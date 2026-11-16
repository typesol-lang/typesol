// Three native-port primitives Percolator v12.20 needs (showcase/mainnet/percolator): `log64` (Rust's sol_log_64,
// five hex words on one line), `zeroData` (a memset of account data, as `for b in data.iter_mut() { *b = 0 }`
// compiles) and PANIC_STYLE "solana-1.18" (a panic logged as solana-program 1.18's handler logs it, then abort).
import { ProgramError, instructionData, log64, panic, programId, remainingAccounts, require, zeroData } from "typesol";

export const PANIC_STYLE = "solana-1.18";

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  if (tag === 0n) log64(data.readU64(1n), data.readU64(9n), data.readU64(17n), data.readU64(25n), data.readU64(33n));
  else if (tag === 1n) {
    const rest = remainingAccounts();
    require(rest.get(0n).owner === programId(), ProgramError.IllegalOwner);
    zeroData(rest.get(0n), data.readU64(1n), data.readU64(9n));
  } else if (tag === 2n) panic("mul_div_floor_u128: a*b overflow", "src/wide_math.rs:1554:30");
  else panic("unknown tag");
}
