'use strict';

/* ═══════════════════════════════════════════════════════
   SELECTION TOOLS — Select, Lasso (free/poly/magnetic), Magic Wand
   Depends on: script.js (buildSelectionPath, commitNewSelection, etc.)
   ═══════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════
   MAGIC WAND — Tolerance-based Selection
   ═══════════════════════════════════════════════════════ */

function magicWandSelect(startX, startY, tolerance, contiguous) {
  const layer = getActiveLayer();
  if (!layer) return null;
  const w = canvasW, h = canvasH;
  const sx = Math.floor(startX), sy = Math.floor(startY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const imgData = layer.ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const tol = Math.max(0, Math.min(255, Math.floor(tolerance)));
  const ti = (sy * w + sx) * 4;
  const tR = data[ti], tG = data[ti + 1], tB = data[ti + 2], tA = data[ti + 3];
  const mask = new Uint8Array(w * h);
  function matches(pos) {
    const i = pos * 4;
    return Math.abs(data[i] - tR) <= tol && Math.abs(data[i+1] - tG) <= tol && Math.abs(data[i+2] - tB) <= tol && Math.abs(data[i+3] - tA) <= tol;
  }
  if (contiguous) {
    const visited = new Uint8Array(w * h);
    if (!matches(sx + sy * w)) return null;
    let sl = sx, sr = sx;
    while (sl > 0 && !visited[sy * w + sl - 1] && matches(sy * w + sl - 1)) sl--;
    while (sr < w - 1 && !visited[sy * w + sr + 1] && matches(sy * w + sr + 1)) sr++;
    const stack = [];
    for (let x = sl; x <= sr; x++) { const pos = sy * w + x; visited[pos] = 1; mask[pos] = 1; }
    stack.push([sy, sl, sr]);
    function scanLine(y, parentLeft, parentRight) {
      if (y < 0 || y >= h) return;
      let x = parentLeft;
      while (x <= parentRight) {
        const pos = y * w + x;
        if (visited[pos] || !matches(pos)) { x++; continue; }
        let left = x, right = x;
        while (left > 0 && !visited[y * w + left - 1] && matches(y * w + left - 1)) left--;
        while (right < w - 1 && !visited[y * w + right + 1] && matches(y * w + right + 1)) right++;
        for (let fx = left; fx <= right; fx++) { const fpos = y * w + fx; visited[fpos] = 1; mask[fpos] = 1; }
        stack.push([y, left, right]);
        x = right + 1;
      }
    }
    while (stack.length > 0) { const [cy, cl, cr] = stack.pop(); scanLine(cy - 1, cl, cr); scanLine(cy + 1, cl, cr); }
  } else {
    for (let i = 0; i < w * h; i++) { if (matches(i)) mask[i] = 1; }
  }
  const contours = maskToContours(mask, w, h);
  if (contours.length === 0) return null;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (const poly of contours) { for (const p of poly) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; } }
  return { contours: contours, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/* ═══════════════════════════════════════════════════════
   MASK CONTOUR TRACING
   ═══════════════════════════════════════════════════════ */

function maskToContours(mask, w, h) {
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) {
      const x = i % w, y = (i / w) | 0;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
    }
  }
  if (bx1 < 0) return [];

  const stride = w + 1;
  const edgeMap = new Map();
  function addEdge(fx, fy, tx, ty) {
    const k = fy * stride + fx;
    let arr = edgeMap.get(k);
    if (!arr) { arr = []; edgeMap.set(k, arr); }
    arr.push({ x: tx, y: ty, used: false });
  }

  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      if (!mask[y * w + x]) continue;
      if (y === 0     || !mask[(y - 1) * w + x])     addEdge(x, y, x + 1, y);
      if (x === w - 1 || !mask[y * w + x + 1])       addEdge(x + 1, y, x + 1, y + 1);
      if (y === h - 1 || !mask[(y + 1) * w + x])     addEdge(x + 1, y + 1, x, y + 1);
      if (x === 0     || !mask[y * w + x - 1])       addEdge(x, y + 1, x, y);
    }
  }

  function turnRank(inDx, inDy, outDx, outDy) {
    const cross = inDx * outDy - inDy * outDx;
    const dot   = inDx * outDx + inDy * outDy;
    if (cross > 0) return 0; if (cross === 0 && dot > 0) return 1; if (cross < 0) return 2; return 3;
  }

  const contours = [];
  for (const [startKey, startEdges] of edgeMap) {
    for (let si = 0; si < startEdges.length; si++) {
      if (startEdges[si].used) continue;
      startEdges[si].used = true;
      const originX = startKey % stride;
      const originY = (startKey / stride) | 0;
      const poly = [{ x: originX, y: originY }];
      let prevX = originX, prevY = originY;
      let cx = startEdges[si].x, cy = startEdges[si].y;
      let safety = (w + h) * 4 + edgeMap.size * 2;
      while ((cx !== originX || cy !== originY) && safety-- > 0) {
        poly.push({ x: cx, y: cy });
        const edges = edgeMap.get(cy * stride + cx);
        if (!edges) break;
        const inDx = cx - prevX, inDy = cy - prevY;
        let bestIdx = -1, bestRank = 999;
        for (let i = 0; i < edges.length; i++) {
          if (edges[i].used) continue;
          const rank = turnRank(inDx, inDy, edges[i].x - cx, edges[i].y - cy);
          if (rank < bestRank) { bestRank = rank; bestIdx = i; }
        }
        if (bestIdx === -1) break;
        edges[bestIdx].used = true;
        prevX = cx; prevY = cy;
        cx = edges[bestIdx].x; cy = edges[bestIdx].y;
      }
      if (poly.length >= 3) contours.push(simplifyContour(poly));
    }
  }
  return contours;
}

