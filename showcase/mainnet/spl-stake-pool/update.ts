// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// The per-epoch update (processor.rs). UpdateValidatorListBalance goes over part of the validator list (a slice of it
// and as many validator / transient stake account pairs), merges transient stake where it can, takes back extra
// lamports, absorbs removed validators into the reserve and records each one's balances for this epoch. Then
// UpdateStakePoolBalance adds the reserve and the list up, mints the manager's epoch fee on the rewards, and moves the
// pending fees one epoch on. Until both have run in an epoch, deposits and withdrawals are refused.
import {
  type RemainingAccounts,
  type StakeProgram,
  type TokenInterface,
  ProgramError,
  currentEpoch,
  loadBorsh,
  loadRaw,
  loadRawMut,
  log,
  programAt,
  programId,
  readData,
  rentExempt,
  require,
  storeBorsh,
  u64,
  u8,
} from "typesol";
import { StakePoolError } from "./errors.js";
import {
  type StakePool,
  type ValidatorList,
  AccountType,
  STAKE_STATE_INITIALIZED,
  STAKE_STATE_STAKE,
  STATUS_ACTIVE,
  STATUS_DEACTIVATING_ALL,
  STATUS_DEACTIVATING_TRANSIENT,
  STATUS_DEACTIVATING_VALIDATOR,
  STATUS_READY_FOR_REMOVAL,
} from "./state.js";
import {
  CLOCK_SYSVAR_ID,
  U64_MAX,
  UNPACK_OK,
  calcEpochFeeAmount,
  checkAccountOwner,
  checkAuthorityWithdraw,
  checkListHeaderDecodes,
  checkListHeaderValid,
  checkMint,
  checkReserveStake,
  checkStakeProgram,
  checkSysvar,
  checkValidatorList,
  isTransientStakeAddress,
  isValidatorStakeAddress,
  managerFeeInfoProblem,
  minimumReserveLamports,
  mintTokens,
  need,
  notDeactivating,
  saturatingSub,
  stakeDeactivate,
  stakeIsInactiveWithoutHistory,
  stakeIsUsableByPool,
  stakeMerge,
  stakeState,
  stakeWithdraw,
  statusWithoutTransient,
  statusWithoutValidator,
  unpackMint,
} from "./util.js";

/**
 * Tag 6: update the list's entries from `start` on, one per pair of accounts after the seventh (the validator stake
 * account, then the transient one). A pair whose addresses are not that entry's is skipped. `noMerge` only records
 * balances (no merges, no withdrawals of extra lamports into the reserve).
 *
 * Not ported: the original first refuses to run while the cluster distributes epoch rewards (`EpochRewards::get()`,
 * EpochRewardDistributionInProgress). TypeSOL has no EpochRewards sysvar read yet.
 */
