"""The VM registry.

Nodes are discovered by walking /proc for qemu-system-* processes and
parsing their argv, so VMs started by hand or from a tmux session show up
without being told about. What we learn is persisted, which is what lets a
node keep existing in the UI after it stops -- the Proxmox behaviour, where
a VM is a thing you own rather than a process that happens to be up.

Nothing here needs root. Android's hidepid means /proc only exposes this
app's own processes, which is exactly the set we care about.
"""

import json
import os
import re
import socket
import struct
import time

from . import host as _host

CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100

TERMOX_HOME = os.environ.get(
    "TERMOX_HOME",
    os.path.join(os.environ.get("XDG_CONFIG_HOME") or
                 os.path.join(os.path.expanduser("~"), ".config"), "termox"),
)
REGISTRY_PATH = os.path.join(TERMOX_HOME, "registry.json")

PORT_LABELS = {22: "ssh", 53: "dns", 80: "http", 443: "https", 3000: "http",
               5432: "postgres", 8006: "web", 8080: "http", 8443: "https",
               9090: "web"}


# ------------------------------------------------------------------ /proc

def _pids():
    try:
        return [int(d) for d in os.listdir("/proc") if d.isdigit()]
    except OSError:
        return []


def _argv(pid):
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    if not raw:
        return None
    return [p.decode("utf-8", "replace") for p in raw.split(b"\0") if p]


def _cwd(pid):
    try:
        return os.readlink("/proc/%d/cwd" % pid)
    except OSError:
        return None


def proc_sample(pid):
    """Jiffies + RSS for one pid, or None if it is gone."""
    try:
        with open("/proc/%d/stat" % pid) as fh:
            raw = fh.read()
    except OSError:
        return None
    # comm can contain spaces and parens; everything real follows the last ')'
    close = raw.rfind(")")
    if close < 0:
        return None
    fields = raw[close + 2:].split()
    try:
        return {
            "utime": int(fields[11]),
            "stime": int(fields[12]),
            "threads": int(fields[17]),
            "starttime": int(fields[19]),
            "rss": int(fields[21]) * os.sysconf("SC_PAGE_SIZE"),
        }
    except (IndexError, ValueError):
        return None


def proc_uptime_seconds(starttime):
    """How long this process has been up.

    Goes through host.uptime() rather than reading /proc/uptime here: that
    file is denied on Samsung builds, and the host module already knows how
    to pin the boot instant without it.
    """
    up = _host.uptime()
    if up is None:
        return None
    return max(0.0, up - starttime / CLK_TCK)


# ------------------------------------------------------------------ argv parsing

def _kv(blob):
    """Parse `a=1,b=2,flag` into a dict; bare tokens map to True."""
    out = {}
    for part in blob.split(","):
        if not part:
            continue
        key, sep, val = part.partition("=")
        out[key.strip()] = val if sep else True
    return out


def _multi(blob):
    """Like _kv but keeps every repeat of a key (hostfwd appears N times)."""
    out = []
    for part in blob.split(","):
        if not part:
            continue
        key, sep, val = part.partition("=")
        out.append((key.strip(), val if sep else True))
    return out


def _mem_mb(value):
    if value is None:
        return None
    text = str(value).strip()
    if "=" in text:                      # -m size=4096,slots=...
        text = str(_kv(text).get("size", ""))
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([KMGTkmgt]?)i?[Bb]?", text)
    if not match:
        return None
    scale = {"": 1, "k": 1 / 1024, "m": 1, "g": 1024, "t": 1024 * 1024}
    return round(float(match.group(1)) * scale[match.group(2).lower()])


def _cores(value):
    if value is None:
        return None
    text = str(value)
    if "=" in text:
        parsed = _kv(text)
        for key in ("cpus", "maxcpus"):
            if isinstance(parsed.get(key), str):
                try:
                    return int(parsed[key])
                except ValueError:
                    pass
        return None
    try:
        return int(text.split(",")[0])
    except ValueError:
        return None


HOSTFWD = re.compile(
    r"(?P<proto>tcp|udp):(?P<hostaddr>[^:]*):(?P<hostport>\d+)-"
    r"(?P<guestaddr>[^:]*):(?P<guestport>\d+)")


def _forwards(blob):
    out = []
    for key, val in _multi(blob):
        if key != "hostfwd" or val is True:
            continue
        match = HOSTFWD.fullmatch(val)
        if not match:
            continue
        guest_port = int(match.group("guestport"))
        host_port = int(match.group("hostport"))
        out.append({
            "proto": match.group("proto"),
            "host_addr": match.group("hostaddr") or "0.0.0.0",
            "host_port": host_port,
            "guest_port": guest_port,
            "label": PORT_LABELS.get(guest_port) or PORT_LABELS.get(host_port),
        })
    return out


def _abspath(path, cwd):
    if not path:
        return path
    if os.path.isabs(path):
        return os.path.normpath(path)
    return os.path.normpath(os.path.join(cwd or "/", path))


