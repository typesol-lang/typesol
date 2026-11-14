// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb, src/percolator.rs `mod oracle` and the oracle
// helpers of `mod verify`), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// Prices. A market reads either a Pyth PriceUpdateV2 account (owner rec5EKMG…, Full verification only, the
// PriceFeedMessage at byte 41, deserialized with Borsh by the original: 84 bytes that a 134-byte account always has)
// or a Chainlink OCR2 aggregator (owner HEvSKofv…, the answer at byte 216), converted to e6, inverted (1e12 / p) and
// scaled by unit_scale into "engine space"; or, in Hyperp mode (an all-zero feed id), no external oracle at all: the
// index follows a mark (the trade EWMA or the admin's pushed mark) at a capped rate.
//
// The readers return an Outcome (errors.ts) instead of failing in place, because UpdateConfig looks at the error
// (OracleStale and OracleConfTooWide select its degenerate arm); every other caller passes it on with `check`.
import { type Inout, type Pubkey, type RemainingAccount, type i64, type u8, type u16, type u32, type u64, type u128, i32, i64 as toI64, i128, lastRestartSlot, pubkey, readData, u64 as toU64, u128 as toU128 } from "typesol";
import { E_ENGINE_OVERFLOW, E_INVALID_ORACLE_KEY, E_ORACLE_CONF_TOO_WIDE, E_ORACLE_INVALID, E_ORACLE_STALE, ERR_ILLEGAL_OWNER, ERR_INVALID_ACCOUNT_DATA, OK, custom } from "./errors.js";
import { type MarketConfig } from "./state.js";
import { MAX_ORACLE_PRICE } from "./engine.js";

export const PYTH_RECEIVER_PROGRAM_ID = pubkey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const CHAINLINK_OCR2_PROGRAM_ID = pubkey("HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny");
export const ZERO_FEED = pubkey("11111111111111111111111111111111");

const PRICE_UPDATE_V2_MIN_LEN = 134n;
const OFF_VERIFICATION_LEVEL = 40n;
const OFF_PRICE_FEED_MESSAGE = 41n;
const PYTH_VERIFICATION_FULL_TAG = 1n;
const CL_MIN_LEN = 232n;
const CL_OFF_DECIMALS = 138n;
const CL_OFF_TIMESTAMP = 208n;
const CL_OFF_ANSWER = 216n;
/** MAX_EXPO_ABS. */
const MAX_EXPO_ABS = 18n;
const INVERSION_CONSTANT = 1000000000000n;
export const U64_MAX = 0xffffffffffffffffn;
const I64_MAX = 0x7fffffffffffffffn;
const I64_MIN = -0x8000000000000000n;
/** clamp_toward_with_dt's cap on dt (about an hour). */
const MAX_CLAMP_DT_SLOTS = 9000n;

/** A price read: the engine-space price and the observation's publish time. */
export interface PriceRead {
  price: u64;
  publish_time: i64;
}

/** 10^n for n <= 24 (u128). */
function pow10(n: u64): u128 {
  let r: u128 = 1n;
  for (let i = 0n; i < n; i++) r *= 10n;
  return r;
}

/** `now.saturating_sub(then)` for i64s. */
function saturatingSubI64(now: i64, then: i64): i64 {
  if (then < 0n) return now > I64_MAX + then ? I64_MAX : now - then;
  return now < I64_MIN + then ? I64_MIN : now - then;
}

/** read_pyth_price_e6: the raw e6 price of a PriceUpdateV2 account (the caller has checked the owner). */
function readPythPriceE6(ai: RemainingAccount, feedId: Pubkey, nowTs: i64, maxStaleness: u64, confBps: u16, out: Inout<PriceRead>): u64 {
  if (ai.owner !== PYTH_RECEIVER_PROGRAM_ID) return ERR_ILLEGAL_OWNER;
  if (ai.dataLen < PRICE_UPDATE_V2_MIN_LEN) return ERR_INVALID_ACCOUNT_DATA;
  if (readData<u8>(ai, OFF_VERIFICATION_LEVEL) !== PYTH_VERIFICATION_FULL_TAG) return custom(E_ORACLE_INVALID);
  const m = OFF_PRICE_FEED_MESSAGE;
  if (readData<Pubkey>(ai, m) !== feedId) return custom(E_INVALID_ORACLE_KEY);
  const price = readData<i64>(ai, m + 32n);
  const conf = readData<u64>(ai, m + 40n);
  const expo = readData<i32>(ai, m + 48n);
  const publishTime = readData<i64>(ai, m + 52n);
  if (price <= 0n) return custom(E_ORACLE_INVALID);
  if (expo < -18n || expo > 18n) return custom(E_ORACLE_INVALID);
  const age = saturatingSubI64(nowTs, publishTime);
  if (age < 0n || toU64(age) > maxStaleness) return custom(E_ORACLE_STALE);
  const priceU = toU128(price);
  if (confBps !== 0n) {
    if (toU128(conf) * 10000n > priceU * toU128(confBps)) return custom(E_ORACLE_CONF_TOO_WIDE);
  }
  return scaleE6(priceU, expo + 6n, publishTime, out);
}

