// Voz neuronal gratuita (Microsoft Edge Read Aloud, vía msedge-tts) con caché en disco.
// Node puro, sin Electron.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const VOZ = 'es-PE-CamilaNeural';
const TONO = '+20Hz';      // un poco más agudo
const VELOCIDAD = '+8%';   // levemente más rápido

const DIR = path.join(__dirname, 'voz'); // caché, fuera de git
const FORMATO = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const LIMITE_MS = 20000;                 // tope de una generación, para no dejar conexiones colgadas
const enCurso = new Map();               // archivo -> promesa, para no generar dos veces lo mismo

function archivo(texto) {
  const hash = crypto.createHash('sha1').update([VOZ, TONO, VELOCIDAD, texto].join('\n')).digest('hex');
  return path.join(DIR, `${hash}.mp3`);
}

// la librería no escapa el texto y va dentro de SSML
function escapar(texto) {
  return texto.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Una sola conexión para todas las frases: conectar tarda segundos, sintetizar no.
let cliente = null; // promesa del MsEdgeTTS ya conectado
function conectar() {
  if (!cliente) {
    const tts = new MsEdgeTTS();
    cliente = tts.setMetadata(VOZ, FORMATO).then(() => tts);
    cliente.catch(() => { cliente = null; });
  }
  return cliente;
}

// Deja la conexión abierta por adelantado. El servicio la cierra tras unos 30 s sin uso y
// reabrirla tarda segundos, así que se llama cuando hay actividad. Como mucho un intento cada 15 s.
let ultimoIntento = 0;
function calentar() {
  if (Date.now() - ultimoIntento < 15000) return;
  ultimoIntento = Date.now();
  // el {} es necesario: sin él, la librería falla al repetir setMetadata
  conectar().then((tts) => tts.setMetadata(VOZ, FORMATO, {})).catch(() => {});
}

async function generar(texto) {
  let reloj;
  try {
    const audio = (async () => {
      const tts = await conectar();
      const { audioStream } = tts.toStream(escapar(texto), { pitch: TONO, rate: VELOCIDAD });
      const partes = [];
      for await (const parte of audioStream) partes.push(parte);
      return Buffer.concat(partes);
    })();
    audio.catch(() => {}); // si gana el tope, que su fallo tardío no quede sin atender
    const tope = new Promise((_, reject) => { reloj = setTimeout(() => reject(new Error('tiempo agotado')), LIMITE_MS); });
    const bytes = await Promise.race([audio, tope]);
    if (!bytes.length) throw new Error('audio vacío');
    return bytes;
  } catch (e) {
    // conexión dudosa: se descarta y la próxima frase abre una nueva
    const viejo = cliente;
    cliente = null;
    if (viejo) viejo.then((tts) => tts.close()).catch(() => {});
    throw e;
  } finally {
    clearTimeout(reloj);
  }
}

// Devuelve los bytes del mp3: de la caché si ya existe; si no, lo genera y lo guarda.
// Con `guardar: false` no toca el disco (respuestas de la charla, que no se repiten).
function decir(texto, { guardar = true } = {}) {
  if (!guardar) return generar(texto);
  const ruta = archivo(texto);
  if (enCurso.has(ruta)) return enCurso.get(ruta);
  const promesa = (async () => {
    try { return await fs.promises.readFile(ruta); } catch {}
    const bytes = await generar(texto);
    await fs.promises.mkdir(DIR, { recursive: true });
    // se escribe aparte y se renombra, para no dejar un audio a medias en la caché
    await fs.promises.writeFile(`${ruta}.tmp`, bytes);
    await fs.promises.rename(`${ruta}.tmp`, ruta);
    return bytes;
  })().finally(() => enCurso.delete(ruta));
  enCurso.set(ruta, promesa);
  return promesa;
}

module.exports = { decir, calentar, VOZ, TONO, VELOCIDAD };
