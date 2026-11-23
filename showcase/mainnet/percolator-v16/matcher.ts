// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs (and
// the engine aeyakovenko/percolator src/v16.rs below it), Copyright Anatoly Yakovenko, licensed under the Apache
// License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The matcher ABI v3 and the two instructions that call a matcher: TradeCpi (tag 10, `handle_trade_cpi`) and
// BatchTradeCpi (tag 67, `handle_batch_trade_cpi`). The taker (A) signs; the LP (B) does not: its portfolio's matcher
// config names a matcher program, a context account and the delegate PDA ["matcher", market, B, B's owner, program,
// context] that signs the call, with a live expiry and a fee cap. Before the call both portfolios are accrued and
// proven current (the matcher cannot receive the program's accounts: the tail of accounts forwarded to it may hold
// none of them, no signer and nothing the program owns), and the market's request sequence is advanced; the matcher
// answers in its context account's first 64 bytes (TradeCpi) or in its return data, one 64-byte answer per leg
// (BatchTradeCpi, after the program cleared the return data); each answer must echo the request (`mod matcher_abi`:
// `read_matcher_return`, `validate_matcher_return`, `validate_atomic_batch_matcher_return`). A fill then runs the
// trade of TradeNoCpi (trading.ts `tradeZeroCopy`) or the batch of BatchTradeNoCpi (batch.ts `batchExecute`), with
// the LP's matcher kept enabled after its fill.
//
// The CPI. The original builds the instruction (`invoke_matcher`: 67 bytes, tag 0, the request id, the asset, the LP
// account id, the oracle price, the size, 24 zero bytes; `invoke_matcher_batch`: tag 3, the leg count, the request
// id, the LP account id, then 26 bytes per leg) with the delegate (a read-only signer), the context (writable) and the
// tail with its own flags, and passes the matcher program, the delegate, the context and the tail as account infos;
// the port passes the same accounts (the program's fifth account onwards) and signs with the same seeds.
//
// Copies. Every step before the call borrows and releases the accounts; the answer is read from the context account
// after the call (its length may have changed: an answer shorter than 64 bytes is InvalidAccountData).
import {
  type FixedVec,
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
  type Inout,
  type FixedArray,
  currentSlot,
  findProgramAddressWithBump,
  fixedArray,
  fixedVec,
  getReturnData,
  invokeInstruction,
  loadRawAt,
  loadRawMutAt,
  readData,
  require,
  setReturnData,
  ProgramError,
  i128 as toI128,
  u8 as toU8,
  u16 as toU16,
  u64 as toU64,
  u128 as toU128,
} from "typesol";
import { PercolatorError, V16_OK, checkV16 } from "./errors.js";
import {
  type AssetOracleProfile,
  type AssetOracleWrapper,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type PortfolioMatcherConfig,
  type WrapperConfig,
  HEADER_LEN,
  KIND_MARKET,
  MARKET_GROUP_OFF,
  MATCHER_ABI_VERSION,
  MATCHER_CONTEXT_MIN_LEN,
  MATCHER_ENABLED_MASK,
  MAX_MATCHER_TAIL_ACCOUNTS,
  MIN_MARKET_ACCOUNT_LEN,
  assetOracleProfileOk,
  assetSlotAt,
  checkHeader,
  dynamicSlotOffset,
  marketHeaderAt,
  matcherTradeFeeCapBps,
  portfolioMatcherConfigAt,
  portfolioPreflightChecks,
  readPortfolioId,
  readPortfolioMatcherExpiry,
  readPortfolioMatcherSequence,
  validateMatcherControl,
  validateWrapperConfig,
  wrapperConfigAt,
} from "./state.js";
import { marketModeErr, provenanceHeaderErr } from "./wire.js";
import { LIFECYCLE_ACTIVE, LIFECYCLE_DRAIN_ONLY, LIFECYCLE_RECOVERY, configFullErr, engineSlotAt, marketShapeErr } from "./engine.js";
import { type BatchRequest } from "./trade.js";
import { absH } from "./health.js";
import {
  accrueZeroMoveBeforePositionChange,
  ensureTradePortfolioCurrentFor,
  expectPositionBinding,
  isPriceManaged,
  mulDivByU64,
  portfolioHasActiveAsset,
  signedPositionForAsset,
  tradeZeroCopy,
} from "./trading.js";
import { type BatchLeg, BATCH_LEG_LEN, batchExecute, signedFromBits } from "./batch.js";
import {
  ensurePortfolioStorage,
  keyCheck,
  marketViewMut,
  needAccounts,
  ownerCheck,
  permissionlessStaleMatured,
  portfolioViewMut,
  readAssetOracleProfileState,
  readMarketConfigMode,
  readMarketTradePreflight,
  signerCheck,
  writableCheck,
} from "./program.js";

