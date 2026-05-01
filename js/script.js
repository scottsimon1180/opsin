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
  if (cancelActiveOperation()) return;
  if (typeof History === 'undefined' || !History) return;
  History.undo();
}

function doRedo() {
  if (_nudgePending) flushNudgeUndo();
  if (typeof History === 'undefined' || !History) return;
  History.redo();
}

/**
 * Render the History panel using real SVG icons from linked_icons.js.
 * Each entry's iconId maps to an `<svg><use href="#icon-..."/></svg>` glyph.
 */
function updateHistoryPanel() {
  const list = document.getElementById('historyList');
  if (!list) return;
  if (typeof History === 'undefined' || !History) { list.innerHTML = ''; return; }

  const timeline = History.getTimeline();
  const cursor = History.getCursor();

  // Rebuild the list; this runs only on state changes, not per-frame.
  list.innerHTML = '';

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const el = document.createElement('button');
    el.className = 'history-entry';
    el.type = 'button';
    if (i < cursor) el.classList.add('past');
    else if (i === cursor) el.classList.add('current');
    else el.classList.add('future');

    const icon = document.createElement('span');
    icon.className = 'history-icon';
    icon.innerHTML = '<svg><use href="#icon-' + (entry.iconId || 'menu-refresh') + '"/></svg>';

    const label = document.createElement('span');
    label.className = 'history-label';
    label.textContent = entry.name;

    el.appendChild(icon);
    el.appendChild(label);
    el.title = entry.name;
    el.onclick = () => {
      if (cancelActiveOperation()) return;
      History.jumpTo(i);
    };
    list.appendChild(el);
  }

  const currentEl = list.querySelector('.history-entry.current');
  if (currentEl) {
    currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
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

/* ═══════════════════════════════════════════════════════
   DRAWING TOOLS — Professional Engine
   ═══════════════════════════════════════════════════════ */

let smoothX = 0, smoothY = 0;
let dabDistAccum = 0;

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

// Brush dab cache — rebuilt only when (size, hardness, color) changes.
// Pre-rendering the dab ourselves lets us apply ordered dither so 8-bit alpha
// banding (visible as contour rings on large soft brushes) becomes imperceptible
// high-frequency noise. This matches how Photoshop/Photopea/Pixlr render soft brushes.
let _dabCache = null;
const _BAYER4 = [
  [ 0, 8, 2,10],
  [12, 4,14, 6],
  [ 3,11, 1, 9],
  [15, 7,13, 5]
];

function buildDabCanvas(size, hardness, rgb) {
  const d = Math.max(2, Math.ceil(size) + 2); // +2 for a 1-px transparent margin
  const c = document.createElement('canvas');
  c.width = d; c.height = d;
  const cx = c.getContext('2d');
  const img = cx.createImageData(d, d);
  const data = img.data;
  const r = size / 2;
  const plateau = r * hardness;
  const fadeBand = Math.max(1e-6, r * (1 - hardness));
  const cxp = d / 2, cyp = d / 2;
  for (let y = 0; y < d; y++) {
    for (let x = 0; x < d; x++) {
      const dx = x + 0.5 - cxp, dy = y + 0.5 - cyp;
      const dist = Math.sqrt(dx*dx + dy*dy);
      let a;
      if (dist <= plateau) a = 1.0;
      else if (dist >= r) a = 0.0;
      else a = 1.0 - (dist - plateau) / fadeBand;
      // Ordered dither: ±0.5 LSB shift from a 4×4 Bayer matrix breaks banding
      // without changing the mean alpha of any region.
      const dith = (_BAYER4[y & 3][x & 3] / 16) - 0.5;
      const a8 = Math.max(0, Math.min(255, Math.round(a * 255 + dith)));
      const i = (y * d + x) * 4;
      data[i]   = rgb.r;
      data[i+1] = rgb.g;
      data[i+2] = rgb.b;
      data[i+3] = a8;
    }
  }
  cx.putImageData(img, 0, 0);
  return c;
}

function getDabCanvas(size, hardness, color) {
  const rgb = hexToRGBA(color);
  if (_dabCache && _dabCache.size === size && _dabCache.hardness === hardness
      && _dabCache.r === rgb.r && _dabCache.g === rgb.g && _dabCache.b === rgb.b) {
    return _dabCache.canvas;
  }
  const canvas = buildDabCanvas(size, hardness, rgb);
  _dabCache = { size, hardness, r: rgb.r, g: rgb.g, b: rgb.b, canvas };
  return canvas;
}

function renderBrushDab(ctx, x, y, size, hardness, color) {
  const r = size/2;
  if(r<0.25) return;
  if(hardness>=0.995){
    // Hard brush: use the native arc+fill to get browser sub-pixel anti-aliasing.
    ctx.fillStyle=color; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); return;
  }
  // Soft brush: stamp the dithered pre-rendered dab.
  const dab = getDabCanvas(size, hardness, color);
  ctx.drawImage(dab, x - dab.width/2, y - dab.height/2);
}

function getDabSpacing(size) { return Math.max(1, size * 0.15); }

function stampBrushSegment(ctx, x0, y0, x1, y1, size, hardness, color) {
  const dist = Math.hypot(x1-x0, y1-y0);
  if(dist < 0.1) return;
  const spacing = getDabSpacing(size);
  const dx = (x1-x0)/dist, dy = (y1-y0)/dist;
  let remaining = dist;
  let cx = x0, cy = y0;
  while(remaining > 0) {
    const stepNeeded = spacing - dabDistAccum;
    if(stepNeeded <= remaining) {
      cx += dx * stepNeeded; cy += dy * stepNeeded;
      remaining -= stepNeeded; dabDistAccum = 0;
      renderBrushDab(ctx, cx, cy, size, hardness, color);
    } else {
      cx += dx * remaining; cy += dy * remaining;
      dabDistAccum += remaining; remaining = 0;
    }
  }
}

function stampPencilDab(ctx, x, y, size, color) {
  ctx.fillStyle=color;
  const half=Math.floor(size/2);
  ctx.fillRect(Math.floor(x)-half, Math.floor(y)-half, size, size);
}

function stampPencilLine(ctx, x0, y0, x1, y1, size, color) {
  let ix0=Math.floor(x0), iy0=Math.floor(y0);
  const ix1=Math.floor(x1), iy1=Math.floor(y1);
  const dx=Math.abs(ix1-ix0), dy=Math.abs(iy1-iy0);
  const sx=ix0<ix1?1:-1, sy=iy0<iy1?1:-1;
  let err=dx-dy;
  const half=Math.floor(size/2);
  ctx.fillStyle=color;
  while(true){
    ctx.fillRect(ix0-half,iy0-half,size,size);
    if(ix0===ix1&&iy0===iy1) break;
    const e2=2*err;
    if(e2>-dy){err-=dy;ix0+=sx;}
    if(e2<dx){err+=dx;iy0+=sy;}
  }
}

function smoothInit(x,y){smoothX=x;smoothY=y;}
function smoothStep(x,y,smoothness){
  const pull=1-smoothness*0.92;
  smoothX+=(x-smoothX)*pull;
  smoothY+=(y-smoothY)*pull;
  return {x:smoothX,y:smoothY};
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
   MAGIC WAND — Tolerance-based Selection
   ═══════════════════════════════════════════════════════ */

function magicWandSelect(startX, startY, tolerance, contiguous) {
  const layer = getActiveLayer();
  if (!layer) return null;
  const w = canvasW, h = canvasH;
  const sx = Math.floor(startX), sy = Math.floor(startY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const imgData = layer.ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const tol = Math.max(0, Math.min(255, Math.floor(tolerance)));
  const ti = (sy * w + sx) * 4;
  const tR = data[ti], tG = data[ti + 1], tB = data[ti + 2], tA = data[ti + 3];
  const mask = new Uint8Array(w * h);
  function matches(pos) {
    const i = pos * 4;
    return Math.abs(data[i] - tR) <= tol && Math.abs(data[i+1] - tG) <= tol && Math.abs(data[i+2] - tB) <= tol && Math.abs(data[i+3] - tA) <= tol;
  }
  if (contiguous) {
    const visited = new Uint8Array(w * h);
    if (!matches(sx + sy * w)) return null;
    let sl = sx, sr = sx;
    while (sl > 0 && !visited[sy * w + sl - 1] && matches(sy * w + sl - 1)) sl--;
    while (sr < w - 1 && !visited[sy * w + sr + 1] && matches(sy * w + sr + 1)) sr++;
    const stack = [];
    for (let x = sl; x <= sr; x++) { const pos = sy * w + x; visited[pos] = 1; mask[pos] = 1; }
    stack.push([sy, sl, sr]);
    function scanLine(y, parentLeft, parentRight) {
      if (y < 0 || y >= h) return;
      let x = parentLeft;
      while (x <= parentRight) {
        const pos = y * w + x;
        if (visited[pos] || !matches(pos)) { x++; continue; }
        let left = x, right = x;
        while (left > 0 && !visited[y * w + left - 1] && matches(y * w + left - 1)) left--;
        while (right < w - 1 && !visited[y * w + right + 1] && matches(y * w + right + 1)) right++;
        for (let fx = left; fx <= right; fx++) { const fpos = y * w + fx; visited[fpos] = 1; mask[fpos] = 1; }
        stack.push([y, left, right]);
        x = right + 1;
      }
    }
    while (stack.length > 0) { const [cy, cl, cr] = stack.pop(); scanLine(cy - 1, cl, cr); scanLine(cy + 1, cl, cr); }
  } else {
    for (let i = 0; i < w * h; i++) { if (matches(i)) mask[i] = 1; }
  }
  const contours = maskToContours(mask, w, h);
  if (contours.length === 0) return null;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (const poly of contours) { for (const p of poly) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; } }
  return { contours: contours, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/**
 * Converts a binary pixel mask into vector contour polygons using edge tracing.
 * Uses integer-keyed Map for edge lookup (no string allocation) and scans only the
 * tight bounding box of set pixels for performance on large canvases.
 * Each contour is a closed polygon of {x, y} grid-aligned vertices.
 * @param {Uint8Array} mask - Binary mask (0 = unset, nonzero = set), w*h elements.
 * @param {number} w - Mask width.
 * @param {number} h - Mask height.
 * @returns {Array<Array<{x:number, y:number}>>} Array of contour polygons.
 */
function maskToContours(mask, w, h) {
  // Find tight bounding box to limit edge scan
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) {
      const x = i % w, y = (i / w) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
  }
  if (bx1 < 0) return [];

  // Build edge map using integer keys (vertex grid is (w+1) wide)
  const stride = w + 1;
  const edgeMap = new Map();
  function addEdge(fx, fy, tx, ty) {
    const k = fy * stride + fx;
    let arr = edgeMap.get(k);
    if (!arr) { arr = []; edgeMap.set(k, arr); }
    arr.push({ x: tx, y: ty, used: false });
  }

  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      if (!mask[y * w + x]) continue;
      if (y === 0     || !mask[(y - 1) * w + x])     addEdge(x, y, x + 1, y);
      if (x === w - 1 || !mask[y * w + x + 1])       addEdge(x + 1, y, x + 1, y + 1);
      if (y === h - 1 || !mask[(y + 1) * w + x])     addEdge(x + 1, y + 1, x, y + 1);
      if (x === 0     || !mask[y * w + x - 1])       addEdge(x, y + 1, x, y);
    }
  }

  function turnRank(inDx, inDy, outDx, outDy) {
    const cross = inDx * outDy - inDy * outDx;
    const dot   = inDx * outDx + inDy * outDy;
    if (cross > 0) return 0; if (cross === 0 && dot > 0) return 1; if (cross < 0) return 2; return 3;
  }

  const contours = [];
  for (const [startKey, startEdges] of edgeMap) {
    for (let si = 0; si < startEdges.length; si++) {
      if (startEdges[si].used) continue;
      startEdges[si].used = true;
      const originX = startKey % stride;
      const originY = (startKey / stride) | 0;
      const poly = [{ x: originX, y: originY }];
      let prevX = originX, prevY = originY;
      let cx = startEdges[si].x, cy = startEdges[si].y;
      let safety = (w + h) * 4 + edgeMap.size * 2;
      while ((cx !== originX || cy !== originY) && safety-- > 0) {
        poly.push({ x: cx, y: cy });
        const edges = edgeMap.get(cy * stride + cx);
        if (!edges) break;
        const inDx = cx - prevX, inDy = cy - prevY;
        let bestIdx = -1, bestRank = 999;
        for (let i = 0; i < edges.length; i++) {
          if (edges[i].used) continue;
          const rank = turnRank(inDx, inDy, edges[i].x - cx, edges[i].y - cy);
          if (rank < bestRank) { bestRank = rank; bestIdx = i; }
        }
        if (bestIdx === -1) break;
        edges[bestIdx].used = true;
        prevX = cx; prevY = cy;
        cx = edges[bestIdx].x; cy = edges[bestIdx].y;
      }
      if (poly.length >= 3) contours.push(simplifyContour(poly));
    }
  }
  return contours;
}

function simplifyContour(poly) {
  if (poly.length < 3) return poly;
  const out = [];
  const len = poly.length;
  for (let i = 0; i < len; i++) {
    const prev = poly[(i - 1 + len) % len];
    const curr = poly[i];
    const next = poly[(i + 1) % len];
    const collinearX = (prev.x === curr.x && curr.x === next.x);
    const collinearY = (prev.y === curr.y && curr.y === next.y);
    if (!collinearX && !collinearY) out.push(curr);
  }
  return out.length >= 3 ? out : poly;
}

function contoursToPath(contours) {
  const path = new Path2D();
  for (const poly of contours) {
    if (poly.length < 3) continue;
    path.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) path.lineTo(poly[i].x, poly[i].y);
    path.closePath();
  }
  return path;
}

/* ═══════════════════════════════════════════════════════
   GRADIENT TOOL — Multi-Stop Editable Linear Gradient
   ═══════════════════════════════════════════════════════ */

function getGradOpacity() { const v = parseInt(document.getElementById('gradOpacity').value); return (isNaN(v) ? 100 : v) / 100; }

function gradSnapshot() {
  const layer = getActiveLayer();
  if (!layer) return;
  gradBaseSnapshot = document.createElement('canvas');
  gradBaseSnapshot.width = canvasW; gradBaseSnapshot.height = canvasH;
  gradBaseSnapshot.getContext('2d').drawImage(layer.canvas, 0, 0);
}

function gradRestore() {
  if (!gradBaseSnapshot) return;
  const layer = getActiveLayer();
  if (!layer) return;
  layer.ctx.clearRect(0, 0, canvasW, canvasH);
  layer.ctx.drawImage(gradBaseSnapshot, 0, 0);
}

const _parseColorCanvas = document.createElement('canvas');
_parseColorCanvas.width = 1; _parseColorCanvas.height = 1;
const _parseColorCtx = _parseColorCanvas.getContext('2d');
let _parseCache1 = {hex:'', rgb:null}, _parseCache2 = {hex:'', rgb:null};
function parseColor(hex) {
  if (_parseCache1.hex === hex) return _parseCache1.rgb;
  if (_parseCache2.hex === hex) return _parseCache2.rgb;
  _parseColorCtx.clearRect(0, 0, 1, 1);
  _parseColorCtx.fillStyle = hex;
  _parseColorCtx.fillRect(0, 0, 1, 1);
  const d = _parseColorCtx.getImageData(0, 0, 1, 1).data;
  const rgb = {r:d[0], g:d[1], b:d[2]};
  _parseCache2 = _parseCache1;
  _parseCache1 = {hex, rgb};
  return rgb;
}

// sRGB <-> linear conversions for perceptual interpolation
function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToSrgb(c) { return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); }

function gradInterpolateColorAt(t) {
  if (gradStops.length < 2) return '#000000';
  if (t <= gradStops[0].t) return gradStops[0].color;
  if (t >= gradStops[gradStops.length - 1].t) return gradStops[gradStops.length - 1].color;
  for (let i = 0; i < gradStops.length - 1; i++) {
    const s0 = gradStops[i], s1 = gradStops[i + 1];
    if (t >= s0.t && t <= s1.t) {
      const segLen = s1.t - s0.t;
      if (segLen < 0.0001) return s0.color;
      const localT = (t - s0.t) / segLen;
      const mid = Math.max(0.001, Math.min(0.999, s0.mid || 0.5));
      const gamma = Math.log(0.5) / Math.log(mid);
      const blend = Math.pow(localT, gamma);
      const c0 = parseColor(s0.color), c1 = parseColor(s1.color);
      const lr0 = srgbToLinear(c0.r), lg0 = srgbToLinear(c0.g), lb0 = srgbToLinear(c0.b);
      const lr1 = srgbToLinear(c1.r), lg1 = srgbToLinear(c1.g), lb1 = srgbToLinear(c1.b);
      const r = linearToSrgb(lr0 * (1 - blend) + lr1 * blend);
      const g = linearToSrgb(lg0 * (1 - blend) + lg1 * blend);
      const b = linearToSrgb(lb0 * (1 - blend) + lb1 * blend);
      return `rgb(${r},${g},${b})`;
    }
  }
  return gradStops[gradStops.length - 1].color;
}

