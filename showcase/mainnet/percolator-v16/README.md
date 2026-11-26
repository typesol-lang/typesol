# Percolator v16 in TypeSOL

> **The original's warning stands for this port: an educational research project, not audited. Do not use it with
> real funds.** (Percolator's engine: "Educational research project. Not production ready. Not audited. Do not use
> with real funds." Its program: "FOR EDUCATIONAL PURPOSES ONLY … This code has NOT been audited. Do NOT use in
> production or with real funds.")

**Status: all 50 instructions of Percolator v16 at commit 7b110913 (engine 5e3af07) are ported**, each compared
transaction by transaction with a reference binary built here from the author's pinned source (not a deployed
program: no v16 build is deployed). The last three, BatchTradeNoCpi (batch.ts) and the matcher ABI v3 with TradeCpi
and BatchTradeCpi (matcher.ts), run the engine's batch (trade.ts `executeBatch`) and call the same three matcher
binaries the author's tests load, in both VMs; the comparison covers the matcher call itself (the inner
instructions), its return data and what the program does after it, with the author's hostile matcher and a rogue
matcher of the tests' own (NOTES.md section 16). No placeholder remains: a decoded instruction always reaches its
handler. Where the reference runs out of its 1,400,000 compute units and the port does not (cranks of 14 legs with 14
hints after price moves, the author's one-shot force-close of two 14-leg portfolios, a batch growing 14 legs), the
reference is run again under a raised compute budget and the port must equal that run (section "Past the reference's
compute-unit limit"). The engine functions of the settlement are in addition compared one by one with the original's
own functions compiled for the host, on generated vectors (TESTING.md), which reach branches the binary comparison
does not. What is not compared is listed at the end ("What is not verified").

A port of Percolator v16 at commit 7b110913 (engine 5e3af07): Anatoly Yakovenko's multi-asset perpetual-futures risk
engine and the Solana program around it, licensed under the Apache License 2.0 (Copyright Anatoly Yakovenko; see
NOTICE).

| | |
| --- | --- |
| Program | aeyakovenko/percolator-prog `7b11091328de23cded2e4afe96592bbd060a6828` (2026-11-15), `src/v16_program.rs`, default features (`anchor-v2`: the pinocchio 0.11.1 entrypoint in front of the native processor) |
| Engine | aeyakovenko/percolator `5e3af0710ec7e9b7077393012f8a94a31b2f07ef` (2026-11-14), `src/v16.rs`, `src/wide_math.rs`, fixed by the program's `Cargo.lock` |
| Reference binary | `test/programs/percolator_v16.so`, 1,375,936 bytes, sha256 `cc35fa4853bddd4e7f58c0e248c7c298ee152625d423ee6ed6b35c9fdfbe60b9`, **built here from those two commits, not deployed anywhere** |
| Toolchain of the reference | Agave 3.1.10 `cargo-build-sbf --tools-version v1.52 -- --locked` (platform-tools v1.52, rustc 1.89.0-dev), linux/amd64 in Docker (`scripts/percolator-v16-reference/`) |
| Instructions | 50, one-byte tags (0–70 with gaps); every persisted struct `#[repr(C)]` bytemuck `Pod` |

Upstream moves quickly (the engine changed by 100–200 lines a day in the weeks before the pin). This port targets the
pin above only; it is not "the current Percolator", and later upstream commits are not compared.

## The reference

No v16 build is deployed that could serve as the comparison target, so the reference is the Rust build of the pinned
commits. `scripts/percolator-v16-reference/build.sh` fetches the sources in a container, builds the program and the
three matchers the author's tests load (aeyakovenko/percolator-match `60aac3a`, and percolator-prog's
`tests/fixtures/auth_matcher` and `tests/fixtures/hostile_matcher`) and copies each into `test/programs/` only when its
sha256 is the one `test/programs/SOURCES.md` records. Why the build can be trusted as the author's own:

- Two clean builds of the pin give the same bytes; the script's own run reproduced them (TESTING.md).
- The same recipe, at the older program commit `cb236b5`, gives `87011b68…`, the sha256 the author's notes in the
  repository record for his own build of that commit (`tests/invariants/inv_089_activation_fee_cpi_audit_20260916.md`,
  "platform-tools v1.52"), and the two test matchers come out with the sha256 his notes record for them.
- The author recorded no hash for the pin itself, and no deployment of it is known: every comparison this port claims
  is against this build, never against a deployed program.

## How it is compared

As the v12.20 port is (showcase/mainnet/percolator): the reference and the port run in two LiteSVMs under the same
program id (`Perco1ator111111111111111111111111111111111`, the original's `declare_id!`) and the same Clock, every
account made the same way in both, and each transaction goes to both (`showcase/test/percolator-v16-helpers.ts`).
They must agree on the outcome and error code, the log lines (v16 has no `msg!`: only panics log), the inner
instructions, the return data and every touched account's lamports, owner, length and bytes (v16 grows accounts
itself: InitPortfolio reallocates a portfolio to its length, asset activation grows the market by one slot). Compute
units are recorded for both; the port must use fewer on every transaction that succeeds.

Every transaction carries the author's own preamble, RequestHeapFrame(256 KiB) and SetComputeUnitLimit(1,400,000), as
`tests/support/v16_svm.rs` sends it: the reference's allocator (pinocchio's default `BumpAllocator`) assumes a
256 KiB heap whatever the transaction requested, so on a smaller frame the reference fails where it allocates past it.
The harness test shows which instructions run on the runtime's default 32 KiB frame
(`showcase/test/percolator-v16-harness.test.ts`).

The log comparison leaves out only the runtime's compute-unit lines (`Program <id> consumed <n> of <m> compute units`,
matched whole); in a coverage run (`PERCOLATOR_V16_PORT_COVERAGE`) the port's branch-probe lines are left out of the
port's side too, and in no other run. Each test file prints how many transactions it compared
(`percolator-v16 compared: …`).

**What the equivalence rests on.** The handlers and the engine code they reach follow the original's statements in
order (the same checks in the same order, the same rounding, the same layout), with stated exceptions: copies the
original makes that the port makes in place (NOTES.md section 1), checks that cannot fail and are not repeated
(NOTES.md section 9 and the port's comments), among them the engine's token-value proofs where their validation
cannot refuse (Withdraw's and the domain insurance withdrawal's are argued in NOTES.md section 17). So the evidence
is not a literal statement-by-statement identity: it is the comparison of every transaction the tests send, the
host-compiled comparison of engine functions on vectors, and those written arguments.

**What CI compares.** The reference binaries are not committed (`test/programs/` is gitignored), so the v16 tests skip
in a checkout without them; each file then prints that it compared 0 transactions. CI's `percolator-v16` job
(`.github/workflows/ci.yml`) builds them from the pinned sources in Docker (`scripts/percolator-v16-reference/build.sh`
and `probe.sh`, each binary kept only at its recorded sha256, then all five checked against `test/programs/SOURCES.md`
again) and runs every `percolator-v16-*` test file under `CI_REQUIRE_ALL=built`, where a missing binary, a missing port
source or a file that compared nothing (no transaction, and for the three vector files no vector) fails the job. The other CI jobs do not run the v16 files. Not compared
in CI: the author's own Rust suite against the port (TESTING.md section 3), the coverage runs, and the longer
generator runs the environment variables in TESTING.md select. The job has not yet run on GitHub's runners: whether
its Docker build there reproduces the recorded hashes, and how long it takes, is not yet observed.

The persisted layouts are in a TypeScript table (`showcase/test/percolator-v16-layout.ts`, every struct field by
field), checked against `offset_of!` / `size_of` printed by the Rust compiler for the pinned sources
(`scripts/percolator-v16-reference/layout.ts`, output in `showcase/test/fixtures/percolator-v16-layout.json`) and
against accounts the reference binary initialised (`showcase/test/percolator-v16-layout.test.ts`).

**Engine functions, one at a time.** Engine functions that no ported instruction reaches (the external oracle reader's
crank-only branches) and the settlement of open legs function by function are compared with the original's own
function compiled for the host (not with the reference binary): a Rust program built in Docker from a copy of the
pinned engine (a harness module added as a child of its `v16` module, so that it can call private functions without
any visibility being changed; TESTING.md says exactly how) answers seeded vectors; a TypeSOL test program runs the
port's same function on the same inputs in LiteSVM; outputs, every changed byte, the engine error and a panic's
location and message must agree. For the settlement this is in addition to the binary comparison through
SyncMaintenanceFee and Withdraw, not instead of it. Branch probes (`scripts/percolator-v16-reference/coverage.ts`)
show which branches of the port's functions each comparison executes.

| Account | Length | Layout |
| --- | ---: | --- |
| Market (kind 1) | 1,190 + 1,845 per asset slot (3,035 at one slot) | 16-byte header, 448-byte wrapper config, 726-byte group header, then the slots: each a 512-byte wrapper (424-byte oracle profile, 88-byte control sequences) and the engine's 1,333-byte asset slot |
| Portfolio (kind 2) | 9,563 | 16-byte header, the engine's 9,419-byte portfolio (16 leg slots, 32 source domains), the 104-byte matcher config, the portfolio id, the owner-state sequence and the matcher expiry (8 bytes each) |
| Backing-domain ledger (kind 3) | 240 | 16-byte header, 224-byte ledger |
| Insurance ledger (kind 4) | 176 | 16-byte header, 160-byte ledger |
| Closed market (kind 5) | 16 | the header alone |

## The author's test suite

aeyakovenko/percolator-prog ships 2,098 `#[test]` functions in six cargo test targets (about 506,000 lines under
`tests/`; the harness lists 2,071 tests). Each loads the program from the path in `PERCOLATOR_FUZZ_SBF`, so the same
suite runs unchanged against the reference binary (built here from the author's source, not a deployed program) and
against the port's. The port's current binary (1,362,912 bytes, sha256 `c6dc6b24…`) ran every target unfiltered on
2026-11-23 to 2026-11-24, the reference on 2026-11-25 to 2026-11-26 (Docker, 2 CPUs, every transaction recorded).
Earlier full runs of two earlier binaries (2026-11-19 to 2026-11-23) gave the same passes and failures; the first of
them found the excesses fixed since (section "Where the port costs more"):

| Target | Tests | Reference: passed / failed | Port: passed / failed |
| --- | ---: | ---: | ---: |
| `listing_oracle_scope` | 2 | 2 / 0 | 2 / 0 |
| `anchor_v2_realloc_probe` | 1 | 1 / 0 | 1 / 0 |
| `open_issue_regressions` | 3 | 3 / 0 | 3 / 0 |
| `v16_program_fuzz_regressions` | 148 | 148 / 0 | 148 / 0 |
| `v16_program_stateful_fuzz` | 336 | 335 / 1 | 335 / 1 |
| `v16_cu` | 1,581 | 1,573 / 8 | 1,571 / 10 |
| **Total** | **2,071** | **2,062 / 9** | **2,060 / 11** |

The reference fails 9 of the author's own tests at this pin (six of the `inv_045…authenticated_reward_handoff`
family, `inv_072…auto_crank_refresh_not_blocked_by_unneeded_first_asset_oracle`,
`inv_077…recovery_kf_progress_survives_stale_42_feed_tail_at_max_shape` and `inv_086…reference_model_matches_deployed_public_sequence`);
the port fails the same 9 at the same assertion with the same message (in two of them the message quotes a failed
transaction's logs, and only the compute-unit figures in those differ). The port fails 2 more, both assertions of the
reference's own compute units, with every transaction before them identical:
`inv_077…max_shape_short_b_budget_has_exact_public_progress` asserts the reference's peak of 554,832 after all its
state assertions pass (the port's peak is 192,398), and `inv_078…force_close_liveness_survives_14_stale_leg_grief_via_precrank`
asserts that a one-shot ForceCloseAbandonedAsset of two 14-leg portfolios exceeds the 1,400,000 limit, which the port
completes (575,741 whole-transaction units; the vitest harness compares that shape with the reference run under a
raised budget, below).

**Transaction by transaction.** Each test's transactions were recorded in both runs (the keys a test makes and
proptest's seed fixed, so that both binaries receive the same transactions) and compared line by line: hashes of the
instructions and keys, the result and error, the return data, the log lines (compute-unit lines left out) and every
account in the transaction's key list after it ran (hashes, not bytes; accounts loaded through an address lookup
table are not hashed, and inner instructions are not recorded apart: TESTING.md section 3). 2,324,991 transactions
compared (1,900 trace files of named tests,
and the transactions of the author's bounded-frontier tests' worker threads, compared as a multiset): 2,324,990
identical. The one difference is `inv_078`'s one-shot force-close above (the reference exhausts its compute units,
the port succeeds); after it the port's test stops, so 35 of the reference's later transactions in that test have no
counterpart. Of the 9 failing tests shared by both, every transaction up to the failure is identical.

Of the 2,127,486 transactions that succeeded identically, none costs the port more compute units than the reference:
67,489,438,873 units in the port against 128,297,605,017 (53%). The first full run, on an earlier binary (sha256 `6677dd5b…`), had found
282 such transactions at three instructions, only at the author's largest shapes; those three were fixed (section
"Where the port costs more" below) and the full run repeated. The scripts fail on anything else: an
unlisted failure or trace difference (every differing transaction of a test is classed, and each kind must be
listed for that test), a listed one that no longer occurs, a target that does not compile, stops at its
limit or runs nothing, a run that records nothing, and any success on which the port costs more (the expectations
file, `scripts/percolator-v16-reference/author-suite-expected.tsv`, lists no such excess; TESTING.md section 3).

