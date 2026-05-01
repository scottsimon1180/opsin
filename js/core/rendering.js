"use strict";

/* ═══════════════════════════════════════════════════════
   RENDERING — canvas compositing, overlays, rulers, guides
   Pure rendering: reads global state, draws to canvases.
   No layer data or DOM state is modified here.
   Loads after script.js; all referenced globals (layers,
   zoom, selectionPath, etc.) are defined before first call.
   ═══════════════════════════════════════════════════════ */

// ── Transparency checkerboard ─────────────────────────────────────────────────

function getCheckerPattern(ctx) {
  if (checkerPattern) return checkerPattern;
  const pc = document.createElement('canvas');
  pc.width = 20; pc.height = 20;
  const pctx = pc.getContext('2d');
  pctx.fillStyle = '#cdcdcd'; pctx.fillRect(0, 0, 20, 20);
  pctx.fillStyle = '#ffffff'; pctx.fillRect(0, 0, 10, 10);
  pctx.fillStyle = '#ffffff'; pctx.fillRect(10, 10, 10, 10);
  checkerPattern = ctx.createPattern(pc, 'repeat');
  return checkerPattern;
}

// ── Layer compositing ─────────────────────────────────────────────────────────

function compositeAll() {
  compositeCtx.clearRect(0, 0, canvasW, canvasH);
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible) continue;
    compositeCtx.globalAlpha = l.opacity;
    compositeCtx.drawImage(l.canvas, 0, 0);
    if (i === activeLayerIndex && floatingActive && floatingCanvas) {
      compositeCtx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y);
    }
    if (i === activeLayerIndex && pxTransformActive && pxTransformData) {
      const _s = pxTransformData.srcCanvas, _b = pxTransformData.curBounds;
      const _rot = (pxTransformData.totalRotation || 0) + (pxTransformData.liveRotation || 0);
      if (_rot) {
        const _cx = _b.x + _b.w / 2, _cy = _b.y + _b.h / 2;
        compositeCtx.save();
        compositeCtx.translate(_cx, _cy);
        compositeCtx.rotate(_rot);
        compositeCtx.drawImage(_s, 0, 0, _s.width, _s.height, -_b.w / 2, -_b.h / 2, _b.w, _b.h);
        compositeCtx.restore();
      } else {
        compositeCtx.drawImage(_s, 0, 0, _s.width, _s.height, _b.x, _b.y, _b.w, _b.h);
      }
    }
  }
  compositeCtx.globalAlpha = 1;
}

function compositeAllWithStrokeBuffer() {
  if (!strokeBuffer) { compositeAll(); return; }
  const opacity = getDrawOpacity();

  compositeCtx.clearRect(0, 0, canvasW, canvasH);

  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.visible) continue;
    compositeCtx.globalAlpha = l.opacity;

    if (i === activeLayerIndex) {
      if (!compositeAllWithStrokeBuffer._tmp) {
        compositeAllWithStrokeBuffer._tmp = document.createElement('canvas');
      }
      const tmp = compositeAllWithStrokeBuffer._tmp;
      if (tmp.width !== canvasW || tmp.height !== canvasH) {
        tmp.width = canvasW; tmp.height = canvasH;
      }
      const tctx = tmp.getContext('2d');
      tctx.clearRect(0, 0, canvasW, canvasH);
      tctx.drawImage(l.canvas, 0, 0);
      tctx.save();
      if (selectionPath) tctx.clip(selectionPath, selectionFillRule);
      if (currentTool === 'eraser') {
        tctx.globalCompositeOperation = 'destination-out';
      }
      tctx.globalAlpha = opacity;
      tctx.drawImage(strokeBuffer, 0, 0);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = 'source-over';
      tctx.restore();
      compositeCtx.drawImage(tmp, 0, 0);

      if (floatingActive && floatingCanvas) {
        compositeCtx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y);
      }
      if (pxTransformActive && pxTransformData) {
        const _s = pxTransformData.srcCanvas, _b = pxTransformData.curBounds;
        const _rot = (pxTransformData.totalRotation || 0) + (pxTransformData.liveRotation || 0);
        if (_rot) {
          const _cx = _b.x + _b.w / 2, _cy = _b.y + _b.h / 2;
          compositeCtx.save();
          compositeCtx.translate(_cx, _cy);
          compositeCtx.rotate(_rot);
          compositeCtx.drawImage(_s, 0, 0, _s.width, _s.height, -_b.w / 2, -_b.h / 2, _b.w, _b.h);
          compositeCtx.restore();
        } else {
          compositeCtx.drawImage(_s, 0, 0, _s.width, _s.height, _b.x, _b.y, _b.w, _b.h);
        }
      }
    } else {
      compositeCtx.drawImage(l.canvas, 0, 0);
    }
  }
  compositeCtx.globalAlpha = 1;
}