function simplifyContour(poly) {
  if (poly.length < 3) return poly;
  const out = [];
  const len = poly.length;
  for (let i = 0; i < len; i++) {
    const prev = poly[(i - 1 + len) % len];
    const curr = poly[i];
    const next = poly[(i + 1) % len];
    const collinearX = (prev.x === curr.x && curr.x === next.x);
    const collinearY = (prev.y === curr.y && curr.y === next.y);
    if (!collinearX && !collinearY) out.push(curr);
  }
  return out.length >= 3 ? out : poly;
}

function contoursToPath(contours) {
  const path = new Path2D();
  for (const poly of contours) {
    if (poly.length < 3) continue;
    path.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) path.lineTo(poly[i].x, poly[i].y);
    path.closePath();
  }
  return path;
}

/* ═══════════════════════════════════════════════════════
   SELECTION SHAPE HELPERS
   ═══════════════════════════════════════════════════════ */

function makeShapePath(shape, sx, sy, sw, sh) {
  const p = new Path2D();
  if (shape === 'rect') p.rect(sx, sy, sw, sh);
  else if (shape === 'ellipse' && sw > 0 && sh > 0) p.ellipse(sx + sw / 2, sy + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
  return p;
}

function constrainSelectBounds(startX, startY, endX, endY, shiftKey, altKey) {
  let dx = endX - startX, dy = endY - startY;
  if (shiftKey) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx) * side;
    dy = Math.sign(dy) * side;
  }
  let sx, sy, sw, sh;
  if (altKey) {
    sw = Math.round(Math.abs(dx) * 2);
    sh = Math.round(Math.abs(dy) * 2);
    sx = Math.round(startX - Math.abs(dx));
    sy = Math.round(startY - Math.abs(dy));
  } else {
    sx = Math.round(Math.min(startX, startX + dx));
    sy = Math.round(Math.min(startY, startY + dy));
    sw = Math.round(Math.abs(dx));
    sh = Math.round(Math.abs(dy));
  }
  return { sx, sy, sw, sh };
}

/* ═══════════════════════════════════════════════════════
   SELECTION TRANSFORM HANDLES
   ═══════════════════════════════════════════════════════ */

function getTransformHandle(px, py) {
  if (!transformSelActive) return null;
  const b = getSelectionBounds(); if (!b || b.w < 1) return null;
  const {x, y, w, h} = b; const t = 8 / zoom;
  const handles = [{n:'nw',hx:x,hy:y},{n:'n',hx:x+w/2,hy:y},{n:'ne',hx:x+w,hy:y},{n:'w',hx:x,hy:y+h/2},{n:'e',hx:x+w,hy:y+h/2},{n:'sw',hx:x,hy:y+h},{n:'s',hx:x+w/2,hy:y+h},{n:'se',hx:x+w,hy:y+h}];
  for (const h of handles) { if (Math.abs(px - h.hx) <= t && Math.abs(py - h.hy) <= t) return h.n; }
  if (px >= x && px <= x + w && py >= y && py <= y + h) return 'move';
  return null;
}

