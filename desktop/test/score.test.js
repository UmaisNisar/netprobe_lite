const test = require('node:test');
const assert = require('node:assert');
const { summarise, average } = require('../src/main/score');

const settings = {
  dnsServers: [{ name: 'A', ip: '1.1.1.1' }, { name: 'Home', ip: '192.168.1.1', home: true }],
  weights: { loss: 0.6, latency: 0.15, jitter: 0.2, dnsLatency: 0.05 },
  thresholds: { loss: 5, latency: 100, jitter: 30, dnsLatency: 100 },
};
const dns = [{ name: 'A', latency: 10 }, { name: 'Home', latency: 50 }];
const close = (a, b) => Math.abs(a - b) < 1e-9;

test('matches the original presentation.py formula', () => {
  const r = summarise({ stats: [{ latency: 50, loss: 1, jitter: 15 }], dns }, settings);
  const expected = 1 - 0.6 * (1 / 5) - 0.15 * 0.5 - 0.2 * 0.5 - 0.05 * 0.5;
  assert.ok(close(r.score, expected));
  assert.strictEqual(r.dnsLatency, 50);
});

test('a perfect connection scores 1', () => {
  const r = summarise({ stats: [{ latency: 0, loss: 0, jitter: 0 }], dns: [{ latency: 0 }, { latency: 0 }] }, settings);
  assert.strictEqual(r.score, 1);
});

test('each metric is capped at its threshold', () => {
  const r = summarise({ stats: [{ latency: 5000, loss: 0, jitter: 0 }], dns: [{ latency: 0 }, { latency: 0 }] }, settings);
  assert.ok(close(r.score, 1 - 0.15));
});

test('averages across sites', () => {
  const r = summarise({
    stats: [{ latency: 10, loss: 0, jitter: 2 }, { latency: 30, loss: 2, jitter: 4 }],
    dns,
  }, settings);
  assert.strictEqual(r.latency, 20);
  assert.strictEqual(r.loss, 1);
  assert.strictEqual(r.jitter, 3);
});

test('sites that never reply are ignored while others answer', () => {
  const r = summarise({
    stats: [{ latency: 10, loss: 0, jitter: 1 }, { latency: null, loss: 100, jitter: null }],
    dns,
  }, settings);
  assert.strictEqual(r.loss, 0);
  assert.strictEqual(r.latency, 10);
});

test('total outage scores zero', () => {
  const r = summarise({
    stats: [{ latency: null, loss: 100, jitter: null }],
    dns: [{ name: 'A', latency: 5000 }, { name: 'Home', latency: 5000 }],
  }, settings);
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.loss, 100);
  assert.strictEqual(r.latency, null);
});

test('the home DNS server is chosen by flag, not by name', () => {
  const s = { ...settings, dnsServers: [{ name: 'Mine', ip: 'x', home: true }, { name: 'Other', ip: 'y' }] };
  const r = summarise({ stats: [{ latency: 1, loss: 0, jitter: 0 }], dns: [{ latency: 7 }, { latency: 99 }] }, s);
  assert.strictEqual(r.dnsLatency, 7);
});

test('falls back to the last DNS server when none is flagged', () => {
  const s = { ...settings, dnsServers: [{ ip: 'x' }, { ip: 'y' }] };
  const r = summarise({ stats: [{ latency: 1, loss: 0, jitter: 0 }], dns: [{ latency: 7 }, { latency: 99 }] }, s);
  assert.strictEqual(r.dnsLatency, 99);
});

test('no DNS results counts DNS as fully bad instead of crashing', () => {
  const r = summarise({ stats: [{ latency: 0, loss: 0, jitter: 0 }], dns: [] }, settings);
  assert.strictEqual(r.dnsLatency, null);
  assert.ok(close(r.score, 1 - 0.05));
});

test('custom weights and thresholds are honoured', () => {
  const s = { ...settings, weights: { loss: 0, latency: 1, jitter: 0, dnsLatency: 0 }, thresholds: { ...settings.thresholds, latency: 40 } };
  const r = summarise({ stats: [{ latency: 10, loss: 50, jitter: 50 }], dns }, s);
  assert.ok(close(r.score, 0.75));
});

test('score is clamped to 0..1 even if weights add up to more than 1', () => {
  const s = { ...settings, weights: { loss: 1, latency: 1, jitter: 1, dnsLatency: 1 } };
  const r = summarise({ stats: [{ latency: 1000, loss: 100, jitter: 100 }], dns }, s);
  assert.strictEqual(r.score, 0);
});

test('average skips nulls and non-numbers', () => {
  assert.strictEqual(average([1, null, 3, undefined, NaN]), 2);
  assert.strictEqual(average([]), null);
  assert.strictEqual(average([null]), null);
});
