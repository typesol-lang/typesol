// Marginfi's venue supply rates and room (programs/marginfi/src/state/rate.rs and the mocks' rate math:
// kamino-mocks MinimalReserve::supply_apr_at / rewards_apr_at, drift-mocks MinimalSpotMarket::deposit_rate_at,
// juplend-mocks TokenReserve::supply_rate_at, RateModel::borrow_rate_at, LendingRewardsRateModel::rewards_apr @
// c5d440f6), for a rebalance's legs in Kamino, Drift and JupLend banks. Solend banks never reach them (a rebalance
// refuses them). Each returns its error as a value: the venue's own (stale, not the bank's account) or MathError where
// the original's `Option` math gives None. u128 arithmetic is done in u256 and checked against u128, as Rust's
// checked_* / saturating_* do.
import {
  type Account,
  type Pubkey,
  type RemainingAccount,
  type u16,
  type i128,
  type i64,
  type u128,
  type u256,
  type u32,
  type u64,
  type u8,
  currentEpoch,
  currentSlot,
  epochStartTimestamp,
  firstNormalEpoch,
  firstNormalSlot,
  pubkey,
  readData,
  require,
  slotsPerEpoch,
  i128 as toI128,
  u128 as toU128,
  u32 as toU32,
  u256 as toU256,
  u64 as toU64,
} from "typesol";
import { MarginfiError } from "./errors";
import { type Fx, I80F48_ONE, I80F48_ZERO, fxFromU64, fxRound, fxTryAdd, fxTryDiv, fxTryMul, fxWrappingDiv, fxWrappingMul } from "./i80f48";
import { type Bank } from "./state";

const VR_MATH: u32 = 6062n;
const VR_U128_MAX: u256 = 340282366920938463463374607431768211455n;
const VR_U64_MAX: u128 = 18446744073709551615n;
/** I80F48::from_num of a u128 that fits (rates and amounts here do); past I80F48 the original panics. */
function VR_fxFromU128(n: u128): i128 {
  require(n <= 604462909807314587353087n, MarginfiError.InternalLogicError);
  return toI128(n) * 281474976710656n;
}
function vrNone(): Fx {
  return { err: VR_MATH, v: 0n };
}
function vrOk(v: i128): Fx {
  return { err: 0n, v };
}

// ---- Kamino (MinimalReserve after its discriminator) -------------------------------------------------------------

const VR_KLEND_ID = pubkey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const VR_KAMINO_RESERVE_DISC: u64 = 9168193160886415915n;
const VR_KAMINO_MARKET_DISC: u64 = 8654965518109930230n;
const VR_KAMINO_RESERVE_VALIDATION_FAILED: u32 = 6210n;
const VR_RESERVE_STALE: u32 = 6206n;
const VR_INVALID_BANK_ACCOUNT: u32 = 6008n;
/** VR_KAMINO_SLOTS_PER_YEAR (klend's 2 slots a second), marginfi's VR_SECONDS_PER_YEAR. */
const VR_KAMINO_SLOTS_PER_YEAR: u64 = 63072000n;
const VR_SECONDS_PER_YEAR: u64 = 31536000n;

/** load_kamino_reserve: the bank's reserve (oracle_keys[1]), klend's, with its discriminator; then refreshed this slot. */
function kaminoReserveErr(bank: Account<Bank>, r: RemainingAccount): u32 {
  if (r.key !== bank.config.oracle_keys.get(1n)) return VR_KAMINO_RESERVE_VALIDATION_FAILED;
  if (r.owner !== VR_KLEND_ID || r.dataLen < 8n || readData<u64>(r, 0n) !== VR_KAMINO_RESERVE_DISC) return VR_KAMINO_RESERVE_VALIDATION_FAILED;
  require(r.dataLen >= 8624n, MarginfiError.InternalLogicError);
  return 0n;
}

/** u68f60 bits (a klend Fraction) as I80F48: the 12 extra fraction bits dropped, toward −∞. */
function vrSfFx(r: RemainingAccount, at: u64): i128 {
  return toI128(readData<u128>(r, at) >> 12n);
}

/** calculate_total_supply_i80f48: available + borrowed − protocol − referrer − pending referrer fees (wrapping). */
function kaminoTotalSupply(r: RemainingAccount): i128 {
  return fxFromU64(readData<u64>(r, 224n)) + vrSfFx(r, 232n) - vrSfFx(r, 344n) - vrSfFx(r, 360n) - vrSfFx(r, 376n);
}

