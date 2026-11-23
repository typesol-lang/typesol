#!/usr/bin/env bash
# Builds the reference binaries of the Percolator v16 port (showcase/mainnet/percolator-v16) from the author's
# sources, in Docker only, and places them in test/programs/ once each has the sha256 recorded below
# (test/programs/SOURCES.md). No v16 build is deployed anywhere that could serve as the reference, so the comparison
# target is this build of the pinned commits; it is not a deployed program.
#
#   scripts/percolator-v16-reference/build.sh
#
# Pinned (all Apache-2.0):
#   aeyakovenko/percolator-prog  7b11091328de23cded2e4afe96592bbd060a6828  (2026-11-15; default features, anchor-v2)
#   aeyakovenko/percolator       5e3af0710ec7e9b7077393012f8a94a31b2f07ef  (the engine, fixed by the program's Cargo.lock)
#   aeyakovenko/percolator-match 60aac3a996d0264c47fbefe9a2625d6ee6fb6a47  (2026-06-03, matcher ABI v3)
# and the program repository's two test matchers, tests/fixtures/auth_matcher and tests/fixtures/hostile_matcher.
#
# Each is built with `cargo-build-sbf --tools-version v1.52 -- --locked` in the image of ./Dockerfile (linux/amd64,
# emulated on arm64 hosts; about 4 minutes for the program on 2 CPUs). The container fetches the sources itself
# (HTTPS, public) and keeps only the cargo registry and git cache in two named volumes; nothing on the host is mounted
# but an empty output directory. Two clean builds of the program give the same bytes.
#
# Output (gitignored; test/programs/SOURCES.md has the rows):
#   test/programs/percolator_v16.so                  percolator_prog.so
#   test/programs/percolator_v16_match.so            percolator_match.so
#   test/programs/percolator_v16_auth_matcher.so     auth_matcher.so
#   test/programs/percolator_v16_hostile_matcher.so  hostile_matcher.so
# A binary whose sha256 differs is not copied, and the script exits 3.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEST="$ROOT/test/programs"

PROG_COMMIT=7b11091328de23cded2e4afe96592bbd060a6828
ENGINE_COMMIT=5e3af0710ec7e9b7077393012f8a94a31b2f07ef
MATCH_COMMIT=60aac3a996d0264c47fbefe9a2625d6ee6fb6a47

# <built file> <name in test/programs> <sha256>
EXPECTED=(
  "percolator_prog.so percolator_v16.so cc35fa4853bddd4e7f58c0e248c7c298ee152625d423ee6ed6b35c9fdfbe60b9"
  "percolator_match.so percolator_v16_match.so 15ca5d638e7911157ef075b60170c06d82ef2208f6565002cf6620315e6dc3ea"
  "auth_matcher.so percolator_v16_auth_matcher.so 50e532267926e180f013200c1799e26127dd23dc150866cffd491424629ddf93"
  "hostile_matcher.so percolator_v16_hostile_matcher.so e0c20fad34a7822cc6ce42a3c77ff08a8591977102f0c497a339d66a9dd6240a"
)

# The image, tagged with this Dockerfile's sha256 so that a changed recipe builds a new one.
DOCKERFILE_SHA="$(shasum -a 256 "$HERE/Dockerfile" | cut -c1-12)"
IMAGE="typesol-percolator-v16-reference:$DOCKERFILE_SHA"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  DOCKER_BUILDKIT=1 docker build --platform linux/amd64 -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
docker run --rm --platform linux/amd64 --cpus 2 --memory 6g \
  -v "$OUT:/out" \
  -v typesol-percolator-v16-cargo:/usr/local/cargo/registry \
  -v typesol-percolator-v16-cargo-git:/usr/local/cargo/git \
  -e PROG_COMMIT="$PROG_COMMIT" -e ENGINE_COMMIT="$ENGINE_COMMIT" -e MATCH_COMMIT="$MATCH_COMMIT" \
  "$IMAGE" bash -c '
    set -euo pipefail
    fetch() { # <repository> <commit> <dir>
      git init -q "$3"
      # A fetch over HTTPS can drop mid-transfer: three tries.
      for i in 1 2 3; do git -C "$3" fetch -q --depth 1 "https://github.com/$1" "$2" && break; sleep 15; done
      git -C "$3" checkout -q --detach FETCH_HEAD
      [[ "$(git -C "$3" rev-parse HEAD)" == "$2" ]]
    }
    fetch aeyakovenko/percolator-prog "$PROG_COMMIT" /src/percolator-prog
    fetch aeyakovenko/percolator-match "$MATCH_COMMIT" /src/percolator-match
    # The engine comes in through the program'"'"'s Cargo.lock, which must name the pinned commit.
    grep -q "^source = \"git+https://github.com/aeyakovenko/percolator?rev=$ENGINE_COMMIT#$ENGINE_COMMIT\"$" /src/percolator-prog/Cargo.lock
    # Each crate is built from a copy at /work/<name>, the paths the recorded hashes were built at.
    cp -r /src/percolator-prog /work/percolator-prog
    cp -r /src/percolator-prog/tests/fixtures/auth_matcher /work/auth_matcher
    cp -r /src/percolator-prog/tests/fixtures/hostile_matcher /work/hostile_matcher
    cp -r /src/percolator-match /work/percolator-match
    for d in percolator-prog auth_matcher hostile_matcher percolator-match; do
      echo "building $d"
      (cd /work/$d && cargo-build-sbf --tools-version v1.52 -- --locked >/out/build-$d.log 2>&1) || { tail -40 /out/build-$d.log; exit 1; }
      cp /work/$d/target/deploy/*.so /out/
    done
    cargo-build-sbf --version >/out/toolchain.txt
  '

bad=0
for row in "${EXPECTED[@]}"; do
  read -r built name want <<<"$row"
  got="$(shasum -a 256 "$OUT/$built" | cut -c1-64)"
  size="$(wc -c <"$OUT/$built" | tr -d ' ')"
  if [[ "$got" == "$want" ]]; then
    cp "$OUT/$built" "$DEST/$name"
    echo "$name: sha256 $got, $size bytes (as recorded)"
  else
    echo "$name: sha256 $got, $size bytes, not the recorded $want: not copied" >&2
    bad=1
  fi
done
cat "$OUT/toolchain.txt"
if [[ "$bad" == 1 ]]; then exit 3; fi
