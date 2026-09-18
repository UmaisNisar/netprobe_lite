// Renders the app and tray icons from SVG using Electron's own Chromium, so
// no image tooling is needed. Run with: npm run icons

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'assets');

// App icon: a gauge arc with a pulse line through it.
const appIcon = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b2130"/><stop offset="1" stop-color="#0d1017"/>
    </linearGradient>
    <linearGradient id="arc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#f25f5c"/><stop offset=".5" stop-color="#f6c343"/><stop offset="1" stop-color="#3ecf8e"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="108" fill="url(#bg)"/>
  <path d="M116 330 A150 150 0 1 1 396 330" fill="none" stroke="#2a3243" stroke-width="40" stroke-linecap="round"/>
  <path d="M116 330 A150 150 0 1 1 396 330" fill="none" stroke="url(#arc)" stroke-width="40" stroke-linecap="round"/>
  <polyline points="120,290 196,290 226,220 266,360 300,250 318,290 392,290" fill="none"
    stroke="#e8ecf4" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Tray icons: a coloured ring with the pulse line, readable at 16px.
const trayIcon = (color) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="13.5" fill="${color}"/>
  <polyline points="6,17 11,17 13.5,11 17.5,22 20,15 21.5,17 26,17" fill="none"
    stroke="#0d1017" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const jobs = [
  ['icon.png', appIcon, 512],
  ['tray-good.png', trayIcon('#3ecf8e'), 16],
  ['tray-good@2x.png', trayIcon('#3ecf8e'), 32],
  ['tray-ok.png', trayIcon('#f6c343'), 16],
  ['tray-ok@2x.png', trayIcon('#f6c343'), 32],
  ['tray-bad.png', trayIcon('#f25f5c'), 16],
  ['tray-bad@2x.png', trayIcon('#f25f5c'), 32],
  ['tray-idle.png', trayIcon('#8a94a6'), 16],
  ['tray-idle@2x.png', trayIcon('#8a94a6'), 32],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<canvas></canvas>');
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, svg, size] of jobs) {
    const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const dataUrl = await win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const c = document.querySelector('canvas');
          c.width = c.height = ${size};
          const ctx = c.getContext('2d');
          ctx.clearRect(0, 0, ${size}, ${size});
          ctx.drawImage(img, 0, 0, ${size}, ${size});
          resolve(c.toDataURL('image/png'));
        };
        img.src = ${JSON.stringify(src)};
      })`);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote', name);
  }
  app.quit();
});
