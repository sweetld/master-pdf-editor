// Restyling original vector graphics in place: stroke and fill colour (or none), line width, dash
// style and opacity. The page's content streams (and the form XObjects they draw) are walked in
// drawing order like pdf.js does; the path matching a scanned graphic's fingerprint (its operands,
// op count and occurrence number, recorded by PdfDoc.scanPage) is wrapped in "q <new style> … Q" and
// its paint operator adjusted. Everything else in the stream is left byte for byte, so the graphic
// keeps its exact geometry and its place in the stacking order.
const L = PDFLib;
const { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber } = L;

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Tokens of a content stream with their byte offsets (enough to find operators and operands). */
function* tokens(b) {
  let i = 0; const n = b.length; const txt = (s, e) => { let o = ''; for (let k = s; k < e; k++) o += String.fromCharCode(b[k]); return o; };
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 37) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; }            // % comment
    const s = i;
    if (c === 40) { let depth = 0; for (; i < n; i++) { if (b[i] === 92) { i++; continue; } if (b[i] === 40) depth++; else if (b[i] === 41 && --depth === 0) { i++; break; } } yield { t: 'str', s, e: i }; continue; }
    if (c === 60 && b[i + 1] === 60) { i += 2; yield { t: '<<', s, e: i }; continue; }
    if (c === 62 && b[i + 1] === 62) { i += 2; yield { t: '>>', s, e: i }; continue; }
    if (c === 60) { while (i < n && b[i] !== 62) i++; i++; yield { t: 'hex', s, e: i }; continue; }
    if (c === 91 || c === 93 || c === 123 || c === 125) { i++; yield { t: String.fromCharCode(c), s, e: i }; continue; }
    if (c === 47) { i++; while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++; yield { t: 'name', v: txt(s + 1, i), s, e: i }; continue; }
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++; if (i === s) { i++; continue; }
    const w = txt(s, i);
    if (NUM.test(w)) { yield { t: 'num', v: parseFloat(w), s, e: i }; continue; }
    if (w === 'ID') { // inline image data: skip to EI
      i++; while (i < n - 1 && !(WS.has(b[i - 1]) && b[i] === 69 && b[i + 1] === 73 && (i + 2 >= n || WS.has(b[i + 2])))) i++; i += 2; yield { t: 'op', v: 'EI', s, e: i }; continue;
    }
    yield { t: 'op', v: w, s, e: i };
  }
}

function decode(obj) {
  if (!obj) return null;
  if (obj instanceof L.PDFRawStream) return L.decodePDFRawStream(obj).decode();
  if (typeof obj.getUnencodedContents === 'function') return obj.getUnencodedContents();
  if (typeof obj.getContents === 'function') return obj.getContents();
  return null;
}
const concat = parts => { const len = parts.reduce((a, p) => a + p.length + 1, 0); const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; out[o++] = 10; } return out; };
const enc = s => new TextEncoder().encode(s);
const f = v => String(+(+v).toFixed(4));
const rgb = hex => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255); };
const sameSig = (nums, nops, t) => nops === t.nops && nums.length === t.nco && t.sig.every((v, k) => Math.abs(nums[k] - v) <= 0.011 + Math.abs(v) * 1e-5);

/**
 * Restyles graphics on page ``pageIndex`` of ``pdfDoc`` (pdf-lib). ``targets``: [{ pathSig, style }]
 * where style = { color, fillColor, lineWidth (user units), lineScale, lineStyle, opacity }; a null
 * color / fillColor removes that paint. Returns how many paths were changed.
 */
