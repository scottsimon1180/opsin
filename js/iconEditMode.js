"use strict";

/* ══════════════════════════════════════════════════════════════════════
   Opsin — Icon Editor Mode (IEM)
   ══════════════════════════════════════════════════════════════════════

   A Greenfish-Icon-Editor-style multi-size .ico editing mode.

   Activated when the user opens a .ico file and chooses "Edit in Icon
   Mode". Each embedded size becomes an independent IconDoc — own layers,
   own undo/redo timeline, own format flag — presented as a vertical
   strip of thumbnails between the canvas and the existing side panels.

   ── Architecture ──────────────────────────────────────────────────────

   • IconDoc per size. Each size owns its layers[], active index, layer
     id counter, format ('png'|'bmp'), bit depth, and a private History
     engine. Switching sizes = auto-commit floating/transform on the
     outgoing doc, snapshot its globals, restore the incoming doc's
     globals, resize composite/overlay canvases, reassign window.History.

   • Master preservation. The ORIGINAL-LARGEST-AT-IMPORT pixel data is
     captured once into masterCanvas. It is never mutated. Even if the
     user deletes the master row from the panel, masterCanvas survives,
     so "Duplicate and resize master" keeps working.

   • Shared host adapter. All per-doc History engines use the SAME host
     adapter that reads/writes script.js's script-scoped globals
     (layers, canvasW, canvasH, selection, …). Because we swap those
     globals atomically on size-switch, each engine operates on its own
     doc's state without knowing about the others.

   • Zero-dependency. Decoder, encoder, UI, state machine — all here.

   ══════════════════════════════════════════════════════════════════════ */

