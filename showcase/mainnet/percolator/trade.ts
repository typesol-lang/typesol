// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb, src/percolator.rs `process_instruction`,
// `mod matcher_abi`, `execute_trade_with_matcher`), Copyright Anatoly Yakovenko, licensed under the Apache License,
// Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The trading instructions: TradeNoCpi (6), both owners signing and the fill at the oracle price, and TradeCpi (10),
// the user signing and the LP's matcher program pricing the fill by CPI (signed by the LP PDA ["lp", slab, lp_idx]),
// with the matcher's answer read back from its context account (ABI v2). Each is the original's handler statement for
// statement, with execute_trade_with_matcher's sign convention: a positive size makes the user the buyer.
import {
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type i128,
  type u8,
  type u16,
  type u32,
  type u64,
  type u128,
  ProgramError,
  findProgramAddressWithBump,
  loadRawMut,
  loadRawMutAt,
  readData,
  require,
  u64 as toU64,
  u128 as toU128,
} from "typesol";
import { PercolatorError, check } from "./errors.js";
import { type GenerationTable, type MarketConfig, type RiskBuffer, type RiskBufferHolder, type RiskEngine, ENGINE_OFF, FLAG_CPI_IN_PROGRESS, GEN_TABLE_OFF, RISK_BUF_OFF } from "./state.js";
import { absI128, mulDivFloorU128 } from "./wide.js";
import { type PriceRead, U64_MAX, clampOraclePrice, computeCurrentFundingRateE9, ewmaUpdate, getEngineOraclePriceE6, isHyperpMode, toEnginePrice } from "./oracle.js";
import { MAX_ORACLE_PRICE, POS_SCALE, ZERO_KEY, accrueMarketTo, asI128, effectivePosQ, executeTradeNotAtomic, syncAccountFeeToSlotNotAtomic } from "./engine.js";
import {
  type SlabPrefix,
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
  requireInitialized,
  riskBufferRemove,
  riskBufferUpsert,
  sanitizeRiskBuffer,
  slabGuard,
} from "./program.js";
import { readI128 } from "./wire.js";

/** constants::MATCHER_ABI_VERSION, MATCHER_CONTEXT_LEN, MATCHER_CALL_TAG. */
const MATCHER_ABI_VERSION = 2n;
const MATCHER_CONTEXT_LEN = 320n;
const FLAG_VALID = 1n;
const FLAG_PARTIAL_OK = 2n;
const FLAG_REJECTED = 4n;

/**
 * execute_trade_with_matcher after the matcher answered (`size` is its fill): a positive size makes the user `a`, the
 * buyer; a negative one the LP (i128::MIN has no positive counterpart: Overflow); zero is Overflow.
 */
function executeFill(e: Inout<RiskEngine>, lpIdx: u16, userIdx: u16, nowSlot: u64, oraclePrice: u64, size: i128, execPrice: u64, rate: i128): void {
  let a = userIdx;
  let b = lpIdx;
  let abs = size;
  if (size < 0n) {
    require(size !== -170141183460469231731687303715884105727n - 1n, PercolatorError.EngineOverflow);
    a = lpIdx;
    b = userIdx;
    abs = -size;
  } else require(size !== 0n, PercolatorError.EngineOverflow);
  // maintenance_fee_per_slot is 0 here: both handlers synced the fees before (the helper's own sync is a no-op).
  executeTradeNotAtomic(e, a, b, oraclePrice, nowSlot, abs, execPrice, rate, e.params.h_min, e.params.h_max);
}

/** The fee-weighted mark EWMA after a fill at `fillPrice` (both handlers, the circuit breaker on). */
function updateMarkEwma(config: Inout<MarketConfig>, fillPrice: u64, slot: u64, insBefore: u128, insAfter: u128): void {
  const base = config.last_effective_price_e6 > 1n ? config.last_effective_price_e6 : 1n;
  const clamped = clampOraclePrice(base, fillPrice, config.oracle_price_cap_e2bps);
  const feePaid = feePaidOf(config, insBefore, insAfter);
  const old = config.mark_ewma_e6;
  const ewmaPrice = old === 0n && config.last_effective_price_e6 > 0n ? config.last_effective_price_e6 : clamped;
  config.mark_ewma_e6 = ewmaUpdate(old, ewmaPrice, config.mark_ewma_halflife_slots, config.mark_ewma_last_slot, slot, feePaid, config.mark_min_fee);
  if (config.mark_min_fee === 0n || feePaid >= config.mark_min_fee) config.mark_ewma_last_slot = slot;
}

