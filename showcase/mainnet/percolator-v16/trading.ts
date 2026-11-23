// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs and
// aeyakovenko/percolator src/v16.rs, Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// TradeNoCpi (tag 6): `handle_trade_nocpi` and `handle_trade_nocpi_zero_copy`, with what the processor does around the
// engine's trade (trade.ts): the zero-move funding accrual before a position change
// (`accrue_zero_move_funding_before_position_change_for_profile_view`, `zero_move_funding_path_for_profile_view`,
// `canonical_accrual_path_for_target_view`, `pending_zero_move_funding_requires_crank_view` and the engine's
// `accrue_asset_path_to_not_atomic` with `canonical_accrual_price_step_v16`), the accepted print and the dynamic fee
// quote (`accepted_reported_trade_price_view`, `hybrid_trade_fee_quote_view` and their `policy_v16` helpers), the
// stale-portfolio guard, the maintenance fees of both portfolios, the source-domain admission and lien bounds, the
// backing-domain fees (`apply_backing_domain_fees_after_trade_view` with the engine's
// `charge_account_backing_fee_not_atomic`), the fee credits to the insurance budgets, the post-trade mark and its
// staged target, the oracle profile's and (for asset 0) the wrapper config's write-back, and the position epochs.
//
// Copies (NOTES.md, section 12). The handler reads the asset's oracle profile and the wrapper config into copies and
// writes them back at its end; every failure in between fails the transaction and nothing in between reads the bytes
// those copies change from the account (the backing-fee policy read takes the profile's fee fields, which the trade
// never changes), so the port changes the account in place. The zero-move accrual's simulation is a real copy (a local
// AssetOracleProfile): the original keeps the simulation only when the path is accepted, and maps every error inside it
// to InvalidConfig. The snapshots of source-domain values before the trade (the original's boxed slices) are kept in
// fixed local arrays of the 32 slots.
//
// Repeated accounts. Two portfolios and the market are borrowed at once: the same portfolio twice is refused first
// (InvalidInstruction), and a portfolio that is the market fails its portfolio header check before any borrow. The two
// signers are only read (`is_signer`, the key): the same key for both, or a signer that is also a portfolio or the
// market, borrows nothing.
import {
  type FixedArray,
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type i128,
  type u8,
  type u16,
  type u64,
  type u128,
  type u256,
  fixedArray,
  loadRawAt,
  loadRawMutAt,
  require,
  i128 as toI128,
  u16 as toU16,
  u32,
  u64 as toU64,
  u128 as toU128,
  u256 as toU256,
} from "typesol";
import {
  PercolatorError,
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_OVERFLOW,
  V16_INVALID_CONFIG,
  V16_LOCK_ACTIVE,
  V16_NON_PROGRESS,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type AssetOracleProfile,
  type AssetOracleWrapper,
  type BackingBucket,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type WrapperConfig,
  EFFECTIVE_PRICE_PROVENANCE_AUTHENTICATED,
  EFFECTIVE_PRICE_PROVENANCE_TRADE_DRIVEN,
  HEADER_LEN,
  KIND_PORTFOLIO,
  MARKET_GROUP_OFF,
  MATCHER_ENABLED_MASK,
  MATCHER_POSITION_EPOCH_MASK,
  MATCHER_POSITION_EPOCH_MAX,
  MATCHER_POSITION_EPOCH_SHIFT,
  MAX_ORACLE_PRICE,
  ORACLE_MODE_AUTH_MARK,
  ORACLE_MODE_EWMA_MARK,
  ORACLE_MODE_HYBRID_AFTER_HOURS,
  PORTFOLIO_MATCHER_CONTROL_OFF,
  PORTFOLIO_MATCHER_EXPIRY_OFF,
  checkHeader,
  readPortfolioId,
  readPortfolioPositionEpoch,
  validateAssetOracleProfile,
  validateMatcherControl,
  validateWrapperConfig,
} from "./state.js";
import { BOUND_SCALE, V16_MAX_PORTFOLIO_ASSETS_N, assetStateErr, backingBucketErr, configShapeErr, healthCertErr, marketModeErr } from "./wire.js";
import {
  FUNDING_DEN,
  LIFECYCLE_ACTIVE,
  LIFECYCLE_DRAIN_ONLY,
  PORTFOLIO_SOURCE_DOMAIN_CAP,
  blockersAfter,
  engineSlotAt,
  legErr,
  marketShapeErr,
  setAssetRawOracleTarget,
  slotBlockers,
  sourceCreditErr,
  validateWithMarket,
} from "./engine.js";
import { addNonMin, clampTowardEngineDt, floorDivFunding, mulNonMin } from "./accrual.js";
import { ewmaUpdate } from "./oracle.js";
import {
  bucketAt,
  bucketForDomain,
  domainAssetSide,
  domainInsuranceBudgetSpent,
  domainIsOccupied,
  setBucketEarnings,
  validateDomainLedger,
} from "./primitives.js";
import { creditDomainInsuranceBudget } from "./refresh.js";
import { certCurrentErr } from "./health.js";
import { type BatchRequest, type TradeRequest, executeTrade } from "./trade.js";
import { creditMaintenanceFee } from "./custody.js";
import { syncAccountFeeToSlot } from "./refresh.js";
import {
  authenticatedMarketSlot,
  ensurePortfolioStorage,
  expectPortfolioAccountKey,
  marketViewMut,
  needAccounts,
  ownerCheck,
  permissionlessStaleMatured,
  portfolioViewMut,
  profileFromView,
  readMarketConfigMode,
  signerCheck,
  writableCheck,
} from "./program.js";

const U64_MAX_TR: u64 = 0xffffffffffffffffn;
const U128_MAX_TR: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MAX_TR: u128 = 0x7fffffffffffffffffffffffffffffffn;
const U128_MAX_TRW: u256 = 340282366920938463463374607431768211455n;
/** `V16_MAX_ACCRUAL_PATH_STEPS`. */
const MAX_PATH_STEPS = 32n;
/** `constants::WRAPPER_MAX_BOUNDED_SOURCE_DOMAINS` (14 assets · 2), `WRAPPER_SOURCE_LIEN_REFRESH_LEG_WEIGHT`,
 * `WRAPPER_MAX_SOURCE_LIEN_REFRESH_WORK`. */
export const MAX_BOUNDED_SOURCE_DOMAINS = 28n;
const LIEN_REFRESH_LEG_WEIGHT = 6n;
export const MAX_LIEN_REFRESH_WORK = 72n;
/** `percolator::CREDIT_RATE_SCALE`, `MAX_MARGIN_BPS`. */
const CREDIT_RATE_SCALE_TR: u128 = 1000000000000n;
const MAX_MARGIN_BPS_TR: u64 = 10000n;
const POS_SCALE_TR: u64 = 1000000n;
/** `BackingBucketStatusV16::Fresh`. */
const BUCKET_FRESH_TR: u8 = 1n;

// ---- Oracle profile predicates --------------------------------------------------------------------------------------------

export function isHybrid(p: AssetOracleProfile): boolean {
  return p.oracle_mode === ORACLE_MODE_HYBRID_AFTER_HOURS;
}
export function isPriceManaged(p: AssetOracleProfile): boolean {
  return p.oracle_mode === ORACLE_MODE_HYBRID_AFTER_HOURS || p.oracle_mode === ORACLE_MODE_EWMA_MARK || p.oracle_mode === ORACLE_MODE_AUTH_MARK;
}
/** `oracle_v16::profile_hybrid_soft_stale_matured`. */
export function softStaleMatured(p: AssetOracleProfile, now: u64): boolean {
  return isHybrid(p) && p.hybrid_soft_stale_slots !== 0n && (now > p.last_good_oracle_slot ? now - p.last_good_oracle_slot : 0n) > p.hybrid_soft_stale_slots;
}
/** `profile_updates_mark_from_trade_view(profile, now)`: an EWMA mark, or a hybrid whose soft-stale window matured. */
export function updatesMarkFromTrade(p: AssetOracleProfile, now: u64): boolean {
  return p.oracle_mode === ORACLE_MODE_EWMA_MARK || (isHybrid(p) && softStaleMatured(p, now));
}

// ---- Funding-mark transitions on a local profile --------------------------------------------------------------------------

/** `advance_funding_mark_checkpoint_view` on a local profile (oracle.ts has it for the account's). */
function advanceCheckpointLocal(p: Inout<AssetOracleProfile>, assetSlot: u64): void {
  if (p.funding_mark_e6 === 0n && p.mark_ewma_last_slot <= assetSlot) p.funding_mark_e6 = p.mark_ewma_e6;
  if (p.funding_mark_pending_e6 !== 0n && p.funding_mark_pending_slot <= assetSlot) {
    const activated = p.funding_mark_pending_slot;
    p.funding_mark_e6 = p.funding_mark_pending_e6;
    p.funding_mark_pending_e6 = 0n;
    p.funding_mark_pending_slot = 0n;
    if (p.mark_ewma_last_slot > activated) {
      if (p.mark_ewma_last_slot <= assetSlot) p.funding_mark_e6 = p.mark_ewma_e6;
      else {
        p.funding_mark_pending_e6 = p.mark_ewma_e6;
        p.funding_mark_pending_slot = p.mark_ewma_last_slot;
      }
    }
  }
}

/** `record_funding_mark_transition_view` on the simulated profile (its EngineStale is the zero-move simulation's
 * InvalidConfig; the crank's own, `crank`). */
function recordTransitionLocal(p: Inout<AssetOracleProfile>, assetSlot: u64, nextMark: u64, markSlot: u64, crank: boolean): void {
  advanceCheckpointLocal(p, assetSlot);
  if (p.funding_mark_e6 === 0n) return;
  if (p.funding_mark_pending_e6 !== 0n) {
    if (markSlot < p.funding_mark_pending_slot) pathFail(crank, 19n);
    if (markSlot === p.funding_mark_pending_slot) p.funding_mark_pending_e6 = nextMark;
    return;
  }
  if (markSlot <= assetSlot) p.funding_mark_e6 = nextMark;
  else {
    p.funding_mark_pending_e6 = nextMark;
    p.funding_mark_pending_slot = markSlot;
  }
}

/** `policy_v16::premium_funding_rate_e9(mark, index, max)`. */
function premiumRate(mark: u64, index: u64, max: u64): i128 {
  if (max === 0n || mark === 0n || index === 0n || mark === index) return 0n;
  const diff = mark > index ? mark - index : index - mark;
  const premium = (toU128(diff) * FUNDING_DEN) / toU128(index);
  const bounded = premium < toU128(max) ? premium : toU128(max);
  return mark > index ? toI128(bounded) : -toI128(bounded);
}

