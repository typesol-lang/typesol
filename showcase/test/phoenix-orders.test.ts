// showcase/mainnet/phoenix's order instructions and matching engine against Phoenix v1 as deployed on mainnet
// (test/programs/phoenix_v1.so), with phoenix-helpers.ts's harness: every transaction must have the same outcome, log
// lines, inner instructions (event batches and token transfers, in order), return data and account bytes (the books
// and the traders tree byte for byte). The outcomes are checked too, so that each path is really reached.
//
// Part 2: Swap, SwapWithFreeFunds, PlaceLimitOrder, PlaceLimitOrderWithFreeFunds, PlaceMultiplePostOnlyOrders and its
// free-funds form, on 512/128 and 4096/8321 markets: PostOnly, Limit and IOC / FOK orders on both sides, crossing many
// levels, partial fills, the three self-trade behaviours, match limits, minimum fills, budgets in base and in quote
// lots, fees, free funds, fail-silent orders, the multiple-order packet's grouping and failure behaviours, a full book
// (eviction and rejection), time in force (expired orders removed during matching), the order sequence number's limit,
// long matches whose events take several Log batches, and the order packet decoder (truncated and invalid packets).
// States the instructions do not reach in a test's time (a sequence number near its maximum, a 100% fee) are written
// into the market's bytes in both VMs.
import { type Address, type Instruction, type KeyPairSigner, address } from "@solana/kit";
import { Clock } from "litesvm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Diff,
  E,
  type Market,
  OFF,
  PANICKED,
  PROGRAM,
  SLOT,
  type Trader,
  U64_MAX,
  UNIX_TIMESTAMP,
  builtin,
  custom,
  cuTable,
  ix,
  multipleOrderPacket,
  orderPacket,
  type CondensedOrder,
  truncate,
  u8,
  u32,
  u64,
  withData,
} from "./phoenix-helpers.js";

const BID = 0 as const;
const ASK = 1 as const;
const ABORT = 0 as const;
const CANCEL_PROVIDE = 1 as const;
const DECREMENT_TAKE = 2 as const;
const NEW_ORDER = custom(E.NewOrderError!);
const BORSH = builtin("BorshIoError");
const INVALID_DATA = builtin("InvalidInstructionData");
/** Enough tokens of each mint for any test. */
const PLENTY = 10n ** 15n;
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

/** Every Diff of the file, for the CU table. */
const diffs: Diff[] = [];
async function diff(): Promise<Diff> {
  const d = await Diff.create();
  diffs.push(d);
  return d;
}
afterAll(() => {
  console.log(cuTable(diffs, "Phoenix v1 orders: compute units, original vs TypeSOL"));
});

// ---- Packets ---------------------------------------------------------------------------------------------------------

type PostOnlyExtra = Partial<Extract<Parameters<typeof orderPacket>[0], { kind: "PostOnly" }>>;
type LimitExtra = Partial<Extract<Parameters<typeof orderPacket>[0], { kind: "Limit" }>>;
type IocExtra = Partial<Extract<Parameters<typeof orderPacket>[0], { kind: "ImmediateOrCancel" }>>;
const po = (side: 0 | 1, price: bigint, lots: bigint, o: PostOnlyExtra = {}) =>
  orderPacket({ kind: "PostOnly", side, priceInTicks: price, numBaseLots: lots, ...o });
const lim = (side: 0 | 1, price: bigint, lots: bigint, o: LimitExtra = {}) =>
  orderPacket({ kind: "Limit", side, priceInTicks: price, numBaseLots: lots, selfTradeBehavior: CANCEL_PROVIDE, ...o });
const ioc = (side: 0 | 1, o: IocExtra = {}) => orderPacket({ kind: "ImmediateOrCancel", side, selfTradeBehavior: CANCEL_PROVIDE, ...o });
/** CondensedOrders at `prices`, `lots` each. */
const levels = (prices: bigint[], lots = 1n, o: Partial<CondensedOrder> = {}): CondensedOrder[] =>
  prices.map((p) => ({ priceInTicks: p, sizeInBaseLots: lots, ...o }));
/** Prices from `from`, `n` of them, `step` apart. */
const ladder = (from: bigint, n: number, step: bigint) => Array.from({ length: n }, (_, i) => from + BigInt(i) * step);
/** SetComputeUnitLimit, for the long matches. */
const computeUnits = (units: number): Instruction => ({ programAddress: COMPUTE_BUDGET, accounts: [], data: new Uint8Array([2, ...u32(units)]) });

/** Both VMs' Clock moved to `slot` and `unixTimestamp`. */
function setClock(d: Diff, slot: bigint, unixTimestamp: bigint): void {
  for (const vm of d.vms) vm.setClock(new Clock(slot, unixTimestamp - 1000n, 580n, 581n, unixTimestamp));
}

/** A market for one test: active, with two seated makers (`a`, `c`) and an unseated taker (`b`), all holding plenty. */
interface Book {
  m: Market;
  a: Trader;
  b: Trader;
  c: Trader;
}
async function book(d: Diff, o: { bids?: number; seats?: number; fee?: number; active?: boolean; baseLotsPerBaseUnit?: bigint } = {}): Promise<Book> {
  const bids = o.bids ?? 512;
  const m = await d.market({
    bids,
    seats: o.seats ?? 128,
    active: o.active ?? true,
    params: { takerFeeBps: o.fee ?? 0, ...(o.baseLotsPerBaseUnit ? { baseLotsPerBaseUnit: o.baseLotsPerBaseUnit } : {}) },
    label: `setup ${bids}`,
  });
  const a = await d.seated(m, PLENTY, PLENTY, "setup a");
  const c = await d.seated(m, PLENTY, PLENTY, "setup c");
  const b = await d.trader(m, PLENTY, PLENTY);
  return { m, a, b, c };
}

