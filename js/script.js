"use strict";

// rAF-throttled render helpers — caps redraws at 60 fps regardless of mouse poll rate
let _rulerRafPending = false;
function scheduleRulerDraw() {
  if (_rulerRafPending) return;
  _rulerRafPending = true;
  requestAnimationFrame(() => { _rulerRafPending = false; drawRulers(); });
}

let _strokeRafPending = false;
function scheduleStrokeComposite() {
  if (_strokeRafPending) return;
  _strokeRafPending = true;
  requestAnimationFrame(() => { _strokeRafPending = false; compositeAllWithStrokeBuffer(); });
}

let _dragRafPending = false;
function scheduleCompositeAndOverlay() {
  if (_dragRafPending) return;
  _dragRafPending = true;
  requestAnimationFrame(() => { _dragRafPending = false; compositeAll(); drawOverlay(); });
}

/* ═══════════════════════════════════════════════════════════════════════
   UNDO / REDO — Host adapter for the History engine (history.js)
   ═════════════════════════════════════════════════════════════════════════

   All history logic — tile storage, reference counting, byte-budgeted
   eviction, timeline navigation — lives in history.js. This section
   provides ONLY the thin host adapter: helpers that capture/restore
   the pieces of document state the engine needs (selection, gradient),
   a canvas-size mutator, an active-operation canceller, and the
   post-restore reactivation logic. Registration happens in `init()`.

   ── Extending for new tools ─────────────────────────────────────────────

     1. Perform the mutation on the document (layer pixels, selection,
        structure, etc.).
     2. Call  History.record('Display Name', 'icon-id')  AFTER the
        mutation is complete. The engine captures the current state.
     3. If your tool has a multi-step editing session (like the gradient
        tool), do NOT record intermediate steps — only record once on
        commit, and use an in-memory pre-session snapshot for cancel.

     New host state that should participate in undo/redo must be added to
     both  captureHostSelection/captureHostGradient  and their matching
     restore functions, then serialized as part of the entry memento.
   ═════════════════════════════════════════════════════════════════════════ */

// ──── Selection memento (host side) ───────────────────────────────────────
/**
 * Captures the current selection state for undo/redo history.
 * Stores: selection descriptor (JSON), fill rule, and mask as Uint8Array (1 byte/px).
 * The Path2D (selectionPath) is NOT stored — it is rebuilt via buildSelectionPath() on restore.
 * @returns {Object|null} Selection memento, or null if no selection exists.
 */
function captureHostSelection() {
  // Phase 9: consume-and-reset the pxTransform-session flag so exactly one
  // entry carries the "re-enter transform on restore" marker.
  const pxWas = _pxTransformWasActiveForPush;
  _pxTransformWasActiveForPush = false;
  if (!selection && !selectionPath) return null;
  const state = {
    selection: selection ? JSON.parse(JSON.stringify(selection)) : null,
    selectionFillRule: selectionFillRule,
    selectionMaskBits: null,
    pxTransformWasActive: pxWas
  };
  if (selectionMask && selectionMaskCtx) {
    const data = selectionMaskCtx.getImageData(0, 0, canvasW, canvasH).data;
    const bits = new Uint8Array(canvasW * canvasH);
    for (let i = 0; i < bits.length; i++) bits[i] = data[i * 4 + 3];
    state.selectionMaskBits = bits;
  }
  return state;
}

/**
 * Restores selection state from a history memento.
 * Handles both current format (selectionMaskBits: Uint8Array) and legacy (selectionMaskData: ImageData).
 * Rebuilds selectionPath via buildSelectionPath() after restoring the descriptor.
 * @param {Object|null} selState - The selection memento from captureHostSelection().
 */
function restoreHostSelection(selState) {
  // Phase 9: stash the transform flag so afterHostRestore can read it.
  _lastRestoredPxTransformWasActive = !!(selState && selState.pxTransformWasActive);
  if (!selState) {
    selection = null;
    selectionPath = null;
    if (selectionMask) selectionMaskCtx.clearRect(0, 0, canvasW, canvasH);
    return;
  }
  selection = selState.selection ? JSON.parse(JSON.stringify(selState.selection)) : null;
  selectionFillRule = selState.selectionFillRule || 'nonzero';
  if (selState.selectionMaskBits) {
    ensureMask();
    const imgData = new ImageData(canvasW, canvasH);
    for (let i = 0; i < selState.selectionMaskBits.length; i++) {
      const v = selState.selectionMaskBits[i];
      imgData.data[i * 4] = 255;
      imgData.data[i * 4 + 1] = 255;
      imgData.data[i * 4 + 2] = 255;
      imgData.data[i * 4 + 3] = v;
    }
    selectionMaskCtx.putImageData(imgData, 0, 0);
  } else if (selState.selectionMaskData && selectionMask) {
    // Legacy: handle old history entries that stored raw RGBA ImageData
    selectionMaskCtx.putImageData(selState.selectionMaskData, 0, 0);
  }
  if (selection) {
    buildSelectionPath();
  } else {
    selectionPath = null;
  }
}

// ──── Gradient memento (host side) ────────────────────────────────────────
// Gradient editing is flattened to a single history entry on commit, but
// the engine still preserves the gradient's base snapshot across undo/redo
// so the user can continue editing a gradient after traveling through
// history (per F2 / E2).
function captureHostGradient() {
  if (!gradActive) return null;
  return {
    p1: gradP1 ? {x: gradP1.x, y: gradP1.y} : null,
    p2: gradP2 ? {x: gradP2.x, y: gradP2.y} : null,
    stops: gradStops.map(s => ({t: s.t, color: s.color, mid: s.mid})),
    baseSnapshot: gradBaseSnapshot ? gradBaseSnapshot.getContext('2d').getImageData(0, 0, gradBaseSnapshot.width, gradBaseSnapshot.height) : null,
    baseW: gradBaseSnapshot ? gradBaseSnapshot.width : 0,
    baseH: gradBaseSnapshot ? gradBaseSnapshot.height : 0
  };
}

function restoreHostGradient(gs) {
  if (!gs) {
    gradActive = false; gradP1 = null; gradP2 = null;
    gradStops = []; gradDragging = null; gradBaseSnapshot = null;
    gradDragStartPos = null; gradStopAboutToDelete = false;
    gradColorPickerMode = false; gradColorTarget = null;
    hideGradStopCtx();
    return;
  }
  gradActive = true;
  gradP1 = gs.p1 ? {x: gs.p1.x, y: gs.p1.y} : null;
  gradP2 = gs.p2 ? {x: gs.p2.x, y: gs.p2.y} : null;
  gradStops = gs.stops.map(s => ({t: s.t, color: s.color, mid: s.mid}));
  gradDragging = null; gradDragStartPos = null; gradStopAboutToDelete = false;
  gradColorPickerMode = false; gradColorTarget = null;
  hideGradStopCtx();
  if (gs.baseSnapshot && gs.baseW && gs.baseH) {
    gradBaseSnapshot = document.createElement('canvas');
    gradBaseSnapshot.width = gs.baseW; gradBaseSnapshot.height = gs.baseH;
    gradBaseSnapshot.getContext('2d').putImageData(gs.baseSnapshot, 0, 0);
  } else {
    gradBaseSnapshot = null;
  }
}

// ──── Canvas dimension mutator (called by engine when an entry with a
//      different canvas size is restored, e.g. Resize/Canvas Size/Crop). ──
function setHostCanvasSize(w, h) {
  canvasW = w; canvasH = h;
  compositeCanvas.width = w;
  compositeCanvas.height = h;
  overlayCanvas.width = w;
  overlayCanvas.height = h;
  canvasWrapper.style.width = w + 'px';
  canvasWrapper.style.height = h + 'px';
  checkerPattern = null;
}

// ──── Layer array swap (called by engine during restore) ────────────────
function setHostLayers(newLayers, activeIdx) {
  layers = newLayers;
  SnapEngine.invalidateAllLayers();
  activeLayerIndex = Math.min(Math.max(0, activeIdx | 0), layers.length - 1);
  selectedLayers = new Set([activeLayerIndex]);

  // Any floating selection / pixel transform session is invalidated by
  // a history jump — the engine records post-commit state only, so there
  // is nothing in-flight to preserve.
  floatingActive = false;
  floatingCanvas = null;
  floatingCtx = null;
  floatingOffset = {x: 0, y: 0};
  floatingSelectionData = null;
  pxTransformActive = false;
  pxTransformData = null;
  pxTransformHandle = null;
  pxTransformStartMouse = null;
  pxTransformOrigBounds = null;
}

// ──── Post-restore re-composite hook ────────────────────────────────────
function afterHostRestore() {
  compositeAll();
  updateLayerPanel();
  updateStatus();
  drawOverlay();
  reactivateAfterHistoryRestore();
}

// ──── Create a blank layer-sized canvas (engine reuses this during restore)
function createBlankLayerCanvas() {
  const c = document.createElement('canvas');
  c.width = canvasW;
  c.height = canvasH;
  return c;
}

/**
 * After an undo/redo/jumpTo restores an entry, re-engage the appropriate
 * tool affordance so the user's interactive context is preserved.
 *
 *   • Move tool with a selection → re-enter pixel transform mode.
 *   • Move-selection tool with a selection → re-show transform handles.
 *   • Gradient state present → switch to gradient tool so handles reappear.
 */
function reactivateAfterHistoryRestore() {
  // Phase 9: only re-enter the transform if the snapshot was pushed from
  // within a live pxTransform session. Prevents auto-creating a transform
  // for plain selections when undoing unrelated history (honors Phase 1).
  if (currentTool === 'move' && selectionPath && selection && !pxTransformActive && _lastRestoredPxTransformWasActive) {
    initPixelTransform(true); // skipUndo: we're mid-restore, no new entry
  }
  _lastRestoredPxTransformWasActive = false;
  if (currentTool === 'movesel' && selectionPath) {
    transformSelActive = true;
    drawOverlay();
  }
  if (gradActive && gradP1 && gradP2 && gradStops.length >= 2) {
    if (currentTool !== 'gradient') selectTool('gradient');
    drawOverlay();
  }
}

/**
 * F4 — Ctrl+Z during an in-progress gesture cancels the gesture instead
 * of consuming a history step. Returns true if a gesture was cancelled.
 *
 * Only CURRENTLY-ACTIVE gestures qualify:
 *   • Brush/pencil/eraser stroke (mouse still down, stroke buffer live)
 *   • Rect/ellipse selection being dragged out
 *   • Gradient creation drag (first gradient drag, before commit)
 *
 * Completed handle drags inside Free Transform / selection transform
 * do NOT qualify — those are already committed entries and should be
 * normal-undo'd.
 */
function cancelActiveOperation() {
  // Cancel in-progress brush/pencil/eraser stroke
  if (strokeBuffer && isDrawing) {
    strokeBuffer = null;
    strokeBufferCtx = null;
    isDrawing = false;
    dabDistAccum = 0;
    compositeAll();
    return true;
  }
  // Cancel in-progress magnetic lasso
  if (magActive) {
    cancelMagneticLasso();
    return true;
  }
  // Cancel in-progress drag of a rectangular/elliptical selection
  if (isDrawingSelection) {
    isDrawingSelection = false;
    drawingPreviewPath = null;
    lassoPoints = [];
    drawOverlay();
    return true;
  }
  // Cancel in-progress gradient creation drag
  if (gradDragging === 'creating') {
    if (gradBaseSnapshot) {
      const layer = getActiveLayer();
      if (layer) {
        layer.ctx.clearRect(0, 0, canvasW, canvasH);
        layer.ctx.drawImage(gradBaseSnapshot, 0, 0);
        SnapEngine.invalidateLayer(layer);
      }
    }
    gradActive = false;
    gradP1 = null; gradP2 = null;
    gradStops = [];
    gradDragging = null;
    gradBaseSnapshot = null;
    gradDragStartPos = null;
    gradStopAboutToDelete = false;
    SnapEngine.endSession();
    compositeAll();
    drawOverlay();
    return true;
  }
  // Cancel a live Free Transform session. Smart-object transforms don't push
  // per-drag history entries, so Ctrl+Z within a session reverts to the
  // pre-transform state without consuming an unrelated history step.
  // The selection is preserved so the user can re-enter the transform or
  // continue with the selection intact.
  if (pxTransformActive) {
    cancelPixelTransform();
    return true;
  }
  return false;
}

/**
 * Thin wrapper around History.record(name) that infers the icon id from
 * the action name. Kept as `pushUndo` for call-site compatibility with
 * legacy code; NEW call-sites should prefer History.record() directly.
 *
 * IMPORTANT: Call this AFTER the action has been applied to the document.
 * Entries are post-state snapshots, not pre-state checkpoints.
 */
function pushUndo(actionName) {
  if (typeof History === 'undefined' || !History) return;
  History.record(actionName);
  if (window.IEM && window.IEM.active && window.IEM.markActiveDocDirty) window.IEM.markActiveDocDirty();
}

function doUndo() {
  if (_nudgePending) flushNudgeUndo();
  // Any open text-edit session must commit before we mutate the layer
  // array out from under it; otherwise the floating tx-box DOM holds a
  // stale layer reference. If the edit changed the model, this commit
  // becomes the entry the user immediately undoes — Photoshop semantics.
  if (window.TextTool && window.TextTool.isActive && window.TextTool.isActive()) {
    window.TextTool.endEdit(true);
  }
  if (cancelActiveOperation()) return;
  if (typeof History === 'undefined' || !History) return;
  History.undo();
}

function doRedo() {
  if (_nudgePending) flushNudgeUndo();
  if (window.TextTool && window.TextTool.isActive && window.TextTool.isActive()) {
    window.TextTool.endEdit(true);
  }
  if (typeof History === 'undefined' || !History) return;
  History.redo();
}


/* ═══════════════════════════════════════════════════════
   ZOOM & PAN
   ═══════════════════════════════════════════════════════ */

function updateTransform() {
  canvasWrapper.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  compositeCanvas.style.imageRendering = zoom >= 1 ? 'pixelated' : 'auto';
  document.getElementById('statusZoom').textContent = Math.round(zoom * 100) + '%';
  drawRulers();
  drawGuides();
  drawUIOverlay();
  if (window.TextTool && window.TextTool.onZoomChange) window.TextTool.onZoomChange();
  if (window.ShapeTool && window.ShapeTool.onZoomChange) window.ShapeTool.onZoomChange();
  if (window.DirectSelection && window.DirectSelection.onZoomChange) window.DirectSelection.onZoomChange();
  if (window.PenTool && window.PenTool.onZoomChange) window.PenTool.onZoomChange();
}

function zoomTo(newZoom, cx, cy) {
  isFitMode = false;
  const wsRect = workspace.getBoundingClientRect();
  if (cx === undefined) cx = wsRect.width / 2;
  if (cy === undefined) cy = wsRect.height / 2;

  const worldX = (cx - panX) / zoom;
  const worldY = (cy - panY) / zoom;

  zoom = Math.max(0.05, Math.min(64, newZoom));

  panX = cx - worldX * zoom;
  panY = cy - worldY * zoom;
  updateTransform();
}

function zoomIn() { zoomTo(zoom * 1.25); }
function zoomOut() { zoomTo(zoom / 1.25); }
function zoom100() { isFitMode = false; zoomTo(1); centerCanvas(); }

// Returns the available workspace area, accounting for visible rulers.
function getAvailableWorkspaceRect() {
  const wsRect = workspace.getBoundingClientRect();
  const rulerOffset = rulersVisible ? RULER_SIZE : 0;
  return {
    width: wsRect.width - rulerOffset,
    height: wsRect.height - rulerOffset,
    rulerOffset
  };
}

function zoomFit() {
  isFitMode = true;
  const avail = getAvailableWorkspaceRect();
  const pad = 40;
  const scaleX = (avail.width - pad) / canvasW;
  const scaleY = (avail.height - pad) / canvasH;
  zoom = Math.min(scaleX, scaleY, 1);
  centerCanvas(avail);
}

function centerCanvas(avail) {
  if (!avail) avail = getAvailableWorkspaceRect();
  panX = avail.rulerOffset + (avail.width - canvasW * zoom) / 2;
  panY = avail.rulerOffset + (avail.height - canvasH * zoom) / 2;
  updateTransform();
}

function wheelDelta(e) {
  return (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? Math.sign(e.deltaX) : -Math.sign(e.deltaY)) * (e.shiftKey ? 10 : 1);
}

function setupAppLikeInput(inp) {
  let isFirstType = false;
  inp.addEventListener('focus', function() {
    this.classList.add('app-input-grey');
    isFirstType = true;
    setTimeout(() => this.select(), 0);
  });
  inp.addEventListener('keydown', function(e) {
    if (isFirstType && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.value = '';
      this.classList.remove('app-input-grey');
      isFirstType = false;
    }
  });
  inp.addEventListener('input', function() {
    this.classList.remove('app-input-grey');
    isFirstType = false;
  });
  inp.addEventListener('blur', function() {
    this.classList.remove('app-input-grey');
    isFirstType = false;
  });
}

