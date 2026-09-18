const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Settings, defaults, validate, systemDns, deps } = require('../src/main/settings');

// Detection shells out to PowerShell on Windows; stub it except where tested.
deps.systemDns = () => '10.0.0.1';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('defaults mirror the original .env', () => {
  const d = defaults();
  assert.strictEqual(d.probeInterval, 30);
  assert.strictEqual(d.pingCount, 50);
  assert.strictEqual(d.dnsTestSite, 'google.com');
  assert.deepStrictEqual(d.weights, { loss: 0.6, latency: 0.15, jitter: 0.2, dnsLatency: 0.05 });
  assert.deepStrictEqual(d.thresholds, { loss: 5, latency: 100, jitter: 30, dnsLatency: 100 });
  assert.strictEqual(d.speedtestEnabled, false);
  assert.strictEqual(d.speedtestInterval, 937);
  assert.strictEqual(d.retentionDays, 30);
  const weightSum = Object.values(d.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-9);
});

test('defaults include exactly one home DNS server', () => {
  const home = defaults().dnsServers.filter((s) => s.home);
  assert.strictEqual(home.length, 1);
});

test('first run detects the system DNS and writes the settings file', (t) => {
  const dir = tempDir(t);
  const s = new Settings(dir).get();
  assert.strictEqual(s.dnsServers.find((d) => d.home).ip, '10.0.0.1');
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
});

test('a later run reads the file instead of detecting again', (t) => {
  const dir = tempDir(t);
  new Settings(dir);
  let calls = 0;
  const saved = deps.systemDns;
  deps.systemDns = () => (calls++, '10.9.9.9');
  try {
    const s = new Settings(dir).get();
    assert.strictEqual(calls, 0);
    assert.strictEqual(s.dnsServers.find((d) => d.home).ip, '10.0.0.1');
  } finally {
    deps.systemDns = saved;
  }
});

test('validates and persists settings', (t) => {
  const dir = tempDir(t);
  const s = new Settings(dir);
  const saved = s.set({
    sites: [' example.com ', ''],
    probeInterval: 1,
    dnsServers: [{ name: 'x', ip: '1.1.1.1', home: true }, { name: 'y', ip: '8.8.8.8', home: true }],
  });
  assert.deepStrictEqual(saved.sites, ['example.com']);
  assert.strictEqual(saved.probeInterval, 15);
  assert.deepStrictEqual(saved.dnsServers.map((d) => d.home), [true, false]);
  assert.deepStrictEqual(new Settings(dir).get().sites, ['example.com']);
});

test('get returns a copy that cannot mutate stored settings', (t) => {
  const s = new Settings(tempDir(t));
  s.get().sites.push('evil.com');
  s.get().weights.loss = 99;
  assert.ok(!s.get().sites.includes('evil.com'));
  assert.strictEqual(s.get().weights.loss, 0.6);
});

test('a corrupt settings file falls back to defaults', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
  const s = new Settings(dir).get();
  assert.deepStrictEqual(s.sites, defaults().sites);
  // ...and is replaced with a valid file.
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')));
});

test('partial weight/threshold updates keep the other values', () => {
  const s = validate({ ...defaults(), weights: { loss: 0.5 }, thresholds: { jitter: 50 } });
  // validate is applied after merge in real use; merge is exercised via set().
  assert.strictEqual(s.weights.loss, 0.5);
  assert.strictEqual(s.weights.latency, 0.15);
  assert.strictEqual(s.thresholds.jitter, 50);
  assert.strictEqual(s.thresholds.loss, 5);
});

test('set merges partial nested objects with defaults', (t) => {
  const saved = new Settings(tempDir(t)).set({ weights: { loss: 0.7 } });
  assert.deepStrictEqual(saved.weights, { loss: 0.7, latency: 0.15, jitter: 0.2, dnsLatency: 0.05 });
});

test('numbers are clamped to safe ranges and junk falls back to defaults', () => {
  const s = validate({
    ...defaults(),
    probeInterval: 99999,
    pingCount: 'lots',
    speedtestInterval: 10,
    retentionDays: 0,
    weights: { loss: -1, latency: 5, jitter: 'x', dnsLatency: 0.05 },
    thresholds: { loss: 0, latency: 100, jitter: 30, dnsLatency: 100 },
  });
  assert.strictEqual(s.probeInterval, 3600);
  assert.strictEqual(s.pingCount, 50);
  assert.strictEqual(s.speedtestInterval, 300);
  assert.strictEqual(s.retentionDays, 1);
  assert.deepStrictEqual(s.weights, { loss: 0, latency: 1, jitter: 0.2, dnsLatency: 0.05 });
  assert.strictEqual(s.thresholds.loss, 0.1); // never 0, it is a divisor
});

