# How TypeSOL is tested

Besides unit tests, these checks run the compiled programs (LiteSVM) against an independent oracle. Every randomized
run prints its seed; reproduce with `FUZZ_SEED=<n>`, widen with `FUZZ_RUNS` / `FUZZ_STEPS` (`pnpm fuzz` runs them wide).

| Check | Oracle | What must hold |
| --- | --- | --- |
| `test/verification/fuzz-arith.test.ts` | BigInt | `+ - * / % **`, `& \| ^ << >> ~`, unary minus, comparisons and casts at every width u8…u128 / i8…i128, plus `mulDiv`, `mulDivCeil`, `isqrt`, `min`, `max`, return the same value or abort with the same code (5100/5101/4102), for edge and random inputs |
| `test/verification/fuzz-u256.test.ts` | BigInt | every `u256` operator, `mulDiv` / `mulDivCeil` with their 512-bit product, comparisons and the checked narrowing casts, on random values: the same value or the same error (5100, 5101, 4102) |
| `showcase/test/fuzz-i80f48.test.ts` | vectors the `fixed` crate (1.28.0) wrote, from `showcase/test/fixtures/marginfi/i80f48-oracle` | Marginfi's I80F48 (`showcase/mainnet/marginfi/i80f48.ts`): a BigInt model must give every vector, then the port must give the model's answer on them and on random values (products toward −∞, quotients toward zero, f64 to nearest-even) |
| `test/verification/fuzz-state.test.ts` | TypeScript state model | random honest + hostile actions on vault and escrow: every outcome as predicted, balances equal the model, SOL conserved up to fees, token supply exactly conserved; random filings/decisions/resets on ledgerbook: Vec contents, account size and rent exemption equal the model |
| `test/verification/fuzz-layout.test.ts` | TypeScript model | random pushes, pops, sets, in-place additions, moves and clears on an account with two growable Vecs (honest, out of range and by a stranger): the decoded account equals the model after every step; random `loadAccountMut` index pairs over remaining-account lists that repeat accounts: every alias refused (2040), balances conserved |
| `showcase/test/fuzz-jito.test.ts` | Jito's tip payment, tip distribution and priority fee distribution as deployed on mainnet | random sequences of tips, receiver and builder changes, accounts opened over epochs, roots uploaded, Merkle claims (wrong amounts, proofs and signers among them), closes and config changes, with at most one injected fault per transaction: the same outcome, account bytes, events and log lines as the original after every step; keys, amounts and choices all come from the seed |
| `showcase/test/fuzz-marginfi.test.ts` | Marginfi v2 as deployed on mainnet | random sequences of bank creation (random weights, curves and fees, most valid, some broken one way), configuration (operational states, curves, liquidation fees, the circuit breaker's switch and settings, frozen banks), accruals over balances written into both at every scale and clock jumps up to a year, limits, pauses, wrong signers: the same outcome, account bytes and events as the original after every step; inputs the original panics on (a negative fee rate) must fail in the port too |
| the `fuzz:` case of `showcase/test/raydium-clmm.test.ts` | Raydium CLMM as deployed on mainnet | random swaps (both ways, exact in and out, price limits, thresholds), positions opened at random ranges, and liquidity added and taken out (over the position's own, under slippage limits): the same outcome, account bytes and events as the original after every step; choices and amounts come from the seed (`CLMM_FUZZ_STEPS` lengthens it), keys are fresh each run; each transaction may use 1.4M compute units, so a swap the original needs more than 200,000 for still runs to its end |
| `showcase/test/spl-stake-pool-fuzz.test.ts` | SPL Stake Pool as deployed on mainnet | a random walk over many epochs: validators added and removed, deposits, withdrawals, stake increased and decreased, rewards and tips at each epoch boundary, some steps wrong on purpose; every step gives the same outcome, logs and account bytes as the original, and every account the walk knows is compared after each epoch and every 25 steps; choices and amounts come from the seed (`STAKE_POOL_FUZZ_STEPS` lengthens it, `STAKE_POOL_FUZZ_SWEEP=1` compares every account after each step), keys are fresh each run |
| `showcase/test/phoenix-fuzz.test.ts` | Phoenix v1 as deployed on mainnet, and a balance model | a random walk over two order books (512/128 and 4096/8321, each started nearly full): every kind of order, reductions and cancels, seats, evictions, fee collection, status changes, a moving clock and invalid packets; every step gives the same outcome, logs, inner instructions, return data and account bytes as the original, and after each step every trader's locked and free lots plus the uncollected fees equal what the vaults hold; choices and every key come from the seed, CI walks seeds 1, 2 and 3 (300 steps on each market) and requires minimum counts of fills, evictions, expiries and fees (`PHOENIX_FUZZ_STEPS` changes the length) |
| `test/verification/rbtree-trace.test.ts` | lib-sokoban 0.3.0 itself (`test/verification/rbtree/oracle`, a Rust program that records traces) | the built-in RedBlackTree replays 21,650 recorded operations (capacities 1 to 4096; u64 keys, Phoenix's order ids with their comparator, Pubkey keys), one a transaction: after each the tree's bytes (root, allocator, every node, freed ones included) hash as the crate's did and the operation returns what the crate's returned; a second pass replays every `remove(key)` as `removeAt(addrOf(key))`; `RBTREE_TRACES=<file>` replays another set |
| `test/verification/differential.test.ts` | Anchor twins in `test/anchor-twins` | identical transactions to TypeSOL and Anchor programs: same outcomes, same account contents, same wallet and token balances after every step |
| `showcase/test/porting/ports-*.test.ts` | the Anchor programs of solana-developers/program-examples and their tests | TypeSOL rewrites under `showcase/program-examples/` run the originals' flows and failure paths with the same outcomes, error codes and balances ([showcase/program-examples/README.md](https://github.com/typesol-lang/typesol/blob/main/showcase/program-examples/README.md)) |

Compute-unit and binary-size comparisons with Anchor, native Rust and Pinocchio are in the README
([Numbers](../README.md#numbers)).

## Epochs and staking

`typesol/testing`'s `warpToEpoch`, `StakeCluster` and `stakeActivation` ([test-your-program.md](test-your-program.md#epochs-and-staking))
are checked in `test/cli/testing-stake.test.ts` against the Stake program LiteSVM runs, the core BPF build bundled in
LiteSVM 1.6.1 (its program data holds a 202,280-byte ELF, sha256 `c9cba7f3…cd2352a8`). The oracle is a withdrawal: from a deactivated stake account the
program lets go of lamports − rent-exempt minimum − the stake it computes as still effective, so withdrawing exactly
the predicted amount must succeed and one lamport more must fail.

- Rate-limited warmup and cooldown over 13 epochs in two VMs: each epoch, the program's held-back stake equals
  `cluster.activation`, merging two delegations fails while either is still activating and succeeds the epoch both are
  fully active, and both VMs' Clock and StakeHistory bytes are equal.
- Warmup read back at the deactivation epoch, after three rate-limited epochs, then its cooldown.
- 25 mainnet-sized cases (stakes up to 30M SOL against 300–500M SOL effective, over two cooldown epochs): the program
  matches the f64 algorithm to the lamport, where the integer one is a few lamports off; the case of
  solana-stake-interface's `high_ulp_case` test is among them.
- `stakeActivation`'s integer algorithm against hand-worked values and the Rust crate's own test cases (bootstrap
  stake, activation and deactivation in one epoch, missing history, the rate change, u128 saturation, the one-lamport
  minimum step).

## Reproducing a release

From 0.39.0 on, each release's GitHub Release carries its manifest, `typesol-<version>-manifest.json`, attached by
hand after the npm publish (written by `scripts/release-manifest.ts` from the tag's sources; the scripts need Node 22.18
or later):

- the compiler and toolchain versions (clang, platform-tools, Node, TypeScript, the runtime header's sha256);
- the sha256 of the SBF binary, IDL and C that every program under `examples/` and `showcase/program-examples/` builds to;
- the sha256 of the reference binaries the differential tests run against (`test/programs/`);
- a hash of the test corpus.

It also carries `binary-diff.txt`: the previous release's sources built by the previous package and by this one,
compared program by program. That is the check behind a changelog line such as "programs that use none of these compile to the
same binaries". To redo it, or to compare other versions:

```sh
git worktree add ../typesol-prev v0.37.0          # the sources to build
npm install --prefix /tmp/a @typesol/cli@0.37.0
npm install --prefix /tmp/b @typesol/cli@0.38.0
node scripts/release-manifest.ts --compiler /tmp/a/node_modules/@typesol/cli --sources ../typesol-prev --out a.json
node scripts/release-manifest.ts --compiler /tmp/b/node_modules/@typesol/cli --sources ../typesol-prev --out b.json
node scripts/release-manifest.ts --diff a.json b.json
```

For 0.37.0 → 0.38.0 (run by hand before release manifests existed): all 67 programs of the 0.37.0 sources build to
the same binary and IDL with both packages.

