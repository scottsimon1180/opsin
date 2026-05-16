"use strict";

/* ═══════════════════════════════════════════════════════
   LAYER MANAGEMENT — creation, deletion, duplication,
   ordering, selection, visibility, opacity, naming,
   merging, and layer-panel UI updates.

   Depends on globals from (in load order):
     js/core/state.js   — layers, activeLayerIndex, selectedLayers,
                          layerIdCounter, canvasW, canvasH,
                          pxTransformActive, floatingActive, checkerPattern
     js/core/dom.js     — compositeCanvas, overlayCanvas, canvasWrapper
   Calls made only from event handlers / callbacks (not at parse time):
     compositeAll()        — js/core/rendering.js
     pushUndo()            — js/script.js
     commitPixelTransform() — js/document/layerTransforms.js
     commitFloating()       — js/script.js
     wheelDelta()           — js/script.js
   ═══════════════════════════════════════════════════════ */

function createLayerCanvas() {
  const c = document.createElement('canvas');
  c.width = canvasW;
  c.height = canvasH;
  c.addEventListener('contextlost', (e) => { e.preventDefault(); });
  c.addEventListener('contextrestored', () => { compositeAll(); });
  return c;
}

function addLayer(name, _skipUndo) {
  const c = createLayerCanvas();
  const layer = {
    id: layerIdCounter++,
    name: name || `Layer ${layerIdCounter - 1}`,
    canvas: c,
    ctx: c.getContext('2d', { willReadFrequently: true }),
    visible: true,
    opacity: 1,
    kind: 'image'
  };
  layers.splice(activeLayerIndex, 0, layer);
  activeLayerIndex = layers.indexOf(layer);
  selectedLayers = new Set([activeLayerIndex]);
  compositeAll();
  updateLayerPanel();
  if (!_skipUndo) pushUndo('Add Layer');
}

// Create a fresh text layer placed above the current active layer.
// textModel: { runs[], boxX, boxY, boxW, boxH, rotation, mode, align,
//              lineSpacing, letterSpacing }
function addTextLayer(textModel, _skipUndo) {
  const c = createLayerCanvas();
  const layer = {
    id: layerIdCounter++,
    name: _textPreviewName(textModel) || `Text ${layerIdCounter - 1}`,
    canvas: c,
    ctx: c.getContext('2d', { willReadFrequently: true }),
    visible: true,
    opacity: 1,
    kind: 'text',
    textModel: textModel
  };
  layers.splice(activeLayerIndex, 0, layer);
  activeLayerIndex = layers.indexOf(layer);
  selectedLayers = new Set([activeLayerIndex]);
  if (typeof renderTextLayer === 'function') renderTextLayer(layer);
  compositeAll();
  updateLayerPanel();
  if (!_skipUndo) pushUndo('Add Text Layer');
  return layer;
}

function _textPreviewName(model) {
  if (!model || !model.runs || !model.runs.length) return null;
  const txt = model.runs.map(r => r.text).join('').trim();
  if (!txt) return null;
  return txt.length > 24 ? txt.slice(0, 24) + '…' : txt;
}

// Create a fresh shape layer placed above the current active layer.
// shapeModel: { shapes: [...primitives], selectedIds: Set<id>, nextId: number }
function addShapeLayer(shapeModel, _skipUndo) {
  const c = createLayerCanvas();
  const layer = {
    id: layerIdCounter++,
    name: _shapeLayerName(shapeModel) || `Shape ${layerIdCounter - 1}`,
    canvas: c,
    ctx: c.getContext('2d', { willReadFrequently: true }),
    visible: true,
    opacity: 1,
    kind: 'shape',
    shapeModel: shapeModel
  };
  layers.splice(activeLayerIndex, 0, layer);
  activeLayerIndex = layers.indexOf(layer);
  selectedLayers = new Set([activeLayerIndex]);
  if (typeof renderShapeLayer === 'function') renderShapeLayer(layer);
  compositeAll();
  updateLayerPanel();
  if (!_skipUndo) pushUndo('Add Shape Layer');
  return layer;
}

function _shapeLayerName(model) {
  if (!model || !model.shapes || !model.shapes.length) return null;
  const t = model.shapes[0].type;
  const n = model.shapes.length;
  const labels = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line' };
  if (n === 1) return labels[t] || 'Shape';
  return `Shapes (${n})`;
}

