import { ChangeDetectionStrategy, Component, computed, ElementRef, input, output, signal, viewChildren } from '@angular/core';
import { MODELS, ModelId, VideoInfo } from '../../../shared/types';
import type { PreviewState } from '../store';

export interface PreviewRun {
  start: number;
  duration: number;
  compare: boolean;
}

interface Pane {
  label: string;
  src: string;
  note?: string;
}

@Component({
  selector: 'app-preview-compare',
  templateUrl: './preview-compare.html',
  styleUrl: './preview-compare.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreviewCompare {
  readonly info = input.required<VideoInfo>();
  readonly state = input.required<PreviewState>();
  readonly engine = input<'realesrgan' | 'ffmpeg'>('realesrgan');
  readonly mediaUrl = input.required<(path: string) => string>();
  readonly run = output<PreviewRun>();
  readonly cancel = output<void>();

  readonly start = signal(0);
  readonly duration = signal(3);
  readonly compare = signal(true);
  readonly mode = signal<'grid' | 'wipe'>('grid');
  readonly wipe = signal(50);
  readonly wipeIndex = signal(0);
  readonly playing = signal(false);

  private readonly videos = viewChildren<ElementRef<HTMLVideoElement>>('vid');

  readonly maxStart = computed(() => Math.max(0, this.info().duration - 1));

  readonly panes = computed<Pane[]>(() => {
    const r = this.state().result;
    if (!r) return [];
    const url = this.mediaUrl();
    const clip = this.info().duration;
    const panes: Pane[] = [{ label: 'Оригинал', src: url(r.original), note: 'без обработки' }];
    for (const v of r.variants) {
      const perSecond = v.seconds / Math.max(0.5, this.duration());
      panes.push({
        label: v.model === 'ffmpeg' ? 'ffmpeg' : titleOf(v.model),
        src: url(v.file),
        note: `${v.seconds.toFixed(0)} с на превью · весь клип ≈ ${formatDuration(perSecond * clip)}`,
      });
    }
    return panes;
  });

  readonly variants = computed(() => this.panes().slice(1));

  num(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  clampStart(v: number) {
    this.start.set(Math.min(this.maxStart(), Math.max(0, v)));
  }

  submit() {
    this.playing.set(false);
    this.run.emit({ start: this.start(), duration: this.duration(), compare: this.compare() && this.engine() === 'realesrgan' });
  }

  togglePlay() {
    const vids = this.videos().map((v) => v.nativeElement);
    if (!vids.length) return;
    if (this.playing()) {
      vids.forEach((v) => v.pause());
      this.playing.set(false);
    } else {
      const t = vids[0].currentTime;
      vids.forEach((v) => {
        v.currentTime = t;
        void v.play();
      });
      this.playing.set(true);
    }
  }

  restart() {
    this.videos().forEach((v) => (v.nativeElement.currentTime = 0));
  }

  /** Keep all panes on the same frame when the user scrubs one of them. */
  sync(e: Event) {
    const src = e.target as HTMLVideoElement;
    for (const v of this.videos()) {
      const el = v.nativeElement;
      if (el !== src && Math.abs(el.currentTime - src.currentTime) > 0.08) el.currentTime = src.currentTime;
    }
  }

  setMode(mode: 'grid' | 'wipe') {
    this.playing.set(false);
    this.mode.set(mode);
  }
}

function titleOf(id: ModelId): string {
  return MODELS.find((m) => m.id === id)?.title ?? id;
}

export function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} мин ${Math.round(sec % 60)} с`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
}
