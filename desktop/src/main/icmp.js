// Native ICMP echo on Windows via iphlpapi's IcmpSendEcho (no admin rights
// needed), called through koffi. Compared with spawning ping.exe it gives
// sub-millisecond timing (ping.exe only prints whole milliseconds), sends
// pings on a fixed schedule instead of one per second, and doesn't start 25
// processes per probe. Anything unexpected makes load() return null and the
// probe falls back to ping.exe.

const dns = require('node:dns').promises;
const { performance } = require('node:perf_hooks');

const IP_SUCCESS = 0;
const PAYLOAD = Buffer.alloc(32, 0x61); // same 32 bytes ping.exe sends
const LOOPBACK = 0x0100007f; // 127.0.0.1 in network byte order
const REPLY_SIZE = 256; // >= sizeof(ICMP_ECHO_REPLY) + payload + 8 + IO_STATUS_BLOCK

// Swappable in tests.
const deps = { platform: process.platform, requireKoffi: () => require('koffi'), lookup: (h) => dns.lookup(h, { family: 4 }) };

let cached; // undefined = not tried, null = unavailable

function load() {
  if (cached !== undefined) return cached;
  cached = null;
  if (deps.platform !== 'win32') return cached;
  try {
    const koffi = deps.requireKoffi();
    const lib = koffi.load('iphlpapi.dll');
    const create = lib.func('void* __stdcall IcmpCreateFile()');
    const close = lib.func('bool __stdcall IcmpCloseHandle(void* handle)');
    const send = lib.func(
      'uint32 __stdcall IcmpSendEcho(void* handle, uint32 dest, void* data, uint16 size, void* options, _Out_ uint8_t* reply, uint32 replySize, uint32 timeout)'
    );
    cached = { create, close, send };
  } catch {
    cached = null;
  }
  return cached;
}

// IPv4 dotted string -> IPAddr (network byte order, read as a little-endian uint32).
function toIPAddr(ip) {
  const b = ip.split('.').map(Number);
  return ((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0;
}

// ICMP_ECHO_REPLY: Address(u32) Status(u32) RoundTripTime(u32) ...
function parseReply(buf) {
  return { status: buf.readUInt32LE(4), rtt: buf.readUInt32LE(8) };
}

function echo(api, handle, dest, timeoutMs) {
  const reply = Buffer.alloc(REPLY_SIZE);
  const start = performance.now();
  return new Promise((resolve) => {
    api.send.async(handle, dest, PAYLOAD, PAYLOAD.length, null, reply, REPLY_SIZE, timeoutMs, (err, count) => {
      const elapsed = performance.now() - start;
      if (err || !count) return resolve(null);
      const { status, rtt } = parseReply(reply);
      if (status !== IP_SUCCESS) return resolve(null);
      // The wall-clock measurement includes a little thread hand-off
      // overhead; never report less than the kernel's own RTT.
      resolve(Math.max(elapsed, rtt));
    });
  });
}

// `count` pings in `streams` sequences, one every `spacingMs` per sequence.
// Returns { sent, rtts: [[...], ...] } (one array per sequence, for jitter).
async function pingSequences(host, count, { streams = 5, spacingMs = 100, timeoutMs = 1000 } = {}) {
  const api = load();
  if (!api) return null;
  let ip;
  try {
    ip = (await deps.lookup(host)).address;
  } catch {
    return { sent: count, rtts: [] }; // unresolvable: everything lost
  }
  const dest = toIPAddr(ip);
  const perStream = Math.ceil(count / streams);
  const run = async () => {
    const handle = api.create();
    const rtts = [];
    try {
      // The first call on a handle pays ~10 ms of worker-thread start-up;
      // spend it on an uncounted loopback echo, which answers instantly.
      await echo(api, handle, LOOPBACK, 100);
      for (let i = 0; i < perStream; i++) {
        const t0 = performance.now();
        const rtt = await echo(api, handle, dest, timeoutMs);
        if (rtt != null) rtts.push(Math.round(rtt * 100) / 100);
        const wait = spacingMs - (performance.now() - t0);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      api.close(handle);
    }
    return rtts;
  };
  const sequences = await Promise.all(Array.from({ length: Math.min(streams, count) }, run));
  return { sent: perStream * sequences.length, rtts: sequences };
}

function reset() {
  cached = undefined;
}

module.exports = { load, pingSequences, toIPAddr, parseReply, reset, deps };
