// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// The swap math (state/virtual_pool.rs: the three swap modes, the curve walks in both directions, apply_swap_result
// and the pre- and post-swap updates; state/fee.rs: the volatility tracker) and the fee totals of PoolFeesConfig
// (state/config.rs). The pool and config are views of the accounts' bytes after the discriminator.
import { type Inout, require, u64, u128, u256 } from "typesol";
import {
  getDeltaAmountBaseUnsigned,
  getDeltaAmountBaseUnsigned256,
  getDeltaAmountQuoteUnsigned,
  getDeltaAmountQuoteUnsigned256,
  getNextSqrtPriceFromInput,
  getNextSqrtPriceFromOutput,
} from "./curve";
import { PoolError } from "./errors";
import {
  baseFeeNumeratorFromExcluded,
  baseFeeNumeratorFromIncluded,
  deltaBinId,
  excludedFeeAmount,
  includedFeeAmount,
  minBaseFeeNumerator,
  splitFees,
  totalFeeNumerator,
} from "./fees";
import { addU128, addU64, castU256ToU64, divU128, mulU128, safeMulDivCastU64, subU64 } from "./math";
import { type PoolConfig, type PoolState, type SwapResult2 } from "./state";

/** constants.rs */
const BPS_MAX: u128 = 10000n;
/** The curve array's length (MAX_CURVE_POINT_CONFIG). */
const CURVE_POINTS: u64 = 20n;

/** SwapAmountFromInput / SwapAmountFromOutput. */
export interface SwapAmount {
  amount_left: u64;
  amount: u64;
  next_sqrt_price: u128;
}

/** What a swap does with fees: FeeMode (state/fee.rs) and the referral. */
export interface SwapFeeMode {
  fees_on_input: boolean;
  fees_on_base_token: boolean;
  has_referral: boolean;
}

// ---- fees on a swap (state/config.rs PoolFeesConfig) ------------------------------------------------------------

/** get_total_fee_numerator_from_included_fee_amount, or the minimum base fee for an eligible first swap. */
function feeNumeratorIncluded(pool: Inout<PoolState>, config: PoolConfig, currentPoint: u64, amount: u64, quoteToBase: boolean, minFee: boolean): u64 {
  if (minFee) return minBaseFeeNumerator(config.pool_fees.base_fee);
  const base = baseFeeNumeratorFromIncluded(config.pool_fees.base_fee, currentPoint, pool.activation_point, quoteToBase, amount);
  return totalFeeNumerator(config.pool_fees, base, pool.volatility_tracker);
}

/** get_total_fee_numerator_from_excluded_fee_amount, or the minimum base fee for an eligible first swap. */
function feeNumeratorExcluded(pool: Inout<PoolState>, config: PoolConfig, currentPoint: u64, amount: u64, quoteToBase: boolean, minFee: boolean): u64 {
  if (minFee) return minBaseFeeNumerator(config.pool_fees.base_fee);
  const base = baseFeeNumeratorFromExcluded(config.pool_fees.base_fee, currentPoint, pool.activation_point, quoteToBase, amount);
  return totalFeeNumerator(config.pool_fees, base, pool.volatility_tracker);
}

// ---- the curve walks ------------------------------------------------------------------------------------------

/** calculate_base_to_quote_from_amount_in: down the curve from the current price. */
function baseToQuoteFromAmountIn(pool: Inout<PoolState>, config: PoolConfig, amountIn: u64): SwapAmount {
  let totalOutput: u64 = 0n;
  let current = pool.sqrt_price;
  let left = amountIn;
  for (let k = 0n; k < CURVE_POINTS - 1n; k++) {
    const i = CURVE_POINTS - 2n - k;
    const point = config.curve.get(i);
    if (point.sqrt_price === 0n || point.liquidity === 0n) continue;
    if (point.sqrt_price < current) {
      const liquidity = config.curve.get(i + 1n).liquidity;
      const maxAmountIn = getDeltaAmountBaseUnsigned256(point.sqrt_price, current, liquidity, true);
      if (u256(left) < maxAmountIn) {
        const next = getNextSqrtPriceFromInput(current, liquidity, left, true);
        totalOutput = addU64(totalOutput, getDeltaAmountQuoteUnsigned(next, current, liquidity, false));
        current = next;
        left = 0n;
        break;
      }
      const next = point.sqrt_price;
      totalOutput = addU64(totalOutput, getDeltaAmountQuoteUnsigned(next, current, liquidity, false));
      current = next;
      left = subU64(left, castU256ToU64(maxAmountIn));
    }
  }
  if (left !== 0n) {
    const first = config.curve.get(0n);
    let next = getNextSqrtPriceFromInput(current, first.liquidity, left, true);
    if (next < config.sqrt_start_price) {
      next = config.sqrt_start_price;
      left = subU64(left, getDeltaAmountBaseUnsigned(next, current, first.liquidity, true));
    } else {
      left = 0n;
    }
    totalOutput = addU64(totalOutput, getDeltaAmountQuoteUnsigned(next, current, first.liquidity, false));
    current = next;
  }
  return { amount_left: left, amount: totalOutput, next_sqrt_price: current };
}

