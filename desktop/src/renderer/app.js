'use strict';

const api = window.netprobe;
const {
  fmt, mbps, fmtMbps, timeAgo, level, scoreCaption, pivot, esc, LOCATIONS, formatDuration, segmentText, uptimeText, bloatGrade, planShare,
} = window.NetprobeLib;
const $ = (sel) => document.querySelector(sel);

let state = null;
let rangeMs = 6 * 3600_000;
let charts = [];
let lastProbeTs = null;
let lastSpeedTs = null;
let connFilter = '';
let incidents = []; // for chart bands and the incidents table
let incidentKey = null; // refetch incidents when this changes

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function scoreColor(score) {
  const css = getComputedStyle(document.documentElement);
  if (score == null) return css.getPropertyValue('--muted');
  if (score >= 0.8) return css.getPropertyValue('--good');
  if (score >= 0.5) return css.getPropertyValue('--ok');
  return css.getPropertyValue('--bad');
}


// ------------------------------------------------------------ live state

const RATING = { 'v-good': 'good', 'v-ok': 'fair', 'v-bad': 'poor' };

function setValue(id, value, unit, cls = '') {
  const el = $(id);
  el.className = `stat-value ${cls}`;
  el.innerHTML = value === '–' ? '–' : `${value}<small>${unit}</small>`;
  // Screen readers get the rating that sighted users read from the colour.
  const label = el.closest('.stat').querySelector('.card-label').textContent;
  el.setAttribute('aria-label', value === '–' ? `${label}: no data` : `${label}: ${value} ${unit}${RATING[cls] ? `, ${RATING[cls]}` : ''}`);
}

const CONN_LABEL = { wifi: 'Wi-Fi', wired: 'Wired', vpn: 'VPN' };

// The adapter name, unless it just repeats the type ("Wi-Fi", "WiFi").
function distinctName(conn) {
  const letters = (v) => String(v ?? '').replace(/[^a-z]/gi, '').toLowerCase();
  return conn.name && letters(conn.name) !== letters(CONN_LABEL[conn.type]) ? conn.name : null;
}

function renderConnection() {
  const conn = state.connection || { type: 'unknown' };
  const chip = $('#conn-chip');
  chip.hidden = conn.type === 'unknown';
  chip.className = `chip ${conn.type}`;
  chip.textContent = CONN_LABEL[conn.type] ?? '';
  const via = conn.name ? `Internet traffic goes through: ${conn.name}.` : '';
  const why = {
    wifi: 'On Wi-Fi, results include your wireless signal and interference, not just your ISP. Connect by cable for ISP-only measurements.',
    vpn: 'A VPN is active: results measure the path through the VPN, not your ISP. Turn it off for accurate ISP measurements.',
  }[conn.type];
  chip.title = [via, why].filter(Boolean).join('\n\n');
}

function renderIncidentStrip() {
  const inc = state.incident;
  const strip = $('#incident-strip');
  strip.hidden = !inc;
  if (!inc) return;
  strip.className = `incident-strip ${inc.kind}`;
  $('#incident-title').textContent = inc.kind === 'outage' ? 'Internet outage in progress.' : 'Connection degraded.';
  const cause = inc.where ? ` Likely cause: ${LOCATIONS[inc.where]}.` : '';
  $('#incident-detail').textContent = `Since ${new Date(inc.start).toLocaleTimeString()} (${formatDuration(Date.now() - inc.start)}).${cause}`;
}

function hopText(hop, seg) {
  if (!hop) return segmentText('unknown');
  const stats = hop.latency == null ? segmentText(seg) : `${fmt(hop.latency)} ms · ${fmt(hop.loss)}% loss`;
  return `${hop.ip} · ${stats}`;
}

