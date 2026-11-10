// showcase/mainnet/phoenix at the edges of what Phoenix v1 accepts, against the binary deployed on mainnet, with
// phoenix-helpers.ts's harness (every compared transaction: the same outcome, log lines, inner instructions, return data
// and account bytes):
//
// - markets InitializeMarket accepts although their parameters are degenerate: a tick size of 0 (every price is 0
//   quote lots, so the matching engine divides by zero) and a raw_base_units_per_base_unit of 0 (a base lot of 0 atoms,
//   by which the available balance divides);
// - a Clock whose unix_timestamp is negative (Phoenix reads it `as u64`);
import { type Instruction, type KeyPairSigner, address } from "@solana/kit";
import { Clock } from "litesvm";
import { afterAll, describe, expect, it } from "vitest";
import { send } from "../../test/harness.js";
import { OUT_OF_MEMORY, bothSides, cpiTx, forwarder, oomBoundary, pad, strangers, sync } from "./phoenix-cpi.js";
import {
  type CondensedOrder,
  Diff,
  type InitParams,
  type Market,
  PANICKED,
  SLOT,
  type Trader,
  builtin,
  cancelOrderParams,
  cancelUpToParams,
  checkCompute,
  cuTable,
  ix,
  meta,
  multipleOrderPacket,
  orderPacket,
  outcome,
  restingOrders,
  withData,
} from "./phoenix-helpers.js";

const BID = 0 as const;
const ASK = 1 as const;
const DECREMENT_TAKE = 2 as const;
const PLENTY = 10n ** 15n;
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
/** SetComputeUnitLimit(1.4M). */
const budget: Instruction = { programAddress: COMPUTE_BUDGET, accounts: [], data: new Uint8Array([2, 0xc0, 0x5c, 0x15, 0]) };
/** A panic or abort, and a BorshIoError, of a forwarded instruction (after cpiTx's two budget instructions). */
const PANICKED_2 = PANICKED.replace("index: 0", "index: 2");
const BORSH_2 = builtin("BorshIoError").replace("index: 0", "index: 2");

/** Every Diff of the file, for the CU table. */
const diffs: Diff[] = [];
async function diff(): Promise<Diff> {
  const d = await Diff.create();
  diffs.push(d);
  return d;
}
/** The transactions this file compares (every case, the setup ones included). */
const COMPARED = 162;
afterAll(() => {
  console.log(cuTable(diffs, "Phoenix v1 limits: compute units, original vs TypeSOL"));
  checkCompute(diffs, COMPARED);
});

/** An active 512/128 market with these parameters, and two seated traders holding plenty of both tokens. */
async function setup(label: string, params: InitParams) {
  const d = await diff();
  const m: Market = await d.market({ bids: 512, seats: 128, params, active: true, label: `${label}: InitializeMarket` });
  const a: Trader = await d.seated(m, PLENTY, PLENTY, `${label} a`);
  const b: Trader = await d.seated(m, PLENTY, PLENTY, `${label} b`);
  return { d, m, a, b };
}

describe("a tick size of 0", () => {
  it("panics dividing by the price when an order is filled in part", async () => {
    const { d, m, a, b } = await setup("tick 0", { tickSizeInQuoteLotsPerBaseUnit: 0n });
    await d.ok("tick 0: ask of 10 lots", a.key, [ix.placeLimitOrder(m, a, orderPacket({ kind: "PostOnly", side: ASK, priceInTicks: 100n, numBaseLots: 10n }))]);
    await d.fails(
      "tick 0: swap buys 3 of the 10 lots",
      b.key,
      [ix.swap(m, b, orderPacket({ kind: "ImmediateOrCancel", side: BID, numBaseLots: 3n }))],
      PANICKED,
    );
    // The whole order needs no division.
    await d.ok("tick 0: swap buys all 10 lots", b.key, [ix.swap(m, b, orderPacket({ kind: "ImmediateOrCancel", side: BID, numBaseLots: 10n }))]);
  });

  it("panics dividing by the price in a DecrementTake self trade", async () => {
    const { d, m, a } = await setup("tick 0 self", { tickSizeInQuoteLotsPerBaseUnit: 0n });
    await d.ok("tick 0 self: ask of 10 lots", a.key, [
      ix.placeLimitOrder(m, a, orderPacket({ kind: "PostOnly", side: ASK, priceInTicks: 100n, numBaseLots: 10n })),
    ]);
    await d.fails(
      "tick 0 self: DecrementTake swap",
      a.key,
      [ix.swap(m, a, orderPacket({ kind: "ImmediateOrCancel", side: BID, numBaseLots: 3n, selfTradeBehavior: DECREMENT_TAKE }))],
      PANICKED,
    );
  });
});