function renderGradientToLayer() {
  if (!gradP1 || !gradP2 || gradStops.length < 2) return;
  const layer = getActiveLayer();
  if (!layer) return;
  gradRestore();
  const opacity = getGradOpacity();
  const grad = layer.ctx.createLinearGradient(gradP1.x, gradP1.y, gradP2.x, gradP2.y);
  const subsPerSeg = 24;
  for (let i = 0; i < gradStops.length - 1; i++) {
    const s0 = gradStops[i], s1 = gradStops[i + 1];
    const c0 = parseColor(s0.color), c1 = parseColor(s1.color);
    const lr0 = srgbToLinear(c0.r), lg0 = srgbToLinear(c0.g), lb0 = srgbToLinear(c0.b);
    const lr1 = srgbToLinear(c1.r), lg1 = srgbToLinear(c1.g), lb1 = srgbToLinear(c1.b);
    const mid = Math.max(0.001, Math.min(0.999, s0.mid || 0.5));
    const gamma = Math.log(0.5) / Math.log(mid);
    for (let j = 0; j <= subsPerSeg; j++) {
      if (j === 0 && i > 0) continue;
      const localT = j / subsPerSeg;
      const blend = Math.pow(localT, gamma);
      const r = linearToSrgb(lr0 * (1 - blend) + lr1 * blend);
      const g = linearToSrgb(lg0 * (1 - blend) + lg1 * blend);
      const b = linearToSrgb(lb0 * (1 - blend) + lb1 * blend);
      const globalT = s0.t + (s1.t - s0.t) * localT;
      grad.addColorStop(Math.max(0, Math.min(1, globalT)), `rgb(${r},${g},${b})`);
    }
  }
  layer.ctx.save();
  layer.ctx.globalAlpha = opacity;
  if (selectionPath) layer.ctx.clip(selectionPath, selectionFillRule);
  layer.ctx.fillStyle = grad;
  layer.ctx.fillRect(0, 0, canvasW, canvasH);
  layer.ctx.restore();
  compositeAll();
}

function commitGradient() {
  if (!gradActive) return;
  // Flatten the entire gradient editing session into a single history entry.
  // All intermediate edits (drag endpoint, add stop, change color, etc.) are
  // deliberately NOT recorded — only this final commit. Pre-session state is
  // preserved in-memory via gradBaseSnapshot for cancel, not in history.
  gradActive = false; gradP1 = null; gradP2 = null;
  gradStops = []; gradDragging = null; gradBaseSnapshot = null;
  gradDragStartPos = null; gradStopAboutToDelete = false;
  gradColorPickerMode = false; gradColorTarget = null;
  hideGradStopCtx();
  drawOverlay();
  pushUndo('Gradient');
}

function gradPerpDist(px, py) {
  if (!gradP1 || !gradP2) return 0;
  const dx = gradP2.x - gradP1.x, dy = gradP2.y - gradP1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return Math.hypot(px - gradP1.x, py - gradP1.y);
  return Math.abs((py - gradP1.y) * dx - (px - gradP1.x) * dy) / len;
}

function gradProjectT(px, py) {
  const dx = gradP2.x - gradP1.x, dy = gradP2.y - gradP1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return 0;
  return Math.max(0, Math.min(1, ((px - gradP1.x) * dx + (py - gradP1.y) * dy) / len2));
}

function gradHitTest(px, py) {
  if (!gradP1 || !gradP2 || gradStops.length < 2) return null;
  const threshold = 12 / zoom;
  for (let i = 0; i < gradStops.length; i++) {
    const s = gradStops[i];
    const sx = gradP1.x + (gradP2.x - gradP1.x) * s.t;
    const sy = gradP1.y + (gradP2.y - gradP1.y) * s.t;
    if (Math.hypot(px - sx, py - sy) <= threshold) return {type: 'stop', index: i};
  }
  for (let i = 0; i < gradStops.length - 1; i++) {
    const s0 = gradStops[i], s1 = gradStops[i + 1];
    const midT = s0.t + (s1.t - s0.t) * (s0.mid || 0.5);
    const mx = gradP1.x + (gradP2.x - gradP1.x) * midT;
    const my = gradP1.y + (gradP2.y - gradP1.y) * midT;
    if (Math.hypot(px - mx, py - my) <= threshold) return {type: 'mid', index: i};
  }
  const perpD = gradPerpDist(px, py);
  if (perpD <= threshold) {
    const t = gradProjectT(px, py);
    if (t > 0.001 && t < 0.999) return {type: 'line', t: t};
  }
  return null;
}

let gradHoverElement = null;

function gradStopPos(i) {
  const s = gradStops[i];
  return {x: gradP1.x + (gradP2.x - gradP1.x) * s.t, y: gradP1.y + (gradP2.y - gradP1.y) * s.t};
}

// Right-click context menu for gradient stop deletion
function showGradStopCtx(stopIndex, screenX, screenY) {
  const menu = document.getElementById('gradStopCtx');
  if (!menu) return;
  menu.dataset.stopIndex = stopIndex;
  menu.style.display = 'flex';
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    let x = screenX - mr.width / 2, y = screenY - mr.height - 10;
    if (y < 4) y = screenY + 10;
    if (x < 4) x = 4;
    if (x + mr.width > window.innerWidth - 4) x = window.innerWidth - mr.width - 4;
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    menu.classList.add('active');
  });
}

function hideGradStopCtx() {
  const menu = document.getElementById('gradStopCtx');
  if (!menu || !menu.classList.contains('active')) return;
  menu.classList.remove('active');
  setTimeout(() => { if (!menu.classList.contains('active')) menu.style.display = 'none'; }, 150);
}

function executeGradStopDelete() {
  const menu = document.getElementById('gradStopCtx');
  if (!menu) return;
  const idx = parseInt(menu.dataset.stopIndex);
  if (isNaN(idx) || idx <= 0 || idx >= gradStops.length - 1) { hideGradStopCtx(); return; }
  // Mid-gradient edit — not a history entry; flattened into the eventual commit.
  gradStops.splice(idx, 1);
  renderGradientToLayer(); drawOverlay();
  hideGradStopCtx();
}

/* ═══════════════════════════════════════════════════════
   SELECTION SYSTEM
   ═══════════════════════════════════════════════════════ */

let isDrawingSelection = false;
let drawingPreviewPath = null;

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

function getTransformHandle(px, py) {
  if (!transformSelActive) return null;
  const b = getSelectionBounds(); if (!b || b.w < 1) return null;
  const {x,y,w,h} = b; const t = 8 / zoom;
  const handles = [{n:'nw',hx:x,hy:y},{n:'n',hx:x+w/2,hy:y},{n:'ne',hx:x+w,hy:y},{n:'w',hx:x,hy:y+h/2},{n:'e',hx:x+w,hy:y+h/2},{n:'sw',hx:x,hy:y+h},{n:'s',hx:x+w/2,hy:y+h},{n:'se',hx:x+w,hy:y+h}];
  for (const h of handles) { if (Math.abs(px-h.hx)<=t && Math.abs(py-h.hy)<=t) return h.n; }
  if (px>=x && px<=x+w && py>=y && py<=y+h) return 'move';
  return null;
}

function applyTransformDelta(handle, dx, dy) {
  if (!selection) return;
  // `b` is the pre-transform bounds. We read it once and reuse it below for the
  // scale-origin math — the points/contours have not been mutated yet, so a
  // second getSelectionBounds() call would return the same values.
  const b = getSelectionBounds(); if (!b) return;
  let {x,y,w,h} = b;
  if (handle==='move'){x+=dx;y+=dy;}
  else if(handle==='nw'){x+=dx;y+=dy;w-=dx;h-=dy;} else if(handle==='n'){y+=dy;h-=dy;} else if(handle==='ne'){w+=dx;y+=dy;h-=dy;}
  else if(handle==='w'){x+=dx;w-=dx;} else if(handle==='e'){w+=dx;} else if(handle==='sw'){x+=dx;w-=dx;h+=dy;}
  else if(handle==='s'){h+=dy;} else if(handle==='se'){w+=dx;h+=dy;}
  if(w<1){x+=w;w=Math.abs(w)||1;} if(h<1){y+=h;h=Math.abs(h)||1;}
  if (selection.type==='lasso' && selection.points) {
    if(b.w>0 && b.h>0) { const sx=w/b.w, sy=h/b.h, ox=x-b.x*sx, oy=y-b.y*sy; selection.points = selection.points.map(p=>({x:p.x*sx+ox, y:p.y*sy+oy})); }
  } else if ((selection.type==='wand' || selection.type==='composite') && selection.contours) {
    if(b.w>0 && b.h>0) { const sx=w/b.w, sy=h/b.h, ox=x-b.x*sx, oy=y-b.y*sy; selection.contours = selection.contours.map(poly => poly.map(p=>({x:p.x*sx+ox, y:p.y*sy+oy}))); }
  } else { selection.x=x; selection.y=y; selection.w=w; selection.h=h; }
  buildSelectionPath(); drawOverlay();
}

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
/**
 * Move-tool "Deselect" action — commits any active pixel transform,
 * clears any active selection, and hides all transform overlays.

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

let gradColorTarget = null;
let gradColorPickerMode = false;

function finishPolygonalLasso() {
  if (polyPoints.length < 3) { polyPoints=[]; drawOverlay(); return; }
  const p = new Path2D();
  p.moveTo(Math.round(polyPoints[0].x), Math.round(polyPoints[0].y));
  for (let i=1;i<polyPoints.length;i++) p.lineTo(Math.round(polyPoints[i].x), Math.round(polyPoints[i].y));
  p.closePath();
  commitNewSelection(p, {type:'lasso', points:polyPoints.map(pt=>({x:Math.round(pt.x),y:Math.round(pt.y)}))});
  polyPoints = []; isDrawingSelection = false; drawingPreviewPath = null; drawOverlay();
}

/* ═══════════════════════════════════════════════════════
   MAGNETIC LASSO — Intelligent Scissors Engine
   ═══════════════════════════════════════════════════════ */

function getMagWidth()     { return parseInt(document.getElementById('magWidthNum').value) || 10; }
function getMagContrast()  { return parseInt(document.getElementById('magContrastNum').value) || 50; }
function getMagFrequency() { return parseInt(document.getElementById('magFrequencyNum').value) || 57; }

/**
 * Compute Sobel gradient magnitude and direction on a local region of the
 * active layer.  Stores results in magEdgeMap (magnitude 0-1), magEdgeGx,
 * magEdgeGy, and records the region bounding box in magEdgeRegion.
 */
function computeEdgeMap(rx, ry, rw, rh) {
  const layer = getActiveLayer();
  if (!layer) return;
  // Clamp to canvas
  if (rx < 0) { rw += rx; rx = 0; }
  if (ry < 0) { rh += ry; ry = 0; }
  if (rx + rw > canvasW) rw = canvasW - rx;
  if (ry + rh > canvasH) rh = canvasH - ry;
  if (rw < 3 || rh < 3) return;

  const imgData = layer.ctx.getImageData(rx, ry, rw, rh);
  const rgba = imgData.data;
  const n = rw * rh;

  // Luminance (Rec.709)
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    lum[i] = 0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2];
  }

  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const mag = new Float32Array(n);
  let maxMag = 0;

  // Sobel 3x3
  for (let y = 1; y < rh - 1; y++) {
    for (let x = 1; x < rw - 1; x++) {
      const tl = lum[(y - 1) * rw + x - 1], tc = lum[(y - 1) * rw + x], tr = lum[(y - 1) * rw + x + 1];
      const ml = lum[y * rw + x - 1],                                     mr = lum[y * rw + x + 1];
      const bl = lum[(y + 1) * rw + x - 1], bc = lum[(y + 1) * rw + x], br = lum[(y + 1) * rw + x + 1];
      const sx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const sy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const idx = y * rw + x;
      gx[idx] = sx;
      gy[idx] = sy;
      const m = Math.sqrt(sx * sx + sy * sy);
      mag[idx] = m;
      if (m > maxMag) maxMag = m;
    }
  }

  // Normalize to [0, 1]
  if (maxMag > 0) {
    const inv = 1 / maxMag;
    for (let i = 0; i < n; i++) mag[i] *= inv;
  }

  magEdgeMap = mag;
  magEdgeGx = gx;
  magEdgeGy = gy;
  magEdgeRegion = { x: rx, y: ry, w: rw, h: rh };
}

/**
 * Ensure the cached edge map covers the bounding box between anchor and
 * cursor, plus the Width margin. Recomputes if necessary.
 */
function ensureEdgeMapCoverage(ax, ay, cx, cy, width) {
  const margin = width + 4;
  const needX = Math.min(ax, cx) - margin;
  const needY = Math.min(ay, cy) - margin;
  const needR = Math.max(ax, cx) + margin;
  const needB = Math.max(ay, cy) + margin;

  if (magEdgeRegion &&
      magEdgeRegion.x <= needX && magEdgeRegion.y <= needY &&
      magEdgeRegion.x + magEdgeRegion.w >= needR &&
      magEdgeRegion.y + magEdgeRegion.h >= needB) {
    return; // Cached region is sufficient
  }

  // Expand to cover all anchors + generous padding
  let ex = needX, ey = needY, er = needR, eb = needB;
  if (magEdgeRegion) {
    ex = Math.min(ex, magEdgeRegion.x);
    ey = Math.min(ey, magEdgeRegion.y);
    er = Math.max(er, magEdgeRegion.x + magEdgeRegion.w);
    eb = Math.max(eb, magEdgeRegion.y + magEdgeRegion.h);
  }
  // Add extra padding so small cursor moves don't trigger recomputation
  const pad = width * 3;
  computeEdgeMap(
    Math.floor(ex - pad), Math.floor(ey - pad),
    Math.ceil(er - ex + pad * 2), Math.ceil(eb - ey + pad * 2)
  );
}

/**
 * Find the pixel with highest gradient magnitude within searchWidth of pos.
 * Returns {x, y} in canvas coordinates.
 */
function snapToNearestEdge(px, py, searchWidth) {
  if (!magEdgeMap || !magEdgeRegion) return { x: Math.round(px), y: Math.round(py) };
  const r = magEdgeRegion;
  const sw = Math.max(2, searchWidth);
  let bestX = Math.round(px), bestY = Math.round(py), bestMag = -1;

  const x0 = Math.max(r.x + 1, Math.round(px) - sw);
  const y0 = Math.max(r.y + 1, Math.round(py) - sw);
  const x1 = Math.min(r.x + r.w - 2, Math.round(px) + sw);
  const y1 = Math.min(r.y + r.h - 2, Math.round(py) + sw);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = (y - r.y) * r.w + (x - r.x);
      const m = magEdgeMap[idx];
      if (m > bestMag) { bestMag = m; bestX = x; bestY = y; }
    }
  }
  return { x: bestX, y: bestY };
}

/**
 * Binary min-heap on typed arrays — zero GC allocation during push/pop.
 */
function MagHeap(capacity) {
  this.costs = new Float64Array(capacity);
  this.nodes = new Int32Array(capacity);
  this.size = 0;
}
MagHeap.prototype.push = function(node, cost) {
  let i = this.size++;
  this.costs[i] = cost;
  this.nodes[i] = node;
  // Sift up
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (this.costs[p] <= cost) break;
    this.costs[i] = this.costs[p]; this.nodes[i] = this.nodes[p];
    this.costs[p] = cost; this.nodes[p] = node;
    i = p;
  }
};
MagHeap.prototype.pop = function() {
  const cost = this.costs[0], node = this.nodes[0];
  this.size--;
  if (this.size > 0) {
    this.costs[0] = this.costs[this.size];
    this.nodes[0] = this.nodes[this.size];
    // Sift down
    let i = 0;
    while (true) {
      let s = i, l = 2 * i + 1, r = 2 * i + 2;
      if (l < this.size && this.costs[l] < this.costs[s]) s = l;
      if (r < this.size && this.costs[r] < this.costs[s]) s = r;
      if (s === i) break;
      const tc = this.costs[i]; const tn = this.nodes[i];
      this.costs[i] = this.costs[s]; this.nodes[i] = this.nodes[s];
      this.costs[s] = tc; this.nodes[s] = tn;
      i = s;
    }
  }
  return { node, cost };
};

// 8-connected neighbor offsets: dx, dy
const _magDirs = [-1,-1, 0,-1, 1,-1, -1,0, 1,0, -1,1, 0,1, 1,1];
const _SQRT2 = 1.4142135623730951;

/**
 * Compute the minimum-cost path from anchor to cursor using Dijkstra on
 * the Sobel gradient map (Intelligent Scissors / Livewire).
 * Returns an array of {x, y} points in canvas coordinates, or null.
 */
