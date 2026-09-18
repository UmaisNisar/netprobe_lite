// The monitoring engine, driven by a fake clock and a fake network against a
// real SQLite store: scheduling, pausing, sleep/wake, network changes,
// incidents, auto DNS and the speed test rules.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Monitor, untilNextTime, monthStart, SETTLE_AFTER_WAKE_MS, SETTLE_AFTER_CHANGE_MS, BACKOFF_START_MS, BACKOFF_MAX_MS } = require('../src/main/monitor');
const { Settings, deps: settingsDeps } = require('../src/main/settings');
const { Store } = require('../src/main/db');
const { HttpError } = require('../src/main/speedtest');

settingsDeps.systemDns = () => '10.0.0.1';

const T0 = new Date(2026, 8, 18, 12, 0, 0).getTime();
const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

// Deterministic clock: timers only fire inside advance().
class Clock {
  constructor(now = T0) {
    this.t = now;
    this.timers = new Map();
    this.seq = 0;
  }
  now = () => this.t;
  setTimeout = (fn, ms = 0) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  setInterval = (fn, ms) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  };
  clearInterval = (id) => this.timers.delete(id);
  // Runs due timers in time order, letting async work settle between them.
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let next = null;
      for (const [id, tm] of this.timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm];
      if (!next) break;
      const [id, tm] = next;
      this.t = Math.max(this.t, tm.at);
      if (tm.every) tm.at += tm.every;
      else this.timers.delete(id);
      tm.fn();
    }
    this.t = end;
    await flush();
  }
  // Jump the wall clock without running timers (e.g. the machine slept).
  jump(ms) {
    this.t += ms;
  }
}

const good = () => ({
  stats: [{ site: 'a.com', latency: 10, loss: 0, jitter: 1, p95: 12 }],
  dns: [{ name: 'Home', ip: 'x', latency: 5, ok: true, uncached: 9 }],
  path: { gateway: { ip: '192.168.1.1', latency: 2, loss: 0, jitter: 0 }, isp: { ip: '62.0.0.1', latency: 8, loss: 0, jitter: 1 } },
});
const silent = () => ({
  stats: [{ site: 'a.com', latency: null, loss: 100, jitter: null }],
  dns: [{ name: 'Home', ip: 'x', latency: 5000, ok: false }],
  path: { gateway: { ip: '192.168.1.1', latency: 2, loss: 0, jitter: 0 }, isp: { ip: '62.0.0.1', latency: null, loss: 100, jitter: null } },
});
const WIRED = { type: 'wired', name: 'Ethernet', gateway: '192.168.1.1', dns: ['192.168.1.1'] };
const WIFI = { type: 'wifi', name: 'Wi-Fi', gateway: '192.168.50.1', dns: ['192.168.50.1'] };