function syncSliders(sId, nId) {
  const s=document.getElementById(sId), n=document.getElementById(nId);
  if(!s||!n) return;
  s.addEventListener('input', ()=>{n.value=s.value;});
  n.addEventListener('input', ()=>{
    let v=parseInt(n.value)||0;
    const max=parseInt(n.max)||5000;
    if(v>max) { v=max; n.value=v; }
    s.value=Math.min(v, parseInt(s.max)||500);
  });
}

function addSliderWheelListener(rowId, numId) {
  const row = document.getElementById(rowId);
  const num = document.getElementById(numId);
  if (!row || !num) return;
  row.addEventListener('wheel', (e) => {
    e.preventDefault();
    let val = isNaN(parseFloat(num.value)) ? 0 : parseFloat(num.value);
    val = Math.max(parseInt(num.min)||0, Math.min(parseInt(num.max)||100, val + wheelDelta(e)));
    num.value = val;
    num.dispatchEvent(new Event('input'));
  }, { passive: false });
}

[
  'rInput', 'gInput', 'bInput', 'hexInput',
  'newWidth', 'newHeight', 'resizeW', 'resizeH', 'canvasSizeW', 'canvasSizeH'
].forEach(id => { const el = document.getElementById(id); if (el) setupAppLikeInput(el); });


const _hexCache = new Map();
const _hexParseCanvas = document.createElement('canvas');
_hexParseCanvas.width = 1; _hexParseCanvas.height = 1;
const _hexParseCtx = _hexParseCanvas.getContext('2d');
function hexToRGBA(hex) {
  let cached = _hexCache.get(hex);
  if (cached) return cached;
  _hexParseCtx.clearRect(0, 0, 1, 1);
  _hexParseCtx.fillStyle = hex;
  _hexParseCtx.fillRect(0, 0, 1, 1);
  const d = _hexParseCtx.getImageData(0, 0, 1, 1).data;
  cached = {r:d[0], g:d[1], b:d[2]};
  if (_hexCache.size > 64) _hexCache.clear();
  _hexCache.set(hex, cached);
  return cached;
}

/* ═══════════════════════════════════════════════════════
   PAINT BUCKET — Scanline Flood Fill
   ═══════════════════════════════════════════════════════ */

function floodFill(ctx, startX, startY, fillColor, tolerance, opacity) {
  const w = canvasW, h = canvasH;
  if (w === 0 || h === 0) return;
  const sx = Math.floor(startX), sy = Math.floor(startY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const ti = (sy * w + sx) * 4;
  const tR = data[ti], tG = data[ti + 1], tB = data[ti + 2], tA = data[ti + 3];
  const tmpC = document.createElement('canvas');
  tmpC.width = 1; tmpC.height = 1;
  const tmpCtx = tmpC.getContext('2d');
  tmpCtx.fillStyle = fillColor;
  tmpCtx.fillRect(0, 0, 1, 1);
  const fc = tmpCtx.getImageData(0, 0, 1, 1).data;
  const fR = fc[0], fG = fc[1], fB = fc[2], fA = fc[3];
  if (opacity >= 1 && fR === tR && fG === tG && fB === tB && fA === tA) return;
  const tol = Math.max(0, Math.min(255, Math.floor(tolerance)));
  const visited = new Uint8Array(w * h);
  function matches(pos) {
    const i = pos * 4;
    return Math.abs(data[i] - tR) <= tol && Math.abs(data[i + 1] - tG) <= tol && Math.abs(data[i + 2] - tB) <= tol && Math.abs(data[i + 3] - tA) <= tol;
  }
  if (!matches(sx + sy * w)) return;
  const alpha = Math.max(0, Math.min(1, opacity));
  let sl = sx, sr = sx;
  while (sl > 0 && !visited[sy * w + sl - 1] && matches(sy * w + sl - 1)) sl--;
  while (sr < w - 1 && !visited[sy * w + sr + 1] && matches(sy * w + sr + 1)) sr++;
  const stack = [];
  for (let x = sl; x <= sr; x++) { const pos = sy * w + x; visited[pos] = 1; applyFill(pos); }
  stack.push([sy, sl, sr]);
  function applyFill(pos) {
    const i = pos * 4;
    if (alpha >= 0.999) { data[i] = fR; data[i+1] = fG; data[i+2] = fB; data[i+3] = fA; }
    else { const inv=1-alpha; data[i]=Math.round(fR*alpha+data[i]*inv); data[i+1]=Math.round(fG*alpha+data[i+1]*inv); data[i+2]=Math.round(fB*alpha+data[i+2]*inv); data[i+3]=Math.round(fA*alpha+data[i+3]*inv); }
  }
  function scanLine(y, parentLeft, parentRight) {
    if (y < 0 || y >= h) return;
    let x = parentLeft;
    while (x <= parentRight) {
      const pos = y * w + x;
      if (visited[pos] || !matches(pos)) { x++; continue; }
      let left = x, right = x;
      while (left > 0 && !visited[y * w + left - 1] && matches(y * w + left - 1)) left--;
      while (right < w - 1 && !visited[y * w + right + 1] && matches(y * w + right + 1)) right++;
      for (let fx = left; fx <= right; fx++) { const fpos = y * w + fx; visited[fpos] = 1; applyFill(fpos); }
      stack.push([y, left, right]);
      x = right + 1;
    }
  }
  while (stack.length > 0) { const [cy, cl, cr] = stack.pop(); scanLine(cy - 1, cl, cr); scanLine(cy + 1, cl, cr); }
  ctx.putImageData(imgData, 0, 0);
}


/* ═══════════════════════════════════════════════════════
   SELECTION SYSTEM
   ═══════════════════════════════════════════════════════ */

/**
 * Rebuilds the selectionPath (Path2D) from the selection descriptor.
 * Handles all selection types: rect, ellipse, lasso (points), wand (contours),
 * and composite (contours from add/subtract operations).
 * For composite type without contours, falls back to rebuildPathFromMask().
 * Invariant: after this call, selectionPath accurately represents the selection descriptor.
 */
function buildSelectionPath() {
  if (!selection) { selectionPath = null; return; }
  selectionPath = new Path2D();
  if (selection.type === 'rect') {
    selectionPath.rect(Math.round(selection.x), Math.round(selection.y), Math.round(selection.w), Math.round(selection.h));
  } else if (selection.type === 'ellipse') {
    const x=Math.round(selection.x), y=Math.round(selection.y), w=Math.round(selection.w), h=Math.round(selection.h);
    if (w > 0 && h > 0) selectionPath.ellipse(x+w/2, y+h/2, w/2, h/2, 0, 0, Math.PI*2);
  } else if (selection.type === 'lasso' && selection.points && selection.points.length > 2) {
    selectionPath.moveTo(selection.points[0].x, selection.points[0].y);
    for (let i=1; i<selection.points.length; i++) selectionPath.lineTo(selection.points[i].x, selection.points[i].y);
    selectionPath.closePath();
  } else if (selection.type === 'wand' && selection.contours) {
    for (const poly of selection.contours) {
      if (poly.length < 3) continue;
      selectionPath.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) selectionPath.lineTo(poly[i].x, poly[i].y);
      selectionPath.closePath();
    }
  } else if (selection.type === 'composite') {
    if (selection.contours && selection.contours.length > 0) {
      for (const poly of selection.contours) {
        if (poly.length < 3) continue;
        selectionPath.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) selectionPath.lineTo(poly[i].x, poly[i].y);
        selectionPath.closePath();
      }
    } else if (selectionMask && selectionMaskCtx) {
      rebuildPathFromMask();
      return;
    }
  }
}

function getSelectionBounds() {
  if (!selection) return null;
  if (selection.type === 'lasso' && selection.points) {
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const p of selection.points) { minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); }
    return {x:minX, y:minY, w:maxX-minX, h:maxY-minY};
  }
  if ((selection.type === 'wand' || selection.type === 'composite') && selection.contours) {
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const poly of selection.contours) { for (const p of poly) { minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); } }
    return {x:minX, y:minY, w:maxX-minX, h:maxY-minY};
  }
  return {x:selection.x, y:selection.y, w:selection.w, h:selection.h};
}

/**
 * Commits a new selection shape, combining with the existing selection per the current mode.
 * Modes: 'new' (replace), 'add' (mask union), 'subtract' (mask destination-out).
 * For add/subtract, the result is rasterized to a pixel mask and re-vectorized via
 * rebuildPathFromMask() so overlapping contours merge cleanly.
 * Invariant: selectionFillRule is always reset to 'nonzero' for add/subtract modes.
 * @param {Path2D} newPath - The Path2D of the new selection shape.
 * @param {Object} newSelData - The selection descriptor ({type, x, y, w, h, points?, contours?}).
 */
function commitNewSelection(newPath, newSelData) {
  if (selectionMode === 'new') { selection = newSelData; selectionPath = newPath; }
  else if (selectionMode === 'add') {
    if (!selectionPath) { selection = newSelData; selectionPath = newPath; }
    else {
      ensureMask();
      selectionMaskCtx.clearRect(0, 0, canvasW, canvasH);
      selectionMaskCtx.fillStyle = '#fff'; selectionMaskCtx.fill(selectionPath, selectionFillRule);
      selectionMaskCtx.fillStyle = '#fff'; selectionMaskCtx.fill(newPath);
      rebuildPathFromMask();
    }
  } else if (selectionMode === 'subtract') {
    if (!selectionPath) return;
    ensureMask();
    selectionMaskCtx.clearRect(0, 0, canvasW, canvasH);
    selectionMaskCtx.fillStyle = '#fff'; selectionMaskCtx.fill(selectionPath, selectionFillRule);
    selectionMaskCtx.globalCompositeOperation = 'destination-out';
    selectionMaskCtx.fillStyle = '#fff'; selectionMaskCtx.fill(newPath);
    selectionMaskCtx.globalCompositeOperation = 'source-over';
    rebuildPathFromMask();
  }
  pushUndo('Selection');
}

function getBoundsFromPoints(pts) {
  if (!pts || pts.length === 0) return {x:0,y:0,w:0,h:0};
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const p of pts) { minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); }
  return {x:minX,y:minY,w:maxX-minX,h:maxY-minY};
}

function ensureMask() {
  if (!selectionMask || selectionMask.width !== canvasW || selectionMask.height !== canvasH) {
    selectionMask = document.createElement('canvas');
    selectionMask.width = canvasW; selectionMask.height = canvasH;
    selectionMaskCtx = selectionMask.getContext('2d', { willReadFrequently: true });
  }
}

/**
 * Rebuilds both selectionPath and selection descriptor from the selectionMask canvas.
 * Reads the mask's alpha channel, extracts a 1-bit Uint8Array, computes bounds,
 * runs maskToContours() + contoursToPath() to produce a pixel-accurate selectionPath,
 * and sets selection to type:'composite' with contours for serialization/transforms.
 * Resets selectionFillRule to 'nonzero'. Called after subtract mask operations.
 */
function rebuildPathFromMask() {
  if (!selectionMask) return;
  const data = selectionMaskCtx.getImageData(0, 0, canvasW, canvasH).data;
  const u8 = new Uint8Array(canvasW * canvasH);
  let minX=canvasW, minY=canvasH, maxX=0, maxY=0;
  let hasContent = false;
  for (let y=0; y<canvasH; y++) {
    for (let x=0; x<canvasW; x++) {
      const i = y * canvasW + x;
      if (data[i * 4 + 3] > 128) {
        u8[i] = 1;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        hasContent = true;
      }
    }
  }
  if (!hasContent) { selection=null; selectionPath=null; return; }
  const contours = maskToContours(u8, canvasW, canvasH);
  selectionPath = contoursToPath(contours);
  selectionFillRule = 'nonzero';
  selection = { type:'composite', x:minX, y:minY, w:maxX-minX+1, h:maxY-minY+1, contours: contours };
}

function selectAll() { selectionFillRule = 'nonzero'; selection = { type:'rect', x:0, y:0, w:canvasW, h:canvasH }; buildSelectionPath(); drawOverlay(); pushUndo('Select All'); }

function commitFloating() {
  if (!floatingActive || !floatingCanvas) return;
  // Nudge flush: any pending floating nudge gets its own undo entry before
  // we fold the floating into the layer.
  if (_nudgePending) flushNudgeUndo();
  const layer = getActiveLayer();
  if (layer) { layer.ctx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y); SnapEngine.invalidateLayer(layer); }
  const ox = floatingOffset.x, oy = floatingOffset.y;
  if (ox !== 0 || oy !== 0) {
    if (selectionPath) { const translated = new Path2D(); translated.addPath(selectionPath, new DOMMatrix([1, 0, 0, 1, ox, oy])); selectionPath = translated; }
    if (selection) {
      if (selection.type === 'lasso' && selection.points) { selection.points = selection.points.map(p => ({x: p.x + ox, y: p.y + oy})); }
      if ((selection.type === 'wand' || selection.type === 'composite') && selection.contours) { selection.contours = selection.contours.map(poly => poly.map(p => ({x: p.x + ox, y: p.y + oy}))); }
      if (selection.x !== undefined) { selection.x += ox; selection.y += oy; }
    }
  }
  floatingActive = false; floatingCanvas = null; floatingCtx = null;
  floatingOffset = {x:0, y:0}; floatingSelectionData = null;
  compositeAll(); updateLayerPanel();
  updateMoveDeselectButtonState();
}

function clearSelection() {
  if (floatingActive) commitFloating();
  if (magActive) resetMagneticState();
  selectionFillRule = 'nonzero';
  selection = null; selectionPath = null; lassoPoints = []; polyPoints = [];
  if (selectionMask) selectionMaskCtx.clearRect(0, 0, canvasW, canvasH);
  transformSelActive = (currentTool === 'movesel');
  drawOverlay();
}

function invertSelection() {
  if (!selectionPath) { selectAll(); return; }
  ensureMask();
  selectionMaskCtx.clearRect(0, 0, canvasW, canvasH);
  selectionMaskCtx.fillStyle = '#fff';
  selectionMaskCtx.fillRect(0, 0, canvasW, canvasH);
  selectionMaskCtx.globalCompositeOperation = 'destination-out';
  selectionMaskCtx.fill(selectionPath, selectionFillRule);
  selectionMaskCtx.globalCompositeOperation = 'source-over';
  rebuildPathFromMask();
  drawOverlay();
  pushUndo('Invert Selection');
}

function deleteSelection() {
  if (!selectionPath && !floatingActive) return;
  const layer = getActiveLayer();
  if (!floatingActive && (!layer || !selectionPath)) return;
  if (floatingActive) {
    floatingActive = false; floatingCanvas = null; floatingCtx = null; floatingOffset = {x:0, y:0};
    if (layer && selectionPath) { layer.ctx.save(); layer.ctx.clip(selectionPath, selectionFillRule); layer.ctx.clearRect(0, 0, canvasW, canvasH); layer.ctx.restore(); SnapEngine.invalidateLayer(layer); }
    compositeAll();
  } else {
    layer.ctx.save(); layer.ctx.clip(selectionPath, selectionFillRule); layer.ctx.clearRect(0, 0, canvasW, canvasH); layer.ctx.restore(); SnapEngine.invalidateLayer(layer); compositeAll();
  }
  pushUndo('Delete');
}

function cropToSelection() {
  const b = getSelectionBounds();
  if (!b || b.w < 1 || b.h < 1) return;
  const nx=Math.max(0,Math.round(b.x)), ny=Math.max(0,Math.round(b.y));
  const nw=Math.min(canvasW-nx,Math.round(b.w)), nh=Math.min(canvasH-ny,Math.round(b.h));
  if (nw < 1 || nh < 1) return;
  const newLayers = layers.map(l => {
    const d=l.ctx.getImageData(nx,ny,nw,nh); const c=document.createElement('canvas');
    c.width=nw; c.height=nh; const ctx=c.getContext('2d'); ctx.putImageData(d,0,0);
    return {...l, canvas:c, ctx};
  });
  canvasW=nw; canvasH=nh; compositeCanvas.width=nw; compositeCanvas.height=nh;
  overlayCanvas.width=nw; overlayCanvas.height=nh;
  canvasWrapper.style.width=nw+'px'; canvasWrapper.style.height=nh+'px';
  layers=newLayers; checkerPattern=null; SnapEngine.invalidateAllLayers(); clearSelection(); zoomFit(); compositeAll(); updateLayerPanel(); updateStatus();
  pushUndo('Crop');
}


/* --- Marching Ants --- */
let marchingAntsOffset = 0;
let marchingAntsRAF = null;
// Set only while the ants timer is driving a drawOverlay redraw. Lets
// drawOverlay skip the expensive updatePropertiesPanel() DOM work for a
// frame type where no panel state actually changes.
let _antsTickInProgress = false;

function startMarchingAnts() {
  if (marchingAntsRAF) return;
  let lastTime = 0;
  function animate(time) {
    marchingAntsRAF = requestAnimationFrame(animate);
    if (time - lastTime < 50) return;
    if (!selectionPath && !gradActive && !isDrawingSelection && !pxTransformActive) return;
    lastTime = time; marchingAntsOffset = (marchingAntsOffset + 1) % 300;
    _antsTickInProgress = true; drawOverlay(); _antsTickInProgress = false;
  }
  marchingAntsRAF = requestAnimationFrame(animate);
}
startMarchingAnts();


