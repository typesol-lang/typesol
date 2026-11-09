// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// What more than one instruction uses: the PDAs (lib.rs), the account checks of processor.rs and of StakePool's
// methods (state.rs) with their log lines, the pool-token arithmetic, the reads of a Stake-program account and of SPL
// Token / Token-2022 accounts (spl-token-2022's StateWithExtensions::unpack), and the CPIs the pool signs.
//
// The Rust returns `Result`s and `Option`s that its callers turn into errors with `?` and `.ok_or(CalculationFailure)`.
// Where every caller fails on the error, the helper fails itself, at the same point. Where some caller only tests
// it (`.is_err()`), the helper returns what went wrong and the caller decides.
import {
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenInterface,
  type StakeProgram,
  type u16,
  type u32,
  type i64,
  ProgramError,
  createProgramAddress,
  findProgramAddress,
  findProgramAddressBump,
  log,
  max,
  named,
  panic,
  programId,
  pubkey,
  readData,
  require,
  u128,
  u64,
  u8,
} from "typesol";
import { StakePoolError } from "./errors.js";
import {
  type Fee,
  type StakePool,
  type StakeState,
  INVALID_STAKE_STATE,
  META_LOCKUP_CUSTODIAN,
  META_LOCKUP_EPOCH,
  META_LOCKUP_UNIX_TIMESTAMP,
  META_STAKER,
  META_WITHDRAWER,
  STAKE_ACTIVATION_EPOCH,
  STAKE_DEACTIVATION_EPOCH,
  STAKE_DELEGATED,
  STAKE_STATE_INITIALIZED,
  STAKE_STATE_INITIALIZED_LEN,
  STAKE_STATE_REWARDS_POOL,
  STAKE_STATE_STAKE,
  STAKE_STATE_STAKE_LEN,
  STAKE_STATE_TAG_LEN,
  STAKE_STATE_UNINITIALIZED,
  STAKE_VOTER,
  STAKE_WARMUP_RATE,
  STATUS_DEACTIVATING_ALL,
  STATUS_DEACTIVATING_TRANSIENT,
  STATUS_DEACTIVATING_VALIDATOR,
  STATUS_READY_FOR_REMOVAL,
  VALIDATOR_LIST_HEADER_LEN,
} from "./state.js";

export const SYSTEM_PROGRAM_ID = pubkey("11111111111111111111111111111111");
export const STAKE_PROGRAM_ID = pubkey("Stake11111111111111111111111111111111111111");
export const TOKEN_PROGRAM_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const CLOCK_SYSVAR_ID = pubkey("SysvarC1ock11111111111111111111111111111111");
export const RENT_SYSVAR_ID = pubkey("SysvarRent111111111111111111111111111111111");
export const STAKE_HISTORY_SYSVAR_ID = pubkey("SysvarStakeHistory1111111111111111111111111");
export const STAKE_CONFIG_ID = pubkey("StakeConfig11111111111111111111111111111111");
export const DEFAULT_PUBKEY = pubkey("11111111111111111111111111111111");

export const AUTHORITY_DEPOSIT = "deposit";
export const AUTHORITY_WITHDRAW = "withdraw";
export const TRANSIENT_STAKE_SEED_PREFIX = "transient";
export const EPHEMERAL_STAKE_SEED_PREFIX = "ephemeral";

/** lib.rs: a validator stake account keeps at least this much delegated, so merges never disagree on credits. */
export const MINIMUM_ACTIVE_STAKE = 1000000n;
/** lib.rs: the reserve keeps its rent-exempt reserve and this much more. */
export const MINIMUM_RESERVE_LAMPORTS = 0n;
export const MAX_VALIDATORS_IN_POOL = 20000n;
/** Native mint decimals (spl-token-2022 native_mint::DECIMALS): the pool token must have 9, as SOL. */
export const NATIVE_DECIMALS = 9n;

export const U64_MAX = 18446744073709551615n;
const U128_MAX = 340282366920938463463374607431768211455n;
const EPOCH_MAX = 18446744073709551615n;

// ---- Accounts by position ---------------------------------------------------------------------------------------

/** `next_account_info` past the end: NotEnoughAccountKeys, where the original reaches that account. */
export function need(rest: RemainingAccounts, n: u64): void {
  require(rest.length >= n, ProgramError.NotEnoughAccountKeys);
}

/** check_account_owner: owned by `owner`, else IncorrectProgramId. */
export function checkAccountOwner(a: RemainingAccount, owner: Pubkey): void {
  if (a.owner !== owner) {
    log(`Expected account to be owned by program ${owner}, received ${a.owner}`);
    require(false, ProgramError.IncorrectProgramId);
  }
}

/** check_system_program. */
export function checkSystemProgram(a: RemainingAccount): void {
  if (a.key !== SYSTEM_PROGRAM_ID) {
    log(`Expected system program ${SYSTEM_PROGRAM_ID}, received ${a.key}`);
    require(false, ProgramError.IncorrectProgramId);
  }
}

/** check_stake_program. */
export function checkStakeProgram(a: RemainingAccount): void {
  if (a.key !== STAKE_PROGRAM_ID) {
    log(`Expected stake program ${STAKE_PROGRAM_ID}, received ${a.key}`);
    require(false, ProgramError.IncorrectProgramId);
  }
}

/**
 * `Clock::from_account_info` / `Rent::from_account_info`: the sysvar's address, else InvalidArgument. The values are
 * then the same as the sysvar syscalls give (currentEpoch(), rentExempt()).
 */
export function checkSysvar(a: RemainingAccount, id: Pubkey): void {
  require(a.key === id, ProgramError.InvalidArgument);
}