function applyTransformDelta(handle, dx, dy) {
  if (!selection) return;
  const b = getSelectionBounds(); if (!b) return;
  let {x, y, w, h} = b;
  if (handle === 'move') { x += dx; y += dy; }
  else if (handle === 'nw') { x += dx; y += dy; w -= dx; h -= dy; } else if (handle === 'n') { y += dy; h -= dy; } else if (handle === 'ne') { w += dx; y += dy; h -= dy; }
  else if (handle === 'w') { x += dx; w -= dx; } else if (handle === 'e') { w += dx; } else if (handle === 'sw') { x += dx; w -= dx; h += dy; }
  else if (handle === 's') { h += dy; } else if (handle === 'se') { w += dx; h += dy; }
  if (w < 1) { x += w; w = Math.abs(w) || 1; } if (h < 1) { y += h; h = Math.abs(h) || 1; }
  if (selection.type === 'lasso' && selection.points) {
    if (b.w > 0 && b.h > 0) { const sx = w / b.w, sy = h / b.h, ox = x - b.x * sx, oy = y - b.y * sy; selection.points = selection.points.map(p => ({x: p.x * sx + ox, y: p.y * sy + oy})); }
  } else if ((selection.type === 'wand' || selection.type === 'composite') && selection.contours) {
    if (b.w > 0 && b.h > 0) { const sx = w / b.w, sy = h / b.h, ox = x - b.x * sx, oy = y - b.y * sy; selection.contours = selection.contours.map(poly => poly.map(p => ({x: p.x * sx + ox, y: p.y * sy + oy}))); }
  } else { selection.x = x; selection.y = y; selection.w = w; selection.h = h; }
  buildSelectionPath(); drawOverlay();
}

/* ═══════════════════════════════════════════════════════
   POLYGONAL LASSO — Finish
   ═══════════════════════════════════════════════════════ */

function finishPolygonalLasso() {
  if (polyPoints.length < 3) {
    polyPoints = []; isDrawingSelection = false; drawingPreviewPath = null;
    drawOverlay(); return;
  }
  const p = new Path2D();
  p.moveTo(Math.round(polyPoints[0].x), Math.round(polyPoints[0].y));
  for (let i = 1; i < polyPoints.length; i++) p.lineTo(Math.round(polyPoints[i].x), Math.round(polyPoints[i].y));
  p.closePath();
  commitNewSelection(p, {type: 'lasso', points: polyPoints.map(pt => ({x: Math.round(pt.x), y: Math.round(pt.y)}))});
  polyPoints = []; isDrawingSelection = false; drawingPreviewPath = null; drawOverlay();
}

function updatePolyPreviewPath(cursorX, cursorY) {
  if (polyPoints.length === 0) return;
  const p = new Path2D();
  p.moveTo(Math.round(polyPoints[0].x), Math.round(polyPoints[0].y));
  for (let i = 1; i < polyPoints.length; i++) p.lineTo(Math.round(polyPoints[i].x), Math.round(polyPoints[i].y));
  if (cursorX !== undefined) p.lineTo(Math.round(cursorX), Math.round(cursorY));
  drawingPreviewPath = p;
  prepareOverlay();
  if (selectionMode !== 'new' && selectionPath) drawAntsOnPath(overlayCtx, selectionPath);
  drawAntsOnPath(overlayCtx, p);
}

/* ═══════════════════════════════════════════════════════
   MAGNETIC LASSO — Intelligent Scissors Engine
   ═══════════════════════════════════════════════════════ */

function getMagWidth()     { return parseInt(document.getElementById('magWidthNum').value) || 10; }
function getMagContrast()  { return parseInt(document.getElementById('magContrastNum').value) || 50; }
function getMagFrequency() { return parseInt(document.getElementById('magFrequencyNum').value) || 57; }

function computeEdgeMap(rx, ry, rw, rh) {
  const layer = getActiveLayer();
  if (!layer) return;
  if (rx < 0) { rw += rx; rx = 0; }
  if (ry < 0) { rh += ry; ry = 0; }
  if (rx + rw > canvasW) rw = canvasW - rx;
  if (ry + rh > canvasH) rh = canvasH - ry;
  if (rw < 3 || rh < 3) return;

  const imgData = layer.ctx.getImageData(rx, ry, rw, rh);
  const rgba = imgData.data;
  const n = rw * rh;

  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    lum[i] = 0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2];
  }

  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  const mag = new Float32Array(n);
  let maxMag = 0;

  for (let y = 1; y < rh - 1; y++) {
    for (let x = 1; x < rw - 1; x++) {
      const tl = lum[(y - 1) * rw + x - 1], tc = lum[(y - 1) * rw + x], tr = lum[(y - 1) * rw + x + 1];
      const ml = lum[y * rw + x - 1],                                     mr = lum[y * rw + x + 1];
      const bl = lum[(y + 1) * rw + x - 1], bc = lum[(y + 1) * rw + x], br = lum[(y + 1) * rw + x + 1];
      const sx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const sy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const idx = y * rw + x;
      gx[idx] = sx;
      gy[idx] = sy;
      const m = Math.sqrt(sx * sx + sy * sy);
      mag[idx] = m;
      if (m > maxMag) maxMag = m;
    }
  }

  if (maxMag > 0) {
    const inv = 1 / maxMag;
    for (let i = 0; i < n; i++) mag[i] *= inv;
  }

  magEdgeMap = mag;
  magEdgeGx = gx;
  magEdgeGy = gy;
  magEdgeRegion = { x: rx, y: ry, w: rw, h: rh };
}

