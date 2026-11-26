// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs and
// aeyakovenko/percolator src/v16.rs, Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// BatchTradeNoCpi (tag 66): `handle_batch_trade_nocpi` and `handle_batch_execute_zero_copy`, which BatchTradeCpi
// (matcher.ts) shares after its matcher's fills: up to 16 legs on distinct assets between two portfolios, A long for
// a positive size of each leg, one engine batch (trade.ts `executeBatch`: both accounts settled once, every leg
// applied, one end-state margin check), and per leg the processor's bookkeeping around it: the accepted print, the fee
// quote, the zero-move funding accrual (not for BatchTradeCpi, which accrued before its matcher call), the collected
// fee allocated to the legs in order, the budget credits, the post-trade mark and its staged target.
//
// Copies (NOTES.md, section 16). The original reads each leg's oracle profile into a copy, changes it (the funding-mark
// checkpoint and the zero-move simulation, then the mark) and writes it back only when the profile is one a trade
// moves (`profile_updates_mark_from_trade_view` at the batch's slot); for any other profile the accrual's changes to
// the copy are dropped (the asset's accrual itself stays). The port accrues in place and, for a profile it will not
// write back, puts the profile's bytes back at once: nothing reads them in between (the engine reads no oracle
// profile; the batch refuses a backing-fee policy, the only other reader). Whether a profile is written back is known
// then: the batch's slot (the market's authenticated slot) does not move during the instruction, and nothing else
// changes the profile. The requests, the per-leg context, the fee credits and the targets are fixed local arrays of
// 16 (34 credits) where the original allocates vectors.
import {
  type FixedArray,
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type i128,
  type u32,
  type u64,
  type u128,
  fixedArray,
  loadRawAt,
  loadRawMutAt,
  require,
  i128 as toI128,
  u64 as toU64,
} from "typesol";
import { PercolatorError, checkV16 } from "./errors.js";
import {
  type AssetOracleProfile,
  type AssetOracleWrapper,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type WrapperConfig,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  MAX_ORACLE_PRICE,
  ORACLE_MODE_EWMA_MARK,
  validateAssetOracleProfile,
  validateWrapperConfig,
} from "./state.js";
import { PORTFOLIO_SOURCE_DOMAIN_CAP, engineSlotAt, legErr, setAssetRawOracleTargets } from "./engine.js";
import { V16_MAX_PORTFOLIO_ASSETS_N } from "./wire.js";
import { domainIsOccupied } from "./primitives.js";
import { type BatchOutcome, type BatchRequest, executeBatch } from "./trade.js";
import { creditDomainInsuranceBudgets } from "./refresh.js";
import { absH } from "./health.js";
import {
  type DomainSnapshot,
  type FeeQuote,
  MAX_BOUNDED_SOURCE_DOMAINS,
  MAX_LIEN_REFRESH_WORK,
  acceptedTradePrice,
  accrueZeroMoveBeforePositionChange,
  bumpPositionEpoch,
  bumpPositionEpochWithMatcherState,
  collectMaintenanceFeesBeforeTrade,
  collectedFeeSupportedMark,
  deltaMayRequireCapacity,
  ensureGrownLiensFullRate,
  ensureNewCounterpartyLiensFresh,
  ensureTradePortfolioCurrentFor,
  expectPositionBinding,
  feeQuote,
  isPriceManaged,
  lienRefreshWork,
  mulDivByU64,
  occupiedCount,
  policyNotionalCeil,
  prepareTradeDrivenTarget,
  pushReserved,
  rejectMaturedForProfile,
  signedPositionForAsset,
  snapshot,
  updateMarkAfterTrade,
  updatesMarkFromTrade,
} from "./trading.js";
import {
  authenticatedMarketSlot,
  ensurePortfolioStorage,
  expectPortfolioAccountKey,
  marketViewMut,
  needAccounts,
  ownerCheck,
  portfolioViewMut,
  profileFromView,
  readMarketConfigMode,
  signerCheck,
  writableCheck,
} from "./program.js";

