const test = require('node:test');
const assert = require('node:assert');
const net = require('../src/main/network');

const {
  parseWindows, parseMacRoute, parseMacPorts, parseScutilDns, parseLinuxRoute, parseResolvectl,
  classifyLinux, detectConnection, discoverHops, ispHop, isPrivate, hopFromPing, ttlArgs, UNKNOWN, deps,
} = net;

function withDeps(overrides, fn) {
  const saved = { ...deps };
  Object.assign(deps, overrides);
  return Promise.resolve(fn()).finally(() => Object.assign(deps, saved));
}

// execFile fake keyed by command name.
const execFrom = (outputs, calls = []) => async (cmd, args) => {
  calls.push([cmd, ...args]);
  if (!(cmd in outputs)) throw Object.assign(new Error(`unexpected ${cmd}`), { code: 'ENOENT' });
  const out = typeof outputs[cmd] === 'function' ? outputs[cmd](args) : outputs[cmd];
  if (out instanceof Error) throw out;
  return { stdout: out, stderr: '' };
};

const MAC_PORTS = `
Hardware Port: Ethernet
Device: en1
Ethernet Address: aa:bb:cc:dd:ee:01

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: aa:bb:cc:dd:ee:00

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: N/A
`;

// ------------------------------------------------------------ Windows

test('Windows: classifies by physical medium and reads gateway + DNS', () => {
  assert.deepStrictEqual(parseWindows('9|Wi-Fi|192.168.1.1|192.168.1.1,8.8.8.8|Intel Wi-Fi 6\r\n'), {
    type: 'wifi', name: 'Wi-Fi', gateway: '192.168.1.1', dns: ['192.168.1.1', '8.8.8.8'],
  });
  assert.strictEqual(parseWindows('14|Ethernet|10.0.0.1||Realtek').type, 'wired');
  assert.strictEqual(parseWindows('0|Something|10.0.0.1||Virtual').type, 'unknown');
});

test('Windows: VPN adapters are recognised by name or description, whatever the medium', () => {
  assert.strictEqual(parseWindows('0|NordLynx|0.0.0.0||NordLynx Tunnel').type, 'vpn');
  assert.strictEqual(parseWindows('14|Radmin VPN|26.0.0.1||Famatech Radmin VPN Ethernet Adapter').type, 'vpn');
  assert.strictEqual(parseWindows('0|Ethernet 5|10.8.0.1||TAP-Windows Adapter V9').type, 'vpn');
  assert.strictEqual(parseWindows('0|wg0|0.0.0.0||WireGuard Tunnel').gateway, null); // on-link
});

test('Windows: drops loopback/IPv6 DNS entries and duplicates', () => {
  assert.deepStrictEqual(parseWindows('9|Wi-Fi|1.1.1.1|127.0.0.1,fe80::1,1.1.1.1,1.1.1.1|x').dns, ['1.1.1.1']);
});

test('Windows: no route or garbage output is unknown', () => {
  assert.deepStrictEqual(parseWindows(''), UNKNOWN);
  assert.deepStrictEqual(parseWindows('WARNING: something'), UNKNOWN);
});

test('Windows: detectConnection runs PowerShell', async () => {
  const calls = [];
  const execFile = execFrom({ 'powershell.exe': '9|WLAN|192.168.0.1|192.168.0.1|x\r\n' }, calls);
  const r = await withDeps({ platform: 'win32', execFile }, detectConnection);
  assert.deepStrictEqual(r, { type: 'wifi', name: 'WLAN', gateway: '192.168.0.1', dns: ['192.168.0.1'] });
  assert.strictEqual(calls[0][0], 'powershell.exe');
});

// ------------------------------------------------------------ macOS

test('macOS: reads interface and gateway from the route', () => {
  const out = '   route to: 1.1.1.1\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY>';
  assert.deepStrictEqual(parseMacRoute(out), { iface: 'en0', gateway: '192.168.1.1' });
  assert.deepStrictEqual(parseMacRoute('  interface: utun4\n'), { iface: 'utun4', gateway: null });
  assert.deepStrictEqual(parseMacRoute('not in table'), { iface: null, gateway: null });
});

