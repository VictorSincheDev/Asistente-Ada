import { initAvatar, mood, hop, lookAtCursor, resize, loadClips } from './avatar.js';
import { abrirMicro } from './oido.js';

const SLEEP_MS = 5 * 60 * 1000;  // inactiva este rato → se duerme
const AWAY_MS = 30 * 60 * 1000;  // sin eventos este rato → al volver, saluda

// Color del aura por estado (el texto del globo dice lo mismo, no depende solo del color)
const STATES = {
  idle:    { aura: null },
  working: { aura: '#5aa9ff' },
  waiting: { aura: '#ffb347' },
  done:    { aura: '#5fd38d' },
  error:   { aura: '#ff5c5c' },
};
const LISTEN_AURA = '#ff7ad9'; // escuchando: rosa, distinta a las de los estados
const PRIORITY = ['error', 'waiting', 'working', 'done', 'idle'];

const canvas = document.getElementById('avatar');
const bubble = document.getElementById('bubble');
let current = 'idle';
let sleepTimer = null;

// ---------- Estado por sesión (varias sesiones de Claude Code a la vez) ----------
const sessions = new Map(); // id -> { state, text, cwd, timer }
let shown = null; // la sesión más urgente; su VS Code se abre al hacer clic en el globo
let chat = null;  // charla en curso: { listening, thinking, text }; mientras exista, manda sobre el globo
let mic = null;   // grabación en curso (micrófono abierto)
let chatTimer = null;
let lastEvent = Date.now();

function render() {
  let best = null;
  for (const s of sessions.values()) {
    if (!best || PRIORITY.indexOf(s.state) < PRIORITY.indexOf(best.state)) best = s;
  }
  shown = best;
  current = best ? best.state : 'idle';
  const text = chat ? chat.text : best && best.state !== 'idle' ? best.text : '';
  bubble.textContent = text;
  bubble.classList.toggle('show', Boolean(text));
  bubble.classList.toggle('full', Boolean(chat && chat.full));
  mood.state = chat && chat.listening ? 'listening' : chat && chat.thinking ? 'thinking' : current;
  const aura = chat && chat.listening ? LISTEN_AURA : STATES[current].aura;
  canvas.style.filter = aura ? `drop-shadow(0 0 6px ${aura})` : 'none';
  updateSleep();
}

// Se duerme tras SLEEP_MS sin ninguna sesión activa; cualquier actividad la despierta
function updateSleep() {
  if (current !== 'idle' || chat) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
    mood.asleep = false;
  } else if (!sleepTimer && !mood.asleep) {
    sleepTimer = setTimeout(() => { sleepTimer = null; mood.asleep = true; }, SLEEP_MS);
  }
}
updateSleep();

// ---------- Avisos: sonido, saltito y voz ----------
// silencio y volumen vienen de config.json (main avisa cada vez que cambian)
let muted = false;
let volume = 1;
const muteBtn = document.getElementById('mute');
function paintMute() { muteBtn.textContent = muted ? 'off' : '♪'; muteBtn.title = muted ? 'Activar sonido' : 'Silenciar'; }
paintMute();
muteBtn.addEventListener('click', () => { if (window.hadita) window.hadita.silenciar(!muted); });

// Barrita de volumen: se oye al moverla y se guarda al soltarla
const volSlider = document.getElementById('vol');
function setVolume(v) {
  volume = v;
  if (voiceGain) voiceGain.gain.value = v;
  volSlider.title = `Volumen ${Math.round(v * 100)}%`;
}
volSlider.addEventListener('input', () => setVolume(volSlider.value / 100));
volSlider.addEventListener('change', () => {
  if (window.hadita) window.hadita.volumen(volSlider.value / 100);
  if (!muted) chime([880]); // muestra de cómo suena
  volSlider.blur();
});

