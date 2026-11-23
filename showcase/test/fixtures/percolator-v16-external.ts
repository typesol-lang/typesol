// The external oracle reader of the Percolator v16 port (showcase/mainnet/percolator-v16/external.ts; Percolator v16 at
// commit 7b110913, engine 5e3af07, aeyakovenko/percolator-prog, Apache-2.0) behind one native entry, for
// showcase/test/percolator-v16-external.test.ts. The data is now_unix_ts (i64) and now_slot (u64); account 0 receives the
// answer (ExternalAnswer), account 1 is a 424-byte asset oracle profile (changed in place as the reader changes it), the
// others are the legs. The reader returns its error as a value, so the instruction succeeds whatever it answers.
import { type i64, type u8, type u64, instructionData, loadRawAt, loadRawMutAt, remainingAccounts } from "typesol";
import { type ExternalRead, profileHybridSoftStaleMatured, readExternalPriceProfile } from "../../mainnet/percolator-v16/external.js";
import { type AssetOracleProfile } from "../../mainnet/percolator-v16/state.js";
import { readI64 } from "../../mainnet/percolator/wire.js";

export interface ExternalAnswer {
  code: u64;
  price: u64;
  publish_time: i64;
  advanced: u8;
  soft: u8;
}

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  const outAccount = rest.get(0n);
  const profile = rest.get(1n);
  const nowTs = readI64(data, 0n);
  const nowSlot = data.readU64(8n);
  const soft = profileHybridSoftStaleMatured(loadRawAt<AssetOracleProfile>(profile, 0n), nowSlot);
  const read: ExternalRead = { price: 0n, publish_time: 0n, advanced: 0n };
  const code = readExternalPriceProfile(profile, 0n, rest, 2n, rest.length - 2n, outAccount.key, nowTs, read);
  const out = loadRawMutAt<ExternalAnswer>(outAccount, 0n);
  out.code = code;
  out.price = read.price;
  out.publish_time = read.publish_time;
  out.advanced = read.advanced;
  out.soft = soft ? 1n : 0n;
}