const U128_MAX_BT: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MAX_BT: u128 = 0x7fffffffffffffffffffffffffffffffn;
const I128_MIN_BT: i128 = -0x80000000000000000000000000000000n;
/** The batch's legs: `BATCH_TRADE_DECODE_MAX_LEGS`. */
export const BATCH_LEG_CAP = 16n;
/** A leg's 42 bytes: asset u16, market id u64, size i128, then two u64 (exec price and fee for BatchTradeNoCpi). */
export const BATCH_LEG_LEN = 42n;

/** What the processor keeps per leg besides the engine request (the original's `leg_ctx` tuple): the market id the
 * signers expected, the fee quote's mark and its paid amounts, the positions before the batch, and whether the leg's
 * oracle profile is written back. */
export interface BatchLeg {
  market_id: u64;
  post_trade_mark: u64;
  writes: boolean;
  base_fee_paid: u128;
  externality: u128;
  pos_a: i128;
  pos_b: i128;
}

/** An i128 from its two's-complement bits read as a u128. */
export function signedFromBits(raw: u128): i128 {
  return raw > I128_MAX_BT ? -toI128(U128_MAX_BT - raw) - 1n : toI128(raw);
}

/**
 * `handle_batch_trade_nocpi(a_id, a_epoch, b_id, b_epoch, legs)`: accounts signer A, signer B, market (w), portfolio
 * A (w), portfolio B (w). Both owners sign; the three writable and the program's; the portfolios distinct
 * (InvalidInstruction); each portfolio's id and position epoch; every leg's print valid (OracleInvalid); the market's
 * config and a Live mode (EngineLockActive); every leg's signed fee at least the policy's base fee
 * (InvalidInstruction). Then `handle_batch_execute_zero_copy` (not matcher-synchronized, no fee cap).
 *
 * @noinline
 */
export function batchTradeNoCpi(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 5n);
  const signerA = rest.get(0n);
  const signerB = rest.get(1n);
  const m = rest.get(2n);
  const pa = rest.get(3n);
  const pb = rest.get(4n);
  signerCheck(signerA);
  signerCheck(signerB);
  writableCheck(m);
  writableCheck(pa);
  writableCheck(pb);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  ownerCheck(pb, programId);
  require(pa.key !== pb.key, PercolatorError.InvalidInstruction);
  const n = toU64(data.readU8(1n));
  const tail = 2n + n * BATCH_LEG_LEN;
  const aId = data.readU64(tail);
  const aEpoch = data.readU64(tail + 8n);
  const bId = data.readU64(tail + 16n);
  const bEpoch = data.readU64(tail + 24n);
  expectPositionBinding(pa, aId, aEpoch);
  expectPositionBinding(pb, bId, bEpoch);
  for (let i = 0n; i < n; i++) {
    const exec = data.readU64(2n + i * BATCH_LEG_LEN + 26n);
    require(exec !== 0n && exec <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  }
  require(readMarketConfigMode(m) === 0n, PercolatorError.EngineLockActive);
  const base = loadRawAt<WrapperConfig>(m, HEADER_LEN).trade_fee_base_bps;
  for (let i = 0n; i < n; i++) require(!(base > data.readU64(2n + i * BATCH_LEG_LEN + 34n)), PercolatorError.InvalidInstruction);
  const reqs = fixedArray<BatchRequest, 16>({ asset: 0n, size: 0n, price: 0n, fee_bps: 0n });
  const legs = fixedArray<BatchLeg, 16>({ market_id: 0n, post_trade_mark: 0n, writes: false, base_fee_paid: 0n, externality: 0n, pos_a: 0n, pos_b: 0n });
  for (let i = 0n; i < n; i++) {
    const at = 2n + i * BATCH_LEG_LEN;
    const r = reqs.get(i);
    r.asset = toU64(data.readU16(at));
    r.size = signedFromBits(data.readU128(at + 10n));
    r.price = data.readU64(at + 26n);
    r.fee_bps = data.readU64(at + 34n);
    legs.get(i).market_id = data.readU64(at + 2n);
  }
  batchExecute(signerA.key, signerB.key, m, pa, pb, aId, aEpoch, bId, bEpoch, reqs, legs, n, false, false, 0n);
}