function deleteLayer() {
  const sel = [...selectedLayers].sort((a, b) => b - a);
  if (sel.length === 0) return;
  if (layers.length - sel.length < 1) return;
  for (const idx of sel) {
    layers.splice(idx, 1);
  }
  if (activeLayerIndex >= layers.length) activeLayerIndex = layers.length - 1;
  selectedLayers = new Set([activeLayerIndex]);
  compositeAll();
  updateLayerPanel();
  pushUndo('Delete Layer');
}

function duplicateLayer() {
  const sel = [...selectedLayers].sort((a, b) => a - b);
  if (sel.length === 0) return;
  const newIndices = [];
  let offset = 0;
  for (const idx of sel) {
    const srcIdx = idx + offset;
    const src = layers[srcIdx];
    const c = createLayerCanvas();
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src.canvas, 0, 0);
    const newLayer = {
      id: layerIdCounter++,
      name: `${src.name} (Copy)`,
      canvas: c,
      ctx,
      visible: src.visible,
      opacity: src.opacity,
      kind: src.kind || 'image'
    };
    if (src.kind === 'text' && src.textModel) {
      newLayer.textModel = _cloneTextModel(src.textModel);
    } else if (src.kind === 'shape' && src.shapeModel) {
      newLayer.shapeModel = _cloneShapeModel(src.shapeModel);
    }
    layers.splice(srcIdx, 0, newLayer);
    newIndices.push(srcIdx);
    offset++;
  }
  activeLayerIndex = newIndices[0];
  selectedLayers = new Set(newIndices);
  compositeAll();
  updateLayerPanel();
  pushUndo('Duplicate Layer');
}

function mergeLayers() {
  const sel = [...selectedLayers].sort((a, b) => a - b);
  if (sel.length <= 1) return;
  // Smart-object guard: any text or shape layer in the selection must be
  // rasterized before merging. Show one confirmation; on accept, rasterize
  // all and re-enter mergeLayers().
  const textIdx  = sel.filter(i => layers[i] && layers[i].kind === 'text');
  const shapeIdx = sel.filter(i => layers[i] && layers[i].kind === 'shape');
  if (textIdx.length > 0 && window.TextTool && window.TextTool.requireRasterize) {
    const proxyLayer = layers[textIdx[0]];
    window.TextTool.requireRasterize(proxyLayer, 'Merge').then((ok) => {
      if (!ok) return;
      for (const i of textIdx) {
        const l = layers[i];
        if (l && l.kind === 'text') rasterizeTextLayer(l);
      }
      if (typeof compositeAll === 'function') compositeAll();
      mergeLayers();
    });
    return;
  }
  if (shapeIdx.length > 0 && window.ShapeTool && window.ShapeTool.requireRasterize) {
    const proxyLayer = layers[shapeIdx[0]];
    window.ShapeTool.requireRasterize(proxyLayer, 'Merge').then((ok) => {
      if (!ok) return;
      for (const i of shapeIdx) {
        const l = layers[i];
        if (l && l.kind === 'shape') rasterizeShapeLayer(l);
      }
      if (typeof compositeAll === 'function') compositeAll();
      mergeLayers();
    });
    return;
  }
  const c = createLayerCanvas();
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (let i = sel.length - 1; i >= 0; i--) {
    const l = layers[sel[i]];
    ctx.globalAlpha = l.opacity;
    ctx.drawImage(l.canvas, 0, 0);
  }
  ctx.globalAlpha = 1;
  const bottomName = layers[sel[sel.length - 1]].name;
  const mergedLayer = {
    id: layerIdCounter++,
    name: bottomName,
    canvas: c,
    ctx,
    visible: true,
    opacity: 1
  };
  for (let i = sel.length - 1; i >= 0; i--) {
    layers.splice(sel[i], 1);
  }
  const insertPos = sel[sel.length - 1] - (sel.length - 1);
  layers.splice(insertPos, 0, mergedLayer);
  activeLayerIndex = insertPos;
  selectedLayers = new Set([insertPos]);
  compositeAll();
  updateLayerPanel();
  pushUndo('Merge Layers');
}

