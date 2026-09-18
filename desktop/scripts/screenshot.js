// Dev helper: starts the app normally, then saves PNGs of the dashboard.
// Usage: electron scripts/screenshot.js <outPrefix> [delaySeconds] [--range=1h] [--click=#selector] [--profile=name]
// Writes <outPrefix>-top.png (status + incidents) and <outPrefix>-charts.png
// (history charts). Uses its own
// userData folder ("Netprobe Dev") so real history is untouched.

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const [out = 'screenshot', delay = '25'] = args.filter((a) => !a.startsWith('--'));
const range = (args.find((a) => a.startsWith('--range=')) || '').split('=')[1];
// --click=<selector> clicks something (e.g. a dialog button) before capturing.
const click = (args.find((a) => a.startsWith('--click=')) || '').slice('--click='.length);

// --profile=<name> uses a different data folder (e.g. a fresh one).
const profile = (args.find((a) => a.startsWith('--profile=')) || '').slice('--profile='.length) || 'Netprobe Dev';
app.setName(profile);
app.setPath('userData', path.join(app.getPath('appData'), profile));
require('../src/main/main');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(Number(delay) * 1000);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code);
  if (range) {
    await js(`[...document.querySelectorAll('#range button')].find(b => b.textContent === '${range}')?.click()`);
    await sleep(1500);
  }
  const save = async (name) => {
    const file = path.resolve(`${out}-${name}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    console.log('saved', file);
  };
  if (click) {
    await js(`document.querySelector(${JSON.stringify(click)}).click()`);
    await sleep(800);
    await save('click');
    app.exit(0);
    return;
  }
  // Grow the window to the whole page and crop each section, instead of
  // scrolling (a scroll doesn't always land before the capture).
  const [width] = win.getContentSize();
  const pageHeight = await js('document.documentElement.scrollHeight');
  win.setContentSize(width, pageHeight);
  await sleep(1500); // charts re-render for the new size
  const rects = await js(`(() => {
    const top = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top + scrollY);
    const history = top('.history-head');
    const charts = document.querySelector('.charts').getBoundingClientRect();
    return {
      top: { x: 0, y: 0, width: innerWidth, height: history - 8 },
      charts: { x: 0, y: history - 12, width: innerWidth, height: Math.min(Math.round(charts.bottom + scrollY) - history + 24, 1400) },
    };
  })()`);
  for (const [name, rect] of Object.entries(rects)) {
    const file = path.resolve(`${out}-${name}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage(rect)).toPNG());
    console.log('saved', file);
  }
  app.exit(0);
});