function computeLiveWire(ax, ay, cx, cy, searchWidth, contrast) {
  if (!magEdgeMap || !magEdgeRegion) return null;
  const r = magEdgeRegion;

  // Bounding box for Dijkstra search
  const margin = searchWidth + 2;
  const bx = Math.max(r.x + 1, Math.min(ax, cx) - margin);
  const by = Math.max(r.y + 1, Math.min(ay, cy) - margin);
  const bx2 = Math.min(r.x + r.w - 2, Math.max(ax, cx) + margin);
  const by2 = Math.min(r.y + r.h - 2, Math.max(ay, cy) + margin);
  const bw = bx2 - bx + 1;
  const bh = by2 - by + 1;
  if (bw < 2 || bh < 2) return null;
  const N = bw * bh;

  // Ensure source and dest are within bounds
  const sax = Math.max(bx, Math.min(bx2, ax));
  const say = Math.max(by, Math.min(by2, ay));
  const scx = Math.max(bx, Math.min(bx2, cx));
  const scy = Math.max(by, Math.min(by2, cy));

  const srcIdx = (say - by) * bw + (sax - bx);
  const dstIdx = (scy - by) * bw + (scx - bx);
  if (srcIdx === dstIdx) return [{ x: ax, y: ay }];

  // Allocate or reuse Dijkstra buffers
  if (N > _magBufCapacity) {
    const cap = Math.max(N, 65536);
    _magDist = new Float32Array(cap);
    _magPrev = new Int32Array(cap);
    _magVisited = new Uint8Array(cap);
    _magHeapCosts = new Float64Array(cap * 2);
    _magHeapNodes = new Int32Array(cap * 2);
    _magBufCapacity = cap;
  }
  const dist = _magDist;
  const prev = _magPrev;
  const visited = _magVisited;
  // Reset only the active region
  for (let i = 0; i < N; i++) { dist[i] = 1e30; prev[i] = -1; visited[i] = 0; }

  // Contrast threshold
  const threshold = (100 - contrast) / 100;

  // Heap
  const heap = new MagHeap(Math.min(N * 2, 262144));
  dist[srcIdx] = 0;
  heap.push(srcIdx, 0);

  while (heap.size > 0) {
    const { node, cost } = heap.pop();
    if (visited[node]) continue;
    visited[node] = 1;
    if (node === dstIdx) break;

    const nx = node % bw, ny = (node / bw) | 0;
    const canvasX = nx + bx, canvasY = ny + by;

    for (let d = 0; d < 16; d += 2) {
      const nnx = nx + _magDirs[d];
      const nny = ny + _magDirs[d + 1];
      if (nnx < 0 || nny < 0 || nnx >= bw || nny >= bh) continue;
      const nIdx = nny * bw + nnx;
      if (visited[nIdx]) continue;

      const ncx = nnx + bx, ncy = nny + by;
      const eIdx = (ncy - r.y) * r.w + (ncx - r.x);

      // Edge cost: low on strong edges
      let rawMag = magEdgeMap[eIdx];
      // Apply contrast threshold
      rawMag = rawMag > threshold ? (rawMag - threshold) / (1 - threshold + 0.001) : 0;
      const edgeCost = 1 - rawMag;

      // Direction cost: penalize crossing edges vs following them
      const egx = magEdgeGx[eIdx], egy = magEdgeGy[eIdx];
      let dirCost = 0;
      if (egx !== 0 || egy !== 0) {
        // Edge tangent direction (perpendicular to gradient)
        const edgeAngle = Math.atan2(-egx, egy); // tangent = rotate gradient 90 degrees
        const linkAngle = Math.atan2(_magDirs[d + 1], _magDirs[d]);
        let angleDiff = Math.abs(linkAngle - edgeAngle);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        if (angleDiff > Math.PI / 2) angleDiff = Math.PI - angleDiff;
        dirCost = angleDiff / (Math.PI / 2); // 0..1
      }

      // Weighted cost
      const isDiag = (_magDirs[d] !== 0 && _magDirs[d + 1] !== 0);
      const stepCost = (0.43 * edgeCost + 0.43 * dirCost + 0.14) * (isDiag ? _SQRT2 : 1);

      const newDist = cost + stepCost;
      if (newDist < dist[nIdx]) {
        dist[nIdx] = newDist;
        prev[nIdx] = node;
        heap.push(nIdx, newDist);
      }
    }
  }

  // Backtrace
  if (!visited[dstIdx]) return null;
  const pts = [];
  let cur = dstIdx;
  while (cur !== -1) {
    const lx = cur % bw, ly = (cur / bw) | 0;
    pts.push({ x: lx + bx, y: ly + by });
    cur = prev[cur];
  }
  pts.reverse();

  // Simplify path — remove collinear points (Ramer-Douglas-Peucker would be
  // overkill; just drop mid-points on perfectly straight 8-dir segments)
  if (pts.length > 3) {
    const simplified = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1], c = pts[i], n = pts[i + 1];
      const dx1 = c.x - p.x, dy1 = c.y - p.y;
      const dx2 = n.x - c.x, dy2 = n.y - c.y;
      if (dx1 !== dx2 || dy1 !== dy2) simplified.push(c);
    }
    simplified.push(pts[pts.length - 1]);
    return simplified;
  }
  return pts;
}

/**
 * Check if auto-anchor should be placed based on frequency setting.
 */
function checkAutoAnchor(px, py, frequency, searchWidth) {
  if (frequency <= 0 || magAnchors.length === 0) return;
  const last = magAnchors[magAnchors.length - 1];
  const dist = Math.hypot(px - last.x, py - last.y);
  // Distance threshold: higher frequency → shorter interval
  const threshold = 60 - (52 * frequency / 100); // 60px at freq=0, 8px at freq=100
  if (dist < threshold) return;
  // Edge strength check: at high frequency, accept weaker edges
  const minEdge = 0.8 - (0.65 * frequency / 100); // 0.8 at freq=0, 0.15 at freq=100
  if (magEdgeMap && magEdgeRegion) {
    const rx = Math.round(px) - magEdgeRegion.x;
    const ry = Math.round(py) - magEdgeRegion.y;
    if (rx >= 0 && ry >= 0 && rx < magEdgeRegion.w && ry < magEdgeRegion.h) {
      const edgeStrength = magEdgeMap[ry * magEdgeRegion.w + rx];
      if (edgeStrength < minEdge) return;
    }
  }
  // Place auto-anchor: snap to nearest edge and commit current live wire
  const snapped = snapToNearestEdge(px, py, searchWidth);
  if (magLivePath && magLivePath.length > 1) {
    magSegments.push(magLivePath);
  }
  magAnchors.push(snapped);
  magLivePath = null;
}

/**
 * Assemble all magnetic lasso segments into a single point array.
 */
function magAssemblePoints() {
  const pts = [];
  const seen = new Set();
  function addPt(x, y) {
    const key = (x << 16) | (y & 0xFFFF);
    if (seen.has(key) && pts.length > 0) return; // skip consecutive duplicates
    seen.clear(); seen.add(key);
    pts.push({ x, y });
  }
  for (const seg of magSegments) {
    if (Array.isArray(seg)) {
      for (const p of seg) addPt(Math.round(p.x), Math.round(p.y));
    }
  }
  return pts;
}

/**
 * Build overlay path from all committed segments + live wire for display.
 */
function magBuildPreviewPath() {
  const p = new Path2D();
  const pts = magAssemblePoints();
  if (pts.length > 0) {
    p.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
  }
  // Append live wire
  if (magLivePath && magLivePath.length > 0) {
    if (pts.length === 0) {
      p.moveTo(Math.round(magLivePath[0].x), Math.round(magLivePath[0].y));
    }
    for (let i = (pts.length === 0 ? 1 : 0); i < magLivePath.length; i++) {
      p.lineTo(Math.round(magLivePath[i].x), Math.round(magLivePath[i].y));
    }
  }
  return p;
}

/**
 * Finish the magnetic lasso selection.
 * @param {boolean} traceToStart - If true, trace edges back to start.
 *                                 If false, close with straight line.
 */
function finishMagneticLasso(traceToStart) {
  if (magAnchors.length < 2 && magSegments.length === 0) { cancelMagneticLasso(); return; }
  // Commit live wire as final segment
  if (magLivePath && magLivePath.length > 1) {
    magSegments.push(magLivePath);
    magLivePath = null;
  }
  // Closing segment
  if (traceToStart && magAnchors.length >= 2) {
    const last = magAnchors[magAnchors.length - 1];
    const first = magAnchors[0];
    const width = getMagWidth();
    const contrast = getMagContrast();
    ensureEdgeMapCoverage(last.x, last.y, first.x, first.y, width);
    const closingPath = computeLiveWire(
      Math.round(last.x), Math.round(last.y),
      Math.round(first.x), Math.round(first.y),
      width, contrast
    );
    if (closingPath && closingPath.length > 1) {
      magSegments.push(closingPath);
    }
  }
  // Build final path
  const allPts = magAssemblePoints();
  if (allPts.length < 3) { cancelMagneticLasso(); return; }

  const p = new Path2D();
  p.moveTo(allPts[0].x, allPts[0].y);
  for (let i = 1; i < allPts.length; i++) p.lineTo(allPts[i].x, allPts[i].y);
  p.closePath();
  commitNewSelection(p, { type: 'lasso', points: allPts });
  resetMagneticState();
  drawOverlay();
}

/**
 * Cancel the magnetic lasso without creating a selection.
 */
function cancelMagneticLasso() {
  resetMagneticState();
  drawOverlay();
}

/**
 * Reset all magnetic lasso state variables.
 */
function resetMagneticState() {
  magAnchors = [];
  magSegments = [];
  magLivePath = null;
  magEdgeMap = null;
  magEdgeGx = null;
  magEdgeGy = null;
  magEdgeRegion = null;
  magActive = false;
  magFreehandMode = false;
  magFreehandPoints = [];
  isDrawingSelection = false;
  drawingPreviewPath = null;
}

function constrainSelectBounds(startX, startY, endX, endY, shiftKey, altKey) {
  let dx = endX - startX, dy = endY - startY;
  if (shiftKey) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx) * side;
    dy = Math.sign(dy) * side;
  }
  let sx, sy, sw, sh;
  if (altKey) {
    sw = Math.round(Math.abs(dx) * 2);
    sh = Math.round(Math.abs(dy) * 2);
    sx = Math.round(startX - Math.abs(dx));
    sy = Math.round(startY - Math.abs(dy));
  } else {
    sx = Math.round(Math.min(startX, startX + dx));
    sy = Math.round(Math.min(startY, startY + dy));
    sw = Math.round(Math.abs(dx));
    sh = Math.round(Math.abs(dy));
  }
  return { sx, sy, sw, sh };
}

function makeShapePath(shape, sx, sy, sw, sh) {
  const p = new Path2D();
  if (shape==='rect') p.rect(sx, sy, sw, sh);
  else if (shape==='ellipse' && sw>0 && sh>0) p.ellipse(sx+sw/2, sy+sh/2, sw/2, sh/2, 0, 0, Math.PI*2);
  return p;
}

function onMouseDown(e) {
  // Any new pointer gesture flushes pending nudge undo — the in-flight
  // burst is committed as its own history entry before the new gesture begins.
  if (_nudgePending) flushNudgeUndo();
  const pos = screenToCanvas(e.clientX, e.clientY); const px=pos.x, py=pos.y;
  isDrawing = true; drawStart = {x:px, y:py}; lastDraw = {x:px, y:py};
  if (e.button===0 && currentTool==='shape') {
    SnapEngine.beginSession({});
    const _sp = SnapEngine.snapPoint({x:px, y:py}, {modifiers:e});
    drawStart = {x:_sp.x, y:_sp.y}; lastDraw = {x:_sp.x, y:_sp.y};
  }
  if (gradActive && currentTool==='gradient') { if (px < 0 || py < 0 || px >= canvasW || py >= canvasH) { commitGradient(); isDrawing = false; return; } }
  // Pan shortcuts take precedence over any tool (including ruler) so the user can always
  // middle-click, space-drag, or alt-drag to pan.
  if (e.button===1 || (e.button===0 && currentTool==='pan') || (e.button===0 && e.altKey && !((pxTransformActive && currentTool==='move') || (transformSelActive && currentTool==='movesel') || (currentTool==='lasso' && lassoMode==='magnetic' && magActive))) || (e.button===0 && spaceDown)) {
    isFitMode=false; isPanning=true; isDrawing=false; panStart={x:e.clientX-panX, y:e.clientY-panY}; workspace.style.cursor='grabbing'; return;
  }
  if (e.button===0 && currentTool==='ruler') {
    const hit = rulerHitTest(e.clientX, e.clientY);
    if (hit && hit.type === 'handle') {
      SnapEngine.beginSession({});
      rulerDrag = { mode: 'handle', which: hit.which };
      workspace.style.cursor = 'grabbing';
    } else if (hit && hit.type === 'line') {
      SnapEngine.beginSession({});
      rulerDrag = { mode: 'move', grabOffset: { dx: px - rulerState.x1, dy: py - rulerState.y1 } };
      workspace.style.cursor = 'all-scroll';
    } else {
      // Click-off: clear existing, start fresh
      if (rulerState.active) clearRuler();
      SnapEngine.beginSession({});
      const _p = snapRulerPoint({ x: px, y: py }, e, null);
      rulerState.active = true;
      rulerState.x1 = _p.x; rulerState.y1 = _p.y;
      rulerState.x2 = _p.x; rulerState.y2 = _p.y;
      rulerDrag = { mode: 'draw' };
      workspace.style.cursor = 'crosshair';
    }
    drawUIOverlay();
    updateRulerOptionsBar();
    return;
  }
  if (e.button===0 && currentTool==='move') {
    // Guide hit-test — allow selecting/dragging guides with move tool.
    const _canCheckGuides = guidesVisible && guides.length > 0;
    if (_canCheckGuides) {
      const hitG = hitTestGuide(e.clientX, e.clientY);
      if (hitG) {
        selectedGuide = hitG;
        draggingGuide = { guide: hitG, isNew: false };
        isDrawing = false;
        workspace.style.cursor = hitG.axis === 'v' ? 'ew-resize' : 'ns-resize';
        SnapEngine.beginSession({ excludeGuides: true, excludeGuideId: hitG.id });
        drawGuides();
        drawOverlay();
        updatePropertiesPanel();
        return;
      }
    }
    if (selectedGuide) { selectedGuide = null; drawGuides(); drawOverlay(); updatePropertiesPanel(); }

    // ── Case 1: a pixel transform is already live ──
    if (pxTransformActive && pxTransformData) {
      const hit = hitTestPxTransform(px, py);
      if (hit) {
        // Click landed on a handle or inside the box → start a drag.
        pxTransformHandle = hit;
        pxTransformStartMouse = {x: px, y: py};
        pxTransformOrigBounds = { ...pxTransformData.curBounds };
        _moveTransformJustInitiated = false;
        _moveDragAltDuplicate = !!(e.altKey && hit === 'move');
        if (hit === 'rotate') {
          // Rotation drag: pivot on the box center, remember the click's
          // initial angle so subsequent mousemoves apply the delta.
          const _b = pxTransformData.curBounds;
          _rotateCenter = { x: _b.x + _b.w / 2, y: _b.y + _b.h / 2 };
          _rotateStartAngle = Math.atan2(py - _rotateCenter.y, px - _rotateCenter.x);
          pxTransformData.liveRotation = 0;
          isDrawing = false;
          return;
        }
        const _excl = new Set(); const _al = getActiveLayer(); if (_al) _excl.add(_al.id);
        SnapEngine.beginSession({ excludeLayerIds: _excl, excludeSelection: true });
        isDrawing = false;
        return;
      }
      // Click landed outside the transform box → commit it (suggestion 9).
      // Absorb the click: the user's gesture was "finish the transform",
      // not "start a new one on whatever is beneath the click".
      commitPixelTransform();
      updateMoveDeselectButtonState();
      isDrawing = false;
      return;
    }

    // ── Case 2: a floating selection is live ──
    if (floatingActive && floatingCanvas) {
      isMovingPixels = true; isDrawing = false;
      _floatingDragBaseOffset = { x: floatingOffset.x, y: floatingOffset.y };
      _floatingDragStart = { x: px, y: py };
      const _excl = new Set(); const _al = getActiveLayer(); if (_al) _excl.add(_al.id);
      SnapEngine.beginSession({ excludeLayerIds: _excl, excludeSelection: true });
      return;
    }

    // ── Case 3: nothing active — decide whether to initiate a new transform ──
    const pick = pickMoveTarget(px, py);
    if (!pick) {
      // Empty click: nothing to move. Respect Q1b / Q5a.
      isDrawing = false;
      return;
    }

    // Auto-Select Layer may have targeted a different layer — switch.
    if (pick.layerIndex !== activeLayerIndex) {
      activeLayerIndex = pick.layerIndex;
      selectedLayers = new Set([activeLayerIndex]);
      updateLayerPanel();
    }

    // Create the transform. initPixelTransform() handles both the
    // "selection present" and "bound all visible pixels" cases.
    initPixelTransform(true);
    if (!pxTransformActive || !pxTransformData) {
      isDrawing = false;
      return;
    }

    // Immediately enter a 'move' drag so the click-drag feels continuous.
    pxTransformHandle = 'move';
    pxTransformStartMouse = {x: px, y: py};
    pxTransformOrigBounds = { ...pxTransformData.curBounds };
    _moveTransformJustInitiated = true;
    _moveDragAltDuplicate = !!e.altKey;
    const _excl = new Set();
    const _al = getActiveLayer();
    if (_al) _excl.add(_al.id);
    SnapEngine.beginSession({ excludeLayerIds: _excl, excludeSelection: true });
    updateMoveDeselectButtonState();
    compositeAll();
    drawOverlay();
    isDrawing = false;
    return;
  }
  if (e.button===0 && currentTool==='zoom') {
    const r=workspace.getBoundingClientRect();
    if(e.shiftKey) zoomTo(zoom/1.4, e.clientX-r.left, e.clientY-r.top); else zoomTo(zoom*1.4, e.clientX-r.left, e.clientY-r.top); return;
  }
  const layer=getActiveLayer(); if(!layer||!layer.visible) return;
  if (transformSelActive && (currentTool==='select'||currentTool==='lasso'||currentTool==='movesel'||currentTool==='wand')) {
    const handle=getTransformHandle(px,py);
    if (handle) {
      transformHandleDrag=handle; transformOrigBounds=selection?JSON.parse(JSON.stringify(selection)):null; isDrawing=false;
      _transformDragMoved = false;
      SnapEngine.beginSession({ excludeSelection: true });
      return;
    }
  }
  if (currentTool==='movesel') { isDrawing=false; return; }
  if (currentTool==='select') {
    SnapEngine.beginSession({ excludeSelection: true });
    const _sp = SnapEngine.snapPoint({x:px, y:py}, {modifiers:e});
    drawStart = {x:_sp.x, y:_sp.y};
    isDrawingSelection = true; drawingPreviewPath = null;
    if (selectionMode==='new') { selection=null; selectionPath=null; }
    return;
  }
  if (currentTool==='lasso') {
    if (lassoMode==='free') { isDrawingSelection = true; drawingPreviewPath = null; if (selectionMode==='new') { selection=null; selectionPath=null; } lassoPoints = [{x:px, y:py}]; }
    else if (lassoMode==='poly') {
      if (polyPoints.length===0) { isDrawingSelection = true; if (selectionMode==='new') { selection=null; selectionPath=null; } }
      if (polyPoints.length>0) { const first=polyPoints[0]; if (Math.hypot(px-first.x, py-first.y) < 10/zoom && polyPoints.length>2) { finishPolygonalLasso(); isDrawing=false; return; } }
      let ppx = px, ppy = py;
      if (e.shiftKey && polyPoints.length > 0) {
        const anchor = polyPoints[polyPoints.length - 1];
        const c = applyRulerShiftConstraint(anchor.x, anchor.y, px, py);
        ppx = c.x; ppy = c.y;
      }
      polyPoints.push({x:ppx, y:ppy}); updatePolyPreviewPath(); isDrawing=false;
    }
    else if (lassoMode==='magnetic') {
      // Alt+click while active = start freehand override
      if (magActive && e.altKey) {
        magFreehandMode = true;
        magFreehandPoints = [{x:px, y:py}];
        isDrawing = true;
        return;
      }
      if (!magActive) {
        // First click: start magnetic lasso session
        magActive = true;
        isDrawingSelection = true;
        if (selectionMode==='new') { selection=null; selectionPath=null; }
        const width = getMagWidth();
        // Compute initial edge map
        computeEdgeMap(
          Math.floor(px - width * 4), Math.floor(py - width * 4),
          Math.ceil(width * 8), Math.ceil(width * 8)
        );
        const snapped = snapToNearestEdge(px, py, width);
        magAnchors = [snapped];
        magSegments = [];
        magLivePath = null;
        drawMagneticOverlay();
      } else {
        // Subsequent click: place anchor or close
        const first = magAnchors[0];
        if (magAnchors.length > 2 && Math.hypot(px - first.x, py - first.y) < 10/zoom) {
          // Close with edge trace to start
          finishMagneticLasso(true);
          isDrawing = false;
          return;
        }
        // Place manual anchor
        const width = getMagWidth();
        const snapped = snapToNearestEdge(px, py, width);
        if (magLivePath && magLivePath.length > 1) {
          magSegments.push(magLivePath);
        }
        magAnchors.push(snapped);
        magLivePath = null;
        drawMagneticOverlay();
      }
      isDrawing = false;
    }
    return;
  }
  if (currentTool==='wand') {
    const tolVal = parseInt(document.getElementById('wandTolerance').value); const tol = isNaN(tolVal) ? 32 : tolVal;
    const contiguous = document.getElementById('wandContiguous').checked;
    const result = magicWandSelect(px, py, tol, contiguous);
    if (result) { const wandPath = contoursToPath(result.contours); const b = result.bounds; commitNewSelection(wandPath, { type: 'wand', contours: result.contours, x: b.x, y: b.y, w: b.w, h: b.h }); }
    else if (selectionMode === 'new') { selection = null; selectionPath = null; }
    drawOverlay(); isDrawing = false; return;
  }
  if (['brush','pencil','eraser'].includes(currentTool)) {
    // Undo entry recorded on mouseUp after the stroke is committed to the layer.
    const size=getDrawSize(); const hardness=currentTool==='pencil'?1:getDrawHardness(); const smoothness=currentTool==='pencil'?0:getDrawSmoothness(); const color=currentTool==='eraser'?'#ffffff':fgColor;
    strokeBuffer=document.createElement('canvas'); strokeBuffer.width=canvasW; strokeBuffer.height=canvasH; strokeBufferCtx=strokeBuffer.getContext('2d');
    if(currentTool==='pencil') strokeBufferCtx.imageSmoothingEnabled=false;
    smoothInit(px,py); dabDistAccum = 0;
    if(currentTool==='pencil') stampPencilDab(strokeBufferCtx,px,py,size,color);
    else { renderBrushDab(strokeBufferCtx,px,py,size,hardness,color); dabDistAccum=0; }
    compositeAllWithStrokeBuffer();
  } else if (currentTool==='fill') {
    const tolVal = parseInt(document.getElementById('fillTolerance').value); const tol = isNaN(tolVal) ? 128 : tolVal;
    const opVal = parseInt(document.getElementById('fillOpacity').value); const opacity = (isNaN(opVal) ? 100 : opVal) / 100;
    if(selectionPath){layer.ctx.save();layer.ctx.clip(selectionPath,selectionFillRule);floodFill(layer.ctx,px,py,fgColor,tol,opacity);layer.ctx.restore();}
    else floodFill(layer.ctx,px,py,fgColor,tol,opacity);
    SnapEngine.invalidateLayer(layer); compositeAll();
    pushUndo('Fill');
  } else if (currentTool==='text') {
    const text=prompt('Enter text:'); if(text){const font=document.getElementById('textFont').value;const size=parseInt(document.getElementById('textSize').value)||24;layer.ctx.save();layer.ctx.globalAlpha=getToolOpacity();layer.ctx.font=`${size}px "${font}"`;layer.ctx.fillStyle=fgColor;layer.ctx.textBaseline='top';if(selectionPath)layer.ctx.clip(selectionPath,selectionFillRule);layer.ctx.fillText(text,px,py);layer.ctx.restore();SnapEngine.invalidateLayer(layer);compositeAll();pushUndo('Text');}
  } else if (currentTool==='gradient') {
    hideGradStopCtx();
    if (gradActive) {
      const hit = gradHitTest(px, py);
      if (hit) {
        if (hit.type === 'line') {
          // Mid-gradient edit — not a history entry; flattened into the eventual commit.
          const newColor = gradInterpolateColorAt(hit.t);
          const insertIdx = gradStops.findIndex(s => s.t > hit.t);
          const newStop = {t: hit.t, color: newColor, mid: 0.5};
          if (insertIdx > 0) gradStops[insertIdx - 1].mid = 0.5;
          gradStops.splice(insertIdx, 0, newStop);
          gradDragging = {type: 'stop', index: insertIdx};
          gradDragStartPos = {x: px, y: py}; gradStopAboutToDelete = false;
          workspace.style.cursor = 'grabbing';
          renderGradientToLayer(); drawOverlay(); isDrawing = false; return;
        }
        gradDragging = hit;
        gradDragStartPos = (hit.type === 'stop') ? {x: px, y: py} : null;
        gradStopAboutToDelete = false;
        // Mid-gradient edit — not a history entry; flattened into the eventual commit.
        if (hit.type === 'stop' && (hit.index === 0 || hit.index === gradStops.length - 1)) SnapEngine.beginSession({});
        workspace.style.cursor = 'grabbing'; isDrawing = false; return;
      }
      isDrawing = false; return;
    }
    // Start of a new gradient editing session — entry recorded on commit only.
    SnapEngine.beginSession({});
    const _spg = SnapEngine.snapPoint({x:px, y:py}, {modifiers:e});
    gradStops = [{t: 0, color: fgColor, mid: 0.5}, {t: 1, color: bgColor}];
    gradP1 = {x: _spg.x, y: _spg.y}; gradP2 = {x: _spg.x, y: _spg.y}; gradDragging = 'creating'; gradSnapshot();
  }
  updateStatus(e);
}

