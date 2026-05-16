"use strict";

/* ═══════════════════════════════════════════════════════
   DRAWING TOOLS — Vector/SVG editing for Opsin.
   Home for all shape and pen tool logic.

   Shape Tool: Illustrator-inspired editable vector shapes
   stored as smart-object layers (kind: 'shape'). A shape
   layer holds an ordered list of editable primitives
   (rect / ellipse / line / path). Each primitive carries its
   own fill, stroke, transform, and (for rect) corner radius.
   The layer canvas is rasterized on every change; the
   shapeModel is the source of truth.

   Pen Tool: (forthcoming) freeform bezier path drawing
   that creates and edits 'path' primitives on shape layers.

   Public surface (window.ShapeTool):
     ShapeTool.beginEdit(layer)        — open editing on an
                                          existing shape layer.
     ShapeTool.endEdit(commit)         — commit/cancel session.
     ShapeTool.isActive()              — true while editing.
     ShapeTool.requireRasterize(layer) — modal, → Promise<bool>.
     ShapeTool.renderShapeLayer(layer) — paint shapes onto layer.
     ShapeTool.setActiveShapeType(t)   — toolbar adapter.
     ShapeTool.onZoomChange()          — re-sync overlay DOM.
     ShapeTool.hitTestAndSelect(x,y)   — used by Move tool.
     ShapeTool.updateHover(x,y)        — hover outline.
     ShapeTool.clearHover()
     ShapeTool.getOptionsForSelection()— return current opts
                                          for the options bar.

   Behavior:
     - Shape tool active + drag: create a new primitive on the
       active shape layer, or push a new shape layer above the
       active layer if it isn't already a shape layer.
     - Shape tool active + click on shape: select shape; show
       8 corner/edge resize handles + detached rotate disc
       (lines: 2 endpoint handles + rotate disc at midpoint).
     - Shift while drawing/resizing: preserve aspect ratio /
       constrain line to 45°.
     - Alt while drawing/resizing: anchor to center.
     - Shift while rotating: snap to 15°.
     - Right-click on shape: context menu (arrange / dup / del).

   Stroke alignment (inner / center / outer) is rendered with
   the standard canvas-clip trick. Dash pattern is six-field
   Illustrator-style: dash gap dash gap dash gap.
   ═══════════════════════════════════════════════════════ */

