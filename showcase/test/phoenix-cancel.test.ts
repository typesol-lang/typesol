// showcase/mainnet/phoenix's reductions and cancels against Phoenix v1 as deployed on mainnet: ReduceOrder,
// CancelAllOrders, CancelUpTo, CancelMultipleOrdersById (each with its WithFreeFunds form), ForceCancelOrders and
// EvictSeat, on two market sizes (512 orders / 128 seats and 4096 / 8321). The harness (phoenix-helpers.ts) runs the
// original and the port in their own LiteSVM; every compared transaction must have the same outcome, log lines (the
// compute-unit lines Phoenix logs itself by count and position), inner instructions (the event batches byte for
// byte, the token transfers), return data and bytes in every account it names.
//
// The orders the tests cancel are placed by the original alone (PlaceMultiplePostOnlyOrders, the matching engine
// being another part of the port), then the market, the vaults and the trader's token accounts are copied into the
// port's VM, so both start every compared transaction from the bytes Phoenix itself wrote, rotations and colors of
// its trees included. States no instruction reaches (a damaged lot size, locked funds below what an order holds) are
// written into both VMs' bytes.
import { type Address, type Instruction, type KeyPairSigner, address } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { send } from "../../test/harness.js";
import {
  Diff,
  E,
  type Market,
  OFF,
  PANICKED,
  TREE,
  type Trader,
  asksAt,
  builtin,
  cancelOrderParams,
  cancelUpToParams,
  checkCompute,
  custom,
  cuTable,
  ix,
  key,
  meta,
  multipleOrderPacket,
  outcome,
  tradersAt,
  truncate,
  u8,
  u32,
  withData,
} from "./phoenix-helpers.js";

const BORSH = builtin("BorshIoError");
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
/** SetComputeUnitLimit(1.4M): the instructions that cancel hundreds of orders need more than the default 200k. */
const budget: Instruction = { programAddress: COMPUTE_BUDGET, accounts: [], data: new Uint8Array([2, 0xc0, 0x5c, 0x15, 0]) };
/** A panic of an instruction sent after the budget one (index 1). */
const PANICKED_1 = PANICKED.replace("index: 0", "index: 1");

/** Every Diff of the file, for the CU table. */
const diffs: Diff[] = [];
async function diff(): Promise<Diff> {
  const d = await Diff.create();
  diffs.push(d);
  return d;
}
/** The transactions this file compares (every case, the setup ones included). */
const COMPARED = 390;
afterAll(() => {
  console.log(cuTable(diffs, "Phoenix v1 reductions and cancels: compute units, original vs TypeSOL"));
  checkCompute(diffs, COMPARED);
});

// ---- Orders placed by the original -------------------------------------------------------------------------------------

/** A resting order as the book holds it (its node index, key and value). */
interface Order {
  index: number;
  price: bigint;
  /** The stored sequence number (a bid's inverted). */
  seq: bigint;
  trader: bigint;
  lots: bigint;
}

/** A book's orders, best first (sokoban's in-order walk over the node registers). */
function book(d: Diff, m: Market, side: "bid" | "ask"): Order[] {
  const b = d.data(m.market);
  const at = side === "bid" ? OFF.bids : asksAt(m.bids);
  const node = (i: number) => at + TREE.nodes + (i - 1) * 64;
  const out: Order[] = [];
  const stack: number[] = [];
  let cur = b.readUInt32LE(at + TREE.root);
  while (stack.length > 0 || cur !== 0) {
    if (cur !== 0) {
      stack.push(cur);
      cur = b.readUInt32LE(node(cur));
      continue;
    }
    const i = stack.pop()!;
    const n = node(i);
    out.push({
      index: i,
      price: b.readBigUInt64LE(n + 16),
      seq: b.readBigUInt64LE(n + 24),
      trader: b.readBigUInt64LE(n + 32),
      lots: b.readBigUInt64LE(n + 40),
    });
    cur = b.readUInt32LE(n + 4);
  }
  return out;
}

/** A trader's node index in the traders tree (0 when it holds no state). */
function traderIndex(d: Diff, m: Market, t: Trader): bigint {
  const b = d.data(m.market);
  const k = key(t.key.address);
  const nodes = tradersAt(m.bids) + TREE.nodes;
  if (b.readBigUInt64LE(tradersAt(m.bids) + TREE.size) === 0n) return 0n;
  // A freed node keeps its key: only a node the tree still links counts.
  const root = b.readUInt32LE(tradersAt(m.bids) + TREE.root);
  for (let i = 1; i <= m.seats; i++) {
    const at = nodes + (i - 1) * 144;
    if (!b.subarray(at + 16, at + 48).equals(k)) continue;
    if (i === root || b.readUInt32LE(at + 8) !== 0) return BigInt(i);
  }
  return 0n;
}

/** The trader's TraderState offset in the market. */
function traderStateAt(d: Diff, m: Market, t: Trader): number {
  const i = Number(traderIndex(d, m, t));
  if (i === 0) throw new Error("trader not registered");
  return tradersAt(m.bids) + TREE.nodes + (i - 1) * 144 + 48;
}

/** The account's bytes in the original copied into the port's VM. */
function sync(d: Diff, ...addresses: Address[]): void {
  for (const a of addresses) {
    const acct = d.original.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    d.port.setAccount({
      address: a,
      data: new Uint8Array(acct.data),
      executable: acct.executable,
      lamports: acct.lamports,
      programAddress: acct.programAddress,
      space: BigInt(acct.data.length),
    });
  }
}

