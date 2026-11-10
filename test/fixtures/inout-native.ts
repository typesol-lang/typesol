// Inout<T> under NATIVE_ACCOUNT_WRITES: two loadRawMut views may be one account (no claim up front), so a helper
// given a place in each has them compared at run time (2040 when they share bytes). test/language/inout.test.ts runs it.
import { instructionData, loadRawMut, log, remainingAccounts } from "typesol";
import { type Recorder, merge } from "./inout-lib.js";

export const NATIVE_ACCOUNT_WRITES = true;

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  const a = loadRawMut<Recorder>(rest.get(0n));
  const b = loadRawMut<Recorder>(rest.get(1n));
  merge(a, b);
  log(`merged ${a.count} ${a.total} ${b.count} ${data.length}`);
}