/* ═══════════════════════════════════════════════════════
   MOVE TOOL — HIT TESTING & TARGET SELECTION
   ═══════════════════════════════════════════════════════ */

/**
 * Returns true if the given layer has a non-transparent pixel at the
 * (canvas-space) coordinate. Single-pixel getImageData is effectively
 * free even on large canvases. Used for Move-tool click hit testing.
 */
function hitTestVisiblePixel(layer, px, py) {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  if (ix < 0 || iy < 0 || ix >= canvasW || iy >= canvasH) return false;
  if (!layer || !layer.ctx) return false;
  try {
    const d = layer.ctx.getImageData(ix, iy, 1, 1).data;
    return d[3] > 0;
  } catch (e) { return false; }
}

/**
 * Returns true if the canvas-space point is inside the current selection
 * path. Uses a scratch 2D context because Path2D point-in-path requires a
 * context but doesn't touch its state.
 */
function isPointInSelectionPath(px, py) {
  if (!selectionPath) return false;
  const ctx = getHitTestCtx();
  return ctx.isPointInPath(selectionPath, px, py, selectionFillRule);
}

/**
 * Decides which layer a Move-tool click should target. Returns
 * { layerIndex } or null if the click should do nothing.
 *
 * Rules:
 *   • If a selection exists: click must be inside the selection path.
 *     The target is always the active layer (selections are per-doc and
 *     operate on whatever layer is currently active).
 *   • If no selection and auto-select is ON: search visible layers
 *     top-to-bottom and pick the first with an opaque pixel at (px, py).
 *   • If no selection and auto-select is OFF: target the active layer
 *     only, and only if it has an opaque pixel at (px, py).
 */
function pickMoveTarget(px, py) {
  if (px < 0 || py < 0 || px >= canvasW || py >= canvasH) return null;
  if (selectionPath) {
    if (!isPointInSelectionPath(px, py)) return null;
    const l = getActiveLayer();
    if (!l || !l.visible) return null;
    return { layerIndex: activeLayerIndex };
  }
  if (moveAutoSelectLayer) {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (!l.visible) continue;
      if (hitTestVisiblePixel(l, px, py)) return { layerIndex: i };
    }
    return null;
  }
  const active = getActiveLayer();
  if (!active || !active.visible) return null;
  if (!hitTestVisiblePixel(active, px, py)) return null;
  return { layerIndex: activeLayerIndex };
}

/* ═══════════════════════════════════════════════════════
   MOUSE EVENT HANDLING
   ═══════════════════════════════════════════════════════ */

function onDblClick(e) {
  // Move tool: double-clicking inside the transform box (or on any of its
  // handles) commits the transform AND clears the selection in a single
  // gesture. Uses hitTestPxTransform so the test honors totalRotation.
  if (currentTool === 'move' && pxTransformActive && pxTransformData) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    if (hitTestPxTransform(pos.x, pos.y)) {
      commitPixelTransform();
      if (selection || selectionPath) clearSelection();
      updateMoveDeselectButtonState();
      return;
    }
  }
  if (currentTool === 'text' && window.TextTool && window.TextTool.beginEditAtPoint) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    if (window.TextTool.beginEditAtPoint(pos.x, pos.y)) return;
  }
  if (currentTool === 'move' && window.TextTool && window.TextTool.beginEditAtPoint) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    const hit = layers.some(l => l.kind === 'text' && l.visible && l.textModel
      && (() => {
        const m = l.textModel;
        const cx = m.boxX + m.boxW / 2, cy = m.boxY + m.boxH / 2;
        let lx = pos.x - cx, ly = pos.y - cy;
        if (m.rotation) {
          const c = Math.cos(-m.rotation), s = Math.sin(-m.rotation);
          const rx = lx * c - ly * s, ry = lx * s + ly * c;
          lx = rx; ly = ry;
        }
        return lx >= -m.boxW/2 && lx <= m.boxW/2 && ly >= -m.boxH/2 && ly <= m.boxH/2;
      })());
    if (hit) {
      if (typeof selectTool === 'function') selectTool('text');
      if (window.TextTool.beginEditAtPoint(pos.x, pos.y)) return;
    }
  }
  if (currentTool==='lasso' && lassoMode==='poly' && polyPoints.length>2) finishPolygonalLasso();
  if (currentTool==='lasso' && lassoMode==='magnetic' && magActive && magAnchors.length>1) { finishMagneticLasso(false); return; }
  if (currentTool==='gradient' && gradActive) {
    const pos = screenToCanvas(e.clientX, e.clientY); const hit = gradHitTest(pos.x, pos.y);
    if (hit && hit.type === 'mid') {
      // Mid-gradient edit — not a history entry; flattened into the eventual commit.
      gradStops[hit.index].mid = 0.5;
      renderGradientToLayer(); drawOverlay();
    } else if (hit && hit.type === 'stop') {
      gradColorTarget = hit.index;
      const currentColor = gradStops[hit.index].color;
      const gcRgb = hexToRgb(currentColor.replace('#',''));
      if (gcRgb) { const hsv = rgbToHsv(gcRgb.r, gcRgb.g, gcRgb.b); if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v; }
      fgColor = currentColor;
      gradColorPickerMode = true;
      toggleColorPicker();
    }
  }
}







// Tools that require rasterization before they can paint a text layer.
const TEXT_RASTERIZE_TOOLS = new Set(['brush','pencil','eraser','fill','gradient','shape']);
const TEXT_TOOL_DISPLAY_NAMES = { brush:'Brush', pencil:'Pencil', eraser:'Eraser', fill:'Fill', gradient:'Gradient', shape:'Shape' };

function onMouseDown(e) {
  // Any new pointer gesture flushes pending nudge undo — the in-flight
  // burst is committed as its own history entry before the new gesture begins.
  if (_nudgePending) flushNudgeUndo();
  const pos = screenToCanvas(e.clientX, e.clientY); const px=pos.x, py=pos.y;
  isDrawing = true; drawStart = {x:px, y:py}; lastDraw = {x:px, y:py};
  // Pan shortcuts take precedence over any tool (including ruler) so the user can always
  // middle-click, space-drag, or alt-drag to pan.
  if (e.button===1 || (e.button===0 && currentTool==='pan') || (e.button===0 && e.altKey && !((pxTransformActive && currentTool==='move') || (transformSelActive && currentTool==='movesel') || (currentTool==='lasso' && lassoMode==='magnetic' && magActive))) || (e.button===0 && spaceDown)) {
    isFitMode=false; isPanning=true; isDrawing=false; panStart={x:e.clientX-panX, y:e.clientY-panY}; workspace.style.cursor='grabbing'; return;
  }
  // Smart-object guard: paint tools acting on a smart-object layer must rasterize
  // first. Shape tool itself silently draws onto/creates shape layers, so it is
  // exempt from the shape rasterize prompt below.
  if (e.button === 0 && TEXT_RASTERIZE_TOOLS.has(currentTool)) {
    const _l = getActiveLayer();
    if (_l && _l.kind === 'text' && window.TextTool && window.TextTool.requireRasterize) {
      isDrawing = false;
      window.TextTool.requireRasterize(_l, TEXT_TOOL_DISPLAY_NAMES[currentTool] || currentTool);
      return;
    }
    if (_l && _l.kind === 'shape' && currentTool !== 'shape' && window.ShapeTool && window.ShapeTool.requireRasterize) {
      isDrawing = false;
      window.ShapeTool.requireRasterize(_l, TEXT_TOOL_DISPLAY_NAMES[currentTool] || currentTool);
      return;
    }
  }
  if (ToolRegistry.dispatch('mouseDown', e, {x: px, y: py})) return;
  const layer=getActiveLayer(); if(!layer||!layer.visible) return;
  updateStatus(e);
}

function onMouseMove(e) {
  const pos=screenToCanvas(e.clientX,e.clientY); const px=pos.x, py=pos.y;
  statusPosEl.textContent=`X: ${Math.round(px)}  Y: ${Math.round(py)}`;
  const wsRect = _getWsRect();
  rulerMouseX = e.clientX - wsRect.left;
  rulerMouseY = e.clientY - wsRect.top;
  if (rulersVisible) scheduleRulerDraw();
  if (ToolRegistry.dispatch('mouseMove', e, pos)) return;
  if (draggingGuide) {
    const gpos = screenToCanvas(e.clientX, e.clientY);
    const _axis = draggingGuide.guide.axis;
    const _raw = _axis === 'v' ? gpos.x : gpos.y;
    const _sv = SnapEngine.snapValue(_raw, _axis, { modifiers: e, excludeGuides: true, excludeGuideId: draggingGuide.guide.id });
    draggingGuide.guide.pos = _sv.val;
    workspace.style.cursor = _axis === 'v' ? 'ew-resize' : 'ns-resize';
    drawGuides();
    drawOverlay();
    updatePropertiesPanel();
    return;
  }
  if(isPanning){panX=e.clientX-panStart.x;panY=e.clientY-panStart.y;updateTransform();return;}
}


function onMouseUp(e) {
  // Guide drag finalization is handled by the document-level mouseup listener
  // to support drags that leave the workspace. Skip here to avoid double-handling.
  if (draggingGuide) return;
  if (ToolRegistry.dispatch('mouseUp', e, null)) return;
  if(isPanning){isPanning=false;workspace.style.cursor=getToolCursor();return;}
  if(!isDrawing) return; isDrawing=false;
  SnapEngine.endSession();
  drawOverlay();
}

/* ═══════════════════════════════════════════════════════
   COLOR SYSTEM — HSV Master State + Custom Picker
   ═══════════════════════════════════════════════════════ */

let cpH = 0, cpS = 0, cpV = 1;

function hsvToRgb(h, s, v) {
  let r, g, b, i = Math.floor((h / 360) * 6), f = (h / 360) * 6 - i;
  let p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) { case 0: r=v;g=t;b=p; break; case 1: r=q;g=v;b=p; break; case 2: r=p;g=v;b=t; break; case 3: r=p;g=q;b=v; break; case 4: r=t;g=p;b=v; break; case 5: r=v;g=p;b=q; break; }
  return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
}
function rgbToHsv(r, g, b) {
  r/=255; g/=255; b/=255;
  let max=Math.max(r,g,b), min=Math.min(r,g,b), h, s, v=max, d=max-min;
  s = max===0 ? 0 : d/max;
  if (max===min) h=0; else { switch(max) { case r: h=(g-b)/d+(g<b?6:0); break; case g: h=(b-r)/d+2; break; case b: h=(r-g)/d+4; break; } h/=6; }
  return { h: h*360, s, v };
}
function rgbToHex(r, g, b) { return ((1<<24)+(r<<16)+(g<<8)+b).toString(16).slice(1).toUpperCase(); }
function hexToRgb(hex) {
  let r = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? { r:parseInt(r[1],16), g:parseInt(r[2],16), b:parseInt(r[3],16) } : null;
}

function setFgColor(hex) { fgColor = hex; updateColorUI(); }
function setBgColor(hex) { bgColor = hex; updateColorUI(); }
function swapColors() { [fgColor, bgColor] = [bgColor, fgColor]; updateColorUI(); }

function updateColorUI() {
  document.getElementById('fgWell').style.background = fgColor;
  document.getElementById('bgWell').style.background = bgColor;
  document.getElementById('colorSwatchPreview').style.background = fgColor;
  const hex6 = fgColor.replace('#','');
  const d = hexToRgb(hex6) || {r:255,g:255,b:255};
  document.getElementById('hexInput').value = hex6.toUpperCase();
  document.getElementById('rSlider').value = d.r; document.getElementById('gSlider').value = d.g; document.getElementById('bSlider').value = d.b;
  document.getElementById('rInput').value = d.r; document.getElementById('gInput').value = d.g; document.getElementById('bInput').value = d.b;
  document.getElementById('rSlider').style.background = `linear-gradient(to right, rgb(0,${d.g},${d.b}), rgb(255,${d.g},${d.b}))`;
  document.getElementById('gSlider').style.background = `linear-gradient(to right, rgb(${d.r},0,${d.b}), rgb(${d.r},255,${d.b}))`;
  document.getElementById('bSlider').style.background = `linear-gradient(to right, rgb(${d.r},${d.g},0), rgb(${d.r},${d.g},255))`;
}

document.getElementById('hexInput').addEventListener('change', function() {
  let v = this.value.replace('#','');
  if (/^[0-9a-fA-F]{6}$/.test(v)) { setFgColor('#' + v); const rgb = hexToRgb(v); if (rgb) { const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b); if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v; } }
});

function panelRgbSync() {
  const r = parseInt(document.getElementById('rInput').value)||0; const g = parseInt(document.getElementById('gInput').value)||0; const b = parseInt(document.getElementById('bInput').value)||0;
  const hex = '#' + [r,g,b].map(v=>Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join('');
  setFgColor(hex); const hsv = rgbToHsv(r,g,b); if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v;
}

['rSlider','gSlider','bSlider'].forEach((sId, i) => {
  const nId = ['rInput','gInput','bInput'][i];
  document.getElementById(sId).addEventListener('input', function() { document.getElementById(nId).value = this.value; panelRgbSync(); });
});
['rInput','gInput','bInput'].forEach((nId, i) => {
  const sId = ['rSlider','gSlider','bSlider'][i];
  document.getElementById(nId).addEventListener('input', function() { document.getElementById(sId).value = this.value; panelRgbSync(); });
  document.getElementById(nId).addEventListener('change', function() { document.getElementById(sId).value = this.value; panelRgbSync(); });
});
[['rSlider','rInput'], ['gSlider','gInput'], ['bSlider','bInput']].forEach(([sId, nId]) => {
  const row = document.getElementById(sId).closest('.color-panel-slider-row');
  const num = document.getElementById(nId);
  if (!row || !num) return;
  row.addEventListener('wheel', (e) => {
    e.preventDefault();
    num.value = Math.max(0, Math.min(255, (isNaN(parseFloat(num.value)) ? 0 : parseFloat(num.value)) + wheelDelta(e)));
    num.dispatchEvent(new Event('input'));
  }, { passive: false });
});

document.querySelectorAll('#colorPresetsGrid .color-preset-swatch').forEach(swatch => {
  swatch.addEventListener('click', () => setFgColor(swatch.dataset.color));
});
document.getElementById('fgWell').addEventListener('click', () => toggleColorPicker());
document.getElementById('bgWell').addEventListener('dblclick', () => { swapColors(); toggleColorPicker(); });

function pickColor(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  if (ix<0||iy<0||ix>=canvasW||iy>=canvasH) return;
  const d = compositeCtx.getImageData(ix, iy, 1, 1).data;
  const hex = '#'+[d[0],d[1],d[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
  const hsv = rgbToHsv(d[0],d[1],d[2]);
  if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v;
  setFgColor(hex);
}

/* ═══════════════════════════════════════════════════════
   EYEDROPPER — Panel toggle mode
   ═══════════════════════════════════════════════════════ */

function _injectEyedropperCursor() {
  let s = document.getElementById('eyedropperCursorStyle');
  if (!s) { s = document.createElement('style'); s.id = 'eyedropperCursorStyle'; document.head.appendChild(s); }
  s.textContent = 'body.is-eyedropper-active, body.is-eyedropper-active * { cursor: ' + _eyedropperCursorUrl + ' !important; }';
}
_injectEyedropperCursor();

function _updateEyedropperBodyClass() {
  const any = panelEyedropperActive || _iframeEyedropperActive;
  document.body.classList.toggle('is-eyedropper-active', any);
  const cpIframe = document.getElementById('cpIframe');
  if (cpIframe && cpIframe.contentWindow) {
    cpIframe.contentWindow.postMessage({ action: 'eyedropperCursor', state: any }, '*');
  }
}

function togglePanelEyedropper() {
  panelEyedropperActive = !panelEyedropperActive;
  document.getElementById('panelEyedropperBtn').classList.toggle('active', panelEyedropperActive);
  const cpBtn = document.getElementById('cpEyedropperBtn');
  if (cpBtn) cpBtn.classList.toggle('active', panelEyedropperActive);
  _updateEyedropperBodyClass();
}

document.addEventListener('mousedown', function(e) {
  if (!panelEyedropperActive && !_iframeEyedropperActive) return;
  if (e.target.closest('#panelEyedropperBtn') || e.target.closest('#cpEyedropperBtn')) return;
  if (e.target.closest('#workspace')) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    pickColor(pos.x, pos.y);
    if (_iframeEyedropperActive) {
      const cpIframe = document.getElementById('cpIframe');
      if (cpIframe && cpIframe.contentWindow) {
        cpIframe.contentWindow.postMessage({ action: 'eyedropperPicked', hex: fgColor }, '*');
      }
    }
  } else if (_iframeEyedropperActive) {
    const cpIframe = document.getElementById('cpIframe');
    if (cpIframe && cpIframe.contentWindow) {
      cpIframe.contentWindow.postMessage({ action: 'eyedropperToggle', state: false }, '*');
    }
  }
  if (panelEyedropperActive) {
    panelEyedropperActive = false;
    document.getElementById('panelEyedropperBtn').classList.toggle('active', false);
    const cpBtn = document.getElementById('cpEyedropperBtn');
    if (cpBtn) cpBtn.classList.toggle('active', false);
  }
  _iframeEyedropperActive = false;
  _updateEyedropperBodyClass();
  e.stopPropagation();
  e.preventDefault();
}, true);

/* ═══════════════════════════════════════════════════════
   COLOR PICKER — Linked iframe (colorPicker.html)
   ═══════════════════════════════════════════════════════ */

function toggleColorPicker() {
  if (document.getElementById('cpIframeOverlay')) { closeColorPicker(); return; }
  const overlay = document.createElement('div');
  overlay.id = 'cpIframeOverlay';
  overlay.addEventListener('pointerdown', function(e) { if (e.target === overlay) closeColorPicker(); });
  const iframe = document.createElement('iframe');
  iframe.id = 'cpIframe';
  const _cpTheme = (document.documentElement.getAttribute('data-theme') === 'light') ? 'light' : 'dark';
  iframe.src = 'pages/colorPicker.html?theme=' + _cpTheme;
  iframe.onload = function() {
    const seed = window._pngPickerSeedHex || fgColor;
    window._pngPickerSeedHex = null;
    iframe.contentWindow.postMessage({ action: 'open', hex: seed }, '*');
  };
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);
}

function closeColorPicker() {
  const overlay = document.getElementById('cpIframeOverlay');
  if (overlay) overlay.remove();
  gradColorPickerMode = false;
  gradColorTarget = null;
  if (window.pngPaletteEditMode) {
    window.pngPaletteEditMode = false;
    window.pngPaletteEditIndex = -1;
    window._pngPickerSeedHex = null;
    if (window.PngExport && window.PngExport.onColorPickerCancelled) {
      window.PngExport.onColorPickerCancelled();
    }
  }
}

// Listen for messages from colorPicker.html iframe
window.addEventListener('message', function(e) {
  if (!e.data || !e.data.action) return;
  if (e.data.action === 'confirm') {
    const hex = e.data.hex;
    if (window.pngPaletteEditMode && window.PngExport && window.PngExport.onColorPicked) {
      window.PngExport.onColorPicked(hex);
      window.pngPaletteEditMode = false;
      window.pngPaletteEditIndex = -1;
      const overlay = document.getElementById('cpIframeOverlay');
      if (overlay) overlay.remove();
      return;
    }
    // Shape fill/stroke pickers are independent of the main fgColor —
    // ShapeTool's own listener will apply the hex; we just close the iframe.
    if (window._shAwaitingColor) {
      const overlay = document.getElementById('cpIframeOverlay');
      if (overlay) overlay.remove();
      return;
    }
    const rgb = hexToRgb(hex.replace('#',''));
    if (rgb) { const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b); if(hsv.s>0&&hsv.v>0) cpH=hsv.h; cpS=hsv.s; cpV=hsv.v; }
    if (gradColorPickerMode && gradActive && gradColorTarget !== null) {
      if (gradStops[gradColorTarget]) gradStops[gradColorTarget].color = hex;
      fgColor = hex; updateColorUI();
      renderGradientToLayer(); drawOverlay();
    } else {
      setFgColor(hex);
    }
    closeColorPicker();
  } else if (e.data.action === 'cancel') {
    closeColorPicker();
  } else if (e.data.action === 'eyedropperToggle') {
    _iframeEyedropperActive = e.data.state;
    _updateEyedropperBodyClass();
  }
});

