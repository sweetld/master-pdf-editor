import { App } from './app.js';
import { platform } from './platform.js';
import { runSmoke } from './smoke.js';
import { installAgent } from './agent.js';
window.addEventListener('DOMContentLoaded', async () => {
  await platform.init();
  const app = new App(); window.mpe = app; installAgent(app); await app.loadRecent();
  platform.onOpenFiles(files => app.openPaths(files));
  platform.onRequestClose(async () => { for (const d of app.docs.slice()) { if (!(await app.closeDoc(d))) return; } platform.allowClose(); });
  const pending = await platform.pendingFiles(); if (pending.length) await app.openPaths(pending);
  const params = new URLSearchParams(location.search); const open = params.get('open'); if (open) { try { const r = await fetch(open); if (r.ok) await app.openBytes(new Uint8Array(await r.arrayBuffer()), decodeURIComponent(open.split('/').pop() || 'document.pdf')); } catch (e) { console.warn(e); } }
  if ('launchQueue' in window && !platform.isDesktop) window.launchQueue.setConsumer(async (p) => { for (const h of p.files || []) { const f = await h.getFile(); await app.openFiles([f], h); } });
  if (params.get('smoke')) runSmoke(app);
});