// ---- Program addresses (lib.rs) -----------------------------------------------------------------------------------

/** find_withdraw_authority_program_address: [pool, "withdraw"]. */
export function withdrawAuthority(pool: Pubkey): Pubkey {
  return findProgramAddress([pool, AUTHORITY_WITHDRAW], programId());
}

/** find_deposit_authority_program_address: [pool, "deposit"]. */
export function depositAuthority(pool: Pubkey): Pubkey {
  return findProgramAddress([pool, AUTHORITY_DEPOSIT], programId());
}

/** find_stake_program_address: [vote, pool] and, for a seed other than 0 (NonZeroU32), its 4 bytes LE. */
export function validatorStakeAddress(vote: Pubkey, pool: Pubkey, seed: u32): Pubkey {
  if (seed === 0n) return findProgramAddress([vote, pool], programId());
  return findProgramAddress([vote, pool, seed], programId());
}

/** The bump of find_stake_program_address. */
export function validatorStakeBump(vote: Pubkey, pool: Pubkey, seed: u32): u8 {
  if (seed === 0n) return findProgramAddressBump([vote, pool], programId());
  return findProgramAddressBump([vote, pool, seed], programId());
}

/** The validator stake address for a bump found already (create_program_address: one hash, not a search). */
export function validatorStakeAddressAt(vote: Pubkey, pool: Pubkey, seed: u32, bump: u8): Pubkey {
  if (seed === 0n) return createProgramAddress([vote, pool, bump], programId())!;
  return createProgramAddress([vote, pool, seed, bump], programId())!;
}

/** find_transient_stake_program_address: ["transient", vote, pool, seed as 8 bytes LE]. */
export function transientStakeAddress(vote: Pubkey, pool: Pubkey, seed: u64): Pubkey {
  return findProgramAddress([TRANSIENT_STAKE_SEED_PREFIX, vote, pool, seed], programId());
}

/** find_ephemeral_stake_program_address: ["ephemeral", pool, seed as 8 bytes LE]. */
export function ephemeralStakeAddress(pool: Pubkey, seed: u64): Pubkey {
  return findProgramAddress([EPHEMERAL_STAKE_SEED_PREFIX, pool, seed], programId());
}

/**
 * check_validator_stake_address, as a test: whether `stake` is the validator stake account of `vote` (logging the
 * mismatch as the original does; UpdateValidatorListBalance skips such a pair, the others fail).
 */
export function isValidatorStakeAddress(pool: Pubkey, stake: Pubkey, vote: Pubkey, seed: u32): boolean {
  const expected = validatorStakeAddress(vote, pool, seed);
  if (expected !== stake) {
    log(`Incorrect stake account address for vote ${vote}, expected ${expected}, received ${stake}`);
    return false;
  }
  return true;
}

/** check_validator_stake_address: InvalidStakeAccountAddress. */
export function checkValidatorStakeAddress(pool: Pubkey, stake: Pubkey, vote: Pubkey, seed: u32): void {
  require(isValidatorStakeAddress(pool, stake, vote, seed), StakePoolError.InvalidStakeAccountAddress);
}

/** check_transient_stake_address, as a test (no log). */
export function isTransientStakeAddress(pool: Pubkey, stake: Pubkey, vote: Pubkey, seed: u64): boolean {
  return transientStakeAddress(vote, pool, seed) === stake;
}

/** check_transient_stake_address: InvalidStakeAccountAddress. */
export function checkTransientStakeAddress(pool: Pubkey, stake: Pubkey, vote: Pubkey, seed: u64): void {
  require(isTransientStakeAddress(pool, stake, vote, seed), StakePoolError.InvalidStakeAccountAddress);
}

// ---- StakePool's checks (state.rs) ----------------------------------------------------------------------------------

/**
 * check_authority_withdraw: create_program_address([pool, "withdraw", bump]) with the stored bump (InvalidSeeds when
 * it gives no address), which must be the account given.
 */
export function checkAuthorityWithdraw(pool: StakePool, authority: Pubkey, poolKey: Pubkey): void {
  const address = createProgramAddress([poolKey, AUTHORITY_WITHDRAW, pool.stakeWithdrawBumpSeed], programId());
  require(address !== null, ProgramError.InvalidSeeds);
  const expected: Pubkey = address!;
  if (expected !== authority) {
    log(`Incorrect authority provided, expected ${expected}, received ${authority}`);
    require(false, StakePoolError.InvalidProgramAddress);
  }
}

/** What check_manager / check_staker find wrong: 0 nothing, 1 another key, 2 no signature (both logged). */
export const AUTH_OK = 0n;
export const AUTH_WRONG_KEY = 1n;
export const AUTH_NOT_SIGNED = 2n;

/** check_manager, as a test (SetStaker accepts the manager or the staker, so it runs both). */
export function managerProblem(pool: StakePool, a: RemainingAccount): u64 {
  if (a.key !== pool.manager) {
    log(`Incorrect manager provided, expected ${pool.manager}, received ${a.key}`);
    return AUTH_WRONG_KEY;
  }
  if (!a.isSigner) {
    log("Manager signature missing");
    return AUTH_NOT_SIGNED;
  }
  return AUTH_OK;
}

/** check_manager: WrongManager, SignatureMissing. */
export function checkManager(pool: StakePool, a: RemainingAccount): void {
  const p = managerProblem(pool, a);
  require(p !== AUTH_WRONG_KEY, StakePoolError.WrongManager);
  require(p !== AUTH_NOT_SIGNED, StakePoolError.SignatureMissing);
}