function renderPath() {
  const latest = state.latest;
  const diag = latest?.diag;
  const conn = state.connection;
  const set = (seg, cls, text) => {
    const node = document.querySelector(`.node[data-seg=${seg}]`);
    node.className = `node seg-${cls}`;
    $(`#p-${seg}`).textContent = text;
  };
  const label = CONN_LABEL[conn.type];
  const showName = distinctName(conn);
  const connText = label ? `${label}${showName ? ` · ${conn.name}` : ''}` : 'Connection type unknown';
  set('computer', conn.type === 'unknown' ? 'unknown' : 'ok', connText);
  if (!latest) {
    set('gateway', 'unknown', state.path.gateway ?? '–');
    set('isp', 'unknown', state.path.isp ?? '–');
    set('internet', 'unknown', '–');
    return;
  }
  const { path } = latest.result;
  set('gateway', diag.gateway, hopText(path?.gateway, diag.gateway));
  set('isp', diag.isp, path?.isp ? hopText(path.isp, diag.isp) : "Your ISP's routers don't answer ping");
  const sum = latest.summary;
  if (sum.latency == null) set('internet', 'down', 'No site answered');
  else set('internet', diag.level !== 'ok' ? 'bad' : 'ok', `${fmt(sum.latency)} ms · ${fmt(sum.loss)}% loss`);
  const blamed = { home: 'gateway', isp: 'isp', internet: 'internet', upstream: 'isp' }[diag.where];
  if (blamed) document.querySelector(`.node[data-seg=${blamed}]`).classList.add('blamed');
  const v = $('#verdict');
  if (diag.settling) {
    v.className = 'verdict';
    v.textContent = 'Network just changed, settling…';
  } else if (diag.level === 'ok') {
    // Good enough overall, but say so if a segment of the path is struggling.
    const slow = diag.gateway === 'bad' ? 'home' : diag.isp === 'bad' ? 'isp' : null;
    v.className = slow ? 'verdict warn' : 'verdict good';
    v.textContent = slow ? `Working, but ${LOCATIONS[slow].charAt(0).toLowerCase()}${LOCATIONS[slow].slice(1)} is slow` : 'All clear';
  } else {
    v.className = 'verdict bad';
    v.textContent = `${diag.level === 'outage' ? 'Outage' : 'Problems'}: ${LOCATIONS[diag.where] ?? 'unknown location'}`;
  }
}

function renderUptime() {
  $('#up-day').textContent = uptimeText(state.uptime?.day);
  $('#up-week').textContent = uptimeText(state.uptime?.week);
  $('#inc-week').textContent = state.uptime?.week ? state.uptime.week.incidents : '–';
}

function renderIncidents() {
  const body = $('#incident-rows');
  if (!incidents.length) {
    body.innerHTML = '<tr><td colspan="7" class="muted">No incidents in the last 30 days.</td></tr>';
    return;
  }
  body.innerHTML = incidents
    .map((inc, i) => {
      const ongoing = inc.end == null;
      const duration = formatDuration((inc.end ?? Date.now()) - inc.start);
      return `<tr>
        <td>${esc(new Date(inc.start).toLocaleString())}</td>
        <td>${duration}${ongoing ? '<span class="badge ongoing">ongoing</span>' : ''}</td>
        <td><span class="badge ${inc.kind}">${inc.kind === 'outage' ? 'Outage' : 'Slowdown'}</span></td>
        <td>${esc(LOCATIONS[inc.location] ?? '–')}</td>
        <td>${fmt(inc.max_loss)}%</td>
        <td>${esc(CONN_LABEL[inc.conn] ?? '–')}</td>
        <td>${inc.trace ? `<button class="btn btn-ghost btn-small" data-trace="${i}">Traceroute</button>` : ''}</td></tr>
        <tr class="trace-row" id="trace-${i}" hidden><td colspan="7"><pre>${esc(inc.trace ?? '')}</pre></td></tr>`;
    })
    .join('');
}

$('#incident-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-trace]');
  if (btn) {
    const row = $(`#trace-${btn.dataset.trace}`);
    row.hidden = !row.hidden;
  }
});

async function loadIncidents() {
  incidents = await api.getIncidents(30 * 86400_000);
  renderIncidents();
}

function renderStatus() {
  const el = $('#status');
  if (!state) return;
  let dot = 'live';
  let text;
  if (state.paused) {
    dot = '';
    text = 'Paused';
  } else if (state.sleeping) {
    dot = '';
    text = 'Paused while the computer sleeps';
  } else if (state.speedtesting) {
    dot = 'busy';
    text = 'Running speed test…';
  } else if (state.probing) {
    dot = 'busy';
    text = 'Probing…';
  } else if (state.lastError) {
    dot = '';
    text = `Probe error: ${state.lastError}`;
  } else if (state.nextProbeAt) {
    const s = Math.max(0, Math.round((state.nextProbeAt - Date.now()) / 1000));
    text = `Monitoring · next probe in ${s}s`;
  } else {
    text = 'Monitoring';
  }
  el.innerHTML = `<span class="dot ${dot}"></span><span></span>`;
  el.lastChild.textContent = text;
}