/** `min(ins_after.saturating_sub(ins_before), u64::MAX)` when mark_min_fee is set, else 0. */
function feePaidOf(config: MarketConfig, insBefore: u128, insAfter: u128): u64 {
  if (config.mark_min_fee === 0n) return 0n;
  const delta = insAfter > insBefore ? insAfter - insBefore : 0n;
  return delta < toU128(U64_MAX) ? toU64(delta) : U64_MAX;
}

/** The risk buffer after a trade: each side upserted at its oracle notional, or removed when flat. */
function updateRiskBuffer(slab: RemainingAccount, userIdx: u16, userEff: i128, lpIdx: u16, lpEff: i128, price: u64): void {
  const holder = loadRawMutAt<RiskBufferHolder>(slab, RISK_BUF_OFF);
  const buf: RiskBuffer = holder.buffer;
  sanitizeRiskBuffer(buf);
  if (userEff === 0n) riskBufferRemove(buf, userIdx);
  else riskBufferUpsert(buf, userIdx, mulDivFloorU128(absI128(userEff), toU128(price), POS_SCALE));
  if (lpEff === 0n) riskBufferRemove(buf, lpIdx);
  else riskBufferUpsert(buf, lpIdx, mulDivFloorU128(absI128(lpEff), toU128(price), POS_SCALE));
  holder.buffer = buf;
}

/** The pre-sync of both counterparties' maintenance fees (before the insurance snapshot of the EWMA weight). */
function presyncFees(e: Inout<RiskEngine>, config: MarketConfig, userIdx: u16, lpIdx: u16, slot: u64): void {
  if (config.maintenance_fee_per_slot > 0n) {
    syncAccountFeeToSlotNotAtomic(e, userIdx, slot, config.maintenance_fee_per_slot);
    syncAccountFeeToSlotNotAtomic(e, lpIdx, slot, config.maintenance_fee_per_slot);
  }
}

// ---- TradeNoCpi (tag 6) ------------------------------------------------------------------------------------------------

/** @noinline */
export function tradeNoCpi(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const lpIdx = data.readU16(1n);
  const userIdx = data.readU16(3n);
  const size = readI128(data, 5n);
  expectLen(rest.length, 5n);
  const aUser = rest.get(0n);
  const aLp = rest.get(1n);
  const aSlab = rest.get(2n);
  expectSigner(aUser);
  expectSigner(aLp);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const clock = readClock(rest.get(3n));
  require(!isHyperpMode(prefix.config), PercolatorError.HyperpTradeNoCpiDisabled);
  const rate = computeCurrentFundingRateE9(prefix.config);
  const read: PriceRead = { price: 0n, publish_time: 0n };
  check(readPriceAndStamp(prefix.config, rest.get(4n), clock.unix_timestamp, clock.slot, read));
  const price = read.price;
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  checkIdx(e, lpIdx);
  checkIdx(e, userIdx);
  require(e.accounts.get(toU64(userIdx)).owner === aUser.key, PercolatorError.EngineUnauthorized);
  require(e.accounts.get(toU64(lpIdx)).owner === aLp.key, PercolatorError.EngineUnauthorized);
  ensureMarketAccruedToNow(e, clock.slot, price, rate);
  presyncFees(e, prefix.config, userIdx, lpIdx, clock.slot);
  const insBefore = e.insurance_balance;
  // NoOpMatcher: the whole size at the oracle price.
  executeFill(e, lpIdx, userIdx, clock.slot, price, size, price, rate);
  if (prefix.config.oracle_price_cap_e2bps > 0n) updateMarkEwma(prefix.config, price, clock.slot, insBefore, e.insurance_balance);
  markOracleInitialized(prefix);
  updateRiskBuffer(aSlab, userIdx, effectivePosQ(e, toU64(userIdx)), lpIdx, effectivePosQ(e, toU64(lpIdx)), price);
}

// ---- TradeCpi (tag 10) -------------------------------------------------------------------------------------------------

/**
 * matcher_abi::validate_matcher_return on the context's first 64 bytes (read_matcher_return), as verify::abi_ok:
 * false for any refusal (the caller fails with InvalidAccountData).
 */
