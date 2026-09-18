// End-to-end smoke test: boots the real app with a throwaway profile and
// checks that the dashboard loads without errors and that one full probe
// (ping + DNS + score + SQLite + IPC) completes. Exits 0 on success.
// Usage: electron scripts/smoke.js   (Linux CI: xvfb-run electron ...)

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIMEOUT_MS = 90_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netprobe-smoke-'));
app.setPath('userData', dir);

const errors = [];
const log = (...a) => console.log('[smoke]', ...a);

function finish(code, message) {
  log(message);
  if (errors.length) log('renderer errors:\n  ' + errors.join('\n  '));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may still hold the db file; the OS temp cleaner will get it.
  }
  app.exit(code);
}

const timer = setTimeout(() => finish(1, `FAIL: timed out after ${TIMEOUT_MS / 1000}s`), TIMEOUT_MS);

process.on('uncaughtException', (e) => {
  clearTimeout(timer);
  finish(1, `FAIL: uncaught exception in main: ${e.stack || e}`);
});

app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message);
  });
  wc.on('preload-error', (_ev, p, err) => errors.push(`preload ${p}: ${err}`));
  wc.on('render-process-gone', (_ev, d) => errors.push(`renderer gone: ${d.reason}`));
});

require('../src/main/main');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100);
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  const js = (code) => win.webContents.executeJavaScript(code);

  const ui = await js(`({
    lib: typeof window.NetprobeLib?.pivot === 'function',
    bridge: typeof window.netprobe?.getState === 'function',
    uplot: typeof window.uPlot === 'function',
    gauge: !!document.querySelector('#gauge-fill'),
    charts: document.querySelectorAll('.chart').length,
    wifiBanner: !!document.querySelector('#wifi-banner'),
  })`);
  log('ui', JSON.stringify(ui));
  if (!ui.lib || !ui.bridge || !ui.uplot || !ui.gauge || !ui.wifiBanner || ui.charts !== 6) {
    clearTimeout(timer);
    return finish(1, 'FAIL: dashboard did not initialise');
  }

  // Wait for the first probe to land. On CI runners ICMP is often blocked,
  // so 100% loss is acceptable; what matters is that the pipeline completes.
  let state;
  for (;;) {
    state = await js('window.netprobe.getState()');
    if (state.latest || state.lastError) break;
    await sleep(1000);
  }
  if (state.lastError) {
    clearTimeout(timer);
    return finish(1, `FAIL: probe error: ${state.lastError}`);
  }
  const s = state.latest.summary;
  log('probe', JSON.stringify({ score: s.score, latency: s.latency, loss: s.loss, dns: state.latest.result.dns.length }));
  log('connection', JSON.stringify(state.connection));

  const history = await js('window.netprobe.getHistory(3600000)');
  const rendered = await js(`!!document.querySelector('#c-score .uplot') && document.querySelector('#score').textContent !== '–'`);
  clearTimeout(timer);
  if (history.runs.length < 1) return finish(1, 'FAIL: probe was not stored');
  if (!rendered) return finish(1, 'FAIL: dashboard did not render the probe');
  if (errors.length) return finish(1, 'FAIL: renderer logged errors');
  finish(0, 'PASS');
});