function ensureEdgeMapCoverage(ax, ay, cx, cy, width) {
  const margin = width + 4;
  const needX = Math.min(ax, cx) - margin;
  const needY = Math.min(ay, cy) - margin;
  const needR = Math.max(ax, cx) + margin;
  const needB = Math.max(ay, cy) + margin;

  if (magEdgeRegion &&
      magEdgeRegion.x <= needX && magEdgeRegion.y <= needY &&
      magEdgeRegion.x + magEdgeRegion.w >= needR &&
      magEdgeRegion.y + magEdgeRegion.h >= needB) {
    return;
  }

  let ex = needX, ey = needY, er = needR, eb = needB;
  if (magEdgeRegion) {
    ex = Math.min(ex, magEdgeRegion.x);
    ey = Math.min(ey, magEdgeRegion.y);
    er = Math.max(er, magEdgeRegion.x + magEdgeRegion.w);
    eb = Math.max(eb, magEdgeRegion.y + magEdgeRegion.h);
  }
  const pad = width * 3;
  computeEdgeMap(
    Math.floor(ex - pad), Math.floor(ey - pad),
    Math.ceil(er - ex + pad * 2), Math.ceil(eb - ey + pad * 2)
  );
}

function snapToNearestEdge(px, py, searchWidth) {
  if (!magEdgeMap || !magEdgeRegion) return { x: Math.round(px), y: Math.round(py) };
  const r = magEdgeRegion;
  const sw = Math.max(2, searchWidth);
  let bestX = Math.round(px), bestY = Math.round(py), bestMag = -1;

  const x0 = Math.max(r.x + 1, Math.round(px) - sw);
  const y0 = Math.max(r.y + 1, Math.round(py) - sw);
  const x1 = Math.min(r.x + r.w - 2, Math.round(px) + sw);
  const y1 = Math.min(r.y + r.h - 2, Math.round(py) + sw);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const idx = (y - r.y) * r.w + (x - r.x);
      const m = magEdgeMap[idx];
      if (m > bestMag) { bestMag = m; bestX = x; bestY = y; }
    }
  }
  return { x: bestX, y: bestY };
}

function MagHeap(capacity) {
  this.costs = new Float64Array(capacity);
  this.nodes = new Int32Array(capacity);
  this.size = 0;
}
MagHeap.prototype.push = function(node, cost) {
  let i = this.size++;
  this.costs[i] = cost;
  this.nodes[i] = node;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (this.costs[p] <= cost) break;
    this.costs[i] = this.costs[p]; this.nodes[i] = this.nodes[p];
    this.costs[p] = cost; this.nodes[p] = node;
    i = p;
  }
};
MagHeap.prototype.pop = function() {
  const cost = this.costs[0], node = this.nodes[0];
  this.size--;
  if (this.size > 0) {
    this.costs[0] = this.costs[this.size];
    this.nodes[0] = this.nodes[this.size];
    let i = 0;
    while (true) {
      let s = i, l = 2 * i + 1, r = 2 * i + 2;
      if (l < this.size && this.costs[l] < this.costs[s]) s = l;
      if (r < this.size && this.costs[r] < this.costs[s]) s = r;
      if (s === i) break;
      const tc = this.costs[i]; const tn = this.nodes[i];
      this.costs[i] = this.costs[s]; this.nodes[i] = this.nodes[s];
      this.costs[s] = tc; this.nodes[s] = tn;
      i = s;
    }
  }
  return { node, cost };
};

const _magDirs = [-1,-1, 0,-1, 1,-1, -1,0, 1,0, -1,1, 0,1, 1,1];
const _SQRT2 = 1.4142135623730951;

