const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const report = require('../src/main/report');
const { Store } = require('../src/main/db');

const { summarise, findings, daily, downsample, median, mean, csvCell, probesCsv, incidentsCsv, speedCsv, buildReport } = report;

const MIN = 60_000;
const HOUR = 60 * MIN;
const settings = { planDown: 500, planUp: 50, probeInterval: 30, sites: ['a.com'] };

const run = (ts, extra = {}) => ({ ts, score: 0.9, latency: 10, p95: 20, loss: 0, jitter: 1, dns_latency: 5, gw_latency: 2, conn: 'wired', ...extra });
const outage = (start, end, extra = {}) => ({ start, end, kind: 'outage', location: 'isp', conn: 'wired', max_loss: 100, ...extra });

test('median and mean skip nulls', () => {
  assert.strictEqual(median([3, null, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(median([]), null);
  assert.strictEqual(mean([2, null, 4]), 3);
  assert.strictEqual(mean([null]), null);
});

test('summarise: uptime counts outage time against monitored time', () => {
  const from = 0;
  const to = 2 * HOUR;
  // 120 probes x 30 s = 1 h monitored, 6 min of it an outage.
  const runs = Array.from({ length: 120 }, (_, i) => run(i * 30_000));
  const incidents = [outage(10 * MIN, 16 * MIN), { ...outage(30 * MIN, 31 * MIN), kind: 'degraded', location: 'home' }];
  const s = summarise({ runs, speeds: [], incidents, from, to, intervalMs: 30_000, settings });
  assert.strictEqual(s.probes, 120);
  assert.strictEqual(s.monitoredMs, HOUR);
  assert.strictEqual(s.coverage, 0.5);
  assert.strictEqual(s.outages, 1);
  assert.strictEqual(s.slowdowns, 1);
  assert.strictEqual(s.outageMs, 6 * MIN);
  assert.ok(Math.abs(s.uptime - 0.9) < 1e-9);
  assert.deepStrictEqual(s.blame, { isp: 1, home: 1 });
  assert.strictEqual(s.latency.median, 10);
  assert.strictEqual(s.speed, null);
});

test('summarise: incidents are clipped to the period', () => {
  const runs = [run(0), run(HOUR)];
  const s = summarise({ runs, speeds: [], incidents: [outage(-HOUR, 10 * MIN)], from: 0, to: 2 * HOUR, intervalMs: HOUR, settings });
  assert.strictEqual(s.outageMs, 10 * MIN);
  assert.strictEqual(s.longestOutageMs, 10 * MIN);
});

test('summarise: speed against plan and worst bufferbloat', () => {
  const speeds = [
    { ts: 1, download: 400e6, upload: 40e6, idle_latency: 10, down_latency: 12, up_latency: 14 },
    { ts: 2, download: 200e6, upload: 30e6, idle_latency: 10, down_latency: 90, up_latency: 20 },
  ];
  const s = summarise({ runs: [run(0)], speeds, incidents: [], from: 0, to: HOUR, intervalMs: 30_000, settings });
  assert.strictEqual(s.speed.tests, 2);
  assert.strictEqual(s.speed.down.mean, 300e6);
  assert.strictEqual(s.speed.down.min, 200e6);
  assert.strictEqual(s.speed.downShare, 0.6);
  assert.strictEqual(s.speed.upShare, 0.7);
  assert.strictEqual(s.speed.belowHalfPlan, 1);
  assert.strictEqual(s.speed.worstBloat, 'C'); // +80 ms
});

test('summarise: no plan means no plan comparisons', () => {
  const speeds = [{ ts: 1, download: 100e6, upload: 10e6 }];
  const s = summarise({ runs: [], speeds, incidents: [], from: 0, to: HOUR, intervalMs: 30_000, settings: { planDown: 0, planUp: 0 } });
  assert.strictEqual(s.speed.downShare, null);
  assert.strictEqual(s.speed.belowHalfPlan, null);
  assert.strictEqual(s.uptime, null);
});

test('findings: plain-language headlines', () => {
  const runs = Array.from({ length: 120 }, (_, i) => run(i * 30_000, { conn: i < 60 ? 'wifi' : 'wired' }));
  const speeds = [{ ts: 1, download: 100e6, upload: 10e6, idle_latency: 10, down_latency: 300, up_latency: 20 }];
  const s = summarise({ runs, speeds, incidents: [outage(10 * MIN, 16 * MIN), outage(20 * MIN, 21 * MIN)], from: 0, to: 2 * HOUR, intervalMs: 30_000, settings });
  const f = findings(s).join('\n');
  assert.match(f, /2 outages totalling 7 min \(longest 6 min\)/);
  assert.match(f, /Most incidents \(2 of 2\) were located at: Your ISP/);
  assert.match(f, /Median latency was 10 ms, 95th percentile 20 ms/);
  assert.match(f, /20% of the 500 Mbps plan/);
  assert.match(f, /1 of 1 tests were below half/);
  assert.match(f, /bufferbloat\) graded as poor as D/);
  assert.match(f, /50% of measurements were taken over Wi-Fi/);
  assert.match(f, /monitoring for 50% of the period/);
});

test('findings: a clean period and an empty one', () => {
  const clean = summarise({ runs: [run(0), run(30_000)], speeds: [], incidents: [], from: 0, to: 60_000, intervalMs: 30_000, settings });
  assert.match(findings(clean)[0], /No outages/);
  const empty = summarise({ runs: [], speeds: [], incidents: [], from: 0, to: HOUR, intervalMs: 30_000, settings });
  assert.deepStrictEqual(findings(empty), ['No measurements were recorded in this period.']);
});

test('daily: one row per local day with per-day uptime', () => {
  const day0 = new Date(2026, 8, 1).getTime();
  const runs = [run(day0 + HOUR), run(day0 + 2 * HOUR), run(day0 + 25 * HOUR)];
  const incidents = [outage(day0 + HOUR, day0 + HOUR + 30_000)];
  const rows = daily({ runs, incidents, from: day0, to: day0 + 48 * HOUR, intervalMs: 30_000 });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].probes, 2);
  assert.strictEqual(rows[0].incidents, 1);
  assert.strictEqual(rows[0].outageMs, 30_000);
  assert.strictEqual(rows[0].uptime, 0.5);
  assert.strictEqual(rows[1].probes, 1);
  assert.strictEqual(rows[1].uptime, 1);
});

