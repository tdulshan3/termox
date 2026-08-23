#!/usr/bin/env python3
"""
StackScope VM agent — runs inside the Alpine guest.

Exposes GET /stats as JSON: guest CPU (aggregate + per-core), memory,
filesystems, load, uptime, and per-container Docker stats.

Stdlib only. No pip install required.

    apk add python3
    python3 vmagent.py            # listens on 0.0.0.0:9101
"""

import http.client
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("STACKSCOPE_PORT", "9101"))
DOCKER_SOCK = "/var/run/docker.sock"
DOCKER_REFRESH = float(os.environ.get("STACKSCOPE_DOCKER_REFRESH", "8"))

_state = {"cpu": None, "docker": {"containers": [], "error": None, "ts": 0}}
_lock = threading.Lock()


# ---------------------------------------------------------------- /proc

def read_cpu_times():
    """Return {'total': [...], 'cpu0': [...], ...} of jiffy counters."""
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
    """Percent busy between two jiffy snapshots."""
    if not prev or not cur:
        return None
    idle_prev = prev[3] + (prev[4] if len(prev) > 4 else 0)
    idle_cur = cur[3] + (cur[4] if len(cur) > 4 else 0)
    total_prev, total_cur = sum(prev), sum(cur)
    dt = total_cur - total_prev
    if dt <= 0:
        return None
    busy = dt - (idle_cur - idle_prev)
    return max(0.0, min(100.0, busy * 100.0 / dt))


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
    swap_free = vals.get("SwapFree", 0)
    return {
        "total": total,
        "available": avail,
        "used": total - avail,
        "percent": round((total - avail) * 100.0 / total, 1) if total else None,
        "swap_total": swap_total,
        "swap_used": swap_total - swap_free,
    }


def filesystems():
    out = []
    seen = set()
    try:
        with open("/proc/mounts") as fh:
            entries = [l.split() for l in fh]
    except OSError:
        entries = [["-", "/", "-"]]
    skip_types = {
        "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2",
        "overlay", "mqueue", "securityfs", "pstore", "debugfs", "bpf",
        "configfs", "fusectl", "tracefs", "ramfs", "squashfs", "autofs",
    }
    for parts in entries:
        if len(parts) < 3:
            continue
        device, mount, fstype = parts[0], parts[1], parts[2]
        if fstype in skip_types or mount in seen:
            continue
        seen.add(mount)
        try:
            st = os.statvfs(mount)
        except OSError:
            continue
        total = st.f_blocks * st.f_frsize
        if total == 0:
            continue
        free = st.f_bavail * st.f_frsize
        used = total - (st.f_bfree * st.f_frsize)
        out.append({
            "mount": mount,
            "device": device,
            "fstype": fstype,
            "total": total,
            "used": used,
            "free": free,
            "percent": round(used * 100.0 / total, 1),
        })
    return out


def loadavg():
    try:
        with open("/proc/loadavg") as fh:
            p = fh.read().split()
        return [float(p[0]), float(p[1]), float(p[2])]
    except (OSError, ValueError, IndexError):
        return None


def uptime_seconds():
    try:
        with open("/proc/uptime") as fh:
            return float(fh.read().split()[0])
    except (OSError, ValueError, IndexError):
        return None


# ---------------------------------------------------------------- docker

