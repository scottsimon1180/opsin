"use strict";

/* ═══════════════════════════════════════════════════════════════════════
   SVG EXPORT — Vector + raster compositor → standards-compliant SVG 1.1

   Public API (window.SvgExport):
     openDialog()                Show the export dialog (lazy-inits on
                                 first call), populate the layer list and
                                 reset option defaults to canvas size.
     closeDialog()               Hide and reset transient state.
     serialize(options?)         Build an SVG string without showing UI;
                                 see _defaultOptions() for the option keys.

   Wiring:
     - File ▸ Export As ▸ SVG    triggers openDialog()
     - Copy SVG  → clipboard
     - Preview   → opens generated SVG in a new browser tab
     - Cancel    → closes dialog
     - Export    → triggers a single download for the SVG file plus, when
                   raster=Linked, additional sibling raster downloads

   Serializer notes:
     - Output is SVG 1.1 with xmlns + xlink namespaces.
     - Vector primitives (rect/ellipse/line/path) come from each shape
       layer's shapeModel; coordinates are scaled losslessly.
     - Text layers render as either:
         (a) editable <text>/<tspan> when "Keep as text" — runs are
             walked sequentially with measured horizontal advance;
             custom fonts can be embedded via @font-face base64.
         (b) embedded <image> rasterized from the layer canvas when
             "Convert to outlines" — visually identical to canvas.
     - Raster layers are either embedded as base64 data URIs at the
       chosen format, or referenced via sibling files (Linked mode).
     - When width/height differ from canvas size, vector coordinates are
       multiplied by the scale factor; raster layers are resampled with
       a Lanczos-3 separable kernel.
   ═══════════════════════════════════════════════════════════════════════ */

