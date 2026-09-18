// Works out how this machine reaches the internet: which interface carries
// the traffic (Wi-Fi, wired, VPN), the router it goes through, and the DNS
// servers that interface uses. Asks the OS for the route to a public
// address rather than the "default route", because VPNs such as NordVPN
// override the default with two /1 routes.

const childProcess = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const { promisify } = require('node:util');

// Swappable in tests.
const deps = {
  platform: process.platform,
  execFile: promisify(childProcess.execFile),
  exists: fs.existsSync,
  systemServers: () => dns.getServers(),
};

const PROBE_TARGET = '1.1.1.1';
const UNKNOWN = Object.freeze({ type: 'unknown', name: null, gateway: null, dns: [] });

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const isIPv4 = (s) => IPV4.test(s);
const usableDns = (list) => [...new Set(list.filter((s) => isIPv4(s) && !s.startsWith('127.')))];

// Adapter names/descriptions that mean "tunnel", across OSes and vendors.
const VPN_RE = /vpn|wireguard|nordlynx|wintun|\btap\b|tap-|tun\d*\b|^tun|^wg\d*|^utun|^ipsec|^ppp|openvpn|anyconnect|fortinet|forticlient|globalprotect|pangp|zerotier|tailscale|hamachi|radmin|juniper|pulse secure|cloudflare warp|proton/i;

// ------------------------------------------------------------ Windows

// NdisPhysicalMedium is numeric and language independent:
// 9 = Native 802.11 (Wi-Fi), 14 = 802.3 (Ethernet), 0 = virtual.
const WIN_PS = `
$r = Find-NetRoute -RemoteIPAddress ${PROBE_TARGET} -ErrorAction SilentlyContinue |
  Where-Object { $_.CimClass.CimClassName -eq 'MSFT_NetRoute' } | Select-Object -First 1
if ($r) {
  $a = Get-NetAdapter -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue
  $d = (Get-DnsClientServerAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses -join ','
  "$([int]$a.NdisPhysicalMedium)|$($a.Name)|$($r.NextHop)|$d|$($a.InterfaceDescription)"
}`;

function parseWindows(out) {
  const line = out.trim().split(/\r?\n/).pop() || '';
  const [medium, name, nextHop, dnsList = '', description = ''] = line.split('|');
  if (!name) return UNKNOWN;
  const gateway = isIPv4(nextHop) && nextHop !== '0.0.0.0' ? nextHop : null;
  const servers = usableDns(dnsList.split(','));
  let type = 'unknown';
  if (VPN_RE.test(name) || VPN_RE.test(description)) type = 'vpn';
  else if (medium === '9') type = 'wifi';
  else if (medium === '14') type = 'wired';
  return { type, name, gateway, dns: servers };
}

// ------------------------------------------------------------ macOS

// `route -n get 1.1.1.1` → "    gateway: 192.168.1.1\n  interface: en0"
function parseMacRoute(out) {
  const iface = out.match(/^\s*interface:\s*(\S+)/m)?.[1] ?? null;
  const gw = out.match(/^\s*gateway:\s*(\S+)/m)?.[1];
  return { iface, gateway: gw && isIPv4(gw) ? gw : null };
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
  return { type: VPN_RE.test(device) ? 'vpn' : 'unknown', name: device };
}

