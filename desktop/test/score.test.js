const test = require('node:test');
const assert = require('node:assert');
const { summarise } = require('../src/main/score');

const settings = {
  dnsServers: [{ name: 'A', ip: '1.1.1.1' }, { name: 'Home', ip: '192.168.1.1', home: true }],
  weights: { loss: 0.6, latency: 0.15, jitter: 0.2, dnsLatency: 0.05 },
  thresholds: { loss: 5, latency: 100, jitter: 30, dnsLatency: 100 },
};
const dns = [{ name: 'A', latency: 10 }, { name: 'Home', latency: 50 }];

test('matches the original formula', () => {
  const r = summarise({ stats: [{ latency: 50, loss: 1, jitter: 15 }], dns }, settings);
  const expected = 1 - 0.6 * (1 / 5) - 0.15 * 0.5 - 0.2 * 0.5 - 0.05 * 0.5;
  assert.ok(Math.abs(r.score - expected) < 1e-9);
  assert.strictEqual(r.dnsLatency, 50);
});

test('sites that never reply are ignored while others answer', () => {
  const r = summarise({
    stats: [{ latency: 10, loss: 0, jitter: 1 }, { latency: null, loss: 100, jitter: null }],
    dns,
  }, settings);
  assert.strictEqual(r.loss, 0);
  assert.strictEqual(r.latency, 10);
});

test('total outage scores near zero', () => {
  const r = summarise({
    stats: [{ latency: null, loss: 100, jitter: null }],
    dns: [{ name: 'A', latency: 5000 }, { name: 'Home', latency: 5000 }],
  }, settings);
  assert.strictEqual(r.score, 0);
});
