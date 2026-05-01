"use strict";

/* ═══════════════════════════════════════════════════════
   OpsinConfig — app-level configuration values
   Loaded before script.js so all subsequent classic scripts
   can reference these as plain globals or via window.OpsinConfig.
   ═══════════════════════════════════════════════════════ */

// ── History ──────────────────────────────────────────────────────────────────
const HISTORY_MAX_BYTES = 512 * 1024 * 1024; // 512 MB undo/redo byte budget

// ── Pixel Transform / Arrow-key nudge ────────────────────────────────────────
const NUDGE_IDLE_MS = 500; // ms to coalesce arrow-key nudges into one undo entry

// ── Canvas rulers (canvas-rendered tick rulers) ───────────────────────────────
const RULER_SIZE = 20; // px — height of horizontal ruler / width of vertical ruler

// ── Guides ───────────────────────────────────────────────────────────────────
const GUIDE_COLOR          = '#00DCFF';
const GUIDE_COLOR_SELECTED = '#0000FF';

// ── Ruler tool (screen-space measurement overlay) ────────────────────────────
const RULER_COLOR       = '#007aff';
const RULER_CROSSHAIR   = '#000000';
const RULER_HANDLE_SIZE = 9; // screen px, square edge
const RULER_HANDLE_HIT  = 7; // screen px, half-extent hit radius
const RULER_LINE_HIT    = 6; // screen px, perpendicular corridor

// ── ICO export ───────────────────────────────────────────────────────────────
const ICO_DEFAULT_SIZES = [256, 128, 64, 48, 32, 16];

// ── File I/O — supported MIME types ──────────────────────────────────────────
const RASTER_MIME_TYPES = new Set(['image/png','image/jpeg','image/jpg','image/gif','image/webp','image/bmp','image/avif']);
const ICO_MIME_TYPES    = new Set(['image/x-icon','image/vnd.microsoft.icon','image/ico']);

// ── Namespace — all values also accessible via window.OpsinConfig ─────────────
window.OpsinConfig = {
  HISTORY_MAX_BYTES,
  NUDGE_IDLE_MS,
  RULER_SIZE,
  GUIDE_COLOR,
  GUIDE_COLOR_SELECTED,
  RULER_COLOR,
  RULER_CROSSHAIR,
  RULER_HANDLE_SIZE,
  RULER_HANDLE_HIT,
  RULER_LINE_HIT,
  ICO_DEFAULT_SIZES,
  RASTER_MIME_TYPES,
  ICO_MIME_TYPES,
};
