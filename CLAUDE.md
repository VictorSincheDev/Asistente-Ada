# Hadita

Compañera de escritorio 3D (avatar VRM) que reacciona en vivo a mis sesiones de Claude Code.
Proyecto personal. Windows, Electron, JavaScript plano (sin framework). Rama `3d`; la versión pixel art quedó en `main`.

## Cómo correr

- `npm start` construye el renderer y levanta la ventana. No hay tests.
- `npm run build` empaqueta `src/renderer.js` con esbuild en `dist/renderer.js` (no se versiona).
- Tras cambiar `main.js` o `preload.js` hay que reiniciar. Para `src/*.js`: `npm run build` y Ctrl+R. Para `index.html` basta Ctrl+R.
- Prueba manual de un evento:
  `curl -X POST http://127.0.0.1:4577/event -H "Content-Type: application/json" -d "{\"state\":\"waiting\",\"text\":\"Hola\"}"`

## Arquitectura

Claude Code (hooks con curl) → POST http://127.0.0.1:4577/event → server.js → main.js → IPC → src/renderer.js → src/avatar.js

- `server.js`: servidor HTTP local. Escucha SOLO en 127.0.0.1:4577. Node puro, sin Electron.
- `main.js`: ventana transparente, sin marco, siempre visible, abajo a la derecha (300x440). Reenvía cada evento al renderer por IPC (`hadita-event`) y la posición del cursor cada 66 ms (`hadita-cursor`). Usa `sandbox: false` para que el preload tenga `fs`.
- `preload.js`: expone `window.hadita.loadModel`, `onEvent`, `onCursor`, `focus`, `moveBy` y `quit`. `loadModel` lee `assets/hadita.vrm` con `fs` y lo devuelve como ArrayBuffer (nunca fetch a file://).
- `src/renderer.js`: estados por sesión, globo, aura, sonido, voz, clic y arrastre. Le habla al avatar solo por `mood` (`state`, `asleep`, `talking`), `hop()` y `lookAtCursor()`.
- `src/avatar.js`: todo lo 3D con `three` y `@pixiv/three-vrm`. Carga con `GLTFLoader.parseAsync` + `VRMLoaderPlugin`, encuadre, poses, alas y bucle a 30 fps.
- `index.html`: estructura y CSS. Carga `dist/renderer.js`. Tiene CSP: sin scripts inline; `img-src` y `connect-src` permiten `blob:` para las texturas del VRM.
- `assets/hadita.vrm`: mi avatar (VRM 1.0, hecho en VRoid).
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
- Aura (`drop-shadow` sobre el canvas): working azul, waiting ámbar, done verde, error rojo, idle sin aura. El globo siempre dice el estado en texto.
- Los avisos (campanita, saltito, voz) solo saltan cuando el estado de una sesión CAMBIA a waiting, done o error.
- Voz con `speechSynthesis` (voces de Windows, busca una en español). Botón ♪ silencia y se guarda en localStorage.

## Clic y arrastre

- Clic en la hadita: `main.js` ejecuta `code "<cwd>"` de la sesión mostrada (la más urgente) para traer su VS Code al frente. Sin `cwd` no hace nada.
- El arrastre es manual sobre el canvas (`pointermove` → IPC `hadita-move`). No volver a poner `-webkit-app-region: drag`: en Windows se come los clics.

## Avatar

- Canvas WebGL de 300x370 con `alpha: true` y fondo transparente; cámara encuadrada al cuerpo entero según la caja del modelo.
- Bucle limitado a 30 fps; `vrm.update(delta)` en cada cuadro (huesos, mirada, expresiones y física del pelo).
- El modelo viene en pose T: los brazos se bajan con `leftUpperArm.z = -1.1` y `rightUpperArm.z = +1.1` (huesos normalizados).
- Vida básica: respiración, flotar, parpadeo aleatorio cada 2 a 6 s (`blink`) y mirada al cursor con `vrm.lookAt` más un giro leve del cuello.
- Poses por estado en `POSES`: idle `relaxed` y balanceo lento; working `neutral`, cabeza inclinada y balanceo rápido; waiting `surprised` y saluda con el brazo derecho; done `happy`; error `sad`. Los cambios se suavizan.
- Saltito (`hop()`): dos saltos al saltar un aviso (waiting, done o error).
- Dormida tras 5 min en idle (`SLEEP_MS`): ojos cerrados, cabeza caída y alas lentas.
- Voz: mientras habla `speechSynthesis`, la expresión `aa` oscila entre 0 y 1; vuelve a 0 al terminar.
- Alas: dos planos lilas translúcidos (`makeWing`) colgados del hueso `chest`; aletean más rápido en working.

## Reglas

- No tocar `~/.claude/settings.json` sin preguntarme. Ahí cada hook manda a dos destinos: mi oficina pixel (localhost:3777) y la hadita (127.0.0.1:4577). La oficina es otro proyecto y no se rompe.
- Usar siempre `127.0.0.1`, no `localhost`, para la hadita.
- Nunca bloquear a Claude Code: los hooks deben fallar en silencio si la hadita está cerrada.
- Mantenerlo simple: sin TypeScript y sin dependencias nuevas, salvo que yo lo pida. Las únicas son `three`, `@pixiv/three-vrm` y `esbuild`.
- Textos de la interfaz y comentarios en español.

## Pendientes

1. Arrancar sola con Windows.
2. Resumen con IA de lo que hizo el agente al terminar.
3. Que me escuche (voz de entrada). Paso grande, al final.
