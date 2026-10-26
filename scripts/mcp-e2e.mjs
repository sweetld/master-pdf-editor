// End-to-end test of the MCP server: starts `node electron/mcp.cjs` (which starts the app from this
// checkout when it isn't running), drives the tools over stdio like an MCP client, checks the saved
// file with pdf-lib and MuPDF, then quits the app it started. Usage: npm run test:mcp
// Renders are written to /tmp/mpe-mcp-*.png.
import { spawn } from 'child_process'; import { writeFileSync, readFileSync, existsSync, rmSync } from 'fs'; import net from 'net';
import { createRequire } from 'module'; import path from 'path'; import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url); const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib'); const { socketPath } = require('../electron/mcp-host.cjs');

const ROWS = ['Full name', 'Address', 'Postcode', 'Telephone', 'Email', 'Date of birth', 'Nationality', 'Occupation'];
async function buildPdf(file) {
  const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica), bold = await d.embedFont(StandardFonts.HelveticaBold); const H = 842;
  const p1 = d.addPage([595, H]); p1.drawText('Application form', { x: 72, y: H - 80, size: 18, font: bold });
  for (let y = 120; y < 540; y += 20) p1.drawText(`Introductory guidance line at ${y}`, { x: 72, y: H - y, size: 11, font });
  p1.drawText('Page 1', { x: 72, y: H - 810, size: 9, font });
  const p2 = d.addPage([595, H]); const top = 72, h = 40 + 36 * ROWS.length; const form = d.getForm();
  p2.drawRectangle({ x: 60, y: H - (top + h), width: 475, height: h, borderColor: rgb(0.2, 0.3, 0.6), borderWidth: 1.5 });
  p2.drawText('Section B: Applicant details', { x: 72, y: H - (top + 24), size: 13, font: bold });
  ROWS.forEach((label, i) => { const y = top + 64 + 36 * i; p2.drawText(label + ':', { x: 72, y: H - y, size: 11, font }); const tf = form.createTextField(label.toLowerCase().replace(/ /g, '_')); tf.addToPage(p2, { x: 200, y: H - (y + 4), width: 320, height: 18, font }); });
  p2.drawText('Section C follows the applicant box.', { x: 72, y: H - (top + h + 40), size: 11, font });
  p2.drawText('Page 2', { x: 72, y: H - 810, size: 9, font });
  writeFileSync(file, await d.save());
}

const results = []; let failed = 0;
const check = (name, cond, info = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); if (!cond) failed++; console.log(results.at(-1)); };

