// Standard security handler: RC4 40/128-bit (R2/R3), AES-128 (R4/AESV2) and AES-256 (R6/AESV3).
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFRawStream, PDFNumber, PDFRef, PDFStream, PDFBool } = PDFLib;
const PAD = new Uint8Array([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
const te = new TextEncoder();
export const concat = (...arrs) => { const n = arrs.reduce((s, a) => s + a.length, 0); const out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
const latin1 = s => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
const randomBytes = n => crypto.getRandomValues(new Uint8Array(n));
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

// ---- MD5 ----
export function md5(input) {
  const K = new Int32Array(64), S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  const len = input.length, padLen = (((len + 8) >> 6) + 1) << 6; const msg = new Uint8Array(padLen); msg.set(input); msg[len] = 0x80;
  const dv = new DataView(msg.buffer); dv.setUint32(padLen - 8, (len * 8) >>> 0, true); dv.setUint32(padLen - 4, Math.floor(len * 8 / 4294967296), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0; A = D; D = C; C = B; B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new Uint8Array(16); const ov = new DataView(out.buffer); ov.setInt32(0, a0, true); ov.setInt32(4, b0, true); ov.setInt32(8, c0, true); ov.setInt32(12, d0, true); return out;
}
// ---- RC4 ----
export function rc4(key, data) {
  const S = new Uint8Array(256); for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]]; out[k] = data[k] ^ S[(S[i] + S[j]) & 255]; }
  return out;
}
// ---- AES via WebCrypto ----
async function aesKey(raw) { return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']); }
export async function aesCbcEncrypt(keyBytes, iv, data) { const k = await aesKey(keyBytes); return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, data)); }
export async function aesCbcDecrypt(keyBytes, iv, data) { const k = await aesKey(keyBytes); try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, data)); } catch { return new Uint8Array(0); } }
async function aesCbcEncryptNoPad(keyBytes, iv, data) { const full = await aesCbcEncrypt(keyBytes, iv, data); return full.subarray(0, data.length); }
async function aesCbcDecryptNoPad(keyBytes, iv, data) { // append a valid padding block so WebCrypto accepts it
  const last = data.subarray(data.length - 16); const padBlock = new Uint8Array(16).fill(16);
  const x = await aesCbcEncryptNoPad(keyBytes, last, padBlock);
  const k = await aesKey(keyBytes); return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, concat(data, x)));
}
const sha = async (n, data) => new Uint8Array(await crypto.subtle.digest('SHA-' + n, data));

function padPassword(pw) { const b = latin1(pw || ''); return concat(b.subarray(0, 32), PAD.subarray(0, Math.max(0, 32 - b.length))); }
function computeO(ownerPw, userPw, R, n) {
  let key = md5(padPassword(ownerPw || userPw)); if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n)); key = key.subarray(0, n);
  let O = rc4(key, padPassword(userPw)); if (R >= 3) for (let i = 1; i <= 19; i++) O = rc4(key.map(b => b ^ i), O); return O;
}
function computeKey(userPw, O, P, id0, R, n) {
  const pb = new Uint8Array(4); new DataView(pb.buffer).setInt32(0, P, true);
  let key = md5(concat(padPassword(userPw), O.subarray(0, 32), pb, id0)); if (R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n)); return key.subarray(0, n);
}
function computeU(key, id0, R) {
  if (R === 2) return rc4(key, PAD);
  let U = rc4(key, md5(concat(PAD, id0))); for (let i = 1; i <= 19; i++) U = rc4(key.map(b => b ^ i), U); return concat(U, new Uint8Array(16));
}
function objectKey(key, num, gen, aes) { const extra = new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]); const k = md5(aes ? concat(key, extra, new Uint8Array([0x73, 0x41, 0x6C, 0x54])) : concat(key, extra)); return k.subarray(0, Math.min(key.length + 5, 16)); }
// R6 hash (ISO 32000-2 algorithm 2.B)
async function hash2B(pw, salt, udata) {
  let K = await sha(256, concat(pw, salt, udata)); let i = 0;
  while (true) {
    const k1 = concat(...Array(64).fill(concat(pw, K, udata)));
    const E = await aesCbcEncryptNoPad(K.subarray(0, 16), K.subarray(16, 32), k1);
    const mod = E.subarray(0, 16).reduce((s, b) => s + b, 0) % 3;
    K = await sha(mod === 0 ? 256 : mod === 1 ? 384 : 512, E);
    i++; if (i >= 64 && E[E.length - 1] <= i - 32) break;
  }
  return K.subarray(0, 32);
}
const utf8pw = pw => te.encode(pw || '').subarray(0, 127);

