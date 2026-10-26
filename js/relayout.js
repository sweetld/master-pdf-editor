// Exact re-layout of a page's existing content: move a selection (also onto another page), and
// flow a section into the free space at the bottom of the previous page, splitting it between rows.
//
// Original text, images and vector graphics are moved in the PDF itself rather than redrawn:
// MuPDF makes a copy of the source page stripped down to the selection and removes the originals,
// then pdf-lib places that copy (clipped to the moved area) as a form XObject where it belongs, so
// fonts and graphics stay exactly as they were. Form fields keep their widget and value; moving one
// to another page moves its annotation there. Added objects and comments move in the model.
// Coordinates are PDF user space (y up), like the rest of the model.
import * as mu from './mupdf-bridge.js';
import { toMuRect, libSave, lookupOrigAnnot, wrapContentInGraphicsState } from './pdfops.js';
import { rectNorm, hexToRgb } from './util.js';
const L = PDFLib;

const CONTENT_ORIG = new Set(['text', 'image', 'vector']);
/** Original page content not edited in the model: moved exactly in the PDF bytes. */
export const isExact = it => it.kind === 'object' && CONTENT_ORIG.has(it.orig) && !it.deleted && !it.origModified;
/** Identity of scanned original content that survives rescans (ids don't); same key as Editor.ensureScanned. */
const keyOf = it => `${it.orig}:${it.rect.map(v => v.toFixed(1)).join(',')}:${it.props.text || it.props.imgName || ''}`;
const isOrigField = it => it.kind === 'field' && !!it.orig && !it.deleted;
/** Model items that must stay on their page (their original content is tied to it until saved). */
const pinned = it => !!it.orig && !isExact(it) && !isOrigField(it);

export const union = rs => rs.reduce((a, r) => { r = rectNorm(r); return a ? [Math.min(a[0], r[0]), Math.min(a[1], r[1]), Math.max(a[2], r[2]), Math.max(a[3], r[3])] : r.slice(); }, null);
const grow = (r, d) => [r[0] - d, r[1] - d, r[2] + d, r[3] + d];
const shift = (r, dx, dy) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
export const contains = (o, i, tol = 0) => i[0] >= o[0] - tol && i[1] >= o[1] - tol && i[2] <= o[2] + tol && i[3] <= o[3] + tol;
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
/** Clip margin around moved content: whole strokes, and glyphs that reach past pdf.js' text boxes. */
const strokePad = items => Math.max(1 + Math.max(0, ...items.filter(i => i.orig === 'vector').map(i => (i.props.lineWidth || 0) / 2)), Math.min(12, 0.3 * Math.max(0, ...items.filter(i => i.orig === 'text').map(i => i.props.fontSize || 0))));
const squash = t => String(t || '').normalize('NFKC').replace(/\s+/g, '');
/** Every moved text run must be found on the page it went to, or the edit is refused (and undone). */
async function verifyText(bytes, plan) {
  const want = new Map();
  for (const j of plan.jobs) for (const pl of j.places) for (const it of j.items) if (it.orig === 'text' && squash(it.props.text) && overlaps(rectNorm(pl.clip), rectNorm(it.rect))) { const r = rectNorm(it.rect), c = rectNorm(pl.clip); if ((r[1] + r[3]) / 2 < c[1] || (r[1] + r[3]) / 2 > c[3]) continue; (want.get(pl.dst) || want.set(pl.dst, []).get(pl.dst)).push(it.props.text); }
  const lost = [];
  for (const [dst, texts] of want) { const have = squash(await mu.pageText(bytes, dst)); for (const t of texts) if (!have.includes(squash(t))) lost.push(t); }
  if (lost.length) throw new Error(`Moving this text didn't work for this PDF, so nothing was changed: ${lost.slice(0, 5).map(t => '“' + t.trim().slice(0, 40) + '”').join(', ')}${lost.length > 5 ? ` and ${lost.length - 5} more` : ''}.`);
}
const pageArea = pm => pm.width * pm.height;
/** Big enough for MuPDF to count the shape as covered: it pads stroked paths for joins (miter limit 10). */
const vectorRemovalRect = it => grow(rectNorm(it.rect), 1 + (it.props.stroke || /stroke/i.test(it.props.paint || '') ? (it.props.lineWidth || 1) * 5 + 1 : 0));
export const isBackground = (pm, it) => it.orig === 'vector' && (it.rect[2] - it.rect[0]) * (it.rect[3] - it.rect[1]) > 0.8 * pageArea(pm);

