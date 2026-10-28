import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Segment } from '../shared/segments';
import { DEFAULT_OPTIONS, type ProcessOptions, type VideoInfo } from '../shared/types';
import { analyze } from './analyze';
import { ChunkCache } from './cache';
import { processClip } from './pipeline';
import { tools } from './tools';

// End-to-end through real ffmpeg (no GPU needed: the fast engine). Skipped without ffmpeg.
const hasFfmpeg = !!tools(true).ffmpeg && !!tools().ffprobe;

const ffmpeg = (args: string[]) => spawnSync(tools().ffmpeg!, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });

function frameHashes(file: string): string[] {
  const res = ffmpeg(['-i', file, '-map', '0:v', '-f', 'framemd5', '-']);
  return res.stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
}

function streamDuration(file: string, type: 'v' | 'a'): number {
  const res = spawnSync(tools().ffprobe!, [
    '-v', 'error', '-select_streams', type, '-show_entries', 'stream=duration', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' });
  return Number(res.stdout.trim());
}

describe.skipIf(!hasFfmpeg)('processClip with fragments (ffmpeg engine)', () => {
  let dir: string;
  let info: VideoInfo;
  const options: ProcessOptions = {
    ...DEFAULT_OPTIONS, engine: 'ffmpeg', deinterlace: 'off', denoise: 0, sharpen: 0, crf: 0, crop: null,
  };

  const run = (name: string, segments: Segment[] | null, o = options, cache: ChunkCache | null = null) =>
    processClip({
      info, options: o, output: path.join(dir, name), signal: new AbortController().signal,
      report: () => undefined, segments, cache,
    }).then(() => path.join(dir, name));

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'enh-pipeline-'));
    const clip = path.join(dir, 'clip.avi');
    // 3 s with a dropped frame (a gap in the timestamps), like many VHS captures.
    const res = ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3',
      '-vf', "select='not(eq(n\\,20))'", '-fps_mode', 'passthrough',
      '-c:v', 'mpeg4', '-q:v', '3', '-g', '12', '-c:a', 'libmp3lame', clip,
    ]);
    expect(res.status, res.stderr).toBe(0);
    info = await analyze(clip);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('joins fragments frame-exactly: same frames as a single pass, gaps filled, audio in sync', async () => {
    const n = info.frames;
    const whole = await run('whole.mp4', [{ start: 0, end: n }]);
    // Cuts on and off keyframes (GOP 12), around the dropped frame, and a 1-frame fragment.
    const cuts = [0, 7, 12, 20, 21, 36, 37, n];
    const chunked = await run('chunked.mp4', cuts.slice(0, -1).map((start, i) => ({ start, end: cuts[i + 1] })));

    const a = frameHashes(whole);
    expect(a).toHaveLength(n);
    expect(frameHashes(chunked)).toEqual(a);
    const v = streamDuration(chunked, 'v');
    expect(Math.abs(v - n / info.fps)).toBeLessThan(0.5 / info.fps);
    expect(Math.abs(streamDuration(chunked, 'a') - v)).toBeLessThan(0.05);
  });

  it('reuses cached fragments and only re-renders the changed one', async () => {
    const cache = new ChunkCache(path.join(dir, 'cache'));
    const segments: Segment[] = [{ start: 0, end: 30 }, { start: 30, end: info.frames }];
    const states: string[][] = [];
    const go = (o: ProcessOptions, segs: typeof segments) => processClip({
      info, options: o, output: path.join(dir, `c${states.length}.mp4`), signal: new AbortController().signal,
      segments: segs, cache, report: (p) => p.stage === 'done' && states.push(p.segments ?? []),
    });

    await go(options, segments);
    await go(options, segments);
    await go(options, [segments[0], { ...segments[1], overrides: { faceRestore: false } }]); // no-op override
    await go({ ...options, crf: 1 }, segments);
    expect(states).toEqual([
      ['done', 'done'], ['cached', 'cached'], ['cached', 'cached'], ['done', 'done'],
    ]);
  });

  it('rejects fragments with gaps', async () => {
    await expect(run('bad.mp4', [{ start: 0, end: 10 }, { start: 11, end: 20 }])).rejects.toThrow(/подряд/);
  });
});