// ---- walking the object graph ----
function walkStrings(obj, fn, seen = new Set()) {
  if (obj instanceof PDFDict) { if (seen.has(obj)) return; seen.add(obj); for (const [k, v] of obj.entries()) { if (v instanceof PDFString || v instanceof PDFHexString) obj.set(k, fn(v)); else walkStrings(v, fn, seen); } }
  else if (obj instanceof PDFArray) { if (seen.has(obj)) return; seen.add(obj); for (let i = 0; i < obj.size(); i++) { const v = obj.get(i); if (v instanceof PDFString || v instanceof PDFHexString) obj.set(i, fn(v)); else walkStrings(v, fn, seen); } }
  else if (obj instanceof PDFStream) walkStrings(obj.dict, fn, seen);
}
const strBytes = s => s instanceof PDFHexString ? s.asBytes() : latin1(s.asString());
function asyncQueue() { const q = []; return { push: p => q.push(p), wait: () => Promise.all(q) }; }

export const PERM = { print: 4, modify: 8, copy: 16, annotate: 32, fillForms: 256, accessibility: 512, assemble: 1024, printHigh: 2048 };
export function permsFromFlags(flags) { const f = { print: true, modify: true, copy: true, annotate: true, fillForms: true, accessibility: true, assemble: true, printHigh: true }; for (const k of Object.keys(f)) f[k] = !!(flags & PERM[k]); return f; }
export function flagsFromPerms(p) { let f = -3904 >>> 0; let v = 0xFFFFF0C0; for (const k of Object.keys(PERM)) if (p[k]) v |= PERM[k]; return v | 0; }

