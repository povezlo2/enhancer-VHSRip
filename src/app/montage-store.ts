import { effect, inject, Injectable, signal, computed } from '@angular/core';
import { createHistory, type History, record, redo, undo } from '../../shared/history';
import {
  insertClips, type MontageClip, montageFrames, montageSources, wholeSource,
} from '../../shared/montage';
import type { MontageFormat, MontageProgress, VideoInfo } from '../../shared/types';
import { Store } from './store';

/** Everything the montage editor needs about one source file. */
export interface SourceMedia {
  info?: VideoInfo;
  error?: string;
  /** media:// URL of the playable copy. */
  proxy?: string;
  thumbs?: { interval: number; urls: string[] };
  /** media:// URL of the whole video played backwards (made when a clip of it is reversed). */
  reversedProxy?: string;
  reversedError?: string;
}

/** A montage, keyed by the path of the video it belongs to (its "owner"). */
export interface MontageState {
  owner: string;
  name: string;
  /** Project frame rate (the owner's). */
  fps: number;
  history: History<MontageClip[]>;
  format: MontageFormat;
  crf: number;
  /** Last edit, ms since epoch; unset until the montage is first changed. */
  savedAt?: number;
  /** Loaded from a previous run and not edited since. */
  restored?: boolean;
  adding?: boolean;
  rendering?: boolean;
  progress?: MontageProgress;
  error?: string;
  /** Queue entry created from the last render. */
  resultId?: string;
  resultName?: string;
}

type Saved = Pick<MontageState, 'owner' | 'name' | 'fps' | 'history' | 'format' | 'crf' | 'savedAt'>;

const STORAGE_KEY = 'enhancer.montages.v2';
/** Montages kept between runs (most recently edited). */
const KEEP = 20;

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function isClip(c: unknown): c is MontageClip {
  const x = c as MontageClip;
  return !!x && typeof x.id === 'string' && typeof x.source === 'string' && x.fps > 0
    && Number.isInteger(x.start) && Number.isInteger(x.end) && x.end > x.start;
}

