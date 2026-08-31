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
DNS_WEB_PORT = int(os.environ.get("TERMOX_DNS_WEB_PORT", "3000"))
DNS_PORT = int(os.environ.get("TERMOX_DNS_PORT", "5300"))
AUTOCLAIM_PORT = int(os.environ.get("TERMOX_AUTOCLAIM_PORT", "8787"))

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
    {
        "id": "dns",
        "name": "DNS · AdGuard Home",
        "exe": "AdGuardHome",
        "port": DNS_WEB_PORT,
        "endpoint": "http://127.0.0.1:%d" % DNS_WEB_PORT,
        "kind": "AdGuard Home, native",
        "uses_gpu": False,
        "probe_port": DNS_PORT,
        # AdGuard takes its listen port from the config file, so there is no
        # --port on the command line to match against
        "match_port": False,
    },
    {
        "id": "autoclaim",
        "name": "AutoClaim",
        "exe": "node",
        "port": AUTOCLAIM_PORT,
        "endpoint": "http://127.0.0.1:%d" % AUTOCLAIM_PORT,
        "kind": "Node, native",
        "uses_gpu": False,
        # Its port comes from the environment, not the command line, so there is
        # no --port to match. `node` alone is far too generic a name to identify
        # a service by, so match the script it was given instead.
        "match_port": False,
        "argv_match": "server/index.js",
    },
]


def find_process(exe, port=None, argv_match=None):
    """The pid whose argv[0] basename matches, and whose --port is `port`.

    Matching argv[0] rather than searching the whole command line matters: a
    shell that merely mentions the name must not be mistaken for the service.
    The port check is what separates two instances of the same binary.

    `argv_match` is the fallback for interpreters, where argv[0] names the
    runtime and not the service: every node process is called `node`, so the
    script path is the only thing that tells one from another. It is matched
    against argv[1:] so it can never collide with the executable itself.
    """
    for pid in vms._pids():
        argv = vms._argv(pid)
        if not argv or os.path.basename(argv[0]) != exe:
            continue
        if argv_match and not any(argv_match in arg for arg in argv[1:]):
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
        self._counter_prev = {}

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

        pid, argv = find_process(
            spec["exe"],
            spec.get("port") if spec.get("match_port", True) else None,
            spec.get("argv_match"))
        if pid:
            entry["state"] = "running"
            entry["runtime"] = self._process(spec["id"], pid, interval)
            entry["model"] = _model_name(argv)

        if spec["id"] == "autoclaim":
            return _render_autoclaim(entry, spec)

        if spec["id"] == "dns":
            # AdGuard has no /health; its liveness is whether the resolver
            # port actually answers, which _render_dns establishes
            return _render_dns(entry, spec)

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
            recent = self._recent_rates(spec["id"], predicted, seconds,
                                        prompt_tokens, prompt_seconds)
            entry["metrics"] = {
                # llama.cpp's own per-second gauges are reset when /metrics is
                # scraped, so they read 0 almost always. These come from the
                # monotonic counters instead: the tokens and the seconds that
                # the last completed request added, divided.
                "tokens_per_second": recent["tokens"],
                "prompt_per_second": recent["prompt"],
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
            "binary": vms._exe(pid),
            "directory": vms._cwd(pid),
            "cpu_percent": percent,
            "rss": sample["rss"],
            "threads": sample["threads"],
            "uptime": vms.proc_uptime_seconds(sample["starttime"]),
            "cores": _affinity(pid),
            "nice": _nice(pid),
        }


    def _recent_rates(self, key, predicted, seconds, prompt_tokens, prompt_seconds):
        """Throughput of whatever finished since the last poll.

        llama.cpp only advances these counters when a request completes, so a
        delta is exactly one or more finished requests: tokens added over
        seconds added is their true rate. While a request is still running
        nothing moves, and the previous figure is carried forward rather than
        collapsing to zero.
        """
        prev = self._counter_prev.get(key)
        self._counter_prev[key] = {
            "predicted": predicted, "seconds": seconds,
            "prompt_tokens": prompt_tokens, "prompt_seconds": prompt_seconds,
            "tokens_rate": None, "prompt_rate": None,
        }
        if not prev:
            return {"tokens": None, "prompt": None}

        rates = {}
        for name, now_tokens, now_secs, was_tokens, was_secs in (
            ("tokens", predicted, seconds, prev["predicted"], prev["seconds"]),
            ("prompt", prompt_tokens, prompt_seconds,
             prev["prompt_tokens"], prev["prompt_seconds"]),
        ):
            dt, ds = now_tokens - was_tokens, now_secs - was_secs
            if dt > 0 and ds > 0:
                rates[name] = round(dt / ds, 2)
            else:
                rates[name] = prev.get(name + "_rate")     # nothing finished
        self._counter_prev[key]["tokens_rate"] = rates["tokens"]
        self._counter_prev[key]["prompt_rate"] = rates["prompt"]
        return rates


