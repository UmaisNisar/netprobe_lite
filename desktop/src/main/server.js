// HTTP server for the always-on mode: serves the same dashboard to any
// browser on the network, a JSON API behind it, live updates over
// server-sent events, CSV/report export, and Prometheus /metrics.
// Plain Node (no Electron), shared by the desktop app and the headless CLI.
//
// Access: without a token anyone who can reach the port may *view*, but only
// the machine itself (loopback) may change anything. With a token, every
// request needs it (Bearer header, ?token=, or the cookie set by ?token=)
// unless it comes from loopback.

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { metrics } = require('./metrics');
const report = require('./report');

const ROOT = path.join(__dirname, '..', '..'); // the desktop/ folder (or app.asar)
const RENDERER = 'src/renderer';
const STATIC = {
  '/app.js': `${RENDERER}/app.js`,
  '/lib.js': `${RENDERER}/lib.js`,
  '/styles.css': `${RENDERER}/styles.css`,
  '/report.js': `${RENDERER}/report.js`,
  '/web-bridge.js': `${RENDERER}/web-bridge.js`,
  '/report-web.js': `${RENDERER}/report-web.js`,
  '/assets/icon.png': 'assets/icon.png',
  '/node_modules/uplot/dist/uPlot.iife.min.js': 'node_modules/uplot/dist/uPlot.iife.min.js',
  '/node_modules/uplot/dist/uPlot.min.css': 'node_modules/uplot/dist/uPlot.min.css',
};
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.html': 'text/html' };
const MAX_BODY = 100_000;
const ACTIONS = {
  '/api/probe-now': (m) => m.runProbe(),
  '/api/speedtest-now': (m) => m.runSpeedtest(),
  '/api/toggle-pause': (m) => m.togglePause(),
  '/api/clear-history': (m) => m.clearHistory(),
};
const DAY = 86400_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// This machine's IPv4 addresses other devices can reach it on.
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function isLoopback(req) {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function cookie(req, name) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Serve the Electron pages with a fetch-based bridge instead of the preload.
function page(file, inject) {
  const html = fs.readFileSync(path.join(ROOT, RENDERER, file), 'utf8');
  return html.replace('<script src="lib.js"></script>', `${inject}<script src="lib.js"></script>`);
}

function createServer({ monitor, saveSettings, token = null, log = () => {} }) {
  const clients = new Map(); // response -> may this viewer change things
  const event = (state, canWrite) => `data: ${JSON.stringify({ ...state, web: { canWrite } })}\n\n`;
  const onState = (state) => {
    for (const [res, canWrite] of clients) res.write(event(state, canWrite));
  };
  monitor.on('state', onState);

  const send = (res, status, body, type = 'application/json; charset=utf-8', headers = {}) => {
    const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(data);
  };

  const range = (q, fallback) => {
    const r = Number(q.get('range') ?? fallback);
    return Number.isFinite(r) && r > 0 ? Math.min(r, 400 * DAY) : fallback;
  };
  const period = (q) => {
    const to = Number(q.get('to') ?? Date.now());
    const from = Number(q.get('from') ?? to - 7 * DAY);
    if (!(to > from)) throw new HttpError(400, 'The end of the period must be after its start.');
    return { from, to };
  };

  async function route(req, res, url, access) {
    const { pathname: p, searchParams: q } = url;
    const method = req.method;
    const write = () => {
      if (!access.write) {
        throw new HttpError(403, 'Changes are only allowed on the computer running Netprobe, or with its access token.');
      }
    };

    if (method === 'GET' && p === '/') {
      return send(res, 200, page('index.html', '<script src="web-bridge.js"></script>'), 'text/html; charset=utf-8');
    }
    if (method === 'GET' && p === '/report') {
      return send(res, 200, page('report.html', '').replace('<script src="report.js"></script>', '<script src="report.js"></script><script src="report-web.js"></script>'), 'text/html; charset=utf-8');
    }
    if (method === 'GET' && STATIC[p]) {
      const file = path.join(ROOT, STATIC[p]);
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? 'application/octet-stream', { 'Cache-Control': 'max-age=300' });
    }
    if (method === 'GET' && p === '/metrics') {
      return send(res, 200, metrics(monitor.publicState()), 'text/plain; version=0.0.4; charset=utf-8');
    }
    if (method === 'GET' && p === '/api/state') return send(res, 200, { ...monitor.publicState(), web: { canWrite: access.write } });
    if (method === 'GET' && p === '/api/history') return send(res, 200, monitor.history(range(q, 6 * 3600_000), q.get('conn') || null));
    if (method === 'GET' && p === '/api/incidents') return send(res, 200, monitor.incidents(range(q, 30 * DAY)));
    if (method === 'GET' && p === '/api/report') {
      const { from, to } = period(q);
      return send(res, 200, report.buildReport(monitor.store, { from, to, settings: monitor.settings.get() }));
    }
    const csv = p.match(/^\/api\/export\/(probes|incidents|speedtests)\.csv$/);
    if (method === 'GET' && csv) {
      const { from, to } = period(q);
      const s = monitor.store;
      const body = {
        probes: () => report.probesCsv(s.runsBetween(from, to)),
        incidents: () => report.incidentsCsv(s.incidentsBetween(from, to)),
        speedtests: () => report.speedCsv(s.speedBetween(from, to)),
      }[csv[1]]();
      const name = `netprobe-${new Date(from).toISOString().slice(0, 10)}-to-${new Date(to).toISOString().slice(0, 10)}-${csv[1]}.csv`;
      return send(res, 200, '\uFEFF' + body, 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="${name}"` });
    }
    if (method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(event(monitor.publicState(), access.write));
      clients.set(res, access.write);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return undefined;
    }
    if (method === 'POST' && ACTIONS[p]) {
      write();
      ACTIONS[p](monitor); // long-running ones (probe, speed test) report back over /api/events
      return send(res, 202, { ok: true });
    }
    if (method === 'PUT' && p === '/api/settings') {
      write();
      return send(res, 200, saveSettings(await readBody(req)));
    }
    throw new HttpError(404, 'Not found');
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'Bad request' });
    }
    try {
      const local = isLoopback(req);
      const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || cookie(req, 'np_token');
      const authed = !token || (given && safeEqual(given, token));
      if (!local && !authed) throw new HttpError(401, 'This Netprobe needs an access token: open it with ?token=YOUR_TOKEN.');
      // Remember a token passed in the URL so the dashboard's own requests carry it.
      if (token && url.searchParams.get('token') && authed) {
        res.setHeader('Set-Cookie', `np_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      }
      await route(req, res, url, { write: local || Boolean(token && authed) });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`server error: ${e.stack || e}`);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : e.message });
    }
  });

  const close = server.close.bind(server);
  server.close = (cb) => {
    monitor.off('state', onState);
    for (const res of clients.keys()) res.end();
    clients.clear();
    return close(cb);
  };
  return server;
}

module.exports = { createServer, lanAddresses, isLoopback, safeEqual, STATIC };
