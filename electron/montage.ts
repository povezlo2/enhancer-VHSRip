import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AudioOverlay, layout, type MontageClip, montageFrames, type OriginalAudio, originalVolume, validMontage, validOverlays,
} from '../shared/montage';
import type { AudioExportFormat, MontageFormat, MontageProgress, Thumbnails, VideoInfo } from '../shared/types';
import { frameCounter } from './fragment';
import { runOk } from './proc';
import { reversedInfo, reverseRange } from './reverse';
import { requireTool } from './tools';

/** Seconds decoded before a clip's first frame, so the keyframe seek always lands early. */
const SEEK_MARGIN = 1;
/** One ffmpeg call opens a source once per clip; more than this is refused. */
export const MAX_CLIPS = 300;

/** Calls `onSeconds` with the latest `out_time_us=` from ffmpeg's -progress output. */
export function timeCounter(onSeconds: (s: number) => void) {
  let buf = '';
  return (chunk: string) => {
    buf = (buf + chunk).slice(-2000);
    const all = [...buf.matchAll(/out_time_us=(\d+)/g)];
    const last = all[all.length - 1];
    if (last) onSeconds(Number(last[1]) / 1e6);
  };
}

/** Extracted sound next to the owner video (or in `outDir`): name_audio.wav / .mp3, then (2), (3)... */
export function audioOutput(src: string, outDir: string | null, format: AudioExportFormat): string {
  const dir = outDir ?? path.dirname(src);
  const base = path.parse(src).name;
  let candidate = path.join(dir, `${base}_audio.${format}`);
  for (let i = 2; existsSync(candidate); i++) candidate = path.join(dir, `${base}_audio (${i}).${format}`);
  return candidate;
}

/** Output file next to the owner video (or in `outDir`): name_montage.mkv / .mp4, then (2), (3)... */
export function montageOutput(src: string, outDir: string | null, format: MontageFormat = 'lossless'): string {
  const dir = outDir ?? path.dirname(src);
  const base = path.parse(src).name;
  const ext = format === 'mp4' ? 'mp4' : 'mkv';
  let candidate = path.join(dir, `${base}_montage.${ext}`);
  for (let i = 2; existsSync(candidate); i++) candidate = path.join(dir, `${base}_montage (${i}).${ext}`);
  return candidate;
}

const interlaced = (i: VideoInfo) => i.interlace === 'tff' || i.interlace === 'bff';
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

function rational(rate: string): [number, number] {
  const [n, d] = rate.split('/').map(Number);
  return n > 0 && d > 0 ? [n, d] : [Math.round(Number(rate)) || 25, 1];
}

/** Does this source need converting (size, pixel aspect, frame rate, pixel format) to match the project? */
export function needsConversion(src: VideoInfo, target: VideoInfo): boolean {
  const [a, b] = rational(src.fpsRational);
  const [c, d] = rational(target.fpsRational);
  return src.width !== target.width || src.height !== target.height
    || src.sarNum * target.sarDen !== target.sarNum * src.sarDen
    || a * d !== b * c || src.pixFmt !== target.pixFmt;
}

/** Size a source is scaled to so it fits the project frame without distortion (the rest is padded). */
export function fitSize(src: VideoInfo, target: VideoInfo): { w: number; h: number } {
  const srcDar = (src.width * src.sarNum) / src.sarDen / src.height;
  const pixel = target.sarNum / target.sarDen;
  const wAtFullHeight = (srcDar * target.height) / pixel;
  if (wAtFullHeight <= target.width + 1) return { w: Math.min(target.width, even(wAtFullHeight)), h: target.height };
  return { w: target.width, h: Math.min(target.height, even((target.width * pixel) / srcDar)) };
}

/**
 * ffmpeg arguments for the whole montage. Every clip is cut by the same frame-exact rules
 * as fragments (frame N of a source is the slot startTime + N / fps: seek early, -copyts,
 * `fps` filter), converted to the project format only when its source differs (size with
 * padding, frame rate, pixel format), then the clips are joined: `concat` for a hard cut,
 * `xfade` + `acrossfade` for a transition.
 *
 * Lossless output (FFV1 + FLAC, MKV) keeps interlacing when every clip already matches the
 * project; once anything is converted (or for MP4) interlaced sources are deinterlaced first,
 * because scaling or blending fields from different sources would tear them.
 */