def _render_dns(entry, spec):
    """AdGuard Home exposes /control/*, not Prometheus.

    Everything under /control needs the web password once one is configured,
    so query counts only appear if credentials are supplied. The parts that
    matter for "is my DNS up" -- the process, and whether the resolver port
    actually answers -- need no authentication at all.
    """
    entry["dns_port"] = spec.get("probe_port")
    entry["dns_open"] = (vms.probe(spec["probe_port"])
                         if spec.get("probe_port") else None)
    if entry["state"] == "running" and not entry["dns_open"]:
        entry["state"] = "starting"          # process up, resolver not yet bound

    status = _fetch(spec["endpoint"] + "/control/status")
    if status:
        try:
            data = json.loads(status)
            entry["dns_version"] = data.get("version")
            entry["protection"] = data.get("protection_enabled")
            entry["dns_running"] = data.get("running")
        except ValueError:
            pass

    stats = _fetch(spec["endpoint"] + "/control/stats")
    if stats:
        try:
            data = json.loads(stats)
            queries = data.get("num_dns_queries") or 0
            blocked = ((data.get("num_blocked_filtering") or 0) +
                       (data.get("num_replaced_safebrowsing") or 0) +
                       (data.get("num_replaced_parental") or 0))
            entry["dns_stats"] = {
                "queries": queries,
                "blocked": blocked,
                "blocked_percent": (round(blocked * 100.0 / queries, 1)
                                    if queries else None),
                "avg_ms": round((data.get("avg_processing_time") or 0) * 1000, 2),
            }
        except ValueError:
            pass
    else:
        entry["dns_stats"] = None
    return entry


def _render_autoclaim(entry, spec):
    """AutoClaim answers /api/status and nothing else useful.

    It is not a model server, so the llama.cpp path -- /health, /props,
    /v1/models, Prometheus -- would 404 four times per poll and then report the
    service as "starting" forever. /api/status is both its liveness check and
    the only interesting thing it has to say.

    What matters for a glance is not that the process is up but whether it has
    actually settled today: the scheduler ticks every five minutes and quietly
    does nothing once every profile is done, so "claimed 1 of 3" is the number
    that tells you something is wrong, not the uptime.
    """
    status = _fetch(spec["endpoint"] + "/api/status")
    if status is None:
        if entry["state"] == "running":
            entry["state"] = "starting"      # process up, not yet serving
        return entry
    entry["state"] = "running"

    try:
        data = json.loads(status)
    except ValueError:
        return entry

    scheduler = data.get("scheduler") or {}
    profiles = data.get("profiles") or []
    entry["claim_day"] = scheduler.get("today")
    entry["claim_timezone"] = scheduler.get("timezone")
    entry["claim_last_tick"] = scheduler.get("lastTickAt")

    # `status` is an object, not a string. Its `settled` flag is the one that
    # matters: it is true only when the account needed nothing further today,
    # which is not the same as `done` -- an account with no game linked is done
    # (the scheduler has stopped trying) but not settled (it earned nothing).
    # A profile with auto-claim off is not counted against anything, because
    # nobody asked it to claim.
    wanted = [p for p in profiles if p.get("autoClaim")]
    settled = [p for p in wanted if (p.get("status") or {}).get("settled")]
    outcomes = {}
    for p in wanted:
        today = ((p.get("status") or {}).get("todayEntry") or {})
        if today.get("outcome"):
            outcomes[today["outcome"]] = outcomes.get(today["outcome"], 0) + 1
    entry["claim_profiles"] = {
        "total": len(profiles),
        "auto": len(wanted),
        "settled": len(settled),
        "expired": len([p for p in wanted if not p.get("authOk")]),
        "outcomes": outcomes,
    }
    return entry


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
