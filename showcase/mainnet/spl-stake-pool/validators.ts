// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// The pool's validators (processor.rs): AddValidatorToPool creates the validator's stake account at its PDA from
// the reserve, RemoveValidatorFromPool deactivates it (UpdateValidatorListBalance merges it back into the reserve once
// it is inactive), CleanupRemovedValidatorEntries drops the entries left with nothing. The list is the ValidatorList
// BigVec, read in place.
import {
  type RemainingAccounts,
  type StakeProgram,
  type SystemProgram,
  type u32,
  ProgramError,
  currentEpoch,
  loadBorsh,
  loadRawMut,
  log,
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
import {
  type StakePool,
  type ValidatorList,
  AccountType,
  STAKE_ACCOUNT_SPACE,
  STAKE_STATE_STAKE,
  STATUS_ACTIVE,
  STATUS_DEACTIVATING_ALL,
  STATUS_DEACTIVATING_VALIDATOR,
  STATUS_READY_FOR_REMOVAL,
} from "./state.js";
import {
  CLOCK_SYSVAR_ID,
  MAX_VALIDATORS_IN_POOL,
  RENT_SYSVAR_ID,
  STAKE_PROGRAM_ID,
  checkAccountOwner,
  checkAuthorityWithdraw,
  checkListHeaderDecodes,
  checkListHeaderValid,
  checkNotTheList,
  checkReserveStake,
  checkStakeProgram,
  checkStaker,
  checkSystemProgram,
  checkSysvar,
  checkTransientStakeAddress,
  checkValidatorList,
  checkValidatorStakeAddress,
  delegatedStakeState,
  poolMinimumDelegation,
  minimumReserveLamports,
  need,
  notDeactivating,
  panicIfTheList,
  saturatingAdd,
  saturatingSub,
  stakeDeactivate,
  stakeDelegate,
  stakeSplit,
  stakeIsUsableByPool,
  stakeState,
  validatorStakeAddressAt,
  validatorStakeBump,
} from "./util.js";

/**
 * Tag 1: add the validator of `vote` (seed: the suffix of its stake account's address, 0 for none). Its stake account
 * is created at that PDA (allocate + assign, the PDA signing), split from the reserve with the minimum delegation and
 * rent, and delegated; the reserve must keep its own rent.
 */
export function addValidatorToPool(rest: RemainingAccounts, seed: u32): void {
  need(rest, 8n);
  checkSysvar(rest.get(7n), RENT_SYSVAR_ID);
  need(rest, 9n);
  checkSysvar(rest.get(8n), CLOCK_SYSVAR_ID);
  need(rest, 13n);
  const poolAcct = rest.get(0n);
  const staker = rest.get(1n);
  const reserve = rest.get(2n);
  const withdrawAuth = rest.get(3n);
  const listAcct = rest.get(4n);
  const stakeAcct = rest.get(5n);
  const vote = rest.get(6n);
  // The Clock, StakeHistory and stake config (accounts 8 to 10): named by address in the Stake CPIs, passed as those
  // accounts.
  const epoch = currentEpoch();

  checkSystemProgram(rest.get(11n));
  checkStakeProgram(rest.get(12n));
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkAuthorityWithdraw(pool, withdrawAuth.key, poolAcct.key);
  checkStaker(pool, staker);
  checkReserveStake(pool, reserve);
  checkValidatorList(pool, listAcct);
  require(pool.lastUpdateEpoch >= epoch, StakePoolError.StakeListAndPoolOutOfDate);

  checkAccountOwner(listAcct, programId());
  checkListHeaderDecodes(listAcct);
  const list = loadRawMut<ValidatorList>(listAcct);
  checkListHeaderValid(listAcct);
  const len = list.validators.length;
  require(u64(list.maxValidators) !== len, ProgramError.AccountDataTooSmall);
  require(len < MAX_VALIDATORS_IN_POOL, StakePoolError.TooManyValidatorsInPool);
  require(list.validators.findIndex((v) => v.voteAccountAddress === vote.key) < 0n, StakePoolError.ValidatorAlreadyAdded);

  const bump = validatorStakeBump(vote.key, poolAcct.key, seed);
  require(validatorStakeAddressAt(vote.key, poolAcct.key, seed, bump) === stakeAcct.key, StakePoolError.InvalidStakeAccountAddress);

  // Fund it with the minimum delegation plus its rent, from the reserve, which must stay rent-exempt.
  const stake = programAt<StakeProgram>(rest.get(12n));
  const required = saturatingAdd(poolMinimumDelegation(stake), rentExempt(STAKE_ACCOUNT_SPACE));
  const reserveMinimum = minimumReserveLamports(rentExempt(reserve.dataLen));
  const reserveLamports = reserve.lamports;
  if (saturatingSub(reserveLamports, required) < reserveMinimum) {
    const short = saturatingSub(saturatingAdd(required, reserveMinimum), reserveLamports);
    log(`Need to add ${short} lamports for the reserve stake to be rent-exempt after adding a validator, reserve currently has ${reserveLamports} lamports`);
    require(false, ProgramError.InsufficientFunds);
  }

  // create_stake_account: allocate and assign, signed by the stake account's own seeds (no lamports moved).
  const system = programAt<SystemProgram>(rest.get(11n));
  checkNotTheList(stakeAcct, listAcct);
  const stakeSeeds = seed === 0n ? signer([vote.key, poolAcct.key, bump]) : signer([vote.key, poolAcct.key, seed, bump]);
  system.allocate(stakeAcct, STAKE_ACCOUNT_SPACE, stakeSeeds);
  system.assign(stakeAcct, STAKE_PROGRAM_ID, stakeSeeds);
  const bumpSeed = pool.stakeWithdrawBumpSeed;
  stakeSplit(stake, reserve, withdrawAuth, poolAcct.key, bumpSeed, required, stakeAcct);
  // The vote account is only looked up in the list (not found, as the list is no vote account of it).
  checkNotTheList(vote, listAcct);
  stakeDelegate(stake, stakeAcct, vote, rest.get(8n), rest.get(9n), rest.get(10n), withdrawAuth, poolAcct.key, bumpSeed);

  list.validators.push({
    activeStakeLamports: required,
    transientStakeLamports: 0n,
    lastUpdateEpoch: epoch,
    transientSeedSuffix: 0n,
    unused: 0n,
    validatorSeedSuffix: seed,
    status: STATUS_ACTIVE,
    voteAccountAddress: vote.key,
  });
}

/**
 * Tag 2: mark the validator of this stake account for removal and deactivate its stake (and its transient stake, when
 * it has some that is still activating or active). A preferred validator that is removed is no longer preferred.
 */
export function removeValidatorFromPool(rest: RemainingAccounts): void {
  need(rest, 7n);
  checkSysvar(rest.get(6n), CLOCK_SYSVAR_ID);
  need(rest, 8n);
  const poolAcct = rest.get(0n);
  const staker = rest.get(1n);
  const withdrawAuth = rest.get(2n);
  const listAcct = rest.get(3n);
  const stakeAcct = rest.get(4n);
  const transientAcct = rest.get(5n);
  const epoch = currentEpoch();

  checkStakeProgram(rest.get(7n));
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkAuthorityWithdraw(pool, withdrawAuth.key, poolAcct.key);
  checkStaker(pool, staker);
  if (pool.lastUpdateEpoch < epoch) {
    log(`clock ${epoch} pool ${pool.lastUpdateEpoch}`);
    require(false, StakePoolError.StakeListAndPoolOutOfDate);
  }
  checkValidatorList(pool, listAcct);
  checkAccountOwner(listAcct, programId());
  checkListHeaderDecodes(listAcct);
  const list = loadRawMut<ValidatorList>(listAcct);
  checkListHeaderValid(listAcct);

  panicIfTheList(stakeAcct, listAcct);
  const s = delegatedStakeState(stakeAcct);
  const voteKey = s.voter;
  const i = list.validators.findIndex((v) => v.voteAccountAddress === voteKey);
  if (i < 0n) {
    log(`Vote account ${voteKey} not found in stake pool`);
    require(false, StakePoolError.ValidatorNotFound);
  }
  const entry = list.validators.get(u64(i));
  checkValidatorStakeAddress(poolAcct.key, stakeAcct.key, voteKey, entry.validatorSeedSuffix);
  if (u64(entry.status) !== STATUS_ACTIVE) {
    log("Validator is already marked for removal");
    require(false, StakePoolError.ValidatorNotFound);
  }

  const stake = programAt<StakeProgram>(rest.get(7n));
  let newStatus: u8 = u8(STATUS_DEACTIVATING_VALIDATOR);
  if (entry.transientStakeLamports > 0n) {
    checkTransientStakeAddress(poolAcct.key, transientAcct.key, voteKey, entry.transientSeedSuffix);
    const t = stakeState(transientAcct);
    if (t.tag === STAKE_STATE_STAKE && stakeIsUsableByPool(t, withdrawAuth.key, pool) && notDeactivating(t))
      stakeDeactivate(stake, transientAcct, rest.get(6n), withdrawAuth, poolAcct.key, pool.stakeWithdrawBumpSeed);
    newStatus = u8(STATUS_DEACTIVATING_ALL);
  }
  // A stake force-deactivated already (deactivate-delinquent) is not deactivated again.
  if (notDeactivating(s)) stakeDeactivate(stake, stakeAcct, rest.get(6n), withdrawAuth, poolAcct.key, pool.stakeWithdrawBumpSeed);
  entry.status = newStatus;

  const preferredDeposit = pool.preferredDepositValidatorVoteAddress;
  if (preferredDeposit !== null && preferredDeposit === voteKey) pool.preferredDepositValidatorVoteAddress = null;
  const preferredWithdraw = pool.preferredWithdrawValidatorVoteAddress;
  if (preferredWithdraw !== null && preferredWithdraw === voteKey) pool.preferredWithdrawValidatorVoteAddress = null;
  storeBorsh(poolAcct, pool);
}

/**
 * Tag 8: drop the entries of validators that are gone (ReadyForRemoval with nothing left). With the pool passed
 * writable, a preferred validator that is no longer in the list, or no longer active, stops being preferred (the
 * pool is written back in any case).
 */
export function cleanupRemovedValidatorEntries(rest: RemainingAccounts): void {
  need(rest, 2n);
  const poolAcct = rest.get(0n);
  const listAcct = rest.get(1n);
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkValidatorList(pool, listAcct);
  checkAccountOwner(listAcct, programId());
  checkListHeaderDecodes(listAcct);
  const list = loadRawMut<ValidatorList>(listAcct);
  checkListHeaderValid(listAcct);
  // ValidatorStakeInfo::is_removed: ReadyForRemoval, and no active or transient lamports.
  list.validators.retain((v) => !(u64(v.status) === STATUS_READY_FOR_REMOVAL && v.activeStakeLamports === 0n && v.transientStakeLamports === 0n));
  if (poolAcct.isWritable) {
    log("Checking preferred validators");
    const deposit = pool.preferredDepositValidatorVoteAddress;
    if (deposit !== null) {
      const i = list.validators.findIndex((v) => v.voteAccountAddress === deposit);
      if (i < 0n || u64(list.validators.get(u64(i)).status) !== STATUS_ACTIVE) {
        log(`Preferred deposit validator ${deposit} not found or not active, resetting`);
        pool.preferredDepositValidatorVoteAddress = null;
      }
    }
    const withdraw = pool.preferredWithdrawValidatorVoteAddress;
    if (withdraw !== null) {
      const i = list.validators.findIndex((v) => v.voteAccountAddress === withdraw);
      if (i < 0n || u64(list.validators.get(u64(i)).status) !== STATUS_ACTIVE) {
        log(`Preferred withdrawal validator ${withdraw} not found or not active, resetting`);
        pool.preferredWithdrawValidatorVoteAddress = null;
      }
    }
    storeBorsh(poolAcct, pool);
  }
}
