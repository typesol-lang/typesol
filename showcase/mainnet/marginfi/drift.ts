// Marginfi's Drift integration (programs/marginfi/src/instructions/drift and programs/drift-mocks of
// mrgnlabs/marginfi-v2 @ c5d440f6): what the Drift instructions read from Drift's spot market and user accounts, at
// the offsets drift-mocks' MinimalSpotMarket and MinimalUser give (discriminator included).
//
// drift-mocks has its own error enum, numbered from 6000 as Marginfi's is: ScalingOverflow 6000 (its math_error!),
// MathError 6004.
import {
  type Account,
  type FixedArray,
  type Pubkey,
  type i64,
  type u128,
  type u16,
  type u32,
  type u64,
  type u8,
  readData,
  require,
  u64 as toU64,
  u128 as toU128,
  u256 as toU256,
} from "typesol";

/**
 * drift-mocks' MinimalSpotMarket: a Drift spot market as Marginfi loads it (AccountLoader: owner, then the
 * discriminator of Drift's SpotMarket), its fields read at their offsets below.
 *
 * @repr c packed
 * @serialization bytemuck
 * @discriminator 0x64b1086ba8414127
 */
export interface DriftSpotMarket {
  bytes: FixedArray<u8, 768>;
}
/**
 * drift-mocks' MinimalUser: a Drift user (sub-account) as Marginfi loads it.
 *
 * @repr c packed
 * @serialization bytemuck
 * @discriminator 0x9f755fe3ef973aec
 */
export interface DriftUser {
  bytes: FixedArray<u8, 4368>;
}
/** DriftMocksError::ScalingOverflow (math_error!) and DriftMocksError::MathError */
const DRIFT_MOCKS_OVERFLOW: u32 = 6000n;
const DRIFT_MOCKS_MATH_ERROR: u32 = 6004n;
/** DRIFT_PRECISION_EXP: Drift scales a token amount by 10^(19 - decimals). */
const DRIFT_PRECISION_EXP: u32 = 19n;
/** anchor_lang's From<TryFromIntError>: ErrorCode::InvalidNumericConversion. */
const INVALID_NUMERIC_CONVERSION: u32 = 4102n;

export function marketMint(market: Account<DriftSpotMarket>): Pubkey {
  return readData<Pubkey>(market, 72n);
}
export function marketIndex(market: Account<DriftSpotMarket>): u16 {
  return readData<u16>(market, 684n);
}
export function marketPoolId(market: Account<DriftSpotMarket>): u8 {
  return readData<u8>(market, 735n);
}
export function marketDecimals(market: Account<DriftSpotMarket>): u32 {
  return readData<u32>(market, 680n);
}
export function marketLastInterest(market: Account<DriftSpotMarket>): u64 {
  return readData<u64>(market, 568n);
}
function cumulativeDepositInterest(market: Account<DriftSpotMarket>): u128 {
  return readData<u128>(market, 464n);
}

/** get_precision_increase: 10^(19 - decimals). */
function precisionIncrease(market: Account<DriftSpotMarket>): u128 {
  const d = marketDecimals(market);
  require(d <= DRIFT_PRECISION_EXP, DRIFT_MOCKS_MATH_ERROR);
  let p: u128 = 1n;
  for (let i: u32 = 0n; i < DRIFT_PRECISION_EXP - d; i++) p *= 10n;
  return p;
}

/** get_scaled_balance_increment / _decrement: amount × precision / interest, rounded up when decrementing (and non-zero). */
export function scaledBalance(market: Account<DriftSpotMarket>, amount: u64, roundUp: boolean): u64 {
  const interest = cumulativeDepositInterest(market);
  const precision = precisionIncrease(market);
  require(interest !== 0n, DRIFT_MOCKS_OVERFLOW);
  const q = (toU128(amount) * precision) / interest;
  // try_into: a scaled balance past u64 (Anchor's InvalidNumericConversion).
  require(q <= 18446744073709551615n, INVALID_NUMERIC_CONVERSION);
  let b = toU64(q);
  if (roundUp && b !== 0n) {
    require(b < 18446744073709551615n, DRIFT_MOCKS_MATH_ERROR);
    b += 1n;
  }
  return b;
}

/** get_withdraw_token_amount: scaled balance × interest / precision, toward zero. */
export function withdrawTokenAmount(market: Account<DriftSpotMarket>, scaled: u64): u64 {
  const precision = precisionIncrease(market);
  const p = toU256(scaled) * toU256(cumulativeDepositInterest(market));
  require(p <= 340282366920938463463374607431768211455n, DRIFT_MOCKS_OVERFLOW);
  const q = toU128(p) / precision;
  require(q <= 18446744073709551615n, DRIFT_MOCKS_MATH_ERROR);
  return toU64(q);
}

/** A user's spot position: USDC (market 0) in the first, any other market in the second. */
function position(user: Account<DriftUser>, i: u64): u64 {
  return 104n + 40n * i;
}
export function userScaledBalance(user: Account<DriftUser>, index: u16): u64 {
  return readData<u64>(user, position(user, index === 0n ? 0n : 1n));
}

/** validate_spot_position: the market's position holds its deposit, or is wholly empty. */
export function spotPositionOk(user: Account<DriftUser>, index: u16): boolean {
  const at = position(user, index === 0n ? 0n : 1n);
  if (readData<u64>(user, at) > 0n) return readData<u16>(user, at + 32n) === index && readData<u8>(user, at + 34n) === 0n;
  return readData<i64>(user, at + 24n) === 0n;
}

/** count_active_deposits: positions with a deposit. */
export function activeDeposits(user: Account<DriftUser>): u64 {
  let n: u64 = 0n;
  for (let i: u64 = 0n; i < 8n; i++) if (readData<u64>(user, position(user, i)) > 0n && readData<u8>(user, position(user, i) + 34n) === 0n) n++;
  return n;
}

/** has_admin_deposit: a deposit of that market in one of the user's positions 2 to 7 (where Drift's admin pays rewards). */
export function hasAdminDeposit(user: Account<DriftUser>, index: u16): boolean {
  for (let i: u64 = 2n; i < 8n; i++) {
    const at = position(user, i);
    if (readData<u16>(user, at + 32n) === index && readData<u64>(user, at) > 0n && readData<u8>(user, at + 34n) === 0n) return true;
  }
  return false;
}
