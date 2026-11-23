# Testing the Percolator v16 port

Percolator v16 at commit 7b110913 (engine 5e3af07). Everything below runs Rust in Docker only; nothing is built or
installed with the host's Solana toolchain.

## 1. The reference binaries

```sh
scripts/percolator-v16-reference/build.sh
```

Builds the image of `scripts/percolator-v16-reference/Dockerfile` (once), fetches aeyakovenko/percolator-prog
`7b11091328de23cded2e4afe96592bbd060a6828` and aeyakovenko/percolator-match `60aac3a996d0264c47fbefe9a2625d6ee6fb6a47`
in the container (the engine comes through the program's `Cargo.lock`, checked to name `5e3af07`), builds four
binaries with `cargo-build-sbf --tools-version v1.52 -- --locked` on 2 CPUs and copies each into `test/programs/` only
if its sha256 is the recorded one (exit 3 otherwise):

| File | Built from | Bytes | sha256 |
| --- | --- | ---: | --- |
| `percolator_v16.so` | percolator-prog `7b11091` | 1,375,936 | `cc35fa4853bddd4e7f58c0e248c7c298ee152625d423ee6ed6b35c9fdfbe60b9` |
| `percolator_v16_match.so` | percolator-match `60aac3a` | 47,064 | `15ca5d638e7911157ef075b60170c06d82ef2208f6565002cf6620315e6dc3ea` |
| `percolator_v16_auth_matcher.so` | percolator-prog `tests/fixtures/auth_matcher` | 29,216 | `50e532267926e180f013200c1799e26127dd23dc150866cffd491424629ddf93` |
| `percolator_v16_hostile_matcher.so` | percolator-prog `tests/fixtures/hostile_matcher` | 84,472 | `e0c20fad34a7822cc6ce42a3c77ff08a8591977102f0c497a339d66a9dd6240a` |

The script as committed was run end to end on 2026-11-17 (macOS arm64 host, linux/amd64 emulated): all four hashes
as recorded, 11 min 40 s including building the image (`cargo-build-sbf` 3.1.10, platform-tools v1.52, rustc 1.89.0).
These are the bytes of the two earlier clean builds of the scope research.

## 2. The TypeScript tests

```sh
npx vitest run showcase/test/percolator-v16-layout.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-harness.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-reference.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-state.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-decode.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-setup.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-setup-refusals.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-setup-stress.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-policy.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-accounts.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-walk.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-oracle.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-lifecycle.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-hybrid.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-external.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-refresh.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-kernels.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-trade.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-trade-walk.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-crank.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-crank-walk.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-recovery.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-reserves.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-terminal.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-gaps.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-batch.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-cpi.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-limit.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-paths.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-shapes.test.ts --maxWorkers=2
```

The last ten but the two trade files compare the 27 instructions ported before TradeNoCpi and ConvertReleasedPnl (README, "Instructions"; the trade files below): `setup` the success paths of the market
and portfolio set-up, `setup-refusals` their refusals and a seeded fuzz of InitMarket's arguments
(`PERCOLATOR_V16_INIT_FUZZ`, 300 by default), `policy` the authority, policy and ledger instructions, `oracle` the
managed marks and SetMatcherConfig with a seeded fuzz of pushes (`PERCOLATOR_V16_MARK_FUZZ`, 300), `lifecycle` the
asset lifecycle, the restart and the spent-backing canonicalisation with a seeded fuzz of shutdowns that accrue
committed funding (`PERCOLATOR_V16_ACCRUAL_FUZZ`, 400) and the permissionless activations with their fee, `hybrid`
ConfigureHybridOracle and the external readers with a seeded fuzz of configurations (`PERCOLATOR_V16_HYBRID_FUZZ`, 400),
`external` the reader's crank-only branches on recorded vectors (below), `refresh` SyncMaintenanceFee and Withdraw
with a fuzz of generated states (`PERCOLATOR_V16_STATE_FUZZ`, 400: `percolator-v16-states.ts` writes the market and
both portfolios into states with legs, PnL, fee debt and extreme money totals; Deposit and ClosePortfolio run on them
too), `accounts` every account position of each from the test world
(`percolator-v16-world.ts`), `walk` the random walk (`PERCOLATOR_V16_WALK_STEPS`, 2,000, × `PERCOLATOR_V16_WALK_SEEDS`,
3) and the mutation fuzzer (`PERCOLATOR_V16_MUTATIONS`, 2,000; a fifth start from a generated state). `kernels`
compares the settlement's engine functions ported so far with the original's compiled for the host, on recorded
vectors, through a test program of its own (below; not the reference binary, and none of its transactions is counted
with the instructions'). `PERCOLATOR_V16_CU_FILE=<path>` appends each compared
transaction's tag and both compute-unit counts to a file (one JSON object a line), from which the README's table is
made. Vitest 5 prints the tests' own counts only with `--silent=false`. The last run of all twenty files, one at a time
(2026-11-18), all passing (since the keys now come from a seed drawn per run, the walk's and the sweeps' tallies below
are those of the run whose seed the walk's row names; other seeds give other, similar counts):

| File | Tests | What ran |
| --- | ---: | --- |
| `percolator-v16-layout.test.ts` | 27 | |
| `percolator-v16-harness.test.ts` | 5 | |
| `percolator-v16-reference.test.ts` | 7 | |
| `percolator-v16-state.test.ts` | 36 | |
| `percolator-v16-decode.test.ts` | 5 | every tag's boundary inputs and 200 random bodies a tag |
| `percolator-v16-setup.test.ts` | 3 | |
| `percolator-v16-setup-refusals.test.ts` | 3 | 300 InitMarket argument sets |
| `percolator-v16-setup-stress.test.ts` | 1 | 300 set-ups (`PERCOLATOR_V16_SETUP_STRESS`); 30,000 in a longer run (section 5) |
| `percolator-v16-policy.test.ts` | 8 | |
| `percolator-v16-accounts.test.ts` | 28 | 3,269 transactions, 129 succeeded in both |
| `percolator-v16-walk.test.ts` | 4 | 3 × 2,000 walk steps (1,188, 1,119 and 1,194 succeeded in both; the keeper sent 6, 4 and 2 transactions, all succeeding; 3, 2 and 2 fresh markets) and 2,000 mutations (393 from generated states, six in ten of them with open legs; 928 succeeded in both; none pinned); run with `PERCOLATOR_V16_SEED=175422424321469`, the same counts as with the keys of before) |
| `percolator-v16-oracle.test.ts` | 5 | 300 fuzzed pushes and reconfigurations (193 succeeded in both; 1,439 of 2,000 in a longer run) |
| `percolator-v16-lifecycle.test.ts` | 6 | 400 fuzzed shutdowns, a third on the hybrid oracle (257 succeeded in both, 57 of them accruing funding); 34 permissionless appends and one reuse with their fee; 300 retirements with lapsed Fresh backing buckets written into the market (139 succeeded in both) |
| `percolator-v16-hybrid.test.ts` | 4 | 400 fuzzed configurations (113 succeeded in both: Pyth 20/55, Switchboard 22/37, Chainlink 17/33, two legs 32/122, three legs 22/153) |
| `percolator-v16-external.test.ts` | 2 | 1,500 vectors equal to the original's answers (270 read a price, 258 of them advancing; 771 with stored legs) |
| `percolator-v16-refresh.test.ts` | 6 | 400 generated states (266 of 313 Live ones accepted by the validators; 151 succeeded in both, 7 of them settling legs) and 300 with open legs (193 of 260 accepted; 83 succeeded in both, 36 of them settling legs); none pinned |
| `percolator-v16-kernels.test.ts` | 1 | 2,700 recorded vectors of 45 engine functions (60 each), 2,620 that decode equal to the original's answers compiled for the host (1,539 successes, 1,051 engine errors, 30 panics); 90,000 in a longer run |
| `percolator-v16-trade.test.ts` | 6 | TradeNoCpi's routes, 14 legs, bounds, fees, margin, accounts and data (below) |
| `percolator-v16-trade-walk.test.ts` | 3 | 2 × 600 walk steps on real state and 600 mutations (below) |
| `percolator-v16-primitives.test.ts` | 1 | 6,600 recorded vectors of 110 engine functions on generated markets and portfolios (60 each), 6,529 that decode equal to the original's answers compiled for the host (4,679 successes, 1,110 of them changing the accounts, 1,850 engine errors); 33,000 in a longer run |
| `percolator-v16-crank.test.ts` | 9 | the crank's dedicated tests (section on the crank below) |
| `percolator-v16-crank-walk.test.ts` | 3 | 2 × 1,500 walk steps with resolutions and close-outs, 600 mutations (below) |
| `percolator-v16-recovery.test.ts` | 11 | six markets taken out of Live and closed out, the sweeps, RebalanceReduce, CureAndCancelClose (below) |
| `percolator-v16-reserves.test.ts` | 2 | 260 reserve transactions among trades and cranks; 2,989 sweep transactions, 80 succeeding in both (below) |
| `percolator-v16-terminal.test.ts` | 12 | three markets closed by CloseSlab, the sweeps (4,560, 415 succeeding), the second mint (977, 7), ForceCloseAbandonedAsset (sweep 303, 90), reserves without legs (sweeps 2,555, 46), five haircut markets (below) |
| `percolator-v16-gaps.test.ts` | 6 | six losses past a portfolio's capital with small chunks and little or no insurance, each market resolved; asserted per seed: the uncovered loss (seeds 0 to 2) and CloseSlab (all but seed 3) (below) |
| `percolator-v16-batch.test.ts` | 5 | BatchTradeNoCpi: routes, 14 legs, refusals, accounts and data, 300 seeded batches (below) |
| `percolator-v16-cpi.test.ts` | 9 | TradeCpi and BatchTradeCpi through the three matchers and the rogue matcher, 300 seeded matcher trades (below) |
| `percolator-v16-limit.test.ts` | 2 | the reference past its compute-unit limit, rerun under a raised budget (below) |
| `percolator-v16-paths.test.ts` | 1 | source liens, backing fees, earnings, lien releases driven on purpose, each asserted on both VMs' state (below) |
| `percolator-v16-shapes.test.ts` | 3 | InitMarket, ResolveMarket, ResolveStalePermissionless and CloseSlab's terminal scan on markets of up to 5,682 slots (below) |

In the latest run (2026-11-21, on the binary of sha256 `01c33233…`; 31 files, one at a time, under
`CI_REQUIRE_ALL=built`, all passing: 226 tests, default sizes) the files printed 70,928 transactions compared with the
port, 30 with the reference on both sides (harness, layout, reference and state files) and 10,649 vectors (external
1,500, kernels 2,620, primitives 6,529). The compute-unit file (`PERCOLATOR_V16_CU_FILE`, the transactions with a
Percolator instruction) held 70,725: 26,035 successes, each cheaper in the port (9 against the reference's run under a
raised budget), and 44,690 refusals, 44,680 cheaper in the port and 10 at 0 in both (refused by the runtime before the
program ran). The run of 2026-11-20 (30 files, 222 tests, the binary before the whole-market scans were fixed): 70,881
transactions; its compute-unit file 70,678, 25,995 successes, 44,683 refusals. The counts move by a few
dozen between runs (the keys come from a seed drawn per run: `percolator-v16-setup-stress` compared 2,286 and 2,258
in two runs). The run of 2026-11-19 counted by the compute-unit file: 70,640 transactions, 25,941 successes, 44,699
refusals. Before the batch and matcher instructions (26 files,
205 tests): 68,632 transactions,
24,657 successes. Before the insurance, backing and terminal instructions: 42,222 transactions,
16,223 successes. Before the crank's Recovery and Resolved paths and the recovery and resolution instructions:
30,025 transactions with the port, 10,275 of them successes, each cheaper
in the port (README, "Compute units and size"). Before the set-up stress file was added, they compared 25,370 transactions with the port (counted by the compute-unit file, which also
counts the transactions each file makes to set up its world), 6,925 of them successes, each cheaper in the port.

Successes and attempts of each instruction in the three 2,000-step walks of the last run (seeds 1618, 2627, 3636; an
attempt is a valid transaction for the state reached, or one with its data or accounts corrupted):

| Instruction | 1618 | 2627 | 3636 |
| --- | ---: | ---: | ---: |
| InitMarket | 68/81 | 57/75 | 52/66 |
| InitPortfolio | 60/62 | 74/80 | 90/92 |
| Deposit | 52/83 | 46/68 | 54/71 |
| Withdraw | 40/72 | 42/77 | 32/60 |
| ClosePortfolio | 22/82 | 30/97 | 23/65 |
| SyncMaintenanceFee | 51/84 | 43/69 | 47/59 |
| UpdateAuthority | 53/73 | 47/63 | 52/68 |
| ConfigureHybridOracle | 53/88 | 42/69 | 33/71 |
| ConfigureEwmaMark | 34/62 | 58/95 | 47/87 |
| PushEwmaMark | 22/64 | 30/76 | 30/68 |
| UpdateLiquidationFeePolicy | 43/54 | 52/66 | 67/81 |
| ConfigurePermissionlessResolve | 54/68 | 50/63 | 71/91 |
| UpdateAssetLifecycle | 64/76 | 48/57 | 52/64 |
| UpdateMaintenanceFeePolicy | 59/74 | 57/79 | 51/69 |
| UpdateBackingFeePolicy | 55/82 | 37/65 | 45/78 |
| SyncBackingDomainLedger | 36/80 | 29/93 | 21/79 |
| SyncInsuranceLedger | 38/69 | 25/63 | 30/72 |
| UpdateTradeFeePolicy | 54/75 | 52/64 | 64/80 |
| UpdateFeeRedirectPolicy | 67/83 | 52/71 | 66/81 |
| UpdateMarketInitFeePolicy | 63/83 | 57/72 | 70/86 |
| UpdateBaseUnitMints | 26/67 | 25/74 | 23/69 |
| ConfigureAuthMark | 44/78 | 53/80 | 42/73 |
| PushAuthMark | 20/62 | 26/77 | 30/73 |
| UpdateAssetAuthority | 55/84 | 41/78 | 52/89 |
| SetMatcherConfig | 39/82 | 32/73 | 41/62 |
| RestartAssetOracle | 16/54 | 14/86 | 9/69 |
| CanonicalizeSpentBackingHistory | 0/78 | 0/70 | 0/77 |

The same for ConfigureHybridOracle by its legs (one oracle account of a kind, or a composite of two or three of the
world's four: Pyth, Switchboard under its mainnet and its devnet owner, Chainlink):

| Legs of ConfigureHybridOracle | 1618 | 2627 | 3636 |
| --- | ---: | ---: | ---: |
| pyth | 6/10 | 4/5 | 8/20 |
| switchboard | 7/9 | 9/9 | 2/5 |
| chainlink | 2/5 | 2/4 | 2/2 |
| composite of 2 | 18/31 | 12/24 | 9/22 |
| composite of 3 | 20/33 | 15/27 | 12/22 |

UpdateBaseUnitMints succeeds only on an empty market (half its attempts go to the funded one, by design);
RestartAssetOracle only while asset 1 is in Recovery; CanonicalizeSpentBackingHistory needs spent-backing history that
no ported instruction makes (its successes are in the lifecycle test, from patched state). The pushes fail more often
than before: an asset configured for the hybrid oracle refuses both (Unauthorized), and the keeper leaves the oracle
accounts unrefreshed on a fifth of the steps, so a ConfigureHybridOracle then meets stale prices.

The harness test runs the reference against itself (the harness's own check) and, since the port's entry exists,
against the port (`showcase/mainnet/percolator-v16/percolator.ts`, built by the test): empty data and all 206 unknown
tags, with 0 to 255 accounts. The reference test records the entrypoint at its limits (section 4).

The state test ties every struct of `state.ts` to the layout rustc printed (from the TypeSOL compiler's model, without
the reference) and runs the wire conversions on known vectors through `showcase/test/fixtures/percolator-v16-wire.ts`.
The decode test sends every tag's boundary inputs and random bodies to both programs (README, "Instructions");
`PERCOLATOR_DECODE_FUZZ=<n>` sets the random bodies per tag (200 by default), `PERCOLATOR_FUZZ_SEED` the seed (1618),
and `PERCOLATOR_TRACE=1` prints each tag's compute units and the reference's outcomes for decoded inputs.

### Replaying a run

Every key the v16 tests make (the `Diff`'s, the test world's, the fixtures' program ids) comes from one seed,
`PERCOLATOR_V16_SEED`, drawn anew for each run unless it is set, so that runs keep covering new keys (account
addresses, PDA bumps, vault addresses, the order of keys in a transaction). The scenario generators keep their own
seeds (`PERCOLATOR_FUZZ_SEED`, 1618 by default, and the per-file ones named above). Each test file prints
`percolator-v16 replay: PERCOLATOR_V16_SEED=… PERCOLATOR_FUZZ_SEED=…` when it starts, and every failure's message
begins with the same line, the port binary's sha256 and its clang; setting those variables runs the same transactions
again. Nothing else in the tests is random (no `Math.random`; the Clock is set by the tests).

The port and the test programs over its functions are built by `loadPort` (`percolator-v16-helpers.ts`) into a new
temporary directory per build, loaded from memory and removed: two test files never share a build. The build must use
the tested toolchain throughout: the platform-tools link the build resolves (`dependencies/platform-tools` of the Agave
installation, which a `cargo-build-sbf` of another tools version re-points for every process on the machine) is
resolved before and after the build, and the binary's manifest must name the tested clang; otherwise the test fails
with a message saying which (`PERCOLATOR_V16_ANY_TOOLCHAIN=1` allows an untested clang on purpose). The probed copy of
the port for the coverage runs is written per process (`.typesol/coverage/<pid>/`) and removed at exit.

Without the binaries the reference-dependent suites skip, and each file prints `percolator-v16 compared: 0
transactions…`: a skipped run compares nothing and must not be read as a pass. `CI_REQUIRE_ALL=built` (or `=1`) makes
it fail instead (`test/binaries.ts`, `STRICT` in `percolator-v16-helpers.ts`): a missing reference, matcher or probe
binary or a missing port source fails the file when it loads, and a file that compared nothing (no transaction; for
the external, kernels and primitives files, no vector: `countVectors`) fails after it runs. CI's `percolator-v16` job builds the five binaries in Docker from the pinned sources (`build.sh`, `probe.sh`;
each kept only at its recorded sha256, and all five checked against `test/programs/SOURCES.md` again before the
tests, a cached copy included) and runs the 31 files one at a time under `CI_REQUIRE_ALL=built`. The showcase job
excludes them. CI does not run the author's Rust suite, the coverage runs or the longer generator runs. The job has not
yet run on GitHub's runners (its duration there is not measured).

Where the reference runs out of compute units and the port does not, `Diff.send` reruns the transaction in a third VM
(the reference under 20,000,000 units). That VM starts from exactly the state the reference held before the
transaction for every account the comparison covers (the fee payer, the transaction's accounts, the watched ones),
taken before the transaction was sent: an account that did not exist then is removed from it, whatever an earlier
replay left there. The port is compared with what that VM holds after the run (a closed account as missing), and the
reference then takes that state, a closed account removed. The harness test checks both cases (a portfolio
ClosePortfolio closes during a replay; a watched portfolio closed by an ordinary transaction between two replays); each
fails against the earlier version of the replay, which skipped missing accounts in both copies. Programs a test adds
(`Diff.addProgram`) are loaded into the third VM too.

The layout fixture is regenerated (only when the table in `showcase/test/percolator-v16-layout.ts` changes) with

```sh
node scripts/percolator-v16-reference/layout.ts
```

### The external reader's vectors

`read_external_price_e6_profile` is reached by ConfigureHybridOracle only on a fresh profile (its legs hold no
observation); the branches that need stored observations, Manual or managed profiles, an invalid leg configuration
or fewer accounts than legs are reached only by the crank, not ported. `percolator-v16-external.test.ts` compares them
on 1,500 vectors made from seed 1618 by `vectors()` in `showcase/test/percolator-v16-oracles.ts` with the answers of
the original's own functions, compiled for the host from the pinned sources in Docker and recorded in
`showcase/test/fixtures/percolator-v16-oracle-vectors.txt` with the sha256 of the inputs (the test regenerates the
inputs and checks it):

```sh
node scripts/percolator-v16-reference/oracle-vectors.ts 1500
```

This is a comparison with the original's source, not with the reference binary: the SBF build was not run on these
inputs. The port runs them on chain through `showcase/test/fixtures/percolator-v16-external.ts`.

### The settlement's engine functions

The settlement of a portfolio's open legs (`settle_account_side_effects_not_atomic`, mapped in NOTES.md section 10) is
run by the reference binary only as a whole: SyncMaintenanceFee and Withdraw compare it with the binary (below, "The
settlement of open legs against the reference binary"). Its parts are in addition compared function by function with
**the original's own functions compiled for the host from the pinned engine**, which reaches branches the binary
comparison does not.

- **The original's side.** `scripts/percolator-v16-reference/kernels.ts` starts `rust:1.89-slim-bookworm` (pinned by
  digest, 2 CPUs, 6 GiB, no host directory but the vectors, read-only), fetches aeyakovenko/percolator at
  `5e3af0710ec7e9b7077393012f8a94a31b2f07ef` into the container (the pinned sources on the host are not used or
  changed), and in that copy appends `#[path = "/harness/typesol_harness.rs"] pub mod typesol_harness;` to
  `src/v16.rs` and `pub use v16::typesol_harness;` to `src/lib.rs`. The module (`scripts/percolator-v16-reference/
  kernels/typesol_harness.rs`) is a child of `v16`, so it may call the engine's private functions and associated
  functions (`V16Core::…`, `MarketGroupV16ViewMut::…`, the free functions) with no visibility edited; it decodes the
  inputs, calls one function and encodes the result, nothing else. `kernels/typesol_kernels.rs`, an example of the
  copy, reads the vectors and prints one answer per vector. It is built in release with overflow checks off
  (`CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS=false`): inside the program the program's profile governs, and it has none,
  so the reference binary's engine wraps where an unchecked operation overflows; the engine crate's own
  `overflow-checks = true` applies only when it is built as the root, which this is.
- **The inputs.** A vector is a function id, eight 16-byte arguments and a 2,020-byte scratch: an engine asset slot
  (1,333), a portfolio leg (152), a portfolio source domain (196), a resolved-payout ledger (90) and an engine config
  (249), drawn by `showcase/test/percolator-v16-kernels.ts` from seed 1717 with the struct generator of
  `percolator-v16-values.ts` (an extension of `percolator-v16-states.ts`, which re-exports it): fields near a few shared
  magnitudes so that the relations the functions check hold or fail by one, half the source credit states made
  shape-valid with their implied rate, buckets whose consumed backing equals the receivable, drainable sides, legs one
  epoch behind, values at the limits of u64, u128 and i128. A struct taken by value is decoded field by field without
  `try_to_runtime`'s static validation (the port works on bytes and is compared on states the validators would refuse
  too); an enum or bool byte that does not decode, or a config whose bools do not, is no input to the original (its
  callers decode first) and is counted, not compared. On success the struct is written back where it came from, as
  each caller writes the returned value.
- **The port's side.** `showcase/test/fixtures/percolator-v16-kernels.ts` is a TypeSOL program that calls the port's
  function (kernels.ts) on the same arguments and the scratch account in place (PANIC_STYLE "solana-1.18", so that a
  panic logs its location and message); `percolator-v16-kernels.test.ts` regenerates the inputs, checks their sha256
  against the answers file, sends each to the program in LiteSVM and requires the same outputs and changed scratch
  bytes, the same engine error (as `map_v16_error` maps it), or a panic at the same `file:line:column` with the same
  message. Each function must reach a success at least once.

The committed answers are 60 vectors per function (`showcase/test/fixtures/percolator-v16-kernel-vectors.txt`, 2,700
vectors); a larger run writes its own file and the test reads it from `PERCOLATOR_V16_KERNEL_ANSWERS`:

```sh
node scripts/percolator-v16-reference/kernels.ts            # 60 per function, the committed fixture
node scripts/percolator-v16-reference/kernels.ts 2000 /tmp/k.txt
PERCOLATOR_V16_KERNEL_ANSWERS=/tmp/k.txt pnpm vitest run showcase/test/percolator-v16-kernels.test.ts --maxWorkers=2
```

Last runs: the committed 2,700 vectors and 90,000 (2,000 per function, 45 functions): equal on every vector that
decodes. Of the 90,000: 50,507 successes, 35,700 engine errors, 2,605 inputs that do not decode, and 1,188 panics,
each at the original's location with its message: `wide_signed_mul_div_floor_from_k_pair` 886 times (a zero
denominator 490, a magnitude past u128 150 or past i128::MAX 25, a quotient past u128 212 or past i128::MAX 9), 292 of
them through `leg_kf_delta_components_for_settlement_from_asset` (a leg whose A basis is zero, or K/F far apart), and
`floor_div_signed_conservative_i128`'s zero denominator 302. Its other panic (a quotient past i128::MAX, only for
i128::MIN over 1) was not reached.

### The backing and lien primitives, and the settlement's upper layers

The rest of the settlement's leaf layer (its market-view accessors), its layer 2 (the backing and lien primitives),
layer 3 (the impaired-lien reconciliation) and layers 4 to 7 (the source-claim burns and PnL setters, the K/F
settlement entries, the B chunks, the driver), mapped in NOTES.md section 10, work on whole markets and portfolios, so
they are compared on those, function by function, with **the original's own functions compiled for the host from the
pinned engine**. The settlement as a whole is also compared with the reference binary through SyncMaintenanceFee and
Withdraw (below); these vectors reach branches that comparison does not.

- **The original's side.** `scripts/percolator-v16-reference/kernels.ts --primitives` runs the same container and
  copy of the engine as above with `kernels/typesol_primitives.rs` as the example; `typesol_harness.rs`'s
  `call_market` takes a market account and a portfolio account and builds the original's views over their bytes as
  the program does (`market_group_view_from_state`: `MarketGroupV16ViewMut::new` over the group header at byte 464 and
  the slots after it, as `Market<[u8; 512]>`; the portfolio's `PortfolioV16ViewMut { header }` over its engine state
  at byte 16, without `new()`'s compaction, since none of these functions is reached through `new()` without the
  caller's own validation first). A struct value an engine function takes (a source credit state, a bucket, a
  reservation, the parts of `create_and_consume_*_parts`) is read from the accounts as its callers read it. The answer
  is the outputs, the engine error or a panic, and every changed byte of both accounts.
- **The inputs.** `showcase/test/percolator-v16-primitives.ts`, from seed 1919: a market of 1 to 4 slots with a
  consistent configured count (`configBytes`), assets from `structBytes` with decodable enum bytes, and per domain a
  ledger consistent with itself (a bucket Empty, Fresh, Expired or Impaired with its amounts and an expiry passed, due
  or ahead; the source credit state's amounts equal to the bucket's and the reservation's, a claim bound and its exact
  part, spent backing at least the receivable, the implied credit rate; provider principal below, at or above the
  reserve; insurance budgets; loss barriers), the header's totals the sums over the slots and money covering the senior
  claims, a Resolved mode or a captured payout snapshot now and then; a portfolio of the market's group with occupied
  source domains (claims within their domain's bound, lien fields consistent, counterparty liens on impaired buckets
  within the bucket's impaired backing), legs bound to their assets, a close-progress ledger now and then. One market
  in eight and one portfolio in eight then gets a field broken (a total or an amount one off, a status, rate or byte
  out of place, a hidden slot or leg), and one market in twelve has amounts no vault covers: deliberately invalid
  states. For the upper layers the states line up more often: three backing-fee rates within their summed maximum (nine
  markets in ten), legs only on assets that can hold one (nine in ten), source domains drawn six times in ten from those
  whose bucket holds backing a lien can sit on, counterparty liens of at least an atom on them (seven in ten there),
  insurance liens within the reservation, the K and F snapshots a step from the side's indices, older K/F epochs (a
  stale cohort), B snapshots at or behind the B index, an exhausted side for the full-drain reset, a single leg in a
  later slot, the account's B-stale mark, reserved PnL, configured slots with no market id, larger freshness horizons,
  counters near their limits. Function 68 (the market's `validate_shape`, then the portfolio's
  `validate_with_market`) measures the validity: 32 of its 60 committed states pass (InvalidConfig 11, InvalidLeg 10,
  HiddenLeg 7), 173 of 300 in the longer run (58%; InvalidConfig 52, HiddenLeg 51, InvalidLeg 24; before this
  generator: 121 of 300, 40%). Arguments are drawn near the domain's fields (amounts
  equal, one off, aligned, unrelated; expiries passed, due, ahead), domains of the portfolio's slots most of the time,
  domains past the configured ones or past u32 now and then.
- **The port's side.** `showcase/test/fixtures/percolator-v16-primitives.ts` calls the port's functions
  (primitives.ts, impairment.ts) over the market and portfolio accounts in place (`NATIVE_ACCOUNT_WRITES`, as the
  port's program); `percolator-v16-primitives.test.ts` regenerates the inputs, checks their sha256 against the answers
  file, sends each and requires the same outputs and changed bytes of both accounts or the same engine error.

```sh
node scripts/percolator-v16-reference/kernels.ts --primitives        # 60 per function, the committed fixture
node scripts/percolator-v16-reference/kernels.ts --primitives 300 /tmp/p.txt
PERCOLATOR_V16_PRIMITIVE_ANSWERS=/tmp/p.txt pnpm vitest run showcase/test/percolator-v16-primitives.test.ts --maxWorkers=2
```

Last runs: the committed 6,600 vectors (60 per function, 110 functions) and 33,000 (300 per function): equal on
every vector that decodes, no panic reached in either. Per function, the committed run (successes that change the
accounts / other successes / engine errors / inputs that do not decode), and the longer run's successes that change
the accounts. Before the generator was thickened, the longer run's writing successes on the deepest paths were: fee
collection 23, reconcile at a slot 10, reconcile all liens 16, expiry 37, fresh-backing adds 40 to 62.

| Id | Function | Committed (60) | Longer run (300): changing |
| ---: | --- | --- | ---: |
| 0 | `domain_asset_side` | 0 / 47 / 13 / 0 | 0 |
| 1 | `insurance_domain_index` | 0 / 49 / 7 / 4 | 0 |
| 2 | `source_credit_for_domain` | 0 / 47 / 13 / 0 | 0 |
| 3 | `source_credit_for_domain_shape` | 0 / 52 / 8 / 0 | 0 |
| 4 | `stored_source_credit_rate_num` | 0 / 53 / 7 / 0 | 0 |
| 5 | `provider_principal_num` | 0 / 39 / 21 / 0 | 0 |
| 6 | `loser_paid_backing_num` | 0 / 37 / 23 / 0 | 0 |
| 7 | `backing_bucket_for_domain (effective expiry)` | 0 / 52 / 8 / 0 | 0 |
| 8 | `backing_bucket_raw_status_expiry_for_domain` | 0 / 54 / 6 / 0 | 0 |
| 9 | `insurance_reservation_for_domain` | 0 / 48 / 12 / 0 | 0 |
| 10 | `fresh_counterparty_backing_expiry_slot` | 0 / 47 / 13 / 0 | 0 |
| 11 | `domain_insurance_budget_spent` | 0 / 47 / 13 / 0 | 0 |
| 12 | `residual, junior_claim_bound, backing_provider_earnings_total, source_fresh_backing_total_atoms` | 0 / 60 / 0 / 0 | 0 |
| 13 | `domain_budget_remaining_parts` | 0 / 30 / 30 / 0 | 0 |
| 15 | `set_source_credit_for_domain (update_source_credit_aggregate_totals)` | 46 / 1 / 13 / 0 | 208 |
| 16 | `set_backing_bucket_for_domain (update_backing_aggregate_totals)` | 30 / 20 / 10 / 0 | 130 |
| 17 | `set_insurance_reservation_for_domain` | 39 / 7 / 14 / 0 | 184 |
| 18 | `adjust_provider_principal_num` | 28 / 21 / 11 / 0 | 143 |
| 19 | `release_provider_principal_after` | 8 / 51 / 1 / 0 | 50 |
| 20 | `set_domain_insurance_spent_delta` | 0 / 14 / 46 / 0 | 0 |
| 21 | `set_domain_insurance_spent_core` | 25 / 8 / 27 / 0 | 118 |
| 22 | `validate_source_domain_ledger` | 0 / 48 / 12 / 0 | 0 |
| 23 | `validate_source_domain_ledger_current` | 0 / 29 / 31 / 0 | 0 |
| 24 | `recompute_source_credit_domain_after_mutation` | 46 / 0 / 14 / 0 | 239 |
| 25 | `recompute_source_credit_domain_after_mutations` | 32 / 0 / 28 / 0 | 146 |
| 26 | `refresh_source_credit_domain_after_mutation` | 38 / 0 / 22 / 0 | 196 |
| 27 | `reservation_encumbrance_proof_for_domain + validate` | 0 / 45 / 15 / 0 | 0 |
| 28 | `reservation_encumbrance_proof_for_domain_parts + validate` | 0 / 52 / 8 / 0 | 0 |
| 29 | `add_fresh_counterparty_backing_unchecked` | 13 / 0 / 47 / 0 | 56 |
| 30 | `add_fresh_counterparty_backing_steps_unchecked` | 15 / 0 / 45 / 0 | 46 |
| 31 | `add_loser_paid_counterparty_backing_unchecked` | 11 / 0 / 49 / 0 | 69 |
| 32 | `add_loser_paid_counterparty_backing_payments_unchecked` | 9 / 0 / 51 / 0 | 50 |
| 33 | `expire_source_backing_bucket_not_atomic` | 8 / 0 / 52 / 0 | 59 |
| 34 | `credit_post_snapshot_residual_not_atomic` | 8 / 44 / 8 / 0 | 23 |
| 35 | `release_source_credit_lien_from_counterparty_terminal_not_atomic` | 7 / 31 / 22 / 0 | 29 |
| 36 | `consume_source_credit_lien_from_counterparty_core_not_atomic` | 4 / 30 / 26 / 0 | 32 |
| 37 | `release_source_credit_lien_from_insurance_core_not_atomic` | 6 / 27 / 27 / 0 | 40 |
| 38 | `release_source_credit_lien_from_insurance_terminal_not_atomic` | 5 / 21 / 34 / 0 | 9 |
| 39 | `create_and_consume_source_credit_from_counterparty_core_not_atomic` | 4 / 27 / 29 / 0 | 45 |
| 40 | `create_and_consume_source_credit_from_counterparty_parts_not_atomic` | 24 / 0 / 36 / 0 | 116 |
| 41 | `create_and_consume_source_credit_from_insurance_core_not_atomic` | 1 / 26 / 33 / 0 | 10 |
| 42 | `create_and_consume_source_credit_from_insurance_parts_not_atomic` | 21 / 0 / 39 / 0 | 113 |
| 43 | `TokenValueFlowProofV16::validate_insurance_to_close_insurance_spent` | 0 / 56 / 4 / 0 | 0 |
| 44 | `source_credit_available_backing_num` | 0 / 47 / 13 / 0 | 0 |
| 45 | `face_claim_to_burn_for_support` | 0 / 38 / 22 / 0 | 0 |
| 46 | `twin_loser_paid_share_num` | 0 / 46 / 14 / 0 | 0 |
| 47 | `loss_bucket_accepts_fresh` | 0 / 45 / 15 / 0 | 0 |
| 48 | `resolved_loss_backing_capacity_num` | 0 / 47 / 13 / 0 | 0 |
| 49 | `pending_domain_loss_barrier_count, has_pending_domain_loss_barrier` | 0 / 52 / 5 / 3 | 0 |
| 50 | `kf_loss_lien_backing_to_consume_num` | 0 / 37 / 6 / 17 | 0 |
| 51 | `add_account_u128_counter` | 0 / 55 / 5 / 0 | 0 |
| 52 | `PortfolioV16View::source_domain_slot` | 0 / 60 / 0 / 0 | 0 |
| 53 | `PortfolioV16ViewMut::source_domain_slot` | 0 / 56 / 4 / 0 | 0 |
| 54 | `PortfolioV16ViewMut::source_domain_slot_or_insert` | 35 / 25 / 0 / 0 | 154 |
| 55 | `PortfolioV16ViewMut::reset_source_domain_slot_if_empty` | 0 / 60 / 0 / 0 | 1 |
| 56 | `account_source_claim_bound_sum_num, account_has_source_claims` | 0 / 60 / 0 / 0 | 0 |
| 57 | `source_claim_unliened_num` | 0 / 59 / 1 / 0 | 0 |
| 58 | `slot_unliened_claim_num` | 0 / 60 / 0 / 0 | 0 |
| 59 | `PortfolioSourceDomainV16Account::is_sparse_tail_default` | 0 / 60 / 0 / 0 | 0 |
| 60 | `has_b_stale_leg` | 0 / 60 / 0 / 0 | 0 |
| 61 | `active_leg_slot_for_asset` | 0 / 58 / 2 / 0 | 0 |
| 62 | `require_active_leg_slot_for_asset` | 0 / 18 / 42 / 0 | 0 |
| 63 | `active_leg_for_asset` | 0 / 60 / 0 / 0 | 0 |
| 64 | `asset_state` | 0 / 54 / 6 / 0 | 0 |
| 65 | `CloseProgressLedgerV16::has_pending_residual` | 0 / 58 / 2 / 0 | 0 |
| 66 | `ensure_account_source_claim_market_id` | 20 / 29 / 11 / 0 | 105 |
| 67 | `collect_account_backing_utilization_fee_for_domain_not_atomic` | 7 / 44 / 9 / 0 | 42 |
| 69 | `V16Core::prepare_account_counterparty_lien_impairment` | 5 / 52 / 3 / 0 | 23 |
| 70 | `V16Core::prepare_counterparty_impaired_lien_retirement_delta` | 8 / 29 / 23 / 0 | 21 |
| 71 | `retire_source_credit_lien_from_counterparty_impaired_not_atomic` | 3 / 32 / 25 / 0 | 16 |
| 72 | `release_or_retire_counterparty_lien_backing_not_atomic` | 8 / 41 / 11 / 0 | 38 |
| 73 | `burn_impaired_account_source_claim_fields` | 15 / 44 / 1 / 0 | 51 |
| 74 | `impair_account_source_credit_counterparty_lien_fields` | 19 / 18 / 23 / 0 | 102 |
| 75 | `reconcile_account_impaired_counterparty_lien_at_slot_not_atomic` | 5 / 50 / 5 / 0 | 36 |
| 76 | `reconcile_account_impaired_counterparty_liens_not_atomic` | 7 / 53 / 0 / 0 | 29 |
| 77 | `decrement_account_source_claim_for_domain_not_atomic` | 17 / 31 / 12 / 0 | 74 |
| 78 | `burn_account_source_lien_face_not_atomic` | 9 / 33 / 18 / 0 | 55 |
| 79 | `burn_account_source_claim_at_slot_up_to` | 17 / 30 / 13 / 0 | 103 |
| 80 | `burn_account_source_claim_bound_num` | 20 / 28 / 12 / 0 | 83 |
| 81 | `burn_account_source_claim_bound_num_domain_first` | 16 / 30 / 14 / 0 | 108 |
| 82 | `source_domain_prospective_support_for_face` | 0 / 44 / 16 / 0 | 0 |
| 83 | `consume_source_domain_credit_for_effective_not_atomic` | 7 / 29 / 24 / 0 | 62 |
| 84 | `consume_validated_account_source_credit_not_atomic` | 1 / 34 / 25 / 0 | 21 |
| 85 | `set_account_pnl` | 27 / 13 / 20 / 0 | 145 |
| 86 | `set_account_pnl_with_source` | 28 / 13 / 19 / 0 | 147 |
| 87 | `set_account_pnl_after_source_claim_burn` | 39 / 10 / 11 / 0 | 175 |
| 88 | `set_account_pnl_after_kf_loss_claim_burn` | 29 / 17 / 14 / 0 | 187 |
| 89 | `set_account_pnl_after_domain_first_source_claim_burn` | 36 / 17 / 7 / 0 | 194 |
| 90 | `record_account_funding_flow` | 48 / 12 / 0 / 0 | 261 |
| 91 | `settle_kf_loss_before_support_not_atomic` | 4 / 55 / 1 / 0 | 22 |
| 92 | `net_slot_face_at_par_not_atomic` | 3 / 50 / 0 / 7 | 15 |
| 93 | `cancel_loss_domain_face_at_par_not_atomic` | 3 / 11 / 14 / 32 | 19 |
| 94 | `pay_kf_loss_from_free_capital_not_atomic` | 11 / 31 / 18 / 0 | 61 |
| 95 | `apply_haircut_bounded_close_loss_to_pnl` | 25 / 27 / 8 / 0 | 152 |
| 96 | `apply_signed_kf_delta_to_pnl` | 22 / 27 / 11 / 0 | 131 |
| 97 | `reserve_new_capital_backed_loss_for_source_domain_not_atomic` | 5 / 25 / 30 / 0 | 31 |
| 98 | `book_kf_loss_support_for_source_domain_not_atomic` | 9 / 39 / 12 / 0 | 65 |
| 99 | `book_realized_kf_loss_for_source_domain_not_atomic` | 13 / 30 / 17 / 0 | 61 |
| 100 | `prepare_account_kf_settlement_entry` | 1 / 25 / 34 / 0 | 3 |
| 101 | `prepare_account_kf_settlement_entry + apply_account_kf_settlement_entry` | 10 / 0 / 50 / 0 | 54 |
| 102 | `begin_full_drain_reset_inner` | 10 / 0 / 42 / 8 | 48 |
| 103 | `b_target_for_leg` | 0 / 56 / 4 / 0 | 0 |
| 104 | `mark_account_b_stale` | 44 / 16 / 0 / 0 | 215 |
| 105 | `clear_account_b_stale` | 11 / 28 / 21 / 0 | 48 |
| 106 | `mark_leg_b_stale` | 47 / 7 / 6 / 0 | 262 |
| 107 | `account_b_settlement_chunk` | 0 / 30 / 30 / 0 | 0 |
| 108 | `settle_account_b_chunk` | 11 / 11 / 38 / 0 | 58 |
| 109 | `settle_account_kf_effects_not_atomic` | 17 / 1 / 42 / 0 | 80 |
| 110 | `settle_account_side_effects_not_atomic` | 10 / 0 / 50 / 0 | 37 |
| 68 | `validate_shape and validate_with_market (the validity of the generated states)` | 0 / 32 / 28 / 0 | 0 |

`expire_source_backing_bucket_not_atomic` is also compared with the reference binary through UpdateAssetLifecycle's
retirement (`percolator-v16-lifecycle.test.ts`, 300 generated states, 139 successes).

### Branch coverage of the port's settlement functions

`scripts/percolator-v16-reference/coverage.ts` writes a copy of the port (under `.typesol/coverage/`, ignored by git)
in which every function of primitives.ts, impairment.ts, claims.ts, kfsettle.ts and settlement.ts logs a probe on
entry, every `if` one in each arm (an else-arm added where there is none) and every loop one when its body runs
(`log64(0xc0de, id, …)`). The probed program gives the same answers (the same bytes and errors; only its logs and
compute units differ), and the probes a transaction reached are read from its log lines, failed transactions
included. Not probed: the arms of `?:` and the operands of `&&` and `||` (a refusal written as one `if` with `||` is
one branch). Two runs use it:

```sh
# the function-level vectors: the probed fixture, the report per function
PERCOLATOR_V16_PRIMITIVE_ANSWERS=/tmp/p.txt PERCOLATOR_V16_COVERAGE=/tmp/cov.txt pnpm vitest run showcase/test/percolator-v16-primitives.test.ts --maxWorkers=2
# the comparison with the reference binary: the probed port as the Diff's program (probe lines left out of the log
# comparison, compute units only recorded)
PERCOLATOR_V16_PORT_COVERAGE=/tmp/bcov.txt pnpm vitest run showcase/test/percolator-v16-refresh.test.ts --maxWorkers=2
```

Last runs (836 probes in the five files): the host vectors reached 744 (committed, 60 per function) and 759 (300 per
function); the reference-binary comparison of the large state runs below reached 580 (2,000 states and 3,000 with open legs) and 508 (5,000 mutations); 766 were reached by one run or another. The probes neither reached
are listed in "Branches not reached" below, each with the reason.

### The settlement of open legs against the reference binary

SyncMaintenanceFee and Withdraw run `settle_account_side_effects_not_atomic` (no placeholder remains), so the
settlement is compared with the reference binary transaction by transaction on generated states
(`percolator-v16-refresh.test.ts`): the 400 states of before (PERCOLATOR_V16_STATE_FUZZ) and 300 states with open legs
the fee settles (PERCOLATOR_V16_OPEN_STATES: `generate(…, open)`: Live nine times in ten, every portfolio with one or
two legs, the fee slot behind the anchor, the assets' K, F and B indices a step of any sign and size from the legs'
snapshots, stale K/F cohorts with their counts, ledgers for the market's four domains and claims and liens for both
portfolios nine times in ten), each with SyncMaintenanceFee (no cranker, itself, the other portfolio), Withdraw,
Deposit or ClosePortfolio; the mutation fuzzer (`percolator-v16-walk.test.ts`) starts a fifth of its transactions
from generated states, six in ten of them with open legs, now and then with one field mutated after. A success
"settled legs" when a leg's snapshots moved.

Large run (PERCOLATOR_V16_STATE_FUZZ=2000, PERCOLATOR_V16_OPEN_STATES=3000, PERCOLATOR_V16_MUTATIONS=5000), every
transaction compared whole with the reference binary, none pinned (the placeholder is gone): of the 3,000 states with
open legs, 2,090 of the 2,685 Live ones pass the validators; 810 transactions succeeded in both (SyncMaintenanceFee
558 of 1,803, Withdraw 86 of 580, Deposit 166 of 330, ClosePortfolio 0 of 287), and 328 of the successes settled legs
(SyncMaintenanceFee 316, Withdraw 12: its fee sync settles, then a portfolio whose legs it closed out withdraws); the
SyncMaintenanceFee refusals on Live states with legs, alike in both, were EngineCounterUnderflow 343, EngineInvalidLeg
157, EngineHiddenLeg 113, EngineLockActive 95, EngineArithmeticOverflow 84, OracleStale 80, InvalidAccountData 44,
EngineInvalidConfig 69, EngineCounterOverflow 47, EngineStale 46, EngineBStale 43 (a settlement stopped at a B chunk).
Of the 2,000 ordinary states, 33 successes settled legs. The mutation fuzzer: 5,000 transactions (998 from generated
states), 2,340 successes, all alike. No disagreement with the reference binary was found in any of these runs. The
same 3,000 open-leg states without probes, compute units judged: the same outcomes, and the port used fewer compute units on every one of the 2,908 successes (the probes' Deposit of 0 included): SyncMaintenanceFee 558 successes, mean 170,907 CU in the reference and 65,934 in the port, worst 565,641 against 194,948; Withdraw 86, mean 35,517 against 12,167, worst 302,606 against 101,134.

### Branches not reached

Probes reached by neither the host vectors nor the binary comparison (70 of 836), from reading, each unreachable from
a state the validators accept, except where said:

- **Refusals the values they test exclude.** Each subtracts or adds what the same function bounded just before, or
  what `validate_with_market` and the market's shape bound: claims.ts 202–216 (the lien's fields after a burn plan
  formed from them), 224 (atoms consumed, at most the release), 419/421 and primitives.ts 1031 (a slot's liened and
  impaired claims within its bound: the lien proof), 442/444 (the face for an amount taken from the realizable support
  is at most the unliened claim), 448–467 (sums bounded by the credit asked for, and the original's own consistency
  check), 521–537 (totals below the bound total, which is checked first), impairment.ts 83/86/173 (the lien proof),
  kfsettle.ts 152 (values at most a PnL), 259 (a domain without claims has rate one: the stored rate is validated
  against it), 267 (the owed atoms are at most the available backing), 275 (with full backing at rate one the transfer
  is the netted face), 279 (the netting is at most the unliened claim), 305/347 (sums bounded by the loss and the
  claims), 470 (a new loss is not positive), 516/525/575/563/581 (support at most the loss; bounds below u128), 663/670
  (a leg the preparation just read and decoded), 681 (a loss at most |net|), primitives.ts 407/419/420/493/565/863/
  1018 (the ledger's shape, checked before), 660 (an expiry only lowers the fresh backing).
- **Bytes the validators decode first.** claims.ts 570, settlement.ts 61/75 and kfsettle.ts 404 (bool bytes:
  `validate_with_market` and the market's shape refuse anything but 0 and 1), kfsettle.ts 546 (a K/F net of
  i128::MIN: refused in its computation), primitives.ts 126 (an asset of a configured domain past the view: the shape
  refuses a capacity below the configured slots), 1092 (two active legs of one asset: HiddenLeg in the validation),
  settlement.ts 153 (a single active bit past the 16 legs: HiddenLeg).
- **Arguments the settlement never passes.** kfsettle.ts 158 (crystallizing nothing), primitives.ts 957/984 (a domain
  above u32: the settlement's domains come from u32 fields).
- **Reachable, not reached.** claims.ts 294/295/302 (a burn across the slots that runs past them: the claim sum covers
  it, so only a state whose total and slots disagree, which the validators do not compare, gets there); claims.ts 562
  and settlement.ts 66 (a count of negative-PnL or B-stale accounts at u64::MAX: the validators do not bound the
  counts, no sequence of instructions reaches them); settlement.ts 124 (a B chunk's loss above i128::MAX: a public B
  chunk near u128::MAX in the config); kfsettle.ts 283 (the second of two backing transfers in one loss netting whose
  bucket expiry is not earlier than the first's: the twin's and a fully backed domain's, both live Fresh with movable
  backing, in one portfolio).


### TradeNoCpi and ConvertReleasedPnl against the reference binary

```sh
npx vitest run showcase/test/percolator-v16-trade.test.ts --maxWorkers=2
npx vitest run showcase/test/percolator-v16-trade-walk.test.ts --maxWorkers=2
```

`percolator-v16-trade.test.ts`, six tests, every transaction compared whole: the routes (open, increase, reduce, flip,
close, long first and short first, on two assets: 20 successes); 14 legs on one portfolio opened and closed one by one
(the reference's cost of the open grows from 127,036 to 388,005 CU, the port's from 77,151 to 101,865; InitMarket
refuses 15 and 16 assets per portfolio, EngineInvalidConfig, in both); the bounds of size (0 and i128::MIN
InvalidInstruction; ±10^14 succeed; ±(10^14 + 1) and i128::MAX EngineInvalidConfig), print (0 and above 10^12
OracleInvalid), fee (above the market's 500 bps InvalidInstruction, also under a base-fee policy of 30 for 0 and 29),
backing cap (above 10,000 InvalidInstruction); the initial margin to the unit (a trade of 10^6 at price 1.0 and 20%
needs 200,000 of each party: 199,999 on either side is EngineInvalidConfig, the initial-margin gate; again with a fee of
1 bps); every ordered pair of the five account positions, each flag dropped, strangers as signers, the signers swapped,
0 to 4 and 6 accounts, one owner with two portfolios; ids, epochs, assets, market ids, a body a byte short or long.

`percolator-v16-trade-walk.test.ts`, the random walk on real state (`PERCOLATOR_V16_TRADE_STEPS`, 600, ×
`PERCOLATOR_V16_TRADE_SEEDS`, 2) and a mutation fuzzer (`PERCOLATOR_V16_TRADE_MUTATIONS`, 600). Each walk runs episodes on
fresh markets of three assets (asset 0 AuthMark, asset 1 an EWMA mark, asset 2 a hybrid on the world's four external
oracle accounts), funding enabled (10,000 e9 a slot at most), marks of 10 e6 (so that the per-slot price cap stays below
one unit for many slots: the zero-move funding path then accrues funding while the price stays put), four portfolios
funded with 10^10: phase 1, the Clock still, trades of every kind between random portfolios on the three assets (sizes
from 1 to the cap and past it, prints at the price ±10% and at the bounds, fees from 0 to past the maximum, a tenth with
corrupted data or accounts), mark pushes at the price, deposits, policy updates, lifecycle changes; phase 2 (four
episodes in five), marks of assets 0 and 1 pushed away from the prices and the Clock moved one slot at a time, each slot
a reducing trade between opposite holders of each asset (its zero-move path accrues the funding and settles both
legs), the portfolios synced, now and then a conversion, a withdrawal or a lifecycle change with legs open; phase 3, the
marks back, every position closed against an opposite one, the closing parties' released PnL converted straight after,
the flat portfolios withdrawing. What a run produced is counted from the reference's accounts before and after each
success: legs whose K or F snapshot a later instruction moved ("settled"), funding-epoch advances (accruals with open
interest), PnL changes, certificates written, certificates whose equity is below capital + PnL − fee debt (the haircut:
positive PnL counts only as far as its source claims realize), portfolios holding source claims after a success.

The default run of the last full test run, and a run of 2 × 2,500 steps with branch probes on the port's trade,
certificate and settlement files (`PERCOLATOR_V16_PORT_COVERAGE`, `PERCOLATOR_V16_PORT_COVERAGE_FILES`: the probes'
compute units are only recorded), every transaction compared whole:

| Run | Transactions | TradeNoCpi | ConvertReleasedPnl | SyncMaintenanceFee | Withdraw | Settled legs | Funding accruals | PnL changes | Certificates written | Haircut certificates | Source-claim holders |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| default, seed 1649 (600 steps) | 669 | 205/293 | 2/53 | 73/200 | 12/17 | 182 | 91 | 93 | 372 | 118 | 154 |
| default, seed 2662 (600 steps) | 647 | 274/366 | 1/31 | 44/156 | 4/14 | 194 | 81 | 84 | 548 | 4 | 286 |
| probed, seed 1649 (2,500 steps) | 2,648 | 974/1,390 | 11/173 | 228/664 | 36/57 | 842 | 315 | 366 | 1,909 | 317 | 977 |
| probed, seed 2662 (2,500 steps) | 2,618 | 1,084/1,403 | 11/145 | 232/715 | 28/51 | 1,009 | 377 | 540 | 2,167 | 467 | 1,480 |

TradeNoCpi's refusals in the probed run (both seeds), alike in both programs: EngineInvalidConfig 181 (the request's
bounds and the initial margin), InvalidInstruction 145 (fees past the maximum, a cap past 10,000, sizes 0 and
i128::MIN, mutated data), OracleInvalid 100, EngineLockActive 151 (growth on a lagging or loss-stale asset, the preflight
gates), AssetGenerationMismatch 27, NotEnoughAccountKeys 25, EngineStale 47, and fewer of the rest. ConvertReleasedPnl's
22 successes convert claims whose support losers' capital-backed losses booked; its refusals are EngineLockActive 220
(nothing realizable, an exposure or the H-lock lane) and EngineStale 72 (a certificate an epoch has passed). The
mutation fuzzer starts each transaction (a trade, a conversion, a sync or a withdrawal) from one snapshot whose open
positions, PnL, certificates and source claims trades made, with its accounts, data or state mutated (a field of the
market's group header, asset slots or oracle profiles, or of a portfolio's state, set to a boundary value): 600 transactions in the last run (210 with their accounts, 199 with their data and 191 with their state mutated), 42 succeeding in both, every one alike.

**Branches the walk reaches.** In the probed run, 871 of the 2,083 probes of accrual.ts, the settlement's files and the
four new ones were reached on real state: trade.ts 215 of 442, trading.ts 221 of 406, health.ts 125 of 204, convert.ts
53 of 77; primitives.ts 91 of 288, impairment.ts 6 of 69, claims.ts 52 of 201, kfsettle.ts 61 of 225, settlement.ts 19
of 59. None of the settlement's 70 probes listed below as not reached became reached: the walk's states are narrower
than the generated ones (no impaired liens, no counterparty backing buckets: no ported instruction makes one). The
accrual's price-move branch is still not reached: `accrueAssetTo` is entered only by a shutdown, and the trade's
accrual path (`accrueAssetPath`) never moves the price, since the zero-move path the trade takes refuses any path that
moves it (NOTES.md section 12); its price-move counters stay at zero in every run. Only the crank moves an effective
price (its section below). Not entered by any compared transaction: the trade's initial-margin source liens
(`createInitialMarginLienIfNeeded` and below), its terminal close-progress ledger, a leg retained as a pending
obligation, and the backing-domain fee charge (README, "What is not verified", says what each needs).

### PermissionlessCrank and FinalizeResetSide against the reference binary

```sh
npx vitest run showcase/test/percolator-v16-crank.test.ts --maxWorkers=1
npx vitest run showcase/test/percolator-v16-crank-walk.test.ts --maxWorkers=1
# a large run: PERCOLATOR_V16_CRANK_STEPS=8000 PERCOLATOR_V16_CRANK_SEEDS=3 PERCOLATOR_V16_CRANK_MUTATIONS=3000
```

The crank world (`percolator-v16-crank-world.ts`): a market of three configured assets in a capacity of four (asset 0
AuthMark, asset 1 an EWMA mark, asset 2 a hybrid on one to three of the world's external oracle accounts), funding
(10,000 e9 a slot at most), a price cap of 50 bps a slot, an accrual segment of 8 slots, initial and maintenance margins
of 10% and 5%, a liquidation fee of 1% capped at 100,000 atoms (the solvency envelope needs the maintenance floor of
10^6 beside it), a maintenance fee of one atom a slot, four portfolios funded with 10^10.

**Dedicated tests** (`percolator-v16-crank.test.ts`), each transaction compared whole:

- cranks of flat portfolios and of portfolios with legs on the three assets while marks and the oracle accounts move
  (168 transactions);
- liquidation as a mark falls (partial, the cranker's portfolio paid half the fee from the insurance), a short squeezed
  as a mark rises (a partial close, then a partial close each slot as the price keeps moving), and two bankruptcies (a
  long and a short left uncranked while the price runs past their capital, then liquidated whole: the insurance drawn,
  the close-progress ledger opened, the residual booked into the other side's B index, its A index scaled down and the
  side turned DrainOnly), each portfolio cranked twice in a row a slot;
- hint shapes in three rounds of moving prices: none, one, the hybrid with its legs, all three, reversed, repeated,
  an unconfigured asset, one past the capacity, the hybrid short of a leg or with one too many, accounts missing or
  left over, legs out of order, a managed asset given an account, 16 hints; the hybrid's oracle accounts stale, published
  ahead of the Clock, malformed, the market, the portfolio and the owner as a leg; gaps of 20 to 100,000 slots (the
  soft-stale window and the market's stale window matured) with and without fresh legs and without a hint; every ordered
  pair of the six positions of a crank with a hybrid hint and a cranker's portfolio, the later position given the
  earlier one's account; too few accounts, the market or the portfolio read-only, the owner not signing, a portfolio of
  another market, an uninitialized one;
- the maximum shape: a portfolio with a leg on each of 14 assets cranked with 14 hints and its counterparties with
  five (TESTING section on compute units in the README); FinalizeResetSide on Normal sides and its refusals.

**The walk** (`percolator-v16-crank-walk.test.ts`; its head says what each step does). Tallies, from the reference's
accounts before and after each success: settled legs (K or F snapshot moved), accruals with open interest, effective
price moves, PnL changes, certificates written, haircut certificates, liquidations (a position the crank lowered:
partial, or to zero), socialised losses (a B index raised), side resets (a side turned ResetPending), sides finalized,
B chunks (a leg's B snapshot moved), close ledgers opened, Recoveries, cranker rewards (another portfolio's capital
raised by a crank), impaired liens. The default run of the last full test run:

| Run | Transactions | Cranks ok | Settled | Accruals with OI | Price moves | PnL changes | Certificates | Haircut | Liquidations partial / full | Side resets | Finalized | Cranker rewards |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| default, seed 1695 (1,500 steps) | 1,556 | 468/1,005 | 1,017 | 399 | 373 | 383 | 585 | 397 | 24 / 14 | 3 | 1 | 11 |
| default, seed 3722 (1,500 steps) | 1,576 | 486/998 | 1,022 | 394 | 346 | 370 | 601 | 326 | 31 / 1 | 2 | 0 | 8 |
| large, seed 1695 (8,000 steps) | 8,270 | 2,485/5,477 | 4,981 | 1,967 | 1,797 | 1,936 | 3,095 | 1,848 | 126 / 45 | 14 | 5 | 50 |
| large, seed 3722 (8,000 steps) | 8,238 | 2,567/5,461 | 4,698 | 2,016 | 1,821 | 1,819 | 2,940 | 1,694 | 113 / 28 | 9 | 3 | 30 |
| large, seed 5749 (8,000 steps) | 8,264 | 2,552/5,435 | 4,724 | 2,080 | 1,888 | 1,890 | 3,074 | 1,903 | 127 / 37 | 14 | 4 | 36 |
| default, seed 1695, with resolutions (1,500 steps) | 1,871 | 440/993 | 770 | 302 | 277 | 300 | 560 | 356 | 11 / 10 | 2 | 1 | 4 |
| default, seed 3722, with resolutions (1,500 steps) | 1,661 | 450/1,004 | 876 | 414 | 391 | 357 | 526 | 325 | 16 / 11 | 3 | 1 | 6 |

The last two rows are the walk since markets leave Live in it (fewer slots of price moves per episode, as an episode
now ends with a resolution and a close-out). Leaving Live in those runs: seed 1695 one ResolveMarket with 4 legs open
(4 winners), 17 CloseResolved and 13 Resolved cranks succeeding, 8 payouts through receipts, 40,403,373,065 atoms paid;
ResolveStalePermissionless tried twelve times in another episode and refused alike (EngineStale: an accrual the
matured cranks could not bring, 11 of them refused with EngineStale too); seed 3722 one ResolveMarket with 3 legs
open (3 winners, 1 loser, 1 bankrupt), 7 CloseResolved and 13 Resolved cranks succeeding, 6 payouts (4 through
receipts), 40,533,128,589 atoms paid. No crank declared Recovery in these runs. The conservation check
(percolator-v16-terminal.ts `conservation`) ran in both VMs at the end of each episode and after every close-out
success and never failed.

The crank's refusals in the walk, alike in both programs: EngineNonProgress (nothing to do and no market accrued, or an
incomplete health observation), OracleStale (the hybrid's legs stale and the soft-stale window not matured),
InvalidInstruction (hint shapes), EngineStale. Not produced by the walk: a socialised loss (a B index raised), a close
ledger, a declared Recovery, a B chunk: the walk's liquidations come before the loss passes the capital; the dedicated
tests produce the first two and the side's DrainOnly mode. The mutation fuzzer starts each crank from a snapshot after
24 slots of marks moved against the longs of large opposite legs (stale certificates, deficits): 600 transactions in the default run (187 with their accounts, 190 with their data and 223 with their state mutated: a field of a portfolio, the group header, an asset slot, an oracle profile or the wrapper config set to a boundary value), 230 succeeding in both, every one alike; a run of 3,000: 1,022 with their accounts, 997 with their data and 981 with their state mutated, 1,188 succeeding in both, every one alike. Since the crank's Recovery and Resolved paths are ported, one mutated crank in five starts from the snapshot with the market in Recovery (a recorded reason) or Resolved (at the market's slot), a Resolved one sent by the portfolio's owner with the payout accounts: in the default run 64 Resolved and 51 in Recovery among the 600 (224 succeeding in both, every one alike).

**Branches the binary comparison reaches.** A probed run of the dedicated tests and the default walk
(`PERCOLATOR_V16_PORT_COVERAGE_FILES=crank.ts,autocrank.ts,liquidation.ts,health.ts,trade.ts,trading.ts,accrual.ts,external.ts`;
the report holds at least the probes the walk's process reached) reached 1,074 of 1,992 probes: crank.ts 99 of 130,
autocrank.ts 87 of 202, liquidation.ts 172 of 331, health.ts 149 of 237, trade.ts 219 of 450, trading.ts 207 of 409,
accrual.ts 57 of 115, external.ts 84 of 118. Against the trade walk's run (section above): health.ts 125 → 149 (the
crank's refresh, its price override, the lapsed scans' empty paths, the B-stale checks), trade.ts 215 → 219 (the
liquidation's reduction routes; a clear of a released obligation), accrual.ts now through the price-move branch (the
crank's accrual at a moving price: `accrueAssetPath` with moves, the epochs raised), external.ts through the reader's
crank-only branches (legs holding observations: the older and same-time refusals, partial advances, the fall-back to
the mark). Entered by no compared transaction in this run: ReleaseSourceLiens (`releaseSourceLiens`: a flat account
with liens a lien release can return, which needs a Fresh bucket or an insurance lien no ported path creates in the
walk), AdvanceClose (`advancePendingClose`: a close ledger still pending after the liquidation that opened it; the
liquidation books the whole residual in one chunk or declares Recovery first), the declaration of Recovery
(`declareRecovery`, `commitDeclared`), a Recovery asset's refresh (`refreshRecoveryAccount`: reached in an earlier walk
run, which first met it as a placeholder; not in this one), a matured resolution's terminal accrual (`resolveAccrual`:
the walk's keeper keeps the stale window from maturing), the lapsed-backing expiry (no Fresh bucket), and still the
trade's initial-margin source liens (`createInitialMarginLienIfNeeded`, `createAccountLienAny`), a leg retained as a
pending obligation (`retainLegAsPendingObligation`: a domain-loss barrier needs a pending close ledger, as AdvanceClose
does) and the backing-domain fee (`chargeAccountBackingFee`: a Fresh bucket). The bankrupt liquidation's insurance draw,
close ledger, residual booking and A scaling are entered by the dedicated bankruptcy tests (`bookResidualInternal`,
`advanceCloseLedger`, `clampCloseResidual`, `reduceMatchingOi`). The settlement's own files were not probed in this run, so
whether the crank reaches any of their "Branches not reached" above is not measured.

### The crank on markets in Recovery and Resolved, and the recovery and resolution instructions

```sh
npx vitest run showcase/test/percolator-v16-recovery.test.ts --maxWorkers=1
```

The shared steps are percolator-v16-terminal.ts: legs opened on the crank world's three assets and marks moved over a
dozen slots with portfolio 0 left uncranked while they move against it (a bankrupt portfolio); the market put into
Recovery by writing its mode and reason into both VMs (as a declaration leaves it); the owners' ForfeitRecoveryLeg
with budgets of 1, 10^3, 10^6, 10^12 and u128::MAX and the Recovery crank (hints none, the legs', nonsense: ignored)
until a crank resolves the market; ResolveMarket by the authority with cranks between refusals (a pending accrual is
EngineStale); ResolveStalePermissionless after ConfigurePermissionlessResolve shortens the stale window to 20–60 slots
and the Clock passes it, with matured cranks (hints without oracle accounts: the terminal accrual) between refusals;
the close-out of every portfolio by its owner (the Resolved crank with or without a hint, or CloseResolved, paying to
its token account), with the conservation check after each success. Every transaction compared whole.

The last run (seeds as printed; `PERCOLATOR_V16_SEED` replays the keys):

| Route | Seed | Legs open at resolution | Transactions | Forfeits ok | Close-out successes (crank / CloseResolved) | Payouts (through a receipt) | Paid | Conservation failures |
| --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: |
| declared Recovery | 2518 | 1 | 330 | 7 of 9 | 11 / 8 | 13 (13) | 39,999,999,938 | 0 |
| ResolveMarket | 2549 | 11 | 213 | | 16 / 14 | 11 (9) | 39,999,999,950 | 0 |
| ResolveStalePermissionless | 2580 | 12 | 275 | | 19 / 13 | 14 (13) | 39,994,672,315 | 0 |
| declared Recovery | 2611 | 0 | 282 | 10 of 12 | 13 / 8 | 14 (13) | 39,997,352,878 | 0 |
| ResolveMarket | 2642 | 9 | 216 | | 13 / 12 | 10 (8) | 39,999,999,950 | 0 |
| ResolveStalePermissionless | 2673 | 12 | 221 | | 14 / 8 | 6 (4) | 39,467,314,804 | 0 |

The refusals are alike in both: EngineNonProgress for a portfolio already closed out, EngineLockActive for a forfeit of
a live leg, EngineStale for a resolution an accrual must precede. Sweeps (each ordered pair of account positions, each
signer and writable flag dropped, each position replaced by each account of the world, the list cut and one longer,
and boundary values written over the body's fields): in Recovery ForfeitRecoveryLeg and the crank, and ForfeitRecoveryLeg
on the market made Live again, 689 transactions (237 succeeding in both); Resolved, CloseResolved and the crank of two
portfolios, 1,475 (868); Live, ResolveMarket and ResolveStalePermissionless before and after the window matures, 214
(6); RebalanceReduce 185 (21); CureAndCancelClose 335 (12). RebalanceReduce on real state: 120 attempts by owners while
prices move, 11 succeeding (the rest EngineLockActive, EngineNonProgress, EngineInvalidLeg alike). CureAndCancelClose
on 80 generated close ledgers (whole, one off, with progress, finalized, without the barrier, with an escrow; deposits
of 0, 1, 10^6 and 2^40 with and without the token accounts): 29 succeeding in both.

Not reached by these runs (no probed run of recovery.ts, resolved.ts, recoveries.ts, closeresolved.ts and
resolution.ts was made, so this is from the tallies and the states, not from branch probes): the Resolved crank's
expiry of a hinted asset's lapsed bucket and the source domains' preparation and realization with liens and claims on
backed domains (both need Fresh backing, which only TopUpBackingBucket makes: reached since it is ported, section below); ReleaseSourceLiens, AdvanceClose, the
terminal trade's close ledger, a leg retained as a pending obligation and the trade's initial-margin source liens on
generated states (asked for, not done in this work); a crank-declared Recovery in the walk.

### The insurance and backing-bucket instructions, and the terminal ones

The shared steps are percolator-v16-terminal.ts's `Reserves`: a source and a destination token account for each role
signer of the three configured assets, a backing-domain ledger per domain and an insurance ledger per insurance
authority (zeroed accounts of the program, created by the first instruction that names them), backing fee policies on
some domains (only while their buckets are empty), insurance on every asset and Fresh backing on every domain, and
transactions of each of the six instructions (and SyncBackingDomainLedger) with arguments drawn around the state:
signers right or wrong, intents newer or not, generations and policies as stored or off by one, expiries at the
bucket's, new, past or u64::MAX, amounts of 0, 1, part, all and more than there is, ledgers given or not, domains past
the configured ones; `windDown` ends a Resolved market (claims and reserve moves between, every portfolio closed by the
market authority, the exact drains of earnings and insurance, then CloseSlab until a tombstone, the Clock moved past a
live bucket's horizon after refusals). Every transaction compared whole.

- `percolator-v16-reserves.test.ts`: 60 of the six instructions on a fresh market, then 200 among trades, pushed marks
  and cranks (the legs that lien backing and earn its fees), the conservation checked after each; account and data
  sweeps of a valid transaction of each.
- `percolator-v16-terminal.test.ts`: three funded markets resolved, closed out (ClaimResolvedPayoutTopup between) and
  closed by CloseSlab; sweeps of ClaimResolvedPayoutTopup and of CloseSlab with portfolios left and at each terminal
  step; SwapSecondaryForPrimary and CloseSlab with a second mint on the world's empty market (UpdateBaseUnitMints first);
  ForceCloseAbandonedAsset on a shut-down asset (before the delay, then pairs and the residue, its sweep); reserves
  without legs (Live withdrawals, the admin's drain of an empty shut-down asset before and after the delay, every
  portfolio closed, the Resolved surplus withdrawn by an unsigned beneficiary, CloseSlab parked on live backing, then
  expired, drained and closed); five markets where portfolio 0's loss runs past its capital with no insurance and
  backing only on asset 2's domains, resolved, half closed out within the backing's resolved horizon, the backing then
  lapsing through the Resolved crank's hinted expiry, and the owners' claims at once.
- `percolator-v16-gaps.test.ts`: six markets with small B chunks and bankrupt-close steps, portfolio 0 at its initial
  margin on two assets and left uncranked while both marks run against it, then cranked with the others for up to 120
  slots, resolved (or its Recovery forfeited and resolved), closed out and closed.
- The crank walk now funds most episodes' reserves, sends one of the six instructions on a third of its slots, shuts an
  asset down now and then and force-closes its legs, resolves 75% of the episodes still Live
  (`PERCOLATOR_V16_CRANK_RESOLVE`), and winds each Resolved market down to a tombstone; the trade walk and every test
  that collects the conservation check now assert it is empty.

The last run (2026-11-18; the keys from a seed drawn per run, the scenarios' seeds as printed), every transaction
alike in both programs and every success cheaper in the port:

- reserves: 559 transactions; successes TopUpBackingBucket 42, TopUpInsurance 28, TopUpInsuranceDomain 17,
  WithdrawBackingBucket 3, WithdrawInsuranceAsset 2 (the Live withdrawals refused EngineLockActive once legs carry
  loss state, as the health gate says; WithdrawBackingBucketEarnings succeeded in other runs, 8 in one); sweeps 2,989
  transactions, 80 succeeding in both.
- terminal: the three funded markets and the five haircut markets all closed by CloseSlab (eight tombstones, the
  vault's retired value burned through the mint); ClaimResolvedPayoutTopup paid a top-up three times (seed 6231: a
  payout rate of 0 at the snapshot, raised to full by the backing's lapse; since 2026-11-20 asserted for that seed,
  and for every haircut seed a payout with a receipt, the snapshot captured and CloseSlab); the second mint swapped and both vaults
  swept and closed; ForceCloseAbandonedAsset 3 successes before the shut-down asset was flat (then EngineNonProgress),
  its sweep 303 transactions (90 succeeding); reserves without legs closed (Live, admin-drain and Resolved-surplus
  withdrawals all succeeding).
- gaps: in three of six seeds portfolio 0 ended with negative PnL and no capital (an uncovered loss left on the
  account by a whole liquidation; in the other three it was liquidated before its loss passed its capital); none
  opened a close ledger or declared Recovery; five of
  six markets were closed by CloseSlab (one wind-down stopped on a portfolio it could not close: alike in both). Since
  2026-11-20 the test asserts these per seed (seeds 0 to 2 the uncovered loss, every seed but 3 CloseSlab, every
  market resolved); the tallies of close ledgers, B-index changes and declarations it was written to reach are printed
  and not asserted (0 in every run so far).
- crank walk (default size): seed 1695, 5 episodes, 4 markets resolved and all 4 closed to tombstones,
  ForceCloseAbandonedAsset 22 of 30; seed 3722, 3 episodes, 1 resolved and closed, ForceCloseAbandonedAsset 20 of 32;
  conservation failures 0 (asserted).


**Branches the binary comparison reaches.** A probed run (`PERCOLATOR_V16_PORT_COVERAGE`, one report per file,
merged: a probe counts once any run reached it) of `percolator-v16-reserves`, `-terminal`, `-gaps`, `-crank-walk`
(default size), `-recovery` and `-crank` over the files of this package and the last two
(`PERCOLATOR_V16_PORT_COVERAGE_FILES=reserves.ts,terminal.ts,recovery.ts,recoveries.ts,resolved.ts,closeresolved.ts,resolution.ts,crank.ts,autocrank.ts,liquidation.ts,trade.ts,trading.ts,health.ts`)
reached 1,638 of 2,510 probes: reserves.ts 150/191, terminal.ts 68/91, recovery.ts 48/90, recoveries.ts 44/63,
resolved.ts 200/311, closeresolved.ts 9/9, resolution.ts 7/8, crank.ts 118/133, autocrank.ts 103/186,
liquidation.ts 176/332, trade.ts 287/450, trading.ts 269/409, health.ts 159/237. (A run without the trade files, the
same tests but gaps: 913 of 1,414.)

Of the paths the previous work left unentered, Fresh backing through TopUpBackingBucket now brings these into compared
transactions: the lapsed-backing expiry of the crank's refresh (`expireFirstLapsedSourceBacking`, 877 entries), the
Resolved crank's lapsed-bucket expiry from a hint (`firstLapsedForAsset`), the source domains' preparation and
realization on backed domains (`prepareOneSourceDomain`, `realizeOneSourceDomain`), the trade's initial-margin source
liens (`createInitialMarginLienIfNeeded`, `createAccountLienAny`: two liens created) and the terminal trade's close
ledger (`beginCloseProgressLedger`, four times). Still entered by no compared transaction: ReleaseSourceLiens
(`releaseSourceLiens`, `flatLienNormalization`: a flat account whose liens a release returns; the two liens above were
on accounts that kept a leg), AdvanceClose (`advancePendingClose`), the declaration of Recovery by a crank
(`declareRecovery`, `commitDeclared`: the gap test's bankrupt portfolios, left with negative PnL and no capital, were
liquidated whole with the uncovered loss left on the account, no close ledger, in every seed), a leg retained as a
pending obligation (`retainLegAsPendingObligation`, `retainAsPendingObligation`: a domain-loss barrier needs a pending
close ledger), the backing-domain fee of a trade (`chargeAccountBackingFee`: a counterparty-backed lien a trade
creates; the walks' trades with backed domains did not create one), a source lien's release for a domain at the
resolved close (`releaseAccountLienForDomain`), the recertification after a source lien (`recertifyAfterSourceLienChange`:
the two lien creations failed their later checks before it). In this package's files: the native mint's residue path
(the tests' mints are not the native mint), the scan's wait at its start (LockActive) and its continuation past 256
assets (four configured), `withdrawFreshBacking`'s emptied-bucket statuses (Impaired, Expired), the recredit's
overflow and underflow refusals (bounded by the values just checked), ForceCloseAbandonedAsset's pair with a zero
effective quantity.

The unreached probes, by file and function (line numbers of the files as committed; "never entered" for a function
whose entry probe no run reached):
- **autocrank.ts**: `selectedAssets` 183 195; `flatLienNormalization` never entered; `readDomainParts` never entered; `hasNormalizableLien` 246 250; `buildSummary` 265; `highestRiskLiquidatable` 323 324 326 328; `releaseSourceLiens` never entered; `validateMarketTail` 431; `crankStart` 439; `crankRefresh` 452 461; `refreshRecoveryAccount` 475 476 477 479; `legSlotOf` 502 504; `autoCrank` 545 565 567 575 582 589 590 591 608 645 649 655 660 667 669 674; `compactDomains` never entered; `commitDecodes` never entered; `finalizeSideReset` 714 715 716 717 718 721 726 734
- **crank.ts**: `resolveAccrual` 238; `hybridTarget` 279; `rejectIncompleteAsset` 322; `positionsChanged` 400; `crankZeroCopy` 494 499 508; `observe` 638 639 677 679; `crankAfterObservations` 720 769
- **health.ts**: `riskNotionalCeil` 146; `adlEffectiveQuantityCeil` 170; `effectiveAbsQuantityForLeg` 180 186; `healthRequirements` 213; `lienEffectiveSupporting` 228 232 234; `accountSourceRealizableSupport` 245 252 253 255 257 260 261 262 268 269 273; `accountHaircutEquity` 290 291 298 302 303 304; `computeHealthCert` 349 357; `recertifyAfterTradeDelta` 373; `replaceTerm` 399 401; `recertifyAfterSourceLienChange` never entered; `certCurrentErr` 427; `ensureFavorableCurrentCert` never entered; `accountHasLossStaleLiveLeg` 468; `accountTouchesBarrier` 481; `accountHLockMax` 499 501 504 505 507; `scalarPreflight` 524 533 535 536 537; `clearAccountStale` 547 550; `collectBackingUtilizationFees` 564 566; `refreshAndCertify` 617 620 621 622 628 650 653 656 660 666 670 672 674 679 680 685 696 705; `firstLapsedRoster` 726; `settleForPositionAction` 782
- **liquidation.ts**: `declareRecovery` never entered; `declareAndReturn` never entered; `commitDeclared` never entered; `liqNotionalCeil` 187 188; `legMaintenance` 197 204; `liqFeeOrFloor` 217 220; `projectedHealthy` 250 254 256 258 260 262 264 266; `configMulDivCeil` 280 283; `minQForNotional` 290 291 293; `partialSearchHi` 300; `closeRequestQ` 313 318; `riskScore` 345 350 351; `validateProgress` 371 372 374; `reduceMatchingOi` 398 404 409; `reducePosition` 433 435 438; `certifyAfterLocalSettlement` 456; `chargeAccountFee` 471 475; `consumeDomainInsurance` 512 513 515; `bankruptcyCapacity` 532 533 539 542 544 546 550 553; `bookResidualInternal` 574 575 586 589 594 596 603 618; `ensureCloseNotExpired` 634 636; `ensureCloseSnapshotCurrent` 646 649 652 654; `advanceCloseLedgerFull` 688 690 694 695 707 710 712 714 716 728 732; `clampCloseResidual` 751 754 755 758 768 769 776; `bookResidualForAccount` 791 795 796 802 804 806 807 809 810; `residualExceedsOneStep` 827; `liquidate` 849 851 856 862 867 885 886 888 892 895 899 903 911 912 914 920 925 926 928 934; `advancePendingClose` never entered
- **recoveries.ts**: `liveResolveNotMatured` 147; `accrueBeforeChange` 158 160; `rebalanceReducePosition` 177 180 191 195 202 203 207; `cureAndCancelPreflight` 254 261 262 264; `cureAndCancelClose` 284 287 289 299 303
- **recovery.ts**: `obligationReleaseAllowed` 60; `fSnapSettled` never entered; `legIsDeadForForfeit` 96 97; `retainLossWeight` 111; `retainAsPendingObligation` never entered; `detach` 157; `forfeitLossBackingCapacity` 173; `settleForfeitedLegKf` 195 199 216; `failDeclared` 238; `forfeitRecoveryLeg` 261 264 275 279 286 289 290 301 305 308 313 319 322 324 327 332 336; `resolveMarket` 351
- **reserves.ts**: `marketWithdrawCapacity` 209; `shutdownEmptyAndMatured` 226; `liveWithdrawHealthOrShutdown` 255; `depositFreshBacking` 433 438; `withdrawFreshBacking` 597 602 606 608 613 618 627; `resolvedBackingSurplus` 650 651 654 657 658 662 668 672 676; `withdrawBackingBucket` 746 754; `withdrawBackingEarnings` 801 829; `setDomainBudget` 847; `withdrawDomainInsurance` 871; `debitMarketInsurance` 886; `withdrawInsuranceAsset` 970; `requireTerminalClaimFree` 1011; `applyRecredit` 1035 1036 1038; `recreditTerminalResidualCore` 1070 1072 1082
- **resolution.ts**: `resolveMarketView` 32
- **resolved.ts**: `headerAggregateTotals` 109 110 112 114 115 116 117; `advanceResolvedSlot` 132; `firstLapsedForAsset` 143 144 145; `createReceipt` 204 208; `receiptClaimableNow` 230 232; `receiptCanStillGain` 246 248 250; `clearFullyDilutedReceipt` 262 263 264; `applyReceiptPayment` 288 289 290; `refineUnreceiptedBound` 305 307 312 316 318; `releaseAccountLienForDomain` never entered; `prepareOneSourceDomain` 384 391 392 406; `wholeAtomConversion` 442; `terminalForHaircutDemote` 474 477 482 485 489 490; `applyConversionRetainingHaircut` 519 520 526 529 532; `realizeOneSourceDomain` 557 570 576 581 590 591 597; `settledPnlAfterBooking` never entered; `settleResolvedBankruptcy` 638 644 646 655 661 676 678 681 686; `detachSolventLegs` 701 703 705 707 713 715 717 718 719 723 725 742; `closeResolvedAccount` 773 777 786 799 801 809 810 829 832 838
- **terminal.ts**: `recreditForSlot` 143 147; `advanceTerminalSlab` 174 196 197 205 211 218; `closeSlab` 290 299 308 324 336; `claimResolvedPayoutTopup` 387; `forceCloseRecoveryPair` 489 490 494 497 506 507 508; `forceCloseAbandonedAsset` 575
- **trade.ts**: `validateBasis` 184; `signedPosition` 194; `lossWeightForBasis` 202 205; `adjustU128` 212 215; `positionChangeTouchesBarrier` 227; `setAssetState` 252; `ensureSourceDomainCapacity` 278 279 284 286 287 290 293 295 297; `attachLegAtSlot` 309 314 315 325 329 331 333; `kernelClearLeg` 379 383 394 396 397 401 405 407 411 413 414 418 422 424; `requireKfCurrent` 459; `clearLegAtSlotInner` 485 490 499 501 504 507 508 512 513; `clearLegOrStale` never entered; `resizeLegSameSide` 565 568 571; `applyPositionDelta` 586 588 596 604 606 611 615 619 635 641; `retainLegAsPendingObligation` never entered; `positionMapCheck` 682 684 685; `planDelta` 702 716 718 732 734 735 748 749; `mulDivFloorWide` 756; `checkedFeeBps` 767; `tradeNotionalFloor` 774 776; `transferResidualRewardCredit` 787 791 794; `setPendingBarrierCount` 815 818 822; `beginCloseProgressLedger` 836 841 843 846 849 869; `terminalResidualAsset` 882; `beginTerminalResidual` 902 903 906; `noPositiveCreditEquity` 919 922; `validLienReserveSum` 935 937; `incrementalCreditNeeded` 948 951 952 956; `createLienBacking` 969 972 978 980 981; `addChecked` 991; `createAccountLienForEffective` 1005 1011 1023 1024; `createAccountLienAny` 1044 1049 1052 1056 1057 1063; `createInitialMarginLienIfNeeded` 1076; `ensureInitialMargin` 1090; `ensureNoPositiveCreditInitialMargin` 1100; `beginZeroOiResidueResets` 1123 1127 1129 1130; `canIgnoreUnrelatedLossStale` 1159; `tradePreflight` 1177 1184; `executeTrade` 1206 1211 1213; `executeAfterTailValidation` 1234 1236 1238 1279
- **trading.ts**: `advanceCheckpointLocal` 178 185; `recordTransitionLocal` 198 200 204; `fundingRateFromCheckpoint` 222 225 226; `pathFail` never entered; `canonicalPriceStep` 259; `canonicalPath` 307 310 322 329 334 336; `zeroMovePath` 383 389 392; `pendingZeroMoveRequiresCrank` 417; `accrueAssetPath` 435 439 445 448 449 452 462 466 467 477 481 483 490 493 496 498 503 505 507 509 515 525 530 535 557; `accrueZeroMoveBeforePositionChange` 580 588; `policyNotionalCeil` 610; `feeQuote` 656 672 678; `feeBpsForPaid` 694 695; `lienRefreshWork` 823 824 827; `ensureNewCounterpartyLiensFresh` 846; `backingDomainParts` never entered; `ensureFullRate` never entered; `chargeAccountBackingFee` never entered; `backingFeeSplit` never entered; `collectBackingFees` 994 1000 1004 1005 1013; `tradeZeroCopy` 1144 1183; `ensureGrownLiensFullRate` 1309; `ensureTradePortfolioCurrent` 1339 1346; `applyBackingDomainFees` 1379 1380 1381 1384 1385; `creditTradeFees` 1410 1415; `creditFeeToDomain` 1431 1433 1435; `updateMarkAfterTrade` 1465 1470 1473 1474 1475 1482


### BatchTradeNoCpi, TradeCpi and BatchTradeCpi against the reference binary

Both VMs load the same three matcher binaries (test/programs/SOURCES.md) and, for one test, a rogue matcher the test
builds from `showcase/test/fixtures/percolator-v16-rogue-matcher.ts` (a TypeSOL test fixture, the same binary in both).
The shared worlds are `percolator-v16-batch-world.ts`: a market of several assets (AuthMark, and EWMA on odd assets
where asked), funded portfolios, the LP's matcher context initialised by the matcher's own instruction and its matcher
config set by SetMatcherConfig. Last run (2026-11-19):

- batch: 300 seeded batches (`PERCOLATOR_V16_BATCH_FUZZ`; a quarter with a corrupted leg, cranks every third step),
  131 succeeding in both (by legs: 1: 38, 2: 26, 3: 29, 4: 24, 5: 14), the rest refused alike (NonProgress 40,
  LockActive 43, InvalidInstruction 41, OracleInvalid 31, AssetGenerationMismatch 14); 14-leg batches on no heap
  request, 32 and 64 KiB alike; the growth of 14 legs and their close past the reference's limit (below).
- cpi: every hostile mode (0 to 9, 13 to 20, 255) of TradeCpi at four sizes and of BatchTradeCpi with one and three
  legs, refused or filled alike; the rogue matcher's cases (README); 300 seeded matcher trades
  (`PERCOLATOR_V16_CPI_FUZZ`) through the auth matcher, percolator-match and the hostile matcher in random modes, 193
  succeeding in both (TradeCpi 120, BatchTradeCpi 73), the rest refused alike; 14-leg BatchTradeCpi with a tail of 4
  on every heap frame from the runtime's default to 256 KiB, all succeeding in both.
- the walks: trade walk seeds 1649 and 2662 (600 steps each): TradeCpi 9/17 and 4/11, BatchTradeNoCpi 7/46 and 15/30,
  BatchTradeCpi 2/9 and 2/4 successes; crank walk seeds 1695 and 3722: TradeCpi 5/7 and 6/10, BatchTradeNoCpi 8/21 and
  5/21, BatchTradeCpi 2/7 and 2/3; conservation failures 0 (asserted).

### Past the reference's compute-unit limit

`Diff.send` (percolator-v16-helpers.ts): where the reference fails with "exceeded CUs meter" and the port succeeds,
the transaction runs again in `raisedReference()`, a LiteSVM with the reference and the matchers whose ComputeBudget
is 20,000,000 units and 256 KiB of heap (`withComputeBudget`, which takes the place of the transaction's
SetComputeUnitLimit); the named accounts are copied from the reference first (the fee payer's balance from before the
failed run); the port's result is compared whole with that run's, and the run's accounts are written back into the
reference. Each such case is in `Diff.raised` and is marked `raised` in the compute-unit file. LiteSVM could raise
the limit; nothing else was needed. Last run: 9 cases, all equal (README, "Compute units and size"):
`percolator-v16-limit.test.ts` (the `inv_078` shape and the 14-hint crank), the crank test's maximum shape (3 cranks)
and the batch test (3 batches).

### The author's largest market shapes

`percolator-v16-shapes.test.ts` builds markets of the sizes the author's suite uses at its largest (up to 5,682 asset
slots, the most a 10 MiB account holds, `MAX_10M_MARKET_SLOTS` in tests/v16_cu.rs), where the comparison of the
author's suite (section 3) had found the port costing more than the reference on three instructions. InitMarket runs
through the instruction into accounts of 1,000 and 5,682 slots; the grown markets (every slot configured) are made as
the author's `grow_market_to_10m_with_high_active_asset` makes them, by writing the configured count, the next market
id and the last slot's asset into the market after InitMarket; CloseSlab's scan state (one atom of fresh backing in
the market, asset 300's long bucket Fresh and live; then a claim-free residual instead) is written into the market
too. Each transaction is compared whole and each success must cost the port less. Figures (reference / port, whole
transactions; the last column is the port's binary before the fix, sha256 `6677dd5b…`, where it was measured):

| Transaction | Reference | Port | Port before |
| --- | ---: | ---: | ---: |
| InitMarket, 1,000 slots | 41,574 | 27,532 | 39,527 |
| InitMarket, 5,682 slots | 211,905 | 146,361 | 214,540 |
| ResolveMarket, 1,000 configured slots | 14,044 | 12,532 | 30,526 |
| ResolveMarket, 5,682 configured slots | 65,546 | 64,034 | 166,304 |
| ResolveStalePermissionless, 5,682 configured slots | 65,216 | 63,962 | – |
| CloseSlab, a scan of 256 assets with fresh backing | 41,318 | 17,682 | 42,314 against 38,318 (the reference's figure moves with the keys' PDA bumps) |
| CloseSlab, a scan to the live Fresh bucket (45 assets) | 17,886 | 6,586 | – |
| CloseSlab, a residual scan of 256 assets | 182,870 | 75,544 | – |

The fix (README, "Where the port costs more"): the three scans read the slots through one view of the slot array,
whose bounds and owner are checked once (`rawArrayAt`), instead of a view per slot with its own owner and bounds check
and an offset computed with overflow checks; CloseSlab makes the two backing expiries effective only for an asset whose
step reads them. The ResolveMarket scan now costs 11 instructions a slot, as the reference's does (65,546 = 3,055 for a
market of one configured slot + 11 × 5,681); the port's lead there is its cheaper fixed part (about 1,500 units),
not the scan. Run against the port before the fix, all three tests fail on the compute-unit rule.

### Paths driven on purpose

`percolator-v16-paths.test.ts`, with branch probes (`PERCOLATOR_V16_PORT_COVERAGE`, files trade.ts, trading.ts,
reserves.ts, autocrank.ts, resolved.ts, health.ts): a portfolio long near its initial margin on asset 0 gains as the
mark rises (a source claim on the short domain, whose Fresh bucket holds backing and which has a 25 bps backing-fee
policy), then grows its position in eight trades whose initial margin its capital alone does not give: each liens its
claim against the bucket (`createAccountLienForEffective`, counterparty-backed: 4 liens) and pays the backing-domain
fee (`chargeAccountBackingFee`, entered 4 times; TradeCpi refused at the taker's backing cap 24, Unauthorized, and
filled at 25); the bucket's utilization fee then gives its provider 431,570 atoms of earnings, half of which and one
atom WithdrawBackingBucketEarnings takes (the deterministic success the earlier runs lacked: 40,669 against 17,297
CU). From that state: the position closed, the flat portfolio's first crank is ReleaseSourceLiens (`releaseSourceLiens`,
`flatLienNormalization` entered); or the market resolved and every portfolio closed out, which releases a liened
domain at the resolved close (`releaseAccountLienForDomain` entered). `recertifyAfterSourceLienChange` entered 7 times.

The probe counts above come from a coverage run. The ordinary test asserts each path's own evidence, read from both
VMs (agreement alone would also pass if both refused early): all eight growing trades succeed; portfolio 0's
counterparty-backed liens grow from none; the short domain's bucket earnings and insurance budget grow (the backing-domain
fee's provider and insurance parts); TradeCpi is refused at cap 24 with Unauthorized and fills at 25; after the position
is closed, the flat portfolio's first crank succeeds and leaves no lien; from the saved state, ResolveMarket succeeds
and the close-out leaves no lien in the portfolio or in the bucket (`valid_liened_backing_num` 0).

Still entered by no transaction of this repository's tests, and why (four of the six are entered by the author's
own tests, whose transactions are identical in both binaries: section 3, "Paths no vitest reaches"):

- **AdvanceClose, a crank's declaration of Recovery, a leg retained as a pending obligation.** All three need a
  pending close-progress ledger (a residual with its domain-loss barrier). A terminal trade begins one only when the
  account entered the trade with a PnL of at least zero, one live leg and no pending residual, and its PnL is negative
  after the refresh, before the fill clears the leg (`begin_terminal_trade_residual_if_needed`). A closing trade at a
  loss past the capital was tried (an uncranked long of 18e9 at a fifth below its price): the refresh did not settle
  the loss before the fill (the clear settles it), so the PnL was not negative at that point and no ledger began; a
  crank first makes the PnL negative before the trade, which excludes it. A bankrupt liquidation books its residual or
  leaves the loss on the account without a ledger (the gap tests). No sequence of instructions found here leaves a
  pending ledger; these paths are compared on ledgers written into the portfolio only where the earlier tests do so
  (CureAndCancelClose), not for these three.
- **WithdrawBackingBucket's emptied-bucket statuses (Impaired, Expired)** need a bucket emptied while impaired liens
  stand or past its expiry with backing left to withdraw; not built here (no generated state was written for it).
- **CloseSlab's native-mint residue path** needs the market's mint to be the native mint (the tests make SPL mints of
  their own); not built as generated state in this work. **The terminal scan past 256 assets** is now driven by
  `percolator-v16-shapes.test.ts` (below) on a market of 5,682 configured assets whose header and one bucket are
  written into the market, not reached by instructions alone.

## 3. The author's suite

### The full run on both binaries, transaction by transaction

All six targets, unfiltered, against the reference (`test/programs/percolator_v16.so`, sha256 `cc35fa48…`, built from
the author's source, not a deployed program) and against the port's current binary (`node dist/cli.js build`,
1,362,872 bytes, sha256 `01c33233edcbcf7c8bfd7d44995b91a5b5b0d8b724615a864982417392e1f750`), with `TRACE=1` (below),
the matchers as recorded, 2 CPUs, `--test-threads=2`, `PROPTEST_RNG_SEED=1`. The reference ran on 2026-11-19/20, the
port on 2026-11-21 to 2026-11-23 (all six targets in one results directory; `author-suite.sh` ended "as expected",
exit 0). The machine was loaded by other work, so the times are long and uneven; the port's seconds below are each
target's own test time (`finished in`), the `v16_program_stateful_fuzz` wall time (119,735 s) including hours the
machine slept:

| Target | Tests | Reference passed / failed | Port passed / failed | Reference seconds | Port seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| `listing_oracle_scope` | 2 | 2 / 0 | 2 / 0 | 1 | 1 |
| `anchor_v2_realloc_probe` | 1 | 1 / 0 | 1 / 0 | 1 | 1 |
| `open_issue_regressions` | 3 | 3 / 0 | 3 / 0 | 3 | 2 |
| `v16_program_fuzz_regressions` | 148 | 148 / 0 | 148 / 0 | 232 | 174 |
| `v16_program_stateful_fuzz` | 336 | 335 / 1 | 335 / 1 | 57,904 | 9,443 |
| `v16_cu` | 1,581 | 1,573 / 8 | 1,571 / 10 | 10,542 | 7,912 |

The first full run of the port (2026-11-19/20, its previous binary, 1,362,760 bytes, sha256 `6677dd5b9eb3b841…`) gave
the same passes, failures and trace differences, but 282 identical successes costing the port more; they were fixed
(below) and the full run repeated on the current binary, the figures of this section.

**Failing on the reference itself** (9; each fails on the port at the same file and line with the same message, the
messages compared whole; in the `inv_072` and `inv_077` ones the message quotes the refused crank's logs, and only the
compute-unit figures in them differ):

- `v16_cu`: the six of `inv_045_no_free_mark_movement::trade_origin_catchup::authenticated_reward_handoff`
  (`exposed_keeper_provenance`, `report_cadence_rewards`, `retained_penalty_handoff`, `reward_maintenance_catchup`,
  `reward_policy_catchup`, `reward_terminal_redemption`: assertions of reward and fee values the program does not give
  at this pin, for example 10,001,995 expected where it gives 10,000,000);
  `inv_072_order_robust_crankability::v16_program_auto_crank_refresh_not_blocked_by_unneeded_first_asset_oracle`
  (tests/v16_cu.rs:4758, the first crank refused with Custom(22) before any progress);
  `inv_077_bounded_work_and_maximum_shape_compute::v16_attack_public_recovery_kf_progress_survives_stale_42_feed_tail_at_max_shape`
  (tests/v16_cu.rs:4833, "crank with oracle tail", Custom(22)).
- `v16_program_stateful_fuzz`: `inv_086_reference_model_and_deployed_transition_equivalence::v16_program_reference_model_matches_deployed_public_sequence`,
  the author's reference model and the program diverging at action 11 of a generated sequence, a RebalanceReduce ("live
  asset 1 has unclassified effective exposure imbalance [1, 0]"), with the same seed and the same sequence in both
  runs. It was open in the run against the port alone (it is the reference's own).

**Failing on the port only** (2), both assertions of the reference's compute units:

- `inv_077_bounded_work_and_maximum_shape_compute::short_side_b_budget::v16_program_max_shape_short_b_budget_has_exact_public_progress`:
  `tests/invariants/cu/inv_077_short_side_b_budget.rs:348` asserts `max_cu == 554_832` ("remeasure the documented
  default-feature SBF peak on a new pin"), the largest of the program's own compute units over the test's crank calls,
  after every assertion on state (the debited claims, the bitmaps, capital, PnL, the market's totals, the framed
  accounts) has passed. The port's peak is 192,398. Its 1,361 transactions are identical in both traces.
- `inv_078_permissionless_recovery_coverage::v16_bpf_force_close_liveness_survives_14_stale_leg_grief_via_precrank`:
  `tests/invariants/cu/inv_078_permissionless_recovery_coverage.rs:1074` asserts that a one-shot
  ForceCloseAbandonedAsset of two portfolios with 14 stale legs each *fails* ("expected to exceed the tx CU limit").
  The reference fails it with ProgramFailedToComplete at 1,400,000 units; the port completes it (575,741 units, whole
  transaction), so the test stops there and its second part (the pre-crank path) runs on the reference only. The 12
  transactions before are identical. The force-close itself and the pre-crank path are compared with the reference in
  `percolator-v16-limit.test.ts` (the reference run under a raised budget for the one-shot; the README has the
  figures).

**The trace comparison.** With `TRACE=1`, every transaction a test sends appends one line to
`<results-dir>/trace/<test>.trace` (`scripts/percolator-v16-reference/trace/send_transaction.rs`, spliced into the
LiteSVM 0.1.0 the tests use): the programs and first data bytes of its instructions, an FNV-1a hash of the
instructions and account keys, the result (the error in full), hashes of the return data and of the log lines (the
runtime's compute-unit lines left out), a hash of every account in the transaction's static key list after it ran
(key, lamports, owner, data; executable accounts by key only) and the compute units. The keys a test makes
(`Keypair::new`, `Pubkey::new_unique`, made per test thread from the thread's name and a counter:
`trace/keypair_new.rs`, `trace/pubkey_new_unique.rs`) and proptest's seed are fixed, so both binaries receive the
same transactions; that holds for every test but where a test reacts to a difference. The author's bounded-frontier
tests (eight in `inv_086`) replay their words on unnamed worker threads (`std::thread::scope`), whose transactions all
go to `main.trace` in an order that varies between runs; `author-trace-compare.ts` compares that file as a multiset.
In the run above those threads' lines were written in pieces and interleaved (unreadable); the writer now writes each
line once under a lock and stops the test if it cannot, and the eight tests were run again on both binaries on
2026-11-21 (`TEST_FILTER="seeded_frontier bounded_reference_graph_exhausts_public_action_words"`, all 8 passing in
both, 4,352 and 5,710 s); that run's `main.trace` replaces the unreadable one, and its other three trace files equal
the first run's byte for byte, compute units included. In the reference's run the four small targets and the two
large ones ran in separate results directories; three test names occur in two targets, and their files are joined
(small targets first) as one run would append them. The port's current binary ran all six in one directory, with the
fixed writer (1,901 trace files).

`node scripts/percolator-v16-reference/author-trace-compare.ts <reference>/trace <port>/trace --list` (unfiltered, no
`--filtered`; exit 0, "every difference is listed and every listed one was observed"):

| | |
| --- | ---: |
| Trace files (1,900 tests that sent a transaction, and `main.trace`) | 1,901 |
| Identical throughout | 1,900 |
| Transactions compared | 2,324,991 |
| Identical (every field but the compute units) | 2,324,990 |
| Different | 1 (`inv_078`, transaction 12: above) |
| On one side only | 35 (`inv_078`'s later transactions, on the reference) |
| Succeeding identically in both | 2,127,486 |
| Their compute units, reference / port | 128,297,605,017 / 67,489,010,058 |
| Of those, the port above the reference | 0 (the previous binary: 282, ResolveMarket 127, CloseSlab 141, InitMarket 14, at 67,519,099,673 units; fixed: below) |

The 9 tests failing on both binaries are identical throughout up to their failure; the 2 port-only failures are
identical up to theirs. No test's transactions differed in their inputs (no test chose a different transaction from a
difference earlier on).

**What the trace comparison does not cover.** It compares hashes, not bytes (a 64-bit FNV-1a collision is not ruled
out but not expected). Accounts that a version-0 transaction loads through an address lookup table (`inv_006`'s
lookup-table tests) are not hashed, nor is the message's lookup part. Inner instructions are not recorded apart.
State a test reads without sending a transaction is compared only through its own assertions. Refusals are compared
like successes, but their compute units are not judged. The matchers are the same binaries in both runs.

**What the scripts enforce.** `author-suite.sh` exits non-zero when a target does not compile, reaches
`TARGET_TIMEOUT`, runs no test, or (`TRACE=1`) records no transaction, and, unless `EXPLORE=1`, when the failures
differ from `scripts/percolator-v16-reference/author-suite-expected.tsv` for the binary under test (the reference by
its sha256, any other binary as the port): an unlisted failure, a listed failure that passed and, unfiltered, a listed
failure that did not run or a test count other than the listed one. `TRACE=1` refuses a non-empty trace directory
(traces are appended). `author-trace-compare.ts` exits non-zero when either directory holds no trace, a line cannot be
read, nothing is compared, anything differs that the same file does not list (`trace` rows name the test and the
kind of difference, `cu` rows the instructions where the port may cost more), or a listed difference or excess was
not observed (`--filtered` relaxes the last for filtered runs). Every row of the file carries its reason.

**To reproduce** (Docker, 2 CPUs; the large targets take hours: here 2.5 to 16 hours for `v16_program_stateful_fuzz`
and 2.3 to 2.9 hours for `v16_cu`, the spread mostly the machine's other load; the small ones about 4 minutes):

```sh
scripts/percolator-v16-reference/build.sh          # once: test/programs/percolator_v16*.so
node dist/cli.js build showcase/mainnet/percolator-v16/percolator.ts --out /tmp/v16-port-build
TRACE=1 TARGET_TIMEOUT=86400 scripts/percolator-v16-reference/author-suite.sh test/programs/percolator_v16.so /tmp/v16-ref
TRACE=1 TARGET_TIMEOUT=86400 scripts/percolator-v16-reference/author-suite.sh /tmp/v16-port-build/percolator.so /tmp/v16-port
node scripts/percolator-v16-reference/author-trace-compare.ts /tmp/v16-ref/trace /tmp/v16-port/trace --list
```

### After the whole-market scans were fixed: the affected tests first

The 282 excesses of the first full run came from the port's scans over the market's asset slots (README, "Where the port costs more";
section 2, "The author's largest market shapes"). After the fix, the port's binary is 1,362,872 bytes, sha256
`01c33233edcbcf7c8bfd7d44995b91a5b5b0d8b724615a864982417392e1f750` (`node dist/cli.js build`, the tested clang). The
20 tests of `v16_cu` whose recorded transactions included one of the 282 ran on it on 2026-11-21:

```sh
TRACE=1 TARGET_TIMEOUT=86400 TEST_FILTER="<the 20 test names>" \
  scripts/percolator-v16-reference/author-suite.sh /tmp/v16-port-build/percolator.so /tmp/v16-port-fixed v16_cu
node scripts/percolator-v16-reference/author-trace-compare.ts <the same 20 files of the reference's full-run traces> \
  /tmp/v16-port-fixed/trace --filtered
```

All 20 passed (3,396 s). The comparison with the reference's traces recorded in the full run: 20 trace files, all
identical throughout; 144,407 transactions compared, 144,407 identical; 143,473 succeeding identically, 4,169,904,579
units in the reference against 1,842,630,993; none where the port costs more, so the three `cu` rows were removed from
`author-suite-expected.tsv` (the scripts would now fail on any excess). Each of the 282 transactions is cheaper; by
instruction over these tests' successes:

| Instruction | Successes | Reference | Port | Largest in the reference (port) | Closest |
| --- | ---: | ---: | ---: | --- | --- |
| InitMarket | 134 | 7,005,969 | 4,551,942 | 308,170 (205,442) | 5,199 against 2,142 |
| CloseSlab | 1,491 | 161,181,428 | 68,478,641 | 554,426 (241,007) | 8,922 against 3,382 |
| ResolveMarket | 133 | 2,347,882 | 2,141,582 | 67,179 (64,166) | 65,584 against 64,080 (the 10 MiB market, was 166,350) |

The 20 tests: `generated_scans_recompute_actionability_across_source_deadlines_and_prefixes`,
`native_sync_after_terminal_prefix_reclassifies_only_external_surplus`,
`terminal_scan_reconciles_external_surplus_arriving_after_cached_prefix` (`inv_070`);
`dense_claimants_and_reserves_reconcile_at_supported_capacity`,
`generated_receipts_and_reserves_have_constructible_terminal_progress`,
`persisted_scan_reclassifies_time_without_skipping_live_siblings` (`inv_071`); in `inv_077`
`public_max_market_native_partial_insurance_ledgers_complete_in_both_orders`,
`max_market_retired_siblings_preserve_oversized_force_close_and_owner_exit`,
`max_market_dense_backing_expiry_has_bounded_terminal_progress`,
`quote_variants_have_bounded_empty_terminal_close_at_capacity`,
`quote_variants_retire_public_last_domain_backing_at_capacity`, and the nine `v16_bpf_10m_market_*` and
`v16_bpf_terminal_*_on_10m_market` tests.

The fix changed three functions of the port: InitMarket's handler, ResolveMarket's and ResolveStalePermissionless's
scan (`resolveMarketView`) and CloseSlab's terminal step (`advanceTerminalSlab`). The whole suite was then run again on
this binary, every target unfiltered (2026-11-21 to 2026-11-23): the figures at the top of this section, with no
identical success costing the port more at any instruction.

### Paths no vitest reaches, in the author's tests

Six paths are entered by no transaction of this repository's tests ("Paths driven on purpose", section 2). The
author's tests were searched by name for ones aimed at them, and 16 such tests ran on 2026-11-21 against a probed port
(`coverage.ts --build trade.ts,liquidation.ts,reserves.ts,autocrank.ts,terminal.ts,recoveries.ts,recovery.ts`, 1,448
probes; `PROBES=1 TRACE=1 EXPLORE=1 TEST_FILTER=… author-suite.sh … v16_cu`, 31 minutes). Their transactions were
compared with the reference's traces of the full run (`author-trace-compare.ts --filtered --coverage probes.json`):
results, return data and accounts equal on all 40,387 aligned transactions; 190 differ in their logs only, and one test
(`inv_070…native_recovery_claims_have_bounded_terminal_disposition`) failed on the probed port alone: the probes' own
log lines fill the runtime's log limit there, which truncates the program's later lines (and with them any later
probe), so a probe missing from a truncated log is not evidence that the branch was not taken. The same tests'
transactions are identical in the unprobed full run above. Reached, each in a transaction identical in the
reference's and the port's full runs:

- **AdvanceClose with a pending close ledger** (`advancePendingClose`, past `closeHasPendingResidual`): by
  PermissionlessCrank in `inv_071…v16_program_public_pending_close_preempts_b_stale_then_exposes_b_progress` (6
  cranks), `inv_039…v16_program_pending_obligation_blocks_close_then_releases` (2) and
  `inv_056…v16_program_pending_close_bad_hints_roll_back_then_canonical_crank_progresses` (1). The ledger's rank step
  (`advanceCloseLedger` from there) was not reached.
- **A crank's declaration of Recovery on real state** (`declareRecovery`, the market not yet declared): by
  PermissionlessCrank in `inv_071…v16_program_bankruptcy_escalation_matrix_commits_recovery_and_resolves` (2, through
  `declareAndReturn` and `commitDeclared`), `inv_055…v16_program_irreversible_close_ledger_admits_only_terminal_progress`,
  `inv_072…v16_program_bad_hints_cannot_block_public_expired_close_recovery` and
  `inv_078…v16_program_auto_crank_expired_close_recovery_not_blocked_by_stale_oracle` (1 each).
- **A leg retained as a pending obligation** (`retainAsPendingObligation` and `retainLegAsPendingObligation`): by
  ForfeitRecoveryLeg in `inv_039…v16_program_pending_obligation_blocks_close_then_releases` (2),
  `inv_039…v16_program_resolve_with_pending_obligation_defers_claim_until_debtor_settles` (2) and
  `inv_063…v16_program_retained_recovery_expiry_prerequisite_matrix_avoids_provider_capitalization` (1). The trade's own retention of a cleared leg (`applyPositionDelta` with a pending domain-loss
  barrier on its side, trade.ts) was not reached.
- **WithdrawBackingBucket leaving a bucket Expired**: in `inv_039…v16_program_pending_obligation_blocks_close_then_releases`
  (2).

Not reached by those 16 tests: WithdrawBackingBucket leaving a bucket Impaired (tried:
`inv_005…v16_program_cold_admin_cannot_seize_impaired_backing_only_role`, `inv_063…spent_backing_expiry_preserves_unpaid_claim_and_refill_exit`),
CloseSlab's native-mint residue (tried: `inv_021…close_slab_native_refund_alias_preserves_wrapped_value_and_rent`,
`inv_070…native_recovery_claims_have_bounded_terminal_disposition`, the latter truncated as above), and the terminal scan past
256 assets (tried: `inv_077…quote_variants_have_bounded_empty_terminal_close_at_capacity`,
`inv_070…terminal_scan_rediscovers_remaining_insurance_across_two_expiry_waves`). The other 2,055 tests were not probed (`inv_037…insurance_covered_liquidation_close_ledger_partitions_exactly` was among the 16 and reached none of the six), so
these three are unreached as far as anything here shows, not shown unreachable. The four reached paths are compared
only through the author's tests (identical traces of both binaries); no vitest in this repository reproduces them yet.

### Earlier runs

An earlier full run against the port alone (2026-11-18, the port's binary `f6a52b6c…` before one fix) failed 12 tests:
the 8 of the reference's own then known, the 2 compute-unit assertions above, `inv_086` (then not yet run on the
reference), and one real difference, fixed since: `inv_045_no_free_mark_movement::v16_program_accepted_mark_boundary_matrix_is_paid_atomic_and_exit_live`
(TradeCpi and BatchTradeCpi must refuse a matcher's price above MAX_ORACLE_PRICE with OracleInvalid, as the original
checks in `accepted_reported_trade_price_view`; now in trading.ts `acceptedTradePrice`, compared in
`percolator-v16-cpi.test.ts`, and passing in the full run above).

The filtered runs before (37 and 47 instructions):

**Against the port.** Every test of the six targets builds its world through `tests/support/v16_svm.rs` (`V16Svm::new` →
`initialize_world`) or `V16CuEnv` in `tests/v16_cu.rs`: InitMarket (two markets), ConfigureAuthMark for each asset,
InitPortfolio, a call of the matcher fixture itself (not this program), SetMatcherConfig and Deposit for each actor.
All of these are ported, so every test gets through its set-up and stops, if anywhere, in its body. Run on 2026-11-18
with the script as committed, after the insurance, backing and terminal instructions were ported (47 instructions;
the port built by `node dist/cli.js build`, 1,258,064 bytes, sha256 `188bca12…`, from the code of this commit but for
comments; the matchers as recorded, 2 CPUs): the four small targets whole, and the two large ones filtered as before
(withdrawal and maintenance fee: `TEST_FILTER="withdraw maintenance sync_fee maint_fee"`; trade; crank; recovery and
resolution: `TEST_FILTER="recover resolve forfeit rebalance cure close_resolved"`) and, new, to the instructions ported
here (`TEST_FILTER="insurance backing top_up topup close_slab claim swap secondary force_close abandon"`), the new
filter also against the reference itself. A failure is classified from the placeholder's code in its log
(Custom(0xc0de0000 + tag): TradeCpi 10, BatchTradeNoCpi 66, BatchTradeCpi 67, the only unported tags), or, where the
test prints none, by reading the test.

| Target | Run | Passed | Failed | Every failure | Before (37 instructions) |
| --- | ---: | ---: | ---: | --- | --- |
| `listing_oracle_scope` | 2 | 2 | 0 | | 2 of 2 |
| `anchor_v2_realloc_probe` | 1 | 1 | 0 | | 1 of 1 |
| `open_issue_regressions` | 3 | 3 | 0 | | 2 of 3 |
| `v16_program_fuzz_regressions` | 148 | 117 | 31 | 30 reach an unported tag (10 ×23, 66 ×7); 1 prints none: `inv_014…revoked_matcher_cannot_recover_terminal_value_with_stale_consent`, whose witness world needs a TradeCpi to land | 85 of 148 |
| `v16_program_stateful_fuzz`, withdrawal filter | 11 | 7 | 4 | all reach an unported tag (10 ×2, 66, 67) | 3 of 11 |
| `v16_cu`, withdrawal filter | 148 | 136 | 12 | 11 reach an unported tag (10 ×8, 66 ×2, 67); 1 prints none: `inv_045…reward_maintenance_catchup`, the reference's own failure | 72 of 148 |
| `v16_program_stateful_fuzz`, trade filter | 29 | 1 | 28 | 25 reach an unported tag (10 ×13, 66 ×11, 67); 3 print none: route matrices whose Cpi and batch routes diverge (`inv_047…generated_nonzero_fee_trade_routes_are_economically_equivalent`, `inv_063…backing_expiry_trade_route_boundary_matrix`, `inv_063…backing_expiry_trade_routes_respect_boundary`, each naming a Cpi or BatchNoCpi route in its message) | 1 of 29 |
| `v16_cu`, trade filter | 154 | 71 | 83 | 75 reach an unported tag (10 ×35, 66 ×25, 67 ×15); 8 print none: two TradeCpi and BatchTradeCpi refusal codes the placeholder replaces, and six of the `inv_045` authenticated-reward-handoff family, the reference's own failures | 63 of 154 |
| `v16_program_stateful_fuzz`, crank filter | 10 | 5 | 5 | all reach an unported tag (10 ×4, 66) | 5 of 10 |
| `v16_cu`, crank filter | 107 | 95 | 12 | 10 reach an unported tag (10 ×5, 66 ×4, 67); 2 print none: `inv_072…auto_crank_refresh_not_blocked_by_unneeded_first_asset_oracle`, the reference's own failure, and `inv_078…force_close_liveness_survives_14_stale_leg_grief_via_precrank` (below) | 83 of 107 |
| `v16_program_stateful_fuzz`, recovery and resolution filter | 53 | 34 | 19 | all reach an unported tag (10 ×14, 66 ×2, 67 ×3) | 17 of 53 |
| `v16_cu`, recovery and resolution filter | 210 | 189 | 21 | 18 reach an unported tag (10 ×11, 66 ×3, 67 ×4); 3 print none: `inv_045…reward_terminal_redemption`, the reference's own failure, `inv_074…non_base_tradecpi_rejects…` (TradeCpi's refusal code) and `inv_078` (below) | 115 of 210 |
| `v16_program_stateful_fuzz`, this work's filter (new) | 84 | 52 | 32 | 29 reach an unported tag (10 ×22, 66 ×3, 67 ×4); 3 print none: `inv_028…flat_source_lien_route_matrix_preserves_bounded_claim_exit` and the two `inv_063` route matrices above, each failing on a BatchNoCpi or Cpi route; the reference: 53 run before its time limit, 53 passed (the three among them) | not run |
| `v16_cu`, this work's filter (new) | 355 | 338 | 17 | 16 reach an unported tag (10 ×6, 66 ×9, 67); 1 prints none: `inv_078` (below); the reference: 355 of 355 | not run |

**`inv_078…force_close_liveness_survives_14_stale_leg_grief_via_precrank`** asserts that a one-shot
ForceCloseAbandonedAsset of two accounts with 14 stale legs each *exceeds* the transaction's compute-unit limit
(`tests/invariants/cu/inv_078_permissionless_recovery_coverage.rs:1074`, "cleanup must go through the pre-crank
path"). In the reference it does; the port completes it within the limit (it uses fewer compute units on every
success, by design of the port), so the assertion that it fails is false for the port. This is the only failure in a
ported path, and it is a difference of compute-unit cost, not of behaviour (the same kind as the crank's maximum shape
in the README). It is not pinned in this repository's tests (it is the author's test); whether the port's state after
that force-close matches what the reference reaches through the pre-crank path is not compared.

The reference against the same filters (earlier runs, recorded in the git history of this file, and this one for the
crank and trade filters): withdrawal, stateful fuzz 11 of 11 and `v16_cu` 147 of 148; trade, stateful fuzz 29 of 29 and
`v16_cu` 148 of 154; crank, stateful fuzz 10 of 10 and `v16_cu` 106 of 107. Its failures are its own: the six of the
`inv_045_no_free_mark_movement::trade_origin_catchup::authenticated_reward_handoff` family (one of them in the
withdrawal filter too) and the `inv_072` crank test above. With the crank ported, the port now reaches the same
assertions in these tests and fails them alike.

No failure but `inv_078` (a compute-unit difference, above) is a difference in a ported path: each was classified from its log or, where it prints no code, by reading
the test. The reference's own baseline below ran the large targets by time, not by name.

### How the script swaps the binary in

How a binary is swapped in, checked by reading the pinned tests: every one of the six targets loads the program
through one of two functions, `program_path()` in `tests/v16_cu.rs` (for `v16_cu` and the 400-odd files it includes)
and `program_path()` in `tests/support/v16_svm.rs` (for the other five, through `mod support`). Both return the path
in `PERCOLATOR_FUZZ_SBF` first (then `$CARGO_TARGET_DIR/deploy/percolator_prog.so`, then
`target/deploy/percolator_prog.so`). No test reads `percolator_prog.so` any other way: every `add_program` of the
program id is fed by `std::fs::read(program_path())`; the other `add_program` calls load the three matchers (fixed
paths: `../percolator-match/target/deploy/percolator_match.so`, `tests/fixtures/{auth,hostile}_matcher/target/deploy/`)
and SPL Token, Token-2022 and the associated-token program from LiteSVM 0.1's own crate. The script sets
`PERCOLATOR_FUZZ_SBF` and places the matchers at those paths. The program runs under `percolator_prog::id()`
(`Perco1ator111111111111111111111111111111111`).

Each target is compiled first (`cargo test --no-run`, not timed), then run with `--test-threads=2` in a container
limited to 2 CPUs, stopped after `TARGET_TIMEOUT` seconds (default 2,400; a target that reaches it now fails the
run). Results go to `<results-dir>/<target>.log`, `<results-dir>/summary.tsv`, `<results-dir>/binaries.txt` (the
sha256 of the program and matchers) and, with `TRACE=1`, `<results-dir>/trace/`. With `TRACE=1` the three spliced
crates come in through `[patch.crates-io]` (so the build is not `--locked`) and lints are capped at warnings.

### Earlier baseline: the reference against its own suite, by time

Run on 2026-11-17/18 with the script as committed: `test/programs/percolator_v16.so` (`cc35fa48…`) and the three
matchers as recorded, `rust:1.89-slim-bookworm` linux/arm64 (native on an Apple silicon host), 2 CPUs,
`--test-threads=2`, the default 40-minute limit per target. 87 minutes in all, compilation included (compilation itself not timed).

| Target | Tests listed | Run | Passed | Failed | Ignored | Wall time | Status |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `listing_oracle_scope` | 2 | 2 | 2 | 0 | 0 | 1 s | complete |
| `anchor_v2_realloc_probe` | 1 | 1 | 1 | 0 | 0 | 1 s | complete |
| `open_issue_regressions` | 3 | 3 | 3 | 0 | 0 | 2 s | complete |
| `v16_program_fuzz_regressions` | 148 | 148 | 148 | 0 | 0 | 213 s | complete |
| `v16_program_stateful_fuzz` | 336 | 120 | 120 | 0 | 0 | 2,400 s | stopped at the limit |
| `v16_cu` | 1,581 | 612 | 612 | 0 | 0 | 2,400 s | stopped at the limit |
| **Total** | **2,071** | **886** | **886** | **0** | **0** | | |

"Tests listed" is the harness's own count (`running N tests`), proptest functions included; the scope research counted
2,098 `#[test]` attributes in the source, which is not the same measure. No test failed or was ignored in what ran.
The two large targets need several hours on 2 CPUs: each stateful-fuzz test takes about 20 s on average (some over a
minute), so a complete baseline of those two is still to be run, with `TARGET_TIMEOUT` raised (for example
`TARGET_TIMEOUT=14400 scripts/percolator-v16-reference/author-suite.sh … /tmp/v16-reference v16_program_stateful_fuzz`),
before any "X of Y pass unchanged" claim about the port. (Done since: the full run at the top of this section.)

## 4. The entrypoint at its limits

Percolator v16 builds with pinocchio 0.11.1's `entrypoint!` (through anchor-lang-v2) in front of a shim that turns
pinocchio's account views into solana-program 1.18 `AccountInfo`s (`mod entrypoint` in src/v16_program.rs) before the
native processor runs. What that entrypoint does at its limits decides what the port must reproduce, so it was
recorded by experiment (`showcase/test/percolator-v16-reference.test.ts`, run on 2026-11-18, all passing):

```sh
scripts/percolator-v16-reference/probe.sh      # once: test/programs/percolator_v16_probe.so
npx vitest run showcase/test/percolator-v16-reference.test.ts --maxWorkers=2
```

Where no instruction the port has reached can drive the reference into a failure, a probe stands in:
`scripts/percolator-v16-reference/probe/` is the same entrypoint and the same shim (pinocchio 0.11.1 and
solana-program 1.18.26, resolved from the reference's own Cargo.lock), built by `probe.sh` with the same image and
toolchain, with a few operations that panic, allocate and borrow on demand (24,200 bytes, sha256 in
test/programs/SOURCES.md). Each rule below says which of the two it was observed on.

### Accounts

- **255 at most, all of them handed to the program.** pinocchio's `MAX_TX_ACCOUNTS` is 255 and the entrypoint uses it,
  so it never skips an account. [reference: InitPortfolio with a tail of 252 repeated accounts succeeds; a 255-account
  unknown tag reaches the program and is refused as InvalidInstructionData. Probe: all 255 keys arrive in order.]
- **256 and more never reach the program.** The runtime refuses the instruction with `MaxAccountsExceeded`
  ("Program <id> failed: Max accounts exceeded", 0 compute units) before any program runs, so the port gets the same
  refusal from the runtime and needs nothing of its own. (The scope report's "accepts up to 255 and silently ignores
  more" describes pinocchio's code path for a smaller `MAX_ACCOUNTS`; at 255 it cannot be reached.) [reference, raw
  transactions of 256 and 300 accounts; @solana/kit itself refuses to compile more than 255.]
- **At most 64 distinct accounts per transaction** (LiteSVM's account-lock limit), so a long list is mostly repeats.
- The port declares `MAX_ACCOUNTS = 255n`. test/language/many-accounts.test.ts checks a native program at that limit:
  a fixed prefix of three accounts and a tail of 36 and 252 (39 and 255 in all, few or many repeats), read, written
  and forwarded whole in a CPI.
- **Compute units grow with the account count even on a refusal**: the shim scans for repeats pairwise. An unknown tag
  costs the reference 557 CU with no account, 8,977 with 39 and 53,489 with 255 (whole transactions, the preamble's
  300 included); the port 362, 904 and 3,928.

### Heap

- pinocchio's `BumpAllocator` believes the heap is 256 KiB whatever frame the transaction requested. It grows upward
  from the heap's start + 8 (its position is the first word): the first allocation is at `0x300000008`. [probe]
- **An allocation that fits 256 KiB but reaches past the real frame succeeds**; the first write past the frame then
  fails the instruction with ProgramFailedToComplete and the runtime's line "Access violation writing N bytes at
  address 0x3000xxxxx (in unallocated region)", nothing logged by the program. [probe: 40 KiB on the default 32 KiB
  frame faults at `0x30000a007`, writing 1 byte; on a 64 KiB frame it succeeds.]
- **An allocation past 256 KiB fails in the allocator, whatever the frame**: "Program log: Error: memory allocation
  failed, out of memory", then "SBF program panicked" (ProgramFailedToComplete). [probe, 300 KiB on 256 and 32 KiB
  frames]
- **The shim alone never exhausts even the default 32 KiB frame.** Its three Vecs (8, 8 and 48 bytes per account) and
  two Rc boxes per distinct account (32 + 40 bytes) come to about 21 KiB at 255 accounts of which 61 distinct, the
  most a transaction allows. [reference: 255 accounts, 61 distinct, no heap request: InvalidInstructionData as usual.]
- What the port needs: under the harness's 256 KiB preamble no exhaustion is possible (the allocator gives up before
  the frame ends, and nothing in v16 allocates near 256 KiB). On a smaller frame, a fault can only come from what a
  handler allocates on top of the shim (decoded legs and observations, CPI metas and data, the batch matcher's reply).
  Each ported handler's allocations must be counted as the v12.20 port counts TradeCpi's (`cpiHeap` in
  showcase/mainnet/percolator/percolator.ts); where a handler can cross a frame of 32 KiB or more within transaction
  limits, the port needs the fault itself: a store at the same heap address, which TypeSOL cannot make today (a
  built-in for it would be the compiler change). None is known yet, so nothing is built; the mutation fuzzers over
  heap frames decide it (not built yet).

### Repeated accounts and RefCell borrows

The shim gives an account passed twice one shared `Rc<RefCell<…>>` for its lamports and one for its data, so a
handler that holds a borrow of one position while borrowing the other fails there. The port has no borrow flags: it
checks key equality explicitly at each such site, giving the same failure, as each site becomes reachable.

- `try_borrow_data` / `try_borrow_mut_data` / `try_borrow_*_lamports` on a conflict: `ProgramError::AccountBorrowFailed`,
  mapped one to one by the shim; the instruction fails with the built-in AccountBorrowFailed, the program logs
  nothing and the runtime writes "failed: instruction tries to borrow reference for an account which is already
  borrowed". [probe]
- `borrow()` / `borrow_mut()` on a conflict (the original's `**a.lamports.borrow_mut() = …` in CloseSlab and the
  close of a portfolio): a panic, logged as below with the file of the call site (`#[track_caller]`):
  `src/v16_program.rs` in the program's own code, `src/account_info.rs` when the borrow is inside solana-program
  (`AccountInfo::lamports()`, `data_len()`, …). [probe: `src/lib.rs` for its own `borrow_mut`, `src/account_info.rs`
  for `lamports()`]
- What the ported instructions do with repeated accounts, compared in every pair of positions
  (`percolator-v16-accounts.test.ts`): SyncBackingDomainLedger and SyncInsuranceLedger hold the market's data while they
  borrow the ledger's, so the market passed as the ledger fails with AccountBorrowFailed (the port compares the keys at
  that point). Everywhere else a repeated account is refused by an earlier check (a kind, an owner, a length) before any
  borrow could conflict; ClosePortfolio's `**lamports.borrow_mut()` cannot be reached with the portfolio = the market.
- At InitMarket and InitPortfolio no conflict is reachable: a repeated account is refused by an earlier check
  (InitPortfolio with the portfolio = the market: AlreadyInitialized, 2; the market = an uninitialised portfolio:
  NotInitialized, 3; InitMarket with the market as its own mint: InvalidMint, 10). [reference] (The scope report
  expected AccountBorrowFailed at InitPortfolio: the `is_initialized` check comes first.)

### Panics

- A panic logs `location.file()` verbatim, then `** PANICKED **`, and std then aborts: ProgramFailedToComplete,
  "SBF program panicked". No line, column or message. [probe: `panic!`, an index out of bounds, `Vec::with_capacity`'s
  capacity check, `RefCell::borrow_mut` and `AccountInfo::lamports()`, line for line]
- Index, `unwrap`, `RefCell` and capacity panics are reported at their caller, so the file is the caller's. The
  reference binary also holds two toolchain paths
  (`/home/runner/work/platform-tools/platform-tools/out/rust/library/alloc/src/raw_vec/mod.rs` and `…/alloc/src/slice.rs`)
  for panics inside `alloc` that are not; and `src/v16.rs`, `src/wide_math.rs`, `src/v16_program.rs`,
  `src/account_info.rs`, `src/instruction.rs`, `src/pubkey.rs`, `src/state.rs`.
- No panic of the reference itself was found with the instructions reachable so far (a one-off search, not kept as a
  test): each of the 745 fields of an initialised market set to 0, all ones and the two sign boundaries before
  InitPortfolio; each of the 1,508 fields of the market and a portfolio set the same ways and to 1 before a crank
  with no hints (which mostly stopped at EngineNonProgress, 22, before the engine's arithmetic); and 372 InitMarket
  argument variations. All gave error codes or success. The rules above come from the probe, which shares the hook.
- The port writes these with `PANIC_STYLE = "pinocchio"` and the original's file as the location
  (`panic(null, "src/v16.rs:812:9")`, `panicsAt("src/wide_math.rs:…", a / b)`); docs/language-native.md.

## 5. The InitMarket fault of 2026-11-18, and runs since

**What was seen.** One run of `percolator-v16-walk.test.ts` on 2026-11-18 (08:08 KST) failed in its first test, at
the world's first InitMarket ("world empty market"): the reference succeeded (4,875 compute units in the program), the
port failed after 1,029 with `Access violation writing 8 bytes at address 0x4 (in unallocated region)`
(ProgramFailedToComplete). The file's three other tests, which build the port again, passed, and so did every rerun.
The test world's keys come from its seed alone, so the transaction was the same as in the passing runs.

**The cause, reproduced.** The run's output begins with TypeSOL's warning that the build used clang 22.1.2-rust-dev
(anza-xyz/llvm-project a4135d04), not the tested clang 20.1.7. That clang is platform-tools v1.57's. The platform-tools
the build resolves are a link in the Agave installation (`…/sbf/dependencies/platform-tools`), shared by every process
on the machine; its modification time is 08:08 that day: something outside the tests (a `cargo-build-sbf` of another
tools version re-points it) switched it to v1.57 and back while that file's first build ran. With the link pointed at
v1.57 on purpose (`TYPESOL_SBF_SDK` at a copy of the SDK whose `dependencies/platform-tools` is v1.57), the same
InitMarket fails the same way, at the same 1,029 compute units, at the same address; with v1.52 it succeeds (1,823).
An early return moved through the handler's generated C places the fault inside `configFullErr` (the solvency
envelope, the first 128-bit multiplication on the path). clang 22 calls `__multi3` with the operands from r1 and takes
the result in registers; the runtime's assembly `__multi3` (and the three 128-bit shifts) take the result's address
in r1, as clang 20 calls them, so it stored the product through the first operand's low half: address 0x4. This was a
defect of the compiler's runtime with an untested clang, not of the port or of the tested toolchain: the runtime now
compiles C definitions of the four for a clang above 20 (CHANGELOG, test/language/builtins.test.ts), and the port
built with v1.57 passes that InitMarket and the whole world set-up. With v1.52 the binaries are unchanged.

**What else was ruled out.** A stale or half-written binary: each build goes to its own new temporary directory and
is loaded after linking, and no two builds share files (the coverage copy, which was a fixed directory removed by each
run, is now one per process). The keys: the failing transaction is reproduced with the passing runs' keys, by the
toolchain alone. Nothing near a null pointer is computed from accounts in InitMarket's path (every view is the account
data plus a checked offset); the fault was in the builtin.

**What the tests do now.** Keys come from a printed, settable seed (section 2, "Replaying a run"), and a build that
did not use the tested toolchain throughout is refused with a message saying so, instead of being compared.

**Set-ups over many key sets since.** `percolator-v16-setup-stress.test.ts` with `PERCOLATOR_V16_SETUP_STRESS=30000`
(seed `PERCOLATOR_V16_SEED=30752617742135`, 2026-11-18, 353 s): 30,000 rounds, every transaction compared whole with
the reference and alike: InitMarket 34,470 times (4,470 with its accounts permuted, repeated, cut or lengthened, each
refused alike; the 30,000 in order all succeeded in both), and 192,880 of the 192,895 later steps (InitPortfolio,
Deposit, ConfigureAuthMark, ConfigurePermissionlessResolve, Withdraw) succeeded in both, the rest refused alike; market
capacities 1 to 64; vault PDA bumps down to 234 (238 to 244: 159 markets); heap frames: the 256 KiB preamble 9,923,
none 5,077, 32 KiB 5,001, 64 KiB 4,970, 128 KiB 5,029. No fault. (An earlier run of the same size stopped succeeding
after about 8,000 rounds because LiteSVM's airdrop faucet ran dry, alike in both; the harness now writes funded
accounts directly.)