const U64_MAX_MT: u64 = 0xffffffffffffffffn;
const U128_MAX_MT: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MIN_MT: i128 = -0x80000000000000000000000000000000n;
/** `matcher_abi::MATCHER_RETURN_BYTES` and the flags. */
const MATCHER_RETURN_BYTES = 64n;
const FLAG_VALID = 1n;
const FLAG_PARTIAL_OK = 2n;
const FLAG_REJECTED = 4n;
const FLAG_BACKING_FEE_CAP_SHIFT = 8n;
const FLAG_BACKING_FEE_CAP_MASK = 0x3fff00n;
/** `MATCHER_BATCH_MAX_LEGS` and `MATCHER_BATCH_TAIL_FANOUT_BUDGET`. */
const MATCHER_BATCH_MAX_LEGS = 16n;
const MATCHER_BATCH_TAIL_FANOUT_BUDGET = 64n;
/** The accounts before the tail. */
const TAIL_START = 7n;

/** An account of the matcher instruction (Rust's `AccountMeta`). */
interface MatcherMeta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

/** `MatcherReturn` as `read_matcher_return` reads it, little-endian from 64 bytes. */
interface MatcherReturn {
  abi_version: u64;
  flags: u64;
  exec_price: u64;
  exec_size: i128;
  req_id: u64;
  lp_account_id: u64;
  oracle_price: u64;
  asset: u64;
}

/** What both instructions establish before the call (the original's locals). */
interface MatcherCall {
  owner_b: Pubkey;
  bump: u8;
  lp_account_id: u64;
  lp_fee_cap: u64;
}

// ---- The matcher ABI ------------------------------------------------------------------------------------------------

/** `validate_matcher_return(ret, lp, asset, oracle_price, req_size, req_id)`: every refusal InvalidAccountData. */
function validateMatcherReturn(ret: MatcherReturn, lp: u64, asset: u64, oraclePrice: u64, reqSize: i128, reqId: u64): void {
  require(ret.abi_version === MATCHER_ABI_VERSION, ProgramError.InvalidAccountData);
  const known = FLAG_VALID | FLAG_PARTIAL_OK | FLAG_REJECTED | FLAG_BACKING_FEE_CAP_MASK;
  require(
    !((ret.flags & ~known & 0xffffffffn) !== 0n ||
      (ret.flags & FLAG_VALID) === 0n ||
      (ret.flags & FLAG_REJECTED) !== 0n ||
      returnBackingFeeCap(ret) > 10000n),
    ProgramError.InvalidAccountData,
  );
  require(
    !(ret.lp_account_id !== lp || ret.oracle_price !== oraclePrice || ret.asset !== asset || ret.req_id !== reqId || ret.exec_price === 0n),
    ProgramError.InvalidAccountData,
  );
  if (ret.exec_size === 0n) {
    require(!((ret.flags & FLAG_PARTIAL_OK) === 0n || ret.exec_price !== oraclePrice), ProgramError.InvalidAccountData);
    return;
  }
  require(!(ret.exec_size === I128_MIN_MT || reqSize === I128_MIN_MT || reqSize === 0n), ProgramError.InvalidAccountData);
  require(ret.exec_size > 0n === reqSize > 0n, ProgramError.InvalidAccountData);
  require(absH(ret.exec_size) <= absH(reqSize), ProgramError.InvalidAccountData);
  require(!(absH(ret.exec_size) < absH(reqSize) && (ret.flags & FLAG_PARTIAL_OK) === 0n), ProgramError.InvalidAccountData);
}

/** `MatcherReturn::backing_fee_cap_bps`: the flags' 14 bits from bit 8. */
function returnBackingFeeCap(ret: MatcherReturn): u64 {
  return (ret.flags & FLAG_BACKING_FEE_CAP_MASK) >> FLAG_BACKING_FEE_CAP_SHIFT;
}

/** `read_matcher_return(ctx)` on the context account's first 64 bytes (InvalidAccountData when it is shorter). */
function readContextReturn(ctx: RemainingAccount): MatcherReturn {
  require(ctx.dataLen >= MATCHER_RETURN_BYTES, ProgramError.InvalidAccountData);
  return {
    abi_version: toU64(readData<u32>(ctx, 0n)),
    flags: toU64(readData<u32>(ctx, 4n)),
    exec_price: readData<u64>(ctx, 8n),
    exec_size: signedFromBits(readData<u128>(ctx, 16n)),
    req_id: readData<u64>(ctx, 32n),
    lp_account_id: readData<u64>(ctx, 40n),
    oracle_price: readData<u64>(ctx, 48n),
    asset: readData<u64>(ctx, 56n),
  };
}

