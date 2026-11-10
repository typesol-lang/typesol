// The built-in RedBlackTree's surface (test/fixtures/rbtree-api.ts): Phoenix's book order through a comparator,
// references into nodes and writes through them, remove's value, reverse walks with break / continue, a read-only
// tree, Pubkey keys, the panics lib-sokoban raises (logged as solana-program up to 1.17 logs a panic), the bounds
// check, and the compile errors. Byte-for-byte agreement with lib-sokoban is test/verification/rbtree-trace.test.ts.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { web3 } from "@anchor-lang/core";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, type Deployed, compileErrors, deployFile, fundedSigner, ix, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const BOOK = 8;
const STRIDE = 64;
const M64 = (1n << 64n) - 1n;

/** Phoenix's FIFOOrderId order, for the expected book. */
function fifo(a: [bigint, bigint], b: [bigint, bigint]): number {
  const bid = a[1] >> 63n === 1n;
  const [x, y] = bid ? [b, a] : [a, b];
  if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  return 0;
}

describe("RedBlackTree", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let market: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/rbtree-api.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 100n);
  });
  const fresh = async (cap: number, stride = STRIDE, extra = 0, owner?: Address) => {
    market = (await generateKeyPairSigner()).address;
    const data = Buffer.alloc(BOOK + 32 + cap * stride + extra);
    data.writeBigUInt64LE(0x1122334455667788n, 0);
    d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: owner ?? d.programId, executable: false, data } as never);
  };
  const bytes = () => Buffer.from((d.svm.getAccount(market) as { data: Uint8Array }).data);
  const call = (name: string, args: Record<string, unknown>, writable = true) => send(d.svm, payer, [ix(d, name, args, [{ address: market, writable }])]);
  const ok = (r: Result) => {
    if (r instanceof FailedTransactionMetadata) throw new Error(`failed: ${String(r.err())}\n${logs(r).join("\n")}`);
    return r;
  };
  const line = (r: Result, prefix: string) => logs(r).find((l) => l.startsWith(`Program log: ${prefix}`));
  /** The book posted by `post` with these price bytes: [price, stored sequence, trader]. */
  const expectedBook = (prices: number[], bid: boolean) =>
    prices.map((p, i) => [BigInt(p), bid ? (100n + BigInt(i)) ^ M64 : 100n + BigInt(i), i + 1] as const).sort((a, b) => fifo([a[0], a[1]], [b[0], b[1]]));
  const priceWord = (prices: number[]) => new BN(Buffer.from(prices).reverse().toString("hex") || "0", 16);

  for (const bid of [true, false]) {
    it(`orders a ${bid ? "bid" : "ask"} book as Phoenix's FIFOOrderId does (comparator called as compare(searched, node))`, async () => {
      await fresh(8);
      ok(await call("init", { cap: new BN(8) }));
      const prices = [5, 9, 5, 7, 9, 1];
      const r = ok(await call("post", { cap: new BN(8), prices: priceWord(prices), count: new BN(prices.length), bid }));
      const want = expectedBook(prices, bid)
        .map(([p, , t]) => ` ${p}/${t}`)
        .join("");
      expect(line(r, "book")).toBe(`Program log: book${want}`);
      // the u64 before the book is untouched
      expect(bytes().readBigUInt64LE(0)).toBe(0x1122334455667788n);
    });
  }

  it("walks a read-only tree backwards with continue and break; min, max, addrOf and nodeAt", async () => {
    await fresh(8);
    ok(await call("init", { cap: new BN(8) }));
    const prices = [5, 9, 5, 7, 9, 1];
    ok(await call("post", { cap: new BN(8), prices: priceWord(prices), count: new BN(prices.length), bid: false }));
    const r = ok(await call("inspect", { cap: new BN(8), skip_trader: new BN(5), stop_after: new BN(3) }, false));
    // asks backwards: 9/5 (skipped), 9/2, 7/4, 5/3 — stop after three; node index = insertion order (bump allocation)
    expect(line(r, "rev")).toBe("Program log: rev 2@2 4@4 3@3");
    expect(line(r, "min")).toBe("Program log: min 1 max 9");
    expect(line(r, "addr")).toBe("Program log: addr 6 same true");
  });

  it("get hands out the value in place; remove's value stays readable; min's value can be written", async () => {
    await fresh(8);
    ok(await call("init", { cap: new BN(8) }));
    const prices = [5, 9, 5, 7];
    ok(await call("post", { cap: new BN(8), prices: priceWord(prices), count: new BN(prices.length), bid: false }));
    const r = ok(
      await call("amend", { cap: new BN(8), price: new BN(9), seq: new BN(101), lots: new BN(1234), cancel_price: new BN(7), cancel_seq: new BN(103) }),
    );
    expect(line(r, "cancel")).toBe("Program log: cancel: trader 4 lots 40");
    expect(line(r, "len")).toBe("Program log: len 3");
    const b = bytes();
    const node = (i: number) => BOOK + 32 + (i - 1) * STRIDE;
    expect(b.readBigUInt64LE(node(2) + 16 + 16 + 8)).toBe(1234n); // order 2's num_base_lots
    expect(b.readBigUInt64LE(node(1) + 16 + 16 + 16)).toBe(77n); // the best ask (5, seq 100) is node 1
    // the cancelled node 4: on the free list (register 0 = the old head, the bump index 5), key and value bytes kept
    expect(b.readUInt32LE(node(4))).toBe(5);
    expect(b.readBigUInt64LE(node(4) + 16)).toBe(7n);
    expect(b.readBigUInt64LE(node(4) + 32)).toBe(4n);
    expect(b.readUInt32LE(BOOK + 28)).toBe(4); // free_list_head
    const none = ok(
      await call("amend", { cap: new BN(8), price: new BN(9), seq: new BN(999), lots: new BN(1), cancel_price: new BN(0), cancel_seq: new BN(0) }),
    );
    expect(line(none, "no such")).toBe("Program log: no such order");
  });

  it("removeAt(index) writes what remove(key) writes for that node; index 0 and a freed node give null and write nothing", async () => {
    const prices = [5, 9, 5, 7, 9, 1, 3];
    const book = async (byKey: boolean) => {
      await fresh(8);
      ok(await call("init", { cap: new BN(8) }));
      ok(await call("post", { cap: new BN(8), prices: priceWord(prices), count: new BN(prices.length), bid: true }));
      const r = ok(await call("cancel_best", { cap: new BN(8), by_key: byKey }));
      return { r, b: bytes() };
    };
    const byKey = await book(true);
    const byIndex = await book(false);
    // the best bid is 9 / trader 2 (node 2)
    expect(line(byKey.r, "removed")).toBe("Program log: removed 2 at 2 len 6");
    expect(line(byIndex.r, "removed")).toBe("Program log: removed 2 at 2 len 6");
    expect(line(byIndex.r, "again")).toBe("Program log: again true zero true len 6");
    expect(byIndex.b.equals(byKey.b)).toBe(true);
  });

  it("an equal key replaces the value even when full; a new key on a full tree gives null and writes nothing", async () => {
    const STR = 32;
    await fresh(2, STR);
    // an initialized allocator (bump index and free list head 1), written here rather than by an instruction
    const raw = bytes();
    raw.writeUInt32LE(1, BOOK + 24); // bump_index
    raw.writeUInt32LE(1, BOOK + 28); // free_list_head
    d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: raw } as never);
    const ins = async (k: number, v: number) => line(ok(await call("scalars", { cap: new BN(2), k: new BN(k), v: new BN(v) })), "insert");
    expect(await ins(1, 10)).toBe("Program log: insert 1 get 10 len 1");
    expect(await ins(2, 20)).toBe("Program log: insert 2 get 20 len 2");
    const before = bytes();
    expect(await ins(3, 30)).toBe("Program log: insert full get none len 2");
    expect(bytes().equals(before)).toBe(true);
    expect(await ins(2, 25)).toBe("Program log: insert 2 get 25 len 2");
  });

  it("Pubkey keys are ordered by their bytes (Phoenix's traders)", async () => {
    await fresh(4, 56);
    const raw = bytes();
    raw.writeUInt32LE(1, BOOK + 24);
    raw.writeUInt32LE(1, BOOK + 28);
    d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: raw } as never);

    const keys = [
      [0x80, 1],
      [0x01, 2],
      [0x80, 0],
      [0x7f, 9],
    ].map(([a, b]) => {
      const k = Buffer.alloc(32, 0);
      k[0] = a!;
      k[31] = b!;
      return new web3.PublicKey(k);
    });
    let r: Result | undefined;
    for (const k of keys) r = ok(await send(d.svm, payer, [ix(d, "seat", { cap: new BN(4), trader: k }, [{ address: market, writable: true }])]));
    // inserted with values 1..4; bytewise order: 01…02 (2), 7f…09 (4), 80…00 (3), 80…01 (1)
    expect(line(r!, "seats")).toBe("Program log: seats 2 4 3 1");
  });

  it("panics as lib-sokoban does, logged as solana-program up to 1.17 logs a panic", async () => {
    const run = (data: Buffer) =>
      send(d.svm, payer, [
        { programAddress: d.programId, accounts: [{ address: market, role: AccountRole.WRITABLE }], data: new Uint8Array(data) } as Instruction,
      ]);
    const panicked = (r: Result, msg: string) => {
      expect(err(r)).toMatch(/ProgramFailedToComplete/);
      expect(logs(r)).toContain(`Program log: panicked at '${msg}`);
      expect(logs(r).at(-1)).toBe(`Program ${d.programId} failed: SBF program panicked`);
    };
    // initialize twice
    market = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: Buffer.alloc(32 + 3 * 32) } as never);
    ok(await run(Buffer.concat([Buffer.from([0]), u64(3)])));
    panicked(await run(Buffer.concat([Buffer.from([0]), u64(3)])), "Cannot reinitialize NodeAllocator', src/node_allocator.rs:249:13");
    // nodeAt(0) and past the capacity: Rust's `nodes[i - 1]`
    panicked(await run(Buffer.concat([Buffer.from([2]), u64(3), u64(0)])), "attempt to subtract with overflow', src/node_allocator.rs:255:21");
    panicked(
      await run(Buffer.concat([Buffer.from([2]), u64(3), u64(4)])),
      "index out of bounds: the len is 3 but the index is 3', src/node_allocator.rs:255:10",
    );
    ok(await run(Buffer.concat([Buffer.from([2]), u64(3), u64(3)])));
    // a walk of a damaged tree: a register past the capacity panics as indexing does, a cycle when the stack is full
    const damaged = async (left: number) => {
      await fresh(3);
      const raw = bytes();
      raw.writeUInt32LE(1, BOOK); // root: node 1
      raw.writeUInt32LE(left, BOOK + 32); // node 1's left register
      d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: raw } as never);
      return call("post", { cap: new BN(3), prices: new BN(0), count: new BN(0), bid: false });
    };
    panicked(await damaged(4), "index out of bounds: the len is 3 but the index is 3', src/node_allocator.rs:255:10");
    panicked(await damaged(1), "TypeSOL: RedBlackTree deeper than a red-black tree can be', rbtree");
    market = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: Buffer.alloc(32 + 3 * 32) } as never);
    ok(await run(Buffer.concat([Buffer.from([0]), u64(3)])));
    // removeAt past the capacity panics as nodeAt does; 0 is no node
    panicked(
      await run(Buffer.concat([Buffer.from([3]), u64(3), u64(4)])),
      "index out of bounds: the len is 3 but the index is 3', src/node_allocator.rs:255:10",
    );
    expect(logs(ok(await run(Buffer.concat([Buffer.from([3]), u64(3), u64(0)]))))).toContain("Program log: none");
    // a tree with no room: an empty tree's insert skips the capacity check, so the allocator panics
    market = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: Buffer.alloc(32) } as never);
    ok(await run(Buffer.concat([Buffer.from([0]), u64(0)])));
    panicked(await run(Buffer.concat([Buffer.from([1]), u64(0)])), "Buffer is full, size 0', src/node_allocator.rs:269:17");
  });

  it("the tree must fit in the account (AccountDataTooSmall) and be this program's (3007)", async () => {
    await fresh(8, STRIDE, -1);
    expect(err(await call("init", { cap: new BN(8) }))).toContain("AccountDataTooSmall");
    await fresh(8);
    expect(err(await call("init", { cap: new BN("1000000000000000") }))).toContain("AccountDataTooSmall");
    await fresh(8, STRIDE, 0, payer.address);
    expect(err(await call("init", { cap: new BN(8) }))).toContain("code: 3007 ");
    await fresh(8);
    expect(err(await call("init", { cap: new BN(8) }, false))).toContain("code: 2000 ");
  });

  it("compile errors name the fix", () => {
    const head = `import { type AccountInfo, type Mut, type FixedString, type i8, type u64, type u32, rbTreeAt, rbTreeMutAt, log } from "typesol";
export interface K { a: u64; b: u64; }
export interface V { x: u64; y: u64; }
export interface Odd { x: u64; y: u32; }
export interface Named { n: FixedString<4>; }
function cmp(a: K, b: K): i8 { return a.a < b.a ? -1n : a.a > b.a ? 1n : 0n; }
function bad(a: u64, b: u64): i8 { return 0n; }
`;
    const f = (body: string, acct = "Mut<AccountInfo>") => compileErrors(`${head}export function f(a: ${acct}, k: K): void { ${body} }`);
    expect(f(`const t = rbTreeAt<K, V>(a, 0n, 4n, cmp); t.insert(k, { x: 1n, y: 2n });`)).toContain("Property 'insert' does not exist");
    expect(f(`const t = rbTreeMutAt<K, V>(a, 0n, 4n, cmp); for (const e of t) t.remove(e.key);`)).toContain(
      "remove() would change the tree a for … of is walking",
    );
    expect(f(`const t = rbTreeMutAt<K, V>(a, 0n, 4n, cmp); for (const e of t) t.removeAt(e.index);`)).toContain(
      "removeAt() would change the tree a for … of is walking",
    );
    expect(f(`const t = rbTreeAt<K, V>(a, 0n, 4n, cmp); t.removeAt(1n);`, "AccountInfo")).toContain("Property 'removeAt' does not exist");
    expect(f(`const t = rbTreeMutAt<K, V>(a, 0n, 4n, cmp); t.removeAt(k);`)).toMatch(/not assignable|expected a u32/);
    expect(f(`const t = rbTreeMutAt<K, V>(a, 0n, 4n, cmp); const v = t.get(k); t.insert(k, { x: 1n, y: 2n }); if (v !== null) log(v.x);`)).toContain(
      '"v" still refers to',
    );
    expect(f(`const t = rbTreeMutAt<K, V>(a, 0n, 4n, bad);`)).toMatch(/bad must take two K keys|not assignable/);
    expect(f(`const t = rbTreeMutAt<Named, V>(a, 0n, 4n); log(t.length);`)).toContain("Named has no default order");
    expect(f(`const t = rbTreeMutAt<K, Odd>(a, 0n, 4n, cmp); log(t.length);`)).toContain("not a multiple of 8");
    expect(f(`const t = rbTreeMutAt<K, V>(a, 0n, 4n, cmp); const r = t.reversed(); log(t.length);`)).toContain("reversed() walks the tree");
    expect(f(`const t = rbTreeMutAt<K, V>(a, 0n, 4n, cmp); const u = t; log(u.length);`)).toContain("is a RedBlackTree");
    expect(f(`log(rbTreeAt<K, V>(a, 0n, 4n, cmp).length);`)).toContain("bind rbTreeAt(…) to a const first");
    expect(f(`const t = rbTreeMutAt<K, V>(a, 0n, 4n, cmp); t.initialize();`, "AccountInfo")).toContain("must be Mut<AccountInfo> to load it with rbTreeMutAt");
    expect(f(`const t = rbTreeAt<K, V>(a, 0n, 4n, cmp); const m = t.min(); if (m !== null) m.value.x = 1n;`, "AccountInfo")).toMatch(/read-only|Cannot assign/);
  });

  it("the language reference's example compiles", () => {
    expect(
      compileErrors(`import { type AccountInfo, type Pubkey, type i8, type u64, rbTreeMutAt } from "typesol";
export const NATIVE_ACCOUNT_WRITES = true;
export interface FIFOOrderId { price_in_ticks: u64; order_sequence_number: u64; }
export interface FIFORestingOrder { trader_index: u64; num_base_lots: u64; last_valid_slot: u64; last_valid_unix_timestamp_in_seconds: u64; }
export interface TraderState { quote_lots_locked: u64; quote_lots_free: u64; base_lots_locked: u64; base_lots_free: u64; }
function orderCmp(a: FIFOOrderId, b: FIFOOrderId): i8 {
  if (a.order_sequence_number >> 63n === 1n) {
    if (a.price_in_ticks !== b.price_in_ticks) return b.price_in_ticks < a.price_in_ticks ? -1n : 1n;
    return b.order_sequence_number < a.order_sequence_number ? -1n : b.order_sequence_number > a.order_sequence_number ? 1n : 0n;
  }
  if (a.price_in_ticks !== b.price_in_ticks) return a.price_in_ticks < b.price_in_ticks ? -1n : 1n;
  return a.order_sequence_number < b.order_sequence_number ? -1n : a.order_sequence_number > b.order_sequence_number ? 1n : 0n;
}
export function fill(market: AccountInfo, n: u64, s: u64, fill: u64, trader: Pubkey, orderId: FIFOOrderId, traderIndex: u64): void {
  const bids = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, 880n, n, orderCmp);
  const traders = rbTreeMutAt<Pubkey, TraderState>(market, 880n + 2n * (32n + 64n * n), s);
  const best = bids.min();
  if (best !== null && best.value.num_base_lots > 0n) best.value.num_base_lots -= fill;
  const index = traders.addrOf(trader);
  if (index !== 0n) traders.nodeAt(index).value.base_lots_free += fill;
  const at = bids.addrOf(orderId);
  if (at !== 0n && bids.nodeAt(at).value.trader_index === traderIndex) bids.removeAt(at);
}`),
    ).toBe("");
  });
});
