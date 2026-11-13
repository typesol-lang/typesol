// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// Fees: the base fee handlers (base_fee/mod.rs, base_fee/fee_scheduler.rs), the fee parameters and their validation
// (params/fee_parameters.rs), the dynamic fee (state/config.rs DynamicFeeConfig, state/fee.rs VolatilityTracker and
// FeeMode), the trading fee splits (state/config.rs PoolFeesConfig) and the DAMM v2 helpers that config validation
// uses (utils/damm_v2_utils.rs).
//
// The original's `Box<dyn BaseFeeHandler>` is a switch on the base fee mode here. The rate limiter
// (base_fee/fee_rate_limiter.rs) is deprecated for new configs (config creation refuses it) but configs made before
// 0.2.1 still swap with it.
import { type Inout, type u8, type u16, isqrt, require, u32, u64, u128, u256 } from "typesol";
import { PoolError } from "./errors";
import {
  type U64Pair,
  ONE_Q64,
  U256_MAX,
  addU128,
  addU64,
  divU128,
  divU64,
  getFeeInPeriod,
  mulU128,
  mulU64,
  safeMulDivCastU64,
  safeShlDivCastU128,
  subU128,
  subU64,
} from "./math";
import {
  BASE_FEE_RATE_LIMITER,
  DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL,
  DAMM_V2_FEE_MARKET_CAP_SCHEDULER_LINEAR,
  type BaseFeeConfig,
  type BaseFeeParameters,
  type DynamicFeeConfig,
  type DynamicFeeParameters,
  type PoolFeeParameters,
  type PoolFeesConfig,
  type VolatilityTracker,
} from "./state";

/** constants.rs, mod fee */
export const FEE_DENOMINATOR: u64 = 1_000_000_000n;
export const MAX_FEE_NUMERATOR: u64 = 990_000_000n;
export const MIN_FEE_NUMERATOR: u64 = 2_500_000n;
export const MAX_BASIS_POINT: u64 = 10000n;
export const PROTOCOL_FEE_PERCENT: u64 = 20n;
export const HOST_FEE_PERCENT: u64 = 20n;
export const PROTOCOL_POOL_CREATION_FEE_PERCENT: u64 = 10n;
/** constants.rs, mod dynamic_fee */
export const BIN_STEP_BPS_DEFAULT: u16 = 1n;
export const BIN_STEP_BPS_U128_DEFAULT: u128 = 1844674407370955n;
export const FILTER_PERIOD_DEFAULT: u16 = 10n;
export const DECAY_PERIOD_DEFAULT: u16 = 120n;
export const REDUCTION_FACTOR_DEFAULT: u16 = 5000n;
export const MAX_DYNAMIC_FEE_PERCENT: u128 = 20n;
export const MAX_VOLATILITY_ACCUMULATOR: u32 = 14460000n;
export const SQUARE_VFA_BIN: u128 = 209091600000000n;
export const U24_MAX: u32 = 0xffffffn;
/** DAMM v2's constants (libs/damm-v2, its IDL). */
export const DAMM_V2_FEE_DENOMINATOR: u64 = 1000000000n;
export const DAMM_V2_MIN_FEE_NUMERATOR: u64 = 100000n;
export const DAMM_V2_MAX_FEE_NUMERATOR_V1: u64 = 990000000n;

// ---- params/fee_parameters.rs -----------------------------------------------------------------------------------

/** validate_fee_fraction */
export function validateFeeFraction(numerator: u64, denominator: u64): void {
  require(!(denominator === 0n || numerator >= denominator), PoolError.InvalidFee);
}

/** to_numerator: bps * denominator / 10_000, TypeCastFailed when it is not a u64. */
export function toNumerator(bps: u128, denominator: u128): u64 {
  const numerator = divU128(mulU128(bps, denominator), u128(MAX_BASIS_POINT));
  require(numerator <= u128(18446744073709551615n), PoolError.TypeCastFailed);
  return u64(numerator);
}

/** to_bps: numerator * 10_000 / denominator, TypeCastFailed when it is not a u64. */
export function toBps(numerator: u128, denominator: u128): u64 {
  const bps = divU128(mulU128(numerator, u128(MAX_BASIS_POINT)), denominator);
  require(bps <= u128(18446744073709551615n), PoolError.TypeCastFailed);
  return u64(bps);
}

// ---- base_fee/fee_scheduler.rs ----------------------------------------------------------------------------------

