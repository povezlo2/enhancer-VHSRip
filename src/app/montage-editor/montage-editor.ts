import {
  ChangeDetectionStrategy, Component, computed, effect, ElementRef, input, OnDestroy, output, signal, untracked, viewChildren,
} from '@angular/core';
import {
  type AudioOverlay, layout, locate, type MontageClip, moveClip, ORIGINAL_AUDIO, type OriginalAudio, originalVolume, removeClips, reverseClips, reverseMontage, setAllTransitions, setTransition,
  sourceEdge, sourceFrameAt, sourceFrameOf, splitClip, type Transition, type TransitionKind, TRANSITIONS, trimClip,
} from '../../../shared/montage';
import type { AudioExportFormat, MontageFormat } from '../../../shared/types';
import type { MontageState, SourceMedia } from '../montage-store';

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
  hue: number;
  label: string;
  missing: boolean;
}

interface JoinView {
  index: number;
  x: number;
  transition?: Transition;
}

interface Drag {
  id: string;
  edge: 'start' | 'end';
  x0: number;
  base: MontageClip[];
  frame0: number;
  fps: number;
}

export interface QueueEntry {
  path: string;
  name: string;
}

/** Thumbnail height on the timeline, px (thumbnails are rendered at 72 px). */
const TILE_H = 54;
/** Space left of the first clip, px, so the playhead at 0 is visible. */
const PAD = 12;
/** Transition lengths offered, seconds. */
export const TRANSITION_SECONDS = [0.25, 0.5, 1, 1.5, 2];

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/**
 * Clipchamp-style montage: play the cut, cut it into clips at the playhead, delete, trim and
 * reorder clips, add other videos, put transitions on the joins, undo/redo up to 5 steps,
 * then render losslessly or to MP4. Edits are emitted as whole cut lists; history and
 * saving live in MontageStore.
 */
@Component({
  selector: 'app-montage-editor',
  templateUrl: './montage-editor.html',
  styleUrl: './montage-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:keydown)': 'onKey($event)' },
})
export class MontageEditor implements OnDestroy {
  readonly state = input.required<MontageState>();
  readonly sources = input.required<Record<string, SourceMedia>>();
  /** Videos in the clip list, offered in «+ Видео». */
  readonly queue = input<QueueEntry[]>([]);
  /** Playable URLs of overlay audio files. */
  readonly audioUrls = input<Record<string, string>>({});

  readonly edit = output<MontageClip[]>();
  readonly undo = output<void>();
  readonly redo = output<void>();
  readonly add = output<{ paths: string[] | 'pick'; after: number }>();
  readonly restart = output<void>();
  readonly outputFormat = output<{ format: MontageFormat; crf?: number }>();
  readonly render = output<void>();
  readonly cancelRender = output<void>();
  readonly openResult = output<string>();
  readonly addAudio = output<number>();
  readonly overlayChange = output<{ id: string; start?: number; volume?: number }>();
  readonly removeOverlay = output<string>();
  readonly originalAudio = output<OriginalAudio>();
  readonly extractAudio = output<AudioExportFormat>();
  readonly showFile = output<string>();

  readonly originalModes = ORIGINAL_AUDIO;
  readonly selectedOverlayId = signal<string | null>(null);
  /** Start of the overlay being dragged (committed on release). */
  private readonly overlayDraft = signal<{ id: string; start: number } | null>(null);
  private readonly audios = viewChildren<ElementRef<HTMLAudioElement>>('audio');

  readonly transitions = TRANSITIONS;
  readonly transitionSeconds = TRANSITION_SECONDS;

  /** Playhead in project frames. */
  readonly playhead = signal(0);
  readonly playing = signal(false);
  readonly selectedId = signal<string | null>(null);
  /** Join (index of the clip after it) whose transition is being edited. */
  readonly selectedJoin = signal<number | null>(null);
  readonly addMenu = signal(false);
  /** Source shown in the player. */
  readonly activeSource = signal<string | null>(null);
  /** Pixels per second on the timeline. */
  readonly pps = signal(0);
  private readonly draft = signal<MontageClip[] | null>(null);
  private drag: Drag | null = null;
  private playIndex = 0;
  private frameCb = 0;
  private frameCbVideo: HTMLVideoElement | null = null;

  private readonly videos = viewChildren<ElementRef<HTMLVideoElement>>('video');
  private readonly scrollers = viewChildren<ElementRef<HTMLElement>>('scroller');

