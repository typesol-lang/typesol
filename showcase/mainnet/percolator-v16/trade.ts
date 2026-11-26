// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The engine's trade (NOTES.md, section 12): `execute_trade_with_fee_loss_stale_scoped_not_atomic` with one request, that
// is `execute_batch_with_fee_loss_stale_scoped_not_atomic` and `execute_batch_with_fee_after_tail_validation_not_atomic`
// on a single request (`recertify_after_fill` is then true: the batch-only `certify_account_after_local_settlement_…`
// is not reached), the position plan (`PositionSlotMapV16::from_account` and `plan_delta`), the fill
// (`apply_trade_after_refresh_not_atomic`: preflight, fee, terminal residual, both position deltas, the side-OI cap, the
// residual reward credit, the two recertifications), the leg routes (`apply_position_delta_with_lookup_inner`:
// attach, clear, flip, resize, the pending-obligation retention, with their kernels), the finishing margin checks with
// the initial-margin source liens, and the zero-OI residue resets.
//
// Copies. The original takes legs and asset states by value, changes the copies and writes them back after its checks;
// every caller propagates every error (no error on these paths is looked at and swallowed), so the port changes the
// account bytes in place and a refusal fails the transaction. Two values are kept across a call because the original
// keeps them: the market's loss-stale flag, restored after the trade when the trade was scoped (an unrelated loss-stale
// asset ignored), and the asset state before the fill (`pre_fill_asset`, for the side-OI cap).
import {
  type FixedArray,
  type Inout,
  type RemainingAccount,
  type i128,
  type u8,
  type u32,
  type u64,
  type u128,
  type u256,
  loadRawAt,
  loadRawMutAt,
  i128 as toI128,
  u32 as toU32,
  u64 as toU64,
  u128 as toU128,
  u256 as toU256,
} from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_HIDDEN_LEG,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_NON_PROGRESS,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type AssetState,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type PortfolioLeg,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  MAX_ORACLE_PRICE,
} from "./state.js";
import {
  ADL_ONE,
  BOUND_SCALE,
  I128_MIN,
  V16_MAX_PORTFOLIO_ASSETS_N,
  boolErr,
  closeProgressErr,
  configShapeErr,
  healthCertErr,
  marketModeErr,
  nonMinI128Err,
} from "./wire.js";
import {
  CREDIT_RATE_SCALE,
  MAX_POSITION_ABS_Q,
  MIN_A_SIDE,
  PORTFOLIO_SOURCE_DOMAIN_CAP,
  SOCIAL_WEIGHT_SCALE,
  blockersAfter,
  engineSlotAt,
  legErr,
  marketShapeErr,
  slotBlockers,
  validateWithMarket,
} from "./engine.js";
import { fSnapResidualIsSubAtom, kfTargetForLeg, bTargetForLeg, normalizeSocialLossCarry, sourceCreditLienAmounts } from "./kernels.js";
import {
  NO_SLOT,
  accountHasSourceClaims,
  assetStateOf,
  bucketAt,
  bucketForDomain,
  closeHasPendingResidual,
  collectBackingUtilizationFee,
  createCounterpartyLienCore,
  createInsuranceLienCore,
  domainAssetSide,
  domainHasDefaultTag,
  domainIsOccupied,
  domainIsSparseTailDefault,
  hasPendingDomainLossBarrier,
  insuranceDomainIndex,
  pendingDomainLossBarrierCount,
  requireActiveLegSlotForAsset,
  reservationAt,
  reservationForDomain,
  sourceAt,
  sourceClaimUnliened,
  sourceCreditAvailableBacking,
  sourceDomainSlotOrInsert,
  sourceDomainSlotView,
  sourceForDomain,
  validateDomainLedgerCurrent,
} from "./primitives.js";
import { beginFullDrainResetInner } from "./kfsettle.js";
import { certifyAfterLocalSettlement } from "./liquidation.js";
import { chargeAccountFeeCurrent } from "./refresh.js";
import {
  absH,
  accountHasLossStaleLiveLeg,
  accountHLockMax,
  adlEffectiveQuantityCeil,
  assetHasTargetLag,
  assetIsLossStale,
  effectiveAbsQuantityForLeg,
  isPriorResetObligation,
  lienEffectiveSupporting,
  marginRequirement,
  recertifyAfterSourceLienChange,
  recertifyAfterTradeDelta,
  riskNotionalCeil,
  settleForPositionAction,
} from "./health.js";
import { type BackingBucket, type InsuranceCreditReservation, type SourceCreditState } from "./state.js";

const U128_MAX_T: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MAX_T: u128 = 0x7fffffffffffffffffffffffffffffffn;
const U128_MAX_TW: u256 = 340282366920938463463374607431768211455n;
const U64_MAX_T: u64 = 0xffffffffffffffffn;
const U32_MAX_T: u64 = 0xffffffffn;
/** `MAX_TRADE_SIZE_Q` (= MAX_POSITION_ABS_Q) and `MAX_OI_SIDE_Q`. */
const MAX_TRADE_SIZE_Q: u128 = 100000000000000n;
const MAX_OI_SIDE_Q: u128 = 100000000000000n;
/** `MarketModeV16::Live`, `::Resolved`. */
const MODE_LIVE_T: u8 = 0n;
const MODE_RESOLVED_T: u8 = 1n;
/** `SideModeV16` bytes. */
const SIDE_MODE_NORMAL_T: u8 = 0n;
const SIDE_MODE_RESET_PENDING_T: u8 = 2n;
/** `AssetLifecycleV16::Active`. */
const LIFECYCLE_ACTIVE_T: u8 = 2n;
/** `BackingBucketStatusV16::Fresh`. */
const BUCKET_FRESH_T: u8 = 1n;
/** No asset (`Option<usize>::None`). */
export const NO_ASSET: u64 = 0xffffffffffffffffn;

/** `TradeRequestV16` as the processor builds it for a single trade: the asset, the size (a positive magnitude: the
 * orientation is the order of the accounts), the fee basis price and the fee rate. */
export interface TradeRequest {
  asset: u64;
  size: i128;
  price: u64;
  fee_bps: u64;
}

/** `TradeOutcomeV16`'s fees (the long account's and the short account's). */
export interface TradeFees {
  fee_long: u128;
  fee_short: u128;
}

/** `PositionDeltaLookupV16`: the existing and empty leg slots (NO_SLOT for none), the basis and the effective quantity
 * before and after. */
export interface Lookup {
  existing: u64;
  empty: u64;
  current_q: i128;
  next_q: i128;
  current_eff: i128;
  next_eff: i128;
}

// ---- Small engine helpers ---------------------------------------------------------------------------------------------

/** `validate_basis(q)`: nonzero, not i128::MIN, at most MAX_POSITION_ABS_Q (InvalidLeg). */
function validateBasis(q: i128): void {
  if (q === 0n || q === I128_MIN || absH(q) > MAX_POSITION_ABS_Q) failV16(V16_INVALID_LEG);
}

/** `validate_basis_or_zero(q)`. */
export function validateBasisOrZero(q: i128): void {
  if (q !== 0n) validateBasis(q);
}

/** `signed_position(leg)`: 0 for an inactive leg, the basis's magnitude signed by the side. */
export function signedPosition(l: PortfolioLeg): i128 {
  if (l.active !== 1n) return 0n;
  const abs = toI128(absH(l.basis_pos_q));
  return l.side === 1n ? -abs : abs;
}

/** `loss_weight_for_basis(abs, a_basis)`: InvalidLeg for a zero A, ⌈abs · SOCIAL_WEIGHT_SCALE / a_basis⌉ in 256 bits
 * (ArithmeticOverflow past u128). */
function lossWeightForBasis(abs: u128, aBasis: u128): u128 {
  if (aBasis === 0n) failV16(V16_INVALID_LEG);
  const p: u256 = toU256(abs) * toU256(SOCIAL_WEIGHT_SCALE);
  const q: u256 = p / toU256(aBasis) + (p % toU256(aBasis) !== 0n ? 1n : 0n);
  if (q > U128_MAX_TW) failV16(V16_ARITHMETIC_OVERFLOW);
  return toU128(q);
}

/** `adjust_u128(current, old, new)`: current moved by new − old (ArithmeticOverflow up, CounterUnderflow down). */
function adjustU128(current: u128, old: u128, next: u128): u128 {
  if (next >= old) {
    if (current > U128_MAX_T - (next - old)) failV16(V16_ARITHMETIC_OVERFLOW);
    return current + (next - old);
  }
  if (current < old - next) failV16(V16_COUNTER_UNDERFLOW);
  return current - (old - next);
}

/** `same_side_risk_reduction_or_flat_obligation(current, next)`. */
function sameSideReduction(current: i128, next: i128): boolean {
  return current !== 0n && (next === 0n || current > 0n === next > 0n) && absH(next) < absH(current);
}

/** `position_change_touches_pending_domain_loss_barrier(asset, current, next)`: the side held before, then the side
 * held after, holding a pending barrier. */
export function positionChangeTouchesBarrier(m: RemainingAccount, markets: u64, asset: u64, current: i128, next: i128): boolean {
  if (current !== 0n && hasPendingDomainLossBarrier(m, markets, asset, current < 0n)) return true;
  return next !== 0n && hasPendingDomainLossBarrier(m, markets, asset, next < 0n);
}

/** `pending_domain_loss_barrier_blocks_position_change(touches, current, next)`. */
export function barrierBlocks(touches: boolean, current: i128, next: i128): boolean {
  return touches && !sameSideReduction(current, next);
}

/** The route of `kernel_classify_position_delta`: 0 Attach, 1 Clear, 2 Flip, 3 Resize. */
function classifyRoute(current: i128, next: i128): u64 {
  if (current === 0n) return 0n;
  if (next === 0n) return 1n;
  if (current > 0n !== next > 0n) return 2n;
  return 3n;
}

