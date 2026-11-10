// The owner checks of native views share a cache (test/fixtures/owner-cache.ts): an account viewed once passes the
// next views of it with a pointer compare, but an owner write (assignOwner, closeRaw) or a CPI forgets it, so a view
// made after the account changed hands still fails with 3007, as the 32-byte compare it replaces did.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../src/compiler/index.js";
import { type Deployed, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");

describe("owner checks of native views", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let other: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/owner-cache.ts", import.meta.url)));
    payer = await fundedSigner(d.svm);
    other = (await generateKeyPairSigner()).address;
  });
  const run = async (op: number) => {
    const acct = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: acct, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: Buffer.alloc(48) } as never);
    return send(d.svm, payer, [
      {
        programAddress: d.programId,
        accounts: [
          { address: acct, role: AccountRole.WRITABLE },
          { address: other, role: AccountRole.WRITABLE },
          { address: d.programId, role: AccountRole.READONLY },
        ],
        data: new Uint8Array([op]),
      } as Instruction,
    ]);
  };

  it("passes views of an unchanged account again (in a loop too)", async () => {
    const r = await run(3);
    expect(err(r)).toBe("ok");
    expect(logs(r).filter((l) => l === "Program log: again 0")).toHaveLength(3);
  });

  for (const [op, how] of [
    [0, "assignOwner"],
    [1, "closeRaw"],
    [2, "a CPI (the program calling itself to assign it)"],
  ] as const)
    it(`fails the next view with 3007 after ${how}`, async () => {
      const r = await run(op);
      expect(logs(r)).toContain("Program log: first 0");
      expect(err(r)).toContain("code: 3007 ");
      expect(logs(r).some((l) => l.includes("account not owned by this program (owner-cache.ts:"))).toBe(true);
    });

  it("only programs that make native views carry the cache", () => {
    const c = generate(fileURLToPath(new URL("../fixtures/owner-cache.ts", import.meta.url))).c;
    expect(c).toContain("#define TS_OWNER_CACHE 1");
    expect(c).toContain("params.owned = NULL;");
    const counter = generate(fileURLToPath(new URL("../../examples/counter.ts", import.meta.url))).c;
    expect(counter).not.toMatch(/TS_OWNER|ts_owned/);
  });
});
