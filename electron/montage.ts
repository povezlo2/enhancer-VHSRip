import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { clipFrames, type MontageClip, montageFrames, validMontage } from '../shared/montage';
import type { MontageProgress, Thumbnails, VideoInfo } from '../shared/types';
import { frameCounter } from './fragment';
import { runOk } from './proc';
import { requireTool } from './tools';

/** Seconds decoded before a clip's first frame, so the keyframe seek always lands early. */
const SEEK_MARGIN = 1;
/** One ffmpeg call opens the source once per clip; more than this is split into passes. */
export const MAX_CLIPS = 300;

/** Output file next to the source (or in `outDir`): name_montage.mkv, name_montage (2).mkv, ... */
export function montageOutput(src: string, outDir: string | null): string {
  const dir = outDir ?? path.dirname(src);
  const base = path.parse(src).name;
  let candidate = path.join(dir, `${base}_montage.mkv`);
  for (let i = 2; existsSync(candidate); i++) candidate = path.join(dir, `${base}_montage (${i}).mkv`);
  return candidate;
}

/**
 * ffmpeg arguments that cut the clips out of the source frame-exactly and join them.
 * Same timing rules as fragments: frame N is the slot startTime + N / fps, found by
 * timestamp (seek early, -copyts, fps filter), so dropped frames do not shift the audio.
 *
 * The result is lossless (FFV1 + FLAC in MKV) and keeps interlacing: it is an intermediate
 * that the enhancer processes next, so cutting must not cost any quality.
 */
export function montageArgs(info: VideoInfo, clips: MontageClip[], output: string, hasAudio: boolean): string[] {
  const inputs: string[] = [];
  const filters: string[] = [];
  const pads: string[] = [];
  const rate = info.fpsRational;
  for (const [i, c] of clips.entries()) {
    const at = c.start / info.fps;
    const len = clipFrames(c);
    const ss = Math.max(0, at - SEEK_MARGIN);
    if (ss > 0) inputs.push('-ss', ss.toFixed(6));
    inputs.push('-t', (at - ss + len / info.fps + 0.5).toFixed(6), '-i', info.path);
    const t0 = info.startTime + at;
    filters.push(`[${i}:v:0]fps=fps=${rate}:start_time=${t0.toFixed(6)},trim=end_frame=${len},setpts=N/((${rate})*TB)[v${i}]`);
    pads.push(`[v${i}]`);
    if (hasAudio) {
      const t1 = t0 + len / info.fps;
      filters.push(`[${i}:a:0]atrim=start=${t0.toFixed(6)}:end=${t1.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`);
      pads.push(`[a${i}]`);
    }
  }
  filters.push(`${pads.join('')}concat=n=${clips.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`);

  const fieldOrder = info.interlace === 'tff' ? ['-field_order', 'tt'] : info.interlace === 'bff' ? ['-field_order', 'bb'] : [];
  return [
    '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-copyts',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[v]', ...(hasAudio ? ['-map', '[a]'] : []),
    '-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '4', '-slicecrc', '1', ...fieldOrder,
    '-r', rate, ...(hasAudio ? ['-c:a', 'flac'] : []),
    output,
  ];
}

/** Render the montage to a lossless MKV. Written to a temp name first, so a cancelled render leaves nothing. */
export async function renderMontage(
  info: VideoInfo, clips: MontageClip[], output: string, signal: AbortSignal,
  onProgress: (p: Omit<MontageProgress, 'output'>) => void,
): Promise<void> {
  if (!validMontage(clips, Math.max(1, info.frames))) throw new Error('Монтаж пуст или выходит за пределы видео.');
  if (clips.length > MAX_CLIPS) throw new Error(`Слишком много клипов (${clips.length}), максимум ${MAX_CLIPS}.`);
  const total = montageFrames(clips);
  const tmp = `${output}.part.mkv`;
  const started = Date.now();
  mkdirSync(path.dirname(output), { recursive: true });
  try {
    await runOk(requireTool('ffmpeg'), montageArgs(info, clips, tmp, !!info.audioCodec), {
      signal,
      onStdout: frameCounter((n) => {
        const done = Math.min(n, total);
        const secs = (Date.now() - started) / 1000;
        onProgress({
          percent: Math.min(99, (done / total) * 100), framesDone: done, framesTotal: total,
          etaSec: done > 5 ? Math.round((secs / done) * (total - done)) : undefined,
        });
      }),
    });
    renameSync(tmp, output);
  } finally {
    rmSync(tmp, { force: true });
  }
  onProgress({ percent: 100, framesDone: total, framesTotal: total });
}

/**
 * Small JPEG thumbnails for the montage timeline: one every `interval` seconds (at most
 * ~400 per file), cached per file version.
 */
export async function thumbnailsFor(info: VideoInfo, dir: string): Promise<Thumbnails> {
  const st = statSync(info.path);
  const key = createHash('sha256').update(JSON.stringify([path.resolve(info.path), st.size, st.mtimeMs])).digest('hex').slice(0, 24);
  const interval = Math.max(0.5, Math.ceil((info.duration / 400) * 2) / 2);
  const out = path.join(dir, key);
  const list = () => (existsSync(out) ? readdirSync(out).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(out, f)) : []);
  if (!existsSync(path.join(out, 'done'))) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const deint = info.interlace === 'tff' || info.interlace === 'bff' ? 'bwdif=mode=send_frame,' : '';
    await runOk(requireTool('ffmpeg'), [
      '-hide_banner', '-y', '-nostats', '-i', info.path, '-an',
      // Thumbnail k shows the picture at k * interval seconds.
      '-vf', `${deint}fps=fps=1/${interval}:start_time=${info.startTime.toFixed(6)}:round=down,scale=-2:72`,
      '-q:v', '5', path.join(out, '%05d.jpg'),
    ]);
    mkdirSync(path.join(out, 'done'));
  }
  return { interval, files: list() };
}