/** check_staker, as a test. */
export function stakerProblem(pool: StakePool, a: RemainingAccount): u64 {
  if (a.key !== pool.staker) {
    log(`Incorrect staker provided, expected ${pool.staker}, received ${a.key}`);
    return AUTH_WRONG_KEY;
  }
  if (!a.isSigner) {
    log("Staker signature missing");
    return AUTH_NOT_SIGNED;
  }
  return AUTH_OK;
}

/** check_staker: WrongStaker, SignatureMissing. */
export function checkStaker(pool: StakePool, a: RemainingAccount): void {
  const p = stakerProblem(pool, a);
  require(p !== AUTH_WRONG_KEY, StakePoolError.WrongStaker);
  require(p !== AUTH_NOT_SIGNED, StakePoolError.SignatureMissing);
}

/** check_validator_list. */
export function checkValidatorList(pool: StakePool, a: RemainingAccount): void {
  if (a.key !== pool.validatorList) {
    log(`Invalid validator list provided, expected ${pool.validatorList}, received ${a.key}`);
    require(false, StakePoolError.InvalidValidatorStakeList);
  }
}

/** check_reserve_stake (InvalidProgramAddress, as the original has it). */
export function checkReserveStake(pool: StakePool, a: RemainingAccount): void {
  if (a.key !== pool.reserveStake) {
    log(`Invalid reserve stake provided, expected ${pool.reserveStake}, received ${a.key}`);
    require(false, StakePoolError.InvalidProgramAddress);
  }
}

/** check_mint: the pool's mint (WrongPoolMint), a valid mint (StateWithExtensions::<Mint>::unpack); its decimals. */
export function checkMint(pool: StakePool, a: RemainingAccount): u8 {
  require(a.key === pool.poolMint, StakePoolError.WrongPoolMint);
  unpackMint(a);
  return readData<u8>(a, 44n);
}

/**
 * check_sol_deposit_authority: when the pool has a SOL deposit authority, the optional account at `index`
 * (NotEnoughAccountKeys when it is missing) must be it, signing.
 */
export function checkSolDepositAuthority(pool: StakePool, rest: RemainingAccounts, index: u64): void {
  const auth = pool.solDepositAuthority;
  if (auth === null) return;
  need(rest, index + 1n);
  const a = rest.get(index);
  if (auth !== a.key) {
    log(`Expected ${auth}, received ${a.key}`);
    require(false, StakePoolError.InvalidSolDepositAuthority);
  }
  if (!a.isSigner) {
    log("SOL Deposit authority signature missing");
    require(false, StakePoolError.SignatureMissing);
  }
}

/** check_sol_withdraw_authority: the same for SOL withdrawals (no log for another key). */
export function checkSolWithdrawAuthority(pool: StakePool, rest: RemainingAccounts, index: u64): void {
  const auth = pool.solWithdrawAuthority;
  if (auth === null) return;
  need(rest, index + 1n);
  const a = rest.get(index);
  require(auth === a.key, StakePoolError.InvalidSolWithdrawAuthority);
  if (!a.isSigner) {
    log("SOL withdraw authority signature missing");
    require(false, StakePoolError.SignatureMissing);
  }
}

// ---- The validator list's header (ValidatorListHeader::deserialize_vec) ---------------------------------------------

/**
 * deserialize_vec's header: an AccountType byte (Borsh: at most 2) and the u32 capacity, else BorshIoError. The
 * caller then checks it is a ValidatorList (InvalidState) where the original does, and loads the list.
 */
export function checkListHeaderDecodes(a: RemainingAccount): void {
  require(a.dataLen >= VALIDATOR_LIST_HEADER_LEN && readData<u8>(a, 0n) <= 2n, ProgramError.BorshIoError);
}

/** header.is_valid(): the list was initialized (InvalidState otherwise). */
export function checkListHeaderValid(a: RemainingAccount): void {
  require(u64(readData<u8>(a, 0n)) === LIST_ACCOUNT_TYPE, StakePoolError.InvalidState);
}

/** AccountType::ValidatorList as the header's byte. */
export const LIST_ACCOUNT_TYPE = 2n;

// ---- The list's borrow ------------------------------------------------------------------------------------------------
//
// The original borrows the validator list's data mutably (`validator_list_info.data.borrow_mut()`, a RefCell) and
// holds it until it returns. With the list passed again in another slot, that AccountInfo shares the RefCell: reading
// its data panics ("already mutably borrowed", which the original's panic handler does not log: only the runtime's
// "SBF program Panicked in <file> at <line>:<column>" remains), and a CPI naming it fails before the call, where
// invoke_signed borrows each account of the instruction (ProgramError::AccountBorrowFailed). The port's list is a view
// of the same bytes, so it makes those refusals itself, where the original meets them. Accounts whose address the
// original has checked already are never the list (its address is no PDA of the program), and are not compared.

/** get_stake_state's `stake_account_info.data.borrow()` on the list: a silent panic there. */
export function panicIfTheList(a: RemainingAccount, list: RemainingAccount): void {
  if (a.key === list.key) panic(null, "program/src/processor.rs:50:89");
}

/** `AccountInfo::data_len()` on the list: the same, in solana-account-info. */
export function dataLenPanicIfTheList(a: RemainingAccount, list: RemainingAccount): void {
  if (a.key === list.key) panic(null, "src/lib.rs:105:19");
}

/** invoke / invoke_signed borrowing the list as an account of the instruction: AccountBorrowFailed. */
export function checkNotTheList(a: RemainingAccount, list: RemainingAccount): void {
  require(a.key !== list.key, ProgramError.AccountBorrowFailed);
}