## The files

| File | What it ports |
| --- | --- |
| `percolator.ts` | the entry: `split_public_input` and `Instruction::decode` for the 50 tags (every length rule, the vector counts, trailing bytes), then the dispatch to the 50 handlers |
| `state.ts` | every persisted struct as a packed view mirroring the Pod field for field (explicit padding), the layout constants, `check_header` and the kinds, and the on-chain accessors of `mod state` that need no engine logic (portfolio words, ledgers, `validate_wrapper_config`, `validate_asset_oracle_profile`, market lengths and slot offsets, the view checks of `market_view_mut` and `portfolio_view_mut_for_market_slots`) |
| `wire.ts` | the engine's wire conversions: the `try_to_runtime` decoders (enum and bool bytes, i128::MIN, the static checks of backing buckets and insurance reservations, the config's shape check) |
| `errors.ts` | `PercolatorError` (32 variants from code 0) and `map_v16_error` |
| `engine.ts` | the engine code the ported instructions reach (src/v16.rs), beside accrual.ts, refresh.ts and lifecycle.ts: `set_asset_raw_oracle_target_not_atomic`, `set_asset_state`'s blocker totals, `validate_public_user_fund` with the exact solvency envelope, the market's `validate_shape` and aggregate totals, `PortfolioV16View::validate_with_market` (source-credit shape, close-progress ledger, resolved-payout receipt, active legs), `SourceCreditStateV16Account::try_to_runtime`, `compact_source_domains`, `register_` / `deregister_empty_materialized_portfolio_not_atomic`, `deposit_not_atomic`, `domain_insurance_budget_remaining` |
| `program.ts` | the processor's helpers these handlers share: the account, authority and SPL Token checks (the canonical-vault pin), the market preflights (`read_market_config_mode_and_capacity`, `read_market_trade_preflight`, `market_view_mut`), the portfolio bindings, an asset slot's oracle profile and control sequences |
| `refresh.ts` | the engine's maintenance fee and withdrawal (src/v16.rs): `sync_account_fee_to_slot_not_atomic` (the fee anchor, the saturated U256 fee), `settle_negative_pnl_from_principal_core_not_atomic`, `charge_account_fee_current_not_atomic`, `credit_account_from_insurance_not_atomic`, `credit_domain_insurance_budget_not_atomic`, `withdraw_not_atomic` with `account_equity_from_parts`; the settlement of open legs before the fee (settlement.ts) |
| `kernels.ts` | the leaf layer of the settlement of open legs (src/v16.rs, src/wide_math.rs): the source-lien face and backing arithmetic, the backing-bucket, counterparty-lien and insurance-lien deltas, the source-credit recompute and positive-claim burn, the K/F stale cohort, the full-drain reset, the social-loss carry, the resolved-payout rate, a leg's B snapshot, K/F and B targets, K/F delta components with the F snapshot after settlement, its B chunk, the backing utilization rate and fee, the K/F plan keys, and v16's `wide_mul_div_floor_u128`, `floor_div_signed_conservative_i128`, `wide_signed_mul_div_floor_from_k_pair` with the original's panic locations; compared with the original's functions compiled for the host |
| `primitives.ts` | the rest of the leaf layer and layer 2 of the settlement of open legs (src/v16.rs): a domain's source credit state, backing bucket with its effective expiry, insurance reservation, provider principal and insurance budget, the market's totals, residual and junior bound, the reservation-encumbrance proof, the source-credit setters and the domain recompute, the counterparty and insurance liens' create, consume and release, fresh and loser-paid counterparty backing, a Fresh bucket's expiry (wired into UpdateAssetLifecycle's retirement), the post-snapshot residual, the backing utilization fee's collection, a portfolio's sparse source domains, active legs and claim sums; also compared with the original's functions compiled for the host on whole generated markets and portfolios |
| `impairment.ts` | layer 3 of the settlement: the impaired-lien reconciliation (a counterparty lien on an Impaired or lapsed bucket moved into the impaired lane, its fee collected, its backing retired), the release-or-retire choice of a burned lien, the burn of impaired claim fields; compared as primitives.ts is |
| `claims.ts` | layer 4 of the settlement: the source-claim burns (a claim decremented with its domain's bound, liened face burned with its backing released, retired or consumed for a K/F loss, a burn across the slots or one domain first), a domain's prospective support, the consumption of source credit (a domain's, or the portfolio's unliened claims slot by slot) and the PnL setters (`set_account_pnl_inner` and its five callers) |
| `kfsettle.ts` | layer 5: the K/F settlement entries (prepare with the full-drain reset of an exhausted side, apply), the signed K/F delta, the haircut-bounded close loss, the par netting of a loss against the account's own face (twin, fully backed, the loss domain's own), the loss paid from free capital, the realized-loss booking for a domain, the capital-backed loss reservation, the funding flows |
| `settlement.ts` | layers 6 and 7: a leg's B target, the B-stale marks, one B chunk, the account's K/F settlement (one leg, or a plan sorted by phase, domain and slot), `settle_account_side_effects_not_atomic` with its AccountBChunk outcome |
| `custody.ts` | SyncMaintenanceFee and Withdraw, with the fee carry (`market_view_mut_with_fee_carry`, `MaintenanceFeeSplitCarry::split`), `credit_maintenance_fee_to_active_market_budgets_view`, `collect_maintenance_fee_before_value_debit_view`, `reject_portfolio_pending_price_managed_mark_view`, `fee_share_floor`, `verify_withdrawable_token_accounts` and the vault PDA's signed SPL Token Transfer |
| `setup.ts` | InitMarket, InitPortfolio, Deposit, ClosePortfolio (with `init_market_account_zero_copy`, `init_portfolio_account_zero_copy`, `close_portfolio_account_to_market_slab`), SetMatcherConfig |
| `oracle.ts` | ConfigureEwmaMark, ConfigureAuthMark, PushEwmaMark, PushAuthMark, ConfigureHybridOracle (`policy_v16::ewma_update`, the funding-mark checkpoint and transitions, the reconfiguration gate, the base-config mirror) |
| `external.ts` | `mod oracle_v16`'s external readers: Pyth PriceUpdateV2, Switchboard On-Demand, Chainlink OCR2 (owners, lengths, discriminators, every field check in the original's order), the freshness and confidence checks, the e6 scaling, the composite of up to three legs with inversion and unit scale, the legs' coherence and commit (`read_external_price_e6_profile`), `profile_hybrid_soft_stale_matured` |
| `lifecycle.ts` | UpdateAssetLifecycle, RestartAssetOracle, CanonicalizeSpentBackingHistory, with the engine's capacity growth, slot activation, drain-only, retirement and terminal normalisation, recovery, restart and spent-history canonicalisation |
| `accrual.ts` | `accrue_asset_to_not_atomic` (K and F scaled by A, the stale cohorts, the loss-stale flag, the epochs) and the committed funding a shutdown accrues (the premium funding rate from the checkpointed mark) |
| `trading.ts` | TradeNoCpi (`handle_trade_nocpi`, `handle_trade_nocpi_zero_copy`): the zero-move funding accrual before a position change (the canonical accrual path simulated on a copy of the oracle profile, the engine's `accrue_asset_path_to_not_atomic`), the accepted print and the dynamic fee quote (`hybrid_trade_fee_quote_view` and its `policy_v16` helpers), the stale-portfolio guard, the maintenance fees, the source-domain admission and lien bounds, the backing-domain fees (with the engine's `charge_account_backing_fee_not_atomic`), the fee credits to the insurance budgets, the post-trade mark and its staged target, the position epochs |
| `batch.ts` | BatchTradeNoCpi (`handle_batch_trade_nocpi`) and the batch handler BatchTradeCpi shares (`handle_batch_execute_zero_copy`: per leg the accepted print, the fee quote and the zero-move accrual, the collected fees allocated to the legs, the budget credits, the post-trade marks and staged targets) |
| `matcher.ts` | the matcher ABI v3 (`mod matcher_abi`), TradeCpi (`handle_trade_cpi`) and BatchTradeCpi (`handle_batch_trade_cpi`): the LP's matcher config, the delegate PDA, the tail, the accrual and currentness before the call, the request id, the call signed by the delegate, the answer read from the context or the return data and validated, the slippage and fee caps |
| `trade.ts` | the engine's trade and batch (`execute_batch_with_fee_loss_stale_scoped_not_atomic` with one request or several, the position maps kept across the requests): the loss-stale scope, the request's checks, the position plans (`PositionSlotMapV16`), the preflight gates, the fee, the terminal close ledger, the position routes (attach, clear, flip, resize, an obligation retained on a barrier side, with their kernels), the side-OI cap, the residual reward credit, the initial-margin source liens, the margin gates, the zero-OI residue resets |
| `health.ts` | margin and health certificates: a leg's requirements (risk notional, margins, the ADL-effective quantity, the target-lag penalty), the haircut equity with the source claims' realizable support, `compute_account_health_cert_with_price_override`, the recertifications after a trade and a source lien, the certificate's currentness, the H-lock lane, the refresh that settles and certifies an account before a position action |
| `convert.ts` | ConvertReleasedPnl (`handle_convert_released_pnl` in `with_one_portfolio_view`, the lapsed-backing refusal, the engine's `convert_released_pnl_to_capital_not_atomic`: the favorable-action gate, the claims' realizable support consumed and burned, the capital credited) |
| `recovery.ts` | the engine's `forfeit_recovery_leg_not_atomic` (a dead leg's K/F effects settled, a B chunk, the principal, the close ledger, the insurance, the residual booked or Recovery declared, the leg retained as a pending obligation or cleared) and `resolve_market_not_atomic` |
| `resolved.ts` | a Resolved market's close: the CloseResolved plan, `close_resolved_account_not_atomic` (the source domains' preparation and realization with the haircut demotion, the resolved bankruptcy, the solvent legs' detachment), the payout ledger and receipt, the classifier's Resolved winner |
| `closeresolved.ts` | CloseResolved and the crank on a Resolved market (`handle_close_resolved`: the fee credit, the payout's signed SPL Token Transfer) |
| `recoveries.ts` | ForfeitRecoveryLeg, RebalanceReduce, CureAndCancelClose (`with_one_portfolio_view`, the zero-move accrual before the change, the cure's escrow and deposit) |
| `resolution.ts` | ResolveMarket and ResolveStalePermissionless (`resolve_market_view` with `reject_market_resolve_before_committed_accrual_view`) |
| `reserves.ts` | TopUpInsurance, TopUpInsuranceDomain, TopUpBackingBucket, WithdrawBackingBucket, WithdrawBackingBucketEarnings, WithdrawInsuranceAsset (`verify_domain_withdrawal_preflight`, the ledgers' read-or-create and sync, the Live withdrawal's health or matured-shutdown gate, the insurance views), with the engine's fresh-backing deposit and withdrawal, the resolved backing surplus, the earnings withdrawal, the domain-insurance withdrawal and the terminal claim-free recredit |
| `terminal.ts` | CloseSlab (the terminal scan: expiries, recredits, the retirement of the vault, the burn or the native residue, the sweep, the vaults closed, the tombstone and the rent refund), ClaimResolvedPayoutTopup, SwapSecondaryForPrimary, ForceCloseAbandonedAsset (`force_close_recovery_pair_not_atomic` on the trade engine, the residue's forfeit) |
| `policy.ts` | UpdateAuthority, UpdateAssetAuthority, the four market-authority policies, UpdateBackingFeePolicy, UpdateTradeFeePolicy, ConfigurePermissionlessResolve, UpdateBaseUnitMints, SyncBackingDomainLedger, SyncInsuranceLedger |
| `NOTES.md` | the sites where the original swallows an error after changing a copy, decode's allocations, the copies the port makes in place and why that is the same bytes, the paths not ported, and the map of the settlement of open legs (section 10: every function it reaches, layer by layer, and what is ported) |

## Instructions

| Tag | Instruction | Ported |
| ---: | --- | --- |
| 0 | InitMarket | yes (`setup.ts`) |
| 1 | InitPortfolio | yes (`setup.ts`) |
| 3 | Deposit | yes (`setup.ts`) |
| 4 | Withdraw | yes (`custody.ts`, `refresh.ts`, the settlement of open legs in `settlement.ts` and below) |
| 5 | PermissionlessCrank | yes (`crank.ts`, `autocrank.ts`, `liquidation.ts`, the refresh in `health.ts`; a market in Recovery and a Recovery asset's forfeit `recovery.ts`; a Resolved market `closeresolved.ts`, `resolved.ts`; NOTES.md section 13) |
| 6 | TradeNoCpi | yes (`trading.ts`, `trade.ts`, `health.ts`; the settlement of open legs below them) |
| 8 | ClosePortfolio | yes (`setup.ts`) |
| 9 | TopUpInsurance | yes (`reserves.ts`) |
| 10 | TradeCpi | yes (`matcher.ts`, then TradeNoCpi's trade in `trading.ts`) |
| 13 | CloseSlab | yes (`terminal.ts`, the recredit in `reserves.ts`) |
| 19 | ResolveMarket | yes (`resolution.ts`, `recovery.ts`) |
| 24 | TopUpBackingBucket | yes (`reserves.ts`) |
| 28 | ConvertReleasedPnl | yes (`convert.ts`) |
| 30 | CloseResolved | yes (`closeresolved.ts`, `resolved.ts`) |
| 32 | UpdateAuthority | yes (`policy.ts`) |
| 34 | ConfigureHybridOracle | yes (`oracle.ts`, `external.ts`) |
| 35 | ConfigureEwmaMark | yes (`oracle.ts`) |
| 36 | PushEwmaMark | yes (`oracle.ts`) |
| 37 | UpdateLiquidationFeePolicy | yes (`policy.ts`) |
| 38 | ConfigurePermissionlessResolve | yes (`policy.ts`) |
| 39 | ResolveStalePermissionless | yes (`resolution.ts`, `recovery.ts`) |
| 40 | UpdateAssetLifecycle | yes (`lifecycle.ts`; a retirement that expires a lapsed Fresh backing bucket is compared on buckets written into the market by the lifecycle test; TopUpBackingBucket now makes them in the other tests) |
| 42 | CureAndCancelClose | yes (`recoveries.ts`; compared on close ledgers written into the portfolio, since no ported instruction leaves one without progress) |
| 43 | ForfeitRecoveryLeg | yes (`recoveries.ts`, `recovery.ts`) |
| 44 | RebalanceReduce | yes (`recoveries.ts`, liquidation's reduction in `liquidation.ts`) |
| 45 | FinalizeResetSide | yes (`crank.ts`, `autocrank.ts`) |
| 46 | ClaimResolvedPayoutTopup | yes (`terminal.ts`, the receipt in `resolved.ts`) |
| 48 | SyncMaintenanceFee | yes (`custody.ts`, `refresh.ts`, the settlement of open legs in `settlement.ts` and below) |
| 49 | UpdateMaintenanceFeePolicy | yes (`policy.ts`) |
| 50 | WithdrawBackingBucket | yes (`reserves.ts`) |
| 51 | UpdateBackingFeePolicy | yes (`policy.ts`) |
| 52 | WithdrawBackingBucketEarnings | yes (`reserves.ts`) |
| 53 | SyncBackingDomainLedger | yes (`policy.ts`) |
| 54 | SyncInsuranceLedger | yes (`policy.ts`) |
| 55 | UpdateTradeFeePolicy | yes (`policy.ts`) |
| 56 | TopUpInsuranceDomain | yes (`reserves.ts`) |
| 57 | WithdrawInsuranceAsset | yes (`reserves.ts`) |
| 58 | UpdateFeeRedirectPolicy | yes (`policy.ts`) |
| 59 | UpdateMarketInitFeePolicy | yes (`policy.ts`) |
| 60 | UpdateBaseUnitMints | yes (`policy.ts`) |
| 61 | SwapSecondaryForPrimary | yes (`terminal.ts`) |
| 62 | ConfigureAuthMark | yes (`oracle.ts`) |
| 63 | PushAuthMark | yes (`oracle.ts`) |
| 64 | ForceCloseAbandonedAsset | yes (`terminal.ts`, the trade engine in `trade.ts`, the residue's forfeit in `recovery.ts`) |
| 65 | UpdateAssetAuthority | yes (`policy.ts`) |
| 66 | BatchTradeNoCpi | yes (`batch.ts`, the engine's batch in `trade.ts`) |
| 67 | BatchTradeCpi | yes (`matcher.ts`, `batch.ts`) |
| 68 | SetMatcherConfig | yes (`setup.ts`) |
| 69 | RestartAssetOracle | yes (`lifecycle.ts`) |
| 70 | CanonicalizeSpentBackingHistory | yes (`lifecycle.ts`) |

What is compared for the 50 instructions, reference against port, every transaction whole (outcome and error
code, log lines, inner instructions, return data, and the lamports, owner, length and bytes of every account it
names, the fee payer included), in the last run:

- **Success paths across the argument space of the set-up and policy instructions** (`percolator-v16-setup.test.ts`, `percolator-v16-policy.test.ts`):
  InitMarket at capacities 1 to 20 with 1 to 14 configured assets and risk parameters that take the exact solvency
  envelope's branches; InitPortfolio from accounts of 0, 100, 9,547, 9,555 and 9,563 bytes (reallocated); Deposit of
  0, 1 and a whole balance, with its SPL Token Transfer (the inner instruction compared); ClosePortfolio (the account
  dropped, its lamports moved to the market); each policy at its bounds, its sequence and authority epoch; both sides
  of both assets of the backing-fee policy and its policy count; authority rotations and burns; the stale window
  ConfigurePermissionlessResolve opens and what it then refuses; new base-unit mints with each old vault; both ledgers
  created and synced for every domain.
- **Their refusals** (`percolator-v16-setup-refusals.test.ts`, `percolator-v16-policy.test.ts`): missing
  accounts, signers, writability, owners, uninitialized and initialized accounts, wrong kinds and lengths, a Token-2022
  mint, token account and token program (the original accepts SPL Token only), non-canonical vaults, delegates, frozen
  and foreign token accounts, each of InitMarket's argument checks and of the configuration's shape checks, the
  solvency envelope and its funding headroom, rent, portfolio bindings, the vault's TVL cap, authorities, stale
  sequences and epochs, generations and frontiers, the empty-market and empty-vault checks, the ledgers' bindings,
  and a seeded fuzz of 300 InitMarket argument sets (36 accepted by both) and 20 deposits.
- **Set-ups over many key sets** (`percolator-v16-setup-stress.test.ts`): the test world's set-up (InitMarket, two
  InitPortfolios, a Deposit, ConfigureAuthMark, ConfigurePermissionlessResolve, a Withdraw) on markets of fresh keys,
  capacities of 1 to 64 slots, vault PDA bumps down to the 240s, every heap frame from none to 256 KiB, and
  InitMarket's accounts permuted, repeated, cut or lengthened now and then (TESTING.md, section 5).
- **The managed marks and the matcher config** (`percolator-v16-oracle.test.ts`): AuthMark and EWMA configured on both
  assets at marks 1, 10^6 and 10^12, pushed in the same slot, unchanged, in later slots (the funding mark pending,
  kept at its first boundary, replaced in the same slot, activated once the asset's slot catches up), EWMA half-lives
  1 to u64::MAX with minimum fees 0 to u64::MAX over gaps of 0 to 10^6 slots; every refusal in order (marks out of
  range, the half-life, the asset and its generation, the mode of the profile, authorities, epochs, sequences, the
  Clock behind the market or the mark, the market's mode, every lifecycle, the position and loss state, the stress
  flags and recovery reason, asset 0's market-wide quiet, the oracle epoch and blocker counts at u64::MAX, a pending
  boundary ahead, the stale window for assets other than 0); a seeded fuzz of 300 pushes and reconfigurations with
  random marks, half-lives, fees, gaps and funding-field patches. SetMatcherConfig enabled and disabled, every shape
  refusal before any account, the provenance, frontier, id, sequence and epoch, the matcher program, context and
  delegate checks, a stored fee cap, and portfolios of the legacy lengths 9,547 and 9,555 (grown) and one byte too long.
- **The asset lifecycle** (`percolator-v16-lifecycle.test.ts`): appending a slot (the market grown by 1,845 bytes; the
  runtime's InsufficientFundsForRent without the rent; into spare capacity without growth; the activation cooldown),
  drain-only, retirement (with the emptiness checks patched one by one), reactivation of a retired slot after its
  cooldown, shutdown into recovery by the market authority and by the asset's admin, restart, the spent-backing
  canonicalisation of a matched round trip, and their refusals; a seeded fuzz of 400 shutdowns whose committed funding
  is accrued (rates from the mark's premium at the bounds, gaps of 0 to past one segment, A, K, F and the cohort
  epochs at their limits, pending boundaries, the funding epoch at u64::MAX): in the last run 3,000 shutdowns gave 1,869
  successes in both, 529 of them accruing funding; and 300 retirements of an asset whose Fresh backing buckets were
  written into the market (unliened backing at atom and non-atom amounts, a valid lien now and then, expiries passed,
  due or ahead, provider principal below, at or above the reserve, a captured payout snapshot a quarter of the time,
  the fresh-backing total one off now and then): 139 succeeded in both (the buckets expired, the residual they freed
  credited after the snapshot), the rest refused alike.
- **ConfigureHybridOracle and the external oracles** (`percolator-v16-hybrid.test.ts`): each source alone on both
  assets at the price bounds (1, 10^6, MAX_ORACLE_PRICE; Switchboard under its mainnet and devnet owners), composites
  of two and three legs over every allowed divide flag, inverted or not, at unit scales 0, 1, 7 and 10^6, the
  staleness limit (inclusive), the confidence filter at its exact boundary, u64::MAX windows, reconfigurations between
  hybrid, AuthMark and EWMA (the pushes refuse a hybrid asset), a hybrid asset shut down; every refusal of the
  instruction in order (accounts, each argument check, the oracle accounts, the market view, the stale window, the
  authority, epoch and sequence, the profile's validation after the reads) and of each reader field by field (Pyth:
  length, discriminator, verification level, feed id, price sign, exponent ±19, age either side, confidence, scaling
  past u128 and past MAX, owners; Switchboard: key, length, discriminator, submission index 31 and 32, feed hash,
  sample counts, slot, update time, value, standard deviation, a fresh account write over a stale selected result;
  Chainlink: key, length, discriminator, version, round, live length, slot, timestamp, answer sign, decimals 19, scaling
  past u128), legs at different publish times, partial quotients out of range, a read that does not advance (publish
  time 0 or below), the market as a leg (AccountBorrowFailed), the admin as a leg (IllegalOwner), one account for two
  legs; and a seeded fuzz of 400 configurations with legs at their boundaries and random composites (PERCOLATOR_V16_HYBRID_FUZZ).
- **The reader's crank-only branches, on vectors** (`percolator-v16-external.test.ts`): `read_external_price_e6_profile`
  and `profile_hybrid_soft_stale_matured` on 1,500 seeded vectors (stored leg observations older, equal, newer or at
  the same time with another price; Manual and managed profiles; invalid leg configurations; short and repeated
  account lists; every reader mutation), answer for answer and stored leg for stored leg against the original's own
  functions compiled for the host from the pinned sources (`scripts/percolator-v16-reference/oracle-vectors.ts`), **not
  against the reference binary**: no ported instruction reaches these branches (only the crank, not ported, reads a
  profile whose legs hold observations).
- **Permissionless activations with their fee** (`percolator-v16-lifecycle.test.ts`): the fee into market 0's
  insurance domains (an odd fee split ⌊fee / 2⌋ long, the rest short) and the SPL Token Transfer (the inner instruction
  compared), 34 appends from asset 1 to 34 (the market grown past its first slots, one slot each), the fee doubled
  from asset 32 on (and refused under the old maximum), a balance below the fee, the reuse of a retired slot; the
  deposit's refusals on patched state (the vault, the insurance and a budget at u128::MAX, spent above the budget, the
  remaining-budget total at u128::MAX and above the insurance, a source state out of shape, a bucket of another
  market). The shutdown fuzz now configures a third of its assets through ConfigureHybridOracle.
- **SyncMaintenanceFee and Withdraw** (`percolator-v16-refresh.test.ts`): the fee charged at rate × elapsed slots into
  asset 0's insurance budgets with the carry giving odd atoms to alternate sides, the cranker's share (none, a quarter,
  all; the portfolio as its own cranker and another portfolio as the cranker), portfolios a fee empties (closed into
  the market) and does not (the deregistration's LockActive swallowed: NOTES.md site 1); withdrawals of part, all (the
  amount submitted equal to the capital before this instruction's fee withdraws what remains after it), nothing, more
  than the capital and above u64, from the secondary collateral mint's vault, the vault PDA's signed SPL Token Transfer
  compared as an inner instruction; every refusal in order (accounts, signers, writability, owners, Token-2022, the
  binding, the vault authority, each token-account check, the vault's balance, the owner, a fee debt above the
  equity, a loss the capital cannot cover, a resolved or recovering market, the fee slot ahead of the Clock), and
  repeated accounts (the market as the portfolio or the cranker). **Generated states**
  (`percolator-v16-states.ts`, PERCOLATOR_V16_STATE_FUZZ, 400): the market and both portfolios rewritten into states the
  original's validators accept (91% of the Live ones in the last run, 288 of 317, judged by a Deposit of 0, which runs
  `validate_with_market` and the market's shape and nothing else), with zero to two open legs bound to the assets'
  side epochs, PnL of either sign up to ±(2^127 − 1), reserved PnL, fee debt, the locks, the money totals, asset 0's
  domain budgets, the assets' exposure and slots, the fee rate from 0 to u128::MAX, the cranker's share, the carry,
  fee slots behind the Clock by up to its whole value or ahead of it, Live, Resolved and Recovery markets; then
  SyncMaintenanceFee, Withdraw, Deposit or ClosePortfolio, every transaction compared (no placeholder is left).
  **States with open legs the fee settles** (PERCOLATOR_V16_OPEN_STATES, 300): every portfolio with legs, the fee slot
  behind the anchor, the assets' K, F and B indices a step from the legs' snapshots, stale K/F cohorts, ledgers for the
  market's four domains and claims and liens for both portfolios. In a run of 3,000 of them, 810 transactions
  succeeded in both and 328 of those settled legs (the rest refused alike); TESTING.md has the counts, the refusals and
  the branches of the settlement each comparison reached.
- **A market leaving Live, and the recovery and resolution instructions** (`percolator-v16-recovery.test.ts`,
  the crank walk; TESTING.md has the runs): six markets taken out of Live with open legs (a declared Recovery whose
  legs their owners forfeit with budgets from 1 to u128::MAX until a crank resolves the market, ResolveMarket by the
  authority after cranks bring a pending accrual, ResolveStalePermissionless once the stale window is shortened and
  passed, with the matured crank's terminal accrual), then every portfolio closed out by its owner through the crank
  (with and without a backing hint) and CloseResolved, winners paid through receipts at the resolved payout rate,
  losers and bankrupt portfolios through the resolved bankruptcy; the conservation the original's own tests assert
  (the vault's token balance equals the accounted vault, which covers the senior claims) checked in both VMs after
  every close-out, never failing; RebalanceReduce by owners while prices move; CureAndCancelClose on generated close
  ledgers; account and data sweeps of each instruction (every ordered pair of positions, flags, substitutions,
  lengths, boundary values in each field); the crank walk resolves markets with open legs and closes them out, and
  its mutation fuzzer starts one crank in five from a market in Recovery or Resolved.
- **TradeNoCpi and ConvertReleasedPnl** (`percolator-v16-trade.test.ts`, `percolator-v16-trade-walk.test.ts`;
  TESTING.md has the runs): open, increase, reduce, flip and close, long first and short first, on two assets; one
  portfolio with a leg on each of 14 assets (the wrapper's cap: InitMarket refuses 15 and 16 assets per portfolio)
  opened and closed one by one; sizes at 0, ±1, ±10^14 (the cap), ±(10^14 + 1), i128::MIN and i128::MAX; prints at 0,
  1, the effective price, MAX_ORACLE_PRICE, one above and u64::MAX; fees at 0, 1, the market's maximum, one above and
  u64::MAX, under a base-fee policy above the signed fee; backing-fee caps at 0, 10,000, 10,001 and u16::MAX; the
  initial margin to the unit on both parties, with and without a fee; every ordered pair of the five account positions
  repeated, each flag dropped, strangers as signers, the signers swapped, short and long account lists, one owner with
  two portfolios; wrong ids, stale epochs, other assets and market ids, a body a byte short or long. **A random walk on
  real state**: episodes on fresh markets of three assets (AuthMark, EWMA mark, a hybrid on the external oracle
  accounts) with funding, four funded portfolios: trades of every kind (a tenth with corrupted data or accounts), then
  marks pushed away from the prices and the Clock moved a slot at a time while reducing trades accrue the funding and
  syncs settle it, then every position closed, the released PnL converted, the flat portfolios withdrawn; lifecycle
  changes of asset 1 with legs open, policy updates, deposits. **A mutation fuzzer** from a snapshot whose open
  positions, PnL, certificates and claims were made by trades: trades, conversions, syncs and withdrawals with their
  accounts, data or state mutated (the market's group header, asset slots and oracle profiles, the portfolios' state).
- **BatchTradeNoCpi** (`percolator-v16-batch.test.ts`; TESTING.md has the runs): one to 14 legs, mixed signs, open,
  grow, reduce, flip and close in one batch, a close and an open reusing the freed slot of the position map, fees with
  a redirect to market 0 and a base fee, EWMA marks moving with the prints, time passing; 15 to 17 legs, repeated
  assets, prints, sizes, market ids and fees out of range, a backing-fee policy (refused), the initial margin to the
  unit across legs; every ordered pair of the five accounts, flags, strangers, short and long lists, ids, epochs,
  lengths; the heap with no request, 32 and 64 KiB; a seeded sequence of 300 batches with cranks between (131
  succeeding in both, up to five legs).
- **TradeCpi and BatchTradeCpi** (`percolator-v16-cpi.test.ts`), through the author's auth matcher (spreads, limits,
  fees against the base, the market's maximum and the LP's cap, the matcher's backing-fee cap), percolator-match (a
  passive LP), the author's hostile matcher in every mode (over-fills, reversed fills, forged asset, oracle, request
  and LP echoes, a zero price, unflagged and matcher-chosen partials, a short batch reply, a stale answer, a drain of a
  tail account, another program's return data before and after its own) and a rogue matcher of the tests' own
  (`fixtures/percolator-v16-rogue-matcher.ts`: failing, changing an account of its own, calling back into the program,
  return data one to 2,000 bytes too long or 1 to 192 too short or set on a single call, a context resized to 0, 63, 64
  and 200 bytes, a price of 0, at and above MAX_ORACLE_PRICE); every account position of TradeCpi, tails of 32 and 33,
  each forbidden tail account (the program itself among them), the LP's matcher config disabled, expired, replaced
  and disabled by a trade without the matcher; the slippage and fee caps of BatchTradeCpi to the unit, its fan-out
  bound; 14-leg batches on every heap frame; a seeded sequence of 300 matcher trades (193 succeeding in both). The
  inner instructions (the matcher call and what the matcher calls) and the return data are compared with the rest.
- **The walks with batch and matcher trades**: the trade walk sends a fifth of its first phase's trades as
  BatchTradeNoCpi (one to three legs) and a fifth as TradeCpi or BatchTradeCpi against portfolio 3 as the LP of an
  auth matcher (its matcher enabled again whenever another trade disabled it), and a third of its closes as one-leg
  batches; the crank walk does the same with its opening and moving trades, in episodes with and without backing-fee
  policies (a batch refuses any). The conservation check stays asserted in both.
- **Driven on purpose** (`percolator-v16-paths.test.ts`): a trade's counterparty-backed initial-margin source lien
  under a backing-fee policy (TradeNoCpi, and TradeCpi refused at the taker's cap 24 and filled at 25), the provider's
  utilization-fee earnings withdrawn, the flat portfolio's liens released by the crank and a liened domain released
  at the resolved close.
- **Every account position** (`percolator-v16-accounts.test.ts`): for each of the 27, every ordered pair of
  positions repeated, each signer and writable flag dropped, each position replaced by every other account of the
  test world (other kinds and owners, the token programs, Token-2022, the program, the zero key), the list cut to each
  shorter length and one account longer: 3,269 transactions (129 succeed in both). The original holds a borrow of the
  market while it borrows a ledger: the market passed as the ledger fails with AccountBorrowFailed in both. No other
  repeated pair reaches a borrow conflict: an earlier check refuses it (TESTING.md, section 4).
- **A random walk** (`percolator-v16-walk.test.ts`): three seeds of 2,000 steps, each one of the 27 instructions valid
  for the state reached, or with its data (20%) or accounts (12%) corrupted. The market is kept live: the Clock moves
  in bounded steps (now and then a gap of up to 5,000 slots), a keeper refreshes the world's four external oracle
  accounts (Pyth, Switchboard under both owners, Chainlink) at moving prices on four steps in five and pushes asset 0's
  mark, or configures its hybrid oracle again, whenever half the stale window has passed (which refreshes the market's
  liveness); ConfigureHybridOracle reads one to three of those accounts (TESTING.md has its shares by legs), a portfolio that can no longer close is replaced, and a
  market that can no longer make progress (not Live, or a control sequence driven near u64::MAX by a mutated argument)
  is replaced by a fresh one. Every instruction but CanonicalizeSpentBackingHistory (which needs spent-backing history
  no ported instruction makes) succeeds in more than a tenth of its attempts; TESTING.md has the shares. **A mutation
  fuzzer** in the same file (the v12.20 port's `percolator-mutate.ts` idea): 2,000 transactions from one snapshot with
  one mutation each, of the accounts, the data, or the state (a field of the market's wrapper config, group header,
  oracle profiles, control sequences or engine slots, of a portfolio's engine state or its tail words, or of either
  ledger, set to a boundary value first), a fifth of them from a generated state (below) instead, mostly with Deposit,
  Withdraw, ClosePortfolio and SyncMaintenanceFee.

What is compared for decode (`showcase/test/percolator-v16-decode.test.ts`, with no account unless said):

- **Every refusal of decode**, with the same outcome (InvalidInstructionData), log lines, inner instructions, return
  data and accounts: for each of the 50 tags the body cut before, one byte into and one byte short of the end of
  every field; one, two and 32 trailing bytes; for the three vector bodies (PermissionlessCrank, BatchTradeNoCpi,
  BatchTradeCpi) counts of 17, 18 and 255 with and without the data they ask for, counts disagreeing with the data,
  cuts inside the elements and after them; one short and one long body of each tag with three accounts (the payer, a
  writable program-owned account and a mint), all untouched; and 200 random bodies per tag around the valid lengths
  (seed 1618). In the last run, 7,687 inputs were refused by both.
- **The boundary between "refused by decode" and "decoded"**, at the same inputs in both: wherever an input
  decodes, the reference must not have refused in decode (its result is its handler's: NotEnoughAccountKeys
  with no account, or InvalidInstruction (9) where a handler judges an argument first: tags 28, 43, 44, 67 and 68),
  and an independent model of decode in the test agrees on every input. The two can be told apart because the
  original returns InvalidInstructionData from decode only, and with no account no handler reaches a CPI (a matcher
  or SPL Token could fail with InvalidInstructionData of its own). Enum, bool and flag bytes out of range and a vector
  count of 0 decode in both: decode leaves them to the handlers. 3,342 inputs were decoded by both in the last run.
- Every decoded input runs its handler in both and is compared whole (with no account: the handler's first
  refusal).

The layouts are tied to rustc mechanically (`showcase/test/percolator-v16-state.test.ts`): every field's offset and
size of every TypeSOL struct, as the TypeSOL compiler's own model lays it out, against `offset_of!` / `size_of` in
`fixtures/percolator-v16-layout.json`. The wire conversions and some state checks run on known vectors in a test
program, starting from a market and a portfolio the reference initialised.

## Compute units and size

| | Reference | Port |
| --- | ---: | ---: |
| Binary | 1,375,936 bytes | 1,362,912 bytes, sha256 `c6dc6b24…` (all 50 handlers and the engine code they reach; 1,362,872 (sha256 `01c33233…`) before the activation fee's overflow was made the original's, 1,362,760 before the whole-market scans were fixed; 1,258,064 before the batch and matcher instructions, 1,139,536 before the insurance, backing and terminal instructions, 1,005,456 before the crank's Recovery and Resolved paths and the six recovery and resolution instructions, 846,712 before PermissionlessCrank and FinalizeResetSide, 588,856 before TradeNoCpi and ConvertReleasedPnl, 289,728 before SyncMaintenanceFee and Withdraw) |

Compute units of every transaction that succeeded in both, from the run of all 31 `percolator-v16-*` test files on
the current binary (2026-11-23; whole transactions, the preamble's two Compute Budget instructions, 300 CU, included). The figures
are whole-transaction costs: the compute-unit file (`PERCOLATOR_V16_CU_FILE`) books each transaction under the tag of
its first Percolator instruction, so a row's figure includes any other instruction in the same transaction.

The latest run (2026-11-23, the current binary, all 31 files, each alone, `CI_REQUIRE_ALL=built`, all passing: 227
tests) printed 70,975 transactions compared with the port (the sum of the `percolator-v16 compared: …` lines; the count
moves by a few dozen from run to run, because the keys come from a seed drawn per run). The compute-unit file of that
run holds the 70,772 of them that carry a Percolator instruction: 26,077 succeeded, the port cheaper on every one (the
harness fails a test otherwise), 9 of them against the reference's run under a raised budget (below, counted apart
and not in the table); of the 44,695 refusals, 44,685 cost the port less and 10 cost 0 in both (refused by the runtime
before the program ran); none cost the port more. (The run of 2026-11-21 on the previous binary: 70,928 transactions,
26,035 successes, 44,690 refusals; the run of 2026-11-20: 70,881 transactions, 25,995 successes, 44,683 refusals.) Refusals are not held to the rule: the harness asserts fewer compute units only for successful
transactions with a top-level Percolator instruction. (The table's run of 2026-11-19 counted the same way: 70,640
transactions, 25,941 successes, 44,699 refusals.) Every instruction has at least one success. To reproduce: build the
reference binaries, then run each file with `PERCOLATOR_V16_CU_FILE=<file>` and count its lines.

**Where the port costs more.** Nowhere: not in the vitest files on the current binary, and not on any of the
2,127,486 identical successes of the author's whole suite on the current binary (section "The author's test
suite"). The first full run of
that suite, on an earlier binary (1,362,760 bytes, sha256 `6677dd5b…`), had found the port costing more compute units
than the reference on 282 of the 2,127,486 transactions that succeeded identically (whole transactions,
compute-budget instructions included), all at three instructions and all at the author's largest shapes:

| Tag | Instruction | Identical successes | Port above the reference | Largest excess (reference / port) | Where |
| ---: | --- | ---: | ---: | --- | --- |
| 19 | ResolveMarket | 5,367 | 127 | 65,584 / 166,350 | every success above 5,000 units in the reference: the author's 10 MiB market and the `inv_077` terminal tests' capacity markets |
| 13 | CloseSlab | 3,793 | 141 | 37,114 / 42,080 | the generated terminal scans of `inv_071`, `inv_070` and `inv_077…terminal_quote_variants` |
| 0 | InitMarket | 27,165 | 14 | 211,873 / 214,508 | InitMarket of the largest markets (`inv_077` capacity tests) |

The cause, the same in the three: a scan over the market's asset slots that made a view of each slot (`loadRawAt` at
the slot's offset), each with its own owner check and bounds check against the account's length and an offset computed
with overflow checks, 29 instructions a slot in ResolveMarket against the reference's 11, where the original indexes a
slice (`group.markets`) whose bounds the market view checked once. InitMarket's copy of asset 0's profile into every
slot (`copyData` with the offsets) paid the same per-copy checks around its memmove syscall, and CloseSlab also made
both backing expiries effective for every scanned slot (two calls that each read the header). The fix is in the port
(no compiler change): each scan takes one view of the slot array (`rawArrayAt` / `rawArrayMutAt`, bounded by the
capacity the market view took from the length, so its check cannot fail where the original's slice exists), and
CloseSlab makes the expiries effective only for an asset with a Fresh bucket or a recredit, the only steps that read
them (the original makes them first; it cannot fail there, the market being Resolved, and changes nothing). On the
same shapes (`percolator-v16-shapes.test.ts`, TESTING.md "The author's largest market shapes"): ResolveMarket of 5,682
configured slots: port 64,034, reference 65,546 (the port was 166,304); InitMarket of 5,682 slots: port 146,361,
reference 211,905 (the port was 214,540); a CloseSlab scan of 256 assets with fresh backing: port 17,682, reference
41,318 (was port 42,314, reference 38,318).
ResolveMarket and ResolveStalePermissionless remain the closest to the reference at that size (98%): their scan now
costs 11 instructions a slot, as the reference's does, and the port's lead is its smaller fixed part (about 1,500
units).

The author's tests that showed the excesses were run again on the fixed binary (sha256 `01c33233…`, 2026-11-21; the 20 tests of `v16_cu`
whose transactions included one of the 282, `TRACE=1 TEST_FILTER=…`, Docker, 2 CPUs, 57 minutes; TESTING.md section
3): all 20 pass, and their 144,407 transactions are identical to the reference's recorded ones (results, return data,
logs, accounts). Of their 143,473 identical successes none costs the port more; the 282 are all cheaper now, the
closest being the 10 MiB ResolveMarket (port 64,080, reference 65,584; the port was 166,350). Over these tests' successes: ResolveMarket
133 transactions, port 2,141,582 units, reference 2,347,882; CloseSlab 1,491, port 68,478,641, reference
161,181,428 (the largest: port 241,007, reference 554,426); InitMarket 134, port 4,551,942, reference 7,005,969.

The full suite was then run again on that binary (sha256 `01c33233…`, 2026-11-21 to 2026-11-23, every target unfiltered)
and on the current one (sha256 `c6dc6b24…`, 2026-11-23 to 2026-11-24, the reference again on 2026-11-25 to
2026-11-26): each time every transaction identical to the reference's recorded run but the `inv_078` force-close, as
before, and no identical success costing the port more. Over all 2,127,486 identical successes the current binary used
67,489,438,873 units against the reference's 128,297,605,017 (53%; the binary of sha256 `01c33233…`: 67,489,010,058;
of `6677dd5b…`: 67,519,099,673).

**Past the reference's compute-unit limit.** Where the reference runs out of its 1,400,000 compute units and the port
does not, `Diff.send` runs the transaction again in a LiteSVM of the reference whose compute budget is 20,000,000 (the
same program, accounts, Clock and 256 KiB heap; LiteSVM's `withComputeBudget`, which replaces what the transaction's
SetComputeUnitLimit asks for) and requires the port's outcome, logs, inner instructions, return data and every named
account to equal that run's; the reference's accounts then take that run's, so both VMs go on alike
(`percolator-v16-limit.test.ts`, the crank's maximum shape, the batch test). In the last run, all equal: a crank of 14
legs with 14 hints after price moves, five times (1,414,112 to 1,538,961 in the reference, 515,972 to 553,760 in the
port); the author's `inv_078` one-shot ForceCloseAbandonedAsset of two portfolios of 14 legs (port 396,866,
reference 1,479,026; the pre-crank path of the same test fits in both, port 197,353, reference 870,198); a
BatchTradeNoCpi growing 14 legs (port 506,434, reference 1,920,381) and closing them (port 400,135, reference
1,409,575).

**Trades.** The original's own CU tests (`tests/v16_cu.rs`) assert 345,000 for a trade and 750,000 for a multi-asset
open trade. The reference's most expensive TradeNoCpi here is 947,654 CU (the port's worst 349,490), a trade whose
portfolios the refresh settles before the fill. The 14th leg opened on one portfolio costs the reference 388,005 and
the port 101,865 (`percolator-v16-trade.test.ts`). BatchTradeNoCpi and BatchTradeCpi cost the port 37% of the
reference on the mean (worst cases: port 392,289, reference 1,124,628; port 345,720, reference 1,027,411); TradeCpi, matcher call
included, 40%.

**ForceCloseAbandonedAsset** runs the trade engine on two portfolios: its 121 successes averaged 837,372 CU in the
reference and 297,261 in the port (worst: port 328,077, reference 926,958).

**The crank.** The author's CU tests assert 325,000 for a crank and 1,375,000 to 1,400,000 for their maximum shapes.
Shapes recorded (reference / port, whole transactions):

| Shape | Reference | Port |
| --- | ---: | ---: |
| a flat portfolio, no hint (NonProgress) | refused | refused |
| one leg, its hint, the price moving (walk, mean) | 323,064 | 122,539 |
| the costliest success within the limit | 1,317,922 | 485,624 |
| 14 legs, 14 hints after four slots of moves | 1,414,112 to 1,538,961 (raised budget) | 515,972 to 553,760 |

| Tag | Instruction | Successes | Reference mean | Port mean | Reference worst | Port worst | Port / reference (mean) | (worst case) |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | InitMarket | 806 | 8,720 | 3,906 | 211,905 | 146,361 | 45% | 69% |
| 1 | InitPortfolio | 1,256 | 29,603 | 17,029 | 38,471 | 21,994 | 58% | 59% |
| 3 | Deposit | 1,397 | 37,118 | 18,140 | 97,372 | 34,830 | 49% | 57% |
| 4 | Withdraw | 538 | 42,452 | 22,346 | 349,639 | 122,480 | 53% | 60% |
| 5 | PermissionlessCrank (every market) | 8,677 | 323,070 | 122,540 | 1,317,922 | 485,624 | 38% | 60% |
| 6 | TradeNoCpi | 1,225 | 315,597 | 133,052 | 947,654 | 349,490 | 42% | 63% |
| 8 | ClosePortfolio | 173 | 29,977 | 19,660 | 35,228 | 22,238 | 66% | 68% |
| 9 | TopUpInsurance | 104 | 24,194 | 8,167 | 36,984 | 11,540 | 34% | 39% |
| 10 | TradeCpi | 248 | 320,067 | 127,130 | 787,704 | 308,995 | 40% | 62% |
| 13 | CloseSlab | 525 | 35,762 | 13,612 | 180,130 | 77,917 | 38% | 44% |
| 19 | ResolveMarket | 33 | 9,622 | 7,940 | 65,546 | 64,034 | 83% | 98% |
| 24 | TopUpBackingBucket | 184 | 31,801 | 10,445 | 47,893 | 16,585 | 33% | 37% |
| 28 | ConvertReleasedPnl | 3 | 94,958 | 45,783 | 102,462 | 46,972 | 48% | 54% |
| 30 | CloseResolved | 668 | 177,328 | 63,770 | 392,694 | 144,114 | 36% | 61% |
| 32 | UpdateAuthority | 180 | 2,594 | 1,104 | 2,866 | 1,140 | 43% | 44% |
| 34 | ConfigureHybridOracle | 554 | 7,314 | 3,853 | 10,919 | 6,120 | 53% | 61% |
| 35 | ConfigureEwmaMark | 270 | 4,462 | 2,293 | 4,754 | 2,375 | 51% | 52% |
| 36 | PushEwmaMark | 1,216 | 6,933 | 2,741 | 7,139 | 2,817 | 40% | 42% |
| 37 | UpdateLiquidationFeePolicy | 222 | 1,939 | 831 | 2,171 | 853 | 43% | 43% |
| 38 | ConfigurePermissionlessResolve | 599 | 2,106 | 989 | 2,379 | 1,033 | 47% | 48% |
| 39 | ResolveStalePermissionless | 3 | 25,428 | 23,827 | 65,216 | 63,962 | 94% | 98% |
| 40 | UpdateAssetLifecycle | 708 | 17,991 | 8,264 | 39,219 | 16,573 | 46% | 56% |
| 42 | CureAndCancelClose | 41 | 313,424 | 114,707 | 346,176 | 127,738 | 37% | 38% |
| 43 | ForfeitRecoveryLeg | 40 | 174,827 | 65,483 | 296,231 | 102,769 | 37% | 45% |
| 44 | RebalanceReduce | 32 | 206,248 | 75,861 | 310,970 | 116,934 | 37% | 42% |
| 45 | FinalizeResetSide | 8 | 2,341 | 1,047 | 3,427 | 1,354 | 45% | 51% |
| 46 | ClaimResolvedPayoutTopup | 472 | 37,610 | 21,612 | 61,765 | 27,770 | 57% | 61% |
| 48 | SyncMaintenanceFee | 490 | 77,851 | 40,094 | 371,983 | 133,299 | 52% | 66% |
| 49 | UpdateMaintenanceFeePolicy | 213 | 1,929 | 850 | 2,167 | 871 | 44% | 45% |
| 50 | WithdrawBackingBucket | 51 | 48,364 | 19,725 | 50,935 | 20,415 | 41% | 46% |
| 51 | UpdateBackingFeePolicy | 238 | 6,163 | 3,108 | 14,656 | 8,023 | 50% | 55% |
| 52 | WithdrawBackingBucketEarnings | 1 | 39,169 | 16,974 | 39,169 | 16,974 | 43% | 43% |
| 53 | SyncBackingDomainLedger | 175 | 3,923 | 1,628 | 7,179 | 2,554 | 41% | 47% |
| 54 | SyncInsuranceLedger | 151 | 2,572 | 1,250 | 3,662 | 1,418 | 49% | 51% |
| 55 | UpdateTradeFeePolicy | 231 | 3,208 | 1,663 | 13,570 | 7,471 | 52% | 55% |
| 56 | TopUpInsuranceDomain | 116 | 19,677 | 6,527 | 30,027 | 8,909 | 33% | 37% |
| 57 | WithdrawInsuranceAsset | 58 | 40,718 | 16,110 | 62,598 | 20,882 | 40% | 45% |
| 58 | UpdateFeeRedirectPolicy | 228 | 1,931 | 847 | 2,169 | 870 | 44% | 44% |
| 59 | UpdateMarketInitFeePolicy | 237 | 1,944 | 868 | 2,177 | 890 | 45% | 45% |
| 60 | UpdateBaseUnitMints | 96 | 10,278 | 3,160 | 11,839 | 3,837 | 31% | 33% |
| 61 | SwapSecondaryForPrimary | 3 | 21,373 | 7,097 | 21,373 | 7,097 | 33% | 33% |
| 62 | ConfigureAuthMark | 1,295 | 4,403 | 2,241 | 4,744 | 2,365 | 51% | 52% |
| 63 | PushAuthMark | 1,429 | 6,586 | 2,777 | 6,760 | 2,906 | 42% | 44% |
| 64 | ForceCloseAbandonedAsset | 121 | 837,372 | 297,261 | 926,958 | 328,077 | 35% | 41% |
| 65 | UpdateAssetAuthority | 185 | 2,348 | 1,135 | 2,622 | 1,207 | 48% | 50% |
| 66 | BatchTradeNoCpi | 188 | 570,542 | 211,207 | 1,124,628 | 392,289 | 37% | 62% |
| 67 | BatchTradeCpi | 108 | 544,259 | 204,101 | 1,027,411 | 345,720 | 38% | 62% |
| 68 | SetMatcherConfig | 230 | 5,502 | 1,984 | 12,514 | 3,744 | 36% | 51% |
| 69 | RestartAssetOracle | 41 | 13,839 | 5,007 | 14,066 | 5,043 | 36% | 36% |
| 70 | CanonicalizeSpentBackingHistory | 1 | 9,973 | 3,801 | 9,973 | 3,801 | 38% | 38% |

"Worst case" is the highest port / reference ratio of one transaction; the two "worst" columns are each side's
highest figure. Every row is from the run of 2026-11-23 on the current binary (`percolator-v16-shapes.test.ts`'s
markets of up to 5,682 slots give the worst cases of InitMarket, CloseSlab, ResolveMarket and
ResolveStalePermissionless). These figures vary from run to run with the keys, which come from a seed drawn per run:
a key's PDA bump decides how many hashes `find_program_address` costs, so a transaction deriving a PDA (CloseSlab's
vault authority, for one) moves by up to a few thousand units in the reference and by less in the port. CloseSlab's
residual scan of 256 assets on the 5,682-slot market measured reference 179,870 / port 74,832 and 181,370 / 75,177 in
two runs on the current binary (182,870 / 75,544 and 181,370 / 75,199 on the previous one, whose scan code is the
same). ResolveMarket and ResolveStalePermissionless are closest to the reference at the largest
shapes: their scan of the configured slots costs 11 instructions a slot in both, and the port's lead is its smaller
fixed part (port 64,034, reference 65,546 for 5,682 slots; section "Where the port costs more"). InitMarket's cost grows with
the market's capacity (asset 0's 424-byte oracle profile is copied into every slot): the port copies it with the
memmove syscall, a whole-struct assignment between two elements of one view of the slot array, whose bounds were
checked once, so each copy is the syscall and a few instructions (until 2026-11-21 it was `copyData` with the offsets,
whose per-copy bounds and overflow checks cost the port more than the reference from about 3,000 slots on). ConfigureHybridOracle's cost grows with its legs (one to three oracle accounts read). SyncMaintenanceFee's and Withdraw's grow with the portfolio's legs and source domains and with what the settlement of
its legs does (the liens reconciled and burned, the source credit consumed, the K/F netting and booking, the B
chunks): the original validates the portfolio against the market up to five times (`validate_with_market`, a scan of
the 32 source domains and 16 legs), and the port makes every one of those validations; their highest counts here
(port 133,151, reference 371,983; port 122,241, reference 349,639) are on generated states with open legs. In a run of 3,000 such
states (TESTING.md) the 558 SyncMaintenanceFee successes averaged 170,907 CU in the reference and 65,934 in the port
(worst: port 194,948, reference 565,641), and none of the 2,908 successes cost the port more. UpdateAssetLifecycle's highest
count is a retirement that expires lapsed Fresh backing buckets on both sides (port 16,560, reference 39,219); an activation that appends a slot (the market reallocated by 1,845 bytes, zeroed by the memset syscall in both). Refusals are not
required to cost less; none of the 44,695 compared in the last run costs the port as much (10 transactions refused by the runtime before
the program ran cost 0 in both). Before the compiler zeroed with the memset syscall (from 64 bytes, as the
reference's realloc does) and copied whole structs in account data with the memmove syscall (from 80 bytes), 13
refusals of InitPortfolio and ClosePortfolio after a reallocation from a shorter length cost the port more (about
3,000 CU for 9,563 bytes zeroed by stores), and a successful InitPortfolio from a 0-byte account cost 20,876 (now
16,129; the reference 27,754). On the same transactions that change took 4,750 CU off InitPortfolio from an empty account
and 2,069 off every Deposit and ClosePortfolio, and added one to InitPortfolio when the account grows by fewer than
64 bytes (the length is tested at run time; two transactions of these tests, 8 and 16 bytes).

The refusals of decode (whole transactions, preamble included; measured with the build of decode alone, before any
handler was ported: decode runs before the handlers and is the same code):

| Refused (InvalidInstructionData) | Reference | Port |
| --- | ---: | ---: |
| No data | 547 | 362 |
| An unknown tag, no account (each of the 206) | 552–557 | 362 |
| No data, 3 accounts | 1,288 | 406 |
| An unknown tag, 2 accounts | 1,058 | 393 |
| An unknown tag, 39 accounts | 8,977 | 904 |
| An unknown tag, 255 accounts | 53,489 | 3,928 |

Decode refusals per tag, with three accounts (the payer, a writable program-owned account, a mint): the body one byte
short and with one trailing byte (tags without a body cannot be short). The port costs less on every one (refusals
are not required to; the test checks it). The reference's cost grows with the bytes it reads before it refuses; the
port compares one length.

| Tag | Instruction | One byte short: reference | port | One trailing byte: reference | port |
| ---: | --- | ---: | ---: | ---: | ---: |
| 0 | InitMarket | 1,397 | 441 | 1,431 | 441 |
| 1 | InitPortfolio | – | – | 1,306 | 443 |
| 3 | Deposit | 1,312 | 448 | 1,327 | 448 |
| 4 | Withdraw | 1,310 | 448 | 1,324 | 448 |
| 5 | PermissionlessCrank | 1,443 | 443 | 1,467 | 443 |
| 6 | TradeNoCpi | 1,402 | 454 | 1,481 | 454 |
| 8 | ClosePortfolio | 1,310 | 455 | 1,323 | 455 |
| 9 | TopUpInsurance | 1,314 | 456 | 1,330 | 456 |
| 10 | TradeCpi | 1,413 | 454 | 1,495 | 454 |
| 13 | CloseSlab | 1,304 | 462 | 1,311 | 462 |
| 19 | ResolveMarket | 1,308 | 463 | 1,318 | 463 |
| 24 | TopUpBackingBucket | 1,329 | 461 | 1,351 | 461 |
| 28 | ConvertReleasedPnl | 1,310 | 460 | 1,325 | 460 |
| 30 | CloseResolved | 1,305 | 463 | 1,315 | 463 |
| 32 | UpdateAuthority | 1,313 | 461 | 1,333 | 461 |
| 34 | ConfigureHybridOracle | 1,444 | 466 | 1,452 | 466 |
| 35 | ConfigureEwmaMark | 1,326 | 467 | 1,348 | 467 |
| 36 | PushEwmaMark | 1,321 | 465 | 1,341 | 465 |
| 37 | UpdateLiquidationFeePolicy | 1,310 | 466 | 1,323 | 466 |
| 38 | ConfigurePermissionlessResolve | 1,317 | 465 | 1,333 | 465 |
| 39 | ResolveStalePermissionless | 1,306 | 466 | 1,314 | 466 |
| 40 | UpdateAssetLifecycle | 1,415 | 467 | 1,560 | 467 |
| 42 | CureAndCancelClose | 1,312 | 466 | 1,327 | 466 |
| 43 | ForfeitRecoveryLeg | 1,314 | 472 | 1,332 | 472 |
| 44 | RebalanceReduce | 1,315 | 472 | 1,333 | 472 |
| 45 | FinalizeResetSide | 1,305 | 482 | 1,314 | 482 |
| 46 | ClaimResolvedPayoutTopup | – | – | 1,306 | 454 |
| 48 | SyncMaintenanceFee | 1,304 | 473 | 1,312 | 473 |
| 49 | UpdateMaintenanceFeePolicy | 1,308 | 472 | 1,320 | 472 |
| 50 | WithdrawBackingBucket | 1,312 | 489 | 1,330 | 489 |
| 51 | UpdateBackingFeePolicy | 1,319 | 489 | 1,335 | 489 |
| 52 | WithdrawBackingBucketEarnings | 1,311 | 489 | 1,328 | 489 |
| 53 | SyncBackingDomainLedger | 1,303 | 489 | 1,312 | 489 |
| 54 | SyncInsuranceLedger | – | – | 1,307 | 453 |
| 55 | UpdateTradeFeePolicy | 1,308 | 489 | 1,320 | 489 |
| 56 | TopUpInsuranceDomain | 1,315 | 489 | 1,334 | 489 |
| 57 | WithdrawInsuranceAsset | 1,313 | 489 | 1,331 | 489 |
| 58 | UpdateFeeRedirectPolicy | 1,308 | 472 | 1,321 | 472 |
| 59 | UpdateMarketInitFeePolicy | 1,309 | 489 | 1,323 | 489 |
| 60 | UpdateBaseUnitMints | 1,312 | 489 | 1,354 | 489 |
| 61 | SwapSecondaryForPrimary | 1,307 | 489 | 1,319 | 489 |
| 62 | ConfigureAuthMark | 1,318 | 470 | 1,338 | 470 |
| 63 | PushAuthMark | 1,319 | 470 | 1,339 | 470 |
| 64 | ForceCloseAbandonedAsset | 1,308 | 489 | 1,323 | 489 |
| 65 | UpdateAssetAuthority | 1,320 | 489 | 1,345 | 489 |
| 66 | BatchTradeNoCpi | 1,459 | 458 | 1,532 | 458 |
| 67 | BatchTradeCpi | 1,484 | 459 | 1,569 | 459 |
| 68 | SetMatcherConfig | 1,371 | 489 | 1,441 | 489 |
| 69 | RestartAssetOracle | 1,318 | 470 | 1,337 | 470 |
| 70 | CanonicalizeSpentBackingHistory | 1,310 | 476 | 1,323 | 476 |

The reference's cost grows with the account count before it decodes anything: its entrypoint builds an `AccountInfo`
list with a pairwise scan for repeated accounts. The reference's own figures from the harness test
(whole transactions, the preamble's two Compute Budget instructions included): InitMarket 5,231 (4,875 without the
preamble), InitPortfolio 27,666 (27,310 without; 27,747 when it reallocates a 0-byte account), a refused InitMarket
2,237, an unknown tag 557.

## What is not verified

- That the pin builds to the author's own bytes: he recorded no hash for it (only for older commits, which the recipe
  reproduces).
- The matcher programs: only the three the author's tests load (built here from their pinned sources, the same binaries
  in both VMs) and the tests' own rogue matcher; no deployed matcher. A matcher that answers with more than one fill
  per leg, or a matcher of another ABI version, is compared only through the refusals of its answers. The crank's Recovery and Resolved paths, the recovery and resolution instructions and the insurance,
  backing and terminal instructions are compared on real state (legs opened by trades, prices moved, portfolios
  bankrupt, Fresh backing and insurance deposited and withdrawn, markets resolved and closed by CloseSlab) except
  where noted: a market in Recovery is declared by a write of its mode and reason into both VMs in the dedicated tests
  (no crank in this repository's tests declared one; the author's tests do, below), and CureAndCancelClose runs on close ledgers written into the
  portfolio (no ported instruction leaves one without progress). Now entered by
  compared transactions on real state (`percolator-v16-paths.test.ts`): a trade's counterparty-backed initial-margin
  source lien and its backing-domain fee (TradeNoCpi and TradeCpi), the provider's utilization-fee earnings and their
  withdrawal, ReleaseSourceLiens on the flat portfolio and a source lien's release at the resolved close. Still entered
  by no transaction of this repository's tests, by the branch probes (TESTING.md "Paths driven on purpose" says why
  for each): AdvanceClose, a crank's declaration of Recovery, a leg retained as a pending obligation,
  WithdrawBackingBucket's emptied-bucket statuses (Impaired, Expired), CloseSlab's native-mint residue path. (The
  terminal scan past 256 assets is now compared, on a market of 5,682 configured slots whose scan state is written into
  it, every step of it: Continue, ScanProgress, the wait at a live Fresh bucket and LockActive from it, the expiry of a
  lapsed Fresh bucket, a nonzero recredit, and the last batch refused while a domain budget remains, then ReadyToClose:
  `percolator-v16-shapes.test.ts`. The activation fee at the top of u128, which no instruction can store, is compared
  on a fee written into the market: `percolator-v16-lifecycle.test.ts`.) Of these, the author's tests enter AdvanceClose with a pending close ledger, a crank's
  declaration of Recovery, a leg retained as a pending obligation through ForfeitRecoveryLeg (not through a trade)
  and the Expired status, in
  transactions identical in both binaries' runs (a probed port on 16 chosen tests; TESTING.md section 3 names them);
  no vitest reproduces those yet. The Impaired status and the native-mint residue were not
  reached by the tests probed (the rest of the author's suite was not probed). wire.ts's conversions are compared only as far as the 50 handlers reach them; the state mutations reach active legs, source domains and the
  close-progress ledger through `validate_with_market` only.
- The settlement of a portfolio's open legs is compared with the reference binary on generated states and on real
  state (legs opened by trades; since the crank, K deltas from moving prices and liquidations too). B chunks, impaired
  liens and a socialised loss in the walk do not arise from real instructions there (the dedicated bankruptcy tests
  book a residual into a B index; a B chunk needs a B index ahead of a leg's snapshot while the leg survives, which the
  walk's liquidations do not leave). Branches of its
  functions that the binary comparison does not reach are compared only on host vectors, and some are reached by
  neither (TESTING.md lists them with the reason).
- The crank's refresh with its price override, B chunks and lapsed-backing scan, and
  `certify_account_after_local_settlement_…`, are ported with the crank; with TopUpBackingBucket ported, the
  lapsed-backing expiry, the trade's initial-margin source liens and the terminal trade's close-progress ledger are
  now entered by compared transactions; a trade's backing-domain fee (`apply_backing_domain_fees_after_trade_view`,
  `charge_account_backing_fee_not_atomic`) is now too (above); the retention of a cleared leg as a pending
  obligation by a trade (a domain-loss barrier on its side) is still not entered, by these tests or by the author's
  tests probed; the author's tests enter the same retention kernel through ForfeitRecoveryLeg only, identically in
  both binaries (above).
- UpdateAssetLifecycle's retirement of an asset with a lapsed Fresh backing bucket: compared with the reference binary
  on buckets written into the market (the lifecycle test predates TopUpBackingBucket's port), on a Live market. Accrual is reached only through a shutdown at the asset's frozen price (so its
  price-move branch, which needs a new price, only by its checks; ConfigureHybridOracle resets an empty asset's anchor
  to the read price without accruing): its K deltas are zero there and its funding path is compared numerically; the
  crank's accrual paths are compared through the crank.
- The external reader's branches that the crank cannot reach (a Manual or managed profile, an invalid stored leg
  configuration, fewer accounts than legs) are compared only with the original's source compiled for the host, on
  vectors; the ones the crank reaches (legs that already hold observations, the fall-back to the mark, the liveness) are
  compared with the reference binary (NOTES.md section 8). The oracle accounts are
  synthetic, built from the offsets the original reads; no mainnet account snapshot was used.
- Activation at large indices: appending with the fee was compared up to index 34 (refusals at 35) and reuse at
  indices 5, 7 and 33 (the fee doubling at 32); the second doubling (64) and beyond were not run. The doubling's overflow is compared on
  base fees of u128::MAX, u128::MAX/2 + 1 and u128::MAX/2 written into the market (no instruction stores a base fee
  above u64::MAX), at indices 7, 33 and 35 only.
- Markets near the 10 MiB limit: InitMarket, ResolveMarket, ResolveStalePermissionless and CloseSlab are compared on
  markets of 1,000 and 5,682 slots (`percolator-v16-shapes.test.ts`), the grown markets' configured count, last asset
  and scan state written into the market; the other instructions were not run on markets of that size.
- The heap: the original's allocations beyond the entrypoint's account list are decode's vectors, the SPL Token
  Transfers' and the matcher calls' instructions, and the batch's vectors; most compared transactions requested the
  author's 256 KiB frame. The largest batch and matcher transactions (14 legs; TradeCpi with a tail of 32) were also
  sent with no heap request and with 32 and 64 KiB frames and agree; how close the reference comes to the end of the
  default frame was not measured. The port allocates too (CPI scratch and copies of struct arguments, NOTES.md
  section 18), within its own 32 KiB; an out-of-heap failure of either side would be a difference, and none occurred.
- The author's own suite (above): its traces hold hashes, not bytes, of the instructions, the result, the return data,
  the log lines (the compute-unit lines left out) and every account in the transaction's static key list after it ran.
  Accounts a version-0 transaction loads through an address lookup table (the `inv_006` lookup-table tests send such
  transactions) are not hashed, nor is the lookup part of the message; the inner instructions are not recorded apart
  (their effects are, through the accounts and the logs); state the tests read without sending a transaction is
  compared only through the tests' own assertions.
- A 14-leg portfolio's liquidation: the cranks that would get there in the maximum-shape test run the reference past
  its limit; those are compared with the reference's run under a raised budget, and only the first legs' liquidation
  is reached there.
- A panic of the reference itself: one is reached, CloseResolved (or the crank on a Resolved market) with the market
  passed as the portfolio (a RefCell borrow of the market's data while it is borrowed mutably,
  src/account_info.rs); the port panics there too, and only the file is logged, so the line and column it records
  (91:19 of solana-program 1.18.26) come from the source, not from a comparison. None other was reached by the ported
  instructions (the walks, the mutations and the sweeps included). The panic lines, the heap
  failures and the RefCell failures were observed on a probe built with the same entrypoint and toolchain
  (TESTING.md, section 4).
