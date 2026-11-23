// A port of Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog src/v16_program.rs
// `mod oracle_v16`, Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL. Ported here: the external oracle
// readers (`read_pyth_price_e6_from_bytes`, `read_switchboard_observation_from_bytes`,
// `validate_switchboard_observation_e6`, `read_chainlink_price_e6_from_bytes`, `read_oracle_price_e6(_from_bytes)`),
// `oracle_publish_time_is_fresh`, `oracle_confidence_is_too_wide`, `scale_decimal_exponent_to_e6`, the composite of up
// to three legs (`compose_price_e6`), `read_coherent_oracle_legs`, `commit_observed_oracle_legs`,
// `read_external_price_e6_profile`, and the hybrid soft-stale predicate (`profile_hybrid_soft_stale_matured`).
//
// Three sources, told apart by the account's owner:
//
//   Pyth PriceUpdateV2     owner rec5EKMG… (the Pyth Solana Receiver); at least 134 bytes; the 8-byte Anchor
//                          discriminator; the verification level's Borsh tag at byte 40 must be Full (1); then
//                          pythnet-sdk 2.3.1's PriceFeedMessage, Borsh at byte 41: feed_id [u8; 32], price i64, conf u64,
//                          exponent i32, publish_time i64 (and three fields the original reads but never uses). 134 bytes
//                          always hold its 84, so the deserialization cannot fail. The leg binds by the message's feed id.
//   Switchboard On-Demand  owner SBondMDr… (mainnet) or Aio4gaXj… (devnet); the leg binds by the account's key; at least
//                          3,208 bytes; the PullFeedAccountData discriminator; fixed offsets: feed_hash at 2,120,
//                          min_sample_size at 2,215, last_update_timestamp at 2,216, the current result's value (i128,
//                          scaled 10^18) at 2,264, std_dev at 2,280, num_samples at 2,360, submission_idx at 2,361,
//                          slot at 2,368, and the 32 submissions' timestamps from 2,952 (the price is aged by the one
//                          submission_idx names, not by last_update_timestamp).
//   Chainlink OCR2         owner HEvSKofv… (the store program); the leg binds by the account's key; at least 248 bytes;
//                          the Transmissions discriminator; version at 8, decimals at 138, latest_round_id u32 at 143,
//                          live_length u32 at 148, then the latest transmission at 200: slot u64, timestamp u32 at 208,
//                          answer i128 at 216.
//
// Errors as values. The readers return a code (`R_*` below, 0 for success) instead of failing in place, because the
// crank (`hybrid_target_for_crank_view`, not ported yet) looks at the error: OracleStale and NotEnoughAccountKeys fall
// back to the EWMA mark once the hybrid soft-stale window has matured. ConfigureHybridOracle fails with the code
// (`failOracle`). Nothing is written before an error is returned (the leg commit checks every leg before it stores any),
// so a returned error leaves the profile as it was, as the original's copy does.
//
// Repeated accounts. `read_oracle_price_e6` borrows each leg's data (`try_borrow_data`) before anything else while the
// caller holds the market's data mutably: a leg that is the market fails with AccountBorrowFailed there. The port
// compares the keys (`busy`).
import {
  type Inout,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type i64,
  type i128,
  type u8,
  type u16,
  type u32,
  type u64,
  type u128,
  ProgramError,
  i32,
  i64 as toI64,
  i128 as toI128,
  loadRawAt,
  loadRawMutAt,
  pubkey,
  readData,
  require,
  u64 as toU64,
  u128 as toU128,
  u256 as toU256,
} from "typesol";
import { PercolatorError } from "./errors.js";
import {
  type AssetOracleProfile,
  MAX_ORACLE_PRICE,
  ORACLE_LEG_CAP,
  ORACLE_LEG_FLAG_DIVIDE_LEG2,
  ORACLE_LEG_FLAG_DIVIDE_LEG3,
  ORACLE_LEG_FLAGS_UNKNOWN,
  ORACLE_MODE_HYBRID_AFTER_HOURS,
  ORACLE_MODE_MANUAL,
  ZERO_KEY,
  oracleLegConfigOk,
} from "./state.js";

export const PYTH_RECEIVER_PROGRAM_ID = pubkey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const CHAINLINK_STORE_PROGRAM_ID = pubkey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
export const SWITCHBOARD_ON_DEMAND_MAINNET_PROGRAM_ID = pubkey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
export const SWITCHBOARD_ON_DEMAND_DEVNET_PROGRAM_ID = pubkey("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");