/** FeeScheduler: number_of_period = first_factor, period_frequency = second_factor, reduction_factor = third_factor. */
export interface FeeScheduler {
  cliff_fee_numerator: u64;
  number_of_period: u16;
  period_frequency: u64;
  reduction_factor: u64;
  fee_scheduler_mode: u8;
}

function schedulerFeeByPeriod(s: FeeScheduler, period: u64): u64 {
  const p = period < u64(s.number_of_period) ? period : u64(s.number_of_period);
  // FeeSchedulerMode::try_from: only 0 and 1 reach here (get_base_fee_handler checked the mode).
  require(s.fee_scheduler_mode <= 1n, PoolError.TypeCastFailed);
  if (s.fee_scheduler_mode === 0n) return subU64(s.cliff_fee_numerator, mulU64(s.reduction_factor, p));
  // u16::try_from(period): period is at most number_of_period, a u16.
  return getFeeInPeriod(s.cliff_fee_numerator, s.reduction_factor, p);
}

export function schedulerMinBaseFeeNumerator(s: FeeScheduler): u64 {
  return schedulerFeeByPeriod(s, u64(s.number_of_period));
}

/** FeeScheduler::get_base_fee_numerator: by the periods passed since activation. */
export function schedulerBaseFeeNumerator(s: FeeScheduler, currentPoint: u64, activationPoint: u64): u64 {
  if (s.period_frequency === 0n) return s.cliff_fee_numerator;
  const period = divU64(subU64(currentPoint, activationPoint), s.period_frequency);
  return schedulerFeeByPeriod(s, period);
}

/** BaseFeeHandler::validate for a FeeScheduler. */
export function validateScheduler(s: FeeScheduler): void {
  if (s.period_frequency !== 0n || s.number_of_period !== 0n || s.reduction_factor !== 0n)
    require(s.number_of_period !== 0n && s.period_frequency !== 0n && s.reduction_factor !== 0n, PoolError.InvalidFeeScheduler);
  const minFeeNumerator = schedulerMinBaseFeeNumerator(s);
  const maxFeeNumerator = s.cliff_fee_numerator;
  validateFeeFraction(minFeeNumerator, FEE_DENOMINATOR);
  validateFeeFraction(maxFeeNumerator, FEE_DENOMINATOR);
  require(minFeeNumerator >= MIN_FEE_NUMERATOR && maxFeeNumerator <= MAX_FEE_NUMERATOR, PoolError.ExceedMaxFeeBps);
}

/** The fee scheduler of the modes 0 and 1 (callers have dispatched the rate limiter and refused other modes). */
export function schedulerOf(cliffFeeNumerator: u64, firstFactor: u16, secondFactor: u64, thirdFactor: u64, baseFeeMode: u8): FeeScheduler {
  return {
    cliff_fee_numerator: cliffFeeNumerator,
    number_of_period: firstFactor,
    period_frequency: secondFactor,
    reduction_factor: thirdFactor,
    fee_scheduler_mode: baseFeeMode,
  };
}

/** BaseFeeParameters::validate */
export function validateBaseFeeParameters(p: BaseFeeParameters): void {
  // get_base_fee_mode: InvalidBaseFeeMode past the enum, then the rate limiter is refused for new configs.
  require(p.base_fee_mode <= BASE_FEE_RATE_LIMITER, PoolError.InvalidBaseFeeMode);
  require(p.base_fee_mode !== BASE_FEE_RATE_LIMITER, PoolError.DeprecatedBaseFeeMode);
  validateScheduler(schedulerOf(p.cliff_fee_numerator, p.first_factor, p.second_factor, p.third_factor, p.base_fee_mode));
}

/** DynamicFeeParameters::validate */
export function validateDynamicFeeParameters(d: DynamicFeeParameters): void {
  require(d.bin_step === BIN_STEP_BPS_DEFAULT, PoolError.InvalidInput);
  require(d.bin_step_u128 === BIN_STEP_BPS_U128_DEFAULT, PoolError.InvalidInput);
  require(d.filter_period < d.decay_period, PoolError.InvalidInput);
  require(d.reduction_factor <= 10000n, PoolError.InvalidInput);
  require(d.variable_fee_control <= U24_MAX, PoolError.InvalidInput);
  require(d.max_volatility_accumulator <= U24_MAX, PoolError.InvalidInput);
}