describe("a base lot of 0 atoms (raw_base_units_per_base_unit 0)", () => {
  it("panics dividing the base account's atoms by the lot size", async () => {
    const { d, m, a } = await setup("lot 0", { rawBaseUnitsPerBaseUnit: 0 });
    await d.fails(
      "lot 0: PlaceMultiplePostOnlyOrders",
      a.key,
      [ix.placeMultiplePostOnlyOrders(m, a, multipleOrderPacket([{ priceInTicks: 100n, sizeInBaseLots: 1n }], []))],
      PANICKED,
    );
    await d.fails(
      "lot 0: fail-silent PlaceLimitOrder",
      a.key,
      [ix.placeLimitOrder(m, a, orderPacket({ kind: "PostOnly", side: BID, priceInTicks: 100n, numBaseLots: 1n, failSilentlyOnInsufficientFunds: true }))],
      PANICKED,
    );
    // Free funds divide nothing.
    await d.ok("lot 0: PlaceMultiplePostOnlyOrdersWithFreeFunds of nothing", a.key, [
      ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, a, multipleOrderPacket([], [])),
    ]);
  });
});

describe("a negative unix_timestamp", () => {
  it("reads it as u64, as Phoenix's `as u64` does", async () => {
    const { d, m, a } = await setup("clock", {});
    for (const vm of d.vms) vm.setClock(new Clock(SLOT, -1000n, 580n, 581n, -5n));
    await d.ok("negative clock: PlaceLimitOrder", a.key, [
      ix.placeLimitOrder(m, a, orderPacket({ kind: "PostOnly", side: BID, priceInTicks: 100n, numBaseLots: 1n })),
    ]);
    // Every time in force is now in the past (u64::MAX - 4 is above any).
    await d.ok("negative clock: PlaceLimitOrder with a time in force", a.key, [
      ix.placeLimitOrder(m, a, orderPacket({ kind: "PostOnly", side: BID, priceInTicks: 99n, numBaseLots: 1n, lastValidUnixTimestampInSeconds: 2n ** 62n })),
    ]);
    await d.ok("negative clock: PlaceMultiplePostOnlyOrders", a.key, [
      ix.placeMultiplePostOnlyOrders(m, a, multipleOrderPacket([{ priceInTicks: 98n, sizeInBaseLots: 1n }], [])),
    ]);
  });
});

// ---- Through a CPI: more than a transaction carries -------------------------------------------------------------------

/** `n` CondensedOrders at `price`, `price - step`, … (one lot each). */
const ladder = (n: number, price: bigint, step = 1n): CondensedOrder[] =>
  Array.from({ length: n }, (_, i) => ({ priceInTicks: price - BigInt(i) * step, sizeInBaseLots: 1n }));
/** `n` orders at one price. */
const same = (n: number, price: bigint): CondensedOrder[] => ladder(n, price, 0n);
/** The orders in a scrambled order (the permutation i × 37 mod n; n is never a multiple of 37 here). */
const scrambled = (orders: CondensedOrder[]): CondensedOrder[] => orders.map((_, i) => orders[(i * 37) % orders.length]!);
/** `n` orders on `levels` prices from `price` (by `step`), scrambled. */
const spread = (n: number, levels: number, price: bigint, step: bigint): CondensedOrder[] =>
  scrambled(Array.from({ length: n }, (_, i) => ({ priceInTicks: price - BigInt(i % levels) * step, sizeInBaseLots: 1n })));

