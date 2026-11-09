// Options of Pubkeys (and Hashes) joined into text: narrowed after `!== null` (the value), or not (null prints as null,
// as in JS), from account data, a local, a struct local and a function's result.
import {
  type Hash,
  type Option,
  type Pubkey,
  createProgramAddress,
  instructionData,
  loadRaw,
  log,
  programId,
  remainingAccounts,
  u64,
  u8,
} from "typesol";

export interface Pool {
  preferred: Option<Pubkey>;
  root: Option<Hash>;
  fee: Option<u64>;
}

export interface Pick {
  who: Option<Pubkey>;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const pool = loadRaw<Pool>(remainingAccounts().get(0n));
  const pref = pool.preferred;
  if (pref !== null) log(`preferred ${pref}`);
  else log(`none ${pref}`);
  if (pool.preferred !== null) log("field " + pool.preferred);
  log(`always ${pool.preferred} root ${pool.root} fee ${pool.fee}`);
  if (pool.root !== null) log(`root ${pool.root}`);
  const local: Option<Pubkey> = data.readU8(0n) === 1n ? pool.preferred : null;
  log(`local ${local}`);
  const pick: Pick = { who: pool.preferred };
  if (pick.who !== null) log(`pick ${pick.who}`);
  const pda = createProgramAddress(["vault", u8(u64(data.readU8(1n)))], programId());
  if (pda !== null) log(`pda ${pda}`);
}
