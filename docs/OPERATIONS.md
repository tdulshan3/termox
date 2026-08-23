# termox

A control panel for the machines running on a phone. It runs **in Termux on
the phone itself** and answers on the LAN, so a browser anywhere in the house
shows what the phone and its VMs are doing.

Today it reads. Creating, starting and connecting to machines is the next
piece of work, and the registry underneath is built for it.

```
browser  →  phone:8080   termox        (Termux, native)
                ├─ /proc + /sys        the phone, incl. Adreno GPU
                ├─ /proc/<pid>         each qemu process
                ├─ :8081/metrics       the model server
                └─ ssh 127.0.0.1:2222  inside each guest
```

Stdlib only, on both ends. No pip, no npm, no build step, and nothing
installed inside the guests.

## Install on the phone

```sh
pkg install python openssh
mkdir -p ~/termox
# copy the termox/ package folder to ~/termox/
cd ~/termox && python3 -m termox
```

Open **http://<phone-ip>:8080** from any machine on the network.

To keep it up across reboots, add one line to `~/.termux/boot/start-vm.sh`:

```sh
tmux new-session -d -s scope 'cd ~/termox && python3 -m termox'
```

`tmux attach -t scope` shows its log.

## Machines find themselves

Nothing needs to be registered. termox walks `/proc` for `qemu-system-*`
processes and reads their command line, so a VM started by hand or from a
tmux session simply appears, with its cores, memory, disks and port forwards
parsed out of the arguments. Relative disk paths are resolved through the
process's own working directory, and qcow2 virtual sizes come from the image
header.

What it learns is written to `~/.config/termox/registry.json`, which is what
lets a machine keep its place in the list after it stops rather than
vanishing.

## Reading inside a guest

Guest stats are collected **over SSH, with nothing installed in the VM** — one
multiplexed connection runs a small shell probe that cats `/proc` and asks
Docker for its containers. A machine is wired up automatically when it
forwards a host port to guest port 22.

```sh
python3 -m termox setup-guest
```

That makes a key at `~/.config/termox/id_ed25519` and prints the one line to
paste inside each guest. Overrides (a different user, port or key) go in
`~/.config/termox/guests.json`, keyed by machine name:

```json
{ "alpine": { "user": "root", "port": 2222, "host": "127.0.0.1" } }
```

### Why Docker readings lag

Under TCG emulation the Docker CLI costs about **18 seconds for `docker ps`
and 22 for `docker stats`** — the Go binary's startup, not the data. So the
poll never waits on it: the probe reads a cache file inside the guest and, if
that has gone stale, kicks off a detached refresh that lands on a later poll.
The card shows how old the reading is. Raise or lower the cadence with
`TERMOX_DOCKER_REFRESH`.

The same emulation tax applies to SSH itself: key exchange is the single most
expensive thing the guest does, so termox brings up one long-lived master
connection and every later poll rides it.

## What Android will not let it read

This matters more than it sounds. On a Samsung build (Knox tightens SELinux
well past stock), an ordinary app is **denied `/proc/stat`, `/proc/uptime`,
`/proc/loadavg`, `/proc/net/dev` and `/sys/class/net`**.

| Reading | How termox gets it |
|---|---|
| Per-core CPU load | **`/sys/.../cpuidle/state*/time`** — busy time is derived from idle residency, since `/proc/stat` is off limits |
| Core frequencies, clusters | `/sys/devices/system/cpu/...` |
| System uptime | derived from our own `/proc/self/stat` start jiffies |
| RAM, swap | `/proc/meminfo` |
| Storage | `statvfs`; read-only volumes are skipped |
| Thermal zones | `/sys/class/thermal` |
| Per-VM CPU, memory, uptime | `/proc/<pid>/stat` — own processes stay visible |
| Battery | `pkg install termux-api` **plus the Termux:API app** — the package alone only installs shell wrappers, which block forever without the app, so the panel names that case |
| GPU load | `/sys/class/kgsl` — usually root-only; the panel says so rather than showing zero |
| **Load average** | **not available** |
| **Host network throughput** | **not available** — the guest's own interfaces still are |
| GPU load and clock | `/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage` and `clock_mhz` — readable, unlike the root-only `gpubusy`/`gpuclk` the obvious guess uses |

Where there is no way through, the panel prints the reason. Nothing shows a
zero that could be mistaken for an idle system.

## The model server

A local LLM runs on port 8081 with an OpenAI-compatible API, and appears in
the sidebar under **Services** with its own page: throughput trend, requests
in flight, model and context, endpoints, and the process's CPU, memory, cores
and priority.

**It runs on the CPU, not the GPU.** That is the opposite of what seems
obvious, so here are the measurements (llama-bench, Qwen2.5-0.5B Q4_0, tg32):

