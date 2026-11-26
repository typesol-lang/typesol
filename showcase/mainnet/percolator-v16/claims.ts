// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The source-claim burns and the PnL setters of the settlement of open legs (layer 4 of the map in NOTES.md, section
// 10): a portfolio's positive claim in a source domain lowered with the domain's claim bound; the burn of liened face,
// which takes the lien's backing down with it (released, retired from the impaired lane, or consumed for a K/F loss);
// the burn of a whole amount across the portfolio's slots (in slot order, or one domain first); the support a gain could
// realize in a domain; the consumption of source credit for an effective amount (the domain's, or the portfolio's
// unliened claims slot by slot); and the PnL setters, which move the market's positive-PnL totals, attribute an
// increase to a source domain and burn claims for a decrease.
//
// Wired through `settle_account_side_effects_not_atomic` (settlement.ts) into SyncMaintenanceFee and Withdraw, compared
// with the reference binary on generated states with open legs (percolator-v16-refresh.test.ts,
// percolator-v16-walk.test.ts); each function is also compared alone with the original's own function compiled for the
// host on generated markets and portfolios (percolator-v16-primitives.test.ts).
//
// Copies. The original reads a domain's source credit state into a value, changes it and writes it back
// (`set_source_credit_for_domain`), and takes a portfolio slot's snapshot (`source_before`, `source_snapshot`) before
// calls that change only the market; all of it on views of the account data. The port changes the slots in place and
// reads the snapshot's fields from the slot, which nothing changes in between. Every caller of every function here
// propagates its error (NOTES.md section 10 lists them), so a refusal after an in-place change fails the transaction
// as the original's does. `Option<&mut KfLossLienPaymentV16>` is a payment place and a flag (`hasKf`).
import { type Inout, type RemainingAccount, type i128, type u64, type u128, loadRawAt, loadRawMutAt, u64 as toU64, u128 as toU128 } from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import { type BackingBucket, type GroupHeader, type Portfolio, type SourceCreditState, HEADER_LEN, MARKET_GROUP_OFF } from "./state.js";
import { BOUND_SCALE, marketModeErr } from "./wire.js";
import { CREDIT_RATE_SCALE, PORTFOLIO_SOURCE_DOMAIN_CAP, amountFromBoundNum, compactSourceDomains } from "./engine.js";
import {
  boundNumFromAmount,
  mulDivFloorOrWide,
  recomputeSourceCreditForEpoch,
  sourceClaimDomainFirstBurnPartition,
  sourceCreditLienAmounts,
  sourceLienFaceBurnPlan,
  sourceLienFeeAfterRelease,
  sourceRealizableSupport,
} from "./kernels.js";
import {
  type KfLossLienPayment,
  NO_SLOT,
  accountSourceClaimBoundSum,
  bucketAt,
  bucketForDomain,
  bucketRawStatusExpiry,
  collectBackingUtilizationFee,
  consumeCounterpartyLien,
  createAndConsumeCounterpartyCore,
  createAndConsumeCounterpartyParts,
  createAndConsumeInsuranceCore,
  createAndConsumeInsuranceParts,
  domainAssetSide,
  domainHasDefaultTag,
  domainIsOccupied,
  ensureAccountSourceClaimMarketId,
  kfLossLienBackingToConsume,
  recomputeSourceCreditAfterMutations,
  releaseInsuranceLien,
  releaseInsuranceLienTerminal,
  resetSourceDomainSlotIfEmpty,
  setSourceCreditTotals,
  sourceAt,
  sourceClaimUnliened,
  sourceCreditAvailableBacking,
  sourceDomainSlotMut,
  sourceDomainSlotOrInsert,
  sourceForDomain,
  sourceTotalsAt,
  validateDomainLedger,
  validateDomainLedgerCurrent,
} from "./primitives.js";
import { burnImpairedSourceClaimFields, reconcileImpairedCounterpartyLienAtSlot, releaseOrRetireCounterpartyLien } from "./impairment.js";

const U128_MAX_CL: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MIN_CL: i128 = -170141183460469231731687303715884105728n;
const U64_MAX_CL: u64 = 0xffffffffffffffffn;
/** `BackingBucketStatusV16` bytes. */
const BUCKET_FRESH_CL = 1n;
/** `MarketModeV16` bytes. */
const MODE_LIVE_CL = 0n;
const MODE_RESOLVED_CL = 1n;