function computeLiveWire(ax, ay, cx, cy, searchWidth, contrast) {
  if (!magEdgeMap || !magEdgeRegion) return null;
  const r = magEdgeRegion;

  const margin = searchWidth + 2;
  const bx = Math.max(r.x + 1, Math.min(ax, cx) - margin);
  const by = Math.max(r.y + 1, Math.min(ay, cy) - margin);
  const bx2 = Math.min(r.x + r.w - 2, Math.max(ax, cx) + margin);
  const by2 = Math.min(r.y + r.h - 2, Math.max(ay, cy) + margin);
  const bw = bx2 - bx + 1;
  const bh = by2 - by + 1;
  if (bw < 2 || bh < 2) return null;
  const N = bw * bh;

  const sax = Math.max(bx, Math.min(bx2, ax));
  const say = Math.max(by, Math.min(by2, ay));
  const scx = Math.max(bx, Math.min(bx2, cx));
  const scy = Math.max(by, Math.min(by2, cy));

  const srcIdx = (say - by) * bw + (sax - bx);
  const dstIdx = (scy - by) * bw + (scx - bx);
  if (srcIdx === dstIdx) return [{ x: ax, y: ay }];

  if (N > _magBufCapacity) {
    const cap = Math.max(N, 65536);
    _magDist = new Float32Array(cap);
    _magPrev = new Int32Array(cap);
    _magVisited = new Uint8Array(cap);
    _magHeapCosts = new Float64Array(cap * 2);
    _magHeapNodes = new Int32Array(cap * 2);
    _magBufCapacity = cap;
  }
  const dist = _magDist;
  const prev = _magPrev;
  const visited = _magVisited;
  for (let i = 0; i < N; i++) { dist[i] = 1e30; prev[i] = -1; visited[i] = 0; }

  const threshold = (100 - contrast) / 100;

  const heap = new MagHeap(Math.min(N * 2, 262144));
  dist[srcIdx] = 0;
  heap.push(srcIdx, 0);

  while (heap.size > 0) {
    const { node, cost } = heap.pop();
    if (visited[node]) continue;
    visited[node] = 1;
    if (node === dstIdx) break;

    const nx = node % bw, ny = (node / bw) | 0;
    const canvasX = nx + bx, canvasY = ny + by;

    for (let d = 0; d < 16; d += 2) {
      const nnx = nx + _magDirs[d];
      const nny = ny + _magDirs[d + 1];
      if (nnx < 0 || nny < 0 || nnx >= bw || nny >= bh) continue;
      const nIdx = nny * bw + nnx;
      if (visited[nIdx]) continue;

      const ncx = nnx + bx, ncy = nny + by;
      const eIdx = (ncy - r.y) * r.w + (ncx - r.x);

      let rawMag = magEdgeMap[eIdx];
      rawMag = rawMag > threshold ? (rawMag - threshold) / (1 - threshold + 0.001) : 0;
      const edgeCost = 1 - rawMag;

      const egx = magEdgeGx[eIdx], egy = magEdgeGy[eIdx];
      let dirCost = 0;
      if (egx !== 0 || egy !== 0) {
        const edgeAngle = Math.atan2(-egx, egy);
        const linkAngle = Math.atan2(_magDirs[d + 1], _magDirs[d]);
        let angleDiff = Math.abs(linkAngle - edgeAngle);
        if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
        if (angleDiff > Math.PI / 2) angleDiff = Math.PI - angleDiff;
        dirCost = angleDiff / (Math.PI / 2);
      }

      const isDiag = (_magDirs[d] !== 0 && _magDirs[d + 1] !== 0);
      const stepCost = (0.43 * edgeCost + 0.43 * dirCost + 0.14) * (isDiag ? _SQRT2 : 1);

      const newDist = cost + stepCost;
      if (newDist < dist[nIdx]) {
        dist[nIdx] = newDist;
        prev[nIdx] = node;
        heap.push(nIdx, newDist);
      }
    }
  }

  if (!visited[dstIdx]) return null;
  const pts = [];
  let cur = dstIdx;
  while (cur !== -1) {
    const lx = cur % bw, ly = (cur / bw) | 0;
    pts.push({ x: lx + bx, y: ly + by });
    cur = prev[cur];
  }
  pts.reverse();

  if (pts.length > 3) {
    const simplified = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1], c = pts[i], n = pts[i + 1];
      const dx1 = c.x - p.x, dy1 = c.y - p.y;
      const dx2 = n.x - c.x, dy2 = n.y - c.y;
      if (dx1 !== dx2 || dy1 !== dy2) simplified.push(c);
    }
    simplified.push(pts[pts.length - 1]);
    return simplified;
  }
  return pts;
}

function checkAutoAnchor(px, py, frequency, searchWidth) {
  if (frequency <= 0 || magAnchors.length === 0) return;
  const last = magAnchors[magAnchors.length - 1];
  const dist = Math.hypot(px - last.x, py - last.y);
  const threshold = 60 - (52 * frequency / 100);
  if (dist < threshold) return;
  const minEdge = 0.8 - (0.65 * frequency / 100);
  if (magEdgeMap && magEdgeRegion) {
    const rx = Math.round(px) - magEdgeRegion.x;
    const ry = Math.round(py) - magEdgeRegion.y;
    if (rx >= 0 && ry >= 0 && rx < magEdgeRegion.w && ry < magEdgeRegion.h) {
      const edgeStrength = magEdgeMap[ry * magEdgeRegion.w + rx];
      if (edgeStrength < minEdge) return;
    }
  }
  const snapped = snapToNearestEdge(px, py, searchWidth);
  if (magLivePath && magLivePath.length > 1) { magSegments.push(magLivePath); }
  magAnchors.push(snapped);
  magLivePath = null;
}