/**
 * `handle_batch_execute_zero_copy(owner_a, owner_b, market, A, B, ids and epochs, legs, matcher_synchronized,
 * max_account_a_fee_atoms)` up to the engine: NonProgress for no leg; both portfolios' storage; the market view; a
 * backing-fee policy refused (InvalidInstruction: per-leg backing fees are not split in a batch); the bindings again,
 * both portfolio views, their account ids and owners (Unauthorized); then each leg in order (`batchPrePassLeg`); unless
 * matcher-synchronized, both portfolios current for the requests; both maintenance fees; the source-domain admission
 * when a leg may need it; then the rest (`batchAfterChecks`). `reqs` holds each leg's asset, signed size, print and
 * signed fee; the pre-pass replaces the print with the fee basis and the fee with the quoted rate.
 *
 * @noinline
 */
export function batchExecute(
  ownerA: Pubkey,
  ownerB: Pubkey,
  m: RemainingAccount,
  pa: RemainingAccount,
  pb: RemainingAccount,
  aId: u64,
  aEpoch: u64,
  bId: u64,
  bEpoch: u64,
  reqs: Inout<FixedArray<BatchRequest, 16>>,
  legs: Inout<FixedArray<BatchLeg, 16>>,
  n: u64,
  synced: boolean,
  hasFeeCap: boolean,
  feeCap: u128,
): void {
  require(n !== 0n, PercolatorError.EngineNonProgress);
  ensurePortfolioStorage(pa);
  ensurePortfolioStorage(pb);
  const markets = marketViewMut(m);
  require(loadRawAt<WrapperConfig>(m, HEADER_LEN).backing_trade_fee_policy_count === 0n, PercolatorError.InvalidInstruction);
  expectPositionBinding(pa, aId, aEpoch);
  expectPositionBinding(pb, bId, bEpoch);
  portfolioViewMut(pa);
  portfolioViewMut(pb);
  expectPortfolioAccountKey(pa);
  expectPortfolioAccountKey(pb);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === ownerA, PercolatorError.Unauthorized);
  require(loadRawAt<Portfolio>(pb, HEADER_LEN).owner === ownerB, PercolatorError.Unauthorized);
  const now = authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot);
  let needsCapacity = false;
  for (let i = 0n; i < n; i++) if (batchPrePassLeg(m, markets, pa, pb, reqs, legs, i, synced, now)) needsCapacity = true;
  if (!synced) {
    ensureTradePortfolioCurrentFor(m, markets, pa, reqs, n);
    ensureTradePortfolioCurrentFor(m, markets, pb, reqs, n);
  }
  collectMaintenanceFeesBeforeTrade(m, markets, pa, pb);
  if (needsCapacity) admitBatchSourceDomains(m, markets, pa, pb, reqs, legs, n);
  batchAfterChecks(m, markets, pa, pb, reqs, legs, n, synced, hasFeeCap, feeCap);
}

/**
 * One leg of the pre-pass: a second leg of an asset refused (InvalidInstruction); the asset in the view with the
 * expected market id (AssetGenerationMismatch); its oracle profile (validated); a matured permissionless resolution
 * refused (OracleStale); the size nonzero and not i128::MIN (InvalidInstruction); both positions on the asset; whether
 * the leg may need source-domain capacity (A's delta, then B's only when A's does not); unless matcher-synchronized,
 * the zero-move funding accrued (Stale when a reducing leg leaves some to a crank); the accepted print and the fee
 * quote. Returns whether the leg may need capacity.
 *
 * @noinline
 */
