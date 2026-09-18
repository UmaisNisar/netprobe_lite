// End-to-end UI tests: the real Electron app (fake network, see entry.js)
// driven with Playwright. Run with `npm run test:e2e` (Linux CI: xvfb-run).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright-core');

const ENTRY = path.join(__dirname, 'entry.js');

async function launch(t, { settings, scenario = 'good' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-e2e-'));
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  const env = { ...process.env, E2E_DATA: dir, E2E_SCENARIO: scenario };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code terminals; stops Electron starting as an app
  const app = await electron.launch({ executablePath: require('electron'), args: [ENTRY], env });
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const readSettings = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  return { app, page, dir, readSettings };
}

const onboarded = { onboarded: true };

test('first run: the welcome screen, then live results', async (t) => {
  const { page, readSettings } = await launch(t);
  const welcome = page.locator('#welcome');
  await welcome.waitFor({ state: 'visible' });
  await page.locator('#welcome-conn').getByText('router 192.168.1.1').waitFor();
  assert.match(await page.locator('#welcome-conn-tip').textContent(), /Wi-Fi/);
  await page.locator('#welcome-form input[name=planDown]').fill('500');
  await page.locator('#welcome-form input[name=speedtestEnabled]').check();
  await page.getByRole('button', { name: 'Start monitoring' }).click();
  await welcome.waitFor({ state: 'hidden' });
  const s = readSettings();
  assert.strictEqual(s.onboarded, true);
  assert.strictEqual(s.planDown, 500);
  assert.strictEqual(s.speedtestEnabled, true);

  await page.locator('#s-latency').getByText('12.3').waitFor();
  assert.match(await page.locator('#s-latency-sub').textContent(), /p95 15.5 ms/);
  assert.strictEqual(await page.locator('#verdict').textContent(), 'All clear');
  assert.match(await page.locator('#p-gateway').textContent(), /192\.168\.1\.1 · 1\.5 ms/);
  assert.match(await page.locator('#p-isp').textContent(), /62\.1\.1\.1 · 7\.5 ms/);
  const chip = page.locator('#conn-chip');
  assert.strictEqual(await chip.textContent(), 'Wi-Fi');
  assert.match(await chip.getAttribute('title'), /wireless signal/);
  assert.match(await page.locator('#s-latency').getAttribute('aria-label'), /Latency: 12.3 ms, good/);
  assert.match(await page.locator('#gauge').getAttribute('aria-label'), /Internet Quality Score \d+ percent/);
});

test('settings are saved to disk and shown again', async (t) => {
  const { page, readSettings } = await launch(t, { settings: onboarded });
  await page.getByRole('button', { name: 'Settings' }).click();
  const drawer = page.locator('#settings');
  await drawer.waitFor({ state: 'visible' });
  // The welcome form has some of the same field names; scope to Settings.
  const form = page.locator('#settings-form');
  await form.locator('textarea[name=sites]').fill('example.com\nexample.org');
  await form.locator('input[name=probeInterval]').fill('45');
  await form.locator('input[name=planDown]').fill('300');
  await form.locator('input[name=speedtestSchedule][value=times]').check();
  await form.locator('input[name=speedtestTimes]').fill('7:30, 19:00');
  await form.locator('input[name=alertsNotify]').uncheck();
  await form.getByRole('button', { name: 'Save' }).click();
  await drawer.waitFor({ state: 'hidden' });

  const s = readSettings();
  assert.deepStrictEqual(s.sites, ['example.com', 'example.org']);
  assert.strictEqual(s.probeInterval, 45);
  assert.strictEqual(s.planDown, 300);
  assert.strictEqual(s.speedtestSchedule, 'times');
  assert.deepStrictEqual(s.speedtestTimes, ['07:30', '19:00']);
  assert.strictEqual(s.alerts.notify, false);

  await page.getByRole('button', { name: 'Settings' }).click();
  assert.strictEqual(await form.locator('input[name=probeInterval]').inputValue(), '45');
  assert.strictEqual(await form.locator('input[name=speedtestTimes]').inputValue(), '07:30, 19:00');
  // Escape closes without saving.
  await form.locator('input[name=probeInterval]').fill('99');
  await page.keyboard.press('Escape');
  await drawer.waitFor({ state: 'hidden' });
  assert.strictEqual(readSettings().probeInterval, 45);
  // The new sites show up in the next probe.
  await page.getByRole('button', { name: 'Probe now' }).click();
  await page.locator('#site-rows').getByText('example.org').waitFor();
});

test('"auto" only applies to the DNS server marked "mine"', async (t) => {
  const { page } = await launch(t, { settings: onboarded });
  await page.getByRole('button', { name: 'Settings' }).click();
  const rows = page.locator('#dns-list .dns-row');
  const last = rows.last();
  assert.ok(await last.locator('input[type=radio]').isChecked());
  assert.ok(await last.locator('[data-f=auto]').isEnabled());
  assert.ok(await rows.first().locator('[data-f=auto]').isDisabled());
  await rows.first().locator('input[type=radio]').check();
  assert.ok(await last.locator('[data-f=auto]').isDisabled(), 'auto follows the radio');
  assert.ok(!(await last.locator('[data-f=auto]').isChecked()));
});

test('history range and connection filter', async (t) => {
  const { page } = await launch(t, { settings: onboarded });
  await page.locator('#c-score .uplot').waitFor();
  const tab = page.getByRole('tab', { name: '24h' });
  await tab.click();
  assert.strictEqual(await tab.getAttribute('aria-selected'), 'true');
  assert.strictEqual(await page.getByRole('tab', { name: '6h' }).getAttribute('aria-selected'), 'false');
  await page.locator('#conn-filter').selectOption('wired');
  // All probes were on Wi-Fi, so a wired-only view is empty.
  await page.locator('#c-score .empty').waitFor();
  await page.locator('#conn-filter').selectOption('wifi');
  await page.locator('#c-score .uplot').waitFor();
});

test('export dialog: custom dates only when "Custom" is chosen', async (t) => {
  const { page } = await launch(t, { settings: onboarded });
  await page.getByRole('button', { name: 'Export report' }).click();
  const custom = page.locator('#export-custom');
  await page.locator('#export').waitFor({ state: 'visible' });
  assert.ok(await custom.isHidden());
  await page.locator('#export-form select[name=range]').selectOption('custom');
  assert.ok(await custom.isVisible());
  await page.locator('#export-cancel').click();
  await page.locator('#export').waitFor({ state: 'hidden' });
});

test('a manual speed test shows bandwidth, plan share and bufferbloat', async (t) => {
  const { page } = await launch(t, { settings: { ...onboarded, planDown: 500 } });
  await page.locator('#s-latency').getByText('12.3').waitFor();
  await page.getByRole('button', { name: 'Speed test' }).click();
  await page.locator('#s-down').getByText('250').waitFor();
  assert.match(await page.locator('#s-speed-sub').textContent(), /50% of plan/);
  assert.match(await page.locator('#s-speed-sub2').textContent(), /bufferbloat B \(\+50 ms\)/);
});

test('an outage shows the incident strip, verdict and incident row', async (t) => {
  // Shortest allowed interval, so the second bad probe comes 15 s later.
  const { page } = await launch(t, { settings: { ...onboarded, probeInterval: 15 }, scenario: 'outage' });
  await page.locator('#verdict').getByText('Outage: Your ISP').waitFor();
  const strip = page.locator('#incident-strip');
  await strip.waitFor({ state: 'visible', timeout: 40_000 });
  assert.match(await strip.textContent(), /Internet outage in progress\. .*Likely cause: Your ISP\./);
  const row = page.locator('#incident-rows tr').first();
  await row.getByText('Outage').waitFor();
  assert.match(await row.textContent(), /ongoing/);
  await row.getByRole('button', { name: 'Traceroute' }).click();
  await page.locator('#incident-rows pre').getByText(/traceroute to \S+ \(test\)/).waitFor();
});
