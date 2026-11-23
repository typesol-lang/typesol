// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// Liquidation and the bankrupt close (NOTES.md section 13): `liquidate_account_not_atomic` with the engine's choice of
// the close size (`liquidation_engine_close_request_q`, the projected health after a close, the bisection over the
// proportional-margin prefix), the liquidation fee (`liquidation_fee_for_close`), the risk score that must fall
// (`risk_score_unchecked`, `validate_liquidation_progress_from_score`), the unilateral close (`reduce_position`, the
// matching OI taken from the other side with its A index scaled down: ADL, `begin_side_reset_if_effective_oi_exhausted`),
// the insurance draw (`consume_domain_insurance_for_negative_pnl`), the bankruptcy residual booked into the other
// side's B index (`book_bankruptcy_residual_chunk_for_account_core`: loss socialisation), the close-progress ledger
// (`advance_close_progress_ledger`, `clamp_close_residual_to_account_loss`, the expiry and snapshot guards), the crank's
// AdvanceClose (`advance_pending_close_residual_not_atomic`) and the permissionless recovery declaration
// (`declare_permissionless_recovery`).
//
// Errors the original looks at. Every path here that declares Recovery writes the market's mode and reason and then
// returns `V16Error::RecoveryRequired`; the crank's `kernel_commit_declared_liquidation_recovery` turns that into a
// success when the mode is now Recovery with a reason, keeping every write made before (the refresh's certificate, a
// position already reduced, the declaration). So those functions return DECLARED as a value (each caller passes it up
// at once, as `?` does), and `commitDeclared` makes the kernel's decision. Every other error fails in place: the kernel
// returns it unchanged. `liquidation_partial_close_is_healthy` reads a projection's NonProgress (the fee floor) as
// "not healthy": the projection is pure, so that is a value here too.
//
// Copies. The original reads the asset into a value, changes it and writes it back with `set_asset_state` after its
// checks (`reduce_matching_open_interest_for_unilateral_close`, the residual booking's `asset_mut`, written only when a
// chunk is booked); the port changes the slot in place after the same checks, the booking only once it is certain.
import { type RemainingAccount, type i128, type u8, type u64, type u128, type u256, loadRawAt, loadRawMutAt, i128 as toI128, u64 as toU64, u128 as toU128, u256 as toU256 } from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_B_STALE,
  V16_COUNTER_UNDERFLOW,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_RECOVERY_REQUIRED,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type Config,
  type EngineAssetSlot,
  type GroupHeader,
  type InsuranceCreditReservation,
  type Portfolio,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  MAX_ORACLE_PRICE,
} from "./state.js";
import {
  ADL_ONE,
  MAX_MARGIN_BPS,
  V16_MAX_PORTFOLIO_ASSETS_N,
  boolErr,
  closeProgressErr,
  configShapeErr,
  healthCertErr,
  marketModeErr,
  optionalRecoveryReasonErr,
} from "./wire.js";
import {
  LIFECYCLE_ACTIVE,
  LIFECYCLE_DRAIN_ONLY,
  MAX_ACCOUNT_NOTIONAL,
  MAX_POSITION_ABS_Q,
  MIN_A_SIDE,
  SOCIAL_LOSS_DEN,
  amountFromBoundNum,
  engineSlotAt,
  legErr,
  marketShapeErr,
  validateWithMarket,
} from "./engine.js";
import { beginFullDrainReset, mulDivCeilOrWide, wideMulDivFloorU128 } from "./kernels.js";
import {
  activeLegForAsset,
  assetStateOf,
  closeHasPendingResidual,
  domainInsuranceBudgetSpent,
  hasBStaleLeg,
  hasPendingDomainLossBarrier,
  insuranceDomainIndex,
  pendingDomainLossBarrierCount,
  requireActiveLegSlotForAsset,
  reservationAt,
  reservationForDomain,
  setDomainInsuranceSpent,
  validateInsuranceToCloseInsuranceSpent,
} from "./primitives.js";
import { setAccountPnl } from "./claims.js";
import { beginFullDrainResetInner } from "./kfsettle.js";
import { settleAccountSideEffects } from "./settlement.js";
import { chargeAccountFeeCurrent, settleNegativePnlFromPrincipal } from "./refresh.js";
import {
  NO_OVERRIDE,
  absH,
  clearAccountStale,
  collectBackingUtilizationFees,
  computeHealthCert,
  effectiveAbsQuantityForLeg,
  marginRequirement,
  refreshAndCertify,
  scalarPreflight,
} from "./health.js";
import {
  applyPositionDelta,
  assetSlot,
  beginCloseProgressLedger,
  beginZeroOiResidueResets,
  planDelta,
  positionChangeTouchesBarrier,
  setAssetState,
  setPendingBarrierCount,
  signedPosition,
  validateBasisOrZero,
} from "./trade.js";
import { blockersAfter, blockersBefore } from "./engine.js";

/** A function that declared Recovery and returned `V16Error::RecoveryRequired` (see the head of the file). */
export const DECLARED = 1n;
/** A function that returned `V16Error::NonProgress`, which the crank's processor swallows once it has accrued a market
 * (NOTES.md section 1, site 2): every write made before it stays. */
export const NONPROG = 2n;
/** Success. */
export const DONE = 0n;

const U128_MAX_LQ: u128 = 0xffffffffffffffffffffffffffffffffn;
const U128_MAX_LQW: u256 = 340282366920938463463374607431768211455n;
const I128_MAX_LQ: u128 = 0x7fffffffffffffffffffffffffffffffn;
const I128_MIN_LQ: i128 = -0x80000000000000000000000000000000n;
const POS_SCALE_LQ: u128 = 1000000n;
/** MarketModeV16: Live 0, Resolved 1, Recovery 2. */
const MODE_LIVE_LQ: u8 = 0n;
const MODE_RESOLVED_LQ: u8 = 1n;
const MODE_RECOVERY_LQ: u8 = 2n;
/** SideModeV16::DrainOnly, ResetPending. */
const SIDE_DRAIN_ONLY_LQ: u8 = 1n;
const SIDE_RESET_PENDING_LQ: u8 = 2n;
/** PermissionlessRecoveryReasonV16: BIndexHeadroomExhausted 3, ActiveBankruptCloseCannotProgress 4. */
export const REASON_B_INDEX_HEADROOM: u8 = 3n;
export const REASON_ACTIVE_BANKRUPT_CLOSE: u8 = 4n;

// ---- Recovery ----------------------------------------------------------------------------------------------------------

/**
 * `declare_permissionless_recovery(reason)`: the config's permissionless recovery enabled (decoded; InvalidConfig when
 * off); a Resolved market LockActive; a reason already recorded returns it (nothing written, whatever the mode); else
 * the mode Recovery, the reason recorded, the market's shape.
 */