export function restyle(pdfDoc, pageIndex, targets) {
  const ctx = pdfDoc.context; const page = pdfDoc.getPages()[pageIndex]; const seen = new Map(); const edits = new Map(); // stream key -> [edit]
  const streams = new Map(); // key -> { bytes, write(bytes), resources }
  const lookup = v => (v instanceof PDFRef ? ctx.lookup(v) : v);
  const pageRes = lookup(page.node.Resources?.() ?? page.node.get(PDFName.of('Resources'))) || page.node.getInheritableAttribute?.(PDFName.of('Resources'));
  const walk = (key, bytes, resources, depth) => {
    let operands = [], inPath = false, clip = false, nums = [], nops = 0, start = 0;
    for (const tk of tokens(bytes)) {
      if (tk.t !== 'op') { operands.push(tk); continue; }
      const op = tk.v;
      if (PATH_OPS.has(op)) { if (!inPath) { inPath = true; clip = false; nums = []; nops = 0; start = operands.length ? operands[0].s : tk.s; } for (const o of operands) if (o.t === 'num') nums.push(o.v); nops++; }
      else if (op === 'W' || op === 'W*') clip = true;
      else if (PAINT_OPS.has(op)) {
        if (inPath && !clip && op !== 'n') for (const t of targets) { if (!sameSig(nums, nops, t.pathSig)) continue; const sk = t.pathSig; const k = seen.get(sk) || 0; seen.set(sk, k + 1); if (k === t.pathSig.k) (edits.get(key) || edits.set(key, []).get(key)).push({ start, ps: tk.s, pe: tk.e, op, style: t.style, resources }); }
        inPath = false;
      } else {
        inPath = false;
        if (op === 'Do' && depth < 12) { const nm = operands[0]?.t === 'name' ? operands[0].v : null; const xo = nm && lookup(lookup(resources)?.get?.(PDFName.of('XObject')))?.get?.(PDFName.of(nm)); const ref = xo instanceof PDFRef ? xo : null; const st = lookup(xo); const sub = st?.dict?.get?.(PDFName.of('Subtype')); if (st && sub === PDFName.of('Form')) { const fkey = ref ? 'x' + ref.objectNumber : 'x?'; if (!streams.has(fkey)) { const fb = decode(st); if (fb) streams.set(fkey, { bytes: fb, ref, stream: st, resources: lookup(st.dict.get(PDFName.of('Resources'))) || resources }); } const fs = streams.get(fkey); if (fs) walk(fkey, fs.bytes, fs.resources, depth + 1); } }
      }
      operands = [];
    }
  };
  const contents = lookup(page.node.get(PDFName.of('Contents'))); const parts = contents instanceof PDFArray ? contents.asArray().map(r => decode(lookup(r))).filter(Boolean) : [decode(contents)].filter(Boolean);
  const pageBytes = concat(parts); streams.set('page', { bytes: pageBytes, resources: pageRes });
  walk('page', pageBytes, pageRes, 0);
  let changed = 0; let gsN = 0;
  for (const [key, list] of edits) {
    const st = streams.get(key); let b = st.bytes;
    for (const e of list.sort((a, c) => c.start - a.start)) {
      const s = e.style; const st2 = []; const stroke = s.color ? rgb(s.color) : null, fill = s.fillColor ? rgb(s.fillColor) : null;
      if (stroke) st2.push(`${stroke.map(f).join(' ')} RG`); if (fill) st2.push(`${fill.map(f).join(' ')} rg`);
      if (s.lineWidth != null) st2.push(`${f(s.lineWidth / (s.lineScale || 1))} w`);
      const unit = Math.max(0.5, (s.lineWidth || 1) / (s.lineScale || 1)); st2.push(s.lineStyle === 'dashed' ? `[${f(unit * 3)} ${f(unit * 3)}] 0 d` : s.lineStyle === 'dotted' ? `[${f(unit)} ${f(unit * 2)}] 0 d` : '[] 0 d');
      if (s.opacity != null && s.opacity < 1) { const res = lookup(e.resources); if (res instanceof PDFDict) { let egs = lookup(res.get(PDFName.of('ExtGState'))); if (!(egs instanceof PDFDict)) { egs = ctx.obj({}); res.set(PDFName.of('ExtGState'), egs); } let nm; do nm = `MPEa${++gsN}`; while (egs.get(PDFName.of(nm))); egs.set(PDFName.of(nm), ctx.obj({ Type: 'ExtGState', CA: s.opacity, ca: s.opacity })); st2.push(`/${nm} gs`); } }
      const closes = e.op === 's' || e.op === 'b' || e.op === 'b*', eo = e.op.endsWith('*');
      const paint = stroke && fill ? (closes ? 'b' : 'B') + (eo ? '*' : '') : stroke ? (closes ? 's' : 'S') : fill ? 'f' + (eo ? '*' : '') : 'n';
      const pre = enc(`q ${st2.join(' ')} `), post = enc(`${paint} Q`);
      const out = new Uint8Array(b.length + pre.length + post.length); let o = 0;
      out.set(b.subarray(0, e.start), o); o += e.start; out.set(pre, o); o += pre.length; out.set(b.subarray(e.start, e.ps), o); o += e.ps - e.start; out.set(post, o); o += post.length; out.set(b.subarray(e.pe), o); o += b.length - e.pe;
      b = out.subarray(0, o); changed++;
    }
    if (key === 'page') page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(b)));
    else { const entries = {}; for (const [k, v] of st.stream.dict.entries()) { const nm = k.asString().slice(1); if (!['Filter', 'DecodeParms', 'Length'].includes(nm)) entries[nm] = v; } const ns = ctx.flateStream(b, entries); if (st.ref) ctx.assign(st.ref, ns); }
  }
  return changed;
}