/** `read_matcher_return(chunk)` on answer `i` of the return data (64 bytes each, the length checked by the caller). */
function readReplyReturn(reply: InstructionBytes, i: u64): MatcherReturn {
  const at = i * MATCHER_RETURN_BYTES;
  return {
    abi_version: toU64(reply.readU32(at)),
    flags: toU64(reply.readU32(at + 4n)),
    exec_price: reply.readU64(at + 8n),
    exec_size: signedFromBits(reply.readU128(at + 16n)),
    req_id: reply.readU64(at + 32n),
    lp_account_id: reply.readU64(at + 40n),
    oracle_price: reply.readU64(at + 48n),
    asset: reply.readU64(at + 56n),
  };
}

// ---- Before the call --------------------------------------------------------------------------------------------------

/**
 * The account checks both handlers make first: the taker signs; the market, both portfolios and the context writable;
 * the market and both portfolios the program's; the portfolios distinct, the matcher not this program, executable,
 * the context not executable, owned by the matcher and at least 64 bytes long (InvalidInstruction); each portfolio's
 * id and position epoch.
 */
function checkCpiAccounts(rest: RemainingAccounts, programId: Pubkey, aId: u64, aEpoch: u64, bId: u64, bEpoch: u64): void {
  needAccounts(rest, TAIL_START);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  const pb = rest.get(3n);
  const prog = rest.get(4n);
  const ctx = rest.get(5n);
  signerCheck(rest.get(0n));
  writableCheck(m);
  writableCheck(pa);
  writableCheck(pb);
  writableCheck(ctx);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  ownerCheck(pb, programId);
  require(
    !(pa.key === pb.key || prog.key === programId || !prog.executable || ctx.executable || ctx.owner !== prog.key || ctx.dataLen < MATCHER_CONTEXT_MIN_LEN),
    PercolatorError.InvalidInstruction,
  );
  expectPositionBinding(pa, aId, aEpoch);
  expectPositionBinding(pb, bId, bEpoch);
}

/** `oracle_v16::global_or_profile_resolve_matured_at_slot(cfg, profile, slot)`. */
function globalOrProfileMatured(cfg: WrapperConfig, p: AssetOracleProfile, now: u64): boolean {
  if (permissionlessStaleMatured(cfg, now)) return true;
  return (
    isPriceManaged(p) &&
    cfg.permissionless_resolve_stale_slots !== 0n &&
    (now > p.last_good_oracle_slot ? now - p.last_good_oracle_slot : 0n) >= cfg.permissionless_resolve_stale_slots
  );
}

/** `expect_portfolio_id(data, id)` then `read_portfolio_owner_preflight(data)`: the length, the header, the provenance
 * decoded and its owner the portfolio's (InvalidAccountData). */
function portfolioOwnerPreflight(p: RemainingAccount, id: u64): void {
  require(readPortfolioId(p) === id, PercolatorError.EngineProvenanceMismatch);
  portfolioPreflightChecks(p);
  const ph = loadRawAt<Portfolio>(p, HEADER_LEN).provenance_header;
  require(provenanceHeaderErr(ph) === 0n, ProgramError.InvalidAccountData);
  require(loadRawAt<Portfolio>(p, HEADER_LEN).owner === ph.owner, ProgramError.InvalidAccountData);
}

/**
 * After the market's preflight: both portfolios' provenance names their own accounts (EngineProvenanceMismatch), A's
 * owner is the taker (Unauthorized); the delegate is the PDA of B's owner (InvalidArgument); B's matcher sequence
 * (EngineStale), its matcher config (validated) enabled for this program, context and delegate, and its capability
 * unexpired at the Clock (Unauthorized each: `matcher_tail_start_or_verify_lp_config`). Returns B's owner, the bump and
 * the LP's fee cap.
 */
function verifyLp(rest: RemainingAccounts, programId: Pubkey, bSequence: u64): MatcherCall {
  const signerA = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  const pb = rest.get(3n);
  const prog = rest.get(4n);
  const ctx = rest.get(5n);
  const delegate = rest.get(6n);
  const ha = loadRawAt<Portfolio>(pa, HEADER_LEN).provenance_header;
  const hb = loadRawAt<Portfolio>(pb, HEADER_LEN).provenance_header;
  require(!(ha.portfolio_account_id !== pa.key || hb.portfolio_account_id !== pb.key), PercolatorError.EngineProvenanceMismatch);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === signerA.key, PercolatorError.Unauthorized);
  const ownerB = loadRawAt<Portfolio>(pb, HEADER_LEN).owner;
  const [derived, bump] = findProgramAddressWithBump(["matcher", m.key, pb.key, ownerB, prog.key, ctx.key], programId);
  keyCheck(delegate, derived);
  require(readPortfolioMatcherSequence(pb) === bSequence, PercolatorError.EngineStale);
  const mc = loadRawAt<PortfolioMatcherConfig>(pb, portfolioMatcherConfigAt(pb));
  validateMatcherControl(mc.control);
  require(
    (mc.control & MATCHER_ENABLED_MASK) === 1n && mc.matcher_program === prog.key && mc.matcher_context === ctx.key && mc.matcher_delegate === delegate.key,
    PercolatorError.Unauthorized,
  );
  const expiry = readPortfolioMatcherExpiry(pb);
  require(expiry !== 0n && currentSlot() < expiry, PercolatorError.Unauthorized);
  // matcher_lp_account_id: the delegate's first eight bytes, little-endian.
  const bytes: FixedVec<u8, 32> = fixedVec([]);
  bytes.pushKey(derived);
  let lp: u64 = 0n;
  for (let i = 0n; i < 8n; i++) lp |= toU64(bytes.get(i)) << (8n * i);
  return { owner_b: ownerB, bump, lp_account_id: lp, lp_fee_cap: matcherTradeFeeCapBps(mc.control) };
}