function renderState() {
  const s = state.settings;
  const t = s.thresholds;
  const latest = state.latest;
  const sum = latest?.summary;

  // Gauge
  const score = sum?.score ?? null;
  const arc = Math.PI * 80;
  const fill = $('#gauge-fill');
  fill.style.strokeDasharray = `${(score ?? 0) * arc} 999`;
  fill.style.stroke = scoreColor(score);
  fill.style.opacity = score == null ? 0 : 1; // round caps would draw a dot at 0
  $('#score').textContent = score == null ? '–' : Math.round(score * 100);
  $('#score-caption').textContent = score == null ? 'Waiting for the first probe' : scoreCaption(score);
  $('#gauge').setAttribute('aria-label', score == null ? 'Internet Quality Score not measured yet' : `Internet Quality Score ${Math.round(score * 100)} percent: ${scoreCaption(score)}`);

  // Stat cards
  setValue('#s-latency', fmt(sum?.latency), 'ms', level(sum?.latency, t.latency));
  $('#s-latency-sub').textContent = sum?.p95 != null ? `avg to sites · p95 ${fmt(sum.p95)} ms` : 'avg to sites';
  setValue('#s-loss', fmt(sum?.loss), '%', level(sum?.loss, t.loss));
  setValue('#s-jitter', fmt(sum?.jitter), 'ms', level(sum?.jitter, t.jitter));
  setValue('#s-dns', fmt(sum?.dnsLatency), 'ms', level(sum?.dnsLatency, t.dnsLatency));
  const home = latest?.result.dns[s.dnsServers.findIndex((d) => d.home)];
  $('#s-dns-sub').textContent = home ? `${home.name} (${home.ip})` : 'response time';

  const sp = state.speed;
  setValue('#s-down', fmtMbps(sp?.download), 'Mbps');
  setValue('#s-up', fmtMbps(sp?.upload), 'Mbps');
  let speedSub;
  if (state.speedtesting) speedSub = 'testing now…';
  else if (state.speedSkipped === 'budget') speedSub = 'paused: monthly data budget used';
  else if (state.speedError) speedSub = /429/.test(state.speedError) ? 'rate-limited, backing off' : 'last test failed';
  else if (sp) speedSub = `tested ${timeAgo(sp.ts)}`;
  else speedSub = s.speedtestEnabled ? 'first test pending' : 'speed test off';
  const downShare = planShare(sp?.download, s.planDown);
  if (downShare != null && !state.speedtesting) speedSub += ` · ${Math.round(downShare * 100)}% of plan`;
  $('#s-speed-sub').textContent = speedSub;
  $('#s-speed-sub').title = state.speedError || '';
  const bloat = bloatGrade(sp);
  const upShare = planShare(sp?.upload, s.planUp);
  const upParts = [];
  if (bloat) upParts.push(`bufferbloat ${bloat.grade} (+${Math.round(bloat.increase)} ms)`);
  if (upShare != null) upParts.push(`${Math.round(upShare * 100)}% of plan`);
  $('#s-speed-sub2').textContent = upParts.join(' · ') || (sp ? new Date(sp.ts).toLocaleTimeString() : '\u00a0'); // keeps the card height when empty
  $('#s-speed-sub2').title = bloat ? 'Latency increase while the connection is fully loaded. A+/A: great for calls and games; C or worse: expect lag while uploading or downloading.' : '';

  // Tables
  if (latest) {
    $('#probe-time').textContent = new Date(latest.ts).toLocaleTimeString();
    const rows = latest.result.stats.map((r) => {
      const noReply = r.latency == null;
      return `<tr>
        <td>${esc(r.site)}${noReply ? '<span class="tag" title="This host did not answer any ping. Many sites block ICMP; it is excluded from the score unless every site is silent.">no reply</span>' : ''}</td>
        <td class="${level(r.latency, t.latency)}">${fmt(r.latency)} ms</td>
        <td class="${level(r.loss, t.loss)}">${fmt(r.loss)} %</td>
        <td class="${level(r.jitter, t.jitter)}">${fmt(r.jitter)} ms</td></tr>`;
    });
    $('#site-rows').innerHTML = rows.join('');
    const dnsRows = latest.result.dns.map((d, i) => {
      const isHome = s.dnsServers[i]?.home;
      return `<tr>
        <td>${esc(d.name)}${isHome ? '<span class="tag home">mine</span>' : ''}</td>
        <td class="muted">${esc(d.ip)}</td>
        <td class="${d.ok ? level(d.latency, t.dnsLatency) : 'v-bad'}">${d.ok ? `${fmt(d.latency)} ms` : 'failed'}</td>
        <td class="${d.uncached != null ? level(d.uncached, t.dnsLatency * 3) : ''}">${d.uncached != null ? `${fmt(d.uncached)} ms` : '–'}</td></tr>`;
    });
    $('#dns-rows').innerHTML = dnsRows.join('');
  }

  renderConnection();
  renderIncidentStrip();
  renderPath();
  renderUptime();

  // Buttons (read-only when viewing another computer's Netprobe in a browser)
  const readOnly = api.web && state.web && !state.web.canWrite;
  $('#readonly-note').hidden = !readOnly;
  for (const id of ['#btn-pause', '#btn-settings']) $(id).disabled = readOnly;
  $('#btn-probe').disabled = readOnly || state.probing || state.speedtesting || state.paused;
  $('#btn-speed').disabled = readOnly || state.speedtesting;
  $('#btn-speed').textContent = state.speedtesting ? 'Testing…' : 'Speed test';
  $('#btn-pause').textContent = state.paused ? 'Resume' : 'Pause';

  renderUpdate();
  renderStatus();
}

