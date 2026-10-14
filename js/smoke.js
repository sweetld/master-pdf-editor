// Self-test used by `npm run smoke`: exercises the desktop paths and prints a JSON report to the console, then quits.
import { platform } from './platform.js';
export async function runSmoke(app) {
  const out = { ok: true, steps: [] }; const step = (name, v) => out.steps.push({ name, ...v }); const fail = (name, e) => { out.ok = false; step(name, { error: String(e?.stack || e) }); };
  try {
    const ops = await import('./pdfops.js'); const mu = await import('./mupdf-bridge.js'); const M = await import('./model.js');
    step('platform', { isDesktop: platform.isDesktop, os: platform.os, info: platform.info });
    const r = await fetch('samples/sample.pdf'); const bytes = new Uint8Array(await r.arrayBuffer()); const doc = await app.openBytes(bytes, 'sample.pdf'); step('open', { pages: doc.pages.length });
    step('mupdf', { available: await mu.available() });
    // true edit: delete an original text run, edit another, then save and check the text really went
    app.setTool('editdoc'); await app.editor.ensureScanned(doc.pages[0]); const pm = doc.pages[0];
    const t0 = pm.items.find(i => i.orig === 'text' && /Version/.test(i.props.text)); const t1 = pm.items.find(i => i.orig === 'text' && /Master PDF/.test(i.props.text));
    doc.removeItems([t0]); t1.origRect = t1.rect.slice(); t1.origModified = true; doc.updateItem(t1, { props: { text: 'Smoke Title' } });
    const saved = await ops.saveBytes(doc, {}); const txt = await mu.pageText(saved, 0); step('trueEdit', { versionGone: !/Version 5\.9/.test(txt), newTitle: /Smoke Title/.test(txt), oldTitleGone: !/Master PDF Editor/.test(txt.split('\n')[0] + txt.split('\n')[1]) , text: txt.slice(0, 80) });
    if (/Version 5\.9/.test(txt) || !/Smoke Title/.test(txt)) out.ok = false;
    // encryption through MuPDF and reopening with pdf.js
    const enc = await ops.saveBytes(doc, { security: { enabled: true, method: 'aes-256', userPassword: 'u', ownerPassword: 'o', permissions: { print: true, modify: false, copy: false, annotate: true, fillForms: true, accessibility: true, assemble: false, printHigh: true } } });
    const t = new M.PdfDoc({ name: 'enc.pdf' }); let wrong = null; try { await t.load(enc, { password: 'x' }); } catch (e) { wrong = e.name; } await t.load(enc, { password: 'u' }); step('encrypt', { wrong, encrypted: t.encrypted, perms: t.permissions });
    // structural op on the encrypted doc (object streams + decryption through MuPDF)
    const encDoc = new M.PdfDoc({ name: 'enc2.pdf' }); await encDoc.load(await mu.compact(enc, { password: 'o' }), { password: 'o' }); const d2 = await mu.decrypt(encDoc.bytes, 'o'); step('decryptObjStm', { isOwner: d2.isOwner, method: d2.method, size: d2.bytes.length });
    await ops.rotatePages(encDoc, [0], 90); step('rotateEncrypted', { rotate: encDoc.pages[0].rotate });
    // signing + verification
    if (platform.sign) { const ids = await platform.sign.listIds(); let id = ids.find(c => c.name === 'Smoke Test'); if (!id) { const p = await platform.sign.createId({ name: 'Smoke Test', password: 'pw' }); id = { path: p }; } const signed = await platform.sign.sign({ bytes: saved, p12Path: id.path, password: 'pw', reason: 'smoke', rect: [300, 40, 560, 110] }); const ver = await platform.sign.verify({ bytes: signed }); step('sign', { valid: ver[0]?.valid, signer: ver[0]?.signer, reason: ver[0]?.reason }); if (!ver[0]?.valid) out.ok = false; const sd = new M.PdfDoc({ name: 's.pdf' }); await sd.load(signed); step('signedFieldsSeen', { sigs: sd.allItems().filter(i => i.type === 'signature').length }); }
    // scanner listing (no scan)
    const sc = await platform.scanner.list(); step('scannerList', sc);
    // print to pdf (silent) sanity
    if (window.native) { const pdf = await window.native.printToPdf({}); step('printToPdf', { size: pdf?.length || pdf?.byteLength }); }
    // UI actions smoke (non-dialog)
    let errors = 0; for (const id of ['view.zoomIn', 'view.zoomOut', 'view.fitPage', 'view.fitWidth', 'view.facing', 'view.continuous', 'view.grid', 'view.grid', 'tools.hand', 'tools.editText', 'tools.editForms', 'forms.highlight', 'view.nextPage', 'view.prevPage']) { try { app.run(id); } catch (e) { errors++; } } step('actions', { errors });
  } catch (e) { fail('exception', e); }
  console.log('SMOKE-RESULT ' + JSON.stringify(out));
  if (window.native) setTimeout(() => { window.native.quit().catch(e => console.log('quit failed ' + e)); }, 500);
}
