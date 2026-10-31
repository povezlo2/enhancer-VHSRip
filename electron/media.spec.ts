import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseRange, serveFile } from './media';

describe('parseRange', () => {
  it('handles open, closed, suffix and invalid ranges', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull(); // multipart: serve whole file
  });
});

describe('serveFile', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'enh-media-'));
  const file = path.join(dir, 'a.mp4');
  writeFileSync(file, Buffer.from([...Array(100).keys()]));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('answers a range request with 206 and exactly those bytes', async () => {
    const res = serveFile(file, 'bytes=10-14');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 10-14/100');
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([10, 11, 12, 13, 14]);
  });

  it('serves the whole file without a range and advertises range support', async () => {
    const res = serveFile(file, null);
    expect(res.status).toBe(200);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
    expect(serveFile(file, 'bytes=200-').status).toBe(416);
  });
});
