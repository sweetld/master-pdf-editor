import { PdfDoc, PageModel, pdfjsLib } from './model.js';
import { hexToRgb, rectNorm, bboxOfPoints, base64ToBytes, uid, settings, PAGE_SIZES } from './util.js';
import { encryptPdf, decryptPdf, concat } from './security.js';
const L = PDFLib;
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFNumber, PDFRef, PDFBool, StandardFonts, rgb, degrees, TextAlignment, PDFRawStream } = L;
const col = hex => { const c = hexToRgb(hex); return c ? rgb(c[0], c[1], c[2]) : undefined; };
const colArr = hex => { const c = hexToRgb(hex); return c ? c.map(v => +v.toFixed(4)) : null; };
const pdfDate = iso => { const d = new Date(iso || Date.now()); const p = n => String(n).padStart(2, '0'); return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; };

// ---------- loading / saving ----------
export async function libLoad(doc, bytes = doc.bytes) {
  if (doc.encrypted || doc.password) {
    try { const r = await decryptPdf(bytes, doc.password || ''); doc.security = { method: r.method, permissions: r.permissions, isOwner: r.isOwner }; return r.doc; }
    catch (e) { if (e.name === 'PasswordException') throw new Error('The document is encrypted and the password does not allow editing.'); throw e; }
  }
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
}
export const libSave = (pdfDoc, opts = {}) => pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: true, ...opts });

/** Run a structural change: fn(pdfDoc) may return the new page-model order (array of PageModel|null). */
export async function structural(doc, label, fn) {
  doc.pushUndo(label);
  const pdfDoc = await libLoad(doc);
  const order = await fn(pdfDoc, doc) ?? doc.pages.slice();
  const bytes = await libSave(pdfDoc);
  const keep = order.map((p, i) => { if (!p) { const np = new PageModel(doc, i); np.imported = true; return np; } return p; });
  doc.encrypted = false; doc.password = null; // decrypted working copy
  await doc.load(bytes, { keepPages: keep });
  return bytes;
}

// ---------- fonts ----------
const fontCache = new WeakMap();
export function stdFontFor(family = '', bold = false, italic = false) {
  const f = family.toLowerCase(); bold = bold || /bold|black|heavy|semibold/.test(f); italic = italic || /italic|oblique/.test(f);
  if (/times|serif|georgia|book|roman|garamond|cambria/.test(f) && !/sans/.test(f)) return bold && italic ? StandardFonts.TimesRomanBoldItalic : bold ? StandardFonts.TimesRomanBold : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  if (/courier|mono|consolas/.test(f)) return bold && italic ? StandardFonts.CourierBoldOblique : bold ? StandardFonts.CourierBold : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
  if (/symbol/.test(f)) return StandardFonts.Symbol; if (/dingbat/.test(f)) return StandardFonts.ZapfDingbats;
  return bold && italic ? StandardFonts.HelveticaBoldOblique : bold ? StandardFonts.HelveticaBold : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
}
export async function getFont(pdfDoc, family, bold, italic) {
  const name = stdFontFor(family, bold, italic); let m = fontCache.get(pdfDoc); if (!m) { m = new Map(); fontCache.set(pdfDoc, m); }
  if (!m.has(name)) m.set(name, await pdfDoc.embedFont(name)); return m.get(name);
}
export function safeText(font, s) { let out = ''; for (const ch of String(s ?? '')) { if (ch === '\n' || ch === '\r' || ch === '\t') { out += ch; continue; } try { font.encodeText(ch); out += ch; } catch { out += '?'; } } return out; }
export function wrapLines(font, text, size, maxWidth) {
  const lines = []; for (const para of safeText(font, text).replace(/\r/g, '').split('\n')) {
    if (maxWidth <= 0) { lines.push(para); continue; }
    let line = ''; for (const word of para.split(' ')) { const t = line ? line + ' ' + word : word; if (font.widthOfTextAtSize(t, size) <= maxWidth || !line) line = t; else { lines.push(line); line = word; } } lines.push(line);
  } return lines;
}
// ---------- appearance-stream helpers ----------
function extG(pdfDoc, item) { const p = item.props; const g = { Type: 'ExtGState', CA: p.opacity ?? 1, ca: p.opacity ?? 1 }; if (['highlight'].includes(item.type)) g.BM = 'Multiply'; return pdfDoc.context.register(pdfDoc.context.obj(g)); }
function strokeOps(p) { const ops = []; const c = colArr(p.color); if (c) ops.push(L.setStrokingRgbColor(c[0], c[1], c[2])); ops.push(L.setLineWidth(p.lineWidth ?? 1)); if (p.lineStyle === 'dashed') ops.push(L.setDashPattern([4, 3], 0)); if (p.lineStyle === 'dotted') ops.push(L.setDashPattern([1, 2], 0)); ops.push(L.setLineCap(L.LineCapStyle.Round), L.setLineJoin(L.LineJoinStyle.Round)); return ops; }
function fillOps(p, key = 'fillColor') { const c = colArr(p[key]); return c ? [L.setFillingRgbColor(c[0], c[1], c[2])] : []; }
function paintOp(p, closed = false) { const hasS = !!p.color && (p.lineWidth ?? 1) > 0, hasF = !!p.fillColor; if (hasS && hasF) return [closed ? L.closePath() : null, L.fillAndStroke()].filter(Boolean); if (hasF) return [L.fill()]; if (hasS) return [closed ? L.closePath() : null, L.stroke()].filter(Boolean); return [L.endPath()]; }
function arrowHeadOps(from, to, size) { const a = Math.atan2(to[1] - from[1], to[0] - from[0]); const s = size; const p1 = [to[0] - s * Math.cos(a - Math.PI / 7), to[1] - s * Math.sin(a - Math.PI / 7)], p2 = [to[0] - s * Math.cos(a + Math.PI / 7), to[1] - s * Math.sin(a + Math.PI / 7)]; return [L.moveTo(p1[0], p1[1]), L.lineTo(to[0], to[1]), L.lineTo(p2[0], p2[1]), L.stroke()]; }
export function cloudPathOps(points, r = 8) { // scalloped polygon
  const ops = []; if (points.length < 2) return ops; const n = points.length; let started = false;
  for (let i = 0; i < n; i++) { const a = points[i], b = points[(i + 1) % n]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); const steps = Math.max(1, Math.round(len / (r * 1.6))); for (let s = 0; s < steps; s++) { const t0 = s / steps, t1 = (s + 1) / steps; const p0 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], p1 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1]; const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2; const nx = -(p1[1] - p0[1]) / Math.max(1e-6, Math.hypot(p1[0] - p0[0], p1[1] - p0[1])) * r, ny = (p1[0] - p0[0]) / Math.max(1e-6, Math.hypot(p1[0] - p0[0], p1[1] - p0[1])) * r; if (!started) { ops.push(L.moveTo(p0[0], p0[1])); started = true; } const k = 0.9; ops.push(L.appendBezierCurve(p0[0] + nx * k, p0[1] + ny * k, p1[0] + nx * k, p1[1] + ny * k, p1[0], p1[1])); } }
  return ops;
}
export function inkSmoothOps(path) { const ops = []; if (!path.length) return ops; ops.push(L.moveTo(path[0][0], path[0][1])); for (let i = 1; i < path.length; i++) ops.push(L.lineTo(path[i][0], path[i][1])); return ops; }
async function textBlockOps(pdfDoc, text, rect, { fontFamily = 'Helvetica', fontSize = 12, color = '#000000', align = 'left', bold, italic, lineHeight = 1.2, pad = 2, charSpacing = 0, wordSpacing = 0 }) {
  const font = await getFont(pdfDoc, fontFamily, bold, italic); const fs = fontSize || 12; const [x1, y1, x2, y2] = rect; const lines = wrapLines(font, text, fs, x2 - x1 - pad * 2);
  const ops = [L.beginText(), ...fillOps({ fillColor: color }), L.setFontAndSize(fontKey(pdfDoc, font), fs), L.setCharacterSpacing(charSpacing || 0), L.setWordSpacing(wordSpacing || 0)]; let y = y2 - pad - fs * 0.85;
  for (const ln of lines) { const w = font.widthOfTextAtSize(ln, fs); const x = align === 'center' ? (x1 + x2) / 2 - w / 2 : align === 'right' ? x2 - pad - w : x1 + pad; ops.push(L.setTextMatrix(1, 0, 0, 1, x, y), L.showText(font.encodeText(ln))); y -= fs * lineHeight; }
  ops.push(L.endText()); return { ops, font };
}
const fontKeys = new WeakMap();
function fontKey(pdfDoc, font) { let m = fontKeys.get(pdfDoc); if (!m) { m = new Map(); fontKeys.set(pdfDoc, m); } if (!m.has(font)) m.set(font, PDFName.of('F' + (m.size + 1) + 'mpe')); return m.get(font); }
function fontResources(pdfDoc, fonts) { const d = {}; for (const f of fonts) d[fontKey(pdfDoc, f).decodeText()] = f.ref; return d; }

