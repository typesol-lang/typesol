// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// A Resolved market's close (NOTES.md section 13): the crank's CloseResolved plan (`advance_resolved_slot_not_atomic`,
// the receipt's gain and claim, `first_lapsed_source_backing_for_asset_at_slot`) and `close_resolved_account_not_atomic`
// with its steps: the source domains' preparation (an impaired counterparty lien retired, a lapsed bucket expired, a lien
// released: `release_account_source_credit_lien_for_domain_not_atomic`), a lapsed bucket an active leg touches, the side
// effects and the fee to the resolved slot, the resolved bankruptcy (`settle_resolved_bankruptcy_negative_pnl`,
// `resolved_bankruptcy_attribution`), the solvent legs' detachment, a source domain's realization
// (`realize_one_source_domain_for_resolved_close_not_atomic` with its conversion, the haircut demotion and the payout
// ledger's refinement), the payout ledger and receipt (`initialize_resolved_payout_ledger_if_needed`,
// `create_resolved_payout_receipt_if_needed`, `resolved_receipt_claimable_now`, `apply_resolved_payout_receipt_payment`,
// `clear_fully_diluted_resolved_receipt_if_terminal`) and the payout out of the vault.
//
// Errors. Every caller propagates these functions' errors and the processor maps them and fails, so the port fails in
// place. The two outcomes the original returns as values (a waiting source claim, a preparation step) are values here.
//
// Copies. The original copies a source-domain slot (`account.header.source_domains[slot]`) and reads from the copy only
// fields no step writes before it reads them; the port reads them from the slot first. The payout ledger and the
// receipt are decoded, changed and written back after their checks; in place after the same checks. The unpledged
// source state of `source_claim_converts_to_zero_unpledged` is a real copy (a local), never written back.
import { type Inout, type RemainingAccount, type i128, type u8, type u64, type u128, type u256, loadRawAt, loadRawMutAt, i128 as toI128, u64 as toU64, u128 as toU128, u256 as toU256 } from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_RECOVERY_REQUIRED,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import { type BackingBucket, type EngineAssetSlot, type GroupHeader, type Portfolio, type SourceCreditState, HEADER_LEN, MARKET_GROUP_OFF } from "./state.js";
import { BOUND_SCALE, V16_MAX_PORTFOLIO_ASSETS_N, backingBucketStatusErr, boolErr, closeProgressErr, marketModeErr, resolvedPayoutLedgerErr } from "./wire.js";
import { CREDIT_RATE_SCALE, PORTFOLIO_SOURCE_DOMAIN_CAP, amountFromBoundNum, compactSourceDomains, emptyForDematerialization, engineSlotAt, legErr, marketShapeErr, receiptStaticCheck, validateWithMarket } from "./engine.js";
import { bTargetForLeg, boundNumFromAmount, expectedSourceCreditRate, fSnapResidualIsSubAtom, kfTargetForLeg, legHasExhaustedEffectiveOi, recomputeResolvedPayoutRate, wideMulDivFloorU128 } from "./kernels.js";
import {
  NO_SLOT,
  accountHasSourceClaims,
  bucketAt,
  bucketForDomain,
  closeHasPendingResidual,
  collectBackingUtilizationFee,
  domainAssetSide,
  domainHasDefaultTag,
  domainIsOccupied,
  effectiveBackingExpiry,
  expireSourceBackingBucket,
  hasPendingDomainLossBarrier,
  insuranceDomainIndex,
  juniorClaimBound,
  releaseCounterpartyLienTerminal,
  releaseInsuranceLienTerminal,
  resetSourceDomainSlotIfEmpty,
  residual,
  sourceAt,
  sourceClaimUnliened,
  sourceDomainSlotMut,
  sourceForDomain,
  validateDomainLedgerCurrent,
} from "./primitives.js";
import { impairAccountCounterpartyLienFields, retireCounterpartyImpairedLien } from "./impairment.js";
import { availableBacking, burnSourceClaimDomainFirst, consumeSourceDomainCreditForEffective, setAccountPnl, setAccountPnlAfterSourceClaimBurn } from "./claims.js";
import { beginFullDrainResetInner } from "./kfsettle.js";
import { settleAccountSideEffects } from "./settlement.js";
import { settleNegativePnlFromPrincipal, syncAccountFeeToSlot } from "./refresh.js";
import { absH, effectiveAbsQuantityForLeg } from "./health.js";
import { hasSourceLiens } from "./convert.js";
import { applyPositionDelta, assetSlot, beginCloseProgressLedger, beginZeroOiResidueResets, clearLegAtSlotInner, planDelta } from "./trade.js";
import { DECLARED, advanceCloseLedgerFull, bookResidualForAccount, clampCloseResidual, consumeDomainInsurance } from "./liquidation.js";
import { obligationReleaseAllowed } from "./recovery.js";

const U128_MAX_RS: u128 = 0xffffffffffffffffffffffffffffffffn;
const U128_MAX_RSW: u256 = 340282366920938463463374607431768211455n;
const I128_MAX_RS: u128 = 0x7fffffffffffffffffffffffffffffffn;
/** MarketModeV16::Resolved. */
const MODE_RESOLVED_RS: u8 = 1n;
/** BackingBucketStatusV16: Empty 0, Fresh 1, Expired 2, Impaired 3. */
const BUCKET_EMPTY_RS: u8 = 0n;
const BUCKET_FRESH_RS: u8 = 1n;
const BUCKET_EXPIRED_RS: u8 = 2n;
const BUCKET_IMPAIRED_RS: u8 = 3n;
/** No domain. */
export const NO_DOMAIN_RS: u64 = 0xffffffffffffffffn;

/** `ResolvedSourcePreparationV16` (0: none). */
const PREPARED_NONE = 0n;
const PREPARED_BACKING_NORMALIZED = 1n;
const PREPARED_LIEN_RELEASED = 2n;
/** `ResolvedSourceRealizationV16`. */
const REALIZED_NO_SOURCE_CLAIM = 0n;
const REALIZED_PROCESSED = 1n;
const REALIZED_WAITING = 2n;

/** `ResolvedCloseOutcomeV16`: Closed with its payout, or ProgressOnly (`closed` false). */
export interface ResolvedClose {
  closed: boolean;
  payout: u128;
}

// ---- The market's header -----------------------------------------------------------------------------------------------

