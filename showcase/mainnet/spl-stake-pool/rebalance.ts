// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// Moving stake between the reserve and the validators (processor.rs process_increase_validator_stake,
// process_decrease_validator_stake): IncreaseValidatorStake (4), IncreaseAdditionalValidatorStake (19),
// DecreaseValidatorStake (3), DecreaseValidatorStakeWithReserve (21), DecreaseAdditionalValidatorStake (20).
//
// An increase splits lamports (plus a stake account's rent) off the reserve into the validator's transient stake
// account and delegates it; UpdateValidatorListBalance merges it into the validator stake once both are active. A
// decrease splits lamports off the validator stake into the transient stake account and deactivates it; the update
// merges it into the reserve once it is inactive. A validator has one transient stake account at a time: the
// "Additional" forms add to it in the epoch it was made, through an ephemeral stake account that is split off (and
// delegated or deactivated) first, then merged into it.
//
// The validator list is loaded where the original borrows it mutably and written through its entry at the end. The
// original holds that borrow throughout, so a client that passes the list again in another slot meets a check or a
// panic first (the panics are ported at the original's locations, util.ts), never the end. A list passed read-only is
// written all the same and the runtime refuses it at the end (ReadonlyDataModified), as the original's.
import {
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type StakeProgram,
  type SystemProgram,
  type u8,
  ProgramError,
  createProgramAddress,
  currentEpoch,
  findProgramAddressBump,
  loadBorsh,
  loadRawMut,
  log,
  programAt,
  programId,
  rentExempt,
  require,
  signer,
  u64,
} from "typesol";
import { StakePoolError } from "./errors.js";
import { type StakePool, type ValidatorList, AccountType, INVALID_STAKE_STATE, STAKE_ACCOUNT_SPACE, STAKE_STATE_STAKE, STATUS_ACTIVE } from "./state.js";
import {
  CLOCK_SYSVAR_ID,
  EPHEMERAL_STAKE_SEED_PREFIX,
  RENT_SYSVAR_ID,
  STAKE_PROGRAM_ID,
  TRANSIENT_STAKE_SEED_PREFIX,
  U64_MAX,
  checkAccountOwner,
  checkAuthorityWithdraw,
  checkListHeaderDecodes,
  checkListHeaderValid,
  checkReserveStake,
  checkStakeProgram,
  checkStaker,
  checkSystemProgram,
  checkSysvar,
  checkValidatorList,
  checkValidatorStakeAccount,
  checkValidatorStakeAddress,
  dataLenPanicIfTheList,
  delegatedStakeState,
  minimumDelegation,
  minimumStakeLamports,
  need,
  notDeactivating,
  panicIfTheList,
  saturatingAdd,
  saturatingSub,
  stakeDeactivate,
  stakeDelegate,
  stakeMerge,
  stakeSplit,
  stakeState,
  stakeWithdraw,
} from "./util.js";

/**
 * Tags 4 and 19: move `lamports` from the reserve to the validator of the vote account given, through its transient
 * stake account (seed `transientSeed`), which gets `lamports` and a stake account's rent, delegated to the validator.
 * With `ephemeral` (IncreaseAdditionalValidatorStake) the lamports go through the ephemeral stake account of
 * `ephemeralSeed` first, which is delegated, then split into a new transient stake account or merged into the one
 * still activating from this epoch.
 */
