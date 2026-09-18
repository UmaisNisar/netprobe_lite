const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const probe = require('../src/main/probe');

const { parseRtts, jitterOf, runPing, pingSite, dnsTest, collect, sampleLatency, percentile, deps } = probe;

// Unit tests drive the ping-binary path; native ICMP is tested with fakes below.
deps.native = null;

// ------------------------------------------------------------ fakes

// Replaces child_process.spawn with a fake ping that prints `output(args)`.
function fakeSpawn(output, calls = []) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(output(args)));
      child.emit('close', 0);
    });
    return child;
  };
}

function withDeps(overrides, fn) {
  const saved = { ...deps };
  Object.assign(deps, overrides);
  return Promise.resolve(fn()).finally(() => Object.assign(deps, saved));
}

const winReply = (ms) => `Reply from 1.1.1.1: bytes=32 time=${ms}ms TTL=57`;

// Minimal DNS server: answers A queries with 1.2.3.4, NXDOMAIN for the
// random "np-..." names used for uncached lookups, or SERVFAIL for all.
async function dnsServer({ fail = false, failRandom = false } = {}) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    let i = 12; // skip header, walk the question name
    const labels = [];
    while (msg[i] !== 0) {
      labels.push(msg.subarray(i + 1, i + 1 + msg[i]).toString());
      i += msg[i] + 1;
    }
    const random = labels[0].startsWith('np-');
    const servfail = fail || (random && failRandom);
    const nxdomain = random && !servfail;
    const question = msg.subarray(12, i + 5);
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2); // id
    header.writeUInt16BE(servfail ? 0x8182 : nxdomain ? 0x8183 : 0x8180, 2);
    header.writeUInt16BE(1, 4); // qdcount
    header.writeUInt16BE(servfail || nxdomain ? 0 : 1, 6); // ancount
    const answer = servfail || nxdomain
      ? Buffer.alloc(0)
      : Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 1, 2, 3, 4]);
    sock.send(Buffer.concat([header, question, answer]), rinfo.port, rinfo.address);
  });
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  return { address: `127.0.0.1:${sock.address().port}`, close: () => sock.close() };
}

// ------------------------------------------------------------ parseRtts

test('parses Windows, localised Windows and Unix reply lines', () => {
  const out = [
    'Reply from 1.1.1.1: bytes=32 time=12ms TTL=57',
    'Reply from 1.1.1.1: bytes=32 time<1ms TTL=57',
    'Antwort von 1.1.1.1: Bytes=32 Zeit=15ms TTL=57',
    'Réponse de 1.1.1.1 : octets=32 temps=14 ms TTL=57',
    '64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=11.4 ms',
    '64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=0,9 ms',
  ].join('\r\n');
  assert.deepStrictEqual(parseRtts(out), [12, 0.5, 15, 14, 11.4, 0.9]);
});

test('ignores timeouts, unreachable replies, headers and summary lines', () => {
  const out = [
    'Pinging google.com [142.250.1.1] with 32 bytes of data:',
    'PING google.com (142.250.1.1): 56 data bytes',
    'Request timed out.',
    'Request timeout for icmp_seq 3',
    'Reply from 192.168.1.1: Destination host unreachable.',
    '    Minimum = 10ms, Maximum = 12ms, Average = 11ms',
    'rtt min/avg/max/mdev = 10.1/11.2/12.3/0.8 ms',
    'round-trip min/avg/max/stddev = 10.1/11.2/12.3/0.8 ms',
  ].join('\n');
  assert.deepStrictEqual(parseRtts(out), []);
});

test('parseRtts handles empty output', () => {
  assert.deepStrictEqual(parseRtts(''), []);
});

// ------------------------------------------------------------ jitter

test('jitter is mean absolute difference of consecutive RTTs per stream', () => {
  assert.strictEqual(jitterOf([[10, 12, 10], [20, 20]]), (2 + 2 + 0) / 3);
});

test('jitter does not compare RTTs across different streams', () => {
  // A 90 ms jump between the end of one stream and the start of the next
  // must not count.
  assert.strictEqual(jitterOf([[10, 10], [100, 100]]), 0);
});

test('jitter is 0 with fewer than two samples', () => {
  assert.strictEqual(jitterOf([[10]]), 0);
  assert.strictEqual(jitterOf([]), 0);
});

// ------------------------------------------------------------ runPing

test('runPing builds Windows arguments (-n count, -w ms)', async () => {
  const calls = [];
  await withDeps({ platform: 'win32', spawn: fakeSpawn(() => '', calls) }, () => runPing('a.com', 10, 1000));
  assert.deepStrictEqual(calls[0], { cmd: 'ping', args: ['-n', '10', '-w', '1000', 'a.com'] });
});

test('runPing builds macOS arguments (-W in milliseconds)', async () => {
  const calls = [];
  await withDeps({ platform: 'darwin', spawn: fakeSpawn(() => '', calls) }, () => runPing('a.com', 10, 1000));
  assert.deepStrictEqual(calls[0].args, ['-n', '-c', '10', '-W', '1000', 'a.com']);
});

