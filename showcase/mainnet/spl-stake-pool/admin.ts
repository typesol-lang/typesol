// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// Creating a pool and managing it (processor.rs): Initialize, SetManager, SetFee, SetStaker, SetFundingAuthority,
// SetPreferredValidator. Each reads the StakePool with loadBorsh after the original's owner check and writes it back
// with storeBorsh, which (as `borsh::to_writer`) leaves the bytes after a shorter encoding as they were: an Option
// set to None leaves its old key behind it.
import {
  type Pubkey,
  type RemainingAccounts,
  type TokenInterface,
  type u8,
  type u32,
  ProgramError,
  currentEpoch,
  findProgramAddressBump,
  createProgramAddress,
  loadBorsh,
  loadRawMut,
  loadRaw,
  log,
  programAt,
  programId,
  readData,
  rentExempt,
  require,
  storeBorsh,
  u64,
} from "typesol";
import { StakePoolError } from "./errors.js";
import {
  type Fee,
  type StakePool,
  type ValidatorList,
  AccountType,
  STAKE_STATE_INITIALIZED,
  STATUS_ACTIVE,
  VALIDATOR_STAKE_INFO_LEN,
  INVALID_STAKE_STATE,
} from "./state.js";
import {
  AUTHORITY_WITHDRAW,
  AUTH_OK,
  DEFAULT_PUBKEY,
  MAX_VALIDATORS_IN_POOL,
  NATIVE_DECIMALS,
  STAKE_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  checkAccountOwner,
  checkListHeaderDecodes,
  checkListHeaderValid,
  checkManager,
  checkManagerFeeInfo,
  checkStaker,
  checkValidatorList,
  checkWithdrawalFee,
  depositAuthority,
  extensionName,
  extensionsValid,
  firstUnsupportedExtension,
  managerProblem,
  minimumReserveLamports,
  mintTokens,
  need,
  stakeState,
  stakerProblem,
  unpackMint,
} from "./util.js";