function renderUpdate() {
  const u = state.update;
  const btn = $('#btn-update');
  btn.hidden = !u || !['ready', 'available'].includes(u.status) || !!api.web;
  if (btn.hidden) return;
  btn.textContent = u.status === 'ready' ? `Restart to update (${u.version})` : `Update available (${u.version})`;
  btn.title = u.status === 'ready' ? 'The new version is downloaded. Netprobe restarts in a few seconds.' : 'Opens the download page.';
}


// ------------------------------------------------------------ charts

const PALETTE = ['#5b8def', '#3ecf8e', '#f6c343', '#e879a6', '#a78bfa', '#22c1d6', '#f59e5b', '#94a3b8'];


function axisColors() {
  const css = getComputedStyle(document.documentElement);
  return { text: css.getPropertyValue('--muted').trim(), grid: css.getPropertyValue('--grid').trim() };
}

// Shades incident periods behind the series (red: outage, amber: slowdown).
function incidentBands() {
  return {
    hooks: {
      drawClear: [
        (u) => {
          const { ctx, bbox } = u;
          ctx.save();
          for (const inc of incidents) {
            const x0 = u.valToPos(inc.start / 1000, 'x', true);
            const x1 = u.valToPos((inc.end ?? Date.now()) / 1000, 'x', true);
            if (x1 < bbox.left || x0 > bbox.left + bbox.width) continue;
            ctx.fillStyle = (inc.kind === 'outage' ? css('--bad') : css('--ok')) + '33';
            const left = Math.max(x0, bbox.left);
            ctx.fillRect(left, bbox.top, Math.max(2, Math.min(x1, bbox.left + bbox.width) - left), bbox.height);
          }
          ctx.restore();
        },
      ],
    },
  };
}

function makeChart(el, { xs, series, yRange, points = false }) {
  el.innerHTML = '';
  if (!xs.length) {
    el.innerHTML = '<div class="empty">No data for this range yet</div>';
    return null;
  }
  const c = axisColors();
  const axis = { stroke: c.text, grid: { stroke: c.grid, width: 1 }, ticks: { stroke: c.grid, width: 1 } };
  const opts = {
    width: el.clientWidth,
    height: PLOT_HEIGHT,
    cursor: { sync: { key: 'np' }, points: { size: 6 }, drag: { x: true, y: false, setScale: true } },
    legend: { live: true },
    plugins: [incidentBands()],
    scales: { x: { time: true }, y: yRange ? { range: yRange } : { auto: true } },
    axes: [axis, { ...axis, size: 48 }],
    series: [
      {},
      ...series.map((s) => ({
        label: s.label,
        stroke: s.color,
        width: s.width ?? 1.5,
        dash: s.dash,
        fill: s.fill,
        spanGaps: false,
        points: { show: points, size: 5, fill: s.color },
        value: (_u, v) => (v == null ? '–' : v.toFixed(s.digits ?? 1)),
      })),
    ],
  };
  const u = new uPlot(opts, [xs, ...series.map((s) => s.data)], el);
  fitToLegend(u, el);
  return u;
}