/** `validate_header_aggregate_totals` (engine.ts `marketShapeErr` makes the same checks inside the shape). */
export function headerAggregateTotals(m: RemainingAccount): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.c_tot > U128_MAX_RS - h.insurance) failV16(V16_ARITHMETIC_OVERFLOW);
  if (h.c_tot + h.insurance > U128_MAX_RS - h.backing_provider_earnings_total) failV16(V16_ARITHMETIC_OVERFLOW);
  const senior = h.c_tot + h.insurance + h.backing_provider_earnings_total;
  if (senior > h.vault) failV16(V16_INVALID_CONFIG);
  const fresh = h.source_fresh_backing_total_num / BOUND_SCALE;
  if (senior > U128_MAX_RS - fresh) failV16(V16_ARITHMETIC_OVERFLOW);
  if (senior + fresh > h.vault) failV16(V16_INVALID_CONFIG);
  if (h.source_insurance_credit_reserved_total_atoms > h.insurance || h.insurance_domain_budget_remaining_total > h.insurance) failV16(V16_INVALID_CONFIG);
  if (h.pnl_pos_bound_tot_num < h.source_claim_bound_total_num) failV16(V16_INVALID_CONFIG);
}

/** `resolved_positive_payout_ready()`: no B-stale account, stale certificate, negative PnL or payout blocker left. */
export function resolvedPositivePayoutReady(m: RemainingAccount): boolean {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  return h.b_stale_account_count === 0n && h.stale_certificate_count === 0n && h.negative_pnl_account_count === 0n && h.resolved_payout_blocker_count === 0n;
}

/** `advance_resolved_slot_not_atomic(slot)` (`kernel_advance_resolved_slot`): LockActive unless Resolved, Stale for a
 * slot behind the market's; the market's slot moved to it. */
export function advanceResolvedSlot(m: RemainingAccount, slot: u64): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_RESOLVED_RS) failV16(V16_LOCK_ACTIVE);
  if (slot < h.current_slot) failV16(V16_STALE);
  h.current_slot = slot;
}

/**
 * `first_lapsed_source_backing_for_asset_at_slot(asset, now)`: none without fresh backing in the market; InvalidLeg past
 * the configured slots, InvalidConfig past the view; the asset's long then short bucket (its status decoded): the
 * first Fresh one whose effective expiry has come.
 */
export function firstLapsedForAsset(m: RemainingAccount, markets: u64, asset: u64, now: u64): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.source_fresh_backing_total_num === 0n) return NO_DOMAIN_RS;
  if (asset >= toU64(h.config.max_market_slots)) failV16(V16_INVALID_LEG);
  if (asset >= markets) failV16(V16_INVALID_CONFIG);
  for (let side = 0n; side < 2n; side++) {
    const d = 2n * asset + side;
    const b = loadRawAt<BackingBucket>(m, bucketAt(d));
    checkV16(backingBucketStatusErr(b.status));
    if (b.status === BUCKET_FRESH_RS && effectiveBackingExpiry(m, b.expiry_slot) <= now) return d;
  }
  return NO_DOMAIN_RS;
}

// ---- The payout ledger and the receipt ------------------------------------------------------------------------------------

/** `recompute_resolved_payout_rate()`: the ledger decoded, its rate recomputed (`kernel_recompute_resolved_payout_rate`). */
function recomputePayoutRate(m: RemainingAccount): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(resolvedPayoutLedgerErr(h.resolved_payout_ledger));
  recomputeResolvedPayoutRate(h.resolved_payout_ledger);
}

/** `initialize_resolved_payout_ledger_if_needed()`: nothing once the snapshot is captured (the flag decoded); else the
 * residual and the junior claim bound snapshotted, the flag set, the ledger begun (the unreceipted bound the market's
 * positive bound total, the slot the later of the resolved and current slots), its rate computed. */
function initializePayoutLedger(m: RemainingAccount): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(boolErr(h.payout_snapshot_captured));
  if (h.payout_snapshot_captured === 1n) return;
  const snap = residual(m);
  h.payout_snapshot = snap;
  h.payout_snapshot_pnl_pos_tot = juniorClaimBound(m);
  h.payout_snapshot_captured = 1n;
  const l = h.resolved_payout_ledger;
  l.snapshot_residual = snap;
  l.terminal_claim_exact_receipts_num = 0n;
  l.terminal_claim_bound_unreceipted_num = h.pnl_pos_bound_tot_num;
  l.current_payout_rate_num = 0n;
  l.current_payout_rate_den = 0n;
  l.snapshot_slot = h.resolved_slot > h.current_slot ? h.resolved_slot : h.current_slot;
  l.payout_halted = 0n;
  l.finalized = 0n;
  recomputePayoutRate(m);
}

/**
 * `create_resolved_payout_receipt_if_needed(account)`: nothing for a receipt present (decoded); the ledger begun if
 * needed; the positive PnL's bound; a bound above the ledger's unreceipted bound halts the payout (written) and is
 * RecoveryRequired; else moved from the unreceipted to the exact receipts (CounterUnderflow, ArithmeticOverflow), the
 * receipt written, the rate recomputed.
 */
function createReceipt(m: RemainingAccount, pa: RemainingAccount): void {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  checkV16(boolErr(p.resolved_payout_receipt.present));
  if (p.resolved_payout_receipt.present === 1n) return;
  initializePayoutLedger(m);
  const face: u128 = p.pnl > 0n ? toU128(p.pnl) : 0n;
  const prior = boundNumFromAmount(face);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const l = h.resolved_payout_ledger;
  checkV16(resolvedPayoutLedgerErr(l));
  // bound_num_from_amount(face) > prior cannot hold (the same value).
  if (prior > l.terminal_claim_bound_unreceipted_num) {
    l.payout_halted = 1n;
    failV16(V16_RECOVERY_REQUIRED);
  }
  if (l.terminal_claim_exact_receipts_num > U128_MAX_RS - prior) failV16(V16_ARITHMETIC_OVERFLOW);
  l.terminal_claim_bound_unreceipted_num -= prior;
  l.terminal_claim_exact_receipts_num += prior;
  const r = p.resolved_payout_receipt;
  r.present = 1n;
  r.prior_bound_contribution_num = prior;
  r.live_released_face_at_receipt = 0n;
  r.terminal_positive_claim_face = face;
  r.paid_effective = 0n;
  r.finalized = 0n;
  recomputePayoutRate(m);
}

