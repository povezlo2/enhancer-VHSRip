// Splitting a clip into fragments ("segments"). Frame-based: start inclusive, end exclusive,
// both counted from the first frame of the source file. Pure functions, shared by main and UI.

/** Per-fragment changes on top of the clip settings. */
export interface SegmentOverrides {
  /** Force face restoration on or off for this fragment. */
  faceRestore?: boolean;
}

export interface Segment {
  start: number;
  end: number;
  overrides?: SegmentOverrides;
}

export interface SegmentLimits {
  /** Fragments shorter than this are merged into a neighbour. */
  minSec: number;
  /** Fragments longer than this are split into equal parts. */
  maxSec: number;
}

export const DEFAULT_LIMITS: SegmentLimits = { minSec: 5, maxSec: 10 };

export const segmentFrames = (s: Segment) => s.end - s.start;

/** Equal fragments of at most `maxSec` covering [start, end). */
export function fixedSegments(start: number, end: number, fps: number, maxSec = DEFAULT_LIMITS.maxSec): Segment[] {
  const total = end - start;
  if (total <= 0) return [];
  const maxLen = Math.max(1, Math.round(maxSec * fps));
  const parts = Math.max(1, Math.ceil(total / maxLen));
  const out: Segment[] = [];
  for (let i = 0; i < parts; i++) {
    out.push({ start: start + Math.round((total * i) / parts), end: start + Math.round((total * (i + 1)) / parts) });
  }
  return out;
}

/**
 * Fragments cut at scene changes, then normalised: a scene shorter than `minSec` is merged
 * into the previous fragment (the first scene into the next one), and anything longer than
 * `maxSec` is split evenly so no fragment exceeds it.
 */
export function segmentsFromCuts(
  cuts: number[], start: number, end: number, fps: number, limits: SegmentLimits = DEFAULT_LIMITS,
): Segment[] {
  const minLen = Math.round(limits.minSec * fps);
  const points = [...new Set(cuts.map(Math.round))].filter((c) => c > start && c < end).sort((a, b) => a - b);
  const bounds = [start, ...points, end];

  const scenes: Segment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) scenes.push({ start: bounds[i], end: bounds[i + 1] });

  const merged: Segment[] = [];
  for (const s of scenes) {
    const prev = merged[merged.length - 1];
    if (prev && (segmentFrames(s) < minLen || segmentFrames(prev) < minLen)) prev.end = s.end;
    else merged.push({ ...s });
  }
  return merged.flatMap((s) => fixedSegments(s.start, s.end, fps, limits.maxSec));
}

/** Split the fragment containing `frame` at that frame. No-op on an existing boundary. */
export function splitAt(segments: Segment[], frame: number): Segment[] {
  const f = Math.round(frame);
  return segments.flatMap((s) =>
    f > s.start && f < s.end
      ? [{ ...s, end: f }, { ...s, start: f }]
      : [s]);
}

/** Merge fragment `index` with the next one; the merged fragment keeps the first one's overrides. */
export function mergeWithNext(segments: Segment[], index: number): Segment[] {
  if (index < 0 || index >= segments.length - 1) return segments;
  const out = segments.slice();
  out.splice(index, 2, { ...segments[index], end: segments[index + 1].end });
  return out;
}

/** True when fragments are contiguous, non-empty and exactly cover [start, end). */
export function coversRange(segments: Segment[], start: number, end: number): boolean {
  if (!segments.length) return false;
  if (segments[0].start !== start || segments[segments.length - 1].end !== end) return false;
  return segments.every((s, i) => s.end > s.start && (i === 0 || segments[i - 1].end === s.start));
}
