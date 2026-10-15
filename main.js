const { app, BrowserWindow, screen, ipcMain, globalShortcut, session, Tray, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Lo que se escribe va a %APPDATA%/hadita: dentro del .exe la carpeta del programa es de solo lectura.
// Tiene que quedar fijado antes de cargar los módulos que guardan cosas.
process.env.HADITA_DIR = app.getPath('userData');
const rutas = require('./rutas');
rutas.migrar();

// Una sola hadita a la vez (con arranque automático es fácil abrir dos)
if (!app.requestSingleInstanceLock()) app.exit(0);

const { start } = require('./server');
const voz = require('./voz');
const charla = require('./charla');
const oido = require('./oido');
const sesiones = require('./sesiones');
const tareas = require('./tareas');
const config = require('./config');
const { crearIcono } = require('./icono');

// permite sonido y voz sin que hagas clic antes
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win, tray;
const W = 300, H = 500; // tamaño mediano; chico y grande lo escalan (config.TAMANOS)

const escala = () => config.TAMANOS[config.leer().tamano];
const tamano = () => ({ width: Math.round(W * escala()), height: Math.round(H * escala()) });

// Posición guardada si sigue cayendo en alguna pantalla; si no, abajo a la derecha
function posicionInicial({ width, height }) {
  const p = config.leer().posicion;
  if (p) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) =>
      p.x + width > a.x + 40 && p.x < a.x + a.width - 40 && p.y >= a.y - 10 && p.y < a.y + a.height - 80);
    if (visible) return p;
  }
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - width - 16, y: workArea.y + workArea.height - height - 16 };
}

function createWindow() {
  const size = tamano();
  win = new BrowserWindow({
    ...size,
    ...posicionInicial(size),
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // el preload no toca el disco (lo hace main), así que va con sandbox
    // backgroundThrottling: false para que la detección de silencio no se frene sin foco
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setContentProtection(true); // no sale al compartir pantalla ni en capturas
  // el tamaño se hace con zoom: todo el contenido (CSS y canvas) escala junto
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(escala()));
  win.on('show', actualizarMenu);
  win.on('hide', actualizarMenu);
  win.loadFile('index.html');
}

function alternarVentana() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) { terminarPaseo(); win.hide(); } else win.showInactive();
}

// ---------- Configuración: se aplica en vivo ----------
function aplicarConfig(c, anterior) {
  if (voz.configurar(c)) pregenerar(); // otra voz, tono o velocidad: frases fijas de nuevo a la caché
  // arranque con Windows: solo en la versión instalada (desde el código abriría el Electron de desarrollo)
  if (app.isPackaged && (!anterior || c.arrancarConWindows !== anterior.arrancarConWindows)) {
    app.setLoginItemSettings({ openAtLogin: c.arrancarConWindows });
  }
  // otro personaje: se recarga la ventana con el modelo nuevo
  if (anterior && c.modelo !== anterior.modelo && win && !win.isDestroyed()) win.reload();
  if (win && !win.isDestroyed()) {
    if (anterior && c.tamano !== anterior.tamano) {
      // se agranda o achica manteniendo fija la esquina inferior derecha
      const b = win.getBounds();
      const size = tamano();
      win.setBounds({ x: b.x + b.width - size.width, y: b.y + b.height - size.height, ...size });
      win.webContents.setZoomFactor(escala());
      config.cambiar({ posicion: { x: b.x + b.width - size.width, y: b.y + b.height - size.height } });
    } else if (anterior && JSON.stringify(c.posicion) !== JSON.stringify(anterior.posicion) && c.posicion) {
      const actual = win.getBounds();
      if (actual.x !== c.posicion.x || actual.y !== c.posicion.y) win.setBounds({ ...c.posicion, ...tamano() });
    }
    win.webContents.send('hadita-config', c);
  }
  actualizarMenu();
}

// ---------- Paseo: la ventana camina por el borde inferior de las pantallas ----------
// El renderer pone la animación de caminar y la gira; aquí solo se mueve la ventana.
let paseo = null; // { x: destino, dir: 1 | -1, timer, antes }

