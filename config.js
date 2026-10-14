// Configuración de la hadita: config.json en la carpeta de datos de la app (userData).
// Se puede editar a mano; los cambios se aplican sin reiniciar. Node puro, sin Electron.
const fs = require('fs');
const path = require('path');

const DEFECTO = {
  voz: 'es-PE-CamilaNeural',
  tono: '+20Hz',          // un poco más agudo
  velocidad: '+8%',       // levemente más rápido
  volumen: 1,             // 0 a 1
  tamano: 'mediano',      // chico, mediano o grande
  posicion: null,         // { x, y } de la esquina superior izquierda; null = abajo a la derecha
  silencio: false,
  // clip por estado: nombre de archivo en assets/anim/ sin extensión (se busca .vrma y luego .fbx).
  // Vacío o sin archivo: ese estado se mueve por código.
  animaciones: { idle: 'idle', working: 'teclear', waiting: 'saludar', done: 'celebrar', estirarse: 'estirarse', pensar: 'pensar' },
  // funciones futuras: cada una con su bloque
  pomodoro: { activo: false, trabajoMin: 25, descansoMin: 5 },
  git: { activo: false, repos: [] },
  resumen: { activo: false },
  uso: { activo: false },
};
const TAMANOS = { chico: 0.8, mediano: 1, grande: 1.25 };

let archivo = null;
let actual = structuredClone(DEFECTO);
let alCambiar = () => {};
let escrito = ''; // lo último que se guardó, para ignorar el aviso de nuestra propia escritura

const esObjeto = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Lo leído se mezcla con los valores por defecto y se valida campo a campo
function normalizar(leido) {
  const c = structuredClone(DEFECTO);
  if (!esObjeto(leido)) return c;
  for (const [clave, valor] of Object.entries(leido)) {
    if (!(clave in DEFECTO)) c[clave] = valor; // claves extra se conservan
    else if (esObjeto(DEFECTO[clave])) c[clave] = esObjeto(valor) ? { ...DEFECTO[clave], ...valor } : c[clave];
    else c[clave] = valor;
  }
  if (typeof c.voz !== 'string' || !/^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(c.voz)) c.voz = DEFECTO.voz;
  if (typeof c.tono !== 'string' || !/^[+-]\d+(Hz|%)$/.test(c.tono)) c.tono = DEFECTO.tono;
  if (typeof c.velocidad !== 'string' || !/^[+-]\d+%$/.test(c.velocidad)) c.velocidad = DEFECTO.velocidad;
  c.volumen = Number.isFinite(Number(c.volumen)) ? Math.min(1, Math.max(0, Number(c.volumen))) : DEFECTO.volumen;
  if (!(c.tamano in TAMANOS)) c.tamano = DEFECTO.tamano;
  const p = c.posicion;
  c.posicion = esObjeto(p) && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
  c.silencio = c.silencio === true;
  for (const [k, v] of Object.entries(c.animaciones)) {
    if (typeof v !== 'string' || !/^[\w\- ]*$/.test(v)) c.animaciones[k] = ''; // solo nombres, sin rutas
  }
  return c;
}

function guardar() {
  escrito = JSON.stringify(actual, null, 2);
  try {
    fs.mkdirSync(path.dirname(archivo), { recursive: true });
    fs.writeFileSync(archivo, escrito);
  } catch (e) {
    console.error('No pude guardar la configuración:', e.message);
  }
}

// Carga (o crea) config.json y vigila si lo edito a mano. `cb(config, anterior)` en cada cambio.
function iniciar(carpeta, cb) {
  archivo = path.join(carpeta, 'config.json');
  alCambiar = cb;
  let leido = null;
  try { leido = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch {}
  actual = normalizar(leido);
  guardar(); // deja escritos los valores por defecto que falten
  fs.watchFile(archivo, { interval: 1000 }, () => {
    let texto;
    try { texto = fs.readFileSync(archivo, 'utf8'); } catch { return; }
    if (texto === escrito) return;
    let nuevo;
    try { nuevo = JSON.parse(texto); } catch { return; } // a medio editar: se ignora hasta que sea JSON válido
    const anterior = actual;
    actual = normalizar(nuevo);
    escrito = texto;
    alCambiar(actual, anterior);
  });
  return actual;
}

// Cambia algunos valores desde la app (menú, botones, arrastre), los guarda y avisa
function cambiar(parcial) {
  const anterior = actual;
  actual = normalizar({ ...actual, ...parcial });
  guardar();
  alCambiar(actual, anterior);
}

const leer = () => actual;
const ruta = () => archivo;

module.exports = { iniciar, cambiar, leer, ruta, TAMANOS, DEFECTO };
