#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
sshd
sleep 15
tmux new-session -d -s adguard ~/adguard.sh
tmux new-session -d -s scope "cd ~/termox && python3 -m termox"
tmux new-session -d -s llm ~/llm.sh
tmux new-session -d -s llmgpu ~/llm-gpu.sh
(sleep 30; ~/tune.sh) >/dev/null 2>&1 &
