// Montage (cut list) editing: which parts of which source files end up in the result, in
// what order, and how neighbouring clips blend. Pure functions, so the UI can keep every
// state for undo/redo and saving, and the main process can validate what it renders.
//
// Units: a clip's `start`/`end` are frames of its own source (at the source's `fps`). The
// montage timeline counts frames at the project frame rate (the video the montage was
// opened from); a clip from a source with another rate is converted when rendering.

export type TransitionKind = 'fadeblack' | 'fade' | 'wipeleft' | 'slideleft';

export const TRANSITIONS: { kind: TransitionKind; title: string }[] = [
  { kind: 'fadeblack', title: 'Затемнение' },
  { kind: 'fade', title: 'Растворение' },
  { kind: 'wipeleft', title: 'Шторка' },
  { kind: 'slideleft', title: 'Сдвиг' },
];

export interface Transition {
  kind: TransitionKind;
  /** Overlap of the two clips, in project frames. */
  frames: number;
}

export interface MontageClip {
  id: string;
  /** Source file path. */
  source: string;
  /** Frame rate of the source; `start`/`end` count its frames. */
  fps: number;
  start: number;
  end: number;
  /** Transition from the previous clip into this one. */
  transitionIn?: Transition;
  /** Played backwards: from source frame end - 1 down to start (sound too). */
  reversed?: boolean;
}

/** Frames of the source used by the clip. */
export const sourceFrames = (c: MontageClip) => c.end - c.start;

/** Length of the clip on the montage timeline, in project frames. */
export function clipLength(c: MontageClip, fps: number): number {
  const n = sourceFrames(c);
  return sameRate(c.fps, fps) ? n : Math.max(1, Math.round((n * fps) / c.fps));
}

const sameRate = (a: number, b: number) => Math.abs(a - b) < 1e-6;

let seq = 0;
/** Unique clip id (good enough for UI keys, undo history and saved projects). */
export const newClipId = () => `m${Date.now().toString(36)}${(++seq).toString(36)}`;

/** A whole source file as one clip. */
export function wholeSource(source: string, fps: number, frames: number, id = newClipId()): MontageClip {
  return { id, source, fps, start: 0, end: Math.max(1, frames) };
}

/**
 * Transition lengths actually used, per clip (index 0 is always 0). Requested lengths are
 * clamped so that neighbouring transitions never overlap and every clip keeps at least one
 * frame of its own. The renderer and the timeline use the same numbers.
 */
export function transitionFrames(clips: MontageClip[], fps: number): number[] {
  const len = clips.map((c) => clipLength(c, fps));
  const t = clips.map(() => 0);
  for (let i = 1; i < clips.length; i++) {
    const want = Math.round(clips[i].transitionIn?.frames ?? 0);
    if (want <= 0) continue;
    const max = Math.min(len[i - 1] - t[i - 1], len[i]) - 1;
    t[i] = Math.max(0, Math.min(want, max));
  }
  return t;
}

export interface MontageLayout {
  /** Timeline frame where each clip starts (it overlaps the previous one by `trans[i]`). */
  starts: number[];
  lengths: number[];
  trans: number[];
  total: number;
}

export function layout(clips: MontageClip[], fps: number): MontageLayout {
  const lengths = clips.map((c) => clipLength(c, fps));
  const trans = transitionFrames(clips, fps);
  const starts: number[] = [];
  for (let i = 0; i < clips.length; i++) starts.push(i === 0 ? 0 : starts[i - 1] + lengths[i - 1] - trans[i]);
  const last = clips.length - 1;
  return { starts, lengths, trans, total: last >= 0 ? starts[last] + lengths[last] : 0 };
}

/** Total length of the montage, in project frames. */
export const montageFrames = (clips: MontageClip[], fps: number) => layout(clips, fps).total;

/** Timeline frame where clip `index` starts. */
export const clipStartFrame = (clips: MontageClip[], fps: number, index: number) => layout(clips, fps).starts[index] ?? 0;