// Merge 2+ selected shape layers into a single vector shape layer, keeping
// the result editable. The merged layer takes the z-position and name of the
// bottom-most selected layer. Each source layer's opacity is baked into its
// paths' alpha so the merge is visually lossless. Shapes are concatenated
// bottom-layer-first so the existing front-to-back stacking is preserved.
function mergeShapeLayers() {
  const sel = [...selectedLayers].sort((a, b) => a - b);
  if (sel.length < 2) return;
  if (!sel.every(i => layers[i] && layers[i].kind === 'shape')) return;

  const combined = [];
  let nextId = 1;
  // Lower index = higher in the stack, so the bottom-most selected layer is
  // sel[last]. Walk bottom → top so earlier-painted shapes stay behind.
  for (let k = sel.length - 1; k >= 0; k--) {
    const l = layers[sel[k]];
    const lOp = (l.opacity == null) ? 1 : l.opacity;
    const shapes = (l.shapeModel && l.shapeModel.shapes) || [];
    for (const s of shapes) {
      const cp = _cloneShape(s);
      cp.id = nextId++;
      cp.opacity = ((s.opacity == null) ? 1 : s.opacity) * lOp;
      combined.push(cp);
    }
  }

  const bottomName = layers[sel[sel.length - 1]].name;
  const c = createLayerCanvas();
  const mergedLayer = {
    id: layerIdCounter++,
    name: bottomName,
    canvas: c,
    ctx: c.getContext('2d', { willReadFrequently: true }),
    visible: true,
    opacity: 1,
    kind: 'shape',
    shapeModel: { nextId, selectedIds: new Set(), shapes: combined }
  };
  for (let i = sel.length - 1; i >= 0; i--) {
    layers.splice(sel[i], 1);
  }
  const insertPos = sel[sel.length - 1] - (sel.length - 1);
  layers.splice(insertPos, 0, mergedLayer);
  activeLayerIndex = insertPos;
  selectedLayers = new Set([insertPos]);
  if (typeof renderShapeLayer === 'function') renderShapeLayer(mergedLayer);
  compositeAll();
  updateLayerPanel();
  pushUndo('Merge SVGs');
}

function moveLayerUp() {
  if (activeLayerIndex <= 0) return;
  const before = _captureLayerRects();
  [layers[activeLayerIndex], layers[activeLayerIndex-1]] = [layers[activeLayerIndex-1], layers[activeLayerIndex]];
  activeLayerIndex--;
  selectedLayers = new Set([activeLayerIndex]);
  compositeAll();
  updateLayerPanel();
  _flipLayerReorder(before);
  pushUndo('Reorder');
}

function moveLayerDown() {
  if (activeLayerIndex >= layers.length - 1) return;
  const before = _captureLayerRects();
  [layers[activeLayerIndex], layers[activeLayerIndex+1]] = [layers[activeLayerIndex+1], layers[activeLayerIndex]];
  activeLayerIndex++;
  selectedLayers = new Set([activeLayerIndex]);
  compositeAll();
  updateLayerPanel();
  _flipLayerReorder(before);
  pushUndo('Reorder');
}

function getActiveLayer() { return layers[activeLayerIndex]; }

function _cloneTextModel(m) {
  if (!m) return null;
  return {
    runs: (m.runs || []).map(r => ({ ...r })),
    boxX: m.boxX, boxY: m.boxY, boxW: m.boxW, boxH: m.boxH,
    rotation: m.rotation || 0,
    mode: m.mode || 'point',
    align: m.align || 'left',
    lineSpacing: m.lineSpacing == null ? 1.2 : m.lineSpacing,
    letterSpacing: m.letterSpacing || 0,
    widthLocked: !!m.widthLocked
  };
}

// Convert a text layer to a regular image layer in place.
// The layer canvas already holds the rendered text (compositing keeps it
// up to date). We just strip the smart-object metadata.
function rasterizeTextLayer(layer) {
  if (!layer || layer.kind !== 'text') return;
  if (typeof renderTextLayer === 'function') renderTextLayer(layer);
  layer.kind = 'image';
  layer.textModel = null;
}

// Deep-clone a shape model — used by duplicate, history, and edit baselines.
function _cloneShapeModel(m) {
  if (!m) return null;
  const out = {
    nextId: m.nextId || 1,
    selectedIds: new Set(),
    shapes: (m.shapes || []).map(s => _cloneShape(s))
  };
  return out;
}

