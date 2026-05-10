"use strict";

/* ═══════════════════════════════════════════════════════
   DIRECT SELECTION — Illustrator-style anchor-point editing.
   Standalone tool (data-tool="directselect", shortcut A).
   Edits individual anchors of existing shapes; on first edit
   a rect is converted to a freeform path (rotation baked into
   the points). Ellipse stays parametric (cardinal drag
   changes w/h around the opposite anchor). Line stays
   parametric (endpoint drag).

   Public surface (window.DirectSelection):
     open(layer)              — enter direct-select mode on a layer
     close()                  — exit
     isOpen()                 — boolean
     onZoomChange()           — re-render overlay after zoom
     hasSelection()           — any anchors selected?
     selectionCount()         — count of selected anchors
   ═══════════════════════════════════════════════════════ */

window.DirectSelection = (function () {

  const ANCHOR_HIT_PAD = 6;   // screen pixels for anchor hit-test slop

  // session = {
  //   layer,
  //   selectedAnchors: [{ shapeId, key }],
  //   overlayEl,
  //   dragOp: null | { ... }
  // }
  let session = null;
  let _docMouseMove = null;
  let _docMouseUp = null;

  // ── Helpers ─────────────────────────────────────────────────

  function _overlayRoot() {
    return (typeof workspace !== 'undefined' && workspace) || document.getElementById('workspace');
  }

  function _shapesOnLayer(layer) {
    return (layer && layer.shapeModel && layer.shapeModel.shapes) ? layer.shapeModel.shapes : [];
  }

  function _findShape(layer, shapeId) {
    return _shapesOnLayer(layer).find(s => s.id === shapeId) || null;
  }

  function _isAnchorSelected(shapeId, key) {
    if (!session) return false;
    return session.selectedAnchors.some(a => a.shapeId === shapeId && a.key === key);
  }

  function _selectionEntry(shapeId, key) {
    if (!session) return null;
    return session.selectedAnchors.find(a => a.shapeId === shapeId && a.key === key) || null;
  }

  function _clearAnchorSelection() {
    if (!session) return;
    session.selectedAnchors = [];
  }

  function _setAnchorSelection(entries) {
    if (!session) return;
    session.selectedAnchors = entries.slice();
  }

  function _addAnchor(shapeId, key) {
    if (!session) return;
    if (!_isAnchorSelected(shapeId, key)) session.selectedAnchors.push({ shapeId, key });
  }

  function _removeAnchor(shapeId, key) {
    if (!session) return;
    session.selectedAnchors = session.selectedAnchors.filter(a => !(a.shapeId === shapeId && a.key === key));
  }

  // ── Anchor drag application ─────────────────────────────────

  // Local clone — DirectSelection needs to snapshot a shape independently
  // of ShapeTool's internal helper so the snapshot survives across rect→path
  // conversion. Mirrors ShapeTool's _cloneShape contract.
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
      cp.points = (s.points || []).map(p => {
        const pt = { x: p.x, y: p.y };
        if (p.type)            pt.type = p.type;
        if (p.ohx !== undefined) { pt.ohx = p.ohx; pt.ohy = p.ohy; }
        if (p.ihx !== undefined) { pt.ihx = p.ihx; pt.ihy = p.ihy; }
        return pt;
      });
      cp.closed = !!s.closed;
    } else {
      cp.x = s.x; cp.y = s.y; cp.w = s.w; cp.h = s.h;
      if (s.type === 'rect') cp.cornerRadius = s.cornerRadius || 0;
    }
    return cp;
  }

  // Apply a drag to the selected anchor. `originalShape` is the shape state
  // at drag-start (snapshot) — used so multi-frame drags compute from the
  // original geometry, not the cumulative previous-frame result. For rects,
  // the live `shape` is converted to a path on first call (rotation baked
  // into points). Returns true if the live shape was converted this call.
  function _applyAnchorDrag(layer, shape, key, newX, newY, originalShape) {
    if (!shape) return false;
    const orig = originalShape || shape;
    if (shape.type === 'line') {
      if (key === 'p1') { shape.p1.x = newX; shape.p1.y = newY; }
      else if (key === 'p2') { shape.p2.x = newX; shape.p2.y = newY; }
      return false;
    }
    if (shape.type === 'ellipse') {
      // Convert to a path on first edit so the cardinal anchor can be moved
      // freely (matches Illustrator). The 4-anchor cubic-bezier ellipse
      // approximation lives in convertShapeToPath; cardinal keys map to
      // anchor indices in N/E/S/W order.
      const map = { n: 0, e: 1, s: 2, w: 3 };
      const idx = map[key];
      window.ShapeTool.convertShapeToPath(shape);
      if (idx != null && shape.points[idx]) {
        const orig_pt = shape.points[idx];
        const dx = newX - orig_pt.x, dy = newY - orig_pt.y;
        const lp = shape.points[idx];
        lp.x = newX; lp.y = newY;
        if (orig_pt.ohx !== undefined) { lp.ohx = orig_pt.ohx + dx; lp.ohy = orig_pt.ohy + dy; }
        if (orig_pt.ihx !== undefined) { lp.ihx = orig_pt.ihx + dx; lp.ihy = orig_pt.ihy + dy; }
      }
      return true;
    }
    if (shape.type === 'rect') {
      // Convert to a path on first edit; rotation gets baked in.
      const map = { nw: 0, ne: 1, se: 2, sw: 3 };
      const idx = map[key];
      window.ShapeTool.convertShapeToPath(shape);
      if (idx != null && shape.points[idx]) {
        shape.points[idx].x = newX;
        shape.points[idx].y = newY;
      }
      return true;
    }
    if (shape.type === 'path') {
      const idx = parseInt(key.slice(1), 10);
      if (Number.isFinite(idx) && shape.points[idx]) {
        const orig_pt = orig.points[idx];
        const dx = newX - orig_pt.x, dy = newY - orig_pt.y;
        const lp = shape.points[idx];
        lp.x = newX; lp.y = newY;
        if (orig_pt.ohx !== undefined) { lp.ohx = orig_pt.ohx + dx; lp.ohy = orig_pt.ohy + dy; }
        if (orig_pt.ihx !== undefined) { lp.ihx = orig_pt.ihx + dx; lp.ihy = orig_pt.ihy + dy; }
      }
      return false;
    }
    return false;
  }

  // After a rect→path conversion, anchor keys 'nw'/'ne'/'se'/'sw' must be
  // remapped to 'p0'/'p1'/'p2'/'p3' so subsequent rendering and selection
  // continue to track the correct anchor.
  function _remapKeyAfterConversion(prevType, key) {
    if (prevType === 'rect') {
      const map = { nw: 'p0', ne: 'p1', se: 'p2', sw: 'p3' };
      return map[key] || key;
    }
    if (prevType === 'ellipse') {
      const map = { n: 'p0', e: 'p1', s: 'p2', w: 'p3' };
      return map[key] || key;
    }
    if (prevType === 'line') {
      return (key === 'p1') ? 'p0' : (key === 'p2') ? 'p1' : key;
    }
    return key;
  }

  // ── Hit testing anchors ────────────────────────────────────

  // Returns { shape, key } if (px, py) is over an anchor of any shape on
  // the active layer; null otherwise. Uses screen-space tolerance so the
  // hit slop stays consistent across zoom levels.
  function _hitAnchor(px, py) {
    if (!session) return null;
    const z = (typeof zoom !== 'undefined') ? zoom : 1;
    const tol = ANCHOR_HIT_PAD / z;
    const shapes = _shapesOnLayer(session.layer);
    // Iterate top-down so visually-on-top anchors win.
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      const anchors = window.ShapeTool.getShapeAnchors(s);
      for (let j = anchors.length - 1; j >= 0; j--) {
        const a = anchors[j];
        if (Math.hypot(px - a.x, py - a.y) <= tol) {
          return { shape: s, key: a.key };
        }
      }
    }
    return null;
  }

  // ── Overlay rendering ──────────────────────────────────────

  function _renderOverlay() {
    if (!session) return;
    const root = session.overlayEl;
    if (!root) return;
    root.innerHTML = '';

    // Hover-reveal outlines + anchors for shapes on OTHER visible shape
    // layers (so the user can see/select them without switching layers).
    const allLayers = (typeof layers !== 'undefined' && Array.isArray(layers)) ? layers : [];
    const ST = window.ShapeTool;
    for (const L of allLayers) {
      if (!L || !L.visible || L.kind !== 'shape' || !L.shapeModel) continue;
      if (L === session.layer) continue;
      for (const sh of L.shapeModel.shapes) {
        if (ST && ST._drawShapeOutlineHover) ST._drawShapeOutlineHover(root, sh);
        if (ST && ST.getShapeAnchors) {
          const anchors = ST.getShapeAnchors(sh);
          for (const a of anchors) _drawHoverAnchorEl(root, a.x, a.y);
        }
      }
    }

    // Active-layer shapes: outline always visible + clickable anchors.
    const shapes = _shapesOnLayer(session.layer);
    for (const s of shapes) {
      _drawShapeOutline(root, s);
      const anchors = window.ShapeTool.getShapeAnchors(s);
      for (const a of anchors) {
        const sel = _isAnchorSelected(s.id, a.key);
        _placeAnchorDot(root, a.x, a.y, s.id, a.key, sel);
      }
    }
  }

  // Hover-reveal anchor dot for shapes on non-active layers. opacity-0 by
  // default; reveals on hover. Same .ds-anchor styling so it visually matches.
  function _drawHoverAnchorEl(root, ax, ay) {
    const p = c2s(ax, ay);
    const el = document.createElement('div');
    el.className = 'ds-anchor';
    el.style.left = p.x + 'px';
    el.style.top  = p.y + 'px';
    el.style.opacity = '0';
    el.style.pointerEvents = 'auto';
    el.addEventListener('mouseenter', () => { el.style.opacity = '1'; });
    el.addEventListener('mouseleave', () => { el.style.opacity = '0'; });
    root.appendChild(el);
  }

  // Draw the shape outline (just the shape's geometry, no bounding box) as
  // dashed-blue lines so the user sees the path they're editing.
  function _drawShapeOutline(root, s) {
    if (s.type === 'line') {
      const a = c2s(s.p1.x, s.p1.y);
      const b = c2s(s.p2.x, s.p2.y);
      _drawLineEl(root, a, b);
      return;
    }
    if (s.type === 'path') {
      const pts = s.points || [];
      if (pts.length < 2) return;
      const _drawSeg = (p0, p1) => {
        const cp1x = p0.ohx !== undefined ? p0.ohx : p0.x;
        const cp1y = p0.ohy !== undefined ? p0.ohy : p0.y;
        const cp2x = p1.ihx !== undefined ? p1.ihx : p1.x;
        const cp2y = p1.ihy !== undefined ? p1.ihy : p1.y;
        if (cp1x === p0.x && cp1y === p0.y && cp2x === p1.x && cp2y === p1.y) {
          _drawLineEl(root, c2s(p0.x, p0.y), c2s(p1.x, p1.y));
        } else {
          let prev = c2s(p0.x, p0.y);
          for (let j = 1; j <= 8; j++) {
            const t = j / 8, mt = 1 - t;
            const bx = mt*mt*mt*p0.x + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*p1.x;
            const by = mt*mt*mt*p0.y + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*p1.y;
            const cur = c2s(bx, by);
            _drawLineEl(root, prev, cur);
            prev = cur;
          }
        }
      };
      for (let i = 0; i < pts.length - 1; i++) _drawSeg(pts[i], pts[i + 1]);
      if (s.closed && pts.length > 2) _drawSeg(pts[pts.length - 1], pts[0]);
      return;
    }
    if (s.type === 'rect') {
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const r = s.rotation || 0;
      const cR = Math.cos(r), sR = Math.sin(r);
      const local = (lx, ly) => c2s(cx + lx * cR - ly * sR, cy + lx * sR + ly * cR);
      const hw = s.w / 2, hh = s.h / 2;
      const corners = [local(-hw,-hh), local(hw,-hh), local(hw,hh), local(-hw,hh)];
      _drawLineEl(root, corners[0], corners[1]);
      _drawLineEl(root, corners[1], corners[2]);
      _drawLineEl(root, corners[2], corners[3]);
      _drawLineEl(root, corners[3], corners[0]);
      return;
    }
    if (s.type === 'ellipse') {
      // Approximate the ellipse outline with a polygon so it tracks the
      // (potentially rotated) shape without needing canvas-style ellipse
      // primitives in the DOM overlay.
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      const r = s.rotation || 0;
      const cR = Math.cos(r), sR = Math.sin(r);
      const hw = s.w / 2, hh = s.h / 2;
      const segs = 32;
      let prev = null;
      for (let i = 0; i <= segs; i++) {
        const th = (i / segs) * Math.PI * 2;
        const lx = Math.cos(th) * hw, ly = Math.sin(th) * hh;
        const wp = c2s(cx + lx * cR - ly * sR, cy + lx * sR + ly * cR);
        if (prev) _drawLineEl(root, prev, wp);
        prev = wp;
      }
    }
  }

  function _drawLineEl(root, p1, p2) {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    const el = document.createElement('div');
    el.className = 'ds-edge';
    el.style.left = p1.x + 'px';
    el.style.top  = p1.y + 'px';
    el.style.width = len + 'px';
    el.style.transform = 'rotate(' + angle + 'deg)';
    root.appendChild(el);
  }

  function _placeAnchorDot(root, cx, cy, shapeId, key, selected) {
    const p = c2s(cx, cy);
    const el = document.createElement('div');
    el.className = 'ds-anchor' + (selected ? ' is-selected' : '');
    el.style.left = p.x + 'px';
    el.style.top  = p.y + 'px';
    el.dataset.shapeId = shapeId;
    el.dataset.anchorKey = key;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      _onAnchorMouseDown(e, shapeId, key);
    });
    root.appendChild(el);
  }

  // ── Mouse handling ─────────────────────────────────────────

  function _onAnchorMouseDown(e, shapeId, key) {
    if (!session) return;
    const shape = _findShape(session.layer, shapeId);
    if (!shape) return;

    if (e.shiftKey) {
      if (_isAnchorSelected(shapeId, key)) _removeAnchor(shapeId, key);
      else _addAnchor(shapeId, key);
    } else if (!_isAnchorSelected(shapeId, key)) {
      _setAnchorSelection([{ shapeId, key }]);
    }

    _renderOverlay();
    _refreshOptionsBar();

    if (!session.selectedAnchors.length) return;
    _beginAnchorDrag(e);
  }

  function _beginAnchorDrag(e) {
    if (!session || !session.selectedAnchors.length) return;
    const start = screenToCanvas(e.clientX, e.clientY);
    // Snapshot each shape and the dragged anchor's start position so the
    // drag computes from the original state every frame (idempotent),
    // rather than chaining off the previous frame's result.
    const startStates = session.selectedAnchors.map(sel => {
      const sh = _findShape(session.layer, sel.shapeId);
      if (!sh) return null;
      const anchors = window.ShapeTool.getShapeAnchors(sh);
      const a = anchors.find(x => x.key === sel.key);
      return a ? {
        shapeId: sel.shapeId,
        key: sel.key,
        startX: a.x, startY: a.y,
        snapshot: _cloneShape(sh)
      } : null;
    }).filter(Boolean);

    session.dragOp = { startMouse: start, startStates, changed: false };

    // Snap the dragged anchor against guides / canvas bounds / other layers'
    // edges. Excludes the active layer so the dragged anchor doesn't snap
    // to its own shape's geometry.
    if (typeof SnapEngine !== 'undefined') {
      const excl = new Set();
      if (session.layer && session.layer.id != null) excl.add(session.layer.id);
      SnapEngine.beginSession({ excludeLayerIds: excl, excludeSelection: true });
    }

    _docMouseMove = _onDragMove;
    _docMouseUp = _onDragUp;
    document.addEventListener('mousemove', _docMouseMove);
    document.addEventListener('mouseup', _docMouseUp);
  }

  function _onDragMove(e) {
    if (!session || !session.dragOp) return;
    const cur = screenToCanvas(e.clientX, e.clientY);
    const op = session.dragOp;
    let dx = cur.x - op.startMouse.x;
    let dy = cur.y - op.startMouse.y;

    // Snap: drive the snap from the primary anchor's target world-position
    // and back-derive the delta applied to all selected anchors.
    if (typeof SnapEngine !== 'undefined' && op.startStates.length) {
      const primary = op.startStates[0];
      const tgt = { x: primary.startX + dx, y: primary.startY + dy };
      const snapped = SnapEngine.snapPoint(tgt, { modifiers: e });
      dx = snapped.x - primary.startX;
      dy = snapped.y - primary.startY;
    }
    if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) op.changed = true;

    // First pass: apply the drag to every selected anchor. Mark which
    // shapes got converted so we can fix up keys + snapshots in pass two.
    const conversions = [];
    for (const st of op.startStates) {
      const shape = _findShape(session.layer, st.shapeId);
      if (!shape) continue;
      const prevType = shape.type;
      const converted = _applyAnchorDrag(
        session.layer, shape, st.key,
        st.startX + dx, st.startY + dy,
        st.snapshot
      );
      if (converted) conversions.push({ st, prevType });
    }

    // Second pass: for any rect→path conversion, remap the key and re-
    // snapshot so subsequent frames operate on the post-conversion state.
    if (conversions.length) {
      for (const { st, prevType } of conversions) {
        const shape = _findShape(session.layer, st.shapeId);
        if (!shape) continue;
        const newKey = _remapKeyAfterConversion(prevType, st.key);
        const selIdx = session.selectedAnchors.findIndex(
          s => s.shapeId === st.shapeId && s.key === st.key);
        if (selIdx >= 0) session.selectedAnchors[selIdx] = { shapeId: st.shapeId, key: newKey };
        const anchors = window.ShapeTool.getShapeAnchors(shape);
        const a = anchors.find(x => x.key === newKey);
        st.key = newKey;
        if (a) { st.startX = a.x; st.startY = a.y; }
        st.snapshot = _cloneShape(shape);
      }
      // Reset the mouse origin to "now" so the next frame's delta is
      // measured from this point — matching the freshly captured starts.
      op.startMouse = cur;
    }

    if (typeof window.ShapeTool.renderShapeLayer === 'function') {
      window.ShapeTool.renderShapeLayer(session.layer);
    }
    if (typeof compositeAll === 'function') compositeAll();
    _renderOverlay();
    _refreshOptionsBar();
  }

  function _onDragUp(e) {
    if (!session) return;
    const op = session.dragOp;
    session.dragOp = null;
    if (_docMouseMove) document.removeEventListener('mousemove', _docMouseMove);
    if (_docMouseUp)   document.removeEventListener('mouseup',   _docMouseUp);
    _docMouseMove = null;
    _docMouseUp = null;
    if (typeof SnapEngine !== 'undefined') SnapEngine.endSession();
    if (op && op.changed && typeof pushUndo === 'function') {
      pushUndo('Edit Anchor');
    }
  }

  // ── Public mouse-down entry ───────────────────────────────

  function handleMouseDown(e, pos) {
    if (!session) return false;
    if (e.button !== 0) return false;
    // Anchor hit on the active layer?
    const hit = _hitAnchor(pos.x, pos.y);
    if (hit) {
      _onAnchorMouseDown(e, hit.shape.id, hit.key);
      return true;
    }
    // No anchor on the active layer — try a cross-layer hit so clicking on a
    // shape on a *different* shape layer auto-switches to that layer.
    if (window.ShapeTool && typeof window.ShapeTool.hitAcrossLayers === 'function') {
      const xhit = window.ShapeTool.hitAcrossLayers(pos.x, pos.y);
      if (xhit && layers[xhit.layerIndex] && layers[xhit.layerIndex] !== session.layer) {
        const newLayer = layers[xhit.layerIndex];
        if (typeof activeLayerIndex !== 'undefined') {
          window.activeLayerIndex = xhit.layerIndex;
          selectedLayers = new Set([xhit.layerIndex]);
          if (typeof updateLayerPanel === 'function') updateLayerPanel();
        }
        open(newLayer);
        // Now re-hit on the freshly opened session — most clicks will land on
        // the shape body rather than an anchor, so just clear anchor selection.
        const newHit = _hitAnchor(pos.x, pos.y);
        if (newHit) {
          _onAnchorMouseDown(e, newHit.shape.id, newHit.key);
        }
        return true;
      }
    }
    // Empty click — clear selection.
    if (!e.shiftKey) {
      _clearAnchorSelection();
      _renderOverlay();
      _refreshOptionsBar();
    }
    return false;
  }

  // ── Options bar ───────────────────────────────────────────

  // Find a single selected anchor's world-space position (for the X/Y
  // inputs). Returns null when 0 or >1 anchors are selected.
  function _singleSelectedAnchor() {
    if (!session || session.selectedAnchors.length !== 1) return null;
    const sel = session.selectedAnchors[0];
    const shape = _findShape(session.layer, sel.shapeId);
    if (!shape) return null;
    const anchors = window.ShapeTool.getShapeAnchors(shape);
    const a = anchors.find(x => x.key === sel.key);
    if (!a) return null;
    return { shape, key: sel.key, x: a.x, y: a.y };
  }

  function _refreshOptionsBar() {
    const single = _singleSelectedAnchor();
    const xEl = document.getElementById('dsAnchorX');
    const yEl = document.getElementById('dsAnchorY');
    const statusEl = document.getElementById('dsStatus');
    const convertBtn = document.getElementById('dsConvertBtn');
    if (xEl && yEl) {
      if (single) {
        xEl.disabled = false; yEl.disabled = false;
        xEl.value = Math.round(single.x);
        yEl.value = Math.round(single.y);
      } else {
        xEl.disabled = true; yEl.disabled = true;
        xEl.value = ''; yEl.value = '';
      }
    }
    if (statusEl) {
      const n = session ? session.selectedAnchors.length : 0;
      if (n === 0) statusEl.textContent = 'No anchors selected';
      else if (n === 1) statusEl.textContent = '1 anchor selected';
      else statusEl.textContent = n + ' anchors selected';
    }
    if (convertBtn) {
      const eligible = session && _shapesOnLayer(session.layer).some(s => s.type !== 'path');
      convertBtn.disabled = !eligible;
    }
    // Mirror to the properties panel so it stays in lockstep with the
    // options-bar X/Y readout.
    if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
  }

  function _showOptionsBar() {
    const el = document.getElementById('opt-direct-select');
    if (el) el.classList.remove('hidden');
  }
  function _hideOptionsBar() {
    const el = document.getElementById('opt-direct-select');
    if (el) el.classList.add('hidden');
  }

  function _wireOptionsBar() {
    const xEl = document.getElementById('dsAnchorX');
    const yEl = document.getElementById('dsAnchorY');
    const onCommit = () => {
      if (!session) return;
      const single = _singleSelectedAnchor();
      if (!single) return;
      const nx = parseFloat(xEl.value);
      const ny = parseFloat(yEl.value);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
      const prevType = single.shape.type;
      const converted = _applyAnchorDrag(session.layer, single.shape, single.key, nx, ny);
      if (converted) {
        const newKey = _remapKeyAfterConversion(prevType, single.key);
        session.selectedAnchors = [{ shapeId: single.shape.id, key: newKey }];
      }
      if (typeof window.ShapeTool.renderShapeLayer === 'function') {
        window.ShapeTool.renderShapeLayer(session.layer);
      }
      if (typeof compositeAll === 'function') compositeAll();
      _renderOverlay();
      _refreshOptionsBar();
      if (typeof pushUndo === 'function') pushUndo('Edit Anchor');
    };
    if (xEl) xEl.addEventListener('change', onCommit);
    if (yEl) yEl.addEventListener('change', onCommit);

    const convertBtn = document.getElementById('dsConvertBtn');
    if (convertBtn) {
      convertBtn.addEventListener('click', () => {
        if (!session) return;
        let any = false;
        const shapes = _shapesOnLayer(session.layer);
        for (const s of shapes) {
          if (s.type !== 'path') {
            window.ShapeTool.convertShapeToPath(s);
            any = true;
          }
        }
        if (any) {
          // Selection keys are no longer valid after conversion.
          _clearAnchorSelection();
          if (typeof window.ShapeTool.renderShapeLayer === 'function') {
            window.ShapeTool.renderShapeLayer(session.layer);
          }
          if (typeof compositeAll === 'function') compositeAll();
          _renderOverlay();
          _refreshOptionsBar();
          if (typeof pushUndo === 'function') pushUndo('Convert to Path');
        }
      });
    }
  }

  // ── Keyboard ──────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (!session) return;
    if (typeof currentTool !== 'undefined' && currentTool !== 'directselect') return;
    const tag = (e.target && e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if (e.key === 'Escape') {
      _clearAnchorSelection();
      _renderOverlay();
      _refreshOptionsBar();
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────

  function open(layer) {
    if (!layer || layer.kind !== 'shape') return;
    if (session && session.layer === layer) {
      _showOptionsBar();
      _renderOverlay();
      _refreshOptionsBar();
      return;
    }
    if (session) close();
    const wrap = _overlayRoot();
    const overlayEl = document.createElement('div');
    overlayEl.className = 'ds-overlay';
    wrap.appendChild(overlayEl);
    session = {
      layer,
      selectedAnchors: [],
      overlayEl,
      dragOp: null
    };
    _showOptionsBar();
    _renderOverlay();
    _refreshOptionsBar();
  }

  function close() {
    if (!session) {
      _hideOptionsBar();
      return;
    }
    if (_docMouseMove) document.removeEventListener('mousemove', _docMouseMove);
    if (_docMouseUp)   document.removeEventListener('mouseup',   _docMouseUp);
    _docMouseMove = null;
    _docMouseUp = null;
    if (session.overlayEl && session.overlayEl.parentNode) {
      session.overlayEl.parentNode.removeChild(session.overlayEl);
    }
    session = null;
    _hideOptionsBar();
  }

  function isOpen() { return !!session; }
  function hasSelection() { return !!(session && session.selectedAnchors.length); }
  function selectionCount() { return session ? session.selectedAnchors.length : 0; }

  function onZoomChange() {
    if (session) _renderOverlay();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireOptionsBar);
  } else {
    _wireOptionsBar();
  }

  // ── Tool registration ─────────────────────────────────────
  ToolRegistry.register('directselect', {
    activate() {
      const layer = (typeof layers !== 'undefined' && typeof activeLayerIndex !== 'undefined')
        ? layers[activeLayerIndex] : null;
      if (layer && layer.kind === 'shape') {
        open(layer);
      } else {
        _showOptionsBar();
      }
      if (typeof workspace !== 'undefined') workspace.style.cursor = 'default';
      if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
    },
    deactivate() {
      close();
      if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
    },
    mouseDown(e, pos) {
      // No active session yet (active layer wasn't a shape on activate). If
      // the user clicks on a shape elsewhere, auto-switch and open.
      if (!session) {
        if (window.ShapeTool && typeof window.ShapeTool.hitAcrossLayers === 'function') {
          const xhit = window.ShapeTool.hitAcrossLayers(pos.x, pos.y);
          if (xhit && layers[xhit.layerIndex]) {
            window.activeLayerIndex = xhit.layerIndex;
            selectedLayers = new Set([xhit.layerIndex]);
            if (typeof updateLayerPanel === 'function') updateLayerPanel();
            open(layers[xhit.layerIndex]);
            const newHit = _hitAnchor(pos.x, pos.y);
            if (newHit) _onAnchorMouseDown(e, newHit.shape.id, newHit.key);
            return true;
          }
        }
        return false;
      }
      return handleMouseDown(e, pos);
    }
  });

  // Public x/y getter for the properties panel — returns null unless exactly
  // one anchor is selected (matches the options-bar single-anchor model).
  function getSingleAnchorPos() {
    const single = _singleSelectedAnchor();
    if (!single) return null;
    return { x: single.x, y: single.y };
  }

  // Public setter for the properties panel. Updates whichever axis is changed,
  // keeps the other from the current anchor position.
  function setSingleAnchorField(field, value) {
    if (!session) return false;
    const single = _singleSelectedAnchor();
    if (!single) return false;
    const num = +value;
    if (!Number.isFinite(num)) return false;
    const nx = field === 'x' ? num : single.x;
    const ny = field === 'y' ? num : single.y;
    const prevType = single.shape.type;
    const converted = _applyAnchorDrag(session.layer, single.shape, single.key, nx, ny);
    if (converted) {
      const newKey = _remapKeyAfterConversion(prevType, single.key);
      session.selectedAnchors = [{ shapeId: single.shape.id, key: newKey }];
    }
    if (typeof window.ShapeTool.renderShapeLayer === 'function') {
      window.ShapeTool.renderShapeLayer(session.layer);
    }
    if (typeof compositeAll === 'function') compositeAll();
    _renderOverlay();
    _refreshOptionsBar();
    if (typeof pushUndo === 'function') pushUndo('Edit Anchor');
    return true;
  }

  return {
    open,
    close,
    isOpen,
    onZoomChange,
    hasSelection,
    selectionCount,
    getSingleAnchorPos,
    setSingleAnchorField
  };
})();
