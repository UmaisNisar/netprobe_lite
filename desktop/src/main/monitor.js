// The monitoring engine: schedules probes and speed tests, tracks the
// network path and incidents, and keeps the live state. It has no Electron
// dependency so it can run behind the desktop UI or headless.
//
// Events: 'state' (anything changed), 'incident' ({ type, incident }).

const { EventEmitter } = require('node:events');
const probe = require('./probe');
const speedtest = require('./speedtest');
const network = require('./network');
const { traceroute } = require('./trace');
const { summarise } = require('./score');
const { diagnose } = require('./diagnose');
const { IncidentTracker } = require('./incidents');

const SETTLE_AFTER_WAKE_MS = 30_000;
const SETTLE_AFTER_CHANGE_MS = 20_000;
const CONNECTION_POLL_MS = 60_000;
const DAY = 86400_000;

class Monitor extends EventEmitter {
  constructor({ settings, store, deps = {} }) {
    super();
    this.settings = settings;
    this.store = store;
    this.deps = {
      collect: probe.collect,
      speedtest: speedtest.run,
      detectConnection: network.detectConnection,
      discoverHops: network.discoverHops,
      ispHop: network.ispHop,
      traceroute,
      now: Date.now,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      ...deps,
    };
    this.tracker = new IncidentTracker();
    this.timers = { probe: null, speed: null, prune: null, connection: null };
    this.settleUntil = 0;
    this.connectionKnown = false;
    this.state = {
      latest: null, // { ts, summary, result, diag }
      speed: null, // { ts, download, upload }
      probing: false,
      speedtesting: false,
      lastError: null,
      speedError: null,
      paused: false,
      sleeping: false,
      nextProbeAt: null,
      nextSpeedtestAt: null,
      connection: { ...network.UNKNOWN },
      path: { gateway: null, isp: null },
      incident: null, // open incident, if any
      uptime: { day: null, week: null },
    };
  }

  // ---------------------------------------------------------- lifecycle

  start() {
    const { store, deps } = this;
    store.closeDangling();
    const speed = store.latestSpeed();
    if (speed) this.state.speed = speed;
    this.#refreshUptime();
    this.prune();
    this.timers.prune = deps.setInterval(() => this.prune(), 3600_000);
    this.timers.connection = deps.setInterval(() => this.refreshConnection(), CONNECTION_POLL_MS);
    // The first probe needs the router and auto DNS, so wait for detection
    // (bounded, in case it hangs).
    const detected = this.refreshConnection().catch(() => {});
    const timeout = new Promise((r) => deps.setTimeout(r, 15_000));
    this.ready = Promise.race([detected, timeout]).then(() => {
      if (!this.stopped) this.scheduleProbe(0);
    });
    this.scheduleSpeedtest();
  }

  stop() {
    const { deps } = this;
    this.stopped = true;
    deps.clearTimeout(this.timers.probe);
    deps.clearTimeout(this.timers.speed);
    deps.clearInterval(this.timers.prune);
    deps.clearInterval(this.timers.connection);
    this.#interrupt();
  }

  publicState() {
    return { ...this.state, settings: this.settings.get() };
  }

