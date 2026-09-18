// History storage. Replaces Redis + Prometheus: every probe, speed test and
// incident is written to a local SQLite file and pruned after the retention
// period.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

// Columns added after 1.0; existing databases are upgraded in place.
const RUN_COLUMNS = {
  conn: 'TEXT', // wifi | wired | vpn | unknown
  level: 'TEXT', // ok | degraded | outage
  location: 'TEXT', // home | isp | upstream | internet | vpn (when not ok)
  gw_latency: 'REAL',
  gw_loss: 'REAL',
  isp_latency: 'REAL',
  isp_loss: 'REAL',
  settling: 'INTEGER', // 1 = just after wake / network change, not judged
  p95: 'REAL', // 1.2: 95th percentile latency (avg over sites)
};
const SITE_COLUMNS = { p95: 'REAL' };
const DNS_COLUMNS = { uncached: 'REAL' }; // random-subdomain (uncached) lookup
// Speed tests: latency before and under load (bufferbloat) and data used.
const SPEED_COLUMNS = {
  idle_latency: 'REAL',
  down_latency: 'REAL',
  up_latency: 'REAL',
  bytes: 'REAL',
};

const CONN_FILTERS = new Set(['wifi', 'wired', 'vpn', 'unknown']);

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'netprobe.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        ts INTEGER PRIMARY KEY, score REAL, latency REAL, loss REAL, jitter REAL, dns_latency REAL
      );
      CREATE TABLE IF NOT EXISTS site_stats (
        ts INTEGER, site TEXT, latency REAL, loss REAL, jitter REAL
      );
      CREATE INDEX IF NOT EXISTS site_stats_ts ON site_stats(ts);
      CREATE TABLE IF NOT EXISTS dns_stats (
        ts INTEGER, name TEXT, ip TEXT, latency REAL
      );
      CREATE INDEX IF NOT EXISTS dns_stats_ts ON dns_stats(ts);
      CREATE TABLE IF NOT EXISTS speed (
        ts INTEGER PRIMARY KEY, download REAL, upload REAL
      );
      CREATE TABLE IF NOT EXISTS incidents (
        start INTEGER PRIMARY KEY, end INTEGER, kind TEXT, location TEXT, conn TEXT,
        worst_score REAL, max_loss REAL, max_latency REAL, probes INTEGER, trace TEXT
      );
    `);
    this.#addColumns('runs', RUN_COLUMNS);
    this.#addColumns('site_stats', SITE_COLUMNS);
    this.#addColumns('dns_stats', DNS_COLUMNS);
    this.#addColumns('speed', SPEED_COLUMNS);
    this.q = {
      run: this.db.prepare(`
        INSERT OR REPLACE INTO runs
          (ts, score, latency, loss, jitter, dns_latency, conn, level, location,
           gw_latency, gw_loss, isp_latency, isp_loss, settling, p95)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      site: this.db.prepare('INSERT INTO site_stats (ts, site, latency, loss, jitter, p95) VALUES (?, ?, ?, ?, ?, ?)'),
      dns: this.db.prepare('INSERT INTO dns_stats (ts, name, ip, latency, uncached) VALUES (?, ?, ?, ?, ?)'),
      speed: this.db.prepare(`
        INSERT OR REPLACE INTO speed (ts, download, upload, idle_latency, down_latency, up_latency, bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      incident: this.db.prepare(`
        INSERT INTO incidents (start, end, kind, location, conn, worst_score, max_loss, max_latency, probes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(start) DO UPDATE SET end = excluded.end, kind = excluded.kind,
          location = excluded.location, worst_score = excluded.worst_score,
          max_loss = excluded.max_loss, max_latency = excluded.max_latency, probes = excluded.probes`),
      trace: this.db.prepare('UPDATE incidents SET trace = ? WHERE start = ?'),
    };
  }

  #addColumns(table, columns) {
    const have = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  // ctx: { conn, level, location, settling } (all optional)
  saveProbe(ts, result, summary, ctx = {}) {
    const gw = result.path?.gateway;
    const isp = result.path?.isp;
    this.db.exec('BEGIN');
    try {
      this.q.run.run(
        ts, summary.score, summary.latency, summary.loss, summary.jitter, summary.dnsLatency,
        ctx.conn ?? null, ctx.level ?? null, ctx.location ?? null,
        gw?.latency ?? null, gw?.loss ?? null, isp?.latency ?? null, isp?.loss ?? null,
        ctx.settling ? 1 : 0, summary.p95 ?? null
      );
      for (const s of result.stats) this.q.site.run(ts, s.site, s.latency, s.loss, s.jitter, s.p95 ?? null);
      for (const d of result.dns) this.q.dns.run(ts, d.name, d.ip, d.latency, d.uncached ?? null);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // r: { download, upload, idleLatency?, downLatency?, upLatency?, bytes? }
  saveSpeed(ts, r) {
    this.q.speed.run(
      ts, r.download, r.upload, r.idleLatency ?? null, r.downLatency ?? null, r.upLatency ?? null, r.bytes ?? null
    );
  }

  // Bytes used by speed tests since `sinceTs` (for the monthly data budget).
  speedBytes(sinceTs) {
    return this.db.prepare('SELECT COALESCE(SUM(bytes), 0) AS b FROM speed WHERE ts >= ?').get(sinceTs).b;
  }

  saveIncident(inc) {
    this.q.incident.run(
      inc.start, inc.end ?? null, inc.kind, inc.where ?? null, inc.conn ?? null,
      inc.worstScore, inc.maxLoss, inc.maxLatency ?? null, inc.probes
    );
  }

  saveTrace(start, text) {
    this.q.trace.run(text, start);
  }

  incidents(sinceTs, limit = 50) {
    return this.db
      .prepare(`SELECT * FROM incidents WHERE COALESCE(end, ?) >= ? ORDER BY start DESC LIMIT ?`)
      .all(Date.now(), sinceTs, limit);
  }

  // Incidents left open by a crash or quit are closed at the last probe
  // recorded inside them.
  closeDangling() {
    this.db.exec(`
      UPDATE incidents SET end = COALESCE(
        (SELECT MAX(ts) FROM runs WHERE runs.ts >= incidents.start), incidents.start)
      WHERE end IS NULL`);
  }

  // Share of monitored time in the window that was not inside an outage.
  // Monitored time is approximated as probes x interval, so time when the
  // computer was off doesn't count against uptime.
  uptime(sinceTs, intervalMs) {
    const now = Date.now();
    const probes = this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE ts >= ?').get(sinceTs).n;
    if (!probes) return { uptime: null, incidents: 0, outageMs: 0 };
    const rows = this.db
      .prepare('SELECT start, COALESCE(end, ?) AS end, kind FROM incidents WHERE COALESCE(end, ?) >= ?')
      .all(now, now, sinceTs);
    let outageMs = 0;
    for (const r of rows) if (r.kind === 'outage') outageMs += Math.max(0, r.end - Math.max(r.start, sinceTs));
    const monitored = Math.min(now - sinceTs, probes * intervalMs);
    return { uptime: Math.max(0, 1 - outageMs / Math.max(monitored, 1)), incidents: rows.length, outageMs };
  }

  // Everything the dashboard needs for a time window, in one call. Probe
  // data is averaged into buckets so a 30 day window stays ~720 points per
  // series instead of ~86k. `conn` limits it to one connection type.
  history(sinceTs, { points = 720, conn = null } = {}) {
    const bucket = Math.max(1, Math.floor((Date.now() - sinceTs) / points));
    const filter = CONN_FILTERS.has(conn) ? conn : null;
    const connSql = filter ? 'AND conn = ?3' : '';
    const inRuns = filter ? 'AND ts IN (SELECT ts FROM runs WHERE ts >= ?2 AND conn = ?3)' : '';
    const bk = 'CAST(ts / ?1 AS INTEGER) * ?1';
    const grouped = (sql) => {
      const args = filter ? [bucket, sinceTs, filter] : [bucket, sinceTs];
      return this.db.prepare(sql).all(...args);
    };
    return {
      runs: grouped(`
        SELECT ${bk} AS ts, AVG(score) AS score, AVG(latency) AS latency, AVG(loss) AS loss,
               AVG(jitter) AS jitter, AVG(dns_latency) AS dns_latency, AVG(p95) AS p95,
               AVG(gw_latency) AS gw_latency, AVG(gw_loss) AS gw_loss,
               AVG(isp_latency) AS isp_latency, AVG(isp_loss) AS isp_loss
        FROM runs WHERE ts >= ?2 ${connSql} GROUP BY 1 ORDER BY 1`),
      sites: grouped(`
        SELECT ${bk} AS ts, site, AVG(latency) AS latency, AVG(loss) AS loss, AVG(jitter) AS jitter, AVG(p95) AS p95
        FROM site_stats WHERE ts >= ?2 ${inRuns} GROUP BY 1, 2 ORDER BY 1`),
      dns: grouped(`
        SELECT ${bk} AS ts, name, AVG(latency) AS latency, AVG(uncached) AS uncached
        FROM dns_stats WHERE ts >= ?2 ${inRuns} GROUP BY 1, 2 ORDER BY 1`),
      // Speed tests are sparse (every 15+ min), so return them raw.
      speed: this.db.prepare('SELECT * FROM speed WHERE ts >= ? ORDER BY ts').all(sinceTs),
      incidents: this.incidents(sinceTs, 500).map(({ trace: _t, ...i }) => i),
    };
  }

  // Raw rows for reports and CSV export.
  runsBetween(from, to) {
    return this.db.prepare('SELECT * FROM runs WHERE ts >= ? AND ts < ? ORDER BY ts').all(from, to);
  }

  speedBetween(from, to) {
    return this.db.prepare('SELECT * FROM speed WHERE ts >= ? AND ts < ? ORDER BY ts').all(from, to);
  }

  incidentsBetween(from, to) {
    return this.db
      .prepare('SELECT * FROM incidents WHERE start < ? AND COALESCE(end, ?) >= ? ORDER BY start')
      .all(to, to, from);
  }

  latestSpeed() {
    return this.db.prepare('SELECT * FROM speed ORDER BY ts DESC LIMIT 1').get() ?? null;
  }

  prune(retentionDays) {
    const cutoff = Date.now() - retentionDays * 86400_000;
    for (const t of ['runs', 'site_stats', 'dns_stats', 'speed']) {
      this.db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoff);
    }
    this.db.prepare('DELETE FROM incidents WHERE end IS NOT NULL AND end < ?').run(cutoff);
  }

  clear() {
    this.db.exec(
      'DELETE FROM runs; DELETE FROM site_stats; DELETE FROM dns_stats; DELETE FROM speed; DELETE FROM incidents;'
    );
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store, RUN_COLUMNS, SITE_COLUMNS, DNS_COLUMNS, SPEED_COLUMNS };
