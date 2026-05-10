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
const toolKeys = {v:'move',q:'movesel',h:'pan',m:'select',l:'lasso',w:'wand',r:'ruler',b:'brush',p:'pencil',e:'eraser',g:'fill',d:'gradient',t:'text',u:'shape',z:'zoom',a:'directselect'};

// ── Selection tool-button SVGs ────────────────────────────────────────────────
const RECT_SELECT_SVG    = '<svg><use href="#icon-select-rect"/></svg>';
const ELLIPSE_SELECT_SVG = '<svg><use href="#icon-select-ellipse"/></svg>';
const LASSO_SVG          = '<svg><use href="#icon-lasso-free"/></svg>';
const POLY_LASSO_SVG     = '<svg><use href="#icon-lasso-poly"/></svg>';
const MAG_LASSO_SVG      = '<svg><use href="#icon-lasso-magnetic"/></svg>';

// ── Pixel Transform rotation cursor (32×32, hotspot 16,16) ───────────────────
const _ROTATE_CURSOR_SVG = window.OpsinLinkedIcons ? window.OpsinLinkedIcons.getRawSvg('rotate-cursor') : '';
const ROTATE_CURSOR = "url('data:image/svg+xml;utf8," + encodeURIComponent(_ROTATE_CURSOR_SVG) + "') 16 16, grab";

// ── Eyedropper cursor (24×24, hotspot 2,22) ───────────────────────────────────
const _eyedropperCursorSvg = window.OpsinLinkedIcons ? window.OpsinLinkedIcons.getRawSvg('eyedropper-cursor') : '';
const _eyedropperCursorUrl = "url('data:image/svg+xml;utf8," + encodeURIComponent(_eyedropperCursorSvg) + "') 2 22, none";

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
