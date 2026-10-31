import { LowerCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { geometry } from '../../shared/geometry';
import type { Segment } from '../../shared/segments';
import type { ProcessOptions } from '../../shared/types';
import { formatDuration, PreviewCompare, PreviewRun } from './preview-compare/preview-compare';
import type { MontageClip } from '../../shared/montage';
import { MontageEditor } from './montage-editor/montage-editor';
import { SegmentEditor, type SegmentPreview } from './segment-editor/segment-editor';
import { SettingsPanel } from './settings-panel/settings-panel';
import { Clip, isActive, Store } from './store';

type Tab = 'montage' | 'settings' | 'segments' | 'preview';

const STAGE_LABEL: Record<string, string> = {
  queued: 'В очереди',
  prepare: 'Очистка кадров',
  upscale: 'Апскейл',
  faces: 'Лица',
  encode: 'Кодирование',
  assemble: 'Склейка',
  done: 'Готово',
  error: 'Ошибка',
  cancelled: 'Отменено',
};

@Component({
  selector: 'app-root',
  imports: [SettingsPanel, PreviewCompare, SegmentEditor, MontageEditor, LowerCasePipe],
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
  protected readonly tab = signal<Tab>('settings');
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

  protected openTab(tab: Tab) {
    this.tab.set(tab);
    const c = this.selected();
    if (!c) return;
    if (tab === 'segments' || tab === 'montage') void this.store.loadProxy(c.id);
    if (tab === 'montage') {
      this.store.montage(c.id);
      void this.store.loadThumbnails(c.id);
    }
  }

  protected selectClip(id: string) {
    this.store.select(id);
    // Prepare what the open tab needs for the newly selected clip.
    if (this.tab() === 'segments' || this.tab() === 'montage') this.openTab(this.tab());
  }

  protected editMontage(clips: MontageClip[]) {
    const c = this.selected();
    if (c) this.store.editMontage(c.id, clips);
  }

  protected setSegments(segments: Segment[] | null) {
    const c = this.selected();
    if (c) this.store.setSegments(c.id, segments);
  }

  protected detectScenes(threshold: number) {
    const c = this.selected();
    if (c) void this.store.detectScenes(c.id, threshold);
  }

  protected previewSegment(p: SegmentPreview) {
    const c = this.selected();
    if (!c) return;
    this.tab.set('preview');
    void this.store.runPreview(c.id, p.start, p.duration, false);
  }

  protected segmentLabel(c: Clip): string {
    const n = c.segmentStates?.length ?? 0;
    if (n < 2 || c.segmentIndex === undefined) return '';
    return ` · фрагмент ${c.segmentIndex + 1}/${n}`;
  }

  protected formatBytes(bytes: number): string {
    if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} КБ`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} МБ`;
    return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
  }
  protected formatDuration = formatDuration;

  protected outSize(c: Clip): string {
    if (!c.info) return '';
    const g = geometry(c.info, c.options);
    return `${g.outW}×${g.outH}`;
  }

  protected engineLabel(o: ProcessOptions): string {
    if (o.engine === 'ffmpeg') return 'ffmpeg';
    const model = o.model === 'realesrgan-x4plus' ? 'x4plus' : `animevideov3 ×${o.scale}`;
    return o.faceRestore ? `${model} + ${o.faceModel === 'codeformer' ? 'CodeFormer' : 'GFPGAN'}` : model;
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