/** `resolved_receipt_claimable_now(receipt)`: the ledger decoded; the receipt's static check; 0 without one;
 * RecoveryRequired while the payout is halted; the face at the current rate (floor) less what was paid (InvalidLeg). */
export function receiptClaimableNow(m: RemainingAccount, pa: RemainingAccount): u128 {
  const l = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).resolved_payout_ledger;
  checkV16(resolvedPayoutLedgerErr(l));
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  receiptStaticCheck(p);
  const r = p.resolved_payout_receipt;
  if (r.present === 0n) return 0n;
  if (l.payout_halted === 1n) failV16(V16_RECOVERY_REQUIRED);
  const gross = wideMulDivFloorU128(r.terminal_positive_claim_face, l.current_payout_rate_num, l.current_payout_rate_den);
  if (gross < r.paid_effective) failV16(V16_INVALID_LEG);
  return gross - r.paid_effective;
}

/** `resolved_receipt_can_still_gain(receipt)` (`kernel_resolved_receipt_can_still_gain`): the ledger decoded; while
 * unreceipted bound remains, yes; at a full rate, no; else whether the best rate the remaining fresh backing could bring
 * (rounded up to whole atoms) pays more than was paid. */
function receiptCanStillGain(m: RemainingAccount, pa: RemainingAccount): boolean {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const l = h.resolved_payout_ledger;
  checkV16(resolvedPayoutLedgerErr(l));
  if (l.terminal_claim_bound_unreceipted_num !== 0n) return true;
  if (l.current_payout_rate_num === l.current_payout_rate_den) return false;
  const fresh = h.source_fresh_backing_total_num;
  if (fresh > U128_MAX_RS - (BOUND_SCALE - 1n)) failV16(V16_ARITHMETIC_OVERFLOW);
  const releasable = ((fresh + BOUND_SCALE - 1n) / BOUND_SCALE) * BOUND_SCALE;
  if (l.current_payout_rate_num > U128_MAX_RS - releasable) failV16(V16_ARITHMETIC_OVERFLOW);
  let best = l.current_payout_rate_num + releasable;
  if (best > l.current_payout_rate_den) best = l.current_payout_rate_den;
  const r = loadRawAt<Portfolio>(pa, HEADER_LEN).resolved_payout_receipt;
  return wideMulDivFloorU128(r.terminal_positive_claim_face, best, l.current_payout_rate_den) > r.paid_effective;
}

/** `clear_fully_diluted_resolved_receipt_if_terminal(account)`: a present, unfinalized receipt (decoded) that can gain
 * nothing more, once the market is payout-ready and nothing is claimable, is cleared. */
export function clearFullyDilutedReceipt(m: RemainingAccount, pa: RemainingAccount): void {
  const r0 = loadRawAt<Portfolio>(pa, HEADER_LEN).resolved_payout_receipt;
  checkV16(boolErr(r0.present));
  checkV16(boolErr(r0.finalized));
  if (r0.present === 0n || r0.finalized === 1n) return;
  if (receiptCanStillGain(m, pa)) return;
  if (!resolvedPositivePayoutReady(m)) return;
  if (receiptClaimableNow(m, pa) !== 0n) return;
  const pv = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const r = pv.resolved_payout_receipt;
  r.prior_bound_contribution_num = 0n;
  r.live_released_face_at_receipt = 0n;
  r.terminal_positive_claim_face = 0n;
  r.paid_effective = 0n;
  r.present = 0n;
  r.finalized = 0n;
}

/** The decoded receipt's checks before a payment (`validate_resolved_payout_receipt_value`). */
function receiptValueCheck(pa: RemainingAccount): void {
  receiptStaticCheck(loadRawAt<Portfolio>(pa, HEADER_LEN));
}

/** `apply_resolved_payout_receipt_payment(receipt, paid)` on the receipt in place: checked; nothing for zero;
 * InvalidLeg without a receipt or for more than its unpaid face; the paid amount raised, finalized when the face is
 * paid in full; checked again. */
export function applyReceiptPayment(pa: RemainingAccount, paid: u128): void {
  receiptValueCheck(pa);
  if (paid === 0n) return;
  const pv = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const r = pv.resolved_payout_receipt;
  if (r.present === 0n) failV16(V16_INVALID_LEG);
  if (r.terminal_positive_claim_face < r.paid_effective) failV16(V16_INVALID_LEG);
  if (paid > r.terminal_positive_claim_face - r.paid_effective) failV16(V16_INVALID_LEG);
  // paid ≤ face − paid_effective: the sum cannot overflow.
  r.paid_effective += paid;
  r.finalized = r.paid_effective === r.terminal_positive_claim_face ? 1n : 0n;
  receiptValueCheck(pa);
}

/**
 * `refine_resolved_unreceipted_bound_not_atomic(decrease)`: LockActive unless Resolved with the snapshot captured (each
 * decoded); the ledger decoded; its unreceipted bound lowered (CounterUnderflow), the rate recomputed; InvalidConfig if
 * the rate fell (`fraction_ge`: InvalidConfig for a zero denominator); the header's aggregate totals.
 */
function refineUnreceiptedBound(m: RemainingAccount, decrease: u128): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_RESOLVED_RS) failV16(V16_LOCK_ACTIVE);
  checkV16(boolErr(h.payout_snapshot_captured));
  if (h.payout_snapshot_captured === 0n) failV16(V16_LOCK_ACTIVE);
  const l = h.resolved_payout_ledger;
  checkV16(resolvedPayoutLedgerErr(l));
  const oldNum = l.current_payout_rate_num;
  const oldDen = l.current_payout_rate_den;
  if (l.terminal_claim_bound_unreceipted_num < decrease) failV16(V16_COUNTER_UNDERFLOW);
  l.terminal_claim_bound_unreceipted_num -= decrease;
  recomputePayoutRate(m);
  checkV16(resolvedPayoutLedgerErr(l));
  if (l.current_payout_rate_den === 0n || oldDen === 0n) failV16(V16_INVALID_CONFIG);
  // Products of two u128 values fit 256 bits.
  if (toU256(l.current_payout_rate_num) * toU256(oldDen) < toU256(oldNum) * toU256(l.current_payout_rate_den)) failV16(V16_INVALID_CONFIG);
  headerAggregateTotals(m);
}