/**
 * Which clip is shown at timeline frame `frame`, and the offset inside it (project frames).
 * Inside a transition the outgoing clip is shown up to the middle, the incoming one after it.
 * Past the end: the last clip with offset = its length.
 */
export function locate(clips: MontageClip[], fps: number, frame: number): { index: number; offset: number } {
  if (!clips.length) return { index: 0, offset: 0 };
  const { starts, lengths, trans, total } = layout(clips, fps);
  const f = Math.max(0, Math.round(frame));
  const last = clips.length - 1;
  if (f >= total) return { index: last, offset: lengths[last] };
  for (let i = 0; i < clips.length; i++) {
    const windowEnd = starts[i] + lengths[i] - Math.floor((trans[i + 1] ?? 0) / 2);
    if (f < windowEnd) return { index: i, offset: f - starts[i] };
  }
  return { index: last, offset: lengths[last] };
}

/** Project-frame offset inside a clip -> how many source frames in (counted in playing order). */
function sourceOffset(c: MontageClip, offset: number, fps: number): number {
  return sameRate(c.fps, fps) ? offset : Math.round((offset * c.fps) / fps);
}

/** Project-frame offset inside a clip -> frame of its source (a reversed clip counts down from the end). */
export function sourceFrameOf(c: MontageClip, offset: number, fps: number): number {
  const k = sourceOffset(c, offset, fps);
  const f = c.reversed ? c.end - 1 - k : c.start + k;
  return Math.min(c.end - 1, Math.max(c.start, f));
}

/** Clip and source frame shown at timeline frame `frame`. */
export function sourceFrameAt(clips: MontageClip[], fps: number, frame: number): { index: number; frame: number } {
  if (!clips.length) return { index: 0, frame: 0 };
  const { index, offset } = locate(clips, fps, frame);
  return { index, frame: sourceFrameOf(clips[index], offset, fps) };
}

/**
 * A transition belongs to a pair of neighbours. After a reorder or delete, keep it only
 * where the clip still follows the same clip; the first clip never has one.
 */
function keepPairs(before: MontageClip[], after: MontageClip[]): MontageClip[] {
  const prevOf = new Map(before.map((c, i) => [c.id, before[i - 1]?.id]));
  return after.map((c, i) => {
    if (!c.transitionIn) return c;
    if (i > 0 && prevOf.get(c.id) === after[i - 1].id) return c;
    const { transitionIn: _dropped, ...rest } = c;
    return rest;
  });
}

/** Split the clip under timeline frame `frame` there. No-op on a clip boundary. */
export function splitClip(clips: MontageClip[], fps: number, frame: number, id = newClipId()): MontageClip[] {
  const { index, offset } = locate(clips, fps, frame);
  const c = clips[index];
  if (!c) return clips;
  const k = sourceOffset(c, offset, fps); // source frames played before the cut
  if (offset <= 0 || k <= 0 || k >= sourceFrames(c)) return clips;
  const { transitionIn: _keepOnLeft, ...plain } = c;
  const out = clips.slice();
  if (c.reversed) {
    // Played from the end: the left part is the end of the source range.
    const cut = c.end - k;
    out.splice(index, 1, { ...c, start: cut }, { ...plain, id, end: cut });
  } else {
    const cut = c.start + k;
    out.splice(index, 1, { ...c, end: cut }, { ...plain, id, start: cut });
  }
  return out;
}

export function removeClips(clips: MontageClip[], ids: Iterable<string>): MontageClip[] {
  const drop = new Set(ids);
  return keepPairs(clips, clips.filter((c) => !drop.has(c.id)));
}

/** Move a clip `delta` places left (negative) or right. */
export function moveClip(clips: MontageClip[], id: string, delta: number): MontageClip[] {
  const from = clips.findIndex((c) => c.id === id);
  if (from < 0) return clips;
  const to = Math.min(clips.length - 1, Math.max(0, from + delta));
  if (to === from) return clips;
  const out = clips.slice();
  const [c] = out.splice(from, 1);
  out.splice(to, 0, c);
  return keepPairs(clips, out);
}

