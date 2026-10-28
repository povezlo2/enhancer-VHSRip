import { createHash } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Geometry } from '../shared/geometry';
import type { Segment } from '../shared/segments';
import type { JobStage, ProcessOptions, VideoInfo } from '../shared/types';
import { runOk } from './proc';
import { countPng } from './processors/realesrgan';
import type { FrameProcessor } from './processors/types';
import { requireTool } from './tools';

/** Bump when the fragment pipeline changes in a way that makes cached fragments stale. */
const PIPELINE_VERSION = 1;

/**
 * Extra source frames decoded before (and after) a fragment so temporal clean-up filters
 * (bwdif, hqdn3d) are already "warmed up" on its first frame. They are dropped afterwards,
 * which is what keeps fragment boundaries invisible.
 */
export const FILTER_WARMUP = 8;

export interface FragmentSpec {
  info: VideoInfo;
  segment: Segment;
  options: ProcessOptions;
  geometry: Geometry;
  pre: string[];
  post: string[];
  processors: FrameProcessor[];
  encode: string[];
}

export interface FragmentProgress {
  stage: Extract<JobStage, 'prepare' | 'upscale' | 'faces' | 'encode'>;
  /** 0..1 within this fragment. */
  fraction: number;
  faces?: number;
}

/** Hash of everything that changes the rendered fragment: source file, range, filters, models, encoder. */
export function fragmentKey(spec: FragmentSpec): string {
  const { info, segment, geometry: g } = spec;
  const st = statSync(info.path);
  const payload = {
    v: PIPELINE_VERSION,
    src: { path: path.resolve(info.path), size: st.size, mtime: st.mtimeMs },
    range: [segment.start, segment.end],
    rate: info.fpsRational,
    size: [g.outW, g.outH],
    pre: spec.pre,
    post: spec.post,
    processors: spec.processors.map((p) => p.signature),
    encode: spec.encode,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

/** mp4 track timescale that represents every frame duration of `rate` exactly (e.g. 30000/1001 -> 30000). */
export function trackTimescale(rate: string): number {
  const [num] = rate.split('/').map(Number);
  const n = Math.max(1, Math.round(num || 25));
  return n * Math.ceil(10_000 / n);
}

/** Frames to decode around [start, end) and where the fragment starts inside them. */
export function decodeWindow(segment: Segment, contextFrames: number, warmup: number) {
  const ctxBefore = Math.min(contextFrames, segment.start);
  const warmBefore = Math.min(warmup, segment.start - ctxBefore);
  const first = segment.start - ctxBefore - warmBefore;
  const length = segment.end - segment.start;
  return {
    /** First source frame to decode. */
    first,
    /** Frames to skip after decoding starts (filter warm-up). */
    skip: warmBefore,
    /** Frames to keep: processor context + fragment + processor context. */
    keep: ctxBefore + length + contextFrames,
    /** Context frames at the start of the kept frames (dropped when encoding). */
    ctxBefore,
    /** Upper bound on frames to read from the source. */
    read: warmBefore + ctxBefore + length + contextFrames + warmup + 2,
    length,
  };
}

/** Seconds decoded before the wanted frame, so the (keyframe-based) seek always lands early. */
const SEEK_MARGIN = 1;

/**
 * Decode starting exactly at source frame `first`, where frame N is the time slot
 * startTime + N / fps. Two pitfalls this avoids:
 * - ffmpeg's own seek can be a frame off (it keeps a keyframe overlapping the seek point),
 *   so we seek about a second early and keep the source timestamps (-copyts);
 * - captures often contain dropped frames (gaps in the timestamps). Counting decoded frames
 *   would drift away from the audio, so the `fps` filter maps pictures to slots by timestamp:
 *   it starts exactly at the wanted slot and repeats the previous picture where one is
 *   missing (what a player shows anyway), the same way for every fragment.
 */
export function exactSeek(info: VideoInfo, first: number, read: number): { input: string[]; filter: string[] } {
  const at = first / info.fps;
  const ss = Math.max(0, at - SEEK_MARGIN);
  const input = ['-copyts'];
  if (ss > 0) input.push('-ss', ss.toFixed(6));
  input.push('-t', (at - ss + read / info.fps).toFixed(6));
  const slot0 = info.startTime + at;
  const filter = [`fps=fps=${info.fpsRational}:start_time=${slot0.toFixed(6)}`];
  return { input, filter };
}

/** Constant frame timing from 0, so fragments concatenate without gaps or drift. */
const cfr = (rate: string) => `setpts=N/((${rate})*TB)`;

/**
 * Render one fragment to an H.264 file without audio: decode with warm-up, clean up,
 * run the processors on PNG frames, then resize, sharpen and encode.
 */
export async function renderFragment(
  spec: FragmentSpec, workDir: string, output: string, signal: AbortSignal,
  report: (p: FragmentProgress) => void,
): Promise<void> {
  const ffmpeg = requireTool('ffmpeg');
  const { info, segment } = spec;
  const ctx = Math.max(0, ...spec.processors.map((p) => p.contextFrames));
  const w = decodeWindow(segment, ctx, spec.pre.length ? FILTER_WARMUP : 0);
  const rate = info.fpsRational;
  const timing = ['-video_track_timescale', String(trackTimescale(rate))];
  const trim = `trim=start_frame=${w.skip}:end_frame=${w.skip + w.keep}`;
  const seek = exactSeek(info, w.first, w.read);

  if (!spec.processors.length) {
    report({ stage: 'encode', fraction: 0 });
    await runOk(ffmpeg, [
      '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1',
      ...seek.input, '-i', info.path, '-an',
      '-vf', [...seek.filter, ...spec.pre, trim, cfr(rate), ...spec.post].join(','),
      '-frames:v', String(w.length), '-r', rate, ...spec.encode, ...timing, output,
    ], { signal, onStdout: frameCounter((n) => report({ stage: 'encode', fraction: n / w.length })) });
    return;
  }

  // Bands inside a fragment: decode 10%, processors by weight, encode 8%.
  const weights = spec.processors.map((p) => p.weight);
  const sum = weights.reduce((a, b) => a + b, 0);
  const procSpan = 0.82;
  let base = 0.1;

  const frames = path.join(workDir, 'frames');
  mkdirSync(frames, { recursive: true });
  report({ stage: 'prepare', fraction: 0 });
  await runOk(ffmpeg, [
    '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1',
    ...seek.input, '-i', info.path, '-an',
    '-vf', [...seek.filter, ...spec.pre, trim].join(','), '-fps_mode', 'passthrough', path.join(frames, '%08d.png'),
  ], { signal, onStdout: frameCounter((n) => report({ stage: 'prepare', fraction: (0.1 * n) / w.keep })) });
  const decoded = countPng(frames);
  if (decoded < w.ctxBefore + 1) throw new Error('ffmpeg не извлёк ни одного кадра фрагмента.');

  let dir = frames;
  for (const [i, p] of spec.processors.entries()) {
    const span = (procSpan * weights[i]) / sum;
    const start = base;
    dir = await p.run(dir, {
      signal, workDir,
      onProgress: ({ done, total, faces }) =>
        report({ stage: p.stage, fraction: start + span * Math.min(1, done / Math.max(1, total)), faces }),
    });
    base += span;
  }

  report({ stage: 'encode', fraction: 0.92 });
  const length = Math.min(w.length, decoded - w.ctxBefore);
  await runOk(ffmpeg, [
    '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1',
    '-framerate', rate, '-start_number', String(w.ctxBefore + 1), '-i', path.join(dir, '%08d.png'),
    '-vf', spec.post.join(','), '-frames:v', String(length), ...spec.encode, ...timing, output,
  ], { signal, onStdout: frameCounter((n) => report({ stage: 'encode', fraction: 0.92 + (0.08 * n) / length })) });
}

/** Calls `onFrame` with the latest `frame=` value from ffmpeg's -progress output. */
export function frameCounter(onFrame: (n: number) => void) {
  let buf = '';
  return (chunk: string) => {
    buf = (buf + chunk).slice(-2000);
    const all = [...buf.matchAll(/frame=\s*(\d+)/g)];
    const last = all[all.length - 1];
    if (last) onFrame(Number(last[1]));
  };
}
