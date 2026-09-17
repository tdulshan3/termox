"""Starting and stopping the things this dashboard watches.

Every managed thing is a tmux session running a launcher script, so starting
is `tmux new-session` and stopping is a signal to the process plus killing the
session. What makes this worth a module is the waiting: a model server takes
half a minute to load weights, and a VM takes longer, so an action is a *job*
with a state and a running commentary rather than a request that blocks.

Jobs live in memory. Restarting the dashboard forgets history, which is the
right trade for a panel that is only ever a browser tab.
"""

import os
import re
import signal
import subprocess
import threading
import time
import uuid

from . import vms

GRACE_SECONDS = 12.0          # how long a process gets to exit politely
START_TIMEOUT = 150.0         # weights and guests are slow; be patient
STOP_TIMEOUT = 90.0

# Managed services: the tmux session, the launcher, and how to recognise the
# process and know it is ready.
SERVICES = {
    "llm-cpu": {
        "session": "llm", "command": "~/llm.sh",
        "exe": "llama-server", "match": "8081", "probe": 8081,
        "probe_kind": "health", "waiting": "loading the model",
        "ready": "the model is loaded and answering",
    },
    "llm-gpu": {
        "session": "llmgpu", "command": "~/llm-gpu.sh",
        "exe": "llama-server", "match": "8082", "probe": 8082,
        "probe_kind": "health", "waiting": "loading the model",
        "ready": "the model is loaded and answering",
    },
    "dns": {
        "session": "adguard", "command": "~/adguard.sh",
        "exe": "AdGuardHome", "match": None, "probe": 5300,
        "ready": "the resolver is answering queries",
    },
    "autoclaim": {
        "session": "autoclaim", "command": "~/autoclaim.sh",
        # `node` names the runtime, not the service, so the script path is what
        # identifies it -- see find_process in services.py.
        "exe": "node", "match": "server/index.js", "probe": 8787,
        "ready": "the scheduler is up and the API is answering",
    },
    "immich": {
        "session": "immich", "command": "~/immich.sh",
        # Immich sets its own process title, so /proc shows `immich`, not
        # `node` -- see services.py. Stopping it SIGTERMs the parent; the API
        # child it forked goes with the tmux session, which is killed last.
        "exe": "immich", "match": None, "probe": 2283,
        "waiting": "bringing up the database, migrating, starting the workers",
        "ready": "the API is answering",
    },
}

LAUNCHERS_PATH = os.path.join(vms.TERMOX_HOME, "launchers.json")

# The CPU model server runs one model at a time. llm.sh lists the choices in a
# case statement, one `  <key>) FILE=<gguf> ...` line each, and llm-use reads
# the same lines, so a model added there shows up in both. The choice itself
# lives in ~/.llm-model, which llm.sh reads every time it starts.
LLM_SCRIPT = os.path.expanduser(SERVICES["llm-cpu"]["command"])
LLM_CHOICE = os.path.expanduser("~/.llm-model")
MODELS_DIR = os.path.expanduser("~/models")
_CHOICE_LINE = re.compile(r"^  ([a-z0-9.]+)\) FILE=(\S+)")
_DEFAULT_LINE = re.compile(r"^MODEL=\$\{MODEL:-([a-z0-9.]+)\}")


# ------------------------------------------------------------------ helpers