test('runPing builds Linux arguments (-W in seconds)', async () => {
  const calls = [];
  await withDeps({ platform: 'linux', spawn: fakeSpawn(() => '', calls) }, () => runPing('a.com', 10, 1500));
  assert.deepStrictEqual(calls[0].args, ['-n', '-c', '10', '-W', '2', 'a.com']);
});

test('runPing reports all packets lost when ping cannot be started', async () => {
  const spawn = () => {
    throw new Error('ENOENT');
  };
  const r = await withDeps({ spawn }, () => runPing('a.com', 7, 1000));
  assert.deepStrictEqual(r, { sent: 7, rtts: [] });
});

test('runPing survives a ping process that emits an error', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.emit('error', new Error('boom'));
      child.emit('close', 1);
    });
    return child;
  };
  const r = await withDeps({ spawn }, () => runPing('a.com', 3, 1000));
  assert.deepStrictEqual(r, { sent: 3, rtts: [] });
});

// ------------------------------------------------------------ pingSite

test('pingSite splits the count across parallel streams and aggregates', async () => {
  const calls = [];
  // Every stream answers 2 of its pings, at 10 ms and 14 ms.
  const spawn = fakeSpawn(() => [winReply(10), winReply(14), 'Request timed out.'].join('\n'), calls);
  const r = await withDeps({ platform: 'win32', spawn }, () => pingSite('a.com', 20, 5));
  assert.strictEqual(calls.length, 5);
  assert.ok(calls.every((c) => c.args[1] === '4')); // 20 pings / 5 streams
  // 5 streams x 4 sent = 20 sent, 10 received
  assert.deepStrictEqual(r, { site: 'a.com', latency: 12, loss: 50, jitter: 4, p50: 12, p95: 14, p99: 14 });
});

test('pingSite reports null latency/jitter and 100% loss when nothing replies', async () => {
  const spawn = fakeSpawn(() => 'Request timed out.');
  const r = await withDeps({ platform: 'win32', spawn }, () => pingSite('a.com', 10));
  assert.deepStrictEqual(r, { site: 'a.com', latency: null, loss: 100, jitter: null, p50: null, p95: null, p99: null });
});

test('pingSite never starts more streams than pings', async () => {
  const calls = [];
  await withDeps({ spawn: fakeSpawn(() => '', calls) }, () => pingSite('a.com', 2, 5));
  assert.strictEqual(calls.length, 2);
});

test('pingSite rounds to two decimals', async () => {
  const spawn = fakeSpawn(() => [winReply(1), winReply(2), winReply(2)].join('\n'));
  const r = await withDeps({ platform: 'win32', spawn }, () => pingSite('a.com', 3, 1));
  assert.strictEqual(r.latency, 1.67);
  assert.strictEqual(r.jitter, 0.5);
});

// ------------------------------------------------------------ DNS

test('dnsTest measures a cached and an uncached (random subdomain) lookup', async () => {
  const srv = await dnsServer();
  try {
    const r = await dnsTest('example.com', { name: 'Local', ip: srv.address });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.name, 'Local');
    assert.ok(r.latency >= 0 && r.latency < 1000, `latency ${r.latency}`);
    // NXDOMAIN for the random name still counts as an answer.
    assert.ok(r.uncached >= 0 && r.uncached < 1000, `uncached ${r.uncached}`);
  } finally {
    srv.close();
  }
});

test('dnsTest keeps the cached result when only the uncached lookup fails', async () => {
  const srv = await dnsServer({ failRandom: true });
  try {
    const r = await dnsTest('example.com', { name: 'Local', ip: srv.address });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.uncached, null);
  } finally {
    srv.close();
  }
});

test('dnsTest scores a SERVFAIL as a failure', async () => {
  const srv = await dnsServer({ fail: true });
  try {
    const r = await dnsTest('example.com', { name: 'Local', ip: srv.address });
    assert.deepStrictEqual(r, { name: 'Local', ip: srv.address, latency: probe.DNS_FAIL_MS, ok: false, uncached: null });
  } finally {
    srv.close();
  }
});

test('dnsTest scores an invalid server address as a failure', async () => {
  const r = await dnsTest('example.com', { name: 'Bad', ip: 'not-an-ip' });
  assert.deepStrictEqual(r, { name: 'Bad', ip: 'not-an-ip', latency: probe.DNS_FAIL_MS, ok: false, uncached: null });
});

test('dnsTest scores a timeout as a failure', async () => {
  // A bound socket that never answers.
  const sock = dgram.createSocket('udp4');
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  try {
    const r = await dnsTest('example.com', { name: 'Mute', ip: `127.0.0.1:${sock.address().port}` }, 200);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.latency, probe.DNS_FAIL_MS);
  } finally {
    sock.close();
  }
});

// ------------------------------------------------------------ collect