function magAssemblePoints() {
  const pts = [];
  const seen = new Set();
  function addPt(x, y) {
    const key = (x << 16) | (y & 0xFFFF);
    if (seen.has(key) && pts.length > 0) return;
    seen.clear(); seen.add(key);
    pts.push({ x, y });
  }
  for (const seg of magSegments) {
    if (Array.isArray(seg)) {
      for (const p of seg) addPt(Math.round(p.x), Math.round(p.y));
    }
  }
  return pts;
}

function magBuildPreviewPath() {
  const p = new Path2D();
  const pts = magAssemblePoints();
  if (pts.length > 0) {
    p.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i].x, pts[i].y);
  }
  if (magLivePath && magLivePath.length > 0) {
    if (pts.length === 0) {
      p.moveTo(Math.round(magLivePath[0].x), Math.round(magLivePath[0].y));
    }
    for (let i = (pts.length === 0 ? 1 : 0); i < magLivePath.length; i++) {
      p.lineTo(Math.round(magLivePath[i].x), Math.round(magLivePath[i].y));
    }
  }
  return p;
}

function finishMagneticLasso(traceToStart) {
  if (magAnchors.length < 2 && magSegments.length === 0) { cancelMagneticLasso(); return; }
  if (magLivePath && magLivePath.length > 1) {
    magSegments.push(magLivePath);
    magLivePath = null;
  }
  if (traceToStart && magAnchors.length >= 2) {
    const last = magAnchors[magAnchors.length - 1];
    const first = magAnchors[0];
    const width = getMagWidth();
    const contrast = getMagContrast();
    ensureEdgeMapCoverage(last.x, last.y, first.x, first.y, width);
    const closingPath = computeLiveWire(
      Math.round(last.x), Math.round(last.y),
      Math.round(first.x), Math.round(first.y),
      width, contrast
    );
    if (closingPath && closingPath.length > 1) { magSegments.push(closingPath); }
  }
  const allPts = magAssemblePoints();
  if (allPts.length < 3) { cancelMagneticLasso(); return; }

  const p = new Path2D();
  p.moveTo(allPts[0].x, allPts[0].y);
  for (let i = 1; i < allPts.length; i++) p.lineTo(allPts[i].x, allPts[i].y);
  p.closePath();
  commitNewSelection(p, { type: 'lasso', points: allPts });
  resetMagneticState();
  drawOverlay();
}

function cancelMagneticLasso() {
  resetMagneticState();
  drawOverlay();
}

function resetMagneticState() {
  magAnchors = [];
  magSegments = [];
  magLivePath = null;
  magEdgeMap = null;
  magEdgeGx = null;
  magEdgeGy = null;
  magEdgeRegion = null;
  magActive = false;
  magFreehandMode = false;
  magFreehandPoints = [];
  isDrawingSelection = false;
  drawingPreviewPath = null;
}

/* ═══════════════════════════════════════════════════════
   TOOL REGISTRATIONS
   ═══════════════════════════════════════════════════════ */

ToolRegistry.register('select', {
  activate() {
    document.getElementById('opt-sel-mode').classList.remove('hidden');
    workspace.style.cursor = 'crosshair';
  },
  mouseDown(e, pos) {
    const layer = getActiveLayer(); if (!layer || !layer.visible) return false;
    if (transformSelActive) {
      const handle = getTransformHandle(pos.x, pos.y);
      if (handle) {
        transformHandleDrag = handle;
        transformOrigBounds = selection ? JSON.parse(JSON.stringify(selection)) : null;
        isDrawing = false; _transformDragMoved = false;
        SnapEngine.beginSession({ excludeSelection: true });
        return true;
      }
    }
    SnapEngine.beginSession({ excludeSelection: true });
    const _sp = SnapEngine.snapPoint({x: pos.x, y: pos.y}, {modifiers: e});
    drawStart = {x: _sp.x, y: _sp.y};
    isDrawingSelection = true; drawingPreviewPath = null;
    if (selectionMode === 'new') { selection = null; selectionPath = null; }
    return true;
  },
  mouseMove(e, pos) {
    if (!isDrawingSelection) return false;
    const _sp = SnapEngine.snapPoint({x: pos.x, y: pos.y}, {modifiers: e});
    const {sx, sy, sw, sh} = constrainSelectBounds(drawStart.x, drawStart.y, _sp.x, _sp.y, e.shiftKey, e.altKey);
    if (sw > 0 && sh > 0) drawingPreviewPath = makeShapePath(selectShape, sx, sy, sw, sh);
    drawOverlay(); return true;
  },
  mouseUp(e, pos) {
    if (!isDrawingSelection) return false;
    if (!isDrawing) return false;
    isDrawing = false; isDrawingSelection = false; drawingPreviewPath = null;
    const _p = screenToCanvas(e.clientX || 0, e.clientY || 0);
    const _spu = SnapEngine.snapPoint({x: _p.x, y: _p.y}, {modifiers: e});
    const {sx, sy, sw, sh} = constrainSelectBounds(drawStart.x, drawStart.y, _spu.x, _spu.y, e.shiftKey, e.altKey);
    if (sw > 1 && sh > 1) { const p = makeShapePath(selectShape, sx, sy, sw, sh); commitNewSelection(p, {type: selectShape, x: sx, y: sy, w: sw, h: sh}); }
    SnapEngine.endSession(); drawOverlay(); return true;
  }
});

