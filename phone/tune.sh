#!/data/data/com.termux/files/usr/bin/python3
"""Keep QEMU out of the model servers' way -- and nothing more.

An earlier version of this script pinned the CPU model server to the "fast"
cores, ranked by cpuinfo_max_freq. That HALVED throughput (8.7 tok/s pinned
versus 19.5 unpinned) for a reason worth writing down:

    cpu7  prime,  2841 MHz max  ->  capped at 1747, running 845
    cpu4  perf,   2419 MHz max  ->  capped at 1747, running 1382
    cpu0  little, 1804 MHz max  ->  uncapped,       running 1612

Android throttles the big cores far below the little ones for background
apps, so hardware maximum frequency is the wrong ranking: pinning to the
"fastest" cores pins to the most throttled ones. The caps also move around,
as does the permitted core set itself (it was seen changing between two
consecutive calls of this script).

So the model servers are left unpinned -- the kernel knows the real caps and
places them better than a static mask can. The only thing worth doing is
keeping QEMU, which will happily eat every core it is given under TCG, on a
couple of cores at low priority. `-t 4` in llm.sh is what actually buys the
throughput.

Idempotent. Re-run after boot, or whenever something looks wrong.
"""
import os, glob

QEMU_CORES = 2


def described():
    for path in glob.glob("/proc/[0-9]*/cmdline"):
        pid = int(path.split("/")[2])
        try:
            argv = [a.decode("utf-8", "replace")
                    for a in open(path, "rb").read().split(b"\0") if a]
        except OSError:
            continue
        if argv:
            yield pid, os.path.basename(argv[0]), argv


def port_of(argv):
    for i, arg in enumerate(argv):
        if arg == "--port" and i + 1 < len(argv):
            return argv[i + 1]
    return None


allowed = set(os.sched_getaffinity(0))
# give QEMU the lowest-numbered cores, which on this SoC are the efficiency
# cluster -- adequate for a DNS container and out of everything else's way
qemu_set = set(sorted(allowed)[:QEMU_CORES]) or allowed
print("permitted now: %s" % sorted(allowed))

for pid, name, argv in described():
    if name == "llama-server":
        label, target, nice = "llama-server :%s" % (port_of(argv) or "?"), allowed, None
    elif name == "qemu-system-aarch64":
        label, target, nice = "qemu", qemu_set, 10
    else:
        continue
    try:
        os.sched_setaffinity(pid, target)
        if nice is not None and os.getpriority(os.PRIO_PROCESS, pid) < nice:
            os.setpriority(os.PRIO_PROCESS, pid, nice)
        print("%-22s pid %-7d cpus %-16s nice %d"
              % (label, pid, sorted(os.sched_getaffinity(pid)),
                 os.getpriority(os.PRIO_PROCESS, pid)))
    except OSError as exc:
        print("%-22s pid %-7d failed: %s" % (label, pid, exc))
