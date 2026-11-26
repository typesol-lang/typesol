// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The engine code the first instructions reach (InitMarket, InitPortfolio, Deposit, ClosePortfolio and the policy and
// ledger instructions): `V16Config::validate_public_user_fund` (the shape check is wire.ts `configShapeErr`; the exact
// solvency envelope is here), `MarketGroupV16View::validate_shape` and its aggregate totals,
// `PortfolioV16View::validate_with_market` with everything it calls (the source-credit shape, the close-progress
// ledger, the resolved-payout receipt, the active legs), `SourceCreditStateV16Account::try_to_runtime`
// (`validate_source_credit_state_static`), `PortfolioV16ViewMut::new` (`compact_source_domains`),
// `register_` / `deregister_empty_materialized_portfolio_not_atomic` (with `is_empty_for_dematerialization`),
// `deposit_not_atomic`, and `domain_insurance_budget_remaining`.
//
// Errors. The original returns `Result<_, V16Error>` and its callers map the error (`map_v16_error` in the processor,
// `map_account_wire_error` in `mod state`). A function below that the original calls from sites with different
// mappings returns its V16Error as a value (errors.ts, 0 for success): the config and market-shape checks
// (`…Err`). One returns a value because a caller looks at the error: `deregisterEmptyPortfolio` (NOTES.md site 1,
// SyncMaintenanceFee keeps going on LockActive). Everything else fails in place with the mapping every caller of it
// uses (`failV16` / `checkV16`, `map_v16_error`).
//
// The market and the portfolio are views of the account data, changed in place as the original changes them (its
// `MarketGroupV16ViewMut` and `PortfolioV16ViewMut` are views too). The helpers take the accounts and bind the views
// themselves: a view passed to a helper that also takes accounts would be copied.
import {
  type FixedArray,
  type Inout,
  type RemainingAccount,
  type u8,
  type u64,
  type u128,
  type u256,
  fixedArray,
  loadRawAt,
  loadRawMutAt,
  require,
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
  V16_OK,
  V16_PROVENANCE_MISMATCH,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type AssetState,
  type Config,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type PortfolioLeg,
  type PortfolioSourceDomain,
  type SourceCreditState,
  ASSET_ORACLE_WRAPPER_LEN,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  MAX_ORACLE_PRICE,
  dynamicSlotOffset,
} from "./state.js";
import {
  ADL_ONE,
  BOUND_SCALE,
  I128_MIN,
  V16_ACCOUNT_VERSION,
  V16_LAYOUT_DISCRIMINATOR,
  V16_MAX_PORTFOLIO_ASSETS_N,
  assetStateErr,
  boolErr,
  closeProgressErr,
  configShapeErr,
  marketModeErr,
  nonMinI128Err,
  optionalRecoveryReasonErr,
  portfolioLegDecodeErr,
  resolvedPayoutLedgerErr,
  resolvedPayoutReceiptErr,
} from "./wire.js";

// ---- Engine constants (src/lib.rs, src/v16.rs) -----------------------------------------------------------------------

export const MAX_VAULT_TVL: u128 = 10000000000000000n;
export const MAX_ACCOUNT_NOTIONAL: u128 = 100000000000000000000n;
export const FUNDING_DEN: u128 = 1000000000n;
export const CREDIT_RATE_SCALE: u128 = 1000000000000n;
export const MIN_A_SIDE: u128 = 100000000000000n;
export const SOCIAL_LOSS_DEN: u128 = 1000000000000000000000n;
/** SOCIAL_WEIGHT_SCALE = ADL_ONE. */
export const SOCIAL_WEIGHT_SCALE: u128 = 1000000000000000n;
export const MAX_POSITION_ABS_Q: u128 = 100000000000000n;
/** 2 × V16_MAX_PORTFOLIO_ASSETS_N: a portfolio's sparse source-domain slots. */
export const PORTFOLIO_SOURCE_DOMAIN_CAP = 32n;
/** AssetLifecycleV16 bytes. */
export const LIFECYCLE_ACTIVE = 2n;
export const LIFECYCLE_DRAIN_ONLY = 3n;
export const LIFECYCLE_RETIRED = 4n;
export const LIFECYCLE_RECOVERY = 5n;
/** SideModeV16::ResetPending. */
const SIDE_MODE_RESET_PENDING = 2n;
/** MarketModeV16::Resolved. */
export const MARKET_MODE_RESOLVED = 1n;

const U64_MAX_E = 0xffffffffffffffffn;
const U128_MAX_E: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MAX_E: u128 = 0x7fffffffffffffffffffffffffffffffn;
/** The envelope's failure, carried in a u256 result (every refusal of the envelope is InvalidConfig). */
/** 2^128 - 1 as a u256. */
const U128_MAX_W: u256 = 340282366920938463463374607431768211455n;
const ENVELOPE_ERR: u256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;

// ---- validate_exact_solvency_envelope ----------------------------------------------------------------------------------
//
// U256 arithmetic of the original. Every product it forms fits 256 bits (each factor is below 2^128, or the product of
// u64 configuration values and constants: at most about 2^218 in `validate_funding_headroom`), so its `checked_mul`s
// never refuse and TypeSOL's exact u256 gives the same values; the narrowing `try_into_u128` checks are kept.

/** `ceil_div_u256_to_u128`: ⌈n / d⌉, InvalidConfig for d = 0 or a quotient past u128. */
function ceilDivU256ToU128(n: u256, d: u256): u256 {
  if (d === 0n) return ENVELOPE_ERR;
  const q = n / d;
  const c = n % d === 0n ? q : q + 1n;
  return c > U128_MAX_W ? ENVELOPE_ERR : c;
}

/**
 * `checked_mul_div_ceil_to_u128`: ⌈a·b / d⌉, InvalidConfig for d = 0 or a quotient past u128. The original's u128
 * fast path (the product fits u128) is kept for its cost; its result is the u256 path's.
 */
function mulDivCeilToU128(a: u128, b: u128, d: u128): u256 {
  if (d === 0n) return ENVELOPE_ERR;
  if (b === 0n || a <= U128_MAX_E / b) {
    const p = a * b;
    const q = p / d;
    return toU256(p % d === 0n ? q : q + 1n);
  }
  const p = toU256(a) * toU256(b);
  const q = p / toU256(d);
  const c = p % toU256(d) === 0n ? q : q + 1n;
  return c > U128_MAX_W ? ENVELOPE_ERR : c;
}