function _cloneShape(s) {
  if (!s) return null;
  const cp = {
    id: s.id,
    type: s.type,
    rotation: s.rotation || 0,
    fill:   s.fill   ? { ...s.fill }   : { type: 'solid', color: '#ffffff' },
    stroke: s.stroke ? { ...s.stroke, dashPattern: s.stroke.dashPattern ? s.stroke.dashPattern.slice() : null }
                     : { type: 'solid', color: '#000000', width: 2, cap: 'butt', join: 'miter', align: 'center', dashPattern: null, dashOffset: 0 },
    opacity: (s.opacity == null) ? 1 : s.opacity
  };
  if (s.type === 'line') {
    cp.p1 = { x: s.p1.x, y: s.p1.y };
    cp.p2 = { x: s.p2.x, y: s.p2.y };
  } else if (s.type === 'path') {
    cp.points = (s.points || []).map(p => {
      const pt = { x: p.x, y: p.y };
      if (p.type)              pt.type = p.type;
      if (p.ohx !== undefined) { pt.ohx = p.ohx; pt.ohy = p.ohy; }
      if (p.ihx !== undefined) { pt.ihx = p.ihx; pt.ihy = p.ihy; }
      return pt;
    });
    cp.closed = !!s.closed;
  } else {
    cp.x = s.x; cp.y = s.y; cp.w = s.w; cp.h = s.h;
    if (s.type === 'rect') cp.cornerRadius = s.cornerRadius || 0;
  }
  return cp;
}

// Convert a shape layer to a regular image layer in place. The layer canvas
// already holds the rendered shapes; we just strip the smart-object metadata.
function rasterizeShapeLayer(layer) {
  if (!layer || layer.kind !== 'shape') return;
  if (typeof renderShapeLayer === 'function') renderShapeLayer(layer);
  layer.kind = 'image';
  layer.shapeModel = null;
}

function updateLayerPanel() {
  const list = document.getElementById('layersList');
  list.innerHTML = '';
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const item = document.createElement('div');
    item.className = 'layer-item' + (selectedLayers.has(i) ? ' active' : '');
    item.dataset.layerIndex = i;
    item.addEventListener('mousedown', (e) => _onLayerItemMouseDown(e, i));
    item.onclick = (e) => {
      if (pxTransformActive) commitPixelTransform();
      if (floatingActive && i !== activeLayerIndex) commitFloating();
      if (e.shiftKey) {
        const anchor = (typeof activeLayerIndex === 'number' && activeLayerIndex >= 0)
          ? activeLayerIndex : i;
        const lo = Math.min(anchor, i);
        const hi = Math.max(anchor, i);
        selectedLayers = new Set();
        for (let k = lo; k <= hi; k++) selectedLayers.add(k);
        activeLayerIndex = i;
      } else if (e.ctrlKey || e.metaKey) {
        if (selectedLayers.has(i)) {
          if (selectedLayers.size > 1) {
            selectedLayers.delete(i);
            if (activeLayerIndex === i) activeLayerIndex = [...selectedLayers][0];
          }
        } else {
          selectedLayers.add(i);
          activeLayerIndex = i;
        }
      } else {
        activeLayerIndex = i;
        selectedLayers = new Set([i]);
      }
      updateLayerPanel();
      updateLayerOpacitySlider();
      if (typeof updateMoveToolOptionsBar === 'function') updateMoveToolOptionsBar();
    };
    item.ondblclick = () => {
      // Text layer: enter edit mode instead of renaming.
      if (l.kind === 'text' && window.TextTool && window.TextTool.beginEdit) {
        if (typeof selectTool === 'function' && currentTool !== 'text') selectTool('text');
        window.TextTool.beginEdit(l);
        return;
      }
      // Shape layer: switch to shape tool so handles surface; select all.
      if (l.kind === 'shape' && window.ShapeTool && window.ShapeTool.beginEdit) {
        if (typeof selectTool === 'function' && currentTool !== 'shape') selectTool('shape');
        window.ShapeTool.beginEdit(l);
        return;
      }
      const newName = prompt('Layer name:', l.name);
      if (newName) { l.name = newName; updateLayerPanel(); }
    };
    item.oncontextmenu = (e) => { e.preventDefault(); _showLayerContextMenu(e, i); };

    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
    if (l.kind === 'text') {
      thumb.innerHTML = `<div class="layer-thumb-text"><svg><use href="#icon-text"/></svg></div>`;
    } else if (l.kind === 'shape') {
      thumb.innerHTML = `<div class="layer-thumb-text"><svg><use href="#icon-shape"/></svg></div>`;
    } else {
      const tc = document.createElement('canvas');
      const maxThumb = 40;
      let tw, th;
      if (canvasW >= canvasH) {
        tw = maxThumb;
        th = Math.max(1, Math.round(maxThumb * (canvasH / canvasW)));
      } else {
        th = maxThumb;
        tw = Math.max(1, Math.round(maxThumb * (canvasW / canvasH)));
      }
      tc.width = tw; tc.height = th;
      const tctx = tc.getContext('2d');
      tctx.drawImage(l.canvas, 0, 0, canvasW, canvasH, 0, 0, tw, th);
      thumb.appendChild(tc);
    }

    const info = document.createElement('div');
    info.className = 'layer-info';
    info.innerHTML = `<div class="layer-name">${l.name}</div><div class="layer-opacity-text">${Math.round(l.opacity*100)}%</div>`;

    const vis = document.createElement('button');
    vis.className = 'layer-vis' + (l.visible ? '' : ' hidden-layer');
    vis.innerHTML = l.visible
      ? '<svg><use href="#icon-layer-visibility-on"/></svg>'
      : '<svg><use href="#icon-layer-visibility-off"/></svg>';
    vis.onclick = (e) => { e.stopPropagation(); l.visible = !l.visible; compositeAll(); updateLayerPanel(); };

    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(vis);
    list.appendChild(item);
  }
  updateLayerOpacitySlider();
}

