import path from 'node:path';
import type { FaceModelId } from '../../shared/types';
import { runOk } from '../proc';
import type { FrameProcessor, ProcessorContext } from './types';

export interface FaceSettings {
  model: FaceModelId;
  /** CodeFormer fidelity, 0..1. */
  fidelity: number;
  /** How much of the restored face is blended in, 0.1..1. */
  strength: number;
}

/**
 * Face restoration (YuNet + GFPGAN or CodeFormer on ONNX Runtime) in a separate process,
 * so model loading and inference never block the app window. Works in place.
 */
export class LocalFaceRestore implements FrameProcessor {
  readonly id = 'faces-onnx';
  readonly stage = 'faces';
  readonly contextFrames = 0;
  readonly weight = 3;
  readonly signature: Record<string, unknown>;

  constructor(private readonly modelsDir: string, private readonly settings: FaceSettings) {
    const { model, strength } = settings;
    this.signature = { id: this.id, model, strength, ...(model === 'codeformer' ? { fidelity: settings.fidelity } : {}) };
  }

  async run(dir: string, ctx: ProcessorContext): Promise<string> {
    const { model, fidelity, strength } = this.settings;
    await runOk(process.execPath, [
      path.join(__dirname, '..', 'faces', 'cli.js'),
      '--dir', dir, '--models', this.modelsDir, '--model', model,
      '--fidelity', String(fidelity), '--strength', String(strength),
    ], {
      signal: ctx.signal,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      onStdout: lineParser((line) => {
        const m = /^progress (\d+) (\d+) (\d+)/.exec(line);
        if (m) ctx.onProgress({ done: Number(m[1]), total: Number(m[2]), faces: Number(m[3]) });
      }),
    });
    return dir;
  }
}

/** Split a stream into lines and call `onLine` for each complete line. */
export function lineParser(onLine: (line: string) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    lines.forEach(onLine);
  };
}