describe("more condensed orders than a transaction carries (through a CPI)", () => {
  it("decodes, sorts, merges and places them all", async () => {
    const { d, m, a } = await setup("cpi", {});
    const caller = await forwarder(d);
    await d.ok("cpi: deposit", a.key, [ix.depositFunds(m, a, 100_000_000n, 100_000n)]);
    const free = (bids: CondensedOrder[], asks: CondensedOrder[]) =>
      cpiTx(d, caller, ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, a, multipleOrderPacket(bids, asks)));
    const withTokens = (bids: CondensedOrder[], asks: CondensedOrder[]) =>
      cpiTx(d, caller, ix.placeMultiplePostOnlyOrders(m, a, multipleOrderPacket(bids, asks)));
    // 73 bids at one price (1,329 bytes of data): one merged order.
    await d.ok("cpi: 73 bids at one price, free funds", a.key, await free(same(73, 100n), []));
    await d.ok("cpi: 73 bids at one price, token accounts", a.key, await withTokens(same(73, 101n), []));
    // 100 bids and 100 asks on 5 levels each, scrambled (the merge sort's runs of all lengths).
    await d.ok("cpi: 100 bids and 100 asks on 5 levels each", a.key, await free(spread(100, 5, 90n, 1n), spread(100, 5, 200n, -1n)));
    // 63 orders resting: the most whose ids fit the return data's 1,024 bytes.
    await d.ok("cpi: 63 bids resting", a.key, await free(ladder(63, 80n), []));
  });

  it("fails in set_return_data from 64 resting orders, after placing them all", async () => {
    const { d, m, a } = await setup("ids", {});
    const caller = await forwarder(d);
    await d.ok("ids: deposit", a.key, [ix.depositFunds(m, a, 100_000_000n, 100_000n)]);
    for (const n of [64, 65, 100, 128, 150]) {
      await d.fails(
        `ids: ${n} bids resting`,
        a.key,
        await cpiTx(d, caller, ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, a, multipleOrderPacket(ladder(n, 1000n), []))),
        PANICKED_2,
      );
      expect(d.lastLogs).toContain(`Return data too large (${4 + 16 * n} > 1024)`);
    }
  });

  it("runs out of memory past 170 orders a side, and past 340 while decoding", async () => {
    const { d, m, a } = await setup("many", {});
    const caller = await forwarder(d);
    await d.ok("many: deposit", a.key, [ix.depositFunds(m, a, 100_000_000n, 100_000n)]);
    const free = (bids: CondensedOrder[], asks: CondensedOrder[]) =>
      cpiTx(d, caller, ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, a, multipleOrderPacket(bids, asks)));
    // 170 bids at one price: one order; 171: the sort's Vec does not fit.
    await d.ok("many: 170 bids at one price", a.key, await free(same(170, 100n), []));
    await d.fails("many: 171 bids at one price", a.key, await free(same(171, 100n), []), PANICKED_2);
    expect(d.lastLogs).toContain(OUT_OF_MEMORY);
    // The bids are placed before the 171 asks run out of memory.
    await d.fails("many: 10 bids, then 171 asks", a.key, await free(ladder(10, 90n), same(171, 200n)), PANICKED_2);
    expect(d.lastLogs).toContain(OUT_OF_MEMORY);
    // 341 bids: the decoded Vec's third growth (680 orders, 32,640 bytes).
    await d.fails("many: 341 bids", a.key, await free(same(341, 100n), []), PANICKED_2);
    expect(d.lastLogs).toContain(OUT_OF_MEMORY);
    // 120 bids decoded, then the asks' count cut short: BorshIoError.
    const full = Buffer.from(ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, a, multipleOrderPacket(same(120, 100n), [])).data!);
    const cut = withData(
      ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, a, Buffer.alloc(0)),
      Buffer.concat([full.subarray(0, 1 + 4 + 120 * 18), Buffer.from([1, 0])]),
    );
    await d.fails("many: 120 bids, then a cut count", a.key, await cpiTx(d, caller, cut), BORSH_2);
  });
});