  #emitState() {
    this.emit('state', this.publicState());
  }

  // ---------------------------------------------------------- probing

  async runProbe() {
    const { state, deps } = this;
    if (state.probing || state.speedtesting || state.paused || state.sleeping) return;
    state.probing = true;
    this.#emitState();
    try {
      const s = this.settings.get();
      const ts = deps.now();
      const dnsServers = this.#dnsServers(s);
      const result = await deps.collect(s, { path: state.path, dnsServers });
      const summary = summarise(result, { ...s, dnsServers });
      let diag = diagnose(summary, result, s, state.connection);
      // A bad probe right after the network changed is the change itself,
      // not an incident: re-check the connection before judging it.
      let settling = ts < this.settleUntil;
      if (diag.level !== 'ok' && !settling && (await this.refreshConnection())) settling = true;
      if (settling) diag = { ...diag, level: 'ok', settling: true };
      this.store.saveProbe(ts, result, summary, {
        conn: state.connection.type,
        level: diag.level,
        location: diag.where,
        settling,
      });
      state.latest = { ts, summary, result, diag };
      state.lastError = null;
      if (!settling) {
        this.#track({
          ts,
          level: diag.level,
          where: diag.where,
          score: summary.score,
          loss: summary.loss,
          latency: summary.latency,
          conn: state.connection.type,
        });
      }
      this.#refreshUptime();
    } catch (e) {
      state.lastError = String(e?.message || e);
    } finally {
      state.probing = false;
      this.#emitState();
    }
  }

  scheduleProbe(delayMs) {
    const { deps, state } = this;
    deps.clearTimeout(this.timers.probe);
    if (state.paused || state.sleeping) {
      state.nextProbeAt = null;
      return;
    }
    const interval = this.settings.get().probeInterval * 1000;
    const delay = delayMs ?? interval;
    state.nextProbeAt = deps.now() + delay;
    this.timers.probe = deps.setTimeout(async () => {
      // A timer firing far too late means the machine slept without telling
      // us (no suspend event); treat it like a wake-up.
      if (deps.now() - state.nextProbeAt > interval + 60_000) {
        this.#interrupt();
        this.settleUntil = deps.now() + SETTLE_AFTER_WAKE_MS;
      }
      await this.runProbe();
      this.scheduleProbe();
    }, delay);
  }

  // ---------------------------------------------------------- speed test

  async runSpeedtest() {
    const { state, deps } = this;
    if (state.speedtesting || state.sleeping) return;
    // Let an in-flight probe finish first so the two don't skew each other.
    while (state.probing) await new Promise((r) => deps.setTimeout(r, 500));
    state.speedtesting = true;
    this.#emitState();
    try {
      const result = await deps.speedtest();
      const ts = deps.now();
      this.store.saveSpeed(ts, result);
      state.speed = { ts, ...result };
      state.speedError = null;
    } catch (e) {
      state.speedError = String(e?.message || e);
    } finally {
      state.speedtesting = false;
      this.#emitState();
    }
  }

  // With no explicit delay, the next test is due one interval after the last
  // one (surviving restarts), but never sooner than a minute from now.
  scheduleSpeedtest(delayMs) {
    const { deps, state } = this;
    deps.clearTimeout(this.timers.speed);
    const s = this.settings.get();
    if (!s.speedtestEnabled || state.paused || state.sleeping) {
      state.nextSpeedtestAt = null;
      return;
    }
    const interval = s.speedtestInterval * 1000;
    const sinceLast = state.speed ? deps.now() - state.speed.ts : Infinity;
    const delay = delayMs ?? Math.max(60_000, Math.min(interval, interval - sinceLast));
    state.nextSpeedtestAt = deps.now() + delay;
    this.timers.speed = deps.setTimeout(async () => {
      await this.runSpeedtest();
      this.scheduleSpeedtest(interval);
    }, delay);
  }

  // ---------------------------------------------------------- network path

  // Returns true when the connection changed.
  async refreshConnection() {
    const next = await this.deps.detectConnection();
    const cur = this.state.connection;
    const changed = next.type !== cur.type || next.name !== cur.name || next.gateway !== cur.gateway;
    const sameDns = (next.dns ?? []).join() === (cur.dns ?? []).join();
    if (!changed && sameDns) return false;
    this.state.connection = next;
    const wasKnown = this.connectionKnown;
    if (changed) {
      if (wasKnown) {
        this.#interrupt();
        this.settleUntil = this.deps.now() + SETTLE_AFTER_CHANGE_MS;
      }
      this.connectionKnown = true;
      await this.discoverPath();
    }
    this.#emitState();
    return changed && wasKnown;
  }

  async discoverPath() {
    const conn = this.state.connection;
    if (conn.type === 'vpn' || (conn.type === 'unknown' && !conn.gateway)) {
      this.state.path = { gateway: conn.gateway ?? null, isp: null };
      return;
    }
    try {
      const hops = await this.deps.discoverHops();
      const gateway = conn.gateway ?? hops[0] ?? null;
      this.state.path = { gateway, isp: this.deps.ispHop(hops, gateway) };
    } catch {
      this.state.path = { gateway: conn.gateway ?? null, isp: null };
    }
  }

  // Home DNS servers marked "auto" follow the current network's resolver.
  #dnsServers(s) {
    const detected = this.state.connection.dns?.[0];
    return s.dnsServers.map((srv) => (srv.home && srv.auto && detected ? { ...srv, ip: detected } : srv));
  }

  // ---------------------------------------------------------- incidents

  #track(p) {
    for (const ev of this.tracker.observe(p)) this.#handleIncident(ev);
  }

  // Sleep, pause or a network change: close any open incident at its last
  // bad probe and start fresh, so gaps never become outages.
  #interrupt() {
    for (const ev of this.tracker.interrupt()) this.#handleIncident(ev);
  }

  #handleIncident(ev) {
    const inc = ev.incident;
    this.store.saveIncident(inc);
    this.state.incident = ev.type === 'end' ? null : inc;
    if (ev.type === 'start') this.#captureTrace(inc);
    if (ev.type !== 'update') this.emit('incident', ev);
    this.#refreshUptime();
  }

  async #captureTrace(inc) {
    // Trace to the worst site of the latest probe (or a public anchor).
    const stats = this.state.latest?.result.stats ?? [];
    const worst = [...stats].sort((a, b) => (b.loss ?? 0) - (a.loss ?? 0))[0]?.site ?? '1.1.1.1';
    try {
      this.store.saveTrace(inc.start, await this.deps.traceroute(worst));
    } catch {
      // Best effort.
    }
  }

  #refreshUptime() {
    const now = this.deps.now();
    const interval = this.settings.get().probeInterval * 1000;
    try {
      this.state.uptime = {
        day: this.store.uptime(now - DAY, interval),
        week: this.store.uptime(now - 7 * DAY, interval),
      };
    } catch {
      // Keep the previous numbers.
    }
  }

  // ---------------------------------------------------------- controls

  togglePause() {
    const { state, deps } = this;
    state.paused = !state.paused;
    if (state.paused) {
      deps.clearTimeout(this.timers.probe);
      deps.clearTimeout(this.timers.speed);
      state.nextProbeAt = null;
      state.nextSpeedtestAt = null;
      this.#interrupt();
    } else {
      this.scheduleProbe(0);
      this.scheduleSpeedtest();
    }
    this.#emitState();
  }

  suspend() {
    const { state, deps } = this;
    if (state.sleeping) return;
    state.sleeping = true;
    deps.clearTimeout(this.timers.probe);
    deps.clearTimeout(this.timers.speed);
    state.nextProbeAt = null;
    state.nextSpeedtestAt = null;
    this.#interrupt();
    this.#emitState();
  }

  resume() {
    const { state, deps } = this;
    if (!state.sleeping) return;
    state.sleeping = false;
    this.settleUntil = deps.now() + SETTLE_AFTER_WAKE_MS;
    this.refreshConnection();
    this.scheduleProbe(SETTLE_AFTER_WAKE_MS);
    this.scheduleSpeedtest();
    this.#emitState();
  }

  applySettings(before, after) {
    if (before.probeInterval !== after.probeInterval) this.scheduleProbe();
    if (!before.speedtestEnabled && after.speedtestEnabled) this.scheduleSpeedtest(5000);
    else if (before.speedtestEnabled !== after.speedtestEnabled || before.speedtestInterval !== after.speedtestInterval) {
      this.scheduleSpeedtest();
    }
    if (before.retentionDays !== after.retentionDays) this.prune();
    this.#emitState();
  }

  clearHistory() {
    this.tracker.interrupt(); // discard, nothing to save
    this.store.clear();
    Object.assign(this.state, { latest: null, speed: null, incident: null });
    this.#refreshUptime();
    this.#emitState();
  }

  prune() {
    try {
      this.store.prune(this.settings.get().retentionDays);
    } catch {
      // Best effort; retried hourly.
    }
  }

  // ---------------------------------------------------------- queries

  history(rangeMs, conn) {
    return this.store.history(this.deps.now() - Number(rangeMs), { conn });
  }

  incidents(rangeMs = 30 * DAY) {
    return this.store.incidents(this.deps.now() - rangeMs, 50);
  }
}

module.exports = { Monitor, SETTLE_AFTER_WAKE_MS, SETTLE_AFTER_CHANGE_MS };
