const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hadita', {
  onEvent: (cb) => ipcRenderer.on('hadita-event', (_e, evt) => cb(evt)),
  focus: (cwd) => ipcRenderer.send('hadita-focus', cwd),
  moveBy: (dx, dy) => ipcRenderer.send('hadita-move', dx, dy),
  quit: () => ipcRenderer.send('hadita-quit'),
});
