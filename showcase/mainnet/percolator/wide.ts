// A port of Percolator v12.20 (aeyakovenko/percolator 3f55f87, src/wide_math.rs), Copyright Anatoly Yakovenko,
// licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in
// TypeSOL.
//
// The engine's wide arithmetic. The original has its own U256 ([u64; 4] limbs), I256 (two's complement over the same
// limbs) and a private U512 for mul-div intermediates. All of them compute exact results and refuse what does not fit:
// `checked_*` return None (which the engine turns into RiskError::Overflow), and the helpers that `assert!` / `expect`
// panic with their messages. TypeSOL's u256 is exact too, so the port keeps the values in u256 (an I256 as a sign and
// a magnitude below 2^255, or exactly 2^255 for I256::MIN) and makes the same range checks before each operation,
// failing where the original fails, with its error or its panic:
//
// - a product a·b that would not fit 256 bits is checked against MAX / a first (U256::checked_mul's None);
// - an I256 that would leave [-2^255, 2^255 - 1] is refused as I256::checked_add / checked_sub / checked_mul_i256 do;
// - `try_into_i128` / `try_into_u128` are range checks;
// - the U512 mul-div helpers are TypeSOL's `mulDiv` (a 512-bit product), whose quotient has to fit u256 as the
//   original's "mul_div quotient must fit U256" requires.
import { type i128, type u128, i128 as toI128, mulDiv, panic, require, u128 as toU128, u256 } from "typesol";
import { PercolatorError } from "./errors.js";

export const U256_MAX = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
/** 2^255: the magnitude of I256::MIN; every other I256 magnitude is below it. */
export const I256_MIN_MAG = 57896044618658097711785492504343953926634992332820282019728792003956564819968n;
export const U128_MAX = 340282366920938463463374607431768211455n;
export const I128_MAX = 170141183460469231731687303715884105727n;
/** The magnitude of i128::MIN, 2^127. */
export const I128_MIN_MAG = 170141183460469231731687303715884105728n;

/** i128::MIN. */
const I128_MIN_W: i128 = -170141183460469231731687303715884105728n;
/** 2^64 - 1 and 2^128 - 1 as bounds below which a product cannot overflow. */
const U64_MAX_W: u128 = 0xffffffffffffffffn;
const U128_MAX_W: u256 = 340282366920938463463374607431768211455n;

/** |v| of an i128, as u128 (i128::unsigned_abs). */
export function absI128(v: i128): u128 {
  if (v >= 0n) return toU128(v);
  if (v === I128_MIN_W) return I128_MIN_MAG;
  return toU128(-v);
}

/** An i128 from a sign and a magnitude known to fit (|v| <= 2^127 when negative, < 2^127 otherwise). */
export function signedI128(neg: boolean, mag: u128): i128 {
  if (!neg) return toI128(mag);
  if (mag === I128_MIN_MAG) return -I128_MAX - 1n;
  return -toI128(mag);
}

/**
 * U256::checked_mul's None as RiskError::Overflow: the exact product, refused past 2^256 - 1. Two factors below 2^128
 * cannot overflow, so the division that decides it is only made when one is not.
 */
export function mulU256(a: u256, b: u256): u256 {
  if (a !== 0n && (a > U128_MAX_W || b > U128_MAX_W)) require(b <= U256_MAX / a, PercolatorError.EngineOverflow);
  return a * b;
}

/** Whether a·b fits 256 bits (U256::checked_mul is Some). */
export function mulFitsU256(a: u256, b: u256): boolean {
  return a === 0n || (a <= U128_MAX_W && b <= U128_MAX_W) || b <= U256_MAX / a;
}

/**
 * `I256::from_i128(k) + (±mag)` then `try_into_i128()`: the sum of an i128 and a signed wide value whose magnitude is
 * below 2^255 (it cannot leave I256), refused with RiskError::Overflow when it does not fit i128.
 */
