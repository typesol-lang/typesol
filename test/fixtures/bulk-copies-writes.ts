// bulk-copies.ts's struct copies under NATIVE_ACCOUNT_WRITES, where an account passed twice gives two views of one
// buffer (as a native program's two AccountInfos): a copy between them may overlap, and goes through memmove.
import { type FixedArray, type u8, type u64, ProgramError, instructionData, loadRawAt, loadRawMutAt, remainingAccounts, require } from "typesol";

export const NATIVE_ACCOUNT_WRITES = true;

export interface B80 {
  head: u64;
  rest: FixedArray<u8, 72>;
}
export interface B1024 {
  head: u64;
  rest: FixedArray<u8, 1016>;
}
export interface H80 {
  v: B80;
}
export interface H1024 {
  v: B1024;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 17n, ProgramError.InvalidInstructionData);
  const rest = remainingAccounts();
  if (data.readU8(0n) === 1n) {
    const d = loadRawMutAt<H80>(rest.get(0n), data.readU64(1n));
    d.v = loadRawAt<H80>(rest.get(1n), data.readU64(9n)).v;
  } else {
    const d = loadRawMutAt<H1024>(rest.get(0n), data.readU64(1n));
    d.v = loadRawAt<H1024>(rest.get(1n), data.readU64(9n)).v;
  }
}