// ── Screen-space overlay helpers ──────────────────────────────────────────────

function prepareOverlay() {
  const ws = workspace.getBoundingClientRect();
  const w = Math.round(ws.width);
  const h = Math.round(ws.height);
  const dpr = window.devicePixelRatio || 1;
  if (overlayCanvas.width !== w * dpr || overlayCanvas.height !== h * dpr) {
    overlayCanvas.width = w * dpr;
    overlayCanvas.height = h * dpr;
    overlayCanvas.style.width = w + 'px';
    overlayCanvas.style.height = h + 'px';
  }
  overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  overlayCtx.clearRect(0, 0, w, h);
}

function pathToScreen(path) {
  const sp = new Path2D();
  sp.addPath(path, new DOMMatrix([zoom, 0, 0, zoom, panX, panY]));
  return sp;
}

// ── Marching ants selection outline ──────────────────────────────────────────

function drawAntsOnPath(ctx, path) {
  if (!path) return;
  const sp = pathToScreen(path);
  ctx.save(); ctx.lineWidth = 1;
  ctx.strokeStyle = '#000000'; ctx.setLineDash([]); ctx.stroke(sp);
  ctx.strokeStyle = '#ffffff'; ctx.setLineDash([5, 5]);
  ctx.lineDashOffset = -marchingAntsOffset * 0.8; ctx.stroke(sp);
  ctx.setLineDash([]); ctx.restore();
}

// ── Main overlay compositor ───────────────────────────────────────────────────

function drawOverlay() {
  prepareOverlay();
  if (isDrawingSelection) {
    // Magnetic lasso has its own overlay rendering
    if (currentTool==='lasso' && lassoMode==='magnetic' && magActive) {
      drawMagneticOverlay();
      return;
    }
    if (drawingPreviewPath) drawAntsOnPath(overlayCtx, drawingPreviewPath);
    if (selectionMode !== 'new' && selectionPath) drawAntsOnPath(overlayCtx, selectionPath);
    SnapEngine.drawIndicators(overlayCtx);
    return;
  }
  if (selectionPath) {
    if (pxTransformActive && pxTransformData) {
      const d = pxTransformData; const cb = d.curBounds;
      const _anyRot = (d.totalRotation || 0) + (d.liveRotation || 0);
      if (_anyRot) {
        // Any rotation (accumulated or in-progress) makes axis-aligned ants
        // fight the rotated box. drawPxTransformHandles already renders the
        // rotated outline — let it speak for itself.
      } else if (d.isIrregular && d.origSelPath) {
        const sb = d.srcBounds; const sx = cb.w / sb.w, sy = cb.h / sb.h;
        const m = new DOMMatrix([sx, 0, 0, sy, cb.x - sb.x * sx, cb.y - sb.y * sy]);
        const scaledPath = new Path2D(); scaledPath.addPath(d.origSelPath, m);
        drawAntsOnPath(overlayCtx, scaledPath);
      } else { const tPath = new Path2D(); tPath.rect(cb.x, cb.y, cb.w, cb.h); drawAntsOnPath(overlayCtx, tPath); }
    } else if (floatingActive) {
      const fPath = new Path2D();
      fPath.addPath(selectionPath, new DOMMatrix([1, 0, 0, 1, floatingOffset.x, floatingOffset.y]));
      drawAntsOnPath(overlayCtx, fPath);
    } else { drawAntsOnPath(overlayCtx, selectionPath); }
  } else if (pxTransformActive && pxTransformData &&
             !((pxTransformData.totalRotation || 0) + (pxTransformData.liveRotation || 0))) {
    const cb = pxTransformData.curBounds; const tPath = new Path2D(); tPath.rect(cb.x, cb.y, cb.w, cb.h); drawAntsOnPath(overlayCtx, tPath);
  }
  if (transformSelActive && selection) { const b = getSelectionBounds(); if (b && b.w > 0 && b.h > 0) drawMoveSelHandles(b); }
  if (gradActive && currentTool === 'gradient') drawGradientUI();
  if (pxTransformActive && currentTool === 'move') drawPxTransformHandles();
  SnapEngine.drawIndicators(overlayCtx);
  if (!_antsTickInProgress) updatePropertiesPanel();
}