function batchPrePassLeg(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  pb: RemainingAccount,
  reqs: Inout<FixedArray<BatchRequest, 16>>,
  legs: Inout<FixedArray<BatchLeg, 16>>,
  i: u64,
  synced: boolean,
  now: u64,
): boolean {
  const r = reqs.get(i);
  const leg = legs.get(i);
  const asset = r.asset;
  for (let j = 0n; j < i; j++) require(reqs.get(j).asset !== asset, PercolatorError.InvalidInstruction);
  require(asset < markets && loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.market_id === leg.market_id, PercolatorError.AssetGenerationMismatch);
  const at = profileFromView(m, markets, asset);
  rejectMaturedForProfile(m, at);
  const size = r.size;
  require(size !== 0n && size !== I128_MIN_BT, PercolatorError.InvalidInstruction);
  const sizeAbs = absH(size);
  const posA = signedPositionForAsset(m, markets, pa, asset);
  const posB = signedPositionForAsset(m, markets, pb, asset);
  leg.pos_a = posA;
  leg.pos_b = posB;
  const reduces = (posA > 0n && size < 0n) || (posA < 0n && size > 0n) || (posB > 0n && -size < 0n) || (posB < 0n && -size > 0n);
  const needs = deltaMayRequireCapacity(posA, size) || deltaMayRequireCapacity(posB, -size);
  if (!synced) accrueKeepingUnwrittenProfile(m, markets, at, asset, reduces, now);
  const basis = acceptedTradePrice(m, markets, at, asset, r.price);
  const profile = loadRawAt<AssetOracleProfile>(m, at);
  const quote = feeQuote(m, markets, profile, asset, sizeAbs, basis, r.fee_bps);
  leg.writes = updatesMarkFromTrade(profile, now);
  r.price = basis;
  r.fee_bps = quote.fee_bps;
  leg.post_trade_mark = quote.post_trade_mark;
  leg.base_fee_paid = quote.base_fee_paid;
  leg.externality = quote.externality;
  return needs;
}

/**
 * `accrue_zero_move_funding_before_position_change_for_profile_view` on the leg's copy of its profile: the port
 * accrues in place and puts the profile's bytes back when the batch will not write the copy back (a profile no trade
 * moves at the batch's slot; an EWMA profile always is).
 *
 * @noinline
 */
function accrueKeepingUnwrittenProfile(m: RemainingAccount, markets: u64, at: u64, asset: u64, reduces: boolean, now: u64): void {
  if (loadRawAt<AssetOracleProfile>(m, at).oracle_mode === ORACLE_MODE_EWMA_MARK) {
    accrueZeroMoveBeforePositionChange(m, markets, at, asset, reduces);
    return;
  }
  const saved: AssetOracleProfile = loadRawAt<AssetOracleProfile>(m, at);
  accrueZeroMoveBeforePositionChange(m, markets, at, asset, reduces);
  if (updatesMarkFromTrade(loadRawAt<AssetOracleProfile>(m, at), now)) return;
  const w = loadRawMutAt<AssetOracleWrapper>(m, at);
  w.profile = saved;
}

/**
 * The source-domain admission of a batch: both snapshots (A's with each request's delta, B's with its negation), then
 * leg by leg A's admission and B's (`ensure_trade_delta_source_domain_capacity_view`).
 *
 * @noinline
 */
function admitBatchSourceDomains(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  pb: RemainingAccount,
  reqs: FixedArray<BatchRequest, 16>,
  legs: FixedArray<BatchLeg, 16>,
  n: u64,
): void {
  const domsA = fixedArray<u64, 32>(0n);
  const domsB = fixedArray<u64, 32>(0n);
  let lenA = reservedDomainsFor(m, markets, pa, reqs, n, false, domsA);
  let lenB = reservedDomainsFor(m, markets, pb, reqs, n, true, domsB);
  for (let i = 0n; i < n; i++) {
    const asset = reqs.get(i).asset;
    const size = reqs.get(i).size;
    lenA = ensureDeltaCapacityLen(domsA, lenA, asset, legs.get(i).pos_a, size);
    lenB = ensureDeltaCapacityLen(domsB, lenB, asset, legs.get(i).pos_b, -size);
  }
}

/**
 * `reserved_source_domains_snapshot_for_trade_view(group, account, requests, invert)`: the occupied domains, then both
 * domains of every active leg (each leg decoded) except one whose request (the first of its asset) closes it, each
 * added once within the wrapper's bound (InvalidInstruction). Returns the count.
 */
