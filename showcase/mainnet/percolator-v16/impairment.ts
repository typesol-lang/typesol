// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The impaired-lien reconciliation of the settlement of open legs (layer 3 of the map in NOTES.md, section 10): a
// portfolio's counterparty lien on a bucket that has become Impaired (or a lapsed Fresh bucket, expired first) moves
// into the impaired-claim lane, its accrued utilization fee collected and its share of the bucket's impaired
// encumbrance retired; the release-or-retire choice a burned lien takes; the burn of impaired claim fields.
//
// Wired through the settlement of open legs (settlement.ts) into SyncMaintenanceFee and Withdraw, which are compared with
// the reference binary on generated states with open legs; each function is also compared alone with the original's
// own function compiled for the host on generated markets and portfolios (percolator-v16-primitives.test.ts).
//
// Copies. `prepare_account_counterparty_lien_impairment` and `prepare_counterparty_impaired_lien_retirement_delta` take
// a source domain, a bucket and a source credit state by value and their callers write the result back after `?`; the
// port changes the slot in place. Every caller of every function here propagates its error (NOTES.md section 10 lists
// them), so a refusal after an in-place change fails the transaction, as the original's does with its copy unwritten.
import { type Inout, type RemainingAccount, type u64, type u128, loadRawAt, loadRawMutAt, u64 as toU64 } from "typesol";
import {
  V16_COUNTER_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_INVALID_LEG,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type BackingBucket,
  type GroupHeader,
  type Portfolio,
  type PortfolioSourceDomain,
  type SourceCreditState,
  HEADER_LEN,
  MARKET_GROUP_OFF,
} from "./state.js";
import { BOUND_SCALE } from "./wire.js";
import { PORTFOLIO_SOURCE_DOMAIN_CAP, amountFromBoundNum, marketShapeErr } from "./engine.js";
import { type Pair, crystallizeSourceLienFee, recomputeSourceCreditForEpoch, requireAtomAligned } from "./kernels.js";
import {
  NO_SLOT,
  bucketAt,
  bucketForDomain,
  bucketRawStatusExpiry,
  collectBackingUtilizationFee,
  domainAssetSide,
  domainHasDefaultTag,
  domainIsOccupied,
  encumbranceProofForParts,
  expireSourceBackingBucket,
  releaseCounterpartyLienTerminal,
  reservationForDomain,
  setSourceCreditTotals,
  sourceAt,
  sourceDomainSlotMut,
  sourceForDomain,
  sourceTotalsAt,
} from "./primitives.js";

const U128_MAX_I: u128 = 0xffffffffffffffffffffffffffffffffn;
/** `BackingBucketStatusV16` bytes. */
const BUCKET_FRESH_I = 1n;
const BUCKET_EXPIRED_I = 2n;
const BUCKET_IMPAIRED_I = 3n;
/** `MarketModeV16::Live`. */
const MODE_LIVE_I = 0n;

/**
 * `V16Core::prepare_account_counterparty_lien_impairment(source)`: a source domain's counterparty lien moved into the
 * impaired lane: its face from the liened claim to the impaired claim, its backing and effective reserve dropped, its
 * fee revenue's share crystallized, the fee cursor cleared. Nothing for no lien; a face without backing, backing
 * without a face, or backing not in whole atoms is InvalidLeg. Returns the effective amount impaired.
 */
export function prepareCounterpartyLienImpairment(s: Inout<PortfolioSourceDomain>): u128 {
  const face = s.source_claim_counterparty_liened_num;
  const backing = s.source_lien_counterparty_backing_num;
  if (face === 0n && backing === 0n) return 0n;
  if (face === 0n || backing === 0n || backing % BOUND_SCALE !== 0n) failV16(V16_INVALID_LEG);
  // backing is a nonzero multiple of BOUND_SCALE: the effective amount is at least 1 (its `== 0` refusal cannot fire).
  const effective = backing / BOUND_SCALE;
  crystallizeSourceLienFee(s, effective);
  s.source_claim_counterparty_liened_num = 0n;
  if (s.source_claim_liened_num < face) failV16(V16_COUNTER_UNDERFLOW);
  s.source_claim_liened_num -= face;
  if (s.source_claim_impaired_num > U128_MAX_I - face) failV16(V16_COUNTER_OVERFLOW);
  s.source_claim_impaired_num += face;
  s.source_lien_counterparty_backing_num = 0n;
  if (s.source_lien_effective_reserved < effective) failV16(V16_COUNTER_UNDERFLOW);
  s.source_lien_effective_reserved -= effective;
  s.source_lien_fee_last_slot = 0n;
  return effective;
}

