"use strict";

/* ═══════════════════════════════════════════════════════
   PAINTING TOOLS — Brush, Pencil, Eraser
   Depends on: toolRegistry.js, toolbar.js (loadDrawSettings,
               saveDrawSettings, getDrawSize, getDrawHardness,
               getDrawOpacity, getDrawSmoothness),
               script.js (getActiveLayer, compositeAllWithStrokeBuffer,
               scheduleStrokeComposite, compositeAll, pushUndo,
               hexToRGBA, SnapEngine),
               state.js (strokeBuffer, strokeBufferCtx, lastDraw,
               fgColor, canvasW, canvasH, selectionPath,
               selectionFillRule, isDrawing, zoom, spaceDown, isPanning)
   ═══════════════════════════════════════════════════════ */

// ── Dab cache ────────────────────────────────────────────

let _dabCache = null;
const _BAYER4 = [
  [ 0, 8, 2,10],
  [12, 4,14, 6],
  [ 3,11, 1, 9],
  [15, 7,13, 5]
];

// ── Smoothing & spacing state ─────────────────────────────

let smoothX = 0, smoothY = 0;
let dabDistAccum = 0;

// ── Paint Engine ─────────────────────────────────────────

function buildDabCanvas(size, hardness, rgb) {
  const d = Math.max(2, Math.ceil(size) + 2); // +2 for a 1-px transparent margin
  const c = document.createElement('canvas');
  c.width = d; c.height = d;
  const cx = c.getContext('2d');
  const img = cx.createImageData(d, d);
  const data = img.data;
  const r = size / 2;
  const plateau = r * hardness;
  const fadeBand = Math.max(1e-6, r * (1 - hardness));
  const cxp = d / 2, cyp = d / 2;
  for (let y = 0; y < d; y++) {
    for (let x = 0; x < d; x++) {
      const dx = x + 0.5 - cxp, dy = y + 0.5 - cyp;
      const dist = Math.sqrt(dx*dx + dy*dy);
      let a;
      if (dist <= plateau) a = 1.0;
      else if (dist >= r) a = 0.0;
      else a = 1.0 - (dist - plateau) / fadeBand;
      // Ordered dither: ±0.5 LSB shift from a 4×4 Bayer matrix breaks banding
      // without changing the mean alpha of any region.
      const dith = (_BAYER4[y & 3][x & 3] / 16) - 0.5;
      const a8 = Math.max(0, Math.min(255, Math.round(a * 255 + dith)));
      const i = (y * d + x) * 4;
      data[i]   = rgb.r;
      data[i+1] = rgb.g;
      data[i+2] = rgb.b;
      data[i+3] = a8;
    }
  }
  cx.putImageData(img, 0, 0);
  return c;
}

function getDabCanvas(size, hardness, color) {
  const rgb = hexToRGBA(color);
  if (_dabCache && _dabCache.size === size && _dabCache.hardness === hardness
      && _dabCache.r === rgb.r && _dabCache.g === rgb.g && _dabCache.b === rgb.b) {
    return _dabCache.canvas;
  }
  const canvas = buildDabCanvas(size, hardness, rgb);
  _dabCache = { size, hardness, r: rgb.r, g: rgb.g, b: rgb.b, canvas };
  return canvas;
}

function renderBrushDab(ctx, x, y, size, hardness, color) {
  const r = size/2;
  if(r<0.25) return;
  if(hardness>=0.995){
    // Hard brush: use the native arc+fill to get browser sub-pixel anti-aliasing.
    ctx.fillStyle=color; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); return;
  }
  // Soft brush: stamp the dithered pre-rendered dab.
  const dab = getDabCanvas(size, hardness, color);
  ctx.drawImage(dab, x - dab.width/2, y - dab.height/2);
}

function getDabSpacing(size) { return Math.max(1, size * 0.15); }

function stampBrushSegment(ctx, x0, y0, x1, y1, size, hardness, color) {
  const dist = Math.hypot(x1-x0, y1-y0);
  if(dist < 0.1) return;
  const spacing = getDabSpacing(size);
  const dx = (x1-x0)/dist, dy = (y1-y0)/dist;
  let remaining = dist;
  let cx = x0, cy = y0;
  while(remaining > 0) {
    const stepNeeded = spacing - dabDistAccum;
    if(stepNeeded <= remaining) {
      cx += dx * stepNeeded; cy += dy * stepNeeded;
      remaining -= stepNeeded; dabDistAccum = 0;
      renderBrushDab(ctx, cx, cy, size, hardness, color);
    } else {
      cx += dx * remaining; cy += dy * remaining;
      dabDistAccum += remaining; remaining = 0;
    }
  }
}