/** The e6 conversion both readers end with: ·10^scale or /10^-scale, then nonzero and within u64. */
function scaleE6(priceU: u128, scale: i32, publishTime: i64, out: Inout<PriceRead>): u64 {
  let fin: u128 = 0n;
  if (scale >= 0n) {
    const mul = pow10(toU64(scale));
    if (mul !== 0n && priceU > 340282366920938463463374607431768211455n / mul) return custom(E_ENGINE_OVERFLOW);
    fin = priceU * mul;
  } else fin = priceU / pow10(toU64(-scale));
  if (fin === 0n) return custom(E_ORACLE_INVALID);
  if (fin > toU128(U64_MAX)) return custom(E_ENGINE_OVERFLOW);
  out.price = toU64(fin);
  out.publish_time = publishTime;
  return OK;
}

/** read_chainlink_price_e6. */
function readChainlinkPriceE6(ai: RemainingAccount, feedKey: Pubkey, nowTs: i64, maxStaleness: u64, out: Inout<PriceRead>): u64 {
  if (ai.owner !== CHAINLINK_OCR2_PROGRAM_ID) return ERR_ILLEGAL_OWNER;
  if (ai.key !== feedKey) return custom(E_INVALID_ORACLE_KEY);
  if (ai.dataLen < CL_MIN_LEN) return ERR_INVALID_ACCOUNT_DATA;
  const decimals = readData<u8>(ai, CL_OFF_DECIMALS);
  const timestamp = readData<u64>(ai, CL_OFF_TIMESTAMP);
  const answer = readData<i128>(ai, CL_OFF_ANSWER);
  if (answer <= 0n) return custom(E_ORACLE_INVALID);
  if (decimals > MAX_EXPO_ABS) return custom(E_ORACLE_INVALID);
  if (timestamp > I64_MAX) return custom(E_ORACLE_STALE);
  const ts = toI64(timestamp);
  const age = saturatingSubI64(nowTs, ts);
  if (age < 0n || toU64(age) > maxStaleness) return custom(E_ORACLE_STALE);
  return scaleE6(toU128(answer), 6n - i32(decimals), ts, out);
}

/** verify::invert_price_e6 (`none` as 0: a price is never 0 here). */
export function invertPriceE6(raw: u64, invert: u8): u64 {
  if (invert === 0n) return raw;
  if (raw === 0n) return 0n;
  const inverted = INVERSION_CONSTANT / toU128(raw);
  if (inverted === 0n) return 0n;
  if (inverted > toU128(U64_MAX)) return 0n;
  return toU64(inverted);
}

/** verify::scale_price_e6 (`None` as 0). */
export function scalePriceE6(price: u64, unitScale: u32): u64 {
  if (unitScale <= 1n) return price;
  return price / toU64(unitScale);
}

/** verify::to_engine_price: invert then scale (0 for None). */
export function toEnginePrice(raw: u64, invert: u8, unitScale: u32): u64 {
  const after = invertPriceE6(raw, invert);
  if (after === 0n) return 0n;
  return scalePriceE6(after, unitScale);
}

/** read_engine_price_e6: dispatch on the owner, then invert, scale and bound by MAX_ORACLE_PRICE. */
export function readEnginePriceE6(ai: RemainingAccount, feedId: Pubkey, nowTs: i64, maxStaleness: u64, confBps: u16, invert: u8, unitScale: u32, out: Inout<PriceRead>): u64 {
  let r = OK;
  if (ai.owner === PYTH_RECEIVER_PROGRAM_ID) r = readPythPriceE6(ai, feedId, nowTs, maxStaleness, confBps, out);
  else if (ai.owner === CHAINLINK_OCR2_PROGRAM_ID) r = readChainlinkPriceE6(ai, feedId, nowTs, maxStaleness, out);
  else return ERR_ILLEGAL_OWNER;
  if (r !== OK) return r;
  const afterInvert = invertPriceE6(out.price, invert);
  if (afterInvert === 0n) return custom(E_ORACLE_INVALID);
  const enginePrice = scalePriceE6(afterInvert, unitScale);
  if (enginePrice === 0n) return custom(E_ORACLE_INVALID);
  if (enginePrice > MAX_ORACLE_PRICE) return custom(E_ORACLE_INVALID);
  out.price = enginePrice;
  return OK;
}

