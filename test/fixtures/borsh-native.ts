// loadBorsh / storeBorsh: a native program's Borsh accounts (no discriminator) read into a local struct and written
// back, as Rust's try_from_slice_unchecked / serialize do. Every field kind (Kitchen), and SPL Stake Pool's StakePool
// (program@v2.1.0 state.rs) with its Option<Pubkey> fields and FutureEpoch<Fee> data enums.
import {
  type AccountInfo,
  type FixedArray,
  type FixedString,
  type FixedVec,
  type Mut,
  type Option,
  type Pubkey,
  type RemainingAccount,
  type i8,
  type i32,
  type i64,
  type i128,
  type u8,
  type u16,
  type u32,
  type u128,
  ProgramError,
  instructionData,
  loadBorsh,
  log,
  remainingAccounts,
  require,
  storeBorsh,
  u64,
} from "typesol";

export const PROGRAM_ERROR_LOG_PREFIX = "Program error: ";

export enum AccountType {
  Uninitialized,
  StakePool,
  ValidatorList,
}

export interface Lockup {
  unixTimestamp: i64;
  epoch: u64;
  custodian: Pubkey;
}

export interface Fee {
  denominator: u64;
  numerator: u64;
}

/** FutureEpoch<Fee>. */
export type FutureEpochFee = { kind: "None" } | { kind: "One"; fee: Fee } | { kind: "Two"; fee: Fee };

/** SPL Stake Pool's StakePool (611 bytes at most: every Option Some, every FutureEpoch One or Two). */
export interface StakePool {
  accountType: AccountType;
  manager: Pubkey;
  staker: Pubkey;
  stakeDepositAuthority: Pubkey;
  stakeWithdrawBumpSeed: u8;
  validatorList: Pubkey;
  reserveStake: Pubkey;
  poolMint: Pubkey;
  managerFeeAccount: Pubkey;
  tokenProgramId: Pubkey;
  totalLamports: u64;
  poolTokenSupply: u64;
  lastUpdateEpoch: u64;
  lockup: Lockup;
  epochFee: Fee;
  nextEpochFee: FutureEpochFee;
  preferredDepositValidatorVoteAddress: Option<Pubkey>;
  preferredWithdrawValidatorVoteAddress: Option<Pubkey>;
  stakeDepositFee: Fee;
  stakeWithdrawalFee: Fee;
  nextStakeWithdrawalFee: FutureEpochFee;
  stakeReferralFee: u8;
  solDepositAuthority: Option<Pubkey>;
  solDepositFee: Fee;
  solReferralFee: u8;
  solWithdrawAuthority: Option<Pubkey>;
  solWithdrawalFee: Fee;
  nextSolWithdrawalFee: FutureEpochFee;
  lastEpochPoolTokenSupply: u64;
  lastEpochTotalLamports: u64;
}

export interface Point {
  x: i32;
  y: i32;
}

/** A nested struct holding an Option: Borsh-variable inside Kitchen. */
export interface Inner {
  a: u16;
  flag: boolean;
  when: Option<u32>;
}

export type Shape = { kind: "Dot" } | { kind: "Box"; w: u64; h: u64 } | { kind: "At"; p: Point };

/** @layout borsh */
export interface Kitchen {
  small: u8;
  half: u16;
  word: u32;
  big: u64;
  huge: u128;
  neg: i8;
  stamp: i64;
  wide: i128;
  flag: boolean;
  key: Pubkey;
  kind: AccountType;
  arr: FixedArray<u16, 3>;
  name: FixedString<12>;
  list: FixedVec<u32, 4>;
  optKey: Option<Pubkey>;
  optNum: Option<u64>;
  optPoint: Option<Point>;
  optInner: Option<Inner>;
  optArr: Option<FixedArray<u16, 3>>;
  inner: Inner;
  point: Point;
  shape: Shape;
  tail: u64;
}

/** The pool's withdrawal fee of an amount (a helper taking the local struct). */
function withdrawalFee(pool: StakePool, amount: u64): u64 {
  if (pool.stakeWithdrawalFee.denominator === 0n) return 0n;
  return (amount * pool.stakeWithdrawalFee.numerator) / pool.stakeWithdrawalFee.denominator;
}

/** Kitchen copied from one RemainingAccount to another inside a helper. */
function copyKitchen(src: RemainingAccount, dst: RemainingAccount): void {
  const k = loadBorsh<Kitchen>(src);
  storeBorsh(dst, k);
}

/** A helper reading its AccountInfo parameter. */
function bigOf(a: AccountInfo): u64 {
  const k = loadBorsh<Kitchen>(a);
  return k.big;
}

