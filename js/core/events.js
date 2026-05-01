"use strict";

/* ═══════════════════════════════════════════════════════
   EVENTS — application-level event listener setup
   Loaded after script.js and rendering.js; all referenced
   globals are defined before first call.
   ═══════════════════════════════════════════════════════ */

// ── Workspace wheel zoom ──────────────────────────────────────────────────────

workspace.addEventListener('wheel', (e) => {
  e.preventDefault();
  const wsRect = workspace.getBoundingClientRect();
  const cx = e.clientX - wsRect.left;
  const cy = e.clientY - wsRect.top;
  const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
  zoomTo(zoom * factor, cx, cy);
}, { passive: false });

// ── Core workspace mouse routing ──────────────────────────────────────────────

workspace.addEventListener('mousedown', onMouseDown);
workspace.addEventListener('mousemove', onMouseMove);
workspace.addEventListener('mouseup', onMouseUp);
workspace.addEventListener('mouseleave', onMouseUp);
workspace.addEventListener('dblclick', onDblClick);
workspace.addEventListener('contextmenu', function(e) {
  if (currentTool === 'gradient' && gradActive) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    const hit = gradHitTest(pos.x, pos.y);
    if (hit && hit.type === 'stop' && hit.index > 0 && hit.index < gradStops.length - 1) {
      e.preventDefault();
      showGradStopCtx(hit.index, e.clientX, e.clientY);
      return;
    }
  }
});
document.addEventListener('mousedown', function(e) {
  const menu = document.getElementById('gradStopCtx');
  if (menu && menu.classList.contains('active') && !menu.contains(e.target)) hideGradStopCtx();
});

// ── File open ─────────────────────────────────────────────────────────────────

document.getElementById('fileInput').addEventListener('change', function(e) {
  const file = e.target.files[0]; if (!file) return;
  // .ico files route into Icon Editor Mode (or PNG-import via choice modal)
  if (window.IEM && window.IEM.isIcoFile && window.IEM.isIcoFile(file)) {
    window.IEM.handleOpenIco(file);
    this.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = function(ev) {
    const img = new Image();
    img.onload = function() {
      initCanvas(img.width, img.height, 'transparent');
      layers[0].ctx.drawImage(img, 0, 0);
      layers[0].name = file.name.replace(/\.[^.]+$/, '');
      compositeAll(); updateLayerPanel();
      // initCanvas already reset + recorded 'New Image'; replace that anchor
      // with the actual opened-file state by resetting and recording fresh.
      if (typeof History !== 'undefined' && History) History.reset();
      pushUndo('Open Image');
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file); this.value = '';
});

// ── Import layer + drag-and-drop ──────────────────────────────────────────────

document.getElementById('importLayerInput').addEventListener('change', async function() { if (!this.files || this.files.length === 0) return; await importFilesAsLayers(this.files); this.value = ''; });

let _dragCounter = 0;
function _hasImageFiles(dataTransfer) { if (!dataTransfer) return false; if (dataTransfer.items && dataTransfer.items.length) return Array.from(dataTransfer.items).some(item => item.kind === 'file' && (RASTER_MIME_TYPES.has(item.type.toLowerCase()) || ICO_MIME_TYPES.has(item.type.toLowerCase()))); return dataTransfer.types && dataTransfer.types.includes('Files'); }
workspace.addEventListener('dragenter', (e) => { if (!_hasImageFiles(e.dataTransfer)) return; e.preventDefault(); _dragCounter++; document.getElementById('dropOverlay').classList.add('visible'); });
workspace.addEventListener('dragover', (e) => { if (!_hasImageFiles(e.dataTransfer)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
workspace.addEventListener('dragleave', (e) => { _dragCounter--; if (_dragCounter <= 0) { _dragCounter = 0; document.getElementById('dropOverlay').classList.remove('visible'); } });
workspace.addEventListener('drop', async (e) => { e.preventDefault(); _dragCounter = 0; document.getElementById('dropOverlay').classList.remove('visible'); const files = e.dataTransfer && e.dataTransfer.files; if (!files || files.length === 0) return; if (window.IEM && window.IEM.handleDroppedFiles && window.IEM.handleDroppedFiles(files)) return; await importFilesAsLayers(files); });

// ── Menu bar event routing ────────────────────────────────────────────────────

let openMenuId = null;
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', function(e) { e.stopPropagation(); const menuId = 'menu-' + this.dataset.menu; if (openMenuId === menuId) { closeAllMenus(); return; } closeAllMenus(); document.getElementById(menuId).classList.add('show'); this.classList.add('open'); openMenuId = menuId; });
  item.addEventListener('mouseenter', function() { if (openMenuId) { closeAllMenus(); const menuId = 'menu-' + this.dataset.menu; document.getElementById(menuId).classList.add('show'); this.classList.add('open'); openMenuId = menuId; } });
  item.addEventListener('mouseleave', function(e) { if (openMenuId && (!e.relatedTarget || !e.relatedTarget.closest('.menu-item'))) closeAllMenus(); });
});
document.querySelectorAll('.menu-action:not(.menu-has-submenu)').forEach(btn => { btn.addEventListener('click', () => closeAllMenus()); });
document.addEventListener('click', (e) => { if (openMenuId && !e.target.closest('.menu-item')) closeAllMenus(); });
document.querySelectorAll('.modal-overlay').forEach(modal => { if (modal.id === 'settingsModal') return; modal.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); }); });

/* ═══════════════════════════════════════════════════════
   SPACE BAR PAN
   ═══════════════════════════════════════════════════════ */

let spaceDown = false;
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !spaceDown && !e.target.matches('input,select,textarea')) { spaceDown = true; workspace.style.cursor = 'grab'; e.preventDefault(); } });
document.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; workspace.style.cursor = getToolCursor(); } });

// ── Brush cursor routing ──────────────────────────────────────────────────────

workspace.addEventListener('mousemove', updateBrushCursor);
workspace.addEventListener('mouseleave', () => { brushCursorEl.style.display = 'none'; rulerMouseX = -1; rulerMouseY = -1; if (rulersVisible) drawRulers(); });

// ── Window resize ─────────────────────────────────────────────────────────────

window.addEventListener('resize', () => { _wsRectCache = null; if (isFitMode) { zoomFit(); } else { centerCanvas(); drawRulers(); drawGuides(); drawUIOverlay(); } });
