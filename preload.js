const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

contextBridge.exposeInMainWorld('hadita', {
  // el .vrm se lee aquí con fs (no con fetch a file://) y viaja como ArrayBuffer
  loadModel: async () => {
    const b = await fs.promises.readFile(path.join(__dirname, 'assets', 'hadita.vrm'));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  onCursor: (cb) => ipcRenderer.on('hadita-cursor', (_e, x, y) => cb(x, y)),
  onEvent: (cb) => ipcRenderer.on('hadita-event', (_e, evt) => cb(evt)),
  focus: (cwd) => ipcRenderer.send('hadita-focus', cwd),
  moveBy: (dx, dy) => ipcRenderer.send('hadita-move', dx, dy),
  quit: () => ipcRenderer.send('hadita-quit'),
});
