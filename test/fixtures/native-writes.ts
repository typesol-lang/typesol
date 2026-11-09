// NATIVE_ACCOUNT_WRITES: loadRawMut, storeBorsh and BigVec writes as a native program makes them. Nothing is checked up
// front; the runtime refuses the instruction when a read-only account's data changed, and one account passed twice is
// two views of the same bytes (SPL Stake Pool's validator list passed again as a stake account, skipped by its address
// checks; a read-only list or pool that is only read).
import {
  type AccountInfo,
  type BigVec,
  type Pubkey,
  ProgramError,
  instructionData,
  loadBorsh,
  loadRawMut,
  log,
  remainingAccounts,
  require,
  storeBorsh,
  type u8,
  u64,
} from "typesol";

export const NATIVE_ACCOUNT_WRITES = true;

export interface Counter {
  owner: Pubkey;
  count: u64;
}

export interface Numbers {
  tag: u8;
  items: BigVec<u64>;
}

/** A plain AccountInfo parameter (not Mut<…>) loaded with loadRawMut: the runtime decides. */
export function bump(counter: AccountInfo, by: u64): void {
  const c = loadRawMut<Counter>(counter);
  if (by > 0n) c.count += by;
  log(`count ${c.count}`);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 2n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const by = u64(data.readU8(1n));
  const rest = remainingAccounts();
  if (tag === 0n) {
    // A view that writes only when asked to.
    const c = loadRawMut<Counter>(rest.get(0n));
    if (by > 0n) c.count += by;
    log(`count ${c.count}`);
    return;
  }
  if (tag === 1n) {
    // The same account at two positions: two views of one record, a write through one seen through the other.
    const a = loadRawMut<Counter>(rest.get(0n));
    const b = loadRawMut<Counter>(rest.get(1n));
    a.count += by;
    log(`seen ${b.count}`);
    return;
  }
  if (tag === 2n) {
    // Borsh written back: unchanged bytes are no change.
    const c = loadBorsh<Counter>(rest.get(0n));
    c.count += by;
    storeBorsh(rest.get(0n), c);
    log(`stored ${c.count}`);
    return;
  }
  if (tag === 3n) {
    // A BigVec: pushed to only when asked to.
    const l = loadRawMut<Numbers>(rest.get(0n));
    if (by > 0n) l.items.push(by);
    log(`items ${l.items.length}`);
    return;
  }
  require(false, ProgramError.InvalidInstructionData);
}
