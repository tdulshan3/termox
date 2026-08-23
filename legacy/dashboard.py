#!/usr/bin/env python3
"""
StackScope — runs in Termux on the phone.

Serves the dashboard UI and a merged /api/stats feed covering all three
layers: the Android host, the QEMU guest, and the containers inside it.

Stdlib only. No pip install required.

    python3 dashboard.py           # listens on 0.0.0.0:8080

Environment:
    STACKSCOPE_PORT       dashboard port            (default 8080)
    STACKSCOPE_VM_AGENT   guest agent base URL      (default http://127.0.0.1:9101)
"""

import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("STACKSCOPE_PORT", "8080"))
VM_AGENT = os.environ.get("STACKSCOPE_VM_AGENT", "http://127.0.0.1:9101")
BATTERY_REFRESH = 30.0

_state = {"cpu": None, "battery": None, "vm": None}
_lock = threading.Lock()


def _read(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return None


def _read_int(path):
    raw = _read(path)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- cpu

def read_cpu_times():
    out = {}
    try:
        with open("/proc/stat") as fh:
            for line in fh:
                if not line.startswith("cpu"):
                    continue
                parts = line.split()
                key = "total" if parts[0] == "cpu" else parts[0]
                out[key] = [int(x) for x in parts[1:]]
    except OSError:
        pass
    return out


def cpu_percent(prev, cur):
    if not prev or not cur:
        return None
    idle_prev = prev[3] + (prev[4] if len(prev) > 4 else 0)
    idle_cur = cur[3] + (cur[4] if len(cur) > 4 else 0)
    dt = sum(cur) - sum(prev)
    if dt <= 0:
        return None
    busy = dt - (idle_cur - idle_prev)
    return max(0.0, min(100.0, busy * 100.0 / dt))


def cpu_topology():
    """Group cores into clusters by their max frequency.

    On a Snapdragon 865 this yields three clusters (4x A55, 3x A77,
    1x A77 Prime) without hardcoding anything device-specific. If the
    cpufreq nodes are unreadable, everything lands in one cluster.
    """
    base = "/sys/devices/system/cpu"
    cores = []
    try:
        names = sorted(
            (d for d in os.listdir(base) if re.fullmatch(r"cpu\d+", d)),
            key=lambda d: int(d[3:]),
        )
    except OSError:
        names = []
    for name in names:
        idx = int(name[3:])
        maxf = _read_int("%s/%s/cpufreq/cpuinfo_max_freq" % (base, name))
        cores.append({"id": idx, "max_khz": maxf})

    groups = {}
    for core in cores:
        groups.setdefault(core["max_khz"], []).append(core["id"])

    known = sorted((k for k in groups if k), reverse=True)
    labels = {}
    if len(known) == 3:
        labels = {known[0]: "Prime", known[1]: "Performance", known[2]: "Efficiency"}
    elif len(known) == 2:
        labels = {known[0]: "Performance", known[1]: "Efficiency"}
    elif len(known) == 1:
        labels = {known[0]: "Cores"}

    clusters = []
    for maxf in known:
        clusters.append({
            "label": labels.get(maxf, "Cluster"),
            "max_mhz": round(maxf / 1000) if maxf else None,
            "cores": sorted(groups[maxf]),
        })
    if None in groups:
        clusters.append({
            "label": "Cores", "max_mhz": None, "cores": sorted(groups[None])})
    return clusters


def core_frequencies(count):
    base = "/sys/devices/system/cpu"
    freqs = {}
    for i in range(count):
        khz = _read_int("%s/cpu%d/cpufreq/scaling_cur_freq" % (base, i))
        if khz:
            freqs[i] = round(khz / 1000)
    return freqs


# ---------------------------------------------------------------- memory / disk

def meminfo():
    vals = {}
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                k, _, rest = line.partition(":")
                vals[k] = int(rest.split()[0]) * 1024
    except OSError:
        return None
    total = vals.get("MemTotal", 0)
    avail = vals.get("MemAvailable", vals.get("MemFree", 0))
    swap_total = vals.get("SwapTotal", 0)
    return {
        "total": total,
        "available": avail,
        "used": total - avail,
        "percent": round((total - avail) * 100.0 / total, 1) if total else None,
        "swap_total": swap_total,
        "swap_used": swap_total - vals.get("SwapFree", 0),
    }


def storage():
    """Volumes the app can actually see. Android hides most mounts."""
    home = os.environ.get("HOME", os.path.expanduser("~"))
    candidates = [
        ("Internal storage", "/data"),
        ("Termux home", home),
        ("Shared storage", "/storage/emulated/0"),
    ]
    out = []
    seen = set()
    for label, path in candidates:
        if not path or not os.path.isdir(path):
            continue
        try:
            st = os.statvfs(path)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        if not total:
            continue
        key = (total, st.f_bfree)
        if key in seen:
            continue
        seen.add(key)
        used = total - (st.f_bfree * st.f_frsize)
        out.append({
            "label": label,
            "path": path,
            "total": total,
            "used": used,
            "free": st.f_bavail * st.f_frsize,
            "percent": round(used * 100.0 / total, 1),
        })
    return out


# ---------------------------------------------------------------- gpu / thermal

def gpu():
    """Adreno stats via the kgsl sysfs nodes.

    These are frequently root-only on stock Android 13, so a null result
    here is expected rather than a bug.
    """
    base = "/sys/class/kgsl/kgsl-3d0"
    if not os.path.isdir(base):
        return {"available": False, "reason": "no kgsl node on this device"}

    busy_raw = _read("%s/gpubusy" % base)
    percent = None
    if busy_raw:
        parts = busy_raw.split()
        if len(parts) >= 2:
            try:
                busy, total = int(parts[0]), int(parts[1])
                if total > 0:
                    percent = round(min(100.0, busy * 100.0 / total), 1)
            except ValueError:
                pass

    clk = _read_int("%s/gpuclk" % base)
    maxclk = _read_int("%s/max_gpuclk" % base)
    if busy_raw is None and clk is None:
        return {"available": False, "reason": "kgsl present but not readable (needs root)"}
    return {
        "available": True,
        "percent": percent,
        "clock_mhz": round(clk / 1_000_000) if clk else None,
        "max_clock_mhz": round(maxclk / 1_000_000) if maxclk else None,
    }


def thermals():
    base = "/sys/class/thermal"
    out = []
    try:
        zones = sorted(
            (d for d in os.listdir(base) if d.startswith("thermal_zone")),
            key=lambda d: int(d.replace("thermal_zone", "") or 0),
        )
    except OSError:
        return out
    wanted = ("cpu", "gpu", "batt", "skin", "soc", "quiet", "therm")
    for zone in zones:
        kind = (_read("%s/%s/type" % (base, zone)) or "").lower()
        raw = _read_int("%s/%s/temp" % (base, zone))
        if raw is None:
            continue
        celsius = raw / 1000.0 if abs(raw) > 1000 else float(raw)
        if not (-40 < celsius < 150):
            continue
        if not any(w in kind for w in wanted):
            continue
        out.append({"zone": kind, "celsius": round(celsius, 1)})
    out.sort(key=lambda z: -z["celsius"])
    return out[:6]


def battery():
    """Needs the Termux:API app plus `pkg install termux-api`."""
    try:
        raw = subprocess.run(
            ["termux-battery-status"],
            capture_output=True, text=True, timeout=12,
        )
        if raw.returncode != 0:
            return {"available": False, "reason": "termux-api not responding"}
        data = json.loads(raw.stdout)
        temp = data.get("temperature")
        return {
            "available": True,
            "percentage": data.get("percentage"),
            "status": data.get("status"),
            "plugged": data.get("plugged"),
            "health": data.get("health"),
            "celsius": round(temp, 1) if isinstance(temp, (int, float)) else None,
        }
    except FileNotFoundError:
        return {"available": False, "reason": "termux-api package not installed"}
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI
        return {"available": False, "reason": str(exc)}


# ---------------------------------------------------------------- background

def cpu_loop():
    prev = read_cpu_times()
    while True:
        time.sleep(1.0)
        cur = read_cpu_times()
        result = {}
        for key, times in cur.items():
            pct = cpu_percent(prev.get(key), times)
            if pct is not None:
                result[key] = round(pct, 1)
        prev = cur
        with _lock:
            _state["cpu"] = result


def battery_loop():
    while True:
        value = battery()
        with _lock:
            _state["battery"] = value
        time.sleep(BATTERY_REFRESH)


def vm_loop():
    while True:
        started = time.time()
        try:
            with urllib.request.urlopen(VM_AGENT + "/stats", timeout=10) as resp:
                data = json.loads(resp.read())
            data["latency_ms"] = round((time.time() - started) * 1000)
            value = data
        except urllib.error.URLError as exc:
            value = {"ok": False, "error": "guest agent unreachable: %s" % exc.reason}
        except Exception as exc:  # noqa: BLE001 - surfaced to the UI
            value = {"ok": False, "error": str(exc)}
        with _lock:
            _state["vm"] = value
        time.sleep(2.0)


# ---------------------------------------------------------------- payload

def host_snapshot():
    with _lock:
        cpu = dict(_state["cpu"] or {})
        batt = _state["battery"]
    clusters = cpu_topology()
    count = sum(len(c["cores"]) for c in clusters) or os.cpu_count() or 0
    freqs = core_frequencies(count)
    cores = []
    for i in range(count):
        cores.append({
            "id": i,
            "percent": cpu.get("cpu%d" % i),
            "mhz": freqs.get(i),
        })
    return {
        "hostname": socket.gethostname(),
        "uptime": _uptime(),
        "load": _loadavg(),
        "cpu": {
            "total": cpu.get("total"),
            "count": count,
            "clusters": clusters,
            "cores": cores,
        },
        "memory": meminfo(),
        "storage": storage(),
        "gpu": gpu(),
        "thermals": thermals(),
        "battery": batt,
    }


def _uptime():
    try:
        with open("/proc/uptime") as fh:
            return float(fh.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def _loadavg():
    try:
        with open("/proc/loadavg") as fh:
            p = fh.read().split()
        return [float(p[0]), float(p[1]), float(p[2])]
    except (OSError, ValueError, IndexError):
        return None


def merged():
    with _lock:
        vm = _state["vm"]
    return {
        "host": host_snapshot(),
        "guest": vm or {"ok": False, "error": "no sample yet"},
        "served_at": time.time(),
    }


# ---------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.split("?")[0]
        if path == "/api/stats":
            self._send(200, json.dumps(merged()).encode(), "application/json")
        elif path in ("/", "/index.html"):
            try:
                with open(os.path.join(HERE, "dashboard.html"), "rb") as fh:
                    self._send(200, fh.read(), "text/html; charset=utf-8")
            except OSError:
                self._send(500, b"dashboard.html is missing from " + HERE.encode(),
                           "text/plain")
        else:
            self._send(404, b"Not found", "text/plain")

    def log_message(self, fmt, *args):
        pass  # quiet


def main():
    threading.Thread(target=cpu_loop, daemon=True).start()
    threading.Thread(target=battery_loop, daemon=True).start()
    threading.Thread(target=vm_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("StackScope on 0.0.0.0:%d  (guest agent: %s)" % (PORT, VM_AGENT), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
