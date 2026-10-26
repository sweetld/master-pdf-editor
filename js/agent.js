// MCP tool implementations (see electron/mcp-tools.cjs for the schemas and docs/MCP.md for the guide).
// The MCP server forwards each tool call to window.mpeAgent.call(name, args) in this window, so agents
// drive the running app: edits go through the same model and undo stack as the user's, and show live.
// Agent coordinates are points with the origin at the top-left of the page as displayed (y down); the
// model is PDF user space (y up), so everything is converted through the page's pdf.js viewport.
import * as ops from './pdfops.js';
import * as RL from './relayout.js';
import { PdfDoc, newItem, pdfjsLib, ANNOT_TYPES, OBJECT_TYPES, FIELD_TYPES } from './model.js';
import { rectNorm, bytesToBase64, loadImage, readFileDataUrl, settings } from './util.js';
import { measureText } from './viewer.js';
import { platform } from './platform.js';

const CMAP_URL = new URL('../vendor/cmaps/', import.meta.url).href;
const FONT_URL = new URL('../vendor/standard_fonts/', import.meta.url).href;
const r1 = v => Math.round(v * 10) / 10;
const fail = msg => { throw new Error(msg); };

export class Agent {
  constructor(app) { this.app = app; this.queue = Promise.resolve(); this.renderCache = new WeakMap(); this.gens = new WeakMap(); this.ready = true; }

  /** Runs one tool call; calls are serialised so they never interleave. Returns MCP tool-result content. */
  call(name, args = {}) { const run = this.queue.then(() => this.run(name, args || {})); this.queue = run.catch(() => { }); return run; }

  async run(name, args) {
    const fn = TOOLS[name]; if (!fn) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}` }] };
    const app = this.app; const saved = { error: app.error, flash: app.flash, alert: app.dialogs.alert, confirm: app.dialogs.confirm, confirm3: app.dialogs.confirm3, prompt: app.dialogs.prompt, password: app.dialogs.password };
    const errors = [], notes = [];
    // No modal dialogs while an agent call runs: errors are returned to the agent, messages become warnings.
    app.error = e => { console.warn('[agent]', e); errors.push(e); };
    app.flash = msg => { notes.push(String(msg)); saved.flash.call(app, msg); };
    app.dialogs.alert = async msg => { notes.push(String(msg)); };
    app.dialogs.confirm = async () => false; app.dialogs.confirm3 = async () => null; app.dialogs.prompt = async () => null;
    app.dialogs.password = async (_n, wrong) => (wrong ? null : (args.password ?? null));
    try {
      const out = await fn.call(this, args, { notes });
      if (errors.length) throw errors[0];
      return toContent(out, notes);
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${e?.message || e}` }] };
    } finally { Object.assign(app, { error: saved.error, flash: saved.flash }); Object.assign(app.dialogs, { alert: saved.alert, confirm: saved.confirm, confirm3: saved.confirm3, prompt: saved.prompt, password: saved.password }); }
  }

  // ---------- helpers ----------
  doc(ref, { activate = true } = {}) {
    const app = this.app; let d = null;
    if (!ref) d = app.doc; else d = app.docs.find(x => x.id === ref) || app.docs.find(x => x.path && (x.path === ref || samePath(x.path, ref))) || app.docs.find(x => x.name === ref || x.name === baseName(ref));
    if (!d) fail(ref ? `No open document matches “${ref}”. Use list_open_pdfs or open_pdf.` : 'No document is open: call open_pdf first.');
    if (!this.gens.has(d)) { this.gens.set(d, 0); d.on(() => this.bump(d)); }
    if (activate && app.doc !== d) app.activate(d);
    return d;
  }
  bump(d) { this.gens.set(d, (this.gens.get(d) || 0) + 1); }
  page(doc, n) { if (!Number.isInteger(n) || n < 1 || n > doc.pages.length) fail(`Page ${n} is out of range (the document has ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}).`); return doc.pages[n - 1]; }
  pages(doc, list) { return (list?.length ? list : doc.pages.map((_, i) => i + 1)).map(n => this.page(doc, n)); }
  async scan(pm) { await this.app.editor.ensureScanned(pm, true); return pm; }
  vp(pm) { return pm.pdfPage.getViewport({ scale: 1 }); }
  /** User-space rect -> top-left display rect. */
  toTop(pm, r) { const v = this.vp(pm); const a = v.convertToViewportPoint(r[0], r[1]), b = v.convertToViewportPoint(r[2], r[3]); return rectNorm([a[0], a[1], b[0], b[1]]).map(r1); }
  /** Top-left display rect -> user-space rect. */
  toUser(pm, r) { checkRect(r); const v = this.vp(pm); const a = v.convertToPdfPoint(r[0], r[1]), b = v.convertToPdfPoint(r[2], r[3]); return rectNorm([a[0], a[1], b[0], b[1]]); }
  ptUser(pm, x, y) { return this.vp(pm).convertToPdfPoint(x, y); }
  item(doc, id) { const it = doc.findItem(id); if (!it || it.deleted) fail(`No element “${id}” in ${doc.name}: ids come from get_page_layout or find_text (re-read the layout after moving content).`); return it; }
  items(doc, ids) { const its = ids.map(id => this.item(doc, id)); const pm = doc.pageOf(its[0]); if (its.some(it => doc.pageOf(it) !== pm)) fail('All ids must be on the same page.'); return { its, pm }; }
  /** Elements of a page as the agent sees them, in reading order. */
  elements(pm, { kinds = null, region = null } = {}) {
    let list = pm.visibleItems().filter(it => !(it.kind === 'object' && it.type === 'cover'));
    if (kinds?.length) list = list.filter(it => kinds.includes(kindOf(it)));
    const reg = region ? this.toUser(pm, region) : null; if (reg) list = list.filter(it => intersects(this.app.editor.bboxOf(it), reg));
    const out = list.map(it => this.describe(pm, it)); out.sort((a, b) => (Math.abs(a.rect[1] - b.rect[1]) > 2 ? a.rect[1] - b.rect[1] : a.rect[0] - b.rect[0])); return out;
  }
  describe(pm, it) {
    const p = it.props; const d = { id: it.id, kind: kindOf(it), rect: this.toTop(pm, this.app.editor.bboxOf(it)) };
    if (it.kind === 'object') {
      if (it.orig !== 'text' && it.orig !== 'image' && it.orig !== 'vector') d.type = it.type;
      if (it.type === 'text' || it.type === 'ftext') Object.assign(d, { text: p.text, font: p.fontFamily, size: p.fontSize, ...(it.orig ? {} : { color: p.color }), ...(p.bold ? { bold: true } : {}), ...(p.italic ? { italic: true } : {}) });
      if (it.orig === 'vector') Object.assign(d, { paint: p.paint, ...(p.stroke ? { stroke: p.stroke } : {}), line_width: p.lineWidth, ...(p.isRect ? { is_rect: true } : {}) });
      if (it.orig === 'image') d.name = p.imgName;
      if (!it.orig && ['rect', 'ellipse', 'line', 'ink'].includes(it.type)) Object.assign(d, { stroke: p.color, fill: p.fillColor, width: p.lineWidth });
      if (it.origModified) d.edited = true;
    } else if (it.kind === 'field') {
      Object.assign(d, { type: it.type, name: p.name });
      if (['checkbox', 'radio'].includes(it.type)) Object.assign(d, { checked: !!p.checked, export_value: p.exportValue }); else if (it.type !== 'link') d.value = p.value;
      if (it.type === 'link') d.url = p.url || p.actions?.[0]?.url || undefined;
    } else if (it.kind === 'annot') {
      Object.assign(d, { type: it.type, ...(p.contents ? { contents: p.contents } : {}), color: p.color, ...(p.author ? { author: p.author } : {}) });
      if (it.type === 'stamp') d.stamp = p.stampName;
    }
    return d;
  }
  /** Refreshes the window after model edits on `pages` (indices) of the active document. */
  refresh(doc, pages = null) { const app = this.app; this.bump(doc); if (doc !== app.doc) return; for (const i of pages ?? doc.pages.map((_, k) => k)) app.viewer.refreshPage(i); app.viewer.refreshOverlays(); app.editor.updateHandles(); app.inspector.render(); app.onItemsChanged(); app.renderDocTabs(); }
  /** A whole-document change (page operations): like App.structural, but errors reach the agent. */
  async structural(doc, fn) {
    const app = this.app; app.editor.commitInline(); app.editor.select([]); app.closeNotePopup();
    try { app.busy(true, 'Working…'); await fn(); } finally { app.busy(false); }
    this.bump(doc); app.viewer.setDoc(doc); app.panels.refresh(); app.updateUI(); app.updateStatus(); app.renderDocTabs(); app.editor.scanVisible();
  }
  /** Moves `its` of page `pm` so their display top-left goes by (dx, dy) (onto page `dst`), optionally scaled. */
  async move(doc, pm, its, { dx = 0, dy = 0, toPage = null, scale = 1 }, notes) {
    const app = this.app; const dst = toPage ? this.page(doc, toPage) : pm; if (dst !== pm) await this.scan(dst);
    if (!(scale > 0)) fail('scale must be positive.');
    const box = RL.union(its.map(it => app.editor.bboxOf(it))); const tl = this.toTop(pm, box);
    const c = this.ptUser(pm, tl[0], tl[1]); const n = this.ptUser(dst, tl[0] + dx, tl[1] + dy);
    const ux = n[0] - c[0] * scale, uy = n[1] - c[1] * scale;
    if (app.tool !== 'editdoc') app.setTool('editdoc');
    const res = await app.moveSelection(ux, uy, dst.index, { sx: scale, sy: scale, items: its });
    if (!res) fail('The move did not happen' + (notes.length ? ': ' + notes.join(' ') : '.'));
    return this.afterRelayout(doc, res);
  }
  /** Delete through the app: original content leaves the PDF at once (no cover left behind). */
  async remove(doc, its, label, pages) {
    if (!its.some(RL.isExact)) { doc.removeItems(its, label); this.refresh(doc, pages); return; }
    if (doc !== this.app.doc) this.app.activate?.(doc);
    const res = await this.app.deleteItems(its, label); if (!res) fail('The deletion did not happen.');
    for (const i of res.touched) await this.scan(doc.pages[i]); this.refresh(doc, res.touched);
  }
  async afterRelayout(doc, res) {
    for (const i of res.touched) await this.scan(doc.pages[i]);
    const moved = RL.resolveTargets(doc, res.targets); this.bump(doc);
    return { pages_changed: res.touched.map(i => i + 1).sort((a, b) => a - b), moved: moved.map(it => ({ ...this.describe(doc.pageOf(it), it), page: doc.pageOf(it).index + 1 })) };
  }
  async regionItems(pm, rect, { kinds = null, partial = false } = {}) {
    await this.scan(pm); const reg = this.toUser(pm, rect);
    return pm.visibleItems().filter(it => !(it.kind === 'object' && it.type === 'cover') && (!kinds?.length || kinds.includes(kindOf(it)))).filter(it => { const b = rectNorm(this.app.editor.bboxOf(it)); return partial ? intersects(b, reg) : RL.contains(reg, b, 0.5); });
  }
  async readFile(path) { if (!window.native) fail('File access needs the desktop app.'); try { return await window.native.readFile(path); } catch (e) { fail(`Cannot read ${path}: ${String(e?.message || e).replace(/^Error invoking remote method 'native': /, '')}`); } }
  /** The document as it would be saved, rendered by a separate pdf.js instance; cached per edit generation. */
  async baked(doc) {
    const gen = this.gens.get(doc) || 0; const c = this.renderCache.get(doc);
    if (c && c.gen === gen && c.undo === doc.undoStack.length) return c.pdf;
    const bytes = await ops.saveBytes(doc, {}); const pdf = await pdfjsLib.getDocument({ data: bytes, cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: FONT_URL, isEvalSupported: false }).promise;
    c?.pdf?.destroy?.(); this.renderCache.set(doc, { gen, undo: doc.undoStack.length, pdf }); return pdf;
  }
  docSummary(doc) { return { id: doc.id, name: doc.name, path: doc.path || null, pages: doc.pages.length, modified: !!doc.modified, active: doc === this.app.doc }; }
}

