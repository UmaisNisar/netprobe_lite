const test = require('node:test');
const assert = require('node:assert');
const { metrics, escapeLabel } = require('../src/main/metrics');

const state = {
  settings: { dnsServers: [{ name: 'Google DNS' }, { name: 'My DNS Server', home: true }] },
  latest: {
    ts: 1_700_000_000_000,
    summary: { score: 0.95, latency: 12, loss: 0, jitter: 1.5, p95: 20 },
    result: {
      stats: [
        { site: 'a.com', latency: 10, loss: 0, jitter: 1 },
        { site: 'b.com', latency: null, loss: 100, jitter: null },
      ],
      dns: [
        { name: 'Google DNS', latency: 30, uncached: 40 },
        { name: 'My DNS Server', latency: 5, uncached: null },
      ],
      path: { gateway: { latency: 2, loss: 0 }, isp: null },
    },
  },
  speed: { download: 5e8, upload: 5e7, idle_latency: 10, down_latency: 20, up_latency: 30 },
  incident: { kind: 'outage' },
  uptime: { day: { uptime: 0.99 }, week: { uptime: null } },
  connection: { type: 'wifi', name: 'Wi-Fi' },
};

test('exposes the original netprobe_lite metrics with their exact names and labels', () => {
  const m = metrics(state);
  assert.match(m, /^# TYPE Network_Stats gauge$/m);
  assert.match(m, /^Network_Stats\{type="latency",target="a.com"\} 10$/m);
  assert.match(m, /^Network_Stats\{type="latency",target="all"\} 12$/m);
  assert.match(m, /^Network_Stats\{type="jitter",target="all"\} 1.5$/m);
  // The original dashboard queries DNS_Stats{server="My_DNS_Server"}.
  assert.match(m, /^DNS_Stats\{server="My_DNS_Server"\} 5$/m);
  assert.match(m, /^DNS_Stats\{server="Google_DNS"\} 30$/m);
  assert.match(m, /^Health_Stats 0.95$/m);
  assert.match(m, /^Speed_Stats\{direction="download"\} 500000000$/m);
});

test('skips values that were not measured', () => {
  const m = metrics(state);
  assert.doesNotMatch(m, /target="b.com"\} null/);
  assert.doesNotMatch(m, /type="latency",target="b.com"/);
  assert.match(m, /^Network_Stats\{type="loss",target="b.com"\} 100$/m);
  assert.doesNotMatch(m, /hop="isp"/);
  assert.doesNotMatch(m, /window="7d"/);
});

test('exposes the new netprobe_* metrics', () => {
  const m = metrics(state);
  assert.match(m, /^netprobe_latency_p95_ms 20$/m);
  assert.match(m, /^netprobe_path_latency_ms\{hop="router"\} 2$/m);
  assert.match(m, /^netprobe_dns_uncached_ms\{server="Google_DNS"\} 40$/m);
  assert.match(m, /^netprobe_incident_open\{kind="outage"\} 1$/m);
  assert.match(m, /^netprobe_incident_open\{kind="degraded"\} 0$/m);
  assert.match(m, /^netprobe_uptime_ratio\{window="24h"\} 0.99$/m);
  assert.match(m, /^netprobe_connection_info\{type="wifi",name="Wi-Fi"\} 1$/m);
  assert.match(m, /^netprobe_bufferbloat_ms\{phase="upload"\} 30$/m);
  assert.match(m, /^netprobe_last_probe_timestamp_seconds 1700000000$/m);
});

test('before the first probe only the always-present metrics appear', () => {
  const m = metrics({ settings: { dnsServers: [] }, latest: null, speed: null, incident: null, uptime: {}, connection: { type: 'unknown' } });
  assert.doesNotMatch(m, /Network_Stats/);
  assert.match(m, /netprobe_incident_open\{kind="outage"\} 0/);
  assert.ok(m.endsWith('\n'));
});

test('label values are escaped', () => {
  assert.strictEqual(escapeLabel('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
});
