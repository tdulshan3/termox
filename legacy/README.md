# StackScope — setup

Two processes. The dashboard runs **natively in Termux** (fast, and it can read
Android's `/proc`, which nothing inside the VM can see). A small agent runs
**inside Alpine** and reports guest + Docker stats back through QEMU's port
forward.

```
Browser  →  phone:8080   dashboard.py   (Termux, native — reads Android /proc)
                 ↓ 127.0.0.1:9101 via hostfwd
             VM:9101      vmagent.py    (Alpine — reads guest /proc + docker.sock)
```

---

## 1. Open a port to the guest

The VM sits behind QEMU's NAT, so the agent needs a forward. Edit `~/alpine/vm.sh`
on the phone and add `,hostfwd=tcp::9101-:9101` to the existing `-netdev` argument:

```
-netdev user,id=n0,hostfwd=tcp::2222-:22,hostfwd=udp::5300-:53,hostfwd=tcp::3000-:3000,hostfwd=tcp::9101-:9101
```

Restart the VM for it to take effect.

## 2. Install the agent in the VM

```sh
ssh -p 2222 root@<phone-ip>
apk add python3
mkdir -p /opt/stackscope
# paste vmagent.py to /opt/stackscope/vmagent.py
chmod +x /opt/stackscope/vmagent.py
```

Run it under OpenRC so it survives reboots:

```sh
cat > /etc/init.d/stackscope <<'EOF'
#!/sbin/openrc-run
name="stackscope"
command="/usr/bin/python3"
command_args="/opt/stackscope/vmagent.py"
command_background=true
pidfile="/run/stackscope.pid"
output_log="/var/log/stackscope.log"
error_log="/var/log/stackscope.log"
depend() { need docker; after net; }
EOF
chmod +x /etc/init.d/stackscope
rc-update add stackscope default
service stackscope start
```

Check it: `wget -qO- localhost:9101/stats | head -c 200`

It must run as root to read `/var/run/docker.sock`.

## 3. Install the dashboard on the phone

```sh
pkg install python termux-api      # termux-api enables battery readings
mkdir -p ~/stackscope
# put dashboard.py and dashboard.html in ~/stackscope/
cd ~/stackscope && python3 dashboard.py
```

Open **http://<phone-ip>:8080** from your desktop.

## 4. Start it at boot

Add one line to `~/.termux/boot/start-vm.sh`, after the tmux line:

```sh
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sshd
sleep 15
tmux new-session -d -s vm ~/alpine/vm.sh
tmux new-session -d -s scope 'cd ~/stackscope && python3 dashboard.py'
```

Two named sessions: `tmux attach -t vm` for the VM console, `-t scope` for the
dashboard log.

---

## What needs root, and what doesn't

| Reading | Works unrooted? |
|---|---|
| Per-core CPU %, cluster grouping | yes — `/proc/stat` |
| Core frequencies | usually — `/sys/.../scaling_cur_freq` |
| RAM, storage, load, uptime | yes |
| Thermal zones | often, varies by device |
| Battery % / temp | yes, via Termux:API |
| **Adreno GPU load** | **usually not** — `/sys/class/kgsl/` is typically root-only on stock Android 13 |

The GPU panel reports why it can't read rather than showing a fake zero. Test
directly with:

```sh
cat /sys/class/kgsl/kgsl-3d0/gpubusy
```

Permission denied there means the panel stays empty, and there's no way around
it on a locked bootloader.

## Environment variables

| Variable | Default | Applies to |
|---|---|---|
| `STACKSCOPE_PORT` | 8080 / 9101 | both |
| `STACKSCOPE_VM_AGENT` | `http://127.0.0.1:9101` | dashboard |
| `STACKSCOPE_DOCKER_REFRESH` | 8 (seconds) | agent |

Container stats are cached and refreshed on a slower interval than everything
else — each `docker stats` sample costs real CPU, and under TCG emulation that
adds up. Raise `STACKSCOPE_DOCKER_REFRESH` if the VM feels loaded.

## Notes

- Both processes are **stdlib only**. No pip, no npm, no build step.
- Sampling is done by background threads, so multiple browser tabs don't
  corrupt the CPU deltas.
- The dashboard binds `0.0.0.0:8080` — above 1024, so no root needed. Keep it on
  the LAN or behind Tailscale; there's no authentication.
