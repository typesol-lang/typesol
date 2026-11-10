// What Phoenix's matching engine and cancels repeat, in compute units (test/fixtures/phx-costs.ts): a cancel by node
// index, walks of a 400-order book, min / max / get / addrOf, views of one account made again and again, a struct
// handed to helpers that take accounts, and a Reduce event by pushBorsh against pushLE.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const CAP = 512;
const ORDERS = 400;
const u16le = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
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

  /**
   * Every measured figure, in compute units, with its upper bound (the figure as measured plus 2–3%): a change
   * that makes any of these paths dearer fails here, not only the ones compared below.
   */
  const LIMITS: Record<string, number> = {
    "baseline (the tree made, nothing done)": 115,
    "walk of 400": 16_500,
    "reversed walk of 400": 16_100,
    "read-only walk of 400": 14_150,
    min: 190,
    max: 180,
    get: 285,
    addrOf: 275,
    "cancel by removeAt": 670,
    "cancel by remove(key)": 815,
    "views baseline (100 passes)": 90,
    "views op 20 (100 passes)": 1630,
    "views op 21 (100 passes)": 2250,
    "views op 22 (100 passes)": 4530,
    "views op 23 (100 passes)": 4530,
    "events baseline": 190,
    "100 events by pushBorsh": 2550,
    "100 events by pushLE": 2550,
  };

  it("measures", async () => {
    const cu: Record<string, number> = {};
    const base = await run(9);
    cu["baseline (the tree made, nothing done)"] = base.cu;
    expect(base.c, "the tree's length").toBe(BigInt(ORDERS));
    // The book in order: asks (sequence numbers below 2⁶³) by price, then by sequence number; the trader index of
    // each order is its sequence number.
    const sorted = [...orders].sort(([pa, sa], [pb, sb]) => (pa !== pb ? Number(pa - pb) : Number(sa - sb)));
    const traders = BigInt((ORDERS * (ORDERS + 1)) / 2);
    const walk = await run(6);
    cu["walk of 400"] = walk.cu;
    expect([walk.a, walk.b], "the walk's count and sum of trader indexes").toEqual([BigInt(ORDERS), traders]);
    // 59 CU per node before (three bounds checks per node, the stack by index): one check per node now.
    expect((walk.cu - base.cu) / ORDERS).toBeLessThan(45);
    const rev = await run(7);
    cu["reversed walk of 400"] = rev.cu;
    expect([rev.a, rev.b], "the reversed walk's count and sum").toEqual([BigInt(ORDERS), traders]);
    const ro = await run(10);
    cu["read-only walk of 400"] = ro.cu;
    expect(Buffer.from(ro.ret).readBigUInt64LE(0), "the read-only walk's sum").toBe(traders);
    const min = await run(4);
    cu.min = min.cu;
    expect(min.a, "min: the lowest ask, first in time").toBe(BigInt(sorted[0]![2]));
    const max = await run(5);
    cu.max = max.cu;
    expect(max.a, "max: the highest ask, last in time").toBe(BigInt(sorted[ORDERS - 1]![2]));
    const mid = orders[200]!;
    const got = await run(3, mid[0], mid[1]);
    cu.get = got.cu;
    expect(got.a, "get: the order's trader index").toBe(BigInt(mid[2]));
    const missing = await run(3, mid[0], 999_999n);
    expect(missing.a, "get of a key not in the tree").toBe(0n);
    const at = await run(8, mid[0], mid[1]);
    cu.addrOf = at.cu;
    // Nothing was removed, so the 201st insert took node 201.
    expect(at.a, "addrOf: the order's node").toBe(201n);
    // The same cancel by node index and by key, from the same book: the same bytes, one search less.
    const saved = snapshot();
    const cancel = await run(2, mid[0], mid[1], mid[2]);
    cu["cancel by removeAt"] = cancel.cu;
    expect([cancel.a, cancel.c], "removeAt: the order's lots, one order fewer").toEqual([1n, BigInt(ORDERS - 1)]);
    const afterIndex = snapshot().subarray(40);
    restore(saved);
    const cancelByKey = await run(12, mid[0], mid[1], mid[2]);
    cu["cancel by remove(key)"] = cancelByKey.cu;
    expect([cancelByKey.a, cancelByKey.c], "remove(key): the order's lots, one order fewer").toEqual([1n, BigInt(ORDERS - 1)]);
    expect(snapshot().subarray(40).equals(afterIndex)).toBe(true);
    restore(saved);
    // 691 → 547 CU: the second search (about the cost of addrOf) is gone.
    expect(cancelByKey.cu - cancel.cu).toBeGreaterThan(120);
    const viewBase = await run(29, 0, 0, 0, 100);
    cu["views baseline (100 passes)"] = viewBase.cu;
    const views: number[] = [];
    for (const op of [20, 21, 22, 23]) {
      const v = await run(op, 0, 0, 0, 100);
      cu[`views op ${op} (100 passes)`] = v.cu;
      views.push((v.cu - viewBase.cu) / 100);
    }
    // The owner check of a view made again (in a loop that writes the account, in each helper call): a pointer
    // compare (ts_owned). Before: 21.0, 35.0, 54.4 and 97.6 CU per pass.
    expect(views[0]).toBeLessThan(17);
    expect(views[1]).toBeLessThan(25);
    // A helper passing its struct parameter on to another helper taking accounts: in place, not copied (97.6 CU per
    // pass before, against 54.4 for the direct call).
    expect(views[3]! - views[2]!).toBeLessThan(5);
    const ev0 = await run(30, 0, 0, 0, 0);
    cu["events baseline"] = ev0.cu;
    const evB = await run(30, 0, 0, 0, 100);
    cu["100 events by pushBorsh"] = evB.cu;
    const evL = await run(31, 0, 0, 0, 100);
    cu["100 events by pushLE"] = evL.cu;
    expect(Buffer.from(evB.ret)).toEqual(Buffer.from(evL.ret));
    // The last of the 100 Reduce events (index 99): tag 4 there, written as the enum's variant 3 here.
    expect(Buffer.from(evB.ret)).toEqual(Buffer.concat([Buffer.from([15, 3]), u16le(99), u64(106), u64(100), u64(99), u64(9)]));
    // Fill (a Pubkey among integers), Moved (a struct field, a bool, an enum) and Flagged: Borsh, field by field.
    const id = Buffer.from(getAddressEncoder().encode(d.programId));
    const fill = Buffer.concat([Buffer.from([2]), u16le(0), id, u64(1), u64(2), u64(3), u64(4)]);
    const moved = Buffer.concat([Buffer.from([4, 7, 0, 0, 0, 0xfe, 0xff, 1, 1]), id]);
    // Flagged: a bool and an enum by direct stores, its fields given out of order (written in declared order)
    const flagged = Buffer.from([5, 1, 1, 0x01, 0x02, 0, 0]);
    expect(Buffer.from((await run(32, 0, 0, 0, 1)).ret)).toEqual(Buffer.concat([Buffer.from([15]), fill, moved, flagged]));
    // 54 CU per event before (the whole 92-byte enum zeroed, filled and copied, then a tag and a switch on it): now
    // within a few units of the six pushLE calls writing the same 35 bytes.
    expect((evB.cu - evL.cu) / 100).toBeLessThan(5);
    console.log(
      Object.entries(cu)
        .map(([k, v]) => `${k}: ${v} (at most ${LIMITS[k]})`)
        .join("\n"),
    );
    expect(Object.keys(cu).sort()).toEqual(Object.keys(LIMITS).sort());
    for (const [k, v] of Object.entries(cu)) expect(v, k).toBeLessThanOrEqual(LIMITS[k]!);
  });
});
