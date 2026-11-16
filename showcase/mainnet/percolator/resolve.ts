// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb, src/percolator.rs `process_instruction`),
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The end of a market: ResolveMarket (19), WithdrawInsurance (20), AdminForceCloseAccount (21),
// WithdrawInsuranceLimited (23), ResolvePermissionless (29) and ForceCloseResolved (30); CloseAccount's resolved arm
// (users.ts) shares `closeResolved` below. Each is the original's handler statement for statement. As in the other
// handlers that write the config only where nothing reads it in between and a failure changes nothing before it fails,
// the config is changed in place rather than through a copy (program.ts).
import {
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenProgram,
  type i128,
  type u16,
  type u64,
  type u128,
  ProgramError,
  loadRawMut,
  loadRawMutAt,
  programAt,
  require,
  u64 as toU64,
  u128 as toU128,
} from "typesol";
import { PercolatorError, OK, check, custom, E_ORACLE_CONF_TOO_WIDE, E_ORACLE_STALE } from "./errors.js";
import { type RiskBuffer, type RiskBufferHolder, type RiskEngine, ENGINE_OFF, FLAG_ORACLE_INITIALIZED, RISK_BUF_OFF } from "./state.js";
import { type PriceRead, U64_MAX, clampOraclePrice, clusterRestartedSinceInit, computeCurrentFundingRateE9, isHyperpMode, permissionlessStaleMatured, readEnginePriceE6, truncU64 } from "./oracle.js";
import { PROGRESS_ONLY, forceCloseResolvedNotAtomic, resolveMarketNotAtomic } from "./engine.js";
import { flushHyperpIndex } from "./market.js";
import {
  type SlabPrefix,
  baseDust,
  baseToUnits,
  catchupAccrue,
  checkIdx,
  engineIsResolved,
  expectKey,
  expectLen,
  expectSigner,
  expectWritable,
  readClock,
  readFlags,
  requireAdmin,
  requireInitialized,
  riskBufferRemove,
  sanitizeRiskBuffer,
  slabGuard,
  syncAccountFee,
  unitsToBase,
  vaultAuthority,
  verifyTokenAccount,
  verifyTokenProgram,
  verifyVault,
  withdrawCollateral,
} from "./program.js";

/** WithdrawInsuranceLimited's anti-Zeno floor: a call may always take this many units (up to the balance). */
const MIN_WITHDRAW_FLOOR_UNITS = 10n;

// ---- ResolveMarket (tag 19) --------------------------------------------------------------------------------------------