/** The asset slot's place, decoded first (`asset_state`). */
export function assetSlot(m: RemainingAccount, markets: u64, asset: u64): u64 {
  assetStateOf(m, markets, asset);
  return engineSlotAt(asset);
}

/** The rest of `set_asset_state` after a change made in place: `before` is the blocker count taken before the change. */
export function setAssetState(m: RemainingAccount, asset: u64, before: u128): void {
  if (before > toU128(U64_MAX_T)) failV16(V16_COUNTER_OVERFLOW);
  blockersAfter(m, asset, toU64(before));
}

/**
 * `require_asset_risk_change_allowed(asset, risk_increasing)`: nothing unless the change increases risk; then the asset
 * decoded, both A indices at ADL_ONE and `asset_risk_increase_gate` (Active, both sides Normal), LockActive otherwise.
 */
function requireRiskChangeAllowed(m: RemainingAccount, markets: u64, asset: u64, increasing: boolean): void {
  if (!increasing) return;
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  if (a.a_long !== ADL_ONE || a.a_short !== ADL_ONE) failV16(V16_LOCK_ACTIVE);
  if (a.lifecycle !== LIFECYCLE_ACTIVE_T || a.mode_long !== SIDE_MODE_NORMAL_T || a.mode_short !== SIDE_MODE_NORMAL_T) failV16(V16_LOCK_ACTIVE);
}

// ---- Leg routes --------------------------------------------------------------------------------------------------------

/**
 * `ensure_source_domain_capacity_for_new_exposure(account, asset, side)`: below the threshold the configured active-leg
 * cap proves room (the source slot at 32 − cap is the sparse tail); otherwise the occupied slots, the active legs
 * whose favorable domain has no slot and the candidate's (each through the view's `source_domain_slot`) must fit the
 * 32 slots (`source_domain_capacity_after_admission`: LockActive).
 */
function ensureSourceDomainCapacity(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, short: boolean): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const maxActive = toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_portfolio_assets);
  if (maxActive !== 0n && maxActive <= PORTFOLIO_SOURCE_DOMAIN_CAP) {
    if (domainIsSparseTailDefault(p.source_domains.get(PORTFOLIO_SOURCE_DOMAIN_CAP - maxActive))) return;
  }
  const candidate = insuranceDomainIndex(m, markets, asset, !short);
  const candidateMissing = sourceDomainSlotView(pa, candidate) === NO_SLOT;
  let occupied = 0n;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = p.source_domains.get(slot);
    if (domainIsSparseTailDefault(s)) break;
    if (domainIsOccupied(s)) occupied += 1n;
  }
  let missing = 0n;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) continue;
    const d = insuranceDomainIndex(m, markets, toU64(leg.asset_index), leg.side !== 1n);
    if (sourceDomainSlotView(pa, d) === NO_SLOT) missing += 1n;
  }
  if (occupied + missing + (candidateMissing ? 1n : 0n) > PORTFOLIO_SOURCE_DOMAIN_CAP) failV16(V16_LOCK_ACTIVE);
}

/**
 * `attach_leg_at_slot(account, asset, side, basis, slot)`: InvalidLeg past the legs; the slot free (no bit, an inactive
 * empty leg: HiddenLeg); LockActive with a pending barrier on the side; the basis valid; the asset decoded, the risk
 * change allowed, the source-domain capacity; the loss weight; `kernel_attach_leg` (the side's A in range and a nonzero
 * weight: InvalidLeg; the side's OI (ArithmeticOverflow), stored count (CounterOverflow) and weight sum
 * (ArithmeticOverflow) raised; the leg snapshotting the side's indices); the bit set, the certificate invalidated, the
 * asset written.
 */
function attachLegAtSlot(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, short: boolean, basis: i128, slot: u64): void {
  if (slot >= V16_MAX_PORTFOLIO_ASSETS_N) failV16(V16_INVALID_LEG);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  const existing = p.legs.get(slot);
  checkV16(legErr(existing));
  if (((bitmap >> slot) & 1n) !== 0n || existing.active === 1n) failV16(V16_HIDDEN_LEG);
  if (hasPendingDomainLossBarrier(m, markets, asset, short)) failV16(V16_LOCK_ACTIVE);
  validateBasis(basis);
  const at = assetSlot(m, markets, asset);
  requireRiskChangeAllowed(m, markets, asset, true);
  ensureSourceDomainCapacity(m, markets, pa, asset, short);
  const e = loadRawMutAt<EngineAssetSlot>(m, at);
  const a = e.asset;
  const aBasis = short ? a.a_short : a.a_long;
  const abs = absH(basis);
  const weight = lossWeightForBasis(abs, aBasis);
  if (aBasis < MIN_A_SIDE || aBasis > ADL_ONE || weight === 0n) failV16(V16_INVALID_LEG);
  const before = slotBlockers(e);
  // add_open_interest_for_new_position: the OI sum, the stored count, the weight sum, in that order.
  const oi = short ? a.oi_eff_short_q : a.oi_eff_long_q;
  if (oi > U128_MAX_T - abs) failV16(V16_ARITHMETIC_OVERFLOW);
  const count = short ? a.stored_pos_count_short : a.stored_pos_count_long;
  if (count === U64_MAX_T) failV16(V16_COUNTER_OVERFLOW);
  const sum = short ? a.loss_weight_sum_short : a.loss_weight_sum_long;
  if (sum > U128_MAX_T - weight) failV16(V16_ARITHMETIC_OVERFLOW);
  if (short) {
    a.oi_eff_short_q = oi + abs;
    a.stored_pos_count_short = count + 1n;
    a.loss_weight_sum_short = sum + weight;
  } else {
    a.oi_eff_long_q = oi + abs;
    a.stored_pos_count_long = count + 1n;
    a.loss_weight_sum_long = sum + weight;
  }
  const leg = p.legs.get(slot);
  leg.active = 1n;
  leg.asset_index = toU32(asset);
  leg.market_id = a.market_id;
  leg.side = short ? 1n : 0n;
  leg.basis_pos_q = basis;
  leg.a_basis = aBasis;
  leg.k_snap = short ? a.k_short : a.k_long;
  leg.f_snap = short ? a.f_short_num : a.f_long_num;
  leg.kf_epoch_snap = short ? a.kf_epoch_short : a.kf_epoch_long;
  leg.epoch_snap = short ? a.epoch_short : a.epoch_long;
  leg.loss_weight = weight;
  leg.b_snap = short ? a.b_short_num : a.b_long_num;
  leg.b_rem = 0n;
  leg.b_epoch_snap = leg.epoch_snap;
  leg.b_stale = 0n;
  leg.stale = 0n;
  p.active_bitmap.set(0n, bitmap | (1n << slot));
  p.health_cert.valid = 0n;
  setAssetState(m, asset, before);
}

/**
 * `kernel_clear_leg(leg, asset, clear_effective)` on the asset in place: a prior-reset leg or one of zero basis clears
 * no effective OI; any other between 1 and its basis (or 0 on a side with none), InvalidLeg otherwise; a current leg's
 * B remainder normalized into the side's dust and explicit loss; the stored count lowered, a zero-basis obligation's
 * pending count lowered, and for a current leg the side's OI and weight sum (CounterUnderflow each).
 */
function kernelClearLeg(a: Inout<AssetState>, leg: PortfolioLeg, clear: u128): void {
  const short = leg.side === 1n;
  const prior = short
    ? a.mode_short === SIDE_MODE_RESET_PENDING_T && leg.epoch_snap !== U64_MAX_T && leg.epoch_snap + 1n === a.epoch_short
    : a.mode_long === SIDE_MODE_RESET_PENDING_T && leg.epoch_snap !== U64_MAX_T && leg.epoch_snap + 1n === a.epoch_long;
  const raw = absH(leg.basis_pos_q);
  const sideOi = short ? a.oi_eff_short_q : a.oi_eff_long_q;
  const valid = prior || raw === 0n ? clear === 0n : (clear >= 1n && clear <= raw) || (clear === 0n && sideOi === 0n);
  if (leg.active !== 1n || !valid) failV16(V16_INVALID_LEG);
  let dust: u128 = 0n;
  let explicit: u128 = 0n;
  const normalize = !prior && leg.b_rem !== 0n;
  if (normalize) {
    const n = normalizeSocialLossCarry(
      leg.b_rem,
      short ? a.social_loss_dust_short_num : a.social_loss_dust_long_num,
      short ? a.explicit_unallocated_loss_short : a.explicit_unallocated_loss_long,
    );
    dust = n.a;
    explicit = n.b;
  }
  const obligation = leg.basis_pos_q === 0n && leg.loss_weight !== 0n;
  if (short) {
    if (a.stored_pos_count_short === 0n) failV16(V16_COUNTER_UNDERFLOW);
    a.stored_pos_count_short -= 1n;
    if (obligation) {
      if (a.pending_obligation_count_short === 0n) failV16(V16_COUNTER_UNDERFLOW);
      a.pending_obligation_count_short -= 1n;
    }
    if (!prior) {
      if (normalize) {
        a.social_loss_dust_short_num = dust;
        a.explicit_unallocated_loss_short = explicit;
      }
      if (a.oi_eff_short_q < clear) failV16(V16_COUNTER_UNDERFLOW);
      a.oi_eff_short_q -= clear;
      if (a.loss_weight_sum_short < leg.loss_weight) failV16(V16_COUNTER_UNDERFLOW);
      a.loss_weight_sum_short -= leg.loss_weight;
    }
  } else {
    if (a.stored_pos_count_long === 0n) failV16(V16_COUNTER_UNDERFLOW);
    a.stored_pos_count_long -= 1n;
    if (obligation) {
      if (a.pending_obligation_count_long === 0n) failV16(V16_COUNTER_UNDERFLOW);
      a.pending_obligation_count_long -= 1n;
    }
    if (!prior) {
      if (normalize) {
        a.social_loss_dust_long_num = dust;
        a.explicit_unallocated_loss_long = explicit;
      }
      if (a.oi_eff_long_q < clear) failV16(V16_COUNTER_UNDERFLOW);
      a.oi_eff_long_q -= clear;
      if (a.loss_weight_sum_long < leg.loss_weight) failV16(V16_COUNTER_UNDERFLOW);
      a.loss_weight_sum_long -= leg.loss_weight;
    }
  }
}

