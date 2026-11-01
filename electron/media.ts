import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

/** Parse a single `bytes=start-end` range. Null = no/unsupported range (serve everything). */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'invalid' | null {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return 'invalid';
  let start: number;
  let end: number;
  if (a === '') {
    // Suffix range: the last N bytes.
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(size - 1, Number(b));
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

/**
 * Serve a local file with HTTP range support. Without ranges Chromium can only seek inside
 * what it has already buffered, so jumping around a video in the editors silently fails.
 */
export function serveFile(file: string, rangeHeader: string | null): Response {
  const size = statSync(file).size;
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = size ? (Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>) : null;
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Content-Length': String(size ? end - start + 1 : 0),
    'Accept-Ranges': 'bytes',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: range ? 206 : 200, headers });
}
