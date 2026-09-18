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
// A first-run profile with the web dashboard switched on.
const PORT = 20000 + Math.floor(Math.random() * 20000);
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: false, server: { enabled: true, port: PORT } }));

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

  // The welcome screen opens once the first state arrives; give it a moment.
  for (let i = 0; i < 50 && !(await js(`document.querySelector('#welcome')?.open`)); i++) await sleep(200);
  const ui = await js(`({
    lib: typeof window.NetprobeLib?.pivot === 'function',
    bridge: typeof window.netprobe?.getState === 'function',
    uplot: typeof window.uPlot === 'function',
    gauge: !!document.querySelector('#gauge-fill'),
    charts: document.querySelectorAll('.chart').length,
    connChip: !!document.querySelector('#conn-chip'),
    path: document.querySelectorAll('.path .node').length,
    exportDialog: !!document.querySelector('#export-form'),
    welcome: document.querySelector('#welcome').open,
  })`);
  log('ui', JSON.stringify(ui));
  if (!ui.lib || !ui.bridge || !ui.uplot || !ui.gauge || !ui.connChip || !ui.exportDialog || !ui.welcome || ui.path !== 4 || ui.charts !== 7) {
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
  // The same dashboard, API and metrics over HTTP (always-on mode).
  const base = `http://127.0.0.1:${PORT}`;
  const web = {
    page: (await fetch(`${base}/`)).status,
    state: (await (await fetch(`${base}/api/state`)).json()).web,
    metrics: /Health_Stats \d/.test(await (await fetch(`${base}/metrics`)).text()),
  };
  log('web', JSON.stringify(web));
  if (web.page !== 200 || !web.state?.canWrite || !web.metrics) {
    clearTimeout(timer);
    return finish(1, 'FAIL: web dashboard / metrics not served');
  }

  // Render the PDF report the same way the Export button does.
  const { Store } = require('../src/main/db');
  const { Settings } = require('../src/main/settings');
  const report = require('../src/main/report');
  const store = new Store(dir);
  const data = report.buildReport(store, { from: Date.now() - 3600_000, to: Date.now() + 1, settings: new Settings(dir).get() });
  store.close();
  const page = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await page.loadFile(require('node:path').join(__dirname, '..', 'src', 'renderer', 'report.html'));
  await page.webContents.executeJavaScript(`window.renderReport(${JSON.stringify(data)})`);
  const pdf = await page.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  page.destroy();
  log('report', JSON.stringify({ findings: data.findings.length, pdfBytes: pdf.length }));
  if (pdf.subarray(0, 4).toString() !== '%PDF' || pdf.length < 10_000) return finish(1, 'FAIL: PDF report did not render');
  if (errors.length) return finish(1, 'FAIL: renderer logged errors');
  finish(0, 'PASS');
});