window.ShapeTool = (function () {

  // ── Defaults / constants ──────────────────────────────────
  const MIN_DIM = 1;
  const HIT_PAD = 4;            // pixel slop for line/edge hit-tests
  const ROTATE_GAP = 22;        // px above top edge for rotate disc
  const ROTATE_SNAP = Math.PI / 12; // 15°
  const DEFAULT_CORNER_RADIUS = 0;

  const DASH_PRESETS = [
    { id: 'solid',       label: 'Solid',           pattern: null },
    { id: 'dashed',      label: 'Dashed',          pattern: [12, 6, 0, 0, 0, 0] },
    { id: 'dashed-fine', label: 'Dashed Fine',     pattern: [4, 4, 0, 0, 0, 0] },
    { id: 'dashed-bold', label: 'Dashed Bold',     pattern: [18, 8, 0, 0, 0, 0] },
    { id: 'dotted',      label: 'Dotted',          pattern: [1, 4, 0, 0, 0, 0] },
    { id: 'dotted-bold', label: 'Dotted Bold',     pattern: [2, 4, 0, 0, 0, 0] },
    { id: 'dash-dot',    label: 'Dash Dot',        pattern: [12, 4, 1, 4, 0, 0] },
    { id: 'dash-dot-dot',label: 'Dash Dot Dot',    pattern: [12, 4, 1, 4, 1, 4] }
  ];

  let _activeShapeKind = 'rect';   // 'rect' | 'ellipse' | 'line'
  let _activeFill   = { type: 'solid', color: '#5b8def' };
  let _activeStroke = {
    type: 'solid',
    color: '#1a1a1e',
    width: 2,
    cap: 'butt',
    join: 'miter',
    align: 'center',
    dashPattern: null,
    dashOffset: 0
  };
  let _activeCornerRadius = 0;
  let _activeOpacity = 1;
  let _selectToolActive = false;  // true while the Selection tool (pen group) is editing shapes

  // ── Session state ─────────────────────────────────────────
  let session = null;
  // session = {
  //   layer,                      // shape layer being edited
  //   draftRect: null | {...},    // in-flight new shape drawing
  //   dragOp: null | {kind,...},  // current drag op
  //   selBoxEl,                   // root DOM <div> for the selection box(es)
  // }

  let _colorTarget = null;        // 'fill' | 'stroke' | null — for iframe
  let _suppressOptionsSync = 0;   // re-entrancy guard for input wiring

  // ── Geometry helpers ──────────────────────────────────────

  function _overlayRoot() {
    return (typeof workspace !== 'undefined' && workspace) || document.getElementById('workspace');
  }

  function _localToScreen(cx, cy) {
    return c2s(cx, cy);
  }

  // Get the world-space (un-rotated) bounding box of a shape.
  function _shapeBBox(s) {
    if (s.type === 'line') {
      const x1 = Math.min(s.p1.x, s.p2.x);
      const y1 = Math.min(s.p1.y, s.p2.y);
      const x2 = Math.max(s.p1.x, s.p2.x);
      const y2 = Math.max(s.p1.y, s.p2.y);
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    if (s.type === 'path') {
      const subs = (s.subpaths && s.subpaths.length)
        ? s.subpaths : [{ points: s.points }];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
      for (const sp of subs) {
        for (const p of (sp.points || [])) {
          any = true;
          if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
          if (p.ohx !== undefined) { if (p.ohx < minX) minX = p.ohx; if (p.ohx > maxX) maxX = p.ohx; if (p.ohy < minY) minY = p.ohy; if (p.ohy > maxY) maxY = p.ohy; }
          if (p.ihx !== undefined) { if (p.ihx < minX) minX = p.ihx; if (p.ihx > maxX) maxX = p.ihx; if (p.ihy < minY) minY = p.ihy; if (p.ihy > maxY) maxY = p.ihy; }
        }
      }
      if (!any) return { x: 0, y: 0, w: 0, h: 0 };
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    return { x: s.x, y: s.y, w: s.w, h: s.h };
  }

  function _shapeCenter(s) {
    if (s.type === 'line') {
      return { x: (s.p1.x + s.p2.x) / 2, y: (s.p1.y + s.p2.y) / 2 };
    }
    if (s.type === 'path') {
      const bb = _shapeBBox(s);
      return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
    }
    return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  }

  // Bounding box of a multi-shape selection (axis-aligned, world-space).
  function _selectionBBox(shapes) {
    if (!shapes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of shapes) {
      const b = _rotatedAabb(s);
      if (b.x < x0) x0 = b.x;
      if (b.y < y0) y0 = b.y;
      if (b.x + b.w > x1) x1 = b.x + b.w;
      if (b.y + b.h > y1) y1 = b.y + b.h;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Axis-aligned bbox of a shape *after* its own rotation is applied.
  function _rotatedAabb(s) {
    if (s.type === 'line') {
      const x1 = Math.min(s.p1.x, s.p2.x);
      const y1 = Math.min(s.p1.y, s.p2.y);
      const x2 = Math.max(s.p1.x, s.p2.x);
      const y2 = Math.max(s.p1.y, s.p2.y);
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    if (s.type === 'path') {
      // Paths bake rotation into their points, so AABB == BBox.
      return _shapeBBox(s);
    }
    const r = s.rotation || 0;
    if (!r) return { x: s.x, y: s.y, w: s.w, h: s.h };
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    const c = Math.cos(r), si = Math.sin(r);
    const hw = s.w / 2, hh = s.h / 2;
    const xs = [-hw, hw, hw, -hw], ys = [-hh, -hh, hh, hh];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      const X = cx + xs[i] * c - ys[i] * si;
      const Y = cy + xs[i] * si + ys[i] * c;
      if (X < x0) x0 = X; if (Y < y0) y0 = Y;
      if (X > x1) x1 = X; if (Y > y1) y1 = Y;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // Compound-aware subpath list for a path shape. A normal single-contour
  // path returns one entry; boolean results with holes carry s.subpaths
  // (rendered/exported with even-odd fill).
  function _pathSubpaths(s) {
    if (s.subpaths && s.subpaths.length) return s.subpaths;
    return [{ points: s.points || [], closed: !!s.closed }];
  }
  function _pathIsCompound(s) {
    return s.type === 'path' && s.subpaths && s.subpaths.length > 1;
  }

  // Every editable point array of a path shape. For a compound path the
  // subpaths are the source of truth (rendering/hit/export read them via
  // _pathSubpaths); re-alias s.points to subpaths[0] so a geometry edit can
  // never move the outer ring while a hole stays behind, even after a
  // clone/undo splits the arrays. Use this for ALL path geometry transforms.
  function _pathPointArrays(s) {
    if (s.subpaths && s.subpaths.length) {
      s.points = s.subpaths[0].points;
      return s.subpaths.map(sp => sp.points || []);
    }
    return [s.points || []];
  }
  // Same shape, for a _cloneShape() snapshot (arrays are independent copies).
  function _snapPointArrays(o) {
    if (o.subpaths && o.subpaths.length) return o.subpaths.map(sp => sp.points || []);
    return [o.points || []];
  }

  // ── Path building (stroke-aligned) ─────────────────────────

  function _appendPathContour(ctx, pts, closed) {
    if (pts.length < 1) return;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1], cur = pts[i];
      const cp1x = prev.ohx !== undefined ? prev.ohx : prev.x;
      const cp1y = prev.ohy !== undefined ? prev.ohy : prev.y;
      const cp2x = cur.ihx  !== undefined ? cur.ihx  : cur.x;
      const cp2y = cur.ihy  !== undefined ? cur.ihy  : cur.y;
      if (cp1x === prev.x && cp1y === prev.y && cp2x === cur.x && cp2y === cur.y) {
        ctx.lineTo(cur.x, cur.y);
      } else {
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, cur.x, cur.y);
      }
    }
    if (closed && pts.length > 1) {
      const prev = pts[pts.length - 1], cur = pts[0];
      const cp1x = prev.ohx !== undefined ? prev.ohx : prev.x;
      const cp1y = prev.ohy !== undefined ? prev.ohy : prev.y;
      const cp2x = cur.ihx  !== undefined ? cur.ihx  : cur.x;
      const cp2y = cur.ihy  !== undefined ? cur.ihy  : cur.y;
      if (cp1x === prev.x && cp1y === prev.y && cp2x === cur.x && cp2y === cur.y) {
        ctx.closePath();
      } else {
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, cur.x, cur.y);
        ctx.closePath();
      }
    }
  }

  function _buildShapePath(ctx, s) {
    if (s.type === 'rect') {
      const r = Math.max(0, Math.min(s.cornerRadius || 0, Math.min(s.w, s.h) / 2));
      ctx.beginPath();
      if (r === 0) {
        ctx.rect(s.x, s.y, s.w, s.h);
      } else if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(s.x, s.y, s.w, s.h, r);
      } else {
        const x = s.x, y = s.y, w = s.w, h = s.h;
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
      }
    } else if (s.type === 'ellipse') {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2);
    } else if (s.type === 'line') {
      ctx.beginPath();
      ctx.moveTo(s.p1.x, s.p1.y);
      ctx.lineTo(s.p2.x, s.p2.y);
    } else if (s.type === 'path') {
      ctx.beginPath();
      const subs = _pathSubpaths(s);
      for (let k = 0; k < subs.length; k++) {
        _appendPathContour(ctx, subs[k].points || [], !!subs[k].closed);
      }
    }
  }

  // Stroke alignment: 'center' (default), 'inner' (clip to interior, draw 2× width),
  // 'outer' (clip to exterior, draw 2× width).
  function _strokeWithAlignment(ctx, s) {
    const sw = s.stroke;
    if (!sw || sw.type === 'none' || !(sw.width > 0)) return;
    const align = (s.type === 'line') ? 'center' : (sw.align || 'center');
    const dashes = _resolveDashPattern(sw);
    ctx.save();
    ctx.strokeStyle = sw.color || '#000';
    ctx.lineCap = sw.cap || 'butt';
    ctx.lineJoin = sw.join || 'miter';
    if (sw.join === 'miter') ctx.miterLimit = 10;
    if (dashes) ctx.setLineDash(dashes);
    ctx.lineDashOffset = sw.dashOffset || 0;

    if (align === 'center') {
      ctx.lineWidth = sw.width;
      _buildShapePath(ctx, s);
      ctx.stroke();
    } else if (align === 'inner') {
      _buildShapePath(ctx, s);
      ctx.save();
      ctx.clip();
      ctx.lineWidth = sw.width * 2;
      _buildShapePath(ctx, s);
      ctx.stroke();
      ctx.restore();
    } else if (align === 'outer') {
      // Build evenodd clip = bigRect XOR shape → leaves only "outside" the shape.
      ctx.beginPath();
      ctx.rect(-1e6, -1e6, 2e6, 2e6);
      _buildShapePath(ctx, s);
      ctx.save();
      ctx.clip('evenodd');
      ctx.lineWidth = sw.width * 2;
      _buildShapePath(ctx, s);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  function _resolveDashPattern(stroke) {
    const p = stroke && stroke.dashPattern;
    if (!p) return null;
    // Drop trailing zero pairs; canvas requires positive lengths.
    const arr = [];
    for (let i = 0; i < p.length; i += 2) {
      const dash = +p[i] || 0;
      const gap  = +p[i + 1] || 0;
      if (dash <= 0 && gap <= 0) continue;
      arr.push(Math.max(0.01, dash));
      arr.push(Math.max(0.01, gap));
    }
    return arr.length ? arr : null;
  }

  // ── Rendering pipeline ────────────────────────────────────

  function _renderOneShape(ctx, s) {
    if (!s) return;
    ctx.save();
    if (s.opacity != null && s.opacity < 1) ctx.globalAlpha *= s.opacity;

    // Lines have no fill; paths store rotation baked in (no transform applied).
    // Rect/ellipse use a rotation transform around their bbox center.
    if (s.type === 'rect' || s.type === 'ellipse') {
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      ctx.translate(cx, cy);
      if (s.rotation) ctx.rotate(s.rotation);
      ctx.translate(-cx, -cy);
    }
    // Fill (skipped for line — line has no fill area)
    if (s.type !== 'line' && s.fill && s.fill.type !== 'none') {
      ctx.fillStyle = s.fill.color || '#000';
      _buildShapePath(ctx, s);
      if (_pathIsCompound(s)) ctx.fill('evenodd'); else ctx.fill();
    }
    // Stroke
    _strokeWithAlignment(ctx, s);

    ctx.restore();
  }

  function renderShapeLayer(layer) {
    if (!layer || layer.kind !== 'shape' || !layer.shapeModel) return;
    const ctx = layer.ctx;
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    for (const s of layer.shapeModel.shapes) {
      _renderOneShape(ctx, s);
    }
  }

  // Bridge so non-tool callers (history, layers, compositor) can re-render
  // without depending on window.ShapeTool being initialized first.
  window.renderShapeLayer = renderShapeLayer;

  // ── Hit testing ───────────────────────────────────────────

  function _pointInRotatedRect(px, py, rect, rotation) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    let lx = px - cx, ly = py - cy;
    if (rotation) {
      const c = Math.cos(-rotation), s = Math.sin(-rotation);
      const rx = lx * c - ly * s, ry = lx * s + ly * c;
      lx = rx; ly = ry;
    }
    return Math.abs(lx) <= rect.w / 2 && Math.abs(ly) <= rect.h / 2;
  }

  function _pointInRotatedEllipse(px, py, rect, rotation) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    let lx = px - cx, ly = py - cy;
    if (rotation) {
      const c = Math.cos(-rotation), s = Math.sin(-rotation);
      const rx = lx * c - ly * s, ry = lx * s + ly * c;
      lx = rx; ly = ry;
    }
    const a = rect.w / 2, b = rect.h / 2;
    if (a <= 0 || b <= 0) return false;
    return (lx * lx) / (a * a) + (ly * ly) / (b * b) <= 1;
  }

  function _distPointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lensq = dx * dx + dy * dy;
    if (lensq === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / lensq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function _bezierAt(p0x, p0y, cp1x, cp1y, cp2x, cp2y, p1x, p1y, t) {
    const mt = 1 - t;
    return {
      x: mt*mt*mt*p0x + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*p1x,
      y: mt*mt*mt*p0y + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*p1y
    };
  }

  function _pointInPolygon(px, py, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const xi = points[i].x, yi = points[i].y;
      const xj = points[j].x, yj = points[j].y;
      const intersect = ((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Hit-test a single shape: return true if (px,py) is on the shape's body.
  // Generous on stroke and line shapes (uses HIT_PAD scaled by zoom).
  function _hitShape(s, px, py) {
    const pad = HIT_PAD / (typeof zoom !== 'undefined' ? zoom : 1);
    if (s.type === 'line') {
      const w = (s.stroke && s.stroke.width) ? s.stroke.width : 1;
      const tol = Math.max(w / 2 + pad, pad + 2);
      return _distPointToSegment(px, py, s.p1.x, s.p1.y, s.p2.x, s.p2.y) <= tol;
    }
    if (s.type === 'rect') {
      // Pre-pad the bbox so the user can grab a stroke-only rect by its edge.
      const padded = { x: s.x - pad, y: s.y - pad, w: s.w + 2 * pad, h: s.h + 2 * pad };
      return _pointInRotatedRect(px, py, padded, s.rotation || 0);
    }
    if (s.type === 'ellipse') {
      const padded = { x: s.x - pad, y: s.y - pad, w: s.w + 2 * pad, h: s.h + 2 * pad };
      return _pointInRotatedEllipse(px, py, padded, s.rotation || 0);
    }
    if (s.type === 'path') {
      const w = (s.stroke && s.stroke.width) ? s.stroke.width : 1;
      const tol = Math.max(w / 2 + pad, pad + 2);
      const _hitSeg = (p0, p1) => {
        const cp1x = p0.ohx !== undefined ? p0.ohx : p0.x;
        const cp1y = p0.ohy !== undefined ? p0.ohy : p0.y;
        const cp2x = p1.ihx !== undefined ? p1.ihx : p1.x;
        const cp2y = p1.ihy !== undefined ? p1.ihy : p1.y;
        if (cp1x === p0.x && cp1y === p0.y && cp2x === p1.x && cp2y === p1.y) {
          return _distPointToSegment(px, py, p0.x, p0.y, p1.x, p1.y) <= tol;
        }
        let lx = p0.x, ly = p0.y;
        for (let j = 1; j <= 8; j++) {
          const b = _bezierAt(p0.x, p0.y, cp1x, cp1y, cp2x, cp2y, p1.x, p1.y, j / 8);
          if (_distPointToSegment(px, py, lx, ly, b.x, b.y) <= tol) return true;
          lx = b.x; ly = b.y;
        }
        return false;
      };
      const subs = _pathSubpaths(s);
      let oddFill = false;
      for (const sp of subs) {
        const pts = sp.points || [];
        if (pts.length < 2) continue;
        for (let i = 0; i < pts.length - 1; i++) {
          if (_hitSeg(pts[i], pts[i + 1])) return true;
        }
        if (sp.closed && _hitSeg(pts[pts.length - 1], pts[0])) return true;
        if (sp.closed && pts.length >= 3 && _pointInPolygon(px, py, pts)) oddFill = !oddFill;
      }
      if (s.fill && s.fill.type !== 'none' && oddFill) return true;
      return false;
    }
    return false;
  }

  // Top-down hit test across all shape layers. Returns { layerIndex, shape } or null.
  function _hitAcrossLayers(px, py) {
    if (typeof layers === 'undefined') return null;
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (!l || !l.visible || l.kind !== 'shape' || !l.shapeModel) continue;
      const arr = l.shapeModel.shapes;
      for (let j = arr.length - 1; j >= 0; j--) {
        if (_hitShape(arr[j], px, py)) return { layerIndex: i, shape: arr[j], shapeIndex: j };
      }
    }
    return null;
  }

  // ── Selection management ──────────────────────────────────

  function _ensureSelectedSet(layer) {
    if (!layer.shapeModel.selectedIds || !(layer.shapeModel.selectedIds instanceof Set)) {
      layer.shapeModel.selectedIds = new Set();
    }
    return layer.shapeModel.selectedIds;
  }

  function _selectedShapes(layer) {
    if (!layer || !layer.shapeModel) return [];
    const ids = _ensureSelectedSet(layer);
    return layer.shapeModel.shapes.filter(s => ids.has(s.id));
  }

  function _setSelection(layer, ids) {
    _ensureSelectedSet(layer);
    layer.shapeModel.selectedIds = new Set(ids);
    _syncOptionsBarFromSelection();
    _renderHandles();
  }

  function _clearSelection(layer) {
    if (!layer || !layer.shapeModel) return;
    if (layer.shapeModel.selectedIds) layer.shapeModel.selectedIds.clear();
    else layer.shapeModel.selectedIds = new Set();
    _syncOptionsBarFromSelection();
    _renderHandles();
  }

  function _findShapeById(layer, id) {
    if (!layer || !layer.shapeModel) return null;
    return layer.shapeModel.shapes.find(s => s.id === id) || null;
  }

  // ── Session lifecycle ─────────────────────────────────────

  function _ensureSession(layer) {
    if (session && session.layer === layer) return session;
    if (session) endEdit(true);
    const wrap = _overlayRoot();
    const selBoxEl = document.createElement('div');
    selBoxEl.className = 'sh-overlay';
    wrap.appendChild(selBoxEl);
    session = {
      layer,
      dragOp: null,
      draftRect: null,
      selBoxEl
    };
    _ensureSelectedSet(layer);
    _renderHandles();
    return session;
  }

  function endEdit(commit) {
    if (!session) return;
    const s = session;
    if (s.dragOp) {
      document.removeEventListener('mousemove', _onDragMove);
      document.removeEventListener('mouseup', _onDragUp);
      s.dragOp = null;
      if (typeof SnapEngine !== 'undefined') SnapEngine.endSession();
    }
    if (s.selBoxEl && s.selBoxEl.parentNode) s.selBoxEl.parentNode.removeChild(s.selBoxEl);
    // Selection lives on layer.shapeModel.selectedIds and intentionally persists
    // across tool switches so a shape selected on one tool stays selected on the
    // next (Shape ↔ Move ↔ Pen ↔ Direct Selection). Use _clearSelection(layer)
    // for explicit user-driven clears (Esc, click empty canvas, delete).
    session = null;
  }

  function beginEdit(layer) {
    if (!layer || layer.kind !== 'shape') return;
    _ensureSession(layer);
    // Select all shapes for visibility.
    const ids = layer.shapeModel.shapes.map(s => s.id);
    _setSelection(layer, ids);
  }

  function _cloneShape(s) {
    const cp = {
      id: s.id, type: s.type, rotation: s.rotation || 0,
      fill:   { ...(s.fill || { type:'solid', color:'#fff' }) },
      stroke: { ...(s.stroke || {}), dashPattern: s.stroke && s.stroke.dashPattern ? s.stroke.dashPattern.slice() : null },
      opacity: s.opacity == null ? 1 : s.opacity
    };
    if (s.type === 'line') {
      cp.p1 = { x: s.p1.x, y: s.p1.y };
      cp.p2 = { x: s.p2.x, y: s.p2.y };
    } else if (s.type === 'path') {
      const clonePts = (arr) => (arr || []).map(p => {
        const pt = { x: p.x, y: p.y };
        if (p.type)            pt.type = p.type;
        if (p.ohx !== undefined) { pt.ohx = p.ohx; pt.ohy = p.ohy; }
        if (p.ihx !== undefined) { pt.ihx = p.ihx; pt.ihy = p.ihy; }
        return pt;
      });
      cp.points = clonePts(s.points);
      cp.closed = !!s.closed;
      if (s.subpaths && s.subpaths.length) {
        cp.subpaths = s.subpaths.map(sp => ({
          points: clonePts(sp.points), closed: !!sp.closed
        }));
      }
    } else {
      cp.x = s.x; cp.y = s.y; cp.w = s.w; cp.h = s.h;
      if (s.type === 'rect') cp.cornerRadius = s.cornerRadius || 0;
    }
    return cp;
  }

  // ── Selection box & handles (DOM overlay) ─────────────────

  // rAF-throttled wrapper. Handles are pure visual scaffolding — coalescing
  // multiple calls per frame avoids rebuilding the DOM (and re-attaching
  // mousedown listeners) on every drag-move event.
  let _handlesRafScheduled = false;
  function _renderHandles() {
    if (!session) return;
    if (_handlesRafScheduled) return;
    _handlesRafScheduled = true;
    requestAnimationFrame(() => {
      _handlesRafScheduled = false;
      _renderHandlesNow();
    });
  }

  function _renderHandlesNow() {
    if (!session) return;
    const layer = session.layer;
    const root = session.selBoxEl;
    if (!root) return;
    root.innerHTML = '';
    // Hover-reveal outlines for every unselected shape on this layer (the
    // selected shapes get their solid outline rendered alongside their
    // bbox/handles below). One SVG group per shape so :hover propagates.
    _renderAllShapeOutlines(root, layer);
    const sel = _selectedShapes(layer);
    if (!sel.length) return;
    if (sel.length === 1) {
      _renderHandlesForShape(root, sel[0]);
    } else {
      _renderGroupHandles(root, sel);
    }
  }

  function _renderAllShapeOutlines(root, layer) {
    // Iterate every visible shape layer (not just the active one) so paths
    // reveal on hover regardless of which layer is active or which shape is
    // currently selected. Skip shapes selected on the active layer (those
    // get their solid outline drawn alongside bbox/handles below).
    const allLayers = (typeof layers !== 'undefined' && Array.isArray(layers)) ? layers : [];
    const activeSelIds = (layer && layer.shapeModel) ? layer.shapeModel.selectedIds : null;
    for (const L of allLayers) {
      if (!L || !L.visible || L.kind !== 'shape' || !L.shapeModel) continue;
      const shapes = L.shapeModel.shapes;
      for (const s of shapes) {
        if (L === layer && activeSelIds && activeSelIds.has(s.id)) continue;
        _drawShapeOutlineHover(root, s);
      }
    }
  }

  // Build the screen-space "d" attribute for any primitive shape (rect/ellipse/line/path).
  function _shapeOutlineD(s) {
    if (s.type === 'path') return _pathD(s);
    if (s.type === 'line') {
      const a = _localToScreen(s.p1.x, s.p1.y);
      const b = _localToScreen(s.p2.x, s.p2.y);
      return 'M ' + a.x.toFixed(2) + ' ' + a.y.toFixed(2) + ' L ' + b.x.toFixed(2) + ' ' + b.y.toFixed(2);
    }
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    const r = s.rotation || 0;
    const cR = Math.cos(r), sR = Math.sin(r);
    const hw = s.w / 2, hh = s.h / 2;
    const local = (lx, ly) => {
      const wx = cx + lx * cR - ly * sR;
      const wy = cy + lx * sR + ly * cR;
      return _localToScreen(wx, wy);
    };
    if (s.type === 'rect') {
      const tl = local(-hw,-hh), tr = local(hw,-hh), br = local(hw,hh), bl = local(-hw,hh);
      return 'M ' + tl.x.toFixed(2) + ' ' + tl.y.toFixed(2)
           + ' L ' + tr.x.toFixed(2) + ' ' + tr.y.toFixed(2)
           + ' L ' + br.x.toFixed(2) + ' ' + br.y.toFixed(2)
           + ' L ' + bl.x.toFixed(2) + ' ' + bl.y.toFixed(2)
           + ' Z';
    }
    if (s.type === 'ellipse') {
      const segs = 64;
      let d = '';
      for (let i = 0; i <= segs; i++) {
        const th = (i / segs) * Math.PI * 2;
        const lx = Math.cos(th) * hw, ly = Math.sin(th) * hh;
        const p = local(lx, ly);
        d += (i === 0 ? 'M ' : ' L ') + p.x.toFixed(2) + ' ' + p.y.toFixed(2);
      }
      return d + ' Z';
    }
    return '';
  }

  // SVG group with two paths: a wide invisible hit path that catches hover
  // (1-2px proximity via stroke-width 4) and a visible path that becomes
  // green on group :hover.
  function _drawShapeOutlineHover(root, s) {
    const d = _shapeOutlineD(s);
    if (!d) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sh-outline-svg');
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'sh-outline-grp');
    g.setAttribute('data-shape-id', s.id);
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('class', 'sh-outline-hit');
    hit.setAttribute('d', d);
    const vis = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    vis.setAttribute('class', 'sh-outline-path');
    vis.setAttribute('d', d);
    g.appendChild(hit);
    g.appendChild(vis);
    svg.appendChild(g);
    root.appendChild(svg);
  }

  function _renderHandlesForShape(root, s) {
    if (s.type === 'line') {
      _renderLineHandles(root, s);
      return;
    }
    if (s.type === 'path') {
      // Path: render the actual curve outline + axis-aligned bbox + 8 handles.
      // Rotate is handled via hover zones offset just outside each edge handle
      // (mirrors the move-tool's pxTransform pattern). No rotate disc.
      _drawPathOutlineSVG(root, s, false /* dashed */);
      const bb = _shapeBBox(s);
      const tl = _localToScreen(bb.x, bb.y);
      const tr = _localToScreen(bb.x + bb.w, bb.y);
      const br = _localToScreen(bb.x + bb.w, bb.y + bb.h);
      const bl = _localToScreen(bb.x, bb.y + bb.h);
      _drawLineEl(root, tl, tr);
      _drawLineEl(root, tr, br);
      _drawLineEl(root, br, bl);
      _drawLineEl(root, bl, tl);
      const mids = {
        n: _localToScreen(bb.x + bb.w/2, bb.y),
        e: _localToScreen(bb.x + bb.w, bb.y + bb.h/2),
        sd: _localToScreen(bb.x + bb.w/2, bb.y + bb.h),
        w: _localToScreen(bb.x, bb.y + bb.h/2)
      };
      _placeHandle(root, tl.x, tl.y, 'sh-h-corner', 'g-nw', null);
      _placeHandle(root, tr.x, tr.y, 'sh-h-corner', 'g-ne', null);
      _placeHandle(root, br.x, br.y, 'sh-h-corner', 'g-se', null);
      _placeHandle(root, bl.x, bl.y, 'sh-h-corner', 'g-sw', null);
      _placeHandle(root, mids.n.x,  mids.n.y,  'sh-h-edge', 'g-n', null);
      _placeHandle(root, mids.e.x,  mids.e.y,  'sh-h-edge', 'g-e', null);
      _placeHandle(root, mids.sd.x, mids.sd.y, 'sh-h-edge', 'g-s', null);
      _placeHandle(root, mids.w.x,  mids.w.y,  'sh-h-edge', 'g-w', null);
      const off = 18; // screen-pixel offset for the rotate hot-zone
      _placeRotateZone(root, mids.n.x,  mids.n.y - off,  null);
      _placeRotateZone(root, mids.sd.x, mids.sd.y + off, null);
      _placeRotateZone(root, mids.e.x + off,  mids.e.y,  null);
      _placeRotateZone(root, mids.w.x - off,  mids.w.y,  null);
      return;
    }
    // Rect/ellipse: outline (curve for ellipse) + 8 resize handles + rotate
    // hover-zones offset just outside each edge handle. (Rect only: corner-radius handle.)
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    const r = s.rotation || 0;
    const cR = Math.cos(r), sR = Math.sin(r);
    const local = (lx, ly) => {
      const wx = cx + lx * cR - ly * sR;
      const wy = cy + lx * sR + ly * cR;
      return _localToScreen(wx, wy);
    };
    const hw = s.w / 2, hh = s.h / 2;

    // For ellipses, the bbox is rect-shaped but the actual outline is elliptical.
    // For rects the bbox === outline so a separate SVG outline is redundant.
    if (s.type === 'ellipse') {
      _drawEllipseOutlineSVG(root, s, false);
    }

    // Bounding-box stroke (4 connecting lines)
    const corners = [local(-hw,-hh), local(hw,-hh), local(hw,hh), local(-hw,hh)];
    _drawLineEl(root, corners[0], corners[1]);
    _drawLineEl(root, corners[1], corners[2]);
    _drawLineEl(root, corners[2], corners[3]);
    _drawLineEl(root, corners[3], corners[0]);

    // Handles: 8 of them
    const defs = [
      { name:'nw', x:-hw, y:-hh, kind:'corner' },
      { name:'n',  x:0,   y:-hh, kind:'edge' },
      { name:'ne', x:hw,  y:-hh, kind:'corner' },
      { name:'e',  x:hw,  y:0,   kind:'edge' },
      { name:'se', x:hw,  y:hh,  kind:'corner' },
      { name:'s',  x:0,   y:hh,  kind:'edge' },
      { name:'sw', x:-hw, y:hh,  kind:'corner' },
      { name:'w',  x:-hw, y:0,   kind:'edge' }
    ];
    for (const d of defs) {
      const p = local(d.x, d.y);
      _placeHandle(root, p.x, p.y, 'sh-h-' + d.kind, d.name, s);
    }

    // Rotate hot-zones offset 18 screen-px past each edge handle (perpendicular
    // to the box edge in the shape's rotated frame).
    const off = 18 / (typeof zoom!=='undefined'?zoom:1);
    const rzN = local(0,    -hh - off);
    const rzS = local(0,     hh + off);
    const rzE = local( hw + off, 0);
    const rzW = local(-hw - off, 0);
    _placeRotateZone(root, rzN.x, rzN.y, s);
    _placeRotateZone(root, rzS.x, rzS.y, s);
    _placeRotateZone(root, rzE.x, rzE.y, s);
    _placeRotateZone(root, rzW.x, rzW.y, s);

    // Corner radius handle (rects only). A small inner disc near the top-left,
    // proportional to current corner radius. Drag it horizontally to set radius.
    if (s.type === 'rect') {
      const maxR = Math.min(s.w, s.h) / 2;
      const cur = Math.max(0, Math.min(s.cornerRadius || 0, maxR));
      // Minimum offset is 8 screen-pixels (i.e., 8/zoom canvas-px) so the handle
      // stays visible & grabbable at any zoom when radius is 0; once the user
      // drags it past that minimum, the position tracks the actual radius.
      const off = Math.max(8 / (typeof zoom !== 'undefined' ? zoom : 1), cur);
      const hx = -hw + off;
      const hy = -hh + off;
      const hp = local(hx, hy);
      _placeCornerRadiusHandle(root, hp.x, hp.y, s);
    }
  }

  function _renderLineHandles(root, s) {
    const p1 = _localToScreen(s.p1.x, s.p1.y);
    const p2 = _localToScreen(s.p2.x, s.p2.y);
    _drawLineEl(root, p1, p2);
    _placeHandle(root, p1.x, p1.y, 'sh-h-corner', 'lp1', s);
    _placeHandle(root, p2.x, p2.y, 'sh-h-corner', 'lp2', s);
    // No rotate disc — lines rotate via endpoint dragging.
  }

  function _renderGroupHandles(root, shapes) {
    // Multi-select: show a single group bbox with 8 resize + rotate handles.
    // Group rotation is stored on the dragOp (transient); the bbox is axis-aligned.
    const bb = _selectionBBox(shapes);
    const tl = _localToScreen(bb.x, bb.y);
    const tr = _localToScreen(bb.x + bb.w, bb.y);
    const br = _localToScreen(bb.x + bb.w, bb.y + bb.h);
    const bl = _localToScreen(bb.x, bb.y + bb.h);
    _drawLineEl(root, tl, tr, 'sh-group-stroke');
    _drawLineEl(root, tr, br, 'sh-group-stroke');
    _drawLineEl(root, br, bl, 'sh-group-stroke');
    _drawLineEl(root, bl, tl, 'sh-group-stroke');
    const mids = {
      n: _localToScreen(bb.x + bb.w/2, bb.y),
      e: _localToScreen(bb.x + bb.w, bb.y + bb.h/2),
      s: _localToScreen(bb.x + bb.w/2, bb.y + bb.h),
      w: _localToScreen(bb.x, bb.y + bb.h/2)
    };
    const corners = { nw: tl, ne: tr, se: br, sw: bl };
    for (const k of ['nw','ne','se','sw']) _placeHandle(root, corners[k].x, corners[k].y, 'sh-h-corner', 'g-' + k, null);
    for (const k of ['n','e','s','w']) _placeHandle(root, mids[k].x, mids[k].y, 'sh-h-edge', 'g-' + k, null);
    const off = 18;
    _placeRotateZone(root, mids.n.x, mids.n.y - off, null);
    _placeRotateZone(root, mids.s.x, mids.s.y + off, null);
    _placeRotateZone(root, mids.e.x + off, mids.e.y, null);
    _placeRotateZone(root, mids.w.x - off, mids.w.y, null);
  }

  function _drawLineEl(root, p1, p2, cls) {
    const el = document.createElement('div');
    el.className = 'sh-edge ' + (cls || '');
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    el.style.left = p1.x + 'px';
    el.style.top  = p1.y + 'px';
    el.style.width = len + 'px';
    el.style.transform = `rotate(${ang}rad)`;
    root.appendChild(el);
  }

  function _placeHandle(root, x, y, cls, dataHandle, shape) {
    const el = document.createElement('div');
    el.className = 'sh-handle ' + cls;
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    el.dataset.handle = dataHandle;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      _beginHandleDrag(dataHandle, shape, e);
    });
    root.appendChild(el);
  }

  function _placeRotateDisc(root, x, y, shape) {
    const el = document.createElement('div');
    el.className = 'sh-handle sh-rot-disc';
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    el.title = 'Rotate';
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      _beginRotateDrag(shape, e);
    });
    root.appendChild(el);
  }

  function _placeRotateZone(root, x, y, shape) {
    const el = document.createElement('div');
    el.className = 'sh-rotate-zone';
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    el.title = 'Rotate';
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      _beginRotateDrag(shape, e);
    });
    root.appendChild(el);
  }

  // SVG path outline for cubic-bezier paths. Pixel-perfect 2px green stroke.
  function _drawPathOutlineSVG(root, s, dashed) {
    const pts = s.points || [];
    if (pts.length < 2) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sh-outline-svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'sh-outline-path' + (dashed ? ' is-dashed' : ''));
    path.setAttribute('d', _pathD(s));
    svg.appendChild(path);
    root.appendChild(svg);
  }

  // SVG ellipse outline (axis-aligned ellipse rotated by s.rotation).
  function _drawEllipseOutlineSVG(root, s, dashed) {
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    const r = s.rotation || 0;
    const cR = Math.cos(r), sR = Math.sin(r);
    const hw = s.w / 2, hh = s.h / 2;
    const segs = 64;
    let d = '';
    for (let i = 0; i <= segs; i++) {
      const th = (i / segs) * Math.PI * 2;
      const lx = Math.cos(th) * hw, ly = Math.sin(th) * hh;
      const wx = cx + lx * cR - ly * sR;
      const wy = cy + lx * sR + ly * cR;
      const p = _localToScreen(wx, wy);
      d += (i === 0 ? 'M ' : ' L ') + p.x.toFixed(2) + ' ' + p.y.toFixed(2);
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'sh-outline-svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'sh-outline-path' + (dashed ? ' is-dashed' : ''));
    path.setAttribute('d', d);
    svg.appendChild(path);
    root.appendChild(svg);
  }

  // Build an SVG path "d" attribute that traces a path-shape's cubic-bezier
  // outline in screen coordinates. Used by both selected-state (solid) and
  // pen-draft (dashed) overlays.
  function _pathD(s) {
    const seg = (p0, p1) => {
      const cp1x = p0.ohx !== undefined ? p0.ohx : p0.x;
      const cp1y = p0.ohy !== undefined ? p0.ohy : p0.y;
      const cp2x = p1.ihx !== undefined ? p1.ihx : p1.x;
      const cp2y = p1.ihy !== undefined ? p1.ihy : p1.y;
      const c1 = _localToScreen(cp1x, cp1y);
      const c2 = _localToScreen(cp2x, cp2y);
      const e  = _localToScreen(p1.x, p1.y);
      if (cp1x === p0.x && cp1y === p0.y && cp2x === p1.x && cp2y === p1.y) {
        return ' L ' + e.x.toFixed(2) + ' ' + e.y.toFixed(2);
      }
      return ' C ' + c1.x.toFixed(2) + ' ' + c1.y.toFixed(2)
        +  ' ' + c2.x.toFixed(2) + ' ' + c2.y.toFixed(2)
        +  ' ' + e.x.toFixed(2)  + ' ' + e.y.toFixed(2);
    };
    let d = '';
    for (const sp of _pathSubpaths(s)) {
      const pts = sp.points || [];
      if (!pts.length) continue;
      const start = _localToScreen(pts[0].x, pts[0].y);
      d += (d ? ' ' : '') + 'M ' + start.x.toFixed(2) + ' ' + start.y.toFixed(2);
      for (let i = 0; i < pts.length - 1; i++) d += seg(pts[i], pts[i + 1]);
      if (sp.closed && pts.length > 2) { d += seg(pts[pts.length - 1], pts[0]) + ' Z'; }
    }
    return d;
  }

  function _placeCornerRadiusHandle(root, x, y, shape) {
    const el = document.createElement('div');
    el.className = 'sh-corner-radius';
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    el.title = 'Corner Radius';
    // Diagonal double-sided arrow pointing toward shape center. Corner-radius
    // handle sits at the top-left of an unrotated rect, so the diagonal is
    // NW-SE → nwse-resize. (For rotated rects this is approximate.)
    el.style.cursor = 'nwse-resize';
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      _beginCornerRadiusDrag(shape, e);
    });
    root.appendChild(el);
  }

  // ── Drag operations ───────────────────────────────────────

  function _beginMoveDrag(e) {
    if (!session) return;
    const sel = _selectedShapes(session.layer);
    if (!sel.length) return;
    session.dragOp = {
      kind: 'move',
      startMouse: { x: e.clientX, y: e.clientY },
      startStates: sel.map(s => _cloneShape(s)),
      changed: false
    };
    if (typeof SnapEngine !== 'undefined') {
      const excl = new Set([session.layer.id]);
      SnapEngine.beginSession({ excludeLayerIds: excl, excludeSelection: true });
    }
    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup', _onDragUp);
  }

  function _beginHandleDrag(handleName, shape, e) {
    if (!session) return;
    const layer = session.layer;
    if (handleName === 'lp1' || handleName === 'lp2') {
      // Line endpoint
      session.dragOp = {
        kind: 'line-endpoint',
        handle: handleName,
        shape,
        startMouse: { x: e.clientX, y: e.clientY },
        startState: _cloneShape(shape),
        changed: false
      };
    } else if (handleName.startsWith('g-')) {
      // Group resize
      const sel = _selectedShapes(layer);
      const bb = _selectionBBox(sel);
      session.dragOp = {
        kind: 'group-resize',
        handle: handleName.slice(2),
        startMouse: { x: e.clientX, y: e.clientY },
        startBBox: { ...bb },
        startStates: sel.map(s => _cloneShape(s)),
        changed: false
      };
    } else {
      session.dragOp = {
        kind: 'resize',
        handle: handleName,
        shape,
        startMouse: { x: e.clientX, y: e.clientY },
        startState: _cloneShape(shape),
        changed: false
      };
    }
    if (typeof SnapEngine !== 'undefined') {
      const excl = new Set([session.layer.id]);
      SnapEngine.beginSession({ excludeLayerIds: excl, excludeSelection: true });
    }
    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup', _onDragUp);
  }

  function _beginRotateDrag(shape, e) {
    if (!session) return;
    const layer = session.layer;
    if (shape) {
      const c = _shapeCenter(shape);
      session.dragOp = {
        kind: 'rotate',
        shape,
        center: c,
        startState: _cloneShape(shape),
        startMouse: { x: e.clientX, y: e.clientY },
        startAngle: _mouseAngleFromCenter(e, c),
        changed: false
      };
    } else {
      // Group rotate: rotate all selected around group bbox center.
      const sel = _selectedShapes(layer);
      const bb = _selectionBBox(sel);
      const c = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
      session.dragOp = {
        kind: 'group-rotate',
        center: c,
        startStates: sel.map(s => _cloneShape(s)),
        startMouse: { x: e.clientX, y: e.clientY },
        startAngle: _mouseAngleFromCenter(e, c),
        changed: false
      };
    }
    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup', _onDragUp);
  }

  function _beginCornerRadiusDrag(shape, e) {
    if (!session) return;
    session.dragOp = {
      kind: 'corner-radius',
      shape,
      startMouse: { x: e.clientX, y: e.clientY },
      startState: _cloneShape(shape),
      changed: false
    };
    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup', _onDragUp);
  }

  function _mouseAngleFromCenter(e, center) {
    const sp = c2s(center.x, center.y);
    return Math.atan2(e.clientY - sp.y, e.clientX - sp.x);
  }

  function _onDragMove(e) {
    if (!session || !session.dragOp) return;
    const op = session.dragOp;
    const layer = session.layer;
    const z = typeof zoom !== 'undefined' ? zoom : 1;
    const dxC = (e.clientX - op.startMouse.x) / z;
    const dyC = (e.clientY - op.startMouse.y) / z;
    if (Math.abs(dxC) > 0.01 || Math.abs(dyC) > 0.01) op.changed = true;

    if (op.kind === 'move') {
      const sel = _selectedShapes(layer);
      sel.forEach((s, i) => {
        const o = op.startStates[i];
        if (s.type === 'line') {
          s.p1.x = o.p1.x + dxC; s.p1.y = o.p1.y + dyC;
          s.p2.x = o.p2.x + dxC; s.p2.y = o.p2.y + dyC;
        } else if (s.type === 'path') {
          const liveArrs = _pathPointArrays(s);
          const snapArrs = _snapPointArrays(o);
          for (let a = 0; a < liveArrs.length && a < snapArrs.length; a++) {
            const live = liveArrs[a], snap = snapArrs[a];
            for (let k = 0; k < snap.length && k < live.length; k++) {
              const sp = snap[k], lp = live[k];
              lp.x = sp.x + dxC; lp.y = sp.y + dyC;
              if (sp.ohx !== undefined) { lp.ohx = sp.ohx + dxC; lp.ohy = sp.ohy + dyC; }
              if (sp.ihx !== undefined) { lp.ihx = sp.ihx + dxC; lp.ihy = sp.ihy + dyC; }
            }
          }
        } else {
          s.x = o.x + dxC; s.y = o.y + dyC;
        }
      });
    } else if (op.kind === 'resize') {
      _applyResize(op, dxC, dyC, e);
    } else if (op.kind === 'rotate') {
      const ang = _mouseAngleFromCenter(e, op.center);
      let r = (op.startState.rotation || 0) + (ang - op.startAngle);
      if (e.shiftKey) r = Math.round(r / ROTATE_SNAP) * ROTATE_SNAP;
      op.shape.rotation = r;
    } else if (op.kind === 'line-endpoint') {
      const tgt = (op.handle === 'lp1') ? op.shape.p1 : op.shape.p2;
      const oth = (op.handle === 'lp1') ? op.startState.p2 : op.startState.p1;
      const start = (op.handle === 'lp1') ? op.startState.p1 : op.startState.p2;
      let nx = start.x + dxC, ny = start.y + dyC;
      if (e.shiftKey) {
        // Constrain to 45° relative to the *other* endpoint.
        const dx = nx - oth.x, dy = ny - oth.y;
        const ang = Math.atan2(dy, dx);
        const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        nx = oth.x + Math.cos(snap) * len;
        ny = oth.y + Math.sin(snap) * len;
      }
      tgt.x = nx; tgt.y = ny;
    } else if (op.kind === 'corner-radius') {
      const o = op.startState;
      const maxR = Math.min(o.w, o.h) / 2;
      // Drag along horizontal-and-vertical of the rotated frame; project onto
      // the diagonal pointing inward from top-left for an intuitive feel.
      const r = (o.rotation || 0);
      const c = Math.cos(-r), si = Math.sin(-r);
      const lx = dxC * c - dyC * si;
      const ly = dxC * si + dyC * c;
      const delta = (lx + ly) / 2;
      const nr = Math.max(0, Math.min(maxR, (o.cornerRadius || 0) + delta));
      op.shape.cornerRadius = nr;
    } else if (op.kind === 'group-resize') {
      _applyGroupResize(op, dxC, dyC, e);
    } else if (op.kind === 'group-rotate') {
      const ang = _mouseAngleFromCenter(e, op.center);
      let dAng = ang - op.startAngle;
      if (e.shiftKey) dAng = Math.round(dAng / ROTATE_SNAP) * ROTATE_SNAP;
      const sel = _selectedShapes(layer);
      const cosA = Math.cos(dAng), sinA = Math.sin(dAng);
      const _rotXY = (x, y) => ({
        x: op.center.x + (x - op.center.x) * cosA - (y - op.center.y) * sinA,
        y: op.center.y + (x - op.center.x) * sinA + (y - op.center.y) * cosA
      });
      sel.forEach((s, i) => {
        const o = op.startStates[i];
        if (s.type === 'line') {
          const p1 = _rotXY(o.p1.x, o.p1.y);
          const p2 = _rotXY(o.p2.x, o.p2.y);
          s.p1.x = p1.x; s.p1.y = p1.y;
          s.p2.x = p2.x; s.p2.y = p2.y;
        } else if (s.type === 'path') {
          const liveArrs = _pathPointArrays(s);
          const snapArrs = _snapPointArrays(o);
          for (let ai = 0; ai < liveArrs.length && ai < snapArrs.length; ai++) {
            const live = liveArrs[ai], snap = snapArrs[ai];
            for (let k = 0; k < snap.length && k < live.length; k++) {
              const op2 = snap[k], lp = live[k];
              const a = _rotXY(op2.x, op2.y);
              lp.x = a.x; lp.y = a.y;
              if (op2.ohx !== undefined) {
                const oh = _rotXY(op2.ohx, op2.ohy);
                lp.ohx = oh.x; lp.ohy = oh.y;
              }
              if (op2.ihx !== undefined) {
                const ih = _rotXY(op2.ihx, op2.ihy);
                lp.ihx = ih.x; lp.ihy = ih.y;
              }
            }
          }
        } else {
          const ocx = o.x + o.w / 2, ocy = o.y + o.h / 2;
          const c = _rotXY(ocx, ocy);
          s.x = c.x - o.w / 2; s.y = c.y - o.h / 2;
          s.rotation = (o.rotation || 0) + dAng;
        }
      });
    }
    renderShapeLayer(layer);
    if (typeof compositeAll === 'function') compositeAll();
    _renderHandles();
    // Skip the full options-bar refresh during drag (it touches dozens of
    // DOM nodes per frame). _onDragUp will sync once the gesture settles.
    if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
  }

  function _applyResize(op, dxC, dyC, e) {
    const o = op.startState;
    const s = op.shape;
    const r = o.rotation || 0;
    // Convert mouse delta from world → local frame so handles behave correctly
    // for rotated shapes.
    const c = Math.cos(-r), si = Math.sin(-r);
    const lx = dxC * c - dyC * si;
    const ly = dxC * si + dyC * c;

    let nl = 0, nt = 0, nr = o.w, nb = o.h; // local frame: rect goes (0,0)→(w,h)
    const h = op.handle;
    const east  = h.includes('e');
    const west  = h.includes('w');
    const north = h.includes('n');
    const south = h.includes('s');
    if (east)  nr = o.w + lx;
    if (west)  nl = lx;
    if (south) nb = o.h + ly;
    if (north) nt = ly;

    // Shift = preserve current aspect ratio. Works on edge handles (scales
    // the perpendicular axis around its center) and corner handles (the
    // larger relative delta drives the smaller one).
    if (e.shiftKey) {
      const isCorner = (east || west) && (north || south);
      const ar = o.w / Math.max(1e-6, o.h);
      if (isCorner) {
        const dw = (nr - nl) - o.w;
        const dh = (nb - nt) - o.h;
        // Scale factor candidates from each axis; pick the one with the larger drag.
        const scaleW = (o.w + dw) / Math.max(1e-6, o.w);
        const scaleH = (o.h + dh) / Math.max(1e-6, o.h);
        const useW = Math.abs(scaleW - 1) >= Math.abs(scaleH - 1);
        const sc = useW ? scaleW : scaleH;
        if (useW) {
          const newH = o.h * sc;
          if (south)      nb = nt + newH;
          else if (north) nt = nb - newH;
        } else {
          const newW = o.w * sc;
          if (east)       nr = nl + newW;
          else if (west)  nl = nr - newW;
        }
      } else if (east || west) {
        // Horizontal edge: scale height to match width, centered vertically.
        const newW = nr - nl;
        const newH = o.h * (newW / Math.max(1e-6, o.w));
        nt = (o.h - newH) / 2;
        nb = nt + newH;
      } else if (north || south) {
        // Vertical edge: scale width to match height, centered horizontally.
        const newH = nb - nt;
        const newW = o.w * (newH / Math.max(1e-6, o.h));
        nl = (o.w - newW) / 2;
        nr = nl + newW;
      }
    }

    // Alt = scale from center (mirror the opposite edge inward).
    if (e.altKey) {
      if (east)  { nl = -(nr - o.w); }
      if (west)  { nr =  o.w - nl; }
      if (south) { nt = -(nb - o.h); }
      if (north) { nb =  o.h - nt; }
    }

    // Don't allow degenerate sizes; flip handles when crossed.
    if (nr - nl < MIN_DIM) {
      if (east) nr = nl + MIN_DIM; else nl = nr - MIN_DIM;
    }
    if (nb - nt < MIN_DIM) {
      if (south) nb = nt + MIN_DIM; else nt = nb - MIN_DIM;
    }

    // Convert local rect (nl, nt, nr, nb) back to world coords. The shape's
    // original center stays put; the new center is shifted by the local
    // midpoint in the rotated frame.
    const newW = nr - nl;
    const newH = nb - nt;
    const localMidX = (nl + nr) / 2;
    const localMidY = (nt + nb) / 2;
    const oldMidX = o.w / 2;
    const oldMidY = o.h / 2;
    const dxLocal = localMidX - oldMidX;
    const dyLocal = localMidY - oldMidY;
    // Rotate (dxLocal, dyLocal) back into world.
    const cR = Math.cos(r), sR = Math.sin(r);
    const dxWorld = dxLocal * cR - dyLocal * sR;
    const dyWorld = dxLocal * sR + dyLocal * cR;
    const oldCx = o.x + o.w / 2;
    const oldCy = o.y + o.h / 2;
    const newCx = oldCx + dxWorld;
    const newCy = oldCy + dyWorld;
    s.w = Math.abs(newW);
    s.h = Math.abs(newH);
    s.x = newCx - s.w / 2;
    s.y = newCy - s.h / 2;
    if (s.type === 'rect') {
      // Re-clamp corner radius so it never exceeds half the shorter side.
      const maxR = Math.min(s.w, s.h) / 2;
      if ((s.cornerRadius || 0) > maxR) s.cornerRadius = maxR;
    }
  }

  function _applyGroupResize(op, dxC, dyC, e) {
    const bb = op.startBBox;
    const h = op.handle;
    const east  = h.includes('e');
    const west  = h.includes('w');
    const north = h.includes('n');
    const south = h.includes('s');
    let nx = bb.x, ny = bb.y, nw = bb.w, nh = bb.h;
    if (east)  nw = Math.max(MIN_DIM, bb.w + dxC);
    if (west)  { nw = Math.max(MIN_DIM, bb.w - dxC); nx = bb.x + (bb.w - nw); }
    if (south) nh = Math.max(MIN_DIM, bb.h + dyC);
    if (north) { nh = Math.max(MIN_DIM, bb.h - dyC); ny = bb.y + (bb.h - nh); }

    if (e.shiftKey) {
      const ar = bb.w / Math.max(1, bb.h);
      const sx = nw / bb.w, sy = nh / bb.h;
      const useX = Math.abs(sx - 1) > Math.abs(sy - 1);
      const sc = useX ? sx : sy;
      nw = bb.w * sc; nh = bb.h * sc;
      if (west)  nx = bb.x + (bb.w - nw); else nx = bb.x;
      if (north) ny = bb.y + (bb.h - nh); else ny = bb.y;
    }
    if (e.altKey) {
      // Scale around bbox center.
      const cx = bb.x + bb.w / 2, cy = bb.y + bb.h / 2;
      nx = cx - nw / 2; ny = cy - nh / 2;
    }

    const sx = nw / bb.w, sy = nh / bb.h;
    const sel = _selectedShapes(session.layer);
    sel.forEach((s, i) => {
      const o = op.startStates[i];
      if (s.type === 'line') {
        s.p1.x = nx + (o.p1.x - bb.x) * sx;
        s.p1.y = ny + (o.p1.y - bb.y) * sy;
        s.p2.x = nx + (o.p2.x - bb.x) * sx;
        s.p2.y = ny + (o.p2.y - bb.y) * sy;
      } else if (s.type === 'path') {
        const liveArrs = _pathPointArrays(s);
        const snapArrs = _snapPointArrays(o);
        for (let ai = 0; ai < liveArrs.length && ai < snapArrs.length; ai++) {
          const live = liveArrs[ai], snap = snapArrs[ai];
          for (let k = 0; k < snap.length && k < live.length; k++) {
            const sp = snap[k], lp = live[k];
            lp.x = nx + (sp.x - bb.x) * sx; lp.y = ny + (sp.y - bb.y) * sy;
            if (sp.ohx !== undefined) { lp.ohx = nx + (sp.ohx - bb.x) * sx; lp.ohy = ny + (sp.ohy - bb.y) * sy; }
            if (sp.ihx !== undefined) { lp.ihx = nx + (sp.ihx - bb.x) * sx; lp.ihy = ny + (sp.ihy - bb.y) * sy; }
          }
        }
      } else {
        s.x = nx + (o.x - bb.x) * sx;
        s.y = ny + (o.y - bb.y) * sy;
        s.w = Math.max(MIN_DIM, o.w * sx);
        s.h = Math.max(MIN_DIM, o.h * sy);
        if (s.type === 'rect') {
          const maxR = Math.min(s.w, s.h) / 2;
          if ((s.cornerRadius || 0) > maxR) s.cornerRadius = maxR;
        }
      }
    });
  }

  function _onDragUp(e) {
    if (!session || !session.dragOp) return;
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('mouseup', _onDragUp);
    const op = session.dragOp;
    session.dragOp = null;
    if (typeof SnapEngine !== 'undefined') SnapEngine.endSession();
    if (op.changed) {
      const labels = {
        'move': 'Move Shape',
        'resize': 'Transform Shape',
        'line-endpoint': 'Edit Line',
        'rotate': 'Rotate Shape',
        'corner-radius': 'Corner Radius',
        'group-resize': 'Transform Shapes',
        'group-rotate': 'Rotate Shapes'
      };
      if (typeof pushUndo === 'function') pushUndo(labels[op.kind] || 'Edit Shape');
      if (typeof updateLayerPanel === 'function') updateLayerPanel();
    }
    _renderHandles();
    // Drag-time sync was suppressed for perf; refresh the options bar /
    // properties panel now that the gesture has settled.
    _syncOptionsBarFromSelection();
  }

  // ── New-shape drawing flow ────────────────────────────────

  let _drawState = null; // { startCanvas, currentCanvas, kind, layer }

  function _beginDraw(canvasX, canvasY) {
    // Don't materialize the target layer yet — defer until commit so a
    // mis-click (no drag) doesn't leave an empty shape layer behind.
    _drawState = { start: { x: canvasX, y: canvasY }, current: { x: canvasX, y: canvasY }, kind: _activeShapeKind, layer: null };
  }

  function _addNewShapeLayerAbove() {
    const initial = { nextId: 1, selectedIds: new Set(), shapes: [] };
    return addShapeLayer(initial, true);
  }

  function _drawPreview() {
    if (!_drawState) return;
    if (typeof prepareOverlay !== 'function') return;
    prepareOverlay();
    const tmp = _buildShapeFromDraft(_drawState, { event: _drawState._event });
    if (!tmp) {
      if (typeof SnapEngine !== 'undefined') SnapEngine.drawIndicators(overlayCtx);
      return;
    }
    // Draft preview: just the green path outline — no fill/stroke/anchors/handles.
    // Fill & stroke materialize on commit. Drawn in screen-space at 1px so the
    // line stays crisp regardless of zoom.
    const dpr = window.devicePixelRatio || 1;
    overlayCtx.save();
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    overlayCtx.lineWidth = 1;
    overlayCtx.strokeStyle = '#4bff4b';
    overlayCtx.setLineDash([]);
    overlayCtx.beginPath();
    if (tmp.type === 'line') {
      const a = c2s(tmp.p1.x, tmp.p1.y);
      const b = c2s(tmp.p2.x, tmp.p2.y);
      overlayCtx.moveTo(a.x + 0.5, a.y + 0.5);
      overlayCtx.lineTo(b.x + 0.5, b.y + 0.5);
    } else if (tmp.type === 'rect') {
      const tl = c2s(tmp.x, tmp.y);
      const w = tmp.w * zoom, h = tmp.h * zoom;
      overlayCtx.rect(Math.round(tl.x) + 0.5, Math.round(tl.y) + 0.5, Math.round(w), Math.round(h));
    } else if (tmp.type === 'ellipse') {
      const cxs = (tmp.x + tmp.w / 2) * zoom + panX;
      const cys = (tmp.y + tmp.h / 2) * zoom + panY;
      overlayCtx.ellipse(cxs, cys, (tmp.w / 2) * zoom, (tmp.h / 2) * zoom, 0, 0, Math.PI * 2);
    }
    overlayCtx.stroke();
    overlayCtx.restore();
    if (typeof SnapEngine !== 'undefined') SnapEngine.drawIndicators(overlayCtx);
  }

  function _buildShapeFromDraft(d, opts) {
    if (!d) return null;
    const e = opts && opts.event;
    const sx = d.start.x, sy = d.start.y;
    let cx = d.current.x, cy = d.current.y;

    if (e && e.shiftKey && d.kind !== 'line') {
      // Square / circle constrained
      const dx = cx - sx, dy = cy - sy;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      cx = sx + Math.sign(dx || 1) * m;
      cy = sy + Math.sign(dy || 1) * m;
    }
    if (e && e.shiftKey && d.kind === 'line') {
      const dx = cx - sx, dy = cy - sy;
      const ang = Math.atan2(dy, dx);
      const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      cx = sx + Math.cos(snap) * len;
      cy = sy + Math.sin(snap) * len;
    }
    let x, y, w, h;
    if (e && e.altKey && d.kind !== 'line') {
      // Center anchor: start point is center; current is offset.
      const dx = Math.abs(cx - sx), dy = Math.abs(cy - sy);
      x = sx - dx; y = sy - dy; w = dx * 2; h = dy * 2;
    } else {
      x = Math.min(sx, cx); y = Math.min(sy, cy);
      w = Math.abs(cx - sx); h = Math.abs(cy - sy);
    }

    const fill = { ...(_activeFill) };
    const stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null };
    if (d.kind === 'line') {
      return { id: -1, type: 'line', p1: { x: sx, y: sy }, p2: { x: cx, y: cy }, rotation: 0, fill: { type:'none', color:'#000' }, stroke, opacity: _activeOpacity };
    }
    if (d.kind === 'rect') {
      return { id: -1, type: 'rect', x, y, w: Math.max(MIN_DIM, w), h: Math.max(MIN_DIM, h), rotation: 0, cornerRadius: _activeCornerRadius, fill, stroke, opacity: _activeOpacity };
    }
    if (d.kind === 'ellipse') {
      return { id: -1, type: 'ellipse', x, y, w: Math.max(MIN_DIM, w), h: Math.max(MIN_DIM, h), rotation: 0, fill, stroke, opacity: _activeOpacity };
    }
    return null;
  }

  function _commitDraw(e) {
    const d = _drawState;
    if (!d) return false;
    const tmp = _buildShapeFromDraft(d, { event: e });
    _drawState = null;
    if (typeof drawOverlay === 'function') drawOverlay();
    if (!tmp) return false;
    // Reject zero-size attempts (mis-clicks shouldn't create shapes or layers).
    if (tmp.type === 'line') {
      if (Math.hypot(tmp.p2.x - tmp.p1.x, tmp.p2.y - tmp.p1.y) < 1) return false;
    } else if (tmp.w < 1 || tmp.h < 1) return false;
    // Materialize the target layer NOW (deferred from _beginDraw).
    // Append to the active layer when it is already a shape layer; only a
    // non-shape active layer spawns a fresh shape layer above it.
    let layer = (typeof getActiveLayer === 'function') ? getActiveLayer() : null;
    if (!layer || layer.kind !== 'shape') {
      layer = _addNewShapeLayerAbove();
    }
    if (!layer.shapeModel) layer.shapeModel = { nextId: 1, selectedIds: new Set(), shapes: [] };
    _ensureSession(layer);
    tmp.id = layer.shapeModel.nextId++;
    layer.shapeModel.shapes.push(tmp);
    _setSelection(layer, [tmp.id]);
    renderShapeLayer(layer);
    if (typeof compositeAll === 'function') compositeAll();
    if (typeof updateLayerPanel === 'function') updateLayerPanel();
    if (typeof pushUndo === 'function') pushUndo('Add Shape');
    return true;
  }

  function _deleteSelected() {
    if (!session) return;
    const layer = session.layer;
    const ids = _ensureSelectedSet(layer);
    if (!ids.size) return;
    layer.shapeModel.shapes = layer.shapeModel.shapes.filter(s => !ids.has(s.id));
    ids.clear();
    renderShapeLayer(layer);
    if (typeof compositeAll === 'function') compositeAll();
    _renderHandles();
    _syncOptionsBarFromSelection();
    if (typeof pushUndo === 'function') pushUndo('Delete Shape');
  }

  function _duplicateSelected() {
    if (!session) return;
    const layer = session.layer;
    const ids = _ensureSelectedSet(layer);
    if (!ids.size) return;
    const offset = 12;
    layer.shapeModel.shapes.filter(s => ids.has(s.id)).forEach(s => {
      const cp = _cloneShape(s);
      if (cp.type === 'line') {
        cp.p1.x += offset; cp.p1.y += offset; cp.p2.x += offset; cp.p2.y += offset;
      } else if (cp.type === 'path') {
        (cp.points || []).forEach(p => {
          p.x += offset; p.y += offset;
          if (p.ohx !== undefined) { p.ohx += offset; p.ohy += offset; }
          if (p.ihx !== undefined) { p.ihx += offset; p.ihy += offset; }
        });
      } else {
        cp.x += offset; cp.y += offset;
      }
      cp.id = 1;
      const newLayer = addShapeLayer({ nextId: 2, selectedIds: new Set([1]), shapes: [cp] }, true);
      _ensureSession(newLayer);
      _setSelection(newLayer, [cp.id]);
      renderShapeLayer(newLayer);
    });
    if (typeof compositeAll === 'function') compositeAll();
    if (typeof updateLayerPanel === 'function') updateLayerPanel();
    if (typeof pushUndo === 'function') pushUndo('Duplicate Shape');
  }

  // ── Z-order within the layer (Order dropdown) ─────────────
  // shapes[] is painted in array order, so the LAST element is frontmost.
  // The selected shapes move as one block, preserving their relative order.

  function _orderSelInfo() {
    if (!session || !session.layer || !session.layer.shapeModel) return null;
    const arr = session.layer.shapeModel.shapes;
    if (!arr || !arr.length) return null;
    const ids = _ensureSelectedSet(session.layer);
    if (!ids.size) return null;
    const idxs = [];
    for (let i = 0; i < arr.length; i++) if (ids.has(arr[i].id)) idxs.push(i);
    if (!idxs.length) return null;
    return { arr, sel: new Set(arr.filter(s => ids.has(s.id))),
             minI: idxs[0], maxI: idxs[idxs.length - 1] };
  }

  function _reorderSelected(kind) {
    const info = _orderSelInfo();
    if (!info) return;
    const { arr, sel } = info;
    if (kind === 'front') {
      const keep = arr.filter(s => !sel.has(s));
      const move = arr.filter(s =>  sel.has(s));
      arr.length = 0; arr.push(...keep, ...move);
    } else if (kind === 'back') {
      const keep = arr.filter(s => !sel.has(s));
      const move = arr.filter(s =>  sel.has(s));
      arr.length = 0; arr.push(...move, ...keep);
    } else if (kind === 'forward') {
      for (let i = arr.length - 2; i >= 0; i--) {
        if (sel.has(arr[i]) && !sel.has(arr[i + 1])) {
          const t = arr[i]; arr[i] = arr[i + 1]; arr[i + 1] = t;
        }
      }
    } else if (kind === 'backward') {
      for (let i = 1; i < arr.length; i++) {
        if (sel.has(arr[i]) && !sel.has(arr[i - 1])) {
          const t = arr[i]; arr[i] = arr[i - 1]; arr[i - 1] = t;
        }
      }
    } else return;
    renderShapeLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _renderHandles();
    _refreshOrderControl();
    if (typeof pushUndo === 'function') pushUndo('Reorder Shape');
  }

  function _refreshOrderControl() {
    const menu = document.getElementById('shOrderMenu');
    if (!menu) return;
    const info = _orderSelInfo();
    const atFront = !info || info.maxI === info.arr.length - 1;
    const atBack  = !info || info.minI === 0;
    const dis = {
      front:    atFront, forward:  atFront,
      backward: atBack,  back:     atBack
    };
    menu.querySelectorAll('[data-order]').forEach(btn => {
      btn.disabled = !!dis[btn.dataset.order];
    });
  }

  function _wireOrderDropdown() {
    const btn  = document.getElementById('shOrderBtn');
    const menu = document.getElementById('shOrderMenu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('is-open');
      if (menu.classList.contains('is-open')) _refreshOrderControl();
    });
    menu.querySelectorAll('[data-order]').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.disabled) return;
        _reorderSelected(item.dataset.order);
        // Menu intentionally stays open so the user can step repeatedly.
      });
    });
    document.addEventListener('mousedown', (e) => {
      if (menu.classList.contains('is-open') &&
          !menu.contains(e.target) && e.target !== btn) {
        menu.classList.remove('is-open');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') menu.classList.remove('is-open');
    });
  }

  // ── Boolean combine (Pathfinder) ──────────────────────────
  // All combine logic lives in js/tools/combine.js (window.OpsinCombine).
  // ShapeTool only exposes the active layer + a selection setter (see the
  // public surface below); the dropdown wires/refreshes itself.

  // ── Right-click context menu ──────────────────────────────

  function _showContextMenu(e) {
    const m = document.getElementById('shapeCtxMenu');
    if (!m) return;
    e.preventDefault();
    m.hidden = false;
    const r = m.getBoundingClientRect();
    let x = e.clientX, y = e.clientY;
    if (x + r.width  > window.innerWidth)  x = window.innerWidth  - r.width  - 4;
    if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 4;
    m.style.left = x + 'px';
    m.style.top  = y + 'px';
    function close() {
      m.hidden = true;
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function away(ev) { if (!m.contains(ev.target)) close(); }
    function onKey(ev) { if (ev.key === 'Escape') close(); }
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', away, true);
      document.addEventListener('keydown', onKey, true);
    });
    m.querySelectorAll('[data-action]').forEach(btn => {
      btn.onclick = () => {
        close();
        const action = btn.dataset.action;
        if (action === 'duplicate') _duplicateSelected();
        else if (action === 'delete') _deleteSelected();
      };
    });
  }

  // ── Options bar wiring ────────────────────────────────────

  function _syncOptionsBarFromSelection() {
    if (_suppressOptionsSync) return;
    const sel = session ? _selectedShapes(session.layer) : [];
    const src = sel.length ? sel[0] : null;
    if (src) {
      _activeFill = { ...(src.fill || _activeFill) };
      _activeStroke = { ...(src.stroke || _activeStroke), dashPattern: src.stroke && src.stroke.dashPattern ? src.stroke.dashPattern.slice() : null };
      if (src.type === 'rect') _activeCornerRadius = src.cornerRadius || 0;
      _activeOpacity = src.opacity == null ? 1 : src.opacity;
    }
    _refreshChips();
    _refreshStrokeControls();
    _refreshDashControls();
    _refreshCornerRadiusControl();
    _refreshOpacityControl();
    _refreshOrderControl();
    if (window.OpsinCombine) window.OpsinCombine.refresh();
    _refreshShapePanel();
    if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
  }

  // Toggles the panel into shape-mode while preserving its outer footprint.
  // On first entry we capture the body's natural height (with the shape
  // section still hidden) into --props-panel-body-h. The CSS rule then
  // caps max-height to that value and turns on overflow scrolling, so the
  // panel never grows past the size it had before shape options appeared.
  function _setShapePanelMode(panel, on) {
    const wasOn = panel.classList.contains('is-shape-mode');
    if (on && !wasOn) {
      const body = panel.querySelector('.panel-body');
      if (body) {
        const h = body.offsetHeight;
        if (h > 0) panel.style.setProperty('--props-panel-body-h', h + 'px');
      }
      panel.classList.add('is-shape-mode');
    } else if (!on && wasOn) {
      panel.classList.remove('is-shape-mode');
      panel.style.removeProperty('--props-panel-body-h');
    }
  }

  // Drives the properties-panel-only state: empty-state veil, section
  // visibility, and disabled state of mirrored controls. Called whenever
  // selection changes or the shape tool activates/deactivates.
  function _refreshShapePanel() {
    const panel = document.getElementById('propertiesPanel');
    const section = document.getElementById('propsShapeSection');
    if (!panel || !section) return;
    const isShape = (typeof currentTool !== 'undefined' && (currentTool === 'shape' || (currentTool === 'pathselect' && _selectToolActive)));
    _setShapePanelMode(panel, isShape);
    section.hidden = !isShape;
    if (!isShape) return;
    const sel = session ? _selectedShapes(session.layer) : [];
    const has = sel.length > 0;
    section.classList.toggle('is-empty', !has);
    // Toggle disabled on every interactive control inside the section.
    section.querySelectorAll('input, button').forEach(el => {
      if (has) el.removeAttribute('disabled');
      else el.setAttribute('disabled', '');
    });
  }

  // Both options-bar and properties-panel mirrors share these refresh
  // helpers. Each lookup walks both sets of IDs ('sh*' = options bar,
  // 'psh*' = properties panel) so updates always happen in lockstep.
  function _refreshChips() {
    for (const id of ['shFillChip', 'pshFillChip']) {
      const fc = document.getElementById(id);
      if (!fc) continue;
      fc.style.backgroundColor = _activeFill.type === 'none' ? '' : _activeFill.color;
      fc.classList.toggle('is-none', _activeFill.type === 'none');
    }
    for (const id of ['shStrokeChip', 'pshStrokeChip']) {
      const sc = document.getElementById(id);
      if (!sc) continue;
      sc.style.color = _activeStroke.type === 'none' ? '' : _activeStroke.color;
      sc.classList.toggle('is-none', _activeStroke.type === 'none');
    }
  }

  function _refreshStrokeControls() {
    for (const id of ['shStrokeWidth', 'pshStrokeWidth']) {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) el.value = _activeStroke.width;
    }
    document.querySelectorAll('#shAlignGroup .opt-icon-btn, #pshAlignGroup .opt-icon-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.align === _activeStroke.align);
    });
    document.querySelectorAll('#shCapGroup .opt-icon-btn, #pshCapGroup .opt-icon-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.cap === _activeStroke.cap);
    });
    document.querySelectorAll('#shJoinGroup .opt-icon-btn, #pshJoinGroup .opt-icon-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.join === _activeStroke.join);
    });
  }

  function _refreshDashControls() {
    const p = _activeStroke.dashPattern || [0,0,0,0,0,0];
    const fieldIds = [
      ['shDash1','pshDash1'],
      ['shGap1', 'pshGap1'],
      ['shDash2','pshDash2'],
      ['shGap2', 'pshGap2'],
      ['shDash3','pshDash3'],
      ['shGap3', 'pshGap3']
    ];
    for (let i = 0; i < 6; i++) {
      for (const id of fieldIds[i]) {
        const el = document.getElementById(id);
        if (el && document.activeElement !== el) el.value = p[i] || 0;
      }
    }
    for (const id of ['shDashOffset', 'pshDashOffset']) {
      const off = document.getElementById(id);
      if (off && document.activeElement !== off) off.value = _activeStroke.dashOffset || 0;
    }
    for (const id of ['shDashPresetBtn', 'pshDashPresetBtn']) {
      const presetBtn = document.getElementById(id);
      if (!presetBtn) continue;
      const match = _matchDashPreset();
      presetBtn.textContent = match ? match.label : 'Custom';
    }
    // Show/hide the custom dash editor + offset based on whether the stroke
    // is Solid (no pattern) or any dashed type. Options bar uses .hidden;
    // properties panel uses [hidden] on a dedicated row container.
    const isSolid = !_activeStroke.dashPattern;
    const grid = document.getElementById('shDashGrid');
    const off  = document.getElementById('shDashOffset');
    const offLbl = document.getElementById('shDashOffsetLabel');
    if (grid)   grid.classList.toggle('hidden', isSolid);
    if (off)    off.classList.toggle('hidden', isSolid);
    if (offLbl) offLbl.classList.toggle('hidden', isSolid);
    const pshRow = document.getElementById('pshDashRow');
    if (pshRow) pshRow.hidden = isSolid;
  }

  function _matchDashPreset() {
    const p = _activeStroke.dashPattern;
    for (const preset of DASH_PRESETS) {
      if (preset.pattern === null && !p) return preset;
      if (preset.pattern && p && preset.pattern.length === p.length) {
        let ok = true;
        for (let i = 0; i < 6; i++) {
          if ((preset.pattern[i] || 0) !== (p[i] || 0)) { ok = false; break; }
        }
        if (ok) return preset;
      }
    }
    return null;
  }

  function _refreshCornerRadiusControl() {
    for (const id of ['shCornerRadius', 'pshCornerRadius']) {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) el.value = Math.round(_activeCornerRadius);
    }
    const sel = session ? _selectedShapes(session.layer) : [];
    const isRect = sel.length > 0 ? sel.every(s => s.type === 'rect') : (_activeShapeKind === 'rect');
    const grp = document.getElementById('opt-shape-corner');
    if (grp) grp.classList.toggle('hidden', !isRect);
    const pshRow = document.getElementById('pshCornerRow');
    if (pshRow) pshRow.hidden = !isRect;
  }

  function _refreshOpacityControl() {
    const range = document.getElementById('toolOpacity');
    const num = document.getElementById('toolOpacityNum');
    const v = Math.round(_activeOpacity * 100);
    if (range) range.value = v;
    if (num) num.value = v;
  }

  // Apply a setter to the current selection (or update defaults if no selection).
  function _applyToSelection(mutator, undoLabel) {
    if (!session) return;
    const sel = _selectedShapes(session.layer);
    if (sel.length === 0) return;
    sel.forEach(s => mutator(s));
    renderShapeLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _renderHandles();
    if (typeof pushUndo === 'function' && undoLabel) pushUndo(undoLabel);
  }

  function _setFillFromHex(hex) {
    _activeFill = { type: 'solid', color: hex };
    _refreshChips();
    _applyToSelection(s => { if (s.type !== 'line') s.fill = { ..._activeFill }; }, 'Change Fill');
  }
  function _setStrokeFromHex(hex) {
    _activeStroke.color = hex;
    _activeStroke.type = 'solid';
    _refreshChips();
    _applyToSelection(s => { s.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null }; }, 'Change Stroke');
  }
  function _toggleFillNone() {
    _activeFill = (_activeFill.type === 'none')
      ? { type: 'solid', color: _activeFill.color || '#5b8def' }
      : { type: 'none',  color: _activeFill.color || '#000' };
    _refreshChips();
    _applyToSelection(s => { if (s.type !== 'line') s.fill = { ..._activeFill }; }, 'Change Fill');
  }
  function _toggleStrokeNone() {
    _activeStroke.type = (_activeStroke.type === 'none') ? 'solid' : 'none';
    _refreshChips();
    _applyToSelection(s => { s.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null }; }, 'Change Stroke');
  }
  function _swapFillStroke() {
    if (_activeStroke.type === 'none' && _activeFill.type === 'none') return;
    const fc = _activeFill.color, ft = _activeFill.type;
    _activeFill = { type: _activeStroke.type === 'none' ? 'none' : 'solid', color: _activeStroke.color };
    _activeStroke.color = fc;
    _activeStroke.type  = ft === 'none' ? 'none' : 'solid';
    _refreshChips();
    _applyToSelection(s => {
      // Lines have no fill area; swapping would clobber the stroke color
      // with the line's placeholder 'none' fill. Leave lines untouched.
      if (s.type === 'line') return;
      const oldFill = s.fill, oldStroke = s.stroke;
      s.fill = { type: oldStroke && oldStroke.type === 'none' ? 'none' : 'solid', color: oldStroke ? oldStroke.color : '#000' };
      s.stroke = { ...(oldStroke || _activeStroke), color: oldFill ? oldFill.color : '#000', type: oldFill && oldFill.type === 'none' ? 'none' : 'solid', dashPattern: oldStroke && oldStroke.dashPattern ? oldStroke.dashPattern.slice() : null };
    }, 'Swap Fill/Stroke');
  }

  // Helper: run fn on every existing element matching any of the given IDs.
  function _eachId(ids, fn) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) fn(el);
    }
  }

  function _wireOptionsBar() {
    // Fill / stroke chip buttons (open color picker, swap, none-toggle).
    _eachId(['shFillBtn',   'pshFillBtn'],   el => el.addEventListener('click', (e) => { e.stopPropagation(); _openColorPicker('fill'); }));
    _eachId(['shStrokeBtn', 'pshStrokeBtn'], el => el.addEventListener('click', (e) => { e.stopPropagation(); _openColorPicker('stroke'); }));
    _eachId(['shSwapBtn',   'pshSwapBtn'],   el => el.addEventListener('click', _swapFillStroke));
    _eachId(['shFillNoneBtn',   'pshFillNoneBtn'],   el => el.addEventListener('click', _toggleFillNone));
    _eachId(['shStrokeNoneBtn', 'pshStrokeNoneBtn'], el => el.addEventListener('click', _toggleStrokeNone));

    // Stroke width — both inputs feed the shared _activeStroke.width.
    _eachId(['shStrokeWidth', 'pshStrokeWidth'], el => {
      el.addEventListener('input', () => {
        const v = Math.max(0, +el.value || 0);
        _activeStroke.width = v;
        // Mirror the value to the other field without echoing input events.
        for (const otherId of ['shStrokeWidth', 'pshStrokeWidth']) {
          const o = document.getElementById(otherId);
          if (o && o !== el && document.activeElement !== o) o.value = v;
        }
        _applyToSelection(s => { s.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null }; }, 'Stroke Width');
      });
    });

    // Alignment / cap / join — single delegated query unions both groups.
    document.querySelectorAll('#shAlignGroup .opt-icon-btn, #pshAlignGroup .opt-icon-btn').forEach(b => {
      b.addEventListener('click', () => {
        _activeStroke.align = b.dataset.align;
        _refreshStrokeControls();
        _applyToSelection(s => { s.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null }; }, 'Stroke Alignment');
      });
    });
    document.querySelectorAll('#shCapGroup .opt-icon-btn, #pshCapGroup .opt-icon-btn').forEach(b => {
      b.addEventListener('click', () => {
        _activeStroke.cap = b.dataset.cap;
        _refreshStrokeControls();
        _applyToSelection(s => { s.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null }; }, 'Stroke Cap');
      });
    });
    document.querySelectorAll('#shJoinGroup .opt-icon-btn, #pshJoinGroup .opt-icon-btn').forEach(b => {
      b.addEventListener('click', () => {
        _activeStroke.join = b.dataset.join;
        _refreshStrokeControls();
        _applyToSelection(s => { s.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null }; }, 'Stroke Join');
      });
    });

    // Dash editor — 6 (dash, gap) fields, paired across both UIs.
    const dashPairs = [
      ['shDash1','pshDash1'], ['shGap1','pshGap1'],
      ['shDash2','pshDash2'], ['shGap2','pshGap2'],
      ['shDash3','pshDash3'], ['shGap3','pshGap3']
    ];
    dashPairs.forEach((pair, i) => {
      pair.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
          if (!_activeStroke.dashPattern) _activeStroke.dashPattern = [0,0,0,0,0,0];
          _activeStroke.dashPattern[i] = Math.max(0, +el.value || 0);
          if (_activeStroke.dashPattern.every(v => !v)) _activeStroke.dashPattern = null;
          // Mirror to the paired field.
          const other = document.getElementById(pair[0] === id ? pair[1] : pair[0]);
          if (other && document.activeElement !== other) other.value = el.value;
          // Update preset label on both buttons.
          for (const pid of ['shDashPresetBtn','pshDashPresetBtn']) {
            const pb = document.getElementById(pid);
            if (pb) { const m = _matchDashPreset(); pb.textContent = m ? m.label : 'Custom'; }
          }
          _applyToSelection(s => { s.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null }; }, 'Stroke Dash');
        });
      });
    });
    _eachId(['shDashOffset', 'pshDashOffset'], el => {
      el.addEventListener('input', () => {
        _activeStroke.dashOffset = +el.value || 0;
        for (const otherId of ['shDashOffset','pshDashOffset']) {
          const o = document.getElementById(otherId);
          if (o && o !== el && document.activeElement !== o) o.value = el.value;
        }
        _applyToSelection(s => { s.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null }; }, 'Dash Offset');
      });
    });

    // Dash preset dropdown — wire each (button + menu) pair separately.
    const presetPairs = [
      ['shDashPresetBtn', 'shDashPresetMenu'],
      ['pshDashPresetBtn','pshDashPresetMenu']
    ];
    presetPairs.forEach(([btnId, menuId]) => {
      const presetBtn  = document.getElementById(btnId);
      const presetMenu = document.getElementById(menuId);
      if (!presetBtn || !presetMenu) return;
      presetMenu.innerHTML = '';
      for (const p of DASH_PRESETS) {
        const item = document.createElement('div');
        item.className = 'sh-preset-item';
        item.dataset.preset = p.id;
        item.innerHTML = `<span class="sh-preset-label">${p.label}</span><span class="sh-preset-stroke"><span class="sh-preset-stroke-line" style="background:${p.pattern ? _previewDashCss(p.pattern) : '#fff'}"></span></span>`;
        item.addEventListener('click', () => {
          _activeStroke.dashPattern = p.pattern ? p.pattern.slice() : null;
          // Update both preset buttons' labels.
          for (const pid of ['shDashPresetBtn','pshDashPresetBtn']) {
            const pb = document.getElementById(pid);
            if (pb) pb.textContent = p.label;
          }
          presetMenu.classList.remove('is-open');
          _refreshDashControls();
          _applyToSelection(s => { s.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null }; }, 'Stroke Dash');
        });
        presetMenu.appendChild(item);
      }
      presetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Close the *other* menu first if open.
        for (const otherMenuId of ['shDashPresetMenu','pshDashPresetMenu']) {
          if (otherMenuId !== menuId) {
            const m = document.getElementById(otherMenuId);
            if (m) m.classList.remove('is-open');
          }
        }
        presetMenu.classList.toggle('is-open');
      });
      document.addEventListener('mousedown', (e) => {
        if (presetMenu.classList.contains('is-open') && !presetMenu.contains(e.target) && e.target !== presetBtn) {
          presetMenu.classList.remove('is-open');
        }
      });
    });

    // Corner radius — both inputs share _activeCornerRadius.
    _eachId(['shCornerRadius', 'pshCornerRadius'], el => {
      el.addEventListener('input', () => {
        _activeCornerRadius = Math.max(0, +el.value || 0);
        for (const otherId of ['shCornerRadius','pshCornerRadius']) {
          const o = document.getElementById(otherId);
          if (o && o !== el && document.activeElement !== o) o.value = el.value;
        }
        _applyToSelection(s => {
          if (s.type !== 'rect') return;
          const maxR = Math.min(s.w, s.h) / 2;
          s.cornerRadius = Math.min(_activeCornerRadius, maxR);
        }, 'Corner Radius');
      });
    });

    // Opacity (shared toolOpacity range — single instance).
    const opR = document.getElementById('toolOpacity');
    function _onOp() {
      _activeOpacity = Math.max(0.01, Math.min(1, (+opR.value || 100) / 100));
      _applyToSelection(s => { s.opacity = _activeOpacity; }, 'Shape Opacity');
    }
    if (opR) opR.addEventListener('input', () => {
      if ((typeof currentTool === 'undefined') || currentTool !== 'shape') return;
      _onOp();
    });

    _wireOrderDropdown();
    if (window.OpsinCombine) window.OpsinCombine.wire();
  }

  function _previewDashCss(p) {
    // Build a tiny CSS gradient that previews the dash pattern as a thin bar.
    const segs = [];
    for (let i = 0; i < p.length; i += 2) {
      const dash = +p[i] || 0;
      const gap  = +p[i + 1] || 0;
      if (dash > 0) segs.push({ on: true, len: dash });
      if (gap  > 0) segs.push({ on: false, len: gap });
    }
    if (!segs.length) return '#fff';
    // Compute fractional widths
    const total = segs.reduce((a, b) => a + b.len, 0);
    const stops = [];
    let acc = 0;
    for (const s of segs) {
      const start = (acc / total) * 100;
      acc += s.len;
      const end = (acc / total) * 100;
      stops.push(`${s.on ? '#fff' : 'transparent'} ${start}%`, `${s.on ? '#fff' : 'transparent'} ${end}%`);
    }
    return `linear-gradient(to right, ${stops.join(',')})`;
  }

  // ── Color picker iframe integration ───────────────────────

  function _openColorPicker(target) {
    _colorTarget = target;
    if (typeof toggleColorPicker !== 'function') return;
    // Reuse the shared iframe; seed from the field we're editing.
    const seed = (target === 'fill') ? (_activeFill.color || '#ffffff') : (_activeStroke.color || '#000000');
    window._shAwaitingColor = target;
    window._pngPickerSeedHex = seed;
    toggleColorPicker();
  }

  // Listen for color-picker iframe messages while in shape-color mode.
  window.addEventListener('message', (e) => {
    if (!e.data || !window._shAwaitingColor) return;
    if (e.data.action === 'cancel') {
      window._shAwaitingColor = null;
      return;
    }
    if (e.data.action !== 'confirm') return;
    const target = window._shAwaitingColor;
    window._shAwaitingColor = null;
    const hex = e.data.hex;
    if (!hex) return;
    if (target === 'fill') _setFillFromHex(hex);
    else if (target === 'stroke') _setStrokeFromHex(hex);
  });

  // ── Rasterize confirmation modal ──────────────────────────

  function requireRasterize(layer, toolName) {
    return new Promise((resolve) => {
      if (!layer || layer.kind !== 'shape') { resolve(true); return; }
      const overlay = document.getElementById('shRasterizeModal');
      const nameEl = document.getElementById('shRasterizeToolName');
      const okBtn  = document.getElementById('shRasterizeConfirm');
      const noBtn  = document.getElementById('shRasterizeCancel');
      if (!overlay) { resolve(false); return; }
      nameEl.textContent = toolName || 'this';
      overlay.hidden = false;

      function cleanup() {
        overlay.hidden = true;
        okBtn.removeEventListener('click', onOk);
        noBtn.removeEventListener('click', onNo);
        overlay.removeEventListener('mousedown', onBackdrop);
        document.removeEventListener('keydown', onKey);
      }
      function onOk() {
        cleanup();
        if (session && session.layer === layer) endEdit(true);
        rasterizeShapeLayer(layer);
        if (typeof compositeAll === 'function') compositeAll();
        if (typeof pushUndo === 'function') pushUndo('Rasterize Shape');
        if (typeof updateLayerPanel === 'function') updateLayerPanel();
        resolve(true);
      }
      function onNo() { cleanup(); resolve(false); }
      function onBackdrop(ev) { if (ev.target === overlay) onNo(); }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); onNo(); }
        else if (ev.key === 'Enter') { ev.preventDefault(); onOk(); }
      }
      okBtn.addEventListener('click', onOk);
      noBtn.addEventListener('click', onNo);
      overlay.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }

  // ── Tool registration ─────────────────────────────────────

  ToolRegistry.register('shape', {
    activate() {
      const ids = ['opt-shape-fill','opt-shape-stroke','opt-shape-stroke-style','opt-shape-dash','opt-shape-corner','opt-shape-order','opt-shape-combine','opt-opacity'];
      ids.forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); });
      // Hide legacy fill-mode + simple stroke-width controls (drawingTools era).
      const old1 = document.getElementById('opt-fill-mode'); if (old1) old1.classList.add('hidden');
      const old2 = document.getElementById('opt-stroke-width'); if (old2) old2.classList.add('hidden');
      workspace.style.cursor = 'crosshair';
      // Re-attach a session for the active shape layer so the persistent
      // selection (carried over from Move / Pen / Direct Selection) renders
      // its handles immediately, before the user clicks anything.
      const _activeLayer = (typeof layers !== 'undefined' && typeof activeLayerIndex !== 'undefined')
        ? layers[activeLayerIndex] : null;
      if (_activeLayer && _activeLayer.kind === 'shape') {
        // Entering a multi-path layer selects nothing; only a selection
        // carried over from Move / Pen / Direct Selection is preserved.
        _ensureSession(_activeLayer);
      }
      _syncOptionsBarFromSelection();
      _refreshShapePanel();
      if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
    },
    deactivate() {
      if (session) endEdit(true);
      const ids = ['opt-shape-fill','opt-shape-stroke','opt-shape-stroke-style','opt-shape-dash','opt-shape-corner','opt-shape-order','opt-shape-combine'];
      ids.forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
      // Force the properties-panel shape section closed — toolbar.js
      // calls deactivate while currentTool is still 'shape', so we
      // can't rely on _refreshShapePanel reading currentTool here.
      const panel = document.getElementById('propertiesPanel');
      const section = document.getElementById('propsShapeSection');
      if (panel) _setShapePanelMode(panel, false);
      if (section) section.hidden = true;
      if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
    },
    mouseDown(e, pos) {
      if (e.button === 2) {
        // Right-click on a shape selects it, then opens context menu.
        const hit = _hitAcrossLayers(pos.x, pos.y);
        if (hit) {
          if (typeof activeLayerIndex !== 'undefined') {
            window.activeLayerIndex = hit.layerIndex;
            selectedLayers = new Set([hit.layerIndex]);
          }
          _ensureSession(layers[hit.layerIndex]);
          if (!_ensureSelectedSet(session.layer).has(hit.shape.id)) {
            _setSelection(session.layer, [hit.shape.id]);
          }
          _showContextMenu(e);
          return true;
        }
        return false;
      }
      if (e.button !== 0) return false;
      // Hit existing shape?
      const hit = _hitAcrossLayers(pos.x, pos.y);
      if (hit) {
        // Auto-switch to the hit layer.
        if (typeof activeLayerIndex !== 'undefined' && activeLayerIndex !== hit.layerIndex) {
          window.activeLayerIndex = hit.layerIndex;
          selectedLayers = new Set([hit.layerIndex]);
          if (typeof updateLayerPanel === 'function') updateLayerPanel();
        }
        _ensureSession(layers[hit.layerIndex]);
        if (!_ensureSelectedSet(session.layer).has(hit.shape.id)) {
          _setSelection(session.layer, [hit.shape.id]);
        }
        // Begin move drag.
        _beginMoveDrag(e);
        return true;
      }
      // Empty space → start drawing a new shape.
      if (session) _clearSelection(session.layer);
      // Begin a snap session for the shape-draw and snap the start point too,
      // so the first corner anchors to guides / canvas / other layers.
      if (typeof SnapEngine !== 'undefined') {
        const excl = new Set();
        SnapEngine.beginSession({ excludeLayerIds: excl, excludeSelection: true });
      }
      const _spStart = (typeof SnapEngine !== 'undefined')
        ? SnapEngine.snapPoint({ x: pos.x, y: pos.y }, { modifiers: e })
        : { x: pos.x, y: pos.y };
      _beginDraw(_spStart.x, _spStart.y);
      return true;
    },
    mouseMove(e, pos) {
      if (_drawState) {
        const _sps = (typeof SnapEngine !== 'undefined') ? SnapEngine.snapPoint({ x: pos.x, y: pos.y }, { modifiers: e }) : pos;
        _drawState.current = { x: _sps.x, y: _sps.y };
        _drawState._event = e; // must be set BEFORE _drawPreview so this frame's
                               // shift/alt modifiers are honored, not last frame's.
        _drawPreview();
        return true;
      }
      return false;
    },
    mouseUp(e, pos) {
      if (_drawState) {
        _commitDraw(e);
        if (typeof SnapEngine !== 'undefined') SnapEngine.endSession();
        if (typeof drawOverlay === 'function') drawOverlay();
        return true;
      }
      return false;
    }
  });

  // ── Hooks for other tools / app-wide events ──────────────

  function setActiveShapeType(t) {
    if (t === 'rect' || t === 'ellipse' || t === 'line') {
      _activeShapeKind = t;
      _refreshCornerRadiusControl();
    }
  }
  function getActiveShapeType() { return _activeShapeKind; }

  function onZoomChange() {
    // Call _renderHandlesNow() directly (not via RAF) so the DOM overlay
    // updates in the same synchronous call as the CSS transform in updateTransform().
    // If we used the RAF path, the compositor can flush the CSS scale to screen
    // one frame ahead of the DOM handle positions, making handles lag behind.
    if (session) _renderHandlesNow();
  }

  function hitTestAndSelect(x, y) {
    const hit = _hitAcrossLayers(x, y);
    if (!hit) return false;
    if (typeof activeLayerIndex !== 'undefined' && activeLayerIndex !== hit.layerIndex) {
      window.activeLayerIndex = hit.layerIndex;
      selectedLayers = new Set([hit.layerIndex]);
      if (typeof updateLayerPanel === 'function') updateLayerPanel();
    }
    _ensureSession(layers[hit.layerIndex]);
    _setSelection(session.layer, [hit.shape.id]);
    return true;
  }

  function updateHover(x, y) {
    if (session && session.dragOp) return;
    // (We could draw a hover outline here; intentionally minimal for now.)
  }
  function clearHover() {}

  // Keyboard shortcuts within an active shape session.
  document.addEventListener('keydown', (e) => {
    if (!session) return;
    if (typeof currentTool !== 'undefined' && currentTool !== 'shape' && !(currentTool === 'pathselect' && _selectToolActive)) return;
    const tag = (e.target && e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      _deleteSelected();
    } else if (e.key === 'Escape') {
      _clearSelection(session.layer);
    }
  });

  // ── Public bounds + transform API (drives Properties panel) ─

  function _selectionList() {
    return session ? _selectedShapes(session.layer) : [];
  }
  function hasSelection() { return _selectionList().length > 0; }
  function getSelectionCount() { return _selectionList().length; }

  // Returns { x, y, w, h, rotation }; rotation is null for multi-select
  // and for line shapes (no panel rotation field).
  function getSelectedBounds() {
    const sel = _selectionList();
    if (!sel.length) return null;
    if (sel.length === 1) {
      const s = sel[0];
      if (s.type === 'line') {
        const x = Math.min(s.p1.x, s.p2.x);
        const y = Math.min(s.p1.y, s.p2.y);
        const w = Math.abs(s.p2.x - s.p1.x);
        const h = Math.abs(s.p2.y - s.p1.y);
        return { x, y, w, h, rotation: null, kind: 'line' };
      }
      if (s.type === 'path') {
        const bb = _shapeBBox(s);
        return { x: bb.x, y: bb.y, w: bb.w, h: bb.h, rotation: null, kind: 'path' };
      }
      return {
        x: s.x, y: s.y, w: s.w, h: s.h,
        rotation: ((s.rotation || 0) * 180 / Math.PI),
        kind: s.type
      };
    }
    const bb = _selectionBBox(sel);
    return { x: bb.x, y: bb.y, w: bb.w, h: bb.h, rotation: null, kind: 'group' };
  }

  function setSelectedBoundsField(field, value) {
    const sel = _selectionList();
    if (!sel.length || !session) return false;
    const num = +value;
    if (!isFinite(num)) return false;

    if (sel.length === 1) {
      const s = sel[0];
      if (s.type === 'line') {
        // x/y translate; w/h adjust the second endpoint while keeping p1.
        if (field === 'x') {
          const dx = num - Math.min(s.p1.x, s.p2.x);
          s.p1.x += dx; s.p2.x += dx;
        } else if (field === 'y') {
          const dy = num - Math.min(s.p1.y, s.p2.y);
          s.p1.y += dy; s.p2.y += dy;
        } else if (field === 'w') {
          const minX = Math.min(s.p1.x, s.p2.x);
          if (s.p1.x <= s.p2.x) s.p2.x = minX + Math.max(0, num);
          else s.p1.x = minX + Math.max(0, num);
        } else if (field === 'h') {
          const minY = Math.min(s.p1.y, s.p2.y);
          if (s.p1.y <= s.p2.y) s.p2.y = minY + Math.max(0, num);
          else s.p1.y = minY + Math.max(0, num);
        }
      } else if (s.type === 'path') {
        const bb = _shapeBBox(s);
        if (field === 'x')      _translateShape(s, num - bb.x, 0);
        else if (field === 'y') _translateShape(s, 0, num - bb.y);
        else if (field === 'w' && bb.w > 1e-6) _scaleShape(s, Math.max(0.001, num) / bb.w, 1, bb.x, bb.y);
        else if (field === 'h' && bb.h > 1e-6) _scaleShape(s, 1, Math.max(0.001, num) / bb.h, bb.x, bb.y);
      } else {
        if (field === 'x') s.x = num;
        else if (field === 'y') s.y = num;
        else if (field === 'w') s.w = Math.max(1, num);
        else if (field === 'h') s.h = Math.max(1, num);
        else if (field === 'rotation') s.rotation = (num % 360) * Math.PI / 180;
      }
    } else {
      // Group: x/y translate everyone; w/h scale around top-left.
      const bb = _selectionBBox(sel);
      if (field === 'x') {
        const dx = num - bb.x;
        sel.forEach(s => _translateShape(s, dx, 0));
      } else if (field === 'y') {
        const dy = num - bb.y;
        sel.forEach(s => _translateShape(s, 0, dy));
      } else if (field === 'w') {
        const sc = Math.max(0.001, num) / Math.max(1e-6, bb.w);
        sel.forEach(s => _scaleShape(s, sc, 1, bb.x, bb.y));
      } else if (field === 'h') {
        const sc = Math.max(0.001, num) / Math.max(1e-6, bb.h);
        sel.forEach(s => _scaleShape(s, 1, sc, bb.x, bb.y));
      } else if (field === 'rotation') {
        return false; // not supported for groups in panel
      }
    }
    renderShapeLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _renderHandles();
    if (typeof pushUndo === 'function') {
      const labels = { x:'Move Shape', y:'Move Shape', w:'Resize Shape', h:'Resize Shape', rotation:'Rotate Shape' };
      pushUndo(labels[field] || 'Edit Shape');
    }
    return true;
  }

  function _translateShape(s, dx, dy) {
    if (s.type === 'line') { s.p1.x += dx; s.p1.y += dy; s.p2.x += dx; s.p2.y += dy; }
    else if (s.type === 'path') {
      for (const pts of _pathPointArrays(s)) for (const p of pts) {
        p.x += dx; p.y += dy;
        if (p.ohx !== undefined) { p.ohx += dx; p.ohy += dy; }
        if (p.ihx !== undefined) { p.ihx += dx; p.ihy += dy; }
      }
    } else { s.x += dx; s.y += dy; }
  }

  function _scaleShape(s, sx, sy, ax, ay) {
    if (s.type === 'line') {
      s.p1.x = ax + (s.p1.x - ax) * sx; s.p1.y = ay + (s.p1.y - ay) * sy;
      s.p2.x = ax + (s.p2.x - ax) * sx; s.p2.y = ay + (s.p2.y - ay) * sy;
    } else if (s.type === 'path') {
      for (const pts of _pathPointArrays(s)) for (const p of pts) {
        p.x = ax + (p.x - ax) * sx; p.y = ay + (p.y - ay) * sy;
        if (p.ohx !== undefined) { p.ohx = ax + (p.ohx - ax) * sx; p.ohy = ay + (p.ohy - ay) * sy; }
        if (p.ihx !== undefined) { p.ihx = ax + (p.ihx - ax) * sx; p.ihy = ay + (p.ihy - ay) * sy; }
      }
    } else {
      s.x = ax + (s.x - ax) * sx; s.w *= sx;
      s.y = ay + (s.y - ay) * sy; s.h *= sy;
    }
  }

  function flipSelected(axis) {
    const sel = _selectionList();
    if (!sel.length || !session) return false;
    const bb = sel.length === 1 ? null : _selectionBBox(sel);
    sel.forEach(s => _flipShape(s, axis, bb));
    renderShapeLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _renderHandles();
    _syncOptionsBarFromSelection();
    if (typeof pushUndo === 'function') pushUndo(axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical');
    return true;
  }

  function _flipShape(s, axis, groupBB) {
    if (s.type === 'line') {
      if (groupBB) {
        if (axis === 'h') {
          s.p1.x = groupBB.x + groupBB.w - (s.p1.x - groupBB.x);
          s.p2.x = groupBB.x + groupBB.w - (s.p2.x - groupBB.x);
        } else {
          s.p1.y = groupBB.y + groupBB.h - (s.p1.y - groupBB.y);
          s.p2.y = groupBB.y + groupBB.h - (s.p2.y - groupBB.y);
        }
      } else {
        if (axis === 'h') { const tmp = s.p1.x; s.p1.x = s.p2.x; s.p2.x = tmp; }
        else              { const tmp = s.p1.y; s.p1.y = s.p2.y; s.p2.y = tmp; }
      }
      return;
    }
    if (s.type === 'path') {
      const bb = groupBB || _shapeBBox(s);
      for (const pts of _pathPointArrays(s)) for (const p of pts) {
        if (axis === 'h') {
          p.x = bb.x + bb.w - (p.x - bb.x);
          if (p.ohx !== undefined) p.ohx = bb.x + bb.w - (p.ohx - bb.x);
          if (p.ihx !== undefined) p.ihx = bb.x + bb.w - (p.ihx - bb.x);
        } else {
          p.y = bb.y + bb.h - (p.y - bb.y);
          if (p.ohy !== undefined) p.ohy = bb.y + bb.h - (p.ohy - bb.y);
          if (p.ihy !== undefined) p.ihy = bb.y + bb.h - (p.ihy - bb.y);
        }
      }
      return;
    }
    if (groupBB) {
      if (axis === 'h') s.x = groupBB.x + groupBB.w - (s.x - groupBB.x) - s.w;
      else              s.y = groupBB.y + groupBB.h - (s.y - groupBB.y) - s.h;
    }
    // Mirror shape's own rotation across the flip axis.
    if (s.rotation) s.rotation = -s.rotation;
  }

  function alignSelectedToCanvas(align) {
    const sel = _selectionList();
    if (!sel.length || !session) return false;
    const cw = (typeof canvasW !== 'undefined') ? canvasW : 0;
    const ch = (typeof canvasH !== 'undefined') ? canvasH : 0;
    if (sel.length === 1) {
      _alignShapeToCanvas(sel[0], align, cw, ch);
    } else {
      // Align the group AABB to canvas, translate every shape by the same delta.
      const bb = _selectionBBox(sel);
      let dx = 0, dy = 0;
      if (align === 'l') dx = 0 - bb.x;
      else if (align === 'r') dx = cw - (bb.x + bb.w);
      else if (align === 'ch') dx = (cw - bb.w) / 2 - bb.x;
      else if (align === 't') dy = 0 - bb.y;
      else if (align === 'b') dy = ch - (bb.y + bb.h);
      else if (align === 'cv') dy = (ch - bb.h) / 2 - bb.y;
      sel.forEach(s => _translateShape(s, dx, dy));
    }
    renderShapeLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _renderHandles();
    if (typeof pushUndo === 'function') pushUndo('Align Shape');
    return true;
  }

  function _alignShapeToCanvas(s, align, cw, ch) {
    const bb = _rotatedAabb(s);
    let dx = 0, dy = 0;
    if (align === 'l') dx = 0 - bb.x;
    else if (align === 'r') dx = cw - (bb.x + bb.w);
    else if (align === 'ch') dx = (cw - bb.w) / 2 - bb.x;
    else if (align === 't') dy = 0 - bb.y;
    else if (align === 'b') dy = ch - (bb.y + bb.h);
    else if (align === 'cv') dy = (ch - bb.h) / 2 - bb.y;
    _translateShape(s, dx, dy);
  }

  // ── Path conversion + anchor accessors (used by Direct Selection) ─

  // Mutates `s` in place so callers retain their reference. Rect/ellipse
  // becomes a closed path with rotation baked into the point coords; line
  // becomes an open 2-point path.
  function convertShapeToPath(s) {
    if (!s || s.type === 'path') return;
    const points = [];
    let closed = true;
    if (s.type === 'rect') {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const r = s.rotation || 0;
      const cR = Math.cos(r), sR = Math.sin(r);
      const local = (lx, ly) => ({ x: cx + lx * cR - ly * sR, y: cy + lx * sR + ly * cR });
      const hw = s.w / 2, hh = s.h / 2;
      points.push(local(-hw, -hh));
      points.push(local( hw, -hh));
      points.push(local( hw,  hh));
      points.push(local(-hw,  hh));
    } else if (s.type === 'ellipse') {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const r = s.rotation || 0;
      const cR = Math.cos(r), sR = Math.sin(r);
      const abs = (lx, ly) => ({ x: cx + lx * cR - ly * sR, y: cy + lx * sR + ly * cR });
      const hw = s.w / 2, hh = s.h / 2;
      const k = 0.5522847498;
      // 4 cubic-bezier anchor points at cardinal positions (N/E/S/W) with
      // symmetric smooth handles — approximates the ellipse within 0.03%.
      const N = abs(0, -hh), E = abs(hw, 0), S = abs(0, hh), W = abs(-hw, 0);
      points.push({ ...N, type: 'symmetric', ohx: abs( k*hw, -hh).x, ohy: abs( k*hw, -hh).y, ihx: abs(-k*hw, -hh).x, ihy: abs(-k*hw, -hh).y });
      points.push({ ...E, type: 'symmetric', ohx: abs(  hw, k*hh).x, ohy: abs(  hw, k*hh).y, ihx: abs(  hw,-k*hh).x, ihy: abs(  hw,-k*hh).y });
      points.push({ ...S, type: 'symmetric', ohx: abs(-k*hw,  hh).x, ohy: abs(-k*hw,  hh).y, ihx: abs( k*hw,  hh).x, ihy: abs( k*hw,  hh).y });
      points.push({ ...W, type: 'symmetric', ohx: abs( -hw,-k*hh).x, ohy: abs( -hw,-k*hh).y, ihx: abs( -hw, k*hh).x, ihy: abs( -hw, k*hh).y });
    } else if (s.type === 'line') {
      points.push({ x: s.p1.x, y: s.p1.y });
      points.push({ x: s.p2.x, y: s.p2.y });
      closed = false;
    } else {
      return;
    }

    // Rebuild s in place: drop type-specific props, install path props.
    delete s.x; delete s.y; delete s.w; delete s.h;
    delete s.cornerRadius; delete s.p1; delete s.p2;
    s.type = 'path';
    s.rotation = 0;
    s.points = points;
    s.closed = closed;
  }

  // Returns world-space anchor positions for the shape's editable points.
  // Each entry: { x, y, key } — keys are stable per shape kind.
  function getShapeAnchors(s) {
    if (!s) return [];
    if (s.type === 'rect') {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const r = s.rotation || 0;
      const cR = Math.cos(r), sR = Math.sin(r);
      const local = (lx, ly) => ({ x: cx + lx * cR - ly * sR, y: cy + lx * sR + ly * cR });
      const hw = s.w / 2, hh = s.h / 2;
      return [
        { ...local(-hw, -hh), key: 'nw' },
        { ...local( hw, -hh), key: 'ne' },
        { ...local( hw,  hh), key: 'se' },
        { ...local(-hw,  hh), key: 'sw' }
      ];
    }
    if (s.type === 'ellipse') {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const r = s.rotation || 0;
      const cR = Math.cos(r), sR = Math.sin(r);
      const local = (lx, ly) => ({ x: cx + lx * cR - ly * sR, y: cy + lx * sR + ly * cR });
      const hw = s.w / 2, hh = s.h / 2;
      return [
        { ...local(0, -hh), key: 'n' },
        { ...local(hw, 0),  key: 'e' },
        { ...local(0,  hh), key: 's' },
        { ...local(-hw, 0), key: 'w' }
      ];
    }
    if (s.type === 'line') {
      return [
        { x: s.p1.x, y: s.p1.y, key: 'p1' },
        { x: s.p2.x, y: s.p2.y, key: 'p2' }
      ];
    }
    if (s.type === 'path') {
      return (s.points || []).map((p, i) => ({ x: p.x, y: p.y, key: 'p' + i, pointType: p.type || 'corner' }));
    }
    return [];
  }

  // Public hit-test exposed to Direct Selection so it doesn't need to
  // duplicate the cross-layer iteration logic.
  function hitAcrossLayers(px, py) { return _hitAcrossLayers(px, py); }

  function getShapeBBox(s) { return _shapeBBox(s); }

  // ── Selection Tool Integration ────────────────────────────
  // Drives Illustrator-style whole-path selection while the Selection
  // tool (pen group, between Pen and Direct Selection) is active.

  function _showSelectShapeOptionsBar() {
    const ids = ['opt-shape-fill','opt-shape-stroke','opt-shape-stroke-style','opt-shape-dash','opt-shape-corner','opt-shape-order','opt-shape-combine','opt-opacity'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); });
    const old1 = document.getElementById('opt-fill-mode'); if (old1) old1.classList.add('hidden');
    const old2 = document.getElementById('opt-stroke-width'); if (old2) old2.classList.add('hidden');
    const moveOpt = document.getElementById('opt-move'); if (moveOpt) moveOpt.classList.add('hidden');
  }

  function _hideSelectShapeOptionsBar() {
    const ids = ['opt-shape-fill','opt-shape-stroke','opt-shape-stroke-style','opt-shape-dash','opt-shape-corner','opt-shape-order','opt-shape-combine','opt-opacity'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
  }

  function openForSelectTool(layer) {
    _selectToolActive = true;
    _showSelectShapeOptionsBar();
    // Entering a shape layer with the Selection tool selects nothing
    // (Illustrator behavior) — the user clicks a path to select it. Any
    // selection carried over from another tool is preserved. When the
    // active layer isn't a shape, drop any stale session so old handles
    // don't linger.
    if (layer && layer.kind === 'shape') _ensureSession(layer);
    else if (session) endEdit(true);
    _syncOptionsBarFromSelection();
    _refreshShapePanel();
  }

  function closeForSelectTool() {
    if (!_selectToolActive) return;
    _selectToolActive = false;
    if (session) endEdit(true);
    _hideSelectShapeOptionsBar();
    const panel = document.getElementById('propertiesPanel');
    const section = document.getElementById('propsShapeSection');
    if (panel) _setShapePanelMode(panel, false);
    if (section) section.hidden = true;
  }

  function isSelectToolActive() { return _selectToolActive; }

  // Toggle one shape's membership in the active layer's selection set
  // (Shift-click multi-select). Returns whether the shape ends up selected.
  function _toggleShapeSelection(layer, id) {
    const set = _ensureSelectedSet(layer);
    let nowSelected;
    if (set.has(id)) { set.delete(id); nowSelected = false; }
    else { set.add(id); nowSelected = true; }
    _setSelection(layer, Array.from(set));
    return nowSelected;
  }

  // Handles Selection tool mouse-down: cross-layer hit-test, select (with
  // Shift-add multi-select), begin a move drag. Never draws a new shape.
  function handleSelectMouseDown(e, pos) {
    if (e.button === 2) {
      const hit = _hitAcrossLayers(pos.x, pos.y);
      if (hit) {
        if (typeof activeLayerIndex !== 'undefined') {
          window.activeLayerIndex = hit.layerIndex;
          selectedLayers = new Set([hit.layerIndex]);
          if (typeof updateLayerPanel === 'function') updateLayerPanel();
        }
        if (!session || session.layer !== layers[hit.layerIndex]) openForSelectTool(layers[hit.layerIndex]);
        _ensureSession(layers[hit.layerIndex]);
        if (!_ensureSelectedSet(session.layer).has(hit.shape.id)) {
          _setSelection(session.layer, [hit.shape.id]);
        }
        _showContextMenu(e);
        return true;
      }
      return false;
    }
    if (e.button !== 0) return false;

    const hit = _hitAcrossLayers(pos.x, pos.y);
    if (hit) {
      // Cross-layer auto-select: clicking any path makes its layer active.
      const switchedLayer = (typeof activeLayerIndex !== 'undefined' && activeLayerIndex !== hit.layerIndex);
      if (switchedLayer) {
        window.activeLayerIndex = hit.layerIndex;
        selectedLayers = new Set([hit.layerIndex]);
        if (typeof updateLayerPanel === 'function') updateLayerPanel();
      }
      if (!session || session.layer !== layers[hit.layerIndex]) openForSelectTool(layers[hit.layerIndex]);
      _ensureSession(layers[hit.layerIndex]);
      // Shift-click adds/removes within one layer's selection (used to feed
      // Combine). The selection model is per-layer, so a Shift-click that
      // lands on a different layer than the current session can't extend a
      // cross-layer set — it just selects that path on the new layer.
      if (e.shiftKey && !switchedLayer) {
        const stillSelected = _toggleShapeSelection(session.layer, hit.shape.id);
        if (stillSelected) _beginMoveDrag(e);
        return true;
      }
      if (!_ensureSelectedSet(session.layer).has(hit.shape.id)) {
        _setSelection(session.layer, [hit.shape.id]);
      }
      _beginMoveDrag(e);
      return true;
    }

    // No shape hit — clear selection but keep the tool active.
    if (_selectToolActive && session) _clearSelection(session.layer);
    return false;
  }

  // Move tool integration: translate every path on a shape layer together
  // as one object (no per-path picking, no selection chrome). Reuses the
  // same vector translate the properties panel uses, so the layer stays
  // fully editable afterward.
  function beginWholeLayerMove(layer, e) {
    if (!layer || layer.kind !== 'shape' || !layer.shapeModel
        || !layer.shapeModel.shapes.length || e.button !== 0) return false;
    const startMouse = { x: e.clientX, y: e.clientY };
    let lastDx = 0, lastDy = 0, changed = false;
    function _mm(ev) {
      const z = (typeof zoom !== 'undefined' ? zoom : 1) || 1;
      const dx = (ev.clientX - startMouse.x) / z;
      const dy = (ev.clientY - startMouse.y) / z;
      const incX = dx - lastDx, incY = dy - lastDy;
      lastDx = dx; lastDy = dy;
      if (!incX && !incY) return;
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) changed = true;
      for (const s of layer.shapeModel.shapes) _translateShape(s, incX, incY);
      renderShapeLayer(layer);
      if (typeof compositeAll === 'function') compositeAll();
      if (typeof drawOverlay === 'function') drawOverlay();
    }
    function _mu() {
      document.removeEventListener('mousemove', _mm);
      document.removeEventListener('mouseup', _mu);
      if (changed) {
        if (typeof pushUndo === 'function') pushUndo('Move');
        if (typeof updateLayerPanel === 'function') updateLayerPanel();
      }
    }
    document.addEventListener('mousemove', _mm);
    document.addEventListener('mouseup', _mu);
    return true;
  }

  // ── Tool registration: Selection tool (pen group) ─────────
  ToolRegistry.register('pathselect', {
    activate() {
      const layer = (typeof layers !== 'undefined' && typeof activeLayerIndex !== 'undefined')
        ? layers[activeLayerIndex] : null;
      openForSelectTool(layer && layer.kind === 'shape' ? layer : null);
      if (typeof workspace !== 'undefined') workspace.style.cursor = 'default';
      if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
    },
    deactivate() {
      closeForSelectTool();
      if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
    },
    mouseDown(e, pos) {
      if (handleSelectMouseDown(e, pos)) return true;
      // Empty-canvas left-click: swallow so it doesn't fall through to
      // pixel-selection behavior. The Selection tool never marquees pixels.
      if (e.button === 0) { if (typeof isDrawing !== 'undefined') isDrawing = false; return true; }
      return false;
    }
  });

  // Init wiring once DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireOptionsBar);
  } else {
    _wireOptionsBar();
  }

  return {
    beginEdit,
    endEdit,
    isActive: () => !!session,
    isLayerPreviewSuppressed: () => false,
    requireRasterize,
    renderShapeLayer,
    setActiveShapeType,
    getActiveShapeType,
    onZoomChange,
    hitTestAndSelect,
    updateHover,
    clearHover,
    hasSelection,
    getSelectionCount,
    getSelectedBounds,
    setSelectedBoundsField,
    flipSelected,
    alignSelectedToCanvas,
    refreshPropertiesPanel: _refreshShapePanel,
    // Bridge for js/tools/combine.js (OpsinCombine).
    getActiveLayer: () => (session ? session.layer : null),
    selectShapes: (layer, ids) => _setSelection(layer, ids),
    openForSelectTool,
    closeForSelectTool,
    isSelectToolActive,
    handleSelectMouseDown,
    beginWholeLayerMove,
    convertShapeToPath,
    getShapeAnchors,
    hitAcrossLayers,
    getShapeBBox,
    DASH_PRESETS,
    // Hover-reveal helpers exposed for the pen tool's overlay.
    _drawShapeOutlineHover,
    _shapeOutlineD
  };
})();