/** from_bps: x / 10,000. */
function vrFromBps(x: u32): i128 {
  return fxWrappingDiv(fxFromU64(toU64(x)), fxFromU64(10000n));
}

/** get_borrow_rate_from_points: klend's 11-point curve at the utilization (at most 1), in whole basis points first. */
function kaminoBorrowRate(r: RemainingAccount, utilization: i128): Fx {
  const u = utilization > I80F48_ONE ? I80F48_ONE : utilization;
  const bps: u32 = toU32(fxRound(fxWrappingMul(u, fxFromU64(10000n))) >> 48n);
  let start: u64 = 0n;
  for (let i: u64 = 0n; i < 10n; i++) {
    if (bps >= readData<u32>(r, 4920n + 8n * i) && bps <= readData<u32>(r, 4920n + 8n * (i + 1n))) {
      start = i;
      break;
    }
  }
  const su = readData<u32>(r, 4920n + 8n * start);
  const sr = readData<u32>(r, 4924n + 8n * start);
  const eu = readData<u32>(r, 4920n + 8n * (start + 1n));
  const er = readData<u32>(r, 4924n + 8n * (start + 1n));
  if (bps === su) return vrOk(vrFromBps(sr));
  if (bps === eu) return vrOk(vrFromBps(er));
  if (er < sr || eu < su || eu === su) return vrNone();
  const coef = u - vrFromBps(su);
  const nom = fxWrappingMul(coef, fxFromU64(toU64(er - sr)));
  return vrOk(fxWrappingDiv(nom, fxFromU64(toU64(eu - su))) + vrFromBps(sr));
}

/** InterestRateBasis::wall_clock_scalar: a per-slot (legacy) reserve's rate at the measured pace, else 1. */
function wallClockScalar(basis: u8, slotsPerSecond: i128): Fx {
  if (basis === 0n) return fxTryDiv(slotsPerSecond, fxFromU64(2n));
  return vrOk(I80F48_ONE);
}

/**
 * measured_slots_per_second: the chain's pace over the elapsed part of this epoch (at least an hour of it, between 1
 * and 4 slots a second), else klend's own 2.
 */
export function measuredSlotsPerSecond(t: i64): i128 {
  const nominal = fxFromU64(2n);
  const epoch = currentEpoch();
  // EpochSchedule::get_first_slot_in_epoch: warmup epochs double from 32 slots.
  let first: u64 = 0n;
  const normal = firstNormalEpoch();
  if (epoch <= normal) {
    if (epoch >= 59n) return nominal;
    first = ((1n << epoch) - 1n) * 32n;
  } else {
    const n = toU128(epoch - normal) * toU128(slotsPerEpoch()) + toU128(firstNormalSlot());
    if (n > VR_U64_MAX) return nominal;
    first = toU64(n);
  }
  const slot = currentSlot();
  if (slot < first) return nominal;
  const start = epochStartTimestamp();
  // i64 saturating_sub
  const seconds: i128 = toI128(t) - toI128(start);
  if (seconds < 3600n) return nominal;
  const s = seconds > 9223372036854775807n ? 9223372036854775807n : seconds;
  const measured = fxTryDiv(fxFromU64(slot - first), toI128(s) * 281474976710656n);
  if (measured.err !== 0n) return nominal;
  if (measured.v < fxFromU64(1n) || measured.v > fxFromU64(4n)) return nominal;
  return measured.v;
}

/** kamino_supply_apr_from_parts at `extra` more supply: borrow rate × utilization × (1 − take rate) × pace. */
function kaminoSupplyAprAt(r: RemainingAccount, extra: i128, sps: i128): Fx {
  const total = fxTryAdd(kaminoTotalSupply(r), extra);
  if (total.err !== 0n) return vrNone();
  const basis = readData<u8>(r, 4865n);
  if (basis > 1n) return vrNone();
  if (total.v <= 0n) return vrNone();
  const utilization = fxTryDiv(vrSfFx(r, 232n), total.v);
  if (utilization.err !== 0n) return vrNone();
  const rate = kaminoBorrowRate(r, utilization.v);
  if (rate.err !== 0n) return vrNone();
  const take = fxWrappingDiv(fxFromU64(toU64(readData<u8>(r, 4870n))), fxFromU64(100n));
  const a = fxTryMul(rate.v, utilization.v);
  if (a.err !== 0n) return vrNone();
  const b = fxTryMul(a.v, I80F48_ONE - take);
  if (b.err !== 0n) return vrNone();
  const scalar = wallClockScalar(basis, sps);
  if (scalar.err !== 0n) return vrNone();
  const c = fxTryMul(b.v, scalar.v);
  return c.err !== 0n ? vrNone() : c;
}

