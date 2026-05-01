"use strict";

/* ═══════════════════════════════════════════════════════
   LAYER TRANSFORMS — Pixel Transform (Free Transform)
   Loaded after script.js; all globals (layers, canvasW, zoom,
   pxTransformActive, pxTransformData, …) are declared in
   core/state.js and core/constants.js and are available at
   call-time.
   ═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════
   PIXEL TRANSFORM (Free Transform)
   ═══════════════════════════════════════════════════════ */

function getLayerContentBounds(layer) {
  const data = layer.ctx.getImageData(0, 0, canvasW, canvasH).data;
  let minX = canvasW, minY = canvasH, maxX = -1, maxY = -1;
  for (let y = 0; y < canvasH; y++) { for (let x = 0; x < canvasW; x++) { if (data[(y * canvasW + x) * 4 + 3] > 0) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; } } }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function initPixelTransform(_skipUndo) {
  if (pxTransformActive) return;
  const layer = getActiveLayer(); if (!layer || !layer.visible) return;
  if (floatingActive) commitFloating();
  let bounds; let irregular = false;
  if (selectionPath && selection) {
    bounds = getSelectionBounds(); if (!bounds || bounds.w < 1 || bounds.h < 1) return;
    bounds = { x: Math.round(bounds.x), y: Math.round(bounds.y), w: Math.round(bounds.w), h: Math.round(bounds.h) };
    irregular = (selection.type !== 'rect');
  } else { bounds = getLayerContentBounds(layer); if (!bounds) return; }
  const srcCanvas = document.createElement('canvas'); srcCanvas.width = bounds.w; srcCanvas.height = bounds.h;
  const srcCtx = srcCanvas.getContext('2d');
  let origPath = null;
  if (selectionPath && irregular) { origPath = new Path2D(); origPath.addPath(selectionPath); }
  if (selectionPath) {
    const tmp = document.createElement('canvas'); tmp.width = canvasW; tmp.height = canvasH;
    const tctx = tmp.getContext('2d'); tctx.save(); tctx.clip(selectionPath, selectionFillRule); tctx.drawImage(layer.canvas, 0, 0); tctx.restore();
    srcCtx.drawImage(tmp, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
    layer.ctx.save(); layer.ctx.clip(selectionPath, selectionFillRule); layer.ctx.clearRect(0, 0, canvasW, canvasH); layer.ctx.restore();
  } else {
    srcCtx.drawImage(layer.canvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
    layer.ctx.clearRect(bounds.x, bounds.y, bounds.w, bounds.h);
  }
  // totalRotation accumulates across rotation drags (and panel rotate clicks)
  // so the transform behaves like a non-destructive smart object. liveRotation
  // is the transient delta during an active rotation drag. Visible rotation =
  // totalRotation + liveRotation. Both are baked into srcCanvas only at commit.
  pxTransformData = { srcCanvas, srcBounds: { ...bounds }, curBounds: { ...bounds }, isIrregular: irregular, origSelPath: origPath, liveRotation: 0, totalRotation: 0 };
  pxTransformActive = true; compositeAll(); drawOverlay();
  updateMoveDeselectButtonState();
}

function commitPixelTransform(_skipUndo) {
  if (!pxTransformActive || !pxTransformData) return;
  // Flush any pending nudge so the session state is fully materialized before
  // we bake and stamp.
  if (_nudgePending) flushNudgeUndo();
  if (!pxTransformActive || !pxTransformData) return;
  // Smart-object commit: bake ALL accumulated rotation (persistent total plus
  // any stray live delta) into srcCanvas before stamping.
  const pendingRot = (pxTransformData.totalRotation || 0) + (pxTransformData.liveRotation || 0);
  if (pendingRot) bakeInteractiveRotation(pendingRot);
  const origBounds = { ...pxTransformData.srcBounds };
  const finalBounds = { ...pxTransformData.curBounds };
  const moved = (origBounds.x !== finalBounds.x || origBounds.y !== finalBounds.y ||
                 origBounds.w !== finalBounds.w || origBounds.h !== finalBounds.h) || !!pendingRot;
  const layer = getActiveLayer();
  if (layer) { const d = pxTransformData; layer.ctx.drawImage(d.srcCanvas, 0, 0, d.srcCanvas.width, d.srcCanvas.height, d.curBounds.x, d.curBounds.y, d.curBounds.w, d.curBounds.h); SnapEngine.invalidateLayer(layer); }
  const cb = pxTransformData.curBounds;
  selection = { type: 'rect', x: cb.x, y: cb.y, w: cb.w, h: cb.h }; buildSelectionPath();
  pxTransformActive = false; pxTransformData = null; pxTransformHandle = null; pxTransformStartMouse = null; pxTransformOrigBounds = null;
  compositeAll(); drawOverlay(); updateLayerPanel();
  updateMoveDeselectButtonState();
  if (!_skipUndo && moved) pushUndo('Free Transform');
}

function cancelPixelTransform() {
  if (!pxTransformActive || !pxTransformData) return;
  // Escape during a nudge burst: drop the pending undo with the transform.
  if (_nudgeTimer) { clearTimeout(_nudgeTimer); _nudgeTimer = null; }
  _nudgePending = false;
  const layer = getActiveLayer();
  if (layer) { const d = pxTransformData; layer.ctx.drawImage(d.srcCanvas, 0, 0, d.srcCanvas.width, d.srcCanvas.height, d.srcBounds.x, d.srcBounds.y, d.srcBounds.w, d.srcBounds.h); SnapEngine.invalidateLayer(layer); }
  pxTransformActive = false; pxTransformData = null; pxTransformHandle = null; pxTransformStartMouse = null; pxTransformOrigBounds = null;
  _rotateCenter = null; _rotateStartAngle = 0;
  compositeAll(); drawOverlay(); updateLayerPanel();
  updateMoveDeselectButtonState();
}

function hitTestPxTransform(px, py) {
  if (!pxTransformActive || !pxTransformData) return null;
  // Rotation hit zones take priority since they live outside the box edge
  // where no other handle exists. Checked before the resize/move handles so
  // that the curved-arrow affordance wins over the (nonexistent) edge space.
  const rot = hitTestPxTransformRotate(px, py);
  if (rot) return 'rotate';
  const b = pxTransformData.curBounds; const t = 8 / zoom; const {x, y, w, h} = b;
  // Inverse-rotate the input point into the transform's local (unrotated)
  // frame so all subsequent tests can use axis-aligned geometry.
  const theta = pxTransformData.totalRotation || 0;
  let lx = px, ly = py;
  if (theta) {
    const cx = x + w / 2, cy = y + h / 2;
    const c = Math.cos(-theta), s = Math.sin(-theta);
    const dx0 = px - cx, dy0 = py - cy;
    lx = cx + dx0 * c - dy0 * s;
    ly = cy + dx0 * s + dy0 * c;
  }
  const handles = [{n:'nw',hx:x,hy:y},{n:'n',hx:x+w/2,hy:y},{n:'ne',hx:x+w,hy:y},{n:'w',hx:x,hy:y+h/2},{n:'e',hx:x+w,hy:y+h/2},{n:'sw',hx:x,hy:y+h},{n:'s',hx:x+w/2,hy:y+h},{n:'se',hx:x+w,hy:y+h}];
  for (const hd of handles) { if (Math.abs(lx - hd.hx) <= t && Math.abs(ly - hd.hy) <= t) return hd.n; }
  if (lx >= x && lx <= x + w && ly >= y && ly <= y + h) return 'move';
  return null;
}

/**
 * Bakes the current live rotation into a new srcCanvas, updating curBounds
 * to the rotated AABB centered on the original curBounds center. Preserves
 * any prior resize because the source is drawn at curBounds width/height,
 * not srcCanvas native width/height. Does NOT push undo or re-render —
 * callers handle both.
 */
function bakeInteractiveRotation(rad) {
  if (!pxTransformActive || !pxTransformData) return;
  const d = pxTransformData;
  const cw = d.curBounds.w, ch = d.curBounds.h;
  const absCos = Math.abs(Math.cos(rad));
  const absSin = Math.abs(Math.sin(rad));
  const newW = Math.max(1, Math.ceil(cw * absCos + ch * absSin));
  const newH = Math.max(1, Math.ceil(cw * absSin + ch * absCos));
  const rotCanvas = document.createElement('canvas');
  rotCanvas.width = newW; rotCanvas.height = newH;
  const rCtx = rotCanvas.getContext('2d');
  rCtx.imageSmoothingEnabled = true;
  rCtx.imageSmoothingQuality = 'high';
  rCtx.translate(newW / 2, newH / 2);
  rCtx.rotate(rad);
  rCtx.drawImage(d.srcCanvas, 0, 0, d.srcCanvas.width, d.srcCanvas.height, -cw / 2, -ch / 2, cw, ch);
  const cx = d.curBounds.x + d.curBounds.w / 2;
  const cy = d.curBounds.y + d.curBounds.h / 2;
  d.srcCanvas = rotCanvas;
  d.curBounds.w = newW; d.curBounds.h = newH;
  d.curBounds.x = Math.round(cx - newW / 2);
  d.curBounds.y = Math.round(cy - newH / 2);
  d.isIrregular = false; d.origSelPath = null;
  d.liveRotation = 0;
  d.totalRotation = 0;
}

/**
 * Rotation zones for the Pixel Transform box. Four small circular targets
 * sit just outside each center-edge handle (n/s/e/w). Returns the zone id
 * if the point hits any zone, otherwise null.
 *
 *   • Offset: 18 screen-px outside the edge (scaled by zoom).
 *   • Radius: 11 screen-px hit-target.
 *
 * Photoshop puts rotation affordances near the corners — we use the center
 * edges because the corners are already claimed by diagonal resize handles
 * and the user specifically asked for rotation above the center edges.
 */
function hitTestPxTransformRotate(px, py) {
  if (!pxTransformActive || !pxTransformData) return null;
  const b = pxTransformData.curBounds;
  // Inverse-rotate the input point so we can reuse axis-aligned zone tests.
  const theta = pxTransformData.totalRotation || 0;
  let lx = px, ly = py;
  if (theta) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const c = Math.cos(-theta), s = Math.sin(-theta);
    const dx0 = px - cx, dy0 = py - cy;
    lx = cx + dx0 * c - dy0 * s;
    ly = cy + dx0 * s + dy0 * c;
  }
  const off = 18 / zoom;
  const r   = 11 / zoom;
  const zones = [
    { cx: b.x + b.w / 2, cy: b.y - off       },
    { cx: b.x + b.w / 2, cy: b.y + b.h + off },
    { cx: b.x - off,       cy: b.y + b.h / 2 },
    { cx: b.x + b.w + off, cy: b.y + b.h / 2 },
  ];
  const r2 = r * r;
  for (const z of zones) {
    const dx = lx - z.cx, dy = ly - z.cy;
    if (dx * dx + dy * dy <= r2) return 'rotate';
  }
  return null;
}

/**
 * Arrow-key nudge for the active Pixel Transform OR floating selection.
 * Called with a 1px (plain arrow) or 10px (Shift+arrow) delta. Visually
 * moves the content immediately; undo is coalesced via flushNudgeUndo()
 * so a burst of consecutive nudges produces a single history entry.
 *
 * Returns true if the keystroke was consumed.
 */
function nudgeMove(dx, dy) {
  if (pxTransformActive && pxTransformData) {
    // Any in-progress rotation drag makes arrow keys ambiguous — bail.
    if (pxTransformHandle) return false;
    pxTransformData.curBounds.x += dx;
    pxTransformData.curBounds.y += dy;
    compositeAll(); drawOverlay(); updatePropertiesPanel();
    _nudgePending = true;
    if (_nudgeTimer) clearTimeout(_nudgeTimer);
    _nudgeTimer = setTimeout(flushNudgeUndo, NUDGE_IDLE_MS);
    return true;
  }
  if (floatingActive && floatingCanvas && currentTool === 'move') {
    floatingOffset.x += dx;
    floatingOffset.y += dy;
    compositeAll(); drawOverlay(); updatePropertiesPanel();
    _nudgePending = true;
    if (_nudgeTimer) clearTimeout(_nudgeTimer);
    _nudgeTimer = setTimeout(flushNudgeUndo, NUDGE_IDLE_MS);
    return true;
  }
  if (currentTool === 'movesel' && selection && !transformHandleDrag) {
    // Move Selection tool: arrow keys nudge the selection geometry only
    // (no layer pixels move). Undo coalesces via flushNudgeUndo like the
    // other branches so a burst of key presses is one history entry.
    const sb = getSelectionBounds();
    if (!sb) return false;
    applySelectionMove(sb, dx, dy);
    buildSelectionPath(); drawOverlay(); updatePropertiesPanel();
    _nudgePending = true;
    if (_nudgeTimer) clearTimeout(_nudgeTimer);
    _nudgeTimer = setTimeout(flushNudgeUndo, NUDGE_IDLE_MS);
    return true;
  }
  return false;
}

/**
 * Commits any pending nudge burst as a single 'Nudge' undo entry. Safe to
 * call at any time — no-ops when no nudge is pending. Mirrors the mouseup
 * drag-end flow: stamp srcCanvas to layer, push undo, re-enter the
 * transform session so the user can keep editing.
 */
function flushNudgeUndo() {
  if (_nudgeTimer) { clearTimeout(_nudgeTimer); _nudgeTimer = null; }
  if (!_nudgePending) return;
  _nudgePending = false;
  if (pxTransformActive && pxTransformData) {
    // Smart-object Free Transform: arrow-key nudges accumulate into curBounds
    // but are NOT committed as their own history entry. The whole session is
    // captured by a single 'Free Transform' entry at commit time.
    return;
  }
  if (floatingActive) {
    pushUndo('Nudge');
  } else if (currentTool === 'movesel' && selection) {
    pushUndo('Move Selection');
  }
}

function computePxTransformBounds(handle, mx, my, shiftKey, altKey) {
  const orig = pxTransformOrigBounds; const start = pxTransformStartMouse;
  let dx = mx - start.x; let dy = my - start.y;
  // Resize handles live on the rotated box but operate on the unrotated AABB.
  // Inverse-rotate the drag delta into the object's local frame so corner and
  // edge drags feel natural regardless of totalRotation. Move is unaffected —
  // translation happens in canvas space because the center moves rigidly.
  const theta = (pxTransformData && pxTransformData.totalRotation) || 0;
  if (theta && handle !== 'move') {
    const c = Math.cos(-theta), s = Math.sin(-theta);
    const ldx = dx * c - dy * s;
    const ldy = dx * s + dy * c;
    dx = ldx; dy = ldy;
  }
  let nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;
  if (handle === 'move') { nx += dx; ny += dy; }
  else {
    if (handle === 'nw') { nx += dx; ny += dy; nw -= dx; nh -= dy; }
    else if (handle === 'n') { ny += dy; nh -= dy; } else if (handle === 'ne') { nw += dx; ny += dy; nh -= dy; }
    else if (handle === 'w') { nx += dx; nw -= dx; } else if (handle === 'e') { nw += dx; }
    else if (handle === 'sw') { nx += dx; nw -= dx; nh += dy; } else if (handle === 's') { nh += dy; } else if (handle === 'se') { nw += dx; nh += dy; }
    if (shiftKey && handle !== 'move') {
      const aspect = orig.w / orig.h;
      if (['n','s'].includes(handle)) { nw = Math.round(nh * aspect); nx = orig.x + Math.round((orig.w - nw) / 2); }
      else if (['w','e'].includes(handle)) { nh = Math.round(nw / aspect); ny = orig.y + Math.round((orig.h - nh) / 2); }
      else { const ratioW = nw / orig.w; const ratioH = nh / orig.h; if (Math.abs(ratioW) > Math.abs(ratioH)) { nh = Math.round(nw / aspect); } else { nw = Math.round(nh * aspect); } if (handle.includes('n')) ny = orig.y + orig.h - nh; if (handle.includes('w')) nx = orig.x + orig.w - nw; }
    }
    if (altKey && handle !== 'move') { const centerX = orig.x + orig.w / 2; const centerY = orig.y + orig.h / 2; nx = Math.round(centerX - nw / 2); ny = Math.round(centerY - nh / 2); }
    if (nw < 1) nw = 1; if (nh < 1) nh = 1;
  }
  return { x: nx, y: ny, w: nw, h: nh };
}

/* ═══════════════════════════════════════════════════════
   SMART OBJECT TRANSFORM — Engage / place transform sessions
   ═══════════════════════════════════════════════════════ */

/**
 * engageSmartObjectTransform — Installs a pxTransform session over a freshly-
 * stamped image while preserving the FULL source pixels (including any
 * portions outside the canvas) so the user can drag, scale, and rotate the
 * incoming image as a smart object until they commit. Call this AFTER
 * stamping the (clipped) image into the active layer and AFTER pushUndo, so
 * the history snapshot captures the post-stamp state. The helper then:
 *   1. Builds an internal srcCanvas at the image's true dimensions.
 *   2. Sets pxTransformData with srcBounds/curBounds at the requested origin
 *      (these may extend beyond the canvas; composite + commit handle that).
 *   3. Clears the stamped region from the active layer so the live composite
 *      doesn't render the underlay beneath the floating smart object.
 * On commit, the full srcCanvas is stamped at curBounds (clipping at the
 * canvas edge as expected). On cancel, srcCanvas is restamped at srcBounds,
 * restoring the post-stamp visual state captured by history.
 */
function engageSmartObjectTransform(srcCanvas, originX, originY) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const layer = getActiveLayer();
  if (!layer) return;

  const internalSrc = document.createElement('canvas');
  internalSrc.width = w; internalSrc.height = h;
  internalSrc.getContext('2d').drawImage(srcCanvas, 0, 0);

  pxTransformData = {
    srcCanvas: internalSrc,
    srcBounds: { x: originX, y: originY, w, h },
    curBounds: { x: originX, y: originY, w, h },
    isIrregular: false,
    origSelPath: null,
    liveRotation: 0,
    totalRotation: 0
  };
  pxTransformActive = true;

  const cx0 = Math.max(0, originX), cy0 = Math.max(0, originY);
  const cx1 = Math.min(canvasW, originX + w), cy1 = Math.min(canvasH, originY + h);
  if (cx1 > cx0 && cy1 > cy0) {
    layer.ctx.clearRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
  }
  SnapEngine.invalidateLayer(layer);
  updateMoveDeselectButtonState();
}

