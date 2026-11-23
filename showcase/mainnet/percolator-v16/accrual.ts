// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator src/v16.rs and
// aeyakovenko/percolator-prog src/v16_program.rs, Copyright Anatoly Yakovenko, licensed under the Apache License,
// Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL. Ported here: asset accrual
// (`MarketGroupV16ViewMut::accrue_asset_to_not_atomic`, with `accrual_activity_for_asset_segment`,
// `kernel_adl_scaled_accrual_index_deltas`, `kernel_mark_kf_stale_cohorts` and the loss-stale summary) and the
// program's committed-funding accrual before an asset's shutdown (`accrue_committed_funding_before_asset_shutdown_view`,
// `permissionless_funding_rate_e9_view`, `funding_rate_from_checkpoint_view`, `policy_v16::premium_funding_rate_e9`,
// `oracle_v16::effective_price_from_target` and `clamp_toward_engine_dt`).
//
// Integer arithmetic. The original's `checked_*` calls return an error the program maps; TypeSOL fails a checked
// operation with its own code (5100). Every product or sum below that can leave its type is therefore tested before it
// is formed (in u256 where the factors can be as wide as the type), giving the original's error at the original's
// point. The funding numerator rate · dt · price cannot overflow: the rate is at most the configuration's maximum
// (≤ 10,000 by the config's shape), dt a u64 and the price at most 10^12, so the product is below 2^118.
import { type RemainingAccount, type i128, type u64, type u256, i128 as toI128, loadRawAt, loadRawMutAt, require, u64 as toU64, u128 as toU128, u256 as toU256 } from "typesol";
import { PercolatorError, V16_ARITHMETIC_OVERFLOW, V16_COUNTER_OVERFLOW, V16_INVALID_CONFIG, V16_LOCK_ACTIVE, V16_NON_PROGRESS, V16_RECOVERY_REQUIRED, checkV16, failV16 } from "./errors.js";
import { type AssetOracleProfile, type EngineAssetSlot, type GroupHeader, MARKET_GROUP_OFF, MAX_ORACLE_PRICE } from "./state.js";
import { FUNDING_DEN, LIFECYCLE_ACTIVE, LIFECYCLE_DRAIN_ONLY, blockersAfter, blockersBefore, engineSlotAt } from "./engine.js";
import { I128_MIN, assetStateErr, configShapeErr, marketModeErr } from "./wire.js";
import { advanceFundingMarkCheckpoint } from "./oracle.js";

const U64_MAX_A = 0xffffffffffffffffn;
const U128_MAX_A: u256 = 340282366920938463463374607431768211455n;
const I128_MAX_A: u256 = 170141183460469231731687303715884105727n;

// ---- Signed helpers ----------------------------------------------------------------------------------------------------

/** |x| as a u256 (i128::MIN included). */
function absWide(x: i128): u256 {
  if (x >= 0n) return toU256(toU128(x));
  if (x === I128_MIN) return I128_MAX_A + 1n;
  return toU256(toU128(-x));
}

/**
 * `checked_i128_mul(a, b)` (the product, then `validate_non_min_i128`): both failures are ArithmeticOverflow, so the
 * product's magnitude must stay below 2^127. Returns i128::MIN for the failure (never a valid result).
 */
export function mulNonMin(a: i128, b: i128): i128 {
  const p = absWide(a) * absWide(b);
  if (p > I128_MAX_A) return I128_MIN;
  const v = toI128(toU128(p));
  return (a < 0n) !== (b < 0n) ? -v : v;
}

/** `add_non_min_i128`: the checked sum, not i128::MIN. Returns i128::MIN for either failure. */
export function addNonMin(a: i128, b: i128): i128 {
  if (b > 0n && a > toI128(toU128(I128_MAX_A)) - b) return I128_MIN;
  if (b < 0n && a < I128_MIN - b) return I128_MIN;
  return a + b;
}

/** `wide_math::floor_div_signed_conservative_i128(n, FUNDING_DEN)`. */
export function floorDivFunding(n: i128): i128 {
  if (n === 0n) return 0n;
  const d = toI128(FUNDING_DEN);
  if (n > 0n) return n / d;
  const abs = absWide(n);
  const den = toU256(FUNDING_DEN);
  const q = abs % den !== 0n ? abs / den + 1n : abs / den;
  return -toI128(toU128(q));
}

// ---- Accrual (engine) ---------------------------------------------------------------------------------------------------

