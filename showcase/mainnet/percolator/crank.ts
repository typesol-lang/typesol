// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb, src/percolator.rs `process_instruction`,
// `sweep_maintenance_fees`), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The keeper instructions: KeeperCrank (5), LiquidateAtOracle (7) and CatchupAccrue (31). Each is the original's
// handler statement for statement. KeeperCrank's candidate list (`combined`: the risk buffer's entries, each with
// FullClose, then the instruction's own candidates) is not built as a vector: the engine reads it in order from the
// risk buffer and the instruction data (engine.ts `nextCandidate`); the decode's cap of 128 candidates keeps it within
// the original's cap of 4 + 128, so its truncation never applies.
//
// The risk buffer: the original reads a sanitized copy before the crank (for `combined`) and a second sanitized copy
// after it, which it changes and writes back. Nothing writes the buffer in between, so the port sanitizes it once in
// place before the crank and makes the after-crank changes in place: the same bytes, without the two copies.
import {
  type FixedVec,
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccounts,
  type u16,
  type u64,
  type u128,
  ProgramError,
  fixedVec,
  log,
  log64,
  loadRawMut,
  loadRawMutAt,
  require,
  u16 as toU16,
  u64 as toU64,
  u128 as toU128,
} from "typesol";
import { PercolatorError, check } from "./errors.js";
import { type MarketConfig, type RiskBuffer, type RiskBufferHolder, type RiskEngine, BITMAP_WORDS, ENGINE_MAX_ACCOUNTS, ENGINE_OFF, RISK_BUF_OFF } from "./state.js";
import { U128_MAX, absI128, mulDivFloorU128 } from "./wide.js";
import { type PriceRead, computeCurrentFundingRateE9, getEngineOraclePriceE6, isHyperpMode, truncU64 } from "./oracle.js";
import {
  POS_SCALE,
  accrueMarketTo,
  effectivePosQ,
  isUsed,
  keeperCrankNotAtomic,
  liquidateAtOracleNotAtomic,
  notional,
  reclaimEmptyAccountNotAtomic,
  syncAccountFeeToSlotNotAtomic,
} from "./engine.js";
import {
  type SlabPrefix,
  CATCHUP_CHUNKS_MAX,
  catchupAccrue,
  checkIdx,
  engineIsResolved,
  ensureMarketAccruedToNow,
  expectLen,
  expectSigner,
  expectWritable,
  markOracleInitialized,
  readClock,
  readPriceAndStamp,
  recomputeMin,
  requireInitialized,
  riskBufferRemove,
  riskBufferUpsert,
  sanitizeRiskBuffer,
  slabGuard,
  syncAccountFee,
} from "./program.js";

/** constants::CRANK_NO_CALLER: the permissionless crank's caller index. */
const CRANK_NO_CALLER = 65535n;
/** constants::FEE_SWEEP_BUDGET: fee syncs per crank. */
const FEE_SWEEP_BUDGET = 128n;
/** percolator::LIQ_BUDGET_PER_CRANK. */
const LIQ_BUDGET_PER_CRANK = 64n;
/** LIQ_BUDGET_PER_CRANK · 2: the most candidates the decode accepts. */
const MAX_CANDIDATES = 128n;
/** constants::CRANK_REWARD_BPS. */
const CRANK_REWARD_BPS: u128 = 5000n;
/** constants::RISK_SCAN_WINDOW. */
const RISK_SCAN_WINDOW = 32n;

// ---- KeeperCrank (tag 5) -----------------------------------------------------------------------------------------------

