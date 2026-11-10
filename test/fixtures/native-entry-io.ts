// A native entry's own return data and compute-unit log lines: `setReturnData(bytes)` from the @fallback entry and its
// helpers (Phoenix sets the ids of the orders that rested), `logComputeUnits()` (sol_log_compute_units, Phoenix's
// cancel and withdraw paths), and an exported instruction whose return value replaces what a helper set.
import { FixedVec, InstructionBytes, ProgramError, fixedVec, instructionData, log, logComputeUnits, require, setReturnData, u64, u8 } from "typesol";

function stash(data: InstructionBytes): void {
  setReturnData(data.slice(1n));
}

function orderIds(count: u64): void {
  // Borsh Vec<u64>: the length as u32, then each id.
  const out: FixedVec<u8, 68> = fixedVec([u8(count), 0n, 0n, 0n]);
  for (let i = 0n; i < count; i++) {
    out.push(u8(i + 1n));
    for (let k = 0n; k < 7n; k++) out.push(0n);
  }
  setReturnData(out);
}

/** The helper's return data is replaced by the instruction's own return value, set last. */
export function answer(): u64 {
  orderIds(2n);
  return 42n;
}

/** A void instruction may set return data too. */
export function echo(): void {
  orderIds(1n);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  if (tag === 0n) {
    logComputeUnits();
    log("between");
    logComputeUnits();
    return;
  }
  // The data after the tag, as it came.
  if (tag === 1n) {
    stash(data);
    return;
  }
  // Built in a local list by a helper.
  if (tag === 2n) {
    orderIds(u64(data.readU8(1n)));
    return;
  }
  // The last call wins; an empty list clears it.
  if (tag === 3n) {
    setReturnData(data.slice(1n));
    const none: FixedVec<u8, 1> = fixedVec([]);
    setReturnData(none);
    return;
  }
  // More than 1024 bytes: the runtime refuses it, as it refuses the Rust call.
  if (tag === 4n) {
    const big: FixedVec<u8, 1100> = fixedVec([]);
    for (let i = 0n; i < 1025n; i++) big.push(7n);
    setReturnData(big);
    return;
  }
  log("no return data");
}
