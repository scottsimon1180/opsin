"use strict";

/* ═══════════════════════════════════════════════════════
   CORE STATE — mutable application state
   Loaded before script.js so all subsequent classic scripts
   can reference these as plain globals.
   ═══════════════════════════════════════════════════════ */

let canvasW = 1920, canvasH = 1080;
let zoom = 1, panX = 0, panY = 0;
let isFitMode = false;
let isPanning = false, panStart = {x:0,y:0}, panOffset = {x:0,y:0};

// Rulers
let rulersVisible = true;
let rulerMouseX = -1, rulerMouseY = -1;

// Guides
let guides = [];
let guidesVisible = true;
let guideIdCounter = 0;
let selectedGuide = null;
let draggingGuide = null;

let currentTool = 'move';
let panelEyedropperActive = false;
let _iframeEyedropperActive = false;
let fgColor = '#ff0000', bgColor = '#ffffff';

// Layers
let layers = [];
let activeLayerIndex = 0;
let selectedLayers = new Set([0]);
let layerIdCounter = 1;

// Selection — mask-based system
let selection = null;
let selectionPath = null;
let selectionMask = null;
let selectionMaskCtx = null;
let selectionFillRule = 'nonzero';
let selectShape = 'rect';
let lassoMode = 'free';
let shapeType = 'rect';
let selectionMode = 'new';
let polyPoints = [];
let transformSelActive = false;
let transformHandleDrag = null;
let transformOrigBounds = null;
// True once the current movesel transform drag has produced any actual
// motion. Set in mousemove's transformHandleDrag branch, reset in mousedown.
// Gates the 'Move Selection' undo so zero-distance clicks don't push entries.
let _transformDragMoved = false;

// Drawing state
let isDrawing = false;
let drawStart = {x:0,y:0};
let lastDraw = {x:0,y:0};

// Selection drawing state
let isDrawingSelection = false;
let drawingPreviewPath = null;

// Gradient state — editable multi-stop
let gradActive = false;
let gradP1 = null, gradP2 = null;
let gradStops = []; // [{t:0, color:'#fff', mid:0.5}, ...] sorted by t
let gradDragging = null; // null | 'creating' | 'p1' | 'p2' | {type:'stop'|'mid', index:number}
let gradBaseSnapshot = null;
let gradDragStartPos = null; // {x,y} for drag-off deletion detection
let gradStopAboutToDelete = false; // visual flag when dragging off line

// Lasso
let lassoPoints = [];

// Magnetic Lasso
let magAnchors = [];
let magSegments = [];
let magLivePath = null;
let magEdgeMap = null;
let magEdgeGx = null;
let magEdgeGy = null;
let magEdgeRegion = null;
let magActive = false;
let magFreehandMode = false;
let magFreehandPoints = [];
let magLastPathTime = 0;
// Reusable Dijkstra buffers (allocated once per session)
let _magDist = null;
let _magPrev = null;
let _magVisited = null;
let _magHeapCosts = null;
let _magHeapNodes = null;
let _magBufCapacity = 0;

// Move tool state
let isMovingPixels = false;
let moveOffset = {x:0, y:0};

// Persistent floating selection (Photoshop-style)
let floatingCanvas = null;
let floatingCtx = null;
let floatingOffset = {x:0, y:0};
let floatingActive = false;
let floatingSelectionData = null;
let _floatingDragBaseOffset = null;
let _floatingDragStart = null;

// Pixel Transform (Free Transform)
let pxTransformActive = false;
let pxTransformData = null;
let pxTransformHandle = null;
let pxTransformStartMouse = null;
let pxTransformOrigBounds = null;
// Rotation-drag transient state. Valid only while pxTransformHandle === 'rotate'.
let _rotateStartAngle = 0;  // angle from box center to mouse at drag start (radians)
let _rotateCenter = null;   // { x, y } canvas-space pivot (box center at drag start)
// Arrow-key nudge coalescing: a single "Nudge" undo captures the accumulated
// delta from any burst of arrow presses within NUDGE_IDLE_MS.
let _nudgeTimer = null;
let _nudgePending = false;
// Record whether a Pixel Transform was in-session at pushUndo time so
// reactivateAfterHistoryRestore() can re-enter ONLY for those entries.
let _pxTransformWasActiveForPush = false;
let _lastRestoredPxTransformWasActive = false;

// Move tool — persistent options & transient drag state
let moveAutoSelectLayer = false;
try { moveAutoSelectLayer = localStorage.getItem('opsin.move.autoSelectLayer') === 'true'; } catch(e) {}
// True when the current move drag was initiated by a click on an empty region
// and should be treated as a one-shot gesture that commits on mouseup.
let _moveTransformJustInitiated = false;
// Set at mousedown to mark that this click created the active transform —
// used by Phase 8 (Alt-drag duplicate).
let _moveDragAltDuplicate = false;

// Clipboard. clipboardCanvas is a tightly-trimmed image (null = empty);
// clipboardOrigin is its top-left in source-doc space so that an internal
// paste lands back where it came from. clipboardSignature is a fast content
// hash used by the system-clipboard `paste` event to detect a round-trip
// (Opsin Copy -> OS clipboard -> Opsin Paste) and preserve origin in that
// case rather than re-centering as if it were an external image.
let clipboardCanvas = null;
let clipboardOrigin = {x:0, y:0};
let clipboardSignature = 0;

// Brush stroke buffer (non-stacking opacity)
let strokeBuffer = null;
let strokeBufferCtx = null;

// Ruler tool (viewport-only measurement; does not touch undo)
let rulerState = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
let rulerDrag = null; // { mode: 'draw'|'move'|'handle', which?: 1|2, grabOffset?: {dx,dy} }

// Transparency checkerboard pattern cache (reset whenever canvas size changes)
let checkerPattern = null;

// Current filter
let currentFilterType = null;
let filterOriginalData = null;
let filterPreviewSrc = null;