function stampPencilDab(ctx, x, y, size, color) {
  ctx.fillStyle=color;
  const half=Math.floor(size/2);
  ctx.fillRect(Math.floor(x)-half, Math.floor(y)-half, size, size);
}

function stampPencilLine(ctx, x0, y0, x1, y1, size, color) {
  let ix0=Math.floor(x0), iy0=Math.floor(y0);
  const ix1=Math.floor(x1), iy1=Math.floor(y1);
  const dx=Math.abs(ix1-ix0), dy=Math.abs(iy1-iy0);
  const sx=ix0<ix1?1:-1, sy=iy0<iy1?1:-1;
  let err=dx-dy;
  const half=Math.floor(size/2);
  ctx.fillStyle=color;
  while(true){
    ctx.fillRect(ix0-half,iy0-half,size,size);
    if(ix0===ix1&&iy0===iy1) break;
    const e2=2*err;
    if(e2>-dy){err-=dy;ix0+=sx;}
    if(e2<dx){err+=dx;iy0+=sy;}
  }
}

function smoothInit(x, y) { smoothX=x; smoothY=y; }
function smoothStep(x, y, smoothness) {
  const pull = 1 - smoothness * 0.92;
  smoothX += (x - smoothX) * pull;
  smoothY += (y - smoothY) * pull;
  return {x: smoothX, y: smoothY};
}

// ── Brush Cursor Preview ─────────────────────────────────

function updateBrushCursor(e) {
  if (!['brush','pencil','eraser'].includes(currentTool) || spaceDown || isPanning) { brushCursorEl.style.display = 'none'; return; }
  const size = getDrawSize(); const screenSize = size * zoom;
  if (currentTool === 'pencil') {
    if (screenSize < 1) { brushCursorEl.style.display = 'none'; workspace.style.cursor = 'crosshair'; return; }
    workspace.style.cursor = 'none'; brushCursorEl.className = 'pencil-cursor'; brushCursorEl.style.display = 'block';
    const dispSize = Math.max(2, screenSize); brushCursorEl.style.width = dispSize + 'px'; brushCursorEl.style.height = dispSize + 'px';
    brushCursorEl.style.background = fgColor; brushCursorEl.style.opacity = '0.7';
    brushCursorEl.style.transform = `translate(${e.clientX - dispSize/2}px, ${e.clientY - dispSize/2}px)`;
  } else {
    // Cursor radius reflects the 50%-alpha falloff boundary of the dab, so
    // softening the brush visibly shrinks the ring to match where ink lands.
    const hardness = getDrawHardness();
    const effScreenSize = screenSize * (0.5 + 0.5 * hardness);
    if (effScreenSize < 4) { brushCursorEl.style.display = 'none'; workspace.style.cursor = 'crosshair'; return; }
    workspace.style.cursor = 'none'; brushCursorEl.className = ''; brushCursorEl.style.display = 'block';
    brushCursorEl.style.background = 'transparent'; brushCursorEl.style.opacity = '1';
    brushCursorEl.style.width = effScreenSize + 'px'; brushCursorEl.style.height = effScreenSize + 'px';
    brushCursorEl.style.transform = `translate(${e.clientX - effScreenSize/2}px, ${e.clientY - effScreenSize/2}px)`;
  }
}

// ── Shared stroke helpers ─────────────────────────────────

function _initStroke(e, pos) {
  if (e.button !== 0) return false;
  const layer = getActiveLayer();
  if (!layer || !layer.visible) return false;
  const size = getDrawSize();
  const hardness = currentTool === 'pencil' ? 1 : getDrawHardness();
  const color = currentTool === 'eraser' ? '#ffffff' : fgColor;
  strokeBuffer = document.createElement('canvas');
  strokeBuffer.width = canvasW; strokeBuffer.height = canvasH;
  strokeBufferCtx = strokeBuffer.getContext('2d');
  if (currentTool === 'pencil') strokeBufferCtx.imageSmoothingEnabled = false;
  smoothInit(pos.x, pos.y); dabDistAccum = 0;
  if (currentTool === 'pencil') stampPencilDab(strokeBufferCtx, pos.x, pos.y, size, color);
  else { renderBrushDab(strokeBufferCtx, pos.x, pos.y, size, hardness, color); dabDistAccum = 0; }
  compositeAllWithStrokeBuffer();
  return true;
}

