"use strict";

/* ═══════════════════════════════════════════════════════
   TOOL REGISTRY — maps tool names to 5-slot handlers.
   Tool files call ToolRegistry.register() at load time.
   script.js calls ToolRegistry.dispatch() on mouse events.
   toolbar.js calls activate/deactivate on tool switches.
   ═══════════════════════════════════════════════════════ */

const ToolRegistry = (() => {
  const _handlers = {};

  return {
    register(name, slots) {
      _handlers[name] = slots;
    },

    has(name) {
      return !!_handlers[name];
    },

    // Calls the named slot for the currently active tool.
    // Returns true only when the handler explicitly returns true (i.e. "I handled this").
    // Returns false when there is no handler or the handler returns nothing/false,
    // signalling the caller to continue with its existing fallback logic.
    dispatch(slot, e, pos) {
      const h = _handlers[currentTool];
      if (!h || typeof h[slot] !== 'function') return false;
      return h[slot](e, pos) === true;
    },

    activate(name) {
      const h = _handlers[name];
      if (h && typeof h.activate === 'function') h.activate();
    },

    deactivate(name) {
      const h = _handlers[name];
      if (h && typeof h.deactivate === 'function') h.deactivate();
    }
  };
})();
