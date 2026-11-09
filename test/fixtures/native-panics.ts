// Panics as a native program's own panic handler and allocator leave them: a panic at a location with no log line of
// its own (`panic(null, location)`), and Rust's abort (`abort()`, the allocator's out-of-memory error).
import { ProgramError, abort, instructionData, log, panic, require } from "typesol";

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  // AccountInfo::data_len on a borrowed account: only the runtime's line.
  if (tag === 0n) panic(null, "src/lib.rs:105:19");
  // At this line of this file, still silent.
  if (tag === 1n) panic(null);
  if (tag === 2n) {
    log("Error: memory allocation failed, out of memory");
    abort();
  }
  if (tag === 3n) abort();
  log("no panic");
}
