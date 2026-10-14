// Electron main process: serves the app over app://, owns native file access, printing, scanner, email and signing.
const { app, BrowserWindow, protocol, ipcMain, dialog, shell, net, Menu, clipboard, nativeImage } = require('electron');
const path = require('path'); const fs = require('fs'); const fsp = require('fs/promises');
const scanner = require('./scanner.cjs'); const email = require('./email.cjs'); const signer = require('./sign.cjs');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.pdf': 'application/pdf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.map': 'application/json' };
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const pendingFiles = []; let mainWindow = null;
const argFiles = (argv) => argv.slice(1).filter(a => !a.startsWith('-') && /\.(pdf|fdf|xfdf|png|jpe?g|bmp|gif|webp|txt)$/i.test(a) && fs.existsSync(a)).map(a => path.resolve(a));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => { const files = argFiles(argv); if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); if (files.length) mainWindow.webContents.send('open-files', files); } else pendingFiles.push(...files); });
app.on('open-file', (e, p) => { e.preventDefault(); if (mainWindow) mainWindow.webContents.send('open-files', [p]); else pendingFiles.push(p); });
function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 900, minHeight: 600, title: 'Master PDF Editor', icon: path.join(ROOT, 'icon.png'), backgroundColor: '#efefef', show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false, nodeIntegration: false, spellcheck: true } });
  Menu.setApplicationMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.on('close', (e) => { if (mainWindow._allowClose) return; e.preventDefault(); mainWindow.webContents.send('request-close'); });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL('app://-/index.html' + (process.argv.includes('--smoke') ? '?smoke=1' : ''));
  if (process.argv.includes('--devtools')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  const shot = process.argv.find(a => a.startsWith('--screenshot=')); if (shot) { mainWindow.setSize(1400, 900); mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => { try { const img = await mainWindow.webContents.capturePage(); fs.writeFileSync(shot.slice(13), img.toPNG()); process.stdout.write('screenshot written\n'); } catch (e) { process.stdout.write('screenshot failed ' + e + '\n'); } app.exit(0); }, 4000)); }
  if (process.argv.includes('--smoke')) { mainWindow.webContents.on('console-message', function (e, a, b) { const msg = String(e && e.message !== undefined ? e.message : (typeof a === 'object' && a ? a.message : b)); const level = e && e.level !== undefined ? e.level : (typeof a === 'object' && a ? a.level : a); if (msg.startsWith('SMOKE-RESULT')) process.stdout.write(msg + '\n'); else if (level === 'error' || level >= 2 || /error/i.test(msg)) process.stdout.write('[renderer] ' + msg + '\n'); }); setTimeout(() => { process.stdout.write('SMOKE-TIMEOUT\n'); app.exit(2); }, 90000); }
}
app.whenReady().then(() => {
  protocol.handle('app', async (req) => { const u = new URL(req.url); let p = decodeURIComponent(u.pathname); if (p === '/' || p === '') p = '/index.html'; const file = path.normalize(path.join(ROOT, p)); if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 }); try { const data = await fsp.readFile(file); return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' } }); } catch { return new Response('not found', { status: 404 }); } });
  pendingFiles.push(...argFiles(process.argv)); createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
// ---------- IPC ----------
const certsDir = () => { const d = path.join(app.getPath('userData'), 'certs'); fs.mkdirSync(d, { recursive: true }); return d; };
const handlers = {
  info: () => ({ platform: process.platform, version: app.getVersion(), electron: process.versions.electron, userData: app.getPath('userData'), certs: certsDir(), documents: app.getPath('documents') }),
  pendingFiles: () => pendingFiles.splice(0),
  openFiles: async ({ multiple = true, filters } = {}) => { const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile', ...(multiple ? ['multiSelections'] : [])], filters: filters || [{ name: 'PDF and data files', extensions: ['pdf', 'fdf', 'xfdf', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'txt'] }, { name: 'PDF', extensions: ['pdf'] }, { name: 'All files', extensions: ['*'] }] }); return r.canceled ? [] : r.filePaths; },
  saveDialog: async ({ defaultPath, filters } = {}) => { const r = await dialog.showSaveDialog(mainWindow, { defaultPath, filters: filters || [{ name: 'PDF', extensions: ['pdf'] }] }); return r.canceled ? null : r.filePath; },
  pickFolder: async () => { const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; },
  readFile: async ({ path: p }) => fsp.readFile(p),
  writeFile: async ({ path: p, data, backup = false }) => { if (backup && fs.existsSync(p)) await fsp.copyFile(p, p + '.bak'); const tmp = p + '.tmp-' + process.pid; await fsp.writeFile(tmp, Buffer.from(data)); await fsp.rename(tmp, p); return true; },
  fileInfo: async ({ path: p }) => { try { const s = await fsp.stat(p); return { exists: true, size: s.size, mtime: s.mtimeMs }; } catch { return { exists: false }; } },
  showInFolder: ({ path: p }) => { shell.showItemInFolder(p); return true; },
  openExternal: ({ url }) => shell.openExternal(url),
  openPath: ({ path: p }) => shell.openPath(p),
  setTitle: ({ title }) => { mainWindow?.setTitle(title); return true; },
  quit: () => { if (mainWindow) { mainWindow._allowClose = true; mainWindow.destroy(); } app.quit(); setTimeout(() => app.exit(0), 1500); return true; },
  allowClose: () => { if (mainWindow) { mainWindow._allowClose = true; mainWindow.close(); } return true; },
  fullscreen: ({ on }) => { mainWindow?.setFullScreen(!!on); return mainWindow?.isFullScreen(); },
  copyImage: ({ dataUrl }) => { clipboard.writeImage(nativeImage.createFromDataURL(dataUrl)); return true; },
  print: async ({ silent = false, copies = 1, landscape = false } = {}) => new Promise((res) => { mainWindow.webContents.print({ silent, printBackground: true, copies, landscape }, (ok, reason) => res({ ok, reason })); }),
  printToPdf: async ({ landscape = false } = {}) => { const data = await mainWindow.webContents.printToPDF({ landscape, printBackground: true }); return data; },
  email: (args) => email.send(args),
  scannerList: () => scanner.list(),
  scannerScan: (args) => scanner.scan(args),
  signListIds: () => signer.listIds(certsDir()),
  signCreateId: (args) => signer.createId(certsDir(), args),
  signImportId: async ({ path: p }) => { const dest = path.join(certsDir(), path.basename(p)); await fsp.copyFile(p, dest); return dest; },
  signRemoveId: async ({ path: p }) => { if (path.dirname(p) === certsDir()) await fsp.unlink(p); return true; },
  signInspect: (args) => signer.inspectId(args),
  signPdf: (args) => signer.signPdf(args),
  verifyPdf: (args) => signer.verifyPdf(args),
  tempPath: ({ name }) => path.join(app.getPath('temp'), name),
};
ipcMain.handle('native', async (_e, method, args) => { const h = handlers[method]; if (!h) throw new Error('Unknown native method ' + method); return h(args || {}); });
