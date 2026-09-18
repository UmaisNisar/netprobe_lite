// Network probe: ping loss/latency/jitter per site and DNS response time per
// nameserver. Port of helpers/network_helper.py that works on Windows, macOS
// and Linux without admin rights: native ICMP on Windows (icmp.js), the OS
// ping binary everywhere else and as a fallback.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { Resolver } = require('node:dns').promises;
const { performance } = require('node:perf_hooks');
const icmp = require('./icmp');

// Swappable in tests. `native` returns null when unavailable.
const deps = { spawn: childProcess.spawn, platform: process.platform, native: icmp.pingSequences };

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
  if (deps.platform === 'win32') args = ['-n', String(count), '-w', String(timeoutMs), host];
  // macOS takes -W in milliseconds, Linux (iputils) in seconds.
  else if (deps.platform === 'darwin') args = ['-n', '-c', String(count), '-W', String(timeoutMs), host];
  else args = ['-n', '-c', String(count), '-W', String(Math.ceil(timeoutMs / 1000)), host];

  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = deps.spawn('ping', args, { windowsHide: true });
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

// Linear-interpolated percentile of an unsorted list (p in 0..100).
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

// Ping binaries send roughly one packet per second without root, so the
// requested count is split across parallel ping processes to finish within
// a few seconds instead of `count` seconds.
async function binaryPings(site, count, streams) {
  const perStream = Math.ceil(count / streams);
  const runs = await Promise.all(Array.from({ length: streams }, () => runPing(site, perStream, 1000)));
  return { sent: runs.reduce((n, r) => n + r.sent, 0), rtts: runs.map((r) => r.rtts) };
}

async function pingSite(site, count, parallel = 5) {
  const streams = Math.max(1, Math.min(parallel, count));
  const native = deps.native ? await deps.native(site, count, { streams }) : null;
  const { sent, rtts: sequences } = native ?? (await binaryPings(site, count, streams));

  const rtts = sequences.flat();
  const received = rtts.length;
  const loss = sent ? ((sent - received) / sent) * 100 : 100;
  const latency = received ? rtts.reduce((a, b) => a + b, 0) / received : null;

  return {
    site,
    latency: round(latency),
    loss: round(loss),
    jitter: received > 1 ? round(jitterOf(sequences)) : null,
    p50: round(percentile(rtts, 50)),
    p95: round(percentile(rtts, 95)),
    p99: round(percentile(rtts, 99)),
  };
}

const DNS_FAIL_MS = 5000; // Same penalty value the original used for failures.

// "Not found" answers are still answers: the resolver did its job.
const ANSWERED = new Set(['ENOTFOUND', 'ENODATA']);

async function timeLookup(resolver, name, acceptNotFound) {
  const start = performance.now();
  try {
    await resolver.resolve4(name);
  } catch (e) {
    if (!(acceptNotFound && ANSWERED.has(e.code))) return null;
  }
  return round(performance.now() - start);
}

// Two lookups per server: `site` (almost always cached, the original
// metric that feeds the score) and a random subdomain of it, which no
// resolver can have cached, so it measures a full recursive lookup.
async function dnsTest(site, server, timeoutMs = 5000) {
  const fail = { name: server.name, ip: server.ip, latency: DNS_FAIL_MS, ok: false, uncached: null };
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  try {
    resolver.setServers([server.ip]);
  } catch {
    return fail;
  }
  const cached = await timeLookup(resolver, site, false);
  if (cached == null) return fail;
  const random = `np-${crypto.randomBytes(6).toString('hex')}.${site}`;
  const uncached = await timeLookup(resolver, random, true);
  return { name: server.name, ip: server.ip, latency: cached, ok: true, uncached };
}

// Pings `target` back to back until `until` settles; returns every RTT.
// Used for latency under load during speed tests (bufferbloat).
async function sampleLatency(target, until) {
  let done = false;
  until.then(
    () => (done = true),
    () => (done = true)
  );
  const rtts = [];
  while (!done) {
    const native = deps.native ? await deps.native(target, 5, { streams: 1, spacingMs: 100 }) : null;
    if (native) rtts.push(...native.rtts.flat());
    else rtts.push(...(await runPing(target, 1, 1000)).rtts);
  }
  return rtts;
}

// Pings along the path (your router, then the ISP's first router) use a
// smaller count: they only need to show whether each segment is healthy.
const PATH_PINGS = 20;

async function pingHop(ip, count) {
  if (!ip) return null;
  const r = await pingSite(ip, Math.min(PATH_PINGS, count));
  return { ip, latency: r.latency, loss: r.loss, jitter: r.jitter, p95: r.p95 };
}

// `path` is { gateway, isp } IPs (either may be null); `dnsServers`
// overrides settings.dnsServers (e.g. with the auto-detected home server).
async function collect(settings, { path = {}, dnsServers = settings.dnsServers } = {}) {
  const sites = settings.sites.filter(Boolean);
  const [stats, dns, gateway, isp] = await Promise.all([
    Promise.all(sites.map((s) => pingSite(s, settings.pingCount))),
    Promise.all(dnsServers.map((srv) => dnsTest(settings.dnsTestSite, srv))),
    pingHop(path.gateway, settings.pingCount),
    pingHop(path.isp, settings.pingCount),
  ]);
  return { stats, dns, path: { gateway, isp } };
}

module.exports = {
  collect, pingSite, pingHop, runPing, dnsTest, sampleLatency, parseRtts, jitterOf, percentile, deps, DNS_FAIL_MS, PATH_PINGS,
};