// Plots keep a fixed height; the card grows when the legend wraps onto
// extra lines (many sites), instead of the legend squeezing the plot.
const PLOT_HEIGHT = 220;
function fitToLegend(u, el) {
  u.setSize({ width: el.clientWidth, height: PLOT_HEIGHT });
}

function withAverage(p, runs, field, gapMs) {
  const avg = pivot(runs, null, (r) => r[field], gapMs);
  // Align the average series onto the per-site x values.
  const lookup = new Map(avg.xs.map((x, i) => [x, avg.ys[0][i]]));
  const series = p.keys.map((k, i) => ({ label: k, color: PALETTE[i % PALETTE.length], data: p.ys[i] }));
  series.push({
    label: 'Average',
    color: css('--text'),
    width: 2.25,
    data: p.xs.map((x) => lookup.get(x) ?? null),
  });
  return series;
}

async function loadHistory() {
  const h = await api.getHistory(rangeMs, connFilter || null);
  incidents = mergeTraces(h.incidents);
  const probeGap = Math.max(rangeMs / 720, (state?.settings.probeInterval ?? 30) * 1000) * 3.5;
  charts.forEach((u) => u?.destroy());
  charts = [];

  const good = css('--good');
  const accent = css('--accent');

  const score = pivot(h.runs, null, (r) => r.score * 100, probeGap);
  charts.push(
    makeChart($('#c-score'), {
      xs: score.xs,
      yRange: [0, 100],
      series: [{ label: 'Score %', color: good, width: 2, fill: good + '22', data: score.ys[0] ?? [], digits: 0 }],
    })
  );

  for (const [id, field] of [['#c-latency', 'latency'], ['#c-loss', 'loss'], ['#c-jitter', 'jitter']]) {
    const p = pivot(h.sites, 'site', (r) => r[field], probeGap);
    const series = withAverage(p, h.runs, field, probeGap);
    if (field === 'latency') {
      const p95 = pivot(h.runs, null, (r) => r.p95, probeGap);
      const lookup = new Map(p95.xs.map((x, i) => [x, p95.ys[0][i]]));
      series.push({ label: 'p95 (avg)', color: css('--muted'), width: 1.5, dash: [5, 4], data: p.xs.map((x) => lookup.get(x) ?? null) });
    }
    charts.push(makeChart($(id), { xs: p.xs, series }));
  }

  const pathRuns = (field) => pivot(h.runs, null, (r) => r[field], probeGap);
  const gw = pathRuns('gw_latency');
  const isp = pathRuns('isp_latency');
  const sites = pathRuns('latency');
  charts.push(
    makeChart($('#c-path'), {
      xs: sites.xs,
      series: [
        { label: 'Your router', color: PALETTE[1], data: gw.ys[0] ?? [] },
        { label: "ISP's first router", color: PALETTE[2], data: isp.ys[0] ?? [] },
        { label: 'Sites (avg)', color: css('--text'), width: 2, data: sites.ys[0] ?? [] },
      ],
    })
  );

  const dns = pivot(h.dns, 'name', (r) => r.latency, probeGap);
  charts.push(
    makeChart($('#c-dns'), {
      xs: dns.xs,
      series: dns.keys.map((k, i) => ({ label: k, color: PALETTE[i % PALETTE.length], data: dns.ys[i] })),
    })
  );

  const speedGap = (state?.settings.speedtestInterval ?? 937) * 1000 * 3.5;
  const down = pivot(h.speed, null, (r) => mbps(r.download), speedGap);
  const up = pivot(h.speed, null, (r) => mbps(r.upload), speedGap);
  const speedSeries = [
    { label: 'Download', color: accent, width: 2, data: down.ys[0] ?? [], digits: 0 },
    { label: 'Upload', color: good, width: 2, data: up.ys[0] ?? [], digits: 0 },
  ];
  const plan = state?.settings ?? {};
  if (plan.planDown) speedSeries.push({ label: 'Plan (down)', color: accent, width: 1, dash: [6, 4], data: down.xs.map(() => plan.planDown), digits: 0 });
  if (plan.planUp) speedSeries.push({ label: 'Plan (up)', color: good, width: 1, dash: [6, 4], data: down.xs.map(() => plan.planUp), digits: 0 });
  charts.push(makeChart($('#c-speed'), { xs: down.xs, points: true, series: speedSeries }));
}