export function declareRecovery(m: RemainingAccount, markets: u64, reason: u8): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(boolErr(h.config.permissionless_recovery_enabled));
  if (h.config.permissionless_recovery_enabled !== 1n) failV16(V16_INVALID_CONFIG);
  checkV16(marketModeErr(h.mode));
  if (h.mode === MODE_RESOLVED_LQ) failV16(V16_LOCK_ACTIVE);
  checkV16(optionalRecoveryReasonErr(h.recovery_reason));
  if (h.recovery_reason.present === 1n) return;
  h.mode = MODE_RECOVERY_LQ;
  h.recovery_reason.present = 1n;
  h.recovery_reason.value = reason;
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/** A declaration followed by `return Err(V16Error::RecoveryRequired)`. */
function declareAndReturn(m: RemainingAccount, markets: u64, reason: u8): u64 {
  declareRecovery(m, markets, reason);
  return DECLARED;
}

/**
 * `kernel_commit_declared_liquidation_recovery(RecoveryRequired, mode, reason)` after a function returned DECLARED: the
 * mode and the reason decoded; a success (RecoveryDeclared) when the market is now in Recovery with a reason, else the
 * RecoveryRequired error.
 */
export function commitDeclared(m: RemainingAccount): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  checkV16(optionalRecoveryReasonErr(h.recovery_reason));
  if (!(h.mode === MODE_RECOVERY_LQ && h.recovery_reason.present === 1n)) failV16(V16_RECOVERY_REQUIRED);
}

// ---- The size of a liquidation (pure) ------------------------------------------------------------------------------------

/** `liquidation_risk_notional_ceil(q, price)`: 0 for none; InvalidConfig past the position cap or the price cap; else
 * ⌈q · price / POS_SCALE⌉ (the product below 2^87). */
function liqNotionalCeil(q: u128, price: u64): u128 {
  if (q === 0n) return 0n;
  if (q > MAX_POSITION_ABS_Q || price > MAX_ORACLE_PRICE) failV16(V16_INVALID_CONFIG);
  const p = q * toU128(price);
  return p / POS_SCALE_LQ + (p % POS_SCALE_LQ !== 0n ? 1n : 0n);
}

/** `liquidation_leg_maintenance_requirement(config, q, side, effective, target)`: 0 for none; InvalidConfig for a
 * maintenance margin past 10,000 bps; the margin of the notional plus the notional of the adverse target gap. */
function legMaintenance(c: Config, q: u128, isShort: boolean, effective: u64, target: u64): u128 {
  if (q === 0n) return 0n;
  if (c.maintenance_margin_bps > MAX_MARGIN_BPS) failV16(V16_INVALID_CONFIG);
  const notional = liqNotionalCeil(q, effective);
  let adverse: u64 = 0n;
  if (!isShort && target < effective) adverse = effective - target;
  else if (isShort && target > effective) adverse = target - effective;
  const penalty = liqNotionalCeil(q, adverse);
  const base = marginRequirement(notional, c.maintenance_margin_bps, c.min_nonzero_mm_req);
  if (base > U128_MAX_LQ - penalty) failV16(V16_ARITHMETIC_OVERFLOW);
  return base + penalty;
}

/** No fee: `liquidation_fee_from_raw_fee`'s NonProgress (a partial close below the fee floor), as a value. */
const FEE_BELOW_FLOOR_LQ: u128 = U128_MAX_LQ;

/**
 * `liquidation_fee_for_close(notional, bps, floor, cap, full)`: InvalidConfig for a notional past the account cap or a
 * rate past 10,000 bps; ⌈notional · bps / 10,000⌉; a partial close whose raw fee is below a nonzero floor is
 * NonProgress (FEE_BELOW_FLOOR_LQ here: the callers decide); else max(raw, floor) then min(·, cap).
 */
function liqFeeOrFloor(notional: u128, bps: u64, floor: u128, cap: u128, full: boolean): u128 {
  if (notional > MAX_ACCOUNT_NOTIONAL || bps > MAX_MARGIN_BPS) failV16(V16_INVALID_CONFIG);
  const p = notional * toU128(bps);
  const raw = p / 10000n + (p % 10000n !== 0n ? 1n : 0n);
  if (!full && floor !== 0n && raw < floor) return FEE_BELOW_FLOOR_LQ;
  const lifted = raw > floor ? raw : floor;
  return lifted < cap ? lifted : cap;
}

/** The parts of the certificate and the account a projection reads. */
interface Projection {
  equity: i128;
  maintenance: u128;
  capital: u128;
  pnl: i128;
  isShort: boolean;
  oldQ: u128;
  effective: u64;
  target: u64;
  bps: u64;
}

/** A projection's outcome: healthy, not, or the fee floor's NonProgress. */
const P_UNHEALTHY_LQ = 0n;
const P_HEALTHY_LQ = 1n;
const P_FLOOR_LQ = 2n;

/**
 * `liquidation_projected_healthy_after_close(config, cert, capital, pnl, side, old_q, effective, target, bps, close)`:
 * not healthy for no close or more than the leg; the leg's maintenance before and after, the fee (the capital's part of
 * it while the PnL is not negative), and the projected deficit (`liquidation_projected_health_deficit_from_parts`:
 * ArithmeticOverflow on its checked steps) zero.
 */
function projectedHealthy(c: Config, j: Projection, close: u128): u64 {
  if (close === 0n || close > j.oldQ) return P_UNHEALTHY_LQ;
  const oldM = legMaintenance(c, j.oldQ, j.isShort, j.effective, j.target);
  const newM = legMaintenance(c, j.oldQ - close, j.isShort, j.effective, j.target);
  const fee = liqFeeOrFloor(liqNotionalCeil(close, j.effective), j.bps, c.min_liquidation_abs, c.liquidation_fee_cap, close === j.oldQ);
  if (fee === FEE_BELOW_FLOOR_LQ) return P_FLOOR_LQ;
  const charged = j.pnl >= 0n ? (fee < j.capital ? fee : j.capital) : 0n;
  if (j.maintenance < oldM) failV16(V16_ARITHMETIC_OVERFLOW);
  const rest = j.maintenance - oldM;
  if (rest > U128_MAX_LQ - newM) failV16(V16_ARITHMETIC_OVERFLOW);
  const post = rest + newM;
  if (charged > I128_MAX_LQ) failV16(V16_ARITHMETIC_OVERFLOW);
  const ch = toI128(charged);
  if (j.equity < I128_MIN_LQ + ch) failV16(V16_ARITHMETIC_OVERFLOW);
  const equity = j.equity - ch;
  if (equity < 0n) {
    // post + |equity|: a deficit, never zero.
    if (post > U128_MAX_LQ - absH(equity)) failV16(V16_ARITHMETIC_OVERFLOW);
    return P_UNHEALTHY_LQ;
  }
  return post <= toU128(equity) ? P_HEALTHY_LQ : P_UNHEALTHY_LQ;
}

