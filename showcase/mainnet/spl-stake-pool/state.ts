// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// The accounts (state.rs, big_vec.rs) and the Stake program's account as the pool reads it. Neither of the pool's own
// accounts has a discriminator. The StakePool is Borsh, read with `try_from_slice_unchecked` and written with
// `borsh::to_writer`: here loadBorsh / storeBorsh, which read from byte 0, ignore what follows the value and leave the
// bytes after a shorter value as they were. The ValidatorList is a 5-byte header and a BigVec of 73-byte packed
// ValidatorStakeInfo records over the rest of a preallocated account, read in place with loadRaw / loadRawMut.
import { type BigVec, type Option, type Pubkey, type i64, type u8, type u32, type u64 } from "typesol";

/** AccountType: the first byte of both pool accounts. */
export enum AccountType {
  Uninitialized,
  StakePool,
  ValidatorList,
}

/** solana_stake_interface::state::Lockup, as the pool stores it (and requires of every stake account it manages). */
export interface Lockup {
  unixTimestamp: i64;
  epoch: u64;
  custodian: Pubkey;
}

/** A fee as a ratio; a denominator of 0 is no fee. Note the order: denominator first. */
export interface Fee {
  denominator: u64;
  numerator: u64;
}

/** FutureEpoch<Fee>: a fee that takes effect after one or two epoch boundaries (Borsh-compatible with an Option). */
export type FutureEpochFee = { kind: "None" } | { kind: "One"; fee: Fee } | { kind: "Two"; fee: Fee };

/** The pool (611 bytes when every Option is Some and every FutureEpoch is One or Two; the account is that size). */
export interface StakePool {
  accountType: AccountType;
  /** Manager authority: changes the staker, the manager, the fee account and the fees. */
  manager: Pubkey;
  /** Staker authority: adds and removes validators and moves stake between them. */
  staker: Pubkey;
  /** Signs stake deposits; by default the pool's PDA [pool, "deposit"], which makes deposits permissionless. */
  stakeDepositAuthority: Pubkey;
  /** The bump of the withdraw authority [pool, "withdraw"]. */
  stakeWithdrawBumpSeed: u8;
  validatorList: Pubkey;
  reserveStake: Pubkey;
  poolMint: Pubkey;
  managerFeeAccount: Pubkey;
  tokenProgramId: Pubkey;
  /** Lamports under management, as of `lastUpdateEpoch`. */
  totalLamports: u64;
  poolTokenSupply: u64;
  lastUpdateEpoch: u64;
  lockup: Lockup;
  /** Taken from each epoch's rewards. */
  epochFee: Fee;
  nextEpochFee: FutureEpochFee;
  preferredDepositValidatorVoteAddress: Option<Pubkey>;
  preferredWithdrawValidatorVoteAddress: Option<Pubkey>;
  stakeDepositFee: Fee;
  stakeWithdrawalFee: Fee;
  nextStakeWithdrawalFee: FutureEpochFee;
  /** Percentage (0-100) of the stake deposit fee paid to the referrer. */
  stakeReferralFee: u8;
  /** When set, SOL deposits must be signed by it. */
  solDepositAuthority: Option<Pubkey>;
  solDepositFee: Fee;
  solReferralFee: u8;
  /** When set, SOL withdrawals must be signed by it. */
  solWithdrawAuthority: Option<Pubkey>;
  solWithdrawalFee: Fee;
  nextSolWithdrawalFee: FutureEpochFee;
  /** The previous epoch's totals, for APR estimates only. */
  lastEpochPoolTokenSupply: u64;
  lastEpochTotalLamports: u64;
}

/** StakeStatus, stored as a byte (PodStakeStatus). */
export const STATUS_ACTIVE = 0n;
/** Only the transient stake account is left, deactivating, after a removal. */
export const STATUS_DEACTIVATING_TRANSIENT = 1n;
/** No stake account left: the entry goes at the next CleanupRemovedValidatorEntries. */
export const STATUS_READY_FOR_REMOVAL = 2n;
/** Only the validator stake account is deactivating (no transient stake). */
export const STATUS_DEACTIVATING_VALIDATOR = 3n;
/** Both the validator and the transient stake accounts are deactivating. */
export const STATUS_DEACTIVATING_ALL = 4n;