test('macOS: maps the device to its hardware port', () => {
  assert.deepStrictEqual(parseMacPorts(MAC_PORTS, 'en0'), { type: 'wifi', name: 'Wi-Fi' });
  assert.deepStrictEqual(parseMacPorts(MAC_PORTS, 'en1'), { type: 'wired', name: 'Ethernet' });
  assert.deepStrictEqual(parseMacPorts(MAC_PORTS, 'utun3'), { type: 'vpn', name: 'utun3' });
  assert.deepStrictEqual(parseMacPorts(MAC_PORTS, 'weird9'), { type: 'unknown', name: 'weird9' });
  assert.deepStrictEqual(parseMacPorts('Hardware Port: AirPort\nDevice: en0\n', 'en0'), { type: 'wifi', name: 'AirPort' });
});

test('macOS: reads the primary resolver from scutil', () => {
  const out = 'DNS configuration\n\nresolver #1\n  nameserver[0] : 192.168.1.1\n  nameserver[1] : 1.1.1.1\n\nresolver #2\n  domain   : local\n';
  assert.deepStrictEqual(parseScutilDns(out), ['192.168.1.1', '1.1.1.1']);
});

test('macOS: detectConnection combines route, networksetup and scutil', async () => {
  const execFile = execFrom({
    route: '    gateway: 192.168.1.1\n  interface: en0\n',
    networksetup: MAC_PORTS,
    scutil: 'resolver #1\n  nameserver[0] : 192.168.1.1\n',
  });
  const r = await withDeps({ platform: 'darwin', execFile }, detectConnection);
  assert.deepStrictEqual(r, { type: 'wifi', name: 'Wi-Fi', gateway: '192.168.1.1', dns: ['192.168.1.1'] });
});

test('macOS: falls back to Node resolver list when scutil fails', async () => {
  const execFile = execFrom({ route: '  interface: en1\n', networksetup: MAC_PORTS, scutil: new Error('x') });
  const r = await withDeps({ platform: 'darwin', execFile, systemServers: () => ['127.0.0.1', '9.9.9.9'] }, detectConnection);
  assert.deepStrictEqual(r.dns, ['9.9.9.9']);
  assert.strictEqual(r.type, 'wired');
});

test('macOS: no route is unknown without calling networksetup', async () => {
  const calls = [];
  const r = await withDeps({ platform: 'darwin', execFile: execFrom({ route: 'not in table' }, calls) }, detectConnection);
  assert.deepStrictEqual(r, UNKNOWN);
  assert.strictEqual(calls.length, 1);
});

// ------------------------------------------------------------ Linux

test('Linux: reads device and gateway from ip route get', () => {
  assert.deepStrictEqual(parseLinuxRoute('1.1.1.1 via 192.168.1.1 dev wlp3s0 src 192.168.1.20 uid 1000\n    cache'), {
    dev: 'wlp3s0', gateway: '192.168.1.1',
  });
  assert.deepStrictEqual(parseLinuxRoute('1.1.1.1 dev wg0 table 51820 src 10.5.0.2'), { dev: 'wg0', gateway: null });
  assert.deepStrictEqual(parseLinuxRoute(''), { dev: null, gateway: null });
});

test('Linux: classifies by name and sysfs', async () => {
  const exists = (p) => ['/sys/class/net/wlan0/wireless', '/sys/class/net/wlan0/device', '/sys/class/net/eth0/device'].includes(p);
  await withDeps({ exists }, () => {
    assert.deepStrictEqual(classifyLinux('wlan0'), { type: 'wifi', name: 'wlan0' });
    assert.deepStrictEqual(classifyLinux('eth0'), { type: 'wired', name: 'eth0' });
    assert.deepStrictEqual(classifyLinux('tun0'), { type: 'vpn', name: 'tun0' });
    assert.deepStrictEqual(classifyLinux('tailscale0'), { type: 'vpn', name: 'tailscale0' });
    assert.deepStrictEqual(classifyLinux('br0'), { type: 'unknown', name: 'br0' });
  });
});

test('Linux: parses resolvectl output', () => {
  assert.deepStrictEqual(parseResolvectl('Link 3 (wlan0): 192.168.1.1 fe80::1%3'), ['192.168.1.1']);
  assert.deepStrictEqual(parseResolvectl('Link 3 (wlan0):'), []);
});

test('Linux: detectConnection uses ip route and asks resolvectl behind the stub resolver', async () => {
  const execFile = execFrom({
    ip: '1.1.1.1 via 192.168.1.1 dev wlan0 src 192.168.1.5\n',
    resolvectl: 'Link 3 (wlan0): 192.168.1.1',
  });
  const exists = (p) => p === '/sys/class/net/wlan0/wireless';
  const r = await withDeps({ platform: 'linux', execFile, exists, systemServers: () => ['127.0.0.53'] }, detectConnection);
  assert.deepStrictEqual(r, { type: 'wifi', name: 'wlan0', gateway: '192.168.1.1', dns: ['192.168.1.1'] });
});

