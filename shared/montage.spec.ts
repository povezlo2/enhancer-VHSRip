import { describe, expect, it } from 'vitest';
import { createHistory, record, redo, undo } from './history';
import {
  clipLength, insertClips, layout, locate, type MontageClip, montageFrames, montageSources, moveClip, removeClips,
  reverseClips, reverseMontage, setAllTransitions, setTransition, sourceEdge, sourceFrameAt, splitClip, transitionFrames,
  trimClip, validMontage, wholeSource,
} from './montage';

const FPS = 25;
const ranges = (clips: MontageClip[]) => clips.map((c) => [c.start, c.end]);
const a = (start: number, end: number, id: string): MontageClip => ({ id, source: 'a.avi', fps: 25, start, end });

describe('one source', () => {
  const base = [wholeSource('a.avi', FPS, 100, 'a')];

  it('splits at the playhead and keeps frames contiguous', () => {
    const s = splitClip(base, FPS, 40, 'b');
    expect(ranges(s)).toEqual([[0, 40], [40, 100]]);
    expect(splitClip(s, FPS, 40)).toBe(s); // already a boundary
    expect(splitClip(s, FPS, 0)).toBe(s);
  });

  it('cuts out a middle part: split twice, delete', () => {
    let m = splitClip(splitClip(base, FPS, 30, 'b'), FPS, 50, 'c'); // [0,30) [30,50) [50,100)
    m = removeClips(m, ['b']);
    expect(ranges(m)).toEqual([[0, 30], [50, 100]]);
    expect(montageFrames(m, FPS)).toBe(80);
    expect(sourceFrameAt(m, FPS, 29)).toEqual({ index: 0, frame: 29 });
    expect(sourceFrameAt(m, FPS, 30)).toEqual({ index: 1, frame: 50 });
  });

  it('moves clips and clamps at the ends', () => {
    const m = splitClip(base, FPS, 40, 'b');
    expect(ranges(moveClip(m, 'b', -1))).toEqual([[40, 100], [0, 40]]);
    expect(moveClip(m, 'a', -1)).toBe(m);
  });

  it('trims edges inside the source and never to zero length', () => {
    const m = splitClip(base, FPS, 40, 'b');
    expect(ranges(trimClip(m, 'b', 'start', 60, 100))).toEqual([[0, 40], [60, 100]]);
    expect(ranges(trimClip(m, 'b', 'start', 500, 100))).toEqual([[0, 40], [99, 100]]);
    expect(ranges(trimClip(m, 'a', 'end', -5, 100))).toEqual([[0, 1], [40, 100]]);
    expect(ranges(trimClip(m, 'a', 'end', 1000, 100))).toEqual([[0, 100], [40, 100]]); // drag back out
  });
});