/** kamino_rewards_apr_from_parts at `extra` more supply: the emission per unit (capped), a year of it over the supply. */
function kaminoRewardsAprAt(r: RemainingAccount, maxAprBps: u64, extra: i128, sps: i128): Fx {
  const total = fxTryAdd(kaminoTotalSupply(r), extra);
  if (total.err !== 0n) return vrNone();
  const basis = readData<u8>(r, 4865n);
  if (basis > 1n) return vrNone();
  const perUnitCfg = readData<u64>(r, 5792n);
  const available = readData<u64>(r, 440n);
  if (maxAprBps === 0n || perUnitCfg === 0n || available === 0n || readData<u64>(r, 2592n) === 0n || total.v <= 0n) return vrOk(I80F48_ZERO);
  const unitsPerYear = fxFromU64(basis === 0n ? VR_KAMINO_SLOTS_PER_YEAR : VR_SECONDS_PER_YEAR);
  const num = fxTryMul(total.v, fxFromU64(maxAprBps));
  if (num.err !== 0n) return vrNone();
  const den = fxTryMul(fxFromU64(10000n), unitsPerYear);
  if (den.err !== 0n) return vrNone();
  const cap = fxTryDiv(num.v, den.v);
  if (cap.err !== 0n) return vrNone();
  let perUnit = fxFromU64(perUnitCfg);
  if (cap.v < perUnit) perUnit = cap.v;
  if (fxFromU64(available) < perUnit) perUnit = fxFromU64(available);
  const yearly = fxTryMul(perUnit, unitsPerYear);
  if (yearly.err !== 0n) return vrNone();
  const apr = fxTryDiv(yearly.v, total.v);
  if (apr.err !== 0n) return vrNone();
  const scalar = wallClockScalar(basis, sps);
  if (scalar.err !== 0n) return vrNone();
  const c = fxTryMul(apr.v, scalar.v);
  return c.err !== 0n ? vrNone() : c;
}

/** kamino_supply_apr: the reserve's supply rate plus its reward emissions, `extraNative` more tokens in. */
export function kaminoSupplyApr(bank: Account<Bank>, r: RemainingAccount, market: RemainingAccount, extraNative: u64, t: i64): Fx {
  const e = kaminoReserveErr(bank, r);
  if (e !== 0n) return { err: e, v: 0n };
  if (readData<u64>(r, 16n) < currentSlot()) return { err: VR_RESERVE_STALE, v: 0n };
  const extra = fxFromU64(extraNative);
  const sps = measuredSlotsPerSecond(t);
  const base = kaminoSupplyAprAt(r, extra, sps);
  if (base.err !== 0n) return base;
  // The reserve's lending market caps the emissions.
  if (market.key !== readData<Pubkey>(r, 32n)) return { err: VR_INVALID_BANK_ACCOUNT, v: 0n };
  if (market.owner !== VR_KLEND_ID || market.dataLen < 8n || readData<u64>(market, 0n) !== VR_KAMINO_MARKET_DISC) return { err: VR_INVALID_BANK_ACCOUNT, v: 0n };
  require(market.dataLen >= 4664n, MarginfiError.InternalLogicError);
  const rewards = kaminoRewardsAprAt(r, toU64(readData<u16>(market, 3358n)), extra, sps);
  if (rewards.err !== 0n) return rewards;
  const sum = fxTryAdd(base.v, rewards.v);
  return sum.err !== 0n ? vrNone() : sum;
}

/** venue_remaining_capacity (Kamino): nothing for an obsolete reserve or one in emergency mode, else the limit's headroom. */
export function kaminoRemaining(bank: Account<Bank>, r: RemainingAccount): Fx {
  const e = kaminoReserveErr(bank, r);
  if (e !== 0n) return { err: e, v: 0n };
  if (readData<u64>(r, 16n) < currentSlot()) return { err: VR_RESERVE_STALE, v: 0n };
  if (readData<u8>(r, 4856n) === 1n || readData<u8>(r, 4864n) !== 0n) return vrOk(0n);
  const limit = readData<u64>(r, 5016n);
  if (limit === 18446744073709551615n) return vrOk(toI128(limit));
  const ceiling = fxFromU64(limit);
  let headroom = ceiling - kaminoTotalSupply(r);
  if (headroom < 0n) headroom = 0n;
  if (headroom > ceiling) headroom = ceiling;
  return vrOk(headroom >> 48n);
}

