#!/usr/bin/env bash
# Runs the Percolator author's own LiteSVM test suite (aeyakovenko/percolator-prog 06f86fb, Apache-2.0) against the
# mainnet binary of v12.20 and against the TypeSOL port, and compares the outcomes test by test
# (showcase/mainnet/percolator/README.md, "The author's test suite").
#
#   scripts/percolator-author-suite.sh <dir> [original|port|both]
#
# <dir> holds three checkouts side by side, as the suite's path dependencies expect:
#   <dir>/percolator-prog   aeyakovenko/percolator-prog  06f86fb125525af81c0bfd19a295095dda102c07
#   <dir>/percolator        aeyakovenko/percolator       3f55f871a3aa29d7b582fc2641d2106cbac0c32e
#   <dir>/percolator-match  aeyakovenko/percolator-match 199b1396ad154c6c6a2ea73938785e728d7ac376
# This script downloads and installs nothing: fetch the crates first (`cargo fetch --locked` in percolator-prog; the
# tests then build offline), fetch the mainnet binary (scripts/fetch-programs.sh), and build the compiler (`pnpm build`).
# Only host builds run (`cargo test`, two jobs); nothing is built for SBF. The matcher TradeCpi calls is the TypeSOL
# matcher fixture (showcase/mainnet/percolator/matcher), under both programs. Outcomes go to <dir>/results-<label>/.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$(cd "${1:?usage: $0 <dir> [original|port|both]}" && pwd)"
WHICH="${2:-both}"
PROG="$DIR/percolator-prog"
ORIGINAL="$ROOT/test/programs/percolator_v12.so"
ORIGINAL_SHA=502088e9cf5e1b38cccd31bbab2df18d4958712fb9456d48669241aaddf4cc93
TESTS="i128_alignment unit test_admin test_oracle test_risk_buffer test_conservation test_insurance test_resolution test_basic test_tradecpi test_security cu_benchmark"

check_commit() {
  local got
  got="$(git -C "$DIR/$1" rev-parse HEAD 2>/dev/null || true)"
  [[ "$got" == "$2" ]] || { echo "$DIR/$1 is at '${got:-not a git checkout}', not $2" >&2; exit 1; }
}
check_commit percolator-prog 06f86fb125525af81c0bfd19a295095dda102c07
check_commit percolator 3f55f871a3aa29d7b582fc2641d2106cbac0c32e
check_commit percolator-match 199b1396ad154c6c6a2ea73938785e728d7ac376
[[ -f "$ROOT/dist/cli.js" ]] || { echo "build the compiler first: pnpm build" >&2; exit 1; }
[[ "$(shasum -a 256 "$ORIGINAL" 2>/dev/null | cut -d' ' -f1)" == "$ORIGINAL_SHA" ]] ||
  { echo "$ORIGINAL missing or not the mainnet build: scripts/fetch-programs.sh mainnet-beta" >&2; exit 1; }

BIN="$(mktemp -d)"
trap 'rm -rf "$BIN"' EXIT
node "$ROOT/dist/cli.js" build "$ROOT/showcase/mainnet/percolator/matcher/matcher.ts" --out "$BIN/matcher" >/dev/null
mkdir -p "$DIR/percolator-match/target/deploy" "$PROG/target/deploy"
cp "$BIN/matcher/matcher.so" "$DIR/percolator-match/target/deploy/percolator_match.so"

run() { # <label> <program .so>
  local out="$DIR/results-$1"
  rm -rf "$out" && mkdir -p "$out"
  cp "$2" "$PROG/target/deploy/percolator_prog.so"
  shasum -a 256 "$PROG/target/deploy/percolator_prog.so" "$DIR/percolator-match/target/deploy/percolator_match.so" >"$out/binaries.txt"
  for t in $TESTS; do
    (cd "$PROG" && cargo test --locked --offline -j 2 --test "$t" -- --test-threads=2 >"$out/$t.log" 2>&1) || true
    echo "$1 $t: $(grep '^test result' "$out/$t.log" || echo 'did not run (see the log)')"
  done
  (cd "$PROG" && cargo test --locked --offline -j 2 --lib -- --test-threads=2 >"$out/lib.log" 2>&1) || true
  echo "$1 lib: $(grep '^test result' "$out/lib.log" || echo 'did not run (see the log)')"
  grep -hE '^test .* \.\.\. ' "$out"/*.log | sort >"$out/outcomes.txt"
}

if [[ "$WHICH" == original || "$WHICH" == both ]]; then run original "$ORIGINAL"; fi
if [[ "$WHICH" == port || "$WHICH" == both ]]; then
  node "$ROOT/dist/cli.js" build "$ROOT/showcase/mainnet/percolator/percolator.ts" --out "$BIN/port" >/dev/null
  run port "$BIN/port/percolator.so"
fi
if [[ "$WHICH" == both ]]; then
  if diff "$DIR/results-original/outcomes.txt" "$DIR/results-port/outcomes.txt"; then
    echo "every test has the same outcome under both ($(grep -c ' ok$' "$DIR/results-port/outcomes.txt") passed)"
  else
    echo "the outcomes differ (above: < original, > port)"
    exit 1
  fi
fi
