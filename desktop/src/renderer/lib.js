// Pure helpers shared by the dashboard (loaded as a plain script, exposed as
// window.NetprobeLib) and the unit tests (loaded with require).
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.NetprobeLib = lib;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const fmt = (v, digits = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(digits));
  const mbps = (bps) => (bps == null ? null : bps / 1e6);
  const fmtMbps = (bps) => {
    const v = mbps(bps);
    return v == null ? '–' : v >= 100 ? v.toFixed(0) : v.toFixed(1);
  };
  const timeAgo = (ts) => {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(ts).toLocaleString();
  };

  // Colour a value relative to its score threshold.
  function level(value, threshold) {
    if (value == null) return '';
    if (value < threshold * 0.5) return 'v-good';
    if (value < threshold) return 'v-ok';
    return 'v-bad';
  }

  function scoreCaption(score) {
    if (score >= 0.9) return 'Excellent — your connection is healthy';
    if (score >= 0.8) return 'Good';
    if (score >= 0.6) return 'Fair — some latency, jitter or loss';
    if (score >= 0.4) return 'Poor — noticeable problems';
    return 'Bad — significant loss or delay';
  }

  // Pivot rows of {ts, key, value} into uPlot's aligned [xs, ...ys] format,
  // inserting nulls where the PC was off so lines break instead of bridging.
  function pivot(rows, keyField, valueFn, gapMs) {
    const xsSet = new Set();
    const keys = [];
    const byKey = new Map();
    for (const r of rows) {
      xsSet.add(r.ts);
      const k = keyField ? r[keyField] : '_';
      if (!byKey.has(k)) {
        byKey.set(k, new Map());
        keys.push(k);
      }
      byKey.get(k).set(r.ts, valueFn(r));
    }
    let xs = [...xsSet].sort((a, b) => a - b);
    const withGaps = [];
    for (let i = 0; i < xs.length; i++) {
      if (i && xs[i] - xs[i - 1] > gapMs) withGaps.push(xs[i - 1] + 1);
      withGaps.push(xs[i]);
    }
    xs = withGaps;
    const ys = keys.map((k) => xs.map((x) => byKey.get(k).get(x) ?? null));
    return { xs: xs.map((x) => x / 1000), keys, ys };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // Where a problem is, as shown to people (keys come from diagnose.js).
  const LOCATIONS = {
    home: 'Your home network (Wi-Fi or router)',
    isp: 'Your ISP',
    upstream: 'Your ISP or beyond',
    internet: "Beyond your ISP's first router",
    vpn: 'The VPN path',
  };

  function formatDuration(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? `${m} min ${s % 60}s` : `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
    return `${Math.floor(h / 24)} d ${h % 24} h`;
  }

  // Status of one segment of the path (router, ISP) for the path view.
  function segmentText(segment) {
    return {
      ok: 'Healthy',
      bad: 'Problems',
      down: 'Not reachable',
      silent: "Doesn't answer ping",
      unknown: 'Not visible',
    }[segment] ?? 'Not visible';
  }

  function uptimeText(u) {
    if (!u || u.uptime == null) return '–';
    const pct = u.uptime * 100;
    return pct >= 99.995 ? '100%' : `${pct.toFixed(pct >= 99 ? 2 : 1)}%`;
  }

  return {
    fmt, mbps, fmtMbps, timeAgo, level, scoreCaption, pivot, esc,
    LOCATIONS, formatDuration, segmentText, uptimeText,
  };
});
