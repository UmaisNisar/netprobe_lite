// Always-on mode plumbing: the data-folder lock, the headless CLI, and the
// updater's version logic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const lock = require('../src/main/lock');
const cli = require('../src/cli');
const { Updater, parseVersion, isNewer, updateMode, FEED, CHECK_EVERY_MS } = require('../src/main/updater');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-svc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ------------------------------------------------------------ lock

test('lock: one owner per data folder', (t) => {
  const dir = tempDir(t);
  const a = lock.acquire(dir, 111);
  const saved = lock.deps.alive;
  lock.deps.alive = (pid) => pid === 111;
  try {
    assert.throws(() => lock.acquire(dir, 222), (e) => e.code === 'ELOCKED' && e.owner === 111 && /already running/.test(e.message));
    a.release();
    const b = lock.acquire(dir, 222);
    assert.strictEqual(fs.readFileSync(b.file, 'utf8'), '222');
    b.release();
    assert.ok(!fs.existsSync(b.file));
  } finally {
    lock.deps.alive = saved;
  }
});

test('lock: a stale lock from a dead process is taken over', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'netprobe.lock'), '999999');
  const saved = lock.deps.alive;
  lock.deps.alive = () => false;
  try {
    const l = lock.acquire(dir, 333);
    assert.strictEqual(fs.readFileSync(l.file, 'utf8'), '333');
    l.release();
  } finally {
    lock.deps.alive = saved;
  }
});

test('lock: releasing does not remove someone else\'s lock', (t) => {
  const dir = tempDir(t);
  const l = lock.acquire(dir, 444);
  fs.writeFileSync(l.file, '555'); // taken over meanwhile
  l.release();
  assert.strictEqual(fs.readFileSync(l.file, 'utf8'), '555');
});

test('lock: the real liveness check sees this process', () => {
  assert.strictEqual(lock.deps.alive(process.pid), true);
  assert.strictEqual(lock.deps.alive(2 ** 31 - 2), false);
});

// ------------------------------------------------------------ CLI

test('cli: --help prints usage and starts nothing', (t) => {
  const out = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => (out.push(s), true);
  t.after(() => (process.stdout.write = write));
  assert.strictEqual(cli.main(['--help']), null);
  process.stdout.write = write;
  assert.match(out.join(''), /--port <n>[\s\S]*--token <t>/);
});

test('cli: rejects a bad port before touching the data folder', () => {
  assert.throws(() => cli.main(['--port', '70000', '--data', path.join(os.tmpdir(), 'np-never-created')]), /Invalid --port/);
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'np-never-created')));
});

test('cli: default data folder matches the desktop app', () => {
  const d = cli.defaultDataDir();
  assert.ok(d.endsWith('Netprobe'), d);
});

