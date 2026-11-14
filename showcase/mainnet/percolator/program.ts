// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb, src/percolator.rs `mod processor` helpers,
// `mod state`, `mod units`, `mod collateral`, `mod accounts`, `mod risk_buffer`), Copyright Anatoly Yakovenko,
// licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in
// TypeSOL.
//
// What every instruction shares: the slab checks (slab_guard, require_initialized, the enum-tag validation the
// original makes before each cast to &RiskEngine), the SPL Token checks (verify_vault, verify_token_account,
// verify_token_program, with spl-token's own `unpack` errors), the Clock read from its account, the market-clock
// helpers (catchup_accrue, ensure_market_accrued_to_now, the fee syncs), the oracle read that stamps liveness, and
// the collateral transfers.
//
// The original reads the header and the config as copies (`read_header` / `read_config`), changes them, and writes
// them back (`write_header` / `write_config`) at chosen points; the port does the same with local copies and
// `prefix.config = config`, so a value read after a write-back sees what the original sees. Where nothing reads the
// config between the copy and its write-back and a failure changes nothing before it fails (WithdrawCollateral,
// CloseAccount, SettleAccount, ConvertReleasedPnl, TradeNoCpi, UpdateConfig, KeeperCrank, LiquidateAtOracle,
// CatchupAccrue), the port changes it in place instead:
// the same bytes, without two 400-byte copies (a loop of word moves in TypeSOL, one memcpy in Rust). TradeCpi keeps the
// copy: the matcher it calls could read the slab before the write-back.
import {
  type Inout,
  type Pubkey,
  type RemainingAccount,
  type TokenProgram,
  type i64,
  type i128,
  type u8,
  type u16,
  type u32,
  type u64,
  type u128,
  ProgramError,
  createProgramAddress,
  log64,
  pubkey,
  readData,
  require,
  u64 as toU64,
  u128 as toU128,
} from "typesol";
import { PercolatorError, OK, custom, E_ORACLE_STALE } from "./errors.js";
import { type MarketConfig, type RiskBuffer, type RiskEngine, type SlabHeader, CONFIG_LEN, ENGINE_MAX_ACCOUNTS, FLAG_CPI_IN_PROGRESS, FLAG_ORACLE_INITIALIZED, HEADER_LEN, MAGIC, RISK_BUF_CAP, SLAB_LEN } from "./state.js";
import { type PriceRead, clampExternalPrice, permissionlessStaleMatured, readEnginePriceE6 } from "./oracle.js";
import { ZERO_KEY, accrueMarketTo, isUsed, syncAccountFeeToSlotNotAtomic } from "./engine.js";

export const TOKEN_PROGRAM_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const CLOCK_SYSVAR_ID = pubkey("SysvarC1ock11111111111111111111111111111111");
export const TOKEN_ACCOUNT_LEN = 165n;
export const MINT_LEN = 82n;

/** The slab's first two parts, read as copies and written back whole (read_header / write_header, …_config). */
export interface SlabPrefix {
  header: SlabHeader;
  config: MarketConfig;
}

/** catchup_accrue's chunk budget per instruction. */
export const CATCHUP_CHUNKS_MAX = 20n;

// ---- Slab checks ------------------------------------------------------------------------------------------------------

/** slab_guard: owned by this program and SLAB_LEN long (else the length is logged), and no TradeCpi in progress. */
export function slabGuard(slab: RemainingAccount, programId: Pubkey): void {
  const owned = slab.owner === programId;
  const lenOk = slab.dataLen === SLAB_LEN;
  if (!(owned && lenOk)) {
    require(owned, ProgramError.IllegalOwner);
    log64(SLAB_LEN, slab.dataLen, 0n, 0n, 0n);
    require(false, PercolatorError.InvalidSlabLen);
  }
  require((readData<u8>(slab, 13n) & FLAG_CPI_IN_PROGRESS) === 0n, ProgramError.InvalidAccountData);
}

/** require_initialized: the header's magic. */
export function requireInitialized(slab: RemainingAccount): void {
  require(readData<u64>(slab, 0n) === MAGIC, PercolatorError.NotInitialized);
}