/** `funding_rate_from_checkpoint_view(profile, max, cap, exposed, asset_slot, before, after, dt)`. */
function fundingRateFromCheckpoint(p: AssetOracleProfile, max: u64, cap: u64, exposed: boolean, assetSlot: u64, before: u64, after: u64, dt: u64): i128 {
  if (!isPriceManaged(p) || max === 0n) return 0n;
  let active: u64 = 0n;
  if (p.funding_mark_e6 !== 0n) active = p.funding_mark_e6;
  else if (p.mark_ewma_last_slot <= assetSlot) active = p.mark_ewma_e6;
  else return 0n;
  const pending = p.funding_mark_pending_e6 !== 0n && p.funding_mark_pending_slot > assetSlot;
  const index = pending ? (exposed ? clampTowardEngineDt(before, active, cap, dt) : active) : after;
  return premiumRate(active, index, max);
}

/** A refusal of the canonical path: InvalidConfig inside the zero-move simulation (which maps every error of it), the
 * original's own error in the crank. */
function pathFail(crank: boolean, e: u64): void {
  if (!crank) failV16(V16_INVALID_CONFIG);
  // The PercolatorError of that number: Custom(e).
  require(false, u32(e));
}

// ---- The canonical accrual path ----------------------------------------------------------------------------------------

/** `AccrualStepV16`. */
export interface AccrualStep {
  price: u64;
  rate: i128;
  rem_before: u64;
  rem_after: u64;
}

/** `canonical_accrual_price_step_v16(current, target, anchor, max_bps, exposed, remainder)`: the next price and remainder
 * (`err` set for an error: InvalidConfig or ArithmeticOverflow). */
interface PriceStep {
  price: u64;
  rem: u64;
  err: u64;
}

function canonicalPriceStep(current: u64, target: u64, anchor: u64, maxBps: u64, exposed: boolean, rem: u64): PriceStep {
  if (
    current === 0n ||
    target === 0n ||
    anchor === 0n ||
    current > MAX_ORACLE_PRICE ||
    target > MAX_ORACLE_PRICE ||
    anchor > MAX_ORACLE_PRICE ||
    rem >= MAX_MARGIN_BPS_TR
  )
    return { price: 0n, rem: 0n, err: V16_INVALID_CONFIG };
  if (!exposed) return { price: target, rem: 0n, err: 0n };
  if (current === target || maxBps === 0n) return { price: current, rem: 0n, err: 0n };
  // anchor ≤ 1e12 and the bps a u64: the product fits u128 (below 2^104), the remainder below 10,000.
  const numerator = toU128(anchor) * toU128(maxBps) + toU128(rem);
  const maxDelta = numerator / toU128(MAX_MARGIN_BPS_TR);
  const after = toU64(numerator % toU128(MAX_MARGIN_BPS_TR));
  const distance = toU128(current > target ? current - target : target - current);
  if (maxDelta >= distance) return { price: target, rem: 0n, err: 0n };
  // maxDelta < distance ≤ 1e12: a u64, and the step stays between current and target.
  const delta = toU64(maxDelta);
  return { price: target > current ? current + delta : current - delta, rem: after, err: 0n };
}

/**
 * `canonical_accrual_path_for_target_view(profile, group, asset, now, target, target_slot)` on the simulation's profile
 * `sim`, every refusal the simulation's InvalidConfig (`zero_move_funding_path_for_profile_view` maps them all): the
 * asset configured and the target nonzero, the Clock not behind the asset; min(segment, 32) one-slot steps from the
 * asset's effective price towards the target (the old target until `target_slot` when the target changes; the price
 * cap anchored at the funding anchor for an unchanged target, else at the effective price; the remainder carried), a
 * fresh hybrid's mark following the price, each step's funding rate from the simulated checkpoint; the remainder, the
 * hybrid mark and its provenance written into `sim`. Returns the number of steps written into `steps`.
 *
 * With `crank` (the crank calls it directly, `?` after it) each refusal is the original's own: InvalidInstruction for the
 * asset or the target, EngineStale for a Clock behind the asset or a mark transition before a pending one,
 * EngineInvalidConfig for the anchor or a step, EngineArithmeticOverflow for the slot, OracleInvalid for a step's price.
 */
export function canonicalPath(
  m: RemainingAccount,
  markets: u64,
  sim: Inout<AssetOracleProfile>,
  asset: u64,
  now: u64,
  target: u64,
  targetSlot: u64,
  steps: Inout<FixedArray<AccrualStep, 32>>,
  crank: boolean,
): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets || target === 0n) pathFail(crank, 9n);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  let simSlot = a.slot_last;
  if (now < simSlot) pathFail(crank, 19n);
  // asset_segment_dt_view (its EngineStale cannot happen after the check above).
  const segment = now - simSlot < h.config.max_accrual_dt_slots ? now - simSlot : h.config.max_accrual_dt_slots;
  const count = segment < MAX_PATH_STEPS ? segment : MAX_PATH_STEPS;
  const oldTarget = a.raw_oracle_target_price === 0n ? a.effective_price : a.raw_oracle_target_price;
  const exposed = a.oi_eff_long_q !== 0n || a.oi_eff_short_q !== 0n;
  const maxBps = h.config.max_price_move_bps_per_slot;
  const maxRate = h.config.max_abs_funding_e9_per_slot;
  let price = a.effective_price;
  let anchor = price;
  if (oldTarget === target) {
    anchor = a.fund_px_last;
    if (anchor === 0n || anchor > MAX_ORACLE_PRICE) failV16(V16_INVALID_CONFIG);
  }
  let rem: u64 = oldTarget === target ? toU64(sim.price_move_remainder_bps_num) : 0n;
  const freshHybrid = isHybrid(sim) && !softStaleMatured(sim, now);
  const hybridStart = sim.last_good_oracle_slot;
  for (let i = 0n; i < count; i++) {
    advanceCheckpointLocal(sim, simSlot);
    if (simSlot === U64_MAX_TR) pathFail(crank, 15n);
    const next = simSlot + 1n;
    const stepTarget = oldTarget === target || next >= targetSlot ? target : oldTarget;
    const before = rem;
    const s = canonicalPriceStep(price, stepTarget, anchor, maxBps, exposed, before);
    if (s.err !== 0n) failV16(V16_INVALID_CONFIG);
    rem = s.rem;
    if (s.price === 0n || s.price > MAX_ORACLE_PRICE) pathFail(crank, 26n);
    if (freshHybrid && next >= hybridStart && s.price !== sim.mark_ewma_e6) {
      recordTransitionLocal(sim, simSlot, s.price, next, crank);
      sim.mark_ewma_e6 = s.price;
      sim.mark_ewma_last_slot = next;
    }
    const rate = fundingRateFromCheckpoint(sim, maxRate, maxBps, exposed, simSlot, price, s.price, 1n);
    const step = steps.get(i);
    step.price = s.price;
    step.rate = rate;
    step.rem_before = before;
    step.rem_after = rem;
    price = s.price;
    simSlot = next;
    advanceCheckpointLocal(sim, simSlot);
  }
  if (freshHybrid && price !== sim.mark_ewma_e6) {
    recordTransitionLocal(sim, simSlot, price, now, crank);
    sim.mark_ewma_e6 = price;
    sim.mark_ewma_last_slot = now;
  }
  if (freshHybrid && price === target) sim.effective_price_provenance = EFFECTIVE_PRICE_PROVENANCE_AUTHENTICATED;
  // set_price_move_remainder_bps_num_view: below 10,000 (a step's remainder is).
  sim.price_move_remainder_bps_num = toU16(rem);
  return count;
}

/**
 * `zero_move_funding_path_for_profile_view(profile, group, asset)` on the simulation's profile `sim` (a copy of the
 * account's): 0 (None) unless the profile is price-managed, the asset configured and in the view, a segment has passed
 * (its EngineStale is InvalidConfig) and both sides have OI; the stored mark target (`stored_mark_target_for_zero_move_
 * accrual_view`: the mark for a managed mark, the asset's raw target otherwise; InvalidConfig out of range); the
 * canonical path to it; 0 again when the path moves the price or carries no funding. Otherwise the number of steps (the
 * caller then keeps `sim`). `target` receives the target.
 */
function zeroMovePath(
  m: RemainingAccount,
  markets: u64,
  sim: Inout<AssetOracleProfile>,
  asset: u64,
  steps: Inout<FixedArray<AccrualStep, 32>>,
  target: Inout<FixedArray<u64, 2>>,
): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (!isPriceManaged(sim) || asset >= toU64(h.config.max_market_slots) || asset >= markets) return 0n;
  const now = authenticatedMarketSlot(h.current_slot);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  if (now < a.slot_last) failV16(V16_INVALID_CONFIG);
  const segment = now - a.slot_last < h.config.max_accrual_dt_slots ? now - a.slot_last : h.config.max_accrual_dt_slots;
  if (segment === 0n || a.oi_eff_long_q === 0n || a.oi_eff_short_q === 0n) return 0n;
  const effective = a.effective_price;
  const managedMark = sim.oracle_mode === ORACLE_MODE_AUTH_MARK || sim.oracle_mode === ORACLE_MODE_EWMA_MARK || (isHybrid(sim) && softStaleMatured(sim, now));
  const t = managedMark ? sim.mark_ewma_e6 : a.raw_oracle_target_price;
  if (t === 0n || t > MAX_ORACLE_PRICE) failV16(V16_INVALID_CONFIG);
  const targetSlot = a.slot_last === U64_MAX_TR ? U64_MAX_TR : a.slot_last + 1n;
  const count = canonicalPath(m, markets, sim, asset, now, t, targetSlot, steps, false);
  if (count === 0n) return 0n;
  let funding = false;
  for (let i = 0n; i < count; i++) {
    const s = steps.get(i);
    if (s.price !== effective) return 0n;
    if (s.rate !== 0n) funding = true;
  }
  if (!funding) return 0n;
  target.set(0n, now);
  target.set(1n, t);
  return count;
}

/**
 * `pending_zero_move_funding_requires_crank_view(profile, group, asset)`: a pending funding mark due within the
 * asset's next segment on a balanced asset whose price would not move towards it, with a nonzero premium.
 */