function abiOk(ctx: RemainingAccount, lpAccountId: u64, price: u64, reqSize: i128, reqId: u64): boolean {
  const flags = toU64(readData<u32>(ctx, 4n));
  const execPrice = readData<u64>(ctx, 8n);
  const execSize = asI128(readData<u128>(ctx, 16n));
  if (toU64(readData<u32>(ctx, 0n)) !== MATCHER_ABI_VERSION) return false;
  if ((flags & ~(FLAG_VALID | FLAG_PARTIAL_OK | FLAG_REJECTED) & 0xffffffffn) !== 0n) return false;
  if ((flags & FLAG_VALID) === 0n) return false;
  if ((flags & FLAG_REJECTED) !== 0n) return false;
  if (readData<u64>(ctx, 40n) !== lpAccountId) return false;
  if (readData<u64>(ctx, 48n) !== price) return false;
  if (readData<u64>(ctx, 56n) !== 0n) return false;
  if (readData<u64>(ctx, 32n) !== reqId) return false;
  if (execPrice === 0n) return false;
  if (execSize === 0n) return (flags & FLAG_PARTIAL_OK) !== 0n;
  if (absI128(execSize) > absI128(reqSize)) return false;
  if (reqSize !== 0n && execSize > 0n !== reqSize > 0n) return false;
  return true;
}

/** What TradeCpi carries across the matcher call (the original's locals). */
export interface TradeCpiCall {
  lp_idx: u16;
  bump: u8;
  req_id: u64;
  lp_account_id: u64;
  price: u64;
  size: i128;
  rate_pre: i128;
  slot: u64;
  hyperp: boolean;
  /** The config with this read's oracle state, and the copy from before the read (the zero fill's rollback). */
  config: MarketConfig;
  config_pre_oracle: MarketConfig;
}

/**
 * TradeCpi up to the matcher call: the accounts, the LP PDA, the request nonce, the matcher binding, the price. The
 * call itself is made by the entrypoint (percolator.ts: the tail of remaining accounts is forwarded from there), between
 * this and tradeCpiAfter, with the reentrancy flag set.
 * @noinline
 */
export function tradeCpiBefore(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): TradeCpiCall {
  const lpIdx = data.readU16(1n);
  const userIdx = data.readU16(3n);
  const size = readI128(data, 5n);
  require(rest.length >= 8n, ProgramError.NotEnoughAccountKeys);
  const aUser = rest.get(0n);
  const aLpOwner = rest.get(1n);
  const aSlab = rest.get(2n);
  const aMatcherProg = rest.get(5n);
  const aMatcherCtx = rest.get(6n);
  const aLpPda = rest.get(7n);
  expectSigner(aUser);
  require(size !== 0n, ProgramError.InvalidInstructionData);
  expectWritable(aSlab);
  expectWritable(aMatcherCtx);
  // verify::matcher_shape_ok.
  const shapeOk = aMatcherProg.executable && !aMatcherCtx.executable && aMatcherCtx.owner === aMatcherProg.key && aMatcherCtx.dataLen >= MATCHER_CONTEXT_LEN;
  require(shapeOk, ProgramError.InvalidAccountData);
  const [expectedLpPda, bump] = findProgramAddressWithBump(["lp", aSlab.key, lpIdx], programId);
  require(expectedLpPda === aLpPda.key, ProgramError.InvalidSeeds);

  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  // is_cpi_in_progress: slab_guard has refused it already, with the same error.
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const config: MarketConfig = prefix.config;
  const configPreOracle: MarketConfig = prefix.config;
  const nonce = prefix.header.req_nonce;
  require(nonce !== U64_MAX, PercolatorError.EngineOverflow);
  const reqId = nonce + 1n;
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  checkIdx(e, lpIdx);
  checkIdx(e, userIdx);
  const lp = e.accounts.get(toU64(lpIdx));
  require(lp.matcher_program !== ZERO_KEY, PercolatorError.EngineAccountKindMismatch);
  require(e.accounts.get(toU64(userIdx)).owner === aUser.key, PercolatorError.EngineUnauthorized);
  require(lp.owner === aLpOwner.key, PercolatorError.EngineUnauthorized);
  const gens = loadRawMutAt<GenerationTable>(aSlab, GEN_TABLE_OFF);
  const lpAccountId = gens.generation.get(toU64(lpIdx));
  require(lpAccountId !== 0n, PercolatorError.EngineAccountNotFound);
  require(lp.matcher_program === aMatcherProg.key && lp.matcher_context === aMatcherCtx.key, PercolatorError.EngineInvalidMatchingEngine);

  const clock = readClock(rest.get(3n));
  const ratePre = computeCurrentFundingRateE9(config);
  const hyperp = isHyperpMode(config);
  const read: PriceRead = { price: 0n, publish_time: 0n };
  if (hyperp) check(getEngineOraclePriceE6(clock.slot, clock.unix_timestamp, config, rest.get(4n), read));
  else check(readPriceAndStamp(config, rest.get(4n), clock.unix_timestamp, clock.slot, read));
  // The reentrancy flag before the call (the config is written back only after it, as in the original).
  prefix.header.padding.set(0n, prefix.header.padding.get(0n) | FLAG_CPI_IN_PROGRESS);
  return {
    lp_idx: lpIdx,
    bump,
    req_id: reqId,
    lp_account_id: lpAccountId,
    price: read.price,
    size,
    rate_pre: ratePre,
    slot: clock.slot,
    hyperp,
    config,
    config_pre_oracle: configPreOracle,
  };
}

