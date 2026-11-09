// A BigVec whose stored length is written again after the load (a second view of the account, storeBorsh, writeData):
// every read, write and loop stays within the account's room, the length clamped to it, as the load's length check
// promised. test/language/bigvec.test.ts runs it.
import {
  type AccountInfo,
  type BigVec,
  type Mut,
  ProgramError,
  instructionData,
  loadRawMut,
  log,
  remainingAccounts,
  require,
  storeBorsh,
  writeData,
  type u32,
  type u8,
  u64,
} from "typesol";

export const NATIVE_ACCOUNT_WRITES = true;
export const PROGRAM_ERROR_LOG_PREFIX = "Error: ";

export interface Numbers {
  tag: u8;
  items: BigVec<u64>;
}

/** Numbers' first bytes: its tag and the BigVec's length. */
export interface Header {
  tag: u8;
  len: u32;
}

/**
 * Instruction data: how the length is written after the load (0: not at all, 1: through a second view, 2: storeBorsh),
 * the new length (u32 at 1), the operation (u8 at 5) and its index (u64 at 6).
 *
 * @fallback
 */
export function entry(): void {
  const data = instructionData();
  require(data.length === 14n, ProgramError.InvalidInstructionData);
  const how = data.readU8(0n);
  const len = data.readU32(1n);
  const op = data.readU8(5n);
  const at = data.readU64(6n);
  const acct = remainingAccounts().get(0n);
  const l = loadRawMut<Numbers>(acct);
  if (how === 1n) {
    const h = loadRawMut<Header>(acct);
    h.len = len;
  } else if (how === 2n) storeBorsh<Header>(acct, { tag: l.tag, len });
  if (op === 0n) {
    // The count, the room, and a for … of over the elements.
    let sum = 0n;
    let n = 0n;
    for (const x of l.items) {
      sum += x;
      n += 1n;
    }
    log(`len ${l.items.length} cap ${l.items.capacity} sum ${sum} n ${n}`);
  } else if (op === 1n) log(`get ${l.items.get(at)}`);
  else if (op === 2n) {
    l.items.set(at, 7n);
    log(`set ${l.items.get(at)}`);
  } else if (op === 3n) {
    let sum = 0n;
    for (const x of l.items.slice(0n, at)) sum += x;
    log(`slice ${l.items.slice(0n, at).length} sum ${sum}`);
  } else if (op === 4n) {
    l.items.retain((x) => x % 2n === 0n);
    log(`retained ${l.items.length}`);
  } else if (op === 5n) {
    l.items.push(9n);
    log(`pushed ${l.items.length}`);
  } else if (op === 6n) log(`index ${l.items.findIndex((x) => x === at)} has ${l.items.includes(at)}`);
  else if (op === 7n) {
    // slice to the end: as far as the room goes.
    let n = 0n;
    l.items.slice(at).forEach(() => {
      n += 1n;
    });
    log(`tail ${n}`);
  }
}

/** The length written with writeData through an AccountInfo parameter, then a loop and a get at `at`. */
export function viaWriteData(list: Mut<AccountInfo>, len: u32, at: u64): void {
  const l = loadRawMut<Numbers>(list);
  writeData<u32>(list, 1n, len);
  let sum = 0n;
  for (const x of l.items) sum += x;
  log(`len ${l.items.length} sum ${sum} get ${l.items.get(at)}`);
}