/** @noinline */
export function keeperCrank(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  // Instruction::decode: the caller, format 1, then (u16 index, u8 tag) per candidate, tag 1 followed by a u128, at
  // most 128 of them, nothing left over (InvalidInstructionData otherwise). Kept as index | tag << 16 | the offset of
  // the u128 << 24.
  const len = data.length;
  require(len >= 4n, ProgramError.InvalidInstructionData);
  require(data.readU8(3n) === 1n, ProgramError.InvalidInstructionData);
  const cands: FixedVec<u64, 128> = fixedVec([]);
  let at = 4n;
  while (len - at >= 3n) {
    require(cands.length < MAX_CANDIDATES, ProgramError.InvalidInstructionData);
    const policy = toU64(data.readU8(at + 2n));
    const c = toU64(data.readU16(at)) | (policy << 16n);
    if (policy === 1n) {
      require(len - at >= 19n, ProgramError.InvalidInstructionData);
      cands.push(c | ((at + 3n) << 24n));
      at += 19n;
    } else {
      require(policy === 0n || policy === 0xffn, ProgramError.InvalidInstructionData);
      cands.push(c);
      at += 3n;
    }
  }
  require(at === len, ProgramError.InvalidInstructionData);
  const callerIdx = data.readU16(1n);
  expectLen(rest.length, 4n);
  const aCaller = rest.get(0n);
  const aSlab = rest.get(1n);
  const permissionless = callerIdx === CRANK_NO_CALLER;
  if (!permissionless) expectSigner(aCaller);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  if (engineIsResolved(aSlab)) {
    // A resolved market: nothing to do (the resolved price must be set).
    const e0 = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
    require(e0.resolved_price !== 0n, ProgramError.InvalidAccountData);
    return;
  }
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const clock = readClock(rest.get(2n));
  const rate = computeCurrentFundingRateE9(prefix.config);
  const read: PriceRead = { price: 0n, publish_time: 0n };
  if (isHyperpMode(prefix.config)) check(getEngineOraclePriceE6(clock.slot, clock.unix_timestamp, prefix.config, rest.get(3n), read));
  else check(readPriceAndStamp(prefix.config, rest.get(3n), clock.unix_timestamp, clock.slot, read));
  const price = read.price;
  const holder = loadRawMutAt<RiskBufferHolder>(aSlab, RISK_BUF_OFF);
  sanitizeRiskBuffer(holder.buffer);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  if (!permissionless) {
    checkIdx(e, callerIdx);
    require(e.accounts.get(toU64(callerIdx)).owner === aCaller.key, PercolatorError.EngineUnauthorized);
  }
  const bufCount = toU64(holder.buffer.count);
  ensureMarketAccruedToNow(e, clock.slot, price, rate);
  const fee = prefix.config.maintenance_fee_per_slot;
  const insBefore = e.insurance_balance;
  let candidateSyncs = 0n;
  if (fee > 0n) candidateSyncs = syncCandidateFees(e, fee, clock.slot, holder.buffer, bufCount, cands);
  sweepMaintenanceFees(e, prefix.config, clock.slot, FEE_SWEEP_BUDGET - candidateSyncs);
  const sweepDelta = e.insurance_balance > insBefore ? e.insurance_balance - insBefore : 0n;
  const hMin = e.params.h_min;
  const hMax = e.params.h_max;
  const liqs = keeperCrankNotAtomic(e, clock.slot, price, holder.buffer, bufCount, cands, data, LIQ_BUDGET_PER_CRANK, rate, hMin, hMax);
  if (!permissionless && fee > 0n && sweepDelta > 0n && isUsed(e, toU64(callerIdx))) {
    // sweep_delta · CRANK_REWARD_BPS (saturating) / 10_000, at most the insurance left.
    let reward: u128 = (sweepDelta > U128_MAX / CRANK_REWARD_BPS ? U128_MAX : sweepDelta * CRANK_REWARD_BPS) / 10000n;
    const insNow = e.insurance_balance;
    if (reward > insNow) reward = insNow;
    if (reward > 0n) {
      const a = e.accounts.get(toU64(callerIdx));
      require(a.capital <= U128_MAX - reward, PercolatorError.EngineOverflow);
      require(e.c_tot <= U128_MAX - reward, PercolatorError.EngineOverflow);
      e.insurance_balance = insNow - reward;
      a.capital += reward;
      e.c_tot += reward;
    }
  }
  const insLow = truncU64(e.insurance_balance);
  markOracleInitialized(prefix);
  updateRiskBufferAfterCrank(e, holder.buffer, cands, price);
  log("CRANK_STATS");
  log64(0xc8a4cn, liqs, ENGINE_MAX_ACCOUNTS, insLow, 0n);
}

