/**
 * Face restoration worker. Runs as a separate process (Electron with ELECTRON_RUN_AS_NODE=1,
 * or plain node) so heavy work never blocks the app window.
 *
 *   faces-cli --dir <frames> --models <dir> [--strength 0.6] [--min 48] [--providers dml,cpu]
 *
 * Processes every PNG in --dir in place. Writes progress lines to stdout:
 *   provider <name> | progress <done> <total> <faces> | done <frames> <faces>
 */
import { readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { estimateSimilarity, faceScale, pasteFace, warpFace } from './align';
import { Gfpgan } from './gfpgan';
import type { RgbImage } from './image';
import { FACE_MODELS } from './models';
import { YuNet } from './yunet';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

async function loadModels(dir: string, wanted: string[]) {
  // Try providers in order (DirectML first on Windows), fall back to CPU if a GPU provider fails.
  const chains = wanted.includes('cpu') && wanted.length > 1 ? [wanted, ['cpu']] : [wanted];
  let lastErr: unknown;
  for (const providers of chains) {
    try {
      const detector = await YuNet.load(path.join(dir, FACE_MODELS.detector), ['cpu']); // tiny model, CPU is fastest
      const restorer = await Gfpgan.load(path.join(dir, FACE_MODELS.restorer), providers);
      return { detector, restorer, provider: providers[0] };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function main() {
  const dir = arg('dir');
  const strength = Math.min(1, Math.max(0, Number(arg('strength', '0.6'))));
  const minSize = Number(arg('min', '48'));
  const defaultProviders = process.platform === 'win32' ? 'dml,cpu' : 'cpu';
  const providers = arg('providers', defaultProviders).split(',').map((p) => p.trim()).filter(Boolean);

  const { detector, restorer, provider } = await loadModels(arg('models'), providers);
  console.log(`provider ${provider}`);

  sharp.concurrency(1);
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  let totalFaces = 0;

  for (const [i, name] of files.entries()) {
    const file = path.join(dir, name);
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const frame: RgbImage = { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };

    const faces = (await detector.detect(frame)).filter((f) => Math.min(f.w, f.h) >= minSize);
    for (const f of faces) {
      const m = estimateSimilarity(f.kps);
      if (faceScale(m) < minSize) continue;
      const crop = warpFace(frame, m);
      const restored = await restorer.restore(crop);
      pasteFace(frame, restored, m, strength);
    }

    if (faces.length) {
      const tmp = `${file}.tmp.png`;
      await sharp(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length), {
        raw: { width: frame.width, height: frame.height, channels: 3 },
      }).png({ compressionLevel: 1 }).toFile(tmp);
      renameSync(tmp, file);
    }
    totalFaces += faces.length;
    console.log(`progress ${i + 1} ${files.length} ${totalFaces}`);
  }
  console.log(`done ${files.length} ${totalFaces}`);
}

main().catch((err) => {
  console.error(`error ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