function pasear() {
  if (paseo || !win || win.isDestroyed() || !win.isVisible()) return;
  const b = win.getBounds();
  // destino al azar en cualquier pantalla, a lo largo de su borde inferior, a 150 px o más
  const pantallas = screen.getAllDisplays();
  let x = b.x;
  for (let intento = 0; intento < 10 && Math.abs(x - b.x) < 150; intento++) {
    const { workArea: a } = pantallas[Math.floor(Math.random() * pantallas.length)];
    x = Math.round(a.x + Math.random() * Math.max(0, a.width - b.width));
  }
  if (Math.abs(x - b.x) < 150) return;
  paseo = { x, dir: Math.sign(x - b.x), antes: Date.now() };
  paseo.timer = setInterval(paso, 33);
  win.webContents.send('hadita-paseo', paseo.dir);
  actualizarMenu();
}

function paso() {
  if (!win || win.isDestroyed()) return terminarPaseo();
  const ahora = Date.now();
  const dt = Math.min(0.1, (ahora - paseo.antes) / 1000);
  paseo.antes = ahora;
  const b = win.getBounds();
  const avance = Math.min(config.leer().pasear.velocidad * escala() * dt, Math.abs(paseo.x - b.x));
  const x = b.x + paseo.dir * avance;
  // los pies sobre la barra de tareas de la pantalla en la que está; al cambiar de pantalla baja o sube suave
  const { workArea: a } = screen.getDisplayNearestPoint({ x: Math.round(x + b.width / 2), y: b.y + b.height / 2 });
  const yMeta = a.y + a.height - b.height;
  const y = b.y + (yMeta - b.y) * Math.min(1, dt * 4);
  win.setBounds({ x: Math.round(x), y: Math.round(Math.abs(yMeta - y) < 1 ? yMeta : y), width: b.width, height: b.height });
  if (Math.round(x) === paseo.x && Math.abs(yMeta - y) < 1) terminarPaseo();
}

function terminarPaseo() {
  if (!paseo) return;
  clearInterval(paseo.timer);
  paseo = null;
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  config.cambiar({ posicion: { x, y } });
  win.webContents.send('hadita-paseo', 0);
  actualizarMenu();
}

// ---------- Archivos: personaje, frases y animaciones ----------
const PERSONAJES = path.join(rutas.DATOS, 'personajes'); // .vrm que agrego desde el menú
const MODELO_INCLUIDO = path.join(rutas.APP, 'assets', 'hadita.vrm');

function personajes() {
  try { return fs.readdirSync(PERSONAJES).filter((n) => /\.vrm$/i.test(n)).sort(); } catch { return []; }
}

function leerFrases() {
  return JSON.parse(fs.readFileSync(rutas.editable('frases.json'), 'utf8'));
}

// Elige un .vrm, lo copia a personajes/ y lo deja puesto
async function agregarPersonaje() {
  const r = await dialog.showOpenDialog({ title: 'Elegir personaje (.vrm)', properties: ['openFile'],
    filters: [{ name: 'Modelo VRM', extensions: ['vrm'] }] });
  if (r.canceled || !r.filePaths[0]) return;
  const nombre = path.basename(r.filePaths[0]).replace(/[^\w\- .()]/g, '_'); // el mismo filtro que config.js
  try {
    fs.mkdirSync(PERSONAJES, { recursive: true });
    fs.copyFileSync(r.filePaths[0], path.join(PERSONAJES, nombre));
    config.cambiar({ modelo: nombre });
  } catch (e) {
    dialog.showErrorBox('Hadita', `No pude copiar el personaje: ${e.message}`);
  }
}

// Frases fijas y de frases.json, generadas por adelantado en la caché de voz
function pregenerar() {
  voz.calentar();
  let saludos = [];
  try { saludos = Object.values(leerFrases()).flat(); } catch {}
  for (const frase of ['Terminé', 'Te necesito aquí', 'No te escuché bien', ...saludos]) {
    if (typeof frase === 'string') voz.decir(frase).catch(() => {});
  }
}

// ---------- Menú (bandeja y engranaje) ----------
const PAISES = {
  'Dominican Republic': 'República Dominicana', 'Equatorial Guinea': 'Guinea Ecuatorial', Mexico: 'México',
  Panama: 'Panamá', Peru: 'Perú', Spain: 'España', 'United States': 'Estados Unidos',
};
let voces = []; // [{ id, nombre, pais }], llegan del servicio de voz

