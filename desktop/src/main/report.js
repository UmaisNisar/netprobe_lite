// Builds the "evidence for your ISP" report: summary numbers, a daily
// breakdown and the incident list for a period, plus CSV exports. Pure
// functions over rows from the store, so they're easy to test and reuse.

const { bloatGrade, planShare, formatDuration, LOCATIONS } = require('../renderer/lib');

const DAY = 86400_000;

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function mean(values) {
  const v = values.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

const GRADE_ORDER = ['A+', 'A', 'B', 'C', 'D', 'F'];

// Clip an incident to [from, to] and return its duration inside it.
const clipped = (inc, from, to) => Math.max(0, Math.min(inc.end ?? to, to) - Math.max(inc.start, from));

function summarise({ runs, speeds, incidents, from, to, intervalMs, settings }) {
  const monitoredMs = Math.min(to - from, runs.length * intervalMs);
  const outages = incidents.filter((i) => i.kind === 'outage');
  const outageMs = outages.reduce((a, i) => a + clipped(i, from, to), 0);
  const grades = speeds.map((s) => bloatGrade(s)?.grade).filter(Boolean);
  const conn = {};
  for (const r of runs) conn[r.conn ?? 'unknown'] = (conn[r.conn ?? 'unknown'] ?? 0) + 1;
  const where = {};
  for (const i of incidents) if (i.location) where[i.location] = (where[i.location] ?? 0) + 1;

  return {
    from,
    to,
    probes: runs.length,
    monitoredMs,
    coverage: (to - from) > 0 ? monitoredMs / (to - from) : 0,
    uptime: runs.length ? Math.max(0, 1 - outageMs / Math.max(monitoredMs, 1)) : null,
    outages: outages.length,
    slowdowns: incidents.length - outages.length,
    outageMs,
    longestOutageMs: outages.reduce((a, i) => Math.max(a, clipped(i, from, to)), 0),
    blame: where,
    score: mean(runs.map((r) => r.score)),
    latency: { median: median(runs.map((r) => r.latency)), p95: mean(runs.map((r) => r.p95)), worst: Math.max(0, ...runs.map((r) => r.latency ?? 0)) || null },
    loss: { mean: mean(runs.map((r) => r.loss)), badProbes: runs.filter((r) => (r.loss ?? 0) >= 2).length },
    jitter: mean(runs.map((r) => r.jitter)),
    dns: mean(runs.map((r) => r.dns_latency)),
    router: mean(runs.map((r) => r.gw_latency)),
    connections: conn,
    speed: speeds.length
      ? {
          tests: speeds.length,
          down: { mean: mean(speeds.map((s) => s.download)), min: Math.min(...speeds.map((s) => s.download)) },
          up: { mean: mean(speeds.map((s) => s.upload)), min: Math.min(...speeds.map((s) => s.upload)) },
          planDown: settings.planDown || null,
          planUp: settings.planUp || null,
          downShare: planShare(mean(speeds.map((s) => s.download)), settings.planDown),
          upShare: planShare(mean(speeds.map((s) => s.upload)), settings.planUp),
          belowHalfPlan: settings.planDown ? speeds.filter((s) => planShare(s.download, settings.planDown) < 0.5).length : null,
          worstBloat: grades.sort((a, b) => GRADE_ORDER.indexOf(b) - GRADE_ORDER.indexOf(a))[0] ?? null,
        }
      : null,
  };
}

// One row per local calendar day in the period.
function daily({ runs, incidents, from, to, intervalMs }) {
  const days = [];
  const start = new Date(from);
  let dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  while (dayStart < to) {
    const next = new Date(new Date(dayStart).setDate(new Date(dayStart).getDate() + 1)).getTime();
    const lo = Math.max(dayStart, from);
    const hi = Math.min(next, to);
    const dayRuns = runs.filter((r) => r.ts >= lo && r.ts < hi);
    const dayInc = incidents.filter((i) => i.start < hi && (i.end ?? to) > lo);
    const outageMs = dayInc.filter((i) => i.kind === 'outage').reduce((a, i) => a + clipped(i, lo, hi), 0);
    const monitored = Math.min(hi - lo, dayRuns.length * intervalMs);
    days.push({
      day: dayStart,
      probes: dayRuns.length,
      uptime: dayRuns.length ? Math.max(0, 1 - outageMs / Math.max(monitored, 1)) : null,
      outageMs,
      incidents: dayInc.length,
      latency: median(dayRuns.map((r) => r.latency)),
      loss: mean(dayRuns.map((r) => r.loss)),
      score: mean(dayRuns.map((r) => r.score)),
    });
    dayStart = next;
  }
  return days;
}

const pct = (x, d = 1) => (x > 0 && x < 0.01 && d === 0 ? 'under 1%' : `${(x * 100).toFixed(d)}%`);
const ms = (x) => `${x < 10 ? x.toFixed(1) : Math.round(x)} ms`;
const mbpsText = (bps) => `${Math.round(bps / 1e6)} Mbps`;

// Plain-language headline findings, most important first.
function findings(sum) {
  const out = [];
  if (!sum.probes) return ['No measurements were recorded in this period.'];
  if (sum.outages) {
    out.push(
      `Uptime was ${pct(sum.uptime, 2)}: ${sum.outages} outage${sum.outages > 1 ? 's' : ''} totalling ${formatDuration(sum.outageMs)} ` +
        `(longest ${formatDuration(sum.longestOutageMs)}).`
    );
  } else out.push('No outages were recorded (uptime 100% while monitored).');
  if (sum.slowdowns) out.push(`${sum.slowdowns} slowdown${sum.slowdowns > 1 ? 's' : ''} (high packet loss or poor quality) were recorded.`);
  const blamed = Object.entries(sum.blame).sort((a, b) => b[1] - a[1])[0];
  const total = sum.outages + sum.slowdowns;
  if (blamed && total) out.push(`Most incidents (${blamed[1]} of ${total}) were located at: ${LOCATIONS[blamed[0]] ?? blamed[0]}.`);
  if (sum.latency.median != null) {
    out.push(`Median latency was ${ms(sum.latency.median)}${sum.latency.p95 != null ? `, 95th percentile ${ms(sum.latency.p95)}` : ''}; average packet loss ${sum.loss.mean.toFixed(2)}%.`);
  }
  const sp = sum.speed;
  if (sp) {
    let line = `Average download ${mbpsText(sp.down.mean)}, upload ${mbpsText(sp.up.mean)} over ${sp.tests} speed test${sp.tests > 1 ? 's' : ''}`;
    if (sp.downShare != null) line += `: ${pct(sp.downShare, 0)} of the ${sp.planDown} Mbps plan`;
    out.push(line + '.');
    if (sp.belowHalfPlan) out.push(`${sp.belowHalfPlan} of ${sp.tests} tests were below half of the plan's download speed.`);
    if (sp.worstBloat && !['A+', 'A'].includes(sp.worstBloat)) out.push(`Latency under load (bufferbloat) graded as poor as ${sp.worstBloat}.`);
  }
  const wifi = (sum.connections.wifi ?? 0) / sum.probes;
  if (wifi > 0.2) out.push(`${pct(wifi, 0)} of measurements were taken over Wi-Fi, so they include wireless conditions as well as the ISP.`);
  if ((sum.connections.vpn ?? 0) / sum.probes > 0.2) out.push('Some measurements were taken through a VPN and reflect the VPN path.');
  if (sum.coverage < 0.9) out.push(`The computer was monitoring for ${pct(sum.coverage, 0)} of the period; gaps are periods when it was off or asleep.`);
  return out;
}

function buildReport(store, { from, to, settings }) {
  const intervalMs = settings.probeInterval * 1000;
  const runs = store.runsBetween(from, to);
  const speeds = store.speedBetween(from, to);
  const incidents = store.incidentsBetween(from, to);
  const summary = summarise({ runs, speeds, incidents, from, to, intervalMs, settings });
  return {
    generatedAt: Date.now(),
    summary,
    findings: findings(summary),
    daily: daily({ runs, incidents, from, to, intervalMs }),
    incidents,
    // Chart series, downsampled to at most ~600 points; lines break across
    // gaps longer than a few samples (computer off or asleep).
    series: downsample(runs, 600).map((r) => ({ ts: r.ts, score: r.score, latency: r.latency, p95: r.p95, loss: r.loss })),
    seriesGapMs: Math.max(4 * intervalMs, Math.ceil(runs.length / 600) * intervalMs * 3),
    speeds,
    settings: { sites: settings.sites, planDown: settings.planDown, planUp: settings.planUp, probeInterval: settings.probeInterval },
  };
}

function downsample(rows, max) {
  if (rows.length <= max) return rows;
  const size = Math.ceil(rows.length / max);
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const avg = (k) => mean(chunk.map((r) => r[k]));
    out.push({ ts: chunk[0].ts, score: avg('score'), latency: avg('latency'), p95: avg('p95'), loss: avg('loss') });
  }
  return out;
}

