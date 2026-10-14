// Ícono de la bandeja: la hadita pixel art original (16x16), dibujada a 32x32 sin archivos.
const { nativeImage } = require('electron');

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
const PALETTE = { H: '#2fb8a6', S: '#ffd9b8', E: '#2a2540', D: '#f4f1ff', W: '#8f7cf0', w: '#d6cdff', B: '#6a5acd' };

function crearIcono() {
  const lado = 32, escala = 2;
  const bgra = Buffer.alloc(lado * lado * 4); // transparente
  SPRITE.forEach((fila, y) => [...fila].forEach((ch, x) => {
    if (ch === '.') return;
    const hex = PALETTE[ch];
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    for (let dy = 0; dy < escala; dy++) {
      for (let dx = 0; dx < escala; dx++) {
        const i = ((y * escala + dy) * lado + x * escala + dx) * 4;
        bgra[i] = b; bgra[i + 1] = g; bgra[i + 2] = r; bgra[i + 3] = 255;
      }
    }
  }));
  return nativeImage.createFromBitmap(bgra, { width: lado, height: lado, scaleFactor: 2 });
}

module.exports = { crearIcono };