/**
 * The candidates' fee syncs before the sweep: the combined list in order (the risk buffer's entries, then the
 * instruction's), missing slots skipped without counting, at most LIQ_BUDGET_PER_CRANK attempts, each account synced
 * once. Returns the syncs made.
 */
function syncCandidateFees(e: Inout<RiskEngine>, fee: u128, nowSlot: u64, buf: RiskBuffer, bufCount: u64, cands: FixedVec<u64, 128>): u64 {
  const synced: FixedVec<u16, 64> = fixedVec([]);
  let attempts = 0n;
  const total = bufCount + cands.length;
  for (let k = 0n; k < total; k++) {
    const idx: u16 = k < bufCount ? buf.entries.get(k).idx : toU16(cands.get(k - bufCount) & 0xffffn);
    if (attempts >= LIQ_BUDGET_PER_CRANK) break;
    if (synced.length >= FEE_SWEEP_BUDGET) break;
    const i = toU64(idx);
    if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) continue;
    attempts += 1n;
    let already = false;
    for (let j = 0n; j < synced.length; j++)
      if (synced.get(j) === idx) {
        already = true;
        break;
      }
    if (already) continue;
    syncAccountFeeToSlotNotAtomic(e, idx, nowSlot, fee);
    synced.push(idx);
  }
  return synced.length;
}

/**
 * sweep_maintenance_fees: from the cursor (word, bit), sync every used account's fees, at most `maxSyncs`, reclaiming
 * the flat accounts the fee drained to nothing; the cursor stops exactly at the budget.
 */
function sweepMaintenanceFees(e: Inout<RiskEngine>, config: Inout<MarketConfig>, nowSlot: u64, maxSyncs: u64): void {
  const fee = config.maintenance_fee_per_slot;
  if (fee === 0n) return;
  if (maxSyncs === 0n) return;
  let word = config.fee_sweep_cursor_word % BITMAP_WORDS;
  const bitCursor = config.fee_sweep_cursor_bit & 63n;
  let syncs = 0n;
  let scanned = 0n;
  let resume = bitCursor;
  while (scanned < BITMAP_WORDS) {
    let bits = e.used.get(word);
    if (resume !== 0n) bits &= ~((1n << resume) - 1n);
    while (bits !== 0n) {
      const bit = trailingZeros(bits);
      if (syncs >= maxSyncs) {
        config.fee_sweep_cursor_word = word;
        config.fee_sweep_cursor_bit = bit;
        return;
      }
      bits &= bits - 1n;
      const idx = word * 64n + bit;
      syncAccountFeeToSlotNotAtomic(e, toU16(idx), nowSlot, fee);
      syncs += 1n;
      const a = e.accounts.get(idx);
      if (a.capital === 0n && a.position_basis_q === 0n && a.pnl === 0n && a.reserved_pnl === 0n && a.sched_present === 0n && a.pending_present === 0n && a.fee_credits <= 0n)
        reclaimEmptyAccountNotAtomic(e, toU16(idx), nowSlot);
    }
    word = (word + 1n) % BITMAP_WORDS;
    resume = 0n;
    scanned += 1n;
    if (syncs >= maxSyncs) break;
  }
  config.fee_sweep_cursor_word = word;
  config.fee_sweep_cursor_bit = 0n;
}

