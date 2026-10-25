import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { JobProgress, PreviewRequest, PreviewResult, ProcessOptions } from '../shared/types';
import { analyze } from './analyze';
import { originalPreview, processClip, TMP_ROOT } from './pipeline';
import { JobQueue } from './queue';
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

const queue = new JobQueue((p: JobProgress) => {
  if (p.output) allow(p.output);
  win?.webContents.send('job:progress', p);
});

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
    return analyze(file);
  });

  ipcMain.handle('job:enqueue', (_e, file: string, options: ProcessOptions, outDir: string | null) =>
    queue.enqueue(file, options, outDir));

  ipcMain.handle('job:cancel', (_e, id: string) => queue.cancel(id));

  ipcMain.handle('preview', async (_e, req: PreviewRequest): Promise<PreviewResult> => {
    previewController?.abort();
    const controller = new AbortController();
    previewController = controller;
    const dir = path.join(TMP_ROOT, 'preview');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const info = await analyze(req.path);
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
        info, options: o, output: file, signal: controller.signal, fast: true,
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
    return net.fetch(pathToFileURL(resolved).toString(), { headers: req.headers });
  });
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  queue.cancelAll();
  previewController?.abort();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => rmSync(TMP_ROOT, { recursive: true, force: true }));
