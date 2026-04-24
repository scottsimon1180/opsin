# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: Opsin - Image Studio

Opsin is a professional browser-based raster image editing program (~14K lines of source), designed to mimic high-end editors like Photoshop, Paint.net, Pixlr, and Photopea. It is a zero-dependency, static HTML/CSS/JS application with no build step, no bundler, and no npm.

## Development

- **Run:** Open `index.html` in a browser. No server required (uses file:// protocol).
- **No build/lint/test pipeline.** All source is vanilla HTML5 + CSS + JavaScript. Changes are verified visually in-browser.
- **Version:** Defined in `js/version.js` as `OPSIN_VERSION`. All version display labels pull from this constant.

## Scope & Edit Discipline

This project is a performance-sensitive, canvas-based image editor with complex state (layers, undo/redo, selections, tools). All decisions must respect this context.

- **Priority:** correctness > performance > architectural consistency > maintainability > UX polish.
- **Surgical edits only:** modify the specific lines needed. Do not refactor, rename, or "clean up" untouched code. Assume existing code is functional and final.
- **Do not expand scope:** no UI/UX redesigns while fixing logic, no new abstractions, no multi-file edits unless required.
- **UX safeguards:** maintain real-time responsiveness; never introduce synchronous operations on large pixel data; preserve existing tool/shortcut/workflow behavior.
- **If unclear, ask.** Do not guess before making structural changes.
- **Autonomous execution:** For tasks with clear scope, proceed to implementation without requesting intermediate approval. Only pause when something is genuinely ambiguous or structurally risky.
- **Always `/plan`** before editing `index.html`, `js/script.js`, or `js/history.js` (the large, load-bearing files).

## Guidelines

- **Naming:** Follow existing conventions exactly. The main script file is `js/script.js`.
- **Standards:** HTML5 semantic tags only. No inline styles — all styling goes in `css/style.css`.
- **Design reference:** `pages/colorPicker.html` is the canonical UI benchmark. All new panels, modals, and controls should match its polish. Use CSS custom properties from `:root` in `css/style.css` — never hardcoded colors or inline styles.
- **Options bar controls:** Use the existing `.opt-*` classes (`opt-seg-bar`, `opt-icon-group`, `opt-input-sm`, `opt-input-md`, `opt-unit`). Do not add inline styles or new input classes for options bar additions.

## Directory Structure

- `index.html` — Main UI shell (at project root). Contains all DOM structure: menu bar, options bar, toolbar, workspace (canvas + rulers + guides), side panels (Color, Properties, Layers, History), status bar, modals (New Image, Filter, Resize, Canvas Size), and the inline Color Picker panel.
- `manifest.json` — PWA manifest (at project root). References icons in `assets/images/`.
- `css/style.css` — All styling. Uses CSS custom properties in `:root` for the dark theme. Key layout vars: `--toolbar-width`, `--panel-width`, `--menubar-height`, `--options-height`, `--statusbar-height`, `--ruler-size`.
- `js/script.js` — All application logic (~7250 lines, single file).
- `js/toolbar.js` — Tool system: `selectTool()`, options bar wiring, per-tool config (draw settings, shape/lasso/selection modes), `toolKeys` map. Loaded after `js/script.js`.
- `js/iconEditMode.js` — Icon Editor Mode (IEM): multi-size `.ico` editing, per-doc History engines, ICO decoder/encoder, icon sizes panel UI. Loaded last. Wrapped in an IIFE; exposes `window.IEM`.
- `js/history.js` — Standalone tile-based undo/redo engine. Exposes a global `History` object and a `createHistoryEngine()` factory (used by IEM for per-doc engines). Driven by a host adapter in `js/script.js` (search `/* ═══ UNDO / REDO`).
- `js/version.js` — Single `const OPSIN_VERSION` declaration. Loaded before `js/script.js`.
- `js/linked_icons.js` — SVG icon definitions embedded as a template literal. Parsed at load and injected as an SVG sprite (`<svg>` with `<symbol>` elements referenced via `<use href="#icon-name"/>`).
- `pages/colorPicker.html` — Standalone color picker loaded in an iframe. Communicates with the parent via `postMessage`.
- `pages/infoPopup.html` — Standalone about/info popup loaded in an iframe. Reads `OPSIN_VERSION` from `../js/version.js`.
- `assets/images/` — App icons and logo assets (favicon, logo-16/24/32/64/96/128/256/1024 PNG files).

## Architecture (script.js)

`script.js` is organized into clearly delimited sections (search for `/* ═══` headers). Key systems and their relationships:

### Rendering Pipeline
Two stacked canvases inside `#canvasWrapper`:
- **`compositeCanvas`** — The visible output. `compositeAll()` re-composites all layers bottom-to-top (respecting visibility, opacity, floating selections, and active pixel transforms) onto this canvas every frame.
- **`overlayCanvas`** — Selection marching ants, transform handles, shape previews. Drawn by `drawOverlay()`.
- A separate **`#guideOverlay`** canvas renders ruler guides on top of everything.

All tools draw to individual **layer canvases** (offscreen), never directly to the composite. The cycle is: tool modifies layer canvas -> `compositeAll()` -> display.

### Layer System (search `/* ═══ LAYER SYSTEM`)
Each layer is `{ id, name, canvas, ctx, visible, opacity }`. Layers are stored in `layers[]` array (index 0 = topmost). `activeLayerIndex` and `selectedLayers` (Set) track state. Multi-select is supported for merge/delete/duplicate. `getActiveLayer()` returns the current drawing target.

### Undo/Redo — History Engine (`history.js` + host adapter, search `/* ═══ UNDO / REDO`)
All history logic lives in `history.js`, which exposes a global `History` object. `script.js` wires it up via a host adapter and thin public wrappers (`pushUndo`, `pushUndoForDrawing`, `commitDrawUndo`, `doUndo`, `doRedo`). Key architecture:

- **Command/memento hybrid.** Each discrete user action produces one `HistoryEntry` representing the post-action document state. Undo/Redo navigates a linear cursor and restores the referenced state directly (no replay, no diffing).
- **Tile-based storage.** Every layer snapshot is stored as a grid of 256×256 RGBA tiles in a shared, reference-counted, content-addressed tile store. Identical tiles are deduplicated via fast FNV-1a hash + byte-equality, so unchanged regions are shared across all entries — a brush stroke only costs a few new tiles, not a full layer copy.
- **Byte-budgeted eviction.** A configurable byte budget (default 512 MB) caps memory; oldest entries are evicted from the tail when exceeded. Entry count is unbounded.
- **Full state restore.** Each entry captures layer structure, per-layer tile snapshots, canvas dimensions, active layer, selection state (including mask pixels), and gradient editing state.
- **Entry points:** `pushUndo(actionName)` for one-shot destructive ops. For drawing strokes, `pushUndoForDrawing()` takes a smart pre-snapshot and `commitDrawUndo()` finalizes post-stroke. Navigation is `doUndo()` / `doRedo()`.

### Selection System (search `/* ═══ SELECTION SYSTEM`)
Dual representation: `selection` (geometric object for simple shapes) and `selectionMask` (per-pixel canvas for complex selections like magic wand, lasso). `selectionPath` is a `Path2D` used for clipping and marching ants. Selection modes: new/add/subtract. Mask-based selections use `maskToContours()` -> `contoursToPath()` to convert pixel masks into vector paths.

### Floating Selections & Free Transform
- **Floating Selection** (state near the top of `script.js`): Photoshop-style behavior. When moving selected pixels, they "float" on `floatingCanvas` at `floatingOffset`. `commitFloating()` stamps them back onto the layer.
- **Pixel Transform** (search `/* ═══ PIXEL TRANSFORM`): Free Transform (Ctrl+T-style). Extracts selected region into `pxTransformData.srcCanvas`, renders handles via `drawPxTransformHandles()`. Supports resize via corner/edge handles with shift-constrain and alt-center modifiers.

### Drawing Engine
Brush rendering uses radial gradient dabs with configurable size, hardness (0 = fully soft, 100 = crisp edge — Photoshop-convention), and opacity. Default brush size on new/open is computed from image diagonal via `computeDefaultBrushSize(w,h)`. `strokeBuffer`/`strokeBufferCtx` is a per-stroke offscreen canvas that prevents opacity stacking within a single stroke. Pencil tool uses direct pixel stamping. Smoothing uses exponential moving average (`smoothStep()`). Includes scanline flood fill (`floodFill`) and tolerance-based magic wand (`magicWandSelect`).

### Magnetic Lasso (Advanced System – only modify if necessary)
Intelligent Scissors / Livewire implementation. Sobel gradient edge map is computed on the active layer's pixels (`computeEdgeMap()`) and cached by `ensureEdgeMapCoverage()` — only recomputed when the cursor moves outside the cached region. Live path snapping uses Dijkstra on the gradient map (`computeLiveWire()`), throttled to 60 fps via `magLastPathTime`. Buffers (`_magDist`, `_magPrev`, etc.) are module-level typed arrays that grow-and-reuse to avoid per-call allocation. State: `magAnchors`, `magSegments`, `magLivePath`, `magActive`, `magFreehandMode`.

### Tool System (`js/toolbar.js`)
`selectTool(name)` handles tool switching, options bar visibility toggling, and cursor updates. Tools: move, movesel, pan, select, lasso (free/poly/magnetic), wand, ruler, brush, pencil, eraser, fill, gradient, eyedropper, text, shape, zoom. Single-key shortcuts in `toolKeys`. Per-tool settings (size, hardness, opacity, smoothness) stored in `drawSettings` and saved/loaded by `saveDrawSettings()`/`loadDrawSettings()`. `js/toolbar.js` loads after `script.js` and calls utility functions (`syncSliders`, `addSliderWheelListener`, `setupAppLikeInput`) defined there.

### Gradient Tool (search `/* ═══ GRADIENT TOOL`)
Multi-stop editable linear gradient with perceptual (linear-light) color interpolation. Supports interactive endpoint dragging, stop insertion/deletion/repositioning, and midpoint handles. Uses `gradSnapshot()`/`gradRestore()` to enable live preview.

### Color System (search `/* ═══ COLOR SYSTEM`)
HSV master state. `fgColor`/`bgColor` are hex strings. The Color Panel (RGB sliders + hex input + preset swatches) in the side panel syncs bidirectionally. The full Color Picker (`colorPicker.html`) loads in an iframe and communicates via `postMessage` (`toggleColorPicker`). Panel eyedropper mode (search `/* ═══ EYEDROPPER`).

### Mouse Event Handling (search `/* ═══ MOUSE EVENT HANDLING`)
All canvas interaction routes through `onMouseDown`, `onMouseMove`, `onMouseUp` (attached to `#workspace`). These functions dispatch based on `currentTool` and manage state transitions for drawing, selection, panning, gradient editing, etc.

### Coordinate System (`screenToCanvas`)
`screenToCanvas(clientX, clientY)` converts screen coordinates to canvas pixel coordinates, accounting for zoom, pan, and ruler offsets. All tool operations work in canvas-space coordinates.

### Snap Engine (`SnapEngine`)
Self-contained unified Snap-To system (Photoshop-style). Any draggable tool can opt in via a small API: `SnapEngine.beginSession(context)` at drag start, `snapBounds` / `snapPoint` / `snapValue` during the drag, `endSession()` at drag end. Indicators draw automatically via `drawIndicators(ctx)`. Categories include document bounds, guides, layers, and selection; enablement persists in `localStorage` under `opsin.snap.enabled`.

### Properties Panel (`updatePropertiesPanel`)
Context-sensitive panel that reflects the current state: pixel transform bounds, floating selection bounds, or selection bounds. Supports numeric W/H/X/Y input, aspect-ratio locking, flip, rotate, and 9-point alignment. `updatePropertiesPanel()` is called whenever state changes.

### Filters (`openFilter`, `applyFilter`, `applyFilterDirect`)
Brightness/Contrast, HSL, Blur (CSS-based), Sharpen, Invert, Grayscale. Modal-based with live preview canvas. `openFilter(type)` captures the active layer's current state; `applyFilter()` commits. Invert/Grayscale can also apply directly via `applyFilterDirect()`.

### File I/O
- **New/Open:** `newImage()` modal, `openImage()` via hidden file input. Opening a `.ico` triggers IEM choice modal.
- **Export:** `saveImage(format)` — PNG, JPG, WebP via `canvas.toBlob()` + download link. TIF/BMP via `openExportModal()` with bit-depth selection. ICO via `openExportIcoModal()` / `executeIcoExport()`.
- **Import as Layer:** `importImageAsLayer(file)` — drag-and-drop or file picker; auto-enters Free Transform if image dimensions differ. Accepted MIME types in `RASTER_MIME_TYPES`.

### Icon Editor Mode (`js/iconEditMode.js`)
Activated when the user opens a `.ico` and chooses "Edit in Icon Mode". Each embedded size becomes an `IconDoc` — own layers, own History engine, own format flag (`FORMAT_PNG`/`FORMAT_BMP`). Switching sizes atomically swaps script.js's global state (`layers`, `canvasW`, `History`, etc.) via `activateDocAtIndex()`. The original largest-at-import image is captured in `masterCanvas` (never mutated) so "Duplicate and resize master" always works. IEM has its own panel-level undo (`opStack`/`opCursor`) for structural ops (add/delete/duplicate/format-toggle), separate from per-doc pixel history. Exposes `window.IEM` for cross-file calls. Key public entry points: `IEM.open(file)`, `IEM.exportProject()`, `IEM.exportCurrentAsPng()`, `IEM.exitIfActive()`.

### Rulers, Guides & Ruler Tool (`drawRulers`, `drawGuides`, `uiOverlay`)
- **Rulers** (`drawRulers`): Canvas-rendered rulers that update on zoom/pan/resize. `drawRulers()` re-renders on every viewport change.
- **Guides** (`drawGuides`, `hitTestGuide`): Draggable horizontal/vertical lines created by clicking rulers. Rendered on `#guideOverlay` by `drawGuides()`.
- **Ruler Tool** (search `/* ═══ RULER TOOL`, `uiOverlay`): Viewport-only measurement tool that draws to `#uiOverlay`. Does not touch layers or undo.

### Image Ops (Resize, Canvas Size, Flip/Rotate)
`Image > Resize` (`applyResizeImage`) resamples the entire document. `Image > Canvas Size` (`applyCanvasSize`) changes canvas dimensions with a 9-point anchor (`canvasAnchor`). Flip/Rotate (`flipHorizontal`, `flipVertical`, `rotateImage`) transforms all layers. All push a single undo entry.

## Keyboard Shortcuts
All shortcuts live in a single `keydown` listener — search `/* ═══ KEYBOARD SHORTCUTS` in `js/script.js` for the full map. Space-bar pan is separate (search `/* ═══ SPACE BAR PAN`).

## Script Load Order & Cross-file Access
Load order in `index.html`: `version.js` → `linked_icons.js` → `history.js` → `script.js` → `toolbar.js` → `iconEditMode.js`. All files are classic scripts (not modules), so top-level `let`/`const`/`function` are global. `toolbar.js` and `iconEditMode.js` freely access `script.js` globals (`layers`, `currentTool`, `pushUndo`, etc.) at runtime — load order only matters for top-level init code, not event-driven calls.

## Definition of Done

A change is valid only if:
- No regression in rendering
- No console errors
- Undo/redo remains intact
- Layers function remains intact
- Tool switching still works