function updateLayerOpacitySlider() {
  const slider = document.getElementById('layerOpacity');
  const val = document.getElementById('layerOpacityVal');
  const l = getActiveLayer();
  if (l) {
    slider.value = Math.round(l.opacity * 100);
    val.textContent = Math.round(l.opacity * 100) + '%';
  }
}

document.getElementById('layerOpacity').addEventListener('input', function() {
  const l = getActiveLayer();
  if (!l) return;
  l.opacity = this.value / 100;
  document.getElementById('layerOpacityVal').textContent = this.value + '%';
  const activeItem = document.querySelector('.layer-item.active .layer-opacity-text');
  if (activeItem) activeItem.textContent = this.value + '%';
  compositeAll();
});
(function() {
  const slider = document.getElementById('layerOpacity');
  const row = slider.closest('.opt-group');
  if (!row) return;
  row.addEventListener('wheel', (e) => {
    e.preventDefault();
    slider.value = Math.max(0, Math.min(100, (parseInt(slider.value) || 0) + wheelDelta(e)));
    slider.dispatchEvent(new Event('input'));
  }, { passive: false });
})();

/* ── FLIP helpers for animated layer reordering ── */
function _captureLayerRects() {
  const out = new Map();
  const list = document.getElementById('layersList');
  if (!list) return out;
  const items = list.querySelectorAll('.layer-item');
  items.forEach(it => {
    const idx = parseInt(it.dataset.layerIndex, 10);
    if (Number.isNaN(idx)) return;
    const layer = layers[idx];
    if (!layer) return;
    out.set(layer.id, it.getBoundingClientRect().top);
  });
  return out;
}

function _flipLayerReorder(beforeMap) {
  if (!beforeMap || beforeMap.size === 0) return;
  const list = document.getElementById('layersList');
  if (!list) return;
  const items = Array.from(list.querySelectorAll('.layer-item'));
  const moved = [];
  items.forEach(it => {
    const idx = parseInt(it.dataset.layerIndex, 10);
    if (Number.isNaN(idx)) return;
    const layer = layers[idx];
    if (!layer) return;
    const beforeTop = beforeMap.get(layer.id);
    if (beforeTop == null) return;
    const afterTop = it.getBoundingClientRect().top;
    const dy = beforeTop - afterTop;
    if (dy === 0) return;
    it.style.transform = `translateY(${dy}px)`;
    moved.push(it);
  });
  if (moved.length === 0) return;
  void list.offsetWidth;
  requestAnimationFrame(() => {
    moved.forEach(it => {
      it.classList.add('layer-shifting');
      it.style.transform = '';
    });
    setTimeout(() => {
      moved.forEach(it => {
        it.classList.remove('layer-shifting');
        it.style.transform = '';
      });
    }, 260);
  });
}

