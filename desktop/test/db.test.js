const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/main/db');

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-db-'));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}

const result = (latency = 10) => ({
  stats: [
    { site: 'a.com', latency, loss: 0, jitter: 1 },
    { site: 'b.com', latency: null, loss: 100, jitter: null },
  ],
  dns: [
    { name: 'Google', ip: '8.8.8.8', latency: 20 },
    { name: 'Home', ip: '192.168.1.1', latency: 5 },
  ],
});
const summary = (score = 0.9) => ({ score, latency: 10, loss: 0, jitter: 1, dnsLatency: 5 });

test('creates the database file in the given folder', (t) => {
  const { dir } = tempStore(t);
  assert.ok(fs.existsSync(path.join(dir, 'netprobe.db')));
});

test('saves a probe and returns it in history', (t) => {
  const { store } = tempStore(t);
  const ts = Date.now() - 1000;
  store.saveProbe(ts, result(), summary());
  const h = store.history(Date.now() - HOUR);
  assert.strictEqual(h.runs.length, 1);
  assert.strictEqual(h.runs[0].score, 0.9);
  assert.strictEqual(h.runs[0].dns_latency, 5);
  assert.deepStrictEqual(h.sites.map((s) => [s.site, s.latency, s.loss]), [['a.com', 10, 0], ['b.com', null, 100]]);
  assert.deepStrictEqual(h.dns.map((d) => d.name).sort(), ['Google', 'Home']);
});

test('history only returns rows inside the window', (t) => {
  const { store } = tempStore(t);
  store.saveProbe(Date.now() - 2 * HOUR, result(), summary(0.1));
  store.saveProbe(Date.now() - 1000, result(), summary(0.9));
  const h = store.history(Date.now() - HOUR);
  assert.deepStrictEqual(h.runs.map((r) => r.score), [0.9]);
});

test('history averages samples into buckets for long windows', (t) => {
  const { store } = tempStore(t);
  const now = Date.now();
  // 30 probes 30 s apart in the last 15 minutes, alternating 10 / 20 ms.
  for (let i = 0; i < 30; i++) {
    store.saveProbe(now - i * 30_000, result(i % 2 ? 20 : 10), summary(i % 2 ? 0.8 : 1));
  }
  // A 30 day window over 720 points gives one-hour buckets: everything
  // collapses into one or two buckets with averaged values.
  const h = store.history(now - 30 * DAY);
  assert.ok(h.runs.length <= 2, `runs ${h.runs.length}`);
  const weighted = h.runs.reduce((a, r) => a + r.score, 0) / h.runs.length;
  assert.ok(weighted > 0.8 && weighted < 1);
  const siteA = h.sites.filter((s) => s.site === 'a.com');
  assert.ok(siteA.length <= 2 && siteA.every((s) => s.latency > 10 && s.latency < 20));
  // A 1 hour window keeps every probe.
  assert.strictEqual(store.history(now - HOUR).runs.length, 30);
});

test('saves speed tests and returns the latest', (t) => {
  const { store } = tempStore(t);
  assert.strictEqual(store.latestSpeed(), null);
  store.saveSpeed(Date.now() - 2000, { download: 100e6, upload: 10e6 });
  store.saveSpeed(Date.now() - 1000, { download: 200e6, upload: 20e6 });
  assert.strictEqual(store.latestSpeed().download, 200e6);
  assert.strictEqual(store.history(Date.now() - HOUR).speed.length, 2);
});

test('prune removes data older than the retention period', (t) => {
  const { store } = tempStore(t);
  store.saveProbe(Date.now() - 40 * DAY, result(), summary(0.1));
  store.saveSpeed(Date.now() - 40 * DAY, { download: 1, upload: 1 });
  store.saveProbe(Date.now() - DAY, result(), summary(0.9));
  store.prune(30);
  const h = store.history(Date.now() - 365 * DAY);
  assert.deepStrictEqual(h.runs.map((r) => r.score), [0.9]);
  assert.strictEqual(h.speed.length, 0);
  assert.ok(h.sites.length > 0 && h.dns.length > 0);
});

test('clear deletes everything', (t) => {
  const { store } = tempStore(t);
  store.saveProbe(Date.now(), result(), summary());
  store.saveSpeed(Date.now(), { download: 1, upload: 1 });
  store.clear();
  const h = store.history(Date.now() - HOUR);
  assert.deepStrictEqual([h.runs.length, h.sites.length, h.dns.length, h.speed.length], [0, 0, 0, 0]);
});

test('saveProbe is atomic: a bad row rolls back the whole probe', (t) => {
  const { store } = tempStore(t);
  const bad = { stats: [{ site: 'a.com', latency: 1, loss: 0, jitter: 0 }], dns: [{ name: 'x', ip: 'y', latency: {} }] };
  assert.throws(() => store.saveProbe(Date.now(), bad, summary()));
  const h = store.history(Date.now() - HOUR);
  assert.strictEqual(h.runs.length, 0);
  assert.strictEqual(h.sites.length, 0);
});

test('data persists across reopening the store', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = new Store(dir);
  a.saveProbe(Date.now(), result(), summary(0.5));
  a.close();
  const b = new Store(dir);
  assert.strictEqual(b.history(Date.now() - HOUR).runs[0].score, 0.5);
  b.close();
});
