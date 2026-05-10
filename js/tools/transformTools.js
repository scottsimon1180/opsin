'use strict';

// ──── Move Tool ────────────────────────────────────────────────────────────────

ToolRegistry.register('move', {
  activate() {
    const _layer = (typeof layers !== 'undefined' && typeof activeLayerIndex !== 'undefined')
      ? layers[activeLayerIndex] : null;
    if (_layer && _layer.kind === 'shape' && window.ShapeTool && window.ShapeTool.openForMoveTool) {
      window.ShapeTool.openForMoveTool(_layer);
    } else {
      document.getElementById('opt-move').classList.remove('hidden');
    }
    workspace.style.cursor = 'default';
    if (selection && selectionPath && !pxTransformActive && !floatingActive) {
      initPixelTransform();
    }
    updateMoveDeselectButtonState();
  },

  deactivate() {
    if (window.ShapeTool && window.ShapeTool.closeForMoveTool) window.ShapeTool.closeForMoveTool();
    if (window.TextTool && window.TextTool.clearHover) window.TextTool.clearHover();
  },

  mouseDown(e, pos) {
    const px = pos.x, py = pos.y;

    // Guide hit-test — allow selecting/dragging guides with move tool.
    const _canCheckGuides = guidesVisible && guides.length > 0;
    if (_canCheckGuides) {
      const hitG = hitTestGuide(e.clientX, e.clientY);
      if (hitG) {
        selectedGuide = hitG;
        draggingGuide = { guide: hitG, isNew: false };
        isDrawing = false;
        workspace.style.cursor = hitG.axis === 'v' ? 'ew-resize' : 'ns-resize';
        SnapEngine.beginSession({ excludeGuides: true, excludeGuideId: hitG.id });
        drawGuides();
        drawOverlay();
        updatePropertiesPanel();
        return true;
      }
    }
    if (selectedGuide) { selectedGuide = null; drawGuides(); drawOverlay(); updatePropertiesPanel(); }

    // ── Text layer interaction ──
    // If a text session is active the click landed outside the box (the box
    // stops propagation for clicks inside it), so commit the session first.
    if (window.TextTool && window.TextTool.isActive()) {
      window.TextTool.endEdit(true);
      updatePropertiesPanel();
    }
    // Single-click on an idle text layer → enter reposition mode.
    if (!pxTransformActive && !floatingActive && window.TextTool) {
      if (window.TextTool.hitTestAndSelect(px, py)) {
        updatePropertiesPanel();
        return true;
      }
    }

    // ── Shape layer delegation ──
    if (window.ShapeTool && window.ShapeTool.handleMoveMouseDown) {
      if (window.ShapeTool.handleMoveMouseDown(e, pos)) return true;
      // If shape mode is active but no shape was hit, don't start a pixel transform.
      if (window.ShapeTool.isOpenForMoveTool && window.ShapeTool.isOpenForMoveTool()) {
        isDrawing = false;
        return true;
      }
    }

    // ── Case 1: a pixel transform is already live ──
    if (pxTransformActive && pxTransformData) {
      const hit = hitTestPxTransform(px, py);
      if (hit) {
        pxTransformHandle = hit;
        pxTransformStartMouse = { x: px, y: py };
        pxTransformOrigBounds = { ...pxTransformData.curBounds };
        _moveTransformJustInitiated = false;
        _moveDragAltDuplicate = !!(e.altKey && hit === 'move');
        if (hit === 'rotate') {
          const _b = pxTransformData.curBounds;
          _rotateCenter = { x: _b.x + _b.w / 2, y: _b.y + _b.h / 2 };
          _rotateStartAngle = Math.atan2(py - _rotateCenter.y, px - _rotateCenter.x);
          pxTransformData.liveRotation = 0;
          isDrawing = false;
          return true;
        }
        const _excl = new Set(); const _al = getActiveLayer(); if (_al) _excl.add(_al.id);
        SnapEngine.beginSession({ excludeLayerIds: _excl, excludeSelection: true });
        isDrawing = false;
        return true;
      }
      // Click outside transform box → commit it.
      commitPixelTransform();
      updateMoveDeselectButtonState();
      isDrawing = false;
      return true;
    }

    // ── Case 2: a floating selection is live ──
    if (floatingActive && floatingCanvas) {
      isMovingPixels = true; isDrawing = false;
      _floatingDragBaseOffset = { x: floatingOffset.x, y: floatingOffset.y };
      _floatingDragStart = { x: px, y: py };
      const _excl = new Set(); const _al = getActiveLayer(); if (_al) _excl.add(_al.id);
      SnapEngine.beginSession({ excludeLayerIds: _excl, excludeSelection: true });
      return true;
    }

    // ── Case 3: nothing active — decide whether to initiate a new transform ──
    const pick = pickMoveTarget(px, py);
    if (!pick) {
      isDrawing = false;
      return true;
    }
    if (pick.layerIndex !== activeLayerIndex) {
      activeLayerIndex = pick.layerIndex;
      selectedLayers = new Set([activeLayerIndex]);
      updateLayerPanel();
    }
    initPixelTransform(true);
    if (!pxTransformActive || !pxTransformData) {
      isDrawing = false;
      return true;
    }
    pxTransformHandle = 'move';
    pxTransformStartMouse = { x: px, y: py };
    pxTransformOrigBounds = { ...pxTransformData.curBounds };
    _moveTransformJustInitiated = true;
    _moveDragAltDuplicate = !!e.altKey;
    const _excl = new Set();
    const _al = getActiveLayer();
    if (_al) _excl.add(_al.id);
    SnapEngine.beginSession({ excludeLayerIds: _excl, excludeSelection: true });
    updateMoveDeselectButtonState();
    compositeAll();
    drawOverlay();
    isDrawing = false;
    return true;
  },

  mouseMove(e, pos) {
    const px = pos.x, py = pos.y;

    // Guide hover cursor
    let _guideHovered = false;
    if (guidesVisible && !isPanning && !isMovingPixels && !pxTransformHandle) {
      const hg = hitTestGuide(e.clientX, e.clientY);
      if (hg) { workspace.style.cursor = hg.axis === 'v' ? 'ew-resize' : 'ns-resize'; _guideHovered = true; }
    }

    // Rotate handle drag
    if (pxTransformHandle === 'rotate' && pxTransformActive && pxTransformData && _rotateCenter) {
      const curAngle = Math.atan2(py - _rotateCenter.y, px - _rotateCenter.x);
      let delta = curAngle - _rotateStartAngle;
      if (SnapEngine.isActive(e)) {
        const step      = Math.PI / 4;
        const threshold = Math.PI / 36;
        const nearest = Math.round(delta / step) * step;
        if (Math.abs(delta - nearest) < threshold) delta = nearest;
      }
      pxTransformData.liveRotation = delta;
      scheduleCompositeAndOverlay();
      return true;
    }

    // Scale/move handle drag
    if (pxTransformHandle && pxTransformActive && pxTransformData) {
      pxTransformData.curBounds = computePxTransformBounds(pxTransformHandle, px, py, e.shiftKey, e.altKey);
      const _b = pxTransformData.curBounds; const _h = pxTransformHandle;
      const _cx = [], _cy = [];
      if (_h === 'move' || /w/.test(_h)) _cx.push({val: _b.x});
      if (_h === 'move' || /e/.test(_h)) _cx.push({val: _b.x + _b.w});
      if (_h === 'move') _cx.push({val: _b.x + _b.w/2});
      if (_h === 'move' || /n/.test(_h)) _cy.push({val: _b.y});
      if (_h === 'move' || /s/.test(_h)) _cy.push({val: _b.y + _b.h});
      if (_h === 'move') _cy.push({val: _b.y + _b.h/2});
      const _snap = SnapEngine.snapBounds(_b, {candidatesX:_cx, candidatesY:_cy, modifiers:e});
      if (_snap.dx || _snap.dy) {
        if (_h === 'move') { _b.x += _snap.dx; _b.y += _snap.dy; }
        else {
          if (_snap.dx) {
            if (/w/.test(_h)) { _b.x += _snap.dx; _b.w -= _snap.dx; }
            else if (/e/.test(_h)) { _b.w += _snap.dx; }
          }
          if (_snap.dy) {
            if (/n/.test(_h)) { _b.y += _snap.dy; _b.h -= _snap.dy; }
            else if (/s/.test(_h)) { _b.h += _snap.dy; }
          }
        }
      }
      scheduleCompositeAndOverlay();
      return true;
    }

    // Update text layer hover outline when not dragging
    if (!pxTransformHandle && !isMovingPixels && !isPanning && window.TextTool) {
      window.TextTool.updateHover(px, py);
    }

    // Cursor updates when hovering (no drag active)
    if (pxTransformHandle === 'rotate') {
      workspace.style.cursor = ROTATE_CURSOR;
    } else if (!_guideHovered && pxTransformActive && pxTransformData && !pxTransformHandle) {
      const hit = hitTestPxTransform(px, py);
      if (hit === 'rotate') {
        workspace.style.cursor = ROTATE_CURSOR;
      } else if (hit) {
        const c = {nw:'nw-resize',n:'n-resize',ne:'ne-resize',w:'w-resize',e:'e-resize',sw:'sw-resize',s:'s-resize',se:'se-resize',move:'move'};
        workspace.style.cursor = c[hit] || 'default';
      } else {
        workspace.style.cursor = 'default';
      }
    } else if (!_guideHovered && !pxTransformActive && !floatingActive && !isPanning && !isMovingPixels) {
      const _pick = pickMoveTarget(px, py);
      workspace.style.cursor = _pick ? 'move' : 'default';
    }

    // Floating drag
    if (isMovingPixels && floatingActive && floatingCanvas) {
      if (!_floatingDragBaseOffset) { _floatingDragBaseOffset = { x: floatingOffset.x, y: floatingOffset.y }; _floatingDragStart = { x: drawStart.x, y: drawStart.y }; }
      const _ux = _floatingDragBaseOffset.x + (px - _floatingDragStart.x);
      const _uy = _floatingDragBaseOffset.y + (py - _floatingDragStart.y);
      const _fb = { x: _ux, y: _uy, w: floatingCanvas.width, h: floatingCanvas.height };
      const _snap = SnapEngine.snapBounds(_fb, {modifiers: e});
      floatingOffset.x = _ux + _snap.dx;
      floatingOffset.y = _uy + _snap.dy;
      drawStart = { x: px, y: py };
      scheduleCompositeAndOverlay();
      return true;
    }
  },

  mouseUp(e) {
    // Rotate drag end
    if (pxTransformHandle === 'rotate') {
      const _d = pxTransformData;
      pxTransformHandle = null; pxTransformStartMouse = null; pxTransformOrigBounds = null;
      _rotateCenter = null; _rotateStartAngle = 0;
      if (_d) {
        _d.totalRotation = (_d.totalRotation || 0) + (_d.liveRotation || 0);
        _d.liveRotation = 0;
      }
      SnapEngine.endSession();
      updatePropertiesPanel();
      compositeAll(); drawOverlay();
      return true;
    }

    // Scale/move drag end
    if (pxTransformHandle) {
      const _handle = pxTransformHandle;
      const _orig = pxTransformOrigBounds;
      const _d = pxTransformData;
      const _moved = !!(_d && _orig && (
        _orig.x !== _d.curBounds.x || _orig.y !== _d.curBounds.y ||
        _orig.w !== _d.curBounds.w || _orig.h !== _d.curBounds.h));
      const _altDup = _moveDragAltDuplicate && _handle === 'move' && _moved
                      && _d && !_d.totalRotation && !_d.liveRotation;
      _moveDragAltDuplicate = false;
      pxTransformHandle = null; pxTransformStartMouse = null; pxTransformOrigBounds = null;
      SnapEngine.endSession();
      if (_altDup && _d) {
        const layer = getActiveLayer();
        if (layer) {
          const sb = _d.srcBounds;
          layer.ctx.drawImage(_d.srcCanvas, 0, 0, _d.srcCanvas.width, _d.srcCanvas.height, sb.x, sb.y, sb.w, sb.h);
          SnapEngine.invalidateLayer(layer);
        }
        pushUndo('Duplicate');
      }
      updatePropertiesPanel();
      compositeAll(); drawOverlay();
      return true;
    }

    // Floating drag end
    if (isMovingPixels) {
      isMovingPixels = false; _floatingDragBaseOffset = null; _floatingDragStart = null;
      SnapEngine.endSession(); drawOverlay();
      pushUndo('Move');
      return true;
    }
  }
});