function onMouseMove(e) {
  const pos=screenToCanvas(e.clientX,e.clientY); const px=pos.x, py=pos.y;
  statusPosEl.textContent=`X: ${Math.round(px)}  Y: ${Math.round(py)}`;
  const wsRect = _getWsRect();
  rulerMouseX = e.clientX - wsRect.left;
  rulerMouseY = e.clientY - wsRect.top;
  if (rulersVisible) scheduleRulerDraw();
  if (currentTool === 'ruler' && !isPanning) {
    if (rulerDrag) {
      if (rulerDrag.mode === 'draw' || rulerDrag.mode === 'handle') {
        const which = rulerDrag.mode === 'draw' ? 2 : rulerDrag.which;
        const anchor = which === 2
          ? { x: rulerState.x1, y: rulerState.y1 }
          : { x: rulerState.x2, y: rulerState.y2 };
        const _p = snapRulerPoint({ x: px, y: py }, e, anchor);
        if (which === 2) { rulerState.x2 = _p.x; rulerState.y2 = _p.y; }
        else             { rulerState.x1 = _p.x; rulerState.y1 = _p.y; }
        workspace.style.cursor = rulerDrag.mode === 'draw' ? 'crosshair' : 'grabbing';
      } else if (rulerDrag.mode === 'move') {
        // Raw new P1 from grab offset, snap it, then translate both endpoints by the same delta
        const rawX = px - rulerDrag.grabOffset.dx;
        const rawY = py - rulerDrag.grabOffset.dy;
        const snapped = SnapEngine.snapPoint({ x: rawX, y: rawY }, { modifiers: e });
        const newX1 = Math.round(snapped.x);
        const newY1 = Math.round(snapped.y);
        const dX = newX1 - rulerState.x1;
        const dY = newY1 - rulerState.y1;
        rulerState.x1 += dX; rulerState.y1 += dY;
        rulerState.x2 += dX; rulerState.y2 += dY;
        workspace.style.cursor = 'all-scroll';
      }
      drawUIOverlay();
      updateRulerOptionsBar();
      return;
    } else {
      const hit = rulerHitTest(e.clientX, e.clientY);
      workspace.style.cursor = getRulerCursor(hit, false);
      return;
    }
  }
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
  // Guide hover cursor when using move tool
  let _guideHovered = false;
  if (currentTool === 'move' && guidesVisible && !isPanning && !isMovingPixels && !pxTransformHandle) {
    const hg = hitTestGuide(e.clientX, e.clientY);
    if (hg) { workspace.style.cursor = hg.axis === 'v' ? 'ew-resize' : 'ns-resize'; _guideHovered = true; }
  }
  if(isPanning){panX=e.clientX-panStart.x;panY=e.clientY-panStart.y;updateTransform();return;}
  if(pxTransformHandle === 'rotate' && pxTransformActive && pxTransformData && _rotateCenter){
    const curAngle = Math.atan2(py - _rotateCenter.y, px - _rotateCenter.x);
    let delta = curAngle - _rotateStartAngle;
    // Sticky 45° snap when Snap-To is active. Rotation stays smooth
    // outside a narrow ±5° magnetic window around each 45° mark, so the
    // object "catches" at the increment as the user rotates past it
    // without sacrificing continuous tracking elsewhere. Ctrl inverts
    // the current snap state.
    if (SnapEngine.isActive(e)) {
      const step      = Math.PI / 4;   // 45° increments
      const threshold = Math.PI / 36;  // ±5° magnetic window
      const nearest = Math.round(delta / step) * step;
      if (Math.abs(delta - nearest) < threshold) delta = nearest;
    }
    pxTransformData.liveRotation = delta;
    scheduleCompositeAndOverlay();
    return;
  }
  if(pxTransformHandle && pxTransformActive && pxTransformData){
    pxTransformData.curBounds = computePxTransformBounds(pxTransformHandle, px, py, e.shiftKey, e.altKey);
    const _b = pxTransformData.curBounds; const _h = pxTransformHandle;
    const _cx = [], _cy = [];
    if (_h === 'move' || /w/.test(_h)) _cx.push({val: _b.x});
    if (_h === 'move' || /e/.test(_h)) _cx.push({val: _b.x + _b.w});
    if (_h === 'move') _cx.push({val: _b.x + _b.w/2});
    if (_h === 'move' || /n/.test(_h)) _cy.push({val: _b.y});
    if (_h === 'move' || /s/.test(_h)) _cy.push({val: _b.y + _b.h});
    if (_h === 'move') _cy.push({val: _b.y + _b.h/2});
    const _snap = SnapEngine.snapBounds(_b, {candidatesX:_cx, candidatesY:_cy, modifiers:e});
    if (_snap.dx || _snap.dy) {
      if (_h === 'move') { _b.x += _snap.dx; _b.y += _snap.dy; }
      else {
        if (_snap.dx) {
          if (/w/.test(_h)) { _b.x += _snap.dx; _b.w -= _snap.dx; }
          else if (/e/.test(_h)) { _b.w += _snap.dx; }
        }
        if (_snap.dy) {
          if (/n/.test(_h)) { _b.y += _snap.dy; _b.h -= _snap.dy; }
          else if (/s/.test(_h)) { _b.h += _snap.dy; }
        }
      }
    }
    scheduleCompositeAndOverlay(); return;
  }
  if (currentTool === 'move' && pxTransformHandle === 'rotate') {
    workspace.style.cursor = ROTATE_CURSOR;
  }
  else if(!_guideHovered && pxTransformActive && pxTransformData && currentTool==='move' && !pxTransformHandle){
    const hit = hitTestPxTransform(px, py);
    if (hit === 'rotate') {
      workspace.style.cursor = ROTATE_CURSOR;
    } else if (hit) {
      const c = {nw:'nw-resize',n:'n-resize',ne:'ne-resize',w:'w-resize',e:'e-resize',sw:'sw-resize',s:'s-resize',se:'se-resize',move:'move'};
      workspace.style.cursor = c[hit] || 'default';
    } else {
      workspace.style.cursor = 'default';
    }
  }
  else if (!_guideHovered && currentTool === 'move' && !pxTransformActive && !floatingActive && !isPanning && !isMovingPixels) {
    const _pick = pickMoveTarget(px, py);
    workspace.style.cursor = _pick ? 'move' : 'default';
  }
  if(isMovingPixels&&floatingActive&&floatingCanvas){
    if (!_floatingDragBaseOffset) { _floatingDragBaseOffset = { x: floatingOffset.x, y: floatingOffset.y }; _floatingDragStart = { x: drawStart.x, y: drawStart.y }; }
    const _ux = _floatingDragBaseOffset.x + (px - _floatingDragStart.x);
    const _uy = _floatingDragBaseOffset.y + (py - _floatingDragStart.y);
    const _fb = { x: _ux, y: _uy, w: floatingCanvas.width, h: floatingCanvas.height };
    const _snap = SnapEngine.snapBounds(_fb, {modifiers:e});
    floatingOffset.x = _ux + _snap.dx;
    floatingOffset.y = _uy + _snap.dy;
    drawStart = {x:px, y:py};
    scheduleCompositeAndOverlay(); return;
  }
  if(transformHandleDrag&&transformOrigBounds){
    const dx=px-drawStart.x, dy=py-drawStart.y;
    if (dx !== 0 || dy !== 0) _transformDragMoved = true;
    // Shallow-clone the top-level object: applyTransformDelta either assigns
    // fresh arrays (lasso .points / wand .contours via .map()) or writes
    // primitives (rect x/y/w/h) on the clone, so transformOrigBounds stays
    // untouched between frames. Deep-cloning was an O(n) hot-path cost for
    // lasso/wand selections with many points.
    selection={...transformOrigBounds};
    applyTransformDelta(transformHandleDrag, dx, dy);
    const _tb = getSelectionBounds();
    if (_tb) {
      const _h = transformHandleDrag;
      const _cx = [], _cy = [];
      if (_h === 'move' || /w/.test(_h)) _cx.push({val: _tb.x});
      if (_h === 'move' || /e/.test(_h)) _cx.push({val: _tb.x + _tb.w});
      if (_h === 'move') _cx.push({val: _tb.x + _tb.w/2});
      if (_h === 'move' || /n/.test(_h)) _cy.push({val: _tb.y});
      if (_h === 'move' || /s/.test(_h)) _cy.push({val: _tb.y + _tb.h});
      if (_h === 'move') _cy.push({val: _tb.y + _tb.h/2});
      const _snap = SnapEngine.snapBounds(_tb, {candidatesX:_cx, candidatesY:_cy, modifiers:e});
      if (_snap.dx || _snap.dy) {
        selection={...transformOrigBounds};
        applyTransformDelta(transformHandleDrag, dx + _snap.dx, dy + _snap.dy);
      }
    }
    return;
  }
  if(transformSelActive&&(currentTool==='select'||currentTool==='lasso'||currentTool==='movesel'||currentTool==='wand')&&!isDrawing){ const h=getTransformHandle(px,py); const _fallback = (currentTool==='movesel') ? 'default' : 'crosshair'; if(h){const c={nw:'nw-resize',n:'n-resize',ne:'ne-resize',w:'w-resize',e:'e-resize',sw:'sw-resize',s:'s-resize',se:'se-resize',move:'move'};workspace.style.cursor=c[h]||_fallback;} else workspace.style.cursor=_fallback; }
  if(currentTool==='lasso'&&lassoMode==='poly'&&polyPoints.length>0&&!isDrawing){
    let cpx=px, cpy=py;
    if(e.shiftKey){ const anchor=polyPoints[polyPoints.length-1]; const c=applyRulerShiftConstraint(anchor.x,anchor.y,px,py); cpx=c.x; cpy=c.y; }
    updatePolyPreviewPath(cpx,cpy); return;
  }
  if(currentTool==='lasso'&&lassoMode==='magnetic'&&magActive){
    // Alt-drag freehand override
    if(magFreehandMode&&isDrawing){
      magFreehandPoints.push({x:px, y:py});
      // Build preview from committed + freehand
      prepareOverlay();
      if(selectionMode!=='new'&&selectionPath) drawAntsOnPath(overlayCtx, selectionPath);
      const p=magBuildPreviewPath();
      // Append freehand points to preview
      for(const fp of magFreehandPoints) p.lineTo(Math.round(fp.x), Math.round(fp.y));
      drawAntsOnPath(overlayCtx, p);
      overlayCtx.save(); overlayCtx.fillStyle='#fff'; overlayCtx.strokeStyle='#000'; overlayCtx.lineWidth=1;
      for(const a of magAnchors){const sp=c2s(a.x,a.y); overlayCtx.beginPath();overlayCtx.arc(sp.x,sp.y,3,0,Math.PI*2);overlayCtx.fill();overlayCtx.stroke();}
      overlayCtx.restore();
      return;
    }
    // Throttle to 60fps
    const now=performance.now();
    if(now-magLastPathTime<16) return;
    magLastPathTime=now;
    const width=getMagWidth();
    const contrast=getMagContrast();
    const frequency=getMagFrequency();
    const lastAnchor=magAnchors[magAnchors.length-1];
    // Ensure edge map covers region
    ensureEdgeMapCoverage(lastAnchor.x, lastAnchor.y, Math.round(px), Math.round(py), width);
    // Compute live-wire
    magLivePath=computeLiveWire(
      Math.round(lastAnchor.x), Math.round(lastAnchor.y),
      Math.round(px), Math.round(py),
      width, contrast
    );
    // Auto-anchor check
    checkAutoAnchor(px, py, frequency, width);
    // Redraw overlay
    drawMagneticOverlay();
    return;
  }
  if(currentTool==='gradient'&&gradDragging){
    if(gradDragging==='creating') { const _spg=SnapEngine.snapPoint({x:px,y:py},{modifiers:e}); gradP2={x:_spg.x, y:_spg.y}; }
    else if(gradDragging.type==='stop'){
      const idx = gradDragging.index;
      const isEndpoint = (idx === 0 || idx === gradStops.length - 1);
      if (isEndpoint) {
        const _spg=SnapEngine.snapPoint({x:px,y:py},{modifiers:e});
        if (idx === 0) gradP1 = {x: _spg.x, y: _spg.y};
        else gradP2 = {x: _spg.x, y: _spg.y};
      } else {
        const newT = gradProjectT(px, py);
        const minT = gradStops[idx - 1].t + 0.001;
        const maxT = gradStops[idx + 1].t - 0.001;
        gradStops[idx].t = Math.max(minT, Math.min(maxT, newT));
        const pd = gradPerpDist(px, py);
        gradStopAboutToDelete = pd > 30 / zoom;
      }
    } else if(gradDragging.type==='mid'){
      const idx = gradDragging.index;
      const s0 = gradStops[idx], s1 = gradStops[idx + 1];
      const dx=gradP2.x-gradP1.x, dy=gradP2.y-gradP1.y; const len2=dx*dx+dy*dy;
      if(len2>0){
        const t=((px-gradP1.x)*dx+(py-gradP1.y)*dy)/len2;
        const segLen = s1.t - s0.t;
        if (segLen > 0.001) { s0.mid = Math.max(0.01, Math.min(0.99, (t - s0.t) / segLen)); }
      }
    }
    renderGradientToLayer(); drawOverlay(); return;
  }
  if(currentTool==='gradient'&&gradActive&&!gradDragging){
    const hit=gradHitTest(px,py);
    const prevHover = gradHoverElement;
    gradHoverElement = hit;
    if (hit) {
      if (hit.type === 'stop') workspace.style.cursor = 'grab';
      else if (hit.type === 'mid') workspace.style.cursor = 'ew-resize';
      else if (hit.type === 'line') workspace.style.cursor = 'copy';
    } else { workspace.style.cursor = 'crosshair'; }
    if (JSON.stringify(hit) !== JSON.stringify(prevHover)) drawOverlay();
  }
  if(!isDrawing) return;
  const layer=getActiveLayer(); if(!layer||!layer.visible) return;
  if(currentTool==='select'&&isDrawingSelection){
    const _sp=SnapEngine.snapPoint({x:px,y:py},{modifiers:e});
    const {sx,sy,sw,sh}=constrainSelectBounds(drawStart.x,drawStart.y,_sp.x,_sp.y,e.shiftKey,e.altKey);
    if(sw>0&&sh>0) drawingPreviewPath=makeShapePath(selectShape, sx, sy, sw, sh); drawOverlay(); return;
  }
  if(currentTool==='lasso'&&lassoMode==='free'&&isDrawingSelection){
    lassoPoints.push({x:px, y:py}); const p=new Path2D();
    p.moveTo(Math.round(lassoPoints[0].x), Math.round(lassoPoints[0].y));
    for(let i=1;i<lassoPoints.length;i++) p.lineTo(Math.round(lassoPoints[i].x), Math.round(lassoPoints[i].y));
    drawingPreviewPath = p; drawOverlay(); return;
  }
  if(['brush','pencil','eraser'].includes(currentTool)&&strokeBuffer){
    const size=getDrawSize(); const hardness=currentTool==='pencil'?1:getDrawHardness();
    const smoothness=currentTool==='pencil'?0:getDrawSmoothness(); const color=currentTool==='eraser'?'#ffffff':fgColor;
    const sp=smoothStep(px,py,smoothness);
    if(currentTool==='pencil') stampPencilLine(strokeBufferCtx,lastDraw.x,lastDraw.y,sp.x,sp.y,size,color);
    else stampBrushSegment(strokeBufferCtx,lastDraw.x,lastDraw.y,sp.x,sp.y,size,hardness,color);
    scheduleStrokeComposite(); lastDraw={x:sp.x,y:sp.y};
  } else if(currentTool==='shape'){ const _sps=SnapEngine.snapPoint({x:px,y:py},{modifiers:e}); prepareOverlay(); overlayCtx.save(); const _dpr=window.devicePixelRatio||1; overlayCtx.setTransform(_dpr*zoom,0,0,_dpr*zoom,panX*_dpr,panY*_dpr); drawShapePreview(overlayCtx,drawStart.x,drawStart.y,_sps.x,_sps.y); overlayCtx.restore(); SnapEngine.drawIndicators(overlayCtx); }
}