/** PoolFeeParameters::validate (collect fee mode and activation type are only read by the rate limiter). */
export function validatePoolFeeParameters(p: PoolFeeParameters): void {
  validateBaseFeeParameters(p.base_fee);
  if (p.dynamic_fee !== null) validateDynamicFeeParameters(p.dynamic_fee);
}

/** PoolFeeParameters::to_pool_fees_config, written into `out` (all zero before). */
export function writePoolFeesConfig(out: Inout<PoolFeesConfig>, p: PoolFeeParameters): void {
  out.base_fee.cliff_fee_numerator = p.base_fee.cliff_fee_numerator;
  out.base_fee.first_factor = p.base_fee.first_factor;
  out.base_fee.second_factor = p.base_fee.second_factor;
  out.base_fee.third_factor = p.base_fee.third_factor;
  out.base_fee.base_fee_mode = p.base_fee.base_fee_mode;
  if (p.dynamic_fee !== null) {
    out.dynamic_fee.initialized = 1n;
    out.dynamic_fee.bin_step = p.dynamic_fee.bin_step;
    out.dynamic_fee.filter_period = p.dynamic_fee.filter_period;
    out.dynamic_fee.decay_period = p.dynamic_fee.decay_period;
    out.dynamic_fee.reduction_factor = p.dynamic_fee.reduction_factor;
    out.dynamic_fee.bin_step_u128 = p.dynamic_fee.bin_step_u128;
    out.dynamic_fee.max_volatility_accumulator = p.dynamic_fee.max_volatility_accumulator;
    out.dynamic_fee.variable_fee_control = p.dynamic_fee.variable_fee_control;
  }
}

// ---- state/config.rs: BaseFeeConfig, DynamicFeeConfig, PoolFeesConfig -------------------------------------------

// ---- base_fee/fee_rate_limiter.rs -------------------------------------------------------------------------------

/**
 * FeeRateLimiter: fee_increment_bps = first_factor, max_limiter_duration = second_factor, reference_amount =
 * third_factor. The original computes in U256 with ruint's bare (wrapping) operators. With the fee bounds (numerators
 * at most 1e9, amounts u64) the products stay far below 2^256, so only its two subtractions in the exact-out inverse
 * can wrap; they wrap here too (wrappingSub). The other operators are checked and cannot fail.
 */
export interface FeeRateLimiter {
  cliff_fee_numerator: u64;
  fee_increment_bps: u16;
  max_limiter_duration: u64;
  reference_amount: u64;
}

/** a - b modulo 2^256, as ruint's `-`. */
function wrappingSub(a: u256, b: u256): u256 {
  return a >= b ? a - b : U256_MAX - (b - a) + 1n;
}

function rateLimiterOf(b: BaseFeeConfig): FeeRateLimiter {
  return { cliff_fee_numerator: b.cliff_fee_numerator, fee_increment_bps: b.first_factor, max_limiter_duration: b.second_factor, reference_amount: b.third_factor };
}

function isZeroRateLimiter(r: FeeRateLimiter): boolean {
  return r.reference_amount === 0n && r.max_limiter_duration === 0n && r.fee_increment_bps === 0n;
}

/** FeeRateLimiter::is_rate_limiter_applied: only quote to base, until activation + max_limiter_duration. */
export function isRateLimiterApplied(r: FeeRateLimiter, currentPoint: u64, activationPoint: u64, quoteToBase: boolean): boolean {
  if (isZeroRateLimiter(r)) return false;
  if (!quoteToBase) return false;
  const last = u128(activationPoint) + u128(r.max_limiter_duration);
  return !(u128(currentPoint) > last);
}

/** BaseFeeConfig::get_fee_rate_limiter's Ok case: whether the config's base fee is a rate limiter. */
export function isRateLimiterConfig(b: BaseFeeConfig): boolean {
  return b.base_fee_mode === BASE_FEE_RATE_LIMITER;
}

export function rateLimiterApplied(b: BaseFeeConfig, currentPoint: u64, activationPoint: u64, quoteToBase: boolean): boolean {
  return isRateLimiterApplied(rateLimiterOf(b), currentPoint, activationPoint, quoteToBase);
}

function rateLimiterMaxIndex(r: FeeRateLimiter): u64 {
  const delta = subU64(MAX_FEE_NUMERATOR, r.cliff_fee_numerator);
  const increment = toNumerator(u128(r.fee_increment_bps), u128(FEE_DENOMINATOR));
  return divU64(delta, increment);
}