// ---- SPL Token / Token-2022 accounts (spl-token-2022 StateWithExtensions::unpack) ---------------------------------

const MINT_LEN = 82n;
const TOKEN_ACCOUNT_LEN = 165n;
const MULTISIG_LEN = 355n;
/** The extension TLV entries start after the 165-byte base, the padding and one account-type byte. */
const TLV_START = 166n;

/** Why StateWithExtensions::unpack (and get_extension_types) refuse an account: 0 they do not. */
export const UNPACK_OK = 0n;
export const UNPACK_INVALID = 1n; // ProgramError::InvalidAccountData
export const UNPACK_UNINITIALIZED = 2n; // ProgramError::UninitializedAccount

/** A COption tag (u32 0 or 1). */
function badCOption(a: RemainingAccount, offset: u64): boolean {
  return readData<u32>(a, offset) > 1n;
}

/**
 * The extension part of a Token-2022 account (unpack_tlv_data): nothing past the base; or zero padding up to byte 165
 * and an account-type byte that names this kind of account (Mint 1, Account 2).
 */
function tlvHeaderValid(a: RemainingAccount, baseLen: u64, accountType: u64): boolean {
  const len = a.dataLen;
  if (len === baseLen) return true;
  if (len < TLV_START) return false;
  for (let i = baseLen; i < TOKEN_ACCOUNT_LEN; i++) if (readData<u8>(a, i) !== 0n) return false;
  return u64(readData<u8>(a, TOKEN_ACCOUNT_LEN)) === accountType;
}

/** StateWithExtensions::<Mint>::unpack, as the failure it gives. */
export function mintProblem(a: RemainingAccount): u64 {
  const len = a.dataLen;
  if (len === MULTISIG_LEN || len < MINT_LEN) return UNPACK_INVALID;
  const initialized = readData<u8>(a, 45n);
  if (badCOption(a, 0n) || initialized > 1n || badCOption(a, 46n)) return UNPACK_INVALID;
  if (initialized === 0n) return UNPACK_UNINITIALIZED;
  return tlvHeaderValid(a, MINT_LEN, 1n) ? UNPACK_OK : UNPACK_INVALID;
}

/** StateWithExtensions::<Mint>::unpack(..)?. */
export function unpackMint(a: RemainingAccount): void {
  const p = mintProblem(a);
  require(p !== UNPACK_INVALID, ProgramError.InvalidAccountData);
  require(p !== UNPACK_UNINITIALIZED, ProgramError.UninitializedAccount);
}

/** StateWithExtensions::<Account>::unpack, as the failure it gives. */
export function tokenAccountProblem(a: RemainingAccount): u64 {
  const len = a.dataLen;
  if (len === MULTISIG_LEN || len < TOKEN_ACCOUNT_LEN) return UNPACK_INVALID;
  const state = readData<u8>(a, 108n);
  if (badCOption(a, 72n) || state > 2n || badCOption(a, 109n) || badCOption(a, 129n)) return UNPACK_INVALID;
  if (state === 0n) return UNPACK_UNINITIALIZED;
  return tlvHeaderValid(a, TOKEN_ACCOUNT_LEN, 2n) ? UNPACK_OK : UNPACK_INVALID;
}

/** The highest ExtensionType spl-token-2022-interface 3.0 knows (PermissionedBurn); higher values do not decode. */
const LAST_EXTENSION_TYPE = 28n;

/**
 * get_extension_types (get_tlv_data_info): walks the TLV entries up to an Uninitialized type or the end (an entry cut
 * short, or an unknown type, is InvalidAccountData: false). An account without extensions has none.
 */
export function extensionsValid(a: RemainingAccount): boolean {
  const len = a.dataLen;
  let start = TLV_START;
  while (start < len) {
    if (len - start < 2n) return true;
    const t = readData<u16>(a, start);
    if (t === 0n) return true;
    if (len - start < 4n) return false;
    if (t > LAST_EXTENSION_TYPE) return false;
    const end = start + 4n + u64(readData<u16>(a, start + 2n));
    if (end > len) return false;
    start = end;
  }
  return true;
}

/**
 * The first extension (in the account's order) that is not in the supported list, 0 when there is none: for the pool
 * mint (is_extension_supported_for_mint) or for the manager fee account (is_extension_supported_for_fee_account).
 * Call it after extensionsValid.
 */
export function firstUnsupportedExtension(a: RemainingAccount, mint: boolean): u64 {
  const len = a.dataLen;
  let start = TLV_START;
  while (start < len && len - start >= 2n) {
    const t = u64(readData<u16>(a, start));
    if (t === 0n) return 0n;
    // Mint: TransferFeeConfig, ConfidentialTransferMint, ConfidentialTransferFeeConfig, DefaultAccountState,
    // InterestBearingConfig, MetadataPointer, TokenMetadata. Fee account: TransferFeeAmount, ImmutableOwner, CpiGuard.
    const ok = mint ? t === 1n || t === 4n || t === 16n || t === 6n || t === 10n || t === 18n || t === 19n : t === 2n || t === 7n || t === 11n;
    if (!ok) return t;
    start = start + 4n + u64(readData<u16>(a, start + 2n));
  }
  return 0n;
}