// History rows carry no traces; keep the ones already loaded for the table.
function mergeTraces(list) {
  const traces = new Map(incidents.map((i) => [i.start, i.trace]));
  return list.map((i) => ({ ...i, trace: traces.get(i.start) ?? null }));
}

const resizeObserver = new ResizeObserver(() => {
  for (const u of charts) {
    if (!u) continue;
    fitToLegend(u, u.root.parentElement);
  }
});
document.querySelectorAll('.chart').forEach((el) => resizeObserver.observe(el));

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  loadHistory();
  if (state) renderState();
});

$('#conn-filter').addEventListener('change', (e) => {
  connFilter = e.target.value;
  loadHistory();
});

$('#range').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  document.querySelectorAll('#range button').forEach((b) => {
    b.classList.toggle('active', b === btn);
    b.setAttribute('aria-selected', String(b === btn));
  });
  rangeMs = Number(btn.dataset.range);
  loadHistory();
});

// ------------------------------------------------------------ actions

$('#btn-probe').addEventListener('click', () => api.probeNow());
$('#btn-speed').addEventListener('click', () => api.speedtestNow());
$('#btn-pause').addEventListener('click', () => api.togglePause());
$('#btn-update').addEventListener('click', () => (state.update?.status === 'ready' ? api.installUpdate() : api.openUpdate()));

// ------------------------------------------------------------ settings

const dialog = $('#settings');
const form = $('#settings-form');

function dnsRow(server = { name: '', ip: '', home: false }) {
  const row = document.createElement('div');
  row.className = 'dns-row';
  row.innerHTML = `
    <input type="text" placeholder="Name" data-f="name">
    <input type="text" placeholder="IP address" data-f="ip" spellcheck="false">
    <label title="The DNS server your network uses; counts toward the score"><input type="radio" name="dnsHome"> mine</label>
    <label title="Follow the DNS server of whichever network you're on"><input type="checkbox" data-f="auto"> auto</label>
    <button type="button" class="btn btn-ghost btn-small" aria-label="Remove">✕</button>`;
  row.querySelector('[data-f=name]').value = server.name;
  row.querySelector('[data-f=ip]').value = server.ip;
  const radio = row.querySelector('input[type=radio]');
  const auto = row.querySelector('[data-f=auto]');
  radio.checked = !!server.home;
  auto.checked = !!server.auto;
  row.querySelector('button').addEventListener('click', () => row.remove());
  return row;
}

// "auto" only applies to the server marked "mine".
function syncAutoBoxes() {
  for (const row of document.querySelectorAll('#dns-list .dns-row')) {
    const mine = row.querySelector('input[type=radio]').checked;
    const auto = row.querySelector('[data-f=auto]');
    auto.disabled = !mine;
    if (!mine) auto.checked = false;
  }
}

function renderServerHint() {
  const info = state?.server;
  let text;
  if (api.web) text = 'You are viewing this dashboard through the web server.';
  else if (info?.error) text = `Web server error: ${info.error}`;
  else if (info?.urls) text = `Running at ${info.urls.join('  ·  ')}  (metrics at /metrics)`;
  else text = 'Other devices, or Grafana/Prometheus, can use this while the app runs. For 24/7 use, see "Always-on mode" in the README.';
  $('#server-hint').textContent = text;
}

$('#token-new').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  form.serverToken.value = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);
});

function updateWeightSum() {
  const sum = ['loss', 'latency', 'jitter', 'dnsLatency'].reduce((a, k) => a + (Number(form[`w.${k}`].value) || 0), 0);
  const el = $('#weight-sum');
  el.textContent = `Weights add up to ${sum.toFixed(2)}`;
  el.className = Math.abs(sum - 1) > 0.001 ? 'hint v-bad' : 'hint';
}

