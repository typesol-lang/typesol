#!/usr/bin/env bash
# Runs the author's own test suite of Percolator v16 (aeyakovenko/percolator-prog 7b110913, Apache-2.0: the six cargo
# test targets under tests/, LiteSVM 0.1) against a program binary, in Docker only, one target at a time, and records
# per target the tests run, passed, failed and ignored and the time taken
# (showcase/mainnet/percolator-v16/TESTING.md).
#
#   scripts/percolator-v16-reference/author-suite.sh <program.so> <results-dir> [target ...]
#
# <program.so> is the binary under test: the reference test/programs/percolator_v16.so (build.sh) or a build of the
# port. Every target loads the program through one of two `program_path()` functions (tests/v16_cu.rs and
# tests/support/v16_svm.rs), both of which take the path in PERCOLATOR_FUZZ_SBF first; the script sets it. The three
# matcher binaries come from test/programs (build.sh), placed where the tests look for them; SPL Token comes from
# LiteSVM's own crate.
#
# Targets (default: all six, smallest first): listing_oracle_scope anchor_v2_realloc_probe open_issue_regressions
# v16_program_fuzz_regressions v16_program_stateful_fuzz v16_cu. Each target is compiled first (`cargo test --no-run`,
# not timed), then run with `--test-threads=2` under a time limit, TARGET_TIMEOUT seconds (default 2400); a target
# that reaches it is stopped and recorded with the tests it finished; TEST_FILTER (libtest name filters) runs a subset.
# TRACE=1 records every transaction each test sends (scripts/percolator-v16-reference/trace/send_transaction.rs, spliced
# into the LiteSVM 0.1.0 the tests use) in <results-dir>/trace/<test>.trace, and makes the runs repeatable: the keys a
# test makes (trace/keypair_new.rs and trace/pubkey_new_unique.rs, spliced into solana-sdk and solana-program 1.18.26)
# and proptest's seed (PROPTEST_RNG_SEED, default 1) are the same in every run, so that two binaries get the same
# transactions; the three crates come in through [patch.crates-io] entries (Cargo.lock gains those path sources, so
# the build is not --locked, and lints are capped at warnings for them as for registry crates).
# author-trace-compare.ts compares two such directories transaction by transaction. PROBES=1 (with TRACE=1 and a probed
# port from `coverage.ts --build`) also records the port's branch probes each transaction reached.
#
# The exit status is 1 when a target does not compile, stops at its time limit, runs no test, or (TRACE=1) records no
# transaction; and, unless EXPLORE=1, when the failures differ from author-suite-expected.tsv for this binary: the
# binary is "reference" when its sha256 is the reference's (test/programs/SOURCES.md), "port" otherwise; a failure not
# listed for it, a listed failure that passed, and (unfiltered) a listed failure that did not run or a target whose
# test count differs from the listed one all fail the run. EXPLORE=1 only reports.
# The container (`rust:1.89-slim-bookworm`, the host's architecture, 2 CPUs) fetches the pinned sources itself; the cargo registry and the build directory are named
# volumes shared with layout.ts. Results: <results-dir>/<target>.log and <results-dir>/summary.tsv.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SO="$(cd "$(dirname "${1:?usage: $0 <program.so> <results-dir> [target ...]}")" && pwd)/$(basename "$1")"
mkdir -p "${2:?usage: $0 <program.so> <results-dir> [target ...]}"
OUT="$(cd "$2" && pwd)"
shift 2
TARGETS="${*:-listing_oracle_scope anchor_v2_realloc_probe open_issue_regressions v16_program_fuzz_regressions v16_program_stateful_fuzz v16_cu}"
TARGET_TIMEOUT="${TARGET_TIMEOUT:-2400}"
# TEST_FILTER: libtest name filters (space-separated substrings) applied to every target; empty runs every test.
TEST_FILTER="${TEST_FILTER:-}"
TRACE="${TRACE:-}"
PROBES="${PROBES:-}"
EXPLORE="${EXPLORE:-}"
EXPECT="${EXPECT:-$HERE/author-suite-expected.tsv}"
REFERENCE_SHA256=cc35fa4853bddd4e7f58c0e248c7c298ee152625d423ee6ed6b35c9fdfbe60b9
PROPTEST_RNG_SEED="${PROPTEST_RNG_SEED:-1}"
TARGET_VOLUME=typesol-percolator-v16-host-target
TRACE_ENV=()
if [[ -n "$TRACE" ]]; then
  mkdir -p "$OUT/trace"
  TARGET_VOLUME=typesol-percolator-v16-trace-target
  TRACE_ENV=(-e TRACE=1 -e RUSTFLAGS=--cap-lints=warn -e PERCOLATOR_TRACE_DIR=/results/trace -e PROPTEST_RNG_SEED="$PROPTEST_RNG_SEED" -v "$HERE/trace:/trace:ro")
  [[ -z "$PROBES" ]] || TRACE_ENV+=(-e PERCOLATOR_TRACE_PROBES=1)
  if [[ -n "$(ls -A "$OUT/trace")" ]]; then echo "$OUT/trace is not empty: traces are appended, use a new results directory" >&2; exit 1; fi