/**
 * placeImageAsTransformLayer — Inserts a full-resolution image as a new
 * layer and engages a smart-object Free Transform session. Off-canvas pixels
 * are preserved in pxTransformData.srcCanvas during the live drag and are
 * only clipped at the canvas edge when the user commits.
 */
function placeImageAsTransformLayer(srcCanvas, layerName, originX, originY) {
  if (pxTransformActive) commitPixelTransform();
  if (floatingActive) commitFloating();
  const w = srcCanvas.width, h = srcCanvas.height;
  const layerCanvas = document.createElement('canvas');
  layerCanvas.width = canvasW; layerCanvas.height = canvasH;
  const layerCtx = layerCanvas.getContext('2d', { willReadFrequently: true });
  layerCtx.drawImage(srcCanvas, originX, originY);
  const layer = { id: layerIdCounter++, name: layerName, canvas: layerCanvas, ctx: layerCtx, visible: true, opacity: 1 };
  const insertAt = Math.max(0, activeLayerIndex);
  layers.splice(insertAt, 0, layer);
  activeLayerIndex = layers.indexOf(layer);
  selectedLayers = new Set([activeLayerIndex]);
  SnapEngine.invalidateLayer(layer);

  selection = { type: 'rect', x: originX, y: originY, w, h };
  selectionFillRule = 'nonzero';
  selectionPath = new Path2D();
  selectionPath.rect(originX, originY, w, h);

  _pxTransformWasActiveForPush = true;
  pushUndo(`Import "${layerName}"`);

  engageSmartObjectTransform(srcCanvas, originX, originY);
  selectTool('move');
  compositeAll();
  drawOverlay();
  updateLayerPanel();
}