function updatePolyPreviewPath(cursorX, cursorY) {
  if(polyPoints.length===0) return;
  const p=new Path2D();
  p.moveTo(Math.round(polyPoints[0].x), Math.round(polyPoints[0].y));
  for(let i=1;i<polyPoints.length;i++) p.lineTo(Math.round(polyPoints[i].x), Math.round(polyPoints[i].y));
  if(cursorX!==undefined) p.lineTo(Math.round(cursorX), Math.round(cursorY));
  drawingPreviewPath = p;
  prepareOverlay();
  if(selectionMode!=='new'&&selectionPath) drawAntsOnPath(overlayCtx, selectionPath);
  drawAntsOnPath(overlayCtx, p);
}

function onMouseUp(e) {
  // Guide drag finalization is handled by the document-level mouseup listener
  // to support drags that leave the workspace. Skip here to avoid double-handling.
  if (draggingGuide) return;
  if (currentTool === 'ruler' && rulerDrag) {
    // Zero-length click-off draw → clear
    if (rulerDrag.mode === 'draw' &&
        rulerState.x1 === rulerState.x2 &&
        rulerState.y1 === rulerState.y2) {
      clearRuler();
    } else {
      rulerDrag = null;
      SnapEngine.endSession();
      drawUIOverlay();
    }
    rulerDrag = null;
    isDrawing = false;
    // Refresh cursor based on final hover state
    const hit = rulerHitTest(e.clientX, e.clientY);
    workspace.style.cursor = getRulerCursor(hit, false);
    return;
  }
  if(pxTransformHandle === 'rotate'){
    // Rotation drag ends: accumulate the live delta into the persistent
    // totalRotation. srcCanvas and layer pixels are NOT mutated — the
    // transform remains a non-destructive smart object until an explicit
    // commit (Ctrl+D, Enter, Deselect button, double-click, Esc, tool
    // switch, etc.).
    const _d = pxTransformData;
    pxTransformHandle = null; pxTransformStartMouse = null; pxTransformOrigBounds = null;
    _rotateCenter = null; _rotateStartAngle = 0;
    if (_d) {
      _d.totalRotation = (_d.totalRotation || 0) + (_d.liveRotation || 0);
      _d.liveRotation = 0;
    }
    SnapEngine.endSession();
    updatePropertiesPanel();
    compositeAll(); drawOverlay();
    return;
  }
  if(pxTransformHandle){
    // Smart-object Free Transform: move/resize drags just update the
    // session state (curBounds). srcCanvas and layer pixels are NOT
    // mutated. The transform lives on as a floating overlay until the
    // user explicitly commits it (Ctrl+D, Enter, Deselect button,
    // double-click inside the box, Esc, tool switch, etc.).
    const _handle = pxTransformHandle;
    const _orig = pxTransformOrigBounds;
    const _d = pxTransformData;
    const _moved = !!(_d && _orig && (
      _orig.x !== _d.curBounds.x || _orig.y !== _d.curBounds.y ||
      _orig.w !== _d.curBounds.w || _orig.h !== _d.curBounds.h));
    // Alt-drag duplicate: stamp the original pixels at srcBounds so a copy
    // is left behind, then continue the session with the moved original.
    // Only legitimate when the user actually moved and there is no pending
    // rotation (we don't bake rotations on a non-commit path).
    const _altDup = _moveDragAltDuplicate && _handle === 'move' && _moved
                    && _d && !_d.totalRotation && !_d.liveRotation;
    _moveDragAltDuplicate = false;
    pxTransformHandle=null;pxTransformStartMouse=null;pxTransformOrigBounds=null;
    SnapEngine.endSession();
    if (_altDup && _d) {
      const layer = getActiveLayer();
      if (layer) {
        const sb = _d.srcBounds;
        layer.ctx.drawImage(_d.srcCanvas, 0, 0, _d.srcCanvas.width, _d.srcCanvas.height, sb.x, sb.y, sb.w, sb.h);
        SnapEngine.invalidateLayer(layer);
      }
      // The deposited duplicate is a destructive edit, so it needs its own
      // history entry. The moving copy stays as a live transform overlay.
      pushUndo('Duplicate');
    }
    updatePropertiesPanel();
    compositeAll(); drawOverlay();
    return;
  }
  if(transformHandleDrag){
    // Zero-distance clicks on handles (no mousemove between down and up)
    // must not push a spurious 'Move Selection' undo entry.
    const _moved = _transformDragMoved;
    _transformDragMoved = false;
    transformHandleDrag=null;transformOrigBounds=null;
    SnapEngine.endSession(); drawOverlay();
    if (_moved) pushUndo('Move Selection');
    return;
  }
  if(isPanning){isPanning=false;workspace.style.cursor=getToolCursor();return;}
  if(isMovingPixels){
    isMovingPixels=false; _floatingDragBaseOffset=null; _floatingDragStart=null;
    SnapEngine.endSession(); drawOverlay();
    pushUndo('Move');
    return;
  }
  if(currentTool==='gradient'&&gradDragging&&gradDragging!=='creating'){
    if (gradDragging.type === 'stop' && gradStopAboutToDelete) {
      const idx = gradDragging.index;
      if (idx > 0 && idx < gradStops.length - 1) {
        gradStops.splice(idx, 1);
      }
      gradStopAboutToDelete = false;
    }
    gradDragging=null; gradDragStartPos=null; gradStopAboutToDelete=false;
    workspace.style.cursor='crosshair'; SnapEngine.endSession(); renderGradientToLayer(); drawOverlay(); return;
  }
  // Magnetic lasso: freehand override release
  if(currentTool==='lasso'&&lassoMode==='magnetic'&&magFreehandMode&&isDrawing){
    isDrawing=false;
    // Commit freehand points as a segment
    if(magFreehandPoints.length>1){
      magSegments.push(magFreehandPoints.slice());
      const lastFH=magFreehandPoints[magFreehandPoints.length-1];
      magAnchors.push({x:Math.round(lastFH.x), y:Math.round(lastFH.y)});
    }
    magFreehandMode=false;
    magFreehandPoints=[];
    magLivePath=null;
    drawMagneticOverlay();
    return;
  }
  // Magnetic lasso is click-based; ignore normal mouseup while active
  if(currentTool==='lasso'&&lassoMode==='magnetic'&&magActive){ isDrawing=false; return; }
  if(!isDrawing) return; isDrawing=false;
  const pos=screenToCanvas(e.clientX||0,e.clientY||0); const px=pos.x,py=pos.y; const layer=getActiveLayer();
  if(currentTool==='select'&&isDrawingSelection){
    isDrawingSelection=false; drawingPreviewPath=null;
    const _spu=SnapEngine.snapPoint({x:px,y:py},{modifiers:e});
    const {sx,sy,sw,sh}=constrainSelectBounds(drawStart.x,drawStart.y,_spu.x,_spu.y,e.shiftKey,e.altKey);
    if(sw>1&&sh>1){ const p=makeShapePath(selectShape,sx,sy,sw,sh); commitNewSelection(p, {type:selectShape, x:sx, y:sy, w:sw, h:sh}); }
    SnapEngine.endSession(); drawOverlay(); return;
  }
  if(currentTool==='lasso'&&lassoMode==='free'&&isDrawingSelection){
    isDrawingSelection=false; drawingPreviewPath=null;
    if(lassoPoints.length>2){
      const p=new Path2D(); p.moveTo(Math.round(lassoPoints[0].x),Math.round(lassoPoints[0].y));
      for(let i=1;i<lassoPoints.length;i++) p.lineTo(Math.round(lassoPoints[i].x),Math.round(lassoPoints[i].y)); p.closePath();
      commitNewSelection(p, {type:'lasso', points:lassoPoints.map(pt=>({x:Math.round(pt.x),y:Math.round(pt.y)}))}); lassoPoints=[];
    }
    drawOverlay(); return;
  }
  if(['brush','pencil','eraser'].includes(currentTool)&&strokeBuffer&&layer){
    const opacity=getDrawOpacity(); layer.ctx.save();
    if(selectionPath) layer.ctx.clip(selectionPath, selectionFillRule);
    if(currentTool==='eraser') layer.ctx.globalCompositeOperation='destination-out';
    layer.ctx.globalAlpha=opacity; layer.ctx.drawImage(strokeBuffer,0,0); layer.ctx.restore();
    strokeBuffer=null; strokeBufferCtx=null; SnapEngine.invalidateLayer(layer); compositeAll();
    pushUndo(currentTool.charAt(0).toUpperCase()+currentTool.slice(1));
    return;
  }
  if(currentTool==='gradient'&&gradDragging){
    if(gradDragging==='creating'){
      const dist=Math.hypot(gradP2.x-gradP1.x, gradP2.y-gradP1.y);
      if(dist<3){ gradRestore(); compositeAll(); gradP1=null; gradP2=null; gradStops=[]; gradDragging=null; gradBaseSnapshot=null; SnapEngine.endSession(); drawOverlay(); return; }
      gradActive=true; renderGradientToLayer();
    }
    gradDragging=null; gradDragStartPos=null; gradStopAboutToDelete=false;
    workspace.style.cursor='crosshair'; SnapEngine.endSession(); drawOverlay(); return;
  }
  if(currentTool==='shape'&&layer){ const _spu=SnapEngine.snapPoint({x:px,y:py},{modifiers:e}); drawShapeOnLayer(layer.ctx,drawStart.x,drawStart.y,_spu.x,_spu.y);SnapEngine.invalidateLayer(layer);compositeAll(); pushUndo('Shape'); }
  SnapEngine.endSession();
  drawOverlay();
}

function drawShapePreview(ctx, x1, y1, x2, y2) {
  const fillMode = document.getElementById('shapeFillMode').value; const sw = parseInt(document.getElementById('shapeStrokeWidth').value) || 2;
  ctx.save(); ctx.strokeStyle = fgColor; ctx.fillStyle = fgColor; ctx.lineWidth = sw; ctx.globalAlpha = getToolOpacity();
  if (shapeType === 'rect') { const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1); if (fillMode === 'fill' || fillMode === 'both') ctx.fillRect(x, y, w, h); if (fillMode === 'stroke' || fillMode === 'both') ctx.strokeRect(x, y, w, h); }
  else if (shapeType === 'ellipse') { const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); if (fillMode === 'fill' || fillMode === 'both') ctx.fill(); if (fillMode === 'stroke' || fillMode === 'both') ctx.stroke(); }
  else if (shapeType === 'line') { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineCap = 'round'; ctx.stroke(); }
  ctx.restore();
}

function drawShapeOnLayer(ctx, x1, y1, x2, y2) {
  const fillMode = document.getElementById('shapeFillMode').value; const sw = parseInt(document.getElementById('shapeStrokeWidth').value) || 2;
  ctx.save(); ctx.strokeStyle = fgColor; ctx.fillStyle = fgColor; ctx.lineWidth = sw; ctx.globalAlpha = getToolOpacity();
  if (selectionPath) ctx.clip(selectionPath, selectionFillRule);
  if (shapeType === 'rect') { const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1); if (fillMode === 'fill' || fillMode === 'both') ctx.fillRect(x, y, w, h); if (fillMode === 'stroke' || fillMode === 'both') ctx.strokeRect(x, y, w, h); }
  else if (shapeType === 'ellipse') { const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); if (fillMode === 'fill' || fillMode === 'both') ctx.fill(); if (fillMode === 'stroke' || fillMode === 'both') ctx.stroke(); }
  else if (shapeType === 'line') { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineCap = 'round'; ctx.stroke(); }
  ctx.restore();
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
  if (type === 'brightness') { titleEl.textContent = 'Brightness / Contrast'; controlsEl.innerHTML = sliderRow('Brightness', 'filterBrightness', -100, 100, 0) + sliderRow('Contrast', 'filterContrast', -100, 100, 0); }
  else if (type === 'hsl') { titleEl.textContent = 'Hue / Saturation'; controlsEl.innerHTML = sliderRow('Hue', 'filterHue', -180, 180, 0) + sliderRow('Saturation', 'filterSaturation', -100, 100, 0) + sliderRow('Lightness', 'filterLightness', -100, 100, 0); }
  else if (type === 'blur') { titleEl.textContent = 'Gaussian Blur'; controlsEl.innerHTML = sliderRow('Radius', 'filterBlurRadius', 0, 20, 3); }
  else if (type === 'sharpen') { titleEl.textContent = 'Sharpen'; controlsEl.innerHTML = sliderRow('Amount', 'filterSharpenAmt', 0, 100, 50); }
  else if (type === 'invert') { applyFilterDirect('invert'); return; }
  else if (type === 'grayscale') { applyFilterDirect('grayscale'); return; }
  controlsEl.querySelectorAll('.filter-slider').forEach(slider => { slider.addEventListener('input', () => { const valEl = slider.parentElement.querySelector('.filter-slider-value'); if (valEl) valEl.textContent = slider.value; updateFilterPreview(); }); slider.addEventListener('dblclick', () => { slider.value = slider.defaultValue; const valEl = slider.parentElement.querySelector('.filter-slider-value'); if (valEl) valEl.textContent = slider.defaultValue; updateFilterPreview(); }); });
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
  return `<div class="filter-slider-row"><span class="filter-slider-label">${label}</span><input type="range" class="filter-slider" id="${id}" min="${min}" max="${max}" value="${val}"><span class="filter-slider-value">${val}</span></div>`;
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

