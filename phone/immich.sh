#!/data/data/com.termux/files/usr/bin/sh
# Start Immich natively in Termux. Built and configured by phone/immich/install.sh.
#
# One tmux session, three processes. PostgreSQL and Valkey are brought up here
# if they are not already, and left running when Immich stops: they are small,
# they hold the library, and the panel's stop button is aimed at the server.
#
# The server sets its own process title, so it shows up in /proc as `immich`
# with the API worker it forks as `immich-api`; that, not the node path, is
# what termox looks for.
ROOT="$HOME/immich"
ENV_FILE="$ROOT/immich.env"

[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE; run phone/immich/install.sh first"; exit 1; }
set -a
. "$ENV_FILE"
set +a
: "${DB_PORT:=5432}" "${REDIS_PORT:=6379}"

if ! pg_ctl -D "$ROOT/pg" status >/dev/null 2>&1; then
  echo "starting postgresql"
  pg_ctl -D "$ROOT/pg" -l "$ROOT/pg.log" -w start || { tail -20 "$ROOT/pg.log"; exit 1; }
fi

if ! valkey-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  echo "starting valkey"
  mkdir -p "$ROOT/valkey"
  # No snapshots, no append log, and the ARM64 fork check switched off. This
  # phone's kernel has the MADV_FREE-after-fork bug that Valkey tests for at
  # start, and the test only comes back positive while the kernel is
  # reclaiming memory -- which is precisely when a backup upload is running,
  # so Valkey started fine on a quiet phone and refused every restart after.
  # The bug can only corrupt a forked child, and with nothing to persist
  # Valkey never forks. Immich's queue state is expendable: jobs re-queue.
  valkey-server --bind 127.0.0.1 --port "$REDIS_PORT" --daemonize yes \
                --dir "$ROOT/valkey" --logfile "$ROOT/valkey.log" \
                --save "" --appendonly no \
                --ignore-warnings ARM64-COW-BUG || exit 1
  # --daemonize returns before the server has decided whether to live, so
  # ask it; a queue that is not there would otherwise surface as Immich
  # hanging on its first job with nothing in this log to say why.
  tries=0
  until valkey-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 20 ]; then
      echo "valkey did not come up; its log ends with:"
      tail -5 "$ROOT/valkey.log"
      exit 1
    fi
    sleep 0.5
  done
fi

echo "immich on $IMMICH_HOST:$IMMICH_PORT | media $IMMICH_MEDIA_LOCATION | db 127.0.0.1:$DB_PORT | queue 127.0.0.1:$REDIS_PORT"
cd "$ROOT/app/server" || exit 1
# Capped so a thumbnail storm cannot grow the heap until Android kills the
# whole phone's worth of background work. Immich idles around 400 MB.
exec node --max-old-space-size=2048 dist/main.js