function plantillaMenu() {
  const c = config.leer();
  const visible = win && !win.isDestroyed() && win.isVisible();
  const porPais = new Map();
  for (const v of voces) {
    const pais = PAISES[v.pais] || v.pais;
    if (!porPais.has(pais)) porPais.set(pais, []);
    porPais.get(pais).push(v);
  }
  const menuVoz = voces.length
    ? [...porPais].map(([pais, lista]) => ({
      label: pais,
      submenu: lista.map((v) => ({ label: v.nombre, type: 'radio', checked: v.id === c.voz, click: () => config.cambiar({ voz: v.id }) })),
    }))
    : [{ label: c.voz, type: 'radio', checked: true }, { label: 'Lista no disponible (sin internet)', enabled: false }];
  return [
    { label: visible ? 'Ocultar' : 'Mostrar', click: alternarVentana },
    { label: 'Silenciar', type: 'checkbox', checked: c.silencio, click: () => config.cambiar({ silencio: !config.leer().silencio }) },
    { label: 'Tamaño', submenu: ['chico', 'mediano', 'grande'].map((t) => ({
      label: t[0].toUpperCase() + t.slice(1), type: 'radio', checked: c.tamano === t, click: () => config.cambiar({ tamano: t }),
    })) },
    { label: 'Voz', submenu: menuVoz },
    { label: 'Personaje', submenu: [
      { label: 'Hadita (incluida)', type: 'radio', checked: !c.modelo, click: () => config.cambiar({ modelo: '' }) },
      ...personajes().map((n) => ({ label: n.replace(/\.vrm$/i, ''), type: 'radio', checked: c.modelo === n, click: () => config.cambiar({ modelo: n }) })),
      { type: 'separator' },
      { label: 'Agregar personaje…', click: agregarPersonaje },
    ] },
    { label: app.isPackaged ? 'Arrancar con Windows' : 'Arrancar con Windows (solo en la versión instalada)',
      type: 'checkbox', checked: c.arrancarConWindows, enabled: app.isPackaged,
      click: () => config.cambiar({ arrancarConWindows: !config.leer().arrancarConWindows }) },
    { type: 'separator' },
    { label: paseo ? 'Dejar de pasear' : 'Pasear ahora', click: () => (paseo ? terminarPaseo() : pasear()) },
    { label: 'Pasear sola', type: 'checkbox', checked: c.pasear.activo,
      click: () => config.cambiar({ pasear: { ...config.leer().pasear, activo: !config.leer().pasear.activo } }) },
    { type: 'separator' },
    { label: 'Abrir configuración', click: () => shell.openPath(config.ruta()) },
    { label: 'Abrir carpeta de datos', click: () => shell.openPath(rutas.DATOS) },
    { label: 'Salir', click: salir },
  ];
}

function actualizarMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(plantillaMenu()));
}

// Sale despidiéndose (el renderer dice la frase y luego pide salir); si no responde, sale igual
function salir() {
  if (!win || win.isDestroyed()) return app.quit();
  win.webContents.send('hadita-salir');
  setTimeout(() => app.quit(), 7000);
}