function pendingZeroMoveRequiresCrank(m: RemainingAccount, markets: u64, p: AssetOracleProfile, asset: u64): boolean {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (p.funding_mark_pending_e6 === 0n || asset >= toU64(h.config.max_market_slots) || asset >= markets) return false;
  const now = authenticatedMarketSlot(h.current_slot);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  if (a.oi_eff_long_q === 0n || a.oi_eff_short_q === 0n || p.funding_mark_pending_slot > now || a.slot_last >= p.funding_mark_pending_slot) return false;
  // asset_segment_dt_view: the Clock is at least the pending slot, which is past the asset's.
  const segment = now - a.slot_last < h.config.max_accrual_dt_slots ? now - a.slot_last : h.config.max_accrual_dt_slots;
  if (segment === 0n) return false;
  const pending = p.funding_mark_pending_e6;
  const bounded = clampTowardEngineDt(a.effective_price, pending, h.config.max_price_move_bps_per_slot, segment);
  return bounded === a.effective_price && premiumRate(pending, a.effective_price, h.config.max_abs_funding_e9_per_slot) !== 0n;
}

/**
 * The engine's `accrue_asset_path_to_not_atomic(asset, now, target, steps, true)`: the config's shape; InvalidConfig
 * unless Live, the asset configured and in the view, the target a valid price and the Clock not behind the market; the
 * asset accruable (Active or DrainOnly: LockActive); the step count the canonical one; each step checked against the
 * canonical price step from the asset's state (InvalidConfig) and applied (the price move into K and the funding into F,
 * scaled by each side's A); the funding anchor; the K/F stale cohorts; the target; the market's clock, slot, loss-stale
 * flag and oracle and funding epochs.
 */