const PRICE_UPDATE_V2_MIN_LEN = 134n;
const OFF_VERIFICATION_LEVEL = 40n;
const OFF_PRICE_FEED_MESSAGE = 41n;
/** `PYTH_PRICE_UPDATE_V2_DISCRIMINATOR` [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd] as a little-endian u64. */
const PYTH_DISCRIMINATOR = 0xcdf47e9d6323f122n;
const PYTH_VERIFICATION_FULL_TAG = 1n;
const MAX_EXPO_ABS = 18n;
/** `SWITCHBOARD_PULL_FEED_DISCRIMINATOR` [196, 27, 108, 196, 10, 215, 219, 40]. */
const SWITCHBOARD_DISCRIMINATOR = 0x28dbd70ac46c1bc4n;
const SWITCHBOARD_PULL_FEED_MIN_LEN = 3208n;
const SB_OFF_FEED_HASH = 2120n;
const SB_OFF_MIN_SAMPLE_SIZE = 2215n;
const SB_OFF_LAST_UPDATE_TIMESTAMP = 2216n;
const SB_OFF_RESULT_VALUE = 2264n;
const SB_OFF_RESULT_STD_DEV = 2280n;
const SB_OFF_RESULT_NUM_SAMPLES = 2360n;
const SB_OFF_RESULT_SUBMISSION_IDX = 2361n;
const SB_OFF_RESULT_SLOT = 2368n;
const SB_OFF_SUBMISSION_TIMESTAMPS = 2952n;
const SB_SUBMISSION_CAP = 32n;
/** `CHAINLINK_TRANSMISSIONS_DISCRIMINATOR` [96, 179, 69, 66, 128, 129, 73, 117]. */
const CHAINLINK_DISCRIMINATOR = 0x754981804245b360n;
const CHAINLINK_FEED_MIN_LEN = 248n;
const CL_OFF_VERSION = 8n;
const CL_OFF_DECIMALS = 138n;
const CL_OFF_LATEST_ROUND_ID = 143n;
const CL_OFF_LIVE_LENGTH = 148n;
const CL_OFF_TRANSMISSION = 200n;
const U128_MAX_X = 0xffffffffffffffffffffffffffffffffn;

/** One leg's read: its e6 price and publish time. */
export interface LegRead {
  price: u64;
  publish_time: i64;
}

// ---- Errors as values ----------------------------------------------------------------------------------------------

/** A `Result<_, ProgramError>` as a number: 0 is Ok, R_CUSTOM + n is PercolatorError n, the others built-in errors. */
export const R_OK = 0n;
export const R_INVALID_ACCOUNT_DATA = 1n;
export const R_ILLEGAL_OWNER = 2n;
export const R_NOT_ENOUGH_ACCOUNT_KEYS = 3n;
export const R_ACCOUNT_BORROW_FAILED = 4n;
export const R_CUSTOM = 100n;
export const R_ENGINE_INVALID_CONFIG = 114n;
export const R_ENGINE_ARITHMETIC_OVERFLOW = 115n;
export const R_ORACLE_INVALID = 126n;
export const R_ORACLE_STALE = 127n;
export const R_ORACLE_CONF_TOO_WIDE = 128n;
export const R_INVALID_ORACLE_KEY = 129n;

/** `?` on a reader's result: fail with its error unless it is R_OK. */
export function failOracle(r: u64): void {
  if (r === R_OK) return;
  require(r !== R_INVALID_ACCOUNT_DATA, ProgramError.InvalidAccountData);
  require(r !== R_ILLEGAL_OWNER, ProgramError.IllegalOwner);
  require(r !== R_NOT_ENOUGH_ACCOUNT_KEYS, ProgramError.NotEnoughAccountKeys);
  require(r !== R_ACCOUNT_BORROW_FAILED, ProgramError.AccountBorrowFailed);
  require(r !== R_ENGINE_INVALID_CONFIG, PercolatorError.EngineInvalidConfig);
  require(r !== R_ENGINE_ARITHMETIC_OVERFLOW, PercolatorError.EngineArithmeticOverflow);
  require(r !== R_ORACLE_INVALID, PercolatorError.OracleInvalid);
  require(r !== R_ORACLE_STALE, PercolatorError.OracleStale);
  require(r !== R_ORACLE_CONF_TOO_WIDE, PercolatorError.OracleConfTooWide);
  // Every code made here is one of the above.
  require(r !== R_INVALID_ORACLE_KEY, PercolatorError.InvalidOracleKey);
}

