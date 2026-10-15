// Registro de sesiones de Claude Code vistas por los hooks, guardado en datos/sesiones.json.
// Node puro, sin Electron.
const fs = require('fs');
const path = require('path');

const DIR = process.env.HADITA_DATOS || path.join(require('./rutas').DATOS, 'datos');
const ARCHIVO = path.join(DIR, 'sesiones.json');
const MAXIMO = 200;        // se conservan las más recientes
const TITULO_MAX = 60;

let sesiones = {}; // session_id -> { id, cwd, proyecto, ultimo, titulo }
try { sesiones = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')); } catch {}

let pendiente = null;
function guardar() {
  if (pendiente) return; // llegan muchos eventos seguidos: se escribe como mucho cada 2 s
  pendiente = setTimeout(() => {
    pendiente = null;
    const recientes = Object.values(sesiones).sort((a, b) => b.ultimo - a.ultimo).slice(0, MAXIMO);
    sesiones = Object.fromEntries(recientes.map((s) => [s.id, s]));
    try {
      fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
      fs.writeFileSync(ARCHIVO, JSON.stringify(sesiones, null, 2));
    } catch (e) {
      console.error('No pude guardar las sesiones:', e.message);
    }
  }, 2000);
}

// Anota un evento de hook: cwd, proyecto, hora y, la primera vez, el título (primer prompt)
function registrar(evt) {
  if (!evt || typeof evt.session_id !== 'string' || typeof evt.cwd !== 'string' || !evt.cwd) return;
  const s = sesiones[evt.session_id] || (sesiones[evt.session_id] = { id: evt.session_id, titulo: '' });
  s.cwd = evt.cwd;
  s.proyecto = path.basename(evt.cwd);
  s.ultimo = Date.now();
  if (!s.titulo && evt.hook_event_name === 'UserPromptSubmit' && typeof evt.prompt === 'string') {
    const limpio = evt.prompt.replace(/\s+/g, ' ').trim();
    s.titulo = limpio.length > TITULO_MAX ? `${limpio.slice(0, TITULO_MAX - 1)}…` : limpio;
  }
  guardar();
}

// Sesiones cuya carpeta es `carpeta` o está dentro de ella, de la más reciente a la más antigua
function deCarpeta(carpeta) {
  const raiz = path.resolve(carpeta).toLowerCase() + path.sep;
  return Object.values(sesiones)
    .filter((s) => (path.resolve(s.cwd).toLowerCase() + path.sep).startsWith(raiz))
    .sort((a, b) => b.ultimo - a.ultimo);
}

module.exports = { registrar, deCarpeta, DIR, ARCHIVO };
