#!/usr/bin/env node
// Downloads the external tools into ./bin (not committed to git):
//   bin/realesrgan/  realesrgan-ncnn-vulkan + models   (BSD-3, xinntao/Real-ESRGAN)
//   bin/ffmpeg/      ffmpeg + ffprobe on Windows        (GPL build, BtbN/FFmpeg-Builds)
// On Linux/macOS ffmpeg is taken from the system (apt / brew) if not present in bin/.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import extract from 'extract-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin');
const force = process.argv.includes('--force');
const platform = process.platform;

const REALESRGAN = {
  win32: 'realesrgan-ncnn-vulkan-20220424-windows.zip',
  linux: 'realesrgan-ncnn-vulkan-20220424-ubuntu.zip',
  darwin: 'realesrgan-ncnn-vulkan-20220424-macos.zip',
};
const REALESRGAN_BASE = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/';
const FFMPEG_WIN = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

const exe = (name) => (platform === 'win32' ? `${name}.exe` : name);

async function download(url, dest) {
  console.log(`↓ ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (pct >= 0 && pct % 10 === 0 && pct !== lastPct) {
      process.stdout.write(`  ${pct}%\r`);
      lastPct = pct;
    }
  }
  await writeFile(dest, Buffer.concat(chunks));
  console.log(`  ${(got / 1024 / 1024).toFixed(1)} MB`);
}

/** Find the first file with this name anywhere under dir. */
function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry === name) {
      return p;
    }
  }
  return null;
}

async function withTemp(fn) {
  const tmp = path.join(os.tmpdir(), `enhancer-setup-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    return await fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function setupRealesrgan() {
  const target = path.join(bin, 'realesrgan');
  if (!force && existsSync(path.join(target, exe('realesrgan-ncnn-vulkan')))) {
    console.log('✓ Real-ESRGAN уже установлен');
    return;
  }
  const file = REALESRGAN[platform];
  if (!file) throw new Error(`Платформа ${platform} не поддерживается Real-ESRGAN ncnn`);
  await withTemp(async (tmp) => {
    const zip = path.join(tmp, file);
    await download(REALESRGAN_BASE + file, zip);
    const out = path.join(tmp, 'x');
    await extract(zip, { dir: out });
    const binary = findFile(out, exe('realesrgan-ncnn-vulkan'));
    if (!binary) throw new Error('В архиве Real-ESRGAN не найден исполняемый файл');
    // Copy only what the app needs: the binary, its DLLs and the models.
    // The release archive also ships sample images and a demo video, which we skip.
    const srcDir = path.dirname(binary);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(srcDir)) {
      const keep = entry === exe('realesrgan-ncnn-vulkan') || entry === 'models' || /\.(dll|dylib|so(\.\d+)*)$/i.test(entry);
      if (keep) cpSync(path.join(srcDir, entry), path.join(target, entry), { recursive: true });
    }
    if (platform !== 'win32') chmodSync(path.join(target, exe('realesrgan-ncnn-vulkan')), 0o755);
  });
  console.log('✓ Real-ESRGAN →', target);
}

async function setupFfmpeg() {
  const target = path.join(bin, 'ffmpeg');
  if (!force && existsSync(path.join(target, exe('ffmpeg')))) {
    console.log('✓ ffmpeg уже установлен');
    return;
  }
  if (platform !== 'win32') {
    const found = spawnSync(platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
    if (found.status === 0) {
      console.log('✓ ffmpeg найден в системе:', found.stdout.trim());
    } else {
      console.log('! ffmpeg не найден. Установите его: sudo apt install ffmpeg  /  brew install ffmpeg');
    }
    return;
  }
  await withTemp(async (tmp) => {
    const zip = path.join(tmp, 'ffmpeg.zip');
    await download(FFMPEG_WIN, zip);
    const out = path.join(tmp, 'x');
    await extract(zip, { dir: out });
    const ffmpeg = findFile(out, 'ffmpeg.exe');
    const ffprobe = findFile(out, 'ffprobe.exe');
    if (!ffmpeg || !ffprobe) throw new Error('В архиве ffmpeg не найдены ffmpeg.exe/ffprobe.exe');
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(ffmpeg, path.join(target, 'ffmpeg.exe'));
    cpSync(ffprobe, path.join(target, 'ffprobe.exe'));
    const license = findFile(out, 'LICENSE.txt');
    if (license) cpSync(license, path.join(target, 'LICENSE.txt'));
  });
  console.log('✓ ffmpeg →', target);
}

try {
  mkdirSync(bin, { recursive: true });
  await setupRealesrgan();
  await setupFfmpeg();
  console.log('\nГотово. Запуск: npm run dev');
} catch (err) {
  console.error('\n✗ Ошибка установки:', err.message);
  process.exit(1);
}