// ---- The source domains -----------------------------------------------------------------------------------------------------

/** The health certificate invalidated. */
function invalidateCert(pa: RemainingAccount): void {
  const pv = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  pv.health_cert.valid = 0n;
}

/** `PortfolioV16ViewMut::compact_source_domains`. */
function compact(pa: RemainingAccount): void {
  const pv = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  compactSourceDomains(pv.source_domains);
}

/**
 * `release_account_source_credit_lien_for_domain_not_atomic(account, domain)`: the domain's slot (the mutable view's
 * search; InvalidLeg for none); its counterparty and insurance lien backing released terminally (whatever the bucket's
 * expiry); the slot's eight lien fields zeroed; the slot reset if empty.
 */
function releaseAccountLienForDomain(m: RemainingAccount, markets: u64, pa: RemainingAccount, d: u64): void {
  const slot = sourceDomainSlotMut(pa, d);
  if (slot === NO_SLOT) failV16(V16_INVALID_LEG);
  const s0 = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
  const cp = s0.source_lien_counterparty_backing_num;
  const ins = s0.source_lien_insurance_backing_num;
  if (cp !== 0n) releaseCounterpartyLienTerminal(m, markets, d, cp);
  if (ins !== 0n) releaseInsuranceLienTerminal(m, markets, d, ins);
  const pv = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const s = pv.source_domains.get(slot);
  s.source_claim_liened_num = 0n;
  s.source_claim_counterparty_liened_num = 0n;
  s.source_claim_insurance_liened_num = 0n;
  s.source_lien_effective_reserved = 0n;
  s.source_lien_counterparty_backing_num = 0n;
  s.source_lien_insurance_backing_num = 0n;
  s.source_lien_fee_last_slot = 0n;
  s.source_lien_capital_at_risk_fee_revenue = 0n;
  resetSourceDomainSlotIfEmpty(pa, slot);
}

/** The end of a preparation step: the certificate invalidated where the original does, the market's shape, the account
 * validated with the market. */
function stepDone(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, pa, markets);
}

/**
 * `prepare_one_source_domain_for_resolved_close_not_atomic(account)`: nothing without source claims; the domains
 * compacted; the first occupied domain (before the compacted tail) whose bucket (decoded, its effective expiry) is
 * Impaired under the account's counterparty lien (CounterUnderflow for less impaired backing than the lien: the
 * utilization fee collected, the impaired lien retired, the account's lien impaired), Fresh and lapsed (expired), or
 * that carries a lien (released): one such step, then the shape and the account's check. Returns the step.
 */
function prepareOneSourceDomain(m: RemainingAccount, markets: u64, pa: RemainingAccount): u64 {
  if (!accountHasSourceClaims(pa)) return PREPARED_NONE;
  compact(pa);
  const now = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) break;
    if (!occupied) continue;
    const d = toU64(s.domain);
    domainAssetSide(m, markets, d);
    const expiry = bucketForDomain(m, markets, d);
    const b = loadRawAt<BackingBucket>(m, bucketAt(d));
    const cp = s.source_lien_counterparty_backing_num;
    const liened = s.source_claim_liened_num;
    if (cp !== 0n && b.status === BUCKET_IMPAIRED_RS) {
      if (b.impaired_liened_backing_num < cp) failV16(V16_COUNTER_UNDERFLOW);
      collectBackingUtilizationFee(m, markets, pa, d);
      retireCounterpartyImpairedLien(m, markets, d, cp);
      impairAccountCounterpartyLienFields(pa, d);
      stepDone(m, markets, pa);
      return PREPARED_BACKING_NORMALIZED;
    }
    if (b.status === BUCKET_FRESH_RS && expiry <= now) {
      expireSourceBackingBucket(m, markets, d, now);
      compact(pa);
      invalidateCert(pa);
      stepDone(m, markets, pa);
      return PREPARED_BACKING_NORMALIZED;
    }
    if (liened !== 0n) {
      releaseAccountLienForDomain(m, markets, pa, d);
      compact(pa);
      invalidateCert(pa);
      stepDone(m, markets, pa);
      return PREPARED_LIEN_RELEASED;
    }
  }
  return PREPARED_NONE;
}

/** `expire_one_lapsed_source_backing_for_resolved_active_leg_not_atomic(account)`: for each active leg (decoded), its
 * asset's long then short domain (checked; the bucket decoded): the first Fresh, lapsed bucket expired. */
function expireOneLapsedForActiveLeg(m: RemainingAccount, markets: u64, pa: RemainingAccount): boolean {
  const now = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) continue;
    const asset = toU64(leg.asset_index);
    for (let side = 0n; side < 2n; side++) {
      const d = insuranceDomainIndex(m, markets, asset, side === 1n);
      const expiry = bucketForDomain(m, markets, d);
      if (loadRawAt<BackingBucket>(m, bucketAt(d)).status === BUCKET_FRESH_RS && expiry <= now) {
        expireSourceBackingBucket(m, markets, d, now);
        return true;
      }
    }
  }
  return false;
}

/** `source_claim_whole_atom_conversion(state, claim)`: the claim at the state's credit rate (256 bits; past u128
 * ArithmeticOverflow), in whole atoms, at most the available backing in whole atoms. */
function wholeAtomConversion(s: SourceCreditState, claim: u128): u128 {
  const credited: u256 = (toU256(claim) * toU256(s.credit_rate_num)) / toU256(CREDIT_RATE_SCALE);
  if (credited > U128_MAX_RSW) failV16(V16_ARITHMETIC_OVERFLOW);
  const atoms = toU128(credited) / BOUND_SCALE;
  const available = availableBacking(s) / BOUND_SCALE;
  return atoms < available ? atoms : available;
}

/** `source_claim_converts_to_zero_unpledged(domain, claim)`: the domain's source state (checked) as a copy with its
 * valid liens released and its rate recomputed for that; whether the claim converts to zero against it. */
function convertsToZeroUnpledged(m: RemainingAccount, markets: u64, d: u64, claim: u128): boolean {
  sourceForDomain(m, markets, d);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(d / 2n));
  const u: SourceCreditState = d % 2n === 1n ? e.source_credit_short : e.source_credit_long;
  u.valid_liened_backing_num = 0n;
  u.valid_liened_insurance_num = 0n;
  u.credit_rate_num = expectedSourceCreditRate(u);
  return wholeAtomConversion(u, claim) === 0n;
}

