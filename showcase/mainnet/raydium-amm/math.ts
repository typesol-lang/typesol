// A port of Raydium AMM v4 (raydium-io/raydium-amm, program/src, d26944b), Copyright Raydium, licensed under the
// Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// math.rs: the decimal normalization, the constant-product swap amounts and the exchange rates of deposits and
// withdrawals. The original works in the `uint` crate's U128 / U256 with `checked_*().unwrap()`; here u128 / u256
// with checked arithmetic, which the program turns into the same panic (PANIC_ON_OVERFLOW). `as_u64()` on a U128 past
// u64 panics too, as u64(x) does here.
import { type u128, type u256, type u64, isqrt, panic, require, u128, u256, u64 } from "typesol";
import { type AmmInfo, AmmError } from "./state.js";

/** SwapDirection. */
export const PC2COIN = 1n;
export const COIN2PC = 2n;

/** Calculator::to_u64: a u128 that does not fit is ConversionFailure (an error, not a panic). */
export function toU64(val: u128): u64 {
  require(val <= 18446744073709551615n, AmmError.ConversionFailure);
  return u64(val);
}

function pow10(n: u64): u128 {
  // U128::from(10).checked_pow(n).unwrap(): 10^39 and past overflow.
  if (n > 38n) panic("called `Option::unwrap()` on a `None` value");
  let r: u128 = 1n;
  for (let i = 0n; i < n; i++) r *= 10n;
  return r;
}

/** Calculator::normalize_decimal_v2: val * sys_decimal_value / 10^native_decimal, as a U128. */
export function normalizeDecimalV2(val: u64, nativeDecimal: u64, sysDecimalValue: u64): u128 {
  return (u128(val) * u128(sysDecimalValue)) / pow10(nativeDecimal);
}

/** Calculator::restore_decimal: val * 10^native_decimal / sys_decimal_value. */
export function restoreDecimal(val: u128, nativeDecimal: u64, sysDecimalValue: u64): u128 {
  return (val * pow10(nativeDecimal)) / u128(sysDecimalValue);
}

/** Calculator::calc_x_power: last_x * last_y * current_x / current_y in U256. */
export function calcXPower(lastX: u256, lastY: u256, currentX: u256, currentY: u256): u256 {
  return (lastX * lastY * currentX) / currentY;
}

/** CheckedCeilDiv on u128 / U128: the quotient rounded up (None, and so a panic, on a zero divisor). */
export function ceilDiv(a: u128, b: u128): u128 {
  const q = a / b;
  return a % b !== 0n ? q + 1n : q;
}

/** Calculator::calc_total_without_take_pnl_no_orderbook: the vaults less the P&L owed. */
export function totalPcWithoutTakePnl(pcAmount: u64, amm: AmmInfo): u64 {
  require(pcAmount >= amm.stateData.needTakePnlPc, AmmError.CheckedSubOverflow);
  return pcAmount - amm.stateData.needTakePnlPc;
}
export function totalCoinWithoutTakePnl(coinAmount: u64, amm: AmmInfo): u64 {
  require(coinAmount >= amm.stateData.needTakePnlCoin, AmmError.CheckedSubOverflow);
  return coinAmount - amm.stateData.needTakePnlCoin;
}

/** Calculator::swap_token_amount_base_in: the constant-product output for an input (rounded down). */
export function swapTokenAmountBaseIn(amountIn: u128, totalPc: u128, totalCoin: u128, direction: u64): u128 {
  if (direction === COIN2PC) return (totalPc * amountIn) / (totalCoin + amountIn);
  return (totalCoin * amountIn) / (totalPc + amountIn);
}

/** Calculator::swap_token_amount_base_out: the input that buys an output (rounded up). */
export function swapTokenAmountBaseOut(amountOut: u128, totalPc: u128, totalCoin: u128, direction: u64): u128 {
  if (direction === COIN2PC) return ceilDiv(totalCoin * amountOut, totalPc - amountOut);
  return ceilDiv(totalPc * amountOut, totalCoin - amountOut);
}

/** InvariantToken::exchange_coin_to_pc / exchange_pc_to_coin and InvariantPool's: a * b / c, floor or ceiling. */
export function mulDiv(a: u64, b: u64, c: u64, ceiling: boolean): u64 {
  const p = u128(a) * u128(b);
  return u64(ceiling ? ceilDiv(p, u128(c)) : p / u128(c));
}

/** U256::integer_sqrt / U128::integer_sqrt. */
export function sqrt256(x: u256): u256 {
  return isqrt(x);
}
export function sqrt128(x: u128): u128 {
  return isqrt(x);
}

export function toU256(x: u128): u256 {
  return u256(x);
}