/** `solvency_envelope_total_for_notional`: the loss budget of `n` plus the clamped liquidation fee. */
function envelopeTotal(c: Config, n: u128, lossNum: u128, lossDen: u128, priceBps: u128): u256 {
  const loss = mulDivCeilToU128(n, lossNum, lossDen);
  if (loss === ENVELOPE_ERR) return ENVELOPE_ERR;
  if (priceBps > U128_MAX_E - 10000n) return ENVELOPE_ERR;
  const worstLiqNotional = mulDivCeilToU128(n, 10000n + priceBps, 10000n);
  if (worstLiqNotional === ENVELOPE_ERR) return ENVELOPE_ERR;
  const raw = mulDivCeilToU128(toU128(worstLiqNotional), toU128(c.liquidation_fee_bps), 10000n);
  if (raw === ENVELOPE_ERR) return ENVELOPE_ERR;
  const atLeast = toU128(raw) > c.min_liquidation_abs ? toU128(raw) : c.min_liquidation_abs;
  const fee = atLeast < c.liquidation_fee_cap ? atLeast : c.liquidation_fee_cap;
  if (toU128(loss) > U128_MAX_E - fee) return ENVELOPE_ERR;
  return loss + toU256(fee);
}

/** `maintenance_requirement_for_notional`: max(⌈n·mm / 10,000⌉, min_nonzero_mm_req). */
function maintenanceRequirement(c: Config, n: u128): u256 {
  const prop = mulDivCeilToU128(n, toU128(c.maintenance_margin_bps), 10000n);
  if (prop === ENVELOPE_ERR) return ENVELOPE_ERR;
  return toU128(prop) > c.min_nonzero_mm_req ? prop : toU256(c.min_nonzero_mm_req);
}

/** `solvency_envelope_holds_for_notional` (0 false, 1 true) or `interval_certifies` (the total at `hi` against the requirement at `lo`); 2 for InvalidConfig. */
function envelopeHolds(c: Config, lo: u128, hi: u128, lossNum: u128, lossDen: u128, priceBps: u128): u64 {
  const total = envelopeTotal(c, hi, lossNum, lossDen, priceBps);
  if (total === ENVELOPE_ERR) return 2n;
  const mm = maintenanceRequirement(c, lo);
  if (mm === ENVELOPE_ERR) return 2n;
  return total <= mm ? 1n : 0n;
}

/**
 * `validate_solvency_envelope_range`: certify [lo, hi] by bisection, intervals of at most 64 notionals checked one by
 * one; at most 4,096 steps and 96 pending intervals. The original keeps a stack of (lo, hi) pairs; the stack only ever
 * holds right halves whose `hi` is the `lo` of the entry below it minus one (the bottom one's `hi` is the range's), so
 * the port keeps the `lo`s alone: the same intervals in the same order, half the stack.
 */
/** @noinline */
function envelopeRangeOk(c: Config, lo: u128, hi: u128, lossNum: u128, lossDen: u128, priceBps: u128): boolean {
  if (lo > hi) return true;
  const los = fixedArray<u128, 96>(0n);
  let len = 1n;
  let steps = 0n;
  los.set(0n, lo);
  while (len !== 0n) {
    steps += 1n;
    if (steps > 4096n) return false;
    len -= 1n;
    const rangeLo = los.get(len);
    const rangeHi = len === 0n ? hi : los.get(len - 1n) - 1n;
    const certifies = envelopeHolds(c, rangeLo, rangeHi, lossNum, lossDen, priceBps);
    if (certifies === 2n) return false;
    if (certifies === 1n) continue;
    if (rangeHi === rangeLo || rangeHi - rangeLo <= 64n) {
      let n = rangeLo;
      while (true) {
        const holds = envelopeHolds(c, n, n, lossNum, lossDen, priceBps);
        if (holds !== 1n) return false;
        if (n === rangeHi) break;
        n += 1n;
      }
      continue;
    }
    const mid = rangeLo + (rangeHi - rangeLo) / 2n;
    if (len + 2n > 96n) return false;
    // (mid + 1, rangeHi), then (rangeLo, mid) on top: the right half's hi is implied by the entry below it.
    los.set(len, mid + 1n);
    los.set(len + 1n, rangeLo);
    len += 2n;
  }
  return true;
}

/** `validate_funding_headroom`: ADL_ONE · MAX_ORACLE_PRICE · rate · slots within i128::MAX. */
function fundingHeadroomOk(rate: u64, slots: u64): boolean {
  const headroom = toU256(ADL_ONE) * toU256(MAX_ORACLE_PRICE) * toU256(rate) * toU256(slots);
  return headroom <= toU256(I128_MAX_E);
}

/** `V16Config::validate_exact_solvency_envelope`, every refusal InvalidConfig. */
export function solvencyEnvelopeOk(c: Config): boolean {
  const priceBudgetFast = toU128(c.max_price_move_bps_per_slot) * toU128(c.max_accrual_dt_slots);
  if (
    c.maintenance_margin_bps === 10000n &&
    priceBudgetFast <= 10000n &&
    c.max_abs_funding_e9_per_slot === 0n &&
    c.liquidation_fee_bps === 0n &&
    c.min_liquidation_abs === 0n
  )
    return true;
  if (!fundingHeadroomOk(c.max_abs_funding_e9_per_slot, c.max_accrual_dt_slots)) return false;
  if (!fundingHeadroomOk(c.max_abs_funding_e9_per_slot, c.min_funding_lifetime_slots)) return false;
  const dt = toU256(c.max_accrual_dt_slots);
  const priceBps = toU128(c.max_price_move_bps_per_slot) * toU128(c.max_accrual_dt_slots);
  const fundingNum = toU256(c.max_abs_funding_e9_per_slot) * dt * 10000n;
  const lossNumWide = toU256(priceBps) * toU256(FUNDING_DEN) + fundingNum;
  const lossDenWide = toU256(10000n) * toU256(FUNDING_DEN);
  const fundingBpsCeil = ceilDivU256ToU128(fundingNum, toU256(FUNDING_DEN));
  if (fundingBpsCeil === ENVELOPE_ERR) return false;
  if (priceBps > U128_MAX_E - toU128(fundingBpsCeil)) return false;
  const lossBpsCeil = priceBps + toU128(fundingBpsCeil);
  if (priceBps > U128_MAX_E - 10000n) return false;
  const worstLiqBpsCeil = ceilDivU256ToU128(toU256(10000n + priceBps) * toU256(c.liquidation_fee_bps), 10000n);
  if (worstLiqBpsCeil === ENVELOPE_ERR) return false;
  if (lossBpsCeil > U128_MAX_E - toU128(worstLiqBpsCeil)) return false;
  const linearBps = lossBpsCeil + toU128(worstLiqBpsCeil);
  const mm = toU128(c.maintenance_margin_bps);
  if (c.maintenance_margin_bps === 10000n && lossBpsCeil === 10000n && worstLiqBpsCeil === 0n && c.min_liquidation_abs === 0n) return true;
  if (lossNumWide > U128_MAX_W || lossDenWide > U128_MAX_W) return false;
  const lossNum = toU128(lossNumWide);
  const lossDen = toU128(lossDenWide);
  const domainMax = MAX_ACCOUNT_NOTIONAL;
  if (mm === 0n) return envelopeHolds(c, domainMax, domainMax, lossNum, lossDen, priceBps) === 1n;
  const floorMaxWide = (toU256(c.min_nonzero_mm_req) * 10000n) / toU256(mm);
  if (floorMaxWide > U128_MAX_W) return false;
  const floorMax = toU128(floorMaxWide);
  const floorEnd = floorMax < domainMax ? floorMax : domainMax;
  if (floorEnd !== 0n) {
    const holds = envelopeHolds(c, floorEnd, floorEnd, lossNum, lossDen, priceBps);
    if (holds === 2n) return false;
    if (holds === 0n) return false;
  }
  if (floorMax >= domainMax) return true;
  const exactStart = floorEnd + 1n;
  if (linearBps < mm) {
    const tailLinear = ceilDivU256ToU128(30000n, toU256(mm - linearBps));
    if (tailLinear === ENVELOPE_ERR) return false;
    if (lossBpsCeil > mm) return false;
    const lossGap = mm - lossBpsCeil;
    if (c.min_liquidation_abs > U128_MAX_E - 2n) return false;
    const tailFee = ceilDivU256ToU128(toU256(c.min_liquidation_abs + 2n) * 10000n, toU256(lossGap));
    if (tailFee === ENVELOPE_ERR) return false;
    const tail = toU128(tailLinear > tailFee ? tailLinear : tailFee);
    if (tail <= exactStart) return true;
    const end = tail - 1n < domainMax ? tail - 1n : domainMax;
    return envelopeRangeOk(c, exactStart, end, lossNum, lossDen, priceBps);
  }
  if (lossBpsCeil >= mm) return envelopeRangeOk(c, exactStart, domainMax, lossNum, lossDen, priceBps);
  if (c.liquidation_fee_cap > U128_MAX_E - 3n) return false;
  const tailWide = ceilDivU256ToU128(toU256(c.liquidation_fee_cap + 3n) * 10000n, toU256(mm - lossBpsCeil));
  if (tailWide === ENVELOPE_ERR) return false;
  const tail = toU128(tailWide);
  if (tail <= exactStart) return true;
  const end = tail - 1n < domainMax ? tail - 1n : domainMax;
  return envelopeRangeOk(c, exactStart, end, lossNum, lossDen, priceBps);
}