test('cli: runs the monitor and web server, then stops cleanly', async (t) => {
  const dir = tempDir(t);
  const exit = process.exit;
  const exits = [];
  process.exit = (c) => exits.push(c);
  t.after(() => (process.exit = exit));
  const log = console.log;
  console.log = () => {};
  t.after(() => (console.log = log));
  const svc = cli.main(['--port', '0', '--data', dir]);
  // Don't actually probe the network in a unit test.
  svc.monitor.stop();
  await new Promise((r) => (svc.server.listening ? r() : svc.server.once('listening', r)));
  const port = svc.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/state`);
  assert.strictEqual(res.status, 200);
  // A second process (different PID) can't use the same data folder.
  assert.throws(() => lock.acquire(dir, process.pid + 1), /already running/);
  svc.stop();
  assert.deepStrictEqual(exits, [0]);
  assert.ok(!fs.existsSync(path.join(dir, 'netprobe.lock')), 'lock released');
});

// ------------------------------------------------------------ updater

test('versions are parsed from tags and compared numerically', () => {
  assert.deepStrictEqual(parseVersion('desktop-v1.10.2'), [1, 10, 2]);
  assert.deepStrictEqual(parseVersion('v2.0.0-beta.1'), [2, 0, 0]);
  assert.strictEqual(parseVersion('latest'), null);
  assert.ok(isNewer('desktop-v1.10.0', '1.9.9'));
  assert.ok(isNewer('desktop-v2.0.0', '1.99.99'));
  assert.ok(!isNewer('desktop-v1.3.0', '1.3.0'));
  assert.ok(!isNewer('desktop-v1.2.9', '1.3.0'));
  assert.ok(!isNewer('garbage', '1.0.0'));
});

test('update mode: install in place where electron-updater can, otherwise notify', () => {
  assert.strictEqual(updateMode('win32', {}), 'auto');
  assert.strictEqual(updateMode('win32', { PORTABLE_EXECUTABLE_DIR: 'C:\\x' }), 'notify');
  assert.strictEqual(updateMode('linux', { APPIMAGE: '/x.AppImage' }), 'auto');
  assert.strictEqual(updateMode('linux', {}), 'notify');
  assert.strictEqual(updateMode('darwin', {}), 'notify');
});

function noTimers() {
  return { setInterval: () => 1, clearInterval: () => {} };
}

test('notify mode: asks GitHub for the latest release', async () => {
  const states = [];
  const fetch = async (url) => {
    assert.match(url, /api\.github\.com\/repos\/UmaisNisar\/netprobe_lite\/releases\/latest$/);
    return { ok: true, json: async () => ({ tag_name: 'desktop-v1.4.0', html_url: 'https://example/rel' }) };
  };
  const u = new Updater({ currentVersion: '1.3.0', platform: 'darwin', env: {}, deps: { fetch, ...noTimers() } });
  u.on('state', (s) => states.push(s.status));
  await u.check();
  assert.deepStrictEqual(states, ['checking', 'available']);
  assert.strictEqual(u.state.version, '1.4.0');
  assert.strictEqual(u.state.url, 'https://example/rel');
});

test('notify mode: up to date and errors', async () => {
  const same = async () => ({ ok: true, json: async () => ({ tag_name: 'desktop-v1.3.0' }) });
  const u = new Updater({ currentVersion: '1.3.0', platform: 'darwin', env: {}, deps: { fetch: same, ...noTimers() } });
  await u.check();
  assert.strictEqual(u.state.status, 'idle');
  const down = async () => ({ ok: false, status: 503 });
  const v = new Updater({ currentVersion: '1.3.0', platform: 'darwin', env: {}, deps: { fetch: down, ...noTimers() } });
  await v.check();
  assert.strictEqual(v.state.status, 'error');
  assert.match(v.state.error, /503/);
});

test('auto mode: wires electron-updater to the release feed and installs on request', async () => {
  const au = new EventEmitter();
  au.checks = 0;
  au.setFeedURL = (f) => (au.feed = f);
  au.checkForUpdates = async () => {
    au.checks++;
    au.emit('checking-for-update');
    au.emit('update-available', { version: '1.4.0' });
    au.emit('update-downloaded', { version: '1.4.0' });
  };
  au.quitAndInstall = (...a) => (au.installed = a);
  let interval;
  const u = new Updater({
    currentVersion: '1.3.0',
    platform: 'win32',
    env: {},
    deps: { loadAutoUpdater: () => au, setInterval: (fn, ms) => ((interval = ms), 1), clearInterval: () => {} },
  });
  const states = [];
  u.on('state', (s) => states.push(s.status));
  u.start();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(au.feed, { provider: 'generic', url: FEED });
  assert.strictEqual(au.autoDownload, true);
  assert.strictEqual(interval, CHECK_EVERY_MS);
  assert.deepStrictEqual(states, ['checking', 'downloading', 'ready']);
  // Already downloaded: further checks do nothing.
  await u.check();
  assert.strictEqual(au.checks, 1);
  u.install();
  assert.deepStrictEqual(au.installed, [false, true]);
});

test('auto mode: errors are reported, and install does nothing until ready', async () => {
  const au = new EventEmitter();
  au.setFeedURL = () => {};
  au.checkForUpdates = async () => {
    throw new Error('net::ERR_INTERNET_DISCONNECTED\nstack...');
  };
  au.quitAndInstall = () => assert.fail('must not install');
  const u = new Updater({ currentVersion: '1.3.0', platform: 'win32', env: {}, deps: { loadAutoUpdater: () => au, ...noTimers() } });
  u.start();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(u.state.status, 'error');
  assert.strictEqual(u.state.error, 'net::ERR_INTERNET_DISCONNECTED');
  au.emit('error', new Error('later'));
  assert.strictEqual(u.state.error, 'later');
  u.install();
  u.stop();
});
