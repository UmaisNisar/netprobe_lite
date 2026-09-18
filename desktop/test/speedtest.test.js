const test = require('node:test');
const assert = require('node:assert');
const { run, HttpError, DEFAULTS } = require('../src/main/speedtest');

const MB = 1_000_000;

// Fake fetch: downloads stream `chunk`-sized pieces with a small delay,
// uploads drain the request body. Records every request.
function fakeFetch({ downStatus = 200, upStatus = 200, chunk = MB, delayMs = 5 } = {}) {
  const calls = { down: 0, up: 0, upBytes: 0, urls: [] };
  const fetch = async (url, init = {}) => {
    calls.urls.push(url);
    if (url.includes('/__down')) {
      calls.down++;
      if (downStatus !== 200) return { ok: false, status: downStatus, body: null };
      const total = Number(new URL(url).searchParams.get('bytes'));
      let sent = 0;
      const body = new ReadableStream({
        async pull(c) {
          if (sent >= total || init.signal?.aborted) return c.close();
          await new Promise((r) => setTimeout(r, delayMs));
          const n = Math.min(chunk, total - sent);
          sent += n;
          c.enqueue(new Uint8Array(n));
        },
      });
      return { ok: true, status: 200, body };
    }
    calls.up++;
    if (upStatus !== 200) {
      await init.body.cancel();
      return { ok: false, status: upStatus, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const reader = init.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      calls.upBytes += value.byteLength;
      await new Promise((r) => setTimeout(r, 1));
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { fetch, calls };
}

const fast = { durationMs: 300, streams: 2 };

test('defaults match the documented limits', () => {
  assert.strictEqual(DEFAULTS.base, 'https://speed.cloudflare.com');
  assert.strictEqual(DEFAULTS.streams, 4);
  assert.strictEqual(DEFAULTS.durationMs, 8000);
  assert.strictEqual(DEFAULTS.maxBytes, 500 * MB);
  // Cloudflare refuses __down requests of 100 MB or more.
  assert.ok(DEFAULTS.requestBytes < 100 * MB);
});

test('measures download and upload throughput in bits per second', async () => {
  const { fetch, calls } = fakeFetch();
  const r = await run({ ...fast, fetch });
  assert.ok(r.download > 0 && Number.isFinite(r.download), `download ${r.download}`);
  assert.ok(r.upload > 0 && Number.isFinite(r.upload), `upload ${r.upload}`);
  assert.ok(calls.down >= 2 && calls.up >= 2, 'every stream made a request');
  assert.ok(calls.urls.every((u) => u.startsWith(DEFAULTS.base)));
});

test('stops each direction at the byte cap with few requests', async () => {
  const { fetch, calls } = fakeFetch({ chunk: MB, delayMs: 1 });
  await run({ durationMs: 5000, streams: 2, maxBytes: 6 * MB, requestBytes: 2 * MB, fetch });
  // 6 MB cap / 2 MB per request: a handful of requests, not hundreds.
  assert.ok(calls.down <= 5, `download requests ${calls.down}`);
  assert.ok(calls.upBytes <= 6 * MB + 2 * 256 * 1024, `uploaded ${calls.upBytes}`);
});

test('reports throughput over the real duration when the cap ends a test early', async () => {
  const { fetch } = fakeFetch({ chunk: MB, delayMs: 20 });
  const started = Date.now();
  const r = await run({ durationMs: 10_000, streams: 1, maxBytes: 3 * MB, requestBytes: 3 * MB, fetch });
  const elapsed = (Date.now() - started) / 1000;
  assert.ok(elapsed < 5, 'finished well before the 10 s window');
  // 3 MB in ~60 ms is ~400 Mbps; dividing by the full 10 s would give ~2.4 Mbps.
  assert.ok(r.download > 50 * MB, `download ${r.download}`);
});

test('turns HTTP 429 into a rate-limit message', async () => {
  const { fetch } = fakeFetch({ downStatus: 429 });
  await assert.rejects(run({ ...fast, fetch }), (e) => {
    assert.ok(e instanceof HttpError);
    assert.strictEqual(e.status, 429);
    assert.match(e.message, /rate-limiting/);
    return true;
  });
});

test('fails the test on other HTTP errors', async () => {
  const { fetch } = fakeFetch({ downStatus: 403 });
  await assert.rejects(run({ ...fast, fetch }), /Download failed \(HTTP 403\)/);
});

test('fails the test when upload is rejected', async () => {
  const { fetch } = fakeFetch({ upStatus: 500 });
  await assert.rejects(run({ ...fast, fetch }), /Upload failed \(HTTP 500\)/);
});

test('fails the test on network errors', async () => {
  const fetch = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(run({ ...fast, fetch }), /fetch failed/);
});

test('HttpError keeps the status code', () => {
  assert.strictEqual(new HttpError('Download', 503).status, 503);
  assert.match(new HttpError('Upload', 503).message, /^Upload failed/);
});
