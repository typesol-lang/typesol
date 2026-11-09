// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// Withdrawing a stake account from the pool (processor.rs process_withdraw_stake): WithdrawStake (10) and
// WithdrawStakeWithSlippage (24). The user burns pool tokens (less the stake withdrawal fee, transferred to the
// manager's fee account) and gets their lamports split off one of the pool's stake accounts into an uninitialized
// stake account, whose authorities are then handed to the user. Where the lamports come from is not the user's
// choice: from a validator stake account while any has more than the minimum (the preferred withdraw validator first,
// while it has), else from a transient stake account, else a validator stake account at the minimum is taken whole
// (and the validator leaves the pool), and from the reserve only when no validator has anything to give.
import {
  type RemainingAccounts,
  type StakeProgram,
  type TokenInterface,
  ProgramError,
  currentEpoch,
  loadBorsh,
  loadRawMut,
  log,
  named,
  programAt,
  programId,
  rentExempt,
  require,
  signer,
  storeBorsh,
  u64,
  u8,
} from "typesol";
import { StakePoolError } from "./errors.js";
import { type StakePool, type ValidatorList, AccountType, INVALID_STAKE_STATE, STAKE_STATE_STAKE, STATUS_ACTIVE, STATUS_READY_FOR_REMOVAL } from "./state.js";
import {
  AUTHORITY_WITHDRAW,
  CLOCK_SYSVAR_ID,
  U64_MAX,
  UNPACK_OK,
  burnTokens,
  calcLamportsWithdrawAmount,
  checkAccountOwner,
  checkAuthorityWithdraw,
  checkListHeaderDecodes,
  checkListHeaderValid,
  checkMint,
  checkNotTheList,
  checkStakeProgram,
  checkSysvar,
  checkTransientStakeAddress,
  checkValidatorList,
  checkValidatorStakeAddress,
  dataLenPanicIfTheList,
  feeApply,
  managerFeeInfoProblem,
  minimumReserveLamports,
  minimumStakeLamports,
  need,
  saturatingAdd,
  saturatingSub,
  stakeSplit,
  stakeState,
  toU64,
  transferTokens,
} from "./util.js";

/** StakeWithdrawSource: where the lamports come from. */
const SOURCE_RESERVE = 0n;
const SOURCE_ACTIVE = 1n;
const SOURCE_TRANSIENT = 2n;
const SOURCE_VALIDATOR_REMOVAL = 3n;

/**
 * Tags 10 and 24: burn `poolTokens` from the account at position 7 (its owner or delegate signing at position 6) for
 * a stake account split off the one at position 3 into the one at position 4, handed to the key at position 5. With
 * `slippage`, fewer than `minimumOut` lamports fail.
 */