/** `liquidation_partial_close_is_healthy`: the projection, its NonProgress read as not healthy (NOTES.md section 1,
 * site 6). */
function partialHealthy(c: Config, j: Projection, close: u128): boolean {
  return projectedHealthy(c, j, close) === P_HEALTHY_LQ;
}

/** `V16Config::checked_mul_div_ceil_to_u128(a, b, d)` (InvalidConfig for a zero divisor or a result past u128). */
function configMulDivCeil(a: u128, b: u128, d: u128): u128 {
  if (d === 0n) failV16(V16_INVALID_CONFIG);
  const p: u256 = toU256(a) * toU256(b);
  const q: u256 = p / toU256(d) + (p % toU256(d) !== 0n ? 1n : 0n);
  if (q > U128_MAX_LQW) failV16(V16_INVALID_CONFIG);
  return toU128(q);
}

/** `min_abs_q_for_risk_notional_at_least(notional, price)`: 0 for none; InvalidConfig for a zero price; ⌊(notional − 1)
 * · POS_SCALE / price⌋ + 1 (in 256 bits past u128; ArithmeticOverflow past u128). */
function minQForNotional(notional: u128, price: u64): u128 {
  if (notional === 0n) return 0n;
  if (price === 0n) failV16(V16_INVALID_CONFIG);
  const q: u256 = (toU256(notional - 1n) * toU256(POS_SCALE_LQ)) / toU256(price);
  if (q >= U128_MAX_LQW) failV16(V16_ARITHMETIC_OVERFLOW);
  return toU128(q) + 1n;
}

/** `liquidation_partial_search_hi(config, old_q, effective)`: 0 without a maintenance margin; else the leg less the
 * smallest quantity whose notional reaches the margin's floor (saturating). */
function partialSearchHi(c: Config, oldQ: u128, effective: u64): u128 {
  if (c.maintenance_margin_bps === 0n) return 0n;
  const floorNotional = configMulDivCeil(c.min_nonzero_mm_req, toU128(MAX_MARGIN_BPS), toU128(c.maintenance_margin_bps));
  const floorQ = minQForNotional(floorNotional, effective);
  return oldQ > floorQ ? oldQ - floorQ : 0n;
}

/**
 * `liquidation_engine_close_request_q(config, cert, capital, pnl, side, old_q, effective, target, bps)`: InvalidLeg for
 * no quantity; the whole leg for a negative equity or PnL, or when even a full close is not projected healthy; else
 * the whole leg unless the top of the proportional prefix is healthy, then the smallest healthy partial close found by
 * bisection over [1, hi] (the whole leg if that one is not healthy after all). Each projection's errors fail.
 */
function closeRequestQ(c: Config, j: Projection): u128 {
  if (j.oldQ === 0n) failV16(V16_INVALID_LEG);
  if (j.equity < 0n || j.pnl < 0n) return j.oldQ;
  // A full close never meets the fee floor (it applies to partial closes only).
  if (projectedHealthy(c, j, j.oldQ) !== P_HEALTHY_LQ) return j.oldQ;
  const hi0 = partialSearchHi(c, j.oldQ, j.effective);
  if (hi0 === 0n || !partialHealthy(c, j, hi0)) return j.oldQ;
  let lo: u128 = 1n;
  let hi = hi0;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (partialHealthy(c, j, mid)) hi = mid;
    else lo = mid + 1n;
  }
  return partialHealthy(c, j, lo) ? lo : j.oldQ;
}

// ---- The risk score -------------------------------------------------------------------------------------------------------

/** `RiskScoreV16`, compared field by field in this order (its derived `Ord`). */
export interface RiskScore {
  deficit: u128;
  bLoss: u128;
  stale: u128;
  gross: u128;
  legs: u64;
}

/** `risk_score_unchecked(account)`: the certificate decoded and valid (Stale otherwise); the loss weights of the active
 * B-stale legs (each leg decoded; ArithmeticOverflow); the stale flag decoded; the worst case; the active count. */
export function riskScore(pa: RemainingAccount): RiskScore {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(healthCertErr(p.health_cert));
  if (p.health_cert.valid !== 1n) failV16(V16_STALE);
  let bLoss: u128 = 0n;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active === 1n && leg.b_stale === 1n) {
      if (bLoss > U128_MAX_LQ - leg.loss_weight) failV16(V16_ARITHMETIC_OVERFLOW);
      bLoss += leg.loss_weight;
    }
  }
  checkV16(boolErr(p.stale_state));
  let legs: u64 = 0n;
  let bits = p.active_bitmap.get(0n);
  while (bits !== 0n) {
    bits &= bits - 1n;
    legs += 1n;
  }
  return { deficit: p.health_cert.certified_liq_deficit, bLoss, stale: toU128(p.stale_state), gross: p.health_cert.certified_worst_case_loss, legs };
}

/** `validate_liquidation_progress_from_score(before, account)`: NonProgress (false) unless the score after is strictly
 * below the score before (lexicographically) or the deficit fell. */
export function validateProgress(before: RiskScore, pa: RemainingAccount): boolean {
  const a = riskScore(pa);
  let less = false;
  if (a.deficit !== before.deficit) less = a.deficit < before.deficit;
  else if (a.bLoss !== before.bLoss) less = a.bLoss < before.bLoss;
  else if (a.stale !== before.stale) less = a.stale < before.stale;
  else if (a.gross !== before.gross) less = a.gross < before.gross;
  else less = a.legs < before.legs;
  return less || a.deficit < before.deficit;
}

// ---- The unilateral close --------------------------------------------------------------------------------------------------

/** `begin_side_reset_if_effective_oi_exhausted(asset, side)`: a side with no effective OI left but stored legs, no pending
 * obligation and not resetting begins its full-drain reset, unless the side holds a barrier. */
function beginSideResetIfExhausted(m: RemainingAccount, markets: u64, asset: u64, isShort: boolean): void {
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const exhausted = isShort
    ? a.oi_eff_short_q === 0n && a.stored_pos_count_short !== 0n && a.pending_obligation_count_short === 0n && a.mode_short !== SIDE_RESET_PENDING_LQ
    : a.oi_eff_long_q === 0n && a.stored_pos_count_long !== 0n && a.pending_obligation_count_long === 0n && a.mode_long !== SIDE_RESET_PENDING_LQ;
  if (exhausted && !hasPendingDomainLossBarrier(m, markets, asset, isShort)) beginFullDrainResetInner(m, markets, asset, isShort);
}

