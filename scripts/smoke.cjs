// Dev-only smoke test: launches the real Electron app, stubs the file dialog with a test clip,
// clicks through the UI and saves screenshots.
// Usage: npm run build && npx electron scripts/smoke.cjs <clip> <outDir>
// (Linux CI / containers: xvfb-run -a npx electron --no-sandbox scripts/smoke.cjs <clip> <outDir>)
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [clip, outDir] = process.argv.slice(-2);
if (!clip || !fs.existsSync(clip)) {
  console.error('usage: electron scripts/smoke.cjs <clip> <outDir>');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
// Fresh profile: no cached fragments or saved settings from earlier runs.
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'enhancer-smoke-')));

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.resolve(clip)] });
require(path.join(__dirname, '..', 'dist-electron', 'electron', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(wc, expr, timeout = 120000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (await wc.executeJavaScript(expr)) return;
    await sleep(300);
  }
  throw new Error('timeout waiting for: ' + expr);
}

async function shot(win, name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name), img.toPNG());
  console.log('screenshot', name);
}

const click = (wc, text) => wc.executeJavaScript(`(() => {
  const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}));
  if (!b) return false; b.click(); return true; })()`);

app.whenReady().then(async () => {
  try {
    await sleep(500);
    const win = BrowserWindow.getAllWindows()[0];
    const wc = win.webContents;
    if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
    await sleep(800);
    console.log('tools', JSON.stringify(await wc.executeJavaScript('window.enhancer.tools()')));
    await shot(win, '1-empty.png');

    await click(wc, '+ Добавить видео');
    await waitFor(wc, `!!document.querySelector('app-settings-panel')`);
    await sleep(400);
    await shot(win, '2-settings.png');

    // Fast engine so everything finishes quickly without a GPU.
    await click(wc, 'Быстро (ffmpeg)');

    // Fragment editor: playable proxy, scene detection, timeline.
    await click(wc, 'Фрагменты');
    await waitFor(wc, `(document.querySelector('app-segment-editor video')?.readyState ?? 0) >= 2`, 60000);
    await click(wc, 'Нарезать по сценам');
    await waitFor(wc, `!document.body.innerText.includes('Автоматически:') && document.querySelectorAll('.timeline .block').length >= 2`, 60000);
    console.log('fragments', await wc.executeJavaScript(`document.querySelectorAll('.timeline .block').length`));
    await sleep(400);
    await shot(win, '3-fragments.png');

    await click(wc, 'Превью');
    await sleep(300);
    await click(wc, 'Сделать превью');
    await waitFor(wc, `document.querySelectorAll('video').length >= 2`);
    await waitFor(wc, `[...document.querySelectorAll('video')].every(v => v.readyState >= 2)`, 30000);
    await shot(win, '3b-preview.png');

    await click(wc, 'Шторка');
    await sleep(800);
    await shot(win, '4-wipe.png');

    await click(wc, 'Обработать');
    await waitFor(wc, `document.body.innerText.includes('Готово:')`, 180000);
    await sleep(300);
    await shot(win, '5-done.png');
    await click(wc, 'Фрагменты');
    await sleep(500);
    console.log('states', await wc.executeJavaScript(`[...document.querySelectorAll('.timeline .block')].map(b => b.dataset.state).join(',')`));
    await shot(win, '6-fragments-done.png');
    console.log('SMOKE OK');
    app.exit(0);
  } catch (err) {
    console.error('SMOKE FAILED', err);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) await shot(win, 'failure.png').catch(() => {});
    app.exit(1);
  }
});
