'use strict';

/* ═══════════════════════════════════════════════════════
   GRADIENT TOOL — Multi-Stop Editable Linear Gradient
   ═══════════════════════════════════════════════════════ */

let gradColorTarget = null;
let gradColorPickerMode = false;
let gradHoverElement = null;

const _parseColorCanvas = document.createElement('canvas');
_parseColorCanvas.width = 1; _parseColorCanvas.height = 1;
const _parseColorCtx = _parseColorCanvas.getContext('2d');
let _parseCache1 = {hex:'', rgb:null}, _parseCache2 = {hex:'', rgb:null};
function parseColor(hex) {
  if (_parseCache1.hex === hex) return _parseCache1.rgb;
  if (_parseCache2.hex === hex) return _parseCache2.rgb;
  _parseColorCtx.clearRect(0, 0, 1, 1);
  _parseColorCtx.fillStyle = hex;
  _parseColorCtx.fillRect(0, 0, 1, 1);
  const d = _parseColorCtx.getImageData(0, 0, 1, 1).data;
  const rgb = {r:d[0], g:d[1], b:d[2]};
  _parseCache2 = _parseCache1;
  _parseCache1 = {hex, rgb};
  return rgb;
}

function srgbToLinear(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToSrgb(c) { return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); }

function getGradOpacity() { const v = parseInt(document.getElementById('gradOpacity').value); return (isNaN(v) ? 100 : v) / 100; }

function gradSnapshot() {
  const layer = getActiveLayer();
  if (!layer) return;
  gradBaseSnapshot = document.createElement('canvas');
  gradBaseSnapshot.width = canvasW; gradBaseSnapshot.height = canvasH;
  gradBaseSnapshot.getContext('2d').drawImage(layer.canvas, 0, 0);
}

function gradRestore() {
  if (!gradBaseSnapshot) return;
  const layer = getActiveLayer();
  if (!layer) return;
  layer.ctx.clearRect(0, 0, canvasW, canvasH);
  layer.ctx.drawImage(gradBaseSnapshot, 0, 0);
}

function gradInterpolateColorAt(t) {
  if (gradStops.length < 2) return '#000000';
  if (t <= gradStops[0].t) return gradStops[0].color;
  if (t >= gradStops[gradStops.length - 1].t) return gradStops[gradStops.length - 1].color;
  for (let i = 0; i < gradStops.length - 1; i++) {
    const s0 = gradStops[i], s1 = gradStops[i + 1];
    if (t >= s0.t && t <= s1.t) {
      const segLen = s1.t - s0.t;
      if (segLen < 0.0001) return s0.color;
      const localT = (t - s0.t) / segLen;
      const mid = Math.max(0.001, Math.min(0.999, s0.mid || 0.5));
      const gamma = Math.log(0.5) / Math.log(mid);
      const blend = Math.pow(localT, gamma);
      const c0 = parseColor(s0.color), c1 = parseColor(s1.color);
      const lr0 = srgbToLinear(c0.r), lg0 = srgbToLinear(c0.g), lb0 = srgbToLinear(c0.b);
      const lr1 = srgbToLinear(c1.r), lg1 = srgbToLinear(c1.g), lb1 = srgbToLinear(c1.b);
      const r = linearToSrgb(lr0 * (1 - blend) + lr1 * blend);
      const g = linearToSrgb(lg0 * (1 - blend) + lg1 * blend);
      const b = linearToSrgb(lb0 * (1 - blend) + lb1 * blend);
      return `rgb(${r},${g},${b})`;
    }
  }
  return gradStops[gradStops.length - 1].color;
}