/* ═══════════════════════════════════════════════════════
   INFO POPUP — Linked iframe (infoPopup.html)
   ═══════════════════════════════════════════════════════ */

function openInfoPopup() {
  if (document.getElementById('infoIframeOverlay')) { closeInfoPopup(); return; }
  const overlay = document.createElement('div');
  overlay.id = 'infoIframeOverlay';
  overlay.addEventListener('pointerdown', function(e) { if (e.target === overlay) closeInfoPopup(); });
  const iframe = document.createElement('iframe');
  iframe.id = 'infoIframe';
  const _infoTheme = (document.documentElement.getAttribute('data-theme') === 'light') ? 'light' : 'dark';
  iframe.src = 'pages/infoPopup.html?theme=' + _infoTheme;
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);
}

function closeInfoPopup() {
  const overlay = document.getElementById('infoIframeOverlay');
  if (overlay) overlay.remove();
}

// Listen for messages from infoPopup.html iframe
window.addEventListener('message', function(e) {
  if (!e.data || !e.data.action) return;
  if (e.data.action === 'closeInfo') closeInfoPopup();
});

/* ═══════════════════════════════════════════════════════
   FILTERS
   ═══════════════════════════════════════════════════════ */

function filterBrightnessContrast(data, brightness, contrast) {
  const len = data.length;
  const b = brightness / 100;
  const c = contrast * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  for (let i = 0; i < len; i += 4) {
    if (data[i + 3] === 0) continue;
    for (let ch = 0; ch < 3; ch++) {
      let v = data[i + ch];
      if (b >= 0) v = v + (255 - v) * b; else v = v * (1 + b);
      v = cf * (v - 128) + 128;
      data[i + ch] = v;
    }
  }
}

function filterHSL(data, hueDeg, saturation, lightness) {
  const len = data.length;
  const hShift = hueDeg / 360;
  const sAdj = saturation / 100;
  const lAdj = lightness / 100;
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  for (let i = 0; i < len; i += 4) {
    if (data[i + 3] === 0) continue;
    let r = data[i] / 255, g = data[i+1] / 255, b = data[i+2] / 255;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const d = mx - mn;
    let h, s, l = (mx + mn) / 2;
    if (d === 0) { h = 0; s = 0; }
    else {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    h = (h + hShift) % 1; if (h < 0) h += 1;
    if (sAdj >= 0) s = s + (1 - s) * sAdj; else s = s * (1 + sAdj);
    if (s < 0) s = 0; if (s > 1) s = 1;
    if (lAdj >= 0) l = l + (1 - l) * lAdj; else l = l * (1 + lAdj);
    if (l < 0) l = 0; if (l > 1) l = 1;
    if (s === 0) { r = g = b = l; }
    else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1/3);
    }
    data[i] = r * 255; data[i+1] = g * 255; data[i+2] = b * 255;
  }
}

function filterInvert(data) {
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    if (data[i + 3] === 0) continue;
    data[i] = 255 - data[i]; data[i+1] = 255 - data[i+1]; data[i+2] = 255 - data[i+2];
  }
}

function filterGrayscale(data) {
  const len = data.length;
  for (let i = 0; i < len; i += 4) {
    if (data[i + 3] === 0) continue;
    const luma = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
    data[i] = data[i+1] = data[i+2] = luma;
  }
}

function applyPixelFilterToData(imgData, type) {
  const d = imgData.data;
  if (type === 'brightness') {
    const bv = parseInt(document.getElementById('filterBrightness')?.value || 0);
    const cv = parseInt(document.getElementById('filterContrast')?.value || 0);
    filterBrightnessContrast(d, bv, cv);
  } else if (type === 'hsl') {
    const h = parseInt(document.getElementById('filterHue')?.value || 0);
    const s = parseInt(document.getElementById('filterSaturation')?.value || 0);
    const l = parseInt(document.getElementById('filterLightness')?.value || 0);
    filterHSL(d, h, s, l);
  } else if (type === 'invert') { filterInvert(d); }
  else if (type === 'grayscale') { filterGrayscale(d); }
}

function applyFilterDirect(type) {
  const layer = getActiveLayer(); if (!layer) return;
  closeAllMenus();
  const imgData = layer.ctx.getImageData(0, 0, canvasW, canvasH);
  applyPixelFilterToData(imgData, type);
  if (selectionPath) {
    const tempCanvas = document.createElement('canvas'); tempCanvas.width = canvasW; tempCanvas.height = canvasH;
    const tempCtx = tempCanvas.getContext('2d'); tempCtx.putImageData(imgData, 0, 0);
    layer.ctx.save(); layer.ctx.clip(selectionPath, selectionFillRule); layer.ctx.clearRect(0, 0, canvasW, canvasH); layer.ctx.drawImage(tempCanvas, 0, 0); layer.ctx.restore();
  } else { layer.ctx.putImageData(imgData, 0, 0); }
  SnapEngine.invalidateLayer(layer); compositeAll();
  pushUndo('Filter');
}

function openFilter(type) {
  // Brightness/Contrast and Hue/Saturation use the live floating adjustment
  // panel instead of the old preview-window modal.
  if (type === 'brightness' || type === 'hsl') { openAdjustmentPanel(type); return; }
  closeAllMenus(); currentFilterType = type;
  const layer = getActiveLayer(); if (!layer) return;
  const titleEl = document.getElementById('filterTitle'); const controlsEl = document.getElementById('filterControls');
  const previewCanvas = document.getElementById('filterPreviewCanvas');
  filterOriginalData = layer.ctx.getImageData(0, 0, canvasW, canvasH);
  const pw = 360, ph = Math.round(360 * canvasH / canvasW);
  previewCanvas.width = pw; previewCanvas.height = ph;
  const pctx = previewCanvas.getContext('2d'); pctx.drawImage(layer.canvas, 0, 0, pw, ph);
  filterPreviewSrc = pctx.getImageData(0, 0, pw, ph);
  controlsEl.innerHTML = '';
  if (type === 'blur') { titleEl.textContent = 'Gaussian Blur'; controlsEl.innerHTML = sliderRow('Radius', 'filterBlurRadius', 0, 20, 3); }
  else if (type === 'sharpen') { titleEl.textContent = 'Sharpen'; controlsEl.innerHTML = sliderRow('Amount', 'filterSharpenAmt', 0, 100, 50); }
  else if (type === 'invert') { applyFilterDirect('invert'); return; }
  else if (type === 'grayscale') { applyFilterDirect('grayscale'); return; }
  controlsEl.querySelectorAll('.filter-slider').forEach(slider => {
    const valEl = slider.parentElement.querySelector('.filter-slider-value');
    slider.addEventListener('input', () => { if (valEl) valEl.value = slider.value; updateFilterPreview(); });
    slider.addEventListener('dblclick', () => { slider.value = slider.defaultValue; if (valEl) valEl.value = slider.defaultValue; updateFilterPreview(); });
    if (valEl) {
      const sync = () => {
        const min = parseFloat(slider.min), max = parseFloat(slider.max);
        let v = parseFloat(valEl.value);
        if (isNaN(v)) v = parseFloat(slider.value) || 0;
        v = Math.max(min, Math.min(max, v));
        valEl.value = v;
        slider.value = v;
        updateFilterPreview();
      };
      valEl.addEventListener('input', sync);
      valEl.addEventListener('change', sync);
    }
  });
  controlsEl.querySelectorAll('.filter-slider-row').forEach(row => {
    const slider = row.querySelector('.filter-slider');
    if (!slider) return;
    row.addEventListener('wheel', (e) => {
      e.preventDefault();
      slider.value = Math.max(parseInt(slider.min)||0, Math.min(parseInt(slider.max)||100, (parseInt(slider.value)||0) + wheelDelta(e)));
      slider.dispatchEvent(new Event('input'));
    }, { passive: false });
  });
  document.getElementById('filterModal').classList.add('show'); updateFilterPreview();
}

function sliderRow(label, id, min, max, val) {
  return `<div class="filter-slider-row"><span class="filter-slider-label">${label}</span><input type="range" class="filter-slider" id="${id}" min="${min}" max="${max}" value="${val}"><input type="number" class="filter-slider-value" id="${id}Num" min="${min}" max="${max}" value="${val}"></div>`;
}

function updateFilterPreview() {
  const previewCanvas = document.getElementById('filterPreviewCanvas'); const pctx = previewCanvas.getContext('2d');
  const pw = previewCanvas.width, ph = previewCanvas.height;
  if (currentFilterType === 'brightness' || currentFilterType === 'hsl') {
    const imgData = new ImageData(new Uint8ClampedArray(filterPreviewSrc.data), pw, ph);
    applyPixelFilterToData(imgData, currentFilterType);
    pctx.putImageData(imgData, 0, 0);
  } else {
    const layer = getActiveLayer(); pctx.drawImage(layer.canvas, 0, 0, pw, ph);
    const cssFilter = buildCSSFilter();
    if (cssFilter) { pctx.filter = cssFilter; pctx.drawImage(previewCanvas, 0, 0); pctx.filter = 'none'; }
  }
}

function buildCSSFilter() {
  if (currentFilterType === 'blur') { const r = parseInt(document.getElementById('filterBlurRadius')?.value || 3); return `blur(${r}px)`; }
  else if (currentFilterType === 'sharpen') { const a = 100 + parseInt(document.getElementById('filterSharpenAmt')?.value || 50) / 2; return `contrast(${a}%)`; }
  return null;
}

function applyFilter() {
  const layer = getActiveLayer(); if (!layer) return;
  if (currentFilterType === 'brightness' || currentFilterType === 'hsl') {
    const imgData = layer.ctx.getImageData(0, 0, canvasW, canvasH);
    applyPixelFilterToData(imgData, currentFilterType);
    if (selectionPath) {
      const tempCanvas = document.createElement('canvas'); tempCanvas.width = canvasW; tempCanvas.height = canvasH;
      const tempCtx = tempCanvas.getContext('2d'); tempCtx.putImageData(imgData, 0, 0);
      layer.ctx.save(); layer.ctx.clip(selectionPath, selectionFillRule); layer.ctx.clearRect(0, 0, canvasW, canvasH); layer.ctx.drawImage(tempCanvas, 0, 0); layer.ctx.restore();
    } else { layer.ctx.putImageData(imgData, 0, 0); }
  } else {
    const cssFilter = buildCSSFilter();
    if (cssFilter) {
      const tempCanvas = document.createElement('canvas'); tempCanvas.width = canvasW; tempCanvas.height = canvasH;
      const tempCtx = tempCanvas.getContext('2d'); tempCtx.filter = cssFilter;
      if (selectionPath) { tempCtx.drawImage(layer.canvas, 0, 0); layer.ctx.save(); layer.ctx.clip(selectionPath, selectionFillRule); layer.ctx.clearRect(0, 0, canvasW, canvasH); layer.ctx.drawImage(tempCanvas, 0, 0); layer.ctx.restore(); }
      else { tempCtx.drawImage(layer.canvas, 0, 0); layer.ctx.clearRect(0, 0, canvasW, canvasH); layer.ctx.drawImage(tempCanvas, 0, 0); }
    }
  }
  SnapEngine.invalidateLayer(layer); compositeAll(); closeModal('filterModal');
  pushUndo('Filter');
}

/* ═══════════════════════════════════════════════════════
   LIVE ADJUSTMENT PANEL — Brightness/Contrast & Hue/Saturation
   ─────────────────────────────────────────────────────────
   Floating, draggable panel that updates the active layer in
   real time as sliders move. OK commits + pushes undo;
   Cancel restores the cached original pixel data.

   Performance:
   • Original layer pixels are snapshot once at open.
   • Slider input is coalesced into a single requestAnimationFrame
     pass — multiple input events per frame collapse to one render.
   • Brightness/Contrast uses a 256-entry LUT (one lookup per
     channel) instead of recomputing the formula per pixel.
   • Scratch buffer + scratch canvas are reused across frames to
     avoid per-frame allocation.
   ═══════════════════════════════════════════════════════ */

let _adjType = null;
let _adjLayer = null;
let _adjOriginalImageData = null;     // ImageData snapshot (for revert + per-frame source)
let _adjOriginalBuffer = null;        // Uint8ClampedArray copy (read-only source)
let _adjScratchBuffer = null;         // Reused per-frame working buffer
let _adjScratchImageData = null;      // ImageData wrapping scratch buffer
let _adjScratchCanvas = null;         // Reused for selection clipping
let _adjScratchCtx = null;
let _adjRafPending = false;
let _adjDragInit = false;

