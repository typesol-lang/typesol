// A caller program for the Phoenix tests: it invokes another program with instruction data and accounts of the
// test's choosing, so that a test can reach what only a CPI reaches (instruction data past the 1,232 bytes of a
// transaction, up to the runtime's 10,240 for a CPI).
//
// Accounts: the program to call, an account whose data holds the instruction data (a u32 length, then the bytes),
// then the accounts to pass on, each with the flags it was passed with (all of them go to the runtime as the CPI's
// account infos). The forwarder's own instruction data is ignored.
import { type FixedVec, type Pubkey, type u8, type u32, ProgramError, fixedVec, invokeInstruction, readData, remainingAccounts, require, u64 } from "typesol";

export const MAX_ACCOUNTS = 255n;
/** Its lists (10 KiB of data, 253 metas, the CPI's account infos) need more than 32 KiB: the tests request the frame. */
export const HEAP_SIZE_KIB = 256n;

interface Meta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

/** @fallback */
export function forward(): void {
  const rest = remainingAccounts();
  require(rest.length >= 2n, ProgramError.NotEnoughAccountKeys);
  const source = rest.get(1n);
  const len = u64(readData<u32>(source, 0n));
  /** @heap */
  const data: FixedVec<u8, 10240> = fixedVec([]);
  for (let i = 0n; i < len; i++) data.push(readData<u8>(source, 4n + i));
  /** @heap */
  const metas: FixedVec<Meta, 253> = fixedVec([]);
  for (let i = 2n; i < rest.length; i++) {
    const a = rest.get(i);
    metas.push({ pubkey: a.key, isSigner: a.isSigner, isWritable: a.isWritable });
  }
  invokeInstruction(rest.get(0n).key, metas, data, rest);
}
