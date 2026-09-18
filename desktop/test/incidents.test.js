const test = require('node:test');
const assert = require('node:assert');
const { IncidentTracker, OUTAGE_AFTER, DEGRADED_AFTER, END_AFTER } = require('../src/main/incidents');

let ts = 0;
const at = () => (ts += 30_000);
const ok = () => ({ ts: at(), level: 'ok', score: 0.95, loss: 0, latency: 10, conn: 'wired' });
const degraded = (where = 'isp', extra = {}) => ({ ts: at(), level: 'degraded', where, score: 0.4, loss: 8, latency: 80, conn: 'wired', ...extra });
const outage = (where = 'isp') => ({ ts: at(), level: 'outage', where, score: 0, loss: 100, latency: null, conn: 'wired' });

function feed(tracker, probes) {
  return probes.flatMap((p) => tracker.observe(p));
}

test.beforeEach(() => {
  ts = 0;
});

test('thresholds are sensible', () => {
  assert.ok(OUTAGE_AFTER >= 2 && DEGRADED_AFTER >= OUTAGE_AFTER && END_AFTER >= 2);
});

test('a single bad probe is noise', () => {
  const t = new IncidentTracker();
  assert.deepStrictEqual(feed(t, [ok(), degraded(), ok(), outage(), ok()]), []);
});

test('an outage opens after two outage probes and starts at the first', () => {
  const t = new IncidentTracker();
  feed(t, [ok()]);
  const first = outage();
  const events = feed(t, [first, outage()]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'start');
  assert.strictEqual(events[0].incident.kind, 'outage');
  assert.strictEqual(events[0].incident.start, first.ts);
  assert.strictEqual(events[0].incident.probes, 2);
  assert.strictEqual(events[0].incident.end, null);
});

test('a slowdown needs three bad probes in a row', () => {
  const t = new IncidentTracker();
  assert.deepStrictEqual(feed(t, [degraded(), degraded()]), []);
  const [ev] = feed(t, [degraded()]);
  assert.strictEqual(ev.type, 'start');
  assert.strictEqual(ev.incident.kind, 'degraded');
});

test('updates while open, escalates to outage, and closes after two good probes', () => {
  const t = new IncidentTracker();
  feed(t, [degraded(), degraded(), degraded()]);
  const upd = feed(t, [outage('home')]);
  assert.strictEqual(upd[0].type, 'update');
  assert.strictEqual(upd[0].incident.kind, 'outage');
  const firstGood = ok();
  assert.deepStrictEqual(feed(t, [firstGood]), []);
  const [end] = feed(t, [ok()]);
  assert.strictEqual(end.type, 'end');
  assert.strictEqual(end.incident.end, firstGood.ts);
  assert.strictEqual(end.incident.probes, 4);
  assert.strictEqual(end.incident.maxLoss, 100);
  assert.strictEqual(end.incident.worstScore, 0);
  assert.strictEqual(end.incident.maxLatency, 80);
});

test('a bad probe between good ones keeps the incident open', () => {
  const t = new IncidentTracker();
  feed(t, [outage(), outage(), ok()]);
  assert.strictEqual(feed(t, [outage()])[0].type, 'update');
  feed(t, [ok()]);
  assert.strictEqual(feed(t, [ok()])[0].type, 'end');
});

test('blames the most common location', () => {
  const t = new IncidentTracker();
  const [start] = feed(t, [degraded('home'), degraded('isp'), degraded('isp')]);
  assert.strictEqual(start.incident.where, 'isp');
});

test('interrupt closes an open incident at its last bad probe', () => {
  const t = new IncidentTracker();
  feed(t, [outage(), outage()]);
  const last = outage();
  feed(t, [last]);
  const [end] = t.interrupt();
  assert.strictEqual(end.type, 'end');
  assert.strictEqual(end.incident.end, last.ts);
  assert.strictEqual(t.open, null);
});

test('interrupt forgets pending bad probes so waking up is not an outage', () => {
  const t = new IncidentTracker();
  feed(t, [outage()]);
  assert.deepStrictEqual(t.interrupt(), []);
  assert.deepStrictEqual(feed(t, [outage()]), []); // streak restarted
});

test('public incidents do not leak internal fields', () => {
  const t = new IncidentTracker();
  const [start] = feed(t, [outage(), outage()]);
  assert.ok(!('whereCounts' in start.incident));
  assert.ok(!('lastBadTs' in start.incident));
  assert.strictEqual(start.incident.conn, 'wired');
});