/** PlaceLimitOrder by `t`, which must succeed. */
async function place(d: Diff, label: string, m: Market, t: Trader, packet: Buffer): Promise<void> {
  await d.ok(label, t.key, [ix.placeLimitOrder(m, t, packet)]);
}
/** PlaceMultiplePostOnlyOrders by `t`, which must succeed. */
async function placeMany(d: Diff, label: string, m: Market, t: Trader, bids: CondensedOrder[], asks: CondensedOrder[], behavior = 0): Promise<void> {
  await d.ok(label, t.key, [ix.placeMultiplePostOnlyOrders(m, t, multipleOrderPacket(bids, asks, null, behavior))]);
}

/** The market's order sequence number. */
const orderSequenceNumber = (d: Diff, m: Market) => d.data(m.market).readBigUInt64LE(OFF.orderSequenceNumber);

const SIZES: [number, number, number][] = [
  [512, 128, 5],
  [4096, 8321, 30],
];

for (const [bids, seats, fee] of SIZES) {
  describe(`orders (${bids}/${seats}, fee ${fee} bps)`, () => {
    let d: Diff;
    const fresh = () => book(d, { bids, seats, fee });
    beforeAll(async () => {
      d = await diff();
    });

    it("PostOnly: rests on both sides, FIFO within a price, with client order ids and return data", async () => {
      const { m, a, c } = await fresh();
      await place(d, `${bids}: PostOnly bid`, m, a, po(BID, 100n, 10n, { clientOrderId: 7n }));
      await place(d, `${bids}: PostOnly bid, same price`, m, c, po(BID, 100n, 3n, { clientOrderId: (1n << 127n) + 5n }));
      await place(d, `${bids}: PostOnly bid, lower`, m, a, po(BID, 99n, 4n));
      await place(d, `${bids}: PostOnly ask`, m, a, po(ASK, 110n, 10n, { clientOrderId: U64_MAX }));
      await place(d, `${bids}: PostOnly ask, same price`, m, c, po(ASK, 110n, 2n));
      await place(d, `${bids}: PostOnly ask, higher`, m, c, po(ASK, 125n, 1n));
      // An ask's price of 0 is raised to 1 tick (here it crosses the bids and is amended above them).
      await place(d, `${bids}: PostOnly ask at 0, amended`, m, c, po(ASK, 0n, 1n, { rejectPostOnly: false }));
    });

    it("PostOnly: crossing orders are rejected or amended", async () => {
      const { m, a, c } = await fresh();
      await place(d, `${bids}: cross setup bid`, m, a, po(BID, 100n, 5n));
      await place(d, `${bids}: cross setup ask`, m, a, po(ASK, 105n, 5n));
      await d.fails(`${bids}: PostOnly bid crossing, rejected`, c.key, [ix.placeLimitOrder(m, c, po(BID, 105n, 1n))], NEW_ORDER);
      await d.fails(`${bids}: PostOnly ask crossing, rejected`, c.key, [ix.placeLimitOrder(m, c, po(ASK, 90n, 1n))], NEW_ORDER);
      await place(d, `${bids}: PostOnly bid crossing, amended`, m, c, po(BID, 200n, 2n, { rejectPostOnly: false }));
      await place(d, `${bids}: PostOnly ask crossing, amended`, m, c, po(ASK, 1n, 2n, { rejectPostOnly: false }));
      // A bid that would have to go to 0 ticks.
      const low = await fresh();
      await place(d, `${bids}: ask at 1 tick`, low.m, low.a, po(ASK, 1n, 1n));
      await d.fails(
        `${bids}: PostOnly bid not amendable`,
        low.c.key,
        [ix.placeLimitOrder(low.m, low.c, po(BID, 5n, 1n, { rejectPostOnly: false }))],
        NEW_ORDER,
      );
      // The trader's own resting order is crossed too.
      await place(d, `${bids}: PostOnly ask amended against own bid`, m, a, po(ASK, 50n, 1n, { rejectPostOnly: false }));
    });

    it("refuses bids at 0 ticks and orders of no size", async () => {
      const { m, a, b } = await fresh();
      await d.fails(`${bids}: PostOnly bid at 0`, a.key, [ix.placeLimitOrder(m, a, po(BID, 0n, 1n))], NEW_ORDER);
      await d.fails(`${bids}: Limit bid at 0`, a.key, [ix.placeLimitOrder(m, a, lim(BID, 0n, 1n))], NEW_ORDER);
      await d.fails(`${bids}: PostOnly of 0 lots`, a.key, [ix.placeLimitOrder(m, a, po(ASK, 10n, 0n))], NEW_ORDER);
      await d.fails(`${bids}: Limit of 0 lots`, a.key, [ix.placeLimitOrder(m, a, lim(BID, 10n, 0n))], NEW_ORDER);
      await d.fails(`${bids}: IOC of 0 lots`, b.key, [ix.swap(m, b, ioc(BID, { priceInTicks: 10n }))], NEW_ORDER);
      await d.fails(`${bids}: IOC in base and quote lots`, b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 1n, numQuoteLots: 1n }))], NEW_ORDER);
      await d.fails(`${bids}: IOC bid at 0`, b.key, [ix.swap(m, b, ioc(BID, { priceInTicks: 0n, numBaseLots: 1n }))], NEW_ORDER);
    });

    it("Limit: rests, fills partly and rests the rest, crosses several levels", async () => {
      const { m, a, b, c } = await fresh();
      await placeMany(d, `${bids}: limit setup asks`, m, a, [], [...levels([110n, 111n], 5n), ...levels([112n], 7n)]);
      await placeMany(d, `${bids}: limit setup bids`, m, a, [...levels([100n, 99n], 5n), ...levels([98n], 7n)], []);
      await place(d, `${bids}: Limit bid resting`, m, c, lim(BID, 105n, 3n, { clientOrderId: 11n }));
      await place(d, `${bids}: Limit bid, partial fill then rests`, m, c, lim(BID, 110n, 8n));
      await place(d, `${bids}: Limit ask through three levels`, m, c, lim(ASK, 98n, 20n));
      await place(d, `${bids}: Limit bid through two levels`, m, c, lim(BID, 112n, 12n));
      // A Limit order whose match limit leaves it crossing does not rest.
      await placeMany(d, `${bids}: limit setup more asks`, m, a, [], levels([113n, 114n, 115n], 2n));
      await place(d, `${bids}: Limit bid, match limit 1, still crossing`, m, c, lim(BID, 115n, 6n, { matchLimit: 1n }));
      await place(d, `${bids}: Limit bid, match limit 0`, m, c, lim(BID, 115n, 1n, { matchLimit: 0n }));
      // The taker side: tokens move both ways.
      await d.ok(`${bids}: unseated taker swaps`, b.key, [ix.swap(m, b, ioc(BID, { priceInTicks: 200n, numBaseLots: 1n }))]);
    });

    it("IOC and FOK: base or quote budgets, price limits, market orders, minimum fills", async () => {
      const { m, a, b } = await fresh();
      await placeMany(d, `${bids}: ioc setup asks`, m, a, [], [...levels([110n, 111n, 112n], 5n)]);
      await placeMany(d, `${bids}: ioc setup bids`, m, a, [...levels([100n, 99n, 98n], 5n)], []);
      await d.ok(`${bids}: IOC buy 7 base lots, limit 111`, b.key, [ix.swap(m, b, ioc(BID, { priceInTicks: 111n, numBaseLots: 7n, clientOrderId: 3n }))]);
      await d.ok(`${bids}: IOC sell 6 base lots, market`, b.key, [ix.swap(m, b, ioc(ASK, { numBaseLots: 6n }))]);
      await d.ok(`${bids}: IOC buy for 700 quote lots`, b.key, [ix.swap(m, b, ioc(BID, { numQuoteLots: 700n }))]);
      await d.ok(`${bids}: IOC sell for 300 quote lots`, b.key, [ix.swap(m, b, ioc(ASK, { priceInTicks: 90n, numQuoteLots: 300n }))]);
      await d.fails(
        `${bids}: IOC below its minimum base fill`,
        b.key,
        [ix.swap(m, b, ioc(BID, { priceInTicks: 112n, numBaseLots: 9n, minBaseLotsToFill: 9n }))],
        NEW_ORDER,
      );
      await d.fails(
        `${bids}: IOC below its minimum quote fill`,
        b.key,
        [ix.swap(m, b, ioc(ASK, { numBaseLots: 2n, minQuoteLotsToFill: 10n ** 9n }))],
        NEW_ORDER,
      );
      await d.ok(`${bids}: FOK buy filled`, b.key, [ix.swap(m, b, ioc(BID, { priceInTicks: 112n, numBaseLots: 2n, minBaseLotsToFill: 2n }))]);
      await d.ok(`${bids}: FOK by quote lots`, b.key, [ix.swap(m, b, ioc(ASK, { numQuoteLots: 200n, minQuoteLotsToFill: 1n }))]);
      await d.ok(`${bids}: IOC with nothing in range`, b.key, [ix.swap(m, b, ioc(BID, { priceInTicks: 50n, numBaseLots: 2n }))]);
      await d.ok(`${bids}: IOC buy, match limit 2`, b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 100n, matchLimit: 2n }))]);
      await d.ok(`${bids}: IOC sells out the bids`, b.key, [ix.swap(m, b, ioc(ASK, { numBaseLots: 1000n }))]);
      await d.ok(`${bids}: IOC sell on an empty book`, b.key, [ix.swap(m, b, ioc(ASK, { numBaseLots: 1n }))]);
    });

    it("self trades: Abort, CancelProvide, DecrementTake", async () => {
      const { m, a, c } = await fresh();
      await placeMany(d, `${bids}: self setup asks a`, m, a, [], [...levels([110n], 4n), ...levels([111n], 6n)]);
      await place(d, `${bids}: self setup ask c`, m, c, po(ASK, 110n, 3n));
      await d.fails(`${bids}: self trade, Abort`, a.key, [ix.placeLimitOrder(m, a, lim(BID, 111n, 5n, { selfTradeBehavior: ABORT }))], NEW_ORDER);
      // CancelProvide: a's 110 order is cancelled, c's filled, the match goes on to a's 111 order (cancelled too).
      await place(d, `${bids}: self trade, CancelProvide`, m, a, lim(BID, 111n, 5n, { selfTradeBehavior: CANCEL_PROVIDE }));
      await placeMany(d, `${bids}: self setup asks again`, m, a, [], [...levels([120n], 4n), ...levels([121n], 6n)]);
      // DecrementTake: a's resting order and the incoming budget go down together.
      await place(d, `${bids}: self trade, DecrementTake partial`, m, a, lim(BID, 121n, 2n, { selfTradeBehavior: DECREMENT_TAKE }));
      await place(d, `${bids}: self trade, DecrementTake through a level`, m, a, lim(BID, 121n, 5n, { selfTradeBehavior: DECREMENT_TAKE }));
      await d.ok(`${bids}: self trade by IOC, DecrementTake in quote lots`, a.key, [
        ix.swap(m, a, ioc(BID, { numQuoteLots: 300n, selfTradeBehavior: DECREMENT_TAKE })),
      ]);
      await d.fails(`${bids}: self trade by IOC, Abort`, a.key, [ix.swap(m, a, ioc(BID, { numBaseLots: 1n, selfTradeBehavior: ABORT }))], NEW_ORDER);
    });

    it("free funds: deposited lots pay, proceeds stay on the market", async () => {
      const { m, a, c } = await fresh();
      await d.ok(`${bids}: free setup deposit`, c.key, [ix.depositFunds(m, c, 100_000n, 50n)]);
      await d.ok(`${bids}: PostOnly ask on free funds`, c.key, [ix.placeLimitOrderWithFreeFunds(m, c, po(ASK, 110n, 20n, { useOnlyDepositedFunds: true }))]);
      await d.ok(`${bids}: PostOnly bid on free funds`, c.key, [ix.placeLimitOrderWithFreeFunds(m, c, po(BID, 100n, 30n, { useOnlyDepositedFunds: true }))]);
      await d.fails(
        `${bids}: free funds short`,
        c.key,
        [ix.placeLimitOrderWithFreeFunds(m, c, po(ASK, 120n, 1000n, { useOnlyDepositedFunds: true }))],
        NEW_ORDER,
      );
      await d.fails(
        `${bids}: free funds short for a bid`,
        c.key,
        [ix.placeLimitOrderWithFreeFunds(m, c, po(BID, 90n, 10n ** 6n, { useOnlyDepositedFunds: true }))],
        NEW_ORDER,
      );
      await place(d, `${bids}: free setup ask a`, m, a, po(ASK, 111n, 10n));
      await d.ok(`${bids}: SwapWithFreeFunds buy`, c.key, [ix.swapWithFreeFunds(m, c, ioc(BID, { numBaseLots: 5n, useOnlyDepositedFunds: true }))]);
      await d.ok(`${bids}: SwapWithFreeFunds sell`, c.key, [ix.swapWithFreeFunds(m, c, ioc(ASK, { numBaseLots: 3n, useOnlyDepositedFunds: true }))]);
      await d.ok(`${bids}: SwapWithFreeFunds sell, nothing left to match`, c.key, [
        ix.swapWithFreeFunds(m, c, ioc(ASK, { numBaseLots: 1000n, useOnlyDepositedFunds: true })),
      ]);
      await d.ok(`${bids}: Limit on free funds crossing`, c.key, [
        ix.placeLimitOrderWithFreeFunds(m, c, lim(BID, 111n, 7n, { useOnlyDepositedFunds: true, selfTradeBehavior: DECREMENT_TAKE })),
      ]);
      // A seated trader's free lots also pay first for orders with token accounts.
      await d.ok(`${bids}: Swap by a trader with free lots`, c.key, [ix.swap(m, c, ioc(ASK, { numBaseLots: 2n }))]);
      await place(d, `${bids}: PostOnly bid using free lots and tokens`, m, c, po(BID, 101n, 200n));
    });

    it("fail-silent orders: skipped when the funds are short", async () => {
      const { m, a } = await fresh();
      const poor = await d.seated(m, 3_000_000n, 500n, "setup poor");
      await place(d, `${bids}: fail-silent ask, funded`, m, poor, po(ASK, 110n, 3n, { failSilentlyOnInsufficientFunds: true }));
      await place(d, `${bids}: fail-silent ask, short`, m, poor, po(ASK, 110n, 1n, { failSilentlyOnInsufficientFunds: true }));
      await place(d, `${bids}: fail-silent bid, short`, m, poor, po(BID, 100n, 10n, { failSilentlyOnInsufficientFunds: true }));
      await place(d, `${bids}: fail-silent Limit bid, funded`, m, poor, lim(BID, 100n, 5n, { failSilentlyOnInsufficientFunds: true }));
      await d.ok(`${bids}: fail-silent deposit`, a.key, [ix.depositFunds(m, a, 0n, 5n)]);
      await d.ok(`${bids}: fail-silent on free funds, short`, a.key, [
        ix.placeLimitOrderWithFreeFunds(m, a, po(ASK, 120n, 6n, { useOnlyDepositedFunds: true, failSilentlyOnInsufficientFunds: true })),
      ]);
      await d.ok(`${bids}: fail-silent on free funds, funded`, a.key, [
        ix.placeLimitOrderWithFreeFunds(m, a, po(ASK, 120n, 5n, { useOnlyDepositedFunds: true, failSilentlyOnInsufficientFunds: true })),
      ]);
      // Without the flag the token transfer fails.
      await d.fails(`${bids}: ask beyond the tokens`, poor.key, [ix.placeLimitOrder(m, poor, po(ASK, 130n, 5n))], custom(1));
    });

    it("checks the instruction against the packet", async () => {
      const { m, a, b } = await fresh();
      await d.fails(`${bids}: Swap with a PostOnly packet`, b.key, [ix.swap(m, b, po(BID, 10n, 1n))], INVALID_DATA);
      await d.fails(`${bids}: Swap with a Limit packet`, b.key, [ix.swap(m, b, lim(BID, 10n, 1n))], INVALID_DATA);
      await d.fails(`${bids}: Swap on deposited funds`, b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 1n, useOnlyDepositedFunds: true }))], INVALID_DATA);
      await d.fails(
        `${bids}: SwapWithFreeFunds of a PostOnly`,
        a.key,
        [ix.swapWithFreeFunds(m, a, po(BID, 10n, 1n, { useOnlyDepositedFunds: true }))],
        INVALID_DATA,
      );
      await d.fails(`${bids}: SwapWithFreeFunds with tokens`, a.key, [ix.swapWithFreeFunds(m, a, ioc(BID, { numBaseLots: 1n }))], INVALID_DATA);
      await d.fails(`${bids}: PlaceLimitOrder of an IOC`, a.key, [ix.placeLimitOrder(m, a, ioc(BID, { numBaseLots: 1n }))], INVALID_DATA);
      await d.fails(
        `${bids}: PlaceLimitOrder on deposited funds`,
        a.key,
        [ix.placeLimitOrder(m, a, po(BID, 10n, 1n, { useOnlyDepositedFunds: true }))],
        INVALID_DATA,
      );
      await d.fails(
        `${bids}: PlaceLimitOrderWithFreeFunds of an IOC`,
        a.key,
        [ix.placeLimitOrderWithFreeFunds(m, a, ioc(BID, { numBaseLots: 1n }))],
        INVALID_DATA,
      );
      await d.fails(`${bids}: PlaceLimitOrderWithFreeFunds with tokens`, a.key, [ix.placeLimitOrderWithFreeFunds(m, a, po(BID, 10n, 1n))], INVALID_DATA);
      // Accounts are taken in order: the seat, then the vault context.
      for (let n = 4; n < 10; n++)
        await d.fails(
          `${bids}: PlaceLimitOrder with ${n} accounts`,
          a.key,
          [truncate(ix.placeLimitOrder(m, a, po(BID, 10n, 1n)), n)],
          builtin("NotEnoughAccountKeys"),
        );
      for (let n = 4; n < 9; n++)
        await d.fails(`${bids}: Swap with ${n} accounts`, b.key, [truncate(ix.swap(m, b, ioc(BID, { numBaseLots: 1n })), n)], builtin("NotEnoughAccountKeys"));
      await d.fails(
        `${bids}: SwapWithFreeFunds with no seat`,
        a.key,
        [truncate(ix.swapWithFreeFunds(m, a, ioc(BID, { numBaseLots: 1n })), 4)],
        builtin("NotEnoughAccountKeys"),
      );
      // A trader with no seat.
      await d.fails(`${bids}: PlaceLimitOrder without a seat`, b.key, [ix.placeLimitOrder(m, b, po(BID, 10n, 1n))], builtin("IllegalOwner"));
    });

    it("market status: posts in PostOnly, no crossing there, nothing when paused", async () => {
      const { m, a, b, c } = await fresh();
      await place(d, `${bids}: status setup ask`, m, a, po(ASK, 110n, 5n));
      await d.ok(`${bids}: status PostOnly`, m.authority, [ix.changeMarketStatus(m, 2)]);
      await place(d, `${bids}: PostOnly while PostOnly`, m, c, po(BID, 100n, 1n));
      await d.fails(`${bids}: Swap while PostOnly`, b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 1n }))], builtin("InvalidAccountData"));
      await d.fails(`${bids}: crossing Limit while PostOnly`, c.key, [ix.placeLimitOrder(m, c, lim(BID, 110n, 1n))], builtin("InvalidAccountData"));
      await d.ok(`${bids}: free setup deposit while PostOnly`, c.key, [ix.depositFunds(m, c, 10_000n, 0n)]);
      await d.ok(`${bids}: crossing Limit on free funds while PostOnly`, c.key, [
        ix.placeLimitOrderWithFreeFunds(m, c, lim(BID, 110n, 1n, { useOnlyDepositedFunds: true })),
      ]);
      await d.ok(`${bids}: status Paused`, m.authority, [ix.changeMarketStatus(m, 3)]);
      await d.fails(`${bids}: PostOnly while Paused`, c.key, [ix.placeLimitOrder(m, c, po(BID, 100n, 1n))], builtin("InvalidAccountData"));
      await d.fails(
        `${bids}: multiple orders while Paused`,
        c.key,
        [ix.placeMultiplePostOnlyOrders(m, c, multipleOrderPacket(levels([90n]), []))],
        builtin("InvalidAccountData"),
      );
    });

    it("time in force: TimeInForce events, expired orders removed while matching", async () => {
      const { m, a, b, c } = await fresh();
      await place(d, `${bids}: tif ask, last slot`, m, a, po(ASK, 110n, 3n, { lastValidSlot: SLOT + 10n }));
      await place(d, `${bids}: tif ask, last timestamp`, m, a, po(ASK, 111n, 3n, { lastValidUnixTimestampInSeconds: UNIX_TIMESTAMP + 10n }));
      await place(d, `${bids}: tif ask, both`, m, c, po(ASK, 112n, 3n, { lastValidSlot: SLOT + 100n, lastValidUnixTimestampInSeconds: UNIX_TIMESTAMP + 5n }));
      await place(d, `${bids}: tif ask, none`, m, c, po(ASK, 113n, 3n));
      await place(d, `${bids}: tif bid, last slot`, m, c, po(BID, 100n, 3n, { lastValidSlot: SLOT + 1n }));
      await place(d, `${bids}: tif expired packet`, m, a, po(BID, 90n, 3n, { lastValidSlot: SLOT - 1n }));
      await d.ok(`${bids}: tif expired IOC packet`, b.key, [
        ix.swap(m, b, ioc(BID, { numBaseLots: 1n, lastValidUnixTimestampInSeconds: UNIX_TIMESTAMP - 1n })),
      ]);
      setClock(d, SLOT + 20n, UNIX_TIMESTAMP + 8n);
      // The slot-limited ask expired, the others are good: a Limit order still crosses the 111 ask, unexpired.
      await place(d, `${bids}: Limit bid skips the expired ask when checking the cross`, m, c, lim(BID, 110n, 1n, { matchLimit: 0n }));
      await d.ok(`${bids}: IOC buy removes the expired ask`, b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 2n }))]);
      setClock(d, SLOT + 200n, UNIX_TIMESTAMP + 20n);
      // A PostOnly removes the expired orders it would cross.
      await place(d, `${bids}: PostOnly bid clears expired asks`, m, a, po(BID, 112n, 1n));
      await d.ok(`${bids}: IOC sell removes the expired bid`, b.key, [ix.swap(m, b, ioc(ASK, { numBaseLots: 5n, matchLimit: 1n }))]);
      setClock(d, SLOT, UNIX_TIMESTAMP);
    });

    it("multiple PostOnly orders: sorted and merged by level, return data", async () => {
      const { m, a, c } = await fresh();
      // Five orders, two at one level: four orders rest.
      await placeMany(d, `${bids}: multi 5 to 4`, m, a, levels([100n, 98n, 100n]), levels([110n, 111n], 2n));
      await d.ok(`${bids}: multi unsorted, client order id`, c.key, [
        ix.placeMultiplePostOnlyOrders(
          m,
          c,
          multipleOrderPacket(
            [
              { priceInTicks: 95n, sizeInBaseLots: 1n },
              { priceInTicks: 97n, sizeInBaseLots: 2n, lastValidSlot: SLOT + 5n },
              { priceInTicks: 97n, sizeInBaseLots: 3n },
              { priceInTicks: 97n, sizeInBaseLots: 4n, lastValidSlot: SLOT + 5n },
              { priceInTicks: 96n, sizeInBaseLots: 5n, lastValidUnixTimestampInSeconds: UNIX_TIMESTAMP + 1n },
            ],
            [
              { priceInTicks: 130n, sizeInBaseLots: 1n },
              { priceInTicks: 120n, sizeInBaseLots: 1n },
              { priceInTicks: 120n, sizeInBaseLots: 1n },
            ],
            123456789n,
          ),
        ),
      ]);
      await placeMany(d, `${bids}: multi nothing`, m, c, [], []);
      await d.ok(`${bids}: multi on free funds deposit`, c.key, [ix.depositFunds(m, c, 1_000_000n, 100n)]);
      await d.ok(`${bids}: multi on free funds`, c.key, [
        ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, c, multipleOrderPacket(levels([90n, 91n], 3n), levels([140n, 141n], 4n))),
      ]);
      await d.fails(
        `${bids}: multi on free funds, short`,
        c.key,
        [ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, c, multipleOrderPacket([], levels([150n], 1000n)))],
        NEW_ORDER,
      );
    });

    it("multiple PostOnly orders: crossing input, and the four failure behaviors", async () => {
      const { m, a, c } = await fresh();
      const crossing = multipleOrderPacket(levels([100n]), levels([100n]));
      await d.fails(`${bids}: multi crossing input`, c.key, [ix.placeMultiplePostOnlyOrders(m, c, crossing)], builtin("InvalidArgument"));
      await d.fails(
        `${bids}: multi lone ask at 0`,
        c.key,
        [ix.placeMultiplePostOnlyOrders(m, c, multipleOrderPacket([], levels([0n])))],
        builtin("InvalidArgument"),
      );
      await placeMany(d, `${bids}: multi behaviors setup`, m, a, levels([100n]), levels([110n]));
      // Amend on cross (0 and 2), fail on cross (1 and 3).
      await placeMany(d, `${bids}: multi bids amended on cross`, m, c, levels([115n, 105n]), [], 0);
      await placeMany(d, `${bids}: multi ask amended on cross`, m, c, [], levels([95n]), 2);
      await d.fails(`${bids}: multi fail on cross`, c.key, [ix.placeMultiplePostOnlyOrders(m, c, multipleOrderPacket(levels([115n]), [], null, 1))], NEW_ORDER);
      const poor = await d.seated(m, 2_000_000n, 3_000n, "setup poor");
      await d.ok(`${bids}: multi skip on insufficient funds, amend`, poor.key, [
        ix.placeMultiplePostOnlyOrders(m, poor, multipleOrderPacket(levels([96n, 97n], 10n), levels([120n, 121n, 122n], 1n), null, 2)),
      ]);
      await d.ok(`${bids}: multi skip on insufficient funds, fail on cross`, poor.key, [
        ix.placeMultiplePostOnlyOrders(m, poor, multipleOrderPacket(levels([10n, 11n], 30n), levels([200n], 5n), null, 3)),
      ]);
      await d.fails(
        `${bids}: multi skip, crossing`,
        c.key,
        [ix.placeMultiplePostOnlyOrders(m, c, multipleOrderPacket([], levels([1n], 1n), null, 3))],
        NEW_ORDER,
      );
      await d.fails(
        `${bids}: multi fail on insufficient funds`,
        poor.key,
        [ix.placeMultiplePostOnlyOrders(m, poor, multipleOrderPacket([], levels([300n], 100n), null, 0))],
        custom(1),
      );
    });

    it("multiple PostOnly orders: Borsh decoding", async () => {
      const { m, c } = await fresh();
      const good = multipleOrderPacket(levels([90n]), levels([110n]), 5n, 1);
      const send = (label: string, data: Buffer, expected: string) =>
        d.fails(`${bids}: multi ${label}`, c.key, [withData(ix.placeMultiplePostOnlyOrders(m, c, good), Buffer.concat([u8(16), data]))], expected);
      await send("one byte short", good.subarray(0, good.length - 1), BORSH);
      await send("one byte more", Buffer.concat([good, u8(0)]), BORSH);
      await send("behavior 4", Buffer.concat([good.subarray(0, good.length - 1), u8(4)]), BORSH);
      const badTag = Buffer.from(good);
      badTag[4 + 16] = 2;
      await send("Option tag 2", badTag, BORSH);
      await send("a count past the data", Buffer.concat([u32(3), good.subarray(4)]), BORSH);
      await send("empty", Buffer.alloc(0), BORSH);
    });
  });
}