// ---- Drift (MinimalSpotMarket after its discriminator) ------------------------------------------------------------

const VR_DRIFT_ID = pubkey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
const VR_DRIFT_SPOT_MARKET_DISC: u64 = 2828614232571425124n;
const VR_DRIFT_SPOT_MARKET_VALIDATION_FAILED: u32 = 6304n;
const VR_DRIFT_SPOT_MARKET_STALE: u32 = 6322n;
const VR_PERCENTAGE_PRECISION: u256 = 1000000n;

/** load_drift_spot_market and check_drift_market_fresh (a market without borrows is exempt). */
function driftMarketErr(bank: Account<Bank>, m: RemainingAccount, t: i64): u32 {
  if (m.key !== bank.config.oracle_keys.get(1n)) return VR_DRIFT_SPOT_MARKET_VALIDATION_FAILED;
  if (m.owner !== VR_DRIFT_ID || m.dataLen < 8n || readData<u64>(m, 0n) !== VR_DRIFT_SPOT_MARKET_DISC) return VR_DRIFT_SPOT_MARKET_VALIDATION_FAILED;
  require(m.dataLen >= 776n, MarginfiError.InternalLogicError);
  const last = readData<u64>(m, 568n);
  const stale = (last > 9223372036854775807n ? toI128(last) - 18446744073709551616n : toI128(last)) < toI128(t);
  if (stale && readData<u128>(m, 448n) !== 0n) return VR_DRIFT_SPOT_MARKET_STALE;
  return 0n;
}

/** MinimalSpotMarket::token_amount: a scaled balance times its cumulative interest over 10^(19 − decimals); -1 for None. */
function driftTokenAmount(m: RemainingAccount, balanceAt: u64, interestAt: u64, roundUp: boolean): u256 {
  const scaled = toU256(readData<u128>(m, balanceAt)) * toU256(readData<u128>(m, interestAt));
  if (scaled > VR_U128_MAX) return VR_U128_MAX + 1n;
  const decimals = readData<u32>(m, 680n);
  if (decimals > 19n) return VR_U128_MAX + 1n;
  let divisor: u256 = 1n;
  for (let i: u32 = 0n; i < 19n - decimals; i++) divisor *= 10n;
  if (roundUp) {
    if (scaled + divisor - 1n > VR_U128_MAX) return VR_U128_MAX + 1n;
    return (scaled + divisor - 1n) / divisor;
  }
  return scaled / divisor;
}

function vrSatMul(a: u256, b: u256): u256 {
  const p = a * b;
  return p > VR_U128_MAX ? VR_U128_MAX : p;
}

/** calculate_borrow_rate: Drift's piecewise curve past optimal utilization, floored at the market's minimum; -1 for None. */
function driftBorrowRate(utilization: u256, optimalUtil: u256, optimalRate: u256, maxRate: u256, minByte: u256): u256 {
  const minRate = minByte * (VR_PERCENTAGE_PRECISION / 200n);
  if (utilization <= optimalUtil) {
    if (optimalUtil === 0n) return VR_U128_MAX + 1n;
    const slope = vrSatMul(optimalRate, VR_PERCENTAGE_PRECISION) / optimalUtil;
    const rate = vrSatMul(utilization, slope) / VR_PERCENTAGE_PRECISION;
    return rate > minRate ? rate : minRate;
  }
  const totalExtra = maxRate > optimalRate ? maxRate - optimalRate : 0n;
  let rate = optimalRate;
  let prev = optimalUtil;
  for (let i: u64 = 0n; i < 6n; i++) {
    const bp: u256 = i === 0n ? 850000n : i === 1n ? 900000n : i === 2n ? 950000n : i === 3n ? 990000n : i === 4n ? 995000n : 1000000n;
    const weight: u256 = i === 0n ? 50n : i === 1n ? 100n : i === 2n ? 150n : i === 3n ? 200n : 250n;
    const range = bp > prev ? bp - prev : 0n;
    const segmentTotal = vrSatMul(totalExtra, weight) / 1000n;
    if (utilization <= bp) {
      const partial = utilization > prev ? utilization - prev : 0n;
      if (range === 0n) return VR_U128_MAX + 1n;
      const add = vrSatMul(segmentTotal, partial) / range;
      rate = rate + add > VR_U128_MAX ? VR_U128_MAX : rate + add;
      break;
    } else {
      rate = rate + segmentTotal > VR_U128_MAX ? VR_U128_MAX : rate + segmentTotal;
      prev = bp;
    }
  }
  return rate > minRate ? rate : minRate;
}