function loadSaved(): Record<string, MontageState> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, Saved>;
    const out: Record<string, MontageState> = {};
    for (const s of Object.values(raw)) {
      const h = s?.history;
      const lists = h ? [h.present, ...(h.past ?? []), ...(h.future ?? [])] : [];
      if (!s?.owner || !(s.fps > 0) || !lists.length || !lists.every((l) => Array.isArray(l) && l.every(isClip))) continue;
      out[s.owner] = {
        owner: s.owner, name: s.name || baseName(s.owner), fps: s.fps,
        history: { past: h.past ?? [], present: h.present, future: h.future ?? [] },
        format: s.format === 'mp4' ? 'mp4' : 'lossless', crf: s.crf || 18, savedAt: s.savedAt, restored: true,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Montages: cut lists with undo/redo (5 steps), clips from several videos, transitions,
 * render settings. Edited montages are saved automatically and restored on the next run.
 */
@Injectable({ providedIn: 'root' })
export class MontageStore {
  private readonly store = inject(Store);
  private readonly api = this.store.api;

  readonly sources = signal<Record<string, SourceMedia>>({});
  readonly states = signal<Record<string, MontageState>>(loadSaved());
  /** Saved montages, newest first, for the start screen. */
  readonly recent = computed(() =>
    Object.values(this.states()).filter((s) => s.savedAt).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)).slice(0, 6));

  private renderingOwner: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pending = new Map<string, Promise<VideoInfo | undefined>>();
  private readonly pendingReversed = new Set<string>();

  constructor() {
    this.api.onMontageProgress((p) => {
      if (this.renderingOwner) this.patch(this.renderingOwner, { progress: p });
    });
    effect(() => {
      const states = this.states();
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.persist(states), 400);
    });
  }

  /** Montage of `owner`, created on first use (the whole video as one clip). Loads its sources. */
  open(owner: string, info: VideoInfo | undefined): MontageState | null {
    let state = this.states()[owner];
    if (!state) {
      if (!info) return null;
      state = {
        owner, name: baseName(owner), fps: info.fps, format: 'lossless', crf: 18,
        history: createHistory([wholeSource(owner, info.fps, info.frames)]),
      };
      this.states.update((all) => ({ ...all, [owner]: state! }));
    }
    if (info) this.sources.update((all) => ({ ...all, [owner]: { ...all[owner], info } }));
    for (const src of new Set([owner, ...montageSources(state.history.present)])) void this.ensureSource(src);
    this.syncReversed(state.history.present);
    return state;
  }

  /** Make sure every source with a reversed clip has its backwards copy for the player. */
  private syncReversed(clips: MontageClip[]) {
    for (const src of new Set(clips.filter((c) => c.reversed).map((c) => c.source))) void this.ensureReversed(src);
  }

  private async ensureReversed(path: string) {
    const known = this.sources()[path];
    if (known?.reversedProxy || this.pendingReversed.has(path)) return;
    this.pendingReversed.add(path);
    try {
      this.patchSource(path, { reversedProxy: this.api.mediaUrl(await this.api.reversedProxy(path)), reversedError: undefined });
    } catch (err) {
      this.patchSource(path, { reversedError: messageOf(err) });
    } finally {
      this.pendingReversed.delete(path);
    }
  }

  /** Analysis, playable proxy and thumbnails of a source (fetched once; concurrent callers share the load). */
  ensureSource(path: string): Promise<VideoInfo | undefined> {
    const known = this.sources()[path];
    if (known?.info && known.proxy && known.thumbs) return Promise.resolve(known.info);
    let job = this.pending.get(path);
    if (!job) {
      job = this.load(path).finally(() => this.pending.delete(path));
      this.pending.set(path, job);
    }
    return job;
  }

  private async load(path: string): Promise<VideoInfo | undefined> {
    let info = this.sources()[path]?.info;
    try {
      info ??= await this.api.analyze(path);
      this.patchSource(path, { info, error: undefined });
      // Playback aids: a failure here still leaves the source usable for rendering.
      if (!this.sources()[path]?.proxy) this.patchSource(path, { proxy: this.api.mediaUrl(await this.api.proxy(path)) });
      if (!this.sources()[path]?.thumbs) {
        const t = await this.api.thumbnails(path);
        this.patchSource(path, { thumbs: { interval: t.interval, urls: t.files.map((f) => this.api.mediaUrl(f)) } });
      }
    } catch (err) {
      this.patchSource(path, { error: messageOf(err) });
    }
    return info;
  }

  edit(owner: string, clips: MontageClip[]) {
    const m = this.states()[owner];
    if (!m) return;
    this.patch(owner, { history: record(m.history, clips), error: undefined, restored: false, savedAt: Date.now() });
    this.syncReversed(clips);
  }

  undo(owner: string) {
    const m = this.states()[owner];
    if (!m?.history.past.length) return;
    this.patch(owner, { history: undo(m.history), restored: false, savedAt: Date.now() });
    this.syncReversed(this.states()[owner]!.history.present);
  }

  redo(owner: string) {
    const m = this.states()[owner];
    if (!m?.history.future.length) return;
    this.patch(owner, { history: redo(m.history), restored: false, savedAt: Date.now() });
    this.syncReversed(this.states()[owner]!.history.present);
  }

  /** Append whole videos after clip `afterIndex` (default: at the end). */
  async add(owner: string, paths: string[], afterIndex?: number) {
    const m = this.states()[owner];
    if (!m || !paths.length) return;
    this.patch(owner, { adding: true, error: undefined });
    try {
      const added: MontageClip[] = [];
      for (const p of paths) {
        const info = await this.ensureSource(p);
        if (!info) throw new Error(`Не удалось открыть ${baseName(p)}: ${this.sources()[p]?.error ?? 'неизвестная ошибка'}`);
        added.push(wholeSource(p, info.fps, info.frames));
      }
      const current = this.states()[owner]!.history.present;
      this.edit(owner, insertClips(current, added, afterIndex ?? current.length - 1));
    } catch (err) {
      this.patch(owner, { error: messageOf(err) });
    } finally {
      this.patch(owner, { adding: false });
    }
  }

  async pickAndAdd(owner: string, afterIndex?: number) {
    await this.add(owner, await this.api.openFiles(), afterIndex);
  }

  /** Back to the whole owner video as one clip (undoable). */
  restart(owner: string) {
    const info = this.sources()[owner]?.info;
    if (info) this.edit(owner, [wholeSource(owner, info.fps, info.frames)]);
  }

  setOutput(owner: string, format: MontageFormat, crf?: number) {
    this.patch(owner, { format, ...(crf ? { crf } : {}) });
  }

  /** Forget a saved montage (start screen). */
  forget(owner: string) {
    this.states.update(({ [owner]: _gone, ...rest }) => rest);
  }

  /** Render, then add the result to the clip list below the others. */
  async render(owner: string) {
    const m = this.states()[owner];
    if (!m || m.rendering || this.renderingOwner) return;
    const missing = montageSources(m.history.present).filter((p) => !this.sources()[p]?.info);
    if (missing.length) {
      this.patch(owner, { error: `Нет доступа к файлам: ${missing.map(baseName).join(', ')}` });
      return;
    }
    this.renderingOwner = owner;
    this.patch(owner, { rendering: true, error: undefined, progress: { percent: 0 }, resultId: undefined, resultName: undefined });
    try {
      const output = await this.api.renderMontage({
        owner, clips: m.history.present, format: m.format, crf: m.crf, outDir: this.store.outDir(),
      });
      const [id] = this.store.addPaths([output]);
      if (id) this.store.markMontageResult(id, m.name);
      this.patch(owner, { rendering: false, resultId: id, resultName: baseName(output) });
      void this.store.refreshCache();
    } catch (err) {
      const msg = messageOf(err);
      this.patch(owner, { rendering: false, progress: undefined, error: /cancel/i.test(msg) ? undefined : msg });
    } finally {
      this.renderingOwner = null;
    }
  }

  cancelRender() {
    void this.api.cancelMontage();
  }

  /** Total length in seconds (for the start screen). */
  seconds(m: MontageState): number {
    return montageFrames(m.history.present, m.fps) / m.fps;
  }

  private patch(owner: string, patch: Partial<MontageState>) {
    this.states.update((all) => (all[owner] ? { ...all, [owner]: { ...all[owner], ...patch } } : all));
  }

  private patchSource(path: string, patch: Partial<SourceMedia>) {
    this.sources.update((all) => ({ ...all, [path]: { ...all[path], ...patch } }));
  }

  private persist(states: Record<string, MontageState>) {
    const saved = Object.values(states)
      .filter((s) => s.savedAt)
      .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
      .slice(0, KEEP)
      .map(({ owner, name, fps, history, format, crf, savedAt }): Saved => ({ owner, name, fps, history, format, crf, savedAt }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(saved.map((s) => [s.owner, s]))));
    } catch {
      /* storage full or unavailable: the montage just will not survive a restart */
    }
  }
}

function messageOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