/**
 * The trader's orders, placed by the original (PlaceMultiplePostOnlyOrders, 30 a transaction, paid by `setup`, which no
 * compared transaction names), then the market, the vaults and the trader's token accounts copied to the port.
 */
async function place(d: Diff, setup: KeyPairSigner, m: Market, t: Trader, bids: [bigint, bigint][], asks: [bigint, bigint][] = []): Promise<void> {
  const all = [...bids.map((o) => ["bid", o] as const), ...asks.map((o) => ["ask", o] as const)];
  for (let i = 0; i < all.length; i += 30) {
    const chunk = all.slice(i, i + 30);
    const pick = (side: "bid" | "ask") => chunk.filter(([s]) => s === side).map(([, [priceInTicks, sizeInBaseLots]]) => ({ priceInTicks, sizeInBaseLots }));
    const r = await send(d.original, setup, [ix.placeMultiplePostOnlyOrders(m, t, multipleOrderPacket(pick("bid"), pick("ask")))]);
    if (outcome(r) !== "ok") throw new Error(`placing orders failed:\n${meta(r).logs().join("\n")}`);
  }
  sync(d, m.market, m.baseVault, m.quoteVault, t.base, t.quote);
}

/** Bids [price, 1 + i % 3 lots] at `from`, `from - step`, … */
const ladder = (n: number, from: bigint, step = 1n): [bigint, bigint][] => Array.from({ length: n }, (_, i) => [from - BigInt(i) * step, 1n + BigInt(i % 3)]);
/** Asks at `from`, `from + step`, … */
const ladderUp = (n: number, from: bigint, step = 1n): [bigint, bigint][] => Array.from({ length: n }, (_, i) => [from + BigInt(i) * step, 1n + BigInt(i % 3)]);

/** CancelOrderParams for a resting order (its side from where it rests unless given). */
const params = (o: Order, side?: 0 | 1) => cancelOrderParams(side ?? (o.seq >> 63n === 1n ? 0 : 1), o.price, o.seq);

/** A market and the accounts its tests share, made once per describe. */
interface Setup {
  d: Diff;
  payer: KeyPairSigner;
  /** Pays for the original-only transactions that place orders. */
  setup: KeyPairSigner;
  m: Market;
}
async function newSetup(bids: number, seats: number, label: string): Promise<Setup> {
  const d = await diff();
  const payer = await d.funded();
  const setup = await d.funded(1000n);
  const m = await d.market({ bids, seats, label: `${label}: InitializeMarket` });
  return { d, payer, setup, m };
}

const RICH = 10n ** 15n;

