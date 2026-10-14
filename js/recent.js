// Recent files: names plus File System Access handles, kept in IndexedDB so files can be reopened.
const DB = 'mpe-recent', STORE = 'files';
function open() { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'name' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function tx(mode, fn) { try { const db = await open(); return await new Promise((res, rej) => { const t = db.transaction(STORE, mode); const s = t.objectStore(STORE); const out = fn(s); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); }); } catch (e) { console.warn('recent db', e); return null; } }
export const recentDb = {
  async list() { const r = await tx('readonly', s => s.getAll()); return (r || []).sort((a, b) => b.time - a.time); },
  async add(f, max = 10) { await tx('readwrite', s => { s.put({ name: f.name, handle: f.handle || null, time: f.time || Date.now() }); }); const all = await this.list(); for (const old of all.slice(max)) await tx('readwrite', s => { s.delete(old.name); }); },
  async clear() { await tx('readwrite', s => { s.clear(); }); },
};
