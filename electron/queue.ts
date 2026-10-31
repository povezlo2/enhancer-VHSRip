import type { Segment } from '../shared/segments';
import type { JobProgress, ProcessOptions } from '../shared/types';
import { analyze } from './analyze';
import type { ChunkCache } from './cache';
import { geometry, processClip, uniqueOutput } from './pipeline';
import { CancelledError } from './proc';

interface Job {
  id: string;
  path: string;
  options: ProcessOptions;
  outDir: string | null;
  segments: Segment[] | null;
  controller: AbortController;
}

/** Processes clips one at a time; the GPU is the bottleneck, so parallel jobs would only slow each other. */
export class JobQueue {
  private jobs: Job[] = [];
  private running = false;
  private seq = 0;

  constructor(private readonly emit: (p: JobProgress) => void, private readonly cache: ChunkCache | null) {}

  enqueue(path: string, options: ProcessOptions, outDir: string | null, segments: Segment[] | null = null): string {
    const id = `j${++this.seq}`;
    this.jobs.push({ id, path, options, outDir, segments, controller: new AbortController() });
    this.emit({ jobId: id, stage: 'queued', percent: 0 });
    void this.pump();
    return id;
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return;
    job.controller.abort();
    this.jobs = this.jobs.filter((j) => j.id !== id || j === this.jobs[0] && this.running);
    this.emit({ jobId: id, stage: 'cancelled', percent: 0 });
  }

  cancelAll(): void {
    for (const j of [...this.jobs]) this.cancel(j.id);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];
        if (!job.controller.signal.aborted) await this.runJob(job);
        this.jobs.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: Job): Promise<void> {
    const report = (p: Omit<JobProgress, 'jobId'>) => {
      if (!job.controller.signal.aborted) this.emit({ ...p, jobId: job.id });
    };
    try {
      report({ stage: 'prepare', percent: 0, message: 'Анализ…' });
      const info = await analyze(job.path);
      const output = uniqueOutput(job.path, job.outDir, geometry(info, job.options).outH);
      await processClip({
        info, options: job.options, output, signal: job.controller.signal, report,
        segments: job.segments, cache: this.cache,
      });
    } catch (err) {
      if (err instanceof CancelledError || job.controller.signal.aborted) return;
      this.emit({ jobId: job.id, stage: 'error', percent: 0, message: (err as Error).message });
    }
  }
}
