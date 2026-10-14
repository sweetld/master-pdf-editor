const { contextBridge, ipcRenderer, webUtils } = require('electron');
const call = (method, args) => ipcRenderer.invoke('native', method, args);
contextBridge.exposeInMainWorld('native', {
  isDesktop: true, platform: process.platform,
  info: () => call('info'), pendingFiles: () => call('pendingFiles'),
  openFiles: (o) => call('openFiles', o), saveDialog: (o) => call('saveDialog', o), pickFolder: () => call('pickFolder'),
  readFile: async (p) => new Uint8Array(await call('readFile', { path: p })), writeFile: (p, data, backup) => call('writeFile', { path: p, data, backup }), fileInfo: (p) => call('fileInfo', { path: p }),
  showInFolder: (p) => call('showInFolder', { path: p }), openExternal: (url) => call('openExternal', { url }), openPath: (p) => call('openPath', { path: p }), setTitle: (title) => call('setTitle', { title }),
  quit: () => call('quit'), allowClose: () => call('allowClose'), fullscreen: (on) => call('fullscreen', { on }), copyImage: (dataUrl) => call('copyImage', { dataUrl }),
  print: (o) => call('print', o), printToPdf: (o) => call('printToPdf', o), email: (o) => call('email', o),
  scanner: { list: () => call('scannerList'), scan: async (o) => { const r = await call('scannerScan', o); if (r?.data) r.data = new Uint8Array(r.data); return r; } },
  sign: { listIds: () => call('signListIds'), createId: (o) => call('signCreateId', o), importId: (p) => call('signImportId', { path: p }), removeId: (p) => call('signRemoveId', { path: p }), inspect: (o) => call('signInspect', o), sign: async (o) => new Uint8Array(await call('signPdf', o)), verify: (o) => call('verifyPdf', o) },
  tempPath: (name) => call('tempPath', { name }), pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return null; } },
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)), onRequestClose: (cb) => ipcRenderer.on('request-close', () => cb()),
});
