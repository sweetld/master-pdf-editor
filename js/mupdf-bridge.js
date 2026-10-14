// MuPDF (WASM) for the operations pdf-lib cannot do: removing original page content, decrypting and encrypting, compacting.
let mod = null, loading = null;
export async function mupdf() { if (mod) return mod; if (!loading) loading = import('../vendor/mupdf/mupdf.js').then(m => (mod = m)); return loading; }
export async function available() { try { await mupdf(); return true; } catch (e) { console.warn('mupdf unavailable', e); return false; } }
const open = (M, bytes, password = '') => { const d = M.PDFDocument.openDocument(bytes.slice(), 'application/pdf'); if (d.needsPassword() && !d.authenticatePassword(password || '')) { d.destroy(); const e = new Error('password'); e.name = 'PasswordException'; throw e; } return d; };
/** Opens an (optionally encrypted) PDF and returns a decrypted copy plus what the password granted. */
export async function decrypt(bytes, password = '') {
  const M = await mupdf(); const doc = M.PDFDocument.openDocument(bytes.slice(), 'application/pdf'); const needs = doc.needsPassword(); let level = 1;
  if (needs) { level = doc.authenticatePassword(password || ''); if (!level) { doc.destroy(); const e = new Error('password'); e.name = 'PasswordException'; throw e; } }
  const enc = doc.getMetaData('encryption') || 'None'; const perms = {}; for (const [k, v] of Object.entries({ print: 'print', copy: 'copy', modify: 'edit', annotate: 'annotate', fillForms: 'form', accessibility: 'accessibility', assemble: 'assemble', printHigh: 'print-hq' })) { try { perms[k] = doc.hasPermission(v); } catch { perms[k] = true; } }
  const out = enc === 'None' ? bytes : doc.saveToBuffer('encrypt=none').asUint8Array().slice(); doc.destroy();
  // authenticatePassword: 1 = none needed, 2 = user password, 4 = owner password (6 = both)
  return { bytes: out, encrypted: enc !== 'None', isOwner: !needs || (level & 4) !== 0, level, method: /AES/.test(enc) ? (/256/.test(enc) ? 'aes-256' : 'aes-128') : /RC4/.test(enc) ? (/40/.test(enc) ? 'rc4-40' : 'rc4-128') : enc === 'None' ? null : 'other', permissions: perms, description: enc };
}
export async function encrypt(bytes, { method = 'aes-128', userPassword = '', ownerPassword = '', permissions = null } = {}) {
  const M = await mupdf(); const doc = open(M, bytes); const P = permissions ? permFlags(permissions) : -1; const esc = s => String(s || '').replace(/,/g, '\\,');
  const out = doc.saveToBuffer(`encrypt=${method},user-password=${esc(userPassword)},owner-password=${esc(ownerPassword || userPassword)},permissions=${P}`).asUint8Array().slice(); doc.destroy(); return out;
}
export function permFlags(p) { let v = 0xFFFFF0C0; const bits = { print: 4, modify: 8, copy: 16, annotate: 32, fillForms: 256, accessibility: 512, assemble: 1024, printHigh: 2048 }; for (const [k, b] of Object.entries(bits)) if (p[k]) v |= b; return v | 0; }
/** Removes page content under rectangles. rects are in MuPDF page space (origin top-left, as displayed). */
export async function removeContent(bytes, jobs, { images = true, lineArt = true, text = true, blackBoxes = false, password = '' } = {}) {
  const M = await mupdf(); const doc = open(M, bytes, password); let any = false;
  for (const job of jobs) { if (!job.rects?.length) continue; const page = doc.loadPage(job.pageIndex); for (const r of job.rects) { const a = page.createAnnotation('Redact'); a.setRect([Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]); a.update(); any = true; }
    page.applyRedactions(blackBoxes, images ? M.PDFPage.REDACT_IMAGE_PIXELS : M.PDFPage.REDACT_IMAGE_NONE, lineArt ? M.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED : M.PDFPage.REDACT_LINE_ART_NONE, text ? M.PDFPage.REDACT_TEXT_REMOVE : M.PDFPage.REDACT_TEXT_NONE); }
  const out = any ? doc.saveToBuffer('garbage').asUint8Array().slice() : bytes; doc.destroy(); return out;
}
export async function compact(bytes, { objectStreams = true, password = '' } = {}) { const M = await mupdf(); const doc = open(M, bytes, password); const out = doc.saveToBuffer(`garbage=deduplicate,compress${objectStreams ? ',objstms' : ''}`).asUint8Array().slice(); doc.destroy(); return out; }
export async function pageText(bytes, pageIndex, password = '') { const M = await mupdf(); const doc = open(M, bytes, password); const t = doc.loadPage(pageIndex).toStructuredText('').asText(); doc.destroy(); return t; }