// ---- The common checks -------------------------------------------------------------------------------------------------

/** `oracle_publish_time_is_fresh`: 0 ≤ now − publish (exact, in i128) ≤ max. */
export function publishTimeIsFresh(publishTime: i64, nowTs: i64, maxStaleness: u64): boolean {
  const age = toI128(nowTs) - toI128(publishTime);
  return age >= 0n && toU128(age) <= toU128(maxStaleness);
}

/** `oracle_confidence_is_too_wide`: uncertainty · 10,000 > value · bps, compared exactly (256 bits); never for 0 bps. */
export function confidenceIsTooWide(uncertainty: u128, value: u128, confBps: u16): boolean {
  if (confBps === 0n) return false;
  return toU256(uncertainty) * 10000n > toU256(value) * toU256(confBps);
}

/** 10^n (n ≤ 24, so in u128). */
function pow10(n: u64): u128 {
  let r: u128 = 1n;
  for (let i = 0n; i < n; i++) r *= 10n;
  return r;
}

/**
 * `scale_decimal_exponent_to_e6(mantissa, exponent)`: a positive mantissa (OracleInvalid), the exponent within ±18
 * (OracleInvalid), then multiplied by 10^(exponent + 6) (EngineArithmeticOverflow past u128) or divided by
 * 10^-(exponent + 6), and the result within 1..=MAX_ORACLE_PRICE (OracleInvalid). The mantissa is passed as its
 * magnitude, nonzero only when positive (each caller has the i128 in hand).
 */
function scaleToE6(mantissa: u128, positive: boolean, exponent: i32, publishTime: i64, out: Inout<LegRead>): u64 {
  if (!positive) return R_ORACLE_INVALID;
  if (exponent < -MAX_EXPO_ABS || exponent > MAX_EXPO_ABS) return R_ORACLE_INVALID;
  const shift = exponent + 6n;
  let price: u128 = 0n;
  if (shift >= 0n) {
    const factor = pow10(toU64(shift));
    if (toU256(mantissa) * toU256(factor) > toU256(U128_MAX_X)) return R_ENGINE_ARITHMETIC_OVERFLOW;
    price = mantissa * factor;
  } else price = mantissa / pow10(toU64(-shift));
  if (price === 0n || price > toU128(MAX_ORACLE_PRICE)) return R_ORACLE_INVALID;
  out.price = toU64(price);
  out.publish_time = publishTime;
  return R_OK;
}

// ---- The three sources -----------------------------------------------------------------------------------------------

/** `read_pyth_price_e6_from_bytes` (the owner already matched). */
function readPyth(ai: RemainingAccount, feed: Pubkey, nowTs: i64, maxStaleness: u64, confBps: u16, out: Inout<LegRead>): u64 {
  if (ai.dataLen < PRICE_UPDATE_V2_MIN_LEN) return R_INVALID_ACCOUNT_DATA;
  if (readData<u64>(ai, 0n) !== PYTH_DISCRIMINATOR) return R_ORACLE_INVALID;
  if (readData<u8>(ai, OFF_VERIFICATION_LEVEL) !== PYTH_VERIFICATION_FULL_TAG) return R_ORACLE_INVALID;
  // PriceFeedMessage (Borsh): feed_id, price, conf, exponent, publish_time.
  const m = OFF_PRICE_FEED_MESSAGE;
  if (readData<Pubkey>(ai, m) !== feed) return R_INVALID_ORACLE_KEY;
  const price = readData<i64>(ai, m + 32n);
  const exponent = readData<i32>(ai, m + 48n);
  if (price <= 0n || exponent < -MAX_EXPO_ABS || exponent > MAX_EXPO_ABS) return R_ORACLE_INVALID;
  const publishTime = readData<i64>(ai, m + 52n);
  if (!publishTimeIsFresh(publishTime, nowTs, maxStaleness)) return R_ORACLE_STALE;
  const value = toU128(price);
  if (confidenceIsTooWide(toU128(readData<u64>(ai, m + 40n)), value, confBps)) return R_ORACLE_CONF_TOO_WIDE;
  return scaleToE6(value, true, exponent, publishTime, out);
}

/**
 * `read_switchboard_price_e6_from_bytes` (the owner already matched): the key, then
 * `read_switchboard_observation_from_bytes` (the length, the discriminator, the selected submission's index and
 * timestamp) and `validate_switchboard_observation_e6` (the observation's shape, its age, its standard deviation, the
 * value scaled from 10^-18).
 */