function reservedDomainsFor(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  reqs: FixedArray<BatchRequest, 16>,
  n: u64,
  invert: boolean,
  doms: Inout<FixedArray<u64, 32>>,
): u64 {
  let len = 0n;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = p.source_domains.get(slot);
    if (!domainIsOccupied(s)) continue;
    // `out.len >= out.domains.len()` cannot hold within 32 slots.
    doms.set(len, toU64(s.domain));
    len += 1n;
  }
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) continue;
    const legAsset = toU64(leg.asset_index);
    let closes = false;
    for (let i = 0n; i < n; i++) {
      if (reqs.get(i).asset !== legAsset) continue;
      // current.checked_add(delta) == Some(0), without forming an overflowing sum.
      const delta = invert ? -reqs.get(i).size : reqs.get(i).size;
      closes = signedPositionForAsset(m, markets, pa, legAsset) === -delta;
      break;
    }
    if (closes) continue;
    len = pushReserved(doms, len, legAsset * 2n);
    len = pushReserved(doms, len, legAsset * 2n + 1n);
  }
  return len;
}

/** `ensure_trade_delta_source_domain_capacity_view(admitted, asset, current, delta)`: when the delta may need it, the
 * snapshot within the bound (InvalidInstruction) and the asset's pair admitted. Returns the new count. */
function ensureDeltaCapacityLen(doms: Inout<FixedArray<u64, 32>>, len: u64, asset: u64, current: i128, delta: i128): u64 {
  if (!deltaMayRequireCapacity(current, delta)) return len;
  require(len <= MAX_BOUNDED_SOURCE_DOMAINS, PercolatorError.InvalidInstruction);
  const next = pushReserved(doms, len, asset * 2n);
  return pushReserved(doms, next, asset * 2n + 1n);
}

/**
 * `handle_batch_execute_zero_copy` from the snapshots on: both portfolios' snapshots and lien work; the engine's batch
 * (A long for a positive leg); each request's side-OI cap; a fee charged to A above the cap BatchTradeCpi signs
 * (InvalidInstruction); new counterparty liens fresh; the fees allocated to the legs (`batchFeeLegs`); the lien bounds
 * (growth, work, full rate); A's position epoch advanced, B's after its matcher's fill when synchronized; for a
 * price-managed asset 0 whose profile was written, the config's mark fields, validated, last.
 *
 * @noinline
 */
function batchAfterChecks(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  pb: RemainingAccount,
  reqs: FixedArray<BatchRequest, 16>,
  legs: FixedArray<BatchLeg, 16>,
  n: u64,
  synced: boolean,
  hasFeeCap: boolean,
  feeCap: u128,
): void {
  const beforeA: DomainSnapshot = { domains: fixedArray<u32, 32>(0n), backing: fixedArray<u128, 32>(0n), lien: fixedArray<u128, 32>(0n), len: 0n };
  const beforeB: DomainSnapshot = { domains: fixedArray<u32, 32>(0n), backing: fixedArray<u128, 32>(0n), lien: fixedArray<u128, 32>(0n), len: 0n };
  snapshot(pa, beforeA);
  snapshot(pb, beforeB);
  const workA = lienRefreshWork(pa);
  const workB = lienRefreshWork(pb);
  const out = executeBatch(m, markets, pa, pb, reqs, n);
  // ensure_trade_side_oi_cap_view for each request (the asset in the view: EngineInvalidLeg).
  for (let i = 0n; i < n; i++) {
    const asset = reqs.get(i).asset;
    require(asset < markets, PercolatorError.EngineInvalidLeg);
    const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
    require(a.oi_eff_long_q <= 100000000000000n && a.oi_eff_short_q <= 100000000000000n, PercolatorError.EngineInvalidLeg);
  }
  require(!(hasFeeCap && out.fee_a > feeCap), PercolatorError.InvalidInstruction);
  const landing = authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot);
  ensureNewCounterpartyLiensFresh(m, markets, pa, beforeA, landing);
  ensureNewCounterpartyLiensFresh(m, markets, pb, beforeB, landing);
  const mirror = batchFeeLegs(m, markets, reqs, legs, n, out);
  const afterA = occupiedCount(pa);
  const afterB = occupiedCount(pb);
  require(!(afterA > beforeA.len && afterA > MAX_BOUNDED_SOURCE_DOMAINS), PercolatorError.InvalidInstruction);
  require(!(afterB > beforeB.len && afterB > MAX_BOUNDED_SOURCE_DOMAINS), PercolatorError.InvalidInstruction);
  const afterWorkA = lienRefreshWork(pa);
  require(!(afterWorkA > workA && afterWorkA > MAX_LIEN_REFRESH_WORK), PercolatorError.InvalidInstruction);
  const afterWorkB = lienRefreshWork(pb);
  require(!(afterWorkB > workB && afterWorkB > MAX_LIEN_REFRESH_WORK), PercolatorError.InvalidInstruction);
  ensureGrownLiensFullRate(m, markets, pa, beforeA);
  ensureGrownLiensFullRate(m, markets, pb, beforeB);
  bumpPositionEpoch(pa);
  bumpPositionEpochWithMatcherState(pb, synced);
  if (mirror) {
    const p = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, 0n));
    const c = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
    c.mark_ewma_e6 = p.mark_ewma_e6;
    c.mark_ewma_last_slot = p.mark_ewma_last_slot;
    c.oracle_target_price_e6 = p.oracle_target_price_e6;
    validateWrapperConfig(c);
  }
}

