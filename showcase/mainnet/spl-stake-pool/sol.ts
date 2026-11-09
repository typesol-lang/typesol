// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// SOL in and out of the reserve (processor.rs): DepositSol moves lamports into the reserve stake account and mints
// pool tokens at the current rate (less the SOL deposit fee, split between the manager and a referrer); WithdrawSol
// burns pool tokens (less the SOL withdrawal fee, sent to the manager) and withdraws their lamports from the reserve.
// The `...WithSlippage` forms add a minimum the user gets.
import {
  type RemainingAccounts,
  type StakeProgram,
  type SystemProgram,
  type TokenInterface,
  ProgramError,
  currentEpoch,
  loadBorsh,
  log,
  programAt,
  programId,
  rentExempt,
  require,
  storeBorsh,
  u64,
} from "typesol";
import { StakePoolError } from "./errors.js";
import { type StakePool, AccountType } from "./state.js";
import {
  U64_MAX,
  UNPACK_OK,
  burnTokens,
  calcLamportsWithdrawAmount,
  calcPoolTokensForDeposit,
  calcReferralFee,
  checkAccountOwner,
  checkAuthorityWithdraw,
  checkMint,
  checkReserveStake,
  checkSolDepositAuthority,
  checkSolWithdrawAuthority,
  checkStakeProgram,
  checkSystemProgram,
  feeApply,
  managerFeeInfoProblem,
  minimumReserveLamports,
  mintTokens,
  need,
  saturatingAdd,
  saturatingSub,
  stakeWithdraw,
  toU64,
  transferTokens,
} from "./util.js";

/**
 * Tags 14 and 25: deposit `lamports` from a signing wallet. With a SOL deposit authority set, it signs too (the
 * optional eleventh account). With `slippage`, fewer than `minimumOut` pool tokens for the user fail.
 */
export function depositSol(rest: RemainingAccounts, lamports: u64, slippage: boolean, minimumOut: u64): void {
  need(rest, 10n);
  const poolAcct = rest.get(0n);
  const withdrawAuth = rest.get(1n);
  const reserve = rest.get(2n);
  const from = rest.get(3n);
  const userPool = rest.get(4n);
  const managerFee = rest.get(5n);
  const referrerFee = rest.get(6n);
  const mint = rest.get(7n);
  const tokenProgram = rest.get(9n);
  const epoch = currentEpoch();

  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkAuthorityWithdraw(pool, withdrawAuth.key, poolAcct.key);
  checkSolDepositAuthority(pool, rest, 10n);
  checkMint(pool, mint);
  checkReserveStake(pool, reserve);
  require(pool.tokenProgramId === tokenProgram.key, ProgramError.IncorrectProgramId);
  checkSystemProgram(rest.get(8n));
  // An invalid manager fee account blocks deposits (they hold no user funds hostage).
  require(pool.managerFeeAccount === managerFee.key, StakePoolError.InvalidFeeAccount);
  // Pool tokens are minted at the rate of an up-to-date pool only.
  require(pool.lastUpdateEpoch >= epoch, StakePoolError.StakeListAndPoolOutOfDate);

  const newPoolTokens = calcPoolTokensForDeposit(pool, lamports);
  const depositFee = toU64(feeApply(pool.solDepositFee, newPoolTokens));
  require(depositFee <= newPoolTokens, StakePoolError.CalculationFailure);
  const userTokens = newPoolTokens - depositFee;
  const referralFee = calcReferralFee(depositFee, pool.solReferralFee);
  require(referralFee <= depositFee, StakePoolError.CalculationFailure);
  const managerTokens = depositFee - referralFee;
  require(saturatingAdd(saturatingAdd(userTokens, managerTokens), referralFee) === newPoolTokens, StakePoolError.CalculationFailure);
  require(userTokens !== 0n, StakePoolError.DepositTooSmall);
  require(!slippage || userTokens >= minimumOut, StakePoolError.ExceededSlippage);

  programAt<SystemProgram>(rest.get(8n)).transfer(from, reserve, lamports);
  const token = programAt<TokenInterface>(tokenProgram);
  const bump = pool.stakeWithdrawBumpSeed;
  mintTokens(token, mint, userPool, withdrawAuth, poolAcct.key, bump, userTokens);
  if (managerTokens > 0n) mintTokens(token, mint, managerFee, withdrawAuth, poolAcct.key, bump, managerTokens);
  if (referralFee > 0n) mintTokens(token, mint, referrerFee, withdrawAuth, poolAcct.key, bump, referralFee);

  require(pool.poolTokenSupply <= U64_MAX - newPoolTokens, StakePoolError.CalculationFailure);
  pool.poolTokenSupply += newPoolTokens;
  require(pool.totalLamports <= U64_MAX - lamports, StakePoolError.CalculationFailure);
  pool.totalLamports += lamports;
  storeBorsh(poolAcct, pool);
}