function readSwitchboard(ai: RemainingAccount, feed: Pubkey, nowTs: i64, maxStaleness: u64, confBps: u16, out: Inout<LegRead>): u64 {
  if (ai.key !== feed) return R_INVALID_ORACLE_KEY;
  if (ai.dataLen < SWITCHBOARD_PULL_FEED_MIN_LEN) return R_INVALID_ACCOUNT_DATA;
  if (readData<u64>(ai, 0n) !== SWITCHBOARD_DISCRIMINATOR) return R_ORACLE_INVALID;
  // read_switchboard_selected_publish_time: the index within the 32 submissions (the read itself cannot fail: the
  // 32 timestamps end at the minimum length).
  const index = toU64(readData<u8>(ai, SB_OFF_RESULT_SUBMISSION_IDX));
  if (index >= SB_SUBMISSION_CAP) return R_ORACLE_INVALID;
  const publishTime = readData<i64>(ai, SB_OFF_SUBMISSION_TIMESTAMPS + index * 8n);
  const minSamples = readData<u8>(ai, SB_OFF_MIN_SAMPLE_SIZE);
  const value = readI128At(ai, SB_OFF_RESULT_VALUE);
  const stdDev = readI128At(ai, SB_OFF_RESULT_STD_DEV);
  if (
    readData<Pubkey>(ai, SB_OFF_FEED_HASH) === ZERO_KEY ||
    minSamples === 0n ||
    readData<u8>(ai, SB_OFF_RESULT_NUM_SAMPLES) < minSamples ||
    readData<u64>(ai, SB_OFF_RESULT_SLOT) === 0n ||
    readData<i64>(ai, SB_OFF_LAST_UPDATE_TIMESTAMP) <= 0n ||
    value <= 0n ||
    stdDev < 0n
  )
    return R_ORACLE_INVALID;
  if (publishTime <= 0n || !publishTimeIsFresh(publishTime, nowTs, maxStaleness)) return R_ORACLE_STALE;
  if (confidenceIsTooWide(toU128(stdDev), toU128(value), confBps)) return R_ORACLE_CONF_TOO_WIDE;
  return scaleToE6(toU128(value), true, -MAX_EXPO_ABS, publishTime, out);
}

/** An i128 at `off` of any account (little-endian). */
function readI128At(ai: RemainingAccount, off: u64): i128 {
  return readData<i128>(ai, off);
}

/** `read_chainlink_price_e6_from_bytes` (the owner already matched). */
function readChainlink(ai: RemainingAccount, feed: Pubkey, nowTs: i64, maxStaleness: u64, out: Inout<LegRead>): u64 {
  if (ai.key !== feed) return R_INVALID_ORACLE_KEY;
  if (ai.dataLen < CHAINLINK_FEED_MIN_LEN) return R_INVALID_ACCOUNT_DATA;
  if (readData<u64>(ai, 0n) !== CHAINLINK_DISCRIMINATOR) return R_ORACLE_INVALID;
  const decimals = readData<u8>(ai, CL_OFF_DECIMALS);
  // The transmission's timestamp, a u32 widened to i64: never negative, so `publish_time <= 0` is a zero timestamp.
  const ts = toI64(readData<u32>(ai, CL_OFF_TRANSMISSION + 8n));
  if (
    readData<u8>(ai, CL_OFF_VERSION) === 0n ||
    readData<u32>(ai, CL_OFF_LATEST_ROUND_ID) === 0n ||
    readData<u32>(ai, CL_OFF_LIVE_LENGTH) !== 1n ||
    readData<u64>(ai, CL_OFF_TRANSMISSION) === 0n ||
    ts <= 0n
  )
    return R_ORACLE_INVALID;
  if (!publishTimeIsFresh(ts, nowTs, maxStaleness)) return R_ORACLE_STALE;
  const answer = readI128At(ai, CL_OFF_TRANSMISSION + 16n);
  return scaleToE6(answer > 0n ? toU128(answer) : 0n, answer > 0n, -i32(decimals), ts, out);
}

/**
 * `read_oracle_price_e6(price_ai, feed, now, max_staleness, conf_bps)`: the leg's data borrowed (AccountBorrowFailed
 * when it is the account the caller holds), then by owner: Pyth, Switchboard (mainnet or devnet), Chainlink, or
 * IllegalOwner.
 */
