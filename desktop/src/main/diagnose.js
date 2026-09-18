// Judges a single probe: how bad is it (ok / degraded / outage) and where is
// the problem most likely to be (your home network, your ISP, or beyond).

// Segment health limits. A home router should answer in a few ms with no
// loss; the ISP's first router is allowed more latency.
const LIMITS = {
  gateway: { loss: 2, latency: 50, jitter: 20 },
  isp: { loss: 2, latency: 100, jitter: 30 },
};

// Labels are shared with the dashboard.
const { LOCATIONS } = require('../renderer/lib');

function severity(summary, result, alerts) {
  if (!result.stats.length || result.stats.every((s) => s.latency == null)) return 'outage';
  if (summary.score < alerts.degradedScore || (summary.loss ?? 0) >= alerts.degradedLoss) return 'degraded';
  return 'ok';
}

// A hop that answered nothing while sites did is ignoring ping (many
// routers deprioritise ICMP to themselves), not broken.
function segment(hop, limits, sitesAnswered) {
  if (!hop) return 'unknown';
  if (hop.latency == null) return sitesAnswered ? 'silent' : 'down';
  if (hop.loss >= limits.loss || hop.latency >= limits.latency || (hop.jitter ?? 0) >= limits.jitter) return 'bad';
  return 'ok';
}

function locate(result, connection) {
  const sitesAnswered = result.stats.some((s) => s.latency != null);
  const gw = segment(result.path?.gateway, LIMITS.gateway, sitesAnswered);
  const isp = segment(result.path?.isp, LIMITS.isp, sitesAnswered);
  if (connection?.type === 'vpn') return { where: 'vpn', gateway: gw, isp };
  let where;
  if (gw === 'bad' || gw === 'down') where = 'home';
  else if (isp === 'bad' || isp === 'down') where = 'isp';
  else if (isp === 'ok') where = 'internet';
  else where = 'upstream';
  return { where, gateway: gw, isp };
}

function diagnose(summary, result, settings, connection) {
  const level = severity(summary, result, settings.alerts);
  const loc = locate(result, connection);
  return { level, where: level === 'ok' ? null : loc.where, gateway: loc.gateway, isp: loc.isp };
}

module.exports = { diagnose, severity, locate, segment, LIMITS, LOCATIONS };
