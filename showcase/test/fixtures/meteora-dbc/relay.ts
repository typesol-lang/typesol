// A test fixture for showcase/test/meteora-dbc-swap.test.ts (subject to Meteora's Non-commercial Licence, see
// showcase/mainnet/meteora-dbc/LICENSE.md): a program that calls another by CPI, loaded into both VMs, so that the
// DBC runs under a caller and its single-swap guard reads the processed sibling instructions. Its accounts are the
// called program, then that instruction's accounts (passed on with the flags they came with); its data is a count n,
// then the instruction's data, which it sends n times.
import { type FixedVec, type Pubkey, fixedVec, instructionData, invokeInstruction, remainingAccounts, u64 } from "typesol";

interface Meta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

/** @fallback */
export function entry(): void {
  const rest = remainingAccounts();
  const data = instructionData();
  const metas: FixedVec<Meta, 31> = fixedVec([]);
  for (let j = 1n; j < rest.length; j++) metas.push({ pubkey: rest.get(j).key, isSigner: rest.get(j).isSigner, isWritable: rest.get(j).isWritable });
  for (let i = 0n; i < u64(data.get(0n)); i++) invokeInstruction(rest.get(0n).key, metas, data.slice(1n), rest);
}