/**
 * zc::engine_ref / engine_mut's check before the cast: the two SideMode bytes at most 2 and the MarketMode byte at
 * most 1 (ProgramError::InvalidAccountData). The length and alignment checks before it always pass after slab_guard.
 */
export function validateEngine(slab: RemainingAccount): void {
  const base = HEADER_LEN + CONFIG_LEN;
  const smLong = readData<u8>(slab, base + 520n);
  const smShort = readData<u8>(slab, base + 521n);
  require(smLong <= 2n && smShort <= 2n, ProgramError.InvalidAccountData);
  require(readData<u8>(slab, base + 208n) <= 1n, ProgramError.InvalidAccountData);
}

/** `zc::engine_ref(&data)?.is_resolved()`. */
export function engineIsResolved(slab: RemainingAccount): boolean {
  validateEngine(slab);
  return readData<u8>(slab, HEADER_LEN + CONFIG_LEN + 208n) === 1n;
}

export function readFlags(slab: RemainingAccount): u8 {
  return readData<u8>(slab, 13n);
}

/** `if !is_oracle_initialized { set_oracle_initialized }`. */
export function markOracleInitialized(prefix: Inout<SlabPrefix>): void {
  const f = prefix.header.padding.get(0n);
  if ((f & FLAG_ORACLE_INITIALIZED) === 0n) prefix.header.padding.set(0n, f | FLAG_ORACLE_INITIALIZED);
}

/** require_admin: the stored key nonzero (not burned) and the signer's. */
export function requireAdmin(stored: Pubkey, signer: Pubkey): void {
  require(stored !== ZERO_KEY && stored === signer, PercolatorError.EngineUnauthorized);
}

/** check_idx: below MAX_ACCOUNTS and in use. */
export function checkIdx(e: RiskEngine, idx: u16): void {
  if (toU64(idx) >= ENGINE_MAX_ACCOUNTS || !isUsed(e, toU64(idx))) require(false, PercolatorError.EngineAccountNotFound);
}

// ---- Accounts ---------------------------------------------------------------------------------------------------------

export function expectSigner(a: RemainingAccount): void {
  require(a.isSigner, PercolatorError.ExpectedSigner);
}

export function expectWritable(a: RemainingAccount): void {
  require(a.isWritable, PercolatorError.ExpectedWritable);
}

export function expectLen(n: u64, want: u64): void {
  require(n === want, ProgramError.NotEnoughAccountKeys);
}

/** accounts::expect_key: InvalidArgument for another key. */
export function expectKey(a: RemainingAccount, key: Pubkey): void {
  require(a.key === key, ProgramError.InvalidArgument);
}

/** derive_vault_authority_with_bump: create_program_address(["vault", slab, bump]), InvalidSeeds when it is no PDA. */
export function vaultAuthority(slab: Pubkey, bump: u8, programId: Pubkey): Pubkey {
  const a = createProgramAddress(["vault", slab, bump], programId);
  require(a !== null, ProgramError.InvalidSeeds);
  return a!;
}

/** Clock::from_account_info: the Clock sysvar's key (InvalidArgument otherwise), then its slot and timestamp. */
export interface ClockRead {
  slot: u64;
  unix_timestamp: i64;
}

export function readClock(a: RemainingAccount): ClockRead {
  require(a.key === CLOCK_SYSVAR_ID, ProgramError.InvalidArgument);
  require(a.dataLen >= 40n, ProgramError.InvalidArgument);
  return { slot: readData<u64>(a, 0n), unix_timestamp: readData<i64>(a, 32n) };
}

/** verify_token_program: SPL Token's key, and executable. */
export function verifyTokenProgram(a: RemainingAccount): void {
  require(a.key === TOKEN_PROGRAM_ID, PercolatorError.InvalidTokenProgram);
  require(a.executable, PercolatorError.InvalidTokenProgram);
}

/** spl_token's COption tag: [0,0,0,0] None, [1,0,0,0] Some, anything else InvalidAccountData. */
function coptionTag(a: RemainingAccount, at: u64): u32 {
  const t = readData<u32>(a, at);
  require(t <= 1n, ProgramError.InvalidAccountData);
  return t;
}

