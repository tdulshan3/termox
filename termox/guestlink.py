"""Agentless collection from inside a guest, over SSH.

Nothing is installed in the VM. One multiplexed SSH connection per node
runs a POSIX-sh probe that cats /proc and asks Docker for its containers,
and the reply is parsed back here. That works on a stock Alpine image with
no Python in it, and it keeps working for any VM created later -- the only
requirement is sshd plus a key.

A node is wired up automatically when it forwards a host port to guest
port 22. Overrides live in guests.json next to the registry.
"""

import hashlib
import json
import os
import shutil
import subprocess
import time

from . import vms

GUESTS_PATH = os.path.join(vms.TERMOX_HOME, "guests.json")
KEY_PATH = os.path.join(vms.TERMOX_HOME, "id_ed25519")
# The multiplexing socket lives under TMPDIR, not TERMOX_HOME: a unix socket
# path has to fit in 108 bytes, and Termux home paths are long enough that
# ~/.config/termox/sockets/<hash> can blow the limit on its own.
SOCKET_MAX = 100

# A loaded TCG guest can take twenty seconds just to answer the SSH banner,
# so these are sized for emulation rather than for a real network.
SSH_TIMEOUT = float(os.environ.get("TERMOX_SSH_TIMEOUT", "45"))

DOCKER_REFRESH = float(os.environ.get("TERMOX_DOCKER_REFRESH", "240"))
DOCKER_CACHE = "/tmp/termox-docker"

# Reading /proc costs about a second. `docker ps` costs eighteen and
# `docker stats` twenty-two, because the Go CLI has to start up under TCG
# emulation -- the data is cheap, the binary is not. So the poll never waits
# on Docker: it reads a cache file inside the guest and, when that has gone
# stale, kicks off a detached refresh that lands on a later poll. A lock file
# keeps those from stacking up, and the default cadence is deliberately slow,
# because each refresh pegs an emulated core for most of a minute.
PROBE = r"""
echo '@os'; head -n 4 /etc/os-release 2>/dev/null
echo '@kernel'; uname -sr
echo '@host'; hostname
echo '@stat'; cat /proc/stat
echo '@meminfo'; head -n 5 /proc/meminfo; grep -E '^(SwapTotal|SwapFree|Cached|Buffers)' /proc/meminfo
echo '@uptime'; cat /proc/uptime
echo '@loadavg'; cat /proc/loadavg
echo '@netdev'; cat /proc/net/dev
echo '@df'; df -Pk 2>/dev/null

if command -v docker >/dev/null 2>&1; then
    echo '@dockerhas'; echo yes
    now=$(date +%s)
    age=-1
    [ -f __CACHE__ ] && age=$((now - $(stat -c %Y __CACHE__ 2>/dev/null || echo 0)))
    echo '@dockerage'; echo $age
    echo '@docker'; [ -f __CACHE__ ] && cat __CACHE__
    if [ "$age" -lt 0 ] || [ "$age" -gt __REFRESH__ ]; then
        stale=1
        if [ -f __CACHE__.lock ]; then
            held=$((now - $(stat -c %Y __CACHE__.lock 2>/dev/null || echo 0)))
            [ "$held" -lt 300 ] && stale=0
        fi
        if [ "$stale" = 1 ]; then
            : > __CACHE__.lock
            nohup sh -c '{ docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}"; echo "--stats--"; docker stats --no-stream --format "{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}"; } > __CACHE__.tmp 2>/dev/null && mv __CACHE__.tmp __CACHE__; rm -f __CACHE__.lock' >/dev/null 2>&1 &
        fi
    fi
else
    echo '@dockerhas'; echo no
fi
echo '@end'
""".replace("__CACHE__", DOCKER_CACHE).replace("__REFRESH__", str(int(DOCKER_REFRESH)))


# ------------------------------------------------------------------ targets

def load_targets():
    try:
        with open(GUESTS_PATH) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_targets(targets):
    try:
        os.makedirs(vms.TERMOX_HOME, exist_ok=True)
        tmp = GUESTS_PATH + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(targets, fh, indent=2)
        os.replace(tmp, GUESTS_PATH)
    except OSError:
        pass