/**
 * `source_domain_terminal_for_haircut_demote(domain, retiring_source, claim)`: the domain; its bucket (decoded); final
 * when Expired or Impaired, or the retiring claim (slot `slot`) holds impaired claim; the asset decoded; final for an
 * Empty bucket on a Resolved market with no stored legs, stale accounts or obligations on the loss side; final on a
 * payout-ready Resolved market when the claim converts to zero even unpledged; else only when no other claim on the
 * domain remains (CounterUnderflow) and the creditor side holds no stored legs or obligations.
 */
function terminalForHaircutDemote(m: RemainingAccount, markets: u64, pa: RemainingAccount, d: u64, slot: u64, claim: u128): boolean {
  const asset = domainAssetSide(m, markets, d);
  const lossShort = d % 2n === 1n;
  bucketForDomain(m, markets, d);
  const status = loadRawAt<BackingBucket>(m, bucketAt(d)).status;
  if (status === BUCKET_EXPIRED_RS || status === BUCKET_IMPAIRED_RS) return true;
  const retiring = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
  if (retiring.source_claim_impaired_num !== 0n) return true;
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (status === BUCKET_EMPTY_RS) {
    checkV16(marketModeErr(h.mode));
    const quiet = lossShort
      ? a.stored_pos_count_short === 0n && a.stale_account_count_short === 0n && a.pending_obligation_count_short === 0n
      : a.stored_pos_count_long === 0n && a.stale_account_count_long === 0n && a.pending_obligation_count_long === 0n;
    if (h.mode === MODE_RESOLVED_RS && quiet) return true;
  }
  checkV16(marketModeErr(h.mode));
  if (h.mode === MODE_RESOLVED_RS && resolvedPositivePayoutReady(m) && convertsToZeroUnpledged(m, markets, d, claim)) return true;
  sourceForDomain(m, markets, d);
  const bound = loadRawAt<SourceCreditState>(m, sourceAt(d)).positive_claim_bound_num;
  const retiringBound = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot).source_claim_bound_num;
  if (bound < retiringBound) failV16(V16_COUNTER_UNDERFLOW);
  if (bound !== retiringBound) return false;
  return lossShort
    ? a.stored_pos_count_long === 0n && a.pending_obligation_count_long === 0n
    : a.stored_pos_count_short === 0n && a.pending_obligation_count_short === 0n;
}

/**
 * `apply_released_pnl_conversion_with_consumption_core_not_atomic(account, pos, converted, consumption, 0,
 * RetainHaircutFaceForTerminalDomain { domain, claim })`: InvalidConfig for nothing converted or more than the released
 * PnL, or (`kernel_released_pnl_conversion_partition`) for a conversion above the face burned or a face burned above
 * the positive PnL; the PnL debited by the amount converted only; the domain's whole source claim burned (domain
 * first), the PnL set with the debit's bound preburned; the capital and c_tot raised (ArithmeticOverflow), the matured
 * positive total lowered (saturating); the protocol surplus consumed (CounterUnderflow); the certificate invalidated.
 * The token-flow proof's sources then sum to the capital credited and it balances at an unchanged vault: its
 * validation cannot refuse.
 */
function applyConversionRetainingHaircut(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  pos: u128,
  converted: u128,
  faceBurn: u128,
  cp: u128,
  ins: u128,
  d: u64,
  claimNum: u128,
): void {
  const reserved = loadRawAt<Portfolio>(pa, HEADER_LEN).reserved_pnl;
  if (converted === 0n || converted > (pos > reserved ? pos - reserved : 0n)) failV16(V16_INVALID_CONFIG);
  if (converted > faceBurn || faceBurn > pos) failV16(V16_INVALID_CONFIG);
  // converted ≤ pos ≤ i128::MAX, and the PnL is at least pos: the difference stays in i128.
  const newPnl: i128 = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl - toI128(converted);
  burnSourceClaimDomainFirst(m, markets, pa, d, claimNum);
  setAccountPnlAfterSourceClaimBurn(m, markets, pa, newPnl, boundNumFromAmount(converted));
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (p.capital > U128_MAX_RS - converted) failV16(V16_ARITHMETIC_OVERFLOW);
  p.capital += converted;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.c_tot > U128_MAX_RS - converted) failV16(V16_ARITHMETIC_OVERFLOW);
  h.c_tot += converted;
  h.pnl_matured_pos_tot = h.pnl_matured_pos_tot > converted ? h.pnl_matured_pos_tot - converted : 0n;
  if (converted < cp || converted - cp < ins) failV16(V16_COUNTER_UNDERFLOW);
  p.health_cert.valid = 0n;
}

/**
 * `realize_one_source_domain_for_resolved_close_not_atomic(account)`: no source claim once a receipt is present
 * (decoded); the domains compacted; the first occupied domain with a claim (before the compacted tail), none without.
 * The released PnL; the claim offered: its unliened part, at most the released PnL's bound. A nonzero offer: the
 * domain's ledger current, its conversion in whole atoms; a nonzero conversion consumes the domain's credit
 * (InvalidConfig for a face burned beyond the offer) and is applied, retaining the haircut face. Nothing converted: a
 * claim that is not final waits (nothing written); a final one is burned (domain first), the certificate invalidated.
 * The source-attributed face less the conversion reserved (`kernel_retain_terminal_source_haircut`: InvalidLeg,
 * CounterOverflow); with the snapshot captured (decoded), the face burned refined out of the ledger's unreceipted bound
 * (CounterUnderflow); the domains compacted.
 */
