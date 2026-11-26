// `copyData(account, from, to, length)`: a copy within one account's data with the memmove syscall (Percolator v16's
// InitMarket copies asset 0's 424-byte oracle profile into every slot of the market this way). The account must be
// this program's: the fixture checks the owner first, as a program using it must.
import { ProgramError, copyData, instructionData, programId, remainingAccounts, require } from "typesol";

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 25n, ProgramError.InvalidInstructionData);
  const rest = remainingAccounts();
  require(rest.get(0n).owner === programId(), ProgramError.IllegalOwner);
  copyData(rest.get(0n), data.readU64(0n), data.readU64(8n), data.readU64(16n));
}