let lastSize = null;
let animMap = null;     // config.animaciones vigente
let avatarReady = false;
function applyConfig(c) {
  if (c.silencio && !muted) stopVoice();
  muted = c.silencio;
  setVolume(c.volumen);
  if (document.activeElement !== volSlider) volSlider.value = Math.round(c.volumen * 100);
  paintMute();
  // nuevo tamaño: el zoom ya cambió, falta ajustar la resolución del canvas
  if (lastSize && c.tamano !== lastSize) setTimeout(resize, 50);
  lastSize = c.tamano;
  // otro mapa de clips: se vuelven a cargar
  if (JSON.stringify(c.animaciones) !== JSON.stringify(animMap)) {
    animMap = c.animaciones;
    if (avatarReady) loadAnimations();
  }
}

// Lee de assets/anim/ los clips del mapa; los que falten quedan con movimiento por código
async function loadAnimations() {
  const list = [];
  for (const [key, name] of Object.entries(animMap || {})) {
    const file = name ? await window.hadita.leerAnimacion(name) : null;
    if (file) list.push({ key, ...file });
  }
  const loaded = await loadClips(list);
  console.log('Animaciones:', loaded.length ? loaded.join(', ') : 'ninguna (todo por código)');
}

let audio;
function chime(notes) {
  if (mic) return; // con el micrófono abierto no suena nada
  try {
    audio = audio || new AudioContext();
    audio.resume();
    notes.forEach((freq, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      const t = audio.currentTime + i * 0.13;
      o.type = 'triangle';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.15 * volume), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.3);
    });
  } catch {}
}

// ---------- Voz: neuronal (la genera main) y, de respaldo, speechSynthesis ----------
let voiceQueue = Promise.resolve(); // una frase a la vez
let voiceSource = null;
let voiceGain = null;
let voiceTurn = 0; // cambia al silenciar, para descartar lo que estaba en cola

function stopVoice() {
  voiceTurn++;
  if (voiceSource) { try { voiceSource.stop(); } catch {} }
  if (window.speechSynthesis) speechSynthesis.cancel();
}

// `ephemeral`: frase que no se repetirá (charla), no se guarda en la caché
function speak(text, ephemeral) {
  const turn = voiceTurn;
  return voiceQueue = voiceQueue.then(async () => {
    while (mic) await mic.done; // no habla mientras escucha, para no oírse a sí misma
    if (muted || turn !== voiceTurn) return;
    let bytes = null;
    try { bytes = window.hadita ? await window.hadita.decir(text, ephemeral) : null; } catch {}
    if (muted || turn !== voiceTurn) return;
    if (bytes) {
      try { return await playVoice(bytes); } catch (e) { console.error('No pude reproducir la voz:', e); }
    }
    return speakFallback(text);
  });
}

// Reproduce el mp3 y mueve la boca con el volumen real (AnalyserNode)
async function playVoice(bytes) {
  audio = audio || new AudioContext();
  audio.resume();
  const buffer = await audio.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const source = audio.createBufferSource();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  const samples = new Uint8Array(analyser.fftSize);
  source.buffer = buffer;
  voiceGain = audio.createGain();
  voiceGain.gain.value = volume;
  // el analizador va antes del volumen: la boca se mueve igual aunque el volumen esté bajo
  source.connect(analyser).connect(voiceGain).connect(audio.destination);
  mood.mouthLevel = () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += ((s - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / samples.length) * 5); // RMS llevado a 0..1
  };
  voiceSource = source;
  await new Promise((resolve) => { source.onended = resolve; source.start(); });
  voiceSource = null;
  mood.mouthLevel = null;
}

function speakFallback(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  const es = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('es'));
  if (es) u.voice = es;
  u.lang = es ? es.lang : 'es-MX';
  u.rate = 1.05;
  u.pitch = 1.3;
  u.volume = volume;
  // mueve la boca mientras dura la frase
  u.onstart = () => { mood.talking = true; };
  return new Promise((resolve) => {
    u.onend = u.onerror = () => { mood.talking = false; resolve(); };
    speechSynthesis.speak(u);
  });
}

function announce(state, proj) {
  hop();
  if (muted) return;
  if (state === 'done') {
    chime([659, 880, 1319]);
    speak(proj ? `Terminó ${proj}` : 'Terminé');
  } else if (state === 'error') {
    chime([440, 330, 220]);
    speak(proj ? `Hubo un error en ${proj}` : 'Hubo un error');
  } else {
    chime([880, 660]);
    speak(proj ? `Te necesito en ${proj}` : 'Te necesito aquí');
  }
}

