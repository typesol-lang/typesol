// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// The migration handlers (programs/dynamic-bonding-curve/src/migration_handler/: mod.rs, compounding_liquidity.rs,
// concentrated_liquidity.rs) and PoolConfig::get_migration_quote_amount. The original's `Box<dyn MigrationHandler>` is
// a `compounding` flag here: compounding liquidity for DAMM v1 and for DAMM v2's compounding fee mode, concentrated
// liquidity otherwise.
import { type u8, type u16, require, u64, u128, u256 } from "typesol";
import { getDeltaAmountBaseUnsigned, getDeltaAmountBaseUnsigned256 } from "./curve";
import { PoolError } from "./errors";
import {
  type U64Pair,
  BASIS_POINT_MAX,
  U64_MAX,
  addU256,
  castU128,
  castU256ToU64,
  divU256,
  mulU128,
  mulU256,
  safeMulDivCastU128,
  safeMulDivCastU64,
  shlU256,
  sqrtU256,
  subU128,
  subU64,
} from "./math";
import { MIGRATED_COLLECT_FEE_MODE_COMPOUNDING, MIGRATION_OPTION_METEORA_DAMM } from "./state";

export const MIN_SQRT_PRICE: u128 = 4295048016n;
export const MAX_SQRT_PRICE: u128 = 79226673521066979257578248091n;
/** DAMM v2's dead liquidity of a compounding pool, 100 << 64. */
export const DAMM_V2_COMPOUNDING_DEAD_LIQUIDITY: u128 = 1844674407370955161600n;

/** get_migration_handler: whether the migration uses compounding liquidity (else concentrated). */
export function isCompoundingMigration(migrationOption: u8, migratedCollectFeeMode: u8): boolean {
  return migrationOption === MIGRATION_OPTION_METEORA_DAMM || migratedCollectFeeMode === MIGRATED_COLLECT_FEE_MODE_COMPOUNDING;
}

/** PoolConfig::get_migration_quote_amount: [quote_amount, fee], the quote amount rounded up. */
export function migrationQuoteAmount(migrationQuoteThreshold: u64, migrationFeePercentage: u8): U64Pair {
  const quoteAmount = safeMulDivCastU64(migrationQuoteThreshold, subU64(100n, u64(migrationFeePercentage)), 100n, true);
  return { a: quoteAmount, b: subU64(migrationQuoteThreshold, quoteAmount) };
}

/** calculate_compounding_initial_sqrt_price_and_liquidity's Option<(u128, u128)>. */
export interface CompoundingInitial {
  some: boolean;
  sqrt_price: u128;
  liquidity: u128;
}

// ---- compounding_liquidity.rs ---------------------------------------------------------------------------------

/**
 * calculate_compounding_initial_sqrt_price_and_liquidity: [sqrt price rounded up, liquidity from the price rounded
 * down], or null where the original returns None (a price outside DAMM v2's range, a liquidity past u128).
 */
export function compoundingInitialSqrtPriceAndLiquidity(tokenAAmount: u64, tokenBAmount: u64): CompoundingInitial {
  // U256(b).checked_shl(128): 192 bits at most, never None. div_ceil by a zero amount panics, as ruint's does.
  const shifted = u256(tokenBAmount) << 128n;
  const a = u256(tokenAAmount);
  const ceil = shifted % a === 0n ? shifted / a : shifted / a + 1n;
  const s1 = sqrtU256(ceil);
  const none: CompoundingInitial = { some: false, sqrt_price: 0n, liquidity: 0n };
  if (s1 > u256(340282366920938463463374607431768211455n)) return none;
  const sqrtPrice1 = u128(s1);
  if (sqrtPrice1 < MIN_SQRT_PRICE || sqrtPrice1 > MAX_SQRT_PRICE) return none;
  const s2 = sqrtU256(shifted / a);
  if (s2 > u256(340282366920938463463374607431768211455n)) return none;
  const sqrtPrice2 = u128(s2);
  const amountA = u128(tokenAAmount);
  if (amountA !== 0n && sqrtPrice2 > 340282366920938463463374607431768211455n / amountA) return none;
  return { some: true, sqrt_price: sqrtPrice1, liquidity: sqrtPrice2 * amountA };
}