test('collect probes every site and DNS server', async () => {
  const srv = await dnsServer();
  try {
    const spawn = fakeSpawn(() => winReply(5));
    const result = await withDeps({ platform: 'win32', spawn }, () =>
      collect({
        sites: ['a.com', '', 'b.com'],
        pingCount: 5,
        dnsTestSite: 'example.com',
        dnsServers: [
          { name: 'One', ip: srv.address },
          { name: 'Two', ip: 'bad' },
        ],
      })
    );
    assert.deepStrictEqual(result.stats.map((s) => s.site), ['a.com', 'b.com']);
    assert.deepStrictEqual(result.dns.map((d) => [d.name, d.ok]), [['One', true], ['Two', false]]);
  } finally {
    srv.close();
  }
});

test('collect pings the router and ISP hop with a smaller count', async () => {
  const calls = [];
  const spawn = fakeSpawn(() => winReply(3), calls);
  const result = await withDeps({ platform: 'win32', spawn }, () =>
    collect(
      { sites: ['a.com'], pingCount: 50, dnsTestSite: 'x', dnsServers: [] },
      { path: { gateway: '192.168.1.1', isp: null }, dnsServers: [] }
    )
  );
  assert.deepStrictEqual(result.path, { gateway: { ip: '192.168.1.1', latency: 3, loss: 75, jitter: 0, p95: 3 }, isp: null });
  const gwCalls = calls.filter((c) => c.args.includes('192.168.1.1'));
  // PATH_PINGS (20) over 5 streams, each answering 1 of its 4 pings.
  assert.strictEqual(gwCalls.length, 5);
  assert.ok(gwCalls.every((c) => c.args[1] === String(probe.PATH_PINGS / 5)));
});

test('collect uses the dnsServers override', async () => {
  const srv = await dnsServer();
  try {
    const result = await withDeps({ spawn: fakeSpawn(() => '') }, () =>
      collect(
        { sites: [], pingCount: 5, dnsTestSite: 'example.com', dnsServers: [{ name: 'Configured', ip: 'bad' }] },
        { dnsServers: [{ name: 'Detected', ip: srv.address }] }
      )
    );
    assert.deepStrictEqual(result.dns.map((d) => [d.name, d.ok]), [['Detected', true]]);
  } finally {
    srv.close();
  }
});

// ------------------------------------------------------------ 1.2 additions

test('percentile interpolates between ranks', () => {
  assert.strictEqual(percentile([], 95), null);
  assert.strictEqual(percentile([5], 95), 5);
  assert.strictEqual(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.strictEqual(percentile([4, 1, 3, 2], 50), 2.5);
  assert.ok(Math.abs(percentile([10, 20, 30, 40, 100], 95) - 88) < 1e-9);
});

test('pingSite uses the native ICMP backend when available', async () => {
  const calls = [];
  const native = async (host, count, opts) => {
    calls.push({ host, count, opts });
    return { sent: 10, rtts: [[1.5, 2.5], [2, 3], [1, 1]] };
  };
  const spawnCalls = [];
  const r = await withDeps({ native, spawn: fakeSpawn(() => '', spawnCalls) }, () => pingSite('a.com', 10, 3));
  assert.deepStrictEqual(calls, [{ host: 'a.com', count: 10, opts: { streams: 3 } }]);
  assert.strictEqual(spawnCalls.length, 0, 'no ping processes started');
  assert.strictEqual(r.loss, 40);
  assert.strictEqual(r.latency, 1.83);
  assert.strictEqual(r.jitter, 0.67); // (1 + 1 + 0) / 3, rounded
});

test('pingSite falls back to the ping binary when native returns null', async () => {
  const spawnCalls = [];
  const r = await withDeps({ native: async () => null, platform: 'win32', spawn: fakeSpawn(() => winReply(4), spawnCalls) }, () =>
    pingSite('a.com', 4, 2)
  );
  assert.strictEqual(spawnCalls.length, 2);
  assert.strictEqual(r.latency, 4);
});

test('sampleLatency collects RTTs until the phase settles (native)', async () => {
  let resolve;
  const until = new Promise((r) => (resolve = r));
  let batches = 0;
  const native = async () => {
    batches++;
    if (batches === 3) resolve();
    await new Promise((r) => setTimeout(r, 5));
    return { sent: 5, rtts: [[10, 11]] };
  };
  const rtts = await withDeps({ native }, () => sampleLatency('1.1.1.1', until));
  assert.strictEqual(batches, 3);
  assert.deepStrictEqual(rtts, [10, 11, 10, 11, 10, 11]);
});

test('sampleLatency uses the ping binary without native, and stops on rejection too', async () => {
  let reject;
  const until = new Promise((_, r) => (reject = r));
  let n = 0;
  const spawn = fakeSpawn(() => {
    if (++n === 2) reject(new Error('phase failed'));
    return winReply(20);
  });
  const rtts = await withDeps({ native: null, platform: 'win32', spawn }, () => sampleLatency('1.1.1.1', until));
  assert.deepStrictEqual(rtts, [20, 20]);
});