/**
 * stampImageAsCommittedLayer — Inserts a full-resolution image as a new layer
 * at (originX, originY) and pushes a regular undo entry. No selection, no
 * Free Transform. Used by the multi-file batch drop where canvas is auto-
 * expanded to fit all incoming images anchored at top-left.
 */
function stampImageAsCommittedLayer(srcCanvas, layerName, originX, originY) {
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
  pushUndo(`Import "${layerName}"`);
}

function _decodeFileToCanvas(file) {
  return new Promise((resolve, reject) => {
    if (!RASTER_MIME_TYPES.has(file.type.toLowerCase())) { reject(new Error(`Unsupported format: ${file.type}`)); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0);
        resolve(c);
      };
      img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
      img.src = ev.target.result;
    };
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/**
 * Single-image import-as-layer.
 *  • Always commits any active transform / floating selection first.
 *  • If the image is bigger than the canvas in either dimension, prompts the
 *    user (Expand / Keep / Cancel).
 *      – Expand: canvas grows to fit (TL-anchored), image drops at (0,0),
 *        Free Transform engaged.
 *      – Keep: image is centered (clipped where it extends past canvas),
 *        Free Transform engaged.
 *  • If the image fits within the canvas, it is centered and Free Transform
 *    is engaged (per spec — every single-file add lands in transform mode).
 */
async function importImageAsLayer(file) {
  const srcCanvas = await _decodeFileToCanvas(file);
  if (pxTransformActive) commitPixelTransform();
  if (floatingActive) commitFloating();

  const layerName = file.name.replace(/\.[^.]+$/, '');
  const w = srcCanvas.width, h = srcCanvas.height;

  if (w > canvasW || h > canvasH) {
    const choice = await openImportSizeDialog(w, h);
    if (choice === 'cancel') return;
    if (choice === 'expand') {
      expandCanvasToFit(w, h);
      placeImageAsTransformLayer(srcCanvas, layerName, 0, 0);
      zoomFit();
      updateStatus();
      return;
    }
  }

  const px = Math.round((canvasW - w) / 2);
  const py = Math.round((canvasH - h) / 2);
  placeImageAsTransformLayer(srcCanvas, layerName, px, py);
}

async function importFilesAsLayers(files) {
  const validFiles = Array.from(files).filter(f => RASTER_MIME_TYPES.has(f.type.toLowerCase()));
  if (validFiles.length === 0) return;

  if (validFiles.length === 1) {
    try { await importImageAsLayer(validFiles[0]); }
    catch (err) { console.warn('[Opsin] Import skipped:', err.message); }
    return;
  }

  // Batch drop: decode everything first, expand canvas to fit the largest
  // dimensions, then stamp each image at top-left as its own committed layer
  // (no per-file prompt, no Free Transform — Paint.NET batch behavior).
  if (pxTransformActive) commitPixelTransform();
  if (floatingActive) commitFloating();

  const decoded = [];
  for (const f of validFiles) {
    try { decoded.push({ name: f.name.replace(/\.[^.]+$/, ''), canvas: await _decodeFileToCanvas(f) }); }
    catch (err) { console.warn('[Opsin] Import skipped:', err.message); }
  }
  if (decoded.length === 0) return;

  let maxW = canvasW, maxH = canvasH;
  for (const d of decoded) { if (d.canvas.width > maxW) maxW = d.canvas.width; if (d.canvas.height > maxH) maxH = d.canvas.height; }
  if (maxW > canvasW || maxH > canvasH) {
    expandCanvasToFit(maxW, maxH);
    zoomFit();
    updateStatus();
  }
  for (const d of decoded) {
    stampImageAsCommittedLayer(d.canvas, d.name, 0, 0);
  }
  compositeAll();
  updateLayerPanel();
}

function triggerImportLayer() { document.getElementById('importLayerInput').click(); }

function saveImage(format) {
  closeAllMenus();
  const exportCanvas = document.createElement('canvas'); exportCanvas.width = canvasW; exportCanvas.height = canvasH;
  const ectx = exportCanvas.getContext('2d');
  if (format === 'jpg') { ectx.fillStyle = '#ffffff'; ectx.fillRect(0, 0, canvasW, canvasH); }
  for (let i = layers.length - 1; i >= 0; i--) { const l = layers[i]; if (!l.visible) continue; ectx.globalAlpha = l.opacity; ectx.drawImage(l.canvas, 0, 0); if (i === activeLayerIndex && floatingActive && floatingCanvas) ectx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y); }
  ectx.globalAlpha = 1;
  const mimeType = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const ext = format === 'jpg' ? '.jpg' : format === 'webp' ? '.webp' : '.png';
  exportCanvas.toBlob(blob => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'image' + ext; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000); }, mimeType, 0.92);
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

/* ── BMP Encoder ─────────────────────────────────────── */
function encodeBMP(imageData, w, h, bitDepth) {
  const channels = bitDepth === 32 ? 4 : 3;
  const rowBytes = w * channels;
  const rowPadding = (4 - (rowBytes % 4)) % 4;
  const pixelDataSize = (rowBytes + rowPadding) * h;

  // 24-bit uses BITMAPINFOHEADER (40 bytes), 32-bit uses BITMAPV4HEADER (108 bytes)
  const dibHeaderSize = bitDepth === 32 ? 108 : 40;
  const headerSize = 14 + dibHeaderSize;
  const fileSize = headerSize + pixelDataSize;
  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);
  const d = imageData.data;

  // ── BMP File Header (14 bytes) ──
  view.setUint8(0, 0x42);  // 'B'
  view.setUint8(1, 0x4D);  // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint16(6, 0, true);  // reserved
  view.setUint16(8, 0, true);  // reserved
  view.setUint32(10, headerSize, true);  // pixel data offset

  // ── DIB Header ──
  view.setUint32(14, dibHeaderSize, true);  // header size
  view.setInt32(18, w, true);               // width
  view.setInt32(22, -h, true);              // height (negative = top-down)
  view.setUint16(26, 1, true);             // color planes
  view.setUint16(28, bitDepth, true);      // bits per pixel

  if (bitDepth === 32) {
    // BITMAPV4HEADER fields
    view.setUint32(30, 3, true);              // compression: BI_BITFIELDS
    view.setUint32(34, pixelDataSize, true);  // image size
    view.setInt32(38, 2835, true);            // X pixels per meter (72 DPI)
    view.setInt32(42, 2835, true);            // Y pixels per meter (72 DPI)
    view.setUint32(46, 0, true);              // colors in table
    view.setUint32(50, 0, true);              // important colors
    // Channel masks: R, G, B, A
    view.setUint32(54, 0x00FF0000, true);     // red mask
    view.setUint32(58, 0x0000FF00, true);     // green mask
    view.setUint32(62, 0x000000FF, true);     // blue mask
    view.setUint32(66, 0xFF000000, true);     // alpha mask
    // Color space: LCS_sRGB (0x73524742 = 'sRGB')
    view.setUint32(70, 0x73524742, true);
    // CIEXYZTRIPLE endpoints (36 bytes) + gamma values (12 bytes) = 48 bytes, all zero for sRGB
    for (let i = 74; i < 122; i += 4) view.setUint32(i, 0, true);
  } else {
    // BITMAPINFOHEADER fields
    view.setUint32(30, 0, true);              // compression: BI_RGB
    view.setUint32(34, pixelDataSize, true);  // image size
    view.setInt32(38, 2835, true);            // X pixels per meter (72 DPI)
    view.setInt32(42, 2835, true);            // Y pixels per meter (72 DPI)
    view.setUint32(46, 0, true);              // colors in table
    view.setUint32(50, 0, true);              // important colors
  }

  // ── Pixel data (top-down via negative height) ──
  let offset = headerSize;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      if (bitDepth === 32) {
        // BGRA byte order
        view.setUint8(offset++, d[si + 2]); // B
        view.setUint8(offset++, d[si + 1]); // G
        view.setUint8(offset++, d[si]);     // R
        view.setUint8(offset++, d[si + 3]); // A
      } else {
        // BGR byte order
        view.setUint8(offset++, d[si + 2]); // B
        view.setUint8(offset++, d[si + 1]); // G
        view.setUint8(offset++, d[si]);     // R
      }
    }
    // Row padding to 4-byte boundary
    for (let p = 0; p < rowPadding; p++) view.setUint8(offset++, 0);
  }

  return new Blob([buf], { type: 'image/bmp' });
}

/* ── TIFF Encoder (uncompressed, little-endian) ────── */
function encodeTIFF(imageData, w, h, bitDepth) {
  const channels = bitDepth === 32 ? 4 : 3;
  const stripSize = w * h * channels;

  // Tag counts and IFD layout
  const tagCount = bitDepth === 32 ? 13 : 12;
  const ifdOffset = 8;
  const ifdSize = 2 + tagCount * 12 + 4;
  let overflowOffset = ifdOffset + ifdSize;

  // BitsPerSample overflow: 3 or 4 shorts
  const bpsOffset = overflowOffset;
  overflowOffset += channels * 2;
  // XResolution rational (8 bytes)
  const xResOffset = overflowOffset;
  overflowOffset += 8;
  // YResolution rational (8 bytes)
  const yResOffset = overflowOffset;
  overflowOffset += 8;

  const stripOffset = overflowOffset;
  const fileSize = stripOffset + stripSize;
  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);
  const d = imageData.data;

  // ── TIFF Header (8 bytes) ──
  view.setUint8(0, 0x49); view.setUint8(1, 0x49); // 'II' little-endian
  view.setUint16(2, 42, true);                      // magic
  view.setUint32(4, ifdOffset, true);                // offset to first IFD

  // ── IFD ──
  let pos = ifdOffset;
  view.setUint16(pos, tagCount, true); pos += 2;

  function writeTag(tag, type, count, value) {
    view.setUint16(pos, tag, true); pos += 2;
    view.setUint16(pos, type, true); pos += 2;
    view.setUint32(pos, count, true); pos += 4;
    // Type sizes: 1=BYTE(1), 2=ASCII(1), 3=SHORT(2), 4=LONG(4), 5=RATIONAL(8)
    if (type === 3 && count === 1) {
      view.setUint16(pos, value, true); pos += 4; // value in low 2 bytes, pad
    } else {
      view.setUint32(pos, value, true); pos += 4;
    }
  }

  // Tags must be in ascending order by tag ID
  writeTag(256, 3, 1, w);                    // ImageWidth
  writeTag(257, 3, 1, h);                    // ImageLength
  writeTag(258, 3, channels, bpsOffset);     // BitsPerSample -> overflow
  writeTag(259, 3, 1, 1);                    // Compression: None
  writeTag(262, 3, 1, 2);                    // PhotometricInterpretation: RGB
  writeTag(273, 4, 1, stripOffset);          // StripOffsets
  writeTag(277, 3, 1, channels);             // SamplesPerPixel
  writeTag(278, 3, 1, h);                    // RowsPerStrip: entire image
  writeTag(279, 4, 1, stripSize);            // StripByteCounts
  writeTag(282, 5, 1, xResOffset);           // XResolution -> overflow
  writeTag(283, 5, 1, yResOffset);           // YResolution -> overflow
  writeTag(296, 3, 1, 2);                    // ResolutionUnit: inch
  if (bitDepth === 32) {
    writeTag(338, 3, 1, 2);                  // ExtraSamples: unassociated alpha
  }

  // Next IFD offset: 0 (no more IFDs)
  view.setUint32(pos, 0, true);

  // ── Overflow data ──
  // BitsPerSample values
  for (let i = 0; i < channels; i++) view.setUint16(bpsOffset + i * 2, 8, true);
  // XResolution: 72/1
  view.setUint32(xResOffset, 72, true);
  view.setUint32(xResOffset + 4, 1, true);
  // YResolution: 72/1
  view.setUint32(yResOffset, 72, true);
  view.setUint32(yResOffset + 4, 1, true);

  // ── Pixel data (uncompressed RGB or RGBA, top-to-bottom) ──
  let offset = stripOffset;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      view.setUint8(offset++, d[si]);     // R
      view.setUint8(offset++, d[si + 1]); // G
      view.setUint8(offset++, d[si + 2]); // B
      if (channels === 4) view.setUint8(offset++, d[si + 3]); // A
    }
  }

  return new Blob([buf], { type: 'image/tiff' });
}

/* ═══════════════════════════════════════════════════════
   EXPORT ICO — Multi-size .ico encoder with Lanczos-3
   ═══════════════════════════════════════════════════════ */

/* ── Lanczos-3 High-Quality Resampler ────────────────── */
// Separable 2-pass Lanczos-3 windowed sinc filter operating in linear light.
// Premultiplied alpha during interpolation for correct edge blending.
function lanczos3Resample(srcData, srcW, srcH, dstW, dstH) {
  const a = 3; // Lanczos kernel radius
  function lanczosKernel(x) {
    if (x === 0) return 1;
    if (x >= a || x <= -a) return 0;
    const px = Math.PI * x;
    return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
  }

  // sRGB <-> linear conversion (matching existing helpers in gradient code)
  function toLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function toSrgb(c) { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(v * 255))); }

  const src = srcData.data;

  // Pass 1: Horizontal resample (srcW -> dstW, height stays srcH)
  const tmpW = dstW, tmpH = srcH;
  const tmp = new Float64Array(tmpW * tmpH * 4);
  const xRatio = srcW / dstW;
  for (let y = 0; y < tmpH; y++) {
    for (let x = 0; x < tmpW; x++) {
      const center = (x + 0.5) * xRatio - 0.5;
      const left = Math.ceil(center - a);
      const right = Math.floor(center + a);
      let r = 0, g = 0, b = 0, alpha = 0, wSum = 0;
      for (let ix = left; ix <= right; ix++) {
        const sx = Math.min(Math.max(ix, 0), srcW - 1);
        const w = lanczosKernel(center - ix);
        const si = (y * srcW + sx) * 4;
        const aVal = src[si + 3] / 255;
        const pa = aVal * w; // premultiplied weight
        r += toLinear(src[si])     * pa;
        g += toLinear(src[si + 1]) * pa;
        b += toLinear(src[si + 2]) * pa;
        alpha += aVal * w;
        wSum += w;
      }
      const di = (y * tmpW + x) * 4;
      if (alpha > 1e-6) {
        tmp[di]     = r / alpha;
        tmp[di + 1] = g / alpha;
        tmp[di + 2] = b / alpha;
        tmp[di + 3] = alpha / wSum;
      }
    }
  }

  // Pass 2: Vertical resample (tmpH -> dstH, width stays dstW)
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const yRatio = tmpH / dstH;
  for (let x = 0; x < dstW; x++) {
    for (let y = 0; y < dstH; y++) {
      const center = (y + 0.5) * yRatio - 0.5;
      const top = Math.ceil(center - a);
      const bottom = Math.floor(center + a);
      let r = 0, g = 0, b = 0, alpha = 0, wSum = 0;
      for (let iy = top; iy <= bottom; iy++) {
        const sy = Math.min(Math.max(iy, 0), tmpH - 1);
        const w = lanczosKernel(center - iy);
        const si = (sy * tmpW + x) * 4;
        const aVal = tmp[si + 3];
        const pa = aVal * w;
        r += tmp[si]     * pa;
        g += tmp[si + 1] * pa;
        b += tmp[si + 2] * pa;
        alpha += aVal * w;
        wSum += w;
      }
      const di = (y * dstW + x) * 4;
      const fa = wSum > 1e-6 ? alpha / wSum : 0;
      out[di + 3] = Math.max(0, Math.min(255, Math.round(fa * 255)));
      if (alpha > 1e-6) {
        out[di]     = toSrgb(r / alpha);
        out[di + 1] = toSrgb(g / alpha);
        out[di + 2] = toSrgb(b / alpha);
      }
    }
  }
  return new ImageData(out, dstW, dstH);
}

/* ── ICO Modal Controls ──────────────────────────────── */
function openExportIcoModal() {
  closeAllMenus();
  // Remove any custom rows from a previous session
  document.querySelectorAll('.ico-size-row.custom').forEach(r => r.remove());
  deactivateIcoGhostRow();
  resetIcoFormats();
  const cbs = document.querySelectorAll('.ico-size-cb');
  cbs.forEach(cb => { cb.checked = ICO_DEFAULT_SIZES.includes(parseInt(cb.value)); });
  updateIcoSelectAll();
  document.getElementById('exportIcoModal').classList.add('show');
}

