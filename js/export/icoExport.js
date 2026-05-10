"use strict";

/* ══════════════════════════════════════════════════════════════════════
   Opsin — ICO Export
   ══════════════════════════════════════════════════════════════════════

   Multi-size .ico encoder with Lanczos-3 resampling.

   Provides:
     • openExportIcoModal()     — open the ICO export dialog
     • executeIcoExport()       — assemble and download the .ico file
     • encodeIcoDIB(imgData, size) — BMP DIB encoder for ICO frames (global,
                                     also called by iconEditMode.js)

   All functions are global (no IIFE) so HTML onclick attributes and
   iconEditMode.js can reference them directly.

   ══════════════════════════════════════════════════════════════════════ */

/* ── ICO Modal Controls ──────────────────────────────── */
function openExportIcoModal() {
  closeAllMenus();
  // Remove any custom rows from a previous session
  document.querySelectorAll('.ico-size-row.custom').forEach(r => r.remove());
  deactivateIcoGhostRow();
  resetIcoFormats();
  const cbs = document.querySelectorAll('.ico-size-cb');
  cbs.forEach(cb => { cb.checked = ICO_DEFAULT_SIZES.includes(parseInt(cb.value)); });
  updateIcoSelectAll();
  document.getElementById('exportIcoModal').classList.add('show');
}

function toggleIcoSelectAll() {
  const all = document.getElementById('icoSelectAll').checked;
  document.querySelectorAll('.ico-size-cb').forEach(cb => { cb.checked = all; });
}

function updateIcoSelectAll() {
  const cbs = Array.from(document.querySelectorAll('.ico-size-cb'));
  const checked = cbs.filter(cb => cb.checked).length;
  const sa = document.getElementById('icoSelectAll');
  sa.checked = checked === cbs.length;
  sa.indeterminate = false;
}

/* ── ICO Per-Row Format Toggle ────────────────────────── */
function setIcoRowFormat(row, fmt) {
  row.dataset.fmt = fmt;
  // Target the togglable format badge (has onclick), not the CUSTOM label badge
  const badges = Array.from(row.querySelectorAll('.ico-format-badge'));
  const badge = badges.find(b => b.getAttribute('onclick')) || badges.find(b => b.classList.contains('png') || b.classList.contains('bmp')) || badges[badges.length - 1];
  badge.className = 'ico-format-badge ' + fmt;
  badge.textContent = fmt.toUpperCase();
  if (!badge.getAttribute('onclick')) {
    badge.setAttribute('onclick', 'event.preventDefault();toggleIcoRowFormat(this)');
  }
}

function toggleIcoRowFormat(badge) {
  const row = badge.closest('.ico-size-row');
  const current = row.dataset.fmt;
  setIcoRowFormat(row, current === 'png' ? 'bmp' : 'png');
}

function resetIcoFormats() {
  document.querySelectorAll('.ico-size-row:not(.custom)').forEach(row => {
    const size = parseInt(row.dataset.icoSize);
    setIcoRowFormat(row, size >= 256 ? 'png' : 'bmp');
  });
}

/* ── ICO Custom Size (Ghost Row) ─────────────────────── */
let _icoGhostBlurTimer = null;

function activateIcoGhostRow() {
  document.getElementById('icoGhostRow').style.display = 'none';
  const gi = document.getElementById('icoGhostInput');
  gi.style.display = 'flex';
  const inp = document.getElementById('icoCustomSizeInput');
  inp.value = '';
  inp.focus();
}

function deactivateIcoGhostRow() {
  clearTimeout(_icoGhostBlurTimer);
  document.getElementById('icoGhostInput').style.display = 'none';
  document.getElementById('icoGhostRow').style.display = 'flex';
}

