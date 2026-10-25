// Types shared between the Electron main process and the Angular renderer.

export type InterlaceKind = 'progressive' | 'tff' | 'bff' | 'unknown';

export interface CropRect {
  w: number;
  h: number;
  x: number;
  y: number;
}

export interface VideoInfo {
  path: string;
  name: string;
  container: string;
  width: number;
  height: number;
  /** Sample (pixel) aspect ratio, e.g. 1:1 for square pixels. */
  sarNum: number;
  sarDen: number;
  /** Display aspect ratio as a number (width / height after SAR). */
  dar: number;
  fps: number;
  fpsText: string;
  duration: number;
  frames: number;
  videoCodec: string;
  videoBitrateKbps?: number;
  audioCodec?: string;
  audioBitrateKbps?: number;
  interlace: InterlaceKind;
  /** Share of frames detected as interlaced (0..1). */
  interlaceRatio: number;
  /** Suggested crop of black borders, or null if the picture fills the frame. */
  suggestedCrop: CropRect | null;
}

export type Engine = 'realesrgan' | 'ffmpeg';

export type ModelId = 'realesr-animevideov3' | 'realesrgan-x4plus';

export interface ModelDescriptor {
  id: ModelId;
  title: string;
  hint: string;
  scales: number[];
}

export const MODELS: ModelDescriptor[] = [
  {
    id: 'realesr-animevideov3',
    title: 'Быстрая (animevideov3)',
    hint: 'В несколько раз быстрее. Обучена на анимации: на лицах и коже возможна «нарисованность».',
    scales: [2, 3, 4],
  },
  {
    id: 'realesrgan-x4plus',
    title: 'Качество (x4plus)',
    hint: 'Лучше для живых съёмок, но заметно медленнее. Всегда считает ×4, затем уменьшаем до цели.',
    scales: [4],
  },
];

export type TargetHeight = 'auto' | 576 | 720 | 1080;

export interface ProcessOptions {
  engine: Engine;
  model: ModelId;
  scale: number;
  targetHeight: TargetHeight;
  deinterlace: 'auto' | 'on' | 'off';
  /** Crop applied before upscaling; null = no crop. */
  crop: CropRect | null;
  /** 0 = off, 1 = light, 2 = medium, 3 = strong (nlmeans). */
  denoise: 0 | 1 | 2 | 3;
  /** Automatic white balance (grayworld). */
  whiteBalance: boolean;
  brightness: number; // -0.3 .. 0.3, 0 = unchanged
  contrast: number; // 0.7 .. 1.5, 1 = unchanged
  saturation: number; // 0.5 .. 1.8, 1 = unchanged
  gamma: number; // 0.7 .. 1.4, 1 = unchanged
  /** 0 = off .. 3 = strong, applied after upscaling. */
  sharpen: 0 | 1 | 2 | 3;
  /** H.264 CRF, lower = better quality / bigger file. */
  crf: number;
  /** Optional segment (seconds). */
  start?: number;
  duration?: number;
}

export const DEFAULT_OPTIONS: ProcessOptions = {
  engine: 'realesrgan',
  model: 'realesr-animevideov3',
  scale: 2,
  targetHeight: 'auto',
  deinterlace: 'auto',
  crop: null,
  denoise: 1,
  whiteBalance: false,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  gamma: 1,
  sharpen: 1,
  crf: 16,
};

export type JobStage = 'queued' | 'prepare' | 'upscale' | 'encode' | 'done' | 'error' | 'cancelled';

export interface JobProgress {
  jobId: string;
  stage: JobStage;
  /** Overall progress 0..100. */
  percent: number;
  framesDone?: number;
  framesTotal?: number;
  etaSec?: number;
  message?: string;
  output?: string;
}

export interface PreviewRequest {
  path: string;
  start: number;
  duration: number;
  options: ProcessOptions;
  /** Models to compare; empty = only current options. */
  models: ModelId[];
}

export interface PreviewResult {
  original: string;
  variants: { model: ModelId | 'ffmpeg'; file: string; seconds: number }[];
}

export interface ToolsStatus {
  ffmpeg: string | null;
  ffprobe: string | null;
  realesrgan: string | null;
  models: string[];
  binDir: string;
}

export interface EnhancerApi {
  tools(): Promise<ToolsStatus>;
  openFiles(): Promise<string[]>;
  chooseDir(): Promise<string | null>;
  pathForFile(file: File): string;
  analyze(path: string): Promise<VideoInfo>;
  enqueue(path: string, options: ProcessOptions, outDir: string | null): Promise<string>;
  cancel(jobId: string): Promise<void>;
  preview(req: PreviewRequest): Promise<PreviewResult>;
  cancelPreview(): Promise<void>;
  mediaUrl(path: string): string;
  showInFolder(path: string): Promise<void>;
  onProgress(cb: (p: JobProgress) => void): () => void;
  onPreviewProgress(cb: (p: JobProgress) => void): () => void;
}