/**
 * `asset_is_loss_stale_at_slot(asset, slot)`: stale accounts on either side, or an asset that contributes to the
 * loss-stale summary (Active or DrainOnly with any exposure, position, stale, pending or loss weight) behind the slot.
 */
function lossStaleAt(e: EngineAssetSlot, slot: u64): boolean {
  const a = e.asset;
  if (a.stale_account_count_long !== 0n || a.stale_account_count_short !== 0n) return true;
  const contributes =
    (a.lifecycle === LIFECYCLE_ACTIVE || a.lifecycle === LIFECYCLE_DRAIN_ONLY) &&
    (a.oi_eff_long_q !== 0n ||
      a.oi_eff_short_q !== 0n ||
      a.stored_pos_count_long !== 0n ||
      a.stored_pos_count_short !== 0n ||
      a.stale_account_count_long !== 0n ||
      a.stale_account_count_short !== 0n ||
      a.pending_obligation_count_long !== 0n ||
      a.pending_obligation_count_short !== 0n ||
      a.loss_weight_sum_long !== 0n ||
      a.loss_weight_sum_short !== 0n);
  return contributes && a.slot_last < slot;
}

/**
 * `accrue_asset_to_not_atomic(asset, now, effective_price, funding_rate_e9, protective_progress_committed)`
 * (map_v16_error at every caller): one segment of at most `max_accrual_dt_slots`: the price move (capped per slot:
 * RecoveryRequired past it) into K, the funding rate · dt · price into F, both scaled by each side's A
 * (`kernel_adl_scaled_accrual_index_deltas`), the sides whose K or F moved marked stale for their stored positions
 * (`kernel_mark_kf_stale_cohorts`), the asset's slot advanced, the market's clock, slot, loss-stale flag and oracle
 * and funding epochs. The audit-scan shape check is a feature the program does not enable.
 */
export function accrueAssetTo(m: RemainingAccount, markets: u64, asset: u64, now: u64, price: u64, rate: i128, committed: boolean): void {
  if (accrueAssetToOrNonProgress(m, markets, asset, now, price, rate, committed)) failV16(V16_NON_PROGRESS);
}

/**
 * `accrue_asset_to_not_atomic` with its NonProgress as a value (true), for the crank, whose processor swallows a
 * NonProgress of the engine's crank once it has accrued a market (NOTES.md section 1, site 2). Both NonProgress refusals
 * come before any write.
 */