/**
 * `reduce_matching_open_interest_for_unilateral_close(asset, closed_side, close_q)`: nothing for no close; the other
 * side's effective OI lowered by the close (InvalidLeg past it) and its A scaled by what remains (`wide_mul_div_floor`;
 * ADL_ONE when nothing remains); an A that would round to zero declares Recovery (ActiveBankruptCloseCannotProgress);
 * an A below MIN_A_SIDE with OI left turns the side DrainOnly; the asset written (`set_asset_state`); a side left with
 * no OI begins its full-drain reset.
 */
function reduceMatchingOi(m: RemainingAccount, markets: u64, asset: u64, closedShort: boolean, closeQ: u128): u64 {
  if (closeQ === 0n) return DONE;
  const at = assetSlot(m, markets, asset);
  const a0 = loadRawAt<EngineAssetSlot>(m, at).asset;
  const oppShort = !closedShort;
  const oiBefore = oppShort ? a0.oi_eff_short_q : a0.oi_eff_long_q;
  const aBefore = oppShort ? a0.a_short : a0.a_long;
  if (closeQ > oiBefore) failV16(V16_INVALID_LEG);
  const oiAfter = oiBefore - closeQ;
  let aAfter: u128 = toU128(ADL_ONE);
  if (oiAfter !== 0n) {
    aAfter = wideMulDivFloorU128(aBefore, oiAfter, oiBefore);
    if (aAfter === 0n) return declareAndReturn(m, markets, REASON_ACTIVE_BANKRUPT_CLOSE);
  }
  const before = blockersBefore(m, asset);
  const e = loadRawMutAt<EngineAssetSlot>(m, at);
  if (oppShort) {
    e.asset.oi_eff_short_q = oiAfter;
    e.asset.a_short = aAfter;
    if (oiAfter !== 0n && aAfter < MIN_A_SIDE) e.asset.mode_short = SIDE_DRAIN_ONLY_LQ;
  } else {
    e.asset.oi_eff_long_q = oiAfter;
    e.asset.a_long = aAfter;
    if (oiAfter !== 0n && aAfter < MIN_A_SIDE) e.asset.mode_long = SIDE_DRAIN_ONLY_LQ;
  }
  blockersAfter(m, asset, before);
  if (oiAfter === 0n) beginFullDrainResetInner(m, markets, asset, oppShort);
  return DONE;
}

/**
 * `reduce_position(account, asset, close_q)`: nothing for no close; the asset's active leg (InvalidLeg for none); the
 * delta toward zero applied (`apply_position_delta`: its lookup, then the delta of the lookup's quantities); the side's
 * reset if its effective OI is exhausted; the other side's matching OI reduced.
 */
export function reducePosition(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, closeQ: u128): u64 {
  if (closeQ === 0n) return DONE;
  const slot = activeLegForAsset(pa, asset);
  if (slot === 0xffffffffffffffffn) failV16(V16_INVALID_LEG);
  const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
  const isShort = leg.side === 1n;
  if (closeQ > I128_MAX_LQ) failV16(V16_ARITHMETIC_OVERFLOW);
  const delta: i128 = isShort ? toI128(closeQ) : -toI128(closeQ);
  // apply_position_delta(account, asset, delta).
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const k = planDelta(m, pa, asset, delta, a);
  applyPositionDelta(m, markets, pa, asset, k.next_q - k.current_q, k, false);
  beginSideResetIfExhausted(m, markets, asset, isShort);
  return reduceMatchingOi(m, markets, asset, isShort, closeQ);
}

/**
 * `certify_account_after_local_settlement_with_price_override(account, None)`: the utilization fees collected; BStale for
 * a B-stale account or leg; a stale account cleared; the certificate computed (B current required) and written.
 */
export function certifyAfterLocalSettlement(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  collectBackingUtilizationFees(m, markets, pa);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(boolErr(p.b_stale_state));
  if (p.b_stale_state === 1n || hasBStaleLeg(pa)) failV16(V16_B_STALE);
  clearAccountStale(m, pa);
  computeHealthCert(m, markets, pa, true);
}

// ---- Fees, insurance and the bankruptcy residual ---------------------------------------------------------------------------

/**
 * `charge_account_fee_not_atomic(account, fee)`: LockActive unless Live; the account's side effects settled with the
 * public B chunk; BStale for a B-stale account or leg; the negative PnL settled from principal; the fee charged from the
 * capital (`charge_account_fee_current_not_atomic`). Returns the amount charged.
 */
function chargeAccountFee(m: RemainingAccount, markets: u64, pa: RemainingAccount, fee: u128): u128 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_LIVE_LQ) failV16(V16_LOCK_ACTIVE);
  settleAccountSideEffects(m, markets, pa, h.config.public_b_chunk_atoms);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(boolErr(p.b_stale_state));
  if (p.b_stale_state === 1n || hasBStaleLeg(pa)) failV16(V16_B_STALE);
  settleNegativePnlFromPrincipal(m, pa);
  return chargeAccountFeeCurrent(m, pa, fee);
}

/**
 * `available_domain_insurance(domain)`: the domain's budget less what it spent less its reservation's reserved
 * insurance (in atoms), saturating, at most the market's insurance less the reserved total (saturating).
 */
export function availableDomainInsurance(m: RemainingAccount, markets: u64, domain: u64): u128 {
  const bs = domainInsuranceBudgetSpent(m, markets, domain);
  reservationForDomain(m, markets, domain);
  const reserved = amountFromBoundNum(loadRawAt<InsuranceCreditReservation>(m, reservationAt(domain)).insurance_credit_reserved_num);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const global = h.insurance > h.source_insurance_credit_reserved_total_atoms ? h.insurance - h.source_insurance_credit_reserved_total_atoms : 0n;
  let remaining = bs.budget > bs.spent ? bs.budget - bs.spent : 0n;
  remaining = remaining > reserved ? remaining - reserved : 0n;
  return global < remaining ? global : remaining;
}

/**
 * `consume_domain_insurance_for_negative_pnl(asset, bankrupt_side, account)`: the domain opposite the bankrupt side;
 * nothing for a PnL at or above zero; the bankruptcy H-lock set; up to the loss from the domain's available insurance
 * (`kernel_consume_insurance_layer`: the insurance lowered, CounterUnderflow; the spent raised, ArithmeticOverflow; the
 * PnL raised); the insurance written, the spent (`set_domain_insurance_spent_core`), the PnL (`set_account_pnl`), the
 * token-flow proof (the vault unchanged), the certificate invalidated. Returns the amount used.
 */
