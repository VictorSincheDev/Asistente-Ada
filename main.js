const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { start } = require('./server');

// permite sonido y voz sin que hagas clic antes
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win;
const W = 240, H = 210;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: W,
    height: H,
    x: workArea.x + workArea.width - W - 16,
    y: workArea.y + workArea.height - H - 16,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  const server = start((evt) => {
    if (win && !win.isDestroyed()) win.webContents.send('hadita-event', evt);
  });
  server.on('error', (e) => {
    console.error('No pude abrir el puerto (¿ya hay otra hadita corriendo?):', e.message);
    app.quit();
  });
});

// Trae al frente la ventana de VS Code que tiene abierta esa carpeta
// (`code <carpeta>` reutiliza la ventana si ya existe; si no, la abre).
function focusVSCode(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return;
  const dir = path.resolve(cwd);
  // el cwd llega por HTTP: solo carpetas reales y sin comillas, porque va a una línea de cmd
  if (dir.includes('"')) return;
  try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
  // code es un .cmd en Windows, por eso necesita shell
  const child = spawn(`code "${dir}"`, { shell: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', (e) => console.error('No pude abrir VS Code:', e.message));
}

ipcMain.on('hadita-focus', (_e, cwd) => focusVSCode(cwd));
// arrastre manual: el sprite ya no usa -webkit-app-region porque se come los clics
ipcMain.on('hadita-move', (_e, dx, dy) => {
  if (!win || win.isDestroyed() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = win.getPosition();
  win.setBounds({ x: Math.round(x + dx), y: Math.round(y + dy), width: W, height: H });
});
ipcMain.on('hadita-quit', () => app.quit());
app.on('window-all-closed', () => app.quit());
