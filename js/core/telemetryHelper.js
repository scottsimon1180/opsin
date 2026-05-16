"use strict";

/* Opsin localhost telemetry helper integration.

   Architecture:
   - Opsin stays a static file:// browser app.
   - opsin_helper.py runs separately on the user's machine.
   - The helper exposes real OS telemetry at:
     http://127.0.0.1:4821/stats

   Expected JSON:
   {
     "cpu_percent": 12.4,
     "gpu_percent": 6.1,
     "ram_percent": 48.2,
     "ram_used_gb": 7.8,
     "ram_total_gb": 16.0
   }

   Polling and reconnect behavior:
   - Poll twice per second with fetch(), which is asynchronous and does not block
     the UI thread.
   - The helper keeps live telemetry cached in the background, so /stats should
     return quickly. While one request is in flight, additional ticks are
     skipped so requests cannot pile up.
   - Store the last valid normalized sample for the status renderer.
   - On any fetch, JSON, or validation failure, mark the helper offline silently.
   - Continue polling while offline, so Opsin reconnects automatically if the
     helper launches later.

   The normalized sample can be extended later with VRAM, FPS, temperatures,
   JS heap, undo memory, or other telemetry without changing this module's
   polling lifecycle. */
(function () {
  const STATS_URL = "http://127.0.0.1:4821/stats";
  const POLL_MS = 500;

  let latestMetrics = null;
  let pollTimer = 0;
  let pollInFlight = false;

  function toFiniteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return isFinite(number) ? number : null;
  }

  function clampPercent(value) {
    const number = toFiniteNumber(value);
    return number === null ? null : Math.max(0, Math.min(100, number));
  }

  function toGb(value) {
    const number = toFiniteNumber(value);
    return number === null || number < 0 ? null : number;
  }

  function normalizeStats(raw) {
    if (!raw || typeof raw !== "object") return null;

    const metrics = {
      online: true,
      cpuPercent: clampPercent(raw.cpu_percent),
      gpuPercent: clampPercent(raw.gpu_percent),
      ramPercent: clampPercent(raw.ram_percent),
      ramUsedGb: toGb(raw.ram_used_gb),
      ramTotalGb: toGb(raw.ram_total_gb)
    };

    if (
      metrics.cpuPercent === null &&
      metrics.gpuPercent === null &&
      metrics.ramPercent === null &&
      metrics.ramUsedGb === null &&
      metrics.ramTotalGb === null
    ) {
      return null;
    }

    return metrics;
  }

  function getLatestMetrics() {
    return latestMetrics;
  }

  function publishMetrics(metrics) {
    latestMetrics = metrics;
    if (window.OpsinSystemMonitor && typeof window.OpsinSystemMonitor.update === "function") {
      window.OpsinSystemMonitor.update();
    }
  }

  async function pollStats() {
    if (pollInFlight) return;
    pollInFlight = true;

    try {
      const response = await fetch(STATS_URL, {
        cache: "no-store"
      });

      if (!response.ok) throw new Error("Telemetry helper returned HTTP " + response.status);

      const metrics = normalizeStats(await response.json());
      publishMetrics(metrics);
    } catch (err) {
      publishMetrics(null);
    } finally {
      pollInFlight = false;
    }
  }

  function startTelemetryHelper() {
    if (pollTimer) return;

    if (window.OpsinSystemMonitor && typeof window.OpsinSystemMonitor.setProvider === "function") {
      window.OpsinSystemMonitor.setProvider(getLatestMetrics);
    }

    pollStats();
    pollTimer = setInterval(pollStats, POLL_MS);
  }

  function stopTelemetryHelper() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = 0;
    publishMetrics(null);
  }

  window.OpsinTelemetryHelper = {
    start: startTelemetryHelper,
    stop: stopTelemetryHelper,
    poll: pollStats,
    getLatestMetrics: getLatestMetrics
  };

  window.addEventListener("load", function() {
    if (localStorage.getItem("opsin_perf_enabled") !== "false") {
      startTelemetryHelper();
    }
  });
})();
