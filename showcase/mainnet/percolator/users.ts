// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb, src/percolator.rs `process_instruction`),
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The account-level instructions: InitUser (1) and InitLP (2), DepositCollateral (3), WithdrawCollateral (4),
// CloseAccount (8; its resolved arm shares resolve.ts `closeResolved`), TopUpInsurance (9), ReclaimEmptyAccount
// (25), SettleAccount (26), DepositFeeCredits (27) and ConvertReleasedPnl (28). Each is the original's handler statement for statement.
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccounts,
  type TokenProgram,
  type u16,
  type u64,
  ProgramError,
  loadRawMut,
  loadRawMutAt,
  programAt,
  require,
  u64 as toU64,
  u128 as toU128,
} from "typesol";
import { PercolatorError, check } from "./errors.js";
import { type GenerationTable, type MarketConfig, type RiskBuffer, type RiskBufferHolder, type RiskEngine, ENGINE_MAX_ACCOUNTS, ENGINE_OFF, GEN_TABLE_OFF, KIND_LP, RISK_BUF_OFF } from "./state.js";
import { feeDebt } from "./wide.js";
import { type PriceRead, U64_MAX, computeCurrentFundingRateE9, getEngineOraclePriceE6, isHyperpMode, permissionlessStaleMatured } from "./oracle.js";
import {
  PROGRESS_ONLY,
  ZERO_KEY,
  closeAccountNotAtomic,
  convertReleasedPnlNotAtomic,
  depositFeeCreditsEngine,
  depositNotAtomic,
  reclaimEmptyAccountNotAtomic,
  setOwner,
  settleAccountNotAtomic,
  topUpInsuranceFund,
  withdrawNotAtomic,
} from "./engine.js";
import {
  type SlabPrefix,
  baseDust,
  baseToUnits,
  boundedNow,
  checkIdx,
  depositCollateral,
  engineIsResolved,
  ensureMarketAccruedToNow,
  expectKey,
  expectLen,
  expectSigner,
  expectWritable,
  markOracleInitialized,
  readClock,
  readPriceAndStamp,
  requireInitialized,
  riskBufferRemove,
  sanitizeRiskBuffer,
  slabGuard,
  syncAccountFee,
  syncAccountFeeBoundedToMarket,
  unitsToBase,
  vaultAuthority,
  verifyTokenAccount,
  verifyTokenProgram,
  verifyVault,
  withdrawCollateral,
} from "./program.js";
import { closeResolved, riskBufferDrop } from "./resolve.js";


/** The TVL:insurance cap shared by InitUser, InitLP and DepositCollateral (admin opt-in: 0 disables it). */
function checkDepositCap(e: RiskEngine, config: MarketConfig, amount: u64): void {
  if (config.tvl_insurance_cap_mult > 0n) {
    const units = baseToUnits(amount, config.unit_scale);
    const ins = e.insurance_balance;
    const mult = toU128(config.tvl_insurance_cap_mult);
    const cap = mult !== 0n && ins > 340282366920938463463374607431768211455n / mult ? 340282366920938463463374607431768211455n : ins * mult;
    const cNew = e.c_tot > 340282366920938463463374607431768211455n - toU128(units) ? 340282366920938463463374607431768211455n : e.c_tot + toU128(units);
    require(cNew <= cap, PercolatorError.DepositCapExceeded);
  }
}

/**
 * The prefix every token-moving user instruction shares: 6 accounts (user, slab, user ATA, vault, token program,
 * clock), the signer, the writable slab, the token program, slab_guard, initialized, not resolved, the vault and the
 * user's token account.
 */
function userTokenPrefix(rest: RemainingAccounts, programId: Pubkey): void {
  expectLen(rest.length, 6n);
  const aUser = rest.get(0n);
  const aSlab = rest.get(1n);
  expectSigner(aUser);
  expectWritable(aSlab);
  verifyTokenProgram(rest.get(4n));
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const mint = prefix.config.collateral_mint;
  const auth = vaultAuthority(aSlab.key, prefix.config.vault_authority_bump, programId);
  verifyVault(rest.get(3n), auth, mint, prefix.config.vault_pubkey, false);
  verifyTokenAccount(rest.get(2n), aUser.key, mint);
}