/** Tag 0: make a pool of an allocated pool account and validator list, a reserve stake account and a pool mint. */
export function initialize(rest: RemainingAccounts, epochFee: Fee, withdrawalFee: Fee, depositFee: Fee, referralFee: u8, maxValidators: u32): void {
  need(rest, 9n);
  const poolAcct = rest.get(0n);
  const manager = rest.get(1n);
  const staker = rest.get(2n);
  const withdrawAuth = rest.get(3n);
  const listAcct = rest.get(4n);
  const reserve = rest.get(5n);
  const mint = rest.get(6n);
  const managerFee = rest.get(7n);
  const tokenProgram = rest.get(8n);

  if (!manager.isSigner) {
    log("Manager did not sign initialization");
    require(false, StakePoolError.SignatureMissing);
  }
  if (poolAcct.key === listAcct.key) {
    log("Cannot use same account for stake pool and validator list");
    require(false, StakePoolError.AlreadyInUse);
  }
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  if (pool.accountType !== AccountType.Uninitialized) {
    log("Provided stake pool already in use");
    require(false, StakePoolError.AlreadyInUse);
  }
  checkAccountOwner(listAcct, programId());
  // try_from_slice_unchecked::<ValidatorList>: the header, then a Borsh Vec of `len` 73-byte entries in the data.
  checkListHeaderDecodes(listAcct);
  const listLen = listAcct.dataLen;
  require(listLen >= 9n, ProgramError.BorshIoError);
  require(u64(readData<u32>(listAcct, 5n)) <= (listLen - 9n) / VALIDATOR_STAKE_INFO_LEN, ProgramError.BorshIoError);
  if (readData<u8>(listAcct, 0n) !== 0n) {
    log("Provided validator list already in use");
    require(false, StakePoolError.AlreadyInUse);
  }
  // ValidatorList::calculate_max_validators
  const expectedMax = listLen > 9n ? (listLen - 9n) / VALIDATOR_STAKE_INFO_LEN : 0n;
  if (expectedMax !== u64(maxValidators) || maxValidators === 0n) {
    log(`Incorrect validator list size provided, expected ${expectedMax}, provided ${maxValidators}`);
    require(false, StakePoolError.UnexpectedValidatorListAccountSize);
  }
  require(u64(maxValidators) <= MAX_VALIDATORS_IN_POOL, StakePoolError.TooManyValidatorsInPool);
  if (poolAcct.lamports < rentExempt(poolAcct.dataLen)) {
    log("Stake pool not rent-exempt");
    require(false, ProgramError.AccountNotRentExempt);
  }
  if (listAcct.lamports < rentExempt(listLen)) {
    log("Validator stake list not rent-exempt");
    require(false, ProgramError.AccountNotRentExempt);
  }
  // Each fee at most 1, the referral share at most 100%.
  require(epochFee.numerator <= epochFee.denominator &&
    withdrawalFee.numerator <= withdrawalFee.denominator &&
    depositFee.numerator <= depositFee.denominator &&
    referralFee <= 100n, StakePoolError.FeeTooHigh);
  // check_spl_token_program_account, then the mint must be that program's.
  require(tokenProgram.key === TOKEN_PROGRAM_ID || tokenProgram.key === TOKEN_2022_PROGRAM_ID, ProgramError.IncorrectProgramId);
  require(mint.owner === tokenProgram.key, ProgramError.IncorrectProgramId);
  pool.tokenProgramId = tokenProgram.key;
  pool.poolMint = mint.key;

  // The optional tenth account is a deposit authority that must sign every deposit; without one, deposits are
  // permissionless (the [pool, "deposit"] PDA, which nobody can sign for outside the program).
  const custom = rest.length >= 10n;
  const stakeDepositAuthority = custom ? rest.get(9n).key : depositAuthority(poolAcct.key);
  const bump = findProgramAddressBump([poolAcct.key, AUTHORITY_WITHDRAW], programId());
  const withdrawKey = createProgramAddress([poolAcct.key, AUTHORITY_WITHDRAW, bump], programId())!;
  if (withdrawKey !== withdrawAuth.key) {
    log(`Incorrect withdraw authority provided, expected ${withdrawKey}, received ${withdrawAuth.key}`);
    require(false, StakePoolError.InvalidProgramAddress);
  }

  // The pool mint: empty, 9 decimals, minted by the withdraw authority only, no freeze authority, and only extensions
  // that cannot hold pool tokens hostage.
  unpackMint(mint);
  require(readData<u64>(mint, 36n) === 0n, StakePoolError.NonZeroPoolTokenSupply);
  require(u64(readData<u8>(mint, 44n)) === NATIVE_DECIMALS, StakePoolError.IncorrectMintDecimals);
  require(readData<u32>(mint, 0n) === 1n && readData<Pubkey>(mint, 4n) === withdrawKey, StakePoolError.WrongMintingAuthority);
  require(readData<u32>(mint, 46n) === 0n, StakePoolError.InvalidMintFreezeAuthority);
  require(extensionsValid(mint), ProgramError.InvalidAccountData);
  const unsupported = firstUnsupportedExtension(mint, true);
  if (unsupported !== 0n) {
    log(`Stake pool mint account cannot have the ${extensionName(unsupported)} extension`);
    require(false, StakePoolError.UnsupportedMintExtension);
  }
  checkManagerFeeInfo(pool, managerFee);

  // The reserve: an initialized (undelegated) stake account of the withdraw authority, no lockup. What it holds past
  // its rent is the pool's first lamports, minted 1:1 to the manager's fee account.
  if (reserve.owner !== STAKE_PROGRAM_ID) {
    log("Reserve stake account not owned by stake program");
    require(false, ProgramError.IncorrectProgramId);
  }
  const reserveRent = rentExempt(reserve.dataLen);
  const r = stakeState(reserve);
  require(r.tag !== INVALID_STAKE_STATE, ProgramError.BorshIoError);
  if (r.tag !== STAKE_STATE_INITIALIZED) {
    log("Reserve stake account not in intialized state");
    require(false, StakePoolError.WrongStakeStake);
  }
  if (r.lockupUnixTimestamp !== 0n || r.lockupEpoch !== 0n || r.lockupCustodian !== DEFAULT_PUBKEY) {
    log("Reserve stake account has some lockup");
    require(false, StakePoolError.WrongStakeStake);
  }
  if (r.staker !== withdrawKey) {
    log(`Reserve stake account has incorrect staker ${r.staker}, should be ${withdrawKey}`);
    require(false, StakePoolError.WrongStakeStake);
  }
  if (r.withdrawer !== withdrawKey) {
    // (The original prints the staker here.)
    log(`Reserve stake account has incorrect withdrawer ${r.staker}, should be ${withdrawKey}`);
    require(false, StakePoolError.WrongStakeStake);
  }
  const reserveMinimum = minimumReserveLamports(reserveRent);
  require(reserve.lamports >= reserveMinimum, StakePoolError.CalculationFailure);
  const totalLamports = reserve.lamports - reserveMinimum;
  if (totalLamports > 0n) mintTokens(programAt<TokenInterface>(tokenProgram), mint, managerFee, withdrawAuth, poolAcct.key, bump, totalLamports);

  // The list: its header, no entries (borsh::to_writer of an empty ValidatorList; the rest is left as it was).
  const list = loadRawMut<ValidatorList>(listAcct);
  list.accountType = 2n;
  list.maxValidators = maxValidators;
  list.validators.retain(() => false);

  pool.accountType = AccountType.StakePool;
  pool.manager = manager.key;
  pool.staker = staker.key;
  pool.stakeDepositAuthority = stakeDepositAuthority;
  pool.stakeWithdrawBumpSeed = bump;
  pool.validatorList = listAcct.key;
  pool.reserveStake = reserve.key;
  pool.managerFeeAccount = managerFee.key;
  pool.totalLamports = totalLamports;
  pool.poolTokenSupply = totalLamports;
  pool.lastUpdateEpoch = currentEpoch();
  pool.lockup = { unixTimestamp: 0n, epoch: 0n, custodian: DEFAULT_PUBKEY };
  pool.epochFee = epochFee;
  pool.nextEpochFee = { kind: "None" };
  pool.preferredDepositValidatorVoteAddress = null;
  pool.preferredWithdrawValidatorVoteAddress = null;
  pool.stakeDepositFee = depositFee;
  pool.stakeWithdrawalFee = withdrawalFee;
  pool.nextStakeWithdrawalFee = { kind: "None" };
  pool.stakeReferralFee = referralFee;
  pool.solDepositAuthority = custom ? stakeDepositAuthority : null;
  pool.solDepositFee = depositFee;
  pool.solReferralFee = referralFee;
  pool.solWithdrawAuthority = null;
  pool.solWithdrawalFee = withdrawalFee;
  pool.nextSolWithdrawalFee = { kind: "None" };
  pool.lastEpochPoolTokenSupply = 0n;
  pool.lastEpochTotalLamports = 0n;
  storeBorsh(poolAcct, pool);
}

