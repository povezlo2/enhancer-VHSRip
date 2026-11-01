import path from 'node:path';
import type { AudioInfo } from '../shared/types';
import { runOk } from './proc';
import { requireTool } from './tools';

export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'mka'];

/** Length and codec of the first audio stream; refuses files without sound. */
export async function probeAudio(file: string): Promise<AudioInfo> {
  const res = await runOk(requireTool('ffprobe'), [
    '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,duration:format=duration',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(res.stdout) as { streams?: { codec_name?: string; duration?: string }[]; format?: { duration?: string } };
  const a = j.streams?.[0];
  if (!a) throw new Error(`В файле ${path.basename(file)} нет звука.`);
  const duration = Number(a.duration) || Number(j.format?.duration) || 0;
  if (!(duration > 0)) throw new Error(`Не удалось определить длительность звука в ${path.basename(file)}.`);
  return { path: file, name: path.basename(file), duration, codec: a.codec_name ?? '?' };
}