/** ExtensionType's Debug name, as the original's "cannot have the {:?} extension" lines print it. */
export function extensionName(t: u64): string {
  switch (t) {
    case 1n:
      return "TransferFeeConfig";
    case 2n:
      return "TransferFeeAmount";
    case 3n:
      return "MintCloseAuthority";
    case 4n:
      return "ConfidentialTransferMint";
    case 5n:
      return "ConfidentialTransferAccount";
    case 6n:
      return "DefaultAccountState";
    case 7n:
      return "ImmutableOwner";
    case 8n:
      return "MemoTransfer";
    case 9n:
      return "NonTransferable";
    case 10n:
      return "InterestBearingConfig";
    case 11n:
      return "CpiGuard";
    case 12n:
      return "PermanentDelegate";
    case 13n:
      return "NonTransferableAccount";
    case 14n:
      return "TransferHook";
    case 15n:
      return "TransferHookAccount";
    case 16n:
      return "ConfidentialTransferFeeConfig";
    case 17n:
      return "ConfidentialTransferFeeAmount";
    case 18n:
      return "MetadataPointer";
    case 19n:
      return "TokenMetadata";
    case 20n:
      return "GroupPointer";
    case 21n:
      return "TokenGroup";
    case 22n:
      return "GroupMemberPointer";
    case 23n:
      return "TokenGroupMember";
    case 24n:
      return "ConfidentialMintBurn";
    case 25n:
      return "ScaledUiAmount";
    case 26n:
      return "Pausable";
    case 27n:
      return "PausableAccount";
    case 28n:
      return "PermissionedBurn";
  }
  return "Uninitialized";
}

/** What check_manager_fee_info finds wrong: one of UNPACK_*, or these (all logged as the original logs them). */
export const FEE_ACCOUNT_INVALID = 3n; // StakePoolError::InvalidFeeAccount
export const FEE_ACCOUNT_UNSUPPORTED_EXTENSION = 4n; // StakePoolError::UnsupportedFeeAccountExtension

/**
 * StakePool::check_manager_fee_info, as a test: a token account of the pool's token program, initialized (not
 * frozen), of the pool mint, with only extensions a fee account may have. UpdateStakePoolBalance and WithdrawSol skip
 * the fee for an account that fails it (the logs stay); Initialize and SetManager fail.
 */
export function managerFeeInfoProblem(pool: StakePool, a: RemainingAccount): u64 {
  const p = tokenAccountProblem(a);
  if (p !== UNPACK_OK) return p;
  if (a.owner !== pool.tokenProgramId || readData<u8>(a, 108n) !== 1n || readData<Pubkey>(a, 0n) !== pool.poolMint) {
    log("Manager fee account is not owned by token program, is not initialized, or does not match stake pool's mint");
    return FEE_ACCOUNT_INVALID;
  }
  if (!extensionsValid(a)) return UNPACK_INVALID;
  const t = firstUnsupportedExtension(a, false);
  if (t !== 0n) {
    log(`Fee account cannot have the ${extensionName(t)} extension`);
    return FEE_ACCOUNT_UNSUPPORTED_EXTENSION;
  }
  return UNPACK_OK;
}

/** StakePool::check_manager_fee_info(..)?. */
export function checkManagerFeeInfo(pool: StakePool, a: RemainingAccount): void {
  const p = managerFeeInfoProblem(pool, a);
  require(p !== UNPACK_INVALID, ProgramError.InvalidAccountData);
  require(p !== UNPACK_UNINITIALIZED, ProgramError.UninitializedAccount);
  require(p !== FEE_ACCOUNT_INVALID, StakePoolError.InvalidFeeAccount);
  require(p !== FEE_ACCOUNT_UNSUPPORTED_EXTENSION, StakePoolError.UnsupportedFeeAccountExtension);
}

// ---- Stake-program accounts -----------------------------------------------------------------------------------------

/**
 * `try_from_slice_unchecked::<StakeStateV2>(data)`: the variant and the fields the pool reads, or INVALID_STAKE_STATE
 * when the bytes do not decode (too short for the variant, a tag past 3, a NaN warmup rate: Borsh refuses NaN).
 */
export function stakeState(a: RemainingAccount): StakeState {
  const len = a.dataLen;
  const s: StakeState = {
    tag: INVALID_STAKE_STATE,
    staker: DEFAULT_PUBKEY,
    withdrawer: DEFAULT_PUBKEY,
    lockupUnixTimestamp: 0n,
    lockupEpoch: 0n,
    lockupCustodian: DEFAULT_PUBKEY,
    voter: DEFAULT_PUBKEY,
    delegatedStake: 0n,
    activationEpoch: 0n,
    deactivationEpoch: 0n,
  };
  if (len < STAKE_STATE_TAG_LEN) return s;
  const tag = u64(readData<u32>(a, 0n));
  if (tag === STAKE_STATE_UNINITIALIZED || tag === STAKE_STATE_REWARDS_POOL) {
    s.tag = tag;
    return s;
  }
  if (tag === STAKE_STATE_INITIALIZED && len < STAKE_STATE_INITIALIZED_LEN) return s;
  if (tag === STAKE_STATE_STAKE) {
    if (len < STAKE_STATE_STAKE_LEN) return s;
    const rate = readData<u64>(a, STAKE_WARMUP_RATE);
    if ((rate & 0x7ff0000000000000n) === 0x7ff0000000000000n && (rate & 0x000fffffffffffffn) !== 0n) return s;
    s.voter = readData<Pubkey>(a, STAKE_VOTER);
    s.delegatedStake = readData<u64>(a, STAKE_DELEGATED);
    s.activationEpoch = readData<u64>(a, STAKE_ACTIVATION_EPOCH);
    s.deactivationEpoch = readData<u64>(a, STAKE_DEACTIVATION_EPOCH);
  } else if (tag !== STAKE_STATE_INITIALIZED) return s;
  s.tag = tag;
  s.staker = readData<Pubkey>(a, META_STAKER);
  s.withdrawer = readData<Pubkey>(a, META_WITHDRAWER);
  s.lockupUnixTimestamp = readData<i64>(a, META_LOCKUP_UNIX_TIMESTAMP);
  s.lockupEpoch = readData<u64>(a, META_LOCKUP_EPOCH);
  s.lockupCustodian = readData<Pubkey>(a, META_LOCKUP_CUSTODIAN);
  return s;
}