// ---------- Saludos (frases.json) ----------
const frases = (window.hadita && window.hadita.frases) || {};
function pick(key) {
  const list = Array.isArray(frases[key]) ? frases[key] : [];
  return list[Math.floor(Math.random() * list.length)] || '';
}

// Cara feliz, brazo en alto, saltito y la frase en voz alta. Devuelve la promesa de la voz.
let greetTimer = null;
function salute(text) {
  hop();
  mood.greeting = true;
  clearTimeout(greetTimer);
  greetTimer = setTimeout(() => { mood.greeting = false; }, 3500);
  return text && !muted ? speak(text) : Promise.resolve();
}

function greet() {
  const h = new Date().getHours();
  salute(pick(h < 12 ? 'manana' : h < 19 ? 'tarde' : 'noche'));
}

// Al cerrar se despide y sale cuando termina la frase (o a los 5 s como mucho)
let leaving = false;
function farewell() {
  if (leaving) return;
  leaving = true;
  stopVoice();
  const voice = salute(pick('despedida'));
  Promise.race([voice, new Promise((r) => setTimeout(r, 5000))]).then(() => window.hadita.quit());
}

function setSession(id, state, text, ttlMs, proj, cwd) {
  const prev = sessions.get(id);
  if (prev && prev.timer) clearTimeout(prev.timer);
  // solo avisa cuando el estado cambia, no en cada evento repetido
  if ((state === 'waiting' || state === 'done' || state === 'error') && (!prev || prev.state !== state)) announce(state, proj);
  const entry = { state, text, cwd: cwd || (prev && prev.cwd), timer: null };
  if (ttlMs) entry.timer = setTimeout(() => { sessions.delete(id); render(); }, ttlMs);
  sessions.set(id, entry);
  render();
}

function projectName(cwd) {
  return cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : '';
}

// Texto corto para los errores de API que reporta StopFailure (campo `error`)
const API_ERRORS = {
  rate_limit: 'Límite de uso alcanzado',
  overloaded: 'La API está saturada',
  authentication_failed: 'Falló la autenticación',
  billing_error: 'Problema de facturación',
  account_on_hold: 'Cuenta en pausa',
  model_not_found: 'Modelo no encontrado',
  server_error: 'Error del servidor',
  max_output_tokens: 'Respuesta cortada por límite de tokens',
};

function handle(evt) {
  // vuelve la actividad tras un buen rato sin eventos: saluda
  if (Date.now() - lastEvent > AWAY_MS) salute(pick('regreso'));
  lastEvent = Date.now();
  const id = evt.session_id || 'default';
  const proj = projectName(evt.cwd);
  const tag = proj ? ` · ${proj}` : '';

  // Formato directo, por si quieres mandarle eventos desde tu oficina pixel:
  // { "state": "working|waiting|done|error|idle", "text": "..." }
  if (evt.state && STATES[evt.state]) {
    return setSession(id, evt.state, evt.text || '', evt.state === 'done' ? 8000 : 0, proj, evt.cwd);
  }

  switch (evt.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return setSession(id, 'working', `Trabajando${tag}`, 10 * 60 * 1000, proj, evt.cwd);
    case 'PostToolUseFailure':
      // falló una herramienta, pero Claude sigue trabajando: no es un estado de error
      return setSession(id, 'working', `Falló ${evt.tool_name || 'una herramienta'}, sigue${tag}`, 10 * 60 * 1000, proj, evt.cwd);
    case 'SubagentStop':
      return setSession(id, 'working', `Un subagente terminó${tag}`, 10 * 60 * 1000, proj, evt.cwd);
    case 'Notification':
      return setSession(id, 'waiting', `${evt.message || 'Te necesito aquí'}${tag}`, 0, proj, evt.cwd);
    case 'Stop':
      return setSession(id, 'done', `¡Listo!${tag}`, 8000, proj, evt.cwd);
    case 'StopFailure':
      // el turno murió por un error de API (llega en lugar de Stop)
      return setSession(id, 'error', `${API_ERRORS[evt.error] || evt.last_assistant_message || 'Error de API'}${tag}`, 0, proj, evt.cwd);
    case 'SessionEnd':
      sessions.delete(id);
      return render();
  }
}

