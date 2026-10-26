// Smart guides: while a selection is dragged, its left/centre/right and bottom/middle/top lines snap
// to the same lines of the other content on the page under the cursor and to the page's edges and
// centre, and the lines it snapped to are shown as guides. Coordinates are PDF user space (y up).
import { rectNorm, settings } from './util.js';

const isBackground = (pm, it) => it.orig === 'vector' && Math.abs((it.rect[2] - it.rect[0]) * (it.rect[3] - it.rect[1])) > 0.8 * pm.width * pm.height;

export function guidesEnabled() { return settings.editing.smartGuides !== false; }

/** Lines that a dragged selection can snap to on page ``pm`` (``exclude``: the items being dragged). */
export function snapTargets(pm, exclude, bboxOf) {
  const xs = [], ys = []; const v = pm.pdfPage.view; const page = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
  const add = (b, kind) => { xs.push({ v: b[0], kind }, { v: (b[0] + b[2]) / 2, kind: kind + '-centre' }, { v: b[2], kind }); ys.push({ v: b[1], kind }, { v: (b[1] + b[3]) / 2, kind: kind + '-centre' }, { v: b[3], kind }); };
  add(page, 'page');
  for (const it of pm.visibleItems()) {
    if (exclude.has(it) || (it.kind !== 'object' && it.kind !== 'field') || isBackground(pm, it) || it.props.hidden) continue;
    const b = rectNorm(bboxOf(it)); if (!(b[2] - b[0] > 0.2 || b[3] - b[1] > 0.2)) continue; add(b, 'object');
  }
  return { xs, ys, page };
}

/**
 * Snaps ``box`` (the dragged selection's bounds, already offset) to ``targets``.
 * Returns the extra offset [ax, ay] and the guide positions to draw.
 * ``axes`` limits snapping (e.g. when Shift restricts the drag to one direction).
 */
export function snapBox(box, targets, tol, axes = { x: true, y: true }) {
  const b = rectNorm(box);
  const best = (vals, lines) => { let hit = null; for (const m of vals) for (const t of lines) { const d = t.v - m; if (Math.abs(d) <= tol && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, t }; } return hit; };
  const mx = [b[0], (b[0] + b[2]) / 2, b[2]], my = [b[1], (b[1] + b[3]) / 2, b[3]];
  const hx = axes.x ? best(mx, targets.xs) : null, hy = axes.y ? best(my, targets.ys) : null;
  const ax = hx ? hx.d : 0, ay = hy ? hy.d : 0;
  // every line of the moved box that now coincides with a target gets a guide
  const near = (vals, lines) => [...new Set(vals.flatMap(m => lines.filter(t => Math.abs(t.v - m) < 0.05).map(t => +t.v.toFixed(2))))];
  return { ax, ay, gx: hx ? near(mx.map(m => m + ax), targets.xs) : [], gy: hy ? near(my.map(m => m + ay), targets.ys) : [] };
}

/** Snap tolerance in user units for the current zoom. */
export function tolerance(zoom) { return Math.max(1, settings.editing.snapTolerance || 5) / Math.max(0.05, zoom); }
