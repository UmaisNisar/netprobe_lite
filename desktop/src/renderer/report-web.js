'use strict';

// Browser version of the PDF export: fetch the report data for the period in
// the URL, render it, then open the print dialog ("Save as PDF").

(async function () {
  const q = new URLSearchParams(location.search);
  const res = await fetch(`/api/report?from=${encodeURIComponent(q.get('from'))}&to=${encodeURIComponent(q.get('to'))}`, {
    credentials: 'same-origin',
  });
  const data = await res.json();
  if (!res.ok) {
    document.body.textContent = data.error || `Could not build the report (HTTP ${res.status}).`;
    return;
  }
  await window.renderReport(data);
  setTimeout(() => window.print(), 300);
})();
