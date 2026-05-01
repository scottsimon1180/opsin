"use strict";

/* ═══════════════════════════════════════════════════════
   DOM — cached element references and canvas contexts
   Loaded before script.js; all declarations are globals
   accessible to every subsequent classic script on the page.
   ═══════════════════════════════════════════════════════ */

// ── Workspace & canvas wrapper ────────────────────────────────────────────────
const workspace     = document.getElementById('workspace');
const canvasWrapper = document.getElementById('canvasWrapper');

// ── Compositing and overlay canvases ──────────────────────────────────────────
const compositeCanvas = document.getElementById('compositeCanvas');
const compositeCtx    = compositeCanvas.getContext('2d');
const overlayCanvas   = document.getElementById('overlayCanvas');
const overlayCtx      = overlayCanvas.getContext('2d');

// ── Status / cursor UI elements ───────────────────────────────────────────────
const brushCursorEl = document.getElementById('brushCursor');
const statusPosEl   = document.getElementById('statusPos');

// ── Ruler canvases ────────────────────────────────────────────────────────────
const rulerH      = document.getElementById('rulerH');
const rulerV      = document.getElementById('rulerV');
const rulerCorner = document.getElementById('rulerCorner');
const rulerHCtx   = rulerH.getContext('2d');
const rulerVCtx   = rulerV.getContext('2d');

// ── Guide overlay canvas ──────────────────────────────────────────────────────
const guideOverlay    = document.getElementById('guideOverlay');
const guideOverlayCtx = guideOverlay.getContext('2d');

// ── UI overlay canvas (ruler tool) ───────────────────────────────────────────
const uiOverlay    = document.getElementById('uiOverlay');
const uiOverlayCtx = uiOverlay.getContext('2d');