/** Insert clips after position `index` (-1 = at the start, clips.length - 1 = at the end). */
export function insertClips(clips: MontageClip[], added: MontageClip[], index = clips.length - 1): MontageClip[] {
  const at = Math.min(clips.length, Math.max(0, index + 1));
  const out = [...clips.slice(0, at), ...added, ...clips.slice(at)];
  return keepPairs(clips, out);
}

/**
 * Change a clip's in or out point (source frames). The clip keeps at least one frame and
 * stays inside its source; like in Clipchamp, a trimmed edge can be dragged back out.
 */
export function trimClip(
  clips: MontageClip[], id: string, edge: 'start' | 'end', sourceFrame: number, totalFrames: number,
): MontageClip[] {
  const f = Math.round(sourceFrame);
  return clips.map((c) => {
    if (c.id !== id) return c;
    if (edge === 'start') return { ...c, start: Math.min(c.end - 1, Math.max(0, f)) };
    return { ...c, end: Math.max(c.start + 1, Math.min(totalFrames, f)) };
  });
}

/**
 * Source edge under a timeline edge: the left edge of a reversed clip is the end of its
 * source range (and the right edge its start).
 */
export function sourceEdge(c: MontageClip, edge: 'start' | 'end'): 'start' | 'end' {
  return c.reversed ? (edge === 'start' ? 'end' : 'start') : edge;
}

/** Play the given clips backwards (or forwards again). */
export function reverseClips(clips: MontageClip[], ids: Iterable<string>): MontageClip[] {
  const flip = new Set(ids);
  return clips.map((c) => {
    if (!flip.has(c.id)) return c;
    if (c.reversed) {
      const { reversed: _off, ...rest } = c;
      return rest;
    }
    return { ...c, reversed: true };
  });
}

/**
 * The whole montage backwards: clips in reverse order, each one played backwards. The join
 * between two clips keeps its transition (it is the same join, crossed the other way).
 */
export function reverseMontage(clips: MontageClip[]): MontageClip[] {
  const n = clips.length;
  const flipped = reverseClips(clips, clips.map((c) => c.id)).reverse();
  return flipped.map((c, j) => {
    const { transitionIn: _old, ...rest } = c;
    const join = j > 0 ? clips[n - j].transitionIn : undefined;
    return join ? { ...rest, transitionIn: join } : rest;
  });
}

/** Set (or remove, with null) the transition into clip `id`. The first clip cannot have one. */
export function setTransition(clips: MontageClip[], id: string, t: Transition | null): MontageClip[] {
  return clips.map((c, i) => {
    if (c.id !== id || i === 0) return c;
    if (!t) {
      const { transitionIn: _removed, ...rest } = c;
      return rest;
    }
    return { ...c, transitionIn: { kind: t.kind, frames: Math.max(1, Math.round(t.frames)) } };
  });
}

/** The same transition on every join (or none). */
export function setAllTransitions(clips: MontageClip[], t: Transition | null): MontageClip[] {
  return clips.reduce((acc, c) => setTransition(acc, c.id, t), clips);
}

/** Every clip is non-empty, whole frames, inside a known source. Used before rendering. */
export function validMontage(clips: MontageClip[], sourceLengths: Record<string, number>): boolean {
  return clips.length > 0 && clips.every((c) => {
    const total = sourceLengths[c.source];
    return total !== undefined && Number.isInteger(c.start) && Number.isInteger(c.end)
      && c.start >= 0 && c.end <= total && c.end > c.start && c.fps > 0
      && (!c.transitionIn || (Number.isInteger(c.transitionIn.frames) && c.transitionIn.frames >= 0));
  });
}

/** Distinct source files, in order of first use. */
export const montageSources = (clips: MontageClip[]) => [...new Set(clips.map((c) => c.source))];
