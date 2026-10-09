# Hadita

Hadita 3D (avatar VRM) de escritorio que reacciona a tus sesiones de Claude Code.

## Arrancar

```
npm install
npm start
```

`npm start` empaqueta el renderer con esbuild y abre la ventana. Aparece abajo a la derecha, siempre visible. Se arrastra desde el avatar y se cierra con la ×.

## Conectar con Claude Code

Copia el bloque `hooks` de `hooks/settings-ejemplo.json` a tu `~/.claude/settings.json`
(si ya tienes hooks, fusiónalos) y cambia `C:/RUTA/A/hadita` por la ruta real.

## Estados

| Estado   | Cuándo                                  | Aura     |
|----------|-----------------------------------------|----------|
| working  | enviaste un prompt / usa herramientas   | azul     |
| waiting  | Claude espera tu aprobación o respuesta | ámbar    |
| done     | terminó (se apaga a los 8 s)            | verde    |
| idle     | nada pasando                            | ninguna  |

Con varias sesiones abiertas muestra la más urgente: waiting > working > done.

## Probar sin Claude Code

```
curl -X POST http://127.0.0.1:4577/event -H "Content-Type: application/json" -d "{\"state\":\"waiting\",\"text\":\"Hola\"}"
```

Ese mismo formato (`state` + `text`) sirve para mandarle eventos desde la oficina pixel.

## Cambiar el personaje

Reemplaza `assets/hadita.vrm` por otro avatar VRM 1.0. Las poses por estado están en `POSES`, al inicio de `src/avatar.js`.