/**
 * The fee loop of `handle_batch_execute_zero_copy`: each account's collected fee allocated against the legs' requested
 * fees in order (`policy_v16::batch_leg_fee` on the leg's size, basis and rate: EngineArithmeticOverflow), each leg's
 * share split into the long and short side and, less the mark-externality part, accumulated into the domains' budget
 * credits (an asset other than 0 redirecting its share to market 0's domains, half long and the rest short); for a leg
 * whose profile a trade moves, the post-trade mark from the fees collected, its staged target and the profile written
 * (validated). Fees left over are EngineArithmeticOverflow; then the credits and the targets, each in one engine call.
 * Returns whether asset 0's price-managed profile was written (the config's mirror).
 *
 * @noinline
 */
function batchFeeLegs(m: RemainingAccount, markets: u64, reqs: FixedArray<BatchRequest, 16>, legs: FixedArray<BatchLeg, 16>, n: u64, out: BatchOutcome): boolean {
  let remA = out.fee_a;
  let remB = out.fee_b;
  let mirror = false;
  const creditDomains = fixedArray<u64, 34>(0n);
  const creditAmounts = fixedArray<u128, 34>(0n);
  let credits = 0n;
  const targetAssets = fixedArray<u64, 16>(0n);
  const targetPrices = fixedArray<u64, 16>(0n);
  let targets = 0n;
  // v16_domain_count_for_market_slots (no overflow for a u32 count).
  const domainCount = 2n * toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots);
  for (let i = 0n; i < n; i++) {
    const r = reqs.get(i);
    const leg = legs.get(i);
    const quote: FeeQuote = { fee_bps: r.fee_bps, post_trade_mark: leg.post_trade_mark, base_fee_paid: leg.base_fee_paid, externality: leg.externality };
    const requested = batchLegFee(absH(r.size), r.price, r.fee_bps);
    const feeA = requested < remA ? requested : remA;
    const feeB = requested < remB ? requested : remB;
    remA -= feeA;
    remB -= feeB;
    if (feeA !== 0n || feeB !== 0n) {
      const feeLong = r.size > 0n ? feeA : feeB;
      const feeShort = r.size > 0n ? feeB : feeA;
      const budgeted = budgetedFees(feeLong, feeShort, quote);
      credits = accumulateFeeCredit(m, creditDomains, creditAmounts, credits, domainCount, r.asset * 2n, budgeted.fee_a);
      credits = accumulateFeeCredit(m, creditDomains, creditAmounts, credits, domainCount, r.asset * 2n + 1n, budgeted.fee_b);
    }
    if (!leg.writes) continue;
    const at = profileFromView(m, markets, r.asset);
    const w = loadRawMutAt<AssetOracleWrapper>(m, at);
    const collected = collectedFeeSupportedMark(w.profile.mark_ewma_e6, quote, feeA, feeB);
    updateMarkAfterTrade(m, markets, w.profile, r.asset, collected);
    if (prepareTradeDrivenTarget(m, markets, w.profile, r.asset)) {
      targetAssets.set(targets, r.asset);
      targetPrices.set(targets, w.profile.oracle_target_price_e6);
      targets += 1n;
    }
    validateAssetOracleProfile(w.profile);
    if (r.asset === 0n && isPriceManaged(w.profile)) mirror = true;
  }
  require(remA === 0n && remB === 0n, PercolatorError.EngineArithmeticOverflow);
  if (credits !== 0n) creditDomainInsuranceBudgets(m, markets, creditDomains, creditAmounts, credits);
  if (targets !== 0n) setAssetRawOracleTargets(m, markets, targetAssets, targetPrices, targets);
  return mirror;
}