/** Encrypts the saved bytes of a document. method: 'rc4-40' | 'rc4-128' | 'aes-128' | 'aes-256'. */
export async function encryptPdf(bytes, { userPassword = '', ownerPassword = '', method = 'aes-128', permissions = null }) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
  const ctx = doc.context; const P = permissions ? flagsFromPerms(permissions) : -1;
  const id0 = randomBytes(16); let encDict; let encStr, encStream;
  if (method === 'aes-256') {
    const fileKey = randomBytes(32); const upw = utf8pw(userPassword), opw = utf8pw(ownerPassword || userPassword);
    const uvs = randomBytes(8), uks = randomBytes(8); const U = concat(await hash2B(upw, uvs, new Uint8Array(0)), uvs, uks);
    const UE = await aesCbcEncryptNoPad(await hash2B(upw, uks, new Uint8Array(0)), new Uint8Array(16), fileKey);
    const ovs = randomBytes(8), oks = randomBytes(8); const O = concat(await hash2B(opw, ovs, U), ovs, oks);
    const OE = await aesCbcEncryptNoPad(await hash2B(opw, oks, U), new Uint8Array(16), fileKey);
    const pb = new Uint8Array(16); new DataView(pb.buffer).setInt32(0, P, true); pb.set([0xff, 0xff, 0xff, 0xff], 4); pb.set([0x54, 0x61, 0x64, 0x62], 8); pb.set(randomBytes(4), 12);
    const Perms = await aesCbcEncryptNoPad(fileKey, new Uint8Array(16), pb);
    encStr = async (b) => { const iv = randomBytes(16); return concat(iv, await aesCbcEncrypt(fileKey, iv, b)); }; encStream = encStr;
    encDict = ctx.obj({ Filter: 'Standard', V: 5, R: 6, Length: 256, P, O: PDFHexString.of(hex(O)), U: PDFHexString.of(hex(U)), OE: PDFHexString.of(hex(OE)), UE: PDFHexString.of(hex(UE)), Perms: PDFHexString.of(hex(Perms)), CF: { StdCF: { CFM: 'AESV3', AuthEvent: 'DocOpen', Length: 32 } }, StmF: 'StdCF', StrF: 'StdCF' });
  } else {
    const aes = method === 'aes-128'; const R = method === 'rc4-40' ? 2 : aes ? 4 : 3; const n = R === 2 ? 5 : 16;
    const O = computeO(ownerPassword, userPassword, R, n); const key = computeKey(userPassword, O, P, id0, R, n); const U = computeU(key, id0, R);
    const mk = (num, gen) => objectKey(key, num, gen, aes);
    encStr = async (b, num, gen) => { if (!aes) return rc4(mk(num, gen), b); const iv = randomBytes(16); return concat(iv, await aesCbcEncrypt(mk(num, gen), iv, b)); }; encStream = encStr;
    const d = { Filter: 'Standard', V: aes ? 4 : R === 2 ? 1 : 2, R, Length: n * 8, P, O: PDFHexString.of(hex(O)), U: PDFHexString.of(hex(U)) };
    if (aes) Object.assign(d, { CF: { StdCF: { CFM: 'AESV2', AuthEvent: 'DocOpen', Length: 16 } }, StmF: 'StdCF', StrF: 'StdCF' });
    encDict = ctx.obj(d);
  }
  const jobs = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const num = ref.objectNumber, gen = ref.generationNumber;
    const strFn = (s) => { const placeholder = PDFHexString.of(''); jobs.push(encStr(strBytes(s), num, gen).then(b => { placeholder.value = hex(b); })); return placeholder; };
    if (obj instanceof PDFRawStream) { const type = obj.dict.get(PDFName.of('Type')); if (type !== PDFName.of('XRef')) jobs.push(encStream(obj.contents, num, gen).then(b => { obj.contents = b; obj.dict.set(PDFName.of('Length'), PDFNumber.of(b.length)); })); walkStrings(obj.dict, strFn); }
    else if (obj instanceof PDFStream) { walkStrings(obj.dict, strFn); }
    else walkStrings(obj, strFn);
  }
  await Promise.all(jobs);
  ctx.trailerInfo.Encrypt = ctx.register(encDict);
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(hex(id0)), PDFHexString.of(hex(id0))]);
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
}