/** The empty leg (`PortfolioLegV16::EMPTY`: every field zero but `a_basis`, ADL_ONE). */
function emptyLeg(leg: Inout<PortfolioLeg>): void {
  leg.active = 0n;
  leg.asset_index = 0n;
  leg.market_id = 0n;
  leg.side = 0n;
  leg.basis_pos_q = 0n;
  leg.a_basis = ADL_ONE;
  leg.k_snap = 0n;
  leg.f_snap = 0n;
  leg.kf_epoch_snap = 0n;
  leg.epoch_snap = 0n;
  leg.loss_weight = 0n;
  leg.b_snap = 0n;
  leg.b_rem = 0n;
  leg.b_epoch_snap = 0n;
  leg.b_stale = 0n;
  leg.stale = 0n;
}

/** The K/F currentness of a leg against its asset (InvalidLeg from the target; false when not current). */
function kfCurrent(a: AssetState, leg: PortfolioLeg): boolean {
  const target = kfTargetForLeg(a, leg);
  const epoch = leg.side === 1n ? a.kf_epoch_short : a.kf_epoch_long;
  return leg.kf_epoch_snap === epoch && target.k === leg.k_snap && fSnapResidualIsSubAtom(absH(leg.basis_pos_q), leg.a_basis, leg.f_snap, target.f);
}

/** The K/F currentness of a leg against its asset (InvalidLeg from the target, Stale when not current). */
function requireKfCurrent(a: AssetState, leg: PortfolioLeg): void {
  if (!kfCurrent(a, leg)) failV16(V16_STALE);
}

/**
 * `clear_leg_at_slot_inner(account, asset, slot, allow_attributed_terminal_trade, clear_effective)`: InvalidLeg past the
 * legs or for a leg that is not the slot's active, unstale leg of the asset; with an uncovered loss and other legs left
 * the liquidation lock set and the certificate invalidated; a pending close residual is LockActive unless it is the
 * attributed terminal trade's own; a pending barrier on the side is LockActive; the leg's K/F (Stale) and B (Stale)
 * current; the effective OI to clear (`hasClear`: given, else the leg's effective quantity); `kernel_clear_leg`; the slot
 * emptied, the bit cleared, the certificate invalidated, the asset written.
 *
 * With `staleAsValue` (the crank's `clear_leg` of a released obligation, whose Stale `permissionless_auto_crank_not_atomic`
 * swallows: NOTES.md section 1, site 3) the two Stale refusals return false instead, after the liquidation lock and
 * the certificate's invalidation the original has written by then; true when the leg was cleared.
 */
export function clearLegAtSlotInner(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  asset: u64,
  slot: u64,
  allowAttributed: boolean,
  hasClear: boolean,
  clearQ: u128,
  staleAsValue: boolean,
): boolean {
  if (slot >= V16_MAX_PORTFOLIO_ASSETS_N) failV16(V16_INVALID_LEG);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const leg = p.legs.get(slot);
  checkV16(legErr(leg));
  const bitmap = p.active_bitmap.get(0n);
  if (((bitmap >> slot) & 1n) === 0n || leg.active !== 1n || toU64(leg.asset_index) !== asset || leg.b_stale === 1n || leg.stale === 1n)
    failV16(V16_INVALID_LEG);
  const remaining = bitmap & ~(1n << slot);
  // uncovered_loss_remains_with_open_risk(pnl, capital, remaining bitmap).
  if (p.pnl < 0n && absH(p.pnl) > p.capital && remaining !== 0n) {
    p.liquidation_lock = 1n;
    p.health_cert.valid = 0n;
  }
  checkV16(closeProgressErr(p.close_progress));
  if (closeHasPendingResidual(p.close_progress)) {
    const attributed = allowAttributed && toU64(p.close_progress.asset_index) === asset && p.close_progress.domain_side !== leg.side;
    if (!attributed) failV16(V16_LOCK_ACTIVE);
  }
  const short = leg.side === 1n;
  if (hasPendingDomainLossBarrier(m, markets, asset, short)) failV16(V16_LOCK_ACTIVE);
  const at = assetSlot(m, markets, asset);
  const e = loadRawMutAt<EngineAssetSlot>(m, at);
  if (!kfCurrent(e.asset, leg)) {
    if (staleAsValue) return false;
    failV16(V16_STALE);
  }
  // b_target_for_leg(asset, leg): the asset configured and decoded (it was, just now).
  if (bTargetForLeg(e.asset, leg) !== leg.b_snap) {
    if (staleAsValue) return false;
    failV16(V16_STALE);
  }
  const clear = hasClear ? clearQ : effectiveAbsQuantityForLeg(e.asset, leg);
  const before = slotBlockers(e);
  kernelClearLeg(e.asset, leg, clear);
  emptyLeg(leg);
  p.active_bitmap.set(0n, remaining);
  p.health_cert.valid = 0n;
  setAssetState(m, asset, before);
  return true;
}

/** `clear_leg(account, asset)` (`clear_leg_inner(account, asset, false)`): the asset's active leg slot (InvalidLeg for
 * none), cleared of its effective quantity. */
export function clearLeg(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64): void {
  const slot = requireActiveLegSlotForAsset(pa, asset);
  clearLegAtSlotInner(m, markets, pa, asset, slot, false, false, 0n, false);
}

/** The crank's `clear_leg` of a released obligation, its Stale a value (false). */
export function clearLegOrStale(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64): boolean {
  const slot = requireActiveLegSlotForAsset(pa, asset);
  return clearLegAtSlotInner(m, markets, pa, asset, slot, false, false, 0n, true);
}

/**
 * `resize_leg_same_side_at_slot(account, asset, slot, new, preserve, old_eff, new_eff)`: the leg decoded, the new
 * weight, the asset decoded; `kernel_resize_leg_same_side` (the side's OI moved by the effective change, the weight sum
 * by the weight change unless an obligation's weight is preserved: `adjust_u128`); the basis and weight written, the
 * certificate invalidated, the asset written.
 */
function resizeLegSameSide(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  asset: u64,
  slot: u64,
  next: i128,
  preserve: boolean,
  oldEff: u128,
  newEff: u128,
): void {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const leg = p.legs.get(slot);
  checkV16(legErr(leg));
  const weight = lossWeightForBasis(absH(next), leg.a_basis);
  const e = loadRawMutAt<EngineAssetSlot>(m, assetSlot(m, markets, asset));
  const a = e.asset;
  const before = slotBlockers(e);
  if (leg.side === 1n) {
    a.oi_eff_short_q = adjustU128(a.oi_eff_short_q, oldEff, newEff);
    if (!preserve) a.loss_weight_sum_short = adjustU128(a.loss_weight_sum_short, leg.loss_weight, weight);
  } else {
    a.oi_eff_long_q = adjustU128(a.oi_eff_long_q, oldEff, newEff);
    if (!preserve) a.loss_weight_sum_long = adjustU128(a.loss_weight_sum_long, leg.loss_weight, weight);
  }
  leg.basis_pos_q = next;
  if (!preserve) leg.loss_weight = weight;
  p.health_cert.valid = 0n;
  setAssetState(m, asset, before);
}

/**
 * `apply_position_delta_with_lookup_inner(account, asset, delta, lookup, true)` (a trade's
 * `apply_current_position_delta_with_lookup`): nothing for no change; the lookup's arithmetic checked (InvalidLeg) and
 * its basis valid; an existing leg decoded, of the asset (HiddenLeg), K/F current (Stale), its sub-atom funding
 * remainder dropped; the signed position the lookup's (HiddenLeg); a pending barrier the change touches (LockActive
 * unless a same-side reduction); the route's unit-A requirement; then attach, clear (retained as a pending obligation
 * when its side holds a barrier), flip (clear, then attach) or resize (B current: Stale; an obligation's weight kept
 * for a reduction on a barrier side).
 */