function openAdjustmentPanel(type) {
  closeAllMenus();
  const layer = getActiveLayer(); if (!layer) return;

  // If a panel is already open, treat re-open as cancel-then-open so we
  // don't leave the previous original data or canvas in a half-applied state.
  if (_adjType) cancelAdjustment();

  _adjType = type;
  _adjLayer = layer;

  // Snapshot the layer once. This is both the revert source and the per-frame
  // input for filter recomputes — the live layer pixels are overwritten as
  // the user drags, so we need a stable original to read from each frame.
  _adjOriginalImageData = layer.ctx.getImageData(0, 0, canvasW, canvasH);
  _adjOriginalBuffer = new Uint8ClampedArray(_adjOriginalImageData.data);

  // Reusable scratch buffer matching the canvas size.
  _adjScratchBuffer = new Uint8ClampedArray(_adjOriginalBuffer.length);
  _adjScratchImageData = new ImageData(_adjScratchBuffer, canvasW, canvasH);

  // Reusable scratch canvas for selection-clipped writes.
  _adjScratchCanvas = document.createElement('canvas');
  _adjScratchCanvas.width = canvasW;
  _adjScratchCanvas.height = canvasH;
  _adjScratchCtx = _adjScratchCanvas.getContext('2d');

  const titleEl = document.getElementById('adjTitle');
  const controlsEl = document.getElementById('adjControls');
  if (type === 'brightness') {
    titleEl.textContent = 'Brightness / Contrast';
    controlsEl.innerHTML =
      sliderRow('Brightness', 'filterBrightness', -100, 100, 0) +
      sliderRow('Contrast',   'filterContrast',   -100, 100, 0);
  } else if (type === 'hsl') {
    titleEl.textContent = 'Hue / Saturation';
    controlsEl.innerHTML =
      sliderRow('Hue',        'filterHue',        -180, 180, 0) +
      sliderRow('Saturation', 'filterSaturation', -100, 100, 0) +
      sliderRow('Lightness',  'filterLightness',  -100, 100, 0);
  }

  // Wire sliders + numeric inputs (mirrors the modal-filter wiring).
  controlsEl.querySelectorAll('.filter-slider').forEach(slider => {
    const valEl = slider.parentElement.querySelector('.filter-slider-value');
    slider.addEventListener('input', () => {
      if (valEl) valEl.value = slider.value;
      _scheduleAdjPreview();
    });
    slider.addEventListener('dblclick', () => {
      slider.value = slider.defaultValue;
      if (valEl) valEl.value = slider.defaultValue;
      _scheduleAdjPreview();
    });
    if (valEl) {
      const sync = () => {
        const min = parseFloat(slider.min), max = parseFloat(slider.max);
        let v = parseFloat(valEl.value);
        if (isNaN(v)) v = parseFloat(slider.value) || 0;
        v = Math.max(min, Math.min(max, v));
        valEl.value = v;
        slider.value = v;
        _scheduleAdjPreview();
      };
      valEl.addEventListener('input', sync);
      valEl.addEventListener('change', sync);
    }
  });
  controlsEl.querySelectorAll('.filter-slider-row').forEach(row => {
    const slider = row.querySelector('.filter-slider');
    if (!slider) return;
    row.addEventListener('wheel', (e) => {
      e.preventDefault();
      slider.value = Math.max(parseInt(slider.min)||0, Math.min(parseInt(slider.max)||100, (parseInt(slider.value)||0) + wheelDelta(e)));
      slider.dispatchEvent(new Event('input'));
    }, { passive: false });
  });

  // Reset position to centered each open (transform-based centering until drag).
  const panel = document.getElementById('adjustmentPanel');
  panel.style.left = '';
  panel.style.top = '';
  panel.style.transform = '';
  document.getElementById('adjOverlay').classList.add('show');

  if (!_adjDragInit) { _initAdjPanelDrag(); _adjDragInit = true; }
}

function _scheduleAdjPreview() {
  if (_adjRafPending) return;
  _adjRafPending = true;
  requestAnimationFrame(() => {
    _adjRafPending = false;
    _renderAdjPreview();
  });
}

// Build a 256-entry LUT from the same brightness/contrast math used by
// filterBrightnessContrast. Identical output, ~3× faster on large canvases.
function _buildBCLut(brightness, contrast) {
  const lut = new Uint8ClampedArray(256);
  const b = brightness / 100;
  const c = contrast * 2.55;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  for (let v = 0; v < 256; v++) {
    let x = v;
    if (b >= 0) x = x + (255 - x) * b; else x = x * (1 + b);
    x = cf * (x - 128) + 128;
    lut[v] = x;
  }
  return lut;
}

function _renderAdjPreview() {
  if (!_adjLayer || !_adjOriginalImageData) return;
  const layer = _adjLayer;
  const src = _adjOriginalBuffer;
  const dst = _adjScratchBuffer;
  const len = src.length;

  // Read slider values once.
  let isIdentity = false;
  if (_adjType === 'brightness') {
    const bv = parseInt(document.getElementById('filterBrightness')?.value || 0);
    const cv = parseInt(document.getElementById('filterContrast')?.value || 0);
    if (bv === 0 && cv === 0) {
      isIdentity = true;
    } else {
      const lut = _buildBCLut(bv, cv);
      for (let i = 0; i < len; i += 4) {
        const a = src[i + 3];
        if (a === 0) {
          dst[i] = 0; dst[i + 1] = 0; dst[i + 2] = 0; dst[i + 3] = 0;
        } else {
          dst[i]     = lut[src[i]];
          dst[i + 1] = lut[src[i + 1]];
          dst[i + 2] = lut[src[i + 2]];
          dst[i + 3] = a;
        }
      }
    }
  } else if (_adjType === 'hsl') {
    const h = parseInt(document.getElementById('filterHue')?.value || 0);
    const s = parseInt(document.getElementById('filterSaturation')?.value || 0);
    const l = parseInt(document.getElementById('filterLightness')?.value || 0);
    if (h === 0 && s === 0 && l === 0) {
      isIdentity = true;
    } else {
      // Copy original into scratch, then run the existing in-place HSL filter.
      dst.set(src);
      filterHSL(dst, h, s, l);
    }
  }

  // Identity: just restore the original (no work needed, but selection-safe).
  if (isIdentity) {
    if (selectionPath) {
      // Outside-selection pixels were never touched; full restore is fine.
      layer.ctx.putImageData(_adjOriginalImageData, 0, 0);
    } else {
      layer.ctx.putImageData(_adjOriginalImageData, 0, 0);
    }
  } else if (selectionPath) {
    // 1) Restore baseline so outside-selection pixels match original.
    layer.ctx.putImageData(_adjOriginalImageData, 0, 0);
    // 2) Stage filtered pixels on the scratch canvas.
    _adjScratchCtx.putImageData(_adjScratchImageData, 0, 0);
    // 3) Clip-overwrite only the selected region with the filtered result.
    layer.ctx.save();
    layer.ctx.clip(selectionPath, selectionFillRule);
    layer.ctx.clearRect(0, 0, canvasW, canvasH);
    layer.ctx.drawImage(_adjScratchCanvas, 0, 0);
    layer.ctx.restore();
  } else {
    layer.ctx.putImageData(_adjScratchImageData, 0, 0);
  }

  SnapEngine.invalidateLayer(layer);
  compositeAll();
}

function commitAdjustment() {
  if (!_adjType) return;
  // Make sure the latest slider state is rendered to the layer before commit.
  // If there's a pending rAF, run it synchronously now so the committed pixels
  // exactly reflect the visible state.
  if (_adjRafPending) {
    _adjRafPending = false;
    _renderAdjPreview();
  }
  const layer = _adjLayer;
  _closeAdjustmentPanel();
  if (layer) {
    SnapEngine.invalidateLayer(layer);
    compositeAll();
    pushUndo('Filter');
  }
}

function cancelAdjustment() {
  if (!_adjType) return;
  // Cancel any pending render so it can't run after we restore.
  _adjRafPending = false;
  if (_adjLayer && _adjOriginalImageData) {
    _adjLayer.ctx.putImageData(_adjOriginalImageData, 0, 0);
    SnapEngine.invalidateLayer(_adjLayer);
    compositeAll();
  }
  _closeAdjustmentPanel();
}

function _closeAdjustmentPanel() {
  document.getElementById('adjOverlay').classList.remove('show');
  _adjType = null;
  _adjLayer = null;
  _adjOriginalImageData = null;
  _adjOriginalBuffer = null;
  _adjScratchBuffer = null;
  _adjScratchImageData = null;
  _adjScratchCanvas = null;
  _adjScratchCtx = null;
}

function _initAdjPanelDrag() {
  const panel = document.getElementById('adjustmentPanel');
  const titlebar = document.getElementById('adjTitlebar');
  let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
  titlebar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.adj-close')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    // Convert from transform-centered to absolute left/top so future writes
    // to .style.left/.style.top move the panel directly.
    const rect = panel.getBoundingClientRect();
    panel.style.transform = 'none';
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    startLeft = rect.left;
    startTop = rect.top;
    titlebar.setPointerCapture(e.pointerId);
  });
  titlebar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    let nl = startLeft + (e.clientX - startX);
    let nt = startTop + (e.clientY - startY);
    const maxL = window.innerWidth - panel.offsetWidth;
    const maxT = window.innerHeight - panel.offsetHeight;
    nl = Math.max(0, Math.min(nl, maxL));
    nt = Math.max(0, Math.min(nt, maxT));
    panel.style.left = nl + 'px';
    panel.style.top = nt + 'px';
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try { titlebar.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  titlebar.addEventListener('pointerup', stop);
  titlebar.addEventListener('pointercancel', stop);
}

// Esc cancels the open adjustment panel (mirrors Settings/PNG-export behavior).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && _adjType) {
    e.preventDefault();
    e.stopPropagation();
    cancelAdjustment();
  }
}, true);

/* ═══════════════════════════════════════════════════════
   FILE I/O
   ═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════
   IMPORT IMAGE AS LAYER — Smart Object System
   ═══════════════════════════════════════════════════════ */

/**
 * Image-larger-than-canvas chooser. Resolves to 'expand' | 'keep' | 'cancel'.
 * Enter triggers the focused card (default Expand). Esc / Cancel button /
 * overlay-click resolve to 'cancel'. Used by single-image paste and single-
 * file import-as-layer when the incoming bitmap exceeds the canvas in either
 * dimension.
 */
let _importSizeDialogActive = false;
function openImportSizeDialog(imgW, imgH) {
  return new Promise((resolve) => {
    if (_importSizeDialogActive) { resolve('cancel'); return; }
    _importSizeDialogActive = true;
    const overlay = document.getElementById('importSizeModal');
    const expandBtn = document.getElementById('importSizeExpand');
    const keepBtn = document.getElementById('importSizeKeep');
    const cancelBtn = document.getElementById('importSizeCancel');
    const dimsEl = document.getElementById('importSizeDims');
    if (dimsEl) dimsEl.textContent = `The incoming image (${imgW} × ${imgH}) is larger than the canvas (${canvasW} × ${canvasH}).`;

    let focusIdx = 0;
    const cards = [expandBtn, keepBtn];
    const setFocus = (i) => {
      focusIdx = (i + cards.length) % cards.length;
      cards.forEach((c, idx) => c.classList.toggle('is-focused', idx === focusIdx));
      cards[focusIdx].focus();
    };

    const cleanup = (choice) => {
      overlay.classList.remove('show');
      cards.forEach(c => c.classList.remove('is-focused'));
      expandBtn.removeEventListener('click', onExpand);
      keepBtn.removeEventListener('click', onKeep);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onOverlay);
      document.removeEventListener('keydown', onKey, true);
      _importSizeDialogActive = false;
      resolve(choice);
    };
    const onExpand = () => cleanup('expand');
    const onKeep   = () => cleanup('keep');
    const onCancel = () => cleanup('cancel');
    const onOverlay = (e) => { if (e.target === overlay) cleanup('cancel'); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); cleanup(cards[focusIdx].dataset.choice); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); setFocus(focusIdx + 1); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'Tab' && e.shiftKey) { e.preventDefault(); setFocus(focusIdx - 1); }
    };

    expandBtn.addEventListener('click', onExpand);
    keepBtn.addEventListener('click', onKeep);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onOverlay);
    document.addEventListener('keydown', onKey, true);

    overlay.classList.add('show');
    setFocus(0);
  });
}

/**
 * expandCanvasToFit — Grows the document to (newW, newH), keeping all existing
 * layer content anchored to the top-left (Paint.NET behavior). No-op if the
 * requested dimensions are already covered. Does not push undo on its own —
 * callers (import/paste) bake the expand + new-layer placement into a single
 * history entry.
 */
function expandCanvasToFit(newW, newH) {
  newW = Math.max(canvasW, newW | 0);
  newH = Math.max(canvasH, newH | 0);
  if (newW === canvasW && newH === canvasH) return;
  layers.forEach(l => {
    const tmp = document.createElement('canvas');
    tmp.width = newW; tmp.height = newH;
    tmp.getContext('2d').drawImage(l.canvas, 0, 0);
    l.canvas.width = newW; l.canvas.height = newH;
    l.ctx = l.canvas.getContext('2d', { willReadFrequently: true });
    l.ctx.drawImage(tmp, 0, 0);
  });
  canvasW = newW; canvasH = newH;
  compositeCanvas.width = newW; compositeCanvas.height = newH;
  overlayCanvas.width = newW; overlayCanvas.height = newH;
  canvasWrapper.style.width = newW + 'px'; canvasWrapper.style.height = newH + 'px';
  checkerPattern = null;
  SnapEngine.invalidateAllLayers();
}

function saveImage(format) {
  if (format === 'jpg') { saveJpg(); return; }
  if (format === 'webp') { saveWebP(); return; }
  closeAllMenus();
  const exportCanvas = document.createElement('canvas'); exportCanvas.width = canvasW; exportCanvas.height = canvasH;
  const ectx = exportCanvas.getContext('2d');
  for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; if (!l.visible) continue; ectx.globalAlpha = l.opacity; ectx.drawImage(l.canvas, 0, 0); if (i === activeLayerIndex && floatingActive && floatingCanvas) ectx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y); }
  ectx.globalAlpha = 1;
  exportCanvas.toBlob(blob => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'image.png'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); }, 'image/png', 0.92);
}

/* ═══════════════════════════════════════════════════════
   EXPORT TIF / BMP — Bit-depth modal + binary encoders
   ═══════════════════════════════════════════════════════ */

let pendingExportFormat = null;

function openExportModal(format) {
  closeAllMenus();
  pendingExportFormat = format;
  document.getElementById('exportModalTitle').textContent = 'Export ' + (format === 'tif' ? 'TIF' : 'BMP');
  // Reset to Auto Detect
  const modal = document.getElementById('exportBitDepthModal');
  const radios = modal.querySelectorAll('input[name="exportBitDepth"]');
  radios.forEach(r => {
    r.checked = r.value === 'auto';
    r.closest('.export-option').classList.toggle('selected', r.value === 'auto');
  });
  modal.classList.add('show');
}

// Wire up radio button selection highlighting
document.getElementById('exportBitDepthModal').addEventListener('change', function(e) {
  if (e.target.name === 'exportBitDepth') {
    this.querySelectorAll('.export-option').forEach(o => o.classList.remove('selected'));
    e.target.closest('.export-option').classList.add('selected');
  }
});

function executeExport() {
  const choice = document.querySelector('input[name="exportBitDepth"]:checked').value;
  closeModal('exportBitDepthModal');
  // Composite all visible layers
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = canvasW; exportCanvas.height = canvasH;
  const ectx = exportCanvas.getContext('2d');
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]; if (!l.visible) continue;
    ectx.globalAlpha = l.opacity;
    ectx.drawImage(l.canvas, 0, 0);
    if (i === activeLayerIndex && floatingActive && floatingCanvas)
      ectx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y);
  }
  ectx.globalAlpha = 1;
  const rgba = ectx.getImageData(0, 0, canvasW, canvasH);

  // Determine bit depth
  let bitDepth;
  if (choice === 'auto') {
    let hasAlpha = false;
    const d = rgba.data;
    for (let i = 3, len = d.length; i < len; i += 4) {
      if (d[i] < 255) { hasAlpha = true; break; }
    }
    bitDepth = hasAlpha ? 32 : 24;
  } else {
    bitDepth = parseInt(choice);
  }

  // For 24-bit, flatten alpha onto white
  if (bitDepth === 24) {
    const d = rgba.data;
    for (let i = 0, len = d.length; i < len; i += 4) {
      const a = d[i + 3] / 255;
      d[i]     = Math.round(d[i]     * a + 255 * (1 - a));
      d[i + 1] = Math.round(d[i + 1] * a + 255 * (1 - a));
      d[i + 2] = Math.round(d[i + 2] * a + 255 * (1 - a));
      d[i + 3] = 255;
    }
  }

  let blob;
  if (pendingExportFormat === 'bmp') {
    blob = encodeBMP(rgba, canvasW, canvasH, bitDepth);
  } else {
    blob = encodeTIFF(rgba, canvasW, canvasH, bitDepth);
  }
  const ext = pendingExportFormat === 'bmp' ? '.bmp' : '.tif';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'image' + ext; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* encodeBMP and encodeTIFF live in js/export/bmpExport.js and js/export/tifExport.js */

/* ICO export logic lives in js/export/icoExport.js */

/* ═══════════════════════════════════════════════════════
   MENUS
   ═══════════════════════════════════════════════════════ */

function closeAllMenus() { document.querySelectorAll('.menu-dropdown').forEach(d => d.classList.remove('show')); document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('open')); document.querySelectorAll('.menu-has-submenu').forEach(el => el.classList.remove('submenu-open')); if (window._clearMenuSubmenuTimer) window._clearMenuSubmenuTimer(); openMenuId = null; if (window.IEM && window.IEM.applyFileMenuState) window.IEM.applyFileMenuState(); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

/* ═══════════════════════════════════════════════════════
   SETTINGS — Color Mode (Light / Dark / System) + theme manager
   ═══════════════════════════════════════════════════════ */