/** get_stake_state: a delegated stake account (BorshIoError when it does not decode, WrongStakeStake otherwise). */
export function delegatedStakeState(a: RemainingAccount): StakeState {
  const s = stakeState(a);
  require(s.tag !== INVALID_STAKE_STATE, ProgramError.BorshIoError);
  require(s.tag === STAKE_STATE_STAKE, StakePoolError.WrongStakeStake);
  return s;
}

/** stake_is_usable_by_pool: both authorities are the pool's withdraw authority and the lockup is the pool's. */
export function stakeIsUsableByPool(s: StakeState, authority: Pubkey, pool: StakePool): boolean {
  return (
    s.staker === authority &&
    s.withdrawer === authority &&
    s.lockupUnixTimestamp === pool.lockup.unixTimestamp &&
    s.lockupEpoch === pool.lockup.epoch &&
    s.lockupCustodian === pool.lockup.custodian
  );
}

/** stake_is_inactive_without_history: deactivated before this epoch, or activated and deactivated in it. */
export function stakeIsInactiveWithoutHistory(s: StakeState, epoch: u64): boolean {
  return s.deactivationEpoch < epoch || (s.activationEpoch === epoch && s.deactivationEpoch === epoch);
}

/** Epoch::MAX, a delegation that is not deactivating. */
export function notDeactivating(s: StakeState): boolean {
  return s.deactivationEpoch === EPOCH_MAX;
}

/** check_stake_state: usable by the pool and delegated to `vote` (WrongStakeStake, logged). */
export function checkStakeState(a: RemainingAccount, authority: Pubkey, vote: Pubkey, pool: StakePool): void {
  const s = delegatedStakeState(a);
  if (!stakeIsUsableByPool(s, authority, pool)) {
    log(`Validator stake for ${vote} not usable by pool, must be owned by withdraw authority`);
    require(false, StakePoolError.WrongStakeStake);
  }
  if (s.voter !== vote) {
    log(`Validator stake ${a.key} not delegated to ${vote}`);
    require(false, StakePoolError.WrongStakeStake);
  }
}

/** check_validator_stake_account: owned by the Stake program, at its address, usable by the pool, delegated to `vote`. */
export function checkValidatorStakeAccount(a: RemainingAccount, poolKey: Pubkey, authority: Pubkey, vote: Pubkey, seed: u32, pool: StakePool): void {
  checkAccountOwner(a, STAKE_PROGRAM_ID);
  checkValidatorStakeAddress(poolKey, a.key, vote, seed);
  checkStakeState(a, authority, vote, pool);
}

/** minimum_delegation: the Stake program's minimum, at least MINIMUM_ACTIVE_STAKE. */
export function minimumDelegation(stakeProgramMinimum: u64): u64 {
  return max(stakeProgramMinimum, MINIMUM_ACTIVE_STAKE);
}

/** minimum_stake_lamports: a stake account's rent plus the minimum delegation (saturating). */
export function minimumStakeLamports(rentReserve: u64, stakeProgramMinimum: u64): u64 {
  return saturatingAdd(rentReserve, minimumDelegation(stakeProgramMinimum));
}

/** minimum_reserve_lamports: the reserve's rent plus MINIMUM_RESERVE_LAMPORTS (saturating). */
export function minimumReserveLamports(rentReserve: u64): u64 {
  return saturatingAdd(rentReserve, MINIMUM_RESERVE_LAMPORTS);
}

// ---- Arithmetic -----------------------------------------------------------------------------------------------------

export function saturatingAdd(a: u64, b: u64): u64 {
  return a > U64_MAX - b ? U64_MAX : a + b;
}

export function saturatingSub(a: u64, b: u64): u64 {
  return a > b ? a - b : 0n;
}

/** `u64::try_from(x).ok()` then `.ok_or(CalculationFailure)?`. */
export function toU64(x: u128): u64 {
  require(x <= U64_MAX, StakePoolError.CalculationFailure);
  return u64(x);
}

/** Fee::apply: the fee on `amount`, rounded up (0 when the denominator is 0). Never overflows a u128. */
export function feeApply(fee: Fee, amount: u64): u128 {
  if (fee.denominator === 0n) return 0n;
  const d = u128(fee.denominator);
  return (u128(amount) * u128(fee.numerator) + d - 1n) / d;
}

/** calc_pool_tokens_for_deposit: pool tokens for `lamports` at the current rate (1:1 for an empty pool). */
export function calcPoolTokensForDeposit(pool: StakePool, lamports: u64): u64 {
  if (pool.totalLamports === 0n || pool.poolTokenSupply === 0n) return lamports;
  return toU64((u128(lamports) * u128(pool.poolTokenSupply)) / u128(pool.totalLamports));
}

/** calc_lamports_withdraw_amount: lamports for `poolTokens` (0 when under one lamport or no supply). */
export function calcLamportsWithdrawAmount(pool: StakePool, poolTokens: u64): u64 {
  const numerator = u128(poolTokens) * u128(pool.totalLamports);
  const denominator = u128(pool.poolTokenSupply);
  if (numerator < denominator || denominator === 0n) return 0n;
  return toU64(numerator / denominator);
}

