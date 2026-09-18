// User settings, stored as JSON in the app's userData folder. Replaces the
// .env file of the Docker version; defaults mirror the original .env.

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns');
const { execFileSync } = require('node:child_process');

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

// On Windows, VPN and virtual adapters often make Node report a loopback
// resolver, so ask for the DNS servers of the adapter holding the preferred
// default route instead.
const WIN_DNS_PS = `
$c = Get-NetIPConfiguration |
  Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
  Sort-Object { $_.IPv4DefaultGateway[0].RouteMetric + $_.NetIPv4Interface.InterfaceMetric } |
  Select-Object -First 1
($c.DNSServer | Where-Object AddressFamily -eq 2).ServerAddresses`;

let detectedDns;
function systemDns() {
  if (detectedDns) return detectedDns;
  const candidates = [];
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_DNS_PS], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      candidates.push(...out.split(/\s+/));
    } catch {
      // Fall through to Node's view of the resolver list.
    }
  }
  candidates.push(...dns.getServers());
  detectedDns = candidates.find((s) => IPV4.test(s) && !s.startsWith('127.')) || '8.8.8.8';
  return detectedDns;
}

// Swappable in tests.
const deps = { systemDns };

// Detecting the system resolver shells out to PowerShell on Windows, so it
// only happens when the user has no saved DNS list (first run, or emptied).
function defaults({ detectDns = false } = {}) {
  return {
    sites: ['google.com', 'facebook.com', 'twitter.com', 'youtube.com', 'cloudflare.com'],
    dnsTestSite: 'google.com',
    dnsServers: [
      { name: 'Google DNS', ip: '8.8.8.8' },
      { name: 'Quad9 DNS', ip: '9.9.9.9' },
      { name: 'Cloudflare DNS', ip: '1.1.1.1' },
      // "auto" follows the resolver of whatever network you're on; the ip is
      // the last one seen (and the fallback if detection fails).
      { name: 'My DNS Server', ip: detectDns ? deps.systemDns() : '8.8.8.8', home: true, auto: true },
    ],
    probeInterval: 30, // seconds
    pingCount: 50, // pings per site per probe
    weights: { loss: 0.6, latency: 0.15, jitter: 0.2, dnsLatency: 0.05 },
    thresholds: { loss: 5, latency: 100, jitter: 30, dnsLatency: 100 },
    speedtestEnabled: false,
    speedtestInterval: 937, // seconds; a prime to avoid colliding with probes
    speedtestSchedule: 'interval', // 'interval' | 'times'
    speedtestTimes: ['08:00', '20:00'], // local times for the 'times' schedule
    speedtestBudgetGB: 0, // monthly cap on data used by scheduled tests; 0 = none
    planDown: 0, // your plan's download speed in Mbps; 0 = not set
    planUp: 0,
    retentionDays: 30,
    openAtLogin: true,
    autoUpdate: true, // check GitHub Releases for new versions
    onboarded: false, // the welcome screen has been completed
    // Built-in web dashboard + /metrics (always-on mode).
    server: {
      enabled: false,
      port: 7979,
      lan: false, // listen on all interfaces so other devices can connect
      token: '', // optional access token for other devices
    },
    alerts: {
      notify: true, // OS notification when an incident starts / ends
      degradedScore: 0.6, // a probe below this score counts as degraded
      degradedLoss: 2, // ...or with at least this % packet loss
    },
  };
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Installs from before the welcome screen existed don't need it.
      if (saved.onboarded === undefined) saved.onboarded = true;
      this.value = validate(merge(defaults(), saved));
    } catch {
      // First run or unreadable file: start from defaults.
      this.value = defaults({ detectDns: true });
      this.write();
    }
  }

  get() {
    return structuredClone(this.value);
  }

  set(next) {
    this.value = validate(merge(defaults(), next));
    this.write();
    return this.get();
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2));
  }
}