function moveGeometry(it, dx, dy, sx = 1, sy = 1) {
  const f = p => [p[0] * sx + dx, p[1] * sy + dy];
  const r = rectNorm(it.rect); it.rect = [...f([r[0], r[1]]), ...f([r[2], r[3]])];
  if (it.points) it.points = it.points.map(f); if (it.paths) it.paths = it.paths.map(path => path.map(f));
  if (it.quads) it.quads = it.quads.map(q => [...f([q[0], q[1]]), ...f([q[2], q[3]])]);
  if (it.origRect && !it.orig) it.origRect = null;
}

// ---------- MuPDF helpers ----------
function redact(M, page, pm, rects, { text = false, images = 0, lineArt = 0 } = {}) {
  rects = rects.filter(Boolean); if (!rects.length) return;
  // MuPDF's "remove line art covered by the redaction" only honours one redaction per pass: with
  // several, all but one covered shape survive. So graphics are removed one rectangle at a time.
  if (lineArt && rects.length > 1) { for (const r of rects) redact(M, page, pm, [r], { text, images, lineArt }); return; }
  for (const r of rects) { let m = toMuRect(pm, rectNorm(r)); if (m[2] - m[0] < 1) m = [m[0] - 0.5, m[1], m[2] + 0.5, m[3]]; if (m[3] - m[1] < 1) m = [m[0], m[1] - 0.5, m[2], m[3] + 0.5]; const a = page.createAnnotation('Redact'); a.setRect(m); a.update(); }
  page.applyRedactions(false, images, lineArt, text ? M.PDFPage.REDACT_TEXT_REMOVE : M.PDFPage.REDACT_TEXT_NONE);
}
function redactMu(M, page, rects, { text = false } = {}) { // rects already in MuPDF page space
  rects = rects.filter(Boolean); if (!rects.length) return;
  for (const m of rects) { const a = page.createAnnotation('Redact'); a.setRect(m); a.update(); }
  page.applyRedactions(false, M.PDFPage.REDACT_IMAGE_NONE, M.PDFPage.REDACT_LINE_ART_NONE, text ? M.PDFPage.REDACT_TEXT_REMOVE : M.PDFPage.REDACT_TEXT_NONE);
}
/**
 * MuPDF's own box for every visible character of a page (MuPDF page space), split into the ones
 * belonging to ``items`` (pdf.js text runs) and the rest. MuPDF removes a character when a redaction
 * touches almost any part of that box, and the box can be much taller than pdf.js' estimate of the
 * run (fonts with tall ascenders/descenders), so text is redacted using these boxes only.
 */
function charBoxes(page, pm, items) {
  const runs = items.map(i => { const r = rectNorm(i.rect); return toMuRect(pm, [r[0] - 0.5, r[1], r[2] + 0.5, r[3]]); });
  const mine = [], other = []; const st = page.toStructuredText('preserve-whitespace');
  try {
    st.walk({ onChar(c, origin, font, size, q) { if (!String(c).trim() || !q) return; const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]; const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; (runs.some(r => cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3]) ? mine : other).push(b); } });
  } finally { st.destroy?.(); }
  return { mine, other };
}
/** A tiny mark at the centre of a character box: enough for MuPDF to remove that character only. */
const centreMark = b => { const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, w = Math.max(0.1, (b[2] - b[0]) * 0.1), h = Math.max(0.1, (b[3] - b[1]) * 0.1); return [cx - w, cy - h, cx + w, cy + h]; };
function dropRedactMarks(page) { for (const a of page.getAnnotations()) if (a.getType() === 'Redact') page.deleteAnnotation(a); }