export function updateValidatorListBalance(rest: RemainingAccounts, start: u64, noMerge: boolean): void {
  need(rest, 5n);
  checkSysvar(rest.get(4n), CLOCK_SYSVAR_ID);
  need(rest, 7n);
  const poolAcct = rest.get(0n);
  const withdrawAuth = rest.get(1n);
  const listAcct = rest.get(2n);
  const reserve = rest.get(3n);
  const clock = rest.get(4n);
  const history = rest.get(5n);
  const epoch = currentEpoch();

  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkValidatorList(pool, listAcct);
  checkAuthorityWithdraw(pool, withdrawAuth.key, poolAcct.key);
  checkReserveStake(pool, reserve);
  checkStakeProgram(rest.get(6n));

  const accounts = rest.length - 7n;
  if (accounts % 2n !== 0n) {
    log("Odd number of validator stake accounts passed in, should be pairs of validator stake and transient stake accounts");
    require(false, StakePoolError.UnexpectedValidatorListAccountSize);
  }
  const pairs = accounts / 2n;
  checkAccountOwner(listAcct, programId());
  checkListHeaderDecodes(listAcct);
  const list = loadRawMut<ValidatorList>(listAcct);
  // deserialize_mut_slice(start, pairs): within the list's length.
  require(start + pairs <= list.validators.length, ProgramError.AccountDataTooSmall);
  checkListHeaderValid(listAcct);

  const stake = programAt<StakeProgram>(rest.get(6n));
  const bump = pool.stakeWithdrawBumpSeed;
  for (let i = 0n; i < pairs; i++) {
    const entry = list.validators.get(start + i);
    const validatorAcct = rest.get(7n + 2n * i);
    const transientAcct = rest.get(8n + 2n * i);
    const vote = entry.voteAccountAddress;
    if (!isValidatorStakeAddress(poolAcct.key, validatorAcct.key, vote, entry.validatorSeedSuffix)) continue;
    if (!isTransientStakeAddress(poolAcct.key, transientAcct.key, vote, entry.transientSeedSuffix)) continue;

    const validatorRent = rentExempt(validatorAcct.dataLen);
    let active: u64 = 0n;
    let transient: u64 = 0n;
    const validatorBefore = stakeState(validatorAcct);
    const t = stakeState(transientAcct);

    // The transient stake: inactive, merged into the reserve; active (and the validator stake too), merged into the
    // validator stake; activating or deactivating, counted as it is; not a stake account of the pool, ignored.
    if (entry.transientStakeLamports !== 0n) {
      if (t.tag === STAKE_STATE_INITIALIZED && stakeIsUsableByPool(t, withdrawAuth.key, pool)) {
        if (noMerge) transient = transientAcct.lamports;
        else {
          stakeMerge(stake, transientAcct, withdrawAuth, poolAcct.key, bump, reserve, clock, history);
          entry.status = statusWithoutTransient(entry.status);
        }
      } else if (t.tag === STAKE_STATE_STAKE && stakeIsUsableByPool(t, withdrawAuth.key, pool)) {
        if (!noMerge) {
          if (stakeIsInactiveWithoutHistory(t, epoch)) {
            stakeMerge(stake, transientAcct, withdrawAuth, poolAcct.key, bump, reserve, clock, history);
            entry.status = statusWithoutTransient(entry.status);
          } else if (u64(entry.status) === STATUS_ACTIVE) {
            if (t.activationEpoch < epoch) {
              if (validatorBefore.tag === STAKE_STATE_STAKE) {
                if (validatorBefore.activationEpoch < epoch) stakeMerge(stake, transientAcct, withdrawAuth, poolAcct.key, bump, validatorAcct, clock, history);
                else log("Stake activating or just active, not ready to merge");
              } else
                log(
                  `Transient stake is activating or active, but validator stake is not, need to add the validator stake account on ${t.voter} back into the stake pool`,
                );
            } else log("Transient stake not ready to be merged anywhere");
          } else if (notDeactivating(t)) {
            log("Transient stake is activating or active, deactivating.");
            stakeDeactivate(stake, transientAcct, clock, withdrawAuth, poolAcct.key, bump);
          }
        }
        transient = transientAcct.lamports;
      }
    }

    // The validator stake, as it is now: delegated, its extra lamports go back to the reserve and its balance is
    // counted (or, removed and inactive, it is merged into the reserve); initialized (undelegated), it is merged into
    // the reserve; anything else is no longer the pool's.
    const v = stakeState(validatorAcct);
    if (v.tag === STAKE_STATE_STAKE && stakeIsUsableByPool(v, withdrawAuth.key, pool)) {
      const extra = saturatingSub(saturatingSub(validatorAcct.lamports, v.delegatedStake), validatorRent);
      if (extra > 0n) stakeWithdraw(stake, validatorAcct, withdrawAuth, poolAcct.key, bump, reserve, clock, history, extra);
      const status = u64(entry.status);
      require(status <= STATUS_DEACTIVATING_ALL, ProgramError.InvalidAccountData);
      if (status === STATUS_ACTIVE) active = validatorAcct.lamports;
      else if (status === STATUS_DEACTIVATING_VALIDATOR || status === STATUS_DEACTIVATING_ALL) {
        if (noMerge) active = validatorAcct.lamports;
        else if (stakeIsInactiveWithoutHistory(v, epoch)) {
          // Removed through the usual way: absorbed into the reserve.
          stakeMerge(stake, validatorAcct, withdrawAuth, poolAcct.key, bump, reserve, clock, history);
          entry.status = statusWithoutValidator(entry.status);
        } else active = validatorAcct.lamports;
      } else log("Validator stake account no longer part of the pool, ignoring");
    } else if (v.tag === STAKE_STATE_INITIALIZED && stakeIsUsableByPool(v, withdrawAuth.key, pool)) {
      // Destaked during a cluster restart, or removed: either way its lamports go to the reserve.
      stakeMerge(stake, validatorAcct, withdrawAuth, poolAcct.key, bump, reserve, clock, history);
      entry.status = u8(transient !== 0n ? STATUS_DEACTIVATING_TRANSIENT : STATUS_READY_FOR_REMOVAL);
    } else log("Validator stake account no longer part of the pool, ignoring");

    entry.lastUpdateEpoch = epoch;
    entry.activeStakeLamports = active;
    entry.transientStakeLamports = transient;
  }
}

