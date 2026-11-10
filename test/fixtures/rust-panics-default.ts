// panicsAt without PANIC_STYLE: Rust's overflow message logged, then sol_panic_ at the location ("SBF program Panicked
// in <file> at <line>:<col>"), as panic(message, location) does; arithmetic outside it still fails with 5100 / 5101.
import { ProgramError, instructionData, log, panicsAt, require } from "typesol";

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 17n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const a = data.readU64(1n);
  const b = data.readU64(9n);
  if (tag === 0n) log(`${panicsAt("src/quantities.rs:233:1", a + b)}`);
  if (tag === 1n) log(`${a + b}`);
  if (tag === 2n) log(`${panicsAt("src/quantities.rs:240:1", a / b)}`);
  if (tag === 3n) log(`${a / b}`);
}
