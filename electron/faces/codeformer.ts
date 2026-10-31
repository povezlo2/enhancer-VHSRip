import * as ort from 'onnxruntime-node';
import type { RgbImage } from './image';
import { createSession, type FaceRestorer, faceToTensor, tensorToFace } from './restorer';

/**
 * CodeFormer face restoration (ONNX export by FaceFusion).
 * Inputs: `input` 1x3x512x512 RGB in [-1, 1] and `weight`, a float64 scalar (fidelity:
 * 0 = invent more detail, 1 = stay closest to the original face). Output `output`, same range.
 */
export class CodeFormer implements FaceRestorer {
  private readonly weight: ort.Tensor;

  private constructor(private readonly session: ort.InferenceSession, fidelity: number) {
    const w = Math.min(1, Math.max(0, fidelity));
    this.weight = new ort.Tensor('float64', new Float64Array([w]), []);
  }

  static async load(modelPath: string, providers: string[], fidelity: number): Promise<CodeFormer> {
    return new CodeFormer(await createSession(modelPath, providers), fidelity);
  }

  async restore(face: RgbImage): Promise<RgbImage> {
    const out = await this.session.run({ input: faceToTensor(face), weight: this.weight });
    return tensorToFace(out['output'].data as Float32Array);
  }
}
