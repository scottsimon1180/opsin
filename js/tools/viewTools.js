"use strict";

/* ═══════════════════════════════════════════════════════
   VIEW TOOLS — Pan, Zoom, Ruler, Eyedropper
   Depends on: toolRegistry.js, script.js, coordinates.js,
               rendering.js (drawUIOverlay),
               toolbar.js (updateRulerOptionsBar)
   ═══════════════════════════════════════════════════════ */

// ── PAN ──────────────────────────────────────────────────
// Mouse lifecycle (isPanning) is handled globally in script.js —
// the pan shortcuts block (middle-click, space-drag, alt-drag, pan tool)
// fires before the registry dispatch and owns mouseMove/mouseUp.
// This entry exists only for activate so the cursor is set correctly.

ToolRegistry.register('pan', {
  activate() {
    workspace.style.cursor = 'grab';
  },
  deactivate() {}
});


// ── ZOOM ─────────────────────────────────────────────────

ToolRegistry.register('zoom', {
  activate() {
    workspace.style.cursor = 'zoom-in';
  },
  deactivate() {},
  mouseDown(e) {
    if (e.button !== 0) return;
    const r = workspace.getBoundingClientRect();
    if (e.shiftKey) zoomTo(zoom / 1.4, e.clientX - r.left, e.clientY - r.top);
    else            zoomTo(zoom * 1.4, e.clientX - r.left, e.clientY - r.top);
    return true;
  }
});


// ── RULER ────────────────────────────────────────────────

ToolRegistry.register('ruler', {
  activate() {
    document.getElementById('opt-ruler').classList.remove('hidden');
    updateRulerOptionsBar();
  },
  deactivate() {
    clearRuler();
  },

  mouseDown(e) {
    if (e.button !== 0) return;
    const pos = screenToCanvas(e.clientX, e.clientY);
    const px = pos.x, py = pos.y;
    const hit = rulerHitTest(e.clientX, e.clientY);
    if (hit && hit.type === 'handle') {
      SnapEngine.beginSession({});
      rulerDrag = { mode: 'handle', which: hit.which };
      workspace.style.cursor = 'grabbing';
    } else if (hit && hit.type === 'line') {
      SnapEngine.beginSession({});
      rulerDrag = { mode: 'move', grabOffset: { dx: px - rulerState.x1, dy: py - rulerState.y1 } };
      workspace.style.cursor = 'all-scroll';
    } else {
      if (rulerState.active) clearRuler();
      SnapEngine.beginSession({});
      const _p = snapRulerPoint({ x: px, y: py }, e, null);
      rulerState.active = true;
      rulerState.x1 = _p.x; rulerState.y1 = _p.y;
      rulerState.x2 = _p.x; rulerState.y2 = _p.y;
      rulerDrag = { mode: 'draw' };
      workspace.style.cursor = 'crosshair';
    }
    drawUIOverlay();
    updateRulerOptionsBar();
    return true;
  },

  mouseMove(e) {
    if (isPanning) return; // let global isPanning block handle pan-while-ruler
    const pos = screenToCanvas(e.clientX, e.clientY);
    const px = pos.x, py = pos.y;
    if (rulerDrag) {
      if (rulerDrag.mode === 'draw' || rulerDrag.mode === 'handle') {
        const which = rulerDrag.mode === 'draw' ? 2 : rulerDrag.which;
        const anchor = which === 2
          ? { x: rulerState.x1, y: rulerState.y1 }
          : { x: rulerState.x2, y: rulerState.y2 };
        const _p = snapRulerPoint({ x: px, y: py }, e, anchor);
        if (which === 2) { rulerState.x2 = _p.x; rulerState.y2 = _p.y; }
        else             { rulerState.x1 = _p.x; rulerState.y1 = _p.y; }
        workspace.style.cursor = rulerDrag.mode === 'draw' ? 'crosshair' : 'grabbing';
      } else if (rulerDrag.mode === 'move') {
        const rawX = px - rulerDrag.grabOffset.dx;
        const rawY = py - rulerDrag.grabOffset.dy;
        const snapped = SnapEngine.snapPoint({ x: rawX, y: rawY }, { modifiers: e });
        const newX1 = Math.round(snapped.x);
        const newY1 = Math.round(snapped.y);
        const dX = newX1 - rulerState.x1;
        const dY = newY1 - rulerState.y1;
        rulerState.x1 += dX; rulerState.y1 += dY;
        rulerState.x2 += dX; rulerState.y2 += dY;
        workspace.style.cursor = 'all-scroll';
      }
      drawUIOverlay();
      updateRulerOptionsBar();
    } else {
      const hit = rulerHitTest(e.clientX, e.clientY);
      workspace.style.cursor = getRulerCursor(hit, false);
    }
    return true;
  },

  mouseUp(e) {
    if (!rulerDrag) return; // not our event (e.g. panning ended while ruler is active)
    if (rulerDrag.mode === 'draw' &&
        rulerState.x1 === rulerState.x2 &&
        rulerState.y1 === rulerState.y2) {
      clearRuler();
    } else {
      rulerDrag = null;
      SnapEngine.endSession();
      drawUIOverlay();
    }
    rulerDrag = null;
    isDrawing = false;
    const hit = rulerHitTest(e.clientX, e.clientY);
    workspace.style.cursor = getRulerCursor(hit, false);
    return true;
  }
});


// ── EYEDROPPER ────────────────────────────────────────────
// Standalone toolbar tool. Samples the composite canvas and
// sets fgColor (alt/shift sets bgColor). Independent of the
// panel / colorPicker eyedroppers (panelEyedropperActive,
// _iframeEyedropperActive) — those keep their own toggle flow.

ToolRegistry.register('eyedropper', {
  activate() {
    workspace.style.cursor = _eyedropperCursorUrl;
  },
  deactivate() {},
  mouseDown(e) {
    if (e.button !== 0) return;
    const pos = screenToCanvas(e.clientX, e.clientY);
    const ix = Math.floor(pos.x), iy = Math.floor(pos.y);
    if (ix < 0 || iy < 0 || ix >= canvasW || iy >= canvasH) return true;
    const d = compositeCtx.getImageData(ix, iy, 1, 1).data;
    const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
    const hsv = rgbToHsv(d[0], d[1], d[2]);
    if (hsv.s > 0 && hsv.v > 0) cpH = hsv.h;
    cpS = hsv.s; cpV = hsv.v;
    if (e.altKey || e.shiftKey) setBgColor(hex);
    else setFgColor(hex);
    return true;
  },
  mouseMove(e) {
    workspace.style.cursor = _eyedropperCursorUrl;
    return true;
  }
});
