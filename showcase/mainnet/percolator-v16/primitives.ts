// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The market-view and portfolio-view accessors of the leaf layer of the settlement of open legs, and the backing and
// lien primitives above them (layers 1 and 2 of the map in NOTES.md, section 10): a domain's source credit state,
// backing bucket (its effective expiry), insurance reservation, provider principal and insurance budget; the market's
// aggregate totals, residual and junior bound; the reservation-encumbrance proof; the source-credit setters and the
// domain recompute; the counterparty and insurance liens' create, consume and release; fresh and loser-paid
// counterparty backing; a Fresh bucket's expiry; the post-snapshot residual; the backing utilization fee; a portfolio's
// sparse source domains, active legs and claim sums.
//
// Wired: `expire_source_backing_bucket_not_atomic` into UpdateAssetLifecycle's retirement (lifecycle.ts), and the rest
// through the settlement of open legs (settlement.ts), which SyncMaintenanceFee and Withdraw run; those are compared
// with the reference binary on generated states with open legs (percolator-v16-refresh.test.ts,
// percolator-v16-walk.test.ts). Each function is also compared alone with the original's own function compiled for the
// host on generated markets and portfolios (showcase/test/percolator-v16-primitives.test.ts).
//
// Views and copies. The original reads a domain's state into values (`source_credit_for_domain`,
// `backing_bucket_for_domain`, `insurance_reservation_for_domain`), changes the values with a delta kernel and writes
// them back with `set_*_for_domain`, all on views of the account data (`MarketGroupV16ViewMut`, `PortfolioV16ViewMut`).
// The port changes the slot in place with the same kernels (kernels.ts) and keeps of the old value only what the setter
// needs (the three amounts of the market's source totals, a bucket's earnings). That is the same bytes because every
// caller of every function here propagates its error (NOTES.md section 10 lists them), so a refusal after an in-place
// change fails the transaction as the original's fails with its copy unwritten, and because each function reads, after
// its in-place change, only what the original reads from its new values. The checks keep the original's order.
//
// A bucket read by `backing_bucket_for_domain` carries the effective expiry (a Resolved market bounds it by the
// resolved slot and the freshness horizon), and `set_backing_bucket_for_domain` writes that expiry back. The port writes
// the effective expiry into the slot where the original's copy takes it and the bucket is certain to be written (or the
// call to fail) after it: never on a path that returns without writing the bucket.
import {
  type Inout,
  type RemainingAccount,
  type u8,
  type u32,
  type u64,
  type u128,
  type u256,
  loadRawAt,
  loadRawMutAt,
  u32 as toU32,
  u64 as toU64,
  u128 as toU128,
  u256 as toU256,
  zeroData,
} from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_HIDDEN_LEG,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type BackingBucket,
  type CloseProgressLedger,
  type EngineAssetSlot,
  type GroupHeader,
  type InsuranceCreditReservation,
  type Portfolio,
  type PortfolioSourceDomain,
  type SourceCreditState,
  HEADER_LEN,
  MARKET_GROUP_OFF,
} from "./state.js";
import { BOUND_SCALE, V16_MAX_PORTFOLIO_ASSETS_N, assetStateErr, backingBucketErr, configShapeErr, insuranceReservationErr, marketModeErr, resolvedPayoutLedgerErr } from "./wire.js";
import { PORTFOLIO_SOURCE_DOMAIN_CAP, amountFromBoundNum, engineSlotAt, legErr, marketShapeErr, sourceCreditErr, sourceCreditShapeErr } from "./engine.js";
import {
  applyBackingUtilizationFeeCharge,
  backingUtilizationFeeQuote,
  boundNumFromAmount,
  counterpartyBackingAdd,
  counterpartyBackingExpiry,
  counterpartyLienConsume,
  counterpartyLienCreate,
  counterpartyLienRelease,
  counterpartyLienTerminalRelease,
  creditPostSnapshotResidual,
  insuranceLienConsume,
  insuranceLienCreate,
  insuranceLienRelease,
  insuranceLienTerminalRelease,
  recomputeSourceCreditForEpoch,
  sourcePositiveClaimBurn,
} from "./kernels.js";

const U64_MAX_PR: u64 = 0xffffffffffffffffn;
const U128_MAX_PR: u128 = 0xffffffffffffffffffffffffffffffffn;
const U128_MAX_PRW: u256 = 340282366920938463463374607431768211455n;
const U32_MAX_PR: u64 = 0xffffffffn;
/** No slot (`None` of an `Option<usize>` slot index). */
export const NO_SLOT: u64 = 0xffffffffffffffffn;
/** `MarketModeV16::Resolved`. */
const MODE_RESOLVED_P: u8 = 1n;
/** `BackingBucketStatusV16` bytes. */
const BUCKET_EMPTY_P: u8 = 0n;
const BUCKET_FRESH_P: u8 = 1n;
const BUCKET_EXPIRED_P: u8 = 2n;
/** Offsets in `EngineAssetSlotV16Account` (the layout table). */
const SOURCE_LONG_AT = 595n;
const SOURCE_SHORT_AT = 779n;
const BACKING_LONG_AT = 963n;
const BACKING_SHORT_AT = 1060n;
const RESERVATION_LONG_AT = 1157n;
const RESERVATION_SHORT_AT = 1229n;
/** Where the portfolio's source domains start in the account (HEADER_LEN + 2,772), and one domain's size. */
const SOURCE_DOMAINS_AT = 2788n;
const SOURCE_DOMAIN_LEN = 196n;

// ---- Domains -------------------------------------------------------------------------------------------------------------

/**
 * `domain_asset_side(domain)`: InvalidLeg at or past the configured domains (`configured_domain_count`, the configured
 * slots doubled: no overflow in 64 bits) or on an asset past the view's slots (`markets`). Returns the asset; the side
 * is the domain's parity (0 long, 1 short).
 */
export function domainAssetSide(m: RemainingAccount, markets: u64, domain: u64): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (domain >= 2n * toU64(h.config.max_market_slots)) failV16(V16_INVALID_LEG);
  const asset = domain / 2n;
  if (asset >= markets) failV16(V16_INVALID_LEG);
  return asset;
}

/** `insurance_domain_index(asset, side)`: the asset configured (InvalidLeg), then `domain_asset_side` of 2·asset + side. */
export function insuranceDomainIndex(m: RemainingAccount, markets: u64, asset: u64, short: boolean): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots)) failV16(V16_INVALID_LEG);
  // asset < 2^32: the checked_mul and checked_add cannot overflow.
  const domain = 2n * asset + (short ? 1n : 0n);
  domainAssetSide(m, markets, domain);
  return domain;
}

/** Where `domain`'s source credit state is (the caller has bounded the domain). */
export function sourceAt(domain: u64): u64 {
  return engineSlotAt(domain / 2n) + (domain % 2n === 1n ? SOURCE_SHORT_AT : SOURCE_LONG_AT);
}
/** Where `domain`'s backing bucket is. */
export function bucketAt(domain: u64): u64 {
  return engineSlotAt(domain / 2n) + (domain % 2n === 1n ? BACKING_SHORT_AT : BACKING_LONG_AT);
}
/** Where `domain`'s insurance reservation is. */
export function reservationAt(domain: u64): u64 {
  return engineSlotAt(domain / 2n) + (domain % 2n === 1n ? RESERVATION_SHORT_AT : RESERVATION_LONG_AT);
}

/** `source_credit_for_domain_shape(domain)`: the domain, then the state's shape (`validate_source_credit_state_shape_static`). */
export function sourceForDomainShape(m: RemainingAccount, markets: u64, domain: u64): void {
  domainAssetSide(m, markets, domain);
  checkV16(sourceCreditShapeErr(loadRawAt<SourceCreditState>(m, sourceAt(domain))));
}

