// Smoke checks for selecting and re-laying out page content (run from smoke.js): mixed selection of
// graphics, form fields and text, exact moves (also onto another page), and flowing a boxed section
// into the gap at the bottom of the previous page.
import * as RL from './relayout.js';
import { settings } from './util.js';
const L = PDFLib;

const ROWS = ['Full name', 'Address', 'Postcode', 'Telephone', 'Email', 'Date of birth', 'Nationality', 'Occupation'];

/** Page 1 ends with a gap above its footer; page 2 starts with a boxed section of labels + text fields. */
export async function buildFlowPdf() {
  const d = await L.PDFDocument.create(); const font = await d.embedFont(L.StandardFonts.Helvetica), bold = await d.embedFont(L.StandardFonts.HelveticaBold); const H = 842;
  const p1 = d.addPage([595, H]); p1.drawText('Application form', { x: 72, y: H - 80, size: 18, font: bold });
  for (let y = 120; y < 540; y += 20) p1.drawText(`Introductory guidance line at ${y}`, { x: 72, y: H - y, size: 11, font });
  p1.drawText('Page 1', { x: 72, y: H - 810, size: 9, font });
  const p2 = d.addPage([595, H]); const top = 72, h = 40 + 36 * ROWS.length; const form = d.getForm();
  p2.drawRectangle({ x: 60, y: H - (top + h), width: 475, height: h, borderColor: L.rgb(0.2, 0.3, 0.6), borderWidth: 1.5 });
  p2.drawText('Section B: Applicant details', { x: 72, y: H - (top + 24), size: 13, font: bold });
  p2.drawLine({ start: { x: 72, y: H - (top + 34) }, end: { x: 520, y: H - (top + 34) }, thickness: 0.8, color: L.rgb(0.5, 0.5, 0.5) });
  ROWS.forEach((label, i) => { const y = top + 64 + 36 * i; p2.drawText(label + ':', { x: 72, y: H - y, size: 11, font }); const tf = form.createTextField(label.toLowerCase().replace(/ /g, '_')); tf.addToPage(p2, { x: 200, y: H - (y + 4), width: 320, height: 18, font }); });
  p2.drawText('Section C follows the applicant box.', { x: 72, y: H - (top + h + 40), size: 11, font });
  p2.drawText('Page 2', { x: 72, y: H - 810, size: 9, font });
  return d.save();
}

const fieldPages = async bytes => { const d = await L.PDFDocument.load(bytes); const pages = d.getPages(); const out = {}; for (const f of d.getForm().getFields()) for (const w of f.acroField.getWidgets()) { const ref = w.P(); const i = pages.findIndex(p => p.ref === ref); out[f.getName()] = i; } return out; };

/** Saves a screenshot of the window to /tmp when run with `npm run smoke:layout`. */
async function shot(app, name) { if (!window.native?.capturePage || new URLSearchParams(location.search).get('smoke') !== 'layout') return; await new Promise(r => setTimeout(r, 700)); await window.native.writeFile(`/tmp/mpe-layout-${name}.png`, await window.native.capturePage()); }

/** `npm run smoke:layout -- --file=/path.pdf`: move page 2's largest box and everything in it onto page 1. */
async function fileCase(app, step, path) {
  const mu = await import('./mupdf-bridge.js'); const bytes = await window.native.readFile(path); const doc = await app.openBytes(bytes, path.split('/').pop()); app.setTool('editdoc');
  const [p1, p2] = doc.pages; await app.editor.ensureScanned(p1); await app.editor.ensureScanned(p2);
  const box = p2.items.filter(i => i.orig === 'vector' && !RL.isBackground(p2, i)).sort((a, b) => (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]) - (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]))[0];
  if (new URLSearchParams(location.search).get('mode') === 'box') { app.editor.select([box]); await app.selectEnclosed(); } else app.editor.select(p2.visibleItems().filter(i => app.editor.selectable(i) && !RL.isBackground(p2, i) && i.kind !== 'annot')); const sel = app.editor.selection.slice(); const texts = sel.filter(i => i.orig === 'text').map(i => i.props.text.trim()).filter(Boolean);
  const before1 = await mu.pageText(doc.bytes, 0); await shot(app, 'file-before');
  await app.moveSelection(0, -300, 0, { items: sel });
  const t1 = await mu.pageText(doc.bytes, 0), t2 = await mu.pageText(doc.bytes, 1); const arrived = texts.filter(t => t1.includes(t) && !before1.includes(t));
  app.viewer.goToPage(0); await new Promise(r => setTimeout(r, 500)); app.viewer.el.scrollTop += 250; await shot(app, 'file-after');
  step('file.move', { ok: arrived.length === texts.length, vectors: sel.filter(i => i.orig === 'vector').map(i => [i.rect.map(Math.round), i.props.paint, i.props.lineWidth]), selected: sel.map(i => i.orig || i.kind), texts, arrived, leftOnP2: texts.filter(t => t2.includes(t)) });
  window.native.writeFile('/tmp/mpe-file-moved.pdf', doc.bytes);
}

