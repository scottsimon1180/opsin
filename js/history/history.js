"use strict";

/* ══════════════════════════════════════════════════════════════════════
   Opsin — History Engine
   ════════════════════════════════════════════════════════════════════════

   A Photoshop-style linear undo/redo system built on a hybrid model:

     • COMMAND/MEMENTO HYBRID — Each discrete user action ("Brush", "Fill",
       "Add Layer", "Filter", …) produces a single HistoryEntry representing
       the POST-action state of the document. Undo/Redo navigates a linear
       cursor across the timeline and restores the referenced state.

     • TILE-BASED STORAGE — Every layer snapshot is stored as a grid of
       256×256 RGBA tiles in a shared, reference-counted content-addressed
       tile store. Tiles identical to a tile already in the store (by byte
       equality after a fast FNV-1a hash bucket lookup) are deduplicated,
       so unchanged regions of the canvas are shared across every history
       entry. This reduces memory from O(entries × pixels) to
       O(unique_tiles × tile_size) — a brush stroke in the corner of a 4K
       canvas produces an entry that is ~2 tiles larger than the previous
       one, not a full copy.

     • BYTE-BUDGETED EVICTION — A configurable byte budget (default 512 MB)
       caps total memory usage. When the budget is exceeded, the oldest
       entries are evicted from the tail until the budget is satisfied.
       Entry count is unbounded; memory is the only ceiling.

     • FULL STATE RESTORE — Each entry stores enough to reconstitute the
       entire document: layer structure (order, names, visibility, opacity),
       per-layer tile snapshots, canvas dimensions, active-layer index,
       selection state (including mask pixel data), and gradient editing
       state. Restoring an entry rebuilds the layer array from scratch.

     • DETERMINISTIC NAVIGATION — Undo/Redo are O(entries touched), never
       more than one. No replay, no diffing — a direct state materialization.

   ══════════════════════════════════════════════════════════════════════
   PUBLIC API
   ══════════════════════════════════════════════════════════════════════

     History.init({ host, maxBytes, onUpdate, debug })
         Wires the engine to the host application. Must be called before
         any other API method.

         host: {
             getLayers()              → Array<Layer>
             getActiveLayerIndex()    → number
             getCanvasW() / getCanvasH()
             setLayers(layers, activeIndex)
             setCanvasSize(w, h)
             createLayerCanvas()      → HTMLCanvasElement
             captureSelection()       → selection memento
             restoreSelection(mem)
             captureGradient()        → gradient memento
             restoreGradient(mem)
             afterRestore()           // composite/redraw/UI refresh hook
         }

     History.record(name, iconId, type)
         Capture the current document state as a new HistoryEntry labeled
         `name` with icon `iconId`. CALL THIS AFTER the user action has
         been applied to the document. Discards any redo-future beyond
         the current cursor.

         type ∈ {'init','pixel','structure','document','selection'}
         (purely informational; all entries store a full state).

     History.undo() / History.redo()
         Navigate one step. Returns true on success.

     History.jumpTo(index)
         Jump to a specific timeline index (for history-panel clicks).

     History.reset()
         Clear the entire timeline and release all tiles.

     History.canUndo() / History.canRedo()
     History.getTimeline() / History.getCursor()
     History.getMemoryUsage() → { entries, tileBytes, totalBytes, … }
     History.integrityCheck() → { ok, issues }
         Walks the timeline and verifies that every referenced tile is
         still present in the store and refCounts match. Exposed for
         tests and the window.__history debug handle.

   ══════════════════════════════════════════════════════════════════════
   HOW NEW TOOLS HOOK IN
   ══════════════════════════════════════════════════════════════════════

     The engine is intentionally content-agnostic: any action that
     mutates a layer's pixels, the layer structure, the canvas
     dimensions, or the selection can be recorded the same way.

         1. Perform the action. Mutate layers, selection, etc.
         2. Call History.record('Action Name', 'icon-id').
         3. That's it.

     For composite workflows (gradient editing, free transform) that
     have many intermediate steps, only record on COMMIT so the whole
     session collapses to a single entry. To preserve the pre-session
     state for cancel, take an in-memory snapshot (not a history entry)
     and restore from that on cancel.

     If the host needs to add a new memento field (e.g., a future smart
     object), extend `host.captureXxx()` / `host.restoreXxx()` and wire
     it into `buildEntry` / `restoreFromEntry` below.

     ══════════════════════════════════════════════════════════════════════ */