export function accrueAssetPath(m: RemainingAccount, markets: u64, asset: u64, now: u64, target: u64, steps: FixedArray<AccrualStep, 32>, count: u64): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(configShapeErr(h.config));
  checkV16(marketModeErr(h.mode));
  if (h.mode !== 0n || asset >= toU64(h.config.max_market_slots) || asset >= markets || target === 0n || target > MAX_ORACLE_PRICE || now < h.current_slot)
    failV16(V16_INVALID_CONFIG);
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  checkV16(assetStateErr(e.asset));
  if (e.asset.lifecycle !== LIFECYCLE_ACTIVE && e.asset.lifecycle !== LIFECYCLE_DRAIN_ONLY) failV16(V16_LOCK_ACTIVE);
  const a = e.asset;
  const kLongBefore = a.k_long;
  const kShortBefore = a.k_short;
  const fLongBefore = a.f_long_num;
  const fShortBefore = a.f_short_num;
  if (now < a.slot_last) failV16(V16_INVALID_CONFIG);
  let expected = now - a.slot_last;
  if (expected > h.config.max_accrual_dt_slots) expected = h.config.max_accrual_dt_slots;
  if (expected > MAX_PATH_STEPS) expected = MAX_PATH_STEPS;
  if (count !== expected) failV16(V16_INVALID_CONFIG);
  const changed = a.raw_oracle_target_price !== target;
  const anchor = changed ? a.effective_price : a.fund_px_last;
  if (anchor === 0n || anchor > MAX_ORACLE_PRICE) failV16(V16_INVALID_CONFIG);
  const before = slotBlockers(e);
  if (changed) a.fund_px_last = a.effective_price;
  let moves = 0n;
  let fundings = 0n;
  let expectedRem: u64 = count === 0n ? 0n : steps.get(0n).rem_before;
  const maxRate = toU128(h.config.max_abs_funding_e9_per_slot);
  for (let i = 0n; i < count; i++) {
    const s = steps.get(i);
    const absRate = s.rate < 0n ? (s.rate === -0x80000000000000000000000000000000n ? I128_MAX_TR + 1n : toU128(-s.rate)) : toU128(s.rate);
    if (s.price === 0n || s.price > MAX_ORACLE_PRICE || absRate > maxRate || (i === 0n && changed && s.rem_before !== 0n) || s.rem_before !== expectedRem)
      failV16(V16_INVALID_CONFIG);
    const exposed = a.oi_eff_long_q !== 0n || a.oi_eff_short_q !== 0n;
    const c = canonicalPriceStep(a.effective_price, target, anchor, h.config.max_price_move_bps_per_slot, exposed, s.rem_before);
    if (c.err !== 0n) failV16(c.err);
    if (s.price !== c.price || s.rem_after !== c.rem) failV16(V16_INVALID_CONFIG);
    expectedRem = c.rem;
    // accrual_activity_for_asset_segment(asset, 1, price, rate); an active segment needs committed progress (it is).
    const balanced = a.oi_eff_long_q !== 0n && a.oi_eff_short_q !== 0n;
    const priceMove = s.price !== a.effective_price && exposed;
    const funding = s.rate !== 0n && balanced && a.fund_px_last > 0n;
    const priceDelta = toI128(toU128(s.price)) - toI128(toU128(a.effective_price));
    // rate · price: |rate| ≤ the config's maximum and the price ≤ 1e12, far inside i128.
    const fundingNum = funding ? s.rate * toI128(toU128(s.price)) : 0n;
    // kernel_adl_scaled_accrual_index_deltas.
    if (a.a_long > I128_MAX_TR || a.a_short > I128_MAX_TR) failV16(V16_ARITHMETIC_OVERFLOW);
    const aLong = toI128(a.a_long);
    const aShort = toI128(a.a_short);
    const kLong = mulNonMin(priceDelta, aLong);
    if (kLong === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
    const kShortPos = mulNonMin(priceDelta, aShort);
    if (kShortPos === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
    let fLong: i128 = 0n;
    let fShort: i128 = 0n;
    const den = toI128(FUNDING_DEN);
    if (fundingNum % den === 0n) {
      const units = fundingNum / den;
      const l = mulNonMin(units, aLong);
      if (l === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
      fLong = -l;
      fShort = mulNonMin(units, aShort);
      if (fShort === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
    } else {
      const l = mulNonMin(fundingNum, aLong);
      if (l === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
      const sh = mulNonMin(fundingNum, aShort);
      if (sh === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
      fLong = floorDivFunding(-l);
      fShort = floorDivFunding(sh);
    }
    const nkLong = addNonMin(a.k_long, kLong);
    if (nkLong === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
    const nkShort = addNonMin(a.k_short, -kShortPos);
    if (nkShort === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
    const nfLong = addNonMin(a.f_long_num, fLong);
    if (nfLong === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
    const nfShort = addNonMin(a.f_short_num, fShort);
    if (nfShort === -0x80000000000000000000000000000000n) failV16(V16_ARITHMETIC_OVERFLOW);
    a.k_long = nkLong;
    a.k_short = nkShort;
    a.f_long_num = nfLong;
    a.f_short_num = nfShort;
    a.effective_price = s.price;
    if (a.slot_last === U64_MAX_TR) failV16(V16_ARITHMETIC_OVERFLOW);
    a.slot_last += 1n;
    if (priceMove) moves += 1n;
    if (funding) fundings += 1n;
  }
  if (a.effective_price === target) a.fund_px_last = a.effective_price;
  const longChanged = a.k_long !== kLongBefore || a.f_long_num !== fLongBefore;
  const shortChanged = a.k_short !== kShortBefore || a.f_short_num !== fShortBefore;
  // kernel_mark_kf_stale_cohorts(asset, long, short, slot_last).
  if (longChanged) {
    if (a.slot_last <= a.kf_epoch_long) failV16(V16_INVALID_CONFIG);
    a.kf_epoch_long = a.slot_last;
    a.stale_account_count_long = a.stored_pos_count_long;
  }
  if (shortChanged) {
    if (a.slot_last <= a.kf_epoch_short) failV16(V16_INVALID_CONFIG);
    a.kf_epoch_short = a.slot_last;
    a.stale_account_count_short = a.stored_pos_count_short;
  }
  a.raw_oracle_target_price = target;
  if (before > toU128(U64_MAX_TR)) failV16(V16_COUNTER_OVERFLOW);
  blockersAfter(m, asset, toU64(before));
  h.current_slot = now;
  h.slot_last = a.slot_last;
  // asset_is_loss_stale_at_slot(asset, now).
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
  const stale = a.stale_account_count_long !== 0n || a.stale_account_count_short !== 0n || (contributes && a.slot_last < now);
  h.loss_stale_active = stale ? 1n : 0n;
  const epochAdd = moves + (changed ? 1n : 0n);
  if (h.oracle_epoch > U64_MAX_TR - epochAdd) failV16(V16_COUNTER_OVERFLOW);
  h.oracle_epoch += epochAdd;
  if (h.funding_epoch > U64_MAX_TR - fundings) failV16(V16_COUNTER_OVERFLOW);
  h.funding_epoch += fundings;
}

/**
 * `accrue_zero_move_funding_before_position_change_for_profile_view(profile, group, asset, require_full_catchup)`
 * (map_v16_error at the caller) on the account's profile at `at`: nothing for an asset not configured or not in the
 * view; the checkpoint advanced to the asset's slot; the zero-move path (simulated on a copy); without one, a reducing
 * trade that leaves a pending zero-move funding to a crank is Stale; with one, the simulation kept, the path accrued, the
 * checkpoint advanced, and a reducing trade with more zero-move funding left is Stale.
 *
 * @noinline
 */
export function accrueZeroMoveBeforePositionChange(m: RemainingAccount, markets: u64, at: u64, asset: u64, reduces: boolean): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) return;
  const w = loadRawMutAt<AssetOracleWrapper>(m, at);
  advanceCheckpointLocal(w.profile, loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.slot_last);
  const steps = fixedArray<AccrualStep, 32>({ price: 0n, rate: 0n, rem_before: 0n, rem_after: 0n });
  const target = fixedArray<u64, 2>(0n);
  const sim: AssetOracleProfile = w.profile;
  const count = zeroMovePath(m, markets, sim, asset, steps, target);
  if (count === 0n) {
    if (reduces && pendingZeroMoveRequiresCrank(m, markets, w.profile, asset)) failV16(V16_STALE);
    return;
  }
  w.profile = sim;
  accrueAssetPath(m, markets, asset, target.get(0n), target.get(1n), steps, count);
  advanceCheckpointLocal(w.profile, loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.slot_last);
  if (reduces) {
    const again: AssetOracleProfile = w.profile;
    if (zeroMovePath(m, markets, again, asset, steps, target) !== 0n || pendingZeroMoveRequiresCrank(m, markets, w.profile, asset)) failV16(V16_STALE);
  }
}

// ---- The fee quote --------------------------------------------------------------------------------------------------------

/** `policy_v16::mul_div_u128_by_u64(value, multiplier, denominator, round_up)` (its None: EngineArithmeticOverflow). */
export function mulDivByU64(value: u128, mult: u64, den: u64, up: boolean): u128 {
  const d = toU128(den);
  const whole = value / d;
  const residue = (value % d) * toU128(mult);
  require(toU128(mult) === 0n || whole <= U128_MAX_TR / toU128(mult), PercolatorError.EngineArithmeticOverflow);
  const q = whole * toU128(mult);
  require(q <= U128_MAX_TR - residue / d, PercolatorError.EngineArithmeticOverflow);
  const sum = q + residue / d;
  const bump: u128 = up && residue % d !== 0n ? 1n : 0n;
  require(sum <= U128_MAX_TR - bump, PercolatorError.EngineArithmeticOverflow);
  return sum + bump;
}

/** `policy_v16::trade_fee_notional_ceil(size, price)`. */
export function policyNotionalCeil(size: u128, price: u64): u128 {
  if (size === 0n || price === 0n) return 0n;
  return mulDivByU64(size, price, POS_SCALE_TR, true);
}

/** `policy_v16::two_sided_trade_fee_paid(notional, bps)`: twice the one-side fee rounded up. */
function twoSidedFeePaid(notional: u128, bps: u64): u128 {
  if (notional === 0n || bps === 0n) return 0n;
  const one = mulDivByU64(notional, bps, 10000n, true);
  require(one <= U128_MAX_TR / 2n, PercolatorError.EngineArithmeticOverflow);
  return one * 2n;
}

/** `policy_v16::price_move_bps_ceil(old, new)`. */
function priceMoveBpsCeil(old: u64, next: u64): u64 {
  if (old === 0n || old === next) return 0n;
  const diff = toU128(old > next ? old - next : next - old);
  const bps = (diff * 10000n + (toU128(old) - 1n)) / toU128(old);
  require(bps <= toU128(U64_MAX_TR), PercolatorError.EngineArithmeticOverflow);
  return toU64(bps);
}

/** `HybridTradeFeeQuote`. */
export interface FeeQuote {
  fee_bps: u64;
  post_trade_mark: u64;
  base_fee_paid: u128;
  externality: u128;
}

/**
 * `hybrid_trade_fee_quote_view(cfg, profile, group, asset, size, accepted_price, caller_fee_bps)`: the base fee (the
 * larger of the caller's and the policy's, at most the market's maximum: InvalidInstruction); the base fee alone unless
 * the profile is an EWMA mark or a matured hybrid with a mark; otherwise the mark the print would move the EWMA to,
 * clamped by the externality fee the maximum rate leaves over the larger of the trade's and the larger side's notional
 * (OracleInvalid past MAX_ORACLE_PRICE), and the fee rate that pays for that move.
 */
export function feeQuote(m: RemainingAccount, markets: u64, p: AssetOracleProfile, asset: u64, size: u128, price: u64, callerBps: u64): FeeQuote {
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const base = callerBps > cfg.trade_fee_base_bps ? callerBps : cfg.trade_fee_base_bps;
  const maxBps = h.config.max_trading_fee_bps;
  require(base <= maxBps, PercolatorError.InvalidInstruction);
  const plain: FeeQuote = { fee_bps: base, post_trade_mark: 0n, base_fee_paid: 0n, externality: 0n };
  if (!isPriceManaged(p) || p.oracle_mode === ORACLE_MODE_AUTH_MARK) return plain;
  const now = authenticatedMarketSlot(h.current_slot);
  if (isHybrid(p) && !softStaleMatured(p, now)) return plain;
  if (asset >= toU64(h.config.max_market_slots) || p.mark_ewma_e6 === 0n) return plain;
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  const notional = policyNotionalCeil(size, price);
  const maxSide = a.oi_eff_long_q > a.oi_eff_short_q ? a.oi_eff_long_q : a.oi_eff_short_q;
  const externalityPrice = a.effective_price > p.mark_ewma_e6 ? a.effective_price : p.mark_ewma_e6;
  const sideNotional = mulDivByU64(maxSide, externalityPrice, POS_SCALE_TR, true);
  const larger = sideNotional > notional ? sideNotional : notional;
  require(larger <= U128_MAX_TR / 2n, PercolatorError.EngineArithmeticOverflow);
  const externality = larger * 2n;
  const candidate = ewmaUpdate(p.mark_ewma_e6, price, p.mark_ewma_halflife_slots, p.mark_ewma_last_slot, now, p.mark_min_fee, p.mark_min_fee);
  require(candidate <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  const basePaid = twoSidedFeePaid(notional, base);
  const maxPaid = twoSidedFeePaid(notional, maxBps);
  const available = maxPaid > basePaid ? maxPaid - basePaid : 0n;
  const candidateMove = priceMoveBpsCeil(p.mark_ewma_e6, candidate);
  let supported: u64 = 0n;
  if (externality !== 0n) {
    require(available <= U128_MAX_TR / 10000n, PercolatorError.EngineArithmeticOverflow);
    const paid = (available * 10000n) / externality;
    supported = paid > toU128(U64_MAX_TR) ? U64_MAX_TR : toU64(paid);
  }
  let quoted = candidateMove < maxBps ? candidateMove : maxBps;
  if (supported < quoted) quoted = supported;
  const post = clampTowardEngineDt(p.mark_ewma_e6, candidate, quoted, 1n);
  const actual = priceMoveBpsCeil(p.mark_ewma_e6, post);
  require(actual === 0n || externality <= U128_MAX_TR / toU128(actual), PercolatorError.EngineArithmeticOverflow);
  const product = externality * toU128(actual);
  const markPaid = product / 10000n + (product % 10000n !== 0n ? 1n : 0n);
  require(basePaid <= U128_MAX_TR - markPaid, PercolatorError.EngineArithmeticOverflow);
  const required = basePaid + markPaid;
  return { fee_bps: feeBpsForPaid(notional, required, base, maxBps), post_trade_mark: post, base_fee_paid: basePaid, externality };
}

/** `policy_v16::fee_bps_for_two_sided_fee_paid(notional, required, min, max)`: the least rate in [min, max] whose two-sided
 * fee pays `required` (a bisection), max when none does. */
function feeBpsForPaid(notional: u128, required: u128, min: u64, max: u64): u64 {
  require(min <= max, PercolatorError.EngineArithmeticOverflow);
  if (required === 0n || notional === 0n) return min;
  if (twoSidedFeePaid(notional, min) >= required) return min;
  if (twoSidedFeePaid(notional, max) < required) return max;
  let lo = min;
  let hi = max;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (twoSidedFeePaid(notional, mid) >= required) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

// ---- Source-domain snapshots and bounds --------------------------------------------------------------------------------

/**
 * The sparse snapshots of a portfolio's occupied source domains taken before the trade (the original's
 * `source_counterparty_backing_snapshot_view` and `source_lien_effective_reserved_snapshot_for_trade_view`, two boxed
 * `(u32, u128)` slices over the same occupied slots in slot order): the domains, the counterparty lien backing and the
 * effective lien reserve of each.
 */
export interface DomainSnapshot {
  domains: FixedArray<u32, 32>;
  backing: FixedArray<u128, 32>;
  lien: FixedArray<u128, 32>;
  len: u64;
}

/** Both snapshots of a portfolio. */
export function snapshot(pa: RemainingAccount, out: Inout<DomainSnapshot>): void {
  out.len = 0n;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = p.source_domains.get(slot);
    if (!domainIsOccupied(s)) continue;
    out.domains.set(out.len, s.domain);
    out.backing.set(out.len, s.source_lien_counterparty_backing_num);
    out.lien.set(out.len, s.source_lien_effective_reserved);
    out.len += 1n;
  }
}

/** `sparse_domain_value_lookup(snapshot, domain)` on the backing (`lien` false) or the lien reserve: the first entry's
 * value, 0 for none. */
export function lookupValue(s: DomainSnapshot, domain: u64, lien: boolean): u128 {
  for (let i = 0n; i < s.len; i++) if (toU64(s.domains.get(i)) === domain) return lien ? s.lien.get(i) : s.backing.get(i);
  return 0n;
}

/** `trade_delta_may_require_source_domain_capacity(current, delta)`: opening, growing or flipping. */
export function deltaMayRequireCapacity(current: i128, delta: i128): boolean {
  // current.checked_add(delta) (EngineArithmeticOverflow): a size near the bounds of i128 with a position of its sign.
  require(!(current > 0n && delta > toI128(I128_MAX_TR) - current) &&
    !(current < 0n && delta < -toI128(I128_MAX_TR) - 1n - current), PercolatorError.EngineArithmeticOverflow);
  const post = current + delta;
  if (current === 0n) return delta !== 0n;
  if (current > 0n) return delta > 0n || post < 0n;
  return delta < 0n || post > 0n;
}

/** `signed_position_for_asset_view(group, portfolio, asset)`: the asset in the view (EngineInvalidConfig); the first
 * active leg of the asset and its market id (each leg decoded), signed by its side; 0 for none. */
export function signedPositionForAsset(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64): i128 {
  require(asset < markets, PercolatorError.EngineInvalidConfig);
  const id = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.market_id;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active === 1n && toU64(leg.asset_index) === asset && leg.market_id === id) {
      const abs = leg.basis_pos_q < 0n ? -leg.basis_pos_q : leg.basis_pos_q;
      return leg.side === 1n ? -abs : abs;
    }
  }
  return 0n;
}

/**
 * `reserved_source_domains_snapshot_for_trade_view(group, account, [request], invert)` with the request's signed delta
 * for this portfolio: the occupied domains, then both domains of every active leg that this trade does not close, each
 * added once within the wrapper's bound (InvalidInstruction past 28). Returns the count.
 */
function reservedDomains(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, delta: i128, doms: Inout<FixedArray<u64, 32>>): u64 {
  let len = 0n;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = p.source_domains.get(slot);
    if (!domainIsOccupied(s)) continue;
    // `out.len >= out.domains.len()` cannot hold within 32 slots.
    doms.set(len, toU64(s.domain));
    len += 1n;
  }
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) continue;
    const legAsset = toU64(leg.asset_index);
    if (legAsset === asset) {
      // current.checked_add(delta) == Some(0), without forming an overflowing sum.
      const position = signedPositionForAsset(m, markets, pa, asset);
      if (position === -delta) continue;
    }
    // v16_domain_pair_for_asset_index: the asset as a u32 domain pair (no overflow below 2^31).
    len = pushReserved(doms, len, legAsset * 2n);
    len = pushReserved(doms, len, legAsset * 2n + 1n);
  }
  return len;
}

/** `ensure_trade_delta_source_domain_capacity_view(admitted, asset, current, delta)`: when the delta may need it, the
 * snapshot within the bound (InvalidInstruction) and the asset's pair admitted. */
function ensureDeltaCapacity(doms: Inout<FixedArray<u64, 32>>, len: u64, asset: u64, current: i128, delta: i128): void {
  if (!deltaMayRequireCapacity(current, delta)) return;
  require(len <= MAX_BOUNDED_SOURCE_DOMAINS, PercolatorError.InvalidInstruction);
  const next = pushReserved(doms, len, asset * 2n);
  pushReserved(doms, next, asset * 2n + 1n);
}

/** `SourceDomainAdmissionSnapshot::push_reserved`: a domain added once (InvalidInstruction past 28 or 32). */
export function pushReserved(doms: Inout<FixedArray<u64, 32>>, len: u64, domain: u64): u64 {
  for (let i = 0n; i < len; i++) if (doms.get(i) === domain) return len;
  require(len < MAX_BOUNDED_SOURCE_DOMAINS, PercolatorError.InvalidInstruction);
  doms.set(len, domain);
  return len + 1n;
}

/** `source_lien_refresh_work_view(account)`: 0 without liened claims, else the liened claims plus 6 per active leg. */
export function lienRefreshWork(pa: RemainingAccount): u64 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  let claims = 0n;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) if (p.source_domains.get(slot).source_claim_liened_num !== 0n) claims += 1n;
  if (claims === 0n) return 0n;
  let legs = 0n;
  let bitmap = p.active_bitmap.get(0n);
  while (bitmap !== 0n) {
    legs += bitmap & 1n;
    bitmap >>= 1n;
  }
  return claims + LIEN_REFRESH_LEG_WEIGHT * legs;
}

