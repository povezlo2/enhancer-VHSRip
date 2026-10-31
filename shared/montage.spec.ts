import { describe, expect, it } from 'vitest';
import { createHistory, record, redo, undo } from './history';
import {
  initialMontage, locate, montageFrames, moveClip, removeClips, sameMontage, sourceFrameAt, splitClip, trimClip,
  validMontage, type MontageClip,
} from './montage';

const ranges = (clips: MontageClip[]) => clips.map((c) => [c.start, c.end]);

describe('montage editing', () => {
  const base = initialMontage(100, 'a');

  it('splits at the playhead and keeps frames contiguous', () => {
    const s = splitClip(base, 40, 'b');
    expect(ranges(s)).toEqual([[0, 40], [40, 100]]);
    expect(splitClip(s, 40)).toBe(s); // already a boundary
    expect(splitClip(s, 0)).toBe(s);
  });

  it('cuts out a middle part: split twice, delete', () => {
    let m = splitClip(splitClip(base, 30, 'b'), 50, 'c'); // [0,30) [30,50) [50,100)
    m = removeClips(m, ['b']);
    expect(ranges(m)).toEqual([[0, 30], [50, 100]]);
    expect(montageFrames(m)).toBe(80);
    // Montage frame 30 now shows source frame 50.
    expect(sourceFrameAt(m, 29)).toBe(29);
    expect(sourceFrameAt(m, 30)).toBe(50);
    expect(locate(m, 30)).toEqual({ index: 1, offset: 0 });
  });

  it('moves clips and clamps at the ends', () => {
    const m = splitClip(base, 40, 'b');
    expect(ranges(moveClip(m, 'b', -1))).toEqual([[40, 100], [0, 40]]);
    expect(moveClip(m, 'a', -1)).toBe(m);
  });

  it('trims edges inside the source and never to zero length', () => {
    const m = splitClip(base, 40, 'b');
    expect(ranges(trimClip(m, 'b', 'start', 60, 100))).toEqual([[0, 40], [60, 100]]);
    expect(ranges(trimClip(m, 'b', 'start', 500, 100))).toEqual([[0, 40], [99, 100]]);
    expect(ranges(trimClip(m, 'a', 'end', -5, 100))).toEqual([[0, 1], [40, 100]]);
    expect(ranges(trimClip(m, 'a', 'end', 1000, 100))).toEqual([[0, 100], [40, 100]]); // drag back out
  });

  it('validates what may be rendered', () => {
    expect(validMontage(base, 100)).toBe(true);
    expect(validMontage([], 100)).toBe(false);
    expect(validMontage([{ id: 'x', start: 0, end: 101 }], 100)).toBe(false);
    expect(validMontage([{ id: 'x', start: 5, end: 5 }], 100)).toBe(false);
    expect(validMontage([{ id: 'x', start: 0.5, end: 5 }], 100)).toBe(false);
    expect(sameMontage(base, initialMontage(100, 'other'))).toBe(true);
  });
});

describe('history (5 steps each way)', () => {
  it('undoes and redoes up to the limit', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 8; i++) h = record(h, i);
    expect(h.past).toEqual([3, 4, 5, 6, 7]);
    for (let i = 0; i < 7; i++) h = undo(h);
    expect(h.present).toBe(3); // only 5 steps back
    expect(h.future).toEqual([4, 5, 6, 7, 8]);
    h = redo(redo(h));
    expect(h.present).toBe(5);
  });

  it('drops the redo branch after a new edit', () => {
    let h = record(record(createHistory('a'), 'b'), 'c');
    h = record(undo(h), 'x');
    expect(h).toEqual({ past: ['a', 'b'], present: 'x', future: [] });
    expect(redo(h)).toBe(h);
  });
});