export function accrueAssetToOrNonProgress(m: RemainingAccount, markets: u64, asset: u64, now: u64, price: u64, rate: i128, committed: boolean): boolean {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(configShapeErr(h.config));
  checkV16(marketModeErr(h.mode));
  if (h.mode !== 0n) failV16(V16_LOCK_ACTIVE);
  const absRate = absWide(rate);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets || price === 0n || price > MAX_ORACLE_PRICE || absRate > toU256(h.config.max_abs_funding_e9_per_slot))
    failV16(V16_INVALID_CONFIG);
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  // require_asset_accruable, then asset_state (decoded).
  checkV16(assetStateErr(e.asset));
  if (e.asset.lifecycle !== LIFECYCLE_ACTIVE && e.asset.lifecycle !== LIFECYCLE_DRAIN_ONLY) failV16(V16_LOCK_ACTIVE);
  const a = e.asset;
  if (now < a.slot_last) failV16(V16_INVALID_CONFIG);
  const dtTotal = now - a.slot_last;
  const dt = dtTotal > h.config.max_accrual_dt_slots ? h.config.max_accrual_dt_slots : dtTotal;
  // accrual_activity_for_asset_segment.
  const exposed = a.oi_eff_long_q !== 0n || a.oi_eff_short_q !== 0n;
  const balanced = a.oi_eff_long_q !== 0n && a.oi_eff_short_q !== 0n;
  const priceMove = price !== a.effective_price && exposed;
  const funding = dt > 0n && rate !== 0n && balanced && a.fund_px_last > 0n;
  if (priceMove || funding) {
    if (dt === 0n) return true;
    const diff = price > a.effective_price ? price - a.effective_price : a.effective_price - price;
    const lhs = toU128(diff) * 10000n;
    const rhs = toU256(toU128(h.config.max_price_move_bps_per_slot) * toU128(dt)) * toU256(a.effective_price);
    if (rhs > U128_MAX_A) failV16(V16_ARITHMETIC_OVERFLOW);
    if (toU256(lhs) > rhs) failV16(V16_RECOVERY_REQUIRED);
    if (!committed) return true;
  }
  const priceDelta = toI128(toU128(price)) - toI128(toU128(a.effective_price));
  // The funding numerator (below 2^118: see the head of the file).
  const fundingNum = funding ? rate * toI128(toU128(dt)) * toI128(toU128(price)) : 0n;
  // kernel_adl_scaled_accrual_index_deltas.
  if (toU256(a.a_long) > I128_MAX_A || toU256(a.a_short) > I128_MAX_A) failV16(V16_ARITHMETIC_OVERFLOW);
  const aLong = toI128(a.a_long);
  const aShort = toI128(a.a_short);
  const kLong = mulNonMin(priceDelta, aLong);
  if (kLong === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
  const kShortPos = mulNonMin(priceDelta, aShort);
  if (kShortPos === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
  const kShort = -kShortPos;
  let fLong: i128 = 0n;
  let fShort: i128 = 0n;
  const den = toI128(FUNDING_DEN);
  if (fundingNum % den === 0n) {
    const units = fundingNum / den;
    const l = mulNonMin(units, aLong);
    if (l === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
    fLong = -l;
    fShort = mulNonMin(units, aShort);
    if (fShort === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
  } else {
    const l = mulNonMin(fundingNum, aLong);
    if (l === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
    const s = mulNonMin(fundingNum, aShort);
    if (s === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
    fLong = floorDivFunding(-l);
    fShort = floorDivFunding(s);
  }
  const longChanged = kLong !== 0n || fLong !== 0n;
  const shortChanged = kShort !== 0n || fShort !== 0n;
  const nkLong = addNonMin(a.k_long, kLong);
  if (nkLong === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
  const nkShort = addNonMin(a.k_short, kShort);
  if (nkShort === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
  const nfLong = addNonMin(a.f_long_num, fLong);
  if (nfLong === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
  const nfShort = addNonMin(a.f_short_num, fShort);
  if (nfShort === I128_MIN) failV16(V16_ARITHMETIC_OVERFLOW);
  if (a.slot_last > U64_MAX_A - dt) failV16(V16_ARITHMETIC_OVERFLOW);
  const slotLast = a.slot_last + dt;
  if (longChanged && slotLast <= a.kf_epoch_long) failV16(V16_INVALID_CONFIG);
  if (shortChanged && slotLast <= a.kf_epoch_short) failV16(V16_INVALID_CONFIG);
  // set_asset_state.
  const before = blockersBefore(m, asset);
  const oldPrice = a.effective_price;
  a.k_long = nkLong;
  a.k_short = nkShort;
  a.f_long_num = nfLong;
  a.f_short_num = nfShort;
  a.effective_price = price;
  // The canonical path's price-cap anchor moves with a direct price move (or a price at the target).
  if (price !== oldPrice || price === a.raw_oracle_target_price) a.fund_px_last = price;
  a.slot_last = slotLast;
  if (longChanged) {
    a.kf_epoch_long = slotLast;
    a.stale_account_count_long = a.stored_pos_count_long;
  }
  if (shortChanged) {
    a.kf_epoch_short = slotLast;
    a.stale_account_count_short = a.stored_pos_count_short;
  }
  blockersAfter(m, asset, before);
  if (now > h.current_slot) h.current_slot = now;
  h.slot_last = slotLast;
  h.loss_stale_active = lossStaleAt(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)), now) ? 1n : 0n;
  if (priceMove) {
    if (h.oracle_epoch === U64_MAX_A) failV16(V16_COUNTER_OVERFLOW);
    h.oracle_epoch += 1n;
  }
  if (funding) {
    if (h.funding_epoch === U64_MAX_A) failV16(V16_COUNTER_OVERFLOW);
    h.funding_epoch += 1n;
  }
  return false;
}

// ---- Committed funding (program) ------------------------------------------------------------------------------------------

/** `clamp_toward_engine_dt(p_last, target, cap_bps, dt)`: the target, moved at most cap · dt bps from p_last. */
export function clampTowardEngineDt(last: u64, target: u64, capBps: u64, dt: u64): u64 {
  if (last === 0n || target === 0n) return target;
  if (capBps === 0n || dt === 0n) return last;
  // (p_last · cap) saturating, then · dt saturating, / 10,000, at most u64::MAX.
  let wide = toU256(toU128(last) * toU128(capBps)) * toU256(dt);
  if (wide > U128_MAX_A) wide = U128_MAX_A;
  let maxDelta = wide / 10000n;
  if (maxDelta > toU256(U64_MAX_A)) maxDelta = toU256(U64_MAX_A);
  const d = toU64(toU128(maxDelta));
  if (target > last) {
    const up = last > U64_MAX_A - d ? U64_MAX_A : last + d;
    return target < up ? target : up;
  }
  const down = last < d ? 0n : last - d;
  return target > down ? target : down;
}

/** `policy_v16::premium_funding_rate_e9(mark, index, max)`: the premium of the mark over the index, ±max at most. */
function premiumFundingRate(mark: u64, index: u64, max: u64): i128 {
  if (max === 0n || mark === 0n || index === 0n || mark === index) return 0n;
  const diff = mark > index ? mark - index : index - mark;
  const premium = (toU128(diff) * FUNDING_DEN) / toU128(index);
  const bounded = premium < toU128(max) ? premium : toU128(max);
  return mark > index ? toI128(bounded) : -toI128(bounded);
}

/**
 * `permissionless_funding_rate_e9_view(profile, group, asset, now, effective_price)` with
 * `funding_rate_from_checkpoint_view`: zero unless the profile is price-managed (hybrid, EWMA or AuthMark) and the
 * market has a funding cap; the active funding mark (the funding mark, or a mark already at or before the asset's
 * slot); the index the mark is compared with (the new price, or with a pending later boundary the price clamped
 * towards the active mark over the segment).
 */
export function permissionlessFundingRate(m: RemainingAccount, markets: u64, at: u64, asset: u64, now: u64, price: u64): i128 {
  const p = loadRawAt<AssetOracleProfile>(m, at);
  if (!(p.oracle_mode === 1n || p.oracle_mode === 2n || p.oracle_mode === 3n)) return 0n;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const max = h.config.max_abs_funding_e9_per_slot;
  if (max === 0n) return 0n;
  require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  const assetSlot = a.slot_last;
  // asset_segment_dt_view.
  require(now >= assetSlot, PercolatorError.EngineStale);
  const dt = now - assetSlot < h.config.max_accrual_dt_slots ? now - assetSlot : h.config.max_accrual_dt_slots;
  const exposed = a.oi_eff_long_q !== 0n || a.oi_eff_short_q !== 0n;
  let active = 0n;
  if (p.funding_mark_e6 !== 0n) active = p.funding_mark_e6;
  else if (p.mark_ewma_last_slot <= assetSlot) active = p.mark_ewma_e6;
  else return 0n;
  const pending = p.funding_mark_pending_e6 !== 0n && p.funding_mark_pending_slot > assetSlot;
  const index = pending ? (exposed ? clampTowardEngineDt(a.effective_price, active, h.config.max_price_move_bps_per_slot, dt) : active) : price;
  return premiumFundingRate(active, index, max);
}

/**
 * `accrue_committed_funding_before_asset_shutdown_view(profile, group, asset, slot)`: the Clock not behind the asset
 * (EngineStale); the funding-mark checkpoint advanced to the asset's slot; no pending boundary already due
 * (EngineStale); the asset's effective price valid (OracleInvalid); for a balanced asset with a nonzero rate, the gap
 * within one segment (EngineStale) and the accrual at the frozen price, then the checkpoint advanced to the Clock.
 * The profile at `at` changes in place, as the original's copy does before it is written back.
 */
export function accrueCommittedFundingBeforeShutdown(m: RemainingAccount, markets: u64, at: u64, asset: u64, slot: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  const assetSlot = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.slot_last;
  require(slot >= assetSlot, PercolatorError.EngineStale);
  advanceFundingMarkCheckpoint(m, at, assetSlot);
  const p = loadRawAt<AssetOracleProfile>(m, at);
  require(!(p.funding_mark_pending_e6 !== 0n && p.funding_mark_pending_slot <= slot), PercolatorError.EngineStale);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  const frozen = a.effective_price;
  require(frozen !== 0n && frozen <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  const rate = permissionlessFundingRate(m, markets, at, asset, slot, frozen);
  if (!(a.oi_eff_long_q !== 0n && a.oi_eff_short_q !== 0n) || rate === 0n) return;
  require(slot - assetSlot <= h.config.max_accrual_dt_slots, PercolatorError.EngineStale);
  accrueAssetTo(m, markets, asset, slot, frozen, rate, true);
  advanceFundingMarkCheckpoint(m, at, slot);
}

