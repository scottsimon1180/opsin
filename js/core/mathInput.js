/* Math expression evaluation for number inputs (Photoshop-style).
 *
 * Lets users type expressions like "100+50", "(10+2)*4", "200/3", "50x2",
 * or "25%" into any <input type="number"> in the app. On commit (Enter or
 * blur) the expression is evaluated and replaced with the result. Invalid
 * expressions blink the input's accent border twice and revert to the
 * value the field had at focus time. */
(function () {
  'use strict';

  const ALLOWED = /^[\d+\-*/().\s%]+$/;
  // Characters allowed inside the field while the user is typing.
  // Includes 'x'/'X' (multiplication alias) and '%' (percent-of-original).
  const ALLOWED_CHAR = /^[\d+\-*/().%xX\s]$/;
  const ALLOWED_RUN  = /^[\d+\-*/().%xX\s]*$/;

  function evaluate(expr, originalValue) {
    if (expr == null) return NaN;
    let s = String(expr).trim();
    if (s === '') return NaN;
    // Allow 'x' / 'X' as multiplication (no variables exist in this grammar)
    s = s.replace(/[xX]/g, '*');
    // Photoshop-style "N%" → percentage of the value the field had at focus
    if (originalValue !== undefined && originalValue !== null && originalValue !== '' && !isNaN(parseFloat(originalValue))) {
      s = s.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100*' + Number(originalValue) + ')');
    }
    if (!ALLOWED.test(s)) return NaN;
    try {
      const v = Function('"use strict"; return (' + s + ')')();
      if (typeof v !== 'number' || !isFinite(v)) return NaN;
      return v;
    } catch (_) {
      return NaN;
    }
  }

  function blinkError(el) {
    const wrap = el.closest('.props-input-wrap, .opt-input-wrap');
    const target = wrap || el;
    target.classList.remove('math-input-error');
    void target.offsetWidth; // restart animation
    target.classList.add('math-input-error');
    setTimeout(() => target.classList.remove('math-input-error'), 480);
  }

  function clampToAttrs(el, n) {
    const step = el.getAttribute('step');
    if (step != null && step !== '' && step !== 'any') {
      const sn = parseFloat(step);
      if (sn > 0 && sn === Math.floor(sn)) n = Math.round(n);
    }
    const minA = el.getAttribute('min');
    const maxA = el.getAttribute('max');
    if (minA != null && minA !== '') {
      const m = parseFloat(minA);
      if (!isNaN(m)) n = Math.max(m, n);
    }
    if (maxA != null && maxA !== '') {
      const m = parseFloat(maxA);
      if (!isNaN(m)) n = Math.min(m, n);
    }
    return n;
  }

  function commit(el) {
    if (el._mathCommitting) return;
    el._mathCommitting = true;

    const raw = el.value;
    const original = el._mathOriginalValue;
    const wasNumber = el._mathOriginalType === 'number';

    // No change typed → just restore type, no event
    if (raw === original) {
      if (wasNumber) el.type = 'number';
      el._mathCommitting = false;
      return;
    }

    // Empty → revert silently to original (matches Photoshop)
    if (raw.trim() === '') {
      if (wasNumber) el.type = 'number';
      el.value = original;
      el._mathCommitting = false;
      return;
    }

    // Fast path: plain number
    let result;
    if (/^-?\d+(?:\.\d+)?$/.test(raw.trim())) {
      result = parseFloat(raw);
    } else {
      result = evaluate(raw, original);
    }

    if (isNaN(result)) {
      blinkError(el);
      if (wasNumber) el.type = 'number';
      el.value = original;
      el._mathCommitting = false;
      return;
    }

    result = clampToAttrs(el, result);
    const resultStr = String(result);

    if (wasNumber) el.type = 'number';
    el.value = resultStr;

    // Clear math state so our capture-phase suppressor doesn't swallow the
    // synthetic events we're about to fire to existing user handlers.
    delete el._mathOriginalType;
    delete el._mathOriginalValue;

    if (resultStr !== original) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el._mathCommitting = false;
  }

  function onFocus(e) {
    const el = e.target;
    if (el.disabled || el.readOnly) return;
    if (el._mathOriginalType !== undefined) return;
    el._mathOriginalType = el.type;
    el._mathOriginalValue = el.value;
    if (el.type === 'number') el.type = 'text';
    setTimeout(() => { try { el.select(); } catch (_) {} }, 0);
  }

  function onBlur(e) {
    const el = e.target;
    if (el._mathOriginalType === undefined) return;
    commit(el);
  }

  // Block unsupported characters at the input boundary so the field can
  // never display invalid text. Allows control keys (backspace, delete,
  // arrows, copy/paste, etc.) and validates pasted/dropped content too.
  function onBeforeInput(e) {
    if (e.target._mathOriginalType === undefined) return;
    const t = e.inputType;
    // Deletions and structural ops always allowed
    if (!t || t.startsWith('delete') || t === 'historyUndo' || t === 'historyRedo') return;
    const data = e.data;
    if (data == null) return;
    if (t === 'insertText' || t === 'insertCompositionText' || t === 'insertReplacementText') {
      if (data.length === 1) {
        if (!ALLOWED_CHAR.test(data)) e.preventDefault();
      } else {
        if (!ALLOWED_RUN.test(data)) e.preventDefault();
      }
    } else if (t === 'insertFromPaste' || t === 'insertFromDrop' || t === 'insertFromYank' || t === 'insertFromPasteAsQuotation') {
      if (!ALLOWED_RUN.test(data)) e.preventDefault();
    }
  }

  function onKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Escape') {
      const el = e.target;
      if (el._mathOriginalValue !== undefined) {
        // Revert without firing change
        if (el._mathOriginalType === 'number') el.type = 'number';
        el.value = el._mathOriginalValue;
        delete el._mathOriginalType;
        delete el._mathOriginalValue;
      }
      e.target.blur();
    }
  }

  // Capture-phase suppressor: while in math-mode, the native 'change' event
  // (which fires on blur with the unevaluated expression as value) must not
  // reach existing user handlers. Our blur handler will dispatch a fresh
  // change event with the evaluated numeric value.
  function onChangeCapture(e) {
    if (e.target._mathOriginalType !== undefined) {
      e.stopImmediatePropagation();
    }
  }
  function onInputCapture(e) {
    if (e.target._mathOriginalType !== undefined) {
      e.stopImmediatePropagation();
    }
  }

  function attach(el) {
    if (!el || el._mathInputAttached) return;
    if (el.tagName !== 'INPUT' || el.type !== 'number') return;
    el._mathInputAttached = true;
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('beforeinput', onBeforeInput);
    el.addEventListener('change', onChangeCapture, true);
    el.addEventListener('input', onInputCapture, true);
  }

  function attachAll(root) {
    const r = root || document;
    if (!r.querySelectorAll) return;
    r.querySelectorAll('input[type="number"]').forEach(attach);
  }

  function init() {
    attachAll();
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return;
          if (node.matches && node.matches('input[type="number"]')) attach(node);
          attachAll(node);
        });
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.MathInput = { evaluate, attach, attachAll };
})();
