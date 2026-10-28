import { ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChild } from '@angular/core';
import {
  DEFAULT_LIMITS, fixedSegments, mergeWithNext, type Segment, segmentFrames, splitAt,
} from '../../../shared/segments';
import type { SegmentState, VideoInfo } from '../../../shared/types';

export interface SegmentPreview {
  start: number;
  duration: number;
}

interface Block {
  index: number;
  segment: Segment;
  left: number;
  width: number;
  state: SegmentState | 'auto';
  faces?: boolean;
}

/** Scene-change sensitivity presets (ffmpeg scene score threshold). */
export const SENSITIVITY = [
  { label: 'Только резкие склейки', value: 0.45 },
  { label: 'Обычная', value: 0.3 },
  { label: 'Высокая', value: 0.18 },
];

/**
 * Fragment editor: a playable proxy of the source, a timeline of fragments, and tools to
 * cut by scenes, by fixed length or by hand. Fragments are frame-based; `null` means
 * "automatic" (equal fragments of up to 10 s, decided by the processor).
 */
@Component({
  selector: 'app-segment-editor',
  templateUrl: './segment-editor.html',
  styleUrl: './segment-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown)': 'onKey($event)' },
})
export class SegmentEditor {
  readonly info = input.required<VideoInfo>();
  readonly segments = input<Segment[] | null>(null);
  readonly states = input<SegmentState[] | undefined>(undefined);
  /** Playable copy of the source, or null while it is being prepared. */
  readonly proxySrc = input<string | null>(null);
  readonly proxyError = input<string | null>(null);
  readonly detecting = input(false);
  readonly disabled = input(false);
  readonly facesEnabled = input(false);

  readonly segmentsChange = output<Segment[] | null>();
  readonly detect = output<number>();
  readonly preview = output<SegmentPreview>();

  readonly sensitivity = SENSITIVITY;
  readonly threshold = signal(0.3);
  readonly selected = signal(0);
  readonly frame = signal(0);
  readonly playing = signal(false);

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

  readonly total = computed(() => Math.max(1, this.info().frames));
  readonly auto = computed(() => this.segments() === null);
  /** What will actually be processed: the user's fragments or the automatic split. */
  readonly effective = computed(() => this.segments() ?? fixedSegments(0, this.total(), this.info().fps));

  readonly blocks = computed<Block[]>(() => {
    const total = this.total();
    const states = this.states();
    return this.effective().map((segment, index) => ({
      index,
      segment,
      left: (segment.start / total) * 100,
      width: (segmentFrames(segment) / total) * 100,
      state: states?.[index] ?? (this.auto() ? 'auto' : 'pending'),
      faces: segment.overrides?.faceRestore,
    }));
  });

  readonly current = computed(() => this.effective()[Math.min(this.selected(), this.effective().length - 1)] ?? null);
  readonly playhead = computed(() => (this.frame() / this.total()) * 100);
  readonly canSplit = computed(() => {
    const f = this.frame();
    return this.effective().some((s) => f > s.start && f < s.end);
  });

  readonly summary = computed(() => {
    const segs = this.effective();
    const fps = this.info().fps;
    const lens = segs.map((s) => segmentFrames(s) / fps);
    return { count: segs.length, min: Math.min(...lens), max: Math.max(...lens) };
  });

  time(frame: number): string {
    return formatTimecode(frame / this.info().fps);
  }

  seconds(frames: number): string {
    return (frames / this.info().fps).toFixed(1);
  }

  // --- Player -------------------------------------------------------------------------

  onTime() {
    const v = this.video()?.nativeElement;
    if (!v) return;
    const f = Math.min(this.total() - 1, Math.round(v.currentTime * this.info().fps));
    this.frame.set(f);
    if (this.playing()) this.selectAt(f);
  }

  togglePlay() {
    const v = this.video()?.nativeElement;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  seekFrame(f: number) {
    const frame = Math.min(this.total() - 1, Math.max(0, Math.round(f)));
    this.frame.set(frame);
    const v = this.video()?.nativeElement;
    // Aim at the middle of the frame so the browser shows exactly this one.
    if (v) v.currentTime = (frame + 0.5) / this.info().fps;
  }

  step(delta: number) {
    this.video()?.nativeElement.pause();
    this.seekFrame(this.frame() + delta);
  }

  onTimelineClick(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const f = ((e.clientX - rect.left) / rect.width) * this.total();
    this.seekFrame(f);
    this.selectAt(Math.round(f));
  }

  selectBlock(i: number, e: Event) {
    e.stopPropagation();
    this.selected.set(i);
    this.seekFrame(this.effective()[i].start);
  }

  private selectAt(frame: number) {
    const i = this.effective().findIndex((s) => frame >= s.start && frame < s.end);
    if (i >= 0 && i !== this.selected()) this.selected.set(i);
  }

  onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      this.step((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? Math.round(this.info().fps) : 1));
    } else if (e.key === ' ' && (e.target as HTMLElement).tagName !== 'BUTTON') {
      e.preventDefault();
      this.togglePlay();
    }
  }

  // --- Editing ------------------------------------------------------------------------

  splitHere() {
    const next = splitAt(this.effective(), this.frame());
    this.segmentsChange.emit(next);
    this.selectAt(this.frame());
  }

  mergeNext() {
    this.segmentsChange.emit(mergeWithNext(this.effective(), this.selected()));
  }

  mergePrev() {
    const i = this.selected();
    if (i <= 0) return;
    this.segmentsChange.emit(mergeWithNext(this.effective(), i - 1));
    this.selected.set(i - 1);
  }

  setFaces(value: string) {
    const i = this.selected();
    const faceRestore = value === 'on' ? true : value === 'off' ? false : undefined;
    const next = this.effective().map((s, j) => {
      if (j !== i) return s;
      const { overrides, ...rest } = s;
      const o = { ...overrides, faceRestore };
      if (faceRestore === undefined) delete o.faceRestore;
      return Object.keys(o).length ? { ...rest, overrides: o } : rest;
    });
    this.segmentsChange.emit(next);
  }

  fixed() {
    this.selected.set(0);
    this.segmentsChange.emit(fixedSegments(0, this.total(), this.info().fps, DEFAULT_LIMITS.maxSec));
  }

  reset() {
    this.selected.set(0);
    this.segmentsChange.emit(null);
  }

  previewCurrent() {
    const s = this.current();
    if (!s) return;
    const fps = this.info().fps;
    this.preview.emit({ start: s.start / fps, duration: Math.min(5, segmentFrames(s) / fps) });
  }

  facesValue(): string {
    const v = this.current()?.overrides?.faceRestore;
    return v === true ? 'on' : v === false ? 'off' : 'inherit';
  }
}

/** 75.4 -> "01:15.40" */
export function formatTimecode(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
