// History storage. Replaces Redis + Prometheus: every probe and speed test
// is written to a local SQLite file and pruned after the retention period.

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

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
    `);
    this.q = {
      run: this.db.prepare('INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?, ?, ?)'),
      site: this.db.prepare('INSERT INTO site_stats VALUES (?, ?, ?, ?, ?)'),
      dns: this.db.prepare('INSERT INTO dns_stats VALUES (?, ?, ?, ?)'),
      speed: this.db.prepare('INSERT OR REPLACE INTO speed VALUES (?, ?, ?)'),
    };
  }

  saveProbe(ts, result, summary) {
    this.db.exec('BEGIN');
    try {
      this.q.run.run(ts, summary.score, summary.latency, summary.loss, summary.jitter, summary.dnsLatency);
      for (const s of result.stats) this.q.site.run(ts, s.site, s.latency, s.loss, s.jitter);
      for (const d of result.dns) this.q.dns.run(ts, d.name, d.ip, d.latency);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  saveSpeed(ts, { download, upload }) {
    this.q.speed.run(ts, download, upload);
  }

  // Everything the dashboard needs for a time window, in one call. Probe
  // data is averaged into buckets so a 30 day window stays ~720 points per
  // series instead of ~86k.
  history(sinceTs, points = 720) {
    const bucket = Math.max(1, Math.floor((Date.now() - sinceTs) / points));
    const bk = 'CAST(ts / ?1 AS INTEGER) * ?1';
    const grouped = (sql) => this.db.prepare(sql).all(bucket, sinceTs);
    return {
      runs: grouped(`
        SELECT ${bk} AS ts, AVG(score) AS score, AVG(latency) AS latency, AVG(loss) AS loss,
               AVG(jitter) AS jitter, AVG(dns_latency) AS dns_latency
        FROM runs WHERE ts >= ?2 GROUP BY 1 ORDER BY 1`),
      sites: grouped(`
        SELECT ${bk} AS ts, site, AVG(latency) AS latency, AVG(loss) AS loss, AVG(jitter) AS jitter
        FROM site_stats WHERE ts >= ?2 GROUP BY 1, 2 ORDER BY 1`),
      dns: grouped(`
        SELECT ${bk} AS ts, name, AVG(latency) AS latency
        FROM dns_stats WHERE ts >= ?2 GROUP BY 1, 2 ORDER BY 1`),
      // Speed tests are sparse (every 15+ min), so return them raw.
      speed: this.db.prepare('SELECT * FROM speed WHERE ts >= ? ORDER BY ts').all(sinceTs),
    };
  }

  latestSpeed() {
    return this.db.prepare('SELECT * FROM speed ORDER BY ts DESC LIMIT 1').get() ?? null;
  }

  prune(retentionDays) {
    const cutoff = Date.now() - retentionDays * 86400_000;
    for (const t of ['runs', 'site_stats', 'dns_stats', 'speed']) {
      this.db.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cutoff);
    }
  }

  clear() {
    this.db.exec('DELETE FROM runs; DELETE FROM site_stats; DELETE FROM dns_stats; DELETE FROM speed;');
  }

  close() {
    this.db.close();
  }
}

module.exports = { Store };
