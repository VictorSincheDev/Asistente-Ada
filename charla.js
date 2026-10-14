// Conversación: le pregunta a Claude Code (`claude -p`) en nombre de la hadita y, de paso,
// decide si el mensaje es charla o un encargo para Claude Code. Node puro, sin Electron.
const fs = require('fs');
const { execFile } = require('child_process');

const PERSONAJE = 'Eres Hadita, la compañera de escritorio de Victor. Responde siempre en español, ' +
  'cálida y breve: máximo dos frases, sin markdown.';
// Cómo distinguir charla de encargo. La lista de proyectos y conversaciones va en cada mensaje.
const INTENCION = `
Victor también puede encargarte tareas para Claude Code en sus proyectos de programación. Tú no las haces: solo las clasificas y otro programa las envía tras pedirle confirmación a Victor.
Clasifica cada mensaje:
- "conversar": charla, preguntas o cualquier cosa que no sea un encargo claro. Pon tu respuesta en "respuesta".
- "tarea": Victor pide que Claude Code haga algo en un proyecto (revisar, arreglar, crear, cambiar código...). Entonces:
  - "proyecto": el nombre exacto de la lista si coincide con lo que dijo; si no está en la lista, el nombre tal como lo dijo; si no dijo ninguno, cadena vacía.
  - "sesion": "nueva" si no indicó conversación o pidió una nueva; "ultima" si pidió seguir con lo último; o el código (s1, s2...) de una conversación de la lista de ese proyecto si se refirió a ella. Nunca inventes un código.
  - "prompt": la instrucción para Claude Code, completa y fiel a lo que pidió Victor, sin añadir detalles que no dijo.
Ante la duda, "conversar".`;
const ESQUEMA = JSON.stringify({
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['conversar', 'tarea'] },
    respuesta: { type: 'string' },
    proyecto: { type: 'string' },
    sesion: { type: 'string' },
    prompt: { type: 'string' },
  },
  required: ['tipo'],
});
const MODELO = 'haiku';       // rápido; la respuesta son dos frases
const LIMITE_MS = 30000;
const MAX_INTERCAMBIOS = 6;   // memoria de la charla (solo en RAM)
const ERROR = 'Uy, no pude pensar eso. ¿Me lo repites?';

const historial = []; // { victor, hadita }

function recordar(victor, hadita) {
  historial.push({ victor, hadita });
  while (historial.length > MAX_INTERCAMBIOS) historial.shift();
}

// Flags comunes: sin herramientas, sin MCP, sin mis ajustes de usuario y sin hooks
// (si disparara los hooks, la hadita se avisaría a sí misma).
function base(prompt, sistema) {
  return [
    '-p', prompt,
    '--system-prompt', sistema,
    '--model', MODELO,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--settings', '{"disableAllHooks":true}',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
}

// Ejecuta claude en `carpeta` (vacía) y devuelve su salida, o null si falla o se pasa del tiempo.
// El prompt va como argumento aparte: execFile no usa shell.
function claude(args, carpeta) {
  return new Promise((resolve) => {
    fs.mkdirSync(carpeta, { recursive: true });
    const hijo = execFile('claude', args,
      { cwd: carpeta, timeout: LIMITE_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) console.error('Charla falló:', error.message.split('\n')[0]);
        resolve(error ? null : String(stdout || ''));
      });
    if (hijo.stdin) hijo.stdin.end(); // que no se quede esperando entrada
  });
}

const sinMarkdown = (t) => String(t || '').replace(/[*`]|^#+\s*/gm, '').trim();

// `proyectos`: texto con los proyectos y conversaciones conocidos (lo arma tareas.js).
// Devuelve { tipo: 'conversar', texto } | { tipo: 'tarea', proyecto, sesion, prompt } | { tipo: 'error', texto }.
async function preguntar(mensaje, carpeta, proyectos) {
  const previo = historial.map((h) => `Victor: ${h.victor}\nHadita: ${h.hadita}`).join('\n');
  const prompt = `Proyectos y conversaciones conocidos:\n${proyectos || '(ninguno)'}\n\n` +
    (previo ? `Conversación hasta ahora:\n${previo}\n\n` : '') + `Victor: ${mensaje}`;
  const args = [...base(prompt, PERSONAJE + '\n' + INTENCION), '--output-format', 'json', '--json-schema', ESQUEMA];
  const salida = await claude(args, carpeta);
  let dato = null;
  try { dato = JSON.parse(salida).structured_output; } catch {}
  if (!dato || typeof dato !== 'object') return { tipo: 'error', texto: ERROR };
  if (dato.tipo === 'tarea' && typeof dato.prompt === 'string' && dato.prompt.trim()) {
    return { tipo: 'tarea', proyecto: String(dato.proyecto || '').trim(),
      sesion: String(dato.sesion || 'nueva').trim(), prompt: dato.prompt.trim() };
  }
  const texto = sinMarkdown(dato.respuesta);
  if (!texto) return { tipo: 'error', texto: ERROR };
  recordar(mensaje, texto);
  return { tipo: 'conversar', texto };
}

// Resume en una o dos frases, para decirlo en voz alta, lo que respondió Claude Code a una tarea
async function resumir(resultado, carpeta) {
  const prompt = 'Esto respondió Claude Code al terminar una tarea que le encargó Victor. ' +
    'Cuéntale el resultado en una o dos frases:\n\n' + String(resultado).slice(0, 6000);
  return sinMarkdown(await claude(base(prompt, PERSONAJE), carpeta));
}

module.exports = { preguntar, resumir, recordar, ERROR, MODELO };