async function buildAppearance(pdfDoc, item, rect) {
  const p = item.props, ctx = pdfDoc.context; let ops = []; const fonts = []; const gs = extG(pdfDoc, item); ops.push(L.pushGraphicsState(), L.setGraphicsState('GSmpe'));
  const [x1, y1, x2, y2] = rect;
  switch (item.type) {
    case 'rect': ops.push(...strokeOps(p), ...fillOps(p), L.rectangle(x1 + (p.lineWidth || 0) / 2, y1 + (p.lineWidth || 0) / 2, x2 - x1 - (p.lineWidth || 0), y2 - y1 - (p.lineWidth || 0)), ...paintOp(p)); break;
    case 'ellipse': { ops.push(...strokeOps(p), ...fillOps(p)); const lw = (p.lineWidth || 0) / 2; ops.push(...L.drawEllipsePath({ x: (x1 + x2) / 2, y: (y1 + y2) / 2, xScale: (x2 - x1) / 2 - lw, yScale: (y2 - y1) / 2 - lw }), ...paintOp(p)); break; }
    case 'line': case 'arrow': case 'distance': { const [a, b] = item.points; ops.push(...strokeOps(p), L.moveTo(a[0], a[1]), L.lineTo(b[0], b[1]), L.stroke()); const hs = Math.max(6, (p.lineWidth || 1) * 4); if (item.type === 'arrow') ops.push(...arrowHeadOps(a, b, hs)); if (item.type === 'distance') { ops.push(...arrowHeadOps(b, a, hs), ...arrowHeadOps(a, b, hs)); const t = await textBlockOps(pdfDoc, measureLabel(item), [Math.min(a[0], b[0]), Math.max(a[1], b[1]) + 2, Math.max(a[0], b[0]) + 80, Math.max(a[1], b[1]) + 16], { fontSize: 9, color: p.color, align: 'left' }); ops.push(...t.ops); fonts.push(t.font); } break; }
    case 'polygon': case 'polyline': case 'area': case 'perimeter': { const pts = item.points; ops.push(...strokeOps(p), ...fillOps(p)); pts.forEach((pt, i) => ops.push(i ? L.lineTo(pt[0], pt[1]) : L.moveTo(pt[0], pt[1]))); const closed = item.type === 'polygon' || item.type === 'area'; ops.push(...(closed ? paintOp(p, true) : [L.stroke()])); if (item.type === 'area' || item.type === 'perimeter') { const bb = bboxOfPoints(pts); const t = await textBlockOps(pdfDoc, measureLabel(item), [bb[0], bb[3] + 2, bb[0] + 120, bb[3] + 16], { fontSize: 9, color: p.color }); ops.push(...t.ops); fonts.push(t.font); } break; }
    case 'cloud': ops.push(...strokeOps(p), ...fillOps(p), ...cloudPathOps(item.points, Math.max(5, (p.lineWidth || 1) * 5)), ...paintOp(p, true)); break;
    case 'ink': case 'brush': ops.push(...strokeOps(p)); if (item.type === 'brush') ops.push(L.setLineWidth((p.lineWidth || 1) * 3)); for (const path of item.paths || []) ops.push(...inkSmoothOps(path), L.stroke()); break;
    case 'highlight': ops.push(...fillOps({ fillColor: p.color })); for (const q of item.quads || []) ops.push(L.rectangle(q[0], q[1], q[2] - q[0], q[3] - q[1]), L.fill()); break;
    case 'underline': ops.push(...strokeOps({ ...p, lineWidth: 1 })); for (const q of item.quads || []) ops.push(L.moveTo(q[0], q[1] + 1), L.lineTo(q[2], q[1] + 1), L.stroke()); break;
    case 'strikeout': ops.push(...strokeOps({ ...p, lineWidth: 1 })); for (const q of item.quads || []) { const my = (q[1] + q[3]) / 2; ops.push(L.moveTo(q[0], my), L.lineTo(q[2], my), L.stroke()); } break;
    case 'squiggly': ops.push(...strokeOps({ ...p, lineWidth: 1 })); for (const q of item.quads || []) { ops.push(L.moveTo(q[0], q[1])); for (let x = q[0], up = true; x < q[2]; x += 3, up = !up) ops.push(L.lineTo(Math.min(x + 3, q[2]), q[1] + (up ? 3 : 0))); ops.push(L.stroke()); } break;
    case 'typewriter': case 'callout': { if (p.fillColor) ops.push(...fillOps(p), L.rectangle(x1, y1, x2 - x1, y2 - y1), L.fill()); if (p.borderColor && (p.borderWidth ?? 0) > 0) ops.push(...strokeOps({ color: p.borderColor, lineWidth: p.borderWidth }), L.rectangle(x1, y1, x2 - x1, y2 - y1), L.stroke()); if (item.type === 'callout' && item.points?.length >= 2) { ops.push(...strokeOps({ color: p.textColor || p.color, lineWidth: 1 })); item.points.forEach((pt, i) => ops.push(i ? L.lineTo(pt[0], pt[1]) : L.moveTo(pt[0], pt[1]))); ops.push(L.stroke(), ...arrowHeadOps(item.points[1], item.points[0], 7)); } const t = await textBlockOps(pdfDoc, p.contents, rect, { fontFamily: p.fontFamily, fontSize: p.fontSize || 12, color: p.textColor || p.color || '#000', align: p.align, bold: p.bold, italic: p.italic }); ops.push(...t.ops); fonts.push(t.font); break; }
    case 'note': { const c = colArr(p.color) || [1, 0.88, 0]; const w = x2 - x1, h = y2 - y1; ops.push(L.setFillingRgbColor(c[0], c[1], c[2]), L.setStrokingRgbColor(0.25, 0.25, 0.25), L.setLineWidth(1), L.moveTo(x1 + 1, y1 + 1), L.lineTo(x2 - 1, y1 + 1), L.lineTo(x2 - 1, y2 - 1 - h * 0.25), L.lineTo(x2 - 1 - w * 0.3, y2 - 1), L.lineTo(x1 + 1, y2 - 1), L.closePath(), L.fillAndStroke()); for (let i = 1; i <= 3; i++) ops.push(L.moveTo(x1 + w * 0.2, y2 - h * 0.22 * i - h * 0.1), L.lineTo(x1 + w * (i === 3 ? 0.55 : 0.8), y2 - h * 0.22 * i - h * 0.1), L.stroke()); break; }
    case 'fileattach': { const c = colArr(p.color) || [0.3, 0.3, 0.3]; ops.push(L.setStrokingRgbColor(c[0], c[1], c[2]), L.setLineWidth(1.5), L.moveTo(x1 + 4, y2 - 4), L.lineTo(x1 + 4, y1 + 5), L.appendBezierCurve(x1 + 4, y1 + 1, x2 - 4, y1 + 1, x2 - 4, y1 + 5), L.lineTo(x2 - 4, y2 - 6), L.appendBezierCurve(x2 - 4, y2 - 2, x1 + 8, y2 - 2, x1 + 8, y2 - 6), L.lineTo(x1 + 8, y1 + 8), L.stroke()); break; }
    case 'stamp': { const c = colArr(p.color) || [0.8, 0.1, 0.1]; ops.push(L.setStrokingRgbColor(c[0], c[1], c[2]), L.setLineWidth(2), L.rectangle(x1 + 1.5, y1 + 1.5, x2 - x1 - 3, y2 - y1 - 3), L.stroke()); const fs = Math.max(8, Math.min((y2 - y1) * 0.55, (x2 - x1) / Math.max(4, (p.stampName || 'DRAFT').length) * 1.7)); const t = await textBlockOps(pdfDoc, p.stampName || 'DRAFT', [x1, (y1 + y2) / 2 - fs * 0.6 - 2, x2, (y1 + y2) / 2 + fs * 0.6], { fontFamily: 'Helvetica-Bold', fontSize: fs, color: p.color || '#cc1a1a', align: 'center', bold: true }); ops.push(...t.ops); fonts.push(t.font); break; }
    case 'label': { const c = colArr(p.color) || [0.2, 0.6, 0.2]; const w = x2 - x1, h = y2 - y1; ops.push(L.setStrokingRgbColor(c[0], c[1], c[2]), L.setLineWidth(Math.max(1.5, w / 8))); const m = p.marker || 'Check'; if (m === 'Check') ops.push(L.moveTo(x1 + w * .15, y1 + h * .5), L.lineTo(x1 + w * .4, y1 + h * .2), L.lineTo(x2 - w * .12, y2 - h * .15), L.stroke()); else if (m === 'Circle') ops.push(...L.drawEllipsePath({ x: (x1 + x2) / 2, y: (y1 + y2) / 2, xScale: w * .4, yScale: h * .4 }), L.stroke()); else if (m === 'Cross') ops.push(L.moveTo(x1 + w * .2, y1 + h * .2), L.lineTo(x2 - w * .2, y2 - h * .2), L.moveTo(x1 + w * .2, y2 - h * .2), L.lineTo(x2 - w * .2, y1 + h * .2), L.stroke()); else if (m === 'RightArrow') ops.push(L.moveTo(x1 + w * .15, (y1 + y2) / 2), L.lineTo(x2 - w * .15, (y1 + y2) / 2), L.moveTo(x2 - w * .45, y2 - h * .2), L.lineTo(x2 - w * .15, (y1 + y2) / 2), L.lineTo(x2 - w * .45, y1 + h * .2), L.stroke()); else if (m === 'Star') { const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, R = Math.min(w, h) * .45; for (let i = 0; i < 10; i++) { const r = i % 2 ? R * .45 : R, a = Math.PI / 2 + i * Math.PI / 5; ops.push(i ? L.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)) : L.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))); } ops.push(L.closePath(), L.stroke()); } else ops.push(L.moveTo(x1 + w * .15, y1 + h * .5), L.lineTo(x1 + w * .4, y1 + h * .2), L.lineTo(x2 - w * .12, y2 - h * .15), L.stroke()); break; }
    case 'redact': { ops.push(...fillOps({ fillColor: p.fillColor || '#000000' }), L.rectangle(x1, y1, x2 - x1, y2 - y1), L.fill()); if (p.overlayText) { const t = await textBlockOps(pdfDoc, p.overlayText, rect, { fontSize: 10, color: p.textColor || '#ff0000', align: 'center' }); ops.push(...t.ops); fonts.push(t.font); } break; }
    default: break;
  }
  ops.push(L.popGraphicsState());
  const xobj = ctx.formXObject(ops, { BBox: [x1, y1, x2, y2], Resources: { ExtGState: { GSmpe: gs }, Font: fontResources(pdfDoc, fonts) } });
  return ctx.register(xobj);
}
export function measureLabel(item) { const u = item.props.units || 'pt', scale = item.props.scale || 1; const f = v => `${(v / ({ pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, px: 0.75 }[u] || 1) * scale).toFixed(2)} ${u}`; const pts = item.points || []; if (item.type === 'distance') return f(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])); if (item.type === 'perimeter') { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return f(s); } if (item.type === 'area') { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } const k = { pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, px: 0.75 }[u] || 1; return `${(Math.abs(a) / 2 / (k * k) * scale * scale).toFixed(2)} ${u}²`; } return ''; }

