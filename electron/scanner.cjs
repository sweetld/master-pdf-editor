// Scanner access: SANE (scanimage) on Linux and macOS, WIA via PowerShell on Windows.
const { spawn, execFile } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => res({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })));
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
async function list() {
  if (process.platform === 'win32') {
    const r = await ps(`$dm = New-Object -ComObject WIA.DeviceManager; foreach ($d in $dm.DeviceInfos) { if ($d.Type -eq 1) { Write-Output ($d.DeviceID + '|' + $d.Properties.Item('Name').Value) } }`);
    if (r.err) return { devices: [], error: 'Windows Image Acquisition is not available: ' + (r.stderr || r.err.message) };
    return { devices: r.stdout.split(/\r?\n/).filter(Boolean).map(l => { const [id, name] = l.split('|'); return { id, name: name || id }; }) };
  }
  const r = await run('scanimage', ['-L']);
  if (r.err) return { devices: [], error: process.platform === 'darwin' ? 'SANE is not installed. Install it with Homebrew (brew install sane-backends) to scan directly, or scan with Image Capture and use File → New → From Files.' : 'SANE (scanimage) is not installed or no scanner was found: ' + (r.stderr || r.err.message) };
  const devices = []; for (const m of r.stdout.matchAll(/device `([^']+)' is a (.+)/g)) devices.push({ id: m[1], name: m[2].trim() });
  return { devices };
}
async function scan({ device, resolution = 200, mode = 'Color' }) {
  const out = path.join(os.tmpdir(), `mpe-scan-${Date.now()}.png`);
  if (process.platform === 'win32') {
    const intent = mode === 'Color' ? 1 : mode === 'Gray' ? 2 : 4;
    const r = await ps(`$dm = New-Object -ComObject WIA.DeviceManager; $info = $dm.DeviceInfos | Where-Object { $_.DeviceID -eq '${device.replace(/'/g, "''")}' }; if (-not $info) { throw 'Scanner not found' }; $dev = $info.Connect(); $item = $dev.Items.Item(1); foreach ($p in $item.Properties) { if ($p.PropertyID -eq 6146) { $p.Value = ${intent} } elseif ($p.PropertyID -eq 6147 -or $p.PropertyID -eq 6148) { try { $p.Value = ${resolution | 0} } catch {} } }; $img = $item.Transfer('{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'); $img.SaveFile('${out.replace(/'/g, "''")}')`);
    if (r.err) return { error: 'Scan failed: ' + (r.stderr || r.err.message) };
  } else {
    const r = await new Promise((res) => { const p = spawn('scanimage', ['-d', device, '--format=png', '--resolution', String(resolution | 0), '--mode', mode]); const chunks = []; let err = ''; p.stdout.on('data', c => chunks.push(c)); p.stderr.on('data', c => err += c); p.on('error', e => res({ err: e.message })); p.on('close', code => res(code === 0 ? { data: Buffer.concat(chunks) } : { err: err || ('scanimage exited with ' + code) })); });
    if (r.err) return { error: 'Scan failed: ' + r.err }; return { data: r.data, resolution };
  }
  try { const data = fs.readFileSync(out); fs.unlinkSync(out); return { data, resolution }; } catch (e) { return { error: 'Scan produced no image: ' + e.message }; }
}
module.exports = { list, scan };