test('Linux: no route is unknown', async () => {
  const r = await withDeps({ platform: 'linux', execFile: execFrom({ ip: '' }) }, detectConnection);
  assert.deepStrictEqual(r, UNKNOWN);
});

test('a failing command reports unknown instead of throwing', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const execFile = async () => {
      throw new Error('ENOENT');
    };
    const r = await withDeps({ platform, execFile }, detectConnection);
    assert.deepStrictEqual(r, UNKNOWN, platform);
  }
});

// ------------------------------------------------------------ path discovery

test('private ranges are home side; CGNAT and public are not', () => {
  for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1', '169.254.1.1', '127.0.0.1']) assert.ok(isPrivate(ip), ip);
  for (const ip of ['100.64.0.1', '172.32.0.1', '8.8.8.8', '11.0.0.1']) assert.ok(!isPrivate(ip), ip);
});

test('TTL ping arguments per OS', async () => {
  await withDeps({ platform: 'win32' }, () => assert.deepStrictEqual(ttlArgs(3, '1.1.1.1'), ['-n', '1', '-i', '3', '-w', '1000', '1.1.1.1']));
  await withDeps({ platform: 'darwin' }, () => assert.deepStrictEqual(ttlArgs(3, '1.1.1.1'), ['-n', '-c', '1', '-m', '3', '-W', '1000', '1.1.1.1']));
  await withDeps({ platform: 'linux' }, () => assert.deepStrictEqual(ttlArgs(3, '1.1.1.1'), ['-n', '-c', '1', '-t', '3', '-W', '1', '1.1.1.1']));
});

test('hopFromPing finds the expiring router in each OS format', () => {
  const win = 'Pinging 1.1.1.1 with 32 bytes of data:\r\nReply from 100.64.0.1: TTL expired in transit.\r\n\r\nPing statistics for 1.1.1.1:';
  const winDe = 'Ping wird ausgeführt für 1.1.1.1 mit 32 Bytes Daten:\r\nAntwort von 10.20.0.1: TTL abgelaufen bei Übertragung.';
  const linux = 'PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.\nFrom 62.1.2.3 icmp_seq=1 Time to live exceeded\n';
  const mac = 'PING 1.1.1.1 (1.1.1.1): 56 data bytes\n36 bytes from 84.1.1.1: Time to live exceeded\n';
  assert.strictEqual(hopFromPing(win, '1.1.1.1'), '100.64.0.1');
  assert.strictEqual(hopFromPing(winDe, '1.1.1.1'), '10.20.0.1');
  assert.strictEqual(hopFromPing(linux, '1.1.1.1'), '62.1.2.3');
  assert.strictEqual(hopFromPing(mac, '1.1.1.1'), '84.1.1.1');
  assert.strictEqual(hopFromPing('Request timed out.', '1.1.1.1'), null);
  assert.strictEqual(hopFromPing('Reply from 1.1.1.1: bytes=32 time=9ms TTL=57', '1.1.1.1'), null);
});

test('discoverHops probes every TTL in parallel', async () => {
  const replies = { 1: 'Reply from 192.168.1.1: TTL expired in transit.', 3: 'Reply from 100.70.0.1: TTL expired in transit.' };
  const execFile = async (_cmd, args) => {
    const ttl = Number(args[args.indexOf('-i') + 1]);
    if (!replies[ttl]) throw Object.assign(new Error('exit 1'), { stdout: 'Request timed out.' });
    return { stdout: replies[ttl] };
  };
  const hops = await withDeps({ platform: 'win32', execFile }, () => discoverHops('1.1.1.1', 4));
  assert.deepStrictEqual(hops, ['192.168.1.1', null, '100.70.0.1', null]);
});

test('ispHop is the first responding non-private hop after the gateway', () => {
  assert.strictEqual(ispHop(['192.168.1.1', null, '100.70.0.1', '8.8.8.8'], '192.168.1.1'), '100.70.0.1');
  // Double NAT: the ISP modem's private address is still "home side".
  assert.strictEqual(ispHop(['192.168.1.1', '192.168.0.1', '62.1.1.1'], '192.168.1.1'), '62.1.1.1');
  assert.strictEqual(ispHop(['172.20.10.1', null, null], '172.20.10.1'), null);
  assert.strictEqual(ispHop([null, '62.1.1.1'], null), '62.1.1.1');
});