function itemRect(item) { if (item.points?.length) { const bb = bboxOfPoints(item.points); const m = (item.props.lineWidth || 1) * 4 + 2; return [Math.min(bb[0], item.rect[0]) - m, Math.min(bb[1], item.rect[1]) - m, Math.max(bb[2], item.rect[2]) + m, Math.max(bb[3], item.rect[3]) + m]; } if (item.paths?.length) { const bb = bboxOfPoints(item.paths.flat()); const m = (item.props.lineWidth || 1) * 2 + 1; return [bb[0] - m, bb[1] - m, bb[2] + m, bb[3] + m]; } if (item.quads?.length) { const bb = [Math.min(...item.quads.map(q => q[0])), Math.min(...item.quads.map(q => q[1])), Math.max(...item.quads.map(q => q[2])), Math.max(...item.quads.map(q => q[3]))]; return bb; } return rectNorm(item.rect); }

async function annotDict(pdfDoc, item, pageRef) {
  const p = item.props; const rect = itemRect(item); const ctx = pdfDoc.context;
  const sub = { note: 'Text', typewriter: 'FreeText', callout: 'FreeText', label: 'Stamp', distance: 'Line', area: 'Polygon', perimeter: 'PolyLine', arrow: 'Line', line: 'Line', rect: 'Square', ellipse: 'Circle', ink: 'Ink', brush: 'Ink', polygon: 'Polygon', polyline: 'PolyLine', cloud: 'Polygon', stamp: 'Stamp', highlight: 'Highlight', strikeout: 'StrikeOut', underline: 'Underline', squiggly: 'Squiggly', fileattach: 'FileAttachment', redact: 'Redact', caret: 'Caret' }[item.type] || 'Square';
  let F = 0; if (p.printable !== false) F |= 4; if (p.hidden) F |= 2; if (p.locked) F |= 128;
  const d = { Type: 'Annot', Subtype: sub, Rect: rect.map(v => +v.toFixed(3)), F, P: pageRef, NM: PDFString.of(item.id), T: PDFHexString.fromText(p.author || ''), Contents: PDFHexString.fromText(p.contents || ''), Subj: PDFHexString.fromText(p.subject || ''), M: PDFString.of(pdfDate(p.modified)), CreationDate: PDFString.of(pdfDate(p.created)), CA: p.opacity ?? 1 };
  const c = colArr(item.type === 'typewriter' || item.type === 'callout' ? p.fillColor : p.color); if (c) d.C = c; const ic = colArr(p.fillColor); if (ic && !['typewriter', 'callout', 'redact'].includes(item.type)) d.IC = ic;
  if (['line', 'arrow', 'distance', 'rect', 'ellipse', 'polygon', 'polyline', 'area', 'perimeter', 'cloud', 'ink', 'brush'].includes(item.type)) d.BS = { Type: 'Border', W: item.type === 'brush' ? (p.lineWidth || 1) * 3 : (p.lineWidth ?? 1), S: p.lineStyle === 'dashed' ? 'D' : 'S', ...(p.lineStyle === 'dashed' ? { D: [4, 3] } : {}) };
  if (item.type === 'note') { d.Name = p.icon || 'Note'; d.Open = !!p.popupOpen; }
  if (item.type === 'line' || item.type === 'arrow' || item.type === 'distance') { d.L = [...item.points[0], ...item.points[1]].map(v => +v.toFixed(3)); if (item.type === 'arrow') d.LE = ['None', 'OpenArrow']; if (item.type === 'distance') { d.LE = ['OpenArrow', 'OpenArrow']; d.IT = 'LineDimension'; d.Cap = true; } }
  if (['polygon', 'polyline', 'area', 'perimeter', 'cloud'].includes(item.type)) { d.Vertices = item.points.flat().map(v => +v.toFixed(3)); if (item.type === 'cloud') { d.IT = 'PolygonCloud'; d.BE = { S: 'C', I: 1 }; } if (item.type === 'area') d.IT = 'PolygonDimension'; if (item.type === 'perimeter') d.IT = 'PolyLineDimension'; }
  if (item.type === 'ink' || item.type === 'brush') d.InkList = (item.paths || []).map(path => path.flat().map(v => +v.toFixed(2)));
  if (item.quads) d.QuadPoints = item.quads.flatMap(q => [q[0], q[3], q[2], q[3], q[0], q[1], q[2], q[1]].map(v => +v.toFixed(3)));
  if (item.type === 'typewriter' || item.type === 'callout') { const tc = colArr(p.textColor || p.color) || [0, 0, 0]; d.DA = PDFString.of(`${tc.join(' ')} rg /Helv ${p.fontSize || 12} Tf`); d.Q = { left: 0, center: 1, right: 2 }[p.align] || 0; if (item.type === 'callout') { d.IT = 'FreeTextCallout'; d.CL = item.points.flat().map(v => +v.toFixed(3)); d.LE = 'OpenArrow'; } else d.IT = 'FreeTextTypewriter'; }
  if (item.type === 'stamp') d.Name = PDFName.of((p.stampName || 'Draft').replace(/[^A-Za-z0-9]/g, '')); if (item.type === 'label') d.Name = PDFName.of('Label' + (p.marker || 'Check'));
  if (item.type === 'fileattach') { d.Name = p.icon || 'PushPin'; if (p.fileContent) { const fs = embedFileSpec(pdfDoc, p.fileName || 'attachment', p.fileContent instanceof Uint8Array ? p.fileContent : base64ToBytes(p.fileContent)); d.FS = fs; } }
  if (item.type === 'redact') { d.IC = colArr(p.fillColor || '#000000'); if (p.overlayText) d.OverlayText = PDFHexString.fromText(p.overlayText); }
  if (item.type === 'distance' || item.type === 'area' || item.type === 'perimeter') d.Measure = { Type: 'Measure', Subtype: 'RL', R: PDFString.of(`1 ${p.units || 'pt'} = ${p.scale || 1} ${p.units || 'pt'}`), X: [{ Type: 'NumberFormat', U: PDFString.of(p.units || 'pt'), C: p.scale || 1, D: 100 }], D: [{ Type: 'NumberFormat', U: PDFString.of(p.units || 'pt'), C: 1, D: 100 }], A: [{ Type: 'NumberFormat', U: PDFString.of(p.units || 'pt'), C: 1, D: 100 }] };
  if (p.inReplyTo) d.IRT = p.inReplyTo; if (p.replyType) d.RT = 'R';
  const dict = ctx.obj(d);
  dict.set(PDFName.of('AP'), ctx.obj({ N: await buildAppearance(pdfDoc, item, rect) }));
  return dict;
}
function embedFileSpec(pdfDoc, name, bytes) { const ctx = pdfDoc.context; const ef = ctx.flateStream(bytes, { Type: 'EmbeddedFile', Params: { Size: bytes.length, ModDate: PDFString.of(pdfDate()) } }); const efRef = ctx.register(ef); return ctx.register(ctx.obj({ Type: 'Filespec', F: PDFString.of(name), UF: PDFHexString.fromText(name), EF: { F: efRef, UF: efRef } })); }

function annotsArray(pdfDoc, page) { let a = page.node.lookup(PDFName.of('Annots')); if (!(a instanceof PDFArray)) { a = pdfDoc.context.obj([]); page.node.set(PDFName.of('Annots'), a); } return a; }
const origNum = id => parseInt(String(id), 10);
function removeOrigAnnots(pdfDoc, page, nums) { const arr = page.node.lookup(PDFName.of('Annots')); if (!(arr instanceof PDFArray)) return; const keep = []; for (let i = 0; i < arr.size(); i++) { const r = arr.get(i); if (r instanceof PDFRef && nums.has(r.objectNumber)) { const d = pdfDoc.context.lookup(r); if (d instanceof PDFDict) { const pop = d.get(PDFName.of('Popup')); if (pop instanceof PDFRef) nums.add(pop.objectNumber); } continue; } keep.push(r); } const out = keep.filter(r => !(r instanceof PDFRef && nums.has(r.objectNumber))); page.node.set(PDFName.of('Annots'), pdfDoc.context.obj(out)); }
function lookupOrigAnnot(pdfDoc, page, id) { const arr = page.node.lookup(PDFName.of('Annots')); if (!(arr instanceof PDFArray)) return null; const n = origNum(id); for (let i = 0; i < arr.size(); i++) { const r = arr.get(i); if (r instanceof PDFRef && r.objectNumber === n) return { ref: r, dict: pdfDoc.context.lookup(r) }; } return null; }