for (const [bids, seats] of [
  [512, 128],
  [4096, 8321],
] as const) {
  const tag = `${bids}/${seats}`;

  describe(`ReduceOrder (${tag})`, () => {
    let S: Setup;
    let a: Trader;
    let b: Trader;
    beforeAll(async () => {
      S = await newSetup(bids, seats, `reduce ${tag}`);
      a = await S.d.seated(S.m, RICH, RICH, `reduce ${tag} a`);
      b = await S.d.seated(S.m, RICH, RICH, `reduce ${tag} b`);
      await place(S.d, S.setup, S.m, a, ladder(6, 1000n), ladderUp(6, 2000n));
      await place(S.d, S.setup, S.m, b, ladder(3, 999n, 2n), ladderUp(3, 2001n, 2n));
    });

    it("reduces part of an order, then the rest, sending the funds", async () => {
      const { d, payer, m } = S;
      const bid = book(d, m, "bid").find((o) => o.trader === traderIndex(d, m, a) && o.lots > 1n)!;
      await d.ok(`ReduceOrder ${tag}: part of a bid`, payer, [ix.reduceOrder(m, a, params(bid), 1n)]);
      await d.ok(`ReduceOrder ${tag}: the rest of the bid (size above it)`, payer, [ix.reduceOrder(m, a, params(bid), 100n)]);
      const ask = book(d, m, "ask").find((o) => o.trader === traderIndex(d, m, a) && o.lots > 1n)!;
      await d.ok(`ReduceOrder ${tag}: part of an ask`, payer, [ix.reduceOrder(m, a, params(ask), ask.lots - 1n)]);
      await d.ok(`ReduceOrder ${tag}: the rest of the ask (exactly)`, payer, [ix.reduceOrder(m, a, params(ask), 1n)]);
      const other = book(d, m, "ask").find((o) => o.trader === traderIndex(d, m, a))!;
      await d.ok(`ReduceOrder ${tag}: by zero lots`, payer, [ix.reduceOrder(m, a, params(other), 0n)]);
      await d.ok(`ReduceOrder ${tag}: an order that is not there`, payer, [ix.reduceOrder(m, a, cancelOrderParams(1, 5n, 77n), 1n)]);
      await d.ok(`ReduceOrder ${tag}: an order gone already`, payer, [ix.reduceOrder(m, a, params(ask), 1n)]);
    });

    it("keeps the funds on the market (WithFreeFunds)", async () => {
      const { d, payer, m } = S;
      const bid = book(d, m, "bid").find((o) => o.trader === traderIndex(d, m, a))!;
      await d.ok(`ReduceOrderWithFreeFunds ${tag}: a bid`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(bid), 1n)]);
      const ask = book(d, m, "ask").find((o) => o.trader === traderIndex(d, m, a))!;
      await d.ok(`ReduceOrderWithFreeFunds ${tag}: a whole ask`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(ask), ask.lots)]);
    });

    it("takes the book from the side argument, the order from the key", async () => {
      const { d, payer, m } = S;
      const bid = book(d, m, "bid").find((o) => o.trader === traderIndex(d, m, a))!;
      const ask = book(d, m, "ask").find((o) => o.trader === traderIndex(d, m, a))!;
      await d.ok(`ReduceOrder ${tag}: a bid's key on the asks`, payer, [ix.reduceOrder(m, a, params(bid, 1), 1n)]);
      await d.ok(`ReduceOrder ${tag}: an ask's key on the bids`, payer, [ix.reduceOrder(m, a, params(ask, 0), 1n)]);
    });

    it("fails for another trader's order and for a trader with no state", async () => {
      const { d, payer, m } = S;
      const theirs = book(d, m, "bid").find((o) => o.trader === traderIndex(d, m, b))!;
      await d.fails(`ReduceOrder ${tag}: another trader's order`, payer, [ix.reduceOrder(m, a, params(theirs), 1n)], custom(E.ReduceOrderError!));
      await d.fails(
        `ReduceOrderWithFreeFunds ${tag}: another trader's order`,
        payer,
        [ix.reduceOrderWithFreeFunds(m, a, params(theirs), 1n)],
        custom(E.ReduceOrderError!),
      );
      const stranger = await d.trader(m, 1n, 1n);
      await d.fails(`ReduceOrder ${tag}: a trader with no state`, payer, [ix.reduceOrder(m, stranger, params(theirs), 1n)], custom(E.ReduceOrderError!));
      await d.fails(
        `ReduceOrderWithFreeFunds ${tag}: a trader with no state`,
        payer,
        [ix.reduceOrderWithFreeFunds(m, stranger, params(theirs), 1n)],
        custom(E.ReduceOrderError!),
      );
    });

    it("decodes ReduceOrderParams exactly and checks the accounts of the plain form", async () => {
      const { d, payer, m } = S;
      const o = book(d, m, "bid").find((x) => x.trader === traderIndex(d, m, a))!;
      const good = ix.reduceOrder(m, a, params(o), 1n);
      const data = Buffer.from(good.data!);
      for (const [label, bytes] of [
        ["no params", data.subarray(0, 1)],
        ["a byte short", data.subarray(0, 25)],
        ["a byte after", Buffer.concat([data, u8(0)])],
        ["side 2", Buffer.concat([u8(4), u8(2), data.subarray(2)])],
      ] as const) {
        await d.fails(`ReduceOrder ${tag}: ${label}`, payer, [withData(good, bytes)], BORSH);
        const free = ix.reduceOrderWithFreeFunds(m, a, params(o), 1n);
        await d.fails(`ReduceOrderWithFreeFunds ${tag}: ${label}`, payer, [withData(free, Buffer.concat([u8(5), bytes.subarray(1)]))], BORSH);
      }
      for (let n = 4; n < 9; n++) await d.fails(`ReduceOrder ${tag}: ${n} accounts`, payer, [truncate(good, n)], builtin("NotEnoughAccountKeys"));
      await d.fails(
        `ReduceOrder ${tag}: quote account as base`,
        payer,
        [ix.reduceOrder(m, { ...a, base: a.quote }, params(o), 1n)],
        builtin("InvalidAccountData"),
      );
    });

    it("needs a market that allows reductions for the plain form only", async () => {
      const { d, payer, m } = S;
      const o = book(d, m, "bid").find((x) => x.trader === traderIndex(d, m, a))!;
      const save = d.data(m.market);
      d.patch(m.market, (x) => x.writeBigUInt64LE(0n, OFF.status));
      await d.fails(`ReduceOrder ${tag}: market Uninitialized`, payer, [ix.reduceOrder(m, a, params(o), 1n)], builtin("InvalidAccountData"));
      await d.ok(`ReduceOrderWithFreeFunds ${tag}: market Uninitialized`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(o), 1n)]);
      d.patch(m.market, (x) => x.writeBigUInt64LE(4n, OFF.status));
      await d.ok(`ReduceOrder ${tag}: market Closed`, payer, [ix.reduceOrder(m, a, params(o), 1n)]);
      d.patch(m.market, (x) => save.copy(x));
      d.patch(m.market, (x) => save.copy(x));
      d.patch(m.market, (x) => x.writeBigUInt64LE(0n, OFF.orderSequenceNumber));
      await d.fails(
        `ReduceOrderWithFreeFunds ${tag}: FIFOMarket not initialized`,
        payer,
        [ix.reduceOrderWithFreeFunds(m, a, params(o), 1n)],
        custom(E.MarketUninitialized!),
      );
      d.patch(m.market, (x) => save.copy(x));
    });

    it("panics as quantities.rs's operators and fifo.rs's division do", async () => {
      const { d, payer, m } = S;
      const save = d.data(m.market);
      const restore = () => d.patch(m.market, (x) => save.copy(x));
      const bid = book(d, m, "bid").find((o) => o.trader === traderIndex(d, m, a))!;
      const ask = book(d, m, "ask").find((o) => o.trader === traderIndex(d, m, a))!;
      const state = traderStateAt(d, m, a);
      // A lot size that does not divide: Phoenix warns, then the unlock goes below what is locked.
      d.patch(m.market, (x) => x.writeBigUInt64LE(7n, OFF.baseLotsPerBaseUnit));
      await d.fails(`ReduceOrderWithFreeFunds ${tag}: unclean division`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(bid), 1n)], PANICKED);
      d.patch(m.market, (x) => x.writeBigUInt64LE(10n ** 12n, state));
      await d.ok(`ReduceOrderWithFreeFunds ${tag}: unclean division, enough locked`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(bid), 1n)]);
      restore();
      d.patch(m.market, (x) => x.writeBigUInt64LE(0n, OFF.baseLotsPerBaseUnit));
      await d.fails(`ReduceOrderWithFreeFunds ${tag}: zero base lots per unit`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(bid), 1n)], PANICKED);
      restore();
      // price × tick overflows (the tick is the FIFOMarket's copy, after the base lots per unit).
      d.patch(m.market, (x) => x.writeBigUInt64LE(1n << 60n, OFF.baseLotsPerBaseUnit + 8));
      await d.fails(`ReduceOrderWithFreeFunds ${tag}: price × tick overflows`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(bid), 1n)], PANICKED);
      restore();
      d.patch(m.market, (x) => x.writeBigUInt64LE(1n << 50n, OFF.baseLotsPerBaseUnit + 8));
      await d.fails(`ReduceOrderWithFreeFunds ${tag}: × lots overflows`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(bid), 100000n)], PANICKED);
      restore();
      // Locked funds below what the orders hold; free funds at the top.
      d.patch(m.market, (x) => x.writeBigUInt64LE(0n, state));
      await d.fails(`ReduceOrderWithFreeFunds ${tag}: quote locked underflows`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(bid), 1n)], PANICKED);
      restore();
      d.patch(m.market, (x) => x.writeBigUInt64LE(0n, state + 16));
      await d.fails(`ReduceOrderWithFreeFunds ${tag}: base locked underflows`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(ask), 1n)], PANICKED);
      restore();
      d.patch(m.market, (x) => x.writeBigUInt64LE(0xffffffffffffffffn, state + 8));
      await d.fails(`ReduceOrderWithFreeFunds ${tag}: quote free overflows`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(bid), 1n)], PANICKED);
      restore();
      d.patch(m.market, (x) => x.writeBigUInt64LE(0xffffffffffffffffn, state + 24));
      await d.fails(`ReduceOrderWithFreeFunds ${tag}: base free overflows`, payer, [ix.reduceOrderWithFreeFunds(m, a, params(ask), 1n)], PANICKED);
      restore();
      // The atoms to send overflow (a huge lot size in the header).
      d.patch(m.market, (x) => x.writeBigUInt64LE(1n << 62n, OFF.quoteLotSize));
      await d.fails(`ReduceOrder ${tag}: quote atoms overflow`, payer, [ix.reduceOrder(m, a, params(bid), 1n)], PANICKED);
      restore();
      const big = book(d, m, "ask").find((o) => o.trader === traderIndex(d, m, a) && o.lots > 1n)!;
      d.patch(m.market, (x) => x.writeBigUInt64LE(1n << 63n, OFF.baseLotSize));
      await d.fails(`ReduceOrder ${tag}: base atoms overflow`, payer, [ix.reduceOrder(m, a, params(big), 2n)], PANICKED);
      restore();
    });
  });

  describe(`CancelAllOrders (${tag})`, () => {
    let S: Setup;
    let a: Trader;
    let b: Trader;
    let c: Trader;
    beforeAll(async () => {
      S = await newSetup(bids, seats, `cancel all ${tag}`);
      a = await S.d.seated(S.m, RICH, RICH, `cancel all ${tag} a`);
      b = await S.d.seated(S.m, RICH, RICH, `cancel all ${tag} b`);
      c = await S.d.seated(S.m, RICH, RICH, `cancel all ${tag} c`);
    });

    it("cancels a trader's orders on both books among others' and sends the funds", async () => {
      const { d, payer, setup, m } = S;
      await place(d, setup, m, a, ladder(2, 1000n, 3n), ladderUp(1, 2000n));
      await place(d, setup, m, b, ladder(4, 1001n, 2n), ladderUp(4, 2000n));
      await place(d, setup, m, c, ladder(3, 1002n), ladderUp(3, 2001n, 3n));
      await d.ok(`CancelAllOrders ${tag}: 3 orders among 17`, payer, [ix.cancelAllOrders(m, a)]);
      await d.ok(`CancelAllOrders ${tag}: no orders left`, payer, [ix.cancelAllOrders(m, a)]);
      await d.ok(`CancelAllOrdersWithFreeFunds ${tag}: 6 orders among 14`, payer, [ix.cancelAllOrdersWithFreeFunds(m, c)]);
      const stranger = await d.trader(m, 1n, 1n);
      await d.ok(`CancelAllOrders ${tag}: a trader with no state`, payer, [ix.cancelAllOrders(m, stranger)]);
      await d.ok(`CancelAllOrdersWithFreeFunds ${tag}: a trader with no state`, payer, [ix.cancelAllOrdersWithFreeFunds(m, stranger)]);
      // An order with no lots left stays (written: no instruction leaves one).
      const one = book(d, m, "ask").find((o) => o.trader === traderIndex(d, m, b))!;
      d.patch(m.market, (x) => x.writeBigUInt64LE(0n, asksAt(m.bids) + TREE.nodes + (one.index - 1) * 64 + 40));
      await d.ok(`CancelAllOrdersWithFreeFunds ${tag}: one order of zero lots`, payer, [ix.cancelAllOrdersWithFreeFunds(m, b)]);
    });

    it("checks the plain form's accounts and the market's status", async () => {
      const { d, payer, m } = S;
      for (let n = 4; n < 9; n++)
        await d.fails(`CancelAllOrders ${tag}: ${n} accounts`, payer, [truncate(ix.cancelAllOrders(m, a), n)], builtin("NotEnoughAccountKeys"));
      const save = d.data(m.market);
      d.patch(m.market, (x) => x.writeBigUInt64LE(0n, OFF.status));
      await d.fails(`CancelAllOrders ${tag}: market Uninitialized`, payer, [ix.cancelAllOrders(m, a)], builtin("InvalidAccountData"));
      await d.ok(`CancelAllOrdersWithFreeFunds ${tag}: market Uninitialized`, payer, [ix.cancelAllOrdersWithFreeFunds(m, a)]);
      d.patch(m.market, (x) => save.copy(x));
      d.patch(m.market, (x) => x.writeBigUInt64LE(0n, OFF.orderSequenceNumber));
      await d.fails(
        `CancelAllOrdersWithFreeFunds ${tag}: FIFOMarket not initialized`,
        payer,
        [ix.cancelAllOrdersWithFreeFunds(m, a)],
        custom(E.MarketUninitialized!),
      );
      d.patch(m.market, (x) => save.copy(x));
    });

    it("sends the events of 90 cancels in 3 batches", async () => {
      const { d, payer, setup, m } = S;
      const t = await d.seated(m, RICH, RICH, `cancel all ${tag} many`);
      await place(d, setup, m, t, ladder(45, 900n), ladderUp(45, 3000n));
      await d.ok(`CancelAllOrdersWithFreeFunds ${tag}: 90 orders`, payer, [budget, ix.cancelAllOrdersWithFreeFunds(m, t)]);
      await place(d, setup, m, t, ladder(50, 900n), ladderUp(46, 3000n));
      await d.ok(`CancelAllOrders ${tag}: 96 orders`, payer, [budget, ix.cancelAllOrders(m, t)]);
    });
  });

  describe(`CancelUpTo (${tag})`, () => {
    let S: Setup;
    let a: Trader;
    let b: Trader;
    beforeAll(async () => {
      S = await newSetup(bids, seats, `cancel up to ${tag}`);
      a = await S.d.seated(S.m, RICH, RICH, `cancel up to ${tag} a`);
      b = await S.d.seated(S.m, RICH, RICH, `cancel up to ${tag} b`);
    });

    it("cancels by tick limit, search and cancel counts", async () => {
      const { d, payer, setup, m } = S;
      const refill = async () => {
        await place(d, setup, m, a, ladder(8, 1000n, 2n), ladderUp(8, 2000n, 2n));
        await place(d, setup, m, b, ladder(8, 1001n, 2n), ladderUp(8, 2001n, 2n));
      };
      await refill();
      const cases: [string, Buffer][] = [
        ["bids, 3 of them", cancelUpToParams(0, null, null, 3)],
        ["asks at or below 2006", cancelUpToParams(1, 2006n)],
        ["bids at or above 990, searching 9", cancelUpToParams(0, 990n, 9)],
        ["asks, searching 0", cancelUpToParams(1, null, 0)],
        ["asks, cancelling 0", cancelUpToParams(1, null, null, 0)],
        ["asks above every price", cancelUpToParams(1, 1n)],
        ["bids, everything", cancelUpToParams(0)],
        ["asks, searching 5, cancelling 1", cancelUpToParams(1, null, 5, 1)],
        ["asks, every limit given", cancelUpToParams(1, 3000n, 100, 100)],
      ];
      for (const [label, p] of cases) await d.ok(`CancelUpTo ${tag}: ${label}`, payer, [ix.cancelUpTo(m, a, p)]);
      await refill();
      for (const [label, p] of cases) await d.ok(`CancelUpToWithFreeFunds ${tag}: ${label}`, payer, [ix.cancelUpToWithFreeFunds(m, b, p)]);
      const stranger = await d.trader(m, 1n, 1n);
      await d.ok(`CancelUpTo ${tag}: a trader with no state`, payer, [ix.cancelUpTo(m, stranger, cancelUpToParams(0))]);
    });

    it("decodes CancelUpToParams exactly", async () => {
      const { d, payer, m } = S;
      const good = ix.cancelUpToWithFreeFunds(m, a, cancelUpToParams(1, 5n, 2, 3));
      const data = Buffer.from(good.data!);
      for (const [label, bytes] of [
        ["no params", data.subarray(0, 1)],
        ["side only", data.subarray(0, 2)],
        ["side 2", Buffer.concat([u8(9), u8(2), data.subarray(2)])],
        ["tick tag 2", Buffer.concat([u8(9), u8(1), u8(2), data.subarray(3)])],
        ["tick short", data.subarray(0, 8)],
        ["search missing", data.subarray(0, 11)],
        ["search short", data.subarray(0, 14)],
        ["cancel missing", data.subarray(0, 16)],
        ["cancel short", data.subarray(0, 19)],
        ["a byte after", Buffer.concat([data, u8(0)])],
        ["search tag 2", Buffer.concat([u8(9), u8(1), u8(0), u8(2)])],
        ["cancel tag 2", Buffer.concat([u8(9), u8(1), u8(0), u8(0), u8(2)])],
      ] as const) {
        await d.fails(`CancelUpToWithFreeFunds ${tag}: ${label}`, payer, [withData(good, bytes)], BORSH);
      }
      await d.fails(`CancelUpTo ${tag}: side 2`, payer, [withData(ix.cancelUpTo(m, a, cancelUpToParams(0)), Buffer.from([8, 2, 0, 0, 0]))], BORSH);
      for (let n = 4; n < 9; n++)
        await d.fails(`CancelUpTo ${tag}: ${n} accounts`, payer, [truncate(ix.cancelUpTo(m, a, cancelUpToParams(0)), n)], builtin("NotEnoughAccountKeys"));
    });
  });

  describe(`CancelMultipleOrdersById (${tag})`, () => {
    let S: Setup;
    let a: Trader;
    let b: Trader;
    beforeAll(async () => {
      S = await newSetup(bids, seats, `cancel by id ${tag}`);
      a = await S.d.seated(S.m, RICH, RICH, `cancel by id ${tag} a`);
      b = await S.d.seated(S.m, RICH, RICH, `cancel by id ${tag} b`);
      await place(S.d, S.setup, S.m, a, ladder(6, 1000n), ladderUp(6, 2000n));
      await place(S.d, S.setup, S.m, b, ladder(4, 999n, 2n), ladderUp(4, 2001n, 2n));
    });

    it("cancels the listed orders, skipping others', unknown ones and wrong sides", async () => {
      const { d, payer, m } = S;
      const mine = (side: "bid" | "ask") => book(d, m, side).filter((o) => o.trader === traderIndex(d, m, a));
      const theirs = book(d, m, "bid").find((o) => o.trader === traderIndex(d, m, b))!;
      const [b1, b2] = mine("bid");
      const [a1] = mine("ask");
      await d.ok(`CancelMultipleOrdersById ${tag}: one bid`, payer, [ix.cancelMultipleOrdersById(m, a, [params(b1!)])]);
      await d.ok(`CancelMultipleOrdersById ${tag}: mixed`, payer, [
        ix.cancelMultipleOrdersById(m, a, [params(b2!), params(theirs), cancelOrderParams(1, 5n, 77n), params(a1!, 0), params(a1!), params(a1!), params(b1!)]),
      ]);
      const [b3] = mine("bid");
      const [a2, a3] = mine("ask");
      await d.ok(`CancelMultipleOrdersByIdWithFreeFunds ${tag}: three`, payer, [
        ix.cancelMultipleOrdersByIdWithFreeFunds(m, a, [params(a3!), params(b3!), params(a2!)]),
      ]);
      await d.ok(`CancelMultipleOrdersById ${tag}: none`, payer, [ix.cancelMultipleOrdersById(m, a, [])]);
      await d.ok(`CancelMultipleOrdersByIdWithFreeFunds ${tag}: none`, payer, [ix.cancelMultipleOrdersByIdWithFreeFunds(m, a, [])]);
      const stranger = await d.trader(m, 1n, 1n);
      await d.ok(`CancelMultipleOrdersById ${tag}: a trader with no state`, payer, [ix.cancelMultipleOrdersById(m, stranger, [params(theirs)])]);
      // As many as a transaction holds: two batches of events.
      const t = await d.seated(m, RICH, RICH, `cancel by id ${tag} many`);
      await place(d, S.setup, m, t, ladder(25, 980n), ladderUp(25, 2100n));
      const all = [...book(d, m, "bid"), ...book(d, m, "ask")].filter((o) => o.trader === traderIndex(d, m, t));
      await d.ok(`CancelMultipleOrdersByIdWithFreeFunds ${tag}: 50 orders`, payer, [
        budget,
        ix.cancelMultipleOrdersByIdWithFreeFunds(
          m,
          t,
          all.reverse().map((o) => params(o)),
        ),
      ]);
    });

    it("decodes the list exactly", async () => {
      const { d, payer, m } = S;
      const one = cancelOrderParams(0, 100n, 1n);
      const good = ix.cancelMultipleOrdersByIdWithFreeFunds(m, a, [one, one]);
      const data = Buffer.from(good.data!);
      for (const [label, bytes] of [
        ["no count", data.subarray(0, 1)],
        ["count short", data.subarray(0, 4)],
        ["an order short", data.subarray(0, data.length - 1)],
        ["a byte after", Buffer.concat([data, u8(0)])],
        ["count above the orders", Buffer.concat([u8(11), u32(3), data.subarray(5)])],
        ["count 0 with an order", Buffer.concat([u8(11), u32(0), data.subarray(5)])],
        ["second side 2", Buffer.concat([data.subarray(0, 22), u8(2), data.subarray(23)])],
      ] as const) {
        await d.fails(`CancelMultipleOrdersByIdWithFreeFunds ${tag}: ${label}`, payer, [withData(good, bytes)], BORSH);
      }
      for (let n = 4; n < 9; n++)
        await d.fails(
          `CancelMultipleOrdersById ${tag}: ${n} accounts`,
          payer,
          [truncate(ix.cancelMultipleOrdersById(m, a, [one]), n)],
          builtin("NotEnoughAccountKeys"),
        );
      const save = d.data(m.market);
      d.patch(m.market, (x) => x.writeBigUInt64LE(0n, OFF.orderSequenceNumber));
      await d.fails(
        `CancelMultipleOrdersByIdWithFreeFunds ${tag}: FIFOMarket not initialized`,
        payer,
        [ix.cancelMultipleOrdersByIdWithFreeFunds(m, a, [one])],
        custom(E.MarketUninitialized!),
      );
      await d.ok(`CancelMultipleOrdersByIdWithFreeFunds ${tag}: none, FIFOMarket not initialized`, payer, [ix.cancelMultipleOrdersByIdWithFreeFunds(m, a, [])]);
      d.patch(m.market, (x) => save.copy(x));
    });
  });

  describe(`ForceCancelOrders and EvictSeat (${tag})`, () => {
    let S: Setup;
    let a: Trader;
    beforeAll(async () => {
      S = await newSetup(bids, seats, `force ${tag}`);
      a = await S.d.seated(S.m, RICH, RICH, `force ${tag} a`);
      await place(S.d, S.setup, S.m, a, ladder(5, 1000n), ladderUp(5, 2000n));
    });

    it("needs the authority and a seat no longer approved", async () => {
      const { d, payer, m } = S;
      await d.fails(`ForceCancelOrders ${tag}: seat still approved`, payer, [ix.forceCancelOrders(m, a, cancelUpToParams(0))], custom(E.InvalidSeatStatus!));
      await d.fails(`EvictSeat ${tag}: seat still approved`, payer, [ix.evictSeat(m, a)], custom(E.InvalidSeatStatus!));
      await d.ok(`ChangeSeatStatus ${tag}: Approved → NotApproved`, payer, [ix.changeSeatStatus(m, a.seat, 0)]);
      await d.fails(
        `ForceCancelOrders ${tag}: not the authority`,
        payer,
        [ix.forceCancelOrders(m, a, cancelUpToParams(0), a.key)],
        custom(E.InvalidMarketAuthority!),
      );
      await d.fails(`EvictSeat ${tag}: not the authority`, payer, [ix.evictSeat(m, a, a.key)], custom(E.InvalidMarketAuthority!));
      for (let n = 4; n < 11; n++) {
        await d.fails(
          `ForceCancelOrders ${tag}: ${n} accounts`,
          payer,
          [truncate(ix.forceCancelOrders(m, a, cancelUpToParams(0)), n)],
          builtin("NotEnoughAccountKeys"),
        );
        await d.fails(`EvictSeat ${tag}: ${n} accounts`, payer, [truncate(ix.evictSeat(m, a), n)], builtin("NotEnoughAccountKeys"));
      }
      await d.fails(
        `ForceCancelOrders ${tag}: params short`,
        payer,
        [withData(ix.forceCancelOrders(m, a, cancelUpToParams(0)), Buffer.from([107, 0, 0]))],
        BORSH,
      );
    });

    it("evicts only a trader without orders, sending its free funds", async () => {
      const { d, payer, m } = S;
      await d.fails(`EvictSeat ${tag}: orders on the book`, payer, [ix.evictSeat(m, a)], custom(E.EvictionError!));
      await d.ok(`ForceCancelOrders ${tag}: asks at or below 2002`, payer, [ix.forceCancelOrders(m, a, cancelUpToParams(1, 2002n))]);
      await d.ok(`ForceCancelOrders ${tag}: bids, 2 of them`, payer, [ix.forceCancelOrders(m, a, cancelUpToParams(0, null, null, 2))]);
      await d.ok(`ForceCancelOrders ${tag}: the rest of the bids`, payer, [ix.forceCancelOrders(m, a, cancelUpToParams(0))]);
      await d.fails(`EvictSeat ${tag}: asks left`, payer, [ix.evictSeat(m, a)], custom(E.EvictionError!));
      await d.ok(`ForceCancelOrders ${tag}: the rest of the asks`, payer, [ix.forceCancelOrders(m, a, cancelUpToParams(1))]);
      // Free funds left on the market (written: a NotApproved trader cannot deposit), and the tokens behind them.
      const state = traderStateAt(d, m, a);
      d.patch(m.market, (x) => {
        x.writeBigUInt64LE(5000n, state + 8);
        x.writeBigUInt64LE(3n, state + 24);
      });
      for (const vault of [m.baseVault, m.quoteVault]) d.patch(vault, (x) => x.writeBigUInt64LE(x.readBigUInt64LE(64) + 10n ** 9n, 64));
      await d.ok(`EvictSeat ${tag}: free funds sent, trader removed`, payer, [ix.evictSeat(m, a)]);
      expect(traderIndex(d, m, a)).toBe(0n);
      await d.fails(`EvictSeat ${tag}: a trader with no state`, payer, [ix.evictSeat(m, a)], custom(E.WithdrawFundsError!));
      await d.ok(`ForceCancelOrders ${tag}: a trader with no state`, payer, [ix.forceCancelOrders(m, a, cancelUpToParams(0))]);
      // A trader with nothing on the market at all, retired.
      const idle = await d.seated(m, 0n, 0n, `force ${tag} idle`);
      await d.ok(`ChangeSeatStatus ${tag}: Approved → Retired`, payer, [ix.changeSeatStatus(m, idle.seat, 2)]);
      await d.ok(`EvictSeat ${tag}: an empty trader, nothing sent`, payer, [ix.evictSeat(m, idle)]);
      expect(traderIndex(d, m, idle)).toBe(0n);
    });
  });
}