/** u64::trailing_zeros of a nonzero word. */
function trailingZeros(x: u64): u64 {
  let n = 0n;
  let v = x;
  if ((v & 0xffffffffn) === 0n) {
    n += 32n;
    v >>= 32n;
  }
  if ((v & 0xffffn) === 0n) {
    n += 16n;
    v >>= 16n;
  }
  if ((v & 0xffn) === 0n) {
    n += 8n;
    v >>= 8n;
  }
  if ((v & 0xfn) === 0n) {
    n += 4n;
    v >>= 4n;
  }
  if ((v & 0x3n) === 0n) {
    n += 2n;
    v >>= 2n;
  }
  if ((v & 0x1n) === 0n) n += 1n;
  return n;
}

/** The risk buffer after the crank: dead entries scrubbed, the rest refreshed, a scan window, then the candidates. */
function updateRiskBufferAfterCrank(e: RiskEngine, buf: Inout<RiskBuffer>, cands: FixedVec<u64, 128>, price: u64): void {
  // Phase A: scrub entries whose slot is free or flat (from the last).
  let i = 4n;
  while (i > 0n) {
    i -= 1n;
    if (i >= toU64(buf.count)) continue;
    const eidx = toU64(buf.entries.get(i).idx);
    if (!isUsed(e, eidx) || effectivePosQ(e, eidx) === 0n) riskBufferRemove(buf, buf.entries.get(i).idx);
  }
  // Phase B: refresh the survivors' notionals.
  for (let k = 0n; k < toU64(buf.count); k++) {
    const ent = buf.entries.get(k);
    ent.notional = mulDivFloorU128(absI128(effectivePosQ(e, toU64(ent.idx))), toU128(price), POS_SCALE);
  }
  recomputeMin(buf);
  // Phase C: a window of RISK_SCAN_WINDOW slots from the cursor, wrapping at the market's max_accounts.
  let scanMod = e.params.max_accounts;
  if (scanMod === 0n || scanMod > ENGINE_MAX_ACCOUNTS) scanMod = ENGINE_MAX_ACCOUNTS;
  const scanStart = toU64(buf.scan_cursor) % scanMod;
  for (let off = 0n; off < RISK_SCAN_WINDOW; off++) {
    const idx = (scanStart + off) % scanMod;
    if (!isUsed(e, idx)) continue;
    const eff = effectivePosQ(e, idx);
    if (eff === 0n) continue;
    riskBufferUpsert(buf, toU16(idx), mulDivFloorU128(absI128(eff), toU128(price), POS_SCALE));
  }
  buf.scan_cursor = toU16((scanStart + RISK_SCAN_WINDOW) % scanMod);
  // Phase D: the instruction's candidates.
  for (let k = 0n; k < cands.length; k++) {
    const cidx = toU16(cands.get(k) & 0xffffn);
    const ci = toU64(cidx);
    if (ci >= ENGINE_MAX_ACCOUNTS || !isUsed(e, ci)) continue;
    const eff = effectivePosQ(e, ci);
    if (eff === 0n) riskBufferRemove(buf, cidx);
    else riskBufferUpsert(buf, cidx, mulDivFloorU128(absI128(eff), toU128(price), POS_SCALE));
  }
}

// ---- LiquidateAtOracle (tag 7) -----------------------------------------------------------------------------------------