// ---------- objects (page content) ----------
async function drawObjectOps(pdfDoc, item, pm) {
  const p = item.props; const [x1, y1, x2, y2] = rectNorm(item.rect); const w = x2 - x1, h = y2 - y1; const ops = [L.pushGraphicsState()]; const res = { fonts: [], xobjects: {}, gs: {} };
  if ((p.opacity ?? 1) < 1) { const g = pdfDoc.context.register(pdfDoc.context.obj({ Type: 'ExtGState', CA: p.opacity, ca: p.opacity })); res.gs['GSo' + item.id] = g; ops.push(L.setGraphicsState('GSo' + item.id)); }
  if (item.rotation) { const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2; ops.push(L.translate(cx, cy), L.rotateDegrees(item.rotation), L.translate(-cx, -cy)); }
  switch (item.type) {
    case 'cover': ops.push(...fillOps({ fillColor: p.fillColor || settings.editing.textCover }), L.rectangle(x1, y1, w, h), L.fill()); break;
    case 'rect': ops.push(...strokeOps(p), ...fillOps(p), L.rectangle(x1, y1, w, h), ...paintOp(p)); break;
    case 'ellipse': ops.push(...strokeOps(p), ...fillOps(p), ...L.drawEllipsePath({ x: x1 + w / 2, y: y1 + h / 2, xScale: w / 2, yScale: h / 2 }), ...paintOp(p)); break;
    case 'line': { const [a, b] = item.points || [[x1, y1], [x2, y2]]; ops.push(...strokeOps(p), L.moveTo(a[0], a[1]), L.lineTo(b[0], b[1]), L.stroke()); break; }
    case 'ink': case 'initials': ops.push(...strokeOps(p)); for (const path of item.paths || []) ops.push(...inkSmoothOps(path), L.stroke()); break;
    case 'text': case 'ftext': { const t = await textBlockOps(pdfDoc, p.text, [x1, y1, x2, y2], { fontFamily: p.fontFamily, fontSize: p.fontSize, color: p.color, align: p.align, bold: p.bold, italic: p.italic, lineHeight: p.lineHeight || 1.2, pad: item.type === 'ftext' ? 2 : 0, charSpacing: p.charSpacing, wordSpacing: p.wordSpacing }); if (p.fillColor) ops.unshift(...fillOps(p), L.rectangle(x1, y1, w, h), L.fill()); ops.push(...t.ops); res.fonts.push(t.font); break; }
    case 'image': { if (!p.imageData) break; const img = await embedImage(pdfDoc, p.imageData); if (!img) break; const key = 'Im' + item.id; res.xobjects[key] = img.ref; ops.push(...L.drawImage(key, { x: x1, y: y1, width: w, height: h, rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) })); break; }
  }
  ops.push(L.popGraphicsState()); return { ops, res };
}
const imgCache = new WeakMap();
export async function embedImage(pdfDoc, dataUrl) {
  let m = imgCache.get(pdfDoc); if (!m) { m = new Map(); imgCache.set(pdfDoc, m); } if (m.has(dataUrl)) return m.get(dataUrl);
  let img = null; try { if (/^data:image\/jpe?g/.test(dataUrl)) img = await pdfDoc.embedJpg(dataUrl); else if (/^data:image\/png/.test(dataUrl)) img = await pdfDoc.embedPng(dataUrl); else { const png = await toPngDataUrl(dataUrl); img = await pdfDoc.embedPng(png); } } catch (e) { console.warn('embed image', e); }
  m.set(dataUrl, img); return img;
}
export async function toPngDataUrl(src) { const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; }); const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); return c.toDataURL('image/png'); }
function addResources(page, res) {
  const ctx = page.doc.context; const r = page.node.normalizedEntries().Resources || (() => { const d = ctx.obj({}); page.node.set(PDFName.of('Resources'), d); return d; })();
  const sub = (name) => { let d = r.lookup(PDFName.of(name)); if (!(d instanceof PDFDict)) { d = ctx.obj({}); r.set(PDFName.of(name), d); } return d; };
  if (res.fonts.length) { const f = sub('Font'); for (const font of res.fonts) f.set(fontKey(page.doc, font), font.ref); }
  if (Object.keys(res.xobjects).length) { const x = sub('XObject'); for (const [k, v] of Object.entries(res.xobjects)) x.set(PDFName.of(k), v); }
  if (Object.keys(res.gs).length) { const g = sub('ExtGState'); for (const [k, v] of Object.entries(res.gs)) g.set(PDFName.of(k), v); }
}
export function prependContent(pdfDoc, page, ops) { const ctx = pdfDoc.context; const stream = ctx.register(ctx.stream(ops.map(o => o.toString()).join('\n'))); const existing = page.node.Contents(); const arr = []; arr.push(stream); if (existing instanceof PDFArray) for (let i = 0; i < existing.size(); i++) arr.push(existing.get(i)); else if (existing) arr.push(page.node.get(PDFName.of('Contents'))); page.node.set(PDFName.of('Contents'), ctx.obj(arr)); }
function wrapContentInGraphicsState(pdfDoc, page) { // q ... Q around existing content so our drawings start from a clean state
  const ctx = pdfDoc.context; const existing = page.node.Contents(); if (!existing) return; const q = ctx.register(ctx.stream('q\n')), Q = ctx.register(ctx.stream('\nQ\n')); const arr = [q]; if (existing instanceof PDFArray) for (let i = 0; i < existing.size(); i++) arr.push(existing.get(i)); else arr.push(page.node.get(PDFName.of('Contents'))); arr.push(Q); page.node.set(PDFName.of('Contents'), ctx.obj(arr));
}

// ---------- fields ----------
async function bakeFields(pdfDoc, doc, pages) {
  const form = pdfDoc.getForm(); const used = new Set(form.getFields().map(f => f.getName())); const radioGroups = new Map();
  const uniq = (name, kind) => { let n = name || kind; if (!used.has(n)) { used.add(n); return n; } let i = 2; while (used.has(`${n}_${i}`)) i++; used.add(`${n}_${i}`); return `${n}_${i}`; };
  for (let i = 0; i < doc.pages.length; i++) {
    const pm = doc.pages[i], page = pages[i];
    for (const it of pm.items.filter(x => x.kind === 'field')) {
      const p = it.props; const [x1, y1, x2, y2] = rectNorm(it.rect); const geo = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
      if (it.orig) { // existing widget
        const found = lookupOrigAnnot(pdfDoc, page, it.orig);
        if (it.deleted) { if (found) { try { const f = p.name ? form.getFieldMaybe(p.name) : null; if (f && it.type !== 'link') form.removeField(f); else removeOrigAnnots(pdfDoc, page, new Set([found.ref.objectNumber])); } catch { removeOrigAnnots(pdfDoc, page, new Set([found.ref.objectNumber])); } } continue; }
        if (found && found.dict instanceof PDFDict) { if (it.origModified) found.dict.set(PDFName.of('Rect'), pdfDoc.context.obj([x1, y1, x2, y2])); if (it.type === 'link' && it.origModified) applyLinkActions(pdfDoc, found.dict, p, doc); }
        if (it.type !== 'link' && it.type !== 'signature' && p.name) { try { const f = form.getFieldMaybe(p.name); if (f) applyFieldValue(f, it, form); } catch (e) { console.warn('field value', e); } }
        continue;
      }
      const style = { textColor: col(p.textColor || '#000'), backgroundColor: col(p.fillColor), borderColor: p.borderWidth > 0 ? col(p.borderColor || '#000') : undefined, borderWidth: p.borderWidth ?? 1 };
      try {
        if (it.type === 'text') { const f = form.createTextField(uniq(p.name, 'Text')); if (p.multiline) f.enableMultiline(); if (p.password) f.enablePassword(); if (p.maxLen) f.setMaxLength(p.maxLen); if (p.comb) { f.setMaxLength(p.comb); f.enableCombing(); } if (p.readOnly) f.enableReadOnly(); if (p.required) f.enableRequired(); if (!p.scrollable) f.disableScrolling(); f.setAlignment(p.align === 'center' ? TextAlignment.Center : p.align === 'right' ? TextAlignment.Right : TextAlignment.Left); if (p.value) f.setText(safeText(await getFont(pdfDoc, 'Helvetica'), p.value)); f.addToPage(page, { ...geo, ...style, font: await getFont(pdfDoc, p.fontFamily || 'Helvetica') }); if (p.fontSize) f.setFontSize(p.fontSize); }
        else if (it.type === 'checkbox') { const f = form.createCheckBox(uniq(p.name, 'CheckBox')); f.addToPage(page, { ...geo, ...style }); if (p.checked) f.check(); if (p.readOnly) f.enableReadOnly(); if (p.required) f.enableRequired(); setWidgetExtras(pdfDoc, f, p, 'checkbox'); }
        else if (it.type === 'radio') { const name = p.name || 'Radio'; let g = radioGroups.get(name); if (!g) { g = form.createRadioGroup(uniq(name, 'Radio')); radioGroups.set(name, g); } const val = p.exportValue || 'Choice' + (g.getOptions().length + 1); g.addOptionToPage(val, page, { ...geo, ...style }); if (p.checked) g.select(val); }
        else if (it.type === 'combo' || it.type === 'list') { const f = it.type === 'combo' ? form.createDropdown(uniq(p.name, 'Combo')) : form.createOptionList(uniq(p.name, 'List')); const opts = (p.options || []).map(o => o.label || o.value).filter(Boolean); if (opts.length) f.addOptions(opts); if (p.value && opts.includes(p.value)) f.select(p.value); if (p.editable && it.type === 'combo') f.enableEditing(); if (p.multiSelect) f.enableMultiselect(); if (p.sort) f.enableSorting(); if (p.readOnly) f.enableReadOnly(); if (p.required) f.enableRequired(); f.addToPage(page, { ...geo, ...style, font: await getFont(pdfDoc, 'Helvetica') }); if (p.fontSize) f.setFontSize(p.fontSize); }
        else if (it.type === 'button') { const f = form.createButton(uniq(p.name, 'Button')); f.addToPage(safeText(await getFont(pdfDoc, 'Helvetica'), p.caption || ''), page, { ...geo, ...style, font: await getFont(pdfDoc, 'Helvetica') }); setWidgetExtras(pdfDoc, f, p, 'button'); applyActions(pdfDoc, f.acroField.getWidgets()[0].dict, p.actions, doc); }
        else if (it.type === 'signature') { const ctx = pdfDoc.context; const d = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFHexString.fromText(uniq(p.name, 'Signature')), Rect: [x1, y1, x2, y2], F: 4, P: page.ref, MK: { BG: colArr(p.fillColor) || undefined, BC: colArr(p.borderColor) || undefined } }); const ref = ctx.register(d); annotsArray(pdfDoc, page).push(ref); form.acroForm.addField(ref); }
        else if (it.type === 'link') { const ctx = pdfDoc.context; const d = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x1, y1, x2, y2], Border: [0, 0, p.borderWidth || 0], C: colArr(p.borderColor) || [0, 0, 1], F: 4, H: 'I' }); if (p.borderStyle === 'dashed') d.set(PDFName.of('BS'), ctx.obj({ W: p.borderWidth || 0, S: 'D', D: [3, 3] })); if (p.borderStyle === 'underline') d.set(PDFName.of('BS'), ctx.obj({ W: p.borderWidth || 1, S: 'U' })); applyLinkActions(pdfDoc, d, p, doc); annotsArray(pdfDoc, page).push(ctx.register(d)); }
      } catch (e) { console.warn('bake field', it, e); }
    }
  }
  try { form.updateFieldAppearances(await getFont(pdfDoc, 'Helvetica')); } catch (e) { console.warn('appearances', e); }
}
function setWidgetExtras(pdfDoc, f, p, kind) { try { const w = f.acroField.getWidgets()[0]; const mk = w.getOrCreateAppearanceCharacteristics(); if (kind === 'button') { if (p.downCaption) mk.dict.set(PDFName.of('AC'), PDFHexString.fromText(p.downCaption)); if (p.rolloverCaption) mk.dict.set(PDFName.of('RC'), PDFHexString.fromText(p.rolloverCaption)); mk.dict.set(PDFName.of('TP'), PDFNumber.of(0)); } if (p.tooltip) f.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(p.tooltip)); } catch { } }
function applyFieldValue(f, it, form) { const p = it.props; const isType = (cls) => f instanceof cls; if (isType(L.PDFTextField)) { if (p.value !== undefined) { try { f.setText(p.value || ''); } catch { } } } else if (isType(L.PDFCheckBox)) { p.checked ? f.check() : f.uncheck(); } else if (isType(L.PDFRadioGroup)) { if (p.checked && p.exportValue) { try { f.select(p.exportValue); } catch { } } } else if (isType(L.PDFDropdown) || isType(L.PDFOptionList)) { if (p.value) { try { f.select(p.value); } catch { } } } }
function actionDict(pdfDoc, a, doc) { const ctx = pdfDoc.context; const pages = pdfDoc.getPages(); switch (a.type) { case 'uri': return ctx.obj({ S: 'URI', URI: PDFString.of(a.url || '') }); case 'goto': { const pg = pages[Math.min(pages.length - 1, Math.max(0, (a.page ?? 1) - 1))]; return ctx.obj({ S: 'GoTo', D: [pg.ref, 'XYZ', null, a.top ?? null, a.zoom || 0] }); } case 'file': return ctx.obj({ S: 'Launch', F: PDFString.of(a.file || '') }); case 'reset': return ctx.obj({ S: 'ResetForm' }); case 'submit': return ctx.obj({ S: 'SubmitForm', F: { FS: 'URL', F: PDFString.of(a.url || '') }, Flags: a.format === 'pdf' ? 256 : a.format === 'html' ? 4 : a.format === 'xfdf' ? 32 : 0 }); case 'showhide': return ctx.obj({ S: 'Hide', T: PDFHexString.fromText(a.field || ''), H: a.hide !== false }); case 'js': return ctx.obj({ S: 'JavaScript', JS: PDFHexString.fromText(a.script || '') }); default: return null; } }
function chainActions(pdfDoc, acts, doc) { const dicts = acts.map(a => actionDict(pdfDoc, a, doc)).filter(Boolean); if (!dicts.length) return null; for (let i = 0; i < dicts.length - 1; i++) dicts[i].set(PDFName.of('Next'), dicts[i + 1]); return dicts[0]; }
function applyActions(pdfDoc, dict, actions = [], doc) { const byEvent = {}; for (const a of actions) (byEvent[a.event || 'up'] ||= []).push(a); const map = { up: 'U', down: 'D', enter: 'E', exit: 'X', focus: 'Fo', blur: 'Bl', keystroke: 'K', format: 'F', validate: 'V', calculate: 'C' }; const aa = pdfDoc.context.obj({}); let any = false; for (const [ev, list] of Object.entries(byEvent)) { const d = chainActions(pdfDoc, list, doc); if (!d) continue; if (ev === 'up') dict.set(PDFName.of('A'), d); else { aa.set(PDFName.of(map[ev] || 'U'), d); any = true; } } if (any) dict.set(PDFName.of('AA'), aa); }
function applyLinkActions(pdfDoc, dict, p, doc) { const acts = p.actions?.length ? p.actions : (p.url ? [{ type: 'uri', url: p.url }] : []); const d = chainActions(pdfDoc, acts, doc); if (d) dict.set(PDFName.of('A'), d); else dict.delete(PDFName.of('A')); }