/**
 * `V16Core::prepare_counterparty_impaired_lien_retirement_delta(bucket, source, amount)`: an impaired lien's backing
 * retired from an Impaired bucket (atom-aligned; CounterUnderflow unless the bucket is Impaired with nothing fresh or
 * valid and both hold the amount); an emptied bucket becomes Expired.
 */
export function counterpartyImpairedLienRetirement(b: Inout<BackingBucket>, s: Inout<SourceCreditState>, amount: u128): void {
  if (amount === 0n) return;
  requireAtomAligned(amount);
  if (
    b.status !== BUCKET_IMPAIRED_I ||
    b.fresh_unliened_backing_num !== 0n ||
    b.valid_liened_backing_num !== 0n ||
    b.impaired_liened_backing_num < amount ||
    s.impaired_liened_backing_num < amount
  )
    failV16(V16_COUNTER_UNDERFLOW);
  b.impaired_liened_backing_num -= amount;
  s.impaired_liened_backing_num -= amount;
  if (b.impaired_liened_backing_num === 0n) b.status = BUCKET_EXPIRED_I;
}

/**
 * `retire_source_credit_lien_from_counterparty_impaired_not_atomic(domain, amount)`: the domain; nothing for zero; the
 * bucket and the source state whole read; the retirement in place; the recompute (one step); the reservation decoded;
 * the proof on the new parts; the bucket written (earnings unchanged: no total moves; its effective expiry); the
 * source's totals; the risk epoch; the market's shape.
 */