/** FeeRateLimiter::get_fee_numerator_from_included_fee_amount */
function rateLimiterFeeFromIncluded(r: FeeRateLimiter, inputAmount: u64): u64 {
  if (inputAmount <= r.reference_amount) return r.cliff_fee_numerator;
  const c = u256(r.cliff_fee_numerator);
  // div_rem by the reference amount (a zero one panics, as num's div_rem does)
  const rest = subU64(inputAmount, r.reference_amount);
  const a = u256(rest / r.reference_amount);
  const b = u256(rest % r.reference_amount);
  const maxIndex = u256(rateLimiterMaxIndex(r));
  const i = u256(toNumerator(u128(r.fee_increment_bps), u128(FEE_DENOMINATOR)));
  const x0 = u256(r.reference_amount);
  let tradingFeeNumerator: u256 = 0n;
  if (a < maxIndex) {
    const numerator1 = c + c * a + (i * a * (a + 1n)) / 2n;
    const numerator2 = c + i * (a + 1n);
    tradingFeeNumerator = x0 * numerator1 + b * numerator2;
  } else {
    const numerator1 = c + c * maxIndex + (i * maxIndex * (maxIndex + 1n)) / 2n;
    const numerator2 = u256(MAX_FEE_NUMERATOR);
    const leftAmount = (a - maxIndex) * x0 + b;
    tradingFeeNumerator = x0 * numerator1 + leftAmount * numerator2;
  }
  const d = u256(FEE_DENOMINATOR);
  const tradingFee = (tradingFeeNumerator + d - 1n) / d;
  require(tradingFee <= u256(18446744073709551615n), PoolError.TypeCastFailed);
  return safeMulDivCastU64(u64(tradingFee), FEE_DENOMINATOR, inputAmount, true);
}

function rateLimiterExcludedFeeAmount(r: FeeRateLimiter, includedAmount: u64): u64 {
  const numerator = rateLimiterFeeFromIncluded(r, includedAmount);
  return excludedFeeAmount(numerator, includedAmount).a;
}

/** FeeRateLimiter::get_fee_numerator_from_excluded_fee_amount */
function rateLimiterFeeFromExcluded(r: FeeRateLimiter, excludedAmount: u64): u64 {
  const excludedReference = rateLimiterExcludedFeeAmount(r, r.reference_amount);
  if (excludedAmount <= excludedReference) return r.cliff_fee_numerator;
  // get_checked_amounts
  const maxIndex = rateLimiterMaxIndex(r);
  const maxIndexInput = (u256(maxIndex) + 1n) * u256(r.reference_amount);
  let checkedIncluded: u64 = 18446744073709551615n;
  let isOverflow = true;
  if (maxIndexInput <= u256(18446744073709551615n)) {
    checkedIncluded = u64(maxIndexInput);
    isOverflow = false;
  }
  const checkedExcluded = rateLimiterExcludedFeeAmount(r, checkedIncluded);
  if (excludedAmount === checkedExcluded) return rateLimiterFeeFromIncluded(r, checkedIncluded);
  let inFee: u64 = 0n;
  if (excludedAmount < checkedExcluded) {
    const i = u256(toNumerator(u128(r.fee_increment_bps), u128(FEE_DENOMINATOR)));
    const x0 = u256(r.reference_amount);
    const d = u256(FEE_DENOMINATOR);
    const c = u256(r.cliff_fee_numerator);
    const ex = u256(excludedAmount);
    const x = i;
    const y = wrappingSub(2n * d * x0 + i * x0, 2n * c * x0);
    const z = 2n * ex * d * x0;
    const root = isqrt(wrappingSub(y * y, 4n * x * z));
    const included = wrappingSub(y, root) / (2n * x);
    require(x0 !== 0n, PoolError.MathOverflow);
    const aPlusOne = included / x0;
    require(included <= u256(18446744073709551615n), PoolError.TypeCastFailed);
    const firstExcluded = rateLimiterExcludedFeeAmount(r, u64(included));
    const excludedRemaining = subU64(excludedAmount, firstExcluded);
    const remainingNumerator = c + i * aPlusOne;
    require(remainingNumerator <= u256(18446744073709551615n), PoolError.TypeCastFailed);
    const includedRemaining = includedFeeAmount(u64(remainingNumerator), excludedRemaining).a;
    const total = included + u256(includedRemaining);
    require(total <= U256_MAX, PoolError.MathOverflow);
    require(total <= u256(18446744073709551615n), PoolError.TypeCastFailed);
    inFee = u64(total);
  } else {
    require(!isOverflow, PoolError.MathOverflow);
    const excludedRemaining = subU64(excludedAmount, checkedExcluded);
    const includedRemaining = includedFeeAmount(MAX_FEE_NUMERATOR, excludedRemaining).a;
    inFee = addU64(includedRemaining, checkedIncluded);
  }
  const tradingFee = subU64(inFee, excludedAmount);
  const feeNumerator = safeMulDivCastU64(tradingFee, FEE_DENOMINATOR, inFee, true);
  require(feeNumerator >= r.cliff_fee_numerator, PoolError.UndeterminedError);
  return feeNumerator;
}

