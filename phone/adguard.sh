#!/data/data/com.termux/files/usr/bin/python3
"""Start AdGuard Home natively in Termux.

Two Android restrictions shape this, and both are worked around here rather
than in the config, because the answer changes every time the phone gets a new
DHCP lease:

  * `bind_hosts: 0.0.0.0` is FATAL. Expanding a wildcard bind makes AdGuard
    enumerate interfaces, which goes through netlink, which Android denies to
    apps -- `route ip+net: netlinkrib: permission denied`. Go's net.Interfaces()
    returns nothing here for the same reason, so this is not fixable in
    AdGuard. Binding literal addresses skips the enumeration entirely.
  * Port 53 cannot be bound without root, so DNS is served on 5300 -- the same
    port the QEMU VM used to forward, so no client needs reconfiguring.

The LAN address is discovered by asking the routing table which source address
it would use for an outside destination. No packet is sent, and it needs no
netlink.
"""
import os, socket, sys

HOME = os.environ["HOME"]
CONFIG = os.path.join(HOME, "adguard", "AdGuardHome.yaml")
DNS_PORT = 5300
WEB_PORT = 3000


def lan_address():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 9))       # TEST-NET-1, never routed
        return sock.getsockname()[0]
    except OSError:
        return None
    finally:
        sock.close()


def rewrite(path, address):
    """Point every listener at literal addresses.

    Both the DNS server and the web API must be given concrete addresses. A
    wildcard (or a missing `address:` key, which defaults to one) sends
    AdGuard down the interface-enumeration path that Android forbids, and it
    exits. The web key is often absent entirely, so it is inserted rather than
    replaced.
    """
    hosts = ["127.0.0.1"] + ([address] if address and address != "127.0.0.1" else [])
    web_host = hosts[-1]
    lines = open(path).read().splitlines()
    out, i, in_http = [], 0, False

    while i < len(lines):
        line = lines[i]

        if line == "  bind_hosts:":
            out.append(line)
            out.extend("    - " + h for h in hosts)
            i += 1
            while i < len(lines) and lines[i].startswith("    - "):
                i += 1
            continue

        if line.startswith("  port: ") and any(l == "dns:" for l in out):
            # the first `  port:` after `dns:` is the DNS listener
            if not any(l.startswith("  port: %d" % DNS_PORT) for l in out):
                out.append("  port: %d" % DNS_PORT)
                i += 1
                continue

        if line == "http:":
            in_http = True
            out.append(line)
            out.append("  address: %s:%d" % (web_host, WEB_PORT))
            i += 1
            continue

        if in_http:
            if line and not line.startswith(" "):
                in_http = False                       # left the http block
            elif line.startswith("  address: "):
                i += 1                                # drop any existing key
                continue

        out.append(line)
        i += 1

    open(path, "w").write("\n".join(out) + "\n")
    return hosts, web_host


address = lan_address()
hosts, web_host = rewrite(CONFIG, address)
print("dns %s:%d | web %s:%d" % (", ".join(hosts), DNS_PORT, web_host, WEB_PORT), flush=True)

os.chdir(os.path.join(HOME, "adguard"))
os.execv("./AdGuardHome",
         ["AdGuardHome", "-c", CONFIG, "-w", os.path.join(HOME, "adguard"),
          "--no-check-update"])