/** `V16ConfigAccount::try_to_runtime`: `decode_runtime`, `validate_public_user_fund` (the shape, then the envelope). */
export function configFullErr(c: Config): u64 {
  const e = configShapeErr(c);
  if (e !== V16_OK) return e;
  return solvencyEnvelopeOk(c) ? V16_OK : V16_INVALID_CONFIG;
}

// ---- Bound numbers (V16Core) -------------------------------------------------------------------------------------------

/** `amount_from_bound_num`: ⌈n / BOUND_SCALE⌉ (its checked_add cannot overflow after the division). */
export function amountFromBoundNum(n: u128): u128 {
  const whole = n / BOUND_SCALE;
  return n % BOUND_SCALE === 0n ? whole : whole + 1n;
}

// ---- MarketGroupV16View::validate_shape ----------------------------------------------------------------------------------

/**
 * `MarketGroupV16View::validate_shape` (the audit scan is a feature the program does not enable), `markets` being
 * the view's slot count (the capacity the account's length gives).
 */
export function marketShapeErr(h: GroupHeader, markets: u64): u64 {
  if (markets !== toU64(h.asset_slot_capacity) || h.asset_slot_capacity < h.config.max_market_slots) return V16_INVALID_CONFIG;
  let e = configShapeErr(h.config);
  if (e === V16_OK) e = boolErr(h.bankruptcy_hlock_active);
  if (e === V16_OK) e = boolErr(h.threshold_stress_active);
  if (e === V16_OK) e = boolErr(h.loss_stale_active);
  if (e === V16_OK) e = boolErr(h.payout_snapshot_captured);
  if (e === V16_OK) e = optionalRecoveryReasonErr(h.recovery_reason);
  if (e === V16_OK) e = resolvedPayoutLedgerErr(h.resolved_payout_ledger);
  if (e !== V16_OK) return e;
  if (h.vault > MAX_VAULT_TVL) return V16_INVALID_CONFIG;
  if (h.c_tot > h.vault || h.insurance > h.vault) return V16_INVALID_CONFIG;
  if (h.pnl_matured_pos_tot > h.pnl_pos_tot || h.pnl_pos_bound_tot < h.pnl_pos_tot || h.slot_last > h.current_slot || h.next_market_id === 0n)
    return V16_INVALID_CONFIG;
  if (h.pnl_pos_bound_tot !== amountFromBoundNum(h.pnl_pos_bound_tot_num)) return V16_INVALID_CONFIG;
  // bound_num_from_amount(pnl_pos_tot): checked_mul (ArithmeticOverflow).
  if (h.pnl_pos_tot > U128_MAX_E / BOUND_SCALE) return V16_ARITHMETIC_OVERFLOW;
  if (h.pnl_pos_bound_tot_num < h.pnl_pos_tot * BOUND_SCALE) return V16_INVALID_CONFIG;
  const l = h.resolved_payout_ledger;
  const ledgerEmpty =
    l.snapshot_residual === 0n &&
    l.terminal_claim_exact_receipts_num === 0n &&
    l.terminal_claim_bound_unreceipted_num === 0n &&
    l.current_payout_rate_num === 0n &&
    l.current_payout_rate_den === 0n &&
    l.snapshot_slot === 0n &&
    l.payout_halted === 0n &&
    l.finalized === 0n;
  if (h.payout_snapshot_captured === 0n && !ledgerEmpty) return V16_INVALID_CONFIG;
  if (h.asset_activation_count === 0n) {
    if (h.last_asset_activation_slot !== 0n) return V16_INVALID_CONFIG;
  } else if (h.last_asset_activation_slot > h.current_slot) return V16_INVALID_CONFIG;
  // validate_header_aggregate_totals.
  if (h.c_tot > U128_MAX_E - h.insurance) return V16_ARITHMETIC_OVERFLOW;
  if (h.c_tot + h.insurance > U128_MAX_E - h.backing_provider_earnings_total) return V16_ARITHMETIC_OVERFLOW;
  const senior = h.c_tot + h.insurance + h.backing_provider_earnings_total;
  if (senior > h.vault) return V16_INVALID_CONFIG;
  const fresh = h.source_fresh_backing_total_num / BOUND_SCALE;
  if (senior > U128_MAX_E - fresh) return V16_ARITHMETIC_OVERFLOW;
  if (senior + fresh > h.vault) return V16_INVALID_CONFIG;
  if (h.source_insurance_credit_reserved_total_atoms > h.insurance || h.insurance_domain_budget_remaining_total > h.insurance)
    return V16_INVALID_CONFIG;
  if (h.pnl_pos_bound_tot_num < h.source_claim_bound_total_num) return V16_INVALID_CONFIG;
  return V16_OK;
}