/** `source_credit_for_domain(domain)`: the shape, then `validate_source_credit_state_static` (the shape again, the rate). */
export function sourceForDomain(m: RemainingAccount, markets: u64, domain: u64): void {
  domainAssetSide(m, markets, domain);
  // sourceCreditErr makes the shape check first: the same refusal as the shape read's.
  checkV16(sourceCreditErr(loadRawAt<SourceCreditState>(m, sourceAt(domain))));
}

/** `stored_source_credit_rate_num(domain)`. */
export function storedSourceCreditRate(m: RemainingAccount, markets: u64, domain: u64): u128 {
  domainAssetSide(m, markets, domain);
  return loadRawAt<SourceCreditState>(m, sourceAt(domain)).credit_rate_num;
}

/** `backing_freshness_horizon_slots`: the largest of the accrual window, h_max, the bankrupt-close lifetime and 1. */
export function backingFreshnessHorizon(m: RemainingAccount): u64 {
  const c = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config;
  let v = c.max_accrual_dt_slots;
  if (c.h_max > v) v = c.h_max;
  if (c.max_bankrupt_close_lifetime_slots > v) v = c.max_bankrupt_close_lifetime_slots;
  return v > 1n ? v : 1n;
}

/** `effective_backing_expiry_slot(expiry)`: the mode decoded (InvalidConfig); a Resolved market caps the expiry at
 * resolved_slot + the horizon (saturating). */
export function effectiveBackingExpiry(m: RemainingAccount, expiry: u64): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_RESOLVED_P) return expiry;
  const horizon = backingFreshnessHorizon(m);
  const deadline = h.resolved_slot > U64_MAX_PR - horizon ? U64_MAX_PR : h.resolved_slot + horizon;
  return expiry < deadline ? expiry : deadline;
}

/** `backing_bucket_for_domain(domain)`: the domain, the bucket decoded (`try_to_runtime`), its effective expiry, which
 * is returned (the slot keeps the stored one: see the file's head). */
export function bucketForDomain(m: RemainingAccount, markets: u64, domain: u64): u64 {
  domainAssetSide(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  checkV16(backingBucketErr(b));
  return effectiveBackingExpiry(m, b.expiry_slot);
}

/** The bucket's stored expiry replaced by the effective one, where the original's copy written back carries it. */
function writeEffectiveExpiry(m: RemainingAccount, domain: u64, expiry: u64): void {
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  b.expiry_slot = expiry;
}

export interface StatusExpiry {
  status: u8;
  expiry: u64;
}

/** `backing_bucket_raw_status_expiry_for_domain(domain)`: the raw status byte (undecoded) and the effective expiry. */
export function bucketRawStatusExpiry(m: RemainingAccount, markets: u64, domain: u64): StatusExpiry {
  domainAssetSide(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  return { status: b.status, expiry: effectiveBackingExpiry(m, b.expiry_slot) };
}

/** `insurance_reservation_for_domain(domain)`: the domain, the reservation decoded. */
export function reservationForDomain(m: RemainingAccount, markets: u64, domain: u64): void {
  domainAssetSide(m, markets, domain);
  checkV16(insuranceReservationErr(loadRawAt<InsuranceCreditReservation>(m, reservationAt(domain))));
}

/** `provider_principal_num(domain)`. */
export function providerPrincipal(m: RemainingAccount, markets: u64, domain: u64): u128 {
  const asset = domainAssetSide(m, markets, domain);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  return domain % 2n === 1n ? e.provider_principal_short_num : e.provider_principal_long_num;
}

/** `loser_paid_backing_num(domain)`: the fresh reserved backing beyond the provider principal (saturating). */
export function loserPaidBacking(m: RemainingAccount, markets: u64, domain: u64): u128 {
  const asset = domainAssetSide(m, markets, domain);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const short = domain % 2n === 1n;
  const reserved = short ? e.source_credit_short.fresh_reserved_backing_num : e.source_credit_long.fresh_reserved_backing_num;
  const principal = short ? e.provider_principal_short_num : e.provider_principal_long_num;
  return reserved > principal ? reserved - principal : 0n;
}

export interface BudgetSpent {
  budget: u128;
  spent: u128;
}

/** `domain_insurance_budget_spent(domain)`. */
export function domainInsuranceBudgetSpent(m: RemainingAccount, markets: u64, domain: u64): BudgetSpent {
  const asset = domainAssetSide(m, markets, domain);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  if (domain % 2n === 1n) return { budget: e.insurance_domain_budget_short, spent: e.insurance_domain_spent_short };
  return { budget: e.insurance_domain_budget_long, spent: e.insurance_domain_spent_long };
}

/** `pending_domain_loss_barrier_count(asset, side)`: `insurance_domain_index`, then `domain_asset_side` again (it
 * passed inside the index), then the side's barrier count. */
export function pendingDomainLossBarrierCount(m: RemainingAccount, markets: u64, asset: u64, short: boolean): u64 {
  insuranceDomainIndex(m, markets, asset, short);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  return short ? e.pending_domain_loss_barrier_short : e.pending_domain_loss_barrier_long;
}

/** `has_pending_domain_loss_barrier(asset, side)`. */
export function hasPendingDomainLossBarrier(m: RemainingAccount, markets: u64, asset: u64, short: boolean): boolean {
  return pendingDomainLossBarrierCount(m, markets, asset, short) !== 0n;
}

/** `asset_state(asset)`: the asset configured and in the view (InvalidLeg), decoded (`try_to_runtime`). */
export function assetStateOf(m: RemainingAccount, markets: u64, asset: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  checkV16(assetStateErr(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset));
}

// ---- The market's totals --------------------------------------------------------------------------------------------------

/** `residual()`: the vault less the senior claims (capital, insurance, the providers' earnings, the fresh backing in
 * atoms), every step saturating. */
export function residual(m: RemainingAccount): u128 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  let senior = h.c_tot;
  senior = senior > U128_MAX_PR - h.insurance ? U128_MAX_PR : senior + h.insurance;
  senior = senior > U128_MAX_PR - h.backing_provider_earnings_total ? U128_MAX_PR : senior + h.backing_provider_earnings_total;
  const fresh = h.source_fresh_backing_total_num / BOUND_SCALE;
  senior = senior > U128_MAX_PR - fresh ? U128_MAX_PR : senior + fresh;
  return h.vault > senior ? h.vault - senior : 0n;
}

/** `junior_claim_bound()`. */
export function juniorClaimBound(m: RemainingAccount): u128 {
  return loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).pnl_pos_bound_tot;
}

/** `apply_total_delta(total, old, new)`: total moved by new − old (CounterOverflow up, CounterUnderflow down). */
export function applyTotalDelta(total: u128, old: u128, next: u128): u128 {
  if (next >= old) {
    if (total > U128_MAX_PR - (next - old)) failV16(V16_COUNTER_OVERFLOW);
    return total + (next - old);
  }
  if (total < old - next) failV16(V16_COUNTER_UNDERFLOW);
  return total - (old - next);
}

/** The three amounts of a source credit state the market's totals follow. */
export interface SourceTotals {
  bound: u128;
  insurance_atoms: u128;
  fresh: u128;
}

/** A state's totals, taken before it is changed in place. `amount_from_bound_num` cannot fail. */
export function sourceTotalsAt(m: RemainingAccount, domain: u64): SourceTotals {
  const s = loadRawAt<SourceCreditState>(m, sourceAt(domain));
  return { bound: s.positive_claim_bound_num, insurance_atoms: amountFromBoundNum(s.insurance_credit_reserved_num), fresh: s.fresh_reserved_backing_num };
}