/** calculate_quote_to_base_from_amount_in: up the curve, stopping at `stopSqrtPrice` (the migration price). */
function quoteToBaseFromAmountIn(pool: Inout<PoolState>, config: PoolConfig, amountIn: u64, stopSqrtPrice: u128): SwapAmount {
  let totalOutput: u64 = 0n;
  let current = pool.sqrt_price;
  let left = amountIn;
  for (let i = 0n; i < CURVE_POINTS; i++) {
    const point = config.curve.get(i);
    if (point.sqrt_price === 0n || point.liquidity === 0n) break;
    const reference = stopSqrtPrice < point.sqrt_price ? stopSqrtPrice : point.sqrt_price;
    if (reference > current) {
      const maxAmountIn = getDeltaAmountQuoteUnsigned256(current, reference, point.liquidity, true);
      if (u256(left) < maxAmountIn) {
        const next = getNextSqrtPriceFromInput(current, point.liquidity, left, false);
        totalOutput = addU64(totalOutput, getDeltaAmountBaseUnsigned(current, next, point.liquidity, false));
        current = next;
        left = 0n;
        break;
      }
      const next = reference;
      totalOutput = addU64(totalOutput, getDeltaAmountBaseUnsigned(current, next, point.liquidity, false));
      current = next;
      left = subU64(left, castU256ToU64(maxAmountIn));
      if (next === stopSqrtPrice) break;
    }
  }
  return { amount_left: left, amount: totalOutput, next_sqrt_price: current };
}

/** calculate_base_to_quote_from_amount_out: the base in for an exact quote out, down the curve. */
function baseToQuoteFromAmountOut(pool: Inout<PoolState>, config: PoolConfig, amountOut: u64): SwapAmount {
  let current = pool.sqrt_price;
  let left = amountOut;
  let totalIn: u64 = 0n;
  for (let k = 0n; k < CURVE_POINTS - 1n; k++) {
    const i = CURVE_POINTS - 2n - k;
    const point = config.curve.get(i);
    if (point.sqrt_price === 0n || point.liquidity === 0n) continue;
    if (point.sqrt_price < current) {
      const liquidity = config.curve.get(i + 1n).liquidity;
      const maxAmountOut = getDeltaAmountQuoteUnsigned256(point.sqrt_price, current, liquidity, false);
      if (u256(left) < maxAmountOut) {
        const next = getNextSqrtPriceFromOutput(current, liquidity, left, true);
        totalIn = addU64(totalIn, getDeltaAmountBaseUnsigned(next, current, liquidity, true));
        current = next;
        left = 0n;
        break;
      }
      const next = point.sqrt_price;
      totalIn = addU64(totalIn, getDeltaAmountBaseUnsigned(next, current, liquidity, true));
      current = next;
      // `max_amount_out.try_into().unwrap()`: it is below `left` here, so it fits
      left = subU64(left, castU256ToU64(maxAmountOut));
    }
  }
  if (left !== 0n) {
    const first = config.curve.get(0n);
    const maxAmountOut = getDeltaAmountQuoteUnsigned256(config.sqrt_start_price, current, first.liquidity, false);
    require(u256(left) <= maxAmountOut, PoolError.InsufficientLiquidity);
    const next = getNextSqrtPriceFromOutput(current, first.liquidity, left, true);
    require(next >= config.sqrt_start_price, PoolError.InsufficientLiquidity);
    totalIn = addU64(totalIn, getDeltaAmountBaseUnsigned(next, current, first.liquidity, true));
    current = next;
  }
  return { amount_left: 0n, amount: totalIn, next_sqrt_price: current };
}