/** @noinline */
export function resolveMarket(rest: RemainingAccounts, programId: Pubkey): void {
  expectLen(rest.length, 4n);
  const aAdmin = rest.get(0n);
  const aSlab = rest.get(1n);
  expectSigner(aAdmin);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  requireAdmin(prefix.header.admin, aAdmin.key);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const rate = computeCurrentFundingRateE9(prefix.config);
  // The original reads the Clock account three times; the same account gives the same values.
  const clock = readClock(rest.get(2n));
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  // The hard timeout: resolved at P_last through the degenerate arm, as ResolvePermissionless does.
  if (permissionlessStaleMatured(prefix.config, clock.slot)) {
    const pLast = e.last_oracle_price;
    require(pLast !== 0n, PercolatorError.OracleInvalid);
    resolveMarketNotAtomic(e, true, pLast, pLast, clock.slot, 0n);
    prefix.config.hyperp_mark_e6 = pLast;
    return;
  }
  const hyperp = isHyperpMode(prefix.config);
  require(!(hyperp && prefix.config.hyperp_mark_e6 === 0n), ProgramError.InvalidAccountData);
  // The fresh external price (non-Hyperp): a stale or too-wide oracle falls through to the degenerate arm, any other
  // error is the instruction's. An observation not newer than the last one stands for the stored baseline.
  let haveFresh = false;
  let fresh: u64 = 0n;
  if (!hyperp) {
    const read: PriceRead = { price: 0n, publish_time: 0n };
    const r = readEnginePriceE6(rest.get(3n), prefix.config.index_feed_id, clock.unix_timestamp, prefix.config.max_staleness_secs, prefix.config.conf_filter_bps, prefix.config.invert, prefix.config.unit_scale, read);
    if (r === OK) {
      haveFresh = true;
      if (read.publish_time <= prefix.config.last_oracle_publish_time) fresh = prefix.config.last_effective_price_e6;
      else {
        fresh = read.price;
        prefix.config.last_effective_price_e6 = clampOraclePrice(prefix.config.last_effective_price_e6, read.price, prefix.config.oracle_price_cap_e2bps);
        prefix.config.last_oracle_publish_time = read.publish_time;
      }
    } else if (r !== custom(E_ORACLE_STALE) && r !== custom(E_ORACLE_CONF_TOO_WIDE)) check(r);
  }
  // Hyperp: the index flushed toward the mark without a staleness check.
  if (hyperp) flushHyperpIndex(prefix.config, clock.slot);
  let settlement: u64 = 0n;
  if (hyperp) settlement = prefix.config.mark_ewma_e6 > 0n ? prefix.config.mark_ewma_e6 : prefix.config.hyperp_mark_e6;
  else settlement = haveFresh ? fresh : e.last_oracle_price;
  const oracleInitialized = (readFlags(aSlab) & FLAG_ORACLE_INITIALIZED) !== 0n;
  // A Hyperp mark silent for more than 3 · max_staleness_secs slots goes the degenerate way too.
  let hyperpStale = false;
  if (hyperp) {
    const pushed = truncU64(prefix.config.last_mark_push_slot);
    const lastUpdate = prefix.config.mark_ewma_last_slot > pushed ? prefix.config.mark_ewma_last_slot : pushed;
    const maxStale = prefix.config.max_staleness_secs > U64_MAX / 3n ? U64_MAX : prefix.config.max_staleness_secs * 3n;
    const since = clock.slot > lastUpdate ? clock.slot - lastUpdate : 0n;
    hyperpStale = since > maxStale && oracleInitialized;
  }
  let live: u64 = 0n;
  let finalRate: i128 = 0n;
  let ordinary = false;
  if (haveFresh) {
    live = fresh;
    finalRate = rate;
    ordinary = true;
  } else if (hyperp && !hyperpStale) {
    live = prefix.config.last_effective_price_e6;
    finalRate = rate;
    ordinary = true;
  } else if ((hyperp && hyperpStale) || oracleInitialized) {
    live = e.last_oracle_price;
  } else require(false, PercolatorError.OracleInvalid);
  // The ordinary arm catches up first (chunks at the stored price), with the rate the final accrual uses.
  if (ordinary) catchupAccrue(e, clock.slot, finalRate);
  resolveMarketNotAtomic(e, !ordinary, settlement, live, clock.slot, finalRate);
}

// ---- ResolvePermissionless (tag 29) ------------------------------------------------------------------------------------

/** @noinline */
export function resolvePermissionless(rest: RemainingAccounts, programId: Pubkey): void {
  expectLen(rest.length, 2n);
  const aSlab = rest.get(0n);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  // A cluster restart since InitMarket freezes the market even with slot staleness turned off.
  require(clusterRestartedSinceInit(prefix.config) || prefix.config.permissionless_resolve_stale_slots !== 0n, PercolatorError.InvalidConfigParam);
  const clock = readClock(rest.get(1n));
  require(permissionlessStaleMatured(prefix.config, clock.slot), PercolatorError.OracleStale);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  const pLast = e.last_oracle_price;
  require(pLast !== 0n, PercolatorError.OracleInvalid);
  resolveMarketNotAtomic(e, true, pLast, pLast, clock.slot, 0n);
  prefix.config.hyperp_mark_e6 = pLast;
}

// ---- The resolved close (ForceCloseResolved, AdminForceCloseAccount, CloseAccount's resolved arm) ---------------------

/**
 * The maintenance fee realized to resolved_slot, then force_close_resolved_not_atomic: the payout in units, or
 * PROGRESS_ONLY (reconciled, kept open until the market is terminal-ready).
 */
export function closeResolved(e: Inout<RiskEngine>, feePerSlot: u128, idx: u16): u128 {
  syncAccountFee(e, feePerSlot, idx, e.resolved_slot);
  return forceCloseResolvedNotAtomic(e, idx);
}

/** read_risk_buffer (a sanitized copy), remove, write_risk_buffer. */
export function riskBufferDrop(aSlab: RemainingAccount, idx: u16): void {
  const holder = loadRawMutAt<RiskBufferHolder>(aSlab, RISK_BUF_OFF);
  const buf: RiskBuffer = holder.buffer;
  sanitizeRiskBuffer(buf);
  riskBufferRemove(buf, idx);
  holder.buffer = buf;
}

// ---- AdminForceCloseAccount (tag 21) -----------------------------------------------------------------------------------

