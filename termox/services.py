"""Long-running services on the phone that are not virtual machines.

Right now that means the model server, which is worth watching for the same
reason a VM is: it holds a lot of memory, it competes for the same cores, and
when it is busy everything else on the phone feels it. Process facts come from
/proc; throughput comes from llama-server's own Prometheus endpoint, which is
the only place the token rates actually exist.
"""

import json
import os
import time
import urllib.error
import urllib.request

from . import vms

CPU_PORT = int(os.environ.get("TERMOX_LLM_CPU_PORT", "8081"))
GPU_PORT = int(os.environ.get("TERMOX_LLM_GPU_PORT", "8082"))

# Two model servers can run side by side: one on the CPU, one on the Adreno.
# They are told apart by the port on their command line, because both are the
# same executable.
SERVICES = [
    {
        "id": "llm-cpu",
        "name": "Model server · CPU",
        "exe": "llama-server",
        "port": CPU_PORT,
        "endpoint": "http://127.0.0.1:%d" % CPU_PORT,
        "kind": "llama.cpp on the processor",
        "uses_gpu": False,
    },
    {
        "id": "llm-gpu",
        "name": "Model server · GPU",
        "exe": "llama-server",
        "port": GPU_PORT,
        "endpoint": "http://127.0.0.1:%d" % GPU_PORT,
        "kind": "llama.cpp on the Adreno",
        "uses_gpu": True,
    },
]


def find_process(exe, port=None):
    """The pid whose argv[0] basename matches, and whose --port is `port`.

    Matching argv[0] rather than searching the whole command line matters: a
    shell that merely mentions the name must not be mistaken for the service.
    The port check is what separates two instances of the same binary.
    """
    for pid in vms._pids():
        argv = vms._argv(pid)
        if not argv or os.path.basename(argv[0]) != exe:
            continue
        if port is None:
            return pid, argv
        for i, arg in enumerate(argv):
            if arg == "--port" and i + 1 < len(argv) and argv[i + 1] == str(port):
                return pid, argv
    return None, None


def _fetch(url, timeout=2.5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def parse_prometheus(text):
    """Flatten `name{labels} value` lines into {name: float}."""
    out = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, _, value = line.partition(" ")
        name = name.split("{")[0]
        try:
            out[name] = float(value)
        except ValueError:
            continue
    return out


class Services:
    """Polls each service, keeping per-pid deltas for CPU percent."""

    def __init__(self):
        self._cpu_prev = {}

    def poll(self, interval):
        out = []
        for spec in SERVICES:
            out.append(self._render(spec, interval))
        return out

    def _render(self, spec, interval):
        # each service keeps its own cpu-delta slot, keyed by id
        entry = {
            "id": spec["id"],
            "name": spec["name"],
            "kind": spec["kind"],
            "endpoint": spec["endpoint"],
            "uses_gpu": spec.get("uses_gpu", False),
            "state": "stopped",
            "runtime": None,
            "model": None,
            "served_model": None,
            "context": None,
            "metrics": None,
        }

        pid, argv = find_process(spec["exe"], spec.get("port"))
        if pid:
            entry["state"] = "running"
            entry["runtime"] = self._process(spec["id"], pid, interval)
            entry["model"] = _model_name(argv)

        health = _fetch(spec["endpoint"] + "/health")
        if health is None:
            if entry["state"] == "running":
                entry["state"] = "starting"      # process up, not yet serving
            return entry
        entry["state"] = "running"

        props = _fetch(spec["endpoint"] + "/props")
        if props:
            try:
                data = json.loads(props)
                entry["context"] = data.get("default_generation_settings", {}) \
                                       .get("n_ctx")
                entry["model"] = data.get("model_path") or entry["model"]
            except ValueError:
                pass

        served = _fetch(spec["endpoint"] + "/v1/models")
        if served:
            try:
                listing = json.loads(served)
                items = listing.get("data") or listing.get("models") or []
                if items:
                    entry["served_model"] = items[0].get("id") or items[0].get("name")
            except ValueError:
                pass

        metrics = parse_prometheus(_fetch(spec["endpoint"] + "/metrics"))
        if metrics:
            predicted = metrics.get("llamacpp:tokens_predicted_total", 0.0)
            seconds = metrics.get("llamacpp:tokens_predicted_seconds_total", 0.0)
            prompt_tokens = metrics.get("llamacpp:prompt_tokens_total", 0.0)
            prompt_seconds = metrics.get("llamacpp:prompt_seconds_total", 0.0)
            entry["metrics"] = {
                "tokens_per_second": metrics.get("llamacpp:predicted_tokens_seconds"),
                "prompt_per_second": metrics.get("llamacpp:prompt_tokens_seconds"),
                "tokens_total": predicted,
                "prompt_total": metrics.get("llamacpp:prompt_tokens_total"),
                "prompt_cached": metrics.get("llamacpp:prompt_tokens_cached_total"),
                "busy_seconds": seconds,
                "processing": metrics.get("llamacpp:requests_processing"),
                "deferred": metrics.get("llamacpp:requests_deferred"),
                "kv_cache": metrics.get("llamacpp:kv_cache_usage_ratio"),
                # llama.cpp RESETS its per-second gauges when /metrics is
                # scraped, so polling every few seconds consumes the value and
                # the next read sees zero. The counters underneath are
                # monotonic and trustworthy, so the rate shown is derived from
                # those instead of from the gauges.
                "average_tps": (predicted / seconds) if seconds else None,
                "average_prompt_tps": ((prompt_tokens / prompt_seconds)
                                       if prompt_seconds else None),
            }
        return entry

    def _process(self, key, pid, interval):
        sample = vms.proc_sample(pid)
        if not sample:
            return None
        prev = self._cpu_prev.get(key)
        percent = None
        if prev and prev["pid"] == pid and interval > 0:
            jiffies = ((sample["utime"] + sample["stime"]) -
                       (prev["utime"] + prev["stime"]))
            if jiffies >= 0:
                percent = round(jiffies * 100.0 / (vms.CLK_TCK * interval), 1)
        self._cpu_prev[key] = {"pid": pid, "utime": sample["utime"],
                               "stime": sample["stime"]}
        return {
            "pid": pid,
            "cpu_percent": percent,
            "rss": sample["rss"],
            "threads": sample["threads"],
            "uptime": vms.proc_uptime_seconds(sample["starttime"]),
            "cores": _affinity(pid),
            "nice": _nice(pid),
        }


def _model_name(argv):
    for i, arg in enumerate(argv or []):
        if arg in ("-m", "--model") and i + 1 < len(argv):
            return os.path.basename(argv[i + 1])
    return None


def _affinity(pid):
    try:
        return sorted(os.sched_getaffinity(pid))
    except (OSError, AttributeError):
        return None


def _nice(pid):
    try:
        return os.getpriority(os.PRIO_PROCESS, pid)
    except (OSError, AttributeError):
        return None