export function applyPositionDelta(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, delta: i128, k: Lookup, allowTerminal: boolean): void {
  if (delta === 0n) return;
  // lookup.current_q + delta: both are bases (|·| ≤ 1e14), no overflow.
  if (k.current_q + delta !== k.next_q) failV16(V16_INVALID_LEG);
  validateBasisOrZero(k.next_q);
  let current: i128 = 0n;
  let currentShort = false;
  if (k.existing !== NO_SLOT) {
    const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
    const leg = p.legs.get(k.existing);
    checkV16(legErr(leg));
    if (leg.active !== 1n || toU64(leg.asset_index) !== asset) failV16(V16_HIDDEN_LEG);
    const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
    requireKfCurrent(a, leg);
    const target = kfTargetForLeg(a, leg);
    if (leg.f_snap !== target.f) leg.f_snap = target.f;
    current = signedPosition(leg);
    currentShort = leg.side === 1n;
  }
  if (current !== k.current_q) failV16(V16_HIDDEN_LEG);
  const next = k.next_q;
  if (barrierBlocks(positionChangeTouchesBarrier(m, markets, asset, k.current_eff, k.next_eff), k.current_eff, k.next_eff)) failV16(V16_LOCK_ACTIVE);
  const route = classifyRoute(k.current_eff, k.next_eff);
  // require_position_route_adl_safe: Attach and Flip always, Resize when it grows.
  if (route === 0n || route === 2n || (route === 3n && absH(k.next_eff) > absH(k.current_eff))) requireRiskChangeAllowed(m, markets, asset, true);
  if (route === 0n) {
    if (k.empty === NO_SLOT) failV16(V16_INVALID_LEG);
    attachLegAtSlot(m, markets, pa, asset, next < 0n, next, k.empty);
    return;
  }
  if (k.existing === NO_SLOT) failV16(V16_INVALID_LEG);
  const slot = k.existing;
  if (route === 1n) {
    // `current_leg.active`: the existing leg is active (checked above).
    if (hasPendingDomainLossBarrier(m, markets, asset, currentShort)) {
      const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
      const leg = p.legs.get(slot);
      const e = loadRawMutAt<EngineAssetSlot>(m, assetSlot(m, markets, asset));
      const retained = effectiveAbsQuantityForLeg(e.asset, leg);
      const before = slotBlockers(e);
      retainLegAsPendingObligation(e.asset, leg, retained);
      p.health_cert.valid = 0n;
      setAssetState(m, asset, before);
      return;
    }
    clearLegAtSlotInner(m, markets, pa, asset, slot, allowTerminal, true, absH(k.current_eff), false);
    return;
  }
  if (route === 2n) {
    clearLegAtSlotInner(m, markets, pa, asset, slot, false, false, 0n, false);
    if (k.empty === NO_SLOT) failV16(V16_INVALID_LEG);
    attachLegAtSlot(m, markets, pa, asset, next < 0n, next, k.empty);
    return;
  }
  const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  if (bTargetForLeg(a, leg) !== leg.b_snap) failV16(V16_STALE);
  const preserve = sameSideReduction(k.current_eff, k.next_eff) && hasPendingDomainLossBarrier(m, markets, asset, currentShort);
  resizeLegSameSide(m, markets, pa, asset, slot, next, preserve, absH(k.current_eff), absH(k.next_eff));
}

/**
 * `kernel_retain_leg_as_pending_obligation(leg, asset, retained)` in place: InvalidLeg for an inactive leg, a zero basis
 * or weight, nothing retained while the side has OI, or more than the basis; the side's OI lowered (CounterUnderflow),
 * its pending-obligation count raised (CounterOverflow), the leg's basis zeroed.
 */
export function retainLegAsPendingObligation(a: Inout<AssetState>, leg: Inout<PortfolioLeg>, retained: u128): void {
  const short = leg.side === 1n;
  const sideOi = short ? a.oi_eff_short_q : a.oi_eff_long_q;
  if (leg.active !== 1n || leg.basis_pos_q === 0n || leg.loss_weight === 0n || (retained === 0n && sideOi !== 0n) || retained > absH(leg.basis_pos_q))
    failV16(V16_INVALID_LEG);
  if (sideOi < retained) failV16(V16_COUNTER_UNDERFLOW);
  if (short) {
    if (a.pending_obligation_count_short === U64_MAX_T) failV16(V16_COUNTER_OVERFLOW);
    a.oi_eff_short_q -= retained;
    a.pending_obligation_count_short += 1n;
  } else {
    if (a.pending_obligation_count_long === U64_MAX_T) failV16(V16_COUNTER_OVERFLOW);
    a.oi_eff_long_q -= retained;
    a.pending_obligation_count_long += 1n;
  }
  leg.basis_pos_q = 0n;
}

// ---- The position plan ----------------------------------------------------------------------------------------------

/**
 * `PositionSlotMapV16::from_account(account)`'s checks: each slot's leg decoded; a slot in the bitmap holds an active
 * leg of an asset no earlier bitmap slot holds; a slot outside it an inactive empty leg (HiddenLeg each).
 */
function positionMapCheck(pa: RemainingAccount): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (((bitmap >> slot) & 1n) !== 0n) {
      if (leg.active !== 1n) failV16(V16_HIDDEN_LEG);
      // `out.assets[..slot].contains(asset)`: an earlier slot outside the bitmap holds u32::MAX there.
      for (let j = 0n; j < slot; j++) if (mapAsset(p, bitmap, j) === toU64(leg.asset_index)) failV16(V16_HIDDEN_LEG);
    } else if (leg.active === 1n) failV16(V16_HIDDEN_LEG);
  }
}

/** The map's entry of a slot: the leg's asset in the bitmap, else u32::MAX. */
function mapAsset(p: Portfolio, bitmap: u64, slot: u64): u64 {
  return ((bitmap >> slot) & 1n) !== 0n ? toU64(p.legs.get(slot).asset_index) : U32_MAX_T;
}

/**
 * `PositionSlotMapV16::plan_delta(asset, delta, asset_state)` on a map just built from the account: the existing slot
 * (the first holding the asset), its current basis and effective quantity (the side's A against the leg's: HiddenLeg
 * for a zero basis), the next effective quantity (a valid basis or zero), the next basis by route (Attach and Flip the
 * effective quantity, Clear 0, Resize the largest raw basis whose effective quantity is the next one, at most the
 * current basis for a reduction), and the empty slot an attach takes (the first free one, after the flip's clear).
 */
export function planDelta(m: RemainingAccount, pa: RemainingAccount, asset: u64, delta: i128, a: AssetState): Lookup {
  return planDeltaOn(pa, asset, delta, a, loadRawAt<Portfolio>(pa, HEADER_LEN).active_bitmap.get(0n));
}

/**
 * `plan_delta` on a map whose occupied slots are `bitmap` (the account's active bitmap when the map is fresh; in a
 * batch, the slots the earlier plans of the same map attached and cleared: `planMapAfter`). Every slot the map holds
 * holds, in the account, the leg the map names, so the map's assets, positions and A bases are read from the legs.
 */
export function planDeltaOn(pa: RemainingAccount, asset: u64, delta: i128, a: AssetState, bitmap: u64): Lookup {
  if (asset > U32_MAX_T) failV16(V16_INVALID_LEG);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  let existing = NO_SLOT;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++)
    if (mapAsset(p, bitmap, slot) === asset) {
      existing = slot;
      break;
    }
  let currentQ: i128 = 0n;
  let currentEff: i128 = 0n;
  if (existing !== NO_SLOT) {
    const leg = p.legs.get(existing);
    currentQ = signedPosition(leg);
    if (currentQ === 0n) failV16(V16_HIDDEN_LEG);
    const eff = adlEffectiveQuantityCeil(absH(currentQ), leg.a_basis, currentQ > 0n ? a.a_long : a.a_short);
    if (eff > I128_MAX_T) failV16(V16_ARITHMETIC_OVERFLOW);
    currentEff = currentQ > 0n ? toI128(eff) : -toI128(eff);
  }
  // current_effective + delta: |current_effective| ≤ 1e14 and the delta is a trade size (≤ 1e14): no overflow.
  const nextEff = currentEff + delta;
  validateBasisOrZero(nextEff);
  const route = classifyRoute(currentEff, nextEff);
  let nextQ: i128 = 0n;
  if (route === 0n || route === 2n) nextQ = nextEff;
  else if (route === 3n) {
    const leg = p.legs.get(existing);
    const currentA = nextEff > 0n ? a.a_long : a.a_short;
    // kernel_raw_basis_for_adl_effective_quantity.
    const effAbs = absH(nextEff);
    if (effAbs > MAX_POSITION_ABS_Q || leg.a_basis < MIN_A_SIDE || leg.a_basis > ADL_ONE || currentA < 1n || currentA > leg.a_basis) failV16(V16_INVALID_LEG);
    let raw = mulDivFloorWide(effAbs, leg.a_basis, currentA);
    if (raw > MAX_POSITION_ABS_Q) failV16(V16_INVALID_LEG);
    if (effAbs <= absH(currentEff) && raw > absH(currentQ)) raw = absH(currentQ);
    nextQ = nextEff > 0n ? toI128(raw) : -toI128(raw);
  }
  validateBasisOrZero(nextQ);
  let empty = NO_SLOT;
  if (route === 0n || route === 2n) {
    for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
      const free = (route === 2n && slot === existing) || mapAsset(p, bitmap, slot) === U32_MAX_T;
      if (free) {
        empty = slot;
        break;
      }
    }
    if (empty === NO_SLOT) failV16(V16_INVALID_LEG);
  } else if (existing === NO_SLOT) failV16(V16_INVALID_LEG);
  return { existing, empty, current_q: currentQ, next_q: nextQ, current_eff: currentEff, next_eff: nextEff };
}

/**
 * The map's occupied slots after `plan_delta` gave `k`: an attach takes the empty slot; a clear frees the existing one;
 * a flip frees the existing slot and takes the empty one (the first free after that); a resize changes neither.
 */
export function planMapAfter(bitmap: u64, k: Lookup): u64 {
  let b = bitmap;
  if (k.existing !== NO_SLOT && (k.next_q === 0n || k.empty !== NO_SLOT)) b &= ~(1n << k.existing);
  if (k.empty !== NO_SLOT) b |= 1n << k.empty;
  return b;
}

/** `V16Core::mul_div_floor_u128_or_wide(a, b, d)` (d nonzero here). */
function mulDivFloorWide(a: u128, b: u128, d: u128): u128 {
  const q: u256 = (toU256(a) * toU256(b)) / toU256(d);
  if (q > U128_MAX_TW) failV16(V16_ARITHMETIC_OVERFLOW);
  return toU128(q);
}

// ---- Fees, notional, residual credits ---------------------------------------------------------------------------------

/** `checked_fee_bps(notional, bps)`: ⌈notional · bps / 10,000⌉ (0 for either zero; ArithmeticOverflow past u128). */
export function checkedFeeBps(notional: u128, bps: u64): u128 {
  if (notional === 0n || bps === 0n) return 0n;
  const p: u256 = toU256(notional) * toU256(bps);
  const q: u256 = p / 10000n + (p % 10000n !== 0n ? 1n : 0n);
  if (q > U128_MAX_TW) failV16(V16_ARITHMETIC_OVERFLOW);
  return toU128(q);
}

/** `trade_notional_floor(size, price)`: ⌊size · price / POS_SCALE⌋ (ArithmeticOverflow past u128: unreachable for a
 * bounded size and price, kept). */
