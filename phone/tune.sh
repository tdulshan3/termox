#!/data/data/com.termux/files/usr/bin/python3
"""Give the model servers every core but one, and the other services that one.

    core 0       Immich, AutoClaim, AdGuard, the panel, QEMU
    cores 1-7    the CPU model server
    cores 1-3    the GPU model server's host threads, off the big cores
                 (see llm-gpu.sh for what that costs it)

How many of those seven cores a model server computes on is -t and -tb in
llm.sh, not this script. Measured on Qwen3.5-4B, 4 big cores capped at
1747 MHz (screen off), tok/s:

    threads      prompt   generation
    4             5.64      4.23        <- -t: generation wants big cores only
    5             5.86      3.99
    6             6.14      4.08
    7 (1-7)       6.49      4.06        <- -tb: prompts gain from little cores

MASKS COME FROM THE CORE COUNT, NEVER FROM sched_getaffinity(). Qualcomm's
core_ctl parks big cores that have gone idle -- here core 4 and the prime core
7 -- and this kernel leaves parked cores out of what sched_getaffinity()
reports, although Cpus_allowed in /proc still lists them. The previous version
of this script copied that report onto llama-server, which locked the server
out of cores 4 and 7 even after load woke them up:

    all four big cores                       5.62 prompt   4.24 generation
    mask copied from an idle report          3.55 prompt   2.62 generation

That is also the likeliest reading of what the version before it recorded
("pinning to the cores with the highest cpuinfo_max_freq halved throughput"):
ranked from the reported set, the "fastest four" are two big cores and two
little ones. The frequency caps it blamed are real, but they cap a whole
cluster for everyone (scaling_max_freq is per cluster), and a capped A77
still outruns an A55. See llm.sh for what the cap is.

Masks and nice values belong to threads, so every thread is set. Children
inherit their parent's mask, which is what keeps Postgres backends and
Immich's workers on core 0 once the parents are there.

The panel restarts services whenever it likes, so `--watch [seconds]`
re-applies the split every 30 seconds by default; start-vm.sh runs it that
way. Without --watch it makes one pass and prints every match. Idempotent.
"""
import glob
import os
import sys
import time

RESERVED = {0}
MODEL = set(range(os.cpu_count())) - RESERVED
GPU_HOST = {1, 2, 3}
QEMU_NICE = 10

# First word of argv[0]'s basename. Several of these retitle themselves:
# Immich shows up as `immich` and `immich-api`, Valkey as
# "valkey-server 127.0.0.1:6379", Postgres backends as "postgres: ...".
OTHERS = {"immich", "immich-api", "node", "postgres", "valkey-server",
          "redis-server", "AdGuardHome"}


def processes():
    for path in glob.glob("/proc/[0-9]*/cmdline"):
        pid = int(path.split("/")[2])
        try:
            with open(path, "rb") as f:
                argv = [a.decode("utf-8", "replace")
                        for a in f.read().split(b"\0") if a]
        except OSError:
            continue
        words = os.path.basename(argv[0]).split() if argv else []
        if words:
            yield pid, words[0].rstrip(":"), argv


def option(argv, *names):
    for i, arg in enumerate(argv):
        if arg in names and i + 1 < len(argv):
            return argv[i + 1]
    return None


def role(name, argv):
    """(label, cores, nice) for a process this script manages, else None."""
    if name == "llama-server":
        label = "llama-server :%s" % (option(argv, "--port") or "?")
        gpu = option(argv, "-ngl", "--gpu-layers", "--n-gpu-layers") not in (None, "0")
        return label, GPU_HOST if gpu else MODEL, None
    if name == "qemu-system-aarch64":
        return "qemu", RESERVED, QEMU_NICE
    if name in OTHERS:
        return name, RESERVED, None
    if name.startswith("python") and "termox" in argv:
        return "termox", RESERVED, None
    return None


def allowed(pid, tid):
    """The mask the kernel holds for a thread, parked cores included."""
    try:
        with open("/proc/%d/task/%d/status" % (pid, tid)) as f:
            for line in f:
                if line.startswith("Cpus_allowed_list:"):
                    cores = set()
                    for part in line.split(":", 1)[1].strip().split(","):
                        lo, _, hi = part.partition("-")
                        cores.update(range(int(lo), int(hi or lo) + 1))
                    return cores
    except (OSError, ValueError):
        pass
    return None


def compact(cores):
    cores = sorted(cores)
    if cores == list(range(cores[0], cores[-1] + 1)):
        return "%d-%d" % (cores[0], cores[-1]) if len(cores) > 1 else str(cores[0])
    return ",".join(map(str, cores))


def apply(verbose):
    for pid, name, argv in processes():
        managed = role(name, argv)
        if managed is None:
            continue
        label, cores, nice = managed
        threads = moved = reniced = failed = 0
        for task in glob.glob("/proc/%d/task/[0-9]*" % pid):
            tid = int(task.rsplit("/", 1)[1])
            threads += 1
            try:
                if allowed(pid, tid) != cores:
                    os.sched_setaffinity(tid, cores)
                    moved += 1
                if nice is not None and os.getpriority(os.PRIO_PROCESS, tid) < nice:
                    os.setpriority(os.PRIO_PROCESS, tid, nice)
                    reniced += 1
            except OSError:
                failed += 1     # the thread exited between listing and setting
        if verbose or moved or reniced:
            print("%s %-18s pid %-6d cores %-4s threads %d, moved %d, reniced %d%s"
                  % (time.strftime("%H:%M:%S"), label, pid, compact(cores), threads,
                     moved, reniced, ", failed %d" % failed if failed else ""),
                  flush=True)


def main():
    print("model servers on cores %s, other services on %s"
          % (compact(MODEL), compact(RESERVED)), flush=True)
    if sys.argv[1:2] != ["--watch"]:
        apply(verbose=True)
        return
    period = float(sys.argv[2]) if len(sys.argv) > 2 else 30.0
    while True:
        apply(verbose=False)
        time.sleep(period)


if __name__ == "__main__":
    main()