  readonly fps = computed(() => this.state().fps);
  readonly owner = computed(() => this.sources()[this.state().owner]?.info ?? null);
  readonly clips = computed(() => this.draft() ?? this.state().history.present);
  readonly lay = computed(() => layout(this.clips(), this.fps()));
  readonly total = computed(() => this.lay().total);
  readonly canUndo = computed(() => this.state().history.past.length);
  readonly canRedo = computed(() => this.state().history.future.length);
  readonly selected = computed(() => this.clips().find((c) => c.id === this.selectedId()) ?? null);
  readonly selectedIndex = computed(() => this.clips().findIndex((c) => c.id === this.selectedId()));
  readonly rendering = computed(() => !!this.state().rendering);
  readonly extracting = computed(() => !!this.state().extracting);
  readonly busy = computed(() => this.rendering() || this.extracting() || !!this.state().adding);

  readonly overlays = computed<(AudioOverlay & { left: number; width: number })[]>(() => {
    const d = this.overlayDraft();
    return this.state().overlays.map((o) => {
      const start = d?.id === o.id ? d.start : o.start;
      return { ...o, start, left: PAD + (start / this.fps()) * this.pps(), width: Math.max(4, o.duration * this.pps()) };
    });
  });
  readonly selectedOverlay = computed(() => this.overlays().find((o) => o.id === this.selectedOverlayId()) ?? null);

  /** Sources in use, in order (one <video> each). */
  readonly usedSources = computed(() => {
    const all = this.sources();
    const paths = [...new Set([this.state().owner, ...this.clips().map((c) => c.source)])];
    return paths.map((path, i) => ({ path, name: baseName(path), proxy: all[path]?.proxy ?? null, hue: (i * 67 + 265) % 360 }));
  });
  /** One player per source and direction: forward copies, plus backwards copies where a clip is reversed. */
  readonly players = computed(() => {
    const all = this.sources();
    const reversed = new Set(this.clips().filter((c) => c.reversed).map((c) => c.source));
    return this.usedSources().flatMap((s) => [
      ...(s.proxy ? [{ key: playerKey(s.path, false), src: s.proxy }] : []),
      ...(reversed.has(s.path) && all[s.path]?.reversedProxy ? [{ key: playerKey(s.path, true), src: all[s.path]!.reversedProxy! }] : []),
    ]);
  });
  /** A reversed clip whose backwards copy is still being made. */
  readonly reversePending = computed(() => {
    const all = this.sources();
    return this.clips().some((c) => c.reversed && !all[c.source]?.reversedProxy && !all[c.source]?.reversedError);
  });
  readonly activePlayer = signal<string | null>(null);
  readonly multiSource = computed(() => new Set(this.clips().map((c) => c.source)).size > 1);
  readonly missing = computed(() => {
    const all = this.sources();
    return [...new Set(this.clips().map((c) => c.source))].filter((p) => all[p]?.error && !all[p]?.info);
  });
  readonly anyProxy = computed(() => this.usedSources().some((s) => s.proxy));

  readonly canSplit = computed(() => {
    const clips = this.clips();
    if (!clips.length) return false;
    const { index, offset } = locate(clips, this.fps(), this.playhead());
    return offset > 0 && offset < this.lay().lengths[index];
  });

  readonly width = computed(() => PAD * 2 + (this.total() / this.fps()) * this.pps());

  readonly views = computed<ClipView[]>(() => {
    const fps = this.fps();
    const pps = this.pps();
    const all = this.sources();
    const hues = new Map(this.usedSources().map((s) => [s.path, s.hue]));
    const dar = this.owner()?.dar ?? 4 / 3;
    const tileW = Math.round(TILE_H * Math.max(0.5, dar));
    const { starts, lengths } = this.lay();
    return this.clips().map((clip, index) => {
      const left = PAD + (starts[index] / fps) * pps;
      const width = (lengths[index] / fps) * pps;
      const thumbs = all[clip.source]?.thumbs;
      const tiles: Tile[] = [];
      if (thumbs?.urls.length && width > 2) {
        for (let x = 0; x < width; x += tileW) {
          // Timeline seconds map 1:1 to source seconds (frame-rate conversion keeps time); backwards for a reversed clip.
          const t = clip.reversed ? Math.max(0, clip.end / clip.fps - (x + tileW) / pps) : clip.start / clip.fps + x / pps;
          tiles.push({ x, url: thumbs.urls[Math.min(thumbs.urls.length - 1, Math.floor(t / thumbs.interval))] });
        }
      }
      return {
        clip, index, left, width, tiles, hue: hues.get(clip.source) ?? 265, label: baseName(clip.source),
        missing: !!all[clip.source]?.error && !all[clip.source]?.info,
      };
    });
  });