/** drift deposit_rate_at: the borrow rate × utilization × (1 − the insurance fund's factor); 0 while deposits are paused. */
export function driftSupplyApr(bank: Account<Bank>, m: RemainingAccount, extraNative: u64, t: i64): Fx {
  const e = driftMarketErr(bank, m, t);
  if (e !== 0n) return { err: e, v: 0n };
  if ((readData<u8>(m, 690n) & 1n) !== 0n) return vrOk(I80F48_ZERO);
  const deposits0 = driftTokenAmount(m, 432n, 464n, false);
  if (deposits0 > VR_U128_MAX) return vrNone();
  const deposits = deposits0 + toU256(extraNative);
  if (deposits > VR_U128_MAX) return vrNone();
  const borrows = driftTokenAmount(m, 448n, 480n, true);
  if (borrows > VR_U128_MAX) return vrNone();
  // calculate_utilization
  let utilization: u256 = 0n;
  if (deposits === 0n) utilization = borrows === 0n ? 0n : VR_PERCENTAGE_PRECISION;
  else utilization = vrSatMul(borrows, VR_PERCENTAGE_PRECISION) / deposits;
  const borrowRate = driftBorrowRate(
    utilization,
    toU256(readData<u32>(m, 668n)),
    toU256(readData<u32>(m, 672n)),
    toU256(readData<u32>(m, 676n)),
    toU256(readData<u8>(m, 728n)),
  );
  if (borrowRate > VR_U128_MAX) return vrNone();
  const factor = toU256(readData<u32>(m, 408n));
  const keep = VR_PERCENTAGE_PRECISION > factor ? VR_PERCENTAGE_PRECISION - factor : 0n;
  const a = borrowRate * keep;
  if (a > VR_U128_MAX) return vrNone();
  const b = a * utilization;
  if (b > VR_U128_MAX) return vrNone();
  const rate = b / VR_PERCENTAGE_PRECISION / VR_PERCENTAGE_PRECISION;
  if (rate > 604462909807314587353087n) return vrNone();
  return vrOk(fxWrappingDiv(VR_fxFromU128(toU128(rate)), fxFromU64(1000000n)));
}

/** venue_remaining_capacity (Drift): nothing unless Active, unlimited without a cap, else the cap less the deposits. */
export function driftRemaining(bank: Account<Bank>, m: RemainingAccount, t: i64): Fx {
  const e = driftMarketErr(bank, m, t);
  if (e !== 0n) return { err: e, v: 0n };
  if (readData<u8>(m, 688n) !== 1n) return vrOk(0n);
  const max = readData<u64>(m, 536n);
  if (max === 0n) return vrOk(toI128(18446744073709551615n));
  const deposits = driftTokenAmount(m, 432n, 464n, false);
  if (deposits > VR_U128_MAX) return vrNone();
  const remaining = toU256(max) > deposits ? toU256(max) - deposits : 0n;
  return vrOk(toI128(remaining > 18446744073709551615n ? 18446744073709551615n : remaining));
}

// ---- JupLend (Lending, TokenReserve, RateModel, LendingRewardsRateModel) -------------------------------------------

const VR_JUPLEND_ID = pubkey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
const VR_JUPLEND_LIQUIDITY_ID = pubkey("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");
const VR_JUPLEND_LENDING_DISC: u64 = 17417253714645927815n;
const VR_JUPLEND_LENDING_VALIDATION_FAILED: u32 = 6501n;
const VR_JUPLEND_LENDING_STALE: u32 = 6504n;
/** TokenReserve, RateModel and LendingRewardsRateModel discriminators, as little-endian u64s. */
const VR_TOKEN_RESERVE_DISC: u64 = 873439360630592021n;
const VR_RATE_MODEL_DISC: u64 = 11674607230393189214n;
const VR_REWARDS_MODEL_DISC: u64 = 13089231471796242598n;
const VR_TOKEN_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const VR_TOKEN_2022_ID = pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const VR_E12: u256 = 1000000000000n;
const VR_E17: u256 = 100000000000000000n;
const VR_FOUR: u256 = 10000n;