def target_for(node, overrides):
    """Where to SSH for this node, or None if it has no obvious door."""
    override = overrides.get(node["key"]) or overrides.get(node["id"]) or {}
    if override.get("enabled") is False:
        return None
    port = override.get("port")
    if not port:
        for fwd in node.get("ports", []):
            if fwd["proto"] == "tcp" and fwd["guest_port"] == 22:
                port = fwd["host_port"]
                break
    if not port:
        return None
    return {
        "host": override.get("host", "127.0.0.1"),
        "port": int(port),
        "user": override.get("user", "root"),
        "key": override.get("identity", KEY_PATH),
    }


def control_path(target):
    """A short-enough socket path, or None to skip multiplexing."""
    digest = hashlib.sha1(
        ("%s@%s:%d" % (target["user"], target["host"], target["port"])).encode()
    ).hexdigest()[:10]
    name = "termox-%s.sock" % digest
    for base in (os.environ.get("TMPDIR"), "/tmp", vms.TERMOX_HOME):
        if not base:
            continue
        candidate = os.path.join(base, name)
        if len(candidate) >= SOCKET_MAX:
            continue
        try:
            os.makedirs(base, exist_ok=True)
        except OSError:
            continue
        return candidate
    return None


# An emulated ARM guest has no crypto instructions, so the key exchange is
# the single most expensive thing we ask of it -- in `top` inside the guest,
# sshd-auth outranks every real workload. chacha20 is the cheapest cipher in
# software there, and one long-lived master connection means we pay for that
# handshake once rather than on every poll.
CRYPTO = [
    "-o", "Ciphers=chacha20-poly1305@openssh.com,aes128-ctr",
    "-o", "MACs=umac-64-etm@openssh.com,hmac-sha2-256",
]


def ssh_command(target, extra=()):
    cmd = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=30",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=%s" % os.path.join(vms.TERMOX_HOME, "known_hosts"),
        "-o", "LogLevel=ERROR",
        "-p", str(target["port"]),
    ] + CRYPTO
    socket_path = control_path(target)
    if socket_path:
        cmd += ["-o", "ControlPath=%s" % socket_path]
    if target.get("key") and os.path.exists(target["key"]):
        cmd += ["-i", target["key"], "-o", "IdentitiesOnly=yes"]
    cmd += list(extra)
    cmd.append("%s@%s" % (target["user"], target["host"]))
    return cmd


MASTER_TIMEOUT = float(os.environ.get("TERMOX_MASTER_TIMEOUT", "90"))


def master_alive(target):
    socket_path = control_path(target)
    if not socket_path or not os.path.exists(socket_path):
        return False
    try:
        return subprocess.run(
            ssh_command(target, ["-O", "check"]),
            capture_output=True, text=True, timeout=10).returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def ensure_master(target):
    """Bring up the shared connection, patiently, before any probe rides it.

    Returns None on success or a reason. The long timeout applies only here:
    it is the one handshake, and it buys every later poll a cheap channel.
    """
    if not control_path(target):
        return None                       # no socket path fits; probes go direct
    if master_alive(target):
        return None
    try:
        proc = subprocess.run(
            ssh_command(target, ["-M", "-N", "-f",
                                 "-o", "ControlPersist=600"]),
            capture_output=True, text=True, timeout=MASTER_TIMEOUT)
    except subprocess.TimeoutExpired:
        return "guest did not finish the ssh handshake in %gs" % MASTER_TIMEOUT
    except OSError as exc:
        return str(exc)
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        reason = detail[-1] if detail else "ssh exited %d" % proc.returncode
        if "Permission denied" in reason:
            reason = "key not authorised in the guest (run: termox setup-guest)"
        return reason
    return None


