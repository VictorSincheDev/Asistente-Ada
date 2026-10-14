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
- `main.js`: ventana transparente, sin marco, siempre visible, abajo a la derecha o donde la dejé (300x500 en tamaño mediano; los 130 px de arriba son para el globo y la cajita). Crea el ícono de la bandeja y su menú. Reenvía cada evento al renderer por IPC (`hadita-event`) y la posición del cursor cada 66 ms (`hadita-cursor`). Usa `sandbox: false` para que el preload tenga `fs`. `setContentProtection(true)` la oculta al compartir pantalla; el atajo global Ctrl+Alt+H la oculta y la muestra.
- `config.js`: lee, valida y guarda `config.json`, y avisa de cada cambio. Node puro, sin Electron.
- `icono.js`: ícono de la bandeja, dibujado desde el sprite pixel art original.
- `voz.js`: voz neuronal con `msedge-tts` y caché en disco. Node puro, sin Electron.
- `charla.js`: conversación; ejecuta `claude -p`, guarda el historial y clasifica cada mensaje en charla o encargo. Node puro, sin Electron.
- `sesiones.js`: registro de sesiones de Claude Code vistas por los hooks. Node puro, sin Electron.
- `tareas.js` y `tareas.json`: encargos a Claude Code (lista blanca, confirmación, ejecución y log).
- `oido.js`: transcribe voz a texto en local con Whisper (`@huggingface/transformers`). Node puro, sin Electron.
- `src/oido.js`: captura del micrófono en el renderer (grabación, corte por silencio y conversión a mono 16 kHz).
- `frases.json`: frases de saludo, despedida y regreso, para editar a mano.
- `preload.js`: expone `window.hadita.loadModel`, `frases`, `decir`, `preguntar`, `confirmar`, `onTarea`, `transcribir`, `onEscuchar`, `onEvent`, `onCursor`, `focus`, `moveBy` y `quit`. `loadModel` lee `assets/hadita.vrm` con `fs` y lo devuelve como ArrayBuffer (nunca fetch a file://).
- `src/renderer.js`: estados por sesión, globo, aura, sonido, voz, clic y arrastre. Le habla al avatar solo por `mood` (`state`, `asleep`, `talking`, `greeting`, `mouthLevel`), `hop()` y `lookAtCursor()`.
- `src/avatar.js`: todo lo 3D con `three` y `@pixiv/three-vrm`. Carga con `GLTFLoader.parseAsync` + `VRMLoaderPlugin`, encuadre, clips de animación, poses por código, alas y bucle a 30 fps.
- `src/animacion.js`: carga clips `.vrma` y `.fbx` de Mixamo adaptados al VRM.
- `assets/anim/`: los clips de animación (los descargo yo; ver «Clips de animación»).
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
- Botón ♪ silencia campanita y voz (corta la frase que esté sonando). Al pasar el ratón sobre él se despliega la barrita de volumen (`#vol`): se aplica al moverla, suena una nota de muestra al soltarla y entonces se guarda. Silencio y volumen van a `config.json`.

## Voz

- Neuronal y gratuita: `voz.js` usa `msedge-tts` (servicio Read Aloud de Edge, necesita internet). Voz (`es-PE-CamilaNeural` por defecto), tono, velocidad y volumen vienen de `config.json`; al cambiar la voz se descarta la conexión y se vuelven a generar las frases fijas.
- Caché en `voz/` (fuera de git): un mp3 por frase, con nombre = sha1 de voz + tono + velocidad + texto. Si existe, no se vuelve a generar.
- Flujo: el renderer llama `window.hadita.decir(texto)` (IPC `hadita-decir`); main devuelve los bytes del mp3 y el renderer los reproduce con Web Audio, una frase a la vez.
- Respaldo: si falla o tarda más de 3 s, main devuelve `null` y el renderer usa `speechSynthesis`; la generación sigue en segundo plano y queda en caché.
- Conectar con el servicio tarda segundos y sintetizar medio segundo: se usa una sola conexión, abierta al arrancar. El servicio la cierra tras unos 30 s sin uso, así que `voz.calentar()` la reabre con cada evento de hook y con cada pregunta de la charla.
- Al arrancar se pregeneran «Terminé» y «Te necesito aquí».
- Las respuestas de la charla se dicen con la misma voz, pero no se guardan en la caché (`efimero`).

## Saludos

- Frases en `frases.json`, por clave: `manana` (antes de las 12), `tarde` (antes de las 19), `noche`, `despedida` y `regreso`. Se elige una al azar. Se leen al arrancar y se pregeneran todas en la caché de voz.
- Al arrancar saluda según la hora. Al cerrar con × se despide y sale al terminar la frase (5 s como mucho). Al llegar un evento tras 30 min sin ninguno (`AWAY_MS`) dice una de `regreso`.
- Cada saludo (`salute()` en `src/renderer.js`): expresión `happy`, brazo en alto, saltito y la frase en voz alta. Respeta el ♪.

## Charla

- Clic en la hadita abre la cajita `#ask` bajo el globo. Enter envía, Esc cierra.
- `charla.js` ejecuta `claude -p` con `execFile` (sin shell; el mensaje es un argumento aparte) y límite de 30 s. Corre en `%APPDATA%/hadita/charla`, una carpeta vacía fuera del proyecto.
- Sin permisos: `--tools ""` (ninguna herramienta), `--strict-mcp-config` (sin MCP), `--setting-sources project` y `disableAllHooks`, para que no dispare mis hooks ni se avise a sí misma. No quitar esos flags.
- El personaje va en `--system-prompt` (`PERSONAJE`) y el modelo es `MODELO` (`haiku`). Los últimos 6 intercambios se guardan en memoria y se envían como contexto.
- Mientras espera: globo «Pensando…» y pose `thinking` (`neutral`, cabeza inclinada). La respuesta se muestra en el globo y se dice en voz alta. Si falla o se pasa del tiempo: «Uy, no pude pensar eso. ¿Me lo repites?».

## Encargos a Claude Code

- Cada mensaje (escrito o hablado) pasa por una sola llamada a `claude -p` que conversa y clasifica a la vez (`--json-schema`): `conversar` o `tarea` con `proyecto`, `sesion` (`nueva`, `ultima` o un código `s1`, `s2`…) y `prompt`. El modelo recibe la lista de proyectos permitidos y los títulos de sus conversaciones; los códigos los valida `tareas.js`, así que no puede inventar sesiones.
- Registro de sesiones (`sesiones.js`): por cada `session_id` guarda `cwd`, proyecto, hora del último evento y título (primer prompt, a 60 caracteres, del hook UserPromptSubmit). Persiste en `datos/sesiones.json` (fuera de git).
- Lista blanca en `tareas.json`: `proyectos` es `{ "nombre": { "carpeta": "C:/ruta", "herramientas": [...] } }`. Si el proyecto no está, se niega y lo dice. Viene vacía: sin proyectos no ejecuta nada. Se relee en cada uso.
- Permisos: por defecto `Read, Glob, Grep, Edit, Write`, sin Bash. Se cambia en `herramientas` (global) o por proyecto. Van en `--tools` y `--allowedTools`, con `--permission-mode acceptEdits` y `--strict-mcp-config`.
- Confirmación obligatoria: «Voy a pedir «…» en proyecto, conversación título. ¿Confirmas?». Se responde con los botones Sí/No, escribiendo o hablando; el sí y el no se deciden en el renderer con una expresión regular, sin modelo. Caduca a los 60 s. Main solo ejecuta lo que él mismo dejó preparado (`pendientes`).
- Ejecución: `execFile('claude', [...])` con los argumentos como array y `cwd` en la carpeta del proyecto; `--resume <id>` para una conversación concreta, `--continue` para la última. Límite de 15 min (`limiteMinutos`). Una tarea a la vez por proyecto.
- Estas sesiones sí disparan mis hooks, así que la hadita muestra «Trabajando» y «¡Listo!» como con cualquier otra.
- Al terminar, `charla.resumir()` cuenta el resultado en una o dos frases y la hadita lo dice (IPC `hadita-tarea`).
- Log en `datos/tareas.log`: fecha, proyecto, conversación y prompt, una línea por tarea enviada.

## Entrada por voz

- Atajo global Ctrl+Alt+Espacio: empieza a escuchar; si ya escucha, corta y envía. Es alternar porque `globalShortcut` no avisa al soltar la tecla.
- Captura en el renderer con `getUserMedia` y `MediaRecorder` (`src/oido.js`). Se corta sola tras 1,5 s de silencio (`AnalyserNode`, umbral `UMBRAL`), a los 6 s si no se oyó nada, o a los 20 s como máximo.
- El audio se convierte a Float32 mono 16 kHz y viaja por IPC (`hadita-transcribir`). `oido.js` lo transcribe con Whisper small (`Xenova/whisper-small`, `q8`, español), cargado una vez al arrancar. El modelo se descarga en `modelos/` (unos 240 MB, fuera de git).
- Cada transcripción tarda unos 6 s en mi PC (i7-8700); es el paso más lento del turno de voz.
- Si no hubo voz, o el texto sale vacío o es ruido (`limpiar()` descarta etiquetas y frases que Whisper inventa), no se envía nada y dice «No te escuché bien».
- El texto se muestra un momento en el globo («Tú: …») y entra al mismo flujo de la charla (`askHadita`).
- Estado `listening`: aura rosa, expresión atenta e inclinada hacia delante; globo «Te escucho…». Luego `thinking`.
- Mientras el micrófono está abierto no habla ni suena la campanita (la voz espera en cola); si estaba hablando al pulsar el atajo, se calla.
- Indicador rojo «● Micrófono abierto» (`#mic`) visible mientras dura la captura.
- Permisos: `session.setPermissionRequestHandler` en `main.js` solo concede `media` de audio.

## Configuración

- `config.json` en la carpeta de datos de la app (`%APPDATA%/hadita`), creado con valores por defecto: `voz`, `tono`, `velocidad`, `volumen` (0 a 1), `tamano` (chico, mediano o grande), `posicion` y `silencio`, más un bloque por función futura (`pomodoro`, `git`, `resumen`, `uso`), aún sin usar.
- Se aplica sin reiniciar: main vigila el archivo (`fs.watchFile`), lo valida campo a campo y manda la configuración al renderer (IPC `hadita-config`). Un JSON a medio editar se ignora.
- Tamaño: zoom de la ventana (`setZoomFactor` 0.8 / 1 / 1.25) y ventana escalada; al cambiarlo, la esquina inferior derecha queda fija y el avatar ajusta su resolución (`resize()`).
- Posición: se guarda al soltar el arrastre y se restaura al arrancar si sigue cayendo en alguna pantalla.
- Ícono en la bandeja (clic: mostrar u ocultar) con menú: mostrar/ocultar, silenciar, tamaño, voz (voces en español del servicio, agrupadas por país), abrir configuración y salir. El botón ⚙ junto a la × abre el mismo menú.
- «Salir» del menú se despide igual que la ×.

## Paseo

- La hadita camina por el borde inferior de las pantallas, sobre la barra de tareas: main mueve la ventana (`pasear()`, `paso()` y `terminarPaseo()` en `main.js`) hacia un punto al azar de cualquier pantalla, a 150 px o más; al cambiar de pantalla ajusta la altura con suavidad.
- El renderer recibe la dirección (IPC `hadita-paseo`: 1, -1 o 0) y la pasa a `mood.walking`: suena el clip `caminar` y el modelo se pone de perfil hacia donde va. Sin clip, flota de lado.
- `caminar` se usa «en el sitio»: `enSitio()` quita el avance horizontal de las caderas, así sirve aunque el FBX se haya bajado sin «In Place». El paso se ajusta a la velocidad (`mood.walkSpeed`).
- Cuándo: sola cada `pasear.cadaMin` minutos (±50 %) si está en idle, despierta y sin nada pendiente; o desde el menú («Pasear ahora» / «Dejar de pasear»). «Pasear sola» lo activa o desactiva.
- Se detiene en cuanto hay un estado distinto de idle, una charla, al agarrarla para arrastrarla o al ocultarla. Donde termina, se queda, y esa posición se guarda.
- `config.json`, bloque `pasear`: `activo`, `cadaMin` y `velocidad` (px/s en tamaño mediano).

## Clic y arrastre

- Clic en la hadita (sin arrastrar): abre o cierra la cajita de la charla.
- Clic en el globo: `main.js` ejecuta `code "<cwd>"` de la sesión mostrada (la más urgente) para traer su VS Code al frente. Sin `cwd` no hace nada.
- El arrastre es manual sobre el canvas: el renderer avisa `inicio`, `mover` y `fin` (IPC `hadita-drag`) y main mueve la ventana con la posición real del cursor, así funciona con cualquier zoom. Al soltar se guarda la posición. No volver a poner `-webkit-app-region: drag`: en Windows se come los clics.

## Avatar

- Canvas WebGL de 300x370 con `alpha: true` y fondo transparente; cámara encuadrada de cuerpo entero, con los pies (según la caja del modelo; para verla más grande, tamaño grande), con luz direccional de frente para que se vea la cara.
- Bucle limitado a 30 fps; `vrm.update(delta)` en cada cuadro (huesos, mirada, expresiones y física del pelo).
- El modelo viene en pose T: los brazos se bajan con `leftUpperArm.z = -ARM_DOWN` y `rightUpperArm.z = +ARM_DOWN` (1.32, huesos normalizados) y `ARM_FORWARD` los adelanta un poco para no atravesar el vestido.
- Vida básica: respiración, flotar, parpadeo aleatorio cada 2 a 6 s (`blink`) y mirada al cursor con `vrm.lookAt` más un giro leve del cuello.
- Poses por estado en `POSES`: idle `relaxed` y balanceo lento; working `neutral`, cabeza inclinada y balanceo rápido; waiting `surprised` y saluda con el brazo derecho; done `happy`; error `sad`. Los cambios se suavizan.
- Saltito (`hop()`): dos saltos al saltar un aviso (waiting, done o error).
- Dormida tras 5 min en idle (`SLEEP_MS`): ojos cerrados, cabeza caída y alas lentas.
- Boca: la expresión `aa` sigue el volumen real del audio (`AnalyserNode`, vía `mood.mouthLevel`); con `speechSynthesis` oscila entre 0 y 1. Vuelve a 0 al terminar.
- Alas: dos planos lilas translúcidos (`makeWing`) colgados del hueso `chest`; aletean más rápido en working.

## Clips de animación

- `src/animacion.js` convierte archivos de `assets/anim/` en clips para los huesos normalizados del VRM: `.vrma` con `@pixiv/three-vrm-animation` (solo huesos; expresiones y mirada siguen por código) y `.fbx` de Mixamo con `FBXLoader` y el adaptador del ejemplo oficial de three-vrm (mapa de huesos `mixamorig*` → VRM).
- Mapa estado → archivo en `config.json`, bloque `animaciones`: `idle`, `working`, `waiting`, `done`, `estirarse`, `pensar` (este para el estado `thinking`) y `caminar` (para el paseo). El valor es el nombre sin extensión; se busca `.vrma` y luego `.fbx`. Por defecto: `idle`, `teclear`, `saludar`, `celebrar`, `estirarse`, `pensar`, `caminar`. Si cambia el mapa, se recargan sin reiniciar; un archivo nuevo en la carpeta necesita Ctrl+R.
- Un `AnimationMixer` sobre `vrm.scene`, con crossfade de 0,3 s (`FUNDIDO`) entre clips. Al pasar a un estado sin clip, el clip se desvanece y la pose por código sigue desde ahí: cada hueso se acerca a su objetivo (`slerp`) y los que no tienen objetivo vuelven al reposo.
- Sin clip para el estado (o dormida, escuchando, error), todo sigue como antes, por código. Al saludar (`mood.greeting`) usa el clip de `waiting` si existe.
- `estirarse` se toca una sola vez: al despertar y, en idle, cada 4 a 8 min.
- Encima de cualquier clip siguen el parpadeo, las expresiones, la boca, la mirada al cursor (ojos con `vrm.lookAt` y un giro del cuello aplicado después del mixer), el flotar, el saltito y las alas.

## Reglas

- No tocar `~/.claude/settings.json` sin preguntarme. Ahí cada hook manda a dos destinos: mi oficina pixel (localhost:3777) y la hadita (127.0.0.1:4577). La oficina es otro proyecto y no se rompe.
- Usar siempre `127.0.0.1`, no `localhost`, para la hadita.
- Nunca bloquear a Claude Code: los hooks deben fallar en silencio si la hadita está cerrada.
- Mantenerlo simple: sin TypeScript y sin dependencias nuevas, salvo que yo lo pida. Las únicas son `three`, `@pixiv/three-vrm`, `@pixiv/three-vrm-animation`, `msedge-tts`, `@huggingface/transformers` y `esbuild`.
- Textos de la interfaz y comentarios en español.

## Pendientes

1. Arrancar sola con Windows.
2. Resumen con IA de lo que hizo el agente al terminar.
3. Que me escuche (voz de entrada). Paso grande, al final.
