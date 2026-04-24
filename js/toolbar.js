"use strict";

/* ═══════════════════════════════════════════════════════
   TOOLBAR — Tool system, options bar wiring, per-tool config
   Depends on: script.js (must load first)
   ═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════
   DRAW SETTINGS — per-tool persistent config
   ═══════════════════════════════════════════════════════ */

const drawSettings = {
  brush:  { size: 20, hardness: 100, opacity: 100, smoothness: 0 },
  eraser: { size: 20, hardness: 100, opacity: 100, smoothness: 0 },
  pencil: { size: 1, opacity: 100 }
};

/* ═══════════════════════════════════════════════════════
   TOOL SYSTEM
   ═══════════════════════════════════════════════════════ */

function updateMoveDeselectButtonState() {
  const btn = document.getElementById('optMoveDeselect');
  if (!btn) return;
  const active = !!(pxTransformActive || floatingActive);
  btn.disabled = !active;
  btn.classList.toggle('opt-action-btn-armed', active);
}

function getToolCursor() {
  if (['brush','pencil','eraser'].includes(currentTool)) return 'crosshair';
  if (currentTool === 'pan') return 'grab';
  if (currentTool === 'move' || currentTool === 'movesel') return 'default';
  if (currentTool === 'zoom') return 'zoom-in';
  if (currentTool === 'text') return 'text';
  return 'crosshair';
}

