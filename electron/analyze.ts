import path from 'node:path';
import type { CropRect, InterlaceKind, VideoInfo } from '../shared/types';
import { run, runOk } from './proc';
import { requireTool } from './tools';

interface ProbeStream {
  codec_type: string;
  codec_name?: string;
  codec_long_name?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  bit_rate?: string;
  duration?: string;
}

interface ProbeOut {
  streams: ProbeStream[];
  format: { format_name?: string; duration?: string; bit_rate?: string };
}

function ratio(text: string | undefined, fallback: number): number {
  if (!text) return fallback;
  const [a, b] = text.split(/[/:]/).map(Number);
  if (!a || !b || !isFinite(a / b)) return fallback;
  return a / b;
}

function kbps(text?: string): number | undefined {
  const n = Number(text);
  return n > 0 ? Math.round(n / 1000) : undefined;
}

export async function analyze(file: string): Promise<VideoInfo> {
  const ffprobe = requireTool('ffprobe');
  const res = await runOk(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]);
  const probe = JSON.parse(res.stdout) as ProbeOut;
  const v = probe.streams.find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error('В файле не найдена видеодорожка.');
  const a = probe.streams.find((s) => s.codec_type === 'audio');

  const fpsRaw = ratio(v.avg_frame_rate, 0) || ratio(v.r_frame_rate, 25);
  const fps = Math.round(fpsRaw * 1000) / 1000;
  const duration = Number(v.duration) || Number(probe.format.duration) || 0;
  const [sarNum, sarDen] = parseSar(v.sample_aspect_ratio);
  const dar = (v.width * sarNum) / sarDen / v.height;

  const [interlace, crop] = await Promise.all([
    detectInterlace(file, duration),
    detectCrop(file, duration, v.width, v.height),
  ]);

  return {
    path: file,
    name: path.basename(file),
    container: probe.format.format_name?.split(',')[0] ?? '',
    width: v.width,
    height: v.height,
    sarNum,
    sarDen,
    dar,
    fps,
    fpsText: Number.isInteger(fps) ? `${fps}` : fps.toFixed(3),
    duration,
    frames: Number(v.nb_frames) || Math.round(duration * fps),
    videoCodec: v.codec_name ?? '?',
    videoBitrateKbps: kbps(v.bit_rate),
    audioCodec: a?.codec_name,
    audioBitrateKbps: kbps(a?.bit_rate),
    interlace: interlace.kind,
    interlaceRatio: interlace.ratio,
    suggestedCrop: crop,
  };
}

function parseSar(text?: string): [number, number] {
  if (!text || text === '0:1' || text === 'N/A') return [1, 1];
  const [a, b] = text.split(':').map(Number);
  return a > 0 && b > 0 ? [a, b] : [1, 1];
}

/** Sample from ~10% into the clip so intros/black frames do not dominate. */
function sampleStart(duration: number): string {
  return duration > 4 ? (duration * 0.1).toFixed(2) : '0';
}

async function detectInterlace(file: string, duration: number): Promise<{ kind: InterlaceKind; ratio: number }> {
  const ffmpeg = requireTool('ffmpeg');
  const res = await run(ffmpeg, [
    '-hide_banner', '-nostats', '-ss', sampleStart(duration), '-i', file,
    '-frames:v', '400', '-an', '-vf', 'idet', '-f', 'null', '-',
  ]);
  // ffmpeg may print the summary more than once (an empty one from a probe instance of
  // the filter graph, then the real one), so take the last line that counted any frames.
  const counts = [...res.stderr.matchAll(/Multi frame detection:\s*TFF:\s*(\d+)\s*BFF:\s*(\d+)\s*Progressive:\s*(\d+)/g)]
    .map((m) => m.slice(1).map(Number))
    .filter(([t, b, p]) => t + b + p > 0);
  const last = counts[counts.length - 1];
  if (!last) return { kind: 'unknown', ratio: 0 };
  const [tff, bff, prog] = last;
  const total = tff + bff + prog;
  const interlaced = (tff + bff) / total;
  if (interlaced < 0.25) return { kind: 'progressive', ratio: interlaced };
  return { kind: tff >= bff ? 'tff' : 'bff', ratio: interlaced };
}

async function detectCrop(file: string, duration: number, width: number, height: number): Promise<CropRect | null> {
  const ffmpeg = requireTool('ffmpeg');
  const res = await run(ffmpeg, [
    '-hide_banner', '-nostats', '-ss', sampleStart(duration), '-i', file,
    '-frames:v', '300', '-an', '-vf', 'cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-',
  ]);
  const all = [...res.stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = all[all.length - 1];
  if (!last) return null;
  const [w, h, x, y] = last.slice(1).map(Number);
  // Ignore tiny or absurd suggestions.
  if (w < width * 0.5 || h < height * 0.5) return null;
  if (width - w < 4 && height - h < 4) return null;
  return { w, h, x, y };
}
