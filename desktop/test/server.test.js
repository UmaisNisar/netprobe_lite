const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createServer, lanAddresses, safeEqual, isLoopback } = require('../src/main/server');

// A monitor stand-in with just what the server uses.
function fakeMonitor() {
  const m = new EventEmitter();
  m.calls = [];
  m.settingsValue = { probeInterval: 30, planDown: 0, planUp: 0, sites: ['a.com'], dnsServers: [] };
  m.settings = { get: () => m.settingsValue };
  m.publicState = () => ({ latest: null, speed: null, incident: null, uptime: {}, connection: { type: 'wired' }, settings: m.settingsValue });
  m.history = (range, conn) => (m.calls.push(['history', range, conn]), { runs: [], sites: [], dns: [], speed: [], incidents: [] });
  m.incidents = (range) => (m.calls.push(['incidents', range]), []);
  for (const a of ['runProbe', 'runSpeedtest', 'togglePause', 'clearHistory']) m[a] = () => m.calls.push([a]);
  const empty = () => [];
  m.store = { runsBetween: empty, speedBetween: empty, incidentsBetween: empty };
  return m;
}

async function start(t, opts = {}) {
  const monitor = fakeMonitor();
  const saved = [];
  const server = createServer({ monitor, saveSettings: (s) => (saved.push(s), { ...s, saved: true }), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { monitor, saved, server, base };
}

async function req(url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url, { method, body: body && JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON.
  }
  return { status: res.status, headers: res.headers, text, json };
}

test('serves the dashboard with the web bridge instead of the preload', async (t) => {
  const { base } = await start(t);
  const r = await req(`${base}/`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.text, /<script src="web-bridge.js"><\/script><script src="lib.js"><\/script>/);
  for (const f of ['/app.js', '/lib.js', '/styles.css', '/web-bridge.js', '/assets/icon.png', '/node_modules/uplot/dist/uPlot.iife.min.js']) {
    assert.strictEqual((await req(`${base}${f}`)).status, 200, f);
  }
  const rep = await req(`${base}/report?from=0&to=1`);
  assert.match(rep.text, /report-web.js/);
});

test('JSON API passes parameters through and clamps ranges', async (t) => {
  const { base, monitor } = await start(t);
  const s = await req(`${base}/api/state`);
  assert.strictEqual(s.json.web.canWrite, true, 'loopback can write');
  await req(`${base}/api/history?range=3600000&conn=wifi`);
  await req(`${base}/api/history?range=-5`);
  await req(`${base}/api/incidents?range=999999999999999`);
  assert.deepStrictEqual(monitor.calls, [
    ['history', 3600000, 'wifi'],
    ['history', 6 * 3600_000, null],
    ['incidents', 400 * 86400_000],
  ]);
});

test('report and CSV export', async (t) => {
  const { base } = await start(t);
  const r = await req(`${base}/api/report?from=0&to=3600000`);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.findings));
  const csv = await req(`${base}/api/export/probes.csv?from=0&to=3600000`);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="netprobe-1970-01-01-to-1970-01-01-probes.csv"/);
  // text() strips a BOM when decoding, so look at the raw bytes.
  const raw = Buffer.from(await (await fetch(`${base}/api/export/probes.csv?from=0&to=3600000`)).arrayBuffer());
  assert.deepStrictEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
  assert.match(csv.text, /^time,score_pct/);
  assert.strictEqual((await req(`${base}/api/export/incidents.csv?from=0&to=1`)).status, 200);
  assert.strictEqual((await req(`${base}/api/export/speedtests.csv?from=0&to=1`)).status, 200);
  assert.strictEqual((await req(`${base}/api/report?from=10&to=5`)).status, 400);
});

test('Prometheus metrics', async (t) => {
  const { base } = await start(t);
  const r = await req(`${base}/metrics`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/plain; version=0.0.4/);
  assert.match(r.text, /netprobe_incident_open/);
});

