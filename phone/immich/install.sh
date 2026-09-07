#!/data/data/com.termux/files/usr/bin/bash
# Immich, natively in Termux. No VM, no container, no root.
#
# Run this on the phone, in the directory holding immich.sh and the portable
# tarball that portable.sh produced on a machine with Docker:
#
#     bash install.sh [immich-portable-v3.1.0.tar.gz]
#
# It is safe to run again: every stage checks for its own result and skips.
#
# What the phone has to build for itself, and why:
#
#   * The server's native modules. sharp (libvips) and bcrypt are compiled
#     against Termux's bionic libc and Termux's libvips; the copies in the
#     official image are linked against glibc and will not load here. The
#     dependencies are installed and pruned the way the official Dockerfile
#     does it, with one change: SHARP_FORCE_GLOBAL_LIBVIPS on both steps,
#     because there is no prebuilt sharp for android-arm64 to fall back on.
#
#     The TypeScript itself is NOT compiled here. TypeScript 7 is a Go
#     binary per platform, none exists for android-arm64, and the linux one
#     is killed by seccomp (fanotify_init) at startup. The compiled JS comes
#     out of the official image in the tarball, like the web app.
#
#   * Three PostgreSQL extensions. Termux's postgresql package skips the
#     `cube` and `earthdistance` contribs, which Immich needs for map search,
#     so they are built from the matching PostgreSQL source with PGXS. The
#     vector index is pgvector rather than VectorChord: VectorChord is a Rust
#     pgrx extension, a multi-hour build on a phone, and Immich still accepts
#     pgvector when DB_VECTOR_EXTENSION says so.
#
# What it cannot build: the web app and the core plugin, which is why the
# tarball exists (see portable.sh). Machine learning is not attempted at all;
# onnxruntime has no bionic wheels. Point IMMICH_MACHINE_LEARNING_URL at a
# machine on the LAN running the official immich-machine-learning image, or
# leave it off: uploads, albums, sharing and the map all work without it.
#
# Stop the model servers before running this. The TypeScript build wants
# several gigabytes for a few minutes, and Android kills the biggest process
# rather than swapping.
set -euo pipefail

IMMICH_TAG="${IMMICH_TAG:-v3.1.0}"
PGVECTOR_TAG="${PGVECTOR_TAG:-v0.8.6}"
PNPM_VERSION="${PNPM_VERSION:-11.13.1}"

ROOT="$HOME/immich"
SRC="$ROOT/src"
APP="$ROOT/app/server"
BUILD="$ROOT/build"
DATA="$ROOT/data"
PGDATA="$ROOT/pg"
ENV_FILE="$ROOT/immich.env"
HERE="$(cd "$(dirname "$0")" && pwd)"
PORTABLE="${1:-}"
if [ -z "$PORTABLE" ]; then
  PORTABLE="$(ls -t "$HOME"/immich-portable-*.tar.gz "$HERE"/immich-portable-*.tar.gz 2>/dev/null | head -1 || true)"
fi

DB_PORT=5432
REDIS_PORT=6379
IMMICH_PORT=2283

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

mkdir -p "$ROOT" "$BUILD" "$DATA"

# ---------------------------------------------------------------- packages

say "packages"
# nodejs (current) and nodejs-lts conflict. Immich pins Node 24; whichever is
# already installed is kept if it is new enough, so AutoClaim keeps its runtime.
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$NODE_MAJOR" -ge 24 ] || die "node $(node -v) is too old for Immich; pkg install nodejs-lts"
  note "node $(node -v) already installed"
else
  pkg install -y nodejs-lts
fi
# ffmpeg's libplacebo is built against a newer libc++ than a phone that has
# not upgraded lately carries, and its post-install hook then fails with
# "CANNOT LINK EXECUTABLE ... __from_chars_floating_point", which leaves the
# package half-configured and aborts the whole install. Lifting libc++ alone
# fixes it without a full `pkg upgrade`, which would also touch the model
# servers' llama-cpp.
apt-get install -y --only-upgrade libc++ >/dev/null 2>&1 || true
pkg install -y postgresql valkey libvips ffmpeg exiftool perl \
               clang make python pkg-config git wget bison flex
