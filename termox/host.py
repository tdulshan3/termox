"""Readers for the Termux host itself (the Android device).

Everything here is unprivileged: /proc, /sys, statvfs, getprop and the
optional termux-api helpers. Any reading that needs root degrades to a
null with a `reason` rather than a fake zero, so the UI can say why.
"""

import json
import os
import re
import socket
import subprocess
import time

CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
CPU_BASE = "/sys/devices/system/cpu"

# Samsung's Android build denies /proc/stat, /proc/uptime, /proc/loadavg and
# /proc/net/dev to ordinary apps -- Knox tightens the SELinux policy well past
# stock. Everything below therefore has a sysfs path or a derivation to fall
# back to, and where there is no way through it says so instead of showing a
# zero that looks like an idle system.

def readable(path):
    try:
        with open(path):
            return True
    except OSError:
        return False


PROC_STAT_OK = readable("/proc/stat")
PROC_NET_OK = readable("/proc/net/dev")
PROC_LOAD_OK = readable("/proc/loadavg")


def read_text(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return None


def read_int(path):
    raw = read_text(path)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def run(cmd, timeout=8):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


# ------------------------------------------------------------------ identity

_getprop_cache = {}


def getprop(key):
    if key not in _getprop_cache:
        _getprop_cache[key] = run(["getprop", key], timeout=4) or None
    return _getprop_cache[key]


def lan_address():
    """Best-effort primary IPv4, found by asking the routing table which
    source address it would use. No packet is actually sent."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))  # TEST-NET-1, never routed
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def identity():
    uname = os.uname()
    model = getprop("ro.product.model")
    vendor = getprop("ro.product.manufacturer")
    device = " ".join(x for x in (vendor, model) if x) or None
    return {
        "hostname": socket.gethostname(),
        "device": device,
        "android": getprop("ro.build.version.release"),
        "sdk": getprop("ro.build.version.sdk"),
        "soc": getprop("ro.soc.model") or getprop("ro.board.platform"),
        "kernel": "%s %s" % (uname.sysname, uname.release),
        "arch": uname.machine,
        "address": lan_address(),
    }


# ------------------------------------------------------------------ cpu

def cpu_times():
    """{'total': [jiffies...], 'cpu0': [...]} straight out of /proc/stat."""
    out = {}
    try:
        with open("/proc/stat") as fh:
            for line in fh:
                if not line.startswith("cpu"):
                    break
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
    delta = sum(cur) - sum(prev)
    if delta <= 0:
        return None
    busy = delta - (idle_cur - idle_prev)
    return max(0.0, min(100.0, busy * 100.0 / delta))


def core_ids():
    try:
        return sorted(int(d[3:]) for d in os.listdir(CPU_BASE)
                      if re.fullmatch(r"cpu\d+", d))
    except OSError:
        return []


def core_online(index):
    """cpu0 usually has no `online` node because it cannot be taken offline."""
    raw = read_text("%s/cpu%d/online" % (CPU_BASE, index))
    return True if raw is None else raw.strip() == "1"


def idle_times():
    """Microseconds each core has spent in any idle state, since boot.

    This is the way to per-core utilisation when /proc/stat is off limits:
    the counters live in sysfs, which the same policy leaves alone.
    """
    out = {}
    for index in core_ids():
        if not core_online(index):
            out[index] = None
            continue
        total, found = 0, False
        base = "%s/cpu%d/cpuidle" % (CPU_BASE, index)
        try:
            states = os.listdir(base)
        except OSError:
            out[index] = None
            continue
        for state in states:
            if not state.startswith("state"):
                continue
            value = read_int("%s/%s/time" % (base, state))
            if value is not None:
                total += value
                found = True
        out[index] = total if found else None
    return out


CPUIDLE_OK = any(v is not None for v in idle_times().values()) if not PROC_STAT_OK else False


def idle_percent(prev, cur, span_seconds):
    """Busy percent per core between two idle snapshots."""
    out = {}
    span_us = span_seconds * 1_000_000.0
    if span_us <= 0:
        return out
    for index, current in cur.items():
        previous = prev.get(index)
        if current is None or previous is None:
            out[index] = None
            continue
        delta = current - previous
        if delta < 0:                       # core was offlined and came back
            out[index] = None
            continue
        out[index] = round(max(0.0, min(100.0, 100.0 * (1.0 - delta / span_us))), 1)
    return out


_topology_cache = None


def topology():
    """Group cores into clusters by max frequency.

    On a big.LITTLE SoC this falls out as 2 or 3 clusters with no
    device-specific table. Unreadable cpufreq nodes collapse to one group.
    """
    global _topology_cache
    if _topology_cache is not None:      # maximum clocks are fixed silicon
        return _topology_cache

    cores = []
    try:
        names = sorted(
            (d for d in os.listdir(CPU_BASE) if re.fullmatch(r"cpu\d+", d)),
            key=lambda d: int(d[3:]),
        )
    except OSError:
        names = []
    for name in names:
        cores.append({
            "id": int(name[3:]),
            "max_khz": read_int("%s/%s/cpufreq/cpuinfo_max_freq" % (CPU_BASE, name)),
        })

    groups = {}
    for core in cores:
        groups.setdefault(core["max_khz"], []).append(core["id"])

    tiers = sorted((k for k in groups if k), reverse=True)
    if len(tiers) == 3:
        labels = dict(zip(tiers, ("Prime", "Performance", "Efficiency")))
    elif len(tiers) == 2:
        labels = dict(zip(tiers, ("Performance", "Efficiency")))
    else:
        labels = {k: "Cores" for k in tiers}

    clusters = [{
        "label": labels.get(khz, "Cluster"),
        "max_mhz": round(khz / 1000),
        "cores": sorted(groups[khz]),
    } for khz in tiers]
    if None in groups:
        clusters.append({"label": "Cores", "max_mhz": None,
                         "cores": sorted(groups[None])})
    _topology_cache = (clusters, len(cores) or os.cpu_count() or 0)
    return _topology_cache


def core_frequencies(count):
    freqs = {}
    for i in range(count):
        khz = read_int("%s/cpu%d/cpufreq/scaling_cur_freq" % (CPU_BASE, i))
        if khz:
            freqs[i] = round(khz / 1000)
    return freqs


def governor():
    return read_text("%s/cpu0/cpufreq/scaling_governor" % CPU_BASE)


# ------------------------------------------------------------------ memory

def memory():
    vals = {}
    try:
        with open("/proc/meminfo") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                try:
                    vals[key] = int(rest.split()[0]) * 1024
                except (IndexError, ValueError):
                    continue
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
        "cached": vals.get("Cached", 0),
        "buffers": vals.get("Buffers", 0),
        "swap_total": swap_total,
        "swap_used": swap_total - vals.get("SwapFree", 0),
        "swap_percent": (round((swap_total - vals.get("SwapFree", 0)) * 100.0 / swap_total, 1)
                         if swap_total else None),
    }


# ------------------------------------------------------------------ storage

def storage():
    """Volumes this process can actually stat. Android hides most mounts."""
    home = os.environ.get("HOME") or os.path.expanduser("~")
    prefix = os.environ.get("PREFIX")
    candidates = [
        ("Internal storage", "/data"),
        ("Termux home", home),
        ("Termux prefix", prefix),
        ("Shared storage", "/storage/emulated/0"),
        ("Root", "/"),
    ]
    out, seen = [], set()
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
        # Android's / is a full, read-only system image: always ~100% and
        # never actionable, so it would only ever read as a red alarm.
        if hasattr(os, "ST_RDONLY") and st.f_flag & os.ST_RDONLY:
            continue
        key = (total, st.f_blocks, st.f_files)
        if key in seen:
            continue
        seen.add(key)
        free = st.f_bavail * st.f_frsize
        used = total - (st.f_bfree * st.f_frsize)
        out.append({
            "label": label, "path": path, "total": total, "used": used,
            "free": free, "percent": round(used * 100.0 / total, 1),
        })
    return out


# ------------------------------------------------------------------ network

def net_counters():
    """{iface: (rx_bytes, tx_bytes)}, from /proc/net/dev or sysfs.

    Both are commonly denied on Samsung builds; an empty result then means
    "not allowed to look", which the payload states outright.
    """
    if not PROC_NET_OK:
        return _net_counters_sysfs()
    out = {}
    try:
        with open("/proc/net/dev") as fh:
            for line in fh.read().splitlines()[2:]:
                name, _, rest = line.partition(":")
                fields = rest.split()
                if len(fields) < 9:
                    continue
                name = name.strip()
                if name == "lo":
                    continue
                out[name] = (int(fields[0]), int(fields[8]))
    except OSError:
        pass
    return out


def _net_counters_sysfs():
    out = {}
    base = "/sys/class/net"
    try:
        names = os.listdir(base)
    except OSError:
        return out
    for name in names:
        if name == "lo":
            continue
        rx = read_int("%s/%s/statistics/rx_bytes" % (base, name))
        tx = read_int("%s/%s/statistics/tx_bytes" % (base, name))
        if rx is not None and tx is not None:
            out[name] = (rx, tx)
    return out


def network_restriction():
    if PROC_NET_OK or _net_counters_sysfs():
        return None
    return "Android denies this app both /proc/net/dev and /sys/class/net"


def load_restriction():
    return None if PROC_LOAD_OK else "Android denies this app /proc/loadavg"


def cpu_source():
    if PROC_STAT_OK:
        return "procstat"
    if CPUIDLE_OK:
        return "cpuidle"
    return "none"


def net_rates(prev, cur, seconds):
    """Per-interface byte rates, dropping interfaces with no traffic ever."""
    rows = []
    for name, (rx, tx) in sorted(cur.items()):
        old = prev.get(name)
        rx_rate = tx_rate = None
        if old and seconds > 0:
            rx_rate = max(0.0, (rx - old[0]) / seconds)
            tx_rate = max(0.0, (tx - old[1]) / seconds)
        if not rx and not tx:
            continue
        rows.append({"iface": name, "rx_bytes": rx, "tx_bytes": tx,
                     "rx_rate": rx_rate, "tx_rate": tx_rate})
    rows.sort(key=lambda r: -(r["rx_bytes"] + r["tx_bytes"]))
    return rows


# ------------------------------------------------------------------ gpu / thermal / battery

KGSL = "/sys/class/kgsl/kgsl-3d0"
_gpu_freq_table = None


def gpu():
    """Adreno counters.

    `gpubusy` and `gpuclk` are root-only on this build, but the driver also
    publishes `gpu_busy_percentage` and `clock_mhz`, which are not -- so real
    utilisation is available without root after all. Where a node cannot be
    read the field stays null and `reason` says why, rather than reporting a
    zero that reads as an idle GPU.
    """
    global _gpu_freq_table
    if not os.path.isdir(KGSL):
        return {"available": False, "reason": "no kgsl node on this device"}

    busy_raw = read_text("%s/gpu_busy_percentage" % KGSL)
    percent = None
    if busy_raw:
        try:
            percent = float(busy_raw.split()[0])
        except (IndexError, ValueError):
            percent = None

    clock = read_int("%s/clock_mhz" % KGSL)

    if _gpu_freq_table is None:
        table = read_text("%s/freq_table_mhz" % KGSL)
        try:
            _gpu_freq_table = sorted((int(x) for x in (table or "").split()), reverse=True)
        except ValueError:
            _gpu_freq_table = []

    max_mhz = _gpu_freq_table[0] if _gpu_freq_table else None
    if percent is None and clock is None:
        return {"available": False,
                "reason": "kgsl present but its counters need root"}
    return {
        "available": True,
        "model": read_text("%s/gpu_model" % KGSL),
        "percent": round(percent, 1) if percent is not None else None,
        "clock_mhz": clock,
        "max_clock_mhz": max_mhz,
        "clock_percent": (round(clock * 100.0 / max_mhz, 1)
                          if clock and max_mhz else None),
        "freq_table": _gpu_freq_table,
    }


THERMAL_KINDS = ("cpu", "gpu", "batt", "skin", "soc", "quiet", "therm", "pkg", "core")


_thermal_zones = None


def thermals(limit=8):
    """Only the temperatures are re-read; which zones exist, and what they
    are called, is fixed for the life of the boot. Scanning every zone each
    second was a measurable slice of this process's own CPU."""
    global _thermal_zones
    base = "/sys/class/thermal"
    if _thermal_zones is None:
        _thermal_zones = []
        try:
            for zone in sorted(os.listdir(base)):
                if not zone.startswith("thermal_zone"):
                    continue
                kind = (read_text("%s/%s/type" % (base, zone)) or "").lower()
                if any(k in kind for k in THERMAL_KINDS):
                    _thermal_zones.append((zone, kind))
        except OSError:
            _thermal_zones = []

    out = []
    for zone, kind in _thermal_zones:
        raw = read_int("%s/%s/temp" % (base, zone))
        if raw is None:
            continue
        celsius = raw / 1000.0 if abs(raw) > 1000 else float(raw)
        if not -40 < celsius < 150:
            continue
        out.append({"zone": kind, "celsius": round(celsius, 1)})
    out.sort(key=lambda z: -z["celsius"])
    return out[:limit]


# `pkg install termux-api` only supplies the shell wrappers. Without the
# Termux:API companion app they run, succeed, and print nothing at all --
# which is the state worth naming, because installing the package looks like
# it should have been enough.
API_APP_MISSING = ("the Termux:API app is not installed - the termux-api "
                   "package alone is not enough")


def battery():
    """Needs `pkg install termux-api` plus the Termux:API app."""
    if not _has("termux-battery-status"):
        return {"available": False, "reason": "termux-api package not installed"}
    raw = run(["termux-battery-status"], timeout=12)
    if raw is None:
        # The wrapper blocks waiting for a companion app that never answers,
        # which is what a missing Termux:API install looks like from here.
        return {"available": False, "reason": API_APP_MISSING}
    if not raw.strip():
        return {"available": False, "reason": API_APP_MISSING}
    try:
        data = json.loads(raw)
    except ValueError:
        return {"available": False, "reason": "unreadable termux-api response"}
    temp = data.get("temperature")
    return {
        "available": True,
        "percentage": data.get("percentage"),
        "status": data.get("status"),
        "plugged": data.get("plugged"),
        "health": data.get("health"),
        "current_ma": (data.get("current") // 1000
                       if isinstance(data.get("current"), int) else None),
        "celsius": round(temp, 1) if isinstance(temp, (int, float)) else None,
    }


def _has(name):
    for directory in (os.environ.get("PATH") or "").split(os.pathsep):
        if directory and os.path.exists(os.path.join(directory, name)):
            return True
    return False


# ------------------------------------------------------------------ misc

def _own_start_jiffies():
    """Jiffies between boot and the moment this process started."""
    try:
        with open("/proc/self/stat") as fh:
            raw = fh.read()
        return int(raw[raw.rfind(")") + 2:].split()[19])
    except (OSError, ValueError, IndexError):
        return None


_BOOT_EPOCH = None
_start_jiffies = _own_start_jiffies()
if _start_jiffies is not None:
    _BOOT_EPOCH = time.time() - _start_jiffies / float(CLK_TCK)


def uptime():
    """/proc/uptime when allowed; otherwise derived from our own start.

    /proc/self is always readable, and field 22 of its stat line counts
    jiffies from boot to when we launched -- which pins the boot instant.
    """
    try:
        with open("/proc/uptime") as fh:
            return float(fh.read().split()[0])
    except (OSError, ValueError, IndexError):
        pass
    if _BOOT_EPOCH is None:
        return None
    return time.time() - _BOOT_EPOCH


def loadavg():
    if not PROC_LOAD_OK:
        return None
    try:
        with open("/proc/loadavg") as fh:
            parts = fh.read().split()
        return {"one": float(parts[0]), "five": float(parts[1]),
                "fifteen": float(parts[2]), "procs": parts[3]}
    except (OSError, ValueError, IndexError):
        return None


def now():
    return time.time()