export function increaseValidatorStake(rest: RemainingAccounts, lamports: u64, transientSeed: u64, ephemeral: boolean, ephemeralSeed: u64): void {
  // pool, staker, withdraw authority, list, reserve, [ephemeral], transient, validator stake, vote, clock, [rent],
  // stake history, stake config, system program, stake program: 14 accounts either way.
  const e: u64 = ephemeral ? 1n : 0n;
  need(rest, 9n + e);
  checkSysvar(rest.get(8n + e), CLOCK_SYSVAR_ID);
  if (!ephemeral) {
    // The legacy instruction takes the Rent sysvar (Rent::from_account_info); the other reads it with Rent::get().
    need(rest, 10n);
    checkSysvar(rest.get(9n), RENT_SYSVAR_ID);
  }
  need(rest, 14n);
  const poolAcct = rest.get(0n);
  const staker = rest.get(1n);
  const withdrawAuth = rest.get(2n);
  const listAcct = rest.get(3n);
  const reserve = rest.get(4n);
  const transientAcct = rest.get(5n + e);
  const validatorAcct = rest.get(6n + e);
  const vote = rest.get(7n + e);
  // The Clock (also checked above), StakeHistory and stake config are named by address in the Stake CPIs.
  const epoch = currentEpoch();

  checkSystemProgram(rest.get(12n));
  checkStakeProgram(rest.get(13n));
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  checkPoolForRebalance(pool, poolAcct.key, withdrawAuth.key, staker, epoch);
  checkValidatorList(pool, listAcct);
  checkReserveStake(pool, reserve);
  checkAccountOwner(listAcct, programId());
  checkListHeaderDecodes(listAcct);
  const list = loadRawMut<ValidatorList>(listAcct);
  checkListHeaderValid(listAcct);

  const voteKey = vote.key;
  const i = list.validators.findIndex((v) => v.voteAccountAddress === voteKey);
  if (i < 0n) {
    log(`Vote account ${voteKey} not found in stake pool`);
    require(false, StakePoolError.ValidatorNotFound);
  }
  const entry = list.validators.get(u64(i));
  const hasTransient = entry.transientStakeLamports > 0n;
  if (hasTransient) {
    if (!ephemeral) {
      log("Attempting to increase stake on a validator with pending transient stake, use IncreaseAdditionalValidatorStake with the existing seed");
      require(false, StakePoolError.TransientAccountInUse);
    }
    checkTransientSeed(entry.transientSeedSuffix, transientSeed);
    // check_if_stake_activating: the transient stake was delegated in this epoch and is not deactivating.
    panicIfTheList(transientAcct, listAcct);
    const t = delegatedStakeState(transientAcct);
    if (!notDeactivating(t) || t.activationEpoch !== epoch) {
      log(`Existing stake ${transientAcct.key} delegated to ${voteKey} not activated in epoch ${epoch}`);
      require(false, StakePoolError.WrongStakeStake);
    }
  }
  checkValidatorStakeAccount(validatorAcct, poolAcct.key, withdrawAuth.key, voteKey, entry.validatorSeedSuffix, pool);
  if (u64(entry.status) !== STATUS_ACTIVE) {
    log("Validator is marked for removal and no longer allows increases");
    require(false, StakePoolError.ValidatorNotFound);
  }

  const stakeRent = rentExempt(STAKE_ACCOUNT_SPACE);
  const stake = programAt<StakeProgram>(rest.get(13n));
  const minimum = minimumDelegation(stake.getMinimumDelegation());
  if (lamports < minimum) {
    log(`Need more than ${minimum} lamports for transient stake to meet minimum delegation requirement, ${lamports} provided`);
    // ProgramError::Custom(StakeError::InsufficientDelegation as u32), 12: the entrypoint reads it as StakePoolError 12.
    require(false, StakePoolError.UserStakeNotActive);
  }
  // The transient stake account's rent comes back to the reserve when it is merged, so it takes `lamports + rent`.
  const total = saturatingAdd(lamports, stakeRent);
  const reserveLamports = reserve.lamports;
  if (saturatingSub(reserveLamports, total) < stakeRent) {
    log(
      `Reserve stake does not have enough lamports for increase, maximum amount ${saturatingSub(reserveLamports, saturatingAdd(stakeRent, stakeRent))}, ${lamports} requested`,
    );
    require(false, ProgramError.InsufficientFunds);
  }

  const system = programAt<SystemProgram>(rest.get(12n));
  const bump = pool.stakeWithdrawBumpSeed;
  if (ephemeral) {
    // The ephemeral stake account: split off the reserve and delegated.
    const ephemeralAcct = rest.get(5n);
    createEphemeralStake(system, ephemeralAcct, poolAcct.key, ephemeralSeed);
    stakeSplit(stake, reserve, withdrawAuth, poolAcct.key, bump, total, ephemeralAcct);
    stakeDelegate(stake, ephemeralAcct, vote, withdrawAuth, poolAcct.key, bump);
  }
  // The account the transient stake comes from: the ephemeral stake account, or the reserve.
  const source = ephemeral ? rest.get(5n) : reserve;
  const transientBump = checkedTransientStakeBump(transientAcct.key, voteKey, poolAcct.key, transientSeed);
  if (hasTransient) {
    // The transient stake exists (activating since this epoch): the ephemeral stake joins it.
    stakeMerge(stake, source, withdrawAuth, poolAcct.key, bump, transientAcct);
  } else {
    createTransientStake(system, transientAcct, voteKey, poolAcct.key, transientSeed, transientBump);
    stakeSplit(stake, source, withdrawAuth, poolAcct.key, bump, total, transientAcct);
    // Split off the reserve it is only initialized: delegate it. Split off a delegated ephemeral stake it is
    // activating already.
    const t = stakeState(transientAcct);
    require(t.tag !== INVALID_STAKE_STATE, ProgramError.BorshIoError);
    if (!(t.tag === STAKE_STATE_STAKE && t.activationEpoch <= epoch)) {
      stakeDelegate(stake, transientAcct, vote, withdrawAuth, poolAcct.key, bump);
    }
  }

  require(entry.transientStakeLamports <= U64_MAX - total, StakePoolError.CalculationFailure);
  entry.transientStakeLamports += total;
  entry.transientSeedSuffix = transientSeed;
}

