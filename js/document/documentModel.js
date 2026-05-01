"use strict";

/* ═══════════════════════════════════════════════════════
   DOCUMENT MODEL — document initialization, creation, and
   history-engine wiring. Loaded after script.js so all
   referenced globals (addLayer, compositeAll, pushUndo,
   setHostLayers, etc.) are in scope at call time.
   ═══════════════════════════════════════════════════════ */

// Default brush radius scales with the image so stroke appears roughly the
// same physical size at fit-to-screen zoom. Calibrated: 1920×1080→50, 3840×2160→100.
function computeDefaultBrushSize(w, h) {
  const d = Math.hypot(w, h) / 44.1;
  return Math.max(1, Math.min(500, Math.round(d)));
}

function initCanvas(w, h, bg) {
  if (window.IEM && window.IEM.active) window.IEM.exitIfActive();
  canvasW = w; canvasH = h;
  if (typeof drawSettings !== 'undefined') {
    const defSize = computeDefaultBrushSize(w, h);
    drawSettings.brush.size = defSize;
    drawSettings.eraser.size = defSize;
    if (currentTool === 'brush' || currentTool === 'eraser') loadDrawSettings(currentTool);
  }
  compositeCanvas.width = w;
  compositeCanvas.height = h;
  overlayCanvas.width = w;
  overlayCanvas.height = h;
  canvasWrapper.style.width = w + 'px';
  canvasWrapper.style.height = h + 'px';

  layers = [];
  activeLayerIndex = 0;
  selectedLayers = new Set([0]);
  layerIdCounter = 1;
  if (typeof History !== 'undefined' && History) History.reset();
  selection = null;
  selectionPath = null;
  checkerPattern = null;
  selectionMask = null;
  selectionMaskCtx = null;
  floatingActive = false;
  floatingCanvas = null;
  floatingCtx = null;
  floatingOffset = {x:0, y:0};
  floatingSelectionData = null;
  strokeBuffer = null;
  strokeBufferCtx = null;
  gradActive = false;
  gradP1 = null;
  gradP2 = null;
  gradStops = [];
  gradDragging = null;
  gradBaseSnapshot = null;
  gradDragStartPos = null;
  gradStopAboutToDelete = false;
  gradColorPickerMode = false;
  gradColorTarget = null;
  isDrawing = false;
  isMovingPixels = false;
  isPanning = false;
  transformSelActive = false;
  transformHandleDrag = null;
  isDrawingSelection = false;
  drawingPreviewPath = null;
  polyPoints = [];
  lassoPoints = [];
  pxTransformActive = false;
  pxTransformData = null;
  pxTransformHandle = null;
  pxTransformStartMouse = null;
  pxTransformOrigBounds = null;
  guides = [];
  guideIdCounter = 0;
  selectedGuide = null;
  draggingGuide = null;
  rulerState = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
  rulerDrag = null;

  addLayer('Background', true);
  if (bg === 'white') {
    const ctx = layers[0].ctx;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  } else if (bg === 'black') {
    const ctx = layers[0].ctx;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);
  }

  zoomFit();
  compositeAll();
  updateLayerPanel();
  pushUndo('New Image');
  updateStatus();
}

/**
 * Bind the History engine to this host application. Must be called once
 * during application init, before any History.record() calls.
 */
function initHistoryEngine() {
  if (typeof History === 'undefined' || !History) return;
  History.init({
    maxBytes: HISTORY_MAX_BYTES,
    onUpdate: updateHistoryPanel,
    host: {
      getLayers:            () => layers,
      getActiveLayerIndex:  () => activeLayerIndex,
      getCanvasW:           () => canvasW,
      getCanvasH:           () => canvasH,
      setLayers:            setHostLayers,
      setCanvasSize:        setHostCanvasSize,
      createLayerCanvas:    createBlankLayerCanvas,
      captureSelection:     captureHostSelection,
      restoreSelection:     restoreHostSelection,
      captureGradient:      captureHostGradient,
      restoreGradient:      restoreHostGradient,
      afterRestore:         afterHostRestore
    }
  });
}

// Legacy alias so any lingering historyManager.* references keep working.
const historyManager = {
  reset:    () => History.reset(),
  undo:     () => doUndo(),
  redo:     () => doRedo(),
  jumpTo:   (i) => History.jumpTo(i),
  getTimeline: () => History.getTimeline(),
  getCursor:   () => History.getCursor(),
  canUndo:     () => History.canUndo(),
  canRedo:     () => History.canRedo()
};

