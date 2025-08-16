const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  testInterface: () => ipcRenderer.invoke('test-interface'),
  setupCounters: () => ipcRenderer.invoke('setup-counters'),
  startCapture: () => ipcRenderer.invoke('start-capture'),
  stopCapture: () => ipcRenderer.invoke('stop-capture'),
  getFrameStats: () => ipcRenderer.invoke('get-frame-stats')
});