// `scutil --dns` → "  nameserver[0] : 192.168.1.1" (first resolver wins)
function parseScutilDns(out) {
  const first = out.split(/\nresolver #/)[0] + '\n' + (out.split(/\nresolver #/)[1] ?? '');
  return usableDns([...first.matchAll(/nameserver\[\d+\]\s*:\s*(\S+)/g)].map((m) => m[1]));
}

// ------------------------------------------------------------ Linux

// `ip route get 1.1.1.1` → "1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.20 uid 1000"
function parseLinuxRoute(out) {
  const dev = out.match(/\bdev\s+(\S+)/)?.[1] ?? null;
  const via = out.match(/\bvia\s+(\S+)/)?.[1];
  return { dev, gateway: via && isIPv4(via) ? via : null };
}

function classifyLinux(dev) {
  if (VPN_RE.test(dev)) return { type: 'vpn', name: dev };
  if (deps.exists(`/sys/class/net/${dev}/wireless`)) return { type: 'wifi', name: dev };
  // Physical NICs have a backing device; bridges and veths don't.
  if (deps.exists(`/sys/class/net/${dev}/device`)) return { type: 'wired', name: dev };
  return { type: 'unknown', name: dev };
}

// `resolvectl dns wlan0` → "Link 3 (wlan0): 192.168.1.1 fe80::1"
function parseResolvectl(out) {
  return usableDns(out.split(':').slice(1).join(':').trim().split(/\s+/));
}

// ------------------------------------------------------------ detect

async function detectConnection() {
  const opts = { timeout: 10000, windowsHide: true };
  const run = (cmd, args) => deps.execFile(cmd, args, opts).then((r) => r.stdout);
  try {
    if (deps.platform === 'win32') {
      return parseWindows(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS]));
    }
    if (deps.platform === 'darwin') {
      const { iface, gateway } = parseMacRoute(await run('route', ['-n', 'get', PROBE_TARGET]));
      if (!iface) return UNKNOWN;
      const port = parseMacPorts(await run('networksetup', ['-listallhardwareports']), iface);
      const servers = await run('scutil', ['--dns']).then(parseScutilDns, () => []);
      return { ...port, gateway, dns: servers.length ? servers : usableDns(deps.systemServers()) };
    }
    const { dev, gateway } = parseLinuxRoute(await run('ip', ['route', 'get', PROBE_TARGET]));
    if (!dev) return UNKNOWN;
    let servers = usableDns(deps.systemServers());
    if (!servers.length) servers = await run('resolvectl', ['dns', dev]).then(parseResolvectl, () => []);
    return { ...classifyLinux(dev), gateway, dns: servers };
  } catch {
    return UNKNOWN;
  }
}

// ------------------------------------------------------------ path discovery

// Private and link-local ranges are "your side"; CGNAT (100.64/10) is the ISP.
function isPrivate(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
}

// One ping with a small TTL: the router where it expires answers with
// "TTL expired" / "Time to live exceeded" from its own address.
function ttlArgs(ttl, target) {
  if (deps.platform === 'win32') return ['-n', '1', '-i', String(ttl), '-w', '1000', target];
  if (deps.platform === 'darwin') return ['-n', '-c', '1', '-m', String(ttl), '-W', '1000', target];
  return ['-n', '-c', '1', '-t', String(ttl), '-W', '1', target];
}

// The first IPv4 address in the output that isn't the target itself.
function hopFromPing(out, target) {
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(`[${target}]`) || /statistics|statistik|statistiques|PING /i.test(line)) continue;
    for (const m of line.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)) {
      if (m[1] !== target) return m[1];
    }
  }
  return null;
}

// Hops 1..maxHops, found in parallel in about a second.
async function discoverHops(target = PROBE_TARGET, maxHops = 8) {
  const probeHop = (ttl) =>
    deps
      .execFile('ping', ttlArgs(ttl, target), { timeout: 5000, windowsHide: true })
      .then((r) => r.stdout, (e) => e.stdout ?? '')
      .then((out) => hopFromPing(out, target));
  return Promise.all(Array.from({ length: maxHops }, (_, i) => probeHop(i + 1)));
}

// The ISP's first router: the first responding hop after the gateway that
// is not a private address. Null when the ISP's routers don't answer.
function ispHop(hops, gateway) {
  const start = gateway ? Math.max(0, hops.indexOf(gateway)) + 1 : 1;
  for (let i = start; i < hops.length; i++) {
    if (hops[i] && !isPrivate(hops[i])) return hops[i];
  }
  return null;
}

module.exports = {
  detectConnection,
  discoverHops,
  ispHop,
  isPrivate,
  hopFromPing,
  ttlArgs,
  parseWindows,
  parseMacRoute,
  parseMacPorts,
  parseScutilDns,
  parseLinuxRoute,
  parseResolvectl,
  classifyLinux,
  VPN_RE,
  UNKNOWN,
  deps,
};
