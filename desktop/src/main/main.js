// Netprobe Desktop: Electron shell around the monitoring engine. Owns the
// window, tray, notifications, power events and IPC; all measuring and
// scheduling lives in monitor.js.

const { app, BrowserWindow, Tray, Menu, Notification, dialog, ipcMain, nativeImage, powerMonitor, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const report = require('./report');
const { createServer, lanAddresses } = require('./server');
const lock = require('./lock');
const { Updater } = require('./updater');
const { Settings } = require('./settings');
const { Store } = require('./db');
const { Monitor } = require('./monitor');
const { LOCATIONS, formatDuration } = require('../renderer/lib');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
let startHidden = process.argv.includes('--hidden');
// --headless: no window or tray, just monitoring + the web dashboard (for
// running the packaged app as a background service).
const headless = process.argv.includes('--headless');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let settings;
let monitor;
let win = null;
let tray = null;
let quitting = false;
let server = null;
let heldLock = null;
let updater = null;
let updateState = null;
const notifiedVersions = new Set();

// ---------------------------------------------------------------- UI

function broadcast(state) {
  if (win && !win.isDestroyed()) win.webContents.send('state', state);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 500,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Netprobe',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });
  // Closing the window keeps monitoring in the tray.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function trayIcon(level) {
  return nativeImage.createFromPath(path.join(ASSETS, `tray-${level}.png`));
}

function scoreLevel(state) {
  if (state.paused || state.sleeping) return 'idle';
  if (state.incident?.kind === 'outage') return 'bad';
  const score = state.latest?.summary.score;
  if (score == null) return 'idle';
  if (score >= 0.8) return 'good';
  if (score >= 0.5) return 'ok';
  return 'bad';
}

function updateTray(state) {
  if (!tray) return;
  const sum = state.latest?.summary;
  tray.setImage(trayIcon(scoreLevel(state)));
  const lines = ['Netprobe'];
  if (state.incident) lines.push(`${state.incident.kind === 'outage' ? 'Outage' : 'Degraded'} in progress`);
  if (state.connection.type === 'wifi') lines.push('On Wi-Fi: results include Wi-Fi issues');
  if (state.connection.type === 'vpn') lines.push('VPN active: measuring the VPN path');
  if (state.paused) lines.push('Paused');
  else if (sum) {
    lines.push(`Score ${Math.round(sum.score * 100)}%`);
    if (sum.latency != null) lines.push(`Latency ${sum.latency.toFixed(1)} ms`);
    lines.push(`Loss ${sum.loss?.toFixed(1) ?? '–'}%`);
  } else lines.push('Waiting for first probe…');
  tray.setToolTip(lines.join('\n'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open dashboard', click: showWindow },
      { type: 'separator' },
      { label: 'Probe now', enabled: !state.paused, click: () => monitor.runProbe() },
      { label: 'Run speed test now', click: () => monitor.runSpeedtest() },
      { label: state.paused ? 'Resume monitoring' : 'Pause monitoring', click: () => monitor.togglePause() },
      ...updateMenu(),
      { type: 'separator' },
      { label: 'Quit Netprobe', click: () => { quitting = true; app.quit(); } },
    ])
  );
}

// ---------------------------------------------------------------- alerts

function notifyIncident({ type, incident }) {
  if (!settings.get().alerts.notify || !Notification.isSupported()) return;
  const what = incident.kind === 'outage' ? 'Internet outage' : 'Connection degraded';
  const where = incident.where ? `Likely cause: ${LOCATIONS[incident.where]}.` : '';
  const n =
    type === 'start'
      ? new Notification({ title: what, body: [`Started ${new Date(incident.start).toLocaleTimeString()}.`, where].join(' ') })
      : new Notification({
          title: incident.kind === 'outage' ? 'Back online' : 'Connection recovered',
          body: `${what} lasted ${formatDuration(incident.end - incident.start)}. ${where}`.trim(),
        });
  n.on('click', showWindow);
  n.show();
}

// ---------------------------------------------------------------- updates

function updateMenu() {
  if (updateState?.status === 'ready') return [{ type: 'separator' }, { label: `Restart to update to ${updateState.version}`, click: installUpdate }];
  if (updateState?.status === 'available') {
    return [{ type: 'separator' }, { label: `Download Netprobe ${updateState.version}`, click: () => shell.openExternal(updateState.url) }];
  }
  return [];
}

function installUpdate() {
  quitting = true;
  updater?.install();
}

function applyUpdater() {
  const want = app.isPackaged && settings.get().autoUpdate;
  if (want && !updater) {
    updater = new Updater({ currentVersion: app.getVersion() });
    updater.on('state', (s) => {
      updateState = s;
      if ((s.status === 'ready' || s.status === 'available') && !notifiedVersions.has(s.version) && Notification.isSupported()) {
        notifiedVersions.add(s.version);
        const n = new Notification({
          title: s.status === 'ready' ? `Netprobe ${s.version} is ready` : `Netprobe ${s.version} is available`,
          body: s.status === 'ready' ? 'Restart Netprobe to finish updating.' : 'Click to download the new version.',
        });
        n.on('click', () => (s.status === 'ready' ? showWindow() : shell.openExternal(s.url)));
        n.show();
      }
      monitor.emit('state', monitor.publicState());
    });
    updater.start();
  } else if (!want && updater) {
    updater.stop();
    updater = null;
    updateState = null;
  }
}

// ---------------------------------------------------------------- web server

function saveSettings(next) {
  const before = settings.get();
  const saved = settings.set(next);
  monitor.applySettings(before, saved);
  applyLoginItem();
  applyUpdater();
  const changed = ['enabled', 'port', 'lan', 'token'].some((k) => before.server[k] !== saved.server[k]);
  if (changed) applyServer();
  return saved;
}