  readonly joins = computed<JoinView[]>(() => {
    const { starts, trans } = this.lay();
    return this.clips().slice(1).map((c, k) => {
      const i = k + 1;
      return { index: i, x: PAD + ((starts[i] + trans[i] / 2) / this.fps()) * this.pps(), transition: c.transitionIn };
    });
  });

  readonly join = computed(() => {
    const i = this.selectedJoin();
    if (i === null || i < 1 || i >= this.clips().length) return null;
    const c = this.clips()[i];
    return { index: i, clip: c, kind: c.transitionIn?.kind ?? null, seconds: (c.transitionIn?.frames ?? 0) / this.fps(), used: this.lay().trans[i] };
  });

  /** What the player overlay shows inside a transition: fade-to-black darkness, or a label. */
  readonly overlay = computed(() => {
    const f = this.playhead();
    const { starts, trans } = this.lay();
    for (let i = 1; i < trans.length; i++) {
      if (!trans[i] || f < starts[i] || f >= starts[i] + trans[i]) continue;
      const kind = this.clips()[i].transitionIn?.kind;
      const p = (f - starts[i] + 0.5) / trans[i];
      return {
        black: kind === 'fadeblack' ? 1 - Math.abs(2 * p - 1) : 0,
        label: TRANSITIONS.find((t) => t.kind === kind)?.title ?? '',
      };
    }
    return null;
  });

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
    // The montage's own sound in the player follows «Исходный звук».
    effect(() => {
      const volume = originalVolume(this.state().originalAudio);
      this.players();
      untracked(() => queueMicrotask(() => this.videos().forEach((v) => (v.nativeElement.volume = volume))));
    });
    effect(() => {
      this.state().owner;
      untracked(() => queueMicrotask(() => this.fit()));
    });
    // After an edit (or once players appear, e.g. a backwards copy), keep the playhead inside the montage
    // and the picture in sync.
    effect(() => {
      const total = this.total();
      this.players();
      untracked(() => {
        if (!this.playing()) this.seek(Math.min(this.playhead(), Math.max(0, total - 1)));
      });
    });
  }

  ngOnDestroy() {
    this.videos().forEach((v) => v.nativeElement.pause());
  }

  time(frame: number): string {
    return clock(frame / this.fps(), true);
  }

  // --- Playback -----------------------------------------------------------------------

  private videoOf(key: string | null): HTMLVideoElement | undefined {
    return this.videos().map((v) => v.nativeElement).find((v) => v.dataset['key'] === key);
  }

  /** Player for a clip, and the time in it that shows source frame `frame`. */
  private playerFor(c: MontageClip, frame: number): { key: string; time: number } {
    const backwards = c.reversed && this.videoOf(playerKey(c.source, true));
    if (backwards) {
      // The backwards copy holds the whole source reversed: source frame f is its frame N - 1 - f.
      const n = this.sources()[c.source]?.info?.frames ?? c.end;
      return { key: playerKey(c.source, true), time: (n - 1 - frame + 0.5) / c.fps };
    }
    return { key: playerKey(c.source, false), time: (frame + 0.5) / c.fps };
  }

  /** Source frame shown by a player at media time `t`. */
  private frameIn(c: MontageClip, key: string, t: number): number {
    const k = Math.round(t * c.fps);
    if (key !== playerKey(c.source, true)) return k;
    const n = this.sources()[c.source]?.info?.frames ?? c.end;
    return n - 1 - k;
  }

  /** Show timeline frame `frame`: set the playhead, pick the source's player and seek it. */
  seek(frame: number) {
    const total = this.total();
    const f = Math.min(Math.max(0, total - 1), Math.max(0, Math.round(frame)));
    this.playhead.set(total ? f : 0);
    if (!total) return;
    const clips = this.clips();
    const { index, frame: src } = sourceFrameAt(clips, this.fps(), f);
    const c = clips[index];
    this.playIndex = index;
    this.activeSource.set(c.source);
    const p = this.playerFor(c, src);
    this.activePlayer.set(p.key);
    const v = this.videoOf(p.key);
    if (v) v.currentTime = p.time;
    if (!this.playing()) this.syncAudio(false);
  }

  /** Keep overlay audio in step with the playhead (re-seek only when it drifts noticeably). */
  private syncAudio(playing: boolean) {
    const sec = this.playhead() / this.fps();
    const byId = new Map(this.state().overlays.map((o) => [o.id, o]));
    for (const ref of this.audios()) {
      const el = ref.nativeElement;
      const o = byId.get(el.dataset['id'] ?? '');
      if (!o) continue;
      const t = sec - o.start / this.fps();
      const inside = t >= 0 && t < o.duration;
      el.volume = Math.min(1, o.volume); // the player cannot amplify; the render can (up to 200%)
      if (playing && inside) {
        if (Math.abs(el.currentTime - t) > 0.15) el.currentTime = t;
        if (el.paused) void el.play();
      } else {
        if (!el.paused) el.pause();
        if (inside) el.currentTime = t;
      }
    }
  }

  togglePlay() {
    const active = this.videoOf(this.activePlayer());
    if (active && !active.paused) {
      active.pause();
      return;
    }
    if (!this.total()) return;
    this.seek(this.playhead() >= this.total() - 1 ? 0 : this.playhead());
    const v = this.videoOf(this.activePlayer());
    if (!v) return;
    void v.play();
    this.watchFrames(v);
  }

  onPlay() {
    this.playing.set(true);
  }

  onPause(e: Event) {
    if (e.target !== this.videoOf(this.activePlayer())) return; // a player we switched away from
    this.playing.set(false);
    this.stopWatching();
    this.syncAudio(false);
  }

  private stopWatching() {
    if (this.frameCbVideo && this.frameCb) this.frameCbVideo.cancelVideoFrameCallback(this.frameCb);
    this.frameCb = 0;
    this.frameCbVideo = null;
  }

  /** While playing, follow the cut list: jump (or switch player) when a clip's part ends. */
  private watchFrames(v: HTMLVideoElement) {
    this.stopWatching();
    const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
      const clips = this.clips();
      const fps = this.fps();
      const { starts, lengths, trans } = this.lay();
      const i = this.playIndex;
      const c = clips[i];
      if (!c || v.paused) return;
      const src = this.frameIn(c, v.dataset['key'] ?? '', meta.mediaTime);
      // Source frames played so far in this clip (a reversed clip plays from its end).
      const played = c.reversed ? c.end - 1 - src : src - c.start;
      // This clip is shown until the middle of the transition into the next one.
      const endOffset = lengths[i] - Math.floor((trans[i + 1] ?? 0) / 2);
      const endPlayed = Math.round((endOffset * c.fps) / fps);
      if (played >= endPlayed - 1) {
        const next = clips[i + 1];
        if (!next) {
          v.pause();
          this.playhead.set(this.total() - 1);
          return;
        }
        this.playIndex = i + 1;
        const startOffset = Math.ceil(trans[i + 1] / 2);
        const nextSrc = sourceFrameOf(next, startOffset, fps);
        this.playhead.set(starts[i + 1] + startOffset);
        const p = this.playerFor(next, nextSrc);
        const nv = this.videoOf(p.key);
        if (!nv) return;
        nv.currentTime = p.time;
        this.activeSource.set(next.source);
        if (nv !== v) {
          // Different source or direction: hand over to that player.
          this.activePlayer.set(p.key);
          v.pause();
          void nv.play();
          this.watchFrames(nv);
          return;
        }
      } else if (played >= 0) {
        this.playhead.set(starts[i] + Math.round((played * fps) / c.fps));
      }
      this.syncAudio(true);
      this.frameCb = v.requestVideoFrameCallback(tick);
    };
    this.frameCbVideo = v;
    this.frameCb = v.requestVideoFrameCallback(tick);
  }

  private pause() {
    this.videoOf(this.activePlayer())?.pause();
  }

  step(frames: number) {
    this.pause();
    this.seek(this.playhead() + frames);
  }

  jumpSeconds(sec: number) {
    const wasPlaying = this.playing();
    this.pause();
    this.seek(this.playhead() + Math.round(sec * this.fps()));
    if (wasPlaying) this.togglePlay();
  }

  // --- Timeline -----------------------------------------------------------------------

  private frameAtX(clientX: number): number {
    const el = this.scrollers()[0]?.nativeElement;
    if (!el) return 0;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - PAD;
    return Math.round((x / this.pps()) * this.fps());
  }

  scrubStart(e: PointerEvent) {
    if (e.button !== 0) return;
    this.pause();
    this.selectedJoin.set(null);
    this.selectedOverlayId.set(null);
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
    this.pause();
    this.selectedId.set(view.clip.id);
    this.selectedJoin.set(null);
    this.selectedOverlayId.set(null);
    this.seek(this.frameAtX(e.clientX));
  }

  clickJoin(j: JoinView, e: Event) {
    e.stopPropagation();
    this.pause();
    this.selectedJoin.set(this.selectedJoin() === j.index ? null : j.index);
    this.seek(this.lay().starts[j.index]);
  }

  /** Drag a clip edge to trim it (ripple: later clips move along). One history step per drag. */
  trimStart(view: ClipView, edge: 'start' | 'end', e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.pause();
    this.selectedId.set(view.clip.id);
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    // A reversed clip's left edge is the end of its source range, and dragging moves it the other way.
    const srcEdge = sourceEdge(view.clip, edge);
    const sign = view.clip.reversed ? -1 : 1;
    this.drag = {
      id: view.clip.id, edge: srcEdge, x0: e.clientX, base: this.clips(), fps: view.clip.fps,
      frame0: srcEdge === 'start' ? view.clip.start : view.clip.end,
    };
    const total = this.sources()[view.clip.source]?.info?.frames ?? view.clip.end;
    const move = (ev: PointerEvent) => {
      const d = this.drag;
      if (!d) return;
      const delta = sign * Math.round(((ev.clientX - d.x0) / this.pps()) * d.fps);
      const next = trimClip(d.base, d.id, d.edge, d.frame0 + delta, total);
      this.draft.set(next);
      const i = next.findIndex((c) => c.id === d.id);
      const lay = layout(next, this.fps());
      this.seek(edge === 'start' ? lay.starts[i] : lay.starts[i] + lay.lengths[i] - 1);
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
    const next = splitClip(this.clips(), this.fps(), this.playhead());
    this.edit.emit(next);
    this.selectedId.set(next[locate(next, this.fps(), this.playhead()).index].id);
  }

  remove() {
    const sel = this.selected();
    if (!sel) return;
    const i = this.selectedIndex();
    const next = removeClips(this.clips(), [sel.id]);
    this.edit.emit(next);
    const k = Math.min(i, next.length - 1);
    this.selectedId.set(next[k]?.id ?? null);
    this.selectedJoin.set(null);
    queueMicrotask(() => this.seek(k >= 0 ? layout(next, this.fps()).starts[k] : 0));
  }

  // --- Sound ----------------------------------------------------------------------------

  selectOverlay(o: AudioOverlay, e: PointerEvent) {
    if (e.button !== 0) return;
    e.stopPropagation();
    this.pause();
    this.selectedOverlayId.set(o.id);
    // Drag sideways to move it in time.
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const start0 = o.start;
    const move = (ev: PointerEvent) => {
      const delta = Math.round(((ev.clientX - x0) / this.pps()) * this.fps());
      if (delta) this.overlayDraft.set({ id: o.id, start: Math.min(this.total(), Math.max(0, start0 + delta)) });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      const d = this.overlayDraft();
      this.overlayDraft.set(null);
      if (d && d.start !== start0) this.overlayChange.emit({ id: o.id, start: d.start });
      this.syncAudio(false);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  nudgeOverlay(seconds: number) {
    const o = this.selectedOverlay();
    if (o) this.overlayChange.emit({ id: o.id, start: Math.min(this.total(), Math.max(0, o.start + Math.round(seconds * this.fps()))) });
  }

  overlayToPlayhead() {
    const o = this.selectedOverlay();
    if (o) this.overlayChange.emit({ id: o.id, start: this.playhead() });
  }

  deleteOverlay() {
    const o = this.selectedOverlay();
    if (!o) return;
    this.removeOverlay.emit(o.id);
    this.selectedOverlayId.set(null);
  }

  /** Reverse the selected clip, or the whole montage when nothing is selected. */
  reverse() {
    const sel = this.selected();
    this.pause();
    if (sel) {
      this.edit.emit(reverseClips(this.clips(), [sel.id]));
      return;
    }
    // Whole montage: the frame under the playhead stays under it, mirrored.
    const mirrored = Math.max(0, this.total() - 1 - this.playhead());
    this.edit.emit(reverseMontage(this.clips()));
    queueMicrotask(() => this.seek(mirrored));
  }

  move(delta: number) {
    const sel = this.selected();
    if (sel) this.edit.emit(moveClip(this.clips(), sel.id, delta));
  }

  /** Delete everything before (or after) the playhead inside the current clip. */
  trimAtPlayhead(edge: 'start' | 'end') {
    const clips = this.clips();
    if (!clips.length) return;
    const { index, offset } = locate(clips, this.fps(), this.playhead());
    const c = clips[index];
    const src = sourceFrameOf(c, offset, this.fps());
    const total = this.sources()[c.source]?.info?.frames ?? c.end;
    // Keep the frame under the playhead; for a reversed clip "before" is the end of its source range.
    const srcEdge = sourceEdge(c, edge);
    this.selectedId.set(c.id);
    this.edit.emit(trimClip(clips, c.id, srcEdge, srcEdge === 'start' ? src : src + 1, total));
  }

  setJoin(kind: TransitionKind | null, seconds?: number) {
    const j = this.join();
    if (!j) return;
    const secs = seconds ?? (j.seconds || 0.5);
    this.edit.emit(setTransition(this.clips(), j.clip.id, kind ? { kind, frames: Math.round(secs * this.fps()) } : null));
  }

  setAllJoins() {
    const j = this.join();
    if (!j) return;
    const t = j.kind ? { kind: j.kind, frames: Math.round((j.seconds || 0.5) * this.fps()) } : null;
    this.edit.emit(setAllTransitions(this.clips(), t));
  }

  addVideos(paths: string[] | 'pick') {
    this.addMenu.set(false);
    const i = this.selectedIndex();
    this.add.emit({ paths, after: i >= 0 ? i : this.clips().length - 1 });
  }

  zoom(factor: number) {
    const el = this.scrollers()[0]?.nativeElement;
    const next = Math.min(400, Math.max(this.fitPps() / 2, this.pps() * factor));
    this.pps.set(next);
    if (el) queueMicrotask(() => (el.scrollLeft = Math.max(0, this.playheadX() - el.clientWidth / 2)));
  }

  fit() {
    this.pps.set(this.fitPps());
  }

  private fitPps(): number {
    const el = this.scrollers()[0]?.nativeElement;
    const w = (el?.clientWidth ?? 800) - PAD * 2;
    return w / Math.max(1, this.total() / this.fps());
  }

  onKey(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || this.busy()) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let handled = true;
    if (ctrl && key === 'z' && !e.shiftKey) this.undo.emit();
    else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) this.redo.emit();
    else if (ctrl) handled = false;
    else if (key === 's') this.split();
    else if (key === 'r') this.reverse();
    else if (key === 'delete' || key === 'backspace') this.remove();
    else if (key === ' ' && tag !== 'BUTTON') this.togglePlay();
    else if (key === 'arrowleft') this.step(e.shiftKey ? -Math.round(this.fps()) : -1);
    else if (key === 'arrowright') this.step(e.shiftKey ? Math.round(this.fps()) : 1);
    else if (key === 'home') this.seek(0);
    else if (key === 'end') this.seek(this.total() - 1);
    else if (key === 'escape') {
      this.addMenu.set(false);
      this.selectedJoin.set(null);
    } else handled = false;
    if (handled) e.preventDefault();
  }

  /** The offered length closest to `seconds` (frame rounding makes exact matches rare: 0.5 s at 25 fps is 0.52 s). */
  closestSeconds(seconds: number): number {
    return TRANSITION_SECONDS.reduce((best, s) => (Math.abs(s - seconds) < Math.abs(best - seconds) ? s : best));
  }

  fileName(p: string): string {
    return baseName(p);
  }

  savedLabel(): string {
    const t = this.state().savedAt;
    if (!t) return '';
    return new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
}

const playerKey = (source: string, reversed: boolean) => `${reversed ? 'rev' : 'fwd'}:${source}`;

/** 75.4 -> "1:15" (or "1:15.40" with fractions). */
function clock(sec: number, fraction = false): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const secs = fraction ? rest.toFixed(2).padStart(5, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${m}:${secs}`;
}
