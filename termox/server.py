"""HTTP server and samplers.

Sampling runs on background threads rather than inside request handlers,
so several browser tabs cannot corrupt the CPU deltas and a slow guest
never stalls a page load. Handlers only ever read the last snapshot.

Stdlib only.
"""

import json
import mimetypes
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import control, host, vms
from .guestlink import GuestLink
from .services import Services

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

PORT = int(os.environ.get("TERMOX_PORT", "8080"))
BIND = os.environ.get("TERMOX_BIND", "0.0.0.0")
TOKEN = os.environ.get("TERMOX_TOKEN") or None

HOST_INTERVAL = 1.0
VM_INTERVAL = 2.0
GUEST_INTERVAL = 15.0        # an emulated guest is slow to answer; do not crowd it
SERVICE_INTERVAL = 3.0
STORAGE_INTERVAL = 15.0   # volumes do not move fast enough to poll every second
BATTERY_INTERVAL = 30.0
BATTERY_RETRY = 300.0     # when the reading is unavailable
HISTORY = 90                      # samples kept for the sparklines


class State:
    """Everything the UI can ask for, refreshed in the background."""

    def __init__(self):
        self.lock = threading.Lock()
        self.host = None
        self.nodes = []
        self.guests = {}
        self.battery = {"available": False, "reason": "not sampled yet"}
        self.history = {"cpu": [], "memory": [], "rx": [], "tx": []}
        self.node_history = {}
        self.started = time.time()
        self.registry = vms.Registry()
        self.link = GuestLink()
        self.services = []
        self.service_poller = Services()
        self.jobs = control.Jobs()
        self.service_history = {}
        self.storage = []

    def push_history(self, cpu, memory, rx, tx):
        for key, value in (("cpu", cpu), ("memory", memory), ("rx", rx), ("tx", tx)):
            series = self.history[key]
            series.append(value)
            if len(series) > HISTORY:
                del series[:len(series) - HISTORY]

    def track_nodes(self, nodes, guests):
        """Keep a per-machine trend on the VM loop's clock.

        The guest reading is sampled on a slower loop, so it is held between
        polls rather than interpolated -- both series then share one step and
        the two sparklines line up in time.
        """
        for node in nodes:
            series = self.node_history.setdefault(node["key"], {"cpu": [], "guest": []})
            runtime = node.get("runtime") or {}
            guest = guests.get(node["key"]) or {}
            guest_cpu = (guest.get("cpu") or {}).get("total") if guest.get("ok") else None
            series["cpu"].append(runtime.get("cpu_percent"))
            series["guest"].append(guest_cpu)
            for values in series.values():
                if len(values) > HISTORY:
                    del values[:len(values) - HISTORY]
            node["history"] = {k: list(v) for k, v in series.items()}
        keys = {node["key"] for node in nodes}
        for stale in set(self.node_history) - keys:
            del self.node_history[stale]

    def track_services(self, services):
        """Keep a short trend per service, on the service loop's clock."""
        gpu = (self.host or {}).get("gpu") or {}
        for service in services:
            series = self.service_history.setdefault(
                service["id"], {"cpu": [], "rate": [], "gpu": []})
            series.setdefault("gpu", [])
            runtime = service.get("runtime") or {}
            metrics = service.get("metrics") or {}
            # the GPU is a host-wide resource, but on a phone running one
            # GPU-backed service its load is that service's load
            series["gpu"].append(gpu.get("percent") if service.get("uses_gpu") else None)
            series["cpu"].append(runtime.get("cpu_percent"))
            # the per-second gauge only refreshes when a request finishes, so
            # a live request would otherwise read as a hole in the trend
            series["rate"].append(metrics.get("tokens_per_second")
                                  or metrics.get("average_tps"))
            for values in series.values():
                if len(values) > HISTORY:
                    del values[:len(values) - HISTORY]
            service["history"] = {k: list(v) for k, v in series.items()}
        keys = {s["id"] for s in services}
        for stale in set(self.service_history) - keys:
            del self.service_history[stale]

    @staticmethod
    def _short(path):
        """Termux paths all begin with the same 34 characters, which pushes
        the interesting part of every row off the screen."""
        if not path:
            return path
        prefix = os.environ.get("PREFIX")
        home = os.environ.get("HOME")
        if home and path.startswith(home):
            return "~" + path[len(home):]
        if prefix and path.startswith(prefix):
            return "$PREFIX" + path[len(prefix):]
        return path

    def paths(self):
        """Where every tracked app actually lives on disk.

        Answering "which binary is this, and from where" needs /proc rather
        than the launch scripts: a service may have been started by hand, from
        a different copy, or with a config other than the one you expect.
        """
        rows = [{
            "name": "termox",
            "kind": "dashboard",
            "binary": self._short(sys.executable),
            "directory": self._short(HERE),
            "detail": self._short(vms.REGISTRY_PATH),
            "state": "running",
        }]
        for service in self.services:
            runtime = service.get("runtime") or {}
            rows.append({
                "name": service["name"],
                "kind": service.get("kind"),
                "binary": self._short(runtime.get("binary")),
                "directory": self._short(runtime.get("directory")),
                "detail": self._short(service.get("model")) or service.get("endpoint"),
                "state": service.get("state"),
            })
        for node in self.nodes:
            spec = node.get("spec") or {}
            disks = spec.get("disks") or []
            rows.append({
                "name": node["name"],
                "kind": "virtual machine",
                "binary": spec.get("binary"),
                "directory": self._short(spec.get("cwd")),
                "detail": self._short(disks[0]["path"]) if disks else None,
                "state": node.get("state"),
            })
        return rows

    def with_jobs(self, items, prefix):
        """Overlay any in-flight action onto what the sampler last saw.

        A service that is mid-restart is neither running nor stopped, and
        saying so is the whole point of showing actions in the panel.
        """
        for item in items:
            key = prefix + str(item.get("id") if prefix == "svc:" else item.get("key"))
            job = self.jobs.active_for(key)
            if job:
                item["job"] = {"action": job["action"], "message": job["message"],
                               "phase": job.get("phase"), "state": job["state"],
                               "started": job["started"]}
                item["state"] = job.get("phase") or (
                    "starting" if job["action"] == "start" else "stopping")
            else:
                item["job"] = None
        return items

    def snapshot(self):
        with self.lock:
            self.with_jobs(self.services, "svc:")
            self.with_jobs(self.nodes, "")
            return {
                "host": self.host,
                "services": self.services,
                "paths": self.paths(),
                "jobs": self.jobs.listing(),
                "control": {"enabled": True, "token_required": bool(TOKEN)},
                "nodes": self.nodes,
                "guests": self.guests,
                "history": {k: list(v) for k, v in self.history.items()},
                "server": {"uptime": time.time() - self.started,
                           "version": "0.1.0"},
                "served_at": time.time(),
            }


