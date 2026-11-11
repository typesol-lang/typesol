// Native views' owner checks share a cache (ts_owned): an account found this program's passes again with a pointer
// compare, until a CPI or an owner write. Each operation views account 0, changes its owner (assignOwner, closeRaw,
// or a self-CPI to op 9 that assigns it), then views it again: the second view must fail with 3007 as it always did.
import {
  type FixedVec,
  type Pubkey,
  type u8,
  type u64,
  assignOwner,
  closeRaw,
  fixedVec,
  instructionData,
  invokeInstruction,
  loadRaw,
  loadRawAt,
  log,
  programId,
  rbTreeAt,
  remainingAccounts,
} from "typesol";

export const NATIVE_ACCOUNT_WRITES = true;

export interface Meta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Head {
  x: u64;
  y: u64;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  const op = data.readU8(0n);
  const acct = rest.get(0n);
  if (op === 9n) {
    // the self-CPI's callee: hand the account to the other program
    assignOwner(acct, rest.get(1n).key);
    return;
  }
  const a = loadRaw<Head>(acct);
  log(`first ${a.x}`);
  if (op === 0n) {
    assignOwner(acct, rest.get(1n).key);
  } else if (op === 1n) {
    closeRaw(acct, rest.get(1n));
  } else if (op === 2n) {
    const metas: FixedVec<Meta, 2> = fixedVec([
      { pubkey: acct.key, isSigner: false, isWritable: true },
      { pubkey: rest.get(1n).key, isSigner: false, isWritable: false },
    ]);
    const ix: FixedVec<u8, 1> = fixedVec([9n]);
    invokeInstruction(programId(), metas, ix, rest);
  }
  // op 3: nothing changes; views of the same account in a loop all pass
  for (let k = 0n; k < 3n; k++) {
    const b = loadRawAt<Head>(acct, 0n);
    const t = rbTreeAt<u64, u64>(acct, 16n, 0n);
    log(`again ${b.y + t.capacity}`);
  }
}
