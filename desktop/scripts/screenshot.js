// Dev helper: starts the app normally, then saves PNGs of the dashboard.
// Usage: electron scripts/screenshot.js <outPrefix> [delaySeconds] [--range=1h] [--click=#selector] [--profile=name]
// Writes <outPrefix>-top.png and <outPrefix>-charts.png. Uses its own
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
  await js('window.scrollTo(0, 0)');
  await sleep(300);
  await save('top');
  await js(`document.querySelector('.history-head').scrollIntoView()`);
  await sleep(800);
  await save('charts');
  app.exit(0);
});
