import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { uid, clone, pdfjsColorToHex, nowIso, rectNorm, applyMatrix, mulMatrix, settings } from './util.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
export { pdfjsLib };
const CMAP_URL = new URL('../vendor/cmaps/', import.meta.url).href;
const FONT_URL = new URL('../vendor/standard_fonts/', import.meta.url).href;

export const ANNOT_TYPES = { note: 'Sticky Note', typewriter: 'Typewriter', callout: 'Callout', label: 'Label', distance: 'Distance', area: 'Area', perimeter: 'Perimeter', arrow: 'Arrow', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', ink: 'Pencil', brush: 'Brush', polygon: 'Polygon', cloud: 'Cloud', stamp: 'Stamp', highlight: 'Highlight', strikeout: 'Strikeout', underline: 'Underline', squiggly: 'Squiggly', fileattach: 'File Attachment', redact: 'Redaction', caret: 'Caret', link: 'Link', other: 'Annotation' };
export const OBJECT_TYPES = { text: 'Text', ftext: 'Formatted Text', image: 'Image', line: 'Line', rect: 'Rectangle', ellipse: 'Ellipse', ink: 'Pencil', initials: 'Initials', vector: 'Vector', cover: 'Cover' };
export const FIELD_TYPES = { text: 'Text Field', checkbox: 'Check Box', radio: 'Radio Button', combo: 'Combo Box', list: 'List Box', button: 'Button', signature: 'Signature', link: 'Link' };
export const NOTE_ICONS = ['Comment', 'Note', 'Key', 'Help', 'NewParagraph', 'Paragraph', 'Insert', 'Check', 'Circle', 'Cross', 'RightArrow', 'RightPointer', 'Star', 'UpArrow', 'UpLeftArrow'];
export const STAMPS = ['APPROVED', 'NOT APPROVED', 'DRAFT', 'FINAL', 'COMPLETED', 'CONFIDENTIAL', 'FOR PUBLIC RELEASE', 'NOT FOR PUBLIC RELEASE', 'FOR COMMENT', 'VOID', 'PRELIMINARY RESULTS', 'INFORMATION ONLY', 'SIGN HERE', 'WITNESS', 'INITIAL HERE', 'ACCEPTED', 'REJECTED', 'REVIEWED', 'RECEIVED', 'EXPERIMENTAL', 'TOP SECRET', 'AS IS', 'DEPARTMENTAL', 'SOLD', 'REVISED'];
export const COMMENT_STATUS = ['None', 'Accepted', 'Rejected', 'Cancelled', 'Completed'];
export const MAX_UNDO = 40;

export function author() { return settings.comments.author || settings.general.author || 'User'; }
export function newItem(kind, type, extra = {}) {
  const base = { id: uid(kind[0]), kind, type, rect: [0, 0, 10, 10], rotation: 0, props: {}, orig: null, deleted: false };
  const p = base.props;
  if (kind === 'annot') Object.assign(p, { author: author(), subject: ANNOT_TYPES[type] || type, contents: '', created: nowIso(), modified: nowIso(), color: settings.comments.color, fillColor: null, opacity: settings.comments.opacity / 100, lineWidth: settings.comments.lineWidth, lineStyle: 'solid', status: 'None', replies: [], hidden: false, locked: false, printable: true });
  if (kind === 'object') Object.assign(p, { color: '#000000', fillColor: null, lineWidth: 1, opacity: 1, fontFamily: settings.editing.defaultFont, fontSize: settings.editing.defaultFontSize, text: '', align: 'left', charSpacing: 0, wordSpacing: 0, lineHeight: 1.2 });
  if (kind === 'field') Object.assign(p, { name: '', tooltip: '', readOnly: false, required: false, hidden: false, printable: true, borderColor: '#000000', fillColor: null, textColor: '#000000', borderWidth: 1, borderStyle: 'solid', fontFamily: 'Helvetica', fontSize: 0, value: '', defaultValue: '', options: [], exportValue: 'Yes', checked: false, checkStyle: 'check', multiline: false, password: false, scrollable: true, spellCheck: false, maxLen: 0, comb: 0, align: 'left', richText: false, multiSelect: false, editable: false, sort: false, commitImmediately: false, caption: '', downCaption: '', rolloverCaption: '', behavior: 'push', actions: [], tabIndex: 0 });
  Object.assign(base, extra);
  return base;
}

export class PageModel {
  constructor(doc, index) { this.doc = doc; this.index = index; this.key = uid('pg'); this.items = []; this.scan = null; this.renderVersion = 0; this.pdfPage = null; this.width = 612; this.height = 792; this.rotate = 0; this.userUnit = 1; this.imported = false; }
  get viewport1() { return this.pdfPage.getViewport({ scale: 1 }); }
  visibleItems() { return this.items.filter(i => !i.deleted); }
  annots() { return this.visibleItems().filter(i => i.kind === 'annot'); }
  fields() { return this.visibleItems().filter(i => i.kind === 'field'); }
  objects() { return this.visibleItems().filter(i => i.kind === 'object'); }
}

export class PdfDoc {
  constructor({ name = 'Untitled.pdf', handle = null, path = null } = {}) {
    this.id = uid('d'); this.name = name; this.handle = handle; this.path = path; this.bytes = null; this.pdf = null; this.pages = [];
    this.modified = false; this.undoStack = []; this.redoStack = []; this.password = null; this.meta = {}; this.outline = []; this.attachments = []; this.layers = []; this.docJs = []; this.docActions = {}; this.permissions = null; this.encrypted = false;
    this.pageLabels = null; this.viewHistory = []; this.viewIndex = -1; this.formValues = {}; this.removedAttachments = []; this.security = null; this.ocConfig = null; this.initialView = {};
    this.lastView = { page: 0, zoom: null, scrollTop: 0, scrollLeft: 0 }; this.listeners = new Set(); this.pendingRedactions = 0; this.hasForms = false; this.tabOrder = {}; this.pageActions = {}; this.pageLayout = null;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const l of this.listeners) l(type, data); }
  get displayName() { return (this.modified ? '*' : '') + this.name; }

  async load(bytes, { password = null, keepPages = null } = {}) {
    this.bytes = bytes;
    const task = pdfjsLib.getDocument({ data: bytes.slice(), password: password ?? this.password ?? undefined, cMapUrl: CMAP_URL, cMapPacked: true, standardFontDataUrl: FONT_URL, enableXfa: false, isEvalSupported: false });
    task.onPassword = (cb, reason) => { task._needsPassword = reason; throw Object.assign(new Error('password'), { name: 'PasswordException', code: reason }); };
    try { this.pdf = await task.promise; } catch (e) { if (e.name === 'PasswordException' || /password/i.test(e.message)) { const err = new Error('password'); err.name = 'PasswordException'; err.wrongPassword = !!password; throw err; } throw e; }
    if (password) this.password = password;
    const n = this.pdf.numPages;
    const oldPages = this.pages;
    this.pages = [];
    for (let i = 0; i < n; i++) {
      const pm = keepPages ? (keepPages[i] || new PageModel(this, i)) : new PageModel(this, i);
      pm.index = i; pm.doc = this;
      pm.pdfPage = await this.pdf.getPage(i + 1);
      const vp = pm.pdfPage.getViewport({ scale: 1 });
      pm.width = vp.width; pm.height = vp.height; pm.rotate = pm.pdfPage.rotate; pm.userUnit = pm.pdfPage.userUnit || 1; pm.scan = null; pm.renderVersion++;
      this.pages.push(pm);
    }
    if (!keepPages) { for (const pm of this.pages) await this.importAnnotations(pm); }
    else for (const pm of this.pages) if (!pm.imported) await this.importAnnotations(pm);
    await this.readMetadata();
    this.emit('reload');
    return this;
  }
  async readMetadata() {
    try { const m = await this.pdf.getMetadata(); this.meta = m.info || {}; this.metaXmp = m.metadata; } catch { this.meta = {}; }
    try { this.permissions = await this.pdf.getPermissions(); this.encrypted = this.permissions != null; } catch { }
    try { this.outline = await this.readOutline(); } catch { this.outline = []; }
    try { const a = await this.pdf.getAttachments(); this.attachments = a ? Object.entries(a).map(([k, v]) => ({ id: uid('at'), name: v.filename || k, content: v.content, size: v.content?.length || 0, orig: true, description: '' })).filter(x => !this.removedAttachments.includes(x.name)) : []; } catch { this.attachments = []; }
    try { this.ocConfig = await this.pdf.getOptionalContentConfig(); this.layers = this.ocConfig ? (this.ocConfig.getOrder() || []).flatMap(id => typeof id === 'string' ? [{ id, ...this.ocConfig.getGroup(id) }] : []) : []; } catch { this.layers = []; }
    try { this.pageLabels = await this.pdf.getPageLabels(); } catch { }
    try { const js = await this.pdf.getJSActions(); if (js) this.catalogJs = js; } catch { }
    this.hasForms = this.pages.some(p => p.fields().length > 0);
  }
  async readOutline() {
    const ol = await this.pdf.getOutline(); if (!ol) return [];
    const conv = async (items) => { const out = []; for (const it of items) { let page = null, dest = it.dest; try { if (typeof dest === 'string') dest = await this.pdf.getDestination(dest); if (Array.isArray(dest) && dest[0]) page = typeof dest[0] === 'object' ? await this.pdf.getPageIndex(dest[0]) : dest[0]; } catch { } out.push({ id: uid('bm'), title: it.title, page, url: it.url || null, zoom: Array.isArray(dest) && dest[1]?.name === 'XYZ' ? dest[4] : null, top: Array.isArray(dest) && dest[1]?.name === 'XYZ' ? dest[3] : null, bold: it.bold, italic: it.italic, color: it.color ? pdfjsColorToHex(it.color) : null, open: true, children: await conv(it.items || []), actions: [] }); } return out; };
    return conv(ol);
  }
  async importAnnotations(pm) {
    pm.imported = true;
    let annots = []; try { annots = await pm.pdfPage.getAnnotations({ intent: 'display' }); } catch { return; }
    for (const a of annots) {
      const item = importAnnotation(a, pm); if (item) pm.items.push(item);
    }
  }
  // Item operations (all undoable)
  snapshot() { return { bytes: this.bytes, pages: this.pages.map(p => ({ key: p.key, items: clone(p.items) })), outline: clone(this.outline), attachments: this.attachments.map(a => ({ ...a })), docJs: clone(this.docJs), docActions: clone(this.docActions), meta: clone(this.meta) }; }
  pushUndo(label = '') { this.undoStack.push({ label, snap: this.snapshot() }); if (this.undoStack.length > MAX_UNDO) this.undoStack.shift(); this.redoStack.length = 0; this.modified = true; this.emit('modified'); }
  async restore(snap) {
    const bytesChanged = snap.bytes !== this.bytes;
    const byKey = new Map(this.pages.map(p => [p.key, p]));
    const pages = snap.pages.map((sp, i) => { const pm = byKey.get(sp.key) || new PageModel(this, i); pm.items = clone(sp.items); pm.renderVersion++; pm.imported = true; return pm; });
    this.outline = clone(snap.outline); this.attachments = snap.attachments.map(a => ({ ...a })); this.docJs = clone(snap.docJs); this.docActions = clone(snap.docActions); this.meta = clone(snap.meta);
    if (bytesChanged) { await this.load(snap.bytes, { keepPages: pages }); }
    else { this.pages = pages; this.pages.forEach((p, i) => p.index = i); this.emit('items'); }
    this.modified = true; this.emit('modified');
  }
  async undo() { const u = this.undoStack.pop(); if (!u) return false; this.redoStack.push({ label: u.label, snap: this.snapshot() }); await this.restore(u.snap); return u.label; }
  async redo() { const r = this.redoStack.pop(); if (!r) return false; this.undoStack.push({ label: r.label, snap: this.snapshot() }); await this.restore(r.snap); return r.label; }
  addItem(pageIdx, item, label = 'Add') { this.pushUndo(label); const pm = this.pages[pageIdx]; pm.items.push(item); pm.renderVersion++; this.emit('items', { page: pageIdx }); return item; }
  removeItems(items, label = 'Delete') { if (!items.length) return; this.pushUndo(label); for (const it of items) { const pm = this.pageOf(it); if (!pm) continue; if (it.orig) { it.deleted = true; it.origModified = true; } else pm.items.splice(pm.items.indexOf(it), 1); pm.renderVersion++; } this.emit('items'); }
  updateItem(item, patch, label = 'Edit', { undo = true } = {}) { if (undo) this.pushUndo(label); if (item.orig) item.origModified = true; if (patch.props) { Object.assign(item.props, patch.props); delete patch.props; } Object.assign(item, patch); if (item.kind === 'annot') item.props.modified = nowIso(); const pm = this.pageOf(item); if (pm) pm.renderVersion++; this.emit('items', { page: pm?.index }); }
  pageOf(item) { return this.pages.find(p => p.items.includes(item)); }
  findItem(id) { for (const p of this.pages) { const it = p.items.find(i => i.id === id); if (it) return it; } return null; }
  allItems() { return this.pages.flatMap(p => p.visibleItems()); }
  allComments() { return this.pages.flatMap(p => p.annots().filter(a => a.type !== 'link')); }
  pageLabel(i) { return this.pageLabels?.[i] ?? String(i + 1); }
  async scanPage(pm) {
    if (pm.scan) return pm.scan;
    const scan = { texts: [], images: [], vectors: [] };
    try {
      const tc = await pm.pdfPage.getTextContent();
      for (const t of tc.items) {
        if (!('str' in t) || !t.str.trim()) continue;
        const [a, b, c, d, e, f] = t.transform; const fs = Math.hypot(a, b) || Math.hypot(c, d);
        const w = t.width, h = t.height || fs; const style = tc.styles[t.fontName] || {};
        const corners = [[0, -0.2 * fs], [w, -0.2 * fs], [w, h], [0, h]].map(([x, y]) => [e + x * (a / fs) - y * (-c / fs) * 0, f + y * 1]);
        const rect = rectNorm([e, f - 0.22 * fs, e + w, f + h * 0.95]); let realName = null; try { if (pm.pdfPage.commonObjs.has(t.fontName)) realName = pm.pdfPage.commonObjs.get(t.fontName)?.name || null; } catch { }
        scan.texts.push({ id: uid('t'), kind: 'object', type: 'text', orig: 'text', rect, rotation: Math.round(Math.atan2(b, a) * 180 / Math.PI), props: { text: t.str, fontFamily: realName ? cleanFontName(realName, null) : cleanFontName(t.fontName, style), fontName: t.fontName, fontSize: +fs.toFixed(2), color: '#000000', fontType: style.vertical ? 'Vertical' : (style.fontFamily?.includes('serif') ? 'Type1' : 'TrueType'), embedded: true, ascent: style.ascent, baseline: f }, ref: t });
      }
    } catch (e) { console.warn('text scan', e); }
    try {
      const ops = await pm.pdfPage.getOperatorList();
      const O = pdfjsLib.OPS; const stack = []; let ctm = [1, 0, 0, 1, 0, 0]; let lw = 1; const pathSeen = new Map();
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], args = ops.argsArray[i];
        if (fn === O.save) stack.push(ctm);
        else if (fn === O.restore) ctm = stack.pop() || ctm;
        else if (fn === O.transform) ctm = mulMatrix(args, ctm);
        else if (fn === O.setLineWidth) lw = args[0];
        else if (fn === O.paintFormXObjectBegin) { stack.push(ctm); if (args[0]) ctm = mulMatrix(args[0], ctm); }
        else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || ctm;
        else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject || fn === O.paintImageXObjectRepeat) {
          const pts = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => applyMatrix(ctm, x, y)); const rect = rectNormPts(pts);
          const name = typeof args[0] === 'string' ? args[0] : (args[0]?.name || null);
          scan.images.push({ id: uid('im'), kind: 'object', type: 'image', orig: 'image', rect, rotation: Math.round(Math.atan2(ctm[1], ctm[0]) * 180 / Math.PI), props: { name, opacity: 1, imgName: name, inline: fn === O.paintInlineImageXObject, mask: fn === O.paintImageMaskXObject, matrix: ctm.slice() }, ref: fn === O.paintInlineImageXObject ? args[0] : null });
        }
        else if (fn === O.constructPath) {
          const minMax = args[2] || args[1]?.minMax; let rect = null;
          if (Array.isArray(minMax) && minMax.length === 4 && isFinite(minMax[0])) { const pts = [[minMax[0], minMax[1]], [minMax[2], minMax[1]], [minMax[2], minMax[3]], [minMax[0], minMax[3]]].map(([x, y]) => applyMatrix(ctm, x, y)); rect = rectNormPts(pts); }
          else if (Array.isArray(args[1])) { const coords = args[1]; const pts = []; for (let k = 0; k + 1 < coords.length; k += 2) pts.push(applyMatrix(ctm, coords[k], coords[k + 1])); if (pts.length) rect = rectNormPts(pts); }
          if (rect && isFinite(rect[0]) && (rect[2] - rect[0] > 0.5 || rect[3] - rect[1] > 0.5)) { const paint = ops.fnArray[i + 1]; const key = rect.map(v => v.toFixed(1)).join(',');
            if (!pathSeen.has(key) && paint !== O.clip && paint !== O.eoClip && paint !== O.endPath) { pathSeen.set(key, 1); scan.vectors.push({ id: uid('v'), kind: 'object', type: 'vector', orig: 'vector', rect, rotation: 0, props: { paint: paintName(paint, O), lineWidth: lw, ops: args[0]?.length || 0 } }); } }
        }
      }
    } catch (e) { console.warn('op scan', e); }
    pm.scan = scan; return scan;
  }
}
function rectNormPts(pts) { const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; }
function paintName(op, O) { for (const k of ['stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke', 'endPath']) if (O[k] === op) return k; return 'path'; }
export function cleanFontName(fontName, style) { const f = style?.fontFamily || fontName || 'Helvetica'; return f.replace(/^[A-Z]{6}\+/, ''); }