// ---- Phoenix's heap ------------------------------------------------------------------------------------------------------

/** A 4096/128 market, a trader with `bids` resting bids (one lot each, at 5000 down) placed by the original, a payer. */
async function restingBids(label: string, bids: number) {
  const d = await diff();
  const setup = await d.funded(1000n);
  const m = await d.market({ bids: 4096, seats: 128, active: true, label: `${label}: InitializeMarket` });
  const t = await d.seated(m, PLENTY, PLENTY, label);
  await placeBids(d, setup, m, t, bids, 5000n);
  return { d, setup, m, t };
}

/**
 * `n` more bids for `t` (one lot each, from `price` down) and `asks` asks (from 10000 up), placed by the original
 * alone, then copied to the port.
 */
async function placeBids(d: Diff, setup: KeyPairSigner, m: Market, t: Trader, n: number, price: bigint, asks = 0): Promise<void> {
  for (let i = 0; i < Math.max(n, asks); i += 30) {
    const b = Math.max(0, Math.min(30, n - i));
    const a = Math.max(0, Math.min(30, asks - i));
    const packet = multipleOrderPacket(ladder(b, price - BigInt(i)), ladder(a, 10_000n + BigInt(i), -1n));
    const r = await send(d.original, setup, [budget, ix.placeMultiplePostOnlyOrders(m, t, packet)]);
    if (outcome(r) !== "ok") throw new Error(`placing orders failed:\n${meta(r).logs().join("\n")}`);
  }
  sync(d, m.market, m.baseVault, m.quoteVault, t.base, t.quote);
}

/** Padding lists 0..`max`, built once (each forwarded transaction writes its data account in both VMs). */
async function lists(max: number, make: (n: number) => Promise<Instruction[]> | Instruction[]): Promise<(n: number) => Instruction[]> {
  const all: Instruction[][] = [];
  for (let n = 0; n <= max; n++) all.push(await make(n));
  return (n) => all[n]!;
}

