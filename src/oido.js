// Captura del micrófono: graba hasta que hay silencio y entrega Float32 mono a 16 kHz.
const SILENCIO_MS = 1500;    // tras hablar, este silencio cierra la grabación
const ESPERA_VOZ_MS = 6000;  // si en este tiempo no se oye nada, se da por vacía
const MAXIMO_MS = 20000;
const UMBRAL = 0.015;        // volumen (RMS) a partir del cual cuenta como voz
const HZ = 16000;

// Abre el micrófono y empieza a grabar. Devuelve { stop, done }:
// `done` se resuelve con las muestras, o con null si no se oyó voz.
export async function abrirMicro(ctx) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);

  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };

  const start = performance.now();
  let heard = false, lastVoice = 0;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const now = performance.now();
    if (Math.sqrt(sum / samples.length) > UMBRAL) { heard = true; lastVoice = now; }
    if (heard ? now - lastVoice > SILENCIO_MS : now - start > ESPERA_VOZ_MS) stop();
    if (now - start > MAXIMO_MS) stop();
  }, 50);

  const done = new Promise((resolve) => {
    recorder.onstop = async () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop()); // aquí se cierra el micrófono
      source.disconnect();
      if (!heard) return resolve(null);
      try {
        const encoded = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
        resolve(await aMono16k(ctx, encoded));
      } catch (e) {
        console.error('No pude convertir el audio:', e);
        resolve(null);
      }
    };
  });
  recorder.start();
  return { stop, done };
}

// Decodifica un audio y lo remuestrea a mono 16 kHz, que es lo que espera Whisper
export async function aMono16k(ctx, encoded) {
  const decoded = await ctx.decodeAudioData(encoded);
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * HZ), HZ);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0);
}