function setup(t, { settings: overrides = {}, conn = WIRED, results = good } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-mon-'));
  const settings = new Settings(dir);
  settings.set({
    ...settings.get(),
    dnsServers: [{ name: 'Home', ip: '8.8.8.8', home: true, auto: true }],
    ...overrides,
  });
  const store = new Store(dir);
  const clock = new Clock();
  const net = { conn, results, collects: [], speedtests: 0, traces: [], hops: ['192.168.1.1', null, '62.0.0.1'] };
  const monitor = new Monitor({
    settings,
    store,
    deps: {
      collect: async (s, opts) => {
        net.collects.push({ at: clock.now(), opts });
        return typeof net.results === 'function' ? net.results() : net.results;
      },
      speedtest: async ({ sampleLatency }) => {
        net.speedtests++;
        if (net.speedError) throw net.speedError;
        await sampleLatency(Promise.resolve());
        return { download: 100e6, upload: 10e6, bytes: 3e8, idleLatency: 5, downLatency: 20, upLatency: 40 };
      },
      sampleLatency: async () => [1],
      detectConnection: async () => net.conn,
      discoverHops: async () => net.hops,
      traceroute: async (target) => (net.traces.push(target), `trace to ${target}`),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      setInterval: clock.setInterval,
      clearInterval: clock.clearInterval,
    },
  });
  const events = [];
  monitor.on('incident', (e) => events.push(e));
  t.after(() => {
    monitor.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { monitor, store, settings, clock, net, events };
}

// ------------------------------------------------------------ scheduling

test('start waits for connection detection, probes at once, then every interval', async (t) => {
  const { monitor, clock, net } = setup(t);
  monitor.start();
  await clock.advance(0);
  assert.strictEqual(net.collects.length, 1);
  assert.deepStrictEqual(monitor.state.connection, WIRED);
  assert.deepStrictEqual(monitor.state.path, { gateway: '192.168.1.1', isp: '62.0.0.1' });
  assert.deepStrictEqual(net.collects[0].opts.path, { gateway: '192.168.1.1', isp: '62.0.0.1' });
  await clock.advance(30_000);
  assert.strictEqual(net.collects.length, 2);
  await clock.advance(90_000);
  assert.strictEqual(net.collects.length, 5);
  assert.strictEqual(monitor.state.nextProbeAt, clock.now() + 30_000);
});

test('the first probe still runs if detection hangs', async (t) => {
  const { monitor, clock, net } = setup(t);
  monitor.deps.detectConnection = () => new Promise(() => {});
  monitor.start();
  await clock.advance(14_000);
  assert.strictEqual(net.collects.length, 0);
  await clock.advance(1_000);
  assert.strictEqual(net.collects.length, 1);
});

test('each probe is stored with its context and summarised in state', async (t) => {
  const { monitor, clock, store } = setup(t);
  const states = [];
  monitor.on('state', (s) => states.push(s));
  monitor.start();
  await clock.advance(0);
  const [row] = store.runsBetween(0, Infinity);
  assert.strictEqual(row.conn, 'wired');
  assert.strictEqual(row.level, 'ok');
  assert.strictEqual(row.gw_latency, 2);
  assert.strictEqual(row.p95, 12);
  assert.strictEqual(monitor.state.latest.diag.level, 'ok');
  assert.ok(states.some((s) => s.probing) && !states.at(-1).probing, 'probing flag toggles');
  assert.ok(monitor.state.uptime.day, 'uptime refreshed');
  assert.ok(states.at(-1).settings, 'public state includes settings');
});

test('a failing probe records the error and keeps the schedule', async (t) => {
  const { monitor, clock, net } = setup(t);
  net.results = () => {
    throw new Error('ping exploded');
  };
  monitor.start();
  await clock.advance(0);
  assert.strictEqual(monitor.state.lastError, 'ping exploded');
  net.results = good;
  await clock.advance(30_000);
  assert.strictEqual(monitor.state.lastError, null);
});

test('the home DNS server follows the detected network when "auto"', async (t) => {
  const { monitor, clock, net, settings } = setup(t);
  monitor.start();
  await clock.advance(0);
  assert.strictEqual(net.collects[0].opts.dnsServers[0].ip, '192.168.1.1');
  settings.set({ ...settings.get(), dnsServers: [{ name: 'Home', ip: '8.8.8.8', home: true, auto: false }] });
  await clock.advance(30_000);
  assert.strictEqual(net.collects[1].opts.dnsServers[0].ip, '8.8.8.8');
});

test('manual probes are ignored while one is running, paused or asleep', async (t) => {
  const { monitor, clock, net } = setup(t);
  let release;
  net.results = () => new Promise((r) => (release = () => r(good())));
  monitor.start();
  await clock.advance(0);
  monitor.runProbe(); // already probing
  release();
  await clock.advance(0);
  assert.strictEqual(net.collects.length, 1);
  net.results = good;
  monitor.togglePause();
  await monitor.runProbe();
  monitor.togglePause();
  monitor.suspend();
  await monitor.runProbe();
  assert.strictEqual(net.collects.length, 1);
});

// ------------------------------------------------------------ incidents

test('an outage opens after two silent probes, captures a traceroute, and closes after recovery', async (t) => {
  const { monitor, clock, net, events, store } = setup(t);
  monitor.start();
  await clock.advance(0);
  net.results = silent;
  await clock.advance(60_000);
  assert.deepStrictEqual(events.map((e) => e.type), ['start']);
  const inc = events[0].incident;
  assert.strictEqual(inc.kind, 'outage');
  assert.strictEqual(inc.where, 'isp', 'router fine, ISP hop unreachable');
  assert.strictEqual(monitor.state.incident.kind, 'outage');
  assert.deepStrictEqual(net.traces, ['a.com']);
  assert.strictEqual(store.incidents(0)[0].trace, 'trace to a.com');
  net.results = good;
  await clock.advance(60_000);
  assert.deepStrictEqual(events.map((e) => e.type), ['start', 'end']);
  assert.strictEqual(monitor.state.incident, null);
  const [row] = store.incidents(0);
  assert.strictEqual(row.end - row.start, 60_000);
  assert.ok(monitor.state.uptime.day.uptime < 1);
});

test('a bad probe caused by a network change is not an incident', async (t) => {
  const { monitor, clock, net, events, store } = setup(t);
  monitor.start();
  await clock.advance(0);
  net.results = silent;
  net.conn = WIFI; // the bad probe coincides with switching networks
  await clock.advance(30_000);
  assert.strictEqual(monitor.state.latest.diag.settling, true);
  assert.deepStrictEqual(monitor.state.connection, WIFI);
  assert.strictEqual(store.runsBetween(0, Infinity).at(-1).settling, 1);
  // Still inside the settle window: not judged either.
  await clock.advance(SETTLE_AFTER_CHANGE_MS - 10_000);
  assert.deepStrictEqual(events, []);
});

test('a network change during an incident closes it', async (t) => {
  const { monitor, clock, net, events } = setup(t);
  monitor.start();
  await clock.advance(0);
  net.results = silent;
  await clock.advance(60_000);
  assert.deepStrictEqual(events.map((e) => e.type), ['start']);
  net.conn = WIFI;
  await monitor.refreshConnection();
  assert.deepStrictEqual(events.map((e) => e.type), ['start', 'end']);
});

// ------------------------------------------------------------ sleep, pause

test('suspend stops probing and ends incidents; resume settles before judging', async (t) => {
  const { monitor, clock, net, events } = setup(t);
  monitor.start();
  await clock.advance(0);
  net.results = silent;
  await clock.advance(60_000);
  monitor.suspend();
  assert.strictEqual(monitor.state.sleeping, true);
  assert.strictEqual(monitor.state.nextProbeAt, null);
  assert.deepStrictEqual(events.map((e) => e.type), ['start', 'end']);
  const before = net.collects.length;
  await clock.advance(10 * 60_000);
  assert.strictEqual(net.collects.length, before, 'nothing while asleep');
  monitor.suspend(); // idempotent
  monitor.resume();
  assert.strictEqual(monitor.state.nextProbeAt, clock.now() + SETTLE_AFTER_WAKE_MS);
  await clock.advance(SETTLE_AFTER_WAKE_MS);
  assert.strictEqual(net.collects.length, before + 1);
  monitor.resume(); // idempotent
});

test('a timer that fires far too late is treated as a silent sleep', async (t) => {
  const { monitor, clock, net, events } = setup(t);
  monitor.start();
  await clock.advance(0);
  net.results = silent;
  await clock.advance(30_000); // one bad probe pending
  clock.jump(2 * 3600_000); // slept without a suspend event
  await clock.advance(29_000); // just the one (late) probe
  assert.deepStrictEqual(events, [], 'the pending bad probe was forgotten; the late probe is settling');
  assert.strictEqual(monitor.state.latest.diag.settling, true);
});

test('pause and resume', async (t) => {
  const { monitor, clock, net } = setup(t);
  monitor.start();
  await clock.advance(0);
  monitor.togglePause();
  assert.strictEqual(monitor.state.paused, true);
  await clock.advance(120_000);
  assert.strictEqual(net.collects.length, 1);
  monitor.togglePause();
  await clock.advance(0);
  assert.strictEqual(net.collects.length, 2);
});

test('stop cancels everything', async (t) => {
  const { monitor, clock, net } = setup(t);
  monitor.start();
  await clock.advance(0);
  monitor.stop();
  await clock.advance(10 * 60_000);
  assert.strictEqual(net.collects.length, 1);
});

// ------------------------------------------------------------ speed tests

test('speed tests are saved with bufferbloat and data used', async (t) => {
  const { monitor, clock, store, net } = setup(t);
  monitor.start();
  await clock.advance(0);
  await monitor.runSpeedtest();
  assert.strictEqual(net.speedtests, 1);
  assert.strictEqual(monitor.state.speed.up_latency, 40);
  assert.strictEqual(store.latestSpeed().bytes, 3e8);
  assert.strictEqual(monitor.state.speedUsage.month, 3e8);
});

test('a speed test waits for a running probe', async (t) => {
  const { monitor, clock, net } = setup(t);
  let release;
  net.results = () => new Promise((r) => (release = () => r(good())));
  monitor.start();
  await clock.advance(0);
  const st = monitor.runSpeedtest();
  await flush();
  assert.strictEqual(net.speedtests, 0);
  release();
  await clock.advance(500);
  await st;
  assert.strictEqual(net.speedtests, 1);
});

test('scheduled speed tests: interval, restart-aware first run, and enabling', async (t) => {
  const { monitor, clock, net, settings } = setup(t, { settings: { speedtestEnabled: true, speedtestInterval: 900 } });
  monitor.start();
  await clock.advance(59_000);
  assert.strictEqual(net.speedtests, 0);
  await clock.advance(1_000);
  assert.strictEqual(net.speedtests, 1, 'first test a minute after start');
  await clock.advance(900_000);
  assert.strictEqual(net.speedtests, 2);
  const before = settings.get();
  settings.set({ ...before, speedtestEnabled: false });
  monitor.applySettings(before, settings.get());
  await clock.advance(3600_000);
  assert.strictEqual(net.speedtests, 2);
  const off = settings.get();
  settings.set({ ...off, speedtestEnabled: true });
  monitor.applySettings(off, settings.get());
  await clock.advance(5_000);
  assert.strictEqual(net.speedtests, 3, 'enabling runs one shortly');
});

test('the "times" schedule runs at the listed times of day', async (t) => {
  const { monitor, clock, net } = setup(t, { settings: { speedtestEnabled: true, speedtestSchedule: 'times', speedtestTimes: ['13:00', '20:00'] } });
  monitor.start();
  await clock.advance(59 * 60_000); // 12:59
  assert.strictEqual(net.speedtests, 0);
  await clock.advance(60_000); // 13:00
  assert.strictEqual(net.speedtests, 1);
  await clock.advance(7 * 3600_000); // 20:00
  assert.strictEqual(net.speedtests, 2);
});

test('rate limiting backs off, doubling up to a maximum', async (t) => {
  const { monitor, clock, net } = setup(t, { settings: { speedtestEnabled: true, speedtestInterval: 300 } });
  net.speedError = new HttpError('Download', 429);
  monitor.start();
  await clock.advance(60_000);
  assert.strictEqual(net.speedtests, 1);
  assert.strictEqual(monitor.state.speedBackoffMs, BACKOFF_START_MS);
  assert.strictEqual(monitor.state.nextSpeedtestAt, clock.now() + BACKOFF_START_MS);
  await clock.advance(BACKOFF_START_MS);
  assert.strictEqual(monitor.state.speedBackoffMs, 2 * BACKOFF_START_MS);
  for (let i = 0; i < 6; i++) await clock.advance(monitor.state.nextSpeedtestAt - clock.now());
  assert.strictEqual(monitor.state.speedBackoffMs, BACKOFF_MAX_MS);
  net.speedError = null;
  await clock.advance(monitor.state.nextSpeedtestAt - clock.now());
  assert.strictEqual(monitor.state.speedBackoffMs, 0, 'reset after a success');
  assert.strictEqual(monitor.state.speedError, null);
});

test('the monthly data budget stops scheduled tests, not manual ones', async (t) => {
  const { monitor, clock, net, store } = setup(t, { settings: { speedtestEnabled: true, speedtestInterval: 300, speedtestBudgetGB: 0.5 } });
  store.saveSpeed(T0 - 1000, { download: 1, upload: 1, bytes: 6e8 }); // over budget already
  monitor.start();
  await clock.advance(5 * 60_000);
  assert.strictEqual(net.speedtests, 0);
  assert.strictEqual(monitor.state.speedSkipped, 'budget');
  await monitor.runSpeedtest();
  assert.strictEqual(net.speedtests, 1, 'manual test still runs');
  assert.strictEqual(monitor.state.speedSkipped, null);
});

test('schedule helpers', () => {
  const at = (h, m) => new Date(2026, 8, 18, h, m).getTime();
  assert.strictEqual(untilNextTime(['08:00', '20:00'], at(21, 30)), 10.5 * 3600_000);
  assert.strictEqual(untilNextTime(['08:00', '20:00'], at(7, 0)), 3600_000);
  assert.strictEqual(untilNextTime(['08:00'], at(8, 0)), 24 * 3600_000, 'exactly now means tomorrow');
  assert.strictEqual(monthStart(at(21, 30)), new Date(2026, 8, 1).getTime());
});

// ------------------------------------------------------------ settings, data

test('changing the interval reschedules; retention change prunes', async (t) => {
  const { monitor, clock, net, settings, store } = setup(t);
  monitor.start();
  await clock.advance(0);
  store.saveProbe(T0 - 20 * 86400_000, good(), { score: 1, latency: 1, loss: 0, jitter: 0, dnsLatency: 1 });
  const before = settings.get();
  settings.set({ ...before, probeInterval: 60, retentionDays: 7 });
  monitor.applySettings(before, settings.get());
  await clock.advance(30_000);
  assert.strictEqual(net.collects.length, 1);
  await clock.advance(30_000);
  assert.strictEqual(net.collects.length, 2);
  assert.ok(store.runsBetween(0, T0 - 86400_000).length === 0, 'old data pruned');
});

test('history, incidents and clearHistory', async (t) => {
  const { monitor, clock, net, store } = setup(t);
  monitor.start();
  await clock.advance(0);
  net.results = silent;
  await clock.advance(60_000);
  assert.strictEqual(monitor.history(3600_000).runs.length, 3);
  assert.strictEqual(monitor.history(3600_000, 'wifi').runs.length, 0);
  assert.strictEqual(monitor.incidents().length, 1);
  monitor.clearHistory();
  assert.strictEqual(monitor.state.latest, null);
  assert.strictEqual(monitor.state.incident, null);
  assert.strictEqual(store.runsBetween(0, Infinity).length, 0);
});

test('an incident left open by a crash is closed on the next start', async (t) => {
  const { monitor, clock, store } = setup(t);
  store.saveIncident({ start: T0 - 60_000, end: null, kind: 'outage', where: 'isp', conn: 'wired', worstScore: 0, maxLoss: 100, probes: 2 });
  monitor.start();
  await clock.advance(0);
  assert.notStrictEqual(store.incidents(0)[0].end, null);
});

test('VPN and unknown connections skip hop discovery', async (t) => {
  const { monitor, clock, net } = setup(t, { conn: { type: 'vpn', name: 'wg0', gateway: null, dns: [] } });
  let scans = 0;
  monitor.deps.discoverHops = async () => (scans++, net.hops);
  monitor.start();
  await clock.advance(0);
  assert.strictEqual(scans, 0);
  assert.deepStrictEqual(monitor.state.path, { gateway: null, isp: null });
  net.conn = { type: 'wired', name: 'eth0', gateway: '10.0.0.1', dns: [] };
  monitor.deps.discoverHops = async () => {
    throw new Error('ping missing');
  };
  await monitor.refreshConnection();
  assert.deepStrictEqual(monitor.state.path, { gateway: '10.0.0.1', isp: null }, 'falls back to the gateway');
});