function selectTool(name) {
  // Commit any pending nudge burst before tearing down the current tool —
  // covers movesel (whose flush isn't reached via commitPixelTransform below)
  // and any edge case where nudge state outlives its owning session.
  if (_nudgePending) flushNudgeUndo();
  // Cancel any in-progress magnetic lasso when switching tools
  if (magActive && (name !== 'lasso')) cancelMagneticLasso();
  if (floatingActive && name !== 'move') {
    const wasMoved = (floatingOffset.x !== 0 || floatingOffset.y !== 0);
    commitFloating();
    if (wasMoved) {
      selection = null; selectionPath = null;
      if (selectionMask) selectionMaskCtx.clearRect(0, 0, canvasW, canvasH);
      drawOverlay();
    }
  }
  if (pxTransformActive && name !== 'move') {
    commitPixelTransform();
  }
  if (['brush','pencil','eraser'].includes(currentTool)) saveDrawSettings();
  if (currentTool === 'gradient' && gradActive && name !== 'gradient') commitGradient();
  if (currentTool === 'ruler' && name !== 'ruler') clearRuler();
  if (selectedGuide) { selectedGuide = null; drawGuides(); }
  currentTool = name;
  transformSelActive = (name === 'movesel');
  if (panelEyedropperActive) togglePanelEyedropper();
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === name));

  const allOpts = ['opt-move','opt-draw-size','opt-draw-soft','opt-draw-opacity','opt-draw-smooth','opt-pencil-size','opt-pencil-opacity','opt-opacity','opt-fill-mode','opt-stroke-width','opt-font','opt-gradient-opacity','opt-fill-opacity','opt-fill-tolerance','opt-sel-mode','opt-wand-tolerance','opt-wand-contiguous','opt-mag-width','opt-mag-contrast','opt-mag-frequency','opt-ruler'];
  allOpts.forEach(id => document.getElementById(id).classList.add('hidden'));

  // ── Tool Indicator ──
  const _tiS = document.getElementById('toolIndicatorSingle');
  const _tiSel = document.getElementById('toolIndicatorSelect');
  const _tiL = document.getElementById('toolIndicatorLasso');
  const _tiSh = document.getElementById('toolIndicatorShape');
  _tiS.classList.add('hidden'); _tiSel.classList.add('hidden');
  _tiL.classList.add('hidden'); _tiSh.classList.add('hidden');
  if (name === 'select') { _tiSel.classList.remove('hidden'); }
  else if (name === 'lasso') { _tiL.classList.remove('hidden'); }
  else if (name === 'shape') { _tiSh.classList.remove('hidden'); }
  else {
    _tiS.classList.remove('hidden');
    const _tiMap = {move:'move',movesel:'move-selection',pan:'pan',brush:'brush',pencil:'pencil',eraser:'eraser',fill:'fill',gradient:'gradient',text:'text',wand:'magic-wand',ruler:'ruler-tool',eyedropper:'eyedropper'};
    document.getElementById('toolIndicatorIcon').setAttribute('href','#icon-'+(_tiMap[name]||'move'));
  }

  if (name === 'move') {
    document.getElementById('opt-move').classList.remove('hidden');
  } else if (name === 'brush' || name === 'eraser') {
    loadDrawSettings(name);
    document.getElementById('opt-draw-size').classList.remove('hidden');
    document.getElementById('opt-draw-soft').classList.remove('hidden');
    document.getElementById('opt-draw-opacity').classList.remove('hidden');
    document.getElementById('opt-draw-smooth').classList.remove('hidden');
  } else if (name === 'pencil') {
    loadDrawSettings(name);
    document.getElementById('opt-pencil-size').classList.remove('hidden');
    document.getElementById('opt-pencil-opacity').classList.remove('hidden');
  } else if (name === 'shape') {
    document.getElementById('opt-fill-mode').classList.remove('hidden');
    document.getElementById('opt-stroke-width').classList.remove('hidden');
    document.getElementById('opt-opacity').classList.remove('hidden');
  } else if (name === 'text') {
    document.getElementById('opt-font').classList.remove('hidden');
    document.getElementById('opt-opacity').classList.remove('hidden');
  } else if (name === 'gradient') {
    document.getElementById('opt-gradient-opacity').classList.remove('hidden');
  } else if (name === 'fill') {
    document.getElementById('opt-fill-opacity').classList.remove('hidden');
    document.getElementById('opt-fill-tolerance').classList.remove('hidden');
  } else if (name === 'select') {
    document.getElementById('opt-sel-mode').classList.remove('hidden');
  } else if (name === 'lasso') {
    document.getElementById('opt-sel-mode').classList.remove('hidden');
    if (lassoMode === 'magnetic') {
      document.getElementById('opt-mag-width').classList.remove('hidden');
      document.getElementById('opt-mag-contrast').classList.remove('hidden');
      document.getElementById('opt-mag-frequency').classList.remove('hidden');
    }
  } else if (name === 'wand') {
    document.getElementById('opt-wand-tolerance').classList.remove('hidden');
    document.getElementById('opt-wand-contiguous').classList.remove('hidden');
    document.getElementById('opt-sel-mode').classList.remove('hidden');
  } else if (name === 'ruler') {
    document.getElementById('opt-ruler').classList.remove('hidden');
    updateRulerOptionsBar();
  }

  if (['brush','pencil','eraser'].includes(name)) {
    workspace.style.cursor = 'crosshair';
  } else {
    workspace.style.cursor = (name === 'pan') ? 'grab' :
      (name === 'move' || name === 'movesel') ? 'default' :
      name === 'text' ? 'text' : 'crosshair';
  }
  brushCursorEl.style.display = 'none';

  drawOverlay();

  const shapeNames = {rect:'Rectangle',ellipse:'Ellipse',line:'Line'};
  const toolNames = {move:'Move',movesel:'Move Selection',pan:'Pan',select:'Select',lasso:'Lasso',wand:'Magic Wand',ruler:'Ruler',brush:'Brush',pencil:'Pencil',eraser:'Eraser',fill:'Fill',gradient:'Gradient',text:'Text',shape:shapeNames[shapeType]||'Shape',zoom:'Zoom'};
  document.getElementById('statusTool').textContent = toolNames[name] || name;

  // Move tool activation:
  //   • Selection active → immediately enter Pixel Transform so the
  //     handles appear the moment the tool is picked.
  //   • No selection → do nothing. A transform box is only produced
  //     when the user explicitly click-drags on a visible pixel
  //     (handled in onMouseDown).
  if (name === 'move') {
    if (selection && selectionPath && !pxTransformActive && !floatingActive) {
      initPixelTransform();
    }
    updateMoveDeselectButtonState();
  }
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool));
});

const toolKeys = {v:'move',q:'movesel',h:'pan',m:'select',l:'lasso',w:'wand',r:'ruler',b:'brush',p:'pencil',e:'eraser',g:'fill',d:'gradient',t:'text',u:'shape',z:'zoom'};

/* ═══════════════════════════════════════════════════════
   OPTIONS BAR WIRING — slider sync + wheel scroll
   ═══════════════════════════════════════════════════════ */

syncSliders('drawSize','drawSizeNum');
syncSliders('drawHardness','drawHardnessNum');
syncSliders('drawOpacity','drawOpacityNum');
syncSliders('drawSmooth','drawSmoothNum');
syncSliders('pencilSize','pencilSizeNum');
syncSliders('pencilOpacity','pencilOpacityNum');
syncSliders('toolOpacity','toolOpacityNum');
syncSliders('gradOpacity','gradOpacityNum');
syncSliders('fillOpacity','fillOpacityNum');
syncSliders('fillTolerance','fillToleranceNum');
syncSliders('wandTolerance','wandToleranceNum');
syncSliders('magWidth','magWidthNum');
syncSliders('magContrast','magContrastNum');
syncSliders('magFrequency','magFrequencyNum');