function renderGradientToLayer() {
  if (!gradP1 || !gradP2 || gradStops.length < 2) return;
  const layer = getActiveLayer();
  if (!layer) return;
  gradRestore();
  const opacity = getGradOpacity();
  const grad = layer.ctx.createLinearGradient(gradP1.x, gradP1.y, gradP2.x, gradP2.y);
  const subsPerSeg = 24;
  for (let i = 0; i < gradStops.length - 1; i++) {
    const s0 = gradStops[i], s1 = gradStops[i + 1];
    const c0 = parseColor(s0.color), c1 = parseColor(s1.color);
    const lr0 = srgbToLinear(c0.r), lg0 = srgbToLinear(c0.g), lb0 = srgbToLinear(c0.b);
    const lr1 = srgbToLinear(c1.r), lg1 = srgbToLinear(c1.g), lb1 = srgbToLinear(c1.b);
    const mid = Math.max(0.001, Math.min(0.999, s0.mid || 0.5));
    const gamma = Math.log(0.5) / Math.log(mid);
    for (let j = 0; j <= subsPerSeg; j++) {
      if (j === 0 && i > 0) continue;
      const localT = j / subsPerSeg;
      const blend = Math.pow(localT, gamma);
      const r = linearToSrgb(lr0 * (1 - blend) + lr1 * blend);
      const g = linearToSrgb(lg0 * (1 - blend) + lg1 * blend);
      const b = linearToSrgb(lb0 * (1 - blend) + lb1 * blend);
      const globalT = s0.t + (s1.t - s0.t) * localT;
      grad.addColorStop(Math.max(0, Math.min(1, globalT)), `rgb(${r},${g},${b})`);
    }
  }
  layer.ctx.save();
  layer.ctx.globalAlpha = opacity;
  if (selectionPath) layer.ctx.clip(selectionPath, selectionFillRule);
  layer.ctx.fillStyle = grad;
  layer.ctx.fillRect(0, 0, canvasW, canvasH);
  layer.ctx.restore();
  compositeAll();
}

function commitGradient() {
  if (!gradActive) return;
  gradActive = false; gradP1 = null; gradP2 = null;
  gradStops = []; gradDragging = null; gradBaseSnapshot = null;
  gradDragStartPos = null; gradStopAboutToDelete = false;
  gradColorPickerMode = false; gradColorTarget = null;
  hideGradStopCtx();
  drawOverlay();
  pushUndo('Gradient');
}

function gradPerpDist(px, py) {
  if (!gradP1 || !gradP2) return 0;
  const dx = gradP2.x - gradP1.x, dy = gradP2.y - gradP1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return Math.hypot(px - gradP1.x, py - gradP1.y);
  return Math.abs((py - gradP1.y) * dx - (px - gradP1.x) * dy) / len;
}

function gradProjectT(px, py) {
  const dx = gradP2.x - gradP1.x, dy = gradP2.y - gradP1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1) return 0;
  return Math.max(0, Math.min(1, ((px - gradP1.x) * dx + (py - gradP1.y) * dy) / len2));
}

function gradHitTest(px, py) {
  if (!gradP1 || !gradP2 || gradStops.length < 2) return null;
  const threshold = 12 / zoom;
  for (let i = 0; i < gradStops.length; i++) {
    const s = gradStops[i];
    const sx = gradP1.x + (gradP2.x - gradP1.x) * s.t;
    const sy = gradP1.y + (gradP2.y - gradP1.y) * s.t;
    if (Math.hypot(px - sx, py - sy) <= threshold) return {type: 'stop', index: i};
  }
  for (let i = 0; i < gradStops.length - 1; i++) {
    const s0 = gradStops[i], s1 = gradStops[i + 1];
    const midT = s0.t + (s1.t - s0.t) * (s0.mid || 0.5);
    const mx = gradP1.x + (gradP2.x - gradP1.x) * midT;
    const my = gradP1.y + (gradP2.y - gradP1.y) * midT;
    if (Math.hypot(px - mx, py - my) <= threshold) return {type: 'mid', index: i};
  }
  const perpD = gradPerpDist(px, py);
  if (perpD <= threshold) {
    const t = gradProjectT(px, py);
    if (t > 0.001 && t < 0.999) return {type: 'line', t: t};
  }
  return null;
}

function gradStopPos(i) {
  const s = gradStops[i];
  return {x: gradP1.x + (gradP2.x - gradP1.x) * s.t, y: gradP1.y + (gradP2.y - gradP1.y) * s.t};
}