/* ═══════════════════════════════════════════════════════════════════
   PEN TOOL — Illustrator/Photoshop-style cubic-bezier path editor.

   Creates and edits 'path' primitives on shape layers. Path point model
   (defined alongside the shape model in this file): each anchor is
   { x, y, type?, ohx?, ohy?, ihx?, ihy? } in world space. Absent ih*
   means a straight incoming segment; absent oh* means a straight
   outgoing segment. type ∈ 'corner'|'smooth'|'symmetric'.

   Modes (options bar — defaults to 'edit' on every (re)activation and
   on every new path):
     edit  — click empty canvas → start new path; click endpoint of an
             open path → resume drawing from there; click middle anchor
             → drag to move; click handle dot → drag to reshape.
     add   — click on segment → split at that t (de Casteljau).
     minus — click on anchor → delete it.

   Modifiers while drawing:
     Shift  → constrain new segment angle to multiples of 45°.
     Alt    → break the symmetric-handle pairing on the just-placed
              anchor (drag controls outgoing only).
     Ctrl   → temporary Direct-Selection (drag existing anchor / handle
              without leaving the pen).

   Finish: Esc / Enter / double-click / tool-switch (auto-commits open).
   Close:  click the path's first anchor (drag during the click sets
           the closing-segment curve, symmetric).

   Each anchor placement / edit pushes one undo entry.
   ═══════════════════════════════════════════════════════════════════ */

