// Optional desktop wrapper: `npm run desktop` (needs `npm i -D electron` first).
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
function createWindow(file) {
  const win = new BrowserWindow({ width: 1400, height: 900, title: 'Master PDF Editor', icon: path.join(__dirname, 'icon.svg'), webPreferences: { contextIsolation: true, sandbox: true } });
  Menu.setApplicationMenu(null); // the app draws its own menu bar
  const q = file ? '?open=' + encodeURIComponent('file://' + path.resolve(file)) : '';
  win.loadFile(path.join(__dirname, 'index.html'), { search: q });
}
app.whenReady().then(() => { createWindow(process.argv.find(a => /\.pdf$/i.test(a))); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
