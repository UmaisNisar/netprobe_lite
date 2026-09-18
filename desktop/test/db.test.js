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
  // Buckets are aligned to the clock, so an hour boundary can fall inside
  // the 15 minutes; a bucket may then hold a single 10 or 20 ms sample.
  assert.ok(siteA.length <= 2 && siteA.every((s) => s.latency >= 10 && s.latency <= 20));
  const largest = siteA.reduce((a, b) => (b.latency !== 10 && b.latency !== 20 ? b : a), siteA[0]);
  assert.ok(largest.latency > 10 && largest.latency < 20, 'the bigger bucket averages both values');
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

// ------------------------------------------------------------ 1.1 additions

test('upgrades a 1.0 database in place', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(path.join(dir, 'netprobe.db'));
  old.exec('CREATE TABLE runs (ts INTEGER PRIMARY KEY, score REAL, latency REAL, loss REAL, jitter REAL, dns_latency REAL)');
  old.exec(`INSERT INTO runs VALUES (${Date.now() - 1000}, 0.7, 10, 0, 1, 5)`);
  old.close();
  const store = new Store(dir);
  const h = store.history(Date.now() - HOUR);
  assert.strictEqual(h.runs[0].score, 0.7);
  assert.strictEqual(h.runs[0].gw_latency, null);
  store.saveProbe(Date.now(), result(), summary(), { conn: 'wired' });
  store.close();
});

test('stores connection, verdict and path per probe', (t) => {
  const { store } = tempStore(t);
  const r = { ...result(), path: { gateway: { latency: 2, loss: 0 }, isp: { latency: 9, loss: 1 } } };
  store.saveProbe(Date.now(), r, summary(), { conn: 'wifi', level: 'degraded', location: 'isp', settling: false });
  const row = store.db.prepare('SELECT conn, level, location, gw_latency, isp_loss, settling FROM runs').get();
  assert.deepStrictEqual({ ...row }, { conn: 'wifi', level: 'degraded', location: 'isp', gw_latency: 2, isp_loss: 1, settling: 0 });
  const h = store.history(Date.now() - HOUR);
  assert.strictEqual(h.runs[0].gw_latency, 2);
  assert.strictEqual(h.runs[0].isp_latency, 9);
});

test('history can be limited to one connection type', (t) => {
  const { store } = tempStore(t);
  store.saveProbe(Date.now() - 20 * 60_000, result(10), summary(0.9), { conn: 'wired' });
  store.saveProbe(Date.now() - 1000, result(50), summary(0.5), { conn: 'wifi' });
  const wired = store.history(Date.now() - HOUR, { conn: 'wired' });
  assert.deepStrictEqual(wired.runs.map((r) => r.score), [0.9]);
  assert.ok(wired.sites.every((s) => s.site !== 'a.com' || s.latency === 10));
  assert.strictEqual(wired.dns.length, 2);
  // Unknown filter values are ignored rather than injected into SQL.
  assert.strictEqual(store.history(Date.now() - HOUR, { conn: "x' OR 1=1" }).runs.length, 2);
});

const incident = (start, extra = {}) => ({
  start, end: null, kind: 'outage', where: 'isp', conn: 'wired', worstScore: 0, maxLoss: 100, maxLatency: null, probes: 2, ...extra,
});

test('saves, updates and lists incidents with traces', (t) => {
  const { store } = tempStore(t);
  const start = Date.now() - 10 * 60_000;
  store.saveIncident(incident(start));
  store.saveIncident(incident(start, { end: start + 60_000, probes: 4, kind: 'outage' }));
  store.saveTrace(start, '1 192.168.1.1');
  const [row] = store.incidents(Date.now() - HOUR);
  assert.strictEqual(row.end, start + 60_000);
  assert.strictEqual(row.probes, 4);
  assert.strictEqual(row.location, 'isp');
  assert.strictEqual(row.trace, '1 192.168.1.1');
  // History includes incidents for chart bands, without the bulky trace.
  const h = store.history(Date.now() - HOUR);
  assert.strictEqual(h.incidents.length, 1);
  assert.ok(!('trace' in h.incidents[0]));
});

test('open incidents are listed even if they started before the window', (t) => {
  const { store } = tempStore(t);
  store.saveIncident(incident(Date.now() - 3 * HOUR));
  assert.strictEqual(store.incidents(Date.now() - HOUR).length, 1);
});

