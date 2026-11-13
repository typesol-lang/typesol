// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// The math modules (programs/dynamic-bonding-curve/src/math/: safe_math.rs, u128x128_math.rs, utils_math.rs,
// fee_math.rs). ruint's U256 is u256 here.
//
// - Every `safe_*` of the original (checked_*, then PoolError::MathOverflow) is a `require(…, MathOverflow)` before the
//   operation, so it fails with the same code. The original also logs "Math error thrown at <file>:<line>"; this port
//   does not (a log difference only).
// - `safe_cast` / `try_into` fail with TypeCastFailed where the original maps them so.
// - Bare operators of the original panic under `overflow-checks = true` (and ruint's `div_ceil` panics on zero): they
//   are bare here too, and the program sets PANIC_ON_OVERFLOW so they panic as Rust does (ProgramFailedToComplete).
import { type u8, type u16, isqrt, mulDiv, mulDivCeil, require, u64, u128, u256 } from "typesol";
import { PoolError } from "./errors";

export const U16_MAX: u16 = 65535n;
export const U64_MAX: u64 = 18446744073709551615n;
export const U128_MAX: u128 = 340282366920938463463374607431768211455n;
export const U256_MAX: u256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
/** constants.rs */
export const ONE_Q64: u128 = 18446744073709551616n;
export const BASIS_POINT_MAX: u64 = 10_000n;
const SCALE_OFFSET: u64 = 64n;
/** fee_math.rs: 2^19, no point computing a Q64.64 power of a larger exponent. */
const MAX_EXPONENTIAL: u64 = 0x80000n;

// ---- safe_math.rs: checked operations failing with MathOverflow ---------------------------------------------------

export function addU16(a: u16, b: u16): u16 {
  require(a <= U16_MAX - b, PoolError.MathOverflow);
  return a + b;
}
export function mulU16(a: u16, b: u16): u16 {
  require(b === 0n || a <= U16_MAX / b, PoolError.MathOverflow);
  return a * b;
}
export function addU8(a: u8, b: u8): u8 {
  require(a <= 255n - b, PoolError.MathOverflow);
  return a + b;
}
export function addU64(a: u64, b: u64): u64 {
  require(a <= U64_MAX - b, PoolError.MathOverflow);
  return a + b;
}
export function subU64(a: u64, b: u64): u64 {
  require(a >= b, PoolError.MathOverflow);
  return a - b;
}
export function mulU64(a: u64, b: u64): u64 {
  require(b === 0n || a <= U64_MAX / b, PoolError.MathOverflow);
  return a * b;
}
export function divU64(a: u64, b: u64): u64 {
  require(b !== 0n, PoolError.MathOverflow);
  return a / b;
}
export function addU128(a: u128, b: u128): u128 {
  require(a <= U128_MAX - b, PoolError.MathOverflow);
  return a + b;
}
export function subU128(a: u128, b: u128): u128 {
  require(a >= b, PoolError.MathOverflow);
  return a - b;
}
export function mulU128(a: u128, b: u128): u128 {
  require(b === 0n || a <= U128_MAX / b, PoolError.MathOverflow);
  return a * b;
}
export function divU128(a: u128, b: u128): u128 {
  require(b !== 0n, PoolError.MathOverflow);
  return a / b;
}
export function addU256(a: u256, b: u256): u256 {
  require(a <= U256_MAX - b, PoolError.MathOverflow);
  return a + b;
}
export function subU256(a: u256, b: u256): u256 {
  require(a >= b, PoolError.MathOverflow);
  return a - b;
}
export function mulU256(a: u256, b: u256): u256 {
  require(b === 0n || a <= U256_MAX / b, PoolError.MathOverflow);
  return a * b;
}
export function divU256(a: u256, b: u256): u256 {
  require(b !== 0n, PoolError.MathOverflow);
  return a / b;
}
/** ruint's checked_shl (safe_shl on U256): fails when the shift is not below 256 or bits would be lost. */
export function shlU256(a: u256, n: u64): u256 {
  require(n < 256n && a <= U256_MAX >> n, PoolError.MathOverflow);
  return a << n;
}
/** u128 → u64 (`safe_cast`, `try_into` mapped to TypeCastFailed). */
export function castU64(x: u128): u64 {
  require(x <= u128(U64_MAX), PoolError.TypeCastFailed);
  return u64(x);
}
/** U256 → u128 (`try_into` mapped to TypeCastFailed). */
export function castU128(x: u256): u128 {
  require(x <= u256(U128_MAX), PoolError.TypeCastFailed);
  return u128(x);
}
/** U256 → u64 (`try_into` mapped to TypeCastFailed). */
export function castU256ToU64(x: u256): u64 {
  require(x <= u256(U64_MAX), PoolError.TypeCastFailed);
  return u64(x);
}

/** ruint's div_ceil: the quotient rounded up; a zero divisor panics, as ruint's does. */
export function divCeilU256(a: u256, b: u256): u256 {
  const q = a / b;
  return a % b === 0n ? q : q + 1n;
}

// ---- u128x128_math.rs -------------------------------------------------------------------------------------------

/** Two u64 results (the original returns a tuple). */
export interface U64Pair {
  a: u64;
  b: u64;
}

/**
 * mul_div_u256: (x * y) / denominator through a 512-bit product. The original returns None for a zero denominator
 * (each caller maps that to its own error, so callers check it first) and when the quotient exceeds U256::MAX: every
 * caller passes x and y below 2^128 (liquidity, sqrt prices and their differences), so the quotient stays below 2^256
 * and that case does not arise.
 */
