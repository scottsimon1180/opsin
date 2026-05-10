"use strict";

/* ═══════════════════════════════════════════════════════
   TEXT TOOL — Pixlr-inspired editable text smart-object

   Public surface (window.TextTool):
     TextTool.beginEdit(layer)   — open the editing UI for an
                                   existing text layer.
     TextTool.endEdit(commit)    — commit (true) or cancel (false)
                                   any active session.
     TextTool.isActive()         — true while a box is on screen.
     TextTool.requireRasterize(layer, toolName) → Promise<bool>
                                   Show modal; resolves true if
                                   user chose to rasterize.

     TextTool.renderTextLayer(layer) — paint a layer's textModel
                                   onto its own canvas.

   Behavior:
     - Click on canvas: point text (Lorem Ipsum prefilled+selected).
     - Drag on canvas: paragraph text (fixed-width wrap).
     - Edit mode: red dashed border, contenteditable focused.
     - Reposition mode: blue solid border, drag to move,
       8 corner/edge handles to resize, top disc to rotate.
     - Click outside: commit, hide box.
     - Double-click box: re-enter edit mode.
     - Per-character formatting (Ctrl+B/I/U or popover toggles).
     - Live preview: every keystroke re-renders to layer canvas.
   ═══════════════════════════════════════════════════════ */