function showGradStopCtx(stopIndex, screenX, screenY) {
  const menu = document.getElementById('gradStopCtx');
  if (!menu) return;
  menu.dataset.stopIndex = stopIndex;
  menu.style.display = 'flex';
  requestAnimationFrame(() => {
    const mr = menu.getBoundingClientRect();
    let x = screenX - mr.width / 2, y = screenY - mr.height - 10;
    if (y < 4) y = screenY + 10;
    if (x < 4) x = 4;
    if (x + mr.width > window.innerWidth - 4) x = window.innerWidth - mr.width - 4;
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    menu.classList.add('active');
  });
}

function hideGradStopCtx() {
  const menu = document.getElementById('gradStopCtx');
  if (!menu || !menu.classList.contains('active')) return;
  menu.classList.remove('active');
  setTimeout(() => { if (!menu.classList.contains('active')) menu.style.display = 'none'; }, 150);
}

function executeGradStopDelete() {
  const menu = document.getElementById('gradStopCtx');
  if (!menu) return;
  const idx = parseInt(menu.dataset.stopIndex);
  if (isNaN(idx) || idx <= 0 || idx >= gradStops.length - 1) { hideGradStopCtx(); return; }
  gradStops.splice(idx, 1);
  renderGradientToLayer(); drawOverlay();
  hideGradStopCtx();
}

/* ═══════════════════════════════════════════════════════
   TOOL REGISTRATIONS
   ═══════════════════════════════════════════════════════ */

ToolRegistry.register('fill', {
  activate() {
    document.getElementById('opt-fill-opacity').classList.remove('hidden');
    document.getElementById('opt-fill-tolerance').classList.remove('hidden');
    workspace.style.cursor = 'crosshair';
  },
  mouseDown(e, pos) {
    const layer = getActiveLayer();
    if (!layer || !layer.visible) return false;
    const px = pos.x, py = pos.y;
    const tolVal = parseInt(document.getElementById('fillTolerance').value);
    const tol = isNaN(tolVal) ? 128 : tolVal;
    const opVal = parseInt(document.getElementById('fillOpacity').value);
    const opacity = (isNaN(opVal) ? 100 : opVal) / 100;
    if (selectionPath) {
      layer.ctx.save(); layer.ctx.clip(selectionPath, selectionFillRule);
      floodFill(layer.ctx, px, py, fgColor, tol, opacity);
      layer.ctx.restore();
    } else {
      floodFill(layer.ctx, px, py, fgColor, tol, opacity);
    }
    SnapEngine.invalidateLayer(layer);
    compositeAll();
    pushUndo('Fill');
    return true;
  }
});