export function addWideToI128(k: i128, neg: boolean, mag: u256): i128 {
  const kNeg = k < 0n;
  const kMag = u256(absI128(k));
  let rNeg = false;
  let rMag: u256 = 0n;
  if (kNeg === neg) {
    rNeg = kNeg;
    rMag = kMag + mag;
  } else if (kMag >= mag) {
    rNeg = kNeg;
    rMag = kMag - mag;
  } else {
    rNeg = neg;
    rMag = mag - kMag;
  }
  if (rMag === 0n) return 0n;
  if (rNeg) require(rMag <= u256(I128_MIN_MAG), PercolatorError.EngineOverflow);
  else require(rMag <= u256(I128_MAX), PercolatorError.EngineOverflow);
  return signedI128(rNeg, toU128(rMag));
}

/**
 * I256::checked_mul_i256 of two values given as sign and magnitude (each magnitude at most 2^255), with None as
 * RiskError::Overflow. Returns the product's magnitude; its sign is `aNeg !== bNeg` (when it is not zero).
 */
export function mulI256Mag(aNeg: boolean, aMag: u256, bNeg: boolean, bMag: u256): u256 {
  if (aMag === 0n || bMag === 0n) return 0n;
  const neg = aNeg !== bNeg;
  // I256::MIN times anything but 1 overflows (MIN · 1 is MIN; MIN · -1 is past MAX).
  if (aNeg && aMag === I256_MIN_MAG) {
    require(!bNeg && bMag === 1n, PercolatorError.EngineOverflow);
    return aMag;
  }
  if (bNeg && bMag === I256_MIN_MAG) {
    require(!aNeg && aMag === 1n, PercolatorError.EngineOverflow);
    return bMag;
  }
  const p = mulU256(aMag, bMag);
  if (neg) require(p <= I256_MIN_MAG, PercolatorError.EngineOverflow);
  else require(p < I256_MIN_MAG, PercolatorError.EngineOverflow);
  return p;
}

// ---- The panicking helpers (wide_math.rs) ------------------------------------------------------------------------------

/** mul_div_floor_u128: a·b must fit u128 (it panics otherwise); d > 0. */
export function mulDivFloorU128(a: u128, b: u128, d: u128): u128 {
  if (d === 0n) panic("mul_div_floor_u128: division by zero", "src/wide_math.rs:1553:5");
  // a·b overflows only when a factor reaches 2^64 (the division that decides it is made only then).
  if (b !== 0n && (a > U64_MAX_W || b > U64_MAX_W) && a > U128_MAX / b) panic("mul_div_floor_u128: a*b overflow", "src/wide_math.rs:1554:30");
  return (a * b) / d;
}

/** mul_div_ceil_u128. */
export function mulDivCeilU128(a: u128, b: u128, d: u128): u128 {
  if (d === 0n) panic("mul_div_ceil_u128: division by zero", "src/wide_math.rs:1560:5");
  if (b !== 0n && (a > U64_MAX_W || b > U64_MAX_W) && a > U128_MAX / b) panic("mul_div_ceil_u128: a*b overflow", "src/wide_math.rs:1561:30");
  const p = a * b;
  const q = p / d;
  return p % d !== 0n ? q + 1n : q;
}

/** wide_mul_div_floor_u128: floor(a·b / d) through a 256-bit product; the result must fit u128. */
export function wideMulDivFloorU128(a: u128, b: u128, d: u128): u128 {
  if (d === 0n) panic("wide_mul_div_floor_u128: division by zero", "src/wide_math.rs:1569:5");
  const q = mulDiv(u256(a), u256(b), u256(d));
  if (q > u256(U128_MAX)) panic("wide_mul_div_floor_u128: result exceeds u128", "src/wide_math.rs:1571:30");
  return toU128(q);
}

/** fee_debt_u128_checked: the debt a negative fee_credits stands for (i128::MIN's is 2^127). */
export function feeDebt(feeCredits: i128): u128 {
  return feeCredits < 0n ? absI128(feeCredits) : 0n;
}