describe("Phoenix's heap: the cancels", () => {
  // Top-level transactions: 20 accounts of their own (more would not fit a transaction), then duplicates.
  for (const bids of [257, 300, 400, 512]) {
    it(`CancelAllOrdersWithFreeFunds of ${bids} orders runs out of memory where Phoenix does`, async () => {
      const { d, m, t } = await restingBids(`cancel all ${bids}`, bids);
      const pool = await strangers(20);
      const make = (n: number) => [budget, pad(ix.cancelAllOrdersWithFreeFunds(m, t), n, pool, 20)];
      expect(await bothSides(d, `cancel all ${bids}`, t.key, make, await oomBoundary(d, t.key, make, 20, 251))).toBe("ok");
    });
  }

  it("CancelAllOrders (to the token accounts) of 400 orders, and through a CPI", async () => {
    const { d, setup, m, t } = await restingBids("cancel all tokens", 400);
    const pool = await strangers(20);
    const make = (n: number) => [budget, pad(ix.cancelAllOrders(m, t), n, pool, 20)];
    expect(await bothSides(d, "cancel all tokens", t.key, make, await oomBoundary(d, t.key, make, 20, 246))).toBe("ok");
    // The same through the forwarder: Phoenix's entrypoint gets the account list the CPI passes on (at most 253).
    await placeBids(d, setup, m, t, 400, 5000n);
    const caller = await forwarder(d);
    const viaCaller = await lists(244, (n) => cpiTx(d, caller, pad(ix.cancelAllOrders(m, t), n, pool, 20)));
    expect(await bothSides(d, "cancel all tokens by CPI", t.key, viaCaller, await oomBoundary(d, t.key, viaCaller, 20, 244))).toBe("ok");
  });

  it("CancelAllOrders of bids and asks (two walks, two withdrawals), with more or fewer accounts of their own", async () => {
    const { d, setup, m, t } = await restingBids("cancel both", 0);
    const pool = await strangers(20);
    for (const own of [20, 12, 4]) {
      await placeBids(d, setup, m, t, 250, 5000n, 150);
      const make = (n: number) => [budget, pad(ix.cancelAllOrders(m, t), n, pool, Math.min(n, own))];
      expect(await bothSides(d, `cancel 250 bids and 150 asks, ${own} accounts of their own`, t.key, make, await oomBoundary(d, t.key, make, own, 246))).toBe(
        "ok",
      );
    }
  });

  it("CancelUpTo with a count and a search limit, and ForceCancelOrders", async () => {
    const { d, setup, m, t } = await restingBids("cancel up to", 450);
    const pool = await strangers(20);
    const upTo = (n: number) => [budget, pad(ix.cancelUpToWithFreeFunds(m, t, cancelUpToParams(0, null, null, 420)), n, pool, 20)];
    expect(await bothSides(d, "cancel up to 420 of 450", t.key, upTo, await oomBoundary(d, t.key, upTo, 20, 251))).toBe("ok");
    await placeBids(d, setup, m, t, 420, 5000n);
    const search = (n: number) => [budget, pad(ix.cancelUpTo(m, t, cancelUpToParams(0, null, 300)), n, pool, 20)];
    expect(await bothSides(d, "cancel up to, searching 300 of 450", t.key, search, await oomBoundary(d, t.key, search, 20, 246))).toBe("ok");
    await placeBids(d, setup, m, t, 300, 5000n);
    // The authority cancels a trader whose seat it no longer approves.
    await d.ok("ForceCancelOrders: seat NotApproved", m.authority, [ix.changeSeatStatus(m, t.seat, 0)]);
    const force = (n: number) => [budget, pad(ix.forceCancelOrders(m, t, cancelUpToParams(0)), n, pool, 20)];
    expect(await bothSides(d, "ForceCancelOrders of 450", m.authority, force, await oomBoundary(d, m.authority, force, 20, 244))).toBe("ok");
  });

  it("CancelMultipleOrdersById through a CPI: the decoded list and the ids it keeps", async () => {
    const { d, setup, m, t } = await restingBids("cancel by id", 200);
    const caller = await forwarder(d);
    const pool = await strangers(20);
    const resting = () => restingOrders(d.data(m.market), m, 0);
    // Every resting bid, and 30 entries whose side disagrees with their sequence number (dropped): 230, a decoded
    // Vec grown to 340.
    const first = resting();
    const params = [...first.map((o) => cancelOrderParams(0, o.price, o.seq)), ...first.slice(0, 30).map((o) => cancelOrderParams(1, o.price, o.seq))];
    const byId = await lists(244, (n) => cpiTx(d, caller, pad(ix.cancelMultipleOrdersById(m, t, params), n, pool, 20)));
    expect(await bothSides(d, "cancel 230 by id", t.key, byId, await oomBoundary(d, t.key, byId, 20, 244))).toBe("ok");
    // 341 entries: the decoded Vec grows to 680 (16,320 bytes) at the 341st, which never fits. 340 (free funds) fit
    // with a few accounts more.
    await placeBids(d, setup, m, t, 300, 5000n);
    const again = resting().map((o) => cancelOrderParams(0, o.price, o.seq));
    await d.fails("cancel 341 by id", t.key, await cpiTx(d, caller, ix.cancelMultipleOrdersById(m, t, [...again, ...again.slice(0, 41)])), PANICKED_2);
    expect(d.lastLogs).toContain(OUT_OF_MEMORY);
    const free = await lists(30, (n) =>
      cpiTx(d, caller, pad(ix.cancelMultipleOrdersByIdWithFreeFunds(m, t, [...again, ...again.slice(0, 40)]), n, pool, Math.min(n, 20))),
    );
    expect(await bothSides(d, "cancel 340 by id", t.key, free, await oomBoundary(d, t.key, free, 0, 30))).toBe("ok");
  });
});