| backend | threads | prompt | generation |
|---|---|---|---|
| CPU | **4** | 58.1 | **39.2 tok/s** |
| CPU | 3 | 44.0 | 29.4 |
| CPU | 6 | 60.2 | 23.8 |
| CPU | 8 | 9.6 | **0.2** |
| GPU (Adreno OpenCL) | 4 | 49.6 | 10.8 |

**The thread count dominates everything else.** The 865 has 4 big cores and 4
little ones; a fifth thread lands on an efficiency core that every sync
barrier then waits for. Eight threads to four is a ~200x difference. An
earlier round of this work measured "0.13 tok/s on CPU" and concluded the CPU
was hopeless -- that number was llama-bench defaulting to 8 threads, not a
property of the phone.

The GPU does work (see `~/clshim` and the notes below) but is 3.6x slower
*and* numerically wrong for some models: on the Adreno OpenCL backend Qwen3.5
emits degenerate loops at temperature 0, while the identical file on the CPU
answers correctly. Qwen2.5 is fine on both, which is what made the fault look
like broken model support at first.

**Context is allocated per slot, not per server.** llama-server defaults to
several parallel slots and gives each one the full `-c`, so `-c 32768` alone
would try to allocate four of them. Pair it with `--parallel 1` for a
single-user setup: 32k context then costs about 0.2 GB rather than four times
that. Verified with a 7,015-token prompt, processed at 32.9 tok/s.

`--reasoning off` matters for short tasks: Qwen3.5 is a thinking model and will
otherwise spend 300+ tokens deliberating before answering "name three
colours". With it off that answer costs 29 tokens.

### Reaching the GPU anyway

If you want to experiment, uncomment the two exports in `~/llm.sh` and add
`-ngl 99 -fa off`. Three things are required and none are obvious:

- `LD_LIBRARY_PATH=$PREFIX/opt/vendor/lib` -- ocl-icd cannot drive Qualcomm's
  driver (it is a full implementation, not an ICD vendor library, so the
  loader reports zero platforms). That directory holds only `libOpenCL.so`,
  which is why it is safe first on the path; `/vendor/lib64` would hijack
  libc++ and break every Termux binary.
- `LD_PRELOAD=~/clshim/libclshim.so` -- supplies
  `clCreateBufferWithProperties`, an OpenCL 3.0 entry point this 2021 driver
  never shipped, without which `libggml-opencl.so` will not even load.
- `-fa off` -- the flash-attention kernels assume Adreno 7xx work-group
  geometry and abort with `CL_INVALID_WORK_GROUP_SIZE` on a 650.

One trap in the telemetry: llama.cpp **resets its per-second gauges when
`/metrics` is scraped**, so a dashboard polling every few seconds consumes the
value and reads zero forever after. The rates shown are derived from the
monotonic counters instead.

`~/tune.sh` splits the CPU: QEMU is confined to the slowest permitted cores
and niced to 10, the model server runs unrestricted. It never pins to fixed
core numbers, because **Android reshuffles which cores this app may use** —
the permitted set was seen changing between two consecutive calls. Re-run it
whenever the split looks wrong.

Not every model works. llama.cpp b10516's `qwen35` support is broken: Ollama's
GGUF will not load (`rope.dimension_sections` expected 4, got 3) and unsloth's
emits degenerate loops at temperature 0. That is not a GPU fault — Qwen2.5-0.5B
on the same GPU answers correctly. Retest after `pkg upgrade llama-cpp`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `TERMOX_PORT` | 8080 | listen port |
| `TERMOX_BIND` | 0.0.0.0 | listen address |
| `TERMOX_TOKEN` | unset | require this token on `/api/*` |
| `TERMOX_HOME` | `~/.config/termox` | registry, keys, known_hosts |
| `TERMOX_DOCKER_REFRESH` | 240 | seconds between container refreshes |
| `TERMOX_SSH_TIMEOUT` | 45 | seconds a guest probe may take |
| `TERMOX_LLM_URL` | `http://127.0.0.1:8081` | model server to scrape |
| `TERMOX_MASTER_TIMEOUT` | 90 | seconds to establish the shared SSH connection |

## Commands

```sh
python3 -m termox                 # serve
python3 -m termox nodes           # discovered machines, as JSON
python3 -m termox setup-guest     # key + instructions for guest reading
python3 -m termox forget KEY      # drop a machine from the registry
```

## Security

The dashboard binds `0.0.0.0:8080` with **no authentication** — keep it on the
LAN or behind Tailscale. Set `TERMOX_TOKEN` to require a token, then open
`http://phone:8080/?token=...`.

## API

`GET /api/state` returns everything the UI draws: `host`, `nodes`, `guests`,
`history`. `GET /api/host` and `GET /api/nodes` are the same data in smaller
pieces.

---

`legacy/` holds StackScope, the earlier single-VM dashboard this replaced.