/** `validate_matcher_tail`: at most 32 accounts; none a signer, one of the instruction's first seven, this program or
 * an account it owns (InvalidInstruction). */
function validateMatcherTail(rest: RemainingAccounts, programId: Pubkey): void {
  const n = rest.length - TAIL_START;
  require(n <= MAX_MATCHER_TAIL_ACCOUNTS, PercolatorError.InvalidInstruction);
  for (let i = TAIL_START; i < rest.length; i++) {
    const ai = rest.get(i);
    let bad = ai.isSigner || ai.key === programId || ai.owner === programId;
    // signer A, the market, both portfolios, the matcher, its context and the delegate.
    for (let j = 0n; j < TAIL_START && !bad; j++) bad = ai.key === rest.get(j).key;
    require(!bad, PercolatorError.InvalidInstruction);
  }
}

/** `state::bump_matcher_req_seq(market)`: the header, the wrapper config (its range and validation), the sequence
 * advanced (InvalidInstruction at u64::MAX). Returns the request id. */
function bumpMatcherReqSeq(m: RemainingAccount): u64 {
  checkHeader(m, KIND_MARKET);
  const c = loadRawMutAt<WrapperConfig>(m, wrapperConfigAt(m));
  validateWrapperConfig(c);
  require(c.matcher_req_seq !== U64_MAX_MT, PercolatorError.InvalidInstruction);
  c.matcher_req_seq += 1n;
  return c.matcher_req_seq;
}

/**
 * `accrue_zero_move_funding_before_matcher_view(market, A, B, requests)`: both portfolios' storage; the market view;
 * nothing when funding is disabled (`max_abs_funding_e9_per_slot` 0); both portfolio views; for each request, the
 * zero-move funding accrued before the position change (`accrue_zero_move_funding_before_position_change_view`: the
 * profile read from the view and written back validated, either failure InvalidConfig); the market's shape.
 *
 * @noinline
 */