export function readOraclePrice(ai: RemainingAccount, busy: Pubkey, feed: Pubkey, nowTs: i64, maxStaleness: u64, confBps: u16, out: Inout<LegRead>): u64 {
  if (ai.key === busy) return R_ACCOUNT_BORROW_FAILED;
  const owner = ai.owner;
  if (owner === PYTH_RECEIVER_PROGRAM_ID) return readPyth(ai, feed, nowTs, maxStaleness, confBps, out);
  if (owner === SWITCHBOARD_ON_DEMAND_MAINNET_PROGRAM_ID || owner === SWITCHBOARD_ON_DEMAND_DEVNET_PROGRAM_ID)
    return readSwitchboard(ai, feed, nowTs, maxStaleness, confBps, out);
  if (owner === CHAINLINK_STORE_PROGRAM_ID) return readChainlink(ai, feed, nowTs, maxStaleness, out);
  return R_ILLEGAL_OWNER;
}

// ---- Composites ----------------------------------------------------------------------------------------------------------

/** What `read_external_price_e6_profile` returns: the composed price, the legs' common publish time, whether a leg advanced. */
export interface ExternalRead {
  price: u64;
  publish_time: i64;
  advanced: u8;
}

/**
 * `compose_price_e6(prices, flags, invert, unit_scale)`: the shape (EngineInvalidConfig), every leg within
 * 1..=MAX_ORACLE_PRICE (OracleInvalid), then the exact rational p0 · (p1 or 10^6/p1) · (p2 or 10^6/p2) / 10^6 per
 * multiplied leg, each partial quotient within range (OracleInvalid), inverted to 10^12 / x, divided by the unit scale
 * above 1, the result within range (OracleInvalid). With every leg at most 10^12 the numerator stays below 10^36 and
 * the denominator below 10^24, the inverted numerator below 10^36: the original's checked products cannot overflow u128.
 */
export function composePrice(count: u64, p0: u64, p1: u64, p2: u64, flags: u8, invert: u8, unitScale: u32): u64 {
  if (
    count === 0n ||
    count > ORACLE_LEG_CAP ||
    invert > 1n ||
    (flags & ORACLE_LEG_FLAGS_UNKNOWN) !== 0n ||
    (count === 1n && flags !== 0n) ||
    (count === 2n && (flags & ORACLE_LEG_FLAG_DIVIDE_LEG3) !== 0n)
  )
    return R_ENGINE_INVALID_CONFIG;
  if (p0 === 0n || p0 > MAX_ORACLE_PRICE || (count >= 2n && (p1 === 0n || p1 > MAX_ORACLE_PRICE)) || (count === 3n && (p2 === 0n || p2 > MAX_ORACLE_PRICE)))
    return R_ORACLE_INVALID;
  let num = toU128(p0);
  let den: u128 = 1n;
  for (let i = 1n; i < count; i++) {
    const p = toU128(i === 1n ? p1 : p2);
    const divides = (flags & (i === 1n ? ORACLE_LEG_FLAG_DIVIDE_LEG2 : ORACLE_LEG_FLAG_DIVIDE_LEG3)) !== 0n;
    if (divides) {
      num *= 1000000n;
      den *= p;
    } else {
      num *= p;
      den *= 1000000n;
    }
    const partial = num / den;
    if (partial === 0n || partial > toU128(MAX_ORACLE_PRICE)) return R_ORACLE_INVALID;
  }
  if (invert !== 0n) {
    const n = den * 1000000000000n;
    den = num;
    num = n;
  }
  let price = num / den;
  if (unitScale > 1n) price /= toU128(unitScale);
  if (price === 0n || price > toU128(MAX_ORACLE_PRICE)) return R_ORACLE_INVALID;
  return toU64(price) + COMPOSED;
}

/** composePrice's result for a price: the price plus this (above every R_* code); below it, an error code. */
export const COMPOSED = 0x1000n;

/**
 * `read_external_price_e6_profile(profile, oracle_accounts, now_unix_ts)` on the profile at `at` of `m`, the legs at
 * `rest[first..]` (`available` of them passed): not Manual (OracleInvalid); the leg count 1..=3 with as many accounts
 * (NotEnoughAccountKeys); the profile's leg configuration (EngineInvalidConfig); each leg read in order
 * (`read_coherent_oracle_legs`, the first error returned), their publish times equal (OracleStale); the composite; then
 * `commit_observed_oracle_legs`: for each leg with a stored observation, not older (OracleStale) and, at the same time,
 * not another price (OracleInvalid); then every leg newer than its stored one stored (`advanced`). `busy` is the
 * account whose data the caller holds.
 */
