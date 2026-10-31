import { computed, inject, Injectable, signal } from '@angular/core';
import { createHistory, type History, record, redo, undo } from '../../shared/history';
import { initialMontage, type MontageClip } from '../../shared/montage';
import { coversRange, type Segment, segmentsFromCuts } from '../../shared/segments';
import {
  CacheInfo, DEFAULT_OPTIONS, MontageProgress, JobProgress, JobStage, ModelId, PreviewResult, ProcessOptions, SegmentState, ToolsStatus,
  VideoInfo,
} from '../../shared/types';
import { EnhancerApiService } from './enhancer-api';

export interface Clip {
  id: string;
  path: string;
  name: string;
  info?: VideoInfo;
  analyzing: boolean;
  options: ProcessOptions;
  /** Fragments to process; null = automatic (equal fragments of up to 10 s). */
  segments: Segment[] | null;
  /** Fragment states reported by the running or last job. */
  segmentStates?: SegmentState[];
  segmentIndex?: number;
  /** media:// URL of the playable H.264 copy for the fragment editor (built once, stable). */
  proxy?: string;
  proxyError?: string;
  detecting?: boolean;
  /** Set when this clip is the result of a montage: name of the source it was cut from. */
  montageOf?: string;
  jobId?: string;
  stage?: JobStage;
  percent: number;
  framesDone?: number;
  framesTotal?: number;
  etaSec?: number;
  faces?: number;
  output?: string;
  error?: string;
}

/** Montage editor state of one clip: cut list with undo/redo, thumbnails, render status. */
export interface MontageState {
  history: History<MontageClip[]>;
  thumbs?: { interval: number; urls: string[] };
  thumbsError?: string;
  rendering: boolean;
  progress?: MontageProgress;
  error?: string;
  /** Queue entry created from the last render. */
  resultId?: string;
  resultName?: string;
}

export interface PreviewState {
  running: boolean;
  percent: number;
  label: string;
  result?: PreviewResult;
  error?: string;
}

const STORAGE_KEY = 'enhancer.defaults.v1';

function loadDefaults(): { options: ProcessOptions; outDir: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as { options?: Partial<ProcessOptions>; outDir?: string | null };
      return { options: { ...DEFAULT_OPTIONS, ...saved.options, crop: null }, outDir: saved.outDir ?? null };
    }
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  return { options: { ...DEFAULT_OPTIONS }, outDir: null };
}

@Injectable({ providedIn: 'root' })
export class Store {
  private readonly bridge = inject(EnhancerApiService);
  readonly api = this.bridge.api;
  readonly isMock = this.bridge.isMock;

  private readonly initial = loadDefaults();
  private seq = 0;

