// Bandwidth test against Cloudflare's public speed test endpoints (the same
// ones speed.cloudflare.com uses). Each direction runs a few parallel
// streams for a fixed duration and measures bytes actually transferred.
//
// Requests are kept large (Cloudflare rate-limits by request count and
// refuses sizes of 100 MB or more), and each direction stops at MAX_BYTES so
// fast lines don't burn gigabytes per test (8 s at 2 Gbps would be ~2 GB).
// That is at most 10 requests per direction.

const { performance } = require('node:perf_hooks');

const BASE = 'https://speed.cloudflare.com';
const STREAMS = 4;
const DURATION_MS = 8000;
const MAX_BYTES = 500_000_000;
const REQUEST_BYTES = 50_000_000;
const UP_BLOCK = new Uint8Array(256 * 1024);

const done = (deadline, counter) => performance.now() >= deadline || counter.bytes >= MAX_BYTES;

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

async function downloadStream(deadline, counter, signal) {
  while (!done(deadline, counter)) {
    const res = await fetch(`${BASE}/__down?bytes=${REQUEST_BYTES}`, { signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new HttpError('Download', res.status);
    for await (const chunk of res.body) {
      counter.bytes += chunk.byteLength;
      if (done(deadline, counter)) break; // leaving the loop cancels the body
    }
  }
}

async function uploadStream(deadline, counter, signal) {
  while (!done(deadline, counter)) {
    let sent = 0;
    // Bytes are counted as the request body is pulled onto the socket, so a
    // slow uplink still gets a measurement when the deadline cuts it short.
    const body = new ReadableStream({
      pull(controller) {
        if (done(deadline, counter) || sent >= REQUEST_BYTES) {
          controller.close();
          return;
        }
        controller.enqueue(UP_BLOCK);
        sent += UP_BLOCK.byteLength;
        counter.bytes += UP_BLOCK.byteLength;
      },
    });
    const res = await fetch(`${BASE}/__up`, { method: 'POST', body, duplex: 'half', signal });
    if (!res.ok) throw new HttpError('Upload', res.status);
    await res.arrayBuffer();
  }
}

async function measure(stream) {
  const controller = new AbortController();
  const counter = { bytes: 0 };
  const start = performance.now();
  const deadline = start + DURATION_MS;
  // Hard stop for anything still in flight well after the window closes.
  const stop = setTimeout(() => controller.abort(), DURATION_MS + 20000);
  const results = await Promise.allSettled(
    Array.from({ length: STREAMS }, () => stream(deadline, counter, controller.signal))
  );
  clearTimeout(stop);
  const elapsed = Math.min(performance.now() - start, DURATION_MS) / 1000;
  controller.abort();
  const failed = results.find((r) => r.status === 'rejected');
  // Any failed stream makes the number meaningless (it would under-report).
  if (failed || counter.bytes === 0) throw failed ? failed.reason : new Error('No data transferred');
  // Streams that hit the byte cap finish early; use the real duration then.
  const seconds = counter.bytes >= MAX_BYTES ? (performance.now() - start) / 1000 : elapsed;
  return (counter.bytes * 8) / seconds; // bits per second
}

async function run() {
  const download = await measure(downloadStream);
  const upload = await measure(uploadStream);
  return { download, upload };
}

module.exports = { run };
