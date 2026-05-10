"use strict";

/* ══════════════════════════════════════════════════════════════════════
   Opsin — WebP Export
   ══════════════════════════════════════════════════════════════════════
   Composites all visible layers and triggers a WebP download at
   quality 0.92.
   Depends on globals from script.js: closeAllMenus, canvasW, canvasH,
   layers, activeLayerIndex, floatingActive, floatingCanvas, floatingOffset.
   ══════════════════════════════════════════════════════════════════════ */

function saveWebP() {
  closeAllMenus();
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
  exportCanvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'image.webp'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/webp', 0.92);
}