/** `SourceCreditConsumptionV16`: the face burned (in atoms), the credit consumed from counterparty backing and from
 * insurance. */
export interface SourceCreditConsumption {
  face_burn: u128;
  counterparty_credit_consumed: u128;
  insurance_credit_consumed: u128;
}

/** What `consume_validated_account_source_credit_not_atomic` returns: the consumption, the claim burned (as a bound
 * number; zero unless the account's claims are burned) and the credit consumed. */
export interface AccountCreditConsumption {
  face_burn: u128;
  counterparty_credit_consumed: u128;
  insurance_credit_consumed: u128;
  burned_num: u128;
  consumed: u128;
}

/** The market's mode decoded (InvalidConfig past Recovery). */
export function marketMode(m: RemainingAccount): u64 {
  const mode = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode;
  checkV16(marketModeErr(mode));
  return toU64(mode);
}

/**
 * The source credit state of `domain` (read whole: `source_credit_for_domain`) with `burn` taken off its claim bound
 * (CounterUnderflow) and as much of it as there is off its exact claim, written back (`set_source_credit_for_domain`:
 * the totals moved).
 */
function burnDomainClaimBound(m: RemainingAccount, markets: u64, domain: u64, burn: u128): void {
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  if (s.positive_claim_bound_num < burn) failV16(V16_COUNTER_UNDERFLOW);
  s.positive_claim_bound_num -= burn;
  // burn.min(exact) ≤ exact: its CounterUnderflow cannot fire.
  const exact = s.exact_positive_claim_num;
  s.exact_positive_claim_num = exact - (burn < exact ? burn : exact);
  setSourceCreditTotals(m, markets, domain, old);
}

/**
 * `decrement_account_source_claim_for_domain_not_atomic(account, slot, domain, burn)`: nothing for zero; InvalidLeg
 * past the slots; the slot's claim bound lowered (CounterUnderflow); the domain's claim bound and exact claim lowered;
 * an emptied slot reset; the domain's credit recomputed (one step).
 */
export function decrementSourceClaim(m: RemainingAccount, markets: u64, pa: RemainingAccount, slot: u64, domain: u64, burn: u128): void {
  if (burn === 0n) return;
  if (slot >= PORTFOLIO_SOURCE_DOMAIN_CAP) failV16(V16_INVALID_LEG);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const s = p.source_domains.get(slot);
  if (s.source_claim_bound_num < burn) failV16(V16_COUNTER_UNDERFLOW);
  s.source_claim_bound_num -= burn;
  burnDomainClaimBound(m, markets, domain, burn);
  resetSourceDomainSlotIfEmpty(pa, slot);
  recomputeSourceCreditAfterMutations(m, markets, domain, 1n);
}

/**
 * `burn_account_source_lien_face_not_atomic(account, slot, domain, face_burn, kf_loss)`: nothing for zero; InvalidLeg
 * past the slots. With counterparty lien backing on an Impaired bucket or a Fresh one whose (effective) expiry has
 * come, the lien's utilization fee is collected first. Then (CounterUnderflow for a burn above the liened face) the
 * burn's plan over the counterparty and insurance faces and backing; for a K/F loss, the part of the counterparty
 * backing that moves to the loss's domain, consumed; the rest of it released or retired; the insurance backing
 * released (terminally on a Resolved market); the slot's faces, effective reserve, backing and fee revenue lowered (the
 * fee cursor cleared with the counterparty backing), the health certificate invalidated; the claim decremented; the
 * consumed atoms added to the loss's payment (ArithmeticOverflow).
 */
