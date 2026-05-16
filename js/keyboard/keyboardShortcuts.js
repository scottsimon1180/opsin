"use strict";

/* ═══════════════════════════════════════════════════════════════════════
   OPSIN KEYBOARD SHORTCUTS — registry, remapping, dispatcher & editor UI

   This module replaces the former js/core/keyboardShortcuts.js dispatcher.
   It owns the entire keyboard-customization feature:

     • COMMANDS         — every remappable command (tools + global actions),
                          each carrying the exact behavior the old inline
                          dispatcher invoked.
     • keymap           — defaults overlaid with user overrides persisted in
                          localStorage ('opsin.shortcuts.custom').
     • dispatcher       — one keydown listener. The view-only context
                          handlers (arrow-nudge, magnetic lasso, Escape
                          chain, Enter-commit, Delete-selection, Space-pan,
                          native paste) are preserved verbatim and are NOT
                          remappable. Every other command is resolved
                          through the (possibly customized) keymap.
     • editor UI        — Premiere-style interactive keyboard + searchable
                          editable command list, rendered into the Settings
                          ▸ Keyboard panel. Conflict = Premiere-style warn &
                          reassign. Reset / Import / Export (.opn).

   Loaded after all tool scripts (same position as the old file) so every
   global a command calls is defined before the first keydown fires.

   Public API (window.OpsinKeyboard):
     initEditor()          Lazy-build the editor UI into the Keyboard panel.
     refresh()             Re-render keyboard + list from current state.
     snapshotOverrides()   JSON string of current overrides (modal baseline).
     restoreOverrides(s)   Restore overrides from a snapshot (Cancel/Esc).
     persist()             Write overrides to localStorage (OK).
   ═══════════════════════════════════════════════════════════════════════ */

