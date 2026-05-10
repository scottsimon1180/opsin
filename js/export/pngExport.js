"use strict";

/* ══════════════════════════════════════════════════════════════════════
   Opsin — PNG Export Dialog ("Save for Web Legacy"-style)
   ══════════════════════════════════════════════════════════════════════

   Provides:
     • Custom PNG encoder for color types 2 (RGB), 6 (RGBA), 3 (Indexed)
       with optional tRNS chunk for per-palette-entry alpha.
     • Median Cut quantizer with weighted variance (pngquant-style).
     • Floyd-Steinberg dither with a tunable diffusion coefficient.
     • A two-pane dialog: live preview (zoom/pan/checkerboard/file-size)
       on the left, encoding options + editable color table on the right.
     • A separate Quick Export entry that bypasses the dialog and writes
       a fully-lossless PNG-24/32.

   Public API (window.PngExport):
       openDialog()           — open the export dialog
       quickExport()          — one-click lossless PNG (no dialog)
       onColorPicked(hex)     — colorPicker dispatcher (script.js)
       onColorPickerCancelled()
       encodeRgba(rgba, w, h, opts)
       quantize(rgba, w, h, opts)

   ══════════════════════════════════════════════════════════════════════ */

(function () {

  /* ═══ CRC-32 ════════════════════════════════════════════════════════ */
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf, start, end) {
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ═══ Adler-32 ══════════════════════════════════════════════════════ */
  function adler32(buf) {
    let a = 1, b = 0;
    const MOD = 65521;
    for (let i = 0; i < buf.length; i++) {
      a = (a + buf[i]) % MOD;
      b = (b + a) % MOD;
    }
    return ((b << 16) | a) >>> 0;
  }

  /* ═══ DEFLATE (stored / BTYPE=00) ═══════════════════════════════════
     Pluggable: a single function `deflate(uint8) -> uint8` is the only
     call site. v1 emits raw stored blocks (max 65535 bytes/block) wrapped
     in a zlib stream. PNG decoders accept this; output decodes to bit-
     identical pixels as a fully-compressed PNG. File sizes are larger.
     A future upgrade to fixed-Huffman+LZ77 replaces this function only.
     ════════════════════════════════════════════════════════════════════ */
  function deflate(input) {
    const MAX_BLOCK = 65535;
    const blocks = Math.max(1, Math.ceil(input.length / MAX_BLOCK));
    const out = new Uint8Array(2 + blocks * 5 + input.length + 4);
    let p = 0;
    out[p++] = 0x78; // CMF: deflate, 32K window
    out[p++] = 0x01; // FLG: no preset dict, fastest, FCHECK so (0x78<<8|0x01)%31==0
    let pos = 0;
    while (pos < input.length || (pos === 0 && input.length === 0)) {
      const len = Math.min(MAX_BLOCK, input.length - pos);
      const last = (pos + len) >= input.length ? 1 : 0;
      out[p++] = last;                    // BFINAL bit + BTYPE=00 (5 padding bits)
      out[p++] = len & 0xFF;
      out[p++] = (len >>> 8) & 0xFF;
      out[p++] = (~len) & 0xFF;
      out[p++] = (~len >>> 8) & 0xFF;
      for (let i = 0; i < len; i++) out[p++] = input[pos + i];
      pos += len;
      if (input.length === 0) break;
    }
    const adler = adler32(input);
    out[p++] = (adler >>> 24) & 0xFF;
    out[p++] = (adler >>> 16) & 0xFF;
    out[p++] = (adler >>> 8) & 0xFF;
    out[p++] = adler & 0xFF;
    return out.subarray(0, p);
  }

  /* ═══ PNG ENCODER ═══════════════════════════════════════════════════ */
  const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  function writeChunk(chunks, type, data) {
    const len = data.length;
    const buf = new Uint8Array(8 + len + 4);
    buf[0] = (len >>> 24) & 0xFF; buf[1] = (len >>> 16) & 0xFF;
    buf[2] = (len >>> 8) & 0xFF;  buf[3] = len & 0xFF;
    buf[4] = type.charCodeAt(0); buf[5] = type.charCodeAt(1);
    buf[6] = type.charCodeAt(2); buf[7] = type.charCodeAt(3);
    for (let i = 0; i < len; i++) buf[8 + i] = data[i];
    const c = crc32(buf, 4, 8 + len);
    buf[8 + len] = (c >>> 24) & 0xFF; buf[9 + len] = (c >>> 16) & 0xFF;
    buf[10 + len] = (c >>> 8) & 0xFF; buf[11 + len] = c & 0xFF;
    chunks.push(buf);
  }

  /* encodeRgba — top-level PNG writer.
     opts:
       colorType  : 2 (RGB), 6 (RGBA), 3 (Indexed). default 6.
       palette    : Uint8Array of [r,g,b]*N      (color type 3)
       trns       : Uint8Array of alpha bytes    (color type 3, optional)
       indexedPx  : Uint8Array length=w*h        (color type 3, palette indices)
     Returns: Blob (image/png).
  */
  function encodeRgba(rgba, w, h, opts) {
    opts = opts || {};
    const colorType = opts.colorType !== undefined ? opts.colorType : 6;
    const chunks = [PNG_SIG];

    // IHDR
    const ihdr = new Uint8Array(13);
    ihdr[0] = (w >>> 24) & 0xFF; ihdr[1] = (w >>> 16) & 0xFF;
    ihdr[2] = (w >>> 8) & 0xFF;  ihdr[3] = w & 0xFF;
    ihdr[4] = (h >>> 24) & 0xFF; ihdr[5] = (h >>> 16) & 0xFF;
    ihdr[6] = (h >>> 8) & 0xFF;  ihdr[7] = h & 0xFF;
    ihdr[8] = 8;          // bit depth
    ihdr[9] = colorType;  // 2 RGB / 6 RGBA / 3 Indexed
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // compression, filter, interlace
    writeChunk(chunks, 'IHDR', ihdr);

    // PLTE + tRNS for indexed
    if (colorType === 3) {
      writeChunk(chunks, 'PLTE', opts.palette);
      if (opts.trns && opts.trns.length > 0) {
        // Trim trailing 255 entries — spec allows any prefix length up to palette size.
        let trnsLen = opts.trns.length;
        while (trnsLen > 0 && opts.trns[trnsLen - 1] === 255) trnsLen--;
        if (trnsLen > 0) writeChunk(chunks, 'tRNS', opts.trns.subarray(0, trnsLen));
      }
    }

    // Build raw pixel stream: filter byte (0 = None) per scanline + pixels
    let bpp;
    let raw;
    if (colorType === 2) {
      bpp = 3;
      raw = new Uint8Array(h * (1 + w * 3));
      let p = 0, q = 0;
      for (let y = 0; y < h; y++) {
        raw[p++] = 0;
        for (let x = 0; x < w; x++) {
          raw[p++] = rgba[q]; raw[p++] = rgba[q + 1]; raw[p++] = rgba[q + 2];
          q += 4;
        }
      }
    } else if (colorType === 6) {
      bpp = 4;
      raw = new Uint8Array(h * (1 + w * 4));
      let p = 0, q = 0;
      for (let y = 0; y < h; y++) {
        raw[p++] = 0;
        for (let x = 0; x < w; x++) {
          raw[p++] = rgba[q]; raw[p++] = rgba[q + 1]; raw[p++] = rgba[q + 2]; raw[p++] = rgba[q + 3];
          q += 4;
        }
      }
    } else if (colorType === 3) {
      bpp = 1;
      const idx = opts.indexedPx;
      raw = new Uint8Array(h * (1 + w));
      let p = 0, q = 0;
      for (let y = 0; y < h; y++) {
        raw[p++] = 0;
        for (let x = 0; x < w; x++) raw[p++] = idx[q++];
      }
    } else {
      throw new Error('PngExport: unsupported colorType ' + colorType);
    }

    const compressed = deflate(raw);
    writeChunk(chunks, 'IDAT', compressed);
    writeChunk(chunks, 'IEND', new Uint8Array(0));

    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return new Blob([out], { type: 'image/png' });
  }

  /* ═══ QUANTIZATION — Median Cut with weighted variance ══════════════
     4-D RGBA space (alpha is a real channel — clusters transparent
     pixels separately). Variance is luma-weighted on the RGB axes
     (matches pngquant); alpha gets a flat weight of 1.0 since modest
     alpha differences are visually significant.

     Inputs:
       rgba       : Uint8ClampedArray of pixel data (length = w*h*4)
       w, h       : dimensions
       targetN    : desired palette size (1..256)
       lockedRGBA : Uint8Array [r,g,b,a]*K of pre-locked palette entries
                    (seeded into the output palette before cutting)

     Output:
       { palette: Uint8Array [r,g,b,a]*N,    // includes alpha channel
         lookup:  function(r,g,b,a) -> idx,  // nearest-color in palette
         actualN: int                        // <= targetN
       }
     ════════════════════════════════════════════════════════════════════ */
  const LUMA_R = 0.299, LUMA_G = 0.587, LUMA_B = 0.114;

  function buildHistogram(rgba) {
    // Map keyed by 32-bit packed RGBA -> count
    const map = new Map();
    for (let i = 0; i < rgba.length; i += 4) {
      const k = (rgba[i] << 24) | (rgba[i + 1] << 16) | (rgba[i + 2] << 8) | rgba[i + 3];
      map.set(k, (map.get(k) || 0) + 1);
    }
    const n = map.size;
    const colors = new Uint8Array(n * 4);
    const counts = new Uint32Array(n);
    let i = 0;
    for (const [k, c] of map) {
      colors[i * 4]     = (k >>> 24) & 0xFF;
      colors[i * 4 + 1] = (k >>> 16) & 0xFF;
      colors[i * 4 + 2] = (k >>> 8) & 0xFF;
      colors[i * 4 + 3] = k & 0xFF;
      counts[i] = c;
      i++;
    }
    return { colors: colors, counts: counts, n: n };
  }

  function boxStats(hist, indices) {
    // Compute weighted centroid + per-axis weighted variance for a box.
    let sumR = 0, sumG = 0, sumB = 0, sumA = 0, sumW = 0;
    const c = hist.colors, ct = hist.counts;
    for (let i = 0; i < indices.length; i++) {
      const k = indices[i], w = ct[k];
      sumR += c[k * 4]     * w;
      sumG += c[k * 4 + 1] * w;
      sumB += c[k * 4 + 2] * w;
      sumA += c[k * 4 + 3] * w;
      sumW += w;
    }
    const mR = sumR / sumW, mG = sumG / sumW, mB = sumB / sumW, mA = sumA / sumW;
    let vR = 0, vG = 0, vB = 0, vA = 0;
    for (let i = 0; i < indices.length; i++) {
      const k = indices[i], w = ct[k];
      const dr = c[k * 4]     - mR;
      const dg = c[k * 4 + 1] - mG;
      const db = c[k * 4 + 2] - mB;
      const da = c[k * 4 + 3] - mA;
      vR += dr * dr * w; vG += dg * dg * w;
      vB += db * db * w; vA += da * da * w;
    }
    // Luma-weight RGB variance (perceptual); alpha gets full weight.
    const score = LUMA_R * vR + LUMA_G * vG + LUMA_B * vB + vA;
    return { mR: mR, mG: mG, mB: mB, mA: mA, vR: vR, vG: vG, vB: vB, vA: vA, score: score, weight: sumW };
  }

  function medianCut(hist, targetN) {
    // Each box = array of color indices (into hist.colors).
    const allIdx = new Uint32Array(hist.n);
    for (let i = 0; i < hist.n; i++) allIdx[i] = i;
    const boxes = [{ idx: Array.from(allIdx), stats: null }];
    boxes[0].stats = boxStats(hist, boxes[0].idx);

    while (boxes.length < targetN) {
      // Pick the box with highest weighted variance score.
      let best = -1, bestScore = -1;
      for (let i = 0; i < boxes.length; i++) {
        if (boxes[i].idx.length < 2) continue;
        if (boxes[i].stats.score > bestScore) { bestScore = boxes[i].stats.score; best = i; }
      }
      if (best < 0) break;
      const box = boxes[best];

      // Cut along axis with greatest individual variance.
      const s = box.stats;
      let axis = 0, mx = s.vR;
      if (s.vG > mx) { axis = 1; mx = s.vG; }
      if (s.vB > mx) { axis = 2; mx = s.vB; }
      if (s.vA > mx) { axis = 3; mx = s.vA; }

      // Sort indices by the chosen channel.
      const c = hist.colors;
      box.idx.sort((a, b) => c[a * 4 + axis] - c[b * 4 + axis]);

      // Find median by weighted count (split at half-weight).
      const ct = hist.counts;
      let halfWeight = s.weight / 2;
      let acc = 0, splitAt = 0;
      for (let i = 0; i < box.idx.length; i++) {
        acc += ct[box.idx[i]];
        if (acc >= halfWeight) { splitAt = i + 1; break; }
      }
      if (splitAt < 1) splitAt = 1;
      if (splitAt >= box.idx.length) splitAt = box.idx.length - 1;

      const left = box.idx.slice(0, splitAt);
      const right = box.idx.slice(splitAt);
      const leftBox = { idx: left, stats: boxStats(hist, left) };
      const rightBox = { idx: right, stats: boxStats(hist, right) };
      boxes.splice(best, 1, leftBox, rightBox);
    }
    return boxes;
  }

  function quantize(rgba, w, h, opts) {
    opts = opts || {};
    const targetN = Math.max(1, Math.min(256, opts.targetN || 256));
    const lockedRGBA = opts.lockedRGBA || null;

    const hist = (opts._cachedHist) || buildHistogram(rgba);

    // If there's already <= targetN unique colors, palette = identity.
    if (hist.n <= targetN) {
      const palette = new Uint8Array(hist.n * 4);
      for (let i = 0; i < hist.n; i++) {
        palette[i * 4]     = hist.colors[i * 4];
        palette[i * 4 + 1] = hist.colors[i * 4 + 1];
        palette[i * 4 + 2] = hist.colors[i * 4 + 2];
        palette[i * 4 + 3] = hist.colors[i * 4 + 3];
      }
      return { palette: palette, actualN: hist.n, _hist: hist };
    }

    // Reserve slots for locked colors.
    const lockedN = lockedRGBA ? (lockedRGBA.length / 4) | 0 : 0;
    const cutN = Math.max(1, targetN - lockedN);
    const boxes = medianCut(hist, cutN);

    const totalN = boxes.length + lockedN;
    const palette = new Uint8Array(totalN * 4);
    let p = 0;
    if (lockedN > 0) {
      for (let i = 0; i < lockedN; i++) {
        palette[p++] = lockedRGBA[i * 4];
        palette[p++] = lockedRGBA[i * 4 + 1];
        palette[p++] = lockedRGBA[i * 4 + 2];
        palette[p++] = lockedRGBA[i * 4 + 3];
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      const s = boxes[i].stats;
      palette[p++] = Math.max(0, Math.min(255, Math.round(s.mR)));
      palette[p++] = Math.max(0, Math.min(255, Math.round(s.mG)));
      palette[p++] = Math.max(0, Math.min(255, Math.round(s.mB)));
      palette[p++] = Math.max(0, Math.min(255, Math.round(s.mA)));
    }
    return { palette: palette, actualN: totalN, _hist: hist };
  }

  /* ═══ NEAREST-COLOR LOOKUP ═══════════════════════════════════════════
     Linear scan over palette. For typical N <= 256 this is fast enough
     for live preview; an octree accelerator could be added later.
     ════════════════════════════════════════════════════════════════════ */
  function nearestIndex(palette, r, g, b, a) {
    const N = (palette.length / 4) | 0;
    let best = 0, bestD = 1e18;
    for (let i = 0; i < N; i++) {
      const dr = palette[i * 4]     - r;
      const dg = palette[i * 4 + 1] - g;
      const db = palette[i * 4 + 2] - b;
      const da = palette[i * 4 + 3] - a;
      // Same luma-weighted RGB metric used by the cutter, plus alpha.
      const d = LUMA_R * dr * dr + LUMA_G * dg * dg + LUMA_B * db * db + da * da;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  /* ═══ FLOYD-STEINBERG DITHER ═══════════════════════════════════════
     Coefficients: 7/16 (right), 3/16 (below-left), 5/16 (below),
     1/16 (below-right). Slider 0..1 scales all four linearly. At 0 we
     short-circuit to nearest-color (no error buffer allocated).

     Input rgba is unmodified. Output is a Uint8Array of palette indices
     length w*h. matteRgb is applied first if color type 6 -> 3 with
     'Transparency: off'; pass null to keep alpha.
     ════════════════════════════════════════════════════════════════════ */
  function quantizeAndDither(rgba, w, h, palette, ditherStrength, matteRgb) {
    const out = new Uint8Array(w * h);
    const ds = Math.max(0, Math.min(1, ditherStrength || 0));

    if (ds === 0 && !matteRgb) {
      let q = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        out[q++] = nearestIndex(palette, rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
      }
      return out;
    }

    // Working buffer in Float32 so error accumulation can go negative / >255.
    const buf = new Float32Array(w * h * 4);
    if (matteRgb) {
      // Composite onto matte color (alpha -> 255).
      const mr = matteRgb[0], mg = matteRgb[1], mb = matteRgb[2];
      for (let i = 0, q = 0; i < rgba.length; i += 4, q += 4) {
        const a = rgba[i + 3] / 255;
        buf[q]     = rgba[i]     * a + mr * (1 - a);
        buf[q + 1] = rgba[i + 1] * a + mg * (1 - a);
        buf[q + 2] = rgba[i + 2] * a + mb * (1 - a);
        buf[q + 3] = 255;
      }
    } else {
      for (let i = 0; i < rgba.length; i++) buf[i] = rgba[i];
    }

    const c7 = (7 / 16) * ds, c3 = (3 / 16) * ds, c5 = (5 / 16) * ds, c1 = (1 / 16) * ds;
    let q = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2], a = buf[i + 3];
        const idx = nearestIndex(
          palette,
          Math.max(0, Math.min(255, r | 0)),
          Math.max(0, Math.min(255, g | 0)),
          Math.max(0, Math.min(255, b | 0)),
          Math.max(0, Math.min(255, a | 0))
        );
        out[q++] = idx;
        if (ds > 0) {
          const er = r - palette[idx * 4];
          const eg = g - palette[idx * 4 + 1];
          const eb = b - palette[idx * 4 + 2];
          const ea = a - palette[idx * 4 + 3];
          if (x + 1 < w) {
            buf[i + 4]     += er * c7; buf[i + 5] += eg * c7;
            buf[i + 6]     += eb * c7; buf[i + 7] += ea * c7;
          }
          if (y + 1 < h) {
            const j = ((y + 1) * w + x) * 4;
            if (x > 0) {
              buf[j - 4] += er * c3; buf[j - 3] += eg * c3;
              buf[j - 2] += eb * c3; buf[j - 1] += ea * c3;
            }
            buf[j]     += er * c5; buf[j + 1] += eg * c5;
            buf[j + 2] += eb * c5; buf[j + 3] += ea * c5;
            if (x + 1 < w) {
              buf[j + 4] += er * c1; buf[j + 5] += eg * c1;
              buf[j + 6] += eb * c1; buf[j + 7] += ea * c1;
            }
          }
        }
      }
    }
    return out;
  }

  /* ═══ PALETTE → PLTE / tRNS HELPERS ═════════════════════════════════ */
  function paletteRgbBytes(palette) {
    const N = (palette.length / 4) | 0;
    const out = new Uint8Array(N * 3);
    for (let i = 0; i < N; i++) {
      out[i * 3]     = palette[i * 4];
      out[i * 3 + 1] = palette[i * 4 + 1];
      out[i * 3 + 2] = palette[i * 4 + 2];
    }
    return out;
  }
  function paletteAlphaBytes(palette) {
    const N = (palette.length / 4) | 0;
    const out = new Uint8Array(N);
    for (let i = 0; i < N; i++) out[i] = palette[i * 4 + 3];
    return out;
  }

  /* ═══ HEX <-> RGB ═══════════════════════════════════════════════════ */
  function hexToRgb(hex) {
    if (!hex) return [255, 255, 255];
    const s = hex.replace('#', '');
    if (s.length === 3) {
      return [parseInt(s[0] + s[0], 16), parseInt(s[1] + s[1], 16), parseInt(s[2] + s[2], 16)];
    }
    return [parseInt(s.substring(0, 2), 16), parseInt(s.substring(2, 4), 16), parseInt(s.substring(4, 6), 16)];
  }
  function rgbToHex(r, g, b) {
    const h = (n) => { const s = n.toString(16); return s.length === 1 ? '0' + s : s; };
    return '#' + h(r) + h(g) + h(b);
  }

  /* ═══ STATE ═════════════════════════════════════════════════════════ */
  const STATE = {
    open: false,
    sourceRgba: null,         // ImageData of compositeCanvas
    w: 0, h: 0,
    mode: 'png24',            // 'png24' | 'png8'
    colors: 256,
    dither: 100,              // 0..100
    matteRgb: [255, 255, 255],
    transparency: true,       // PNG-8 only — when false, composite onto matte
    palette: null,            // current Uint8Array [r,g,b,a]*N
    locks: [],                // boolean[] — same length as palette/4
    indexedPx: null,          // last quantized index buffer
    encodedBlob: null,        // last encoded PNG Blob
    encodedSize: 0,
    hist: null,               // cached histogram
    renderToken: 0,
    workingBadgeShown: false,
    debounceTimer: 0,
    previewZoom: 1,
    previewPanX: 0,
    previewPanY: 0,
    previewFitOnce: true,
    previewHover: false,
    previewIsPanning: false,
    previewPanStart: null,
    spaceHeld: false
  };

  /* ═══ DIALOG OPEN / CLOSE ═══════════════════════════════════════════ */
  function openDialog() {
    if (typeof closeAllMenus === 'function') closeAllMenus();
    if (window.IEM && window.IEM.active) {
      // IEM owns its own export flow; defer to it.
      window.IEM.exportCurrentAsPng();
      return;
    }
    const modal = document.getElementById('pngExportModal');
    if (!modal) return;

    // Snapshot from the live composite canvas (matches what user sees).
    const cc = document.getElementById('compositeCanvas');
    if (!cc || cc.width === 0 || cc.height === 0) return;
    const ctx = cc.getContext('2d');
    STATE.w = cc.width; STATE.h = cc.height;
    STATE.sourceRgba = ctx.getImageData(0, 0, STATE.w, STATE.h);
    STATE.hist = null;
    STATE.palette = null;
    STATE.locks = [];
    STATE.indexedPx = null;
    STATE.encodedBlob = null;
    STATE.encodedSize = 0;
    STATE.previewZoom = 1;
    STATE.previewPanX = 0;
    STATE.previewPanY = 0;
    STATE.previewFitOnce = true;

    // Reset UI to defaults.
    setMode('png24');
    setColorsValue(256);
    setDitherValue(100);
    setMatteHex('#ffffff');
    setTransparency(true);

    modal.classList.add('show');
    STATE.open = true;
    requestAnimationFrame(() => { fitPreview(); scheduleRender(0); });
  }

  function closeDialog() {
    const modal = document.getElementById('pngExportModal');
    if (modal) modal.classList.remove('show');
    STATE.open = false;
    STATE.sourceRgba = null;
    STATE.hist = null;
    STATE.palette = null;
    STATE.indexedPx = null;
    STATE.encodedBlob = null;
    STATE.renderToken++;
  }

  /* ═══ QUICK EXPORT (PNG-24, no dialog) ══════════════════════════════ */
  function quickExport() {
    if (typeof closeAllMenus === 'function') closeAllMenus();
    if (window.IEM && window.IEM.active) {
      window.IEM.exportCurrentAsPng();
      return;
    }
    const cc = document.getElementById('compositeCanvas');
    if (!cc) return;
    const ctx = cc.getContext('2d');
    const w = cc.width, h = cc.height;
    const rgba = ctx.getImageData(0, 0, w, h).data;
    // Auto-detect: use type 6 if any alpha < 255, else type 2.
    let hasAlpha = false;
    for (let i = 3; i < rgba.length; i += 4) { if (rgba[i] < 255) { hasAlpha = true; break; } }
    const blob = encodeRgba(rgba, w, h, { colorType: hasAlpha ? 6 : 2 });
    triggerDownload(blob, 'image.png');
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ═══ COMMIT EXPORT (from dialog) ═══════════════════════════════════ */
  function commitExport() {
    if (!STATE.encodedBlob) return;
    triggerDownload(STATE.encodedBlob, 'image.png');
    closeDialog();
  }

  /* ═══ RENDER PIPELINE — chunked + cancellable ═══════════════════════ */
  function scheduleRender(delay) {
    if (STATE.debounceTimer) clearTimeout(STATE.debounceTimer);
    STATE.debounceTimer = setTimeout(runRender, delay === undefined ? 250 : delay);
  }

  function runRender() {
    STATE.debounceTimer = 0;
    const myToken = ++STATE.renderToken;
    const startedAt = performance.now();
    let badgeTimer = setTimeout(() => { showWorkingBadge(true); }, 100);

    const finish = () => {
      clearTimeout(badgeTimer);
      showWorkingBadge(false);
    };

    if (!STATE.sourceRgba) { finish(); return; }
    const src = STATE.sourceRgba.data, w = STATE.w, h = STATE.h;

    if (STATE.mode === 'png24') {
      // Lossless: skip quantization, encode straight.
      setTimeout(() => {
        if (myToken !== STATE.renderToken) { finish(); return; }
        const blob = encodeRgba(src, w, h, { colorType: 6 });
        STATE.encodedBlob = blob;
        STATE.encodedSize = blob.size;
        renderPreviewCanvas(src, w, h);
        updateSizeReadout();
        finish();
      }, 0);
      return;
    }

    // PNG-8 path
    setTimeout(() => {
      if (myToken !== STATE.renderToken) { finish(); return; }
      if (!STATE.hist) STATE.hist = buildHistogram(src);

      setTimeout(() => {
        if (myToken !== STATE.renderToken) { finish(); return; }
        const lockedRGBA = collectLockedRGBA();
        const target = clampColorTarget(STATE.colors);
        const q = quantize(src, w, h, { targetN: target, lockedRGBA: lockedRGBA, _cachedHist: STATE.hist });

        // Preserve user-edited swatches by replacing palette entries with locks (already merged in quantize).
        STATE.palette = q.palette;
        // Always rebuild locks: quantize() places locked colors at indices
        // [0..lockedN-1], so STATE.locks must mirror that ordering even if
        // the total palette length didn't change.
        const newLocks = new Array((q.palette.length / 4) | 0).fill(false);
        const lockedN = lockedRGBA ? (lockedRGBA.length / 4) | 0 : 0;
        for (let i = 0; i < lockedN; i++) newLocks[i] = true;
        STATE.locks = newLocks;

        setTimeout(() => {
          if (myToken !== STATE.renderToken) { finish(); return; }
          const matte = STATE.transparency ? null : STATE.matteRgb;
          const idx = quantizeAndDither(src, w, h, STATE.palette, STATE.dither / 100, matte);
          STATE.indexedPx = idx;

          setTimeout(() => {
            if (myToken !== STATE.renderToken) { finish(); return; }
            const plte = paletteRgbBytes(STATE.palette);
            const trns = STATE.transparency ? paletteAlphaBytes(STATE.palette) : null;
            const blob = encodeRgba(null, w, h, {
              colorType: 3, palette: plte, trns: trns, indexedPx: idx
            });
            STATE.encodedBlob = blob;
            STATE.encodedSize = blob.size;
            renderQuantizedPreview(idx, STATE.palette, w, h, matte);
            renderColorTable();
            updateSizeReadout();
            finish();
          }, 0);
        }, 0);
      }, 0);
    }, 0);
  }

  function clampColorTarget(n) {
    n = parseInt(n, 10);
    if (isNaN(n) || n < 1) n = 1;
    if (n > 256) n = 256;
    return n;
  }

  function collectLockedRGBA() {
    if (!STATE.palette || !STATE.locks) return null;
    const N = (STATE.palette.length / 4) | 0;
    const locked = [];
    for (let i = 0; i < N; i++) {
      if (STATE.locks[i]) {
        locked.push(STATE.palette[i * 4], STATE.palette[i * 4 + 1], STATE.palette[i * 4 + 2], STATE.palette[i * 4 + 3]);
      }
    }
    return locked.length > 0 ? new Uint8Array(locked) : null;
  }

  /* ═══ PREVIEW CANVAS RENDER ═════════════════════════════════════════ */
  function renderPreviewCanvas(rgba, w, h) {
    const cv = document.getElementById('pngExportPreviewCanvas');
    if (!cv) return;
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const id = ctx.createImageData(w, h);
    id.data.set(rgba);
    ctx.putImageData(id, 0, 0);
    applyPreviewTransform();
  }

  function renderQuantizedPreview(idx, palette, w, h, matteRgb) {
    const cv = document.getElementById('pngExportPreviewCanvas');
    if (!cv) return;
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const id = ctx.createImageData(w, h);
    const dst = id.data;
    for (let i = 0, j = 0; i < idx.length; i++, j += 4) {
      const k = idx[i];
      dst[j]     = palette[k * 4];
      dst[j + 1] = palette[k * 4 + 1];
      dst[j + 2] = palette[k * 4 + 2];
      dst[j + 3] = palette[k * 4 + 3];
    }
    ctx.putImageData(id, 0, 0);
    applyPreviewTransform();
  }

  function applyPreviewTransform() {
    const cv = document.getElementById('pngExportPreviewCanvas');
    if (!cv) return;
    cv.style.transform = `translate(${STATE.previewPanX}px, ${STATE.previewPanY}px) scale(${STATE.previewZoom})`;
    cv.style.imageRendering = STATE.previewZoom >= 1 ? 'pixelated' : 'auto';
    const z = document.getElementById('pngExportZoomReadout');
    if (z) z.textContent = Math.round(STATE.previewZoom * 100) + '%';
  }

  function fitPreview() {
    const stage = document.getElementById('pngExportPreviewStage');
    if (!stage || !STATE.w || !STATE.h) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const pad = 20;
    const sx = (rect.width - pad * 2) / STATE.w;
    const sy = (rect.height - pad * 2) / STATE.h;
    STATE.previewZoom = Math.min(sx, sy, 1);
    centerPreview(rect);
  }
  function centerPreview(rect) {
    if (!rect) {
      const stage = document.getElementById('pngExportPreviewStage');
      if (!stage) return;
      rect = stage.getBoundingClientRect();
    }
    STATE.previewPanX = (rect.width - STATE.w * STATE.previewZoom) / 2;
    STATE.previewPanY = (rect.height - STATE.h * STATE.previewZoom) / 2;
    applyPreviewTransform();
  }

  function previewZoomTo(newZoom, cx, cy) {
    const stage = document.getElementById('pngExportPreviewStage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (cx === undefined) cx = rect.width / 2;
    if (cy === undefined) cy = rect.height / 2;
    const worldX = (cx - STATE.previewPanX) / STATE.previewZoom;
    const worldY = (cy - STATE.previewPanY) / STATE.previewZoom;
    STATE.previewZoom = Math.max(0.1, Math.min(8, newZoom));
    STATE.previewPanX = cx - worldX * STATE.previewZoom;
    STATE.previewPanY = cy - worldY * STATE.previewZoom;
    applyPreviewTransform();
  }

  /* ═══ FILE SIZE / WORKING BADGE / ZOOM READOUT ══════════════════════ */
  function updateSizeReadout() {
    const el = document.getElementById('pngExportSizeReadout');
    if (!el) return;
    el.textContent = formatBytes(STATE.encodedSize) + ' · ' + STATE.w + ' × ' + STATE.h;
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function showWorkingBadge(visible) {
    const b = document.getElementById('pngExportWorkingBadge');
    if (!b) return;
    if (visible && !STATE.workingBadgeShown) { b.classList.add('show'); STATE.workingBadgeShown = true; }
    else if (!visible && STATE.workingBadgeShown) { b.classList.remove('show'); STATE.workingBadgeShown = false; }
  }

  /* ═══ COLOR TABLE RENDER ═══════════════════════════════════════════ */
  function renderColorTable() {
    const grid = document.getElementById('pngExportColorTable');
    if (!grid || !STATE.palette) return;
    const N = (STATE.palette.length / 4) | 0;
    const frags = [];
    for (let i = 0; i < N; i++) {
      const r = STATE.palette[i * 4];
      const g = STATE.palette[i * 4 + 1];
      const b = STATE.palette[i * 4 + 2];
      const a = STATE.palette[i * 4 + 3];
      const locked = !!STATE.locks[i];
      const hex = rgbToHex(r, g, b);
      frags.push(
        `<div class="png-export-swatch${locked ? ' locked' : ''}" data-idx="${i}" ` +
        `title="${hex}  α=${a}  (#${i})" ` +
        `style="background:rgba(${r},${g},${b},${a / 255})"></div>`
      );
    }
    frags.push(`<div class="png-export-swatch png-export-swatch-add" id="pngExportSwatchAdd" title="Add color"></div>`);
    grid.innerHTML = frags.join('');
    // Update count readout
    const cn = document.getElementById('pngExportActualCount');
    if (cn) cn.textContent = N + ' color' + (N === 1 ? '' : 's');
  }

  /* ═══ OPTION SETTERS ═══════════════════════════════════════════════ */
  function setMode(m) {
    STATE.mode = m;
    const r24 = document.getElementById('pngExportRadio24');
    const r8  = document.getElementById('pngExportRadio8');
    if (r24) r24.checked = (m === 'png24');
    if (r8)  r8.checked  = (m === 'png8');
    const r24Row = r24 && r24.closest('.png-export-radio-row');
    const r8Row  = r8  && r8.closest('.png-export-radio-row');
    if (r24Row) r24Row.classList.toggle('selected', m === 'png24');
    if (r8Row)  r8Row.classList.toggle('selected',  m === 'png8');
    const sec = document.getElementById('pngExportPng8Section');
    if (sec) sec.classList.toggle('disabled', m !== 'png8');
    const ct = document.getElementById('pngExportColorTableWrap');
    if (ct) ct.classList.toggle('disabled', m !== 'png8');
    STATE.indexedPx = null;
    scheduleRender();
  }

  function setColorsValue(n) {
    STATE.colors = clampColorTarget(n);
    const sel = document.getElementById('pngExportColorSelect');
    const inp = document.getElementById('pngExportColorInput');
    const presets = [2, 4, 8, 16, 32, 64, 128, 256];
    if (sel) sel.value = presets.indexOf(STATE.colors) >= 0 ? String(STATE.colors) : 'custom';
    if (inp) inp.value = String(STATE.colors);
    STATE.indexedPx = null;
    scheduleRender();
  }

  function setDitherValue(n) {
    STATE.dither = Math.max(0, Math.min(100, parseInt(n, 10) || 0));
    const sl = document.getElementById('pngExportDither');
    const rd = document.getElementById('pngExportDitherReadout');
    if (sl) sl.value = String(STATE.dither);
    if (rd) rd.textContent = STATE.dither + '%';
    // Dither change reuses palette; only re-runs assignment.
    STATE.indexedPx = null;
    scheduleRender();
  }

  function setMatteHex(hex) {
    const rgb = hexToRgb(hex);
    STATE.matteRgb = rgb;
    const w = document.getElementById('pngExportMatteWell');
    if (w) w.style.background = rgbToHex(rgb[0], rgb[1], rgb[2]);
    if (!STATE.transparency) scheduleRender();
  }

  function setTransparency(on) {
    STATE.transparency = !!on;
    const cb = document.getElementById('pngExportTransparency');
    if (cb) cb.checked = STATE.transparency;
    scheduleRender();
  }

  /* ═══ COLOR PICKER ROUTING (called by script.js) ═══════════════════ */
  function onColorPicked(hex) {
    const rgb = hexToRgb(hex);
    if (PCKR_TARGET === 'palette' && PCKR_INDEX >= 0 && STATE.palette) {
      // Override: replace palette entry in place, keep existing indexedPx.
      // Pixels mapped to this slot will now display the new color.
      const i = PCKR_INDEX;
      STATE.palette[i * 4]     = rgb[0];
      STATE.palette[i * 4 + 1] = rgb[1];
      STATE.palette[i * 4 + 2] = rgb[2];
      STATE.locks[i] = true;
      rerenderWithExistingPalette();
    } else if (PCKR_TARGET === 'palette-add' && STATE.palette) {
      // Add a new locked palette entry; full re-render to remap pixels.
      const N = (STATE.palette.length / 4) | 0;
      if (N < 256) {
        const newPal = new Uint8Array((N + 1) * 4);
        newPal.set(STATE.palette);
        newPal[N * 4]     = rgb[0]; newPal[N * 4 + 1] = rgb[1];
        newPal[N * 4 + 2] = rgb[2]; newPal[N * 4 + 3] = 255;
        STATE.palette = newPal;
        STATE.locks.push(true);
        STATE.indexedPx = null;
        scheduleRender(0);
      }
    } else if (PCKR_TARGET === 'matte') {
      setMatteHex(hex);
    }
    PCKR_TARGET = null; PCKR_INDEX = -1;
  }

  function rerenderWithExistingPalette() {
    if (!STATE.palette || !STATE.indexedPx) { scheduleRender(0); return; }
    const matte = STATE.transparency ? null : STATE.matteRgb;
    const plte = paletteRgbBytes(STATE.palette);
    const trns = STATE.transparency ? paletteAlphaBytes(STATE.palette) : null;
    const blob = encodeRgba(null, STATE.w, STATE.h, {
      colorType: 3, palette: plte, trns: trns, indexedPx: STATE.indexedPx
    });
    STATE.encodedBlob = blob;
    STATE.encodedSize = blob.size;
    renderQuantizedPreview(STATE.indexedPx, STATE.palette, STATE.w, STATE.h, matte);
    renderColorTable();
    updateSizeReadout();
  }
  function onColorPickerCancelled() {
    PCKR_TARGET = null; PCKR_INDEX = -1;
  }
  let PCKR_TARGET = null;
  let PCKR_INDEX = -1;
  function openPickerForSwatch(idx) {
    if (typeof toggleColorPicker !== 'function') return;
    PCKR_TARGET = 'palette'; PCKR_INDEX = idx;
    window.pngPaletteEditMode = true;
    window.pngPaletteEditIndex = idx;
    // Seed FG color so the picker opens to the swatch's color.
    if (typeof fgColor !== 'undefined' && STATE.palette) {
      const r = STATE.palette[idx * 4], g = STATE.palette[idx * 4 + 1], b = STATE.palette[idx * 4 + 2];
      window._pngPickerSeedHex = rgbToHex(r, g, b);
    }
    toggleColorPicker();
  }
  function openPickerForMatte() {
    if (typeof toggleColorPicker !== 'function') return;
    PCKR_TARGET = 'matte'; PCKR_INDEX = -1;
    window.pngPaletteEditMode = true;
    window.pngPaletteEditIndex = -1;
    window._pngPickerSeedHex = rgbToHex(STATE.matteRgb[0], STATE.matteRgb[1], STATE.matteRgb[2]);
    toggleColorPicker();
  }
  function openPickerForAdd() {
    if (typeof toggleColorPicker !== 'function') return;
    PCKR_TARGET = 'palette-add'; PCKR_INDEX = -1;
    window.pngPaletteEditMode = true;
    window.pngPaletteEditIndex = -1;
    window._pngPickerSeedHex = '#ffffff';
    toggleColorPicker();
  }

  /* ═══ EVENT BINDINGS — wired on first openDialog (lazily) ══════════ */
  let _bound = false;
  function bindEventsOnce() {
    if (_bound) return;
    const modal = document.getElementById('pngExportModal');
    if (!modal) return;
    _bound = true;

    // Mode radios
    const r24 = document.getElementById('pngExportRadio24');
    const r8  = document.getElementById('pngExportRadio8');
    if (r24) r24.addEventListener('change', () => { if (r24.checked) setMode('png24'); });
    if (r8)  r8.addEventListener('change',  () => { if (r8.checked)  setMode('png8'); });

    // Color count
    const sel = document.getElementById('pngExportColorSelect');
    const inp = document.getElementById('pngExportColorInput');
    if (sel) sel.addEventListener('change', () => {
      if (sel.value === 'custom') { inp.style.display = ''; inp.focus(); }
      else { inp.style.display = 'none'; setColorsValue(sel.value); }
    });
    if (inp) {
      inp.addEventListener('input', () => setColorsValue(inp.value));
      inp.addEventListener('change', () => setColorsValue(inp.value));
    }

    // Dither
    const dith = document.getElementById('pngExportDither');
    if (dith) dith.addEventListener('input', () => setDitherValue(dith.value));

    // Transparency
    const tr = document.getElementById('pngExportTransparency');
    if (tr) tr.addEventListener('change', () => setTransparency(tr.checked));

    // Matte well
    const mw = document.getElementById('pngExportMatteWell');
    if (mw) mw.addEventListener('click', openPickerForMatte);

    // Reset button
    const reset = document.getElementById('pngExportResetPalette');
    if (reset) reset.addEventListener('click', () => {
      STATE.locks = [];
      STATE.indexedPx = null;
      scheduleRender();
    });

    // Color table delegation
    const ct = document.getElementById('pngExportColorTable');
    if (ct) {
      ct.addEventListener('click', (e) => {
        const sw = e.target.closest('.png-export-swatch');
        if (!sw) return;
        if (sw.id === 'pngExportSwatchAdd') {
          if (!STATE.palette) return;
          const N = (STATE.palette.length / 4) | 0;
          if (N >= 256) return;
          openPickerForAdd();
          return;
        }
        const idx = parseInt(sw.dataset.idx, 10);
        if (!isNaN(idx)) openPickerForSwatch(idx);
      });
      ct.addEventListener('contextmenu', (e) => {
        const sw = e.target.closest('.png-export-swatch');
        if (!sw || sw.id === 'pngExportSwatchAdd') return;
        e.preventDefault();
        const idx = parseInt(sw.dataset.idx, 10);
        if (isNaN(idx) || !STATE.palette) return;
        showSwatchContextMenu(e.clientX, e.clientY, idx);
      });
    }

    // Footer buttons
    const cancel = document.getElementById('pngExportCancelBtn');
    const ok = document.getElementById('pngExportOkBtn');
    if (cancel) cancel.addEventListener('click', closeDialog);
    if (ok) ok.addEventListener('click', commitExport);

    // Preview pane interactions
    const stage = document.getElementById('pngExportPreviewStage');
    if (stage) {
      stage.addEventListener('mouseenter', () => { STATE.previewHover = true; });
      stage.addEventListener('mouseleave', () => { STATE.previewHover = false; STATE.previewIsPanning = false; });
      stage.addEventListener('wheel', (e) => {
        if (!STATE.open) return;
        e.preventDefault();
        const rect = stage.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        previewZoomTo(STATE.previewZoom * factor, cx, cy);
      }, { passive: false });
      stage.addEventListener('mousedown', (e) => {
        if (!STATE.open) return;
        if (STATE.spaceHeld || e.button === 1) {
          STATE.previewIsPanning = true;
          STATE.previewPanStart = { x: e.clientX - STATE.previewPanX, y: e.clientY - STATE.previewPanY };
          e.preventDefault();
        }
      });
      window.addEventListener('mousemove', (e) => {
        if (!STATE.previewIsPanning) return;
        STATE.previewPanX = e.clientX - STATE.previewPanStart.x;
        STATE.previewPanY = e.clientY - STATE.previewPanStart.y;
        applyPreviewTransform();
      });
      window.addEventListener('mouseup', () => { STATE.previewIsPanning = false; });
    }

    // Zoom toolbar buttons
    const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    bind('pngExportZoomOut', () => previewZoomTo(STATE.previewZoom / 1.4));
    bind('pngExportZoomIn',  () => previewZoomTo(STATE.previewZoom * 1.4));
    bind('pngExportZoomFit', () => fitPreview());
    bind('pngExportZoom100', () => { STATE.previewZoom = 1; centerPreview(); });
    bind('pngExportZoom200', () => { STATE.previewZoom = 2; centerPreview(); });
    bind('pngExportZoom400', () => { STATE.previewZoom = 4; centerPreview(); });

    // Keyboard shortcuts (dialog-scoped; only fire when modal is open).
    window.addEventListener('keydown', (e) => {
      if (!STATE.open) return;
      // Defer to colorPicker if it's open on top of the dialog.
      if (document.getElementById('cpIframeOverlay')) return;
      // Allow text input editing without intercepting.
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
      if (e.key === 'Escape') { closeDialog(); return; }
      if (e.key === ' ' || e.code === 'Space') { STATE.spaceHeld = true; e.preventDefault(); return; }
      if (!STATE.previewHover) return;
      if (e.key === '+' || e.key === '=') { previewZoomTo(STATE.previewZoom * 1.4); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { previewZoomTo(STATE.previewZoom / 1.4); e.preventDefault(); }
      else if (e.key === '0') { fitPreview(); e.preventDefault(); }
      else if (e.key === '1') { STATE.previewZoom = 1; centerPreview(); e.preventDefault(); }
      else if (e.key === '2') { STATE.previewZoom = 2; centerPreview(); e.preventDefault(); }
      else if (e.key === '3') { STATE.previewZoom = 4; centerPreview(); e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.code === 'Space') STATE.spaceHeld = false;
    });
  }

  function showSwatchContextMenu(x, y, idx) {
    let menu = document.getElementById('pngExportSwatchMenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'pngExportSwatchMenu';
      menu.className = 'png-export-context-menu';
      document.body.appendChild(menu);
    }
    const locked = !!STATE.locks[idx];
    menu.innerHTML =
      `<div class="pem-item" data-act="edit">Edit color…</div>` +
      `<div class="pem-item" data-act="lock">${locked ? 'Unlock' : 'Lock'}</div>` +
      `<div class="pem-item" data-act="del">Delete</div>`;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.classList.add('show');

    const onClick = (e) => {
      const it = e.target.closest('.pem-item');
      if (!it) return;
      const act = it.dataset.act;
      if (act === 'edit') openPickerForSwatch(idx);
      else if (act === 'lock') {
        STATE.locks[idx] = !STATE.locks[idx];
        renderColorTable();
      } else if (act === 'del') {
        if (!STATE.palette) return;
        const N = (STATE.palette.length / 4) | 0;
        if (N <= 1) return;
        const out = new Uint8Array((N - 1) * 4);
        let q = 0;
        for (let i = 0; i < N; i++) {
          if (i === idx) continue;
          out[q++] = STATE.palette[i * 4];
          out[q++] = STATE.palette[i * 4 + 1];
          out[q++] = STATE.palette[i * 4 + 2];
          out[q++] = STATE.palette[i * 4 + 3];
        }
        STATE.palette = out;
        STATE.locks.splice(idx, 1);
        STATE.indexedPx = null;
        scheduleRender();
      }
      hide();
    };
    const hide = () => {
      menu.classList.remove('show');
      menu.removeEventListener('click', onClick);
      window.removeEventListener('mousedown', onAway);
    };
    const onAway = (e) => { if (!menu.contains(e.target)) hide(); };
    menu.addEventListener('click', onClick);
    setTimeout(() => window.addEventListener('mousedown', onAway), 0);
  }

  /* ═══ INIT — bind on DOM ready (idempotent) ═════════════════════════ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindEventsOnce);
  } else {
    bindEventsOnce();
  }

  /* ═══ PUBLIC API ════════════════════════════════════════════════════ */
  window.PngExport = {
    openDialog: function () { bindEventsOnce(); openDialog(); },
    quickExport: quickExport,
    onColorPicked: onColorPicked,
    onColorPickerCancelled: onColorPickerCancelled,
    encodeRgba: encodeRgba,
    quantize: quantize,
    closeDialog: closeDialog
  };

})();
