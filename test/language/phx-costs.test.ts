// What Phoenix's matching engine and cancels repeat, in compute units (test/fixtures/phx-costs.ts): a cancel by node
// index, walks of a 400-order book, min / max / get / addrOf, views of one account made again and again, a struct
// handed to helpers that take accounts, and a Reduce event by pushBorsh against pushLE.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const CAP = 512;
const ORDERS = 400;
const u64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

describe("Phoenix's hot paths", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let market: Address;
  let nonce = 0;
  const orders: [bigint, bigint, number][] = [];
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/phx-costs.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 100n);
    market = (await generateKeyPairSigner()).address;
    const data = Buffer.alloc(40 + 32 + CAP * 64);
    data.writeBigUInt64LE(11n, 24);
    data.writeBigUInt64LE(22n, 32);
    d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data } as never);
    await run(0);
    let x = 12345n;
    for (let i = 0; i < ORDERS; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      const o: [bigint, bigint, number] = [1000n + ((x >> 33n) % 300n), BigInt(i + 1), i + 1];
      orders.push(o);
      await run(1, o[0], o[1], o[2]);
    }
  }, 300_000);

  const snapshot = () => Buffer.from((d.svm.getAccount(market) as { data: Uint8Array }).data);
  const restore = (data: Buffer) =>
    d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data } as never);

  async function run(op: number, a: bigint | number = 0, b: bigint | number = 0, c: bigint | number = 0, n: number = CAP) {
    const data = Buffer.concat([Buffer.from([op]), u64(n), u64(a), u64(b), u64(c), u64(nonce++)]);
    const r: Result = await send(d.svm, payer, [
      { programAddress: d.programId, accounts: [{ address: market, role: AccountRole.WRITABLE }], data: new Uint8Array(data) } as Instruction,
    ]);
    if (r instanceof FailedTransactionMetadata) throw new Error(`failed: ${String(r.err())}\n${r.meta().logs().join("\n")}`);
    const acct = d.svm.getAccount(market) as { data: Uint8Array };
    const out = Buffer.from(acct.data);
    return {
      cu: Number(r.computeUnitsConsumed()),
      a: out.readBigUInt64LE(0),
      b: out.readBigUInt64LE(8),
      c: out.readBigUInt64LE(16),
      ret: r.returnData().data(),
    };
  }

  it("measures", async () => {
    const base = (await run(9)).cu;
    const walk = await run(6);
    expect(walk.a).toBe(BigInt(ORDERS));
    // 59 CU per node before (three bounds checks per node, the stack by index): one check per node now.
    expect((walk.cu - base) / ORDERS).toBeLessThan(45);
    const rev = await run(7);
    const ro = await run(10);
    const mid = orders[200]!;
    const lines = [
      `walk per node ${((walk.cu - base) / ORDERS).toFixed(1)}`,
      `reversed per node ${((rev.cu - base) / ORDERS).toFixed(1)}`,
      `read-only walk total ${ro.cu}`,
      `min ${(await run(4)).cu - base}`,
      `max ${(await run(5)).cu - base}`,
      `get ${(await run(3, mid[0], mid[1])).cu - base}`,
      `addrOf ${(await run(8, mid[0], mid[1])).cu - base}`,
    ];
    // The same cancel by node index and by key, from the same book: the same bytes, one search less.
    const saved = snapshot();
    const cancel = await run(2, mid[0], mid[1], mid[2]);
    expect(cancel.a).toBe(1n);
    const afterIndex = snapshot().subarray(40);
    restore(saved);
    const cancelByKey = await run(12, mid[0], mid[1], mid[2]);
    expect(cancelByKey.a).toBe(1n);
    expect(snapshot().subarray(40).equals(afterIndex)).toBe(true);
    restore(saved);
    lines.push(`cancel removeAt ${cancel.cu - base}`, `cancel remove(key) ${cancelByKey.cu - base}`);
    // 691 → 547 CU: the second search (about the cost of addrOf) is gone.
    expect(cancelByKey.cu - cancel.cu).toBeGreaterThan(120);
    const viewBase = (await run(29, 0, 0, 0, 100)).cu;
    const pass = async (op: number) => ((await run(op, 0, 0, 0, 100)).cu - viewBase) / 100;
    const views = [await pass(20), await pass(21), await pass(22), await pass(23)];
    views.forEach((v, i) => lines.push(`views op ${20 + i} per pass ${v.toFixed(1)}`));
    // The owner check of a view made again (in a loop that writes the account, in each helper call): a pointer
    // compare (ts_owned). Before: 21.0, 35.0, 54.4 and 97.6 CU per pass.
    expect(views[0]).toBeLessThan(17);
    expect(views[1]).toBeLessThan(25);
    // A helper passing its struct parameter on to another helper taking accounts: in place, not copied (97.6 CU per
    // pass before, against 54.4 for the direct call).
    expect(views[3] - views[2]).toBeLessThan(5);
    const ev0 = (await run(30, 0, 0, 0, 0)).cu;
    const evB = await run(30, 0, 0, 0, 100);
    const evL = await run(31, 0, 0, 0, 100);
    expect(Buffer.from(evB.ret)).toEqual(Buffer.from(evL.ret));
    lines.push(`pushBorsh per event ${((evB.cu - ev0) / 100).toFixed(1)}`, `pushLE per event ${((evL.cu - ev0) / 100).toFixed(1)}`);
    console.log(lines.join("\n"));
  });
});