export function consumeDomainInsurance(m: RemainingAccount, markets: u64, asset: u64, bankruptShort: boolean, pa: RemainingAccount): u128 {
  const domain = insuranceDomainIndex(m, markets, asset, !bankruptShort);
  const pnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  if (pnl >= 0n) return 0n;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  h.bankruptcy_hlock_active = 1n;
  const available = availableDomainInsurance(m, markets, domain);
  const spentBefore = domainInsuranceBudgetSpent(m, markets, domain).spent;
  const residual = absH(pnl);
  const used = residual < available ? residual : available;
  if (h.insurance < used) failV16(V16_COUNTER_UNDERFLOW);
  if (spentBefore > U128_MAX_LQ - used) failV16(V16_ARITHMETIC_OVERFLOW);
  // used ≤ |pnl| ≤ i128::MAX: the conversion and the sum (toward zero) cannot fail.
  if (used === 0n) return 0n;
  const vault = h.vault;
  h.insurance -= used;
  setDomainInsuranceSpent(m, markets, domain, spentBefore + used);
  setAccountPnl(m, markets, pa, pnl + toI128(used));
  validateInsuranceToCloseInsuranceSpent(used, vault, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).vault);
  const pv = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  pv.health_cert.valid = 0n;
  return used;
}

/** `bankruptcy_residual_single_step_capacity(asset, bankrupt_side, residual)`: the asset configured; 0 for no residual
 * or no loss weight on the other side; the chunk cap (residual, public chunk) when it books a nonzero B delta within B's
 * headroom; else what B's headroom allows (0 when the carried remainder already exceeds it), at most the residual and
 * the public chunk. */
export function bankruptcyCapacity(m: RemainingAccount, markets: u64, asset: u64, bankruptShort: boolean, residual: u128): u128 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  if (residual === 0n) return 0n;
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const oppShort = !bankruptShort;
  const bNow = oppShort ? a.b_short_num : a.b_long_num;
  const weight = oppShort ? a.loss_weight_sum_short : a.loss_weight_sum_long;
  const rem = oppShort ? a.social_loss_remainder_short_num : a.social_loss_remainder_long_num;
  if (weight === 0n) return 0n;
  const chunkCap = h.config.public_b_chunk_atoms;
  const candidate = residual < chunkCap ? residual : chunkCap;
  if (candidate !== 0n) {
    const num: u256 = toU256(candidate) * toU256(SOCIAL_LOSS_DEN) + toU256(rem);
    if (num <= U128_MAX_LQW) {
      const delta = toU128(num) / weight;
      if (delta !== 0n && bNow <= U128_MAX_LQ - delta) return candidate;
    }
  }
  const maxScaled: u256 = (toU256(U128_MAX_LQ - bNow) + 1n) * toU256(weight) - 1n;
  if (toU256(rem) > maxScaled) return 0n;
  const byB: u256 = (maxScaled - toU256(rem)) / toU256(SOCIAL_LOSS_DEN);
  let out = byB > U128_MAX_LQW ? residual : toU128(byB);
  if (residual < out) out = residual;
  return out < chunkCap ? out : chunkCap;
}

/** `BResidualBookingOutcomeV16`'s booked and explicit loss. */
export interface Booking {
  status: u64;
  booked: u128;
  explicit: u128;
}

/**
 * `book_bankruptcy_residual_chunk_internal(asset, bankrupt_side, residual)`: the asset configured; nothing for no
 * residual; with loss weight on the other side and a nonzero capacity, the chunk booked into that side's B index
 * (`apply_bankruptcy_residual_chunk_to_loss_side` with `social_loss_book_split`: none when the delta is zero or B would
 * overflow); `kernel_bresidual_step`: a booked chunk writes the asset and sets the bankruptcy H-lock; none in a Resolved
 * market is all explicit loss (the H-lock set); none otherwise declares Recovery (ActiveBankruptCloseCannotProgress for
 * no weight, else BIndexHeadroomExhausted).
 */
function bookResidualInternal(m: RemainingAccount, markets: u64, asset: u64, bankruptShort: boolean, residual: u128): Booking {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  if (residual === 0n) return { status: DONE, booked: 0n, explicit: 0n };
  const at = assetSlot(m, markets, asset);
  const a = loadRawAt<EngineAssetSlot>(m, at).asset;
  const oppShort = !bankruptShort;
  const weight = oppShort ? a.loss_weight_sum_short : a.loss_weight_sum_long;
  checkV16(marketModeErr(h.mode));
  const resolved = h.mode === MODE_RESOLVED_LQ;
  let reason = REASON_ACTIVE_BANKRUPT_CLOSE;
  let chunk: u128 = 0n;
  let deltaB: u128 = 0n;
  let newRem: u128 = 0n;
  if (weight !== 0n) {
    reason = REASON_B_INDEX_HEADROOM;
    const engineChunk = bankruptcyCapacity(m, markets, asset, bankruptShort, residual);
    if (engineChunk !== 0n && engineChunk <= residual) {
      const bNow = oppShort ? a.b_short_num : a.b_long_num;
      const rem = oppShort ? a.social_loss_remainder_short_num : a.social_loss_remainder_long_num;
      // social_loss_book_split: chunk · SOCIAL_LOSS_DEN + rem (ArithmeticOverflow past u128).
      const num: u256 = toU256(engineChunk) * toU256(SOCIAL_LOSS_DEN) + toU256(rem);
      if (num > U128_MAX_LQW) failV16(V16_ARITHMETIC_OVERFLOW);
      const d = toU128(num) / weight;
      if (d !== 0n && bNow <= U128_MAX_LQ - d) {
        chunk = engineChunk;
        deltaB = d;
        newRem = toU128(num) % weight;
      }
    }
  }
  if (chunk !== 0n) {
    const before = blockersBefore(m, asset);
    const e = loadRawMutAt<EngineAssetSlot>(m, at);
    if (oppShort) {
      e.asset.b_short_num += deltaB;
      e.asset.social_loss_remainder_short_num = newRem;
    } else {
      e.asset.b_long_num += deltaB;
      e.asset.social_loss_remainder_long_num = newRem;
    }
    blockersAfter(m, asset, before);
    const hb = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    hb.bankruptcy_hlock_active = 1n;
    return { status: DONE, booked: chunk, explicit: 0n };
  }
  if (resolved) {
    const hr = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    hr.bankruptcy_hlock_active = 1n;
    return { status: DONE, booked: 0n, explicit: residual };
  }
  declareRecovery(m, markets, reason);
  return { status: DECLARED, booked: 0n, explicit: 0n };
}

// ---- The close-progress ledger ---------------------------------------------------------------------------------------------

/** `ensure_close_progress_not_expired(ledger)`: an active ledger past its deadline declares Recovery
 * (ActiveBankruptCloseCannotProgress) unless the market is Resolved. */