function drawMoveSelHandles(b) {
  const p1 = c2s(b.x, b.y); const p2 = c2s(b.x + b.w, b.y + b.h);
  const sx = p1.x, sy = p1.y, sw = p2.x - p1.x, sh = p2.y - p1.y;
  const hr = 4.5; const ctx = overlayCtx;
  ctx.save();
  if (selectionPath) { const sp = pathToScreen(selectionPath); ctx.globalAlpha = 0.10; ctx.fillStyle = '#6aaeff'; ctx.fill(sp, selectionFillRule); ctx.globalAlpha = 1; }
  if (selection && selection.type !== 'rect') { ctx.strokeStyle = 'rgba(100, 170, 255, 0.45)'; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.strokeRect(sx, sy, sw, sh); }
  const handles = [[sx,sy],[sx+sw/2,sy],[sx+sw,sy],[sx,sy+sh/2],[sx+sw,sy+sh/2],[sx,sy+sh],[sx+sw/2,sy+sh],[sx+sw,sy+sh]];
  ctx.lineWidth = 1.2;
  for (const [hx, hy] of handles) { ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.strokeStyle = '#333333'; ctx.stroke(); }
  ctx.restore();
}

// ── Pixel Transform handles ───────────────────────────────────────────────────

function drawPxTransformHandles() {
  if (!pxTransformActive || !pxTransformData) return;
  const b = pxTransformData.curBounds;
  const rot = (pxTransformData.totalRotation || 0) + (pxTransformData.liveRotation || 0);
  const p1 = c2s(b.x, b.y); const p2 = c2s(b.x + b.w, b.y + b.h);
  const sx = p1.x, sy = p1.y, sw = p2.x - p1.x, sh = p2.y - p1.y;
  const cxS = sx + sw / 2, cyS = sy + sh / 2;
  const hs = 4; const ctx = overlayCtx;
  ctx.save();
  if (rot) { ctx.translate(cxS, cyS); ctx.rotate(rot); ctx.translate(-cxS, -cyS); }
  // Thin outline: always drawn for irregular selections; also drawn whenever
  // the transform has any rotation so the rotated bounding box is visible.
  if (pxTransformData.isIrregular || rot) {
    ctx.strokeStyle = 'rgba(100, 170, 255, 0.55)';
    ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.strokeRect(sx, sy, sw, sh);
  }
  const handles = [[sx,sy],[sx+sw/2,sy],[sx+sw,sy],[sx,sy+sh/2],[sx+sw,sy+sh/2],[sx,sy+sh],[sx+sw/2,sy+sh],[sx+sw,sy+sh]];
  ctx.lineWidth = 1.2;
  for (const [hx, hy] of handles) { ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#333333'; ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2); ctx.strokeRect(hx - hs, hy - hs, hs * 2, hs * 2); }
  // Rotation-zone affordances at the 4 center-edge positions. Hidden only
  // during an active drag — they should remain visible after a rotation so
  // the user can keep rotating without losing the affordance.
  if (!pxTransformHandle) {
    const off = 18;
    const rotCenters = [
      [cxS, sy - off], [cxS, sy + sh + off],
      [sx - off, cyS], [sx + sw + off, cyS],
    ];
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    for (const [rx, ry] of rotCenters) {
      ctx.beginPath(); ctx.arc(rx, ry, 3, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.restore();
  // Angle tooltip while actively rotating (drawn unrotated on top).
  if (pxTransformHandle === 'rotate' && rot) {
    drawRotationAngleTooltip(rot);
  }
}

/**
 * Small HUD label showing the current rotation angle in degrees, drawn
 * near the top-right of the (rotated) bounding box. Kept on-screen via
 * viewport clamping so it never drifts off the workspace.
 */
function drawRotationAngleTooltip(rotRad) {
  if (!pxTransformData) return;
  const b = pxTransformData.curBounds;
  // Anchor near the box center, offset toward the top-right, in screen px.
  const cxC = b.x + b.w / 2, cyC = b.y + b.h / 2;
  const anchorC = c2s(cxC, cyC);
  const radius = (Math.min(b.w, b.h) / 2 + 28) * zoom;
  // Label angle follows rotation so it visually "orbits" the box.
  const la = rotRad - Math.PI / 2; // start above, rotating with the box
  let lx = anchorC.x + Math.cos(la) * radius;
  let ly = anchorC.y + Math.sin(la) * radius;
  let deg = rotRad * 180 / Math.PI;
  // Normalize to (-180, 180]
  while (deg >   180) deg -= 360;
  while (deg <= -180) deg += 360;
  const txt = (deg >= 0 ? '+' : '') + deg.toFixed(1) + '°';
  const ctx = overlayCtx;
  ctx.save();
  ctx.font = '600 11px system-ui, -apple-system, Segoe UI, sans-serif';
  const metrics = ctx.measureText(txt);
  const padX = 7, padY = 4;
  const tw = metrics.width + padX * 2;
  const th = 16 + padY * 0;
  // Clamp to overlay bounds so the tooltip never leaves the viewport.
  lx = Math.max(4, Math.min(overlayCanvas.width  - tw - 4, lx - tw / 2));
  ly = Math.max(4, Math.min(overlayCanvas.height - th - 4, ly - th / 2));
  ctx.fillStyle = 'rgba(20,22,28,0.92)';
  ctx.strokeStyle = 'rgba(100,170,255,0.65)';
  ctx.lineWidth = 1;
  const r = 4;
  ctx.beginPath();
  ctx.moveTo(lx + r, ly);
  ctx.lineTo(lx + tw - r, ly);
  ctx.quadraticCurveTo(lx + tw, ly, lx + tw, ly + r);
  ctx.lineTo(lx + tw, ly + th - r);
  ctx.quadraticCurveTo(lx + tw, ly + th, lx + tw - r, ly + th);
  ctx.lineTo(lx + r, ly + th);
  ctx.quadraticCurveTo(lx, ly + th, lx, ly + th - r);
  ctx.lineTo(lx, ly + r);
  ctx.quadraticCurveTo(lx, ly, lx + r, ly);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#e9f1ff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(txt, lx + padX, ly + th / 2 + 0.5);
  ctx.restore();
}

// ── Gradient editor overlay ───────────────────────────────────────────────────

function drawGradientUI() {
  if (!gradP1 || !gradP2 || gradStops.length < 2) return;
  const ctx = overlayCtx;
  const sp1 = c2s(gradP1.x, gradP1.y);
  const sp2 = c2s(gradP2.x, gradP2.y);
  const lw = 1.5; const r = 7; const dr = 5;
  ctx.save();
  // draw line
  ctx.beginPath(); ctx.moveTo(sp1.x, sp1.y); ctx.lineTo(sp2.x, sp2.y);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = lw * 3; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = lw; ctx.stroke();
  // draw midpoint diamonds
  for (let i = 0; i < gradStops.length - 1; i++) {
    const s0 = gradStops[i], s1 = gradStops[i + 1];
    const midT = s0.t + (s1.t - s0.t) * (s0.mid || 0.5);
    const mp = c2s(gradP1.x + (gradP2.x - gradP1.x) * midT, gradP1.y + (gradP2.y - gradP1.y) * midT);
    const isHov = gradHoverElement && gradHoverElement.type === 'mid' && gradHoverElement.index === i;
    const dp = isHov ? dr * 1.3 : dr;
    ctx.beginPath(); ctx.moveTo(mp.x, mp.y - dp); ctx.lineTo(mp.x + dp, mp.y); ctx.lineTo(mp.x, mp.y + dp); ctx.lineTo(mp.x - dp, mp.y); ctx.closePath();
    if (isHov) { ctx.shadowColor = 'rgba(255,255,255,0.6)'; ctx.shadowBlur = 6; }
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = lw; ctx.stroke();
  }
  // draw stop handles
  for (let i = 0; i < gradStops.length; i++) {
    const s = gradStops[i];
    const sp = c2s(gradP1.x + (gradP2.x - gradP1.x) * s.t, gradP1.y + (gradP2.y - gradP1.y) * s.t);
    const isHov = gradHoverElement && gradHoverElement.type === 'stop' && gradHoverElement.index === i;
    const isDeleting = gradStopAboutToDelete && gradDragging && gradDragging.type === 'stop' && gradDragging.index === i;
    const rs = isHov ? r * 1.15 : r;
    ctx.globalAlpha = isDeleting ? 0.35 : 1;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, rs, 0, Math.PI * 2);
    ctx.fillStyle = s.color; ctx.fill();
    const isEndpoint = (i === 0 || i === gradStops.length - 1);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = isEndpoint ? lw * 2.5 : lw * 1.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = lw; ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ── Magnetic lasso overlay ────────────────────────────────────────────────────

/**
 * Draw magnetic lasso overlay: committed path + live wire + anchor dots.
 */
function drawMagneticOverlay() {
  prepareOverlay();
  if (selectionMode !== 'new' && selectionPath) drawAntsOnPath(overlayCtx, selectionPath);

  const previewPath = magBuildPreviewPath();
  drawAntsOnPath(overlayCtx, previewPath);

  // Anchor dots
  overlayCtx.save();
  overlayCtx.fillStyle = '#fff';
  overlayCtx.strokeStyle = '#000';
  overlayCtx.lineWidth = 1;
  for (let i = 0; i < magAnchors.length; i++) {
    const sp = c2s(magAnchors[i].x, magAnchors[i].y);
    const r = i === 0 ? 4 : 3; // First anchor slightly larger
    overlayCtx.beginPath();
    overlayCtx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    overlayCtx.fill();
    overlayCtx.stroke();
  }
  overlayCtx.restore();
}

// ── Canvas rulers ─────────────────────────────────────────────────────────────

// Ruler colors are canvas-drawn — read live from CSS variables so the
// ThemeManager drives them automatically (no reassignment needed).
function getRulerColors() {
  const s = getComputedStyle(document.documentElement);
  return {
    bg:        s.getPropertyValue('--bg-secondary').trim() || '#242428',
    tick:      s.getPropertyValue('--ruler-tick').trim()   || 'rgba(200,200,200,0.5)',
    text:      s.getPropertyValue('--ruler-text').trim()   || 'rgba(200,200,200,0.55)',
    indicator: s.getPropertyValue('--accent').trim()       || '#007aff'
  };
}

function getRulerInterval() {
  const steps = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const targetScreen = 80;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] * zoom >= targetScreen) return steps[i];
  }
  return steps[steps.length - 1];
}

function drawRulers() {
  if (!rulersVisible) return;
  const { bg: RULER_BG, tick: RULER_TICK, text: RULER_TEXT, indicator: RULER_INDICATOR } = getRulerColors();

  const dpr = window.devicePixelRatio || 1;
  const wsRect = _getWsRect();
  const hW = Math.round(wsRect.width - RULER_SIZE);
  const vH = Math.round(wsRect.height - RULER_SIZE);

  // Resize canvases if needed (account for DPR for crisp rendering)
  if (rulerH.width !== hW * dpr || rulerH.height !== RULER_SIZE * dpr) {
    rulerH.width = hW * dpr;
    rulerH.height = RULER_SIZE * dpr;
    rulerH.style.width = hW + 'px';
    rulerH.style.height = RULER_SIZE + 'px';
  }
  if (rulerV.width !== RULER_SIZE * dpr || rulerV.height !== vH * dpr) {
    rulerV.width = RULER_SIZE * dpr;
    rulerV.height = vH * dpr;
    rulerV.style.width = RULER_SIZE + 'px';
    rulerV.style.height = vH + 'px';
  }

  const interval = getRulerInterval();
  const sub = interval >= 10 ? 10 : interval >= 5 ? 5 : interval >= 2 ? 4 : 2;
  const subSize = interval / sub;

  // ── Horizontal ruler ──
  rulerHCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rulerHCtx.clearRect(0, 0, hW, RULER_SIZE);
  rulerHCtx.fillStyle = RULER_BG;
  rulerHCtx.fillRect(0, 0, hW, RULER_SIZE);

  // The screen x position for canvas coordinate 0 is: panX (relative to workspace)
  // But the horizontal ruler starts at RULER_SIZE from workspace left,
  // so offset is panX - RULER_SIZE
  const hOffset = panX - RULER_SIZE;

  // Find range of canvas coords visible in the ruler
  const canvasXStart = (-hOffset) / zoom;
  const canvasXEnd = (hW - hOffset) / zoom;

  // Find first major tick before visible range
  const firstMajor = Math.floor(canvasXStart / interval) * interval;

  rulerHCtx.fillStyle = RULER_TEXT;
  rulerHCtx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  rulerHCtx.textBaseline = 'top';

  for (let val = firstMajor; val <= canvasXEnd; val += subSize) {
    const screenX = val * zoom + hOffset;
    if (screenX < -1 || screenX > hW + 1) continue;

    const roundedVal = Math.round(val * 1000) / 1000;
    const isMajor = Math.abs(roundedVal % interval) < 0.001;
    const isHalf = !isMajor && sub >= 4 && Math.abs(roundedVal % (interval / 2)) < 0.001;

    const tickH = isMajor ? 12 : isHalf ? 8 : 4;
    const x = Math.round(screenX) + 0.5;

    rulerHCtx.strokeStyle = RULER_TICK;
    rulerHCtx.lineWidth = 1;
    rulerHCtx.beginPath();
    rulerHCtx.moveTo(x, RULER_SIZE);
    rulerHCtx.lineTo(x, RULER_SIZE - tickH);
    rulerHCtx.stroke();

    if (isMajor) {
      const label = Math.round(roundedVal).toString();
      rulerHCtx.fillStyle = RULER_TEXT;
      rulerHCtx.fillText(label, screenX + 2, 2);
    }
  }

  // Mouse indicator on horizontal ruler
  if (rulerMouseX >= RULER_SIZE && rulerMouseX >= 0) {
    const ix = Math.round(rulerMouseX - RULER_SIZE) + 0.5;
    rulerHCtx.strokeStyle = RULER_INDICATOR;
    rulerHCtx.lineWidth = 1;
    rulerHCtx.beginPath();
    rulerHCtx.moveTo(ix, 0);
    rulerHCtx.lineTo(ix, RULER_SIZE);
    rulerHCtx.stroke();
  }

  // ── Vertical ruler ──
  rulerVCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rulerVCtx.clearRect(0, 0, RULER_SIZE, vH);
  rulerVCtx.fillStyle = RULER_BG;
  rulerVCtx.fillRect(0, 0, RULER_SIZE, vH);

  const vOffset = panY - RULER_SIZE;

  const canvasYStart = (-vOffset) / zoom;
  const canvasYEnd = (vH - vOffset) / zoom;
  const firstMajorY = Math.floor(canvasYStart / interval) * interval;

  rulerVCtx.fillStyle = RULER_TEXT;
  rulerVCtx.font = '9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

  for (let val = firstMajorY; val <= canvasYEnd; val += subSize) {
    const screenY = val * zoom + vOffset;
    if (screenY < -1 || screenY > vH + 1) continue;

    const roundedVal = Math.round(val * 1000) / 1000;
    const isMajor = Math.abs(roundedVal % interval) < 0.001;
    const isHalf = !isMajor && sub >= 4 && Math.abs(roundedVal % (interval / 2)) < 0.001;

    const tickH = isMajor ? 12 : isHalf ? 8 : 4;
    const y = Math.round(screenY) + 0.5;

    rulerVCtx.strokeStyle = RULER_TICK;
    rulerVCtx.lineWidth = 1;
    rulerVCtx.beginPath();
    rulerVCtx.moveTo(RULER_SIZE, y);
    rulerVCtx.lineTo(RULER_SIZE - tickH, y);
    rulerVCtx.stroke();

    if (isMajor) {
      const label = Math.round(roundedVal).toString();
      rulerVCtx.save();
      rulerVCtx.translate(2, screenY + 2);
      rulerVCtx.rotate(-Math.PI / 2);
      rulerVCtx.fillStyle = RULER_TEXT;
      rulerVCtx.textBaseline = 'top';
      rulerVCtx.fillText(label, 0, 0);
      rulerVCtx.restore();
    }
  }

  // Mouse indicator on vertical ruler
  if (rulerMouseY >= RULER_SIZE && rulerMouseY >= 0) {
    const iy = Math.round(rulerMouseY - RULER_SIZE) + 0.5;
    rulerVCtx.strokeStyle = RULER_INDICATOR;
    rulerVCtx.lineWidth = 1;
    rulerVCtx.beginPath();
    rulerVCtx.moveTo(0, iy);
    rulerVCtx.lineTo(RULER_SIZE, iy);
    rulerVCtx.stroke();
  }
}

// ── Guides overlay ────────────────────────────────────────────────────────────

function drawGuides() {
  const dpr = window.devicePixelRatio || 1;
  const wsRect = workspace.getBoundingClientRect();
  const w = Math.round(wsRect.width);
  const h = Math.round(wsRect.height);

  if (guideOverlay.width !== w * dpr || guideOverlay.height !== h * dpr) {
    guideOverlay.width = w * dpr;
    guideOverlay.height = h * dpr;
    guideOverlay.style.width = w + 'px';
    guideOverlay.style.height = h + 'px';
  }

  guideOverlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  guideOverlayCtx.clearRect(0, 0, w, h);

  if (!guidesVisible || guides.length === 0) return;

  for (const g of guides) {
    const isSelected = (g === selectedGuide) || (draggingGuide && g === draggingGuide.guide);
    guideOverlayCtx.strokeStyle = isSelected ? GUIDE_COLOR_SELECTED : GUIDE_COLOR;
    guideOverlayCtx.lineWidth = 1;
    guideOverlayCtx.setLineDash([]);

    if (g.axis === 'v') {
      const sx = Math.round(g.pos * zoom + panX) + 0.5;
      guideOverlayCtx.beginPath();
      guideOverlayCtx.moveTo(sx, 0);
      guideOverlayCtx.lineTo(sx, h);
      guideOverlayCtx.stroke();
    } else {
      const sy = Math.round(g.pos * zoom + panY) + 0.5;
      guideOverlayCtx.beginPath();
      guideOverlayCtx.moveTo(0, sy);
      guideOverlayCtx.lineTo(w, sy);
      guideOverlayCtx.stroke();
    }
  }
}

// ── UI overlay (ruler tool, screen-space measurement) ─────────────────────────

function drawUIOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const wsRect = workspace.getBoundingClientRect();
  const w = Math.round(wsRect.width);
  const h = Math.round(wsRect.height);

  if (uiOverlay.width !== w * dpr || uiOverlay.height !== h * dpr) {
    uiOverlay.width = w * dpr;
    uiOverlay.height = h * dpr;
    uiOverlay.style.width = w + 'px';
    uiOverlay.style.height = h + 'px';
  }

  uiOverlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  uiOverlayCtx.clearRect(0, 0, w, h);

  if (!rulerState.active) return;

  const p1 = _rulerCanvasToScreen(rulerState.x1, rulerState.y1);
  const p2 = _rulerCanvasToScreen(rulerState.x2, rulerState.y2);

  // ── Line: single solid 3px accent stroke ──
  uiOverlayCtx.save();
  uiOverlayCtx.lineCap = 'butt';
  uiOverlayCtx.lineJoin = 'miter';

  uiOverlayCtx.strokeStyle = RULER_COLOR;
  uiOverlayCtx.lineWidth = 2;
  uiOverlayCtx.beginPath();
  uiOverlayCtx.moveTo(p1.sx, p1.sy);
  uiOverlayCtx.lineTo(p2.sx, p2.sy);
  uiOverlayCtx.stroke();

  // ── Endpoint handles: transparent fill, blue outline, black crosshair ──
  const hs = RULER_HANDLE_SIZE;
  const half = Math.floor(hs / 2); // 4 for 900px

  for (const p of [p1, p2]) {
    // Crisp pixel alignment: align rect corner to integer grid
    const cx = Math.round(p.sx);
    const cy = Math.round(p.sy);
    const rx = cx - half;
    const ry = cy - half;

    // Accent outline only (no fill so the pixel beneath is visible)
    uiOverlayCtx.strokeStyle = RULER_COLOR;
    uiOverlayCtx.lineWidth = 1;
    uiOverlayCtx.strokeRect(rx + 0.5, ry + 0.5, hs - 1, hs - 1);

    // Black 1px crosshair glyph through the center pixel
    uiOverlayCtx.strokeStyle = RULER_CROSSHAIR;
    uiOverlayCtx.lineWidth = 0.5;
    uiOverlayCtx.beginPath();
    uiOverlayCtx.moveTo(rx + 0.5,       cy + 0.5);
    uiOverlayCtx.lineTo(rx + hs - 0.5,  cy + 0.5);
    uiOverlayCtx.moveTo(cx + 0.5,       ry + 0.5);
    uiOverlayCtx.lineTo(cx + 0.5,       ry + hs - 0.5);
    uiOverlayCtx.stroke();
  }
  uiOverlayCtx.restore();
}
