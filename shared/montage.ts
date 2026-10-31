// Montage (cut list) editing: which parts of the source end up in the result, in what order.
// Frame-based like segments: a clip is source frames [start, end). Pure functions, so the
// UI can keep every state for undo/redo and the main process can validate what it renders.

export interface MontageClip {
  id: string;
  start: number;
  end: number;
}

export const clipFrames = (c: MontageClip) => c.end - c.start;

/** Total length of the montage in frames. */
export const montageFrames = (clips: MontageClip[]) => clips.reduce((n, c) => n + clipFrames(c), 0);

let seq = 0;
/** Unique clip id (good enough for UI keys and undo history). */
export const newClipId = () => `m${Date.now().toString(36)}${(++seq).toString(36)}`;

/** Whole source as a single clip. */
export function initialMontage(totalFrames: number, id = newClipId()): MontageClip[] {
  return totalFrames > 0 ? [{ id, start: 0, end: totalFrames }] : [];
}

/** Montage frame -> clip index and frame offset inside it. Past the end -> last clip's end. */
export function locate(clips: MontageClip[], frame: number): { index: number; offset: number } {
  let rest = Math.max(0, Math.round(frame));
  for (const [index, c] of clips.entries()) {
    const len = clipFrames(c);
    if (rest < len) return { index, offset: rest };
    rest -= len;
  }
  const last = clips.length - 1;
  return { index: Math.max(0, last), offset: last >= 0 ? clipFrames(clips[last]) : 0 };
}

/** Montage frame where clip `index` starts. */
export function clipStartFrame(clips: MontageClip[], index: number): number {
  return montageFrames(clips.slice(0, Math.max(0, index)));
}

/** Source frame shown at montage frame `frame`. */
export function sourceFrameAt(clips: MontageClip[], frame: number): number {
  if (!clips.length) return 0;
  const { index, offset } = locate(clips, frame);
  return Math.min(clips[index].start + offset, clips[index].end - 1);
}

/** Split the clip under montage frame `frame` there. No-op on a clip boundary. */
export function splitClip(clips: MontageClip[], frame: number, id = newClipId()): MontageClip[] {
  const { index, offset } = locate(clips, frame);
  const c = clips[index];
  if (!c || offset <= 0 || offset >= clipFrames(c)) return clips;
  const out = clips.slice();
  out.splice(index, 1, { ...c, end: c.start + offset }, { id, start: c.start + offset, end: c.end });
  return out;
}

export function removeClips(clips: MontageClip[], ids: Iterable<string>): MontageClip[] {
  const drop = new Set(ids);
  return clips.filter((c) => !drop.has(c.id));
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
  return out;
}

/**
 * Change a clip's in or out point (source frames). The clip keeps at least one frame and
 * stays inside the source; like in Clipchamp, a trimmed edge can be dragged back out.
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

/** Clips are non-empty, whole frames and inside the source. Used before rendering. */
export function validMontage(clips: MontageClip[], totalFrames: number): boolean {
  return clips.length > 0 && clips.every((c) =>
    Number.isInteger(c.start) && Number.isInteger(c.end) && c.start >= 0 && c.end <= totalFrames && c.end > c.start);
}

/** Same cut list (ignoring ids). */
export function sameMontage(a: MontageClip[], b: MontageClip[]): boolean {
  return a.length === b.length && a.every((c, i) => c.start === b[i].start && c.end === b[i].end);
}