// ---- SourceCreditStateV16Account::try_to_runtime ---------------------------------------------------------------------

/** `validate_bound_num_atom_aligned`. */
function atomAligned(n: u128): boolean {
  return n === 0n || n % BOUND_SCALE === 0n;
}

/**
 * `V16Core::validate_source_credit_state_static`: the shape (`validate_source_credit_state_shape_static`: EMPTY, or
 * three insurance amounts atom-aligned, the claim and rate bounds, the available backing), then the stored credit rate
 * equal to the one the state implies (`expected_source_credit_rate_num_for_state`).
 */
export function sourceCreditErr(s: SourceCreditState): u64 {
  const e = sourceCreditShapeErr(s);
  if (e !== V16_OK || sourceCreditEmpty(s)) return e;
  const available = sourceAvailableBacking(s);
  // expected_source_credit_rate_num_for_state (its own shape check and available backing pass: they just did).
  let expected = CREDIT_RATE_SCALE;
  if (s.positive_claim_bound_num !== 0n && available === 0n) expected = 0n;
  else if (s.positive_claim_bound_num !== 0n) {
    if (s.valid_liened_backing_num > U128_MAX_E - s.valid_liened_insurance_num) return V16_ARITHMETIC_OVERFLOW;
    const covered = s.valid_liened_backing_num + s.valid_liened_insurance_num;
    const unliened = s.positive_claim_bound_num > covered ? s.positive_claim_bound_num - covered : 0n;
    if (available < unliened) expected = toU128((toU256(available) * toU256(CREDIT_RATE_SCALE)) / toU256(unliened));
  }
  return s.credit_rate_num === expected ? V16_OK : V16_INVALID_CONFIG;
}

/** `SourceCreditStateV16::EMPTY` (every amount zero, the rate CREDIT_RATE_SCALE, epoch 0). */
export function sourceCreditEmpty(s: SourceCreditState): boolean {
  return (
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
    s.credit_rate_num === CREDIT_RATE_SCALE &&
    s.credit_epoch === 0n
  );
}

/** `available_backing_num_for_source_credit_state` after the shape check passed (its sums fit then). */
function sourceAvailableBacking(s: SourceCreditState): u128 {
  const encumbered = s.valid_liened_insurance_num + s.impaired_liened_insurance_num;
  return s.fresh_reserved_backing_num - s.valid_liened_backing_num + (s.insurance_credit_reserved_num - encumbered);
}

/**
 * `V16Core::validate_source_credit_state_shape_static`: EMPTY, or three insurance amounts atom-aligned, the claim and
 * rate bounds, and the available backing (`available_backing_num_for_source_credit_state`).
 */
export function sourceCreditShapeErr(s: SourceCreditState): u64 {
  if (sourceCreditEmpty(s)) return V16_OK;
  if (!atomAligned(s.insurance_credit_reserved_num) || !atomAligned(s.valid_liened_insurance_num) || !atomAligned(s.impaired_liened_insurance_num))
    return V16_INVALID_CONFIG;
  if (s.exact_positive_claim_num > s.positive_claim_bound_num || s.credit_rate_num > CREDIT_RATE_SCALE || s.spent_backing_num < s.provider_receivable_num)
    return V16_INVALID_CONFIG;
  if (s.fresh_reserved_backing_num < s.valid_liened_backing_num) return V16_INVALID_CONFIG;
  if (s.valid_liened_insurance_num > U128_MAX_E - s.impaired_liened_insurance_num) return V16_ARITHMETIC_OVERFLOW;
  const encumbered = s.valid_liened_insurance_num + s.impaired_liened_insurance_num;
  if (s.insurance_credit_reserved_num < encumbered) return V16_INVALID_CONFIG;
  const freeBacking = s.fresh_reserved_backing_num - s.valid_liened_backing_num;
  const freeInsurance = s.insurance_credit_reserved_num - encumbered;
  if (freeBacking > U128_MAX_E - freeInsurance) return V16_ARITHMETIC_OVERFLOW;
  return V16_OK;
}

// ---- Market slots -----------------------------------------------------------------------------------------------------

/** The engine part of asset slot `i` (`market.markets[i].engine`); the caller has bounded `i` by the capacity. */
export function engineSlotAt(i: u64): u64 {
  return dynamicSlotOffset(i) + ASSET_ORACLE_WRAPPER_LEN;
}

/** `MarketGroupV16View::domain_insurance_budget_remaining` (`domain_asset_side`, then budget − spent). */
export function domainInsuranceBudgetRemaining(m: RemainingAccount, markets: u64, domain: u64): u128 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const asset = domain / 2n;
  if (domain >= 2n * toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  const slot = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const budget = domain % 2n === 0n ? slot.insurance_domain_budget_long : slot.insurance_domain_budget_short;
  const spent = domain % 2n === 0n ? slot.insurance_domain_spent_long : slot.insurance_domain_spent_short;
  if (budget < spent) failV16(V16_INVALID_CONFIG);
  return budget - spent;
}

// ---- Portfolio legs ------------------------------------------------------------------------------------------------------

/** `validate_active_leg`. */
function activeLegErr(l: PortfolioLeg): u64 {
  let e = nonMinI128Err(l.k_snap);
  if (e === V16_OK) e = nonMinI128Err(l.f_snap);
  if (e !== V16_OK) return e;
  let current: u128 = 0n;
  if (l.basis_pos_q !== 0n) {
    // validate_basis.
    if (l.basis_pos_q === I128_MIN) return V16_INVALID_LEG;
    const abs = l.basis_pos_q < 0n ? toU128(-l.basis_pos_q) : toU128(l.basis_pos_q);
    if (abs > MAX_POSITION_ABS_Q) return V16_INVALID_LEG;
    // loss_weight_for_basis: ⌈abs · SOCIAL_WEIGHT_SCALE / a_basis⌉ (below 2^100: it cannot leave u128).
    if (l.a_basis === 0n) return V16_INVALID_LEG;
    const p = abs * SOCIAL_WEIGHT_SCALE;
    current = p % l.a_basis === 0n ? p / l.a_basis : p / l.a_basis + 1n;
  }
  if (
    l.a_basis < MIN_A_SIDE ||
    l.a_basis > ADL_ONE ||
    l.loss_weight === 0n ||
    l.loss_weight < current ||
    l.loss_weight > SOCIAL_LOSS_DEN ||
    l.b_rem >= SOCIAL_LOSS_DEN ||
    l.b_epoch_snap !== l.epoch_snap
  )
    return V16_INVALID_LEG;
  return V16_OK;
}

/** `PortfolioLegV16Account::try_to_runtime`: the decoding, then `validate_active_leg` for an active leg. */
export function legErr(l: PortfolioLeg): u64 {
  const e = portfolioLegDecodeErr(l);
  if (e !== V16_OK) return e;
  return l.active === 1n ? activeLegErr(l) : V16_OK;
}

