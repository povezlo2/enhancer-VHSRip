import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { even, geometry, type Geometry } from '../shared/geometry';
import { coversRange, fixedSegments, type Segment, segmentFrames } from '../shared/segments';
import type { JobProgress, ProcessOptions, SegmentState, VideoInfo } from '../shared/types';
import type { ChunkCache } from './cache';
import { type FragmentSpec, fragmentKey, renderFragment } from './fragment';
import { CancelledError, runOk } from './proc';
import { LocalFaceRestore } from './processors/faces';
import { LocalRealEsrgan } from './processors/realesrgan';
import type { FrameProcessor } from './processors/types';
import { requireTool, tools } from './tools';

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
export function postFilters(g: Geometry, o: ProcessOptions): string[] {
  const f = [`scale=${g.outW}:${g.outH}:flags=lanczos`];
  const amount = [0, 0.4, 0.8, 1.2][o.sharpen];
  if (amount > 0) f.push(`unsharp=5:5:${amount}:5:5:0`);
  f.push('format=yuv420p', 'setsar=1');
  return f;
}

function encodeArgs(o: ProcessOptions, fast: boolean): string[] {
  return ['-c:v', 'libx264', '-preset', fast ? 'veryfast' : 'slow', '-crf', String(o.crf), '-pix_fmt', 'yuv420p'];
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

/** Source frames [start, end) covered by the job (whole file, or the preview segment). */
export function jobRange(info: VideoInfo, o: ProcessOptions): { start: number; end: number } {
  const total = Math.max(1, info.frames);
  const start = Math.min(total - 1, Math.max(0, Math.round((o.start ?? 0) * info.fps)));
  const end = o.duration && o.duration > 0 ? Math.min(total, start + Math.max(1, Math.round(o.duration * info.fps))) : total;
  return { start, end };
}

/** Settings of one fragment: the clip settings plus the fragment's own overrides. */
export function fragmentOptions(o: ProcessOptions, s: Segment): ProcessOptions {
  return s.overrides?.faceRestore === undefined ? o : { ...o, faceRestore: s.overrides.faceRestore };
}

/** Local processors for a fragment, in order. Empty for the fast ffmpeg engine. */
export function localProcessors(o: ProcessOptions): FrameProcessor[] {
  if (o.engine !== 'realesrgan') return [];
  const chain: FrameProcessor[] = [new LocalRealEsrgan(o.model, o.model === 'realesrgan-x4plus' ? 4 : o.scale)];
  if (o.faceRestore) {
    const t = tools();
    if (!t.faces || !t.faceModels.includes(o.faceModel)) {
      throw new Error(`Не найдена модель лиц ${o.faceModel}. Запустите «npm run setup» в папке проекта.`);
    }
    chain.push(new LocalFaceRestore(t.faces, { model: o.faceModel, fidelity: o.faceFidelity, strength: o.faceStrength }));
  }
  return chain;
}

export interface ClipRun {
  info: VideoInfo;
  options: ProcessOptions;
  output: string;
  signal: AbortSignal;
  report: Report;
  /** Fragments to cut the clip into; null/undefined = equal fragments of up to 10 s. */
  segments?: Segment[] | null;
  /** Finished fragments are stored here and reused; null = render everything, keep nothing. */
  cache: ChunkCache | null;
  /** Faster encoder preset, used for previews. */
  fast?: boolean;
  /** Attempts per fragment before the job fails (a GPU driver hiccup should not lose the job). */
  attempts?: number;
}

/**
 * Full pipeline for one clip: cut into fragments → clean up, upscale and restore faces in
 * each fragment (reusing cached ones) → join the fragments and add the original audio.
 */
export async function processClip(job: ClipRun): Promise<void> {
  const { info, options: o, output, signal, report } = job;
  const g = geometry(info, o);
  const range = jobRange(info, o);
  const segments = job.segments?.length ? job.segments : fixedSegments(range.start, range.end, info.fps);
  if (!coversRange(segments, segments[0].start, segments[segments.length - 1].end)
      || segments[0].start < range.start || segments[segments.length - 1].end > range.end) {
    throw new Error('Фрагменты должны идти подряд и не выходить за пределы видео.');
  }
  const first = segments[0].start;
  const last = segments[segments.length - 1].end;
  const total = last - first;
  const pre = preFilters(info, o);
  const post = postFilters(g, o);
  const encode = encodeArgs(o, !!job.fast);

  const states: SegmentState[] = segments.map(() => 'pending');
  const work = path.join(TMP_ROOT, `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(work, { recursive: true });
  const files: string[] = [];
  const started = Date.now();
  let doneFrames = 0;
  let workedFrames = 0; // frames actually rendered (not cached), for the ETA
  let faces = 0;

  // 0..97% fragments (by frames), 97..100% joining.
  const overall = (fragmentFrames: number) => (97 * (doneFrames + fragmentFrames)) / total;
  const emit = (p: Omit<JobProgress, 'jobId' | 'segments' | 'segmentCount'>) =>
    report({ ...p, segments: [...states], segmentCount: segments.length });

  try {
    for (const [i, seg] of segments.entries()) {
      const so = fragmentOptions(o, seg);
      const spec: FragmentSpec = {
        info, segment: seg, options: so, geometry: g, pre, post, encode, processors: localProcessors(so),
      };
      const len = segmentFrames(seg);
      const key = fragmentKey(spec);
      const cached = job.cache?.get(key);
      if (cached) {
        states[i] = 'cached';
        files.push(cached);
        doneFrames += len;
        emit({ stage: 'prepare', percent: overall(0), segmentIndex: i, framesDone: doneFrames, framesTotal: total });
        continue;
      }

      states[i] = 'running';
      const attempts = Math.max(1, job.attempts ?? 3);
      let file = '';
      let fragmentFaces = 0;
      for (let attempt = 1; ; attempt++) {
        fragmentFaces = 0;
        const dir = path.join(work, `f${i}-a${attempt}`);
        mkdirSync(dir, { recursive: true });
        file = path.join(work, `fragment-${String(i).padStart(4, '0')}.mp4`);
        try {
          await renderFragment(spec, dir, file, signal, ({ stage, fraction, faces: f }) => {
            const doneHere = Math.round(fraction * len);
            emit({
              stage, percent: overall(fraction * len), segmentIndex: i,
              framesDone: doneFrames + doneHere, framesTotal: total,
              faces: f === undefined ? undefined : faces + f,
              // Cached fragments cost nothing, so the ETA only counts rendered frames.
              etaSec: eta(started, workedFrames + doneHere, workedFrames + total - doneFrames),
              message: attempt > 1 ? `повтор ${attempt}/${attempts}` : undefined,
            });
            if (f !== undefined) fragmentFaces = f;
          });
          break;
        } catch (err) {
          if (err instanceof CancelledError || signal.aborted || attempt >= attempts) {
            if (!(err instanceof CancelledError)) states[i] = 'error';
            throw err;
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      faces += fragmentFaces;
      files.push(job.cache ? job.cache.put(key, file, files) : file);
      states[i] = 'done';
      doneFrames += len;
      workedFrames += len;
    }

    emit({ stage: 'assemble', percent: 97, framesDone: total, framesTotal: total, faces });
    await assemble(info, files, first, total, output, work, signal);
    report({ stage: 'done', percent: 100, output, segments: [...states], segmentCount: segments.length, faces });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Join fragments without re-encoding and add the source audio for the same time span. */
async function assemble(
  info: VideoInfo, files: string[], firstFrame: number, frames: number, output: string, work: string, signal: AbortSignal,
) {
  const list = path.join(work, 'fragments.txt');
  writeFileSync(list, files.map((f) => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const audio: string[] = [];
  if (firstFrame > 0) audio.push('-ss', (firstFrame / info.fps).toFixed(6));
  audio.push('-t', (frames / info.fps).toFixed(6));
  await runOk(requireTool('ffmpeg'), [
    '-hide_banner', '-y', '-nostats',
    '-f', 'concat', '-safe', '0', '-i', list,
    ...audio, '-i', info.path,
    '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', output,
  ], { signal });
}

/** Unprocessed segment scaled to the same size, for side-by-side comparison (same frames as the variants). */
export async function originalPreview(info: VideoInfo, o: ProcessOptions, output: string, signal: AbortSignal) {
  const g = geometry(info, o);
  const crop = o.crop ? [`crop=${even(o.crop.w)}:${even(o.crop.h)}:${o.crop.x}:${o.crop.y}`] : [];
  const range = jobRange(info, o);
  const work = path.join(TMP_ROOT, `original-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  try {
    const fragment = path.join(work, 'original.mp4');
    await renderFragment({
      info, segment: range, options: o, geometry: g, pre: crop, processors: [],
      post: [`scale=${g.outW}:${g.outH}:flags=bicubic`, 'format=yuv420p', 'setsar=1'],
      encode: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'],
    }, work, fragment, signal, () => undefined);
    await assemble(info, [fragment], range.start, range.end - range.start, output, work, signal);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function eta(started: number, done: number, total: number): number | undefined {
  if (done < 2) return undefined;
  const perItem = (Date.now() - started) / 1000 / done;
  return Math.round(perItem * (total - done));
}
