# Notes on the Percolator v16 port

Percolator v16 at commit 7b110913 (engine 5e3af07). What reading the pinned sources (aeyakovenko/percolator-prog
`src/v16_program.rs`, aeyakovenko/percolator `src/v16.rs`) showed that every ported instruction must keep, and what the
ported handlers do about it. Line numbers are those of the pinned files.

## 1. Copies in the original that the port makes in place

The port works on views of the account data, changed in place, where the original often copies a struct out
(`*market_header(data)?`, `read_wrapper_config_from_bytes`, `read_asset_oracle_profile`, `pod_read_unaligned`), changes
the copy and writes it back. That is the same bytes whenever a failure after the change fails the transaction (Solana
then discards every change). It is not the same where the original **looks at an error and continues**: then the copy
is dropped, the persisted bytes keep their old value, and an in-place port would keep the partial change. Sites found
by reading (a search for `Err(..) =>`, `.is_err()`, `.is_ok()`, `.ok()`, `unwrap_or` and `let _ =` in both files, each
read in context):

| # | File, function | What is swallowed | What the port must do |
| ---: | --- | --- | --- |
| 1 | src/v16_program.rs `handle_sync_maintenance_fee` (11847; the match at 11985) | `deregister_empty_materialized_portfolio_not_atomic` returning `V16Error::LockActive` becomes "do not close", and the instruction goes on to succeed | The engine call works on the market view in place in the original too (`MarketViewMutV16` over the account data), so a write it made before returning LockActive persists in both. The port's version of `deregister_…` must leave exactly the original's partial state on LockActive (it writes nothing before that error: section 3). **Ported** (custody.ts, section 9): compared on portfolios a fee leaves non-empty, every one a success that keeps the portfolio. |
| 2 | src/v16_program.rs `handle_permissionless_crank_zero_copy` (14060; the match at 14472) | `permissionless_auto_crank_not_atomic` returning `V16Error::NonProgress` after `market_accrual_performed` becomes `None`, and the crank goes on (and can succeed) | As 1: in place in both, so the engine's writes before NonProgress persist in both; the port's auto-crank must leave the same partial state. **Ported** (crank.ts, autocrank.ts, liquidation.ts, accrual.ts; section 13): every NonProgress the engine crank can return (the Refresh's accrual, a Refresh with no asset and no observation, liquidation's four, AdvanceClose's two, ReleaseSourceLiens' two) is a value (`NONPROG`) returned after exactly the writes the original made before it; the processor then continues as the original does. Compared with the reference binary: a liquidation whose score did not fall after its fee and refresh, a bankrupt close whose residual did not fall, swallowed in both with the same bytes. |
| 3 | src/v16.rs `permissionless_auto_crank_not_atomic` (17129; the match at 17219) | `clear_leg` returning `V16Error::Stale` becomes `advanced = false`, and the crank goes on to the ordinary refresh dispatch | `clear_leg` → `clear_leg_inner(account, asset_index, false)` changes the portfolio and market views in place; any write before the Stale return persists in the original. The port must reproduce the order of writes and checks in `clear_leg_inner` exactly. **From reading** (the crank is not ported): the Stale that `prepare_counterparty_backing_expiry_delta` can return does not reach this match. `clear_leg_inner` (18469) and the `clear_leg_at_slot_inner` it calls reach only `require_active_leg_slot_for_asset`, the leg and close-progress decodings, `has_pending_domain_loss_barrier`, `asset_state`, the K/F and B targets, `leg_kf_epoch_is_current`, `uncovered_loss_remains_with_open_risk` (pure), `effective_abs_quantity_for_leg`, `kernel_clear_leg` and `set_asset_state`: no bucket expiry and no settlement. Their Stale is their own (a leg whose K/F/B snapshots are not current: 18536, 18539). Every caller of `expire_source_backing_bucket_not_atomic` checks the raw status Fresh and the effective expiry against the slot first, and the delta reads the same effective expiry, so its Stale is not reached from them either. **Ported** (trade.ts `clearLegOrStale`): `clear_leg_at_slot_inner` returns its two Stale refusals as false with `staleAsValue`, after the liquidation lock and the certificate's invalidation it may have written, as the original. |
| 4 | src/v16_program.rs `canonical_accrual_path_for_target_view` (15830; `let mut simulated_profile = *profile` at 15874) and `zero_move_funding_path_for_profile_view` (16021; at 16042) | Not an error: the copy is a simulation that is never written back (`advance_funding_mark_checkpoint_view` runs on it per step), and in the second the error of the simulation is remapped with `.map_err(|_| V16Error::InvalidConfig)` | The port must keep these two as real copies (a local AssetOracleProfile, 424 bytes: within a 4 KiB frame but not a list local), never a view. Both also allocate (`Vec::with_capacity(step_count)`), see section 3. |
| 5 | src/v16_program.rs `live_domain_withdraw_health_or_shutdown_view` (6122; `.is_ok()` at 6128) | The error of `shutdown_asset_empty_and_matured_now_view` becomes `false` | Read-only (views taken by `&`): nothing to keep. |
| 6 | src/v16.rs `liquidation_partial_close_is_healthy` (432; at 458) | `NonProgress` from a projection becomes `Ok(false)` | Pure (values only): nothing to keep. |
| 7 | src/v16.rs `account_has_active_source_claim_exposure` (17900; `.is_ok()` at 17912) and `settle_account_for_position_action_and_refresh_not_atomic` (19630; `.is_ok()` at 19639) | Errors of read-only checks become booleans | Read-only: nothing to keep. |
| 8 | src/v16.rs `permissionless_crank_not_atomic` (16562; Liquidate's `kernel_commit_declared_liquidation_recovery` at 16640) and `permissionless_auto_crank_not_atomic` (AdvanceClose, 17346) | an error of `liquidate_account_not_atomic` or `advance_pending_close_residual_not_atomic` becomes `RecoveryDeclared` (a success) when it is RecoveryRequired and the market is now in Recovery with a reason: every path that declares Recovery (`declare_permissionless_recovery`) returns RecoveryRequired right after | **Ported** (liquidation.ts `DECLARED`, `commitDeclared`): the seven declaring sites return DECLARED, each caller passes it up at once, and the kernel's decision (the mode and the reason decoded, then the test) is made where the original makes it; every write before stays. Other errors fail in place (the kernel returns them unchanged, after decoding the mode and the reason, which the port also decodes before a swallowed NonProgress). |

The remaining `Err(_) => true` arms of src/v16.rs (about 50, e.g. lines 130, 1240, 1473, …, 18161) are in pure
predicates over values (overflow of a computed sum read as "out of bounds"); they change no state. `unwrap_or` in the
program reads the Clock with a fallback (`Clock::get().map(|c| c.slot).unwrap_or(…)`, 5986, 7855, 14193) or saturates
a conversion; no state.

By-value copies whose errors propagate (equivalent in place, listed so that nobody "fixes" them into copies):
`activate_dynamic_asset_slot` (src/v16_program.rs 2049: the 726-byte group header and the 1,333-byte engine slot,
written back after two `?`s), the wrapper-config read/modify/`write_wrapper_config` sequences of the policy handlers,
`read_asset_oracle_profile` / `write_asset_oracle_profile` and the control-sequence pairs (about 47 `let mut x = read_…`
/ `*…` sites in the processor). Each validates the value it writes (`validate_wrapper_config`,
`validate_asset_oracle_profile`) before writing: in place, the port validates after changing the view, before
anything else can read it.

`write_wrapper_config_to_bytes` keeps the byte at `MAINTENANCE_FEE_SPLIT_CARRY_OFF` (197, `_padding0`) as it is in the
account, whatever the copy holds: a handler that writes back an earlier config copy must not roll the carry back. In
place, the carry byte is simply never written by those handlers.

## 2. Decode: what allocates

`Instruction::decode` (src/v16_program.rs 3691) allocates for three tags, after reading the count and refusing a count
above 16, before reading the elements (so a body whose count is at most 16 but whose data is short still allocates,
then is refused):

| Tag | Instruction | Allocation | At most (16 elements) |
| ---: | --- | --- | ---: |
| 5 | PermissionlessCrank | `Vec<CrankObservationHint>::with_capacity(count)`: `{ u16, u8 }`, 4 bytes, align 2 | 64 bytes |
| 66 | BatchTradeNoCpi | `Vec<BatchTradeLeg>::with_capacity(count)`: `{ u16, u64, i128, u64, u64 }`, 48 bytes (42 rounded up to align 8) | 768 bytes |
| 67 | BatchTradeCpi | `Vec<BatchTradeCpiLeg>::with_capacity(count)`: the same shape, 48 bytes | 768 bytes |

A count of 0 allocates nothing. The element sizes are Rust's layout of those structs on SBF, derived from their field
types, not measured. Every other tag allocates nothing in decode. Pinocchio's bump allocator puts these after the
account shim's lists (about 21 KiB at 255 accounts, of which 61 distinct: TESTING.md section 4), so even on the
runtime's default 32 KiB frame decode cannot exhaust the heap; the handlers' own allocations (CPI metas and data, the
batch matcher's return, `read_asset_effective_prices`' two `Vec<u64>`, the accrual paths' `steps`) are counted per
handler where it is ported. The port allocates nothing in decode (section 18 lists where it does allocate).

Decode does not judge enum, bool or flag bytes (UpdateAssetLifecycle `action`, UpdateAssetAuthority `kind`,
FinalizeResetSide `side`, SetMatcherConfig `enabled`, ConfigureHybridOracle `invert`, `oracle_leg_count`,
`oracle_leg_flags`), and accepts a vector count of 0: each handler refuses those (`decode_side` in the processor gives
InvalidInstruction for a side above 1; `set_enabled` the same for `enabled` above 1).

## 3. Engine checks of the set-up instructions

Ported in engine.ts with the set-up, policy and ledger instructions:

- `validate_exact_solvency_envelope` (with `validate_funding_headroom`, the interval bisection of
  `validate_solvency_envelope_range` and its 4,096-step and 96-interval limits). Its U256 products all fit 256 bits,
  so TypeSOL's u256 gives the same values with no need of the v12.20 port's `wide.ts` (not imported); the narrowing
  checks (`try_into_u128`) are kept. The bisection stack keeps only each pending interval's low end: the `hi` of every
  entry is the `lo` of the entry below it minus one (engine.ts says why), the same intervals in the same order.
  `configFullErr` is `V16ConfigAccount::try_to_runtime` (shape, then envelope), returned as a value because its callers
  map it differently (`map_account_wire_error` in `mod state`, `map_v16_error` in the processor).
- `validate_source_credit_state_static` (`sourceCreditErr`, with the expected credit rate).
- `validate_active_leg` inside the leg decoding (`legErr`), so `PortfolioLegV16Account::try_to_runtime` is whole.
- `PortfolioV16View::validate_with_market`, `MarketGroupV16View::validate_shape` (the `audit-scan` feature that would
  add the full slot scan is off in the program's build), `compact_source_domains` (it runs on every mutable portfolio
  view: `program.ts` `portfolioViewMut`), `register_` / `deregister_empty_materialized_portfolio_not_atomic`,
  `deposit_not_atomic`, `domain_insurance_budget_remaining`.

Site 1 of section 1 (`deregister_empty_materialized_portfolio_not_atomic` under SyncMaintenanceFee): it writes nothing
before it returns LockActive (the count changes only after `is_empty_for_dematerialization`), so the port's
`deregisterEmptyPortfolio` returns V16_LOCK_ACTIVE as a value and fails in place on every other error (the program
maps every other error with `map_v16_error` there too); ClosePortfolio passes the value to `checkV16`.

The maintenance fee and the withdrawal of a portfolio without open legs are ported with SyncMaintenanceFee and
Withdraw (section 9). Ported later, each with its instruction (sections 9 to 16): `read_asset_effective_prices`
(BatchTradeCpi's, which reads stored effective prices, no oracle account), `bump_matcher_req_seq`,
`market_view_mut_with_fee_carry`, the insurance domains' withdrawals and credits, the settlement of open legs and every
engine path of trades, cranks, margin and resolution. The insurance domains' deposit (`deposit_domain_insurance_not_atomic`) is
ported with the permissionless activation's fee (section 7).

## 4. Errors at individual sites

`map_v16_error` is `failV16` / `checkV16` (errors.ts). The processor maps some engine errors itself; the ones met while
reading so far: `map_account_wire_error` in `mod state` (every V16Error → InvalidAccountData), `.map_err(|_|
V16Error::InvalidConfig)` in `zero_move_funding_path_for_profile_view`, `ok_or(PercolatorError::…)` on checked
arithmetic throughout. Each handler ports its own where it is ported.

## 5. Views and TypeSOL's own checks

`loadRawAt` / `loadRawMutAt` check the owner (3007), the size (AccountDataTooSmall) and, for a mutable view,
writability (3006). The original's accessors check only lengths (`data.get(range).ok_or(InvalidAccountLen)`); owners
and writability are the handlers' (`expect_writable`, the owner checks before any read). Every accessor in state.ts
makes the original's length check first, so TypeSOL's size check never fires; each handler must make the original's
owner and writable checks before it takes a view, as the v12.20 port does.

## 6. The set-up and policy handlers

- **Validation the original repeats.** `register_empty_materialized_portfolio_not_atomic` and `deposit_not_atomic`
  call `validate_with_market` again right after the handler did; `validate_source_credit_shape_with_market` repeats
  five checks of `SourceCreditLienAggregateProofV16::validate` on the same values; `validate_with_market` calls
  `validate_active_leg` again on a leg `try_to_runtime` validated. The port keeps every first check and drops the
  repeats that cannot fail (each site says so); the repeated `validate_with_market` calls are kept (they run on the
  state the handler may have changed in between).
- **Write-backs that validate.** `write_wrapper_config` and `write_oracle_profile_to_view` validate the value they
  write. In place, the port validates again only where a changed field is validated (UpdateBackingFeePolicy's policy
  count against the config's own fees can fail for an asset other than 0); everywhere else only fields the validation
  does not look at, or values already held to the same bounds, change.
- **Lazy accounts.** UpdateBaseUnitMints takes the old vaults (positions 4 and 5) only when a mint changes, after
  every other check: NotEnoughAccountKeys comes that late in both.
- **Token programs.** The original accepts SPL Token only (`spl_token::ID`, executable): a Token-2022 mint, token
  account or token program is refused (InvalidMint, InvalidTokenAccount, InvalidTokenProgram), so no extension or
  transfer fee is ever met. Vaults are pinned to the vault PDA's associated token account of the mint (derived with
  SPL Token's id), as the original's F-VAULT-FRAG check does.
- **Compute.** `resizeAccount` zeroes the bytes it adds with the memset syscall from 64 bytes, as the reference's
  realloc does (a compiler change of its own, which also changed other programs' binaries: CHANGELOG). Before it,
  stores cost about 3,000 CU more for 9,563 bytes and 13 refusals after a reallocation cost the port more than the
  reference; none does now (README).

## 7. The managed marks, the matcher config and the asset lifecycle

- **Copies written back.** The managed marks, RestartAssetOracle and UpdateAssetLifecycle read the asset's oracle
  profile and the wrapper config into copies, change them (the funding-mark checkpoint and transition, the frozen
  marks of a shutdown) and write them back after validating them; nothing between reads the profile's or config's
  bytes from the account (the engine calls in between read the asset slot and the group header only), so the port
  changes them in place and validates the view where the original validates the copy. No error is swallowed on these
  paths. `activate_dynamic_asset_slot` copies the 726-byte group header and the 1,333-byte slot, grows the capacity and
  activates the slot on the copies, and writes both back; each refusal fails the transaction (every engine error there
  is `map_account_wire_error`, InvalidAccountData), so it runs in place.
- **Errors as values.** `grow_asset_slot_capacity_not_atomic` and `activate_empty_market_slot_not_atomic` return their
  V16Error as a value (lifecycle.ts): the append path maps it to InvalidAccountData, the reuse path with
  `map_v16_error`. Both make every check before their first write.
- **`set_asset_state`.** It recomputes the slot's resolved-payout blockers before and after and moves the market's
  total by the difference (CounterOverflow on the old sum, the new sum, or the total). The port changes the asset in
  place between `blockersBefore` and `blockersAfter` (engine.ts); where the original restores the old asset after a
  failed new sum, the failed transaction does the same.
- **Arithmetic.** The original's `checked_*` errors are V16Errors; TypeSOL's checked operators fail with 5100. Every
  sum and product of the accrual (accrual.ts) that can leave its type is tested before it is formed, in u256 where the
  factors are wide; the funding numerator (rate · dt · price) cannot overflow (the rate is held to the config's
  maximum, at most 10,000).
- **The permissionless activation's fee** goes into market 0's insurance (`deposit_market_zero_insurance_view`: ⌊fee /
  2⌋ into asset 0's long domain, the rest into its short one, each through `deposit_domain_insurance_not_atomic`: the
  vault, the insurance and the domain budget raised, the market's remaining-budget total raised and held to the
  insurance, the token-flow proof, `validate_source_domain_ledger`, the shape), after a second `market_view_mut`, then
  the SPL Token Transfer from the signer's account. The token-flow proof (`external_in_to_insurance_capital`) credits
  and debits the same amount and its vault delta is the amount, so its validation cannot fail and is not repeated.
- **A lapsed Fresh bucket at retirement.** `expire_lapsed_source_backing_for_asset_not_atomic` expires, per side, a
  Fresh bucket whose expiry slot has passed (`expire_source_backing_bucket_not_atomic`, primitives.ts: the unliened
  backing leaves the source's reserve, a valid lien becomes impaired, the provider principal is released, the credit
  rate recomputed, the encumbrance proof and the market's shape checked, and with a captured payout snapshot the
  residual it frees credited to the resolved-payout ledger), then reads the bucket again for the normalisation. The
  placeholder that stood there is gone. Only TopUpBackingBucket (not ported) makes a Fresh bucket, so the path is
  compared with the reference binary on buckets written into the market in both VMs (percolator-v16-lifecycle.test.ts:
  300 generated states, 139 retirements succeeding in both, the rest refused alike: an impaired lien left on the asset
  (EngineLockActive), totals one off (EngineCounterUnderflow), a source state refused (EngineInvalidConfig)).
- **Repeated accounts.** None of these handlers holds two borrows at once (SetMatcherConfig borrows the portfolio, the
  market and the context's length one at a time; the others borrow the market alone, in sequence), so no repeated
  pair reaches a borrow conflict; the account sweeps confirm it.

## 8. The external oracles and ConfigureHybridOracle

- **Where an external price is read.** In the original, `oracle_v16::read_external_price_e6_profile` has two callers:
  ConfigureHybridOracle (tag 34) and the crank's `hybrid_target_for_crank_view` (PermissionlessCrank, ported since: below).
  `read_external_price_e6` (the config's variant) has none in the program. No other ported instruction reads an oracle
  account: activations, the restart and the shutdown take a price argument or the asset's frozen effective price, the
  pushes a mark argument; trades read stored targets only (`read_asset_effective_prices` reads effective prices).
- **Errors as values.** The crank matches on the reader's error (OracleStale and NotEnoughAccountKeys fall back to the
  EWMA mark once the soft-stale window has matured), so external.ts returns its error as a code (`R_*`) and
  ConfigureHybridOracle fails with it (`failOracle`). The reader writes nothing before an error: each leg is read and
  checked, the composite formed, then `commit_observed_oracle_legs` checks every leg before it stores any.
- **Branches only the crank reaches.** ConfigureHybridOracle builds a fresh profile, so its legs never hold an
  observation. With the crank ported (crank.ts `hybridTarget`), these are now compared with the reference binary:
  `commit_observed_oracle_legs`' refusals (an older publish time: OracleStale; the same publish time with another
  price: OracleInvalid, which a keeper meets whenever the Clock's unix time has not moved since the last read), a read
  that advances only some legs and one that advances none (the liveness slot kept), the fall-back to the EWMA mark on
  OracleStale once the soft-stale window has matured (and the refusal before it), the EWMA, AuthMark and Manual
  targets, and the market's stale window (EngineRecoveryRequired) (percolator-v16-crank.test.ts, the walk). Still only
  on host vectors, because the crank cannot reach them: the reader on a Manual or managed profile (the crank calls it
  for a hybrid profile only), a stored leg configuration that is invalid (`validate_asset_oracle_profile` refuses it
  first) and an account list shorter than the legs (the crank requires exactly the leg count, InvalidInstruction, and
  NotEnoughAccountKeys before the reader); the crank's own NotEnoughAccountKeys fall-back is therefore unreachable too.
- **Pyth's Borsh.** The original deserializes pythnet-sdk 2.3.1's PriceFeedMessage (84 bytes) from byte 41 after
  checking the length (134), so the deserialization cannot fail; the port reads the five fields it uses at their Borsh
  offsets. The v12.20 port's reader (showcase/mainnet/percolator/oracle.ts) is not reused: v16 checks the
  discriminator, orders the feed and exponent checks differently, bounds the scaled price by MAX_ORACLE_PRICE
  (OracleInvalid) instead of u64, compares the confidence in 256 bits and adds Switchboard, the composites and the
  publish-time coherence; nothing in it is the same function.
- **Repeated accounts.** The market's data is held while the legs are borrowed: the market as a leg fails with
  AccountBorrowFailed (the port compares the keys first in `readOraclePrice`); the admin as a leg is read (it is
  system-owned: IllegalOwner); one account for two legs is read twice (two feeds cannot both match it).
- **The copy.** ConfigureHybridOracle builds the new profile as a local and reads the legs into it before anything is
  written back; nothing in between reads the profile's bytes from the account, so the port builds it in place (as
  ConfigureEwmaMark does) and every failure after that fails the transaction.
- **The hybrid mode in the ported paths.** A hybrid asset is price-managed: a shutdown accrues its committed funding as
  for EWMA and AuthMark (`permissionless_funding_rate_e9_view`, accrual.ts), which the lifecycle fuzz compares with
  assets configured through ConfigureHybridOracle. The soft-stale window decides the crank's target and whether the
  canonical accrual path moves the hybrid funding mark with the price (`update_fresh_hybrid_mark`), both crank code.
- **Accrual's price move.** No ported instruction accrues at a new price: ConfigureHybridOracle resets an empty
  asset's anchor to the read price directly (`reset_empty_asset_oracle_anchor_view`), and the shutdown accrues at the
  frozen effective price. The crank now accrues at moving prices (section 13): the price-move branch is compared with
  the reference binary through it.

## 9. The maintenance fee and Withdraw

- **The settlement of open legs.** `sync_account_fee_to_slot_not_atomic` (the engine's fee sync, under
  SyncMaintenanceFee and under Withdraw's `collect_maintenance_fee_before_value_debit_view`) settles the portfolio's
  open legs first (`settle_account_side_effects_not_atomic`, with the config's public B chunk as the loss budget) only
  on a Live market, only for a portfolio with a bit in its active bitmap, and only when the fee anchor
  (`account_fee_anchor_for_loss_currentness`: the earliest `slot_last` of its exposed assets, or the slot) has passed
  the portfolio's fee slot; a zero fee rate does not skip it. A settlement that stops at a B chunk
  (`PermissionlessProgressOutcomeV16::AccountBChunk`) is BStale there (21202); the port's driver returns that outcome as
  a value (settlement.ts `BSettlement.current`) and refresh.ts fails with BStale on it. The placeholders that stood
  there (the placeholder for tags 48 and 4) are gone. Withdraw with an open leg is then refused by
  `withdraw_not_atomic` (EngineStale) whatever the settlement did: only a flat portfolio withdraws.
- **What the settlement does.** It reconciles impaired counterparty liens, settles each leg's K and F deltas (a plan
  sorted by phase, source domain and slot; the haircut-bounded close loss, the source-claim burns, the loss-support
  booking, the capital-backed loss reservation, the funding flows, the stale K/F cohorts), then each leg's B index one
  chunk at a time, and books what remains against principal. The 275 functions and 6,397 lines it reaches are mapped
  in section 10; all are ported (claims.ts, kfsettle.ts, settlement.ts for layers 4 to 7).
- **Errors.** Every engine error on these paths goes through `map_v16_error` and fails the transaction, except
  `deregister_…`'s LockActive under SyncMaintenanceFee (site 1). No by-value copy is made: the original's engine works
  on views; the wrapper config (`cfg`, `cfg_pre`) is a copy only read, and the fee carry is a byte written in place
  (`MaintenanceFeeSplitCarry`) in both.
- **Checks that cannot fail, not repeated.** `kernel_settle_principal`'s conversion of the amount paid to i128 (the
  amount is at most |pnl| ≤ i128::MAX), `set_account_pnl_after_principal_settlement`'s shape check (the new PnL lies
  between the old and zero), the token-value proofs (each moves one amount between two classes with the vault
  unchanged, or out to the outside with the vault lowered by it: Withdraw's is argued in section 17), `charged.checked_sub(reward)` (the share is at most
  10,000 bps), `account_equity_from_parts`' repeated `validate_non_min_i128` and `validate_fee_credits`. The repeated
  `validate_shape` and `validate_with_market` calls the handlers make after the engine's own are kept.
- **Repeated accounts.** SyncMaintenanceFee holds the market while it borrows the portfolio and the cranker; Withdraw
  holds the market while it borrows the portfolio. A portfolio or cranker that is the market is first given the
  portfolio's length (`ensure_portfolio_storage_for_market_slots`: a longer market InvalidAccountLen, a shorter one
  reallocated, after which the market view refuses it), so no borrow conflict is reachable; the account sweep and the
  tests compare these.
- **Generated states.** No ported instruction can open a leg or make PnL, so these paths are compared on states written
  into the accounts (showcase/test/percolator-v16-states.ts): the original's own validators decide whether a state is
  acceptable, and the reference's refusal of one is compared like any other. The states with open legs carry the
  assets' K, F and B indices a step from the legs' snapshots, stale K/F cohorts with their counts, ledgers for the
  market's four domains (Fresh, Expired, Impaired and Empty buckets, reservations, the source credit states) and, for
  both portfolios, claims and counterparty and insurance liens on those buckets, with the market's totals, money and
  positive-PnL totals made to hold them (`generate(…, open)`, `writeDomains`).


## 10. The settlement of open legs: the map

`settle_account_side_effects_not_atomic` (src/v16.rs 15982) is what SyncMaintenanceFee and Withdraw stop at (section 9),
and liquidation, the crank, trades and conversions reach it too (its callers: 19589, 20522, 20875, 21203, 21826). The
reference binary runs it only as a whole. This section maps every function it reaches, layer by layer from the bottom:
all are ported, and SyncMaintenanceFee and Withdraw run it, so it is compared with the reference binary through them
(TESTING.md, "The settlement of open legs against the reference binary"), besides function by function on host
vectors.

**How the map is made.** `scripts/percolator-v16-reference/settlement-map.py` reads the pinned src/v16.rs and follows
the calls (it prints the tables below; keep its `NOW` list current and paste its output here). It blanks comments and
the items the program's build leaves out (cfg(test), cfg(kani), the fuzz and audit-scan features: the audit scan
validators are `Ok(())` in the program), gives each function the type of the `impl` around it, and resolves `self.f(`,
`Self::f(` and `Type::f(` to that type's `f`, a bare call to the free function, and `x.f(` through the type the field
`x` has in the struct definitions. Eight method names stay ambiguous on receivers the field table does not type
(`as_view`, `get`, `is_empty`, `is_empty_amount_shape`, `source_domain_slot`, `validate`, `validate_shape`,
`validate_with_market`); each resolves to every candidate (small accessors and validators, most ported before), so the
closure is exact up to those few over-counted rows. The name-based closure of the scope report (about 5,600 lines in
220 functions) differs both ways: it merged same-named functions and missed calls through `Self::`, a type path or a
field. **275 functions and 6,397 lines** (each function's lines from `fn` to its closing brace, comments inside
included), no recursion. The wide_math helpers it uses are not in the count: `wide_mul_div_floor_u128`,
`checked_mul_div_ceil_u256`, `floor_div_signed_conservative_i128`, `mul_div_floor_u256_with_rem`,
`wide_signed_mul_div_floor_from_k_pair` and U256's checked operations.

**The layers are the source's own order, not the obvious one.** The source-claim burns call the impaired-lien
reconciliation (`burn_account_source_claim_at_slot_up_to` → `reconcile_account_impaired_counterparty_lien_at_slot_not_atomic`),
the PnL setters call the burns (`set_account_pnl_inner` → `burn_account_source_claim_bound_num`), the K/F loss
support calls the PnL setters (`settle_kf_loss_before_support_not_atomic` → `set_account_pnl_after_source_claim_burn`),
and a B chunk sets the PnL through a domain-first burn (`settle_account_b_chunk` →
`set_account_pnl_after_domain_first_source_claim_burn`). So the bottom-up order is: leaf arithmetic and accessors →
backing and lien primitives → impaired-lien reconciliation → source-claim burns and the PnL setters → K/F settlement
entries → B chunks → the driver (`settle_account_kf_effects_not_atomic`, which reconciles the liens first, then
settles the K/F plan, and `settle_account_side_effects_not_atomic`). Each layer calls only its own and lower layers
(the script checks it and raises a function that would break it; none needs raising).

**Status.** *before*: ported with an earlier instruction (the closures of `validate_with_market`, `validate_shape`,
`settle_negative_pnl_from_principal_core_not_atomic`, `set_asset_state`, `compact_source_domains`,
`validate_source_domain_ledger` and the accessors they use; some exist in the port only inside those functions and
need a standalone form when a later layer calls them). *kernels*: ported in kernels.ts (the value kernels of the leaf
layer) and compared with the original's own function compiled for the host on struct vectors (TESTING.md, "The
settlement's engine functions"). *primitives*: ported in primitives.ts (the remaining leaf accessors and layer 2) and
impairment.ts (layer 3). *settlement*: ported in claims.ts (layer 4), kfsettle.ts (layer 5) and settlement.ts (layers
6 and 7). Both are compared with the original's own function compiled for the host on whole generated markets and
portfolios (TESTING.md, "The backing and lien primitives") and, as the settlement SyncMaintenanceFee and Withdraw run,
with the reference binary (`expire_source_backing_bucket_not_atomic` also through UpdateAssetLifecycle's retirement,
section 7). *in place*: the
conversions between account bytes and runtime values (`from_runtime`, `encode_*`, `as_view`, the slot accessors, the
Pod `new` / `get`), which the port, working on the bytes, has no code for, and `validate_account_audit_scan`, which the
program's build compiles to `Ok(())` (the audit-scan feature is off). *remaining*: not ported. **Also**: the function
is reached as well from margin and health (M, `compute_account_health_cert_with_price_override`), trades (T,
`execute_trade_with_fee_loss_stale_scoped_not_atomic`), the crank (C, `permissionless_auto_crank_not_atomic`) or
liquidation (L, `liquidate_account_not_atomic`) without going through the driver; port it once, for all of them.

Lines and functions per layer (functions / lines; output of settlement-map.py):

| Layer | | Functions | Lines | Ported before | kernels.ts | primitives.ts, impairment.ts | claims.ts, kfsettle.ts, settlement.ts | In place (no code) | Remaining |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Leaf arithmetic, accessors and validation | 185 | 3061 | 99 / 1472 | 45 / 1134 | 32 / 353 | 0 / 0 | 9 / 102 | 0 / 0 |
| 2 | Backing and lien primitives | 47 | 1140 | 7 / 310 | 0 / 0 | 40 / 830 | 0 / 0 | 0 / 0 | 0 / 0 |
| 3 | Impaired-lien reconciliation | 8 | 257 | 0 / 0 | 0 / 0 | 8 / 257 | 0 / 0 | 0 / 0 | 0 / 0 |
| 4 | Source-claim burns and the PnL setters | 14 | 783 | 0 / 0 | 0 / 0 | 0 / 0 | 14 / 783 | 0 / 0 | 0 / 0 |
| 5 | K/F settlement entries | 13 | 960 | 0 / 0 | 0 / 0 | 0 / 0 | 13 / 960 | 0 / 0 | 0 / 0 |
| 6 | B chunks | 6 | 109 | 0 / 0 | 0 / 0 | 0 / 0 | 6 / 109 | 0 / 0 | 0 / 0 |
| 7 | The side-effects driver | 2 | 87 | 0 / 0 | 0 / 0 | 0 / 0 | 2 / 87 | 0 / 0 | 0 / 0 |
| | Total | 275 | 6397 | 106 / 1782 | 45 / 1134 | 80 / 1440 | 35 / 1939 | 9 / 102 | 0 / 0 |

**The kernels and their copies.** The original takes the kernels' structs by value and its callers write the result
back after `?`; kernels.ts changes the caller's place (`Inout<…>`). No caller of any of them swallows its error (each
direct caller propagates it; the only swallow site that reaches some of them, `permissionless_auto_crank_not_atomic`
matching `clear_leg`'s Stale, matches Stale only, which of the kernels only `prepare_counterparty_backing_expiry_delta`
returns, through `expire_source_backing_bucket_not_atomic`; it cannot reach `clear_leg`: section 1, site 3), so failing in place is
the same bytes.

**Copies and swallowed errors, function by function.** The original's layer-2 and layer-3 functions read a domain's
source credit state, bucket and reservation into values, change them with a delta kernel and write them back
(`set_source_credit_for_domain`, `set_backing_bucket_for_domain`, `set_insurance_reservation_for_domain`); a portfolio
source domain is copied out (`account.header.source_domains[slot]`), changed and written back. All of it happens on
views of the account data (`MarketGroupV16ViewMut`, `PortfolioV16ViewMut`), so a write the original makes before an
error persists in the view in both. The port changes the slots in place (primitives.ts, impairment.ts) and keeps of
the old value only what a setter needs (the three amounts the market's source totals follow, a bucket's earnings). That
is the same bytes when every caller propagates the error. Each `_not_atomic` function's callers, read one by one in
src/v16.rs:

| Function | Callers (line) | Finding |
| --- | --- | --- |
| `expire_source_backing_bucket_not_atomic` | 10336, 10475, 13038, 14857, 15312, 16689, 17375, 21657, 21700, 22175 | every one `?`; none on a copy |
| `credit_post_snapshot_residual_not_atomic` | 10156, 14724 | `?` |
| `release_source_credit_lien_from_counterparty_terminal_not_atomic` | 10480 (returned as the match's value), 11300 | propagated |
| `consume_source_credit_lien_from_counterparty_core_not_atomic` | 10557, 11430 | `?` |
| `release_source_credit_lien_from_insurance_core_not_atomic` | 10748, 11452, 20961 | `?` |
| `release_source_credit_lien_from_insurance_terminal_not_atomic` | 11306, 11447, 11708 | `?` |
| `create_and_consume_source_credit_from_counterparty_core_not_atomic` | 12720 | `?` |
| `create_and_consume_source_credit_from_counterparty_parts_not_atomic` | 12582, 13188, 14264 | `?`; the parts each caller passes are the domain's stored state read just before (`backing_bucket_for_domain`, `source_credit_for_domain[_shape]`, `insurance_reservation_for_domain`), so in place they are the slot (13188 and 14264 to be rechecked where layers 4 and 5 are ported) |
| `create_and_consume_source_credit_from_insurance_core_not_atomic` | 12726 | `?` |
| `create_and_consume_source_credit_from_insurance_parts_not_atomic` | 12635, 13200 | `?`; parts as for the counterparty's |
| `collect_account_backing_utilization_fee_for_domain_not_atomic` | 11398, 13371, 15321, 15763, 20931, 21639 | `?`; its early returns keep the cursor and slot writes, in both |
| `retire_source_credit_lien_from_counterparty_impaired_not_atomic` | 10483 (the match's value), 15322, 20932, 21642 | propagated |
| `release_or_retire_counterparty_lien_backing_not_atomic` | 11440 | `?` |
| `reconcile_account_impaired_counterparty_liens_not_atomic` | 15343 | `?` |
| `reconcile_account_impaired_counterparty_lien_at_slot_not_atomic` | 11676, 15261 | `?` |

The non-`_not_atomic` setters and preparers they use (`set_*_for_domain`, `recompute_*`, `refresh_*`,
`add_fresh_counterparty_backing*`, `impair_account_source_credit_counterparty_lien_fields`,
`burn_impaired_account_source_claim_fields`, `prepare_account_counterparty_lien_impairment`,
`prepare_counterparty_impaired_lien_retirement_delta`) are called with `?` at every site too. The swallow sites of
section 1 reach these only through higher layers: site 3 (`permissionless_auto_crank_not_atomic` matching `clear_leg`'s
Stale) is crank code; `clear_leg` reaches neither `validate_source_domain_ledger_current` nor the expiry delta (section
1, site 3), so the port's functions failing in place need no value-returning variant for it.

**A bucket's effective expiry.** `backing_bucket_for_domain` replaces a Resolved market's bucket expiry by
`min(expiry, resolved_slot + horizon)`, and `set_backing_bucket_for_domain` writes the bucket it was given back, so
every path that reads a bucket this way and then sets it persists the effective expiry. The port writes it into the slot
at the point the original's copy takes it, only on paths where the bucket is then certain to be written (or the call
to fail): the deposits, the expiry, the counterparty lien's release, consumption, create-and-consume and retirement,
and the fee collection's charge; never on the paths that only read the bucket (the insurance liens' proofs, the fee
collection's early returns).

**Layers 4 to 7: copies and swallowed errors.** Every caller of every function of these layers, read one by one in
src/v16.rs, propagates its error (`?`, or the call is the function's tail value: 14181, 14570, 15354); the
driver's outcome is a value, which `sync_account_fee_to_slot_not_atomic` turns into BStale (21202). So the port
fails in place throughout. The copies: `burn_account_source_lien_face_not_atomic` snapshots the slot
(`source_before`) before calls that change only the market, `burn_account_source_claim_bound_num` and
`consume_validated_account_source_credit_not_atomic` read a slot per turn, `apply_account_kf_settlement_entry`
reads the leg and the asset at its start and writes both back at its end (`from_runtime`, `set_asset_state`),
`mark_leg_b_stale` and `settle_account_b_chunk` read a leg, change it and write it back; nothing in between writes
what was copied (the PnL paths never write a leg or an asset state; the only `set_asset_state` in the closure,
`begin_full_drain_reset_inner`, runs in the preparation, before the asset is read for the application), so the port
changes them in place. `set_asset_state` counts the stored asset's resolved-payout blockers before it writes; the port
takes that count before its in-place change and fails with its CounterOverflow after the kernel's own refusals, in the
original's order (kfsettle.ts).

**The parts callers, rechecked.** `create_and_consume_source_credit_from_counterparty_parts_not_atomic` at 13188 and
`create_and_consume_source_credit_from_insurance_parts_not_atomic` at 13200
(`consume_validated_account_source_credit_not_atomic`) get the domain's `source_credit_for_domain_shape`,
`backing_bucket_for_domain` and `insurance_reservation_for_domain` read at the top of the slot's turn; in between
only `domain_asset_side`, `validate_source_domain_ledger_parts` and the rate's arithmetic run, which read. At 14264
(`net_slot_face_at_par_not_atomic`) the bucket and `source_credit_for_domain` are read at the function's start and the
reservation as the call's argument; in between, `domain_asset_side`, `has_pending_domain_loss_barrier` and
`twin_loser_paid_share_num` (which reads `loser_paid_backing_num`) only read. In place, all three are the slots, as
NOTES assumed; the bucket the original passes carries the effective expiry, which the port passes as the expiry to
write (`createAndConsumeCounterpartyParts(…, effective, …)`).

**Arithmetic the original leaves unchecked.** `net_slot_face_at_par_not_atomic` and
`cancel_loss_domain_face_at_par_not_atomic` add to the batch with plain `+=`/`-=` (wrapping in the program's build),
`settle_kf_loss_before_support_not_atomic` subtracts the capital paid with `-=`, `pay_kf_loss_from_free_capital`
counts payments with `+= 1`, `insert_account_kf_settlement_plan_entry` counts entries. Each is bounded by the
values it is formed from (a netting at most the loss and face left and the slot's unliened claim; a payment at most
the loss; at most 16 entries), so none wraps; the port's operators are checked (TypeSOL) and cannot fire there either.

#### Layer 1: Leaf arithmetic, accessors and validation

| Function | Lines | Status | Also | Callers in the closure | Callees in the closure |
| --- | --- | --- | --- | --- | --- |
| `apply_backing_utilization_fee_charge` | 95–124 (30) | kernels | TCL | collect_account_backing_utilization_fee_for_domain_not_atomic | – |
| `v16_domain_count_for_market_slots` | 171–175 (5) | before | MTCL | configured_domain_count, validate_source_credit_shape_with_market | – |
| `active_bitmap_get` | 263–270 (8) | before | TCL | active_leg_slot_for_asset, settle_account_kf_effects_not_atomic, validate_with_market | – |
| `unattributed_loss_lock_after_pnl` | 337–343 (7) | before | TCL | sync_unattributed_loss_lock | active_bitmap_count_ones |
| `active_bitmap_count_ones` | 674–682 (9) | before | TCL | settle_account_kf_effects_not_atomic, unattributed_loss_lock_after_pnl | – |
| `V16Core::amount_from_bound_num` | 723–731 (9) | before | TCL | book_realized_kf_loss_for_source_domain_not_atomic, burn_impaired_account_source_claim_fields, consume_source_domain_credit_for_effective_not_atomic, … | – |
| `V16Core::bound_num_from_amount` | 734–738 (5) | before | MTCL | burn_account_source_claim_at_slot_up_to, cancel_loss_domain_face_at_par_not_atomic, kf_loss_lien_backing_to_consume_num, net_slot_face_at_par_not_atomic, … | – |
| `V16Core::mul_div_floor_u128_or_wide` | 741–753 (13) | kernels | MTCL | source_credit_state_realizable_support_for_claim_num, source_domain_prospective_support_for_face | – |
| `V16Core::mul_div_ceil_u128_or_wide` | 756–773 (18) | kernels | MTCL | source_credit_lien_amounts_for_effective | – |
| `V16Core::source_credit_lien_amounts_for_effective` | 776–796 (21) | kernels | TCL | consume_source_domain_credit_for_effective_not_atomic, consume_validated_account_source_credit_not_atomic | bound_num_from_amount, mul_div_ceil_u128_or_wide |
| `V16Core::source_lien_backing_release_for_face_burn` | 799–817 (19) | kernels | TCL | source_lien_face_burn_plan | amount_from_bound_num, bound_num_from_amount |
| `V16Core::source_lien_fee_after_backing_release` | 819–841 (23) | kernels | TCL | burn_account_source_lien_face_not_atomic | – |
| `V16Core::source_lien_face_burn_partition` | 845–861 (17) | kernels | TCL | source_lien_face_burn_plan | – |
| `V16Core::source_lien_face_burn_plan` | 865–897 (33) | kernels | TCL | burn_account_source_lien_face_not_atomic | source_lien_backing_release_for_face_burn, source_lien_face_burn_partition |
| `V16Core::crystallize_source_lien_fee_for_effective` | 899–928 (30) | kernels | TCL | prepare_account_counterparty_lien_impairment | get, new |
| `V16Core::validate_bound_num_atom_aligned` | 1040–1048 (9) | before | MTCL | prepare_counterparty_impaired_lien_retirement_delta, prepare_insurance_lien_consume_delta, prepare_insurance_lien_create_delta, … | – |
| `V16Core::validate_positive_pnl_source_attribution` | 1051–1063 (13) | before | TCL | validate_with_market | bound_num_from_amount |
| `V16Core::kernel_settle_kf_stale_cohort` | 1159–1175 (17) | kernels | TCL | apply_account_kf_settlement_entry | – |
| `V16Core::available_backing_num_for_source_credit_state` | 1242–1258 (17) | before | MTCL | expected_source_credit_rate_num_for_state, net_slot_face_at_par_not_atomic, resolved_loss_backing_capacity_num, source_credit_available_backing_num, … | – |
| `V16Core::unliened_claim_bound_num_for_source_credit_state` | 1269–1277 (9) | before | MTCL | expected_source_credit_rate_num_for_state | – |
| `V16Core::expected_source_credit_rate_num_for_state` | 1282–1301 (20) | before | MTCL | prepare_source_credit_domain_recompute_for_epoch_steps, validate_source_credit_state_static | available_backing_num_for_source_credit_state, unliened_claim_bound_num_for_source_credit_state, validate_source_credit_state_shape_static |
| `V16Core::validate_source_credit_state_shape_static` | 1303–1317 (15) | before | MTCL | expected_source_credit_rate_num_for_state, source_credit_for_domain_shape, validate_source_credit_state_static | available_backing_num_for_source_credit_state, validate_bound_num_atom_aligned |
| `V16Core::validate_source_credit_state_static` | 1319–1325 (7) | before | MTCL | source_credit_for_domain, try_to_runtime, validate, validate_source_domain_ledger_parts | expected_source_credit_rate_num_for_state, validate_source_credit_state_shape_static |
| `V16Core::validate_backing_bucket_static` | 1327–1366 (40) | before | MTCL | try_to_runtime, validate_source_domain_ledger_parts | is_empty_amount_shape, is_empty_amount_shape |
| `V16Core::validate_insurance_reservation_static` | 1368–1385 (18) | before | MTCL | try_to_runtime, validate_source_domain_ledger_parts | validate_bound_num_atom_aligned |
| `V16Core::validate_source_domain_ledger_parts` | 1387–1423 (37) | before | MTCL | consume_validated_account_source_credit_not_atomic, validate_source_domain_ledger | validate_backing_bucket_static, validate_insurance_reservation_static, validate_source_credit_state_static |
| `V16Core::prepare_source_credit_domain_recompute_for_epoch` | 1425–1430 (6) | kernels | TCL | consume_source_credit_lien_from_counterparty_core_not_atomic, recompute_source_credit_domain_after_mutation, … | prepare_source_credit_domain_recompute_for_epoch_steps |
| `V16Core::prepare_source_credit_domain_recompute_for_epoch_steps` | 1432–1451 (20) | kernels | TCL | create_and_consume_source_credit_from_counterparty_parts_not_atomic, create_and_consume_source_credit_from_insurance_parts_not_atomic, … | expected_source_credit_rate_num_for_state |
| `V16Core::prepare_source_positive_claim_burn_delta` | 1476–1489 (14) | kernels | TCL | create_and_consume_source_credit_from_counterparty_parts_not_atomic, create_and_consume_source_credit_from_insurance_parts_not_atomic | – |
| `V16Core::source_claim_domain_first_burn_partition` | 1492–1498 (7) | kernels | TCL | burn_account_source_claim_bound_num_domain_first | – |
| `V16Core::kernel_settle_principal` | 1844–1860 (17) | before | TCL | settle_negative_pnl_from_principal_core_not_atomic | – |
| `V16Core::kernel_settle_positive_face_after_support` | 1930–1947 (18) | kernels | TCL | apply_haircut_bounded_close_loss_to_pnl | – |
| `V16Core::kernel_recompute_resolved_payout_rate` | 2026–2045 (20) | kernels | TCL | kernel_credit_post_snapshot_residual | – |
| `V16Core::kernel_credit_post_snapshot_residual` | 2140–2154 (15) | kernels | TCL | credit_post_snapshot_residual_not_atomic | kernel_recompute_resolved_payout_rate |
| `V16Core::kernel_advance_leg_b_snap` | 2982–2995 (14) | kernels | TCL | settle_account_b_chunk | – |
| `V16Core::kernel_normalize_social_loss_carry` | 3017–3038 (22) | kernels | TCL | kernel_begin_full_drain_reset | – |
| `V16Core::kernel_begin_full_drain_reset` | 3043–3108 (66) | kernels | TCL | begin_full_drain_reset_inner | kernel_normalize_social_loss_carry |
| `V16Core::prepare_counterparty_lien_create_delta` | 3576–3601 (26) | kernels | TCL | create_and_consume_source_credit_from_counterparty_parts_not_atomic | – |
| `V16Core::prepare_counterparty_backing_add_delta` | 3619–3657 (39) | kernels | TCL | add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked | – |
| `V16Core::prepare_counterparty_backing_expiry_delta` | 3702–3738 (37) | kernels | TCL | expire_source_backing_bucket_not_atomic | – |
| `V16Core::prepare_counterparty_lien_terminal_release_delta` | 3954–3972 (19) | kernels | TCL | release_source_credit_lien_from_counterparty_terminal_not_atomic | – |
| `V16Core::prepare_counterparty_lien_consume_delta` | 3987–4023 (37) | kernels | TCL | consume_source_credit_lien_from_counterparty_core_not_atomic, create_and_consume_source_credit_from_counterparty_parts_not_atomic | – |
| `V16Core::prepare_insurance_lien_consume_delta` | 4117–4158 (42) | kernels | TCL | create_and_consume_source_credit_from_insurance_parts_not_atomic | amount_from_bound_num, validate_bound_num_atom_aligned |
| `V16Core::prepare_insurance_lien_create_delta` | 4173–4203 (31) | kernels | TCL | create_and_consume_source_credit_from_insurance_parts_not_atomic | validate_bound_num_atom_aligned |
| `V16Core::prepare_insurance_lien_release_delta` | 4217–4234 (18) | kernels | TCL | release_source_credit_lien_from_insurance_core_not_atomic | validate_bound_num_atom_aligned |
| `V16Core::prepare_insurance_lien_terminal_release_delta` | 4259–4292 (34) | kernels | TCL | release_source_credit_lien_from_insurance_terminal_not_atomic | validate_bound_num_atom_aligned |
| `V16Core::source_credit_state_realizable_support_for_claim_num` | 4335–4346 (12) | kernels | MTCL | consume_validated_account_source_credit_not_atomic | available_backing_num_for_source_credit_state, mul_div_floor_u128_or_wide |
| `V16Core::backing_utilization_rate_e9_for_source_state` | 4427–4476 (50) | kernels | TCL | backing_utilization_fee_quote_atoms_for_lien | validate_public_user_fund_shape |
| `V16Core::backing_utilization_fee_quote_atoms_for_lien` | 4478–4501 (24) | kernels | TCL | collect_account_backing_utilization_fee_for_domain_not_atomic | backing_utilization_rate_e9_for_source_state |
| `V16Config::validate_public_user_fund_shape` | 5077–5137 (61) | before | MTCL | backing_utilization_rate_e9_for_source_state, try_to_runtime_shape | – |
| `SourceCreditStateV16::is_empty_amount_shape` | 5318–5330 (13) | before | MTCL | validate_backing_bucket_static | – |
| `BackingBucketV16::is_empty_amount_shape` | 5394–5402 (9) | before | MTCL | validate_backing_bucket_static | – |
| `Market::engine_slot` | 5490–5492 (3) | before | MTCL | backing_bucket_for_domain, backing_bucket_raw_status_expiry_for_domain, domain_insurance_budget_spent, insurance_reservation_for_domain, … | – |
| `Market::engine_slot_mut` | 5496–5498 (3) | before | TCL | adjust_provider_principal_num, set_asset_state, set_backing_bucket_for_domain, set_domain_insurance_spent_core, set_insurance_reservation_for_domain, … | – |
| `Group::as_view` | 5522–5527 (6) | before | TCL | account_b_settlement_chunk, apply_haircut_bounded_close_loss_to_pnl, burn_account_source_claim_at_slot_up_to, burn_account_source_claim_bound_num, … | – |
| `Portfolio::source_domain_slot` | 5548–5559 (12) | primitives | TCL | burn_account_source_claim_bound_num_domain_first, collect_account_backing_utilization_fee_for_domain_not_atomic, … | get, is_occupied |
| `Portfolio::source_domain` | 5561–5566 (6) | primitives | TCL | source_claim_unliened_num | source_domain_slot |
| `PortfolioMut::as_view` | 5576–5580 (5) | before | TCL | apply_haircut_bounded_close_loss_to_pnl, burn_account_source_claim_at_slot_up_to, burn_account_source_claim_bound_num, clear_account_b_stale, … | – |
| `PortfolioMut::source_domain_slot` | 5582–5601 (20) | primitives | TCL | burn_account_source_claim_bound_num_domain_first, collect_account_backing_utilization_fee_for_domain_not_atomic, … | get, has_default_sparse_tag, is_occupied |
| `PortfolioMut::compact_source_domains` | 5645–5686 (42) | before | TCL | burn_account_source_claim_bound_num, burn_account_source_claim_bound_num_domain_first, consume_validated_account_source_credit_not_atomic, … | get, is_occupied |
| `Portfolio::source_claim_bound_sum_num` | 5909–5919 (11) | before | TCL | validate_with_market | get |
| `Portfolio::validate_resolved_payout_receipt_static` | 5921–5923 (3) | before | TCL | validate_with_market | validate_resolved_payout_receipt_value |
| `Portfolio::validate_close_progress_ledger_with_market` | 5925–5992 (68) | before | TCL | validate_with_market | active_leg_slot_for_asset, get, get, get, get, get, has_irreversible_progress, is_empty, is_empty, is_empty, opposite_side, try_to_runtime, try_to_runtime |
| `Portfolio::active_leg_slot_for_asset` | 5994–6008 (15) | before | TCL | validate_close_progress_ledger_with_market, validate_with_market | try_to_runtime |
| `PortfolioLegV16::is_empty` | 6106–6123 (18) | before | MTCL | try_to_runtime, validate_close_progress_ledger_with_market, validate_resolved_payout_receipt_value, validate_with_market | – |
| `CloseProgressLedgerV16::has_pending_residual` | 6193–6195 (3) | primitives | TCL | prepare_account_kf_settlement_entry | – |
| `CloseProgressLedgerV16::has_irreversible_progress` | 6197–6205 (9) | before | TCL | validate_close_progress_ledger_with_market | – |
| `CloseProgressLedgerV16::is_empty` | 6211–6230 (20) | before | MTCL | try_to_runtime, validate_close_progress_ledger_with_market, validate_resolved_payout_receipt_value, validate_with_market | – |
| `ResolvedPayoutReceiptV16::is_empty` | 6292–6299 (8) | before | MTCL | try_to_runtime, validate_close_progress_ledger_with_market, validate_resolved_payout_receipt_value, validate_with_market | – |
| `validate_resolved_payout_receipt_value` | 6308–6326 (19) | before | TCL | validate_resolved_payout_receipt_static | is_empty, is_empty, is_empty |
| `TokenValueFlowProofV16::empty` | 6887–6896 (10) | before | TCL | account_capital_to_realized_loss, insurance_to_close_insurance_spent | – |
| `TokenValueFlowProofV16::account_capital_to_realized_loss` | 7003–7012 (10) | before | TCL | pay_kf_loss_from_free_capital_not_atomic, reserve_new_capital_backed_loss_for_source_domain_not_atomic, settle_negative_pnl_from_principal_core_not_atomic | credit, debit, empty |
| `TokenValueFlowProofV16::insurance_to_close_insurance_spent` | 7014–7023 (10) | primitives | TCL | validate_insurance_to_close_insurance_spent | credit, debit, empty |
| `TokenValueFlowProofV16::debit` | 7096–7102 (7) | before | TCL | account_capital_to_realized_loss, insurance_to_close_insurance_spent | – |
| `TokenValueFlowProofV16::credit` | 7104–7110 (7) | before | TCL | account_capital_to_realized_loss, insurance_to_close_insurance_spent | – |
| `TokenValueFlowProofV16::validate` | 7112–7145 (34) | before | TCL | add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked, consume_source_credit_lien_from_counterparty_core_not_atomic, … | – |
| `ReservationEncumbranceProofV16::validate` | 7173–7213 (41) | before | TCL | add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked, consume_source_credit_lien_from_counterparty_core_not_atomic, … | validate_source_credit_state_static |
| `SourceCreditLienAggregateProofV16::validate` | 7263–7303 (41) | before | TCL | add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked, consume_source_credit_lien_from_counterparty_core_not_atomic, … | amount_from_bound_num |
| `account_kf_settlement_plan_key` | 7362–7375 (14) | kernels | TCL | decode_account_kf_settlement_plan_key, prepare_account_kf_settlement_entry | – |
| `decode_account_kf_settlement_plan_key` | 7377–7389 (13) | kernels | TCL | apply_account_kf_settlement_entry | account_kf_settlement_plan_key |
| `V16PodU16::get` | 7557–7559 (3) | before | MTCL | account_b_settlement_chunk_from_leg, add_account_u128_counter, adjust_provider_principal_num, asset_state, b_target_for_leg, … | – |
| `V16PodU32::new` | 7569–7573 (5) | in place | TCL | ensure_account_source_claim_market_id, from_runtime, source_domain_slot_or_insert | – |
| `V16PodU32::get` | 7575–7577 (3) | before | MTCL | account_b_settlement_chunk_from_leg, add_account_u128_counter, adjust_provider_principal_num, asset_state, b_target_for_leg, … | – |
| `V16PodU64::new` | 7587–7591 (5) | before | TCL | begin_full_drain_reset_inner, burn_account_source_lien_face_not_atomic, clear_account_b_stale, collect_account_backing_utilization_fee_for_domain_not_atomic, … | – |
| `V16PodU64::get` | 7593–7595 (3) | before | MTCL | account_b_settlement_chunk_from_leg, add_account_u128_counter, add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked, … | – |
| `V16PodU128::new` | 7605–7609 (5) | before | TCL | add_account_u128_counter, adjust_provider_principal_num, apply_haircut_bounded_close_loss_to_pnl, burn_account_source_lien_face_not_atomic, … | – |
| `V16PodU128::get` | 7611–7613 (3) | before | MTCL | account_b_settlement_chunk_from_leg, account_source_claim_bound_sum_num, add_account_u128_counter, adjust_provider_principal_num, … | – |
| `V16PodI128::new` | 7623–7627 (5) | before | TCL | from_runtime, from_runtime, set_account_pnl_after_principal_settlement, set_account_pnl_inner | – |
| `V16PodI128::get` | 7629–7631 (3) | before | MTCL | account_b_settlement_chunk_from_leg, add_account_u128_counter, adjust_provider_principal_num, apply_account_kf_settlement_entry, … | – |
| `V16OptionalRecoveryReasonAccount::try_to_runtime` | 7655–7661 (7) | before | TCL | validate_shape | decode_recovery_reason |
| `V16ConfigAccount::decode_runtime` | 7807–7860 (54) | before | MTCL | try_to_runtime_shape | decode_bool, get, get, get, get, get |
| `V16ConfigAccount::try_to_runtime_shape` | 7862–7866 (5) | before | MTCL | collect_account_backing_utilization_fee_for_domain_not_atomic, fresh_counterparty_backing_expiry_slot, validate_shape, validate_with_market | decode_runtime, validate_public_user_fund_shape |
| `SourceCreditStateV16Account::from_runtime` | 7893–7908 (16) | in place | TCL | set_source_credit_for_domain | new, new |
| `SourceCreditStateV16Account::try_to_runtime` | 7910–7927 (18) | before | TCL | validate_source_credit_shape_with_market | get, get, get, get, get, validate_source_credit_state_static |
| `BackingBucketV16Account::from_runtime` | 7944–7955 (12) | in place | TCL | set_backing_bucket_for_domain | encode_backing_bucket_status, new, new |
| `BackingBucketV16Account::try_to_runtime` | 7957–7970 (14) | before | MTCL | backing_bucket_for_domain | decode_backing_bucket_status, get, get, get, get, get, validate_backing_bucket_static |
| `InsuranceCreditReservationV16Account::from_runtime` | 7984–7992 (9) | in place | TCL | set_insurance_reservation_for_domain | new, new |
| `InsuranceCreditReservationV16Account::try_to_runtime` | 7994–8004 (11) | before | MTCL | insurance_reservation_for_domain | get, get, get, get, get, validate_insurance_reservation_static |
| `AssetStateV16Account::from_runtime` | 8056–8102 (47) | before | TCL | set_asset_state | encode_asset_lifecycle, encode_side_mode, new, new, new |
| `AssetStateV16Account::try_to_runtime` | 8104–8159 (56) | before | MTCL | asset_state, b_target_for_leg, slot_resolved_payout_blockers_v16, validate_source_credit_shape_with_market, validate_with_market | decode_asset_lifecycle, decode_side_mode, get, get, get, get, get, validate_non_min_i128 |
| `asset_contributes_to_loss_stale_summary` | 8189–8203 (15) | kernels | TCL | asset_is_loss_stale_at_slot | – |
| `asset_is_loss_stale_at_slot` | 8205–8209 (5) | kernels | TCL | apply_account_kf_settlement_entry | asset_contributes_to_loss_stale_summary |
| `slot_resolved_payout_blockers_v16` | 8211–8221 (11) | before | TCL | set_asset_state | get, try_to_runtime |
| `MarketGroupV16HeaderAccount::validate_dynamic_market_slots_len_static` | 8651–8660 (10) | before | TCL | validate_shape | – |
| `GroupView::validate_shape` | 8858–8914 (57) | before | TCL | refresh_source_credit_domain_after_mutation, release_source_credit_lien_from_counterparty_terminal_not_atomic, … | amount_from_bound_num, bound_num_from_amount, decode_bool, get, get, get, get, get, try_to_runtime, try_to_runtime, try_to_runtime_shape, … |
| `GroupView::validate_header_aggregate_totals` | 8916–8958 (43) | before | TCL | validate_shape | get |
| `Group::validate_shape` | 9175–9177 (3) | before | TCL | refresh_source_credit_domain_after_mutation, release_source_credit_lien_from_counterparty_terminal_not_atomic, … | as_view, validate_shape |
| `Group::validate_account_audit_scan` | 9247–9256 (10) | in place | TCL | settle_account_b_chunk | – |
| `Group::configured_domain_count` | 9291–9293 (3) | before | MTCL | domain_asset_side | get, get, get, get, get, v16_domain_count_for_market_slots |
| `Group::apply_total_delta` | 9302–9312 (11) | before | TCL | set_domain_insurance_spent_delta, update_backing_aggregate_totals, update_source_credit_aggregate_totals | – |
| `Group::apply_total_delta_u64` | 9314–9324 (11) | before | TCL | update_resolved_payout_blocker_total | – |
| `Group::domain_budget_remaining_parts` | 9326–9328 (3) | primitives | TCL | set_domain_insurance_spent_delta | – |
| `Group::update_source_credit_aggregate_totals` | 9330–9358 (29) | primitives | TCL | set_source_credit_for_domain | amount_from_bound_num, apply_total_delta, get, new |
| `Group::update_backing_aggregate_totals` | 9360–9371 (12) | primitives | TCL | set_backing_bucket_for_domain | apply_total_delta, get, new |
| `Group::update_resolved_payout_blocker_total` | 9373–9380 (8) | before | TCL | set_asset_state | apply_total_delta_u64, get, new |
| `Group::backing_provider_earnings_total` | 9384–9386 (3) | primitives | TCL | residual | get |
| `Group::source_fresh_backing_total_atoms` | 9392–9394 (3) | primitives | TCL | residual | get |
| `Group::residual` | 9402–9411 (10) | primitives | TCL | apply_haircut_bounded_close_loss_to_pnl, apply_signed_kf_delta_to_pnl, expire_source_backing_bucket_not_atomic | backing_provider_earnings_total, get, source_fresh_backing_total_atoms |
| `Group::junior_claim_bound` | 9413–9415 (3) | primitives | TCL | apply_haircut_bounded_close_loss_to_pnl, apply_signed_kf_delta_to_pnl | get |
| `Group::domain_asset_side` | 9417–9432 (16) | before | MTCL | adjust_provider_principal_num, backing_bucket_for_domain, backing_bucket_raw_status_expiry_for_domain, book_realized_kf_loss_for_source_domain_not_atomic, … | configured_domain_count |
| `Group::insurance_domain_index` | 9434–9444 (11) | primitives | TCL | apply_account_kf_settlement_entry, kf_loss_lien_backing_to_consume_num, pending_domain_loss_barrier_count, prepare_account_kf_settlement_entry, … | domain_asset_side, encode_side, get, get, get, get, get |
| `Group::source_credit_for_domain` | 9446–9450 (5) | primitives | MTCL | add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked, book_realized_kf_loss_for_source_domain_not_atomic, … | source_credit_for_domain_shape, validate_source_credit_state_static |
| `Group::stored_source_credit_rate_num` | 9454–9461 (8) | primitives | TCL | cancel_loss_domain_face_at_par_not_atomic, settle_kf_loss_before_support_not_atomic | domain_asset_side, engine_slot, get, get, get, get, get |
| `Group::source_credit_for_domain_shape` | 9463–9486 (24) | before | MTCL | consume_validated_account_source_credit_not_atomic, recompute_source_credit_domain_after_mutation, recompute_source_credit_domain_after_mutations, … | domain_asset_side, engine_slot, get, get, get, get, get, validate_source_credit_state_shape_static |
| `Group::provider_principal_num` | 9548–9555 (8) | primitives | TCL | book_realized_kf_loss_for_source_domain_not_atomic | domain_asset_side, engine_slot, get |
| `Group::loser_paid_backing_num` | 9569–9583 (15) | primitives | TCL | twin_loser_paid_share_num | domain_asset_side, engine_slot, get, get, get, get, get |
| `Group::backing_freshness_horizon_slots` | 9614–9622 (9) | before | MTCL | effective_backing_expiry_slot, fresh_counterparty_backing_expiry_slot | get, get, get, get, get |
| `Group::effective_backing_expiry_slot` | 9630–9640 (11) | before | MTCL | backing_bucket_for_domain, backing_bucket_raw_status_expiry_for_domain, fresh_counterparty_backing_expiry_slot | backing_freshness_horizon_slots, decode_market_mode, get |
| `Group::backing_bucket_for_domain` | 9642–9651 (10) | before | MTCL | add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked, book_realized_kf_loss_for_source_domain_not_atomic, … | domain_asset_side, effective_backing_expiry_slot, engine_slot, try_to_runtime |
| `Group::backing_bucket_raw_status_expiry_for_domain` | 9655–9666 (12) | primitives | TCL | book_realized_kf_loss_for_source_domain_not_atomic, cancel_loss_domain_face_at_par_not_atomic, consume_validated_account_source_credit_not_atomic, … | domain_asset_side, effective_backing_expiry_slot, engine_slot, get, get, get, get, get |
| `Group::insurance_reservation_for_domain` | 9684–9694 (11) | before | MTCL | consume_source_credit_lien_from_counterparty_core_not_atomic, consume_validated_account_source_credit_not_atomic, … | domain_asset_side, engine_slot, try_to_runtime |
| `Group::reservation_encumbrance_proof_for_domain_parts` | 9804–9833 (30) | primitives | TCL | consume_source_credit_lien_from_counterparty_core_not_atomic, create_and_consume_source_credit_from_counterparty_parts_not_atomic, … | domain_asset_side |
| `Group::fresh_counterparty_backing_expiry_slot` | 9835–9851 (17) | primitives | TCL | book_realized_kf_loss_for_source_domain_not_atomic, pay_kf_loss_from_free_capital_not_atomic | backing_bucket_for_domain, backing_freshness_horizon_slots, domain_asset_side, effective_backing_expiry_slot, get, try_to_runtime_shape |
| `Group::account_source_claim_bound_sum_num` | 11055–11069 (15) | primitives | MTCL | account_has_source_claims, burn_account_source_claim_bound_num | get, has_default_sparse_tag, is_occupied |
| `Group::account_has_source_claims` | 11071–11073 (3) | primitives | MTCL | apply_haircut_bounded_close_loss_to_pnl | account_source_claim_bound_sum_num |
| `Group::source_claim_unliened_num` | 11132–11144 (13) | primitives | TCL | burn_account_source_claim_at_slot_up_to | get, source_domain |
| `Group::domain_insurance_budget_spent` | 12010–12023 (14) | primitives | TCL | create_and_consume_source_credit_from_insurance_parts_not_atomic, set_domain_insurance_spent_core | domain_asset_side, engine_slot, get |
| `Group::haircut_effective_support` | 13462–13475 (14) | kernels | TCL | apply_haircut_bounded_close_loss_to_pnl, apply_signed_kf_delta_to_pnl | – |
| `Group::record_account_residual_crystallized_loss` | 13526–13542 (17) | before | TCL | pay_kf_loss_from_free_capital_not_atomic, reserve_new_capital_backed_loss_for_source_domain_not_atomic, settle_negative_pnl_from_principal_core_not_atomic | get, new |
| `Group::sync_unattributed_loss_lock` | 13700–13711 (12) | before | TCL | set_account_pnl_after_principal_settlement, set_account_pnl_inner | decode_bool, encode_bool, unattributed_loss_lock_after_pnl |
| `Group::slot_unliened_claim_num` | 14129–14141 (13) | primitives | TCL | net_slot_face_at_par_not_atomic, settle_kf_loss_before_support_not_atomic | get |
| `Group::kf_target_for_leg_from_asset` | 14945–14977 (33) | kernels | TCL | apply_account_kf_settlement_entry, leg_kf_delta_components_for_settlement_from_asset | – |
| `Group::b_target_for_leg_from_asset` | 15002–15026 (25) | kernels | MTCL | b_target_for_leg | – |
| `Group::leg_kf_delta_components_for_settlement_from_asset` | 15029–15078 (50) | kernels | TCL | prepare_account_kf_settlement_entry | f_snap_after_settlement, kf_target_for_leg_from_asset, scaled_adl_delta_fast, validate_non_min_i128 |
| `Group::has_b_stale_leg` | 15701–15711 (11) | primitives | TCL | clear_account_b_stale, settle_account_b_chunk | try_to_runtime |
| `Group::account_b_settlement_chunk_from_leg` | 15864–15919 (56) | kernels | TCL | account_b_settlement_chunk | get, get, get, get, get |
| `Group::active_leg_slot_for_asset` | 17405–17428 (24) | primitives | TCL | active_leg_for_asset, require_active_leg_slot_for_asset | active_bitmap_get, try_to_runtime |
| `Group::require_active_leg_slot_for_asset` | 17430–17435 (6) | primitives | TCL | mark_leg_b_stale, settle_account_b_chunk | active_leg_slot_for_asset |
| `Group::active_leg_for_asset` | 17437–17446 (10) | primitives | TCL | account_b_settlement_chunk | active_leg_slot_for_asset, try_to_runtime |
| `Group::asset_state` | 17448–17455 (8) | primitives | MTCL | apply_account_kf_settlement_entry, begin_full_drain_reset_inner, book_realized_kf_loss_for_source_domain_not_atomic, prepare_account_kf_settlement_entry | get, get, get, get, get, try_to_runtime |
| `Group::validate_configured_asset_index` | 17509–17516 (8) | before | TCL | begin_full_drain_reset_inner | get, get, get, get, get |
| `Group::pending_domain_loss_barrier_count` | 17923–17935 (13) | primitives | TCL | has_pending_domain_loss_barrier | domain_asset_side, engine_slot, get, insurance_domain_index |
| `Group::leg_has_exhausted_effective_oi` | 22505–22526 (22) | kernels | TCL | prepare_account_kf_settlement_entry | – |
| `PortfolioLegV16Account::from_runtime` | 22774–22793 (20) | in place | TCL | apply_account_kf_settlement_entry, mark_leg_b_stale, settle_account_b_chunk | encode_bool, encode_side, new, new, new, new |
| `PortfolioLegV16Account::try_to_runtime` | 22795–22820 (26) | before | MTCL | active_leg_for_asset, active_leg_slot_for_asset, active_leg_slot_for_asset, apply_account_kf_settlement_entry, has_b_stale_leg, mark_leg_b_stale, … | decode_bool, decode_side, get, get, get, get, get, is_empty, is_empty, is_empty, validate_active_leg |
| `CloseProgressLedgerV16Account::try_to_runtime` | 22922–22943 (22) | before | TCL | prepare_account_kf_settlement_entry, validate_close_progress_ledger_with_market | decode_bool, decode_side, get, get, get, get, get |
| `ResolvedPayoutLedgerV16Account::from_runtime` | 22960–22975 (16) | in place | TCL | credit_post_snapshot_residual_not_atomic | encode_bool, new, new |
| `ResolvedPayoutLedgerV16Account::try_to_runtime` | 22977–22988 (12) | before | TCL | credit_post_snapshot_residual_not_atomic, validate_shape | decode_bool, get, get, get, get, get |
| `ResolvedPayoutReceiptV16Account::try_to_runtime` | 23014–23023 (10) | before | TCL | validate_with_market | decode_bool, get, get, get, get, get |
| `PortfolioSourceDomainV16Account::is_occupied` | 23051–23064 (14) | before | MTCL | account_source_claim_bound_sum_num, burn_account_source_claim_at_slot_up_to, burn_account_source_claim_bound_num, compact_source_domains, … | get, get |
| `PortfolioSourceDomainV16Account::has_default_sparse_tag` | 23067–23069 (3) | before | MTCL | account_source_claim_bound_sum_num, burn_account_source_claim_bound_num, consume_validated_account_source_credit_not_atomic, is_sparse_tail_default, … | get, get |
| `PortfolioSourceDomainV16Account::is_sparse_tail_default` | 23072–23074 (3) | primitives | TCL | settle_kf_loss_before_support_not_atomic | has_default_sparse_tag, is_occupied |
| `encode_bool` | 23407–23413 (7) | before | TCL | apply_account_kf_settlement_entry, from_runtime, from_runtime, sync_unattributed_loss_lock | – |
| `decode_bool` | 23415–23421 (7) | before | MTCL | book_kf_loss_support_for_source_domain_not_atomic, book_realized_kf_loss_for_source_domain_not_atomic, clear_account_b_stale, … | – |
| `encode_side` | 23423–23428 (6) | in place | TCL | from_runtime, insurance_domain_index | – |
| `decode_side` | 23430–23436 (7) | before | MTCL | try_to_runtime, try_to_runtime | – |
| `encode_side_mode` | 23438–23444 (7) | before | TCL | from_runtime | – |
| `decode_side_mode` | 23446–23453 (8) | before | MTCL | try_to_runtime | – |
| `encode_asset_lifecycle` | 23455–23464 (10) | before | TCL | from_runtime | – |
| `decode_asset_lifecycle` | 23466–23476 (11) | before | MTCL | try_to_runtime | – |
| `decode_market_mode` | 23486–23493 (8) | before | MTCL | apply_haircut_bounded_close_loss_to_pnl, apply_signed_kf_delta_to_pnl, book_realized_kf_loss_for_source_domain_not_atomic, … | – |
| `encode_backing_bucket_status` | 23495–23502 (8) | in place | TCL | book_realized_kf_loss_for_source_domain_not_atomic, cancel_loss_domain_face_at_par_not_atomic, consume_validated_account_source_credit_not_atomic, … | – |
| `decode_backing_bucket_status` | 23504–23512 (9) | before | MTCL | try_to_runtime | – |
| `decode_recovery_reason` | 23527–23539 (13) | before | TCL | try_to_runtime | – |
| `opposite_side` | 23560–23565 (6) | before | TCL | apply_account_kf_settlement_entry, book_realized_kf_loss_for_source_domain_not_atomic, kf_loss_lien_backing_to_consume_num, … | – |
| `validate_non_min_i128` | 23580–23585 (6) | before | MTCL | apply_signed_kf_delta_to_pnl, leg_kf_delta_components_for_settlement_from_asset, set_account_pnl_after_principal_settlement, set_account_pnl_inner, … | – |
| `validate_fee_credits` | 23587–23593 (7) | before | MTCL | validate_with_market | validate_non_min_i128 |
| `validate_basis` | 23595–23603 (9) | before | MTCL | validate_active_leg | – |
| `validate_active_leg` | 23605–23624 (20) | before | MTCL | try_to_runtime, validate_with_market | loss_weight_for_basis, validate_basis, validate_non_min_i128 |
| `snapshot_epoch_bound_to_side` | 23626–23629 (4) | before | TCL | leg_snapshots_bound_to_asset_side | – |
| `leg_snapshots_bound_to_asset_side` | 23631–23639 (9) | before | TCL | validate_with_market | snapshot_epoch_bound_to_side |
| `loss_weight_for_basis` | 23676–23687 (12) | before | MTCL | validate_active_leg | – |
| `scaled_adl_delta_fast` | 23689–23709 (21) | kernels | TCL | leg_kf_delta_components_for_settlement_from_asset | – |
| `f_snap_after_settlement` | 23723–23772 (50) | kernels | TCL | leg_kf_delta_components_for_settlement_from_asset | f_snap_residual_is_sub_atom |
| `f_snap_residual_is_sub_atom` | 23778–23801 (24) | kernels | TCL | f_snap_after_settlement | – |

#### Layer 2: Backing and lien primitives

| Function | Lines | Status | Also | Callers in the closure | Callees in the closure |
| --- | --- | --- | --- | --- | --- |
| `PortfolioMut::source_domain_slot_or_insert` | 5603–5624 (22) | primitives | TCL | source_domain_mut_or_insert | get, has_default_sparse_tag, is_occupied, new |
| `PortfolioMut::source_domain_mut_or_insert` | 5626–5632 (7) | primitives | TCL | ensure_account_source_claim_market_id, set_account_pnl_inner | source_domain_slot_or_insert |
| `PortfolioMut::reset_source_domain_slot_if_empty` | 5634–5643 (10) | primitives | TCL | burn_account_source_claim_at_slot_up_to, collect_account_backing_utilization_fee_for_domain_not_atomic, decrement_account_source_claim_for_domain_not_atomic, … | has_default_sparse_tag, is_occupied |
| `Portfolio::validate_with_market` | 5690–5795 (106) | before | TCL | account_b_settlement_chunk, settle_account_side_effects_not_atomic, validate_with_market | active_bitmap_get, active_leg_slot_for_asset, decode_bool, decode_market_mode, get, get, get, get, get, is_empty, is_empty, is_empty, … |
| `Portfolio::validate_source_credit_shape_with_market` | 5797–5907 (111) | before | TCL | validate_with_market | amount_from_bound_num, engine_slot, get, get, get, get, get, has_default_sparse_tag, is_occupied, try_to_runtime, try_to_runtime, … |
| `PortfolioMut::validate_with_market` | 6056–6058 (3) | before | TCL | account_b_settlement_chunk, settle_account_side_effects_not_atomic | as_view, validate_with_market |
| `TokenValueFlowProofV16::validate_insurance_to_close_insurance_spent` | 7025–7031 (7) | primitives | TCL | create_and_consume_source_credit_from_insurance_parts_not_atomic | insurance_to_close_insurance_spent, validate, validate, validate |
| `Group::set_source_credit_for_domain` | 9488–9506 (19) | primitives | TCL | add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked, burn_account_source_claim_at_slot_up_to, … | domain_asset_side, engine_slot_mut, from_runtime, source_credit_for_domain_shape, update_source_credit_aggregate_totals |
| `Group::release_provider_principal_after` | 9511–9522 (12) | primitives | TCL | expire_source_backing_bucket_not_atomic | adjust_provider_principal_num |
| `Group::adjust_provider_principal_num` | 9525–9544 (20) | primitives | TCL | release_provider_principal_after | domain_asset_side, engine_slot_mut, get, get, get, get, get, new |
| `Group::add_loser_paid_counterparty_backing_unchecked` | 9588–9595 (8) | primitives | TCL | book_realized_kf_loss_for_source_domain_not_atomic | add_fresh_counterparty_backing_unchecked |
| `Group::add_loser_paid_counterparty_backing_payments_unchecked` | 9602–9610 (9) | primitives | TCL | settle_kf_loss_before_support_not_atomic | add_fresh_counterparty_backing_steps_unchecked |
| `Group::set_backing_bucket_for_domain` | 9668–9682 (15) | primitives | TCL | add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked, collect_account_backing_utilization_fee_for_domain_not_atomic, … | backing_bucket_for_domain, domain_asset_side, engine_slot_mut, from_runtime, update_backing_aggregate_totals |
| `Group::validate_source_domain_ledger` | 9696–9703 (8) | before | MTCL | validate_source_domain_ledger_current | backing_bucket_for_domain, domain_asset_side, get, get, get, get, get, insurance_reservation_for_domain, source_credit_for_domain_shape, … |
| `Group::validate_source_domain_ledger_current` | 9705–9714 (10) | primitives | MTCL | consume_source_domain_credit_for_effective_not_atomic, source_domain_prospective_support_for_face | backing_bucket_for_domain, get, validate_source_domain_ledger |
| `Group::recompute_source_credit_domain_after_mutation` | 9716–9725 (10) | primitives | TCL | add_fresh_counterparty_backing_unchecked, burn_account_source_claim_at_slot_up_to, decrement_account_source_claim_for_domain_not_atomic, … | get, new, prepare_source_credit_domain_recompute_for_epoch, set_source_credit_for_domain, source_credit_for_domain_shape |
| `Group::recompute_source_credit_domain_after_mutations` | 9730–9745 (16) | primitives | TCL | add_fresh_counterparty_backing_steps_unchecked | get, new, prepare_source_credit_domain_recompute_for_epoch_steps, set_source_credit_for_domain, source_credit_for_domain_shape |
| `Group::refresh_source_credit_domain_after_mutation` | 9747–9752 (6) | primitives | TCL | expire_source_backing_bucket_not_atomic | recompute_source_credit_domain_after_mutation, reservation_encumbrance_proof_for_domain, validate, validate, validate, validate_shape, validate_shape |
| `Group::reservation_encumbrance_proof_for_domain` | 9774–9802 (29) | primitives | TCL | add_fresh_counterparty_backing_steps_unchecked, add_fresh_counterparty_backing_unchecked, refresh_source_credit_domain_after_mutation | backing_bucket_for_domain, insurance_reservation_for_domain, source_credit_for_domain |
| `Group::add_fresh_counterparty_backing_unchecked` | 9853–9873 (21) | primitives | TCL | add_loser_paid_counterparty_backing_unchecked | backing_bucket_for_domain, get, prepare_counterparty_backing_add_delta, recompute_source_credit_domain_after_mutation, … |
| `Group::add_fresh_counterparty_backing_steps_unchecked` | 9880–9901 (22) | primitives | TCL | add_loser_paid_counterparty_backing_payments_unchecked | backing_bucket_for_domain, get, prepare_counterparty_backing_add_delta, recompute_source_credit_domain_after_mutations, … |
| `Group::expire_source_backing_bucket_not_atomic` | 10126–10159 (34) | primitives | TCL | book_realized_kf_loss_for_source_domain_not_atomic, reconcile_account_impaired_counterparty_lien_at_slot_not_atomic, … | backing_bucket_for_domain, credit_post_snapshot_residual_not_atomic, decode_bool, prepare_counterparty_backing_expiry_delta, … |
| `Group::credit_post_snapshot_residual_not_atomic` | 10161–10173 (13) | primitives | TCL | expire_source_backing_bucket_not_atomic, reserve_new_capital_backed_loss_for_source_domain_not_atomic | decode_bool, from_runtime, get, kernel_credit_post_snapshot_residual, new, try_to_runtime |
| `Group::release_source_credit_lien_from_counterparty_terminal_not_atomic` | 10429–10458 (30) | primitives | TCL | release_or_retire_counterparty_lien_backing_not_atomic | backing_bucket_for_domain, domain_asset_side, get, insurance_reservation_for_domain, new, prepare_counterparty_lien_terminal_release_delta, … |
| `Group::consume_source_credit_lien_from_counterparty_core_not_atomic` | 10520–10549 (30) | primitives | TCL | burn_account_source_lien_face_not_atomic | backing_bucket_for_domain, domain_asset_side, get, insurance_reservation_for_domain, new, prepare_counterparty_lien_consume_delta, … |
| `Group::release_source_credit_lien_from_insurance_core_not_atomic` | 10711–10740 (30) | primitives | TCL | burn_account_source_lien_face_not_atomic | backing_bucket_for_domain, domain_asset_side, get, insurance_reservation_for_domain, new, prepare_insurance_lien_release_delta, … |
| `Group::release_source_credit_lien_from_insurance_terminal_not_atomic` | 10752–10781 (30) | primitives | TCL | burn_account_source_claim_at_slot_up_to, burn_account_source_lien_face_not_atomic | backing_bucket_for_domain, domain_asset_side, get, insurance_reservation_for_domain, new, prepare_insurance_lien_terminal_release_delta, … |
| `Group::kf_loss_lien_backing_to_consume_num` | 11549–11601 (53) | primitives | TCL | burn_account_source_lien_face_not_atomic | backing_bucket_raw_status_expiry_for_domain, bound_num_from_amount, domain_asset_side, encode_backing_bucket_status, get, has_pending_domain_loss_barrier, … |
| `Group::source_credit_available_backing_num` | 11909–11913 (5) | primitives | TCL | consume_source_domain_credit_for_effective_not_atomic | available_backing_num_for_source_credit_state, source_credit_for_domain |
| `Group::set_insurance_reservation_for_domain` | 11990–12008 (19) | primitives | TCL | create_and_consume_source_credit_from_insurance_parts_not_atomic, release_source_credit_lien_from_insurance_core_not_atomic, … | domain_asset_side, engine_slot_mut, from_runtime |
| `Group::set_domain_insurance_spent_delta` | 12041–12055 (15) | primitives | TCL | set_domain_insurance_spent_core | apply_total_delta, domain_budget_remaining_parts |
| `Group::set_domain_insurance_spent_core` | 12057–12074 (18) | primitives | TCL | create_and_consume_source_credit_from_insurance_parts_not_atomic | domain_asset_side, domain_insurance_budget_spent, engine_slot_mut, get, new, set_domain_insurance_spent_delta |
| `Group::create_and_consume_source_credit_from_counterparty_core_not_atomic` | 12573–12590 (18) | primitives | TCL | consume_source_domain_credit_for_effective_not_atomic | backing_bucket_for_domain, create_and_consume_source_credit_from_counterparty_parts_not_atomic, domain_asset_side, insurance_reservation_for_domain, … |
| `Group::create_and_consume_source_credit_from_counterparty_parts_not_atomic` | 12592–12624 (33) | primitives | TCL | consume_validated_account_source_credit_not_atomic, create_and_consume_source_credit_from_counterparty_core_not_atomic, net_slot_face_at_par_not_atomic | get, new, prepare_counterparty_lien_consume_delta, prepare_counterparty_lien_create_delta, prepare_source_credit_domain_recompute_for_epoch_steps, … |
| `Group::create_and_consume_source_credit_from_insurance_core_not_atomic` | 12626–12643 (18) | primitives | TCL | consume_source_domain_credit_for_effective_not_atomic | backing_bucket_for_domain, create_and_consume_source_credit_from_insurance_parts_not_atomic, domain_asset_side, insurance_reservation_for_domain, … |
| `Group::create_and_consume_source_credit_from_insurance_parts_not_atomic` | 12645–12691 (47) | primitives | TCL | consume_validated_account_source_credit_not_atomic, create_and_consume_source_credit_from_insurance_core_not_atomic | domain_insurance_budget_spent, get, get, new, new, prepare_insurance_lien_consume_delta, prepare_insurance_lien_create_delta, … |
| `Group::ensure_account_source_claim_market_id` | 13503–13524 (22) | primitives | TCL | set_account_pnl_inner | domain_asset_side, get, get, get, get, get, new, new, source_domain_mut_or_insert |
| `Group::add_account_u128_counter` | 13544–13555 (12) | primitives | TCL | record_account_funding_flow | get, get, get, get, get, new |
| `Group::face_claim_to_burn_for_support` | 13931–13953 (23) | primitives | TCL | apply_haircut_bounded_close_loss_to_pnl, apply_signed_kf_delta_to_pnl | – |
| `Group::twin_loser_paid_share_num` | 14342–14365 (24) | primitives | TCL | kf_loss_lien_backing_to_consume_num, net_slot_face_at_par_not_atomic | bound_num_from_amount, loser_paid_backing_num |
| `Group::loss_bucket_accepts_fresh` | 14367–14374 (8) | primitives | TCL | kf_loss_lien_backing_to_consume_num, settle_kf_loss_before_support_not_atomic | backing_bucket_for_domain, get |
| `Group::resolved_loss_backing_capacity_num` | 14909–14929 (21) | primitives | TCL | book_realized_kf_loss_for_source_domain_not_atomic | available_backing_num_for_source_credit_state, backing_bucket_for_domain, decode_bool, get, source_credit_for_domain |
| `Group::collect_account_backing_utilization_fee_for_domain_not_atomic` | 15774–15850 (77) | primitives | TCL | burn_account_source_lien_face_not_atomic, reconcile_account_impaired_counterparty_lien_at_slot_not_atomic | apply_backing_utilization_fee_charge, backing_bucket_for_domain, backing_utilization_fee_quote_atoms_for_lien, domain_asset_side, get, get, get, new, new, … |
| `Group::set_asset_state` | 17457–17479 (23) | before | TCL | apply_account_kf_settlement_entry, begin_full_drain_reset_inner | engine_slot, engine_slot_mut, from_runtime, get, get, get, get, get, slot_resolved_payout_blockers_v16, update_resolved_payout_blocker_total |
| `Group::has_pending_domain_loss_barrier` | 17937–17943 (7) | primitives | TCL | begin_full_drain_reset_inner, kf_loss_lien_backing_to_consume_num, net_slot_face_at_par_not_atomic, prepare_account_kf_settlement_entry, … | pending_domain_loss_barrier_count |
| `Group::set_account_pnl_after_principal_settlement` | 20252–20274 (23) | before | TCL | settle_negative_pnl_from_principal_core_not_atomic | get, get, new, new, sync_unattributed_loss_lock, validate_non_min_i128 |
| `Group::settle_negative_pnl_from_principal_core_not_atomic` | 20433–20468 (36) | before | TCL | settle_account_side_effects_not_atomic | account_capital_to_realized_loss, get, get, kernel_settle_principal, new, record_account_residual_crystallized_loss, … |

#### Layer 3: Impaired-lien reconciliation

| Function | Lines | Status | Also | Callers in the closure | Callees in the closure |
| --- | --- | --- | --- | --- | --- |
| `V16Core::prepare_account_counterparty_lien_impairment` | 930–977 (48) | primitives | TCL | impair_account_source_credit_counterparty_lien_fields | crystallize_source_lien_fee_for_effective, get, new, new |
| `V16Core::prepare_counterparty_impaired_lien_retirement_delta` | 4092–4115 (24) | primitives | TCL | retire_source_credit_lien_from_counterparty_impaired_not_atomic | validate_bound_num_atom_aligned |
| `Group::release_or_retire_counterparty_lien_backing_not_atomic` | 10464–10487 (24) | primitives | TCL | burn_account_source_lien_face_not_atomic | backing_bucket_for_domain, expire_source_backing_bucket_not_atomic, get, release_source_credit_lien_from_counterparty_terminal_not_atomic, … |
| `Group::retire_source_credit_lien_from_counterparty_impaired_not_atomic` | 10489–10518 (30) | primitives | TCL | reconcile_account_impaired_counterparty_lien_at_slot_not_atomic, release_or_retire_counterparty_lien_backing_not_atomic | backing_bucket_for_domain, domain_asset_side, get, insurance_reservation_for_domain, new, prepare_counterparty_impaired_lien_retirement_delta, … |
| `Group::burn_impaired_account_source_claim_fields` | 11146–11193 (48) | primitives | TCL | burn_account_source_claim_at_slot_up_to | amount_from_bound_num, get, new |
| `Group::impair_account_source_credit_counterparty_lien_fields` | 11195–11208 (14) | primitives | TCL | reconcile_account_impaired_counterparty_lien_at_slot_not_atomic | prepare_account_counterparty_lien_impairment, source_domain_slot, source_domain_slot |
| `Group::reconcile_account_impaired_counterparty_liens_not_atomic` | 15247–15268 (22) | primitives | TCL | settle_account_kf_effects_not_atomic | get, has_default_sparse_tag, is_occupied, reconcile_account_impaired_counterparty_lien_at_slot_not_atomic |
| `Group::reconcile_account_impaired_counterparty_lien_at_slot_not_atomic` | 15282–15328 (47) | primitives | TCL | burn_account_source_claim_at_slot_up_to, reconcile_account_impaired_counterparty_liens_not_atomic | backing_bucket_for_domain, backing_bucket_raw_status_expiry_for_domain, collect_account_backing_utilization_fee_for_domain_not_atomic, … |

#### Layer 4: Source-claim burns and the PnL setters

| Function | Lines | Status | Also | Callers in the closure | Callees in the closure |
| --- | --- | --- | --- | --- | --- |
| `Group::decrement_account_source_claim_for_domain_not_atomic` | 11324–11357 (34) | settlement | TCL | burn_account_source_claim_at_slot_up_to, burn_account_source_lien_face_not_atomic, cancel_loss_domain_face_at_par_not_atomic, net_slot_face_at_par_not_atomic | get, new, recompute_source_credit_domain_after_mutation, reset_source_domain_slot_if_empty, set_source_credit_for_domain, source_credit_for_domain |
| `Group::burn_account_source_lien_face_not_atomic` | 11371–11529 (159) | settlement | TCL | burn_account_source_claim_at_slot_up_to | backing_bucket_for_domain, collect_account_backing_utilization_fee_for_domain_not_atomic, consume_source_credit_lien_from_counterparty_core_not_atomic, … |
| `Group::burn_account_source_claim_bound_num` | 11603–11648 (46) | settlement | TCL | burn_account_source_claim_bound_num_domain_first, set_account_pnl_inner | account_source_claim_bound_sum_num, as_view, as_view, burn_account_source_claim_at_slot_up_to, compact_source_domains, domain_asset_side, get, … |
| `Group::burn_account_source_claim_at_slot_up_to` | 11650–11732 (83) | settlement | TCL | burn_account_source_claim_bound_num, burn_account_source_claim_bound_num_domain_first | as_view, as_view, bound_num_from_amount, burn_account_source_lien_face_not_atomic, burn_impaired_account_source_claim_fields, decode_market_mode, … |
| `Group::burn_account_source_claim_bound_num_domain_first` | 11734–11764 (31) | settlement | TCL | set_account_pnl_after_domain_first_source_claim_burn | burn_account_source_claim_at_slot_up_to, burn_account_source_claim_bound_num, compact_source_domains, domain_asset_side, get, … |
| `Group::source_domain_prospective_support_for_face` | 11772–11801 (30) | settlement | TCL | apply_signed_kf_delta_to_pnl | available_backing_num_for_source_credit_state, backing_bucket_for_domain, bound_num_from_amount, get, mul_div_floor_u128_or_wide, source_credit_for_domain, … |
| `Group::consume_source_domain_credit_for_effective_not_atomic` | 12693–12737 (45) | settlement | TCL | apply_signed_kf_delta_to_pnl | amount_from_bound_num, backing_bucket_for_domain, create_and_consume_source_credit_from_counterparty_core_not_atomic, … |
| `Group::consume_validated_account_source_credit_not_atomic` | 13085–13255 (171) | settlement | TCL | apply_haircut_bounded_close_loss_to_pnl | amount_from_bound_num, backing_bucket_for_domain, backing_bucket_raw_status_expiry_for_domain, compact_source_domains, … |
| `Group::set_account_pnl` | 13692–13698 (7) | settlement | TCL | apply_haircut_bounded_close_loss_to_pnl, apply_signed_kf_delta_to_pnl, reserve_new_capital_backed_loss_for_source_domain_not_atomic | set_account_pnl_inner |
| `Group::set_account_pnl_with_source` | 13713–13721 (9) | settlement | TCL | apply_signed_kf_delta_to_pnl | domain_asset_side, set_account_pnl_inner |
| `Group::set_account_pnl_after_source_claim_burn` | 13723–13730 (8) | settlement | TCL | set_account_pnl_after_domain_first_source_claim_burn, settle_kf_loss_before_support_not_atomic | set_account_pnl_inner |
| `Group::set_account_pnl_after_kf_loss_claim_burn` | 13735–13743 (9) | settlement | TCL | apply_haircut_bounded_close_loss_to_pnl | set_account_pnl_inner |
| `Group::set_account_pnl_after_domain_first_source_claim_burn` | 13745–13763 (19) | settlement | TCL | settle_account_b_chunk | bound_num_from_amount, burn_account_source_claim_bound_num_domain_first, get, set_account_pnl_after_source_claim_burn |
| `Group::set_account_pnl_inner` | 13798–13929 (132) | settlement | TCL | set_account_pnl, set_account_pnl_after_kf_loss_claim_burn, set_account_pnl_after_source_claim_burn, set_account_pnl_with_source | amount_from_bound_num, bound_num_from_amount, burn_account_source_claim_bound_num, decode_market_mode, ensure_account_source_claim_market_id, get, get, get, … |

#### Layer 5: K/F settlement entries

| Function | Lines | Status | Also | Callers in the closure | Callees in the closure |
| --- | --- | --- | --- | --- | --- |
| `Group::record_account_funding_flow` | 13557–13596 (40) | settlement | TCL | apply_account_kf_settlement_entry | add_account_u128_counter |
| `Group::settle_kf_loss_before_support_not_atomic` | 13982–14127 (146) | settlement | TCL | apply_account_kf_settlement_entry | add_loser_paid_counterparty_backing_payments_unchecked, backing_bucket_for_domain, compact_source_domains, decode_market_mode, domain_asset_side, get, get, … |
| `Group::net_slot_face_at_par_not_atomic` | 14157–14295 (139) | settlement | TCL | settle_kf_loss_before_support_not_atomic | available_backing_num_for_source_credit_state, backing_bucket_for_domain, bound_num_from_amount, cancel_loss_domain_face_at_par_not_atomic, … |
| `Group::cancel_loss_domain_face_at_par_not_atomic` | 14310–14336 (27) | settlement | TCL | net_slot_face_at_par_not_atomic | backing_bucket_raw_status_expiry_for_domain, bound_num_from_amount, decrement_account_source_claim_for_domain_not_atomic, encode_backing_bucket_status, get, … |
| `Group::pay_kf_loss_from_free_capital_not_atomic` | 14391–14438 (48) | settlement | TCL | settle_kf_loss_before_support_not_atomic | account_capital_to_realized_loss, fresh_counterparty_backing_expiry_slot, get, new, record_account_residual_crystallized_loss, validate, validate, validate |
| `Group::apply_haircut_bounded_close_loss_to_pnl` | 14445–14553 (109) | settlement | TCL | apply_account_kf_settlement_entry, apply_signed_kf_delta_to_pnl | account_has_source_claims, as_view, as_view, consume_validated_account_source_credit_not_atomic, decode_market_mode, face_claim_to_burn_for_support, get, … |
| `Group::apply_signed_kf_delta_to_pnl` | 14555–14673 (119) | settlement | TCL | apply_account_kf_settlement_entry | apply_haircut_bounded_close_loss_to_pnl, consume_source_domain_credit_for_effective_not_atomic, decode_market_mode, face_claim_to_burn_for_support, get, … |
| `Group::reserve_new_capital_backed_loss_for_source_domain_not_atomic` | 14675–14728 (54) | settlement | TCL | apply_account_kf_settlement_entry | account_capital_to_realized_loss, book_realized_kf_loss_for_source_domain_not_atomic, credit_post_snapshot_residual_not_atomic, domain_asset_side, get, get, … |
| `Group::book_kf_loss_support_for_source_domain_not_atomic` | 14745–14755 (11) | settlement | TCL | apply_account_kf_settlement_entry | book_realized_kf_loss_for_source_domain_not_atomic, decode_bool |
| `Group::book_realized_kf_loss_for_source_domain_not_atomic` | 14772–14880 (109) | settlement | TCL | book_kf_loss_support_for_source_domain_not_atomic, reserve_new_capital_backed_loss_for_source_domain_not_atomic | add_loser_paid_counterparty_backing_unchecked, amount_from_bound_num, asset_state, backing_bucket_for_domain, backing_bucket_raw_status_expiry_for_domain, … |
| `Group::prepare_account_kf_settlement_entry` | 15098–15150 (53) | settlement | TCL | settle_account_kf_effects_not_atomic | account_kf_settlement_plan_key, asset_state, begin_full_drain_reset_inner, get, get, get, get, get, has_pending_domain_loss_barrier, has_pending_residual, … |
| `Group::apply_account_kf_settlement_entry` | 15152–15240 (89) | settlement | TCL | settle_account_kf_effects_not_atomic | apply_haircut_bounded_close_loss_to_pnl, apply_signed_kf_delta_to_pnl, asset_is_loss_stale_at_slot, asset_state, … |
| `Group::begin_full_drain_reset_inner` | 19192–19207 (16) | settlement | TCL | prepare_account_kf_settlement_entry | asset_state, get, has_pending_domain_loss_barrier, kernel_begin_full_drain_reset, new, set_asset_state, validate_configured_asset_index |

#### Layer 6: B chunks

| Function | Lines | Status | Also | Callers in the closure | Callees in the closure |
| --- | --- | --- | --- | --- | --- |
| `Group::b_target_for_leg` | 14992–15000 (9) | settlement | MTCL | account_b_settlement_chunk, settle_account_side_effects_not_atomic | b_target_for_leg_from_asset, get, get, get, get, get, try_to_runtime |
| `Group::mark_account_b_stale` | 15713–15726 (14) | settlement | TCL | mark_leg_b_stale, settle_account_b_chunk | decode_bool, get, new |
| `Group::clear_account_b_stale` | 15728–15743 (16) | settlement | TCL | settle_account_b_chunk | as_view, as_view, decode_bool, get, has_b_stale_leg, new |
| `Group::mark_leg_b_stale` | 15852–15862 (11) | settlement | TCL | settle_account_side_effects_not_atomic | as_view, as_view, from_runtime, mark_account_b_stale, require_active_leg_slot_for_asset, try_to_runtime |
| `Group::account_b_settlement_chunk` | 15921–15937 (17) | settlement | TCL | settle_account_b_chunk | account_b_settlement_chunk_from_leg, active_leg_for_asset, as_view, b_target_for_leg, validate_with_market, validate_with_market |
| `Group::settle_account_b_chunk` | 15939–15980 (42) | settlement | TCL | settle_account_side_effects_not_atomic | account_b_settlement_chunk, as_view, as_view, clear_account_b_stale, from_runtime, get, has_b_stale_leg, insurance_domain_index, kernel_advance_leg_b_snap, … |

#### Layer 7: The side-effects driver

| Function | Lines | Status | Also | Callers in the closure | Callees in the closure |
| --- | --- | --- | --- | --- | --- |
| `Group::settle_account_kf_effects_not_atomic` | 15330–15385 (56) | settlement | TCL | settle_account_side_effects_not_atomic | active_bitmap_count_ones, active_bitmap_get, apply_account_kf_settlement_entry, prepare_account_kf_settlement_entry, … |
| `Group::settle_account_side_effects_not_atomic` | 15982–16012 (31) | settlement | CL | – | as_view, b_target_for_leg, mark_leg_b_stale, settle_account_b_chunk, settle_account_kf_effects_not_atomic, … |

## 11. Margin and health certificates, ConvertReleasedPnl and Withdraw: the map

`settlement-map.py <v16.rs> --margin` follows the calls from three roots as section 10 does from the settlement:
`compute_account_health_cert_with_price_override` (15401; the margin and health certificate: initial and maintenance
requirements per leg and for the portfolio, the haircut equity, the realizable source support, the target-effective
lag penalty), `convert_released_pnl_to_capital_not_atomic` (20846; ConvertReleasedPnl's engine call) and
`withdraw_not_atomic` (21219). Of the 244 functions they reach, 211 were ported before (the settlement's closure,
section 10, and Withdraw's own code in refresh.ts); the 33 below (764 lines) were new, and all are now ported, with
TradeNoCpi and ConvertReleasedPnl (health.ts, convert.ts; section 12: the script's `--margin` table is empty now).
Height is the call height inside this set (0 calls none of the others).

What reading these showed:

- **Withdraw with open legs.** `withdraw_not_atomic` returns `Ok(())` for an amount of 0, validates, refuses a market
  that is not Live (LockActive), then refuses any portfolio whose active bitmap is not empty (Stale) before anything
  else, and the program calls it from one place (`handle_withdraw`, src/v16_program.rs 8127). No health certificate is
  computed or read on the way, so no state lets a portfolio with an open leg withdraw: the only Withdraw that moves
  tokens for a portfolio that had legs is the one whose maintenance-fee sync settled them all away first (compared:
  TESTING.md, "The settlement of open legs against the reference binary"). The port does the same (refresh.ts
  `withdrawEngine`). Withdraw also clears the stored certificate (`health_cert.valid = 0`).
- **Who computes a certificate.** `compute_account_health_cert_with_price_override` is called only by
  `certify_account_after_local_settlement_with_price_override` (16014) and `recertify_account_after_trade_delta`
  (19714), which are reached from the trade paths (`apply_trade_after_refresh_not_atomic`,
  `execute_batch_with_fee_after_tail_validation_not_atomic`), liquidation (`liquidate_account_not_atomic`),
  `rebalance_reduce_position_not_atomic` and `release_account_source_credit_liens_if_unneeded_core_not_atomic` (the
  crank's). TradeNoCpi reaches `recertify_account_after_trade_delta` (a single request recertifies after its fill;
  `certify_account_after_local_settlement_…` is the batch's), so the certificate is compared with the reference binary
  through it (section 12).
- **ConvertReleasedPnl reads a certificate, it does not compute one.** Its handler (src/v16_program.rs 11642) refuses an
  amount of 0 (InvalidInstruction), takes the portfolio through `with_one_portfolio_view` (owner signer, ids, position
  epoch), refuses a market that is not Live or whose permissionless resolution has matured (LockActive), runs
  `reject_lapsed_source_backing_for_conversion_view`, then the engine's conversion, and refuses a result of 0 or above
  the amount (LockActive). The engine's preflight (`preflight_convert_released_pnl_to_capital`, 20662) refuses a
  market not Live or with a captured payout snapshot (LockActive), then `ensure_favorable_action_allowed` (17878)
  validates the portfolio, refuses the H-lock lane HMax (LockActive), requires the stored certificate to be current
  (`kernel_cert_is_current`: valid, the four epochs and the active bitmap equal to the market's; else Stale, whatever
  the flags) and refuses a target-effective lag (LockActive). A certificate never written is not current (`valid` is
  0); a success needs a certificate written by a trade (or the crank, ported since): the real-state walk converts right
  after a close, whose recertification is current (TESTING.md). The
  conversion itself (20674) converts nothing in a Live market unless the portfolio holds source claims (then up to
  their realizable support), and refuses claims with liens or active exposure (LockActive). No tokens move (capital
  and PnL change inside the two accounts).

#### Margin, health certificates, ConvertReleasedPnl and Withdraw: 244 functions reached, 211 ported, 33 new (764 lines)

| Height | Function | Lines | Reached from |
| ---: | --- | --- | --- |
| 0 | `V16Core::kernel_released_pnl_conversion_partition` | 1973–1987 (15) | convert |
| 0 | `V16Core::kernel_adl_effective_quantity_ceil` | 2197–2209 (13) | health |
| 0 | `V16Core::kernel_is_prior_reset_obligation` | 2465–2471 (7) | health |
| 0 | `V16Core::kernel_cert_is_current` | 2656–2670 (15) | convert |
| 0 | `V16Core::target_effective_lag_adverse_delta` | 4359–4373 (15) | health |
| 0 | `V16Core::health_requirements_from_base_and_target_lag` | 4408–4425 (18) | health |
| 0 | `TokenValueFlowProofV16::support_to_account_capital` | 7033–7063 (31) | convert |
| 0 | `Group::account_has_source_liens` | 11075–11088 (14) | convert |
| 0 | `Group::source_lien_effective_reserved_supporting` | 11919–11944 (26) | health, convert |
| 0 | `Group::account_has_active_exposure_for_source_domain` | 17890–17898 (9) | convert |
| 0 | `Group::account_touches_pending_domain_loss_barrier` | 17945–17960 (16) | convert |
| 0 | `Group::asset_has_target_effective_lag` | 18063–18066 (4) | convert |
| 0 | `Group::asset_is_loss_stale` | 18068–18074 (7) | convert |
| 0 | `HealthCertV16Account::try_to_runtime` | 22856–22872 (17) | convert |
| 0 | `risk_notional_ceil` | 23211–23229 (19) | health |
| 0 | `margin_requirement` | 23284–23290 (7) | health |
| 1 | `V16Core::effective_abs_quantity_for_leg` | 2215–2237 (23) | health |
| 1 | `V16Core::target_effective_lag_loss_penalty` | 4348–4357 (10) | health |
| 1 | `V16Core::health_requirements_from_notional_and_target_lag` | 4375–4396 (22) | health |
| 1 | `Group::account_source_realizable_support` | 11803–11868 (66) | health, convert |
| 1 | `Group::ensure_favorable_action_current_certificate` | 17847–17864 (18) | convert |
| 1 | `Group::account_has_target_effective_lag` | 17866–17876 (11) | convert |
| 1 | `Group::account_has_active_source_claim_exposure` | 17900–17921 (22) | convert |
| 1 | `Group::account_has_loss_stale_live_leg` | 18076–18092 (17) | convert |
| 1 | `Group::apply_released_pnl_conversion_with_consumption_core_not_atomic` | 20750–20844 (95) | convert |
| 2 | `Group::account_haircut_equity` | 13477–13501 (25) | health |
| 2 | `Group::h_lock_lane` | 18026–18061 (36) | convert |
| 2 | `Group::apply_released_pnl_conversion_core_not_atomic` | 20710–20748 (39) | convert |
| 3 | `Group::compute_account_health_cert_with_price_override` | 15401–15475 (75) | health |
| 3 | `Group::ensure_favorable_action_allowed` | 17878–17888 (11) | convert |
| 3 | `Group::convert_released_pnl_to_capital_core_not_atomic` | 20674–20708 (35) | convert |
| 4 | `Group::preflight_convert_released_pnl_to_capital` | 20662–20672 (11) | convert |
| 5 | `Group::convert_released_pnl_to_capital_not_atomic` | 20846–20860 (15) | convert |

| Height | Functions | Lines |
| ---: | ---: | ---: |
| 0 | 16 | 233 |
| 1 | 9 | 284 |
| 2 | 3 | 100 |
| 3 | 3 | 121 |
| 4 | 1 | 11 |
| 5 | 1 | 15 |

## 12. TradeNoCpi and ConvertReleasedPnl

`settlement-map.py <v16.rs> --trade <v16_program.rs>` maps what TradeNoCpi reaches: first the processor's closure of
`handle_trade_nocpi` in src/v16_program.rs (its inline modules `state`, `policy_v16`, `oracle_v16` resolved as free
functions of the one file), with the engine entry points each function calls; then the engine's closure of those entry
points (`execute_trade_with_fee_loss_stale_scoped_not_atomic`, `accrue_asset_path_to_not_atomic`,
`charge_account_backing_fee_not_atomic`, `credit_domain_insurance_budget_not_atomic`,
`set_asset_raw_oracle_target_not_atomic`, `sync_account_fee_to_slot_not_atomic`, the views' `validate_shape` and
`as_view`) less what earlier instructions ported. Its tables are below; the totals:

- **The processor**: 127 functions, 2,758 lines (each function's lines from `fn` to its closing brace), of which 126 are
  in trading.ts or were ported before (the account checks, the market and portfolio views, the configs' validation, the
  oracle profile's accessors, the funding-mark checkpoint, the maintenance fee's collection). The one left then,
  `bump_portfolio_position_epoch_after_matcher_fill`, is TradeCpi's (`account_b_matcher_synchronized` is false for
  TradeNoCpi), ported with it (section 16).
- **The engine**: 420 functions reached, 293 ported before (the settlement's closure, the accrual, the fee sync and
  charge, the insurance credits, the stored-target setter), 127 new (3,645 lines): 117 ported (3,429 lines, health.ts
  and trade.ts, `accrue_asset_path_to_not_atomic` and the backing-fee charge in trading.ts), 4 in place (the token-value
  proof a fee charge forms, which balances by construction; the audit scan, `Ok` in the program's build; the batch's
  accumulation of its one fill, which changes nothing a single trade reads), and 6 that TradeNoCpi does not reach: the
  closure follows `refresh_account_and_certify_not_atomic` into its `allow_b_chunk` branch (the lapsed-backing scan
  and expiry, `first_lapsed_*`, `kernel_lapsed_source_backing_scan_step`), which only the crank takes, and the batch's
  `certify_account_after_local_settlement_with_price_override` (a single request recertifies after its fill). The six
  are ported with the crank (section 13: health.ts `refreshAndCertify` with the price override and the B chunk, the
  lapsed-backing scans, liquidation.ts `certifyAfterLocalSettlement`).
- **Shared**: of the 127 new engine functions, 121 are reached by BatchTradeNoCpi as well (and through it by TradeCpi and
  BatchTradeCpi), 69 by liquidation and 73 by the crank. The health certificate's closure (section 11) is all ported.
- **ConvertReleasedPnl** (convert.ts): `handle_convert_released_pnl` in `with_one_portfolio_view`,
  `reject_lapsed_source_backing_for_conversion_view` and the 12 engine functions of section 11's "convert" rows.

What reading the sources showed (the scope report's facts confirmed: trades read no oracle account; TradeNoCpi's
accounts are signer A, signer B, market, portfolio A, portfolio B):

- **No sequence or expiry.** TradeNoCpi binds each portfolio by its id and position epoch (EngineProvenanceMismatch,
  EngineStale) and advances both epochs after the fill (`bump_portfolio_position_epoch`, which also disables the
  portfolio's matcher and zeroes its expiry). The matcher sequence is TradeCpi's.
- **The order of the checks.** The outer handler: five accounts, both signers, the three writable, the three the
  program's, the portfolios distinct (InvalidInstruction), both bindings, the reported price (OracleInvalid), the
  market's config and a Live mode (EngineLockActive), the signed fee at least the policy's base fee and the backing cap
  at most 10,000 (InvalidInstruction). Then the zero-copy handler: both portfolios' storage, the market view, the asset
  and its market id (AssetGenerationMismatch), its oracle profile, a matured permissionless resolution (OracleStale),
  the bindings again, both portfolio views, their account ids and owners (Unauthorized), the size (InvalidInstruction
  for 0 and i128::MIN), both positions, the zero-move funding accrual, the accepted print, the fee quote, the
  stale-portfolio guard (portfolios of 8 legs or more), both maintenance fees, the source-domain admission, the engine's
  trade, the side-OI cap, new counterparty liens fresh, the backing-domain fees, the fee credits, the post-trade mark,
  the staged target, the profile's write-back, the shape, the lien bounds, the epochs, the config's write-back.
- **The engine's order**: the market's dynamic slots; the loss-stale scope; Live; the request (InvalidConfig: an asset
  not configured, a size of 0 or above 10^14, a price of 0 or above 10^12, a fee above the market's maximum); each
  account's attributable terminal asset; each account refreshed and certified for the position action unless its
  certificate is current; the H-lock lane; the position plans; the preflight (the pre-existing OI reduction gate, the
  target lag, the domain barriers, LockActive for growth on a loss-stale or lagging asset); the risk-change gate (both A
  indices at one, Active, both sides Normal); the fee (⌈notional · bps / 10,000⌉ on the ceiling notional) charged from
  each account's capital into the insurance; the terminal close ledger; both position deltas (attach, clear, flip,
  resize, an obligation retained on a barrier side); the side-OI cap on the net fill; the residual reward credit; both
  certificates recertified (by delta at the effective price, or whole when the asset's target lags); the initial-margin
  source liens; the initial margin (InvalidConfig below it, Stale for an invalid certificate) and, in the locked lane,
  the no-positive-credit margin (LockActive); the zero-OI residue resets.
- **The price never moves in a trade.** The zero-move funding path accepts only a path on which the price stays put
  (`zero_move_funding_path_for_profile_view` returns None for any step that moves it), so a trade accrues funding but
  never a price move; the accrual's price-move branch is reached only by the crank (ported since: section 13). Without the crank, an
  asset with open interest becomes loss-stale as soon as the market's clock passes its slot (any accrual or anchor reset
  of another asset moves the clock), and a risk-increasing trade on it is LockActive until a zero-move path or a crank
  brings it up to date; a stored target away from the effective price (a pushed mark) is a target lag, which blocks
  growth the same way. Reductions pass. The real-state walk (TESTING.md) is built around this.

Copies and swallowed errors, function by function (each caller of each, read in the sources):

| Function | What the original does | Finding |
| --- | --- | --- |
| `handle_trade_nocpi_zero_copy` | reads the wrapper config into `cfg` (`market_view_mut_with_fee_carry`) and, for a price-managed asset 0, writes three mark fields of it back at the very end (`write_wrapper_config`: the header, `validate_wrapper_config`, the carry byte preserved) | in place: nothing writes the config's bytes in between but the carry (which the write-back keeps); the port sets the three fields and validates the config at the same point, last |
| `handle_trade_nocpi_zero_copy` | reads the asset's oracle profile into `oracle_profile`, changes it (the funding-mark checkpoint, the zero-move simulation's result, the post-trade mark, the staged target, the remainder) and writes it back validated before the shape check | in place: the only read of the profile's bytes in between is `backing_fee_policy_for_domain_view`, which reads the backing-fee fields the trade never changes; every failure in between fails the transaction |
| `zero_move_funding_path_for_profile_view`, `canonical_accrual_path_for_target_view` | simulate on a copy (`simulated_profile`), kept only when the path is accepted; every error of the simulation becomes InvalidConfig (`.map_err(|_| V16Error::InvalidConfig)`) | a real copy (a local `AssetOracleProfile`, 424 bytes) in the port; each refusal inside it is InvalidConfig |
| `execute_batch_with_fee_loss_stale_scoped_not_atomic` | clears `loss_stale_active` for a scoped trade, runs the trade, restores the old flag whatever the result, then propagates the result | the port restores it after a success; a failure fails the transaction |
| `settle_account_for_position_action_and_refresh_not_atomic` | `ensure_favorable_action_current_certificate(…).is_ok()` | read-only (section 1, site 7) |
| `account_has_active_source_claim_exposure` | `domain_asset_side(d).is_ok()` | read-only |
| `apply_position_delta_with_lookup_inner`, `clear_leg_at_slot_inner` | write the leg's F snapshot, or the liquidation lock and the certificate's validity, before later checks; legs and asset states by value written back after the kernels (`set_asset_state` restores the old asset on a blocker overflow) | every caller propagates: in place |
| the source-domain snapshots, the fee totals, the accrual steps | boxed slices and `Vec`s on the heap | fixed local arrays of 32 (no heap there; the port's heap use is section 18); the original's allocations are within its 256 KiB heap (at most 32 entries of 32 bytes each, six snapshots, the fee totals and 32 accrual steps) |
| `handle_convert_released_pnl` | converts in place, then refuses a result of 0 or above the caller's amount (LockActive) | the transaction fails, as the original's comment intends ("staging the conversion and only committing it when the converted amount fits") |

**Repeated accounts.** TradeNoCpi borrows the market and both portfolios at once: the same portfolio twice is refused
before any borrow (InvalidInstruction), a portfolio that is the market fails its portfolio header check (the binding's
`check_header`) before the market is borrowed, and the signers are only read. Every ordered pair of the five positions
is compared (TESTING.md). ConvertReleasedPnl borrows the market and one portfolio (the portfolio as the market fails its
header check first).

#### TradeNoCpi: the processor's and the engine's closures (output of `settlement-map.py --trade`)

##### The processor: 127 functions reached (2758 lines), 126 ported

| Height | Function | Lines | Engine calls | Status |
| ---: | --- | --- | --- | --- |
| 0 | `PortfolioMatcherConfigV16::position_epoch` | 795–797 (3) | – | ported |
| 0 | `PortfolioMatcherConfigV16::trade_fee_cap_bps` | 800–802 (3) | – | ported |
| 0 | `read_u16` | 867–874, 4618–4625 (16) | – | ported |
| 0 | `read_u64` | 877–884, 4609–4616 (16) | – | ported |
| 0 | `backing_trade_fee_policy_shape_ok` | 1512–1519 (8) | – | ported |
| 0 | `valid_engine_oracle_price` | 1522–1524 (3) | – | ported |
| 0 | `MaintenanceFeeSplitCarry::split` | 1738–1745 (8) | – | ported |
| 0 | `portfolio_account_len_for_market_slots` | 1784–1792 (9) | – | ported |
| 0 | `market_slot_capacity` | 1795–1803 (9) | – | ported |
| 0 | `market_group_view_from_state` | 2025–2047 (23) | – | ported |
| 0 | `market_header` | 2124–2132 (9) | – | ported |
| 0 | `decode_market_mode` | 2188–2195 (8) | – | ported |
| 0 | `profile_is_hybrid` | 4888–4890 (3) | – | ported |
| 0 | `profile_is_ewma_mark` | 4892–4894 (3) | – | ported |
| 0 | `profile_is_auth_mark` | 4896–4898 (3) | – | ported |
| 0 | `permissionless_stale_matured` | 4925–4929 (5) | – | ported |
| 0 | `clamp_toward_engine_dt` | 5540–5557 (18) | – | ported |
| 0 | `mul_div_u128_by_u64` | 5577–5594 (18) | – | ported |
| 0 | `account_fees_to_trade_sides` | 5598–5610 (13) | – | ported |
| 0 | `ceil_div_u128` | 5685–5690 (6) | – | ported |
| 0 | `price_move_bps_ceil` | 5777–5785 (9) | – | ported |
| 0 | `premium_funding_rate_e9` | 5829–5847 (19) | – | ported |
| 0 | `ewma_effective_alpha_bps` | 5853–5859 (7) | – | ported |
| 0 | `ensure_valid_reported_trade_price` | 5978–5983 (6) | – | ported |
| 0 | `authenticated_market_slot_or_fallback_view` | 5989–5996 (8) | – | ported |
| 0 | `permissionless_resolve_matured_for_profile_at_slot` | 6016–6024 (9) | – | ported |
| 0 | `credit_market_insurance_budget_view` | 6616–6634 (19) | credit_domain_insurance_budget_not_atomic | ported |
| 0 | `trade_fee_budgeted_amounts_with_mark_externality_view` | 6754–6807 (54) | – | ported |
| 0 | `source_credit_has_live_amounts` | 8968–8979 (12) | – | ported |
| 0 | `sparse_domain_value_lookup` | 9065–9074 (10) | – | ported |
| 0 | `source_lien_effective_reserved_snapshot_for_trade_view` | 9076–9086 (11) | – | ported |
| 0 | `SourceDomainAdmissionSnapshot::contains` | 9094–9103 (10) | – | ported |
| 0 | `trade_delta_may_require_source_domain_capacity` | 9190–9204 (15) | – | ported |
| 0 | `ensure_source_domain_growth_within_wrapper_bound` | 9206–9215 (10) | – | ported |
| 0 | `source_lien_refresh_work_view` | 9220–9234 (15) | – | ported |
| 0 | `ensure_source_lien_refresh_work_within_wrapper_bound` | 9238–9247 (10) | – | ported |
| 0 | `backing_domain_parts_view` | 10379–10398 (20) | – | ported |
| 0 | `account` | 14643–14648 (6) | – | ported |
| 0 | `expect_signer` | 14650–14655 (6) | – | ported |
| 0 | `expect_writable` | 14657–14662 (6) | – | ported |
| 0 | `expect_owner` | 14664–14669 (6) | – | ported |
| 0 | `expect_portfolio_view_owner` | 14702–14710 (9) | – | ported |
| 0 | `expect_portfolio_view_account_key` | 14712–14725 (14) | – | ported |
| 0 | `portfolio_has_active_asset_view` | 14872–14896 (25) | – | ported |
| 0 | `signed_position_for_asset_view` | 14898–14921 (24) | – | ported |
| 0 | `ensure_trade_side_oi_cap_view` | 14981–14998 (18) | – | ported |
| 0 | `trade_delta_reduces_existing` | 15014–15016 (3) | – | ported |
| 0 | `source_counterparty_backing_snapshot_view` | 15200–15213 (14) | – | ported |
| 0 | `domain_fee_add` | 15215–15238 (24) | – | ported |
| 0 | `charge_account_backing_domain_fees_view` | 15313–15331 (19) | charge_account_backing_fee_not_atomic | ported |
| 0 | `asset_segment_dt_view` | 15470–15483 (14) | – | ported |
| 0 | `price_move_remainder_bps_num_view` | 15815–15817 (3) | – | ported |
| 0 | `set_price_move_remainder_bps_num_view` | 15819–15828 (10) | – | ported |
| 0 | `advance_funding_mark_checkpoint_view` | 16204–16225 (22) | – | ported |
| 0 | `amount_to_u64` | 16431–16433 (3) | – | ported |
| 1 | `PortfolioMatcherConfigV16::validate` | 823–828 (6) | – | ported |
| 1 | `check_header` | 901–915 (15) | – | ported |
| 1 | `validate_wrapper_config` | 1408–1509 (102) | – | ported |
| 1 | `validate_asset_oracle_profile` | 1527–1627 (101) | – | ported |
| 1 | `validate_market_dynamic_len` | 1806–1813 (8) | – | ported |
| 1 | `profile_is_price_managed` | 4900–4902 (3) | – | ported |
| 1 | `profile_hybrid_soft_stale_matured` | 4911–4919 (9) | – | ported |
| 1 | `effective_price_from_target` | 5559–5571 (13) | – | ported |
| 1 | `fee_share_floor` | 5651–5656 (6) | – | ported |
| 1 | `risk_notional_ceil` | 5674–5676 (3) | – | ported |
| 1 | `two_sided_trade_fee_paid` | 5692–5698 (7) | – | ported |
| 1 | `clamp_mark_to_supported_move_bps` | 5816–5827 (12) | – | ported |
| 1 | `ewma_update` | 5861–5896 (36) | – | ported |
| 1 | `credit_maintenance_fee_to_active_market_budgets_view` | 6912–6942 (31) | credit_domain_insurance_budget_not_atomic | ported |
| 1 | `ensure_source_credit_full_rate_for_domain_view` | 8981–9006 (26) | – | ported |
| 1 | `ensure_new_counterparty_backed_liens_fresh_for_trade_view` | 9031–9061 (31) | – | ported |
| 1 | `SourceDomainAdmissionSnapshot::push_reserved` | 9105–9118 (14) | – | ported |
| 1 | `MarketAuthorityPolicyUpdate::validate` | 13161–13175 (15) | – | ported |
| 1 | `ensure_trade_portfolio_current_for_requests_view` | 14923–14979 (57) | – | ported |
| 1 | `ensure_portfolio_storage_for_market_slots` | 15115–15127 (13) | – | ported |
| 1 | `record_funding_mark_transition_view` | 16227–16257 (31) | – | ported |
| 1 | `reset_price_move_remainder_on_target_change_view` | 16292–16308 (17) | – | ported |
| 2 | `read_portfolio_id` | 1002–1009 (8) | – | ported |
| 2 | `write_portfolio_matcher_expiry` | 1081–1093 (13) | – | ported |
| 2 | `read_portfolio_position_epoch` | 1181–1190 (10) | – | ported |
| 2 | `next_portfolio_position_control` | 1193–1209 (17) | – | ported |
| 2 | `read_wrapper_config_from_bytes` | 1378–1385 (8) | – | ported |
| 2 | `write_wrapper_config_to_bytes` | 1711–1725 (15) | – | ported |
| 2 | `portfolio_view_mut_for_market_slots` | 2653–2672 (20) | – | ported |
| 2 | `trade_fee_notional_ceil` | 5678–5683 (6) | – | ported |
| 2 | `fee_bps_for_two_sided_fee_paid` | 5700–5729 (30) | – | ported |
| 2 | `collected_fee_supported_mark` | 5787–5814 (28) | – | ported |
| 2 | `global_or_profile_resolve_matured_at_slot` | 6026–6034 (9) | – | ported |
| 2 | `read_oracle_profile_from_view` | 6260–6277 (18) | – | ported |
| 2 | `write_oracle_profile_to_view` | 6305–6318 (14) | – | ported |
| 2 | `credit_fee_to_domain_budget_view` | 6717–6740 (24) | credit_domain_insurance_budget_not_atomic | ported |
| 2 | `collect_maintenance_fee_to_slot_before_value_debit_view` | 6948–6963 (16) | sync_account_fee_to_slot_not_atomic | ported |
| 2 | `ensure_new_source_lien_domains_full_rate_for_trade_view` | 9008–9029 (22) | – | ported |
| 2 | `reserved_source_domains_snapshot_for_trade_view` | 9121–9165 (45) | – | ported |
| 2 | `ensure_trade_delta_source_domain_capacity_view` | 9167–9188 (22) | – | ported |
| 2 | `ensure_trade_portfolios_current_for_requests_view` | 15000–15008 (9) | – | ported |
| 2 | `profile_updates_mark_from_trade_view` | 15493–15500 (8) | – | ported |
| 2 | `funding_rate_from_checkpoint_view` | 15776–15813 (38) | – | ported |
| 2 | `stored_mark_target_for_zero_move_accrual_view` | 15994–16019 (26) | – | ported |
| 2 | `pending_zero_move_funding_requires_crank_view` | 16066–16107 (42) | – | ported |
| 3 | `next_portfolio_position_control_for_matcher_sync` | 1212–1221 (10) | – | ported |
| 3 | `market_view_mut_with_fee_carry` | 1750–1770 (21) | – | ported |
| 3 | `read_market_config_mode_and_capacity` | 1937–1954 (18) | – | ported |
| 3 | `write_wrapper_config` | 1990–1996 (7) | – | ported |
| 3 | `reject_permissionless_resolve_matured_live_for_profile_view` | 6046–6061 (16) | – | ported |
| 3 | `credit_trade_fees_to_market_budgets_view` | 6742–6751 (10) | – | ported |
| 3 | `collect_maintenance_fee_before_trade_view` | 6975–6983 (9) | – | ported |
| 3 | `expect_portfolio_id` | 14727–14732 (6) | – | ported |
| 3 | `backing_fee_policy_for_domain_view` | 15240–15259 (20) | – | ported |
| 3 | `accepted_reported_trade_price_view` | 15511–15548 (38) | – | ported |
| 3 | `hybrid_trade_fee_quote_view` | 15550–15685 (136) | – | ported |
| 3 | `collected_fee_supported_mark_view` | 15687–15702 (16) | – | ported |
| 3 | `canonical_accrual_path_for_target_view` | 15830–15958 (129) | – | ported |
| 3 | `update_hybrid_mark_after_trade_view` | 16259–16290 (32) | – | ported |
| 3 | `prepare_trade_driven_mark_target_view` | 16310–16341 (32) | – | ported |
| 4 | `bump_portfolio_position_epoch_with_matcher_state` | 1224–1239 (16) | – | ported |
| 4 | `credit_trade_fees_with_mark_externality_view` | 6810–6827 (18) | – | ported |
| 4 | `expect_portfolio_position_binding` | 14747–14757 (11) | – | ported |
| 4 | `collect_backing_domain_fees_for_account_view` | 15261–15311 (51) | – | ported |
| 4 | `zero_move_funding_path_for_profile_view` | 16021–16064 (44) | – | ported |
| 4 | `stage_trade_driven_mark_target_view` | 16343–16357 (15) | set_asset_raw_oracle_target_not_atomic | ported |
| 5 | `bump_portfolio_position_epoch` | 1242–1244 (3) | – | ported |
| 5 | `bump_portfolio_position_epoch_after_matcher_fill` | 1247–1251 (5) | – | ported with TradeCpi (section 16) |
| 5 | `apply_backing_domain_fees_after_trade_view` | 15333–15376 (44) | as_view, validate_shape | ported |
| 5 | `accrue_zero_move_funding_before_position_change_for_profile_view` | 16109–16145 (37) | accrue_asset_path_to_not_atomic | ported |
| 6 | `handle_trade_nocpi_zero_copy` | 8148–8427 (280) | execute_trade_with_fee_loss_stale_scoped_not_atomic, validate_shape | ported |
| 7 | `handle_trade_nocpi` | 8870–8945 (76) | – | ported |

| Height | Functions | Lines |
| ---: | ---: | ---: |
| 0 | 55 | 654 |
| 1 | 22 | 556 |
| 2 | 23 | 448 |
| 3 | 15 | 500 |
| 4 | 6 | 155 |
| 5 | 4 | 89 |
| 6 | 1 | 280 |
| 7 | 1 | 76 |

##### The engine: entry points validate_shape, accrue_asset_path_to_not_atomic, as_view, charge_account_backing_fee_not_atomic, credit_domain_insurance_budget_not_atomic, execute_trade_with_fee_loss_stale_scoped_not_atomic, set_asset_raw_oracle_target_not_atomic, sync_account_fee_to_slot_not_atomic, validate_shape; 420 functions reached, 293 ported, 127 new (3645 lines)

| Height | Function | Lines | Also | Status |
| ---: | --- | --- | --- | --- |
| 0 | `source_domain_capacity_after_admission` | 43–56 (14) | BLC | ported |
| 0 | `health_cert_after_capital_debit` | 149–168 (20) | – | ported |
| 0 | `active_bitmap_is_empty` | 251–260 (10) | BLC | ported |
| 0 | `active_bitmap_set` | 273–281 (9) | BLC | ported |
| 0 | `active_bitmap_clear` | 284–292 (9) | BLC | ported |
| 0 | `liquidation_uncovered_loss_after_principal` | 318–324 (7) | BLC | ported |
| 0 | `add_open_interest_for_new_position` | 622–671 (50) | BLC | ported |
| 0 | `V16Core::loss_stale_trade_scope_allowed` | 687–697 (11) | B | ported |
| 0 | `V16Core::kernel_initial_margin_gate` | 1665–1674 (10) | B | ported |
| 0 | `V16Core::kernel_locked_margin_gate` | 1692–1710 (19) | B | ported |
| 0 | `V16Core::kernel_accumulate_batch_trade` | 1729–1758 (30) | B | in place |
| 0 | `V16Core::kernel_classify_position_delta` | 2168–2178 (11) | BLC | ported |
| 0 | `V16Core::kernel_position_route_requires_unit_adl` | 2181–2191 (11) | BLC | ported |
| 0 | `V16Core::kernel_adl_effective_quantity_ceil` | 2197–2209 (13) | BLCM | ported |
| 0 | `V16Core::kernel_raw_basis_for_adl_effective_quantity` | 2243–2259 (17) | BLC | ported |
| 0 | `V16Core::kernel_trade_side_oi_cap_gate` | 2278–2292 (15) | B | ported |
| 0 | `V16Core::kernel_trade_preexisting_oi_reduction_gate` | 2296–2331 (36) | B | ported |
| 0 | `V16Core::kernel_is_prior_reset_obligation` | 2465–2471 (7) | BLCM | ported |
| 0 | `V16Core::kernel_should_clear_prior_reset_obligation` | 2503–2509 (7) | BLC | ported |
| 0 | `V16Core::build_trade_request_guard_summary` | 2625–2638 (14) | B | ported |
| 0 | `V16Core::kernel_cert_is_current` | 2656–2670 (15) | BC | ported |
| 0 | `V16Core::kernel_retain_leg_as_pending_obligation` | 3152–3193 (42) | BLC | ported |
| 0 | `V16Core::kernel_clear_leg` | 3328–3431 (104) | BLC | ported |
| 0 | `V16Core::kernel_lapsed_source_backing_scan_step` | 3780–3797 (18) | BLC | not from TradeNoCpi |
| 0 | `V16Core::target_effective_lag_adverse_delta` | 4359–4373 (15) | BLCM | ported |
| 0 | `V16Core::health_requirements_from_base_and_target_lag` | 4408–4425 (18) | BLCM | ported |
| 0 | `CloseProgressLedgerV16::is_finalized_inert` | 6207–6209 (3) | BLC | ported |
| 0 | `canonical_accrual_price_step_v16` | 6385–6431 (47) | – | ported |
| 0 | `TradeRequestGuardSummaryV16::all_pass` | 6619–6626 (8) | B | ported |
| 0 | `TokenValueFlowProofV16::account_capital_to_insurance` | 6946–6955 (10) | BLC | in place |
| 0 | `Group::validate_shape_audit_scan` | 9235–9244 (10) | BLC | in place |
| 0 | `Group::validate_account_scalar_preflight` | 9258–9289 (32) | BLC | ported |
| 0 | `Group::create_source_credit_lien_from_counterparty_core_not_atomic` | 10350–10380 (31) | B | ported |
| 0 | `Group::create_source_credit_lien_from_insurance_core_not_atomic` | 10680–10709 (30) | B | ported |
| 0 | `Group::source_lien_effective_reserved_supporting` | 11919–11944 (26) | BLCM | ported |
| 0 | `Group::apply_account_source_credit_lien_delta` | 13291–13352 (62) | B | ported |
| 0 | `Group::transfer_account_residual_reward_credit` | 13598–13625 (28) | B | ported |
| 0 | `Group::kf_epoch_for_leg_from_asset` | 14980–14985 (6) | BLC | ported |
| 0 | `Group::clear_account_stale` | 15387–15399 (13) | BLC | ported |
| 0 | `Group::require_asset_mark_pushable` | 16043–16048 (6) | – | ported |
| 0 | `Group::validate_unconfigured_market_tail` | 17519–17531 (13) | BC | ported |
| 0 | `Group::account_touches_pending_domain_loss_barrier` | 17945–17960 (16) | B | ported |
| 0 | `Group::position_change_touches_pending_domain_loss_barrier` | 17962–17989 (28) | BLC | ported |
| 0 | `Group::asset_has_target_effective_lag` | 18063–18066 (4) | B | ported |
| 0 | `Group::asset_is_loss_stale` | 18068–18074 (7) | B | ported |
| 0 | `Group::trade_signed_size_deltas` | 18163–18173 (11) | B | ported |
| 0 | `Group::set_pending_domain_loss_barrier_count` | 18752–18777 (26) | BLC | ported |
| 0 | `Group::drop_unowned_side_oi` | 19237–19262 (26) | BLC | ported |
| 0 | `Group::account_no_positive_credit_equity` | 19656–19667 (12) | BC | ported |
| 0 | `Group::terminal_trade_residual_asset_before_refresh` | 19800–19822 (23) | B | ported |
| 0 | `HealthCertV16Account::try_to_runtime` | 22856–22872 (17) | BLC | ported |
| 0 | `risk_notional_ceil` | 23211–23229 (19) | BLCM | ported |
| 0 | `trade_account_requires_initial_margin` | 23252–23254 (3) | B | ported |
| 0 | `trade_preflight_risk_gate` | 23256–23268 (13) | B | ported |
| 0 | `asset_risk_increase_gate` | 23270–23282 (13) | BLC | ported |
| 0 | `margin_requirement` | 23284–23290 (7) | BLCM | ported |
| 0 | `trade_notional_floor` | 23292–23305 (14) | B | ported |
| 0 | `checked_fee_bps` | 23314–23333 (20) | B | ported |
| 0 | `adjust_u128` | 23395–23405 (11) | BLC | ported |
| 0 | `validate_basis_or_zero` | 23541–23547 (7) | BLC | ported |
| 0 | `signed_position` | 23549–23558 (10) | BLC | ported |
| 0 | `same_side_risk_reduction_or_flat_obligation` | 23641–23645 (5) | BLC | ported |
| 0 | `leg_f_snap_is_settled` | 23803–23810 (8) | BLC | ported |
| 1 | `active_bitmap_with_cleared` | 295–301 (7) | BLC | ported |
| 1 | `uncovered_loss_remains_with_open_risk` | 327–334 (8) | BLC | ported |
| 1 | `V16Core::kernel_resize_leg_same_side` | 1614–1648 (35) | BLC | ported |
| 1 | `V16Core::effective_abs_quantity_for_leg` | 2215–2237 (23) | BLCM | ported |
| 1 | `V16Core::kernel_attach_leg` | 3505–3561 (57) | BLC | ported |
| 1 | `V16Core::target_effective_lag_loss_penalty` | 4348–4357 (10) | BLCM | ported |
| 1 | `V16Core::health_requirements_from_notional_and_target_lag` | 4375–4396 (22) | BLCM | ported |
| 1 | `PositionSlotMapV16::from_account` | 6650–6674 (25) | BLC | ported |
| 1 | `PositionSlotMapV16::plan_delta` | 6676–6795 (120) | BLC | ported |
| 1 | `Group::first_lapsed_roster_source_backing_for_account_at_slot` | 10194–10228 (35) | BLC | not from TradeNoCpi |
| 1 | `Group::first_lapsed_latent_source_backing_for_account_at_slot` | 10246–10292 (47) | BLC | not from TradeNoCpi |
| 1 | `Group::account_source_realizable_support` | 11803–11868 (66) | BLCM | ported |
| 1 | `Group::valid_source_lien_effective_reserved_sum` | 11946–11965 (20) | B | ported |
| 1 | `Group::create_source_credit_lien_backing_not_atomic` | 13257–13289 (33) | B | ported |
| 1 | `Group::initial_margin_requirement_for_abs_q` | 13627–13638 (12) | B | ported |
| 1 | `Group::leg_kf_epoch_is_current` | 14988–14990 (3) | BLC | ported |
| 1 | `Group::collect_account_backing_utilization_fees_not_atomic` | 15745–15772 (28) | BLC | ported |
| 1 | `Group::accrue_asset_path_to_not_atomic` | 16366–16531 (166) | – | ported |
| 1 | `Group::leg_is_prior_reset_obligation` | 16931–16937 (7) | BLC | ported |
| 1 | `Group::require_asset_risk_change_allowed` | 17481–17494 (14) | BLC | ported |
| 1 | `Group::ensure_favorable_action_current_certificate` | 17847–17864 (18) | B | ported |
| 1 | `Group::account_has_loss_stale_live_leg` | 18076–18092 (17) | B | ported |
| 1 | `Group::validate_trade_request` | 18135–18149 (15) | B | ported |
| 1 | `Group::ensure_source_domain_capacity_for_new_exposure` | 18301–18353 (53) | BLC | ported |
| 1 | `Group::begin_close_progress_ledger` | 18779–18827 (49) | BLC | ported |
| 1 | `Group::begin_zero_oi_residue_resets` | 19209–19227 (19) | BLC | ported |
| 1 | `Group::ensure_initial_margin` | 19651–19654 (4) | B | ported |
| 1 | `Group::ensure_no_positive_credit_initial_margin` | 19669–19679 (11) | B | ported |
| 1 | `Group::accumulate_batch_trade_apply` | 19964–19983 (20) | B | in place |
| 1 | `trade_fee_notional_ceil` | 23307–23312 (6) | B | ported |
| 1 | `pending_domain_loss_barrier_blocks_position_change` | 23647–23653 (7) | BLC | ported |
| 2 | `Group::first_lapsed_source_backing_for_account_at_slot` | 10178–10189 (12) | BLC | not from TradeNoCpi |
| 2 | `Group::charge_account_backing_fee_not_atomic` | 10971–11053 (83) | – | ported |
| 2 | `Group::incremental_initial_margin_source_credit_needed` | 11967–11988 (22) | B | ported |
| 2 | `Group::create_account_source_credit_lien_for_effective_unchecked` | 13354–13385 (32) | B | ported |
| 2 | `Group::account_haircut_equity` | 13477–13501 (25) | BLCM | ported |
| 2 | `Group::increased_initial_margin_principal` | 13640–13652 (13) | B | ported |
| 2 | `Group::require_position_route_adl_safe` | 17496–17507 (12) | BLC | ported |
| 2 | `Group::h_lock_lane` | 18026–18061 (36) | B | ported |
| 2 | `Group::can_ignore_unrelated_loss_stale_for_trade` | 18094–18109 (16) | B | ported |
| 2 | `Group::validate_trade_position_preflight` | 18175–18247 (73) | B | ported |
| 2 | `Group::attach_leg_at_slot` | 18262–18299 (38) | BLC | ported |
| 2 | `Group::clear_leg_at_slot_inner` | 18485–18554 (70) | BLC | ported |
| 2 | `Group::resize_leg_same_side_at_slot` | 18724–18750 (27) | BLC | ported |
| 2 | `Group::begin_terminal_trade_residual_if_needed` | 19824–19855 (32) | B | ported |
| 3 | `Group::expire_first_lapsed_source_backing_for_account_not_atomic` | 10326–10338 (13) | BLC | not from TradeNoCpi |
| 3 | `Group::create_account_source_credit_lien_for_effective_any_not_atomic` | 13387–13433 (47) | B | ported |
| 3 | `Group::transfer_trade_residual_reward_credit` | 13654–13690 (37) | B | ported |
| 3 | `Group::compute_account_health_cert_with_price_override` | 15401–15475 (75) | BLCM | ported |
| 3 | `Group::clear_leg_inner` | 18469–18483 (15) | BLC | ported |
| 3 | `Group::apply_position_delta_with_lookup_inner` | 18594–18721 (128) | BLC | ported |
| 3 | `Group::recertify_account_after_source_lien_change` | 19681–19712 (32) | BC | ported |
| 4 | `Group::create_initial_margin_source_lien_if_needed` | 13435–13460 (26) | B | ported |
| 4 | `Group::certify_account_after_local_settlement_with_price_override` | 16014–16034 (21) | BLC | not from TradeNoCpi |
| 4 | `Group::clear_leg` | 18355–18361 (7) | BLC | ported |
| 4 | `Group::apply_current_position_delta_with_lookup` | 18584–18592 (9) | B | ported |
| 4 | `Group::recertify_account_after_trade_delta` | 19714–19798 (85) | B | ported |
| 5 | `Group::refresh_account_and_certify_not_atomic` | 15488–15699 (212) | BLC | ported |
| 5 | `Group::apply_trade_after_refresh_not_atomic` | 19857–19962 (106) | B | ported |
| 5 | `Group::finish_trade_checks_not_atomic` | 19985–20022 (38) | B | ported |
| 6 | `Group::settle_account_for_position_action_and_refresh_not_atomic` | 19630–19649 (20) | B | ported |
| 7 | `Group::execute_batch_with_fee_after_tail_validation_not_atomic` | 20140–20250 (111) | B | ported |
| 8 | `Group::execute_batch_with_fee_loss_stale_scoped_not_atomic` | 20098–20138 (41) | B | ported |
| 9 | `Group::execute_trade_with_fee_loss_stale_scoped_not_atomic` | 20080–20096 (17) | – | ported |

| Height | Functions | Lines | Shared with BatchTradeNoCpi | with liquidation | with the crank |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 63 | 1157 | 60 | 36 | 39 |
| 1 | 31 | 957 | 30 | 20 | 20 |
| 2 | 14 | 491 | 13 | 6 | 6 |
| 3 | 7 | 347 | 7 | 4 | 5 |
| 4 | 5 | 148 | 5 | 2 | 2 |
| 5 | 3 | 356 | 3 | 1 | 1 |
| 6 | 1 | 20 | 1 | 0 | 0 |
| 7 | 1 | 111 | 1 | 0 | 0 |
| 8 | 1 | 41 | 1 | 0 | 0 |
| 9 | 1 | 17 | 0 | 0 | 0 |
| | 127 | 3645 | 121 | 69 | 73 |

ported: 117 functions, 3429 lines
in place: 4 functions, 70 lines
not from TradeNoCpi: 6 functions, 146 lines
remaining: 0 functions, 0 lines

## 13. PermissionlessCrank and FinalizeResetSide

`settlement-map.py <v16.rs> --crank <v16_program.rs>` maps what PermissionlessCrank reaches, as section 12 does for
TradeNoCpi: the processor's closure of `handle_permissionless_crank` (94 functions, 2,509 lines), then the engine's
closure of the ten entry points the processor calls (507 functions reached, 374 ported before, 133 new: 4,436 lines),
each new engine function attributed to the crank's actions that reach it (a function several reach is listed under
each; the totals count it once):

| Action | New engine functions it reaches | Lines | Only this action |
| --- | ---: | ---: | ---: |
| the plan (the actionable summary, the selector, the riskiest liquidatable leg) | 22 | 708 | 14 / 517 |
| Refresh (the refresh and certificate with B chunks and lapsed backing) | 6 | 131 | 1 / 6 |
| ReleaseSourceLiens | 5 | 249 | 3 / 187 |
| Liquidate (liquidation, its fees, the insurance, loss socialisation, ADL) | 60 | 1,615 | 31 / 817 |
| the cranker's reward | 3 | 58 | 3 / 58 |
| AdvanceClose | 21 | 680 | 1 / 57 |
| DeclareRecovery | 1 | 20 | 0 / 0 |
| a market in Recovery (forfeits, the committed-state refresh, resolution) | 40 | 1,262 | 13 / 487 |
| a Resolved market (CloseResolved) | 56 | 1,727 | 29 / 1,013 |
| total, each function once | 133 | 4,436 | |

The observation (accrual at a moving price, the stored target), the maintenance fee and its split, the released
obligation's `clear_leg` and SettleBChunk reach nothing new: the trade and the settlement ported them.

**All of it is ported.** Everything a Live market's crank reaches (89 new engine functions, 2,919 lines, three of them
the insurance credit SyncMaintenanceFee's cranker share had already ported in refresh.ts; and 84 of the 94 processor
functions) came first; the rest followed (44 engine functions, 1,517 lines; 10 processor functions, 234 lines): a
market in Recovery (recovery.ts: `forfeit_recovery_leg_not_atomic` with its 12 helpers, `resolve_market_not_atomic`),
the forfeit of a released obligation on a Recovery asset (the same function, from the Live market's Refresh), a
Resolved market (closeresolved.ts `handle_close_resolved` with the token payout; resolved.ts
`close_resolved_account_not_atomic` and the resolved payout, the receipt, the source domains' preparation and
realization) and the CloseResolved plan (autocrank.ts, which the classifier selects only on a Resolved market). The
four placeholder sites (Custom(0xc0de0000 + site · 0x100 + 5): 1, 2, 4, 5) are gone; `settlement-map.py --crank` lists
every function of both closures as ported (below).

FinalizeResetSide (tag 45) is `finalize_side_reset_not_atomic` (54 lines) on the market view; its closure was ported
with the settlement (`set_asset_state`, the barrier count, the header's aggregate totals).

**What reading the sources and the comparison showed.**

- **The certificate a liquidation needs.** The classifier selects Liquidate only for a current certificate. With a
  maintenance fee, the first crank of a slot collects it (`collect_maintenance_fee_before_value_debit_view`), which
  invalidates the certificate, so that crank refreshes; a second crank of the same portfolio in the same slot finds the
  certificate current and liquidates. Another portfolio's settlement between the two can move the market's risk epoch
  (a source credit recomputed when a winner's claim grows), which makes the certificate stale again: in a busy market
  a portfolio is liquidated by two cranks of it in a row. Both binaries behave alike; the tests and the walk crank that
  way.
- **NonProgress swallowed** (section 1, site 2): the engine's NonProgress after a market accrual makes the crank a
  success that keeps whatever the engine wrote before it (a refreshed certificate, a liquidation's fee and settlement
  when the score did not fall). The processor then credits the insurance's growth to the fee asset's domains as for a
  non-liquidation (`selected_liquidation` is false for a swallowed result).
- **A declared Recovery is a success** (section 1, site 8). Liquidation declares it when a bankrupt close cannot make
  progress (no loss weight on the other side, the B index's headroom, an A index that would round to zero, a residual
  beyond one step, an uncovered loss with other legs, an expired close ledger or a moved close snapshot).
- **Copies.** The processor copies the wrapper config (written back validated at the end, or after a matured
  settlement or a bounded catch-up; not written on the expired-close path) and each hinted asset's oracle profile
  (written back validated at the end of its turn, compared with the stored one for `market_accrual_performed`). The
  port changes both in place: nothing reads their bytes from the account in between, every failure in between fails the
  transaction, and the swallowed NonProgress comes after the profiles are written. To tell whether a profile changed it
  keeps the 16 fields a crank can change (the funding checkpoint, the target and its publish time, the liveness slot,
  the three legs' prices and times, the mark and its slot, the provenance, the price-move remainder). The engine's
  copies (`asset_mut` of the residual booking, the reduction's asset) are written back after their checks; the port
  writes in place after the same checks, the booking only once a chunk is certain.
- **Repeated accounts.** The market is held mutably while the portfolio (dropped while the oracles are read), the
  oracle accounts and the cranker's portfolio are borrowed. An oracle account that is the market fails its borrow
  (AccountBorrowFailed, the reader's `busy` key); a cranker portfolio that is the market fails its preflight's borrow
  (AccountBorrowFailed, an explicit key check in the port) and one that is the portfolio is InvalidInstruction first;
  the portfolio as an oracle account is read (IllegalOwner). Every ordered pair of positions of a crank with a hybrid
  hint and a cranker is compared (percolator-v16-crank.test.ts).
- **The side OI cap** (the trade's `ensure_trade_side_oi_cap_view`, which refuses a side above `MAX_OI_SIDE_Q` whether
  or not the fill grew it). The cap is on effective quantity, not notional, so a price move cannot push a side over
  it; the crank only lowers effective OI (the unilateral close's reduction of the other side and its A scaling, the
  residue drop); trades are refused by the engine's own gate when they would grow a side over the cap. No sequence of
  ported instructions makes a side exceed the cap, so whether a reducing trade on an over-cap side is refused could not
  be checked against the reference binary with real instructions.
- **Arithmetic.** The liquidation's projections run in u128 where the original's checked steps cannot overflow (a
  quantity at most 10^14 times a price at most 10^12), with the original's errors where they can; the bankruptcy
  capacity's 256-bit headroom is TypeSOL's u256; the bisection makes at most 47 projections.

Copies and swallowed errors, function by function:

| Function | What the original does | Finding |
| --- | --- | --- |
| `handle_permissionless_crank_zero_copy` | `cfg` and each `oracle_profile` by value, written back validated | in place (above) |
| `permissionless_auto_crank_not_atomic` | swallows `clear_leg`'s Stale; returns NonProgress for a Refresh without an asset or an observation | site 3; NONPROG |
| `permissionless_crank_not_atomic` | Liquidate's errors through `kernel_commit_declared_liquidation_recovery` | site 8 |
| `liquidate_account_not_atomic` | NonProgress at four places, RecoveryRequired after declarations; the risk score before by value | values (NONPROG, DECLARED); the score kept in a local |
| `advance_pending_close_residual_not_atomic` | NonProgress twice, declarations under it | values |
| `release_account_source_credit_liens_if_unneeded_core_not_atomic` | NonProgress twice; `source_snapshot` by value, the slot then cleared in place | values; nothing writes the slot between the snapshot and its clearing |
| `book_bankruptcy_residual_chunk_internal` | `asset_mut`, written only for a booked chunk | in place after the chunk is certain |
| `reduce_matching_open_interest_for_unilateral_close` | the asset by value, a declaration before any write | in place after the declaration's test |
| `accrue_asset_to_not_atomic` | NonProgress before any write (the crank's Refresh and its trailing accrual) | `accrueAssetToOrNonProgress` |
| `refresh_account_and_certify_not_atomic` (the crank's) | stops at a lapsed expiry or a B chunk, both successes | outcome codes; every other caller propagates |
| `forfeit_recovery_leg_not_atomic` | every error propagated (both callers); RecoveryRequired after a declaration under it (the close ledger's expiry, a residual no step books) | fails in place with RecoveryRequired: the declaration is discarded with the transaction, as in the original; its own CommitRecovery step declares and succeeds |
| `settle_forfeited_leg_kf_effects` | the leg read at the start and written back at the end; the asset through `kernel_settle_kf_stale_cohort` and `set_asset_state` | in place: nothing in between writes either (the PnL paths write no leg or asset) |
| `retain_leg_as_pending_obligation` | the leg (its F snapshot set to the target) and the asset by value, written back after the kernel's checks | in place after the same checks |
| `prepare_one_source_domain_for_resolved_close_not_atomic`, `realize_one_source_domain_for_resolved_close_not_atomic` | a source-domain slot copied (`source_domains[slot]`) | the fields read from it are read from the slot before any step writes them |
| `source_claim_converts_to_zero_unpledged` | the domain's source state copied, its valid liens zeroed and its rate recomputed, never written | a real copy (a local struct) |
| `create_resolved_payout_receipt_if_needed`, `refine_resolved_unreceipted_bound_not_atomic`, `apply_resolved_payout_receipt_payment` | the payout ledger or the receipt decoded, changed, written back after their checks (the halted flag written before RecoveryRequired, which fails the transaction) | in place after the same checks |
| `close_resolved_account_not_atomic` | its two outcomes (a waiting source claim after a pre-payout step, a preparation step) are values, not errors | values (`ResolvedClose`, the realization's and preparation's codes) |
| `handle_close_resolved` | the wrapper config by value, never written back | read in place (only the fee rate and the mints are used) |

#### PermissionlessCrank: the processor and the engine (output of `settlement-map.py --crank`)

The processor: 94 functions reached (2,509 lines), all ported (crank.ts, closeresolved.ts and the files of the earlier
instructions; the last ten were `handle_close_resolved` with its token checks and signed transfer).

##### The engine: 10 entry points; 507 functions reached, 374 ported, 133 new (4436 lines)

| Height | Function | Lines | Actions | Also | Status |
| ---: | --- | --- | --- | --- | --- |
| 0 | `v16_domain_pair_for_asset_index` | 178–186 (9) | resolved | – | ported |
| 0 | `liquidation_remaining_active_bitmap_after_close` | 304–315 (12) | liquidate | – | ported |
| 0 | `liquidation_risk_notional_ceil` | 345–356 (12) | liquidate | – | ported |
| 0 | `min_abs_q_for_risk_notional_at_least` | 463–485 (23) | liquidate | – | ported |
| 0 | `liquidation_projected_health_deficit_from_parts` | 504–525 (22) | liquidate | – | ported |
| 0 | `V16Core::kernel_advance_close_ledger` | 1767–1817 (51) | liquidate, close, recovery, resolved | – | ported |
| 0 | `V16Core::kernel_consume_insurance_layer` | 1885–1904 (20) | liquidate, close, recovery, resolved | – | ported |
| 0 | `V16Core::kernel_retain_terminal_source_haircut` | 2006–2021 (16) | resolved | – | ported |
| 0 | `V16Core::kernel_resolved_receipt_can_still_gain` | 2075–2102 (28) | resolved | – | ported |
| 0 | `V16Core::kernel_principal_cure_close_ledger` | 2109–2136 (28) | liquidate, close, recovery, resolved | – | ported |
| 0 | `V16Core::kernel_unilateral_close_capacity` | 2337–2343 (7) | plan, liquidate | R | ported |
| 0 | `V16Core::kernel_reduce_position_delta` | 2370–2385 (16) | liquidate | R | ported |
| 0 | `V16Core::kernel_auto_crank_lifecycle_dispatchable` | 2444–2449 (6) | plan | – | ported |
| 0 | `V16Core::kernel_b_settlement_pending` | 2454–2463 (10) | plan | – | ported |
| 0 | `V16Core::kernel_auto_crank_refresh_asset` | 2511–2516 (6) | plan | – | ported |
| 0 | `V16Core::kernel_refresh_detached_selected_leg` | 2518–2523 (6) | refresh | – | ported |
| 0 | `V16Core::kernel_commit_declared_liquidation_recovery` | 2528–2539 (12) | liquidate | – | ported |
| 0 | `V16Core::select_auto_crank_plan` | 2577–2609 (33) | plan | – | ported |
| 0 | `V16Core::actionable_summary_from_signals` | 2690–2710 (21) | plan | – | ported |
| 0 | `V16Core::kernel_open_close_snapshot_is_stale` | 2720–2726 (7) | liquidate, close, recovery, resolved | – | ported |
| 0 | `V16Core::kernel_social_loss_chunk_cap` | 2740–2745 (6) | liquidate, close, recovery, resolved | – | ported |
| 0 | `V16Core::kernel_bresidual_step` | 2871–2891 (21) | liquidate, close, recovery, resolved | – | ported |
| 0 | `V16Core::kernel_forfeit_residual_step` | 2907–2918 (12) | recovery | – | ported |
| 0 | `V16Core::kernel_settle_resolved_pnl_after_booking` | 2941–2956 (16) | close, resolved | – | ported |
| 0 | `V16Core::kernel_recovery_pending_obligation_release_allowed` | 3203–3213 (11) | plan, recovery, resolved | – | ported |
| 0 | `V16Core::kernel_advance_resolved_slot` | 3760–3772 (13) | resolved | – | ported |
| 0 | `V16Core::kernel_lapsed_source_backing_scan_step` | 3780–3797 (18) | plan, refresh, liquidate, recovery | B | ported |
| 0 | `V16Core::kernel_flat_source_lien_normalization` | 3803–3843 (41) | plan, release | – | ported |
| 0 | `V16Core::kernel_live_account_refresh_required` | 3849–3857 (9) | plan | – | ported |
| 0 | `V16Core::kernel_live_flat_source_lien_normalization_required` | 3859–3868 (10) | plan | – | ported |
| 0 | `V16Core::kernel_live_liquidation_required` | 3881–3894 (14) | plan | – | ported |
| 0 | `V16Core::prepare_counterparty_lien_release_delta` | 3910–3933 (24) | release | – | ported |
| 0 | `V16Config::checked_mul_div_ceil_to_u128` | 4729–4743 (15) | liquidate | – | ported |
| 0 | `Portfolio::is_empty_for_dematerialization` | 6010–6052 (43) | plan | – | ported |
| 0 | `apply_resolved_payout_receipt_payment` | 6328–6353 (26) | resolved | – | ported |
| 0 | `TokenValueFlowProofV16::insurance_capital_to_account_capital` | 6981–6990 (10) | reward | – | ported |
| 0 | `TokenValueFlowProofV16::capital_and_resolved_payout_to_external_out` | 7065–7084 (20) | resolved | – | ported |
| 0 | `Group::release_account_source_credit_lien_for_domain_not_atomic` | 11285–11322 (38) | resolved | – | ported |
| 0 | `Group::credit_account_from_insurance_delta` | 12315–12335 (21) | reward | – | ported |
| 0 | `Group::available_domain_insurance` | 12442–12457 (16) | liquidate, close, recovery, resolved | – | ported |
| 0 | `Group::kf_target_for_leg` | 14931–14943 (13) | recovery | – | ported |
| 0 | `Group::certify_account_after_local_settlement_with_price_override` | 16014–16034 (21) | release, liquidate | BR | ported |
| 0 | `Group::declare_permissionless_recovery` | 16533–16552 (20) | liquidate, close, recover, recovery, resolved | R | ported |
| 0 | `Group::require_asset_live_reducible` | 17627–17633 (7) | liquidate | R | ported |
| 0 | `Group::side_mode_for` | 17734–17740 (7) | recovery | – | ported |
| 0 | `Group::account_b_loss_bound` | 17798–17811 (14) | liquidate | R | ported |
| 0 | `Group::position_delta_touches_pending_domain_loss_barrier` | 17991–18006 (16) | liquidate | – | ported |
| 0 | `Group::position_delta_lookup_for_asset` | 18249–18260 (12) | liquidate, resolved | R | ported |
| 0 | `Group::remaining_effective_oi_for_leg` | 18426–18435 (10) | recovery | – | ported |
| 0 | `Group::apply_position_delta_with_lookup` | 18574–18582 (9) | liquidate, resolved | R | ported |
| 0 | `Group::begin_legless_asset_resets` | 19266–19272 (7) | liquidate, close, recovery, resolved | – | ported |
| 0 | `Group::begin_side_reset_if_effective_oi_exhausted` | 19288–19312 (25) | liquidate | R | ported |
| 0 | `Group::resolved_bankruptcy_attribution` | 20276–20302 (27) | resolved | – | ported |
| 0 | `Group::clear_resolved_unattributed_negative_pnl` | 20304–20315 (12) | resolved | – | ported |
| 0 | `Group::settle_negative_pnl_from_principal_not_atomic` | 20385–20394 (10) | recovery, resolved | – | ported |
| 0 | `Group::charge_account_fee_after_loss_settlement` | 20517–20534 (18) | liquidate | – | ported |
| 0 | `Group::resolved_positive_payout_ready` | 20547–20556 (10) | plan, resolved | – | ported |
| 0 | `Group::recompute_resolved_payout_rate` | 20558–20564 (7) | resolved | – | ported |
| 0 | `Group::resolved_receipt_claimable_against_ledger` | 20641–20660 (20) | resolved | – | ported |
| 0 | `Group::resolve_market_not_atomic` | 21289–21299 (11) | recovery | – | ported |
| 0 | `Group::source_claim_whole_atom_conversion` | 21488–21499 (12) | resolved | – | ported |
| 0 | `Group::expire_one_lapsed_source_backing_for_resolved_active_leg_not_atomic` | 21684–21708 (25) | resolved | – | ported |
| 0 | `Group::forfeit_loss_backing_capacity_atoms` | 22494–22503 (10) | recovery | – | ported |
| 0 | `RiskScoreV16::strictly_reduces_from` | 23197–23199 (3) | liquidate | R | ported |
| 0 | `liquidation_fee_from_raw_fee` | 23357–23367 (11) | liquidate | – | ported |
| 0 | `fraction_ge` | 23567–23578 (12) | resolved | – | ported |
| 0 | `social_loss_book_split` | 23661–23674 (14) | liquidate, close, recovery, resolved | – | ported |
| 1 | `liquidation_leg_maintenance_requirement` | 358–382 (25) | liquidate | – | ported |
| 1 | `liquidation_partial_search_hi` | 487–502 (16) | liquidate | – | ported |
| 1 | `V16Core::liquidation_progress_from_scores` | 1224–1227 (4) | liquidate | R | ported |
| 1 | `V16Core::kernel_auto_crank_leg_flags` | 2477–2498 (22) | plan | – | ported |
| 1 | `V16Core::apply_bankruptcy_residual_chunk_to_loss_side` | 2790–2841 (52) | liquidate, close, recovery, resolved | – | ported |
| 1 | `Group::first_lapsed_roster_source_backing_for_account_at_slot` | 10194–10228 (35) | plan, refresh, liquidate, recovery | B | ported |
| 1 | `Group::first_lapsed_latent_source_backing_for_account_at_slot` | 10246–10292 (47) | plan, refresh, liquidate, recovery | B | ported |
| 1 | `Group::first_lapsed_source_backing_for_asset_at_slot` | 10296–10324 (29) | resolved | – | ported |
| 1 | `Group::release_source_credit_lien_from_counterparty_core_not_atomic` | 10392–10422 (31) | release | – | ported |
| 1 | `Group::account_has_normalizable_source_credit_lien` | 11090–11130 (41) | plan | – | ported |
| 1 | `Group::credit_account_from_insurance_not_atomic` | 12337–12363 (27) | reward | – | ported |
| 1 | `Group::consume_domain_insurance_for_negative_pnl` | 12471–12506 (36) | liquidate, close, recovery, resolved | – | ported |
| 1 | `Group::liquidation_residual_after_principal_and_insurance` | 12508–12526 (19) | liquidate | – | ported |
| 1 | `Group::highest_risk_liquidatable_asset` | 16943–16992 (50) | plan | – | ported |
| 1 | `Group::risk_score_unchecked` | 17813–17831 (19) | liquidate | R | ported |
| 1 | `Group::recovery_pending_obligation_release_allowed` | 18363–18384 (22) | plan, recovery, resolved | – | ported |
| 1 | `Group::retain_leg_as_pending_obligation` | 18386–18417 (32) | recovery | – | ported |
| 1 | `Group::clear_forfeited_leg` | 18439–18455 (17) | recovery | – | ported |
| 1 | `Group::apply_position_delta` | 18556–18572 (17) | liquidate, resolved | R | ported |
| 1 | `Group::ensure_close_progress_not_expired` | 18829–18843 (15) | liquidate, close, recovery, resolved | – | ported |
| 1 | `Group::ensure_open_close_snapshot_current_or_recovery` | 18845–18870 (26) | liquidate, close, recovery, resolved | – | ported |
| 1 | `Group::bankruptcy_residual_single_step_capacity` | 18921–18984 (64) | liquidate, close, recovery, resolved | – | ported |
| 1 | `Group::unilateral_close_capacity` | 19274–19286 (13) | liquidate | R | ported |
| 1 | `Group::reduce_matching_open_interest_for_unilateral_close` | 19314–19366 (53) | liquidate | R | ported |
| 1 | `Group::clamp_close_residual_to_account_loss` | 20402–20431 (30) | liquidate, close, recovery, resolved | – | ported |
| 1 | `Group::charge_account_fee_not_atomic` | 20536–20545 (10) | liquidate | – | ported |
| 1 | `Group::initialize_resolved_payout_ledger_if_needed` | 20566–20590 (25) | resolved | – | ported |
| 1 | `Group::resolved_receipt_claimable_now` | 20636–20639 (4) | resolved | – | ported |
| 1 | `Group::advance_resolved_slot_not_atomic` | 21304–21312 (9) | resolved | – | ported |
| 1 | `Group::resolved_receipt_can_still_gain` | 21320–21326 (7) | resolved | – | ported |
| 1 | `Group::source_claim_converts_to_zero_unpledged` | 21511–21521 (11) | resolved | – | ported |
| 1 | `Group::prepare_one_source_domain_for_resolved_close_not_atomic` | 21608–21675 (68) | resolved | – | ported |
| 1 | `Group::refine_resolved_unreceipted_bound_not_atomic` | 21752–21781 (30) | resolved | – | ported |
| 1 | `Group::leg_is_dead_for_forfeit` | 22393–22414 (22) | recovery | – | ported |
| 1 | `Group::settle_forfeited_leg_kf_effects` | 22416–22489 (74) | recovery | – | ported |
| 1 | `liquidation_fee_for_close` | 23335–23355 (21) | liquidate | – | ported |
| 2 | `liquidation_projected_healthy_after_close` | 384–430 (47) | liquidate | – | ported |
| 2 | `Group::first_lapsed_source_backing_for_account_at_slot` | 10178–10189 (12) | refresh, liquidate, recovery | B | ported |
| 2 | `Group::liquidation_residual_exceeds_single_step_capacity` | 12528–12552 (25) | liquidate | – | ported |
| 2 | `Group::auto_crank_selected_assets` | 16994–17099 (106) | plan | – | ported |
| 2 | `Group::validate_liquidation_progress_from_score` | 17834–17845 (12) | liquidate | R | ported |
| 2 | `Group::retain_recovery_loss_weight_before_detach` | 18457–18467 (11) | recovery | – | ported |
| 2 | `Group::advance_close_progress_ledger` | 18872–18919 (48) | liquidate, close, recovery, resolved | – | ported |
| 2 | `Group::book_bankruptcy_residual_chunk_internal` | 18986–19065 (80) | liquidate, close, recovery, resolved | – | ported |
| 2 | `Group::reduce_position` | 19368–19391 (24) | liquidate | R | ported |
| 2 | `Group::create_resolved_payout_receipt_if_needed` | 20592–20634 (43) | resolved | – | ported |
| 2 | `Group::release_account_source_credit_liens_if_unneeded_core_not_atomic` | 20862–20993 (132) | release | – | ported |
| 2 | `Group::clear_fully_diluted_resolved_receipt_if_terminal` | 21330–21350 (21) | resolved | – | ported |
| 2 | `Group::source_domain_terminal_for_haircut_demote` | 21526–21602 (77) | resolved | – | ported |
| 2 | `Group::detach_solvent_active_legs_for_resolved_close` | 21939–22032 (94) | resolved | – | ported |
| 3 | `liquidation_partial_close_is_healthy` | 432–461 (30) | liquidate | – | ported |
| 3 | `Group::expire_first_lapsed_source_backing_for_account_not_atomic` | 10326–10338 (13) | refresh, liquidate, recovery | B | ported |
| 3 | `Group::preflight_liquidation_residual_durability` | 12554–12571 (18) | liquidate | – | ported |
| 3 | `Group::refresh_recovery_account_from_committed_state_not_atomic` | 16669–16714 (46) | recovery | – | ported |
| 3 | `Group::build_actionable_summary_and_selected_assets` | 16762–16907 (146) | plan | – | ported |
| 3 | `Group::book_bankruptcy_residual_chunk_for_account_core` | 19067–19132 (66) | liquidate, close, recovery, resolved | – | ported |
| 3 | `Group::realize_one_source_domain_for_resolved_close_not_atomic` | 21377–21484 (108) | resolved | – | ported |
| 4 | `liquidation_engine_close_request_q` | 527–620 (94) | liquidate | – | ported |
| 4 | `Group::build_actionable_summary_at_slot` | 16752–16760 (9) | – | – | ported |
| 4 | `Group::advance_pending_close_residual_not_atomic` | 19134–19190 (57) | close | – | ported |
| 4 | `Group::settle_resolved_bankruptcy_negative_pnl` | 20317–20383 (67) | resolved | – | ported |
| 4 | `Group::forfeit_recovery_leg_not_atomic` | 22528–22749 (222) | recovery | – | ported |
| 5 | `Group::liquidate_account_not_atomic` | 19393–19573 (181) | liquidate | – | ported |
| 5 | `Group::close_resolved_account_not_atomic` | 21783–21937 (155) | resolved | – | ported |
| 6 | `Group::permissionless_crank_not_atomic` | 16562–16663 (102) | – | – | ported |
| 7 | `Group::permissionless_auto_crank_not_atomic` | 17129–17403 (275) | – | – | ported |

| Action | | Functions reached that are new | Lines | Only this action |
| --- | --- | ---: | ---: | ---: |
| plan | the plan: the actionable summary, the selector, the riskiest liquidatable asset | 22 | 708 | 14 / 517 |
| observe | the observation: accrual at the observed price, the stored target | 0 | 0 | 0 / 0 |
| fee | the maintenance fee and the fee split | 0 | 0 | 0 / 0 |
| refresh | Refresh: the refresh and certificate with B chunks and lapsed backing | 6 | 131 | 1 / 6 |
| obligation | a released reset obligation: clear_leg and the residue resets | 0 | 0 | 0 / 0 |
| settle_b | SettleBChunk | 0 | 0 | 0 / 0 |
| release | ReleaseSourceLiens | 5 | 249 | 3 / 187 |
| liquidate | Liquidate: liquidation, its fees, loss socialisation and ADL | 60 | 1615 | 31 / 817 |
| reward | the cranker's reward | 3 | 58 | 3 / 58 |
| close | AdvanceClose | 21 | 680 | 1 / 57 |
| recover | DeclareRecovery | 1 | 20 | 0 / 0 |
| recovery | a market in Recovery: forfeits, recovery refresh, resolution | 40 | 1262 | 13 / 487 |
| resolved | a Resolved market (CloseResolved) | 56 | 1727 | 29 / 1013 |
| | total (each once) | 133 | 4436 | |

ported: 133 functions, 4436 lines
remaining: 0 functions, 0 lines

shared with RebalanceReduce: 17; with FinalizeResetSide: 0; with BatchTradeNoCpi: 6

#### ForfeitRecoveryLeg, CloseResolved, ResolveMarket, ResolveStalePermissionless

| Instruction | Processor functions beyond the crank's | Lines | Ported | Engine functions beyond the port and the crank | Lines |
| --- | ---: | ---: | ---: | ---: | ---: |
| ForfeitRecoveryLeg | 12 | 316 | 10 | 0 | 0 |
| CloseResolved | 1 | 119 | 1 | 0 | 0 |
| ResolveMarket | 10 | 163 | 6 | 0 | 0 |
| ResolveStalePermissionless | 5 | 107 | 4 | 0 | 0 |

The four instructions above add no engine function beyond the crank's closure (the crank reaches
`forfeit_recovery_leg_not_atomic`, `resolve_market_not_atomic` and `close_resolved_account_not_atomic`); their processor
functions not counted as ported are those the port inlines (`portfolio_position_binding_matches`, the profile reads'
error mapping) or the trade's (`accrue_zero_move_funding_before_position_change_for_profile_view`, ported in trading.ts).

## 14. The recovery and resolution instructions

ForfeitRecoveryLeg (43), RebalanceReduce (44) and CureAndCancelClose (42) are recoveries.ts; ResolveMarket (19) and
ResolveStalePermissionless (39) resolution.ts; CloseResolved (30) closeresolved.ts. Their engine code is recovery.ts,
resolved.ts and liquidation.ts (RebalanceReduce reuses liquidation's reduction, risk score and certification).

- **Errors.** No caller of these instructions' engine calls looks at an error: every one goes through `map_v16_error`
  and fails the transaction, so the port fails in place throughout. RebalanceReduce's NonProgress (nothing to reduce,
  or a score that did not fall) is a failure here, unlike the crank's liquidation.
- **Copies.** `with_one_portfolio_view`'s closures read the asset's oracle profile into a copy
  (`read_oracle_profile_from_view(...).map_err(|_| InvalidConfig)`) and write it back validated
  (`write_oracle_profile_to_view`, InvalidConfig); nothing in between reads the profile's bytes, so the port accrues in
  place and validates the profile where the original writes it (`assetOracleProfileOk`, the validator as a value, so
  that the refusal is InvalidConfig and not InvalidAccountData). `reject_market_resolve_before_committed_accrual_view`
  reads each profile unchecked and validates it only past the zero-value test, as the original does.
- **The required resolve accrual.** ResolveMarket asks `required_market_resolve_accrual_for_profile_view` without the
  pending mark's activation step (`include_pending_mark = false`); ResolveStalePermissionless and the crank's matured
  resolution with it (crank.ts `resolveAccrual(..., include)`).
- **Repeated accounts.** `handle_close_resolved` borrows the market mutably before it checks the portfolio's storage,
  which reads the portfolio's `data_len()` through its RefCell: a portfolio that is the market panics there
  (solana-program 1.18.26 src/account_info.rs:91:19; the pinocchio hook logs the file only, so the line and column
  are from the source, not compared). CureAndCancelClose and the `with_one_portfolio_view` instructions check the
  storage before the market's borrow, as the earlier handlers do. The sweeps (percolator-v16-recovery.test.ts) compare
  every ordered pair of positions.
- **CureAndCancelClose's state.** It needs an active close ledger with its whole gross loss outstanding and no
  irreversible progress, and a barrier on its domain: no ported instruction leaves one (the trade's terminal close and
  liquidation book progress in the same transaction), so it is compared on ledgers written into the portfolio (and
  the barrier and blocker counts into the market), the reference deciding which are acceptable.
- **Arithmetic.** `kernel_resolved_receipt_can_still_gain` rounds the fresh backing up to whole atoms with a checked
  add; the payout's capital plus claim is checked; `fraction_ge`'s products of two u128 values fit 256 bits (its
  ArithmeticOverflow cannot fire); the escrow's sums are bounded by the preflight before they are formed.

## 15. The insurance and backing-bucket instructions, and the terminal ones

TopUpInsurance (9) and TopUpInsuranceDomain (56), TopUpBackingBucket (24), WithdrawBackingBucket (50),
WithdrawBackingBucketEarnings (52) and WithdrawInsuranceAsset (57) are reserves.ts; CloseSlab (13),
ClaimResolvedPayoutTopup (46), SwapSecondaryForPrimary (61) and ForceCloseAbandonedAsset (64) are terminal.ts. These
are every tag whose dispatch ended in the placeholder except the three that need the matcher ABI or the batch (TradeCpi 10,
BatchTradeNoCpi 66, BatchTradeCpi 67; BatchTradeNoCpi shares the batch engine with them). With them 47 of the 50
instructions are ported.

**What they reach.** `settlement-map.py`'s closure of each handler, beyond the processor functions and the engine
functions earlier instructions ported (the crank's closure among them):

| Instruction | Engine functions new to the port | Lines |
| --- | --- | ---: |
| TopUpInsurance, TopUpInsuranceDomain | none (`deposit_domain_insurance_not_atomic`, `domain_insurance_budget_remaining` and the proof `external_in_to_insurance_capital` came with UpdateAssetLifecycle's activation fee) | 0 |
| TopUpBackingBucket | `deposit_fresh_counterparty_backing_not_atomic` | 23 |
| WithdrawBackingBucket | `withdraw_fresh_counterparty_backing_not_atomic`, `withdraw_resolved_counterparty_backing_surplus_not_atomic`, `resolved_counterparty_backing_surplus`, `resolved_junior_payout_pool`, `asset_has_unsettled_kf_position`, `kernel_resolved_junior_backing_need_num`, `prepare_counterparty_backing_withdraw_delta` | 170 |
| WithdrawBackingBucketEarnings | `withdraw_backing_provider_earnings_not_atomic`, `apply_backing_provider_earnings_withdraw` | 37 |
| WithdrawInsuranceAsset | `withdraw_domain_insurance_not_atomic` and `_delta`, `domain_insurance_withdraw_capacity`, `recredit_terminal_claim_free_residual_for_asset_not_atomic` and `_core_`, the overlap and unconsumed-spend recredits with their kernels, `apply_terminal_insurance_recredit_not_atomic`, `require_terminal_claim_free_state`, the proofs `insurance_capital_to_external_out` and `unallocated_protocol_surplus_to_insurance` | 256 |
| CloseSlab | `advance_terminal_slab_not_atomic`, `terminal_claim_free_recredit_for_slot`, `kernel_terminal_slab_asset_step`, `kernel_terminal_slab_wait_continuation`, `retire_terminal_unbudgeted_insurance_core_not_atomic` and `_delta` (and the recredit above) | 220 |
| ClaimResolvedPayoutTopup | `claim_resolved_payout_topup_not_atomic` and `_core_`, `preflight_claim_resolved_payout_topup`, `kernel_resolved_payout_step` | 57 |
| SwapSecondaryForPrimary | none (token checks and transfers only) | 0 |
| ForceCloseAbandonedAsset | `force_close_recovery_pair_not_atomic` (it runs the trade engine of trade.ts and, for a residue, the forfeit of recovery.ts) | 53 |
| total, each once | 34 functions | 816 |

The processor functions they add beyond the earlier handlers' are the handlers themselves,
`verify_domain_withdrawal_preflight`, `read_or_new_*_ledger` and `write_or_init_*_ledger`,
`live_domain_withdraw_health_or_shutdown_view` with `shutdown_asset_empty_and_matured_*` and
`asset_local_loss_stale_view`, the insurance views (`market_insurance_remaining_view`,
`market_insurance_withdraw_capacity_view`, `debit_market_insurance_budget_view`, `domain_withdraw_capacity_view`),
`require_domain_accepts_live_topup_view`, `backing_fee_policy_for_domain_view`, `terminal_slab_scan_start`,
`encode_terminal_slab_scan_progress`, `burn_tokens_signed`, `verify_mint` and `write_closed_market_tombstone`.

**What reading the sources and the comparison showed.**

- **No error is swallowed.** Every engine call of these handlers goes through `map_v16_error` and fails the
  transaction; CloseSlab's outcomes (a scan step, an expiry, a recredit, ready to close) are values, and the first
  three end the instruction successfully with the scan progress written.
- **Two borrows, one view.** Each top-up takes the market view twice (a preflight block, then the mutation block after
  the token accounts are checked) and repeats checks of the first block in the second; nothing writes the market in
  between, so the port makes them once and makes where the original does only what the second block adds (the stale
  window, the domain's lifecycle again, the authority read from the view).
- **Copies.** The ledgers are read into copies, changed around the engine call and written after the market's shape;
  the port changes them in place (every error after the first change fails the transaction). The one check a write
  makes that the read did not is a new ledger's authority: a ledger created for a zero authority (the admin's shutdown
  drain of a domain with no backing authority, or a Live withdrawal by the operator of an asset with no insurance
  authority) is refused there with InvalidAccountData, which the port checks at the same point. CloseSlab copies the
  wrapper config and writes it back validated; the port changes the scan progress in place and validates where the
  original writes. ForceCloseAbandonedAsset copies the asset state before the two maintenance fees and reads the copy's
  open interest after them (the port keeps those two values).
- **Repeated accounts.** A ledger that is the market fails its borrow (AccountBorrowFailed, checked by key);
  CloseSlab refuses the admin as the market (InvalidInstruction); every token account is owner-checked by SPL Token
  before its data is read; a portfolio that is the market is longer than a portfolio and refused by the storage check
  (InvalidAccountLen). The sweeps (percolator-v16-reserves.test.ts, percolator-v16-terminal.test.ts) compare every
  ordered pair of positions.
- **What CloseSlab retires.** `retire_terminal_unbudgeted_insurance_delta` returns `(vault, 0, 0)`, bound as
  `(retired, next_vault, next_insurance)`: the whole accounted vault (the insurance and the claim-free protocol surplus
  above it) is retired and burned (for a native mint, sent to asset 0's insurance authority's canonical account), and
  only tokens beyond the accounted vault are swept to the admin. The contract above the function says so; both binaries
  burn the same amounts.
- **Unauthenticated identities.** ClaimResolvedPayoutTopup takes the owner as any account (no signature): the payout
  goes only to a token account of the recorded owner. A Resolved market's WithdrawInsuranceAsset and
  WithdrawBackingBucket (with no portfolio or capital left) take the beneficiary unsigned the same way and pay only its
  token account, unencumbered.
- **Unreachable checks.** `deposit_fresh_counterparty_backing_not_atomic`'s and the withdrawal's zero amount (the
  handlers refuse it first), the withdrawal's vault underflow and the ledger's principal underflow after the bound was
  checked, `withdraw_domain_insurance_delta`'s underflows (the amount is within the bounds it just checked),
  `encode_terminal_slab_scan_progress`'s refusal (every continuation is below the configured count),
  `kernel_terminal_slab_wait_continuation`'s LockActive when the start itself waits (reachable: a scan parked on a live
  bucket), the native mint's residue path (the tests' mints are not the native mint).

Copies and swallowed errors, function by function:

| Function | What the original does | Finding |
| --- | --- | --- |
| `handle_top_up_insurance`, `handle_top_up_backing_bucket` | the view taken twice, the ledger read into a copy and written after the shape | one view, the ledger in place (above) |
| `handle_withdraw_backing_bucket`, `_earnings`, `handle_withdraw_insurance_asset` | the preflight on an immutable borrow, then the view; the ledger copied | as above |
| `withdraw_fresh_counterparty_backing_not_atomic` | the bucket (with its effective expiry) and the source state by value, written back after the proof | in place after the same checks; the effective expiry written with the bucket |
| `withdraw_backing_provider_earnings_not_atomic` | the bucket by value, written back | in place |
| `handle_close_slab` | the wrapper config by value, written back validated (not written on a refusal) | in place, validated at the same point |
| `handle_force_close_abandoned_asset` | the asset state copied before the fees | the two open-interest values kept |
| `claim_resolved_payout_topup_core_not_atomic` | the receipt decoded, changed, written back | in place after the same checks |

## 16. BatchTradeNoCpi, TradeCpi and BatchTradeCpi: the batch engine and the matcher ABI v3

BatchTradeNoCpi (66) is batch.ts, TradeCpi (10) and BatchTradeCpi (67) are matcher.ts; the engine's batch is trade.ts
`executeBatch`. With them all 50 instructions are ported; percolator.ts has no placeholder left (placeholder.ts is
gone; a decoded tag always reaches its handler).

**What they reach.** The engine's trade was already the batch engine on one request (section 12:
`execute_trade_with_fee_loss_stale_scoped_not_atomic` is `execute_batch_with_fee_loss_stale_scoped_not_atomic` with
`from_ref(&request)`), so the three add no engine function of their own but these, each ported statement by statement:

| Function | What a batch of several requests changes |
| --- | --- |
| `execute_batch_with_fee_loss_stale_scoped_not_atomic` | the loss-stale scope judged for each request in order (the first that touches a loss-stale asset or account ends the scan) |
| `execute_batch_with_fee_after_tail_validation_not_atomic` | NonProgress for none, InvalidConfig past the portfolio cap; every request validated before the refresh; one refresh and H-lock lane for all; one position map per account (`PositionSlotMapV16`) kept across the requests |
| `PositionSlotMapV16::plan_delta` on a map that earlier plans changed | the port's `planDeltaOn` takes the map's occupied slots as a bitmap (`planMapAfter`): a clear frees a slot in the map even where the account keeps the leg (a leg retained as a pending obligation), and a later attach may take that slot, as in the original; every other entry the map holds equals the account's leg (the requests are of distinct assets) |
| `apply_trade_after_refresh_not_atomic` (`applyTradeAfterRefresh`) | the recertification only for a single request; the terminal residual only at the final fill |
| `kernel_accumulate_batch_trade` | the fees and the notional summed (ArithmeticOverflow), the flags or-ed |
| `certify_account_after_local_settlement_with_price_override(account, None)` | both accounts certified once after several fills (liquidation.ts `certifyAfterLocalSettlement`, ported with the crank) |
| `finish_trade_checks_not_atomic` (`finishTradeChecks`) | the margin checks on the accumulated flags |
| `begin_zero_oi_residue_resets` | for each request's asset in order |
| `credit_domain_insurance_budgets_not_atomic` (refresh.ts `creditDomainInsuranceBudgets`) | every credit applied, then every domain's ledger validated, then the market's shape (a single credit validates as it goes) |
| `set_asset_raw_oracle_targets_not_atomic` (engine.ts `setAssetRawOracleTargets`) | every target validated before any is written; the oracle epoch advanced once for the batch |

The processor functions new to the port: `handle_batch_trade_nocpi`, `handle_batch_execute_zero_copy` (and in it
`reserved_source_domains_snapshot_for_trade_view` over several requests, `batch_leg_fee`,
`accumulate_fee_to_domain_budget_credits`, `accumulate_domain_budget_credit`,
`trade_fee_budgeted_amounts_with_mark_externality_view`, `prepare_trade_driven_mark_target_view`), `handle_trade_cpi`,
`handle_batch_trade_cpi`, `mod matcher_abi` (`read_matcher_return`, `validate_matcher_return`,
`validate_atomic_batch_matcher_return`), `matcher_tail_start_or_verify_lp_config`, `validate_matcher_tail`,
`derive_matcher_delegate`, `matcher_lp_account_id`, `invoke_matcher`, `invoke_matcher_batch`,
`accrue_zero_move_funding_before_matcher_view`, `ensure_cpi_trade_portfolios_current_before_matcher` with
`ensure_cpi_trade_asset_lifecycle_before_matcher`, `state::bump_matcher_req_seq`, `state::read_asset_effective_prices`,
`state::read_portfolio_owner_preflight`, `bump_portfolio_position_epoch_after_matcher_fill`,
`global_or_profile_resolve_matured_at_slot`, `policy_v16::adverse_trade_slippage_atoms` and `accumulate_with_cap`.
TradeCpi then runs TradeNoCpi's `handle_trade_nocpi_zero_copy` with the fill (its `account_b_matcher_synchronized`
true, A's backing-fee cap from the instruction and B's from the matcher's answer, the base fee as the rate: the LP
signs nothing), so trading.ts `tradeZeroCopy` now takes both caps and the flag.

What reading the sources showed:

- **TradeCpi's order** (accounts: signer A, market, A, B, the matcher program, its context, the delegate, the tail):
  the seven accounts (NotEnoughAccountKeys), the taker's signature, four writable, three owners; the portfolios
  distinct, the matcher not this program and executable, the context not executable, the matcher's and at least 64
  bytes (InvalidInstruction); both bindings; the market's trade preflight (the asset configured: InvalidInstruction;
  its market id: AssetGenerationMismatch); both portfolios' id and owner preflight; Live (EngineLockActive); the
  asset's profile and the stale windows at the Clock (OracleStale); the fees (InvalidInstruction); the provenance of
  both portfolios (EngineProvenanceMismatch) and the taker as A's owner (Unauthorized); the delegate (InvalidArgument);
  B's matcher sequence (EngineStale), its config enabled for this matcher, context and delegate, and its expiry
  ahead of the Clock (Unauthorized); the base fee within the LP's cap; the tail (at most 32; no signer, none of the
  seven, not this program, nothing it owns); the size and the asset's price (InvalidInstruction); the market's config
  and capacity (`read_market_config_mode_and_capacity`, which also checks the market's length, which the preflight
  does not); the accrual and the currentness before the call; the request id; the call; the answer.
- **BatchTradeCpi** refuses no leg or more than 16 before looking at any account, then reads every leg's price with
  one parse of the market (`read_asset_effective_prices`: the legs distinct, configured, within the portfolio cap) and
  reads the legs' profiles only up to the first whose stale window has matured. It clears its return data before the
  call; the matcher's answers are its return data, which the instruction leaves as the transaction's return data.
- **The answer is read after the call from what the matcher left.** TradeCpi reads the context account's first 64
  bytes (a matcher that shrinks its context below 64 bytes: InvalidAccountData; one that writes nothing leaves the last
  answer, whose request id no longer matches); BatchTradeCpi reads the return data, which must come from the matcher
  itself (a nested call's return data set after the matcher's own is refused) and be exactly 64 bytes a leg.
- **Re-entry.** The matcher receives none of the program's accounts (the tail check), and the runtime refuses a call
  back into the program from the matcher anyway: the rogue matcher's attempt fails in both with the runtime's
  MissingAccount (the program is not among the accounts it was given).
- **The heap.** The reference's allocations around the call (the CPI's metas, data and infos, solana-program 1.18's
  clone of the instruction in `invoke_signed`, the decoded legs, the requests and the per-leg contexts with each leg's
  424-byte profile, the snapshots and fee credits) stay inside the runtime's default 32 KiB frame for the largest
  transactions these instructions can make (14 legs, a tail of up to 32 accounts): the tests send them with no heap
  request, 32, 64 and 256 KiB, alike in both. The port's own heap use there is its CPI scratch and argument copies
  (section 18).

Copies and swallowed errors:

| Function | What the original does | Finding |
| --- | --- | --- |
| `handle_batch_execute_zero_copy` | each leg's oracle profile read into a copy (`leg_ctx`); the zero-move accrual changes the copy (the funding-mark checkpoint, the accepted simulation) and the market; the copy is written back only for a leg whose profile a trade moves (`profile_updates_mark_from_trade_view` at the batch's slot), after its post-trade mark | the port accrues in place and, for a profile it will not write back, puts the profile's bytes back at once (batch.ts `accrueKeepingUnwrittenProfile`): nothing reads them in between (the engine reads no oracle profile; a backing-fee policy, whose fields the only other reader takes, refuses the batch), and the batch's slot, which decides the write-back, does not move during the instruction (every accrual sets the market's slot to the authenticated slot) |
| `handle_batch_execute_zero_copy` | the wrapper config by value; three mark fields set for a price-managed asset 0 whose profile was written, written back validated last | in place, last, as for TradeNoCpi |
| `handle_trade_cpi`, `handle_batch_trade_cpi` | every borrow before the call released; the market's request sequence written through a config copy (`bump_matcher_req_seq`, validated) | in place |
| `accrue_zero_move_funding_before_matcher_view` | the profile read from the view and written back validated, either failure InvalidConfig | in place, the two validations as values (`assetOracleProfileOk`) |

**Possibly a defect of the original (reported, not changed in the port).** BatchTradeNoCpi drops the accrual's
changes to a leg's oracle profile when the profile is not one a trade moves (an AuthMark profile, a hybrid that has not
matured), although the asset's own accrual (its slot, K and F) stays: src/v16_program.rs 8609 accrues into
`oracle_profile`, 8786 `continue`s before `write_oracle_profile_to_view` (8802) for such a leg. TradeNoCpi writes the
same changes back (8377, after its accrual at 8224). The two routes of one economic trade can therefore leave different oracle profiles (a
funding-mark checkpoint not advanced, an accepted simulation's price-move remainder discarded) and later accruals
compute from them. Reachable by BatchTradeNoCpi on an AuthMark or unmatured hybrid asset with funding and open
interest on both sides; the port reproduces it (and the comparison passes through it), it is not demonstrated here to
change a later result.

## 17. Token-value proofs the port does not form

The engine builds a `TokenValueFlowProofV16` after most money moves and validates it (`validate`, v16.rs 7112–7145):
the debits of its value classes must sum to the credits (ArithmeticOverflow on a sum past u128, InvalidConfig when they
differ), and the external quote in less out must equal the vault's change, in its direction (InvalidConfig otherwise).
Where the amounts it is given make the validation impossible to fail, the port does not form the proof (refresh.ts and
reserves.ts say so at the sites). The port is therefore not statement by statement there: the omitted statements are
these checks, and the argument below is why no input reaches their refusals. They are compared only through their
effect, which is none: no refusal of these two handlers can come from the proof, so none appears in the comparison.

- **Withdraw** (`withdraw_not_atomic`, v16.rs 21250–21287; the port's `withdrawEngine`, refresh.ts). After the checks
  the port keeps, `vault = vault_before.checked_sub(amount)` has succeeded, and the proof is
  `account_capital_to_external_out(amount, vault_before, vault)`: one debit of `amount` (AccountCapital) and one
  credit of `amount` (ExternalQuote) on arrays of zeros (each `checked_add` is `0 + amount`: no overflow), so the debit
  and credit totals are both `amount`; external out is `amount`, in is 0. With `amount > 0` the vault fell by exactly
  `amount` (the branch `vault_after < vault_before`: out − in = `amount` = the change); with `amount = 0` the handler
  returned before (`if (amount === 0n) return`, the engine's own early return) and the proof would be the empty one at
  an unchanged vault. No input fails it.
- **WithdrawInsuranceDomain's engine part** (`withdraw_domain_insurance_not_atomic`, v16.rs 12263–12299; the port's
  `withdrawDomainInsurance`, reserves.ts). `withdraw_domain_insurance_delta` returns
  `next_vault = vault.checked_sub(amount)` (after refusing `amount > vault` with LockActive), the vault is set to it,
  and the proof is `insurance_capital_to_external_out(amount, vault_before, next_vault)`: one debit (InsuranceCapital)
  and one credit (ExternalQuote) of `amount`, external out `amount`, the vault lowered by exactly `amount` (or
  unchanged for 0, where in = out = 0 and the change is 0). No input fails it.
- **The other sites** follow the same rule, argued at each port function (kfsettle.ts, liquidation.ts, lifecycle.ts,
  convert.ts, recoveries.ts, resolved.ts, engine.ts): one amount moved between two classes at an unchanged vault, or
  into or out of the vault by exactly the vault's change (recoveries.ts: CureAndCancelClose's proof moves the deposit
  and the escrow into capital with the vault raised by the deposit). `validate_insurance_to_close_insurance_spent`,
  which holds exactly when the two vault values are equal, is also ported as a check
  (primitives.ts `validateInsuranceToCloseInsuranceSpent`).

## 18. The port's heap

The port has no heap values of its own, but it does allocate from the bump heap (TypeSOL's `ts_alloc`, never freed
within a transaction), in three places, all from the generated code (counted in `typesol emit-c` output of this
version):

- **Struct arguments copied from account data.** A struct or array passed from account data to a helper that also takes
  accounts is copied at the call (the helper may change the account; JavaScript passes the value as it was): one
  buffer per call site, allocated on its first use in the transaction. 47 such sites, of 88 to 1,296 bytes, 23,813
  bytes if every one were reached in one transaction (they are spread over different instructions' paths).
- **The CPI account-info list.** `MAX_ACCOUNTS = 255` (percolator.ts, pinocchio's MAX_TX_ACCOUNTS) puts the scratch
  list of a CPI's account infos on the heap: 16 records of 56 bytes (896 bytes) at the first CPI, the list doubled when
  a CPI names more. Every SPL Token Transfer and the matcher calls go through it: a successful Withdraw allocates it.
- **The matcher call's meta list**: at most 34 metas of 16 bytes per call (matcher.ts `matcherMetas`).

The heap the port can use is the runtime's default 32 KiB whatever frame the transaction requests (it declares no
`HEAP_SIZE_KIB`); past it a transaction fails with TypeSOL's out-of-heap error, which no compared transaction did. The
largest batch and matcher transactions (14 legs, a tail of 32 accounts) were also sent with no heap request (the
runtime's 32 KiB frame) and agree with the reference. A static bound below 32 KiB for every path is not established
here.