// Persisted user preference: 'light' | 'dark' | 'system' (default).
// A boot script in index.html <head> reads this BEFORE first paint to
// prevent a flash-of-wrong-theme; this manager handles all subsequent
// runtime switching, including live-reaction to OS theme changes.
const ThemeManager = {
  STORAGE_KEY: 'opsin.settings.colorMode',
  VALID: new Set(['light', 'dark', 'system']),
  _mql: null,
  _current: null,    // user preference
  _effective: null,  // applied theme ('light' | 'dark')
  _transTimer: null,

  init() {
    let saved = null;
    try { saved = localStorage.getItem(this.STORAGE_KEY); } catch (e) {}
    if (!this.VALID.has(saved)) saved = 'system';
    this._current = saved;
    this._mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    if (this._mql) {
      const onSysChange = () => { if (this._current === 'system') this._applyEffective(true); };
      if (this._mql.addEventListener) this._mql.addEventListener('change', onSysChange);
      else if (this._mql.addListener) this._mql.addListener(onSysChange);  // Safari legacy
    }
    this._applyEffective(false);
    this._syncUI();
  },

  set(mode) {
    if (!this.VALID.has(mode)) mode = 'system';
    if (mode === this._current) { this._syncUI(); return; }
    this._current = mode;
    try { localStorage.setItem(this.STORAGE_KEY, mode); } catch (e) {}
    this._applyEffective(true);
    this._syncUI();
  },

  _resolve() {
    if (this._current === 'light') return 'light';
    if (this._current === 'dark')  return 'dark';
    return (this._mql && this._mql.matches) ? 'light' : 'dark';
  },

  _applyEffective(animate) {
    const effective = this._resolve();
    const root = document.documentElement;
    if (animate && effective !== this._effective) {
      root.classList.add('theme-transitioning');
      clearTimeout(this._transTimer);
      this._transTimer = setTimeout(() => root.classList.remove('theme-transitioning'), 260);
    }
    if (effective === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    const changed = (effective !== this._effective);
    this._effective = effective;
    // Redraw canvas-drawn chrome that sampled the old theme's colors
    if (changed) {
      try { if (typeof rulerHCtx !== 'undefined' && rulerHCtx && typeof rulersVisible !== 'undefined' && rulersVisible) drawRulers(); } catch (e) {}
    }
    this._broadcastToIframes();
  },

  _broadcastToIframes() {
    const effective = this._effective;
    const cp = document.getElementById('cpIframe');
    if (cp && cp.contentWindow) { try { cp.contentWindow.postMessage({ action: 'theme', effective }, '*'); } catch (e) {} }
    const info = document.getElementById('infoIframe');
    if (info && info.contentWindow) { try { info.contentWindow.postMessage({ action: 'theme', effective }, '*'); } catch (e) {} }
  },

  _syncUI() {
    const grid = document.getElementById('themeChoiceGrid');
    if (grid) {
      grid.querySelectorAll('.theme-choice').forEach(btn => {
        const on = btn.dataset.mode === this._current;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    const hint = document.getElementById('themeHint');
    if (hint) {
      if (this._current === 'system') {
        hint.textContent = `Matches your device's color scheme automatically (currently ${this._effective}).`;
      } else if (this._current === 'light') {
        hint.textContent = 'A refined, professional light palette — clean neutral surfaces with deepened accents.';
      } else {
        hint.textContent = 'The classic Opsin dark theme — easy on the eyes for extended editing sessions.';
      }
    }
  }
};

// Boot synchronously so data-theme is correct before rulers/canvas first draw.
ThemeManager.init();

// Session baseline — captured when the window opens, restored if the user
// cancels. Built as an object so future settings can snapshot alongside
// colorMode without restructuring.
let _settingsBaseline = null;

function openSettings() {
  closeAllMenus();
  _settingsBaseline = {
    colorMode: ThemeManager._current
  };
  ThemeManager._syncUI();
  document.getElementById('settingsModal').classList.add('show');
}

// OK — changes were applied in real-time and already persisted. Just close.
function commitSettings() {
  _settingsBaseline = null;
  document.getElementById('settingsModal').classList.remove('show');
}

// Cancel / Esc / X / backdrop — revert every setting touched this session
// back to its baseline, then close.
function cancelSettings() {
  if (_settingsBaseline) {
    if (_settingsBaseline.colorMode !== ThemeManager._current) {
      ThemeManager.set(_settingsBaseline.colorMode);
    }
    _settingsBaseline = null;
  }
  document.getElementById('settingsModal').classList.remove('show');
}

// Cancel on Escape while the Settings modal is open
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const m = document.getElementById('settingsModal');
    if (m && m.classList.contains('show')) { cancelSettings(); e.stopPropagation(); }
  }
}, true);

// Cancel on click-outside (overlay backdrop)
document.getElementById('settingsModal').addEventListener('click', function(e) {
  if (e.target === this) cancelSettings();
});

// Wire up theme-choice card clicks
document.querySelectorAll('.theme-choice').forEach(btn => {
  btn.addEventListener('click', () => ThemeManager.set(btn.dataset.mode));
});

// Wire up Settings sidebar category switching (ready for future categories)
document.querySelectorAll('.settings-cat').forEach(btn => {
  btn.addEventListener('click', () => {
    const cat = btn.dataset.cat;
    document.querySelectorAll('.settings-cat').forEach(c => c.classList.toggle('active', c === btn));
    document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === cat));
  });
});

/* ═══════════════════════════════════════════════════════
   STATUS BAR
   ═══════════════════════════════════════════════════════ */

function updateStatus(e) {
  document.getElementById('statusSize').textContent = `${canvasW} × ${canvasH}`;
  document.getElementById('statusZoom').textContent = Math.round(zoom * 100) + '%';
}

/* ═══════════════════════════════════════════════════════
   BRUSH CURSOR PREVIEW
   ═══════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════
   FLIP & ROTATE
   ═══════════════════════════════════════════════════════ */

function flipHorizontal() {
  closeAllMenus();
  layers.forEach(l => { const temp = document.createElement('canvas'); temp.width = canvasW; temp.height = canvasH; const tctx = temp.getContext('2d'); tctx.translate(canvasW, 0); tctx.scale(-1, 1); tctx.drawImage(l.canvas, 0, 0); l.ctx.clearRect(0, 0, canvasW, canvasH); l.ctx.drawImage(temp, 0, 0); });
  compositeAll(); updateLayerPanel();
  pushUndo('Flip H');
}
function flipVertical() {
  closeAllMenus();
  layers.forEach(l => { const temp = document.createElement('canvas'); temp.width = canvasW; temp.height = canvasH; const tctx = temp.getContext('2d'); tctx.translate(0, canvasH); tctx.scale(1, -1); tctx.drawImage(l.canvas, 0, 0); l.ctx.clearRect(0, 0, canvasW, canvasH); l.ctx.drawImage(temp, 0, 0); });
  compositeAll(); updateLayerPanel();
  pushUndo('Flip V');
}
function rotateImage(angle) {
  closeAllMenus();
  const isSwap = (angle === 90 || angle === 270 || angle === -90);
  const newW = isSwap ? canvasH : canvasW; const newH = isSwap ? canvasW : canvasH;
  layers.forEach(l => { const temp = document.createElement('canvas'); temp.width = newW; temp.height = newH; const tctx = temp.getContext('2d'); tctx.translate(newW/2, newH/2); tctx.rotate(angle * Math.PI / 180); tctx.drawImage(l.canvas, -canvasW/2, -canvasH/2); l.canvas.width = newW; l.canvas.height = newH; l.ctx = l.canvas.getContext('2d', { willReadFrequently: true }); l.ctx.drawImage(temp, 0, 0); });
  canvasW = newW; canvasH = newH; compositeCanvas.width = newW; compositeCanvas.height = newH; overlayCanvas.width = newW; overlayCanvas.height = newH;
  canvasWrapper.style.width = newW + 'px'; canvasWrapper.style.height = newH + 'px'; checkerPattern = null;
  clearSelection(); zoomFit(); compositeAll(); updateLayerPanel(); updateStatus();
  pushUndo('Rotate');
}
function rotateCW() { rotateImage(90); }
function rotateCCW() { rotateImage(-90); }
function rotate180() { rotateImage(180); }

/* ═══════════════════════════════════════════════════════
   PROPERTIES PANEL
   ═══════════════════════════════════════════════════════ */

let propsAspectLocked = false;
let propsAspectRatio = 1;
let _propsUpdating = false;

function updatePropertiesPanel() {
  if (_propsUpdating) return;
  _propsUpdating = true;
  const wIn = document.getElementById('propW');
  const hIn = document.getElementById('propH');
  const xIn = document.getElementById('propX');
  const yIn = document.getElementById('propY');
  const lockBtn = document.getElementById('propAspectLock');
  if (!wIn) { _propsUpdating = false; return; }

  const focused = document.activeElement;
  const propsInputs = [wIn, hIn, xIn, yIn];
  const userIsEditing = propsInputs.includes(focused);

  // Direct Selection — only x/y are editable, everything else greyed out.
  if (currentTool === 'directselect') {
    const rotIn = document.getElementById('propRotation');
    const flipH = document.getElementById('propFlipH');
    const flipV = document.getElementById('propFlipV');
    const alignDots = document.querySelectorAll('.props-align-btn');
    let dsPos = null;
    if (window.DirectSelection && window.DirectSelection.getSingleAnchorPos) {
      dsPos = window.DirectSelection.getSingleAnchorPos();
    }
    if (dsPos) {
      if (focused !== xIn) xIn.value = Math.round(dsPos.x);
      if (focused !== yIn) yIn.value = Math.round(dsPos.y);
      xIn.disabled = false; yIn.disabled = false;
    } else {
      xIn.value = ''; yIn.value = '';
      xIn.disabled = true; yIn.disabled = true;
    }
    wIn.value = ''; hIn.value = '';
    wIn.disabled = true; hIn.disabled = true;
    lockBtn.disabled = true;
    if (rotIn) { rotIn.disabled = true; rotIn.value = 0; }
    if (flipH) flipH.disabled = true;
    if (flipV) flipV.disabled = true;
    alignDots.forEach(d => d.disabled = true);
    _propsUpdating = false;
    return;
  }

  // Guide selected — show position only
  if (selectedGuide && currentTool === 'move') {
    const rotIn = document.getElementById('propRotation');
    const flipH = document.getElementById('propFlipH');
    const flipV = document.getElementById('propFlipV');
    const alignDots = document.querySelectorAll('.props-align-btn');
    if (selectedGuide.axis === 'v') {
      if (focused !== xIn) xIn.value = Math.round(selectedGuide.pos);
      xIn.disabled = false;
      yIn.value = ''; yIn.disabled = true;
    } else {
      if (focused !== yIn) yIn.value = Math.round(selectedGuide.pos);
      yIn.disabled = false;
      xIn.value = ''; xIn.disabled = true;
    }
    wIn.value = ''; wIn.disabled = true;
    hIn.value = ''; hIn.disabled = true;
    lockBtn.disabled = true;
    if (rotIn) { rotIn.disabled = true; rotIn.value = 0; }
    if (flipH) flipH.disabled = true;
    if (flipV) flipV.disabled = true;
    alignDots.forEach(d => d.disabled = true);
    _propsUpdating = false;
    return;
  }

  let bounds = null;
  let editable = false;
  let shapeRotation = null;        // numeric deg, single-shape only
  let shapeBoundsActive = false;   // shape tool driving these fields

  if (currentTool === 'shape' && window.ShapeTool && window.ShapeTool.getSelectedBounds) {
    const sb = window.ShapeTool.getSelectedBounds();
    if (sb) {
      bounds = { x: Math.round(sb.x), y: Math.round(sb.y), w: Math.round(sb.w), h: Math.round(sb.h) };
      editable = true;
      shapeBoundsActive = true;
      if (sb.rotation != null) shapeRotation = Math.round(sb.rotation * 100) / 100;
    }
  } else if (currentTool === 'move') {
    // Move tool driving a shape layer — same panel surface as Shape tool.
    let _shapeBoundsHandled = false;
    if (window.ShapeTool && window.ShapeTool.isOpenForMoveTool && window.ShapeTool.isOpenForMoveTool()
        && window.ShapeTool.getSelectedBounds) {
      const sb = window.ShapeTool.getSelectedBounds();
      if (sb) {
        bounds = { x: Math.round(sb.x), y: Math.round(sb.y), w: Math.round(sb.w), h: Math.round(sb.h) };
        editable = true;
        shapeBoundsActive = true;
        if (sb.rotation != null) shapeRotation = Math.round(sb.rotation * 100) / 100;
        _shapeBoundsHandled = true;
      }
    }
    if (!_shapeBoundsHandled) {
      if (window.TextTool && window.TextTool.isActive && window.TextTool.isActive()) {
        const _tm = window.TextTool.getActiveModel && window.TextTool.getActiveModel();
        if (_tm) {
          bounds = { x: Math.round(_tm.boxX), y: Math.round(_tm.boxY), w: Math.round(_tm.boxW), h: Math.round(_tm.boxH) };
          editable = true;
        }
      } else if (pxTransformActive && pxTransformData) {
        const cb = pxTransformData.curBounds;
        bounds = { x: Math.round(cb.x), y: Math.round(cb.y), w: Math.round(cb.w), h: Math.round(cb.h) };
        editable = true;
      } else if (floatingActive && floatingCanvas) {
        bounds = { x: Math.round(floatingOffset.x), y: Math.round(floatingOffset.y), w: floatingCanvas.width, h: floatingCanvas.height };
        editable = true;
      }
    }
  } else if (currentTool === 'movesel') {
    if (selection) {
      const sb = getSelectionBounds();
      if (sb && sb.w > 0 && sb.h > 0) {
        bounds = { x: Math.round(sb.x), y: Math.round(sb.y), w: Math.round(sb.w), h: Math.round(sb.h) };
        editable = true;
      }
    }
  } else if (selection) {
    const sb = getSelectionBounds();
    if (sb && sb.w > 0 && sb.h > 0) {
      bounds = { x: Math.round(sb.x), y: Math.round(sb.y), w: Math.round(sb.w), h: Math.round(sb.h) };
    }
  }

  const rotIn = document.getElementById('propRotation');
  const flipH = document.getElementById('propFlipH');
  const flipV = document.getElementById('propFlipV');
  const alignDots = document.querySelectorAll('.props-align-btn');
  const allPropsInputs = [wIn, hIn, xIn, yIn, rotIn];
  const userIsEditingAny = allPropsInputs.includes(focused);

  // Determine if transform actions (rotate/flip/align) are available
  const transformable = editable && !(currentTool === 'move' && floatingActive && !pxTransformActive);
  // Shape tool: rotation editable only for single-shape selection (and not lines).
  const shapeRotEditable = shapeBoundsActive && shapeRotation != null;

  if (bounds) {
    if (!userIsEditing) {
      wIn.value = bounds.w; hIn.value = bounds.h;
      xIn.value = bounds.x; yIn.value = bounds.y;
    } else {
      for (const inp of propsInputs) {
        if (inp !== focused) {
          if (inp === wIn) inp.value = bounds.w;
          else if (inp === hIn) inp.value = bounds.h;
          else if (inp === xIn) inp.value = bounds.x;
          else if (inp === yIn) inp.value = bounds.y;
        }
      }
    }
    wIn.disabled = !editable; hIn.disabled = !editable;
    xIn.disabled = !editable; yIn.disabled = !editable;
    lockBtn.disabled = !editable;
    if (editable && currentTool === 'move' && floatingActive && !pxTransformActive) {
      wIn.disabled = true; hIn.disabled = true;
      lockBtn.disabled = true;
    }
  } else if (!userIsEditingAny) {
    wIn.value = ''; hIn.value = '';
    xIn.value = ''; yIn.value = '';
    wIn.disabled = true; hIn.disabled = true;
    xIn.disabled = true; yIn.disabled = true;
    lockBtn.disabled = true;
  }

  // Rotation, flip, align controls
  if (rotIn) {
    if (shapeBoundsActive) {
      rotIn.disabled = !shapeRotEditable;
      if (focused !== rotIn) rotIn.value = shapeRotEditable ? shapeRotation : 0;
    } else {
      rotIn.disabled = !transformable;
      if (!transformable && focused !== rotIn) rotIn.value = 0;
    }
  }
  if (flipH) flipH.disabled = shapeBoundsActive ? !editable : !transformable;
  if (flipV) flipV.disabled = shapeBoundsActive ? !editable : !transformable;
  alignDots.forEach(d => d.disabled = !editable);

  _propsUpdating = false;
}

