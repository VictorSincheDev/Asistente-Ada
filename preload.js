const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// frases de saludo, editables en frases.json
let frases = {};
try { frases = JSON.parse(fs.readFileSync(path.join(__dirname, 'frases.json'), 'utf8')); } catch {}

contextBridge.exposeInMainWorld('hadita', {
  frases,
  // el .vrm se lee aquí con fs (no con fetch a file://) y viaja como ArrayBuffer
  loadModel: async () => {
    const b = await fs.promises.readFile(path.join(__dirname, 'assets', 'hadita.vrm'));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
  decir: (texto, efimero) => ipcRenderer.invoke('hadita-decir', texto, efimero),
  preguntar: (mensaje) => ipcRenderer.invoke('hadita-preguntar', mensaje),
  confirmar: (id, si) => ipcRenderer.invoke('hadita-confirmar', id, si),
  onTarea: (cb) => ipcRenderer.on('hadita-tarea', (_e, texto) => cb(texto)),
  transcribir: (audio) => ipcRenderer.invoke('hadita-transcribir', audio),
  onEscuchar: (cb) => ipcRenderer.on('hadita-escuchar', () => cb()),
  onCursor: (cb) => ipcRenderer.on('hadita-cursor', (_e, x, y) => cb(x, y)),
  onEvent: (cb) => ipcRenderer.on('hadita-event', (_e, evt) => cb(evt)),
  focus: (cwd) => ipcRenderer.send('hadita-focus', cwd),
  moveBy: (dx, dy) => ipcRenderer.send('hadita-move', dx, dy),
  quit: () => ipcRenderer.send('hadita-quit'),
});