window.TextTool = (function() {

  // ── State ──────────────────────────────────────────────
  let session = null;            // { layer, mode:'edit'|'reposition', el, editEl, ... }
  let pendingNewLayerOnNextDown = false;
  let dragOp = null;             // { kind:'move'|'resize', ... }
  let _activeFont = 'Arial';
  let _activeSize = 96;
  let _activeBold = false;
  let _activeItalic = false;
  let _activeUnderline = false;
  let _activeAlign = 'center';
  let _activeLineSpacing = 1.2;
  let _activeLetterSpacing = 0;
  let _savedRange = null;
  let _hoverEl = null;
  let _hoverLayer = null;

  const DEFAULT_FONTS = [
    'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
    'Courier New', 'Verdana', 'Impact', 'Tahoma',
    'Trebuchet MS', 'Comic Sans MS', 'Lucida Console', 'Palatino Linotype'
  ];
  const SIZE_PRESETS = [8, 10, 12, 14, 18, 24, 36, 48, 72, 96, 144];
  const LOREM = 'Lorem Ipsum';
  const MIN_BOX_W = 20;
  const MIN_BOX_H = 16;
  const TEXT_PAD_X = 4;
  const TEXT_PAD_Y = 2;

  // ── Geometry helpers ───────────────────────────────────

  // Convert canvas-space rect → screen-space rect (within #canvasWrapper).
  // canvasWrapper is already transformed; placing children in canvas coords
  // (1 CSS px per canvas px, plain top/left) auto-scales with the wrapper.
  // Text box chrome lives in workspace screen space so its stroke/handles
  // stay visually fixed while the underlying canvas zooms and pans.
  function _overlayRoot() {
    return workspace || document.getElementById('workspace');
  }

  function _modelBoxToScreenRect(model) {
    const p1 = c2s(model.boxX, model.boxY);
    const p2 = c2s(model.boxX + model.boxW, model.boxY + model.boxH);
    return { x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y };
  }

  // ── DOM helpers ────────────────────────────────────────

  function _nodeInside(root, node) {
    if (!root || !node) return false;
    const el = node.nodeType === 1 ? node : node.parentNode;
    return !!el && (el === root || root.contains(el));
  }

  function _selectionInsideEditor(sel, editEl) {
    if (!sel || !editEl || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    return _nodeInside(editEl, range.commonAncestorContainer)
      && _nodeInside(editEl, sel.anchorNode)
      && _nodeInside(editEl, sel.focusNode);
  }

  function _saveEditorSelection() {
    if (!session || !session.editEl) return;
    const sel = window.getSelection();
    if (_selectionInsideEditor(sel, session.editEl)) {
      _savedRange = sel.getRangeAt(0).cloneRange();
    }
  }

  function _restoreEditorSelection() {
    if (!session || !session.editEl || !_savedRange) return false;
    if (!_nodeInside(session.editEl, _savedRange.commonAncestorContainer)) return false;
    const sel = window.getSelection();
    try {
      sel.removeAllRanges();
      sel.addRange(_savedRange.cloneRange());
      return true;
    } catch (err) {
      _savedRange = null;
      return false;
    }
  }

  function _escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function _escapeAttr(value) {
    return _escapeHtml(value).replace(/"/g, '&quot;');
  }

  function _cleanFontFamily(value) {
    const raw = String(value || '').split(',')[0].trim();
    return raw.replace(/^['"]|['"]$/g, '') || null;
  }

  function _cssFontFamily(value) {
    return '"' + String(value || _activeFont).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function _parseCssSize(value, fallback) {
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function _sameRunStyle(a, b) {
    return a.font === b.font
      && a.size === b.size
      && a.color === b.color
      && !!a.bold === !!b.bold
      && !!a.italic === !!b.italic
      && !!a.underline === !!b.underline;
  }

  function _pushRun(runs, run) {
    if (!run || run.text === '') return;
    const normalized = {
      text: String(run.text),
      font: run.font || _activeFont,
      size: _parseCssSize(run.size, _activeSize),
      color: run.color || (typeof fgColor !== 'undefined' ? fgColor : '#ffffff'),
      bold: !!run.bold,
      italic: !!run.italic,
      underline: !!run.underline
    };
    const prev = runs[runs.length - 1];
    if (prev && _sameRunStyle(prev, normalized)) prev.text += normalized.text;
    else runs.push(normalized);
  }

  function _cloneTextModel(model) {
    if (!model) return null;
    const lineSpacing = Number(model.lineSpacing);
    const letterSpacing = Number(model.letterSpacing);
    return {
      runs: (model.runs || []).map(r => ({
        text: String(r.text || ''),
        font: r.font || _activeFont,
        size: _parseCssSize(r.size, _activeSize),
        color: r.color || '#ffffff',
        bold: !!r.bold,
        italic: !!r.italic,
        underline: !!r.underline
      })),
      boxX: Number(model.boxX) || 0,
      boxY: Number(model.boxY) || 0,
      boxW: Math.max(MIN_BOX_W, Number(model.boxW) || MIN_BOX_W),
      boxH: Math.max(MIN_BOX_H, Number(model.boxH) || MIN_BOX_H),
      rotation: Number(model.rotation) || 0,
      mode: model.mode === 'paragraph' ? 'paragraph' : 'point',
      align: model.align || 'left',
      lineSpacing: Number.isFinite(lineSpacing) ? lineSpacing : 1.2,
      letterSpacing: Number.isFinite(letterSpacing) ? letterSpacing : 0,
      widthLocked: !!model.widthLocked
    };
  }

  function _modelsEqual(a, b) {
    return JSON.stringify(_cloneTextModel(a)) === JSON.stringify(_cloneTextModel(b));
  }

  function _modelHasText(model) {
    return !!(model && model.runs && model.runs.some(r => String(r.text || '').trim()));
  }

  function _removeLayer(layer) {
    const idx = layers.indexOf(layer);
    if (idx < 0 || layers.length <= 1) return false;
    layers.splice(idx, 1);
    activeLayerIndex = Math.min(Math.max(0, idx - 1), layers.length - 1);
    selectedLayers = new Set([activeLayerIndex]);
    if (typeof compositeAll === 'function') compositeAll();
    if (typeof updateLayerPanel === 'function') updateLayerPanel();
    return true;
  }

  function _ensureBoxDom() {
    if (session && session.el && session.el.parentNode) return session.el;
    const el = document.createElement('div');
    el.className = 'tx-box';
    el.innerHTML = `
      <div class="tx-edit" contenteditable="true" spellcheck="false"></div>
      <div class="tx-handle tx-h-e"  data-handle="e"></div>
      <div class="tx-handle tx-h-s"  data-handle="s"></div>
      <div class="tx-handle tx-h-w"  data-handle="w"></div>
    `;
    return el;
  }

  // Apply box position/size/rotation to the DOM element.
  function _syncBoxDom() {
    if (!session) return;
    const m = session.layer.textModel;
    const el = session.el;
    const rect = _modelBoxToScreenRect(m);
    const z = typeof zoom !== 'undefined' ? zoom : 1;
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
    el.style.opacity = session.layer.opacity == null ? '1' : String(session.layer.opacity);
    // Rotation: pivot the box around its center.
    el.style.transformOrigin = '50% 50%';
    el.style.transform = `rotate(${m.rotation || 0}rad)`;
    el.classList.toggle('is-editing', session.mode === 'edit');

    // Apply text-level formatting to the editor surface so the visible
    // preview matches what _renderTextLayer will draw.
    const ed = session.editEl;
    const _r0 = m.runs[0] || {};
    ed.style.fontFamily = `"${_r0.font || _activeFont}", sans-serif`;
    ed.style.fontSize = (_r0.size || _activeSize) + 'px';
    ed.style.fontWeight = _r0.bold ? '700' : '400';
    ed.style.fontStyle = _r0.italic ? 'italic' : 'normal';
    ed.style.textDecoration = _r0.underline ? 'underline' : 'none';
    ed.style.lineHeight = (m.lineSpacing || 1.2);
    ed.style.letterSpacing = (m.letterSpacing || 0) + 'px';
    ed.style.textAlign = m.align || 'left';
    ed.style.color = _r0.color || '#ffffff';
    ed.style.width = m.boxW + 'px';
    ed.style.height = m.boxH + 'px';
    ed.style.transformOrigin = '0 0';
    ed.style.transform = `scale(${z})`;
    // Paragraph mode wraps; point mode does not.
    if (m.mode === 'point') {
      ed.style.whiteSpace = 'pre';
      ed.style.wordWrap = 'normal';
    } else {
      ed.style.whiteSpace = 'pre-wrap';
      ed.style.wordWrap = 'break-word';
    }
  }

  function _adoptModelDefaults(model) {
    if (!model) return;
    const first = (model.runs && model.runs[0]) || {};
    _activeFont = first.font || _activeFont;
    _activeSize = _parseCssSize(first.size, _activeSize);
    _activeBold = !!first.bold;
    _activeItalic = !!first.italic;
    _activeUnderline = !!first.underline;
    _activeAlign = model.align || _activeAlign;
    const lineSpacing = Number(model.lineSpacing);
    const letterSpacing = Number(model.letterSpacing);
    _activeLineSpacing = Number.isFinite(lineSpacing) ? lineSpacing : _activeLineSpacing;
    _activeLetterSpacing = Number.isFinite(letterSpacing) ? letterSpacing : 0;

    _refreshFontButton();
    _refreshFillChip();
    const sizeStr = String(Math.round(_activeSize));
    _eachId(['txSize', 'ptxSize'], (el) => { if (document.activeElement !== el) el.value = sizeStr; });
    _eachId(['txLineSpacing', 'ptxLineSpacing'], (el) => { if (document.activeElement !== el) el.value = _activeLineSpacing; });
    _eachId(['txLineSpacingNum', 'ptxLineSpacingNum'], (el) => { if (document.activeElement !== el) el.value = _activeLineSpacing.toFixed(2); });
    _eachId(['txLetterSpacing', 'ptxLetterSpacing'], (el) => { if (document.activeElement !== el) el.value = _activeLetterSpacing; });
    _eachId(['txLetterSpacingNum', 'ptxLetterSpacingNum'], (el) => { if (document.activeElement !== el) el.value = Math.round(_activeLetterSpacing); });
    _refreshAlignButtons();
    _refreshStyleButtons();
    _refreshTextPanelEnabled();
  }

  // Serialize the contenteditable's HTML into runs[].
  // Each run = { text, font, size, color, bold, italic, underline }.
  function _serializeRuns(editEl, defaults) {
    const runs = [];
    const def = defaults || {};
    function inheritElementStyle(node, ctx) {
      const next = { ...ctx };
      const style = node.style || {};
      const tag = node.tagName;
      const font = _cleanFontFamily(style.fontFamily || (tag === 'FONT' ? node.getAttribute('face') : ''));
      const size = _parseCssSize(style.fontSize, null);
      const color = style.color || (tag === 'FONT' ? node.getAttribute('color') : '');
      const weight = String(style.fontWeight || '').toLowerCase();
      const decoration = String(style.textDecorationLine || style.textDecoration || '').toLowerCase();

      if (font) next.font = font;
      if (size) next.size = size;
      if (color) next.color = color;
      if (tag === 'B' || tag === 'STRONG' || weight === 'bold' || parseInt(weight, 10) >= 600) next.bold = true;
      if (tag === 'I' || tag === 'EM' || style.fontStyle === 'italic' || style.fontStyle === 'oblique') next.italic = true;
      if (tag === 'U' || decoration.includes('underline')) next.underline = true;
      return next;
    }
    function walk(node, ctx) {
      if (node.nodeType === 3) {
        if (!node.nodeValue) return;
        _pushRun(runs, {
          text: node.nodeValue,
          font: ctx.font,
          size: ctx.size,
          color: ctx.color,
          bold: !!ctx.bold,
          italic: !!ctx.italic,
          underline: !!ctx.underline
        });
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      const next = inheritElementStyle(node, ctx);
      if (tag === 'BR') { _pushRun(runs, { text: '\n', font: ctx.font, size: ctx.size, color: ctx.color, bold: !!ctx.bold, italic: !!ctx.italic, underline: !!ctx.underline }); return; }
      if (tag === 'DIV' || tag === 'P') {
        // Treat a div/p as an implicit line break before its content
        // (browsers insert these for line wrapping).
        if (runs.length && !runs[runs.length-1].text.endsWith('\n')) {
          _pushRun(runs, { text: '\n', font: ctx.font, size: ctx.size, color: ctx.color, bold: !!ctx.bold, italic: !!ctx.italic, underline: !!ctx.underline });
        }
      }
      for (const ch of node.childNodes) walk(ch, next);
    }
    const root = {
      font: def.font || _activeFont,
      size: def.size || _activeSize,
      color: def.color || (typeof fgColor !== 'undefined' ? fgColor : '#ffffff'),
      bold: false, italic: false, underline: false
    };
    for (const ch of editEl.childNodes) walk(ch, root);
    if (!runs.length) {
      runs.push({ text: '', font: root.font, size: root.size, color: root.color, bold: false, italic: false, underline: false });
    }
    return runs;
  }

  // Render runs[] back into the contenteditable.
  function _runsToEditableHtml(runs) {
    const out = [];
    // All text shares one uniform style — output plain text only.
    // Bold/italic/underline/color/font/size are applied via box-level CSS in _syncBoxDom.
    for (const r of runs) {
      out.push(_escapeHtml(r.text || '').replace(/\n/g, '<br>'));
    }
    return out.join('');
  }

  // ── Rasterization (text → layer canvas) ────────────────

  function _setCtxRunFont(ctx, run, model) {
    const weight = run.bold ? '700' : '400';
    const style = run.italic ? 'italic' : 'normal';
    const size = _parseCssSize(run.size, _activeSize);
    const font = run.font || _activeFont;
    ctx.font = `${style} ${weight} ${size}px "${font}", sans-serif`;
  }

  // Wrap text within maxWidth (paragraph mode only). Returns array of lines,
  // each line a list of run-fragments (text shares the run's style).
  function _layoutModel(layer) {
    const m = layer.textModel;
    if (!m) return null;
    const ctx = layer.ctx;
    // Tokenize runs → words while preserving styles and explicit \n.
    const tokens = [];
    for (const r of m.runs) {
      const s = String(r.text || '').replace(/\r\n?/g, '\n');
      // Split into words, spaces, and newlines while keeping them all.
      const parts = s.split(/(\n|\s+)/);
      for (const p of parts) {
        if (!p) continue;
        tokens.push({ text: p, run: r });
      }
    }
    const lines = [];
    let cur = [];
    let curW = 0;
    const wrapWidth = m.mode === 'paragraph' ? Math.max(8, m.boxW - TEXT_PAD_X * 2) : Infinity;

    function pushLine() { lines.push(cur); cur = []; curW = 0; }

    for (const tok of tokens) {
      if (tok.text === '\n') { pushLine(); continue; }
      _setCtxRunFont(ctx, tok.run, m);
      const w = ctx.measureText(tok.text).width + (m.letterSpacing || 0) * Math.max(0, tok.text.length - 1);
      if (curW + w > wrapWidth && cur.length > 0 && /\S/.test(tok.text)) {
        // Wrap before this token (skip if the line is empty to avoid infinite loops on huge words).
        pushLine();
      }
      cur.push({ ...tok, width: w });
      curW += w;
    }
    if (cur.length) pushLine();
    return lines;
  }

  // Compute the natural width/height of laid-out lines.
  function _measureLines(layer, lines) {
    const m = layer.textModel;
    const ctx = layer.ctx;
    let maxW = 0;
    const lineHeights = [];
    for (const line of lines) {
      let w = 0;
      let ascent = 0, descent = 0;
      let maxSize = 0;
      for (const t of line) {
        _setCtxRunFont(ctx, t.run, m);
        const tm = ctx.measureText(t.text);
        const size = _parseCssSize(t.run.size, _activeSize);
        w += tm.width + (m.letterSpacing || 0) * Math.max(0, t.text.length - 1);
        ascent  = Math.max(ascent,  tm.fontBoundingBoxAscent  || tm.actualBoundingBoxAscent  || size * 0.8);
        descent = Math.max(descent, tm.fontBoundingBoxDescent || tm.actualBoundingBoxDescent || size * 0.2);
        maxSize = Math.max(maxSize, size);
      }
      maxW = Math.max(maxW, w);
      if (!line.length) {
        maxSize = _parseCssSize(m.runs[0]?.size, _activeSize);
        _setCtxRunFont(ctx, m.runs[0] || { size: maxSize }, m);
        const tm = ctx.measureText('M');
        ascent  = tm.fontBoundingBoxAscent  || tm.actualBoundingBoxAscent  || maxSize * 0.8;
        descent = tm.fontBoundingBoxDescent || tm.actualBoundingBoxDescent || maxSize * 0.2;
      }
      const contentHeight = ascent + descent;
      const height = Math.max(contentHeight, maxSize * Math.max(0.1, m.lineSpacing || 1.2));
      lineHeights.push({ ascent, descent, height, leadingTop: Math.max(0, (height - contentHeight) / 2) });
    }
    const totalH = lineHeights.reduce((sum, lh) => sum + lh.height, 0);
    return { maxW, lineHeights, totalH };
  }

  function renderTextLayer(layer) {
    if (!layer || layer.kind !== 'text' || !layer.textModel) return;
    const m = layer.textModel;
    const ctx = layer.ctx;
    ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    if (!m.runs || m.runs.length === 0) return;

    const lines = _layoutModel(layer);
    if (!lines || !lines.length) return;
    const meas = _measureLines(layer, lines);
    if (!meas) return;

    const cx = m.boxX + m.boxW / 2;
    const cy = m.boxY + m.boxH / 2;
    ctx.save();
    ctx.translate(cx, cy);
    if (m.rotation) ctx.rotate(m.rotation);
    ctx.translate(-m.boxW / 2, -m.boxH / 2);

    let yTop = TEXT_PAD_Y;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const metrics = meas.lineHeights[lineIndex] || { ascent: _activeSize * 0.8, height: _activeSize * 1.2, leadingTop: 0 };
      const baselineY = yTop + metrics.leadingTop + metrics.ascent;
      // Compute line width (excluding trailing whitespace in our tokens — we
      // keep them so caret positioning stays predictable).
      let lineW = 0;
      for (const t of line) lineW += t.width;
      let xStart;
      if (m.align === 'center')      xStart = (m.boxW - lineW) / 2;
      else if (m.align === 'right')  xStart = (m.boxW - lineW) - TEXT_PAD_X;
      else                            xStart = TEXT_PAD_X;
      // Justify: distribute extra space across word boundaries (skip for last line).
      let justifyExtra = 0;
      if (m.align === 'justify' && m.mode === 'paragraph') {
        const wordCount = line.filter(t => /^\s+$/.test(t.text)).length;
        if (wordCount > 0) justifyExtra = ((m.boxW - TEXT_PAD_X * 2) - lineW) / wordCount;
      }

      let x = xStart;
      for (const t of line) {
        _setCtxRunFont(ctx, t.run, m);
        ctx.fillStyle = t.run.color || '#ffffff';
        ctx.textBaseline = 'alphabetic';

        // Honor letterSpacing by drawing char-by-char when nonzero.
        const ls = m.letterSpacing || 0;
        if (ls === 0) {
          ctx.fillText(t.text, x, baselineY);
        } else {
          let cx2 = x;
          for (const ch of t.text) {
            ctx.fillText(ch, cx2, baselineY);
            cx2 += ctx.measureText(ch).width + ls;
          }
        }

        // Underline
        if (t.run.underline) {
          const w = (ls === 0) ? ctx.measureText(t.text).width : (t.width);
          const size = _parseCssSize(t.run.size, _activeSize);
          const uy = baselineY + Math.max(2, size * 0.12);
          ctx.save();
          ctx.strokeStyle = t.run.color || '#ffffff';
          ctx.lineWidth = Math.max(1, size / 18);
          ctx.beginPath();
          ctx.moveTo(x, uy);
          ctx.lineTo(x + w, uy);
          ctx.stroke();
          ctx.restore();
        }

        x += t.width;
        if (m.align === 'justify' && /^\s+$/.test(t.text)) x += justifyExtra;
      }
      yTop += metrics.height;
    }
    ctx.restore();
  }

  // Recompute boxH (and boxW if not user-locked) for point text.
  function _autoFitPointText(layer) {
    const m = layer.textModel;
    if (!m || m.mode !== 'point') return;
    const lines = _layoutModel(layer);
    if (!lines) return;
    const meas = _measureLines(layer, lines);
    if (!m.widthLocked) m.boxW = Math.max(40, Math.ceil(meas.maxW) + TEXT_PAD_X * 2);
    m.boxH = Math.max(MIN_BOX_H, Math.ceil(meas.totalH) + TEXT_PAD_Y * 2);
  }

  // ── Session lifecycle ──────────────────────────────────

  function _createSession(layer, mode, opts) {
    if (session) endEdit(true);
    _clearHover();
    const wrap = _overlayRoot();
    const el = _ensureBoxDom();
    wrap.appendChild(el);
    _savedRange = null;
    session = {
      layer,
      mode,
      el,
      editEl: el.querySelector('.tx-edit'),
      isNew: !!(opts && opts.isNew),
      preLorem: !!(opts && opts.preLorem),
      originalName: layer.name,
      originalModel: _cloneTextModel(layer.textModel)
    };
    _adoptModelDefaults(layer.textModel);
    _syncBoxDom();
    _hookSessionEvents();

    if (session.preLorem) {
      session.editEl.textContent = LOREM;
      // Select all on next frame so focus is settled.
      requestAnimationFrame(() => {
        if (!session) return;
        session.editEl.focus();
        const range = document.createRange();
        range.selectNodeContents(session.editEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        _savedRange = range.cloneRange();
        _syncFromEditor();
      });
    } else if (mode === 'edit') {
      session.editEl.innerHTML = _runsToEditableHtml(layer.textModel.runs);
      requestAnimationFrame(() => { if (session) session.editEl.focus(); });
    } else {
      session.editEl.innerHTML = _runsToEditableHtml(layer.textModel.runs);
    }
    _refreshTextPanelEnabled();
  }

  function _hookSessionEvents() {
    const s = session;
    // Input → live preview
    s._onInput = () => { _syncFromEditor(); _saveEditorSelection(); };
    s._onRememberSelection = () => _saveEditorSelection();
    s.editEl.addEventListener('input', s._onInput);
    s.editEl.addEventListener('keyup', s._onRememberSelection);
    s.editEl.addEventListener('mouseup', s._onRememberSelection);
    s.editEl.addEventListener('focus', s._onRememberSelection);

    // Click on the box (not on a handle, not on the edit area when editing) = drag/move
    s._onMouseDown = (e) => {
      if (e.button !== 0) return;
      const handleEl = e.target.closest('[data-handle]');
      if (handleEl) {
        e.preventDefault();
        e.stopPropagation();
        _beginHandleDrag(handleEl.dataset.handle, e);
        return;
      }
      // If editing and click landed in the edit area, let native caret handling run.
      if (s.mode === 'edit' && s.editEl.contains(e.target)) {
        e.stopPropagation();
        requestAnimationFrame(() => _saveEditorSelection());
        return;
      }
      // Otherwise begin a move drag — and if we're in edit mode, switch to reposition.
      e.preventDefault();
      e.stopPropagation();
      if (s.mode === 'edit') _setMode('reposition');
      _beginMoveDrag(e);
    };
    s.el.addEventListener('mousedown', s._onMouseDown);

    // Double-click → enter edit mode with all text selected
    s._onDblClick = (e) => {
      if (e.target.closest('[data-handle]')) return;
      e.stopPropagation();
      _setMode('edit');
      requestAnimationFrame(() => {
        if (session === s) {
          s.editEl.focus();
          const range = document.createRange();
          range.selectNodeContents(s.editEl);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          _savedRange = range.cloneRange();
        }
      });
    };
    s.el.addEventListener('dblclick', s._onDblClick);
  }

  function _setMode(mode) {
    if (!session) return;
    session.mode = mode;
    _syncBoxDom();
    if (typeof compositeAll === 'function') compositeAll();
    if (mode === 'edit') {
      session.editEl.focus();
      _restoreEditorSelection();
    } else {
      _saveEditorSelection();
      session.editEl.blur();
    }
  }

  // Re-read the contenteditable into the layer's runs[] and re-render.
  function _syncFromEditor() {
    if (!session) return;
    _saveEditorSelection();
    const m = session.layer.textModel;
    const color = m.runs[0]?.color || (typeof fgColor !== 'undefined' ? fgColor : '#ffffff');
    m.runs = _serializeRuns(session.editEl, { font: _activeFont, size: _activeSize, color });
    // Normalize all runs to the same uniform style.
    for (const r of m.runs) {
      r.font = _activeFont; r.size = _activeSize; r.color = color;
      r.bold = _activeBold; r.italic = _activeItalic; r.underline = _activeUnderline;
    }
    if (m.mode === 'point') _autoFitPointText(session.layer);
    renderTextLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _syncBoxDom();
  }

  function endEdit(commit) {
    if (!session) return;
    const s = session;
    const layer = s.layer;
    const wasNew = s.isNew;

    // Tear down DOM
    s.editEl.removeEventListener('input', s._onInput);
    s.editEl.removeEventListener('keyup', s._onRememberSelection);
    s.editEl.removeEventListener('mouseup', s._onRememberSelection);
    s.editEl.removeEventListener('focus', s._onRememberSelection);
    s.el.removeEventListener('mousedown', s._onMouseDown);
    s.el.removeEventListener('dblclick', s._onDblClick);
    if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
    session = null;
    _savedRange = null;
    _refreshTextPanelEnabled();
    if (dragOp) {
      document.removeEventListener('mousemove', _onDragMove);
      document.removeEventListener('mouseup', _onDragUp);
      dragOp = null;
      if (typeof SnapEngine !== 'undefined') SnapEngine.endSession();
    }

    if (commit === false && layer && layer.kind === 'text') {
      if (wasNew) {
        _removeLayer(layer);
      } else {
        layer.name = s.originalName;
        layer.textModel = _cloneTextModel(s.originalModel);
        renderTextLayer(layer);
        if (typeof compositeAll === 'function') compositeAll();
        if (typeof updateLayerPanel === 'function') updateLayerPanel();
      }
      return;
    }

    if (commit !== false && layer && layer.kind === 'text') {
      if (wasNew && !_modelHasText(layer.textModel)) {
        _removeLayer(layer);
        return;
      }
      const changed = !_modelsEqual(s.originalModel, layer.textModel);
      // Refresh the layer name from the current text content.
      const newName = _previewName(layer.textModel);
      if (newName) layer.name = newName;
      // Final render and history.
      renderTextLayer(layer);
      if (typeof compositeAll === 'function') compositeAll();
      // Use a friendlier label than 'Add Text Layer' on edits to existing layers.
      if (wasNew) {
        if (typeof pushUndo === 'function') pushUndo('Add Text Layer');
      } else if (changed && typeof pushUndo === 'function') {
        pushUndo('Edit Text');
      }
      if (typeof updateLayerPanel === 'function') updateLayerPanel();
    }
  }

  function _previewName(model) {
    if (!model || !model.runs || !model.runs.length) return null;
    const txt = model.runs.map(r => r.text).join('').replace(/\n/g, ' ').trim();
    if (!txt) return null;
    return txt.length > 24 ? txt.slice(0, 24) + '…' : txt;
  }

  // ── Drag operations ────────────────────────────────────

  function _beginSnapSession() {
    if (typeof SnapEngine === 'undefined') return;
    const excl = new Set();
    if (session && session.layer && session.layer.id != null) excl.add(session.layer.id);
    SnapEngine.beginSession({ excludeLayerIds: excl, excludeSelection: true });
  }

  function _beginMoveDrag(e) {
    const m = session.layer.textModel;
    dragOp = {
      kind: 'move',
      startMouse: { x: e.clientX, y: e.clientY },
      startBox: { x: m.boxX, y: m.boxY, w: m.boxW, h: m.boxH },
      changed: false
    };
    session.el.classList.add('is-dragging');
    _beginSnapSession();
    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup', _onDragUp);
  }

  function _beginHandleDrag(handle, e) {
    const m = session.layer.textModel;
    dragOp = {
      kind: 'resize',
      handle,
      startMouse: { x: e.clientX, y: e.clientY },
      startBox: { x: m.boxX, y: m.boxY, w: m.boxW, h: m.boxH },
      startRunSizes: m.runs.map(r => _parseCssSize(r.size, _activeSize)),
      changed: false
    };
    session.el.classList.add('is-dragging');
    _beginSnapSession();
    document.addEventListener('mousemove', _onDragMove);
    document.addEventListener('mouseup', _onDragUp);
  }

  function _onDragMove(e) {
    if (!dragOp || !session) return;
    const m = session.layer.textModel;
    const dxScreen = e.clientX - dragOp.startMouse.x;
    const dyScreen = e.clientY - dragOp.startMouse.y;
    const dxCanvas = dxScreen / zoom;
    const dyCanvas = dyScreen / zoom;
    if (Math.abs(dxCanvas) > 0.01 || Math.abs(dyCanvas) > 0.01) dragOp.changed = true;

    if (dragOp.kind === 'move') {
      let nx = dragOp.startBox.x + dxCanvas;
      let ny = dragOp.startBox.y + dyCanvas;
      const w = dragOp.startBox.w, h = dragOp.startBox.h;
      if (typeof SnapEngine !== 'undefined') {
        const cx = [{val: nx}, {val: nx + w / 2}, {val: nx + w}];
        const cy = [{val: ny}, {val: ny + h / 2}, {val: ny + h}];
        const snap = SnapEngine.snapBounds(
          { x: nx, y: ny, w, h },
          { candidatesX: cx, candidatesY: cy, modifiers: e }
        );
        nx += snap.dx; ny += snap.dy;
      }
      m.boxX = nx;
      m.boxY = ny;
    } else if (dragOp.kind === 'resize') {
      const h = dragOp.handle;
      let nx = dragOp.startBox.x, ny = dragOp.startBox.y;
      let nw = dragOp.startBox.w, nh = dragOp.startBox.h;
      if (h === 'e') {
        nw = Math.max(MIN_BOX_W, dragOp.startBox.w + dxCanvas);
        if (typeof SnapEngine !== 'undefined') {
          const snap = SnapEngine.snapBounds(
            { x: nx, y: ny, w: nw, h: nh },
            { candidatesX: [{val: nx + nw}], candidatesY: [], modifiers: e }
          );
          nw = Math.max(MIN_BOX_W, nw + snap.dx);
        }
      } else if (h === 'w') {
        nw = Math.max(MIN_BOX_W, dragOp.startBox.w - dxCanvas);
        nx = dragOp.startBox.x + (dragOp.startBox.w - nw);
        if (typeof SnapEngine !== 'undefined') {
          const snap = SnapEngine.snapBounds(
            { x: nx, y: ny, w: nw, h: nh },
            { candidatesX: [{val: nx}], candidatesY: [], modifiers: e }
          );
          if (snap.dx) {
            const newNx = nx + snap.dx;
            const rightEdge = dragOp.startBox.x + dragOp.startBox.w;
            const newNw = Math.max(MIN_BOX_W, rightEdge - newNx);
            nx = rightEdge - newNw;
            nw = newNw;
          }
        }
      } else if (h === 's') {
        // Bottom handle: scale box and all font sizes proportionally from top-center anchor.
        nh = Math.max(MIN_BOX_H, dragOp.startBox.h + dyCanvas);
        if (typeof SnapEngine !== 'undefined') {
          const probeCenterX = dragOp.startBox.x + dragOp.startBox.w / 2;
          const probeW = Math.max(MIN_BOX_W, dragOp.startBox.w * (nh / dragOp.startBox.h));
          const probeX = probeCenterX - probeW / 2;
          const snap = SnapEngine.snapBounds(
            { x: probeX, y: ny, w: probeW, h: nh },
            { candidatesX: [], candidatesY: [{val: ny + nh}], modifiers: e }
          );
          nh = Math.max(MIN_BOX_H, nh + snap.dy);
        }
        const scale = nh / dragOp.startBox.h;
        nw = Math.max(MIN_BOX_W, dragOp.startBox.w * scale);
        // Keep horizontal center fixed as width changes.
        const startCenterX = dragOp.startBox.x + dragOp.startBox.w / 2;
        nx = startCenterX - nw / 2;
        dragOp.startRunSizes.forEach((sz, i) => {
          if (m.runs[i]) m.runs[i].size = Math.max(1, Math.round(sz * scale));
        });
        _activeSize = m.runs[0]?.size || _activeSize;
        const sizeInp = document.getElementById('txSize');
        if (sizeInp) sizeInp.value = Math.round(_activeSize);
      }
      m.boxX = nx; m.boxY = ny; m.boxW = nw; m.boxH = nh;
      m.widthLocked = true;
    }
    renderTextLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    if (typeof drawOverlay === 'function') drawOverlay();
    _syncBoxDom();
  }

  function _onDragUp() {
    if (!dragOp) return;
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('mouseup', _onDragUp);
    if (session && session.el) session.el.classList.remove('is-dragging');
    const wasResize = dragOp.kind === 'resize';
    const changed = dragOp.changed;
    dragOp = null;
    if (typeof SnapEngine !== 'undefined') SnapEngine.endSession();
    if (typeof drawOverlay === 'function') drawOverlay();
    if (!changed) return;
    if (wasResize) {
      if (typeof pushUndo === 'function') pushUndo('Transform Text');
      if (typeof updateLayerPanel === 'function') updateLayerPanel();
    } else {
      if (typeof pushUndo === 'function') pushUndo('Move Text');
    }
    if (session) {
      session.originalName = session.layer.name;
      session.originalModel = _cloneTextModel(session.layer.textModel);
    }
  }

  // ── Public: beginEdit / addTextLayer / requireRasterize ─

  function beginEdit(layer) {
    if (!layer || layer.kind !== 'text') return;
    _createSession(layer, 'edit', { isNew: false });
  }

  function _createTextLayerAt(canvasX, canvasY, opts) {
    const isParagraph = !!(opts && opts.paragraph);
    const w = isParagraph ? Math.max(80, opts.boxW || 200) : 200;
    const h = isParagraph ? Math.max(40, opts.boxH || 80) : Math.max(_activeSize * 1.4, 32);
    const x = canvasX - (isParagraph ? 0 : 0);
    const y = canvasY - (isParagraph ? 0 : 0);
    const color = (typeof fgColor !== 'undefined') ? fgColor : '#ffffff';
    const model = {
      runs: [{ text: LOREM, font: _activeFont, size: _activeSize, color, bold: false, italic: false, underline: false }],
      boxX: x, boxY: y, boxW: w, boxH: h,
      rotation: 0,
      mode: isParagraph ? 'paragraph' : 'point',
      align: _activeAlign,
      lineSpacing: _activeLineSpacing,
      letterSpacing: _activeLetterSpacing
    };
    const layer = addTextLayer(model, true);
    if (model.mode === 'point') _autoFitPointText(layer);
    renderTextLayer(layer);
    if (typeof compositeAll === 'function') compositeAll();
    _createSession(layer, 'edit', { isNew: true, preLorem: true });
    return layer;
  }

  // ── Rasterize confirmation ─────────────────────────────

  function requireRasterize(layer, toolName) {
    return new Promise((resolve) => {
      if (!layer || layer.kind !== 'text') { resolve(true); return; }
      const overlay = document.getElementById('txRasterizeModal');
      const nameEl = document.getElementById('txRasterizeToolName');
      const okBtn  = document.getElementById('txRasterizeConfirm');
      const noBtn  = document.getElementById('txRasterizeCancel');
      if (!overlay) { resolve(false); return; }
      nameEl.textContent = toolName || 'this';
      overlay.hidden = false;

      function cleanup() {
        overlay.hidden = true;
        okBtn.removeEventListener('click', onOk);
        noBtn.removeEventListener('click', onNo);
        overlay.removeEventListener('mousedown', onBackdrop);
        document.removeEventListener('keydown', onKey);
      }
      function onOk() {
        cleanup();
        // If a text edit session exists for this layer, commit first.
        if (session && session.layer === layer) endEdit(true);
        rasterizeTextLayer(layer);
        if (typeof compositeAll === 'function') compositeAll();
        if (typeof pushUndo === 'function') pushUndo('Rasterize Text');
        if (typeof updateLayerPanel === 'function') updateLayerPanel();
        resolve(true);
      }
      function onNo() { cleanup(); resolve(false); }
      function onBackdrop(e) { if (e.target === overlay) onNo(); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); onNo(); }
        else if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      }
      okBtn.addEventListener('click', onOk);
      noBtn.addEventListener('click', onNo);
      overlay.addEventListener('mousedown', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }

  // ── Tool registration ──────────────────────────────────

  // Hit test: is canvas-space point (x,y) inside any text layer's bounding box?
  // Returns the topmost text layer (and its index) or null. Honors rotation.
  function _hitTextLayer(x, y) {
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (l.kind !== 'text' || !l.textModel || !l.visible) continue;
      const m = l.textModel;
      const cx = m.boxX + m.boxW / 2;
      const cy = m.boxY + m.boxH / 2;
      let lx = x - cx, ly = y - cy;
      if (m.rotation) {
        const c = Math.cos(-m.rotation), s = Math.sin(-m.rotation);
        const rx = lx * c - ly * s;
        const ry = lx * s + ly * c;
        lx = rx; ly = ry;
      }
      if (lx >= -m.boxW/2 && lx <= m.boxW/2 && ly >= -m.boxH/2 && ly <= m.boxH/2) {
        return { layer: l, index: i };
      }
    }
    return null;
  }

  ToolRegistry.register('text', {
    activate() {
      const ids = ['opt-text-font', 'opt-text-size', 'opt-text-fill', 'opt-text-format'];
      ids.forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); });
      workspace.style.cursor = 'text';
      _refreshFontMenu();
      _refreshSizeMenu();
      _refreshFontButton();
      _refreshFillChip();
      _showTextPanelSection(true);
      _refreshTextPanelEnabled();
      if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
    },
    deactivate() {
      if (session) endEdit(true);
      _clearHover();
      _showTextPanelSection(false);
      if (typeof updatePropertiesPanel === 'function') updatePropertiesPanel();
    },
    mouseDown(e, pos) {
      if (e.button !== 0) return false;
      // If an active session already exists, clicking outside it commits.
      // The click that commits should NOT also create a new text box.
      if (session) {
        endEdit(true);
        return true;
      }
      // Click on an existing committed text layer → reposition mode.
      const hit = _hitTextLayer(pos.x, pos.y);
      if (hit) {
        activeLayerIndex = hit.index;
        selectedLayers = new Set([hit.index]);
        if (typeof updateLayerPanel === 'function') updateLayerPanel();
        _createSession(hit.layer, 'reposition', { isNew: false });
        return true;
      }
      // Begin tracking a possible drag — distinguishes click vs drag for new text.
      pendingNewLayerOnNextDown = true;
      _txDownStart = { x: pos.x, y: pos.y, sx: e.clientX, sy: e.clientY };
      _txDragged = false;
      return true;
    },
    mouseMove(e, pos) {
      _updateHover(pos.x, pos.y);
      if (!pendingNewLayerOnNextDown || !_txDownStart) return false;
      const dx = e.clientX - _txDownStart.sx;
      const dy = e.clientY - _txDownStart.sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) _txDragged = true;
      return false;
    },
    mouseUp(e, pos) {
      if (!pendingNewLayerOnNextDown) return false;
      pendingNewLayerOnNextDown = false;
      const start = _txDownStart;
      _txDownStart = null;
      if (!start) return false;
      const endP = screenToCanvas(e.clientX || 0, e.clientY || 0);
      if (_txDragged) {
        const x = Math.min(start.x, endP.x);
        const y = Math.min(start.y, endP.y);
        const w = Math.abs(endP.x - start.x);
        const h = Math.abs(endP.y - start.y);
        _createTextLayerAt(x, y, { paragraph: true, boxW: w, boxH: h });
      } else {
        _createTextLayerAt(start.x, start.y, { paragraph: false });
      }
      _txDragged = false;
      return true;
    }
  });

  let _txDownStart = null;
  let _txDragged = false;

  // ── Options bar wiring ─────────────────────────────────

  // Helpers — text tool mirrors its options-bar controls into the
  // properties panel (id prefix 'ptx*'). _eachId iterates both id sets
  // so a single update keeps the two UIs in lockstep.
  function _eachId(ids, fn) {
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) fn(el);
    }
  }

  function _refreshFontButton() {
    _eachId(['txFontBtn', 'ptxFontBtn'], (btn) => {
      btn.textContent = _activeFont;
      btn.style.fontFamily = `"${_activeFont}", sans-serif`;
    });
  }

  function _refreshFillChip() {
    const color = (typeof fgColor !== 'undefined') ? fgColor : '#ffffff';
    _eachId(['txFillChip', 'ptxFillChip'], (chip) => { chip.style.background = color; });
  }

  function _refreshFontMenu() {
    const customs = (window.CustomFonts ? window.CustomFonts.list() : []) || [];
    const customFamilies = customs.map(c => c.family);

    function populate(menu) {
      if (!menu) return;
      menu.innerHTML = '';
      function addItem(family, opts) {
        const item = document.createElement('div');
        item.className = 'tx-font-item' + (family === _activeFont ? ' is-active' : '');
        item.style.fontFamily = `"${family}", sans-serif`;
        item.textContent = family;
        if (opts && opts.badge) {
          const b = document.createElement('span');
          b.className = 'tx-font-badge';
          b.textContent = opts.badge;
          b.style.fontFamily = 'var(--font)';
          item.appendChild(b);
        }
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          _setActiveFont(family);
          _closeFontMenu();
        });
        menu.appendChild(item);
      }
      for (const fam of customFamilies) addItem(fam, { badge: 'Custom' });
      if (customFamilies.length) {
        const div = document.createElement('div');
        div.className = 'tx-font-divider';
        menu.appendChild(div);
      }
      for (const fam of DEFAULT_FONTS) addItem(fam);
      const div2 = document.createElement('div');
      div2.className = 'tx-font-divider';
      menu.appendChild(div2);
      const add = document.createElement('div');
      add.className = 'tx-font-add';
      add.textContent = 'Add custom font from PC…';
      add.addEventListener('mousedown', (e) => {
        e.preventDefault();
        document.getElementById('txFontFile').click();
      });
      menu.appendChild(add);
    }

    populate(document.getElementById('txFontMenu'));
    populate(document.getElementById('ptxFontMenu'));
  }

  function _refreshSizeMenu() {
    function populate(menu) {
      if (!menu) return;
      menu.innerHTML = '';
      for (const s of SIZE_PRESETS) {
        const item = document.createElement('div');
        item.className = 'tx-size-item';
        item.textContent = s;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          _setActiveSize(s);
          _closeSizeMenu();
        });
        menu.appendChild(item);
      }
    }
    populate(document.getElementById('txSizeMenu'));
    populate(document.getElementById('ptxSizeMenu'));
  }

  function _setActiveFont(family) {
    _activeFont = family;
    _refreshFontButton();
    if (session) {
      for (const r of session.layer.textModel.runs) r.font = family;
      if (session.layer.textModel.mode === 'point') _autoFitPointText(session.layer);
      renderTextLayer(session.layer);
      if (typeof compositeAll === 'function') compositeAll();
      _syncBoxDom();
      if (typeof pushUndo === 'function') pushUndo('Change Font');
      _bumpBaseline();
    }
  }

  function _setActiveSize(size) {
    _activeSize = Math.max(1, _parseCssSize(size, _activeSize));
    const v = String(Math.round(_activeSize));
    _eachId(['txSize', 'ptxSize'], (el) => {
      if (document.activeElement !== el) el.value = v;
    });
    if (session) {
      for (const r of session.layer.textModel.runs) r.size = _activeSize;
      if (session.layer.textModel.mode === 'point') _autoFitPointText(session.layer);
      renderTextLayer(session.layer);
      if (typeof compositeAll === 'function') compositeAll();
      _syncBoxDom();
    }
  }

  function _setActiveColor(hex) {
    if (session) {
      for (const r of session.layer.textModel.runs) r.color = hex;
      renderTextLayer(session.layer);
      if (typeof compositeAll === 'function') compositeAll();
      _syncBoxDom();
    }
    _refreshFillChip();
  }

  function _toggleStyle(name) {
    if (!session) return;
    const m = session.layer.textModel;
    if (name === 'bold') {
      _activeBold = !_activeBold;
      for (const r of m.runs) r.bold = _activeBold;
    } else if (name === 'italic') {
      _activeItalic = !_activeItalic;
      for (const r of m.runs) r.italic = _activeItalic;
    } else if (name === 'underline') {
      _activeUnderline = !_activeUnderline;
      for (const r of m.runs) r.underline = _activeUnderline;
    }
    _refreshStyleButtons();
    renderTextLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _syncBoxDom();
  }

  function _refreshStyleButtons() {
    document.querySelectorAll('#txStyleGroup [data-style="bold"], #ptxStyleGroup [data-style="bold"]').forEach(b => b.classList.toggle('active', _activeBold));
    document.querySelectorAll('#txStyleGroup [data-style="italic"], #ptxStyleGroup [data-style="italic"]').forEach(b => b.classList.toggle('active', _activeItalic));
    document.querySelectorAll('#txStyleGroup [data-style="underline"], #ptxStyleGroup [data-style="underline"]').forEach(b => b.classList.toggle('active', _activeUnderline));
  }

  function _refreshAlignButtons() {
    document.querySelectorAll('#txAlignGroup .opt-icon-btn, #ptxAlignGroup .opt-icon-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.align === _activeAlign);
    });
  }

  function _openFontMenu()  {
    _eachId(['txFontDrop', 'ptxFontDrop'], (el) => el.classList.add('is-open'));
    _refreshFontMenu();
  }
  function _closeFontMenu() { _eachId(['txFontDrop', 'ptxFontDrop'], (el) => el.classList.remove('is-open')); }
  function _openSizeMenu()  { _eachId(['txSizeBox', 'ptxSizeBox'],   (el) => el.classList.add('is-open')); }
  function _closeSizeMenu() { _eachId(['txSizeBox', 'ptxSizeBox'],   (el) => el.classList.remove('is-open')); }

  // ── Hover outline (idle text layers) ───────────────────

  function _initHoverEl() {
    _hoverEl = document.createElement('div');
    _hoverEl.className = 'tx-hover';
    _hoverEl.style.display = 'none';
    const wrap = _overlayRoot();
    if (wrap) wrap.appendChild(_hoverEl);
  }

  function _syncHoverDom(layer) {
    if (!_hoverEl) return;
    if (!layer || !layer.textModel) {
      _hoverEl.style.display = 'none';
      return;
    }
    const m = layer.textModel;
    const rect = _modelBoxToScreenRect(m);
    _hoverEl.style.left = rect.x + 'px';
    _hoverEl.style.top = rect.y + 'px';
    _hoverEl.style.width = rect.w + 'px';
    _hoverEl.style.height = rect.h + 'px';
    _hoverEl.style.transformOrigin = '50% 50%';
    _hoverEl.style.transform = `rotate(${m.rotation || 0}rad)`;
    _hoverEl.style.display = 'block';
  }

  function _updateHover(canvasX, canvasY) {
    if (session) { _clearHover(); return; }
    const hit = _hitTextLayer(canvasX, canvasY);
    const layer = hit ? hit.layer : null;
    _hoverLayer = layer;
    _syncHoverDom(layer);
  }

  function _clearHover() {
    _hoverLayer = null;
    if (_hoverEl) _hoverEl.style.display = 'none';
  }

  // ── Properties-panel section visibility ────────────────
  // Mirror of ShapeTool's _setShapePanelMode: when the text section
  // unhides we lock the panel-body's pre-text height into a CSS var
  // so the panel keeps its outer footprint and scrolls instead of
  // growing.
  function _setTextPanelMode(panel, on) {
    const wasOn = panel.classList.contains('is-text-mode');
    if (on && !wasOn) {
      const body = panel.querySelector('.panel-body');
      if (body) {
        const h = body.offsetHeight;
        if (h > 0) panel.style.setProperty('--props-panel-body-h', h + 'px');
      }
      panel.classList.add('is-text-mode');
    } else if (!on && wasOn) {
      panel.classList.remove('is-text-mode');
      panel.style.removeProperty('--props-panel-body-h');
    }
  }

  function _showTextPanelSection(visible) {
    const panel = document.getElementById('propertiesPanel');
    const section = document.getElementById('propsTextSection');
    if (!panel || !section) return;
    _setTextPanelMode(panel, visible);
    section.hidden = !visible;
  }

  // Toggle disabled state on every interactive control inside the
  // panel section based on whether a text editing session is active.
  function _refreshTextPanelEnabled() {
    const section = document.getElementById('propsTextSection');
    if (!section) return;
    const has = !!session;
    section.classList.toggle('is-empty', !has);
    section.querySelectorAll('input, button').forEach(el => {
      if (has) el.removeAttribute('disabled');
      else el.setAttribute('disabled', '');
    });
  }

  // ── DOM ready wiring ───────────────────────────────────

  function _wireOptionsBar() {
    _initHoverEl();
    const fontBtn = document.getElementById('txFontBtn');
    const fontFile = document.getElementById('txFontFile');
    const sizeInp = document.getElementById('txSize');
    const sizeTog = document.getElementById('txSizeToggle');
    const sizeBox = document.getElementById('txSizeBox');
    const fillBtn = document.getElementById('txFillBtn');
    const formatBtn = document.getElementById('txFormatBtn');
    const popover = document.getElementById('txFormatPopover');

    function rememberSelectionBeforeControl(el, preventDefault) {
      if (!el) return;
      el.addEventListener('mousedown', (e) => {
        if (!session) return;
        _saveEditorSelection();
        if (preventDefault) e.preventDefault();
      });
    }

    rememberSelectionBeforeControl(fontBtn, true);
    rememberSelectionBeforeControl(sizeInp, false);
    rememberSelectionBeforeControl(sizeTog, true);
    rememberSelectionBeforeControl(fillBtn, true);
    rememberSelectionBeforeControl(formatBtn, true);

    if (fontBtn) {
      fontBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const drop = document.getElementById('txFontDrop');
        if (drop.classList.contains('is-open')) _closeFontMenu();
        else _openFontMenu();
      });
    }
    if (fontFile) {
      fontFile.addEventListener('change', async function() {
        const f = this.files && this.files[0];
        if (!f || !window.CustomFonts) { this.value = ''; return; }
        try {
          const { family } = await window.CustomFonts.add(f);
          _setActiveFont(family);
          _refreshFontMenu();
        } catch (err) {
          console.warn('[TextTool] Failed to add custom font:', err);
        }
        this.value = '';
      });
    }
    if (sizeInp) {
      sizeInp.addEventListener('change', () => {
        const v = parseFloat(sizeInp.value);
        if (!isNaN(v) && v > 0) _setActiveSize(Math.round(v));
      });
      sizeInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); sizeInp.blur(); }
      });
    }
    if (sizeTog) {
      sizeTog.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (sizeBox.classList.contains('is-open')) _closeSizeMenu();
        else _openSizeMenu();
      });
    }
    if (fillBtn) {
      fillBtn.addEventListener('click', () => {
        // Reuse the existing color picker iframe; on confirm fgColor is updated
        // and we apply it to the active text selection.
        if (typeof toggleColorPicker === 'function') {
          window._txAwaitingFill = true;
          toggleColorPicker();
        }
      });
    }
    if (formatBtn) {
      formatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popover.classList.contains('is-open')) {
          popover.classList.remove('is-open');
          popover.hidden = true;
          return;
        }
        const r = formatBtn.getBoundingClientRect();
        popover.style.top = (r.bottom + 6) + 'px';
        popover.style.left = Math.max(8, r.right - 280) + 'px';
        popover.hidden = false;
        popover.classList.add('is-open');
      });
    }

    // Format popover wiring — both the options-bar pair and the
    // properties-panel mirror feed the same _activeLineSpacing /
    // _activeLetterSpacing state. Each apply() pushes the new value
    // to BOTH pairs so the two UIs stay in lockstep.
    const lineR  = document.getElementById('txLineSpacing');
    const lineN  = document.getElementById('txLineSpacingNum');
    const letR   = document.getElementById('txLetterSpacing');
    const letN   = document.getElementById('txLetterSpacingNum');
    const plineR = document.getElementById('ptxLineSpacing');
    const plineN = document.getElementById('ptxLineSpacingNum');
    const pletR  = document.getElementById('ptxLetterSpacing');
    const pletN  = document.getElementById('ptxLetterSpacingNum');
    function _wireSyncGroup(refRange, pairs, fmt, onChange) {
      if (!refRange) return;
      function apply(raw, sourceEl) {
        let v = parseFloat(raw);
        if (!Number.isFinite(v)) return;
        const min = parseFloat(refRange.min);
        const max = parseFloat(refRange.max);
        if (Number.isFinite(min)) v = Math.max(min, v);
        if (Number.isFinite(max)) v = Math.min(max, v);
        const text = fmt(v);
        for (const [r, n] of pairs) {
          if (r && r !== sourceEl && document.activeElement !== r) r.value = v;
          if (n && n !== sourceEl && document.activeElement !== n) n.value = text;
        }
        onChange(v);
      }
      for (const [r, n] of pairs) {
        if (r) r.addEventListener('input', () => apply(r.value, r));
        if (n) n.addEventListener('input', () => apply(n.value, n));
      }
    }
    _wireSyncGroup(lineR, [[lineR, lineN], [plineR, plineN]], (v) => Number(v).toFixed(2), (v) => {
      _activeLineSpacing = v;
      if (session) { session.layer.textModel.lineSpacing = v; _syncFromEditor(); }
    });
    _wireSyncGroup(letR, [[letR, letN], [pletR, pletN]], (v) => Math.round(Number(v)), (v) => {
      _activeLetterSpacing = v;
      if (session) { session.layer.textModel.letterSpacing = v; _syncFromEditor(); }
    });

    document.querySelectorAll('#txAlignGroup, #ptxAlignGroup').forEach(group => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-align]');
        if (!btn) return;
        _activeAlign = btn.dataset.align;
        _refreshAlignButtons();
        if (session) { session.layer.textModel.align = _activeAlign; _syncFromEditor(); }
      });
    });
    document.querySelectorAll('#txStyleGroup, #ptxStyleGroup').forEach(group => {
      group.addEventListener('mousedown', (e) => {
        const btn = e.target.closest('[data-style]');
        if (!btn) return;
        e.preventDefault();
        _toggleStyle(btn.dataset.style);
      });
    });

    // ── Properties-panel mirror wiring ───────────────────────
    const pFontBtn = document.getElementById('ptxFontBtn');
    const pSizeInp = document.getElementById('ptxSize');
    const pSizeTog = document.getElementById('ptxSizeToggle');
    const pSizeBox = document.getElementById('ptxSizeBox');
    const pFillBtn = document.getElementById('ptxFillBtn');

    rememberSelectionBeforeControl(pFontBtn, true);
    rememberSelectionBeforeControl(pSizeInp, false);
    rememberSelectionBeforeControl(pSizeTog, true);
    rememberSelectionBeforeControl(pFillBtn, true);

    if (pFontBtn) {
      pFontBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const drop = document.getElementById('ptxFontDrop');
        if (drop.classList.contains('is-open')) _closeFontMenu();
        else _openFontMenu();
      });
    }
    if (pSizeInp) {
      pSizeInp.addEventListener('change', () => {
        const v = parseFloat(pSizeInp.value);
        if (!isNaN(v) && v > 0) _setActiveSize(Math.round(v));
      });
      pSizeInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); pSizeInp.blur(); }
      });
    }
    if (pSizeTog) {
      pSizeTog.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pSizeBox.classList.contains('is-open')) _closeSizeMenu();
        else _openSizeMenu();
      });
    }
    if (pFillBtn) {
      pFillBtn.addEventListener('click', () => {
        if (typeof toggleColorPicker === 'function') {
          window._txAwaitingFill = true;
          toggleColorPicker();
        }
      });
    }

    // Click-outside to close popover/dropdowns
    document.addEventListener('mousedown', (e) => {
      _eachId(['txFontDrop', 'ptxFontDrop'], (drop) => {
        if (drop.classList.contains('is-open') && !drop.contains(e.target)) drop.classList.remove('is-open');
      });
      _eachId(['txSizeBox', 'ptxSizeBox'], (sb) => {
        if (sb.classList.contains('is-open') && !sb.contains(e.target)) sb.classList.remove('is-open');
      });
      if (popover && popover.classList.contains('is-open') && !popover.contains(e.target) && e.target !== formatBtn && !formatBtn.contains(e.target)) {
        popover.classList.remove('is-open');
        popover.hidden = true;
      }
    });

    // Subscribe to font list changes (e.g. from another tab).
    if (window.CustomFonts && window.CustomFonts.onChange) {
      window.CustomFonts.onChange(() => _refreshFontMenu());
    }
  }

  // Listen for color-picker confirmation when in fill-color mode.
  window.addEventListener('message', (e) => {
    if (!e.data || e.data.action !== 'confirm') return;
    if (!window._txAwaitingFill) return;
    window._txAwaitingFill = false;
    const hex = e.data.hex;
    if (hex) _setActiveColor(hex);
  });

  // Bold/Italic/Underline/Escape keyboard shortcuts — only while editing.
  document.addEventListener('keydown', (e) => {
    if (!session || session.mode !== 'edit') return;
    if (e.key === 'Escape') { e.preventDefault(); endEdit(true); return; }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); _toggleStyle('bold'); }
    else if (k === 'i') { e.preventDefault(); _toggleStyle('italic'); }
    else if (k === 'u') { e.preventDefault(); _toggleStyle('underline'); }
  });

  // Init wiring once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireOptionsBar);
  } else {
    _wireOptionsBar();
  }

  function beginEditAtPoint(canvasX, canvasY) {
    const hit = _hitTextLayer(canvasX, canvasY);
    if (!hit) return false;
    activeLayerIndex = hit.index;
    selectedLayers = new Set([hit.index]);
    if (typeof updateLayerPanel === 'function') updateLayerPanel();
    _createSession(hit.layer, 'edit', { isNew: false });
    return true;
  }

  // Select a text layer by hit-test → reposition session. Used by move tool.
  function hitTestAndSelect(x, y) {
    const hit = _hitTextLayer(x, y);
    if (!hit) return false;
    if (session && session.layer === hit.layer) return false;
    if (session) endEdit(true);
    activeLayerIndex = hit.index;
    selectedLayers = new Set([hit.index]);
    if (typeof updateLayerPanel === 'function') updateLayerPanel();
    _createSession(hit.layer, 'reposition', { isNew: false });
    return true;
  }

  function _setPosition(x, y) {
    if (!session) return;
    const m = session.layer.textModel;
    m.boxX = x; m.boxY = y;
    renderTextLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _syncBoxDom();
  }

  function _setBoxWidth(w) {
    if (!session) return;
    const m = session.layer.textModel;
    m.boxW = Math.max(MIN_BOX_W, w);
    m.widthLocked = true;
    renderTextLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _syncBoxDom();
  }

  function _setBoxHeight(h) {
    if (!session) return;
    const m = session.layer.textModel;
    if (m.boxH <= 0) return;
    const nh = Math.max(MIN_BOX_H, h);
    const scale = nh / m.boxH;
    const startCenterX = m.boxX + m.boxW / 2;
    const startRunSizes = m.runs.map(r => _parseCssSize(r.size, _activeSize));
    m.boxW = Math.max(MIN_BOX_W, m.boxW * scale);
    m.boxX = startCenterX - m.boxW / 2;
    m.boxH = nh;
    m.widthLocked = true;
    startRunSizes.forEach((sz, i) => {
      if (m.runs[i]) m.runs[i].size = Math.max(1, Math.round(sz * scale));
    });
    _activeSize = m.runs[0]?.size || _activeSize;
    const sizeInp = document.getElementById('txSize');
    if (sizeInp) sizeInp.value = Math.round(_activeSize);
    renderTextLayer(session.layer);
    if (typeof compositeAll === 'function') compositeAll();
    _syncBoxDom();
  }

  function _onZoomChange() {
    if (session && session.el) {
      _syncBoxDom();
    }
    if (_hoverLayer) {
      _syncHoverDom(_hoverLayer);
    }
  }

  // Reset the session's "original" baseline to the current layer state so a
  // subsequent endEdit(true) won't re-push an 'Edit Text' entry for changes
  // that have already been recorded externally (e.g. drag-end, properties-
  // panel commits). Mirrors the post-drag reset in _onDragUp.
  function _bumpBaseline() {
    if (!session) return;
    session.originalName = session.layer.name;
    session.originalModel = _cloneTextModel(session.layer.textModel);
  }

  return {
    beginEdit,
    beginEditAtPoint,
    endEdit,
    hitTestAndSelect,
    isActive: () => !!session,
    isLayerPreviewSuppressed: (layer) => !!(session && session.layer === layer && session.mode === 'edit'),
    getActiveModel: () => (session && session.layer && session.layer.textModel) || null,
    updateHover: _updateHover,
    clearHover: _clearHover,
    onZoomChange: _onZoomChange,
    setPosition: _setPosition,
    setBoxWidth: _setBoxWidth,
    setBoxHeight: _setBoxHeight,
    bumpBaseline: _bumpBaseline,
    requireRasterize,
    renderTextLayer,
    refreshPropertiesPanel: _refreshTextPanelEnabled,
    DEFAULT_FONTS
  };
})();

// Bridge so callers (history restore, layers.js) can re-render text layers
// without depending on window.TextTool being initialized first.
function renderTextLayer(layer) {
  if (window.TextTool && window.TextTool.renderTextLayer) {
    return window.TextTool.renderTextLayer(layer);
  }
}
