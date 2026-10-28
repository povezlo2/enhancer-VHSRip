import type { VideoInfo } from '../shared/types';
import { runOk } from './proc';
import { requireTool } from './tools';

/**
 * Frames where a new scene starts, using ffmpeg's scene score on a small grey copy of the
 * picture (fast, and less sensitive to VHS colour noise).
 */
export async function detectScenes(info: VideoInfo, threshold: number, signal?: AbortSignal): Promise<number[]> {
  const ffmpeg = requireTool('ffmpeg');
  const t = Math.min(0.9, Math.max(0.05, threshold));
  const res = await runOk(ffmpeg, [
    '-hide_banner', '-nostats', '-i', info.path, '-an',
    '-vf', `setpts=PTS-STARTPTS,scale=320:-2,format=gray,select='gt(scene\\,${t})',showinfo`,
    '-f', 'null', '-',
  ], { signal, keep: 2_000_000 });
  return parseSceneTimes(res.stderr).map((sec) => Math.round(sec * info.fps)).filter((f) => f > 0);
}

/** `pts_time` of every frame that showinfo printed. */
export function parseSceneTimes(stderr: string): number[] {
  return [...stderr.matchAll(/Parsed_showinfo[^\n]*\bpts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
}
