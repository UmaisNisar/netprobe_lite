// Electron entry point for the UI tests: loads the real app with a fake
// network so results are deterministic on any machine or CI runner.
//   E2E_DATA      data folder (a fresh temp dir per test)
//   E2E_SCENARIO  'good' (default) or 'outage' (no site answers)

const path = require('node:path');
const { app } = require('electron');

app.setPath('userData', process.env.E2E_DATA);

const src = path.join(__dirname, '..', '..', 'src', 'main');
const probe = require(path.join(src, 'probe'));
const network = require(path.join(src, 'network'));
const speedtest = require(path.join(src, 'speedtest'));
const trace = require(path.join(src, 'trace'));

const outage = process.env.E2E_SCENARIO === 'outage';
const hop = (ip, latency) => ({ ip, latency, loss: latency == null ? 100 : 0, jitter: latency == null ? null : 0.4, p95: latency });

// Patch before the app loads monitor.js, which picks these up.
probe.collect = async (settings, { dnsServers }) => ({
  stats: settings.sites.map((site) =>
    outage
      ? { site, latency: null, loss: 100, jitter: null, p50: null, p95: null, p99: null }
      : { site, latency: 12.3, loss: 0, jitter: 1.1, p50: 12, p95: 15.5, p99: 17 }
  ),
  dns: dnsServers.map((d) => ({ name: d.name, ip: d.ip, latency: outage ? 5000 : 8, ok: !outage, uncached: outage ? null : 21 })),
  path: { gateway: hop('192.168.1.1', 1.5), isp: hop('62.1.1.1', outage ? null : 7.5) },
});
network.detectConnection = async () => ({ type: 'wifi', name: 'Wi-Fi', gateway: '192.168.1.1', dns: ['192.168.1.1'] });
network.discoverHops = async () => ['192.168.1.1', '62.1.1.1'];
speedtest.run = async () => ({ download: 250e6, upload: 20e6, bytes: 2e8, idleLatency: 10, downLatency: 25, upLatency: 60 });
trace.traceroute = async (target) => `traceroute to ${target} (test)`;

require(path.join(src, 'main'));
