// ---------- Sprite (16x16, diseño propio; cámbialo editando SPRITE y PALETTE) ----------
const SPRITE = [
  '......HHHH......',
  '.....HHHHHH.....',
  '....HHHHHHHH....',
  '....HSSSSSSH....',
  '....HSESSESH....',
  '....HSSSSSSH....',
  '.WW..HSSSSH..WW.',
  'WwwW..DDDD..WwwW',
  'WwwwWDDDDDDWwwwW',
  'WwwwWSDDDDSWwwwW',
  '.WwwW.DDDD.WwwW.',
  '..WW.DDDDDD.WW..',
  '.....DDDDDD.....',
  '......S..S......',
  '......S..S......',
  '......B..B......',
];
const PALETTE = { H: '#2fb8a6', S: '#ffd9b8', E: '#2a2540', D: '#f4f1ff', W: '#8f7cf0', w: '#d6cdff', B: '#6a5acd',
  M: '#c2566b', R: '#ffb0a8', C: '#b98a6e' }; // boca, mejilla y ojo cerrado

// Caras: píxeles [x, y, color] que se pintan encima del sprite
const FACES = {
  happy:  [[5, 5, 'R'], [7, 5, 'M'], [8, 5, 'M'], [10, 5, 'R']],
  asleep: [[6, 4, 'C'], [9, 4, 'C']],
};
const ZZZ = ['ZZZ', '.Z.', 'ZZZ']; // la «z» que sube mientras duerme
const SLEEP_MS = 5 * 60 * 1000;    // inactiva este rato → se duerme

// Color del aura por estado (el texto del globo dice lo mismo, no depende solo del color)
const STATES = {
  idle:    { aura: null,      speed: 900 },
  working: { aura: '#5aa9ff', speed: 220 },
  waiting: { aura: '#ffb347', speed: 450 },
  done:    { aura: '#5fd38d', speed: 600 },
  error:   { aura: '#ff5c5c', speed: 300 },
};
const PRIORITY = ['error', 'waiting', 'working', 'done', 'idle'];

const canvas = document.getElementById('sprite');
const ctx = canvas.getContext('2d');
const bubble = document.getElementById('bubble');
let current = 'idle';
let asleep = false;
let sleepTimer = null;

function draw(t) {
  const st = STATES[current];
  const flap = !asleep && Math.floor(t / st.speed) % 2 === 1; // dormida no aletea
  const bob = Math.floor(t / (asleep ? 1200 : 500)) % 2; // sube y baja 1 px
  ctx.clearRect(0, 0, 16, 18);
  SPRITE.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      const wing = ch === 'W' || ch === 'w';
      if (wing && flap) {
        if (x === 0 || x === 15) return;        // alas recogidas
        if (x === 1 || x === 14) ch = 'W';
      }
      ctx.fillStyle = PALETTE[ch];
      ctx.fillRect(x, y + 1 + bob, 1, 1);
    });
  });
  const face = asleep ? FACES.asleep : current === 'done' ? FACES.happy : null;
  if (face) {
    for (const [x, y, ch] of face) {
      ctx.fillStyle = PALETTE[ch];
      ctx.fillRect(x, y + 1 + bob, 1, 1);
    }
  }
  if (asleep) {
    const step = Math.floor(t / 700) % 3; // sube 1 px por paso y se desvanece
    ctx.fillStyle = PALETTE.w;
    ctx.globalAlpha = 1 - step * 0.3;
    ZZZ.forEach((row, y) => {
      [...row].forEach((ch, x) => { if (ch === 'Z') ctx.fillRect(13 + x, 3 - step + y, 1, 1); });
    });
    ctx.globalAlpha = 1;
  }
  canvas.style.filter = st.aura ? `drop-shadow(0 0 6px ${st.aura})` : 'none';
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ---------- Estado por sesión (varias sesiones de Claude Code a la vez) ----------
const sessions = new Map(); // id -> { state, text, cwd, timer }
let shown = null; // la sesión más urgente, la que se abre al hacer clic

function render() {
  let best = null;
  for (const s of sessions.values()) {
    if (!best || PRIORITY.indexOf(s.state) < PRIORITY.indexOf(best.state)) best = s;
  }
  shown = best;
  current = best ? best.state : 'idle';
  const text = best && best.state !== 'idle' ? best.text : '';
  bubble.textContent = text;
  bubble.classList.toggle('show', Boolean(text));
  updateSleep();
}

// Se duerme tras SLEEP_MS sin ninguna sesión activa; cualquier actividad la despierta
function updateSleep() {
  if (current !== 'idle') {
    clearTimeout(sleepTimer);
    sleepTimer = null;
    asleep = false;
  } else if (!sleepTimer && !asleep) {
    sleepTimer = setTimeout(() => { sleepTimer = null; asleep = true; }, SLEEP_MS);
  }
}
updateSleep();

// ---------- Avisos: sonido, saltito y voz ----------
let muted = false;
try { muted = localStorage.getItem('hadita-muted') === '1'; } catch {}
const muteBtn = document.getElementById('mute');
function paintMute() { muteBtn.textContent = muted ? 'off' : '♪'; muteBtn.title = muted ? 'Activar sonido' : 'Silenciar'; }
paintMute();
muteBtn.addEventListener('click', () => {
  muted = !muted;
  try { localStorage.setItem('hadita-muted', muted ? '1' : '0'); } catch {}
  if (muted && window.speechSynthesis) speechSynthesis.cancel();
  paintMute();
});

let audio;
function chime(notes) {
  try {
    audio = audio || new AudioContext();
    notes.forEach((freq, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      const t = audio.currentTime + i * 0.13;
      o.type = 'triangle';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.3);
    });
  } catch {}
}

function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  const es = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('es'));
  if (es) u.voice = es;
  u.lang = es ? es.lang : 'es-MX';
  u.rate = 1.05;
  u.pitch = 1.3;
  speechSynthesis.speak(u);
}

function announce(state, proj) {
  canvas.classList.remove('hop');
  void canvas.offsetWidth; // reinicia la animación
  canvas.classList.add('hop');
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

// ---------- Clic y arrastre ----------
// Clic: trae al frente el VS Code de la sesión que se muestra. Arrastrar: mueve la ventana.
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return; // tolerancia para que un clic no cuente como arrastre
  drag.moved = true;
  drag.x = e.screenX;
  drag.y = e.screenY;
  if (window.hadita) window.hadita.moveBy(dx, dy);
});
canvas.addEventListener('pointerup', () => {
  const wasClick = drag && !drag.moved;
  drag = null;
  if (wasClick && shown && shown.cwd && window.hadita) window.hadita.focus(shown.cwd);
});
canvas.addEventListener('pointercancel', () => { drag = null; });

if (window.hadita) {
  window.hadita.onEvent(handle);
  document.getElementById('close').addEventListener('click', () => window.hadita.quit());
}
window.__haditaHandle = handle; // para pruebas
