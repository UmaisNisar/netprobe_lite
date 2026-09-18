const test = require('node:test');
const assert = require('node:assert');
const icmp = require('../src/main/icmp');

const { load, pingSequences, toIPAddr, parseReply, reset, deps } = icmp;

// A fake koffi whose IcmpSendEcho replies according to `behaviour(n)`:
// { rtt } for success, { status } for an ICMP error, or null for no reply.
function fakeKoffi(behaviour, log = []) {
  let n = 0;
  return {
    load: (dll) => {
      log.push(['load', dll]);
      return {
        func: (sig) => {
          if (sig.includes('IcmpCreateFile')) return () => ({ handle: ++n });
          if (sig.includes('IcmpCloseHandle')) return (h) => log.push(['close', h.handle]);
          const send = () => {
            throw new Error('sync call not expected');
          };
          send.async = (handle, dest, data, size, opts, reply, replySize, timeout, cb) => {
            // The uncounted warm-up echo goes to 127.0.0.1 and always succeeds.
            const warmup = dest === toIPAddr('127.0.0.1');
            log.push([warmup ? 'warmup' : 'send', dest, size, timeout]);
            const r = warmup ? { rtt: 0 } : behaviour(log.filter((l) => l[0] === 'send').length);
            setImmediate(() => {
              if (!r) return cb(null, 0);
              reply.writeUInt32LE(dest, 0);
              reply.writeUInt32LE(r.status ?? 0, 4);
              reply.writeUInt32LE(r.rtt ?? 0, 8);
              cb(null, 1);
            });
          };
          return send;
        },
      };
    },
  };
}

function withDeps(overrides, fn) {
  const saved = { ...deps };
  Object.assign(deps, overrides);
  reset();
  return Promise.resolve(fn()).finally(() => {
    Object.assign(deps, saved);
    reset();
  });
}

const lookup = async () => ({ address: '8.8.4.4' });

test('IPv4 addresses are converted to network byte order', () => {
  assert.strictEqual(toIPAddr('1.2.3.4'), 0x04030201);
  assert.strictEqual(toIPAddr('192.168.1.1'), 0x0101a8c0);
  assert.strictEqual(toIPAddr('255.255.255.255'), 0xffffffff);
});

test('reply status and RTT are read from ICMP_ECHO_REPLY', () => {
  const buf = Buffer.alloc(40);
  buf.writeUInt32LE(11010, 4); // IP_REQ_TIMED_OUT
  buf.writeUInt32LE(7, 8);
  assert.deepStrictEqual(parseReply(buf), { status: 11010, rtt: 7 });
});

test('not available off Windows', async () => {
  await withDeps({ platform: 'linux', requireKoffi: () => assert.fail('must not load koffi') }, async () => {
    assert.strictEqual(load(), null);
    assert.strictEqual(await pingSequences('a.com', 5), null);
  });
});

test('not available when koffi fails to load (falls back to ping.exe)', async () => {
  const requireKoffi = () => {
    throw new Error('Cannot find module');
  };
  await withDeps({ platform: 'win32', requireKoffi }, async () => {
    assert.strictEqual(load(), null);
    assert.strictEqual(await pingSequences('a.com', 5), null);
  });
});

test('load binds iphlpapi once and caches the result', async () => {
  const log = [];
  let loads = 0;
  const requireKoffi = () => (loads++, fakeKoffi(() => ({ rtt: 1 }), log));
  await withDeps({ platform: 'win32', requireKoffi }, () => {
    assert.ok(load());
    assert.ok(load());
    assert.strictEqual(loads, 1);
    assert.deepStrictEqual(log[0], ['load', 'iphlpapi.dll']);
  });
});

test('pings in sequences, counts losses and closes every handle', async () => {
  const log = [];
  // Every third echo gets no reply; every fifth an ICMP error.
  const behaviour = (n) => (n % 3 === 0 ? null : n % 5 === 0 ? { status: 11003 } : { rtt: 1 });
  await withDeps({ platform: 'win32', requireKoffi: () => fakeKoffi(behaviour, log), lookup }, async () => {
    const r = await pingSequences('dns.google', 10, { streams: 2, spacingMs: 0 });
    assert.strictEqual(r.sent, 10);
    assert.strictEqual(r.rtts.length, 2);
    const received = r.rtts.flat().length;
    assert.strictEqual(received, 5); // n = 3, 6, 9 unanswered; n = 5, 10 ICMP errors
    assert.ok(r.rtts.flat().every((v) => v >= 1), 'never below the kernel RTT');
    const sends = log.filter((l) => l[0] === 'send');
    assert.ok(sends.every((l) => l[1] === toIPAddr('8.8.4.4') && l[2] === 32 && l[3] === 1000));
    assert.strictEqual(log.filter((l) => l[0] === 'close').length, 2);
    assert.strictEqual(log.filter((l) => l[0] === 'warmup').length, 2, 'one warm-up per sequence');
  });
});

test('an unresolvable host counts as full loss', async () => {
  const bad = async () => {
    throw new Error('ENOTFOUND');
  };
  await withDeps({ platform: 'win32', requireKoffi: () => fakeKoffi(() => ({ rtt: 1 })), lookup: bad }, async () => {
    assert.deepStrictEqual(await pingSequences('nope.invalid', 5), { sent: 5, rtts: [] });
  });
});

test('never starts more sequences than pings, and spaces pings out', async () => {
  const log = [];
  await withDeps({ platform: 'win32', requireKoffi: () => fakeKoffi(() => ({ rtt: 0 }), log), lookup }, async () => {
    const t0 = Date.now();
    const r = await pingSequences('a.com', 2, { streams: 5, spacingMs: 30 });
    assert.strictEqual(r.rtts.length, 2);
    assert.strictEqual(r.sent, 2);
    assert.ok(Date.now() - t0 >= 25, 'waited for the spacing');
  });
});

test('works against the real Windows API when available', { skip: process.platform !== 'win32' }, async () => {
  reset();
  assert.ok(load(), 'koffi + iphlpapi load on Windows');
  const r = await pingSequences('127.0.0.1', 4, { streams: 2, spacingMs: 10 });
  assert.strictEqual(r.sent, 4);
  assert.strictEqual(r.rtts.flat().length, 4, 'loopback always answers');
});
