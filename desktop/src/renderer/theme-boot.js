'use strict';

// Applies the last chosen theme before the page paints, so there's no flash
// of the wrong colours. app.js keeps it in sync with the saved setting.
try {
  const theme = localStorage.getItem('netprobe-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // Storage unavailable: follow the system.
}
