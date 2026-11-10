// A native program's account lifecycle on remaining accounts and AccountInfo parameters: closeRaw (Phoenix's Tombstone:
// lamports to the receiver, assign to the System Program, realloc to 0, data not wiped), assignOwner and resizeAccount,
// with the checks a program gets without NATIVE_ACCOUNT_WRITES (writable, passed once, owned by this program).
import {
  AccountInfo,
  Mut,
  ProgramError,
  RemainingAccount,
  assignOwner,
  closeRaw,
  instructionData,
  pubkey,
  remainingAccounts,
  require,
  resizeAccount,
} from "typesol";

const SYSTEM = pubkey("11111111111111111111111111111111");

function tombstone(market: RemainingAccount, receiver: RemainingAccount): void {
  closeRaw(market, receiver);
}

/** The declared-parameter form. */
export function closeParam(account: Mut<AccountInfo>, receiver: Mut<AccountInfo>): void {
  closeRaw(account, receiver);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const rest = remainingAccounts();
  if (tag === 0n) closeRaw(rest.get(0n), rest.get(1n));
  // Through a helper's RemainingAccount parameters.
  if (tag === 1n) tombstone(rest.get(0n), rest.get(1n));
  // Emptied and handed to the System Program, its lamports kept.
  if (tag === 2n) {
    resizeAccount(rest.get(0n), 0n);
    assignOwner(rest.get(0n), SYSTEM);
  }
  // Resized to the u64 after the tag (new bytes zeroed; at most 10 KiB past the size it started with).
  if (tag === 3n) resizeAccount(rest.get(0n), data.readU64(1n));
  // Grown twice in one instruction: the limit is against the size it started with, not the last one.
  if (tag === 4n) {
    resizeAccount(rest.get(0n), data.readU64(1n));
    resizeAccount(rest.get(0n), data.readU64(9n));
  }
  // Assigned without being emptied: the runtime refuses an owner change of an account with data left.
  if (tag === 5n) assignOwner(rest.get(0n), SYSTEM);
}