export function burnSourceLienFace(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  slot: u64,
  domain: u64,
  faceBurn: u128,
  kf: Inout<KfLossLienPayment>,
  hasKf: boolean,
): void {
  if (faceBurn === 0n) return;
  if (slot >= PORTFOLIO_SOURCE_DOMAIN_CAP) failV16(V16_INVALID_LEG);
  if (loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot).source_lien_counterparty_backing_num !== 0n) {
    const expiry = bucketForDomain(m, markets, domain);
    const status = loadRawAt<BackingBucket>(m, bucketAt(domain)).status;
    if (status === 3n || (status === BUCKET_FRESH_CL && expiry <= loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot))
      collectBackingUtilizationFee(m, markets, pa, domain);
  }
  // `source_before`: the slot after the fee; the calls below change only the market, so its fields are read from it.
  const before = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
  if (faceBurn > before.source_claim_liened_num) failV16(V16_COUNTER_UNDERFLOW);
  const cpBackingBefore = before.source_lien_counterparty_backing_num;
  const plan = sourceLienFaceBurnPlan(
    before.source_claim_counterparty_liened_num,
    before.source_claim_insurance_liened_num,
    cpBackingBefore,
    before.source_lien_insurance_backing_num,
    faceBurn,
  );
  let consumed: u128 = 0n;
  if (hasKf && plan.counterparty_backing_release !== 0n)
    consumed = kfLossLienBackingToConsume(m, markets, domain, kf, plan.counterparty_face_burn, plan.counterparty_backing_release);
  if (consumed !== 0n) consumeCounterpartyLien(m, markets, domain, consumed);
  // consumed ≤ the release (the twin's share is bounded by it): the subtraction cannot underflow.
  if (plan.counterparty_backing_release !== consumed) releaseOrRetireCounterpartyLien(m, markets, domain, plan.counterparty_backing_release - consumed);
  if (plan.insurance_backing_release !== 0n) {
    if (marketMode(m) === MODE_RESOLVED_CL) releaseInsuranceLienTerminal(m, markets, domain, plan.insurance_backing_release);
    else releaseInsuranceLien(m, markets, domain, plan.insurance_backing_release);
  }
  const effectiveRelease = plan.backing_release / BOUND_SCALE;
  if (cpBackingBefore < plan.counterparty_backing_release) failV16(V16_COUNTER_UNDERFLOW);
  const cpBackingAfter = cpBackingBefore - plan.counterparty_backing_release;
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const s = p.source_domains.get(slot);
  const feeAfter = sourceLienFeeAfterRelease(s.source_lien_capital_at_risk_fee_revenue, cpBackingBefore, cpBackingAfter);
  if (s.source_claim_liened_num < faceBurn) failV16(V16_COUNTER_UNDERFLOW);
  s.source_claim_liened_num -= faceBurn;
  if (s.source_claim_counterparty_liened_num < plan.counterparty_face_burn) failV16(V16_COUNTER_UNDERFLOW);
  s.source_claim_counterparty_liened_num -= plan.counterparty_face_burn;
  if (s.source_claim_insurance_liened_num < plan.insurance_face_burn) failV16(V16_COUNTER_UNDERFLOW);
  s.source_claim_insurance_liened_num -= plan.insurance_face_burn;
  if (s.source_lien_effective_reserved < effectiveRelease) failV16(V16_COUNTER_UNDERFLOW);
  s.source_lien_effective_reserved -= effectiveRelease;
  s.source_lien_counterparty_backing_num = cpBackingAfter;
  if (s.source_lien_insurance_backing_num < plan.insurance_backing_release) failV16(V16_COUNTER_UNDERFLOW);
  s.source_lien_insurance_backing_num -= plan.insurance_backing_release;
  s.source_lien_capital_at_risk_fee_revenue = feeAfter;
  if (cpBackingAfter === 0n) s.source_lien_fee_last_slot = 0n;
  p.health_cert.valid = 0n;
  decrementSourceClaim(m, markets, pa, slot, domain, faceBurn);
  if (hasKf) {
    const atoms = consumed / BOUND_SCALE;
    if (kf.consumed_atoms > U128_MAX_CL - atoms) failV16(V16_ARITHMETIC_OVERFLOW);
    kf.consumed_atoms += atoms;
  }
}

/**
 * `burn_account_source_claim_at_slot_up_to(account, slot, domain, burn, kf_loss)` → the burn taken (up to the slot's
 * claim bound): nothing for zero; CounterUnderflow past the slots or for a slot that is empty or of another domain; the
 * slot's impaired counterparty lien reconciled; the domain's unliened claim burned first, then liened face, then the
 * impaired claim (on a Resolved market its impaired insurance backing released terminally; the domain's claim bound and
 * exact claim lowered, an emptied slot reset, the credit recomputed); LockActive if any of the target is left.
 */
