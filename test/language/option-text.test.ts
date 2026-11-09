// Options of Pubkeys and Hashes in template strings and `+` (test/fixtures/option-text.ts): after `x !== null` the
// value's base58, and an Option that may be null prints as JS prints it ("null"), from account data, locals, struct
// locals and createProgramAddress.
import { type Address, AccountRole, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, deployFile, fundedSigner, pda, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const enc = getAddressEncoder();

describe("Option<Pubkey> as text", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let pool: Address;
  let who: Address;
  let root: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/option-text.ts", import.meta.url)));
    payer = await fundedSigner(d.svm);
    pool = (await generateKeyPairSigner()).address;
    who = (await generateKeyPairSigner()).address;
    root = getAddressDecoder().decode(new Uint8Array(32).fill(7));
  });
  const put = (preferred: Address | null, hash: Address | null, fee: bigint | null) => {
    const data = Buffer.alloc(75);
    if (preferred) ((data[0] = 1), Buffer.from(enc.encode(preferred)).copy(data, 1));
    if (hash) ((data[33] = 1), Buffer.from(enc.encode(hash)).copy(data, 34));
    if (fee !== null) ((data[66] = 1), data.writeBigUInt64LE(fee, 67));
    d.svm.setAccount({ address: pool, lamports: 10_000_000n, programAddress: d.programId, executable: false, data } as never);
  };
  let nonce = 0;
  const call = (pickLocal: boolean, bump = 255) =>
    send(d.svm, payer, [
      {
        programAddress: d.programId,
        accounts: [{ address: pool, role: AccountRole.READONLY }],
        data: new Uint8Array([pickLocal ? 1 : 0, bump, nonce++ & 0xff]),
      },
    ]);

  it("joins a narrowed Option<Pubkey> as its base58", async () => {
    put(who, root, 5n);
    const [vault, bump] = await pda(d.programId, ["vault"]);
    const r = await call(true, bump);
    expect(err(r)).toBe("ok");
    expect(logs(r)).toEqual(
      expect.arrayContaining([
        `Program log: preferred ${who}`,
        `Program log: field ${who}`,
        `Program log: always ${who} root ${root} fee 5`,
        `Program log: root ${root}`,
        `Program log: local ${who}`,
        `Program log: pick ${who}`,
        `Program log: pda ${vault}`,
      ]),
    );
  });

  it("joins an empty Option as null, as JS does", async () => {
    put(null, null, null);
    const r = await call(false);
    expect(err(r)).toBe("ok");
    expect(logs(r)).toEqual(expect.arrayContaining(["Program log: none null", "Program log: always null root null fee null", "Program log: local null"]));
    expect(logs(r).some((l) => l.startsWith("Program log: field ") || l.startsWith("Program log: pick "))).toBe(false);
  });
});