function ensureCloseNotExpired(m: RemainingAccount, markets: u64, pa: RemainingAccount): u64 {
  const c = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (c.active === 1n && h.current_slot > c.max_close_slot) {
    checkV16(marketModeErr(h.mode));
    if (h.mode === MODE_RESOLVED_LQ) return DONE;
    return declareAndReturn(m, markets, REASON_ACTIVE_BANKRUPT_CLOSE);
  }
  return DONE;
}

/** `ensure_open_close_snapshot_current_or_recovery(account, ledger)`: an active ledger whose configured asset still has
 * the account's leg and has moved past the ledger's reference slot declares Recovery unless Resolved. */
function ensureCloseSnapshotCurrent(m: RemainingAccount, markets: u64, pa: RemainingAccount): u64 {
  const c = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
  if (c.active !== 1n) return DONE;
  const asset = toU64(c.asset_index);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset < toU64(h.config.max_market_slots)) {
    const legActive = activeLegForAssetSlot(pa, asset);
    const slotLast = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset.slot_last;
    if (legActive && slotLast > c.drift_reference_slot) {
      checkV16(marketModeErr(h.mode));
      if (h.mode === MODE_RESOLVED_LQ) return DONE;
      return declareAndReturn(m, markets, REASON_ACTIVE_BANKRUPT_CLOSE);
    }
  }
  return DONE;
}

/** `Self::active_leg_slot_for_asset(account, asset)?.is_some()`. */
function activeLegForAssetSlot(pa: RemainingAccount, asset: u64): boolean {
  return activeLegForAsset(pa, asset) !== 0xffffffffffffffffn;
}

/** `advance_close_progress_ledger(account, 0, 0, insurance, b_loss, explicit)`: what liquidation and AdvanceClose book. */
function advanceCloseLedger(m: RemainingAccount, markets: u64, pa: RemainingAccount, insurance: u128, bLoss: u128, explicit: u128): u64 {
  return advanceCloseLedgerFull(m, markets, pa, 0n, 0n, insurance, bLoss, explicit);
}

/**
 * `advance_close_progress_ledger(account, support, junior, insurance, b_loss, explicit)`: nothing when all are zero; the
 * ledger decoded; its expiry guard; LockActive unless active and not finalized; `kernel_advance_close_ledger` (each
 * category raised in the original's order, the progress at most the gross loss plus drift, ArithmeticOverflow; the
 * residual the rest, finalized at zero); a ledger that stops pending releases its barrier (CounterUnderflow) and begins
 * the legless asset's resets; the ledger written, the certificate invalidated, the account validated with the market.
 */
export function advanceCloseLedgerFull(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  support: u128,
  junior: u128,
  insurance: u128,
  bLoss: u128,
  explicit: u128,
): u64 {
  if (support === 0n && junior === 0n && insurance === 0n && bLoss === 0n && explicit === 0n) return DONE;
  checkV16(closeProgressErr(loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress));
  if (ensureCloseNotExpired(m, markets, pa) === DECLARED) return DECLARED;
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const c = p.close_progress;
  const wasPending = closeHasPendingResidual(c);
  if (c.active !== 1n || c.finalized === 1n) failV16(V16_LOCK_ACTIVE);
  if (
    c.support_consumed > U128_MAX_LQ - support ||
    c.junior_face_burned > U128_MAX_LQ - junior ||
    c.insurance_spent > U128_MAX_LQ - insurance ||
    c.b_loss_booked > U128_MAX_LQ - bLoss ||
    c.explicit_loss_assigned > U128_MAX_LQ - explicit
  )
    failV16(V16_ARITHMETIC_OVERFLOW);
  const supportConsumed = c.support_consumed + support;
  const insuranceSpent = c.insurance_spent + insurance;
  const booked = c.b_loss_booked + bLoss;
  const assigned = c.explicit_loss_assigned + explicit;
  if (c.gross_loss_at_close_start > U128_MAX_LQ - c.drift_consumed) failV16(V16_ARITHMETIC_OVERFLOW);
  const total = c.gross_loss_at_close_start + c.drift_consumed;
  let progress = supportConsumed;
  if (progress > U128_MAX_LQ - insuranceSpent) failV16(V16_ARITHMETIC_OVERFLOW);
  progress += insuranceSpent;
  if (progress > U128_MAX_LQ - booked) failV16(V16_ARITHMETIC_OVERFLOW);
  progress += booked;
  if (progress > U128_MAX_LQ - assigned) failV16(V16_ARITHMETIC_OVERFLOW);
  progress += assigned;
  if (progress > total) failV16(V16_ARITHMETIC_OVERFLOW);
  c.support_consumed = supportConsumed;
  c.junior_face_burned += junior;
  c.insurance_spent = insuranceSpent;
  c.b_loss_booked = booked;
  c.explicit_loss_assigned = assigned;
  c.residual_remaining = total - progress;
  if (c.residual_remaining === 0n) c.finalized = 1n;
  if (wasPending && !closeHasPendingResidual(c)) {
    const asset = toU64(c.asset_index);
    const isShort = c.domain_side === 1n;
    const count = pendingDomainLossBarrierCount(m, markets, asset, isShort);
    if (count === 0n) failV16(V16_COUNTER_UNDERFLOW);
    setPendingBarrierCount(m, markets, asset, isShort, count - 1n);
    // begin_legless_asset_resets(asset).
    const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
    if (a.stored_pos_count_long === 0n && a.stored_pos_count_short === 0n) beginZeroOiResidueResets(m, markets, asset);
  }
  p.health_cert.valid = 0n;
  validateWithMarket(m, pa, markets);
  return DONE;
}

/**
 * `clamp_close_residual_to_account_loss(account)`: a pending residual above the account's loss is cured by the excess
 * (`kernel_principal_cure_close_ledger`: the gross loss and the residual lowered by at most both; a residual reaching
 * zero finalizes a ledger with irreversible progress, else cancels it, and releases the barrier, CounterUnderflow); a
 * changed ledger is written and the certificate invalidated.
 */
