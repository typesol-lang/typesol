// NATIVE_ACCOUNT_WRITES with several views of one account at one position: loadRawMut twice, loadRaw after a write
// through loadRawMut, storeBorsh under a loadRawMut view, and BigVec writes seen through another view. Every view reads
// the account's bytes in place, so each sees the others' writes.
import {
  type BigVec,
  type Pubkey,
  ProgramError,
  instructionData,
  loadRaw,
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

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 2n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const by = u64(data.readU8(1n));
  const rest = remainingAccounts();
  if (tag === 0n) {
    // loadRawMut twice at the same position: two views of one record.
    const a = loadRawMut<Counter>(rest.get(0n));
    const b = loadRawMut<Counter>(rest.get(0n));
    a.count += by;
    log(`seen ${b.count}`);
    return;
  }
  if (tag === 1n) {
    // A read view made after a write through loadRawMut reads the new value.
    const m = loadRawMut<Counter>(rest.get(0n));
    m.count += by;
    const r = loadRaw<Counter>(rest.get(0n));
    log(`read ${r.count}`);
    return;
  }
  if (tag === 2n) {
    // storeBorsh under a loadRawMut view: the view reads what was stored.
    const m = loadRawMut<Counter>(rest.get(0n));
    storeBorsh<Counter>(rest.get(0n), { owner: m.owner, count: m.count + by });
    log(`view ${m.count}`);
    return;
  }
  if (tag === 3n) {
    // A BigVec push through loadRawMut, read through loadRaw.
    const w = loadRawMut<Numbers>(rest.get(0n));
    w.items.push(by);
    const r = loadRaw<Numbers>(rest.get(0n));
    log(`items ${r.items.length} last ${r.items.get(r.items.length - 1n)}`);
    return;
  }
  if (tag === 4n) {
    // Two loadRawMut views of one BigVec account: a push through one, a set through the other, both seen.
    const a = loadRawMut<Numbers>(rest.get(0n));
    const b = loadRawMut<Numbers>(rest.get(0n));
    a.items.push(by);
    b.items.set(0n, by + 1n);
    log(`items ${a.items.length} ${b.items.length} first ${a.items.get(0n)}`);
    return;
  }
  require(false, ProgramError.InvalidInstructionData);
}