[
  'drawSizeNum', 'drawHardnessNum', 'drawOpacityNum', 'drawSmoothNum',
  'pencilSizeNum', 'pencilOpacityNum',
  'toolOpacityNum', 'gradOpacityNum', 'fillOpacityNum',
  'fillToleranceNum', 'wandToleranceNum',
  'magWidthNum', 'magContrastNum', 'magFrequencyNum',
  'shapeStrokeWidth', 'textSize'
].forEach(id => { const el = document.getElementById(id); if (el) setupAppLikeInput(el); });

addSliderWheelListener('opt-draw-size',        'drawSizeNum');
addSliderWheelListener('opt-draw-soft',        'drawHardnessNum');
addSliderWheelListener('opt-draw-opacity',     'drawOpacityNum');
addSliderWheelListener('opt-draw-smooth',      'drawSmoothNum');
addSliderWheelListener('opt-pencil-size',      'pencilSizeNum');
addSliderWheelListener('opt-pencil-opacity',   'pencilOpacityNum');
addSliderWheelListener('opt-opacity',          'toolOpacityNum');
addSliderWheelListener('opt-gradient-opacity', 'gradOpacityNum');
addSliderWheelListener('opt-fill-opacity',     'fillOpacityNum');
addSliderWheelListener('opt-fill-tolerance',   'fillToleranceNum');
addSliderWheelListener('opt-wand-tolerance',   'wandToleranceNum');
addSliderWheelListener('opt-mag-width',        'magWidthNum');
addSliderWheelListener('opt-mag-contrast',     'magContrastNum');
addSliderWheelListener('opt-mag-frequency',    'magFrequencyNum');

/* ═══════════════════════════════════════════════════════
   DRAW SETTINGS — save / load / getters
   ═══════════════════════════════════════════════════════ */

function saveDrawSettings() {
  const t=currentTool;
  if(t==='brush'||t==='eraser'){
    const sz=parseInt(document.getElementById('drawSize').value); drawSettings[t].size=isNaN(sz)?20:sz;
    const hd=parseInt(document.getElementById('drawHardness').value); drawSettings[t].hardness=isNaN(hd)?100:hd;
    const op=parseInt(document.getElementById('drawOpacity').value); drawSettings[t].opacity=isNaN(op)?100:op;
    const sm=parseInt(document.getElementById('drawSmooth').value); drawSettings[t].smoothness=isNaN(sm)?0:sm;
  } else if(t==='pencil'){
    const sz=parseInt(document.getElementById('pencilSize').value); drawSettings.pencil.size=isNaN(sz)?1:sz;
    const op=parseInt(document.getElementById('pencilOpacity').value); drawSettings.pencil.opacity=isNaN(op)?100:op;
  }
}

function loadDrawSettings(tool) {
  if(tool==='brush'||tool==='eraser'){
    const s=drawSettings[tool];
    document.getElementById('drawSize').value=Math.min(s.size,500); document.getElementById('drawSizeNum').value=s.size;
    document.getElementById('drawHardness').value=s.hardness; document.getElementById('drawHardnessNum').value=s.hardness;
    document.getElementById('drawOpacity').value=s.opacity; document.getElementById('drawOpacityNum').value=s.opacity;
    document.getElementById('drawSmooth').value=s.smoothness; document.getElementById('drawSmoothNum').value=s.smoothness;
  } else if(tool==='pencil'){
    document.getElementById('pencilSize').value=Math.min(drawSettings.pencil.size,500); document.getElementById('pencilSizeNum').value=drawSettings.pencil.size;
    document.getElementById('pencilOpacity').value=drawSettings.pencil.opacity; document.getElementById('pencilOpacityNum').value=drawSettings.pencil.opacity;
  }
}

function getDrawSize() {
  if(currentTool==='pencil') return Math.min(5000, parseInt(document.getElementById('pencilSizeNum').value)||1);
  return Math.min(5000, parseInt(document.getElementById('drawSizeNum').value)||20);
}
function getDrawHardness() { const v=parseInt(document.getElementById('drawHardness').value); return (isNaN(v)?100:v)/100; }
function getDrawOpacity() {
  if(currentTool==='pencil'){ const v=parseInt(document.getElementById('pencilOpacity').value); return (isNaN(v)?100:v)/100; }
  const v=parseInt(document.getElementById('drawOpacity').value); return (isNaN(v)?100:v)/100;
}
function getDrawSmoothness() { const v=parseInt(document.getElementById('drawSmooth').value); return (isNaN(v)?0:v)/100; }
function getToolOpacity() { const v=parseInt(document.getElementById('toolOpacity').value); return (isNaN(v)?100:v)/100; }

/* ═══════════════════════════════════════════════════════
   TOOL OPTION SETTERS — options bar sub-controls
   ═══════════════════════════════════════════════════════ */