function tradeNotionalFloor(size: u128, price: u64): u128 {
  if (size === 0n) return 0n;
  const q: u256 = (toU256(size) * toU256(price)) / 1000000n;
  if (q > U128_MAX_TW) failV16(V16_ARITHMETIC_OVERFLOW);
  return toU128(q);
}

/** `transfer_account_residual_reward_credit(trader, lp, principal)`: the trader's crystallized loss not yet spent
 * (CounterUnderflow) up to the principal, spent by the trader and received by the LP (CounterOverflow each). */
function transferResidualRewardCredit(trader: RemainingAccount, lp: RemainingAccount, principal: u128): void {
  if (principal === 0n) return;
  const t = loadRawMutAt<Portfolio>(trader, HEADER_LEN);
  const crystallized = t.residual_crystallized_loss_atoms_total;
  const spent = t.residual_spent_principal_atoms_total;
  if (crystallized < spent) failV16(V16_COUNTER_UNDERFLOW);
  const available = crystallized - spent;
  const credit = available < principal ? available : principal;
  if (credit === 0n) return;
  if (spent > U128_MAX_T - credit) failV16(V16_COUNTER_OVERFLOW);
  t.residual_spent_principal_atoms_total = spent + credit;
  const l = loadRawMutAt<Portfolio>(lp, HEADER_LEN);
  if (l.residual_received_atoms_total > U128_MAX_T - credit) failV16(V16_COUNTER_OVERFLOW);
  l.residual_received_atoms_total += credit;
}

/** `increased_initial_margin_principal(config, old, new, price)`: the initial margin a growth adds (0 otherwise). */
function increasedInitialMargin(m: RemainingAccount, oldQ: u128, newQ: u128, price: u64): u128 {
  if (newQ <= oldQ) return 0n;
  const c = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config;
  const oldReq = marginRequirement(riskNotionalCeil(oldQ, price), c.initial_margin_bps, c.min_nonzero_im_req);
  const newReq = marginRequirement(riskNotionalCeil(newQ, price), c.initial_margin_bps, c.min_nonzero_im_req);
  return newReq > oldReq ? newReq - oldReq : 0n;
}

// ---- The close-progress ledger of a terminal trade --------------------------------------------------------------------

/**
 * `set_pending_domain_loss_barrier_count(asset, side, value)`: the asset configured (InvalidLeg); the slot's blockers
 * with the side's barrier replaced (CounterOverflow), the market's total moved, the count written.
 */
export function setPendingBarrierCount(m: RemainingAccount, markets: u64, asset: u64, short: boolean, value: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const before = slotBlockers(e);
  if (before > toU128(U64_MAX_T)) failV16(V16_COUNTER_OVERFLOW);
  const old = short ? e.pending_domain_loss_barrier_short : e.pending_domain_loss_barrier_long;
  // old_blockers − old_value + value, each checked (CounterOverflow): old_value ≤ old_blockers.
  const rest = toU64(before) - old;
  if (rest > U64_MAX_T - value) failV16(V16_COUNTER_OVERFLOW);
  if (short) e.pending_domain_loss_barrier_short = value;
  else e.pending_domain_loss_barrier_long = value;
  blockersAfter(m, asset, toU64(before));
}

/**
 * `begin_close_progress_ledger(account, asset, domain_side, gross)`: validated with the market; nothing for no loss; an
 * active ledger that is not finalized-inert is LockActive; the domain; a pending barrier on the side is LockActive; a
 * new ledger (the next close id, the asset's market id, the slot and the lifetime's deadline: ArithmeticOverflow; the
 * residual the gross loss); the side's barrier count raised (CounterOverflow); the domain checked again.
 */
export function beginCloseProgressLedger(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, short: boolean, gross: u128): void {
  validateWithMarket(m, pa, markets);
  if (gross === 0n) return;
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const c = p.close_progress;
  checkV16(closeProgressErr(c));
  const finalizedInert = c.active === 1n && c.finalized === 1n && c.canceled === 0n && c.residual_remaining === 0n;
  if (c.active === 1n && !finalizedInert) failV16(V16_LOCK_ACTIVE);
  const domain = insuranceDomainIndex(m, markets, asset, short);
  if (pendingDomainLossBarrierCount(m, markets, asset, short) !== 0n) failV16(V16_LOCK_ACTIVE);
  const id = c.close_id === U64_MAX_T ? U64_MAX_T : c.close_id + 1n;
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  if (asset > U32_MAX_T) failV16(V16_INVALID_LEG);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const life = h.config.max_bankrupt_close_lifetime_slots;
  if (h.current_slot > U64_MAX_T - life) failV16(V16_ARITHMETIC_OVERFLOW);
  c.active = 1n;
  c.finalized = 0n;
  c.canceled = 0n;
  c.close_id = id === 0n ? 1n : id;
  c.asset_index = toU32(asset);
  c.market_id = a.market_id;
  c.domain_side = short ? 1n : 0n;
  c.gross_loss_at_close_start = gross;
  c.drift_reference_slot = h.current_slot;
  c.max_close_slot = h.current_slot + life;
  c.support_consumed = 0n;
  c.junior_face_burned = 0n;
  c.insurance_spent = 0n;
  c.b_loss_booked = 0n;
  c.explicit_loss_assigned = 0n;
  c.quantity_adl_applied_q = 0n;
  c.drift_consumed = 0n;
  c.residual_remaining = gross;
  const count = pendingDomainLossBarrierCount(m, markets, asset, short);
  if (count === U64_MAX_T) failV16(V16_COUNTER_OVERFLOW);
  setPendingBarrierCount(m, markets, asset, short, count + 1n);
  domainAssetSide(m, markets, domain);
}

/**
 * `terminal_trade_residual_asset_before_refresh(account)`: the asset of the one active leg of an account with a PnL at
 * or above zero and no pending close residual; NO_ASSET otherwise (HiddenLeg for a bit without a leg).
 */
function terminalResidualAsset(pa: RemainingAccount): u64 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  if (p.pnl < 0n) return NO_ASSET;
  checkV16(closeProgressErr(p.close_progress));
  if (closeHasPendingResidual(p.close_progress)) return NO_ASSET;
  const bitmap = p.active_bitmap.get(0n);
  if (bitmap === 0n || (bitmap & (bitmap - 1n)) !== 0n) return NO_ASSET;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active === 1n) return toU64(leg.asset_index);
  }
  failV16(V16_HIDDEN_LEG);
  return NO_ASSET;
}

/**
 * `begin_terminal_trade_residual_if_needed(account, asset, lookup, true, attributable)`: a fill that closes the one
 * attributable leg of an account now at a loss begins its close-progress ledger on the opposite side for the loss (the
 * existing slot, the leg active, of the asset and at the lookup's position: InvalidLeg otherwise).
 */
function beginTerminalResidual(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, k: Lookup, attributable: u64): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  if (attributable !== asset || k.current_q === 0n || k.next_q !== 0n || p.pnl >= 0n || bitmap === 0n || (bitmap & (bitmap - 1n)) !== 0n) return;
  if (k.existing === NO_SLOT) failV16(V16_INVALID_LEG);
  const leg = p.legs.get(k.existing);
  checkV16(legErr(leg));
  if (leg.active !== 1n || toU64(leg.asset_index) !== asset || signedPosition(leg) !== k.current_q) failV16(V16_INVALID_LEG);
  beginCloseProgressLedger(m, markets, pa, asset, leg.side !== 1n, absH(p.pnl));
}

// ---- Initial-margin source liens --------------------------------------------------------------------------------------

/** `account_no_positive_credit_equity(account)`: capital + min(PnL, 0) − fee debt (the PnL and fee credits valid;
 * ArithmeticOverflow). */
export function noPositiveCreditEquity(pa: RemainingAccount): i128 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(nonMinI128Err(p.pnl));
  checkV16(nonMinI128Err(p.fee_credits));
  if (p.fee_credits > 0n) failV16(V16_INVALID_LEG);
  if (p.capital > I128_MAX_T) failV16(V16_ARITHMETIC_OVERFLOW);
  const sum = toI128(p.capital) + (p.pnl < 0n ? p.pnl : 0n);
  const debt = toI128(absH(p.fee_credits));
  if (sum < I128_MIN + debt) failV16(V16_ARITHMETIC_OVERFLOW);
  return sum - debt;
}

/** `valid_source_lien_effective_reserved_sum(account)`: the supporting lien reserve of every occupied domain before the
 * compacted tail (ArithmeticOverflow). */
function validLienReserveSum(m: RemainingAccount, markets: u64, pa: RemainingAccount): u128 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  let sum: u128 = 0n;
  for (let d = 0n; d < PORTFOLIO_SOURCE_DOMAIN_CAP; d++) {
    const s = p.source_domains.get(d);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) break;
    if (!occupied) continue;
    const v = lienEffectiveSupporting(m, markets, s);
    if (sum > U128_MAX_T - v) failV16(V16_ARITHMETIC_OVERFLOW);
    sum += v;
  }
  return sum;
}

/** `incremental_initial_margin_source_credit_needed(account, no_positive_equity)`: the certificate decoded and valid
 * (Stale); the initial requirement not covered by the no-positive-credit equity and the existing supporting liens. */
function incrementalCreditNeeded(m: RemainingAccount, markets: u64, pa: RemainingAccount, equity: i128): u128 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(healthCertErr(p.health_cert));
  if (p.health_cert.valid !== 1n) failV16(V16_STALE);
  const initial = p.health_cert.certified_initial_req;
  const existing = validLienReserveSum(m, markets, pa);
  if (equity >= 0n) {
    if (toU128(equity) > U128_MAX_T - existing) failV16(V16_ARITHMETIC_OVERFLOW);
    const covered = toU128(equity) + existing;
    return initial > covered ? initial - covered : 0n;
  }
  if (initial > U128_MAX_T - absH(equity)) failV16(V16_ARITHMETIC_OVERFLOW);
  const need = initial + absH(equity);
  return need > existing ? need - existing : 0n;
}