/** A one-page PDF of page ``pm`` reduced to the ``keep`` items around ``clip`` (user space). */
function isolate(M, base, pm, keep, clip, pad) {
  const d = M.PDFDocument.openDocument(base.slice(), 'application/pdf');
  try {
    for (let i = d.countPages() - 1; i >= 0; i--) if (i !== pm.index) d.deletePage(i);
    const page = d.loadPage(0); dropRedactMarks(page);
    const keepKeys = new Set(keep.map(i => i.origKey || keyOf(i))); const kept = t => keepKeys.has(keyOf(t)); const sc = pm.scan;
    const c = grow(clip, pad);
    const v = pm.pdfPage.view; const pr = grow([Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])], 10);
    const strips = b => [[pr[0], b[3], pr[2], pr[3]], [pr[0], pr[1], pr[2], b[1]], [pr[0], b[1], b[0], b[3]], [b[2], b[1], pr[2], b[3]]].filter(s => s[2] > s[0] && s[3] > s[1]);
    // text outside: strips clear of every kept character's real box; other text inside: one character at a time
    const chars = charBoxes(page, pm, keep.filter(i => i.orig === 'text'));
    const cm = union([toMuRect(pm, c), ...chars.mine]); const ctm = grow(cm, 0.5); const mb = toMuRect(pm, pr);
    redactMu(M, page, [[mb[0], mb[1], mb[2], ctm[1]], [mb[0], ctm[3], mb[2], mb[3]], [mb[0], ctm[1], ctm[0], ctm[3]], [ctm[2], ctm[1], mb[2], ctm[3]]].filter(s => s[2] > s[0] && s[3] > s[1]), { text: true });
    redactMu(M, page, chars.other.filter(b => overlaps(b, ctm)).map(centreMark).filter(m => !chars.mine.some(k => overlaps(k, m))), { text: true });
    redact(M, page, pm, strips(c), { images: M.PDFPage.REDACT_IMAGE_REMOVE });
    // graphics reaching outside (an enclosing box, a panel behind the selection) go entirely; the
    // strips keep clear of the kept graphics' own (miter-padded) bounds so those are never touched
    const cl = union([c, ...keep.filter(i => i.orig === 'vector').map(vectorRemovalRect)]);
    redact(M, page, pm, strips(cl), { lineArt: M.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED });
    // other content inside
    const keptImages = keep.filter(i => i.orig === 'image');
    redact(M, page, pm, sc.images.filter(t => !kept(t) && contains(c, t.rect) && !keptImages.some(k => overlaps(k.rect, t.rect))).map(t => t.rect), { images: M.PDFPage.REDACT_IMAGE_REMOVE });
    redact(M, page, pm, sc.vectors.filter(t => !kept(t) && contains(c, t.rect) && !keep.some(k => contains(t.rect, k.rect, 0.5))).map(t => grow(t.rect, 0.5)), { lineArt: M.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED });
    return d.saveToBuffer('').asUint8Array().slice();
  } finally { d.destroy(); }
}

/**
 * Rewrites the document bytes. ``plan``:
 *   jobs:   [{ pm, items, clip, pad, remove, places: [{ clip, dst, dx, dy, sx, sy }] }]  content moved exactly
 *   fields: [{ it, src, dst, dx, dy }]                                                  original form fields
 *   lines:  [{ dst, x0, x1, y, color, width }]                                          rules to draw
 * (src/dst are page indices; a place maps p -> p * s + d.)
 */