function initPropertiesPanel() {
  const wIn = document.getElementById('propW');
  const hIn = document.getElementById('propH');
  const xIn = document.getElementById('propX');
  const yIn = document.getElementById('propY');
  const lockBtn = document.getElementById('propAspectLock');

  function applyPropsChange(field) {
    if (_propsUpdating) return;
    const val = parseInt(field === 'w' ? wIn.value : field === 'h' ? hIn.value : field === 'x' ? xIn.value : yIn.value);
    if (isNaN(val)) return;

    // Guide position editing
    if (selectedGuide && currentTool === 'move') {
      if (selectedGuide.axis === 'v' && field === 'x') { selectedGuide.pos = val; drawGuides(); }
      else if (selectedGuide.axis === 'h' && field === 'y') { selectedGuide.pos = val; drawGuides(); }
      return;
    }

    // Direct Selection — x/y only, drive the single selected anchor.
    if (currentTool === 'directselect'
        && window.DirectSelection && window.DirectSelection.setSingleAnchorField) {
      if (field === 'x' || field === 'y') window.DirectSelection.setSingleAnchorField(field, val);
      return;
    }

    // Shape tool — drive the selected shape (or group) directly.
    if (currentTool === 'shape' && window.ShapeTool && window.ShapeTool.setSelectedBoundsField) {
      window.ShapeTool.setSelectedBoundsField(field, val);
      return;
    }

    // Move tool driving a shape layer — same surface as Shape tool.
    if (currentTool === 'move'
        && window.ShapeTool && window.ShapeTool.isOpenForMoveTool && window.ShapeTool.isOpenForMoveTool()
        && window.ShapeTool.setSelectedBoundsField) {
      window.ShapeTool.setSelectedBoundsField(field, val);
      return;
    }

    if (currentTool === 'move' && window.TextTool && window.TextTool.isActive && window.TextTool.isActive()) {
      if (field === 'x' || field === 'y') {
        const _tm = window.TextTool.getActiveModel && window.TextTool.getActiveModel();
        if (_tm) {
          const nx = field === 'x' ? val : Math.round(_tm.boxX);
          const ny = field === 'y' ? val : Math.round(_tm.boxY);
          window.TextTool.setPosition(nx, ny);
          if (typeof pushUndo === 'function') pushUndo('Move Text');
          if (window.TextTool.bumpBaseline) window.TextTool.bumpBaseline();
        }
      } else if (field === 'w' && window.TextTool.setBoxWidth) {
        window.TextTool.setBoxWidth(val);
        if (typeof pushUndo === 'function') pushUndo('Resize Text');
        if (window.TextTool.bumpBaseline) window.TextTool.bumpBaseline();
      } else if (field === 'h' && window.TextTool.setBoxHeight) {
        window.TextTool.setBoxHeight(val);
        if (typeof pushUndo === 'function') pushUndo('Resize Text');
        if (window.TextTool.bumpBaseline) window.TextTool.bumpBaseline();
      }
      return;
    }

    if (currentTool === 'move' && pxTransformActive && pxTransformData) {
      const cb = pxTransformData.curBounds;
      if (field === 'w') {
        const newW = Math.max(1, val);
        if (propsAspectLocked && cb.w > 0) {
          cb.h = Math.max(1, Math.round(newW / propsAspectRatio));
        }
        cb.w = newW;
      } else if (field === 'h') {
        const newH = Math.max(1, val);
        if (propsAspectLocked && cb.h > 0) {
          cb.w = Math.max(1, Math.round(newH * propsAspectRatio));
        }
        cb.h = newH;
      } else if (field === 'x') {
        cb.x = val;
      } else if (field === 'y') {
        cb.y = val;
      }
      compositeAll(); drawOverlay();
      // No history push — this numeric edit is part of the live Free
      // Transform session and will fold into the single entry at commit.
    } else if (currentTool === 'move' && floatingActive && floatingCanvas) {
      if (field === 'x') floatingOffset.x = val;
      else if (field === 'y') floatingOffset.y = val;
      compositeAll(); drawOverlay();
      pushUndo('Move');
    } else if (currentTool === 'movesel' && selection) {
      const sb = getSelectionBounds();
      if (!sb) return;
      if (field === 'w') {
        const newW = Math.max(1, val);
        if (propsAspectLocked && sb.w > 0) {
          const newH = Math.max(1, Math.round(newW / propsAspectRatio));
          applySelectionResize(sb, newW, newH);
        } else {
          applySelectionResize(sb, newW, sb.h);
        }
      } else if (field === 'h') {
        const newH = Math.max(1, val);
        if (propsAspectLocked && sb.h > 0) {
          const newW = Math.max(1, Math.round(newH * propsAspectRatio));
          applySelectionResize(sb, newW, newH);
        } else {
          applySelectionResize(sb, sb.w, newH);
        }
      } else if (field === 'x') {
        applySelectionMove(sb, val - sb.x, 0);
      } else if (field === 'y') {
        applySelectionMove(sb, 0, val - sb.y);
      }
      buildSelectionPath(); drawOverlay();
      pushUndo('Move Selection');
    }
  }

  wIn.addEventListener('change', () => applyPropsChange('w'));
  hIn.addEventListener('change', () => applyPropsChange('h'));
  xIn.addEventListener('change', () => applyPropsChange('x'));
  yIn.addEventListener('change', () => applyPropsChange('y'));

  wIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { wIn.blur(); } });
  hIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { hIn.blur(); } });
  xIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { xIn.blur(); } });
  yIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { yIn.blur(); } });

  lockBtn.addEventListener('click', () => {
    propsAspectLocked = !propsAspectLocked;
    lockBtn.classList.toggle('locked', propsAspectLocked);
    const useEl = lockBtn.querySelector('svg use');
    useEl.setAttribute('href', propsAspectLocked ? '#icon-chain-linked' : '#icon-chain-unlinked');
    if (propsAspectLocked) {
      const w = parseInt(wIn.value) || 1;
      const h = parseInt(hIn.value) || 1;
      propsAspectRatio = w / h;
    }
  });

  // Rotation input
  const rotIn = document.getElementById('propRotation');
  rotIn.addEventListener('change', () => {
    const angle = parseFloat(rotIn.value);
    if (currentTool === 'shape' && window.ShapeTool && window.ShapeTool.setSelectedBoundsField) {
      if (isNaN(angle)) { rotIn.value = 0; return; }
      window.ShapeTool.setSelectedBoundsField('rotation', angle);
      return;
    }
    if (currentTool === 'move'
        && window.ShapeTool && window.ShapeTool.isOpenForMoveTool && window.ShapeTool.isOpenForMoveTool()
        && window.ShapeTool.setSelectedBoundsField) {
      if (isNaN(angle)) { rotIn.value = 0; return; }
      window.ShapeTool.setSelectedBoundsField('rotation', angle);
      return;
    }
    if (isNaN(angle) || angle === 0) { rotIn.value = 0; return; }
    if (currentTool === 'move' && pxTransformActive && pxTransformData) {
      propsRotatePixelTransform(angle);
    } else if (currentTool === 'movesel' && selection) {
      propsRotateSelection(angle);
    }
    // Keep the typed angle visible in the field while the transform session
    // is still live; updatePropertiesPanel() resets to 0 on commit/cancel
    // (when transformable becomes false).
  });
  rotIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') rotIn.blur(); });

  // Flip buttons
  function _moveOnShape() {
    return currentTool === 'move'
      && window.ShapeTool && window.ShapeTool.isOpenForMoveTool && window.ShapeTool.isOpenForMoveTool();
  }

  document.getElementById('propFlipH').addEventListener('click', () => {
    if (currentTool === 'shape' && window.ShapeTool && window.ShapeTool.flipSelected) { window.ShapeTool.flipSelected('h'); return; }
    if (_moveOnShape() && window.ShapeTool.flipSelected) { window.ShapeTool.flipSelected('h'); return; }
    if (currentTool === 'move' && pxTransformActive) propsFlipPixelTransform('h');
    else if (currentTool === 'movesel' && selection) propsFlipSelection('h');
  });
  document.getElementById('propFlipV').addEventListener('click', () => {
    if (currentTool === 'shape' && window.ShapeTool && window.ShapeTool.flipSelected) { window.ShapeTool.flipSelected('v'); return; }
    if (_moveOnShape() && window.ShapeTool.flipSelected) { window.ShapeTool.flipSelected('v'); return; }
    if (currentTool === 'move' && pxTransformActive) propsFlipPixelTransform('v');
    else if (currentTool === 'movesel' && selection) propsFlipSelection('v');
  });

  // Alignment bar — Photoshop-style 6-axis alignment
  document.querySelectorAll('.props-align-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const align = btn.dataset.align;
      if (currentTool === 'shape' && window.ShapeTool && window.ShapeTool.alignSelectedToCanvas) { window.ShapeTool.alignSelectedToCanvas(align); return; }
      if (_moveOnShape() && window.ShapeTool.alignSelectedToCanvas) { window.ShapeTool.alignSelectedToCanvas(align); return; }
      if (currentTool === 'move' && pxTransformActive) propsAlignPixelTransform(align);
      else if (currentTool === 'move' && floatingActive) propsAlignFloating(align);
      else if (currentTool === 'movesel' && selection) propsAlignSelection(align);
    });
  });
}

/* --- Floating Selection: Align --- */

function propsAlignFloating(align) {
  if (!floatingActive || !floatingCanvas) return;
  const fw = floatingCanvas.width, fh = floatingCanvas.height;
  switch (align) {
    case 'l':  floatingOffset.x = 0; break;
    case 'ch': floatingOffset.x = Math.round((canvasW - fw) / 2); break;
    case 'r':  floatingOffset.x = canvasW - fw; break;
    case 't':  floatingOffset.y = 0; break;
    case 'cv': floatingOffset.y = Math.round((canvasH - fh) / 2); break;
    case 'b':  floatingOffset.y = canvasH - fh; break;
    default: return;
  }
  compositeAll(); drawOverlay();
  pushUndo('Align');
}

/* --- Selection: Rotate / Flip / Align --- */

function ensureSelectionHasPoints() {
  if (!selection) return;
  if (selection.type === 'lasso' && selection.points) return;
  if ((selection.type === 'wand' || selection.type === 'composite') && selection.contours) return;
  const sb = getSelectionBounds();
  if (!sb) return;
  if (selection.type === 'ellipse') {
    const rx = sb.w / 2, ry = sb.h / 2;
    const ecx = sb.x + rx, ecy = sb.y + ry;
    const n = Math.max(72, Math.ceil(Math.max(rx, ry)));
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      pts.push({ x: ecx + rx * Math.cos(a), y: ecy + ry * Math.sin(a) });
    }
    selection.type = 'lasso'; selection.points = pts;
  } else {
    selection.type = 'lasso';
    selection.points = [
      { x: sb.x, y: sb.y }, { x: sb.x + sb.w, y: sb.y },
      { x: sb.x + sb.w, y: sb.y + sb.h }, { x: sb.x, y: sb.y + sb.h }
    ];
  }
}

function propsRotateSelection(angleDeg) {
  if (!selection) return;
  const sb = getSelectionBounds();
  if (!sb || sb.w < 1 || sb.h < 1) return;
  const cx = sb.x + sb.w / 2, cy = sb.y + sb.h / 2;
  const rad = angleDeg * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  function rotPt(p) {
    const dx = p.x - cx, dy = p.y - cy;
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  }
  ensureSelectionHasPoints();
  if ((selection.type === 'wand' || selection.type === 'composite') && selection.contours) {
    selection.contours = selection.contours.map(poly => poly.map(rotPt));
  } else if (selection.points) {
    selection.points = selection.points.map(rotPt);
  }
  const nb = getSelectionBounds();
  if (nb) { selection.x = nb.x; selection.y = nb.y; selection.w = nb.w; selection.h = nb.h; }
  buildSelectionPath(); drawOverlay();
  pushUndo('Rotate Selection');
}

function propsFlipSelection(axis) {
  if (!selection) return;
  const sb = getSelectionBounds();
  if (!sb || sb.w < 1 || sb.h < 1) return;
  const cx = sb.x + sb.w / 2, cy = sb.y + sb.h / 2;
  ensureSelectionHasPoints();
  if ((selection.type === 'wand' || selection.type === 'composite') && selection.contours) {
    selection.contours = selection.contours.map(poly =>
      poly.map(p => axis === 'h' ? { x: 2 * cx - p.x, y: p.y } : { x: p.x, y: 2 * cy - p.y })
    );
  } else if (selection.points) {
    selection.points = selection.points.map(p =>
      axis === 'h' ? { x: 2 * cx - p.x, y: p.y } : { x: p.x, y: 2 * cy - p.y }
    );
  }
  buildSelectionPath(); drawOverlay();
  pushUndo('Flip Selection');
}

function propsAlignSelection(align) {
  if (!selection) return;
  const sb = getSelectionBounds();
  if (!sb) return;
  let dx = 0, dy = 0;
  switch (align) {
    case 'l':  dx = -sb.x; break;
    case 'ch': dx = Math.round((canvasW - sb.w) / 2) - sb.x; break;
    case 'r':  dx = (canvasW - sb.w) - sb.x; break;
    case 't':  dy = -sb.y; break;
    case 'cv': dy = Math.round((canvasH - sb.h) / 2) - sb.y; break;
    case 'b':  dy = (canvasH - sb.h) - sb.y; break;
    default: return;
  }
  if (dx === 0 && dy === 0) return;
  applySelectionMove(sb, dx, dy);
  buildSelectionPath(); drawOverlay();
  pushUndo('Align Selection');
}

function applySelectionResize(oldBounds, newW, newH) {
  if (!selection) return;
  const sx = newW / oldBounds.w;
  const sy = newH / oldBounds.h;
  const ox = oldBounds.x;
  const oy = oldBounds.y;

  if (selection.type === 'lasso' && selection.points) {
    selection.points = selection.points.map(p => ({
      x: ox + (p.x - ox) * sx,
      y: oy + (p.y - oy) * sy
    }));
  } else if ((selection.type === 'wand' || selection.type === 'composite') && selection.contours) {
    selection.contours = selection.contours.map(poly =>
      poly.map(p => ({ x: ox + (p.x - ox) * sx, y: oy + (p.y - oy) * sy }))
    );
  }
  if (selection.w !== undefined) { selection.w = newW; selection.h = newH; }
}

function applySelectionMove(oldBounds, dx, dy) {
  if (!selection) return;
  if (selection.type === 'lasso' && selection.points) {
    selection.points = selection.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
  } else if ((selection.type === 'wand' || selection.type === 'composite') && selection.contours) {
    selection.contours = selection.contours.map(poly =>
      poly.map(p => ({ x: p.x + dx, y: p.y + dy }))
    );
  }
  if (selection.x !== undefined) { selection.x += dx; selection.y += dy; }
}

/* ═══════════════════════════════════════════════════════
   SNAP ENGINE — unified Snap-To system (Photoshop-style)
   ═══════════════════════════════════════════════════════
   Central, self-contained module that every draggable tool
   can plug into via a tiny API:
     beginSession(context) → call at drag start
     snapBounds / snapPoint / snapValue → call during drag
     endSession() → call at drag end
   Indicators draw automatically via drawIndicators(ctx).
   ─────────────────────────────────────────────────────── */

