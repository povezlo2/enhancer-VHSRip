import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ModelId } from '../../shared/types';
import { runOk } from '../proc';
import { modelsDir, requireTool } from '../tools';
import type { FrameProcessor, ProcessorContext } from './types';

/** Real-ESRGAN ncnn-vulkan, frame by frame on the local GPU (Vulkan). */
export class LocalRealEsrgan implements FrameProcessor {
  readonly id = 'realesrgan-ncnn';
  readonly stage = 'upscale';
  readonly contextFrames = 0;
  readonly weight = 6;
  readonly signature: Record<string, unknown>;

  constructor(private readonly model: ModelId, private readonly scale: number) {
    this.signature = { id: this.id, model, scale };
  }

  async run(dir: string, ctx: ProcessorContext): Promise<string> {
    const out = path.join(ctx.workDir, 'upscaled');
    mkdirSync(out, { recursive: true });
    const total = countPng(dir);
    // Progress = files written so far; the tool itself prints nothing useful per frame.
    const timer = setInterval(() => ctx.onProgress({ done: countPng(out), total }), 700);
    try {
      await runOk(requireTool('realesrgan'), [
        '-i', dir, '-o', out, '-n', this.model, '-s', String(this.scale), '-f', 'png', '-m', modelsDir()!,
      ], { signal: ctx.signal });
    } finally {
      clearInterval(timer);
    }
    const done = countPng(out);
    if (done < total) throw new Error(`Real-ESRGAN обработал ${done} из ${total} кадров.`);
    ctx.onProgress({ done, total });
    rmSync(dir, { recursive: true, force: true }); // free disk early
    return out;
  }
}

export function countPng(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.png')).length;
  } catch {
    return 0;
  }
}