dpkg --configure -a >/dev/null 2>&1 || true
ffmpeg -version >/dev/null 2>&1 || die "ffmpeg does not run; try: pkg upgrade libc++ && dpkg --configure -a"
note "postgresql $(pg_config --version | awk '{print $2}'), libvips $(pkg-config --modversion vips-cpp), ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"

if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm -v)" != "$PNPM_VERSION" ]; then
  npm install -g "pnpm@$PNPM_VERSION" >/dev/null
fi
note "pnpm $(pnpm -v)"

# -------------------------------------------------------------- extensions

say "postgresql extensions"
PGXS="$(pg_config --pgxs)"
[ -f "$PGXS" ] || die "pg_config --pgxs points at $PGXS, which is missing; the postgresql package should ship it"
EXTDIR="$(pg_config --sharedir)/extension"
PGVER="$(pg_config --version | awk '{print $2}')"

if [ -f "$EXTDIR/vector.control" ]; then
  note "pgvector already installed"
else
  note "building pgvector $PGVECTOR_TAG"
  rm -rf "$ROOT/pgvector-src"
  git clone -q --depth 1 --branch "$PGVECTOR_TAG" https://github.com/pgvector/pgvector.git "$ROOT/pgvector-src"
  # OPTFLAGS="" drops -march=native, which clang on Android does not accept.
  # SHLIB_LINK=-lm because bionic keeps the maths in a separate library and
  # PGXS does not add it: without this PostgreSQL loads vector.so and dies on
  # "cannot locate symbol acos".
  make -C "$ROOT/pgvector-src" -s OPTFLAGS="" SHLIB_LINK=-lm >/dev/null
  make -C "$ROOT/pgvector-src" -s OPTFLAGS="" SHLIB_LINK=-lm install >/dev/null
  rm -rf "$ROOT/pgvector-src"
fi

if [ -f "$EXTDIR/earthdistance.control" ] && [ -f "$EXTDIR/cube.control" ]; then
  note "cube and earthdistance already installed"
else
  note "building cube and earthdistance from postgresql $PGVER source"
  PGSRC="$ROOT/postgresql-$PGVER"
  if [ ! -d "$PGSRC/contrib/cube" ]; then
    wget -q -O "$ROOT/pg.tar.bz2" "https://ftp.postgresql.org/pub/source/v$PGVER/postgresql-$PGVER.tar.bz2"
    # only the two contribs; the full tree is 40 MB unpacked and not needed
    tar xjf "$ROOT/pg.tar.bz2" -C "$ROOT" --wildcards \
        "postgresql-$PGVER/contrib/cube" "postgresql-$PGVER/contrib/earthdistance"
    rm -f "$ROOT/pg.tar.bz2"
  fi
  # PostgreSQL 17+ tarballs no longer ship the generated parser, hence bison
  # and flex above. cube first: earthdistance is built on it.
  # BISON and FLEX are named on the command line because the installed
  # Makefile.global records whatever path Termux's build host had.
  for contrib in cube earthdistance; do
    make -C "$PGSRC/contrib/$contrib" -s USE_PGXS=1 BISON=bison FLEX=flex SHLIB_LINK=-lm >/dev/null
    make -C "$PGSRC/contrib/$contrib" -s USE_PGXS=1 BISON=bison FLEX=flex SHLIB_LINK=-lm install >/dev/null
  done
  rm -rf "$PGSRC"
fi
for ext in vector cube earthdistance; do
  [ -f "$EXTDIR/$ext.control" ] || die "$ext.control did not land in $EXTDIR"
done
note "vector, cube, earthdistance in $EXTDIR"

# ---------------------------------------------------------------- database