/**
 * `set_source_credit_for_domain(domain, new)` after the caller changed the state in place from one whose totals were
 * `old`: the domain (its `domain_asset_side`), the old state's shape (`source_credit_for_domain_shape`: every caller
 * read the old state with that check or the full one just before changing it, so it passed), then
 * `update_source_credit_aggregate_totals`: the claim bound, the insurance reserved in atoms and the fresh backing
 * totals moved by the change, in that order.
 */
export function setSourceCreditTotals(m: RemainingAccount, markets: u64, domain: u64, old: SourceTotals): void {
  domainAssetSide(m, markets, domain);
  const s = loadRawAt<SourceCreditState>(m, sourceAt(domain));
  const insurance = amountFromBoundNum(s.insurance_credit_reserved_num);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  h.source_claim_bound_total_num = applyTotalDelta(h.source_claim_bound_total_num, old.bound, s.positive_claim_bound_num);
  h.source_insurance_credit_reserved_total_atoms = applyTotalDelta(h.source_insurance_credit_reserved_total_atoms, old.insurance_atoms, insurance);
  h.source_fresh_backing_total_num = applyTotalDelta(h.source_fresh_backing_total_num, old.fresh, s.fresh_reserved_backing_num);
}

/**
 * `set_backing_bucket_for_domain(domain, bucket)` where the caller's bucket is the stored one with its earnings set to
 * `earnings` and its expiry the effective one: the domain, the old bucket decoded again (it was, just before: it
 * passes), `update_backing_aggregate_totals` (the providers' earnings total moved by the change), the bucket written.
 */
export function setBucketEarnings(m: RemainingAccount, markets: u64, domain: u64, earnings: u128, expiry: u64): void {
  domainAssetSide(m, markets, domain);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  h.backing_provider_earnings_total = applyTotalDelta(h.backing_provider_earnings_total, b.utilization_fee_earnings, earnings);
  b.utilization_fee_earnings = earnings;
  b.expiry_slot = expiry;
}

/** `domain_budget_remaining_parts(budget, spent)` (InvalidConfig). */
export function domainBudgetRemainingParts(budget: u128, spent: u128): u128 {
  if (budget < spent) failV16(V16_INVALID_CONFIG);
  return budget - spent;
}

/** `set_domain_insurance_spent_delta(total_remaining, insurance, budget, old_spent, new_spent)`: the remaining total
 * moved by the change of the domain's remaining budget, not above the insurance (LockActive). */
export function setDomainInsuranceSpentDelta(total: u128, insurance: u128, budget: u128, oldSpent: u128, newSpent: u128): u128 {
  const oldRemaining = domainBudgetRemainingParts(budget, oldSpent);
  const newRemaining = domainBudgetRemainingParts(budget, newSpent);
  const next = applyTotalDelta(total, oldRemaining, newRemaining);
  if (next > insurance) failV16(V16_LOCK_ACTIVE);
  return next;
}

/** `set_domain_insurance_spent_core(domain, spent)`. */
export function setDomainInsuranceSpent(m: RemainingAccount, markets: u64, domain: u64, spent: u128): void {
  const asset = domainAssetSide(m, markets, domain);
  // domain_insurance_budget_spent: its domain_asset_side passed just above.
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const short = domain % 2n === 1n;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const budget = short ? e.insurance_domain_budget_short : e.insurance_domain_budget_long;
  const old = short ? e.insurance_domain_spent_short : e.insurance_domain_spent_long;
  h.insurance_domain_budget_remaining_total = setDomainInsuranceSpentDelta(h.insurance_domain_budget_remaining_total, h.insurance, budget, old, spent);
  if (short) e.insurance_domain_spent_short = spent;
  else e.insurance_domain_spent_long = spent;
}

/** `adjust_provider_principal_num(domain, amount, add)`: saturating. */
export function adjustProviderPrincipal(m: RemainingAccount, markets: u64, domain: u64, amount: u128, add: boolean): void {
  const asset = domainAssetSide(m, markets, domain);
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const old = domain % 2n === 1n ? e.provider_principal_short_num : e.provider_principal_long_num;
  let next: u128 = 0n;
  if (add) next = old > U128_MAX_PR - amount ? U128_MAX_PR : old + amount;
  else next = old > amount ? old - amount : 0n;
  if (domain % 2n === 1n) e.provider_principal_short_num = next;
  else e.provider_principal_long_num = next;
}

/** `release_provider_principal_after(domain, before, after)`: the fresh backing that left takes provider principal first. */
export function releaseProviderPrincipalAfter(m: RemainingAccount, markets: u64, domain: u64, before: u128, after: u128): void {
  const left = before > after ? before - after : 0n;
  if (left === 0n) return;
  adjustProviderPrincipal(m, markets, domain, left, false);
}

// ---- Validation of a domain's ledger -----------------------------------------------------------------------------------

/**
 * `ReservationEncumbranceProofV16::validate` on a domain's source state, bucket and reservation (what
 * `reservation_encumbrance_proof_for_domain` and `…_parts` build): the source's amounts equal to the bucket's and the
 * reservation's, the spent backing at least the receivable, the reservation covering its liens, then the source state
 * whole (`validate_source_credit_state_static` with credit epoch 0: an epoch changes nothing that check decides, since
 * a state whose amounts are all zero and rate is the scale passes it on either path).
 */
export function encumbranceProofCheck(s: SourceCreditState, b: BackingBucket, r: InsuranceCreditReservation): void {
  if (b.fresh_unliened_backing_num > U128_MAX_PR - b.valid_liened_backing_num) failV16(V16_ARITHMETIC_OVERFLOW);
  if (
    s.fresh_reserved_backing_num !== b.fresh_unliened_backing_num + b.valid_liened_backing_num ||
    s.provider_receivable_num !== b.consumed_liened_backing_num ||
    s.spent_backing_num < s.provider_receivable_num ||
    s.valid_liened_backing_num !== b.valid_liened_backing_num ||
    s.impaired_liened_backing_num !== b.impaired_liened_backing_num ||
    s.insurance_credit_reserved_num !== r.insurance_credit_reserved_num ||
    s.valid_liened_insurance_num !== r.valid_liened_insurance_num ||
    s.impaired_liened_insurance_num !== r.impaired_liened_insurance_num
  )
    failV16(V16_INVALID_CONFIG);
  if (r.valid_liened_insurance_num > U128_MAX_PR - r.impaired_liened_insurance_num) failV16(V16_ARITHMETIC_OVERFLOW);
  if (r.insurance_credit_reserved_num < r.valid_liened_insurance_num + r.impaired_liened_insurance_num) failV16(V16_INVALID_CONFIG);
  checkV16(sourceCreditErr(s));
}

/** `reservation_encumbrance_proof_for_domain_parts(domain, …)?.validate()` on the stored parts: `domain_asset_side`,
 * the domain as u16 (it is below 2·capacity, far below 2^16), the proof. */
export function encumbranceProofForParts(m: RemainingAccount, markets: u64, domain: u64): void {
  domainAssetSide(m, markets, domain);
  encumbranceProofCheck(
    loadRawAt<SourceCreditState>(m, sourceAt(domain)),
    loadRawAt<BackingBucket>(m, bucketAt(domain)),
    loadRawAt<InsuranceCreditReservation>(m, reservationAt(domain)),
  );
}

/** `reservation_encumbrance_proof_for_domain(domain)?.validate()`: the source state whole, the bucket and the
 * reservation decoded (in that order), the proof. */
export function encumbranceProofForDomain(m: RemainingAccount, markets: u64, domain: u64): void {
  sourceForDomain(m, markets, domain);
  bucketForDomain(m, markets, domain);
  reservationForDomain(m, markets, domain);
  encumbranceProofForParts(m, markets, domain);
}

/** `validate_source_domain_ledger(domain)`: the shape, the bucket (effective expiry), the reservation, the domain again,
 * then `validate_source_domain_ledger_parts` with the asset's market id. */