/** calc_pool_tokens_*_referral_fee: `referral` percent of a deposit fee. */
export function calcReferralFee(depositFee: u64, referral: u8): u64 {
  return toU64((u128(depositFee) * u128(referral)) / 100n);
}

/** calc_epoch_fee_amount: the pool tokens to mint the manager for `reward` new lamports. */
export function calcEpochFeeAmount(pool: StakePool, reward: u64): u64 {
  if (reward === 0n) return 0n;
  const total = u128(pool.totalLamports) + u128(reward);
  const feeLamports = feeApply(pool.epochFee, reward);
  if (total === feeLamports || pool.poolTokenSupply === 0n) return reward;
  // (supply * fee) / (total - fee): the product fits a u128 only while the fee does (it is at most ~2^64 · numerator).
  require(total >= feeLamports, StakePoolError.CalculationFailure);
  require(feeLamports <= U128_MAX / u128(pool.poolTokenSupply), StakePoolError.CalculationFailure);
  return toU64((u128(pool.poolTokenSupply) * feeLamports) / (total - feeLamports));
}

/** Whether a * b fits a u128 (`checked_mul` is Some). */
function mulFits(a: u128, b: u128): boolean {
  return a === 0n || b <= U128_MAX / a;
}

/** WITHDRAWAL_BASELINE_FEE (1/1000), MAX_WITHDRAWAL_FEE_INCREASE (1/200), MAX_WITHDRAWAL_FEE_INCREASE_FACTOR (3/2). */
const BASELINE_NUMERATOR = 1n;
const BASELINE_DENOMINATOR = 1000n;
const MAX_INCREASE_NUMERATOR = 1n;
const MAX_INCREASE_DENOMINATOR = 200n;
const MAX_FACTOR_NUMERATOR = 3n;
const MAX_FACTOR_DENOMINATOR = 2n;

/**
 * Fee::check_withdrawal: a new withdrawal fee may rise by at most 1/200 (half a percent) and by at most half of the
 * old one (from 1/1000 when there was none). Products past u128 fail with CalculationFailure.
 */
export function checkWithdrawalFee(next: Fee, old: Fee): void {
  let oldNum = old.numerator;
  let oldDenom = old.denominator;
  if (oldDenom === 0n || oldNum === 0n) {
    oldNum = BASELINE_NUMERATOR;
    oldDenom = BASELINE_DENOMINATOR;
  }
  // old_denom * denominator * 1 < (numerator * old_denom - denominator * old_num) * 200 (the left side first)
  const allowedBase = u128(oldDenom) * u128(next.denominator);
  require(mulFits(allowedBase, u128(MAX_INCREASE_NUMERATOR)), StakePoolError.CalculationFailure);
  const allowed = allowedBase * u128(MAX_INCREASE_NUMERATOR);
  const scaledNew = u128(next.numerator) * u128(oldDenom);
  const scaledOld = u128(next.denominator) * u128(oldNum);
  const rise = scaledNew > scaledOld ? scaledNew - scaledOld : 0n;
  require(mulFits(rise, u128(MAX_INCREASE_DENOMINATOR)), StakePoolError.CalculationFailure);
  if (allowed < rise * u128(MAX_INCREASE_DENOMINATOR)) {
    log(`Fee increase exceeds maximum allowed, need to increase by ${MAX_INCREASE_NUMERATOR} / ${MAX_INCREASE_DENOMINATOR}`);
    require(false, StakePoolError.FeeIncreaseTooHigh);
  }
  // old_num * denominator * 3 < numerator * old_denom * 2
  const factorOldBase = u128(oldNum) * u128(next.denominator);
  require(mulFits(factorOldBase, u128(MAX_FACTOR_NUMERATOR)), StakePoolError.CalculationFailure);
  const factorNewBase = u128(next.numerator) * u128(oldDenom);
  require(mulFits(factorNewBase, u128(MAX_FACTOR_DENOMINATOR)), StakePoolError.CalculationFailure);
  if (factorOldBase * u128(MAX_FACTOR_NUMERATOR) < factorNewBase * u128(MAX_FACTOR_DENOMINATOR)) {
    const shownNew = mulSaturating(next.numerator, oldDenom);
    const shownOld = mulSaturating(oldNum, next.denominator);
    log(`Fee increase exceeds maximum allowed, proposed increase factor (${shownNew} / ${shownOld})`);
    require(false, StakePoolError.FeeIncreaseTooHigh);
  }
}

/** u64::saturating_mul. */
function mulSaturating(a: u64, b: u64): u64 {
  const p = u128(a) * u128(b);
  return p > U64_MAX ? U64_MAX : u64(p);
}

// ---- CPIs the pool signs as its withdraw authority [pool, "withdraw", bump] ------------------------------------------

/** Processor::token_mint_to: MintTo (tag 7) of `amount` to `to`, signed by the withdraw authority. */
export function mintTokens(
  token: TokenInterface,
  mint: RemainingAccount,
  to: RemainingAccount,
  authority: RemainingAccount,
  poolKey: Pubkey,
  bump: u8,
  amount: u64,
): void {
  token.mintTo(mint, to, authority, amount, [poolKey, AUTHORITY_WITHDRAW, bump]);
}

// The Stake instructions are built as solana_program's builders build them (stake::instruction::merge, withdraw,
// deactivate_stake, delegate_stake), which name the Clock, the StakeHistory sysvar and the stake config by their
// addresses, and invoked with the accounts of their slots in the instruction (clock_info, stake_history_info,
// stake_config_info), as Rust's invoke_signed takes them: the runtime finds each address among those accounts only, and
// refuses the call when a slot holds another account (MissingAccount, "Instruction references an unknown account"),
// wherever else the sysvar is.