/* ═══════════════════════════════════════════════════════
   PROPERTIES PANEL — Pixel Transform controls
   ═══════════════════════════════════════════════════════ */

function propsRotatePixelTransform(angleDeg) {
  if (!pxTransformActive || !pxTransformData) return;
  // Smart-object transform: panel rotate buttons accumulate into
  // totalRotation just like the interactive rotation drag. Nothing is
  // baked into srcCanvas until the session is committed, so the pixels
  // stay lossless across any number of rotate clicks.
  const rad = angleDeg * Math.PI / 180;
  pxTransformData.totalRotation = (pxTransformData.totalRotation || 0) + rad;
  compositeAll(); drawOverlay();
  updatePropertiesPanel();
}

function propsFlipPixelTransform(axis) {
  if (!pxTransformActive || !pxTransformData) return;
  const d = pxTransformData;
  // Flip acts on srcCanvas pixels, so any accumulated rotation must be
  // baked first — otherwise the flip would apply in the unrotated source
  // frame rather than the frame the user actually sees.
  const pending = (d.totalRotation || 0) + (d.liveRotation || 0);
  if (pending) bakeInteractiveRotation(pending);
  const src = d.srcCanvas;
  const flipped = document.createElement('canvas');
  flipped.width = src.width; flipped.height = src.height;
  const fCtx = flipped.getContext('2d');
  if (axis === 'h') { fCtx.translate(src.width, 0); fCtx.scale(-1, 1); }
  else { fCtx.translate(0, src.height); fCtx.scale(1, -1); }
  fCtx.drawImage(src, 0, 0);
  d.srcCanvas = flipped;
  compositeAll(); drawOverlay();
  // No history push — the flip is part of the live session and will be
  // captured by the single 'Free Transform' entry at commit time.
}

function propsAlignPixelTransform(align) {
  if (!pxTransformActive || !pxTransformData) return;
  const cb = pxTransformData.curBounds;
  // Photoshop-style: each button moves on a single axis only; the
  // perpendicular axis stays at the object's current position.
  switch (align) {
    case 'l':  cb.x = 0; break;
    case 'ch': cb.x = Math.round((canvasW - cb.w) / 2); break;
    case 'r':  cb.x = canvasW - cb.w; break;
    case 't':  cb.y = 0; break;
    case 'cv': cb.y = Math.round((canvasH - cb.h) / 2); break;
    case 'b':  cb.y = canvasH - cb.h; break;
    default: return;
  }
  compositeAll(); drawOverlay();
  updatePropertiesPanel();
  // No history push — alignment is part of the live session and folds into
  // the single 'Free Transform' entry at commit time.
}