/** TokenReserve::utilization_at: scaled borrows over scaled supply (with `extra` native tokens in), ×10^4; -1 for None. */
function juplendUtilization(tr: RemainingAccount, extra: u64): u256 {
  const sep = toU256(readData<u64>(tr, 86n));
  const bep = toU256(readData<u64>(tr, 94n));
  if (sep === 0n || bep === 0n) return VR_U128_MAX + 1n;
  const extraRaw = (toU256(extra) * VR_E12) / sep;
  const a = toU256(readData<u64>(tr, 104n)) + extraRaw;
  if (a > VR_U128_MAX || a * sep > VR_U128_MAX) return VR_U128_MAX + 1n;
  const free = toU256(readData<u64>(tr, 112n)) * VR_E12;
  const scaledSupply = a * sep + free;
  if (scaledSupply > VR_U128_MAX) return VR_U128_MAX + 1n;
  if (scaledSupply === 0n) return 0n;
  const borrowWith = toU256(readData<u64>(tr, 120n)) * bep;
  const borrowFree = toU256(readData<u64>(tr, 128n)) * VR_E12;
  if (borrowWith > VR_U128_MAX || borrowWith + borrowFree > VR_U128_MAX) return VR_U128_MAX + 1n;
  const scaledBorrow = (borrowWith + borrowFree) * VR_FOUR;
  if (scaledBorrow > VR_U128_MAX) return VR_U128_MAX + 1n;
  return scaledBorrow / scaledSupply;
}

/** RateModel::borrow_rate_at: the mint's 1- or 2-kink curve at the utilization (×10^4), capped at 65,535; -1 for None. */
function juplendBorrowRate(model: RemainingAccount, utilization: u256): i128 {
  const version = readData<u8>(model, 40n);
  const zero = toU256(readData<u16>(model, 41n));
  const kink1 = toU256(readData<u16>(model, 43n));
  const atKink1 = toU256(readData<u16>(model, 45n));
  const max = toU256(readData<u16>(model, 47n));
  const kink2 = toU256(readData<u16>(model, 49n));
  const atKink2 = toU256(readData<u16>(model, 51n));
  let y1: u256 = 0n;
  let y2: u256 = 0n;
  let x1: u256 = 0n;
  let x2: u256 = 0n;
  if (version === 1n) {
    if (utilization < kink1) {
      y1 = zero;
      y2 = atKink1;
      x2 = kink1;
    } else {
      y1 = atKink1;
      y2 = max;
      x1 = kink1;
      x2 = VR_FOUR;
    }
  } else if (version === 2n) {
    if (utilization < kink1) {
      y1 = zero;
      y2 = atKink1;
      x2 = kink1;
    } else if (utilization < kink2) {
      y1 = atKink1;
      y2 = atKink2;
      x1 = kink1;
      x2 = kink2;
    } else {
      y1 = atKink2;
      y2 = max;
      x1 = kink2;
      x2 = VR_FOUR;
    }
  } else return -1n;
  // interpolate_rate in i128.
  if (x2 < x1) return -1n;
  const den = toI128(x2 - x1);
  if (den === 0n) return -1n;
  const num = (toI128(y2) - toI128(y1)) * 1000000000000n;
  // i128 division toward zero.
  const slope = num < 0n ? -(-num / den) : num / den;
  const constant = toI128(y1) * 1000000000000n - slope * toI128(x1);
  // i128::try_from(utilization) and checked_mul / checked_add: past i128, None (MathError), not an abort.
  const I128_MAX: u256 = 170141183460469231731687303715884105727n;
  if (utilization > I128_MAX) return -1n;
  const absSlope: u256 = slope < 0n ? toU256(toU128(-slope)) : toU256(toU128(slope));
  if (absSlope * utilization > I128_MAX) return -1n;
  const prod = slope * toI128(utilization);
  if ((constant > 0n && prod > 170141183460469231731687303715884105727n - constant) || (constant < 0n && prod < -170141183460469231731687303715884105728n - constant)) return -1n;
  const v = prod + constant;
  const rate = v < 0n ? -(-v / 1000000000000n) : v / 1000000000000n;
  if (rate < 0n) return -1n;
  return rate > 65535n ? 65535n : rate;
}

