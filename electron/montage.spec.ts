import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MontageClip, setTransition } from '../shared/montage';
import type { VideoInfo } from '../shared/types';
import { analyze } from './analyze';
import { fitSize, montageArgs, montageOutput, needsConversion, renderMontage, thumbnailsFor } from './montage';
import { tools } from './tools';

const hasFfmpeg = !!tools(true).ffmpeg && !!tools().ffprobe;
const ffmpeg = (args: string[]) => spawnSync(tools().ffmpeg!, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });

/** md5 of every decoded frame, after an optional filter (e.g. normalising to frame slots). */
function frameHashes(file: string, filter = 'null'): string[] {
  const res = ffmpeg(['-i', file, '-map', '0:v', '-vf', filter, '-f', 'framemd5', '-']);
  return res.stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

function probe(file: string) {
  const res = spawnSync(tools().ffprobe!, [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file,
  ], { encoding: 'utf8' });
  const j = JSON.parse(res.stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration: string } };
  return { video: j.streams.find((s) => s.codec_type === 'video')!, audio: j.streams.find((s) => s.codec_type === 'audio'), duration: Number(j.format.duration) };
}

describe.skipIf(!hasFfmpeg)('renderMontage', () => {
  let dir: string;
  let a: VideoInfo;
  let b: VideoInfo;
  let sourceA: string[];
  const signal = () => new AbortController().signal;
  const clipA = (start: number, end: number, id: string): MontageClip => ({ id, source: a.path, fps: a.fps, start, end });

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'enh-montage-'));
    // A: 4:3, 25 fps, with sound and a dropped frame (gap in the timestamps), GOP 12.
    const fileA = path.join(dir, 'a.avi');
    let res = ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3',
      '-vf', "select='not(eq(n\\,20))'", '-fps_mode', 'passthrough',
      '-c:v', 'mpeg4', '-q:v', '3', '-g', '12', '-c:a', 'libmp3lame', fileA,
    ]);
    expect(res.status, res.stderr).toBe(0);
    // B: 16:9, 30 fps, H.264, no sound.
    const fileB = path.join(dir, 'b.mp4');
    res = ffmpeg(['-f', 'lavfi', '-i', 'smptebars=s=192x108:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fileB]);
    expect(res.status, res.stderr).toBe(0);
    a = await analyze(fileA);
    b = await analyze(fileB);
    sourceA = frameHashes(fileA, `fps=fps=${a.fpsRational}`);
    expect(sourceA).toHaveLength(a.frames);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('cuts, reorders and joins one source frame-exactly and losslessly', async () => {
    const clips = [clipA(40, 55, 'p'), clipA(5, 12, 'q'), clipA(19, 23, 'r'), clipA(70, a.frames, 's')];
    const out = montageOutput(a.path, dir);
    expect(path.basename(out)).toBe('a_montage.mkv');
    const updates: number[] = [];
    await renderMontage(a, new Map([[a.path, a]]), clips, out, { format: 'lossless' }, signal(), (p) => updates.push(p.percent));

    const expected = clips.flatMap((c) => sourceA.slice(c.start, c.end));
    expect(frameHashes(out)).toEqual(expected);
    expect(Math.abs(probe(out).duration - expected.length / a.fps)).toBeLessThan(0.1);
    expect(updates.at(-1)).toBe(100);
    expect(montageOutput(a.path, dir)).toMatch(/a_montage \(2\)\.mkv$/);
  });

  it('mixes sources: converts frame rate and size, pads, adds silence, crossfades', async () => {
    // idet may call the synthetic clip interlaced; a mixed montage would then deinterlace it
    // (checked below). Treat A as progressive here so its frames can be compared bit for bit.
    a = { ...a, interlace: 'progressive' };
    expect(needsConversion(b, a)).toBe(true);
    expect(fitSize(b, a)).toEqual({ w: 160, h: 90 }); // 16:9 inside 4:3: letterboxed
    // A[5,20) | B whole (90 frames at 30 fps = 75 at 25) | fade 5 | A[40,50)
    const clips = setTransition([
      clipA(5, 20, 'x'), { id: 'y', source: b.path, fps: b.fps, start: 0, end: 90 }, clipA(40, 50, 'z'),
    ], 'z', { kind: 'fade', frames: 5 });
    const out = path.join(dir, 'mixed.mkv');
    await renderMontage(a, new Map([[a.path, a], [b.path, b]]), clips, out, { format: 'lossless' }, signal(), () => undefined);

    const frames = frameHashes(out);
    expect(frames).toHaveLength(15 + 75 + 10 - 5);
    // Untouched parts of A stay bit-exact: before B, and after the crossfade into the last clip.
    expect(frames.slice(0, 15)).toEqual(sourceA.slice(5, 20));
    expect(frames.slice(90)).toEqual(sourceA.slice(45, 50));
    const p = probe(out);
    expect([p.video.width, p.video.height]).toEqual([160, 120]);
    expect(p.audio?.codec_name).toBe('flac'); // B had no sound: silence keeps audio and video aligned
    expect(Math.abs(p.duration - 95 / 25)).toBeLessThan(0.1);
  });

  it('deinterlaces interlaced sources only when something is converted or for MP4', () => {
    const tff: VideoInfo = { ...a, interlace: 'tff' };
    const graph = (sources: VideoInfo[], format: 'lossless' | 'mp4') => {
      const clips = sources.map((s, i): MontageClip => ({ id: `c${i}`, source: s.path, fps: s.fps, start: 0, end: 10 }));
      const args = montageArgs(tff, new Map(sources.map((s) => [s.path, s])), clips, 'x.mkv', { format });
      return { filter: args[args.indexOf('-filter_complex') + 1], args };
    };
    const same = graph([tff], 'lossless');
    expect(same.filter).not.toContain('bwdif');
    expect(same.args).toContain('-field_order'); // stays interlaced, flagged
    expect(graph([tff], 'mp4').filter).toContain('bwdif=mode=send_frame:parity=tff');
    const mixed = graph([tff, b], 'lossless');
    expect(mixed.filter).toContain('bwdif');
    expect(mixed.args).not.toContain('-field_order');
  });

  it('exports MP4 (H.264 + AAC)', async () => {
    const clips = setTransition([clipA(0, 30, 'x'), clipA(40, 70, 'y')], 'y', { kind: 'fadeblack', frames: 10 });
    const out = montageOutput(a.path, dir, 'mp4');
    expect(path.basename(out)).toBe('a_montage.mp4');
    await renderMontage(a, new Map([[a.path, a]]), clips, out, { format: 'mp4', crf: 23 }, signal(), () => undefined);
    const p = probe(out);
    expect(p.video.codec_name).toBe('h264');
    expect(p.audio?.codec_name).toBe('aac');
    expect(frameHashes(out)).toHaveLength(50);
  });

  it('refuses an empty or out-of-range montage', async () => {
    const run = (clips: MontageClip[]) =>
      renderMontage(a, new Map([[a.path, a]]), clips, path.join(dir, 'bad.mkv'), { format: 'lossless' }, signal(), () => undefined);
    await expect(run([])).rejects.toThrow(/пуст/);
    await expect(run([clipA(0, a.frames + 5, 'x')])).rejects.toThrow();
    await expect(run([{ id: 'u', source: '/nope.avi', fps: 25, start: 0, end: 5 }])).rejects.toThrow();
  });

  it('makes timeline thumbnails once per file version', async () => {
    const t = await thumbnailsFor(a, path.join(dir, 'thumbs'));
    expect(t.interval).toBe(0.5);
    expect(t.files.length).toBeGreaterThanOrEqual(6);
    expect((await thumbnailsFor(a, path.join(dir, 'thumbs'))).files).toEqual(t.files);
  });
});