/** clamp_oracle_price: within last ± last·cap/1e6 (no cap, or no history: as it is). */
export function clampOraclePrice(last: u64, raw: u64, capE2bps: u64): u64 {
  if (capE2bps === 0n || last === 0n) return raw;
  const d128 = (toU128(last) * toU128(capE2bps)) / 1000000n;
  const d = d128 < toU128(U64_MAX) ? toU64(d128) : U64_MAX;
  const lower = last > d ? last - d : 0n;
  const upper = last > U64_MAX - d ? U64_MAX : last + d;
  if (raw < lower) return lower;
  if (raw > upper) return upper;
  return raw;
}

/**
 * clamp_external_price after a successful read: an observation not newer than the last accepted one returns the
 * stored price and changes nothing; a newer one is clamped and becomes the baseline.
 */
export function clampExternalPrice(config: Inout<MarketConfig>, extPrice: u64, publishTime: i64): u64 {
  if (publishTime <= config.last_oracle_publish_time) return config.last_effective_price_e6;
  const clamped = clampOraclePrice(config.last_effective_price_e6, extPrice, config.oracle_price_cap_e2bps);
  config.last_effective_price_e6 = clamped;
  config.last_oracle_publish_time = publishTime;
  return clamped;
}

export function isHyperpMode(config: MarketConfig): boolean {
  return config.index_feed_id === ZERO_FEED;
}

/** cluster_restarted_since_init: LastRestartSlot::get() past the slot recorded at InitMarket. */
export function clusterRestartedSinceInit(config: MarketConfig): boolean {
  return lastRestartSlot() > config.init_restart_slot;
}

/** permissionless_stale_matured: a restart since init, or no live price for permissionless_resolve_stale_slots. */
export function permissionlessStaleMatured(config: MarketConfig, clockSlot: u64): boolean {
  if (clusterRestartedSinceInit(config)) return true;
  if (config.permissionless_resolve_stale_slots === 0n) return false;
  const lastLive = isHyperpMode(config) ? truncU64(config.last_mark_push_slot) : config.last_good_oracle_slot;
  const since = clockSlot > lastLive ? clockSlot - lastLive : 0n;
  return since >= config.permissionless_resolve_stale_slots;
}

/** `x as u64` of a u128: its low 64 bits. */
export function truncU64(x: u128): u64 {
  return toU64(x & 0xffffffffffffffffn);
}

/** clamp_toward_with_dt: move `index` toward `mark` by at most index · cap · min(dt, 9000) / 1e6. */
export function clampTowardWithDt(index: u64, mark: u64, capE2bps: u64, dtSlots: u64): u64 {
  if (index === 0n) return mark;
  if (capE2bps === 0n || dtSlots === 0n) return index;
  const dt = dtSlots < MAX_CLAMP_DT_SLOTS ? dtSlots : MAX_CLAMP_DT_SLOTS;
  // (index · cap) · dt, each step saturating at u128::MAX, then / 1e6.
  const a = toU128(index) * toU128(capE2bps);
  const b = toU128(dt) !== 0n && a > 340282366920938463463374607431768211455n / toU128(dt) ? 340282366920938463463374607431768211455n : a * toU128(dt);
  const d128 = b / 1000000n;
  const d = d128 < toU128(U64_MAX) ? toU64(d128) : U64_MAX;
  const lo = index > d ? index - d : 0n;
  const hi = index > U64_MAX - d ? U64_MAX : index + d;
  if (mark < lo) return lo;
  if (mark > hi) return hi;
  return mark;
}

/**
 * get_engine_oracle_price_e6: the hard-timeout gate, then in Hyperp mode the index moved toward the mark (the EWMA,
 * else the pushed mark) with the mark's staleness checked; otherwise the external read, clamped.
 */