// ---------- Charla por texto ----------
const ask = document.getElementById('ask');

function setChat(next, ttlMs) {
  clearTimeout(chatTimer);
  chat = next;
  if (next && ttlMs) chatTimer = setTimeout(() => setChat(null), ttlMs);
  render();
}

function toggleAsk(open) {
  ask.classList.toggle('show', open);
  if (open) ask.focus(); else ask.blur();
}

ask.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return toggleAsk(false);
  const text = ask.value.trim();
  if (e.key !== 'Enter' || !text || busy || !window.hadita) return;
  ask.value = '';
  askHadita(text);
});

// Le pregunta a la hadita (escrito o hablado) y muestra y dice la respuesta
let busy = false; // transcribiendo o pensando
// `echo`: muestra un momento «Tú: …» (lo que entendió por voz) mientras ya está pensando
async function askHadita(text, echo) {
  if (pending) { busy = false; return answerPending(text, echo); } // hay un «¿Confirmas?» abierto: esto es el sí o el no
  busy = true;
  ask.disabled = true;
  setChat({ thinking: true, text: echo ? `Tú: ${text}` : 'Pensando…' });
  if (echo) setTimeout(() => { if (chat && chat.thinking) setChat({ thinking: true, text: 'Pensando…' }); }, 2000);
  let reply = { texto: 'Uy, no pude pensar eso. ¿Me lo repites?' };
  try { reply = await window.hadita.preguntar(text); } catch {}
  busy = false;
  ask.disabled = false;
  if (ask.classList.contains('show')) ask.focus();
  if (reply.confirmar) return askConfirm(reply, echo);
  say(reply.texto);
}

// Muestra un texto en el globo un rato proporcional a su largo y lo dice
function say(text) {
  setChat({ text }, Math.max(8000, text.length * 90));
  return muted ? Promise.resolve() : speak(text, true);
}

// ---------- Encargos a Claude Code: confirmación obligatoria ----------
const confirmBox = document.getElementById('confirm');
let pending = null; // { id, timer }: tarea que espera mi sí o no (voz, texto o botones)

function askConfirm(reply, byVoice) {
  const id = reply.confirmar;
  pending = { id, timer: setTimeout(() => { if (pending && pending.id === id) settle(false); }, 60000) };
  confirmBox.classList.add('show');
  setChat({ text: reply.texto, full: true });
  const spoken = muted ? Promise.resolve() : speak(reply.texto, true);
  // si me lo pidió hablando, al terminar la pregunta abre el micrófono para oír el sí o el no
  if (byVoice) spoken.then(() => { if (pending && pending.id === id && !mic) toggleListen(); });
}

// Lo que escribí o dije mientras esperaba confirmación: se decide aquí, sin pasar por el modelo
function answerPending(text, byVoice) {
  const t = text.toLowerCase().replace(/^[\s¡!¿?.,]+/, '');
  if (/^(s[ií]|confirmo|confirmado|dale|hazlo|ok|okay|claro|adelante|de acuerdo)(?![\p{L}])/u.test(t)) return settle(true);
  if (/^(no|cancela|cancelar|mejor no|olv[ií]dalo)(?![\p{L}])/u.test(t)) return settle(false);
  if (chat && !chat.text.endsWith('(Dime sí o no)')) setChat({ text: `${chat.text}\n(Dime sí o no)`, full: true });
  const spoken = muted ? Promise.resolve() : speak('Dime sí o no');
  if (byVoice) spoken.then(() => { if (pending && !mic) toggleListen(); });
}

async function settle(yes) {
  if (!pending) return;
  const { id, timer } = pending;
  clearTimeout(timer);
  pending = null;
  confirmBox.classList.remove('show');
  if (mic) { discard = true; mic.stop(); } // ya respondí con un botón: lo grabado no cuenta
  let reply = { texto: 'Uy, no pude enviar la tarea.' };
  try { reply = await window.hadita.confirmar(id, yes); } catch {}
  say(reply.texto);
}
document.getElementById('yes').addEventListener('click', () => settle(true));
document.getElementById('no').addEventListener('click', () => settle(false));