/** get_with_interest_vs_free_ratio. */
function vrRatio(withInterest: u256, free: u256): u256 {
  if (withInterest > free) return (free * VR_FOUR) / withInterest;
  if (withInterest < free) return (withInterest * VR_FOUR) / free;
  return withInterest > 0n ? VR_FOUR : 0n;
}

/** juplend_supply_rate_from_parts: the liquidity layer's supply rate (×10^-12 as I80F48); -1 sentinel via err. */
function juplendSupplyRateFromParts(
  borrowRate: u256,
  fee: u256,
  utilization: u256,
  sep: u256,
  bep: u256,
  supplyWith: u256,
  supplyFree: u256,
  borrowWith: u256,
  borrowFree: u256,
): Fx {
  if (borrowRate === 0n || borrowWith === 0n || supplyWith === 0n || sep === 0n || bep === 0n) return vrOk(I80F48_ZERO);
  const supplyRatio = vrRatio(supplyWith, supplyFree);
  let yieldRatio: u256 = 0n;
  if (supplyWith < supplyFree) {
    if (supplyRatio === 0n) return vrOk(I80F48_ZERO);
    const r = (VR_E17 * VR_FOUR) / supplyRatio;
    yieldRatio = vrSatMul(utilization, VR_E17 + r) / VR_FOUR;
  } else yieldRatio = vrSatMul(vrSatMul(utilization, VR_E17), VR_FOUR + supplyRatio) / (VR_FOUR * VR_FOUR);
  const b = vrRatio(borrowWith, borrowFree);
  const borrowRatio = borrowWith < borrowFree ? (b * VR_E17) / (VR_FOUR + b) : VR_E17 - (b * VR_E17) / (VR_FOUR + b);
  const product = yieldRatio * borrowRatio;
  if (product > VR_U128_MAX) return vrNone();
  yieldRatio = ((product / VR_E17) * VR_FOUR) / VR_E17;
  const a = borrowRate * yieldRatio;
  if (a > VR_U128_MAX) return vrNone();
  const supplyRate = a * (VR_FOUR > fee ? VR_FOUR - fee : 0n);
  if (supplyRate > VR_U128_MAX) return vrNone();
  return vrOk(fxWrappingDiv(VR_fxFromU128(toU128(supplyRate)), VR_fxFromU128(1000000000000n)));
}

/** TokenReserve::supply_rate_at: the stored rate (no extra), or the mint's rate model at the diluted utilization. */
function juplendTokenSupplyRate(tr: RemainingAccount, extra: u64, hasModel: boolean, model: RemainingAccount): Fx {
  let borrowRate: u256 = 0n;
  let utilization: u256 = 0n;
  if (extra === 0n) {
    borrowRate = toU256(readData<u16>(tr, 72n));
    utilization = toU256(readData<u16>(tr, 76n));
  } else {
    utilization = juplendUtilization(tr, extra);
    if (utilization > VR_U128_MAX) return vrNone();
    if (!hasModel) return vrNone();
    const r = juplendBorrowRate(model, utilization);
    if (r < 0n) return vrNone();
    borrowRate = toU256(toU128(r));
  }
  const sep = toU256(readData<u64>(tr, 86n));
  const extraShares = sep === 0n ? 0n : vrSatMul(toU256(extra), VR_E12) / sep;
  const supplyWith = toU256(readData<u64>(tr, 104n)) + extraShares;
  return juplendSupplyRateFromParts(
    borrowRate,
    toU256(readData<u16>(tr, 74n)),
    utilization,
    sep,
    toU256(readData<u64>(tr, 94n)),
    supplyWith > VR_U128_MAX ? VR_U128_MAX : supplyWith,
    toU256(readData<u64>(tr, 112n)),
    toU256(readData<u64>(tr, 120n)),
    toU256(readData<u64>(tr, 128n)),
  );
}

