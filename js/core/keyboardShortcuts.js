"use strict";

/* ═══════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   Loaded after tools/toolbar.js; all referenced globals are
   defined before first keydown fires.
   ═══════════════════════════════════════════════════════ */

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
  const k = e.key.toLowerCase(); const ctrl = e.ctrlKey || e.metaKey;
  // Arrow-key nudge: Move tool / Pixel Transform / Floating Selection.
  // Plain arrow = 1 px, Shift+arrow = 10 px. Handled before any other
  // shortcut so the arrows aren't intercepted by future bindings.
  if (!ctrl && (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown')) {
    const step = e.shiftKey ? 10 : 1;
    let dx = 0, dy = 0;
    if (k === 'arrowleft')  dx = -step;
    else if (k === 'arrowright') dx = step;
    else if (k === 'arrowup')    dy = -step;
    else if (k === 'arrowdown')  dy = step;
    if (nudgeMove(dx, dy)) { e.preventDefault(); return; }
  }
  // Magnetic lasso keyboard handlers (must precede generic Escape/Backspace/Enter)
  if (currentTool==='lasso' && lassoMode==='magnetic' && magActive) {
    if (k === 'escape') {
      e.preventDefault(); cancelMagneticLasso(); return;
    }
    if (k === 'backspace') {
      e.preventDefault();
      if (magAnchors.length > 1) {
        magAnchors.pop();
        if (magSegments.length > 0) magSegments.pop();
        magLivePath = null;
        drawMagneticOverlay();
      } else {
        cancelMagneticLasso();
      }
      return;
    }
    if (k === 'enter' && magAnchors.length > 2) {
      e.preventDefault(); finishMagneticLasso(true); return;
    }
  }
  if (ctrl && !e.shiftKey && k === 'z') { e.preventDefault(); if (window.IEM && window.IEM.active) window.IEM.dispatchUndo(); else doUndo(); }
  else if (k === 'escape') { e.preventDefault(); if (panelEyedropperActive) { togglePanelEyedropper(); return; } if (document.getElementById('cpIframeOverlay')) { closeColorPicker(); return; } if (currentTool === 'ruler' && rulerState.active) { clearRuler(); return; } if (pxTransformActive) { cancelPixelTransform(); if (selection || selectionPath) clearSelection(); return; } if (floatingActive) commitFloating(); if (selection || selectionPath) clearSelection(); if (gradActive) { commitGradient(); drawOverlay(); } }
  else if (k === 'enter') { if (pxTransformActive) { e.preventDefault(); commitPixelTransform(); return; } }
  else if ((ctrl && k === 'y') || (ctrl && e.shiftKey && k === 'z')) { e.preventDefault(); if (window.IEM && window.IEM.active) window.IEM.dispatchRedo(); else doRedo(); }
  else if (ctrl && k === 'c') { e.preventDefault(); doCopy(); }
  else if (ctrl && k === 'x') { e.preventDefault(); doCut(); }
  else if (ctrl && k === 'v') { /* allow native paste event to fire — handled by paste event listener */ }
  else if (ctrl && k === 'n') { e.preventDefault(); newImage(); }
  else if (ctrl && k === 'o') { e.preventDefault(); openImage(); }
  else if (ctrl && k === 'a') { e.preventDefault(); selectAll(); }
  else if (ctrl && !e.shiftKey && k === 'i') { e.preventDefault(); applyFilterDirect('invert'); }
  else if (ctrl && e.shiftKey && k === 'i') { e.preventDefault(); invertSelection(); }
  else if (ctrl && k === 'e') { e.preventDefault(); mergeLayers(); }
  else if (ctrl && k === 'd') {
    e.preventDefault();
    if (gradActive) commitGradient();
    // Move tool: Ctrl+D commits any active transform AND clears the selection
    // in one gesture (Q6/Q7). On other tools it's plain Deselect.
    if (pxTransformActive || (currentTool === 'move' && floatingActive)) {
      deselectMove();
    } else {
      clearSelection();
    }
  }
  else if (ctrl && k === '=') { e.preventDefault(); zoomIn(); }
  else if (ctrl && k === '-') { e.preventDefault(); zoomOut(); }
  else if (ctrl && k === '0') { e.preventDefault(); zoomFit(); }
  else if (ctrl && k === '1') { e.preventDefault(); zoom100(); }
  else if (ctrl && k === 'r') { location.reload(); }
  else if (ctrl && e.shiftKey && k === ';') { e.preventDefault(); SnapEngine.toggle(); }
  else if (ctrl && !e.shiftKey && k === ';') { e.preventDefault(); toggleGuides(); }
  else if (k === 'delete' || k === 'backspace') { if (selection) { e.preventDefault(); deleteSelection(); } }
  else if (k === 'x') { swapColors(); }
  else if (k === '[') {
    e.preventDefault(); const cur = getDrawSize(); const step = cur > 100 ? 20 : cur > 20 ? 5 : cur > 5 ? 2 : 1; const s = Math.max(1, cur - step);
    if (currentTool === 'pencil') { document.getElementById('pencilSize').value = s; document.getElementById('pencilSizeNum').value = s; }
    else { document.getElementById('drawSize').value = s; document.getElementById('drawSizeNum').value = s; }
  }
  else if (k === ']') {
    e.preventDefault(); const cur = getDrawSize(); const step = cur > 100 ? 20 : cur > 20 ? 5 : cur > 5 ? 2 : 1; const max = currentTool === 'pencil' ? 100 : 5000; const s = Math.min(max, cur + step);
    if (currentTool === 'pencil') { document.getElementById('pencilSize').value = s; document.getElementById('pencilSizeNum').value = s; }
    else { document.getElementById('drawSize').value = s; document.getElementById('drawSizeNum').value = s; }
  }
  else if (k === 'i' && !ctrl) { e.preventDefault(); togglePanelEyedropper(); }
  else if (k === ' ') { e.preventDefault(); }
  else if (toolKeys[k]) { selectTool(toolKeys[k]); }
});