// ---------- Entrada por voz (Ctrl+Alt+Espacio) ----------
const micBadge = document.getElementById('mic');
let opening = false;
let discard = false; // la grabación en curso se tira sin transcribir

function notHeard(text = 'No te escuché bien') {
  setChat({ text }, 5000);
  if (!muted) speak(text);
}

async function toggleListen() {
  if (mic) return mic.stop(); // ya escucha: corta y envía
  if (opening || busy || leaving || !window.hadita) return;
  opening = true;
  stopVoice(); // si estaba hablando, se calla antes de abrir el micrófono
  let recording;
  try {
    audio = audio || new AudioContext();
    await audio.resume();
    recording = await abrirMicro(audio);
  } catch (e) {
    console.error('No pude abrir el micrófono:', e);
    opening = false;
    return setChat({ text: 'No pude abrir el micrófono' }, 5000);
  }
  opening = false;
  mic = recording;
  micBadge.classList.add('show'); // indicador visible mientras el micrófono está abierto
  setChat({ listening: true, text: 'Te escucho…' });
  const samples = await recording.done;
  mic = null;
  micBadge.classList.remove('show');
  if (discard) { discard = false; return; }
  heard(samples);
}

// Lo grabado (o null si no hubo voz) → texto → charla
async function heard(samples) {
  if (!samples) return notHeard();
  busy = true;
  setChat({ thinking: true, text: 'Pensando…' });
  let text = '';
  try { text = (await window.hadita.transcribir(samples)) || ''; } catch {}
  if (!text) { busy = false; return notHeard(); }
  askHadita(text, true);
}

// ---------- Clic y arrastre ----------
// Clic en la hadita: abre o cierra la cajita de texto. Arrastrar: mueve la ventana.
// Clic en el globo: trae al frente el VS Code de la sesión que se muestra.
bubble.addEventListener('click', () => {
  if (shown && shown.cwd && window.hadita) window.hadita.focus(shown.cwd);
});
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY, moved: false };
  if (window.hadita) window.hadita.drag('inicio');
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return; // tolerancia para que un clic no cuente como arrastre
  drag.moved = true;
  if (window.hadita) window.hadita.drag('mover'); // main calcula la posición con el cursor real
});
canvas.addEventListener('pointerup', () => {
  const wasClick = drag && !drag.moved;
  if (drag && drag.moved && window.hadita) window.hadita.drag('fin'); // guarda la posición
  drag = null;
  if (wasClick) toggleAsk(!ask.classList.contains('show'));
});
canvas.addEventListener('pointercancel', () => {
  if (drag && drag.moved && window.hadita) window.hadita.drag('fin');
  drag = null;
});

if (window.hadita) {
  window.hadita.onConfig(applyConfig);
  // la configuración llega antes del saludo, para que respete el silencio
  Promise.all([window.hadita.leerConfig().then(applyConfig), window.hadita.loadModel()])
    .then(([, buffer]) => initAvatar(canvas, buffer))
    .then(() => { avatarReady = true; return loadAnimations(); })
    .then(greet)
    .catch((e) => {
      console.error('No pude cargar el avatar:', e);
      bubble.textContent = 'No pude cargar assets/hadita.vrm';
      bubble.classList.add('show');
    });
  // el cursor llega en píxeles relativos a la ventana
  window.hadita.onCursor((x, y) => {
    const r = canvas.getBoundingClientRect();
    lookAtCursor(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
  });
  window.hadita.onEscuchar(toggleListen);
  window.hadita.onTarea(say); // resumen de una tarea que terminó
  window.hadita.onEvent(handle);
  document.getElementById('close').addEventListener('click', farewell);
  document.getElementById('gear').addEventListener('click', () => window.hadita.menu());
  window.hadita.onSalir(farewell); // «Salir» del menú: también se despide
}
window.__haditaHandle = handle; // para pruebas
window.__haditaHeard = heard;