/**
 * `ensure_new_counterparty_backed_liens_fresh_for_trade_view(group, slot, before, account)` for one portfolio: each
 * occupied domain whose counterparty lien backing grew needs its bucket (`backing_domain_parts_view`: the domain
 * configured, InvalidInstruction; the source state and the bucket decoded) Fresh and unexpired at the slot
 * (EngineStale).
 */
export function ensureNewCounterpartyLiensFresh(m: RemainingAccount, markets: u64, pa: RemainingAccount, before: DomainSnapshot, slot: u64): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let i = 0n; i < PORTFOLIO_SOURCE_DOMAIN_CAP; i++) {
    const s = p.source_domains.get(i);
    if (!domainIsOccupied(s)) continue;
    const d = toU64(s.domain);
    if (s.source_lien_counterparty_backing_num <= lookupValue(before, d, false)) continue;
    backingDomainParts(m, markets, d);
    const b = loadRawAt<BackingBucket>(m, bucketAt(d));
    require(b.status === BUCKET_FRESH_TR && b.expiry_slot > slot, PercolatorError.EngineStale);
  }
}

/** `backing_domain_parts_view(group, domain)`: the domain below twice the configured slots and its asset in the view
 * (InvalidInstruction), its source state and bucket decoded (map_v16_error). */
function backingDomainParts(m: RemainingAccount, markets: u64, d: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(d < 2n * toU64(h.config.max_market_slots) && d / 2n < markets, PercolatorError.InvalidInstruction);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(d / 2n));
  if (d % 2n === 1n) {
    checkV16(sourceCreditErr(e.source_credit_short));
    checkV16(backingBucketErr(e.backing_short));
  } else {
    checkV16(sourceCreditErr(e.source_credit_long));
    checkV16(backingBucketErr(e.backing_long));
  }
}

/**
 * `ensure_source_credit_full_rate_for_domain_view(group, domain)`: the configured slots within the view and the domain's
 * asset configured (EngineInvalidConfig); its source state decoded; a state with live amounts at less than the full
 * credit rate is EngineLockActive.
 */
function ensureFullRate(m: RemainingAccount, markets: u64, d: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const configured = toU64(h.config.max_market_slots);
  require(!(configured > markets || d / 2n >= configured), PercolatorError.EngineInvalidConfig);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(d / 2n));
  const s = d % 2n === 1n ? e.source_credit_short : e.source_credit_long;
  checkV16(sourceCreditErr(s));
  const live =
    s.positive_claim_bound_num !== 0n ||
    s.exact_positive_claim_num !== 0n ||
    s.fresh_reserved_backing_num !== 0n ||
    s.spent_backing_num !== 0n ||
    s.provider_receivable_num !== 0n ||
    s.valid_liened_backing_num !== 0n ||
    s.impaired_liened_backing_num !== 0n ||
    s.insurance_credit_reserved_num !== 0n ||
    s.valid_liened_insurance_num !== 0n ||
    s.impaired_liened_insurance_num !== 0n;
  require(!(live && s.credit_rate_num !== CREDIT_RATE_SCALE_TR), PercolatorError.EngineLockActive);
}

// ---- Backing-domain fees ------------------------------------------------------------------------------------------------

/**
 * The engine's `charge_account_backing_fee_not_atomic(account, domain, provider_fee, domain, insurance_fee)` (map_v16_error
 * at the caller): both domains; nothing for a zero total; validated with the market; the certificate current (Stale); a
 * negative PnL or capital short of the fee is LockActive; the certificate after the debit (`health_cert_after_capital_
 * debit`: the equity lowered, LockActive below zero or the initial requirement); the capital and c_tot lowered; the
 * provider's part into the domain's Fresh unexpired bucket's earnings (LockActive otherwise; CounterOverflow), the ledger
 * validated; the insurance part into the insurance and the domain's budget (CounterOverflow, the remaining total within
 * the insurance: LockActive), the ledger validated; validated with the market and the market's shape.
 */
function chargeAccountBackingFee(m: RemainingAccount, markets: u64, pa: RemainingAccount, domain: u64, provider: u128, insurance: u128): void {
  domainAssetSide(m, markets, domain);
  domainAssetSide(m, markets, domain);
  if (provider > U128_MAX_TR - insurance) failV16(V16_ARITHMETIC_OVERFLOW);
  const total = provider + insurance;
  if (total === 0n) return;
  validateWithMarket(m, pa, markets);
  checkV16(certCurrentErr(m, pa));
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (p.pnl < 0n || p.capital < total) failV16(V16_LOCK_ACTIVE);
  // health_cert_after_capital_debit (the certificate decoded in the currentness check).
  const c = p.health_cert;
  if (total > I128_MAX_TR) failV16(V16_ARITHMETIC_OVERFLOW);
  if (c.certified_equity < -0x80000000000000000000000000000000n + toI128(total)) failV16(V16_ARITHMETIC_OVERFLOW);
  const equity = c.certified_equity - toI128(total);
  if (equity < 0n || toU128(equity) < c.certified_initial_req) failV16(V16_LOCK_ACTIVE);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  // capital ≥ total (checked); c_tot ≥ capital (the market's shape).
  if (h.c_tot < total) failV16(12n);
  p.capital -= total;
  h.c_tot -= total;
  c.certified_equity = equity;
  c.certified_liq_deficit = c.certified_maintenance_req > toU128(equity) ? c.certified_maintenance_req - toU128(equity) : 0n;
  if (provider !== 0n) {
    const expiry = bucketForDomain(m, markets, domain);
    const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
    if (b.status !== BUCKET_FRESH_TR || expiry <= h.current_slot) failV16(V16_LOCK_ACTIVE);
    if (b.utilization_fee_earnings > U128_MAX_TR - provider) failV16(V16_COUNTER_OVERFLOW);
    setBucketEarnings(m, markets, domain, b.utilization_fee_earnings + provider, expiry);
    validateDomainLedger(m, markets, domain);
  }
  if (insurance !== 0n) {
    if (h.insurance > U128_MAX_TR - insurance) failV16(V16_COUNTER_OVERFLOW);
    const next = h.insurance + insurance;
    const bs = domainInsuranceBudgetSpent(m, markets, domain);
    if (bs.budget > U128_MAX_TR - insurance) failV16(V16_COUNTER_OVERFLOW);
    h.insurance = next;
    // set_domain_insurance_budget_core(domain, budget + fee, next insurance): the remaining part grows by the fee.
    if (bs.budget < bs.spent) failV16(V16_INVALID_CONFIG);
    const totalRemaining = h.insurance_domain_budget_remaining_total;
    if (totalRemaining > U128_MAX_TR - insurance) failV16(V16_COUNTER_OVERFLOW);
    if (totalRemaining + insurance > next) failV16(V16_LOCK_ACTIVE);
    h.insurance_domain_budget_remaining_total = totalRemaining + insurance;
    const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(domain / 2n));
    if (domain % 2n === 1n) e.insurance_domain_budget_short = bs.budget + insurance;
    else e.insurance_domain_budget_long = bs.budget + insurance;
    validateDomainLedger(m, markets, domain);
  }
  validateWithMarket(m, pa, markets);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/** `backing_domain_fee_split_for_lien_delta_num(delta, bps, share)`: the fee on the delta's atoms (InvalidConfig for a
 * bps past 10,000 or a delta not atom-aligned), the insurance share floored, the rest to the provider. */
interface FeeSplit {
  total: u128;
  provider: u128;
  insurance: u128;
}
function backingFeeSplit(delta: u128, bps: u64, share: u64): FeeSplit {
  if (bps > MAX_MARGIN_BPS_TR || share > MAX_MARGIN_BPS_TR || delta % BOUND_SCALE !== 0n) failV16(V16_INVALID_CONFIG);
  const atoms = delta / BOUND_SCALE;
  let total: u128 = 0n;
  if (atoms !== 0n && bps !== 0n) {
    const p: u256 = toU256(atoms) * toU256(bps);
    const q: u256 = p / 10000n + (p % 10000n !== 0n ? 1n : 0n);
    if (q > U128_MAX_TRW) failV16(V16_ARITHMETIC_OVERFLOW);
    total = toU128(q);
  }
  const ins = toU128((toU256(total) * toU256(share)) / 10000n);
  return { total, provider: total - ins, insurance: ins };
}

/**
 * `collect_backing_domain_fees_for_account_view` and `charge_account_backing_domain_fees_view` for one portfolio: each
 * occupied domain whose counterparty lien backing grew is charged its asset's backing-trade fee on the growth (the
 * policy of the domain's side read from its oracle profile; a fee above the signed cap is Unauthorized), summed per
 * domain, then charged in that order. Returns the total.
 */
