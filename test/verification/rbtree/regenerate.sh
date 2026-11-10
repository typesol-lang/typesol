#!/usr/bin/env bash
# Rebuild traces.jsonl.gz, the lib-sokoban 0.3.0 traces test/verification/rbtree-trace.test.ts replays, with the
# oracle in ./oracle (needs Rust; the test itself does not). Seeds 1–3; every shape (u64, bid, ask, mixed, trader:
# strides 32, 64, 64, 64, 144). Capacities 1, 2, 3 and 7 in random phases; 64 filled and drained three times and 512
# twice for each stride (the mixed shape, whose comparator is no order, in random phases); one 4096 trace (Phoenix's
# book size) filled to 800 and drained. Larger runs for a one-off check (a .jsonl or .jsonl.gz):
#   (cd oracle && cargo run --release -- /tmp/big.jsonl 1000 10 3400 u64,bid,ask,mixed,trader 1,2,3,7,64,512)
#   (cd oracle && cargo run --release -- /tmp/cycles.jsonl 1 5 0 u64,bid,ask,trader 512,4096 4)
#   RBTREE_TRACES=/tmp/big.jsonl pnpm vitest run test/verification/rbtree-trace.test.ts
# CARGO_TARGET_DIR is honoured (the build goes to ./oracle/target otherwise).
set -euo pipefail
cd "$(dirname "$0")/oracle"
cargo build --release --quiet
bin="${CARGO_TARGET_DIR:-target}/release/rbt-oracle"
tmp=$(mktemp -d)
"$bin" "$tmp/a.jsonl" 1 3 60 u64,bid,ask,mixed,trader 1,2,3,7
"$bin" "$tmp/b1.jsonl" 1 1 0 u64 64 3
"$bin" "$tmp/b2.jsonl" 2 1 0 bid,trader 64 3
"$bin" "$tmp/b3.jsonl" 3 1 0 ask 64 3
"$bin" "$tmp/b4.jsonl" 1 1 300 mixed 64
"$bin" "$tmp/c1.jsonl" 1 1 0 u64 512 2
"$bin" "$tmp/c2.jsonl" 2 1 0 bid 512 2
"$bin" "$tmp/c3.jsonl" 3 1 0 ask 512 2
"$bin" "$tmp/c4.jsonl" 1 1 0 trader 512 2
"$bin" "$tmp/c5.jsonl" 1 1 600 mixed 512
"$bin" "$tmp/d.jsonl" 3 1 0 bid 4096 1 800
cat "$tmp"/a.jsonl "$tmp"/b1.jsonl "$tmp"/b2.jsonl "$tmp"/b3.jsonl "$tmp"/b4.jsonl "$tmp"/c1.jsonl "$tmp"/c2.jsonl "$tmp"/c3.jsonl \
  "$tmp"/c4.jsonl "$tmp"/c5.jsonl "$tmp"/d.jsonl | gzip -9 -n > ../traces.jsonl.gz
rm -rf "$tmp"
echo "wrote test/verification/rbtree/traces.jsonl.gz"