/** @noinline */
export function liquidateAtOracle(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const targetIdx = data.readU16(1n);
  expectLen(rest.length, 4n);
  const aSlab = rest.get(1n);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const clock = readClock(rest.get(2n));
  const rate = computeCurrentFundingRateE9(prefix.config);
  const read: PriceRead = { price: 0n, publish_time: 0n };
  if (isHyperpMode(prefix.config)) check(getEngineOraclePriceE6(clock.slot, clock.unix_timestamp, prefix.config, rest.get(3n), read));
  else check(readPriceAndStamp(prefix.config, rest.get(3n), clock.unix_timestamp, clock.slot, read));
  const price = read.price;
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  checkIdx(e, targetIdx);
  const t = toU64(targetIdx);
  log64(t, price, 0n, 0n, 0n);
  log64(truncU64(e.accounts.get(t).capital), 0n, 0n, 0n, 1n);
  const eff = effectivePosQ(e, t);
  log64(truncU64(notional(e, t, price)), eff === 0n ? 1n : 0n, 0n, 0n, 2n);
  const hMin = e.params.h_min;
  const hMax = e.params.h_max;
  ensureMarketAccruedToNow(e, clock.slot, price, rate);
  syncAccountFee(e, prefix.config.maintenance_fee_per_slot, targetIdx, clock.slot);
  const res = liquidateAtOracleNotAtomic(e, targetIdx, clock.slot, price, rate, hMin, hMax);
  log64(res ? 1n : 0n, 0n, 0n, 0n, 4n);
  const liqEff = effectivePosQ(e, t);
  markOracleInitialized(prefix);
  const holder = loadRawMutAt<RiskBufferHolder>(aSlab, RISK_BUF_OFF);
  sanitizeRiskBuffer(holder.buffer);
  if (liqEff === 0n) riskBufferRemove(holder.buffer, targetIdx);
  else riskBufferUpsert(holder.buffer, targetIdx, mulDivFloorU128(absI128(liqEff), toU128(price), POS_SCALE));
}

// ---- CatchupAccrue (tag 31) --------------------------------------------------------------------------------------------

/**
 * CatchupAccrue: the oracle read proves the market live; then the engine's clock advances to now when one call can get
 * there (COMPLETE: the fresh observation kept), or by CATCHUP_CHUNKS_MAX · max_accrual_dt_slots at the stored price
 * (PARTIAL: the observation's price and index fields rolled back, its liveness stamp kept). The original restores a
 * copy of the config taken before the read; the read changes four fields, so the port keeps the two it rolls back.
 *
 * @noinline
 */
export function catchupAccrueIx(rest: RemainingAccounts, programId: Pubkey): void {
  expectLen(rest.length, 3n);
  const aSlab = rest.get(0n);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const clock = readClock(rest.get(1n));
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const preEffective = prefix.config.last_effective_price_e6;
  const preHyperpSlot = prefix.config.last_hyperp_index_slot;
  const rate = computeCurrentFundingRateE9(prefix.config);
  const read: PriceRead = { price: 0n, publish_time: 0n };
  if (isHyperpMode(prefix.config)) check(getEngineOraclePriceE6(clock.slot, clock.unix_timestamp, prefix.config, rest.get(2n), read));
  else check(readPriceAndStamp(prefix.config, rest.get(2n), clock.unix_timestamp, clock.slot, read));
  const fresh = read.price;
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  if (e.last_oracle_price === 0n) {
    markOracleInitialized(prefix);
    return;
  }
  const maxDt = e.params.max_accrual_dt_slots;
  const maxStep = maxDt > 0xffffffffffffffffn / CATCHUP_CHUNKS_MAX ? 0xffffffffffffffffn : CATCHUP_CHUNKS_MAX * maxDt;
  const gap = clock.slot > e.last_market_slot ? clock.slot - e.last_market_slot : 0n;
  const fundingActive = rate !== 0n && e.oi_eff_long_q !== 0n && e.oi_eff_short_q !== 0n && e.fund_px_last > 0n;
  if (!fundingActive || gap <= maxStep) {
    catchupAccrue(e, clock.slot, rate);
    if (clock.slot > e.last_market_slot) accrueMarketTo(e, clock.slot, fresh, rate);
  } else {
    const stored = e.last_oracle_price;
    const target = e.last_market_slot > 0xffffffffffffffffn - maxStep ? 0xffffffffffffffffn : e.last_market_slot + maxStep;
    catchupAccrue(e, target, rate);
    if (target > e.last_market_slot) accrueMarketTo(e, target, stored, rate);
    prefix.config.last_effective_price_e6 = preEffective;
    prefix.config.last_hyperp_index_slot = preHyperpSlot;
  }
  markOracleInitialized(prefix);
}
