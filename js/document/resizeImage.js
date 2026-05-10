/* ═══════════════════════════════════════════════════════
   IMAGE RESIZE — dialog, aspect-ratio constraint, and
   Lanczos-3 high-quality pixel resampler.

   Depends on globals from script.js:
     canvasW, canvasH, layers, compositeCanvas, overlayCanvas,
     canvasWrapper, checkerPattern, closeAllMenus, closeModal,
     clearSelection, zoomFit, compositeAll, updateLayerPanel,
     updateStatus, pushUndo
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

/* ── Resize Image Dialog & Apply ─────────────────────── */

let resizeAspect = 1;
let resizeDimLocked = true;
function openResizeDialog() {
  closeAllMenus();
  document.getElementById('resizeW').value = canvasW;
  document.getElementById('resizeH').value = canvasH;
  resizeAspect = canvasW / canvasH;
  document.getElementById('resizeImageModal').classList.add('show');
}
(function wireResizeDim() {
  const wInp = document.getElementById('resizeW');
  const hInp = document.getElementById('resizeH');
  const lockBtn = document.getElementById('resizeDimLock');
  if (!wInp || !hInp || !lockBtn) return;
  let suppress = false;
  wInp.addEventListener('input', () => {
    if (suppress || !resizeDimLocked) return;
    const v = parseFloat(wInp.value);
    if (!v || v < 1) return;
    suppress = true;
    hInp.value = Math.max(1, Math.round(v / resizeAspect));
    suppress = false;
  });
  hInp.addEventListener('input', () => {
    if (suppress || !resizeDimLocked) return;
    const v = parseFloat(hInp.value);
    if (!v || v < 1) return;
    suppress = true;
    wInp.value = Math.max(1, Math.round(v * resizeAspect));
    suppress = false;
  });
  lockBtn.addEventListener('click', () => {
    resizeDimLocked = !resizeDimLocked;
    lockBtn.classList.toggle('locked', resizeDimLocked);
    const useEl = lockBtn.querySelector('svg use');
    useEl.setAttribute('href', resizeDimLocked ? '#icon-chain-linked' : '#icon-chain-unlinked');
    if (resizeDimLocked) {
      const w = parseFloat(wInp.value) || 1;
      const h = parseFloat(hInp.value) || 1;
      resizeAspect = w / h;
    }
  });
})();

function applyResizeImage() {
  const newW = parseInt(document.getElementById('resizeW').value) || canvasW; const newH = parseInt(document.getElementById('resizeH').value) || canvasH;
  if (newW === canvasW && newH === canvasH) { closeModal('resizeImageModal'); return; }
  layers.forEach(l => { const temp = document.createElement('canvas'); temp.width = newW; temp.height = newH; const tctx = temp.getContext('2d'); tctx.drawImage(l.canvas, 0, 0, canvasW, canvasH, 0, 0, newW, newH); l.canvas.width = newW; l.canvas.height = newH; l.ctx = l.canvas.getContext('2d', { willReadFrequently: true }); l.ctx.drawImage(temp, 0, 0); });
  canvasW = newW; canvasH = newH; compositeCanvas.width = newW; compositeCanvas.height = newH; overlayCanvas.width = newW; overlayCanvas.height = newH;
  canvasWrapper.style.width = newW + 'px'; canvasWrapper.style.height = newH + 'px'; checkerPattern = null;
  clearSelection(); zoomFit(); compositeAll(); updateLayerPanel(); updateStatus(); closeModal('resizeImageModal');
  pushUndo('Resize');
}