ToolRegistry.register('lasso', {
  activate() {
    document.getElementById('opt-sel-mode').classList.remove('hidden');
    if (lassoMode === 'magnetic') {
      document.getElementById('opt-mag-width').classList.remove('hidden');
      document.getElementById('opt-mag-contrast').classList.remove('hidden');
      document.getElementById('opt-mag-frequency').classList.remove('hidden');
    }
    workspace.style.cursor = 'crosshair';
  },
  mouseDown(e, pos) {
    const layer = getActiveLayer(); if (!layer || !layer.visible) return false;
    if (transformSelActive) {
      const handle = getTransformHandle(pos.x, pos.y);
      if (handle) {
        transformHandleDrag = handle;
        transformOrigBounds = selection ? JSON.parse(JSON.stringify(selection)) : null;
        isDrawing = false; _transformDragMoved = false;
        SnapEngine.beginSession({ excludeSelection: true });
        return true;
      }
    }
    const px = pos.x, py = pos.y;
    if (lassoMode === 'free') {
      isDrawingSelection = true; drawingPreviewPath = null;
      if (selectionMode === 'new') { selection = null; selectionPath = null; }
      lassoPoints = [{x: px, y: py}];
    } else if (lassoMode === 'poly') {
      if (polyPoints.length === 0) { isDrawingSelection = true; if (selectionMode === 'new') { selection = null; selectionPath = null; } }
      if (polyPoints.length > 0) {
        const first = polyPoints[0];
        if (Math.hypot(px - first.x, py - first.y) < 10 / zoom && polyPoints.length > 2) {
          finishPolygonalLasso(); isDrawing = false; return true;
        }
      }
      let ppx = px, ppy = py;
      if (e.shiftKey && polyPoints.length > 0) {
        const anchor = polyPoints[polyPoints.length - 1];
        const c = applyRulerShiftConstraint(anchor.x, anchor.y, px, py);
        ppx = c.x; ppy = c.y;
      }
      polyPoints.push({x: ppx, y: ppy}); updatePolyPreviewPath(); isDrawing = false;
    } else if (lassoMode === 'magnetic') {
      if (magActive && e.altKey) {
        magFreehandMode = true;
        magFreehandPoints = [{x: px, y: py}];
        isDrawing = true;
        return true;
      }
      if (!magActive) {
        magActive = true;
        isDrawingSelection = true;
        if (selectionMode === 'new') { selection = null; selectionPath = null; }
        const width = getMagWidth();
        computeEdgeMap(
          Math.floor(px - width * 4), Math.floor(py - width * 4),
          Math.ceil(width * 8), Math.ceil(width * 8)
        );
        const snapped = snapToNearestEdge(px, py, width);
        magAnchors = [snapped];
        magSegments = [];
        magLivePath = null;
        drawMagneticOverlay();
      } else {
        const first = magAnchors[0];
        if (magAnchors.length > 2 && Math.hypot(px - first.x, py - first.y) < 10 / zoom) {
          finishMagneticLasso(true); isDrawing = false; return true;
        }
        const width = getMagWidth();
        const snapped = snapToNearestEdge(px, py, width);
        if (magLivePath && magLivePath.length > 1) { magSegments.push(magLivePath); }
        magAnchors.push(snapped);
        magLivePath = null;
        drawMagneticOverlay();
      }
      isDrawing = false;
    }
    return true;
  },
  mouseMove(e, pos) {
    const px = pos.x, py = pos.y;
    if (lassoMode === 'poly' && polyPoints.length > 0 && !isDrawing) {
      let cpx = px, cpy = py;
      if (e.shiftKey) { const anchor = polyPoints[polyPoints.length - 1]; const c = applyRulerShiftConstraint(anchor.x, anchor.y, px, py); cpx = c.x; cpy = c.y; }
      updatePolyPreviewPath(cpx, cpy); return true;
    }
    if (lassoMode === 'magnetic' && magActive) {
      if (magFreehandMode && isDrawing) {
        magFreehandPoints.push({x: px, y: py});
        prepareOverlay();
        if (selectionMode !== 'new' && selectionPath) drawAntsOnPath(overlayCtx, selectionPath);
        const p = magBuildPreviewPath();
        for (const fp of magFreehandPoints) p.lineTo(Math.round(fp.x), Math.round(fp.y));
        drawAntsOnPath(overlayCtx, p);
        overlayCtx.save(); overlayCtx.fillStyle = '#fff'; overlayCtx.strokeStyle = '#000'; overlayCtx.lineWidth = 1;
        for (const a of magAnchors) { const sp = c2s(a.x, a.y); overlayCtx.beginPath(); overlayCtx.arc(sp.x, sp.y, 3, 0, Math.PI * 2); overlayCtx.fill(); overlayCtx.stroke(); }
        overlayCtx.restore();
        return true;
      }
      const now = performance.now();
      if (now - magLastPathTime < 16) return true;
      magLastPathTime = now;
      const width = getMagWidth();
      const contrast = getMagContrast();
      const frequency = getMagFrequency();
      const lastAnchor = magAnchors[magAnchors.length - 1];
      ensureEdgeMapCoverage(lastAnchor.x, lastAnchor.y, Math.round(px), Math.round(py), width);
      magLivePath = computeLiveWire(
        Math.round(lastAnchor.x), Math.round(lastAnchor.y),
        Math.round(px), Math.round(py),
        width, contrast
      );
      checkAutoAnchor(px, py, frequency, width);
      drawMagneticOverlay();
      return true;
    }
    if (!isDrawing) return false;
    if (lassoMode === 'free' && isDrawingSelection) {
      lassoPoints.push({x: px, y: py});
      const p = new Path2D();
      p.moveTo(Math.round(lassoPoints[0].x), Math.round(lassoPoints[0].y));
      for (let i = 1; i < lassoPoints.length; i++) p.lineTo(Math.round(lassoPoints[i].x), Math.round(lassoPoints[i].y));
      drawingPreviewPath = p; drawOverlay(); return true;
    }
    return false;
  },
  mouseUp(e, pos) {
    if (lassoMode === 'magnetic' && magFreehandMode && isDrawing) {
      isDrawing = false;
      if (magFreehandPoints.length > 1) {
        magSegments.push(magFreehandPoints.slice());
        const lastFH = magFreehandPoints[magFreehandPoints.length - 1];
        magAnchors.push({x: Math.round(lastFH.x), y: Math.round(lastFH.y)});
      }
      magFreehandMode = false; magFreehandPoints = []; magLivePath = null;
      drawMagneticOverlay();
      return true;
    }
    if (lassoMode === 'magnetic' && magActive) { isDrawing = false; return true; }
    if (lassoMode === 'free' && isDrawingSelection) {
      if (!isDrawing) return false;
      isDrawing = false; isDrawingSelection = false; drawingPreviewPath = null;
      if (lassoPoints.length > 2) {
        const p = new Path2D();
        p.moveTo(Math.round(lassoPoints[0].x), Math.round(lassoPoints[0].y));
        for (let i = 1; i < lassoPoints.length; i++) p.lineTo(Math.round(lassoPoints[i].x), Math.round(lassoPoints[i].y));
        p.closePath();
        commitNewSelection(p, {type: 'lasso', points: lassoPoints.map(pt => ({x: Math.round(pt.x), y: Math.round(pt.y)}))});
      }
      lassoPoints = [];
      drawOverlay(); return true;
    }
    return false;
  }
});