async function rewrite(doc, plan) {
  const M = await mu.mupdf();
  let base = doc.bytes; if (doc.encrypted || doc.password) base = (await mu.decrypt(base, doc.password || '')).bytes;
  for (const j of plan.jobs) if (!j.pm.scan) await doc.scanPage(j.pm);
  const isos = plan.jobs.map(j => j.items.length && j.places.length ? isolate(M, base, j.pm, j.items, j.clip, j.pad) : null);
  let cleaned = base; const byPage = new Map();
  for (const j of plan.jobs) if (j.remove !== false && j.items.length) byPage.set(j.pm, [...(byPage.get(j.pm) || []), ...j.items]);
  // Removing a graphic also removes unselected graphics lying inside its rectangle, and removing an
  // image removes images touching it; put those back exactly where they were.
  for (const [pm, items] of byPage) {
    const moving = new Set(items.map(i => i.origKey || keyOf(i))); const vr = items.filter(i => i.orig === 'vector').map(vectorRemovalRect); const ir = items.filter(i => i.orig === 'image').map(i => rectNorm(i.rect));
    const caught = [...pm.scan.vectors.filter(v => vr.some(r => contains(r, v.rect))), ...pm.scan.images.filter(m => ir.some(r => overlaps(r, m.rect)))].filter(t => !moving.has(keyOf(t)) && !isBackground(pm, t));
    if (caught.length) { const pad = strokePad(caught); let clip = union(caught.map(i => i.rect)); const inner = clip => { for (const v of items.filter(i => i.orig === 'vector')) { const r = rectNorm(v.rect); if (contains(grow(r, 1), clip)) { const m = (v.props.lineWidth || 1) / 2 + 0.3; clip = [Math.max(clip[0], r[0] + m), Math.max(clip[1], r[1] + m), Math.min(clip[2], r[2] - m), Math.min(clip[3], r[3] - m)]; } } return clip; }; plan.jobs.push({ pm, items: caught, clip, pad, remove: false, restore: true, places: [{ clip: inner(grow(clip, pad)), dst: pm.index, dx: 0, dy: 0 }] }); isos.push(isolate(M, base, pm, caught, clip, pad)); }
  }
  if (byPage.size) {
    const d = M.PDFDocument.openDocument(base.slice(), 'application/pdf');
    try {
      for (const [pm, items] of byPage) {
        const page = d.loadPage(pm.index); if (page.getAnnotations().some(a => a.getType() === 'Redact')) throw new Error(`Page ${pm.index + 1} has redaction marks in the file; apply or delete them first.`);
        { const ch = charBoxes(page, pm, items.filter(i => i.orig === 'text')); redactMu(M, page, ch.mine.map(centreMark).filter(m => !ch.other.some(o => overlaps(o, m))), { text: true }); }
        redact(M, page, pm, items.filter(i => i.orig === 'image').map(i => { const r = rectNorm(i.rect); return r[2] - r[0] > 4 && r[3] - r[1] > 4 ? grow(r, -1) : r; }), { images: M.PDFPage.REDACT_IMAGE_REMOVE });
        redact(M, page, pm, items.filter(i => i.orig === 'vector').map(vectorRemovalRect), { lineArt: M.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED });
      }
      cleaned = d.saveToBuffer('').asUint8Array().slice();
    } finally { d.destroy(); }
  }
  const opts = { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false };
  const pdfDoc = await L.PDFDocument.load(cleaned, opts); const pages = pdfDoc.getPages(); const wrapped = new Set();
  const wrap = i => { if (!wrapped.has(i)) { wrapContentInGraphicsState(pdfDoc, pages[i]); wrapped.add(i); } };
  for (let k = 0; k < plan.jobs.length; k++) {
    if (!isos[k]) continue; const src = await L.PDFDocument.load(isos[k], opts); const sp = src.getPages()[0];
    for (const pl of plan.jobs[k].places) {
      const c = rectNorm(pl.clip); const sx = pl.sx ?? 1, sy = pl.sy ?? 1;
      const emb = await pdfDoc.embedPage(sp, { left: c[0], bottom: c[1], right: c[2], top: c[3] }); wrap(pl.dst);
      pages[pl.dst].drawPage(emb, { x: c[0] * sx + pl.dx, y: c[1] * sy + pl.dy, xScale: sx, yScale: sy });
    }
  }
  for (const f of plan.fields) {
    const found = lookupOrigAnnot(pdfDoc, pages[f.src], f.it.orig); if (!found) continue;
    found.dict.set(L.PDFName.of('Rect'), pdfDoc.context.obj(shift(rectNorm(f.it.rect), f.dx, f.dy)));
    if (f.src !== f.dst) { pages[f.src].node.removeAnnot(found.ref); pages[f.dst].node.addAnnot(found.ref); found.dict.set(L.PDFName.of('P'), pages[f.dst].ref); }
  }
  for (const l of plan.lines || []) { const c = hexToRgb(l.color) || [0, 0, 0]; wrap(l.dst); pages[l.dst].drawLine({ start: { x: l.x0, y: l.y }, end: { x: l.x1, y: l.y }, thickness: l.width || 1, color: L.rgb(c[0], c[1], c[2]) }); }
  return libSave(pdfDoc);
}

