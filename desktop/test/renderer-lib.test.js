const test = require('node:test');
const assert = require('node:assert');
const { fmt, mbps, fmtMbps, timeAgo, level, scoreCaption, pivot, esc } = require('../src/renderer/lib');

test('fmt shows a dash for missing values', () => {
  assert.strictEqual(fmt(1.234), '1.2');
  assert.strictEqual(fmt(1.234, 2), '1.23');
  assert.strictEqual(fmt(null), '–');
  assert.strictEqual(fmt(undefined), '–');
  assert.strictEqual(fmt(NaN), '–');
  assert.strictEqual(fmt(Infinity), '–');
});

test('bandwidth is shown in Mbps with sensible precision', () => {
  assert.strictEqual(mbps(5e6), 5);
  assert.strictEqual(mbps(null), null);
  assert.strictEqual(fmtMbps(12.34e6), '12.3');
  assert.strictEqual(fmtMbps(1880.2e6), '1880');
  assert.strictEqual(fmtMbps(null), '–');
});

test('timeAgo uses seconds, minutes and hours', () => {
  const now = Date.now();
  assert.strictEqual(timeAgo(now - 5000), '5s ago');
  assert.strictEqual(timeAgo(now - 5 * 60_000), '5 min ago');
  assert.strictEqual(timeAgo(now - 3 * 3600_000), '3 h ago');
  assert.strictEqual(timeAgo(now - 3 * 86400_000), new Date(now - 3 * 86400_000).toLocaleString());
});

test('level colours values against their threshold', () => {
  assert.strictEqual(level(10, 100), 'v-good');
  assert.strictEqual(level(50, 100), 'v-ok');
  assert.strictEqual(level(100, 100), 'v-bad');
  assert.strictEqual(level(null, 100), '');
});

test('score captions cover the whole range', () => {
  assert.match(scoreCaption(0.95), /Excellent/);
  assert.match(scoreCaption(0.85), /Good/);
  assert.match(scoreCaption(0.7), /Fair/);
  assert.match(scoreCaption(0.5), /Poor/);
  assert.match(scoreCaption(0.1), /Bad/);
});

test('pivot aligns per-key rows onto shared timestamps in seconds', () => {
  const rows = [
    { ts: 1000, site: 'a', v: 1 },
    { ts: 1000, site: 'b', v: 2 },
    { ts: 2000, site: 'a', v: 3 },
  ];
  const p = pivot(rows, 'site', (r) => r.v, 10_000);
  assert.deepStrictEqual(p.xs, [1, 2]);
  assert.deepStrictEqual(p.keys, ['a', 'b']);
  assert.deepStrictEqual(p.ys, [[1, 3], [2, null]]);
});

test('pivot inserts a null point across gaps so lines break', () => {
  const rows = [{ ts: 0, v: 1 }, { ts: 30_000, v: 2 }, { ts: 3_600_000, v: 3 }];
  const p = pivot(rows, null, (r) => r.v, 100_000);
  assert.deepStrictEqual(p.ys[0], [1, 2, null, 3]);
  assert.strictEqual(p.xs.length, 4);
  assert.ok(p.xs.every((x, i) => i === 0 || x > p.xs[i - 1]), 'x values stay strictly increasing');
});

test('pivot handles no data', () => {
  assert.deepStrictEqual(pivot([], 'site', (r) => r.v, 1000), { xs: [], keys: [], ys: [] });
});

test('esc neutralises HTML in user-provided names', () => {
  assert.strictEqual(esc('<img src=x onerror="a()">'), '&lt;img src=x onerror=&quot;a()&quot;&gt;');
  assert.strictEqual(esc("a & b's"), 'a &amp; b&#39;s');
});

const { LOCATIONS, formatDuration, segmentText, uptimeText } = require('../src/renderer/lib');

test('formatDuration covers seconds to days', () => {
  assert.strictEqual(formatDuration(0), '1s');
  assert.strictEqual(formatDuration(45_000), '45s');
  assert.strictEqual(formatDuration(120_000), '2 min');
  assert.strictEqual(formatDuration(200_000), '3 min 20s');
  assert.strictEqual(formatDuration(3_600_000), '1 h');
  assert.strictEqual(formatDuration(5_400_000), '1 h 30 min');
  assert.strictEqual(formatDuration(3 * 86_400_000 + 3_600_000), '3 d 1 h');
});

test('segment and uptime texts', () => {
  assert.strictEqual(segmentText('ok'), 'Healthy');
  assert.strictEqual(segmentText('silent'), "Doesn't answer ping");
  assert.strictEqual(segmentText('nonsense'), 'Not visible');
  assert.strictEqual(uptimeText(null), '–');
  assert.strictEqual(uptimeText({ uptime: null }), '–');
  assert.strictEqual(uptimeText({ uptime: 1 }), '100%');
  assert.strictEqual(uptimeText({ uptime: 0.99912 }), '99.91%');
  assert.strictEqual(uptimeText({ uptime: 0.9 }), '90.0%');
  assert.ok(LOCATIONS.home && LOCATIONS.isp);
});