/**
 * Tags 3, 20 and 21: move `lamports` off the validator stake account of the stake account given into its transient
 * stake account (seed `transientSeed`), deactivating. `fundRentFromReserve` (all but the deprecated
 * DecreaseValidatorStake): the reserve pays the new stake accounts' rent; without it nothing does, and the Stake
 * program only splits active stake into a transient account funded beforehand.
 * With `ephemeral` (DecreaseAdditionalValidatorStake) the lamports go through the ephemeral stake account of
 * `ephemeralSeed` first, which is deactivated, then split into a new transient stake account or merged into the one
 * still deactivating from this epoch.
 */
export function decreaseValidatorStake(
  rest: RemainingAccounts,
  lamports: u64,
  transientSeed: u64,
  ephemeral: boolean,
  ephemeralSeed: u64,
  fundRentFromReserve: boolean,
): void {
  // pool, staker, withdraw authority, list, [reserve], validator stake, [ephemeral], transient, clock, then the rent
  // sysvar (DecreaseValidatorStake) or the stake history, system program, stake program.
  const f: u64 = fundRentFromReserve ? 1n : 0n;
  const o = f + (ephemeral ? 1n : 0n);
  need(rest, 7n + o);
  checkSysvar(rest.get(6n + o), CLOCK_SYSVAR_ID);
  need(rest, 8n + o);
  if (!ephemeral && !fundRentFromReserve) checkSysvar(rest.get(7n), RENT_SYSVAR_ID);
  need(rest, 10n + o);
  const poolAcct = rest.get(0n);
  const staker = rest.get(1n);
  const withdrawAuth = rest.get(2n);
  const listAcct = rest.get(3n);
  const reserve = rest.get(4n); // when fundRentFromReserve
  const validatorAcct = rest.get(4n + f);
  const transientAcct = rest.get(5n + o);
  const epoch = currentEpoch();

  checkSystemProgram(rest.get(8n + o));
  checkStakeProgram(rest.get(9n + o));
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  checkPoolForRebalance(pool, poolAcct.key, withdrawAuth.key, staker, epoch);
  checkValidatorList(pool, listAcct);
  checkAccountOwner(listAcct, programId());
  checkListHeaderDecodes(listAcct);
  const list = loadRawMut<ValidatorList>(listAcct);
  checkListHeaderValid(listAcct);
  if (fundRentFromReserve) checkReserveStake(pool, reserve);

  // The validator is the one the stake account is delegated to (its owner and authorities are not checked: the
  // address is, and the Stake program checks the rest).
  dataLenPanicIfTheList(validatorAcct, listAcct);
  const validatorRent = rentExempt(validatorAcct.dataLen);
  const voteKey = delegatedStakeState(validatorAcct).voter;
  const i = list.validators.findIndex((v) => v.voteAccountAddress === voteKey);
  if (i < 0n) {
    log(`Vote account ${voteKey} not found in stake pool`);
    require(false, StakePoolError.ValidatorNotFound);
  }
  const entry = list.validators.get(u64(i));
  checkValidatorStakeAddress(poolAcct.key, validatorAcct.key, voteKey, entry.validatorSeedSuffix);
  const hasTransient = entry.transientStakeLamports > 0n;
  if (hasTransient) {
    if (!ephemeral) {
      log("Attempting to decrease stake on a validator with pending transient stake, use DecreaseAdditionalValidatorStake with the existing seed");
      require(false, StakePoolError.TransientAccountInUse);
    }
    checkTransientSeed(entry.transientSeedSuffix, transientSeed);
    // check_if_stake_deactivating: the transient stake was deactivated in this epoch.
    panicIfTheList(transientAcct, listAcct);
    if (delegatedStakeState(transientAcct).deactivationEpoch !== epoch) {
      log(`Existing stake ${transientAcct.key} delegated to ${voteKey} not deactivated in epoch ${epoch}`);
      require(false, StakePoolError.WrongStakeStake);
    }
  }
  if (u64(entry.status) !== STATUS_ACTIVE) {
    log("Validator is marked for removal and no longer allows decreases");
    require(false, StakePoolError.ValidatorNotFound);
  }

  const stakeRent = rentExempt(STAKE_ACCOUNT_SPACE);
  const stake = programAt<StakeProgram>(rest.get(9n + o));
  const stakeMinimum = stake.getMinimumDelegation();
  const minimum = minimumDelegation(stakeMinimum);
  if (lamports < minimum) {
    log(`Need at least ${minimum} lamports for transient stake to meet minimum delegation and rent-exempt requirements, ${lamports} provided`);
    require(false, ProgramError.AccountNotRentExempt);
  }
  // The validator stake keeps its rent and the minimum delegation.
  const validatorLamports = validatorAcct.lamports;
  require(lamports <= validatorLamports, ProgramError.InsufficientFunds);
  const required = minimumStakeLamports(validatorRent, stakeMinimum);
  if (validatorLamports - lamports < required) {
    // The message's last number is `lamports().checked_sub(required).ok_or(CalculationFailure)?`, taken first.
    require(required <= validatorLamports, StakePoolError.CalculationFailure);
    log(
      `Need at least ${required} lamports in the stake account after decrease, ${lamports} requested, ${validatorLamports - required} is the current possible maximum`,
    );
    require(false, ProgramError.InsufficientFunds);
  }

  const system = programAt<SystemProgram>(rest.get(8n + o));
  const bump = pool.stakeWithdrawBumpSeed;
  let splitLamports: u64 = lamports;
  if (ephemeral) {
    // The ephemeral stake account: its rent from the reserve, the lamports split off the validator stake, deactivated.
    const ephemeralAcct = rest.get(5n + f);
    createEphemeralStake(system, ephemeralAcct, poolAcct.key, ephemeralSeed);
    if (fundRentFromReserve) {
      const rentNeeded = saturatingSub(stakeRent, ephemeralAcct.lamports);
      if (rentNeeded > 0n) {
        require(rentNeeded < reserve.lamports, StakePoolError.ReserveDepleted);
        stakeWithdraw(stake, reserve, withdrawAuth, poolAcct.key, bump, ephemeralAcct, rentNeeded);
      }
    }
    stakeSplit(stake, validatorAcct, withdrawAuth, poolAcct.key, bump, lamports, ephemeralAcct);
    stakeDeactivate(stake, ephemeralAcct, withdrawAuth, poolAcct.key, bump);
    splitLamports = ephemeralAcct.lamports;
  }
  // The account the transient stake comes from: the ephemeral stake account, or the validator stake account.
  const source = ephemeral ? rest.get(5n + f) : validatorAcct;
  const transientBump = checkedTransientStakeBump(transientAcct.key, voteKey, poolAcct.key, transientSeed);
  if (hasTransient) {
    // The transient stake exists (deactivating since this epoch): the ephemeral stake joins it.
    stakeMerge(stake, source, withdrawAuth, poolAcct.key, bump, transientAcct);
  } else {
    createTransientStake(system, transientAcct, voteKey, poolAcct.key, transientSeed, transientBump);
    // Its rent from the reserve, unless the whole ephemeral stake moves over (and its rent with it).
    if (fundRentFromReserve) {
      const rentNeeded = saturatingSub(stakeRent, transientAcct.lamports);
      if (source.lamports !== splitLamports) {
        require(rentNeeded < reserve.lamports, StakePoolError.ReserveDepleted);
        if (rentNeeded > 0n) {
          stakeWithdraw(stake, reserve, withdrawAuth, poolAcct.key, bump, transientAcct, rentNeeded);
        }
      }
    }
    stakeSplit(stake, source, withdrawAuth, poolAcct.key, bump, splitLamports, transientAcct);
    // Split off the validator stake it is still active: deactivate it (off the ephemeral stake it is deactivating).
    if (notDeactivating(delegatedStakeState(transientAcct))) stakeDeactivate(stake, transientAcct, withdrawAuth, poolAcct.key, bump);
  }

  require(lamports <= entry.activeStakeLamports, StakePoolError.CalculationFailure);
  entry.activeStakeLamports -= lamports;
  entry.transientStakeLamports = transientAcct.lamports;
  entry.transientSeedSuffix = transientSeed;
}