// ──── Move Selection Tool ──────────────────────────────────────────────────────

ToolRegistry.register('movesel', {
  activate() {
    workspace.style.cursor = 'default';
    transformSelActive = true;
    drawOverlay();
  },

  deactivate() {
    transformSelActive = false;
  },

  mouseDown(e, pos) {
    const px = pos.x, py = pos.y;

    // Move Selection has no behavior on shape layers — swallow the click so a
    // shape isn't accidentally treated as a pixel-selection drag target.
    const _layer = (typeof layers !== 'undefined' && typeof activeLayerIndex !== 'undefined')
      ? layers[activeLayerIndex] : null;
    if (_layer && _layer.kind === 'shape') {
      isDrawing = false;
      return true;
    }

    if (transformSelActive) {
      const handle = getTransformHandle(px, py);
      if (handle) {
        transformHandleDrag = handle;
        transformOrigBounds = selection ? JSON.parse(JSON.stringify(selection)) : null;
        isDrawing = false;
        _transformDragMoved = false;
        SnapEngine.beginSession({ excludeSelection: true });
        return true;
      }
    }
    isDrawing = false;
    return true;
  },

  mouseMove(e, pos) {
    const px = pos.x, py = pos.y;

    if (transformHandleDrag && transformOrigBounds) {
      const dx = px - drawStart.x, dy = py - drawStart.y;
      if (dx !== 0 || dy !== 0) _transformDragMoved = true;
      selection = { ...transformOrigBounds };
      applyTransformDelta(transformHandleDrag, dx, dy);
      const _tb = getSelectionBounds();
      if (_tb) {
        const _h = transformHandleDrag;
        const _cx = [], _cy = [];
        if (_h === 'move' || /w/.test(_h)) _cx.push({val: _tb.x});
        if (_h === 'move' || /e/.test(_h)) _cx.push({val: _tb.x + _tb.w});
        if (_h === 'move') _cx.push({val: _tb.x + _tb.w/2});
        if (_h === 'move' || /n/.test(_h)) _cy.push({val: _tb.y});
        if (_h === 'move' || /s/.test(_h)) _cy.push({val: _tb.y + _tb.h});
        if (_h === 'move') _cy.push({val: _tb.y + _tb.h/2});
        const _snap = SnapEngine.snapBounds(_tb, {candidatesX:_cx, candidatesY:_cy, modifiers:e});
        if (_snap.dx || _snap.dy) {
          selection = { ...transformOrigBounds };
          applyTransformDelta(transformHandleDrag, dx + _snap.dx, dy + _snap.dy);
        }
      }
      return true;
    }

    // Cursor hover
    if (!isDrawing) {
      const h = getTransformHandle(px, py);
      if (h) {
        const c = {nw:'nw-resize',n:'n-resize',ne:'ne-resize',w:'w-resize',e:'e-resize',sw:'sw-resize',s:'s-resize',se:'se-resize',move:'move'};
        workspace.style.cursor = c[h] || 'default';
      } else {
        workspace.style.cursor = 'default';
      }
    }
  },

  mouseUp(e) {
    if (transformHandleDrag) {
      const _moved = _transformDragMoved;
      _transformDragMoved = false;
      transformHandleDrag = null; transformOrigBounds = null;
      SnapEngine.endSession(); drawOverlay();
      if (_moved) pushUndo('Move Selection');
      return true;
    }
  }
});