ToolRegistry.register('wand', {
  activate() {
    document.getElementById('opt-wand-tolerance').classList.remove('hidden');
    document.getElementById('opt-wand-contiguous').classList.remove('hidden');
    document.getElementById('opt-sel-mode').classList.remove('hidden');
    workspace.style.cursor = 'crosshair';
  },
  mouseDown(e, pos) {
    const layer = getActiveLayer(); if (!layer || !layer.visible) return false;
    if (transformSelActive) {
      const handle = getTransformHandle(pos.x, pos.y);
      if (handle) {
        transformHandleDrag = handle;
        transformOrigBounds = selection ? JSON.parse(JSON.stringify(selection)) : null;
        isDrawing = false; _transformDragMoved = false;
        SnapEngine.beginSession({ excludeSelection: true });
        return true;
      }
    }
    const tolVal = parseInt(document.getElementById('wandTolerance').value);
    const tol = isNaN(tolVal) ? 32 : tolVal;
    const contiguous = document.getElementById('wandContiguous').checked;
    const result = magicWandSelect(pos.x, pos.y, tol, contiguous);
    if (result) {
      const wandPath = contoursToPath(result.contours);
      const b = result.bounds;
      commitNewSelection(wandPath, {type: 'wand', contours: result.contours, x: b.x, y: b.y, w: b.w, h: b.h});
    } else if (selectionMode === 'new') { selection = null; selectionPath = null; }
    drawOverlay(); isDrawing = false; return true;
  }
});