const SnapEngine = (function () {
  // ── State ──
  let enabled = true;
  let activeIndicators = [];   // [{axis:'v'|'h', pos, kind, extent?}]
  let _sessionTargets = null;  // frozen {v:[], h:[]} during a drag
  let _sessionContext = null;

  // Category flags — ready for a future View > Snap To > sub-menu
  const categories = {
    documentBounds: true,
    guides: true,
    layers: true,
    selection: true
  };

  // ── Persistence ──
  try {
    const stored = localStorage.getItem('opsin.snap.enabled');
    if (stored !== null) enabled = (stored === 'true');
  } catch (e) {}

  function _save() {
    try { localStorage.setItem('opsin.snap.enabled', String(enabled)); } catch (e) {}
  }

  function _updateMenuCheck() {
    const el = document.getElementById('snapCheck');
    if (el) el.classList.toggle('hidden', !enabled);
  }

  // ── State API ──
  function isEnabled() { return enabled; }
  function setEnabled(v) {
    enabled = !!v;
    _save();
    _updateMenuCheck();
    clearIndicators();
    if (typeof drawOverlay === 'function') drawOverlay();
  }
  function toggle() { setEnabled(!enabled); }

  // Ctrl (or Cmd on macOS) inverts the current state during a drag
  function isActive(modifiers) {
    const ctrl = modifiers && (modifiers.ctrlKey || modifiers.metaKey);
    return ctrl ? !enabled : enabled;
  }

  // ── Zoom-aware threshold ──
  // Base 7 screen px, slightly tighter when zoomed in, looser when zoomed out.
  // Returned in canvas-space (divided by zoom) so callers can compare directly.
  function getThreshold() {
    let t = 7;
    if (zoom >= 4)   t = 5;
    if (zoom >= 16)  t = 4;
    if (zoom <= 0.5) t = 9;
    if (zoom <= 0.2) t = 10;
    return t / zoom;
  }

  // ── Layer bounds cache ──
  // `undefined` = not cached, `null` = cached as empty, object = cached bounds.
  function getCachedLayerBounds(layer) {
    if (!layer) return null;
    if (layer._snapBoundsCache !== undefined) return layer._snapBoundsCache;
    const b = getLayerContentBounds(layer);
    layer._snapBoundsCache = b;
    return b;
  }
  function invalidateLayer(layer) { if (layer) layer._snapBoundsCache = undefined; }
  function invalidateAllLayers() {
    if (typeof layers === 'undefined' || !layers) return;
    for (const l of layers) if (l) l._snapBoundsCache = undefined;
  }

  // ── Target collection ──
  function collectTargets(context) {
    context = context || {};
    const out = { v: [], h: [] };
    const addV = (pos, kind, extent) => { if (isFinite(pos)) out.v.push({ pos, kind, extent }); };
    const addH = (pos, kind, extent) => { if (isFinite(pos)) out.h.push({ pos, kind, extent }); };

    // Document bounds — edges, center, thirds
    if (categories.documentBounds) {
      addV(0, 'canvas-edge');
      addV(canvasW, 'canvas-edge');
      addV(canvasW / 2, 'canvas-center');
      addV(canvasW / 3, 'canvas-third');
      addV((canvasW * 2) / 3, 'canvas-third');
      addH(0, 'canvas-edge');
      addH(canvasH, 'canvas-edge');
      addH(canvasH / 2, 'canvas-center');
      addH(canvasH / 3, 'canvas-third');
      addH((canvasH * 2) / 3, 'canvas-third');
    }

    // Guides
    if (categories.guides && !context.excludeGuides && typeof guidesVisible !== 'undefined' && guidesVisible) {
      const skipId = context.excludeGuideId;
      for (const g of guides) {
        if (skipId != null && g.id === skipId) continue;
        if (g.axis === 'v') addV(g.pos, 'guide');
        else addH(g.pos, 'guide');
      }
    }

    // Other layers' content bounding box
    if (categories.layers && typeof layers !== 'undefined') {
      const skip = context.excludeLayerIds || null;
      for (let i = 0; i < layers.length; i++) {
        const l = layers[i];
        if (!l || !l.visible) continue;
        if (skip && skip.has(l.id)) continue;
        const b = getCachedLayerBounds(l);
        if (!b) continue;
        const extY = { start: b.y, end: b.y + b.h };
        const extX = { start: b.x, end: b.x + b.w };
        addV(b.x,             'layer-edge',   extY);
        addV(b.x + b.w,       'layer-edge',   extY);
        addV(b.x + b.w / 2,   'layer-center', extY);
        addH(b.y,             'layer-edge',   extX);
        addH(b.y + b.h,       'layer-edge',   extX);
        addH(b.y + b.h / 2,   'layer-center', extX);
      }
    }

    // Active selection bounds
    if (categories.selection && !context.excludeSelection) {
      const sb = (typeof getSelectionBounds === 'function') ? getSelectionBounds() : null;
      if (sb && sb.w > 0 && sb.h > 0) {
        const extY = { start: sb.y, end: sb.y + sb.h };
        const extX = { start: sb.x, end: sb.x + sb.w };
        addV(sb.x,              'selection-edge',   extY);
        addV(sb.x + sb.w,       'selection-edge',   extY);
        addV(sb.x + sb.w / 2,   'selection-center', extY);
        addH(sb.y,              'selection-edge',   extX);
        addH(sb.y + sb.h,       'selection-edge',   extX);
        addH(sb.y + sb.h / 2,   'selection-center', extX);
      }
    }

    return out;
  }

  // ── Session (freeze targets for the duration of a drag) ──
  function beginSession(context) {
    _sessionContext = context || {};
    _sessionTargets = collectTargets(_sessionContext);
  }
  function endSession() {
    _sessionTargets = null;
    _sessionContext = null;
    clearIndicators();
  }
  function hasSession() { return _sessionTargets !== null; }

  function _getTargets(fallbackContext) {
    return _sessionTargets || collectTargets(fallbackContext || {});
  }

  // ── Core axis snap ──
  function _snapAxis(candidate, axisTargets, threshold) {
    let best = null;
    for (const t of axisTargets) {
      const d = Math.abs(candidate - t.pos);
      if (d < threshold && (!best || d < best.d)) {
        best = { d, pos: t.pos, kind: t.kind, extent: t.extent };
      }
    }
    return best;
  }

  // ── Snap a bounding rect ──
  function snapBounds(bounds, opts) {
    opts = opts || {};
    if (!isActive(opts.modifiers)) { clearIndicators(); return { dx: 0, dy: 0 }; }
    const targets = _getTargets(opts.context);
    const th = getThreshold();

    const { x, y, w, h } = bounds;
    const cx = opts.candidatesX || [
      { val: x         },
      { val: x + w / 2 },
      { val: x + w     }
    ];
    const cy = opts.candidatesY || [
      { val: y         },
      { val: y + h / 2 },
      { val: y + h     }
    ];

    let bx = null, by = null;
    for (const c of cx) {
      const s = _snapAxis(c.val, targets.v, th);
      if (s && (!bx || s.d < bx.d)) bx = { d: s.d, delta: s.pos - c.val, pos: s.pos, kind: s.kind, extent: s.extent };
    }
    for (const c of cy) {
      const s = _snapAxis(c.val, targets.h, th);
      if (s && (!by || s.d < by.d)) by = { d: s.d, delta: s.pos - c.val, pos: s.pos, kind: s.kind, extent: s.extent };
    }

    const inds = [];
    if (bx) inds.push({ axis: 'v', pos: bx.pos, kind: bx.kind, extent: bx.extent });
    if (by) inds.push({ axis: 'h', pos: by.pos, kind: by.kind, extent: by.extent });
    setIndicators(inds);

    return { dx: bx ? bx.delta : 0, dy: by ? by.delta : 0 };
  }

  // ── Snap a point ──
  function snapPoint(pt, opts) {
    opts = opts || {};
    if (!isActive(opts.modifiers)) { clearIndicators(); return { x: pt.x, y: pt.y, snappedX: false, snappedY: false }; }
    const targets = _getTargets(opts.context);
    const th = getThreshold();
    const sx = _snapAxis(pt.x, targets.v, th);
    const sy = _snapAxis(pt.y, targets.h, th);
    const inds = [];
    const r = { x: pt.x, y: pt.y, snappedX: false, snappedY: false };
    if (sx) { r.x = sx.pos; r.snappedX = true; inds.push({ axis: 'v', pos: sx.pos, kind: sx.kind, extent: sx.extent }); }
    if (sy) { r.y = sy.pos; r.snappedY = true; inds.push({ axis: 'h', pos: sy.pos, kind: sy.kind, extent: sy.extent }); }
    setIndicators(inds);
    return r;
  }

  // ── Snap a single axis value (used by guide drag) ──
  function snapValue(val, axis, opts) {
    opts = opts || {};
    if (!isActive(opts.modifiers)) { clearIndicators(); return { val, snapped: false }; }
    const targets = _getTargets(opts.context);
    const th = getThreshold();
    const axisTargets = (axis === 'v') ? targets.v : targets.h;
    const s = _snapAxis(val, axisTargets, th);
    if (s) {
      setIndicators([{ axis, pos: s.pos, kind: s.kind, extent: s.extent }]);
      return { val: s.pos, snapped: true };
    }
    clearIndicators();
    return { val, snapped: false };
  }

  // ── Indicator rendering ──
  function setIndicators(list) { activeIndicators = list || []; }
  function clearIndicators() { activeIndicators = []; }
  function getIndicators() { return activeIndicators.slice(); }

  function drawIndicators(ctx) {
    if (!activeIndicators.length) return;
    const ws = workspace.getBoundingClientRect();
    ctx.save();
    ctx.strokeStyle = '#FF00FF'; // Photoshop smart guide magenta
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const ind of activeIndicators) {
      ctx.beginPath();
      if (ind.axis === 'v') {
        const sx = ind.pos * zoom + panX;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, ws.height);
      } else {
        const sy = ind.pos * zoom + panY;
        ctx.moveTo(0, sy);
        ctx.lineTo(ws.width, sy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Public API
  return {
    isEnabled, setEnabled, toggle, isActive,
    getThreshold,
    beginSession, endSession, hasSession,
    snapBounds, snapPoint, snapValue,
    collectTargets,
    setIndicators, clearIndicators, getIndicators, drawIndicators,
    invalidateLayer, invalidateAllLayers,
    syncMenuCheck: _updateMenuCheck,
    categories
  };
})();

/* ═══════════════════════════════════════════════════════
   RULERS
   ═══════════════════════════════════════════════════════ */

function toggleRulers() {
  rulersVisible = !rulersVisible;
  rulerH.style.display = rulersVisible ? '' : 'none';
  rulerV.style.display = rulersVisible ? '' : 'none';
  rulerCorner.style.display = rulersVisible ? '' : 'none';
  const chk = document.getElementById('rulerCheck');
  if (chk) chk.classList.toggle('hidden', !rulersVisible);
  if (isFitMode) {
    zoomFit();
  } else if (rulersVisible) {
    drawRulers();
  }
}

/* ═══════════════════════════════════════════════════════
   GUIDES
   ═══════════════════════════════════════════════════════ */

function toggleGuides() {
  guidesVisible = !guidesVisible;
  const chk = document.getElementById('guideCheck');
  if (chk) chk.classList.toggle('hidden', !guidesVisible);
  drawGuides();
}

function clearAllGuides() {
  guides = [];
  selectedGuide = null;
  draggingGuide = null;
  drawGuides();
  updatePropertiesPanel();
}

/* ═══════════════════════════════════════════════════════
   RULER TOOL (screen-space UI overlay)
   Viewport-only measurement; does not touch layers or undo.
   ═══════════════════════════════════════════════════════ */

function clearRuler() {
  rulerState.active = false;
  rulerState.x1 = rulerState.y1 = rulerState.x2 = rulerState.y2 = 0;
  rulerDrag = null;
  SnapEngine.endSession();
  drawUIOverlay();
  updateRulerOptionsBar();
}

// ── Ruler drag → create guide ──
rulerH.style.pointerEvents = 'auto';
rulerV.style.pointerEvents = 'auto';

rulerH.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const pos = screenToCanvas(e.clientX, e.clientY);
  const _id = guideIdCounter++;
  SnapEngine.beginSession({ excludeGuides: true, excludeGuideId: _id });
  const _sv = SnapEngine.snapValue(pos.y, 'h', { modifiers: e, excludeGuides: true, excludeGuideId: _id });
  const g = { id: _id, axis: 'h', pos: _sv.val };
  guides.push(g);
  selectedGuide = g;
  draggingGuide = { guide: g, isNew: true };
  workspace.style.cursor = 'ns-resize';
  drawGuides();
  drawOverlay();
  updatePropertiesPanel();
});

rulerV.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const pos = screenToCanvas(e.clientX, e.clientY);
  const _id = guideIdCounter++;
  SnapEngine.beginSession({ excludeGuides: true, excludeGuideId: _id });
  const _sv = SnapEngine.snapValue(pos.x, 'v', { modifiers: e, excludeGuides: true, excludeGuideId: _id });
  const g = { id: _id, axis: 'v', pos: _sv.val };
  guides.push(g);
  selectedGuide = g;
  draggingGuide = { guide: g, isNew: true };
  workspace.style.cursor = 'ew-resize';
  drawGuides();
  drawOverlay();
  updatePropertiesPanel();
});

// Ensure mouseup on document also finalizes guide drag (in case mouse leaves workspace)
document.addEventListener('mouseup', (e) => {
  if (!draggingGuide) return;
  const wsRect = workspace.getBoundingClientRect();
  const mx = e.clientX - wsRect.left;
  const my = e.clientY - wsRect.top;
  const g = draggingGuide.guide;
  const overHRuler = my < RULER_SIZE;
  const overVRuler = mx < RULER_SIZE;
  if ((g.axis === 'h' && overHRuler) || (g.axis === 'v' && overVRuler)) {
    guides = guides.filter(x => x !== g);
    if (selectedGuide === g) selectedGuide = null;
  } else {
    selectedGuide = g;
  }
  draggingGuide = null;
  SnapEngine.endSession();
  workspace.style.cursor = getToolCursor();
  drawGuides();
  drawOverlay();
  updatePropertiesPanel();
});

// Track guide drag on document-level mousemove (for when mouse is over rulers during drag)
document.addEventListener('mousemove', (e) => {
  if (!draggingGuide) return;
  const pos = screenToCanvas(e.clientX, e.clientY);
  const _axis = draggingGuide.guide.axis;
  const _raw = _axis === 'v' ? pos.x : pos.y;
  const _sv = SnapEngine.snapValue(_raw, _axis, { modifiers: e, excludeGuides: true, excludeGuideId: draggingGuide.guide.id });
  draggingGuide.guide.pos = _sv.val;
  drawGuides();
  drawOverlay();
  updatePropertiesPanel();
});

/* ═══════════════════════════════════════════════════════
   CANVAS CONTEXT LOSS RECOVERY

   Browsers may reclaim GPU memory for visible canvases
   under memory pressure or after extended idle periods,
   causing contexts to be silently lost.  The underlying
   layer data (offscreen canvases) is unaffected — only
   the on-screen compositing breaks.

   Three-layer defence:
   1. contextlost / contextrestored events (standard API)
   2. visibilitychange handler  (catches tab-switch loss)
   3. Periodic watchdog         (catches silent edge cases)
   ═══════════════════════════════════════════════════════ */

function _recoverCanvasDisplay() {
  checkerPattern = null;
  compositeAll();
  drawOverlay();
  drawGuides();
  drawRulers();
  drawUIOverlay();
}

// — Composite canvas (main display) —
compositeCanvas.addEventListener('contextlost', (e) => { e.preventDefault(); });
compositeCanvas.addEventListener('contextrestored', () => { _recoverCanvasDisplay(); });

// — Overlay canvas (marching ants, transform handles) —
overlayCanvas.addEventListener('contextlost', (e) => { e.preventDefault(); });
overlayCanvas.addEventListener('contextrestored', () => { drawOverlay(); });

// — Guide overlay canvas —
guideOverlay.addEventListener('contextlost', (e) => { e.preventDefault(); });
guideOverlay.addEventListener('contextrestored', () => { drawGuides(); });

// — UI overlay canvas (ruler tool) —
uiOverlay.addEventListener('contextlost', (e) => { e.preventDefault(); });
uiOverlay.addEventListener('contextrestored', () => { drawUIOverlay(); });

// — Tab visibility change —
// Context loss commonly occurs when a tab is backgrounded.
// Re-composite immediately when the tab regains focus.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestAnimationFrame(_recoverCanvasDisplay);
  }
});

// — Periodic watchdog (every 4 s) —
// Catches silent context loss on browsers that don't fire the event,
// or edge cases where the event is missed.
let _ctxWatchdogLost = false;
setInterval(() => {
  if (typeof compositeCtx.isContextLost === 'function') {
    if (compositeCtx.isContextLost()) {
      _ctxWatchdogLost = true;
    } else if (_ctxWatchdogLost) {
      _ctxWatchdogLost = false;
      _recoverCanvasDisplay();
    }
  }
}, 4000);

/* ═══════════════════════════════════════════════════════
   PWA TOOLBAR DETECTION
   Detects whether running as a Chrome Web App and whether
   the browser toolbar is expanded or collapsed, then swaps
   the version number between the menubar (top-right) and
   the status bar (bottom-right) accordingly.

   Single signal: viewport height (window.innerHeight).
   When Chrome's toolbar expands it reduces the content
   viewport, so a sustained drop > THRESHOLD below the
   rolling maximum baseline = toolbar expanded.

   Both `resize` and WCO `geometrychange` events are used
   as triggers for the same height evaluation — not as
   direct state reads — so wco.visible semantics and
   Chrome's event timing are irrelevant.

   Self-correcting: if the user resizes the window larger,
   the baseline updates and the threshold auto-adjusts.
   ═══════════════════════════════════════════════════════ */

(function initPWABehavior() {
  const isPWA = window.matchMedia('(display-mode: standalone)').matches
             || window.matchMedia('(display-mode: window-controls-overlay)').matches
             || navigator.standalone === true; // iOS Safari
  if (!isPWA) return;

  // Mark body so CSS can distinguish PWA from regular browser
  document.body.classList.add('is-pwa');

  const hasWCO = 'windowControlsOverlay' in navigator;
  const THRESHOLD = 30; // px; Chrome toolbar is ~48 px
  let baselineH = window.innerHeight;
  let rafId = null;

  function evaluate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;

      let toolbarShown;
      if (hasWCO) {
        // WCO API: visible === true means overlay is active (title bar hidden)
        toolbarShown = !navigator.windowControlsOverlay.visible;
      } else {
        // Fallback: height heuristic for standalone mode
        const h = window.innerHeight;
        if (h > baselineH) baselineH = h;
        toolbarShown = baselineH - h > THRESHOLD;
      }
      document.body.classList.toggle('pwa-toolbar-shown', toolbarShown);
    });
  }

  window.addEventListener('resize', evaluate);

  if (hasWCO) {
    navigator.windowControlsOverlay.addEventListener('geometrychange', evaluate);
  }

  // Defer initial check one frame so the layout has settled
  evaluate();
})();

/* ═══ LAYERS / HISTORY TAB SWITCHER (springboard panel) ══════════════════ */
function switchLayersHistoryTab(tab) {
  const root = document.getElementById('layersHistoryPanel');
  if (!root) return;
  root.dataset.activeTab = tab;
  root.querySelectorAll('.panel-tab').forEach(btn => {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  root.querySelectorAll('[data-tab-pane]').forEach(pane => {
    pane.hidden = pane.dataset.tabPane !== tab;
  });
  root.querySelectorAll('[data-actions-for]').forEach(grp => {
    grp.hidden = grp.dataset.actionsFor !== tab;
  });
}