// Wires up the Move-tool options bar (Auto-Select Layer checkbox).
function initMoveToolOptions() {
  const cb = document.getElementById('moveAutoSelect');
  if (cb) {
    cb.checked = moveAutoSelectLayer;
    cb.addEventListener('change', () => setMoveAutoSelectLayer(cb.checked));
  }
  updateMoveDeselectButtonState();
}

function setMoveAutoSelectLayer(on) {
  moveAutoSelectLayer = !!on;
  try { localStorage.setItem('opsin.move.autoSelectLayer', moveAutoSelectLayer ? 'true' : 'false'); } catch(e) {}
  const cb = document.getElementById('moveAutoSelect');
  if (cb) cb.checked = moveAutoSelectLayer;
}

function deselectMove() {
  if (pxTransformActive) {
    commitPixelTransform();
  } else if (floatingActive) {
    commitFloating();
  }
  if (selection || selectionPath) clearSelection();
  updateMoveDeselectButtonState();
  drawOverlay();
}

function setSelectShape(shape) {
  selectShape = shape;
  document.getElementById('optSelectRect').classList.toggle('active', shape==='rect');
  document.getElementById('optSelectEllipse').classList.toggle('active', shape==='ellipse');
  document.getElementById('selectToolBtn').innerHTML = shape==='rect' ? RECT_SELECT_SVG : ELLIPSE_SELECT_SVG;
}

function setLassoMode(mode) {
  // Cancel any in-progress magnetic lasso before switching
  if (lassoMode === 'magnetic' && magActive) cancelMagneticLasso();
  // Cancel any in-progress poly lasso
  if (lassoMode === 'poly' && polyPoints.length > 0) { polyPoints = []; isDrawingSelection = false; drawingPreviewPath = null; }
  lassoMode = mode;
  document.getElementById('optLassoFree').classList.toggle('active', mode==='free');
  document.getElementById('optLassoPoly').classList.toggle('active', mode==='poly');
  document.getElementById('optLassoMag').classList.toggle('active', mode==='magnetic');
  const btn = document.getElementById('lassoToolBtn');
  if (btn) btn.innerHTML = mode==='free' ? LASSO_SVG : mode==='poly' ? POLY_LASSO_SVG : MAG_LASSO_SVG;
  // Toggle magnetic options visibility
  const magIds = ['opt-mag-width','opt-mag-contrast','opt-mag-frequency'];
  if (currentTool === 'lasso') {
    magIds.forEach(id => document.getElementById(id).classList.toggle('hidden', mode !== 'magnetic'));
  }
  drawOverlay();
}

function setSelectionMode(mode) {
  selectionMode = mode;
  document.getElementById('optSelNew').classList.toggle('active', mode==='new');
  document.getElementById('optSelAdd').classList.toggle('active', mode==='add');
  document.getElementById('optSelSub').classList.toggle('active', mode==='subtract');
}

function setShapeType(type) {
  shapeType = type;
  document.getElementById('optShapeRect').classList.toggle('active', type==='rect');
  document.getElementById('optShapeEllipse').classList.toggle('active', type==='ellipse');
  document.getElementById('optShapeLine').classList.toggle('active', type==='line');
  const shapeNames = {rect:'Rectangle',ellipse:'Ellipse',line:'Line'};
  document.getElementById('statusTool').textContent = shapeNames[type] || 'Shape';
}

/* ═══════════════════════════════════════════════════════
   RULER OPTIONS BAR
   ═══════════════════════════════════════════════════════ */

function updateRulerOptionsBar() {
  const wEl = document.getElementById('rulerReadoutW');
  const hEl = document.getElementById('rulerReadoutH');
  const dEl = document.getElementById('rulerReadoutD');
  const aEl = document.getElementById('rulerReadoutA');
  if (!wEl) return;
  if (!rulerState.active) {
    wEl.textContent = '—';
    hEl.textContent = '—';
    dEl.textContent = '—';
    aEl.textContent = '—';
    return;
  }
  const dx = rulerState.x2 - rulerState.x1;
  const dy = rulerState.y2 - rulerState.y1;
  const w = Math.abs(dx);
  const h = Math.abs(dy);
  const d = Math.hypot(dx, dy);
  // Photoshop convention: 0° along +X, positive = counter-clockwise (screen-up)
  const a = (dx === 0 && dy === 0) ? 0 : (-Math.atan2(dy, dx) * 180 / Math.PI);
  wEl.textContent = w + ' px';
  hEl.textContent = h + ' px';
  dEl.textContent = d.toFixed(2) + ' px';
  aEl.textContent = a.toFixed(2) + '°';
}