/** What both check of the pool: a pool (logged), its withdraw authority, the staker signing, updated this epoch. */
function checkPoolForRebalance(pool: StakePool, poolKey: Pubkey, withdrawAuth: Pubkey, staker: RemainingAccount, epoch: u64): void {
  if (pool.accountType !== AccountType.StakePool) {
    log("Expected valid stake pool");
    require(false, StakePoolError.InvalidState);
  }
  checkAuthorityWithdraw(pool, withdrawAuth, poolKey);
  checkStaker(pool, staker);
  require(pool.lastUpdateEpoch >= epoch, StakePoolError.StakeListAndPoolOutOfDate);
}

/** A transient stake account in use is added to only with its own seed (InvalidSeeds). */
function checkTransientSeed(existing: u64, given: u64): void {
  if (given !== existing) {
    log(`Transient stake already exists with seed ${existing}, you must use that one`);
    require(false, ProgramError.InvalidSeeds);
  }
}

/**
 * check_transient_stake_address, returning the bump to sign with: ["transient", vote, pool, seed] must be the account
 * given (InvalidStakeAccountAddress, not logged).
 */
function checkedTransientStakeBump(account: Pubkey, vote: Pubkey, poolKey: Pubkey, seed: u64): u8 {
  const bump = findProgramAddressBump([TRANSIENT_STAKE_SEED_PREFIX, vote, poolKey, seed], programId());
  require(createProgramAddress([TRANSIENT_STAKE_SEED_PREFIX, vote, poolKey, seed, bump], programId()) === account, StakePoolError.InvalidStakeAccountAddress);
  return bump;
}