/** `snapshot_epoch_bound_to_side`. */
function epochBound(snap: u64, sideEpoch: u64, mode: u8): boolean {
  return snap === sideEpoch || (mode === SIDE_MODE_RESET_PENDING && snap !== U64_MAX_E && snap + 1n === sideEpoch);
}

/** `leg_snapshots_bound_to_asset_side`. */
export function legBoundToAsset(a: AssetState, l: PortfolioLeg): boolean {
  const long = l.side === 0n;
  const sideEpoch = long ? a.epoch_long : a.epoch_short;
  const kfEpoch = long ? a.kf_epoch_long : a.kf_epoch_short;
  const mode = long ? a.mode_long : a.mode_short;
  return l.kf_epoch_snap <= kfEpoch && epochBound(l.epoch_snap, sideEpoch, mode) && epochBound(l.b_epoch_snap, sideEpoch, mode);
}

/** `active_leg_slot_for_asset`: the one active leg of `asset` (HiddenLeg for two), or 16 for none. */
function activeLegSlotForAsset(p: Portfolio, asset: u64): u64 {
  let found = 16n;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active === 1n && toU64(leg.asset_index) === asset) {
      if (found !== 16n) failV16(V16_HIDDEN_LEG);
      found = slot;
    }
  }
  return found;
}

// ---- Portfolio source domains ---------------------------------------------------------------------------------------------

/** `PortfolioSourceDomainV16Account::is_occupied`. */
function domainOccupied(s: PortfolioSourceDomain): boolean {
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
function domainDefaultTag(s: PortfolioSourceDomain): boolean {
  return s.domain === 0n && s.source_claim_market_id === 0n;
}

/** `SourceCreditLienAggregateProofV16::validate` on a source domain's lien fields. */
function lienProofErr(s: PortfolioSourceDomain): u64 {
  const face = s.source_claim_liened_num;
  if (s.source_claim_counterparty_liened_num > U128_MAX_E - s.source_claim_insurance_liened_num) return V16_ARITHMETIC_OVERFLOW;
  if (s.source_claim_counterparty_liened_num + s.source_claim_insurance_liened_num !== face) return V16_INVALID_LEG;
  if (face > U128_MAX_E - s.source_claim_impaired_num) return V16_ARITHMETIC_OVERFLOW;
  if (face + s.source_claim_impaired_num > s.source_claim_bound_num) return V16_INVALID_LEG;
  if (s.source_lien_effective_reserved > amountFromBoundNum(face)) return V16_INVALID_LEG;
  if (s.source_lien_counterparty_backing_num % BOUND_SCALE !== 0n || s.source_lien_insurance_backing_num % BOUND_SCALE !== 0n) return V16_INVALID_LEG;
  if (s.source_lien_counterparty_backing_num > U128_MAX_E - s.source_lien_insurance_backing_num) return V16_ARITHMETIC_OVERFLOW;
  if (s.source_lien_effective_reserved > U128_MAX_E / BOUND_SCALE) return V16_ARITHMETIC_OVERFLOW;
  if (s.source_lien_counterparty_backing_num + s.source_lien_insurance_backing_num !== s.source_lien_effective_reserved * BOUND_SCALE)
    return V16_INVALID_LEG;
  if (s.source_lien_impaired_effective_reserved !== 0n && s.source_claim_impaired_num === 0n) return V16_INVALID_LEG;
  return V16_OK;
}

/**
 * `validate_source_credit_shape_with_market`. After `proof.validate()` the original repeats five of its checks on the
 * same values (they cannot fail then); only the fee-slot check after them is new.
 */
export function sourceCreditShapeWithMarket(m: RemainingAccount, pa: RemainingAccount): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const configured = 2n * toU64(h.config.max_market_slots);
  for (let i = 0n; i < PORTFOLIO_SOURCE_DOMAIN_CAP; i++) {
    const s = p.source_domains.get(i);
    const occupied = domainOccupied(s);
    if (domainDefaultTag(s) && !occupied) continue;
    if (!occupied) failV16(V16_HIDDEN_LEG);
    const d = toU64(s.domain);
    if (d >= configured) failV16(V16_HIDDEN_LEG);
    for (let j = 0n; j < i; j++) {
      // The domains seen so far are exactly the earlier occupied slots (an earlier slot was skipped or seen).
      const t = p.source_domains.get(j);
      if (domainOccupied(t) && t.domain === s.domain) failV16(V16_HIDDEN_LEG);
    }
    const slot = loadRawAt<EngineAssetSlot>(m, engineSlotAt(d / 2n));
    checkV16(assetStateErr(slot.asset));
    if (s.source_claim_market_id !== slot.asset.market_id) failV16(V16_HIDDEN_LEG);
    const credit = d % 2n === 0n ? slot.source_credit_long : slot.source_credit_short;
    checkV16(sourceCreditErr(credit));
    if (s.source_claim_bound_num > credit.positive_claim_bound_num) failV16(V16_INVALID_LEG);
    checkV16(lienProofErr(s));
    if ((s.source_lien_counterparty_backing_num === 0n && s.source_lien_fee_last_slot !== 0n) || s.source_lien_fee_last_slot > h.current_slot)
      failV16(V16_INVALID_LEG);
  }
}

/**
 * `PortfolioV16ViewMut::new`'s `compact_source_domains`: the occupied slots moved to the front in order, the rest
 * zeroed, then an insertion sort by domain if they were out of order. It runs whenever the original takes a mutable
 * portfolio view (`portfolio_view_mut_for_market_slots`).
 */
export function compactSourceDomains(doms: Inout<FixedArray<PortfolioSourceDomain, 32>>): void {
  const zero: PortfolioSourceDomain = {
    domain: 0n,
    source_claim_market_id: 0n,
    source_claim_bound_num: 0n,
    source_claim_liened_num: 0n,
    source_claim_counterparty_liened_num: 0n,
    source_claim_insurance_liened_num: 0n,
    source_lien_effective_reserved: 0n,
    source_lien_counterparty_backing_num: 0n,
    source_lien_insurance_backing_num: 0n,
    source_lien_fee_last_slot: 0n,
    source_claim_impaired_num: 0n,
    source_lien_impaired_effective_reserved: 0n,
    source_lien_capital_at_risk_fee_revenue: 0n,
    source_lien_impaired_capital_at_risk_fee_revenue: 0n,
  };
  let write = 0n;
  let ordered = true;
  let havePrevious = false;
  let previous = 0n;
  for (let read = 0n; read < PORTFOLIO_SOURCE_DOMAIN_CAP; read++) {
    if (!domainOccupied(doms.get(read))) continue;
    const domain = doms.get(read).domain;
    if (havePrevious && previous > toU64(domain)) ordered = false;
    havePrevious = true;
    previous = toU64(domain);
    if (write !== read) {
      doms.set(write, doms.get(read));
      doms.set(read, zero);
    }
    write += 1n;
  }
  const occupied = write;
  while (write < PORTFOLIO_SOURCE_DOMAIN_CAP) {
    doms.set(write, zero);
    write += 1n;
  }
  if (!ordered) {
    for (let index = 1n; index < occupied; index++) {
      const source: PortfolioSourceDomain = doms.get(index);
      let insert = index;
      while (insert !== 0n && doms.get(insert - 1n).domain > source.domain) {
        doms.set(insert, doms.get(insert - 1n));
        insert -= 1n;
      }
      doms.set(insert, source);
    }
  }
}