app.whenReady().then(() => {
  // Permisos: solo el micrófono ("media" de audio); todo lo demás se niega
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const soloAudio = (details.mediaTypes || []).every((t) => t === 'audio');
    callback(permission === 'media' && soloAudio);
  });
  aplicarConfig(config.iniciar(app.getPath('userData'), aplicarConfig));
  createWindow();
  tray = new Tray(crearIcono());
  tray.setToolTip('Hadita');
  tray.on('click', alternarVentana);
  actualizarMenu();
  voz.voces().then((lista) => { voces = lista; actualizarMenu(); }).catch(() => {});
  oido.cargar().catch(() => {}); // Whisper se carga una vez, en segundo plano
  const server = start((evt) => {
    voz.calentar(); // hay actividad: que la conexión de voz esté lista para el próximo aviso
    sesiones.registrar(evt);
    if (win && !win.isDestroyed()) win.webContents.send('hadita-event', evt);
  });
  // deja listas las frases fijas y la conexión abierta, para que la voz no espere
  pregenerar();
  // Ctrl+Alt+H oculta y muestra la ventana
  const ok = globalShortcut.register('Control+Alt+H', alternarVentana);
  if (!ok) console.error('No pude registrar Ctrl+Alt+H (¿lo usa otra app?)');
  // Ctrl+Alt+Espacio: empieza a escuchar; si ya escucha, corta y envía.
  // (globalShortcut no avisa al soltar la tecla, por eso alterna en vez de mantener presionado)
  const okVoz = globalShortcut.register('Control+Alt+Space', () => {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.showInactive();
    win.webContents.send('hadita-escuchar');
  });
  if (!okVoz) console.error('No pude registrar Ctrl+Alt+Espacio (¿lo usa otra app?)');
  // posición del cursor (relativa a la ventana, en píxeles CSS) para que la hadita lo siga con la mirada
  let lastCursor = '';
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    const f = escala();
    const key = `${p.x - x},${p.y - y},${f}`;
    if (key === lastCursor) return;
    lastCursor = key;
    win.webContents.send('hadita-cursor', (p.x - x) / f, (p.y - y) / f);
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
ipcMain.handle('hadita-config-leer', () => config.leer());
// personaje elegido; si falta el archivo, la hadita incluida
ipcMain.handle('hadita-modelo', () => {
  const elegido = config.leer().modelo && path.join(PERSONAJES, config.leer().modelo);
  try { return fs.readFileSync(elegido && fs.existsSync(elegido) ? elegido : MODELO_INCLUIDO); } catch (e) {
    console.error('No pude leer el personaje:', e.message);
    return fs.readFileSync(MODELO_INCLUIDO);
  }
});
ipcMain.handle('hadita-frases', () => { try { return leerFrases(); } catch { return {}; } });
// clip: <nombre>.vrma o .fbx; primero en la carpeta de datos (anim/), luego en los que trae el programa
ipcMain.handle('hadita-animacion', (_e, nombre) => {
  if (typeof nombre !== 'string' || !/^[\w\- ]+$/.test(nombre)) return null;
  for (const dir of [path.join(rutas.DATOS, 'anim'), path.join(rutas.APP, 'assets', 'anim')]) {
    for (const ext of ['vrma', 'fbx']) {
      try { return { ext, bytes: fs.readFileSync(path.join(dir, `${nombre}.${ext}`)) }; } catch {}
    }
  }
  return null;
});
// el renderer solo puede cambiar el silencio (botón ♪) y el volumen (barrita); el resto va por el menú o el archivo
ipcMain.on('hadita-silencio', (_e, si) => config.cambiar({ silencio: si === true }));
ipcMain.on('hadita-volumen', (_e, v) => { if (Number.isFinite(v)) config.cambiar({ volumen: v }); });
ipcMain.on('hadita-menu', () => {
  if (win && !win.isDestroyed()) Menu.buildFromTemplate(plantillaMenu()).popup({ window: win });
});
ipcMain.on('hadita-focus', (_e, cwd) => focusVSCode(cwd));
// Arrastre manual (el canvas no usa -webkit-app-region porque se come los clics). La posición se
// calcula con el cursor real, así no importa el zoom; al soltar se guarda en config.json.
let arrastre = null;
ipcMain.on('hadita-drag', (_e, fase) => {
  if (!win || win.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  if (fase === 'inicio') {
    terminarPaseo(); // si la agarro mientras pasea, se queda conmigo
    const [x, y] = win.getPosition();
    arrastre = { dx: p.x - x, dy: p.y - y };
  } else if (fase === 'mover' && arrastre) {
    win.setBounds({ x: p.x - arrastre.dx, y: p.y - arrastre.dy, ...tamano() });
  } else if (fase === 'fin' && arrastre) {
    arrastre = null;
    const [x, y] = win.getPosition();
    config.cambiar({ posicion: { x, y } });
  }
});
ipcMain.on('hadita-pasear', pasear);
ipcMain.on('hadita-parar-paseo', terminarPaseo);
ipcMain.on('hadita-quit', () => app.quit());
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
