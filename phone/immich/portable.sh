#!/usr/bin/env bash
# The three pieces of Immich the phone cannot build, taken from the official
# image on a machine that has Docker.
#
#   www/       the web app: a static SvelteKit build, pure JS, portable
#   plugins/   the core workflow plugin, compiled to WebAssembly by extism-js,
#              which has no Android build -- this is the one that forces the
#              image route
#   geodata/   GeoNames and Natural Earth dumps for reverse geocoding, which
#              the phone could download itself but need not
#   server-dist/, plugin-sdk-dist/
#              the server compiled to JavaScript. TypeScript 7 is a Go binary
#              shipped per platform; there is none for android-arm64, and the
#              linux-arm64 one is killed by Android's seccomp filter on
#              fanotify_init before it runs a line, exactly as stock Go
#              binaries die on faccessat2. The output is plain JS, so it
#              travels; only the native modules have to be built in place.
#
# What stays on the phone: installing the server's dependencies, which is
# where sharp and bcrypt get compiled against Termux's libc and libvips (the
# image's copies are linked against glibc and will not load), and pruning
# that into the tree the launcher runs.
#
# The platform is pinned to amd64 on purpose: these three pieces are identical
# in every architecture's image, and the native one pulls fastest.
set -euo pipefail

TAG="${1:-v3.1.0}"
IMAGE="ghcr.io/immich-app/immich-server:${TAG}"
OUT="$(pwd)/immich-portable-${TAG}.tar.gz"

echo "pulling ${IMAGE}"
docker pull --platform linux/amd64 "${IMAGE}" >/dev/null

CID="$(docker create --platform linux/amd64 "${IMAGE}")"
TMP="$(mktemp -d)"
trap 'docker rm -f "${CID}" >/dev/null 2>&1; rm -rf "${TMP}"' EXIT

for piece in www plugins geodata; do
  echo "copying /build/${piece}"
  docker cp "${CID}:/build/${piece}" "${TMP}/${piece}"
done
echo "copying the compiled server"
docker cp "${CID}:/usr/src/app/server/dist" "${TMP}/server-dist"
# The workspace package the server depends on, as pnpm injected it: a real
# directory behind a symlink, hence -L.
docker cp -L "${CID}:/usr/src/app/server/node_modules/@immich/plugin-sdk/dist" "${TMP}/plugin-sdk-dist"
# Records the versions of libvips and friends the image was built with. The
# server reads it for its About page and copes without it, so it is optional.
docker cp "${CID}:/build/build-lock.json" "${TMP}/build-lock.json" 2>/dev/null || true

echo "${TAG}" > "${TMP}/IMMICH_TAG"
tar czf "${OUT}" -C "${TMP}" .

echo
echo "wrote ${OUT} ($(du -h "${OUT}" | cut -f1))"
echo "copy it to the phone, then run install.sh there:"
echo "  scp -P 8022 ${OUT} u0_a323@<phone-ip>:"