/** Processor::stake_merge: Merge `source` into `destination`, signed by the withdraw authority. */
export function stakeMerge(
  stake: StakeProgram,
  source: RemainingAccount,
  authority: RemainingAccount,
  poolKey: Pubkey,
  bump: u8,
  destination: RemainingAccount,
  clock: RemainingAccount,
  stakeHistory: RemainingAccount,
): void {
  stake.merge(destination, source, named(clock, CLOCK_SYSVAR_ID), named(stakeHistory, STAKE_HISTORY_SYSVAR_ID), authority, [poolKey, AUTHORITY_WITHDRAW, bump]);
}

/** Processor::stake_deactivate, signed by the withdraw authority. */
export function stakeDeactivate(
  stake: StakeProgram,
  account: RemainingAccount,
  clock: RemainingAccount,
  authority: RemainingAccount,
  poolKey: Pubkey,
  bump: u8,
): void {
  stake.deactivate(account, named(clock, CLOCK_SYSVAR_ID), authority, [poolKey, AUTHORITY_WITHDRAW, bump]);
}

/** Processor::stake_withdraw: Withdraw `lamports` from `source` to `destination` (no custodian). */
export function stakeWithdraw(
  stake: StakeProgram,
  source: RemainingAccount,
  authority: RemainingAccount,
  poolKey: Pubkey,
  bump: u8,
  destination: RemainingAccount,
  clock: RemainingAccount,
  stakeHistory: RemainingAccount,
  lamports: u64,
): void {
  stake.withdraw(source, destination, named(clock, CLOCK_SYSVAR_ID), named(stakeHistory, STAKE_HISTORY_SYSVAR_ID), authority, lamports, [
    poolKey,
    AUTHORITY_WITHDRAW,
    bump,
  ]);
}

/** Processor::stake_split: Split `lamports` of `source` into `destination`, signed by the withdraw authority. */
export function stakeSplit(
  stake: StakeProgram,
  source: RemainingAccount,
  authority: RemainingAccount,
  poolKey: Pubkey,
  bump: u8,
  lamports: u64,
  destination: RemainingAccount,
): void {
  stake.split(source, destination, authority, lamports, [poolKey, AUTHORITY_WITHDRAW, bump]);
}

/** Processor::stake_delegate: DelegateStake of `account` to `vote`, signed by the withdraw authority. */
export function stakeDelegate(
  stake: StakeProgram,
  account: RemainingAccount,
  vote: RemainingAccount,
  clock: RemainingAccount,
  stakeHistory: RemainingAccount,
  stakeConfig: RemainingAccount,
  authority: RemainingAccount,
  poolKey: Pubkey,
  bump: u8,
): void {
  stake.delegate(account, vote, named(clock, CLOCK_SYSVAR_ID), named(stakeHistory, STAKE_HISTORY_SYSVAR_ID), named(stakeConfig, STAKE_CONFIG_ID), authority, [
    poolKey,
    AUTHORITY_WITHDRAW,
    bump,
  ]);
}

/** stake::tools::get_minimum_delegation, then minimum_delegation: the most of it and MINIMUM_ACTIVE_STAKE. */
export function poolMinimumDelegation(stake: StakeProgram): u64 {
  return minimumDelegation(stake.getMinimumDelegation());
}

// ---- Token CPIs the user signs ------------------------------------------------------------------------------------

/** Processor::token_burn: Burn (tag 8) `amount` from `from`, the user's transfer authority signing. */
export function burnTokens(token: TokenInterface, from: RemainingAccount, mint: RemainingAccount, authority: RemainingAccount, amount: u64): void {
  token.burn(from, mint, authority, amount);
}

/** Processor::token_transfer: TransferChecked (tag 12) with the mint's decimals, the user's authority signing. */
export function transferTokens(
  token: TokenInterface,
  from: RemainingAccount,
  mint: RemainingAccount,
  to: RemainingAccount,
  authority: RemainingAccount,
  amount: u64,
): void {
  token.transferChecked(from, mint, to, authority, amount);
}

// ---- Status changes (PodStakeStatus) -------------------------------------------------------------------------------

/**
 * PodStakeStatus::remove_transient_stake: the transient stake account is gone (DeactivatingAll -> DeactivatingValidator,
 * DeactivatingTransient -> ReadyForRemoval; the others stay). A byte that is no StakeStatus is InvalidAccountData.
 */
export function statusWithoutTransient(status: u8): u8 {
  require(status <= STATUS_DEACTIVATING_ALL, ProgramError.InvalidAccountData);
  if (status === STATUS_DEACTIVATING_ALL) return u8(STATUS_DEACTIVATING_VALIDATOR);
  if (status === STATUS_DEACTIVATING_TRANSIENT) return u8(STATUS_READY_FOR_REMOVAL);
  return status;
}

/**
 * PodStakeStatus::remove_validator_stake: the validator stake account is gone (DeactivatingAll -> DeactivatingTransient,
 * DeactivatingValidator -> ReadyForRemoval; the others stay).
 */
export function statusWithoutValidator(status: u8): u8 {
  require(status <= STATUS_DEACTIVATING_ALL, ProgramError.InvalidAccountData);
  if (status === STATUS_DEACTIVATING_ALL) return u8(STATUS_DEACTIVATING_TRANSIENT);
  if (status === STATUS_DEACTIVATING_VALIDATOR) return u8(STATUS_READY_FOR_REMOVAL);
  return status;
}