// ---- InitUser (tag 1) and InitLP (tag 2) -------------------------------------------------------------------------------

/** @noinline */
export function initAccount(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey, lp: boolean): void {
  let matcherProgram = ZERO_KEY;
  let matcherContext = ZERO_KEY;
  let feePayment = 0n;
  if (lp) {
    matcherProgram = data.readPubkey(1n);
    matcherContext = data.readPubkey(33n);
    feePayment = data.readU64(65n);
  } else feePayment = data.readU64(1n);
  userTokenPrefix(rest, programId);
  const aUser = rest.get(0n);
  const aSlab = rest.get(1n);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const clock = readClock(rest.get(5n));
  require(!permissionlessStaleMatured(prefix.config, clock.slot), PercolatorError.OracleStale);
  require(baseDust(feePayment, prefix.config.unit_scale) === 0n, ProgramError.InvalidArgument);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  checkDepositCap(e, prefix.config, feePayment);
  // `new_account_fee.try_into::<u64>()` (EngineOverflow above u64).
  require(prefix.config.new_account_fee <= toU128(U64_MAX), PercolatorError.EngineOverflow);
  const feeBase = toU64(prefix.config.new_account_fee);
  require(feePayment > feeBase, PercolatorError.EngineInsufficientBalance);
  const capitalBase = feePayment - feeBase;
  depositCollateral(programAt<TokenProgram>(rest.get(4n)), rest.get(2n), rest.get(3n), aUser, feePayment);
  const capitalUnits = baseToUnits(capitalBase, prefix.config.unit_scale);
  const feeUnits = baseToUnits(feeBase, prefix.config.unit_scale);
  require(capitalUnits !== 0n, PercolatorError.EngineInsufficientBalance);
  const idx = e.free_head;
  require(toU64(idx) < ENGINE_MAX_ACCOUNTS, PercolatorError.EngineOverflow);
  depositNotAtomic(e, idx, toU128(capitalUnits), clock.slot);
  setOwner(e, idx, aUser.key);
  if (lp) {
    const a = e.accounts.get(toU64(idx));
    a.kind = KIND_LP;
    a.matcher_program = matcherProgram;
    a.matcher_context = matcherContext;
  }
  if (feeUnits > 0n) topUpInsuranceFund(e, toU128(feeUnits), clock.slot);
  // state::next_mat_counter (None at u64::MAX: EngineOverflow), then the generation table.
  require(prefix.header.mat_counter !== U64_MAX, PercolatorError.EngineOverflow);
  prefix.header.mat_counter += 1n;
  const gens = loadRawMutAt<GenerationTable>(aSlab, GEN_TABLE_OFF);
  gens.generation.set(toU64(idx), prefix.header.mat_counter);
}

// ---- DepositCollateral (tag 3) -----------------------------------------------------------------------------------------

/** @noinline */
export function deposit(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const userIdx = data.readU16(1n);
  const amount = data.readU64(3n);
  userTokenPrefix(rest, programId);
  const aUser = rest.get(0n);
  const aSlab = rest.get(1n);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const clock = readClock(rest.get(5n));
  require(!permissionlessStaleMatured(prefix.config, clock.slot), PercolatorError.OracleStale);
  require(baseDust(amount, prefix.config.unit_scale) === 0n, ProgramError.InvalidArgument);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  checkDepositCap(e, prefix.config, amount);
  depositCollateral(programAt<TokenProgram>(rest.get(4n)), rest.get(2n), rest.get(3n), aUser, amount);
  const units = baseToUnits(amount, prefix.config.unit_scale);
  checkIdx(e, userIdx);
  require(e.accounts.get(toU64(userIdx)).owner === aUser.key, PercolatorError.EngineUnauthorized);
  syncAccountFeeBoundedToMarket(e, prefix.config.maintenance_fee_per_slot, userIdx, clock.slot);
  depositNotAtomic(e, userIdx, toU128(units), clock.slot);
}