function _continueStroke(e, pos) {
  if (!strokeBuffer) return false;
  const size = getDrawSize();
  const hardness = currentTool === 'pencil' ? 1 : getDrawHardness();
  const smoothness = currentTool === 'pencil' ? 0 : getDrawSmoothness();
  const color = currentTool === 'eraser' ? '#ffffff' : fgColor;
  const sp = smoothStep(pos.x, pos.y, smoothness);
  if (currentTool === 'pencil') stampPencilLine(strokeBufferCtx, lastDraw.x, lastDraw.y, sp.x, sp.y, size, color);
  else stampBrushSegment(strokeBufferCtx, lastDraw.x, lastDraw.y, sp.x, sp.y, size, hardness, color);
  scheduleStrokeComposite();
  lastDraw = {x: sp.x, y: sp.y};
  return true;
}

function _commitStroke(e) {
  if (!strokeBuffer) return false;
  const layer = getActiveLayer();
  if (!layer) return false;
  const opacity = getDrawOpacity();
  layer.ctx.save();
  if (selectionPath) layer.ctx.clip(selectionPath, selectionFillRule);
  if (currentTool === 'eraser') layer.ctx.globalCompositeOperation = 'destination-out';
  layer.ctx.globalAlpha = opacity;
  layer.ctx.drawImage(strokeBuffer, 0, 0);
  layer.ctx.restore();
  strokeBuffer = null; strokeBufferCtx = null;
  SnapEngine.invalidateLayer(layer);
  compositeAll();
  isDrawing = false;
  pushUndo(currentTool.charAt(0).toUpperCase() + currentTool.slice(1));
  return true;
}

// ── Tool Registrations ───────────────────────────────────

ToolRegistry.register('brush', {
  activate() {
    loadDrawSettings('brush');
    document.getElementById('opt-draw-size').classList.remove('hidden');
    document.getElementById('opt-draw-soft').classList.remove('hidden');
    document.getElementById('opt-draw-opacity').classList.remove('hidden');
    document.getElementById('opt-draw-smooth').classList.remove('hidden');
    workspace.style.cursor = 'crosshair';
    brushCursorEl.style.display = 'none';
  },
  deactivate() {
    saveDrawSettings();
    brushCursorEl.style.display = 'none';
  },
  mouseDown(e, pos) { return _initStroke(e, pos); },
  mouseMove(e, pos) { return _continueStroke(e, pos); },
  mouseUp(e)        { return _commitStroke(e); }
});

ToolRegistry.register('pencil', {
  activate() {
    loadDrawSettings('pencil');
    document.getElementById('opt-pencil-size').classList.remove('hidden');
    document.getElementById('opt-pencil-opacity').classList.remove('hidden');
    workspace.style.cursor = 'crosshair';
    brushCursorEl.style.display = 'none';
  },
  deactivate() {
    saveDrawSettings();
    brushCursorEl.style.display = 'none';
  },
  mouseDown(e, pos) { return _initStroke(e, pos); },
  mouseMove(e, pos) { return _continueStroke(e, pos); },
  mouseUp(e)        { return _commitStroke(e); }
});

ToolRegistry.register('eraser', {
  activate() {
    loadDrawSettings('eraser');
    document.getElementById('opt-draw-size').classList.remove('hidden');
    document.getElementById('opt-draw-soft').classList.remove('hidden');
    document.getElementById('opt-draw-opacity').classList.remove('hidden');
    document.getElementById('opt-draw-smooth').classList.remove('hidden');
    workspace.style.cursor = 'crosshair';
    brushCursorEl.style.display = 'none';
  },
  deactivate() {
    saveDrawSettings();
    brushCursorEl.style.display = 'none';
  },
  mouseDown(e, pos) { return _initStroke(e, pos); },
  mouseMove(e, pos) { return _continueStroke(e, pos); },
  mouseUp(e)        { return _commitStroke(e); }
});
