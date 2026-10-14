const { app, BrowserWindow, screen, ipcMain, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { start } = require('./server');
const voz = require('./voz');
const charla = require('./charla');
const oido = require('./oido');
const sesiones = require('./sesiones');
const tareas = require('./tareas');

// permite sonido y voz sin que hagas clic antes
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win;
const W = 300, H = 500;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - 16,
    y: workArea.y + workArea.height - H - 16,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // sandbox: false para que preload.js pueda leer el .vrm con fs
    // backgroundThrottling: false para que la detección de silencio no se frene sin foco
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: false, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true); // no sale al compartir pantalla ni en capturas
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  // Permisos: solo el micrófono ("media" de audio); todo lo demás se niega
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const soloAudio = (details.mediaTypes || []).every((t) => t === 'audio');
    callback(permission === 'media' && soloAudio);
  });
  createWindow();
  oido.cargar().catch(() => {}); // Whisper se carga una vez, en segundo plano
  const server = start((evt) => {
    voz.calentar(); // hay actividad: que la conexión de voz esté lista para el próximo aviso
    sesiones.registrar(evt);
    if (win && !win.isDestroyed()) win.webContents.send('hadita-event', evt);
  });
  // deja listas las frases fijas y la conexión abierta, para que la voz no espere
  voz.calentar();
  let saludos = [];
  try { saludos = Object.values(JSON.parse(fs.readFileSync(path.join(__dirname, 'frases.json'), 'utf8'))).flat(); } catch {}
  for (const frase of ['Terminé', 'Te necesito aquí', 'No te escuché bien', ...saludos]) {
    if (typeof frase === 'string') voz.decir(frase).catch(() => {});
  }
  // Ctrl+Alt+H oculta y muestra la ventana
  const ok = globalShortcut.register('Control+Alt+H', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) win.hide(); else win.showInactive();
  });
  if (!ok) console.error('No pude registrar Ctrl+Alt+H (¿lo usa otra app?)');
  // Ctrl+Alt+Espacio: empieza a escuchar; si ya escucha, corta y envía.
  // (globalShortcut no avisa al soltar la tecla, por eso alterna en vez de mantener presionado)
  const okVoz = globalShortcut.register('Control+Alt+Space', () => {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
    win.webContents.send('hadita-escuchar');
  });
  if (!okVoz) console.error('No pude registrar Ctrl+Alt+Espacio (¿lo usa otra app?)');
  // posición del cursor (relativa a la ventana) para que la hadita lo siga con la mirada
  let lastCursor = '';
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    const key = `${p.x - x},${p.y - y}`;
    if (key === lastCursor) return;
    lastCursor = key;
    win.webContents.send('hadita-cursor', p.x - x, p.y - y);
  }, 66);
  server.on('error', (e) => {
    console.error('No pude abrir el puerto (¿ya hay otra hadita corriendo?):', e.message);
    app.quit();
  });
});

// Trae al frente la ventana de VS Code que tiene abierta esa carpeta
// (`code <carpeta>` reutiliza la ventana si ya existe; si no, la abre).
function focusVSCode(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return;
  const dir = path.resolve(cwd);
  // el cwd llega por HTTP: solo carpetas reales y sin comillas, porque va a una línea de cmd
  if (dir.includes('"')) return;
  try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
  // code es un .cmd en Windows, por eso necesita shell
  const child = spawn(`code "${dir}"`, { shell: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', (e) => console.error('No pude abrir VS Code:', e.message));
}

// Voz: devuelve los bytes del mp3, o null si falla o tarda más de 3 s (el renderer usa entonces
// speechSynthesis). La generación sigue en segundo plano y queda en caché para la próxima vez.
// `efimero`: no se guarda en la caché (respuestas de la charla).
ipcMain.handle('hadita-decir', (_e, texto, efimero) => {
  if (typeof texto !== 'string' || !texto.trim() || texto.length > 600) return null;
  const audio = voz.decir(texto.trim(), { guardar: !efimero }).catch((e) => {
    console.error('Voz neuronal no disponible:', e.message);
    return null;
  });
  return Promise.race([audio, new Promise((r) => setTimeout(() => r(null), 3000))]);
});
// Oído: recibe Float32 mono a 16 kHz y devuelve el texto ('' si no hubo habla)
ipcMain.handle('hadita-transcribir', async (_e, audio) => {
  voz.calentar(); // habrá respuesta hablada en unos segundos
  if (!(audio instanceof Float32Array) || audio.length < 1600 || audio.length > 16000 * 25) return '';
  try { return await oido.transcribir(audio); } catch (e) {
    console.error('No pude transcribir:', e.message);
    return '';
  }
});
// Charla: claude corre en una carpeta vacía propia, fuera del proyecto
const carpetaCharla = () => path.join(app.getPath('userData'), 'charla');
// Devuelve { ok, texto } y, si es un encargo válido, { confirmar: id } para pedir el sí o no.
ipcMain.handle('hadita-preguntar', async (_e, mensaje) => {
  if (typeof mensaje !== 'string' || !mensaje.trim()) return { ok: false, texto: '' };
  voz.calentar(); // la conexión de voz se cierra sola tras ~30 s sin uso: se reabre mientras claude piensa
  const texto = mensaje.trim().slice(0, 500);
  const conocidos = tareas.contexto();
  const r = await charla.preguntar(texto, carpetaCharla(), conocidos.texto);
  if (r.tipo !== 'tarea') return { ok: r.tipo === 'conversar', texto: r.texto };
  const preparada = tareas.preparar(r, conocidos.codigos);
  charla.recordar(texto, preparada.texto);
  return { ok: true, texto: preparada.texto, confirmar: preparada.confirmar };
});
// Respuesta a «¿Confirmas?». Solo se ejecuta lo que main dejó preparado; al terminar avisa con un resumen.
ipcMain.handle('hadita-confirmar', (_e, id, si) => {
  voz.calentar();
  const texto = tareas.confirmar(String(id), si === true, async (error, resultado) => {
    let final = error;
    if (!final) {
      const resumen = await charla.resumir(resultado.texto, carpetaCharla());
      final = resumen ? `En ${resultado.proyecto}: ${resumen}` : `Terminó la tarea en ${resultado.proyecto}.`;
    }
    voz.calentar();
    if (win && !win.isDestroyed()) win.webContents.send('hadita-tarea', final);
  });
  return { texto };
});
ipcMain.on('hadita-focus', (_e, cwd) => focusVSCode(cwd));
// arrastre manual: el sprite ya no usa -webkit-app-region porque se come los clics
ipcMain.on('hadita-move', (_e, dx, dy) => {
  if (!win || win.isDestroyed() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = win.getPosition();
  win.setBounds({ x: Math.round(x + dx), y: Math.round(y + dy), width: W, height: H });
});
ipcMain.on('hadita-quit', () => app.quit());
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
