// Bandwidth test against Cloudflare's public speed test endpoints (the same
// ones speed.cloudflare.com uses). Each direction runs a few parallel
// streams for a fixed duration and measures bytes actually transferred.
//
// Requests are kept large (Cloudflare rate-limits by request count and
// refuses sizes of 100 MB or more), and each direction stops at MAX_BYTES so
// fast lines don't burn gigabytes per test (8 s at 2 Gbps would be ~2 GB).
// That is at most 10 requests per direction.

const { performance } = require('node:perf_hooks');

const DEFAULTS = {
  base: 'https://speed.cloudflare.com',
  streams: 4,
  durationMs: 8000,
  maxBytes: 500_000_000,
  requestBytes: 50_000_000,
  fetch: (...args) => fetch(...args),
};
const UP_BLOCK = new Uint8Array(256 * 1024);

const done = (deadline, counter, o) => performance.now() >= deadline || counter.bytes >= o.maxBytes;

class HttpError extends Error {
  constructor(what, status) {
    super(
      status === 429
        ? 'Cloudflare is rate-limiting speed tests from this network (HTTP 429). It will retry at the next interval; consider a longer interval.'
        : `${what} failed (HTTP ${status})`
    );
    this.status = status;
  }
}

async function downloadStream(deadline, counter, signal, o) {
  while (!done(deadline, counter, o)) {
    const res = await o.fetch(`${o.base}/__down?bytes=${o.requestBytes}`, { signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new HttpError('Download', res.status);
    for await (const chunk of res.body) {
      counter.bytes += chunk.byteLength;
      if (done(deadline, counter, o)) break; // leaving the loop cancels the body
    }
  }
}

async function uploadStream(deadline, counter, signal, o) {
  while (!done(deadline, counter, o)) {
    let sent = 0;
    // Bytes are counted as the request body is pulled onto the socket, so a
    // slow uplink still gets a measurement when the deadline cuts it short.
    const body = new ReadableStream({
      pull(controller) {
        if (done(deadline, counter, o) || sent >= o.requestBytes) {
          controller.close();
          return;
        }
        controller.enqueue(UP_BLOCK);
        sent += UP_BLOCK.byteLength;
        counter.bytes += UP_BLOCK.byteLength;
      },
    });
    const res = await o.fetch(`${o.base}/__up`, { method: 'POST', body, duplex: 'half', signal });
    if (!res.ok) throw new HttpError('Upload', res.status);
    await res.arrayBuffer();
  }
}

async function measure(stream, o) {
  const controller = new AbortController();
  const counter = { bytes: 0 };
  const start = performance.now();
  const deadline = start + o.durationMs;
  // Hard stop for anything still in flight well after the window closes.
  const stop = setTimeout(() => controller.abort(), o.durationMs + 20000);
  const results = await Promise.allSettled(
    Array.from({ length: o.streams }, () => stream(deadline, counter, controller.signal, o))
  );
  clearTimeout(stop);
  const elapsed = Math.min(performance.now() - start, o.durationMs) / 1000;
  controller.abort();
  const failed = results.find((r) => r.status === 'rejected');
  // Any failed stream makes the number meaningless (it would under-report).
  if (failed || counter.bytes === 0) throw failed ? failed.reason : new Error('No data transferred');
  // Streams that hit the byte cap finish early; use the real duration then.
  const seconds = counter.bytes >= o.maxBytes ? (performance.now() - start) / 1000 : elapsed;
  return (counter.bytes * 8) / seconds; // bits per second
}

// Options exist for tests; the app always uses the defaults.
async function run(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const download = await measure(downloadStream, o);
  const upload = await measure(uploadStream, o);
  return { download, upload };
}

module.exports = { run, HttpError, DEFAULTS };