elif [[ -n "$PROBES" ]]; then
  echo "PROBES=1 needs TRACE=1" >&2; exit 1
fi
PROG_COMMIT=7b11091328de23cded2e4afe96592bbd060a6828
ENGINE_COMMIT=5e3af0710ec7e9b7077393012f8a94a31b2f07ef
RUST_IMAGE=rust:1.89-slim-bookworm@sha256:d7fc7de78bb8c1469933aeecbf801314d30d7d6e9f0578bba4cfa285bfa37fe6

for m in percolator_v16_match percolator_v16_auth_matcher percolator_v16_hostile_matcher; do
  [[ -f "$ROOT/test/programs/$m.so" ]] || { echo "test/programs/$m.so missing: run scripts/percolator-v16-reference/build.sh" >&2; exit 1; }
done
[[ -f "$SO" ]] || { echo "$SO missing" >&2; exit 1; }
[[ -f "$EXPECT" ]] || { echo "$EXPECT missing" >&2; exit 1; }
if [[ "$(shasum -a 256 "$SO" | cut -d" " -f1)" == "$REFERENCE_SHA256" ]]; then ROLE=reference; else ROLE=port; fi
echo "binary under test: $SO ($ROLE)"

docker run --rm --cpus 2 --memory 6g \
  -v "$SO:/so/percolator_prog.so:ro" \
  -v "$ROOT/test/programs/percolator_v16_match.so:/matchers/percolator_match.so:ro" \
  -v "$ROOT/test/programs/percolator_v16_auth_matcher.so:/matchers/auth_matcher.so:ro" \
  -v "$ROOT/test/programs/percolator_v16_hostile_matcher.so:/matchers/hostile_matcher.so:ro" \
  -v "$OUT:/results" \
  -v typesol-percolator-v16-host-cargo:/usr/local/cargo/registry \
  -v typesol-percolator-v16-host-cargo-git:/usr/local/cargo/git \
  -v "$TARGET_VOLUME:/work/target" ${TRACE_ENV[@]+"${TRACE_ENV[@]}"} \
  -e CARGO_TARGET_DIR=/work/target -e CARGO_NET_GIT_FETCH_WITH_CLI=true \
  -e PERCOLATOR_FUZZ_SBF=/so/percolator_prog.so \
  -e PROG_COMMIT="$PROG_COMMIT" -e ENGINE_COMMIT="$ENGINE_COMMIT" -e TARGETS="$TARGETS" -e TARGET_TIMEOUT="$TARGET_TIMEOUT" -e TEST_FILTER="$TEST_FILTER" \
  "$RUST_IMAGE" bash -c '
    set -euo pipefail
    apt-get update -qq && apt-get install -y -qq --no-install-recommends pkg-config libssl-dev libudev-dev git >/dev/null
    git init -q /work/percolator-prog && cd /work/percolator-prog
    # A fetch over HTTPS can drop mid-transfer: three tries.
    for i in 1 2 3; do git fetch -q --depth 1 https://github.com/aeyakovenko/percolator-prog "$PROG_COMMIT" && break; sleep 15; done
    git checkout -q --detach FETCH_HEAD
    [[ "$(git rev-parse HEAD)" == "$PROG_COMMIT" ]]
    grep -q "percolator?rev=$ENGINE_COMMIT#$ENGINE_COMMIT" Cargo.lock
    LOCKED=--locked
    if [[ -n "${TRACE:-}" ]]; then
      cargo fetch --locked -q
      cp -r /usr/local/cargo/registry/src/*/litesvm-0.1.0 /work/litesvm-traced
      rm -f /work/litesvm-traced/rust-toolchain.toml
      perl -0pi -e '"'"'BEGIN { local $/; open my $f, "<", "/trace/send_transaction.rs" or die; $r = <$f> } s/    pub fn send_transaction\(&mut self, tx: impl Into<VersionedTransaction>\) -> TransactionResult \{\n        let vtx: VersionedTransaction = tx.into\(\);\n/$r/'"'"' /work/litesvm-traced/src/lib.rs
      grep -q send_transaction_untraced /work/litesvm-traced/src/lib.rs
      # Keys made the same in every run of a test: Keypair::new and Pubkey::new_unique, per test thread.
      cp -r /usr/local/cargo/registry/src/*/solana-sdk-1.18.26 /work/solana-sdk-traced
      cp -r /usr/local/cargo/registry/src/*/solana-program-1.18.26 /work/solana-program-traced
      perl -0pi -e '"'"'BEGIN { local $/; open my $f, "<", "/trace/keypair_new.rs" or die; $r = <$f> } s/    pub fn new\(\) -> Self \{\n        let mut rng = OsRng;\n        Self::generate\(&mut rng\)\n    \}\n/$r/'"'"' /work/solana-sdk-traced/src/signer/keypair.rs
      grep -q "thread_local! { static MADE" /work/solana-sdk-traced/src/signer/keypair.rs
      perl -0pi -e '"'"'BEGIN { local $/; open my $f, "<", "/trace/pubkey_new_unique.rs" or die; $r = <$f> } s/    pub fn new_unique\(\) -> Self \{\n.*?        Self::from\(b\)\n    \}\n/$r/s'"'"' /work/solana-program-traced/src/pubkey.rs
      grep -q "thread_local! { static NEXT" /work/solana-program-traced/src/pubkey.rs
      printf "\n[patch.crates-io]\nlitesvm = { path = \"/work/litesvm-traced\" }\nsolana-sdk = { path = \"/work/solana-sdk-traced\" }\nsolana-program = { path = \"/work/solana-program-traced\" }\n" >>Cargo.toml
      LOCKED=
    fi
    # The matchers where the tests look for them: ../percolator-match/target/deploy and tests/fixtures/*/target/deploy.
    mkdir -p /work/percolator-match/target/deploy tests/fixtures/auth_matcher/target/deploy tests/fixtures/hostile_matcher/target/deploy
    cp /matchers/percolator_match.so /work/percolator-match/target/deploy/
    cp /matchers/auth_matcher.so tests/fixtures/auth_matcher/target/deploy/
    cp /matchers/hostile_matcher.so tests/fixtures/hostile_matcher/target/deploy/
    sha256sum /so/percolator_prog.so /matchers/*.so | tee /results/binaries.txt
    printf "target\tcompiled\tstatus\tseconds\ttests\tpassed\tfailed\tignored\n" >/results/summary.tsv
    for t in $TARGETS; do
      if ! cargo test $LOCKED -j 2 --test "$t" --no-run >/results/$t.build.log 2>&1; then
        printf "%s\tno\t-\t-\t-\t-\t-\t-\n" "$t" >>/results/summary.tsv; echo "$t: did not compile"; continue
      fi
      start=$(date +%s); status=complete
      timeout --signal=INT --kill-after=30 "$TARGET_TIMEOUT" cargo test $LOCKED -j 2 --test "$t" -- $TEST_FILTER --test-threads=2 >/results/$t.log 2>&1 || {
        code=$?; if [[ $code == 124 || $code == 137 ]]; then status=timeout; else status=exit-$code; fi; }
      secs=$(( $(date +%s) - start ))
      passed=$(grep -cE "^test .* \.\.\. ok$" /results/$t.log || true)
      failed=$(grep -cE "^test .* \.\.\. FAILED$" /results/$t.log || true)
      ignored=$(grep -cE "^test .* \.\.\. ignored" /results/$t.log || true)
      printf "%s\tyes\t%s\t%s\t%s\t%s\t%s\t%s\n" "$t" "$status" "$secs" "$((passed + failed + ignored))" "$passed" "$failed" "$ignored" >>/results/summary.tsv
      echo "$t: $status after ${secs}s, $passed passed, $failed failed, $ignored ignored ($(grep "^test result" /results/$t.log | tail -1 || true))"
    done
  '
column -t -s "$(printf '\t')" "$OUT/summary.tsv"

# The checks. Every target asked for must have compiled, finished within its limit and run at least one test.
problems=()
for t in $TARGETS; do
  row="$(awk -F'\t' -v t="$t" '$1 == t' "$OUT/summary.tsv")"
  [[ -n "$row" ]] || { problems+=("$t: no result"); continue; }
  IFS=$'\t' read -r _ compiled status _ tests passed failed _ <<<"$row"
  [[ "$compiled" == yes ]] || { problems+=("$t: did not compile ($t.build.log)"); continue; }
  [[ "$status" != timeout ]] || problems+=("$t: stopped at TARGET_TIMEOUT")
  [[ "$tests" != 0 ]] || problems+=("$t: ran no test")
  if [[ -z "$EXPLORE" ]]; then
    listed="$(awk -F'\t' -v t="$t" '$1 == "count" && $3 == t { print $4 }' "$EXPECT")"
    [[ -n "$TEST_FILTER" || -z "$listed" || "$tests" == "$listed" ]] || problems+=("$t: $tests tests, $listed listed")
    # Failures against the listed ones for this binary ("both" or its role).
    expected="$(awk -F'\t' -v t="$t" -v r="$ROLE" '$1 == "fail" && $3 == t && ($2 == "both" || $2 == r) { print $4 }' "$EXPECT" | sort)"
    got="$(sed -nE 's/^test (.*) \.\.\. FAILED$/\1/p' "$OUT/$t.log" | sort)"
    ok="$(sed -nE 's/^test (.*) \.\.\. ok$/\1/p' "$OUT/$t.log" | sort)"
    while IFS= read -r name; do
      [[ -n "$name" ]] || continue
      grep -qxF -- "$name" <<<"$expected" || problems+=("$t: unexpected failure: $name")
    done <<<"$got"
    while IFS= read -r name; do
      [[ -n "$name" ]] || continue
      if grep -qxF -- "$name" <<<"$ok"; then problems+=("$t: listed failure passed: $name")
      elif ! grep -qxF -- "$name" <<<"$got" && [[ -z "$TEST_FILTER" ]]; then problems+=("$t: listed failure did not run: $name"); fi
    done <<<"$expected"
  fi
done
if [[ -n "$TRACE" ]]; then
  traces="$(find "$OUT/trace" -name '*.trace' -size +0 | wc -l | tr -d ' ')"
  [[ "$traces" != 0 ]] || problems+=("TRACE=1 recorded no transaction")
  echo "traces: $traces files in $OUT/trace"
fi
if (( ${#problems[@]} > 0 )); then
  printf 'FAIL: %s\n' "${problems[@]}" >&2
  exit 1
fi
echo "author's suite ($ROLE): as expected${EXPLORE:+ (EXPLORE=1: failures not checked)}"