/**
 * Applies a re-layout as one undoable step: rewrites the bytes for exact content and original
 * fields, moves model items (``models``: [{ it, dst, dx, dy, sx, sy }]), reloads, and returns
 * selectors for what moved ([{ page, orig, rect } | { page, item }]).
 */
export async function applyRelayout(doc, label, plan) {
  plan = { jobs: [], fields: [], models: [], lines: [], deletes: [], ...plan };
  const needBytes = plan.jobs.some(j => j.items.length) || plan.fields.length || plan.lines.length;
  if (needBytes && !(await mu.available())) throw new Error('Moving page content needs MuPDF, which could not be loaded.');
  doc.pushUndo(label);
  const targets = []; const touched = new Set();
  try {
    const bytes = needBytes ? await rewrite(doc, plan) : null; if (bytes) await verifyText(bytes, plan);
    for (const j of plan.jobs) { touched.add(j.pm.index); if (j.restore) continue; for (const pl of j.places) { touched.add(pl.dst); for (const it of j.items) { if (!contains(grow(rectNorm(pl.clip), 0.5), it.rect) && !overlaps(rectNorm(pl.clip), it.rect)) continue; const r = rectNorm(it.rect); const sx = pl.sx ?? 1, sy = pl.sy ?? 1; targets.push({ page: pl.dst, orig: it.orig, rect: [r[0] * sx + pl.dx, r[1] * sy + pl.dy, r[2] * sx + pl.dx, r[3] * sy + pl.dy] }); } } }
    const relocateItem = (it, srcIdx, dstIdx) => { if (srcIdx === dstIdx) return; const from = doc.pages[srcIdx], to = doc.pages[dstIdx]; from.items.splice(from.items.indexOf(it), 1); to.items.push(it); };
    for (const f of plan.fields) { f.it.rect = shift(rectNorm(f.it.rect), f.dx, f.dy); relocateItem(f.it, f.src, f.dst); touched.add(f.src); touched.add(f.dst); targets.push({ page: f.dst, item: f.it }); }
    for (const m of plan.models) { const src = doc.pageOf(m.it).index; moveGeometry(m.it, m.dx, m.dy, m.sx, m.sy); if (m.it.orig && m.it.kind === 'object') m.it.origModified = true; if (m.it.kind === 'annot' && m.it.orig) m.it.origModified = true; relocateItem(m.it, src, m.dst); touched.add(src); touched.add(m.dst); targets.push({ page: m.dst, item: m.it }); }
    for (const it of plan.deletes) { const pm = doc.pageOf(it); if (!pm) continue; touched.add(pm.index); if (it.orig) { it.deleted = true; it.origModified = true; } else pm.items.splice(pm.items.indexOf(it), 1); }
    if (bytes) {
      for (const i of touched) { const pm = doc.pages[i]; pm.items = pm.items.filter(it => !isExact(it)); }
      doc.encrypted = false; doc.password = null; await doc.load(bytes, { keepPages: doc.pages.slice() });
    }
    for (const i of touched) doc.pages[i].renderVersion++;
    doc.modified = true; doc.emit('items'); doc.emit('modified');
  } catch (e) { const u = doc.undoStack.pop(); if (u) await doc.restore(u.snap); throw e; }
  return { targets, touched: [...touched] };
}

/** Finds the items a re-layout's selectors point to (after the pages were rescanned). */
export function resolveTargets(doc, targets, tol = 1.5) {
  const out = [];
  for (const t of targets) {
    if (t.item) { if (doc.pageOf(t.item)) out.push(t.item); continue; }
    const pm = doc.pages[t.page]; const hit = pm?.items.find(it => isExact(it) && it.orig === t.orig && !out.includes(it) && it.rect.every((v, k) => Math.abs(v - t.rect[k]) <= tol));
    if (hit) out.push(hit);
  }
  return out;
}

