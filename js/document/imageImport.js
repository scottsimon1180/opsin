"use strict";

/* ═══════════════════════════════════════════════════════
   IMAGE IMPORT — file decoding, import-as-layer, batch
   drop, and trigger helpers.

   Depends on globals available at call time (not parse time):
     js/core/config.js       — RASTER_MIME_TYPES
     js/core/state.js        — canvasW, canvasH, layers,
                               activeLayerIndex, selectedLayers,
                               layerIdCounter, pxTransformActive,
                               floatingActive
     js/core/rendering.js    — compositeAll
     js/document/layers.js   — updateLayerPanel
     js/document/layerTransforms.js — commitPixelTransform,
                               placeImageAsTransformLayer
     js/script.js            — commitFloating, openImportSizeDialog,
                               expandCanvasToFit, pushUndo,
                               zoomFit, updateStatus, SnapEngine
   ═══════════════════════════════════════════════════════ */

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
