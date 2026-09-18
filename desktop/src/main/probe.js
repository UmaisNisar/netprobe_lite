// Network probe: ping loss/latency/jitter per site and DNS response time per
// nameserver. Port of helpers/network_helper.py that works on Windows, macOS
// and Linux without admin rights by driving the OS ping binary.

const { spawn } = require('node:child_process');
const { Resolver } = require('node:dns').promises;
const { performance } = require('node:perf_hooks');

const IS_WIN = process.platform === 'win32';

// Reply lines carry the RTT as "time=12ms" (Windows), "time<1ms" (Windows,
// sub-millisecond) or "time=12.3 ms" (Unix). The keyword is localised on
// Windows ("Zeit=", "temps=") so only the "=12ms" / "<1ms" shape is matched.
// Summary lines ("Minimum = 10ms", "rtt min/avg/max = ...") have a space
// after "=" and are deliberately not matched.
const RTT_RE = /([=<])(\d+(?:[.,]\d+)?) ?ms\b/i;

function parseRtts(output) {
  const rtts = [];
  for (const line of output.split(/\r?\n/)) {
    // Every successful echo reply carries a TTL on all platforms; this also
    // filters out "Destination host unreachable" style lines.
    if (!/ttl/i.test(line)) continue;
    const m = line.match(RTT_RE);
    if (!m) continue;
    const value = parseFloat(m[2].replace(',', '.'));
    // "time<1ms" means somewhere under a millisecond; take the midpoint.
    rtts.push(m[1] === '<' ? value / 2 : value);
  }
  return rtts;
}

function runPing(host, count, timeoutMs) {
  let args;
  if (IS_WIN) args = ['-n', String(count), '-w', String(timeoutMs), host];
  // macOS takes -W in milliseconds, Linux (iputils) in seconds.
  else if (process.platform === 'darwin') args = ['-n', '-c', String(count), '-W', String(timeoutMs), host];
  else args = ['-n', '-c', String(count), '-W', String(Math.ceil(timeoutMs / 1000)), host];

  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('ping', args, { windowsHide: true });
    } catch {
      resolve({ sent: count, rtts: [] });
      return;
    }
    // Hard stop in case the binary hangs (e.g. DNS resolution of the host).
    const killer = setTimeout(() => child.kill(), count * (timeoutMs + 1000) + 5000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => {});
    child.on('close', () => {
      clearTimeout(killer);
      resolve({ sent: count, rtts: parseRtts(out) });
    });
  });
}

// Jitter as the mean absolute difference between consecutive RTTs
// (RFC 3550 style). The original reported ping's mdev, which is a standard
// deviation rather than jitter.
function jitterOf(sequences) {
  let total = 0;
  let pairs = 0;
  for (const seq of sequences) {
    for (let i = 1; i < seq.length; i++) {
      total += Math.abs(seq[i] - seq[i - 1]);
      pairs++;
    }
  }
  return pairs ? total / pairs : 0;
}

const round = (n, d = 2) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

// Ping binaries send roughly one packet per second without root, so the
// requested count is split across parallel ping processes to finish within
// a few seconds instead of `count` seconds.
async function pingSite(site, count, parallel = 5) {
  const streams = Math.max(1, Math.min(parallel, count));
  const perStream = Math.ceil(count / streams);
  const runs = await Promise.all(
    Array.from({ length: streams }, () => runPing(site, perStream, 1000))
  );

  const sent = runs.reduce((n, r) => n + r.sent, 0);
  const rtts = runs.flatMap((r) => r.rtts);
  const received = rtts.length;
  const loss = sent ? ((sent - received) / sent) * 100 : 100;
  const latency = received ? rtts.reduce((a, b) => a + b, 0) / received : null;

  return {
    site,
    latency: round(latency),
    loss: round(loss),
    jitter: received > 1 ? round(jitterOf(runs.map((r) => r.rtts))) : null,
  };
}

const DNS_FAIL_MS = 5000; // Same penalty value the original used for failures.

async function dnsTest(site, server) {
  const resolver = new Resolver({ timeout: 5000, tries: 1 });
  try {
    resolver.setServers([server.ip]);
  } catch {
    return { name: server.name, ip: server.ip, latency: DNS_FAIL_MS, ok: false };
  }
  const start = performance.now();
  try {
    await resolver.resolve4(site);
    return { name: server.name, ip: server.ip, latency: round(performance.now() - start), ok: true };
  } catch {
    return { name: server.name, ip: server.ip, latency: DNS_FAIL_MS, ok: false };
  }
}

async function collect(settings) {
  const sites = settings.sites.filter(Boolean);
  const [stats, dns] = await Promise.all([
    Promise.all(sites.map((s) => pingSite(s, settings.pingCount))),
    Promise.all(settings.dnsServers.map((srv) => dnsTest(settings.dnsTestSite, srv))),
  ]);
  return { stats, dns };
}

module.exports = { collect, parseRtts, jitterOf };