// ---------- building plans ----------
/** Move/scale ``items`` of page ``pm``: p -> p * s + d, onto page ``dst`` (an index). */
export function movePlan(doc, pm, items, dst, dx, dy, { sx = 1, sy = 1 } = {}) {
  const exact = items.filter(isExact), fields = items.filter(isOrigField), notes = [];
  let models = items.filter(it => !isExact(it) && !isOrigField(it) && !it.deleted);
  if (dst !== pm.index) { const stay = models.filter(pinned); if (stay.length) notes.push(`${stay.length} edited object(s) can only move on their own page until the document is saved; they were left in place.`); models = models.filter(it => !pinned(it)); }
  const jobs = []; if (exact.length) { const pad = strokePad(exact); const clip = union(exact.map(i => i.rect)); jobs.push({ pm, items: exact, clip, pad, places: [{ clip: grow(clip, pad), dst, dx, dy, sx, sy }] }); }
  return { jobs, fields: fields.map(it => ({ it, src: pm.index, dst, dx: dx + rectNorm(it.rect)[0] * (sx - 1), dy: dy + rectNorm(it.rect)[1] * (sy - 1) })), models: models.map(it => ({ it, dst, dx, dy, sx, sy })), notes };
}

/**
 * Deleting: original text, images and graphics are removed from the PDF straight away (MuPDF), like a
 * move with no destination, so no page-coloured cover is left over the spot; everything else (added
 * objects, comments, form fields) is deleted in the model as before.
 */
export function deletePlan(doc, items) {
  const byPage = new Map(), deletes = [];
  for (const it of items) { if (isExact(it)) { const pm = doc.pageOf(it); byPage.set(pm, [...(byPage.get(pm) || []), it]); } else if (!it.deleted) deletes.push(it); }
  const jobs = [...byPage].map(([pm, its]) => ({ pm, items: its, clip: union(its.map(i => i.rect)), pad: strokePad(its), places: [] }));
  return { jobs, deletes };
}

/** ``sel`` plus everything on the page lying inside any selected graphic (a box bounding a section). */
export function enclosedItems(pm, sel, bboxOf) {
  const out = sel.slice(); const boxes = sel.filter(it => it.kind === 'object' && (it.orig === 'vector' || ['rect', 'ellipse'].includes(it.type)));
  for (const b of boxes) { const r = grow(rectNorm(bboxOf(b)), 1); for (const it of pm.visibleItems()) if (!out.includes(it) && it.kind !== 'annot' && !isBackground(pm, it) && contains(r, rectNorm(bboxOf(it)))) out.push(it); }
  return out;
}

// Flow planning works top-down (y = distance from the top of the page), like reading order.
export const FOOTER_BAND = 0.9;
function frame(pm) { const v = pm.pdfPage.view; return { top: Math.max(v[1], v[3]), bottom: Math.min(v[1], v[3]), h: Math.abs(v[3] - v[1]) }; }
function down(pm, it, bboxOf) { const f = frame(pm), r = rectNorm(bboxOf(it)); return { it, x0: r[0], x1: r[2], y0: f.top - r[3], y1: f.top - r[1] }; }
const flowable = (pm, it) => (it.kind === 'object' || it.kind === 'field') && !it.deleted && !isBackground(pm, it);
function footerTop(els, h) { const ys = els.filter(e => e.y0 >= h * FOOTER_BAND).map(e => e.y0); return ys.length ? Math.min(...ys) : null; }
function rows(spans, minGap = 0.5) { const out = []; for (const [a, b] of spans.slice().sort((p, q) => p[0] - q[0])) { if (out.length && a < out[out.length - 1][1] + minGap) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b); else out.push([a, b]); } return out; }
const isDrawing = it => it.kind === 'object' && (it.orig === 'vector' || ['rect', 'ellipse', 'line', 'ink'].includes(it.type));

/**
 * Plans flowing ``sel`` (items of page ``pm``) into the gap at the bottom of the previous page:
 * wholly if it fits, else split between two rows so the top part fills the gap and the rest stays
 * where the section started. Throws an Error with a user-facing message when it can't.
 */
