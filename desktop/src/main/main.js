// Netprobe Desktop: main process. Runs the probe and speed test loops in the
// background, keeps history in SQLite, and serves the dashboard window.

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path = require('node:path');
const probe = require('./probe');
const speedtest = require('./speedtest');
const { summarise } = require('./score');
const { Settings } = require('./settings');
const { Store } = require('./db');
const { detectConnection } = require('./network');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
let startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let settings;
let store;
let win = null;
let tray = null;
let quitting = false;

const state = {
  latest: null, // { ts, summary, result }
  speed: null, // { ts, download, upload }
  probing: false,
  speedtesting: false,
  lastError: null,
  speedError: null,
  paused: false,
  nextProbeAt: null,
  nextSpeedtestAt: null,
  connection: { type: 'unknown', name: null }, // wifi | wired | unknown
};

let probeTimer = null;
let speedTimer = null;

// ---------------------------------------------------------------- loops

async function runProbe() {
  if (state.probing || state.speedtesting || state.paused) return;
  state.probing = true;
  broadcast();
  try {
    const s = settings.get();
    const ts = Date.now();
    const result = await probe.collect(s);
    const summary = summarise(result, s);
    store.saveProbe(ts, result, summary);
    state.latest = { ts, summary, result };
    state.lastError = null;
  } catch (e) {
    state.lastError = String(e?.message || e);
  } finally {
    state.probing = false;
    updateTray();
    broadcast();
  }
}

function scheduleProbe(delayMs) {
  clearTimeout(probeTimer);
  const interval = settings.get().probeInterval * 1000;
  const delay = delayMs ?? interval;
  state.nextProbeAt = Date.now() + delay;
  probeTimer = setTimeout(async () => {
    await runProbe();
    scheduleProbe();
  }, delay);
}

async function runSpeedtest() {
  if (state.speedtesting) return;
  // Let an in-flight probe finish first so the two don't skew each other.
  while (state.probing) await new Promise((r) => setTimeout(r, 500));
  state.speedtesting = true;
  broadcast();
  try {
    const result = await speedtest.run();
    const ts = Date.now();
    store.saveSpeed(ts, result);
    state.speed = { ts, ...result };
    state.speedError = null;
  } catch (e) {
    state.speedError = String(e?.message || e);
  } finally {
    state.speedtesting = false;
    broadcast();
  }
}

// With no explicit delay, the next test is due one interval after the last
// one (surviving restarts), but never sooner than a minute from now.
function scheduleSpeedtest(delayMs) {
  clearTimeout(speedTimer);
  const s = settings.get();
  if (!s.speedtestEnabled || state.paused) {
    state.nextSpeedtestAt = null;
    return;
  }
  const interval = s.speedtestInterval * 1000;
  const sinceLast = state.speed ? Date.now() - state.speed.ts : Infinity;
  const delay = delayMs ?? Math.max(60_000, Math.min(interval, interval - sinceLast));
  state.nextSpeedtestAt = Date.now() + delay;
  speedTimer = setTimeout(async () => {
    await runSpeedtest();
    scheduleSpeedtest(interval);
  }, delay);
}

async function refreshConnection() {
  const next = await detectConnection();
  if (next.type === state.connection.type && next.name === state.connection.name) return;
  state.connection = next;
  updateTray();
  broadcast();
}

function prune() {
  try {
    store.prune(settings.get().retentionDays);
  } catch {
    // Pruning is best effort; it retries in an hour.
  }
}

// ---------------------------------------------------------------- UI

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
}

function publicState() {
  return { ...state, settings: settings.get() };
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

function scoreLevel(score) {
  if (score == null) return 'idle';
  if (score >= 0.8) return 'good';
  if (score >= 0.5) return 'ok';
  return 'bad';
}

function updateTray() {
  if (!tray) return;
  const sum = state.latest?.summary;
  tray.setImage(trayIcon(state.paused ? 'idle' : scoreLevel(sum?.score)));
  const lines = ['Netprobe'];
  if (state.connection.type === 'wifi') lines.push('On Wi-Fi: results include Wi-Fi issues');
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
      { label: 'Probe now', enabled: !state.paused, click: () => runProbe() },
      { label: 'Run speed test now', click: () => runSpeedtest() },
      { label: state.paused ? 'Resume monitoring' : 'Pause monitoring', click: togglePause },
      { type: 'separator' },
      { label: 'Quit Netprobe', click: () => { quitting = true; app.quit(); } },
    ])
  );
}

function togglePause() {
  state.paused = !state.paused;
  if (state.paused) {
    clearTimeout(probeTimer);
    clearTimeout(speedTimer);
    state.nextProbeAt = null;
    state.nextSpeedtestAt = null;
  } else {
    scheduleProbe(0);
    scheduleSpeedtest();
  }
  updateTray();
  broadcast();
}

function applyLoginItem() {
  if (!app.isPackaged) return; // Don't register the dev electron binary.
  app.setLoginItemSettings({ openAtLogin: settings.get().openAtLogin, args: ['--hidden'] });
}

// ---------------------------------------------------------------- IPC

ipcMain.handle('get-state', () => publicState());
ipcMain.handle('get-history', (_e, rangeMs) => store.history(Date.now() - Number(rangeMs)));
ipcMain.handle('save-settings', (_e, next) => {
  const before = settings.get();
  const saved = settings.set(next);
  if (before.probeInterval !== saved.probeInterval && !state.paused) scheduleProbe();
  if (!before.speedtestEnabled && saved.speedtestEnabled) scheduleSpeedtest(5000);
  else if (
    before.speedtestEnabled !== saved.speedtestEnabled ||
    before.speedtestInterval !== saved.speedtestInterval
  ) {
    scheduleSpeedtest();
  }
  if (before.retentionDays !== saved.retentionDays) prune();
  applyLoginItem();
  broadcast();
  return saved;
});
ipcMain.handle('probe-now', () => runProbe());
ipcMain.handle('speedtest-now', () => runSpeedtest());
ipcMain.handle('toggle-pause', () => togglePause());
ipcMain.handle('clear-history', () => {
  store.clear();
  state.latest = null;
  state.speed = null;
  updateTray();
  broadcast();
});

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
  store = new Store(dataDir);

  const speed = store.latestSpeed();
  if (speed) state.speed = speed;

  tray = new Tray(trayIcon('idle'));
  tray.on('click', showWindow);
  updateTray();

  createWindow();
  applyLoginItem();

  prune();
  setInterval(prune, 3600_000);
  refreshConnection();
  setInterval(refreshConnection, 120_000);
  scheduleProbe(1000);
  scheduleSpeedtest();
});

app.on('will-quit', () => {
  clearTimeout(probeTimer);
  clearTimeout(speedTimer);
  store?.close();
});
