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
    opacity: 1
  };
  layers.splice(activeLayerIndex, 0, layer);
  activeLayerIndex = layers.indexOf(layer);
  selectedLayers = new Set([activeLayerIndex]);
  compositeAll();
  updateLayerPanel();
  if (!_skipUndo) pushUndo('Add Layer');
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
      opacity: src.opacity
    };
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

function moveLayerUp() {
  if (activeLayerIndex <= 0) return;
  [layers[activeLayerIndex], layers[activeLayerIndex-1]] = [layers[activeLayerIndex-1], layers[activeLayerIndex]];
  activeLayerIndex--;
  selectedLayers = new Set([activeLayerIndex]);
  compositeAll();
  updateLayerPanel();
  pushUndo('Reorder');
}

function moveLayerDown() {
  if (activeLayerIndex >= layers.length - 1) return;
  [layers[activeLayerIndex], layers[activeLayerIndex+1]] = [layers[activeLayerIndex+1], layers[activeLayerIndex]];
  activeLayerIndex++;
  selectedLayers = new Set([activeLayerIndex]);
  compositeAll();
  updateLayerPanel();
  pushUndo('Reorder');
}

function getActiveLayer() { return layers[activeLayerIndex]; }

function updateLayerPanel() {
  const list = document.getElementById('layersList');
  list.innerHTML = '';
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const item = document.createElement('div');
    item.className = 'layer-item' + (selectedLayers.has(i) ? ' active' : '');
    item.onclick = (e) => {
      if (pxTransformActive) commitPixelTransform();
      if (floatingActive && i !== activeLayerIndex) commitFloating();
      if (e.ctrlKey || e.metaKey) {
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
    };
    item.ondblclick = () => {
      const newName = prompt('Layer name:', l.name);
      if (newName) { l.name = newName; updateLayerPanel(); }
    };

    const thumb = document.createElement('div');
    thumb.className = 'layer-thumb';
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
