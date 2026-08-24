#!/data/data/com.termux/files/usr/bin/sh
# Qwen3.5-0.8B on the Snapdragon 865 CPU.
#
# Measured on this phone (llama-bench, Qwen2.5-0.5B Q4_0, tg32) -- the thread
# count dominates everything else:
#     CPU  -t 4    39.2 tok/s     <- what we run
#     CPU  -t 3    29.4
#     CPU  -t 6    23.8
#     CPU  -t 8     0.2           <- llama-bench default; never let it default
#     GPU  -ngl 99 10.8
#
# The 865 is 4 big cores plus 4 little ones. A fifth thread lands on an
# efficiency core that every sync barrier then waits for, so 8 threads to 4 is
# a ~200x difference, not a tuning nicety. The GPU is the slower path here and
# is also numerically wrong for this model: on the Adreno OpenCL backend
# Qwen3.5 emits degenerate loops at temperature 0, while the same file on the
# CPU answers correctly. Keep this on the CPU.
#
# --no-mmap keeps the weights in ordinary RAM; a memory-mapped model has its
# pages evicted by Android under pressure, which stalls generation.
#
# --reasoning off is not a preference, it is a requirement at this model size.
# Measured with reasoning on: "Name three colours." consumed 600 tokens of
# thinking without ever producing an answer, and a genuine reasoning question
# consumed 1200. The 0.8B model does not reliably terminate its own thinking,
# so every reply came back empty with finish_reason=length.
#
# Off is also strictly better than auto, because it is only a DEFAULT: a client
# can still request thinking per call with
#     "chat_template_kwargs": {"enable_thinking": true}
# which does engage it. The reverse is not true of --reasoning on, which no
# client request can switch off.
exec llama-server \
  -m $HOME/models/Qwen3.5-0.8B-Q4_0.gguf \
  -t 4 -c 131072 --parallel 1 -b 256 --no-mmap \
  --reasoning on \
  --reasoning-effort minimal \
  --host 0.0.0.0 --port 8081 \
  --metrics \
  --alias qwen3.5-0.8b