  readonly tools = signal<ToolsStatus | null>(null);
  readonly clips = signal<Clip[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly outDir = signal<string | null>(this.initial.outDir);
  readonly defaults = signal<ProcessOptions>(this.initial.options);
  readonly preview = signal<PreviewState>({ running: false, percent: 0, label: '' });
  readonly cache = signal<CacheInfo | null>(null);
  readonly montages = signal<Record<string, MontageState>>({});
  /** Clip whose montage is being rendered (one at a time). */
  private renderingId: string | null = null;

  readonly selected = computed(() => this.clips().find((c) => c.id === this.selectedId()) ?? null);
  readonly busy = computed(() => this.clips().some((c) => isActive(c.stage)));
  readonly missingTools = computed(() => {
    const t = this.tools();
    if (!t) return [];
    const miss: string[] = [];
    if (!t.ffmpeg) miss.push('ffmpeg');
    if (!t.ffprobe) miss.push('ffprobe');
    if (!t.realesrgan) miss.push('realesrgan-ncnn-vulkan');
    return miss;
  });

  constructor() {
    void this.refreshTools();
    void this.refreshCache();
    this.api.onProgress((p) => this.applyProgress(p));
    this.api.onMontageProgress((p) => {
      const id = this.renderingId;
      if (id) this.patchMontage(id, { progress: p });
    });
    this.api.onPreviewProgress((p) =>
      this.preview.update((s) => (s.running ? { ...s, percent: p.percent, label: p.message ?? s.label } : s)));
  }

  async refreshTools() {
    this.tools.set(await this.api.tools());
  }

  async pickFiles() {
    this.addPaths(await this.api.openFiles());
  }

  addFiles(files: FileList | File[]) {
    this.addPaths([...files].map((f) => this.api.pathForFile(f)).filter(Boolean));
  }

  addPaths(paths: string[]): string[] {
    const added: string[] = [];
    for (const path of paths) {
      if (this.clips().some((c) => c.path === path && !isFinished(c.stage))) continue;
      const clip: Clip = {
        id: `c${++this.seq}`, path, name: path.split(/[\\/]/).pop() ?? path,
        analyzing: true, options: { ...this.defaults() }, segments: null, percent: 0,
      };
      this.clips.update((list) => [...list, clip]);
      if (!this.selectedId()) this.selectedId.set(clip.id);
      added.push(clip.id);
      void this.analyze(clip.id);
    }
    return added;
  }

  private async analyze(id: string) {
    const clip = this.clips().find((c) => c.id === id);
    if (!clip) return;
    try {
      const info = await this.api.analyze(clip.path);
      this.patch(id, { info, analyzing: false, options: { ...clip.options, crop: info.suggestedCrop } });
    } catch (err) {
      this.patch(id, { analyzing: false, error: messageOf(err) });
    }
  }

  select(id: string) {
    this.selectedId.set(id);
    this.preview.set({ running: false, percent: 0, label: '' });
  }

  remove(id: string) {
    const clip = this.clips().find((c) => c.id === id);
    if (clip?.jobId && isActive(clip.stage)) void this.api.cancel(clip.jobId);
    this.clips.update((list) => list.filter((c) => c.id !== id));
    if (this.montages()[id]) {
      this.montages.update(({ [id]: _removed, ...rest }) => rest);
    }
    if (this.selectedId() === id) this.selectedId.set(this.clips()[0]?.id ?? null);
  }

  updateOptions(id: string, patch: Partial<ProcessOptions>) {
    const clip = this.clips().find((c) => c.id === id);
    if (!clip) return;
    const options = { ...clip.options, ...patch };
    if (patch.model === 'realesrgan-x4plus') options.scale = 4;
    if (patch.model === 'realesr-animevideov3' && options.scale === 4 && !patch.scale) options.scale = 2;
    this.patch(id, { options });
  }

  setSegments(id: string, segments: Segment[] | null) {
    const clip = this.clips().find((c) => c.id === id);
    if (!clip?.info || isActive(clip.stage)) return;
    if (segments && !coversRange(segments, 0, clip.info.frames)) return;
    this.patch(id, { segments, segmentStates: undefined });
  }

  async detectScenes(id: string, threshold: number) {
    const clip = this.clips().find((c) => c.id === id);
    if (!clip?.info || clip.detecting) return;
    this.patch(id, { detecting: true });
    try {
      const cuts = await this.api.detectScenes({ path: clip.path, threshold });
      const fresh = this.clips().find((c) => c.id === id);
      if (fresh?.info) {
        this.patch(id, { segments: segmentsFromCuts(cuts, 0, fresh.info.frames, fresh.info.fps), segmentStates: undefined });
      }
    } catch (err) {
      this.patch(id, { error: messageOf(err) });
    } finally {
      this.patch(id, { detecting: false });
    }
  }

  /** Prepare the playable copy for the fragment editor (once per clip). */
  async loadProxy(id: string) {
    const clip = this.clips().find((c) => c.id === id);
    if (!clip?.info || clip.proxy || clip.proxyError === '') return;
    this.patch(id, { proxyError: '' }); // '' = in progress
    try {
      const file = await this.api.proxy(clip.path);
      this.patch(id, { proxy: this.api.mediaUrl(file), proxyError: undefined });
    } catch (err) {
      this.patch(id, { proxyError: messageOf(err) });
    }
  }

  // --- Montage ------------------------------------------------------------------------

  /** Montage state of a clip, created on first use (the whole video as one clip). */
  montage(id: string): MontageState | null {
    const existing = this.montages()[id];
    if (existing) return existing;
    const clip = this.clips().find((c) => c.id === id);
    if (!clip?.info) return null;
    const state: MontageState = { history: createHistory(initialMontage(clip.info.frames)), rendering: false };
    this.montages.update((m) => ({ ...m, [id]: state }));
    return state;
  }

  /** Apply an edit (undoable, 5 steps). */
  editMontage(id: string, clips: MontageClip[]) {
    const m = this.montage(id);
    if (m) this.patchMontage(id, { history: record(m.history, clips), error: undefined });
  }

  undoMontage(id: string) {
    const m = this.montage(id);
    if (m) this.patchMontage(id, { history: undo(m.history) });
  }

  redoMontage(id: string) {
    const m = this.montage(id);
    if (m) this.patchMontage(id, { history: redo(m.history) });
  }

  async loadThumbnails(id: string) {
    const clip = this.clips().find((c) => c.id === id);
    const m = this.montage(id);
    if (!clip || !m || m.thumbs || m.thumbsError === '') return;
    this.patchMontage(id, { thumbsError: '' }); // '' = loading
    try {
      const t = await this.api.thumbnails(clip.path);
      this.patchMontage(id, { thumbs: { interval: t.interval, urls: t.files.map((f) => this.api.mediaUrl(f)) }, thumbsError: undefined });
    } catch (err) {
      this.patchMontage(id, { thumbsError: messageOf(err) });
    }
  }

  /** Render the cut list to a new file and add it to the list below the others. */
  async renderMontage(id: string) {
    const clip = this.clips().find((c) => c.id === id);
    const m = this.montage(id);
    if (!clip || !m || m.rendering || this.renderingId) return;
    this.renderingId = id;
    this.patchMontage(id, { rendering: true, error: undefined, progress: { percent: 0 }, resultId: undefined, resultName: undefined });
    try {
      const output = await this.api.renderMontage({ path: clip.path, clips: m.history.present, outDir: this.outDir() });
      const [newId] = this.addPaths([output]);
      if (newId) this.patch(newId, { montageOf: clip.name });
      this.patchMontage(id, { rendering: false, resultId: newId, resultName: output.split(/[\\/]/).pop() });
      void this.refreshCache();
    } catch (err) {
      const msg = messageOf(err);
      this.patchMontage(id, { rendering: false, progress: undefined, error: /cancel/i.test(msg) ? undefined : msg });
    } finally {
      this.renderingId = null;
    }
  }

  cancelMontage() {
    void this.api.cancelMontage();
  }

  private patchMontage(id: string, patch: Partial<MontageState>) {
    this.montages.update((all) => (all[id] ? { ...all, [id]: { ...all[id], ...patch } } : all));
  }

  async refreshCache() {
    try {
      this.cache.set(await this.api.cacheInfo());
    } catch {
      this.cache.set(null);
    }
  }

  async clearCache() {
    this.cache.set(await this.api.clearCache());
  }

  /** Remember the current clip's settings (without crop, which is per-file) for new clips. */
  saveAsDefaults(id: string) {
    const clip = this.clips().find((c) => c.id === id);
    if (!clip) return;
    const options = { ...clip.options, crop: null, start: undefined, duration: undefined };
    this.defaults.set(options);
    this.persist();
  }

  applyToAll(id: string) {
    const src = this.clips().find((c) => c.id === id);
    if (!src) return;
    this.clips.update((list) => list.map((c) =>
      c.id === id || isActive(c.stage) ? c : { ...c, options: { ...src.options, crop: c.info?.suggestedCrop ?? null } }));
  }

  async chooseOutDir() {
    const dir = await this.api.chooseDir();
    if (dir) {
      this.outDir.set(dir);
      this.persist();
    }
  }

  resetOutDir() {
    this.outDir.set(null);
    this.persist();
  }

  async start(id: string) {
    const clip = this.clips().find((c) => c.id === id);
    if (!clip?.info || isActive(clip.stage)) return;
    const jobId = await this.api.enqueue(clip.path, this.effectiveOptions(clip.options), this.outDir(), clip.segments);
    this.patch(id, {
      jobId, stage: 'queued', percent: 0, error: undefined, output: undefined, segmentStates: undefined, segmentIndex: undefined,
    });
  }

  async startAll() {
    for (const c of this.clips()) {
      if (c.info && !isActive(c.stage) && c.stage !== 'done') await this.start(c.id);
    }
  }

  cancel(id: string) {
    const clip = this.clips().find((c) => c.id === id);
    if (clip?.jobId) void this.api.cancel(clip.jobId);
  }

  async runPreview(id: string, start: number, duration: number, compare: boolean) {
    const clip = this.clips().find((c) => c.id === id);
    if (!clip?.info) return;
    const models: ModelId[] = compare ? ['realesr-animevideov3', 'realesrgan-x4plus'] : [];
    this.preview.set({ running: true, percent: 0, label: 'Подготовка…' });
    try {
      const result = await this.api.preview({ path: clip.path, start, duration, options: this.effectiveOptions(clip.options), models });
      this.preview.set({ running: false, percent: 100, label: '', result });
      void this.refreshCache();
    } catch (err) {
      const msg = messageOf(err);
      this.preview.set({ running: false, percent: 0, label: '', error: /cancel/i.test(msg) ? undefined : msg });
    }
  }

  cancelPreview() {
    void this.api.cancelPreview();
    this.preview.set({ running: false, percent: 0, label: '' });
  }

  /** Use an installed face model if the chosen one is missing (e.g. only GFPGAN was downloaded). */
  private effectiveOptions(o: ProcessOptions): ProcessOptions {
    const installed = this.tools()?.faceModels ?? [];
    if (!o.faceRestore || !installed.length || installed.includes(o.faceModel)) return o;
    return { ...o, faceModel: installed[0] };
  }

  private applyProgress(p: JobProgress) {
    const clip = this.clips().find((c) => c.jobId === p.jobId);
    if (!clip) return;
    this.patch(clip.id, {
      stage: p.stage,
      percent: p.percent,
      framesDone: p.framesDone,
      framesTotal: p.framesTotal,
      etaSec: p.etaSec,
      faces: p.faces,
      output: p.output ?? clip.output,
      error: p.stage === 'error' ? p.message : undefined,
      segmentStates: p.segments ?? clip.segmentStates,
      segmentIndex: p.segmentIndex,
    });
    if (isFinished(p.stage)) void this.refreshCache();
  }

  private patch(id: string, patch: Partial<Clip>) {
    this.clips.update((list) => list.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ options: this.defaults(), outDir: this.outDir() }));
    } catch {
      /* storage unavailable: settings just will not be remembered */
    }
  }
}

export function isActive(stage?: JobStage): boolean {
  return stage === 'queued' || stage === 'prepare' || stage === 'upscale' || stage === 'faces' || stage === 'encode'
    || stage === 'assemble';
}

export function isFinished(stage?: JobStage): boolean {
  return stage === 'done' || stage === 'error' || stage === 'cancelled';
}

function messageOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Electron prefixes errors thrown in ipcMain handlers.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