// ---- PortfolioV16View::validate_with_market --------------------------------------------------------------------------------

/** `validate_close_progress_ledger_with_market`. */
export function closeProgressWithMarket(m: RemainingAccount, pa: RemainingAccount, markets: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const c = p.close_progress;
  checkV16(closeProgressErr(c));
  const configured = toU64(h.config.max_market_slots);
  const irreversible =
    c.support_consumed !== 0n ||
    c.junior_face_burned !== 0n ||
    c.insurance_spent !== 0n ||
    c.b_loss_booked !== 0n ||
    c.explicit_loss_assigned !== 0n ||
    c.quantity_adl_applied_q !== 0n ||
    c.drift_consumed !== 0n;
  if (c.canceled === 1n) {
    if (
      c.active === 1n ||
      c.finalized === 1n ||
      c.close_id === 0n ||
      toU64(c.asset_index) >= configured ||
      c.drift_reference_slot > c.max_close_slot ||
      irreversible ||
      c.residual_remaining !== c.gross_loss_at_close_start
    )
      failV16(V16_INVALID_LEG);
    return;
  }
  if (c.active === 0n) {
    // CloseProgressLedgerV16::is_empty (active and canceled are already 0 here).
    if (
      c.finalized !== 0n ||
      c.close_id !== 0n ||
      c.asset_index !== 0n ||
      c.market_id !== 0n ||
      c.domain_side !== 0n ||
      c.gross_loss_at_close_start !== 0n ||
      c.drift_reference_slot !== 0n ||
      c.max_close_slot !== 0n ||
      irreversible ||
      c.residual_remaining !== 0n
    )
      failV16(V16_INVALID_LEG);
    return;
  }
  const asset = toU64(c.asset_index);
  if (c.close_id === 0n || asset >= configured || asset >= markets) failV16(V16_INVALID_LEG);
  const slot = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  if (c.market_id !== slot.asset.market_id || c.drift_reference_slot > c.max_close_slot || c.support_consumed > c.junior_face_burned)
    failV16(V16_INVALID_LEG);
  if (c.support_consumed > U128_MAX_E - c.insurance_spent) failV16(V16_ARITHMETIC_OVERFLOW);
  if (c.support_consumed + c.insurance_spent > U128_MAX_E - c.b_loss_booked) failV16(V16_ARITHMETIC_OVERFLOW);
  if (c.support_consumed + c.insurance_spent + c.b_loss_booked > U128_MAX_E - c.explicit_loss_assigned) failV16(V16_ARITHMETIC_OVERFLOW);
  const progress = c.support_consumed + c.insurance_spent + c.b_loss_booked + c.explicit_loss_assigned;
  if (c.gross_loss_at_close_start > U128_MAX_E - c.drift_consumed) failV16(V16_ARITHMETIC_OVERFLOW);
  const total = c.gross_loss_at_close_start + c.drift_consumed;
  if (progress > total || c.residual_remaining !== total - progress) failV16(V16_INVALID_LEG);
  if (c.finalized === 1n && c.residual_remaining !== 0n) failV16(V16_INVALID_LEG);
  if (c.quantity_adl_applied_q !== 0n && (c.finalized === 0n || c.residual_remaining !== 0n)) failV16(V16_INVALID_LEG);
  const legSlot = activeLegSlotForAsset(p, asset);
  if (legSlot !== 16n) {
    const leg = p.legs.get(legSlot);
    // ledger.domain_side != opposite_side(leg.side).
    if (leg.active === 1n && c.domain_side === leg.side) failV16(V16_INVALID_LEG);
  }
}

/** The resolved-payout receipt decoded (`try_to_runtime`) and `validate_resolved_payout_receipt_static`. */
export function receiptStaticCheck(p: Portfolio): void {
  const r = p.resolved_payout_receipt;
  checkV16(resolvedPayoutReceiptErr(r));
  if (r.present === 0n) {
    if (r.prior_bound_contribution_num !== 0n || r.live_released_face_at_receipt !== 0n || r.terminal_positive_claim_face !== 0n || r.paid_effective !== 0n || r.finalized !== 0n)
      failV16(V16_INVALID_LEG);
  } else {
    if (r.terminal_positive_claim_face > U128_MAX_E / BOUND_SCALE) failV16(V16_ARITHMETIC_OVERFLOW);
    const finalizedNow = r.paid_effective === r.terminal_positive_claim_face;
    if (r.terminal_positive_claim_face * BOUND_SCALE > r.prior_bound_contribution_num || r.paid_effective > r.terminal_positive_claim_face || (r.finalized === 1n) !== finalizedNow)
      failV16(V16_INVALID_LEG);
  }
}

/**
 * `PortfolioV16View::validate_with_market` for the portfolio at HEADER_LEN of `pa` and the market `m` (`markets`
 * slots). Every refusal through `map_v16_error`, which every caller uses.
 */
