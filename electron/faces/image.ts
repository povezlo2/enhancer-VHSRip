/** Minimal RGB image helpers (interleaved 8-bit, 3 channels). */
export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Bilinear sample of one channel at a fractional position (clamped to the edges). */
export function sample(img: RgbImage, x: number, y: number, c: number): number {
  const { data, width, height } = img;
  const xc = x < 0 ? 0 : x > width - 1 ? width - 1 : x;
  const yc = y < 0 ? 0 : y > height - 1 ? height - 1 : y;
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const x1 = x0 + 1 < width ? x0 + 1 : x0;
  const y1 = y0 + 1 < height ? y0 + 1 : y0;
  const fx = xc - x0;
  const fy = yc - y0;
  const i00 = (y0 * width + x0) * 3 + c;
  const i10 = (y0 * width + x1) * 3 + c;
  const i01 = (y1 * width + x0) * 3 + c;
  const i11 = (y1 * width + x1) * 3 + c;
  const top = data[i00] + (data[i10] - data[i00]) * fx;
  const bottom = data[i01] + (data[i11] - data[i01]) * fx;
  return top + (bottom - top) * fy;
}
