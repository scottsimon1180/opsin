"use strict";

/* ═══════════════════════════════════════════════════════
   OpsinConstants — true constants (identifiers, enum-like
   values, fixed SVG strings, cursor data, key maps)
   Loaded before history.js and all app scripts.
   ═══════════════════════════════════════════════════════ */

// ── History tile store ────────────────────────────────────────────────────────
const TILE_SIZE = 256; // px — edge length of each RGBA tile in the tile store

// ── ICO format discriminators ─────────────────────────────────────────────────
const FORMAT_PNG = 'png';
const FORMAT_BMP = 'bmp';

// ── Tool keyboard shortcuts ───────────────────────────────────────────────────
const toolKeys = {v:'move',q:'movesel',h:'pan',m:'select',l:'lasso',w:'wand',r:'ruler',b:'brush',p:'pencil',e:'eraser',g:'fill',d:'gradient',t:'text',u:'shape',z:'zoom'};

// ── Selection tool-button SVGs ────────────────────────────────────────────────
const RECT_SELECT_SVG    = '<svg><use href="#icon-select-rect"/></svg>';
const ELLIPSE_SELECT_SVG = '<svg><use href="#icon-select-ellipse"/></svg>';
const LASSO_SVG          = '<svg><use href="#icon-lasso-free"/></svg>';
const POLY_LASSO_SVG     = '<svg><use href="#icon-lasso-poly"/></svg>';
const MAG_LASSO_SVG      = '<svg><use href="#icon-lasso-magnetic"/></svg>';

// ── Pixel Transform rotation cursor (32×32, hotspot 16,16) ───────────────────
const _ROTATE_CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16 A10 10 0 1 1 16 26" stroke="#000" stroke-width="4"/><path d="M2 13 L6 16 L9 12" stroke="#000" stroke-width="4"/><path d="M20 26 L16 26 L18 22" stroke="#000" stroke-width="4"/><path d="M6 16 A10 10 0 1 1 16 26" stroke="#fff" stroke-width="2"/><path d="M2 13 L6 16 L9 12" stroke="#fff" stroke-width="2"/><path d="M20 26 L16 26 L18 22" stroke="#fff" stroke-width="2"/></g></svg>';
const ROTATE_CURSOR = "url('data:image/svg+xml;utf8," + encodeURIComponent(_ROTATE_CURSOR_SVG) + "') 16 16, grab";

// ── Eyedropper cursor (24×24, hotspot 2,22) ───────────────────────────────────
const _eyedropperCursorSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">' +
  '<path d="M14.31,7.57l2.11,2.11l-4.29,4.29c-1.47,1.47-3.1,2.78-4.85,3.9L4.09,19.9l2.03-3.18' +
  'c1.12-1.75,2.43-3.38,3.9-4.85L14.31,7.57M14.31,6.26l-4.95,4.95c-1.52,1.52-2.87,3.2-4.02,5.01' +
  'l-3.2,5.01v0.62h0.62l5.01-3.2c1.81-1.16,3.49-2.5,5.01-4.02l4.95-4.95L14.31,6.26L14.31,6.26z' +
  'M21.94,4.16c-0.22-1.04-1.05-1.87-2.09-2.09c-0.93-0.19-1.79,0.09-2.41,0.64l-0.01-0.01l-2.07,2.07' +
  'l-0.4-0.4l0,0c-0.37-0.37-0.9-0.57-1.48-0.48c-0.72,0.11-1.31,0.7-1.42,1.42c-0.09,0.58,0.11,1.11,0.48,1.48' +
  'l0,0l4.64,4.64l0,0c0.37,0.37,0.9,0.57,1.48,0.48c0.72-0.11,1.31-0.7,1.42-1.42c0.09-0.58-0.11-1.11-0.48-1.48' +
  'l0,0l-0.37-0.37l1.95-1.95c0.01-0.01,0.02-0.02,0.02-0.02l0.09-0.09l0,0C21.85,5.95,22.13,5.09,21.94,4.16z' +
  'M19.27,2.94c0.13,0,0.26,0.01,0.39,0.04c0.68,0.14,1.23,0.69,1.37,1.37c0.12,0.58-0.03,1.16-0.42,1.6' +
  'l-0.05,0.06l-0.02,0.02l-1.95,1.95l-0.66,0.66l0.66,0.66l0.37,0.37c0.18,0.18,0.26,0.43,0.22,0.68' +
  'c-0.05,0.32-0.32,0.59-0.64,0.64C18.49,11,18.44,11,18.4,11c-0.21,0-0.4-0.08-0.55-0.23l-4.64-4.64' +
  'C13.04,5.96,12.96,5.71,13,5.46c0.05-0.32,0.32-0.59,0.64-0.64c0.04-0.01,0.09-0.01,0.13-0.01' +
  'c0.21,0,0.4,0.08,0.55,0.23l0.4,0.4l0.66,0.66l0.66-0.66l1.95-1.95l0.09-0.08C18.4,3.11,18.83,2.94,19.27,2.94' +
  'M19.27,2.01c-0.7,0-1.34,0.27-1.82,0.7l-0.01-0.01l-2.07,2.07l-0.4-0.4l0,0c-0.31-0.31-0.74-0.5-1.21-0.5' +
  'c-0.09,0-0.18,0.01-0.27,0.02c-0.72,0.11-1.31,0.7-1.42,1.42c-0.09,0.58,0.11,1.11,0.48,1.48l0,0l4.64,4.64' +
  'l0,0c0.31,0.31,0.74,0.5,1.21,0.5c0.09,0,0.18-0.01,0.27-0.02c0.72-0.11,1.31-0.7,1.42-1.42' +
  'c0.09-0.58-0.11-1.11-0.48-1.48l0,0l-0.37-0.37l1.95-1.95c0.01-0.01,0.02-0.02,0.02-0.02l0.09-0.09l0,0' +
  'c0.55-0.62,0.83-1.48,0.64-2.41c-0.22-1.04-1.05-1.87-2.09-2.09C19.65,2.03,19.46,2.01,19.27,2.01L19.27,2.01z' +
  'M2.65,21.92l0.11-0.07l-0.62-0.62l-0.07,0.11C1.83,21.72,2.27,22.16,2.65,21.92z"' +
  ' fill="%23f2f2f7" stroke="black" stroke-width="0.5"/></svg>';
const _eyedropperCursorUrl = "url('data:image/svg+xml;utf8," + _eyedropperCursorSvg + "') 2 22, none";

// ── Namespace — all values also accessible via window.OpsinConstants ──────────
window.OpsinConstants = {
  TILE_SIZE,
  FORMAT_PNG,
  FORMAT_BMP,
  toolKeys,
  RECT_SELECT_SVG,
  ELLIPSE_SELECT_SVG,
  LASSO_SVG,
  POLY_LASSO_SVG,
  MAG_LASSO_SVG,
  _ROTATE_CURSOR_SVG,
  ROTATE_CURSOR,
  _eyedropperCursorSvg,
  _eyedropperCursorUrl,
};
