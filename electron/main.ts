import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Segment } from '../shared/segments';
import type {
  AudioExportFormat, CacheInfo, JobProgress, MontageProgress, MontageRequest, PreviewRequest, PreviewResult, ProcessOptions, SceneRequest,
  VideoInfo,
} from '../shared/types';
import { analyze } from './analyze';
import { ChunkCache } from './cache';
import { serveFile } from './media';
import { AUDIO_EXT, probeAudio } from './audio';
import { audioOutput, montageOutput, renderMontage, thumbnailsFor } from './montage';
import { originalPreview, processClip, TMP_ROOT } from './pipeline';
import { proxyFor } from './proxy';
import { reversedProxyFor } from './reverse';
import { JobQueue } from './queue';
import { detectScenes } from './scenes';
import { tools } from './tools';

const DEV_URL = process.env.ENHANCER_DEV_URL; // set by `npm run dev`
const VIDEO_EXT = ['avi', 'mp4', 'mkv', 'mov', 'mpg', 'mpeg', 'wmv', 'webm', 'm4v', 'flv', 'vob', 'ts', '3gp'];

let win: BrowserWindow | null = null;

/** Files the renderer is allowed to load through media:// (picked by the user or produced by us). */
const allowedMedia = new Set<string>();
const allow = (p: string) => allowedMedia.add(path.resolve(p));

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

// Rendered fragments and editor proxies live in the user profile, so they survive restarts.
const cacheRoot = () => path.join(app.getPath('userData'), 'cache');
const proxiesDir = () => path.join(cacheRoot(), 'proxies');
const thumbsDir = () => path.join(cacheRoot(), 'thumbs');
let montageController: AbortController | null = null;
let chunkCache: ChunkCache | null = null;
const cache = () => (chunkCache ??= new ChunkCache(path.join(cacheRoot(), 'fragments')));

let queue: JobQueue;

let previewController: AbortController | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#0f1115',
    title: 'Enhancer VHSRip',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Never navigate away from the app or open new windows inside it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(__dirname, '..', '..', 'dist', 'renderer', 'browser', 'index.html'));
}

/** Analysis results per file version, so the editor's scene search and proxy don't re-run idet/cropdetect. */
const analyzed = new Map<string, Promise<VideoInfo>>();
function analyzeCached(file: string): Promise<VideoInfo> {
  const st = statSync(file);
  const key = `${path.resolve(file)}|${st.size}|${st.mtimeMs}`;
  let info = analyzed.get(key);
  if (!info) {
    info = analyze(file);
    info.catch(() => analyzed.delete(key));
    analyzed.set(key, info);
  }
  return info;
}

/** Total size and file count of everything under `dir`. */
function dirUsage(dir: string): { bytes: number; files: number } {
  if (!existsSync(dir)) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirUsage(p);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      bytes += statSync(p).size;
      files++;
    }
  }
  return { bytes, files };
}

function cacheInfo(): CacheInfo {
  const parts = [cache().info(), dirUsage(proxiesDir()), dirUsage(thumbsDir())];
  return {
    dir: cacheRoot(),
    files: parts.reduce((n, p) => n + p.files, 0),
    bytes: parts.reduce((n, p) => n + p.bytes, 0),
  };
}

