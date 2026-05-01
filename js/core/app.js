"use strict";

/* ═══════════════════════════════════════════════════════
   APP — startup orchestration
   Loaded last; all globals (selectTool, initHistoryEngine,
   SnapEngine, window.IEM, etc.) are defined before this runs.
   ═══════════════════════════════════════════════════════ */

function init() {
  initHistoryEngine();
  initCanvas(1920, 1080, 'white');
  selectTool('move');
  updateColorUI();
  initPropertiesPanel();
  initMoveToolOptions();
  document.getElementById('selectToolBtn').innerHTML = RECT_SELECT_SVG;
  SnapEngine.syncMenuCheck();
  // PWA File Handling API — must register after app is ready so consumer fires after init
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams.files || !launchParams.files.length) return;
      const fileHandle = launchParams.files[0];
      const file = await fileHandle.getFile();
      if (window.IEM && window.IEM.isIcoFile && window.IEM.isIcoFile(file)) {
        window.IEM.handleOpenIco(file); return;
      }
      const reader = new FileReader();
      reader.onload = function(ev) {
        const img = new Image();
        img.onload = function() {
          initCanvas(img.width, img.height, 'transparent');
          layers[0].ctx.drawImage(img, 0, 0);
          layers[0].name = file.name.replace(/\.[^.]+$/, '');
          compositeAll(); updateLayerPanel();
          if (typeof History !== 'undefined' && History) History.reset();
          pushUndo('Open Image');
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
}

window.addEventListener('load', init);