/**
 * check_ephemeral_stake_address (["ephemeral", pool, seed], InvalidStakeAccountAddress), then create_stake_account:
 * allocate and assign to the Stake program, signed by the account's own seeds (no lamports moved).
 */
function createEphemeralStake(system: SystemProgram, account: RemainingAccount, poolKey: Pubkey, seed: u64): void {
  const bump = findProgramAddressBump([EPHEMERAL_STAKE_SEED_PREFIX, poolKey, seed], programId());
  require(createProgramAddress([EPHEMERAL_STAKE_SEED_PREFIX, poolKey, seed, bump], programId()) === account.key, StakePoolError.InvalidStakeAccountAddress);
  const seeds = signer([EPHEMERAL_STAKE_SEED_PREFIX, poolKey, seed, bump]);
  system.allocate(account, STAKE_ACCOUNT_SPACE, seeds);
  system.assign(account, STAKE_PROGRAM_ID, seeds);
}

/** create_stake_account for the transient stake account (its address checked already). */
function createTransientStake(system: SystemProgram, account: RemainingAccount, vote: Pubkey, poolKey: Pubkey, seed: u64, bump: u8): void {
  const seeds = signer([TRANSIENT_STAKE_SEED_PREFIX, vote, poolKey, seed, bump]);
  system.allocate(account, STAKE_ACCOUNT_SPACE, seeds);
  system.assign(account, STAKE_PROGRAM_ID, seeds);
}
