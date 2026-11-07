// BigVec<T>: SPL's big_vec over a preallocated native account (the stake pool's ValidatorList), read in place with
// loadRaw / loadRawMut: push into the account's room, retain, find, get / set, for … of, slices for chunked work.
import {
  type AccountInfo,
  type BigVec,
  type Mut,
  type Pubkey,
  ProgramError,
  instructionData,
  loadRaw,
  loadRawMut,
  log,
  remainingAccounts,
  require,
  type u32,
  type u8,
  u64,
} from "typesol";

export const PROGRAM_ERROR_LOG_PREFIX = "Error: ";

/** The stake pool's ValidatorStakeInfo: 73 bytes, packed. */
export interface ValidatorStakeInfo {
  active_stake_lamports: u64;
  transient_stake_lamports: u64;
  last_update_epoch: u64;
  transient_seed_suffix: u64;
  unused: u32;
  validator_seed_suffix: u32;
  status: u8;
  vote_account_address: Pubkey;
}

/** The stake pool's ValidatorList: a 5-byte header, then the BigVec. */
export interface ValidatorList {
  account_type: u8;
  max_validators: u32;
  validators: BigVec<ValidatorStakeInfo>;
}

/** Scalar elements. */
export interface Numbers {
  tag: u8;
  items: BigVec<u64>;
}

/** Bump every validator's epoch through an AccountInfo parameter (not a remaining account). */
export function touch(list: Mut<AccountInfo>, epoch: u64): void {
  const l = loadRawMut<ValidatorList>(list);
  for (const v of l.validators) v.last_update_epoch = epoch;
  log(`touched ${l.validators.length}`);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const rest = remainingAccounts();
  if (tag === 0n) {
    // push(vote, active, status)
    const l = loadRawMut<ValidatorList>(rest.get(0n));
    l.validators.push({
      active_stake_lamports: data.readU64(33n),
      transient_stake_lamports: 0n,
      last_update_epoch: 0n,
      transient_seed_suffix: 0n,
      unused: 0n,
      validator_seed_suffix: 0n,
      status: data.readU8(41n),
      vote_account_address: data.readPubkey(1n),
    });
    return;
  }
  if (tag === 1n) {
    // find by vote account: the index, and a field of the element found
    const l = loadRaw<ValidatorList>(rest.get(0n));
    const key = data.readPubkey(1n);
    const i = l.validators.findIndex((v) => v.vote_account_address === key);
    if (i < 0n) {
      log("not found");
      return;
    }
    log(`found ${i} active ${l.validators.find((v) => v.vote_account_address === key)!.active_stake_lamports}`);
    return;
  }
  if (tag === 2n) {
    // retain the elements whose status is not the byte given (the stake pool's !is_removed)
    const l = loadRawMut<ValidatorList>(rest.get(0n));
    const status = data.readU8(1n);
    l.validators.retain((v) => v.status !== status);
    return;
  }
  if (tag === 3n) {
    // get(i)
    const l = loadRaw<ValidatorList>(rest.get(0n));
    log(`active ${l.validators.get(data.readU64(1n)).active_stake_lamports}`);
    return;
  }
  if (tag === 4n) {
    // set(i, whole element), then one field in place
    const l = loadRawMut<ValidatorList>(rest.get(0n));
    const i = data.readU64(1n);
    const old = l.validators.get(i);
    l.validators.set(i, {
      active_stake_lamports: data.readU64(9n),
      transient_stake_lamports: 0n,
      last_update_epoch: 0n,
      transient_seed_suffix: 0n,
      unused: 0n,
      validator_seed_suffix: 0n,
      status: 0n,
      vote_account_address: old.vote_account_address,
    });
    l.validators.get(i).transient_stake_lamports = 7n;
    return;
  }
  if (tag === 5n) {
    // iterate: totals, length, capacity
    const l = loadRaw<ValidatorList>(rest.get(0n));
    let total = 0n;
    for (const v of l.validators) total += v.active_stake_lamports;
    log(`len ${l.validators.length} cap ${l.validators.capacity} total ${total}`);
    return;
  }
  if (tag === 6n) {
    // chunked: deserialize_mut_slice(skip, len) is slice(skip, skip + len)
    const l = loadRawMut<ValidatorList>(rest.get(0n));
    const skip = data.readU64(1n);
    const len = data.readU64(9n);
    let n = 0n;
    for (const v of l.validators.slice(skip, skip + len)) {
      v.last_update_epoch = 99n;
      n += 1n;
    }
    log(`chunk ${n} ${l.validators.slice(skip, skip + len).length} some ${l.validators.slice(skip, skip + len).some((v) => v.status === 1n)}`);
    return;
  }
  if (tag === 7n) {
    // slice to the end, and get / set through a slice
    const l = loadRawMut<ValidatorList>(rest.get(0n));
    const from = data.readU64(1n);
    let total = 0n;
    l.validators.slice(from).forEach((v) => {
      total += v.active_stake_lamports;
    });
    if (l.validators.slice(from).length > 0n) l.validators.slice(from).get(0n).unused = 5n;
    log(`tail ${total}`);
    return;
  }
  if (tag === 8n) {
    // u64 elements: push, retain the even ones, find (an Option), includes
    const nums = loadRawMut<Numbers>(rest.get(0n));
    const v = data.readU64(1n);
    if (v > 0n) nums.items.push(v);
    else nums.items.retain((x) => x % 2n === 0n);
    const big = nums.items.find((x) => x > 100n);
    log(`n ${nums.items.length} first>100 ${big === null ? 0n : big} has42 ${nums.items.includes(42n)}`);
    return;
  }
  if (tag === 9n) {
    // nothing but the load (its checks)
    const l = loadRaw<ValidatorList>(rest.get(0n));
    log(`loaded ${l.validators.length} of ${u64(l.max_validators)}`);
    return;
  }
  require(false, ProgramError.InvalidInstructionData);
}