export function validateDomainLedger(m: RemainingAccount, markets: u64, domain: u64): void {
  sourceForDomainShape(m, markets, domain);
  bucketForDomain(m, markets, domain);
  reservationForDomain(m, markets, domain);
  const asset = domainAssetSide(m, markets, domain);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const s = loadRawAt<SourceCreditState>(m, sourceAt(domain));
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  const r = loadRawAt<InsuranceCreditReservation>(m, reservationAt(domain));
  // validate_source_domain_ledger_parts: the three static checks (the shape passed; the rate is new), then the ids.
  checkV16(sourceCreditErr(s));
  const id = e.asset.market_id;
  if (id === 0n) {
    // The parts equal to EMPTY (the bucket's EMPTY includes its expiry: the effective one, equal to the stored one
    // when the stored one is 0, which EMPTY needs).
    const bucketEmpty =
      b.market_id === 0n &&
      b.fresh_unliened_backing_num === 0n &&
      b.valid_liened_backing_num === 0n &&
      b.consumed_liened_backing_num === 0n &&
      b.impaired_liened_backing_num === 0n &&
      b.utilization_fee_earnings === 0n &&
      b.expiry_slot === 0n &&
      b.status === BUCKET_EMPTY_P;
    const sourceEmpty =
      s.positive_claim_bound_num === 0n &&
      s.exact_positive_claim_num === 0n &&
      s.fresh_reserved_backing_num === 0n &&
      s.spent_backing_num === 0n &&
      s.provider_receivable_num === 0n &&
      s.valid_liened_backing_num === 0n &&
      s.impaired_liened_backing_num === 0n &&
      s.insurance_credit_reserved_num === 0n &&
      s.valid_liened_insurance_num === 0n &&
      s.impaired_liened_insurance_num === 0n &&
      s.credit_rate_num === 1000000000000n &&
      s.credit_epoch === 0n;
    const reservationEmpty =
      r.insurance_credit_reserved_num === 0n &&
      r.valid_liened_insurance_num === 0n &&
      r.impaired_liened_insurance_num === 0n &&
      r.consumed_insurance_num === 0n &&
      r.source_credit_epoch === 0n;
    if (!(sourceEmpty && bucketEmpty && reservationEmpty)) failV16(V16_INVALID_CONFIG);
    return;
  }
  if (b.market_id !== id) failV16(V16_INVALID_CONFIG);
  if (b.fresh_unliened_backing_num > U128_MAX_PR - b.valid_liened_backing_num) failV16(V16_ARITHMETIC_OVERFLOW);
  if (
    s.fresh_reserved_backing_num !== b.fresh_unliened_backing_num + b.valid_liened_backing_num ||
    s.provider_receivable_num !== b.consumed_liened_backing_num ||
    s.valid_liened_backing_num !== b.valid_liened_backing_num ||
    s.impaired_liened_backing_num !== b.impaired_liened_backing_num ||
    s.insurance_credit_reserved_num !== r.insurance_credit_reserved_num ||
    s.valid_liened_insurance_num !== r.valid_liened_insurance_num ||
    s.impaired_liened_insurance_num !== r.impaired_liened_insurance_num
  )
    failV16(V16_INVALID_CONFIG);
}

/** `validate_source_domain_ledger_current(domain)`: the ledger, then a Fresh bucket whose effective expiry has come is
 * Stale. */
export function validateDomainLedgerCurrent(m: RemainingAccount, markets: u64, domain: u64): void {
  validateDomainLedger(m, markets, domain);
  const expiry = bucketForDomain(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  if (b.status === BUCKET_FRESH_P && expiry <= loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot) failV16(V16_STALE);
}

/** `fresh_counterparty_backing_expiry_slot(domain)`: a live Fresh bucket's (effective) expiry, else the config's shape
 * checked and the current slot plus the horizon (CounterOverflow), made effective. */
export function freshCounterpartyBackingExpiry(m: RemainingAccount, markets: u64, domain: u64): u64 {
  domainAssetSide(m, markets, domain);
  const expiry = bucketForDomain(m, markets, domain);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (loadRawAt<BackingBucket>(m, bucketAt(domain)).status === BUCKET_FRESH_P && expiry > h.current_slot) return expiry;
  checkV16(configShapeErr(h.config));
  const horizon = backingFreshnessHorizon(m);
  if (h.current_slot > U64_MAX_PR - horizon) failV16(V16_COUNTER_OVERFLOW);
  return effectiveBackingExpiry(m, h.current_slot + horizon);
}

/** `source_credit_available_backing_num(domain)`: the state whole, then its available backing (which, after the
 * shape check, cannot fail). */
export function sourceCreditAvailableBacking(m: RemainingAccount, markets: u64, domain: u64): u128 {
  sourceForDomain(m, markets, domain);
  const s = loadRawAt<SourceCreditState>(m, sourceAt(domain));
  return s.fresh_reserved_backing_num - s.valid_liened_backing_num + (s.insurance_credit_reserved_num - (s.valid_liened_insurance_num + s.impaired_liened_insurance_num));
}

/** `loss_bucket_accepts_fresh(domain)`: an Empty or Expired bucket, or a Fresh one not yet (effectively) expired. */
export function lossBucketAcceptsFresh(m: RemainingAccount, markets: u64, domain: u64): boolean {
  const expiry = bucketForDomain(m, markets, domain);
  const status = loadRawAt<BackingBucket>(m, bucketAt(domain)).status;
  if (status === BUCKET_EMPTY_P || status === BUCKET_EXPIRED_P) return true;
  if (status === BUCKET_FRESH_P) return expiry > loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
  return false;
}

/**
 * `resolved_loss_backing_capacity_num(domain)`: the support gap (claims beyond the available backing, saturating); once
 * the payout snapshot is captured, that; else unbounded for a live Fresh bucket holding backing or a receivable, and
 * otherwise the gap plus the receivable (ArithmeticOverflow).
 */
export function resolvedLossBackingCapacity(m: RemainingAccount, markets: u64, domain: u64): u128 {
  const available = sourceCreditAvailableBacking(m, markets, domain);
  const s = loadRawAt<SourceCreditState>(m, sourceAt(domain));
  const gap = s.positive_claim_bound_num > available ? s.positive_claim_bound_num - available : 0n;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.payout_snapshot_captured > 1n) failV16(V16_INVALID_CONFIG);
  if (h.payout_snapshot_captured === 1n) return gap;
  const expiry = bucketForDomain(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  if (
    b.status === BUCKET_FRESH_P &&
    expiry > h.current_slot &&
    (b.fresh_unliened_backing_num !== 0n || b.valid_liened_backing_num !== 0n || s.provider_receivable_num !== 0n)
  )
    return U128_MAX_PR;
  if (gap > U128_MAX_PR - s.provider_receivable_num) failV16(V16_ARITHMETIC_OVERFLOW);
  return gap + s.provider_receivable_num;
}

// ---- Source credit recompute ---------------------------------------------------------------------------------------------

/**
 * `recompute_source_credit_domain_after_mutations(domain, steps)` (`…_after_mutation` is one step): the state's shape,
 * the rate recomputed and the credit epoch advanced in place (`prepare_source_credit_domain_recompute_for_epoch_steps`),
 * `set_source_credit_for_domain` (no total moves: only the rate and the epoch changed, so each `apply_total_delta`
 * adds zero and cannot fail), the risk epoch advanced by as many steps.
 */
export function recomputeSourceCreditAfterMutations(m: RemainingAccount, markets: u64, domain: u64, steps: u64): void {
  sourceForDomainShape(m, markets, domain);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  const next = recomputeSourceCreditForEpoch(s, h.risk_epoch, steps);
  // set_source_credit_for_domain: its domain_asset_side and shape read pass (the shape was checked above and only the
  // rate and epoch changed, neither of which the shape bounds beyond the scale, which the recompute keeps).
  h.risk_epoch = next;
}

/** `refresh_source_credit_domain_after_mutation(domain)`: the recompute, the encumbrance proof, the market's shape. */
export function refreshSourceCreditAfterMutation(m: RemainingAccount, markets: u64, domain: u64): void {
  recomputeSourceCreditAfterMutations(m, markets, domain, 1n);
  encumbranceProofForDomain(m, markets, domain);
  checkV16(marketShapeErrOf(m, markets));
}

/** The market's `validate_shape` (engine.ts `marketShapeErr`). */
function marketShapeErrOf(m: RemainingAccount, markets: u64): u64 {
  return marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets);
}