// ------------------------------------------------------------ CSV

function csvCell(v) {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const lines = [columns.map((c) => c[0]).join(',')];
  for (const r of rows) lines.push(columns.map(([, get]) => csvCell(get(r))).join(','));
  return lines.join('\r\n') + '\r\n';
}

const iso = (ts) => (ts == null ? null : new Date(ts).toISOString());

function probesCsv(runs) {
  return toCsv(
    [
      ['time', (r) => iso(r.ts)],
      ['score_pct', (r) => (r.score == null ? null : r.score * 100)],
      ['latency_ms', (r) => r.latency],
      ['p95_ms', (r) => r.p95],
      ['loss_pct', (r) => r.loss],
      ['jitter_ms', (r) => r.jitter],
      ['dns_ms', (r) => r.dns_latency],
      ['router_ms', (r) => r.gw_latency],
      ['router_loss_pct', (r) => r.gw_loss],
      ['isp_hop_ms', (r) => r.isp_latency],
      ['isp_hop_loss_pct', (r) => r.isp_loss],
      ['connection', (r) => r.conn],
      ['status', (r) => r.level],
      ['problem_location', (r) => r.location],
    ],
    runs
  );
}

function incidentsCsv(incidents) {
  return toCsv(
    [
      ['start', (i) => iso(i.start)],
      ['end', (i) => iso(i.end)],
      ['duration_s', (i) => (i.end == null ? null : (i.end - i.start) / 1000)],
      ['type', (i) => i.kind],
      ['likely_cause', (i) => i.location],
      ['connection', (i) => i.conn],
      ['worst_score_pct', (i) => (i.worst_score == null ? null : i.worst_score * 100)],
      ['max_loss_pct', (i) => i.max_loss],
      ['max_latency_ms', (i) => i.max_latency],
      ['probes', (i) => i.probes],
    ],
    incidents
  );
}

function speedCsv(speeds) {
  return toCsv(
    [
      ['time', (s) => iso(s.ts)],
      ['download_mbps', (s) => s.download / 1e6],
      ['upload_mbps', (s) => s.upload / 1e6],
      ['idle_latency_ms', (s) => s.idle_latency],
      ['download_latency_ms', (s) => s.down_latency],
      ['upload_latency_ms', (s) => s.up_latency],
      ['bufferbloat_grade', (s) => bloatGrade(s)?.grade ?? null],
      ['data_mb', (s) => (s.bytes == null ? null : s.bytes / 1e6)],
    ],
    speeds
  );
}

module.exports = { buildReport, summarise, findings, daily, downsample, median, mean, toCsv, csvCell, probesCsv, incidentsCsv, speedCsv, DAY };
