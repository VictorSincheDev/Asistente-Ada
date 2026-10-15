// Dónde está cada cosa. Node puro, sin Electron.
// - APP: los archivos del programa. Dentro del .exe son de solo lectura.
// - DATOS: lo que la hadita escribe o yo edito a mano (%APPDATA%/hadita). main.js lo fija en
//   HADITA_DIR con app.getPath('userData') antes de cargar los demás módulos.
const fs = require('fs');
const path = require('path');

const APP = __dirname;
const DATOS = process.env.HADITA_DIR || path.join(APP, 'datos-locales');

// Archivo para editar a mano: la primera vez se copia el que trae el programa
function editable(nombre) {
  const destino = path.join(DATOS, nombre);
  if (!fs.existsSync(destino)) {
    try {
      fs.mkdirSync(DATOS, { recursive: true });
      fs.writeFileSync(destino, fs.readFileSync(path.join(APP, nombre))); // copyFile no lee del .asar en todas las versiones
    } catch (e) {
      console.error(`No pude preparar ${nombre}:`, e.message);
    }
  }
  return destino;
}

// Antes todo se guardaba junto al código: si quedó algo ahí (corriendo desde el código fuente),
// se mueve una sola vez a DATOS para no volver a descargar Whisper ni perder la caché y el registro.
function migrar() {
  for (const carpeta of ['voz', 'modelos', 'datos']) {
    const viejo = path.join(APP, carpeta), nuevo = path.join(DATOS, carpeta);
    if (!fs.existsSync(viejo) || fs.existsSync(nuevo)) continue;
    try {
      fs.mkdirSync(DATOS, { recursive: true });
      fs.renameSync(viejo, nuevo);
    } catch (e) {
      console.error(`No pude mover ${carpeta}/ a ${DATOS}:`, e.message);
    }
  }
}

module.exports = { APP, DATOS, editable, migrar };
