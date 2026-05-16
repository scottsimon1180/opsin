from __future__ import annotations

import subprocess
import threading
import time
from flask import Flask, jsonify
from flask_cors import CORS
import psutil


# ============================================
# CONFIG
# ============================================

HOST = "127.0.0.1"
PORT = 4821
CPU_RAM_SAMPLE_INTERVAL = 0.5
GPU_SAMPLE_INTERVAL = 1.0
GIB = 1024 ** 3


# ============================================
# FLASK APP
# ============================================

app = Flask(__name__)
CORS(app)


# ============================================
# LIVE TELEMETRY CACHE
# ============================================

_stats_lock = threading.Lock()
_latest_stats = {
    "cpu_percent": None,
    "gpu_percent": None,
    "ram_percent": None,
    "ram_used_gb": None,
    "ram_total_gb": None,
}
_sampler_started = False
_last_gpu_error_log = 0.0


# ============================================
# GPU MONITORING
# ============================================

def get_gpu_percent() -> float | None:
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                r"(Get-Counter '\GPU Engine(*)\Utilization Percentage').CounterSamples | Measure-Object CookedValue -Maximum | Select-Object -ExpandProperty Maximum"
            ],
            capture_output=True,
            text=True,
            timeout=3,
            check=True,
        )

        raw_output = result.stdout.strip()

        if not raw_output:
            return None

        gpu_value = float(raw_output)
        gpu_value = max(0.0, min(gpu_value, 100.0))

        return round(gpu_value, 1)

    except Exception as e:
        global _last_gpu_error_log
        now = time.monotonic()
        if now - _last_gpu_error_log >= 10.0:
            print("GPU READ FAILED:", e)
            _last_gpu_error_log = now
        return None


def sample_cpu_ram() -> dict:
    ram = psutil.virtual_memory()
    return {
        "cpu_percent": round(psutil.cpu_percent(interval=None), 1),
        "ram_percent": round(ram.percent, 1),
        "ram_used_gb": round(ram.used / GIB, 2),
        "ram_total_gb": round(ram.total / GIB, 2),
    }


def update_cached_stats(next_values: dict) -> None:
    with _stats_lock:
        _latest_stats.update(next_values)


def cpu_ram_sampler() -> None:
    psutil.cpu_percent(interval=None)

    while True:
        update_cached_stats(sample_cpu_ram())
        time.sleep(CPU_RAM_SAMPLE_INTERVAL)


def gpu_sampler() -> None:
    while True:
        update_cached_stats({"gpu_percent": get_gpu_percent()})
        time.sleep(GPU_SAMPLE_INTERVAL)


def start_sampler() -> None:
    global _sampler_started
    if _sampler_started:
        return

    _sampler_started = True
    threading.Thread(target=cpu_ram_sampler, daemon=True).start()
    threading.Thread(target=gpu_sampler, daemon=True).start()


# ============================================
# API ROUTES
# ============================================

@app.route("/stats")
def stats():
    with _stats_lock:
        return jsonify(dict(_latest_stats))


@app.route("/health")
def health():
    return jsonify(
        {
            "status": "ok"
        }
    )


# ============================================
# START SERVER
# ============================================

if __name__ == "__main__":
    start_sampler()

    print()
    print("=" * 50)
    print(" Opsin Helper Running")
    print("=" * 50)
    print(f" URL: http://{HOST}:{PORT}")
    print()
    print(" Available Endpoints:")
    print("   /stats")
    print("   /health")
    print()
    print(" Waiting for Opsin connections...")
    print("=" * 50)
    print()

    app.run(
        host=HOST,
        port=PORT,
        threaded=True
    )