// ---- WithdrawCollateral (tag 4) ----------------------------------------------------------------------------------------

/** @noinline */
export function withdraw(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const userIdx = data.readU16(1n);
  const amount = data.readU64(3n);
  expectLen(rest.length, 8n);
  const aUser = rest.get(0n);
  const aSlab = rest.get(1n);
  const aVault = rest.get(2n);
  const aUserAta = rest.get(3n);
  const aVaultPda = rest.get(4n);
  expectSigner(aUser);
  expectWritable(aSlab);
  verifyTokenProgram(rest.get(5n));
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const mint = prefix.config.collateral_mint;
  const derived = vaultAuthority(aSlab.key, prefix.config.vault_authority_bump, programId);
  expectKey(aVaultPda, derived);
  verifyVault(aVault, derived, mint, prefix.config.vault_pubkey, false);
  verifyTokenAccount(aUserAta, aUser.key, mint);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const clock = readClock(rest.get(6n));
  const rate = computeCurrentFundingRateE9(prefix.config);
  const read: PriceRead = { price: 0n, publish_time: 0n };
  if (isHyperpMode(prefix.config)) check(getEngineOraclePriceE6(clock.slot, clock.unix_timestamp, prefix.config, rest.get(7n), read));
  else check(readPriceAndStamp(prefix.config, rest.get(7n), clock.unix_timestamp, clock.slot, read));
  const price = read.price;
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  checkIdx(e, userIdx);
  require(e.accounts.get(toU64(userIdx)).owner === aUser.key, PercolatorError.EngineUnauthorized);
  require(!(prefix.config.unit_scale !== 0n && amount % toU64(prefix.config.unit_scale) !== 0n), ProgramError.InvalidInstructionData);
  const unitsRequested = baseToUnits(amount, prefix.config.unit_scale);
  const hMin = e.params.h_min;
  const hMax = e.params.h_max;
  ensureMarketAccruedToNow(e, clock.slot, price, rate);
  syncAccountFee(e, prefix.config.maintenance_fee_per_slot, userIdx, clock.slot);
  withdrawNotAtomic(e, userIdx, toU128(unitsRequested), price, clock.slot, rate, hMin, hMax);
  markOracleInitialized(prefix);
  const baseToPay = unitsToBase(unitsRequested, prefix.config.unit_scale);
  withdrawCollateral(programAt<TokenProgram>(rest.get(5n)), aVault, aUserAta, aVaultPda, baseToPay, aSlab.key, prefix.config.vault_authority_bump);
}

// ---- CloseAccount (tag 8) ----------------------------------------------------------------------------------------------