// ---------- outline / attachments / js / metadata ----------
function writeOutline(pdfDoc, outline) {
  const ctx = pdfDoc.context, cat = pdfDoc.catalog; const pages = pdfDoc.getPages();
  if (!outline.length) { cat.delete(PDFName.of('Outlines')); return; }
  const rootRef = ctx.nextRef(); const build = (nodes, parentRef) => { const refs = nodes.map(() => ctx.nextRef()); let total = 0; nodes.forEach((n, i) => { const d = { Title: PDFHexString.fromText(n.title || ''), Parent: parentRef }; if (i > 0) d.Prev = refs[i - 1]; if (i < nodes.length - 1) d.Next = refs[i + 1]; if (n.url) d.A = { S: 'URI', URI: PDFString.of(n.url) }; else if (n.page != null && pages[n.page]) d.Dest = [pages[n.page].ref, 'XYZ', null, n.top ?? null, n.zoom ?? 0]; if (n.actions?.length) { const a = chainActions(pdfDoc, n.actions, null); if (a) d.A = a; } let flags = 0; if (n.italic) flags |= 1; if (n.bold) flags |= 2; if (flags) d.F = flags; const c = colArr(n.color); if (c) d.C = c; if (n.children?.length) { const sub = build(n.children, refs[i]); d.First = sub.first; d.Last = sub.last; d.Count = n.open === false ? -sub.count : sub.count; total += sub.count; } ctx.assign(refs[i], ctx.obj(d)); total++; }); return { first: refs[0], last: refs[refs.length - 1], count: total }; };
  const r = build(outline, rootRef); ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: r.first, Last: r.last, Count: r.count })); cat.set(PDFName.of('Outlines'), rootRef);
}
function writeAttachments(pdfDoc, doc) {
  const ctx = pdfDoc.context; const anyChange = doc.attachments.some(a => !a.orig) || doc.removedAttachments.length;
  if (!anyChange) return;
  const names = pdfDoc.catalog.lookup(PDFName.of('Names')); if (names instanceof PDFDict) names.delete(PDFName.of('EmbeddedFiles'));
  for (const a of doc.attachments) { if (!a.content) continue; pdfDoc.attach(a.content, a.name, { mimeType: a.mime || 'application/octet-stream', description: a.description || '', creationDate: new Date(), modificationDate: new Date() }); }
}
function writeJavaScript(pdfDoc, doc) {
  const ctx = pdfDoc.context; for (const js of doc.docJs) { if (js.script?.trim()) pdfDoc.addJavaScript(js.name || 'Script', js.script); }
  const aa = {}; const map = { willClose: 'WC', willSave: 'WS', didSave: 'DS', willPrint: 'WP', didPrint: 'DP' }; let any = false; for (const [k, v] of Object.entries(doc.docActions)) if (v?.trim()) { aa[map[k]] = { S: 'JavaScript', JS: PDFHexString.fromText(v) }; any = true; }
  if (any) pdfDoc.catalog.set(PDFName.of('AA'), ctx.obj(aa));
  const pages = pdfDoc.getPages();
  for (const [key, acts] of Object.entries(doc.pageActions)) { const pm = doc.pages.find(p => p.key === key); if (!pm || !pages[pm.index]) continue; const pa = {}; if (acts.open?.trim()) pa.O = { S: 'JavaScript', JS: PDFHexString.fromText(acts.open) }; if (acts.close?.trim()) pa.C = { S: 'JavaScript', JS: PDFHexString.fromText(acts.close) }; if (Object.keys(pa).length) pages[pm.index].node.set(PDFName.of('AA'), ctx.obj(pa)); }
  for (const [key, order] of Object.entries(doc.tabOrder)) { const pm = doc.pages.find(p => p.key === key); if (pm && pages[pm.index] && order && order !== 'unspecified') pages[pm.index].node.set(PDFName.of('Tabs'), PDFName.of({ row: 'R', column: 'C', structure: 'S' }[order] || 'R')); }
}
export function writeMetadata(pdfDoc, doc) {
  const m = doc.meta || {}; if (m.Title != null) pdfDoc.setTitle(m.Title || ''); if (m.Author != null) pdfDoc.setAuthor(m.Author || ''); if (m.Subject != null) pdfDoc.setSubject(m.Subject || ''); if (m.Keywords != null) pdfDoc.setKeywords(String(m.Keywords || '').split(/[,;]\s*/).filter(Boolean)); if (m.Creator != null) pdfDoc.setCreator(m.Creator || ''); pdfDoc.setProducer('Master PDF Editor replica'); pdfDoc.setModificationDate(new Date());
  const iv = doc.initialView || {}; const cat = pdfDoc.catalog; if (iv.pageMode) cat.set(PDFName.of('PageMode'), PDFName.of(iv.pageMode)); if (iv.pageLayout) cat.set(PDFName.of('PageLayout'), PDFName.of(iv.pageLayout)); if (iv.openPage != null) { const pg = pdfDoc.getPages()[iv.openPage]; if (pg) cat.set(PDFName.of('OpenAction'), pdfDoc.context.obj([pg.ref, 'XYZ', null, null, iv.zoom || 0])); }
  const vp = {}; if (iv.hideToolbar) vp.HideToolbar = true; if (iv.hideMenubar) vp.HideMenubar = true; if (iv.fitWindow) vp.FitWindow = true; if (iv.centerWindow) vp.CenterWindow = true; if (iv.displayDocTitle) vp.DisplayDocTitle = true; if (Object.keys(vp).length) cat.set(PDFName.of('ViewerPreferences'), pdfDoc.context.obj(vp));
}