window.OpsinKeyboard = (function () {

  const STORAGE_KEY = 'opsin.shortcuts.custom';
  const FILE_FORMAT = 'opsin-shortcuts';
  const FILE_VERSION = 1;
  const EXPORT_NAME = 'opsinCustomShortcuts.opn';

  /* ─── Command registry ──────────────────────────────────────────────
     Each command: { id, label, category, defaultCombos:[combo],
                     pd:boolean (preventDefault — matches old behavior),
                     locked?:true, run(e) }
     `run` holds the EXACT behavior the old dispatcher executed inline. */

  function _selTool(name) { return function () { selectTool(name); }; }

  function _brushStep(dir) {
    const cur = getDrawSize();
    const step = cur > 100 ? 20 : cur > 20 ? 5 : cur > 5 ? 2 : 1;
    let s;
    if (dir < 0) {
      s = Math.max(1, cur - step);
    } else {
      const max = currentTool === 'pencil' ? 100 : 5000;
      s = Math.min(max, cur + step);
    }
    if (currentTool === 'pencil') {
      document.getElementById('pencilSize').value = s;
      document.getElementById('pencilSizeNum').value = s;
    } else {
      document.getElementById('drawSize').value = s;
      document.getElementById('drawSizeNum').value = s;
    }
  }

  const COMMANDS = [
    // ── Tools ──
    { id: 'tool.move',         label: 'Move',              category: 'Tools', defaultCombos: ['v'], pd: false, run: _selTool('move') },
    { id: 'tool.movesel',      label: 'Move Selection',    category: 'Tools', defaultCombos: ['q'], pd: false, run: _selTool('movesel') },
    { id: 'tool.pan',          label: 'Pan / Hand',        category: 'Tools', defaultCombos: ['h'], pd: false, run: _selTool('pan') },
    { id: 'tool.select',       label: 'Select',            category: 'Tools', defaultCombos: ['m'], pd: false, run: _selTool('select') },
    { id: 'tool.lasso',        label: 'Lasso',             category: 'Tools', defaultCombos: ['l'], pd: false, run: _selTool('lasso') },
    { id: 'tool.wand',         label: 'Magic Wand',        category: 'Tools', defaultCombos: ['w'], pd: false, run: _selTool('wand') },
    { id: 'tool.ruler',        label: 'Ruler',             category: 'Tools', defaultCombos: ['r'], pd: false, run: _selTool('ruler') },
    { id: 'tool.brush',        label: 'Brush',             category: 'Tools', defaultCombos: ['b'], pd: false, run: _selTool('brush') },
    { id: 'tool.pencil',       label: 'Pencil',            category: 'Tools', defaultCombos: ['p'], pd: false, run: _selTool('pencil') },
    { id: 'tool.eraser',       label: 'Eraser',            category: 'Tools', defaultCombos: ['e'], pd: false, run: _selTool('eraser') },
    { id: 'tool.fill',         label: 'Fill',              category: 'Tools', defaultCombos: ['g'], pd: false, run: _selTool('fill') },
    { id: 'tool.gradient',     label: 'Gradient',          category: 'Tools', defaultCombos: ['d'], pd: false, run: _selTool('gradient') },
    { id: 'tool.text',         label: 'Text',              category: 'Tools', defaultCombos: ['t'], pd: false, run: _selTool('text') },
    { id: 'tool.shape',        label: 'Shape',             category: 'Tools', defaultCombos: ['u'], pd: false, run: _selTool('shape') },
    { id: 'tool.zoom',         label: 'Zoom',              category: 'Tools', defaultCombos: ['z'], pd: false, run: _selTool('zoom') },
    { id: 'tool.directselect', label: 'Direct Selection',  category: 'Tools', defaultCombos: ['a'], pd: false, run: _selTool('directselect') },

    // ── File ──
    { id: 'file.new',    label: 'New Image',  category: 'File', defaultCombos: ['ctrl+n'], pd: true,  run: function () { newImage(); } },
    { id: 'file.open',   label: 'Open Image', category: 'File', defaultCombos: ['ctrl+o'], pd: true,  run: function () { openImage(); } },
    { id: 'file.reload', label: 'Reload App', category: 'File', defaultCombos: ['ctrl+r'], pd: false, run: function () { location.reload(); } },

    // ── Edit ──
    { id: 'edit.undo',            label: 'Undo',             category: 'Edit', defaultCombos: ['ctrl+z'],              pd: true, run: function () { if (window.IEM && window.IEM.active) window.IEM.dispatchUndo(); else doUndo(); } },
    { id: 'edit.redo',            label: 'Redo',             category: 'Edit', defaultCombos: ['ctrl+y', 'ctrl+shift+z'], pd: true, run: function () { if (window.IEM && window.IEM.active) window.IEM.dispatchRedo(); else doRedo(); } },
    { id: 'edit.copy',            label: 'Copy',             category: 'Edit', defaultCombos: ['ctrl+c'], pd: true, run: function () { doCopy(); } },
    { id: 'edit.cut',             label: 'Cut',              category: 'Edit', defaultCombos: ['ctrl+x'], pd: true, run: function () { doCut(); } },
    { id: 'edit.paste',           label: 'Paste',            category: 'Edit', defaultCombos: ['ctrl+v'], pd: false, locked: true, run: function () {} },
    { id: 'edit.selectAll',       label: 'Select All',       category: 'Edit', defaultCombos: ['ctrl+a'], pd: true, run: function () { selectAll(); } },
    { id: 'edit.deselect',        label: 'Deselect',         category: 'Edit', defaultCombos: ['ctrl+d'], pd: true, run: function () {
        if (gradActive) commitGradient();
        if (pxTransformActive || (currentTool === 'move' && floatingActive)) deselectMove();
        else clearSelection();
      } },
    { id: 'edit.invertColors',    label: 'Invert Colors',    category: 'Edit', defaultCombos: ['ctrl+i'],       pd: true, run: function () { applyFilterDirect('invert'); } },
    { id: 'edit.invertSelection', label: 'Invert Selection', category: 'Edit', defaultCombos: ['ctrl+shift+i'], pd: true, run: function () { invertSelection(); } },
    { id: 'edit.mergeLayers',     label: 'Merge Layers',     category: 'Edit', defaultCombos: ['ctrl+e'],       pd: true, run: function () { mergeLayers(); } },

    // ── View ──
    { id: 'view.zoomIn',  label: 'Zoom In',        category: 'View', defaultCombos: ['ctrl+='],       pd: true, run: function () { zoomIn(); } },
    { id: 'view.zoomOut', label: 'Zoom Out',       category: 'View', defaultCombos: ['ctrl+-'],       pd: true, run: function () { zoomOut(); } },
    { id: 'view.fit',     label: 'Fit to Window',  category: 'View', defaultCombos: ['ctrl+0'],       pd: true, run: function () { zoomFit(); } },
    { id: 'view.actual',  label: 'Zoom to 100%',   category: 'View', defaultCombos: ['ctrl+1'],       pd: true, run: function () { zoom100(); } },
    { id: 'view.guides',  label: 'Toggle Guides',  category: 'View', defaultCombos: ['ctrl+;'],       pd: true, run: function () { toggleGuides(); } },
    { id: 'view.snap',    label: 'Toggle Snap',    category: 'View', defaultCombos: ['ctrl+shift+;'], pd: true, run: function () { SnapEngine.toggle(); } },

    // ── Color ──
    { id: 'color.swap',       label: 'Swap FG / BG Colors',     category: 'Color', defaultCombos: ['x'], pd: false, run: function () { swapColors(); } },
    { id: 'color.eyedropper', label: 'Toggle Panel Eyedropper', category: 'Color', defaultCombos: ['i'], pd: true,  run: function () { togglePanelEyedropper(); } },

    // ── Brush ──
    { id: 'brush.decrease', label: 'Decrease Brush Size', category: 'Brush', defaultCombos: ['['], pd: true, run: function () { _brushStep(-1); } },
    { id: 'brush.increase', label: 'Increase Brush Size', category: 'Brush', defaultCombos: [']'], pd: true, run: function () { _brushStep(1); } }
  ];

  const CATEGORY_ORDER = ['Tools', 'File', 'Edit', 'View', 'Color', 'Brush'];

  const _cmdById = {};
  COMMANDS.forEach(function (c) { _cmdById[c.id] = c; });

  /* ─── Read-only context-modifier reference (NOT remappable) ──────────
     Mirrors KEYBOARD.md's contextual tables so users can still SEE every
     shortcut. Purely informational. */

  const REFERENCE = [
    { group: 'Global (context keys)', rows: [
      ['Esc', 'Cancel eyedropper / color picker / ruler / active transform; commit floating selection & gradient; close panels.'],
      ['Enter', 'Commit an active Pixel Transform.'],
      ['Delete / Backspace', 'Delete the active raster selection when one exists.'],
      ['Arrow Keys', 'Nudge active transform / floating selection / Move Selection by 1 px.'],
      ['Shift + Arrows', 'Nudge by 10 px.'],
      ['Space (hold)', 'Temporary pan / hand mode.']
    ]},
    { group: 'Selection & Lasso', rows: [
      ['Shift + drag', 'Constrain marquee to a square / circle.'],
      ['Alt + drag', 'Draw marquee from center.'],
      ['Shift (polygon lasso)', 'Constrain next segment to 45°.'],
      ['Alt (magnetic lasso)', 'Freehand magnetic segment while active.'],
      ['Esc / Backspace / Enter', 'Cancel / remove last anchor / finish magnetic lasso.']
    ]},
    { group: 'Move, Transform & Guides', rows: [
      ['Shift + handle', 'Preserve aspect ratio while resizing.'],
      ['Alt + handle', 'Resize from center.'],
      ['Alt + drag', 'Duplicate on drag end (when eligible).'],
      ['Ctrl + drag', 'Temporarily invert snap while rotating / dragging guides.']
    ]},
    { group: 'Pan, Zoom, Ruler & Eyedropper', rows: [
      ['Space + drag / Middle drag', 'Pan the workspace.'],
      ['Mouse wheel', 'Zoom in / out at cursor.'],
      ['Zoom tool + Shift', 'Zoom out (click).'],
      ['Shift (ruler)', 'Constrain ruler to 45°.'],
      ['Alt + click (eyedropper)', 'Sample into background color.']
    ]},
    { group: 'Shape & Pen', rows: [
      ['Shift + drag', 'Constrain to square / circle / 45° line.'],
      ['Alt + drag', 'Draw from center.'],
      ['Shift (rotate)', 'Snap rotation to 15° increments.'],
      ['Ctrl (pen)', 'Temporarily direct-select an anchor / handle.'],
      ['Alt (pen)', 'Break symmetric handle (corner).']
    ]},
    { group: 'Text', rows: [
      ['Esc', 'End / commit the current text edit session.'],
      ['Ctrl + B / I / U', 'Toggle bold / italic / underline (while editing text).']
    ]},
    { group: 'Layers & Icon Edit Mode', rows: [
      ['Shift + click', 'Select a contiguous range of layers / sizes.'],
      ['Ctrl + click', 'Toggle a layer / size in the selection.']
    ]},
    { group: 'Dialogs & Number Inputs', rows: [
      ['Esc', 'Cancel the open dialog / panel / popup.'],
      ['Enter', 'Commit a math-enabled number input.'],
      ['Mouse wheel on field', 'Adjust value by 1 (Shift = 10).']
    ]}
  ];

  /* ─── Combo normalization ───────────────────────────────────────────
     Canonical combo string: modifiers in fixed order then the base key,
     joined with '+'. e.g. 'ctrl+shift+i', 'ctrl+=', 'v', '['.
     'ctrl' means Ctrl OR Cmd (matches the legacy ctrlKey||metaKey check). */

  const _CODE_MAP = {
    Minus: '-', Equal: '=', Semicolon: ';', BracketLeft: '[', BracketRight: ']',
    Comma: ',', Period: '.', Slash: '/', Quote: "'", Backslash: '\\', Backquote: '`',
    Space: ' '
  };

  // Derive a shift-stable base key so capture and dispatch always agree
  // (Shift+1 → '1', not '!'; Shift+a → 'a', not 'A').
  function _normKey(e) {
    const code = e.code || '';
    if (code.indexOf('Key') === 0) return code.slice(3).toLowerCase();
    if (code.indexOf('Digit') === 0) return code.slice(5);
    if (code.indexOf('Numpad') === 0) {
      const n = code.slice(6);
      if (/^[0-9]$/.test(n)) return n;
    }
    if (_CODE_MAP[code] !== undefined) return _CODE_MAP[code];
    if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
    return (e.key || '').toLowerCase();
  }

  function _comboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    parts.push(_normKey(e));
    return parts.join('+');
  }

  const _RESERVED_KEYS = {
    escape: 1, enter: 1, tab: 1, ' ': 1, backspace: 1, delete: 1,
    arrowup: 1, arrowdown: 1, arrowleft: 1, arrowright: 1,
    control: 1, shift: 1, alt: 1, meta: 1, capslock: 1, contextmenu: 1
  };

  // A capture is valid only if it carries a real (non-modifier, non-reserved)
  // base key. Bare modifiers or reserved context keys are rejected.
  function _captureCombo(e) {
    const key = _normKey(e);
    if (_RESERVED_KEYS[key]) return null;
    if (!key || key.length === 0) return null;
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('ctrl');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    parts.push(key);
    return parts.join('+');
  }

  function _prettyKey(k) {
    if (k === ' ') return 'Space';
    if (/^f([1-9]|1[0-2])$/.test(k)) return k.toUpperCase();
    if (k.length === 1) return k.toUpperCase();
    return k.charAt(0).toUpperCase() + k.slice(1);
  }

  function prettyCombo(combo) {
    if (!combo) return '';
    const segs = combo.split('+');
    const key = segs.pop();
    const out = [];
    if (segs.indexOf('ctrl') !== -1) out.push('Ctrl');
    if (segs.indexOf('alt') !== -1) out.push('Alt');
    if (segs.indexOf('shift') !== -1) out.push('Shift');
    out.push(_prettyKey(key));
    return out.join('+');
  }

  /* ─── Keymap (defaults + overrides) ─────────────────────────────────
     _overrides: { commandId: [combo,...] } — present only for commands
     the user changed (including cleared → []). Everything else falls
     back to defaults, so future default changes still propagate. */

  const DEFAULTS = {};
  COMMANDS.forEach(function (c) { DEFAULTS[c.id] = c.defaultCombos.slice(); });

  let _overrides = {};
  let _active = {};      // commandId -> [combo]
  let _byCombo = {};     // combo -> commandId

  function _clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function _recompute() {
    _active = {};
    COMMANDS.forEach(function (c) {
      _active[c.id] = Object.prototype.hasOwnProperty.call(_overrides, c.id)
        ? _overrides[c.id].slice()
        : DEFAULTS[c.id].slice();
    });
    _byCombo = {};
    COMMANDS.forEach(function (c) {
      _active[c.id].forEach(function (combo) { _byCombo[combo] = c.id; });
    });
  }

  function _setOverride(id, combos) {
    const def = DEFAULTS[id];
    const same = def.length === combos.length && def.every(function (v, i) { return v === combos[i]; });
    if (same) delete _overrides[id];
    else _overrides[id] = combos.slice();
    _recompute();
  }

  function resolve(combo) { return _byCombo[combo] || null; }
  function getCombos(id) { return (_active[id] || []).slice(); }

  // Assign `combo` to `id`. If another command owns it, that command loses
  // it (Premiere-style steal). `slot` (optional) replaces a specific
  // existing combo on `id`; otherwise the combo is added.
  function assignCombo(id, combo, slot) {
    const owner = _byCombo[combo];
    if (owner && owner !== id) {
      const stripped = _active[owner].filter(function (c) { return c !== combo; });
      _setOverride(owner, stripped);
    }
    let combos = _active[id] ? _active[id].slice() : [];
    if (slot !== undefined && slot !== null && combos[slot] !== undefined) combos[slot] = combo;
    else if (combos.indexOf(combo) === -1) combos.push(combo);
    // de-dupe in case the stolen combo equaled an existing one
    combos = combos.filter(function (c, i) { return combos.indexOf(c) === i; });
    _setOverride(id, combos);
  }

  function clearCombo(id, combo) {
    const combos = (_active[id] || []).filter(function (c) { return c !== combo; });
    _setOverride(id, combos);
  }

  function resetAll() { _overrides = {}; _recompute(); }

  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || data.format !== FILE_FORMAT || !data.overrides) return;
      _ingestOverrides(data.overrides);
    } catch (e) { /* corrupt / unavailable → defaults */ }
  }

  // Keep only known command ids mapped to arrays of non-empty strings.
  function _ingestOverrides(src) {
    const clean = {};
    Object.keys(src).forEach(function (id) {
      if (!_cmdById[id]) return;
      const v = src[id];
      if (!Array.isArray(v)) return;
      clean[id] = v.filter(function (c) { return typeof c === 'string' && c.length > 0; });
    });
    _overrides = clean;
    _recompute();
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        format: FILE_FORMAT, version: FILE_VERSION, overrides: _overrides
      }));
    } catch (e) { /* storage unavailable — in-memory still works */ }
  }

  function snapshotOverrides() { return JSON.stringify(_overrides); }

  function restoreOverrides(snap) {
    try { _overrides = snap ? JSON.parse(snap) : {}; }
    catch (e) { _overrides = {}; }
    _recompute();
    if (_uiBuilt) refresh();
  }

  _recompute();   // establish defaults so the keymap works with no saved overrides
  _load();         // overlay any persisted overrides (recomputes again if present)

  /* ─── Dispatcher ────────────────────────────────────────────────────
     View-only context handlers are preserved verbatim from the legacy
     dispatcher and take precedence; only the editable-command branches
     are routed through the keymap resolver. */

  let _capturing = false;

  document.addEventListener('keydown', function (e) {
    if (_capturing) return;   // editor is recording a shortcut
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;

    // ── View-only: arrow-key nudge (1 px, Shift = 10 px) ──
    if (!ctrl && (k === 'arrowleft' || k === 'arrowright' || k === 'arrowup' || k === 'arrowdown')) {
      const step = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (k === 'arrowleft') dx = -step;
      else if (k === 'arrowright') dx = step;
      else if (k === 'arrowup') dy = -step;
      else if (k === 'arrowdown') dy = step;
      if (nudgeMove(dx, dy)) { e.preventDefault(); return; }
    }

    // ── View-only: magnetic lasso (precedes generic Esc/Backspace/Enter) ──
    if (currentTool === 'lasso' && lassoMode === 'magnetic' && magActive) {
      if (k === 'escape') { e.preventDefault(); cancelMagneticLasso(); return; }
      if (k === 'backspace') {
        e.preventDefault();
        if (magAnchors.length > 1) {
          magAnchors.pop();
          if (magSegments.length > 0) magSegments.pop();
          magLivePath = null;
          drawMagneticOverlay();
        } else {
          cancelMagneticLasso();
        }
        return;
      }
      if (k === 'enter' && magAnchors.length > 2) { e.preventDefault(); finishMagneticLasso(true); return; }
    }

    // ── View-only: context-sensitive Escape chain (verbatim) ──
    if (k === 'escape') {
      e.preventDefault();
      if (panelEyedropperActive) { togglePanelEyedropper(); return; }
      if (document.getElementById('cpIframeOverlay')) { closeColorPicker(); return; }
      if (currentTool === 'ruler' && rulerState.active) { clearRuler(); return; }
      if (pxTransformActive) { cancelPixelTransform(); if (selection || selectionPath) clearSelection(); return; }
      if (floatingActive) commitFloating();
      if (selection || selectionPath) clearSelection();
      if (gradActive) { commitGradient(); drawOverlay(); }
      return;
    }

    // ── View-only: Enter commits a Pixel Transform ──
    if (k === 'enter') {
      if (pxTransformActive) { e.preventDefault(); commitPixelTransform(); }
      return;
    }

    // ── View-only: Delete / Backspace clears a raster selection ──
    if (k === 'delete' || k === 'backspace') {
      if (selection) { e.preventDefault(); deleteSelection(); }
      return;
    }

    // ── View-only: native paste passthrough (handled by paste event) ──
    if (ctrl && k === 'v') return;

    // ── View-only: Space → temporary pan ──
    if (k === ' ') { e.preventDefault(); return; }

    // ── Remappable commands ──
    const id = resolve(_comboFromEvent(e));
    if (id) {
      const cmd = _cmdById[id];
      if (cmd && !cmd.locked) {
        if (cmd.pd) e.preventDefault();
        cmd.run(e);
      }
    }
  });

  /* ═══════════════════════════════════════════════════════════════════
     EDITOR UI — interactive keyboard + searchable editable list
     ═══════════════════════════════════════════════════════════════════ */

  // Keyboard layout. code: canonical key char, 'fN', or '__name' for a
  // structural key. mod: toggles a modifier view. res: reserved (inert).
  const KB_ROWS = [
    [['__esc', 'Esc', 1.3, { res: 1 }], ['f1', 'F1', 1], ['f2', 'F2', 1], ['f3', 'F3', 1], ['f4', 'F4', 1], ['f5', 'F5', 1], ['f6', 'F6', 1], ['f7', 'F7', 1], ['f8', 'F8', 1], ['f9', 'F9', 1], ['f10', 'F10', 1], ['f11', 'F11', 1], ['f12', 'F12', 1]],
    [['`', '`', 1], ['1', '1', 1], ['2', '2', 1], ['3', '3', 1], ['4', '4', 1], ['5', '5', 1], ['6', '6', 1], ['7', '7', 1], ['8', '8', 1], ['9', '9', 1], ['0', '0', 1], ['-', '-', 1], ['=', '=', 1], ['__bksp', 'Backspace', 2, { res: 1 }]],
    [['__tab', 'Tab', 1.5, { res: 1 }], ['q', 'Q', 1], ['w', 'W', 1], ['e', 'E', 1], ['r', 'R', 1], ['t', 'T', 1], ['y', 'Y', 1], ['u', 'U', 1], ['i', 'I', 1], ['o', 'O', 1], ['p', 'P', 1], ['[', '[', 1], [']', ']', 1], ['\\', '\\', 1.5]],
    [['__caps', 'Caps', 1.8, { res: 1 }], ['a', 'A', 1], ['s', 'S', 1], ['d', 'D', 1], ['f', 'F', 1], ['g', 'G', 1], ['h', 'H', 1], ['j', 'J', 1], ['k', 'K', 1], ['l', 'L', 1], [';', ';', 1], ["'", "'", 1], ['__enter', 'Enter', 2.2, { res: 1 }]],
    [['__lshift', 'Shift', 2.3, { mod: 'shift' }], ['z', 'Z', 1], ['x', 'X', 1], ['c', 'C', 1], ['v', 'V', 1], ['b', 'B', 1], ['n', 'N', 1], ['m', 'M', 1], [',', ',', 1], ['.', '.', 1], ['/', '/', 1], ['__rshift', 'Shift', 2.7, { mod: 'shift' }]],
    [['__lctrl', 'Ctrl', 1.5, { mod: 'ctrl' }], ['__lalt', 'Alt', 1.4, { mod: 'alt' }], ['__space', 'Space', 6.4, { res: 1 }], ['__ralt', 'Alt', 1.4, { mod: 'alt' }], ['__rctrl', 'Ctrl', 1.5, { mod: 'ctrl' }]]
  ];

  let _uiBuilt = false;
  let _root = null;
  let _els = {};
  let _mods = { ctrl: false, alt: false, shift: false };
  let _query = '';
  let _catFilter = 'All';
  let _armed = null;          // { id, slot } currently capturing
  let _pendingConflict = null;

  function _modPrefix() {
    const p = [];
    if (_mods.ctrl) p.push('ctrl');
    if (_mods.alt) p.push('alt');
    if (_mods.shift) p.push('shift');
    return p;
  }

  function _closeKbDropdowns() {
    if (!_root) return;
    _root.querySelectorAll('.kb-cs.is-open').forEach(function (w) {
      w.classList.remove('is-open');
      var b = w.querySelector('.kb-cs-btn');
      if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  function initEditor() {
    if (_uiBuilt) { refresh(); return; }
    const panel = document.querySelector('.settings-panel[data-panel="keyboard"]');
    if (!panel) return;
    _root = document.getElementById('kbEditorRoot');
    if (!_root) return;

    _root.innerHTML =
      '<div class="kb-toolbar">' +
        '<div class="kb-search">' +
          '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
          '<input type="text" id="kbSearch" placeholder="Search commands or shortcuts…" autocomplete="off" spellcheck="false">' +
        '</div>' +
        '<div class="kb-cs" id="kbCatFilter">' +
          '<button type="button" class="kb-cs-btn" aria-haspopup="listbox" aria-expanded="false">' +
            '<span class="kb-cs-btn-label">All</span>' +
            '<span class="kb-cs-btn-sizer">Ctrl+Shift</span>' +
          '</button>' +
          '<div class="kb-cs-menu" role="listbox">' +
            '<button type="button" class="kb-cs-opt is-selected" role="option" data-cat="All">All</button>' +
            ['Tools','File','Edit','View','Color','Brush'].map(function(c){return '<button type="button" class="kb-cs-opt" role="option" data-cat="'+c+'">'+c+'</button>';}).join('') +
          '</div>' +
        '</div>' +
        '<div class="kb-toolbar-actions">' +
          '<button type="button" class="kb-btn" id="kbImportBtn" title="Import shortcuts from a .opn file">Import</button>' +
          '<button type="button" class="kb-btn" id="kbExportBtn" title="Export your shortcuts to a .opn file">Export</button>' +
          '<button type="button" class="kb-btn kb-btn-reset" id="kbResetBtn" title="Restore all default shortcuts">Reset to Default</button>' +
          '<input type="file" id="kbImportFile" accept=".opn,application/json" hidden>' +
        '</div>' +
      '</div>' +
      '<div class="kb-modbar" id="kbModbar">' +
        '<span class="kb-modbar-label">Modifiers</span>' +
        '<button type="button" class="kb-mod" data-mod="ctrl">Ctrl</button>' +
        '<button type="button" class="kb-mod" data-mod="alt">Alt</button>' +
        '<button type="button" class="kb-mod" data-mod="shift">Shift</button>' +
        '<span class="kb-modbar-hint">Click a modifier (or its key) to see that layer. Click any key to assign the selected command.</span>' +
      '</div>' +
      '<div class="kb-keyboard" id="kbKeyboard"></div>' +
      '<div class="kb-legend">' +
        '<span><i class="kb-sw kb-sw-assigned"></i>Assigned</span>' +
        '<span><i class="kb-sw kb-sw-empty"></i>Unassigned</span>' +
        '<span><i class="kb-sw kb-sw-armed"></i>Recording</span>' +
        '<span><i class="kb-sw kb-sw-match"></i>Search match</span>' +
      '</div>' +
      '<div class="kb-list" id="kbList"></div>' +
      '<div class="kb-ref" id="kbRef"></div>' +
      '<div class="kb-conflict" id="kbConflict" hidden>' +
        '<div class="kb-conflict-card">' +
          '<div class="kb-conflict-title">Shortcut already in use</div>' +
          '<div class="kb-conflict-msg" id="kbConflictMsg"></div>' +
          '<div class="kb-conflict-actions">' +
            '<button type="button" class="kb-btn" id="kbConflictCancel">Cancel</button>' +
            '<button type="button" class="kb-btn kb-btn-primary" id="kbConflictOk">Reassign</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    _els = {
      search: document.getElementById('kbSearch'),
      keyboard: document.getElementById('kbKeyboard'),
      list: document.getElementById('kbList'),
      ref: document.getElementById('kbRef'),
      modbar: document.getElementById('kbModbar'),
      conflict: document.getElementById('kbConflict'),
      conflictMsg: document.getElementById('kbConflictMsg'),
      importFile: document.getElementById('kbImportFile')
    };

    _els.search.addEventListener('input', function () {
      _query = _els.search.value.trim().toLowerCase();
      _renderList();
      _renderKeyboard();
    });
    _els.modbar.querySelectorAll('.kb-mod').forEach(function (b) {
      b.addEventListener('click', function () {
        _mods[b.dataset.mod] = !_mods[b.dataset.mod];
        _syncModbar();
        _renderKeyboard();
      });
    });
    document.getElementById('kbResetBtn').addEventListener('click', _onReset);
    document.getElementById('kbExportBtn').addEventListener('click', _onExport);
    document.getElementById('kbImportBtn').addEventListener('click', function () { _els.importFile.click(); });
    _els.importFile.addEventListener('change', _onImportFile);
    document.getElementById('kbConflictCancel').addEventListener('click', _closeConflict);
    document.getElementById('kbConflictOk').addEventListener('click', _confirmConflict);

    // Category filter dropdown
    var catWrap = document.getElementById('kbCatFilter');
    catWrap.querySelector('.kb-cs-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = catWrap.classList.contains('is-open');
      _closeKbDropdowns();
      if (!isOpen) {
        catWrap.classList.add('is-open');
        catWrap.querySelector('.kb-cs-btn').setAttribute('aria-expanded', 'true');
      }
    });
    catWrap.querySelectorAll('.kb-cs-opt').forEach(function (opt) {
      opt.addEventListener('click', function (e) {
        e.stopPropagation();
        _catFilter = opt.dataset.cat;
        catWrap.querySelector('.kb-cs-btn-label').textContent = _catFilter;
        catWrap.querySelectorAll('.kb-cs-opt').forEach(function (o) { o.classList.toggle('is-selected', o === opt); });
        _closeKbDropdowns();
        _renderList();
      });
    });
    document.addEventListener('click', _closeKbDropdowns);

    _buildKeyboard();
    _renderRef();
    _uiBuilt = true;
    refresh();
  }

  function refresh() {
    if (!_uiBuilt) return;
    _disarm();
    _query = '';
    _catFilter = 'All';
    if (_els.search) _els.search.value = '';
    var catWrap = document.getElementById('kbCatFilter');
    if (catWrap) {
      catWrap.querySelector('.kb-cs-btn-label').textContent = 'All';
      catWrap.querySelectorAll('.kb-cs-opt').forEach(function (o) { o.classList.toggle('is-selected', o.dataset.cat === 'All'); });
    }
    _syncModbar();
    _renderKeyboard();
    _renderList();
  }

  function _syncModbar() {
    _els.modbar.querySelectorAll('.kb-mod').forEach(function (b) {
      b.classList.toggle('active', !!_mods[b.dataset.mod]);
    });
  }

  /* ─── Interactive keyboard ──────────────────────────────────────── */

  function _buildKeyboard() {
    const kb = _els.keyboard;
    kb.innerHTML = '';
    KB_ROWS.forEach(function (row) {
      const rEl = document.createElement('div');
      rEl.className = 'kb-row';
      row.forEach(function (def) {
        const code = def[0], label = def[1], w = def[2], meta = def[3] || {};
        const key = document.createElement('button');
        key.type = 'button';
        key.className = 'kb-key';
        key.style.flexGrow = String(w);
        key.dataset.code = code;
        if (meta.res) key.classList.add('kb-key-res');
        if (meta.mod) { key.classList.add('kb-key-mod'); key.dataset.mod = meta.mod; }
        key.innerHTML = '<span class="kb-key-cap">' + _esc(label) + '</span><span class="kb-key-cmd"></span>';
        if (meta.mod) {
          key.addEventListener('click', function () {
            _mods[meta.mod] = !_mods[meta.mod];
            _syncModbar();
            _renderKeyboard();
          });
        } else if (!meta.res) {
          key.addEventListener('click', function () { _onKeyClick(code); });
        }
        rEl.appendChild(key);
      });
      kb.appendChild(rEl);
    });
  }

  function _renderKeyboard() {
    if (!_els.keyboard) return;
    const prefix = _modPrefix();
    _els.keyboard.querySelectorAll('.kb-key').forEach(function (key) {
      const code = key.dataset.code;
      const capEl = key.querySelector('.kb-key-cmd');
      if (key.classList.contains('kb-key-mod')) {
        key.classList.toggle('active', !!_mods[key.dataset.mod]);
        capEl.textContent = '';
        return;
      }
      if (key.classList.contains('kb-key-res')) { capEl.textContent = ''; return; }
      const combo = prefix.concat([code]).join('+');
      const id = _byCombo[combo];
      key.classList.toggle('assigned', !!id);
      key.classList.toggle('armed', !!_armed && id === _armed.id);
      let match = false;
      if (_query && id) {
        const c = _cmdById[id];
        match = c.label.toLowerCase().indexOf(_query) !== -1;
      }
      key.classList.toggle('match', match);
      capEl.textContent = id ? _cmdById[id].label : '';
      key.title = id ? _cmdById[id].label + '  ·  ' + prettyCombo(combo) : '';
    });
  }

  function _onKeyClick(code) {
    const combo = _modPrefix().concat([code]).join('+');
    if (_armed) {
      const a = _armed;
      _disarm();
      _tryAssign(a.id, a.slot, combo);
      return;
    }
    const id = _byCombo[combo];
    if (id) {
      _query = '';
      if (_els.search) _els.search.value = '';
      _renderList();
      _flashCommand(id);
    }
  }

  function _flashCommand(id) {
    const row = _els.list.querySelector('.kb-cmd-row[data-id="' + id + '"]');
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.remove('flash');
    // restart the CSS animation
    void row.offsetWidth;
    row.classList.add('flash');
  }

  /* ─── Searchable editable command list ──────────────────────────── */

  function _renderList() {
    const list = _els.list;
    list.innerHTML = '';
    const cats = _catFilter === 'All' ? CATEGORY_ORDER : [_catFilter];
    cats.forEach(function (cat) {
      const cmds = COMMANDS.filter(function (c) { return c.category === cat; }).filter(_matchesQuery);
      if (!cmds.length) return;
      const grp = document.createElement('div');
      grp.className = 'kb-cmd-group';
      if (_catFilter === 'All') {
        grp.innerHTML = '<div class=”kb-cmd-group-title”>' + _esc(cat) + '</div>';
      }
      cmds.forEach(function (c) { grp.appendChild(_renderRow(c)); });
      list.appendChild(grp);
    });
    if (!list.children.length) {
      const q = _els.search ? _els.search.value : '';
      list.innerHTML = '<div class=”kb-empty”>No commands match' + (q ? ' “' + _esc(q) + '”' : ' the selected filter') + '.</div>';
    }
  }

  function _matchesQuery(c) {
    if (!_query) return true;
    if (c.label.toLowerCase().indexOf(_query) !== -1) return true;
    if (c.category.toLowerCase().indexOf(_query) !== -1) return true;
    return _active[c.id].some(function (combo) {
      return prettyCombo(combo).toLowerCase().indexOf(_query) !== -1;
    });
  }

  function _renderRow(c) {
    const row = document.createElement('div');
    row.className = 'kb-cmd-row';
    row.dataset.id = c.id;

    const name = document.createElement('div');
    name.className = 'kb-cmd-name';
    name.textContent = c.label;
    if (c.locked) {
      const lock = document.createElement('span');
      lock.className = 'kb-cmd-lock';
      lock.textContent = 'Fixed';
      lock.title = 'Browser security requires Ctrl+V for paste — this shortcut can’t be changed.';
      name.appendChild(lock);
    }
    row.appendChild(name);

    const binds = document.createElement('div');
    binds.className = 'kb-cmd-binds';

    const combos = _active[c.id];
    if (c.locked) {
      const chip = document.createElement('span');
      chip.className = 'kb-chip kb-chip-locked';
      chip.textContent = prettyCombo(combos[0] || 'ctrl+v');
      binds.appendChild(chip);
    } else {
      combos.forEach(function (combo, slot) {
        binds.appendChild(_renderField(c, combo, slot));
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'kb-add';
      add.title = 'Add another shortcut';
      add.textContent = combos.length ? '+' : 'Click to assign';
      if (!combos.length) add.classList.add('kb-add-empty');
      add.addEventListener('click', function () { _arm(c.id, null, add); });
      binds.appendChild(add);
    }
    row.appendChild(binds);
    return row;
  }

  function _renderField(c, combo, slot) {
    const wrap = document.createElement('span');
    wrap.className = 'kb-field-wrap';

    const field = document.createElement('button');
    field.type = 'button';
    field.className = 'kb-field';
    field.textContent = prettyCombo(combo);
    field.addEventListener('click', function () { _arm(c.id, slot, field); });
    wrap.appendChild(field);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'kb-field-clear';
    del.title = 'Remove this shortcut';
    del.setAttribute('aria-label', 'Remove shortcut ' + prettyCombo(combo));
    del.textContent = '×';
    del.addEventListener('click', function (ev) {
      ev.stopPropagation();
      clearCombo(c.id, combo);
      _afterChange();
    });
    wrap.appendChild(del);
    return wrap;
  }

  /* ─── Capture / arm ─────────────────────────────────────────────── */

  function _arm(id, slot, el) {
    _disarm();
    _armed = { id: id, slot: slot, el: el };
    if (el) {
      el.classList.add('kb-recording');
      el.dataset.prev = el.textContent;
      el.textContent = 'Press keys…';
    }
    _capturing = true;
    // Bind on window (capture) so this fires BEFORE the Settings modal's
    // document-level Escape handler — Escape must cancel the recording,
    // not close the whole modal.
    window.addEventListener('keydown', _captureHandler, true);
    _renderKeyboard();
  }

  function _disarm() {
    if (_armed && _armed.el) {
      _armed.el.classList.remove('kb-recording');
      if (_armed.el.dataset.prev !== undefined) {
        _armed.el.textContent = _armed.el.dataset.prev;
        delete _armed.el.dataset.prev;
      }
    }
    _armed = null;
    _capturing = false;
    window.removeEventListener('keydown', _captureHandler, true);
  }

  function _captureHandler(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const key = (e.key || '').toLowerCase();
    if (key === 'escape') { _disarm(); _renderKeyboard(); return; }
    // Wait for a real (non-modifier) key before resolving the combo.
    if (key === 'control' || key === 'shift' || key === 'alt' || key === 'meta') return;
    const combo = _captureCombo(e);
    if (!combo) {
      if (_armed && _armed.el) _armed.el.textContent = 'Reserved key — try another';
      return;
    }
    const armed = _armed;
    _disarm();
    _tryAssign(armed.id, armed.slot, combo);
  }

  function _tryAssign(id, slot, combo) {
    const owner = _byCombo[combo];
    if (owner && owner !== id) {
      _pendingConflict = { id: id, slot: slot, combo: combo, owner: owner };
      _els.conflictMsg.innerHTML =
        '<b>' + _esc(prettyCombo(combo)) + '</b> is currently assigned to ' +
        '<b>' + _esc(_cmdById[owner].label) + '</b>.<br>' +
        'Reassign it to <b>' + _esc(_cmdById[id].label) + '</b>? ' +
        'It will be removed from <b>' + _esc(_cmdById[owner].label) + '</b>.';
      _els.conflict.hidden = false;
      return;
    }
    if (owner === id && _active[id].indexOf(combo) !== -1 && slot === null) {
      // already bound to this very command — nothing to do
      _afterChange();
      return;
    }
    assignCombo(id, combo, slot);
    _afterChange();
  }

  function _confirmConflict() {
    if (!_pendingConflict) return;
    const p = _pendingConflict;
    _pendingConflict = null;
    _els.conflict.hidden = true;
    assignCombo(p.id, p.combo, p.slot);
    _afterChange();
  }

  function _closeConflict() {
    _pendingConflict = null;
    _els.conflict.hidden = true;
  }

  function _afterChange() {
    _renderList();
    _renderKeyboard();
  }

  /* ─── Reset / Import / Export ───────────────────────────────────── */

  function _onReset() {
    if (!window.confirm('Restore all keyboard shortcuts to their defaults? Your customizations will be cleared.')) return;
    resetAll();
    refresh();
  }

  function _onExport() {
    const data = { format: FILE_FORMAT, version: FILE_VERSION, overrides: _overrides };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = EXPORT_NAME;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
  }

  function _onImportFile() {
    const file = _els.importFile.files && _els.importFile.files[0];
    _els.importFile.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || data.format !== FILE_FORMAT || typeof data.overrides !== 'object' || !data.overrides) {
          throw new Error('Unrecognized file');
        }
        _ingestOverrides(data.overrides);
        refresh();
      } catch (err) {
        alert('Could not import shortcuts: ' + (err && err.message ? err.message : 'invalid .opn file') + '.');
      }
    };
    reader.onerror = function () { alert('Could not read the selected file.'); };
    reader.readAsText(file);
  }

  /* ─── Read-only reference ───────────────────────────────────────── */

  function _renderRef() {
    let html = '<details class="kb-ref-details">' +
      '<summary class="kb-ref-summary">Other Shortcuts <span class="kb-ref-tag">view only</span>' +
      '<span class="kb-ref-note">Context modifiers — fixed to keep tools working correctly.</span></summary>' +
      '<div class="kb-ref-body">';
    REFERENCE.forEach(function (sec) {
      html += '<div class="kb-ref-group"><div class="kb-ref-group-title">' + _esc(sec.group) + '</div>';
      sec.rows.forEach(function (r) {
        html += '<div class="kb-ref-row"><span class="kb-ref-keys">' + _esc(r[0]) +
          '</span><span class="kb-ref-desc">' + _esc(r[1]) + '</span></div>';
      });
      html += '</div>';
    });
    html += '</div></details>';
    _els.ref.innerHTML = html;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ─── Public ────────────────────────────────────────────────────── */

  return {
    initEditor: initEditor,
    refresh: refresh,
    snapshotOverrides: snapshotOverrides,
    restoreOverrides: restoreOverrides,
    persist: persist,
    resolve: resolve,
    getCombos: getCombos
  };
})();