STATE = State()


# ------------------------------------------------------------------ samplers

def sample_cpu(source):
    return host.cpu_times() if source == "procstat" else host.idle_times()


def cpu_percents(source, prev, cur, span):
    """One shape of answer from either source: {'total': x, 'cpuN': y}."""
    out = {}
    if source == "procstat":
        for key, times in cur.items():
            value = host.cpu_percent(prev.get(key), times)
            if value is not None:
                out[key] = round(value, 1)
        return out
    if source != "cpuidle":
        return out
    per_core = host.idle_percent(prev, cur, span)
    values = []
    for index, value in per_core.items():
        if value is None:
            continue
        out["cpu%d" % index] = value
        values.append(value)
    if values:
        out["total"] = round(sum(values) / len(values), 1)
    return out


def host_loop():
    source = host.cpu_source()
    prev_cpu = sample_cpu(source)
    prev_net = host.net_counters()
    prev_at = time.time()
    identity = host.identity()
    limits = {
        "cpu_source": source,
        "network": host.network_restriction(),
        "load": host.load_restriction(),
    }
    storage, storage_at = host.storage(), 0.0
    while True:
        time.sleep(HOST_INTERVAL)
        now = time.time()
        span = now - prev_at
        if now - storage_at >= STORAGE_INTERVAL:
            storage, storage_at = host.storage(), now
        cur_cpu = sample_cpu(source)
        cur_net = host.net_counters()

        percents = cpu_percents(source, prev_cpu, cur_cpu, span)
        network = host.net_rates(prev_net, cur_net, span)
        prev_cpu, prev_net, prev_at = cur_cpu, cur_net, now

        clusters, count = host.topology()
        freqs = host.core_frequencies(count)
        cores = [{"id": i, "percent": percents.get("cpu%d" % i), "mhz": freqs.get(i)}
                 for i in range(count)]
        memory = host.memory()

        with STATE.lock:
            battery = STATE.battery
        snapshot = {
            "identity": identity,
            "uptime": host.uptime(),
            "load": host.loadavg(),
            "cpu": {"total": percents.get("total"), "count": count,
                    "clusters": clusters, "cores": cores,
                    "governor": host.governor()},
            "memory": memory,
            "storage": storage,
            "network": network,
            "gpu": host.gpu(),
            "thermals": host.thermals(),
            "battery": battery,
            "limits": limits,
        }
        with STATE.lock:
            STATE.host = snapshot
            STATE.push_history(
                percents.get("total"),
                memory["percent"] if memory else None,
                sum(n["rx_rate"] or 0 for n in network) if network else 0.0,
                sum(n["tx_rate"] or 0 for n in network) if network else 0.0,
            )


