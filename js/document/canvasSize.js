/* ═══════════════════════════════════════════════════════
   CANVAS SIZE
   ═══════════════════════════════════════════════════════ */

let canvasAnchor = 'mc';
let canvasSizeAspect = 1;
let canvasSizeDimLocked = false;
function openCanvasSizeDialog() {
  closeAllMenus();
  document.getElementById('canvasSizeW').value = canvasW;
  document.getElementById('canvasSizeH').value = canvasH;
  canvasSizeAspect = canvasW / canvasH;
  canvasAnchor = 'mc';
  document.querySelectorAll('.anchor-btn').forEach(b => b.classList.toggle('active', b.dataset.anchor === 'mc'));
  document.getElementById('canvasSizeModal').classList.add('show');
}
document.querySelectorAll('.anchor-btn').forEach(btn => { btn.addEventListener('click', () => { canvasAnchor = btn.dataset.anchor; document.querySelectorAll('.anchor-btn').forEach(b => b.classList.toggle('active', b.dataset.anchor === canvasAnchor)); }); });

(function wireCanvasSizeDim() {
  const wInp = document.getElementById('canvasSizeW');
  const hInp = document.getElementById('canvasSizeH');
  const lockBtn = document.getElementById('canvasSizeDimLock');
  if (!wInp || !hInp || !lockBtn) return;
  let suppress = false;
  wInp.addEventListener('input', () => {
    if (suppress || !canvasSizeDimLocked) return;
    const v = parseFloat(wInp.value);
    if (!v || v < 1) return;
    suppress = true;
    hInp.value = Math.max(1, Math.round(v / canvasSizeAspect));
    suppress = false;
  });
  hInp.addEventListener('input', () => {
    if (suppress || !canvasSizeDimLocked) return;
    const v = parseFloat(hInp.value);
    if (!v || v < 1) return;
    suppress = true;
    wInp.value = Math.max(1, Math.round(v * canvasSizeAspect));
    suppress = false;
  });
  lockBtn.addEventListener('click', () => {
    canvasSizeDimLocked = !canvasSizeDimLocked;
    lockBtn.classList.toggle('locked', canvasSizeDimLocked);
    const useEl = lockBtn.querySelector('svg use');
    useEl.setAttribute('href', canvasSizeDimLocked ? '#icon-chain-linked' : '#icon-chain-unlinked');
    if (canvasSizeDimLocked) {
      const w = parseFloat(wInp.value) || 1;
      const h = parseFloat(hInp.value) || 1;
      canvasSizeAspect = w / h;
    }
  });
})();

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