/** CompoundingLiquidity::validate_initial_pool_information */
export function validateCompoundingInitialPool(baseAmount: u64, quoteAmount: u64, migrationSqrtPrice: u128): void {
  const r = compoundingInitialSqrtPriceAndLiquidity(baseAmount, quoteAmount);
  require(r.some, PoolError.MathOverflow);
  const sqrtPrice = r.sqrt_price;
  const totalLiquidity = r.liquidity;
  require(sqrtPrice >= MIN_SQRT_PRICE && sqrtPrice <= MAX_SQRT_PRICE, PoolError.InvalidCompoundingParameters);
  require(totalLiquidity > DAMM_V2_COMPOUNDING_DEAD_LIQUIDITY, PoolError.InsufficientLiquidityForMigration);
  const absDiff = migrationSqrtPrice > sqrtPrice ? migrationSqrtPrice - sqrtPrice : sqrtPrice - migrationSqrtPrice;
  const larger = migrationSqrtPrice > sqrtPrice ? migrationSqrtPrice : sqrtPrice;
  require(mulU128(absDiff, 100n) <= larger, PoolError.InvalidCurve);
}

/** CompoundingLiquidity::get_migration_protocol_fees: both amounts times the fee bps, rounded down. */
export function compoundingProtocolFees(depositBaseAmount: u64, depositQuoteAmount: u64, migrationFeeBps: u16): U64Pair {
  const baseFee = safeMulDivCastU64(depositBaseAmount, u64(migrationFeeBps), BASIS_POINT_MAX, false);
  const quoteFee = safeMulDivCastU64(depositQuoteAmount, u64(migrationFeeBps), BASIS_POINT_MAX, false);
  return { a: baseFee, b: quoteFee };
}

/** get_constant_product_base_from_quote: quote / price, rounded up. */
export function constantProductBaseFromQuote(quoteAmount: u64, sqrtMigrationPrice: u128): u64 {
  const s = u256(sqrtMigrationPrice);
  const price = mulU256(s, s);
  const quote = shlU256(u256(quoteAmount), 128n);
  // div_rem by price: the price is never zero here (the migration price is at least the start price)
  let base = quote / price;
  if (quote % price !== 0n) base = addU256(base, 1n);
  require(base <= u256(U64_MAX), PoolError.MathOverflow);
  return castU256ToU64(base);
}

/** CompoundingLiquidity::get_migration_deposit_amounts */
export function compoundingDepositAmounts(baseBudget: u64, quoteBudget: u64, baseAmount: u64, quoteAmount: u64): U64Pair {
  if (baseAmount === baseBudget && quoteAmount === quoteBudget) return { a: baseBudget, b: quoteBudget };
  const baseSideBinds = mulU128(u128(baseAmount), u128(quoteBudget)) <= mulU128(u128(quoteAmount), u128(baseBudget));
  let base = baseAmount;
  let quote = quoteAmount;
  if (baseSideBinds) quote = safeMulDivCastU64(quoteBudget, baseAmount, baseBudget, false);
  else base = safeMulDivCastU64(baseBudget, quoteAmount, quoteBudget, true);
  require(base > 0n && quote > 0n, PoolError.AmountIsZero);
  return { a: base, b: quote };
}

/** CompoundingLiquidity::calculate_liquidity_delta */
export function compoundingLiquidityDelta(baseAmount: u64, quoteAmount: u64, poolBaseReserve: u64, poolQuoteReserve: u64, poolLiquidity: u128): u128 {
  const fromBase = safeMulDivCastU128(u128(baseAmount), poolLiquidity, u128(poolBaseReserve), false);
  const fromQuote = safeMulDivCastU128(u128(quoteAmount), poolLiquidity, u128(poolQuoteReserve), false);
  return fromBase < fromQuote ? fromBase : fromQuote;
}

// ---- concentrated_liquidity.rs --------------------------------------------------------------------------------

/** get_initial_liquidity_from_delta_quote: L = Δb << 128 / (√P - √P_min), rounded down. */
export function initialLiquidityFromDeltaQuote(quoteAmount: u64, sqrtMinPrice: u128, sqrtPrice: u128): u128 {
  const priceDelta = u256(subU128(sqrtPrice, sqrtMinPrice));
  const q = shlU256(u256(quoteAmount), 128n);
  return castU128(divU256(q, priceDelta));
}