// ---------- the main bake ----------
export async function bake(doc, { flattenAnnots = false, includeAnnots = true, includeFields = true } = {}) {
  const pdfDoc = await libLoad(doc); const pages = pdfDoc.getPages();
  for (let i = 0; i < doc.pages.length && i < pages.length; i++) {
    const pm = doc.pages[i], page = pages[i];
    const objects = pm.items.filter(it => it.kind === 'object'); const annots = pm.items.filter(it => it.kind === 'annot');
    let wrapped = false; const ensureWrap = () => { if (!wrapped) { wrapContentInGraphicsState(pdfDoc, page); wrapped = true; } };
    for (const it of objects) {
      const needsCover = it.orig && (it.deleted || it.origModified); const isNew = !it.orig;
      if (needsCover) { ensureWrap(); const { ops, res } = await drawObjectOps(pdfDoc, { ...it, type: 'cover', rotation: 0, rect: it.origRect || it.rect, props: { fillColor: settings.editing.textCover } }, pm); page.pushOperators(...ops); addResources(page, res); }
      if (it.deleted) continue;
      if (isNew || needsCover) { ensureWrap(); const draw = { ...it }; if (it.orig === 'text') draw.type = 'text'; if (it.orig === 'image' || it.orig === 'vector') { if (it.orig === 'image' && it.props.imageData) draw.type = 'image'; else continue; } const { ops, res } = await drawObjectOps(pdfDoc, draw, pm); page.pushOperators(...ops); addResources(page, res); }
    }
    const removeNums = new Set(); for (const it of annots) if (it.orig && (it.deleted || it.origModified || flattenAnnots)) removeNums.add(origNum(it.orig));
    if (!includeAnnots) for (const it of annots) if (it.orig) removeNums.add(origNum(it.orig));
    if (removeNums.size) removeOrigAnnots(pdfDoc, page, removeNums);
    if (includeAnnots) for (const it of annots) {
      if (it.deleted) continue; if (it.orig && !it.origModified && !flattenAnnots) continue; if (it.type === 'link') continue;
      if (flattenAnnots) { ensureWrap(); const apRef = await buildAppearance(pdfDoc, it, itemRect(it)); const key = 'FA' + it.id; addResources(page, { fonts: [], xobjects: { [key]: apRef }, gs: {} }); page.pushOperators(L.pushGraphicsState(), L.drawObject(key), L.popGraphicsState()); continue; }
      const d = await annotDict(pdfDoc, it, page.ref); const ref = pdfDoc.context.register(d); annotsArray(pdfDoc, page).push(ref);
      if (it.type === 'note' || (it.props.contents && !['typewriter', 'callout'].includes(it.type))) { const r = itemRect(it); const pop = pdfDoc.context.register(pdfDoc.context.obj({ Type: 'Annot', Subtype: 'Popup', Parent: ref, Rect: [r[2] + 10, r[3] - 120, r[2] + 190, r[3]], Open: !!it.props.popupOpen, F: 28 })); d.set(PDFName.of('Popup'), pop); annotsArray(pdfDoc, page).push(pop); }
      for (const rep of it.props.replies || []) { const rd = pdfDoc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: itemRect(it).map(v => +v.toFixed(2)), F: 28, IRT: ref, RT: 'R', T: PDFHexString.fromText(rep.author || ''), Contents: PDFHexString.fromText(rep.contents || ''), M: PDFString.of(pdfDate(rep.date)), CreationDate: PDFString.of(pdfDate(rep.date)), Name: 'Comment', P: page.ref }); annotsArray(pdfDoc, page).push(pdfDoc.context.register(rd)); }
      if (it.props.status && it.props.status !== 'None') { const sd = pdfDoc.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: itemRect(it).map(v => +v.toFixed(2)), F: 30, IRT: ref, RT: 'R', T: PDFHexString.fromText(it.props.statusBy || it.props.author || ''), Contents: PDFHexString.fromText(it.props.status), State: PDFHexString.fromText(it.props.status), StateModel: PDFHexString.fromText('Review'), M: PDFString.of(pdfDate()), P: page.ref }); annotsArray(pdfDoc, page).push(pdfDoc.context.register(sd)); }
    }
  }
  if (includeFields) await bakeFields(pdfDoc, doc, pages);
  writeOutline(pdfDoc, doc.outline); writeAttachments(pdfDoc, doc); writeJavaScript(pdfDoc, doc); writeMetadata(pdfDoc, doc);
  return pdfDoc;
}
export async function saveBytes(doc, opts = {}) {
  const pdfDoc = await bake(doc, opts); let bytes = await libSave(pdfDoc, { useObjectStreams: !!opts.objectStreams });
  if (opts.security?.enabled) bytes = await encryptPdf(bytes, opts.security);
  return bytes;
}

// ---------- page operations ----------
export function blankPage(pdfDoc, { width = 595.276, height = 841.89, index = null }) { const p = index == null ? pdfDoc.addPage([width, height]) : pdfDoc.insertPage(index, [width, height]); return p; }
export async function insertBlankPages(doc, { index, count = 1, width, height }) {
  return structural(doc, 'Insert Blank Pages', (pdfDoc) => { const order = doc.pages.slice(); for (let i = 0; i < count; i++) { pdfDoc.insertPage(index + i, [width, height]); order.splice(index + i, 0, null); } return order; });
}
export async function deletePages(doc, indices) {
  const set = new Set(indices); return structural(doc, 'Delete Pages', (pdfDoc) => { [...set].sort((a, b) => b - a).forEach(i => pdfDoc.removePage(i)); return doc.pages.filter((_, i) => !set.has(i)); });
}
export async function rotatePages(doc, indices, deg) {
  return structural(doc, 'Rotate Pages', (pdfDoc) => { const pages = pdfDoc.getPages(); for (const i of indices) { const p = pages[i]; p.setRotation(degrees(((p.getRotation().angle + deg) % 360 + 360) % 360)); } });
}
export async function movePages(doc, indices, to) { // move selected pages so that they start at position `to` (index in the resulting document before removal semantics)
  return structural(doc, 'Move Pages', (pdfDoc) => { const set = new Set(indices); const pages = pdfDoc.getPages(); const moving = [...set].sort((a, b) => a - b); const movingPages = moving.map(i => pages[i]); const before = moving.filter(i => i < to).length; const target = to - before; moving.slice().reverse().forEach(i => pdfDoc.removePage(i)); movingPages.forEach((p, k) => pdfDoc.insertPage(target + k, p)); const order = doc.pages.filter((_, i) => !set.has(i)); order.splice(target, 0, ...moving.map(i => doc.pages[i])); return order; });
}
export async function cropPages(doc, indices, box, mode = 'crop') { // box in user space [x1,y1,x2,y2]
  return structural(doc, 'Crop Pages', (pdfDoc) => { const pages = pdfDoc.getPages(); for (const i of indices) { const p = pages[i]; const [x1, y1, x2, y2] = rectNorm(box); if (mode === 'media') { p.setMediaBox(x1, y1, x2 - x1, y2 - y1); p.setCropBox(x1, y1, x2 - x1, y2 - y1); } else p.setCropBox(x1, y1, x2 - x1, y2 - y1); } });
}
export async function setPageLayout(doc, indices, { width, height, anchor = 'center', scaleContent = false }) {
  return structural(doc, 'Page Layout', (pdfDoc) => { const pages = pdfDoc.getPages(); for (const i of indices) { const p = pages[i]; const mb = p.getMediaBox(); const cb = p.getCropBox(); const ow = cb.width, oh = cb.height; if (scaleContent) { const s = Math.min(width / ow, height / oh); p.scaleContent(s, s); p.scaleAnnotations(s, s); p.setMediaBox(cb.x * s, cb.y * s, width, height); p.setCropBox(cb.x * s, cb.y * s, width, height); continue; } const dx = anchor.includes('left') ? 0 : anchor.includes('right') ? width - ow : (width - ow) / 2; const dy = anchor.includes('bottom') ? 0 : anchor.includes('top') ? height - oh : (height - oh) / 2; p.translateContent(dx, dy); try { const annots = p.node.Annots(); if (annots) for (let k = 0; k < annots.size(); k++) { const a = pdfDoc.context.lookup(annots.get(k)); const r = a?.lookup?.(PDFName.of('Rect')); if (r instanceof PDFArray) { const v = r.asArray().map(n => n.asNumber()); a.set(PDFName.of('Rect'), pdfDoc.context.obj([v[0] + dx, v[1] + dy, v[2] + dx, v[3] + dy])); } } } catch { } p.setMediaBox(0, 0, width, height); p.setCropBox(0, 0, width, height); } });
}
export async function insertFromBytes(doc, { bytes, index, pages = null, password = '' }) {
  return structural(doc, 'Insert Pages', async (pdfDoc) => { const src = await loadForeign(bytes, password); const idx = pages || src.getPageIndices(); const copied = await pdfDoc.copyPages(src, idx); const order = doc.pages.slice(); copied.forEach((p, k) => { pdfDoc.insertPage(index + k, p); order.splice(index + k, 0, null); }); return order; });
}
export async function loadForeign(bytes, password = '') { try { return await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false }); } catch (e) { if (/encrypted/i.test(e.message)) { const r = await decryptPdf(bytes, password); return r.doc; } throw e; } }
export async function replacePages(doc, indices, { bytes, pages }) {
  return structural(doc, 'Replace Pages', async (pdfDoc) => { const src = await loadForeign(bytes); const srcIdx = pages || src.getPageIndices(); const copied = await pdfDoc.copyPages(src, srcIdx); const sorted = [...indices].sort((a, b) => a - b); const first = sorted[0]; sorted.slice().reverse().forEach(i => pdfDoc.removePage(i)); copied.forEach((p, k) => pdfDoc.insertPage(first + k, p)); const order = doc.pages.filter((_, i) => !indices.includes(i)); order.splice(first, 0, ...copied.map(() => null)); return order; });
}
export async function extractPages(doc, indices, { separate = false, withBookmarks = true } = {}) {
  const baked = await bake(doc); const mk = async (idx) => { const out = await PDFDocument.create(); const copied = await out.copyPages(baked, idx); copied.forEach(p => out.addPage(p)); if (withBookmarks) { const bm = doc.outline.filter(n => idx.includes(n.page)).map(n => ({ ...n, page: idx.indexOf(n.page), children: [] })); writeOutline(out, bm); } return out.save({ useObjectStreams: false }); };
  if (separate) { const files = []; for (const i of indices) files.push({ name: doc.name.replace(/\.pdf$/i, '') + `_page${i + 1}.pdf`, bytes: await mk([i]) }); return files; }
  return [{ name: doc.name.replace(/\.pdf$/i, '') + '_extracted.pdf', bytes: await mk(indices) }];
}
export async function newBlankDocument({ width = 595.276, height = 841.89, count = 1 }) { const pdfDoc = await PDFDocument.create(); for (let i = 0; i < count; i++) pdfDoc.addPage([width, height]); pdfDoc.setProducer('Master PDF Editor replica'); pdfDoc.setCreator('Master PDF Editor replica'); pdfDoc.setCreationDate(new Date()); return pdfDoc.save({ useObjectStreams: false }); }
export async function imageToPdfBytes(dataUrl, { pageSize = null, margin = 0 } = {}) { const pdfDoc = await PDFDocument.create(); const img = await embedImage(pdfDoc, dataUrl); if (!img) throw new Error('Unsupported image'); let w = img.width * 0.75, h = img.height * 0.75; if (pageSize) { const [pw, ph] = pageSize; const s = Math.min((pw - 2 * margin) / w, (ph - 2 * margin) / h, 1); const page = pdfDoc.addPage([pw, ph]); page.drawImage(img, { x: (pw - w * s) / 2, y: (ph - h * s) / 2, width: w * s, height: h * s }); } else { const page = pdfDoc.addPage([w, h]); page.drawImage(img, { x: 0, y: 0, width: w, height: h }); } return pdfDoc.save({ useObjectStreams: false }); }
export async function textToPdfBytes(text, { fontSize = 11 } = {}) { const pdfDoc = await PDFDocument.create(); const font = await pdfDoc.embedFont(StandardFonts.Courier); const [pw, ph] = PAGE_SIZES.A4; const lines = wrapLines(font, text, fontSize, pw - 100); let page = pdfDoc.addPage([pw, ph]); let y = ph - 50; for (const ln of lines) { if (y < 50) { page = pdfDoc.addPage([pw, ph]); y = ph - 50; } page.drawText(ln, { x: 50, y, size: fontSize, font }); y -= fontSize * 1.3; } return pdfDoc.save({ useObjectStreams: false }); }
export async function mergeBytes(list) { const out = await PDFDocument.create(); for (const b of list) { const src = await loadForeign(b); const copied = await out.copyPages(src, src.getPageIndices()); copied.forEach(p => out.addPage(p)); } return out.save({ useObjectStreams: false }); }

