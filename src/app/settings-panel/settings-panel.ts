import { UpperCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { geometry } from '../../../shared/geometry';
import {
  CropRect, FACE_MODEL_INFO, FaceModelId, MODELS, ModelId, ProcessOptions, TargetHeight, VideoInfo,
} from '../../../shared/types';

interface Margins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

@Component({
  selector: 'app-settings-panel',
  imports: [UpperCasePipe],
  templateUrl: './settings-panel.html',
  styleUrl: './settings-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPanel {
  readonly info = input.required<VideoInfo>();
  readonly options = input.required<ProcessOptions>();
  readonly disabled = input(false);
  /** Face restorers whose models are installed (bin/faces). */
  readonly faceModels = input<FaceModelId[]>([]);
  readonly optionsChange = output<Partial<ProcessOptions>>();

  readonly models = MODELS;
  readonly heights: { value: TargetHeight; label: string }[] = [
    { value: 'auto', label: 'Авто' },
    { value: 576, label: '576p' },
    { value: 720, label: '720p' },
    { value: 1080, label: '1080p' },
  ];
  readonly denoiseLabels = ['Выкл.', 'Слабое', 'Среднее', 'Сильное'];
  readonly sharpenLabels = ['Выкл.', 'Слабая', 'Средняя', 'Сильная'];

  readonly geo = computed(() => geometry(this.info(), this.options()));
  readonly model = computed(() => MODELS.find((m) => m.id === this.options().model) ?? MODELS[0]);
  readonly faceModelInfo = FACE_MODEL_INFO;
  readonly facesAvailable = computed(() => this.faceModels().length > 0);
  readonly facesUsable = computed(() => this.facesAvailable() && this.options().engine === 'realesrgan');
  /** The chosen face model, or the first installed one if the chosen one is missing. */
  readonly faceModel = computed<FaceModelId>(() => {
    const want = this.options().faceModel;
    return this.faceModels().includes(want) ? want : (this.faceModels()[0] ?? want);
  });
  readonly interlaced = computed(() => this.info().interlace === 'tff' || this.info().interlace === 'bff');

  readonly margins = computed<Margins>(() => {
    const c = this.options().crop;
    const { width, height } = this.info();
    if (!c) return { top: 0, bottom: 0, left: 0, right: 0 };
    return { top: c.y, left: c.x, bottom: height - c.y - c.h, right: width - c.x - c.w };
  });

  set<K extends keyof ProcessOptions>(key: K, value: ProcessOptions[K]) {
    this.optionsChange.emit({ [key]: value } as Partial<ProcessOptions>);
  }

  num(e: Event): number {
    return Number((e.target as HTMLInputElement).value);
  }

  setModel(id: ModelId) {
    this.optionsChange.emit({ model: id });
  }

  setHeight(raw: string) {
    this.set('targetHeight', raw === 'auto' ? 'auto' : (Number(raw) as TargetHeight));
  }

  setMargin(side: keyof Margins, value: number) {
    const m = { ...this.margins(), [side]: Math.max(0, Math.round(value)) };
    const { width, height } = this.info();
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    if (w < width * 0.4 || h < height * 0.4) return;
    const crop: CropRect | null = m.top || m.bottom || m.left || m.right ? { x: m.left, y: m.top, w, h } : null;
    this.set('crop', crop);
  }

  resetCrop() {
    this.set('crop', this.info().suggestedCrop);
  }

  resetColor() {
    this.optionsChange.emit({ brightness: 0, contrast: 1, saturation: 1, gamma: 1, whiteBalance: false });
  }

  fmt(v: number, digits = 2): string {
    return v.toFixed(digits);
  }
}