/* ── Layer drag-to-reorder ── */
let layerDragState = null;
const LAYER_DRAG_THRESHOLD = 4;

function _onLayerItemMouseDown(e, idx) {
  if (e.button !== 0) return;
  if (e.target.closest('.layer-vis')) return;

  const list = document.getElementById('layersList');
  const items = Array.from(list.querySelectorAll('.layer-item'));
  const item = items[idx];
  if (!item) return;

  layerDragState = {
    started: false,
    srcIdx: idx,
    item,
    items,
    list,
    startY: e.clientY,
    targetIdx: idx
  };

  document.addEventListener('mousemove', _onLayerDragMove);
  document.addEventListener('mouseup', _onLayerDragUp);
  e.preventDefault();
}

function _onLayerDragMove(e) {
  const st = layerDragState;
  if (!st) return;
  const dy = e.clientY - st.startY;

  if (!st.started) {
    if (Math.abs(dy) < LAYER_DRAG_THRESHOLD) return;
    st.started = true;
    st.itemHeights = st.items.map(it => it.getBoundingClientRect().height);
    st.itemTops = st.items.map(it => it.getBoundingClientRect().top);
    st.slotHeight = (st.items.length > 1)
      ? (st.itemTops[1] - st.itemTops[0])
      : (st.itemHeights[0] + 2);
    st.list.classList.add('is-dragging');
    for (let i = 0; i < st.items.length; i++) {
      st.items[i].classList.add('layer-shifting');
      if (i === st.srcIdx) st.items[i].classList.add('layer-dragging');
    }
  }

  st.item.style.transform = `translateY(${dy}px)`;

  const draggedCenter = st.itemTops[st.srcIdx] + st.itemHeights[st.srcIdx] / 2 + dy;
  const baseTop = st.itemTops[0];
  let targetIdx = Math.floor((draggedCenter - baseTop) / st.slotHeight);
  if (targetIdx < 0) targetIdx = 0;
  if (targetIdx > st.items.length - 1) targetIdx = st.items.length - 1;
  st.targetIdx = targetIdx;

  for (let i = 0; i < st.items.length; i++) {
    if (i === st.srcIdx) continue;
    let visualIdx = i;
    if (i < st.srcIdx && i >= targetIdx) visualIdx = i + 1;
    else if (i > st.srcIdx && i <= targetIdx) visualIdx = i - 1;
    const offset = (visualIdx - i) * st.slotHeight;
    st.items[i].style.transform = offset === 0 ? '' : `translateY(${offset}px)`;
  }
}

function _onLayerDragUp() {
  const st = layerDragState;
  document.removeEventListener('mousemove', _onLayerDragMove);
  document.removeEventListener('mouseup', _onLayerDragUp);
  layerDragState = null;

  if (!st || !st.started) return;

  // Suppress the click event that would otherwise fire after this mouseup
  const suppressClick = (ev) => {
    ev.stopImmediatePropagation();
    ev.preventDefault();
    document.removeEventListener('click', suppressClick, true);
  };
  document.addEventListener('click', suppressClick, true);
  setTimeout(() => document.removeEventListener('click', suppressClick, true), 0);

  const { srcIdx, targetIdx } = st;

  if (targetIdx === srcIdx) {
    // No reorder — animate everything back to rest
    st.item.classList.remove('layer-dragging');
    for (let i = 0; i < st.items.length; i++) st.items[i].style.transform = '';
    setTimeout(() => {
      st.list.classList.remove('is-dragging');
      for (let i = 0; i < st.items.length; i++) {
        st.items[i].classList.remove('layer-shifting');
      }
    }, 230);
    return;
  }

  const moved = layers.splice(srcIdx, 1)[0];
  layers.splice(targetIdx, 0, moved);
  activeLayerIndex = targetIdx;
  selectedLayers = new Set([targetIdx]);
  compositeAll();
  updateLayerPanel();
  pushUndo('Reorder Layer');
}

/* ── Layer right-click context menu ─────────────────────── */

