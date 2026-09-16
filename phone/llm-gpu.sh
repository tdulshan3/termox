#!/data/data/com.termux/files/usr/bin/sh
# Qwen2.5-0.5B on the Adreno 650, alongside the CPU server on 8081.
#
# Only models that are numerically correct on the OpenCL backend belong here.
# Qwen2.5 is: at temperature 0 it answers "Paris" and "4" on the GPU. Qwen3.5
# is NOT: the same GGUF that answers correctly on the CPU emits degenerate
# loops on this backend, so it stays on 8081.
#
# Speed note: the GPU is the slower path (10.8 tok/s versus 39.2 on four CPU
# threads). This server exists so GPU work can run WITHOUT taking the big
# cores from the CPU server, not because it is faster.
#
# The three requirements, none of them obvious:
#   LD_LIBRARY_PATH  ocl-icd cannot drive Qualcomms driver (a full
#                    implementation, not an ICD vendor library, so the loader
#                    finds zero platforms). That directory holds only
#                    libOpenCL.so, so unlike /vendor/lib64 it will not hijack
#                    the C++ runtime and break every Termux binary.
#   LD_PRELOAD       supplies clCreateBufferWithProperties, an OpenCL 3.0
#                    entry point this 2021 driver never shipped; without it
#                    libggml-opencl.so will not even dlopen.
#   -fa off          the flash-attention kernels assume Adreno 7xx work group
#                    geometry and abort with CL_INVALID_WORK_GROUP_SIZE here.
#
# Retested on llama.cpp 0.4.1: still correct for Qwen2.5 (13.7 tok/s), still
# wrong for Qwen3.5. --load-mode none replaces --no-mmap, which 0.4.1 refuses.
#
# CORES. The host side of GPU generation is CPU work, and fast cores help it:
# 16.7 tok/s with its threads free on cores 1-7, 11.1 confined to the little
# cores 1-3. It lives on 1-3 anyway, to leave the big cores to the CPU server;
# tune.sh keeps it there. The two servers still slow each other down through
# shared memory and heat: while this one generated, the 4B on the CPU server
# dropped from 5.5 / 4.2 to 4.7 / 2.5 tok/s (prompt / generation).
export LD_LIBRARY_PATH=$PREFIX/opt/vendor/lib
export LD_PRELOAD=$HOME/clshim/libclshim.so
exec taskset -c 1-3 llama-server \
  -m $HOME/models/Qwen2.5-0.5B-Instruct-Q4_0.gguf \
  -ngl 99 -fa off \
  -t 2 -c 8192 --parallel 1 -b 256 --load-mode none \
  --host 0.0.0.0 --port 8082 \
  --metrics \
  --alias qwen2.5-0.5b-gpu