export function clampCloseResidual(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const c = p.close_progress;
  checkV16(closeProgressErr(c));
  if (!closeHasPendingResidual(c)) return;
  const owed = p.pnl < 0n ? absH(p.pnl) : 0n;
  if (c.residual_remaining <= owed) return;
  const excess = c.residual_remaining - owed;
  let cure = excess < c.residual_remaining ? excess : c.residual_remaining;
  if (c.gross_loss_at_close_start < cure) cure = c.gross_loss_at_close_start;
  if (cure === 0n) return;
  c.gross_loss_at_close_start -= cure;
  c.residual_remaining -= cure;
  if (c.residual_remaining === 0n) {
    // has_irreversible_progress: any booked progress or quantity ADL or drift.
    const irreversible =
      c.support_consumed !== 0n ||
      c.junior_face_burned !== 0n ||
      c.insurance_spent !== 0n ||
      c.b_loss_booked !== 0n ||
      c.explicit_loss_assigned !== 0n ||
      c.quantity_adl_applied_q !== 0n ||
      c.drift_consumed !== 0n;
    if (irreversible) c.finalized = 1n;
    else {
      c.active = 0n;
      c.canceled = 1n;
    }
    const asset = toU64(c.asset_index);
    const isShort = c.domain_side === 1n;
    const count = pendingDomainLossBarrierCount(m, markets, asset, isShort);
    if (count === 0n) failV16(V16_COUNTER_UNDERFLOW);
    setPendingBarrierCount(m, markets, asset, isShort, count - 1n);
  }
  p.health_cert.valid = 0n;
}

/**
 * `book_bankruptcy_residual_chunk_for_account_core(account, asset, bankrupt_side, residual)`: nothing for no residual;
 * without an active ledger, a zero single-step capacity declares Recovery, else the ledger begins on the other side for
 * the residual; the expiry guard; LockActive for a ledger of another asset or side; the residual clamped to the loss;
 * nothing more once nothing is pending; the snapshot guard; one chunk booked on the ledger's residual; the ledger
 * advanced by it.
 */
export function bookResidualForAccount(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, bankruptShort: boolean, residual: u128): Booking {
  const none: Booking = { status: DONE, booked: 0n, explicit: 0n };
  if (residual === 0n) return none;
  const domainShort = !bankruptShort;
  const c0 = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
  checkV16(closeProgressErr(c0));
  if (c0.active !== 1n) {
    if (bankruptcyCapacity(m, markets, asset, bankruptShort, residual) === 0n) {
      declareRecovery(m, markets, REASON_ACTIVE_BANKRUPT_CLOSE);
      return { status: DECLARED, booked: 0n, explicit: 0n };
    }
    beginCloseProgressLedger(m, markets, pa, asset, domainShort, residual);
  }
  if (ensureCloseNotExpired(m, markets, pa) === DECLARED) return { status: DECLARED, booked: 0n, explicit: 0n };
  const c = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
  if (toU64(c.asset_index) !== asset || (c.domain_side === 1n) !== domainShort) failV16(V16_LOCK_ACTIVE);
  clampCloseResidual(m, markets, pa);
  if (!closeHasPendingResidual(loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress)) return none;
  if (ensureCloseSnapshotCurrent(m, markets, pa) === DECLARED) return { status: DECLARED, booked: 0n, explicit: 0n };
  const out = bookResidualInternal(m, markets, asset, bankruptShort, loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress.residual_remaining);
  if (out.status === DECLARED) return out;
  if (advanceCloseLedger(m, markets, pa, 0n, out.booked, out.explicit) === DECLARED) return { status: DECLARED, booked: 0n, explicit: 0n };
  return out;
}

/** `liquidation_residual_exceeds_single_step_capacity(asset, bankrupt_side, account)`: the loss beyond the capital and the
 * domain's available insurance (saturating) is more than the public chunk, or more than one step can book. */
function residualExceedsOneStep(m: RemainingAccount, markets: u64, asset: u64, bankruptShort: boolean, pa: RemainingAccount): boolean {
  const domain = insuranceDomainIndex(m, markets, asset, !bankruptShort);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  let residual: u128 = 0n;
  if (p.pnl < 0n) {
    const loss = absH(p.pnl);
    residual = loss > p.capital ? loss - p.capital : 0n;
    const ins = availableDomainInsurance(m, markets, domain);
    residual = residual > ins ? residual - ins : 0n;
  }
  if (residual === 0n) return false;
  if (loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.public_b_chunk_atoms < residual) return true;
  return bankruptcyCapacity(m, markets, asset, bankruptShort, residual) < residual;
}

// ---- Liquidation -------------------------------------------------------------------------------------------------------------

/**
 * `liquidate_account_not_atomic(account, asset)` (as the crank calls it): LockActive unless Live; the config's shape; an
 * asset past the configured slots InvalidConfig; the asset Active or DrainOnly (LockActive); the scalar preflight; the
 * asset's active leg (InvalidLeg); the account refreshed and certified (no B chunk); NonProgress for no certified deficit;
 * the risk score before; the leg; the engine's close size within the unilateral capacity (NonProgress for none); the
 * reduction (`kernel_reduce_position_delta`); LockActive when it touches a barrier. Under a liquidation lock the
 * position is reduced and recertified with no fee or insurance; otherwise a close that would leave an uncovered loss
 * with open risk declares Recovery, as does a residual one step cannot book; the fee charged; the loss settled from
 * principal; a remaining loss opens the close ledger, takes the domain's insurance, and books a chunk of the residual
 * into the other side's B index (the PnL raised by it, the H-lock set); the position reduced; the account recertified;
 * the residue resets; the score must have fallen. Returns DONE, DECLARED where the original returns RecoveryRequired
 * after a declaration, or NONPROG where it returns NonProgress (the writes before stay).
 */
