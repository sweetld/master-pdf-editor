// Runs in the app's main process: a private local socket that the MCP bridge (mcp.cjs) connects to.
// Each line is a JSON request { id, tool, args }; the call is executed by js/agent.js in the window
// and the reply { id, result } or { id, error } is written back as one line.
const net = require('net'); const fs = require('fs'); const os = require('os'); const path = require('path');

/** Per-user socket path shared by the app and the bridge (a named pipe on Windows). */
function socketPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\master-pdf-editor-mcp-${os.userInfo().username}`;
  const dir = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
  return path.join(dir, `master-pdf-editor-mcp-${process.getuid ? process.getuid() : 'user'}.sock`);
}

function start(getWindow) {
  const sock = socketPath();
  const server = net.createServer(conn => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(line, conn); } });
    conn.on('error', () => { });
  });
  async function handle(line, conn) {
    let req; try { req = JSON.parse(line); } catch { return; }
    const reply = msg => { if (!conn.destroyed) conn.write(JSON.stringify({ id: req.id, ...msg }) + '\n'); };
    try {
      if (req.op === 'ping') return reply({ result: { pong: true, pid: process.pid } });
      const win = await readyWindow(getWindow);
      if (req.op === 'focus') { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return reply({ result: true }); }
      const result = await win.webContents.executeJavaScript(`window.mpeAgent.call(${JSON.stringify(String(req.tool))}, ${JSON.stringify(req.args || {})})`, true);
      reply({ result });
    } catch (e) { reply({ error: String(e?.message || e) }); }
  }
  const listen = () => server.listen(sock, () => { if (process.platform !== 'win32') { try { fs.chmodSync(sock, 0o600); } catch { } } });
  server.on('error', e => {
    if (e.code !== 'EADDRINUSE' || process.platform === 'win32') { console.warn('MCP socket:', e.message); return; }
    // A socket file left by a previous run: remove it unless something is answering on it.
    const probe = net.connect(sock); probe.on('connect', () => { probe.destroy(); console.warn('MCP socket already in use by another instance'); });
    probe.on('error', () => { try { fs.unlinkSync(sock); } catch { } listen(); });
  });
  listen();
  const cleanup = () => { try { server.close(); if (process.platform !== 'win32') fs.unlinkSync(sock); } catch { } };
  process.on('exit', cleanup);
  return { server, sock, cleanup };
}

/** Waits until the window has loaded and js/agent.js is installed. */
async function readyWindow(getWindow, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) {
      try { if (await win.webContents.executeJavaScript('!!(window.mpeAgent && window.mpeAgent.ready)', true)) return win; } catch { }
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('Master PDF Editor did not become ready in time.');
    await new Promise(r => setTimeout(r, 150));
  }
}

module.exports = { start, socketPath };