function importAnnotation(a, pm) {
  const rect = rectNorm(a.rect || [0, 0, 0, 0]);
  const base = { id: uid('a'), rect, rotation: 0, orig: a.id, origModified: false, deleted: false, props: {} };
  const common = { author: a.titleObj?.str || a.title || '', subject: a.subject || '', contents: a.contentsObj?.str || a.contents || '', created: pdfDate(a.creationDate), modified: pdfDate(a.modificationDate), color: pdfjsColorToHex(a.color) || '#ffe100', fillColor: pdfjsColorToHex(a.interiorColor), opacity: a.opacity ?? 1, lineWidth: a.borderStyle?.width ?? 1, lineStyle: a.borderStyle?.style === 2 ? 'dashed' : 'solid', status: 'None', replies: [], hidden: !!(a.annotationFlags & 2), locked: !!(a.annotationFlags & 128), printable: !!(a.annotationFlags & 4), inReplyTo: a.inReplyTo || null, hasAppearance: a.hasAppearance, replyType: a.replyType };
  const T = a.subtype;
  if (T === 'Widget') {
    const ft = a.fieldType; let type = 'text';
    if (ft === 'Tx') type = 'text'; else if (ft === 'Btn') type = a.checkBox ? 'checkbox' : a.radioButton ? 'radio' : 'button'; else if (ft === 'Ch') type = a.combo ? 'combo' : 'list'; else if (ft === 'Sig') type = 'signature'; else return null;
    const it = newItem('field', type, base);
    Object.assign(it.props, { name: a.fieldName || '', tooltip: a.alternativeText || '', readOnly: !!a.readOnly, required: !!a.required, hidden: !!(a.annotationFlags & 2), borderColor: pdfjsColorToHex(a.borderColor), fillColor: pdfjsColorToHex(a.backgroundColor), textColor: a.defaultAppearanceData?.fontColor ? pdfjsColorToHex(a.defaultAppearanceData.fontColor.map(v => v * 255)) : '#000000', fontSize: a.defaultAppearanceData?.fontSize || 0, borderWidth: a.borderStyle?.width ?? 1, value: typeof a.fieldValue === 'string' ? a.fieldValue : (Array.isArray(a.fieldValue) ? a.fieldValue.join(',') : ''), options: (a.options || []).map(o => ({ label: o.displayValue, value: o.exportValue })), exportValue: a.exportValue || a.buttonValue || 'Yes', checked: type === 'checkbox' || type === 'radio' ? (a.fieldValue != null && a.fieldValue !== 'Off' && (a.exportValue == null || a.fieldValue === a.exportValue)) : false, multiline: !!a.multiLine, password: !!a.password, maxLen: a.maxLen || 0, comb: a.comb ? (a.maxLen || 0) : 0, align: ['left', 'center', 'right'][a.textAlignment || 0], multiSelect: !!a.multiSelect, editable: !!(a.combo && a.hasOwnProperty('editable') ? a.editable : false), caption: a.buttonValue || '', hasAppearance: a.hasAppearance, fieldId: a.id });
    return it;
  }
  if (T === 'Link') { const it = newItem('field', 'link', base); it.props.actions = a.url ? [{ type: 'uri', url: a.url }] : a.dest ? [{ type: 'goto', dest: a.dest }] : []; it.props.borderWidth = a.borderStyle?.width ?? 0; it.props.borderColor = pdfjsColorToHex(a.color); it.props.url = a.url || ''; return it; }
  const map = { Text: 'note', FreeText: 'typewriter', Line: 'line', Square: 'rect', Circle: 'ellipse', Polygon: 'polygon', PolyLine: 'polyline', Highlight: 'highlight', Underline: 'underline', Squiggly: 'squiggly', StrikeOut: 'strikeout', Stamp: 'stamp', Caret: 'caret', Ink: 'ink', FileAttachment: 'fileattach', Redact: 'redact' };
  let type = map[T]; if (!type) return T === 'Popup' ? null : null;
  const it = newItem('annot', type, base); Object.assign(it.props, common); it.props.subject ||= ANNOT_TYPES[type];
  if (type === 'note') it.props.icon = a.name || 'Note';
  if (type === 'typewriter') { it.props.fontSize = a.defaultAppearanceData?.fontSize || 12; it.props.textColor = a.defaultAppearanceData?.fontColor ? pdfjsColorToHex(a.defaultAppearanceData.fontColor.map(v => v * 255)) : '#000000'; it.props.color = it.props.textColor; it.props.fillColor = pdfjsColorToHex(a.color); if (a.intent === 'FreeTextCallout' || a.callout) { it.type = 'callout'; it.points = a.callout ? [[a.callout[0], a.callout[1]], [a.callout[2], a.callout[3]], ...(a.callout.length >= 6 ? [[a.callout[4], a.callout[5]]] : [])] : [[rect[0] - 40, rect[1] - 40], [rect[0], rect[1]]]; } }
  if (type === 'line') { it.points = a.lineCoordinates ? [[a.lineCoordinates[0], a.lineCoordinates[1]], [a.lineCoordinates[2], a.lineCoordinates[3]]] : [[rect[0], rect[1]], [rect[2], rect[3]]]; if (it.points[1][0] < it.points[0][0]) it.points.reverse(); const le = (a.lineEndings || []).filter(e => e && e !== 'None'); if (le.length === 1) it.type = 'arrow'; if (le.length === 2 || a.intent === 'LineDimension') it.type = 'distance'; }
  if (type === 'polygon' || type === 'polyline') { it.points = toPoints(a.vertices); if (a.intent === 'PolygonCloud') it.type = 'cloud'; if (a.intent === 'PolygonDimension') it.type = 'area'; if (a.intent === 'PolyLineDimension') it.type = 'perimeter'; }
  if (type === 'ink') it.paths = (a.inkLists || []).map(l => toPoints(l));
  if (['highlight', 'underline', 'strikeout', 'squiggly'].includes(type)) it.quads = toQuads(a.quadPoints);
  if (type === 'stamp') it.props.stampName = a.name || (it.props.subject) || 'Draft';
  if (type === 'fileattach') { it.props.fileName = a.file?.filename || 'attachment'; it.props.fileContent = a.file?.content || null; it.props.icon = a.name || 'PushPin'; }
  if (type === 'redact') { it.props.fillColor = '#000000'; }
  it.props.popupOpen = a.popupRef ? false : false;
  return it;
}
function toPoints(v) { if (!v) return []; if (typeof v[0] === 'number') { const out = []; for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]); return out; } return Array.from(v, p => Array.isArray(p) ? [p[0], p[1]] : [p.x, p.y]); }
function toQuads(q) { if (!q || !q.length) return []; const out = []; if (typeof q[0] === 'number') { for (let i = 0; i + 7 < q.length; i += 8) { const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]], ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]]; out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]); } return out; } for (const qp of q) { const pts = toPoints(qp); const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]); out.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]); } return out; }
function pdfDate(s) { if (!s) return nowIso(); const m = String(s).match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/); if (!m) return nowIso(); const d = new Date(Date.UTC(+m[1], +(m[2] || 1) - 1, +(m[3] || 1), +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))); return isNaN(d) ? nowIso() : d.toISOString(); }
