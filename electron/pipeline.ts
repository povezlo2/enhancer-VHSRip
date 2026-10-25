import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { even, geometry, type Geometry } from '../shared/geometry';
import type { JobProgress, ProcessOptions, VideoInfo } from '../shared/types';
import { runOk } from './proc';
import { modelsDir, requireTool } from './tools';

export { geometry };

export const TMP_ROOT = path.join(os.tmpdir(), 'enhancer-vhsrip');

type Report = (p: Omit<JobProgress, 'jobId'>) => void;

/** Clean-up filters applied to the source before upscaling (VHS-specific). */
export function preFilters(info: VideoInfo, o: ProcessOptions): string[] {
  const f: string[] = [];
  const interlaced = info.interlace === 'tff' || info.interlace === 'bff';
  if (o.deinterlace === 'on' || (o.deinterlace === 'auto' && interlaced)) {
    const parity = interlaced ? info.interlace : 'auto';
    f.push(`bwdif=mode=send_frame:parity=${parity}`);
  }
  if (o.crop) {
    const { w, h, x, y } = o.crop;
    f.push(`crop=${even(w)}:${even(h)}:${Math.max(0, x)}:${Math.max(0, y)}`);
  }
  switch (o.denoise) {
    case 1: f.push('hqdn3d=2:1.5:3:3'); break;
    case 2: f.push('hqdn3d=4:3:6:4.5'); break;
    case 3: f.push('nlmeans=s=3:p=7:r=15'); break;
  }
  if (o.whiteBalance) f.push('grayworld');
  const eq: string[] = [];
  if (o.brightness !== 0) eq.push(`brightness=${o.brightness.toFixed(3)}`);
  if (o.contrast !== 1) eq.push(`contrast=${o.contrast.toFixed(3)}`);
  if (o.saturation !== 1) eq.push(`saturation=${o.saturation.toFixed(3)}`);
  if (o.gamma !== 1) eq.push(`gamma=${o.gamma.toFixed(3)}`);
  if (eq.length) f.push(`eq=${eq.join(':')}`);
  return f;
}

/** Final resize + sharpening applied when encoding. */
function postFilters(g: Geometry, o: ProcessOptions): string[] {
  const f = [`scale=${g.outW}:${g.outH}:flags=lanczos`];
  const amount = [0, 0.4, 0.8, 1.2][o.sharpen];
  if (amount > 0) f.push(`unsharp=5:5:${amount}:5:5:0`);
  f.push('format=yuv420p', 'setsar=1');
  return f;
}

function segmentArgs(o: ProcessOptions): string[] {
  const a: string[] = [];
  if (o.start && o.start > 0) a.push('-ss', o.start.toFixed(3));
  if (o.duration && o.duration > 0) a.push('-t', o.duration.toFixed(3));
  return a;
}

function expectedFrames(info: VideoInfo, o: ProcessOptions): number {
  const len = o.duration && o.duration > 0
    ? Math.min(o.duration, info.duration - (o.start ?? 0))
    : info.duration - (o.start ?? 0);
  return Math.max(1, Math.round(len * info.fps));
}

function frameProgress(onFrame: (n: number) => void) {
  let buf = '';
  return (chunk: string) => {
    buf = (buf + chunk).slice(-2000);
    const all = [...buf.matchAll(/frame=\s*(\d+)/g)];
    const last = all[all.length - 1];
    if (last) onFrame(Number(last[1]));
  };
}

function encodeArgs(o: ProcessOptions, fast: boolean): string[] {
  return [
    '-c:v', 'libx264', '-preset', fast ? 'veryfast' : 'slow', '-crf', String(o.crf),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
  ];
}

export function uniqueOutput(src: string, outDir: string | null, outH: number): string {
  const dir = outDir ?? path.dirname(src);
  const base = path.parse(src).name;
  let candidate = path.join(dir, `${base}_enhanced_${outH}p.mp4`);
  for (let i = 2; existsSync(candidate); i++) {
    candidate = path.join(dir, `${base}_enhanced_${outH}p (${i}).mp4`);
  }
  return candidate;
}

export interface ClipRun {
  info: VideoInfo;
  options: ProcessOptions;
  output: string;
  signal: AbortSignal;
  report: Report;
  /** Faster encoder preset, used for previews. */
  fast?: boolean;
}