/** Both accounts as AccountInfo parameters: Kitchen from `src` into `dst`. */
export function viaParams(src: AccountInfo, dst: Mut<AccountInfo>): void {
  const k: Kitchen = loadBorsh(src);
  log(`big ${k.big} ${bigOf(src)}`);
  storeBorsh(dst, k);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const rest = remainingAccounts();
  if (tag === 0n) {
    // Kitchen from account 0 into account 1, unchanged.
    const k = loadBorsh<Kitchen>(rest.get(0n));
    storeBorsh(rest.get(1n), k);
    return;
  }
  if (tag === 1n) {
    // Every Option flips (Some -> None, None -> Some), the shape moves on, a few values change; written back in place.
    const k = loadBorsh<Kitchen>(rest.get(0n));
    k.optKey = k.optKey === null ? rest.get(0n).key : null;
    k.optNum = k.optNum === null ? 7n : null;
    if (k.optPoint !== null) k.optPoint = null;
    else k.optPoint = { x: -3n, y: 4n };
    if (k.optInner === null) k.optInner = { a: 9n, flag: true, when: 70000n };
    else k.optInner = null;
    k.optArr = null; // (an Option<FixedArray> field is only ever set to null)
    k.inner.when = k.inner.when === null ? 11n : null;
    if (k.shape.kind === "Dot") k.shape = { kind: "Box", w: 1n, h: 2n };
    else if (k.shape.kind === "Box") k.shape = { kind: "At", p: { x: -1n, y: 2n } };
    else k.shape = { kind: "Dot" };
    k.big += 1n;
    k.flag = !k.flag;
    k.kind = AccountType.ValidatorList;
    k.name = "renamed";
    if (k.list.length < 4n) k.list.push(42n);
    storeBorsh(rest.get(0n), k);
    return;
  }
  if (tag === 2n) {
    // A stake pool update: totals, preferred validators set or cleared, fees rolled; the copy is left alone.
    const pool = loadBorsh<StakePool>(rest.get(0n));
    require(pool.accountType === AccountType.StakePool, ProgramError.InvalidAccountData);
    const before: StakePool = pool;
    pool.totalLamports += data.readU64(1n);
    pool.poolTokenSupply += withdrawalFee(pool, 1000n);
    pool.preferredDepositValidatorVoteAddress = pool.preferredDepositValidatorVoteAddress === null ? pool.manager : null;
    if (pool.preferredWithdrawValidatorVoteAddress !== null) {
      log(pool.preferredWithdrawValidatorVoteAddress);
      pool.preferredWithdrawValidatorVoteAddress = null;
    }
    pool.solDepositAuthority = null;
    // The future fee moves one epoch on.
    if (pool.nextEpochFee.kind === "One") {
      pool.epochFee = pool.nextEpochFee.fee;
      pool.nextEpochFee = { kind: "None" };
    } else if (pool.nextEpochFee.kind === "Two") pool.nextEpochFee = { kind: "One", fee: pool.nextEpochFee.fee };
    if (pool.nextSolWithdrawalFee.kind === "None") pool.nextSolWithdrawalFee = { kind: "Two", fee: { denominator: 100n, numerator: 3n } };
    log(`before ${before.totalLamports} after ${pool.totalLamports}`);
    log(`epoch fee ${pool.epochFee.numerator}/${pool.epochFee.denominator}`);
    storeBorsh(rest.get(0n), pool);
    return;
  }
  if (tag === 3n) {
    // Compute: a 611-byte stake pool read and written back unchanged.
    const pool = loadBorsh<StakePool>(rest.get(0n));
    storeBorsh(rest.get(0n), pool);
    return;
  }
  if (tag === 4n) {
    // The baseline for tag 3: the same entry and account lookup, no Borsh.
    const a = rest.get(0n);
    require(a.lamports > 0n, ProgramError.InvalidArgument);
    return;
  }
  if (tag === 5n) {
    // Read only (the error cases).
    const k = loadBorsh<Kitchen>(rest.get(0n));
    log(`tail ${k.tail}`);
    return;
  }
  if (tag === 6n) {
    // A struct literal written as Borsh.
    storeBorsh<Inner>(rest.get(0n), { a: 513n, flag: true, when: null });
    return;
  }
  if (tag === 7n) {
    copyKitchen(rest.get(0n), rest.get(1n));
    return;
  }
  if (tag === 8n) {
    // Compute: a 611-byte stake pool read only.
    const pool = loadBorsh<StakePool>(rest.get(0n));
    require(pool.totalLamports !== 1n, ProgramError.InvalidArgument);
    return;
  }
  require(false, ProgramError.InvalidInstructionData);
}