function openSettings() {
  const s = state.settings;
  form.sites.value = s.sites.join('\n');
  form.probeInterval.value = s.probeInterval;
  form.pingCount.value = s.pingCount;
  form.dnsTestSite.value = s.dnsTestSite;
  const list = $('#dns-list');
  list.innerHTML = '';
  s.dnsServers.forEach((d) => list.appendChild(dnsRow(d)));
  syncAutoBoxes();
  form.speedtestEnabled.checked = s.speedtestEnabled;
  form.speedtestIntervalMin.value = Math.round(s.speedtestInterval / 60);
  form.querySelector(`input[name=speedtestSchedule][value=${s.speedtestSchedule}]`).checked = true;
  form.speedtestTimes.value = s.speedtestTimes.join(', ');
  form.planDown.value = s.planDown || '';
  form.planUp.value = s.planUp || '';
  form.speedtestBudgetGB.value = s.speedtestBudgetGB;
  const used = (state.speedUsage?.month ?? 0) / 1e9;
  $('#usage-hint').textContent = `Speed tests have used ${used.toFixed(used < 10 ? 2 : 0)} GB this month.`;
  for (const k of Object.keys(s.weights)) form[`w.${k}`].value = s.weights[k];
  for (const k of Object.keys(s.thresholds)) form[`t.${k}`].value = s.thresholds[k];
  form.openAtLogin.checked = s.openAtLogin;
  form.openAtLogin.closest('label').hidden = !!api.web; // not meaningful in a browser
  form.autoUpdate.checked = s.autoUpdate;
  form.autoUpdate.closest('label').hidden = !!api.web;
  $('#version-hint').textContent = state.version ? `Version ${state.version}${state.update?.status === 'error' ? ' · last update check failed' : ''}` : '';
  form.serverEnabled.checked = s.server.enabled;
  form.serverPort.value = s.server.port;
  form.serverLan.checked = s.server.lan;
  form.serverToken.value = s.server.token;
  renderServerHint();
  form.alertsNotify.checked = s.alerts.notify;
  form.degradedScore.value = Math.round(s.alerts.degradedScore * 100);
  form.degradedLoss.value = s.alerts.degradedLoss;
  form.retentionDays.value = s.retentionDays;
  $('#save-msg').textContent = '';
  updateWeightSum();
  dialog.showModal();
}

form.addEventListener('input', (e) => {
  if (e.target.name?.startsWith('w.')) updateWeightSum();
  if (e.target.name === 'dnsHome') syncAutoBoxes();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const dnsServers = [...document.querySelectorAll('#dns-list .dns-row')].map((row) => ({
    name: row.querySelector('[data-f=name]').value,
    ip: row.querySelector('[data-f=ip]').value,
    home: row.querySelector('input[type=radio]').checked,
    auto: row.querySelector('[data-f=auto]').checked,
  }));
  const num = (name) => Number(form[name].value);
  const next = {
    sites: form.sites.value.split(/[\s,]+/).filter(Boolean),
    probeInterval: num('probeInterval'),
    pingCount: num('pingCount'),
    dnsTestSite: form.dnsTestSite.value,
    dnsServers,
    speedtestEnabled: form.speedtestEnabled.checked,
    speedtestInterval: num('speedtestIntervalMin') * 60,
    speedtestSchedule: form.querySelector('input[name=speedtestSchedule]:checked')?.value ?? 'interval',
    speedtestTimes: form.speedtestTimes.value,
    planDown: num('planDown'),
    planUp: num('planUp'),
    speedtestBudgetGB: num('speedtestBudgetGB'),
    weights: { loss: num('w.loss'), latency: num('w.latency'), jitter: num('w.jitter'), dnsLatency: num('w.dnsLatency') },
    thresholds: { loss: num('t.loss'), latency: num('t.latency'), jitter: num('t.jitter'), dnsLatency: num('t.dnsLatency') },
    openAtLogin: form.openAtLogin.checked,
    autoUpdate: form.autoUpdate.checked,
    server: {
      enabled: form.serverEnabled.checked,
      port: num('serverPort'),
      lan: form.serverLan.checked,
      token: form.serverToken.value,
    },
    alerts: { notify: form.alertsNotify.checked, degradedScore: num('degradedScore') / 100, degradedLoss: num('degradedLoss') },
    retentionDays: num('retentionDays'),
  };
  try {
    await api.saveSettings(next);
    dialog.close();
  } catch (err) {
    $('#save-msg').textContent = `Could not save: ${err.message}`;
  }
});

$('#btn-settings').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', () => dialog.close());
$('#settings-cancel').addEventListener('click', () => dialog.close());
$('#dns-add').addEventListener('click', () => {
  $('#dns-list').appendChild(dnsRow());
  syncAutoBoxes();
});
$('#clear-history').addEventListener('click', async () => {
  if (!confirm('Delete all recorded history? This cannot be undone.')) return;
  await api.clearHistory();
  loadHistory();
  loadIncidents();
});
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close(); // click on backdrop
});

// ------------------------------------------------------------ export