/**
 * `create_source_credit_lien_backing_not_atomic(domain, backing)`: the domain; InvalidConfig for no backing; the bucket
 * (decoded, effective expiry) when it is Fresh, unexpired and holds the backing unliened: a counterparty lien (true);
 * else the reservation's unencumbered part (ArithmeticOverflow, CounterUnderflow) when it holds it: an insurance lien
 * (false); else LockActive.
 */
function createLienBacking(m: RemainingAccount, markets: u64, domain: u64, backing: u128): boolean {
  domainAssetSide(m, markets, domain);
  if (backing === 0n) failV16(V16_INVALID_CONFIG);
  const expiry = bucketForDomain(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  if (b.status === BUCKET_FRESH_T && expiry > loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot && b.fresh_unliened_backing_num >= backing) {
    createCounterpartyLienCore(m, markets, domain, backing);
    return true;
  }
  reservationForDomain(m, markets, domain);
  const r = loadRawAt<InsuranceCreditReservation>(m, reservationAt(domain));
  if (r.valid_liened_insurance_num > U128_MAX_T - r.impaired_liened_insurance_num) failV16(V16_ARITHMETIC_OVERFLOW);
  const encumbered = r.valid_liened_insurance_num + r.impaired_liened_insurance_num;
  if (r.insurance_credit_reserved_num < encumbered) failV16(V16_COUNTER_UNDERFLOW);
  if (r.insurance_credit_reserved_num - encumbered >= backing) {
    createInsuranceLienCore(m, markets, domain, backing);
    return false;
  }
  failV16(V16_LOCK_ACTIVE);
  return false;
}

/** `checked_add` of a portfolio counter (ArithmeticOverflow). */
function addChecked(v: u128, x: u128): u128 {
  if (v > U128_MAX_T - x) failV16(V16_ARITHMETIC_OVERFLOW);
  return v + x;
}

/**
 * `create_account_source_credit_lien_for_effective_unchecked(account, domain, effective)`: the domain; nothing for
 * zero; the ledger current, the rate, the face and backing the effective credit needs; LockActive when the unliened
 * claim is short of the face; the domain's utilization fee collected; the backing liened (counterparty or insurance);
 * the domain's source slot (or a new one) raised by the face, the effective reserve and the backing on its side (the
 * counterparty fee cursor started on a first counterparty backing: `apply_account_source_credit_lien_delta`,
 * ArithmeticOverflow each); the certificate invalidated.
 */
function createAccountLienForEffective(m: RemainingAccount, markets: u64, pa: RemainingAccount, domain: u64, effective: u128): void {
  domainAssetSide(m, markets, domain);
  if (effective === 0n) return;
  validateDomainLedgerCurrent(m, markets, domain);
  sourceForDomain(m, markets, domain);
  const amounts = sourceCreditLienAmounts(effective, loadRawAt<SourceCreditState>(m, sourceAt(domain)).credit_rate_num);
  const face = amounts.a;
  const backing = amounts.b;
  if (sourceClaimUnliened(pa, domain) < face) failV16(V16_LOCK_ACTIVE);
  collectBackingUtilizationFee(m, markets, pa, domain);
  const counterparty = createLienBacking(m, markets, domain, backing);
  const slot = sourceDomainSlotOrInsert(pa, domain);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const s = p.source_domains.get(slot);
  const prior = s.source_lien_counterparty_backing_num;
  s.source_claim_liened_num = addChecked(s.source_claim_liened_num, face);
  s.source_lien_effective_reserved = addChecked(s.source_lien_effective_reserved, effective);
  if (counterparty) {
    s.source_claim_counterparty_liened_num = addChecked(s.source_claim_counterparty_liened_num, face);
    s.source_lien_counterparty_backing_num = addChecked(s.source_lien_counterparty_backing_num, backing);
    if (prior === 0n) s.source_lien_fee_last_slot = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
  } else {
    s.source_claim_insurance_liened_num = addChecked(s.source_claim_insurance_liened_num, face);
    s.source_lien_insurance_backing_num = addChecked(s.source_lien_insurance_backing_num, backing);
  }
  p.health_cert.valid = 0n;
}

/**
 * `create_account_source_credit_lien_for_effective_any_not_atomic(account, effective)`: validated with the market; over
 * the occupied domains before the compacted tail, each with a rate and an unliened claim (its ledger current) liens what
 * its claim at the rate (in 256 bits: ArithmeticOverflow) and its available backing allow, up to what is left;
 * LockActive when the domains cannot cover it all; validated with the market again.
 */
function createAccountLienAny(m: RemainingAccount, markets: u64, pa: RemainingAccount, effective: u128): void {
  validateWithMarket(m, pa, markets);
  let remaining = effective;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP && remaining !== 0n; slot++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) break;
    if (!occupied) continue;
    const d = toU64(s.domain);
    sourceForDomain(m, markets, d);
    const rate = loadRawAt<SourceCreditState>(m, sourceAt(d)).credit_rate_num;
    const unliened = sourceClaimUnliened(pa, d);
    if (rate !== 0n && unliened !== 0n) {
      validateDomainLedgerCurrent(m, markets, d);
      const soft: u256 = (toU256(unliened) * toU256(rate)) / toU256(CREDIT_RATE_SCALE);
      if (soft > U128_MAX_TW) failV16(V16_ARITHMETIC_OVERFLOW);
      const byClaim = toU128(soft) / BOUND_SCALE;
      const byBacking = sourceCreditAvailableBacking(m, markets, d) / BOUND_SCALE;
      let take = remaining < byClaim ? remaining : byClaim;
      if (byBacking < take) take = byBacking;
      if (take !== 0n) {
        createAccountLienForEffective(m, markets, pa, d, take);
        remaining -= take;
      }
    }
  }
  if (remaining !== 0n) failV16(V16_LOCK_ACTIVE);
  validateWithMarket(m, pa, markets);
}

/**
 * `create_initial_margin_source_lien_if_needed(account)`: at most two rounds of: the certificate valid (decoded; Stale);
 * the credit the initial margin still needs; none ends it; otherwise liens for it and the certificate's equity taken
 * again (`recertify_account_after_source_lien_change`). A third round would be LockActive.
 */
function createInitialMarginLienIfNeeded(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  for (let round = 0n; round < 2n; round++) {
    const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
    checkV16(boolErr(p.health_cert.valid));
    if (p.health_cert.valid !== 1n) failV16(V16_STALE);
    const required = incrementalCreditNeeded(m, markets, pa, noPositiveCreditEquity(pa));
    if (required === 0n) return;
    createAccountLienAny(m, markets, pa, required);
    recertifyAfterSourceLienChange(m, markets, pa);
  }
  failV16(V16_LOCK_ACTIVE);
}

/** `ensure_initial_margin(account)` (`kernel_initial_margin_gate`): the certificate decoded; not valid: Stale; a
 * negative equity or one below the initial requirement: InvalidConfig. */
function ensureInitialMargin(pa: RemainingAccount): void {
  const c = loadRawAt<Portfolio>(pa, HEADER_LEN).health_cert;
  checkV16(healthCertErr(c));
  if (c.valid !== 1n) failV16(V16_STALE);
  if (c.certified_equity < 0n || toU128(c.certified_equity) < c.certified_initial_req) failV16(V16_INVALID_CONFIG);
}

/** `ensure_no_positive_credit_initial_margin(account)` (`kernel_locked_margin_gate`): capital + min(PnL, 0) − fee debt
 * covering the certified initial requirement, LockActive otherwise. */
function ensureNoPositiveCreditInitialMargin(pa: RemainingAccount): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(nonMinI128Err(p.pnl));
  checkV16(nonMinI128Err(p.fee_credits));
  if (p.fee_credits > 0n) failV16(V16_INVALID_LEG);
  checkV16(healthCertErr(p.health_cert));
  const equity = noPositiveCreditEquity(pa);
  if (equity < 0n || toU128(equity) < p.health_cert.certified_initial_req) failV16(V16_LOCK_ACTIVE);
}

// ---- The zero-OI residue resets -----------------------------------------------------------------------------------------

/**
 * `begin_zero_oi_residue_resets(asset)`: the unowned side OI dropped (`drop_unowned_side_oi`: on a Live market only once
 * the asset is legless and neither side holds a barrier), then a side with no OI, no pending obligation, not already
 * resetting and with stored legs or an A below one begins its full-drain reset.
 */
export function beginZeroOiResidueResets(m: RemainingAccount, markets: u64, asset: u64): void {
  const at = assetSlot(m, markets, asset);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  const resolved = h.mode === MODE_RESOLVED_T;
  const e0 = loadRawAt<EngineAssetSlot>(m, at);
  let skip = !resolved && (e0.asset.stored_pos_count_long !== 0n || e0.asset.stored_pos_count_short !== 0n);
  if (!skip) {
    const barrierLong = hasPendingDomainLossBarrier(m, markets, asset, false);
    const barrierShort = hasPendingDomainLossBarrier(m, markets, asset, true);
    if (!(!resolved && (barrierLong || barrierShort))) {
      const e = loadRawMutAt<EngineAssetSlot>(m, at);
      const dropLong = e.asset.stored_pos_count_long === 0n && e.asset.oi_eff_long_q !== 0n && !barrierLong;
      const dropShort = e.asset.stored_pos_count_short === 0n && e.asset.oi_eff_short_q !== 0n && !barrierShort;
      if (dropLong || dropShort) {
        const before = slotBlockers(e);
        if (dropLong) e.asset.oi_eff_long_q = 0n;
        if (dropShort) e.asset.oi_eff_short_q = 0n;
        setAssetState(m, asset, before);
      }
    }
  }
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const resetLong =
    a.oi_eff_long_q === 0n &&
    a.pending_obligation_count_long === 0n &&
    a.mode_long !== SIDE_MODE_RESET_PENDING_T &&
    (a.stored_pos_count_long !== 0n || a.a_long !== ADL_ONE);
  const resetShort =
    a.oi_eff_short_q === 0n &&
    a.pending_obligation_count_short === 0n &&
    a.mode_short !== SIDE_MODE_RESET_PENDING_T &&
    (a.stored_pos_count_short !== 0n || a.a_short !== ADL_ONE);
  if (resetLong) beginFullDrainResetInner(m, markets, asset, false);
  if (resetShort) beginFullDrainResetInner(m, markets, asset, true);
}