function realizeOneSourceDomain(m: RemainingAccount, markets: u64, pa: RemainingAccount): u64 {
  const p0 = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(boolErr(p0.resolved_payout_receipt.present));
  if (p0.resolved_payout_receipt.present === 1n) return REALIZED_NO_SOURCE_CLAIM;
  compact(pa);
  let found = NO_SLOT;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP && found === NO_SLOT; slot++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) break;
    if (occupied && s.source_claim_bound_num !== 0n) found = slot;
  }
  if (found === NO_SLOT) return REALIZED_NO_SOURCE_CLAIM;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const pos: u128 = p.pnl > 0n ? toU128(p.pnl) : 0n;
  const released = pos > p.reserved_pnl ? pos - p.reserved_pnl : 0n;
  const src = p.source_domains.get(found);
  const d = toU64(src.domain);
  const claimNum = src.source_claim_bound_num;
  const unliened = sourceClaimUnliened(pa, d);
  const releasedNum = boundNumFromAmount(released);
  const claim = unliened < releasedNum ? unliened : releasedNum;
  let converted: u128 = 0n;
  if (claim !== 0n) {
    validateDomainLedgerCurrent(m, markets, d);
    sourceForDomain(m, markets, d);
    converted = wholeAtomConversion(loadRawAt<SourceCreditState>(m, sourceAt(d)), claim);
    if (converted !== 0n) {
      const c = consumeSourceDomainCreditForEffective(m, markets, d, converted);
      if (boundNumFromAmount(c.face_burn) > claim) failV16(V16_INVALID_CONFIG);
      applyConversionRetainingHaircut(m, markets, pa, pos, converted, c.face_burn, c.counterparty_credit_consumed, c.insurance_credit_consumed, d, claimNum);
    }
  }
  if (converted === 0n) {
    if (!terminalForHaircutDemote(m, markets, pa, d, found, claim)) return REALIZED_WAITING;
    burnSourceClaimDomainFirst(m, markets, pa, d, claimNum);
    invalidateCert(pa);
  }
  const attributedAll = amountFromBoundNum(claimNum);
  const face = attributedAll < released ? attributedAll : released;
  const pr = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  // kernel_retain_terminal_source_haircut(pos, reserved, face, converted).
  const reservedNow = pr.reserved_pnl;
  if (reservedNow > pos || face > pos - reservedNow || converted > face) failV16(V16_INVALID_LEG);
  if (reservedNow > U128_MAX_RS - (face - converted)) failV16(V16_COUNTER_OVERFLOW);
  pr.reserved_pnl = reservedNow + (face - converted);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(boolErr(h.payout_snapshot_captured));
  if (h.payout_snapshot_captured === 1n) {
    const after: u128 = pr.pnl > 0n ? toU128(pr.pnl) : 0n;
    if (pos < after) failV16(V16_COUNTER_UNDERFLOW);
    checkV16(resolvedPayoutLedgerErr(h.resolved_payout_ledger));
    const burnedNum = boundNumFromAmount(pos - after);
    const unreceipted = h.resolved_payout_ledger.terminal_claim_bound_unreceipted_num;
    const decrease = burnedNum < unreceipted ? burnedNum : unreceipted;
    if (decrease !== 0n) refineUnreceiptedBound(m, decrease);
  }
  compact(pa);
  return REALIZED_PROCESSED;
}

// ---- The account's close ------------------------------------------------------------------------------------------------------

/** `V16Core::kernel_settle_resolved_pnl_after_booking(pnl, booked, explicit)`: the PnL raised by what the booking
 * cleared, at most the loss (ArithmeticOverflow for a sum or an amount past i128). */
function settledPnlAfterBooking(pnl: i128, booked: u128, explicit: u128): i128 {
  const loss = absH(pnl);
  if (booked > U128_MAX_RS - explicit) failV16(V16_ARITHMETIC_OVERFLOW);
  let cleared = booked + explicit;
  if (cleared > loss) cleared = loss;
  if (cleared > I128_MAX_RS) failV16(V16_ARITHMETIC_OVERFLOW);
  if (pnl > 0n && pnl > toI128(I128_MAX_RS) - toI128(cleared)) failV16(V16_ARITHMETIC_OVERFLOW);
  return pnl + toI128(cleared);
}

/**
 * `settle_resolved_bankruptcy_negative_pnl(account)`: a PnL not below zero clamps a pending close's residual to the loss
 * (`clamp_close_residual_to_account_loss`). Otherwise LockActive unless Resolved; the attribution (`resolved_bankruptcy_attribution`:
 * a pending close's asset and the side opposite its domain, the asset configured; else the one active leg that is
 * neither stale nor B-stale, each candidate's asset configured, none for two); without one the loss is written off
 * (`clear_resolved_unattributed_negative_pnl`: the H-lock set, the PnL zeroed, the certificate invalidated). With one: the
 * H-lock set; a new close ledger unless one is active and not finalized-inert; the domain's insurance (the ledger
 * advanced by it); a residual left books one chunk (the PnL raised by what it cleared); the certificate invalidated.
 */
function settleResolvedBankruptcy(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  if (loadRawAt<Portfolio>(pa, HEADER_LEN).pnl >= 0n) {
    clampCloseResidual(m, markets, pa);
    return;
  }
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_RESOLVED_RS) failV16(V16_LOCK_ACTIVE);
  const configured = toU64(h.config.max_market_slots);
  const c = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
  checkV16(closeProgressErr(c));
  let asset = NO_DOMAIN_RS;
  let bankruptShort = false;
  if (c.active === 1n && c.canceled === 0n && c.finalized === 0n && c.residual_remaining !== 0n) {
    asset = toU64(c.asset_index);
    if (asset >= configured || asset >= markets) failV16(V16_INVALID_LEG);
    bankruptShort = c.domain_side !== 1n;
  } else {
    let count: u64 = 0n;
    for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N && count < 2n; slot++) {
      const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
      checkV16(legErr(leg));
      if (leg.active === 1n && leg.stale === 0n && leg.b_stale === 0n) {
        const candidate = toU64(leg.asset_index);
        if (candidate >= configured || candidate >= markets) failV16(V16_INVALID_LEG);
        count += 1n;
        asset = candidate;
        bankruptShort = leg.side === 1n;
      }
    }
    if (count !== 1n) {
      // clear_resolved_unattributed_negative_pnl (the PnL is negative here).
      const hl = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
      hl.bankruptcy_hlock_active = 1n;
      setAccountPnl(m, markets, pa, 0n);
      invalidateCert(pa);
      return;
    }
  }
  const hm = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  hm.bankruptcy_hlock_active = 1n;
  const gross = absH(loadRawAt<Portfolio>(pa, HEADER_LEN).pnl);
  const c1 = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
  checkV16(closeProgressErr(c1));
  const inert = c1.active === 1n && c1.finalized === 1n && c1.canceled === 0n && c1.residual_remaining === 0n;
  if (c1.active !== 1n || inert) beginCloseProgressLedger(m, markets, pa, asset, !bankruptShort, gross);
  const used = consumeDomainInsurance(m, markets, asset, bankruptShort, pa);
  if (used !== 0n && advanceCloseLedgerFull(m, markets, pa, 0n, 0n, used, 0n, 0n) === DECLARED) failV16(V16_RECOVERY_REQUIRED);
  const pnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  const residualLeft = pnl < 0n ? absH(pnl) : 0n;
  if (residualLeft === 0n) {
    invalidateCert(pa);
    return;
  }
  const out = bookResidualForAccount(m, markets, pa, asset, bankruptShort, residualLeft);
  if (out.status === DECLARED) failV16(V16_RECOVERY_REQUIRED);
  setAccountPnl(m, markets, pa, settledPnlAfterBooking(loadRawAt<Portfolio>(pa, HEADER_LEN).pnl, out.booked, out.explicit));
  invalidateCert(pa);
}