/** calculate_quote_to_base_from_amount_out: the quote in for an exact base out, up the curve. */
function quoteToBaseFromAmountOut(pool: Inout<PoolState>, config: PoolConfig, amountOut: u64): SwapAmount {
  let totalIn: u64 = 0n;
  let left = amountOut;
  let current = pool.sqrt_price;
  for (let i = 0n; i < CURVE_POINTS; i++) {
    const point = config.curve.get(i);
    if (point.sqrt_price === 0n || point.liquidity === 0n) break;
    if (point.sqrt_price > current) {
      const maxAmountOut = getDeltaAmountBaseUnsigned256(current, point.sqrt_price, point.liquidity, false);
      if (u256(left) < maxAmountOut) {
        const next = getNextSqrtPriceFromOutput(current, point.liquidity, left, false);
        totalIn = addU64(totalIn, getDeltaAmountQuoteUnsigned(current, next, point.liquidity, true));
        current = next;
        left = 0n;
        break;
      }
      const next = point.sqrt_price;
      totalIn = addU64(totalIn, getDeltaAmountQuoteUnsigned(current, next, point.liquidity, true));
      current = next;
      left = subU64(left, castU256ToU64(maxAmountOut));
    }
  }
  require(left === 0n, PoolError.AmountLeftIsNotZero);
  return { amount_left: 0n, amount: totalIn, next_sqrt_price: current };
}

// ---- swap results ---------------------------------------------------------------------------------------------

/** get_swap_result_from_exact_input */
export function swapResultFromExactInput(
  pool: Inout<PoolState>,
  config: PoolConfig,
  amountIn: u64,
  mode: SwapFeeMode,
  quoteToBase: boolean,
  currentPoint: u64,
  minFee: boolean,
): SwapResult2 {
  let protocolFee: u64 = 0n;
  let tradingFee: u64 = 0n;
  let referralFee: u64 = 0n;
  const numerator = feeNumeratorIncluded(pool, config, currentPoint, amountIn, quoteToBase, minFee);
  let actualIn = amountIn;
  if (mode.fees_on_input) {
    const ex = excludedFeeAmount(numerator, amountIn);
    const split = splitFees(ex.b, mode.has_referral);
    protocolFee = split.protocol_fee;
    tradingFee = split.trading_fee;
    referralFee = split.referral_fee;
    actualIn = ex.a;
  }
  const r = quoteToBase ? quoteToBaseFromAmountIn(pool, config, actualIn, config.migration_sqrt_price) : baseToQuoteFromAmountIn(pool, config, actualIn);
  require(r.amount_left === 0n, PoolError.InsufficientLiquidity);
  let actualOut = r.amount;
  if (!mode.fees_on_input) {
    const ex = excludedFeeAmount(numerator, r.amount);
    const split = splitFees(ex.b, mode.has_referral);
    tradingFee = split.trading_fee;
    protocolFee = split.protocol_fee;
    referralFee = split.referral_fee;
    actualOut = ex.a;
  }
  return {
    included_fee_input_amount: amountIn,
    excluded_fee_input_amount: actualIn,
    amount_left: r.amount_left,
    output_amount: actualOut,
    next_sqrt_price: r.next_sqrt_price,
    trading_fee: tradingFee,
    protocol_fee: protocolFee,
    referral_fee: referralFee,
  };
}