// ---- base_fee/mod.rs: the base fee handler of a config -----------------------------------------------------------

/** BaseFeeConfig::get_base_fee_handler as a fee scheduler (modes 0 and 1). */
export function schedulerOfConfig(b: BaseFeeConfig): FeeScheduler {
  return schedulerOf(b.cliff_fee_numerator, b.first_factor, b.second_factor, b.third_factor, b.base_fee_mode);
}

/** BaseFeeHandler::get_base_fee_numerator_from_included_fee_amount of the config's handler. */
export function baseFeeNumeratorFromIncluded(b: BaseFeeConfig, currentPoint: u64, activationPoint: u64, quoteToBase: boolean, amount: u64): u64 {
  require(b.base_fee_mode <= BASE_FEE_RATE_LIMITER, PoolError.InvalidBaseFeeMode);
  if (b.base_fee_mode === BASE_FEE_RATE_LIMITER) {
    const r = rateLimiterOf(b);
    if (isRateLimiterApplied(r, currentPoint, activationPoint, quoteToBase)) return rateLimiterFeeFromIncluded(r, amount);
    return r.cliff_fee_numerator;
  }
  return schedulerBaseFeeNumerator(schedulerOfConfig(b), currentPoint, activationPoint);
}

/** BaseFeeHandler::get_base_fee_numerator_from_excluded_fee_amount of the config's handler. */
export function baseFeeNumeratorFromExcluded(b: BaseFeeConfig, currentPoint: u64, activationPoint: u64, quoteToBase: boolean, amount: u64): u64 {
  require(b.base_fee_mode <= BASE_FEE_RATE_LIMITER, PoolError.InvalidBaseFeeMode);
  if (b.base_fee_mode === BASE_FEE_RATE_LIMITER) {
    const r = rateLimiterOf(b);
    if (isRateLimiterApplied(r, currentPoint, activationPoint, quoteToBase)) return rateLimiterFeeFromExcluded(r, amount);
    return r.cliff_fee_numerator;
  }
  return schedulerBaseFeeNumerator(schedulerOfConfig(b), currentPoint, activationPoint);
}

/** BaseFeeHandler::get_min_base_fee_numerator of the config's handler. */
export function minBaseFeeNumerator(b: BaseFeeConfig): u64 {
  require(b.base_fee_mode <= BASE_FEE_RATE_LIMITER, PoolError.InvalidBaseFeeMode);
  if (b.base_fee_mode === BASE_FEE_RATE_LIMITER) return b.cliff_fee_numerator;
  return schedulerMinBaseFeeNumerator(schedulerOfConfig(b));
}

/** BaseFeeConfig::validate_min_base_fee: InvalidMinBaseFee below the minimum. */
export function validateMinBaseFee(b: BaseFeeConfig): void {
  require(minBaseFeeNumerator(b) >= MIN_FEE_NUMERATOR, PoolError.InvalidMinBaseFee);
}

/** DynamicFeeConfig::get_variable_fee_numerator: ((volatility * bin_step)^2 * control + 1e11 - 1) / 1e11. */
export function variableFeeNumerator(d: DynamicFeeConfig, v: VolatilityTracker): u128 {
  if (d.initialized === 0n) return 0n;
  const vb = mulU128(v.volatility_accumulator, u128(d.bin_step));
  // checked_pow(2), mapped to MathOverflow
  const squareVfaBin = mulU128(vb, vb);
  const vFee = mulU128(squareVfaBin, u128(d.variable_fee_control));
  return divU128(addU128(vFee, 99_999_999_999n), 100_000_000_000n);
}