const wasRunning = await new Promise(res => { const c = net.connect(socketPath()); c.once('connect', () => { c.destroy(); res(true); }); c.once('error', () => res(false)); });
const srv = spawn(process.execPath, [path.join(ROOT, 'electron/mcp.cjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = ''; const waiting = new Map(); let nextId = 1;
srv.stdout.setEncoding('utf8'); srv.stdout.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } });
const rpc = (method, params) => new Promise(res => { const id = nextId++; waiting.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const text = r => r.result?.content?.find(c => c.type === 'text')?.text || '';
async function call(name, args = {}, { expectError = false } = {}) {
  const r = await rpc('tools/call', { name, arguments: args }); const t = text(r); const isErr = !!r.result?.isError;
  if (isErr !== expectError) { console.log(`  ${name} ${JSON.stringify(args).slice(0, 200)} -> ${t.slice(0, 600)}`); }
  let json = null; try { json = JSON.parse(t); } catch { }
  return { r, t, json, isErr, image: r.result?.content?.find(c => c.type === 'image')?.data };
}
const savePng = (name, b64) => { if (b64) writeFileSync(`/tmp/mpe-mcp-${name}.png`, Buffer.from(b64, 'base64')); };

const IN = '/tmp/mpe-mcp-in.pdf', OUT = '/tmp/mpe-mcp-out.pdf', EXTRACT = '/tmp/mpe-mcp-extract.pdf';
for (const f of [OUT, EXTRACT, IN.replace('.pdf', '.orig.pdf')]) if (existsSync(f)) rmSync(f);
await buildPdf(IN);
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  check('initialize', init.result?.serverInfo?.name === 'master-pdf-editor' && init.result.protocolVersion === '2025-06-18');
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {}); check('tools/list', list.result.tools.length >= 40, `${list.result.tools.length} tools`);

  const t0 = Date.now(); const o = await call('open_pdf', { path: IN }); check('open_pdf', o.json?.pages === 2 && o.json.form_fields === 8, `${Date.now() - t0} ms ${o.t.slice(0, 120)}`);
  const docId = o.json.id;
  await call('open_pdf', { path: '/nonexistent.pdf' }, { expectError: true }).then(r => check('open_pdf missing file errors', r.isErr, r.t.slice(0, 100)));

  const r1 = await call('render_page', { page: 1, overlay: true, grid: true }); savePng('p1-overlay', r1.image); check('render_page', !!r1.image && r1.image.length > 10000);
  const lay2 = await call('get_page_layout', { page: 2 }); const els = lay2.json.elements;
  const box = els.find(e => e.kind === 'vector' && e.is_rect && e.rect[2] - e.rect[0] > 400);
  check('get_page_layout', box && els.filter(e => e.kind === 'field').length === 8 && els.some(e => e.kind === 'text' && /Section B/.test(e.text)), `${els.length} elements, box ${JSON.stringify(box?.rect)}`);
  check('layout top-left coords', box && Math.abs(box.rect[1] - 72) < 3, JSON.stringify(box?.rect));

  const ft = await call('find_text', { query: 'page 1' }); check('find_text', ft.json.matches.length === 1 && ft.json.matches[0].page === 1);
  const ed = await call('edit_text', { id: ft.json.matches[0].id, text: 'Page one (edited)' }); check('edit_text', ed.json?.element?.text === 'Page one (edited)', ed.t.slice(0, 200));

  const at = await call('add_text', { page: 1, x: 72, y: 560, text: 'Added by the agent', font_size: 14, color: '#c00000', bold: true }); check('add_text', at.json?.added?.kind === 'object');
  const sh = await call('add_shape', { page: 1, shape: 'rect', rect: [400, 60, 520, 100], stroke: '#0000ff', fill: '#ddeeff', width: 2 }); check('add_shape', !!sh.json?.added);
  const hl = await call('add_annotation', { page: 1, type: 'highlight', text: 'Application form' }); check('add_annotation highlight by text', hl.json?.added?.type === 'highlight');
  const nt = await call('add_annotation', { page: 1, type: 'note', rect: [540, 60, 560, 80], text: 'Check this page' }); check('add_annotation note', nt.json?.added?.type === 'note');
  const ff = await call('add_form_field', { page: 1, type: 'checkbox', rect: [72, 600, 86, 614], name: 'agree' }); check('add_form_field', ff.json?.added?.name === 'agree');
  const fill = await call('fill_form', { values: { full_name: 'Ada Lovelace', email: 'ada@example.org', agree: true, nope: 'x' } }); check('fill_form', fill.json?.filled?.length === 3 && fill.json.not_found?.[0] === 'nope', fill.t.slice(0, 200));

  const dry = await call('flow_to_previous_page', { ids: [box.id], dry_run: true }); check('flow dry run', dry.json?.dry_run && dry.json.split === true, dry.json?.plan?.slice(0, 120));
  const fl = await call('flow_to_previous_page', { ids: [box.id] }); check('flow_to_previous_page', fl.json?.pages_changed?.includes(1) && fl.json?.moved?.length > 0, fl.t.slice(0, 200));
  const ff2 = await call('list_form_fields', {}); const pageOf = n => ff2.json.fields.find(f => f.name === n)?.page;
  check('flow moved fields', pageOf('full_name') === 1 && pageOf('occupation') === 2, `full_name p${pageOf('full_name')} occupation p${pageOf('occupation')}`);
  check('values survive flow', ff2.json.fields.find(f => f.name === 'full_name')?.value === 'Ada Lovelace');
  savePng('p1-flow', (await call('render_page', { page: 1 })).image); savePng('p2-flow', (await call('render_page', { page: 2, overlay: true })).image);

  const un = await call('undo'); const ff3 = await call('list_form_fields', {}); check('undo flow', un.json?.undone && ff3.json.fields.find(f => f.name === 'full_name')?.page === 2, un.t.slice(0, 100));
  await call('redo'); const ff4 = await call('list_form_fields', {}); check('redo flow', ff4.json.fields.find(f => f.name === 'full_name')?.page === 1);

  const secC = (await call('find_text', { query: 'Section C' })).json.matches[0];
  const mv = await call('move_elements', { ids: [secC.id], dx: 0, dy: 300 }); check('move_elements', mv.json?.moved?.[0] && Math.abs(mv.json.moved[0].rect[1] - (secC.rect[1] + 300)) < 2, `${JSON.stringify(secC.rect)} -> ${JSON.stringify(mv.json?.moved?.[0]?.rect)}`);
  const mv2 = await call('move_elements', { ids: [mv.json.moved[0].id], to_page: 1, dx: 0, dy: 0 }); check('move_elements to another page', mv2.json?.moved?.[0]?.page === 1, mv2.t.slice(0, 160));
  const dr = await call('delete_region', { page: 1, rect: [60, 120, 400, 200], kinds: ['text'] }); check('delete_region', dr.json?.deleted >= 3, dr.t.slice(0, 160));

  await call('duplicate_page', { page: 1 }).then(r => check('duplicate_page', r.json?.pages === 3));
  await call('insert_blank_page', { after: 0 }).then(r => check('insert_blank_page', r.json?.pages === 4));
  await call('move_pages', { order: [2, 3, 4, 1] }).then(r => check('move_pages', JSON.stringify(r.json?.order) === '[2,3,4,1]'));
  await call('rotate_pages', { pages: [3], degrees: 90 }).then(r => check('rotate_pages', r.json?.rotation?.[0] === 90));
  await call('delete_pages', { pages: [4, 3] }).then(r => check('delete_pages', r.json?.pages === 2, r.t.slice(0, 100)));
  savePng('final-1', (await call('render_page', { page: 1 })).image); savePng('final-2', (await call('render_page', { page: 2 })).image);

  const ex = await call('extract_pages', { pages: [2], output_path: EXTRACT }); check('extract_pages', ex.json?.written === EXTRACT && existsSync(EXTRACT));
  await call('close_pdf', { doc: docId }, { expectError: true }).then(r => check('close refuses unsaved changes', r.isErr, r.t.slice(0, 80)));
  const sv = await call('save_pdf', { output_path: OUT }); check('save_pdf', sv.json?.saved === OUT && existsSync(OUT));
  const out = await PDFDocument.load(readFileSync(OUT)); const names = out.getForm().getFields().map(f => f.getName());
  check('saved file', out.getPageCount() === 2 && names.includes('agree') && names.includes('full_name'), `${out.getPageCount()} pages, fields ${names.join(',')}`);
  check('saved values', out.getForm().getTextField('full_name').getText() === 'Ada Lovelace' && out.getForm().getCheckBox('agree').isChecked());
  const mupdf = await import('mupdf'); const md = mupdf.PDFDocument.openDocument(readFileSync(OUT), 'application/pdf'); const txt = [0, 1].map(i => md.loadPage(i).toStructuredText('').asText());
  check('saved text', /Page one \(edited\)/.test(txt.join('\n')) && /Added by the agent/.test(txt.join('\n')) && /Section B/.test(txt[0]), txt[0].slice(0, 80).replace(/\n/g, ' | '));
  check('original text really removed', !/Introductory guidance line at 140/.test(txt.join('\n')));

  const sh2 = await call('screenshot_app'); savePng('app', sh2.image); check('screenshot_app', !!sh2.image);
  await call('close_pdf', { doc: docId, discard_changes: true }).then(r => check('close_pdf', !!r.json?.closed));
} catch (e) { failed++; console.log('EXCEPTION', e); }
finally {
  if (!wasRunning) { const pid = await new Promise(res => { const c = net.connect(socketPath()); c.setEncoding('utf8'); c.on('data', d => { try { res(JSON.parse(d).result.pid); } catch { res(null); } c.destroy(); }); c.on('error', () => res(null)); c.write(JSON.stringify({ id: 1, op: 'ping' }) + '\n'); }); if (pid) try { process.kill(pid); } catch { } }
  srv.stdin.end(); console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
}
