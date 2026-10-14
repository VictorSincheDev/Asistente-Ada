// Encargos para Claude Code: lista blanca de proyectos, confirmación, ejecución y log.
// Node puro, sin Electron.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sesiones = require('./sesiones');

const CONFIG = process.env.HADITA_TAREAS || path.join(__dirname, 'tareas.json'); // lista blanca y permisos, se edita a mano
const LOG = path.join(sesiones.DIR, 'tareas.log');
const HERRAMIENTAS = ['Read', 'Glob', 'Grep', 'Edit', 'Write']; // por defecto: leer y editar archivos, sin Bash
const LIMITE_MIN = 15;
const CONFIRMAR_MS = 60000;   // la confirmación caduca
const SESIONES_LISTADAS = 5;  // conversaciones por proyecto que se le muestran al modelo

const pendientes = new Map(); // id -> tarea preparada, a la espera del sí
const enCurso = new Set();    // proyectos con una tarea corriendo

// Se relee en cada uso, para que los cambios en tareas.json valgan sin reiniciar.
// Devuelve [{ nombre, carpeta, herramientas }].
function proyectos() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
  const porDefecto = Array.isArray(config.herramientas) ? config.herramientas : HERRAMIENTAS;
  return Object.entries(config.proyectos || {})
    .filter(([, p]) => p && typeof p.carpeta === 'string')
    .map(([nombre, p]) => ({
      nombre,
      carpeta: path.resolve(p.carpeta),
      herramientas: (Array.isArray(p.herramientas) ? p.herramientas : porDefecto).filter((h) => typeof h === 'string'),
      limiteMin: Number(p.limiteMinutos || config.limiteMinutos) || LIMITE_MIN,
    }));
}

function hace(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 60) return `hace ${Math.max(min, 1)} min`;
  if (min < 60 * 24) return `hace ${Math.round(min / 60)} h`;
  return `hace ${Math.round(min / 1440)} d`;
}

// Lo que ve el modelo para elegir sin inventar: proyectos permitidos y sus conversaciones,
// con códigos cortos (s1, s2...). `codigos` traduce cada código a su sesión.
function contexto() {
  const codigos = new Map();
  let n = 0;
  const lineas = proyectos().map((p) => {
    const lista = sesiones.deCarpeta(p.carpeta).filter((s) => s.titulo).slice(0, SESIONES_LISTADAS).map((s) => {
      const codigo = `s${++n}`;
      codigos.set(codigo, s);
      return `${codigo} «${s.titulo}» (${hace(s.ultimo)})`;
    });
    return `- ${p.nombre}: ${lista.join('; ') || 'sin conversaciones conocidas'}`;
  });
  return { texto: lineas.join('\n') || '(ninguno: la lista de proyectos permitidos está vacía)', codigos };
}

// Valida un encargo contra la lista blanca y lo deja a la espera de confirmación.
// Devuelve { texto } (se negó o falta algo) o { texto, confirmar: id }.
function preparar(encargo, codigos) {
  const lista = proyectos();
  const nombres = lista.map((p) => p.nombre).join(', ') || 'ninguno todavía';
  if (!encargo.proyecto) return { texto: `¿En qué proyecto lo hago? Puedo trabajar en: ${nombres}.` };
  const proyecto = lista.find((p) => p.nombre.toLowerCase() === encargo.proyecto.toLowerCase());
  if (!proyecto) {
    return { texto: `No puedo: ${encargo.proyecto} no está en mi lista de proyectos permitidos. Tengo: ${nombres}.` };
  }
  if (!fs.existsSync(proyecto.carpeta)) return { texto: `No encuentro la carpeta de ${proyecto.nombre}.` };
  if (enCurso.has(proyecto.nombre)) return { texto: `Ya hay una tarea en curso en ${proyecto.nombre}. Espera a que termine.` };

  let sesion = null, titulo = 'nueva';
  if (encargo.sesion === 'ultima') titulo = 'la última';
  else if (codigos.has(encargo.sesion)) {
    sesion = codigos.get(encargo.sesion);
    // la conversación tiene que ser de ese mismo proyecto
    if (!sesiones.deCarpeta(proyecto.carpeta).includes(sesion)) sesion = null;
    else titulo = `«${sesion.titulo}»`;
  }
  const id = crypto.randomUUID();
  const tarea = {
    id, proyecto, prompt: encargo.prompt.replace(/^-+\s*/, ''), // que no parezca una flag
    modo: sesion ? 'reanudar' : encargo.sesion === 'ultima' ? 'continuar' : 'nueva',
    sesion, titulo,
  };
  pendientes.set(id, tarea);
  setTimeout(() => pendientes.delete(id), CONFIRMAR_MS);
  return { texto: `Voy a pedir «${tarea.prompt}» en ${proyecto.nombre}, conversación ${titulo}. ¿Confirmas?`, confirmar: id };
}

function anotar(tarea) {
  const linea = [new Date().toISOString(), tarea.proyecto.nombre, tarea.titulo, JSON.stringify(tarea.prompt)].join('\t');
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, linea + '\n');
  } catch (e) {
    console.error('No pude escribir el log de tareas:', e.message);
  }
}

// Argumentos de claude para una tarea, siempre como array (execFile no usa shell)
function argumentos(tarea) {
  const args = [
    '-p', tarea.prompt,
    '--tools', tarea.proyecto.herramientas.join(','),        // solo estas herramientas existen
    '--allowedTools', tarea.proyecto.herramientas.join(','), // y se usan sin preguntar
    '--permission-mode', 'acceptEdits',
    '--strict-mcp-config',                                   // sin servidores MCP
    '--output-format', 'json',
  ];
  if (tarea.modo === 'reanudar') args.push('--resume', tarea.sesion.id);
  if (tarea.modo === 'continuar') args.push('--continue');
  return args;
}

// Respuesta a la confirmación. Con sí, lanza la tarea y avisa por `alTerminar(texto, resultado)`.
// Devuelve el texto que la hadita dice en el momento.
function confirmar(id, si, alTerminar) {
  const tarea = pendientes.get(id);
  pendientes.delete(id);
  if (!tarea) return 'Esa confirmación ya caducó. Pídemelo otra vez.';
  if (!si) return 'Vale, no hago nada.';
  const { proyecto } = tarea;
  if (enCurso.has(proyecto.nombre)) return `Ya hay una tarea en curso en ${proyecto.nombre}. Espera a que termine.`;

  enCurso.add(proyecto.nombre);
  anotar(tarea);
  const cwd = tarea.modo === 'reanudar' ? tarea.sesion.cwd : proyecto.carpeta;
  const hijo = execFile('claude', argumentos(tarea),
    { cwd, timeout: proyecto.limiteMin * 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    (error, stdout) => {
      enCurso.delete(proyecto.nombre);
      let salida = null;
      try { salida = JSON.parse(stdout); } catch {}
      if (error || !salida || salida.is_error) {
        const motivo = error && error.killed ? `pasó de ${proyecto.limiteMin} minutos` : 'Claude Code falló';
        console.error('Tarea falló:', error ? error.message.split('\n')[0] : String(stdout).slice(0, 200));
        return alTerminar(`La tarea en ${proyecto.nombre} no terminó bien: ${motivo}.`, null);
      }
      alTerminar(null, { proyecto: proyecto.nombre, texto: String(salida.result || '') });
    });
  if (hijo.stdin) hijo.stdin.end();
  return `Hecho, ya se lo pedí a Claude en ${proyecto.nombre}. Te aviso cuando termine.`;
}

module.exports = { contexto, preparar, confirmar, argumentos, proyectos, CONFIG, LOG };
