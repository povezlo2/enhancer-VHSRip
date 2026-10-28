import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { VideoInfo } from '../shared/types';
import { runOk } from './proc';
import { requireTool } from './tools';

const pending = new Map<string, Promise<string>>();

/**
 * Small H.264 copy of the source for the fragment editor: Chromium cannot play AVI/XviD,
 * MPEG-2 and friends. Same frames and timing as the source (no frame-rate conversion), so
 * a time in the proxy maps to the same source frame. Frequent keyframes for quick scrubbing.
 */
export function proxyFor(info: VideoInfo, dir: string): Promise<string> {
  const st = statSync(info.path);
  const key = createHash('sha256').update(JSON.stringify([path.resolve(info.path), st.size, st.mtimeMs])).digest('hex').slice(0, 24);
  const file = path.join(dir, `${key}.mp4`);
  if (existsSync(file)) return Promise.resolve(file);
  let job = pending.get(file);
  if (!job) {
    job = build(info, file).finally(() => pending.delete(file));
    pending.set(file, job);
  }
  return job;
}

async function build(info: VideoInfo, file: string): Promise<string> {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part.mp4`;
  const gop = Math.max(1, Math.round(info.fps / 2));
  // Deinterlace for viewing only (one frame per frame, so timing stays the same).
  const deint = info.interlace === 'tff' || info.interlace === 'bff' ? 'bwdif=mode=send_frame,' : '';
  await runOk(requireTool('ffmpeg'), [
    '-hide_banner', '-y', '-nostats', '-i', info.path,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', `${deint}scale=-2:min(ih\\,360),format=yuv420p`,
    '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', String(gop),
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', tmp,
  ]);
  renameSync(tmp, file);
  return file;
}