/* ═══════════════════════════════════════════════════════
   NEW IMAGE / OPEN FILE
   ═══════════════════════════════════════════════════════ */

function newImage() {
  closeAllMenus();
  document.getElementById('newImageModal').classList.add('show');
  syncNewImagePresetActive();
  // Probe the system clipboard for image dimensions to pre-fill the dialog,
  // matching professional editors where clipboard content defines new document
  // size. Uses the async Clipboard API — requires secure context (HTTPS).
  // Fails silently on file:// or permission denial; defaults remain as-is.
  probeClipboardDimensions();
}

function syncNewImagePresetActive() {
  const w = parseInt(document.getElementById('newWidth').value, 10);
  const h = parseInt(document.getElementById('newHeight').value, 10);
  document.querySelectorAll('#newImagePresets .preset-chip').forEach(chip => {
    const cw = parseInt(chip.dataset.w, 10);
    const ch = parseInt(chip.dataset.h, 10);
    chip.classList.toggle('active', cw === w && ch === h);
  });
}

(function initNewImagePresets() {
  const wire = () => {
    const presets = document.getElementById('newImagePresets');
    const wIn = document.getElementById('newWidth');
    const hIn = document.getElementById('newHeight');
    const lockBtn = document.getElementById('newDimLock');
    if (!presets || !wIn || !hIn || !lockBtn) return;
    let newImageDimLocked = true;
    let newImageDimRatio = 1920 / 1080;

    presets.addEventListener('click', e => {
      const chip = e.target.closest('.preset-chip');
      if (!chip) return;
      wIn.value = chip.dataset.w;
      hIn.value = chip.dataset.h;
      newImageDimRatio = parseInt(chip.dataset.w, 10) / parseInt(chip.dataset.h, 10);
      syncNewImagePresetActive();
    });

    let suppressLink = false;
    const linkFrom = (src, dst) => {
      if (suppressLink || !newImageDimLocked) return;
      const v = parseInt(src.value, 10);
      if (!v || v < 1) return;
      suppressLink = true;
      const ratio = src === wIn ? newImageDimRatio : 1 / newImageDimRatio;
      dst.value = Math.max(1, Math.round(v / ratio));
      suppressLink = false;
      syncNewImagePresetActive();
    };
    wIn.addEventListener('input', () => { linkFrom(wIn, hIn); syncNewImagePresetActive(); });
    hIn.addEventListener('input', () => { linkFrom(hIn, wIn); syncNewImagePresetActive(); });

    lockBtn.addEventListener('click', () => {
      newImageDimLocked = !newImageDimLocked;
      lockBtn.classList.toggle('locked', newImageDimLocked);
      const useEl = lockBtn.querySelector('svg use');
      useEl.setAttribute('href', newImageDimLocked ? '#icon-chain-linked' : '#icon-chain-unlinked');
      if (newImageDimLocked) {
        const w = parseInt(wIn.value, 10) || 1;
        const h = parseInt(hIn.value, 10) || 1;
        newImageDimRatio = w / h;
      }
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

/**
 * probeClipboardDimensions — Reads the system clipboard via the async Clipboard
 * API (navigator.clipboard.read) looking for image data. If found, decodes it
 * into an Image to extract natural dimensions and populates the New Image
 * dialog's width/height fields. Called when the New Image modal opens.
 *
 * This is async and non-blocking: the modal appears instantly with defaults
 * (1920x1080), and if a clipboard image is detected the fields update shortly
 * after (typically < 100ms). Silent no-op when the API is unavailable.
 */
async function probeClipboardDimensions() {
  try {
    if (!navigator.clipboard || !navigator.clipboard.read) return;
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find(t => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        const img = new Image();
        img.onload = () => {
          document.getElementById('newWidth').value = img.naturalWidth || img.width;
          document.getElementById('newHeight').value = img.naturalHeight || img.height;
          syncNewImagePresetActive();
          URL.revokeObjectURL(img.src);
        };
        img.src = URL.createObjectURL(blob);
        return;
      }
    }
  } catch (e) { /* Clipboard API unavailable or permission denied */ }
}

function createNewImage() {
  const w = parseInt(document.getElementById('newWidth').value) || 1920; const h = parseInt(document.getElementById('newHeight').value) || 1080;
  const bg = document.getElementById('newBg').value; initCanvas(w, h, bg); closeModal('newImageModal');
}

function openImage() { closeAllMenus(); document.getElementById('fileInput').click(); }
