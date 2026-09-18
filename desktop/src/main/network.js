// Detects whether the connection carrying internet traffic (the preferred
// default route) is Wi-Fi or wired, so the dashboard can warn that Wi-Fi
// results include local wireless problems, not just the ISP.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const { promisify } = require('node:util');

// Swappable in tests.
const deps = {
  platform: process.platform,
  execFile: promisify(childProcess.execFile),
  exists: fs.existsSync,
};

const UNKNOWN = { type: 'unknown', name: null };

// NdisPhysicalMedium is numeric and language independent:
// 9 = Native 802.11 (Wi-Fi), 14 = 802.3 (Ethernet), 0 = virtual/VPN.
const WIN_PS = `
$c = Get-NetIPConfiguration |
  Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
  Sort-Object { $_.IPv4DefaultGateway[0].RouteMetric + $_.NetIPv4Interface.InterfaceMetric } |
  Select-Object -First 1
if ($c) { "$([int]$c.NetAdapter.NdisPhysicalMedium)|$($c.InterfaceAlias)" }`;

function parseWindows(out) {
  const line = out.trim().split(/\r?\n/).pop() || '';
  const [medium, name] = line.split('|');
  if (!name) return UNKNOWN;
  if (medium === '9') return { type: 'wifi', name };
  if (medium === '14') return { type: 'wired', name };
  return { type: 'unknown', name };
}

// `route -n get default` → "  interface: en0"
function parseMacRoute(out) {
  const m = out.match(/^\s*interface:\s*(\S+)/m);
  return m ? m[1] : null;
}

// `networksetup -listallhardwareports` → blocks of
// "Hardware Port: Wi-Fi\nDevice: en0\nEthernet Address: ..."
function parseMacPorts(out, device) {
  for (const block of out.split(/\n\s*\n/)) {
    const port = block.match(/Hardware Port:\s*(.+)/)?.[1]?.trim();
    const dev = block.match(/Device:\s*(\S+)/)?.[1];
    if (dev !== device || !port) continue;
    return { type: /wi-?fi|airport/i.test(port) ? 'wifi' : 'wired', name: port };
  }
  return { type: 'unknown', name: device }; // e.g. a VPN tunnel (utun)
}

// `ip route show default` → "default via 192.168.1.1 dev wlp3s0 proto dhcp metric 600"
function parseLinuxRoute(out) {
  const routes = out
    .split('\n')
    .map((l) => ({ dev: l.match(/\bdev\s+(\S+)/)?.[1], metric: Number(l.match(/\bmetric\s+(\d+)/)?.[1] ?? 0) }))
    .filter((r) => r.dev)
    .sort((a, b) => a.metric - b.metric);
  return routes[0]?.dev ?? null;
}

function classifyLinux(dev) {
  if (deps.exists(`/sys/class/net/${dev}/wireless`)) return { type: 'wifi', name: dev };
  // Physical NICs have a backing device; bridges, VPNs and veths don't.
  if (deps.exists(`/sys/class/net/${dev}/device`)) return { type: 'wired', name: dev };
  return { type: 'unknown', name: dev };
}

async function detectConnection() {
  const opts = { timeout: 10000, windowsHide: true };
  try {
    if (deps.platform === 'win32') {
      const { stdout } = await deps.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], opts);
      return parseWindows(stdout);
    }
    if (deps.platform === 'darwin') {
      const { stdout: route } = await deps.execFile('route', ['-n', 'get', 'default'], opts);
      const device = parseMacRoute(route);
      if (!device) return UNKNOWN;
      const { stdout: ports } = await deps.execFile('networksetup', ['-listallhardwareports'], opts);
      return parseMacPorts(ports, device);
    }
    const { stdout } = await deps.execFile('ip', ['route', 'show', 'default'], opts);
    const dev = parseLinuxRoute(stdout);
    return dev ? classifyLinux(dev) : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

module.exports = { detectConnection, parseWindows, parseMacRoute, parseMacPorts, parseLinuxRoute, classifyLinux, deps };