export function planFlow(doc, pm, sel, bboxOf, { spacing = null, gapBottom = null, bottomMargin = 36 } = {}) {
  if (pm.index === 0) throw new Error('The first page has no previous page.');
  const prev = doc.pages[pm.index - 1]; const ff = frame(pm), pf = frame(prev);
  sel = sel.filter(it => flowable(pm, it)); if (!sel.length) throw new Error('Select the section first (for example its box, then Select Enclosed Content).');
  const S = sel.map(it => down(pm, it, bboxOf)); const box = { x0: Math.min(...S.map(e => e.x0)), x1: Math.max(...S.map(e => e.x1)), y0: Math.min(...S.map(e => e.y0)), y1: Math.max(...S.map(e => e.y1)) };
  const els = pm.visibleItems().filter(it => flowable(pm, it) && !sel.includes(it)).map(it => down(pm, it, bboxOf));
  const prevEls = prev.visibleItems().filter(it => flowable(prev, it)).map(it => down(prev, it, bboxOf));
  if (spacing == null) { const above = els.filter(e => e.y1 <= box.y0 + 0.5).map(e => e.y1); spacing = above.length ? Math.min(24, Math.max(4, box.y0 - Math.max(...above))) : 12; }
  const pFoot = footerTop(prevEls, pf.h); const body = prevEls.filter(e => pFoot == null || e.y0 < pFoot);
  const gapTop = body.length ? Math.max(...body.map(e => e.y1)) + spacing : box.y0;
  if (gapBottom == null) gapBottom = pFoot != null ? pFoot - spacing : pf.h - bottomMargin;
  const avail = gapBottom - gapTop;
  if (avail <= 1) throw new Error(`Page ${prev.index + 1} has no free space at the bottom.`);
  const foot = footerTop(els, ff.h); const following = els.filter(e => e.y0 >= box.y1 - 0.5 && (foot == null || e.y0 < foot));
  const plan = { pm, prev, box, gapTop, gapBottom, spacing, available: avail, sel, following: following.map(e => e.it), cut: null, splitDrawings: [], shift: 0 };
  if (box.y1 - box.y0 <= avail) { plan.shift = following.length ? Math.min(...following.map(e => e.y0)) - box.y0 : 0; plan.topHeight = box.y1 - box.y0; return plan; }
  // Split between rows. A graphic is cut (not kept whole) when it bounds two or more rows of the
  // section or can never fit; everything else is atomic.
  const atoms = S.filter(e => !isDrawing(e.it)); const solid = []; const split = [];
  for (const d of S.filter(e => isDrawing(e.it))) { const inner = atoms.filter(a => a.y0 >= d.y0 - 1 && a.y1 <= d.y1 + 1 && a.x0 >= d.x0 - 1 && a.x1 <= d.x1 + 1); if (d.it.orig === 'vector' && (rows(inner.map(a => [a.y0, a.y1])).length >= 2 || d.y1 - d.y0 > avail)) split.push(d); else solid.push(d); }
  const R = rows([...atoms, ...solid].map(e => [e.y0, e.y1])); const limit = box.y0 + avail; let cut = null;
  for (let k = 0; k + 1 < R.length; k++) if (R[k][1] <= limit) cut = Math.min((R[k][1] + R[k + 1][0]) / 2, limit);
  if (cut == null) throw new Error(`The section's first row (${Math.round((R[0]?.[1] ?? box.y1) - box.y0)} pt tall) doesn't fit in the ${Math.round(avail)} pt free at the bottom of page ${prev.index + 1}.`);
  Object.assign(plan, { cut, shift: cut - box.y0, topHeight: cut - box.y0, splitDrawings: split.filter(d => d.y0 < cut && cut < d.y1).map(d => d.it) });
  return plan;
}

