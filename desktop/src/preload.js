const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('netprobe', {
  getState: () => ipcRenderer.invoke('get-state'),
  getHistory: (rangeMs, conn) => ipcRenderer.invoke('get-history', rangeMs, conn),
  getIncidents: (rangeMs) => ipcRenderer.invoke('get-incidents', rangeMs),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  probeNow: () => ipcRenderer.invoke('probe-now'),
  speedtestNow: () => ipcRenderer.invoke('speedtest-now'),
  togglePause: () => ipcRenderer.invoke('toggle-pause'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  exportReport: (opts) => ipcRenderer.invoke('export-report', opts),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openUpdate: () => ipcRenderer.invoke('open-update'),
  onState: (fn) => {
    const listener = (_e, s) => fn(s);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
});