describe('several sources', () => {
  const b30: MontageClip = { id: 'b', source: 'b.mp4', fps: 30, start: 0, end: 90 }; // 3 s

  it('measures clips from another frame rate in project frames', () => {
    expect(clipLength(b30, FPS)).toBe(75);
    const m = [a(0, 50, 'a'), b30];
    expect(montageFrames(m, FPS)).toBe(125);
    // 1 s into the 30 fps clip is its frame 30.
    expect(sourceFrameAt(m, FPS, 75)).toEqual({ index: 1, frame: 30 });
    expect(montageSources(m)).toEqual(['a.avi', 'b.mp4']);
  });

  it('splits a converted clip at the matching source frame', () => {
    const m = splitClip([a(0, 50, 'a'), b30], FPS, 75, 'c');
    expect(ranges(m)).toEqual([[0, 50], [0, 30], [30, 90]]);
    expect(m[2].source).toBe('b.mp4');
  });

  it('inserts clips after a position', () => {
    const m = insertClips([a(0, 50, 'a'), a(60, 80, 'c')], [b30], 0);
    expect(m.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('validates sources and ranges', () => {
    expect(validMontage([a(0, 50, 'a'), b30], { 'a.avi': 100, 'b.mp4': 90 })).toBe(true);
    expect(validMontage([b30], { 'a.avi': 100 })).toBe(false); // unknown source
    expect(validMontage([a(0, 101, 'a')], { 'a.avi': 100 })).toBe(false);
    expect(validMontage([], {})).toBe(false);
  });
});

describe('transitions', () => {
  const fade = (frames: number) => ({ kind: 'fade' as const, frames });

  it('overlap neighbouring clips and shorten the montage', () => {
    const m = setTransition([a(0, 50, 'a'), a(50, 100, 'b')], 'b', fade(10));
    expect(layout(m, FPS)).toEqual({ starts: [0, 40], lengths: [50, 50], trans: [0, 10], total: 90 });
    // Outgoing clip up to the middle of the transition, incoming after it.
    expect(locate(m, FPS, 44)).toEqual({ index: 0, offset: 44 });
    expect(locate(m, FPS, 45)).toEqual({ index: 1, offset: 5 });
  });

  it('are clamped so every clip keeps a frame of its own', () => {
    const m = setAllTransitions([a(0, 10, 'a'), a(10, 16, 'b'), a(16, 40, 'c')], fade(8));
    const t = transitionFrames(m, FPS);
    expect(t).toEqual([0, 5, 0]); // b is 6 frames: 5 in from a, nothing left for b -> c
    expect(setTransition(m, 'a', fade(5))[0].transitionIn).toBeUndefined(); // first clip: none
  });

  it('survive a split on the left half and are dropped when neighbours change', () => {
    let m = setTransition([a(0, 50, 'a'), a(50, 100, 'b')], 'b', fade(10));
    m = splitClip(m, FPS, 70, 'c'); // inside b
    expect(m[1].transitionIn).toEqual(fade(10));
    expect(m[2].transitionIn).toBeUndefined();
    expect(removeClips(m, ['a'])[0].transitionIn).toBeUndefined();
    expect(moveClip(m, 'b', 1).find((c) => c.id === 'b')!.transitionIn).toBeUndefined();
    expect(removeClips(m, ['c'])[1].transitionIn).toEqual(fade(10)); // a -> b untouched
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

describe('reverse', () => {
  const r = (start: number, end: number, id: string): MontageClip => ({ ...a(start, end, id), reversed: true });

  it('plays a reversed clip from its last frame down', () => {
    const m = [r(10, 20, 'x')];
    expect(sourceFrameAt(m, FPS, 0)).toEqual({ index: 0, frame: 19 });
    expect(sourceFrameAt(m, FPS, 9)).toEqual({ index: 0, frame: 10 });
  });

  it('splits a reversed clip so both halves keep playing backwards', () => {
    const m = splitClip([r(10, 20, 'x')], FPS, 3, 'y');
    expect(m).toEqual([r(17, 20, 'x'), r(10, 17, 'y')]);
    // What plays is unchanged by the split: 19, 18, 17 | 16 ... 10.
    expect([0, 2, 3, 9].map((f) => sourceFrameAt(m, FPS, f).frame)).toEqual([19, 17, 16, 10]);
  });

  it('maps timeline edges to source edges', () => {
    expect(sourceEdge(r(0, 5, 'x'), 'start')).toBe('end');
    expect(sourceEdge(a(0, 5, 'x'), 'start')).toBe('start');
  });

  it('toggles clips', () => {
    const m = reverseClips([a(0, 5, 'x'), a(5, 9, 'y')], ['y']);
    expect(m[1].reversed).toBe(true);
    expect(reverseClips(m, ['y'])[1].reversed).toBeUndefined();
  });

  it('reverses the whole montage: order, direction, joins keep their transitions', () => {
    const fade = { kind: 'fade' as const, frames: 4 };
    const m = setTransition([a(0, 10, 'x'), a(10, 20, 'y'), a(20, 30, 'z')], 'z', fade); // join y|z
    const rev = reverseMontage(m);
    expect(rev.map((c) => [c.id, c.reversed])).toEqual([['z', true], ['y', true], ['x', true]]);
    expect(rev[1].transitionIn).toEqual(fade); // same join, now z|y
    expect(rev[0].transitionIn).toBeUndefined();
    expect(rev[2].transitionIn).toBeUndefined();
    // Frame by frame, the result is the original played backwards.
    const total = montageFrames(m, FPS);
    expect(montageFrames(rev, FPS)).toBe(total);
    expect(sourceFrameAt(rev, FPS, 0).frame).toBe(29);
    expect(sourceFrameAt(rev, FPS, total - 1).frame).toBe(0);
    expect(reverseMontage(rev)).toEqual(m);
  });
});