/** get_swap_result_from_partial_input: as exact input, but stops at the migration price and charges what it used. */
export function swapResultFromPartialInput(
  pool: Inout<PoolState>,
  config: PoolConfig,
  amountIn: u64,
  mode: SwapFeeMode,
  quoteToBase: boolean,
  currentPoint: u64,
  minFee: boolean,
): SwapResult2 {
  let protocolFee: u64 = 0n;
  let tradingFee: u64 = 0n;
  let referralFee: u64 = 0n;
  const numerator = feeNumeratorIncluded(pool, config, currentPoint, amountIn, quoteToBase, minFee);
  let actualIn = amountIn;
  if (mode.fees_on_input) {
    const ex = excludedFeeAmount(numerator, amountIn);
    const split = splitFees(ex.b, mode.has_referral);
    protocolFee = split.protocol_fee;
    tradingFee = split.trading_fee;
    referralFee = split.referral_fee;
    actualIn = ex.a;
  }
  const r = quoteToBase ? quoteToBaseFromAmountIn(pool, config, actualIn, config.migration_sqrt_price) : baseToQuoteFromAmountIn(pool, config, actualIn);
  let includedIn = amountIn;
  if (r.amount_left !== 0n) {
    actualIn = subU64(actualIn, r.amount_left);
    if (mode.fees_on_input) {
      const n2 = feeNumeratorExcluded(pool, config, currentPoint, actualIn, quoteToBase, minFee);
      const inc = includedFeeAmount(n2, actualIn);
      const split = splitFees(inc.b, mode.has_referral);
      tradingFee = split.trading_fee;
      protocolFee = split.protocol_fee;
      referralFee = split.referral_fee;
      includedIn = inc.a;
    } else {
      includedIn = actualIn;
    }
  }
  let actualOut = r.amount;
  if (!mode.fees_on_input) {
    const ex = excludedFeeAmount(numerator, r.amount);
    const split = splitFees(ex.b, mode.has_referral);
    protocolFee = split.protocol_fee;
    tradingFee = split.trading_fee;
    referralFee = split.referral_fee;
    actualOut = ex.a;
  }
  return {
    included_fee_input_amount: includedIn,
    excluded_fee_input_amount: actualIn,
    amount_left: r.amount_left,
    output_amount: actualOut,
    next_sqrt_price: r.next_sqrt_price,
    trading_fee: tradingFee,
    protocol_fee: protocolFee,
    referral_fee: referralFee,
  };
}

/** get_swap_result_from_exact_output */
export function swapResultFromExactOutput(
  pool: Inout<PoolState>,
  config: PoolConfig,
  amountOut: u64,
  mode: SwapFeeMode,
  quoteToBase: boolean,
  currentPoint: u64,
  minFee: boolean,
): SwapResult2 {
  let protocolFee: u64 = 0n;
  let tradingFee: u64 = 0n;
  let referralFee: u64 = 0n;
  let includedOut = amountOut;
  if (!mode.fees_on_input) {
    const n = feeNumeratorExcluded(pool, config, currentPoint, amountOut, quoteToBase, minFee);
    const inc = includedFeeAmount(n, amountOut);
    const split = splitFees(inc.b, mode.has_referral);
    tradingFee = split.trading_fee;
    protocolFee = split.protocol_fee;
    referralFee = split.referral_fee;
    includedOut = inc.a;
  }
  const r = quoteToBase ? quoteToBaseFromAmountOut(pool, config, includedOut) : baseToQuoteFromAmountOut(pool, config, includedOut);
  require(r.next_sqrt_price <= config.migration_sqrt_price, PoolError.InsufficientLiquidity);
  let includedIn = r.amount;
  if (mode.fees_on_input) {
    const n = feeNumeratorExcluded(pool, config, currentPoint, r.amount, quoteToBase, minFee);
    const inc = includedFeeAmount(n, r.amount);
    const split = splitFees(inc.b, mode.has_referral);
    tradingFee = split.trading_fee;
    protocolFee = split.protocol_fee;
    referralFee = split.referral_fee;
    includedIn = inc.a;
  }
  return {
    included_fee_input_amount: includedIn,
    excluded_fee_input_amount: r.amount,
    amount_left: 0n,
    output_amount: amountOut,
    next_sqrt_price: r.next_sqrt_price,
    trading_fee: tradingFee,
    protocol_fee: protocolFee,
    referral_fee: referralFee,
  };
}

/** The swap result of a SwapMode: 0 ExactIn, 1 PartialFill, 2 ExactOut. */
export function swapResultFor(
  pool: Inout<PoolState>,
  config: PoolConfig,
  amount: u64,
  mode: SwapFeeMode,
  quoteToBase: boolean,
  currentPoint: u64,
  minFee: boolean,
  swapMode: u64,
): SwapResult2 {
  if (swapMode === 0n) return swapResultFromExactInput(pool, config, amount, mode, quoteToBase, currentPoint, minFee);
  if (swapMode === 1n) return swapResultFromPartialInput(pool, config, amount, mode, quoteToBase, currentPoint, minFee);
  return swapResultFromExactOutput(pool, config, amount, mode, quoteToBase, currentPoint, minFee);
}

// ---- applying a swap (state/virtual_pool.rs, state/fee.rs) -------------------------------------------------------

