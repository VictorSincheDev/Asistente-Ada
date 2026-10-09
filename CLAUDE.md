# Hadita

Compañera de escritorio en pixel art que reacciona en vivo a mis sesiones de Claude Code.
Proyecto personal. Windows, Electron, JavaScript plano (sin build, sin framework).

## Cómo correr

- `npm start` levanta la ventana. No hay tests ni build.
- Tras cambiar `main.js` o `preload.js` hay que reiniciar; para `renderer.js` e `index.html` basta Ctrl+R en la ventana.
- Prueba manual de un evento:
  `curl -X POST http://127.0.0.1:4577/event -H "Content-Type: application/json" -d "{\"state\":\"waiting\",\"text\":\"Hola\"}"`

## Arquitectura

Claude Code (hooks con curl) → POST http://127.0.0.1:4577/event → server.js → main.js → IPC → renderer.js

- `server.js`: servidor HTTP local. Escucha SOLO en 127.0.0.1:4577. Node puro, sin Electron.
- `main.js`: ventana transparente, sin marco, siempre visible, abajo a la derecha (240x210). Reenvía cada evento al renderer por IPC (`hadita-event`).
- `preload.js`: expone `window.hadita.onEvent`, `focus`, `moveBy` y `quit`.
- `renderer.js`: todo lo visible. Sprite, estados, globo, sonido, saltito y voz.
- `index.html`: estructura y CSS. Tiene CSP: sin scripts inline.
- `hooks/`: `notify.js` y un ejemplo de settings. NO los uso; mis hooks reales usan curl.

## Eventos

Dos formatos llegan al mismo endpoint:

1. Hook de Claude Code tal cual (JSON por stdin): usa `hook_event_name`, `session_id`, `cwd`, `message`.
   - UserPromptSubmit, PreToolUse, PostToolUse, SubagentStop → working
   - PostToolUseFailure → working (falló una herramienta, pero Claude sigue; el globo lo dice, sin aviso)
   - StopFailure → error (el turno murió por un error de API; llega en lugar de Stop)
   - Notification → waiting
   - Stop → done (expira a los 8 s)
   - SessionEnd → borra la sesión
2. Formato directo: `{ "state": "idle|working|waiting|done|error", "text": "..." }`

## Estados

- Un estado por sesión, en un `Map` por `session_id`. Se muestra el más urgente: error > waiting > working > done > idle.
- Aura: working azul, waiting ámbar, done verde, error rojo, idle sin aura. El globo siempre dice el estado en texto.
- Los avisos (campanita, saltito, voz) solo saltan cuando el estado de una sesión CAMBIA a waiting, done o error.
- Voz con `speechSynthesis` (voces de Windows, busca una en español). Botón ♪ silencia y se guarda en localStorage.

## Clic y arrastre

- Clic en la hadita: `main.js` ejecuta `code "<cwd>"` de la sesión mostrada (la más urgente) para traer su VS Code al frente. Sin `cwd` no hace nada.
- El arrastre es manual (`pointermove` → IPC `hadita-move`). No volver a poner `-webkit-app-region: drag` en el sprite: en Windows se come los clics.

## Sprite

- Definido en `SPRITE` (16x16, un carácter por píxel) y `PALETTE` al inicio de `renderer.js`.
- Se dibuja en un canvas de 16x18 escalado a 96 px con `image-rendering: pixelated`.
- Caras: `FACES` son píxeles que se pintan encima del sprite. Feliz (sonrisa y mejillas) mientras se muestra done; dormida (ojos cerrados, alas quietas y «z» flotando) tras 5 min en idle (`SLEEP_MS`).
- Es diseño propio (pelo turquesa, alas lilas). Inspirado en la idea de Yui de SAO, pero no debe copiar al personaje.

## Reglas

- No tocar `~/.claude/settings.json` sin preguntarme. Ahí cada hook manda a dos destinos: mi oficina pixel (localhost:3777) y la hadita (127.0.0.1:4577). La oficina es otro proyecto y no se rompe.
- Usar siempre `127.0.0.1`, no `localhost`, para la hadita.
- Nunca bloquear a Claude Code: los hooks deben fallar en silencio si la hadita está cerrada.
- Mantenerlo simple: sin TypeScript, sin bundler y sin dependencias nuevas, salvo que yo lo pida.
- Textos de la interfaz y comentarios en español.

## Pendientes

1. Arrancar sola con Windows.
2. Resumen con IA de lo que hizo el agente al terminar.
3. Que me escuche (voz de entrada). Paso grande, al final.