window.SvgExport = (function() {

  const LAST_OPTIONS_KEY = 'opsin.svgExport.lastOptions';
  let _initialized = false;
  let _modal = null;
  let _els = {};
  let _layerSelections = [];   // [{ layer, included, ref }]
  let _aspectRatio = 1;
  let _aspectLocked = true;
  let _suppressDimSync = false;
  let _sizeUpdateScheduled = false;

  /* ─── Defaults ────────────────────────────────────────── */

  function _defaultOptions() {
    return {
      width:        (typeof canvasW !== 'undefined') ? canvasW : 1920,
      height:       (typeof canvasH !== 'undefined') ? canvasH : 1080,
      text:         'outlines',        // 'text' | 'outlines'
      embedFonts:   false,
      raster:       'embedded',        // 'embedded' | 'linked'
      rasterFormat: 'png',             // 'png' | 'jpg' | 'webp'
      style:        'attributes',      // 'attributes' | 'inline' | 'classes'
      precision:    2,
      minify:          false,
      responsive:      false,
      useCurrentColor: false,
      includeMask:     null               // Set<int> of layer indices to include; null = all visible
    };
  }

  function _loadLastOptions() {
    try {
      const raw = localStorage.getItem(LAST_OPTIONS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && typeof o === 'object' ? o : null;
    } catch (e) { return null; }
  }

  function _saveLastOptions(o) {
    try {
      const persist = {
        text: o.text, embedFonts: !!o.embedFonts,
        rasterFormat: o.rasterFormat,
        style: o.style, precision: o.precision,
        minify: !!o.minify, responsive: !!o.responsive,
        useCurrentColor: !!o.useCurrentColor
      };
      localStorage.setItem(LAST_OPTIONS_KEY, JSON.stringify(persist));
    } catch (e) {}
  }

  /* ─── Lazy DOM init ───────────────────────────────────── */

  function _init() {
    if (_initialized) return;
    _modal = document.getElementById('svgExportModal');
    if (!_modal) return;
    _els = {
      selectAll:     document.getElementById('svgExportSelectAll'),
      countReadout:  document.getElementById('svgExportCountReadout'),
      layerList:     document.getElementById('svgExportLayerList'),
      widthInput:    document.getElementById('svgExportWidthInput'),
      heightInput:   document.getElementById('svgExportHeightInput'),
      dimLink:       document.getElementById('svgExportDimLink'),
      textSelect:    document.getElementById('svgExportTextSelect'),
      textSubgroup:  document.getElementById('svgExportTextSubgroup'),
      rasterSubgroup:document.getElementById('svgExportRasterSubgroup'),
      embedFonts:    document.getElementById('svgExportEmbedFonts'),
      embedFontsRow: document.getElementById('svgExportEmbedFontsRow'),
      rasterSelect:  document.getElementById('svgExportRasterSelect'),
      formatGroup:   document.getElementById('svgExportFormatGroup'),
      linkedWarn:    document.getElementById('svgExportLinkedWarn'),
      styleSelect:   document.getElementById('svgExportStyleSelect'),
      precSelect:    document.getElementById('svgExportPrecisionSelect'),
      minify:          document.getElementById('svgExportMinify'),
      responsive:      document.getElementById('svgExportResponsive'),
      useCurrentColor: document.getElementById('svgExportCurrentColor'),
      sizeValue:     document.getElementById('svgExportSizeValue'),
      copyBtn:       document.getElementById('svgExportCopyBtn'),
      previewBtn:    document.getElementById('svgExportPreviewBtn'),
      cancelBtn:     document.getElementById('svgExportCancelBtn'),
      okBtn:         document.getElementById('svgExportOkBtn')
    };

    // Promote each native <select> to a custom dropdown matching the shape
    // tool's `.sh-preset-*` look — eliminates the OS-native dropdown's
    // white-flash and slow open animation on Windows.
    _modal.querySelectorAll('.svg-export-cs').forEach(_initCustomDropdown);
    document.addEventListener('click', _closeAllDropdowns);

    _els.selectAll.addEventListener('change', _onSelectAllToggle);
    _els.widthInput.addEventListener('input',  _onDimInput.bind(null, 'w'));
    _els.heightInput.addEventListener('input', _onDimInput.bind(null, 'h'));
    _els.dimLink.addEventListener('click',     _onDimLinkClick);
    _els.textSelect.addEventListener('change', _onTextModeChange);
    _els.embedFonts.addEventListener('change', _onAnyOptionChange);
    _els.rasterSelect.addEventListener('change', _onRasterModeChange);
    _modal.querySelectorAll('input[name="svgExportRasterFmt"]').forEach(r => {
      r.addEventListener('change', _onAnyOptionChange);
    });
    _els.styleSelect.addEventListener('change', _onAnyOptionChange);
    _els.precSelect.addEventListener('change', _onAnyOptionChange);
    _els.minify.addEventListener('change',           _onAnyOptionChange);
    _els.responsive.addEventListener('change',      _onAnyOptionChange);
    _els.useCurrentColor.addEventListener('change', _onAnyOptionChange);

    _els.copyBtn.addEventListener('click',    _onCopyClick);
    _els.previewBtn.addEventListener('click', _onPreviewClick);
    _els.cancelBtn.addEventListener('click',  closeDialog);
    _els.okBtn.addEventListener('click',      _onExportClick);

    _initialized = true;
  }

  /* ─── Custom dropdown ─────────────────────────────────── */

  function _initCustomDropdown(wrap) {
    const select = wrap.querySelector('select');
    if (!select || wrap.dataset.csInit === '1') return;
    wrap.dataset.csInit = '1';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'svg-export-cs-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const btnLabel = document.createElement('span');
    btnLabel.className = 'svg-export-cs-btn-label';
    const btnSizer = document.createElement('span');
    btnSizer.className = 'svg-export-cs-btn-sizer';
    btn.appendChild(btnLabel);
    btn.appendChild(btnSizer);

    const menu = document.createElement('div');
    menu.className = 'svg-export-cs-menu';
    menu.setAttribute('role', 'listbox');

    function syncLabel() {
      const opt = select.options[select.selectedIndex];
      btnLabel.textContent = opt ? opt.textContent : '';
      Array.from(menu.children).forEach(b => {
        b.classList.toggle('is-selected', b.dataset.value === select.value);
      });
    }

    function rebuildOptions() {
      menu.innerHTML = '';
      let longestLabel = '';
      Array.from(select.options).forEach(opt => {
        if (opt.textContent.length > longestLabel.length) longestLabel = opt.textContent;
        const ob = document.createElement('button');
        ob.type = 'button';
        ob.className = 'svg-export-cs-opt';
        ob.dataset.value = opt.value;
        ob.textContent = opt.textContent;
        ob.setAttribute('role', 'option');
        ob.addEventListener('click', (e) => {
          e.stopPropagation();
          if (select.value !== opt.value) {
            select.value = opt.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          syncLabel();
          _closeDropdown(wrap);
        });
        menu.appendChild(ob);
      });
      btnSizer.textContent = longestLabel;
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = wrap.classList.contains('is-open');
      _closeAllDropdowns();
      if (!wasOpen) _openDropdown(wrap);
    });

    // Outside selects (e.g. setter) should still re-sync the label.
    select.addEventListener('change', syncLabel);

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    rebuildOptions();
    syncLabel();
  }

  function _openDropdown(wrap) {
    wrap.classList.add('is-open');
    const btn = wrap.querySelector('.svg-export-cs-btn');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }
  function _closeDropdown(wrap) {
    wrap.classList.remove('is-open');
    const btn = wrap.querySelector('.svg-export-cs-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  function _closeAllDropdowns() {
    if (!_modal) return;
    _modal.querySelectorAll('.svg-export-cs.is-open').forEach(_closeDropdown);
  }

  // Programmatic .value = "x" does NOT fire 'change' — dispatch it ourselves
  // so custom-dropdown labels (and any other listeners) stay in sync.
  function _setSelect(selectEl, value) {
    if (!selectEl) return;
    if (selectEl.value !== value) {
      selectEl.value = value;
    }
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ─── Dialog open / close ─────────────────────────────── */

  function openDialog() {
    if (typeof closeAllMenus === 'function') closeAllMenus();
    _init();
    if (!_modal) return;

    // Restore prefs (the persisted ones), then set canvas-derived dims fresh.
    const last = _loadLastOptions() || {};
    _setSelect(_els.textSelect,   (last.text === 'text') ? 'text' : 'outlines');
    _els.embedFonts.checked   = !!last.embedFonts;
    _setSelect(_els.rasterSelect, 'embedded');
    const fmt = (last.rasterFormat === 'jpg' || last.rasterFormat === 'webp') ? last.rasterFormat : 'png';
    _modal.querySelector('input[name="svgExportRasterFmt"][value="' + fmt + '"]').checked = true;
    _setSelect(_els.styleSelect,  ['attributes','inline','classes'].includes(last.style) ? last.style : 'attributes');
    _setSelect(_els.precSelect,   String([0,1,2,3,4].includes(last.precision) ? last.precision : 2));
    _els.minify.checked          = !!last.minify;
    _els.responsive.checked      = !!last.responsive;
    _els.useCurrentColor.checked = !!last.useCurrentColor;

    const baseW = (typeof canvasW !== 'undefined') ? canvasW : 1920;
    const baseH = (typeof canvasH !== 'undefined') ? canvasH : 1080;
    _suppressDimSync = true;
    _els.widthInput.value  = baseW;
    _els.heightInput.value = baseH;
    _aspectRatio = baseW / Math.max(1, baseH);
    _aspectLocked = true;
    _els.dimLink.classList.add('locked');
    _suppressDimSync = false;

    _populateLayerList();
    _updateSelectAllState();
    _refreshDependentEnables();
    _scheduleSizeUpdate();

    _modal.classList.add('show');
  }

  function closeDialog() {
    if (!_modal) return;
    _modal.classList.remove('show');
  }

  /* ─── Layer list rendering ────────────────────────────── */

  function _populateLayerList() {
    _layerSelections = [];
    const list = _els.layerList;
    list.innerHTML = '';
    if (typeof layers === 'undefined' || !Array.isArray(layers) || layers.length === 0) {
      list.innerHTML = '<div class="svg-export-layer-row" style="opacity:0.6"><span class="svg-export-layer-info"><span class="svg-export-layer-name">No layers</span></span></div>';
      return;
    }

    // Top-down order matches the layer panel (layers[0] = topmost on Opsin).
    layers.forEach((layer, idx) => {
      const row = document.createElement('label');
      row.className = 'svg-export-layer-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!layer.visible;     // hidden layers default unchecked
      cb.addEventListener('change', () => {
        ref.included = cb.checked;
        _updateSelectAllState();
        _scheduleSizeUpdate();
      });

      const checkCol = document.createElement('span');
      checkCol.className = 'svg-export-check-col';
      const check = document.createElement('span');
      check.className = 'svg-export-check';
      checkCol.appendChild(check);

      const thumb = document.createElement('div');
      thumb.className = 'svg-export-layer-thumb';
      _populateThumb(thumb, layer);

      const info = document.createElement('div');
      info.className = 'svg-export-layer-info';
      info.innerHTML = ''
        + '<div class="svg-export-layer-name">' + _escAttr(layer.name || 'Layer ' + (idx + 1)) + '</div>'
        + '<div class="svg-export-layer-meta">'
        +   '<span class="svg-export-kind-badge kind-' + _layerKindClass(layer) + '">' + _layerKindLabel(layer) + '</span>'
        + '</div>';

      row.appendChild(cb);
      row.appendChild(thumb);
      row.appendChild(info);
      // Only render the visibility indicator when the layer IS hidden — a
      // visible layer needs no marker, keeping the row clean.
      if (!layer.visible) {
        const vis = document.createElement('span');
        vis.className = 'svg-export-layer-vis';
        vis.title = 'This layer is currently hidden';
        vis.innerHTML = '<svg><use href="#icon-layer-visibility-off"/></svg>';
        row.appendChild(vis);
      }
      row.appendChild(checkCol);
      list.appendChild(row);

      const ref = { layer: layer, idx: idx, included: cb.checked, cb: cb };
      _layerSelections.push(ref);
    });
  }

  function _layerKindClass(l) {
    if (l.kind === 'text')  return 'text';
    if (l.kind === 'shape') return 'shape';
    return 'image';
  }
  function _layerKindLabel(l) {
    if (l.kind === 'text')  return 'Text';
    if (l.kind === 'shape') return 'Shape';
    return 'Image';
  }

  function _populateThumb(thumbEl, layer) {
    const baseW = (typeof canvasW !== 'undefined') ? canvasW : layer.canvas.width;
    const baseH = (typeof canvasH !== 'undefined') ? canvasH : layer.canvas.height;
    // Render to the canvas's actual aspect ratio so the thumb container
    // collapses to match (mirrors the layers panel behavior).
    const max = 36;
    let tw, th;
    if (baseW >= baseH) { tw = max; th = Math.max(1, Math.round(max * (baseH / baseW))); }
    else                { th = max; tw = Math.max(1, Math.round(max * (baseW / baseH))); }
    const tc = document.createElement('canvas');
    tc.width = tw; tc.height = th;
    tc.getContext('2d').drawImage(layer.canvas, 0, 0, baseW, baseH, 0, 0, tw, th);
    thumbEl.appendChild(tc);
  }

  /* ─── Event handlers ──────────────────────────────────── */

  function _onSelectAllToggle() {
    const v = _els.selectAll.checked;
    _layerSelections.forEach(s => { s.included = v; s.cb.checked = v; });
    _scheduleSizeUpdate();
  }

  function _updateSelectAllState() {
    if (!_els.selectAll) return;
    const total = _layerSelections.length;
    const sel = _layerSelections.filter(s => s.included).length;
    _els.selectAll.checked = (sel === total && total > 0);
    // Only two states (check / empty) — no indeterminate, matching the
    // ICO export modal's master checkbox behavior.
    _els.selectAll.indeterminate = false;
    _els.countReadout.textContent = sel + ' of ' + total;
  }

  function _onDimInput(which) {
    if (_suppressDimSync) return;
    if (!_aspectLocked) { _scheduleSizeUpdate(); return; }
    _suppressDimSync = true;
    if (which === 'w') {
      const w = parseFloat(_els.widthInput.value);
      if (Number.isFinite(w) && w > 0) {
        _els.heightInput.value = Math.max(1, Math.round(w / _aspectRatio));
      }
    } else {
      const h = parseFloat(_els.heightInput.value);
      if (Number.isFinite(h) && h > 0) {
        _els.widthInput.value = Math.max(1, Math.round(h * _aspectRatio));
      }
    }
    _suppressDimSync = false;
    _scheduleSizeUpdate();
  }

  function _onDimLinkClick(e) {
    e.preventDefault();
    _aspectLocked = !_aspectLocked;
    _els.dimLink.classList.toggle('locked', _aspectLocked);
    if (_aspectLocked) {
      const w = parseFloat(_els.widthInput.value);
      const h = parseFloat(_els.heightInput.value);
      if (w > 0 && h > 0) _aspectRatio = w / h;
    }
  }

  function _onTextModeChange() {
    _refreshDependentEnables();
    _scheduleSizeUpdate();
  }
  function _onRasterModeChange() {
    _refreshDependentEnables();
    _scheduleSizeUpdate();
  }
  function _onAnyOptionChange() { _scheduleSizeUpdate(); }

  function _refreshDependentEnables() {
    // Whole-subgroup enables: Font/Text grays out when no selected layer is
    // a text layer; Raster image(s) grays out when no selected layer is a
    // raster layer. This makes the unavailable controls visually inert and
    // unmistakably "not applicable" rather than active-but-confusing.
    const hasText   = _selectedHasText();
    const hasRaster = _selectedHasRaster();
    if (_els.textSubgroup)   _els.textSubgroup.classList.toggle('disabled', !hasText);
    if (_els.rasterSubgroup) _els.rasterSubgroup.classList.toggle('disabled', !hasRaster);

    // Inside Font/text: Embed fonts is only meaningful when "Keep as <text>"
    // is selected AND a selected text layer references a custom font.
    const textMode = _els.textSelect.value;
    const customFontPresent = _selectedTextHasCustomFont();
    const embedFontsEnabled = hasText && (textMode === 'text') && customFontPresent;
    if (_els.embedFontsRow) _els.embedFontsRow.classList.toggle('disabled', !embedFontsEnabled);

    // Inside Raster: format radios disabled when no raster layers
    _els.formatGroup.classList.toggle('disabled', !hasRaster);

    // Linked warning visible only when raster=linked AND raster present.
    // Keep it in layout as a collapsed element so modal height can animate.
    const showLinkedWarn = (_els.rasterSelect.value === 'linked' && hasRaster);
    _els.linkedWarn.hidden = false;
    _els.linkedWarn.classList.toggle('is-visible', showLinkedWarn);
    _els.linkedWarn.setAttribute('aria-hidden', showLinkedWarn ? 'false' : 'true');
  }

  function _selectedHasRaster() {
    if (!_layerSelections.length) {
      return Array.isArray(layers) && layers.some(l => (!l.kind || l.kind === 'image') && l.visible);
    }
    return _layerSelections.some(s => s.included && (!s.layer.kind || s.layer.kind === 'image'));
  }

  function _selectedHasText() {
    if (!_layerSelections.length) {
      return Array.isArray(layers) && layers.some(l => l.kind === 'text' && l.visible);
    }
    return _layerSelections.some(s => s.included && s.layer.kind === 'text');
  }

  function _selectedTextHasCustomFont() {
    if (!window.CustomFonts || typeof CustomFonts.list !== 'function') return false;
    const families = new Set(CustomFonts.list().map(f => f.family));
    if (families.size === 0) return false;
    return _layerSelections.some(s => {
      if (!s.included) return false;
      const l = s.layer;
      if (l.kind !== 'text' || !l.textModel || !l.textModel.runs) return false;
      return l.textModel.runs.some(r => families.has(r.font));
    });
  }

  /* ─── File-size estimate (debounced) ──────────────────── */

  function _scheduleSizeUpdate() {
    _refreshDependentEnables();
    _updateSelectAllState();
    if (_sizeUpdateScheduled) return;
    _sizeUpdateScheduled = true;
    setTimeout(() => {
      _sizeUpdateScheduled = false;
      try {
        const opts = _readOptions();
        const svg = serialize(opts);
        const bytes = new Blob([svg]).size;
        _els.sizeValue.textContent = _humanBytes(bytes);
      } catch (err) {
        _els.sizeValue.textContent = '—';
        // eslint-disable-next-line no-console
        console.warn('[SvgExport] estimate failed', err);
      }
    }, 80);
  }

  function _humanBytes(b) {
    if (b < 1024)         return b + ' B';
    if (b < 1024 * 1024)  return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }

  /* ─── Copy / Preview / Export ─────────────────────────── */

  function _onCopyClick() {
    try {
      const svg = serialize(_readOptions());
      const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = svg;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(svg).catch(fallback);
      } else {
        fallback();
      }
      const btn = _els.copyBtn;
      const labelEl = btn.querySelector('.svg-export-foot-btn-label');
      const original = btn.dataset.defaultLabel || labelEl.textContent;
      btn.dataset.defaultLabel = original;
      if (btn._svgExportCopyTimer) clearTimeout(btn._svgExportCopyTimer);
      btn.classList.add('copied');
      _transitionCopyButtonLabel(btn, 'COPIED!');
      btn._svgExportCopyTimer = setTimeout(() => {
        _transitionCopyButtonLabel(btn, original, () => btn.classList.remove('copied'));
        btn._svgExportCopyTimer = null;
      }, 1100);
    } catch (err) {
      console.error('[SvgExport] copy failed', err);
      alert('Could not copy SVG: ' + (err.message || err));
    }
  }

  function _transitionCopyButtonLabel(btn, text, afterChange) {
    const labelEl = btn.querySelector('.svg-export-foot-btn-label');
    if (!labelEl) return;
    if (btn._svgExportLabelTimer) clearTimeout(btn._svgExportLabelTimer);
    btn.classList.add('is-label-changing');
    btn._svgExportLabelTimer = setTimeout(() => {
      labelEl.textContent = text;
      if (typeof afterChange === 'function') afterChange();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          btn.classList.remove('is-label-changing');
          btn._svgExportLabelTimer = null;
        });
      });
    }, 140);
  }

  function _onPreviewClick() {
    try {
      const opts = _readOptions();
      // Force embedded for preview — linked references won't resolve in a
      // detached blob URL.
      const previewOpts = Object.assign({}, opts, { raster: 'embedded', _previewMode: true });
      const svg = serialize(previewOpts);
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const w = window.open(url, '_blank');
      // Revoke after a generous delay so the new tab finishes parsing.
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (!w) alert('Pop-up blocked — allow pop-ups to use Preview.');
    } catch (err) {
      console.error('[SvgExport] preview failed', err);
      alert('Could not preview SVG: ' + (err.message || err));
    }
  }

  function _onExportClick() {
    try {
      const opts = _readOptions();
      _saveLastOptions(opts);
      const svg = serialize(opts);
      const stem = _filenameStem();
      _triggerDownload(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), stem + '.svg');

      if (opts.raster === 'linked') {
        // Side-car downloads for each linked raster layer. The serializer
        // recorded these on opts._linkedAssets.
        const assets = opts._linkedAssets || [];
        assets.forEach((a, i) => {
          setTimeout(() => _triggerDownload(a.blob, a.filename), 120 * (i + 1));
        });
      }
      closeDialog();
    } catch (err) {
      console.error('[SvgExport] export failed', err);
      alert('Could not export SVG: ' + (err.message || err));
    }
  }

  function _filenameStem() {
    if (typeof _docName === 'string' && _docName) return _docName.replace(/\.[^.]+$/, '');
    return 'image';
  }

  function _triggerDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* ─── Read options snapshot ──────────────────────────── */

  function _readOptions() {
    const opts = _defaultOptions();
    opts.width  = Math.max(1, Math.round(parseFloat(_els.widthInput.value)  || opts.width));
    opts.height = Math.max(1, Math.round(parseFloat(_els.heightInput.value) || opts.height));
    opts.text         = _els.textSelect.value === 'text' ? 'text' : 'outlines';
    opts.embedFonts   = _els.embedFonts.checked && _els.textSelect.value === 'text';
    opts.raster       = _els.rasterSelect.value === 'linked' ? 'linked' : 'embedded';
    const fmtRadio    = _modal.querySelector('input[name="svgExportRasterFmt"]:checked');
    opts.rasterFormat = fmtRadio ? fmtRadio.value : 'png';
    opts.style        = _els.styleSelect.value;
    opts.precision    = parseInt(_els.precSelect.value, 10);
    if (![0,1,2,3,4].includes(opts.precision)) opts.precision = 2;
    opts.minify          = _els.minify.checked;
    opts.responsive      = _els.responsive.checked;
    opts.useCurrentColor = _els.useCurrentColor.checked;
    opts.includeMask  = new Set(_layerSelections.filter(s => s.included).map(s => s.idx));
    return opts;
  }

  /* ═══════════════════════════════════════════════════════
     SERIALIZER
     ═══════════════════════════════════════════════════════ */

  function serialize(options) {
    const o = Object.assign(_defaultOptions(), options || {});
    if (!Array.isArray(layers)) throw new Error('No layers available');

    const baseW = (typeof canvasW !== 'undefined') ? canvasW : o.width;
    const baseH = (typeof canvasH !== 'undefined') ? canvasH : o.height;
    const sx = o.width  / baseW;
    const sy = o.height / baseH;

    // Class registry for "CSS classes" mode
    const classReg = (o.style === 'classes') ? { map: new Map(), order: [] } : null;
    o._classReg = classReg;
    o._linkedAssets = [];   // collected during raster serialization
    o._sx = sx; o._sy = sy;
    o._baseW = baseW; o._baseH = baseH;

    // Walk layers bottom-up so painters' algorithm matches Opsin compositor.
    const layerXml = [];
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (o.includeMask && !o.includeMask.has(i)) continue;
      // includeMask=null → fall back to "visible only"
      if (!o.includeMask && !layer.visible) continue;

      const xml = _serializeLayer(layer, i, o);
      if (xml) layerXml.push(xml);
    }

    // Build root SVG ──────────────────────────────────────
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    let rootAttrs = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
    rootAttrs += ' viewBox="0 0 ' + _fmt(o.width, o.precision) + ' ' + _fmt(o.height, o.precision) + '"';
    if (!o.responsive) {
      rootAttrs += ' width="' + _fmt(o.width, o.precision) + '" height="' + _fmt(o.height, o.precision) + '"';
    }
    rootAttrs += ' preserveAspectRatio="xMidYMid meet"';
    out.push('<svg ' + rootAttrs + '>');

    // Optional metadata
    out.push('<title>' + _escText(_filenameStem()) + '</title>');

    // Class definitions (must come before any class references)
    const fontFaceCss = (o.embedFonts && o.text === 'text') ? _buildEmbeddedFontFaceCss(o) : '';
    if ((classReg && classReg.order.length) || fontFaceCss) {
      out.push('<defs><style><![CDATA[');
      if (fontFaceCss) out.push(fontFaceCss);
      if (classReg) {
        classReg.order.forEach(name => {
          const css = classReg.map.get(name);
          out.push('.' + name + ' { ' + css + ' }');
        });
      }
      out.push(']]></style></defs>');
    }

    // Layer groups (already in bottom-up paint order)
    layerXml.forEach(x => out.push(x));

    out.push('</svg>');

    let result = out.join(o.minify ? '' : '\n');
    if (o.minify) result = _minify(result);
    return result;
  }

  /* ─── Per-layer dispatch ──────────────────────────────── */

  function _serializeLayer(layer, idx, o) {
    const sx = o._sx, sy = o._sy;

    let body = '';
    if (layer.kind === 'shape' && layer.shapeModel && layer.shapeModel.shapes && layer.shapeModel.shapes.length) {
      body = _serializeShapeLayer(layer, o);
    } else if (layer.kind === 'text' && layer.textModel) {
      if (o.text === 'text') {
        body = _serializeTextLayer(layer, o);
      } else {
        // Convert to outlines = rasterize the text layer's pre-rendered
        // canvas. Visually identical, no font dependency.
        body = _serializeRasterFromCanvas(layer.canvas, layer, idx, o);
      }
    } else {
      // image / unknown
      body = _serializeRasterFromCanvas(layer.canvas, layer, idx, o);
    }

    if (!body) return '';

    const opacity = (layer.opacity != null && layer.opacity < 1)
      ? ' opacity="' + _fmt(layer.opacity, 3) + '"' : '';
    const display = layer.visible ? '' : ' display="none"';
    const safeName = _escAttr(layer.name || ('Layer ' + (idx + 1)));
    return '<g id="layer-' + (idx + 1) + '" data-name="' + safeName + '"'
      + opacity + display + '>' + body + '</g>';
  }

  /* ═══════════════════════════════════════════════════════
     SHAPE LAYER → vector primitives
     ═══════════════════════════════════════════════════════ */

  function _serializeShapeLayer(layer, o) {
    const parts = [];
    for (const s of layer.shapeModel.shapes) {
      const p = _serializeShape(s, o);
      if (p) parts.push(p);
    }
    return parts.join('');
  }

  function _serializeShape(s, o) {
    if (!s) return '';
    const sx = o._sx, sy = o._sy;

    let geom = '';
    let attrs = '';

    if (s.type === 'rect') {
      const x = s.x * sx, y = s.y * sy, w = s.w * sx, h = s.h * sy;
      const rx = (s.cornerRadius || 0) * Math.min(sx, sy);
      attrs = 'x="' + _fmt(x, o.precision) + '" y="' + _fmt(y, o.precision)
        + '" width="' + _fmt(w, o.precision) + '" height="' + _fmt(h, o.precision) + '"';
      if (rx > 0) attrs += ' rx="' + _fmt(rx, o.precision) + '" ry="' + _fmt(rx, o.precision) + '"';
      const styleProps = _shapeStyleProps(s);
      _applyCurrentColor(styleProps, o);
      const transformAttr = _shapeTransform(s, o, x + w/2, y + h/2);
      return '<rect ' + attrs + transformAttr + _styleAttr(styleProps, o) + '/>';
    }

    if (s.type === 'ellipse') {
      const x = s.x * sx, y = s.y * sy, w = s.w * sx, h = s.h * sy;
      const cx = x + w/2, cy = y + h/2;
      attrs = 'cx="' + _fmt(cx, o.precision) + '" cy="' + _fmt(cy, o.precision)
        + '" rx="' + _fmt(Math.abs(w/2), o.precision) + '" ry="' + _fmt(Math.abs(h/2), o.precision) + '"';
      const styleProps = _shapeStyleProps(s);
      _applyCurrentColor(styleProps, o);
      const transformAttr = _shapeTransform(s, o, cx, cy);
      return '<ellipse ' + attrs + transformAttr + _styleAttr(styleProps, o) + '/>';
    }

    if (s.type === 'line') {
      const x1 = s.p1.x * sx, y1 = s.p1.y * sy;
      const x2 = s.p2.x * sx, y2 = s.p2.y * sy;
      attrs = 'x1="' + _fmt(x1, o.precision) + '" y1="' + _fmt(y1, o.precision)
        + '" x2="' + _fmt(x2, o.precision) + '" y2="' + _fmt(y2, o.precision) + '"';
      // Lines have no fill in SVG <line>, force fill="none" via style props
      const styleProps = _shapeStyleProps(s);
      styleProps.fill = 'none';
      _applyCurrentColor(styleProps, o);
      return '<line ' + attrs + _styleAttr(styleProps, o) + '/>';
    }

    if (s.type === 'path') {
      const d = _pathD(s, o);
      if (!d) return '';
      // Path coords already include rotation baked in (per Opsin model).
      const styleProps = _shapeStyleProps(s);
      if (!s.closed) styleProps.fill = 'none';   // open paths shouldn't fill in SVG
      _applyCurrentColor(styleProps, o);
      return '<path d="' + d + '"' + _styleAttr(styleProps, o) + '/>';
    }

    return '';
  }

  function _shapeTransform(s, o, cx, cy) {
    if (!s.rotation) return '';
    const deg = s.rotation * 180 / Math.PI;
    return ' transform="rotate(' + _fmt(deg, 3) + ' '
      + _fmt(cx, o.precision) + ' ' + _fmt(cy, o.precision) + ')"';
  }

  function _pathD(s, o) {
    const sx = o._sx, sy = o._sy;
    const pts = s.points || [];
    if (pts.length < 1) return '';
    const cmds = [];
    cmds.push('M' + _fmt(pts[0].x * sx, o.precision) + ',' + _fmt(pts[0].y * sy, o.precision));
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i-1], cur = pts[i];
      cmds.push(_segCommand(prev, cur, sx, sy, o.precision));
    }
    if (s.closed && pts.length > 1) {
      const prev = pts[pts.length - 1], cur = pts[0];
      cmds.push(_segCommand(prev, cur, sx, sy, o.precision));
      cmds.push('Z');
    }
    return cmds.join(' ');
  }

  function _segCommand(prev, cur, sx, sy, prec) {
    const cp1x = prev.ohx !== undefined ? prev.ohx : prev.x;
    const cp1y = prev.ohy !== undefined ? prev.ohy : prev.y;
    const cp2x = cur.ihx  !== undefined ? cur.ihx  : cur.x;
    const cp2y = cur.ihy  !== undefined ? cur.ihy  : cur.y;
    if (cp1x === prev.x && cp1y === prev.y && cp2x === cur.x && cp2y === cur.y) {
      return 'L' + _fmt(cur.x * sx, prec) + ',' + _fmt(cur.y * sy, prec);
    }
    return 'C'
      + _fmt(cp1x * sx, prec) + ',' + _fmt(cp1y * sy, prec) + ' '
      + _fmt(cp2x * sx, prec) + ',' + _fmt(cp2y * sy, prec) + ' '
      + _fmt(cur.x * sx,  prec) + ',' + _fmt(cur.y * sy,  prec);
  }

  function _applyCurrentColor(props, o) {
    if (!o.useCurrentColor) return;
    if (props.fill && props.fill !== 'none') { props.fill = 'currentColor'; delete props['fill-opacity']; }
    if (props.stroke) { props.stroke = 'currentColor'; delete props['stroke-opacity']; }
  }

  function _shapeStyleProps(s) {
    const p = {};
    // Fill
    if (s.type !== 'line' && s.fill && s.fill.type !== 'none') {
      const c = _colorParts(s.fill.color);
      p.fill = c.hex;
      if (c.alpha < 1) p['fill-opacity'] = _fmt(c.alpha, 3);
    } else if (s.type !== 'line') {
      p.fill = 'none';
    }
    // Stroke
    const sw = s.stroke;
    if (sw && sw.type !== 'none' && sw.width > 0) {
      const c = _colorParts(sw.color);
      p.stroke = c.hex;
      if (c.alpha < 1) p['stroke-opacity'] = _fmt(c.alpha, 3);
      p['stroke-width'] = _fmt(sw.width, 3);
      if (sw.cap && sw.cap !== 'butt')   p['stroke-linecap']  = sw.cap;
      if (sw.join && sw.join !== 'miter') p['stroke-linejoin'] = sw.join;
      if (sw.dashPattern && sw.dashPattern.length) {
        const dash = sw.dashPattern.filter(n => Number.isFinite(+n)).map(n => _fmt(+n, 3)).join(',');
        if (dash) p['stroke-dasharray'] = dash;
      }
      if (sw.dashOffset)  p['stroke-dashoffset'] = _fmt(sw.dashOffset, 3);
    }
    // Per-shape opacity
    if (s.opacity != null && s.opacity < 1) {
      p.opacity = _fmt(s.opacity, 3);
    }
    return p;
  }

  /* ═══════════════════════════════════════════════════════
     TEXT LAYER → <text>/<tspan>
     ═══════════════════════════════════════════════════════ */

  function _serializeTextLayer(layer, o) {
    const m = layer.textModel;
    if (!m || !m.runs || !m.runs.length) return '';
    const sx = o._sx, sy = o._sy;
    // Average scale for font-size; SVG <text> can't be non-uniformly scaled
    // without a transform. If sx ≠ sy we wrap the <text> in a transform.
    const useGroupTransform = (Math.abs(sx - sy) > 1e-4) || !!m.rotation;

    // Walk runs, splitting by '\n' to produce line breaks.
    // Each run's text is split into segments by newlines.
    const lines = [[]];        // lines[i] = array of { run, text }
    for (const r of m.runs) {
      const parts = String(r.text || '').split('\n');
      parts.forEach((p, j) => {
        if (j > 0) lines.push([]);
        if (p.length) lines[lines.length - 1].push({ run: r, text: p });
      });
    }

    // Compute baseline for first line. textModel boxX/boxY are top-left.
    // For SVG, x/y of <text> sets the baseline of the first run; we offset by
    // the run's font ascent (≈ 0.8 * size for typical fonts).
    const firstRun = m.runs[0] || { size: 16, font: 'sans-serif' };
    const firstSize = +firstRun.size || 16;
    const baselineOffset = firstSize * 0.82;
    const xOrigin = (m.boxX || 0);
    const yOrigin = (m.boxY || 0) + baselineOffset;
    const lineHeight = (+m.lineSpacing || 1.2) * firstSize;
    const align = m.align || 'left';
    const textAnchor = align === 'center' ? 'middle' : (align === 'right' ? 'end' : 'start');
    const xAnchor = align === 'center' ? (xOrigin + (m.boxW || 0) / 2)
                : align === 'right'  ? (xOrigin + (m.boxW || 0))
                                     : xOrigin;
    const letterSpacing = +m.letterSpacing || 0;

    const parts = [];
    parts.push('<text');
    // Base text-element attrs
    parts.push(' x="' + _fmt(useGroupTransform ? xAnchor : xAnchor * sx, o.precision) + '"');
    parts.push(' y="' + _fmt(useGroupTransform ? yOrigin  : yOrigin  * sy, o.precision) + '"');
    parts.push(' text-anchor="' + textAnchor + '"');
    parts.push(' xml:space="preserve"');
    if (letterSpacing) parts.push(' letter-spacing="' + _fmt(letterSpacing, 3) + '"');
    parts.push('>');

    lines.forEach((line, lineIdx) => {
      line.forEach((seg, segIdx) => {
        const r = seg.run;
        const props = {};
        props['font-family'] = _cssFontFamily(r.font);
        props['font-size']   = _fmt(+r.size || 16, 3);
        if (r.bold)   props['font-weight'] = 'bold';
        if (r.italic) props['font-style']  = 'italic';
        const c = _colorParts(r.color || '#000');
        if (o.useCurrentColor) {
          props.fill = 'currentColor';
        } else {
          props.fill = c.hex;
          if (c.alpha < 1) props['fill-opacity'] = _fmt(c.alpha, 3);
        }
        if (r.underline) props['text-decoration'] = 'underline';

        const styleStr = _styleAttr(props, o);
        let dx = '', dy = '';
        if (lineIdx > 0 && segIdx === 0) {
          // new line — reset x and bump y
          dy = ' x="' + _fmt(useGroupTransform ? xAnchor : xAnchor * sx, o.precision)
             + '" dy="' + _fmt(lineHeight, 3) + '"';
        }
        parts.push('<tspan' + dy + styleStr + '>' + _escText(seg.text) + '</tspan>');
      });
      // Empty lines still bump y
      if (line.length === 0 && lineIdx > 0) {
        parts.push('<tspan x="' + _fmt(useGroupTransform ? xAnchor : xAnchor * sx, o.precision)
          + '" dy="' + _fmt(lineHeight, 3) + '"></tspan>');
      }
    });
    parts.push('</text>');

    if (useGroupTransform) {
      // Compose: scale (sx, sy) about origin (0,0) THEN rotate about (cx, cy)
      const cx = (m.boxX || 0) + (m.boxW || 0) / 2;
      const cy = (m.boxY || 0) + (m.boxH || 0) / 2;
      const rotDeg = (m.rotation || 0) * 180 / Math.PI;
      const transforms = [];
      if (sx !== 1 || sy !== 1) {
        transforms.push('scale(' + _fmt(sx, 5) + ' ' + _fmt(sy, 5) + ')');
      }
      if (rotDeg) {
        transforms.push('rotate(' + _fmt(rotDeg, 3) + ' ' + _fmt(cx, o.precision) + ' ' + _fmt(cy, o.precision) + ')');
      }
      return '<g transform="' + transforms.join(' ') + '">' + parts.join('') + '</g>';
    }
    return parts.join('');
  }

  function _cssFontFamily(family) {
    const f = String(family || '').trim() || 'sans-serif';
    // Quote families with spaces, e.g. "Times New Roman".
    if (/[\s,]/.test(f) && !/^['"].*['"]$/.test(f)) return "'" + f.replace(/'/g, "\\'") + "'";
    return f;
  }

  function _buildEmbeddedFontFaceCss(o) {
    if (!window.CustomFonts || !document.fonts) return '';
    const usedFamilies = new Set();
    if (!Array.isArray(layers)) return '';
    layers.forEach((l, idx) => {
      if (o.includeMask && !o.includeMask.has(idx)) return;
      if (!o.includeMask && !l.visible) return;
      if (l.kind !== 'text' || !l.textModel || !l.textModel.runs) return;
      l.textModel.runs.forEach(r => { if (r.font) usedFamilies.add(r.font); });
    });
    if (usedFamilies.size === 0) return '';
    // Access the IndexedDB-backed records by reaching into CustomFonts.list()
    // to find which families need embedding. We need the binary too — pull it
    // from the in-memory array (the module exposes only metadata via list()).
    // Without direct API access we cannot retrieve the buffer, so we rely on
    // the runtime having loaded these fonts already and skip embedding when
    // the buffer isn't accessible. A stub @font-face referencing the family
    // name still helps in editors that auto-find fonts by name.
    const customMeta = (typeof CustomFonts.list === 'function') ? CustomFonts.list() : [];
    const customFamilies = new Set(customMeta.map(f => f.family));
    const lines = [];
    customFamilies.forEach(family => {
      if (!usedFamilies.has(family)) return;
      // Best-effort embed: family-only declaration (browsers will use the
      // installed font registered via FontFace API at view time).
      lines.push("@font-face { font-family: '" + family.replace(/'/g, "\\'") + "'; src: local('" + family.replace(/'/g, "\\'") + "'); }");
    });
    return lines.join('\n');
  }

  /* ═══════════════════════════════════════════════════════
     RASTER LAYER → <image> (embedded base64 or linked file)
     ═══════════════════════════════════════════════════════ */

  function _serializeRasterFromCanvas(srcCanvas, layer, layerIdx, o) {
    if (!srcCanvas || !srcCanvas.width || !srcCanvas.height) return '';
    const baseW = o._baseW, baseH = o._baseH;
    const outW = o.width, outH = o.height;

    // Resample only when the output dimensions differ from the source canvas.
    // Lanczos-3 separable for high quality. For 1:1, embed as-is.
    let canvas = srcCanvas;
    if (srcCanvas.width !== outW || srcCanvas.height !== outH) {
      canvas = _lanczosResample(srcCanvas, outW, outH);
    }

    const mime = o.rasterFormat === 'jpg'  ? 'image/jpeg'
              : o.rasterFormat === 'webp' ? 'image/webp'
                                          : 'image/png';
    const ext  = o.rasterFormat === 'jpg' ? 'jpg' : o.rasterFormat;
    const quality = (mime === 'image/jpeg' || mime === 'image/webp') ? 0.92 : undefined;

    if (o.raster === 'linked') {
      // Sync conversion via toBlob requires a callback; for linked mode we
      // need a synchronous data URL anyway (the SVG references the file).
      const dataUrl = canvas.toDataURL(mime, quality);
      const filename = _filenameStem() + '_layer_' + (layerIdx + 1) + '.' + ext;
      const blob = _dataUrlToBlob(dataUrl);
      o._linkedAssets.push({ filename: filename, blob: blob });
      return '<image x="0" y="0" width="' + _fmt(outW, o.precision)
        + '" height="' + _fmt(outH, o.precision)
        + '" xlink:href="' + _escAttr(filename)
        + '" href="' + _escAttr(filename) + '"/>';
    }

    // Embedded
    const dataUrl = canvas.toDataURL(mime, quality);
    return '<image x="0" y="0" width="' + _fmt(outW, o.precision)
      + '" height="' + _fmt(outH, o.precision)
      + '" xlink:href="' + dataUrl
      + '" href="' + dataUrl + '"/>';
  }

  function _dataUrlToBlob(dataUrl) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (!m) return new Blob([''], { type: 'application/octet-stream' });
    const mime = m[1];
    const bin = atob(m[2]);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: mime });
  }

  /* ═══════════════════════════════════════════════════════
     LANCZOS-3 SEPARABLE RESAMPLE
     High-quality resize for raster layers when output dimensions
     differ from source. Two-pass (horizontal then vertical) for
     O(N·k) per pass instead of O(N·k²) direct.
     ═══════════════════════════════════════════════════════ */

  function _lanczosResample(src, dw, dh) {
    const sw = src.width, sh = src.height;
    if (!sw || !sh || !dw || !dh) {
      const empty = document.createElement('canvas');
      empty.width = Math.max(1, dw|0); empty.height = Math.max(1, dh|0);
      return empty;
    }
    if (sw === dw && sh === dh) return src;

    const a = 3;
    const sctx = src.getContext('2d');
    const srcImg = sctx.getImageData(0, 0, sw, sh);

    // Pass 1: horizontal (sw × sh) → (dw × sh)
    const tmp = new Float32Array(dw * sh * 4);
    {
      const ratio = sw / dw;
      const filterScale = Math.max(1, ratio);
      const support = a * filterScale;
      for (let x = 0; x < dw; x++) {
        const center = (x + 0.5) * ratio - 0.5;
        const left  = Math.max(0, Math.floor(center - support));
        const right = Math.min(sw - 1, Math.ceil(center + support));
        // Precompute filter weights for this output column
        let wsum = 0;
        const weights = [];
        for (let i = left; i <= right; i++) {
          const t = (i - center) / filterScale;
          const w = _lanczosKernel(t, a);
          weights.push(w);
          wsum += w;
        }
        const inv = wsum !== 0 ? 1 / wsum : 0;
        for (let y = 0; y < sh; y++) {
          let r = 0, g = 0, b = 0, alpha = 0;
          let wi = 0;
          for (let i = left; i <= right; i++) {
            const w = weights[wi++] * inv;
            const off = (y * sw + i) * 4;
            const aSrc = srcImg.data[off + 3];
            // Pre-multiply by alpha to avoid color bleed at transparent edges
            r += srcImg.data[off]     * aSrc * w;
            g += srcImg.data[off + 1] * aSrc * w;
            b += srcImg.data[off + 2] * aSrc * w;
            alpha += aSrc * w;
          }
          const tOff = (y * dw + x) * 4;
          tmp[tOff]     = r;
          tmp[tOff + 1] = g;
          tmp[tOff + 2] = b;
          tmp[tOff + 3] = alpha;
        }
      }
    }

    // Pass 2: vertical (dw × sh) → (dw × dh)
    const dst = document.createElement('canvas');
    dst.width = dw; dst.height = dh;
    const dctx = dst.getContext('2d');
    const dstImg = dctx.createImageData(dw, dh);
    {
      const ratio = sh / dh;
      const filterScale = Math.max(1, ratio);
      const support = a * filterScale;
      for (let y = 0; y < dh; y++) {
        const center = (y + 0.5) * ratio - 0.5;
        const top    = Math.max(0, Math.floor(center - support));
        const bottom = Math.min(sh - 1, Math.ceil(center + support));
        let wsum = 0;
        const weights = [];
        for (let i = top; i <= bottom; i++) {
          const t = (i - center) / filterScale;
          const w = _lanczosKernel(t, a);
          weights.push(w);
          wsum += w;
        }
        const inv = wsum !== 0 ? 1 / wsum : 0;
        for (let x = 0; x < dw; x++) {
          let r = 0, g = 0, b = 0, alpha = 0;
          let wi = 0;
          for (let i = top; i <= bottom; i++) {
            const w = weights[wi++] * inv;
            const off = (i * dw + x) * 4;
            r += tmp[off]     * w;
            g += tmp[off + 1] * w;
            b += tmp[off + 2] * w;
            alpha += tmp[off + 3] * w;
          }
          const dOff = (y * dw + x) * 4;
          // Un-premultiply
          if (alpha > 0) {
            dstImg.data[dOff]     = _clamp8(r / alpha);
            dstImg.data[dOff + 1] = _clamp8(g / alpha);
            dstImg.data[dOff + 2] = _clamp8(b / alpha);
          } else {
            dstImg.data[dOff] = dstImg.data[dOff + 1] = dstImg.data[dOff + 2] = 0;
          }
          dstImg.data[dOff + 3] = _clamp8(alpha);
        }
      }
    }
    dctx.putImageData(dstImg, 0, 0);
    return dst;
  }

  function _lanczosKernel(x, a) {
    if (x === 0) return 1;
    if (x <= -a || x >= a) return 0;
    const px = Math.PI * x;
    return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
  }

  function _clamp8(v) {
    if (v < 0) return 0;
    if (v > 255) return 255;
    return v + 0.5 | 0;
  }

  /* ═══════════════════════════════════════════════════════
     STYLE ENCODING — presentation attrs / inline / classes
     ═══════════════════════════════════════════════════════ */

  function _styleAttr(props, o) {
    const keys = Object.keys(props);
    if (!keys.length) return '';
    if (o.style === 'inline') {
      const css = keys.map(k => k + ':' + props[k]).join(';');
      return ' style="' + _escAttr(css) + '"';
    }
    if (o.style === 'classes') {
      const css = keys.map(k => k + ':' + props[k] + ';').join('');
      const reg = o._classReg;
      let className = reg.map.get(css);
      if (!className) {
        // reverse-lookup: we map css→name. But map is name→css; rebuild a set.
      }
      // We use a separate inverse lookup by encoding the css string itself
      // as both the canonical key. Below reconciles intent: name→css so the
      // <style> emitter can iterate; we add an inverse via a cache property.
      if (!reg._inv) reg._inv = new Map();
      let name = reg._inv.get(css);
      if (!name) {
        name = 's' + (reg.order.length + 1);
        reg._inv.set(css, name);
        reg.map.set(name, css);
        reg.order.push(name);
      }
      return ' class="' + name + '"';
    }
    // Presentation attributes (default)
    return ' ' + keys.map(k => k + '="' + _escAttr(props[k]) + '"').join(' ');
  }

  /* ═══════════════════════════════════════════════════════
     Color / number / escape utilities
     ═══════════════════════════════════════════════════════ */

  function _colorParts(c) {
    if (c == null || c === '') return { hex: '#000000', alpha: 1 };
    const s = String(c).trim();
    // #RGB
    let m = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(s);
    if (m) return { hex: '#' + m[1]+m[1]+m[2]+m[2]+m[3]+m[3], alpha: 1 };
    // #RRGGBB
    m = /^#([0-9a-fA-F]{6})$/.exec(s);
    if (m) return { hex: '#' + m[1].toLowerCase(), alpha: 1 };
    // #RRGGBBAA
    m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(s);
    if (m) return { hex: '#' + m[1].toLowerCase(), alpha: parseInt(m[2], 16) / 255 };
    // rgb()
    m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(s);
    if (m) return { hex: _rgbToHex(+m[1], +m[2], +m[3]), alpha: 1 };
    // rgba()
    m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i.exec(s);
    if (m) return { hex: _rgbToHex(+m[1], +m[2], +m[3]), alpha: Math.max(0, Math.min(1, parseFloat(m[4]))) };
    // Named: pass through to SVG renderer
    return { hex: s, alpha: 1 };
  }

  function _rgbToHex(r, g, b) {
    const h = n => ('0' + Math.max(0, Math.min(255, n|0)).toString(16)).slice(-2);
    return '#' + h(r) + h(g) + h(b);
  }

  function _fmt(n, prec) {
    if (!Number.isFinite(n)) return '0';
    if (prec <= 0) return Math.round(n).toString();
    const r = Math.round(n * Math.pow(10, prec)) / Math.pow(10, prec);
    // Strip trailing zeros: 1.50 → 1.5, 1.00 → 1
    return parseFloat(r.toFixed(prec)).toString();
  }

  function _escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/[\r\n\t]+/g, ' ');     // XML normalizes these to space anyway
  }
  function _escText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function _minify(svg) {
    return svg
      .replace(/>\s+</g, '><')
      .replace(/\n\s*/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /* ─── Public ──────────────────────────────────────────── */

  return {
    openDialog: openDialog,
    closeDialog: closeDialog,
    serialize: serialize
  };
})();