/** Turns a flow plan into a re-layout (see applyRelayout). */
export function flowRelayout(plan, bboxOf, { closeBoxes = true, pullUp = true } = {}) {
  const { pm, prev, box, cut } = plan; const ff = frame(pm), pf = frame(prev); const src = pm.index, dst = prev.index;
  const dyPrev = (pf.top - ff.top) - (plan.gapTop - box.y0);   // user-space shift onto the previous page
  const dyStay = cut == null ? 0 : cut - box.y0;               // the rest moves up by the part that left
  const exact = plan.sel.filter(isExact), notes = [];
  const pad = strokePad(exact); const boxUser = [box.x0, ff.top - box.y1, box.x1, ff.top - box.y0];
  const places = cut == null ? [{ clip: grow(boxUser, pad), dst, dx: 0, dy: dyPrev }]
    : [{ clip: [boxUser[0] - pad, ff.top - cut, boxUser[2] + pad, boxUser[3] + pad], dst, dx: 0, dy: dyPrev },
       { clip: [boxUser[0] - pad, boxUser[1] - pad, boxUser[2] + pad, ff.top - cut], dst: src, dx: 0, dy: dyStay }];
  const jobs = exact.length ? [{ pm, items: exact, clip: boxUser, pad, places }] : [];
  const fields = [], models = [];
  const where = it => { if (cut == null) return [dst, dyPrev]; const e = down(pm, it, bboxOf); return (e.y0 + e.y1) / 2 < cut ? [dst, dyPrev] : [src, dyStay]; };
  for (const it of plan.sel) {
    if (isExact(it)) continue; const [to, dy] = where(it);
    if (isOrigField(it)) fields.push({ it, src, dst: to, dx: 0, dy });
    else if (to !== src && pinned(it)) notes.push('An edited object was left on its page; save, then flow again to move it.');
    else models.push({ it, dst: to, dx: 0, dy });
  }
  const lines = [];
  if (cut != null && closeBoxes) for (const it of plan.splitDrawings) {
    if (!it.props.stroke || !it.props.isRect) continue; const r = rectNorm(it.rect);
    lines.push({ dst, x0: r[0], x1: r[2], y: pf.top - (cut + plan.gapTop - box.y0), color: it.props.stroke, width: it.props.lineWidth || 1 }, { dst: src, x0: r[0], x1: r[2], y: ff.top - box.y0, color: it.props.stroke, width: it.props.lineWidth || 1 });
  }
  if (pullUp && plan.shift > 0.05 && plan.following.length) {
    const fe = plan.following.filter(isExact);
    if (fe.length) { const fpad = strokePad(fe); const clip = union(fe.map(i => i.rect)); jobs.push({ pm, items: fe, clip, pad: fpad, places: [{ clip: grow(clip, fpad), dst: src, dx: 0, dy: plan.shift }] }); }
    for (const it of plan.following) { if (isExact(it)) continue; if (isOrigField(it)) fields.push({ it, src, dst: src, dx: 0, dy: plan.shift }); else models.push({ it, dst: src, dx: 0, dy: plan.shift }); }
  }
  return { jobs, fields, models, lines, notes };
}

export function describeFlow(plan, pullUp = true) {
  const prev = plan.prev.index + 1, cur = plan.pm.index + 1;
  let t = `Page ${prev} has ${Math.round(plan.available)} pt free. The section is ${Math.round(plan.box.y1 - plan.box.y0)} pt tall.\n\n`;
  t += plan.cut == null ? `It fits: the whole section moves to page ${prev}.`
    : `It is split between two rows: the top ${Math.round(plan.topHeight)} pt moves to page ${prev}, the remaining ${Math.round(plan.box.y1 - plan.cut)} pt moves up to where the section started on page ${cur}.`;
  if (pullUp && plan.following.length && plan.shift > 0.05) t += `\nThe content below it on page ${cur} moves up ${Math.round(plan.shift)} pt.`;
  return t;
}

/** Below the page's main content (ignoring a footer), in user space: the y for a block's top. */
export function belowContentY(doc, pm, bboxOf, exclude = []) {
  const f = frame(pm); const els = pm.visibleItems().filter(it => flowable(pm, it) && !exclude.includes(it)).map(it => down(pm, it, bboxOf));
  const foot = footerTop(els, f.h); const body = els.filter(e => foot == null || e.y0 < foot);
  return f.top - (body.length ? Math.max(...body.map(e => e.y1)) + 12 : 36);
}
