// Internet Quality Score, same formula as presentation.py: each metric is
// normalised against its threshold (capped at 1) and subtracted from 1 by
// its weight. 1.0 is perfect, 0.0 is at or beyond every threshold.

function average(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function summarise(result, settings) {
  const { dns } = result;
  // A site with zero replies while others answer is almost always blocking
  // ICMP (amazon.com, netflix.com do), not real loss; the original dropped
  // such sites too. If nothing answers at all, it counts as 100% loss.
  const answering = result.stats.filter((s) => s.latency != null);
  const stats = answering.length ? answering : result.stats;
  const latency = average(stats.map((s) => s.latency));
  const loss = average(stats.map((s) => s.loss));
  const jitter = average(stats.map((s) => s.jitter));
  const p95 = average(stats.map((s) => s.p95));

  // The original looked up the server literally named "My_DNS_Server" and
  // crashed if it was renamed; here the home server is chosen by flag.
  const home = dns.find((d, i) => settings.dnsServers[i]?.home) ?? dns[dns.length - 1];
  const dnsLatency = home ? home.latency : null;

  const { weights: w, thresholds: t } = settings;
  const norm = (value, threshold) => (value == null ? 1 : Math.min(value / threshold, 1));

  // With every ping lost there is no latency or jitter; treat them as maxed out.
  const score =
    1 -
    w.loss * norm(loss, t.loss) -
    w.latency * norm(latency, t.latency) -
    w.jitter * norm(jitter, t.jitter) -
    w.dnsLatency * norm(dnsLatency, t.dnsLatency);

  return {
    score: Math.max(0, Math.min(1, score)),
    latency,
    loss,
    jitter,
    p95,
    dnsLatency,
  };
}

module.exports = { summarise, average };
