"use strict";

/* ══════════════════════════════════════════════════════════════════════
   Opsin — BMP Encoder
   ══════════════════════════════════════════════════════════════════════
   encodeBMP(imageData, w, h, bitDepth) -> Blob
     bitDepth: 24 (BGR, BI_RGB) or 32 (BGRA, BI_BITFIELDS + BITMAPV4HEADER)
   Called by executeExport() in script.js.
   ══════════════════════════════════════════════════════════════════════ */

function encodeBMP(imageData, w, h, bitDepth) {
  const channels = bitDepth === 32 ? 4 : 3;
  const rowBytes = w * channels;
  const rowPadding = (4 - (rowBytes % 4)) % 4;
  const pixelDataSize = (rowBytes + rowPadding) * h;

  // 24-bit uses BITMAPINFOHEADER (40 bytes), 32-bit uses BITMAPV4HEADER (108 bytes)
  const dibHeaderSize = bitDepth === 32 ? 108 : 40;
  const headerSize = 14 + dibHeaderSize;
  const fileSize = headerSize + pixelDataSize;
  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);
  const d = imageData.data;

  // ── BMP File Header (14 bytes) ──
  view.setUint8(0, 0x42);  // 'B'
  view.setUint8(1, 0x4D);  // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint16(6, 0, true);  // reserved
  view.setUint16(8, 0, true);  // reserved
  view.setUint32(10, headerSize, true);  // pixel data offset

  // ── DIB Header ──
  view.setUint32(14, dibHeaderSize, true);  // header size
  view.setInt32(18, w, true);               // width
  view.setInt32(22, -h, true);              // height (negative = top-down)
  view.setUint16(26, 1, true);             // color planes
  view.setUint16(28, bitDepth, true);      // bits per pixel

  if (bitDepth === 32) {
    // BITMAPV4HEADER fields
    view.setUint32(30, 3, true);              // compression: BI_BITFIELDS
    view.setUint32(34, pixelDataSize, true);  // image size
    view.setInt32(38, 2835, true);            // X pixels per meter (72 DPI)
    view.setInt32(42, 2835, true);            // Y pixels per meter (72 DPI)
    view.setUint32(46, 0, true);              // colors in table
    view.setUint32(50, 0, true);              // important colors
    // Channel masks: R, G, B, A
    view.setUint32(54, 0x00FF0000, true);     // red mask
    view.setUint32(58, 0x0000FF00, true);     // green mask
    view.setUint32(62, 0x000000FF, true);     // blue mask
    view.setUint32(66, 0xFF000000, true);     // alpha mask
    // Color space: LCS_sRGB (0x73524742 = 'sRGB')
    view.setUint32(70, 0x73524742, true);
    // CIEXYZTRIPLE endpoints (36 bytes) + gamma values (12 bytes) = 48 bytes, all zero for sRGB
    for (let i = 74; i < 122; i += 4) view.setUint32(i, 0, true);
  } else {
    // BITMAPINFOHEADER fields
    view.setUint32(30, 0, true);              // compression: BI_RGB
    view.setUint32(34, pixelDataSize, true);  // image size
    view.setInt32(38, 2835, true);            // X pixels per meter (72 DPI)
    view.setInt32(42, 2835, true);            // Y pixels per meter (72 DPI)
    view.setUint32(46, 0, true);              // colors in table
    view.setUint32(50, 0, true);              // important colors
  }

  // ── Pixel data (top-down via negative height) ──
  let offset = headerSize;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      if (bitDepth === 32) {
        // BGRA byte order
        view.setUint8(offset++, d[si + 2]); // B
        view.setUint8(offset++, d[si + 1]); // G
        view.setUint8(offset++, d[si]);     // R
        view.setUint8(offset++, d[si + 3]); // A
      } else {
        // BGR byte order
        view.setUint8(offset++, d[si + 2]); // B
        view.setUint8(offset++, d[si + 1]); // G
        view.setUint8(offset++, d[si]);     // R
      }
    }
    // Row padding to 4-byte boundary
    for (let p = 0; p < rowPadding; p++) view.setUint8(offset++, 0);
  }

  return new Blob([buf], { type: 'image/bmp' });
}