/** @noinline */
export function closeAccount(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const userIdx = data.readU16(1n);
  expectLen(rest.length, 8n);
  const aUser = rest.get(0n);
  const aSlab = rest.get(1n);
  const aVault = rest.get(2n);
  const aUserAta = rest.get(3n);
  const aPda = rest.get(4n);
  expectSigner(aUser);
  expectWritable(aSlab);
  verifyTokenProgram(rest.get(5n));
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const mint = prefix.config.collateral_mint;
  const auth = vaultAuthority(aSlab.key, prefix.config.vault_authority_bump, programId);
  verifyVault(aVault, auth, mint, prefix.config.vault_pubkey, false);
  verifyTokenAccount(aUserAta, aUser.key, mint);
  expectKey(aPda, auth);
  const resolved = engineIsResolved(aSlab);
  const clock = readClock(rest.get(6n));
  const rate = computeCurrentFundingRateE9(prefix.config);
  if (resolved) {
    // The resolved arm: at the settlement price (it must be set), the fee realized to resolved_slot, then
    // force_close_resolved_not_atomic; a winner on a market not terminal-ready yet is only reconciled.
    const er = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
    require(er.resolved_price !== 0n, ProgramError.InvalidAccountData);
    checkIdx(er, userIdx);
    require(er.accounts.get(toU64(userIdx)).owner === aUser.key, PercolatorError.EngineUnauthorized);
    const paid = closeResolved(er, prefix.config.maintenance_fee_per_slot, userIdx);
    if (paid === PROGRESS_ONLY) return;
    require(paid <= toU128(U64_MAX), PercolatorError.EngineOverflow);
    riskBufferDrop(aSlab, userIdx);
    withdrawCollateral(programAt<TokenProgram>(rest.get(5n)), aVault, aUserAta, aPda, unitsToBase(toU64(paid), prefix.config.unit_scale), aSlab.key, prefix.config.vault_authority_bump);
    return;
  }
  const read: PriceRead = { price: 0n, publish_time: 0n };
  if (isHyperpMode(prefix.config)) check(getEngineOraclePriceE6(clock.slot, clock.unix_timestamp, prefix.config, rest.get(7n), read));
  else check(readPriceAndStamp(prefix.config, rest.get(7n), clock.unix_timestamp, clock.slot, read));
  const price = read.price;
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  checkIdx(e, userIdx);
  require(e.accounts.get(toU64(userIdx)).owner === aUser.key, PercolatorError.EngineUnauthorized);
  const hMin = e.params.h_min;
  const hMax = e.params.h_max;
  ensureMarketAccruedToNow(e, clock.slot, price, rate);
  syncAccountFee(e, prefix.config.maintenance_fee_per_slot, userIdx, clock.slot);
  const amtUnits = closeAccountNotAtomic(e, userIdx, clock.slot, price, rate, hMin, hMax);
  require(amtUnits <= toU128(U64_MAX), PercolatorError.EngineOverflow);
  markOracleInitialized(prefix);
  // read_risk_buffer (a sanitized copy), remove, write_risk_buffer.
  const holder = loadRawMutAt<RiskBufferHolder>(aSlab, RISK_BUF_OFF);
  const buf: RiskBuffer = holder.buffer;
  sanitizeRiskBuffer(buf);
  riskBufferRemove(buf, userIdx);
  holder.buffer = buf;
  const baseToPay = unitsToBase(toU64(amtUnits), prefix.config.unit_scale);
  withdrawCollateral(programAt<TokenProgram>(rest.get(5n)), aVault, aUserAta, aPda, baseToPay, aSlab.key, prefix.config.vault_authority_bump);
}

// ---- TopUpInsurance (tag 9) --------------------------------------------------------------------------------------------

/** @noinline */
export function topUpInsurance(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const amount = data.readU64(1n);
  userTokenPrefix(rest, programId);
  const aUser = rest.get(0n);
  const aSlab = rest.get(1n);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const clock = readClock(rest.get(5n));
  require(!permissionlessStaleMatured(prefix.config, clock.slot), PercolatorError.OracleStale);
  require(baseDust(amount, prefix.config.unit_scale) === 0n, ProgramError.InvalidArgument);
  depositCollateral(programAt<TokenProgram>(rest.get(4n)), rest.get(2n), rest.get(3n), aUser, amount);
  const units = baseToUnits(amount, prefix.config.unit_scale);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  topUpInsuranceFund(e, toU128(units), boundedNow(e, clock.slot));
}

// ---- ReclaimEmptyAccount (tag 25) --------------------------------------------------------------------------------------

/** @noinline */
export function reclaimEmptyAccount(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const userIdx = data.readU16(1n);
  expectLen(rest.length, 2n);
  const aSlab = rest.get(0n);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const clock = readClock(rest.get(1n));
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  require(!permissionlessStaleMatured(prefix.config, clock.slot), PercolatorError.OracleStale);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  syncAccountFeeBoundedToMarket(e, prefix.config.maintenance_fee_per_slot, userIdx, clock.slot);
  reclaimEmptyAccountNotAtomic(e, userIdx, boundedNow(e, clock.slot));
}

// ---- SettleAccount (tag 26) --------------------------------------------------------------------------------------------

