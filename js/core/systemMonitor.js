"use strict";

/* Live status-bar performance monitor.
   Browsers do not expose OS-wide CPU/GPU/RAM usage to file:// pages, so these
   values are lightweight, browser-safe estimates of Opsin/page pressure. */
(function () {
  const UPDATE_MS = 1000;
  const FRAME_TARGET_MS = 1000 / 60;
  const BYTES_PER_PIXEL = 4;
  const GIB = 1024 * 1024 * 1024;

  let statusEl = null;
  let intervalId = 0;
  let rafId = 0;
  let lastTick = 0;
  let lastFrameTs = 0;
  let longTaskMs = 0;
  let frameCount = 0;
  let slowFrameCount = 0;
  let frameLagMs = 0;
  let cpuPercent = 0;
  let gpuPercent = 0;
  let observer = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function smooth(previous, next) {
    return previous * 0.65 + next * 0.35;
  }

  function addCanvasBytes(canvas, seen) {
    if (!canvas || !canvas.width || !canvas.height || seen.has(canvas)) return 0;
    seen.add(canvas);
    return canvas.width * canvas.height * BYTES_PER_PIXEL;
  }

  function estimateCanvasBytes() {
    const seen = new Set();
    let bytes = 0;

    if (typeof layers !== "undefined" && Array.isArray(layers)) {
      for (const layer of layers) {
        if (layer && layer.canvas) bytes += addCanvasBytes(layer.canvas, seen);
      }
    }

    if (typeof compositeCanvas !== "undefined") bytes += addCanvasBytes(compositeCanvas, seen);
    if (typeof overlayCanvas !== "undefined") bytes += addCanvasBytes(overlayCanvas, seen);
    if (typeof guideOverlay !== "undefined") bytes += addCanvasBytes(guideOverlay, seen);
    if (typeof uiOverlay !== "undefined") bytes += addCanvasBytes(uiOverlay, seen);
    if (typeof selectionMask !== "undefined") bytes += addCanvasBytes(selectionMask, seen);
    if (typeof rulerH !== "undefined") bytes += addCanvasBytes(rulerH, seen);
    if (typeof rulerV !== "undefined") bytes += addCanvasBytes(rulerV, seen);

    return bytes;
  }

  function getHistoryBytes() {
    try {
      if (typeof History !== "undefined" && History && typeof History.getMemoryUsage === "function") {
        const usage = History.getMemoryUsage();
        return usage && typeof usage.totalBytes === "number" ? usage.totalBytes : 0;
      }
    } catch (err) {
      return 0;
    }
    return 0;
  }

  function getRamBytes() {
    const canvasBytes = estimateCanvasBytes();
    const historyBytes = getHistoryBytes();
    const memory = performance && performance.memory;
    const heapBytes = memory && typeof memory.usedJSHeapSize === "number" ? memory.usedJSHeapSize : 0;

    return heapBytes ? heapBytes + canvasBytes : canvasBytes + historyBytes;
  }

  function formatRam(bytes) {
    if (!bytes || !isFinite(bytes)) return "--";
    return (bytes / GIB).toFixed(1) + "GB";
  }

  function trackFrames(ts) {
    if (lastFrameTs) {
      const delta = ts - lastFrameTs;
      frameCount++;
      if (delta > FRAME_TARGET_MS * 1.5) slowFrameCount++;
      frameLagMs += Math.max(0, delta - FRAME_TARGET_MS);
    }
    lastFrameTs = ts;
    rafId = requestAnimationFrame(trackFrames);
  }

  function startLongTaskObserver() {
    if (observer || typeof PerformanceObserver === "undefined") return;

    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTaskMs += entry.duration || 0;
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch (err) {
      observer = null;
    }
  }

  function updateStatus() {
    if (!statusEl) return;

    const now = performance.now();
    const elapsed = lastTick ? now - lastTick : UPDATE_MS;
    const driftMs = Math.max(0, elapsed - UPDATE_MS);
    lastTick = now;

    const longTaskLoad = clamp((longTaskMs / UPDATE_MS) * 100, 0, 100);
    const driftLoad = clamp((driftMs / UPDATE_MS) * 100, 0, 100);
    const frameBudget = frameCount * FRAME_TARGET_MS;
    const lagLoad = frameBudget ? (frameLagMs / frameBudget) * 100 : 0;
    const slowFrameLoad = frameCount ? (slowFrameCount / frameCount) * 100 : 0;

    cpuPercent = smooth(cpuPercent, Math.max(longTaskLoad, driftLoad));
    gpuPercent = smooth(gpuPercent, clamp(Math.max(lagLoad, slowFrameLoad), 0, 100));

    statusEl.textContent =
      "CPU " + Math.round(cpuPercent) + "% | " +
      "GPU " + Math.round(gpuPercent) + "% | " +
      "RAM " + formatRam(getRamBytes());

    longTaskMs = 0;
    frameCount = 0;
    slowFrameCount = 0;
    frameLagMs = 0;
  }

  function startSystemMonitor() {
    if (intervalId) return;
    statusEl = document.getElementById("statusSystemMonitor");
    if (!statusEl) return;

    startLongTaskObserver();
    lastTick = performance.now();
    updateStatus();
    intervalId = setInterval(updateStatus, UPDATE_MS);
    rafId = requestAnimationFrame(trackFrames);
  }

  function stopSystemMonitor() {
    if (intervalId) clearInterval(intervalId);
    if (rafId) cancelAnimationFrame(rafId);
    if (observer) observer.disconnect();
    intervalId = 0;
    rafId = 0;
    observer = null;
  }

  window.OpsinSystemMonitor = {
    start: startSystemMonitor,
    stop: stopSystemMonitor
  };

  window.addEventListener("load", startSystemMonitor);
})();
