"use strict";

/* ══════════════════════════════════════════════════════════════════════
   Opsin — TIFF Encoder (uncompressed, little-endian)
   ══════════════════════════════════════════════════════════════════════
   encodeTIFF(imageData, w, h, bitDepth) -> Blob
     bitDepth: 24 (RGB) or 32 (RGBA with unassociated alpha ExtraSamples tag)
   Called by executeExport() in script.js.
   ══════════════════════════════════════════════════════════════════════ */

function encodeTIFF(imageData, w, h, bitDepth) {
  const channels = bitDepth === 32 ? 4 : 3;
  const stripSize = w * h * channels;

  // Tag counts and IFD layout
  const tagCount = bitDepth === 32 ? 13 : 12;
  const ifdOffset = 8;
  const ifdSize = 2 + tagCount * 12 + 4;
  let overflowOffset = ifdOffset + ifdSize;

  // BitsPerSample overflow: 3 or 4 shorts
  const bpsOffset = overflowOffset;
  overflowOffset += channels * 2;
  // XResolution rational (8 bytes)
  const xResOffset = overflowOffset;
  overflowOffset += 8;
  // YResolution rational (8 bytes)
  const yResOffset = overflowOffset;
  overflowOffset += 8;

  const stripOffset = overflowOffset;
  const fileSize = stripOffset + stripSize;
  const buf = new ArrayBuffer(fileSize);
  const view = new DataView(buf);
  const d = imageData.data;

  // ── TIFF Header (8 bytes) ──
  view.setUint8(0, 0x49); view.setUint8(1, 0x49); // 'II' little-endian
  view.setUint16(2, 42, true);                      // magic
  view.setUint32(4, ifdOffset, true);                // offset to first IFD

  // ── IFD ──
  let pos = ifdOffset;
  view.setUint16(pos, tagCount, true); pos += 2;

  function writeTag(tag, type, count, value) {
    view.setUint16(pos, tag, true); pos += 2;
    view.setUint16(pos, type, true); pos += 2;
    view.setUint32(pos, count, true); pos += 4;
    // Type sizes: 1=BYTE(1), 2=ASCII(1), 3=SHORT(2), 4=LONG(4), 5=RATIONAL(8)
    if (type === 3 && count === 1) {
      view.setUint16(pos, value, true); pos += 4; // value in low 2 bytes, pad
    } else {
      view.setUint32(pos, value, true); pos += 4;
    }
  }

  // Tags must be in ascending order by tag ID
  writeTag(256, 3, 1, w);                    // ImageWidth
  writeTag(257, 3, 1, h);                    // ImageLength
  writeTag(258, 3, channels, bpsOffset);     // BitsPerSample -> overflow
  writeTag(259, 3, 1, 1);                    // Compression: None
  writeTag(262, 3, 1, 2);                    // PhotometricInterpretation: RGB
  writeTag(273, 4, 1, stripOffset);          // StripOffsets
  writeTag(277, 3, 1, channels);             // SamplesPerPixel
  writeTag(278, 3, 1, h);                    // RowsPerStrip: entire image
  writeTag(279, 4, 1, stripSize);            // StripByteCounts
  writeTag(282, 5, 1, xResOffset);           // XResolution -> overflow
  writeTag(283, 5, 1, yResOffset);           // YResolution -> overflow
  writeTag(296, 3, 1, 2);                    // ResolutionUnit: inch
  if (bitDepth === 32) {
    writeTag(338, 3, 1, 2);                  // ExtraSamples: unassociated alpha
  }

  // Next IFD offset: 0 (no more IFDs)
  view.setUint32(pos, 0, true);

  // ── Overflow data ──
  // BitsPerSample values
  for (let i = 0; i < channels; i++) view.setUint16(bpsOffset + i * 2, 8, true);
  // XResolution: 72/1
  view.setUint32(xResOffset, 72, true);
  view.setUint32(xResOffset + 4, 1, true);
  // YResolution: 72/1
  view.setUint32(yResOffset, 72, true);
  view.setUint32(yResOffset + 4, 1, true);

  // ── Pixel data (uncompressed RGB or RGBA, top-to-bottom) ──
  let offset = stripOffset;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      view.setUint8(offset++, d[si]);     // R
      view.setUint8(offset++, d[si + 1]); // G
      view.setUint8(offset++, d[si + 2]); // B
      if (channels === 4) view.setUint8(offset++, d[si + 3]); // A
    }
  }

  return new Blob([buf], { type: 'image/tiff' });
}
