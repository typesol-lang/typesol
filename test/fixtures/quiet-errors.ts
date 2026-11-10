// Failures that log nothing (`ERROR_LOG_PREFIX = null`, `PROGRAM_ERROR_LOG_PREFIX = null`), as a native program
// returns an error its own checks already explained: the program's errors (code 0 included), a code computed at run
// time, built-in ProgramErrors and programAt's check. test/language/quiet-errors.test.ts also builds it with "" for
// both prefixes, the log line each failure costs.
import { type StakeProgram, type u32, type u8, ProgramError, instructionData, log, programAt, remainingAccounts, require } from "typesol";

export const ERROR_LOG_PREFIX = null;
export const PROGRAM_ERROR_LOG_PREFIX = null;

export enum QuietError {
  /** @code 0 */
  First = "The first error.",
  Second = "The second error.",
}

/** An error code a helper hands back, as a native program's `Result<(), u32>`. */
function codeFor(tag: u8): u32 {
  return tag === 3n ? 40n : 0n;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const tag = data.readU8(0n);
  log("checked by the program itself");
  require(tag !== 0n, QuietError.First);
  require(tag !== 1n, QuietError.Second);
  require(tag !== 2n, ProgramError.IllegalOwner);
  if (tag === 3n || tag === 4n) require(false, codeFor(tag));
  if (tag === 5n) {
    const stake = programAt<StakeProgram>(remainingAccounts().get(0n));
    log(stake.key);
  }
}