/** @noinline */
export function settleAccount(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const userIdx = data.readU16(1n);
  expectLen(rest.length, 3n);
  const aSlab = rest.get(0n);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const clock = readClock(rest.get(1n));
  const rate = computeCurrentFundingRateE9(prefix.config);
  const read: PriceRead = { price: 0n, publish_time: 0n };
  if (isHyperpMode(prefix.config)) check(getEngineOraclePriceE6(clock.slot, clock.unix_timestamp, prefix.config, rest.get(2n), read));
  else check(readPriceAndStamp(prefix.config, rest.get(2n), clock.unix_timestamp, clock.slot, read));
  const price = read.price;
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  const hMin = e.params.h_min;
  const hMax = e.params.h_max;
  ensureMarketAccruedToNow(e, clock.slot, price, rate);
  syncAccountFee(e, prefix.config.maintenance_fee_per_slot, userIdx, clock.slot);
  settleAccountNotAtomic(e, userIdx, price, clock.slot, rate, hMin, hMax);
  markOracleInitialized(prefix);
}

// ---- DepositFeeCredits (tag 27) ----------------------------------------------------------------------------------------

/** @noinline */
export function depositFeeCredits(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const userIdx = data.readU16(1n);
  const amount = data.readU64(3n);
  expectLen(rest.length, 6n);
  const aUser = rest.get(0n);
  const aSlab = rest.get(1n);
  expectSigner(aUser);
  expectWritable(aSlab);
  verifyTokenProgram(rest.get(4n));
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const mint = prefix.config.collateral_mint;
  const auth = vaultAuthority(aSlab.key, prefix.config.vault_authority_bump, programId);
  verifyVault(rest.get(3n), auth, mint, prefix.config.vault_pubkey, false);
  verifyTokenAccount(rest.get(2n), aUser.key, mint);
  const clock = readClock(rest.get(5n));
  require(!permissionlessStaleMatured(prefix.config, clock.slot), PercolatorError.OracleStale);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  checkIdx(e, userIdx);
  require(e.accounts.get(toU64(userIdx)).owner === aUser.key, PercolatorError.EngineUnauthorized);
  syncAccountFeeBoundedToMarket(e, prefix.config.maintenance_fee_per_slot, userIdx, clock.slot);
  const debt = feeDebt(e.accounts.get(toU64(userIdx)).fee_credits);
  const units = baseToUnits(amount, prefix.config.unit_scale);
  const dust = baseDust(amount, prefix.config.unit_scale);
  require(!(units === 0n || dust !== 0n), ProgramError.InvalidArgument);
  require(toU128(units) <= debt, ProgramError.InvalidArgument);
  depositCollateral(programAt<TokenProgram>(rest.get(4n)), rest.get(2n), rest.get(3n), aUser, amount);
  // Phase 4 reads the clock again (the same account) and books the payment at the bounded slot.
  depositFeeCreditsEngine(e, userIdx, toU128(units), boundedNow(e, clock.slot));
}


// ---- ConvertReleasedPnl (tag 28) ---------------------------------------------------------------------------------------

/** @noinline */
export function convertReleasedPnl(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const userIdx = data.readU16(1n);
  const amount = data.readU64(3n);
  expectLen(rest.length, 4n);
  const aUser = rest.get(0n);
  const aSlab = rest.get(1n);
  expectSigner(aUser);
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
  checkIdx(e, userIdx);
  require(e.accounts.get(toU64(userIdx)).owner === aUser.key, PercolatorError.EngineUnauthorized);
  require(baseDust(amount, prefix.config.unit_scale) === 0n, ProgramError.InvalidArgument);
  const units = baseToUnits(amount, prefix.config.unit_scale);
  const hMin = e.params.h_min;
  const hMax = e.params.h_max;
  ensureMarketAccruedToNow(e, clock.slot, price, rate);
  syncAccountFee(e, prefix.config.maintenance_fee_per_slot, userIdx, clock.slot);
  convertReleasedPnlNotAtomic(e, userIdx, toU128(units), price, clock.slot, rate, hMin, hMax);
  markOracleInitialized(prefix);
}
