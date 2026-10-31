import { describe, expect, it } from 'vitest';
import type { VideoInfo } from '../shared/types';
import { decodeWindow, exactSeek, FILTER_WARMUP, trackTimescale } from './fragment';
import { parseSceneTimes } from './scenes';

describe('decodeWindow', () => {
  it('adds filter warm-up before the fragment, clamped at the start of the file', () => {
    expect(decodeWindow({ start: 100, end: 200 }, 0, FILTER_WARMUP)).toMatchObject({ first: 92, skip: 8, keep: 100, ctxBefore: 0 });
    expect(decodeWindow({ start: 3, end: 50 }, 0, FILTER_WARMUP)).toMatchObject({ first: 0, skip: 3, keep: 47 });
  });

  it('keeps processor context on both sides', () => {
    const w = decodeWindow({ start: 100, end: 200 }, 6, 8);
    expect(w).toMatchObject({ first: 86, skip: 8, ctxBefore: 6, keep: 112, length: 100 });
  });
});

describe('trackTimescale', () => {
  it('represents every frame duration exactly', () => {
    for (const rate of ['25/1', '30000/1001', '24000/1001', '50/1']) {
      const [n, d] = rate.split('/').map(Number);
      const ts = trackTimescale(rate);
      expect(Number.isInteger((ts * d) / n)).toBe(true);
      expect(ts).toBeGreaterThanOrEqual(10_000);
    }
  });
});

describe('exactSeek', () => {
  const info = { fps: 25, fpsRational: '25/1', startTime: 0 } as VideoInfo;

  it('seeks a second early and starts the frame grid at the wanted slot', () => {
    const s = exactSeek(info, 100, 50);
    expect(s.input).toEqual(['-copyts', '-ss', '3.000000', '-t', '3.000000']);
    expect(s.filter).toEqual(['fps=fps=25/1:start_time=4.000000']);
  });

  it('honours a non-zero start time (MPEG-TS, VOB)', () => {
    const s = exactSeek({ ...info, startTime: 1.4 }, 0, 10);
    expect(s.input).toEqual(['-copyts', '-t', '0.400000']);
    expect(s.filter).toEqual(['fps=fps=25/1:start_time=1.400000']);
  });
});

describe('parseSceneTimes', () => {
  it('reads pts_time from showinfo lines', () => {
    const log = [
      '[Parsed_showinfo_4 @ 0x1] n:   0 pts:  10240 pts_time:4.04    duration: 512',
      'unrelated pts_time:9.9',
      '[Parsed_showinfo_4 @ 0x1] n:   1 pts:  20480 pts_time:8       duration: 512',
    ].join('\n');
    expect(parseSceneTimes(log)).toEqual([4.04, 8]);
  });
});