export function validateWithMarket(m: RemainingAccount, pa: RemainingAccount, markets: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(configShapeErr(h.config));
  const ph = p.provenance_header;
  if (ph.market_group_id !== h.market_group_id || p.owner !== ph.owner || ph.version !== V16_ACCOUNT_VERSION || ph.layout_discriminator !== V16_LAYOUT_DISCRIMINATOR)
    failV16(V16_PROVENANCE_MISMATCH);
  const pnl = p.pnl;
  checkV16(nonMinI128Err(pnl));
  // validate_fee_credits.
  checkV16(nonMinI128Err(p.fee_credits));
  if (p.fee_credits > 0n) failV16(V16_INVALID_LEG);
  checkV16(boolErr(p.liquidation_lock));
  if (p.liquidation_lock === 1n && pnl >= 0n) failV16(V16_INVALID_LEG);
  const positive = pnl > 0n ? toU128(pnl) : 0n;
  if (p.reserved_pnl > positive) failV16(V16_INVALID_LEG);
  if (p.residual_spent_principal_atoms_total > p.residual_crystallized_loss_atoms_total) failV16(V16_INVALID_LEG);
  sourceCreditShapeWithMarket(m, pa);
  let claimSum: u128 = 0n;
  for (let d = 0n; d < PORTFOLIO_SOURCE_DOMAIN_CAP; d++) {
    const b = p.source_domains.get(d).source_claim_bound_num;
    if (claimSum > U128_MAX_E - b) failV16(V16_ARITHMETIC_OVERFLOW);
    claimSum += b;
  }
  if (claimSum !== 0n) {
    checkV16(marketModeErr(h.mode));
    const attributed = h.mode === MARKET_MODE_RESOLVED ? positive - p.reserved_pnl : positive;
    // validate_positive_pnl_source_attribution(attributed as i128, sum).
    if (attributed > 0n) {
      if (attributed > U128_MAX_E / BOUND_SCALE) failV16(V16_ARITHMETIC_OVERFLOW);
      if (claimSum < attributed * BOUND_SCALE) failV16(V16_INVALID_LEG);
    }
  }
  receiptStaticCheck(p);
  closeProgressWithMarket(m, pa, markets);
  const cap = toU64(h.config.max_portfolio_assets);
  const configured = toU64(h.config.max_market_slots);
  const bitmap = p.active_bitmap.get(0n);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const bit = ((bitmap >> slot) & 1n) !== 0n;
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    const active = leg.active === 1n;
    if (slot >= cap) {
      // An inactive leg is empty after try_to_runtime, so `!leg.is_empty()` is `active`.
      if (bit || active) failV16(V16_HIDDEN_LEG);
      continue;
    }
    if (bit !== active) failV16(V16_HIDDEN_LEG);
    if (!active) continue;
    // validate_active_leg again: it passed in try_to_runtime.
    const asset = toU64(leg.asset_index);
    if (asset >= configured || asset >= markets) failV16(V16_HIDDEN_LEG);
    const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
    checkV16(assetStateErr(a));
    const life = a.lifecycle;
    if (leg.market_id !== a.market_id || !(life === LIFECYCLE_ACTIVE || life === LIFECYCLE_DRAIN_ONLY || life === LIFECYCLE_RECOVERY) || !legBoundToAsset(a, leg))
      failV16(V16_HIDDEN_LEG);
    for (let j = 0n; j < slot; j++) {
      // The assets seen so far are the earlier active legs (every earlier active leg was recorded).
      const o = p.legs.get(j);
      if (o.active === 1n && o.asset_index === leg.asset_index) failV16(V16_HIDDEN_LEG);
    }
  }
  if (p.close_progress.quantity_adl_applied_q !== 0n) {
    const i = toU64(p.close_progress.asset_index);
    if (i >= configured || activeLegSlotForAsset(p, i) !== 16n) failV16(V16_INVALID_LEG);
  }
}

// ---- Materialized portfolios ----------------------------------------------------------------------------------------------

/** `is_empty_for_dematerialization` (its bool decodings fail with InvalidConfig). */
export function emptyForDematerialization(p: Portfolio): boolean {
  if (p.active_bitmap.get(0n) !== 0n || p.capital !== 0n || p.pnl !== 0n || p.reserved_pnl !== 0n || p.fee_credits !== 0n || p.cancel_deposit_escrow !== 0n)
    return false;
  checkV16(boolErr(p.stale_state));
  if (p.stale_state === 1n) return false;
  checkV16(boolErr(p.b_stale_state));
  if (p.b_stale_state === 1n) return false;
  checkV16(boolErr(p.rebalance_lock));
  if (p.rebalance_lock === 1n) return false;
  checkV16(boolErr(p.liquidation_lock));
  if (p.liquidation_lock === 1n) return false;
  const c = p.close_progress;
  checkV16(closeProgressErr(c));
  const irreversible =
    c.support_consumed !== 0n ||
    c.junior_face_burned !== 0n ||
    c.insurance_spent !== 0n ||
    c.b_loss_booked !== 0n ||
    c.explicit_loss_assigned !== 0n ||
    c.quantity_adl_applied_q !== 0n ||
    c.drift_consumed !== 0n;
  const isEmpty =
    c.active === 0n &&
    c.finalized === 0n &&
    c.canceled === 0n &&
    c.close_id === 0n &&
    c.asset_index === 0n &&
    c.market_id === 0n &&
    c.domain_side === 0n &&
    c.gross_loss_at_close_start === 0n &&
    c.drift_reference_slot === 0n &&
    c.max_close_slot === 0n &&
    !irreversible &&
    c.residual_remaining === 0n;
  const inertCanceled =
    c.canceled === 1n && c.active === 0n && c.finalized === 0n && c.close_id !== 0n && !irreversible && c.residual_remaining === c.gross_loss_at_close_start;
  const finalizedInert = c.active === 1n && c.finalized === 1n && c.canceled === 0n && c.residual_remaining === 0n;
  if (!isEmpty && !inertCanceled && !finalizedInert) return false;
  const r = p.resolved_payout_receipt;
  checkV16(resolvedPayoutReceiptErr(r));
  if (r.present === 1n && r.finalized === 0n) return false;
  for (let d = 0n; d < PORTFOLIO_SOURCE_DOMAIN_CAP; d++) if (domainOccupied(p.source_domains.get(d))) return false;
  return true;
}

/** `register_empty_materialized_portfolio_not_atomic` (map_v16_error at its one caller, InitPortfolio). */
export function registerEmptyPortfolio(m: RemainingAccount, pa: RemainingAccount, markets: u64): void {
  validateWithMarket(m, pa, markets);
  if (!emptyForDematerialization(loadRawAt<Portfolio>(pa, HEADER_LEN))) failV16(V16_LOCK_ACTIVE);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.materialized_portfolio_count === U64_MAX_E) failV16(V16_COUNTER_OVERFLOW);
  h.materialized_portfolio_count += 1n;
}

/**
 * `deregister_empty_materialized_portfolio_not_atomic`. Returns V16_LOCK_ACTIVE for a portfolio that is not empty,
 * as a value: SyncMaintenanceFee (NOTES.md site 1) goes on when it gets LockActive, ClosePortfolio fails with it.
 * Every other refusal fails in place (map_v16_error at both callers). Nothing is written before LockActive.
 */
export function deregisterEmptyPortfolio(m: RemainingAccount, pa: RemainingAccount, markets: u64): u64 {
  validateWithMarket(m, pa, markets);
  if (!emptyForDematerialization(loadRawAt<Portfolio>(pa, HEADER_LEN))) return V16_LOCK_ACTIVE;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.materialized_portfolio_count === 0n) failV16(V16_COUNTER_UNDERFLOW);
  h.materialized_portfolio_count -= 1n;
  return V16_OK;
}

/**
 * `deposit_not_atomic`: validated, then (for a nonzero amount) capital, c_tot and the vault raised together, the
 * health certificate invalidated, validated again with the market's shape. Its token-flow proof (ExternalQuote in,
 * AccountCapital debited by the same amount, the vault up by it) holds by construction and refuses nothing.
 */
