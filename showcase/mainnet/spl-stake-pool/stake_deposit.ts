// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// Depositing a stake account into the pool (processor.rs process_deposit_stake): DepositStake (9) and
// DepositStakeWithSlippage (23). The user's stake account, delegated to one of the pool's validators and active, has
// its staker and withdrawer handed to the pool's withdraw authority (signed by the stake deposit authority: the
// pool's PDA [pool, "deposit"] by default, which makes deposits permissionless, or a key of the manager's choosing,
// which must then sign) and is merged into that validator's stake account. The Stake program checks the rest: the
// authorities, the lockup, that both are active and delegated to the same vote account. The pool mints tokens for
// the lamports the validator stake account gained: those that came as stake at the stake deposit fee, the rest (the
// deposit's rent reserve and any undelegated lamports) at the SOL deposit fee, and withdraws the latter into the
// reserve. The referrer gets its share of both fees.
import {
  type RemainingAccounts,
  type StakeProgram,
  type TokenInterface,
  ProgramError,
  createProgramAddress,
  currentEpoch,
  loadBorsh,
  loadRawMut,
  log,
  named,
  programAt,
  programId,
  readData,
  require,
  signer,
  storeBorsh,
  u64,
  u8,
} from "typesol";
import { StakePoolError } from "./errors.js";
import { type StakePool, type ValidatorList, AccountType, STAKE_DELEGATED, STATUS_ACTIVE } from "./state.js";
import {
  AUTHORITY_DEPOSIT,
  CLOCK_SYSVAR_ID,
  U64_MAX,
  calcPoolTokensForDeposit,
  calcReferralFee,
  checkAccountOwner,
  checkAuthorityWithdraw,
  checkListHeaderDecodes,
  checkListHeaderValid,
  checkMint,
  checkNotTheList,
  checkReserveStake,
  checkStakeProgram,
  checkSysvar,
  checkValidatorList,
  checkValidatorStakeAddress,
  delegatedStakeState,
  feeApply,
  mintTokens,
  need,
  panicIfTheList,
  saturatingAdd,
  stakeMerge,
  stakeWithdraw,
  toU64,
} from "./util.js";

/**
 * Tags 9 and 23: deposit the stake account at position 4 into the validator stake account at position 5. With
 * `slippage`, fewer than `minimumOut` pool tokens for the user fail.
 */
