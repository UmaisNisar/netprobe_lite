'use strict';

// Browser version of the preload bridge: when the dashboard is opened from
// Netprobe's built-in web server, window.netprobe talks to /api over fetch
// and gets live state over server-sent events.

(function () {
  async function call(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  const get = (url) => call('GET', url);

  function download(url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  window.netprobe = {
    web: true,
    getState: () => get('/api/state'),
    getHistory: (rangeMs, conn) => get(`/api/history?range=${encodeURIComponent(rangeMs)}&conn=${encodeURIComponent(conn ?? '')}`),
    getIncidents: (rangeMs) => get(`/api/incidents?range=${encodeURIComponent(rangeMs)}`),
    saveSettings: (s) => call('PUT', '/api/settings', s),
    probeNow: () => call('POST', '/api/probe-now'),
    speedtestNow: () => call('POST', '/api/speedtest-now'),
    togglePause: () => call('POST', '/api/toggle-pause'),
    clearHistory: () => call('POST', '/api/clear-history'),
    // PDF: the report opens in a new tab and brings up the browser's print
    // dialog ("Save as PDF"). CSV: three downloads.
    exportReport: async ({ from, to, format }) => {
      const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      if (format === 'csv') {
        const files = ['probes', 'incidents', 'speedtests'].map((k) => `/api/export/${k}.csv?${qs}`);
        files.forEach((u, i) => setTimeout(() => download(u), i * 400));
        return files;
      }
      window.open(`/report?${qs}`, '_blank', 'noopener');
      return [`/report?${qs}`];
    },
    onState: (fn) => {
      let source;
      let retry;
      const connect = () => {
        source = new EventSource('/api/events');
        source.onmessage = (e) => fn(JSON.parse(e.data));
        source.onerror = () => {
          source.close();
          retry = setTimeout(connect, 3000);
        };
      };
      connect();
      return () => {
        clearTimeout(retry);
        source?.close();
      };
    },
  };
})();