test('downsample averages into at most N points', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => run(i, { latency: i % 2 ? 20 : 10 }));
  const d = downsample(rows, 100);
  assert.ok(d.length <= 100);
  assert.ok(d.every((r) => r.latency === 15));
  assert.strictEqual(downsample(rows.slice(0, 5), 100).length, 5);
});

test('CSV cells are escaped and numbers rounded', () => {
  assert.strictEqual(csvCell(null), '');
  assert.strictEqual(csvCell(1.23456), '1.235');
  assert.strictEqual(csvCell('a,b'), '"a,b"');
  assert.strictEqual(csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(csvCell('x\ny'), '"x\ny"');
});

test('CSV exports have headers, ISO times and one line per row', () => {
  const probes = probesCsv([run(Date.UTC(2026, 8, 1), { level: 'ok' })]);
  const [head, line] = probes.trim().split('\r\n');
  assert.match(head, /^time,score_pct,latency_ms,p95_ms,loss_pct/);
  assert.match(line, /^2026-09-01T00:00:00.000Z,90,10,20,0,/);
  const inc = incidentsCsv([{ ...outage(0, 90_000), worst_score: 0, max_latency: null, probes: 3 }]).trim().split('\r\n');
  assert.strictEqual(inc[1], '1970-01-01T00:00:00.000Z,1970-01-01T00:01:30.000Z,90,outage,isp,wired,0,100,,3');
  const sp = speedCsv([{ ts: 0, download: 123.4e6, upload: 10e6, idle_latency: 10, down_latency: 11, up_latency: 12, bytes: 5e8 }]).trim().split('\r\n');
  assert.strictEqual(sp[1], '1970-01-01T00:00:00.000Z,123.4,10,10,11,12,A+,500');
});

test('buildReport assembles everything from the store', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-report-'));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.now();
  const result = { stats: [{ site: 'a.com', latency: 10, loss: 0, jitter: 1, p95: 15 }], dns: [] };
  for (let i = 0; i < 10; i++) store.saveProbe(now - i * 30_000, result, { score: 0.9, latency: 10, loss: 0, jitter: 1, p95: 15, dnsLatency: 5 }, { conn: 'wired' });
  store.saveIncident({ start: now - 60_000, end: now - 30_000, kind: 'outage', where: 'home', conn: 'wired', worstScore: 0, maxLoss: 100, probes: 2 });
  store.saveSpeed(now - 1000, { download: 100e6, upload: 10e6, idleLatency: 5, downLatency: 6, upLatency: 7, bytes: 1e8 });
  const r = buildReport(store, { from: now - HOUR, to: now + 1, settings: { ...settings, sites: ['a.com'] } });
  assert.strictEqual(r.summary.probes, 10);
  assert.strictEqual(r.summary.outages, 1);
  assert.strictEqual(r.incidents.length, 1);
  assert.strictEqual(r.speeds.length, 1);
  assert.strictEqual(r.series.length, 10);
  assert.ok(r.daily.length >= 1);
  assert.ok(r.findings.length >= 2);
  assert.deepStrictEqual(r.settings.sites, ['a.com']);
});