export function readExternalPriceProfile(
  m: RemainingAccount,
  at: u64,
  rest: RemainingAccounts,
  first: u64,
  available: u64,
  busy: Pubkey,
  nowTs: i64,
  out: Inout<ExternalRead>,
): u64 {
  const p = loadRawAt<AssetOracleProfile>(m, at);
  if (p.oracle_mode === ORACLE_MODE_MANUAL) return R_ORACLE_INVALID;
  const count = toU64(p.oracle_leg_count);
  if (count === 0n || count > ORACLE_LEG_CAP || available < count) return R_NOT_ENOUGH_ACCOUNT_KEYS;
  if (!oracleLegConfigOk(p.oracle_leg_count, p.oracle_leg_flags, p.oracle_leg_feeds)) return R_ENGINE_INVALID_CONFIG;
  const maxStaleness = p.max_staleness_secs;
  const confBps = p.conf_filter_bps;
  const leg: LegRead = { price: 0n, publish_time: 0n };
  let p0 = 0n;
  let p1 = 0n;
  let p2 = 0n;
  let t0: i64 = 0n;
  let t1: i64 = 0n;
  let t2: i64 = 0n;
  for (let i = 0n; i < count; i++) {
    const r = readOraclePrice(rest.get(first + i), busy, p.oracle_leg_feeds.get(i), nowTs, maxStaleness, confBps, leg);
    if (r !== R_OK) return r;
    if (i === 0n) {
      p0 = leg.price;
      t0 = leg.publish_time;
    } else if (i === 1n) {
      p1 = leg.price;
      t1 = leg.publish_time;
    } else {
      p2 = leg.price;
      t2 = leg.publish_time;
    }
  }
  // oracle_publish_times_are_coherent.
  if ((count >= 2n && t1 !== t0) || (count === 3n && t2 !== t0)) return R_ORACLE_STALE;
  const composed = composePrice(count, p0, p1, p2, p.oracle_leg_flags, p.invert, p.unit_scale);
  if (composed < COMPOSED) return composed;
  // commit_observed_oracle_legs: every leg checked, then the newer ones stored.
  for (let i = 0n; i < count; i++) {
    const prevTime = p.oracle_leg_publish_times.get(i);
    const prevPrice = p.oracle_leg_prices_e6.get(i);
    const t = i === 0n ? t0 : i === 1n ? t1 : t2;
    const price = i === 0n ? p0 : i === 1n ? p1 : p2;
    if (prevTime !== 0n) {
      if (t < prevTime) return R_ORACLE_STALE;
      if (t === prevTime && prevPrice !== 0n && price !== prevPrice) return R_ORACLE_INVALID;
    }
  }
  const w = loadRawMutAt<AssetOracleProfile>(m, at);
  let advanced: u8 = 0n;
  for (let i = 0n; i < count; i++) {
    const t = i === 0n ? t0 : i === 1n ? t1 : t2;
    if (t > w.oracle_leg_publish_times.get(i)) {
      w.oracle_leg_publish_times.set(i, t);
      w.oracle_leg_prices_e6.set(i, i === 0n ? p0 : i === 1n ? p1 : p2);
      advanced = 1n;
    }
  }
  out.price = composed - COMPOSED;
  out.publish_time = t0;
  out.advanced = advanced;
  return R_OK;
}

// ---- The hybrid after-hours mode -------------------------------------------------------------------------------------

/**
 * `profile_hybrid_soft_stale_matured(profile, now_slot)`: a hybrid profile whose soft-stale window (nonzero) has passed
 * since its last good observation (strictly more slots, saturating). Then the crank's target falls back to the EWMA
 * mark when the external read is stale or short of accounts, and the zero-move accrual and the canonical accrual path
 * stop moving the hybrid funding mark with the price (`update_fresh_hybrid_mark`).
 */
export function profileHybridSoftStaleMatured(p: AssetOracleProfile, nowSlot: u64): boolean {
  if (p.oracle_mode !== ORACLE_MODE_HYBRID_AFTER_HOURS || p.hybrid_soft_stale_slots === 0n) return false;
  const since = nowSlot > p.last_good_oracle_slot ? nowSlot - p.last_good_oracle_slot : 0n;
  return since > p.hybrid_soft_stale_slots;
}