say "database"
# The password lives in immich.env once that is written, and in .dbpass from
# the moment the cluster exists: a failure between the two must not leave a
# cluster nobody can log in to.
if [ -f "$PGDATA/PG_VERSION" ]; then
  note "cluster exists at $PGDATA"
  DB_PASSWORD="$(sed -n 's/^DB_PASSWORD=//p' "$ENV_FILE" 2>/dev/null || true)"
  [ -n "$DB_PASSWORD" ] || DB_PASSWORD="$(cat "$ROOT/.dbpass" 2>/dev/null || true)"
else
  DB_PASSWORD="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  (umask 077; printf '%s\n' "$DB_PASSWORD" > "$ROOT/.dbpass")
  # Bionic has no locale data, so the collation is C; Immich does not care.
  initdb -D "$PGDATA" -U postgres -A scram-sha-256 --pwfile="$ROOT/.dbpass" \
         -E UTF8 --locale=C >/dev/null
  cat >> "$PGDATA/postgresql.conf" <<CONF

# --- termox: immich ---
listen_addresses = '127.0.0.1'
port = $DB_PORT
unix_socket_directories = '$PREFIX/tmp'
shared_buffers = 128MB
max_connections = 50
logging_collector = off
# Android 12+ counts an app's background processes and kills them past 32
# (the "phantom process killer"). Every PostgreSQL helper is one of those,
# so the ones this install does not need are switched off: the three I/O
# workers (PostgreSQL 18 defaults to io_method = worker) and the logical
# replication launcher.
io_method = sync
wal_level = minimal
max_wal_senders = 0
max_logical_replication_workers = 0
CONF
  note "initialised $PGDATA"
fi
[ -n "${DB_PASSWORD:-}" ] || die "cluster exists but no password in $ENV_FILE or $ROOT/.dbpass; remove $PGDATA if it is empty, or set DB_PASSWORD by hand"

PG_STARTED_HERE=0
if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  pg_ctl -D "$PGDATA" -l "$ROOT/pg.log" -w start >/dev/null
  PG_STARTED_HERE=1
fi
export PGPASSWORD="$DB_PASSWORD"
PSQL="psql -h 127.0.0.1 -p $DB_PORT -U postgres -v ON_ERROR_STOP=1 -q"
if ! $PSQL -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='immich'" | grep -q 1; then
  $PSQL -d postgres -c "CREATE DATABASE immich"
fi
# Immich creates these itself as a superuser; doing it here proves the builds
# above actually load before the server is ever started.
$PSQL -d immich -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS cube; CREATE EXTENSION IF NOT EXISTS earthdistance;"
note "database immich with $($PSQL -d immich -tAc "SELECT string_agg(extname||' '||extversion, ', ') FROM pg_extension WHERE extname IN ('vector','cube','earthdistance')")"
unset PGPASSWORD

# ---------------------------------------------------------------- portable

say "web app, plugin, geodata, compiled server"
if [ -n "$PORTABLE" ] && [ -f "$PORTABLE" ]; then
  note "unpacking $(basename "$PORTABLE")"
  tar xzf "$PORTABLE" -C "$BUILD"
  PORTABLE_TAG="$(cat "$BUILD/IMMICH_TAG" 2>/dev/null || echo '?')"
  [ "$PORTABLE_TAG" = "$IMMICH_TAG" ] || note "WARNING: tarball is $PORTABLE_TAG, server is $IMMICH_TAG"
fi
[ -f "$BUILD/server-dist/main.js" ] || die "no compiled server in $BUILD/server-dist; run portable.sh on a machine with Docker and pass the tarball"
[ -f "$BUILD/plugin-sdk-dist/index.js" ] || die "no plugin-sdk build in $BUILD/plugin-sdk-dist; the tarball is from an older portable.sh"

# ------------------------------------------------------------------ server

say "server $IMMICH_TAG"
BUILT_TAG="$(cat "$ROOT/.server-tag" 2>/dev/null || true)"
if [ "$BUILT_TAG" = "$IMMICH_TAG" ] && [ -f "$APP/dist/main.js" ]; then
  note "already built at $APP"