/**
 * `detach_solvent_active_legs_for_resolved_close(account)`: nothing for a negative PnL, a B-stale or stale account
 * (decoded) or a pending close. Every active leg (decoded) must be settled: not B-stale or stale, its asset configured
 * (InvalidLeg), no barrier on its side, an obligation's release allowed; an exhausted side begins its full-drain reset;
 * its K/F epoch, K, F and B current; otherwise nothing. Then the first active leg is detached: one that owns no
 * effective OI is cleared (`clear_leg_at_slot_inner` with zero), any other closed by its effective quantity bounded by
 * its side's OI (`apply_position_delta`); the asset's residue resets begun.
 */
function detachSolventLegs(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  if (p.pnl < 0n) return;
  checkV16(boolErr(p.b_stale_state));
  if (p.b_stale_state === 1n) return;
  checkV16(boolErr(p.stale_state));
  if (p.stale_state === 1n) return;
  checkV16(closeProgressErr(p.close_progress));
  if (closeHasPendingResidual(p.close_progress)) return;
  const configured = toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) continue;
    if (leg.b_stale === 1n || leg.stale === 1n) return;
    const asset = toU64(leg.asset_index);
    if (asset >= configured) failV16(V16_INVALID_LEG);
    const short = leg.side === 1n;
    if (hasPendingDomainLossBarrier(m, markets, asset, short)) return;
    if (leg.basis_pos_q === 0n && leg.loss_weight !== 0n && !obligationReleaseAllowed(m, markets, asset, short)) return;
    if (legHasExhaustedEffectiveOi(loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset, leg)) beginFullDrainResetInner(m, markets, asset, short);
    const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
    const t = kfTargetForLeg(a, leg);
    const epoch = short ? a.kf_epoch_short : a.kf_epoch_long;
    if (leg.kf_epoch_snap !== epoch || t.k !== leg.k_snap || !fSnapResidualIsSubAtom(absH(leg.basis_pos_q), leg.a_basis, leg.f_snap, t.f)) return;
    // b_target_for_leg(asset, leg): the asset configured (it is) and decoded again.
    if (bTargetForLeg(loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset, leg) !== leg.b_snap) return;
  }
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) continue;
    const asset = toU64(leg.asset_index);
    const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
    const short = leg.side === 1n;
    const sideOi = short ? a.oi_eff_short_q : a.oi_eff_long_q;
    const q = effectiveAbsQuantityForLeg(a, leg);
    const close = sideOi < q ? sideOi : q;
    if (close === 0n) {
      clearLegAtSlotInner(m, markets, pa, asset, slot, false, true, 0n, false);
      beginZeroOiResidueResets(m, markets, asset);
      return;
    }
    if (close > I128_MAX_RS) failV16(V16_ARITHMETIC_OVERFLOW);
    const delta: i128 = short ? toI128(close) : -toI128(close);
    // apply_position_delta(account, asset, delta): the lookup (the slot map, then the asset decoded), the delta of its
    // quantities.
    const k = planDelta(m, pa, asset, delta, loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset);
    applyPositionDelta(m, markets, pa, asset, k.next_q - k.current_q, k, false);
    beginZeroOiResidueResets(m, markets, asset);
    return;
  }
}

/**
 * `close_resolved_account_not_atomic(account, fee_rate)`: LockActive unless Resolved. One source-domain preparation step
 * (a normalized bucket, or a released lien while liens remain, ends the call as ProgressOnly; a last lien released is a
 * pre-payout step); a lapsed bucket an active leg touches is expired (ProgressOnly); the side effects settled (a B chunk
 * left: ProgressOnly after the shape); the fee synced to the resolved slot (a moved fee slot is a pre-payout step); the
 * loss settled from principal; the resolved bankruptcy; the solvent legs' detachment. An account with legs, a negative
 * PnL or a stale flag (decoded) is ProgressOnly, as is a positive PnL before the market is payout-ready. A source
 * domain's realization: processed with claims left is ProgressOnly; a waiting claim is LockActive unless the call made a
 * pre-payout step (then ProgressOnly). Then the receipt (created for a positive PnL or kept when present) and what it
 * can claim now; the payout (the capital and the claim, at most the vault: ArithmeticOverflow), paid to the receipt
 * first from the capital; a fully diluted receipt cleared; the vault lowered (CounterUnderflow), c_tot by the capital
 * (saturating), the PnL, capital, reserved PnL and fee credits zeroed, the certificate invalidated; the shape and the
 * account's check. The token-flow proof's sources sum to the payout and the vault falls by it: its validation cannot
 * refuse.
 */
