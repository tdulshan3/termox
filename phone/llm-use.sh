#!/data/data/com.termux/files/usr/bin/sh
# Switch the CPU model server to another model.
#
#     llm-use           list the models, the selected one and what :8081 serves
#     llm-use 4b        switch to Qwen3.5-4B
#     llm-use 0.8b      switch back to Qwen3.5-0.8B
#
# One model at a time: the running server is stopped before the new one
# starts, so two models never share the CPU or the RAM. The choice is kept in
# ~/.llm-model, which llm.sh reads, so the panel's restart and a reboot both
# bring back the model picked here. The models themselves are listed in llm.sh.
#
# Installed as a command with:  ln -s ~/llm-use.sh $PREFIX/bin/llm-use
CHOICES=$(sed -n 's/^  \([a-z0-9.]*\)) FILE=.*/\1/p' $HOME/llm.sh | tr '\n' ' ')
SELECTED=$(cat $HOME/.llm-model 2>/dev/null || echo 0.8b)

serving() {
  curl -sf -m 3 http://127.0.0.1:8081/props |
    python3 -c 'import json, os, sys; print(os.path.basename(json.load(sys.stdin).get("model_path", "?")))' 2>/dev/null
}

# Found by name, then port: `pgrep -f` would also match any command line that
# merely mentions the server, a shell running this very search included.
server_pid() {
  for p in $(pgrep -x llama-server); do
    case " $(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null) " in
      *" --port 8081 "*) echo "$p"; return ;;
    esac
  done
}

if [ -z "$1" ]; then
  echo "models:   $CHOICES"
  echo "selected: $SELECTED"
  echo "serving:  $(serving || echo 'nothing on :8081')"
  exit 0
fi

case " $CHOICES " in
  *" $1 "*) ;;
  *) echo "llm-use: no model called '$1' (choices: $CHOICES)" >&2; exit 1 ;;
esac

echo "$1" > $HOME/.llm-model

pid=$(server_pid)
if [ -n "$pid" ]; then
  printf 'stopping %s' "$(serving || echo 'the current model')"
  kill "$pid"
  i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do
    printf .; sleep 1; i=$((i + 1))
  done
  echo
fi
# "=llm", never "llm": a tmux target with no exact match falls back to a
# prefix match, and the session is usually gone by now (it ends with its
# server), so a bare "llm" would kill `llmgpu`, the GPU server.
tmux kill-session -t =llm 2>/dev/null
tmux new-session -d -s llm $HOME/llm.sh

printf 'loading %s' "$1"
i=0
until curl -sf -m 3 http://127.0.0.1:8081/health > /dev/null; do
  i=$((i + 1))
  if [ $i -gt 180 ] || ! tmux has-session -t =llm 2>/dev/null; then
    echo
    echo "llm-use: :8081 is not answering; look with: tmux attach -t llm" >&2
    exit 1
  fi
  printf .; sleep 1
done
echo
echo "serving:  $(serving)"
