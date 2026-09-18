// Turns a stream of judged probes into incidents: a stretch of bad probes
// long enough to matter. Pure state machine; the monitor persists and
// announces what it returns.
//
// - An outage opens after OUTAGE_AFTER bad probes in a row, a degradation
//   after DEGRADED_AFTER (a single bad probe is noise).
// - A degraded incident that hits an outage probe escalates to 'outage'.
// - It closes after END_AFTER good probes in a row; the end time is the
//   first good probe.
// - interrupt() (sleep, network change) closes an open incident at the last
//   bad probe and forgets streaks, so waking up never looks like an outage.

const OUTAGE_AFTER = 2;
const DEGRADED_AFTER = 3;
const END_AFTER = 2;

class IncidentTracker {
  constructor() {
    this.open = null; // current incident
    this.pending = []; // bad probes not yet enough to open one
    this.goodStreak = null; // { count, firstTs } while an incident is closing
  }

  // probe: { ts, level: 'ok'|'degraded'|'outage', where, score, loss, latency, conn }
  // Returns a list of events: { type: 'start'|'update'|'end', incident }.
  observe(probe) {
    if (probe.level === 'ok') return this.#good(probe);
    return this.#bad(probe);
  }

  interrupt() {
    const events = [];
    if (this.open) {
      this.open.end = this.open.lastBadTs;
      events.push({ type: 'end', incident: this.#public(this.open) });
    }
    this.open = null;
    this.pending = [];
    this.goodStreak = null;
    return events;
  }

  #good(probe) {
    this.pending = [];
    if (!this.open) return [];
    this.goodStreak = this.goodStreak ?? { count: 0, firstTs: probe.ts };
    this.goodStreak.count++;
    if (this.goodStreak.count < END_AFTER) return [];
    this.open.end = this.goodStreak.firstTs;
    const done = this.#public(this.open);
    this.open = null;
    this.goodStreak = null;
    return [{ type: 'end', incident: done }];
  }

  #bad(probe) {
    this.goodStreak = null;
    if (this.open) {
      this.#absorb(this.open, probe);
      return [{ type: 'update', incident: this.#public(this.open) }];
    }
    this.pending.push(probe);
    const outages = this.pending.filter((p) => p.level === 'outage').length;
    const tailOutages = countTail(this.pending, (p) => p.level === 'outage');
    if (tailOutages < OUTAGE_AFTER && this.pending.length < DEGRADED_AFTER) return [];
    const first = this.pending[0];
    this.open = {
      start: first.ts,
      end: null,
      kind: outages ? 'outage' : 'degraded',
      whereCounts: {},
      worstScore: 1,
      maxLoss: 0,
      maxLatency: null,
      probes: 0,
      conn: first.conn ?? null,
      lastBadTs: first.ts,
    };
    for (const p of this.pending) this.#absorb(this.open, p);
    this.pending = [];
    return [{ type: 'start', incident: this.#public(this.open) }];
  }

  #absorb(inc, p) {
    if (p.level === 'outage') inc.kind = 'outage';
    if (p.where) inc.whereCounts[p.where] = (inc.whereCounts[p.where] ?? 0) + 1;
    inc.worstScore = Math.min(inc.worstScore, p.score ?? 0);
    inc.maxLoss = Math.max(inc.maxLoss, p.loss ?? 100);
    if (p.latency != null) inc.maxLatency = Math.max(inc.maxLatency ?? 0, p.latency);
    inc.probes++;
    inc.lastBadTs = p.ts;
  }

  #public(inc) {
    // Blame the location seen most often during the incident.
    const where = Object.entries(inc.whereCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const { whereCounts: _w, lastBadTs: _l, ...rest } = inc;
    return { ...rest, where };
  }
}

function countTail(list, pred) {
  let n = 0;
  for (let i = list.length - 1; i >= 0 && pred(list[i]); i--) n++;
  return n;
}

module.exports = { IncidentTracker, OUTAGE_AFTER, DEGRADED_AFTER, END_AFTER };
