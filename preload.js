const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hadita', {
  // los archivos los lee main (preload sin acceso a disco): personaje, frases y animaciones
  loadModel: () => ipcRenderer.invoke('hadita-modelo'),
  leerFrases: () => ipcRenderer.invoke('hadita-frases'),
  decir: (texto, efimero) => ipcRenderer.invoke('hadita-decir', texto, efimero),
  preguntar: (mensaje) => ipcRenderer.invoke('hadita-preguntar', mensaje),
  confirmar: (id, si) => ipcRenderer.invoke('hadita-confirmar', id, si),
  onTarea: (cb) => ipcRenderer.on('hadita-tarea', (_e, texto) => cb(texto)),
  transcribir: (audio) => ipcRenderer.invoke('hadita-transcribir', audio),
  onEscuchar: (cb) => ipcRenderer.on('hadita-escuchar', () => cb()),
  onCursor: (cb) => ipcRenderer.on('hadita-cursor', (_e, x, y) => cb(x, y)),
  onEvent: (cb) => ipcRenderer.on('hadita-event', (_e, evt) => cb(evt)),
  focus: (cwd) => ipcRenderer.send('hadita-focus', cwd),
  drag: (fase) => ipcRenderer.send('hadita-drag', fase), // 'inicio' | 'mover' | 'fin'
  leerConfig: () => ipcRenderer.invoke('hadita-config-leer'),
  onConfig: (cb) => ipcRenderer.on('hadita-config', (_e, c) => cb(c)),
  silenciar: (si) => ipcRenderer.send('hadita-silencio', si),
  volumen: (v) => ipcRenderer.send('hadita-volumen', v),
  menu: () => ipcRenderer.send('hadita-menu'),
  onSalir: (cb) => ipcRenderer.on('hadita-salir', () => cb()),
  pasear: () => ipcRenderer.send('hadita-pasear'),
  pararPaseo: () => ipcRenderer.send('hadita-parar-paseo'),
  onPaseo: (cb) => ipcRenderer.on('hadita-paseo', (_e, dir) => cb(dir)), // 1 derecha, -1 izquierda, 0 parada
  // clip de animación: <nombre>.vrma o .fbx, primero en mi carpeta de datos y luego en assets/anim/
  leerAnimacion: (nombre) => ipcRenderer.invoke('hadita-animacion', nombre),
  quit: () => ipcRenderer.send('hadita-quit'),
});
