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

// The file dialog returns the test clip, or the next file queued in `nextPick` (montage: «Файл с диска…»).
const nextPick = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextPick.shift() ?? path.resolve(clip)] });

// A second, different source for the multi-video montage: 16:9, 30 fps, no sound.
const second = path.join(outDir, 'smoke_second.mp4');
const made = require('node:child_process').spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'smptebars=s=320x180:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', second]);
if (made.status !== 0) throw new Error('could not create the second test clip (ffmpeg on PATH?)');
require(path.join(__dirname, '..', 'dist-electron', 'electron', 'main.js'));

const montageFiles = [];
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
const clickExact = (wc, text) => wc.executeJavaScript(`(() => {
  const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
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

    // Montage: cut out the middle, check undo/redo, render, result appears in the list.
    const key = (k, extra = {}) => wc.executeJavaScript(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key: k, ...extra })}))`);
    const clipCount = () => wc.executeJavaScript(`document.querySelectorAll('app-montage-editor .clip').length`);
    await click(wc, 'Монтаж');
    await waitFor(wc, `(document.querySelector('app-montage-editor video.active')?.readyState ?? 0) >= 2`, 60000);
    await waitFor(wc, `document.querySelectorAll('app-montage-editor .clip img').length > 0`, 60000);
    for (let i = 0; i < 3; i++) await key('ArrowRight', { shiftKey: true });
    await key('s');
    for (let i = 0; i < 2; i++) await key('ArrowRight', { shiftKey: true });
    await key('s');
    if ((await clipCount()) !== 3) throw new Error('split failed: ' + (await clipCount()));
    await wc.executeJavaScript(`(() => { const c = document.querySelectorAll('app-montage-editor .clip')[1]; const r = c.getBoundingClientRect();
      c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + r.width / 2, clientY: r.top + 5 })); })()`);
    await key('Delete');
    if ((await clipCount()) !== 2) throw new Error('delete failed');
    await key('z', { ctrlKey: true });
    if ((await clipCount()) !== 3) throw new Error('undo failed');
    await key('y', { ctrlKey: true });
    if ((await clipCount()) !== 2) throw new Error('redo failed');
    // Montage 0:03 is source 0:05 now (0:03-0:05 was cut out): the player must be there.
    const videoAt = () => wc.executeJavaScript(`document.querySelector('app-montage-editor video.active').currentTime`);
    await waitFor(wc, `Math.abs(document.querySelector('app-montage-editor video.active').currentTime - 5.02) < 0.05`, 10000);
    console.log('montage', await wc.executeJavaScript(`document.querySelector('app-montage-editor .tc').innerText`), 'source at', (await videoAt()).toFixed(2));
    // Playback jumps over the cut: from montage 2.6 s, after ~1 s we must be past source 5 s.
    for (let i = 0; i < 10; i++) await key('ArrowLeft');
    await key(' ');
    await waitFor(wc, `document.querySelector('app-montage-editor video.active').currentTime > 5.1`, 10000);
    await key(' ');
    console.log('played across the cut, source at', (await videoAt()).toFixed(2));
    // Second video from disk, appended after the selected clip (the last one).
    nextPick.push(second);
    await click(wc, '+ Видео');
    await click(wc, 'Файл с диска');
    await waitFor(wc, `document.querySelectorAll('app-montage-editor .clip').length === 3 && document.querySelectorAll('app-montage-editor video').length === 2`, 60000);
    // Crossfade on the first join.
    await wc.executeJavaScript(`document.querySelector('app-montage-editor .join').click()`);
    await click(wc, 'Растворение');
    await waitFor(wc, `!!document.querySelector('app-montage-editor .join.set')`, 5000);
    const shownSeconds = await wc.executeJavaScript(`document.querySelector('app-montage-editor .panel select').value`);
    if (shownSeconds !== '0.5') throw new Error('transition length shown as ' + shownSeconds);
    // Playback hands over to the second video's player at the last join.
    await key('End');
    await waitFor(wc, `document.querySelector('app-montage-editor video.active')?.dataset.key?.endsWith('smoke_second.mp4')`, 10000);
    console.log('montage', await wc.executeJavaScript(`document.querySelector('app-montage-editor .tc').innerText`), '3 clips, 2 sources, transition set');
    await key('Home');
    await sleep(600);
    await shot(win, '2b-montage.png');

    // MP4 export.
    await clickExact(wc, 'MP4');
    await click(wc, 'Смонтировать');
    await waitFor(wc, `!!document.querySelector('app-montage-editor .done')`, 120000);
    await waitFor(wc, `document.querySelectorAll('.clips li').length === 2 && !!document.querySelector('.clip-badge')`, 60000);
    await sleep(800);
    await shot(win, '2c-montage-done.png');
    const montageName = await wc.executeJavaScript(`document.querySelector('app-montage-editor .done code').innerText`);
    console.log('montage result', montageName);
    if (!montageName.endsWith('.mp4')) throw new Error('expected an MP4 result');
    montageFiles.push(path.join(path.dirname(path.resolve(clip)), montageName));

    // Saved between runs: reload the window, continue from the start screen.
    wc.reload();
    await new Promise((r) => wc.once('did-finish-load', r));
    await waitFor(wc, `document.body.innerText.includes('Продолжить монтаж')`, 15000);
    await shot(win, '2d-continue.png');
    await wc.executeJavaScript(`document.querySelector('.recent-open').click()`);
    await waitFor(wc, `document.querySelectorAll('app-montage-editor .clip').length === 3 && !!document.querySelector('app-montage-editor .notice') && !!document.querySelector('app-montage-editor .join.set')`, 60000);
    console.log('montage restored after reload: 3 clips, transition kept');

    // Reverse the whole montage (nothing selected): order flips, every clip plays backwards.
    await click(wc, '⇄ Реверс');
    await waitFor(wc, `document.querySelectorAll('app-montage-editor .clip .rev').length === 3`, 5000);
    await waitFor(wc, `document.querySelectorAll('app-montage-editor video[data-key^="rev:"]').length === 2`, 120000);
    const firstLabel = await wc.executeJavaScript(`document.querySelector('app-montage-editor .clip .src').innerText`);
    if (firstLabel !== 'smoke_second.mp4') throw new Error('reverse did not flip the order: ' + firstLabel);
    await key('Home');
    await waitFor(wc, `document.querySelector('app-montage-editor video.active')?.dataset.key?.startsWith('rev:')`, 10000);
    await key(' ');
    await sleep(1200);
    await key(' ');
    await waitFor(wc, `document.querySelector('app-montage-editor video.active').paused && document.querySelector('app-montage-editor .play').innerText.trim() === '▶'`, 5000);
    console.log('reversed montage plays from the backwards copy:', await wc.executeJavaScript(`document.querySelector('app-montage-editor .tc').innerText`));
    await shot(win, '2e-reversed.png');
    await clickExact(wc, 'Без потерь (MKV)');
    await click(wc, 'Смонтировать');
    await waitFor(wc, `document.querySelector('app-montage-editor .done code')?.innerText.endsWith('.mkv')`, 180000);
    const reversedName = await wc.executeJavaScript(`document.querySelector('app-montage-editor .done code').innerText`);
    console.log('reversed montage result', reversedName);
    montageFiles.push(path.join(path.dirname(path.resolve(clip)), reversedName));

    // Sound: extract it (for translation), lay a "translated" voice back over the picture.
    await clickExact(wc, 'MP3');
    await waitFor(wc, `document.body.innerText.includes('Звук сохранён')`, 120000);
    const audioName = await wc.executeJavaScript(`[...document.querySelectorAll('app-montage-editor .done code')].map(c => c.innerText).find(n => n.includes('_audio'))`);
    if (!audioName?.endsWith('_audio.mp3')) throw new Error('unexpected extracted sound: ' + audioName);
    montageFiles.push(path.join(path.dirname(path.resolve(clip)), audioName));
    console.log('sound extracted', audioName);
    const voice = path.join(outDir, 'smoke_voice.wav');
    const madeVoice = require('node:child_process').spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=f=660:d=3', voice]);
    if (madeVoice.status !== 0) throw new Error('could not create the test voice track');
    await key('Home');
    nextPick.push(voice);
    await click(wc, '+ Наложить аудио');
    await waitFor(wc, `!!document.querySelector('app-montage-editor .aclip') && !!document.querySelector('app-montage-editor audio')`, 15000);
    // The first overlay turns the original down.
    await waitFor(wc, `[...document.querySelectorAll('app-montage-editor .sound .seg button')].find(b => b.classList.contains('on'))?.innerText.startsWith('Тише')`, 5000);
    await wc.executeJavaScript(`(() => { const c = document.querySelector('app-montage-editor .aclip'); const r = c.getBoundingClientRect();
      c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 }));
      c.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: r.left + 5, clientY: r.top + 5 })); })()`);
    await click(wc, '+0.1 с');
    await waitFor(wc, `document.querySelector('app-montage-editor .panel .mono')?.innerText.startsWith('с 0:00.12')`, 5000);
    await key(' ');
    await waitFor(wc, `!document.querySelector('app-montage-editor audio').paused`, 5000);
    await sleep(500);
    await key(' ');
    await waitFor(wc, `document.querySelector('app-montage-editor audio').paused`, 5000);
    console.log('overlay plays in sync with the picture');
    await shot(win, '2f-sound.png');
    await clickExact(wc, 'MP4');
    await click(wc, 'Смонтировать');
    await waitFor(wc, `[...document.querySelectorAll('app-montage-editor .done code')].some(c => c.innerText.endsWith('.mp4') && c.innerText.includes('(2)'))`, 180000);
    const dubbedName = await wc.executeJavaScript(`[...document.querySelectorAll('app-montage-editor .done code')].map(c => c.innerText).find(n => n.includes('(2)'))`);
    montageFiles.push(path.join(path.dirname(path.resolve(clip)), dubbedName));
    console.log('dubbed montage', dubbedName);
    await click(wc, 'Настройки');

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

    await clickExact(wc, 'Обработать'); // this clip only, not «Обработать все»
    await waitFor(wc, `document.body.innerText.includes('Готово:')`, 180000);
    await sleep(300);
    await shot(win, '5-done.png');
    await click(wc, 'Фрагменты');
    await sleep(500);
    console.log('states', await wc.executeJavaScript(`[...document.querySelectorAll('.timeline .block')].map(b => b.dataset.state).join(',')`));
    await shot(win, '6-fragments-done.png');
    for (const f of montageFiles) fs.rmSync(f, { force: true });
    console.log('SMOKE OK');
    app.exit(0);
  } catch (err) {
    console.error('SMOKE FAILED', err);
    const win = BrowserWindow.getAllWindows()[0];
    if (win) await shot(win, 'failure.png').catch(() => {});
    app.exit(1);
  }
});
