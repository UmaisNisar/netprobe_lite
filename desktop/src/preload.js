const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('netprobe', {
  getState: () => ipcRenderer.invoke('get-state'),
  getHistory: (rangeMs) => ipcRenderer.invoke('get-history', rangeMs),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  probeNow: () => ipcRenderer.invoke('probe-now'),
  speedtestNow: () => ipcRenderer.invoke('speedtest-now'),
  togglePause: () => ipcRenderer.invoke('toggle-pause'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  onState: (fn) => {
    const listener = (_e, s) => fn(s);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
});