/** One validator of the pool: 73 bytes, packed (bytemuck Pod), the order fixed. */
export interface ValidatorStakeInfo {
  /** Lamports on the validator stake account, rent included, as of `lastUpdateEpoch`. */
  activeStakeLamports: u64;
  /** Lamports on the transient stake account, as of `lastUpdateEpoch`. */
  transientStakeLamports: u64;
  lastUpdateEpoch: u64;
  /** Seed suffix of the transient stake account's address. */
  transientSeedSuffix: u64;
  unused: u32;
  /** Seed suffix of the validator stake account's address (0: none, the address has no third seed). */
  validatorSeedSuffix: u32;
  status: u8;
  voteAccountAddress: Pubkey;
}

/** The validator list: header (account type, capacity the pool was made with), then the BigVec. */
export interface ValidatorList {
  accountType: u8;
  maxValidators: u32;
  validators: BigVec<ValidatorStakeInfo>;
}

/** The header's size and an entry's size (ValidatorListHeader::LEN, ValidatorStakeInfo::LEN). */
export const VALIDATOR_LIST_HEADER_LEN = 5n;
export const VALIDATOR_STAKE_INFO_LEN = 73n;

// The Stake program's account, StakeStateV2 (solana-stake-interface): Borsh with a u32 tag (0 Uninitialized,
// 1 Initialized(Meta), 2 Stake(Meta, Stake, StakeFlags), 3 RewardsPool). TypeSOL's data enums carry a u8 tag and its
// account views check the owner, so util.ts reads it with readData at these offsets (stakeState()).
export const STAKE_STATE_UNINITIALIZED = 0n;
export const STAKE_STATE_INITIALIZED = 1n;
export const STAKE_STATE_STAKE = 2n;
export const STAKE_STATE_REWARDS_POOL = 3n;
/** Meta: rent_exempt_reserve u64, Authorized { staker, withdrawer }, Lockup { unix_timestamp, epoch, custodian }. */
export const META_STAKER = 12n;
export const META_WITHDRAWER = 44n;
export const META_LOCKUP_UNIX_TIMESTAMP = 76n;
export const META_LOCKUP_EPOCH = 84n;
export const META_LOCKUP_CUSTODIAN = 92n;
/** Stake: Delegation { voter_pubkey, stake, activation_epoch, deactivation_epoch, warmup_cooldown_rate f64 }, credits_observed. */
export const STAKE_VOTER = 124n;
export const STAKE_DELEGATED = 156n;
export const STAKE_ACTIVATION_EPOCH = 164n;
export const STAKE_DEACTIVATION_EPOCH = 172n;
export const STAKE_WARMUP_RATE = 180n;
/** Bytes each variant needs to decode: the tag, Meta (120), Stake (72), StakeFlags (1). */
export const STAKE_STATE_TAG_LEN = 4n;
export const STAKE_STATE_INITIALIZED_LEN = 124n;
export const STAKE_STATE_STAKE_LEN = 197n;
/** std::mem::size_of::<StakeStateV2>(), the space of a stake account the pool creates. */
export const STAKE_ACCOUNT_SPACE = 200n;

/** What the pool reads of a StakeStateV2 (the variant, then Meta's and the Delegation's fields when present). */
export interface StakeState {
  /** STAKE_STATE_*, or INVALID_STAKE_STATE when the bytes do not decode (try_from_slice_unchecked fails). */
  tag: u64;
  staker: Pubkey;
  withdrawer: Pubkey;
  lockupUnixTimestamp: i64;
  lockupEpoch: u64;
  lockupCustodian: Pubkey;
  voter: Pubkey;
  delegatedStake: u64;
  activationEpoch: u64;
  deactivationEpoch: u64;
}
export const INVALID_STAKE_STATE = 255n;