// (Re)starts or stops the web server to match settings. Headless mode always
// runs it.
function applyServer() {
  const cfg = settings.get().server;
  if (server) {
    server.close();
    server = null;
  }
  monitor.serverInfo = null;
  if (!cfg.enabled && !headless) return monitor.emit('state', monitor.publicState());
  const host = cfg.lan ? '0.0.0.0' : '127.0.0.1';
  server = createServer({ monitor, saveSettings, token: cfg.token || null, log: (m) => console.error(m) });
  server.on('error', (e) => {
    monitor.serverInfo = { error: e.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use.` : e.message };
    monitor.emit('state', monitor.publicState());
  });
  server.listen(cfg.port, host, () => {
    const hosts = cfg.lan ? ['localhost', ...lanAddresses()] : ['localhost'];
    monitor.serverInfo = { urls: hosts.map((h) => `http://${h}:${cfg.port}/`), lan: cfg.lan };
    monitor.emit('state', monitor.publicState());
  });
}

function applyLoginItem() {
  if (!app.isPackaged) return; // Don't register the dev electron binary.
  app.setLoginItemSettings({ openAtLogin: settings.get().openAtLogin, args: ['--hidden'] });
}

// ---------------------------------------------------------------- export

const stamp = (ts) => new Date(ts).toISOString().slice(0, 10);

async function renderPdf(data) {
  const page = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await page.loadFile(path.join(__dirname, '..', 'renderer', 'report.html'));
    await page.webContents.executeJavaScript(`window.renderReport(${JSON.stringify(data)})`);
    return await page.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  } finally {
    page.destroy();
  }
}

// Returns the saved file paths, or null if the user cancelled.
async function exportReport({ from, to, format }) {
  const s = settings.get();
  from = Number(from);
  to = Number(to);
  if (!(to > from)) throw new Error('The end of the period must be after its start.');
  const base = `netprobe-${stamp(from)}-to-${stamp(to)}`;
  if (format === 'csv') {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export measurements as CSV',
      defaultPath: path.join(app.getPath('documents'), `${base}-probes.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    const stem = filePath.replace(/(-probes)?\.csv$/i, '');
    const files = [
      [`${stem}-probes.csv`, report.probesCsv(monitor.store.runsBetween(from, to))],
      [`${stem}-incidents.csv`, report.incidentsCsv(monitor.store.incidentsBetween(from, to))],
      [`${stem}-speedtests.csv`, report.speedCsv(monitor.store.speedBetween(from, to))],
    ];
    const BOM = String.fromCharCode(0xfeff); // so Excel reads the files as UTF-8
    for (const [file, body] of files) fs.writeFileSync(file, BOM + body);
    shell.showItemInFolder(files[0][0]);
    return files.map((f) => f[0]);
  }
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save report as PDF',
    defaultPath: path.join(app.getPath('documents'), `${base}-report.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  const pdf = await renderPdf(report.buildReport(monitor.store, { from, to, settings: s }));
  fs.writeFileSync(filePath, pdf);
  shell.openPath(filePath);
  return [filePath];
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('get-state', () => monitor.publicState());
ipcMain.handle('get-history', (_e, rangeMs, conn) => monitor.history(rangeMs, conn));
ipcMain.handle('get-incidents', (_e, rangeMs) => monitor.incidents(rangeMs));
ipcMain.handle('save-settings', (_e, next) => saveSettings(next));
ipcMain.handle('probe-now', () => monitor.runProbe());
ipcMain.handle('speedtest-now', () => monitor.runSpeedtest());
ipcMain.handle('toggle-pause', () => monitor.togglePause());
ipcMain.handle('clear-history', () => monitor.clearHistory());
ipcMain.handle('export-report', (_e, opts) => exportReport(opts));
ipcMain.handle('install-update', () => installUpdate());
ipcMain.handle('open-update', () => updateState?.url && shell.openExternal(updateState.url));

// ---------------------------------------------------------------- lifecycle

app.on('second-instance', () => {
  if (!headless) showWindow();
});
app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', (e) => e.preventDefault()); // Keep running in tray.
app.on('activate', showWindow); // macOS dock click.

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.netprobe.desktop');
  // macOS ignores login-item args, so detect a login launch directly.
  if (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin) startHidden = true;
  const dataDir = app.getPath('userData');
  try {
    heldLock = lock.acquire(dataDir);
  } catch (e) {
    if (e.code !== 'ELOCKED') throw e;
    dialog.showErrorBox('Netprobe is already running', `${e.message}\n\nIf Netprobe is running as a background service, open its web dashboard instead.`);
    app.exit(1);
    return;
  }
  settings = new Settings(dataDir);
  monitor = new Monitor({ settings, store: new Store(dataDir) });

  // The web server's URLs ride along with the state for the Settings screen.
  const publicState = monitor.publicState.bind(monitor);
  monitor.publicState = () => ({ ...publicState(), server: monitor.serverInfo ?? null, update: updateState, version: app.getVersion() });

  monitor.on('state', (state) => {
    updateTray(state);
    broadcast(state);
  });
  monitor.on('incident', notifyIncident);

  powerMonitor.on('suspend', () => monitor.suspend());
  powerMonitor.on('resume', () => monitor.resume());

  if (!headless) {
    tray = new Tray(trayIcon('idle'));
    tray.on('click', showWindow);
    updateTray(monitor.publicState());
    createWindow();
    applyLoginItem();
  }
  applyServer();
  applyUpdater();
  monitor.start();
});

app.on('will-quit', () => {
  updater?.stop();
  server?.close();
  monitor?.stop();
  monitor?.store.close();
  heldLock?.release();
});