(function (global) {

  /* ══════════════════════════════════════════════════════════════════════
     Factory — createHistoryEngine() returns a self-contained engine
     instance with its own timeline, tile store, and host binding.
     The default singleton (window.History) is created below. The Icon
     Editor Mode creates additional instances, one per icon size, so
     each size has an independent undo/redo timeline.
     ══════════════════════════════════════════════════════════════════════ */

  function createHistoryEngine() {

  /* ──── Configuration ──────────────────────────────────────────────── */

  const DEFAULT_MAX_BYTES = 512 * 1024 * 1024; // 512 MB fallback when History.init() is called without maxBytes
  const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4; // 262144 bytes / full tile
  const TILE_OVERHEAD = 96; // approximate per-tile struct + Map entry cost

  /* ──── Tile Store — content-addressed, reference-counted ──────────── */

  // Map<hashKey, Array<TileRecord>> (bucket list handles hash collisions)
  const tileStore = new Map();
  let tileStoreBytes = 0;
  let tileCount = 0;

  // Fast FNV-1a 32-bit hash of a Uint8ClampedArray. Used only as a
  // bucket key; final identity is confirmed by full byte equality.
  function hashBytes(u8) {
    let h = 0x811c9dc5 | 0;
    const len = u8.length;
    // Unroll 4-byte stride for speed
    let i = 0;
    const end4 = len - (len & 3);
    for (; i < end4; i += 4) {
      h ^= u8[i];     h = Math.imul(h, 0x01000193);
      h ^= u8[i + 1]; h = Math.imul(h, 0x01000193);
      h ^= u8[i + 2]; h = Math.imul(h, 0x01000193);
      h ^= u8[i + 3]; h = Math.imul(h, 0x01000193);
    }
    for (; i < len; i++) {
      h ^= u8[i];     h = Math.imul(h, 0x01000193);
    }
    return ((h >>> 0).toString(36)) + ':' + len;
  }

  function bytesEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    const n = a.length;
    if (n !== b.length) return false;
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /**
   * Insert (or share) a tile in the store. Returns the TileRecord — a
   * handle carrying a back-pointer to its bucket so release is O(1).
   *   TileRecord = { data, w, h, hash, refCount }
   */
  function tileAdd(u8, w, h) {
    const hash = hashBytes(u8);
    let bucket = tileStore.get(hash);
    if (bucket) {
      for (let i = 0, n = bucket.length; i < n; i++) {
        const rec = bucket[i];
        if (rec.w === w && rec.h === h && bytesEqual(rec.data, u8)) {
          rec.refCount++;
          return rec;
        }
      }
    } else {
      bucket = [];
      tileStore.set(hash, bucket);
    }
    const rec = { data: u8, w: w, h: h, hash: hash, refCount: 1 };
    bucket.push(rec);
    tileStoreBytes += u8.length + TILE_OVERHEAD;
    tileCount++;
    return rec;
  }

  function tileRelease(rec) {
    if (!rec || rec.refCount <= 0) return;
    rec.refCount--;
    if (rec.refCount > 0) return;
    const bucket = tileStore.get(rec.hash);
    if (bucket) {
      const idx = bucket.indexOf(rec);
      if (idx !== -1) bucket.splice(idx, 1);
      if (bucket.length === 0) tileStore.delete(rec.hash);
    }
    tileStoreBytes -= (rec.data ? rec.data.length : 0) + TILE_OVERHEAD;
    tileCount--;
    rec.data = null;
  }

  /* ──── Layer snapshot (tile set) ──────────────────────────────────── */

  /**
   * Capture a 2D context as a LayerSnapshot.
   *   LayerSnapshot = { w, h, tilesX, tilesY, tiles: Array<TileRecord> }
   */
  function snapshotLayer(ctx, w, h) {
    const tilesX = Math.ceil(w / TILE_SIZE);
    const tilesY = Math.ceil(h / TILE_SIZE);
    const tiles = new Array(tilesX * tilesY);
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const x = tx * TILE_SIZE;
        const y = ty * TILE_SIZE;
        const tw = Math.min(TILE_SIZE, w - x);
        const th = Math.min(TILE_SIZE, h - y);
        const img = ctx.getImageData(x, y, tw, th);
        // getImageData returns a fresh buffer; no need to copy again.
        const u8 = img.data;
        tiles[ty * tilesX + tx] = tileAdd(u8, tw, th);
      }
    }
    return { w: w, h: h, tilesX: tilesX, tilesY: tilesY, tiles: tiles };
  }

  function restoreLayer(ctx, snapshot) {
    const { w, h, tilesX, tilesY, tiles } = snapshot;
    ctx.clearRect(0, 0, w, h);
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const rec = tiles[ty * tilesX + tx];
        if (!rec || !rec.data) continue;
        // ImageData constructor needs an owned Uint8ClampedArray — so clone.
        const img = new ImageData(new Uint8ClampedArray(rec.data), rec.w, rec.h);
        ctx.putImageData(img, tx * TILE_SIZE, ty * TILE_SIZE);
      }
    }
  }

  function releaseSnapshot(snapshot) {
    if (!snapshot || !snapshot.tiles) return;
    for (const rec of snapshot.tiles) tileRelease(rec);
    snapshot.tiles = null;
  }

  /* ──── History timeline state ─────────────────────────────────────── */

  let timeline = [];
  let cursor = -1;
  let nextEntryId = 1;
  let byteBudget = DEFAULT_MAX_BYTES;
  let host = null;
  let onUpdateCb = null;
  let debugEnabled = false;

  /*
   * HistoryEntry structure:
   *   {
   *     id           : number   — monotonically increasing
   *     name         : string   — display label ("Brush", "Add Layer", …)
   *     iconId       : string   — SVG <symbol> id (without the 'icon-' prefix)
   *     type         : string   — 'init'|'pixel'|'structure'|'document'|'selection'
   *     timestamp    : number   — Date.now() at capture
   *     canvasW/H    : number
   *     structure    : Array<{id,name,visible,opacity}>
   *     layerSnapshots: Map<layerId, LayerSnapshot>
   *     activeLayer  : number
   *     selectionState : opaque memento from host.captureSelection()
   *     gradientState  : opaque memento from host.captureGradient()
   *     overheadBytes  : number  — per-entry bookkeeping bytes (tile data is
   *                                 shared and counted once in tileStoreBytes)
   *   }
   */

  function _cloneShapeForHistory(sh) {
    const cp = {
      id: sh.id,
      type: sh.type,
      rotation: sh.rotation || 0,
      fill:   sh.fill   ? { ...sh.fill }   : { type: 'solid', color: '#ffffff' },
      stroke: sh.stroke ? { ...sh.stroke, dashPattern: sh.stroke.dashPattern ? sh.stroke.dashPattern.slice() : null }
                        : { type: 'solid', color: '#000000', width: 2, cap: 'butt', join: 'miter', align: 'center', dashPattern: null, dashOffset: 0 },
      opacity: (sh.opacity == null) ? 1 : sh.opacity
    };
    if (sh.type === 'line') {
      cp.p1 = { x: sh.p1.x, y: sh.p1.y };
      cp.p2 = { x: sh.p2.x, y: sh.p2.y };
    } else if (sh.type === 'path') {
      cp.points = (sh.points || []).map(p => {
        const pt = { x: p.x, y: p.y };
        if (p.type)              pt.type = p.type;
        if (p.ohx !== undefined) { pt.ohx = p.ohx; pt.ohy = p.ohy; }
        if (p.ihx !== undefined) { pt.ihx = p.ihx; pt.ihy = p.ihy; }
        return pt;
      });
      cp.closed = !!sh.closed;
    } else {
      cp.x = sh.x; cp.y = sh.y; cp.w = sh.w; cp.h = sh.h;
      if (sh.type === 'rect') cp.cornerRadius = sh.cornerRadius || 0;
    }
    return cp;
  }

  function buildEntry(name, iconId, type) {
    const layers = host.getLayers();
    const W = host.getCanvasW();
    const H = host.getCanvasH();

    const structure = new Array(layers.length);
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      const s = { id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, kind: l.kind || 'image' };
      if (l.kind === 'text' && l.textModel) {
        // Deep-clone the text model so subsequent edits don't mutate the snapshot.
        s.textModel = {
          runs: l.textModel.runs.map(r => ({ ...r })),
          boxX: l.textModel.boxX, boxY: l.textModel.boxY,
          boxW: l.textModel.boxW, boxH: l.textModel.boxH,
          rotation: l.textModel.rotation || 0,
          mode: l.textModel.mode || 'point',
          align: l.textModel.align || 'left',
          lineSpacing: l.textModel.lineSpacing == null ? 1.2 : l.textModel.lineSpacing,
          letterSpacing: l.textModel.letterSpacing || 0,
          widthLocked: !!l.textModel.widthLocked
        };
      }
      if (l.kind === 'shape' && l.shapeModel) {
        // Deep-clone the shape model so subsequent edits don't mutate the snapshot.
        s.shapeModel = {
          nextId: l.shapeModel.nextId || 1,
          shapes: (l.shapeModel.shapes || []).map(sh => _cloneShapeForHistory(sh))
        };
      }
      structure[i] = s;
    }

    const layerSnapshots = new Map();
    for (const l of layers) {
      layerSnapshots.set(l.id, snapshotLayer(l.ctx, W, H));
    }

    const entry = {
      id: nextEntryId++,
      name: String(name || 'Action'),
      iconId: iconId || inferIconId(name),
      type: type || 'pixel',
      timestamp: Date.now(),
      canvasW: W,
      canvasH: H,
      structure: structure,
      layerSnapshots: layerSnapshots,
      activeLayer: host.getActiveLayerIndex(),
      selectionState: host.captureSelection ? host.captureSelection() : null,
      gradientState: host.captureGradient ? host.captureGradient() : null,
      overheadBytes: 0
    };
    entry.overheadBytes = estimateEntryOverhead(entry);
    return entry;
  }

  function estimateEntryOverhead(entry) {
    let b = 320; // object + fields
    if (entry.structure) b += entry.structure.length * 96;
    if (entry.layerSnapshots) {
      for (const [, snap] of entry.layerSnapshots) {
        if (!snap || !snap.tiles) continue;
        b += 48 + snap.tiles.length * 16; // snapshot header + tile-ref pointers
      }
    }
    if (entry.selectionState) {
      const ss = entry.selectionState;
      if (ss.selectionMaskBits) {
        b += ss.selectionMaskBits.length + 96;
      } else if (ss.selectionMaskData) {
        b += (ss.selectionMaskData.width * ss.selectionMaskData.height * 4) + 96;
      }
    }
    if (entry.gradientState && entry.gradientState.baseSnapshot) {
      b += (entry.gradientState.baseW * entry.gradientState.baseH * 4) + 96;
    }
    return b;
  }

  function freeEntry(entry) {
    if (!entry) return;
    if (entry.layerSnapshots) {
      for (const [, snap] of entry.layerSnapshots) releaseSnapshot(snap);
      entry.layerSnapshots = null;
    }
    entry.structure = null;
    entry.selectionState = null;
    entry.gradientState = null;
  }

  function clearRedo() {
    if (cursor < timeline.length - 1) {
      const removed = timeline.splice(cursor + 1);
      for (const e of removed) freeEntry(e);
    }
  }

  function totalBytes() {
    let overhead = 0;
    for (const e of timeline) overhead += e.overheadBytes;
    return tileStoreBytes + overhead;
  }

  function enforceBudget() {
    // Never evict the only remaining entry (the initial state anchor).
    while (timeline.length > 1 && totalBytes() > byteBudget) {
      const evicted = timeline.shift();
      freeEntry(evicted);
      cursor--;
    }
    if (cursor < 0 && timeline.length > 0) cursor = 0;
  }

  function pushEntry(entry) {
    clearRedo();
    timeline.push(entry);
    cursor = timeline.length - 1;
    enforceBudget();
    notify();
  }

  function notify() {
    if (onUpdateCb) {
      try { onUpdateCb(); }
      catch (err) { if (debugEnabled) console.error('[History] onUpdate error:', err); }
    }
  }

  function restoreFromEntry(entry) {
    // Resize canvas if dimensions changed.
    if (host.getCanvasW() !== entry.canvasW || host.getCanvasH() !== entry.canvasH) {
      host.setCanvasSize(entry.canvasW, entry.canvasH);
    }

    // Rebuild every layer from the structure manifest and tile snapshots.
    const newLayers = new Array(entry.structure.length);
    for (let i = 0; i < entry.structure.length; i++) {
      const s = entry.structure[i];
      const c = host.createLayerCanvas();
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const snap = entry.layerSnapshots.get(s.id);
      if (snap) restoreLayer(ctx, snap);
      newLayers[i] = {
        id: s.id,
        name: s.name,
        canvas: c,
        ctx: ctx,
        visible: s.visible,
        opacity: s.opacity,
        kind: s.kind || 'image'
      };
      if (s.kind === 'text' && s.textModel) {
        newLayers[i].textModel = {
          runs: s.textModel.runs.map(r => ({ ...r })),
          boxX: s.textModel.boxX, boxY: s.textModel.boxY,
          boxW: s.textModel.boxW, boxH: s.textModel.boxH,
          rotation: s.textModel.rotation || 0,
          mode: s.textModel.mode || 'point',
          align: s.textModel.align || 'left',
          lineSpacing: s.textModel.lineSpacing == null ? 1.2 : s.textModel.lineSpacing,
          letterSpacing: s.textModel.letterSpacing || 0,
          widthLocked: !!s.textModel.widthLocked
        };
      }
      if (s.kind === 'shape' && s.shapeModel) {
        newLayers[i].shapeModel = {
          nextId: s.shapeModel.nextId || 1,
          selectedIds: new Set(),
          shapes: (s.shapeModel.shapes || []).map(sh => _cloneShapeForHistory(sh))
        };
      }
    }
    host.setLayers(newLayers, Math.min(entry.activeLayer, newLayers.length - 1));

    if (host.restoreSelection) host.restoreSelection(entry.selectionState);
    if (host.restoreGradient) host.restoreGradient(entry.gradientState);
    if (host.afterRestore) host.afterRestore();
  }

  /* ──── Icon mapping ───────────────────────────────────────────────── */

  // Map display names to the SVG <symbol> ids defined in linked_icons.js.
  // Returns the icon id without the 'icon-' prefix; the renderer prepends it.
  function inferIconId(name) {
    if (!name) return 'menu-refresh';
    const n = String(name).toLowerCase().trim();

    // Exact matches first
    if (n === 'new image' || n === 'open image') return 'logo-opsin';
    if (n === 'brush') return 'brush';
    if (n === 'pencil') return 'pencil';
    if (n === 'eraser') return 'eraser';
    if (n === 'fill') return 'fill';
    if (n === 'text') return 'text';
    if (n === 'eyedropper') return 'eyedropper';
    if (n === 'shape') return 'shape';
    if (n === 'move') return 'move';
    if (n === 'move selection') return 'move-selection';
    if (n === 'transform') return 'move-selection';
    if (n === 'fill') return 'fill';
    if (n === 'crop') return 'select-rect';
    if (n === 'delete') return 'layer-delete';
    if (n === 'cut') return 'eraser';
    if (n === 'paste' || n === 'paste image') return 'import-layer';
    if (n === 'filter') return 'menu-refresh';

    // Layer ops
    if (n === 'add layer') return 'layer-add';
    if (n === 'delete layer') return 'layer-delete';
    if (n === 'duplicate layer') return 'duplicate-layer';
    if (n === 'merge layers') return 'merge-layers';
    if (n === 'reorder') return 'layer-move-up';

    // Document ops
    if (n === 'resize' || n === 'canvas size') return 'arrow-horizontal';
    if (n === 'rotate' || n === 'rotate selection') return 'arrow-vertical';
    if (n === 'flip h' || n === 'flip horizontal' || n === 'flip selection') return 'flip-horizontal';
    if (n === 'flip v' || n === 'flip vertical') return 'flip-vertical';
    if (n === 'align' || n === 'align selection') return 'move-selection';

    // Gradient family → flattened to a single "Gradient" entry, but be
    // lenient in case something slips through.
    if (n === 'gradient' || n.startsWith('gradient')) return 'gradient';

    // Selection family
    if (n === 'select all' || n === 'selection' || n === 'invert selection' ||
        n.includes('selection') || n.startsWith('select')) return 'select-rect';

    // Imports
    if (n.startsWith('import')) return 'import-layer';

    return 'menu-refresh';
  }

  /* ──── Public API ─────────────────────────────────────────────────── */

  const API = {

    /**
     * Wire the engine to the host application.
     * Idempotent: calling init again replaces the host binding.
     */
    init(opts) {
      opts = opts || {};
      host = opts.host || host;
      byteBudget = (typeof opts.maxBytes === 'number' && opts.maxBytes > 0)
                     ? opts.maxBytes
                     : DEFAULT_MAX_BYTES;
      onUpdateCb = opts.onUpdate || onUpdateCb;
      debugEnabled = !!opts.debug;
    },

    /**
     * Capture the current document state as a HistoryEntry.
     * CALL THIS AFTER the action has been applied to the document.
     */
    record(name, iconId, type) {
      if (!host) return false;
      const entry = buildEntry(name, iconId, type);
      pushEntry(entry);
      return true;
    },

    undo() {
      if (cursor <= 0) return false;
      cursor--;
      restoreFromEntry(timeline[cursor]);
      notify();
      return true;
    },

    redo() {
      if (cursor >= timeline.length - 1) return false;
      cursor++;
      restoreFromEntry(timeline[cursor]);
      notify();
      return true;
    },

    jumpTo(index) {
      if (index < 0 || index >= timeline.length || index === cursor) return false;
      cursor = index;
      restoreFromEntry(timeline[cursor]);
      notify();
      return true;
    },

    reset() {
      for (const e of timeline) freeEntry(e);
      timeline = [];
      cursor = -1;
      notify();
    },

    canUndo() { return cursor > 0; },
    canRedo() { return cursor < timeline.length - 1; },
    getTimeline() { return timeline; },
    getCursor() { return cursor; },
    getLength() { return timeline.length; },

    getMemoryUsage() {
      let overhead = 0;
      for (const e of timeline) overhead += e.overheadBytes;
      return {
        entries: timeline.length,
        cursor: cursor,
        overheadBytes: overhead,
        tileStoreBytes: tileStoreBytes,
        totalBytes: tileStoreBytes + overhead,
        budget: byteBudget,
        uniqueTiles: tileCount,
        bucketCount: tileStore.size
      };
    },

    /**
     * Walk the timeline and verify that every referenced tile is in the
     * store and refCounts match. Expensive — for tests / debug only.
     */
    integrityCheck() {
      const issues = [];
      const expectedRefs = new Map(); // TileRecord -> expected count

      for (const e of timeline) {
        if (!e.layerSnapshots) { issues.push(`Entry #${e.id} has null layerSnapshots`); continue; }
        for (const [layerId, snap] of e.layerSnapshots) {
          if (!snap || !snap.tiles) {
            issues.push(`Entry #${e.id} layer ${layerId} snapshot is null`);
            continue;
          }
          for (const rec of snap.tiles) {
            if (!rec) continue;
            expectedRefs.set(rec, (expectedRefs.get(rec) || 0) + 1);
          }
        }
      }

      // Every expected ref must exist in the store with matching refCount.
      for (const [rec, expected] of expectedRefs) {
        if (!rec.data) {
          issues.push(`TileRecord referenced but data is null (hash=${rec.hash})`);
          continue;
        }
        if (rec.refCount !== expected) {
          issues.push(`RefCount mismatch: store=${rec.refCount} expected=${expected} hash=${rec.hash}`);
        }
        const bucket = tileStore.get(rec.hash);
        if (!bucket || bucket.indexOf(rec) === -1) {
          issues.push(`Referenced tile not in store bucket (hash=${rec.hash})`);
        }
      }

      // Every tile in the store should have matching refCount.
      for (const [hash, bucket] of tileStore) {
        for (const rec of bucket) {
          const expected = expectedRefs.get(rec) || 0;
          if (rec.refCount !== expected) {
            issues.push(`Store refCount leak: rec.refCount=${rec.refCount} expected=${expected} hash=${hash}`);
          }
        }
      }

      return { ok: issues.length === 0, issues: issues };
    },

    /**
     * Snapshot the engine for debugging. Paired with window.__history.
     */
    debug() {
      return {
        timeline: timeline.map(e => ({
          id: e.id, name: e.name, icon: e.iconId, type: e.type,
          timestamp: e.timestamp,
          layers: e.structure ? e.structure.length : 0,
          overheadBytes: e.overheadBytes
        })),
        cursor: cursor,
        memory: API.getMemoryUsage(),
        tileStoreBucketCount: tileStore.size,
        tileCount: tileCount
      };
    },

    _internals: {
      TILE_SIZE: TILE_SIZE,
      get tileStore() { return tileStore; },
      get host() { return host; }
    }
  };

  return API;

  } // end createHistoryEngine

  /* ──── Default instance — preserves existing single-engine behavior ─ */

  const defaultEngine = createHistoryEngine();
  global.History = defaultEngine;
  global.createHistoryEngine = createHistoryEngine;

  // Expose a debug handle on window for console introspection.
  // Reads through window.History so it always reflects whichever engine
  // is currently active (default engine, or an IEM per-size engine).
  try {
    Object.defineProperty(global, '__history', {
      configurable: true,
      get: function () {
        const H = global.History || defaultEngine;
        return {
          state: H.debug(),
          memory: H.getMemoryUsage(),
          check: function () { return H.integrityCheck(); },
          undo: function () { return H.undo(); },
          redo: function () { return H.redo(); },
          reset: function () { return H.reset(); },
          jumpTo: function (i) { return H.jumpTo(i); },
          timeline: H.getTimeline(),
          cursor: H.getCursor()
        };
      }
    });
  } catch (e) { /* ignore */ }

})(typeof window !== 'undefined' ? window : this);