def _run(target, script, timeout):
    if not shutil.which("ssh"):
        return None, "openssh is not installed (pkg install openssh)"
    failure = ensure_master(target)
    if failure:
        return None, failure
    try:
        proc = subprocess.run(
            ssh_command(target) + ["sh -s"],
            input=script, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "guest did not answer in %gs" % timeout
    except OSError as exc:
        return None, str(exc)
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip().splitlines()
        reason = detail[-1] if detail else "ssh exited %d" % proc.returncode
        if "Permission denied" in reason:
            reason = "key not authorised in the guest (run: termox setup-guest)"
        return None, reason
    return proc.stdout, None


# ------------------------------------------------------------------ parsing

def _sections(text):
    out, current = {}, None
    for line in text.splitlines():
        if line.startswith("@"):
            current = line[1:].strip()
            out[current] = []
        elif current:
            out[current].append(line)
    return out


def _meminfo(lines):
    vals = {}
    for line in lines:
        key, _, rest = line.partition(":")
        try:
            vals[key.strip()] = int(rest.split()[0]) * 1024
        except (IndexError, ValueError):
            continue
    total = vals.get("MemTotal", 0)
    avail = vals.get("MemAvailable", vals.get("MemFree", 0))
    swap_total = vals.get("SwapTotal", 0)
    return {
        "total": total, "available": avail, "used": total - avail,
        "percent": round((total - avail) * 100.0 / total, 1) if total else None,
        "cached": vals.get("Cached", 0),
        "swap_total": swap_total,
        "swap_used": swap_total - vals.get("SwapFree", 0),
    }


def _cpu(lines):
    out = {}
    for line in lines:
        if not line.startswith("cpu"):
            continue
        parts = line.split()
        key = "total" if parts[0] == "cpu" else parts[0]
        try:
            out[key] = [int(x) for x in parts[1:]]
        except ValueError:
            continue
    return out


def _filesystems(lines):
    out = []
    for line in lines[1:]:
        parts = line.split()
        if len(parts) < 6:
            continue
        device, mount = parts[0], parts[5]
        if device in ("tmpfs", "devtmpfs", "none", "shm", "overlay"):
            continue
        if mount.startswith(("/dev", "/sys", "/proc", "/run")):
            continue
        try:
            total = int(parts[1]) * 1024
            used = int(parts[2]) * 1024
        except ValueError:
            continue
        if not total:
            continue
        out.append({"device": device, "mount": mount, "total": total,
                    "used": used, "free": total - used,
                    "percent": round(used * 100.0 / total, 1)})
    return out


def _netdev(lines):
    out = {}
    for line in lines[2:]:
        name, _, rest = line.partition(":")
        fields = rest.split()
        if len(fields) < 9:
            continue
        name = name.strip()
        if name == "lo":
            continue
        try:
            out[name] = (int(fields[0]), int(fields[8]))
        except ValueError:
            continue
    return out


def _os_name(lines):
    values = {}
    for line in lines:
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip().strip('"')
    return values.get("PRETTY_NAME") or values.get("NAME")


def _containers(lines):
    """Split the cached blob into `docker ps` rows and `docker stats` rows."""
    listing, stats, target = [], [], "listing"
    for line in lines:
        if line.strip() == "--stats--":
            target = "stats"
            continue
        (listing if target == "listing" else stats).append(line)

    out = []
    for line in listing:
        parts = line.split("|")
        if len(parts) < 5:
            continue
        out.append({"id": parts[0], "name": parts[1], "image": parts[2],
                    "state": parts[3], "status": parts[4],
                    "cpu_percent": None, "mem_used": None, "mem_percent": None,
                    "net_io": None, "block_io": None})
    _merge_stats(out, stats)
    return out


def _percent(text):
    try:
        return round(float(text.strip().rstrip("%")), 1)
    except (AttributeError, ValueError):
        return None


UNITS = {"b": 1, "kb": 1000, "kib": 1024, "mb": 1000**2, "mib": 1024**2,
         "gb": 1000**3, "gib": 1024**3, "tb": 1000**4, "tib": 1024**4}


def _bytes(text):
    text = (text or "").strip().lower()
    number, unit = "", ""
    for char in text:
        if char.isdigit() or char == ".":
            number += char
        else:
            unit += char
    try:
        return int(float(number) * UNITS.get(unit.strip(), 1))
    except ValueError:
        return None


def _merge_stats(containers, lines):
    by_id = {c["id"]: c for c in containers}
    for line in lines:
        parts = line.split("|")
        if len(parts) < 6:
            continue
        container = by_id.get(parts[0])
        if not container:
            continue
        container["cpu_percent"] = _percent(parts[1])
        used, _, _limit = parts[2].partition("/")
        container["mem_used"] = _bytes(used)
        container["mem_percent"] = _percent(parts[3])
        container["net_io"] = parts[4].strip()
        container["block_io"] = parts[5].strip()


# ------------------------------------------------------------------ collector

class GuestLink:
    """Polls every reachable guest, keeping per-node deltas for rates."""

    def __init__(self):
        self.state = {}
        self._prev = {}

    def poll(self, nodes):
        overrides = load_targets()
        keys = set()
        for node in nodes:
            key = node["key"]
            keys.add(key)
            if node["state"] != "running":
                self.state[key] = {"ok": False, "reason": "machine is not running",
                                   "configured": False}
                self._prev.pop(key, None)
                continue
            target = target_for(node, overrides)
            if not target:
                self.state[key] = {
                    "ok": False, "configured": False,
                    "reason": "no ssh forward on this machine "
                              "(add hostfwd=tcp::PORT-:22)"}
                continue
            self.state[key] = self._collect(key, target)
        for stale in set(self.state) - keys:
            del self.state[stale]
        return self.state

    def _collect(self, key, target):
        started = time.time()
        text, error = _run(target, PROBE, SSH_TIMEOUT)
        endpoint = "%s@%s:%d" % (target["user"], target["host"], target["port"])
        if error:
            return {"ok": False, "configured": True, "endpoint": endpoint,
                    "reason": error}

        sections = _sections(text)
        now = time.time()
        cpu_now = _cpu(sections.get("stat", []))
        net_now = _netdev(sections.get("netdev", []))
        prev = self._prev.get(key)
        self._prev[key] = {"at": now, "cpu": cpu_now, "net": net_now}

        cpu = {"total": None, "cores": []}
        net = []
        if prev:
            span = now - prev["at"]
            for name, cur in sorted(cpu_now.items()):
                pct = _cpu_percent(prev["cpu"].get(name), cur)
                if name == "total":
                    cpu["total"] = pct
                elif pct is not None:
                    cpu["cores"].append({"id": int(name[3:]), "percent": pct})
            for name, (rx, tx) in sorted(net_now.items()):
                old = prev["net"].get(name)
                net.append({
                    "iface": name, "rx_bytes": rx, "tx_bytes": tx,
                    "rx_rate": max(0.0, (rx - old[0]) / span) if old and span else None,
                    "tx_rate": max(0.0, (tx - old[1]) / span) if old and span else None,
                })
        cpu["count"] = len([k for k in cpu_now if k != "total"])

        has_docker = (sections.get("dockerhas") or ["no"])[0].strip() == "yes"
        containers = _containers(sections.get("docker", [])) if has_docker else []
        try:
            docker_age = int((sections.get("dockerage") or ["-1"])[0])
        except ValueError:
            docker_age = -1

        uptime_line = (sections.get("uptime") or [""])[0].split()
        load_line = (sections.get("loadavg") or [""])[0].split()
        return {
            "ok": True,
            "configured": True,
            "endpoint": endpoint,
            "latency_ms": round((time.time() - started) * 1000),
            "hostname": (sections.get("host") or [None])[0],
            "os": _os_name(sections.get("os", [])),
            "kernel": (sections.get("kernel") or [None])[0],
            "cpu": cpu,
            "memory": _meminfo(sections.get("meminfo", [])),
            "filesystems": _filesystems(sections.get("df", [])),
            "network": net,
            "uptime": float(uptime_line[0]) if uptime_line else None,
            "load": ([float(x) for x in load_line[:3]]
                     if len(load_line) >= 3 else None),
            "docker": {
                "installed": has_docker,
                "containers": containers,
                # -1 means the cache has not been written yet; the first
                # refresh is in flight and lands on a later poll
                "age": docker_age if has_docker else None,
                "refresh": DOCKER_REFRESH,
            },
        }


def _cpu_percent(prev, cur):
    if not prev or not cur:
        return None
    idle_prev = prev[3] + (prev[4] if len(prev) > 4 else 0)
    idle_cur = cur[3] + (cur[4] if len(cur) > 4 else 0)
    delta = sum(cur) - sum(prev)
    if delta <= 0:
        return None
    return round(max(0.0, min(100.0, (delta - (idle_cur - idle_prev)) * 100.0 / delta)), 1)
