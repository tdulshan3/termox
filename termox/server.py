"""HTTP server and samplers.

Sampling runs on background threads rather than inside request handlers,
so several browser tabs cannot corrupt the CPU deltas and a slow guest
never stalls a page load. Handlers only ever read the last snapshot.

Stdlib only.
"""

import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import host, vms
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
        for service in services:
            series = self.service_history.setdefault(
                service["id"], {"cpu": [], "rate": []})
            runtime = service.get("runtime") or {}
            metrics = service.get("metrics") or {}
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

    def snapshot(self):
        with self.lock:
            return {
                "host": self.host,
                "services": self.services,
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
        if path == "/api/services":
            with STATE.lock:
                return self._json({"services": STATE.services})
        if path == "/api/nodes":
            with STATE.lock:
                return self._json({"nodes": STATE.nodes, "guests": STATE.guests})
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