function addIcoCustomSize() {
  clearTimeout(_icoGhostBlurTimer);
  const inp = document.getElementById('icoCustomSizeInput');
  const val = parseInt(inp.value);
  if (!val || val < 1 || val > 512 || !Number.isInteger(val)) { inp.focus(); return; }
  // Check for duplicates among all current size rows
  const existing = Array.from(document.querySelectorAll('.ico-size-cb')).map(cb => parseInt(cb.value));
  if (existing.includes(val)) { inp.value = ''; inp.focus(); return; }
  // Build the custom row — default format follows auto rule
  const row = document.createElement('label');
  row.className = 'ico-size-row custom';
  row.dataset.icoSize = val;
  const fmt = val >= 256 ? 'png' : 'bmp';
  row.dataset.fmt = fmt;
  row.innerHTML =
    '<input type="checkbox" class="ico-size-cb" value="' + val + '" checked onchange="updateIcoSelectAll()">' +
    '<span class="ico-check"></span>' +
    '<span class="ico-size-label">' + val + ' x ' + val + '</span>' +
    '<span class="ico-format-badge custom">CUSTOM</span>' +
    '<span class="ico-format-badge ' + fmt + '" onclick="event.preventDefault();toggleIcoRowFormat(this)">' + fmt.toUpperCase() + '</span>' +
    '<button class="ico-remove" onclick="event.preventDefault();removeIcoCustomSize(this)" title="Remove">&times;</button>';
  // Insert sorted (descending) — find the first row with a smaller size
  const list = document.querySelector('.ico-size-list');
  const rows = Array.from(list.querySelectorAll('.ico-size-row'));
  let inserted = false;
  for (const r of rows) {
    if (parseInt(r.dataset.icoSize) < val) {
      list.insertBefore(row, r);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    // Smaller than all — insert before ghost row
    list.insertBefore(row, document.getElementById('icoGhostRow'));
  }
  updateIcoSelectAll();
  deactivateIcoGhostRow();
}

function removeIcoCustomSize(btn) {
  btn.closest('.ico-size-row').remove();
  updateIcoSelectAll();
}

// Wire up keyboard events for the custom size input
document.getElementById('icoCustomSizeInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') { e.preventDefault(); addIcoCustomSize(); }
  else if (e.key === 'Escape') { deactivateIcoGhostRow(); }
});
document.getElementById('icoCustomSizeInput').addEventListener('blur', function() {
  _icoGhostBlurTimer = setTimeout(deactivateIcoGhostRow, 150);
});

/* ── ICO Binary Encoder ──────────────────────────────── */
// Encodes a BMP DIB (no file header) for embedding in ICO.
// 32-bit BGRA, bottom-to-top rows, with AND mask.
function encodeIcoDIB(imageData, size) {
  const w = size, h = size;
  const andRowBytes = Math.ceil(w / 8);
  const andRowPad = (4 - (andRowBytes % 4)) % 4;
  const andMaskSize = (andRowBytes + andRowPad) * h;
  const pixelDataSize = w * h * 4;
  const dibHeaderSize = 40;
  const totalSize = dibHeaderSize + pixelDataSize + andMaskSize;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const d = imageData.data;

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(0, 40, true);          // biSize
  view.setInt32(4, w, true);            // biWidth
  view.setInt32(8, h * 2, true);        // biHeight (XOR + AND)
  view.setUint16(12, 1, true);          // biPlanes
  view.setUint16(14, 32, true);         // biBitCount
  view.setUint32(16, 0, true);          // biCompression = BI_RGB
  view.setUint32(20, pixelDataSize + andMaskSize, true); // biSizeImage
  // biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant = 0

  // Pixel data: BGRA, bottom-to-top
  let offset = dibHeaderSize;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      view.setUint8(offset,     d[si + 2]); // B
      view.setUint8(offset + 1, d[si + 1]); // G
      view.setUint8(offset + 2, d[si]);     // R
      view.setUint8(offset + 3, d[si + 3]); // A
      offset += 4;
    }
  }

  // AND mask: 1-bit per pixel, bottom-to-top
  // With 32-bit BGRA the alpha channel carries transparency,
  // so the AND mask is formally all-zero (opaque). Some legacy
  // readers still consult it, so we set bits for fully-transparent pixels.
  for (let y = h - 1; y >= 0; y--) {
    for (let byteIdx = 0; byteIdx < andRowBytes; byteIdx++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const px = byteIdx * 8 + bit;
        if (px < w) {
          const si = (y * w + px) * 4;
          if (d[si + 3] === 0) byte |= (0x80 >> bit);
        }
      }
      view.setUint8(offset, byte);
      offset++;
    }
    for (let p = 0; p < andRowPad; p++) { view.setUint8(offset++, 0); }
  }

  return new Uint8Array(buf);
}

