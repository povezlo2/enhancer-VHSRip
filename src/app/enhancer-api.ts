import { Injectable } from '@angular/core';
import type { EnhancerApi, JobProgress, PreviewResult, ToolsStatus, VideoInfo } from '../../shared/types';

declare global {
  interface Window {
    enhancer?: EnhancerApi;
  }
}

/** Thin wrapper over the preload bridge; falls back to a mock when opened in a plain browser (`ng serve`). */
@Injectable({ providedIn: 'root' })
export class EnhancerApiService {
  readonly api: EnhancerApi = window.enhancer ?? createMock();
  readonly isMock = !window.enhancer;
}

function createMock(): EnhancerApi {
  const progress = new Set<(p: JobProgress) => void>();
  const previewProgress = new Set<(p: JobProgress) => void>();
  const sub = (set: Set<(p: JobProgress) => void>, cb: (p: JobProgress) => void) => {
    set.add(cb);
    return () => set.delete(cb);
  };
  let seq = 0;

  const info = (path: string): VideoInfo => ({
    path,
    name: path.split(/[\\/]/).pop() ?? path,
    container: 'avi',
    width: 768,
    height: 576,
    sarNum: 1,
    sarDen: 1,
    dar: 4 / 3,
    fps: 25,
    fpsText: '25',
    duration: 18.4,
    frames: 460,
    videoCodec: 'mpeg4',
    videoBitrateKbps: 1512,
    audioCodec: 'mp3',
    audioBitrateKbps: 192,
    interlace: 'tff',
    interlaceRatio: 0.92,
    suggestedCrop: { w: 752, h: 560, x: 8, y: 8 },
  });

  return {
    tools: async (): Promise<ToolsStatus> => ({
      ffmpeg: 'mock', ffprobe: 'mock', realesrgan: 'mock',
      models: ['realesr-animevideov3', 'realesrgan-x4plus'], binDir: '(mock)',
    }),
    openFiles: async () => ['C:/Видео/demo_clip.avi'],
    chooseDir: async () => 'C:/Видео/out',
    pathForFile: (f) => f.name,
    analyze: async (p) => {
      await new Promise((r) => setTimeout(r, 400));
      return info(p);
    },
    enqueue: async () => {
      const jobId = `m${++seq}`;
      let pct = 0;
      const t = setInterval(() => {
        pct += 7;
        const stage = pct < 10 ? 'prepare' : pct < 90 ? 'upscale' : 'encode';
        const done = pct >= 100;
        progress.forEach((cb) => cb({
          jobId, stage: done ? 'done' : stage, percent: Math.min(100, pct),
          framesDone: Math.round((pct / 100) * 460), framesTotal: 460, etaSec: Math.max(0, 30 - pct / 3),
          output: done ? 'C:/Видео/demo_clip_enhanced_1080p.mp4' : undefined,
        }));
        if (done) clearInterval(t);
      }, 400);
      return jobId;
    },
    cancel: async () => undefined,
    preview: async (): Promise<PreviewResult> => {
      for (let i = 0; i <= 100; i += 20) {
        previewProgress.forEach((cb) => cb({ jobId: 'preview', stage: 'upscale', percent: i, message: 'mock' }));
        await new Promise((r) => setTimeout(r, 200));
      }
      return { original: '', variants: [{ model: 'realesr-animevideov3', file: '', seconds: 12 }, { model: 'realesrgan-x4plus', file: '', seconds: 41 }] };
    },
    cancelPreview: async () => undefined,
    mediaUrl: () => '',
    showInFolder: async () => undefined,
    onProgress: (cb) => sub(progress, cb),
    onPreviewProgress: (cb) => sub(previewProgress, cb),
  };
}