export function withdrawStake(rest: RemainingAccounts, poolTokens: u64, slippage: boolean, minimumOut: u64): void {
  // The Clock is read as the eleventh account is taken.
  need(rest, 11n);
  checkSysvar(rest.get(10n), CLOCK_SYSVAR_ID);
  need(rest, 13n);
  const poolAcct = rest.get(0n);
  const listAcct = rest.get(1n);
  const withdrawAuth = rest.get(2n);
  const splitFrom = rest.get(3n);
  const splitTo = rest.get(4n);
  const userStakeAuthority = rest.get(5n);
  const userAuthority = rest.get(6n);
  const burnFrom = rest.get(7n);
  const managerFee = rest.get(8n);
  const mint = rest.get(9n);
  const clock = rest.get(10n);
  const tokenProgram = rest.get(11n);

  checkStakeProgram(rest.get(12n));
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkMint(pool, mint);
  checkValidatorList(pool, listAcct);
  checkAuthorityWithdraw(pool, withdrawAuth.key, poolAcct.key);
  require(pool.managerFeeAccount === managerFee.key, StakePoolError.InvalidFeeAccount);
  require(pool.tokenProgramId === tokenProgram.key, ProgramError.IncorrectProgramId);
  require(pool.lastUpdateEpoch >= currentEpoch(), StakePoolError.StakeListAndPoolOutOfDate);

  checkAccountOwner(listAcct, programId());
  checkListHeaderDecodes(listAcct);
  const list = loadRawMut<ValidatorList>(listAcct);
  checkListHeaderValid(listAcct);

  // No fee when the manager withdraws from the fee account itself, or when the fee account can no longer take it
  // (a faulty fee account must not block withdrawals).
  let fee: u64 = 0n;
  if (pool.managerFeeAccount !== burnFrom.key && managerFeeInfoProblem(pool, managerFee) === UNPACK_OK)
    fee = toU64(feeApply(pool.stakeWithdrawalFee, poolTokens));
  require(fee <= poolTokens, StakePoolError.CalculationFailure);
  const burnt = poolTokens - fee;
  let withdrawLamports = calcLamportsWithdrawAmount(pool, burnt);
  require(withdrawLamports !== 0n, StakePoolError.WithdrawalTooSmall);
  require(!slippage || withdrawLamports >= minimumOut, StakePoolError.ExceededSlippage);

  dataLenPanicIfTheList(splitFrom, listAcct);
  const splitFromRent = rentExempt(splitFrom.dataLen);
  const stake = programAt<StakeProgram>(rest.get(12n));
  const stakeMinimum = stake.getMinimumDelegation();
  const s = stakeState(splitFrom);
  require(s.tag !== INVALID_STAKE_STATE, ProgramError.BorshIoError);
  const required = minimumStakeLamports(splitFromRent, stakeMinimum);

  // get_lamports_per_pool_token: the value of one pool token, rounded up.
  require(pool.totalLamports <= U64_MAX - pool.poolTokenSupply, StakePoolError.CalculationFailure);
  const sum = pool.totalLamports + pool.poolTokenSupply;
  require(sum !== 0n && pool.poolTokenSupply !== 0n, StakePoolError.CalculationFailure);
  const perToken = (sum - 1n) / pool.poolTokenSupply;
  const tolerance = saturatingAdd(required, perToken);

  // Whether an active validator has more than the minimum (and the tolerance) on its validator stake account, or on
  // its transient stake account: two searches, as the original's, each stopping at the first one found (the lamports
  // compared before the status is read).
  let hasActive = false;
  for (const v of list.validators)
    if (v.activeStakeLamports > tolerance && u64(v.status) === STATUS_ACTIVE) {
      hasActive = true;
      break;
    }
  let hasTransient = false;
  for (const v of list.validators)
    if (v.transientStakeLamports > tolerance && u64(v.status) === STATUS_ACTIVE) {
      hasTransient = true;
      break;
    }

  let source = SOURCE_RESERVE;
  let index: u64 = 0n;
  if (splitFrom.key === pool.reserveStake) {
    if (hasTransient || hasActive) {
      log("Error withdrawing from reserve: validator stake accounts have lamports available, please use those first.");
      require(false, StakePoolError.StakeLamportsNotEqualToMinimum);
    }
    const reserveMinimum = minimumReserveLamports(splitFromRent);
    if (saturatingSub(splitFrom.lamports, withdrawLamports) < reserveMinimum) {
      log(
        `Attempting to withdraw ${withdrawLamports} lamports, maximum possible SOL withdrawal is ${saturatingSub(splitFrom.lamports, reserveMinimum)} lamports`,
      );
      require(false, StakePoolError.SolWithdrawalTooLarge);
    }
  } else {
    require(s.tag === STAKE_STATE_STAKE, StakePoolError.WrongStakeStake);
    const voteKey = s.voter;
    const preferred = pool.preferredWithdrawValidatorVoteAddress;
    if (preferred !== null) {
      // Defensive: the preferred validator may have been removed.
      const p = list.validators.findIndex((v) => v.voteAccountAddress === preferred);
      if (p >= 0n) {
        const preferredActive = list.validators.get(u64(p)).activeStakeLamports;
        if (preferred !== voteKey && saturatingSub(preferredActive, tolerance) > 0n) {
          log(
            `Validator vote address ${preferred} is preferred for withdrawals, it currently has ${preferredActive} lamports available. Please withdraw those before using other validator stake accounts.`,
          );
          require(false, StakePoolError.IncorrectWithdrawVoteAddress);
        }
      } else log("Preferred withdraw validator not found, allowing withdrawal from any validator");
    }
    const i = list.validators.findIndex((v) => v.voteAccountAddress === voteKey);
    require(i >= 0n, StakePoolError.ValidatorNotFound);
    index = u64(i);
    const entry = list.validators.get(index);
    if (hasActive) {
      // While any validator has stake to give, it comes from a validator stake account.
      checkValidatorStakeAddress(poolAcct.key, splitFrom.key, voteKey, entry.validatorSeedSuffix);
      source = SOURCE_ACTIVE;
    } else if (hasTransient || entry.transientStakeLamports !== 0n) {
      // Then from a transient stake account (never removing a validator with transient lamports tied to it).
      checkTransientStakeAddress(poolAcct.key, splitFrom.key, voteKey, entry.transientSeedSuffix);
      source = SOURCE_TRANSIENT;
    } else {
      // Then a validator stake account at the minimum, whole.
      checkValidatorStakeAddress(poolAcct.key, splitFrom.key, voteKey, entry.validatorSeedSuffix);
      source = SOURCE_VALIDATOR_REMOVAL;
    }
    if (u64(entry.status) !== STATUS_ACTIVE) {
      log("Validator is marked for removal and no longer allowing withdrawals");
      require(false, StakePoolError.ValidatorNotFound);
    }
    const available = splitFrom.lamports;
    if (source !== SOURCE_VALIDATOR_REMOVAL) {
      if (saturatingSub(available, withdrawLamports) < required) {
        log(`Attempting to withdraw ${withdrawLamports} lamports from validator account with ${available} stake lamports, ${required} must remain`);
        require(false, StakePoolError.StakeLamportsNotEqualToMinimum);
      }
    } else {
      if (withdrawLamports < available || withdrawLamports > saturatingAdd(available, perToken)) {
        log(
          `Cannot withdraw a whole account worth ${withdrawLamports} lamports, must withdraw at least ${available} lamports worth of pool tokens with a margin of ${perToken} lamports`,
        );
        require(false, StakePoolError.StakeLamportsNotEqualToMinimum);
      }
      // The account goes whole: the lamports are cut down to what it holds.
      withdrawLamports = available;
      const preferredDeposit = pool.preferredDepositValidatorVoteAddress;
      if (preferredDeposit !== null && preferredDeposit === voteKey) pool.preferredDepositValidatorVoteAddress = null;
      const preferredWithdraw = pool.preferredWithdrawValidatorVoteAddress;
      if (preferredWithdraw !== null && preferredWithdraw === voteKey) pool.preferredWithdrawValidatorVoteAddress = null;
    }
  }

  const token = programAt<TokenInterface>(tokenProgram);
  checkNotTheList(burnFrom, listAcct);
  checkNotTheList(userAuthority, listAcct);
  burnTokens(token, burnFrom, mint, userAuthority, burnt);
  const bump = pool.stakeWithdrawBumpSeed;
  checkNotTheList(splitTo, listAcct);
  stakeSplit(stake, splitFrom, withdrawAuth, poolAcct.key, bump, withdrawLamports, splitTo);
  const seeds = signer([poolAcct.key, AUTHORITY_WITHDRAW, bump]);
  stake.authorize(splitTo, named(clock, CLOCK_SYSVAR_ID), withdrawAuth, userStakeAuthority.key, "staker", seeds);
  stake.authorize(splitTo, named(clock, CLOCK_SYSVAR_ID), withdrawAuth, userStakeAuthority.key, "withdrawer", seeds);
  if (fee > 0n) transferTokens(token, burnFrom, mint, managerFee, userAuthority, fee);

  require(pool.poolTokenSupply >= burnt, StakePoolError.CalculationFailure);
  pool.poolTokenSupply -= burnt;
  require(pool.totalLamports >= withdrawLamports, StakePoolError.CalculationFailure);
  pool.totalLamports -= withdrawLamports;
  storeBorsh(poolAcct, pool);

  if (source === SOURCE_RESERVE) return;
  const entry = list.validators.get(index);
  if (source === SOURCE_TRANSIENT) {
    require(entry.transientStakeLamports >= withdrawLamports, StakePoolError.CalculationFailure);
    entry.transientStakeLamports -= withdrawLamports;
    return;
  }
  require(entry.activeStakeLamports >= withdrawLamports, StakePoolError.CalculationFailure);
  entry.activeStakeLamports -= withdrawLamports;
  if (source === SOURCE_VALIDATOR_REMOVAL) {
    if (entry.activeStakeLamports !== 0n) {
      log(
        `Attempting to remove a validator from the pool, but withdrawal leaves ${entry.activeStakeLamports} lamports, update the pool to merge any unaccounted lamports`,
      );
      require(false, StakePoolError.StakeListAndPoolOutOfDate);
    }
    // There is no transient stake (checked above): the entry is ready for removal at once.
    entry.status = u8(STATUS_READY_FOR_REMOVAL);
  }
}