function collectBackingFees(m: RemainingAccount, markets: u64, pa: RemainingAccount, before: DomainSnapshot, cap: u64, fees: Inout<DomainSnapshot>): u128 {
  fees.len = 0n;
  let total: u128 = 0n;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let i = 0n; i < PORTFOLIO_SOURCE_DOMAIN_CAP; i++) {
    const s = p.source_domains.get(i);
    if (!domainIsOccupied(s)) continue;
    const d = toU64(s.domain);
    const after = s.source_lien_counterparty_backing_num;
    const prior = lookupValue(before, d, false);
    if (after <= prior) continue;
    const at = profileFromView(m, markets, d / 2n);
    const profile = loadRawAt<AssetOracleProfile>(m, at);
    const bps = d % 2n === 0n ? toU64(profile.backing_trade_fee_bps_long) : toU64(profile.backing_trade_fee_bps_short);
    const share = d % 2n === 0n ? toU64(profile.backing_trade_fee_insurance_share_bps_long) : toU64(profile.backing_trade_fee_insurance_share_bps_short);
    const split = backingFeeSplit(after - prior, bps, share);
    if (split.total === 0n) continue;
    require(bps <= cap, PercolatorError.Unauthorized);
    // domain_fee_add: an existing entry raised (EngineArithmeticOverflow), else appended.
    let found = false;
    for (let j = 0n; j < fees.len; j++) {
      if (toU64(fees.domains.get(j)) !== d) continue;
      require(fees.backing.get(j) <= U128_MAX_TR - split.provider, PercolatorError.EngineArithmeticOverflow);
      fees.backing.set(j, fees.backing.get(j) + split.provider);
      require(fees.lien.get(j) <= U128_MAX_TR - split.insurance, PercolatorError.EngineArithmeticOverflow);
      fees.lien.set(j, fees.lien.get(j) + split.insurance);
      found = true;
      break;
    }
    if (!found) {
      fees.domains.set(fees.len, s.domain);
      fees.backing.set(fees.len, split.provider);
      fees.lien.set(fees.len, split.insurance);
      fees.len += 1n;
    }
    require(total <= U128_MAX_TR - split.total, PercolatorError.EngineArithmeticOverflow);
    total += split.total;
  }
  return total;
}

// ---- Position epochs --------------------------------------------------------------------------------------------------

/** `bump_portfolio_position_epoch(data)` (not matcher-synchronized): the header; the control word validated, the epoch
 * advanced (EngineCounterOverflow past its 49 bits), the matcher disabled; the matcher expiry zeroed. */
export function bumpPositionEpoch(pa: RemainingAccount): void {
  bumpPositionEpochWithMatcherState(pa, false);
}

/** `bump_portfolio_position_epoch_with_matcher_state(data, synchronized)`: the header; the control word validated, the
 * epoch advanced (EngineCounterOverflow past its 49 bits); unless the matcher is synchronized (TradeCpi's and
 * BatchTradeCpi's LP after its matcher's fill: `bump_portfolio_position_epoch_after_matcher_fill`), the matcher disabled
 * and its expiry zeroed. */
export function bumpPositionEpochWithMatcherState(pa: RemainingAccount, synced: boolean): void {
  checkHeader(pa, KIND_PORTFOLIO);
  require(pa.dataLen >= PORTFOLIO_MATCHER_CONTROL_OFF + 8n, PercolatorError.InvalidAccountLen);
  const cell = loadRawMutAt<U64Word>(pa, PORTFOLIO_MATCHER_CONTROL_OFF);
  const control = cell.v;
  validateMatcherControl(control);
  const epoch = (control & MATCHER_POSITION_EPOCH_MASK) >> MATCHER_POSITION_EPOCH_SHIFT;
  require(epoch !== U64_MAX_TR && epoch + 1n <= MATCHER_POSITION_EPOCH_MAX, PercolatorError.EngineCounterOverflow);
  let next = (control & ~MATCHER_POSITION_EPOCH_MASK) | ((epoch + 1n) << MATCHER_POSITION_EPOCH_SHIFT);
  if (!synced) next &= ~MATCHER_ENABLED_MASK;
  cell.v = next;
  if (synced) return;
  checkHeader(pa, KIND_PORTFOLIO);
  require(pa.dataLen >= PORTFOLIO_MATCHER_EXPIRY_OFF + 8n, PercolatorError.InvalidAccountLen);
  const expiry = loadRawMutAt<U64Word>(pa, PORTFOLIO_MATCHER_EXPIRY_OFF);
  expiry.v = 0n;
}

/** A u64 word of an account's data. */
interface U64Word {
  v: u64;
}

/** `expect_portfolio_position_binding(data, id, epoch)`: the id (EngineProvenanceMismatch), the position epoch
 * (EngineStale). */
export function expectPositionBinding(pa: RemainingAccount, id: u64, epoch: u64): void {
  require(readPortfolioId(pa) === id, PercolatorError.EngineProvenanceMismatch);
  require(readPortfolioPositionEpoch(pa) === epoch, PercolatorError.EngineStale);
}

// ---- The handler ---------------------------------------------------------------------------------------------------------

/**
 * `handle_trade_nocpi(a_id, a_epoch, b_id, b_epoch, asset, market_id, size, exec_price, fee_bps, backing_fee_cap_bps)`:
 * accounts signer A, signer B, market (w), portfolio A (w), portfolio B (w). Both owners sign; the three writable and
 * the program's; the portfolios distinct (InvalidInstruction); each portfolio's id and position epoch; the reported
 * price valid (OracleInvalid); the market's config and a Live mode (EngineLockActive); the signed fee at least the base
 * policy fee and the backing cap at most 10,000 (InvalidInstruction). Then `handle_trade_nocpi_zero_copy`.
 *
 * @noinline
 */
export function tradeNoCpi(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 5n);
  const signerA = rest.get(0n);
  const signerB = rest.get(1n);
  const m = rest.get(2n);
  const pa = rest.get(3n);
  const pb = rest.get(4n);
  signerCheck(signerA);
  signerCheck(signerB);
  writableCheck(m);
  writableCheck(pa);
  writableCheck(pb);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  ownerCheck(pb, programId);
  require(pa.key !== pb.key, PercolatorError.InvalidInstruction);
  const aId = data.readU64(1n);
  const aEpoch = data.readU64(9n);
  const bId = data.readU64(17n);
  const bEpoch = data.readU64(25n);
  const asset = toU64(data.readU16(33n));
  const marketId = data.readU64(35n);
  const rawSize = data.readU128(43n);
  const size: i128 = rawSize > I128_MAX_TR ? -toI128(U128_MAX_TR - rawSize) - 1n : toI128(rawSize);
  const execPrice = data.readU64(59n);
  const feeBps = data.readU64(67n);
  const cap = toU64(data.readU16(75n));
  expectPositionBinding(pa, aId, aEpoch);
  expectPositionBinding(pb, bId, bEpoch);
  require(execPrice !== 0n && execPrice <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  const mode = readMarketConfigMode(m);
  require(mode === 0n, PercolatorError.EngineLockActive);
  require(loadRawAt<WrapperConfig>(m, HEADER_LEN).trade_fee_base_bps <= feeBps, PercolatorError.InvalidInstruction);
  require(cap <= 10000n, PercolatorError.InvalidInstruction);
  tradeZeroCopy(signerA.key, signerB.key, m, pa, pb, aId, aEpoch, bId, bEpoch, asset, marketId, size, execPrice, feeBps, cap, cap, false);
}

/**
 * `handle_trade_nocpi_zero_copy`: both portfolios' storage; the market view (`market_view_mut_with_fee_carry`); the asset
 * in the view with the expected market id (AssetGenerationMismatch); its oracle profile (validated); a matured
 * permissionless resolution refused (OracleStale); the bindings again, both portfolio views, their account ids and
 * owners (Unauthorized); the size nonzero and not i128::MIN (InvalidInstruction); both positions on the asset; the
 * zero-move funding accrued (Stale when a reducing trade leaves some to a crank); the accepted print and the fee quote;
 * the stale-portfolio guard; both maintenance fees; the source-domain admission; the snapshots; the engine's trade (A
 * long for a positive size); the side-OI cap; new counterparty liens fresh; the backing-domain fees; the trade fees into
 * the insurance budgets (the mark-externality part kept outside them); the post-trade mark and its staged target; the
 * profile written (validated) and, for a price-managed asset 0, the config's mark fields; the shape when no target was
 * staged; the lien bounds; both position epochs advanced.
 *
 * @noinline
 */
export function tradeZeroCopy(
  ownerA: Pubkey,
  ownerB: Pubkey,
  m: RemainingAccount,
  pa: RemainingAccount,
  pb: RemainingAccount,
  aId: u64,
  aEpoch: u64,
  bId: u64,
  bEpoch: u64,
  asset: u64,
  marketId: u64,
  size: i128,
  execPrice: u64,
  feeBps: u64,
  capA: u64,
  capB: u64,
  synced: boolean,
): void {
  ensurePortfolioStorage(pa);
  ensurePortfolioStorage(pb);
  const markets = marketViewMut(m);
  require(asset < markets && loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.market_id === marketId, PercolatorError.AssetGenerationMismatch);
  const at = profileFromView(m, markets, asset);
  rejectMaturedForProfile(m, at);
  expectPositionBinding(pa, aId, aEpoch);
  expectPositionBinding(pb, bId, bEpoch);
  portfolioViewMut(pa);
  portfolioViewMut(pb);
  expectPortfolioAccountKey(pa);
  expectPortfolioAccountKey(pb);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === ownerA, PercolatorError.Unauthorized);
  require(loadRawAt<Portfolio>(pb, HEADER_LEN).owner === ownerB, PercolatorError.Unauthorized);
  require(size !== 0n && size !== -0x80000000000000000000000000000000n, PercolatorError.InvalidInstruction);
  const sizeAbs = size < 0n ? toU128(-size) : toU128(size);
  const posA = signedPositionForAsset(m, markets, pa, asset);
  const posB = signedPositionForAsset(m, markets, pb, asset);
  const reduces = (posA > 0n && size < 0n) || (posA < 0n && size > 0n) || (posB > 0n && -size < 0n) || (posB < 0n && -size > 0n);
  accrueZeroMoveBeforePositionChange(m, markets, at, asset, reduces);
  const basis = acceptedTradePrice(m, markets, at, asset, execPrice);
  const quote = feeQuote(m, markets, loadRawAt<AssetOracleProfile>(m, at), asset, sizeAbs, basis, feeBps);
  ensureTradePortfolioCurrent(m, markets, pa, asset);
  ensureTradePortfolioCurrent(m, markets, pb, asset);
  collectMaintenanceFeesBeforeTrade(m, markets, pa, pb);
  const needsA = deltaMayRequireCapacity(posA, size);
  const needsB = deltaMayRequireCapacity(posB, -size);
  if (needsA || needsB) admitSourceDomains(m, markets, pa, pb, asset, posA, posB, size);
  tradeAfterChecks(m, markets, at, pa, pb, asset, size, sizeAbs, basis, quote, capA, capB, synced);
}

