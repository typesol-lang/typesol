// A relay for the environment fuzzer of showcase/mainnet/percolator (percolator-mutate-env.test.ts): it calls the
// program named by its first account with the rest of its accounts (each with the flags it was passed with) and its
// instruction data after the first byte, that byte giving the number of calls (0 to call nothing). So every
// Percolator instruction can be sent at stack height 2, once or several times in one instruction.
import { type FixedVec, type Pubkey, ProgramError, fixedVec, u64, instructionData, invokeInstruction, remainingAccounts, require } from "typesol";

export const MAX_ACCOUNTS = 64n;

interface Meta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

/** @fallback */
export function relay(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  require(data.length >= 1n && rest.length >= 1n, ProgramError.InvalidInstructionData);
  const times = u64(data.readU8(0n));
  /** @heap */
  const metas: FixedVec<Meta, 63> = fixedVec([]);
  for (let i = 1n; i < rest.length; i++) {
    const a = rest.get(i);
    metas.push({ pubkey: a.key, isSigner: a.isSigner, isWritable: a.isWritable });
  }
  for (let k = 0n; k < times; k++) invokeInstruction(rest.get(0n).key, metas, data.slice(1n, data.length), rest);
}