function registerIpc() {
  ipcMain.handle('tools', () => tools(true));

  ipcMain.handle('dialog:openFiles', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Выберите видео',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Видео', extensions: VIDEO_EXT }, { name: 'Все файлы', extensions: ['*'] }],
    });
    res.filePaths.forEach(allow);
    return res.filePaths;
  });

  ipcMain.handle('dialog:chooseDir', async () => {
    const res = await dialog.showOpenDialog(win!, { title: 'Папка для результатов', properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('analyze', (_e, file: string) => {
    allow(file); // dropped files arrive here first
    return analyzeCached(file);
  });

  ipcMain.handle('job:enqueue', (_e, file: string, options: ProcessOptions, outDir: string | null, segments: Segment[] | null) =>
    queue.enqueue(file, options, outDir, segments));

  ipcMain.handle('scenes', async (_e, req: SceneRequest) => detectScenes(await analyzeCached(req.path), req.threshold));

  ipcMain.handle('proxy', async (_e, file: string) => {
    const proxy = await proxyFor(await analyzeCached(file), proxiesDir());
    allow(proxy);
    return proxy;
  });

  ipcMain.handle('thumbnails', async (_e, file: string) => {
    const thumbs = await thumbnailsFor(await analyzeCached(file), thumbsDir());
    thumbs.files.forEach(allow);
    return thumbs;
  });

  /** Montage render, or (with `audio`) only its sound to WAV/MP3. */
  const montageJob = async (req: MontageRequest, audio?: AudioExportFormat) => {
    montageController?.abort();
    const controller = new AbortController();
    montageController = controller;
    const target = await analyzeCached(req.owner);
    const sources = new Map<string, VideoInfo>();
    for (const p of new Set(req.clips.map((c) => c.source))) sources.set(p, await analyzeCached(p));
    const output = audio ? audioOutput(req.owner, req.outDir, audio) : montageOutput(req.owner, req.outDir, req.format);
    const send = (p: MontageProgress) => win?.webContents.send('montage:progress', p);
    try {
      await renderMontage(target, sources, req.clips, output, {
        format: req.format, crf: req.crf, overlays: req.overlays, originalAudio: req.originalAudio, audioOnly: audio,
      }, controller.signal, send);
    } finally {
      if (montageController === controller) montageController = null;
    }
    allow(output);
    send({ percent: 100, output });
    return output;
  };

  ipcMain.handle('montage:render', (_e, req: MontageRequest) => montageJob(req));
  ipcMain.handle('montage:extractAudio', (_e, req: MontageRequest, format: AudioExportFormat) =>
    montageJob(req, format === 'mp3' ? 'mp3' : 'wav'));

  ipcMain.handle('dialog:openAudio', async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Выберите звук',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Звук', extensions: AUDIO_EXT }, { name: 'Все файлы', extensions: ['*'] }],
    });
    return res.filePaths;
  });

  ipcMain.handle('audio:probe', async (_e, file: string) => {
    const info = await probeAudio(file);
    allow(file); // the player plays it in sync with the montage
    return info;
  });

  ipcMain.handle('montage:cancel', () => {
    montageController?.abort();
    montageController = null;
  });

  ipcMain.handle('proxy:reversed', async (_e, file: string) => {
    const proxy = await reversedProxyFor(await analyzeCached(file), proxiesDir());
    allow(proxy);
    return proxy;
  });

  ipcMain.handle('cache:info', () => cacheInfo());
  ipcMain.handle('cache:clear', () => {
    cache().clear();
    rmSync(proxiesDir(), { recursive: true, force: true });
    rmSync(thumbsDir(), { recursive: true, force: true });
    return cacheInfo();
  });

  ipcMain.handle('job:cancel', (_e, id: string) => queue.cancel(id));

  ipcMain.handle('preview', async (_e, req: PreviewRequest): Promise<PreviewResult> => {
    previewController?.abort();
    const controller = new AbortController();
    previewController = controller;
    const dir = path.join(TMP_ROOT, 'preview');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const info = await analyzeCached(req.path);
    const base: ProcessOptions = { ...req.options, start: req.start, duration: req.duration, crf: 18 };
    const send = (p: Omit<JobProgress, 'jobId'>, label: string) =>
      win?.webContents.send('preview:progress', { ...p, jobId: 'preview', message: label });

    const original = path.join(dir, 'original.mp4');
    send({ stage: 'prepare', percent: 0 }, 'Оригинал');
    await originalPreview(info, base, original, controller.signal);
    allow(original);

    const variants: PreviewResult['variants'] = [];
    const runs: ProcessOptions[] = base.engine === 'ffmpeg' || !req.models.length
      ? [base]
      : req.models.map((model) => ({ ...base, model, scale: model === 'realesrgan-x4plus' ? 4 : base.scale }));

    for (const [i, o] of runs.entries()) {
      const label = o.engine === 'ffmpeg' ? 'ffmpeg' : o.model;
      const file = path.join(dir, `variant-${i}-${label}.mp4`);
      const started = Date.now();
      await processClip({
        info, options: o, output: file, signal: controller.signal, fast: true, cache: cache(),
        report: (p) => send(p, `${i + 1}/${runs.length}: ${label}`),
      });
      allow(file);
      variants.push({ model: o.engine === 'ffmpeg' ? 'ffmpeg' : o.model, file, seconds: (Date.now() - started) / 1000 });
    }
    if (previewController === controller) previewController = null;
    return { original, variants };
  });

  ipcMain.handle('preview:cancel', () => {
    previewController?.abort();
    previewController = null;
  });

  ipcMain.handle('shell:showItem', (_e, file: string) => shell.showItemInFolder(file));
}

void app.whenReady().then(() => {
  protocol.handle('media', (req) => {
    const file = new URL(req.url).searchParams.get('p') ?? '';
    const resolved = path.resolve(file);
    if (!allowedMedia.has(resolved)) return new Response('forbidden', { status: 403 });
    try {
      return serveFile(resolved, req.headers.get('range'));
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  queue = new JobQueue((p: JobProgress) => {
    if (p.output) allow(p.output);
    win?.webContents.send('job:progress', p);
  }, cache());
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  queue?.cancelAll();
  montageController?.abort();
  previewController?.abort();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => rmSync(TMP_ROOT, { recursive: true, force: true }));