/** `reject_permissionless_resolve_matured_live_for_profile_view(cfg, profile, group)`: on a Live market, the
 * market-wide stale window matured, or a price-managed profile's own (OracleStale). */
export function rejectMaturedForProfile(m: RemainingAccount, at: u64): void {
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const h0 = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h0.mode !== 0n) return;
  const now = authenticatedMarketSlot(h0.current_slot);
  const prof = loadRawAt<AssetOracleProfile>(m, at);
  const own =
    isPriceManaged(prof) &&
    cfg.permissionless_resolve_stale_slots !== 0n &&
    (now > prof.last_good_oracle_slot ? now - prof.last_good_oracle_slot : 0n) >= cfg.permissionless_resolve_stale_slots;
  require(!(permissionlessStaleMatured(cfg, now) || own), PercolatorError.OracleStale);
}

/** `accepted_reported_trade_price_view(profile, group, asset, print)`: the print valid (OracleInvalid); the asset configured and in the view
 * (InvalidInstruction); for a profile the trade moves, the print clamped toward the EWMA mark by the elapsed slots
 * (EngineStale for a mark ahead of the Clock); otherwise the asset's effective price. */
export function acceptedTradePrice(m: RemainingAccount, markets: u64, at: u64, asset: u64, execPrice: u64): u64 {
  // ensure_valid_reported_trade_price: TradeNoCpi and BatchTradeNoCpi checked the print already; a matcher's price
  // (TradeCpi, BatchTradeCpi) is checked here first.
  require(execPrice !== 0n && execPrice <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  const now = authenticatedMarketSlot(h.current_slot);
  const profile = loadRawAt<AssetOracleProfile>(m, at);
  let basis = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.effective_price;
  if (updatesMarkFromTrade(profile, now)) {
    require(now >= profile.mark_ewma_last_slot, PercolatorError.EngineStale);
    const dt = now - profile.mark_ewma_last_slot < h.config.max_accrual_dt_slots ? now - profile.mark_ewma_last_slot : h.config.max_accrual_dt_slots;
    basis = clampTowardEngineDt(profile.mark_ewma_e6, execPrice, h.config.max_price_move_bps_per_slot, dt);
  }
  return basis;
}

/** `collect_maintenance_fee_before_trade_view` for A, then B (on a Live market: the callers checked the mode). */
export function collectMaintenanceFeesBeforeTrade(m: RemainingAccount, markets: u64, pa: RemainingAccount, pb: RemainingAccount): void {
  const rate = loadRawAt<WrapperConfig>(m, HEADER_LEN).maintenance_fee_per_slot;
  if (rate === 0n) return;
  creditMaintenanceFee(m, markets, syncAccountFeeToSlot(m, pa, markets, authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot), rate));
  creditMaintenanceFee(m, markets, syncAccountFeeToSlot(m, pb, markets, authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot), rate));
}

/**
 * The source-domain admission of both portfolios: both snapshots, then both admissions (A's, then B's).
 *
 * @noinline
 */
function admitSourceDomains(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  pb: RemainingAccount,
  asset: u64,
  posA: i128,
  posB: i128,
  size: i128,
): void {
  const domsA = fixedArray<u64, 32>(0n);
  const domsB = fixedArray<u64, 32>(0n);
  const lenA = reservedDomains(m, markets, pa, asset, size, domsA);
  const lenB = reservedDomains(m, markets, pb, asset, -size, domsB);
  ensureDeltaCapacity(domsA, lenA, asset, posA, size);
  ensureDeltaCapacity(domsB, lenB, asset, posB, -size);
}

/**
 * The rest of `handle_trade_nocpi_zero_copy` from the snapshots on (kept apart for its locals' frame).
 *
 * @noinline
 */
function tradeAfterChecks(
  m: RemainingAccount,
  markets: u64,
  at: u64,
  pa: RemainingAccount,
  pb: RemainingAccount,
  asset: u64,
  size: i128,
  sizeAbs: u128,
  basis: u64,
  quote: FeeQuote,
  capA: u64,
  capB: u64,
  synced: boolean,
): void {
  const beforeA: DomainSnapshot = { domains: fixedArray<u32, 32>(0n), backing: fixedArray<u128, 32>(0n), lien: fixedArray<u128, 32>(0n), len: 0n };
  const beforeB: DomainSnapshot = { domains: fixedArray<u32, 32>(0n), backing: fixedArray<u128, 32>(0n), lien: fixedArray<u128, 32>(0n), len: 0n };
  snapshot(pa, beforeA);
  snapshot(pb, beforeB);
  const workA = lienRefreshWork(pa);
  const workB = lienRefreshWork(pb);
  const req: TradeRequest = { asset, size: toI128(sizeAbs), price: basis, fee_bps: quote.fee_bps };
  const fees = size > 0n ? executeTrade(m, markets, pa, pb, req) : executeTrade(m, markets, pb, pa, req);
  // ensure_trade_side_oi_cap_view (the asset is in the view).
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  require(a.oi_eff_long_q <= 100000000000000n && a.oi_eff_short_q <= 100000000000000n, PercolatorError.EngineInvalidLeg);
  const landing = authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot);
  ensureNewCounterpartyLiensFresh(m, markets, pa, beforeA, landing);
  ensureNewCounterpartyLiensFresh(m, markets, pb, beforeB, landing);
  if (loadRawAt<WrapperConfig>(m, HEADER_LEN).backing_trade_fee_policy_count !== 0n) applyBackingDomainFees(m, markets, pa, beforeA, pb, beforeB, capA, capB);
  // account_fees_to_trade_sides(size_abs, fee_a, fee_b): the long account's fee and the short's.
  creditTradeFees(m, markets, asset, fees.fee_long, fees.fee_short, quote);
  // collected_fee_supported_mark_view(profile, quote, fee_a, fee_b): the engine's fee_a is the long account's.
  const w = loadRawMutAt<AssetOracleWrapper>(m, at);
  const collected = collectedFeeSupportedMark(w.profile.mark_ewma_e6, quote, fees.fee_long, fees.fee_short);
  updateMarkAfterTrade(m, markets, w.profile, asset, collected);
  const staged = stageTradeDrivenTarget(m, markets, w.profile, asset);
  // write_oracle_profile_to_view: validated (the slot is in the view).
  validateAssetOracleProfile(w.profile);
  const mirror = asset === 0n && isPriceManaged(w.profile);
  if (!staged) checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  // The lien bounds: the occupied-domain growth (A, B), the refresh work (A, B), the full rate of each domain whose
  // effective lien reserve grew (A's, then B's).
  const afterA = occupiedCount(pa);
  const afterB = occupiedCount(pb);
  require(!(afterA > beforeA.len && afterA > MAX_BOUNDED_SOURCE_DOMAINS), PercolatorError.InvalidInstruction);
  require(!(afterB > beforeB.len && afterB > MAX_BOUNDED_SOURCE_DOMAINS), PercolatorError.InvalidInstruction);
  const afterWorkA = lienRefreshWork(pa);
  require(!(afterWorkA > workA && afterWorkA > MAX_LIEN_REFRESH_WORK), PercolatorError.InvalidInstruction);
  const afterWorkB = lienRefreshWork(pb);
  require(!(afterWorkB > workB && afterWorkB > MAX_LIEN_REFRESH_WORK), PercolatorError.InvalidInstruction);
  ensureGrownLiensFullRate(m, markets, pa, beforeA);
  ensureGrownLiensFullRate(m, markets, pb, beforeB);
  bumpPositionEpoch(pa);
  bumpPositionEpochWithMatcherState(pb, synced);
  // The wrapper config written back last (`state::write_wrapper_config`: the market's header, the config validated).
  if (mirror) {
    const p = loadRawAt<AssetOracleProfile>(m, at);
    const c = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
    c.mark_ewma_e6 = p.mark_ewma_e6;
    c.mark_ewma_last_slot = p.mark_ewma_last_slot;
    c.oracle_target_price_e6 = p.oracle_target_price_e6;
    validateWrapperConfig(c);
  }
}

/** The number of occupied source domains (the length of an after-trade snapshot). */
export function occupiedCount(pa: RemainingAccount): u64 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  let n = 0n;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) if (domainIsOccupied(p.source_domains.get(slot))) n += 1n;
  return n;
}

/** `ensure_new_source_lien_domains_full_rate_for_trade_view` for one portfolio: each occupied domain whose effective lien
 * reserve grew over the snapshot at the full credit rate. */
export function ensureGrownLiensFullRate(m: RemainingAccount, markets: u64, pa: RemainingAccount, before: DomainSnapshot): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = p.source_domains.get(slot);
    if (!domainIsOccupied(s)) continue;
    const d = toU64(s.domain);
    if (s.source_lien_effective_reserved > lookupValue(before, d, true)) ensureFullRate(m, markets, d);
  }
}

/**
 * `ensure_trade_portfolio_current_for_requests_view(group, portfolio, [request])`: a portfolio with legs that touches the
 * trade's asset (`portfolio_has_active_asset_view`: the asset in the view, EngineInvalidConfig; an asset with stored
 * legs and an active leg of it with its market id), whose certificate (decoded) names legs and requirements and covers
 * 8 legs or more, must not be B-stale (EngineBStale) or stale (EngineStale) and its certificate must be current
 * (EngineStale). Smaller portfolios are left to the engine.
 */
export function ensureTradePortfolioCurrent(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64): void {
  if (loadRawAt<Portfolio>(pa, HEADER_LEN).active_bitmap.get(0n) === 0n) return;
  if (!portfolioHasActiveAsset(m, markets, pa, asset)) return;
  requireLargeCertCurrent(m, pa);
}

/** `ensure_trade_portfolio_current_for_requests_view(group, portfolio, requests[..n])`: as for one request, the
 * portfolio touching any request's asset (judged in order, the first that touches ends the scan). */
export function ensureTradePortfolioCurrentFor(m: RemainingAccount, markets: u64, pa: RemainingAccount, reqs: FixedArray<BatchRequest, 16>, n: u64): void {
  if (loadRawAt<Portfolio>(pa, HEADER_LEN).active_bitmap.get(0n) === 0n) return;
  let touches = false;
  for (let i = 0n; i < n && !touches; i++) touches = portfolioHasActiveAsset(m, markets, pa, reqs.get(i).asset);
  if (!touches) return;
  requireLargeCertCurrent(m, pa);
}

/** `portfolio_has_active_asset_view(group, portfolio, asset)`: the asset in the view (EngineInvalidConfig); an asset
 * with stored legs and an active leg of it with its market id (each leg decoded up to it). */
