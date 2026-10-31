// Types shared between the Electron main process and the Angular renderer.

import type { MontageClip } from './montage';
import type { Segment } from './segments';

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
  /** Exact frame rate as ffmpeg writes it (e.g. 30000/1001), used for frame-exact timing. */
  fpsRational: string;
  duration: number;
  /** Timestamp of the first frame in seconds (non-zero in e.g. MPEG-TS and VOB files). */
  startTime: number;
  frames: number;
  videoCodec: string;
  /** ffmpeg pixel format, e.g. yuv420p. */
  pixFmt: string;
  videoBitrateKbps?: number;
  audioCodec?: string;
  audioBitrateKbps?: number;
  audioSampleRate?: number;
  audioChannels?: number;
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

export type FaceModelId = 'gfpgan' | 'codeformer';

export interface FaceModelDescriptor {
  id: FaceModelId;
  title: string;
  hint: string;
}

export const FACE_MODEL_INFO: FaceModelDescriptor[] = [
  {
    id: 'codeformer',
    title: 'CodeFormer',
    hint: 'Бережнее к чертам лица: ползунок «Похожесть» решает, сколько оставить от оригинала. Только для некоммерческого использования.',
  },
  {
    id: 'gfpgan',
    title: 'GFPGAN 1.4',
    hint: 'Быстрее и ярче, но чаще делает лицо «гладким» и немного чужим.',
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
  /** Restore faces after upscaling (neural engine only). */
  faceRestore: boolean;
  faceModel: FaceModelId;
  /** CodeFormer only, 0..1: higher keeps more of the original face, lower invents more detail. */
  faceFidelity: number;
  /** 0.1..1: how much of the restored face is blended in (lower = more natural). */
  faceStrength: number;
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
  faceRestore: false,
  faceModel: 'codeformer',
  faceFidelity: 0.7,
  faceStrength: 0.6,
  sharpen: 1,
  crf: 16,
};

export type JobStage =
  | 'queued' | 'prepare' | 'upscale' | 'faces' | 'encode' | 'assemble' | 'done' | 'error' | 'cancelled';

export type SegmentState = 'pending' | 'running' | 'done' | 'cached' | 'error';

export interface JobProgress {
  jobId: string;
  stage: JobStage;
  /** Overall progress 0..100. */
  percent: number;
  framesDone?: number;
  framesTotal?: number;
  etaSec?: number;
  /** Faces restored so far (faces stage). */
  faces?: number;
  message?: string;
  output?: string;
  /** Fragment being processed (0-based) and how many there are. */
  segmentIndex?: number;
  segmentCount?: number;
  /** State of every fragment, in order. */
  segments?: SegmentState[];
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

export interface SceneRequest {
  path: string;
  /** Scene-change sensitivity, 0.1 (many cuts) .. 0.6 (only hard cuts). */
  threshold: number;
}

export interface Thumbnails {
  /** Seconds between thumbnails: file k shows the picture at k * interval. */
  interval: number;
  files: string[];
}

/** lossless: FFV1 + FLAC in MKV, for further enhancement. mp4: H.264 + AAC, to watch and share. */
export type MontageFormat = 'lossless' | 'mp4';

export interface MontageRequest {
  /** The video the montage belongs to: it sets size, frame rate and the output name. */
  owner: string;
  clips: MontageClip[];
  format: MontageFormat;
  /** H.264 CRF for MP4 (18 = high, 23 = smaller). */
  crf?: number;
  /** Folder for the result; null = next to the owner video. */
  outDir: string | null;
}

export interface MontageProgress {
  percent: number;
  framesDone?: number;
  framesTotal?: number;
  etaSec?: number;
  output?: string;
}

export interface CacheInfo {
  dir: string;
  bytes: number;
  files: number;
}

export interface ToolsStatus {
  ffmpeg: string | null;
  ffprobe: string | null;
  realesrgan: string | null;
  models: string[];
  /** Folder with the face models, or null if the detector or every restorer is missing. */
  faces: string | null;
  /** Face restorers whose model file is installed. */
  faceModels: FaceModelId[];
  binDir: string;
}

export interface EnhancerApi {
  tools(): Promise<ToolsStatus>;
  openFiles(): Promise<string[]>;
  chooseDir(): Promise<string | null>;
  pathForFile(file: File): string;
  analyze(path: string): Promise<VideoInfo>;
  /** `segments` = fragments to cut the clip into; null = automatic fixed-length fragments. */
  enqueue(path: string, options: ProcessOptions, outDir: string | null, segments: Segment[] | null): Promise<string>;
  cancel(jobId: string): Promise<void>;
  preview(req: PreviewRequest): Promise<PreviewResult>;
  cancelPreview(): Promise<void>;
  /** Frames where a new scene starts. */
  detectScenes(req: SceneRequest): Promise<number[]>;
  /** Small H.264 copy of the source that the browser can play (AVI/XviD often cannot). */
  proxy(path: string): Promise<string>;
  /** Timeline thumbnails for the montage editor. */
  thumbnails(path: string): Promise<Thumbnails>;
  /** Cut and join clips into a lossless MKV; resolves with its path. */
  renderMontage(req: MontageRequest): Promise<string>;
  cancelMontage(): Promise<void>;
  onMontageProgress(cb: (p: MontageProgress) => void): () => void;
  cacheInfo(): Promise<CacheInfo>;
  clearCache(): Promise<CacheInfo>;
  mediaUrl(path: string): string;
  showInFolder(path: string): Promise<void>;
  onProgress(cb: (p: JobProgress) => void): () => void;
  onPreviewProgress(cb: (p: JobProgress) => void): () => void;
}