/** PoolFeesConfig::get_total_fee_numerator: base + variable, capped at MAX_FEE_NUMERATOR. */
export function totalFeeNumerator(f: PoolFeesConfig, baseFeeNumerator: u64, v: VolatilityTracker): u64 {
  const total = addU128(variableFeeNumerator(f.dynamic_fee, v), u128(baseFeeNumerator));
  return total > u128(MAX_FEE_NUMERATOR) ? MAX_FEE_NUMERATOR : u64(total);
}

/** PoolFeesConfig::get_excluded_fee_amount: (amount - fee, fee), the fee rounded up. */
export function excludedFeeAmount(tradeFeeNumerator: u64, includedFeeAmount: u64): U64Pair {
  const tradingFee = safeMulDivCastU64(includedFeeAmount, tradeFeeNumerator, FEE_DENOMINATOR, true);
  return { a: subU64(includedFeeAmount, tradingFee), b: tradingFee };
}

/** PoolFeesConfig::get_included_fee_amount: (amount with fee, fee), rounded up. */
export function includedFeeAmount(tradeFeeNumerator: u64, excludedAmount: u64): U64Pair {
  const included = safeMulDivCastU64(excludedAmount, FEE_DENOMINATOR, subU64(FEE_DENOMINATOR, tradeFeeNumerator), true);
  return { a: included, b: subU64(included, excludedAmount) };
}

/** split_fees' result. */
export interface FeeSplit {
  trading_fee: u64;
  protocol_fee: u64;
  referral_fee: u64;
}

/** PoolFeesConfig::split_fees: (trading, protocol, referral). */
export function splitFees(feeAmount: u64, hasReferral: boolean): FeeSplit {
  const protocolFee = safeMulDivCastU64(feeAmount, PROTOCOL_FEE_PERCENT, 100n, false);
  const tradingFee = subU64(feeAmount, protocolFee);
  const referralFee = hasReferral ? safeMulDivCastU64(protocolFee, HOST_FEE_PERCENT, 100n, false) : 0n;
  return { trading_fee: tradingFee, protocol_fee: subU64(protocolFee, referralFee), referral_fee: referralFee };
}

// ---- state/fee.rs: VolatilityTracker ----------------------------------------------------------------------------

/** VolatilityTracker::get_delta_bin_id */
export function deltaBinId(binStepU128: u128, sqrtPriceA: u128, sqrtPriceB: u128): u128 {
  const upper = sqrtPriceA > sqrtPriceB ? sqrtPriceA : sqrtPriceB;
  const lower = sqrtPriceA > sqrtPriceB ? sqrtPriceB : sqrtPriceA;
  const priceRatio = safeShlDivCastU128(upper, lower, 64n, false);
  const deltaBin = divU128(subU128(priceRatio, ONE_Q64), binStepU128);
  return mulU128(deltaBin, 2n);
}

// ---- utils/damm_v2_utils.rs -------------------------------------------------------------------------------------

/** DAMM v2's VestingParameters as config validation builds them. */
export interface DammV2VestingParameters {
  cliff_point: u64;
  period_frequency: u64;
  cliff_unlock_liquidity: u128;
  liquidity_per_period: u128;
  number_of_period: u16;
}

/** get_max_unlocked_liquidity_at_current_point (cliff_point is always Some where DBC builds the parameters). */
export function maxUnlockedLiquidityAt(v: DammV2VestingParameters, currentPoint: u64): u128 {
  if (currentPoint < v.cliff_point) return 0n;
  if (v.period_frequency === 0n) return v.cliff_unlock_liquidity;
  const period = divU64(subU64(currentPoint, v.cliff_point), v.period_frequency);
  const p = u128(period < u64(v.number_of_period) ? period : u64(v.number_of_period));
  return addU128(v.cliff_unlock_liquidity, mulU128(p, v.liquidity_per_period));
}

/** validate_vesting_parameters */
export function validateVestingParameters(v: DammV2VestingParameters, currentPoint: u64, maxVestingDuration: u64): void {
  const cliffPoint = v.cliff_point;
  require(cliffPoint >= currentPoint, PoolError.InvalidVestingParameters);
  if (cliffPoint === currentPoint) require(v.number_of_period > 0n, PoolError.InvalidVestingParameters);
  if (v.number_of_period > 0n) require(v.period_frequency > 0n && v.liquidity_per_period > 0n, PoolError.InvalidVestingParameters);
  const vestingDuration = addU64(subU64(cliffPoint, currentPoint), mulU64(v.period_frequency, u64(v.number_of_period)));
  require(vestingDuration <= maxVestingDuration, PoolError.InvalidVestingParameters);
  const totalLock = addU128(v.cliff_unlock_liquidity, mulU128(v.liquidity_per_period, u128(v.number_of_period)));
  require(totalLock > 0n, PoolError.InvalidVestingParameters);
}

