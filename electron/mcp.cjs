// The MCP server: `master-pdf-editor --mcp` (or `npm run mcp`) speaks MCP (JSON-RPC 2.0) on
// stdin/stdout. Tool calls are forwarded over a private local socket to the running Master PDF
// Editor window (electron/mcp-host.cjs -> js/agent.js), starting the app first if it isn't running.
// Plain Node: no Electron APIs, so it also runs with `node electron/mcp.cjs`.
const net = require('net'); const { spawn } = require('child_process'); const path = require('path');
const { tools, INSTRUCTIONS } = require('./mcp-tools.cjs');
const { socketPath } = require('./mcp-host.cjs');

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = (() => { try { return require('../package.json').version; } catch { return '0.0.0'; } })();

/** `launch()` starts the desktop app (detached); see electron/main.cjs. */
function run({ launch = defaultLaunch } = {}) {
  console.log = console.info = console.warn = (...a) => process.stderr.write(a.join(' ') + '\n'); // stdout is the protocol
  let conn = null, connecting = null, nextId = 1, launched = false; const pending = new Map();

  function connectOnce() {
    return new Promise((resolve, reject) => {
      const c = net.connect(socketPath()); let buf = '';
      c.setEncoding('utf8');
      c.once('connect', () => resolve(c));
      c.once('error', reject);
      c.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let msg; try { msg = JSON.parse(line); } catch { continue; } const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result); } } });
      c.on('close', () => { if (conn === c) conn = null; for (const [id, p] of pending) if (p.conn === c) { pending.delete(id); p.reject(new Error('Master PDF Editor was closed while the call was running. Call open_pdf again.')); } });
    });
  }
  async function connect() {
    if (conn && !conn.destroyed) return conn;
    if (connecting) return connecting;
    connecting = (async () => {
      try { conn = await connectOnce(); return conn; } catch { }
      if (!launched || Date.now() - launched > 60000) { launched = Date.now(); launch(); }
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) { await new Promise(r => setTimeout(r, 300)); try { conn = await connectOnce(); return conn; } catch { } }
      throw new Error('Could not start Master PDF Editor (no answer on its MCP socket after 60 s).');
    })().finally(() => { connecting = null; });
    return connecting;
  }
  async function request(msg) {
    const c = await connect(); const id = nextId++;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, conn: c }); c.write(JSON.stringify({ id, ...msg }) + '\n'); });
  }

  const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
  const listed = tools.map(({ group, ...t }) => t);
  async function onMessage(msg) {
    const { id, method, params } = msg; const isReq = id !== undefined && id !== null;
    try {
      let result;
      if (method === 'initialize') { const v = params?.protocolVersion; result = { protocolVersion: PROTOCOLS.includes(v) ? v : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'master-pdf-editor', title: 'Master PDF Editor', version: VERSION }, instructions: INSTRUCTIONS }; }
      else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = { tools: listed };
      else if (method === 'tools/call') {
        const name = params?.name; if (!listed.some(t => t.name === name)) result = { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
        else { try { result = await request({ tool: name, args: params.arguments || {} }); } catch (e) { result = { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] }; } }
      }
      else if (method === 'resources/list') result = { resources: [] };
      else if (method === 'prompts/list') result = { prompts: [] };
      else if (method?.startsWith('notifications/')) return;
      else { if (isReq) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }); return; }
      if (isReq) send({ jsonrpc: '2.0', id, result });
    } catch (e) { if (isReq) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } }); }
  }

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; let msg; try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; } for (const m of Array.isArray(msg) ? msg : [msg]) onMessage(m); } });
  process.stdin.on('end', () => process.exit(0));
}

/** Starts the app: the app's own binary when it runs this file as Node (ELECTRON_RUN_AS_NODE, see
 * master-pdf-editor-mcp), else the local Electron of a source checkout. */
function defaultLaunch() {
  const root = path.join(__dirname, '..'); const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  if (process.versions.electron) { spawn(process.execPath, /app\.asar/.test(__dirname) ? [] : [root], { detached: true, stdio: 'ignore', env }).unref(); return; }
  let electron; try { electron = require(path.join(root, 'node_modules', 'electron')); } catch { throw new Error('Electron is not installed here; run the installed app with --mcp instead.'); }
  spawn(electron, [root], { detached: true, stdio: 'ignore', env }).unref();
}

module.exports = { run };
if (require.main === module) run();