/** Tag 11: a new manager (both sign) and a new fee account. */
export function setManager(rest: RemainingAccounts): void {
  need(rest, 4n);
  const poolAcct = rest.get(0n);
  const manager = rest.get(1n);
  const newManager = rest.get(2n);
  const newFee = rest.get(3n);
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  checkAccountOwner(newFee, pool.tokenProgramId);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkManager(pool, manager);
  if (!newManager.isSigner) {
    log("New manager signature missing");
    require(false, StakePoolError.SignatureMissing);
  }
  checkManagerFeeInfo(pool, newFee);
  pool.manager = newManager.key;
  pool.managerFeeAccount = newFee.key;
  storeBorsh(poolAcct, pool);
}

/** FeeType's variants (instruction.rs order). */
const FEE_SOL_REFERRAL = 0n;
const FEE_STAKE_REFERRAL = 1n;
const FEE_EPOCH = 2n;
const FEE_STAKE_WITHDRAWAL = 3n;
const FEE_SOL_DEPOSIT = 4n;
const FEE_STAKE_DEPOSIT = 5n;
const FEE_SOL_WITHDRAWAL = 6n;

/** FeeType's Debug name. */
function feeTypeName(kind: u8): string {
  if (kind === FEE_SOL_REFERRAL) return "SolReferral";
  if (kind === FEE_STAKE_REFERRAL) return "StakeReferral";
  if (kind === FEE_EPOCH) return "Epoch";
  if (kind === FEE_STAKE_WITHDRAWAL) return "StakeWithdrawal";
  if (kind === FEE_SOL_DEPOSIT) return "SolDeposit";
  if (kind === FEE_STAKE_DEPOSIT) return "StakeDeposit";
  return "SolWithdrawal";
}

/**
 * Tag 12: one fee (FeeType: a referral percentage, or a Fee). The epoch fee and the withdrawal fees take effect two
 * epoch boundaries later (FutureEpoch::Two), and only on an up-to-date pool; the withdrawal fees may rise only so fast
 * (Fee::check_withdrawal). The others apply at once.
 */