describe("a full book (512/128)", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await diff();
  });

  it("evicts the least aggressive order for a better one, and refuses a worse one", async () => {
    const { m, a, c } = await book(d);
    // 512 bids at 1000..1511 and 512 asks at 3000..3511, 40 orders a transaction.
    for (let from = 0; from < 512; from += 40) {
      const n = Math.min(40, 512 - from);
      await placeMany(d, "full: fill bids", m, from % 80 === 0 ? a : c, levels(ladder(1000n + BigInt(from), n, 1n)), []);
      await placeMany(d, "full: fill asks", m, from % 80 === 0 ? c : a, [], levels(ladder(3000n + BigInt(from), n, 1n), 2n));
    }
    await place(d, "full: a better bid evicts the lowest", m, c, po(BID, 2000n, 3n));
    await d.fails("full: a bid at the lowest price is refused", c.key, [ix.placeLimitOrder(m, c, po(BID, 1001n, 1n))], NEW_ORDER);
    await d.fails("full: a worse bid is refused", c.key, [ix.placeLimitOrder(m, c, lim(BID, 500n, 1n))], NEW_ORDER);
    await place(d, "full: a better ask evicts the highest", m, a, po(ASK, 2500n, 1n));
    await d.fails("full: a worse ask is refused", a.key, [ix.placeLimitOrder(m, a, po(ASK, 4000n, 1n))], NEW_ORDER);
    // A Limit order that matches first makes room for itself.
    await place(d, "full: a Limit ask fills a bid, then rests", m, a, lim(ASK, 2000n, 5n));
    await d.ok("full: multiple orders evict", c.key, [ix.placeMultiplePostOnlyOrders(m, c, multipleOrderPacket(levels([2100n, 2101n]), []))]);
    await d.fails(
      "full: multiple orders, one refused",
      c.key,
      [ix.placeMultiplePostOnlyOrders(m, c, multipleOrderPacket(levels([2102n, 900n]), []))],
      NEW_ORDER,
    );
  });
});

