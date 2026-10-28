import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChunkCache } from './cache';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'enh-cache-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function fragment(dir: string, name: string, bytes: number): string {
  const f = path.join(dir, name);
  writeFileSync(f, Buffer.alloc(bytes));
  return f;
}

describe('ChunkCache', () => {
  it('stores, finds and clears fragments', () => {
    const work = tmp();
    const cache = new ChunkCache(path.join(tmp(), 'c'));
    expect(cache.get('a')).toBeNull();
    const stored = cache.put('a', fragment(work, 'x.mp4', 10));
    expect(cache.get('a')).toBe(stored);
    expect(cache.info()).toMatchObject({ files: 1, bytes: 10 });
    expect(cache.clear()).toMatchObject({ files: 0, bytes: 0 });
  });

  it('evicts the least recently used fragments but never protected ones', () => {
    const work = tmp();
    const cache = new ChunkCache(tmp(), 25);
    const a = cache.put('a', fragment(work, 'a.mp4', 10));
    const b = cache.put('b', fragment(work, 'b.mp4', 10));
    utimesSync(a, new Date(1000), new Date(1000));
    utimesSync(b, new Date(2000), new Date(2000));
    cache.put('c', fragment(work, 'c.mp4', 10), [a]);
    expect(cache.get('a')).not.toBeNull(); // protected (e.g. part of the running job)
    expect(cache.get('b')).toBeNull(); // oldest unprotected
    expect(cache.get('c')).not.toBeNull();
  });
});
