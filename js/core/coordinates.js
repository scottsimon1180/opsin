"use strict";

/* ═══════════════════════════════════════════════════════
   COORDINATE & GEOMETRY HELPERS
   Extracted from script.js and rendering.js.
   All functions are globals (classic script — no modules).
   Depends on: dom.js (workspace), config.js (RULER_* constants).
   Runtime globals used: zoom, panX, panY, guides, guidesVisible,
                         rulerState, SnapEngine.
   ═══════════════════════════════════════════════════════ */

// ── Workspace rect cache ──────────────────────────────────────────────────────

// Cached workspace bounding rect — invalidated on resize, lazy on first access
let _wsRectCache = null;
function _getWsRect() {
  if (!_wsRectCache) _wsRectCache = workspace.getBoundingClientRect();
  return _wsRectCache;
}

// ── Scratch hit-test context ──────────────────────────────────────────────────

// Scratch 2D context for point-in-path hit tests (reused, never drawn to).
let _hitTestCtx = null;
function getHitTestCtx() {
  if (!_hitTestCtx) {
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    _hitTestCtx = c.getContext('2d');
  }
  return _hitTestCtx;
}

// ── Screen ↔ canvas conversions ───────────────────────────────────────────────

function screenToCanvas(clientX, clientY) {
  const wsRect = _getWsRect();
  const sx = clientX - wsRect.left;
  const sy = clientY - wsRect.top;
  return {
    x: (sx - panX) / zoom,
    y: (sy - panY) / zoom
  };
}

// Canvas-space (cx, cy) → workspace screen-space {x, y}
function c2s(cx, cy) {
  return { x: cx * zoom + panX, y: cy * zoom + panY };
}

// Canvas-space (cx, cy) → workspace screen-space {sx, sy}
function _rulerCanvasToScreen(cx, cy) {
  return { sx: cx * zoom + panX, sy: cy * zoom + panY };
}

// ── Guide hit testing ─────────────────────────────────────────────────────────

function hitTestGuide(clientX, clientY) {
  if (!guidesVisible || guides.length === 0) return null;
  const wsRect = workspace.getBoundingClientRect();
  const mx = clientX - wsRect.left;
  const my = clientY - wsRect.top;
  const threshold = 6;
  let bestGuide = null, bestDist = threshold;
  for (let i = guides.length - 1; i >= 0; i--) {
    const g = guides[i];
    const dist = g.axis === 'v'
      ? Math.abs(mx - (g.pos * zoom + panX))
      : Math.abs(my - (g.pos * zoom + panY));
    if (dist < bestDist) { bestDist = dist; bestGuide = g; }
  }
  return bestGuide;
}

// ── Ruler tool hit testing & geometry ────────────────────────────────────────

// Screen-space hit test. Returns {type:'handle', which:1|2} | {type:'line'} | null
function rulerHitTest(clientX, clientY) {
  if (!rulerState.active) return null;
  const wsRect = workspace.getBoundingClientRect();
  const mx = clientX - wsRect.left;
  const my = clientY - wsRect.top;

  const p1 = _rulerCanvasToScreen(rulerState.x1, rulerState.y1);
  const p2 = _rulerCanvasToScreen(rulerState.x2, rulerState.y2);

  // Handles win over line (handles first)
  const d1 = Math.max(Math.abs(mx - p1.sx), Math.abs(my - p1.sy));
  if (d1 <= RULER_HANDLE_HIT) return { type: 'handle', which: 1 };
  const d2 = Math.max(Math.abs(mx - p2.sx), Math.abs(my - p2.sy));
  if (d2 <= RULER_HANDLE_HIT) return { type: 'handle', which: 2 };

  // Perpendicular distance from segment
  const dx = p2.sx - p1.sx;
  const dy = p2.sy - p1.sy;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.0001) return null;
  let t = ((mx - p1.sx) * dx + (my - p1.sy) * dy) / lenSq;
  if (t < 0 || t > 1) return null;
  const px = p1.sx + t * dx;
  const py = p1.sy + t * dy;
  const pd = Math.hypot(mx - px, my - py);
  if (pd <= RULER_LINE_HIT) return { type: 'line' };
  return null;
}

function getRulerCursor(hit, isDragging) {
  if (!hit) return 'crosshair';
  if (hit.type === 'handle') return isDragging ? 'grabbing' : 'grab';
  if (hit.type === 'line') return 'all-scroll';
  return 'crosshair';
}

// Photoshop-style 45° constraint: project raw point onto nearest 45° ray from anchor
function applyRulerShiftConstraint(anchorX, anchorY, rawX, rawY) {
  const dx = rawX - anchorX;
  const dy = rawY - anchorY;
  const len = Math.hypot(dx, dy);
  if (len < 0.0001) return { x: anchorX, y: anchorY };
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: anchorX + len * Math.cos(ang), y: anchorY + len * Math.sin(ang) };
}

// Endpoint pipeline: SnapEngine → shift constraint → integer pixel lock
function snapRulerPoint(pt, e, anchor) {
  const snapped = SnapEngine.snapPoint({ x: pt.x, y: pt.y }, { modifiers: e });
  let x = snapped.x, y = snapped.y;
  if (e && e.shiftKey && anchor) {
    const c = applyRulerShiftConstraint(anchor.x, anchor.y, x, y);
    x = c.x; y = c.y;
  }
  return { x: Math.round(x), y: Math.round(y) };
}