class _UnixHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection that talks to a unix domain socket."""

    def __init__(self, path, timeout=25):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        sock.connect(self._path)
        self.sock = sock


def docker_get(path, timeout=25):
    conn = _UnixHTTPConnection(DOCKER_SOCK, timeout=timeout)
    try:
        conn.request("GET", path)
        resp = conn.getresponse()
        body = resp.read()
        if resp.status >= 400:
            raise RuntimeError("docker api %s: %s" % (resp.status, body[:200]))
        return json.loads(body)
    finally:
        conn.close()


def container_cpu_percent(s):
    try:
        cpu, pre = s["cpu_stats"], s["precpu_stats"]
        cpu_delta = cpu["cpu_usage"]["total_usage"] - pre["cpu_usage"]["total_usage"]
        sys_delta = cpu.get("system_cpu_usage", 0) - pre.get("system_cpu_usage", 0)
        ncpu = cpu.get("online_cpus") or len(
            cpu["cpu_usage"].get("percpu_usage") or [1])
        if sys_delta > 0 and cpu_delta >= 0:
            return round(cpu_delta / sys_delta * ncpu * 100.0, 1)
    except (KeyError, TypeError, ZeroDivisionError):
        pass
    return None


def container_memory(s):
    try:
        mem = s["memory_stats"]
        usage = mem.get("usage")
        if usage is None:
            return None
        detail = mem.get("stats", {})
        # cgroup v2 uses inactive_file; v1 uses total_inactive_file
        cache = detail.get("inactive_file", detail.get("total_inactive_file", 0))
        used = max(0, usage - cache)
        limit = mem.get("limit") or 0
        return {
            "used": used,
            "limit": limit,
            "percent": round(used * 100.0 / limit, 1) if limit else None,
        }
    except (KeyError, TypeError):
        return None


def sample_docker():
    """Refresh the cached container list. Runs on a background thread."""
    if not os.path.exists(DOCKER_SOCK):
        with _lock:
            _state["docker"] = {
                "containers": [],
                "error": "no socket at %s - is the docker service started?" % DOCKER_SOCK,
                "ts": time.time(),
            }
        return
    try:
        listing = docker_get("/containers/json?all=1")
    except PermissionError:
        msg = "permission denied on %s - run the agent as root" % DOCKER_SOCK
        with _lock:
            _state["docker"] = {"containers": [], "error": msg, "ts": time.time()}
        return
    except Exception as exc:  # noqa: BLE001 - surfaced to the UI
        with _lock:
            _state["docker"] = {
                "containers": [], "error": str(exc), "ts": time.time()}
        return

    containers = []
    for c in listing:
        cid = c["Id"]
        name = (c.get("Names") or ["/?"])[0].lstrip("/")
        row = {
            "id": cid[:12],
            "name": name,
            "image": c.get("Image", ""),
            "state": c.get("State", ""),
            "status": c.get("Status", ""),
            "cpu_percent": None,
            "memory": None,
        }
        if c.get("State") == "running":
            try:
                s = docker_get("/containers/%s/stats?stream=false" % cid)
                row["cpu_percent"] = container_cpu_percent(s)
                row["memory"] = container_memory(s)
            except Exception:  # noqa: BLE001 - a dead container is not fatal
                pass
        containers.append(row)

    containers.sort(key=lambda r: (r["state"] != "running", r["name"]))
    with _lock:
        _state["docker"] = {
            "containers": containers, "error": None, "ts": time.time()}


def docker_loop():
    while True:
        sample_docker()
        time.sleep(DOCKER_REFRESH)


# ---------------------------------------------------------------- sampling

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


def snapshot():
    with _lock:
        cpu = dict(_state["cpu"] or {})
        docker = dict(_state["docker"])
    cores = sorted(
        (k for k in cpu if k.startswith("cpu")),
        key=lambda k: int(k[3:]),
    )
    return {
        "ok": True,
        "hostname": socket.gethostname(),
        "uptime": uptime_seconds(),
        "load": loadavg(),
        "cpu": {
            "total": cpu.get("total"),
            "cores": [{"id": int(k[3:]), "percent": cpu[k]} for k in cores],
            "count": len(cores) or os.cpu_count(),
        },
        "memory": meminfo(),
        "filesystems": filesystems(),
        "docker": docker,
        "sampled_at": time.time(),
    }


# ---------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.split("?")[0] not in ("/stats", "/"):
            self.send_error(404, "Only /stats is served here")
            return
        payload = json.dumps(snapshot()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        pass  # quiet


def main():
    threading.Thread(target=cpu_loop, daemon=True).start()
    threading.Thread(target=docker_loop, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("StackScope VM agent listening on 0.0.0.0:%d" % PORT, flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
