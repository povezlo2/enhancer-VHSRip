import * as ort from 'onnxruntime-node';
import { FACE_SIZE } from './align';
import type { RgbImage } from './image';

/** A model that turns an aligned 512x512 face crop into a restored one. */
export interface FaceRestorer {
  restore(face: RgbImage): Promise<RgbImage>;
}

/** Aligned face (RGB, 0..255) -> 1x3x512x512 float tensor in [-1, 1]. Same for GFPGAN and CodeFormer. */
export function faceToTensor(face: RgbImage): ort.Tensor {
  const plane = FACE_SIZE * FACE_SIZE;
  const input = new Float32Array(3 * plane);
  const src = face.data;
  for (let i = 0; i < plane; i++) {
    input[i] = src[i * 3] / 127.5 - 1;
    input[plane + i] = src[i * 3 + 1] / 127.5 - 1;
    input[2 * plane + i] = src[i * 3 + 2] / 127.5 - 1;
  }
  return new ort.Tensor('float32', input, [1, 3, FACE_SIZE, FACE_SIZE]);
}

/** Inverse of faceToTensor, clamped to 0..255. */
export function tensorToFace(res: Float32Array): RgbImage {
  const plane = FACE_SIZE * FACE_SIZE;
  const data = new Uint8Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      const v = (res[c * plane + i] + 1) * 127.5;
      data[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return { data, width: FACE_SIZE, height: FACE_SIZE };
}

export function createSession(modelPath: string, providers: string[]): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(modelPath, { executionProviders: providers, graphOptimizationLevel: 'all' });
}