/** VolatilityTracker::update_references (PoolState::update_pre_swap, when the dynamic fee is on). */
export function updatePreSwap(pool: Inout<PoolState>, config: PoolConfig, currentTimestamp: u64): void {
  const d = config.pool_fees.dynamic_fee;
  if (d.initialized === 0n) return;
  const elapsed = currentTimestamp > pool.volatility_tracker.last_update_timestamp ? currentTimestamp - pool.volatility_tracker.last_update_timestamp : 0n;
  if (elapsed >= u64(d.filter_period)) {
    pool.volatility_tracker.sqrt_price_reference = pool.sqrt_price;
    if (elapsed < u64(d.decay_period)) pool.volatility_tracker.volatility_reference = divU128(mulU128(pool.volatility_tracker.volatility_accumulator, u128(d.reduction_factor)), BPS_MAX);
    else pool.volatility_tracker.volatility_reference = 0n;
  }
}

/** PoolState::update_post_swap: the volatility accumulator, and the timestamp when the price moved a bin. */
function updatePostSwap(pool: Inout<PoolState>, config: PoolConfig, oldSqrtPrice: u128, currentTimestamp: u64): void {
  const d = config.pool_fees.dynamic_fee;
  if (d.initialized === 0n) return;
  const delta = deltaBinId(d.bin_step_u128, pool.sqrt_price, pool.volatility_tracker.sqrt_price_reference);
  const accumulator = addU128(pool.volatility_tracker.volatility_reference, mulU128(delta, BPS_MAX));
  const max = u128(d.max_volatility_accumulator);
  pool.volatility_tracker.volatility_accumulator = accumulator < max ? accumulator : max;
  if (deltaBinId(d.bin_step_u128, oldSqrtPrice, pool.sqrt_price) > 0n) pool.volatility_tracker.last_update_timestamp = currentTimestamp;
}

/** PoolConfig::split_partner_and_creator_fee: [partner, creator]. */
function creatorShare(config: PoolConfig, fee: u64): u64 {
  if (config.creator_trading_fee_percentage === 0n) return 0n;
  return safeMulDivCastU64(fee, u64(config.creator_trading_fee_percentage), 100n, false);
}

/** PoolState::apply_swap_result */
export function applySwapResult(pool: Inout<PoolState>, config: PoolConfig, r: SwapResult2, mode: SwapFeeMode, quoteToBase: boolean, currentTimestamp: u64): void {
  const oldSqrtPrice = pool.sqrt_price;
  pool.sqrt_price = r.next_sqrt_price;
  const creatorFee = creatorShare(config, r.trading_fee);
  const partnerFee = subU64(r.trading_fee, creatorFee);
  if (mode.fees_on_base_token) {
    pool.partner_base_fee = addU64(pool.partner_base_fee, partnerFee);
    pool.protocol_base_fee = addU64(pool.protocol_base_fee, r.protocol_fee);
    pool.creator_base_fee = addU64(pool.creator_base_fee, creatorFee);
    pool.metrics.total_protocol_base_fee = addU64(pool.metrics.total_protocol_base_fee, r.protocol_fee);
    pool.metrics.total_trading_base_fee = addU64(pool.metrics.total_trading_base_fee, r.trading_fee);
  } else {
    pool.partner_quote_fee = addU64(pool.partner_quote_fee, partnerFee);
    pool.protocol_quote_fee = addU64(pool.protocol_quote_fee, r.protocol_fee);
    pool.creator_quote_fee = addU64(pool.creator_quote_fee, creatorFee);
    pool.metrics.total_protocol_quote_fee = addU64(pool.metrics.total_protocol_quote_fee, r.protocol_fee);
    pool.metrics.total_trading_quote_fee = addU64(pool.metrics.total_trading_quote_fee, r.trading_fee);
  }
  const actualOutput = mode.fees_on_input ? r.output_amount : addU64(addU64(addU64(r.output_amount, r.trading_fee), r.protocol_fee), r.referral_fee);
  // SwapResult's actual_input_amount is SwapResult2's excluded_fee_input_amount
  if (!quoteToBase) {
    pool.base_reserve = addU64(pool.base_reserve, r.excluded_fee_input_amount);
    pool.quote_reserve = subU64(pool.quote_reserve, actualOutput);
  } else {
    pool.quote_reserve = addU64(pool.quote_reserve, r.excluded_fee_input_amount);
    pool.base_reserve = subU64(pool.base_reserve, actualOutput);
  }
  updatePostSwap(pool, config, oldSqrtPrice, currentTimestamp);
  pool.has_swap = 1n;
}
