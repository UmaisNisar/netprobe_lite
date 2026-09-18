'use strict';

// Fills report.html from the data built by src/main/report.js. The main
// process calls window.renderReport(data) and prints the page to PDF.

const { fmt, fmtMbps, esc, LOCATIONS, formatDuration, bloatGrade, planShare } = window.NetprobeLib;
const $ = (sel) => document.querySelector(sel);
const CONN = { wifi: 'Wi-Fi', wired: 'Wired', vpn: 'VPN', unknown: 'Unknown' };
const dateFmt = { year: 'numeric', month: 'short', day: 'numeric' };
const pctText = (x, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);

function tile(k, v, s = '') {
  return `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
}

function chart(el, xs, series, yRange) {
  if (!xs.length) {
    el.innerHTML = '<div class="muted">No data</div>';
    return Promise.resolve();
  }
  const axis = { stroke: '#5f6878', grid: { stroke: '#eef0f5', width: 1 }, ticks: { stroke: '#eef0f5', width: 1 }, font: '10px "Segoe UI", sans-serif' };
  new uPlot(
    {
      width: 700,
      height: 150,
      cursor: { show: false },
      legend: { show: series.length > 1 },
      scales: { x: { time: true }, y: yRange ? { range: yRange } : {} },
      axes: [axis, { ...axis, size: 40 }],
      series: [{}, ...series.map((s) => ({ label: s.label, stroke: s.color, width: s.width ?? 1.25, fill: s.fill, spanGaps: false, points: { show: false } }))],
    },
    [xs, ...series.map((s) => s.data)],
    el
  );
  return new Promise((r) => requestAnimationFrame(() => r()));
}

// Break lines across gaps (computer off) like the dashboard does.
function withGaps(series, gapMs) {
  const xs = [];
  const rows = [];
  series.forEach((p, i) => {
    if (i && p.ts - series[i - 1].ts > gapMs) {
      xs.push((series[i - 1].ts + 1) / 1000);
      rows.push(null);
    }
    xs.push(p.ts / 1000);
    rows.push(p);
  });
  return { xs, col: (k, f = (v) => v) => rows.map((r) => (r?.[k] == null ? null : f(r[k]))) };
}

window.renderReport = async function renderReport(data) {
  const { summary: sum, settings } = data;
  const from = new Date(sum.from);
  const to = new Date(sum.to);
  $('#period').textContent = `${from.toLocaleString(undefined, dateFmt)} ${from.toLocaleTimeString()} – ${to.toLocaleString(undefined, dateFmt)} ${to.toLocaleTimeString()}`;
  $('#generated').innerHTML = `Generated ${esc(new Date(data.generatedAt).toLocaleString())}<br>by Netprobe Desktop`;
  $('#findings').innerHTML = data.findings.map((f) => `<li>${esc(f)}</li>`).join('');

  const sp = sum.speed;
  $('#tiles').innerHTML = [
    tile('Uptime (while monitored)', pctText(sum.uptime, 2), sum.outages ? `${sum.outages} outage(s), ${formatDuration(sum.outageMs)}` : 'no outages'),
    tile('Median latency', sum.latency.median == null ? '–' : `${fmt(sum.latency.median)} ms`, sum.latency.p95 == null ? '' : `95th pct ${fmt(sum.latency.p95)} ms`),
    tile('Average packet loss', sum.loss.mean == null ? '–' : `${sum.loss.mean.toFixed(2)}%`, `${sum.loss.badProbes} probe(s) ≥ 2%`),
    tile('Average quality score', pctText(sum.score, 0), `${sum.probes} probes, ${sum.coverage > 0 && sum.coverage < 0.01 ? 'under 1%' : pctText(sum.coverage, 0)} of period monitored`),
    tile('Jitter', sum.jitter == null ? '–' : `${fmt(sum.jitter)} ms`),
    tile('DNS (your server)', sum.dns == null ? '–' : `${fmt(sum.dns)} ms`),
    tile('Download (avg)', sp ? `${fmtMbps(sp.down.mean)} Mbps` : '–', sp?.downShare != null ? `${pctText(sp.downShare, 0)} of ${sp.planDown} Mbps plan` : sp ? `min ${fmtMbps(sp.down.min)} Mbps` : 'no speed tests'),
    tile('Upload (avg)', sp ? `${fmtMbps(sp.up.mean)} Mbps` : '–', sp?.upShare != null ? `${pctText(sp.upShare, 0)} of ${sp.planUp} Mbps plan` : sp ? `min ${fmtMbps(sp.up.min)} Mbps` : ''),
  ].join('');

  const g = withGaps(data.series, data.seriesGapMs);
  await chart($('#c-score'), g.xs, [{ label: 'Score', color: '#16a36b', fill: '#16a36b22', data: g.col('score', (v) => v * 100) }], [0, 100]);
  await chart($('#c-latency'), g.xs, [
    { label: 'Average', color: '#2f6fe4', data: g.col('latency') },
    { label: '95th percentile', color: '#c98a00', data: g.col('p95') },
  ]);
  await chart($('#c-loss'), g.xs, [{ label: 'Loss', color: '#d63d3a', data: g.col('loss') }]);

  $('#incidents').innerHTML = data.incidents.length
    ? data.incidents
        .map(
          (i) => `<tr>
            <td>${esc(new Date(i.start).toLocaleString())}</td>
            <td>${i.end ? esc(new Date(i.end).toLocaleString()) : 'ongoing'}</td>
            <td>${formatDuration((i.end ?? sum.to) - i.start)}</td>
            <td class="${i.kind === 'outage' ? 'bad' : 'warn'}">${i.kind === 'outage' ? 'Outage' : 'Slowdown'}</td>
            <td>${esc(LOCATIONS[i.location] ?? '–')}</td>
            <td>${fmt(i.max_loss)}%</td>
            <td>${esc(CONN[i.conn] ?? '–')}</td></tr>`
        )
        .join('')
    : '<tr><td colspan="7" class="muted">No incidents in this period.</td></tr>';

  $('#daily').innerHTML = data.daily
    .map(
      (d) => `<tr>
        <td>${esc(new Date(d.day).toLocaleDateString(undefined, { weekday: 'short', ...dateFmt }))}</td>
        <td class="${d.uptime != null && d.uptime < 0.99 ? 'bad' : ''}">${pctText(d.uptime, 2)}</td>
        <td>${d.outageMs ? formatDuration(d.outageMs) : '–'}</td>
        <td>${d.incidents || '–'}</td>
        <td>${d.latency == null ? '–' : `${fmt(d.latency)} ms`}</td>
        <td>${d.loss == null ? '–' : `${d.loss.toFixed(2)}%`}</td>
        <td>${pctText(d.score, 0)}</td>
        <td class="muted">${d.probes}</td></tr>`
    )
    .join('');

  if (!data.speeds.length) $('#speed-section').hidden = true;
  $('#speeds').innerHTML = data.speeds
    .map((s) => {
      const bloat = bloatGrade(s);
      const share = planShare(s.download, settings.planDown);
      return `<tr>
        <td>${esc(new Date(s.ts).toLocaleString())}</td>
        <td>${fmtMbps(s.download)} Mbps</td>
        <td>${fmtMbps(s.upload)} Mbps</td>
        <td class="${share != null && share < 0.5 ? 'bad' : ''}">${pctText(share, 0)}</td>
        <td>${s.idle_latency == null ? '–' : `${fmt(s.idle_latency)} ms`}</td>
        <td>${s.down_latency == null ? '–' : `${fmt(Math.max(s.down_latency, s.up_latency ?? 0))} ms`}</td>
        <td>${bloat ? `${bloat.grade} (+${Math.round(bloat.increase)} ms)` : '–'}</td></tr>`;
    })
    .join('');

  $('#method').textContent =
    `How this was measured: every ${settings.probeInterval} s, 50 pings to each of ${settings.sites.join(', ')}, ` +
    'plus pings to the home router and the ISP\'s first router and DNS lookups. An outage is two probes in a row where no site ' +
    'answered; a slowdown is three probes in a row with high packet loss or a low quality score. "Likely cause" compares the ' +
    'router, the ISP\'s first router and the websites to find where problems start. Speed tests use speed.cloudflare.com; ' +
    'bufferbloat is the latency increase while the connection is fully loaded. Times are local to the computer that recorded them.';
  return true;
};