describe("hundreds of orders (4096/8321)", () => {
  let S: Setup;
  beforeAll(async () => {
    S = await newSetup(4096, 8321, "hundreds");
  });

  it("cancels 512 orders in one instruction and runs out of memory collecting 513, as Phoenix's Vec does", async () => {
    const { d, payer, setup, m } = S;
    const t = await d.seated(m, RICH, RICH, "hundreds t");
    await place(d, setup, m, t, ladder(300, 5000n), ladderUp(212, 6000n));
    await d.ok("CancelAllOrders 4096/8321: 512 orders", payer, [budget, ix.cancelAllOrders(m, t)]);
    await place(d, setup, m, t, ladder(300, 5000n), ladderUp(213, 6000n));
    await d.fails("CancelAllOrders 4096/8321: 513 orders", payer, [budget, ix.cancelAllOrders(m, t)], PANICKED_1);
    await d.fails("CancelAllOrdersWithFreeFunds 4096/8321: 513 orders", payer, [budget, ix.cancelAllOrdersWithFreeFunds(m, t)], PANICKED_1);
    await d.ok("CancelUpTo 4096/8321: 213 asks", payer, [budget, ix.cancelUpTo(m, t, cancelUpToParams(1))]);
    await place(d, setup, m, t, ladder(213, 4000n));
    await d.fails("CancelUpTo 4096/8321: 513 bids", payer, [budget, ix.cancelUpTo(m, t, cancelUpToParams(0))], PANICKED_1);
    await d.fails("CancelUpToWithFreeFunds 4096/8321: 513 bids", payer, [budget, ix.cancelUpToWithFreeFunds(m, t, cancelUpToParams(0))], PANICKED_1);
    await d.ok("CancelUpToWithFreeFunds 4096/8321: 512 of 513 bids", payer, [budget, ix.cancelUpToWithFreeFunds(m, t, cancelUpToParams(0, null, null, 512))]);
    // The authority's: the trader's seat no longer approved.
    const u = await d.seated(m, RICH, RICH, "hundreds u");
    await place(d, setup, m, u, ladder(513, 3000n));
    await d.ok("hundreds: ChangeSeatStatus Approved → NotApproved", payer, [ix.changeSeatStatus(m, u.seat, 0)]);
    await d.fails("ForceCancelOrders 4096/8321: 513 bids", payer, [budget, ix.forceCancelOrders(m, u, cancelUpToParams(0))], PANICKED_1);
    await d.ok("ForceCancelOrders 4096/8321: 300 of the first 400", payer, [budget, ix.forceCancelOrders(m, u, cancelUpToParams(0, null, 400, 300))]);
  });
});