export function setFee(rest: RemainingAccounts, kind: u8, percent: u8, denominator: u64, numerator: u64): void {
  need(rest, 2n);
  const poolAcct = rest.get(0n);
  const manager = rest.get(1n);
  const epoch = currentEpoch();
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkManager(pool, manager);
  // FeeType::can_only_change_next_epoch
  const later = kind === FEE_EPOCH || kind === FEE_STAKE_WITHDRAWAL || kind === FEE_SOL_WITHDRAWAL;
  require(!later || pool.lastUpdateEpoch >= epoch, StakePoolError.StakeListAndPoolOutOfDate);
  // FeeType::check_too_high, which logs the FeeType's Debug form.
  const referral = kind === FEE_SOL_REFERRAL || kind === FEE_STAKE_REFERRAL;
  if (referral ? percent > 100n : numerator > denominator) {
    if (referral) log(`Fee greater than 100%: ${feeTypeName(kind)}(${percent})`);
    else log(`Fee greater than 100%: ${feeTypeName(kind)}(Fee { denominator: ${denominator}, numerator: ${numerator} })`);
    require(false, StakePoolError.FeeTooHigh);
  }
  // StakePool::update_fee
  const fee: Fee = { denominator, numerator };
  if (kind === FEE_SOL_REFERRAL) pool.solReferralFee = percent;
  else if (kind === FEE_STAKE_REFERRAL) pool.stakeReferralFee = percent;
  else if (kind === FEE_EPOCH) pool.nextEpochFee = { kind: "Two", fee };
  else if (kind === FEE_STAKE_WITHDRAWAL) {
    checkWithdrawalFee(fee, pool.stakeWithdrawalFee);
    pool.nextStakeWithdrawalFee = { kind: "Two", fee };
  } else if (kind === FEE_SOL_WITHDRAWAL) {
    checkWithdrawalFee(fee, pool.solWithdrawalFee);
    pool.nextSolWithdrawalFee = { kind: "Two", fee };
  } else if (kind === FEE_SOL_DEPOSIT) pool.solDepositFee = fee;
  else pool.stakeDepositFee = fee;
  storeBorsh(poolAcct, pool);
}

/** Tag 13: a new staker, set by the manager or the staker (both checks run, and log, before either is decided on). */
export function setStaker(rest: RemainingAccounts): void {
  need(rest, 3n);
  const poolAcct = rest.get(0n);
  const authority = rest.get(1n);
  const newStaker = rest.get(2n);
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  const asStaker = stakerProblem(pool, authority);
  const asManager = managerProblem(pool, authority);
  require(asStaker === AUTH_OK || asManager === AUTH_OK, StakePoolError.SignatureMissing);
  pool.staker = newStaker.key;
  storeBorsh(poolAcct, pool);
}

/**
 * Tag 15: the stake deposit, SOL deposit or SOL withdraw authority (FundingType 0, 1, 2) becomes the optional third
 * account, or is removed without one (the stake deposit authority then falls back to the [pool, "deposit"] PDA).
 */
export function setFundingAuthority(rest: RemainingAccounts, fundingType: u8): void {
  need(rest, 2n);
  const poolAcct = rest.get(0n);
  const manager = rest.get(1n);
  const given = rest.length >= 3n;
  const newAuthority = given ? rest.get(2n).key : DEFAULT_PUBKEY;
  checkAccountOwner(poolAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkManager(pool, manager);
  if (fundingType === 0n) pool.stakeDepositAuthority = given ? newAuthority : depositAuthority(poolAcct.key);
  else if (fundingType === 1n) pool.solDepositAuthority = given ? newAuthority : null;
  else pool.solWithdrawAuthority = given ? newAuthority : null;
  storeBorsh(poolAcct, pool);
}

/**
 * Tag 5: deposits or withdrawals (`withdraw`) must go through this validator, or (`some` false) any. A validator
 * must be in the pool and active.
 */
export function setPreferredValidator(rest: RemainingAccounts, withdraw: boolean, some: boolean, vote: Pubkey): void {
  need(rest, 3n);
  const poolAcct = rest.get(0n);
  const staker = rest.get(1n);
  const listAcct = rest.get(2n);
  checkAccountOwner(poolAcct, programId());
  checkAccountOwner(listAcct, programId());
  const pool = loadBorsh<StakePool>(poolAcct);
  if (pool.accountType !== AccountType.StakePool) {
    log("Expected valid stake pool");
    require(false, StakePoolError.InvalidState);
  }
  checkStaker(pool, staker);
  checkValidatorList(pool, listAcct);
  checkListHeaderDecodes(listAcct);
  checkListHeaderValid(listAcct);
  const which = withdraw ? "Withdraw" : "Deposit";
  if (some) {
    const list = loadRaw<ValidatorList>(listAcct);
    const i = list.validators.findIndex((v) => v.voteAccountAddress === vote);
    if (i < 0n) {
      log(`Validator for ${which} not present in the stake pool, cannot set as preferred deposit account`);
      require(false, StakePoolError.ValidatorNotFound);
    }
    if (u64(list.validators.get(u64(i)).status) !== STATUS_ACTIVE) {
      log(`Validator for ${which} about to be removed, cannot set as preferred deposit account`);
      require(false, StakePoolError.InvalidPreferredValidator);
    }
  }
  if (withdraw) pool.preferredWithdrawValidatorVoteAddress = some ? vote : null;
  else pool.preferredDepositValidatorVoteAddress = some ? vote : null;
  storeBorsh(poolAcct, pool);
}
