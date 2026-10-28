import type * as ort from 'onnxruntime-node';
import type { RgbImage } from './image';
import { createSession, type FaceRestorer, faceToTensor, tensorToFace } from './restorer';

/** GFPGAN v1.4 face restoration (ONNX): 1x3x512x512 RGB in [-1, 1] -> same. */
export class Gfpgan implements FaceRestorer {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(modelPath: string, providers: string[]): Promise<Gfpgan> {
    return new Gfpgan(await createSession(modelPath, providers));
  }

  async restore(face: RgbImage): Promise<RgbImage> {
    const out = await this.session.run({ [this.session.inputNames[0]]: faceToTensor(face) });
    return tensorToFace(out[this.session.outputNames[0]].data as Float32Array);
  }
}
