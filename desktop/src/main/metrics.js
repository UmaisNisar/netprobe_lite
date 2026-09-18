// Prometheus exposition of the live state. The first four metrics use the
// exact names and labels of the original netprobe_lite exporter, so the
// original Grafana dashboard works unchanged against Netprobe Desktop; the
// netprobe_* metrics are new.

const escapeLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const underscore = (v) => String(v).trim().replace(/\s+/g, '_');

function family(name, help, samples) {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const [labels, value] of samples) {
    if (value == null || !Number.isFinite(value)) continue;
    const l = Object.entries(labels);
    const ls = l.length ? `{${l.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : '';
    lines.push(`${name}${ls} ${value}`);
  }
  return lines.length > 2 ? lines.join('\n') : null;
}

function metrics(state) {
  const out = [];
  const latest = state.latest;
  const sum = latest?.summary;
  const s = state.settings;

  if (latest) {
    const net = [];
    for (const st of latest.result.stats) {
      net.push([{ type: 'latency', target: st.site }, st.latency]);
      net.push([{ type: 'loss', target: st.site }, st.loss]);
      net.push([{ type: 'jitter', target: st.site }, st.jitter]);
    }
    net.push([{ type: 'latency', target: 'all' }, sum.latency]);
    net.push([{ type: 'loss', target: 'all' }, sum.loss]);
    net.push([{ type: 'jitter', target: 'all' }, sum.jitter]);
    out.push(family('Network_Stats', 'Network statistics for latency and loss from the probe to the destination', net));

    out.push(
      family(
        'DNS_Stats',
        'DNS performance statistics for various DNS servers',
        latest.result.dns.map((d, i) => [{ server: s.dnsServers[i]?.home ? 'My_DNS_Server' : underscore(d.name) }, d.latency])
      )
    );
    out.push(family('Health_Stats', 'Overall internet health function', [[{}, sum.score]]));
  }
  if (state.speed) {
    out.push(
      family('Speed_Stats', 'Speedtest performance statistics', [
        [{ direction: 'download' }, state.speed.download],
        [{ direction: 'upload' }, state.speed.upload],
      ])
    );
  }

  // ---- netprobe_* (new in the desktop version)
  if (latest) {
    out.push(family('netprobe_latency_p95_ms', '95th percentile latency, averaged over sites', [[{}, sum.p95]]));
    const path = latest.result.path ?? {};
    out.push(
      family('netprobe_path_latency_ms', 'Latency to your router and to the ISP\'s first router', [
        [{ hop: 'router' }, path.gateway?.latency],
        [{ hop: 'isp' }, path.isp?.latency],
      ])
    );
    out.push(
      family('netprobe_path_loss_percent', 'Packet loss to your router and to the ISP\'s first router', [
        [{ hop: 'router' }, path.gateway?.loss],
        [{ hop: 'isp' }, path.isp?.loss],
      ])
    );
    out.push(
      family(
        'netprobe_dns_uncached_ms',
        'Uncached (random subdomain) DNS lookup time',
        latest.result.dns.map((d, i) => [{ server: s.dnsServers[i]?.home ? 'My_DNS_Server' : underscore(d.name) }, d.uncached])
      )
    );
    out.push(family('netprobe_last_probe_timestamp_seconds', 'When the latest probe ran', [[{}, latest.ts / 1000]]));
  }
  out.push(
    family('netprobe_incident_open', 'Whether an outage or slowdown is in progress', [
      [{ kind: 'outage' }, state.incident?.kind === 'outage' ? 1 : 0],
      [{ kind: 'degraded' }, state.incident?.kind === 'degraded' ? 1 : 0],
    ])
  );
  out.push(
    family('netprobe_uptime_ratio', 'Share of monitored time without an outage', [
      [{ window: '24h' }, state.uptime?.day?.uptime],
      [{ window: '7d' }, state.uptime?.week?.uptime],
    ])
  );
  const conn = state.connection?.type ?? 'unknown';
  out.push(
    family('netprobe_connection_info', 'Connection carrying internet traffic (1 = current)', [[{ type: conn, name: state.connection?.name ?? '' }, 1]])
  );
  if (state.speed?.idle_latency != null) {
    out.push(
      family('netprobe_bufferbloat_ms', 'Latency idle and under load during the latest speed test', [
        [{ phase: 'idle' }, state.speed.idle_latency],
        [{ phase: 'download' }, state.speed.down_latency],
        [{ phase: 'upload' }, state.speed.up_latency],
      ])
    );
  }
  return out.filter(Boolean).join('\n') + '\n';
}

module.exports = { metrics, escapeLabel };
