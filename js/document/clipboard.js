"use strict";

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