/**
 * calculate_concentrated_initial_liquidity: the smaller of the liquidity the base amount gives (over [√P, √P_max])
 * and the one the quote amount gives. The original computes the base side in U512
 * (Δa * √P * √P_max / (√P_max - √P)), which can pass 2^256; it is compared here without forming it: it is greater
 * than the quote side's u128 exactly when Δa * √P * √P_max >= (quote side + 1) * (√P_max - √P).
 */
export function concentratedInitialLiquidity(baseAmount: u64, quoteAmount: u64, migrationSqrtPrice: u128): u128 {
  // get_initial_liquidity_from_delta_base: price_delta (safe_sub), then the U512 product and its quotient (safe_div)
  const priceDelta = subU128(MAX_SQRT_PRICE, migrationSqrtPrice);
  require(priceDelta !== 0n, PoolError.MathOverflow);
  const fromQuote = initialLiquidityFromDeltaQuote(quoteAmount, MIN_SQRT_PRICE, migrationSqrtPrice);
  // a = Δa * √P fits in 192 bits; the product a * √P_max is compared with t = (fromQuote + 1) * Δ (at most 226 bits).
  const a = u256(baseAmount) * u256(migrationSqrtPrice);
  const t = (u256(fromQuote) + 1n) * u256(priceDelta);
  const m = u256(MAX_SQRT_PRICE);
  const tOverM = t % m === 0n ? t / m : t / m + 1n;
  if (a >= tOverM) return fromQuote;
  // Here the base side is at most fromQuote, so its quotient fits a u128.
  return castU128((a * m) / u256(priceDelta));
}

/** ConcentratedLiquidity::get_migration_protocol_fees */
export function concentratedProtocolFees(depositQuoteAmount: u64, migrationFeeBps: u16, migrationSqrtPrice: u128): U64Pair {
  const quoteFee = safeMulDivCastU64(depositQuoteAmount, u64(migrationFeeBps), BASIS_POINT_MAX, false);
  const feeLiquidity = initialLiquidityFromDeltaQuote(quoteFee, MIN_SQRT_PRICE, migrationSqrtPrice);
  const baseFee = getDeltaAmountBaseUnsigned(migrationSqrtPrice, MAX_SQRT_PRICE, feeLiquidity, false);
  return { a: baseFee, b: quoteFee };
}

/** MigrationHandler::get_included_protocol_fee_migration_amounts_1 (config creation): [base, quote]. */
export function includedProtocolFeeMigrationAmounts1(compounding: boolean, migrationSqrtPrice: u128, migrationQuoteThreshold: u64, migrationFeePercentage: u8): U64Pair {
  const quoteAmount = migrationQuoteAmount(migrationQuoteThreshold, migrationFeePercentage).a;
  if (compounding) return { a: constantProductBaseFromQuote(quoteAmount, migrationSqrtPrice), b: quoteAmount };
  const liquidity = initialLiquidityFromDeltaQuote(quoteAmount, MIN_SQRT_PRICE, migrationSqrtPrice);
  const baseAmount = getDeltaAmountBaseUnsigned256(migrationSqrtPrice, MAX_SQRT_PRICE, liquidity, true);
  require(baseAmount <= u256(U64_MAX), PoolError.MathOverflow);
  return { a: castU256ToU64(baseAmount), b: quoteAmount };
}

/** MigrationHandler::get_included_protocol_fee_migration_amounts_2 (migration): [base, quote]. */
export function includedProtocolFeeMigrationAmounts2(
  compounding: boolean,
  migrationBaseThreshold: u64,
  migrationQuoteThreshold: u64,
  migrationFeePercentage: u8,
  excludedFeeBaseReserve: u64,
): U64Pair {
  if (compounding) require(excludedFeeBaseReserve >= migrationBaseThreshold, PoolError.UndeterminedError);
  const quoteAmount = migrationQuoteAmount(migrationQuoteThreshold, migrationFeePercentage).a;
  return { a: compounding ? migrationBaseThreshold : excludedFeeBaseReserve, b: quoteAmount };
}

/** ConcentratedLiquidity::get_migration_deposit_amounts */
export function concentratedDepositAmounts(baseAmount: u64, quoteAmount: u64): U64Pair {
  require(baseAmount > 0n && quoteAmount > 0n, PoolError.AmountIsZero);
  return { a: baseAmount, b: quoteAmount };
}