function merge(base, over) {
  const out = { ...base, ...over };
  out.weights = { ...base.weights, ...(over.weights || {}) };
  out.thresholds = { ...base.thresholds, ...(over.thresholds || {}) };
  out.alerts = { ...base.alerts, ...(over.alerts || {}) };
  out.server = { ...base.server, ...(over.server || {}) };
  return out;
}

const clamp = (n, lo, hi, fallback) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
};

// "8:5" / "08:05" / "20:00" -> "HH:MM"; anything else -> null.
function normaliseTime(t) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function validate(s) {
  const d = defaults();
  s.sites = (s.sites || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
  if (!s.sites.length) s.sites = d.sites;
  s.dnsTestSite = String(s.dnsTestSite || '').trim() || d.dnsTestSite;
  s.dnsServers = (s.dnsServers || [])
    .map((x) => ({
      name: String(x.name || x.ip || '').trim(),
      ip: String(x.ip || '').trim(),
      home: !!x.home,
      // Home servers saved before 1.1 follow the network automatically.
      auto: !!x.home && (x.auto ?? true),
    }))
    .filter((x) => x.ip);
  if (!s.dnsServers.length) s.dnsServers = defaults({ detectDns: true }).dnsServers;
  if (!s.dnsServers.some((x) => x.home)) s.dnsServers[s.dnsServers.length - 1].home = true;
  let seenHome = false;
  for (const x of s.dnsServers) {
    if (x.home && seenHome) x.home = false;
    if (x.home) seenHome = true;
  }
  s.probeInterval = clamp(s.probeInterval, 15, 3600, d.probeInterval);
  s.pingCount = Math.round(clamp(s.pingCount, 5, 200, d.pingCount));
  s.speedtestInterval = clamp(s.speedtestInterval, 300, 86400, d.speedtestInterval);
  s.speedtestSchedule = s.speedtestSchedule === 'times' ? 'times' : 'interval';
  s.speedtestTimes = [...new Set((Array.isArray(s.speedtestTimes) ? s.speedtestTimes : String(s.speedtestTimes ?? '').split(/[\s,]+/))
    .map(normaliseTime)
    .filter(Boolean))]
    .sort()
    .slice(0, 24);
  if (!s.speedtestTimes.length) s.speedtestTimes = d.speedtestTimes;
  s.speedtestBudgetGB = clamp(s.speedtestBudgetGB, 0, 100000, 0);
  s.planDown = clamp(s.planDown, 0, 100000, 0);
  s.planUp = clamp(s.planUp, 0, 100000, 0);
  s.retentionDays = Math.round(clamp(s.retentionDays, 1, 365, d.retentionDays));
  for (const k of Object.keys(d.weights)) s.weights[k] = clamp(s.weights[k], 0, 1, d.weights[k]);
  for (const k of Object.keys(d.thresholds)) s.thresholds[k] = clamp(s.thresholds[k], 0.1, 100000, d.thresholds[k]);
  s.speedtestEnabled = !!s.speedtestEnabled;
  s.openAtLogin = !!s.openAtLogin;
  s.autoUpdate = s.autoUpdate !== false;
  s.onboarded = !!s.onboarded;
  delete s.wifiWarning; // setting removed in 1.2 (no more banner)
  s.server = {
    enabled: !!s.server?.enabled,
    port: Math.round(clamp(s.server?.port, 1024, 65535, d.server.port)),
    lan: !!s.server?.lan,
    token: String(s.server?.token ?? '').trim().slice(0, 128),
  };
  s.alerts = {
    notify: !!s.alerts?.notify,
    degradedScore: clamp(s.alerts?.degradedScore, 0, 1, d.alerts.degradedScore),
    degradedLoss: clamp(s.alerts?.degradedLoss, 0.1, 100, d.alerts.degradedLoss),
  };
  return s;
}

module.exports = { Settings, defaults, validate, normaliseTime, systemDns, deps };
