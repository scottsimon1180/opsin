"use strict";

/* Status-bar telemetry renderer.
   Opsin is a static browser app, so this file does not collect OS metrics by
   itself. Dedicated integration modules, such as telemetryHelper.js, supply
   normalized metric objects through OpsinSystemMonitor.setProvider().

   Current provider shape:
   {
     online: true,
     cpuPercent: 12.4,
     gpuPercent: 6.1,
     ramPercent: 48.2,
     ramUsedGb: 7.8,
     ramTotalGb: 16.0
   }

   The shape leaves room for future telemetry such as VRAM, FPS, temperatures,
   JS heap, and undo-memory usage without changing the status-bar UI contract. */
(function () {
  const UPDATE_MS = 500;
  const OFFLINE_TITLE = "Telemetry helper offline. Start opsin_helper.py to enable live CPU/GPU/RAM metrics.";
  const ONLINE_TITLE = "Live CPU/GPU/RAM metrics supplied by the Opsin localhost telemetry helper.";

  let statusEl = null;
  let intervalId = 0;
  let provider = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function toFiniteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return isFinite(number) ? number : null;
  }

  function toPercent(value) {
    const number = toFiniteNumber(value);
    return number === null ? null : clamp(number, 0, 100);
  }

  function toGb(value) {
    const number = toFiniteNumber(value);
    return number === null || number < 0 ? null : number;
  }

  function readProviderMetrics() {
    const source = provider || window.OpsinNativeSystemMetrics;
    if (!source) return null;

    try {
      const metrics = typeof source === "function" ? source() : source;
      if (!metrics || metrics.online === false) return null;

      const cpuPercent = toPercent(metrics.cpuPercent !== undefined ? metrics.cpuPercent : metrics.cpu);
      const gpuPercent = toPercent(metrics.gpuPercent !== undefined ? metrics.gpuPercent : metrics.gpu);
      const ramPercent = toPercent(metrics.ramPercent !== undefined ? metrics.ramPercent : metrics.ram);
      const ramUsedGb = toGb(metrics.ramUsedGb !== undefined ? metrics.ramUsedGb : metrics.ramGb);
      const ramTotalGb = toGb(metrics.ramTotalGb !== undefined ? metrics.ramTotalGb : metrics.ramTotalGB);

      if (
        cpuPercent === null &&
        gpuPercent === null &&
        ramPercent === null &&
        ramUsedGb === null &&
        ramTotalGb === null
      ) {
        return null;
      }

      return {
        cpuPercent: cpuPercent,
        gpuPercent: gpuPercent,
        ramPercent: ramPercent,
        ramUsedGb: ramUsedGb,
        ramTotalGb: ramTotalGb
      };
    } catch (err) {
      return null;
    }
  }

  function formatPercent(value) {
    if (value === null) return "-%";
    const rounded = Math.round(value * 10) / 10;
    return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + "%";
  }

  function formatGb(value) {
    if (value === null) return "-- GB";
    return value.toFixed(1) + " GB";
  }

  function formatRam(metrics) {
    return metrics.ramUsedGb !== null ? formatGb(metrics.ramUsedGb) : "- GB";
  }

  function renderOffline() {
    if (!statusEl) return;
    statusEl.innerHTML =
      '<span class="status-system-monitor__metric status-system-monitor__metric--cpu">CPU--%</span>' +
      '<span class="status-system-monitor__sep">|</span>' +
      '<span class="status-system-monitor__metric status-system-monitor__metric--gpu">GPU--%</span>' +
      '<span class="status-system-monitor__sep">|</span>' +
      '<span class="status-system-monitor__metric status-system-monitor__metric--ram">RAM-- GB</span>';
    statusEl.title = OFFLINE_TITLE;
  }

  function renderStatus(metrics) {
    if (!statusEl) return;
    statusEl.innerHTML =
      '<span class="status-system-monitor__metric status-system-monitor__metric--cpu">CPU-' + formatPercent(metrics.cpuPercent) + "</span>" +
      '<span class="status-system-monitor__sep">|</span>' +
      '<span class="status-system-monitor__metric status-system-monitor__metric--gpu">GPU-' + formatPercent(metrics.gpuPercent) + "</span>" +
      '<span class="status-system-monitor__sep">|</span>' +
      '<span class="status-system-monitor__metric status-system-monitor__metric--ram">RAM-' + formatRam(metrics) + "</span>";
    statusEl.title = ONLINE_TITLE;
  }

  function updateStatus() {
    if (!statusEl) return;

    const metrics = readProviderMetrics();
    if (metrics) {
      renderStatus(metrics);
    } else {
      renderOffline();
    }
  }

  function startSystemMonitor() {
    if (intervalId) return;
    statusEl = document.getElementById("statusSystemMonitor");
    if (!statusEl) return;

    updateStatus();
    intervalId = setInterval(updateStatus, UPDATE_MS);
  }

  function stopSystemMonitor() {
    if (intervalId) clearInterval(intervalId);
    intervalId = 0;
  }

  function setProvider(nextProvider) {
    provider = nextProvider || null;
    updateStatus();
  }

  window.OpsinSystemMonitor = {
    start: startSystemMonitor,
    stop: stopSystemMonitor,
    update: updateStatus,
    setProvider: setProvider
  };

  window.addEventListener("load", function() {
    if (localStorage.getItem("opsin_perf_enabled") !== "false") {
      startSystemMonitor();
    } else {
      var el = document.getElementById("statusSystemMonitor");
      if (el) el.hidden = true;
    }
  });
})();
