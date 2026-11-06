// A native (non-Anchor) program's shape: one @fallback entry over the raw instruction data and accounts by position,
// a discriminator-less account, built-in ProgramErrors, panics, and errors from code 0 logged as its entrypoint does.
import {
  ProgramError,
  createProgramAddress,
  instructionData,
  isqrt,
  log,
  logBase64,
  loadRaw,
  loadRawMut,
  panic,
  programId,
  remainingAccounts,
  require,
  type Pubkey,
  u128,
  u256,
  u64,
  u8,
} from "typesol";

export const PANIC_ON_OVERFLOW = true;
export const ERROR_LOG_PREFIX = "Native error: ";
export const PROGRAM_ERROR_LOG_PREFIX = "Program error: ";

export interface Counter {
  owner: Pubkey;
  count: u64;
  total: u128;
}

export interface Record {
  kind: u8;
  value: u64;
  who: Pubkey;
}

export enum NativeError {
  /** @code 0 */
  NotOwner = "Not the owner.",
  TooSmall = "Too small.",
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const rest = remainingAccounts();
  if (tag === 0n) {
    // Bump the counter by a u64 at byte 1; the owner signs.
    require(rest.length >= 2n, ProgramError.NotEnoughAccountKeys);
    const c = loadRawMut<Counter>(rest.get(0n));
    require(rest.get(1n).isSigner && rest.get(1n).key === c.owner, NativeError.NotOwner);
    const by = data.readU64(1n);
    require(by > 0n, NativeError.TooSmall);
    c.count += by; // overflow panics (PANIC_ON_OVERFLOW)
    c.total = c.total + u128(by) * u128(by);
    const r: Record = { kind: 7n, value: c.count, who: c.owner };
    logBase64("record: ", r);
    return;
  }
  if (tag === 1n) {
    // Read-only view, a PDA with an explicit bump, and a u256 square root.
    const c = loadRaw<Counter>(rest.get(0n));
    const pda = createProgramAddress(["vault", u8(u64(data.readU8(1n)))], programId());
    if (pda === null) log("no address");
    else log(pda!);
    log(`sqrt ${isqrt(u256(c.total) * u256(c.total))}`);
    return;
  }
  if (tag === 2n) panic("not implemented: tag 2", "program/src/lib.rs:12:5");
  require(false, ProgramError.InvalidInstructionData);
}