export function burnSourceClaimAtSlotUpTo(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  slot: u64,
  domain: u64,
  burn: u128,
  kf: Inout<KfLossLienPayment>,
  hasKf: boolean,
): u128 {
  if (burn === 0n) return 0n;
  if (slot >= PORTFOLIO_SOURCE_DOMAIN_CAP) failV16(V16_COUNTER_UNDERFLOW);
  const s0 = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
  if (!domainIsOccupied(s0) || toU64(s0.domain) !== domain) failV16(V16_COUNTER_UNDERFLOW);
  const target = burn < s0.source_claim_bound_num ? burn : s0.source_claim_bound_num;
  let remaining = target;
  reconcileImpairedCounterpartyLienAtSlot(m, markets, pa, slot);
  const unliened = sourceClaimUnliened(pa, domain);
  const free = unliened < remaining ? unliened : remaining;
  if (free !== 0n) {
    decrementSourceClaim(m, markets, pa, slot, domain, free);
    remaining -= free;
  }
  if (remaining !== 0n) {
    const liened = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot).source_claim_liened_num;
    const lienedBurn = liened < remaining ? liened : remaining;
    if (lienedBurn !== 0n) {
      burnSourceLienFace(m, markets, pa, slot, domain, lienedBurn, kf, hasKf);
      remaining -= lienedBurn;
    }
  }
  if (remaining !== 0n) {
    const r = burnImpairedSourceClaimFields(pa, slot, remaining);
    if (r.a !== 0n) {
      if (marketMode(m) === MODE_RESOLVED_CL && r.b !== 0n) releaseInsuranceLienTerminal(m, markets, domain, boundNumFromAmount(r.b));
      burnDomainClaimBound(m, markets, domain, r.a);
      resetSourceDomainSlotIfEmpty(pa, slot);
      recomputeSourceCreditAfterMutations(m, markets, domain, 1n);
      remaining -= r.a;
    }
  }
  if (remaining !== 0n) failV16(V16_LOCK_ACTIVE);
  return target;
}

/**
 * `burn_account_source_claim_bound_num(account, burn, kf_loss)`: nothing for zero or an account without claims;
 * CounterUnderflow for a burn above them; then slot by slot (to the first default empty one, skipping empty ones), each
 * slot's domain checked and burned up to its claim; LockActive if any is left; the slots compacted.
 */
export function burnSourceClaimBoundNum(m: RemainingAccount, markets: u64, pa: RemainingAccount, burn: u128, kf: Inout<KfLossLienPayment>, hasKf: boolean): void {
  if (burn === 0n) return;
  const sum = accountSourceClaimBoundSum(pa);
  if (sum === 0n) return;
  if (sum < burn) failV16(V16_COUNTER_UNDERFLOW);
  let left = burn;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP && left !== 0n; slot++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    if (domainHasDefaultTag(s) && !domainIsOccupied(s)) break;
    if (!domainIsOccupied(s)) continue;
    const d = toU64(s.domain);
    domainAssetSide(m, markets, d);
    const burned = burnSourceClaimAtSlotUpTo(m, markets, pa, slot, d, left, kf, hasKf);
    // burned ≤ left (the target is at most the burn asked): the CounterUnderflow cannot fire.
    left -= burned;
  }
  if (left !== 0n) failV16(V16_LOCK_ACTIVE);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  compactSourceDomains(p.source_domains);
}

/**
 * `burn_account_source_claim_bound_num_domain_first(account, domain, burn)`: nothing for zero; the domain checked; its
 * slot (the mutable view's search) burned first up to its claim, the slots compacted; the rest across all slots.
 */
export function burnSourceClaimDomainFirst(m: RemainingAccount, markets: u64, pa: RemainingAccount, domain: u64, burn: u128): void {
  if (burn === 0n) return;
  domainAssetSide(m, markets, domain);
  const slot = sourceDomainSlotMut(pa, domain);
  const claim = slot === NO_SLOT ? 0n : loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot).source_claim_bound_num;
  const part = sourceClaimDomainFirstBurnPartition(claim, burn);
  const none: KfLossLienPayment = { loss_domain: 0n, loss_side_open: 0n, consumed_atoms: 0n };
  if (slot !== NO_SLOT) {
    burnSourceClaimAtSlotUpTo(m, markets, pa, slot, domain, part.a, none, false);
    const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
    compactSourceDomains(p.source_domains);
  }
  burnSourceClaimBoundNum(m, markets, pa, part.b, none, false);
}

/** `available_backing_num_for_source_credit_state(state)`: the fresh backing beyond its valid liens plus the insurance
 * beyond its liens (InvalidConfig for an encumbrance above either, ArithmeticOverflow). */
