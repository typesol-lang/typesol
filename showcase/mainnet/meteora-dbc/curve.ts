// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), licensed under Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// The curve math (programs/dynamic-bonding-curve/src/curve.rs): amounts between two Q64.64 sqrt prices at a given
// liquidity, and the next sqrt price after an amount in or out, each with the original's rounding. `assert!`s panic.
import { type u64, panic, require, u128, u256 } from "typesol";
import { PoolError } from "./errors";
import { type U64Pair, U64_MAX, addU256, castU128, castU256ToU64, divCeilU256, divU256, mulDivU256, mulU256, shlU256, subU256 } from "./math";

export const RESOLUTION: u64 = 64n;

/** get_initialize_amounts: the base above and the quote below `sqrtPrice` at `liquidity`, both rounded up. */
export function getInitializeAmounts(sqrtMinPrice: u128, sqrtMaxPrice: u128, sqrtPrice: u128, liquidity: u128): U64Pair {
  const amountBase = getDeltaAmountBaseUnsigned(sqrtPrice, sqrtMaxPrice, liquidity, true);
  const amountQuote = getDeltaAmountQuoteUnsigned(sqrtMinPrice, sqrtPrice, liquidity, true);
  return { a: amountBase, b: amountQuote };
}

/** get_delta_amount_base_unsigned: Δa = L * (√P_upper - √P_lower) / (√P_upper * √P_lower), as a u64. */
export function getDeltaAmountBaseUnsigned(lowerSqrtPrice: u128, upperSqrtPrice: u128, liquidity: u128, up: boolean): u64 {
  const result = getDeltaAmountBaseUnsigned256(lowerSqrtPrice, upperSqrtPrice, liquidity, up);
  require(result <= u256(U64_MAX), PoolError.MathOverflow);
  return castU256ToU64(result);
}

/** get_delta_amount_base_unsigned_256 / _unchecked. */
export function getDeltaAmountBaseUnsigned256(lowerSqrtPrice: u128, upperSqrtPrice: u128, liquidity: u128, up: boolean): u256 {
  const numerator1 = u256(liquidity);
  // A bare u128 subtraction in the original: it panics when the prices are the wrong way round.
  const numerator2 = u256(upperSqrtPrice - lowerSqrtPrice);
  const denominator = mulU256(u256(lowerSqrtPrice), u256(upperSqrtPrice));
  if (!(denominator > 0n)) panic("assertion failed: denominator > U256::ZERO");
  return mulDivU256(numerator1, numerator2, denominator, up);
}

/** get_delta_amount_quote_unsigned: Δb = L * (√P_upper - √P_lower), as a u64. */
export function getDeltaAmountQuoteUnsigned(lowerSqrtPrice: u128, upperSqrtPrice: u128, liquidity: u128, up: boolean): u64 {
  const result = getDeltaAmountQuoteUnsigned256(lowerSqrtPrice, upperSqrtPrice, liquidity, up);
  require(result <= u256(U64_MAX), PoolError.MathOverflow);
  return castU256ToU64(result);
}

/** get_delta_amount_quote_unsigned_256 / _unchecked: L * Δ√P >> 128, rounded as asked. */
export function getDeltaAmountQuoteUnsigned256(lowerSqrtPrice: u128, upperSqrtPrice: u128, liquidity: u128, up: boolean): u256 {
  const l = u256(liquidity);
  const deltaSqrtPrice = u256(upperSqrtPrice - lowerSqrtPrice);
  const prod = mulU256(l, deltaSqrtPrice);
  if (up) {
    const denominator = shlU256(1n, RESOLUTION * 2n);
    return divCeilU256(prod, denominator);
  }
  return prod >> (RESOLUTION * 2n);
}

/** get_next_sqrt_price_from_input: base in (rounding up) or quote in (rounding down). */
export function getNextSqrtPriceFromInput(sqrtPrice: u128, liquidity: u128, amountIn: u64, baseForQuote: boolean): u128 {
  if (!(sqrtPrice > 0n)) panic("assertion failed: sqrt_price > 0");
  if (!(liquidity > 0n)) panic("assertion failed: liquidity > 0");
  if (baseForQuote) return getNextSqrtPriceFromBaseAmountInRoundingUp(sqrtPrice, liquidity, amountIn);
  return getNextSqrtPriceFromQuoteAmountInRoundingDown(sqrtPrice, liquidity, amountIn);
}

/** get_next_sqrt_price_from_output: quote out (rounding down) or base out (rounding up). */
export function getNextSqrtPriceFromOutput(sqrtPrice: u128, liquidity: u128, amountOut: u64, baseForQuote: boolean): u128 {
  if (!(sqrtPrice > 0n)) panic("assertion failed: sqrt_price > 0");
  if (!(liquidity > 0n)) panic("assertion failed: liquidity > 0");
  if (baseForQuote) return getNextSqrtPriceFromQuoteAmountOutRoundingDown(sqrtPrice, liquidity, amountOut);
  return getNextSqrtPriceFromBaseAmountOutRoundingUp(sqrtPrice, liquidity, amountOut);
}

/** √P' = √P - Δy / L, the quotient rounded up. */
export function getNextSqrtPriceFromQuoteAmountOutRoundingDown(sqrtPrice: u128, liquidity: u128, amount: u64): u128 {
  const l = u256(liquidity);
  const qAmount = shlU256(u256(amount), 128n);
  const quotient = divCeilU256(qAmount, l);
  return castU128(subU256(u256(sqrtPrice), quotient));
}

/** √P' = √P * L / (L - Δx * √P), rounded up. */
export function getNextSqrtPriceFromBaseAmountOutRoundingUp(sqrtPrice: u128, liquidity: u128, amount: u64): u128 {
  if (amount === 0n) return sqrtPrice;
  const p = u256(sqrtPrice);
  const l = u256(liquidity);
  const product = mulU256(u256(amount), p);
  const denominator = subU256(l, product);
  require(denominator !== 0n, PoolError.TypeCastFailed);
  return castU128(mulDivU256(l, p, denominator, true));
}

/** √P' = √P * L / (L + Δx * √P), rounded up. */
export function getNextSqrtPriceFromBaseAmountInRoundingUp(sqrtPrice: u128, liquidity: u128, amount: u64): u128 {
  if (amount === 0n) return sqrtPrice;
  const p = u256(sqrtPrice);
  const l = u256(liquidity);
  const product = mulU256(u256(amount), p);
  const denominator = addU256(l, product);
  require(denominator !== 0n, PoolError.MathOverflow);
  return castU128(mulDivU256(l, p, denominator, true));
}

/** √P' = √P + Δy / L, rounded down. */
export function getNextSqrtPriceFromQuoteAmountInRoundingDown(sqrtPrice: u128, liquidity: u128, amount: u64): u128 {
  const quotient = divU256(shlU256(u256(amount), RESOLUTION * 2n), u256(liquidity));
  return castU128(addU256(u256(sqrtPrice), quotient));
}