def service_loop():
    while True:
        try:
            services = STATE.service_poller.poll(SERVICE_INTERVAL)
        except Exception as exc:                # noqa: BLE001 - surfaced in the UI
            services = [{"id": "llm", "name": "Model server", "state": "error",
                         "error": str(exc)}]
        with STATE.lock:
            STATE.track_services(services)
            STATE.services = services
        time.sleep(SERVICE_INTERVAL)


def battery_loop():
    """Backs off when there is nothing to read: without the Termux:API app
    each call blocks for the full timeout, and retrying that every half
    minute buys nothing."""
    while True:
        value = host.battery()
        with STATE.lock:
            STATE.battery = value
        time.sleep(BATTERY_INTERVAL if value.get("available") else BATTERY_RETRY)


def vm_loop():
    while True:
        nodes = STATE.registry.refresh(VM_INTERVAL)
        with STATE.lock:
            STATE.track_nodes(nodes, STATE.guests)
            STATE.nodes = nodes
        time.sleep(VM_INTERVAL)


def guest_loop():
    while True:
        with STATE.lock:
            nodes = list(STATE.nodes)
        if nodes:
            try:
                guests = STATE.link.poll(nodes)
            except Exception as exc:            # noqa: BLE001 - surfaced in the UI
                guests = {n["key"]: {"ok": False, "reason": str(exc)} for n in nodes}
            with STATE.lock:
                STATE.guests = dict(guests)
        time.sleep(GUEST_INTERVAL)


# ------------------------------------------------------------------ http