export function availableBacking(s: SourceCreditState): u128 {
  if (s.fresh_reserved_backing_num < s.valid_liened_backing_num) failV16(V16_INVALID_CONFIG);
  if (s.valid_liened_insurance_num > U128_MAX_CL - s.impaired_liened_insurance_num) failV16(V16_ARITHMETIC_OVERFLOW);
  const encumbered = s.valid_liened_insurance_num + s.impaired_liened_insurance_num;
  if (s.insurance_credit_reserved_num < encumbered) failV16(V16_INVALID_CONFIG);
  const a = s.fresh_reserved_backing_num - s.valid_liened_backing_num;
  const b = s.insurance_credit_reserved_num - encumbered;
  if (a > U128_MAX_CL - b) failV16(V16_ARITHMETIC_OVERFLOW);
  return a + b;
}

/**
 * `source_domain_prospective_support_for_face(domain, face)`: nothing for zero; the domain's ledger current; nothing
 * unless its bucket is Fresh and not (effectively) expired; else the face at the domain's credit rate (floored, in
 * atoms), bounded by the bucket's fresh unliened backing within the state's available backing (in atoms).
 */
export function sourceDomainProspectiveSupport(m: RemainingAccount, markets: u64, domain: u64, face: u128): u128 {
  if (face === 0n) return 0n;
  validateDomainLedgerCurrent(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const expiry = bucketForDomain(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  if (b.status !== BUCKET_FRESH_CL || expiry <= loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot) return 0n;
  const s = loadRawAt<SourceCreditState>(m, sourceAt(domain));
  const available = availableBacking(s);
  const fresh = b.fresh_unliened_backing_num < available ? b.fresh_unliened_backing_num : available;
  const limited = mulDivFloorOrWide(boundNumFromAmount(face), s.credit_rate_num, CREDIT_RATE_SCALE) / BOUND_SCALE;
  const freshAtoms = fresh / BOUND_SCALE;
  return limited < freshAtoms ? limited : freshAtoms;
}

/**
 * `consume_source_domain_credit_for_effective_not_atomic(domain, effective)`: the domain; nothing for zero; the ledger
 * current; the face and backing the effective credit needs at the domain's rate; LockActive if the domain's available
 * backing is short of it; then created and consumed from a live Fresh bucket holding that much unliened backing, or
 * else from the insurance. The face burned is returned in atoms.
 */
export function consumeSourceDomainCreditForEffective(m: RemainingAccount, markets: u64, domain: u64, effective: u128): SourceCreditConsumption {
  domainAssetSide(m, markets, domain);
  if (effective === 0n) return { face_burn: 0n, counterparty_credit_consumed: 0n, insurance_credit_consumed: 0n };
  validateDomainLedgerCurrent(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const amounts = sourceCreditLienAmounts(effective, loadRawAt<SourceCreditState>(m, sourceAt(domain)).credit_rate_num);
  if (sourceCreditAvailableBacking(m, markets, domain) < amounts.b) failV16(V16_LOCK_ACTIVE);
  const expiry = bucketForDomain(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  let cp: u128 = 0n;
  let ins: u128 = 0n;
  if (b.status === BUCKET_FRESH_CL && expiry > loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot && b.fresh_unliened_backing_num >= amounts.b) {
    createAndConsumeCounterpartyCore(m, markets, domain, amounts.b);
    cp = effective;
  } else {
    createAndConsumeInsuranceCore(m, markets, domain, amounts.b);
    ins = effective;
  }
  return { face_burn: amountFromBoundNum(amounts.a), counterparty_credit_consumed: cp, insurance_credit_consumed: ins };
}

/**
 * `consume_validated_account_source_credit_not_atomic(account, effective, burn_account_claims, require_full)`: nothing
 * for zero; else slot by slot (to the first default empty one, skipping empty ones) while credit is left: a slot
 * without unliened claim only fails closed on a lapsed Fresh bucket (Stale, from its raw status and effective expiry);
 * otherwise its domain's ledger validated (`validate_source_domain_ledger_parts` on the parts read just before), a
 * lapsed Fresh bucket Stale, and at a nonzero credit rate as much as the claim can realize created and consumed (from
 * a live Fresh bucket that holds the backing, else the insurance), the domain's claim and, with `burn_account_claims`,
 * the slot's claim burned by the face. Then InvalidConfig if the sums disagree, LockActive for a partial consumption
 * when the whole was required, the slots compacted after burning.
 *
 * The parts. The original passes `create_and_consume_*_parts_not_atomic` the domain's bucket, source state and
 * reservation as it read them at the top of the slot's turn (`backing_bucket_for_domain`, with the effective expiry;
 * `source_credit_for_domain_shape`; `insurance_reservation_for_domain`), with nothing written in between (the ledger
 * validation and the rate's arithmetic only read): in place, they are the slots.
 */
export function consumeValidatedAccountSourceCredit(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  effective: u128,
  burnClaims: boolean,
  requireFull: boolean,
): AccountCreditConsumption {
  if (effective === 0n) return { face_burn: 0n, counterparty_credit_consumed: 0n, insurance_credit_consumed: 0n, burned_num: 0n, consumed: 0n };
  let remaining = effective;
  let faceBurnNum: u128 = 0n;
  let cp: u128 = 0n;
  let ins: u128 = 0n;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP && remaining !== 0n; slot++) {
    const src = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    if (domainHasDefaultTag(src) && !domainIsOccupied(src)) break;
    if (!domainIsOccupied(src)) continue;
    const d = toU64(src.domain);
    if (src.source_claim_liened_num > U128_MAX_CL - src.source_claim_impaired_num) failV16(V16_ARITHMETIC_OVERFLOW);
    const locked = src.source_claim_liened_num + src.source_claim_impaired_num;
    if (src.source_claim_bound_num < locked) failV16(V16_COUNTER_UNDERFLOW);
    const unliened = src.source_claim_bound_num - locked;
    const now = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
    if (unliened === 0n) {
      const raw = bucketRawStatusExpiry(m, markets, d);
      if (raw.status === BUCKET_FRESH_CL && raw.expiry <= now) failV16(V16_STALE);
      continue;
    }
    // source_credit_for_domain_shape, backing_bucket_for_domain, insurance_reservation_for_domain, domain_asset_side,
    // validate_source_domain_ledger_parts: validate_source_domain_ledger's sequence.
    validateDomainLedger(m, markets, d);
    const expiry = bucketForDomain(m, markets, d);
    const b = loadRawAt<BackingBucket>(m, bucketAt(d));
    if (b.status === BUCKET_FRESH_CL && expiry <= now) failV16(V16_STALE);
    const s = loadRawAt<SourceCreditState>(m, sourceAt(d));
    const rate = s.credit_rate_num;
    if (rate === 0n) continue;
    const consumable = sourceRealizableSupport(s, unliened);
    const take = remaining < consumable ? remaining : consumable;
    if (take === 0n) continue;
    const amounts = sourceCreditLienAmounts(take, rate);
    if (amounts.a > unliened) failV16(V16_COUNTER_UNDERFLOW);
    const claim = src.source_claim_bound_num;
    if (burnClaims && claim < amounts.a) failV16(V16_COUNTER_UNDERFLOW);
    const burnNum = burnClaims ? amounts.a : 0n;
    if (b.status === BUCKET_FRESH_CL && expiry > now && b.fresh_unliened_backing_num >= amounts.b) {
      createAndConsumeCounterpartyParts(m, markets, d, expiry, amounts.b, burnNum);
      if (cp > U128_MAX_CL - take) failV16(V16_ARITHMETIC_OVERFLOW);
      cp += take;
    } else {
      createAndConsumeInsuranceParts(m, markets, d, amounts.b, burnNum);
      if (ins > U128_MAX_CL - take) failV16(V16_ARITHMETIC_OVERFLOW);
      ins += take;
    }
    if (burnClaims) {
      const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
      p.source_domains.get(slot).source_claim_bound_num = claim - amounts.a;
    }
    if (faceBurnNum > U128_MAX_CL - amounts.a) failV16(V16_ARITHMETIC_OVERFLOW);
    faceBurnNum += amounts.a;
    // take ≤ remaining: the CounterUnderflow cannot fire.
    remaining -= take;
  }
  if (cp > U128_MAX_CL - ins) failV16(V16_ARITHMETIC_OVERFLOW);
  const consumed = cp + ins;
  // remaining ≤ effective: the CounterUnderflow of effective − remaining cannot fire.
  if (consumed !== effective - remaining) failV16(V16_INVALID_CONFIG);
  if (requireFull && consumed !== effective) failV16(V16_LOCK_ACTIVE);
  if (burnClaims) {
    const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
    compactSourceDomains(p.source_domains);
  }
  return {
    face_burn: amountFromBoundNum(faceBurnNum),
    counterparty_credit_consumed: cp,
    insurance_credit_consumed: ins,
    burned_num: burnClaims ? faceBurnNum : 0n,
    consumed,
  };
}

// ---- The PnL setters --------------------------------------------------------------------------------------------------

/** No source domain (`None`). */
export const NO_DOMAIN: u64 = U64_MAX_CL;

/**
 * `set_account_pnl_inner(account, new_pnl, source_domain, preburned, kf_loss)`: the new PnL not i128::MIN
 * (ArithmeticOverflow). A positive part that grows (InvalidConfig with a preburned claim): on a Live market an increase
 * needs a source domain (InvalidLeg); the positive totals raised (ArithmeticOverflow); with a domain, the slot's market
 * id ensured, its claim raised, the domain's claim bound and exact claim raised and its credit recomputed (one step).
 * One that shrinks: the claims burned by the decrease less what was preburned (CounterUnderflow), the positive total
 * lowered (CounterUnderflow), the bound total lowered (saturating) but not below the exact total's, the matured total
 * held to the positive total. Then the bound total in atoms, the count of negative accounts moved, the
 * unattributed-loss lock, the PnL, the health certificate invalidated.
 */
export function setAccountPnlInner(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  newPnl: i128,
  sourceDomain: u64,
  preburned: u128,
  kf: Inout<KfLossLienPayment>,
  hasKf: boolean,
): void {
  if (newPnl === I128_MIN_CL) failV16(V16_ARITHMETIC_OVERFLOW);
  const oldPnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  const oldPos: u128 = oldPnl > 0n ? toU128(oldPnl) : 0n;
  const newPos: u128 = newPnl > 0n ? toU128(newPnl) : 0n;
  if (newPos >= oldPos) {
    if (preburned !== 0n) failV16(V16_INVALID_CONFIG);
    const increase = newPos - oldPos;
    const increaseNum = boundNumFromAmount(increase);
    let domain = NO_DOMAIN;
    if (increaseNum !== 0n) {
      if (sourceDomain === NO_DOMAIN && marketMode(m) === MODE_LIVE_CL) failV16(V16_INVALID_LEG);
      domain = sourceDomain;
    }
    const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    if (h.pnl_pos_tot > U128_MAX_CL - increase) failV16(V16_ARITHMETIC_OVERFLOW);
    h.pnl_pos_tot += increase;
    if (h.pnl_pos_bound_tot_num > U128_MAX_CL - increaseNum) failV16(V16_ARITHMETIC_OVERFLOW);
    h.pnl_pos_bound_tot_num += increaseNum;
    if (domain !== NO_DOMAIN) {
      ensureAccountSourceClaimMarketId(m, markets, pa, domain);
      const slot = sourceDomainSlotOrInsert(pa, domain);
      const pp = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
      const ps = pp.source_domains.get(slot);
      if (ps.source_claim_bound_num > U128_MAX_CL - increaseNum) failV16(V16_ARITHMETIC_OVERFLOW);
      ps.source_claim_bound_num += increaseNum;
      sourceForDomain(m, markets, domain);
      const old = sourceTotalsAt(m, domain);
      const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
      if (s.positive_claim_bound_num > U128_MAX_CL - increaseNum) failV16(V16_ARITHMETIC_OVERFLOW);
      s.positive_claim_bound_num += increaseNum;
      if (s.exact_positive_claim_num > U128_MAX_CL - increaseNum) failV16(V16_ARITHMETIC_OVERFLOW);
      s.exact_positive_claim_num += increaseNum;
      const next = recomputeSourceCreditForEpoch(s, h.risk_epoch, 1n);
      setSourceCreditTotals(m, markets, domain, old);
      h.risk_epoch = next;
    }
  } else {
    const decrease = oldPos - newPos;
    const decreaseNum = boundNumFromAmount(decrease);
    if (decreaseNum < preburned) failV16(V16_COUNTER_UNDERFLOW);
    burnSourceClaimBoundNum(m, markets, pa, decreaseNum - preburned, kf, hasKf);
    const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    if (h.pnl_pos_tot < decrease) failV16(V16_COUNTER_UNDERFLOW);
    h.pnl_pos_tot -= decrease;
    const nextBound = h.pnl_pos_bound_tot_num > decreaseNum ? h.pnl_pos_bound_tot_num - decreaseNum : 0n;
    const exactMin = boundNumFromAmount(h.pnl_pos_tot);
    h.pnl_pos_bound_tot_num = nextBound > exactMin ? nextBound : exactMin;
    if (h.pnl_matured_pos_tot > h.pnl_pos_tot) h.pnl_matured_pos_tot = h.pnl_pos_tot;
  }
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  h.pnl_pos_bound_tot = amountFromBoundNum(h.pnl_pos_bound_tot_num);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const oldNegative = p.pnl < 0n;
  const newNegative = newPnl < 0n;
  if (!oldNegative && newNegative) {
    if (h.negative_pnl_account_count === U64_MAX_CL) failV16(V16_COUNTER_OVERFLOW);
    h.negative_pnl_account_count += 1n;
  } else if (oldNegative && !newNegative) {
    if (h.negative_pnl_account_count === 0n) failV16(V16_COUNTER_UNDERFLOW);
    h.negative_pnl_account_count -= 1n;
  }
  // sync_unattributed_loss_lock: the lock decoded (InvalidConfig), then locked while a loss remains and the account was
  // locked or holds more than one active leg.
  if (p.liquidation_lock > 1n) failV16(V16_INVALID_CONFIG);
  const bitmap = p.active_bitmap.get(0n);
  const several = bitmap !== 0n && (bitmap & (bitmap - 1n)) !== 0n;
  p.liquidation_lock = newNegative && (p.liquidation_lock === 1n || several) ? 1n : 0n;
  p.pnl = newPnl;
  p.health_cert.valid = 0n;
}

/** `set_account_pnl(account, new_pnl)`. */
export function setAccountPnl(m: RemainingAccount, markets: u64, pa: RemainingAccount, newPnl: i128): void {
  const none: KfLossLienPayment = { loss_domain: 0n, loss_side_open: 0n, consumed_atoms: 0n };
  setAccountPnlInner(m, markets, pa, newPnl, NO_DOMAIN, 0n, none, false);
}

/** `set_account_pnl_with_source(account, new_pnl, domain)`: the domain checked first. */
export function setAccountPnlWithSource(m: RemainingAccount, markets: u64, pa: RemainingAccount, newPnl: i128, domain: u64): void {
  domainAssetSide(m, markets, domain);
  const none: KfLossLienPayment = { loss_domain: 0n, loss_side_open: 0n, consumed_atoms: 0n };
  setAccountPnlInner(m, markets, pa, newPnl, domain, 0n, none, false);
}

/** `set_account_pnl_after_source_claim_burn(account, new_pnl, preburned)`. */
export function setAccountPnlAfterSourceClaimBurn(m: RemainingAccount, markets: u64, pa: RemainingAccount, newPnl: i128, preburned: u128): void {
  const none: KfLossLienPayment = { loss_domain: 0n, loss_side_open: 0n, consumed_atoms: 0n };
  setAccountPnlInner(m, markets, pa, newPnl, NO_DOMAIN, preburned, none, false);
}

/** `set_account_pnl_after_kf_loss_claim_burn(account, new_pnl, preburned, kf_loss)`. */
export function setAccountPnlAfterKfLossClaimBurn(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  newPnl: i128,
  preburned: u128,
  kf: Inout<KfLossLienPayment>,
  hasKf: boolean,
): void {
  setAccountPnlInner(m, markets, pa, newPnl, NO_DOMAIN, preburned, kf, hasKf);
}

/**
 * `set_account_pnl_after_domain_first_source_claim_burn(account, new_pnl, domain)`: the decrease of the positive part
 * (InvalidConfig for an increase) burned from the domain first, then the PnL set with that burn preburned.
 */
export function setAccountPnlAfterDomainFirstBurn(m: RemainingAccount, markets: u64, pa: RemainingAccount, newPnl: i128, domain: u64): void {
  const oldPnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  const oldPos: u128 = oldPnl > 0n ? toU128(oldPnl) : 0n;
  const newPos: u128 = newPnl > 0n ? toU128(newPnl) : 0n;
  if (oldPos < newPos) failV16(V16_INVALID_CONFIG);
  const decreaseNum = boundNumFromAmount(oldPos - newPos);
  burnSourceClaimDomainFirst(m, markets, pa, domain, decreaseNum);
  setAccountPnlAfterSourceClaimBurn(m, markets, pa, newPnl, decreaseNum);
}
