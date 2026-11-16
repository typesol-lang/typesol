// `executable` on a remaining account (AccountInfo::executable), as a native program checks a program passed among its
// accounts before it calls it (Percolator v12.20's TradeCpi checks its matcher program and context this way).
import { ProgramError, remainingAccounts, require } from "typesol";

/** @fallback */
export function entry(): void {
  const rest = remainingAccounts();
  require(rest.length === 2n, ProgramError.NotEnoughAccountKeys);
  require(rest.get(0n).executable, ProgramError.InvalidAccountData);
  require(!rest.get(1n).executable, ProgramError.InvalidArgument);
}