def qcow2_virtual_size(path):
    """Virtual size out of a qcow2 header, without shelling out to qemu-img."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(32)
    except OSError:
        return None
    if len(head) < 32 or head[:4] != b"QFI\xfb":
        return None
    return struct.unpack(">Q", head[24:32])[0]


def _disk(path, fmt, iface, cwd):
    full = _abspath(path, cwd)
    entry = {"path": full, "name": os.path.basename(full), "format": fmt,
             "interface": iface, "allocated": None, "virtual": None,
             "missing": False}
    try:
        entry["allocated"] = os.stat(full).st_size
    except OSError:
        entry["missing"] = True
        return entry
    virtual = qcow2_virtual_size(full)
    if virtual is None:
        if (fmt or "raw").lower() == "raw":
            virtual = entry["allocated"]
    else:
        entry["format"] = entry["format"] or "qcow2"
    entry["virtual"] = virtual
    return entry


def parse_qemu(argv, cwd=None):
    """Turn a qemu-system-* argv into a machine spec."""
    binary = os.path.basename(argv[0])
    arch = binary[len("qemu-system-"):] if binary.startswith("qemu-system-") else None
    spec = {
        "binary": binary, "arch": arch, "machine": None, "cpu": None,
        "cores": None, "memory_mb": None, "accel": None, "name": None,
        "disks": [], "cdroms": [], "forwards": [], "qmp": None,
        "monitor": None, "vnc": None, "display": None, "bios": None,
        "cwd": cwd, "argv": list(argv),
    }
    accel = None
    i = 1
    while i < len(argv):
        arg, value = argv[i], None
        if arg.startswith("-") and i + 1 < len(argv) and not argv[i + 1].startswith("-"):
            value = argv[i + 1]

        if arg == "-name" and value:
            spec["name"] = (_kv(value).get("guest") if "=" in value
                            else value.split(",")[0])
        elif arg in ("-m", "-mem") and value:
            spec["memory_mb"] = _mem_mb(value)
        elif arg == "-smp" and value:
            spec["cores"] = _cores(value)
        elif arg == "-cpu" and value:
            spec["cpu"] = value.split(",")[0]
        elif arg in ("-M", "-machine") and value:
            parsed = _kv(value)
            spec["machine"] = next(iter(parsed), None)
            if isinstance(parsed.get("type"), str):
                spec["machine"] = parsed["type"]
            if isinstance(parsed.get("accel"), str):
                accel = parsed["accel"]
        elif arg == "-accel" and value:
            accel = value.split(",")[0]
        elif arg == "-enable-kvm":
            accel = "kvm"
        elif arg == "-drive" and value:
            parsed = _kv(value)
            path = parsed.get("file")
            if isinstance(path, str):
                fmt = parsed.get("format")
                iface = parsed.get("if")
                disk = _disk(path,
                             fmt if isinstance(fmt, str) else None,
                             iface if isinstance(iface, str) else None, cwd)
                bucket = "cdroms" if parsed.get("media") == "cdrom" else "disks"
                spec[bucket].append(disk)
        elif arg in ("-hda", "-hdb", "-hdc", "-hdd") and value:
            spec["disks"].append(_disk(value, None, "ide", cwd))
        elif arg == "-cdrom" and value:
            spec["cdroms"].append(_disk(value, "raw", "ide", cwd))
        elif arg in ("-netdev", "-nic", "-net") and value:
            spec["forwards"].extend(_forwards(value))
        elif arg == "-qmp" and value:
            spec["qmp"] = value
        elif arg == "-monitor" and value:
            spec["monitor"] = value
        elif arg == "-vnc" and value:
            spec["vnc"] = value
        elif arg == "-display" and value:
            spec["display"] = value
        elif arg == "-nographic":
            spec["display"] = "nographic"
        elif arg == "-bios" and value:
            spec["bios"] = _abspath(value, cwd)
        i += 1 if value is None else 2

    spec["accel"] = accel or "tcg"
    seen, unique = set(), []
    for fwd in spec["forwards"]:          # -netdev and -nic can restate a rule
        key = (fwd["proto"], fwd["host_port"], fwd["guest_port"])
        if key not in seen:
            seen.add(key)
            unique.append(fwd)
    spec["forwards"] = sorted(unique, key=lambda f: f["host_port"])
    return spec


def _slug(text):
    slug = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")
    return slug or "vm"


def identify(spec, pid):
    """Stable identity for a machine across restarts.

    The primary disk is the most durable handle: qemu is usually started
    without -name, and the pid obviously changes every boot.
    """
    if spec["name"]:
        return _slug(spec["name"]), spec["name"]
    if spec["disks"]:
        stem = os.path.splitext(os.path.basename(spec["disks"][0]["path"]))[0]
        return _slug(stem), stem
    return "vm-%d" % pid, "vm-%d" % pid


def registry_key(spec, fallback):
    if spec["disks"]:
        return "disk:" + spec["disks"][0]["path"]
    if spec["name"]:
        return "name:" + spec["name"]
    return "id:" + fallback


# ------------------------------------------------------------------ probes

def probe(port, host="127.0.0.1", timeout=0.4):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        return sock.connect_ex((host, port)) == 0
    except OSError:
        return False
    finally:
        sock.close()


# ------------------------------------------------------------------ registry

def _load():
    try:
        with open(REGISTRY_PATH) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data.get("nodes", {}) if isinstance(data, dict) else {}


def _save(nodes):
    try:
        os.makedirs(TERMOX_HOME, exist_ok=True)
        tmp = REGISTRY_PATH + ".tmp"
        with open(tmp, "w") as fh:
            json.dump({"version": 1, "nodes": nodes}, fh, indent=2)
        os.replace(tmp, REGISTRY_PATH)
    except OSError:
        pass


class Registry:
    """Discovered + remembered machines, refreshed by a sampler thread."""

    def __init__(self):
        self.nodes = _load()
        self._cpu_prev = {}
        self._probe_cache = {}
        self._probe_at = 0.0

    def discover(self):
        """One pass over /proc; returns {registry_key: live info}."""
        live = {}
        for pid in _pids():
            argv = _argv(pid)
            if not argv or not os.path.basename(argv[0]).startswith("qemu-system"):
                continue
            spec = parse_qemu(argv, _cwd(pid))
            node_id, name = identify(spec, pid)
            live[registry_key(spec, node_id)] = {
                "id": node_id, "name": name, "pid": pid, "spec": spec}
        return live

    def refresh(self, interval):
        """Merge a discovery pass into the registry and compute rates."""
        live = self.discover()
        stamp = time.time()

        for key, found in live.items():
            record = self.nodes.get(key)
            if record is None:
                record = {"id": found["id"], "first_seen": stamp, "boots": 0,
                          "source": "discovered"}
                self.nodes[key] = record
            if record.get("last_pid") != found["pid"]:
                record["boots"] = record.get("boots", 0) + 1
            record.update({"name": found["name"], "id": found["id"],
                           "spec": found["spec"], "last_seen": stamp,
                           "last_pid": found["pid"]})

        self._refresh_probes(live, stamp)

        out = [self._render(key, record, live.get(key), interval)
               for key, record in self.nodes.items()]
        out.sort(key=lambda n: (n["state"] != "running", n["name"].lower()))
        _save(self.nodes)
        return out

    def _refresh_probes(self, live, stamp):
        if stamp - self._probe_at < 6.0:
            return
        self._probe_at = stamp
        cache = {}
        for found in live.values():
            for fwd in found["spec"]["forwards"]:
                if fwd["proto"] == "tcp":
                    cache[fwd["host_port"]] = probe(fwd["host_port"])
        self._probe_cache = cache

    def _render(self, key, record, found, interval):
        spec = record.get("spec") or {}
        node = {
            "key": key,
            "id": record.get("id"),
            "name": record.get("name") or record.get("id"),
            "state": "running" if found else "stopped",
            "source": record.get("source", "discovered"),
            "first_seen": record.get("first_seen"),
            "last_seen": record.get("last_seen"),
            "boots": record.get("boots", 0),
            "spec": {k: v for k, v in spec.items() if k != "argv"},
            "cmdline": " ".join(spec.get("argv") or []),
            "controllable": bool(spec.get("qmp")),
            "runtime": None,
            "ports": [],
        }
        for fwd in spec.get("forwards", []):
            entry = dict(fwd)
            entry["open"] = (self._probe_cache.get(fwd["host_port"])
                             if fwd["proto"] == "tcp" and found else False)
            node["ports"].append(entry)

        if not found:
            self._cpu_prev.pop(key, None)
            return node

        pid = found["pid"]
        sample = proc_sample(pid)
        if sample:
            prev = self._cpu_prev.get(key)
            percent = None
            if prev and prev["pid"] == pid and interval > 0:
                jiffies = ((sample["utime"] + sample["stime"]) -
                           (prev["utime"] + prev["stime"]))
                if jiffies >= 0:
                    percent = round(jiffies * 100.0 / (CLK_TCK * interval), 1)
            self._cpu_prev[key] = {"pid": pid, "utime": sample["utime"],
                                   "stime": sample["stime"]}
            cores = spec.get("cores") or 1
            node["runtime"] = {
                "pid": pid,
                "cpu_percent": percent,
                "cpu_of_allocated": (round(min(100.0, percent / cores), 1)
                                     if percent is not None else None),
                "rss": sample["rss"],
                "threads": sample["threads"],
                "uptime": proc_uptime_seconds(sample["starttime"]),
            }
        return node

    def forget(self, key):
        if key in self.nodes:
            del self.nodes[key]
            _save(self.nodes)
            return True
        return False
