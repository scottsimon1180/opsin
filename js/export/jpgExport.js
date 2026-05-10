"use strict";

/* ══════════════════════════════════════════════════════════════════════
   Opsin — JPG Export
   ══════════════════════════════════════════════════════════════════════
   Composites all visible layers onto a white background and triggers a
   JPEG download at quality 0.92.
   Depends on globals from script.js: closeAllMenus, canvasW, canvasH,
   layers, activeLayerIndex, floatingActive, floatingCanvas, floatingOffset.
   ══════════════════════════════════════════════════════════════════════ */

function saveJpg() {
  closeAllMenus();
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = canvasW; exportCanvas.height = canvasH;
  const ectx = exportCanvas.getContext('2d');
  ectx.fillStyle = '#ffffff';
  ectx.fillRect(0, 0, canvasW, canvasH);
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
    a.href = url; a.download = 'image.jpg'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/jpeg', 0.92);
}