const exportDialog = $('#export');
const exportForm = $('#export-form');
const toDateInput = (ts) => new Date(ts - new Date(ts).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

$('#btn-export').addEventListener('click', () => {
  $('#export-msg').textContent = '';
  exportForm.from.value = toDateInput(Date.now() - 7 * 86400_000);
  exportForm.to.value = toDateInput(Date.now());
  exportDialog.showModal();
});
exportForm.range.addEventListener('change', () => {
  $('#export-custom').hidden = exportForm.range.value !== 'custom';
});
$('#export-cancel').addEventListener('click', () => exportDialog.close());
exportForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  let from;
  let to = Date.now();
  if (exportForm.range.value === 'custom') {
    from = new Date(`${exportForm.from.value}T00:00`).getTime();
    to = new Date(`${exportForm.to.value}T00:00`).getTime() + 86400_000; // include the "to" day
  } else from = to - Number(exportForm.range.value);
  const btn = $('#export-go');
  btn.disabled = true;
  $('#export-msg').textContent = 'Preparing…';
  try {
    const files = await api.exportReport({ from, to, format: exportForm.format.value });
    if (files) exportDialog.close();
    else $('#export-msg').textContent = '';
  } catch (err) {
    $('#export-msg').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------ welcome

const welcome = $('#welcome');
const welcomeForm = $('#welcome-form');

function renderWelcomeConnection() {
  const c = state.connection;
  const parts = [];
  if (c.type === 'unknown' && !c.gateway) parts.push('Still detecting your connection…');
  else {
    const name = distinctName(c);
    parts.push(`<strong>${esc(CONN_LABEL[c.type] ?? 'Unknown connection')}</strong>${name ? ` (${esc(name)})` : ''}`);
    if (c.gateway) parts.push(`router ${esc(c.gateway)}`);
    if (c.dns?.length) parts.push(`DNS ${esc(c.dns[0])}`);
  }
  $('#welcome-conn').innerHTML = parts.join(' · ');
  $('#welcome-conn-tip').textContent =
    c.type === 'wifi'
      ? "You're on Wi-Fi, so results will include your wireless signal as well as your ISP. For ISP-only measurements, use an Ethernet cable."
      : c.type === 'vpn'
        ? 'A VPN is active, so results will measure the VPN path. Turn it off to measure your ISP.'
        : '';
}

function maybeWelcome() {
  if (api.web || state.settings.onboarded || welcome.open) return;
  const s = state.settings;
  welcomeForm.speedtestEnabled.checked = s.speedtestEnabled;
  welcomeForm.planDown.value = s.planDown || '';
  welcomeForm.planUp.value = s.planUp || '';
  welcomeForm.alertsNotify.checked = s.alerts.notify;
  welcomeForm.openAtLogin.checked = s.openAtLogin;
  renderWelcomeConnection();
  welcome.showModal();
}

welcomeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = state.settings;
  await api.saveSettings({
    ...s,
    onboarded: true,
    speedtestEnabled: welcomeForm.speedtestEnabled.checked,
    planDown: Number(welcomeForm.planDown.value) || 0,
    planUp: Number(welcomeForm.planUp.value) || 0,
    alerts: { ...s.alerts, notify: welcomeForm.alertsNotify.checked },
    openAtLogin: welcomeForm.openAtLogin.checked,
  });
  welcome.close();
});
// Escape shouldn't skip it silently: treat closing as "keep the defaults".
welcome.addEventListener('cancel', (e) => {
  e.preventDefault();
  welcomeForm.requestSubmit();
});

// ------------------------------------------------------------ boot

function onState(next) {
  state = next;
  renderState();
  if (welcome.open) renderWelcomeConnection();
  else maybeWelcome();
  const probeTs = state.latest?.ts ?? null;
  const speedTs = state.speed?.ts ?? null;
  if (probeTs !== lastProbeTs || speedTs !== lastSpeedTs) {
    lastProbeTs = probeTs;
    lastSpeedTs = speedTs;
    loadHistory();
  }
  const key = state.incident ? `${state.incident.start}:${state.incident.kind}` : 'none';
  if (key !== incidentKey) {
    incidentKey = key;
    loadIncidents();
  }
}

api.onState(onState);
api.getState().then((s) => {
  onState(s);
  loadHistory();
});
setInterval(() => {
  renderStatus();
  if (state?.incident) renderIncidentStrip();
}, 1000);
