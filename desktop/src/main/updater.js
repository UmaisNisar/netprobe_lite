// Keeps installed copies up to date from GitHub Releases.
//
// - Windows installer and Linux AppImage: electron-updater downloads the
//   new version in the background and installs it on restart.
// - macOS (unsigned apps can't self-update) and the Windows portable exe:
//   check the latest release and offer a link to download it.
//
// Only runs in packaged builds; checks at start-up and every 6 hours.

const { EventEmitter } = require('node:events');

const REPO = 'UmaisNisar/netprobe_lite';
const FEED = `https://github.com/${REPO}/releases/latest/download`;
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 6 * 3600_000;

// "desktop-v1.2.3" / "v1.2.3" / "1.2.3" -> [1, 2, 3] (pre-release suffix ignored)
function parseVersion(tag) {
  const m = String(tag ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// 'auto' when electron-updater can install in place, otherwise 'notify'.
function updateMode(platform, env) {
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_DIR ? 'notify' : 'auto';
  if (platform === 'linux') return env.APPIMAGE ? 'auto' : 'notify';
  return 'notify'; // macOS: unsigned builds can't use Squirrel.Mac
}

class Updater extends EventEmitter {
  constructor({ currentVersion, platform = process.platform, env = process.env, deps = {} }) {
    super();
    this.currentVersion = currentVersion;
    this.mode = updateMode(platform, env);
    this.deps = {
      fetch: (...a) => fetch(...a),
      loadAutoUpdater: () => require('electron-updater').autoUpdater,
      setInterval,
      clearInterval,
      ...deps,
    };
    // status: idle | checking | downloading | ready | available | error
    this.state = { status: 'idle', version: null, url: RELEASES, mode: this.mode, error: null };
    this.timer = null;
  }

  #set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  start() {
    if (this.mode === 'auto') {
      const au = this.deps.loadAutoUpdater();
      au.setFeedURL({ provider: 'generic', url: FEED });
      au.autoDownload = true;
      au.autoInstallOnAppQuit = true;
      au.on('checking-for-update', () => this.#set({ status: 'checking', error: null }));
      au.on('update-available', (i) => this.#set({ status: 'downloading', version: i.version }));
      au.on('update-not-available', () => this.#set({ status: 'idle' }));
      au.on('update-downloaded', (i) => this.#set({ status: 'ready', version: i.version }));
      au.on('error', (e) => this.#set({ status: 'error', error: String(e?.message || e).split('\n')[0] }));
      this.autoUpdater = au;
    }
    this.check();
    this.timer = this.deps.setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  stop() {
    this.deps.clearInterval(this.timer);
  }

  async check() {
    if (this.state.status === 'ready' || this.state.status === 'downloading') return;
    if (this.autoUpdater) {
      try {
        await this.autoUpdater.checkForUpdates();
      } catch (e) {
        this.#set({ status: 'error', error: String(e?.message || e).split('\n')[0] });
      }
      return;
    }
    this.#set({ status: 'checking', error: null });
    try {
      const res = await this.deps.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Netprobe-Desktop' },
      });
      if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
      const rel = await res.json();
      if (isNewer(rel.tag_name, this.currentVersion)) {
        this.#set({ status: 'available', version: parseVersion(rel.tag_name).join('.'), url: rel.html_url || RELEASES });
      } else this.#set({ status: 'idle' });
    } catch (e) {
      this.#set({ status: 'error', error: String(e?.message || e) });
    }
  }

  // Restart into the downloaded version (auto mode only).
  install() {
    if (this.state.status === 'ready') this.autoUpdater?.quitAndInstall(false, true);
  }
}

module.exports = { Updater, parseVersion, isNewer, updateMode, FEED, RELEASES, CHECK_EVERY_MS };