// ---------- rasterising ----------
export async function renderPageToCanvas(pm, { scale = 2, annotations = true, background = '#ffffff' } = {}) {
  const vp = pm.pdfPage.getViewport({ scale }); const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height); const ctx = c.getContext('2d'); ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height);
  await pm.pdfPage.render({ canvasContext: ctx, viewport: vp, annotationMode: annotations ? pdfjsLib.AnnotationMode.ENABLE : pdfjsLib.AnnotationMode.DISABLE, background }).promise; return c;
}
export async function convertToScanned(doc, indices, { dpi = 150, grayscale = false, jpegQuality = 0.85, drawOverlay = null } = {}) {
  const images = []; for (const i of indices) { const pm = doc.pages[i]; const c = await renderPageToCanvas(pm, { scale: dpi / 72 }); if (drawOverlay) await drawOverlay(c, pm, dpi / 72); if (grayscale) { const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height); for (let k = 0; k < d.data.length; k += 4) { const v = 0.3 * d.data[k] + 0.59 * d.data[k + 1] + 0.11 * d.data[k + 2]; d.data[k] = d.data[k + 1] = d.data[k + 2] = v; } g.putImageData(d, 0, 0); } images.push({ i, dataUrl: c.toDataURL('image/jpeg', jpegQuality), w: pm.width, h: pm.height, rot: pm.rotate }); }
  return structural(doc, 'Convert to Scanned Pages', async (pdfDoc) => { const pages = pdfDoc.getPages(); for (const im of images) { const page = pages[im.i]; const img = await pdfDoc.embedJpg(im.dataUrl); const w = page.getWidth(), h = page.getHeight(); const np = pdfDoc.insertPage(im.i + 1, [im.rot % 180 ? h : w, im.rot % 180 ? w : h]); np.drawImage(img, { x: 0, y: 0, width: np.getWidth(), height: np.getHeight() }); pdfDoc.removePage(im.i); const pm = doc.pages[im.i]; pm.items = pm.items.filter(it => !it.orig); pm.scan = null; } return doc.pages.slice(); });
}
export async function optimizeImages(doc, { maxDpi = 150, quality = 0.75 } = {}) {
  return structural(doc, 'Optimize', async (pdfDoc) => {
    const pages = pdfDoc.getPages(); let count = 0;
    for (let i = 0; i < pages.length; i++) {
      const pm = doc.pages[i]; const scan = await doc.scanPage(pm); const page = pages[i]; const res = page.node.Resources(); const xo = res?.lookup(PDFName.of('XObject')); if (!(xo instanceof PDFDict)) continue;
      for (const im of scan.images) { if (!im.props.imgName || im.props.inline) continue; let data = null; try { data = pm.pdfPage.objs.get(im.props.imgName); } catch { continue; } if (!data) continue; const w = im.rect[2] - im.rect[0], h = im.rect[3] - im.rect[1]; const dpi = data.width / (w / 72); if (dpi <= maxDpi * 1.1) continue; const s = Math.min(1, maxDpi / dpi); const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(data.width * s)); c.height = Math.max(1, Math.round(data.height * s)); const g = c.getContext('2d'); const src = imageDataToCanvas(data); if (!src) continue; g.drawImage(src, 0, 0, c.width, c.height); const jpg = await pdfDoc.embedJpg(c.toDataURL('image/jpeg', quality)); xo.set(PDFName.of(im.props.imgName), jpg.ref); count++; }
    }
    return doc.pages.slice();
  });
}
export function imageDataToCanvas(data) { try { const c = document.createElement('canvas'); c.width = data.width; c.height = data.height; const g = c.getContext('2d'); if (data.bitmap) { g.drawImage(data.bitmap, 0, 0); return c; } if (data.data) { let rgba; if (data.data.length === data.width * data.height * 4) rgba = data.data; else if (data.data.length === data.width * data.height * 3) { rgba = new Uint8ClampedArray(data.width * data.height * 4); for (let i = 0, j = 0; i < data.data.length; i += 3, j += 4) { rgba[j] = data.data[i]; rgba[j + 1] = data.data[i + 1]; rgba[j + 2] = data.data[i + 2]; rgba[j + 3] = 255; } } else if (data.data.length === data.width * data.height) { rgba = new Uint8ClampedArray(data.width * data.height * 4); for (let i = 0, j = 0; i < data.data.length; i++, j += 4) { rgba[j] = rgba[j + 1] = rgba[j + 2] = data.data[i]; rgba[j + 3] = 255; } } else return null; g.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), data.width, data.height), 0, 0); return c; } } catch { } return null; }