else
  if [ ! -d "$SRC/.git" ]; then
    git clone -q --depth 1 --branch "$IMMICH_TAG" https://github.com/immich-app/immich.git "$SRC"
  elif [ "$(git -C "$SRC" describe --tags --exact-match 2>/dev/null || true)" != "$IMMICH_TAG" ]; then
    git -C "$SRC" fetch -q --depth 1 origin "refs/tags/$IMMICH_TAG:refs/tags/$IMMICH_TAG"
    git -C "$SRC" checkout -q "$IMMICH_TAG"
  fi

  export CI=1
  # Both steps against Termux's libvips: there is no prebuilt sharp for
  # android-arm64, so the Dockerfile's IGNORE-then-FORCE dance has nowhere to go.
  export SHARP_FORCE_GLOBAL_LIBVIPS=true
  # node-gyp would otherwise download upstream headers; Termux ships its own,
  # patched for bionic, under $PREFIX/include/node.
  export npm_config_nodedir="$PREFIX"
  export NODE_OPTIONS="--max-old-space-size=3072"

  cd "$SRC"
  note "installing (this fetches a lot; a few minutes)"
  pnpm --filter @immich/plugin-sdk --filter immich install --frozen-lockfile
  note "placing the compiled server from the tarball"
  rm -rf "$SRC/server/dist" "$SRC/packages/plugin-sdk/dist"
  cp -r "$BUILD/server-dist" "$SRC/server/dist"
  cp -r "$BUILD/plugin-sdk-dist" "$SRC/packages/plugin-sdk/dist"
  note "deploying production tree to $APP"
  rm -rf "$APP"
  mkdir -p "$(dirname "$APP")"
  pnpm --filter immich --prod --no-optional deploy "$APP"
  cd "$ROOT"

  # The vendored exiftool is a Perl script with a /usr/bin/perl shebang.
  # termux-exec rewrites that on the fly, but not in every spawn path, so
  # point it at the real interpreter.
  find "$APP/node_modules" -path '*exiftool-vendored.pl/bin/exiftool' -type f \
       -exec sed -i "1s|^#!.*perl.*|#!$PREFIX/bin/perl|" {} +

  printf '%s\n' "$IMMICH_TAG" > "$ROOT/.server-tag"
fi

