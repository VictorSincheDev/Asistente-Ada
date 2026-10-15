// Voz neuronal gratuita (Microsoft Edge Read Aloud, vía msedge-tts) con caché en disco.
// Node puro, sin Electron.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

// Voz, tono y velocidad vienen de config.json (ver config.js); estos son solo el arranque
const ajustes = { voz: 'es-PE-CamilaNeural', tono: '+20Hz', velocidad: '+8%' };

const { DATOS } = require('./rutas');

const DIR = path.join(DATOS, 'voz'); // caché
const FORMATO = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
const LIMITE_MS = 20000;                 // tope de una generación, para no dejar conexiones colgadas
const enCurso = new Map();               // archivo -> promesa, para no generar dos veces lo mismo

function archivo(texto) {
  const hash = crypto.createHash('sha1').update([ajustes.voz, ajustes.tono, ajustes.velocidad, texto].join('\n')).digest('hex');
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
    cliente = tts.setMetadata(ajustes.voz, FORMATO).then(() => tts);
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
  conectar().then((tts) => tts.setMetadata(ajustes.voz, FORMATO, {})).catch(() => {});
}

async function generar(texto) {
  let reloj;
  try {
    const audio = (async () => {
      const tts = await conectar();
      const { audioStream } = tts.toStream(escapar(texto), { pitch: ajustes.tono, rate: ajustes.velocidad });
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

// Cambia voz, tono o velocidad. Con otra voz se descarta la conexión (la próxima frase abre una nueva).
// Devuelve true si algo cambió.
function configurar({ voz, tono, velocidad }) {
  const nuevos = { voz, tono, velocidad };
  const cambio = Object.keys(nuevos).some((k) => nuevos[k] && nuevos[k] !== ajustes[k]);
  if (!cambio) return false;
  const otraVoz = voz && voz !== ajustes.voz;
  for (const k of Object.keys(nuevos)) if (nuevos[k]) ajustes[k] = nuevos[k];
  if (otraVoz && cliente) {
    const viejo = cliente;
    cliente = null;
    viejo.then((tts) => tts.close()).catch(() => {});
  }
  ultimoIntento = 0;
  return true;
}

// Voces neuronales en español disponibles: [{ id, nombre, pais }]. Se piden una vez al servicio.
let listaVoces = null;
function voces() {
  if (!listaVoces) {
    listaVoces = new MsEdgeTTS().getVoices().then((todas) => todas
      .filter((v) => /^es-/.test(v.ShortName))
      .map((v) => ({
        id: v.ShortName,
        nombre: v.ShortName.split('-')[2].replace(/(Multilingual)?Neural$/, ''),
        pais: (v.FriendlyName.match(/Spanish \(([^)]+)\)/) || [])[1] || v.Locale,
      }))
      .sort((a, b) => a.pais.localeCompare(b.pais) || a.nombre.localeCompare(b.nombre)));
    listaVoces.catch(() => { listaVoces = null; });
  }
  return listaVoces;
}

module.exports = { decir, calentar, configurar, voces };