describe("a nearly full book (4096/8321)", () => {
  let S: Setup;
  let x: Trader;
  let y: Trader;
  let z: Trader;
  beforeAll(async () => {
    S = await newSetup(4096, 8321, "full");
    const { d, setup, m } = S;
    x = await d.seated(m, RICH, RICH, "full x");
    y = await d.seated(m, RICH, RICH, "full y");
    z = await d.seated(m, RICH, RICH, "full z");
    // 4000 bids (5000 down to 1001) and 4000 asks (10000 up to 13999), interleaved: x every 40th price, y the odd
    // ones, z the rest.
    const owner = (p: bigint) => (p % 40n === 0n ? x : p % 2n === 1n ? y : z);
    for (const t of [x, y, z]) {
      const bidsOf: [bigint, bigint][] = [];
      const asksOf: [bigint, bigint][] = [];
      for (let i = 0n; i < 4000n; i++) {
        if (owner(5000n - i) === t) bidsOf.push([5000n - i, 1n + (i % 4n)]);
        if (owner(10000n + i) === t) asksOf.push([10000n + i, 1n + (i % 4n)]);
      }
      await place(d, setup, m, t, bidsOf, asksOf);
    }
    expect(book(d, m, "bid").length + book(d, m, "ask").length).toBe(8000);
  }, 600_000);

  it("walks both books whole to cancel one trader's 200 orders", async () => {
    const { d, payer, m } = S;
    await d.ok("CancelAllOrders 4096/8321: 200 of 8000 orders", payer, [budget, ix.cancelAllOrders(m, x)]);
    await d.ok("CancelAllOrders 4096/8321: none of 7800 orders", payer, [budget, ix.cancelAllOrders(m, x)]);
  });

  it("cancels up to a limit and by id on the full book", async () => {
    const { d, payer, m } = S;
    await d.ok("CancelUpTo 4096/8321: 3 asks of 7800 orders", payer, [ix.cancelUpTo(m, y, cancelUpToParams(1, null, null, 3))]);
    await d.ok("CancelUpTo 4096/8321: bids at or above 4000, searching 1500", payer, [budget, ix.cancelUpTo(m, z, cancelUpToParams(0, 4000n, 1500))]);
    const mine = book(d, m, "bid").filter((o) => o.trader === traderIndex(d, m, y));
    const asks = book(d, m, "ask").filter((o) => o.trader === traderIndex(d, m, y));
    await d.ok("CancelMultipleOrdersById 4096/8321: 1 of 7000 orders", payer, [ix.cancelMultipleOrdersById(m, y, [params(mine[700]!)])]);
    await d.ok("CancelMultipleOrdersById 4096/8321: 3 of 7000 orders", payer, [
      ix.cancelMultipleOrdersById(m, y, [params(mine[10]!), params(asks[5]!), params(mine[1200]!)]),
    ]);
    await d.ok("ReduceOrder 4096/8321: part of one of 7000 orders", payer, [ix.reduceOrder(m, y, params(asks[100]!), 1n)]);
    await d.ok("CancelAllOrders 4096/8321: 3 orders of 7000", payer, [budget, ix.cancelAllOrders(m, x)]);
  });
});