export function depositEngine(m: RemainingAccount, pa: RemainingAccount, markets: u64, amount: u128): void {
  validateWithMarket(m, pa, markets);
  if (amount === 0n) return;
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (p.capital > U128_MAX_E - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  if (h.c_tot > U128_MAX_E - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  if (h.vault > U128_MAX_E - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  p.capital += amount;
  p.health_cert.valid = 0n;
  h.c_tot += amount;
  h.vault += amount;
  validateWithMarket(m, pa, markets);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

// ---- Oracle targets -------------------------------------------------------------------------------------------------------

/** `slot_resolved_payout_blockers_v16`'s checked sum (CounterOverflow); its decoding has passed at every caller. */
function slotBlockersOk(e: EngineAssetSlot): boolean {
  const a = e.asset;
  let sum = a.stored_pos_count_long;
  if (sum > U64_MAX_E - a.stored_pos_count_short) return false;
  sum += a.stored_pos_count_short;
  if (sum > U64_MAX_E - a.stale_account_count_long) return false;
  sum += a.stale_account_count_long;
  if (sum > U64_MAX_E - a.stale_account_count_short) return false;
  sum += a.stale_account_count_short;
  if (sum > U64_MAX_E - e.pending_domain_loss_barrier_long) return false;
  sum += e.pending_domain_loss_barrier_long;
  return sum <= U64_MAX_E - e.pending_domain_loss_barrier_short;
}

/**
 * `set_asset_raw_oracle_target_not_atomic(asset, target)`, that is `set_asset_raw_oracle_targets_not_atomic` with one
 * target: the asset configured (InvalidLeg), the target a valid price (InvalidConfig), the asset decoded and Active or
 * DrainOnly (LockActive); the oracle epoch raised by one when the target changes (CounterOverflow); `set_asset_state`
 * (its resolved-payout blocker count checked, unchanged by a target), then the market's shape. Every caller maps the
 * error with map_v16_error. The market is Live at every caller (it refused another mode first), so the mode check
 * (InvalidConfig) cannot fail.
 */
export function setAssetRawOracleTarget(m: RemainingAccount, markets: u64, asset: u64, target: u64): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  if (target === 0n || target > MAX_ORACLE_PRICE) failV16(V16_INVALID_CONFIG);
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  checkV16(assetStateErr(e.asset));
  const life = e.asset.lifecycle;
  if (life !== LIFECYCLE_ACTIVE && life !== LIFECYCLE_DRAIN_ONLY) failV16(V16_LOCK_ACTIVE);
  const changed = e.asset.raw_oracle_target_price !== target;
  if (changed && h.oracle_epoch === U64_MAX_E) failV16(V16_COUNTER_OVERFLOW);
  if (!slotBlockersOk(e)) failV16(V16_COUNTER_OVERFLOW);
  e.asset.raw_oracle_target_price = target;
  if (changed) h.oracle_epoch += 1n;
  checkV16(marketShapeErr(h, markets));
}

/**
 * `set_asset_raw_oracle_targets_not_atomic(targets[..n])` (a batch trade's staged targets, the assets distinct):
 * InvalidConfig for none or a market not Live; each target's asset configured (InvalidLeg), the target nonzero and at
 * most MAX_ORACLE_PRICE (InvalidConfig), its asset pushable (Active or DrainOnly: LockActive); the oracle epoch's
 * advance when any target changes (CounterOverflow); each target written (`set_asset_state`: the blockers,
 * CounterOverflow); the epoch advanced once; the market's shape.
 */
export function setAssetRawOracleTargets(m: RemainingAccount, markets: u64, assets: FixedArray<u64, 16>, targets: FixedArray<u64, 16>, n: u64): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (n === 0n || h.mode !== 0n) failV16(V16_INVALID_CONFIG);
  let changed = false;
  for (let i = 0n; i < n; i++) {
    const asset = assets.get(i);
    const target = targets.get(i);
    if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
    if (target === 0n || target > MAX_ORACLE_PRICE) failV16(V16_INVALID_CONFIG);
    const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
    checkV16(assetStateErr(e.asset));
    const life = e.asset.lifecycle;
    if (life !== LIFECYCLE_ACTIVE && life !== LIFECYCLE_DRAIN_ONLY) failV16(V16_LOCK_ACTIVE);
    for (let j = 0n; j < i; j++) if (assets.get(j) === asset) failV16(V16_INVALID_CONFIG);
    changed = changed || e.asset.raw_oracle_target_price !== target;
  }
  if (changed && h.oracle_epoch === U64_MAX_E) failV16(V16_COUNTER_OVERFLOW);
  for (let i = 0n; i < n; i++) {
    const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(assets.get(i)));
    if (!slotBlockersOk(e)) failV16(V16_COUNTER_OVERFLOW);
    e.asset.raw_oracle_target_price = targets.get(i);
  }
  if (changed) h.oracle_epoch += 1n;
  checkV16(marketShapeErr(h, markets));
}

// ---- Asset state's resolved-payout blockers (set_asset_state) ----------------------------------------------------------

/**
 * `slot_resolved_payout_blockers_v16`: the six blocker counts summed (CounterOverflow), as a u128 so that an overflow
 * can be reported as U128_MAX (no real sum reaches it).
 */
export function slotBlockers(e: EngineAssetSlot): u128 {
  const a = e.asset;
  const sum =
    toU128(a.stored_pos_count_long) +
    toU128(a.stored_pos_count_short) +
    toU128(a.stale_account_count_long) +
    toU128(a.stale_account_count_short) +
    toU128(e.pending_domain_loss_barrier_long) +
    toU128(e.pending_domain_loss_barrier_short);
  return sum > toU128(U64_MAX_E) ? U128_MAX_E : sum;
}

/** `slot_resolved_payout_blockers_v16` before a `set_asset_state`: the count, or a CounterOverflow failure. */
export function blockersBefore(m: RemainingAccount, asset: u64): u64 {
  const b = slotBlockers(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)));
  if (b === U128_MAX_E) failV16(V16_COUNTER_OVERFLOW);
  return toU64(b);
}

/**
 * The rest of `set_asset_state` after the caller changed the asset in place: the new blocker count (CounterOverflow;
 * the original restores the old asset and fails, which the transaction's failure does here) and the market's total
 * moved by the difference (`apply_total_delta_u64`: CounterOverflow or CounterUnderflow).
 */
export function blockersAfter(m: RemainingAccount, asset: u64, before: u64): void {
  const b = slotBlockers(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)));
  if (b === U128_MAX_E) failV16(V16_COUNTER_OVERFLOW);
  const after = toU64(b);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (after >= before) {
    if (h.resolved_payout_blocker_count > U64_MAX_E - (after - before)) failV16(V16_COUNTER_OVERFLOW);
    h.resolved_payout_blocker_count += after - before;
  } else {
    if (h.resolved_payout_blocker_count < before - after) failV16(V16_COUNTER_UNDERFLOW);
    h.resolved_payout_blocker_count -= before - after;
  }
}