/** LendingRewardsRateModel::rewards_apr: this period's (or the next's) yearly reward over the assets, capped at 50%. */
function juplendRewardsApr(model: RemainingAccount, totalAssets: u256, t: u64): Fx {
  const startTvl = toU256(readData<u64>(model, 40n));
  const duration = readData<u64>(model, 48n);
  const startTime = readData<u64>(model, 56n);
  if (totalAssets === 0n || totalAssets < startTvl) return vrOk(I80F48_ZERO);
  if (toU256(startTime) + toU256(duration) > 18446744073709551615n) return vrNone();
  const end = startTime + duration;
  let yearly: u256 = 0n;
  if (startTime > 0n && t >= startTime && t < end) yearly = toU256(readData<u64>(model, 64n));
  else {
    const nextDuration = readData<u64>(model, 72n);
    const nextAmount = readData<u64>(model, 80n);
    if (toU256(end) + toU256(nextDuration) > 18446744073709551615n) return vrNone();
    if (nextAmount > 0n && nextDuration > 0n && t > end && t < end + nextDuration) yearly = (toU256(nextAmount) * 31536000n) / toU256(nextDuration);
    else return vrOk(I80F48_ZERO);
  }
  const p = yearly * 100000000000000n;
  if (p > VR_U128_MAX) return vrNone();
  let rate = p / totalAssets;
  if (rate > 50000000000000n) rate = 50000000000000n;
  const r = fxTryDiv(VR_fxFromU128(toU128(rate)), VR_fxFromU128(100000000000000n));
  return r.err !== 0n ? vrNone() : r;
}

/**
 * juplend_supply_apr: the liquidity layer's supply rate after `extraNative` more tokens, plus the Lending's reward rate
 * over its assets (the fToken supply at the token exchange price) with them in.
 */
export function juplendSupplyApr(
  bank: Account<Bank>,
  lending: RemainingAccount,
  tr: RemainingAccount,
  rewardsModel: RemainingAccount,
  fTokenMint: RemainingAccount,
  hasRateModel: boolean,
  rateModel: RemainingAccount,
  extraNative: u64,
  t: i64,
): Fx {
  if (lending.key !== bank.config.oracle_keys.get(1n)) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  if (lending.owner !== VR_JUPLEND_ID || lending.dataLen < 8n || readData<u64>(lending, 0n) !== VR_JUPLEND_LENDING_DISC)
    return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  require(lending.dataLen >= 196n, MarginfiError.InternalLogicError);
  if (tr.key !== readData<Pubkey>(lending, 131n)) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  if (tr.dataLen < 192n || readData<u64>(tr, 0n) !== VR_TOKEN_RESERVE_DISC) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  const updated = readData<u64>(tr, 78n);
  if ((updated > 9223372036854775807n ? toI128(updated) - 18446744073709551616n : toI128(updated)) < toI128(t)) return { err: VR_JUPLEND_LENDING_STALE, v: 0n };
  if (hasRateModel) {
    if (rateModel.owner !== VR_JUPLEND_LIQUIDITY_ID) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
    if (rateModel.dataLen < 53n || readData<u64>(rateModel, 0n) !== VR_RATE_MODEL_DISC) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  }
  const base = juplendTokenSupplyRate(tr, extraNative, hasRateModel, rateModel);
  if (base.err !== 0n) return base;
  if (rewardsModel.key !== readData<Pubkey>(lending, 75n)) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  if (fTokenMint.key !== readData<Pubkey>(lending, 40n)) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  if (rewardsModel.dataLen < 89n || readData<u64>(rewardsModel, 0n) !== VR_REWARDS_MODEL_DISC) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  // InterfaceAccount::<Mint>::try_from: a token program's initialized mint.
  if (fTokenMint.owner !== VR_TOKEN_ID && fTokenMint.owner !== VR_TOKEN_2022_ID) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  if (fTokenMint.dataLen < 82n || readData<u8>(fTokenMint, 45n) === 0n) return { err: VR_JUPLEND_LENDING_VALIDATION_FAILED, v: 0n };
  const supply = toU256(readData<u64>(fTokenMint, 36n));
  const p = toU256(readData<u64>(lending, 115n)) * supply;
  if (p > VR_U128_MAX) return vrNone();
  const totalAssets = p / VR_E12 + toU256(extraNative);
  if (totalAssets > VR_U128_MAX) return vrNone();
  const rewards = juplendRewardsApr(rewardsModel, totalAssets, toU64(toU128(toI128(t) < 0n ? toI128(t) + 18446744073709551616n : toI128(t))));
  if (rewards.err !== 0n) return rewards;
  const sum = fxTryAdd(base.v, rewards.v);
  return sum.err !== 0n ? vrNone() : sum;
}
