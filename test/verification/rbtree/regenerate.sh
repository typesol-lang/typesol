#!/usr/bin/env bash
# Rebuild traces.jsonl.gz, the lib-sokoban 0.3.0 traces test/verification/rbtree-trace.test.ts replays (7,320
# operations), with the oracle in ./oracle (needs Rust; the test itself does not). Larger runs for a one-off check
# (a .jsonl or .jsonl.gz):
#   (cd oracle && cargo run --release -- /tmp/big.jsonl 1000 10 3400 u64,bid,ask,mixed,trader 1,2,3,7,64,512)
#   RBTREE_TRACES=/tmp/big.jsonl pnpm vitest run test/verification/rbtree-trace.test.ts
set -euo pipefail
cd "$(dirname "$0")/oracle"
cargo build --release --quiet
bin=target/release/rbt-oracle
tmp=$(mktemp -d)
"$bin" "$tmp/a.jsonl" 1 1 120 u64,bid,ask,trader 1,2,3,7
"$bin" "$tmp/b.jsonl" 1 1 300 u64,bid,ask,trader 64
"$bin" "$tmp/c.jsonl" 1 1 1800 u64,bid 512
"$bin" "$tmp/d.jsonl" 1 1 300 ask,trader 512
cat "$tmp"/a.jsonl "$tmp"/b.jsonl "$tmp"/c.jsonl "$tmp"/d.jsonl | gzip -9 -n > ../traces.jsonl.gz
rm -rf "$tmp"
echo "wrote test/verification/rbtree/traces.jsonl.gz"