describe("fees, overflows and limits (512/128)", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await diff();
  });

  it("charges a 100% fee; selling for quote lots then divides by zero", async () => {
    const { m, a, b } = await book(d, { fee: 10000 });
    await placeMany(d, "fee 100%: setup", m, a, levels([100n, 99n], 5n), levels([110n, 111n], 5n));
    await d.ok("fee 100%: IOC buy", b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 3n }))]);
    await d.ok("fee 100%: IOC buy for quote lots", b.key, [ix.swap(m, b, ioc(BID, { numQuoteLots: 1000n }))]);
    await d.ok("fee 100%: IOC sell", b.key, [ix.swap(m, b, ioc(ASK, { numBaseLots: 3n }))]);
    await d.fails("fee 100%: IOC sell for quote lots", b.key, [ix.swap(m, b, ioc(ASK, { numQuoteLots: 100n }))], PANICKED);
  });

  it("rounds fees up to whole quote lots (more base lots per unit than the tick)", async () => {
    const { m, a, b } = await book(d, { fee: 1, baseLotsPerBaseUnit: 10n });
    await placeMany(d, "fee rounding: setup", m, a, levels([7n, 6n], 3n), levels([9n, 13n], 3n));
    await d.ok("fee rounding: IOC buy", b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 4n }))]);
    await d.ok("fee rounding: IOC sell for quote lots", b.key, [ix.swap(m, b, ioc(ASK, { numQuoteLots: 3333n }))]);
  });

  it("panics on overflows where Phoenix's quantities overflow", async () => {
    const { m, a, b } = await book(d);
    // tick size × price (QuoteLotsPerBaseUnitPerTick × Ticks), then × lots (QuoteLotsPerBaseUnit × BaseLots).
    await d.fails("overflow: tick × price", a.key, [ix.placeLimitOrder(m, a, po(BID, 1n << 60n, 1n))], PANICKED);
    await d.fails("overflow: price × lots", a.key, [ix.placeLimitOrder(m, a, po(BID, 1n << 40n, 1n << 30n))], PANICKED);
    // quote lots × base lots per base unit (an IOC's quote budget).
    await d.fails("overflow: quote budget", b.key, [ix.swap(m, b, ioc(BID, { numQuoteLots: 1n << 60n }))], PANICKED);
    // lots × lot size: the base atoms an ask deposits.
    await d.fails("overflow: base atoms", a.key, [ix.placeLimitOrder(m, a, po(ASK, 10n, 1n << 50n))], PANICKED);
    // The sizes of one level of a multiple-order packet.
    await d.fails(
      "overflow: one level's size",
      a.key,
      [ix.placeMultiplePostOnlyOrders(m, a, multipleOrderPacket([], [...levels([500n], U64_MAX), ...levels([500n], 1n)]))],
      PANICKED,
    );
  });

  it("stops placing at the largest order sequence number", async () => {
    const { m, a, b } = await book(d);
    d.patch(m.market, (data) => data.writeBigUInt64LE((U64_MAX >> 1n) - 2n, OFF.orderSequenceNumber));
    await place(d, "sequence: an ask, two below the limit", m, a, po(ASK, 110n, 1n));
    await place(d, "sequence: a bid, one below the limit", m, a, po(BID, 100n, 1n));
    expect(orderSequenceNumber(d, m)).toBe(U64_MAX >> 1n);
    await d.fails("sequence: at the limit", a.key, [ix.placeLimitOrder(m, a, po(BID, 99n, 1n))], NEW_ORDER);
    await d.fails("sequence: an IOC at the limit", b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 1n }))], NEW_ORDER);
    await d.fails("sequence: multiple orders at the limit", a.key, [ix.placeMultiplePostOnlyOrders(m, a, multipleOrderPacket(levels([90n]), []))], NEW_ORDER);
  });

  it("registers traders: a full traders tree refuses a new one", async () => {
    const { m, a, b } = await book(d);
    // 126 more seats fill the 128 trader slots.
    for (let i = 0; i < 126; i++) await d.seated(m, 0n, 0n, "traders: fill");
    // A seat approved in the account for a trader the full tree could not register.
    const late = await d.trader(m, PLENTY, PLENTY);
    const seat = Buffer.from(d.data(a.seat));
    d.data(late.base).copy(seat, 40, 32, 64);
    d.write(late.seat, PROGRAM, seat);
    await d.fails("traders: full, PostOnly", late.key, [ix.placeLimitOrder(m, late, po(BID, 10n, 1n))], NEW_ORDER);
    await d.fails(
      "traders: full, fail-silent order",
      late.key,
      [ix.placeLimitOrder(m, late, po(BID, 10n, 1n, { failSilentlyOnInsufficientFunds: true }))],
      custom(E.TraderNotFound!),
    );
    await d.fails(
      "traders: full, multiple orders",
      late.key,
      [ix.placeMultiplePostOnlyOrders(m, late, multipleOrderPacket(levels([10n]), []))],
      custom(E.TraderNotFound!),
    );
    await place(d, "traders: full, setup ask", m, a, po(ASK, 20n, 2n));
    await d.ok("traders: full, a swap needs no registration", late.key, [ix.swap(m, late, ioc(BID, { numBaseLots: 1n }))]);
    await d.ok("traders: an unseated taker", b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 1n }))]);
  });
});

