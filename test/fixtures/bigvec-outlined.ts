// BigVec loops moved into C functions of their own (see outlinedLoop), run many times from an outer loop: a Borsh
// event emitted in one, a helper given an element (copied for it) in another, and a loop formatting a Pubkey.
// test/language/bigvec.test.ts runs it.
import {
  type BigVec,
  type Pubkey,
  type RemainingAccount,
  ProgramError,
  emit,
  instructionData,
  loadRaw,
  log,
  remainingAccounts,
  require,
  type u8,
  u64,
} from "typesol";

export interface Item {
  value: u64;
  owner: Pubkey;
}

export interface Items {
  tag: u8;
  items: BigVec<Item>;
}

/** @layout borsh */
export interface Seen {
  value: u64;
  round: u64;
  note: string;
}

/** Takes an account, so an element passed to it is copied first (a buffer taken once per call site). */
function weigh(acct: RemainingAccount, item: Item): u64 {
  return item.value + (acct.lamports > 0n ? 1n : 0n);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length === 9n, ProgramError.InvalidInstructionData);
  const op = data.readU8(0n);
  const rounds = data.readU64(1n);
  const acct = remainingAccounts().get(0n);
  const l = loadRaw<Items>(acct);
  if (op === 0n) {
    // An event for the first element, every round.
    let n = 0n;
    for (let r = 0n; r < rounds; r++)
      for (const x of l.items)
        if (x.value === 1n) {
          emit<Seen>({ value: x.value, round: r, note: "seen" });
          n += 1n;
        }
    log(`emitted ${n}`);
  } else if (op === 1n) {
    // A helper given each element, every round.
    let total = 0n;
    for (let r = 0n; r < rounds; r++) for (const x of l.items) total += weigh(acct, x);
    log(`weighed ${total}`);
  } else if (op === 2n) {
    // Each element's owner formatted (base58), every round.
    let n = 0n;
    for (let r = 0n; r < rounds; r++)
      for (const x of l.items) {
        if (r === 0n) log(`owner ${x.owner}`);
        n += 1n;
      }
    log(`formatted ${n}`);
  }
}
