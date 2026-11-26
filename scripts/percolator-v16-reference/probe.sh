#!/usr/bin/env bash
# Builds test/programs/percolator_v16_probe.so: a probe of the entrypoint Percolator v16 at commit 7b110913 (engine
# 5e3af07) is built with (pinocchio 0.11.1's `entrypoint!` in front of solana-program 1.18.26's AccountInfo, as
# percolator-prog's `mod entrypoint` puts them), from ./probe, in the image and with the toolchain of build.sh. It makes
# that entrypoint panic, run out of heap and fail RefCell borrows on demand, where the reference itself cannot be
# driven yet; showcase/test/percolator-v16-reference.test.ts and test/language/pinocchio-panics.test.ts run it.
#
#   scripts/percolator-v16-reference/probe.sh
#
# probe/Cargo.lock was resolved from percolator-prog 7b110913's own Cargo.lock (the versions the reference links), and
# the build uses it with --locked. The binary is copied only when its sha256 is the one recorded in
# test/programs/SOURCES.md (exit 3 otherwise). About 2 minutes on 2 emulated CPUs once the image exists.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WANT=4886c91aaf6ec9619961956833a56aa45774dd916addeef155e4bef0603eb830

DOCKERFILE_SHA="$(shasum -a 256 "$HERE/Dockerfile" | cut -c1-12)"
IMAGE="typesol-percolator-v16-reference:$DOCKERFILE_SHA"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  DOCKER_BUILDKIT=1 docker build --platform linux/amd64 -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
docker run --rm --platform linux/amd64 --cpus 2 --memory 6g \
  -v "$HERE/probe:/src:ro" -v "$OUT:/out" \
  -v typesol-percolator-v16-cargo:/usr/local/cargo/registry \
  -v typesol-percolator-v16-cargo-git:/usr/local/cargo/git \
  "$IMAGE" bash -c '
    set -euo pipefail
    mkdir -p /work/percolator_v16_probe && cp -r /src/Cargo.toml /src/Cargo.lock /src/src /work/percolator_v16_probe/
    cd /work/percolator_v16_probe
    cargo-build-sbf --tools-version v1.52 -- --locked >/out/build.log 2>&1 || { tail -40 /out/build.log; exit 1; }
    cp target/deploy/percolator_v16_probe.so /out/
  '
got="$(shasum -a 256 "$OUT/percolator_v16_probe.so" | cut -c1-64)"
size="$(wc -c <"$OUT/percolator_v16_probe.so" | tr -d ' ')"
if [[ "$got" != "$WANT" ]]; then
  echo "percolator_v16_probe.so: sha256 $got, $size bytes, not the recorded $WANT: not copied" >&2
  exit 3
fi
cp "$OUT/percolator_v16_probe.so" "$ROOT/test/programs/percolator_v16_probe.so"
echo "percolator_v16_probe.so: sha256 $got, $size bytes (as recorded)"