describe("long matches (512/128)", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await diff();
  });

  it("sends the events in several batches, before the token transfers", async () => {
    const { m, a, b, c } = await book(d, { fee: 5 });
    await placeMany(d, "long: 40 asks", m, a, [], levels(ladder(200n, 40, 1n), 3n));
    await d.ok("long: 40 fills", b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 120n }))]);
    await placeMany(d, "long: 40 bids", m, c, levels(ladder(100n, 40, 1n), 2n), []);
    await d.ok("long: a Limit ask through 35 bids, then rests", a.key, [ix.placeLimitOrder(m, a, lim(ASK, 105n, 80n))]);
  });

  it("counts more than 256 events with a u16 index", async () => {
    const { m, a, b, c } = await book(d);
    for (let i = 0; i < 300; i += 40)
      await placeMany(d, "u16: asks", m, i % 80 === 0 ? a : c, [], levels(ladder(1000n + BigInt(i), Math.min(40, 300 - i), 1n)));
    await d.ok("u16: 300 fills", b.key, [computeUnits(1_400_000), ix.swap(m, b, ioc(BID, { numBaseLots: 300n }))]);
  });
});

describe("the order packet decoder", () => {
  let d: Diff;
  let bk: Book;
  beforeAll(async () => {
    d = await diff();
    bk = await book(d);
    await placeMany(d, "decoder: setup", bk.m, bk.a, levels([100n], 50n), levels([110n], 50n));
  });

  /** The packet for PlaceLimitOrder (PostOnly, Limit) or Swap (IOC), sent as the instruction's data after its tag. */
  async function send(label: string, packet: Buffer, swap: boolean): Promise<string> {
    const { m, a, b } = bk;
    const i = swap ? ix.swap(m, b, Buffer.alloc(0)) : ix.placeLimitOrder(m, a, Buffer.alloc(0));
    return d.both(`decoder: ${label}`, swap ? b.key : a.key, [withData(i, Buffer.concat([u8(swap ? 0 : 2), packet]))]);
  }

  it("decodes packets written without their trailing fields, padding them with zeros", async () => {
    const packets: [string, Buffer, boolean][] = [
      ["PostOnly", po(BID, 90n, 1n), false],
      ["PostOnly with both times", po(ASK, 120n, 1n, { lastValidSlot: SLOT + 99n, lastValidUnixTimestampInSeconds: UNIX_TIMESTAMP + 99n }), false],
      ["PostOnly with a slot", po(ASK, 121n, 1n, { lastValidSlot: SLOT + 300n }), false],
      ["Limit", lim(BID, 91n, 1n, { matchLimit: 3n }), false],
      ["Limit with a timestamp", lim(ASK, 122n, 1n, { lastValidUnixTimestampInSeconds: UNIX_TIMESTAMP + 77n }), false],
      ["IOC", ioc(BID, { numBaseLots: 1n }), true],
      [
        "IOC with a price and times",
        ioc(ASK, { priceInTicks: 90n, numBaseLots: 1n, lastValidSlot: SLOT + 5n, lastValidUnixTimestampInSeconds: UNIX_TIMESTAMP + 70000n }),
        true,
      ],
    ];
    const outcomes = new Set<string>();
    for (const [label, packet, swap] of packets) {
      outcomes.add(await send(`${label}, whole`, packet, swap));
      for (let cut = 1; cut <= 4; cut++) outcomes.add(await send(`${label}, ${cut} cut`, packet.subarray(0, packet.length - cut), swap));
      outcomes.add(await send(`${label}, one byte more`, Buffer.concat([packet, u8(0)]), swap));
    }
    expect([...outcomes].sort()).toEqual([INVALID_DATA, "ok"].sort());
  });

  it("refuses unknown variants and tags, bad booleans and Options", async () => {
    const postOnly = po(BID, 90n, 1n);
    const limit = lim(BID, 90n, 1n);
    const iocPacket = ioc(BID, { priceInTicks: 120n, numBaseLots: 1n });
    const edit = (b: Buffer, at: number, v: number) => {
      const c = Buffer.from(b);
      c[at] = v;
      return c;
    };
    const cases: [string, Buffer, boolean][] = [
      ["variant 3", edit(postOnly, 0, 3), false],
      ["side 2", edit(postOnly, 1, 2), false],
      ["PostOnly reject_post_only 2", edit(postOnly, 34, 2), false],
      ["PostOnly use_only_deposited_funds 2", edit(postOnly, 35, 2), false],
      ["PostOnly last_valid_slot tag 2", edit(postOnly, 36, 2), false],
      ["PostOnly fail_silently 2", edit(postOnly, 38, 2), false],
      ["Limit self_trade_behavior 3", edit(limit, 18, 3), false],
      ["Limit match_limit tag 2", edit(limit, 19, 2), false],
      ["IOC price tag 2", edit(iocPacket, 2, 2), true],
      ["IOC self_trade_behavior 3", edit(iocPacket, 43, 3), true],
      ["empty", Buffer.alloc(0), false],
      ["only a variant", u8(1), false],
    ];
    for (const [label, packet, swap] of cases) expect(await send(label, packet, swap), label).toBe(INVALID_DATA);
  });
});