function toggleIcoSelectAll() {
  const all = document.getElementById('icoSelectAll').checked;
  document.querySelectorAll('.ico-size-cb').forEach(cb => { cb.checked = all; });
}

function updateIcoSelectAll() {
  const cbs = Array.from(document.querySelectorAll('.ico-size-cb'));
  const checked = cbs.filter(cb => cb.checked).length;
  const sa = document.getElementById('icoSelectAll');
  sa.checked = checked === cbs.length;
  sa.indeterminate = false;
}

/* ── ICO Per-Row Format Toggle ────────────────────────── */
function setIcoRowFormat(row, fmt) {
  row.dataset.fmt = fmt;
  // Target the togglable format badge (has onclick), not the CUSTOM label badge
  const badges = Array.from(row.querySelectorAll('.ico-format-badge'));
  const badge = badges.find(b => b.getAttribute('onclick')) || badges.find(b => b.classList.contains('png') || b.classList.contains('bmp')) || badges[badges.length - 1];
  badge.className = 'ico-format-badge ' + fmt;
  badge.textContent = fmt.toUpperCase();
  if (!badge.getAttribute('onclick')) {
    badge.setAttribute('onclick', 'event.preventDefault();toggleIcoRowFormat(this)');
  }
}

function toggleIcoRowFormat(badge) {
  const row = badge.closest('.ico-size-row');
  const current = row.dataset.fmt;
  setIcoRowFormat(row, current === 'png' ? 'bmp' : 'png');
  updateIcoMasterFmtLabel();
}

function cycleIcoMasterFormat() {
  const btn = document.getElementById('icoMasterFmt');
  // If currently mixed (user-defined), cycle starts at png
  const current = btn.dataset.mode || 'auto';
  const cycleFrom = (current === '' || current === 'mixed') ? 'mixed' : current;
  const modes = ['auto', 'png', 'bmp'];
  let next;
  if (cycleFrom === 'mixed') next = 'png';
  else next = modes[(modes.indexOf(current) + 1) % modes.length];
  btn.dataset.mode = next;
  btn.textContent = { auto: 'Default', png: 'PNG', bmp: 'BMP' }[next];
  document.querySelectorAll('.ico-size-row').forEach(row => {
    const size = parseInt(row.dataset.icoSize);
    if (next === 'auto') setIcoRowFormat(row, size >= 256 ? 'png' : 'bmp');
    else setIcoRowFormat(row, next);
  });
}

function updateIcoMasterFmtLabel() {
  const rows = Array.from(document.querySelectorAll('.ico-size-row'));
  const allPng = rows.every(r => r.dataset.fmt === 'png');
  const allBmp = rows.every(r => r.dataset.fmt === 'bmp');
  const isAuto = rows.every(r => {
    const s = parseInt(r.dataset.icoSize);
    return (s >= 256 && r.dataset.fmt === 'png') || (s < 256 && r.dataset.fmt === 'bmp');
  });
  const btn = document.getElementById('icoMasterFmt');
  if (allPng) { btn.dataset.mode = 'png'; btn.textContent = 'PNG'; }
  else if (allBmp) { btn.dataset.mode = 'bmp'; btn.textContent = 'BMP'; }
  else if (isAuto) { btn.dataset.mode = 'auto'; btn.textContent = 'Default'; }
  else { btn.dataset.mode = 'mixed'; btn.textContent = 'Mixed'; }
}

function resetIcoFormats() {
  document.querySelectorAll('.ico-size-row:not(.custom)').forEach(row => {
    const size = parseInt(row.dataset.icoSize);
    setIcoRowFormat(row, size >= 256 ? 'png' : 'bmp');
  });
  const btn = document.getElementById('icoMasterFmt');
  btn.dataset.mode = 'auto';
  btn.textContent = 'Default';
}

/* ── ICO Custom Size (Ghost Row) ─────────────────────── */
let _icoGhostBlurTimer = null;

function activateIcoGhostRow() {
  document.getElementById('icoGhostRow').style.display = 'none';
  const gi = document.getElementById('icoGhostInput');
  gi.style.display = 'flex';
  const inp = document.getElementById('icoCustomSizeInput');
  inp.value = '';
  inp.focus();
}

function deactivateIcoGhostRow() {
  clearTimeout(_icoGhostBlurTimer);
  document.getElementById('icoGhostInput').style.display = 'none';
  document.getElementById('icoGhostRow').style.display = 'flex';
}

function addIcoCustomSize() {
  clearTimeout(_icoGhostBlurTimer);
  const inp = document.getElementById('icoCustomSizeInput');
  const val = parseInt(inp.value);
  if (!val || val < 1 || val > 512 || !Number.isInteger(val)) { inp.focus(); return; }
  // Check for duplicates among all current size rows
  const existing = Array.from(document.querySelectorAll('.ico-size-cb')).map(cb => parseInt(cb.value));
  if (existing.includes(val)) { inp.value = ''; inp.focus(); return; }
  // Build the custom row — default format follows master or auto rule
  const row = document.createElement('label');
  row.className = 'ico-size-row custom';
  row.dataset.icoSize = val;
  const masterMode = (document.getElementById('icoMasterFmt').dataset.mode || 'auto');
  const fmt = masterMode === 'png' ? 'png' : masterMode === 'bmp' ? 'bmp' : (val >= 256 ? 'png' : 'bmp');
  row.dataset.fmt = fmt;
  row.innerHTML =
    '<input type="checkbox" class="ico-size-cb" value="' + val + '" checked onchange="updateIcoSelectAll()">' +
    '<span class="ico-check"></span>' +
    '<span class="ico-size-label">' + val + ' x ' + val + '</span>' +
    '<span class="ico-format-badge custom">CUSTOM</span>' +
    '<span class="ico-format-badge ' + fmt + '" onclick="event.preventDefault();toggleIcoRowFormat(this)">' + fmt.toUpperCase() + '</span>' +
    '<button class="ico-remove" onclick="event.preventDefault();removeIcoCustomSize(this)" title="Remove">&times;</button>';
  // Insert sorted (descending) — find the first row with a smaller size
  const list = document.querySelector('.ico-size-list');
  const rows = Array.from(list.querySelectorAll('.ico-size-row'));
  let inserted = false;
  for (const r of rows) {
    if (parseInt(r.dataset.icoSize) < val) {
      list.insertBefore(row, r);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    // Smaller than all — insert before ghost row
    list.insertBefore(row, document.getElementById('icoGhostRow'));
  }
  updateIcoSelectAll();
  deactivateIcoGhostRow();
}

function removeIcoCustomSize(btn) {
  btn.closest('.ico-size-row').remove();
  updateIcoSelectAll();
  updateIcoMasterFmtLabel();
}

// Wire up keyboard events for the custom size input
document.getElementById('icoCustomSizeInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); addIcoCustomSize(); }
  else if (e.key === 'Escape') { deactivateIcoGhostRow(); }
});
document.getElementById('icoCustomSizeInput').addEventListener('blur', function() {
  _icoGhostBlurTimer = setTimeout(deactivateIcoGhostRow, 150);
});

/* ── ICO Binary Encoder ──────────────────────────────── */
// Encodes a BMP DIB (no file header) for embedding in ICO.
// 32-bit BGRA, bottom-to-top rows, with AND mask.
function encodeIcoDIB(imageData, size) {
  const w = size, h = size;
  const andRowBytes = Math.ceil(w / 8);
  const andRowPad = (4 - (andRowBytes % 4)) % 4;
  const andMaskSize = (andRowBytes + andRowPad) * h;
  const pixelDataSize = w * h * 4;
  const dibHeaderSize = 40;
  const totalSize = dibHeaderSize + pixelDataSize + andMaskSize;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const d = imageData.data;

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(0, 40, true);          // biSize
  view.setInt32(4, w, true);            // biWidth
  view.setInt32(8, h * 2, true);        // biHeight (XOR + AND)
  view.setUint16(12, 1, true);          // biPlanes
  view.setUint16(14, 32, true);         // biBitCount
  view.setUint32(16, 0, true);          // biCompression = BI_RGB
  view.setUint32(20, pixelDataSize + andMaskSize, true); // biSizeImage
  // biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant = 0

  // Pixel data: BGRA, bottom-to-top
  let offset = dibHeaderSize;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      view.setUint8(offset,     d[si + 2]); // B
      view.setUint8(offset + 1, d[si + 1]); // G
      view.setUint8(offset + 2, d[si]);     // R
      view.setUint8(offset + 3, d[si + 3]); // A
      offset += 4;
    }
  }

  // AND mask: 1-bit per pixel, bottom-to-top
  // With 32-bit BGRA the alpha channel carries transparency,
  // so the AND mask is formally all-zero (opaque). Some legacy
  // readers still consult it, so we set bits for fully-transparent pixels.
  for (let y = h - 1; y >= 0; y--) {
    for (let byteIdx = 0; byteIdx < andRowBytes; byteIdx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const px = byteIdx * 8 + bit;
        if (px < w) {
          const si = (y * w + px) * 4;
          if (d[si + 3] === 0) byte |= (0x80 >> bit);
        }
      }
      view.setUint8(offset, byte);
      offset++;
    }
    for (let p = 0; p < andRowPad; p++) { view.setUint8(offset++, 0); }
  }

  return new Uint8Array(buf);
}

async function executeIcoExport() {
  // Build a size->format map from the checked rows (read before closing modal)
  const checkedRows = Array.from(document.querySelectorAll('.ico-size-row')).filter(r => r.querySelector('.ico-size-cb').checked);
  const fmtMap = {};
  checkedRows.forEach(r => { fmtMap[parseInt(r.dataset.icoSize)] = r.dataset.fmt || 'bmp'; });
  const sizes = Object.keys(fmtMap).map(Number).sort((a, b) => b - a);
  if (sizes.length === 0) return;
  closeModal('exportIcoModal');

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
  const srcData = ectx.getImageData(0, 0, canvasW, canvasH);

  // Resample and encode each size
  const imageEntries = []; // { size, data: Uint8Array }
  for (const size of sizes) {
    const resampled = (size === canvasW && size === canvasH)
      ? srcData
      : lanczos3Resample(srcData, canvasW, canvasH, size, size);

    if (fmtMap[size] === 'png') {
      // PNG-encode
      const tmpCvs = document.createElement('canvas');
      tmpCvs.width = size; tmpCvs.height = size;
      tmpCvs.getContext('2d').putImageData(resampled, 0, 0);
      const pngBlob = await new Promise(resolve => tmpCvs.toBlob(resolve, 'image/png'));
      const pngBuf = await pngBlob.arrayBuffer();
      imageEntries.push({ size, data: new Uint8Array(pngBuf) });
    } else {
      // BMP DIB
      imageEntries.push({ size, data: encodeIcoDIB(resampled, size) });
    }
  }

  // Assemble ICO file
  const count = imageEntries.length;
  const headerSize = 6;
  const dirSize = count * 16;
  let dataOffset = headerSize + dirSize;
  const totalSize = dataOffset + imageEntries.reduce((s, e) => s + e.data.length, 0);
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);

  // ICONDIR header
  view.setUint16(0, 0, true);       // reserved
  view.setUint16(2, 1, true);       // type = ICO
  view.setUint16(4, count, true);   // image count

  // ICONDIRENTRY for each image
  for (let i = 0; i < count; i++) {
    const e = imageEntries[i];
    const off = 6 + i * 16;
    view.setUint8(off, e.size === 256 ? 0 : e.size);     // width (0 = 256)
    view.setUint8(off + 1, e.size === 256 ? 0 : e.size); // height (0 = 256)
    view.setUint8(off + 2, 0);      // color count
    view.setUint8(off + 3, 0);      // reserved
    view.setUint16(off + 4, 1, true);  // planes
    view.setUint16(off + 6, 32, true); // bit count
    view.setUint32(off + 8, e.data.length, true);  // bytes in resource
    view.setUint32(off + 12, dataOffset, true);     // offset to data
    dataOffset += e.data.length;
  }

  // Image data
  let writePos = headerSize + dirSize;
  for (const e of imageEntries) {
    new Uint8Array(buf, writePos, e.data.length).set(e.data);
    writePos += e.data.length;
  }

  const blob = new Blob([buf], { type: 'image/x-icon' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'image.ico'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ═══════════════════════════════════════════════════════
   MENUS
   ═══════════════════════════════════════════════════════ */

function closeAllMenus() { document.querySelectorAll('.menu-dropdown').forEach(d => d.classList.remove('show')); document.querySelectorAll('.menu-item').forEach(i => i.classList.remove('open')); openMenuId = null; if (window.IEM && window.IEM.applyFileMenuState) window.IEM.applyFileMenuState(); }
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

function updateBrushCursor(e) {
  if (!['brush','pencil','eraser'].includes(currentTool) || spaceDown || isPanning) { brushCursorEl.style.display = 'none'; return; }
  const size = getDrawSize(); const screenSize = size * zoom;
  if (currentTool === 'pencil') {
    if (screenSize < 1) { brushCursorEl.style.display = 'none'; workspace.style.cursor = 'crosshair'; return; }
    workspace.style.cursor = 'none'; brushCursorEl.className = 'pencil-cursor'; brushCursorEl.style.display = 'block';
    const dispSize = Math.max(2, screenSize); brushCursorEl.style.width = dispSize + 'px'; brushCursorEl.style.height = dispSize + 'px';
    brushCursorEl.style.background = fgColor; brushCursorEl.style.opacity = '0.7';
    brushCursorEl.style.transform = `translate(${e.clientX - dispSize/2}px, ${e.clientY - dispSize/2}px)`;
  } else {
    // Cursor radius reflects the 50%-alpha falloff boundary of the dab, so
    // softening the brush visibly shrinks the ring to match where ink lands.
    const hardness = getDrawHardness();
    const effScreenSize = screenSize * (0.5 + 0.5 * hardness);
    if (effScreenSize < 4) { brushCursorEl.style.display = 'none'; workspace.style.cursor = 'crosshair'; return; }
    workspace.style.cursor = 'none'; brushCursorEl.className = ''; brushCursorEl.style.display = 'block';
    brushCursorEl.style.background = 'transparent'; brushCursorEl.style.opacity = '1';
    brushCursorEl.style.width = effScreenSize + 'px'; brushCursorEl.style.height = effScreenSize + 'px';
    brushCursorEl.style.transform = `translate(${e.clientX - effScreenSize/2}px, ${e.clientY - effScreenSize/2}px)`;
  }
}

/* ═══════════════════════════════════════════════════════
   COPY / CUT / PASTE — Floating Selection System
   ═══════════════════════════════════════════════════════ */

function showPasteFlash() {
  if (!selectionPath) return;
  let flashAlpha = 0.35; const flashPath = selectionPath;
  const ox = floatingActive ? floatingOffset.x : 0; const oy = floatingActive ? floatingOffset.y : 0;
  function flashFrame() {
    flashAlpha -= 0.035; if (flashAlpha <= 0) { drawOverlay(); return; }
    drawOverlay();
    const offsetPath = new Path2D();
    offsetPath.addPath(flashPath, new DOMMatrix([1, 0, 0, 1, ox, oy]));
    const sp = pathToScreen(offsetPath);
    overlayCtx.save(); overlayCtx.globalAlpha = flashAlpha;
    overlayCtx.fillStyle = '#ffffff'; overlayCtx.fill(sp);
    overlayCtx.strokeStyle = 'rgba(0,0,0,0.25)'; overlayCtx.lineWidth = 2; overlayCtx.stroke(sp);
    overlayCtx.globalAlpha = 1; overlayCtx.restore(); requestAnimationFrame(flashFrame);
  }
  requestAnimationFrame(flashFrame);
}

/**
 * scanCanvasBounds — Single tight scan over the alpha channel returning the
 * non-transparent bounding box, or null if the canvas is fully transparent.
 * Replaces the in-place loops that doCopy/doPaste/writeToSystemClipboard each
 * used to run on the same buffer. One pass, no allocations beyond the
 * unavoidable getImageData call.
 */
function scanCanvasBounds(canvas) {
  const w = canvas.width, h = canvas.height;
  if (w === 0 || h === 0) return null;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * hashCanvasContent — Fast 32-bit FNV-1a-style hash mixing dimensions plus
 * up to 64 RGBA samples spread across the buffer. Used purely as a
 * "did this image come from us?" probe by the system-clipboard paste path
 * to detect an internal copy round-trip and preserve origin in that case.
 * Collisions are harmless: a false-positive only causes an external image
 * to inherit the previous internal-clipboard origin, a near-impossible
 * coincidence given that we also gate on exact width/height match.
 */
function hashCanvasContent(canvas) {
  const w = canvas.width, h = canvas.height;
  if (w === 0 || h === 0) return 0;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let hash = 0x811c9dc5;
  // Mix dimensions first so different sizes hash differently even when
  // sampled bytes happen to coincide.
  hash = ((hash ^ (w & 0xff)) * 0x01000193) >>> 0;
  hash = ((hash ^ ((w >>> 8) & 0xff)) * 0x01000193) >>> 0;
  hash = ((hash ^ (h & 0xff)) * 0x01000193) >>> 0;
  hash = ((hash ^ ((h >>> 8) & 0xff)) * 0x01000193) >>> 0;
  const totalPx = w * h;
  const sampleCount = Math.min(64, totalPx);
  for (let i = 0; i < sampleCount; i++) {
    // Spread sample positions evenly across the buffer.
    const px = Math.floor(((i + 0.5) / sampleCount) * totalPx);
    const idx = px * 4;
    hash = ((hash ^ data[idx])     * 0x01000193) >>> 0;
    hash = ((hash ^ data[idx + 1]) * 0x01000193) >>> 0;
    hash = ((hash ^ data[idx + 2]) * 0x01000193) >>> 0;
    hash = ((hash ^ data[idx + 3]) * 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * pasteCanvasInternal — Single canonical paste finalizer used by every entry
 * point (internal Ctrl+V via doPaste and the system-clipboard paste listener).
 *
 * Sequence:
 *   1. Commit any active pixel transform / floating selection so the paste
 *      lands cleanly on top of the user's prior committed work.
 *   2. Clamp the requested origin: if it would put the entire pasted image
 *      off-canvas (e.g. user shrank the doc between Copy and Paste), fall
 *      back to a centered origin.
 *   3. Stamp pixels onto the active layer and invalidate the snap cache.
 *   4. Build a rect selection wrapping the paste, switch to the Move tool,
 *      composite, and run the paste-flash animation.
 *   5. Push exactly one 'Paste' undo entry with the pxTransform-restore
 *      flag set, then enter Free Transform so the user can immediately
 *      reposition / scale. On undo this entry fully reverts; on redo it
 *      reapplies and re-engages Free Transform (Phase 9 contract).
 */
function pasteCanvasInternal(srcCanvas, originX, originY) {
  closeAllMenus();
  if (!srcCanvas || !srcCanvas.width || !srcCanvas.height) return;
  if (pxTransformActive) commitPixelTransform();
  if (floatingActive) commitFloating();
  const layer = getActiveLayer();
  if (!layer) return;

  const w = srcCanvas.width, h = srcCanvas.height;
  let px = Math.round(originX), py = Math.round(originY);
  // If the saved origin would put the entire paste off-canvas, center it
  // instead so the user can always see what they pasted.
  if (px + w <= 0 || py + h <= 0 || px >= canvasW || py >= canvasH) {
    px = Math.round((canvasW - w) / 2);
    py = Math.round((canvasH - h) / 2);
  }

  layer.ctx.drawImage(srcCanvas, px, py);
  SnapEngine.invalidateLayer(layer);

  selection = { type: 'rect', x: px, y: py, w, h };
  selectionFillRule = 'nonzero';
  selectionPath = new Path2D();
  selectionPath.rect(px, py, w, h);

  // Push the Paste undo BEFORE engaging the smart-object transform.
  // The history snapshot freezes the pristine stamped pixels (clipped at
  // canvas bounds); the live session then carries the FULL srcCanvas in
  // pxTransformData so off-canvas pixels survive drag/resize until commit.
  _pxTransformWasActiveForPush = true;
  pushUndo('Paste');

  engageSmartObjectTransform(srcCanvas, px, py);
  selectTool('move');
  compositeAll();
  drawOverlay();
  showPasteFlash();
}

function doCopy() {
  closeAllMenus();
  const layer = getActiveLayer();
  if (!layer) return;

  // Compose source pixels onto a canvas-sized scratch so the selection
  // clip lines up with layer coordinates, then trim to a tight crop.
  const scratch = document.createElement('canvas');
  scratch.width = canvasW; scratch.height = canvasH;
  const sctx = scratch.getContext('2d');
  if (floatingActive && floatingCanvas) {
    sctx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y);
  } else if (selectionPath && selection) {
    sctx.save();
    sctx.clip(selectionPath, selectionFillRule);
    sctx.drawImage(layer.canvas, 0, 0);
    sctx.restore();
  } else {
    sctx.drawImage(layer.canvas, 0, 0);
  }

  const b = scanCanvasBounds(scratch);
  if (!b) return; // nothing visible to copy — leave existing clipboard intact

  const trimmed = document.createElement('canvas');
  trimmed.width = b.w; trimmed.height = b.h;
  trimmed.getContext('2d').drawImage(scratch, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);

  clipboardCanvas = trimmed;
  clipboardOrigin = { x: b.x, y: b.y };
  clipboardSignature = hashCanvasContent(trimmed);

  // Mirror to the OS clipboard for external-app interop. Silent no-op on
  // file:// (Clipboard API requires a secure context).
  writeToSystemClipboard(trimmed);
}

/**
 * writeToSystemClipboard — Writes srcCanvas as a PNG blob to the OS clipboard.
 * The caller is responsible for trimming; doCopy already hands us a tight
 * crop, so this is a thin pass-through with the necessary user-activation
 * dance: pass a Promise<Blob> to ClipboardItem so navigator.clipboard.write()
 * itself executes synchronously within the keydown/click activation window
 * while the blob resolves asynchronously after that point (per spec).
 *
 * Silently no-ops on file:// (no secure context, ClipboardItem undefined) or
 * if the browser denies permission, preserving the internal clipboard as a
 * fallback for in-app paste.
 */
function writeToSystemClipboard(srcCanvas) {
  if (!navigator.clipboard || !navigator.clipboard.write) return;
  if (typeof ClipboardItem === 'undefined') return;
  try {
    const blobPromise = new Promise(resolve => srcCanvas.toBlob(resolve, 'image/png'));
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]).catch(() => {});
  } catch (e) { /* secure context unavailable or permission denied */ }
}

function doCut() {
  closeAllMenus(); if (!selectionPath && !floatingActive) return; doCopy();
  if (floatingActive) { floatingActive = false; floatingCanvas = null; floatingCtx = null; floatingOffset = {x:0, y:0}; }
  else if (selectionPath) { const layer = getActiveLayer(); if (layer) { layer.ctx.save(); layer.ctx.clip(selectionPath, selectionFillRule); layer.ctx.clearRect(0, 0, canvasW, canvasH); layer.ctx.restore(); SnapEngine.invalidateLayer(layer); } }
  compositeAll();
  pushUndo('Cut');
}

/**
 * doPaste — Edit > Paste menu entry point and round-trip helper for the
 * paste-event listener. Photoshop-fidelity behavior:
 *
 *  1. Try to async-read the OS clipboard. If it has an image, decode it,
 *     hash-compare against our internal clipboard:
 *       - Match -> internal round-trip (use internal canvas + saved origin
 *         so the pixels land back where they came from).
 *       - No match -> external image (centered).
 *  2. If the OS clipboard read fails (file://, no permission, no image),
 *     fall back to the internal clipboard with its saved origin.
 *
 * Async because navigator.clipboard.read() is async; all callers fire-and-
 * forget. Note that Ctrl+V does NOT call doPaste — the keyboard handler
 * lets the browser fire a synchronous `paste` event which is faster and
 * doesn't require navigator.clipboard.read permission. doPaste is the
 * fallback for menu clicks and for the round-trip branch in the paste
 * listener (which calls it knowing we'll just use the internal clipboard).
 */
async function doPaste() {
  closeAllMenus();
  if (navigator.clipboard && navigator.clipboard.read && typeof ClipboardItem !== 'undefined') {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const url = URL.createObjectURL(blob);
        const img = new Image();
        await new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
          img.src = url;
        });
        if (!img.naturalWidth) { URL.revokeObjectURL(url); break; }
        const w = img.naturalWidth, h = img.naturalHeight;
        const tc = document.createElement('canvas');
        tc.width = w; tc.height = h;
        tc.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        if (clipboardCanvas &&
            clipboardCanvas.width === w &&
            clipboardCanvas.height === h &&
            hashCanvasContent(tc) === clipboardSignature) {
          // Internal round-trip — preserve origin.
          pasteCanvasWithSizeCheck(clipboardCanvas, clipboardOrigin.x, clipboardOrigin.y);
        } else {
          // External image — center it.
          pasteCanvasWithSizeCheck(tc, Math.round((canvasW - w) / 2), Math.round((canvasH - h) / 2));
        }
        return;
      }
    } catch (e) { /* permission denied / no secure context — fall through */ }
  }
  // Fall back to internal clipboard.
  if (clipboardCanvas) {
    pasteCanvasWithSizeCheck(clipboardCanvas, clipboardOrigin.x, clipboardOrigin.y);
  }
}