/**
 * spl_token::state::Account::unpack of a 165-byte account (the callers check the length): the COption tags and the
 * state byte (InvalidAccountData), then initialized (UninitializedAccount). Returns the state byte.
 */
export function unpackTokenAccount(a: RemainingAccount): u8 {
  coptionTag(a, 72n);
  const state = readData<u8>(a, 108n);
  require(state <= 2n, ProgramError.InvalidAccountData);
  coptionTag(a, 109n);
  coptionTag(a, 129n);
  require(state !== 0n, ProgramError.UninitializedAccount);
  return state;
}

/** verify_vault (and verify_vault_empty with `empty`). */
export function verifyVault(vault: RemainingAccount, owner: Pubkey, mint: Pubkey, expected: Pubkey, empty: boolean): void {
  require(vault.key === expected, PercolatorError.InvalidVaultAta);
  require(vault.owner === TOKEN_PROGRAM_ID, PercolatorError.InvalidVaultAta);
  require(vault.dataLen === TOKEN_ACCOUNT_LEN, PercolatorError.InvalidVaultAta);
  const state = unpackTokenAccount(vault);
  require(readData<Pubkey>(vault, 0n) === mint, PercolatorError.InvalidMint);
  require(readData<Pubkey>(vault, 32n) === owner, PercolatorError.InvalidVaultAta);
  require(state === 1n, PercolatorError.InvalidVaultAta);
  require(readData<u32>(vault, 72n) === 0n && readData<u32>(vault, 129n) === 0n, PercolatorError.InvalidVaultAta);
  if (empty) require(readData<u64>(vault, 64n) === 0n, ProgramError.InvalidAccountData);
}

/** verify_token_account: SPL Token's, 165 bytes, the mint, the owner, initialized (not frozen). */
export function verifyTokenAccount(ta: RemainingAccount, owner: Pubkey, mint: Pubkey): void {
  require(ta.owner === TOKEN_PROGRAM_ID, PercolatorError.InvalidTokenAccount);
  require(ta.dataLen === TOKEN_ACCOUNT_LEN, PercolatorError.InvalidTokenAccount);
  const state = unpackTokenAccount(ta);
  require(readData<Pubkey>(ta, 0n) === mint, PercolatorError.InvalidMint);
  require(readData<Pubkey>(ta, 32n) === owner, PercolatorError.InvalidTokenAccount);
  require(state === 1n, PercolatorError.InvalidTokenAccount);
}

/** Mint::unpack of an 82-byte mint: the COption tags, is_initialized 0 or 1, then initialized. */
export function unpackMint(m: RemainingAccount): void {
  coptionTag(m, 0n);
  const init = readData<u8>(m, 45n);
  require(init <= 1n, ProgramError.InvalidAccountData);
  coptionTag(m, 46n);
  require(init === 1n, ProgramError.UninitializedAccount);
}

// ---- Units (mod units) -------------------------------------------------------------------------------------------------

export function baseToUnits(base: u64, scale: u32): u64 {
  return scale === 0n ? base : base / toU64(scale);
}

export function baseDust(base: u64, scale: u32): u64 {
  return scale === 0n ? 0n : base % toU64(scale);
}

/** units_to_base_checked (EngineOverflow for None, as the callers map it). */
export function unitsToBase(units: u64, scale: u32): u64 {
  if (scale === 0n) return units;
  require(units <= 0xffffffffffffffffn / toU64(scale), PercolatorError.EngineOverflow);
  return units * toU64(scale);
}

// ---- Collateral (mod collateral) ---------------------------------------------------------------------------------------

/** collateral::deposit: an SPL Token Transfer signed by the user, none for 0. */
export function depositCollateral(token: TokenProgram, source: RemainingAccount, dest: RemainingAccount, authority: RemainingAccount, amount: u64): void {
  if (amount === 0n) return;
  token.transfer(source, dest, authority, amount);
}

/** collateral::withdraw: a Transfer from the vault signed by the vault PDA ["vault", slab, bump]. */
export function withdrawCollateral(token: TokenProgram, vault: RemainingAccount, dest: RemainingAccount, authority: RemainingAccount, amount: u64, slab: Pubkey, bump: u8): void {
  if (amount === 0n) return;
  token.transfer(vault, dest, authority, amount, ["vault", slab, bump]);
}