/**
 * Tags 16 and 26: burn `poolTokens` (the user transfer authority signs) for their lamports from the reserve, which
 * keeps its rent. With a SOL withdraw authority set, it signs too (the optional thirteenth account). With `slippage`,
 * fewer than `minimumOut` lamports fail.
 */
export function withdrawSol(rest: RemainingAccounts, poolTokens: u64, slippage: boolean, minimumOut: u64): void {
  need(rest, 12n);
  const poolAcct = rest.get(0n);
  const withdrawAuth = rest.get(1n);
  const userAuthority = rest.get(2n);
  const burnFrom = rest.get(3n);
  const reserve = rest.get(4n);
  const destination = rest.get(5n);
  const managerFee = rest.get(6n);
  const mint = rest.get(7n);
  const tokenProgram = rest.get(11n);

  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkAuthorityWithdraw(pool, withdrawAuth.key, poolAcct.key);
  checkSolWithdrawAuthority(pool, rest, 12n);
  checkMint(pool, mint);
  checkReserveStake(pool, reserve);
  require(pool.tokenProgramId === tokenProgram.key, ProgramError.IncorrectProgramId);
  checkStakeProgram(rest.get(10n));
  require(pool.managerFeeAccount === managerFee.key, StakePoolError.InvalidFeeAccount);
  require(pool.lastUpdateEpoch >= currentEpoch(), StakePoolError.StakeListAndPoolOutOfDate);

  // No fee when the manager withdraws from the fee account itself, or when the fee account can no longer take it
  // (a faulty fee account must not block withdrawals).
  let fee: u64 = 0n;
  if (pool.managerFeeAccount !== burnFrom.key && managerFeeInfoProblem(pool, managerFee) === UNPACK_OK)
    fee = toU64(feeApply(pool.solWithdrawalFee, poolTokens));
  require(fee <= poolTokens, StakePoolError.CalculationFailure);
  const burnt = poolTokens - fee;
  const withdrawLamports = calcLamportsWithdrawAmount(pool, burnt);
  require(withdrawLamports !== 0n, StakePoolError.WithdrawalTooSmall);
  require(!slippage || withdrawLamports >= minimumOut, StakePoolError.ExceededSlippage);

  const reserveMinimum = minimumReserveLamports(rentExempt(reserve.dataLen));
  if (saturatingSub(reserve.lamports, withdrawLamports) < reserveMinimum) {
    log(`Attempting to withdraw ${withdrawLamports} lamports, maximum possible SOL withdrawal is ${saturatingSub(reserve.lamports, reserveMinimum)} lamports`);
    require(false, StakePoolError.SolWithdrawalTooLarge);
  }

  const token = programAt<TokenInterface>(tokenProgram);
  burnTokens(token, burnFrom, mint, userAuthority, burnt);
  if (fee > 0n) transferTokens(token, burnFrom, mint, managerFee, userAuthority, fee);
  // Its Clock and StakeHistory (accounts 8 and 9) are named by address, never read here.
  stakeWithdraw(programAt<StakeProgram>(rest.get(10n)), reserve, withdrawAuth, poolAcct.key, pool.stakeWithdrawBumpSeed, destination, withdrawLamports);

  require(pool.poolTokenSupply >= burnt, StakePoolError.CalculationFailure);
  pool.poolTokenSupply -= burnt;
  require(pool.totalLamports >= withdrawLamports, StakePoolError.CalculationFailure);
  pool.totalLamports -= withdrawLamports;
  storeBorsh(poolAcct, pool);
}