async function executeIcoExport() {
  // Build a size->format map from the checked rows (read before closing modal)
  const checkedRows = Array.from(document.querySelectorAll('.ico-size-row')).filter(r => r.querySelector('.ico-size-cb').checked);
  const fmtMap = {};
  checkedRows.forEach(r => { fmtMap[parseInt(r.dataset.icoSize)] = r.dataset.fmt || 'bmp'; });
  const sizes = Object.keys(fmtMap).map(Number).sort((a, b) => b - a);
  if (sizes.length === 0) return;
  closeModal('exportIcoModal');

  // Composite all visible layers
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = canvasW; exportCanvas.height = canvasH;
  const ectx = exportCanvas.getContext('2d');
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i]; if (!l.visible) continue;
    ectx.globalAlpha = l.opacity;
    ectx.drawImage(l.canvas, 0, 0);
    if (i === activeLayerIndex && floatingActive && floatingCanvas)
      ectx.drawImage(floatingCanvas, floatingOffset.x, floatingOffset.y);
  }
  ectx.globalAlpha = 1;
  const srcData = ectx.getImageData(0, 0, canvasW, canvasH);

  // Resample and encode each size
  const imageEntries = []; // { size, data: Uint8Array }
  for (const size of sizes) {
    const resampled = (size === canvasW && size === canvasH)
      ? srcData
      : lanczos3Resample(srcData, canvasW, canvasH, size, size);

    if (fmtMap[size] === 'png') {
      // PNG-encode
      const tmpCvs = document.createElement('canvas');
      tmpCvs.width = size; tmpCvs.height = size;
      tmpCvs.getContext('2d').putImageData(resampled, 0, 0);
      const pngBlob = await new Promise(resolve => tmpCvs.toBlob(resolve, 'image/png'));
      const pngBuf = await pngBlob.arrayBuffer();
      imageEntries.push({ size, data: new Uint8Array(pngBuf) });
    } else {
      // BMP DIB
      imageEntries.push({ size, data: encodeIcoDIB(resampled, size) });
    }
  }

  // Assemble ICO file
  const count = imageEntries.length;
  const headerSize = 6;
  const dirSize = count * 16;
  let dataOffset = headerSize + dirSize;
  const totalSize = dataOffset + imageEntries.reduce((s, e) => s + e.data.length, 0);
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);

  // ICONDIR header
  view.setUint16(0, 0, true);       // reserved
  view.setUint16(2, 1, true);       // type = ICO
  view.setUint16(4, count, true);   // image count

  // ICONDIRENTRY for each image
  for (let i = 0; i < count; i++) {
    const e = imageEntries[i];
    const off = 6 + i * 16;
    view.setUint8(off, e.size === 256 ? 0 : e.size);     // width (0 = 256)
    view.setUint8(off + 1, e.size === 256 ? 0 : e.size); // height (0 = 256)
    view.setUint8(off + 2, 0);      // color count
    view.setUint8(off + 3, 0);      // reserved
    view.setUint16(off + 4, 1, true);  // planes
    view.setUint16(off + 6, 32, true); // bit count
    view.setUint32(off + 8, e.data.length, true);  // bytes in resource
    view.setUint32(off + 12, dataOffset, true);     // offset to data
    dataOffset += e.data.length;
  }

  // Image data
  let writePos = headerSize + dirSize;
  for (const e of imageEntries) {
    new Uint8Array(buf, writePos, e.data.length).set(e.data);
    writePos += e.data.length;
  }

  const blob = new Blob([buf], { type: 'image/x-icon' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'image.ico'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
