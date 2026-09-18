// Netprobe Desktop: Electron shell around the monitoring engine. Owns the
// window, tray, notifications, power events and IPC; all measuring and
// scheduling lives in monitor.js.

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, nativeImage, powerMonitor, shell } = require('electron');
const path = require('node:path');
const { Settings } = require('./settings');
const { Store } = require('./db');
const { Monitor } = require('./monitor');
const { LOCATIONS, formatDuration } = require('../renderer/lib');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
let startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let settings;
let monitor;
let win = null;
let tray = null;
let quitting = false;

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

function applyLoginItem() {
  if (!app.isPackaged) return; // Don't register the dev electron binary.
  app.setLoginItemSettings({ openAtLogin: settings.get().openAtLogin, args: ['--hidden'] });
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('get-state', () => monitor.publicState());
ipcMain.handle('get-history', (_e, rangeMs, conn) => monitor.history(rangeMs, conn));
ipcMain.handle('get-incidents', (_e, rangeMs) => monitor.incidents(rangeMs));
ipcMain.handle('save-settings', (_e, next) => {
  const before = settings.get();
  const saved = settings.set(next);
  monitor.applySettings(before, saved);
  applyLoginItem();
  return saved;
});
ipcMain.handle('probe-now', () => monitor.runProbe());
ipcMain.handle('speedtest-now', () => monitor.runSpeedtest());
ipcMain.handle('toggle-pause', () => monitor.togglePause());
ipcMain.handle('clear-history', () => monitor.clearHistory());

// ---------------------------------------------------------------- lifecycle

app.on('second-instance', showWindow);
app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', (e) => e.preventDefault()); // Keep running in tray.
app.on('activate', showWindow); // macOS dock click.

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.netprobe.desktop');
  // macOS ignores login-item args, so detect a login launch directly.
  if (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin) startHidden = true;
  const dataDir = app.getPath('userData');
  settings = new Settings(dataDir);
  monitor = new Monitor({ settings, store: new Store(dataDir) });

  monitor.on('state', (state) => {
    updateTray(state);
    broadcast(state);
  });
  monitor.on('incident', notifyIncident);

  powerMonitor.on('suspend', () => monitor.suspend());
  powerMonitor.on('resume', () => monitor.resume());

  tray = new Tray(trayIcon('idle'));
  tray.on('click', showWindow);
  updateTray(monitor.publicState());

  createWindow();
  applyLoginItem();
  monitor.start();
});

app.on('will-quit', () => {
  monitor?.stop();
  monitor?.store.close();
});