// ---- Counterparty backing ---------------------------------------------------------------------------------------------------

/**
 * `add_fresh_counterparty_backing_steps_unchecked(domain, amount, expiry, steps)` (`add_fresh_counterparty_backing_unchecked`
 * is one step, `add_loser_paid_counterparty_backing_unchecked` and `…_payments_unchecked` call these): the bucket and
 * the source state read (decoded, whole), the deposit (`prepare_counterparty_backing_add_delta` at the market's current
 * slot) in place, the bucket written (its earnings unchanged: no total moves), the source's totals, the recompute, the
 * encumbrance proof.
 */
export function addFreshCounterpartyBacking(m: RemainingAccount, markets: u64, domain: u64, amount: u128, expiry: u64, steps: u64): void {
  const effective = bucketForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  writeEffectiveExpiry(m, domain, effective);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  counterpartyBackingAdd(b, s, amount, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot, expiry);
  // set_backing_bucket_for_domain: the domain and the old bucket pass (read above); the earnings did not change.
  setSourceCreditTotals(m, markets, domain, old);
  recomputeSourceCreditAfterMutations(m, markets, domain, steps);
  encumbranceProofForDomain(m, markets, domain);
}

/**
 * `credit_post_snapshot_residual_not_atomic(released)`: nothing for zero (before the flag is decoded) or without a
 * captured payout snapshot (the flag decoded: InvalidConfig); else the resolved-payout ledger decoded and the released
 * residual credited to it and to the legacy snapshot (`kernel_credit_post_snapshot_residual`).
 */
export function creditPostSnapshotResidualMarket(m: RemainingAccount, released: u128): void {
  if (released === 0n) return;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.payout_snapshot_captured > 1n) failV16(V16_INVALID_CONFIG);
  if (h.payout_snapshot_captured === 0n) return;
  checkV16(resolvedPayoutLedgerErr(h.resolved_payout_ledger));
  h.payout_snapshot = creditPostSnapshotResidual(h.resolved_payout_ledger, h.payout_snapshot, released);
}

/**
 * `expire_source_backing_bucket_not_atomic(domain, now)`: the snapshot flag decoded (InvalidConfig) and the residual
 * before (with a captured snapshot); the source state whole, then the bucket; the expiry (`prepare_counterparty_backing_expiry_delta`:
 * Stale unless a Fresh bucket whose effective expiry has come) in place; the bucket written (earnings unchanged); the
 * source's totals; the provider principal released by the fresh backing that left; the refresh (recompute, proof,
 * shape); then the residual the expiry released (CounterUnderflow) credited after the snapshot.
 */
export function expireSourceBackingBucket(m: RemainingAccount, markets: u64, domain: u64, now: u64): void {
  const flag = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).payout_snapshot_captured;
  if (flag > 1n) failV16(V16_INVALID_CONFIG);
  const captured = flag === 1n;
  const before = captured ? residual(m) : 0n;
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  const effective = bucketForDomain(m, markets, domain);
  writeEffectiveExpiry(m, domain, effective);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  counterpartyBackingExpiry(b, s, now);
  setSourceCreditTotals(m, markets, domain, old);
  releaseProviderPrincipalAfter(m, markets, domain, old.fresh, loadRawAt<SourceCreditState>(m, sourceAt(domain)).fresh_reserved_backing_num);
  refreshSourceCreditAfterMutation(m, markets, domain);
  if (captured) {
    const after = residual(m);
    if (after < before) failV16(V16_COUNTER_UNDERFLOW);
    creditPostSnapshotResidualMarket(m, after - before);
  }
}

// ---- Counterparty liens ---------------------------------------------------------------------------------------------------

/**
 * The common end of the counterparty lien's terminal release, consumption and impaired retirement, after the delta was
 * made in place on the bucket and the source state (`old` the source's totals before): the recompute in place
 * (`prepare_source_credit_domain_recompute_for_epoch`, one step), the reservation decoded, the proof on the new parts,
 * the bucket written (earnings unchanged), the source's totals, the risk epoch. Returns nothing; `shape` adds the
 * market's shape at the end (the terminal release and the retirement).
 */
function finishCounterpartyLien(m: RemainingAccount, markets: u64, domain: u64, old: SourceTotals, shape: boolean): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  const next = recomputeSourceCreditForEpoch(s, h.risk_epoch, 1n);
  reservationForDomain(m, markets, domain);
  encumbranceProofForParts(m, markets, domain);
  // set_backing_bucket_for_domain: the domain and the old bucket pass (read before the delta); no earnings change.
  setSourceCreditTotals(m, markets, domain, old);
  h.risk_epoch = next;
  if (shape) checkV16(marketShapeErrOf(m, markets));
}

/** `release_source_credit_lien_from_counterparty_terminal_not_atomic(domain, amount)`: a valid lien returned to the
 * bucket's unliened backing, whatever the bucket's freshness. */
export function releaseCounterpartyLienTerminal(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  const effective = bucketForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  writeEffectiveExpiry(m, domain, effective);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  counterpartyLienTerminalRelease(b, s, amount);
  finishCounterpartyLien(m, markets, domain, old, true);
}

/**
 * `release_source_credit_lien_from_counterparty_core_not_atomic(domain, amount)` (the crank's release of a flat
 * account's liens): the domain; nothing for zero; the bucket (effective expiry) and the source state whole read; the
 * release at the market's current slot (`prepare_counterparty_lien_release_delta`); the recompute by one step; the
 * reservation decoded and the proof on the new parts; the bucket written (its effective expiry), the source's totals,
 * the risk epoch.
 */
export function releaseCounterpartyLienCore(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  const effective = bucketForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  writeEffectiveExpiry(m, domain, effective);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  counterpartyLienRelease(b, s, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot, amount);
  finishCounterpartyLien(m, markets, domain, old, false);
}

/**
 * `create_source_credit_lien_from_counterparty_core_not_atomic(domain, amount)` (a trade's initial-margin lien): the
 * domain; nothing for zero; the bucket (effective expiry) and the source state whole read; a valid lien created on the
 * bucket's unliened backing at the current slot (`prepare_counterparty_lien_create_delta`: LockActive unless the bucket
 * is Fresh, unexpired and holds the amount); the recompute by one step; the reservation decoded and the proof on the new
 * parts; the bucket written (with its effective expiry), the source's totals, the risk epoch.
 */
export function createCounterpartyLienCore(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  const effective = bucketForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  writeEffectiveExpiry(m, domain, effective);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  counterpartyLienCreate(b, s, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot, amount);
  finishCounterpartyLien(m, markets, domain, old, false);
}

/**
 * `create_source_credit_lien_from_insurance_core_not_atomic(domain, amount)`: the domain; nothing for zero; the
 * reservation decoded and the source state whole read; a valid lien on the reservation's unencumbered part
 * (`prepare_insurance_lien_create_delta`); the recompute, the bucket decoded, the proof, the reservation and the
 * source's totals written, the risk epoch.
 */
