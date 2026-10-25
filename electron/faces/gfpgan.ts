import * as ort from 'onnxruntime-node';
import { FACE_SIZE } from './align';
import type { RgbImage } from './image';

/** GFPGAN v1.4 face restoration (ONNX): 1x3x512x512 RGB in [-1, 1] -> same. */
export class Gfpgan {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(modelPath: string, providers: string[]): Promise<Gfpgan> {
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });
    return new Gfpgan(session);
  }

  async restore(face: RgbImage): Promise<RgbImage> {
    const plane = FACE_SIZE * FACE_SIZE;
    const input = new Float32Array(3 * plane);
    const src = face.data;
    for (let i = 0; i < plane; i++) {
      input[i] = src[i * 3] / 127.5 - 1;
      input[plane + i] = src[i * 3 + 1] / 127.5 - 1;
      input[2 * plane + i] = src[i * 3 + 2] / 127.5 - 1;
    }
    const out = await this.session.run({
      [this.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, FACE_SIZE, FACE_SIZE]),
    });
    const res = out[this.session.outputNames[0]].data as Float32Array;
    const data = new Uint8Array(plane * 3);
    for (let i = 0; i < plane; i++) {
      for (let c = 0; c < 3; c++) {
        const v = (res[c * plane + i] + 1) * 127.5;
        data[i * 3 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return { data, width: FACE_SIZE, height: FACE_SIZE };
  }
}