// ---- The trade ---------------------------------------------------------------------------------------------------------

/**
 * `can_ignore_unrelated_loss_stale_for_trade(long, short, asset)`: on a loss-stale market, the trade's asset not
 * loss-stale and neither account holding a loss-stale live leg (`loss_stale_trade_scope_allowed`; all three evaluated).
 */
function canIgnoreUnrelatedLossStale(m: RemainingAccount, markets: u64, long: RemainingAccount, short: RemainingAccount, asset: u64): boolean {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(boolErr(h.loss_stale_active));
  if (h.loss_stale_active === 0n) return false;
  const assetStale = assetIsLossStale(m, markets, asset);
  const longStale = accountHasLossStaleLiveLeg(m, markets, long);
  const shortStale = accountHasLossStaleLiveLeg(m, markets, short);
  return !assetStale && !longStale && !shortStale;
}

/**
 * `validate_trade_position_preflight(long, short, request, long_lookup, short_lookup)`: the size; whether either
 * account's effective position grows; the reduction of each side's OI at most that side's OI before the trade
 * (`kernel_trade_preexisting_oi_reduction_gate` on the raw asset: LockActive); the target lag; whether a pending barrier
 * blocks either change; `trade_preflight_risk_gate` (a barrier, or growth on a loss-stale or lagging asset: LockActive).
 * Returns whether the trade increases risk.
 */
function tradePreflight(m: RemainingAccount, markets: u64, r: TradeRequest, lk: Lookup, sk: Lookup): boolean {
  const longGrows = absH(lk.next_eff) > absH(lk.current_eff);
  const shortGrows = absH(sk.next_eff) > absH(sk.current_eff);
  const increasing = longGrows || shortGrows;
  if (r.asset >= markets) failV16(V16_INVALID_LEG);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(r.asset)).asset;
  const longReduction = sideReduction(lk.current_eff, lk.next_eff, false) + sideReduction(sk.current_eff, sk.next_eff, false);
  const shortReduction = sideReduction(lk.current_eff, lk.next_eff, true) + sideReduction(sk.current_eff, sk.next_eff, true);
  if (longReduction > a.oi_eff_long_q || shortReduction > a.oi_eff_short_q) failV16(V16_LOCK_ACTIVE);
  const lag = assetHasTargetLag(m, markets, r.asset);
  let blocked = barrierBlocks(positionChangeTouchesBarrier(m, markets, r.asset, lk.current_eff, lk.next_eff), lk.current_eff, lk.next_eff);
  if (!blocked) blocked = barrierBlocks(positionChangeTouchesBarrier(m, markets, r.asset, sk.current_eff, sk.next_eff), sk.current_eff, sk.next_eff);
  const stale = assetIsLossStale(m, markets, r.asset);
  if (blocked || (increasing && (stale || lag))) failV16(V16_LOCK_ACTIVE);
  return increasing;
}

/** One side's part of `kernel_trade_preexisting_oi_reduction_gate`: the position held on the side before less after. */
function sideReduction(current: i128, next: i128, short: boolean): u128 {
  const before = short ? (current < 0n ? absH(current) : 0n) : current > 0n ? toU128(current) : 0n;
  const after = short ? (next < 0n ? absH(next) : 0n) : next > 0n ? toU128(next) : 0n;
  return before > after ? before - after : 0n;
}

/**
 * `execute_trade_with_fee_loss_stale_scoped_not_atomic(long, short, request)`: the market's dynamic slots against its
 * capacity (InvalidConfig); on a loss-stale market the trade scoped when nothing it touches is loss-stale (the flag
 * cleared for the trade and restored after); then `execute_batch_with_fee_after_tail_validation_not_atomic` for the one
 * request; the market's shape and both accounts validated with it. Returns the two fees (long, short).
 */
export function executeTrade(m: RemainingAccount, markets: u64, long: RemainingAccount, short: RemainingAccount, r: TradeRequest): TradeFees {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  // validate_unconfigured_market_tail (validate_dynamic_market_slots_len_static).
  if (markets !== toU64(h.asset_slot_capacity) || toU64(h.asset_slot_capacity) < toU64(h.config.max_market_slots)) failV16(V16_INVALID_CONFIG);
  checkV16(boolErr(h.loss_stale_active));
  let scoped = h.loss_stale_active === 1n;
  if (scoped) scoped = canIgnoreUnrelatedLossStale(m, markets, long, short, r.asset);
  const restore = h.loss_stale_active;
  if (scoped) h.loss_stale_active = 0n;
  const fees = executeAfterTailValidation(m, markets, long, short, r);
  if (scoped) {
    const hr = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    hr.loss_stale_active = restore;
  }
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, long, markets);
  validateWithMarket(m, short, markets);
  return fees;
}

/**
 * `execute_batch_with_fee_after_tail_validation_not_atomic(long, short, [request])`: LockActive unless Live; the config's
 * shape; a single request within the portfolio cap (InvalidConfig); `validate_trade_request` (the asset configured, the
 * size nonzero and within the cap, the price nonzero and at most MAX_ORACLE_PRICE, the fee at most the maximum:
 * InvalidConfig); each account's attributable terminal asset; each account settled and certified for the position
 * action; the H-lock lane (the short account's only when the long's is not HMax); the position plans; the fill; the
 * finishing margin checks; the zero-OI residue resets.
 */
function executeAfterTailValidation(m: RemainingAccount, markets: u64, long: RemainingAccount, short: RemainingAccount, r: TradeRequest): TradeFees {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_LIVE_T) failV16(V16_LOCK_ACTIVE);
  checkV16(configShapeErr(h.config));
  if (1n > toU64(h.config.max_portfolio_assets)) failV16(V16_INVALID_CONFIG);
  validateTradeRequest(m, r.asset, r.size, r.price, r.fee_bps);
  const longAttributable = terminalResidualAsset(long);
  const shortAttributable = terminalResidualAsset(short);
  settleForPositionAction(m, markets, long);
  settleForPositionAction(m, markets, short);
  let locked = accountHLockMax(m, markets, long);
  if (!locked) locked = accountHLockMax(m, markets, short);
  positionMapCheck(long);
  positionMapCheck(short);
  // trade_signed_size_deltas(size): nonzero and within the cap (checked by the request's validation).
  const at = assetSlot(m, markets, r.asset);
  const lk = planDelta(m, long, r.asset, r.size, loadRawAt<EngineAssetSlot>(m, at).asset);
  const sk = planDelta(m, short, r.asset, -r.size, loadRawAt<EngineAssetSlot>(m, at).asset);
  const applied = applyTradeAfterRefresh(m, markets, long, short, r.asset, r.size, r.price, r.fee_bps, lk, sk, true, true, longAttributable, shortAttributable);
  // kernel_accumulate_batch_trade from the empty outcome: one fill, the sums of one fill (no overflow).
  finishTradeChecks(m, markets, long, short, locked, applied);
  beginZeroOiResidueResets(m, markets, r.asset);
  return { fee_long: applied.fee_a, fee_short: applied.fee_b };
}

/** `validate_trade_request(request)` (`build_trade_request_guard_summary`): the asset configured, the size nonzero and
 * within the cap, the price nonzero and at most MAX_ORACLE_PRICE, the fee at most the maximum (InvalidConfig). */
function validateTradeRequest(m: RemainingAccount, asset: u64, sizeQ: i128, price: u64, feeBps: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const size = absH(sizeQ);
  if (
    asset >= toU64(h.config.max_market_slots) ||
    sizeQ === 0n ||
    size > MAX_TRADE_SIZE_Q ||
    price === 0n ||
    price > MAX_ORACLE_PRICE ||
    feeBps > h.config.max_trading_fee_bps
  )
    failV16(V16_INVALID_CONFIG);
}

/** `TradeApplyOutcomeV16`: the fees charged (the long account's, the short's), the notional, whether the fill
 * increases risk, whether each account needs the initial margin, whether each holds source claims. */
interface Applied {
  fee_a: u128;
  fee_b: u128;
  notional: u128;
  risk: boolean;
  long_im: boolean;
  short_im: boolean;
  long_claims: boolean;
  short_claims: boolean;
}

/**
 * `apply_trade_after_refresh_not_atomic(long, short, request, lookups, recertify_after_fill, is_final_batch_fill,
 * attributable assets)`: the preflight and the risk-change gate, the notional, the fee charged from each account, the
 * terminal residual of a final fill, both position deltas, the side-OI cap on the net fill, the residual reward credit,
 * and (for a single request) both recertifications.
 *
 * @noinline
 */
