import type { JobStage } from '../../shared/types';

export interface ProcessorProgress {
  done: number;
  total: number;
  /** Faces restored so far in this fragment (face processors). */
  faces?: number;
}

export interface ProcessorContext {
  signal: AbortSignal;
  /** Scratch folder owned by this fragment; deleted afterwards. */
  workDir: string;
  onProgress(p: ProcessorProgress): void;
}

/**
 * One step that works on a fragment's frames (PNG files named %08d.png). Local processors
 * (Real-ESRGAN, face restoration) and, later, cloud ones (SeedVR2) implement the same shape.
 */
export interface FrameProcessor {
  readonly id: string;
  /** Pipeline stage shown in the UI while this processor runs. */
  readonly stage: Extract<JobStage, 'upscale' | 'faces'>;
  /**
   * Neighbouring frames the processor needs on each side of the fragment. Per-frame models
   * use 0; temporal models (e.g. SeedVR2) need context so fragments join without seams.
   */
  readonly contextFrames: number;
  /** Rough share of a fragment's processing time, for the progress bar. */
  readonly weight: number;
  /** Everything that changes the output; part of the fragment cache key. */
  readonly signature: Record<string, unknown>;
  /** Process the frames in `dir`; resolves with the folder that holds the results. */
  run(dir: string, ctx: ProcessorContext): Promise<string>;
}
