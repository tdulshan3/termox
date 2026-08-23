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
export LD_LIBRARY_PATH=$PREFIX/opt/vendor/lib
export LD_PRELOAD=$HOME/clshim/libclshim.so
exec llama-server \
  -m $HOME/models/Qwen2.5-0.5B-Instruct-Q4_0.gguf \
  -ngl 99 -fa off \
  -t 2 -c 8192 --parallel 1 -b 256 --no-mmap \
  --host 0.0.0.0 --port 8082 \
  --metrics \
  --alias qwen2.5-0.5b-gpu