// ---- Market clock (processor helpers) ----------------------------------------------------------------------------------

/** sync_account_fee: realize maintenance fees up to now_slot (no-op without a fee). */
export function syncAccountFee(e: Inout<RiskEngine>, feePerSlot: u128, idx: u16, nowSlot: u64): void {
  if (feePerSlot === 0n) return;
  syncAccountFeeToSlotNotAtomic(e, idx, nowSlot, feePerSlot);
}

/** sync_account_fee_bounded_to_market: the anchor max(min(clock, last_market_slot), current_slot). */
export function syncAccountFeeBoundedToMarket(e: Inout<RiskEngine>, feePerSlot: u128, idx: u16, wallclockSlot: u64): void {
  if (feePerSlot === 0n) return;
  syncAccountFeeToSlotNotAtomic(e, idx, boundedNow(e, wallclockSlot), feePerSlot);
}

/** max(min(clock.slot, last_market_slot), current_slot): the no-oracle paths' anchor. */
export function boundedNow(e: RiskEngine, clockSlot: u64): u64 {
  const m = clockSlot < e.last_market_slot ? clockSlot : e.last_market_slot;
  return m > e.current_slot ? m : e.current_slot;
}

/**
 * catchup_accrue: when funding is active and the gap since last_market_slot exceeds max_accrual_dt_slots, accrue in
 * steps of that size at the stored price (at most CATCHUP_CHUNKS_MAX; more is CatchupRequired).
 */
export function catchupAccrue(e: Inout<RiskEngine>, nowSlot: u64, fundingRateE9: i128): void {
  const maxDt = e.params.max_accrual_dt_slots;
  if (maxDt === 0n) return;
  if (nowSlot <= e.last_market_slot) return;
  if (e.last_oracle_price === 0n) return;
  const active = fundingRateE9 !== 0n && e.oi_eff_long_q !== 0n && e.oi_eff_short_q !== 0n && e.fund_px_last > 0n;
  if (!active) return;
  const chunkPrice = e.last_oracle_price;
  let chunks = 0n;
  while ((nowSlot > e.last_market_slot ? nowSlot - e.last_market_slot : 0n) > maxDt) {
    require(chunks < CATCHUP_CHUNKS_MAX, PercolatorError.CatchupRequired);
    const step = e.last_market_slot > 0xffffffffffffffffn - maxDt ? 0xffffffffffffffffn : e.last_market_slot + maxDt;
    accrueMarketTo(e, step, chunkPrice, fundingRateE9);
    chunks += 1n;
  }
}

/** ensure_market_accrued_to_now: catch up, then accrue the rest at the fresh price. */
export function ensureMarketAccruedToNow(e: Inout<RiskEngine>, nowSlot: u64, price: u64, fundingRateE9: i128): void {
  catchupAccrue(e, nowSlot, fundingRateE9);
  if (price > 0n && nowSlot > e.last_market_slot) accrueMarketTo(e, nowSlot, price, fundingRateE9);
}

/**
 * read_price_and_stamp: the hard-timeout gate, the external read, the clamp, and `last_good_oracle_slot` stamped
 * only when this read advanced the publish time. Returns an Outcome; the price is in `out.price`.
 */
export function readPriceAndStamp(config: Inout<MarketConfig>, oracle: RemainingAccount, nowTs: i64, clockSlot: u64, out: Inout<PriceRead>): u64 {
  if (permissionlessStaleMatured(config, clockSlot)) return custom(E_ORACLE_STALE);
  const r = readEnginePriceE6(oracle, config.index_feed_id, nowTs, config.max_staleness_secs, config.conf_filter_bps, config.invert, config.unit_scale, out);
  const prev = config.last_oracle_publish_time;
  if (r !== OK) return r;
  out.price = clampExternalPrice(config, out.price, out.publish_time);
  if (config.last_oracle_publish_time > prev) config.last_good_oracle_slot = clockSlot;
  return OK;
}

// ---- Risk buffer (mod risk_buffer, state::read_risk_buffer) ------------------------------------------------------------