export function depositStake(rest: RemainingAccounts, slippage: boolean, minimumOut: u64): void {
  // The Clock is read as the twelfth account is taken.
  need(rest, 12n);
  checkSysvar(rest.get(11n), CLOCK_SYSVAR_ID);
  need(rest, 15n);
  const poolAcct = rest.get(0n);
  const listAcct = rest.get(1n);
  const depositAuth = rest.get(2n);
  const withdrawAuth = rest.get(3n);
  const userStake = rest.get(4n);
  const validatorStake = rest.get(5n);
  const reserve = rest.get(6n);
  const userPool = rest.get(7n);
  const managerFee = rest.get(8n);
  const referrerFee = rest.get(9n);
  const mint = rest.get(10n);
  // The Clock and StakeHistory (accounts 11 and 12): named by address in the Stake CPIs, passed as these accounts.
  const clock = rest.get(11n);
  const stakeHistory = rest.get(12n);
  const tokenProgram = rest.get(13n);

  checkStakeProgram(rest.get(14n));
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkAuthorityWithdraw(pool, withdrawAuth.key, poolAcct.key);
  require(pool.stakeDepositAuthority === depositAuth.key, StakePoolError.InvalidStakeDepositAuthority);
  checkMint(pool, mint);
  checkValidatorList(pool, listAcct);
  checkReserveStake(pool, reserve);
  require(pool.tokenProgramId === tokenProgram.key, ProgramError.IncorrectProgramId);
  // An invalid manager fee account blocks deposits (they hold no user funds hostage).
  require(pool.managerFeeAccount === managerFee.key, StakePoolError.InvalidFeeAccount);
  require(pool.lastUpdateEpoch >= currentEpoch(), StakePoolError.StakeListAndPoolOutOfDate);

  checkAccountOwner(listAcct, programId());
  checkListHeaderDecodes(listAcct);
  const list = loadRawMut<ValidatorList>(listAcct);
  checkListHeaderValid(listAcct);

  // The validator stake account is read before it is looked up (no owner check: the merge makes that one).
  panicIfTheList(validatorStake, listAcct);
  const before = delegatedStakeState(validatorStake);
  const lamportsBefore = validatorStake.lamports;
  const voteKey = before.voter;
  const preferred = pool.preferredDepositValidatorVoteAddress;
  if (preferred !== null && preferred !== voteKey) {
    log(`Incorrect deposit address, expected ${preferred}, received ${voteKey}`);
    require(false, StakePoolError.IncorrectDepositVoteAddress);
  }
  const i = list.validators.findIndex((v) => v.voteAccountAddress === voteKey);
  require(i >= 0n, StakePoolError.ValidatorNotFound);
  const entry = list.validators.get(u64(i));
  checkValidatorStakeAddress(poolAcct.key, validatorStake.key, voteKey, entry.validatorSeedSuffix);
  if (u64(entry.status) !== STATUS_ACTIVE) {
    log("Validator is marked for removal and no longer accepting deposits");
    require(false, StakePoolError.ValidatorNotFound);
  }
  log(`Stake pre merge ${before.delegatedStake}`);

  // Hand both authorities to the withdraw authority: the deposit PDA signs for itself, any other authority must have
  // signed the transaction. A signer is never a program address (off the curve), so it needs no search.
  const stake = programAt<StakeProgram>(rest.get(14n));
  const newAuthority = withdrawAuth.key;
  // The authorities change on the user's stake account, signed by the deposit authority (a key the manager may set to
  // anything): neither may be the list.
  checkNotTheList(userStake, listAcct);
  checkNotTheList(depositAuth, listAcct);
  if (depositAuth.isSigner) {
    stake.authorize(userStake, named(clock, CLOCK_SYSVAR_ID), depositAuth, newAuthority, "staker");
    stake.authorize(userStake, named(clock, CLOCK_SYSVAR_ID), depositAuth, newAuthority, "withdrawer");
  } else {
    // find_deposit_authority_program_address: the first bump from 255 down that gives an address.
    let depositBump: u8 = 255n;
    let address = createProgramAddress([poolAcct.key, AUTHORITY_DEPOSIT, depositBump], programId());
    while (address === null) {
      depositBump = depositBump - 1n;
      address = createProgramAddress([poolAcct.key, AUTHORITY_DEPOSIT, depositBump], programId());
    }
    if (address === depositAuth.key) {
      const seeds = signer([poolAcct.key, AUTHORITY_DEPOSIT, depositBump]);
      stake.authorize(userStake, named(clock, CLOCK_SYSVAR_ID), depositAuth, newAuthority, "staker", seeds);
      stake.authorize(userStake, named(clock, CLOCK_SYSVAR_ID), depositAuth, newAuthority, "withdrawer", seeds);
    } else {
      stake.authorize(userStake, named(clock, CLOCK_SYSVAR_ID), depositAuth, newAuthority, "staker");
      stake.authorize(userStake, named(clock, CLOCK_SYSVAR_ID), depositAuth, newAuthority, "withdrawer");
    }
  }
  const bump = pool.stakeWithdrawBumpSeed;
  stakeMerge(stake, userStake, withdrawAuth, poolAcct.key, bump, validatorStake, clock, stakeHistory);

  // A merged account is still delegated: only its stake is read again.
  const stakeAfter = readData<u64>(validatorStake, STAKE_DELEGATED);
  const lamportsAfter = validatorStake.lamports;
  log(`Stake post merge ${stakeAfter}`);

  require(lamportsAfter >= lamportsBefore, StakePoolError.CalculationFailure);
  const totalDeposit = lamportsAfter - lamportsBefore;
  require(stakeAfter >= before.delegatedStake, StakePoolError.CalculationFailure);
  const stakeDeposit = stakeAfter - before.delegatedStake;
  require(totalDeposit >= stakeDeposit, StakePoolError.CalculationFailure);
  const solDeposit = totalDeposit - stakeDeposit;

  const newPoolTokens = calcPoolTokensForDeposit(pool, totalDeposit);
  const fromStake = calcPoolTokensForDeposit(pool, stakeDeposit);
  require(newPoolTokens >= fromStake, StakePoolError.CalculationFailure);
  const fromSol = newPoolTokens - fromStake;
  const stakeFee = toU64(feeApply(pool.stakeDepositFee, fromStake));
  const solFee = toU64(feeApply(pool.solDepositFee, fromSol));
  require(stakeFee <= U64_MAX - solFee, StakePoolError.CalculationFailure);
  const totalFee = stakeFee + solFee;
  require(newPoolTokens >= totalFee, StakePoolError.CalculationFailure);
  const userTokens = newPoolTokens - totalFee;
  const referralFee = calcReferralFee(totalFee, pool.stakeReferralFee);
  require(totalFee >= referralFee, StakePoolError.CalculationFailure);
  const managerTokens = totalFee - referralFee;
  require(saturatingAdd(saturatingAdd(userTokens, managerTokens), referralFee) === newPoolTokens, StakePoolError.CalculationFailure);
  require(userTokens !== 0n, StakePoolError.DepositTooSmall);
  require(!slippage || userTokens >= minimumOut, StakePoolError.ExceededSlippage);

  const token = programAt<TokenInterface>(tokenProgram);
  checkNotTheList(userPool, listAcct);
  mintTokens(token, mint, userPool, withdrawAuth, poolAcct.key, bump, userTokens);
  if (managerTokens > 0n) mintTokens(token, mint, managerFee, withdrawAuth, poolAcct.key, bump, managerTokens);
  if (referralFee > 0n) {
    checkNotTheList(referrerFee, listAcct);
    mintTokens(token, mint, referrerFee, withdrawAuth, poolAcct.key, bump, referralFee);
  }
  // The lamports that did not come as stake go to the reserve.
  if (solDeposit > 0n) stakeWithdraw(stake, validatorStake, withdrawAuth, poolAcct.key, bump, reserve, clock, stakeHistory, solDeposit);

  require(pool.poolTokenSupply <= U64_MAX - newPoolTokens, StakePoolError.CalculationFailure);
  pool.poolTokenSupply += newPoolTokens;
  // The extra lamports count as though they were sent to the reserve directly.
  require(pool.totalLamports <= U64_MAX - totalDeposit, StakePoolError.CalculationFailure);
  pool.totalLamports += totalDeposit;
  storeBorsh(poolAcct, pool);
  entry.activeStakeLamports = validatorStake.lamports;
}