export function createInsuranceLienCore(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  reservationForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  const r = loadRawMutAt<InsuranceCreditReservation>(m, reservationAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  insuranceLienCreate(r, s, amount);
  finishInsuranceLien(m, markets, domain, old, false);
}

/** `consume_source_credit_lien_from_counterparty_core_not_atomic(domain, amount)`: a valid lien consumed. */
export function consumeCounterpartyLien(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  const effective = bucketForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  writeEffectiveExpiry(m, domain, effective);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  counterpartyLienConsume(b, s, amount);
  finishCounterpartyLien(m, markets, domain, old, false);
}

/**
 * `create_and_consume_source_credit_from_counterparty_parts_not_atomic(domain, bucket, source, reservation, amount,
 * burn)` on the stored parts (every caller passes the domain's bucket as `backing_bucket_for_domain` reads it, its
 * source state and its reservation, read just before with nothing written in between: the core reads them itself, the
 * two others are checked where they are ported): a lien created at the current slot and consumed at once, the claim
 * bound burned by `burn`, the recompute by one or two steps, the proof, the bucket written, the source's totals, the
 * risk epoch.
 */
export function createAndConsumeCounterpartyParts(m: RemainingAccount, markets: u64, domain: u64, effective: u64, amount: u128, burn: u128): void {
  const old = sourceTotalsAt(m, domain);
  writeEffectiveExpiry(m, domain, effective);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  counterpartyLienCreate(b, s, h.current_slot, amount);
  counterpartyLienConsume(b, s, amount);
  sourcePositiveClaimBurn(s, burn);
  const next = recomputeSourceCreditForEpoch(s, h.risk_epoch, burn !== 0n ? 2n : 1n);
  encumbranceProofForParts(m, markets, domain);
  setSourceCreditTotals(m, markets, domain, old);
  h.risk_epoch = next;
}

/** `create_and_consume_source_credit_from_counterparty_core_not_atomic(domain, amount)`: the domain; nothing for zero;
 * the bucket, the source state whole and the reservation read; the parts function with no burn. */
export function createAndConsumeCounterpartyCore(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  const effective = bucketForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  reservationForDomain(m, markets, domain);
  createAndConsumeCounterpartyParts(m, markets, domain, effective, amount, 0n);
}

// ---- Insurance liens ------------------------------------------------------------------------------------------------------

/** The common end of the insurance lien's releases (the delta made in place on the reservation and the source state):
 * the recompute, the bucket decoded, the proof, the source's totals, the risk epoch, the shape for the terminal one. */
function finishInsuranceLien(m: RemainingAccount, markets: u64, domain: u64, old: SourceTotals, shape: boolean): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  const next = recomputeSourceCreditForEpoch(s, h.risk_epoch, 1n);
  bucketForDomain(m, markets, domain);
  encumbranceProofForParts(m, markets, domain);
  // set_insurance_reservation_for_domain: its domain_asset_side passed; it writes the reservation (changed in place).
  setSourceCreditTotals(m, markets, domain, old);
  h.risk_epoch = next;
  if (shape) checkV16(marketShapeErrOf(m, markets));
}

