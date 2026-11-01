import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { VideoInfo } from '../shared/types';
import { exactSeek, frameCounter, trackTimescale } from './fragment';
import { runOk } from './proc';
import { requireTool } from './tools';

/**
 * Frames reversed at a time. ffmpeg's `reverse` keeps every frame of its input in memory,
 * so a whole clip would need gigabytes; chunks keep it to a few tens of megabytes.
 */
export const REVERSE_CHUNK = 64;

export type ReverseKind = 'lossless' | 'proxy';

const interlaced = (i: VideoInfo) => i.interlace === 'tff' || i.interlace === 'bff';

/** Chunks of [start, end) from the end backwards: each is reversed, then they are joined in this order. */
export function reverseChunks(start: number, end: number, size = REVERSE_CHUNK): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  for (let to = end; to > start; to -= size) out.push({ from: Math.max(start, to - size), to });
  return out;
}

/**
 * Write source frames [start, end) played backwards, sound too. Frame N is the time slot
 * startTime + N / fps, exactly as everywhere else (dropped frames repeat the previous one).
 * Interlaced sources are deinterlaced first: reversing whole frames would swap the order of
 * their fields in time.
 *
 * lossless: FFV1 + FLAC in MKV, for the montage. proxy: small H.264 + AAC MP4 for the player.
 */
export async function reverseRange(
  info: VideoInfo, start: number, end: number, output: string, kind: ReverseKind, signal?: AbortSignal,
  onFrames?: (done: number) => void,
): Promise<void> {
  const ffmpeg = requireTool('ffmpeg');
  const work = `${output}.chunks`;
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const rate = info.fpsRational;
  const ext = kind === 'proxy' ? 'mp4' : 'mkv';
  const files: string[] = [];
  let done = 0;
  try {
    for (const [j, c] of reverseChunks(start, end).entries()) {
      const n = c.to - c.from;
      const seek = exactSeek(info, c.from, n);
      const v = [
        ...seek.filter,
        // A chunk at the very end may run out of frames: repeat the last one so every chunk is exact.
        `tpad=stop_mode=clone:stop=${n}`, `trim=end_frame=${n}`,
        ...(interlaced(info) ? [`bwdif=mode=send_frame:parity=${info.interlace}`] : []),
        'reverse',
        ...(kind === 'proxy' ? ['scale=-2:min(ih\\,360)', 'format=yuv420p'] : []),
        `setpts=N/((${rate})*TB)`,
      ];
      const t0 = info.startTime + c.from / info.fps;
      const t1 = info.startTime + c.to / info.fps;
      const audio = info.audioCodec
        ? ['-af', `atrim=start=${t0.toFixed(6)}:end=${t1.toFixed(6)},asetpts=PTS-STARTPTS,areverse`]
        : ['-an'];
      const encode = kind === 'proxy'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', String(Math.max(1, Math.round(info.fps / 2))),
          ...(info.audioCodec ? ['-c:a', 'aac', '-b:a', '96k'] : []), '-video_track_timescale', String(trackTimescale(rate))]
        : ['-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '4', ...(info.audioCodec ? ['-c:a', 'flac'] : [])];
      const file = path.join(work, `${String(j).padStart(5, '0')}.${ext}`);
      await runOk(ffmpeg, [
        '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...seek.input, '-i', info.path,
        '-map', '0:v:0', ...(info.audioCodec ? ['-map', '0:a:0'] : []),
        '-vf', v.join(','), ...audio, '-frames:v', String(n), '-r', rate, ...encode, file,
      ], { signal, onStdout: frameCounter((k) => onFrames?.(done + Math.min(k, n))) });
      files.push(file);
      done += n;
      onFrames?.(done);
    }
    const list = path.join(work, 'chunks.txt');
    writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    const tmp = `${output}.part.${ext}`;
    await runOk(ffmpeg, [
      '-hide_banner', '-y', '-nostats', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy',
      ...(kind === 'proxy' ? ['-movflags', '+faststart'] : []), tmp,
    ], { signal });
    renameSync(tmp, output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** What the montage needs to know about a reversed lossless file made by reverseRange. */
export function reversedInfo(src: VideoInfo, file: string, frames: number): VideoInfo {
  return {
    ...src,
    path: file,
    name: path.basename(file),
    container: 'matroska',
    videoCodec: 'ffv1',
    startTime: 0,
    frames,
    duration: frames / src.fps,
    interlace: interlaced(src) ? 'progressive' : src.interlace,
    interlaceRatio: 0,
    suggestedCrop: null,
    audioCodec: src.audioCodec ? 'flac' : undefined,
  };
}

const pending = new Map<string, Promise<string>>();

/** The whole source backwards as a small playable copy (the player cannot play backwards by itself). */
export function reversedProxyFor(info: VideoInfo, dir: string): Promise<string> {
  const st = statSync(info.path);
  const key = createHash('sha256').update(JSON.stringify(['rev', path.resolve(info.path), st.size, st.mtimeMs])).digest('hex').slice(0, 24);
  const file = path.join(dir, `${key}.mp4`);
  if (existsSync(file)) return Promise.resolve(file);
  let job = pending.get(file);
  if (!job) {
    mkdirSync(dir, { recursive: true });
    job = reverseRange(info, 0, Math.max(1, info.frames), file, 'proxy').then(() => file).finally(() => pending.delete(file));
    pending.set(file, job);
  }
  return job;
}
