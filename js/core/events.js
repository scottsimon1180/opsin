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
  // Shape tool: suppress browser menu over a hit shape so the in-app
  // arrange/duplicate/delete menu can show. (Shape tool's own mouseDown
  // handler creates the menu; we only need to swallow the default.)
  if (currentTool === 'shape' && window.ShapeTool) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    // Cheap probe: if any shape on any visible shape layer contains the
    // pointer, suppress the default menu.
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (!l || !l.visible || l.kind !== 'shape' || !l.shapeModel) continue;
      const arr = l.shapeModel.shapes;
      for (let j = arr.length - 1; j >= 0; j--) {
        const s = arr[j];
        const bbox = s.type === 'line'
          ? { x: Math.min(s.p1.x, s.p2.x) - 4, y: Math.min(s.p1.y, s.p2.y) - 4,
              w: Math.abs(s.p2.x - s.p1.x) + 8, h: Math.abs(s.p2.y - s.p1.y) + 8 }
          : { x: s.x - 4, y: s.y - 4, w: s.w + 8, h: s.h + 8 };
        if (pos.x >= bbox.x && pos.x <= bbox.x + bbox.w &&
            pos.y >= bbox.y && pos.y <= bbox.y + bbox.h) {
          e.preventDefault();
          return;
        }
      }
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
let _submenuCloseTimer = null;
const SUBMENU_CLOSE_DELAY = 400;

function _clearMenuSubmenuTimer() {
  if (_submenuCloseTimer !== null) { clearTimeout(_submenuCloseTimer); _submenuCloseTimer = null; }
}
window._clearMenuSubmenuTimer = _clearMenuSubmenuTimer;

function _scheduleSubmenuClose(parent) {
  _clearMenuSubmenuTimer();
  _submenuCloseTimer = setTimeout(() => { parent.classList.remove('submenu-open'); _submenuCloseTimer = null; }, SUBMENU_CLOSE_DELAY);
}

// Tabs: click toggles the dropdown; hover only switches when a *different*
// menu is already open. Mouseleave never closes — the user must click another
// tab, click outside, or click the same tab again to dismiss.
document.querySelectorAll('.menu-item').forEach(item => {
  item.addEventListener('click', function(e) {
    e.stopPropagation();
    // Clicks from inside the dropdown bubble up here — ignore them so that
    // a menu-action closing the menu doesn't cause the tab to reopen it.
    if (e.target.closest('.menu-dropdown')) return;
    const menuId = 'menu-' + this.dataset.menu;
    if (openMenuId === menuId) { closeAllMenus(); return; }
    closeAllMenus();
    document.getElementById(menuId).classList.add('show');
    this.classList.add('open');
    openMenuId = menuId;
  });
  item.addEventListener('mouseenter', function() {
    const menuId = 'menu-' + this.dataset.menu;
    if (openMenuId && openMenuId !== menuId) {
      closeAllMenus();
      document.getElementById(menuId).classList.add('show');
      this.classList.add('open');
      openMenuId = menuId;
    }
  });
});

// Submenus: open instantly on hover; close after a grace period so diagonal
// movement toward the submenu panel and accidental slips don't dismiss it.
// The submenu sits as a DOM child of its parent row, so moving directly between
// them does not fire mouseleave on the parent — the timer only kicks in when
// the cursor genuinely leaves both the row and the panel.
document.querySelectorAll('.menu-has-submenu').forEach(parent => {
  const submenu = parent.querySelector('.menu-submenu');
  parent.addEventListener('mouseenter', () => {
    _clearMenuSubmenuTimer();
    document.querySelectorAll('.menu-has-submenu.submenu-open').forEach(el => { if (el !== parent) el.classList.remove('submenu-open'); });
    parent.classList.add('submenu-open');
  });
  parent.addEventListener('mouseleave', () => _scheduleSubmenuClose(parent));
  if (submenu) {
    submenu.addEventListener('mouseenter', _clearMenuSubmenuTimer);
    submenu.addEventListener('mouseleave', (e) => {
      if (parent.contains(e.relatedTarget)) return;
      _scheduleSubmenuClose(parent);
    });
  }
});

document.querySelectorAll('.menu-action:not(.menu-has-submenu)').forEach(btn => {
  btn.addEventListener('click', () => closeAllMenus());
});
document.addEventListener('click', (e) => { if (openMenuId && !e.target.closest('.menu-item')) closeAllMenus(); });
document.querySelectorAll('.modal-overlay').forEach(modal => { if (modal.id === 'settingsModal') return; modal.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); }); });

/* ═══════════════════════════════════════════════════════
   SPACE BAR PAN
   ═══════════════════════════════════════════════════════ */

let spaceDown = false;
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !spaceDown && !e.target.matches('input,select,textarea') && !e.target.isContentEditable) { spaceDown = true; workspace.style.cursor = 'grab'; e.preventDefault(); } });
document.addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; workspace.style.cursor = getToolCursor(); } });

// ── Brush cursor routing ──────────────────────────────────────────────────────

workspace.addEventListener('mousemove', (e) => updateBrushCursor(e));
workspace.addEventListener('mouseleave', () => { brushCursorEl.style.display = 'none'; rulerMouseX = -1; rulerMouseY = -1; if (rulersVisible) drawRulers(); });

// ── Window resize ─────────────────────────────────────────────────────────────

window.addEventListener('resize', () => { _wsRectCache = null; if (isFitMode) { zoomFit(); } else { centerCanvas(); drawRulers(); drawGuides(); drawUIOverlay(); } });
