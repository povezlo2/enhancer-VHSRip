import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { ToolsStatus } from '../shared/types';
import { FACE_MODELS } from './faces/models';

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
  cache = {
    ffmpeg: locate('ffmpeg', 'ffmpeg'),
    ffprobe: locate('ffprobe', 'ffmpeg'),
    realesrgan,
    models: realesrgan ? listModels(path.join(path.dirname(realesrgan), 'models')) : [],
    faces: facesDir(),
    binDir: binDir(),
  };
  return cache;
}

/** bin/faces with both face models present, else null. */
function facesDir(): string | null {
  const dir = path.join(binDir(), 'faces');
  const ok = Object.values(FACE_MODELS).every((f) => existsSync(path.join(dir, f)));
  return ok ? dir : null;
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