/** TradeCpi after the matcher call: the flag cleared, the answer checked, the fill (or the zero fill) booked. @noinline */
export function tradeCpiAfter(rest: RemainingAccounts, data: InstructionBytes, t: Inout<TradeCpiCall>): void {
  const lpIdx = t.lp_idx;
  const userIdx = data.readU16(3n);
  const limitPrice = data.readU64(21n);
  const aSlab = rest.get(2n);
  const aMatcherCtx = rest.get(6n);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  prefix.header.padding.set(0n, prefix.header.padding.get(0n) & (0xffn ^ FLAG_CPI_IN_PROGRESS));
  const price = t.price;
  const size = t.size;
  const reqId = t.req_id;
  const slot = t.slot;
  const ratePre = t.rate_pre;
  const config = t.config;

  // read_matcher_return: a context shorter than the 64-byte answer (a matcher may resize it during the call) is
  // InvalidAccountData before any field is read.
  require(aMatcherCtx.dataLen >= 64n, ProgramError.InvalidAccountData);
  require(abiOk(aMatcherCtx, t.lp_account_id, price, size, reqId), ProgramError.InvalidAccountData);
  const execPrice = readData<u64>(aMatcherCtx, 8n);
  const execSize = asI128(readData<u128>(aMatcherCtx, 16n));

  // The user's limit, in engine space (inversion flips the order).
  if (limitPrice !== 0n && execSize !== 0n) {
    const limitEng = toEnginePrice(limitPrice, config.invert, config.unit_scale);
    require(limitEng !== 0n, PercolatorError.OracleInvalid);
    const inverted = config.invert !== 0n;
    let bad = false;
    if (size > 0n) bad = inverted ? execPrice < limitEng : execPrice > limitEng;
    else bad = inverted ? execPrice > limitEng : execPrice < limitEng;
    require(!bad, ProgramError.InvalidAccountData);
  }

  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  if (execSize === 0n) {
    // Zero fill: the engine's clock advances at the pre-read rate; the config goes back to its pre-oracle copy but
    // for the oracle state that advanced.
    catchupAccrue(e, slot, ratePre);
    accrueMarketTo(e, slot, price, ratePre);
    const restored = t.config_pre_oracle;
    restored.last_good_oracle_slot = config.last_good_oracle_slot;
    restored.last_effective_price_e6 = config.last_effective_price_e6;
    restored.last_oracle_publish_time = config.last_oracle_publish_time;
    restored.last_hyperp_index_slot = config.last_hyperp_index_slot;
    prefix.config = restored;
    prefix.header.req_nonce = reqId;
    return;
  }

  require(execPrice <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  // The off-market band: |exec - oracle| · 10_000 <= max(2 · fee_bps, 100) · oracle (no product here can saturate).
  if (execPrice > 0n && price > 0n) {
    const fee2 = e.params.trading_fee_bps > U64_MAX / 2n ? U64_MAX : e.params.trading_fee_bps * 2n;
    const band = fee2 > 100n ? fee2 : 100n;
    const diff = execPrice > price ? execPrice - price : price - execPrice;
    require(toU128(diff) * 10000n <= toU128(band) * toU128(price), PercolatorError.OracleInvalid);
  }
  ensureMarketAccruedToNow(e, slot, price, ratePre);
  presyncFees(e, config, userIdx, lpIdx, slot);
  const insBefore = e.insurance_balance;
  executeFill(e, lpIdx, userIdx, slot, price, execSize, execPrice, ratePre);
  if (config.oracle_price_cap_e2bps > 0n) updateMarkEwma(config, execPrice, slot, insBefore, e.insurance_balance);
  if (t.hyperp) {
    config.hyperp_mark_e6 = clampOraclePrice(config.last_effective_price_e6, execPrice, config.oracle_price_cap_e2bps);
    const feePaid = feePaidOf(config, insBefore, e.insurance_balance);
    if (config.mark_min_fee === 0n || feePaid >= config.mark_min_fee) config.last_mark_push_slot = toU128(slot);
  }
  prefix.header.req_nonce = reqId;
  prefix.config = config;
  markOracleInitialized(prefix);
  updateRiskBuffer(aSlab, userIdx, effectivePosQ(e, toU64(userIdx)), lpIdx, effectivePosQ(e, toU64(lpIdx)), price);
}