export function retireCounterpartyImpairedLien(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) return;
  const effective = bucketForDomain(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  b.expiry_slot = effective;
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  counterpartyImpairedLienRetirement(b, s, amount);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const next = recomputeSourceCreditForEpoch(s, h.risk_epoch, 1n);
  reservationForDomain(m, markets, domain);
  encumbranceProofForParts(m, markets, domain);
  setSourceCreditTotals(m, markets, domain, old);
  h.risk_epoch = next;
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `release_or_retire_counterparty_lien_backing_not_atomic(domain, amount)`: nothing for zero; a Fresh bucket whose
 * (effective) expiry has come is expired at the market's current slot first; then a Fresh bucket takes the lien back
 * (the terminal release), an Impaired one retires it, anything else is CounterUnderflow.
 */
export function releaseOrRetireCounterpartyLien(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  if (amount === 0n) return;
  const current = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
  const expiry = bucketForDomain(m, markets, domain);
  const first = loadRawAt<BackingBucket>(m, bucketAt(domain));
  if (first.status === BUCKET_FRESH_I && expiry <= current) {
    expireSourceBackingBucket(m, markets, domain, current);
    bucketForDomain(m, markets, domain);
  }
  const status = loadRawAt<BackingBucket>(m, bucketAt(domain)).status;
  if (status === BUCKET_FRESH_I) releaseCounterpartyLienTerminal(m, markets, domain, amount);
  else if (status === BUCKET_IMPAIRED_I) retireCounterpartyImpairedLien(m, markets, domain, amount);
  else failV16(V16_COUNTER_UNDERFLOW);
}

/**
 * `burn_impaired_account_source_claim_fields(account, slot, burn)` → (impaired claim burned, impaired effective reserve
 * burned): the impaired claim (and the bound with it) lowered by up to `burn`; the impaired effective reserve by the
 * burned atoms (all of it when the impaired claim is gone, whose impaired fee revenue is then cleared). InvalidLeg for a
 * slot past the domains.
 */
export function burnImpairedSourceClaimFields(pa: RemainingAccount, slot: u64, burn: u128): Pair {
  if (burn === 0n) return { a: 0n, b: 0n };
  if (slot >= PORTFOLIO_SOURCE_DOMAIN_CAP) failV16(V16_INVALID_LEG);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const s = p.source_domains.get(slot);
  const impairedBurn = s.source_claim_impaired_num < burn ? s.source_claim_impaired_num : burn;
  if (impairedBurn === 0n) return { a: 0n, b: 0n };
  // impairedBurn ≤ the impaired claim: the CounterUnderflow of next_impaired cannot fire.
  const nextImpaired = s.source_claim_impaired_num - impairedBurn;
  if (s.source_claim_bound_num < impairedBurn) failV16(V16_COUNTER_UNDERFLOW);
  s.source_claim_bound_num -= impairedBurn;
  s.source_claim_impaired_num = nextImpaired;
  let effectiveBurn = s.source_lien_impaired_effective_reserved;
  if (nextImpaired !== 0n) {
    const atoms = amountFromBoundNum(impairedBurn);
    if (atoms < effectiveBurn) effectiveBurn = atoms;
  }
  // effectiveBurn ≤ the impaired effective reserve: its CounterUnderflow cannot fire.
  s.source_lien_impaired_effective_reserved -= effectiveBurn;
  if (nextImpaired === 0n) s.source_lien_impaired_capital_at_risk_fee_revenue = 0n;
  return { a: impairedBurn, b: effectiveBurn };
}

/**
 * `impair_account_source_credit_counterparty_lien_fields(account, domain)`: the domain's slot (the mutable view's
 * search; none is InvalidLeg), its counterparty lien impaired in place, the health certificate invalidated. Returns the
 * effective amount impaired.
 */
export function impairAccountCounterpartyLienFields(pa: RemainingAccount, domain: u64): u128 {
  const slot = sourceDomainSlotMut(pa, domain);
  if (slot === NO_SLOT) failV16(V16_INVALID_LEG);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const effective = prepareCounterpartyLienImpairment(p.source_domains.get(slot));
  p.health_cert.valid = 0n;
  return effective;
}

/**
 * `reconcile_account_impaired_counterparty_lien_at_slot_not_atomic(account, slot)`: InvalidLeg past the domains;
 * nothing unless the slot holds counterparty lien backing, is occupied and the market is Live (its mode byte 0); then
 * from the bucket's raw status and effective expiry: nothing unless it is a lapsed Fresh bucket (expired first, at the
 * market's current slot) or Impaired; nothing if the bucket read again is not Impaired; CounterUnderflow when it holds
 * less impaired backing than the lien; else the lien's utilization fee collected, its backing retired from the bucket,
 * and the account's lien fields impaired.
 */
export function reconcileImpairedCounterpartyLienAtSlot(m: RemainingAccount, markets: u64, pa: RemainingAccount, slot: u64): void {
  if (slot >= PORTFOLIO_SOURCE_DOMAIN_CAP) failV16(V16_INVALID_LEG);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const s = p.source_domains.get(slot);
  const backing = s.source_lien_counterparty_backing_num;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (backing === 0n || !domainIsOccupied(s) || h.mode !== MODE_LIVE_I) return;
  const domain = toU64(s.domain);
  const now = h.current_slot;
  const raw = bucketRawStatusExpiry(m, markets, domain);
  const lapsed = raw.status === BUCKET_FRESH_I && raw.expiry <= now;
  if (!lapsed && raw.status !== BUCKET_IMPAIRED_I) return;
  if (lapsed) expireSourceBackingBucket(m, markets, domain, now);
  bucketForDomain(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  if (b.status !== BUCKET_IMPAIRED_I) return;
  if (b.impaired_liened_backing_num < backing) failV16(V16_COUNTER_UNDERFLOW);
  collectBackingUtilizationFee(m, markets, pa, domain);
  retireCounterpartyImpairedLien(m, markets, domain, backing);
  impairAccountCounterpartyLienFields(pa, domain);
}

/**
 * `reconcile_account_impaired_counterparty_liens_not_atomic(account)`: on a Live market (its mode byte 0), each source
 * slot before the first default empty one that holds counterparty lien backing reconciled in order.
 */
export function reconcileImpairedCounterpartyLiens(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  if (loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode !== MODE_LIVE_I) return;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
    const s = p.source_domains.get(slot);
    if (domainHasDefaultTag(s) && !domainIsOccupied(s)) break;
    if (s.source_lien_counterparty_backing_num !== 0n) reconcileImpairedCounterpartyLienAtSlot(m, markets, pa, slot);
  }
}