window.PenTool = (function () {

  // ── Tunables ───────────────────────────────────────────────
  const ANCHOR_HIT_PAD = 7;     // screen px slop for anchor hit-tests
  const HANDLE_HIT_PAD = 6;     // screen px slop for handle dot hit-tests
  const SEG_HIT_PAD    = 5;     // screen px slop for segment hit-tests
  const SEG_SAMPLES    = 32;    // bezier subdivision steps for hit tests

  // ── State ─────────────────────────────────────────────────
  let _mode = 'edit';
  let _variant = 'pen';         // 'pen' | 'anchor'  (sub-tool)
  // _draft = null | { layer, shape, pendingHandle, _closing? }
  //   pendingHandle = null | { anchorIdx } during click-drag handle setup
  let _draft = null;
  let _overlayEl = null;
  let _docMouseMove = null, _docMouseUp = null;
  let _dragOp = null;           // edit-mode anchor / handle drag
  let _hoverCanvas = null;

  let _activeFill = { type: 'none', color: '#5b8def' };
  let _activeStroke = {
    type: 'solid', color: '#1a1a1e', width: 2,
    cap: 'butt', join: 'miter', align: 'center',
    dashPattern: null, dashOffset: 0
  };

  // ── Geometry helpers ──────────────────────────────────────
  function _overlayRoot() {
    return (typeof workspace !== 'undefined' && workspace) || document.getElementById('workspace');
  }
  function _zoom() { return (typeof zoom !== 'undefined') ? zoom : 1; }

  function _segCps(prev, cur) {
    return {
      c1x: prev.ohx !== undefined ? prev.ohx : prev.x,
      c1y: prev.ohy !== undefined ? prev.ohy : prev.y,
      c2x: cur.ihx  !== undefined ? cur.ihx  : cur.x,
      c2y: cur.ihy  !== undefined ? cur.ihy  : cur.y
    };
  }

  function _bezierPoint(p0x, p0y, c1x, c1y, c2x, c2y, p1x, p1y, t) {
    const mt = 1 - t;
    return {
      x: mt*mt*mt*p0x + 3*mt*mt*t*c1x + 3*mt*t*t*c2x + t*t*t*p1x,
      y: mt*mt*mt*p0y + 3*mt*mt*t*c1y + 3*mt*t*t*c2y + t*t*t*p1y
    };
  }

  // Snap a free point to the nearest 45° ray from anchor (Shift constraint).
  function _shiftConstrain(ax, ay, cx, cy) {
    const dx = cx - ax, dy = cy - ay;
    const ang = Math.atan2(dy, dx);
    const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return { x: ax + Math.cos(snap) * len, y: ay + Math.sin(snap) * len };
  }

  // ── Active path resolution ────────────────────────────────
  function _activeShapeLayer() {
    if (_draft) return _draft.layer;
    if (typeof layers === 'undefined' || typeof activeLayerIndex === 'undefined') return null;
    const L = layers[activeLayerIndex];
    return (L && L.kind === 'shape') ? L : null;
  }

  // The path the pen is currently editing: drafting shape, else the
  // topmost path primitive on the active shape layer. null if none.
  function _activePath() {
    if (_draft) return _draft.shape;
    const L = _activeShapeLayer();
    if (!L || !L.shapeModel) return null;
    const shapes = L.shapeModel.shapes;
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (shapes[i].type === 'path') return shapes[i];
    }
    return null;
  }

  // ── Hit testing on the active path only (Q19) ─────────────
  function _hitAnchor(cx, cy) {
    const s = _activePath();
    if (!s) return null;
    const tol = ANCHOR_HIT_PAD / _zoom();
    const pts = s.points || [];
    for (let i = pts.length - 1; i >= 0; i--) {
      if (Math.hypot(cx - pts[i].x, cy - pts[i].y) <= tol) return { shape: s, idx: i };
    }
    return null;
  }
  function _hitHandle(cx, cy) {
    const s = _activePath();
    if (!s) return null;
    const tol = HANDLE_HIT_PAD / _zoom();
    const pts = s.points || [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.ohx !== undefined && Math.hypot(cx - p.ohx, cy - p.ohy) <= tol) {
        return { shape: s, idx: i, side: 'oh' };
      }
      if (p.ihx !== undefined && Math.hypot(cx - p.ihx, cy - p.ihy) <= tol) {
        return { shape: s, idx: i, side: 'ih' };
      }
    }
    return null;
  }
  function _hitSegment(cx, cy) {
    const s = _activePath();
    if (!s) return null;
    const pts = s.points || [];
    if (pts.length < 2) return null;
    const tol = SEG_HIT_PAD / _zoom();
    let best = null;
    function _trySeg(iA, iB) {
      const prev = pts[iA], cur = pts[iB];
      const cp = _segCps(prev, cur);
      let prevS = { x: prev.x, y: prev.y };
      for (let k = 1; k <= SEG_SAMPLES; k++) {
        const t = k / SEG_SAMPLES;
        const next = _bezierPoint(prev.x, prev.y, cp.c1x, cp.c1y, cp.c2x, cp.c2y, cur.x, cur.y, t);
        const sx = next.x - prevS.x, sy = next.y - prevS.y;
        const len2 = sx*sx + sy*sy;
        let u = 0;
        if (len2 > 0) u = ((cx - prevS.x) * sx + (cy - prevS.y) * sy) / len2;
        if (u < 0) u = 0; if (u > 1) u = 1;
        const px = prevS.x + sx * u, py = prevS.y + sy * u;
        const d = Math.hypot(cx - px, cy - py);
        if (d <= tol) {
          const tCurve = (k - 1 + u) / SEG_SAMPLES;
          if (!best || d < best.d) best = { idxA: iA, idxB: iB, t: tCurve, d };
        }
        prevS = next;
      }
    }
    for (let i = 0; i < pts.length - 1; i++) _trySeg(i, i + 1);
    if (s.closed && pts.length > 2) _trySeg(pts.length - 1, 0);
    return best ? { shape: s, idxA: best.idxA, idxB: best.idxB, t: best.t } : null;
  }

  // ── de Casteljau anchor insertion (mathematically exact) ──
  function _insertAnchorOnSegment(s, idxA, idxB, t) {
    const pts = s.points;
    const P0 = pts[idxA], P1 = pts[idxB];
    const cp = _segCps(P0, P1);
    const c1x = cp.c1x, c1y = cp.c1y, c2x = cp.c2x, c2y = cp.c2y;
    const lerp = (a, b) => a + (b - a) * t;
    const Q0x = lerp(P0.x, c1x),  Q0y = lerp(P0.y, c1y);
    const Q1x = lerp(c1x, c2x),   Q1y = lerp(c1y, c2y);
    const Q2x = lerp(c2x, P1.x),  Q2y = lerp(c2y, P1.y);
    const R0x = lerp(Q0x, Q1x),   R0y = lerp(Q0y, Q1y);
    const R1x = lerp(Q1x, Q2x),   R1y = lerp(Q1y, Q2y);
    const Sx  = lerp(R0x, R1x),   Sy  = lerp(R0y, R1y);
    P0.ohx = Q0x; P0.ohy = Q0y;
    P1.ihx = Q2x; P1.ihy = Q2y;
    const newPt = { x: Sx, y: Sy, type: 'smooth', ihx: R0x, ihy: R0y, ohx: R1x, ohy: R1y };
    if (idxB === 0 && idxA === pts.length - 1) pts.push(newPt);
    else pts.splice(idxA + 1, 0, newPt);
  }

  // ── Layer / shape management ──────────────────────────────
  function _newPathShape(initialPoint) {
    const stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null };
    const fill = { ..._activeFill };
    return {
      id: -1, type: 'path', rotation: 0,
      points: initialPoint ? [{ x: initialPoint.x, y: initialPoint.y }] : [],
      closed: false,
      fill, stroke, opacity: 1
    };
  }
  function _ensureLayerForDraft() {
    let L = (typeof getActiveLayer === 'function') ? getActiveLayer() : null;
    // Append to the active layer when it is already a shape layer; only a
    // non-shape active layer spawns a fresh shape layer above it.
    if (!L || L.kind !== 'shape') {
      const initial = { nextId: 1, selectedIds: new Set(), shapes: [] };
      L = addShapeLayer(initial, true);
    }
    if (!L.shapeModel) L.shapeModel = { nextId: 1, selectedIds: new Set(), shapes: [] };
    return L;
  }

  // ── Render: layer canvas + DOM overlay (anchors / handles) ───
  function _renderLayer() {
    const L = _draft ? _draft.layer : _activeShapeLayer();
    if (!L) return;
    if (typeof renderShapeLayer === 'function') renderShapeLayer(L);
    if (typeof compositeAll === 'function') compositeAll();
  }
  function _ensureOverlay() {
    if (_overlayEl && _overlayEl.parentNode) return _overlayEl;
    const wrap = _overlayRoot();
    _overlayEl = document.createElement('div');
    _overlayEl.className = 'pen-overlay';
    wrap.appendChild(_overlayEl);
    return _overlayEl;
  }
  function _clearOverlay() {
    if (_overlayEl && _overlayEl.parentNode) _overlayEl.parentNode.removeChild(_overlayEl);
    _overlayEl = null;
  }
  function _drawHandleLine(root, ax, ay, hx, hy) {
    const a = c2s(ax, ay), b = c2s(hx, hy);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    const el = document.createElement('div');
    el.className = 'pen-handle-line';
    el.style.left = a.x + 'px';
    el.style.top  = a.y + 'px';
    el.style.width = len + 'px';
    el.style.transform = 'rotate(' + ang + 'deg)';
    root.appendChild(el);
  }
  function _drawHandleDot(root, hx, hy) {
    const p = c2s(hx, hy);
    const el = document.createElement('div');
    el.className = 'pen-handle-dot';
    el.style.left = p.x + 'px';
    el.style.top  = p.y + 'px';
    root.appendChild(el);
  }
  function _drawAnchorDot(root, ax, ay, isFirst) {
    const p = c2s(ax, ay);
    const el = document.createElement('div');
    el.className = 'pen-anchor' + (isFirst ? ' is-first' : '');
    el.style.left = p.x + 'px';
    el.style.top  = p.y + 'px';
    root.appendChild(el);
  }

  function _renderOverlay() {
    if (typeof currentTool !== 'undefined' && currentTool !== 'pen') return;
    const root = _ensureOverlay();
    root.innerHTML = '';
    // Hover-reveal outlines + anchors for non-draft shapes on the active layer.
    _drawHoverOverlaysForOtherShapes(root);
    const s = _activePath();
    if (!s) return;
    const pts = s.points || [];
    const closed = !!s.closed;
    // Outline of the entire path: dashed while drafting, solid once committed.
    if (pts.length >= 2) {
      const drafting = !!(_draft && _draft.shape === s);
      _drawDraftOutline(root, s, drafting);
    }
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      // Show handles for the anchor currently being placed (pendingHandle), even
      // though it is the last point (i < pts.length - 1 would otherwise be false).
      const isDraftAnchor = _draft && _draft.pendingHandle && _draft.pendingHandle.anchorIdx === i;
      const hasOut = (p.ohx !== undefined) && (i < pts.length - 1 || closed || isDraftAnchor);
      const hasIn  = (p.ihx !== undefined) && (i > 0 || closed || isDraftAnchor);
      if (hasOut) { _drawHandleLine(root, p.x, p.y, p.ohx, p.ohy); _drawHandleDot(root, p.ohx, p.ohy); }
      if (hasIn)  { _drawHandleLine(root, p.x, p.y, p.ihx, p.ihy); _drawHandleDot(root, p.ihx, p.ihy); }
      _drawAnchorDot(root, p.x, p.y, i === 0);
    }
  }

  // Hover-reveal: draw outlines + per-anchor reveal dots for every shape on
  // EVERY visible shape layer (skip just the current draft). Reuses ShapeTool
  // helpers for outline geometry; anchors get their own hover hit-target so
  // each one reveals individually.
  function _drawHoverOverlaysForOtherShapes(root) {
    const draftShape = _draft ? _draft.shape : null;
    const ST = window.ShapeTool;
    const allLayers = (typeof layers !== 'undefined' && Array.isArray(layers)) ? layers : [];
    for (const L of allLayers) {
      if (!L || !L.visible || L.kind !== 'shape' || !L.shapeModel) continue;
      for (const sh of L.shapeModel.shapes) {
        if (sh === draftShape) continue;
        if (ST && ST._drawShapeOutlineHover) ST._drawShapeOutlineHover(root, sh);
        if (ST && ST.getShapeAnchors) {
          const anchors = ST.getShapeAnchors(sh);
          for (const a of anchors) _drawHoverAnchor(root, a.x, a.y);
        }
      }
    }
  }

  function _drawHoverAnchor(root, ax, ay) {
    const p = c2s(ax, ay);
    const el = document.createElement('div');
    el.className = 'ds-anchor pen-anchor-hover';
    el.style.left = p.x + 'px';
    el.style.top  = p.y + 'px';
    el.style.opacity = '0';
    el.style.pointerEvents = 'auto';
    el.style.transition = 'opacity 80ms ease, width 90ms ease, height 90ms ease, margin 90ms ease, background 90ms ease, border-width 90ms ease';
    el.addEventListener('mouseenter', () => { el.style.opacity = '1'; });
    el.addEventListener('mouseleave', () => { el.style.opacity = '0'; });
    root.appendChild(el);
  }

  function _drawDraftOutline(root, s, dashed) {
    const pts = s.points;
    let d = '';
    const start = c2s(pts[0].x, pts[0].y);
    d += 'M ' + start.x.toFixed(2) + ' ' + start.y.toFixed(2);
    const seg = (p0, p1) => {
      const cp1x = p0.ohx !== undefined ? p0.ohx : p0.x;
      const cp1y = p0.ohy !== undefined ? p0.ohy : p0.y;
      const cp2x = p1.ihx !== undefined ? p1.ihx : p1.x;
      const cp2y = p1.ihy !== undefined ? p1.ihy : p1.y;
      const e = c2s(p1.x, p1.y);
      if (cp1x === p0.x && cp1y === p0.y && cp2x === p1.x && cp2y === p1.y) {
        d += ' L ' + e.x.toFixed(2) + ' ' + e.y.toFixed(2);
      } else {
        const c1 = c2s(cp1x, cp1y), c2_ = c2s(cp2x, cp2y);
        d += ' C ' + c1.x.toFixed(2) + ' ' + c1.y.toFixed(2)
          +  ' ' + c2_.x.toFixed(2) + ' ' + c2_.y.toFixed(2)
          +  ' ' + e.x.toFixed(2) + ' ' + e.y.toFixed(2);
      }
    };
    for (let i = 0; i < pts.length - 1; i++) seg(pts[i], pts[i + 1]);
    if (s.closed && pts.length > 2) { seg(pts[pts.length - 1], pts[0]); d += ' Z'; }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'pen-draft-svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'pen-draft-path');
    if (!dashed) path.style.strokeDasharray = 'none';
    path.setAttribute('d', d);
    svg.appendChild(path);
    root.appendChild(svg);
  }

  // Clear the overlayCanvas rubber band. Called whenever a draft transitions
  // to a non-drafting state (commit, close, finish, deactivate).
  function _clearRubberBand() {
    if (typeof prepareOverlay === 'function') prepareOverlay();
  }

  // Rubber-band: dashed preview from last anchor → cursor, drawn on the
  // shared overlayCanvas so it tracks zoom/pan exactly. Only while drafting,
  // not during pendingHandle.
  function _drawRubberBand(cursor, e) {
    if (!_draft || !_draft.shape) return;
    if (typeof prepareOverlay !== 'function') return;
    const pts = _draft.shape.points;
    if (!pts.length) return;
    const last = pts[pts.length - 1];
    let cx = cursor.x, cy = cursor.y;
    if (e && e.shiftKey) {
      const c = _shiftConstrain(last.x, last.y, cx, cy);
      cx = c.x; cy = c.y;
    }
    prepareOverlay();
    const dpr = window.devicePixelRatio || 1;
    overlayCtx.save();
    overlayCtx.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr);
    overlayCtx.lineWidth = Math.max(1 / zoom, 0.5);
    overlayCtx.strokeStyle = '#4bff4b';
    overlayCtx.setLineDash([3 / zoom, 2 / zoom]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(last.x, last.y);
    if (last.ohx !== undefined) {
      // Cubic with the cursor as the (incoming-flat) endpoint.
      overlayCtx.bezierCurveTo(last.ohx, last.ohy, cx, cy, cx, cy);
    } else {
      overlayCtx.lineTo(cx, cy);
    }
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  // ── Anchor placement ─────────────────────────────────────
  function _beginDraftWithAnchor(canvasX, canvasY) {
    const layer = _ensureLayerForDraft();
    const shape = _newPathShape({ x: canvasX, y: canvasY });
    shape.id = layer.shapeModel.nextId++;
    layer.shapeModel.shapes.push(shape);
    _draft = { layer, shape, pendingHandle: { anchorIdx: 0 } };
    _renderLayer();
    _renderOverlay();
  }
  function _appendDraftAnchor(canvasX, canvasY) {
    const s = _draft.shape;
    s.points.push({ x: canvasX, y: canvasY });
    _draft.pendingHandle = { anchorIdx: s.points.length - 1 };
    _renderLayer();
    _renderOverlay();
  }
  function _updatePendingHandle(handleX, handleY, alt) {
    if (!_draft || !_draft.pendingHandle) return;
    const idx = _draft.pendingHandle.anchorIdx;
    const p = _draft.shape.points[idx];
    p.ohx = handleX; p.ohy = handleY;
    if (!alt) {
      p.ihx = 2 * p.x - handleX;
      p.ihy = 2 * p.y - handleY;
      p.type = 'symmetric';
    } else {
      delete p.ihx; delete p.ihy;
      p.type = 'corner';
    }
    _renderLayer();
    _renderOverlay();
  }
  function _commitPendingHandle() {
    if (!_draft) return;
    const ph = _draft.pendingHandle;
    _draft.pendingHandle = null;
    if (!ph) return;
    const p = _draft.shape.points[ph.anchorIdx];
    if (p.ohx === undefined && p.ihx === undefined) p.type = 'corner';
    _renderLayer();
    _renderOverlay();
  }

  // ── Resume drawing from an existing endpoint ────────────
  function _reversePathPoints(s) {
    s.points.reverse();
    for (const p of s.points) {
      const ihx = p.ihx, ihy = p.ihy, ohx = p.ohx, ohy = p.ohy;
      if (ohx !== undefined) { p.ihx = ohx; p.ihy = ohy; } else { delete p.ihx; delete p.ihy; }
      if (ihx !== undefined) { p.ohx = ihx; p.ohy = ihy; } else { delete p.ohx; delete p.ohy; }
    }
  }
  function _resumeDraft(layer, shape, endpointIdx) {
    if (shape.closed) return false;
    if (endpointIdx === 0) _reversePathPoints(shape);
    _draft = { layer, shape, pendingHandle: null };
    return true;
  }

  // ── Edit-mode anchor / handle drag ─────────────────────
  function _clonePoint(p) {
    const c = { x: p.x, y: p.y };
    if (p.type) c.type = p.type;
    if (p.ihx !== undefined) { c.ihx = p.ihx; c.ihy = p.ihy; }
    if (p.ohx !== undefined) { c.ohx = p.ohx; c.ohy = p.ohy; }
    return c;
  }
  function _beginAnchorDrag(e, hit) {
    const layer = _activeShapeLayer();
    if (!layer) return;
    const start = screenToCanvas(e.clientX, e.clientY);
    _dragOp = {
      kind: 'anchor', layer, shape: hit.shape, anchorIdx: hit.idx,
      startMouse: start, snapshot: _clonePoint(hit.shape.points[hit.idx]),
      changed: false
    };
    _docMouseMove = _onDragMove; _docMouseUp = _onDragUp;
    document.addEventListener('mousemove', _docMouseMove);
    document.addEventListener('mouseup', _docMouseUp);
  }
  function _beginHandleDrag(e, hit) {
    const layer = _activeShapeLayer();
    if (!layer) return;
    const start = screenToCanvas(e.clientX, e.clientY);
    _dragOp = {
      kind: 'handle', layer, shape: hit.shape, anchorIdx: hit.idx, side: hit.side,
      startMouse: start, snapshot: _clonePoint(hit.shape.points[hit.idx]),
      changed: false
    };
    _docMouseMove = _onDragMove; _docMouseUp = _onDragUp;
    document.addEventListener('mousemove', _docMouseMove);
    document.addEventListener('mouseup', _docMouseUp);
  }
  function _onDragMove(e) {
    if (!_dragOp) return;
    const cur = screenToCanvas(e.clientX, e.clientY);
    const dx = cur.x - _dragOp.startMouse.x;
    const dy = cur.y - _dragOp.startMouse.y;
    if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) _dragOp.changed = true;
    const op = _dragOp;
    const snap = op.snapshot;
    const p = op.shape.points[op.anchorIdx];
    if (op.kind === 'anchor') {
      p.x = snap.x + dx; p.y = snap.y + dy;
      if (snap.ohx !== undefined) { p.ohx = snap.ohx + dx; p.ohy = snap.ohy + dy; }
      if (snap.ihx !== undefined) { p.ihx = snap.ihx + dx; p.ihy = snap.ihy + dy; }
    } else {
      // handle drag — preserve the opposite handle for smooth/symmetric
      // points, mirror-rotated through the anchor.
      const hx = (op.side === 'oh' ? snap.ohx : snap.ihx) + dx;
      const hy = (op.side === 'oh' ? snap.ohy : snap.ihy) + dy;
      if (op.side === 'oh') { p.ohx = hx; p.ohy = hy; } else { p.ihx = hx; p.ihy = hy; }
      const ptype = p.type || 'corner';
      if (!e.altKey && (ptype === 'smooth' || ptype === 'symmetric') && p.ohx !== undefined && p.ihx !== undefined) {
        if (op.side === 'oh') {
          if (ptype === 'symmetric') {
            p.ihx = 2 * p.x - p.ohx; p.ihy = 2 * p.y - p.ohy;
          } else {
            const dxh = p.ohx - p.x, dyh = p.ohy - p.y;
            const lenOh = Math.hypot(dxh, dyh) || 1;
            const oldDx = p.ihx - p.x, oldDy = p.ihy - p.y;
            const oldLen = Math.hypot(oldDx, oldDy) || 1;
            p.ihx = p.x - (dxh / lenOh) * oldLen;
            p.ihy = p.y - (dyh / lenOh) * oldLen;
          }
        } else {
          if (ptype === 'symmetric') {
            p.ohx = 2 * p.x - p.ihx; p.ohy = 2 * p.y - p.ihy;
          } else {
            const dxh = p.ihx - p.x, dyh = p.ihy - p.y;
            const lenIh = Math.hypot(dxh, dyh) || 1;
            const oldDx = p.ohx - p.x, oldDy = p.ohy - p.y;
            const oldLen = Math.hypot(oldDx, oldDy) || 1;
            p.ohx = p.x - (dxh / lenIh) * oldLen;
            p.ohy = p.y - (dyh / lenIh) * oldLen;
          }
        }
      }
    }
    _renderLayer();
    _renderOverlay();
  }
  function _onDragUp() {
    const op = _dragOp;
    _dragOp = null;
    if (_docMouseMove) document.removeEventListener('mousemove', _docMouseMove);
    if (_docMouseUp)   document.removeEventListener('mouseup',   _docMouseUp);
    _docMouseMove = null; _docMouseUp = null;
    if (op && op.changed && typeof pushUndo === 'function') {
      pushUndo(op.kind === 'anchor' ? 'Move Anchor' : 'Edit Handle');
    }
  }

  // ── Adaptive cursors (Q18: small hint for add/minus) ────
  // Edit-mode default — pen icon, hotspot at the tip (upper-left).
  const _iconSvg = window.OpsinLinkedIcons ? window.OpsinLinkedIcons.getRawSvg.bind(window.OpsinLinkedIcons) : function () { return ''; };
  const _PEN_CURSOR_EDIT = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(_iconSvg('pen-edit-cursor-bw')) + '") 1 1, crosshair';
  const _PEN_CURSOR_ADD = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(_iconSvg('pen-add-cursor-bw')) + '") 1 1, crosshair';
  const _PEN_CURSOR_MINUS = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(_iconSvg('pen-minus-cursor-bw')) + '") 1 1, crosshair';
  const _PEN_CURSOR_CLOSE = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(_iconSvg('pen-close-cursor')) + '") 12 12, crosshair';
  const _PEN_CURSOR_ANCHOR = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(_iconSvg('pen-anchor-cursor-bw')) + '") 1 1, crosshair';

  function _updateCursor(canvasPos) {
    if (typeof workspace === 'undefined' || !canvasPos) return;
    // Default for Edit-mode (including while drafting a new path) is the
    // pen-edit cursor; Add/Minus stay on crosshair until they hover something
    // actionable, at which point they show their adaptive hint.
    let cur = (_mode === 'edit') ? _PEN_CURSOR_EDIT : 'crosshair';
    if (_draft) {
      const pts = _draft.shape.points;
      if (pts.length >= 2) {
        const tol = ANCHOR_HIT_PAD / _zoom();
        if (Math.hypot(canvasPos.x - pts[0].x, canvasPos.y - pts[0].y) <= tol) cur = _PEN_CURSOR_CLOSE;
      }
    } else if (_mode === 'add') {
      const seg = _hitSegment(canvasPos.x, canvasPos.y);
      if (seg) cur = _PEN_CURSOR_ADD;
    } else if (_mode === 'minus') {
      const a = _hitAnchor(canvasPos.x, canvasPos.y);
      if (a) cur = _PEN_CURSOR_MINUS;
    }
    workspace.style.cursor = cur;
  }

  // ── Mouse handlers ──────────────────────────────────────
  function _onMouseDown(e, pos) {
    if (e.button !== 0) return false;
    const cx = pos.x, cy = pos.y;

    // Double-click finishes the open path without placing a duplicate anchor.
    if (e.detail >= 2 && _draft) { _finishOpen(); return true; }

    // Ctrl temp Direct-Selection: drag an existing anchor / handle without
    // leaving the pen, even while drafting.
    if (e.ctrlKey || e.metaKey) {
      const aHit = _hitAnchor(cx, cy);
      if (aHit) { _beginAnchorDrag(e, aHit); return true; }
      const hHit = _hitHandle(cx, cy);
      if (hHit) { _beginHandleDrag(e, hHit); return true; }
    }

    // Drafting: click on the first anchor → close (drag sets closing curve).
    if (_draft && _draft.shape.points.length >= 2) {
      const tol = ANCHOR_HIT_PAD / _zoom();
      const p0 = _draft.shape.points[0];
      if (Math.hypot(cx - p0.x, cy - p0.y) <= tol) {
        _draft.shape.closed = true;
        _draft.pendingHandle = { anchorIdx: 0, _closing: true };
        _renderLayer();
        _renderOverlay();
        return true;
      }
    }

    // Mode-specific behavior on the active path (only when not drafting).
    if (!_draft) {
      const aHit = _hitAnchor(cx, cy);
      const hHit = aHit ? null : _hitHandle(cx, cy);
      if (_mode === 'edit') {
        if (aHit) {
          const s = aHit.shape;
          const isEnd = !s.closed && (aHit.idx === 0 || aHit.idx === s.points.length - 1);
          if (isEnd) {
            const layer = _activeShapeLayer();
            if (_resumeDraft(layer, s, aHit.idx)) { _renderOverlay(); return true; }
          }
          _beginAnchorDrag(e, aHit); return true;
        }
        if (hHit) { _beginHandleDrag(e, hHit); return true; }
      } else if (_mode === 'add') {
        if (aHit) {
          const s = aHit.shape;
          const isEnd = !s.closed && (aHit.idx === 0 || aHit.idx === s.points.length - 1);
          if (isEnd) {
            const layer = _activeShapeLayer();
            if (_resumeDraft(layer, s, aHit.idx)) { _renderOverlay(); return true; }
          }
          _beginAnchorDrag(e, aHit); return true;
        }
        if (hHit) { _beginHandleDrag(e, hHit); return true; }
        const seg = _hitSegment(cx, cy);
        if (seg) {
          _insertAnchorOnSegment(seg.shape, seg.idxA, seg.idxB, seg.t);
          _renderLayer(); _renderOverlay();
          if (typeof pushUndo === 'function') pushUndo('Insert Anchor');
          return true;
        }
      } else if (_mode === 'minus') {
        if (aHit) {
          _deleteAnchor(aHit.shape, aHit.idx);
          _renderLayer(); _renderOverlay();
          if (typeof pushUndo === 'function') pushUndo('Delete Anchor');
          return true;
        }
      }
    }

    // Empty canvas → reset to Edit mode + start (or extend) a draft path.
    if (!_draft) {
      setMode('edit');
      _beginDraftWithAnchor(cx, cy);
      return true;
    }
    let nx = cx, ny = cy;
    if (e.shiftKey && _draft.shape.points.length > 0) {
      const last = _draft.shape.points[_draft.shape.points.length - 1];
      const c = _shiftConstrain(last.x, last.y, nx, ny);
      nx = c.x; ny = c.y;
    }
    _appendDraftAnchor(nx, ny);
    return true;
  }

  function _onMouseMove(e, pos) {
    _hoverCanvas = pos;
    _updateCursor(pos);
    if (_draft && _draft.pendingHandle && !_dragOp) {
      // Clear any stale rubber-band left on the overlay canvas from before the click.
      if (typeof prepareOverlay === 'function') prepareOverlay();
      const ph = _draft.pendingHandle;
      const p = _draft.shape.points[ph.anchorIdx];
      let hx = pos.x, hy = pos.y;
      if (e.shiftKey) {
        const c = _shiftConstrain(p.x, p.y, hx, hy);
        hx = c.x; hy = c.y;
      }
      const alt = !!e.altKey;
      if (ph._closing) {
        // Close-drag: drag sets the first anchor's incoming handle (with
        // symmetric outgoing unless Alt). The path is already marked closed
        // by mouseDown.
        p.ihx = hx; p.ihy = hy;
        if (!alt) { p.ohx = 2 * p.x - hx; p.ohy = 2 * p.y - hy; p.type = 'symmetric'; }
        else      { delete p.ohx; delete p.ohy; p.type = 'corner'; }
        _renderLayer(); _renderOverlay();
      } else {
        _updatePendingHandle(hx, hy, alt);
      }
      return true;
    }
    if (_draft) { _drawRubberBand(pos, e); return true; }
    return false;
  }

  function _onMouseUp(e, pos) {
    if (_draft && _draft.pendingHandle && _draft.pendingHandle._closing) {
      _draft.pendingHandle = null;
      _draft = null;
      setMode('edit');
      _clearRubberBand();
      _renderLayer(); _renderOverlay();
      if (typeof pushUndo === 'function') pushUndo('Close Path');
      return true;
    }
    if (_draft && _draft.pendingHandle) {
      _commitPendingHandle();
      if (typeof pushUndo === 'function') pushUndo('Add Anchor');
      return true;
    }
    return false;
  }

  function _deleteAnchor(shape, idx) {
    const pts = shape.points;
    if (idx < 0 || idx >= pts.length) return;
    pts.splice(idx, 1);
    if (pts.length < 2) {
      const layer = _activeShapeLayer();
      if (layer && layer.shapeModel) {
        const arr = layer.shapeModel.shapes;
        const sIdx = arr.indexOf(shape);
        if (sIdx >= 0) arr.splice(sIdx, 1);
      }
    } else if (shape.closed && pts.length < 3) {
      shape.closed = false;
    }
    // Trailing/leading handles on an open path's endpoints are preserved
    // so that resuming the path keeps curve continuity. They render as
    // straight unless a future segment uses them.
  }

  function _finishOpen() {
    if (!_draft) return;
    // If there's an in-flight handle drag, commit it as part of the finish
    // so the last anchor keeps the handle the user was setting.
    if (_draft.pendingHandle) _draft.pendingHandle = null;
    const had = _draft.shape.points.length;
    _draft = null;
    setMode('edit');
    _clearRubberBand();
    _renderLayer(); _renderOverlay();
    if (had > 0 && typeof pushUndo === 'function') pushUndo('Finish Path');
  }

  // ── Anchor-Point sub-tool ───────────────────────────────
  // Operates on the topmost shape of the active shape layer. On first edit
  // a non-path primitive (rect/ellipse/line) is auto-converted to a path
  // via window.ShapeTool.convertShapeToPath so editing always happens on
  // the cubic-bezier point list.
  //
  //   click  : toggle smooth ↔ corner
  //   drag   : pull symmetric handles out of the anchor in drag direction
  //   handle : drag breaks the symmetric pair (cusp)

  function _topmostShape(layer) {
    if (!layer || !layer.shapeModel) return null;
    const arr = layer.shapeModel.shapes;
    return arr.length ? arr[arr.length - 1] : null;
  }

  function _ensurePathFromShape(layer, s) {
    if (!s || s.type === 'path') return s;
    if (window.ShapeTool && typeof window.ShapeTool.convertShapeToPath === 'function') {
      window.ShapeTool.convertShapeToPath(s);
    }
    if (typeof renderShapeLayer === 'function') renderShapeLayer(layer);
    return s;
  }

  function _hitAnchorOnShape(s, cx, cy) {
    if (!s || !Array.isArray(s.points)) return -1;
    const tol = ANCHOR_HIT_PAD / _zoom();
    for (let i = s.points.length - 1; i >= 0; i--) {
      if (Math.hypot(cx - s.points[i].x, cy - s.points[i].y) <= tol) return i;
    }
    return -1;
  }

  // Hit-test a non-path shape by its parametric anchors (rect corners,
  // ellipse cardinals, line endpoints). Returns the post-conversion point
  // index since convertShapeToPath preserves anchor order.
  function _hitParametricAnchorIdx(s, cx, cy) {
    if (!s || !window.ShapeTool || typeof window.ShapeTool.getShapeAnchors !== 'function') return -1;
    const anchors = window.ShapeTool.getShapeAnchors(s);
    const tol = ANCHOR_HIT_PAD / _zoom();
    for (let i = 0; i < anchors.length; i++) {
      if (Math.hypot(cx - anchors[i].x, cy - anchors[i].y) <= tol) return i;
    }
    return -1;
  }

  function _autoSmoothAnchor(shape, idx) {
    const pts = shape.points;
    const n = pts.length;
    if (!n) return;
    const p = pts[idx];
    const closed = !!shape.closed;
    const prevIdx = closed ? (idx - 1 + n) % n : (idx > 0 ? idx - 1 : -1);
    const nextIdx = closed ? (idx + 1) % n : (idx < n - 1 ? idx + 1 : -1);
    let tx = 0, ty = 0;
    if (prevIdx !== -1 && nextIdx !== -1) {
      tx = pts[nextIdx].x - pts[prevIdx].x;
      ty = pts[nextIdx].y - pts[prevIdx].y;
    } else if (prevIdx !== -1) {
      tx = p.x - pts[prevIdx].x; ty = p.y - pts[prevIdx].y;
    } else if (nextIdx !== -1) {
      tx = pts[nextIdx].x - p.x; ty = pts[nextIdx].y - p.y;
    }
    const len = Math.hypot(tx, ty) || 1;
    const ux = tx / len, uy = ty / len;
    let inLen  = (prevIdx !== -1) ? Math.hypot(p.x - pts[prevIdx].x, p.y - pts[prevIdx].y) / 3 : 0;
    let outLen = (nextIdx !== -1) ? Math.hypot(pts[nextIdx].x - p.x, pts[nextIdx].y - p.y) / 3 : 0;
    if (!inLen)  inLen  = outLen;
    if (!outLen) outLen = inLen;
    if (!inLen && !outLen) { inLen = outLen = 30; }
    p.ihx = p.x - ux * inLen; p.ihy = p.y - uy * inLen;
    p.ohx = p.x + ux * outLen; p.ohy = p.y + uy * outLen;
    p.type = 'smooth';
  }

  function _toggleSmoothCorner(shape, idx) {
    const p = shape.points[idx];
    const wasSmooth = (p.ohx !== undefined) || (p.ihx !== undefined);
    if (wasSmooth) {
      delete p.ohx; delete p.ohy; delete p.ihx; delete p.ihy;
      p.type = 'corner';
    } else {
      _autoSmoothAnchor(shape, idx);
    }
  }

  function _beginConvertAnchorOp(e, layer, shape, idx) {
    const start = screenToCanvas(e.clientX, e.clientY);
    _dragOp = {
      kind: 'convertAnchor', layer, shape, anchorIdx: idx,
      startMouse: start, snapshot: _clonePoint(shape.points[idx]),
      changed: false
    };
    _docMouseMove = _onConvertAnchorMove;
    _docMouseUp   = _onConvertAnchorUp;
    document.addEventListener('mousemove', _docMouseMove);
    document.addEventListener('mouseup',   _docMouseUp);
  }

  function _onConvertAnchorMove(e) {
    if (!_dragOp || _dragOp.kind !== 'convertAnchor') return;
    const cur = screenToCanvas(e.clientX, e.clientY);
    const dx = cur.x - _dragOp.startMouse.x;
    const dy = cur.y - _dragOp.startMouse.y;
    if (!_dragOp.changed) {
      const px = (typeof zoom !== 'undefined' ? zoom : 1);
      const threshold = 2 / px;
      if (Math.hypot(dx, dy) < threshold) return;
      _dragOp.changed = true;
    }
    const op = _dragOp;
    const p = op.shape.points[op.anchorIdx];
    p.ohx = p.x + dx; p.ohy = p.y + dy;
    p.ihx = p.x - dx; p.ihy = p.y - dy;
    p.type = 'symmetric';
    _renderLayer();
    _renderOverlay();
  }

  function _onConvertAnchorUp() {
    const op = _dragOp;
    _dragOp = null;
    if (_docMouseMove) document.removeEventListener('mousemove', _docMouseMove);
    if (_docMouseUp)   document.removeEventListener('mouseup',   _docMouseUp);
    _docMouseMove = null; _docMouseUp = null;
    if (!op) return;
    if (!op.changed) {
      _toggleSmoothCorner(op.shape, op.anchorIdx);
      _renderLayer();
      _renderOverlay();
    }
    if (typeof pushUndo === 'function') pushUndo('Convert Anchor');
  }

  function _beginBreakHandleOp(e, hit) {
    const layer = _activeShapeLayer();
    if (!layer) return;
    const start = screenToCanvas(e.clientX, e.clientY);
    _dragOp = {
      kind: 'breakHandle', layer, shape: hit.shape, anchorIdx: hit.idx, side: hit.side,
      startMouse: start, snapshot: _clonePoint(hit.shape.points[hit.idx]),
      changed: false
    };
    _docMouseMove = _onBreakHandleMove;
    _docMouseUp   = _onBreakHandleUp;
    document.addEventListener('mousemove', _docMouseMove);
    document.addEventListener('mouseup',   _docMouseUp);
  }

  function _onBreakHandleMove(e) {
    if (!_dragOp || _dragOp.kind !== 'breakHandle') return;
    const cur = screenToCanvas(e.clientX, e.clientY);
    const dx = cur.x - _dragOp.startMouse.x;
    const dy = cur.y - _dragOp.startMouse.y;
    if (!_dragOp.changed) {
      const px = (typeof zoom !== 'undefined' ? zoom : 1);
      const threshold = 2 / px;
      if (Math.hypot(dx, dy) < threshold) return;
      _dragOp.changed = true;
    }
    const op = _dragOp;
    const snap = op.snapshot;
    const p = op.shape.points[op.anchorIdx];
    // Move only the dragged side; opposite handle is preserved (cusp).
    if (op.side === 'oh') {
      p.ohx = (snap.ohx !== undefined ? snap.ohx : p.x) + dx;
      p.ohy = (snap.ohy !== undefined ? snap.ohy : p.y) + dy;
    } else {
      p.ihx = (snap.ihx !== undefined ? snap.ihx : p.x) + dx;
      p.ihy = (snap.ihy !== undefined ? snap.ihy : p.y) + dy;
    }
    p.type = 'corner';
    _renderLayer();
    _renderOverlay();
  }

  function _onBreakHandleUp() {
    const op = _dragOp;
    _dragOp = null;
    if (_docMouseMove) document.removeEventListener('mousemove', _docMouseMove);
    if (_docMouseUp)   document.removeEventListener('mouseup',   _docMouseUp);
    _docMouseMove = null; _docMouseUp = null;
    if (!op || !op.changed) return;
    if (typeof pushUndo === 'function') pushUndo('Break Handle');
  }

  function _onAnchorVariantMouseDown(e, pos) {
    // Always swallow the click so neither the legacy paint fallback nor a
    // new-draft path can be initiated while the anchor variant is active.
    if (e.button !== 0) return true;
    const layer = _activeShapeLayer();
    if (!layer) return true;
    const s = _topmostShape(layer);
    if (!s) return true;

    if (s.type === 'path') {
      const idx = _hitAnchorOnShape(s, pos.x, pos.y);
      if (idx !== -1) { _beginConvertAnchorOp(e, layer, s, idx); return true; }
      const hHit = _hitHandle(pos.x, pos.y);
      if (hHit) { _beginBreakHandleOp(e, hHit); return true; }
      return true;
    }

    // Non-path: hit-test parametric anchors and auto-convert on first edit.
    const idx = _hitParametricAnchorIdx(s, pos.x, pos.y);
    if (idx === -1) return true;
    _ensurePathFromShape(layer, s);
    if (typeof pushUndo === 'function') pushUndo('Convert to Path');
    _renderOverlay();
    _beginConvertAnchorOp(e, layer, s, idx);
    return true;
  }

  function _onAnchorVariantMouseMove(e, pos) {
    _hoverCanvas = pos;
    if (typeof workspace !== 'undefined') {
      const layer = _activeShapeLayer();
      const s = layer ? _topmostShape(layer) : null;
      let onHittable = false;
      if (s) {
        if (s.type === 'path') {
          if (_hitAnchorOnShape(s, pos.x, pos.y) !== -1) onHittable = true;
          else if (_hitHandle(pos.x, pos.y)) onHittable = true;
        } else {
          if (_hitParametricAnchorIdx(s, pos.x, pos.y) !== -1) onHittable = true;
        }
      }
      workspace.style.cursor = onHittable ? 'pointer' : _PEN_CURSOR_ANCHOR;
    }
    return true;
  }

  function setVariant(v) {
    if (v !== 'pen' && v !== 'anchor') return;
    if (_variant === v) return;
    // Switching variants — finish/commit any in-progress draft path so the
    // anchor-point variant starts from a clean slate.
    if (_draft) {
      const had = _draft.shape.points.length;
      const layer = _draft.layer;
      _draft = null;
      _clearRubberBand();
      if (layer && typeof renderShapeLayer === 'function') renderShapeLayer(layer);
      if (typeof compositeAll === 'function') compositeAll();
      if (had > 0 && typeof pushUndo === 'function') pushUndo('Finish Path');
    }
    _variant = v;
    const showPenChrome = (v === 'pen');
    ['opt-pen-mode','opt-pen-fill','opt-pen-width'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', !showPenChrome);
    });
    if (v === 'anchor') {
      if (typeof workspace !== 'undefined') workspace.style.cursor = _PEN_CURSOR_ANCHOR;
    } else {
      if (typeof workspace !== 'undefined') workspace.style.cursor = _PEN_CURSOR_EDIT;
    }
    _renderOverlay();
  }
  function getVariant() { return _variant; }

  // ── Mode + options bar ─────────────────────────────────
  function setMode(m) {
    if (m !== 'edit' && m !== 'add' && m !== 'minus') return;
    _mode = m;
    const map = { edit: 'optPenEdit', add: 'optPenAdd', minus: 'optPenSub' };
    Object.values(map).forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('active'); });
    const el = document.getElementById(map[m]);
    if (el) el.classList.add('active');
    if (_hoverCanvas) _updateCursor(_hoverCanvas);
  }
  function getMode() { return _mode; }

  // ── Color picker integration (own flag to avoid clashing with shape) ──
  function _openPenColorPicker(target) {
    if (typeof toggleColorPicker !== 'function') return;
    const seed = (target === 'fill') ? (_activeFill.color || '#ffffff') : (_activeStroke.color || '#000000');
    window._penAwaitingColor = target;
    window._pngPickerSeedHex = seed;
    toggleColorPicker();
  }
  window.addEventListener('message', (e) => {
    if (!e.data || !window._penAwaitingColor) return;
    if (e.data.action === 'cancel') { window._penAwaitingColor = null; return; }
    if (e.data.action !== 'confirm') return;
    const target = window._penAwaitingColor;
    window._penAwaitingColor = null;
    const hex = e.data.hex;
    if (!hex) return;
    if (target === 'fill') _activeFill = { type: 'solid', color: hex };
    else if (target === 'stroke') _activeStroke = { ..._activeStroke, type: 'solid', color: hex };
    _refreshChips();
    if (_draft && _draft.shape) {
      _draft.shape.fill = { ..._activeFill };
      _draft.shape.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null };
      _renderLayer();
    }
  });
  function _refreshChips() {
    const fc = document.getElementById('penFillChip');
    const sc = document.getElementById('penStrokeChip');
    if (fc) {
      fc.classList.toggle('is-none', _activeFill.type === 'none');
      fc.style.background = _activeFill.type === 'none' ? '' : (_activeFill.color || '#fff');
    }
    if (sc) {
      sc.classList.toggle('is-none', _activeStroke.type === 'none');
      sc.style.background = _activeStroke.type === 'none' ? '' : (_activeStroke.color || '#000');
    }
  }
  function _wireOptionsBar() {
    const fillBtn = document.getElementById('penFillBtn');
    const fillNone = document.getElementById('penFillNoneBtn');
    const strokeBtn = document.getElementById('penStrokeBtn');
    const strokeNone = document.getElementById('penStrokeNoneBtn');
    const widthInp = document.getElementById('penStrokeWidth');
    if (fillBtn) fillBtn.addEventListener('click', (ev) => { ev.stopPropagation(); _openPenColorPicker('fill'); });
    if (strokeBtn) strokeBtn.addEventListener('click', (ev) => { ev.stopPropagation(); _openPenColorPicker('stroke'); });
    if (fillNone) fillNone.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _activeFill = { type: 'none', color: _activeFill.color || '#000' };
      _refreshChips();
      if (_draft && _draft.shape) { _draft.shape.fill = { ..._activeFill }; _renderLayer(); }
    });
    if (strokeNone) strokeNone.addEventListener('click', (ev) => {
      ev.stopPropagation();
      _activeStroke = { ..._activeStroke, type: 'none' };
      _refreshChips();
      if (_draft && _draft.shape) {
        _draft.shape.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null };
        _renderLayer();
      }
    });
    if (widthInp) widthInp.addEventListener('change', () => {
      const v = parseFloat(widthInp.value);
      if (Number.isFinite(v)) {
        _activeStroke.width = Math.max(0, v);
        if (_draft && _draft.shape) {
          _draft.shape.stroke = { ..._activeStroke, dashPattern: _activeStroke.dashPattern ? _activeStroke.dashPattern.slice() : null };
          _renderLayer();
        }
      }
    });
    _refreshChips();
  }

  // ── Tool registration ──────────────────────────────────
  ToolRegistry.register('pen', {
    activate() {
      try { if (window.ShapeTool && window.ShapeTool.isActive && window.ShapeTool.isActive()) { window.ShapeTool.endEdit && window.ShapeTool.endEdit(true); } } catch (_) {}
      try { if (window.DirectSelection && window.DirectSelection.isOpen && window.DirectSelection.isOpen()) { window.DirectSelection.close(); } } catch (_) {}
      setMode('edit');
      const showPenChrome = (_variant === 'pen');
      ['opt-pen-mode','opt-pen-fill','opt-pen-width'].forEach(id => {
        const el = document.getElementById(id); if (el) el.classList.toggle('hidden', !showPenChrome);
      });
      _ensureOverlay();
      _renderOverlay();
      if (typeof workspace !== 'undefined') {
        workspace.style.cursor = (_variant === 'anchor') ? _PEN_CURSOR_ANCHOR : _PEN_CURSOR_EDIT;
      }
      const statusEl = document.getElementById('statusTool');
      if (statusEl) statusEl.textContent = (_variant === 'anchor') ? 'Anchor Point' : 'Pen';
    },
    deactivate() {
      // Auto-finish/commit any in-progress path (Q17). Trailing handles are
      // preserved so a later resume-from-endpoint keeps curve continuity.
      if (_draft) {
        const had = _draft.shape.points.length;
        const layer = _draft.layer;
        _draft = null;
        _clearRubberBand();
        if (layer && typeof renderShapeLayer === 'function') renderShapeLayer(layer);
        if (typeof compositeAll === 'function') compositeAll();
        if (had > 0 && typeof pushUndo === 'function') pushUndo('Finish Path');
      }
      if (_dragOp) {
        if (_docMouseMove) document.removeEventListener('mousemove', _docMouseMove);
        if (_docMouseUp)   document.removeEventListener('mouseup',   _docMouseUp);
        _dragOp = null; _docMouseMove = null; _docMouseUp = null;
      }
      _clearOverlay();
      ['opt-pen-mode','opt-pen-fill','opt-pen-width'].forEach(id => {
        const el = document.getElementById(id); if (el) el.classList.add('hidden');
      });
      if (typeof drawOverlay === 'function') drawOverlay();
    },
    mouseDown: function (e, pos) {
      if (_variant === 'anchor') return _onAnchorVariantMouseDown(e, pos);
      return _onMouseDown(e, pos);
    },
    mouseMove: function (e, pos) {
      if (_variant === 'anchor') return _onAnchorVariantMouseMove(e, pos);
      return _onMouseMove(e, pos);
    },
    mouseUp: function (e, pos) {
      // Drag operations install their own document listeners; nothing to do
      // here for the anchor variant beyond the pen tool's existing handler.
      if (_variant === 'anchor') return;
      return _onMouseUp(e, pos);
    }
  });

  // ── Keyboard ──────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (typeof currentTool !== 'undefined' && currentTool !== 'pen') return;
    const tag = (e.target && e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if ((e.key === 'Escape' || e.key === 'Enter') && _draft) { e.preventDefault(); _finishOpen(); }
  });

  function onZoomChange() { _renderOverlay(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireOptionsBar);
  } else {
    _wireOptionsBar();
  }

  return {
    setMode,
    getMode,
    setVariant,
    getVariant,
    onZoomChange,
    isActive: () => !!_draft,
    getActivePath: _activePath
  };
})();

window.setPenMode = function (m) { window.PenTool.setMode(m); };
// `setPenVariant` is defined in toolbar.js — it updates indicator buttons,
// status-bar label, and forwards to PenTool.setVariant.