def _tmux(*args, timeout=20):
    try:
        return subprocess.run(("tmux",) + args, capture_output=True,
                              text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None


def _exact(session):
    """A tmux target that matches `session` and nothing else. A bare name with
    no exact match falls back to a prefix match, so killing a session that
    has already ended with its process -- `llm` -- would kill `llmgpu`."""
    return "=" + session


def _find(exe, match=None):
    """pid of a process whose argv[0] basename is `exe`, optionally requiring
    `match` somewhere in its arguments (that is how two llama-servers are told
    apart)."""
    for pid in vms._pids():
        argv = vms._argv(pid)
        if not argv or os.path.basename(argv[0]) != exe:
            continue
        if match and match not in " ".join(argv[1:]):
            continue
        return pid
    return None


def banner_open(port, host="127.0.0.1", timeout=3.0):
    """True only once something answers with a greeting.

    A plain TCP connect is useless for a VM: QEMU accepts on its forwarded
    port the moment it starts, long before the guest has booted, so a connect
    would report "ready" in a second. Waiting for sshd's banner proves the
    guest itself is up.
    """
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        if sock.connect_ex((host, port)) != 0:
            return False
        return bool(sock.recv(64))
    except OSError:
        return False
    finally:
        sock.close()


def health_ok(port, host="127.0.0.1", timeout=2.0):
    """True only once a model is loaded.

    A port probe is useless for llama-server too: it opens its port before
    reading the weights and answers /health with 503 until they are in, so a
    connect said "ready" while a 4B model still had seconds of loading to go.
    """
    import http.client
    import urllib.request
    try:
        with urllib.request.urlopen("http://%s:%d/health" % (host, port),
                                    timeout=timeout) as response:
            return response.status == 200
    except (OSError, ValueError, http.client.HTTPException):
        return False                       # refused, 503, or not HTTP at all


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _why_not(path):
    """The last meaningful line the launcher printed, if any."""
    try:
        with open(path) as fh:
            lines = [l.strip() for l in fh.read().splitlines() if l.strip()]
    except OSError:
        return None
    if not lines:
        return None
    tail = lines[-1]
    return tail[:160] if len(tail) > 8 else " ".join(lines[-2:])[:160]


def node_launcher(node):
    """How to start a machine again.

    Read from launchers.json when present, otherwise guessed from the
    directory qemu was started in, which is where vm.sh conventionally lives.
    """
    import json
    try:
        with open(LAUNCHERS_PATH) as fh:
            configured = json.load(fh)
    except (OSError, ValueError):
        configured = {}
    entry = configured.get(node["key"]) or configured.get(node["id"])
    if entry:
        return entry.get("session", node["id"]), entry.get("command")

    cwd = (node.get("spec") or {}).get("cwd")
    if cwd:
        candidate = os.path.join(cwd, "vm.sh")
        if os.path.exists(candidate):
            return node["id"], candidate
    return node["id"], None


def llm_models():
    """The CPU server's models and which one is picked, or None without llm.sh.

    {"choices": [{"key", "file", "present", "size"}...], "selected": key}
    """
    try:
        with open(LLM_SCRIPT) as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    choices, default = [], None
    for line in lines:
        found = _CHOICE_LINE.match(line)
        if found:
            try:
                size = os.path.getsize(os.path.join(MODELS_DIR, found.group(2)))
            except OSError:
                size = None
            choices.append({"key": found.group(1), "file": found.group(2),
                            "present": size is not None, "size": size})
            continue
        found = _DEFAULT_LINE.match(line)
        if found:
            default = found.group(1)
    if not choices:
        return None
    try:
        with open(LLM_CHOICE) as fh:
            selected = fh.read().strip() or default
    except OSError:
        selected = default
    return {"choices": choices, "selected": selected}


def model_problem(key):
    """Why `key` cannot be switched to, or None when it can."""
    models = llm_models()
    if not models:
        return "no model list: %s is missing or lists none" % LLM_SCRIPT
    choice = next((c for c in models["choices"] if c["key"] == key), None)
    if not choice:
        return "no model called %r; llm.sh lists %s" % (
            key, ", ".join(c["key"] for c in models["choices"]))
    if not choice["present"]:
        return "%s is not in %s" % (choice["file"], MODELS_DIR)
    return None


def select_model(key):
    """Record the choice where llm.sh reads it, as `llm-use` does."""
    problem = model_problem(key)
    if problem:
        raise ValueError(problem)
    scratch = LLM_CHOICE + ".tmp"
    with open(scratch, "w") as fh:
        fh.write(key + "\n")
    os.replace(scratch, LLM_CHOICE)


# --------------------------------------------------------------------- jobs

class Jobs:
    """The record of what was asked for and what happened."""

    def __init__(self):
        self._lock = threading.Lock()
        self._jobs = {}
        self._active = {}          # target -> job id, so two clicks do not race

    def active_for(self, target):
        with self._lock:
            job_id = self._active.get(target)
            return dict(self._jobs[job_id]) if job_id else None

    def listing(self, limit=12):
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j["started"], reverse=True)
            return [dict(j) for j in jobs[:limit]]

    def _new(self, target, action, label):
        job = {
            "id": uuid.uuid4().hex[:12],
            "target": target,
            "action": action,
            "label": label,
            "state": "running",
            # a restart passes through both phases; the panel labels itself
            # from this rather than from the action
            "phase": "starting" if action == "start" else "stopping",
            "message": "starting up" if action == "start" else "shutting down",
            "started": time.time(),
            "finished": None,
        }
        with self._lock:
            self._jobs[job["id"]] = job
            self._active[target] = job["id"]
        return job

    def _say(self, job, message, phase=None):
        with self._lock:
            job["message"] = message
            if phase:
                job["phase"] = phase

    def _finish(self, job, state, message):
        with self._lock:
            job["state"] = state
            job["message"] = message
            job["finished"] = time.time()
            if self._active.get(job["target"]) == job["id"]:
                del self._active[job["target"]]

    # ---------------------------------------------------------------- verbs

    def run(self, target, action, spec):
        """Queue an action; returns the job, or an existing one if busy."""
        busy = self.active_for(target)
        if busy:
            return busy, "already %s" % busy["action"] + "ing"
        job = self._new(target, action, spec.get("label", target))
        if spec.get("model"):
            job["model"] = spec["model"]        # set before the worker starts
        worker = threading.Thread(
            target=self._work, args=(job, action, spec), daemon=True)
        worker.start()
        return job, None

    def _work(self, job, action, spec):
        """The phases report back rather than closing the job themselves,
        which is what lets restart run stop and start under one job."""
        try:
            if action == "start":
                ok, message = self._start(job, spec)
            elif action == "stop":
                ok, message = self._stop(job, spec)
            elif action == "restart":
                ok, message = self._stop(job, spec)
                if ok:
                    ok, message = self._start(job, spec)
            elif action == "switch":
                ok, message = self._switch(job, spec)
            else:
                ok, message = False, "unknown action"
            self._finish(job, "done" if ok else "failed", message)
        except Exception as exc:                # noqa: BLE001 - shown in the UI
            self._finish(job, "failed", str(exc))

    def _switch(self, job, spec):
        """A restart onto another model: the choice is written only once the
        old server is down, so a failed stop leaves the selection as it was."""
        model = spec["model"]
        self._say(job, "switching to %s" % model)
        ok, message = self._stop(job, spec)
        if not ok:
            return ok, message
        select_model(model)
        ok, message = self._start(job, spec)
        return ok, ("now serving %s" % model) if ok else message

    def _start(self, job, spec):
        """Returns (ok, message)."""
        session, command = spec.get("session"), spec.get("command")
        if not command:
            return False, "no launcher known; add one to launchers.json"
        if _find(spec["exe"], spec.get("match")):
            return True, "it was already running"

        self._say(job, "launching %s" % os.path.basename(command), phase="starting")
        _tmux("kill-session", "-t", _exact(session))
        # keep the launcher's own output; when a start fails the reason is
        # almost always in there, and the tmux session is gone by then
        log = os.path.join(vms.TERMOX_HOME, "%s.launch.log" % session)
        try:
            os.makedirs(vms.TERMOX_HOME, exist_ok=True)
            os.remove(log)
        except OSError:
            pass
        result = _tmux("new-session", "-d", "-s", session,
                       "%s > %s 2>&1" % (command, log))
        if result is None or result.returncode != 0:
            detail = (result.stderr or "").strip() if result else "tmux missing"
            return False, detail or "tmux refused to start it"

        self._say(job, "waiting for the process")
        deadline = time.time() + START_TIMEOUT
        pid = None
        while time.time() < deadline:
            pid = _find(spec["exe"], spec.get("match"))
            if pid:
                break
            time.sleep(1.0)
        if not pid:
            return False, _why_not(log) or "the process never appeared"

        probe = spec.get("probe")
        if not probe:
            return True, "started"

        wait_for = {"banner": banner_open, "health": health_ok}.get(
            spec.get("probe_kind"), vms.probe)
        self._say(job, spec.get("waiting", "loading; waiting for port %d" % probe))
        while time.time() < deadline:
            if wait_for(probe):
                return True, spec.get("ready", "ready")
            if not _alive(pid):
                return False, _why_not(log) or "it exited while starting"
            time.sleep(1.5)
        return False, "it did not answer on %d in time" % probe

    def _stop(self, job, spec):
        """Returns (ok, message)."""
        pid = _find(spec["exe"], spec.get("match"))
        if not pid:
            _tmux("kill-session", "-t", _exact(spec.get("session", "")))
            return True, "it was not running"

        graceful = spec.get("graceful")
        if graceful:
            self._say(job, graceful["message"], phase="stopping")
            try:
                subprocess.run(graceful["command"], capture_output=True,
                               timeout=graceful.get("timeout", 45))
            except (OSError, subprocess.SubprocessError):
                pass
            deadline = time.time() + STOP_TIMEOUT
            while time.time() < deadline and _alive(pid):
                self._say(job, "waiting for a clean shutdown")
                time.sleep(2.0)

        if _alive(pid):
            self._say(job, "asking the process to exit", phase="stopping")
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
            deadline = time.time() + GRACE_SECONDS
            while time.time() < deadline and _alive(pid):
                time.sleep(0.5)

        if _alive(pid):
            self._say(job, "it ignored the request; forcing")
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            time.sleep(1.5)

        _tmux("kill-session", "-t", _exact(spec.get("session", "")))
        if _alive(pid):
            return False, "the process would not exit"
        return True, "stopped"