function applyTradeAfterRefresh(
  m: RemainingAccount,
  markets: u64,
  long: RemainingAccount,
  short: RemainingAccount,
  asset: u64,
  sizeQ: i128,
  price: u64,
  feeBps: u64,
  lk: Lookup,
  sk: Lookup,
  recertify: boolean,
  isFinal: boolean,
  longAttributable: u64,
  shortAttributable: u64,
): Applied {
  const size = absH(sizeQ);
  const r: TradeRequest = { asset, size: sizeQ, price, fee_bps: feeBps };
  const increasing = tradePreflight(m, markets, r, lk, sk);
  const longIm = absH(lk.next_eff) >= absH(lk.current_eff);
  const shortIm = absH(sk.next_eff) >= absH(sk.current_eff);
  const longClaims = accountHasSourceClaims(long);
  const shortClaims = accountHasSourceClaims(short);
  requireRiskChangeAllowed(m, markets, asset, increasing);
  const notional = tradeNotionalFloor(size, price);
  const fee = checkedFeeBps(riskNotionalCeil(size, price), feeBps);
  const feeLong = chargeAccountFeeCurrent(m, long, fee);
  const feeShort = chargeAccountFeeCurrent(m, short, fee);
  const pre = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const preLong = pre.oi_eff_long_q;
  const preShort = pre.oi_eff_short_q;
  if (isFinal) {
    beginTerminalResidual(m, markets, long, asset, lk, longAttributable);
    beginTerminalResidual(m, markets, short, asset, sk, shortAttributable);
  }
  applyPositionDelta(m, markets, long, asset, lk.next_q - lk.current_q, lk, true);
  applyPositionDelta(m, markets, short, asset, sk.next_q - sk.current_q, sk, true);
  const post = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  // kernel_trade_side_oi_cap_gate: a side grown past MAX_OI_SIDE_Q is InvalidLeg.
  if ((post.oi_eff_long_q > MAX_OI_SIDE_Q && post.oi_eff_long_q > preLong) || (post.oi_eff_short_q > MAX_OI_SIDE_Q && post.oi_eff_short_q > preShort))
    failV16(V16_INVALID_LEG);
  // transfer_trade_residual_reward_credit: the config's shape (checked above), the effective price.
  const effective = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset.effective_price;
  const longOld = absH(lk.current_eff);
  const longNew = absH(lk.next_eff);
  const shortOld = absH(sk.current_eff);
  const shortNew = absH(sk.next_eff);
  const longPrincipal = increasedInitialMargin(m, longOld, longNew, effective);
  const shortPrincipal = increasedInitialMargin(m, shortOld, shortNew, effective);
  if (longNew > longOld) transferResidualRewardCredit(long, short, shortPrincipal);
  if (shortNew > shortOld) transferResidualRewardCredit(short, long, longPrincipal);
  if (recertify) {
    const certPrice = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset.effective_price;
    recertifyAfterTradeDelta(m, markets, long, asset, longOld, longNew, certPrice);
    recertifyAfterTradeDelta(m, markets, short, asset, shortOld, shortNew, certPrice);
  }
  return {
    fee_a: feeLong,
    fee_b: feeShort,
    notional,
    risk: increasing,
    long_im: longIm,
    short_im: shortIm,
    long_claims: longClaims,
    short_claims: shortClaims,
  };
}

/**
 * `finish_trade_checks_not_atomic(long, short, locked, risk_increasing, long_im, short_im, long_claims, short_claims)`:
 * the initial-margin source liens of a risk-increasing unlocked trade, the initial margin of each account that needs
 * it, and in the locked lane its no-positive-credit margin (the audit scans are `Ok` in the program's build).
 */
function finishTradeChecks(m: RemainingAccount, markets: u64, long: RemainingAccount, short: RemainingAccount, locked: boolean, f: Applied): void {
  if (f.risk && !locked) {
    if (f.long_im && f.long_claims) createInitialMarginLienIfNeeded(m, markets, long);
    if (f.short_im && f.short_claims) createInitialMarginLienIfNeeded(m, markets, short);
  }
  if (f.long_im) ensureInitialMargin(long);
  if (f.short_im) ensureInitialMargin(short);
  if (locked) {
    if (f.long_im) ensureNoPositiveCreditInitialMargin(long);
    if (f.short_im) ensureNoPositiveCreditInitialMargin(short);
  }
}

/** One request of a batch (`TradeRequestV16`): the asset, the signed size (the first account long for a positive one),
 * the fee basis price and the fee rate. */
export interface BatchRequest {
  asset: u64;
  size: i128;
  price: u64;
  fee_bps: u64;
}

/** `BatchTradeOutcomeV16`'s sums: the fees charged to the first account and to the second, the notional. */
export interface BatchOutcome {
  fee_a: u128;
  fee_b: u128;
  notional: u128;
}

/**
 * `execute_batch_with_fee_loss_stale_scoped_not_atomic(long, short, requests[..n])`: the market's dynamic slots
 * (InvalidConfig); on a loss-stale market, with at least one request, the batch scoped when no request's asset nor
 * either account is loss-stale (each request judged in order, the first that is not ends the scan); the batch; the
 * flag restored; the market's shape and both accounts validated with it.
 *
 * @noinline
 */
export function executeBatch(m: RemainingAccount, markets: u64, long: RemainingAccount, short: RemainingAccount, reqs: FixedArray<BatchRequest, 16>, n: u64): BatchOutcome {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (markets !== toU64(h.asset_slot_capacity) || toU64(h.asset_slot_capacity) < toU64(h.config.max_market_slots)) failV16(V16_INVALID_CONFIG);
  checkV16(boolErr(h.loss_stale_active));
  let scoped = h.loss_stale_active === 1n && n !== 0n;
  if (scoped)
    for (let i = 0n; i < n; i++)
      if (!canIgnoreUnrelatedLossStale(m, markets, long, short, reqs.get(i).asset)) {
        scoped = false;
        break;
      }
  const restore = h.loss_stale_active;
  if (scoped) h.loss_stale_active = 0n;
  const out = batchAfterTailValidation(m, markets, long, short, reqs, n);
  if (scoped) {
    const hr = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    hr.loss_stale_active = restore;
  }
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, long, markets);
  validateWithMarket(m, short, markets);
  return out;
}

/**
 * `execute_batch_with_fee_after_tail_validation_not_atomic(long, short, requests)`: LockActive unless Live; the
 * config's shape; NonProgress for no request; more requests than the portfolio cap is InvalidConfig; every request
 * validated; each account's attributable terminal asset; both settled and certified for the position action; the
 * H-lock lane; the two position maps; then each request in order: its signed deltas, both plans on the maps (which
 * keep what the earlier plans attached and cleared), the fill (recertified only for a single request; the terminal
 * residual only at the last), the sums (ArithmeticOverflow); after a batch of several fills both accounts certified
 * after local settlement; the finishing margin checks; the zero-OI residue resets of each request's asset.
 *
 * @noinline
 */
function batchAfterTailValidation(m: RemainingAccount, markets: u64, long: RemainingAccount, short: RemainingAccount, reqs: FixedArray<BatchRequest, 16>, n: u64): BatchOutcome {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_LIVE_T) failV16(V16_LOCK_ACTIVE);
  checkV16(configShapeErr(h.config));
  if (n === 0n) failV16(V16_NON_PROGRESS);
  if (n > toU64(h.config.max_portfolio_assets)) failV16(V16_INVALID_CONFIG);
  for (let i = 0n; i < n; i++) {
    const r = reqs.get(i);
    validateTradeRequest(m, r.asset, r.size, r.price, r.fee_bps);
  }
  const longAttributable = terminalResidualAsset(long);
  const shortAttributable = terminalResidualAsset(short);
  settleForPositionAction(m, markets, long);
  settleForPositionAction(m, markets, short);
  let locked = accountHLockMax(m, markets, long);
  if (!locked) locked = accountHLockMax(m, markets, short);
  positionMapCheck(long);
  positionMapCheck(short);
  let longMap = loadRawAt<Portfolio>(long, HEADER_LEN).active_bitmap.get(0n);
  let shortMap = loadRawAt<Portfolio>(short, HEADER_LEN).active_bitmap.get(0n);
  const recertify = n === 1n;
  const out: BatchOutcome = { fee_a: 0n, fee_b: 0n, notional: 0n };
  const sum: Applied = { fee_a: 0n, fee_b: 0n, notional: 0n, risk: false, long_im: false, short_im: false, long_claims: false, short_claims: false };
  for (let i = 0n; i < n; i++) {
    const r = reqs.get(i);
    // trade_signed_size_deltas(size): nonzero and within the cap (the requests were validated).
    const at = assetSlot(m, markets, r.asset);
    const lk = planDeltaOn(long, r.asset, r.size, loadRawAt<EngineAssetSlot>(m, at).asset, longMap);
    longMap = planMapAfter(longMap, lk);
    const sk = planDeltaOn(short, r.asset, -r.size, loadRawAt<EngineAssetSlot>(m, at).asset, shortMap);
    shortMap = planMapAfter(shortMap, sk);
    const applied = applyTradeAfterRefresh(m, markets, long, short, r.asset, r.size, r.price, r.fee_bps, lk, sk, recertify, i + 1n === n, longAttributable, shortAttributable);
    sum.long_im = sum.long_im || applied.long_im;
    sum.short_im = sum.short_im || applied.short_im;
    // kernel_accumulate_batch_trade: the fill count (at most 16), the fees and the notional (ArithmeticOverflow).
    if (out.fee_a > U128_MAX_T - applied.fee_a) failV16(V16_ARITHMETIC_OVERFLOW);
    out.fee_a += applied.fee_a;
    if (out.fee_b > U128_MAX_T - applied.fee_b) failV16(V16_ARITHMETIC_OVERFLOW);
    out.fee_b += applied.fee_b;
    if (out.notional > U128_MAX_T - applied.notional) failV16(V16_ARITHMETIC_OVERFLOW);
    out.notional += applied.notional;
    sum.risk = sum.risk || applied.risk;
    sum.long_claims = sum.long_claims || applied.long_claims;
    sum.short_claims = sum.short_claims || applied.short_claims;
  }
  if (!recertify) {
    certifyAfterLocalSettlement(m, markets, long);
    certifyAfterLocalSettlement(m, markets, short);
  }
  finishTradeChecks(m, markets, long, short, locked, sum);
  for (let i = 0n; i < n; i++) beginZeroOiResidueResets(m, markets, reqs.get(i).asset);
  return out;
}
