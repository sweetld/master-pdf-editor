export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
let _uid = 0;
export const uid = (p = 'i') => `${p}${Date.now().toString(36)}${(_uid++).toString(36)}`;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const isMac = /Mac/.test(navigator.platform);

export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
export const svgNS = 'http://www.w3.org/2000/svg';
export function svgEl(tag, attrs = {}, ...children) {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}
export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const clone = o => JSON.parse(JSON.stringify(o));
export const fmtDate = d => { d = d instanceof Date ? d : new Date(d); return isNaN(d) ? '' : d.toLocaleString(); };
export const nowIso = () => new Date().toISOString();
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Colours: internal representation is '#rrggbb' or null (none).
export function hexToRgb(hex) { if (!hex) return null; const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
export function rgbToHex(rgb) { if (!rgb) return null; const [r, g, b] = rgb.length === 3 ? rgb : [rgb[0], rgb[0], rgb[0]]; return '#' + [r, g, b].map(v => Math.round(clamp(v <= 1 ? v * 255 : v, 0, 255)).toString(16).padStart(2, '0')).join(''); }
export function pdfjsColorToHex(c) { if (!c) return null; if (c.length === 3) return rgbToHex([c[0] / 255, c[1] / 255, c[2] / 255]); if (c.length === 1) return rgbToHex([c[0] / 255, c[0] / 255, c[0] / 255]); if (c.length === 4) { const [C, M, Y, K] = c.map(v => v / 255); return rgbToHex([(1 - C) * (1 - K), (1 - M) * (1 - K), (1 - Y) * (1 - K)]); } return null; }
export const NAMED_COLORS = { Black: '#000000', White: '#ffffff', Red: '#d8322e', Green: '#2d9a3f', Blue: '#3d8ee6', Yellow: '#ffe100', Orange: '#ff8c00', Magenta: '#d733d7', Cyan: '#2bb5c9', Gray: '#808080', 'Dark Gray': '#404040', 'Light Gray': '#c0c0c0', Brown: '#8b5a2b', Purple: '#6a3fb5' };
export function colorName(hex) { if (!hex) return 'None'; const e = Object.entries(NAMED_COLORS).find(([, v]) => v === hex.toLowerCase()); return e ? e[0] : hex; }

// Units: everything is stored in PDF points.
export const UNITS = { pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54, px: 72 / 96 };
export const fromPt = (v, u = 'pt') => v / UNITS[u];
export const toPt = (v, u = 'pt') => v * UNITS[u];
export const fmtNum = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toString();
export function evalExpr(s) { // Object Inspector accepts + - * / ( ) expressions
  if (typeof s === 'number') return s;
  const t = String(s).replace(/,/g, '.').trim();
  if (!/^[\d.+\-*/()\s]+$/.test(t)) return NaN;
  try { return Function(`"use strict";return (${t})`)(); } catch { return NaN; }
}
export const PAGE_SIZES = { 'A4': [595.276, 841.89], 'A3': [841.89, 1190.55], 'A5': [419.528, 595.276], 'Letter': [612, 792], 'Legal': [612, 1008], 'Tabloid': [792, 1224], 'B5': [498.898, 708.661], 'Executive': [522, 756] };

export function download(data, name, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export const readFileBytes = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(new Uint8Array(r.result)); r.onerror = rej; r.readAsArrayBuffer(f); });
export const readFileDataUrl = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
export function pickFiles(input, { accept, multiple = false } = {}) {
  return new Promise(res => {
    if (accept) input.accept = accept; input.multiple = multiple; input.value = '';
    input.onchange = () => res([...input.files]); input.click();
  });
}
export const loadImage = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
export function bytesToBase64(b) { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
export function base64ToBytes(s) { const bin = atob(s); const b = new Uint8Array(bin.length); for (let i = 0; i < b.length; i++) b[i] = bin.charCodeAt(i); return b; }
export const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
export function rectNorm(r) { return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]; }
export function rectsIntersect(a, b) { return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]; }
export function bboxOfPoints(pts) { let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity; for (const [x, y] of pts) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); } return [x1, y1, x2, y2]; }
export function applyMatrix(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }
export function mulMatrix(a, b) { // a then b  (pdf.js Util.transform(b, a))
  return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
}
export function parsePageRange(s, max) { // "1-3,5,8-" → zero-based indices
  const out = new Set();
  for (let part of String(s).split(',')) { part = part.trim(); if (!part) continue; const m = part.match(/^(\d*)\s*-\s*(\d*)$/); if (m) { const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : max; for (let i = a; i <= Math.min(b, max); i++) if (i >= 1) out.add(i - 1); } else if (/^\d+$/.test(part) && +part >= 1 && +part <= max) out.add(+part - 1); }
  return [...out].sort((a, b) => a - b);
}

// ---------- Settings (Tools > Settings) ----------
export const DEFAULT_SETTINGS = {
  general: { author: 'User', openLastSession: false, recentCount: 10, showWelcome: true, confirmClose: true, restoreZoom: true, undoSteps: 0 },
  system: { autosaveMinutes: 5, backupOnSave: false, singleInstance: true, associateFiles: false },
  forms: { highlightFields: true, highlightColor: '#ccd7ff', autoCalculate: true, showFieldNames: false },
  editing: { snapTolerance: 5, nudgeStep: 5, nudgeStepFine: 1, defaultFont: 'Helvetica', defaultFontSize: 12, textCover: '#ffffff', smartGuides: true },
  grid: { spacing: 36, subdivisions: 1, color: '#9ac7f2', offsetX: 0, offsetY: 0 },
  javascript: { enable: true, showConsoleOnError: false },
  comments: { author: '', showPopups: true, lineWidth: 1, opacity: 100, color: '#ffe100', fontSize: 12, showHidden: false },
  display: { background: '#9b9b9b', pageBorder: true, smoothText: true, smoothImages: true, replaceColors: false, textColor: '#000000', pageColor: '#ffffff', defaultZoom: 'fitwidth', defaultLayout: 'continuous', units: 'pt', renderDpi: 'auto' },
  toolbars: { iconSize: 18, showText: false },
  appearance: { theme: 'light', font: 'default', navWidth: 260, inspWidth: 290 },
  keyboard: {},
  email: { client: 'default', address: '' },
  ocr: { language: 'eng', engine: 'none' },
  redaction: { fillColor: '#000000', overlayText: '', textColor: '#ff0000', autoRepeat: false },
  network: { proxy: 'system', host: '', port: 0 },
  certificates: { store: 'system' },
  language: { ui: 'en' },
  update: { auto: true, channel: 'stable' },
};
export const settings = (() => {
  let s = clone(DEFAULT_SETTINGS);
  try { const saved = JSON.parse(localStorage.getItem('mpe.settings') || 'null'); if (saved) for (const k of Object.keys(s)) Object.assign(s[k], saved[k] || {}); } catch { }
  return s;
})();
export function saveSettings() { try { localStorage.setItem('mpe.settings', JSON.stringify(settings)); } catch { } }
export function resetSettings() { for (const k of Object.keys(settings)) settings[k] = clone(DEFAULT_SETTINGS[k]); saveSettings(); }
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem('mpe.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mpe.' + k, JSON.stringify(v)); } catch { } },
};