test('closeDangling ends incidents left open by a crash at their last probe', (t) => {
  const { store } = tempStore(t);
  const start = Date.now() - 5 * 60_000;
  store.saveIncident(incident(start));
  store.saveProbe(start + 30_000, result(), summary(0));
  store.saveProbe(start + 60_000, result(), summary(0));
  store.saveIncident(incident(start - DAY)); // no probes after it at all
  store.closeDangling();
  const rows = store.incidents(Date.now() - 2 * DAY);
  assert.strictEqual(rows.find((r) => r.start === start).end, start + 60_000);
  // No probes after the older one: it ends where it started... unless the
  // newer probes count, which they do (MAX(ts) >= start), so it ends there.
  assert.strictEqual(rows.find((r) => r.start === start - DAY).end, start + 60_000);
  assert.ok(rows.every((r) => r.end != null));
});

test('uptime counts outage time against monitored time only', (t) => {
  const { store } = tempStore(t);
  const now = Date.now();
  assert.deepStrictEqual(store.uptime(now - DAY, 30_000), { uptime: null, incidents: 0, outageMs: 0 });
  // 120 probes x 30 s = 1 h monitored; a 6 minute outage and a slowdown.
  for (let i = 0; i < 120; i++) store.saveProbe(now - i * 30_000, result(), summary());
  store.saveIncident(incident(now - 30 * 60_000, { end: now - 24 * 60_000 }));
  store.saveIncident(incident(now - 10 * 60_000, { end: now - 9 * 60_000, kind: 'degraded' }));
  const u = store.uptime(now - DAY, 30_000);
  assert.strictEqual(u.incidents, 2);
  assert.strictEqual(u.outageMs, 6 * 60_000);
  assert.ok(Math.abs(u.uptime - 0.9) < 0.001, `uptime ${u.uptime}`);
});

test('prune and clear include incidents', (t) => {
  const { store } = tempStore(t);
  store.saveIncident(incident(Date.now() - 40 * DAY, { end: Date.now() - 40 * DAY + 1000 }));
  store.saveIncident(incident(Date.now() - DAY, { end: Date.now() - DAY + 1000 }));
  store.prune(30);
  assert.strictEqual(store.incidents(0).length, 1);
  store.clear();
  assert.strictEqual(store.incidents(0).length, 0);
});

// ------------------------------------------------------------ 1.2 additions

test('stores p95 per probe and site, and uncached DNS', (t) => {
  const { store } = tempStore(t);
  const r = {
    stats: [{ site: 'a.com', latency: 10, loss: 0, jitter: 1, p95: 18 }],
    dns: [{ name: 'Home', ip: '1.1.1.1', latency: 5, uncached: 40 }],
  };
  store.saveProbe(Date.now(), r, { ...summary(), p95: 18 });
  const h = store.history(Date.now() - HOUR);
  assert.strictEqual(h.runs[0].p95, 18);
  assert.strictEqual(h.sites[0].p95, 18);
  assert.strictEqual(h.dns[0].uncached, 40);
});

test('stores speed test latency and data used; sums bytes for the budget', (t) => {
  const { store } = tempStore(t);
  const now = Date.now();
  store.saveSpeed(now - 40 * DAY, { download: 1, upload: 1, bytes: 9e9 });
  store.saveSpeed(now - 2000, { download: 100e6, upload: 10e6, idleLatency: 5, downLatency: 30, upLatency: 60, bytes: 5e8 });
  store.saveSpeed(now - 1000, { download: 100e6, upload: 10e6, bytes: 2e8 });
  const latest = store.latestSpeed();
  assert.strictEqual(latest.bytes, 2e8);
  const [withLatency] = store.speedBetween(now - 3000, now - 1500);
  assert.deepStrictEqual([withLatency.idle_latency, withLatency.down_latency, withLatency.up_latency], [5, 30, 60]);
  assert.strictEqual(store.speedBytes(now - DAY), 7e8);
});

test('range queries for reports', (t) => {
  const { store } = tempStore(t);
  const now = Date.now();
  store.saveProbe(now - 3 * HOUR, result(), summary(0.1));
  store.saveProbe(now - HOUR, result(), summary(0.9));
  store.saveIncident({ start: now - 5 * HOUR, end: now - 4 * HOUR, kind: 'outage', where: 'isp', conn: 'wired', worstScore: 0, maxLoss: 100, probes: 2 });
  store.saveIncident({ start: now - 2 * HOUR - 10, end: null, kind: 'degraded', where: 'home', conn: 'wifi', worstScore: 0.5, maxLoss: 5, probes: 3 });
  const runs = store.runsBetween(now - 2 * HOUR, now);
  assert.deepStrictEqual(runs.map((r) => r.score), [0.9]);
  const incidents = store.incidentsBetween(now - 2 * HOUR, now);
  assert.deepStrictEqual(incidents.map((i) => i.kind), ['degraded'], 'open incidents overlapping the range are included');
  assert.strictEqual(store.incidentsBetween(now - 6 * HOUR, now).length, 2);
});
