// closeRaw / assignOwner / resizeAccount under NATIVE_ACCOUNT_WRITES: no checks of their own, the runtime judges the
// result as it judges a native program's (a read-only account changed, another program's account drained, an account
// closed into itself).
import { AccountInfo, ProgramError, assignOwner, closeRaw, instructionData, pubkey, remainingAccounts, require, resizeAccount } from "typesol";

export const NATIVE_ACCOUNT_WRITES = true;

const SYSTEM = pubkey("11111111111111111111111111111111");

/** A plain AccountInfo parameter is enough under the flag. */
export function closeParam(account: AccountInfo, receiver: AccountInfo): void {
  closeRaw(account, receiver);
}

/** A plain AccountInfo parameter resized under the flag (the runtime judges a read-only one). */
export function resizeParam(account: AccountInfo): void {
  resizeAccount(account, 3n);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const rest = remainingAccounts();
  if (tag === 0n) closeRaw(rest.get(0n), rest.get(1n));
  if (tag === 2n) {
    resizeAccount(rest.get(0n), 0n);
    assignOwner(rest.get(0n), SYSTEM);
  }
  if (tag === 3n) resizeAccount(rest.get(0n), data.readU64(1n));
}