/** Full pipeline for one clip: clean-up → upscale → encode with original audio. */
export async function processClip(job: ClipRun): Promise<void> {
  const { info, options: o, output, signal, report } = job;
  const ffmpeg = requireTool('ffmpeg');
  const g = geometry(info, o);
  const total = expectedFrames(info, o);
  const pre = preFilters(info, o);

  if (o.engine === 'ffmpeg') {
    report({ stage: 'encode', percent: 0, framesTotal: total });
    const started = Date.now();
    await runOk(ffmpeg, [
      '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1',
      ...segmentArgs(o), '-i', info.path,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', [...pre, ...postFilters(g, o)].join(','),
      ...encodeArgs(o, !!job.fast), output,
    ], {
      signal,
      onStdout: frameProgress((n) => report({
        stage: 'encode', percent: Math.min(99, (n / total) * 100), framesDone: n, framesTotal: total,
        etaSec: eta(started, n, total),
      })),
    });
    report({ stage: 'done', percent: 100, output });
    return;
  }

  const realesrgan = requireTool('realesrgan');
  const work = path.join(TMP_ROOT, `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const inDir = path.join(work, 'in');
  const outDir = path.join(work, 'out');
  mkdirSync(inDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  try {
    // 1. Clean-up and extract frames (0..10%).
    report({ stage: 'prepare', percent: 0, framesTotal: total });
    await runOk(ffmpeg, [
      '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1',
      ...segmentArgs(o), '-i', info.path, '-an',
      ...(pre.length ? ['-vf', pre.join(',')] : []),
      '-fps_mode', 'passthrough', path.join(inDir, '%08d.png'),
    ], {
      signal,
      onStdout: frameProgress((n) => report({
        stage: 'prepare', percent: Math.min(10, (n / total) * 10), framesDone: n, framesTotal: total,
      })),
    });
    const frames = readdirSync(inDir).length;
    if (!frames) throw new Error('ffmpeg не извлёк ни одного кадра.');

    // 2. Neural upscale (10..90%). Progress = files written to outDir.
    const started = Date.now();
    const scale = o.model === 'realesrgan-x4plus' ? 4 : o.scale;
    const timer = setInterval(() => {
      const done = safeCount(outDir);
      report({
        stage: 'upscale', percent: 10 + (done / frames) * 80, framesDone: done, framesTotal: frames,
        etaSec: eta(started, done, frames),
      });
    }, 700);
    try {
      await runOk(realesrgan, [
        '-i', inDir, '-o', outDir, '-n', o.model, '-s', String(scale), '-f', 'png',
        '-m', modelsDir()!,
      ], { signal });
    } finally {
      clearInterval(timer);
    }
    rmSync(inDir, { recursive: true, force: true }); // free disk early

    // 3. Resize to target, sharpen, encode with source audio (90..100%).
    report({ stage: 'encode', percent: 90, framesTotal: frames });
    await runOk(ffmpeg, [
      '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1',
      '-framerate', String(info.fps), '-i', path.join(outDir, '%08d.png'),
      ...segmentArgs(o), '-i', info.path,
      '-map', '0:v:0', '-map', '1:a:0?',
      '-vf', postFilters(g, o).join(','),
      ...encodeArgs(o, !!job.fast), '-shortest', output,
    ], {
      signal,
      onStdout: frameProgress((n) => report({
        stage: 'encode', percent: 90 + Math.min(9.9, (n / frames) * 10), framesDone: n, framesTotal: frames,
      })),
    });
    report({ stage: 'done', percent: 100, output });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Unprocessed segment scaled to the same size, for side-by-side comparison. */
export async function originalPreview(info: VideoInfo, o: ProcessOptions, output: string, signal: AbortSignal) {
  const ffmpeg = requireTool('ffmpeg');
  const g = geometry(info, o);
  const crop = o.crop ? [`crop=${even(o.crop.w)}:${even(o.crop.h)}:${o.crop.x}:${o.crop.y}`] : [];
  await runOk(ffmpeg, [
    '-hide_banner', '-y', ...segmentArgs(o), '-i', info.path,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', [...crop, `scale=${g.outW}:${g.outH}:flags=bicubic`, 'format=yuv420p', 'setsar=1'].join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '128k', output,
  ], { signal });
}

function safeCount(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

function eta(started: number, done: number, total: number): number | undefined {
  if (done < 2) return undefined;
  const perItem = (Date.now() - started) / 1000 / done;
  return Math.round(perItem * (total - done));
}