/** `policy_v16::batch_leg_fee(abs_size, price, bps)`: 0 for no size or rate; ⌈notional · bps / 10,000⌉ on the ceiling
 * notional (EngineArithmeticOverflow past u128). */
function batchLegFee(size: u128, price: u64, bps: u64): u128 {
  if (size === 0n || bps === 0n) return 0n;
  const notional = policyNotionalCeil(size, price);
  if (notional === 0n) return 0n;
  return mulDivByU64(notional, bps, 10000n, true);
}

/** `trade_fee_budgeted_amounts_with_mark_externality_view(long, short, quote)`: each side's fee less its part of the
 * mark-externality fee (the fees beyond the base fee paid, split half and half and moved to the other side where one
 * side's fee cannot hold its half). */
function budgetedFees(feeLong: u128, feeShort: u128, quote: FeeQuote): BatchOutcome {
  const plain: BatchOutcome = { fee_a: feeLong, fee_b: feeShort, notional: 0n };
  if (quote.externality === 0n) return plain;
  require(feeLong <= U128_MAX_BT - feeShort, PercolatorError.EngineArithmeticOverflow);
  const total = feeLong + feeShort;
  const markFee = total > quote.base_fee_paid ? total - quote.base_fee_paid : 0n;
  if (markFee === 0n) return plain;
  let markLong = markFee / 2n;
  let markShort = markFee - markLong;
  if (markLong > feeLong) {
    const over = markLong - feeLong;
    markLong = feeLong;
    markShort += over;
  }
  if (markShort > feeShort) {
    const over = markShort - feeShort;
    markShort = feeShort;
    markLong += over;
  }
  require(!(markLong > feeLong || markShort > feeShort), PercolatorError.EngineCounterUnderflow);
  return { fee_a: feeLong - markLong, fee_b: feeShort - markShort, notional: 0n };
}

/**
 * `accumulate_fee_to_domain_budget_credits(cfg, credits, domain_count, domain, amount)`: nothing for zero; for an asset
 * other than 0 the redirect share (`fee_share_floor`: EngineArithmeticOverflow) taken out; the rest credited to the
 * domain and the redirect split ⌊r / 2⌋ to domain 0 and the rest to domain 1 (`accumulate_domain_budget_credit`: each
 * nonzero amount to a domain below the count, InvalidInstruction, added to its entry, EngineArithmeticOverflow, or
 * appended). Returns the entry count.
 */
function accumulateFeeCredit(
  m: RemainingAccount,
  domains: Inout<FixedArray<u64, 34>>,
  amounts: Inout<FixedArray<u128, 34>>,
  count: u64,
  domainCount: u64,
  domain: u64,
  amount: u128,
): u64 {
  if (amount === 0n) return count;
  let redirect: u128 = 0n;
  if (domain / 2n !== 0n) redirect = mulDivByU64(amount, toU64(loadRawAt<WrapperConfig>(m, HEADER_LEN).fee_redirect_to_market_0_bps), 10000n, false);
  let c = accumulateCredit(domains, amounts, count, domainCount, domain, amount - redirect);
  const long = redirect / 2n;
  c = accumulateCredit(domains, amounts, c, domainCount, 0n, long);
  return accumulateCredit(domains, amounts, c, domainCount, 1n, redirect - long);
}

function accumulateCredit(domains: Inout<FixedArray<u64, 34>>, amounts: Inout<FixedArray<u128, 34>>, count: u64, domainCount: u64, domain: u64, amount: u128): u64 {
  if (amount === 0n) return count;
  require(domain < domainCount, PercolatorError.InvalidInstruction);
  for (let i = 0n; i < count; i++) {
    if (domains.get(i) !== domain) continue;
    require(amounts.get(i) <= U128_MAX_BT - amount, PercolatorError.EngineArithmeticOverflow);
    amounts.set(i, amounts.get(i) + amount);
    return count;
  }
  domains.set(count, domain);
  amounts.set(count, amount);
  return count + 1n;
}