export async function runLayoutSmoke(app, step) {
  if (new URLSearchParams(location.search).get('mode') === 'about') { app.dialogs.about(); await shot(app, 'about'); return true; }
  const file = new URLSearchParams(location.search).get('file'); if (file) { await fileCase(app, step, file); return true; }
  const mu = await import('./mupdf-bridge.js'); const ops = await import('./pdfops.js'); const M = await import('./model.js'); let ok = true; const check = (name, cond, info = {}) => { step(name, { ok: !!cond, ...info }); if (!cond) ok = false; };
  const doc = await app.openBytes(await buildFlowPdf(), 'flow.pdf'); app.setTool('editdoc'); const [p1, p2] = doc.pages;
  await app.editor.ensureScanned(p1); await app.editor.ensureScanned(p2);
  const box = p2.items.find(i => i.orig === 'vector' && i.rect[2] - i.rect[0] > 400 && i.rect[3] - i.rect[1] > 50);
  check('layout.scanBox', box && box.props.isRect && box.props.stroke, { props: box?.props });
  // mixed selection: a graphic, a text field and a text run together (Ctrl+click in Edit Document)
  const email = p2.items.find(i => i.kind === 'field' && i.props.name === 'email'); const emailLabel = p2.items.find(i => i.orig === 'text' && /^Email/.test(i.props.text));
  app.editor.select([box]); app.editor.select([email], { add: true }); app.editor.select([emailLabel], { add: true });
  check('layout.mixedSelection', app.editor.selection.length === 3, { kinds: app.editor.selection.map(i => i.kind + ':' + (i.orig || i.type)) });
  // hit-testing: the box is drawn below the text inside it, and only its outline is hit
  app.viewer.refreshOverlays(); const nodes = [...app.viewer.wraps[1].querySelectorAll('svg.overlay [data-id]')]; const order = id => nodes.findIndex(n => n.dataset.id === id);
  check('layout.hitOrder', order(box.id) >= 0 && order(box.id) < order(emailLabel.id) && nodes[order(box.id)].querySelector('[pointer-events="stroke"]'), { box: order(box.id), label: order(emailLabel.id) });
  // move the label + field onto page 1 (cross-page, exact)
  const res = await app.moveSelection(0, 842 - 560 - (842 - (72 + 64 + 36 * 4)), 0, { items: [emailLabel, email] });
  let t1 = await mu.pageText(doc.bytes, 0), t2 = await mu.pageText(doc.bytes, 1); let fp = await fieldPages(doc.bytes);
  check('layout.crossPageMove', res && /Email:/.test(t1) && !/Email:/.test(t2) && fp.email === 0 && doc.pages[0].fields().some(f => f.props.name === 'email'), { fieldPage: fp.email, selected: app.editor.selection.length });
  await app.undo(); t2 = await mu.pageText(doc.bytes, 1); fp = await fieldPages(doc.bytes);
  check('layout.undoMove', /Email:/.test(t2) && fp.email === 1 && doc.pages[1].fields().some(f => f.props.name === 'email'));
  // an original vector moved on its page survives saving (it used to be dropped)
  await app.editor.ensureScanned(doc.pages[1]); const box2 = doc.pages[1].items.find(i => i.orig === 'vector' && i.rect[2] - i.rect[0] > 400 && i.rect[3] - i.rect[1] > 50);
  await app.moveSelection(5, -5, null, { items: [box2] }); const moved = await ops.saveBytes(doc, {}); const md = new M.PdfDoc({ name: 'm.pdf' }); await md.load(moved); const ms = await md.scanPage(md.pages[1]);
  check('layout.vectorMoveSaved', ms.vectors.some(v => Math.abs(v.rect[0] - (box2.rect[0] + 5)) < 1 && Math.abs(v.rect[2] - v.rect[0] - 475) < 2), { vectors: ms.vectors.map(v => v.rect.map(Math.round)) });
  await app.undo();
  // moving only the box must not take the rule inside it along (removal catches it; it is put back)
  await app.editor.ensureScanned(doc.pages[1]); const boxOnly = doc.pages[1].items.find(i => i.orig === 'vector' && i.rect[2] - i.rect[0] > 400 && i.rect[3] - i.rect[1] > 50);
  await app.moveSelection(0, 20, null, { items: [boxOnly] }); const after = (await doc.scanPage(doc.pages[1])).vectors; if (window.native) await window.native.writeFile('/tmp/mpe-boxonly.pdf', doc.bytes);
  check('layout.innerRuleKept', after.some(v => Math.abs(v.rect[1] - (842 - 106)) < 1.5 && v.rect[2] - v.rect[0] > 400 && v.rect[3] - v.rect[1] < 3) && after.some(v => Math.abs(v.rect[3] - (boxOnly.rect[3] + 20)) < 1.5), { after: after.map(v => v.rect.map(Math.round)) });
  await app.undo();
  // flow: select the box, add what it encloses, flow into page 1's gap
  await app.editor.ensureScanned(doc.pages[1]); const box3 = doc.pages[1].items.find(i => i.orig === 'vector' && i.rect[2] - i.rect[0] > 400 && i.rect[3] - i.rect[1] > 50); app.editor.select([box3]); await app.selectEnclosed();
  const kinds = new Set(app.editor.selection.map(i => i.kind === 'field' ? 'field' : i.orig)); check('layout.selectEnclosed', kinds.has('field') && kinds.has('text') && kinds.has('vector'), { n: app.editor.selection.length });
  await shot(app, 'select');
  const plan = app.flowPlanner()({}); check('layout.flowPlan', plan.cut != null && plan.available > 150, { available: plan.available, cut: plan.cut, top: plan.topHeight });
  await app.flowSelection({ plan });
  t1 = await mu.pageText(doc.bytes, 0); t2 = await mu.pageText(doc.bytes, 1); fp = await fieldPages(doc.bytes);
  const onP1 = ROWS.filter(r => fp[r.toLowerCase().replace(/ /g, '_')] === 0).length;
  check('layout.flowSplit', /Section B/.test(t1) && !/Section B/.test(t2) && /Occupation/.test(t2) && onP1 >= 4 && onP1 < ROWS.length && /Page 1/.test(t1), { onP1, fp });
  await app.editor.ensureScanned(doc.pages[1]); const secC = doc.pages[1].items.find(i => i.orig === 'text' && /Section C/.test(i.props.text));
  check('layout.flowPullUp', secC && secC.rect[3] > 842 - 400, { secC: secC?.rect.map(Math.round) });
  const closing = (await doc.scanPage(doc.pages[0])).vectors.filter(v => v.rect[3] - v.rect[1] < 2 && v.rect[2] - v.rect[0] > 400).length;
  check('layout.flowClosedBoxes', closing >= 1, { closing });
  app.viewer.goToPage(0); await new Promise(r => setTimeout(r, 300)); app.viewer.el.scrollTop += 380; await shot(app, 'flow');
  const saved = await ops.saveBytes(doc, {}); const sp = await fieldPages(saved); check('layout.flowSaved', sp.full_name === 0 && sp.occupation === 1, { sp });
  await app.undo(); fp = await fieldPages(doc.bytes); check('layout.flowUndo', fp.full_name === 1 && /Section B/.test(await mu.pageText(doc.bytes, 1)));
  // a real drag through the editor's pointer handlers: label + field dropped onto page 1
  await app.editor.ensureScanned(doc.pages[1]); const tel = doc.pages[1].items.find(i => i.orig === 'text' && /^Telephone/.test(i.props.text)), telF = doc.pages[1].items.find(i => i.kind === 'field' && i.props.name === 'telephone');
  app.viewer.goToPage(1); await new Promise(r => setTimeout(r, 300)); app.viewer.refreshOverlays(); app.editor.select([tel, telF]);
  const client = (pm, x, y) => { const [vx, vy] = app.viewer.toViewport(pm, x, y); const r = app.viewer.wraps[pm.index].getBoundingClientRect(); return [r.left + vx, r.top + vy]; };
  const node = app.viewer.wraps[1].querySelector(`[data-id="${tel.id}"]`); const cap = app.viewer.el.setPointerCapture; app.viewer.el.setPointerCapture = () => { };
  const [sx0, sy0] = client(doc.pages[1], tel.rect[0] + 2, tel.rect[1] + 3); const ev = (x, y) => ({ button: 0, clientX: x, clientY: y, target: node, pointerId: 1, ctrlKey: false, shiftKey: false, altKey: false, preventDefault() { }, stopPropagation() { } });
  app.editor.onDown(ev(sx0, sy0)); app.editor.onMove(ev(sx0 + 4, sy0 + 4)); const [tx, ty] = client(doc.pages[0], tel.rect[0] + 2, 842 - 600); app.editor.onMove(ev(tx, ty)); app.editor.onUp(ev(tx, ty)); app.viewer.el.setPointerCapture = cap;
  for (let k = 0; k < 50 && app._relayoutBusy !== false; k++) await new Promise(r => setTimeout(r, 100)); await new Promise(r => setTimeout(r, 200));
  fp = await fieldPages(doc.bytes); t1 = await mu.pageText(doc.bytes, 0);
  check('layout.dragToOtherPage', fp.telephone === 0 && /Telephone:/.test(t1) && !/Telephone:/.test(await mu.pageText(doc.bytes, 1)), { fieldPage: fp.telephone });
  await app.undo();
  // Alt+click cycles through what is stacked under the cursor (a text run, then the box behind it is not hit: only its outline)
  await app.editor.ensureScanned(doc.pages[1]); app.viewer.goToPage(1); await new Promise(r => setTimeout(r, 300)); app.viewer.refreshOverlays();
  const b4 = doc.pages[1].items.find(i => i.orig === 'vector' && i.rect[2] - i.rect[0] > 400 && i.rect[3] - i.rect[1] > 50); const [ex, ey] = client(doc.pages[1], b4.rect[0], b4.rect[3] - 20); const seen = new Set();
  for (let k = 0; k < 2; k++) { app.editor.cycleAt({ clientX: ex, clientY: ey, ctrlKey: false }); for (const it of app.editor.selection) seen.add(it.orig || it.kind); }
  check('layout.altClickOutline', seen.has('vector'), { seen: [...seen] });
  // deleting original text removes it from the PDF at once: no page-coloured cover is left that would
  // hide text moved onto the same spot later
  await app.editor.ensureScanned(doc.pages[1]); const pc = doc.pages[1].items.find(i => i.orig === 'text' && /^Postcode/.test(i.props.text));
  app.editor.select([pc]); await app.editor.delete();
  const covers = doc.pages[1].items.filter(i => i.deleted && i.kind === 'object' && i.orig).length; t2 = await mu.pageText(doc.bytes, 1);
  check('layout.deleteIsReal', !/Postcode:/.test(t2) && covers === 0, { covers, stillThere: /Postcode:/.test(t2) });
  await app.editor.ensureScanned(doc.pages[1]); const nat = doc.pages[1].items.find(i => i.orig === 'text' && /^Nationality/.test(i.props.text));
  await app.moveSelection(pc.rect[0] - nat.rect[0], pc.rect[1] - nat.rect[1], null, { items: [nat] }); app.viewer.refreshOverlays();
  const coverRects = [...app.viewer.wraps[1].querySelectorAll('svg.overlay rect')].filter(r => r.getAttribute('fill') === settings.editing.textCover && !r.closest('[data-id]'));
  check('layout.moveOntoDeletedSpot', /Nationality:/.test(await mu.pageText(doc.bytes, 1)) && coverRects.length === 0, { covers: coverRects.length });
  await app.undo(); await app.undo(); check('layout.deleteUndo', /Postcode:/.test(await mu.pageText(doc.bytes, 1)));
  // smart guides: a field dragged to ~1pt from the page's horizontal centre snaps onto it (guide shown);
  // with Alt held it lands exactly where it was dropped
  const snapDrag = async (it, ddx, alt, dstPage = 1) => {
    app.viewer.goToPage(1); await new Promise(r => setTimeout(r, 250)); app.viewer.refreshOverlays(); app.editor.select([it]);
    const nodeS = app.viewer.wraps[1].querySelector(`[data-id="${it.id}"]`); const cap2 = app.viewer.el.setPointerCapture; app.viewer.el.setPointerCapture = () => { };
    const [sx, sy] = client(doc.pages[1], it.rect[0] + 5, it.rect[1] + 5); const [tx2, ty2] = client(doc.pages[dstPage], it.rect[0] + 5 + ddx, it.rect[1] + 5 + (dstPage === 1 ? 0 : 0));
    const evS = (x, y, a = alt) => ({ button: 0, clientX: x, clientY: y, target: nodeS, pointerId: 1, ctrlKey: false, shiftKey: false, altKey: a, preventDefault() { }, stopPropagation() { } });
    app.editor.onDown(evS(sx, sy, false)); app.editor.onMove(evS(sx + 4, sy)); app.editor.onMove(evS(tx2, ty2)); const guides = document.querySelectorAll('.snap-guide').length; if (!alt && dstPage === 1) await shot(app, 'guides'); const adj = app.editor.drag?.snapAdj?.slice();
    app.editor.onUp(evS(tx2, ty2)); app.viewer.el.setPointerCapture = cap2; for (let k = 0; k < 50 && app._relayoutBusy; k++) await new Promise(r => setTimeout(r, 100));
    return { guides, adj, left: document.querySelectorAll('.snap-guide').length };
  };
  await app.editor.ensureScanned(doc.pages[1]); const fEmail = doc.pages[1].items.find(i => i.kind === 'field' && i.props.name === 'email'); const x0 = fEmail.rect[0];
  const centreTarget = 297.5 - (fEmail.rect[0] + fEmail.rect[2]) / 2; let sres = await snapDrag(fEmail, centreTarget + 1.2, false);
  check('layout.snapToPageCentre', Math.abs((fEmail.rect[0] + fEmail.rect[2]) / 2 - 297.5) < 0.01 && sres.guides > 0 && sres.left === 0, { centre: (fEmail.rect[0] + fEmail.rect[2]) / 2, ...sres });
  await app.undo(); const fE2 = doc.pages[1].items.find(i => i.kind === 'field' && i.props.name === 'email'); sres = await snapDrag(fE2, centreTarget + 1.2, true);
  check('layout.altPlacesFreely', Math.abs(fE2.rect[0] - (x0 + centreTarget + 1.2)) < 0.6 && sres.guides === 0, { x: fE2.rect[0], want: x0 + centreTarget + 1.2, ...sres });
  await app.undo();
  // an original text run dragged onto page 1 snaps to the left edge of the text there (x = 72)
  await app.editor.ensureScanned(doc.pages[0]); await app.editor.ensureScanned(doc.pages[1]); const occ = doc.pages[1].items.find(i => i.orig === 'text' && /^Occupation/.test(i.props.text));
  const occText = occ.props.text; sres = await snapDrag(occ, 1.5, false, 0); await app.editor.ensureScanned(doc.pages[0]);
  const landed = doc.pages[0].items.find(i => i.orig === 'text' && i.props.text === occText);
  check('layout.snapAcrossPages', landed && Math.abs(landed.rect[0] - 72) < 0.6 && sres.guides > 0, { x: landed?.rect[0], ...sres });
  if (landed) await app.undo();
  // Object TreeView: Ctrl+click adds graphics and fields to one selection
  app.panels.openPages = new Set([1]); app.panels.openGroups = new Set(['1:Vector graphics', '1:Form fields']); app.setTool('hand'); app.panels.show('objtree'); await app.editor.ensureScanned(doc.pages[1], true); app.panels.render();
  const rows = app.panels.objRows; const vRow = rows.find(r => r.it.orig === 'vector'), fRows = rows.filter(r => r.it.kind === 'field');
  vRow.row.dispatchEvent(new MouseEvent('click', { bubbles: true })); fRows[0].row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); fRows[1].row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
  check('layout.treeMultiSelect', app.editor.selection.length === 3 && app.tool === 'editdoc' && rows.filter(r => r.row.classList.contains('sel')).length === 3, { tool: app.tool, n: app.editor.selection.length });
  doc.modified = false; await app.closeDoc(doc);
  return ok;
}