/** Loads an encrypted PDF with pdf-lib and decrypts it in place. Returns { doc, isOwner }. Throws 'password' if the password is wrong. */
export async function decryptPdf(bytes, password = '') {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const ctx = doc.context; const encRef = ctx.trailerInfo.Encrypt; if (!encRef) return { doc, isOwner: true };
  const enc = ctx.lookup(encRef, PDFDict); const num = k => { const v = ctx.lookup(enc.get(PDFName.of(k))); return v instanceof PDFNumber ? v.asNumber() : undefined; };
  const str = k => { const v = ctx.lookup(enc.get(PDFName.of(k))); return v ? strBytes(v) : new Uint8Array(0); };
  const V = num('V') || 0, R = num('R') || 2, P = num('P') | 0, Length = num('Length') || 40; const O = str('O'), U = str('U');
  let idArr = ctx.lookup(ctx.trailerInfo.ID); let id0 = idArr instanceof PDFArray && idArr.size() ? strBytes(ctx.lookup(idArr.get(0))) : new Uint8Array(0);
  let cfm = 'V2'; if (V >= 4) { const cf = ctx.lookup(enc.get(PDFName.of('CF'))); const stmf = enc.get(PDFName.of('StmF')); const std = cf instanceof PDFDict && stmf ? ctx.lookup(cf.get(stmf)) : null; const m = std instanceof PDFDict ? ctx.lookup(std.get(PDFName.of('CFM'))) : null; cfm = m ? m.decodeText?.() || m.asString?.() || String(m).replace('/', '') : 'Identity'; cfm = cfm.replace('/', ''); }
  let decStr, isOwner = false;
  if (R >= 5) {
    const pw = utf8pw(password); const vs = U.subarray(32, 40), ks = U.subarray(40, 48); let fileKey = null;
    const h = async (p, s, u) => R === 5 ? await sha(256, concat(p, s, u)) : await hash2B(p, s, u);
    const uh = await h(pw, vs, new Uint8Array(0));
    if (hex(uh) === hex(U.subarray(0, 32))) { const ik = await h(pw, ks, new Uint8Array(0)); fileKey = await aesCbcDecryptNoPad(ik, new Uint8Array(16), str('UE')); }
    else { const ovs = O.subarray(32, 40), oks = O.subarray(40, 48); const oh = await h(pw, ovs, U.subarray(0, 48)); if (hex(oh) === hex(O.subarray(0, 32))) { isOwner = true; const ik = await h(pw, oks, U.subarray(0, 48)); fileKey = await aesCbcDecryptNoPad(ik, new Uint8Array(16), str('OE')); } }
    if (!fileKey) throw Object.assign(new Error('password'), { name: 'PasswordException' });
    decStr = async (b) => b.length < 16 ? new Uint8Array(0) : aesCbcDecrypt(fileKey, b.subarray(0, 16), b.subarray(16));
  } else {
    const n = R === 2 ? 5 : Math.max(5, Math.min(16, Length / 8)); const aes = cfm === 'AESV2';
    const tryUser = (upw) => { const key = computeKey(upw, O, P, id0, R, n); const u = computeU(key, id0, R); return hex(u.subarray(0, 16)) === hex(U.subarray(0, 16)) ? key : null; };
    let key = tryUser(password);
    if (!key) { // owner password (algorithm 3.7)
      let ok = md5(padPassword(password)); if (R >= 3) for (let i = 0; i < 50; i++) ok = md5(ok.subarray(0, n)); ok = ok.subarray(0, n);
      let upw = O.subarray(0, 32); if (R === 2) upw = rc4(ok, upw); else for (let i = 19; i >= 0; i--) upw = rc4(ok.map(b => b ^ i), upw);
      let s = ''; for (const b of upw) s += String.fromCharCode(b); s = s.replace(/\(\xBF\x4E[\s\S]*$/, ''); // trim PAD
      for (let L = 32; L >= 0; L--) { key = tryUser(s.slice(0, L)); if (key) { isOwner = true; break; } }
    }
    if (!key) throw Object.assign(new Error('password'), { name: 'PasswordException' });
    decStr = async (b, onum, gen) => { const k = objectKey(key, onum, gen, aes); if (!aes) return rc4(k, b); return b.length < 16 ? new Uint8Array(0) : aesCbcDecrypt(k, b.subarray(0, 16), b.subarray(16)); };
    if (cfm === 'Identity' && V >= 4) decStr = async b => b;
  }
  const jobs = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (ref === encRef || (encRef && ref.objectNumber === encRef.objectNumber)) continue;
    const onum = ref.objectNumber, gen = ref.generationNumber;
    const strFn = (s) => { const ph = PDFHexString.of(''); jobs.push(decStr(strBytes(s), onum, gen).then(b => { ph.value = hex(b); })); return ph; };
    if (obj instanceof PDFRawStream) { const type = obj.dict.get(PDFName.of('Type')); if (type !== PDFName.of('XRef')) jobs.push(decStr(obj.contents, onum, gen).then(b => { obj.contents = b; obj.dict.set(PDFName.of('Length'), PDFNumber.of(b.length)); })); walkStrings(obj.dict, strFn); }
    else if (obj instanceof PDFStream) walkStrings(obj.dict, strFn);
    else walkStrings(obj, strFn);
  }
  await Promise.all(jobs);
  delete ctx.trailerInfo.Encrypt; ctx.delete(encRef);
  return { doc, isOwner, permissions: permsFromFlags(P), method: R >= 5 ? 'aes-256' : cfm === 'AESV2' ? 'aes-128' : R === 2 ? 'rc4-40' : 'rc4-128' };
}