describe("a big book (512/128): compute units", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await diff();
  });

  it("places, matches and evicts among hundreds of orders", async () => {
    const { m, a, b, c } = await book(d, { fee: 5 });
    // 440 bids and 440 asks from two makers, two orders a level.
    for (let i = 0; i < 220; i += 40) {
      const n = Math.min(40, 220 - i);
      for (const maker of [a, c]) {
        await placeMany(d, "big book: fill bids", m, maker, levels(ladder(5000n - BigInt(i), n, -1n), 2n), []);
        await placeMany(d, "big book: fill asks", m, maker, [], levels(ladder(6000n + BigInt(i), n, 1n), 2n));
      }
    }
    await place(d, "big book: PostOnly bid", m, a, po(BID, 5500n, 3n));
    await place(d, "big book: Limit bid", m, a, lim(BID, 5501n, 3n));
    await d.ok("big book: swap, 2 fills", b.key, [ix.swap(m, b, ioc(BID, { numBaseLots: 4n }))]);
    await d.ok("big book: swap, 30 fills", b.key, [ix.swap(m, b, ioc(ASK, { numBaseLots: 60n }))]);
    await placeMany(d, "big book: multiple orders, 5 to 4", m, c, levels([5600n, 5601n, 5601n, 5602n]), levels([5900n]));
    await placeMany(d, "big book: 32 asks", m, c, [], levels(ladder(5800n, 32, 1n)));
    await d.ok("big book: Limit ask through 20 fills, then rests", c.key, [ix.placeLimitOrder(m, c, lim(ASK, 4900n, 50n))]);
  });
});
