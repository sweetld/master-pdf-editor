// Desktop (Electron) vs browser platform abstraction. Everything here degrades to browser behaviour when window.native is absent.
import { download, readFileBytes, pickFiles, store, $ } from './util.js';
const N = window.native || null;
export const platform = {
  isDesktop: !!N, os: N ? N.platform : 'web', info: null,
  async init() { if (N) { this.info = await N.info(); } },
  async openFiles({ multiple = true } = {}) { if (N) { const paths = await N.openFiles({ multiple }); const out = []; for (const p of paths) out.push({ name: p.split(/[\\/]/).pop(), path: p, bytes: await N.readFile(p) }); return out; } const files = await pickFiles($('#file-input'), { multiple }); return Promise.all(files.map(async f => ({ name: f.name, file: f, bytes: await readFileBytes(f) }))); },
  async readPath(p) { return N ? N.readFile(p) : null; },
  async saveAs(defaultName) { if (N) { const p = await N.saveDialog({ defaultPath: defaultName }); return p; } return null; },
  async write(path, bytes, { backup = false } = {}) { if (N && path) { await N.writeFile(path, bytes, backup); return true; } download(bytes, path || 'document.pdf', 'application/pdf'); return false; },
  async exportFile(name, data, mime) { if (N) { const p = await N.saveDialog({ defaultPath: name, filters: [{ name: 'File', extensions: [name.split('.').pop()] }] }); if (!p) return null; const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : typeof data === 'string' ? new TextEncoder().encode(data) : data; await N.writeFile(p, bytes); return p; } download(data, name, mime); return name; },
  async pickFolder() { return N ? N.pickFolder() : null; },
  openExternal(url) { if (N) N.openExternal(url); else window.open(url, '_blank', 'noopener'); },
  showInFolder(p) { if (N) N.showInFolder(p); },
  setTitle(t) { if (N) N.setTitle(t); document.title = t; },
  quit() { if (N) N.quit(); else window.close(); },
  allowClose() { if (N) N.allowClose(); },
  fullscreen(on) { if (N) return N.fullscreen(on); },
  async copyImage(dataUrl) { if (N) return N.copyImage(dataUrl); const blob = await (await fetch(dataUrl)).blob(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); },
  async email(o) { if (N) return N.email(o); window.location.href = `mailto:${encodeURIComponent(o.to || '')}?subject=${encodeURIComponent(o.subject || '')}&body=${encodeURIComponent(o.body || '')}`; return { ok: true, method: 'mailto', attached: false }; },
  scanner: { list: () => N ? N.scanner.list() : Promise.resolve({ devices: [], error: 'Scanning needs the desktop application.' }), scan: (o) => N ? N.scanner.scan(o) : Promise.resolve({ error: 'Scanning needs the desktop application.' }) },
  sign: N ? N.sign : null,
  recent: { list: () => store.get('recentPaths', []), add(entry, max = 10) { const l = this.list().filter(x => x.path !== entry.path); l.unshift({ name: entry.name, path: entry.path, time: Date.now() }); store.set('recentPaths', l.slice(0, max)); }, clear() { store.set('recentPaths', []); } },
  onOpenFiles(cb) { if (N) N.onOpenFiles(cb); }, onRequestClose(cb) { if (N) N.onRequestClose(cb); }, pendingFiles: () => N ? N.pendingFiles() : Promise.resolve([]),
};
