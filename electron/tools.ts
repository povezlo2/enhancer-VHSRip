import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { FaceModelId, ToolsStatus } from '../shared/types';
import { FACE_DETECTOR, FACE_RESTORERS } from './faces/models';

const EXE = process.platform === 'win32' ? '.exe' : '';

/** bin/ next to the project in dev, inside resources/ in a packaged app. */
export function binDir(): string {
  const packaged = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    process.env.ENHANCER_BIN_DIR,
    packaged ? path.join(packaged, 'bin') : undefined,
    path.resolve(__dirname, '..', '..', 'bin'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];
}

function fromPath(name: string): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(finder, [name], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) return null;
  const first = res.stdout.split(/\r?\n/).find((l) => l.trim());
  return first?.trim() ?? null;
}

function locate(name: string, ...subdirs: string[]): string | null {
  const dir = binDir();
  for (const sub of ['', ...subdirs]) {
    const p = path.join(dir, sub, name + EXE);
    if (existsSync(p)) return p;
  }
  return fromPath(name);
}

let cache: ToolsStatus | null = null;

export function tools(refresh = false): ToolsStatus {
  if (cache && !refresh) return cache;
  const realesrgan = locate('realesrgan-ncnn-vulkan', 'realesrgan');
  const faceModels = installedFaceModels();
  cache = {
    ffmpeg: locate('ffmpeg', 'ffmpeg'),
    ffprobe: locate('ffprobe', 'ffmpeg'),
    realesrgan,
    models: realesrgan ? listModels(path.join(path.dirname(realesrgan), 'models')) : [],
    faces: faceModels.length ? facesRoot() : null,
    faceModels,
    binDir: binDir(),
  };
  return cache;
}

const facesRoot = () => path.join(binDir(), 'faces');

/** Restorers usable right now: the detector plus that restorer's model are in bin/faces. */
function installedFaceModels(): FaceModelId[] {
  const dir = facesRoot();
  if (!existsSync(path.join(dir, FACE_DETECTOR))) return [];
  return (Object.keys(FACE_RESTORERS) as FaceModelId[]).filter((id) => existsSync(path.join(dir, FACE_RESTORERS[id])));
}

export function modelsDir(): string | null {
  const r = tools().realesrgan;
  return r ? path.join(path.dirname(r), 'models') : null;
}

function listModels(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const names = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.param')) names.add(f.replace(/\.param$/, '').replace(/-x[234]$/, ''));
  }
  return [...names].sort();
}

export function requireTool(key: 'ffmpeg' | 'ffprobe' | 'realesrgan'): string {
  const p = tools()[key];
  if (!p) {
    const names = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', realesrgan: 'realesrgan-ncnn-vulkan' };
    throw new Error(`Не найден ${names[key]}. Запустите «npm run setup» в папке проекта.`);
  }
  return p;
}
