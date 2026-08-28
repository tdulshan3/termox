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
#
# THINKING
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
# -c 32768 is also a safety limit, not just a capacity choice. A runaway can
# only ever be as long as the context, and at 20-39 tok/s a 131072 context
# meant a stuck request generated for about an hour before returning nothing.
MSG="$(printf '\n\nTime to answer.')"

exec llama-server \
  -m $HOME/models/Qwen3.5-0.8B-Q4_0.gguf \
  -t 4 -c 32768 --parallel 1 -b 256 --no-mmap \
  --reasoning on \
  --reasoning-budget 512 \
  --reasoning-budget-message "$MSG" \
  --host 0.0.0.0 --port 8081 \
  --metrics \
  --alias qwen3.5-0.8b