(function () {

  /* ═══════════════════════════════════════════════════════
     STATE
     ═══════════════════════════════════════════════════════ */

  let active        = false;
  let docs          = [];          // Array<IconDoc>
  let activeIdx     = -1;
  let primaryIdx    = -1;          // The "current" selection (most recently clicked) in a multi-select
  let selectedIdxs  = new Set();   // Current selection of rows (supports multi-select)
  let masterCanvas  = null;        // HTMLCanvasElement — the original largest at import
  let masterMeta    = null;        // {w, h, bpp, format}
  let fileName      = 'icon';      // Base filename for exports (no extension)

  // IEM panel op history (add/delete/duplicate/format-toggle). Separate
  // from per-doc history but shared Ctrl+Z dispatch.
  let opStack  = [];
  let opCursor = -1;

  const FORMAT_PNG = 'png';
  const FORMAT_BMP = 'bmp';

  // Context-menu element (lazy)
  let ctxMenuEl = null;

  // Default engine cached on entry so exit restores it.
  let savedDefaultEngine = null;

  // Snapshot of File-menu label overrides for restoration on exit.
  let savedFileMenuState = null;

  /* ═══════════════════════════════════════════════════════
     SHARED HOST ADAPTER
     All per-doc History engines use this single adapter. The script.js
     globals it reads/writes are swapped on size-switch.
     ═══════════════════════════════════════════════════════ */

  const sharedHost = {
    getLayers:           () => layers,
    getActiveLayerIndex: () => activeLayerIndex,
    getCanvasW:          () => canvasW,
    getCanvasH:          () => canvasH,
    setLayers:           (newLayers, activeIndex) => setHostLayers(newLayers, activeIndex),
    setCanvasSize:       (w, h) => setHostCanvasSize(w, h),
    createLayerCanvas:   () => createBlankLayerCanvas(),
    captureSelection:    () => captureHostSelection(),
    restoreSelection:    (mem) => restoreHostSelection(mem),
    captureGradient:     () => captureHostGradient(),
    restoreGradient:     (mem) => restoreHostGradient(mem),
    afterRestore:        () => afterHostRestore()
  };

  function createDocHistoryEngine() {
    const engine = window.createHistoryEngine();
    engine.init({
      maxBytes: 128 * 1024 * 1024,   // 128 MB per-size cap — ample for icon work
      onUpdate: () => {
        if (window.History === engine && typeof updateHistoryPanel === 'function') {
          updateHistoryPanel();
        }
      },
      host: sharedHost
    });
    return engine;
  }

  /* ═══════════════════════════════════════════════════════
     ICO DECODER
     ═══════════════════════════════════════════════════════ */

  /**
   * Decode a .ico file into an array of entries.
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<Array<{w, h, bpp, format, imageData}>>}
   */
  async function decodeIco(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < 6) throw new Error('File too small to be an ICO');
    const reserved = dv.getUint16(0, true);
    const type     = dv.getUint16(2, true);
    const count    = dv.getUint16(4, true);
    if (reserved !== 0) throw new Error('Invalid ICO: reserved != 0');
    if (type !== 1) throw new Error('Not an ICO (type=' + type + '; CUR files use type=2)');
    if (count === 0) throw new Error('ICO contains no images');
    if (arrayBuffer.byteLength < 6 + count * 16) throw new Error('ICO truncated');

    const results = [];
    for (let i = 0; i < count; i++) {
      const base = 6 + i * 16;
      const widthRaw   = dv.getUint8(base);
      const heightRaw  = dv.getUint8(base + 1);
      const bytesInRes = dv.getUint32(base + 8, true);
      const imageOffset = dv.getUint32(base + 12, true);
      const width  = widthRaw  === 0 ? 256 : widthRaw;
      const height = heightRaw === 0 ? 256 : heightRaw;

      if (imageOffset + bytesInRes > arrayBuffer.byteLength) {
        throw new Error('ICO entry ' + i + ' points past end of file');
      }
      const entryBytes = new Uint8Array(arrayBuffer, imageOffset, bytesInRes);

      // PNG signature
      if (entryBytes.length >= 8 &&
          entryBytes[0] === 0x89 && entryBytes[1] === 0x50 &&
          entryBytes[2] === 0x4E && entryBytes[3] === 0x47 &&
          entryBytes[4] === 0x0D && entryBytes[5] === 0x0A &&
          entryBytes[6] === 0x1A && entryBytes[7] === 0x0A) {
        const pngResult = await decodePngEntry(entryBytes);
        results.push({
          w: pngResult.w,
          h: pngResult.h,
          bpp: pngResult.bpp,
          format: FORMAT_PNG,
          imageData: pngResult.imageData
        });
      } else {
        const bmpResult = decodeBmpEntry(entryBytes, width, height);
        results.push({
          w: bmpResult.w,
          h: bmpResult.h,
          bpp: bmpResult.bpp,
          format: FORMAT_BMP,
          imageData: bmpResult.imageData
        });
      }
    }
    return results;
  }

  function decodePngEntry(bytes) {
    return new Promise((resolve, reject) => {
      const blob = new Blob([bytes], { type: 'image/png' });
      const url  = URL.createObjectURL(blob);
      const img  = new Image();
      img.onload = function () {
        try {
          const c = document.createElement('canvas');
          c.width  = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const imageData = ctx.getImageData(0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve({
            w: img.naturalWidth,
            h: img.naturalHeight,
            bpp: detectPngBpp(bytes),
            imageData: imageData
          });
        } catch (err) { URL.revokeObjectURL(url); reject(err); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('PNG decode failed')); };
      img.src = url;
    });
  }

  function detectPngBpp(bytes) {
    if (bytes.length < 26) return 32;
    const bitDepth  = bytes[24];
    const colorType = bytes[25];
    let samples;
    switch (colorType) {
      case 0: samples = 1; break;   // grayscale
      case 2: samples = 3; break;   // RGB
      case 3: samples = 1; break;   // palette index
      case 4: samples = 2; break;   // gray + alpha
      case 6: samples = 4; break;   // RGBA
      default: samples = 4;
    }
    return bitDepth * samples;
  }

  function decodeBmpEntry(bytes, declaredW, declaredH) {
    if (bytes.length < 40) throw new Error('BMP DIB too small');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize  = dv.getUint32(0, true);
    if (headerSize < 40) throw new Error('BMP header < 40 bytes');
    const biWidth     = dv.getInt32(4, true);
    const biHeight    = dv.getInt32(8, true);   // In ICO: 2 × actual height (xor + and mask)
    const biBitCount  = dv.getUint16(14, true);
    const biCompression = dv.getUint32(16, true);
    if (biCompression !== 0 && biCompression !== 3) {
      throw new Error('BMP compression ' + biCompression + ' not supported');
    }

    const w = biWidth || declaredW;
    const h = Math.floor(biHeight / 2) || declaredH;

    // Palette for <= 8 bpp (4 bytes per entry, BGR0)
    let palette = null;
    let palEntries = 0;
    const paletteOffset = headerSize;
    let pixelOffset = paletteOffset;
    if (biBitCount <= 8) {
      palEntries = 1 << biBitCount;   // 2, 16, or 256
      palette = new Array(palEntries);
      for (let i = 0; i < palEntries; i++) {
        const o = paletteOffset + i * 4;
        palette[i] = {
          b: bytes[o],
          g: bytes[o + 1],
          r: bytes[o + 2]
        };
      }
      pixelOffset += palEntries * 4;
    }

    const xorStride = ((biBitCount * w + 31) >>> 5) << 2;
    const xorSize   = xorStride * h;
    const andStride = ((w + 31) >>> 5) << 2;
    const andOffset = pixelOffset + xorSize;

    // If 32-bit BMP, check whether alpha is all-zero (pathological) — fall back to AND mask
    let use32bitAlpha = true;
    if (biBitCount === 32) {
      let allZero = true;
      for (let y = 0; y < h && allZero; y++) {
        const rowOffset = pixelOffset + y * xorStride;
        for (let x = 0; x < w; x++) {
          if (bytes[rowOffset + x * 4 + 3] !== 0) { allZero = false; break; }
        }
      }
      if (allZero) use32bitAlpha = false;
    }

    const imgData = new ImageData(w, h);
    const data = imgData.data;

    for (let y = 0; y < h; y++) {
      const srcY = h - 1 - y;   // BMP is bottom-up
      const rowOffset    = pixelOffset + srcY * xorStride;
      const andRowOffset = andOffset   + srcY * andStride;

      for (let x = 0; x < w; x++) {
        const dstIdx = (y * w + x) * 4;
        let r = 0, g = 0, b = 0, a = 255;

        switch (biBitCount) {
          case 1: {
            const bo  = rowOffset + (x >> 3);
            const bit = 7 - (x & 7);
            const idx = (bytes[bo] >> bit) & 1;
            const p = palette[idx]; r = p.r; g = p.g; b = p.b;
            break;
          }
          case 4: {
            const bo  = rowOffset + (x >> 1);
            const idx = (x & 1) === 0 ? (bytes[bo] >> 4) : (bytes[bo] & 0x0F);
            const p = palette[idx]; r = p.r; g = p.g; b = p.b;
            break;
          }
          case 8: {
            const idx = bytes[rowOffset + x];
            const p = palette[idx]; r = p.r; g = p.g; b = p.b;
            break;
          }
          case 24: {
            const o = rowOffset + x * 3;
            b = bytes[o]; g = bytes[o + 1]; r = bytes[o + 2];
            break;
          }
          case 32: {
            const o = rowOffset + x * 4;
            b = bytes[o]; g = bytes[o + 1]; r = bytes[o + 2];
            a = use32bitAlpha ? bytes[o + 3] : 255;
            break;
          }
          default:
            r = g = b = 0;
        }

        // Apply AND mask for <32-bit and for 32-bit-with-zero-alpha case
        if (biBitCount !== 32 || !use32bitAlpha) {
          const bo  = andRowOffset + (x >> 3);
          const bit = 7 - (x & 7);
          const mask = (bytes[bo] >> bit) & 1;
          a = mask === 1 ? 0 : 255;
        }

        data[dstIdx]     = r;
        data[dstIdx + 1] = g;
        data[dstIdx + 2] = b;
        data[dstIdx + 3] = a;
      }
    }

    return { w: w, h: h, bpp: biBitCount, imageData: imgData };
  }

  /* ═══════════════════════════════════════════════════════
     ICO ENCODER (multi-size)
     Reuses script.js's encodeIcoDIB() for BMP entries and
     canvas.toBlob('image/png') for PNG entries.
     ═══════════════════════════════════════════════════════ */

  async function encodeIcoProject() {
    if (docs.length === 0) throw new Error('No sizes to export');

    // Flatten each doc to its composite canvas
    const entries = [];
    for (const d of docs) {
      const comp = flattenDocToCanvas(d);
      if (d.format === FORMAT_PNG) {
        const blob = await new Promise(res => comp.toBlob(res, 'image/png'));
        const buf = await blob.arrayBuffer();
        entries.push({ size: d.size, data: new Uint8Array(buf), format: FORMAT_PNG });
      } else {
        const imgData = comp.getContext('2d').getImageData(0, 0, d.size, d.size);
        const dib = window.encodeIcoDIB(imgData, d.size);
        entries.push({ size: d.size, data: dib, format: FORMAT_BMP });
      }
    }

    // Sort entries descending by size to match common ICO ordering
    entries.sort((a, b) => b.size - a.size);

    // Build ICONDIR (6) + ICONDIRENTRY[] (16×N) + image data
    const dirSize     = 6 + entries.length * 16;
    let totalBytes    = dirSize;
    for (const e of entries) totalBytes += e.data.length;

    const out = new Uint8Array(totalBytes);
    const ov  = new DataView(out.buffer);
    // ICONDIR
    ov.setUint16(0, 0, true);              // reserved
    ov.setUint16(2, 1, true);              // type = ICO
    ov.setUint16(4, entries.length, true); // count

    let dataOffset = dirSize;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const base = 6 + i * 16;
      const dim = e.size >= 256 ? 0 : e.size;   // 256 encodes as 0
      out[base]     = dim;                       // width
      out[base + 1] = dim;                       // height
      out[base + 2] = 0;                         // color count
      out[base + 3] = 0;                         // reserved
      ov.setUint16(base + 4, 1,  true);          // planes
      ov.setUint16(base + 6, 32, true);          // bit count (always 32 for IEM exports)
      ov.setUint32(base + 8, e.data.length, true);
      ov.setUint32(base + 12, dataOffset, true);
      out.set(e.data, dataOffset);
      dataOffset += e.data.length;
    }
    return new Blob([out], { type: 'image/x-icon' });
  }

  function flattenDocToCanvas(doc) {
    const c = document.createElement('canvas');
    c.width  = doc.size;
    c.height = doc.size;
    const ctx = c.getContext('2d');
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (!l.visible) continue;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(l.canvas, 0, 0);
    }
    ctx.globalAlpha = 1;
    return c;
  }

  /* ═══════════════════════════════════════════════════════
     IconDoc — per-size document container
     ═══════════════════════════════════════════════════════ */

  let _nextDocId = 1;

  function makeDoc(size, bpp, format, isMaster, imageData /* or null for blank */) {
    const doc = {
      id: _nextDocId++,
      size: size,
      bpp: bpp || 32,
      format: format || (size >= 256 ? FORMAT_PNG : FORMAT_BMP),
      isMaster: !!isMaster,
      pristine: true,

      // Layer state (starts with one "Background" layer containing imageData or blank)
      layers: [],
      activeLayerIndex: 0,
      selectedLayers: new Set([0]),
      layerIdCounter: 1,

      // Per-doc history engine (filled below after init)
      history: null
    };

    // Build the background layer
    const c = document.createElement('canvas');
    c.width  = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (imageData) ctx.putImageData(imageData, 0, 0);
    doc.layers.push({
      id: 1,
      name: 'Background',
      canvas: c,
      ctx: ctx,
      visible: true,
      opacity: 1
    });

    // Create the doc's history engine + seed initial entry so the user
    // can undo all the way back to the as-imported state for every size.
    doc.history = createDocHistoryEngine();
    seedDocInitialHistory(doc, 'Open Size');

    return doc;
  }

  /**
   * Records an initial history entry on a doc by temporarily swapping
   * window.History and the script.js layer/canvas globals so the engine's
   * shared host adapter sees the doc's state. Restores everything after.
   */
  function seedDocInitialHistory(doc, label) {
    if (!doc || !doc.history) return;
    const prevH    = window.History;
    const prevL    = layers;
    const prevAL   = activeLayerIndex;
    const prevSL   = selectedLayers;
    const prevLC   = layerIdCounter;
    const prevW    = canvasW;
    const prevH2   = canvasH;
    try {
      layers           = doc.layers;
      activeLayerIndex = doc.activeLayerIndex;
      selectedLayers   = new Set(doc.selectedLayers);
      layerIdCounter   = doc.layerIdCounter;
      canvasW          = doc.size;
      canvasH          = doc.size;
      window.History   = doc.history;
      doc.history.record(label || 'Open Size', 'menu-refresh', 'init');
    } finally {
      window.History    = prevH;
      layers            = prevL;
      activeLayerIndex  = prevAL;
      selectedLayers    = prevSL;
      layerIdCounter    = prevLC;
      canvasW           = prevW;
      canvasH           = prevH2;
    }
  }

  // Snapshot globals → doc
  function snapshotGlobalsIntoDoc(doc) {
    doc.layers           = layers;
    doc.activeLayerIndex = activeLayerIndex;
    doc.selectedLayers   = new Set(selectedLayers);
    doc.layerIdCounter   = layerIdCounter;
  }

  // Restore doc → globals. Does NOT touch selection / floating /
  // pxTransform / gradient — caller is expected to wipe those.
  function restoreDocIntoGlobals(doc) {
    layers             = doc.layers;
    activeLayerIndex   = doc.activeLayerIndex;
    selectedLayers     = new Set(doc.selectedLayers);
    layerIdCounter     = doc.layerIdCounter;
  }

  // Wipe all selection / floating / pxTransform / gradient state.
  function wipeTransientCanvasState() {
    selection = null;
    selectionPath = null;
    if (selectionMask && selectionMaskCtx) {
      selectionMaskCtx.clearRect(0, 0, selectionMask.width, selectionMask.height);
    }
    selectionMask = null;
    selectionMaskCtx = null;
    selectionFillRule = 'nonzero';
    selectionMode = 'new';
    polyPoints = [];
    lassoPoints = [];
    if (typeof resetMagneticState === 'function') resetMagneticState();

    floatingActive = false;
    floatingCanvas = null;
    floatingCtx = null;
    floatingOffset = { x: 0, y: 0 };
    floatingSelectionData = null;

    pxTransformActive = false;
    pxTransformData = null;
    pxTransformHandle = null;
    pxTransformStartMouse = null;
    pxTransformOrigBounds = null;
    transformSelActive = false;

    gradActive = false;
    gradP1 = null;
    gradP2 = null;
    gradStops = [];
    gradDragging = null;
    gradBaseSnapshot = null;
    if (typeof hideGradStopCtx === 'function') hideGradStopCtx();
  }

  /* ═══════════════════════════════════════════════════════
     MODE LIFECYCLE
     ═══════════════════════════════════════════════════════ */

  async function handleOpenIco(file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const decoded = await decodeIco(buf);
      fileName = (file.name || 'icon').replace(/\.[^.]+$/, '');
      openChoiceModal(decoded, fileName);
    } catch (err) {
      alert('Failed to open ICO: ' + (err && err.message ? err.message : err));
    }
  }

  // Open the "Import as PNG" vs "Edit in Icon Mode" modal
  function openChoiceModal(decoded, baseName) {
    const modal = document.getElementById('iemOpenChoiceModal');
    if (!modal) return;
    // Stash decoded entries on the modal for handlers
    modal._decoded = decoded;
    modal._fileName = baseName;
    modal.classList.add('show');
    modal.removeAttribute('hidden');
    // Populate preview info
    const info = document.getElementById('iemChoiceInfo');
    if (info) {
      const sizes = decoded.map(d => `${d.w}×${d.h}`).join(', ');
      info.textContent = `${baseName}.ico — ${decoded.length} size${decoded.length === 1 ? '' : 's'}: ${sizes}`;
    }
  }

  function closeChoiceModal() {
    const modal = document.getElementById('iemOpenChoiceModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('hidden', '');
    modal._decoded = null;
    modal._fileName = null;
  }

  function choosePngImport() {
    const modal = document.getElementById('iemOpenChoiceModal');
    if (!modal || !modal._decoded) return;
    const decoded = modal._decoded;
    const baseName = modal._fileName;
    closeChoiceModal();

    // Largest entry (descending by area)
    const largest = decoded.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
    // Route through the normal init path
    initCanvas(largest.w, largest.h, 'transparent');
    layers[0].ctx.putImageData(largest.imageData, 0, 0);
    layers[0].name = baseName || 'Icon';
    compositeAll();
    updateLayerPanel();
    if (typeof History !== 'undefined' && History) History.reset();
    pushUndo('Open ICO as PNG');
  }

  function chooseIconMode() {
    const modal = document.getElementById('iemOpenChoiceModal');
    if (!modal || !modal._decoded) return;
    const decoded = modal._decoded;
    const baseName = modal._fileName;
    closeChoiceModal();
    enter(decoded, baseName);
  }

  function enter(decoded, baseName) {
    if (active) exit();
    active = true;
    fileName = baseName || 'icon';

    // Find the master (largest by area) and cache its pixel data
    const largest = decoded.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
    masterMeta = { w: largest.w, h: largest.h, bpp: largest.bpp, format: largest.format };
    masterCanvas = document.createElement('canvas');
    masterCanvas.width  = largest.w;
    masterCanvas.height = largest.h;
    masterCanvas.getContext('2d', { willReadFrequently: true }).putImageData(largest.imageData, 0, 0);

    // Build docs (descending size order)
    const entries = decoded.slice().sort((a, b) => b.w - a.w || b.h - a.h);
    docs = entries.map(e => {
      const isMaster = (e.w === largest.w && e.h === largest.h);
      return makeDoc(e.w, e.bpp, e.format, isMaster, e.imageData);
    });

    // Cache default engine for exit restore
    savedDefaultEngine = window.History;

    // Activate the master doc (index 0)
    activeIdx = 0;
    primaryIdx = 0;
    selectedIdxs = new Set([0]);

    // Fully reset the default engine so returning to non-IEM mode starts fresh
    if (savedDefaultEngine && savedDefaultEngine.reset) savedDefaultEngine.reset();

    // Activate: swap in the master doc's state
    activateDocAtIndex(0, /*fresh*/ true);

    // UI
    document.body.setAttribute('data-iem', 'active');
    const panel = document.getElementById('iconSizesPanel');
    if (panel) { panel.hidden = false; panel.classList.add('show'); }
    renderPanel();
    mountBanner();
    saveAndApplyFileMenuState();

    // Re-fit since the workspace width shrunk by the panel width
    if (typeof zoomFit === 'function') zoomFit();
    if (typeof centerCanvas === 'function') centerCanvas();

    // Initial per-doc history entries were already seeded by makeDoc(),
    // so window.History (= docs[0].history) already has its anchor entry.
    // Reset op stack for a fresh IEM session.
    opStack = [];
    opCursor = -1;
  }

  function commitTransients() {
    if (floatingActive && typeof commitFloating === 'function') commitFloating();
    if (pxTransformActive && typeof commitPixelTransform === 'function') commitPixelTransform();
    if (gradActive && typeof commitGradient === 'function') commitGradient();
  }

  function exit() {
    if (!active) return;
    commitTransients();

    active = false;
    // Dispose every per-doc history engine BEFORE dropping the array so
    // the tile store memory is freed eagerly (tile dedup keeps refs alive
    // otherwise — could spike on rapid open/close cycles of large icons).
    for (const d of docs) {
      if (d && d.history && d.history.reset) {
        try { d.history.reset(); } catch (e) { /* ignore */ }
      }
    }
    docs = [];
    activeIdx = -1;
    primaryIdx = -1;
    selectedIdxs = new Set();
    masterCanvas = null;
    masterMeta = null;
    opStack = [];
    opCursor = -1;

    // Restore default History engine
    if (savedDefaultEngine) {
      window.History = savedDefaultEngine;
    }
    savedDefaultEngine = null;

    // UI teardown
    document.body.removeAttribute('data-iem');
    const panel = document.getElementById('iconSizesPanel');
    if (panel) { panel.hidden = true; panel.classList.remove('show'); panel.innerHTML = ''; }
    unmountBanner();
    restoreFileMenuState();
    hideContextMenu();

    // initCanvas (called by New/Open) will already refresh the viewport; if
    // exit is called standalone, also run a zoomFit for safety.
    if (typeof zoomFit === 'function') zoomFit();
  }

  function exitIfActive() {
    if (active) exit();
  }

  /* ═══════════════════════════════════════════════════════
     SIZE SWITCHING
     ═══════════════════════════════════════════════════════ */

  function switchTo(index, modifiers) {
    modifiers = modifiers || {};
    if (index < 0 || index >= docs.length) return;

    // Update selection set (multi-select handled here)
    if (modifiers.shift && primaryIdx >= 0) {
      const lo = Math.min(primaryIdx, index);
      const hi = Math.max(primaryIdx, index);
      selectedIdxs = new Set();
      for (let i = lo; i <= hi; i++) selectedIdxs.add(i);
    } else if (modifiers.ctrl) {
      if (selectedIdxs.has(index)) selectedIdxs.delete(index);
      else selectedIdxs.add(index);
    } else {
      selectedIdxs = new Set([index]);
    }
    primaryIdx = index;

    // If the primary is different from the current active, do the heavy swap
    if (index !== activeIdx) {
      activateDocAtIndex(index, /*fresh*/ false);
    }
    renderPanel();
  }

  function activateDocAtIndex(index, fresh) {
    if (index < 0 || index >= docs.length) return;

    // Step 1: commit transient state on outgoing doc
    if (!fresh && activeIdx >= 0 && activeIdx < docs.length) {
      commitTransients();
      // Snapshot outgoing globals into outgoing doc
      snapshotGlobalsIntoDoc(docs[activeIdx]);
    }

    // Step 2: wipe transient state (selection, floating, transform, gradient)
    wipeTransientCanvasState();

    // Step 3: restore incoming globals
    const incoming = docs[index];
    restoreDocIntoGlobals(incoming);

    // Step 4: resize composite/overlay/wrapper
    setHostCanvasSize(incoming.size, incoming.size);

    // Step 5: swap History engine
    window.History = incoming.history;

    // Step 6: refresh UI
    activeIdx = index;
    if (typeof compositeAll === 'function') compositeAll();
    if (typeof updateLayerPanel === 'function') updateLayerPanel();
    if (typeof drawOverlay === 'function') drawOverlay();
    if (typeof updateStatus === 'function') updateStatus();
    if (typeof zoomFit === 'function') zoomFit();
    if (typeof updateHistoryPanel === 'function') updateHistoryPanel();

    // Invalidate snap caches since the document changed
    if (typeof SnapEngine !== 'undefined' && SnapEngine && SnapEngine.invalidateAllLayers) {
      SnapEngine.invalidateAllLayers();
    }
  }

  /* ═══════════════════════════════════════════════════════
     ICON SIZES PANEL RENDERING
     ═══════════════════════════════════════════════════════ */

  function renderPanel() {
    const panel = document.getElementById('iconSizesPanel');
    if (!panel) return;

    // Build DOM: header, list, toolbar
    panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'iem-panel-header';
    header.innerHTML = '<span class="iem-panel-title">Icon Sizes</span><span class="iem-panel-count">' + docs.length + '</span>';
    panel.appendChild(header);

    const list = document.createElement('div');
    list.className = 'iem-size-list';
    panel.appendChild(list);

    // Ensure docs are sorted descending by size for display
    // (We keep docs array sorted at all times; renderPanel trusts that)
    for (let i = 0; i < docs.length; i++) {
      list.appendChild(renderRow(docs[i], i));
    }

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'iem-size-toolbar';
    toolbar.innerHTML =
      '<button class="iem-tb-btn" id="iemBtnAdd" title="Add Size"><svg><use href="#icon-layer-add"/></svg></button>' +
      '<button class="iem-tb-btn" id="iemBtnDuplicate" title="Duplicate Size"><svg><use href="#icon-duplicate-layer"/></svg></button>' +
      '<button class="iem-tb-btn iem-tb-btn-danger" id="iemBtnDelete" title="Delete Size"><svg><use href="#icon-layer-delete"/></svg></button>';
    panel.appendChild(toolbar);

    document.getElementById('iemBtnAdd').addEventListener('click', openAddSizeModal);
    document.getElementById('iemBtnDuplicate').addEventListener('click', duplicateSelectedSizes);
    document.getElementById('iemBtnDelete').addEventListener('click', deleteSelectedSizes);
  }

  function renderRow(doc, idx) {
    const row = document.createElement('div');
    row.className = 'iem-size-row';
    if (selectedIdxs.has(idx)) row.classList.add('selected');
    if (idx === primaryIdx) row.classList.add('primary');

    // Thumbnail (true-size up to 256; capped at 256 for larger)
    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'iem-size-thumb-wrap';
    const thumbSize = Math.min(doc.size, 256);
    thumbWrap.style.width  = thumbSize + 'px';
    thumbWrap.style.height = thumbSize + 'px';

    const thumb = document.createElement('canvas');
    thumb.className = 'iem-size-thumb';
    thumb.width  = thumbSize;
    thumb.height = thumbSize;
    const tctx = thumb.getContext('2d');
    // Paint flattened composite
    if (doc === docs[activeIdx]) {
      // Use live composite canvas for the current size
      tctx.drawImage(compositeCanvas, 0, 0, thumbSize, thumbSize);
    } else {
      // Composite this doc's layers at thumbSize
      if (doc.size <= 256) {
        for (let i = doc.layers.length - 1; i >= 0; i--) {
          const l = doc.layers[i];
          if (!l.visible) continue;
          tctx.globalAlpha = l.opacity;
          tctx.drawImage(l.canvas, 0, 0);
        }
        tctx.globalAlpha = 1;
      } else {
        // Larger than 256, downscale to 256
        const tmp = document.createElement('canvas');
        tmp.width = doc.size; tmp.height = doc.size;
        const ttctx = tmp.getContext('2d');
        for (let i = doc.layers.length - 1; i >= 0; i--) {
          const l = doc.layers[i];
          if (!l.visible) continue;
          ttctx.globalAlpha = l.opacity;
          ttctx.drawImage(l.canvas, 0, 0);
        }
        ttctx.globalAlpha = 1;
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = 'high';
        tctx.drawImage(tmp, 0, 0, 256, 256);
      }
    }
    thumbWrap.appendChild(thumb);

    // Meta column
    const meta = document.createElement('div');
    meta.className = 'iem-size-meta';

    const labelLine = document.createElement('div');
    labelLine.className = 'iem-size-label-line';
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'iem-size-label';
    sizeLabel.textContent = doc.size + ' × ' + doc.size;
    labelLine.appendChild(sizeLabel);
    if (doc.isMaster) {
      const hq = document.createElement('span');
      hq.className = 'iem-hq-pill';
      hq.textContent = 'HQ';
      hq.title = 'Master — original-largest source at import';
      labelLine.appendChild(hq);
    }
    meta.appendChild(labelLine);

    const bppLine = document.createElement('div');
    bppLine.className = 'iem-size-bpp';
    bppLine.textContent = doc.bpp + '-bit';
    meta.appendChild(bppLine);

    const fmtPill = document.createElement('span');
    fmtPill.className = 'iem-fmt-pill ' + doc.format;
    fmtPill.textContent = doc.format.toUpperCase();
    fmtPill.title = 'Click to toggle PNG/BMP encoding';
    fmtPill.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDocFormat(idx);
    });
    meta.appendChild(fmtPill);

    row.appendChild(thumbWrap);
    row.appendChild(meta);

    // Click / multi-select / context menu handlers
    row.addEventListener('click', (e) => {
      switchTo(idx, { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // If not already selected, single-select this row
      if (!selectedIdxs.has(idx)) {
        switchTo(idx, {});
      }
      showContextMenu(e.clientX, e.clientY);
    });

    return row;
  }

  function refreshActiveRowThumb() {
    if (!active || activeIdx < 0) return;
    const panel = document.getElementById('iconSizesPanel');
    if (!panel) return;
    const rows = panel.querySelectorAll('.iem-size-row');
    const row = rows[activeIdx];
    if (!row) { renderPanel(); return; }
    const thumb = row.querySelector('.iem-size-thumb');
    if (!thumb) { renderPanel(); return; }
    const doc = docs[activeIdx];
    const thumbSize = Math.min(doc.size, 256);
    thumb.width = thumbSize;
    thumb.height = thumbSize;
    const tctx = thumb.getContext('2d');
    tctx.clearRect(0, 0, thumbSize, thumbSize);
    tctx.drawImage(compositeCanvas, 0, 0, thumbSize, thumbSize);
  }

  /* ═══════════════════════════════════════════════════════
     FORMAT TOGGLE
     ═══════════════════════════════════════════════════════ */

  function toggleDocFormat(idx) {
    if (idx < 0 || idx >= docs.length) return;
    const doc = docs[idx];
    const prev = doc.format;
    doc.format = prev === FORMAT_PNG ? FORMAT_BMP : FORMAT_PNG;
    pushOp({
      type: 'format',
      docId: doc.id,
      prev: prev,
      next: doc.format
    });
    renderPanel();
  }

  /* ═══════════════════════════════════════════════════════
     ADD / DELETE / DUPLICATE
     ═══════════════════════════════════════════════════════ */

  function addDocSorted(doc) {
    // Insert doc into docs[] maintaining descending size order.
    // If duplicates of the same size exist, new doc goes immediately BELOW the last one of that size.
    let insertAt = docs.length;
    for (let i = 0; i < docs.length; i++) {
      if (docs[i].size < doc.size) { insertAt = i; break; }
    }
    docs.splice(insertAt, 0, doc);
    // When inserting before activeIdx, bump it
    if (insertAt <= activeIdx) activeIdx++;
    if (insertAt <= primaryIdx) primaryIdx++;
    // Bump selectedIdxs
    const bumped = new Set();
    for (const s of selectedIdxs) bumped.add(s >= insertAt ? s + 1 : s);
    selectedIdxs = bumped;
    return insertAt;
  }

  function removeDocAt(idx) {
    if (idx < 0 || idx >= docs.length) return null;
    // Dispose the doc's history engine memory
    const doc = docs[idx];
    if (doc.history && doc.history.reset) doc.history.reset();
    docs.splice(idx, 1);
    if (activeIdx > idx) activeIdx--;
    else if (activeIdx === idx) activeIdx = -1;
    if (primaryIdx > idx) primaryIdx--;
    else if (primaryIdx === idx) primaryIdx = -1;
    // Rebuild selectedIdxs with shifting
    const shifted = new Set();
    for (const s of selectedIdxs) {
      if (s === idx) continue;
      shifted.add(s > idx ? s - 1 : s);
    }
    selectedIdxs = shifted;
    return doc;
  }

  function duplicateSelectedSizes() {
    if (selectedIdxs.size === 0) return;
    // Operate on a sorted copy so insertion positions remain stable
    const sorted = Array.from(selectedIdxs).sort((a, b) => b - a);
    const insertedIds = [];
    for (const srcIdx of sorted) {
      const src = docs[srcIdx];
      if (!src) continue;
      const clone = cloneDoc(src);
      addDocSorted(clone);
      insertedIds.push(clone.id);
    }
    pushOp({ type: 'duplicate', ids: insertedIds });
    renderPanel();
  }

  function cloneDoc(src) {
    // Deep clone: own canvases, own layers[], own history engine
    const c = document.createElement('canvas');
    c.width = src.size;
    c.height = src.size;
    const flat = flattenDocToCanvas(src);
    c.getContext('2d').drawImage(flat, 0, 0);
    const dup = {
      id: _nextDocId++,
      size: src.size,
      bpp: src.bpp,
      format: src.format,
      isMaster: false,  // duplicates are never the master
      pristine: src.pristine,
      layers: [{
        id: 1,
        name: 'Background',
        canvas: c,
        ctx: c.getContext('2d', { willReadFrequently: true }),
        visible: true,
        opacity: 1
      }],
      activeLayerIndex: 0,
      selectedLayers: new Set([0]),
      layerIdCounter: 2,
      history: createDocHistoryEngine()
    };
    seedDocInitialHistory(dup, 'Duplicate Size');
    return dup;
  }

  function deleteSelectedSizes() {
    if (selectedIdxs.size === 0) return;
    if (docs.length - selectedIdxs.size < 1) {
      alert('Cannot delete the last remaining size.');
      return;
    }
    // Capture for undo BEFORE removing
    const sorted = Array.from(selectedIdxs).sort((a, b) => b - a);   // desc so indexes stay valid
    const removed = [];
    // Switch away from any index we're about to delete
    if (sorted.includes(activeIdx)) {
      // Pick a replacement: first non-deleted index
      const keep = [];
      for (let i = 0; i < docs.length; i++) if (!selectedIdxs.has(i)) keep.push(i);
      if (keep.length > 0) {
        activateDocAtIndex(keep[0], /*fresh*/ false);
      }
    }
    for (const idx of sorted) {
      const d = removeDocAt(idx);
      if (d) removed.unshift({ idx: idx, doc: d });
    }
    pushOp({ type: 'delete', removed: removed });
    // If no primary, select the new top
    if (primaryIdx < 0 && docs.length > 0) {
      primaryIdx = 0;
      selectedIdxs = new Set([0]);
      activateDocAtIndex(0, /*fresh*/ false);
    }
    renderPanel();
  }

  /* ═══════════════════════════════════════════════════════
     ADD SIZE MODAL
     ═══════════════════════════════════════════════════════ */

  function openAddSizeModal() {
    const modal = document.getElementById('iemAddSizeModal');
    if (!modal) return;
    modal.classList.add('show');
    modal.removeAttribute('hidden');
    const input = document.getElementById('iemAddSizeInput');
    const err   = document.getElementById('iemAddSizeError');
    if (input) { input.value = '32'; input.focus(); input.select(); }
    if (err) err.textContent = '';
    // Default radio: duplicate-master if master is still available, else blank
    const radioMaster = document.getElementById('iemRadioMaster');
    const radioBlank  = document.getElementById('iemRadioBlank');
    if (masterCanvas) { radioMaster.checked = true; radioMaster.disabled = false; }
    else              { radioBlank.checked  = true; radioMaster.disabled = true;  }
  }

  function closeAddSizeModal() {
    const modal = document.getElementById('iemAddSizeModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('hidden', '');
  }

  function confirmAddSize() {
    const input = document.getElementById('iemAddSizeInput');
    const err   = document.getElementById('iemAddSizeError');
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 1 || val > 2048) {
      err.textContent = 'Enter a size from 1 to 512.';
      return;
    }
    try {
      _confirmAddSizeImpl(val);
    } catch (e) {
      console.error('[IEM] Add Size failed:', e);
      err.textContent = 'Add failed: ' + (e && e.message ? e.message : e);
    }
  }

  function _confirmAddSizeImpl(val) {
    const err = document.getElementById('iemAddSizeError');
    const useMaster = document.getElementById('iemRadioMaster').checked && masterCanvas;

    // Check if size already exists
    const existingIdx = docs.findIndex(d => d.size === val);
    let newImgData = null;
    let newBpp = 32;
    let newFormat = val >= 256 ? FORMAT_PNG : FORMAT_BMP;

    if (useMaster) {
      if (existingIdx >= 0 && docs[existingIdx].pristine && docs[existingIdx].size === val) {
        // Cheap clone: the existing is still a master-resample, just clone it
        const existing = docs[existingIdx];
        const flat = flattenDocToCanvas(existing);
        const c = document.createElement('canvas'); c.width = val; c.height = val;
        c.getContext('2d', { willReadFrequently: true }).drawImage(flat, 0, 0);
        newImgData = c.getContext('2d').getImageData(0, 0, val, val);
      } else {
        // Fresh resample of master via Lanczos-3 (returns an ImageData directly)
        const masterData = masterCanvas.getContext('2d').getImageData(0, 0, masterCanvas.width, masterCanvas.height);
        newImgData = window.lanczos3Resample
          ? window.lanczos3Resample(masterData, masterCanvas.width, masterCanvas.height, val, val)
          : fallbackResample(masterData, masterCanvas.width, masterCanvas.height, val, val);
      }
    }
    // else: blank canvas — leave newImgData null

    const doc = makeDoc(val, newBpp, newFormat, false, newImgData);
    const insertedAt = addDocSorted(doc);
    pushOp({ type: 'add', id: doc.id });
    // Switch to the newly added size
    primaryIdx = insertedAt;
    selectedIdxs = new Set([insertedAt]);
    activateDocAtIndex(insertedAt, /*fresh*/ false);
    renderPanel();
    closeAddSizeModal();
  }

  function fallbackResample(imgData, srcW, srcH, dstW, dstH) {
    // Fallback if lanczos3Resample isn't available — use canvas high-quality smoothing
    const src = document.createElement('canvas'); src.width = srcW; src.height = srcH;
    src.getContext('2d').putImageData(imgData, 0, 0);
    const dst = document.createElement('canvas'); dst.width = dstW; dst.height = dstH;
    const ctx = dst.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0, dstW, dstH);
    return ctx.getImageData(0, 0, dstW, dstH);
  }

  /* ═══════════════════════════════════════════════════════
     BANNER (menubar)
     ═══════════════════════════════════════════════════════ */

  function mountBanner() {
    const banner = document.getElementById('iemBanner');
    if (!banner) return;
    banner.hidden = false;
    banner.style.display = '';
    layoutBanner();
    window.addEventListener('resize', layoutBanner);
  }

  function unmountBanner() {
    const banner = document.getElementById('iemBanner');
    if (!banner) return;
    banner.hidden = true;
    banner.style.display = 'none';
    window.removeEventListener('resize', layoutBanner);
  }

  function layoutBanner() {
    const banner = document.getElementById('iemBanner');
    if (!banner || !active) return;
    const menubar = banner.parentElement;
    if (!menubar) return;

    // Measure rightmost menu button and left-edge of version
    const menuItems = menubar.querySelectorAll('.menu-item, .menu-item-action');
    let menuRight = 0;
    for (const m of menuItems) {
      const r = m.getBoundingClientRect();
      if (r.right > menuRight) menuRight = r.right;
    }
    const versionEl = document.getElementById('statusVersion');
    const versionLeft = versionEl ? versionEl.getBoundingClientRect().left : window.innerWidth;
    const barRect = menubar.getBoundingClientRect();
    const gap = 24;
    const bannerW = banner.offsetWidth || 170;

    // Default: centered in menubar
    let left = (barRect.width - bannerW) / 2;

    // If centered would overlap menus, shift right
    if (left < menuRight - barRect.left + gap) {
      left = menuRight - barRect.left + gap;
    }
    // If shifting right would overlap version, hide
    if (left + bannerW > versionLeft - barRect.left - gap) {
      banner.style.visibility = 'hidden';
      return;
    } else {
      banner.style.visibility = 'visible';
    }
    banner.style.left = left + 'px';
  }

  /* ═══════════════════════════════════════════════════════
     FILE MENU STATE MACHINE
     ═══════════════════════════════════════════════════════ */

  function saveAndApplyFileMenuState() {
    const menu = document.getElementById('menu-file');
    if (!menu) return;

    savedFileMenuState = {
      exports: [],
      pngLabel: null,
      pngHandler: null,
      icoHandler: null
    };

    const buttons = menu.querySelectorAll('button.menu-action');
    buttons.forEach(btn => {
      const t = btn.dataset.exportType;
      if (!t) return;
      const labelEl = btn.querySelector('.menu-label');
      savedFileMenuState.exports.push({
        btn: btn,
        label: labelEl ? labelEl.textContent : '',
        onclick: btn.getAttribute('onclick')
      });
      if (t === 'png') {
        if (labelEl) labelEl.textContent = 'Export Current Size as PNG';
        btn.setAttribute('onclick', 'IEM.exportCurrentAsPng()');
        btn.removeAttribute('disabled');
        btn.classList.remove('iem-disabled');
      } else if (t === 'quickpng') {
        btn.setAttribute('onclick', 'IEM.exportCurrentAsPng()');
        btn.removeAttribute('disabled');
        btn.classList.remove('iem-disabled');
      } else if (t === 'ico') {
        btn.setAttribute('onclick', 'IEM.exportProject()');
        btn.removeAttribute('disabled');
        btn.classList.remove('iem-disabled');
      } else {
        // Grey out all other exports
        btn.setAttribute('disabled', '');
        btn.classList.add('iem-disabled');
        btn.setAttribute('onclick', '');
      }
    });
  }

  function restoreFileMenuState() {
    if (!savedFileMenuState) return;
    savedFileMenuState.exports.forEach(info => {
      const labelEl = info.btn.querySelector('.menu-label');
      if (labelEl) labelEl.textContent = info.label;
      if (info.onclick) info.btn.setAttribute('onclick', info.onclick);
      else info.btn.removeAttribute('onclick');
      info.btn.removeAttribute('disabled');
      info.btn.classList.remove('iem-disabled');
    });
    savedFileMenuState = null;
  }

  // Re-apply on every menu open (safeguard)
  function applyFileMenuState() {
    if (active && !savedFileMenuState) saveAndApplyFileMenuState();
  }

  /* ═══════════════════════════════════════════════════════
     DIRECT EXPORTS
     ═══════════════════════════════════════════════════════ */

  async function exportCurrentAsPng() {
    if (typeof closeAllMenus === 'function') closeAllMenus();
    if (!active || activeIdx < 0) return;
    // Stamp any in-flight floating/transform/gradient onto the layer first
    // so the exported PNG matches what the user sees on the canvas.
    commitTransients();
    const doc = docs[activeIdx];
    const canvas = flattenDocToCanvas(doc);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    downloadBlob(blob, `${fileName}-${doc.size}.png`);
  }

  async function exportProject() {
    if (typeof closeAllMenus === 'function') closeAllMenus();
    if (!active) return;
    commitTransients();
    try {
      const blob = await encodeIcoProject();
      downloadBlob(blob, `${fileName}.ico`);
    } catch (err) {
      alert('Export failed: ' + (err && err.message ? err.message : err));
    }
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  /* ═══════════════════════════════════════════════════════
     DRAG-DROP ICO
     ═══════════════════════════════════════════════════════ */

  function isIcoFile(file) {
    if (!file) return false;
    const name = (file.name || '').toLowerCase();
    const type = (file.type || '').toLowerCase();
    return name.endsWith('.ico') || type === 'image/x-icon' || type === 'image/vnd.microsoft.icon';
  }

  function isProjectPristine() {
    // Heuristic: no history has been accumulated beyond the initial entry.
    if (active) return false;
    if (typeof History === 'undefined' || !window.History) return true;
    return window.History.canUndo() === false;
  }

  function handleDroppedFiles(files) {
    // If exactly one .ico, IEM is inactive, and project is pristine → handle it
    if (!files || files.length !== 1) return false;
    const file = files[0];
    if (!isIcoFile(file)) return false;
    if (active) return true;                   // consume but no-op (prevents fallthrough)
    if (!isProjectPristine()) return true;     // consume but no-op
    handleOpenIco(file);
    return true;
  }

  /* ═══════════════════════════════════════════════════════
     CONTEXT MENU (right-click on size row)
     ═══════════════════════════════════════════════════════ */

  function buildContextMenu() {
    if (ctxMenuEl) return ctxMenuEl;
    const el = document.createElement('div');
    el.className = 'iem-context-menu';
    el.innerHTML =
      '<button data-action="duplicate">Duplicate</button>' +
      '<button data-action="delete">Delete</button>' +
      '<div class="iem-ctx-sep"></div>' +
      '<button data-action="export-png">Export as PNG</button>' +
      '<button data-action="toggle-format">Toggle Format (PNG ↔ BMP)</button>';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const action = btn.dataset.action;
      hideContextMenu();
      if (action === 'duplicate') duplicateSelectedSizes();
      else if (action === 'delete') deleteSelectedSizes();
      else if (action === 'export-png') exportCurrentAsPng();
      else if (action === 'toggle-format') toggleDocFormat(primaryIdx);
    });
    ctxMenuEl = el;
    return el;
  }

  function showContextMenu(x, y) {
    const el = buildContextMenu();
    el.style.display = 'block';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    setTimeout(() => {
      document.addEventListener('click', hideContextMenuOnce, { once: true });
    }, 0);
  }
  function hideContextMenuOnce() { hideContextMenu(); }
  function hideContextMenu() { if (ctxMenuEl) ctxMenuEl.style.display = 'none'; }

  /* ═══════════════════════════════════════════════════════
     IEM OP STACK — undo/redo for panel-level ops
     ═══════════════════════════════════════════════════════ */

  function pushOp(op) {
    // Truncate any redo future
    opStack.length = opCursor + 1;
    opStack.push(op);
    opCursor = opStack.length - 1;
  }

  function opUndo() {
    if (opCursor < 0) return false;
    const op = opStack[opCursor];
    applyOpInverse(op);
    opCursor--;
    renderPanel();
    return true;
  }

  function opRedo() {
    if (opCursor >= opStack.length - 1) return false;
    opCursor++;
    const op = opStack[opCursor];
    applyOp(op);
    renderPanel();
    return true;
  }

  function applyOp(op) {
    // Re-apply an op (used by redo)
    if (op.type === 'format') {
      const doc = docs.find(d => d.id === op.docId);
      if (doc) doc.format = op.next;
    } else if (op.type === 'add') {
      // Would need snapshotted doc to re-add — for v1, add/delete/duplicate are NOT redo-safe
      // (they're undoable once but redoing recreates data, which is complex)
    } else if (op.type === 'delete') {
      // Re-delete the same doc ids
      for (const rec of op.removed) {
        const idx = docs.findIndex(d => d.id === rec.doc.id);
        if (idx >= 0) removeDocAt(idx);
      }
    } else if (op.type === 'duplicate') {
      // Redoing duplicate would recreate — skipped in v1
    }
  }

  function applyOpInverse(op) {
    if (op.type === 'format') {
      const doc = docs.find(d => d.id === op.docId);
      if (doc) doc.format = op.prev;
    } else if (op.type === 'add') {
      const idx = docs.findIndex(d => d.id === op.id);
      if (idx >= 0) removeDocAt(idx);
    } else if (op.type === 'delete') {
      // Re-insert removed docs
      for (const rec of op.removed) {
        addDocSorted(rec.doc);
      }
    } else if (op.type === 'duplicate') {
      for (const id of op.ids) {
        const idx = docs.findIndex(d => d.id === id);
        if (idx >= 0) removeDocAt(idx);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════
     UNIFIED UNDO/REDO DISPATCH
     When IEM is active, Ctrl+Z first checks per-doc history, then IEM op stack.
     ═══════════════════════════════════════════════════════ */

  function dispatchUndo() {
    if (!active) return false;
    const H = window.History;
    if (H && H.canUndo()) { H.undo(); return true; }
    if (opUndo()) return true;
    return false;
  }

  function dispatchRedo() {
    if (!active) return false;
    const H = window.History;
    if (H && H.canRedo()) { H.redo(); return true; }
    if (opRedo()) return true;
    return false;
  }

  /* ═══════════════════════════════════════════════════════
     AFTER-EDIT HOOK — called from script.js whenever a stroke completes,
     so the active-doc thumbnail can refresh.
     ═══════════════════════════════════════════════════════ */

  function markActiveDocDirty() {
    if (!active || activeIdx < 0) return;
    docs[activeIdx].pristine = false;
    refreshActiveRowThumb();
  }

  /* ═══════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════ */

  window.IEM = {
    // State
    get active()        { return active; },
    get docs()          { return docs; },
    get activeIdx()     { return activeIdx; },
    get primaryIdx()    { return primaryIdx; },
    get selectedIdxs()  { return selectedIdxs; },
    get masterCanvas()  { return masterCanvas; },
    get fileName()      { return fileName; },

    // Lifecycle
    handleOpenIco,
    enter,
    exit,
    exitIfActive,

    // Choice modal
    openChoiceModal,
    closeChoiceModal,
    choosePngImport,
    chooseIconMode,

    // Size ops
    switchTo,
    addSize: openAddSizeModal,
    duplicateSelectedSizes,
    deleteSelectedSizes,
    toggleDocFormat,

    // Add size modal
    openAddSizeModal,
    closeAddSizeModal,
    confirmAddSize,

    // Banner
    mountBanner,
    unmountBanner,
    layoutBanner,

    // File menu
    applyFileMenuState,
    saveAndApplyFileMenuState,
    restoreFileMenuState,

    // Exports
    exportCurrentAsPng,
    exportProject,

    // Drag-drop
    handleDroppedFiles,
    isIcoFile,
    isProjectPristine,

    // Undo/redo dispatch
    dispatchUndo,
    dispatchRedo,

    // Hooks
    markActiveDocDirty,
    refreshActiveRowThumb,

    // Decoder/encoder (exposed for debugging)
    decodeIco,
    encodeIcoProject
  };

})();