// ---------- header/footer, watermark, background ----------
export async function addHeaderFooter(doc, { indices, left = '', center = '', right = '', fleft = '', fcenter = '', fright = '', fontFamily = 'Helvetica', fontSize = 10, color = '#000000', margin = 36, startNumber = 1 }) {
  return structural(doc, 'Header and Footer', async (pdfDoc) => { const pages = pdfDoc.getPages(); const font = await getFont(pdfDoc, fontFamily); const total = pages.length; for (const i of indices) { const page = pages[i]; const { width, height } = page.getSize(); const sub = s => safeText(font, String(s || '').replace(/<<page>>|\{page\}/gi, String(i + startNumber)).replace(/<<total>>|\{total\}/gi, String(total)).replace(/<<date>>|\{date\}/gi, new Date().toLocaleDateString()).replace(/<<time>>|\{time\}/gi, new Date().toLocaleTimeString()).replace(/<<title>>|\{title\}/gi, doc.meta.Title || doc.name)); const draw = (txt, x, y, align) => { if (!txt) return; const t = sub(txt); const w = font.widthOfTextAtSize(t, fontSize); page.drawText(t, { x: align === 'l' ? x : align === 'r' ? x - w : x - w / 2, y, size: fontSize, font, color: col(color) }); }; draw(left, margin, height - margin, 'l'); draw(center, width / 2, height - margin, 'c'); draw(right, width - margin, height - margin, 'r'); draw(fleft, margin, margin, 'l'); draw(fcenter, width / 2, margin, 'c'); draw(fright, width - margin, margin, 'r'); } });
}
export async function addWatermark(doc, { indices, text = '', imageData = null, fontFamily = 'Helvetica', fontSize = 48, color = '#ff0000', opacity = 0.3, rotation = 45, behind = false, scale = 50, position = 'center' }) {
  return structural(doc, 'Watermark', async (pdfDoc) => { const pages = pdfDoc.getPages(); const font = await getFont(pdfDoc, fontFamily, true); const img = imageData ? await embedImage(pdfDoc, imageData) : null; for (const i of indices) { const page = pages[i]; const { width, height } = page.getSize(); const gsRef = pdfDoc.context.register(pdfDoc.context.obj({ Type: 'ExtGState', CA: opacity, ca: opacity })); const key = 'GSwm' + i; addResources(page, { fonts: [], xobjects: {}, gs: { [key]: gsRef } }); const ops = [L.pushGraphicsState(), L.setGraphicsState(key)]; const cx = position.includes('left') ? width * 0.25 : position.includes('right') ? width * 0.75 : width / 2, cy = position.includes('top') ? height * 0.75 : position.includes('bottom') ? height * 0.25 : height / 2; if (img) { const iw = width * scale / 100, ih = iw * img.height / img.width; const xk = 'ImWm' + i; addResources(page, { fonts: [], xobjects: { [xk]: img.ref }, gs: {} }); ops.push(...L.drawImage(xk, { x: cx - iw / 2, y: cy - ih / 2, width: iw, height: ih, rotate: degrees(rotation), xSkew: degrees(0), ySkew: degrees(0) })); } if (text) { const t = safeText(font, text); const w = font.widthOfTextAtSize(t, fontSize); addResources(page, { fonts: [font], xobjects: {}, gs: {} }); const c = colArr(color) || [1, 0, 0]; ops.push(L.beginText(), L.setFillingRgbColor(c[0], c[1], c[2]), L.setFontAndSize(fontKey(pdfDoc, font), fontSize), L.rotateAndSkewTextDegreesAndTranslate(rotation, 0, 0, cx - (w / 2) * Math.cos(rotation * Math.PI / 180), cy - (w / 2) * Math.sin(rotation * Math.PI / 180)), L.showText(font.encodeText(t)), L.endText()); } ops.push(L.popGraphicsState()); if (behind) prependContent(pdfDoc, page, ops); else { wrapContentInGraphicsState(pdfDoc, page); page.pushOperators(...ops); } } });
}
export async function addBackground(doc, { indices, color = null, imageData = null, opacity = 1, scale = 100 }) {
  return structural(doc, 'Background', async (pdfDoc) => { const pages = pdfDoc.getPages(); const img = imageData ? await embedImage(pdfDoc, imageData) : null; for (const i of indices) { const page = pages[i]; const { width, height } = page.getSize(); const gsRef = pdfDoc.context.register(pdfDoc.context.obj({ Type: 'ExtGState', CA: opacity, ca: opacity })); const key = 'GSbg' + i; addResources(page, { fonts: [], xobjects: {}, gs: { [key]: gsRef } }); const ops = [L.pushGraphicsState(), L.setGraphicsState(key)]; if (color) { const c = colArr(color); ops.push(L.setFillingRgbColor(c[0], c[1], c[2]), L.rectangle(0, 0, width, height), L.fill()); } if (img) { const iw = width * scale / 100, ih = iw * img.height / img.width; const xk = 'ImBg' + i; addResources(page, { fonts: [], xobjects: { [xk]: img.ref }, gs: {} }); ops.push(...L.drawImage(xk, { x: (width - iw) / 2, y: (height - ih) / 2, width: iw, height: ih, rotate: degrees(0), xSkew: degrees(0), ySkew: degrees(0) })); } ops.push(L.popGraphicsState()); prependContent(pdfDoc, page, ops); } });
}
export async function addBatesNumbering(doc, { indices, prefix = '', suffix = '', start = 1, digits = 6, position = 'bottom-right', fontSize = 10, margin = 36 }) {
  return structural(doc, 'Bates Numbering', async (pdfDoc) => { const pages = pdfDoc.getPages(); const font = await getFont(pdfDoc, 'Helvetica'); let n = start; for (const i of indices) { const page = pages[i]; const { width, height } = page.getSize(); const t = safeText(font, `${prefix}${String(n++).padStart(digits, '0')}${suffix}`); const w = font.widthOfTextAtSize(t, fontSize); const x = position.includes('left') ? margin : position.includes('right') ? width - margin - w : width / 2 - w / 2; const y = position.includes('top') ? height - margin : margin; page.drawText(t, { x, y, size: fontSize, font }); } });
}

// ---------- export ----------
export async function pageText(pm) { const tc = await pm.pdfPage.getTextContent(); let out = '', lastY = null, lastX = null; for (const it of tc.items) { if (!('str' in it)) continue; const y = it.transform[5], x = it.transform[4]; if (lastY !== null && Math.abs(y - lastY) > 2) out += '\n'; else if (lastX !== null && x - lastX > 4 && out && !out.endsWith(' ')) out += ' '; out += it.str; if (it.hasEOL) out += '\n'; lastY = y; lastX = x + it.width; } return out; }
export async function exportText(doc, indices) { let out = ''; for (const i of indices) out += (await pageText(doc.pages[i])) + '\n\n'; return out; }
export function textToCsv(text) { return text.split('\n').filter(l => l.trim()).map(l => l.trim().split(/\s{2,}|\t/).map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n'); }
export function textToHtmlDoc(text, title, kind) { const rows = text.split('\n').map(l => `<tr>${l.trim().split(/\s{2,}|\t/).map(c => `<td>${c.replace(/</g, '&lt;')}</td>`).join('')}</tr>`).join(''); if (kind === 'xls') return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><title>${title}</title></head><body><table>${rows}</table></body></html>`; return `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${title}</title></head><body>${text.split('\n\n').map(p => `<p>${p.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')}</body></html>`; }
export function canvasToBmp(c) { const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; const rowSize = (c.width * 3 + 3) & ~3; const size = 54 + rowSize * c.height; const b = new ArrayBuffer(size); const v = new DataView(b); const u = new Uint8Array(b); u[0] = 0x42; u[1] = 0x4D; v.setUint32(2, size, true); v.setUint32(10, 54, true); v.setUint32(14, 40, true); v.setInt32(18, c.width, true); v.setInt32(22, c.height, true); v.setUint16(26, 1, true); v.setUint16(28, 24, true); v.setUint32(34, rowSize * c.height, true); v.setInt32(38, 2835, true); v.setInt32(42, 2835, true); for (let y = 0; y < c.height; y++) { let o = 54 + (c.height - 1 - y) * rowSize; for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; u[o++] = d[i + 2]; u[o++] = d[i + 1]; u[o++] = d[i]; } } return new Blob([b], { type: 'image/bmp' }); }
export function canvasToTiff(c) { const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; const n = c.width * c.height; const rgb = new Uint8Array(n * 3); for (let i = 0, j = 0; i < n * 4; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; } const entries = 11; const ifdOff = 8 + rgb.length; const extra = ifdOff + 2 + entries * 12 + 4; const buf = new ArrayBuffer(extra + 6 + 16); const v = new DataView(buf); const u = new Uint8Array(buf); u[0] = 0x49; u[1] = 0x49; v.setUint16(2, 42, true); v.setUint32(4, ifdOff, true); u.set(rgb, 8); let o = ifdOff; v.setUint16(o, entries, true); o += 2; const bpsOff = extra, resOff = extra + 6; const tag = (t, type, count, val) => { v.setUint16(o, t, true); v.setUint16(o + 2, type, true); v.setUint32(o + 4, count, true); if (type === 3 && count === 1) v.setUint16(o + 8, val, true); else v.setUint32(o + 8, val, true); o += 12; }; tag(256, 4, 1, c.width); tag(257, 4, 1, c.height); tag(258, 3, 3, bpsOff); tag(259, 3, 1, 1); tag(262, 3, 1, 2); tag(273, 4, 1, 8); tag(277, 3, 1, 3); tag(278, 4, 1, c.height); tag(279, 4, 1, rgb.length); tag(282, 5, 1, resOff); tag(283, 5, 1, resOff + 8); v.setUint32(o, 0, true); v.setUint16(bpsOff, 8, true); v.setUint16(bpsOff + 2, 8, true); v.setUint16(bpsOff + 4, 8, true); v.setUint32(resOff, 72, true); v.setUint32(resOff + 4, 1, true); v.setUint32(resOff + 8, 72, true); v.setUint32(resOff + 12, 1, true); return new Blob([buf], { type: 'image/tiff' }); }
export async function canvasToBlob(c, format = 'png', quality = 0.9) { if (format === 'bmp') return canvasToBmp(c); if (format === 'tiff') return canvasToTiff(c); return new Promise(res => c.toBlob(res, format === 'jpg' ? 'image/jpeg' : 'image/png', quality)); }
export async function extractImages(doc, indices) { const out = []; for (const i of indices) { const pm = doc.pages[i]; const scan = await doc.scanPage(pm); let k = 0; for (const im of scan.images) { let data = null; try { data = im.props.inline ? im.ref : pm.pdfPage.objs.get(im.props.imgName); } catch { } if (!data) continue; const c = imageDataToCanvas(data); if (!c) continue; out.push({ name: `${doc.name.replace(/\.pdf$/i, '')}_p${i + 1}_${++k}.png`, blob: await canvasToBlob(c, 'png') }); } } return out; }
export async function imageDataUrlOf(pm, im) { let data = null; try { data = im.props.inline ? im.ref : pm.pdfPage.objs.get(im.props.imgName); } catch { } if (!data) return null; const c = imageDataToCanvas(data); return c ? c.toDataURL('image/png') : null; }
export async function toPdfA(doc) {
  return structural(doc, 'Convert to PDF/A', async (pdfDoc) => { const ctx = pdfDoc.context; const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${(doc.meta.Title || doc.name).replace(/[<&]/g, '')}</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`; const ms = ctx.stream(xmp, { Type: 'Metadata', Subtype: 'XML' }); pdfDoc.catalog.set(PDFName.of('Metadata'), ctx.register(ms)); pdfDoc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([ctx.obj({ Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'), Info: PDFString.of('sRGB IEC61966-2.1'), RegistryName: PDFString.of('http://www.color.org') })])); pdfDoc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true })); });
}
export async function flattenForm(doc) { return structural(doc, 'Flatten Forms', async (pdfDoc) => { try { pdfDoc.getForm().flatten(); } catch (e) { console.warn(e); } for (const pm of doc.pages) pm.items = pm.items.filter(it => it.kind !== 'field'); }); }
export { PDFDocument };
