"use strict";

/* ══════════════════════════════════════════════════════════════════════
   Opsin — History Panel UI
   Renders the history panel list and handles click-to-jump navigation.
   Depends on: History (history/history.js), cancelActiveOperation (script.js)
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Render the History panel using real SVG icons from linked_icons.js.
 * Each entry's iconId maps to an `<svg><use href="#icon-..."/></svg>` glyph.
 */
function updateHistoryPanel() {
  const list = document.getElementById('historyList');
  if (!list) return;
  if (typeof History === 'undefined' || !History) { list.innerHTML = ''; return; }

  const timeline = History.getTimeline();
  const cursor = History.getCursor();

  // Rebuild the list; this runs only on state changes, not per-frame.
  list.innerHTML = '';

  for (let i = 0; i < timeline.length; i++) {
    const entry = timeline[i];
    const el = document.createElement('button');
    el.className = 'history-entry';
    el.type = 'button';
    if (i < cursor) el.classList.add('past');
    else if (i === cursor) el.classList.add('current');
    else el.classList.add('future');

    const icon = document.createElement('span');
    icon.className = 'history-icon';
    icon.innerHTML = '<svg><use href="#icon-' + (entry.iconId || 'menu-refresh') + '"/></svg>';

    const label = document.createElement('span');
    label.className = 'history-label';
    label.textContent = entry.name;

    el.appendChild(icon);
    el.appendChild(label);
    el.title = entry.name;
    el.onclick = () => {
      if (window.TextTool && window.TextTool.isActive && window.TextTool.isActive()) {
        window.TextTool.endEdit(true);
      }
      if (cancelActiveOperation()) return;
      History.jumpTo(i);
    };
    list.appendChild(el);
  }

  const currentEl = list.querySelector('.history-entry.current');
  if (currentEl) {
    currentEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