export function montageArgs(
  target: VideoInfo, sources: Map<string, VideoInfo>, clips: MontageClip[], output: string, opts: MontageOptions,
): string[] {
  const fps = target.fps;
  const [rn, rd] = rational(target.fpsRational);
  const lay = layout(clips, fps);
  const infos = clips.map((c) => {
    const info = sources.get(c.source);
    if (!info) throw new Error(`Нет данных об исходнике ${c.source}`);
    return info;
  });
  const converts = infos.map((i) => needsConversion(i, target));
  const progressive = opts.format === 'mp4' || !!opts.progressive || converts.some(Boolean);
  const pixFmt = opts.format === 'mp4' ? 'yuv420p' : target.pixFmt;
  const audioOnly = opts.audioOnly;
  const overlays = opts.overlays ?? [];
  const clipAudio = infos.some((i) => !!i.audioCodec);
  const hasAudio = clipAudio || overlays.length > 0;
  if (audioOnly && !hasAudio) throw new Error('В монтаже нет звука: ни у одного клипа нет звуковой дорожки.');
  const rate = target.audioSampleRate ?? infos.find((i) => i.audioSampleRate)?.audioSampleRate ?? 48000;
  const channels = target.audioCodec ? (target.audioChannels ?? 2) : 2;
  const chLayout = channels === 1 ? 'mono' : 'stereo';

  const inputs: string[] = [];
  const graph: string[] = [];
  for (const [i, c] of clips.entries()) {
    const src = infos[i];
    const at = c.start / src.fps;
    const n = c.end - c.start;
    const len = lay.lengths[i];
    const ss = Math.max(0, at - SEEK_MARGIN);
    if (ss > 0) inputs.push('-ss', ss.toFixed(6));
    inputs.push('-t', (at - ss + n / src.fps + 0.5).toFixed(6), ...(audioOnly ? ['-vn'] : []), '-i', src.path);
    const t0 = src.startTime + at;

    const v = [`fps=fps=${src.fpsRational}:start_time=${t0.toFixed(6)}`, `trim=end_frame=${n}`];
    const tin = lay.trans[i];
    const tout = lay.trans[i + 1] ?? 0;
    if (progressive && interlaced(src)) v.push(`bwdif=mode=send_frame:parity=${src.interlace}`);
    if (converts[i]) {
      const [sn, sd] = rational(src.fpsRational);
      // Rate conversion can be a frame short or long: pad by cloning, then cut to the exact length.
      if (sn * rd !== sd * rn) v.push(`fps=fps=${target.fpsRational}`, 'tpad=stop_mode=clone:stop=2', `trim=end_frame=${len}`);
      const fit = fitSize(src, target);
      if (fit.w !== src.width || fit.h !== src.height || fit.w !== target.width || fit.h !== target.height
          || src.sarNum * target.sarDen !== target.sarNum * src.sarDen) {
        v.push(`scale=${fit.w}:${fit.h}:flags=lanczos`, `setsar=${target.sarNum}/${target.sarDen}`,
          `pad=${target.width}:${target.height}:${(target.width - fit.w) >> 1}:${(target.height - fit.h) >> 1}:black`);
      }
    }
    v.push(`format=${pixFmt}`, `settb=${rd}/${rn}`, 'setpts=N');

    // Split off the frames that overlap the neighbours: only those go through xfade (which
    // in FFmpeg 6.1 converts to 4:4:4 and back), so every other frame stays untouched.
    const parts: { label: string; from: number; to: number }[] = [];
    if (tin) parts.push({ label: `h${i}`, from: 0, to: tin });
    parts.push({ label: `b${i}`, from: tin, to: len - tout });
    if (tout) parts.push({ label: `t${i}`, from: len - tout, to: len });
    if (audioOnly) {
      // Sound only: no picture is decoded.
    } else if (parts.length === 1) {
      graph.push(`[${i}:v:0]${v.join(',')}[b${i}]`);
    } else {
      graph.push(`[${i}:v:0]${v.join(',')},split=${parts.length}${parts.map((p) => `[s${p.label}]`).join('')}`);
      for (const p of parts) graph.push(`[s${p.label}]trim=start_frame=${p.from}:end_frame=${p.to},setpts=N[${p.label}]`);
    }

    if (clipAudio) {
      const dur = (len / fps).toFixed(6);
      if (src.audioCodec) {
        const t1 = t0 + n / src.fps;
        graph.push(`[${i}:a:0]atrim=start=${t0.toFixed(6)}:end=${t1.toFixed(6)},asetpts=PTS-STARTPTS,`
          + `aresample=${rate},aformat=sample_rates=${rate}:channel_layouts=${chLayout},apad=whole_dur=${dur},atrim=end=${dur}[a${i}]`);
      } else {
        graph.push(`anullsrc=r=${rate}:cl=${chLayout}:d=${dur}[a${i}]`);
      }
    }
  }

  // Video: body 0, transition 0->1, body 1, ... joined by one concat.
  const pieces: string[] = ['b0'];
  for (let i = 1; i < clips.length && !audioOnly; i++) {
    if (lay.trans[i] > 0) {
      const kind = clips[i].transitionIn?.kind ?? 'fade';
      const dur = (lay.trans[i] / fps).toFixed(6);
      graph.push(`[t${i - 1}][h${i}]xfade=transition=${kind}:duration=${dur}:offset=0,format=${pixFmt},settb=${rd}/${rn},setpts=N[x${i}]`);
      pieces.push(`x${i}`);
    }
    pieces.push(`b${i}`);
  }
  let v = 'vout';
  if (pieces.length === 1 || audioOnly) v = pieces[0];
  else graph.push(`${pieces.map((p) => `[${p}]`).join('')}concat=n=${pieces.length}:v=1:a=0,settb=${rd}/${rn},setpts=N[vout]`);

  // Audio: left to right, a 2-way concat for a cut, acrossfade for a transition.
  let a = 'a0';
  if (clipAudio) {
    for (let i = 1; i < clips.length; i++) {
      const t = lay.trans[i];
      graph.push(t > 0
        ? `[${a}][a${i}]acrossfade=d=${(t / fps).toFixed(6)}:c1=tri:c2=tri[aj${i}]`
        : `[${a}][a${i}]concat=n=2:v=0:a=1[aj${i}]`);
      a = `aj${i}`;
    }
  }

  // Overlays (e.g. a translated voice track) over the montage's own sound, which can be kept,
  // turned down or muted. amix with duration=first keeps the result exactly as long as the video.
  const origVolume = originalVolume(opts.originalAudio);
  if (overlays.length) {
    const seconds = (lay.total / fps).toFixed(6);
    if (clipAudio) graph.push(`[${a}]volume=${origVolume}[base]`);
    else graph.push(`anullsrc=r=${rate}:cl=${chLayout}:d=${seconds}[base]`);
    const mix = ['[base]'];
    for (const [k, o] of overlays.entries()) {
      inputs.push('-vn', '-i', o.path);
      const delay = Math.round((o.start / fps) * 1000);
      graph.push(`[${clips.length + k}:a:0]aresample=${rate},aformat=sample_rates=${rate}:channel_layouts=${chLayout},`
        + `adelay=delays=${delay}:all=1,volume=${o.volume}[o${k}]`);
      mix.push(`[o${k}]`);
    }
    graph.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0:normalize=0[amix]`);
    a = 'amix';
  } else if (clipAudio && origVolume !== 1) {
    graph.push(`[${a}]volume=${origVolume}[aquiet]`);
    a = 'aquiet';
  }

  if (audioOnly) {
    return [
      '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-copyts',
      ...inputs,
      '-filter_complex', graph.join(';'),
      '-map', `[${a}]`,
      ...(audioOnly === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '192k'] : ['-c:a', 'pcm_s16le']),
      output,
    ];
  }

  const fieldOrder = !progressive && target.interlace === 'tff' ? ['-field_order', 'tt']
    : !progressive && target.interlace === 'bff' ? ['-field_order', 'bb'] : [];
  const encode = opts.format === 'mp4'
    ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(opts.crf ?? 18), '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-movflags', '+faststart']
    : ['-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '4', '-slicecrc', '1', ...fieldOrder,
      ...(hasAudio ? ['-c:a', 'flac'] : [])];
  return [
    '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-copyts',
    ...inputs,
    '-filter_complex', graph.join(';'),
    '-map', `[${v}]`, ...(hasAudio ? ['-map', `[${a}]`] : []),
    ...encode, '-r', target.fpsRational, '-frames:v', String(lay.total),
    output,
  ];
}

export interface MontageOptions {
  format: MontageFormat;
  /** H.264 CRF for MP4. */
  crf?: number;
  /** Deinterlace everything (set when a reversed clip comes from an interlaced source). */
  progressive?: boolean;
  overlays?: AudioOverlay[];
  originalAudio?: OriginalAudio;
  /** Write only the sound, to WAV or MP3 (for translation, dubbing...). */
  audioOnly?: AudioExportFormat;
}

/**
 * Render the montage. Reversed clips are first written backwards to lossless temp files (in
 * chunks, see reverse.ts) and then joined like any other clip. Written to a temp name first,
 * so a cancelled render leaves nothing.
 */
export async function renderMontage(
  target: VideoInfo, sources: Map<string, VideoInfo>, clips: MontageClip[], output: string, opts: MontageOptions,
  signal: AbortSignal, onProgress: (p: Omit<MontageProgress, 'output'>) => void,
): Promise<void> {
  const lengths = Object.fromEntries([...sources].map(([p, i]) => [p, Math.max(1, i.frames)]));
  if (!validMontage(clips, lengths)) throw new Error('Монтаж пуст или выходит за пределы видео.');
  if (clips.length > MAX_CLIPS) throw new Error(`Слишком много клипов (${clips.length}), максимум ${MAX_CLIPS}.`);
  const total = montageFrames(clips, target.fps);
  if (!validOverlays(opts.overlays ?? [], total)) throw new Error('Наложенный звук задан неверно.');
  for (const o of opts.overlays ?? []) {
    if (!existsSync(o.path)) throw new Error(`Нет файла звука: ${o.path}`);
  }
  const backwards = clips.filter((c) => c.reversed).reduce((n, c) => n + c.end - c.start, 0);
  const work = backwards ? mkdtempSync(path.join(os.tmpdir(), 'enhancer-reverse-')) : null;
  const ext = path.extname(output);
  const tmp = `${output}.part${ext}`;
  const started = Date.now();
  // Progress over all frames written: reversed clips first, then the montage itself.
  const report = (done: number) => {
    const all = backwards + total;
    const secs = (Date.now() - started) / 1000;
    onProgress({
      percent: Math.min(99, (done / all) * 100), framesDone: done, framesTotal: all,
      etaSec: done > 5 ? Math.round((secs / done) * (all - done)) : undefined,
    });
  };
  mkdirSync(path.dirname(output), { recursive: true });
  try {
    const plan = new Map(sources);
    const final: MontageClip[] = [];
    let reversedDone = 0;
    let progressive = !!opts.progressive;
    for (const [i, c] of clips.entries()) {
      if (!c.reversed) {
        final.push(c);
        continue;
      }
      const src = sources.get(c.source)!;
      const file = path.join(work!, `reversed-${i}.mkv`);
      const base = reversedDone;
      await reverseRange(src, c.start, c.end, file, 'lossless', signal, (n) => report(base + n));
      reversedDone += c.end - c.start;
      plan.set(file, reversedInfo(src, file, c.end - c.start));
      if (src.interlace === 'tff' || src.interlace === 'bff') progressive = true;
      const { reversed: _done, ...rest } = c;
      final.push({ ...rest, source: file, start: 0, end: c.end - c.start });
    }
    await runOk(requireTool('ffmpeg'), montageArgs(target, plan, final, tmp, { ...opts, progressive }), {
      signal,
      // Sound only: ffmpeg reports time written instead of frames.
      onStdout: opts.audioOnly
        ? timeCounter((sec) => report(backwards + Math.min(Math.round(sec * target.fps), total)))
        : frameCounter((n) => report(backwards + Math.min(n, total))),
    });
    renameSync(tmp, output);
  } finally {
    rmSync(tmp, { force: true });
    if (work) rmSync(work, { recursive: true, force: true });
  }
  onProgress({ percent: 100, framesDone: backwards + total, framesTotal: backwards + total });
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
