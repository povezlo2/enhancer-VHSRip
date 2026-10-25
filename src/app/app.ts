import { LowerCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { geometry } from '../../shared/geometry';
import type { ProcessOptions } from '../../shared/types';
import { formatDuration, PreviewCompare, PreviewRun } from './preview-compare/preview-compare';
import { SettingsPanel } from './settings-panel/settings-panel';
import { Clip, isActive, Store } from './store';

const STAGE_LABEL: Record<string, string> = {
  queued: 'В очереди',
  prepare: 'Очистка кадров',
  upscale: 'Апскейл',
  encode: 'Кодирование',
  done: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменено',
};

@Component({
  selector: 'app-root',
  imports: [SettingsPanel, PreviewCompare, LowerCasePipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
  },
})
export class App {
  protected readonly store = inject(Store);
  protected readonly dragging = signal(false);
  protected readonly tab = signal<'settings' | 'preview'>('settings');
  protected readonly mediaUrl = (p: string) => this.store.api.mediaUrl(p);

  protected readonly selected = this.store.selected;
  protected readonly selectedBusy = computed(() => isActive(this.selected()?.stage));
  protected readonly pending = computed(() =>
    this.store.clips().filter((c) => c.info && !isActive(c.stage) && c.stage !== 'done').length);

  protected stageLabel(c: Clip): string {
    if (c.analyzing) return 'Анализ…';
    if (c.error && !c.stage) return 'Не удалось прочитать';
    return c.stage ? STAGE_LABEL[c.stage] : 'Готов к обработке';
  }

  protected isActive = isActive;
  protected formatDuration = formatDuration;

  protected outSize(c: Clip): string {
    if (!c.info) return '';
    const g = geometry(c.info, c.options);
    return `${g.outW}×${g.outH}`;
  }

  protected engineLabel(o: ProcessOptions): string {
    if (o.engine === 'ffmpeg') return 'ffmpeg';
    return o.model === 'realesrgan-x4plus' ? 'x4plus' : `animevideov3 ×${o.scale}`;
  }

  protected updateSelected(patch: Partial<ProcessOptions>) {
    const c = this.selected();
    if (c) this.store.updateOptions(c.id, patch);
  }

  protected runPreview(r: PreviewRun) {
    const c = this.selected();
    if (c) void this.store.runPreview(c.id, r.start, r.duration, r.compare);
  }

  protected onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    this.dragging.set(true);
  }

  protected onDragLeave(e: DragEvent) {
    // Only reset when the pointer actually leaves the window.
    if (!e.relatedTarget) this.dragging.set(false);
  }

  protected onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragging.set(false);
    if (e.dataTransfer?.files.length) this.store.addFiles(e.dataTransfer.files);
  }

  protected shortPath(p: string | null): string {
    if (!p) return 'рядом с исходником';
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p;
  }
}
