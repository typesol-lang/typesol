// A port of Raydium AMM v4 (raydium-io/raydium-amm, program/src, d26944b), Copyright Raydium, licensed under the
// Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// math.rs: the decimal normalization, the constant-product swap amounts and the exchange rates of deposits and
// withdrawals. The original works in the `uint` crate's U128 / U256 with `checked_*().unwrap()`; here u128 / u256
// with checked arithmetic, which the program turns into the same panic (PANIC_ON_OVERFLOW). `as_u64()` on a U128 past
// u64 panics too, as u64(x) does here.
import { isqrt, panic, require, u128, u256, u64 } from "typesol";
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

const NONE = "called `Option::unwrap()` on a `None` value";

/**
 * Calculator::swap_token_amount_base_out: the input that buys an output (rounded up). Asking for the whole side or
 * more panics where the original's unwraps do (its checked_sub, then its checked_ceil_div by zero).
 */
export function swapTokenAmountBaseOut(amountOut: u128, totalPc: u128, totalCoin: u128, direction: u64): u128 {
  if (direction === COIN2PC) {
    if (amountOut > totalPc) panic(NONE, "program/src/math.rs:341:85");
    if (amountOut === totalPc) panic(NONE, "program/src/math.rs:346:22");
    return ceilDiv(totalCoin * amountOut, totalPc - amountOut);
  }
  if (amountOut > totalCoin) panic(NONE, "program/src/math.rs:358:87");
  if (amountOut === totalCoin) panic(NONE, "program/src/math.rs:363:22");
  return ceilDiv(totalPc * amountOut, totalCoin - amountOut);
}

const U64_OVERFLOW = "Integer overflow when casting to u64";
// as_u64 panics inside the U128 that construct_uint! defines at math.rs:14:1.
const UINT_AS_U64 = "program/src/math.rs:14:1";

/** InvariantToken::exchange_coin_to_pc (ceiling): token_coin * pc / coin, rounded up. */
export function exchangeCoinToPcCeil(tokenCoin: u64, pc: u64, coin: u64): u64 {
  if (coin === 0n) panic(NONE, "program/src/math.rs:397:18");
  const q = ceilDiv(u128(tokenCoin) * u128(pc), u128(coin));
  if (q > 18446744073709551615n) panic(U64_OVERFLOW, UINT_AS_U64);
  return u64(q);
}
/** InvariantToken::exchange_pc_to_coin (ceiling). */
export function exchangePcToCoinCeil(tokenPc: u64, coin: u64, pc: u64): u64 {
  if (pc === 0n) panic(NONE, "program/src/math.rs:420:18");
  const q = ceilDiv(u128(tokenPc) * u128(coin), u128(pc));
  if (q > 18446744073709551615n) panic(U64_OVERFLOW, UINT_AS_U64);
  return u64(q);
}
/** InvariantPool::exchange_pool_to_token (floor): total * input / pool total. */
export function exchangePoolToTokenFloor(total: u64, input: u64, poolTotal: u64): u64 {
  if (poolTotal === 0n) panic(NONE, "program/src/math.rs:445:18");
  const q = (u128(total) * u128(input)) / u128(poolTotal);
  if (q > 18446744073709551615n) panic(U64_OVERFLOW, UINT_AS_U64);
  return u64(q);
}
/** InvariantPool::exchange_token_to_pool (floor): pool total * input / token total. */
export function exchangeTokenToPoolFloor(poolTotal: u64, input: u64, total: u64): u64 {
  if (total === 0n) panic(NONE, "program/src/math.rs:467:18");
  const q = (u128(poolTotal) * u128(input)) / u128(total);
  if (q > 18446744073709551615n) panic(U64_OVERFLOW, UINT_AS_U64);
  return u64(q);
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