/**
 * Tag 7: the pool's total from the reserve (past its rent) and every validator's active and transient lamports, all
 * updated this epoch. The manager's fee on the rewards is minted to the fee account (unless that account is no longer
 * a valid one); on the first update of an epoch the pending fees move one epoch on.
 */
export function updateStakePoolBalance(rest: RemainingAccounts): void {
  need(rest, 7n);
  const poolAcct = rest.get(0n);
  const withdrawAuth = rest.get(1n);
  const listAcct = rest.get(2n);
  const reserve = rest.get(3n);
  const managerFee = rest.get(4n);
  const mint = rest.get(5n);
  const tokenProgram = rest.get(6n);
  const epoch = currentEpoch();

  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkMint(pool, mint);
  checkAuthorityWithdraw(pool, withdrawAuth.key, poolAcct.key);
  checkReserveStake(pool, reserve);
  require(pool.managerFeeAccount === managerFee.key, StakePoolError.InvalidFeeAccount);
  require(listAcct.key === pool.validatorList, StakePoolError.InvalidValidatorStakeList);
  require(pool.tokenProgramId === tokenProgram.key, ProgramError.IncorrectProgramId);
  checkAccountOwner(listAcct, programId());
  checkListHeaderDecodes(listAcct);
  checkListHeaderValid(listAcct);
  const list = loadRaw<ValidatorList>(listAcct);

  const previousLamports = pool.totalLamports;
  const previousSupply = pool.poolTokenSupply;
  // Saturating: a reserve short of its rent (rent went up) counts as empty.
  let total = saturatingSub(reserve.lamports, minimumReserveLamports(rentExempt(reserve.dataLen)));
  for (const v of list.validators) {
    require(v.lastUpdateEpoch >= epoch, StakePoolError.StakeListOutOfDate);
    // stake_lamports(): active + transient, then the running total, each checked.
    require(v.activeStakeLamports <= U64_MAX - v.transientStakeLamports, StakePoolError.CalculationFailure);
    const lamports = v.activeStakeLamports + v.transientStakeLamports;
    require(total <= U64_MAX - lamports, StakePoolError.CalculationFailure);
    total += lamports;
  }
  const reward = saturatingSub(total, previousLamports);
  // A manager fee account that is no longer valid gets no fee (its problem is logged).
  const fee = managerFeeInfoProblem(pool, managerFee) === UNPACK_OK ? calcEpochFeeAmount(pool, reward) : 0n;
  if (fee > 0n) mintTokens(programAt<TokenInterface>(tokenProgram), mint, managerFee, withdrawAuth, poolAcct.key, pool.stakeWithdrawBumpSeed, fee);

  if (pool.lastUpdateEpoch < epoch) {
    // FutureEpoch::get (a value One epoch away is due), then update_epoch (Two -> One -> None).
    if (pool.nextEpochFee.kind === "One") {
      pool.epochFee = pool.nextEpochFee.fee;
      pool.nextEpochFee = { kind: "None" };
    } else if (pool.nextEpochFee.kind === "Two") pool.nextEpochFee = { kind: "One", fee: pool.nextEpochFee.fee };
    if (pool.nextStakeWithdrawalFee.kind === "One") {
      pool.stakeWithdrawalFee = pool.nextStakeWithdrawalFee.fee;
      pool.nextStakeWithdrawalFee = { kind: "None" };
    } else if (pool.nextStakeWithdrawalFee.kind === "Two") pool.nextStakeWithdrawalFee = { kind: "One", fee: pool.nextStakeWithdrawalFee.fee };
    if (pool.nextSolWithdrawalFee.kind === "One") {
      pool.solWithdrawalFee = pool.nextSolWithdrawalFee.fee;
      pool.nextSolWithdrawalFee = { kind: "None" };
    } else if (pool.nextSolWithdrawalFee.kind === "Two") pool.nextSolWithdrawalFee = { kind: "One", fee: pool.nextSolWithdrawalFee.fee };
    pool.lastUpdateEpoch = epoch;
    pool.lastEpochTotalLamports = previousLamports;
    pool.lastEpochPoolTokenSupply = previousSupply;
  }
  pool.totalLamports = total;
  // The supply as the mint has it now (after the fee was minted).
  unpackMint(mint);
  pool.poolTokenSupply = readData<u64>(mint, 36n);
  storeBorsh(poolAcct, pool);
}
