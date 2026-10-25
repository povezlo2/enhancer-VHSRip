import * as ort from 'onnxruntime-node';
import { RgbImage, sample } from './image';

/** Detected face in frame pixel coordinates. */
export interface Face {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  /** 5 landmarks: right eye, left eye, nose tip, right mouth corner, left mouth corner (person's sides). */
  kps: [number, number][];
}

const SIZE = 640; // the 2023mar model has a fixed 1x3x640x640 input
const STRIDES = [8, 16, 32];

/**
 * YuNet face detector (OpenCV Zoo, face_detection_yunet_2023mar.onnx).
 * The frame is letterboxed into 640x640; raw outputs are decoded per stride and filtered with NMS.
 */
export class YuNet {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(modelPath: string, providers: string[]): Promise<YuNet> {
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: providers });
    return new YuNet(session);
  }

  async detect(img: RgbImage, scoreThreshold = 0.7, nmsThreshold = 0.3): Promise<Face[]> {
    const scale = Math.min(SIZE / img.width, SIZE / img.height);
    const input = new Float32Array(3 * SIZE * SIZE); // zero padding outside the picture
    const plane = SIZE * SIZE;
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const inv = 1 / scale;
    for (let y = 0; y < h; y++) {
      const sy = (y + 0.5) * inv - 0.5;
      for (let x = 0; x < w; x++) {
        const sx = (x + 0.5) * inv - 0.5;
        const o = y * SIZE + x;
        // Model expects BGR, 0..255, NCHW.
        input[o] = sample(img, sx, sy, 2);
        input[plane + o] = sample(img, sx, sy, 1);
        input[2 * plane + o] = sample(img, sx, sy, 0);
      }
    }

    const out = await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });

    const faces: Face[] = [];
    for (const s of STRIDES) {
      const cls = out[`cls_${s}`].data as Float32Array;
      const obj = out[`obj_${s}`].data as Float32Array;
      const bbox = out[`bbox_${s}`].data as Float32Array;
      const kps = out[`kps_${s}`].data as Float32Array;
      const cols = SIZE / s;
      const rows = SIZE / s;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c;
          const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
          if (score < scoreThreshold) continue;
          const cx = (c + bbox[i * 4]) * s;
          const cy = (r + bbox[i * 4 + 1]) * s;
          const bw = Math.exp(bbox[i * 4 + 2]) * s;
          const bh = Math.exp(bbox[i * 4 + 3]) * s;
          const points: [number, number][] = [];
          for (let k = 0; k < 5; k++) {
            points.push([((c + kps[i * 10 + 2 * k]) * s) * inv, ((r + kps[i * 10 + 2 * k + 1]) * s) * inv]);
          }
          faces.push({
            x: (cx - bw / 2) * inv,
            y: (cy - bh / 2) * inv,
            w: bw * inv,
            h: bh * inv,
            score,
            kps: points,
          });
        }
      }
    }
    return nms(faces, nmsThreshold);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function iou(a: Face, b: Face): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

function nms(faces: Face[], threshold: number): Face[] {
  const sorted = [...faces].sort((a, b) => b.score - a.score);
  const keep: Face[] = [];
  for (const f of sorted) {
    if (keep.every((k) => iou(k, f) <= threshold)) keep.push(f);
  }
  return keep;
}