export function liquidate(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_LIVE_LQ) failV16(V16_LOCK_ACTIVE);
  checkV16(configShapeErr(h.config));
  if (asset >= toU64(h.config.max_market_slots)) failV16(V16_INVALID_CONFIG);
  const c = h.config;
  const feeBps = c.liquidation_fee_bps;
  // require_asset_live_reducible.
  const life = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset.lifecycle;
  if (life !== LIFECYCLE_ACTIVE && life !== LIFECYCLE_DRAIN_ONLY) failV16(V16_LOCK_ACTIVE);
  scalarPreflight(m, markets, pa);
  requireActiveLegSlotForAsset(pa, asset);
  refreshAndCertify(m, markets, pa, NO_OVERRIDE, 0n, c.public_b_chunk_atoms, false);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(healthCertErr(p.health_cert));
  if (p.health_cert.certified_liq_deficit === 0n) return NONPROG;
  const before = riskScore(pa);
  const slot = requireActiveLegSlotForAsset(pa, asset);
  const leg = p.legs.get(slot);
  checkV16(legErr(leg));
  if (leg.active !== 1n) failV16(V16_INVALID_LEG);
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const isShort = leg.side === 1n;
  const effQ = effectiveAbsQuantityForLeg(a, leg);
  const j: Projection = {
    equity: p.health_cert.certified_equity,
    maintenance: p.health_cert.certified_maintenance_req,
    capital: p.capital,
    pnl: p.pnl,
    isShort,
    oldQ: effQ,
    effective: a.effective_price,
    target: a.raw_oracle_target_price,
    bps: feeBps,
  };
  const request = closeRequestQ(c, j);
  // unilateral_close_capacity(asset, leg): the effective quantity, bounded by both sides' effective OI.
  let cap = effectiveAbsQuantityForLeg(a, leg);
  if (a.oi_eff_long_q < cap) cap = a.oi_eff_long_q;
  if (a.oi_eff_short_q < cap) cap = a.oi_eff_short_q;
  const budget = request < cap ? request : cap;
  if (budget === 0n) return NONPROG;
  // kernel_reduce_position_delta(basis, side, budget).
  const preAbs = absH(leg.basis_pos_q);
  const closeQ = budget < preAbs ? budget : preAbs;
  if (closeQ > I128_MAX_LQ) failV16(V16_ARITHMETIC_OVERFLOW);
  const delta: i128 = isShort ? toI128(closeQ) : -toI128(closeQ);
  // position_delta_touches_pending_domain_loss_barrier(account, asset, delta).
  if (delta !== 0n) {
    const current = signedPosition(loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(activeLegForAsset(pa, asset)));
    const next = current + delta;
    validateBasisOrZero(next);
    if (positionChangeTouchesBarrier(m, markets, asset, current, next)) failV16(V16_LOCK_ACTIVE);
  }
  checkV16(boolErr(p.liquidation_lock));
  if (p.liquidation_lock === 1n) {
    if (reducePosition(m, markets, pa, asset, closeQ) === DECLARED) return DECLARED;
    certifyAfterLocalSettlement(m, markets, pa);
    beginZeroOiResidueResets(m, markets, asset);
    return validateProgress(before, pa) ? DONE : NONPROG;
  }
  // liquidation_remaining_active_bitmap_after_close, then uncovered_loss_remains_with_open_risk.
  let remaining = p.active_bitmap.get(0n);
  if (closeQ === effQ) remaining &= ~(1n << slot);
  if (p.pnl < 0n && absH(p.pnl) > p.capital && remaining !== 0n) return declareAndReturn(m, markets, REASON_ACTIVE_BANKRUPT_CLOSE);
  if (residualExceedsOneStep(m, markets, asset, isShort, pa)) return declareAndReturn(m, markets, REASON_ACTIVE_BANKRUPT_CLOSE);
  const fee = liqFeeOrFloor(liqNotionalCeil(closeQ, a.effective_price), feeBps, c.min_liquidation_abs, c.liquidation_fee_cap, closeQ === effQ);
  if (fee === FEE_BELOW_FLOOR_LQ) return NONPROG;
  chargeAccountFee(m, markets, pa, fee);
  settleNegativePnlFromPrincipal(m, pa);
  const pnl1 = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  if (pnl1 < 0n) beginCloseProgressLedger(m, markets, pa, asset, !isShort, absH(pnl1));
  const used = consumeDomainInsurance(m, markets, asset, isShort, pa);
  if (used !== 0n && advanceCloseLedger(m, markets, pa, used, 0n, 0n) === DECLARED) return DECLARED;
  const pnl2 = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  if (pnl2 < 0n) {
    const residual = absH(pnl2);
    const out = bookResidualForAccount(m, markets, pa, asset, isShort, residual);
    if (out.status === DECLARED) return DECLARED;
    if (out.booked > U128_MAX_LQ - out.explicit) failV16(V16_ARITHMETIC_OVERFLOW);
    let cleared = out.booked + out.explicit;
    if (cleared > residual) cleared = residual;
    // cleared ≤ |pnl2|: it fits i128 and the sum moves toward zero.
    setAccountPnl(m, markets, pa, loadRawAt<Portfolio>(pa, HEADER_LEN).pnl + toI128(cleared));
    const hl = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    hl.bankruptcy_hlock_active = 1n;
  }
  if (reducePosition(m, markets, pa, asset, closeQ) === DECLARED) return DECLARED;
  certifyAfterLocalSettlement(m, markets, pa);
  beginZeroOiResidueResets(m, markets, asset);
  return validateProgress(before, pa) ? DONE : NONPROG;
}

// ---- AdvanceClose -------------------------------------------------------------------------------------------------------------

/**
 * `advance_pending_close_residual_not_atomic(account)`: the account validated with the market; LockActive unless Live;
 * NonProgress without a pending residual; the expiry guard; the loss settled from principal; the domain's insurance
 * (the ledger advanced by it); the residual clamped; a loss left with a pending ledger books one chunk (the PnL raised
 * by it, `kernel_settle_resolved_pnl_after_booking`); NonProgress unless the residual fell. Returns DONE (ResidualBooked
 * or AccountCurrent: the crank does not tell them apart), DECLARED or NONPROG.
 */
export function advancePendingClose(m: RemainingAccount, markets: u64, pa: RemainingAccount): u64 {
  validateWithMarket(m, pa, markets);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_LIVE_LQ) failV16(V16_LOCK_ACTIVE);
  const c0 = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
  checkV16(closeProgressErr(c0));
  if (!closeHasPendingResidual(c0)) return NONPROG;
  const residualBefore = c0.residual_remaining;
  if (ensureCloseNotExpired(m, markets, pa) === DECLARED) return DECLARED;
  const asset = toU64(c0.asset_index);
  const bankruptShort = c0.domain_side !== 1n;
  settleNegativePnlFromPrincipal(m, pa);
  const used = consumeDomainInsurance(m, markets, asset, bankruptShort, pa);
  if (used !== 0n && advanceCloseLedger(m, markets, pa, used, 0n, 0n) === DECLARED) return DECLARED;
  clampCloseResidual(m, markets, pa);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  if (p.pnl < 0n && closeHasPendingResidual(p.close_progress)) {
    const out = bookResidualForAccount(m, markets, pa, asset, bankruptShort, absH(p.pnl));
    if (out.status === DECLARED) return DECLARED;
    const pnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
    if (out.booked > U128_MAX_LQ - out.explicit) failV16(V16_ARITHMETIC_OVERFLOW);
    const loss = absH(pnl);
    let cleared = out.booked + out.explicit;
    if (cleared > loss) cleared = loss;
    if (cleared > I128_MAX_LQ) failV16(V16_ARITHMETIC_OVERFLOW);
    if (pnl > 0n && pnl > I128_MAX_L_LQ - toI128(cleared)) failV16(V16_ARITHMETIC_OVERFLOW);
    setAccountPnl(m, markets, pa, pnl + toI128(cleared));
  }
  if (loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress.residual_remaining >= residualBefore) return NONPROG;
  return DONE;
}

const I128_MAX_L_LQ: i128 = 0x7fffffffffffffffffffffffffffffffn;
