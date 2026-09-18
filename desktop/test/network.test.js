const test = require('node:test');
const assert = require('node:assert');
const net = require('../src/main/network');

const { parseWindows, parseMacRoute, parseMacPorts, parseLinuxRoute, classifyLinux, detectConnection, deps } = net;

function withDeps(overrides, fn) {
  const saved = { ...deps };
  Object.assign(deps, overrides);
  return Promise.resolve(fn()).finally(() => Object.assign(deps, saved));
}

// execFile fake keyed by command name.
const execFrom = (outputs, calls = []) => async (cmd, args) => {
  calls.push([cmd, ...args]);
  if (!(cmd in outputs)) throw new Error(`unexpected ${cmd}`);
  const out = outputs[cmd];
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

test('Windows: medium 9 is Wi-Fi, 14 is wired, anything else unknown', () => {
  assert.deepStrictEqual(parseWindows('9|Wi-Fi\r\n'), { type: 'wifi', name: 'Wi-Fi' });
  assert.deepStrictEqual(parseWindows('14|Ethernet'), { type: 'wired', name: 'Ethernet' });
  assert.deepStrictEqual(parseWindows('0|NordLynx'), { type: 'unknown', name: 'NordLynx' });
});

test('Windows: no default route or garbage output is unknown', () => {
  assert.deepStrictEqual(parseWindows(''), { type: 'unknown', name: null });
  assert.deepStrictEqual(parseWindows('WARNING: something'), { type: 'unknown', name: null });
});

test('Windows: detectConnection runs PowerShell and parses its output', async () => {
  const calls = [];
  const r = await withDeps({ platform: 'win32', execFile: execFrom({ 'powershell.exe': '9|WLAN\r\n' }, calls) }, detectConnection);
  assert.deepStrictEqual(r, { type: 'wifi', name: 'WLAN' });
  assert.strictEqual(calls[0][0], 'powershell.exe');
});

// ------------------------------------------------------------ macOS

test('macOS: reads the default route interface', () => {
  const out = '   route to: default\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY>';
  assert.strictEqual(parseMacRoute(out), 'en0');
  assert.strictEqual(parseMacRoute('route: writing to routing socket: not in table'), null);
});

test('macOS: maps the device to its hardware port', () => {
  assert.deepStrictEqual(parseMacPorts(MAC_PORTS, 'en0'), { type: 'wifi', name: 'Wi-Fi' });
  assert.deepStrictEqual(parseMacPorts(MAC_PORTS, 'en1'), { type: 'wired', name: 'Ethernet' });
  assert.deepStrictEqual(parseMacPorts(MAC_PORTS, 'utun3'), { type: 'unknown', name: 'utun3' });
  assert.deepStrictEqual(parseMacPorts('Hardware Port: AirPort\nDevice: en0\n', 'en0'), { type: 'wifi', name: 'AirPort' });
});

test('macOS: detectConnection combines route and networksetup', async () => {
  const execFile = execFrom({ route: '  interface: en0\n', networksetup: MAC_PORTS });
  const r = await withDeps({ platform: 'darwin', execFile }, detectConnection);
  assert.deepStrictEqual(r, { type: 'wifi', name: 'Wi-Fi' });
});

test('macOS: no default route is unknown without calling networksetup', async () => {
  const calls = [];
  const r = await withDeps({ platform: 'darwin', execFile: execFrom({ route: 'not in table' }, calls) }, detectConnection);
  assert.deepStrictEqual(r, { type: 'unknown', name: null });
  assert.strictEqual(calls.length, 1);
});

// ------------------------------------------------------------ Linux

test('Linux: picks the default route with the lowest metric', () => {
  const out = [
    'default via 10.8.0.1 dev tun0 proto static metric 700',
    'default via 192.168.1.1 dev wlp3s0 proto dhcp src 192.168.1.20 metric 600',
    'default via 192.168.1.1 dev enp4s0 proto dhcp metric 100',
  ].join('\n');
  assert.strictEqual(parseLinuxRoute(out), 'enp4s0');
  assert.strictEqual(parseLinuxRoute('default via 192.168.1.1 dev wlan0'), 'wlan0');
  assert.strictEqual(parseLinuxRoute(''), null);
});

test('Linux: classifies by sysfs', async () => {
  const exists = (p) => ['/sys/class/net/wlan0/wireless', '/sys/class/net/wlan0/device', '/sys/class/net/eth0/device'].includes(p);
  await withDeps({ exists }, () => {
    assert.deepStrictEqual(classifyLinux('wlan0'), { type: 'wifi', name: 'wlan0' });
    assert.deepStrictEqual(classifyLinux('eth0'), { type: 'wired', name: 'eth0' });
    assert.deepStrictEqual(classifyLinux('tun0'), { type: 'unknown', name: 'tun0' });
  });
});

test('Linux: detectConnection uses ip route', async () => {
  const execFile = execFrom({ ip: 'default via 192.168.1.1 dev wlan0 metric 600\n' });
  const exists = (p) => p === '/sys/class/net/wlan0/wireless';
  const r = await withDeps({ platform: 'linux', execFile, exists }, detectConnection);
  assert.deepStrictEqual(r, { type: 'wifi', name: 'wlan0' });
});

// ------------------------------------------------------------ failures

test('a failing command reports unknown instead of throwing', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const execFile = async () => {
      throw new Error('ENOENT');
    };
    const r = await withDeps({ platform, execFile }, detectConnection);
    assert.deepStrictEqual(r, { type: 'unknown', name: null }, platform);
  }
});

test('detectConnection works against the real OS', async () => {
  const r = await detectConnection();
  assert.ok(['wifi', 'wired', 'unknown'].includes(r.type));
});
