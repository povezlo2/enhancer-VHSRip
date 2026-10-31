import { describe, expect, it } from 'vitest';
import { coversRange, fixedSegments, mergeWithNext, segmentsFromCuts, splitAt } from './segments';

describe('fixedSegments', () => {
  it('splits into equal fragments no longer than maxSec', () => {
    const s = fixedSegments(0, 625, 25, 10); // 25 s at 25 fps
    expect(s).toHaveLength(3);
    expect(coversRange(s, 0, 625)).toBe(true);
    expect(Math.max(...s.map((x) => x.end - x.start))).toBeLessThanOrEqual(250);
  });

  it('keeps a short range in one fragment and returns nothing for an empty one', () => {
    expect(fixedSegments(10, 60, 25)).toEqual([{ start: 10, end: 60 }]);
    expect(fixedSegments(5, 5, 25)).toEqual([]);
  });
});

describe('segmentsFromCuts', () => {
  const fps = 25;

  it('cuts at scene changes and normalises lengths to 5..10 s', () => {
    // scenes: 0-200 (8 s), 200-260 (2.4 s, too short), 260-900 (25.6 s, too long)
    const s = segmentsFromCuts([200, 260], 0, 900, fps);
    expect(coversRange(s, 0, 900)).toBe(true);
    // The short scene joins the previous one (0-260, 10.4 s), which is then halved.
    expect(s.slice(0, 2)).toEqual([{ start: 0, end: 130 }, { start: 130, end: 260 }]);
    for (const x of s) {
      expect(x.end - x.start).toBeLessThanOrEqual(10 * fps);
      expect(x.end - x.start).toBeGreaterThanOrEqual(5 * fps);
    }
  });

  it('merges a short first scene into the next one', () => {
    const s = segmentsFromCuts([30], 0, 300, fps);
    expect(s[0].start).toBe(0);
    expect(s[0].end).toBeGreaterThan(30);
  });

  it('ignores duplicate, unsorted and out-of-range cuts', () => {
    const s = segmentsFromCuts([400, 150, 150, -5, 2000], 0, 600, fps);
    expect(coversRange(s, 0, 600)).toBe(true);
    expect(s.map((x) => x.start)).toContain(150);
    expect(s.map((x) => x.start)).toContain(400);
  });
});

describe('editing', () => {
  const base = [{ start: 0, end: 100 }, { start: 100, end: 250, overrides: { faceRestore: true } }];

  it('splits inside a fragment and keeps its overrides on both halves', () => {
    const s = splitAt(base, 180);
    expect(s).toEqual([
      { start: 0, end: 100 },
      { start: 100, end: 180, overrides: { faceRestore: true } },
      { start: 180, end: 250, overrides: { faceRestore: true } },
    ]);
    expect(splitAt(base, 100)).toEqual(base); // existing boundary
  });

  it('merges with the next fragment', () => {
    expect(mergeWithNext(base, 0)).toEqual([{ start: 0, end: 250 }]);
    expect(mergeWithNext(base, 1)).toBe(base); // last one: nothing to merge
  });

  it('detects gaps and overlaps', () => {
    expect(coversRange([{ start: 0, end: 10 }, { start: 11, end: 20 }], 0, 20)).toBe(false);
    expect(coversRange([{ start: 0, end: 10 }, { start: 9, end: 20 }], 0, 20)).toBe(false);
    expect(coversRange([], 0, 0)).toBe(false);
  });
});