ToolRegistry.register('gradient', {
  activate() {
    document.getElementById('opt-gradient-opacity').classList.remove('hidden');
    workspace.style.cursor = 'crosshair';
  },
  deactivate() {
    if (gradActive) commitGradient();
  },
  mouseDown(e, pos) {
    const px = pos.x, py = pos.y;
    if (gradActive && (px < 0 || py < 0 || px >= canvasW || py >= canvasH)) {
      commitGradient(); isDrawing = false; return true;
    }
    hideGradStopCtx();
    if (gradActive) {
      const hit = gradHitTest(px, py);
      if (hit) {
        if (hit.type === 'line') {
          const newColor = gradInterpolateColorAt(hit.t);
          const insertIdx = gradStops.findIndex(s => s.t > hit.t);
          const newStop = {t: hit.t, color: newColor, mid: 0.5};
          if (insertIdx > 0) gradStops[insertIdx - 1].mid = 0.5;
          gradStops.splice(insertIdx, 0, newStop);
          gradDragging = {type: 'stop', index: insertIdx};
          gradDragStartPos = {x: px, y: py}; gradStopAboutToDelete = false;
          workspace.style.cursor = 'grabbing';
          renderGradientToLayer(); drawOverlay(); isDrawing = false; return true;
        }
        gradDragging = hit;
        gradDragStartPos = (hit.type === 'stop') ? {x: px, y: py} : null;
        gradStopAboutToDelete = false;
        if (hit.type === 'stop' && (hit.index === 0 || hit.index === gradStops.length - 1)) SnapEngine.beginSession({});
        workspace.style.cursor = 'grabbing'; isDrawing = false; return true;
      }
      isDrawing = false; return true;
    }
    SnapEngine.beginSession({});
    const _spg = SnapEngine.snapPoint({x:px, y:py}, {modifiers:e});
    gradStops = [{t: 0, color: fgColor, mid: 0.5}, {t: 1, color: bgColor}];
    gradP1 = {x: _spg.x, y: _spg.y}; gradP2 = {x: _spg.x, y: _spg.y}; gradDragging = 'creating'; gradSnapshot();
    return true;
  },
  mouseMove(e, pos) {
    const px = pos.x, py = pos.y;
    if (gradDragging) {
      if (gradDragging === 'creating') { const _spg = SnapEngine.snapPoint({x:px,y:py},{modifiers:e}); gradP2 = {x:_spg.x, y:_spg.y}; }
      else if (gradDragging.type === 'stop') {
        const idx = gradDragging.index;
        const isEndpoint = (idx === 0 || idx === gradStops.length - 1);
        if (isEndpoint) {
          const _spg = SnapEngine.snapPoint({x:px,y:py},{modifiers:e});
          if (idx === 0) gradP1 = {x: _spg.x, y: _spg.y};
          else gradP2 = {x: _spg.x, y: _spg.y};
        } else {
          const newT = gradProjectT(px, py);
          const minT = gradStops[idx - 1].t + 0.001;
          const maxT = gradStops[idx + 1].t - 0.001;
          gradStops[idx].t = Math.max(minT, Math.min(maxT, newT));
          const pd = gradPerpDist(px, py);
          gradStopAboutToDelete = pd > 30 / zoom;
        }
      } else if (gradDragging.type === 'mid') {
        const idx = gradDragging.index;
        const s0 = gradStops[idx], s1 = gradStops[idx + 1];
        const dx = gradP2.x - gradP1.x, dy = gradP2.y - gradP1.y; const len2 = dx*dx + dy*dy;
        if (len2 > 0) {
          const t = ((px - gradP1.x)*dx + (py - gradP1.y)*dy) / len2;
          const segLen = s1.t - s0.t;
          if (segLen > 0.001) { s0.mid = Math.max(0.01, Math.min(0.99, (t - s0.t) / segLen)); }
        }
      }
      renderGradientToLayer(); drawOverlay(); return true;
    }
    if (gradActive && !gradDragging) {
      const hit = gradHitTest(px, py);
      const prevHover = gradHoverElement;
      gradHoverElement = hit;
      if (hit) {
        if (hit.type === 'stop') workspace.style.cursor = 'grab';
        else if (hit.type === 'mid') workspace.style.cursor = 'ew-resize';
        else if (hit.type === 'line') workspace.style.cursor = 'copy';
      } else { workspace.style.cursor = 'crosshair'; }
      if (JSON.stringify(hit) !== JSON.stringify(prevHover)) drawOverlay();
    }
    return false;
  },
  mouseUp(e, pos) {
    if (gradDragging && gradDragging !== 'creating') {
      if (gradDragging.type === 'stop' && gradStopAboutToDelete) {
        const idx = gradDragging.index;
        if (idx > 0 && idx < gradStops.length - 1) gradStops.splice(idx, 1);
        gradStopAboutToDelete = false;
      }
      gradDragging = null; gradDragStartPos = null; gradStopAboutToDelete = false;
      workspace.style.cursor = 'crosshair'; SnapEngine.endSession(); renderGradientToLayer(); drawOverlay(); return true;
    }
    if (gradDragging === 'creating') {
      const dist = Math.hypot(gradP2.x - gradP1.x, gradP2.y - gradP1.y);
      if (dist < 3) {
        gradRestore(); compositeAll(); gradP1 = null; gradP2 = null; gradStops = [];
        gradDragging = null; gradBaseSnapshot = null; SnapEngine.endSession(); drawOverlay();
        isDrawing = false; return true;
      }
      gradActive = true; renderGradientToLayer();
      gradDragging = null; gradDragStartPos = null; gradStopAboutToDelete = false;
      workspace.style.cursor = 'crosshair'; SnapEngine.endSession(); drawOverlay();
      isDrawing = false; return true;
    }
    return false;
  }
});