// ---------- tools ----------
const TOOLS = {
  // documents
  async open_pdf({ path }) {
    const app = this.app; if (!/^([a-zA-Z]:)?[\\/]/.test(path || '')) fail('path must be absolute.');
    const was = app.docs.find(d => d.path && samePath(d.path, path)); const bytes = was ? null : await this.readFile(path);
    if (bytes && !new TextDecoder().decode(bytes.slice(0, 1024)).includes('%PDF')) fail(`${path} is not a PDF file.`);
    const doc = was || await app.openBytes(bytes, baseName(path), null, path);
    if (!doc) fail('The PDF is encrypted: pass its password (or the password given was wrong).');
    const d = this.doc(doc.id);
    return { ...this.docSummary(d), already_open: !!was, page_sizes: summarizeSizes(d.pages.map(pm => { const v = this.vp(pm); return [r1(v.width), r1(v.height)]; })), rotated_pages: d.pages.filter(p => p.rotate).map(p => p.index + 1), form_fields: d.allItems().filter(i => i.kind === 'field' && i.type !== 'link').length, encrypted: !!d.encrypted };
  },
  async list_open_pdfs() { return { documents: this.app.docs.map(d => this.docSummary(d)) }; },
  async get_document_info({ doc: ref }) {
    const doc = this.doc(ref, { activate: false }); const m = doc.meta || {};
    return { ...this.docSummary(doc), title: m.Title || null, author: m.Author || null, subject: m.Subject || null, keywords: m.Keywords || null, creator: m.Creator || null, producer: m.Producer || null,
      pages_info: doc.pages.map(pm => { const v = this.vp(pm); return { page: pm.index + 1, width: r1(v.width), height: r1(v.height), rotation: pm.rotate, label: doc.pageLabel(pm.index) }; }),
      form_fields: doc.allItems().filter(i => i.kind === 'field' && i.type !== 'link').length, comments: doc.allComments().length, bookmarks: doc.outline?.length || 0, attachments: doc.attachments?.length || 0,
      encrypted: !!doc.encrypted, undo: doc.undoStack.map(u => u.label).slice(-10), redo: doc.redoStack.map(u => u.label).slice(-10) };
  },
  async save_pdf({ doc: ref, output_path }) {
    const app = this.app; const doc = this.doc(ref); app.editor.commitInline();
    const path = output_path || doc.path; if (!path) fail('This document has no file yet: pass output_path.'); if (!/^([a-zA-Z]:)?[\\/]/.test(path)) fail('output_path must be absolute.');
    const security = doc.saveSecurity?.enabled ? doc.saveSecurity : (doc.encrypted && !doc.saveSecurity ? { enabled: true, method: doc.security?.method === 'rc4-40' ? 'rc4-40' : doc.security?.method || 'aes-128', userPassword: doc.security?.isOwner ? '' : (doc.password || ''), ownerPassword: doc.password || '', permissions: doc.security?.permissions } : null);
    let backup = null;
    if (doc.path && samePath(path, doc.path)) { const b = path.replace(/(\.pdf)?$/i, '.orig.pdf'); if (!(await window.native.fileInfo(b)).exists && (await window.native.fileInfo(path)).exists) { await window.native.writeFile(b, await window.native.readFile(path)); backup = b; } }
    try { app.busy(true, 'Saving…'); const bytes = await ops.saveBytes(doc, { security }); await platform.write(path, bytes);
      doc.name = baseName(path); doc.path = path; doc.modified = false; doc.savedBytes = bytes; app.addRecent({ name: doc.name, path, time: Date.now() }); await app.reopenFromBytes(doc, bytes, security); app.renderDocTabs(); app.updateUI(); this.bump(doc);
      return { saved: path, bytes: bytes.length, ...(backup ? { backup } : {}), note: 'As in the app, saving reloads the document from the written file and clears its undo history.' };
    } finally { app.busy(false); }
  },
  async close_pdf({ doc: ref, discard_changes = false }) {
    const doc = this.doc(ref, { activate: false }); if (doc.modified && !discard_changes) fail(`${doc.name} has unsaved changes: save_pdf first, or pass discard_changes=true.`);
    doc.modified = false; await this.app.closeDoc(doc); return { closed: doc.name, open: this.app.docs.map(d => d.name) };
  },
  async undo({ doc: ref }) { const doc = this.doc(ref); const label = doc.undoStack[doc.undoStack.length - 1]?.label; if (!label && !doc.undoStack.length) fail('Nothing to undo.'); await this.app.undo(); this.bump(doc); return { undone: label || 'change', can_undo: doc.undoStack.length > 0, can_redo: doc.redoStack.length > 0 }; },
  async redo({ doc: ref }) { const doc = this.doc(ref); const label = doc.redoStack[doc.redoStack.length - 1]?.label; if (!doc.redoStack.length) fail('Nothing to redo.'); await this.app.redo(); this.bump(doc); return { redone: label || 'change', can_undo: doc.undoStack.length > 0, can_redo: doc.redoStack.length > 0 }; },

  // seeing
  async render_page({ doc: ref, page, scale = 1.5, overlay = false, grid = false, kinds = null, clip = null }) {
    const doc = this.doc(ref); const pm = this.page(doc, page); scale = Math.max(0.25, Math.min(4, scale));
    const pdf = await this.baked(doc); const pg = await pdf.getPage(page); const v = pg.getViewport({ scale });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(v.width); canvas.height = Math.ceil(v.height); const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: ctx, viewport: v, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    let els = null; if (overlay) { await this.scan(pm); els = this.elements(pm, { kinds }); drawOverlay(ctx, els, scale); }
    if (grid) drawGrid(ctx, v.width / scale, v.height / scale, scale);
    let out = canvas; if (clip) { checkRect(clip); const [x0, y0, x1, y1] = rectNorm(clip).map(n => Math.round(n * scale)); out = document.createElement('canvas'); out.width = Math.max(1, x1 - x0); out.height = Math.max(1, y1 - y0); out.getContext('2d').drawImage(canvas, -x0, -y0); }
    const data = out.toDataURL('image/png').split(',')[1];
    return { image: data, text: `Page ${page} of ${doc.pages.length} (${r1(v.width / scale)} x ${r1(v.height / scale)} pt) at ${scale} px/pt${clip ? `, clip ${JSON.stringify(clip)}` : ''}${overlay ? `; ${els.length} elements outlined (ids as in get_page_layout)` : ''}.` };
  },
  async get_page_layout({ doc: ref, page, kinds = null, region = null }) {
    const doc = this.doc(ref); const pm = await this.scan(this.page(doc, page)); const v = this.vp(pm);
    return { page, width: r1(v.width), height: r1(v.height), rotation: pm.rotate, elements: this.elements(pm, { kinds, region }) };
  },
  async get_text({ doc: ref, pages }) { const doc = this.doc(ref); const out = []; for (const pm of this.pages(doc, pages)) out.push({ page: pm.index + 1, text: await ops.pageText(pm) }); return { pages: out }; },
  async find_text({ doc: ref, query, pages, case_sensitive = false, regex = false }) {
    const doc = this.doc(ref); if (!query) fail('query is empty.'); const re = makeRe(query, { case_sensitive, regex });
    const matches = [], spanning = [];
    for (const pm of this.pages(doc, pages)) {
      await this.scan(pm); let found = 0;
      for (const it of pm.visibleItems()) { const t = textOf(it); if (t == null) continue; re.lastIndex = 0; if (re.test(t)) { matches.push({ page: pm.index + 1, ...this.describe(pm, it) }); found++; } }
      if (!found) { re.lastIndex = 0; if (re.test((await ops.pageText(pm)).replace(/\s+/g, ' '))) spanning.push(pm.index + 1); }
    }
    return { matches, ...(spanning.length ? { note: `Also found on page(s) ${spanning.join(', ')} spread over several text elements; use get_page_layout there.` } : {}) };
  },

  // deleting
  async delete_elements({ doc: ref, ids }) {
    const doc = this.doc(ref); const its = ids.map(id => this.item(doc, id)); const pages = [...new Set(its.map(it => doc.pageOf(it).index))];
    this.app.editor.select([]); await this.remove(doc, its, its.length === 1 ? 'Delete' : `Delete ${its.length} objects`, pages);
    return { deleted: its.length, pages: pages.map(i => i + 1) };
  },
  async delete_region({ doc: ref, page, rect, kinds = null, partial = false }) {
    const doc = this.doc(ref); const pm = this.page(doc, page); const its = await this.regionItems(pm, rect, { kinds, partial });
    if (!its.length) return { deleted: 0, note: 'Nothing lies inside that box' + (partial ? '.' : ' (partial=true also takes elements that only intersect it).') };
    const desc = its.map(it => this.describe(pm, it)); this.app.editor.select([]); await this.remove(doc, its, 'Delete Region', [pm.index]);
    return { deleted: its.length, elements: desc.map(d => ({ id: d.id, kind: d.kind, ...(d.text ? { text: d.text } : {}), ...(d.name ? { name: d.name } : {}) })) };
  },

  // text
  async edit_text({ doc: ref, id, text, font_size, color, font, bold, italic }, { notes }) {
    const doc = this.doc(ref); const it = this.item(doc, id); const pm = doc.pageOf(it);
    if (it.kind === 'annot') { if (!['typewriter', 'callout', 'note'].includes(it.type)) fail(`${id} is a ${it.type} annotation without editable text.`); const props = { contents: text }; if (font_size) props.fontSize = font_size; if (color) props.textColor = color; doc.updateItem(it, { props }, 'Edit Text'); this.refresh(doc, [pm.index]); return { edited: id, element: this.describe(pm, it) }; }
    if (it.kind !== 'object' || !['text', 'ftext'].includes(it.type)) fail(`${id} is not a text element (it is ${kindOf(it)}${it.type ? ' ' + it.type : ''}).`);
    const props = { text }; if (font_size) props.fontSize = font_size; if (color) props.color = checkColor(color); if (font) props.fontFamily = font; if (bold != null) props.bold = bold; if (italic != null) props.italic = italic;
    const p = { ...it.props, ...props }; const patch = { props, rect: fitRect(it, p) };
    if (it.orig === 'text') {
      if (!it.origRect) it.origRect = it.rect.slice(); it.origModified = true;
      const std = ops.stdFontFor(p.fontFamily || '', p.bold, p.italic); if (!sameFont(p.fontFamily, std)) notes.push(/^(sans-serif|serif|monospace)$/i.test(p.fontFamily || '') ? `The original font is only known as “${p.fontFamily}”; the text is re-set in ${std}. Check it with render_page.` : `The original font “${p.fontFamily}” is not a standard PDF font; the text is re-set in ${std}. Check it with render_page.`);
    }
    const before = rectNorm(it.rect); doc.updateItem(it, patch, 'Edit Text'); this.refresh(doc, [pm.index]);
    const after = rectNorm(it.rect); if (after[2] - after[0] > (before[2] - before[0]) * 1.15 + 2) notes.push(`The text is ${Math.round(after[2] - after[0] - (before[2] - before[0]))} pt wider than before; check it doesn't run into neighbouring content.`);
    return { edited: id, element: this.describe(pm, it) };
  },
  async replace_text({ doc: ref, find, replace, pages, case_sensitive = true, regex = false }) {
    const doc = this.doc(ref); if (!find) fail('find is empty.'); const re = makeRe(find, { case_sensitive, regex, global: true }); const changed = []; let pushed = false;
    for (const pm of this.pages(doc, pages)) {
      await this.scan(pm);
      for (const it of pm.visibleItems()) {
        const t = textOf(it); if (t == null) continue; re.lastIndex = 0; if (!re.test(t)) continue; re.lastIndex = 0; const nt = t.replace(re, regex ? replace : () => replace);
        if (nt === t) continue; if (!pushed) { doc.pushUndo('Replace Text'); pushed = true; }
        if (it.kind === 'annot') { doc.updateItem(it, { props: { contents: nt } }, '', { undo: false }); }
        else { if (it.orig === 'text') { if (!it.origRect) it.origRect = it.rect.slice(); it.origModified = true; } doc.updateItem(it, { props: { text: nt }, rect: fitRect(it, { ...it.props, text: nt }) }, '', { undo: false }); }
        changed.push({ id: it.id, page: pm.index + 1, before: t, after: nt });
      }
    }
    if (changed.length) this.refresh(doc);
    return { replaced: changed.length, elements: changed.slice(0, 100) };
  },
  async add_text({ doc: ref, page, text, x, y, rect, font = 'Helvetica', font_size = 12, color = '#000000', bold, italic, align, background, line_height }) {
    const doc = this.doc(ref); const pm = this.page(doc, page); if (!text) fail('text is empty.');
    const it = newItem('object', rect ? 'ftext' : 'text'); const p = it.props;
    Object.assign(p, { text, fontFamily: font, fontSize: font_size, color: checkColor(color), bold: !!bold, italic: !!italic, align: align || 'left', fillColor: background || null, lineWidth: 0, lineHeight: line_height || 1.2 });
    if (rect) { it.rect = this.toUser(pm, rect); }
    else { if (x == null || y == null) fail('Give x and y (top-left of the text) or rect.'); p.nowrap = true; const lines = text.split('\n'); const w = Math.max(...lines.map(l => measureText(l, font_size, p))) + 2; const h = Math.max(font_size * 1.2, lines.length * font_size * p.lineHeight); it.rect = this.toUser(pm, [x, y, x + w, y + h]); }
    doc.addItem(pm.index, it, 'Add Text'); this.refresh(doc, [pm.index]);
    return { added: this.describe(pm, it) };
  },

  // graphics & annotations
  async add_image({ doc: ref, page, path, x, y, rect, keep_aspect = true, opacity }) {
    const doc = this.doc(ref); const pm = this.page(doc, page); const bytes = await this.readFile(path);
    const data = await readFileDataUrl(new Blob([bytes], { type: mimeOf(path) })); const im = await loadImage(data).catch(() => fail(`${path} is not an image the app can read (PNG, JPEG, GIF, WebP, BMP).`));
    const v = this.vp(pm); let box;
    if (rect) { checkRect(rect); box = rectNorm(rect); if (keep_aspect) { const bw = box[2] - box[0], bh = box[3] - box[1]; const s = Math.min(bw / im.naturalWidth, bh / im.naturalHeight); const w = im.naturalWidth * s, h = im.naturalHeight * s; const ox = box[0] + (bw - w) / 2, oy = box[1] + (bh - h) / 2; box = [ox, oy, ox + w, oy + h]; } }
    else { if (x == null || y == null) fail('Give x and y (top-left) or rect.'); let w = im.naturalWidth * 0.75, h = im.naturalHeight * 0.75; const s = Math.min(1, (v.width - x) / w, (v.height - y) / h); w *= s; h *= s; box = [x, y, x + w, y + h]; }
    const it = newItem('object', 'image'); it.rect = this.toUser(pm, box); it.props = { imageData: data, opacity: opacity ?? 1, fileName: baseName(path), naturalWidth: im.naturalWidth, naturalHeight: im.naturalHeight };
    doc.addItem(pm.index, it, 'Add Image'); this.refresh(doc, [pm.index]); return { added: this.describe(pm, it) };
  },
  async add_shape({ doc: ref, page, shape, rect, points, stroke = '#000000', fill, width = 1, opacity }) {
    const doc = this.doc(ref); const pm = this.page(doc, page); const it = newItem('object', shape);
    Object.assign(it.props, { color: width > 0 ? checkColor(stroke) : null, fillColor: fill ? checkColor(fill) : null, lineWidth: width, opacity: opacity ?? 1 });
    if (shape === 'line') { const pts = points?.length === 2 ? points : rect ? [[rect[0], rect[1]], [rect[2], rect[3]]] : fail('A line needs points [[x0,y0],[x1,y1]] or rect.'); it.points = pts.map(([px, py]) => this.ptUser(pm, px, py)); it.rect = rectNorm([...it.points[0], ...it.points[1]]); if (!it.props.color) fail('A line needs width > 0.'); }
    else { if (!rect) fail(`A ${shape} needs rect.`); it.rect = this.toUser(pm, rect); if (!it.props.color && !it.props.fillColor) fail('Give a fill colour or width > 0, or the shape is invisible.'); }
    doc.addItem(pm.index, it, 'Add ' + OBJECT_TYPES[shape]); this.refresh(doc, [pm.index]); return { added: this.describe(pm, it) };
  },
  async add_annotation({ doc: ref, page, type, rect, text, color, stamp, font_size, author }) {
    const app = this.app; const doc = this.doc(ref); const pm = this.page(doc, page); const it = newItem('annot', type);
    Object.assign(it.props, app.editor.annotProps(color ? { color: checkColor(color) } : {})); if (author) it.props.author = author;
    const need = () => rect || fail(`A ${type} annotation needs rect.`);
    if (type === 'note') { const r = need(); const [ux, uy] = this.ptUser(pm, r[0], r[1]); it.rect = [ux, uy - 20, ux + 20, uy]; Object.assign(it.props, { icon: 'Comment', contents: text || '', color: color || '#ffd400' }); }
    else if (type === 'typewriter') { it.rect = this.toUser(pm, need()); Object.assign(it.props, { contents: text || '', fontSize: font_size || settings.comments.fontSize || 12, fontFamily: 'Helvetica', textColor: color || '#000000', color: color || '#000000', fillColor: null, borderColor: null, borderWidth: 0, align: 'left' }); }
    else if (['highlight', 'underline', 'strikeout', 'squiggly'].includes(type)) {
      let quads;
      if (rect) quads = [this.toUser(pm, rect)];
      else { if (!text) fail(`A ${type} needs rect or the text to mark.`); quads = await textQuads(app, pm, text); if (!quads.length) fail(`“${text}” is not on page ${page}.`); }
      it.quads = quads; it.rect = RL.union(quads); it.props.color = color || { highlight: '#ffff00', underline: '#00a000', strikeout: '#ff0000', squiggly: '#00a000' }[type]; if (text && !rect) it.props.contents = '';
    }
    else if (type === 'rect' || type === 'ellipse') { it.rect = this.toUser(pm, need()); it.props.color = color || '#ff0000'; if (text) it.props.contents = text; }
    else if (type === 'stamp') { const name = (stamp || 'APPROVED').toUpperCase(); const r = rect || fail('A stamp needs rect (its box, or just where its top-left goes).'); const w = Math.max(90, name.length * 13), h = 44; const box = r[2] > r[0] + 5 && r[3] > r[1] + 5 ? r : [r[0], r[1], r[0] + w, r[1] + h]; it.rect = this.toUser(pm, box); Object.assign(it.props, { stampName: name, subject: name, color: color || '#cc1a1a' }); }
    else if (type === 'redact') { it.rect = this.toUser(pm, need()); Object.assign(it.props, { fillColor: settings.redaction.fillColor, overlayText: settings.redaction.overlayText, textColor: settings.redaction.textColor, color: '#d00000', subject: 'Redaction' }); }
    else fail(`Unknown annotation type ${type}.`);
    if (text && type !== 'note' && type !== 'typewriter' && rect) it.props.contents = text;
    doc.addItem(pm.index, it, 'Add ' + (ANNOT_TYPES[type] || type)); this.refresh(doc, [pm.index]); return { added: this.describe(pm, it) };
  },
  async apply_redactions({ doc: ref }) {
    const doc = this.doc(ref); const marks = doc.allItems().filter(i => i.kind === 'annot' && i.type === 'redact' && !i.props.applied); if (!marks.length) fail('There are no redaction marks (add_annotation type=redact).');
    const pages = [...new Set(marks.map(m => doc.pageOf(m).index))]; doc.pushUndo('Apply Redactions');
    for (const m of marks) { const pm = doc.pageOf(m); const cover = newItem('object', 'cover'); cover.rect = m.rect.slice(); cover.props.fillColor = m.props.fillColor || '#000000'; pm.items.push(cover); if (m.props.overlayText) { const t = newItem('object', 'text'); t.rect = m.rect.slice(); Object.assign(t.props, { text: m.props.overlayText, color: m.props.textColor || '#ff0000', fontSize: Math.min(10, (m.rect[3] - m.rect[1]) * 0.7), align: 'center' }); pm.items.push(t); } if (m.orig) { m.deleted = true; m.origModified = true; } else pm.items.splice(pm.items.indexOf(m), 1); }
    await this.structural(doc, async () => { if (!(await ops.applyTrueRedaction(doc, marks))) fail('MuPDF is not available, so the content could not be removed.'); });
    return { applied: marks.length, pages: pages.map(i => i + 1) };
  },
  async update_element({ doc: ref, id, rect, color, fill, width, opacity, font_size, text_color, contents }) {
    const doc = this.doc(ref); const it = this.item(doc, id); const pm = doc.pageOf(it); const props = {}; const patch = {};
    if (rect) { if (RL.isExact(it)) fail(`${id} is original page content: use move_elements to move it.`); const nr = this.toUser(pm, rect); if (it.points || it.paths || it.quads) { const ob = rectNorm(this.app.editor.bboxOf(it)); const sx = (nr[2] - nr[0]) / Math.max(1e-6, ob[2] - ob[0]), sy = (nr[3] - nr[1]) / Math.max(1e-6, ob[3] - ob[1]); const f = ([px, py]) => [nr[0] + (px - ob[0]) * sx, nr[1] + (py - ob[1]) * sy]; if (it.points) patch.points = it.points.map(f); if (it.paths) patch.paths = it.paths.map(pt => pt.map(f)); if (it.quads) patch.quads = it.quads.map(q => [...f([q[0], q[1]]), ...f([q[2], q[3]])]); } patch.rect = nr; }
    if (color !== undefined) { if (it.kind === 'field') props.borderColor = color; else props.color = color; }
    if (fill !== undefined) props.fillColor = fill; if (width !== undefined) { if (it.kind === 'field') props.borderWidth = width; else props.lineWidth = width; } if (opacity !== undefined) props.opacity = opacity;
    if (font_size !== undefined) props.fontSize = font_size; if (text_color !== undefined) props[it.kind === 'object' ? 'color' : 'textColor'] = text_color; if (contents !== undefined) props.contents = contents;
    if (!Object.keys(props).length && !patch.rect) fail('Nothing to change.'); if (Object.keys(props).length) patch.props = props;
    if (RL.isExact(it) && it.orig === 'vector') { // original graphics are restyled in the PDF itself (in place)
      const style = {}; for (const k of ['color', 'fillColor', 'lineWidth', 'opacity']) if (k in props) style[k] = props[k] === 'none' ? null : props[k];
      if (!Object.keys(style).length) fail(`${id} is an original graphic: only color, fill, width and opacity can be changed here.`);
      if (doc !== this.app.doc) this.app.activate?.(doc); const res = await this.app.restyleVectors([it], style, 'Edit'); if (!res) fail('The change did not happen.');
      for (const i of res.touched) await this.scan(doc.pages[i]); this.refresh(doc, res.touched); const nit = RL.resolveTargets(doc, res.targets)[0];
      return { updated: nit ? this.describe(pm, nit) : null };
    }
    doc.updateItem(it, patch, 'Edit'); this.refresh(doc, [pm.index]); return { updated: this.describe(pm, it) };
  },

  // re-layout
  async move_elements({ doc: ref, ids, dx = 0, dy = 0, to_page, scale = 1 }, { notes }) {
    const doc = this.doc(ref); const { its, pm } = this.items(doc, ids); return this.move(doc, pm, its, { dx, dy, toPage: to_page, scale }, notes);
  },
  async move_region({ doc: ref, page, rect, dx = 0, dy = 0, to_page, scale = 1, partial = false }, { notes }) {
    const doc = this.doc(ref); const pm = this.page(doc, page); const its = await this.regionItems(pm, rect, { partial }); if (!its.length) fail('Nothing lies inside that box.');
    return this.move(doc, pm, its, { dx, dy, toPage: to_page, scale }, notes);
  },
  async flow_to_previous_page({ doc: ref, page, ids, rect, spacing = null, close_boxes = true, pull_up = true, dry_run = false }, { notes }) {
    const app = this.app; const doc = this.doc(ref); let its, pm;
    if (ids?.length) ({ its, pm } = this.items(doc, ids)); else if (rect) { pm = this.page(doc, page ?? fail('page is needed with rect.')); its = await this.regionItems(pm, rect, {}); if (!its.length) fail('Nothing lies inside that box.'); } else fail('Give the section as ids (e.g. its box) or rect.');
    if (pm.index === 0) fail('The section is on page 1, which has no previous page.');
    await this.scan(pm); await this.scan(doc.pages[pm.index - 1]); if (app.tool !== 'editdoc') app.setTool('editdoc'); app.editor.select(its);
    const plan = app.flowPlanner()({ spacing }); const description = RL.describeFlow(plan, pull_up);
    if (dry_run) return { dry_run: true, plan: description, available: r1(plan.available), section_height: r1(plan.box.y1 - plan.box.y0), split: plan.cut != null, elements: plan.sel.length };
    const res = await app.flowSelection({ plan, closeBoxes: close_boxes, pullUp: pull_up }); if (!res) fail('The section was not moved' + (notes.length ? ': ' + notes.join(' ') : '.'));
    return { plan: description, ...(await this.afterRelayout(doc, res)) };
  },

  // forms
  async list_form_fields({ doc: ref, pages }) {
    const doc = this.doc(ref, { activate: false }); const out = [];
    for (const pm of this.pages(doc, pages)) for (const f of pm.fields()) { if (f.type === 'link') continue; const p = f.props; out.push({ id: f.id, name: p.name, type: f.type, page: pm.index + 1, rect: this.toTop(pm, f.rect), ...(['checkbox', 'radio'].includes(f.type) ? { checked: !!p.checked, export_value: p.exportValue } : { value: p.value }), ...(p.options?.length ? { options: p.options.map(o => o.value ?? o.label) } : {}), ...(p.tooltip ? { tooltip: p.tooltip } : {}), ...(p.readOnly ? { read_only: true } : {}), ...(p.required ? { required: true } : {}), ...(p.multiline ? { multiline: true } : {}) }); }
    return { fields: out };
  },
  async fill_form({ doc: ref, values }) {
    const doc = this.doc(ref); const fields = doc.allItems().filter(i => i.kind === 'field' && i.type !== 'link'); const done = [], missing = [], issues = []; let pushed = false;
    const begin = () => { if (!pushed) { doc.pushUndo('Fill Form'); pushed = true; } };
    for (const [name, val] of Object.entries(values || {})) {
      const group = fields.filter(f => f.props.name === name); if (!group.length) { missing.push(name); continue; }
      const t = group[0].type;
      if (t === 'checkbox') { const on = typeof val === 'string' ? !/^(false|off|no|0|)$/i.test(val) || val === group[0].props.exportValue : !!val; begin(); for (const f of group) doc.updateItem(f, { props: { checked: on, value: on ? f.props.exportValue : 'Off' } }, '', { undo: false }); }
      else if (t === 'radio') { const v = String(val); const hit = group.find(f => f.props.exportValue === v); if (!hit && v !== 'Off') { issues.push(`${name}: no button with export value “${v}” (choices: ${group.map(f => f.props.exportValue).join(', ')})`); continue; } begin(); for (const f of group) doc.updateItem(f, { props: { checked: f === hit, value: hit ? v : 'Off' } }, '', { undo: false }); }
      else if (t === 'signature' || t === 'button') { issues.push(`${name} is a ${t} field and can't be filled with a value.`); continue; }
      else { const v = Array.isArray(val) ? val.join(',') : String(val ?? ''); const opts = group[0].props.options || []; if ((t === 'combo' && !group[0].props.editable || t === 'list') && opts.length && !opts.some(o => (o.value ?? o.label) === v || o.label === v)) issues.push(`${name}: “${v}” is not one of its options (${opts.map(o => o.value ?? o.label).join(', ')}); set anyway.`); begin(); for (const f of group) doc.updateItem(f, { props: { value: v } }, '', { undo: false }); }
      done.push(name);
    }
    if (pushed) { try { this.app.recalculate?.(); } catch { } this.refresh(doc); }
    return { filled: done, ...(missing.length ? { not_found: missing } : {}), ...(issues.length ? { issues } : {}) };
  },
  async add_form_field({ doc: ref, page, type, rect, name, value, options, export_value, tooltip, multiline, required, read_only, font_size, caption }) {
    const doc = this.doc(ref); const pm = this.page(doc, page); const f = newItem('field', type); f.rect = this.toUser(pm, rect); const p = f.props;
    const n = doc.allItems().filter(i => i.kind === 'field' && i.type === type).length + 1; p.name = name || `${FIELD_TYPES[type].replace(/\s/g, '')}${n}`;
    if (type !== 'radio' && name && doc.allItems().some(i => i.kind === 'field' && i.props.name === name)) fail(`A field named “${name}” already exists.`);
    if (type === 'button') p.caption = caption || 'Button'; if (type === 'checkbox') p.exportValue = export_value || 'Yes';
    if (type === 'radio') { p.name = name || 'RadioGroup1'; p.exportValue = export_value || `Choice${n}`; p.checkStyle = 'circle'; }
    if (type === 'combo' || type === 'list') p.options = (options?.length ? options : ['Item 1', 'Item 2']).map(o => ({ label: String(o), value: String(o) }));
    if (['text', 'combo', 'list'].includes(type)) p.borderColor = '#000000'; p.fillColor = type === 'button' ? '#e6e6e6' : '#ffffff';
    if (tooltip) p.tooltip = tooltip; if (multiline) p.multiline = true; if (required) p.required = true; if (read_only) p.readOnly = true; if (font_size != null) p.fontSize = font_size;
    if (value !== undefined) { if (['checkbox', 'radio'].includes(type)) { p.checked = value === true || value === p.exportValue; p.value = p.checked ? p.exportValue : 'Off'; } else p.value = String(value); }
    doc.addItem(pm.index, f, 'Add ' + FIELD_TYPES[type]); this.refresh(doc, [pm.index]); return { added: this.describe(pm, f) };
  },
  async update_form_field({ doc: ref, field, name, rect, value, options, tooltip, multiline, required, read_only, font_size, border_color, fill_color, text_color }) {
    const doc = this.doc(ref); const f = this.field(doc, field); const pm = doc.pageOf(f); const props = {}; const patch = {};
    if (name != null && name !== f.props.name) { if (f.type !== 'radio' && doc.allItems().some(i => i.kind === 'field' && i !== f && i.props.name === name)) fail(`A field named “${name}” already exists.`); props.name = name; }
    if (rect) patch.rect = this.toUser(pm, rect);
    if (value !== undefined) { if (['checkbox', 'radio'].includes(f.type)) { props.checked = value === true || value === f.props.exportValue; props.value = props.checked ? f.props.exportValue : 'Off'; } else props.value = String(value); }
    if (options) props.options = options.map(o => ({ label: String(o), value: String(o) })); if (tooltip != null) props.tooltip = tooltip; if (multiline != null) props.multiline = multiline; if (required != null) props.required = required; if (read_only != null) props.readOnly = read_only;
    if (font_size != null) props.fontSize = font_size; if (border_color !== undefined) props.borderColor = border_color; if (fill_color !== undefined) props.fillColor = fill_color; if (text_color) props.textColor = text_color;
    if (!Object.keys(props).length && !patch.rect) fail('Nothing to change.'); patch.props = props;
    doc.updateItem(f, patch, 'Edit Field'); this.refresh(doc, [pm.index]); return { updated: this.describe(pm, f) };
  },
  async delete_form_field({ doc: ref, field }) {
    const doc = this.doc(ref); const byId = doc.findItem(field); const its = byId?.kind === 'field' && !byId.deleted ? [byId] : doc.allItems().filter(i => i.kind === 'field' && i.props.name === field);
    if (!its.length) fail(`No field “${field}”.`); const pages = [...new Set(its.map(i => doc.pageOf(i).index))]; doc.removeItems(its, 'Delete Field'); this.refresh(doc, pages); return { deleted: its.length, name: its[0].props.name };
  },
  async flatten_form({ doc: ref }) {
    const doc = this.doc(ref); const n = doc.allItems().filter(i => i.kind === 'field' && i.type !== 'link').length; if (!n) fail('The document has no form fields.');
    // Bake first so the current values (and any other pending edits) are what gets flattened.
    await this.structural(doc, async () => {
      doc.pushUndo('Flatten Forms'); const bytes = await ops.saveBytes(doc, {});
      doc.pages.forEach(p => { p.items = []; p.imported = false; p.scan = null; p.textContent = null; }); await doc.load(bytes);
      const lib = await ops.libLoad(doc); lib.getForm().flatten(); const out = await ops.libSave(lib);
      doc.pages.forEach(p => { p.items = p.items.filter(it => it.kind !== 'field'); }); doc.encrypted = false; doc.password = null; await doc.load(out, { keepPages: doc.pages.slice() }); doc.modified = true; doc.emit('modified');
    });
    return { flattened: n };
  },

  // pages
  async delete_pages({ doc: ref, pages }) { const doc = this.doc(ref); const idx = [...new Set(this.pages(doc, pages).map(p => p.index))]; if (idx.length >= doc.pages.length) fail('A document must keep at least one page.'); await this.structural(doc, () => ops.deletePages(doc, idx)); return { deleted: idx.map(i => i + 1), pages: doc.pages.length }; },
  async move_pages({ doc: ref, pages, to, order }) {
    const doc = this.doc(ref); const n = doc.pages.length; let ord;
    if (order) { ord = order.map(k => k - 1); if (ord.length !== n || new Set(ord).size !== n || ord.some(k => !(k >= 0 && k < n))) fail(`order must list every page 1..${n} exactly once.`); }
    else { if (!pages?.length || !to) fail('Give pages and to, or order.'); const mv = [...new Set(this.pages(doc, pages).map(p => p.index))].sort((a, b) => a - b); const rest = doc.pages.map((_, i) => i).filter(i => !mv.includes(i)); const at = Math.max(0, Math.min(rest.length, to - 1)); ord = [...rest.slice(0, at), ...mv, ...rest.slice(at)]; }
    if (ord.every((k, i) => k === i)) return { order: ord.map(k => k + 1), note: 'Already in that order.' };
    await this.structural(doc, () => ops.structural(doc, 'Move Pages', (lib) => { const pg = lib.getPages(); for (let i = pg.length - 1; i >= 0; i--) lib.removePage(i); ord.forEach(k => lib.addPage(pg[k])); return ord.map(k => doc.pages[k]); }));
    return { order: ord.map(k => k + 1) };
  },
  async insert_blank_page({ doc: ref, after, count = 1, width, height }) {
    const doc = this.doc(ref); const at = after == null ? doc.pages.length : after; if (at < 0 || at > doc.pages.length) fail(`after must be 0..${doc.pages.length}.`);
    const near = doc.pages[Math.max(0, Math.min(doc.pages.length - 1, at - 1))]; const v = this.vp(near); const rot = near.rotate % 180 !== 0;
    await this.structural(doc, () => ops.insertBlankPages(doc, { index: at, count, width: width || (rot ? v.height : v.width), height: height || (rot ? v.width : v.height) }));
    return { inserted: Array.from({ length: count }, (_, k) => at + k + 1), pages: doc.pages.length };
  },
  async duplicate_page({ doc: ref, page, copies = 1 }) {
    const doc = this.doc(ref); const pm = this.page(doc, page); const bytes = await ops.saveBytes(doc, {});
    await this.structural(doc, () => ops.insertFromBytes(doc, { bytes, index: pm.index + 1, pages: Array(copies).fill(pm.index) }));
    return { copies: Array.from({ length: copies }, (_, k) => page + k + 1), pages: doc.pages.length };
  },
  async rotate_pages({ doc: ref, pages, degrees }) { const doc = this.doc(ref); const idx = this.pages(doc, pages).map(p => p.index); await this.structural(doc, () => ops.rotatePages(doc, idx, degrees)); return { rotated: idx.map(i => i + 1), rotation: idx.map(i => doc.pages[i].rotate) }; },
  async insert_pages_from_pdf({ doc: ref, path, pages, after, password }) {
    const app = this.app; const doc = this.doc(ref); const raw = await this.readFile(path); const at = after == null ? doc.pages.length : after; if (at < 0 || at > doc.pages.length) fail(`after must be 0..${doc.pages.length}.`);
    const bytes = /\.pdf$/i.test(path) ? raw : await app.fileToPdfBytes(new File([raw], baseName(path)));
    const before = doc.pages.length; await this.structural(doc, () => ops.insertFromBytes(doc, { bytes, index: at, pages: pages?.length ? pages.map(k => k - 1) : null, password: password || '' }));
    const added = doc.pages.length - before; return { inserted: Array.from({ length: added }, (_, k) => at + k + 1), pages: doc.pages.length };
  },
  async crop_page({ doc: ref, pages, rect }) { const doc = this.doc(ref); const list = this.pages(doc, pages); const box = this.toUser(list[0], rect); await this.structural(doc, () => ops.cropPages(doc, list.map(p => p.index), box)); const v = this.vp(doc.pages[list[0].index]); return { cropped: list.map(p => p.index + 1), size: [r1(v.width), r1(v.height)] }; },
  async extract_pages({ doc: ref, pages, output_path }) {
    const doc = this.doc(ref, { activate: false }); if (!/^([a-zA-Z]:)?[\\/]/.test(output_path || '')) fail('output_path must be absolute.'); const idx = this.pages(doc, pages).map(p => p.index);
    const [f] = await ops.extractPages(doc, idx, {}); await window.native.writeFile(output_path, f.bytes); return { written: output_path, pages: idx.length, bytes: f.bytes.length };
  },

  // the app
  async show_page({ doc: ref, page, select }) {
    const app = this.app; const doc = this.doc(ref); const pm = this.page(doc, page); app.goTo(pm.index);
    if (select?.length) { await this.scan(pm); const its = select.map(id => this.item(doc, id)).filter(it => doc.pageOf(it) === pm); if (app.tool !== 'editdoc') app.setTool('editdoc'); app.editor.select(its); }
    return { showing: page, selected: select?.length || 0 };
  },
  async screenshot_app() { if (!window.native?.capturePage) fail('Screenshots need the desktop app.'); const png = await window.native.capturePage(); return { image: bytesToBase64(png), text: 'The Master PDF Editor window.' }; },
};
Agent.prototype.field = function (doc, ref) { const it = doc.findItem(ref); if (it?.kind === 'field' && !it.deleted) return it; const byName = doc.allItems().filter(i => i.kind === 'field' && i.props.name === ref); if (!byName.length) fail(`No field “${ref}” (use list_form_fields).`); if (byName.length > 1) fail(`“${ref}” has ${byName.length} widgets; pass one of their ids: ${byName.map(i => i.id).join(', ')}.`); return byName[0]; };