/** @noinline */
export function adminForceCloseAccount(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const userIdx = data.readU16(1n);
  expectLen(rest.length, 8n);
  const aAdmin = rest.get(0n);
  const aSlab = rest.get(1n);
  const aVault = rest.get(2n);
  const aOwnerAta = rest.get(3n);
  const aPda = rest.get(4n);
  expectSigner(aAdmin);
  expectWritable(aSlab);
  verifyTokenProgram(rest.get(5n));
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  requireAdmin(prefix.header.admin, aAdmin.key);
  require(engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const mint = prefix.config.collateral_mint;
  const auth = vaultAuthority(aSlab.key, prefix.config.vault_authority_bump, programId);
  verifyVault(aVault, auth, mint, prefix.config.vault_pubkey, false);
  expectKey(aPda, auth);
  // Clock::from_account_info (not used further).
  readClock(rest.get(6n));
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  require(e.resolved_price !== 0n, ProgramError.InvalidAccountData);
  checkIdx(e, userIdx);
  const owner = e.accounts.get(toU64(userIdx)).owner;
  const amt = closeResolved(e, prefix.config.maintenance_fee_per_slot, userIdx);
  if (amt === PROGRESS_ONLY) return;
  require(amt <= toU128(U64_MAX), PercolatorError.EngineOverflow);
  if (amt > 0n) verifyTokenAccount(aOwnerAta, owner, mint);
  riskBufferDrop(aSlab, userIdx);
  const base = unitsToBase(toU64(amt), prefix.config.unit_scale);
  withdrawCollateral(programAt<TokenProgram>(rest.get(5n)), aVault, aOwnerAta, aPda, base, aSlab.key, prefix.config.vault_authority_bump);
}

// ---- ForceCloseResolved (tag 30) ---------------------------------------------------------------------------------------

/** @noinline */
export function forceCloseResolved(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const userIdx = data.readU16(1n);
  expectLen(rest.length, 7n);
  const aSlab = rest.get(0n);
  const aVault = rest.get(1n);
  const aOwnerAta = rest.get(2n);
  const aPda = rest.get(3n);
  // rest.get(6n), the oracle, is not read.
  expectWritable(aSlab);
  verifyTokenProgram(rest.get(4n));
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  const resolvedSlot = e.resolved_slot;
  const delay = prefix.config.force_close_delay_slots;
  require(delay !== 0n, PercolatorError.InvalidConfigParam);
  const clock = readClock(rest.get(5n));
  const due = resolvedSlot > U64_MAX - delay ? U64_MAX : resolvedSlot + delay;
  require(clock.slot >= due, ProgramError.InvalidAccountData);
  const mint = prefix.config.collateral_mint;
  const auth = vaultAuthority(aSlab.key, prefix.config.vault_authority_bump, programId);
  verifyVault(aVault, auth, mint, prefix.config.vault_pubkey, false);
  expectKey(aPda, auth);
  require(e.resolved_price !== 0n, ProgramError.InvalidAccountData);
  checkIdx(e, userIdx);
  const owner = e.accounts.get(toU64(userIdx)).owner;
  const amt = closeResolved(e, prefix.config.maintenance_fee_per_slot, userIdx);
  if (amt === PROGRESS_ONLY) return;
  if (amt > 0n) verifyTokenAccount(aOwnerAta, owner, mint);
  require(amt <= toU128(U64_MAX), PercolatorError.EngineOverflow);
  riskBufferDrop(aSlab, userIdx);
  const base = unitsToBase(toU64(amt), prefix.config.unit_scale);
  withdrawCollateral(programAt<TokenProgram>(rest.get(4n)), aVault, aOwnerAta, aPda, base, aSlab.key, prefix.config.vault_authority_bump);
}

// ---- WithdrawInsurance (tag 20) ----------------------------------------------------------------------------------------

/** @noinline */
export function withdrawInsurance(rest: RemainingAccounts, programId: Pubkey): void {
  expectLen(rest.length, 6n);
  const aAdmin = rest.get(0n);
  const aSlab = rest.get(1n);
  const aAta = rest.get(2n);
  const aVault = rest.get(3n);
  const aVaultPda = rest.get(5n);
  expectSigner(aAdmin);
  expectWritable(aSlab);
  verifyTokenProgram(rest.get(4n));
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  requireAdmin(prefix.header.insurance_authority, aAdmin.key);
  require(engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const mint = prefix.config.collateral_mint;
  const auth = vaultAuthority(aSlab.key, prefix.config.vault_authority_bump, programId);
  verifyVault(aVault, auth, mint, prefix.config.vault_pubkey, false);
  verifyTokenAccount(aAta, aAdmin.key, mint);
  expectKey(aVaultPda, auth);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  require(e.num_used_accounts === 0n, ProgramError.InvalidAccountData);
  // The terminal surplus: with every account closed and every aggregate zero, the whole vault is paid out (rounding
  // residue folded in); otherwise the insurance balance alone.
  const surplusOk =
    e.c_tot === 0n &&
    e.pnl_pos_tot === 0n &&
    e.pnl_matured_pos_tot === 0n &&
    e.oi_eff_long_q === 0n &&
    e.oi_eff_short_q === 0n &&
    e.stored_pos_count_long === 0n &&
    e.stored_pos_count_short === 0n &&
    e.stale_account_count_long === 0n &&
    e.stale_account_count_short === 0n &&
    e.neg_pnl_account_count === 0n;
  const payout = surplusOk ? e.vault : e.insurance_balance;
  if (payout === 0n) return;
  require(payout <= toU128(U64_MAX), PercolatorError.EngineOverflow);
  const base = unitsToBase(toU64(payout), prefix.config.unit_scale);
  e.insurance_balance = 0n;
  require(payout <= e.vault, PercolatorError.EngineInsufficientBalance);
  e.vault = e.vault - payout;
  withdrawCollateral(programAt<TokenProgram>(rest.get(4n)), aVault, aAta, aVaultPda, base, aSlab.key, prefix.config.vault_authority_bump);
}

// ---- WithdrawInsuranceLimited (tag 23) ---------------------------------------------------------------------------------

/** @noinline */
export function withdrawInsuranceLimited(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const amount = data.readU64(1n);
  expectLen(rest.length, 7n);
  const aOperator = rest.get(0n);
  const aSlab = rest.get(1n);
  const aAta = rest.get(2n);
  const aVault = rest.get(3n);
  const aVaultPda = rest.get(5n);
  expectSigner(aOperator);
  expectWritable(aSlab);
  verifyTokenProgram(rest.get(4n));
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  requireAdmin(prefix.header.insurance_operator, aOperator.key);
  const clock = readClock(rest.get(6n));
  require(!permissionlessStaleMatured(prefix.config, clock.slot), PercolatorError.OracleStale);
  require(prefix.config.insurance_withdraw_max_bps !== 0n, PercolatorError.InvalidConfigParam);
  const last = prefix.config.last_insurance_withdraw_slot;
  const since = clock.slot > last ? clock.slot - last : 0n;
  require(!(last !== 0n && since < prefix.config.insurance_withdraw_cooldown_slots), PercolatorError.InsuranceWithdrawCooldown);
  const units = baseToUnits(amount, prefix.config.unit_scale);
  require(!(baseDust(amount, prefix.config.unit_scale) !== 0n || units === 0n), ProgramError.InvalidArgument);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  const ins = e.insurance_balance;
  require(ins !== 0n, PercolatorError.EngineInsufficientBalance);
  // ins.saturating_mul(max_bps) / 10_000, at least the floor, at most the balance.
  const bps = toU128(prefix.config.insurance_withdraw_max_bps);
  const bpsCap = (ins > 340282366920938463463374607431768211455n / bps ? 340282366920938463463374607431768211455n : ins * bps) / 10000n;
  let cap = bpsCap > MIN_WITHDRAW_FLOOR_UNITS ? bpsCap : MIN_WITHDRAW_FLOOR_UNITS;
  if (cap > ins) cap = ins;
  require(toU128(units) <= cap, PercolatorError.InsuranceWithdrawCapExceeded);
  const mint = prefix.config.collateral_mint;
  const auth = vaultAuthority(aSlab.key, prefix.config.vault_authority_bump, programId);
  verifyVault(aVault, auth, mint, prefix.config.vault_pubkey, false);
  verifyTokenAccount(aAta, aOperator.key, mint);
  expectKey(aVaultPda, auth);
  e.insurance_balance = ins - toU128(units);
  require(e.vault >= toU128(units), PercolatorError.EngineInsufficientBalance);
  e.vault = e.vault - toU128(units);
  prefix.config.last_insurance_withdraw_slot = clock.slot;
  withdrawCollateral(programAt<TokenProgram>(rest.get(4n)), aVault, aAta, aVaultPda, amount, aSlab.key, prefix.config.vault_authority_bump);
}
