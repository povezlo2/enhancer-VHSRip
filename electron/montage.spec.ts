import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MontageClip } from '../shared/montage';
import type { VideoInfo } from '../shared/types';
import { analyze } from './analyze';
import { montageOutput, renderMontage, thumbnailsFor } from './montage';
import { tools } from './tools';

const hasFfmpeg = !!tools(true).ffmpeg && !!tools().ffprobe;
const ffmpeg = (args: string[]) => spawnSync(tools().ffmpeg!, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });

/** md5 of every decoded frame, after normalising to constant frame slots like the app does. */
function frameHashes(file: string, filter = 'null'): string[] {
  const res = ffmpeg(['-i', file, '-map', '0:v', '-vf', filter, '-f', 'framemd5', '-']);
  return res.stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

const duration = (file: string, type: 'v' | 'a') => Number(spawnSync(tools().ffprobe!, [
  '-v', 'error', '-select_streams', type, '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
], { encoding: 'utf8' }).stdout.trim());

describe.skipIf(!hasFfmpeg)('renderMontage', () => {
  let dir: string;
  let info: VideoInfo;
  let source: string[];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'enh-montage-'));
    const clip = path.join(dir, 'clip.avi');
    // 3 s with a dropped frame (gap in the timestamps), GOP 12.
    const res = ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3',
      '-vf', "select='not(eq(n\\,20))'", '-fps_mode', 'passthrough',
      '-c:v', 'mpeg4', '-q:v', '3', '-g', '12', '-c:a', 'libmp3lame', clip,
    ]);
    expect(res.status, res.stderr).toBe(0);
    info = await analyze(clip);
    source = frameHashes(clip, `fps=fps=${info.fpsRational}`);
    expect(source).toHaveLength(info.frames);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('cuts, reorders and joins frame-exactly, losslessly, with audio of the same length', async () => {
    const clips: MontageClip[] = [
      { id: 'a', start: 40, end: 55 }, // moved before an earlier part
      { id: 'b', start: 5, end: 12 }, // ends on a keyframe boundary
      { id: 'c', start: 19, end: 23 }, // spans the dropped frame
      { id: 'd', start: 70, end: info.frames }, // to the end
    ];
    const out = montageOutput(path.join(dir, 'clip.avi'), dir);
    expect(path.basename(out)).toBe('clip_montage.mkv');
    const updates: number[] = [];
    await renderMontage(info, clips, out, new AbortController().signal, (p) => updates.push(p.percent));

    const expected = clips.flatMap((c) => source.slice(c.start, c.end));
    expect(frameHashes(out)).toEqual(expected);
    const v = expected.length / info.fps;
    expect(Math.abs(duration(out, 'v') - v)).toBeLessThan(0.1);
    expect(updates.at(-1)).toBe(100);
    expect(montageOutput(path.join(dir, 'clip.avi'), dir)).toMatch(/clip_montage \(2\)\.mkv$/);
  });

  it('refuses an empty or out-of-range montage', async () => {
    const run = (clips: MontageClip[]) => renderMontage(info, clips, path.join(dir, 'bad.mkv'), new AbortController().signal, () => undefined);
    await expect(run([])).rejects.toThrow(/пуст/);
    await expect(run([{ id: 'x', start: 0, end: info.frames + 5 }])).rejects.toThrow();
  });

  it('makes timeline thumbnails once per file version', async () => {
    const t = await thumbnailsFor(info, path.join(dir, 'thumbs'));
    expect(t.interval).toBe(0.5);
    expect(t.files.length).toBeGreaterThanOrEqual(6);
    const again = await thumbnailsFor(info, path.join(dir, 'thumbs'));
    expect(again.files).toEqual(t.files);
  });
});
