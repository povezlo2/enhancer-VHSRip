import { RgbImage, sample } from './image';

export const FACE_SIZE = 512;

/** FFHQ 5-point template for 512x512 crops (same order as YuNet landmarks). Used by GFPGAN/facexlib. */
const TEMPLATE: [number, number][] = [
  [192.98138, 239.94708],
  [318.90277, 240.1936],
  [256.63416, 314.01935],
  [201.26117, 371.41043],
  [313.08905, 371.15118],
];

/** Similarity transform x' = a*x - b*y + tx, y' = b*x + a*y + ty (frame -> face crop). */
export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/** Least-squares similarity transform mapping `src` points onto `dst` points (closed form). */
export function estimateSimilarity(src: [number, number][], dst: [number, number][] = TEMPLATE): Similarity {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1];
  }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - sx, py = src[i][1] - sy;
    const qx = dst[i][0] - dx, qy = dst[i][1] - dy;
    num1 += px * qx + py * qy;
    num2 += px * qy - py * qx;
    den += px * px + py * py;
  }
  const a = num1 / den;
  const b = num2 / den;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

function invert(m: Similarity): Similarity {
  const d = m.a * m.a + m.b * m.b;
  const a = m.a / d;
  const b = -m.b / d;
  return { a, b, tx: -(a * m.tx - b * m.ty), ty: -(b * m.tx + a * m.ty) };
}

const apply = (m: Similarity, x: number, y: number): [number, number] => [m.a * x - m.b * y + m.tx, m.b * x + m.a * y + m.ty];

/** Size of the face in frame pixels (crop scale is 512 / that). */
export function faceScale(m: Similarity): number {
  return FACE_SIZE / Math.hypot(m.a, m.b);
}

/** Cut the aligned 512x512 face out of the frame. */
export function warpFace(frame: RgbImage, m: Similarity): RgbImage {
  const inv = invert(m);
  const data = new Uint8Array(FACE_SIZE * FACE_SIZE * 3);
  for (let v = 0; v < FACE_SIZE; v++) {
    for (let u = 0; u < FACE_SIZE; u++) {
      const [x, y] = apply(inv, u, v);
      const o = (v * FACE_SIZE + u) * 3;
      data[o] = sample(frame, x, y, 0);
      data[o + 1] = sample(frame, x, y, 1);
      data[o + 2] = sample(frame, x, y, 2);
    }
  }
  return { data, width: FACE_SIZE, height: FACE_SIZE };
}

/**
 * Soft mask in crop space: 1 in the middle, fading to 0 towards the crop border, so the seam
 * disappears. `feather` is the fade width in crop pixels.
 */
function maskAt(u: number, v: number, feather: number): number {
  const edge = Math.min(u, v, FACE_SIZE - 1 - u, FACE_SIZE - 1 - v);
  if (edge <= 0) return 0;
  if (edge >= feather) return 1;
  const t = edge / feather;
  return t * t * (3 - 2 * t); // smoothstep
}

/**
 * Paste the restored face back into the frame (in place).
 * `strength` 0..1 blends restored vs. original (lower = more natural, less "other person").
 */
export function pasteFace(frame: RgbImage, face: RgbImage, m: Similarity, strength: number, feather = 48): void {
  const inv = invert(m);
  // Bounding box of the crop square in frame coordinates.
  const corners = [apply(inv, 0, 0), apply(inv, FACE_SIZE, 0), apply(inv, 0, FACE_SIZE), apply(inv, FACE_SIZE, FACE_SIZE)];
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
  const x1 = Math.min(frame.width - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
  const y1 = Math.min(frame.height - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));
  const { data, width } = frame;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [u, v] = apply(m, x, y);
      if (u < 0 || v < 0 || u > FACE_SIZE - 1 || v > FACE_SIZE - 1) continue;
      const alpha = maskAt(u, v, feather) * strength;
      if (alpha <= 0) continue;
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const restored = sample(face, u, v, c);
        data[o + c] = Math.round(data[o + c] + (restored - data[o + c]) * alpha);
      }
    }
  }
}