describe("Phoenix's heap: many orders through a CPI", () => {
  it("runs out of memory where Phoenix does: decoding, sorting, the order ids and their bytes", async () => {
    const { d, m, a } = await setup("multi heap", {});
    const caller = await forwarder(d);
    await d.ok("multi heap: deposit", a.key, [ix.depositFunds(m, a, 10n ** 9n, 10n ** 6n)]);
    const pool = await strangers(20);
    let at = 0n;
    /** A packet's boundary over the padding, `from` padding entries up (each case at prices of its own: what rests stays). */
    async function edge(label: string, from: number, bids: (p: bigint) => CondensedOrder[], asks: (p: bigint) => CondensedOrder[]): Promise<string> {
      at += 1000n;
      const packet = multipleOrderPacket(bids(100_000n - at), asks(200_000n + at));
      const make = await lists(240, (n) => cpiTx(d, caller, pad(ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, a, packet), n, pool, 20)));
      return bothSides(d, `multi heap: ${label}`, a.key, make, await oomBoundary(d, a.key, make, from, 240));
    }
    // 130 bids on 130 levels, in order: the decoded Vec grown to 170, 130 ids (a Vec of 256) and their 2,084 bytes (a
    // Vec grown to 4,096), then set_return_data's refusal.
    expect(
      await edge(
        "130 levels in order",
        0,
        (p) => ladder(130, p),
        () => [],
      ),
    ).toBe(PANICKED_2);
    // Scrambled (runs of every length for the merge sort): 165 bids on 40 levels, 60 asks on 20.
    expect(
      await edge(
        "165 bids on 40 levels and 60 asks on 20, scrambled",
        20,
        (p) => spread(165, 40, p, 1n),
        (p) => spread(60, 20, p, -1n),
      ),
    ).toBe("ok");
    // Both sides past 85 (two decoded Vecs grown to 170) on 3 levels each.
    expect(
      await edge(
        "90 bids and 90 asks on 3 levels",
        0,
        (p) => spread(90, 3, p, 1n),
        (p) => spread(90, 3, p, -1n),
      ),
    ).toBe("ok");
  });

  it("PlaceMultiplePostOnlyOrders with token accounts: the deposits' transfers", async () => {
    const { d, m, a } = await setup("tokens heap", {});
    const caller = await forwarder(d);
    const pool = await strangers(20);
    const packet = multipleOrderPacket(spread(150, 30, 1000n, 1n), spread(40, 20, 2000n, -1n));
    const make = await lists(236, (n) => cpiTx(d, caller, pad(ix.placeMultiplePostOnlyOrders(m, a, packet), n, pool, 20)));
    expect(await bothSides(d, "tokens heap: 150 bids and 40 asks", a.key, make, await oomBoundary(d, a.key, make, 20, 236))).toBe("ok");
  });

  it("counts the Insufficient funds lines of the orders it skips", async () => {
    const { d, m, a } = await setup("skip heap", {});
    const caller = await forwarder(d);
    // Enough for ten bids only: the rest are skipped, a line each.
    await d.ok("skip heap: deposit", a.key, [ix.depositFunds(m, a, 1_000n, 0n)]);
    const pool = await strangers(20);
    const packet = multipleOrderPacket(ladder(80, 100n), ladder(20, 300n, -1n), null, 2);
    const make = await lists(240, (n) => cpiTx(d, caller, pad(ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, a, packet), n, pool, Math.min(n, 20))));
    expect(await bothSides(d, "skip heap: 80 bids and 20 asks, most skipped", a.key, make, await oomBoundary(d, a.key, make, 20, 240))).toBe("ok");
  });
});