// ---------- helpers ----------
function toContent(out, notes) {
  const content = []; if (out?.image) { content.push({ type: 'image', data: out.image, mimeType: 'image/png' }); const { image, text, ...rest } = out; const t = [text, Object.keys(rest).length ? JSON.stringify(rest) : ''].filter(Boolean).join('\n'); content.push({ type: 'text', text: t + (notes.length ? `\nWarnings: ${notes.join(' ')}` : '') }); return { content }; }
  const body = { ...(out || {}) }; if (notes.length) body.warnings = [...new Set(notes)];
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 1) }] };
}
const kindOf = it => it.kind === 'field' ? 'field' : it.kind === 'annot' ? 'annot' : (it.orig === 'text' || it.orig === 'image' || it.orig === 'vector') ? it.orig : 'object';
const textOf = it => it.kind === 'object' && (it.type === 'text' || it.type === 'ftext') ? (it.props.text ?? '') : it.kind === 'annot' && ['typewriter', 'callout'].includes(it.type) ? (it.props.contents ?? '') : null;
const intersects = (a, b) => { a = rectNorm(a); b = rectNorm(b); return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]; };
const baseName = p => String(p).split(/[\\/]/).pop();
const samePath = (a, b) => String(a).replace(/\\/g, '/').replace(/\/+$/, '') === String(b).replace(/\\/g, '/').replace(/\/+$/, '');
function checkRect(r) { if (!Array.isArray(r) || r.length !== 4 || r.some(v => typeof v !== 'number' || !isFinite(v))) fail('rect must be [x0, y0, x1, y1] (numbers).'); const n = rectNorm(r); if (n[2] - n[0] < 0.1 || n[3] - n[1] < 0.1) fail('rect has no area.'); }
function checkColor(c) { if (c == null) return c; if (!/^#[0-9a-f]{6}$/i.test(c)) fail(`Colour “${c}” must be #rrggbb.`); return c; }
function makeRe(q, { case_sensitive, regex, global = false }) { try { return new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), (case_sensitive ? '' : 'i') + (global ? 'g' : '')); } catch (e) { fail(`Bad regex: ${e.message}`); } }
function mimeOf(p) { const e = p.split('.').pop().toLowerCase(); return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }[e] || 'application/octet-stream'; }
function sameFont(family = '', std) { const f = family.toLowerCase().replace(/[^a-z]/g, ''); const s = String(std).toLowerCase().replace(/[^a-z]/g, ''); return ['helvetica', 'arial', 'times', 'courier'].some(k => f.startsWith(k) && s.startsWith(k === 'arial' ? 'helvetica' : k)); }
function summarizeSizes(sizes) { const u = [...new Set(sizes.map(s => s.join('x')))]; return u.length === 1 ? `${u[0]} pt (all pages)` : sizes.map((s, i) => `${i + 1}: ${s.join('x')}`).join(', '); }
/** The rect a text element needs for `p.text`, kept at its top-left like the app's inline editor does. */
function fitRect(it, p) {
  const fs = p.fontSize || 12; const lines = String(p.text).split('\n'); const w = Math.max(...lines.map(l => measureText(l, fs, p))); const r = rectNorm(it.rect);
  if (it.type === 'text') { const h = Math.max(fs * 1.2, lines.length * fs * (p.lineHeight || 1.2)); return [r[0], r[3] - h, Math.max(r[0] + w + 2, r[0] + 10), r[3]]; }
  const needH = lines.length * fs * (p.lineHeight || 1.2) + 4; return needH > r[3] - r[1] ? [r[0], r[3] - needH, r[2], r[3]] : r;
}
/** Quads (user space) covering each occurrence of `text` on the page. */
async function textQuads(app, pm, text) {
  const tc = pm.textContent || (pm.textContent = await pm.pdfPage.getTextContent()); const full = tc.items.filter(i => 'str' in i).map(i => i.str).join(''); const out = []; const lower = full.toLowerCase(), q = text.toLowerCase();
  for (let k = lower.indexOf(q); k >= 0; k = lower.indexOf(q, k + q.length)) out.push(...await app.quadsForMatch(pm, { index: k, length: q.length }));
  return out;
}
const KIND_COLORS = { text: '#1a5fd0', image: '#c0392b', vector: '#e08a00', field: '#7b2cbf', annot: '#1e8a3c', object: '#d0218a' };
function drawOverlay(ctx, els, s) {
  ctx.save(); ctx.lineWidth = 1; ctx.font = `bold ${Math.max(9, Math.round(7 * s))}px sans-serif`; ctx.textBaseline = 'bottom';
  for (const e of els) { const c = KIND_COLORS[e.kind] || '#333'; const [x0, y0, x1, y1] = e.rect.map(v => v * s); ctx.strokeStyle = c; ctx.globalAlpha = 0.85; ctx.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(1, x1 - x0), Math.max(1, y1 - y0)); const w = ctx.measureText(e.id).width + 4, h = Math.max(10, Math.round(8 * s)); const ly = y0 >= h ? y0 : y1 + h; ctx.globalAlpha = 0.8; ctx.fillStyle = c; ctx.fillRect(x0, ly - h, w, h); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillText(e.id, x0 + 2, ly); }
  ctx.restore();
}
function drawGrid(ctx, w, h, s) {
  ctx.save(); ctx.font = `${Math.max(8, Math.round(6 * s))}px sans-serif`;
  for (let x = 0; x <= w; x += 10) { const major = x % 50 === 0; if (!major && s < 1.5) continue; ctx.strokeStyle = major ? 'rgba(0,120,255,.45)' : 'rgba(0,120,255,.12)'; ctx.lineWidth = x % 100 === 0 ? 1 : 0.5; ctx.beginPath(); ctx.moveTo(x * s, 0); ctx.lineTo(x * s, h * s); ctx.stroke(); if (x % 100 === 0) { ctx.fillStyle = 'rgba(0,80,200,.9)'; ctx.fillText(String(x), x * s + 2, 10 * s / 1.5 + 2); } }
  for (let y = 0; y <= h; y += 10) { const major = y % 50 === 0; if (!major && s < 1.5) continue; ctx.strokeStyle = major ? 'rgba(0,120,255,.45)' : 'rgba(0,120,255,.12)'; ctx.lineWidth = y % 100 === 0 ? 1 : 0.5; ctx.beginPath(); ctx.moveTo(0, y * s); ctx.lineTo(w * s, y * s); ctx.stroke(); if (y % 100 === 0 && y) { ctx.fillStyle = 'rgba(0,80,200,.9)'; ctx.fillText(String(y), 2, y * s - 2); } }
  ctx.restore();
}

export function installAgent(app) { const agent = new Agent(app); window.mpeAgent = agent; return agent; }
