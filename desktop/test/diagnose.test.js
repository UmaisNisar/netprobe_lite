const test = require('node:test');
const assert = require('node:assert');
const { diagnose, severity, locate, segment, LIMITS, LOCATIONS } = require('../src/main/diagnose');

const alerts = { degradedScore: 0.6, degradedLoss: 2 };
const settings = { alerts };
const site = (latency, loss = 0) => ({ site: 's', latency, loss, jitter: 1 });
const hop = (latency, loss = 0, jitter = 1) => ({ ip: '1.2.3.4', latency, loss, jitter });
const wifi = { type: 'wifi' };

test('severity: no site answering is an outage', () => {
  assert.strictEqual(severity({ score: 0 }, { stats: [site(null, 100), site(null, 100)] }, alerts), 'outage');
  assert.strictEqual(severity({ score: 0 }, { stats: [] }, alerts), 'outage');
});

test('severity: low score or loss is degraded, otherwise ok', () => {
  const stats = [site(10)];
  assert.strictEqual(severity({ score: 0.5, loss: 0 }, { stats }, alerts), 'degraded');
  assert.strictEqual(severity({ score: 0.9, loss: 2 }, { stats }, alerts), 'degraded');
  assert.strictEqual(severity({ score: 0.9, loss: 1.9 }, { stats }, alerts), 'ok');
});

test('segment health uses per-segment limits', () => {
  assert.strictEqual(segment(null, LIMITS.gateway, true), 'unknown');
  assert.strictEqual(segment(hop(2), LIMITS.gateway, true), 'ok');
  assert.strictEqual(segment(hop(2, 5), LIMITS.gateway, true), 'bad');
  assert.strictEqual(segment(hop(60), LIMITS.gateway, true), 'bad');
  assert.strictEqual(segment(hop(60), LIMITS.isp, true), 'ok');
  assert.strictEqual(segment(hop(5, 0, 25), LIMITS.gateway, true), 'bad');
});

test('a hop that ignores ping while sites answer is "silent", not broken', () => {
  assert.strictEqual(segment(hop(null, 100), LIMITS.gateway, true), 'silent');
  assert.strictEqual(segment(hop(null, 100), LIMITS.gateway, false), 'down');
});

test('locate blames the first unhealthy segment', () => {
  const sites = [site(40, 10)];
  assert.strictEqual(locate({ stats: sites, path: { gateway: hop(80), isp: hop(10) } }, wifi).where, 'home');
  assert.strictEqual(locate({ stats: sites, path: { gateway: hop(2), isp: hop(10, 10) } }, wifi).where, 'isp');
  assert.strictEqual(locate({ stats: sites, path: { gateway: hop(2), isp: hop(10) } }, wifi).where, 'internet');
  // ISP router not visible: can't tell ISP from beyond.
  assert.strictEqual(locate({ stats: sites, path: { gateway: hop(2), isp: null } }, wifi).where, 'upstream');
});

test('locate: router unreachable during an outage means the home network', () => {
  const r = locate({ stats: [site(null, 100)], path: { gateway: hop(null, 100), isp: hop(null, 100) } }, wifi);
  assert.strictEqual(r.where, 'home');
  assert.strictEqual(r.gateway, 'down');
});

test('locate: router fine but ISP router unreachable during an outage means the ISP', () => {
  const r = locate({ stats: [site(null, 100)], path: { gateway: hop(2), isp: hop(null, 100) } }, wifi);
  assert.strictEqual(r.where, 'isp');
});

test('locate: a silent router does not get the blame', () => {
  const r = locate({ stats: [site(40, 10)], path: { gateway: hop(null, 100), isp: hop(10) } }, wifi);
  assert.strictEqual(r.gateway, 'silent');
  assert.strictEqual(r.where, 'internet');
});

test('locate: on a VPN the path is the VPN', () => {
  assert.strictEqual(locate({ stats: [site(10)], path: {} }, { type: 'vpn' }).where, 'vpn');
});

test('locate works without any path data', () => {
  assert.strictEqual(locate({ stats: [site(10)] }, null).where, 'upstream');
});

test('diagnose only names a location when something is wrong', () => {
  const ok = diagnose({ score: 0.95, loss: 0 }, { stats: [site(10)], path: { gateway: hop(2), isp: hop(9) } }, settings, wifi);
  assert.deepStrictEqual(ok, { level: 'ok', where: null, gateway: 'ok', isp: 'ok' });
  const bad = diagnose({ score: 0.3, loss: 20 }, { stats: [site(50, 20)], path: { gateway: hop(90, 20), isp: hop(9) } }, settings, wifi);
  assert.deepStrictEqual(bad, { level: 'degraded', where: 'home', gateway: 'bad', isp: 'ok' });
});

test('every location has a label', () => {
  for (const key of ['home', 'isp', 'upstream', 'internet', 'vpn']) assert.ok(LOCATIONS[key], key);
});