/** calculate_dynamic_fee_params: the variable fee control for DAMM v2's default dynamic fee. */
export function dammV2VariableFeeControl(baseFeeNumerator: u64): u32 {
  const maxDynamicFeeNumerator = divU128(mulU128(u128(baseFeeNumerator), MAX_DYNAMIC_FEE_PERCENT), 100n);
  const vFee = subU128(mulU128(maxDynamicFeeNumerator, 100_000_000_000n), 99_999_999_999n);
  const control = divU128(vFee, SQUARE_VFA_BIN);
  require(control <= 4294967295n, PoolError.TypeCastFailed);
  return u32(control);
}

/** DammV2PodAlignedFeeMarketCapScheduler (the fields config validation fills in). */
export interface DammV2MarketCapScheduler {
  cliff_fee_numerator: u64;
  base_fee_mode: u8;
  number_of_period: u16;
  sqrt_price_step_bps: u32;
  scheduler_expiration_duration: u32;
  reduction_factor: u64;
}

function marketCapFeeByPeriod(s: DammV2MarketCapScheduler, period: u64): u64 {
  const p = period < u64(s.number_of_period) ? period : u64(s.number_of_period);
  // BaseFeeMode::try_from: TypeCastFailed past the enum; the time and rate limiter modes are UndeterminedError.
  require(s.base_fee_mode <= DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL, PoolError.TypeCastFailed);
  if (s.base_fee_mode === DAMM_V2_FEE_MARKET_CAP_SCHEDULER_LINEAR) return subU64(s.cliff_fee_numerator, mulU64(s.reduction_factor, p));
  require(s.base_fee_mode === DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL, PoolError.UndeterminedError);
  return getFeeInPeriod(s.cliff_fee_numerator, s.reduction_factor, p);
}

/** DammV2PodAlignedFeeMarketCapScheduler::get_min_base_fee_numerator */
export function marketCapMinBaseFeeNumerator(s: DammV2MarketCapScheduler): u64 {
  return marketCapFeeByPeriod(s, u64(s.number_of_period));
}

/** DammV2PodAlignedFeeMarketCapScheduler::validate */
export function validateMarketCapScheduler(s: DammV2MarketCapScheduler): void {
  require(s.reduction_factor > 0n, PoolError.InvalidFeeMarketCapScheduler);
  require(s.sqrt_price_step_bps > 0n, PoolError.InvalidFeeMarketCapScheduler);
  require(s.scheduler_expiration_duration > 0n, PoolError.InvalidFeeMarketCapScheduler);
  require(s.number_of_period > 0n, PoolError.InvalidFeeMarketCapScheduler);
  const minFeeNumerator = marketCapMinBaseFeeNumerator(s);
  const maxFeeNumerator = s.cliff_fee_numerator;
  validateFeeFraction(minFeeNumerator, DAMM_V2_FEE_DENOMINATOR);
  validateFeeFraction(maxFeeNumerator, DAMM_V2_FEE_DENOMINATOR);
  // get_max_fee_numerator(CURRENT_POOL_VERSION = 1)
  require(minFeeNumerator >= DAMM_V2_MIN_FEE_NUMERATOR && maxFeeNumerator <= DAMM_V2_MAX_FEE_NUMERATOR_V1, PoolError.ExceedMaxFeeBps);
}

// ---- state/fee.rs: FeeMode ----------------------------------------------------------------------------------------

/** FeeMode (has_referral is the caller's). */
export interface FeeMode {
  fees_on_input: boolean;
  fees_on_base_token: boolean;
}

/** FeeMode::get_fee_mode. */
export function feeMode(collectFeeMode: u8, quoteToBase: boolean): FeeMode {
  require(collectFeeMode <= 1n, PoolError.InvalidCollectFeeMode);
  if (collectFeeMode === 1n) return { fees_on_input: false, fees_on_base_token: quoteToBase };
  return { fees_on_input: quoteToBase, fees_on_base_token: false };
}