export function mulDivU256(x: u256, y: u256, denominator: u256, up: boolean): u256 {
  return up ? mulDivCeil(x, y, denominator) : mulDiv(x, y, denominator);
}

// ---- utils_math.rs ----------------------------------------------------------------------------------------------

/** safe_mul_shr_cast::<u128> (mul_shr: (x * y) >> offset in U256, None when it is not a u128 → MathOverflow). */
export function safeMulShrCastU128(x: u128, y: u128, offset: u64): u128 {
  const q = (u256(x) * u256(y)) >> offset;
  require(q <= u256(U128_MAX), PoolError.MathOverflow);
  return u128(q);
}

/** safe_mul_shr_cast::<u64>: as safeMulShrCastU128, TypeCastFailed when the result is not a u64. */
export function safeMulShrCastU64(x: u128, y: u128, offset: u64): u64 {
  return castU64(safeMulShrCastU128(x, y, offset));
}

/** safe_mul_div_cast_u64 as a u128 (its T = u128 callers): (x * y) / denominator in u128, rounded as asked. */
export function safeMulDivU64(x: u64, y: u64, denominator: u64, up: boolean): u128 {
  const prod = mulU128(u128(x), u128(y));
  const d = u128(denominator);
  if (up) return divU128(subU128(addU128(prod, d), 1n), d);
  return divU128(prod, d);
}

/** safe_mul_div_cast_u64::<u64>: as safeMulDivU64, TypeCastFailed when the result is not a u64. */
export function safeMulDivCastU64(x: u64, y: u64, denominator: u64, up: boolean): u64 {
  return castU64(safeMulDivU64(x, y, denominator, up));
}

/** safe_mul_div_cast_u128: (x * y) / denominator in U256, TypeCastFailed when the result is not a u128. */
export function safeMulDivCastU128(x: u128, y: u128, denominator: u128, up: boolean): u128 {
  const prod = mulU256(u256(x), u256(y));
  const d = u256(denominator);
  if (up) return castU128(divU256(subU256(addU256(prod, d), 1n), d));
  return castU128(divU256(prod, d));
}

/**
 * safe_shl_div_cast::<u128>: shl_div, (x << offset) / y in U256 rounded as asked; its None (y zero, bits lost, the
 * quotient not a u128) is MathOverflow.
 */
export function safeShlDivCastU128(x: u128, y: u128, offset: u64, up: boolean): u128 {
  require(y !== 0n, PoolError.MathOverflow);
  require(offset < 256n && u256(x) <= U256_MAX >> offset, PoolError.MathOverflow);
  const prod = u256(x) << offset;
  const d = u256(y);
  const q = up ? divCeilU256(prod, d) : prod / d;
  require(q <= u256(U128_MAX), PoolError.MathOverflow);
  return u128(q);
}

/** safe_shl_div_cast::<u64>: as safeShlDivCastU128, TypeCastFailed when the result is not a u64. */
export function safeShlDivCastU64(x: u128, y: u128, offset: u64, up: boolean): u64 {
  return castU64(safeShlDivCastU128(x, y, offset, up));
}

/**
 * sqrt_u256: the integer square root, bit by bit in the original; isqrt gives the same floor. The original returns
 * None only when a checked step overflows, which none of its steps can.
 */
export function sqrtU256(radicand: u256): u256 {
  return isqrt(radicand);
}

// ---- fee_math.rs ------------------------------------------------------------------------------------------------

/**
 * pow: base^exp in Q64.64 by squaring; 0 where the original returns None (a result of 0 is None there too). The
 * original takes an i32 and inverts for a negative exponent; its only caller passes a u16 period, so the exponent
 * here is never negative.
 */
export function powQ64(base: u128, exp: u64): u128 {
  let invert = false;
  if (exp === 0n) return ONE_Q64;
  if (exp >= MAX_EXPONENTIAL) return 0n;
  let squaredBase = base;
  let result = ONE_Q64;
  if (squaredBase >= result) {
    squaredBase = U128_MAX / squaredBase;
    invert = !invert;
  }
  // The original's 19 unrolled steps: bit 0, then square and test the next bit, up to bit 18.
  for (let bit = 0n; bit < 19n; bit++) {
    if (bit > 0n) {
      if (squaredBase !== 0n && squaredBase > U128_MAX / squaredBase) return 0n;
      squaredBase = (squaredBase * squaredBase) >> SCALE_OFFSET;
    }
    if ((exp & (1n << bit)) > 0n) {
      if (squaredBase !== 0n && result > U128_MAX / squaredBase) return 0n;
      result = (result * squaredBase) >> SCALE_OFFSET;
    }
  }
  if (result === 0n) return 0n;
  if (invert) result = U128_MAX / result;
  return result;
}

/** get_fee_in_period: cliff_fee_numerator * (1 - reduction_factor / 10_000)^passed_period. */
export function getFeeInPeriod(cliffFeeNumerator: u64, reductionFactor: u64, passedPeriod: u64): u64 {
  // safe_shl by 64 on a u128 holding a u64 loses no bits and cannot fail.
  const bps = divU128(u128(reductionFactor) << SCALE_OFFSET, u128(BASIS_POINT_MAX));
  const base = subU128(ONE_Q64, bps);
  const result = powQ64(base, passedPeriod);
  require(result !== 0n, PoolError.MathOverflow);
  const fee = mulU128(result, u128(cliffFeeNumerator)) >> SCALE_OFFSET;
  return castU64(fee);
}
