"""Command line entry point: python3 -m termox [command]"""

import json
import os
import subprocess
import sys
import time

from . import guestlink, server, vms

USAGE = """termox - a control panel for the machines running on this phone

  python3 -m termox                 serve the dashboard (default)
  python3 -m termox nodes           print the discovered machines as JSON
  python3 -m termox setup-guest     make a key so the dashboard can read
                                    inside a guest, and show how to trust it
  python3 -m termox forget KEY      drop a machine from the registry

Environment:
  TERMOX_PORT      listen port                    (default 8080)
  TERMOX_BIND      listen address                 (default 0.0.0.0)
  TERMOX_TOKEN     require this token on /api/*   (default unset)
  TERMOX_HOME      state directory                (default ~/.config/termox)
"""


def cmd_nodes():
    """Two passes with a real gap between them: CPU percent is a delta, so
    the first pass only primes the counters."""
    registry = vms.Registry()
    registry.refresh(1.0)
    time.sleep(1.0)
    nodes = registry.refresh(1.0)
    print(json.dumps(nodes, indent=2, default=str))


def cmd_forget(argv):
    if not argv:
        print("which one? pass the key shown by `termox nodes`")
        return 1
    print("forgotten" if vms.Registry().forget(argv[0]) else "no such machine")
    return 0


def cmd_setup_guest(argv):
    """Create the dashboard's own key and explain how to trust it.

    The key is never pushed automatically -- that would need the guest's
    password, and authorising a key is the kind of change worth typing
    yourself.
    """
    port = argv[0] if argv else None
    os.makedirs(vms.TERMOX_HOME, exist_ok=True)
    key = guestlink.KEY_PATH
    if not os.path.exists(key):
        subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-q",
                        "-C", "termox", "-f", key], check=True)
        print("created %s" % key)
    else:
        print("using existing %s" % key)

    try:
        with open(key + ".pub") as fh:
            pub = fh.read().strip()
    except OSError:
        print("could not read the public key")
        return 1

    print("\nRun this once inside each guest you want stats from:\n")
    print("  mkdir -p ~/.ssh && echo '%s' >> ~/.ssh/authorized_keys" % pub)
    print("  chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys\n")

    if not port:
        registry = vms.Registry()
        for node in registry.refresh(0.5):
            for fwd in node["ports"]:
                if fwd["guest_port"] == 22:
                    port = str(fwd["host_port"])
                    print("%s answers ssh on host port %s" % (node["name"], port))
    if port:
        target = {"host": "127.0.0.1", "port": int(port), "user": "root",
                  "key": key}
        text, error = guestlink._run(target, "echo reachable\n", 10)
        print("\ntest: %s" % (error or (text or "").strip()))
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    command = argv[0] if argv else "serve"
    if command in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    if command == "nodes":
        return cmd_nodes()
    if command == "forget":
        return cmd_forget(argv[1:])
    if command == "setup-guest":
        return cmd_setup_guest(argv[1:])
    if command != "serve":
        print(USAGE)
        return 2
    server.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
