// Digital IDs and PKCS#7 signatures with node-forge; the PDF structure is edited with pdf-lib.
const forge = require('node-forge'); const fs = require('fs'); const fsp = require('fs/promises'); const path = require('path');
const { PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, PDFArray, StandardFonts, rgb } = require('pdf-lib');
const SIG_LEN = 8192;
function loadP12(p12Path, password) {
  const der = fs.readFileSync(p12Path, 'binary'); const asn1 = forge.asn1.fromDer(der); const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password || '');
  const certs = []; let key = null;
  for (const sc of p12.safeContents) for (const sb of sc.safeBags) { if (sb.cert) certs.push(sb.cert); if (sb.key) key = sb.key; }
  if (!key) for (const sc of p12.safeContents) for (const sb of sc.safeBags) if (sb.type === forge.pki.oids.pkcs8ShroudedKeyBag && sb.key) key = sb.key;
  if (!key || !certs.length) throw new Error('The certificate file has no private key or certificate.');
  const cert = certs.find(c => { try { return c.publicKey.n.equals(key.n); } catch { return false; } }) || certs[0];
  return { key, cert, chain: certs };
}
const cn = (c) => c.subject.getField('CN')?.value || c.subject.attributes.map(a => a.value).join(', ');
async function listIds(dir) { const out = []; for (const f of await fsp.readdir(dir)) { if (!/\.(p12|pfx)$/i.test(f)) continue; const p = path.join(dir, f); out.push({ name: f.replace(/\.(p12|pfx)$/i, ''), path: p, file: f }); } return out; }
function inspectId({ path: p, password }) { const { cert } = loadP12(p, password); return { subject: cn(cert), issuer: cn(cert) === (cert.issuer.getField('CN')?.value) ? 'self-signed' : (cert.issuer.getField('CN')?.value || ''), validFrom: cert.validity.notBefore.toISOString(), validTo: cert.validity.notAfter.toISOString(), serial: cert.serialNumber, email: cert.subject.getField('E')?.value || '' }; }
async function createId(dir, { name, email = '', org = '', country = '', password = '', years = 5 }) {
  const keys = forge.pki.rsa.generateKeyPair(2048); const cert = forge.pki.createCertificate(); cert.publicKey = keys.publicKey; cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + years * 365.25 * 86400000);
  const attrs = [{ name: 'commonName', value: name }]; if (email) attrs.push({ name: 'emailAddress', value: email }); if (org) attrs.push({ name: 'organizationName', value: org }); if (country) attrs.push({ name: 'countryName', value: country });
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true, nonRepudiation: true }, { name: 'extKeyUsage', emailProtection: true, codeSigning: false }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des', generateLocalKeyId: true, friendlyName: name }); const der = forge.asn1.toDer(p12).getBytes();
  const file = path.join(dir, name.replace(/[^\w.-]+/g, '_') + '.p12'); await fsp.writeFile(file, Buffer.from(der, 'binary')); return file;
}
function pdfDate(d = new Date()) { const p = n => String(n).padStart(2, '0'); return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; }
async function signPdf({ bytes, p12Path, password, fieldName, pageIndex = 0, rect = null, reason = '', location = '', contact = '', visible = true, lockAfter = false, caption = null }) {
  const { key, cert, chain } = loadP12(p12Path, password); const signerName = cn(cert);
  const pdfDoc = await PDFDocument.load(Buffer.from(bytes), { ignoreEncryption: false, updateMetadata: false }); const ctx = pdfDoc.context; const pages = pdfDoc.getPages(); const page = pages[Math.min(pageIndex, pages.length - 1)];
  const sigDict = ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: PDFArray.withContext(ctx), Contents: PDFHexString.of('0'.repeat(SIG_LEN * 2)), Reason: PDFHexString.fromText(reason || ''), Location: PDFHexString.fromText(location || ''), ContactInfo: PDFHexString.fromText(contact || ''), M: PDFString.of(pdfDate()), Name: PDFHexString.fromText(signerName) });
  const br = sigDict.get(PDFName.of('ByteRange')); br.push(PDFNumber.of(0)); br.push(PDFName.of('**********')); br.push(PDFName.of('**********')); br.push(PDFName.of('**********'));
  const sigRef = ctx.register(sigDict);
  // find an existing signature field or create a widget
  let widget = null; const annots = page.node.lookup(PDFName.of('Annots'));
  if (fieldName && annots) for (let i = 0; i < annots.size(); i++) { const d = ctx.lookup(annots.get(i)); const ft = d?.get?.(PDFName.of('FT')); const t = d?.get?.(PDFName.of('T')); if (ft?.encodedName === '/Sig' && t && (t.decodeText?.() || t.asString?.()) === fieldName) { widget = d; break; } }
  const r = rect || (widget ? widget.get(PDFName.of('Rect')).asArray().map(n => n.asNumber()) : [36, 36, 216, 96]);
  if (!widget) { widget = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFHexString.fromText(fieldName || 'Signature' + Date.now().toString(36)), Rect: r, F: visible ? 4 : 6, P: page.ref }); const wref = ctx.register(widget); let arr = page.node.lookup(PDFName.of('Annots')); if (!arr) { arr = ctx.obj([]); page.node.set(PDFName.of('Annots'), arr); } arr.push(wref); const form = pdfDoc.getForm(); form.acroForm.addField(wref); }
  widget.set(PDFName.of('V'), sigRef); if (!visible) widget.set(PDFName.of('F'), PDFNumber.of(6));
  try { pdfDoc.getForm().acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(lockAfter ? 3 : 1)); } catch { }
  if (visible) { // appearance stream with the signature text
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica); const [x1, y1, x2, y2] = r; const w = x2 - x1, h = y2 - y1; const lines = (caption || `Digitally signed by ${signerName}\nDate: ${new Date().toLocaleString()}${reason ? '\nReason: ' + reason : ''}${location ? '\nLocation: ' + location : ''}`).split('\n');
    const fs = Math.max(6, Math.min(10, h / (lines.length + 1))); const safe = s => s.replace(/[^\x20-\x7e]/g, '?');
    const ops = ['q', '0.2 0.2 0.6 RG 1 w', `${0.5} ${0.5} ${w - 1} ${h - 1} re S`, 'BT', '0 0 0 rg', `/F1 ${fs} Tf`, ...lines.map((ln, i) => `1 0 0 1 4 ${h - 4 - fs * (i + 1)} Tm (${safe(ln).replace(/[\\()]/g, c => '\\' + c)}) Tj`), 'ET', 'Q'].join('\n');
    const xo = ctx.stream(ops, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h], Resources: { Font: { F1: font.ref } } }); widget.set(PDFName.of('AP'), ctx.obj({ N: ctx.register(xo) }));
  }
  if (lockAfter) { const fields = pdfDoc.getForm().getFields(); for (const f of fields) { try { f.enableReadOnly(); } catch { } } }
  let out = Buffer.from(await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false }));
  // fill ByteRange and sign
  const brPos = out.indexOf('/ByteRange [ 0 /********** /********** /********** ]'); const brPos2 = brPos >= 0 ? brPos : out.indexOf('/ByteRange [0 /********** /********** /**********]'); if (brPos2 < 0) throw new Error('ByteRange placeholder not found');
  const contentsTag = '/Contents <' + '0'.repeat(SIG_LEN * 2) + '>'; const cPos = out.indexOf(contentsTag, brPos2); if (cPos < 0) throw new Error('Contents placeholder not found');
  const start = cPos + '/Contents <'.length, end = start + SIG_LEN * 2; const ranges = [0, start - 1, end + 1, out.length - end - 1];
  const brText = `/ByteRange [${ranges.join(' ')}]`; const placeholderLen = (brPos >= 0 ? '/ByteRange [ 0 /********** /********** /********** ]' : '/ByteRange [0 /********** /********** /**********]').length; out.write(brText.padEnd(placeholderLen, ' '), brPos2, 'latin1');
  const signed = Buffer.concat([out.subarray(ranges[0], ranges[0] + ranges[1]), out.subarray(ranges[2], ranges[2] + ranges[3])]);
  const p7 = forge.pkcs7.createSignedData(); p7.content = forge.util.createBuffer(signed.toString('binary')); for (const c of chain) p7.addCertificate(c);
  p7.addSigner({ key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256, authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: new Date() }] });
  p7.sign({ detached: true }); const der = forge.asn1.toDer(p7.toAsn1()).getBytes(); const hex = Buffer.from(der, 'binary').toString('hex'); if (hex.length > SIG_LEN * 2) throw new Error('Signature too large'); out.write(hex.padEnd(SIG_LEN * 2, '0'), start, 'latin1');
  return out;
}
function verifyPdf({ bytes }) {
  const buf = Buffer.from(bytes); const text = buf.toString('latin1'); const out = []; const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g; let m;
  while ((m = re.exec(text))) {
    const ranges = m.slice(1, 5).map(Number); const cm = /\/Contents\s*<([0-9a-fA-F]+)>/.exec(text.slice(m.index, m.index + 60000)) || /\/Contents\s*<([0-9a-fA-F]+)>/.exec(text.slice(Math.max(0, m.index - 60000), m.index)); if (!cm) continue;
    const info = { byteRange: ranges, signer: '', time: null, valid: false, coversWholeFile: ranges[2] + ranges[3] === buf.length, reason: '', location: '', error: null };
    try { const sig = Buffer.from(cm[1].replace(/0+$/, '').length % 2 ? cm[1].replace(/0+$/, '') + '0' : cm[1].replace(/0+$/, ''), 'hex'); const asn1 = forge.asn1.fromDer(forge.util.createBuffer(sig.toString('binary'))); const p7 = forge.pkcs7.messageFromAsn1(asn1); const cert = p7.certificates[0]; info.signer = cert ? cn(cert) : '?'; info.issuer = cert?.issuer.getField('CN')?.value || ''; info.selfSigned = cert && cn(cert) === info.issuer;
      const rc = p7.rawCapture; const attrs = rc.authenticatedAttributes; const algo = { '1.3.14.3.2.26': 'sha1', '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512' }[forge.asn1.derToOid(rc.digestAlgorithm)] || 'sha256';
      const data = Buffer.concat([buf.subarray(ranges[0], ranges[0] + ranges[1]), buf.subarray(ranges[2], ranges[2] + ranges[3])]); const md = forge.md[algo].create(); md.update(data.toString('binary')); const digest = md.digest().bytes();
      let mdAttr = null; for (const a of attrs || []) { const oid = forge.asn1.derToOid(a.value[0].value); if (oid === forge.pki.oids.messageDigest) mdAttr = a.value[1].value[0].value; if (oid === forge.pki.oids.signingTime) { const v = a.value[1].value[0]; info.time = forge.asn1.utcTimeToDate ? (v.type === forge.asn1.Type.UTCTIME ? forge.asn1.utcTimeToDate(v.value) : forge.asn1.generalizedTimeToDate(v.value)).toISOString() : null; } }
      const digestOk = mdAttr ? mdAttr === digest : false; const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs); const md2 = forge.md[algo].create(); md2.update(forge.asn1.toDer(set).getBytes()); const sigOk = cert ? cert.publicKey.verify(md2.digest().bytes(), rc.signature) : false; info.valid = digestOk && sigOk; info.digestOk = digestOk; info.signatureOk = sigOk; info.algorithm = algo; info.validTo = cert?.validity.notAfter.toISOString(); } catch (e) { info.error = e.message; }
    const near = text.slice(Math.max(0, m.index - 40000), m.index + 40000); const dec = (lit, hex) => { if (lit != null) return lit; const b = Buffer.from(hex || '', 'hex'); if (b[0] === 0xfe && b[1] === 0xff) { let o = ''; for (let i = 2; i + 1 < b.length; i += 2) o += String.fromCharCode((b[i] << 8) | b[i + 1]); return o; } return b.toString('latin1'); }; for (const [key, prop] of [['Reason', 'reason'], ['Location', 'location'], ['ContactInfo', 'contact']]) { const mm = new RegExp('/' + key + '\\s*(?:\\(([^)]*)\\)|<([0-9a-fA-F]*)>)').exec(near); if (mm) info[prop] = dec(mm[1], mm[2]); }
    out.push(info);
  }
  return out;
}
module.exports = { listIds, createId, inspectId, signPdf, verifyPdf };
