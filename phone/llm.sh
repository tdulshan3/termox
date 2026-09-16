#!/data/data/com.termux/files/usr/bin/sh
# The CPU model server on :8081, one model at a time, on the Snapdragon 865.
#
# Which model: the first argument, else ~/.llm-model, else 0.8b. `llm-use`
# (llm-use.sh) switches it and restarts this session. To add a model, add a
# line to the case at the bottom; llm-use reads its choices from there.
#
# llama.cpp 0.4.1, llama-bench pp64 / tg32, tok/s, cool phone:
#
#     model                  prompt   generation
#     0.8b  Qwen3.5-0.8B      53        27
#     4b    Qwen3.5-4B         8.0       5.0
#
#
# CORES
#
# Four big cores (4-6, plus the prime core 7) and four little ones (0-3).
# tune.sh keeps core 0 for everything else, so this server gets cores 1-7, and
# taskset puts it there before its first instruction. Keep the two in step.
#
# Generation wants the big cores alone; prompts gain from the little ones too.
# llama-server splits the two: -t runs single-token steps, -tb runs batches.
# Hot phone (see HEAT), tok/s, prompt / generation:
#
#     threads      Qwen3.5-4B      Qwen3.5-0.8B
#     4            5.64 / 4.23     37.2 / 19.7      <- -t
#     5            5.86 / 3.99
#     6            6.14 / 4.08     33.3 / 13.9
#     7 (1-7)      6.49 / 4.06     39.7 / 12.9      <- -tb
#     8 (0-7)                       7.8 / 0.19
#
# The smaller the model, the more a slow little core costs a single-token
# step: seven threads take a third off the 0.8B's generation.
#
# Never let the thread count default. At llama-bench's default of 8 the eighth
# thread shares core 0 with the other services and the interrupts, and every
# step waits for it: a hundred times slower.
#
# Measured and changing nothing (within 1%): pinning to the big cores, with or
# without --cpu-strict; --poll 100; --prio 2 (the process already runs at
# nice -10, inherited from the Termux app, and SCHED_FIFO is refused).
#
#
# HEAT
#
# Samsung's overheat protection caps both big clusters at 1747 MHz (of 2419 and
# 2841) once the skin sensor nears 40 C: sys.siop.level 1 and up, Android
# thermal status 2+. A long run of prompts gets there on its own. The cap costs
# the 4B ~30% of its prompt speed and ~16% of its generation (8.0 / 5.0 cool,
# 5.6 / 4.2 capped). Neither the screen being on nor
# `cmd power set-fixed-performance-mode-enabled` moves it, and without root it
# cannot be lifted: it goes through /sys/power/cpufreq_max_limit, which even
# adb shell cannot read. A cooler phone lifts it -- out of the case, on a fan.
#
#
# GPU
#
# Slower at generation on every route. llama.cpp 0.4.1, Qwen3.5-4B, prompt /
# generation, cool phone unless marked:
#
#   OpenCL, llm-gpu.sh's setup      9.6 / 2.0, and still numerically wrong for
#                                   Qwen3.5 (loops, a leaked </think>)
#   Vulkan, Qualcomm's driver       segfaults as it starts, even at -ngl 0
#                                   (reachable only through a symlink to
#                                   /system/lib64/libvulkan.so; Termux's own
#                                   loader sees just llvmpipe)
#   Vulkan, Mesa Turnip             10.3 / 0.5 in llama-bench; llama-server
#                                   dies with vk::DeviceLostError
#   Turnip, weights on the CPU      8.4 / 3.2 hot, against 5.6 / 4.2 for the
#                                   CPU alone: prompts faster, generation not
#
# Splitting layers between the two lands in between, still slower than the CPU
# alone at generation. All the routes, and how to reach them, are in
# docs/OPERATIONS.md.
#
# Speculative decoding does not pay either. The 0.8B drafting for the 4B took
# generation from 4.2 to 1.5 tok/s (story, 30% accepted) and 2.4 (code, 76%
# accepted); ngram-simple changed nothing.
#
# --load-mode none keeps the weights in ordinary RAM; a memory-mapped model has
# its pages evicted by Android under pressure, which stalls generation. It is
# what --no-mmap did: llama.cpp 0.4.1 refuses --no-mmap outright ("invalid
# argument"), which is how the upgrade first stopped both servers from
# starting. Measured on the 0.8B: RssAnon 640 MB / RssFile 65 MB with
# `none`, 163 MB / 551 MB with `mmap`. mlock is out: Termux's RLIMIT_MEMLOCK
# is 64 MB.
#
#
# THINKING
#
# Everything below was measured on the 0.8B. The 4B runs with the same budget.
#
# This model does not reliably close its own thinking block. Left unbounded it
# enumerates alternatives forever -- "Option 12: Red, Blue, Green. (Wait, I
# need to make sure I don't repeat the same one). Option 13: ..." -- and the
# reply comes back with finish_reason=length and EMPTY content. Measured: 7 of
# 12 unbounded runs returned nothing at all.
#
# Counter-intuitively it is the TRIVIAL prompts that run away. "Name three
# colours" and "Write one sentence about rain" both looped to empty, while
# "What is 17 * 23?" terminated on its own in 331 tokens. The model loops when
# it has nothing to reason about. A smoke test built from arithmetic alone
# misses this bug completely.
#
# --reasoning-budget is what fixes it. It is a logit-forcing sampler, not a
# template feature, so it fires however thinking was turned on. Across 114
# runs with a budget set, empty content occurred zero times. Under adversarial
# probing -- a hostile "consider at least 25 alternatives" instruction, four
# languages, five-turn histories, an injected unclosed <think> block -- it
# terminated 14 times out of 14.
#
# --reasoning-budget-message is NOT cosmetic, and the two leading newlines are
# the active ingredient rather than the wording. The budget cuts mid-token: with
# a bare message one run was severed inside "6150" and another leaked a literal
# </think> into the answer. Newline-prefixed, 10 of 10 broke cleanly.
# POSIX sh has no $'...', so the newlines are built with printf below.
#
# Things that look like fixes and are not, all measured:
#
#   --reasoning-effort   A no-op for this model. /props reports
#                        chat_template_caps.supports_reasoning_effort=false;
#                        the template only reads enable_thinking.
#   -n / --n-predict     Does not register in this build (0.1.2-dev). Launched
#                        with -n 1024, /props still reports n_predict=-1. Not a
#                        backstop. -c is the only ceiling a client cannot raise.
#   --reasoning off      Not a safe default. The advertised escape hatch, a
#                        client sending chat_template_kwargs {enable_thinking:
#                        true}, reproduces the runaway completely unguarded.
#                        Off also answers 17*23 as 491; budgeted it answers 391.
#   Qwen's own published thinking-mode sampling (temp 1.0, top_p 0.95, top_k 20,
#                        presence_penalty 1.5) was the WORST config tested: 0/3,
#                        all empty. It stops the verbatim repetition and the
#                        model explores forever instead. It also broke
#                        arithmetic, 1/4 correct.
#   repeat-penalty / DRY Made it worse, 3/3 down to 1/3, and corrupted the
#                        working: "23 x 10 = 230, 23 x -7 ? No."
#
# So: stock sampling, unchanged. The budget is the whole fix.
#
# Sizing the budget. Left to terminate on its own this model uses 331 tokens
# for "17 * 23" and 402 for "12 * 15 + 37 * 4", so the budget has to clear ~400
# or it severs a derivation before the final step. Measured: at 192 the chain
# question answered "180" -- the first term alone, with both correct partials
# already sitting in the reasoning block -- and 123*456 came back 56228, a
# number appearing nowhere in its own working. 512 is the lowest value that
# clears the observed ceiling with headroom. Higher is not better: at 2048 the
# trivial prompts burn the whole budget and take ~2 minutes to say "red, blue,
# green", because this model only loops when it has nothing to reason about.
#
# CONTEXT
#
# 65536 for both, with the KV cache in q8_0. Quantising V needs flash
# attention, and on this CPU the pair is no slower than f16 without it -- a
# little faster -- at half the memory. Hot phone, prompt / generation:
#
#                      empty context     with context
#     0.8B f16         36.6 / 17.6       31.5 / 16.9   (2048 in)
#     0.8B q8_0 + fa   37.4 / 20.0       31.1 / 18.0
#     4B   f16          5.59 / 4.07       5.51 / 4.11  (512 in)
#     4B   q8_0 + fa    5.65 / 4.26       5.54 / 4.21
#     4B   q4_0 + fa    5.64 / 4.26       5.49 / 4.16
#
# At 64k the q8_0 cache is 0.40 GB for the 0.8B (6 attention layers) and
# 1.07 GB for the 4B (8); f16 would be twice that. q4_0 buys no speed.
#
# -c is also a safety limit, not just a capacity choice. A runaway can only
# ever be as long as the context, and -n is still no backstop on 0.4.1: with
# -n 777 a request for 2000 tokens got 1515. The reasoning budget below bounds
# the thinking, but not a looping answer, and at 64k such an answer could run
# for about an hour on the 0.8B and four on the 4B. A 131072 context once let
# a stuck 0.8B request run that hour before returning nothing.
MSG="$(printf '\n\nTime to answer.')"

MODEL=${1:-$(cat $HOME/.llm-model 2>/dev/null)}
MODEL=${MODEL:-0.8b}
case $MODEL in
  0.8b) FILE=Qwen3.5-0.8B-Q4_0.gguf CTX=65536 ;;
  4b) FILE=Qwen3.5-4B-Q4_0.gguf CTX=65536 ;;
  *) echo "llm.sh: no model called '$MODEL'" >&2; exit 1 ;;
esac

exec taskset -c 1-7 llama-server \
  -m $HOME/models/$FILE \
  -t 4 -tb 7 -c $CTX --parallel 1 -b 256 --load-mode none \
  -fa on -ctk q8_0 -ctv q8_0 \
  --reasoning on \
  --reasoning-budget 512 \
  --reasoning-budget-message "$MSG" \
  --host 0.0.0.0 --port 8081 \
  --metrics \
  --alias qwen3.5-$MODEL