test('site list is trimmed, de-blanked and capped at 20', () => {
  const many = Array.from({ length: 25 }, (_, i) => `s${i}.com`);
  assert.strictEqual(validate({ ...defaults(), sites: many }).sites.length, 20);
  assert.deepStrictEqual(validate({ ...defaults(), sites: ['', '  '] }).sites, defaults().sites);
});

test('DNS servers without an IP are dropped; an empty list is restored', () => {
  const s = validate({ ...defaults(), dnsServers: [{ name: 'no ip' }, { ip: ' 9.9.9.9 ' }] });
  assert.deepStrictEqual(s.dnsServers, [{ name: '9.9.9.9', ip: '9.9.9.9', home: true, auto: false }]);
  const empty = validate({ ...defaults(), dnsServers: [] });
  assert.strictEqual(empty.dnsServers.find((d) => d.home).ip, '10.0.0.1');
});

test('the last DNS server becomes home when none is marked', () => {
  const s = validate({ ...defaults(), dnsServers: [{ name: 'a', ip: '1.1.1.1' }, { name: 'b', ip: '2.2.2.2' }] });
  assert.deepStrictEqual(s.dnsServers.map((d) => d.home), [false, true]);
});

test('home DNS servers follow the network by default, others never do', () => {
  const s = validate({
    ...defaults(),
    dnsServers: [{ name: 'a', ip: '1.1.1.1', auto: true }, { name: 'b', ip: '2.2.2.2', home: true }],
  });
  assert.deepStrictEqual(s.dnsServers.map((d) => d.auto), [false, true]);
  const pinned = validate({ ...defaults(), dnsServers: [{ name: 'b', ip: '2.2.2.2', home: true, auto: false }] });
  assert.strictEqual(pinned.dnsServers[0].auto, false);
});

test('alert settings have defaults and are clamped', () => {
  assert.deepStrictEqual(defaults().alerts, { notify: true, degradedScore: 0.6, degradedLoss: 2 });
  const s = validate({ ...defaults(), alerts: { notify: 0, degradedScore: 5, degradedLoss: -1 } });
  assert.deepStrictEqual(s.alerts, { notify: false, degradedScore: 1, degradedLoss: 0.1 });
});

test('booleans are coerced', () => {
  const s = validate({ ...defaults(), speedtestEnabled: 'yes', openAtLogin: 0 });
  assert.strictEqual(s.speedtestEnabled, true);
  assert.strictEqual(s.openAtLogin, false);
});

test('systemDns returns a non-loopback IPv4 address', () => {
  const ip = systemDns();
  assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
  assert.ok(!ip.startsWith('127.'));
});

// ------------------------------------------------------------ 1.2 additions

const { normaliseTime } = require('../src/main/settings');

test('speed test schedule, plan and budget defaults', () => {
  const d = defaults();
  assert.strictEqual(d.speedtestSchedule, 'interval');
  assert.deepStrictEqual(d.speedtestTimes, ['08:00', '20:00']);
  assert.strictEqual(d.speedtestBudgetGB, 0);
  assert.strictEqual(d.planDown, 0);
  assert.strictEqual(d.planUp, 0);
});

test('times of day are normalised, de-duplicated and sorted', () => {
  assert.strictEqual(normaliseTime('8:5'), '08:05');
  assert.strictEqual(normaliseTime('23:59'), '23:59');
  assert.strictEqual(normaliseTime('24:00'), null);
  assert.strictEqual(normaliseTime('12:60'), null);
  assert.strictEqual(normaliseTime('noon'), null);
  const s = validate({ ...defaults(), speedtestTimes: '20:00, 8:5 x 20:00, 25:00' });
  assert.deepStrictEqual(s.speedtestTimes, ['08:05', '20:00']);
  assert.deepStrictEqual(validate({ ...defaults(), speedtestTimes: ['nope'] }).speedtestTimes, ['08:00', '20:00']);
});

test('schedule, plan and budget are validated', () => {
  const s = validate({ ...defaults(), speedtestSchedule: 'hourly', planDown: -5, planUp: 'x', speedtestBudgetGB: 50 });
  assert.strictEqual(s.speedtestSchedule, 'interval');
  assert.strictEqual(s.planDown, 0);
  assert.strictEqual(s.planUp, 0);
  assert.strictEqual(s.speedtestBudgetGB, 50);
  assert.strictEqual(validate({ ...defaults(), speedtestSchedule: 'times' }).speedtestSchedule, 'times');
});
