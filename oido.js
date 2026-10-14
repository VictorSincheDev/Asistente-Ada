// Oído: transcribe voz a texto en local con Whisper (@huggingface/transformers).
// Node puro, sin Electron.
const path = require('path');

const MODELO = 'Xenova/whisper-small';
const PRECISION = 'q8';    // pesos cuantizados: mucho más livianos que fp32
const IDIOMA = 'spanish';
const DIR = path.join(__dirname, 'modelos'); // descarga del modelo, fuera de git

// Frases que Whisper se inventa cuando solo hay silencio o ruido
const INVENTADAS = [
  /subt[ií]tulos/i, /amara\.org/i, /^gracias( por ver( el v[ií]deo)?)?$/i, /^suscr[ií]bete/i,
  /^(m[uú]sica|aplausos|risas|silencio)$/i,
];

let modelo = null; // promesa del pipeline; se carga una sola vez

function cargar() {
  if (!modelo) {
    modelo = (async () => {
      const { pipeline, env } = require('@huggingface/transformers');
      env.cacheDir = DIR;
      return pipeline('automatic-speech-recognition', MODELO, { dtype: PRECISION });
    })();
    modelo.catch((e) => {
      console.error('No pude cargar Whisper:', e.message);
      modelo = null; // se reintenta en la próxima transcripción
    });
  }
  return modelo;
}

// Deja solo lo que parece habla: sin etiquetas tipo [Música] ni frases inventadas
function limpiar(texto) {
  const t = String(texto || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/\s+/g, ' ').trim();
  const nucleo = t.replace(/^[\s.,;:¡!¿?…-]+|[\s.,;:¡!¿?…-]+$/g, '');
  if (!/\p{L}{2,}/u.test(nucleo)) return '';
  if (INVENTADAS.some((r) => r.test(nucleo))) return '';
  return t.replace(/\badita\b/gi, 'Hadita'); // la hache no suena, Whisper la escribe sin ella
}

// `audio`: Float32Array mono a 16 kHz. Devuelve el texto, o '' si no hubo habla.
async function transcribir(audio) {
  const asr = await cargar();
  const salida = await asr(audio, { language: IDIOMA, task: 'transcribe' });
  return limpiar(salida.text);
}

module.exports = { cargar, transcribir, limpiar, MODELO };