function _showLayerContextMenu(e, layerIdx) {
  const menu = document.getElementById('layerCtxMenu');
  if (!menu) return;
  const layer = layers[layerIdx];
  if (!layer) return;
  // Make the right-clicked layer active. Preserve an existing multi-selection
  // when the clicked layer is part of it so merge actions see the whole set;
  // otherwise reduce the selection to just this layer.
  if (!selectedLayers.has(layerIdx)) {
    selectedLayers = new Set([layerIdx]);
  }
  activeLayerIndex = layerIdx;
  updateLayerPanel();

  const isText  = layer.kind === 'text';
  const isShape = layer.kind === 'shape';
  const isSmart = isText || isShape;
  const rasterizeBtn = document.getElementById('layerCtxRasterize');
  const editTextBtn  = document.getElementById('layerCtxEditText');
  rasterizeBtn.disabled = !isSmart;
  rasterizeBtn.textContent = isShape ? 'Rasterize Shape Layer' : (isText ? 'Rasterize Text Layer' : 'Rasterize Layer');
  editTextBtn.style.display = isSmart ? '' : 'none';
  editTextBtn.textContent  = isShape ? 'Edit Shapes' : 'Edit Text';

  // Multi-select merge actions. All-SVG selection → vector "Merge SVGs";
  // mixed SVG + raster → single "Rasterize & Merge" (delegates to the
  // existing mergeLayers flow, which rasterizes smart layers then flattens).
  const selLayers = [...selectedLayers].map(i => layers[i]).filter(Boolean);
  const shapeCount = selLayers.filter(l => l.kind === 'shape').length;
  const multi = selLayers.length >= 2;
  const allShape   = multi && shapeCount === selLayers.length;
  const mixedShape = multi && shapeCount >= 1 && shapeCount < selLayers.length;
  const mergeSvgsBtn   = document.getElementById('layerCtxMergeSvgs');
  const rasterMergeBtn = document.getElementById('layerCtxRasterizeMerge');
  if (mergeSvgsBtn)   mergeSvgsBtn.style.display   = allShape   ? '' : 'none';
  if (rasterMergeBtn) rasterMergeBtn.style.display = mixedShape ? '' : 'none';

  // Position. Clamp inside viewport.
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  let x = e.clientX, y = e.clientY;
  if (x + r.width  > window.innerWidth)  x = window.innerWidth  - r.width  - 4;
  if (y + r.height > window.innerHeight) y = window.innerHeight - r.height - 4;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';

  function close() {
    menu.hidden = true;
    document.removeEventListener('mousedown', onAway, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function onAway(ev) {
    if (!menu.contains(ev.target)) close();
  }
  function onKey(ev) { if (ev.key === 'Escape') close(); }

  rasterizeBtn.onclick = () => {
    close();
    if (layer.kind === 'text') {
      rasterizeTextLayer(layer);
      if (typeof compositeAll === 'function') compositeAll();
      if (typeof pushUndo === 'function') pushUndo('Rasterize Text');
      updateLayerPanel();
    } else if (layer.kind === 'shape') {
      rasterizeShapeLayer(layer);
      if (typeof compositeAll === 'function') compositeAll();
      if (typeof pushUndo === 'function') pushUndo('Rasterize Shape');
      updateLayerPanel();
    }
  };
  editTextBtn.onclick = () => {
    close();
    if (layer.kind === 'text' && window.TextTool) {
      if (typeof selectTool === 'function' && currentTool !== 'text') selectTool('text');
      window.TextTool.beginEdit(layer);
    } else if (layer.kind === 'shape' && window.ShapeTool) {
      if (typeof selectTool === 'function' && currentTool !== 'shape') selectTool('shape');
      window.ShapeTool.beginEdit(layer);
    }
  };
  if (mergeSvgsBtn)   mergeSvgsBtn.onclick   = () => { close(); mergeShapeLayers(); };
  if (rasterMergeBtn) rasterMergeBtn.onclick = () => { close(); mergeLayers(); };

  // Defer attaching the away-listener to the next frame so the
  // contextmenu's own mousedown doesn't immediately close the menu.
  requestAnimationFrame(() => {
    document.addEventListener('mousedown', onAway, true);
    document.addEventListener('keydown', onKey, true);
  });
}
