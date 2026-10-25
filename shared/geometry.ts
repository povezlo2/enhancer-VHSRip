import type { ProcessOptions, VideoInfo } from './types';

export interface Geometry {
  srcW: number;
  srcH: number;
  outW: number;
  outH: number;
  /** Scale beyond what the model really reconstructs (pure interpolation). */
  overstretch: boolean;
}

export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Size after crop, and final output size that keeps the display aspect ratio. */
export function geometry(info: Pick<VideoInfo, 'width' | 'height' | 'sarNum' | 'sarDen'>, o: ProcessOptions): Geometry {
  const srcW = o.crop ? o.crop.w : info.width;
  const srcH = o.crop ? o.crop.h : info.height;
  const dar = (srcW * info.sarNum) / info.sarDen / srcH;
  const factor = o.engine === 'realesrgan' ? (o.model === 'realesrgan-x4plus' ? 4 : o.scale) : 2;
  const outH = o.targetHeight === 'auto' ? even(Math.min(1080, srcH * factor)) : o.targetHeight;
  return { srcW, srcH, outW: even(outH * dar), outH, overstretch: outH > srcH * factor * 1.05 };
}