/** `release_source_credit_lien_from_insurance_core_not_atomic(domain, amount)`. */
export function releaseInsuranceLien(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  reservationForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  const r = loadRawMutAt<InsuranceCreditReservation>(m, reservationAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  insuranceLienRelease(r, s, amount);
  finishInsuranceLien(m, markets, domain, old, false);
}

/** `release_source_credit_lien_from_insurance_terminal_not_atomic(domain, amount)`. */
export function releaseInsuranceLienTerminal(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  reservationForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  const r = loadRawMutAt<InsuranceCreditReservation>(m, reservationAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  insuranceLienTerminalRelease(r, s, amount);
  finishInsuranceLien(m, markets, domain, old, true);
}

/**
 * `create_and_consume_source_credit_from_insurance_parts_not_atomic(domain, bucket, reservation, source, amount, burn)`
 * on the stored parts (as for the counterparty's): a lien created on the reservation and consumed at once (the domain's
 * spent budget and the insurance after it), the claim bound burned, the insurance spent (CounterUnderflow), the
 * recompute, the token-flow proof (insurance to close-insurance-spent at an unchanged vault: it balances), the
 * encumbrance proof, the reservation and the source written, the insurance lowered, the domain's spent budget set, the
 * risk epoch.
 */
export function createAndConsumeInsuranceParts(m: RemainingAccount, markets: u64, domain: u64, amount: u128, burn: u128): void {
  const old = sourceTotalsAt(m, domain);
  const r = loadRawMutAt<InsuranceCreditReservation>(m, reservationAt(domain));
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  insuranceLienCreate(r, s, amount);
  const spentBefore = domainInsuranceBudgetSpent(m, markets, domain).spent;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const insuranceBefore = h.insurance;
  const after = insuranceLienConsume(r, s, spentBefore, insuranceBefore, amount);
  sourcePositiveClaimBurn(s, burn);
  // insurance_before − next_insurance: the consume lowered the insurance by the lien's atoms (it checked them), so
  // the CounterUnderflow cannot fire.
  const next = recomputeSourceCreditForEpoch(s, h.risk_epoch, burn !== 0n ? 2n : 1n);
  // TokenValueFlowProofV16::validate_insurance_to_close_insurance_spent(spend, vault, vault): one debit and one
  // credit of the same amount, no external flow, the vault unchanged: it holds.
  encumbranceProofForParts(m, markets, domain);
  setSourceCreditTotals(m, markets, domain, old);
  h.insurance = after.b;
  setDomainInsuranceSpent(m, markets, domain, after.a);
  h.risk_epoch = next;
}

/** `create_and_consume_source_credit_from_insurance_core_not_atomic(domain, amount)`: the bucket, the reservation and
 * the source state whole read, then the parts function with no burn. */
export function createAndConsumeInsuranceCore(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  bucketForDomain(m, markets, domain);
  reservationForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  createAndConsumeInsuranceParts(m, markets, domain, amount, 0n);
}

/** `TokenValueFlowProofV16::validate_insurance_to_close_insurance_spent(amount, vault_before, vault_after)`: balanced
 * (one debit, one credit of `amount`), no external flow, so it holds exactly when the vault is unchanged. */
export function validateInsuranceToCloseInsuranceSpent(amount: u128, before: u128, after: u128): void {
  if (before !== after) failV16(V16_INVALID_CONFIG);
}

// ---- Losses against backing ---------------------------------------------------------------------------------------------------

/** `face_claim_to_burn_for_support(support, residual, junior)`: ⌈support · junior / residual⌉ below a full residual. */
export function faceClaimToBurnForSupport(support: u128, res: u128, junior: u128): u128 {
  if (support === 0n) return 0n;
  if (res === 0n || junior === 0n) failV16(V16_LOCK_ACTIVE);
  if (res >= junior) return support;
  const p = toU256(support) * toU256(junior);
  const q = p / toU256(res);
  const c = p % toU256(res) === 0n ? q : q + 1n;
  if (c > U128_MAX_PRW) failV16(V16_ARITHMETIC_OVERFLOW);
  return toU128(c);
}

/** `twin_loser_paid_share_num(face_domain, netted, claims)`: ⌈netted · loser-paid / (claims · BOUND_SCALE)⌉ atoms as a
 * bound number, not past the loser-paid backing. */
export function twinLoserPaidShare(m: RemainingAccount, markets: u64, faceDomain: u64, netted: u128, claims: u128): u128 {
  const loser = loserPaidBacking(m, markets, faceDomain);
  if (loser === 0n) return 0n;
  if (claims <= loser) return netted;
  // claims > loser ≥ 1, so the denominator is nonzero; claims · BOUND_SCALE fits 256 bits.
  const p = toU256(netted) * toU256(loser);
  const d = toU256(claims) * toU256(BOUND_SCALE);
  const q = p / d;
  const c = p % d === 0n ? q : q + 1n;
  if (c > U128_MAX_PRW) failV16(V16_ARITHMETIC_OVERFLOW);
  const share = boundNumFromAmount(toU128(c));
  return share < loser ? share : loser;
}

/** `KfLossLienPaymentV16`: the loss's domain, whether it can take backing (0 not known yet, 1 no, 2 yes: the
 * original's `Option<bool>`), the atoms consumed. */
export interface KfLossLienPayment {
  loss_domain: u64;
  loss_side_open: u8;
  consumed_atoms: u128;
}

/**
 * `kf_loss_lien_backing_to_consume_num(face_domain, payment, counterparty_face_burn, counterparty_backing_release)`:
 * how much of a burned counterparty lien's backing moves to the loss's domain (none for the loss's own domain, a face
 * bucket that is not live and Fresh, a loss side closed by a barrier or a bucket that takes no fresh backing, or a
 * barrier on the face's asset); the twin's share is bounded by its loser-paid backing.
 */
export function kfLossLienBackingToConsume(m: RemainingAccount, markets: u64, faceDomain: u64, payment: Inout<KfLossLienPayment>, faceBurn: u128, release: u128): u128 {
  const lossDomain = payment.loss_domain;
  if (faceDomain === lossDomain) return 0n;
  const raw = bucketRawStatusExpiry(m, markets, faceDomain);
  if (raw.status !== BUCKET_FRESH_P || raw.expiry <= loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot) return 0n;
  const lossAsset = domainAssetSide(m, markets, lossDomain);
  const lossShort = lossDomain % 2n === 1n;
  let open = payment.loss_side_open === 2n;
  if (payment.loss_side_open === 0n) {
    open =
      !hasPendingDomainLossBarrier(m, markets, lossAsset, false) &&
      !hasPendingDomainLossBarrier(m, markets, lossAsset, true) &&
      lossBucketAcceptsFresh(m, markets, lossDomain);
    payment.loss_side_open = open ? 2n : 1n;
  }
  if (!open) return 0n;
  const faceAsset = domainAssetSide(m, markets, faceDomain);
  if (faceAsset !== lossAsset && (hasPendingDomainLossBarrier(m, markets, faceAsset, false) || hasPendingDomainLossBarrier(m, markets, faceAsset, true)))
    return 0n;
  const twin = insuranceDomainIndex(m, markets, lossAsset, !lossShort);
  let movable = release;
  if (faceDomain === twin) {
    // The share's arguments: the face burn, then the face domain's source state read whole for its claim bound.
    sourceForDomain(m, markets, faceDomain);
    const share = twinLoserPaidShare(m, markets, faceDomain, faceBurn, loadRawAt<SourceCreditState>(m, sourceAt(faceDomain)).positive_claim_bound_num);
    movable = share < release ? share : release;
  }
  return boundNumFromAmount(movable / BOUND_SCALE);
}

/** `add_account_u128_counter(counter, atoms)`: the counter raised (CounterOverflow); returns its new value. */
export function addAccountCounter(counter: u128, atoms: u128): u128 {
  if (atoms === 0n) return counter;
  if (counter > U128_MAX_PR - atoms) failV16(V16_COUNTER_OVERFLOW);
  return counter + atoms;
}

// ---- A portfolio's source domains ----------------------------------------------------------------------------------------

/** `PortfolioSourceDomainV16Account::is_occupied`. */
export function domainIsOccupied(s: PortfolioSourceDomain): boolean {
  return (
    s.source_claim_bound_num !== 0n ||
    s.source_claim_liened_num !== 0n ||
    s.source_claim_counterparty_liened_num !== 0n ||
    s.source_claim_insurance_liened_num !== 0n ||
    s.source_lien_effective_reserved !== 0n ||
    s.source_lien_counterparty_backing_num !== 0n ||
    s.source_lien_insurance_backing_num !== 0n ||
    s.source_lien_fee_last_slot !== 0n ||
    s.source_claim_impaired_num !== 0n ||
    s.source_lien_impaired_effective_reserved !== 0n ||
    s.source_lien_capital_at_risk_fee_revenue !== 0n ||
    s.source_lien_impaired_capital_at_risk_fee_revenue !== 0n
  );
}

/** `has_default_sparse_tag`. */
export function domainHasDefaultTag(s: PortfolioSourceDomain): boolean {
  return s.domain === 0n && s.source_claim_market_id === 0n;
}

/** `is_sparse_tail_default`. */
export function domainIsSparseTailDefault(s: PortfolioSourceDomain): boolean {
  return domainHasDefaultTag(s) && !domainIsOccupied(s);
}

/** Where source domain `slot` of the portfolio account is. */
export function sourceDomainAt(slot: u64): u64 {
  return SOURCE_DOMAINS_AT + slot * SOURCE_DOMAIN_LEN;
}

/** `PortfolioV16View::source_domain_slot(domain)`: the domain as u32 (ArithmeticOverflow), then the first occupied slot
 * of that domain over all 32; NO_SLOT for none. */
export function sourceDomainSlotView(pa: RemainingAccount, domain: u64): u64 {
  if (domain > U32_MAX_PR) failV16(V16_ARITHMETIC_OVERFLOW);
  const doms = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = doms.source_domains.get(slot);
    if (toU64(s.domain) === domain && domainIsOccupied(s)) return slot;
  }
  return NO_SLOT;
}

/** `PortfolioV16ViewMut::source_domain_slot(domain)`: as the view's, but a slot of the domain with the default tag, or a
 * default empty slot of another domain, ends the search (the compacted tail). */
export function sourceDomainSlotMut(pa: RemainingAccount, domain: u64): u64 {
  if (domain > U32_MAX_PR) failV16(V16_ARITHMETIC_OVERFLOW);
  const doms = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = doms.source_domains.get(slot);
    if (toU64(s.domain) === domain) {
      if (domainIsOccupied(s)) return slot;
      if (domainHasDefaultTag(s)) return NO_SLOT;
    } else if (domainHasDefaultTag(s) && !domainIsOccupied(s)) return NO_SLOT;
  }
  return NO_SLOT;
}

/** `source_domain_slot_or_insert(domain)` (and `source_domain_mut_or_insert`, which returns that slot's place): the
 * domain as u32; the domain's slot, or the first default empty slot tagged with it; LockActive when none is left. */
export function sourceDomainSlotOrInsert(pa: RemainingAccount, domain: u64): u64 {
  if (domain > U32_MAX_PR) failV16(V16_ARITHMETIC_OVERFLOW);
  const doms = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = doms.source_domains.get(slot);
    if (toU64(s.domain) === domain) {
      // Occupied or tagged: this slot. Otherwise the default tag (domain 0, no market id): tagged with 0, unchanged.
      return slot;
    } else if (domainHasDefaultTag(s) && !domainIsOccupied(s)) {
      s.domain = toU32(domain);
      return slot;
    }
  }
  failV16(V16_LOCK_ACTIVE);
  return NO_SLOT;
}

/** `reset_source_domain_slot_if_empty(slot)`: an unoccupied slot that is not the default tag is zeroed; whether it was. */
export function resetSourceDomainSlotIfEmpty(pa: RemainingAccount, slot: u64): boolean {
  if (slot >= PORTFOLIO_SOURCE_DOMAIN_CAP) return false;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const s = p.source_domains.get(slot);
  if (domainIsOccupied(s) || domainHasDefaultTag(s)) return false;
  zeroData(pa, sourceDomainAt(slot), SOURCE_DOMAIN_LEN);
  return true;
}

/** `account_source_claim_bound_sum_num(account)`: the claim bounds of the slots before the first default empty one
 * (ArithmeticOverflow). */
