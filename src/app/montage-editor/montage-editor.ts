import {
  ChangeDetectionStrategy, Component, computed, effect, ElementRef, input, OnDestroy, output, signal, untracked, viewChild,
} from '@angular/core';
import {
  clipFrames, clipStartFrame, type MontageClip, locate, montageFrames, moveClip, removeClips, sourceFrameAt, splitClip,
  trimClip,
} from '../../../shared/montage';
import type { VideoInfo } from '../../../shared/types';
import type { MontageState } from '../store';

interface Tile {
  x: number;
  url: string;
}

interface ClipView {
  clip: MontageClip;
  index: number;
  left: number;
  width: number;
  tiles: Tile[];
}

interface Drag {
  id: string;
  edge: 'start' | 'end';
  x0: number;
  base: MontageClip[];
  frame0: number;
}

/** Thumbnail height on the timeline, px (thumbnails are rendered at 72 px). */
const TILE_H = 54;
/** Space left of the first clip, px, so the playhead at 0 is visible. */
const PAD = 12;

/**
 * Simple Clipchamp-style montage: play the video, cut it into clips at the playhead, delete,
 * trim and reorder clips, undo/redo up to 5 steps, then render. Edits are emitted as whole
 * cut lists; history lives in the store.
 */
@Component({
  selector: 'app-montage-editor',
  templateUrl: './montage-editor.html',
  styleUrl: './montage-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onKey($event)' },
})
export class MontageEditor implements OnDestroy {
  readonly info = input.required<VideoInfo>();
  readonly state = input.required<MontageState>();
  readonly proxySrc = input<string | null>(null);
  readonly proxyError = input<string | null>(null);

  readonly edit = output<MontageClip[]>();
  readonly undo = output<void>();
  readonly redo = output<void>();
  readonly render = output<void>();
  readonly cancelRender = output<void>();
  readonly openResult = output<string>();

  /** Playhead in montage frames. */
  readonly playhead = signal(0);
  readonly playing = signal(false);
  readonly selectedId = signal<string | null>(null);
  /** Pixels per second on the timeline. */
  readonly pps = signal(0);
  /** Cut list while an edge is being dragged (committed on release). */
  private readonly draft = signal<MontageClip[] | null>(null);
  private drag: Drag | null = null;
  private playIndex = 0;
  private frameCb = 0;

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  readonly clips = computed(() => this.draft() ?? this.state().history.present);
  readonly fps = computed(() => this.info().fps);
  readonly total = computed(() => montageFrames(this.clips()));
  readonly canUndo = computed(() => this.state().history.past.length);
  readonly canRedo = computed(() => this.state().history.future.length);
  readonly selected = computed(() => this.clips().find((c) => c.id === this.selectedId()) ?? null);
  readonly selectedIndex = computed(() => this.clips().findIndex((c) => c.id === this.selectedId()));
  readonly rendering = computed(() => this.state().rendering);

  /** Splitting is possible when the playhead is strictly inside a clip. */
  readonly canSplit = computed(() => {
    const clips = this.clips();
    if (!clips.length) return false;
    const { index, offset } = locate(clips, this.playhead());
    return offset > 0 && offset < clipFrames(clips[index]);
  });

  readonly width = computed(() => PAD * 2 + (this.total() / this.fps()) * this.pps());

  readonly views = computed<ClipView[]>(() => {
    const fps = this.fps();
    const pps = this.pps();
    const thumbs = this.state().thumbs;
    const tileW = Math.round(TILE_H * Math.max(0.5, this.info().dar));
    let start = 0;
    return this.clips().map((clip, index) => {
      const left = PAD + (start / fps) * pps;
      const width = (clipFrames(clip) / fps) * pps;
      start += clipFrames(clip);
      const tiles: Tile[] = [];
      if (thumbs?.urls.length && width > 2) {
        for (let x = 0; x < width; x += tileW) {
          const t = clip.start / fps + x / pps;
          const k = Math.min(thumbs.urls.length - 1, Math.floor(t / thumbs.interval));
          tiles.push({ x, url: thumbs.urls[k] });
        }
      }
      return { clip, index, left, width, tiles };
    });
  });

