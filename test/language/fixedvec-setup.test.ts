// A local FixedVec's setup (test/fixtures/fixedvec-setup.ts): constant compute units at any capacity, elements and
// struct-literal fields written in place, and free slots that read as zero when the whole list is copied out.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
const ok = (r: Result) => {
  if (r instanceof FailedTransactionMetadata) throw new Error(`${String(r.err())}\n${r.meta().logs().join("\n")}`);
  return r;
};

describe("local FixedVec setup", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let nonce = 0;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/fixedvec-setup.ts", import.meta.url)));
    payer = await fundedSigner(d.svm);
  });
  const call = (tag: number, accounts: Address[] = []) =>
    send(d.svm, payer, [
      {
        programAddress: d.programId,
        accounts: accounts.map((address) => ({ address, role: AccountRole.WRITABLE })),
        data: new Uint8Array([tag, nonce++ & 0xff, nonce >> 8]),
      } as Instruction,
    ]);
  const run = async (tag: number) => {
    const r = ok(await call(tag));
    return { cu: Number(r.computeUnitsConsumed()), data: Buffer.from(r.returnData().data()) };
  };

  it("costs about the same at 64 and 1280 elements, with or without a first element, or as a struct's field", async () => {
    const small = await run(0);
    const empty = await run(1);
    const one = await run(2);
    const field = await run(3);
    const popped = await run(4);
    expect(small.data).toEqual(Buffer.from([1]));
    expect(empty.data).toEqual(Buffer.from([1]));
    expect(one.data).toEqual(Buffer.from([15, 1]));
    expect(field.data).toEqual(Buffer.from([15, 1]));
    expect(popped.data).toEqual(Buffer.from([1]));
    // 1,436 / 3,216 / 2,571 CU before (each slot zeroed twice, a temporary copied); now the memset syscall, about
    // 10 CU, and the elements themselves.
    for (const r of [empty, one, field, popped]) expect(r.cu - small.cu).toBeLessThan(20);
  });

  it("copies zeros past the length into account data, whatever the stack held", async () => {
    const store = (await generateKeyPairSigner()).address;
    const size = 4 + 600 + (4 + 1280 + 8);
    d.svm.setAccount({
      address: store,
      lamports: 100_000_000n,
      programAddress: d.programId,
      executable: false,
      data: new Uint8Array(size).fill(0xcd),
    } as never);
    const r = ok(await call(5, [store]));
    expect(Buffer.from(r.returnData().data())).toEqual(Buffer.alloc(600, 0xab));
    const a = d.svm.getAccount(store);
    if (!a.exists) throw new Error("store is gone");
    const want = Buffer.alloc(size);
    want.writeUInt32LE(2, 0);
    want[4] = 1;
    want[5] = 2;
    want.writeUInt32LE(1, 604);
    want[608] = 7;
    want.writeBigUInt64LE(5n, 608 + 1280);
    expect(Buffer.from(a.data).equals(want)).toBe(true);
    expect(meta(r).computeUnitsConsumed()).toBeGreaterThan(0n);
  });
});