export function accountSourceClaimBoundSum(pa: RemainingAccount): u128 {
  const doms = loadRawAt<Portfolio>(pa, HEADER_LEN);
  let sum: u128 = 0n;
  for (let d = 0n; d < PORTFOLIO_SOURCE_DOMAIN_CAP; d++) {
    const s = doms.source_domains.get(d);
    if (domainHasDefaultTag(s) && !domainIsOccupied(s)) break;
    if (sum > U128_MAX_PR - s.source_claim_bound_num) failV16(V16_ARITHMETIC_OVERFLOW);
    sum += s.source_claim_bound_num;
  }
  return sum;
}

/** `account_has_source_claims(account)`. */
export function accountHasSourceClaims(pa: RemainingAccount): boolean {
  return accountSourceClaimBoundSum(pa) !== 0n;
}

/** `slot_unliened_claim_num(source)`: the bound less the liened and impaired claim (ArithmeticOverflow, CounterUnderflow). */
export function slotUnlienedClaim(s: PortfolioSourceDomain): u128 {
  if (s.source_claim_liened_num > U128_MAX_PR - s.source_claim_impaired_num) failV16(V16_ARITHMETIC_OVERFLOW);
  const locked = s.source_claim_liened_num + s.source_claim_impaired_num;
  if (s.source_claim_bound_num < locked) failV16(V16_COUNTER_UNDERFLOW);
  return s.source_claim_bound_num - locked;
}

/** `source_claim_unliened_num(account, domain)`: the domain's slot (`PortfolioV16View::source_domain`: a missing one is
 * the default record, all zero), then as `slot_unliened_claim_num`. */
export function sourceClaimUnliened(pa: RemainingAccount, domain: u64): u128 {
  const slot = sourceDomainSlotView(pa, domain);
  if (slot === NO_SLOT) return 0n;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  return slotUnlienedClaim(p.source_domains.get(slot));
}

/**
 * `ensure_account_source_claim_market_id(account, domain)`: the domain; the asset's market id nonzero (InvalidLeg); the
 * domain's slot or a new one (`source_domain_mut_or_insert`), tagged with the domain; an untagged market id set, another
 * one HiddenLeg.
 */
export function ensureAccountSourceClaimMarketId(m: RemainingAccount, markets: u64, pa: RemainingAccount, domain: u64): void {
  const asset = domainAssetSide(m, markets, domain);
  const id = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.market_id;
  if (id === 0n) failV16(V16_INVALID_LEG);
  const slot = sourceDomainSlotOrInsert(pa, domain);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const s = p.source_domains.get(slot);
  // u32::try_from(domain): checked by the insert.
  s.domain = toU32(domain);
  if (s.source_claim_market_id === 0n) {
    s.source_claim_market_id = id;
    return;
  }
  if (s.source_claim_market_id !== id) failV16(V16_HIDDEN_LEG);
}

// ---- A portfolio's legs --------------------------------------------------------------------------------------------------------

/** `has_b_stale_leg(account)`: every leg decoded (`try_to_runtime`) in order until an active one marked B-stale. */
export function hasBStaleLeg(pa: RemainingAccount): boolean {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const l = p.legs.get(slot);
    checkV16(legErr(l));
    if (l.active === 1n && l.b_stale === 1n) return true;
  }
  return false;
}

/** `MarketGroupV16ViewMut::active_leg_slot_for_asset(account, asset)`: over the slots whose bitmap bit is set, each leg
 * decoded and active (HiddenLeg), at most one of the asset (HiddenLeg); its slot or NO_SLOT. */
export function activeLegSlotForAssetBitmap(pa: RemainingAccount, asset: u64): u64 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  let found = NO_SLOT;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    if (((bitmap >> slot) & 1n) === 0n) continue;
    const l = p.legs.get(slot);
    checkV16(legErr(l));
    if (l.active !== 1n) failV16(V16_HIDDEN_LEG);
    if (toU64(l.asset_index) === asset) {
      if (found !== NO_SLOT) failV16(V16_HIDDEN_LEG);
      found = slot;
    }
  }
  return found;
}

/** `require_active_leg_slot_for_asset(account, asset)`: InvalidLeg for none. */
export function requireActiveLegSlotForAsset(pa: RemainingAccount, asset: u64): u64 {
  const slot = activeLegSlotForAssetBitmap(pa, asset);
  if (slot === NO_SLOT) failV16(V16_INVALID_LEG);
  return slot;
}

/** `active_leg_for_asset(account, asset)`: the asset's active leg slot, its leg decoded again (it passed in the scan);
 * NO_SLOT stands for `PortfolioLegV16::EMPTY`. */
export function activeLegForAsset(pa: RemainingAccount, asset: u64): u64 {
  const slot = activeLegSlotForAssetBitmap(pa, asset);
  if (slot !== NO_SLOT) {
    const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
    checkV16(legErr(p.legs.get(slot)));
  }
  return slot;
}

/** `CloseProgressLedgerV16::has_pending_residual` on a decoded ledger. */
export function closeHasPendingResidual(c: CloseProgressLedger): boolean {
  return c.active === 1n && c.finalized === 0n && c.canceled === 0n && c.residual_remaining !== 0n;
}

// ---- The backing utilization fee --------------------------------------------------------------------------------------------

/**
 * `collect_account_backing_utilization_fee_for_domain_not_atomic(account, domain)`: the domain; the portfolio's slot of
 * it (none: 0); without counterparty lien backing the fee cursor cleared and an emptied slot reset (0); a cursor never
 * started starts at the current slot (0); else the fee quoted from the cursor to the current slot (bounded by the
 * bucket's effective expiry, if any) on the config's shape and the source state whole; a zero quote leaves the cursor
 * (0); else the cursor moved, the fee charged from the capital (`apply_backing_utilization_fee_charge`), and when
 * anything was charged: the capital, c_tot, the bucket's earnings (`set_backing_bucket_for_domain`, its total), the
 * domain's capital-at-risk fee revenue (CounterOverflow), the health certificate invalidated. Returns the charge.
 */
export function collectBackingUtilizationFee(m: RemainingAccount, markets: u64, pa: RemainingAccount, domain: u64): u128 {
  domainAssetSide(m, markets, domain);
  const slot = sourceDomainSlotMut(pa, domain);
  if (slot === NO_SLOT) return 0n;
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const s = p.source_domains.get(slot);
  const lien = s.source_lien_counterparty_backing_num;
  if (lien === 0n) {
    s.source_lien_fee_last_slot = 0n;
    resetSourceDomainSlotIfEmpty(pa, slot);
    return 0n;
  }
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const last = s.source_lien_fee_last_slot;
  if (last === 0n) {
    s.source_lien_fee_last_slot = h.current_slot;
    return 0n;
  }
  const expiry = bucketForDomain(m, markets, domain);
  const through = expiry === 0n || h.current_slot < expiry ? h.current_slot : expiry;
  checkV16(configShapeErr(h.config));
  sourceForDomain(m, markets, domain);
  const fee = backingUtilizationFeeQuote(h.config, loadRawAt<SourceCreditState>(m, sourceAt(domain)), lien, last, through);
  if (fee === 0n) return 0n;
  s.source_lien_fee_last_slot = through;
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  const charge = applyBackingUtilizationFeeCharge(p.capital, h.c_tot, b.utilization_fee_earnings, p.pnl, fee);
  if (charge.charged === 0n) return 0n;
  p.capital = charge.capital;
  h.c_tot = charge.c_tot;
  setBucketEarnings(m, markets, domain, charge.earnings, expiry);
  if (s.source_lien_capital_at_risk_fee_revenue > U128_MAX_PR - charge.charged) failV16(V16_COUNTER_OVERFLOW);
  s.source_lien_capital_at_risk_fee_revenue += charge.charged;
  p.health_cert.valid = 0n;
  return charge.charged;
}
