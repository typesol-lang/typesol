// Read-only list parameters given the caller's own lists (test/language/list-params.test.ts): a local FixedVec of
// integers or structs, a FixedVec field of a local struct, a Vec<T> parameter given a FixedVec, and a FixedVec in
// account data, read in place or (when the helper takes accounts, and so may write it) copied first, as a struct
// argument is.
import {
  type FixedVec,
  type Pubkey,
  type RemainingAccount,
  type Vec,
  type u64,
  u8,
  fixedVec,
  instructionData,
  loadRawMut,
  remainingAccounts,
  setReturnData,
} from "typesol";

export interface Meta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Batch {
  ids: FixedVec<u64, 8>;
  tag: u8;
}

export interface Store {
  ids: FixedVec<u64, 8>;
}

function sum(ids: FixedVec<u64, 8>): u64 {
  return ids.reduce((acc, x) => acc + x, 0n);
}

function signers(metas: FixedVec<Meta, 4>): u64 {
  let n = 0n;
  for (const m of metas) if (m.isSigner) n += 1n;
  return n;
}

function total(xs: Vec<u64>): u64 {
  let t = 0n;
  for (let i = 0n; i < xs.length; i++) t += xs.get(i);
  return t;
}

/** Takes an account too (it could write the one the list lives in), so a list in account data is copied for it. */
function sumWith(acct: RemainingAccount, ids: FixedVec<u64, 8>): u64 {
  return sum(ids) + (acct.isWritable ? 100n : 0n);
}

function bytesOut(b: FixedVec<u8, 32>): void {
  setReturnData(b);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const tag = data.readU8(0n);
  const out: FixedVec<u8, 32> = fixedVec([]);
  if (tag === 0n) {
    const ids: FixedVec<u64, 8> = fixedVec([1n, 2n, 3n]);
    ids.push(4n);
    const metas: FixedVec<Meta, 4> = fixedVec([]);
    const rest = remainingAccounts();
    for (let i = 0n; i < rest.length; i++) metas.push({ pubkey: rest.get(i).key, isSigner: rest.get(i).isSigner, isWritable: false });
    const b: Batch = { ids: fixedVec([10n, 20n]), tag: 1n };
    out.pushLE(sum(ids));
    out.pushLE(small(signers(metas)));
    out.pushLE(sum(b.ids) + total(ids));
    bytesOut(out);
  } else if (tag === 1n) {
    const acct = remainingAccounts().get(0n);
    const store = loadRawMut<Store>(acct);
    const inPlace = sum(store.ids);
    const copied = sumWith(acct, store.ids);
    out.pushLE(inPlace);
    out.pushLE(copied);
    bytesOut(out);
  }
}

function small(x: u64): u8 {
  return x < 256n ? u8(x) : 255n;
}