/**
 * pasteCanvasWithSizeCheck — Paste entry-point that gates oversized images
 * through the Image-Larger-Than-Canvas chooser. Both internal (Ctrl+V round-
 * trip) and external (clipboard / drag-drop) paste paths route through here
 * so the prompt fires consistently.
 *
 *  • Expand → grow canvas to fit (TL anchor) and stamp the image at (0,0).
 *  • Keep   → stamp at the requested origin (clipped where it extends past
 *             the canvas — same as the prior paste behavior).
 *  • Cancel → no-op.
 */
async function pasteCanvasWithSizeCheck(srcCanvas, originX, originY) {
  if (!srcCanvas || !srcCanvas.width || !srcCanvas.height) return;
  const w = srcCanvas.width, h = srcCanvas.height;
  if (w > canvasW || h > canvasH) {
    const choice = await openImportSizeDialog(w, h);
    if (choice === 'cancel') return;
    if (choice === 'expand') {
      expandCanvasToFit(w, h);
      zoomFit();
      updateStatus();
      pasteCanvasInternal(srcCanvas, 0, 0);
      return;
    }
  }
  pasteCanvasInternal(srcCanvas, originX, originY);
}

/**
 * Paste event listener — Unified handler for Ctrl+V and browser context-menu
 * paste. Bridges three sources:
 *
 *  1. System clipboard with image data, MATCHING our internal clipboard
 *     (Opsin Copy -> OS clipboard -> Opsin Paste round-trip). Detected by
 *     comparing dimensions and a fast content hash. Routed to
 *     pasteCanvasInternal with the internal canvas + saved origin so the
 *     pixels land back where they came from. Without this branch the
 *     round-trip would re-center the pasted pixels and lose their position.
 *
 *  2. System clipboard with image data from an external source. Routed to
 *     pasteCanvasInternal with a centered origin (no internal origin to
 *     preserve). Works on both file:// and HTTPS because it reads from the
 *     synchronous clipboardData rather than the async Clipboard API.
 *
 *  3. No system-clipboard image, but internal clipboardCanvas exists. Falls
 *     through to doPaste() (covers file:// where the OS clipboard write was
 *     suppressed but the user just performed an internal Copy).
 *
 * Text inputs / textareas / contenteditable are excluded so normal text
 * paste in the UI stays unaffected.
 */
document.addEventListener('paste', (e) => {
  const tgt = e.target;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;

  const items = e.clipboardData && e.clipboardData.items;
  if (items) {
    for (const item of items) {
      if (!item.type || !item.type.startsWith('image/')) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        const tc = document.createElement('canvas');
        tc.width = w; tc.height = h;
        tc.getContext('2d').drawImage(img, 0, 0);
        // Round-trip detection: identical dimensions + matching content hash
        // means this image just came from our own doCopy. Use the internal
        // canvas + saved origin so the pasted pixels land back where they
        // came from. Direct call (not via doPaste) to skip the redundant
        // navigator.clipboard.read round-trip.
        if (clipboardCanvas &&
            clipboardCanvas.width === w &&
            clipboardCanvas.height === h &&
            hashCanvasContent(tc) === clipboardSignature) {
          pasteCanvasWithSizeCheck(clipboardCanvas, clipboardOrigin.x, clipboardOrigin.y);
        } else {
          // External image — drop it centered.
          pasteCanvasWithSizeCheck(tc, Math.round((canvasW - w) / 2), Math.round((canvasH - h) / 2));
        }
        URL.revokeObjectURL(url);
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
      return;
    }
  }
  // No system-clipboard image — fall back to internal clipboard.
  if (clipboardCanvas) { e.preventDefault(); doPaste(); }
});

/* ═══════════════════════════════════════════════════════
   IMAGE RESIZE
   ═══════════════════════════════════════════════════════ */

let resizeAspect = 1;
function openResizeDialog() { closeAllMenus(); document.getElementById('resizeW').value = canvasW; document.getElementById('resizeH').value = canvasH; resizeAspect = canvasW / canvasH; document.getElementById('resizeImageModal').classList.add('show'); }
document.getElementById('resizeW').addEventListener('input', function() { if (document.getElementById('resizeConstrain').checked) document.getElementById('resizeH').value = Math.round(this.value / resizeAspect); });
document.getElementById('resizeH').addEventListener('input', function() { if (document.getElementById('resizeConstrain').checked) document.getElementById('resizeW').value = Math.round(this.value * resizeAspect); });

function applyResizeImage() {
  const newW = parseInt(document.getElementById('resizeW').value) || canvasW; const newH = parseInt(document.getElementById('resizeH').value) || canvasH;
  if (newW === canvasW && newH === canvasH) { closeModal('resizeImageModal'); return; }
  layers.forEach(l => { const temp = document.createElement('canvas'); temp.width = newW; temp.height = newH; const tctx = temp.getContext('2d'); tctx.drawImage(l.canvas, 0, 0, canvasW, canvasH, 0, 0, newW, newH); l.canvas.width = newW; l.canvas.height = newH; l.ctx = l.canvas.getContext('2d', { willReadFrequently: true }); l.ctx.drawImage(temp, 0, 0); });
  canvasW = newW; canvasH = newH; compositeCanvas.width = newW; compositeCanvas.height = newH; overlayCanvas.width = newW; overlayCanvas.height = newH;
  canvasWrapper.style.width = newW + 'px'; canvasWrapper.style.height = newH + 'px'; checkerPattern = null;
  clearSelection(); zoomFit(); compositeAll(); updateLayerPanel(); updateStatus(); closeModal('resizeImageModal');
  pushUndo('Resize');
}

/* ═══════════════════════════════════════════════════════
   CANVAS SIZE
   ═══════════════════════════════════════════════════════ */

let canvasAnchor = 'mc';
function openCanvasSizeDialog() { closeAllMenus(); document.getElementById('canvasSizeW').value = canvasW; document.getElementById('canvasSizeH').value = canvasH; canvasAnchor = 'mc'; document.querySelectorAll('.anchor-btn').forEach(b => b.classList.toggle('active', b.dataset.anchor === 'mc')); document.getElementById('canvasSizeModal').classList.add('show'); }
document.querySelectorAll('.anchor-btn').forEach(btn => { btn.addEventListener('click', () => { canvasAnchor = btn.dataset.anchor; document.querySelectorAll('.anchor-btn').forEach(b => b.classList.toggle('active', b.dataset.anchor === canvasAnchor)); }); });

function applyCanvasSize() {
  const newW = parseInt(document.getElementById('canvasSizeW').value) || canvasW; const newH = parseInt(document.getElementById('canvasSizeH').value) || canvasH;
  if (newW === canvasW && newH === canvasH) { closeModal('canvasSizeModal'); return; }
  let ox = 0, oy = 0;
  if (canvasAnchor.includes('c')) ox = Math.round((newW - canvasW) / 2);
  if (canvasAnchor.includes('r')) ox = newW - canvasW;
  if (canvasAnchor.includes('m') && !canvasAnchor.includes('l') && !canvasAnchor.includes('r')) ox = Math.round((newW - canvasW) / 2);
  if (canvasAnchor[0] === 'm') oy = Math.round((newH - canvasH) / 2);
  if (canvasAnchor[0] === 'b') oy = newH - canvasH;
  layers.forEach(l => { const temp = document.createElement('canvas'); temp.width = newW; temp.height = newH; const tctx = temp.getContext('2d'); tctx.drawImage(l.canvas, ox, oy); l.canvas.width = newW; l.canvas.height = newH; l.ctx = l.canvas.getContext('2d', { willReadFrequently: true }); l.ctx.drawImage(temp, 0, 0); });
  canvasW = newW; canvasH = newH; compositeCanvas.width = newW; compositeCanvas.height = newH; overlayCanvas.width = newW; overlayCanvas.height = newH;
  canvasWrapper.style.width = newW + 'px'; canvasWrapper.style.height = newH + 'px'; checkerPattern = null;
  clearSelection(); zoomFit(); compositeAll(); updateLayerPanel(); updateStatus(); closeModal('canvasSizeModal');
  pushUndo('Canvas Size');
}

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

  if (currentTool === 'move') {
    if (pxTransformActive && pxTransformData) {
      const cb = pxTransformData.curBounds;
      bounds = { x: Math.round(cb.x), y: Math.round(cb.y), w: Math.round(cb.w), h: Math.round(cb.h) };
      editable = true;
    } else if (floatingActive && floatingCanvas) {
      bounds = { x: Math.round(floatingOffset.x), y: Math.round(floatingOffset.y), w: floatingCanvas.width, h: floatingCanvas.height };
      editable = true;
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
    rotIn.disabled = !transformable;
    if (!transformable && focused !== rotIn) rotIn.value = 0;
  }
  if (flipH) flipH.disabled = !transformable;
  if (flipV) flipV.disabled = !transformable;
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
    const angle = parseInt(rotIn.value);
    if (isNaN(angle) || angle === 0) { rotIn.value = 0; return; }
    if (currentTool === 'move' && pxTransformActive && pxTransformData) {
      propsRotatePixelTransform(angle);
    } else if (currentTool === 'movesel' && selection) {
      propsRotateSelection(angle);
    }
    rotIn.value = 0;
  });
  rotIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') rotIn.blur(); });

  // Flip buttons
  document.getElementById('propFlipH').addEventListener('click', () => {
    if (currentTool === 'move' && pxTransformActive) propsFlipPixelTransform('h');
    else if (currentTool === 'movesel' && selection) propsFlipSelection('h');
  });
  document.getElementById('propFlipV').addEventListener('click', () => {
    if (currentTool === 'move' && pxTransformActive) propsFlipPixelTransform('v');
    else if (currentTool === 'movesel' && selection) propsFlipSelection('v');
  });

  // Alignment bar — Photoshop-style 6-axis alignment
  document.querySelectorAll('.props-align-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const align = btn.dataset.align;
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