export function closeResolvedAccount(m: RemainingAccount, markets: u64, pa: RemainingAccount, feeRate: u128, out: Inout<ResolvedClose>): void {
  out.closed = false;
  out.payout = 0n;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_RESOLVED_RS) failV16(V16_LOCK_ACTIVE);
  let pre = false;
  const prep = prepareOneSourceDomain(m, markets, pa);
  if (prep !== PREPARED_NONE) {
    if (prep === PREPARED_BACKING_NORMALIZED || hasSourceLiens(pa)) return;
    pre = true;
  }
  if (expireOneLapsedForActiveLeg(m, markets, pa)) {
    stepDone(m, markets, pa);
    return;
  }
  if (loadRawAt<Portfolio>(pa, HEADER_LEN).active_bitmap.get(0n) !== 0n) pre = true;
  const feeBefore = loadRawAt<Portfolio>(pa, HEADER_LEN).last_fee_slot;
  if (settleAccountSideEffects(m, markets, pa, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.public_b_chunk_atoms).current === 0n) {
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    return;
  }
  syncAccountFeeToSlot(m, pa, markets, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).resolved_slot, feeRate);
  if (loadRawAt<Portfolio>(pa, HEADER_LEN).last_fee_slot !== feeBefore) pre = true;
  validateWithMarket(m, pa, markets);
  settleNegativePnlFromPrincipal(m, pa);
  settleResolvedBankruptcy(m, markets, pa);
  detachSolventLegs(m, markets, pa);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  if (p.active_bitmap.get(0n) !== 0n || p.pnl < 0n) return;
  checkV16(boolErr(p.b_stale_state));
  if (p.b_stale_state === 1n) return;
  checkV16(boolErr(p.stale_state));
  if (p.stale_state === 1n) return;
  if (p.pnl > 0n && !resolvedPositivePayoutReady(m)) return;
  const realized = realizeOneSourceDomain(m, markets, pa);
  if (realized === REALIZED_PROCESSED) {
    if (accountHasSourceClaims(pa)) {
      stepDone(m, markets, pa);
      return;
    }
  } else if (realized === REALIZED_WAITING) {
    if (!pre) failV16(V16_LOCK_ACTIVE);
    stepDone(m, markets, pa);
    return;
  }
  let receipt = false;
  let pnlPayout: u128 = 0n;
  let wanted = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl > 0n;
  if (!wanted) {
    const present = loadRawAt<Portfolio>(pa, HEADER_LEN).resolved_payout_receipt.present;
    checkV16(boolErr(present));
    wanted = present === 1n;
  }
  if (wanted) {
    createReceipt(m, pa);
    checkV16(resolvedPayoutReceiptErr_(pa));
    pnlPayout = receiptClaimableNow(m, pa);
    receipt = true;
  }
  const capital = loadRawAt<Portfolio>(pa, HEADER_LEN).capital;
  if (capital > U128_MAX_RS - pnlPayout) failV16(V16_ARITHMETIC_OVERFLOW);
  const vault0 = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).vault;
  let payout = capital + pnlPayout;
  if (payout > vault0) payout = vault0;
  const capitalPaid = capital < payout ? capital : payout;
  const resolvedPaid = payout - capitalPaid;
  if (receipt) applyReceiptPayment(pa, resolvedPaid);
  clearFullyDilutedReceipt(m, pa);
  const hm = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (hm.vault < payout) failV16(V16_COUNTER_UNDERFLOW);
  hm.vault -= payout;
  hm.c_tot -= capital < hm.c_tot ? capital : hm.c_tot;
  setAccountPnl(m, markets, pa, 0n);
  const pm = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  pm.capital = 0n;
  pm.reserved_pnl = 0n;
  pm.fee_credits = 0n;
  pm.health_cert.valid = 0n;
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, pa, markets);
  out.closed = true;
  out.payout = payout;
}

/** The receipt decoded again (`try_to_runtime`). */
function resolvedPayoutReceiptErr_(pa: RemainingAccount): u64 {
  const r = loadRawAt<Portfolio>(pa, HEADER_LEN).resolved_payout_receipt;
  const e = boolErr(r.present);
  return e !== 0n ? e : boolErr(r.finalized);
}

/**
 * The crank's CloseResolved plan: the resolved slot advanced; a present, unfinalized receipt (decoded) that can still
 * gain: with a hinted asset, its first lapsed bucket is expired (the shape, the account's check: ProgressOnly); else
 * nothing claimable now is NonProgress (returned: NONPROG_RS). Then the account's close.
 */
export function crankCloseResolved(m: RemainingAccount, markets: u64, pa: RemainingAccount, now: u64, hint: u64, feeRate: u128, out: Inout<ResolvedClose>): u64 {
  out.closed = false;
  out.payout = 0n;
  advanceResolvedSlot(m, now);
  const r = loadRawAt<Portfolio>(pa, HEADER_LEN).resolved_payout_receipt;
  checkV16(resolvedPayoutReceiptErr_(pa));
  if (r.present === 1n && r.finalized === 0n && receiptCanStillGain(m, pa)) {
    if (hint !== NO_DOMAIN_RS) {
      const slot = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
      const d = firstLapsedForAsset(m, markets, hint, slot);
      if (d !== NO_DOMAIN_RS) {
        expireSourceBackingBucket(m, markets, d, slot);
        stepDone(m, markets, pa);
        return 0n;
      }
    }
    if (receiptClaimableNow(m, pa) === 0n) return NONPROG_RS;
  }
  closeResolvedAccount(m, markets, pa, feeRate, out);
  return 0n;
}

/** NonProgress, which every caller of the Resolved crank fails with (EngineNonProgress). */
export const NONPROG_RS: u64 = 2n;

/**
 * The Resolved flags of `build_actionable_summary_and_selected_assets`: the fee sync pending (the fee slot behind the
 * resolved slot); pending while the account is not empty for dematerialization (decoded) or its fee is behind; pre-payout
 * progress (legs, a B-stale or stale flag decoded, a PnL not above zero, liens, lapsed backing, a pending close, the fee);
 * a winner: pending, and with pre-payout progress or a payout-ready market.
 */
export function resolvedWinner(m: RemainingAccount, pa: RemainingAccount, lapsed: boolean): boolean {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const resolved = h.mode === MODE_RESOLVED_RS;
  const feeSync = resolved && p.last_fee_slot < h.resolved_slot;
  const pending = resolved && (!emptyForDematerialization(p) || feeSync);
  let pre = p.active_bitmap.get(0n) !== 0n;
  if (!pre) {
    checkV16(boolErr(p.b_stale_state));
    pre = p.b_stale_state === 1n;
  }
  if (!pre) {
    checkV16(boolErr(p.stale_state));
    pre = p.stale_state === 1n;
  }
  // The rest reads without refusing; its value matters only on a Resolved market.
  if (!resolved) return false;
  if (!pre) pre = p.pnl <= 0n || hasSourceLiens(pa) || lapsed || closeHasPendingResidual(p.close_progress) || feeSync;
  return pending && (pre || resolvedPositivePayoutReady(m));
}