export function getEngineOraclePriceE6(nowSlot: u64, nowTs: i64, config: Inout<MarketConfig>, oracle: RemainingAccount, out: Inout<PriceRead>): u64 {
  if (permissionlessStaleMatured(config, nowSlot)) return custom(E_ORACLE_STALE);
  if (isHyperpMode(config)) {
    const mark = config.mark_ewma_e6 > 0n ? config.mark_ewma_e6 : config.hyperp_mark_e6;
    if (mark === 0n) return custom(E_ORACLE_INVALID);
    const pushed = truncU64(config.last_mark_push_slot);
    const lastPush = config.mark_ewma_last_slot > pushed ? config.mark_ewma_last_slot : pushed;
    if (lastPush > 0n) {
      const maxStale = config.max_staleness_secs > U64_MAX / 3n ? U64_MAX : config.max_staleness_secs * 3n;
      const since = nowSlot > lastPush ? nowSlot - lastPush : 0n;
      if (since > maxStale) return custom(E_ORACLE_STALE);
    }
    const prevIndex = config.last_effective_price_e6;
    const dt = nowSlot > config.last_hyperp_index_slot ? nowSlot - config.last_hyperp_index_slot : 0n;
    const newIndex = clampTowardWithDt(prevIndex > 1n ? prevIndex : 1n, mark, config.oracle_price_cap_e2bps, dt);
    config.last_effective_price_e6 = newIndex;
    config.last_hyperp_index_slot = nowSlot;
    out.price = newIndex;
    return OK;
  }
  return readPriceClamped(config, oracle, nowTs, out);
}

/** read_price_clamped: read_engine_price_e6 with the config's feed, then clamp_external_price. */
export function readPriceClamped(config: Inout<MarketConfig>, oracle: RemainingAccount, nowTs: i64, out: Inout<PriceRead>): u64 {
  const r = readEnginePriceE6(oracle, config.index_feed_id, nowTs, config.max_staleness_secs, config.conf_filter_bps, config.invert, config.unit_scale, out);
  if (r !== OK) return r;
  out.price = clampExternalPrice(config, out.price, out.publish_time);
  return OK;
}

/** compute_current_funding_rate_e9: the clamped EWMA-mark premium over the index, per slot, in e9. */
export function computeCurrentFundingRateE9(config: MarketConfig): i128 {
  const mark = config.mark_ewma_e6;
  const index = config.last_effective_price_e6;
  if (mark === 0n || index === 0n || config.funding_horizon_slots === 0n) return 0n;
  const diff = i128(mark) - i128(index);
  // diff.saturating_mul(1e9) cannot saturate (|diff| < 2^64).
  let premium = (diff * 1000000000n) / i128(index);
  const maxPrem = i128(config.funding_max_premium_bps) * 100000n;
  if (premium < -maxPrem) premium = -maxPrem;
  if (premium > maxPrem) premium = maxPrem;
  const scaled = (premium * i128(config.funding_k_bps)) / 100n;
  const perSlot = scaled / i128(config.funding_horizon_slots);
  const maxRate = i128(config.funding_max_e9_per_slot);
  if (perSlot < -maxRate) return -maxRate;
  if (perSlot > maxRate) return maxRate;
  return perSlot;
}

/**
 * verify::ewma_update: old·(1 - α) + price·α with α = dt / (dt + halflife) in bps, weighted down by the fee paid
 * below mark_min_fee (the first update seeds the price, unless the fee falls short).
 */
export function ewmaUpdate(old: u64, price: u64, halflife: u64, lastSlot: u64, nowSlot: u64, feePaid: u64, markMinFee: u64): u64 {
  if (old === 0n) {
    if (markMinFee > 0n && feePaid < markMinFee) return 0n;
    return price;
  }
  const dt = nowSlot > lastSlot ? nowSlot - lastSlot : 0n;
  if (dt === 0n) return old;
  if (halflife === 0n) return price;
  if (feePaid === 0n && markMinFee > 0n) return old;
  const alpha = (10000n * toU128(dt)) / (toU128(dt) + toU128(halflife));
  const eff = markMinFee === 0n || feePaid >= markMinFee ? alpha : (alpha * toU128(feePaid)) / toU128(markMinFee);
  const o = toU128(old);
  const p = toU128(price);
  let result: u128 = 0n;
  if (price >= old) result = o + ((p - o) * eff) / 10000n;
  else result = o - ((o - p) * eff) / 10000n;
  return result < 0xffffffffffffffffn ? toU64(result) : 0xffffffffffffffffn;
}