export function recomputeMin(b: Inout<RiskBuffer>): void {
  const c = toU64(b.count);
  if (c === 0n) b.min_notional = 0n;
  else if (c === 1n) b.min_notional = b.entries.get(0n).notional;
  else if (c === 2n) b.min_notional = minU128(b.entries.get(0n).notional, b.entries.get(1n).notional);
  else if (c === 3n) b.min_notional = minU128(b.entries.get(0n).notional, minU128(b.entries.get(1n).notional, b.entries.get(2n).notional));
  else b.min_notional = minU128(minU128(b.entries.get(0n).notional, b.entries.get(1n).notional), minU128(b.entries.get(2n).notional, b.entries.get(3n).notional));
}

function minU128(a: u128, b: u128): u128 {
  return a < b ? a : b;
}

export function riskBufferFind(b: RiskBuffer, idx: u16): u64 {
  if (b.count > 0n && b.entries.get(0n).idx === idx) return 0n;
  if (b.count > 1n && b.entries.get(1n).idx === idx) return 1n;
  if (b.count > 2n && b.entries.get(2n).idx === idx) return 2n;
  if (b.count > 3n && b.entries.get(3n).idx === idx) return 3n;
  return 4n;
}

/** RiskBuffer::remove: swap-remove with the last entry, the last zeroed. */
export function riskBufferRemove(b: Inout<RiskBuffer>, idx: u16): boolean {
  const slot = riskBufferFind(b, idx);
  if (slot === 4n) return false;
  const last = toU64(b.count) - 1n;
  if (slot !== last) b.entries.set(slot, b.entries.get(last));
  const z = b.entries.get(last);
  z.idx = 0n;
  for (let i = 0n; i < 14n; i++) z.pad.set(i, 0n);
  z.notional = 0n;
  b.count -= 1n;
  recomputeMin(b);
  return true;
}

/** read_risk_buffer's sanitization of the copy it reads. */
export function sanitizeRiskBuffer(b: Inout<RiskBuffer>): void {
  if (b.count > RISK_BUF_CAP) b.count = RISK_BUF_CAP;
  for (let i = toU64(b.count); i < RISK_BUF_CAP; i++) {
    const z = b.entries.get(i);
    z.idx = 0n;
    for (let k = 0n; k < 14n; k++) z.pad.set(k, 0n);
    z.notional = 0n;
  }
  let i = toU64(b.count);
  while (i > 0n) {
    i -= 1n;
    const id = b.entries.get(i).idx;
    if (toU64(id) >= ENGINE_MAX_ACCOUNTS) riskBufferRemove(b, id);
  }
  recomputeMin(b);
  if (toU64(b.scan_cursor) >= ENGINE_MAX_ACCOUNTS) b.scan_cursor = 0n;
}

function minSlot(b: RiskBuffer): u64 {
  let m = 0n;
  if (b.count > 1n && b.entries.get(1n).notional < b.entries.get(m).notional) m = 1n;
  if (b.count > 2n && b.entries.get(2n).notional < b.entries.get(m).notional) m = 2n;
  if (b.count > 3n && b.entries.get(3n).notional < b.entries.get(m).notional) m = 3n;
  return m;
}

/** RiskBuffer::upsert: update in place, append below the cap, or replace the smallest when larger than it. */
export function riskBufferUpsert(b: Inout<RiskBuffer>, idx: u16, notional: u128): boolean {
  const slot = riskBufferFind(b, idx);
  if (slot !== 4n) {
    if (b.entries.get(slot).notional === notional) return false;
    b.entries.get(slot).notional = notional;
    recomputeMin(b);
    return true;
  }
  if (toU64(b.count) < RISK_BUF_CAP) {
    const e = b.entries.get(toU64(b.count));
    e.idx = idx;
    e.notional = notional;
    for (let i = 0n; i < 14n; i++) e.pad.set(i, 0n);
    b.count += 1n;
    recomputeMin(b);
    return true;
  }
  if (notional <= b.min_notional) return false;
  const v = b.entries.get(minSlot(b));
  v.idx = idx;
  v.notional = notional;
  for (let i = 0n; i < 14n; i++) v.pad.set(i, 0n);
  recomputeMin(b);
  return true;
}