export function portfolioHasActiveAsset(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64): boolean {
  require(asset < markets, PercolatorError.EngineInvalidConfig);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  if (a.stored_pos_count_long === 0n && a.stored_pos_count_short === 0n) return false;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active === 1n && toU64(leg.asset_index) === asset && leg.market_id === a.market_id) return true;
  }
  return false;
}

/** The rest of `ensure_trade_portfolio_current_for_requests_view` for a portfolio that touches a request's asset: a
 * certificate (decoded) that names legs and requirements and covers 8 legs or more must not be B-stale (EngineBStale)
 * or stale (EngineStale) and must be current (EngineStale). */
function requireLargeCertCurrent(m: RemainingAccount, pa: RemainingAccount): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const c = p.health_cert;
  checkV16(healthCertErr(c));
  const certBitmap = c.active_bitmap_at_cert.get(0n);
  if (certBitmap === 0n || (c.certified_initial_req === 0n && c.certified_maintenance_req === 0n && c.certified_worst_case_loss === 0n)) return;
  let ones = 0n;
  let b = certBitmap;
  while (b !== 0n) {
    ones += b & 1n;
    b >>= 1n;
  }
  if (ones < 8n) return;
  require(p.b_stale_state === 0n, PercolatorError.EngineBStale);
  require(p.stale_state === 0n, PercolatorError.EngineStale);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(c.valid === 1n &&
    c.cert_oracle_epoch === h.oracle_epoch &&
    c.cert_funding_epoch === h.funding_epoch &&
    c.cert_risk_epoch === h.risk_epoch &&
    c.cert_asset_set_epoch === h.asset_set_epoch &&
    certBitmap === p.active_bitmap.get(0n), PercolatorError.EngineStale);
}

/**
 * `apply_backing_domain_fees_after_trade_view(cfg, group, A, before_a, B, before_b, Some(cap), Some(cap))`: each
 * portfolio's fees collected (A first: `DomainFeeTotals`, here a snapshot whose two values are the provider's and the
 * insurance's fee), nothing when both are zero, then charged per domain (A's, then B's), the market's shape and both
 * portfolios validated with it.
 *
 * @noinline
 */
function applyBackingDomainFees(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  beforeA: DomainSnapshot,
  pb: RemainingAccount,
  beforeB: DomainSnapshot,
  capA: u64,
  capB: u64,
): void {
  const feesA: DomainSnapshot = { domains: fixedArray<u32, 32>(0n), backing: fixedArray<u128, 32>(0n), lien: fixedArray<u128, 32>(0n), len: 0n };
  const feesB: DomainSnapshot = { domains: fixedArray<u32, 32>(0n), backing: fixedArray<u128, 32>(0n), lien: fixedArray<u128, 32>(0n), len: 0n };
  const a = collectBackingFees(m, markets, pa, beforeA, capA, feesA);
  const b = collectBackingFees(m, markets, pb, beforeB, capB, feesB);
  if (a === 0n && b === 0n) return;
  for (let i = 0n; i < feesA.len; i++) {
    if (feesA.backing.get(i) === 0n && feesA.lien.get(i) === 0n) continue;
    chargeAccountBackingFee(m, markets, pa, toU64(feesA.domains.get(i)), feesA.backing.get(i), feesA.lien.get(i));
  }
  for (let i = 0n; i < feesB.len; i++) {
    if (feesB.backing.get(i) === 0n && feesB.lien.get(i) === 0n) continue;
    chargeAccountBackingFee(m, markets, pb, toU64(feesB.domains.get(i)), feesB.backing.get(i), feesB.lien.get(i));
  }
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, pa, markets);
  validateWithMarket(m, pb, markets);
  require(a <= U128_MAX_TR - b, PercolatorError.EngineArithmeticOverflow);
}

/**
 * `credit_trade_fees_with_mark_externality_view(cfg, group, asset, fee_long, fee_short, quote)`: the mark-externality part
 * of the fees (beyond the base fee paid) split between the sides and kept outside the budgets; the rest of each side's
 * fee credited to its domain's budget (`credit_fee_to_domain_budget_view`: for an asset other than 0 the redirect share
 * to market 0's budgets, half long and the rest short).
 */
function creditTradeFees(m: RemainingAccount, markets: u64, asset: u64, feeLong: u128, feeShort: u128, quote: FeeQuote): void {
  let budgetLong = feeLong;
  let budgetShort = feeShort;
  if (quote.externality !== 0n) {
    require(feeLong <= U128_MAX_TR - feeShort, PercolatorError.EngineArithmeticOverflow);
    const total = feeLong + feeShort;
    const markFee = total > quote.base_fee_paid ? total - quote.base_fee_paid : 0n;
    if (markFee !== 0n) {
      let markLong = markFee / 2n;
      let markShort = markFee - markLong;
      if (markLong > feeLong) {
        const over = markLong - feeLong;
        markLong = feeLong;
        markShort += over;
      }
      if (markShort > feeShort) {
        const over = markShort - feeShort;
        markShort = feeShort;
        markLong += over;
      }
      require(!(markLong > feeLong || markShort > feeShort), PercolatorError.EngineCounterUnderflow);
      budgetLong = feeLong - markLong;
      budgetShort = feeShort - markShort;
    }
  }
  creditFeeToDomain(m, markets, asset * 2n, budgetLong);
  creditFeeToDomain(m, markets, asset * 2n + 1n, budgetShort);
}

/** `credit_fee_to_domain_budget_view(cfg, group, domain, amount)`. */
function creditFeeToDomain(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  if (amount === 0n) return;
  let redirect: u128 = 0n;
  if (domain / 2n !== 0n) redirect = mulDivByU64(amount, toU64(loadRawAt<WrapperConfig>(m, HEADER_LEN).fee_redirect_to_market_0_bps), 10000n, false);
  creditDomainInsuranceBudget(m, markets, domain, amount - redirect);
  if (redirect === 0n) return;
  const long = redirect / 2n;
  creditDomainInsuranceBudget(m, markets, 0n, long);
  creditDomainInsuranceBudget(m, markets, 1n, redirect - long);
}

/** `policy_v16::collected_fee_supported_mark(old, quoted, base_paid, externality, fee_a, fee_b)`: the quoted mark,
 * clamped to the move the matched externality fees of both sides pay for. */
export function collectedFeeSupportedMark(old: u64, quote: FeeQuote, feeA: u128, feeB: u128): u64 {
  if (quote.post_trade_mark === 0n || quote.externality === 0n) return quote.post_trade_mark;
  const perSide = quote.base_fee_paid / 2n;
  const extA = feeA > perSide ? feeA - perSide : 0n;
  const extB = feeB > perSide ? feeB - perSide : 0n;
  const matched = extA < extB ? extA : extB;
  require(matched <= U128_MAX_TR / 2n, PercolatorError.EngineArithmeticOverflow);
  require(matched * 2n <= U128_MAX_TR / 10000n, PercolatorError.EngineArithmeticOverflow);
  const supported = (matched * 2n * 10000n) / quote.externality;
  return clampTowardEngineDt(old, quote.post_trade_mark, supported > toU128(U64_MAX_TR) ? U64_MAX_TR : toU64(supported), 1n);
}

/**
 * `update_hybrid_mark_after_trade_view(profile, group, asset, mark)`: for a profile the trade moves (EWMA, matured
 * hybrid) on a configured asset, a nonzero mark (OracleInvalid past MAX_ORACLE_PRICE) other than the EWMA's recorded
 * as a funding-mark transition at the asset's slot (EngineStale), the EWMA set at the Clock, a hybrid's provenance
 * trade-driven.
 */
export function updateMarkAfterTrade(m: RemainingAccount, markets: u64, p: Inout<AssetOracleProfile>, asset: u64, mark: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const now = authenticatedMarketSlot(h.current_slot);
  if (!updatesMarkFromTrade(p, now) || asset >= toU64(h.config.max_market_slots)) return;
  if (mark === 0n) return;
  require(mark <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  if (mark === p.mark_ewma_e6) return;
  const assetSlot = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.slot_last;
  advanceCheckpointLocal(p, assetSlot);
  if (p.funding_mark_e6 !== 0n) {
    if (p.funding_mark_pending_e6 !== 0n) {
      require(now >= p.funding_mark_pending_slot, PercolatorError.EngineStale);
      if (now === p.funding_mark_pending_slot) p.funding_mark_pending_e6 = mark;
    } else if (now <= assetSlot) p.funding_mark_e6 = mark;
    else {
      p.funding_mark_pending_e6 = mark;
      p.funding_mark_pending_slot = now;
    }
  }
  p.mark_ewma_e6 = mark;
  p.mark_ewma_last_slot = now;
  if (isHybrid(p)) p.effective_price_provenance = EFFECTIVE_PRICE_PROVENANCE_TRADE_DRIVEN;
}

/**
 * `stage_trade_driven_mark_target_view(profile, group, asset)`: for an EWMA or hybrid profile the trade moves, the
 * oracle target set to the mark; a target that differs from the asset's raw one (the asset in the view:
 * InvalidInstruction) resets the price-move remainder and is staged on the asset (`set_asset_raw_oracle_target_not_atomic`,
 * map_v16_error). Returns whether a target was staged.
 */
function stageTradeDrivenTarget(m: RemainingAccount, markets: u64, p: Inout<AssetOracleProfile>, asset: u64): boolean {
  if (!prepareTradeDrivenTarget(m, markets, p, asset)) return false;
  setAssetRawOracleTarget(m, markets, asset, p.oracle_target_price_e6);
  return true;
}

/**
 * `prepare_trade_driven_mark_target_view(profile, group, asset)`: for an EWMA or hybrid profile the trade moves, the
 * oracle target set to the mark; a target that differs from the asset's raw one (the asset in the view:
 * InvalidInstruction) resets the price-move remainder and is to be staged (true).
 */
export function prepareTradeDrivenTarget(m: RemainingAccount, markets: u64, p: Inout<AssetOracleProfile>, asset: u64): boolean {
  if (p.oracle_mode !== ORACLE_MODE_EWMA_MARK && !isHybrid(p)) return false;
  const now = authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot);
  if (!updatesMarkFromTrade(p, now)) return false;
  p.oracle_target_price_e6 = p.mark_ewma_e6;
  require(asset < markets, PercolatorError.InvalidInstruction);
  if (loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.raw_oracle_target_price === p.oracle_target_price_e6) return false;
  // reset_price_move_remainder_on_target_change_view: the target differs (just checked).
  p.price_move_remainder_bps_num = 0n;
  return true;
}