  /** Ruler ticks: a step that keeps labels ~80 px apart. */
  readonly ticks = computed(() => {
    const pps = this.pps();
    const seconds = this.total() / this.fps();
    if (!pps) return [];
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pps >= 80) ?? 600;
    const out: { x: number; label: string }[] = [];
    for (let t = 0; t <= seconds + 0.001; t += step) out.push({ x: PAD + t * pps, label: clock(t) });
    return out;
  });

  readonly playheadX = computed(() => PAD + (this.playhead() / this.fps()) * this.pps());

  constructor() {
    // Fit the whole montage when the editor opens or the clip changes.
    effect(() => {
      this.info();
      untracked(() => queueMicrotask(() => this.fit()));
    });
    // After an edit, keep the playhead inside the montage and the picture in sync.
    effect(() => {
      const total = this.total();
      untracked(() => {
        if (this.playing()) return;
        const f = Math.min(this.playhead(), Math.max(0, total - 1));
        this.seek(f);
      });
    });
  }

  ngOnDestroy() {
    this.video()?.nativeElement.pause();
  }

  time(frame: number): string {
    return clock(frame / this.fps(), true);
  }

  // --- Playback -----------------------------------------------------------------------

  /** Show montage frame `frame`: set the playhead and seek the source video. */
  seek(frame: number) {
    const total = this.total();
    const f = Math.min(Math.max(0, total - 1), Math.max(0, Math.round(frame)));
    this.playhead.set(total ? f : 0);
    const v = this.video()?.nativeElement;
    if (v && total) {
      this.playIndex = locate(this.clips(), f).index;
      v.currentTime = (sourceFrameAt(this.clips(), f) + 0.5) / this.fps();
    }
  }

  togglePlay() {
    const v = this.video()?.nativeElement;
    if (!v || !this.total()) return;
    if (!v.paused) {
      v.pause();
      return;
    }
    if (this.playhead() >= this.total() - 1) this.seek(0);
    else this.seek(this.playhead());
    void v.play();
    this.watchFrames();
  }

  onPlay() {
    this.playing.set(true);
  }

  onPause() {
    this.playing.set(false);
    const v = this.video()?.nativeElement;
    if (v && this.frameCb) v.cancelVideoFrameCallback(this.frameCb);
    this.frameCb = 0;
  }

  /** While playing, follow the cut list: jump to the next clip when the current one ends. */
  private watchFrames() {
    const v = this.video()?.nativeElement;
    if (!v) return;
    const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
      const clips = this.clips();
      const clip = clips[this.playIndex];
      if (!clip || v.paused) return;
      const src = Math.round(meta.mediaTime * this.fps());
      if (src >= clip.end - 1 || src < clip.start - 1) {
        const next = clips[this.playIndex + 1];
        if (src >= clip.end - 1 && next) {
          this.playIndex++;
          v.currentTime = (next.start + 0.5) / this.fps();
          this.playhead.set(clipStartFrame(clips, this.playIndex));
        } else if (src >= clip.end - 1) {
          v.pause();
          this.playhead.set(this.total() - 1);
          return;
        }
      } else {
        this.playhead.set(clipStartFrame(clips, this.playIndex) + (src - clip.start));
      }
      this.frameCb = v.requestVideoFrameCallback(tick);
    };
    this.frameCb = v.requestVideoFrameCallback(tick);
  }

  step(frames: number) {
    this.video()?.nativeElement.pause();
    this.seek(this.playhead() + frames);
  }

  jumpSeconds(sec: number) {
    const v = this.video()?.nativeElement;
    const wasPlaying = v && !v.paused;
    v?.pause();
    this.seek(this.playhead() + Math.round(sec * this.fps()));
    if (wasPlaying) this.togglePlay();
  }

  // --- Timeline -----------------------------------------------------------------------

  private frameAtX(clientX: number): number {
    const el = this.scroller()?.nativeElement;
    if (!el) return 0;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD;
    return Math.round((x / this.pps()) * this.fps());
  }

  /** Click or drag on the ruler/empty track moves the playhead. */
  scrubStart(e: PointerEvent) {
    if (e.button !== 0) return;
    this.video()?.nativeElement.pause();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    this.seek(this.frameAtX(e.clientX));
    const move = (ev: PointerEvent) => this.seek(this.frameAtX(ev.clientX));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  clickClip(view: ClipView, e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.video()?.nativeElement.pause();
    this.selectedId.set(view.clip.id);
    this.seek(this.frameAtX(e.clientX));
  }

  /** Drag a clip edge to trim it (ripple: later clips move along). One history step per drag. */
  trimStart(view: ClipView, edge: 'start' | 'end', e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.video()?.nativeElement.pause();
    this.selectedId.set(view.clip.id);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    this.drag = {
      id: view.clip.id, edge, x0: e.clientX, base: this.clips(), frame0: edge === 'start' ? view.clip.start : view.clip.end,
    };
    const move = (ev: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      const delta = Math.round(((ev.clientX - d.x0) / this.pps()) * this.fps());
      const next = trimClip(d.base, d.id, d.edge, d.frame0 + delta, this.info().frames);
      this.draft.set(next);
      // Show the frame at the edge being dragged.
      const i = next.findIndex((c) => c.id === d.id);
      const c = next[i];
      this.seek(d.edge === 'start' ? clipStartFrame(next, i) : clipStartFrame(next, i) + clipFrames(c) - 1);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      const next = this.draft();
      this.draft.set(null);
      this.drag = null;
      if (next) this.edit.emit(next);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  // --- Edits --------------------------------------------------------------------------

  split() {
    if (!this.canSplit()) return;
    const next = splitClip(this.clips(), this.playhead());
    this.edit.emit(next);
    this.selectedId.set(next[locate(next, this.playhead()).index].id);
  }

  remove() {
    const sel = this.selected();
    if (!sel) return;
    const i = this.selectedIndex();
    const next = removeClips(this.clips(), [sel.id]);
    this.edit.emit(next);
    // Select the clip that took its place, playhead at its start (like Clipchamp).
    const neighbour = next[Math.min(i, next.length - 1)];
    this.selectedId.set(neighbour?.id ?? null);
    queueMicrotask(() => this.seek(neighbour ? clipStartFrame(next, Math.min(i, next.length - 1)) : 0));
  }

  move(delta: number) {
    const sel = this.selected();
    if (sel) this.edit.emit(moveClip(this.clips(), sel.id, delta));
  }

  /** Delete everything before (or after) the playhead inside the current clip. */
  trimAtPlayhead(edge: 'start' | 'end') {
    const clips = this.clips();
    if (!clips.length) return;
    const { index, offset } = locate(clips, this.playhead());
    const c = clips[index];
    const frame = edge === 'start' ? c.start + offset : c.start + offset + 1;
    this.selectedId.set(c.id);
    this.edit.emit(trimClip(clips, c.id, edge, frame, this.info().frames));
  }

  zoom(factor: number) {
    const el = this.scroller()?.nativeElement;
    const min = this.fitPps() / 2;
    const next = Math.min(400, Math.max(min, this.pps() * factor));
    this.pps.set(next);
    // Keep the playhead in view.
    if (el) queueMicrotask(() => (el.scrollLeft = Math.max(0, this.playheadX() - el.clientWidth / 2)));
  }

  fit() {
    this.pps.set(this.fitPps());
  }

  private fitPps(): number {
    const el = this.scroller()?.nativeElement;
    const w = (el?.clientWidth ?? 800) - PAD * 2;
    const seconds = Math.max(1, this.total() / this.fps());
    return w / seconds;
  }

  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || this.rendering()) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let handled = true;
    if (ctrl && key === 'z' && !e.shiftKey) this.undo.emit();
    else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) this.redo.emit();
    else if (ctrl) handled = false;
    else if (key === 's') this.split();
    else if (key === 'delete' || key === 'backspace') this.remove();
    else if (key === ' ' && tag !== 'BUTTON') this.togglePlay();
    else if (key === 'arrowleft') this.step(e.shiftKey ? -Math.round(this.fps()) : -1);
    else if (key === 'arrowright') this.step(e.shiftKey ? Math.round(this.fps()) : 1);
    else if (key === 'home') this.seek(0);
    else if (key === 'end') this.seek(this.total() - 1);
    else handled = false;
    if (handled) e.preventDefault();
  }
}

/** 75.4 -> "1:15" (or "1:15.40" with fractions). */
function clock(sec: number, fraction = false): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const secs = fraction ? rest.toFixed(2).padStart(5, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${m}:${secs}`;
}