test('actions and settings from loopback', async (t) => {
  const { base, monitor, saved } = await start(t);
  for (const a of ['probe-now', 'speedtest-now', 'toggle-pause', 'clear-history']) {
    assert.strictEqual((await req(`${base}/api/${a}`, { method: 'POST' })).status, 202, a);
  }
  assert.deepStrictEqual(monitor.calls.map((c) => c[0]), ['runProbe', 'runSpeedtest', 'togglePause', 'clearHistory']);
  const put = await req(`${base}/api/settings`, { method: 'PUT', body: { probeInterval: 60 } });
  assert.deepStrictEqual(put.json, { probeInterval: 60, saved: true });
  assert.deepStrictEqual(saved, [{ probeInterval: 60 }]);
});

test('rejects bad input', async (t) => {
  const { base } = await start(t);
  assert.strictEqual((await req(`${base}/nope`)).status, 404);
  assert.strictEqual((await req(`${base}/api/state`, { method: 'DELETE' })).status, 404);
  const bad = await fetch(`${base}/api/settings`, { method: 'PUT', body: '{not json' });
  assert.strictEqual(bad.status, 400);
  const big = await fetch(`${base}/api/settings`, { method: 'PUT', body: 'x'.repeat(200_000) }).catch(() => ({ status: 413 }));
  assert.strictEqual(big.status, 413);
});

test('pushes state over server-sent events', async (t) => {
  const { base, monitor } = await start(t);
  const got = await new Promise((resolve, reject) => {
    const r = http.get(`${base}/api/events`, (res) => {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      let buf = '';
      const events = [];
      res.on('data', (d) => {
        buf += d;
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const p of parts) if (p.startsWith('data: ')) events.push(JSON.parse(p.slice(6)));
        if (events.length === 1) monitor.emit('state', { hello: 'world' });
        if (events.length === 2) {
          r.destroy();
          resolve(events);
        }
      });
    });
    r.on('error', reject);
  });
  assert.strictEqual(got[0].web.canWrite, true);
  assert.deepStrictEqual(got[1], { hello: 'world', web: { canWrite: true } });
});

// Other devices are simulated by overriding each socket's remote address.
test('non-loopback viewers: read-only without a token', async (t) => {
  const { base, server } = await start(t);
  // Make every connection look remote.
  server.prependListener('connection', (sock) => Object.defineProperty(sock, 'remoteAddress', { value: '192.168.1.50' }));
  const s = await req(`${base}/api/state`);
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.json.web.canWrite, false);
  const w = await req(`${base}/api/probe-now`, { method: 'POST' });
  assert.strictEqual(w.status, 403);
  assert.match(w.json.error, /only allowed on the computer running Netprobe/);
  assert.strictEqual((await req(`${base}/api/settings`, { method: 'PUT', body: {} })).status, 403);
});

test('non-loopback viewers: a token is required for everything when set', async (t) => {
  const { base, server } = await start(t, { token: 's3cret' });
  server.prependListener('connection', (sock) => Object.defineProperty(sock, 'remoteAddress', { value: '10.0.0.9' }));
  assert.strictEqual((await req(`${base}/`)).status, 401);
  assert.strictEqual((await req(`${base}/metrics`)).status, 401);
  assert.strictEqual((await req(`${base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await req(`${base}/api/state`, { headers: { Authorization: 'Bearer s3cret' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.web.canWrite, true);
  // ?token= sets a cookie so the dashboard's own requests carry it.
  const first = await req(`${base}/?token=s3cret`);
  assert.strictEqual(first.status, 200);
  const cookie = first.headers.get('set-cookie');
  assert.match(cookie, /np_token=s3cret; Path=\/; HttpOnly; SameSite=Strict/);
  const withCookie = await req(`${base}/api/probe-now`, { method: 'POST', headers: { Cookie: 'np_token=s3cret' } });
  assert.strictEqual(withCookie.status, 202);
});

test('helpers', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
  assert.ok(isLoopback({ socket: { remoteAddress: '::ffff:127.0.0.1' } }));
  assert.ok(!isLoopback({ socket: { remoteAddress: '192.168.1.2' } }));
  assert.ok(lanAddresses().every((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a) && !a.startsWith('127.')));
});

test('closing the server ends event streams and detaches from the monitor', async (t) => {
  const { base, monitor, server } = await start(t);
  await new Promise((resolve) => {
    http.get(`${base}/api/events`, (res) => {
      res.once('data', () => {
        assert.strictEqual(monitor.listenerCount('state'), 1);
        res.on('end', resolve);
        server.close();
      });
    });
  });
  assert.strictEqual(monitor.listenerCount('state'), 0);
});
