"use strict";

/* ═══════════════════════════════════════════════════════
   CUSTOM FONTS — IndexedDB-backed persistent storage
   Saves user-uploaded font files (TTF/OTF/WOFF/WOFF2) so
   custom fonts survive across sessions and page reloads.

   Public API (window.CustomFonts):
     CustomFonts.init()       → Promise — call on app boot;
                                opens DB, registers all stored
                                fonts via FontFace API.
     CustomFonts.add(file)    → Promise<{family, id}>
     CustomFonts.list()       → Promise<Array<{id, family, addedAt}>>
     CustomFonts.delete(id)   → Promise
     CustomFonts.onChange(cb) → Subscribe to add/delete events.

   No external deps. Stores raw ArrayBuffer; family name is
   derived from filename (stripped extension, sanitized).
   ═══════════════════════════════════════════════════════ */

window.CustomFonts = (function() {
  const DB_NAME = 'opsin-fonts';
  const DB_VERSION = 1;
  const STORE = 'fonts';

  let dbPromise = null;
  const listeners = new Set();
  // Loaded font records (in-memory mirror of DB)
  let loaded = [];

  function _openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function() {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          os.createIndex('family', 'family', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return dbPromise;
  }

  function _tx(mode) {
    return _openDb().then(db => db.transaction(STORE, mode).objectStore(STORE));
  }

  function _sanitizeFamily(filename) {
    // Strip extension, replace bad chars, collapse whitespace.
    let name = (filename || 'CustomFont').replace(/\.(ttf|otf|woff2?|eot)$/i, '');
    name = name.replace(/[^\w\s\-]/g, ' ').replace(/\s+/g, ' ').trim();
    return name || 'CustomFont';
  }

  async function _registerFont(record) {
    if (!record || !record.data) return;
    try {
      const face = new FontFace(record.family, record.data);
      await face.load();
      document.fonts.add(face);
      record._face = face;
    } catch (err) {
      console.warn('[CustomFonts] Failed to register', record.family, err);
    }
  }

  function _emit() {
    listeners.forEach(cb => { try { cb(loaded.slice()); } catch (e) {} });
  }

  async function init() {
    try {
      const store = await _tx('readonly');
      const all = await new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
      });
      // Register all stored fonts in parallel.
      await Promise.all(all.map(rec => _registerFont(rec)));
      loaded = all;
      _emit();
    } catch (err) {
      console.warn('[CustomFonts] init failed:', err);
      loaded = [];
    }
  }

  async function add(file) {
    if (!file) throw new Error('No file provided');
    const buf = await file.arrayBuffer();
    const family = _sanitizeFamily(file.name);
    const record = {
      family,
      filename: file.name,
      addedAt: Date.now(),
      size: buf.byteLength,
      data: buf
    };
    const store = await _tx('readwrite');
    await new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => { record.id = req.result; resolve(); };
      req.onerror   = () => reject(req.error);
    });
    await _registerFont(record);
    loaded.push(record);
    _emit();
    return { id: record.id, family };
  }

  async function deleteFont(id) {
    const store = await _tx('readwrite');
    await new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
    const rec = loaded.find(r => r.id === id);
    if (rec && rec._face) {
      try { document.fonts.delete(rec._face); } catch (e) {}
    }
    loaded = loaded.filter(r => r.id !== id);
    _emit();
  }

  function list() {
    // Return shallow copies stripped of binary data.
    return loaded.map(r => ({ id: r.id, family: r.family, filename: r.filename, addedAt: r.addedAt, size: r.size }));
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return { init, add, list, delete: deleteFont, onChange };
})();
