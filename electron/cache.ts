import { existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import type { CacheInfo } from '../shared/types';

/**
 * Finished fragments, keyed by a hash of everything that affects them (source file, frame
 * range, settings, tool versions). Re-running a clip after changing one fragment only
 * re-renders that fragment; an interrupted job resumes where it stopped.
 */
export class ChunkCache {
  readonly dir: string;

  constructor(
    dir: string,
    /** Oldest fragments are deleted when the cache grows past this size. */
    readonly limitBytes = 10 * 1024 ** 3,
  ) {
    this.dir = path.resolve(dir);
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.mp4`);
  }

  /** Path of the cached fragment, or null. Touches it so eviction treats it as recently used. */
  get(key: string): string | null {
    const f = this.file(key);
    if (!existsSync(f)) return null;
    const now = new Date();
    try {
      utimesSync(f, now, now);
    } catch {
      /* read-only or vanished: still usable if it exists */
    }
    return f;
  }

  /** Move a finished fragment into the cache and return its new path. */
  put(key: string, source: string, protect: Iterable<string> = []): string {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(key);
    try {
      renameSync(source, target);
    } catch {
      copyFileSync(source, target); // different drive than the temp folder
      rmSync(source, { force: true });
    }
    this.evict(new Set([target, ...protect]));
    return target;
  }

  info(): CacheInfo {
    const files = this.list();
    return { dir: this.dir, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  }

  clear(): CacheInfo {
    for (const f of this.list()) rmSync(f.path, { force: true });
    return this.info();
  }

  private evict(protect: Set<string>) {
    const files = this.list().sort((a, b) => a.mtime - b.mtime);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files) {
      if (total <= this.limitBytes) break;
      if (protect.has(f.path)) continue;
      rmSync(f.path, { force: true });
      total -= f.size;
    }
  }

  private list(): { path: string; size: number; mtime: number }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => n.endsWith('.mp4'))
      .map((n) => {
        const p = path.join(this.dir, n);
        const st = statSync(p);
        return { path: p, size: st.size, mtime: st.mtimeMs };
      });
  }
}
