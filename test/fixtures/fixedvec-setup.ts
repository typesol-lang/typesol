// What a local FixedVec costs to set up (test/language/fixedvec-setup.test.ts): its free slots are zeroed once, by the
// memset syscall when large, so `fixedVec([])` costs about the same at any size; the elements of a literal are written
// in place, and a struct literal's FixedVec field is built in the struct itself. The free slots read as zero wherever
// the list's whole layout is copied, even where the stack held other bytes before (tag 5).
import { type FixedVec, type u64, type u8, fixedVec, instructionData, loadRawMut, remainingAccounts, setReturnData } from "typesol";

export interface Rec {
  data: FixedVec<u8, 1280>;
  n: u64;
}

export interface Store {
  bytes: FixedVec<u8, 600>;
  rec: Rec;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const tag = data.readU8(0n);
  if (tag === 0n) {
    const a: FixedVec<u8, 64> = fixedVec([]);
    a.push(1n);
    setReturnData(a);
  } else if (tag === 1n) {
    const a: FixedVec<u8, 1280> = fixedVec([]);
    a.push(1n);
    setReturnData(a);
  } else if (tag === 2n) {
    const a: FixedVec<u8, 1280> = fixedVec([15n]);
    a.push(1n);
    setReturnData(a);
  } else if (tag === 3n) {
    const r: Rec = { data: fixedVec([15n]), n: 0n };
    r.data.push(1n);
    setReturnData(r.data);
  } else if (tag === 4n) {
    const a: FixedVec<u8, 1280> = fixedVec([]);
    a.push(1n);
    a.push(2n);
    a.pop();
    setReturnData(a);
  } else if (tag === 5n) {
    const store = loadRawMut<Store>(remainingAccounts().get(0n));
    {
      // Bytes left on the stack by an earlier list, where the next one may be placed.
      const junk: FixedVec<u8, 600> = fixedVec([]);
      for (let i = 0n; i < 600n; i++) junk.push(0xabn);
      setReturnData(junk);
    }
    {
      const b: FixedVec<u8, 600> = fixedVec([1n, 2n]);
      store.bytes = b;
      const r: Rec = { data: fixedVec([7n]), n: 5n };
      store.rec = r;
    }
  }
}
