import { App } from './app.js';
window.addEventListener('DOMContentLoaded', async () => {
  const app = new App(); window.mpe = app; await app.loadRecent();
  const params = new URLSearchParams(location.search); const open = params.get('open'); if (open) { try { const r = await fetch(open); if (r.ok) await app.openBytes(new Uint8Array(await r.arrayBuffer()), decodeURIComponent(open.split('/').pop() || 'document.pdf')); } catch (e) { console.warn(e); } }
  if ('launchQueue' in window) window.launchQueue.setConsumer(async (p) => { for (const h of p.files || []) { const f = await h.getFile(); await app.openFiles([f], h); } });
});
