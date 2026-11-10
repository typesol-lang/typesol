// showcase/mainnet/phoenix against Phoenix v1 as deployed on mainnet (test/programs/phoenix_v1.so): a seeded random
// walk over an order book, on a 512/128 market and a 4096/8321 one. Seated makers (more seated, retired, evicted and
// approved again as it goes, so their places in the traders tree move) and unseated takers deposit and withdraw, place
// every kind of order (PostOnly rejected or amended, Limit with each self-trade behaviour and match limit, IOC and FOK
// with base or quote budgets and minimum fills, multiple PostOnly orders with each failure behaviour, all of them with
// tokens or on free funds, with and without time in force, fail-silent or not), reduce and cancel them (by id, with
// ids that are someone else's, unknown, on the wrong side or with the side bit flipped; up to a tick, a search and a
// count; all), and the authority changes seats, forces cancels, evicts, collects fees, changes the fee recipient and
// the market's status, while the Clock moves on (orders expire). Each book starts nearly full of orders far from the
// action (resting on free funds), so better orders evict the worst. Some steps send invalid packets (a bool, Option
// or enum tag out of range, 1–3 bytes cut). Every step is one transaction sent to both programs through `both()`
// (the same outcome, logs, inner instructions, return data and bytes in every account named), and after each step an
// oracle checks the market's books balance: every registered trader's locked and free lots, plus the fees not
// collected, add up to exactly what the vaults hold (in lots).
//
// The choices and every keypair come from the seed, so a run is reproduced by it. CI walks a fixed list of seeds
// (SEEDS); FUZZ_SEED=<seed> walks that one instead, PHOENIX_FUZZ_STEPS=<n> changes the length. With the fixed seeds and
// length the walk must also reach minimum counts of real effects (fills, partial fills, orders rested, self trades,
// expiries, evictions, fees: counted from the event batches) and a minimum share of successes for every kind of
// instruction; the thresholds are about half of what those seeds produce. The walk's transactions are not in the
// counts the other files give.
import { type Address, type Instruction, type KeyPairSigner, createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import {
  type CondensedOrder,
  Diff,
  OFF,
  type Result,
  SLOT,
  type Trader,
  UNIX_TIMESTAMP,
  asksAt,
  cancelOrderParams,
  cancelUpToParams,
  computeUnits,
  ix,
  key,
  meta,
  multipleOrderPacket,
  orderPacket,
  registeredTraders,
  restingOrders,
  setClock,
  traderEntry,
  TREE,
  u8,
  withData,
} from "./phoenix-helpers.js";

/** The seeds CI walks, each over both markets. */
const DEFAULT_SEEDS = [1n, 2n, 3n];
const SEEDS = process.env.FUZZ_SEED ? [BigInt(process.env.FUZZ_SEED)] : DEFAULT_SEEDS;
const DEFAULT_STEPS = 300;
const STEPS = Number(process.env.PHOENIX_FUZZ_STEPS ?? DEFAULT_STEPS);
/** The fixed seeds at the default length: the run the effect and success thresholds below are calibrated on. */
const CALIBRATED = !process.env.FUZZ_SEED && STEPS === DEFAULT_STEPS;
/** Walks this long (with any seed) are required to have every main kind of instruction succeed at least once. */
const EVERY_KIND_STEPS = 1000;

/** The most compute a transaction may use, after Phoenix's instruction (so its errors stay at index 0). */
const BUDGET = computeUnits(1_400_000);
const BID = 0 as const;
const ASK = 1 as const;
const RICH = 10n ** 15n;
/** The price the walk's orders gather around (the fillers rest far below and far above it). */
const MID = 1000;
/** A seat's approval status, in its bytes. */
const SEAT_STATUS_AT = 72;

/** PhoenixMarketEvent's variants after the Header: their tags and Borsh sizes (program/events.rs). */
const EVENT = { Fill: 2, Place: 3, Reduce: 4, Evict: 5, FillSummary: 6, Fee: 7, TimeInForce: 8, ExpiredOrder: 9 } as const;
const EVENT_SIZE: Record<number, number> = { 2: 66, 3: 42, 4: 34, 5: 58, 6: 42, 7: 10, 8: 26, 9: 58 };
/** The instructions that place orders (a Reduce event in one of them is a self trade). */
const ORDER_TAGS = new Set([0, 1, 2, 3, 16, 17]);

/**
 * The events of a transaction's Log self-CPIs. Each batch is the Log tag (15), the Header event (its tag 1 and 91
 * bytes, the instruction's tag first and the batch's event count last), then the events; the decoding must use the
 * whole batch and find the count the header gives.
 */
function marketEvents(r: Result): { instruction: number; kind: number; body: Buffer }[] {
  const out: { instruction: number; kind: number; body: Buffer }[] = [];
  for (const list of meta(r).innerInstructions())
    for (const i of list) {
      const data = Buffer.from(i.instruction().data());
      if (data.length < 93 || data[0] !== 15 || data[1] !== 1) continue;
      const total = data.readUInt16LE(91);
      let at = 93;
      let n = 0;
      while (at < data.length) {
        const kind = data[at]!;
        const size = EVENT_SIZE[kind];
        expect(size, `event tag ${kind}`).toBeDefined();
        out.push({ instruction: data[2]!, kind, body: data.subarray(at + 1, at + 1 + size!) });
        at += 1 + size!;
        n++;
      }
      expect([at, n], "an event batch decoded whole").toEqual([data.length, total]);
    }
  return out;
}

/**
 * The minimums the fixed seeds must reach together on each market (about half of what seeds 1–3 at 300 steps
 * produce): effects counted from the event batches of the walk's successful transactions, the walk's own notes, and
 * the share of each kind of instruction that succeeded.
 */
const MINIMUMS: Record<string, { effects: Record<string, number>; events: Record<string, number>; okShare: Record<string, number> }> = {
  "512/128": {
    effects: {
      fills: 130,
      "partial fills": 6,
      "orders rested": 650,
      "self trades": 60,
      "reductions and cancels": 450,
      "orders evicted": 180,
      "orders with a time in force": 20,
      "orders expired": 3,
      "takes that paid a fee": 12,
      "fee collections": 5,
    },
    events: { "posted on a full bid book": 12, "posted on a full ask book": 3, evicted: 5, "re-registered after an eviction": 3 },
    okShare: {
      deposit: 0.35,
      withdraw: 0.45,
      "post only": 0.25,
      limit: 0.3,
      swap: 0.25,
      "swap free": 0.25,
      multi: 0.25,
      reduce: 0.25,
      "cancel by id": 0.5,
      "cancel up to": 0.5,
      "cancel all": 0.5,
      "seat status": 0.45,
      "force cancel": 0.25,
      evict: 0.2,
      "collect fees": 0.4,
      "fee recipient": 0.5,
      "market status": 0.3,
      "invalid packet": 0.15,
    },
  },
  "4096/8321": {
    effects: {
      fills: 55,
      "partial fills": 15,
      "orders rested": 600,
      "self trades": 10,
      "reductions and cancels": 280,
      "orders evicted": 200,
      "orders with a time in force": 30,
      "orders expired": 4,
      "takes that paid a fee": 25,
      "fee collections": 6,
    },
    events: { "posted on a full bid book": 4, "posted on a full ask book": 12, evicted: 2, "re-registered after an eviction": 3 },
    okShare: {
      deposit: 0.4,
      withdraw: 0.5,
      "post only": 0.3,
      limit: 0.35,
      swap: 0.25,
      "swap free": 0.15,
      multi: 0.3,
      reduce: 0.25,
      "cancel by id": 0.5,
      "cancel up to": 0.5,
      "cancel all": 0.5,
      "seat status": 0.5,
      "force cancel": 0.2,
      evict: 0.05,
      "collect fees": 0.4,
      "fee recipient": 0.4,
      "market status": 0.3,
      "invalid packet": 0.15,
    },
  },
};
/** What the walks of each market did, summed over the seeds. */
const totals: Record<string, { runs: number; effects: Record<string, number>; events: Record<string, number>; stats: Record<string, Record<string, number>> }> =
  {};
const add = (into: Record<string, number>, from: Record<string, number>) => {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
};
afterAll(() => {
  if (!CALIBRATED) return;
  for (const [market, min] of Object.entries(MINIMUMS)) {
    const t = totals[market];
    expect(t?.runs, `${market}: walks finished`).toBe(SEEDS.length);
    const why = `${market}, seeds ${SEEDS.join(", ")}: ${JSON.stringify(t)}`;
    for (const [what, n] of Object.entries(min.effects)) expect(t!.effects[what] ?? 0, `${what}: ${why}`).toBeGreaterThanOrEqual(n);
    for (const [what, n] of Object.entries(min.events)) expect(t!.events[what] ?? 0, `${what}: ${why}`).toBeGreaterThanOrEqual(n);
    for (const [op, share] of Object.entries(min.okShare)) {
      const all = Object.values(t!.stats[op] ?? {}).reduce((a, b) => a + b, 0);
      expect(all, `${op} sent: ${why}`).toBeGreaterThan(0);
      expect((t!.stats[op]?.ok ?? 0) / all, `${op} succeeded: ${why}`).toBeGreaterThanOrEqual(share);
    }
  }
});

for (const SEED of SEEDS)
  for (const [bids, seats, fillers] of [
    [512, 128, 1],
    [4096, 8321, 8],
  ] as const) {
    describe(`a random walk over a ${bids}/${seats} order book (seed ${SEED})`, () => {
      it("trades, cancels and administers at random, the same in both", async () => {
        const rng = new Rng(SEED ^ BigInt(bids));
        // The keys from a stream of their own, so that making one more keypair does not shift the walk's choices.
        const keys = new Rng(SEED ^ BigInt(bids) ^ 0x6b657973n);
        const d = await Diff.create(async () => createKeyPairSignerFromPrivateKeyBytes(keys.bytes(32)));
        const tag = `${bids}/${seats} (seed ${SEED})`;
        const [tick, perUnit] = rng.pick([
          [1000n, 1000n],
          [1000n, 100n],
          [5000n, 1000n],
          [1000n, 10n],
        ] as const);
        const fee = rng.pick([0, 1, 5, 30]);
        const m = await d.market({
          bids,
          seats,
          params: { tickSizeInQuoteLotsPerBaseUnit: tick, baseLotsPerBaseUnit: perUnit, takerFeeBps: fee },
          active: true,
          label: `fuzz ${tag}: InitializeMarket`,
        });
        const authority = m.authority;

        // The fillers: orders of one lot each on free funds, bids from 10 ticks up and asks from 5000 up (each filler
        // under 512 orders), leaving about 60 places a side for the walk.
        const perFiller = Math.floor((bids - 60) / fillers);
        for (let f = 0; f < 2 * fillers; f++) {
          const side = f < fillers ? BID : ASK;
          const t = await d.seated(m, RICH, RICH, `fuzz ${tag}: filler ${f}`);
          await d.ok(`fuzz ${tag}: filler ${f} deposits`, t.key, [ix.depositFunds(m, t, 10n ** 9n, 10n ** 6n), BUDGET]);
          for (let i = 0; i < perFiller; i += 49) {
            const prices = Array.from({ length: Math.min(49, perFiller - i) }, (_, k) => BigInt((side === BID ? 10 : 5000) + i + k));
            const levels = prices.map((p): CondensedOrder => ({ priceInTicks: p, sizeInBaseLots: 1n }));
            await d.ok(`fuzz ${tag}: filler ${f} places`, t.key, [
              ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, t, side === BID ? multipleOrderPacket(levels, []) : multipleOrderPacket([], levels)),
              BUDGET,
            ]);
          }
        }

        // The walk's traders: seated makers (one of them poor) and unseated takers (one of them poor).
        const makers: Trader[] = [];
        for (let i = 0; i < 4; i++) makers.push(await d.seated(m, i === 3 ? 50n * 10n ** 6n : RICH, i === 3 ? 20_000n : RICH, `fuzz ${tag}: maker ${i}`));
        const takers = [await d.trader(m, RICH, RICH), await d.trader(m, 30n * 10n ** 6n, 30_000n)];
        // Fee recipients the walk may name, each with a quote token account.
        const recipients: { key: KeyPairSigner; quote: Address }[] = [{ key: authority, quote: await d.tokenAccount(m.quoteMint, authority.address) }];
        for (let i = 0; i < 2; i++) {
          const k = await d.funded(10n);
          recipients.push({ key: k, quote: await d.tokenAccount(m.quoteMint, k.address) });
        }

        const stats: Record<string, Record<string, number>> = {};
        const count = (op: string, o: string) => {
          const k = o === "ok" ? "ok" : (/code: (\d+)/.exec(o)?.[1] ?? /error: (\w+) \}$/.exec(o)?.[1] ?? "other");
          (stats[op] ??= {})[k] = (stats[op]![k] ?? 0) + 1;
        };
        const events: Record<string, number> = {};
        const note = (what: string) => (events[what] = (events[what] ?? 0) + 1);
        /** What the walk's transactions did, from their event batches. */
        const effects: Record<string, number> = {};
        const effect = (what: string) => (effects[what] = (effects[what] ?? 0) + 1);
        let step = -1;
        const run = async (op: string, what: string, signer: KeyPairSigner, i: Instruction) => {
          const got = await d.both(`fuzz ${tag} step ${step}: ${op}: ${what}`, signer, [i, BUDGET]);
          count(op, got);
          if (got === "ok")
            for (const e of marketEvents(d.last!)) {
              if (e.kind === EVENT.Fill) {
                effect("fills");
                if (e.body.readBigUInt64LE(58) > 0n) effect("partial fills");
              } else if (e.kind === EVENT.Place) effect("orders rested");
              else if (e.kind === EVENT.Reduce) effect(ORDER_TAGS.has(e.instruction) ? "self trades" : "reductions and cancels");
              else if (e.kind === EVENT.Evict) effect("orders evicted");
              else if (e.kind === EVENT.FillSummary && e.body.readBigUInt64LE(34) > 0n) effect("takes that paid a fee");
              else if (e.kind === EVENT.Fee && e.body.readBigUInt64LE(2) > 0n) effect("fee collections");
              else if (e.kind === EVENT.TimeInForce) effect("orders with a time in force");
              else if (e.kind === EVENT.ExpiredOrder) effect("orders expired");
            }
          return got;
        };

        // ---- What the walk reads ----------------------------------------------------------------------------------------
        const data = () => d.data(m.market);
        const entry = (t: Trader) => traderEntry(data(), m, t.key.address);
        const ordersOf = (t: Trader, side: 0 | 1) => {
          const e = entry(t);
          return e ? restingOrders(data(), m, side).filter((o) => o.trader === BigInt(e.index)) : [];
        };
        const bookSize = (side: 0 | 1) => Number(data().readBigUInt64LE((side === BID ? OFF.bids : asksAt(bids)) + TREE.size));
        const seatStatus = (t: Trader) => d.data(t.seat).readBigUInt64LE(SEAT_STATUS_AT);
        const status = () => Number(data().readBigUInt64LE(OFF.status));
        const feeRecipient = () =>
          recipients.find((r) =>
            data()
              .subarray(OFF.feeRecipient, OFF.feeRecipient + 32)
              .equals(key(r.key.address)),
          );
        /** The books balance: every registered trader's locked and free lots, plus the uncollected fees, are what the vaults hold. */
        const oracle = (when: string) => {
          const b = data();
          let base = 0n;
          let quote = b.readBigUInt64LE(OFF.unclaimedFees);
          for (const t of registeredTraders(b, m)) {
            base += t.baseLocked + t.baseFree;
            quote += t.quoteLocked + t.quoteFree;
          }
          const [baseLot, quoteLot] = [b.readBigUInt64LE(OFF.baseLotSize), b.readBigUInt64LE(OFF.quoteLotSize)];
          const [baseVault, quoteVault] = [d.amount(m.baseVault), d.amount(m.quoteVault)];
          const why = `${when}: vaults ${baseVault}/${quoteVault} atoms, lots ${baseLot}/${quoteLot}, traders and fees ${base}/${quote} lots`;
          expect(baseVault % baseLot, why).toBe(0n);
          expect(quoteVault % quoteLot, why).toBe(0n);
          expect(baseVault / baseLot, why).toBe(base);
          expect(quoteVault / quoteLot, why).toBe(quote);
        };
        oracle(`fuzz ${tag}: after the setup`);

        // ---- Random parts -------------------------------------------------------------------------------------------------
        const clock = { slot: SLOT, time: UNIX_TIMESTAMP };
        const side = () => rng.int(2) as 0 | 1;
        /** The side to place on: a full one more often, so that its worst orders get evicted. */
        const placeSide = (): 0 | 1 => {
          const full = ([BID, ASK] as const).filter((s) => bookSize(s) >= bids);
          return full.length > 0 && rng.chance(60) ? rng.pick(full) : side();
        };
        const price = (s: 0 | 1): bigint => {
          const r = rng.int(100);
          if (r < 2) return rng.pick([0n, 1n, 1n << 40n, 1n << 62n]);
          return BigInt(s === BID ? MID - 60 + rng.int(75) : MID - 15 + rng.int(75));
        };
        const lots = (): bigint => {
          const r = rng.int(100);
          if (r < 70) return BigInt(1 + rng.int(20));
          if (r < 90) return BigInt(1 + rng.int(200));
          if (r < 97) return BigInt(1 + rng.int(5000));
          return rng.pick([0n, 10n ** 9n, 1n << 40n]);
        };
        const slotLimit = () => (rng.chance(20) ? clock.slot + BigInt(rng.int(40)) - 4n : null);
        const timeLimit = () => (rng.chance(20) ? clock.time + BigInt(rng.int(30)) - 4n : null);
        const coid = () => (rng.chance(50) ? 0n : (rng.next() << 64n) | rng.next());
        const stb = () => rng.int(3) as 0 | 1 | 2;
        const matchLimit = () => (rng.chance(60) ? null : rng.chance(30) ? 0n : BigInt(1 + rng.int(6)));
        /** A maker: one whose seat is approved, mostly. */
        const maker = () => {
          const approved = makers.filter((t) => seatStatus(t) === 1n);
          return approved.length > 0 && rng.chance(85) ? rng.pick(approved) : rng.pick(makers);
        };
        /**
         * A maker to place orders, unless it has many resting: up to 360 on the small market (a cancel-all never
         * collects more than 512) and 150 on the large one, where a cancel-all walks its 8,000 orders for about 800,000
         * of the original's units and each order it cancels costs about 2,000 more (the costliest in the seeds tried took
         * 1,215,414), so that it stays under the 1,400,000 a transaction may use and running out never decides an outcome.
         */
        const placer = () => {
          const t = maker();
          return ordersOf(t, BID).length + ordersOf(t, ASK).length > (bids === 512 ? 360 : 150) ? undefined : t;
        };
        const anyone = () => (rng.chance(70) ? maker() : rng.pick(takers));
        const free = () => rng.chance(30);

        const postOnly = (s: 0 | 1, useFree: boolean) =>
          orderPacket({
            kind: "PostOnly",
            side: s,
            priceInTicks: price(s),
            numBaseLots: lots(),
            clientOrderId: coid(),
            rejectPostOnly: rng.chance(50),
            useOnlyDepositedFunds: useFree,
            lastValidSlot: slotLimit(),
            lastValidUnixTimestampInSeconds: timeLimit(),
            failSilentlyOnInsufficientFunds: rng.chance(20),
          });
        /**
         * The match limit of an order whose price reaches the fillers (none, or far from the action): 120 at most. It
         * could otherwise take thousands of their one-lot orders, past the units (or, for the cheaper port, the 64
         * instructions of the trace) a transaction may use: running out is not a comparison.
         */
        const reach = (limitPrice: bigint | null, ml: bigint | null) =>
          (limitPrice === null || limitPrice < BigInt(MID - 100) || limitPrice > BigInt(MID + 100)) && (ml === null || ml > 120n) ? 120n : ml;
        const limit = (s: 0 | 1, useFree: boolean) => {
          const limitPrice = price(s);
          return orderPacket({
            kind: "Limit",
            side: s,
            priceInTicks: limitPrice,
            numBaseLots: lots(),
            selfTradeBehavior: stb(),
            matchLimit: reach(limitPrice, matchLimit()),
            clientOrderId: coid(),
            useOnlyDepositedFunds: useFree,
            lastValidSlot: slotLimit(),
            lastValidUnixTimestampInSeconds: timeLimit(),
            failSilentlyOnInsufficientFunds: rng.chance(20),
          });
        };
        const ioc = (s: 0 | 1, useFree: boolean) => {
          const byQuote = rng.chance(30);
          const budget = byQuote ? BigInt(1 + rng.int(rng.chance(80) ? 20_000 : 2_000_000)) : BigInt(1 + rng.int(rng.chance(80) ? 30 : 150));
          const r = rng.int(100);
          const min = r < 65 ? 0n : r < 85 ? budget : BigInt(rng.int(Number(budget) + 2));
          const limitPrice = rng.chance(40) ? null : price(s === BID ? ASK : BID);
          const ml = reach(limitPrice, matchLimit());
          return orderPacket({
            kind: "ImmediateOrCancel",
            side: s,
            priceInTicks: limitPrice,
            numBaseLots: byQuote ? (rng.chance(3) ? 1n : 0n) : budget,
            numQuoteLots: byQuote ? budget : 0n,
            minBaseLotsToFill: byQuote ? (rng.chance(50) ? 0n : BigInt(rng.int(30))) : min,
            minQuoteLotsToFill: byQuote ? min : rng.chance(10) ? BigInt(rng.int(50_000)) : 0n,
            selfTradeBehavior: stb(),
            matchLimit: ml,
            clientOrderId: coid(),
            useOnlyDepositedFunds: useFree,
            lastValidSlot: slotLimit(),
            lastValidUnixTimestampInSeconds: timeLimit(),
          });
        };
        const condensed = (s: 0 | 1, n: number): CondensedOrder[] => {
          const out: CondensedOrder[] = [];
          for (let i = 0; i < n; i++) {
            const p = out.length > 0 && rng.chance(20) ? out[rng.int(out.length)]!.priceInTicks : price(s);
            out.push({ priceInTicks: p, sizeInBaseLots: lots() % 50n, lastValidSlot: slotLimit(), lastValidUnixTimestampInSeconds: timeLimit() });
          }
          return out;
        };
        const multi = () => multipleOrderPacket(condensed(BID, rng.int(6)), condensed(ASK, rng.int(6)), rng.chance(50) ? null : coid(), rng.int(4));
        /** An order for the cancels: one of `t`'s (mostly), someone else's, or none at all. */
        const target = (t: Trader) => {
          const s = side();
          const mine = ordersOf(t, s);
          const r = rng.int(100);
          if (r < 70 && mine.length > 0) return { o: rng.pick(mine), s };
          const all = restingOrders(data(), m, s);
          if (r < 85 && all.length > 0) return { o: rng.pick(all), s };
          return { o: { price: price(s), seq: rng.next(), lots: 1n, index: 0 }, s };
        };
        /** CancelOrderParams for the order, sometimes with the other side or its sequence number's side bit flipped. */
        const params = (o: { price: bigint; seq: bigint }, s: 0 | 1) => {
          const r = rng.int(100);
          if (r < 8) return cancelOrderParams(s === BID ? ASK : BID, o.price, o.seq);
          if (r < 14) return cancelOrderParams(s, o.price, o.seq ^ (1n << 63n));
          if (r < 18) return cancelOrderParams(s, o.price + 1n, o.seq);
          return cancelOrderParams(s, o.price, o.seq);
        };
        const upTo = () =>
          cancelUpToParams(side(), rng.chance(50) ? null : price(side()), rng.chance(60) ? null : rng.int(25), rng.chance(60) ? null : rng.int(12));
        /** A packet made invalid: a tag out of range or the end cut. */
        const corrupt = (p: Buffer, tags: [number, number][]) => {
          const c = Buffer.from(p);
          if (rng.chance(40)) return c.subarray(0, c.length - 1 - rng.int(3));
          const [at, v] = rng.pick(tags);
          c[at] = v;
          return c;
        };

        /** ChangeMarketStatus: back to Active (Closed through PostOnly) to restore it; else any status, a tombstone now and then. */
        const marketStatus = async (restore: boolean) => {
          const now = status();
          const to = restore || (now !== 1 && rng.chance(70)) ? (now === 4 ? 2 : 1) : rng.chance(8) ? 5 : rng.int(5);
          await run("market status", `${now} → ${to}`, authority, ix.changeMarketStatus(m, to));
        };

        // ---- The walk -----------------------------------------------------------------------------------------------------
        const before = d.compared;
        const fullBefore = { [BID]: 0, [ASK]: 0 };
        const ops: [number, string, () => Promise<unknown>][] = [
          [
            6,
            "deposit",
            async () => {
              const t = maker();
              await run("deposit", t.key.address, t.key, ix.depositFunds(m, t, rng.chance(20) ? 0n : lots() * 1000n, rng.chance(20) ? 0n : lots()));
            },
          ],
          [
            5,
            "withdraw",
            async () => {
              const t = maker();
              const amount = () => (rng.chance(50) ? null : rng.chance(20) ? 0n : lots() * 100n);
              await run("withdraw", t.key.address, t.key, ix.withdrawFunds(m, t, amount(), amount()));
            },
          ],
          [
            13,
            "post only",
            async () => {
              const t = placer();
              if (!t) return;
              const useFree = free();
              const s = placeSide();
              const full = bookSize(s) >= bids;
              const got = await run(
                "post only",
                `${t.key.address} free ${useFree}`,
                t.key,
                useFree ? ix.placeLimitOrderWithFreeFunds(m, t, postOnly(s, true)) : ix.placeLimitOrder(m, t, postOnly(s, false)),
              );
              if (full && got === "ok") note(`posted on a full ${s === BID ? "bid" : "ask"} book`);
            },
          ],
          [
            11,
            "limit",
            async () => {
              const t = placer();
              if (!t) return;
              const useFree = free();
              const s = placeSide();
              const full = bookSize(s) >= bids;
              const got = await run(
                "limit",
                `${t.key.address} free ${useFree}`,
                t.key,
                useFree ? ix.placeLimitOrderWithFreeFunds(m, t, limit(s, true)) : ix.placeLimitOrder(m, t, limit(s, false)),
              );
              if (full && got === "ok") note(`posted on a full ${s === BID ? "bid" : "ask"} book`);
            },
          ],
          [
            11,
            "swap",
            async () => {
              const t = anyone();
              await run("swap", t.key.address, t.key, ix.swap(m, t, ioc(side(), false)));
            },
          ],
          [
            4,
            "swap free",
            async () => {
              const t = maker();
              await run("swap free", t.key.address, t.key, ix.swapWithFreeFunds(m, t, ioc(side(), true)));
            },
          ],
          [
            6,
            "multi",
            async () => {
              const t = placer();
              if (!t) return;
              const useFree = free();
              await run(
                "multi",
                `${t.key.address} free ${useFree}`,
                t.key,
                useFree ? ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, t, multi()) : ix.placeMultiplePostOnlyOrders(m, t, multi()),
              );
            },
          ],
          [
            5,
            "bulk",
            async () => {
              // A ladder of 20–40 orders a side.
              const t = placer();
              if (!t) return;
              const s = placeSide();
              const n = 20 + rng.int(21);
              const start = s === BID ? MID - 70 + rng.int(40) : MID - 10 + rng.int(40);
              const step = 1 + rng.int(3);
              const levels = Array.from({ length: n }, (_, i): CondensedOrder => ({
                priceInTicks: BigInt(s === BID ? start - i * step : start + i * step),
                sizeInBaseLots: BigInt(1 + rng.int(5)),
              }));
              const packet = multipleOrderPacket(s === BID ? levels : [], s === BID ? [] : levels, null, rng.pick([0, 2, 2, 3]));
              const full = bookSize(s) >= bids;
              const got = await run("multi", `${t.key.address} ladder of ${n}`, t.key, ix.placeMultiplePostOnlyOrders(m, t, packet));
              if (full && got === "ok") note(`posted on a full ${s === BID ? "bid" : "ask"} book`);
            },
          ],
          [
            6,
            "reduce",
            async () => {
              const t = maker();
              const { o, s } = target(t);
              const r = rng.int(100);
              const size = r < 10 ? 0n : r < 50 ? 1n + BigInt(rng.int(Number(o.lots))) : r < 80 ? o.lots : o.lots + BigInt(1 + rng.int(100));
              const p = params(o, s);
              await run(
                "reduce",
                `${t.key.address} ${o.price}/${o.seq} by ${size}`,
                t.key,
                rng.chance(50) ? ix.reduceOrderWithFreeFunds(m, t, p, size) : ix.reduceOrder(m, t, p, size),
              );
            },
          ],
          [
            5,
            "cancel by id",
            async () => {
              const t = maker();
              const list = Array.from({ length: rng.int(9) }, () => {
                const { o, s } = target(t);
                return params(o, s);
              });
              await run(
                "cancel by id",
                `${t.key.address} ${list.length}`,
                t.key,
                rng.chance(50) ? ix.cancelMultipleOrdersByIdWithFreeFunds(m, t, list) : ix.cancelMultipleOrdersById(m, t, list),
              );
            },
          ],
          [
            4,
            "cancel up to",
            async () => {
              const t = maker();
              await run("cancel up to", t.key.address, t.key, rng.chance(50) ? ix.cancelUpToWithFreeFunds(m, t, upTo()) : ix.cancelUpTo(m, t, upTo()));
            },
          ],
          [
            2,
            "cancel all",
            async () => {
              const t = maker();
              await run("cancel all", t.key.address, t.key, rng.chance(50) ? ix.cancelAllOrdersWithFreeFunds(m, t) : ix.cancelAllOrders(m, t));
            },
          ],
          [
            3,
            "seat status",
            async () => {
              // An evicted trader whose seat may be approved again comes back half the time (registered anew, at another
              // place in the traders tree); otherwise NotApproved and back mostly, Retired (for good) now and then.
              const evicted = makers.filter((x) => entry(x) === undefined && seatStatus(x) === 0n);
              const back = evicted.length > 0 && rng.chance(50);
              const t = back ? rng.pick(evicted) : rng.pick(makers);
              const r = rng.int(100);
              const to = back ? 1 : r < 5 ? 2 : r < 45 ? 0 : 1;
              const registered = entry(t) !== undefined;
              const got = await run("seat status", `${t.key.address} ${seatStatus(t)} → ${to}`, authority, ix.changeSeatStatus(m, t.seat, to));
              if (got === "ok" && to === 1 && !registered && entry(t) !== undefined) note("re-registered after an eviction");
            },
          ],
          [
            3,
            "force cancel",
            async () => {
              const t = maker();
              await run("force cancel", t.key.address, authority, ix.forceCancelOrders(m, t, upTo()));
            },
          ],
          [
            3,
            "evict",
            async () => {
              // A trader not approved, mostly; its orders forced off first, sometimes.
              const off = makers.filter((t) => seatStatus(t) !== 1n);
              const t = off.length > 0 && rng.chance(85) ? rng.pick(off) : maker();
              if (seatStatus(t) !== 1n && rng.chance(60)) {
                await run("force cancel", `${t.key.address} bids`, authority, ix.forceCancelOrders(m, t, cancelUpToParams(BID)));
                await run("force cancel", `${t.key.address} asks`, authority, ix.forceCancelOrders(m, t, cancelUpToParams(ASK)));
              }
              const got = await run("evict", t.key.address, authority, ix.evictSeat(m, t));
              if (got === "ok") note("evicted");
            },
          ],
          [
            1,
            "request seat",
            async () => {
              // A new maker (while there is room), approved mostly.
              if (makers.length >= 10) return;
              const t = await d.trader(m, RICH, RICH);
              if ((await run("request seat", t.key.address, t.key, ix.requestSeat(m, t))) !== "ok") return;
              makers.push(t);
              if (rng.chance(80)) await run("seat status", `${t.key.address} new → 1`, authority, ix.changeSeatStatus(m, t.seat, 1));
            },
          ],
          [
            2,
            "collect fees",
            async () => {
              const to = rng.chance(85) ? (feeRecipient() ?? recipients[0]!) : rng.pick(recipients);
              const sweeper = rng.chance(50) ? authority : anyone().key;
              await run("collect fees", to.key.address, sweeper, ix.collectFees(m, sweeper, to.quote));
            },
          ],
          [
            1,
            "fee recipient",
            async () => {
              const next = rng.pick(recipients);
              const current = feeRecipient();
              const r = rng.int(100);
              const signer = r < 60 ? current?.key : r < 75 ? rng.pick(recipients).key : undefined;
              await run("fee recipient", `${next.key.address} signed by ${signer?.address}`, authority, ix.changeFeeRecipient(m, next.key.address, signer));
            },
          ],
          [3, "market status", () => marketStatus(false)],
          [
            3,
            "clock",
            async () => {
              clock.slot += BigInt(1 + rng.int(30));
              clock.time += BigInt(rng.int(20));
              setClock(d, clock.slot, clock.time);
              count("clock", "ok");
            },
          ],
          [
            3,
            "invalid packet",
            async () => {
              // PostOnly: variant 0, side 1, reject_post_only 34, use_only_deposited_funds 35, slot tag 36 (no times).
              // Limit: self_trade_behavior 18, match_limit tag 19. IOC: price tag 2, self_trade_behavior 43 (a price).
              // Multiple: the behaviour (last byte), an Option tag of the first bid.
              const t = maker();
              const r = rng.int(4);
              const base = { side: side(), priceInTicks: price(BID), numBaseLots: 1n + BigInt(rng.int(5)) };
              if (r === 0) {
                const p = orderPacket({ kind: "PostOnly", ...base });
                const bad = corrupt(p, [
                  [0, 3],
                  [1, 2],
                  [34, 2],
                  [35, 2],
                  [36, 2],
                  [p.length - 1, 2],
                ]);
                await run("invalid packet", "PostOnly", t.key, withData(ix.placeLimitOrder(m, t, p), Buffer.concat([u8(2), bad])));
              } else if (r === 1) {
                const p = orderPacket({ kind: "Limit", ...base, selfTradeBehavior: stb() });
                const bad = corrupt(p, [
                  [18, 3],
                  [19, 2],
                  [1, 2],
                  [0, 4],
                ]);
                await run("invalid packet", "Limit", t.key, withData(ix.placeLimitOrder(m, t, p), Buffer.concat([u8(2), bad])));
              } else if (r === 2) {
                const p = orderPacket({ kind: "ImmediateOrCancel", ...base, priceInTicks: price(ASK) });
                const bad = corrupt(p, [
                  [2, 2],
                  [43, 3],
                  [1, 2],
                  [0, 3],
                ]);
                await run("invalid packet", "IOC", t.key, withData(ix.swap(m, t, p), Buffer.concat([u8(0), bad])));
              } else {
                const p = multipleOrderPacket([{ priceInTicks: price(BID), sizeInBaseLots: 1n }], [], null, rng.int(4));
                const bad = corrupt(p, [
                  [p.length - 1, 4],
                  [4 + 16, 2],
                  [4 + 17, 2],
                  [p.length - 2, 2],
                ]);
                await run("invalid packet", "multiple", t.key, withData(ix.placeMultiplePostOnlyOrders(m, t, p), Buffer.concat([u8(16), bad])));
              }
            },
          ],
        ];
        const total = ops.reduce((n, [w]) => n + w, 0);
        for (step = 0; step < STEPS; step++) {
          let r = rng.int(total);
          // A market that does not take orders is set back before long (about 10 steps).
          const op = status() !== 1 && rng.chance(10) ? ([0, "market status", () => marketStatus(true)] as const) : ops.find(([w]) => (r -= w) < 0)!;
          await op[2]();
          for (const s of [BID, ASK] as const) if (bookSize(s) >= bids) fullBefore[s]++;
          oracle(`fuzz ${tag} step ${step}: after ${op[1]}`);
        }

        // At the end: no order of no lots rests (a filled, reduced or cancelled order leaves the tree).
        for (const s of [BID, ASK] as const)
          for (const o of restingOrders(data(), m, s)) expect(o.lots, `${tag}: order ${o.price}/${o.seq}`).toBeGreaterThan(0n);
        const walked = d.compared - before;
        const heavy = Object.entries(d.cu)
          .filter(([l]) => l.includes(" step "))
          .sort(([, [a]], [, [b]]) => Number(b - a))
          .slice(0, 5)
          .map(([l, [a, b]]) => `${a} / ${b}: ${l.replace(/^fuzz \S+ /, "")}`);
        console.log(
          `phoenix fuzz ${tag}: ${STEPS} steps, ${walked} transactions, tick ${tick}, ${perUnit} lots a unit, fee ${fee}; ` +
            `books ${bookSize(BID)}/${bookSize(ASK)}, ${registeredTraders(data(), m).length} traders, steps with a full book ${fullBefore[BID]}/${fullBefore[ASK]}; ` +
            `${JSON.stringify(events)}\neffects ${JSON.stringify(effects)}\nmost compute (original / TypeSOL):\n  ${heavy.join("\n  ")}`,
        );
        console.log(JSON.stringify(stats));
        const sum = (totals[`${bids}/${seats}`] ??= { runs: 0, effects: {}, events: {}, stats: {} });
        sum.runs++;
        add(sum.effects, effects);
        add(sum.events, events);
        for (const [op, outcomes] of Object.entries(stats)) add((sum.stats[op] ??= {}), outcomes);
        // Every walk, whatever its seed, moves the books: orders rest, fill and are cancelled.
        for (const what of ["orders rested", "fills", "reductions and cancels"]) expect(effects[what] ?? 0, `${what} (${tag})`).toBeGreaterThan(0);
        // A walk whose steps all failed would compare little: every main kind of instruction got through at least once
        // (in a walk of EVERY_KIND_STEPS or more), each book filled up and took orders that evicted others, an evicted
        // trader came back, and the walk compared at least about one transaction a step.
        if (STEPS >= EVERY_KIND_STEPS) {
          for (const op of [
            "deposit",
            "withdraw",
            "post only",
            "limit",
            "swap",
            "swap free",
            "multi",
            "reduce",
            "cancel by id",
            "cancel up to",
            "cancel all",
            "seat status",
            "force cancel",
            "evict",
            "collect fees",
            "fee recipient",
            "market status",
          ])
            expect(stats[op]?.ok ?? 0, `no ${op} succeeded (${tag}): ${JSON.stringify(stats)}`).toBeGreaterThan(0);
          for (const what of ["posted on a full bid book", "posted on a full ask book", "evicted", "re-registered after an eviction"])
            expect(events[what] ?? 0, `never ${what} (${tag}): ${JSON.stringify(events)}`).toBeGreaterThan(0);
        }
        expect(walked, `transactions compared `).toBeGreaterThanOrEqual(Math.floor(STEPS * 0.9));
      }, 3_600_000);
    });
  }