function accrueBeforeMatcher(m: RemainingAccount, pa: RemainingAccount, pb: RemainingAccount, reqs: FixedArray<BatchRequest, 16>, n: u64): void {
  ensurePortfolioStorage(pa);
  ensurePortfolioStorage(pb);
  const markets = marketViewMut(m);
  if (loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_abs_funding_e9_per_slot === 0n) return;
  portfolioViewMut(pa);
  portfolioViewMut(pb);
  for (let i = 0n; i < n; i++) {
    const asset = reqs.get(i).asset;
    const size = reqs.get(i).size;
    const posA = signedPositionForAsset(m, markets, pa, asset);
    const posB = signedPositionForAsset(m, markets, pb, asset);
    const reduces = (posA > 0n && size < 0n) || (posA < 0n && size > 0n) || (posB > 0n && -size < 0n) || (posB < 0n && -size > 0n);
    // read_oracle_profile_from_view (InvalidConfig): the slot in the view, the profile valid.
    require(asset < markets, PercolatorError.EngineInvalidConfig);
    const at = dynamicSlotOffset(asset);
    require(assetOracleProfileOk(loadRawAt<AssetOracleProfile>(m, at)), PercolatorError.EngineInvalidConfig);
    accrueZeroMoveBeforePositionChange(m, markets, at, asset, reduces);
    require(assetOracleProfileOk(loadRawAt<AssetOracleWrapper>(m, at).profile), PercolatorError.EngineInvalidConfig);
  }
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `ensure_cpi_trade_portfolios_current_before_matcher(market, A, B, requests)`: both portfolios' storage; the market
 * view and both portfolio views; each request's asset configured and in the view (InvalidInstruction), Active, or
 * DrainOnly or in Recovery when either portfolio holds it and neither change grows a position (EngineLockActive
 * otherwise); then both portfolios current for the requests.
 *
 * @noinline
 */
function ensureCurrentBeforeMatcher(m: RemainingAccount, pa: RemainingAccount, pb: RemainingAccount, reqs: FixedArray<BatchRequest, 16>, n: u64): void {
  ensurePortfolioStorage(pa);
  ensurePortfolioStorage(pb);
  const markets = marketViewMut(m);
  portfolioViewMut(pa);
  portfolioViewMut(pb);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  for (let i = 0n; i < n; i++) {
    const asset = reqs.get(i).asset;
    const size = reqs.get(i).size;
    require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
    const life = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle;
    if (life === LIFECYCLE_ACTIVE) continue;
    require(life === LIFECYCLE_DRAIN_ONLY || life === LIFECYCLE_RECOVERY, PercolatorError.EngineLockActive);
    const hasA = portfolioHasActiveAsset(m, markets, pa, asset);
    const hasB = portfolioHasActiveAsset(m, markets, pb, asset);
    require(hasA || hasB, PercolatorError.EngineLockActive);
    const posA = signedPositionForAsset(m, markets, pa, asset);
    const posB = signedPositionForAsset(m, markets, pb, asset);
    require(!(mustIncreaseRisk(posA, size) || mustIncreaseRisk(posB, -size)), PercolatorError.EngineLockActive);
  }
  ensureTradePortfolioCurrentFor(m, markets, pa, reqs, n);
  ensureTradePortfolioCurrentFor(m, markets, pb, reqs, n);
}

/** `requested_delta_must_increase_risk(current, delta)`. */
function mustIncreaseRisk(current: i128, delta: i128): boolean {
  return current === 0n || (current > 0n && delta > 0n) || (current < 0n && delta < 0n);
}

/** The matcher instruction's accounts: the delegate (a read-only signer by the seeds), the context (writable), then the
 * tail with the flags it was passed with. */
function matcherMetas(rest: RemainingAccounts, metas: Inout<FixedVec<MatcherMeta, 34>>): void {
  metas.push({ pubkey: rest.get(6n).key, isSigner: true, isWritable: false });
  metas.push({ pubkey: rest.get(5n).key, isSigner: false, isWritable: true });
  for (let i = TAIL_START; i < rest.length; i++) metas.push({ pubkey: rest.get(i).key, isSigner: rest.get(i).isSigner, isWritable: rest.get(i).isWritable });
}

// ---- TradeCpi (tag 10) --------------------------------------------------------------------------------------------------

/**
 * `handle_trade_cpi(a_id, a_epoch, b_id, b_epoch, b_sequence, asset, market_id, size, fee_bps, limit_price,
 * backing_fee_cap_bps)`: accounts signer A, market (w), portfolio A (w), portfolio B (w), the matcher program, its
 * context (w), the delegate, then the tail. The account checks; the market's trade preflight (the asset configured,
 * InvalidInstruction) and its market id (AssetGenerationMismatch); both portfolios' id and owner preflight; a Live
 * market (EngineLockActive); the asset's profile (validated) and the stale windows at the Clock (OracleStale); the
 * signed fee at least the base fee, the larger of the two at most the market's maximum, the backing cap at most
 * 10,000 (InvalidInstruction); the LP; the base fee within the LP's cap (InvalidInstruction); the tail; the size
 * nonzero and not i128::MIN and the asset's price nonzero (InvalidInstruction); the market's config and capacity; the
 * accrual and the currentness before the call; the request id; the call; the answer read from the context and
 * validated; a limit price the fill must not cross (InvalidInstruction); a zero fill ends the instruction; otherwise
 * TradeNoCpi's trade of the fill at the matcher's price, at the base fee, A's backing cap and the matcher's for B, B's
 * matcher kept.
 *
 * @noinline
 */
export function tradeCpi(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const aId = data.readU64(1n);
  const aEpoch = data.readU64(9n);
  const bId = data.readU64(17n);
  const bEpoch = data.readU64(25n);
  const bSequence = data.readU64(33n);
  const asset = toU64(data.readU16(41n));
  const marketId = data.readU64(43n);
  const size = signedFromBits(data.readU128(51n));
  const feeBps = data.readU64(67n);
  const limit = data.readU64(75n);
  const cap = toU64(data.readU16(83n));
  checkCpiAccounts(rest, programId, aId, aEpoch, bId, bEpoch);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  const pb = rest.get(3n);
  const mode = readMarketTradePreflight(m, asset);
  const slot = loadRawAt<EngineAssetSlot>(m, assetSlotAt(m, asset)).asset;
  require(slot.market_id === marketId, PercolatorError.AssetGenerationMismatch);
  const oraclePrice = slot.effective_price;
  portfolioOwnerPreflight(pa, aId);
  portfolioOwnerPreflight(pb, bId);
  require(mode === 0n, PercolatorError.EngineLockActive);
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const profile = loadRawAt<AssetOracleProfile>(m, readAssetOracleProfileState(m, asset));
  require(!globalOrProfileMatured(cfg, profile, currentSlot()), PercolatorError.OracleStale);
  const base = cfg.trade_fee_base_bps;
  require(base <= feeBps, PercolatorError.InvalidInstruction);
  require((feeBps > base ? feeBps : base) <= loadRawAt<GroupHeader>(m, marketHeaderAt(m)).config.max_trading_fee_bps, PercolatorError.InvalidInstruction);
  require(cap <= 10000n, PercolatorError.InvalidInstruction);
  const call = verifyLp(rest, programId, bSequence);
  require(base <= call.lp_fee_cap, PercolatorError.InvalidInstruction);
  validateMatcherTail(rest, programId);
  require(size !== 0n && size !== I128_MIN_MT, PercolatorError.InvalidInstruction);
  require(oraclePrice !== 0n, PercolatorError.InvalidInstruction);
  readMarketConfigMode(m);
  const reqs = fixedArray<BatchRequest, 16>({ asset: 0n, size: 0n, price: 0n, fee_bps: 0n });
  reqs.get(0n).asset = asset;
  reqs.get(0n).size = size;
  accrueBeforeMatcher(m, pa, pb, reqs, 1n);
  ensureCurrentBeforeMatcher(m, pa, pb, reqs, 1n);
  const reqId = bumpMatcherReqSeq(m);
  invokeSingle(rest, call, reqId, asset, oraclePrice, size);
  const ret = readContextReturn(rest.get(5n));
  validateMatcherReturn(ret, call.lp_account_id, asset, oraclePrice, size, reqId);
  if (limit !== 0n) require(size > 0n ? ret.exec_price <= limit : ret.exec_price >= limit, PercolatorError.InvalidInstruction);
  if (ret.exec_size === 0n) return;
  readMarketConfigMode(m);
  tradeZeroCopy(
    rest.get(0n).key,
    call.owner_b,
    m,
    pa,
    pb,
    aId,
    aEpoch,
    bId,
    bEpoch,
    asset,
    marketId,
    ret.exec_size,
    ret.exec_price,
    base,
    cap,
    returnBackingFeeCap(ret),
    true,
  );
}

/** `invoke_matcher`: the 67-byte request (tag 0, request id, asset u16, LP account id, oracle price, size, 24 zero
 * bytes) to the matcher, signed by the delegate's seeds. @noinline */
function invokeSingle(rest: RemainingAccounts, call: MatcherCall, reqId: u64, asset: u64, oraclePrice: u64, size: i128): void {
  const metas: FixedVec<MatcherMeta, 34> = fixedVec([]);
  matcherMetas(rest, metas);
  const ix: FixedVec<u8, 67> = fixedVec([0n]);
  ix.pushLE<u64>(reqId);
  ix.pushLE<u16>(toU16(asset));
  ix.pushLE<u64>(call.lp_account_id);
  ix.pushLE<u64>(oraclePrice);
  ix.pushLE<i128>(size);
  for (let i = 0n; i < 24n; i++) ix.push(0n);
  invokeInstruction(rest.get(4n).key, metas, ix, rest.slice(4n), [
    "matcher",
    rest.get(1n).key,
    rest.get(3n).key,
    call.owner_b,
    rest.get(4n).key,
    rest.get(5n).key,
    call.bump,
  ]);
}

// ---- BatchTradeCpi (tag 67) ---------------------------------------------------------------------------------------------

/**
 * `handle_batch_trade_cpi(a_id, a_epoch, b_id, b_epoch, b_sequence, max_slippage, max_fee, legs)`: no leg or more than
 * 16 (InvalidInstruction), before any account; the account checks; every leg's size nonzero and not i128::MIN
 * (InvalidInstruction); the market read once for the legs (`read_asset_effective_prices`: the legs distinct and
 * configured, each asset's market id and price); each leg's market id (AssetGenerationMismatch); each leg's profile
 * and the stale windows at the Clock, up to the first that has matured; then a Live market (EngineLockActive), no
 * matured window (OracleStale), no backing-fee policy and every leg's fee within the market's maximum
 * (InvalidInstruction); both portfolios' owner preflight; the LP; the base fee within the LP's cap; the tail, and the
 * legs times the tail within 64 (InvalidInstruction); the request id; each leg's price nonzero; the accrual and the
 * currentness before the call; the return data cleared; the call; the answers (`batchAnswers`); then the batch of
 * the fills at the base fee, B's matcher kept, A's fee within `max_fee`.
 *
 * @noinline
 */
export function batchTradeCpi(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const n = toU64(data.readU8(1n));
  require(n !== 0n && n <= MATCHER_BATCH_MAX_LEGS, PercolatorError.InvalidInstruction);
  const tail = 2n + n * BATCH_LEG_LEN;
  const aId = data.readU64(tail);
  const aEpoch = data.readU64(tail + 8n);
  const bId = data.readU64(tail + 16n);
  const bEpoch = data.readU64(tail + 24n);
  const bSequence = data.readU64(tail + 32n);
  const maxSlippage = data.readU128(tail + 40n);
  const maxFee = data.readU128(tail + 56n);
  checkCpiAccounts(rest, programId, aId, aEpoch, bId, bEpoch);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  const pb = rest.get(3n);
  const reqs = fixedArray<BatchRequest, 16>({ asset: 0n, size: 0n, price: 0n, fee_bps: 0n });
  const legs = fixedArray<BatchLeg, 16>({ market_id: 0n, post_trade_mark: 0n, writes: false, base_fee_paid: 0n, externality: 0n, pos_a: 0n, pos_b: 0n });
  for (let i = 0n; i < n; i++) {
    const at = 2n + i * BATCH_LEG_LEN;
    const size = signedFromBits(data.readU128(at + 10n));
    require(size !== 0n && size !== I128_MIN_MT, PercolatorError.InvalidInstruction);
    reqs.get(i).asset = toU64(data.readU16(at));
    reqs.get(i).size = size;
  }
  // read_asset_effective_prices: the prices go to `legs[i].pos_a` until the fills replace them (a leg's oracle price
  // is the asset's effective price, at most MAX_ORACLE_PRICE).
  const mode = readAssetEffectivePrices(m, reqs, legs, n);
  for (let i = 0n; i < n; i++) require(data.readU64(2n + i * BATCH_LEG_LEN + 2n) === legs.get(i).market_id, PercolatorError.AssetGenerationMismatch);
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const now = currentSlot();
  let stale = false;
  for (let i = 0n; i < n && !stale; i++)
    stale = globalOrProfileMatured(cfg, loadRawAt<AssetOracleProfile>(m, readAssetOracleProfileState(m, reqs.get(i).asset)), now);
  const base = cfg.trade_fee_base_bps;
  const maxBps = loadRawAt<GroupHeader>(m, marketHeaderAt(m)).config.max_trading_fee_bps;
  let feesOk = true;
  for (let i = 0n; i < n; i++) {
    const fee = data.readU64(2n + i * BATCH_LEG_LEN + 26n);
    if ((fee > base ? fee : base) > maxBps) feesOk = false;
  }
  require(mode === 0n, PercolatorError.EngineLockActive);
  require(!stale, PercolatorError.OracleStale);
  require(cfg.backing_trade_fee_policy_count === 0n, PercolatorError.InvalidInstruction);
  require(feesOk, PercolatorError.InvalidInstruction);
  portfolioOwnerPreflight(pa, aId);
  portfolioOwnerPreflight(pb, bId);
  const call = verifyLp(rest, programId, bSequence);
  require(base <= call.lp_fee_cap, PercolatorError.InvalidInstruction);
  validateMatcherTail(rest, programId);
  require(n * (rest.length - TAIL_START) <= MATCHER_BATCH_TAIL_FANOUT_BUDGET, PercolatorError.InvalidInstruction);
  const reqId = bumpMatcherReqSeq(m);
  for (let i = 0n; i < n; i++) require(legs.get(i).pos_a !== 0n, PercolatorError.InvalidInstruction);
  accrueBeforeMatcher(m, pa, pb, reqs, n);
  ensureCurrentBeforeMatcher(m, pa, pb, reqs, n);
  setReturnData(data.slice(0n, 0n));
  invokeBatch(rest, call, reqId, reqs, legs, n);
  batchAnswers(rest, data, call, reqId, reqs, legs, n, maxSlippage, base);
  batchExecute(rest.get(0n).key, call.owner_b, m, pa, pb, aId, aEpoch, bId, bEpoch, reqs, legs, n, true, true, maxFee);
}

/**
 * `state::read_asset_effective_prices(market, assets)`: the minimum length, the header, the wrapper config
 * (validated), the engine config (InvalidAccountData); no asset or more than the portfolio cap (InvalidInstruction);
 * per asset, in order: a repeat refused, the asset configured (InvalidInstruction), its slot within the data
 * (InvalidAccountLen), its market id and effective price (into `legs`); the mode (InvalidAccountData). Returns the
 * mode.
 *
 * @noinline
 */
function readAssetEffectivePrices(m: RemainingAccount, reqs: FixedArray<BatchRequest, 16>, legs: Inout<FixedArray<BatchLeg, 16>>, n: u64): u8 {
  require(m.dataLen >= MIN_MARKET_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  checkHeader(m, KIND_MARKET);
  validateWrapperConfig(loadRawAt<WrapperConfig>(m, wrapperConfigAt(m)));
  const h = loadRawAt<GroupHeader>(m, marketHeaderAt(m));
  require(configFullErr(h.config) === V16_OK, ProgramError.InvalidAccountData);
  require(!(n === 0n || n > toU64(h.config.max_portfolio_assets)), PercolatorError.InvalidInstruction);
  for (let i = 0n; i < n; i++) {
    const asset = reqs.get(i).asset;
    // The seen-asset set (a bit per asset below 128, a list of at most 16 above): any repeat.
    for (let j = 0n; j < i; j++) require(reqs.get(j).asset !== asset, PercolatorError.InvalidInstruction);
    require(asset < toU64(h.config.max_market_slots), PercolatorError.InvalidInstruction);
    const slot = loadRawAt<EngineAssetSlot>(m, assetSlotAt(m, asset)).asset;
    legs.get(i).market_id = slot.market_id;
    legs.get(i).pos_a = toI128(toU128(slot.effective_price));
  }
  require(marketModeErr(h.mode) === V16_OK, ProgramError.InvalidAccountData);
  return h.mode;
}

/** `invoke_matcher_batch`: tag 3, the leg count, the request id, the LP account id, then per leg the asset u16, its
 * oracle price and the signed size, to the matcher, signed by the delegate's seeds. @noinline */
function invokeBatch(rest: RemainingAccounts, call: MatcherCall, reqId: u64, reqs: FixedArray<BatchRequest, 16>, legs: FixedArray<BatchLeg, 16>, n: u64): void {
  const metas: FixedVec<MatcherMeta, 34> = fixedVec([]);
  matcherMetas(rest, metas);
  const ix: FixedVec<u8, 434> = fixedVec([3n]);
  ix.push(toU8(n));
  ix.pushLE<u64>(reqId);
  ix.pushLE<u64>(call.lp_account_id);
  for (let i = 0n; i < n; i++) {
    ix.pushLE<u16>(toU16(reqs.get(i).asset));
    ix.pushLE<u64>(toU64(toU128(legs.get(i).pos_a)));
    ix.pushLE<i128>(reqs.get(i).size);
  }
  invokeInstruction(rest.get(4n).key, metas, ix, rest.slice(4n), [
    "matcher",
    rest.get(1n).key,
    rest.get(3n).key,
    call.owner_b,
    rest.get(4n).key,
    rest.get(5n).key,
    call.bump,
  ]);
}

/**
 * The batch's answers: the return data present, from the matcher and exactly 64 bytes per leg (InvalidInstruction);
 * per leg in order, the answer read and validated for an atomic batch (the fill exactly the request:
 * InvalidAccountData), a limit price the fill must not cross (InvalidInstruction), its adverse slippage against the
 * oracle price (EngineArithmeticOverflow) added to the total within `max_slippage` (InvalidInstruction); the request
 * becomes the fill (its size, the matcher's price, the base fee).
 *
 * @noinline
 */
function batchAnswers(
  rest: RemainingAccounts,
  data: InstructionBytes,
  call: MatcherCall,
  reqId: u64,
  reqs: Inout<FixedArray<BatchRequest, 16>>,
  legs: FixedArray<BatchLeg, 16>,
  n: u64,
  maxSlippage: u128,
  base: u64,
): void {
  const [from, reply] = getReturnData();
  require(reply.length !== 0n, PercolatorError.InvalidInstruction);
  require(!(from !== rest.get(4n).key || reply.length !== n * MATCHER_RETURN_BYTES), PercolatorError.InvalidInstruction);
  let slippage: u128 = 0n;
  for (let i = 0n; i < n; i++) {
    const r = reqs.get(i);
    const oracle = toU64(toU128(legs.get(i).pos_a));
    const ret = readReplyReturn(reply, i);
    validateMatcherReturn(ret, call.lp_account_id, r.asset, oracle, r.size, reqId);
    require(ret.exec_size === r.size, ProgramError.InvalidAccountData);
    const limit = data.readU64(2n + i * BATCH_LEG_LEN + 34n);
    if (limit !== 0n) require(r.size > 0n ? ret.exec_price <= limit : ret.exec_price >= limit, PercolatorError.InvalidInstruction);
    // adverse_trade_slippage_atoms: the price moved against the taker, times the size (risk_notional_ceil).
    let delta: u64 = 0n;
    if (ret.exec_size > 0n) delta = ret.exec_price > oracle ? ret.exec_price - oracle : 0n;
    else delta = oracle > ret.exec_price ? oracle - ret.exec_price : 0n;
    const leg = mulDivByU64(absH(ret.exec_size), delta, 1000000n, true);
    require(slippage <= U128_MAX_MT - leg && slippage + leg <= maxSlippage, PercolatorError.InvalidInstruction);
    slippage += leg;
    r.size = ret.exec_size;
    r.price = ret.exec_price;
    r.fee_bps = base;
  }
  // The positions the pre-pass records replace the oracle prices kept here.
}