def control_spec(target):
    """Turn a UI target into something control.Jobs can act on."""
    if not target:
        return None
    if target.startswith("svc:"):
        spec = control.SERVICES.get(target[4:])
        if not spec:
            return None
        spec = dict(spec)
        with STATE.lock:
            match = [s for s in STATE.services if "svc:" + s["id"] == target]
        spec["label"] = match[0]["name"] if match else target
        return spec

    with STATE.lock:
        nodes = [n for n in STATE.nodes if n["key"] == target]
    if not nodes:
        return None
    node = nodes[0]
    session, command = control.node_launcher(node)
    spec = {
        "session": session, "command": command, "label": node["name"],
        "exe": (node.get("spec") or {}).get("binary") or "qemu-system-aarch64",
        "match": None,
        "probe": next((p["host_port"] for p in node.get("ports", [])
                       if p["proto"] == "tcp" and p["guest_port"] == 22), None),
        # QEMU opens its forwarded ports immediately, so readiness has to come
        # from the guest's own ssh greeting rather than a TCP connect
        "probe_kind": "banner",
        "waiting": "booting the guest",
        "ready": "the guest has booted and ssh is answering",
    }
    # a virtual machine gets the chance to shut its filesystem down cleanly
    ssh_port = spec["probe"]
    if ssh_port:
        from .guestlink import ssh_command
        spec["graceful"] = {
            "message": "asking the guest to power off",
            "command": ssh_command({"host": "127.0.0.1", "port": ssh_port,
                                    "user": "root",
                                    "key": os.path.join(vms.TERMOX_HOME, "id_ed25519")})
                       + ["poweroff"],
            "timeout": 45,
        }
    return spec


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "termox"

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, payload, code=200):
        self._send(code, json.dumps(payload, default=str), "application/json")

    def _authorised(self, query):
        if not TOKEN:
            return True
        if self.headers.get("X-Termox-Token") == TOKEN:
            return True
        return query.get("token") == TOKEN

    def do_POST(self):                                  # noqa: N802 - stdlib API
        path, _, raw_query = self.path.partition("?")
        query = dict(
            part.split("=", 1) if "=" in part else (part, "")
            for part in raw_query.split("&") if part)
        if not self._authorised(query):
            return self._json({"error": "token required"}, 401)
        if path != "/api/control":
            return self._send(404, b"not found", "text/plain")

        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return self._json({"error": "unreadable request"}, 400)

        target, action = body.get("target"), body.get("action")
        if action not in ("start", "stop", "restart"):
            return self._json({"error": "unknown action"}, 400)

        spec = control_spec(target)
        if not spec:
            return self._json({"error": "nothing controllable called %r" % target}, 404)

        job, note = STATE.jobs.run(target, action, spec)
        return self._json({"job": job, "note": note})

    def do_GET(self):                                   # noqa: N802 - stdlib API
        path, _, raw_query = self.path.partition("?")
        query = dict(
            part.split("=", 1) if "=" in part else (part, "")
            for part in raw_query.split("&") if part)

        if path.startswith("/api/") and not self._authorised(query):
            return self._json({"error": "token required"}, 401)

        if path == "/api/state":
            return self._json(STATE.snapshot())
        if path == "/api/host":
            with STATE.lock:
                return self._json(STATE.host or {})
        if path == "/api/jobs":
            return self._json({"jobs": STATE.jobs.listing()})
        if path == "/api/services":
            with STATE.lock:
                # same overlay the full snapshot applies, so both endpoints
                # agree about what is mid-action
                return self._json({"services": STATE.with_jobs(STATE.services, "svc:")})
        if path == "/api/nodes":
            with STATE.lock:
                return self._json({"nodes": STATE.with_jobs(STATE.nodes, ""),
                                   "guests": STATE.guests})
        if path == "/api/health":
            return self._json({"ok": True, "uptime": time.time() - STATE.started})
        if path in ("/", "/index.html"):
            return self._file("index.html")
        if path.startswith("/static/"):
            return self._file(path[len("/static/"):])
        return self._send(404, b"not found", "text/plain")

    def _file(self, name):
        safe = os.path.normpath(name).lstrip("./")
        full = os.path.join(STATIC, safe)
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype == "application/javascript":
            ctype += "; charset=utf-8"
        with open(full, "rb") as fh:
            self._send(200, fh.read(), ctype)

    def log_message(self, fmt, *args):
        pass


def serve():
    for loop in (host_loop, battery_loop, vm_loop, guest_loop, service_loop):
        threading.Thread(target=loop, daemon=True).start()
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    address = host.lan_address() or BIND
    print("termox listening on http://%s:%d" % (address, PORT), flush=True)
    print("registry: %s" % vms.REGISTRY_PATH, flush=True)
    if not TOKEN:
        print("no TERMOX_TOKEN set - anyone on this network can read the "
              "dashboard", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("", flush=True)