note "checking native modules"
( cd "$APP" && node -e '
  const sharp = require("sharp");
  const bcrypt = require("bcrypt");
  console.log("   sharp " + sharp.versions.sharp + " on libvips " + sharp.versions.vips
              + (sharp.format.heif.input.file ? ", heif ok" : ", NO heif")
              + (sharp.format.jxl && sharp.format.jxl.input.file ? ", jxl ok" : ""));
  console.log("   bcrypt " + (bcrypt.compareSync("x", bcrypt.hashSync("x", 4)) ? "ok" : "BROKEN"));
' ) || die "sharp or bcrypt failed to load; see the build output above"
EXIF="$(find "$APP/node_modules" -path '*exiftool-vendored.pl/bin/exiftool' -type f | head -1)"
[ -n "$EXIF" ] && note "exiftool $("$EXIF" -ver 2>/dev/null || echo 'DOES NOT RUN')"

# ---------------------------------------------------------- what landed

say "checking the build folder"
if [ ! -f "$BUILD/geodata/cities500.txt" ]; then
  note "no geodata in the tarball; downloading it"
  mkdir -p "$BUILD/geodata"
  G="https://download.geonames.org/export/dump"
  wget -q -O "$BUILD/geodata/cities500.zip" "$G/cities500.zip"
  (cd "$BUILD/geodata" && unzip -qo cities500.zip && rm cities500.zip)
  for f in admin1CodesASCII.txt admin2Codes.txt countryInfo.txt; do
    wget -q -O "$BUILD/geodata/$f" "$G/$f"
  done
  wget -q -O "$BUILD/geodata/ne_10m_admin_0_countries.geojson" \
       "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson"
  date --iso-8601=seconds | tr -d '\n' > "$BUILD/geodata/geodata-date.txt"
fi
[ -f "$BUILD/www/index.html" ] && note "web app present" \
  || note "WARNING: no web app at $BUILD/www -- the API will run but the browser gets a 404."
[ -f "$BUILD/plugins/immich-plugin-core/manifest.json" ] && note "core plugin present" \
  || note "WARNING: no core plugin; workflows will be unavailable (the server logs one warning and carries on)"

# ------------------------------------------------------------- environment

say "environment"
if [ -f "$ENV_FILE" ]; then
  note "$ENV_FILE exists; left alone"
else
  TZ_NAME="$(getprop persist.sys.timezone 2>/dev/null || echo UTC)"
  cat > "$ENV_FILE" <<ENV
# Immich on this phone. Read by ~/immich.sh; see docs/OPERATIONS.md.
IMMICH_ENV=production
NODE_ENV=production
IMMICH_HOST=0.0.0.0
IMMICH_PORT=$IMMICH_PORT
IMMICH_MEDIA_LOCATION=$DATA
IMMICH_BUILD_DATA=$BUILD
IMMICH_LOG_LEVEL=log
TZ=$TZ_NAME

DB_HOSTNAME=127.0.0.1
DB_PORT=$DB_PORT
DB_USERNAME=postgres
DB_PASSWORD=$DB_PASSWORD
DB_DATABASE_NAME=immich
# pgvector, not VectorChord: see install.sh. Remove only after installing vchord.
DB_VECTOR_EXTENSION=pgvector

REDIS_HOSTNAME=127.0.0.1
REDIS_PORT=$REDIS_PORT

# No machine learning on the phone. To get smart search and faces, run the
# official immich-machine-learning image somewhere on the LAN and point at it:
IMMICH_MACHINE_LEARNING_ENABLED=false
#IMMICH_MACHINE_LEARNING_URL=http://192.168.1.x:3003

# Prometheus is off unless IMMICH_TELEMETRY_INCLUDE is set, but its default
# ports are 8081 and 8082 -- the model servers. Moved so it can never collide.
IMMICH_API_METRICS_PORT=2284
IMMICH_MICROSERVICES_METRICS_PORT=2285
ENV
  chmod 600 "$ENV_FILE"
  note "wrote $ENV_FILE (timezone $TZ_NAME)"
fi

# The launcher may sit beside this script (scp'd into $HOME) or one level up
# (a checkout of the repo); either way it ends up at ~/immich.sh.
LAUNCHER=""
for candidate in "$HERE/../immich.sh" "$HERE/immich.sh"; do
  [ -f "$candidate" ] && { LAUNCHER="$candidate"; break; }
done
if [ -z "$LAUNCHER" ]; then
  note "copy phone/immich.sh to ~/immich.sh by hand"
elif [ "$(realpath "$LAUNCHER")" = "$(realpath "$HOME/immich.sh" 2>/dev/null || true)" ]; then
  chmod 700 "$HOME/immich.sh"
  note "launcher already at ~/immich.sh"
else
  install -m 700 "$LAUNCHER" "$HOME/immich.sh"
  note "launcher at ~/immich.sh"
fi

if [ "$PG_STARTED_HERE" = 1 ]; then
  pg_ctl -D "$PGDATA" -w stop >/dev/null
fi

say "done"
note "start it:      tmux new-session -d -s immich ~/immich.sh"
note "watch it:      tmux attach -t immich"
# The LAN address the way adguard.sh finds it: ask the routing table which
# source it would use, which needs no netlink and sends nothing.
LAN="$(python3 -c 'import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
try:
    s.connect(("192.0.2.1",9)); print(s.getsockname()[0])
except OSError: print("<phone-ip>")' 2>/dev/null || echo '<phone-ip>')"
note "open it:       http://$LAN:$IMMICH_PORT"
note "admin CLI:     cd ~/immich/app/server && node dist/main.js immich-admin"
