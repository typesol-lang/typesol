// showcase/mainnet/phoenix against Phoenix v1 as deployed on mainnet (test/programs/phoenix_v1.so): the scenarios of
// the original's own tests (Ellipsis-Labs/phoenix-v1 c16694d: tests/test_phoenix.rs, the matching engine's unit tests
// in src/state/markets/test_market.rs and the packet decoder's in src/state/order_schema/order_packet.rs) that the
// other files do not already run, each sent to both programs through `both()` (the same outcome, logs, inner
// instructions, return data and bytes in every account named), with the outcome the original's test expects. The
// mapping of every upstream test to a case here or elsewhere is in phoenix-upstream.md, next to this file.
//
// Adaptations:
// - Upstream's program-test bootstrap (a 4096/8193 market, 100,000 quote lots per quote unit, 1,000 base lots per
//   base unit, a tick of 1,000 quote lots, 9 and 6 decimals, made Active by its creator, a maker seated by the
//   authority and an unseated taker) is made the same way here; the SDK's float prices are given in ticks (×100 for
//   that market) and its base units in lots (×1,000).
// - The unit tests call the FIFOMarket directly (no seats, no tokens, a clock function). Here they run on a real
//   market with the unit tests' tick and base lot sizes (1,000,000 quote lots per quote unit): each `place_order` is
//   a PlaceLimitOrder (or Swap / the WithFreeFunds form, as the packet asks), each trader that places a limit order
//   holds an approved seat and tokens, `claim_all_funds` is WithdrawFunds, `collect_fees` CollectFees, and the clock
//   function is the Clock both VMs run with (`setClock`).
// - `warp_to_slot` (upstream's way to send an identical transaction twice) needs nothing: the harness expires the
//   blockhash after every transaction.
import { getTransferSolInstruction } from "@solana-program/system";
import { type Address, type Instruction, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import {
  type CondensedOrder,
  Diff,
  type Market,
  OFF,
  PROGRAM,
  SLOT,
  type Trader,
  TREE,
  U64_MAX,
  UNIX_TIMESTAMP,
  asksAt,
  cancelOrderParams,
  cancelUpToParams,
  computeUnits,
  cuTable,
  initParams,
  ix,
  key,
  marketSize,
  multipleOrderPacket,
  orderPacket,
  registeredTraders,
  restingOrders,
  seatAddress,
  setClock,
  tradersAt,
  truncate,
  u8,
  vaultAddress,
  withData,
} from "./phoenix-helpers.js";

const BID = 0 as const;
const ASK = 1 as const;
const ABORT = 0 as const;
const CANCEL_PROVIDE = 1 as const;
const DECREMENT_TAKE = 2 as const;
/** FailedMultipleLimitOrderBehavior. */
const FAIL_FUNDS_FAIL_CROSS = 1;
const SKIP_FUNDS_AMEND_CROSS = 2;
const SKIP_FUNDS_FAIL_CROSS = 3;
/** Enough tokens of each mint for the unit tests' traders. */
const PLENTY = 10n ** 16n;
const BUDGET = computeUnits(1_400_000);

const diffs: Diff[] = [];
async function diff(): Promise<Diff> {
  const d = await Diff.create();
  diffs.push(d);
  return d;
}
afterAll(() => {
  console.log(cuTable(diffs, "Phoenix v1 upstream scenarios: compute units, original vs TypeSOL"));
});

/** both(), which must fail (upstream asserts `is_err` only). */
async function rejects(d: Diff, label: string, payer: KeyPairSigner, ixs: Instruction[]): Promise<void> {
  const got = await d.both(label, payer, ixs);
  expect(got, `${label}: must fail\n${d.lastLogs}`).not.toBe("ok");
}

// ---- Packets (OrderPacket's constructors) --------------------------------------------------------------------------------

/** new_limit_order_default: CancelProvide, no match limit. */
const limit = (
  side: 0 | 1,
  price: bigint,
  lots: bigint,
  o: { stb?: 0 | 1 | 2; matchLimit?: bigint | null; coid?: bigint; free?: boolean; silent?: boolean } = {},
) =>
  orderPacket({
    kind: "Limit",
    side,
    priceInTicks: price,
    numBaseLots: lots,
    selfTradeBehavior: o.stb ?? CANCEL_PROVIDE,
    matchLimit: o.matchLimit ?? null,
    clientOrderId: o.coid ?? 0n,
    useOnlyDepositedFunds: o.free ?? false,
    failSilentlyOnInsufficientFunds: o.silent ?? false,
  });
/** new_post_only (reject_post_only true by default). */
const postOnly = (
  side: 0 | 1,
  price: bigint,
  lots: bigint,
  o: { reject?: boolean; free?: boolean; coid?: bigint; slot?: bigint | null; time?: bigint | null; silent?: boolean } = {},
) =>
  orderPacket({
    kind: "PostOnly",
    side,
    priceInTicks: price,
    numBaseLots: lots,
    clientOrderId: o.coid ?? 0n,
    rejectPostOnly: o.reject ?? true,
    useOnlyDepositedFunds: o.free ?? false,
    lastValidSlot: o.slot ?? null,
    lastValidUnixTimestampInSeconds: o.time ?? null,
    failSilentlyOnInsufficientFunds: o.silent ?? false,
  });
/** new_ioc. */
const ioc = (
  side: 0 | 1,
  o: {
    price?: bigint | null;
    base?: bigint;
    quote?: bigint;
    minBase?: bigint;
    minQuote?: bigint;
    stb?: 0 | 1 | 2;
    matchLimit?: bigint | null;
    coid?: bigint;
    free?: boolean;
    slot?: bigint | null;
    time?: bigint | null;
  },
) =>
  orderPacket({
    kind: "ImmediateOrCancel",
    side,
    priceInTicks: o.price ?? null,
    numBaseLots: o.base ?? 0n,
    numQuoteLots: o.quote ?? 0n,
    minBaseLotsToFill: o.minBase ?? 0n,
    minQuoteLotsToFill: o.minQuote ?? 0n,
    selfTradeBehavior: o.stb ?? CANCEL_PROVIDE,
    matchLimit: o.matchLimit ?? null,
    clientOrderId: o.coid ?? 0n,
    useOnlyDepositedFunds: o.free ?? false,
    lastValidSlot: o.slot ?? null,
    lastValidUnixTimestampInSeconds: o.time ?? null,
  });
/** new_ioc_by_lots / new_ioc_sell_with_limit_price: a price limit and a base lot budget. */
const iocLots = (side: 0 | 1, price: bigint, lots: bigint, stb: 0 | 1 | 2 = ABORT, o: { free?: boolean; coid?: bigint } = {}) =>
  ioc(side, { price, base: lots, stb, ...o });
/** new_fok_{buy,sell}_with_limit_price: the minimum fill is the whole budget. */
const fok = (side: 0 | 1, price: bigint, lots: bigint, o: { free?: boolean; coid?: bigint } = {}) =>
  ioc(side, { price, base: lots, minBase: lots, stb: ABORT, ...o });
/** CondensedOrder::new_default. */
const level = (priceInTicks: bigint, sizeInBaseLots: bigint): CondensedOrder => ({ priceInTicks, sizeInBaseLots });

// ---- Markets ---------------------------------------------------------------------------------------------------------------

/** test_phoenix.rs's bootstrap: the market, its authority (the admin, also the fee recipient) and the default traders. */
interface Boot {
  m: Market;
  admin: KeyPairSigner;
  /** The admin's quote token account (where CollectFees sends). */
  adminQuote: Address;
  /** Seated by the authority (RequestSeatAuthorized, ChangeSeatStatus). */
  maker: Trader;
  /** Not seated. */
  taker: Trader;
}
/** setup_account's tokens: `base` base units (×10⁹ atoms, whatever the decimals) and `quote` quote units (×10⁶). */
const units = (base: bigint, quote: bigint) => [base * 10n ** 9n, quote * 10n ** 6n] as const;

async function bootstrap(
  d: Diff,
  name: string,
  o: {
    fee?: number;
    quoteLotsPerQuoteUnit?: bigint;
    baseLotsPerBaseUnit?: bigint;
    tick?: bigint;
    baseDecimals?: number;
    raw?: number;
    makerTokens?: readonly [bigint, bigint];
  } = {},
): Promise<Boot> {
  const m = await d.newMarket({ bids: 4096, seats: 8193, baseDecimals: o.baseDecimals ?? 9, quoteDecimals: 6 });
  const admin = m.authority;
  const params = initParams(
    {
      bids: 4096,
      seats: 8193,
      quoteLotsPerQuoteUnit: o.quoteLotsPerQuoteUnit ?? 100_000n,
      baseLotsPerBaseUnit: o.baseLotsPerBaseUnit ?? 1000n,
      tickSizeInQuoteLotsPerBaseUnit: o.tick ?? 1000n,
      takerFeeBps: o.fee ?? 0,
      rawBaseUnitsPerBaseUnit: o.raw ?? null,
    },
    admin.address,
  );
  await d.ok(`${name}: InitializeMarket, ChangeMarketStatus Active`, admin, [ix.initializeMarket(m, params), ix.changeMarketStatus(m, 1)]);
  const adminQuote = await d.tokenAccount(m.quoteMint, admin.address);
  const maker = await d.trader(m, ...(o.makerTokens ?? units(1_000_000n, 1_000_000n)));
  await d.ok(`${name}: maker RequestSeatAuthorized`, admin, [ix.requestSeatAuthorized(m, admin, maker.key.address, maker.seat)]);
  await d.ok(`${name}: maker ChangeSeatStatus Approved`, admin, [ix.changeSeatStatus(m, maker.seat, 1)]);
  const taker = await d.trader(m, ...units(1_000_000n, 1_000_000n));
  return { m, admin, adminQuote, maker, taker };
}

/** get_new_maker: tokens, 5,000 lamports sent to the seat with RequestSeatAuthorized, then approved. */
async function newMaker(d: Diff, b: Boot, name: string, base: bigint, quote: bigint): Promise<Trader> {
  const t = await d.trader(b.m, ...units(base, quote));
  await d.ok(`${name}: new maker, seat funded and RequestSeatAuthorized`, b.admin, [
    getTransferSolInstruction({ source: b.admin, destination: t.seat, amount: 5000n }),
    ix.requestSeatAuthorized(b.m, b.admin, t.key.address, t.seat),
  ]);
  await d.ok(`${name}: new maker ChangeSeatStatus Approved`, b.admin, [ix.changeSeatStatus(b.m, t.seat, 1)]);
  return t;
}

/** layer_orders: Limit orders (CancelProvide) from `start` to `end`, `step` ticks apart, growing by `sizeStep` lots, 12 a transaction. */
async function layer(d: Diff, label: string, m: Market, t: Trader, start: bigint, end: bigint, step: bigint, size: bigint, sizeStep: bigint, side: 0 | 1) {
  const ixs: Instruction[] = [];
  for (let p = start, s = size; side === BID ? p >= end && p > 0n : p <= end; p += side === BID ? -step : step, s += sizeStep)
    ixs.push(ix.placeLimitOrder(m, t, limit(side, p, s)));
  for (let i = 0; i < ixs.length; i += 12) await d.ok(`${label} (${i / 12 + 1})`, t.key, ixs.slice(i, i + 12));
  return ixs.length;
}

/** A market for the matching engine's unit tests (4096/8193, as their Dex): its admin and two seated traders. */
interface UnitMarket {
  m: Market;
  admin: KeyPairSigner;
  trader: Trader;
  taker: Trader;
}
async function unitMarket(d: Diff, name: string, tick = 10_000n, baseLotsPerBaseUnit = 100n, fee = 0): Promise<UnitMarket> {
  const m = await d.market({
    bids: 4096,
    seats: 8193,
    params: { quoteLotsPerQuoteUnit: 1_000_000n, tickSizeInQuoteLotsPerBaseUnit: tick, baseLotsPerBaseUnit, takerFeeBps: fee },
    active: true,
    label: `${name}: InitializeMarket`,
  });
  return {
    m,
    admin: m.authority,
    trader: await d.seated(m, PLENTY, PLENTY, `${name}: trader`),
    taker: await d.seated(m, PLENTY, PLENTY, `${name}: taker`),
  };
}

/** PlaceLimitOrder (or its free-funds form for a packet on deposited funds), which must succeed. */
const place = (d: Diff, label: string, m: Market, t: Trader, packet: Buffer, free = false) =>
  d.ok(label, t.key, [free ? ix.placeLimitOrderWithFreeFunds(m, t, packet) : ix.placeLimitOrder(m, t, packet)]);
/** Swap (or SwapWithFreeFunds), which must succeed. */
const swap = (d: Diff, label: string, m: Market, t: Trader, packet: Buffer, free = false) =>
  d.ok(label, t.key, [free ? ix.swapWithFreeFunds(m, t, packet) : ix.swap(m, t, packet)]);

/** The market's order sequence number (FIFOMarket::get_sequence_number). */
const sequenceNumber = (d: Diff, m: Market) => d.data(m.market).readBigUInt64LE(OFF.orderSequenceNumber);
/** A bid's stored sequence number (`!seq`). */
const not = (n: bigint) => U64_MAX ^ n;

/** get_typed_ladder: the best `n` levels of each side, their sizes summed. */
function ladder(d: Diff, m: Market, n: number) {
  const data = d.data(m.market);
  const levels = (side: 0 | 1) => {
    const out: { price: bigint; size: bigint }[] = [];
    for (const o of restingOrders(data, m, side)) {
      const last = out[out.length - 1];
      if (last && last.price === o.price) last.size += o.lots;
      else if (out.length < n) out.push({ price: o.price, size: o.lots });
      else break;
    }
    return out;
  };
  return { bids: levels(BID), asks: levels(ASK) };
}

/** The sizes of the market's three trees. */
const treeSizes = (d: Diff, m: Market) => {
  const b = d.data(m.market);
  return [OFF.bids, asksAt(m.bids), tradersAt(m.bids)].map((at) => b.readBigUInt64LE(at + TREE.size));
};

// ---- tests/test_phoenix.rs ---------------------------------------------------------------------------------------------------

describe("test_phoenix.rs", () => {
  it("test_phoenix_request_seats", async () => {
    const d = await diff();
    const b = await bootstrap(d, "request seats");
    const { m, admin } = b;
    const maker = await d.trader(m);
    const attacker = await d.funded(20n);
    // The attacker's own 512/128 market on the same mints.
    const own = (await generateKeyPairSigner()).address;
    d.write(own, PROGRAM, Buffer.alloc(marketSize(512, 128)));
    const ownMarket: Market = {
      market: own,
      authority: attacker,
      baseMint: m.baseMint,
      quoteMint: m.quoteMint,
      baseVault: await vaultAddress(own, m.baseMint),
      quoteVault: await vaultAddress(own, m.quoteMint),
      bids: 512,
      seats: 128,
    };
    await d.ok("request seats: the attacker's market", attacker, [
      ix.initializeMarket(
        ownMarket,
        initParams(
          { bids: 512, seats: 128, quoteLotsPerQuoteUnit: 1_000_000n, baseLotsPerBaseUnit: 1000n, tickSizeInQuoteLotsPerBaseUnit: 1000n },
          attacker.address,
        ),
      ),
    ]);
    const attackerSeat = await seatAddress(m.market, attacker.address);
    await d.ok("request seats: the attacker's RequestSeat", attacker, [
      ix.requestSeat(m, { key: attacker, seat: attackerSeat, base: m.baseVault, quote: m.quoteVault }),
    ]);
    await rejects(d, "request seats: the attacker approves its seat through its own market", attacker, [
      ix.changeSeatStatus(ownMarket, attackerSeat, 1, attacker),
    ]);
    await d.ok("request seats: maker RequestSeat", maker.key, [ix.requestSeat(m, maker)]);
    await rejects(d, "request seats: the maker approves its own seat", maker.key, [ix.changeSeatStatus(m, maker.seat, 1, maker.key)]);
    await d.ok("request seats: approve the maker", admin, [ix.changeSeatStatus(m, maker.seat, 1)]);
    await d.ok("request seats: retire the maker", admin, [ix.changeSeatStatus(m, maker.seat, 2)]);
    await rejects(d, "request seats: the maker cannot be unretired", admin, [ix.changeSeatStatus(m, maker.seat, 1)]);
    const maker1 = await d.trader(m, ...units(1_000_000n, 1_000_000n));
    await d.ok("request seats: maker1 RequestSeatAuthorized", admin, [ix.requestSeatAuthorized(m, admin, maker1.key.address, maker1.seat)]);
    await d.ok("request seats: approve maker1", admin, [ix.changeSeatStatus(m, maker1.seat, 1)]);
    await place(d, "request seats: maker1 bids at 100", m, maker1, limit(BID, 10_000n, 1n));
    await d.ok("request seats: retire maker1", admin, [ix.changeSeatStatus(m, maker1.seat, 2)]);
    await rejects(d, "request seats: evict maker1 with an open order", admin, [ix.evictSeat(m, maker1)]);
    await d.ok("request seats: ForceCancelOrders on both sides", admin, [
      ix.forceCancelOrders(m, maker1, cancelUpToParams(BID)),
      ix.forceCancelOrders(m, maker1, cancelUpToParams(ASK)),
    ]);
    await d.ok("request seats: evict maker1", admin, [ix.evictSeat(m, maker1)]);
  });

  it("test_phoenix_orders", async () => {
    const d = await diff();
    const { m, admin, maker } = await bootstrap(d, "orders");
    const orders = [limit(BID, 10_000n, 1n), limit(BID, 9_900n, 1n), limit(ASK, 10_100n, 1n), limit(ASK, 10_200n, 1n)].map((p) =>
      ix.placeLimitOrder(m, maker, p),
    );
    await rejects(d, "orders: a bid at 0 ticks", admin, [ix.placeLimitOrder(m, maker, limit(BID, 0n, 1n))]);
    await d.ok("orders: a bid at 1 tick", admin, [ix.placeLimitOrder(m, maker, limit(BID, 1n, 1n))]);
    await d.ok("orders: cancel the first bid by id", admin, [ix.cancelMultipleOrdersById(m, maker, [cancelOrderParams(BID, 1n, not(1n))])]);
    await d.ok("orders: four orders in one transaction", admin, orders);
    const seq = sequenceNumber(d, m);
    const asks = [cancelOrderParams(ASK, 10_200n, seq - 1n), cancelOrderParams(ASK, 10_100n, seq - 2n)];
    await d.ok("orders: cancel both asks by id", admin, [ix.cancelMultipleOrdersById(m, maker, asks)]);
    expect(sequenceNumber(d, m)).toBe(seq);
    await d.ok("orders: cancel them again", admin, [ix.cancelMultipleOrdersById(m, maker, asks)]);
    await d.ok("orders: a cancelled ask, an unknown ask, the bid at 99", admin, [
      ix.cancelMultipleOrdersById(m, maker, [
        cancelOrderParams(ASK, 10_200n, seq - 1n),
        cancelOrderParams(ASK, 10_800n, seq - 2n),
        cancelOrderParams(BID, 9_900n, not(seq - 3n)),
      ]),
    ]);
  });

  it("test_phoenix_admin", async () => {
    const d = await diff();
    const { m, admin, adminQuote, maker, taker } = await bootstrap(d, "admin", { fee: 5 });
    await d.ok(
      "admin: maker's four orders",
      maker.key,
      [limit(BID, 10_000n, 1n), limit(BID, 9_900n, 1n), limit(ASK, 10_100n, 1n), limit(ASK, 10_200n, 1n)].map((p) => ix.placeLimitOrder(m, maker, p)),
    );
    const successor = await d.funded(10n);
    await rejects(d, "admin: NameSuccessor by a non-admin", successor, [ix.nameSuccessor(m, successor.address, successor)]);
    await d.ok("admin: NameSuccessor by the admin", admin, [ix.nameSuccessor(m, successor.address)]);
    const attacker = await d.funded(10n);
    await rejects(d, "admin: ClaimAuthority by an attacker", attacker, [ix.claimAuthority(m, attacker)]);
    await d.ok("admin: ClaimAuthority by the successor", successor, [ix.claimAuthority(m, successor)]);
    const buy = ix.swap(m, taker, iocLots(BID, 10_200n, 1n, DECREMENT_TAKE));
    await d.ok("admin: trade while Active", admin, [buy]);
    await rejects(d, "admin: close an Active market", successor, [ix.changeMarketStatus(m, 4, undefined, successor)]);
    await rejects(d, "admin: the previous admin pauses", admin, [ix.changeMarketStatus(m, 3)]);
    await d.ok("admin: the admin pauses", successor, [ix.changeMarketStatus(m, 3, undefined, successor)]);
    await d.ok("admin: cancel a bid while Paused", maker.key, [ix.cancelUpTo(m, maker, cancelUpToParams(BID, null, null, 1))]);
    await d.ok("admin: reactivate", successor, [ix.changeMarketStatus(m, 1, undefined, successor)]);
    await d.ok("admin: pause again", successor, [ix.changeMarketStatus(m, 3, undefined, successor)]);
    await rejects(d, "admin: trade while Paused", taker.key, [buy]);
    await d.ok("admin: close the Paused market", successor, [ix.changeMarketStatus(m, 4, undefined, successor)]);
    await rejects(d, "admin: tombstone a market with orders", successor, [ix.changeMarketStatus(m, 5, undefined, successor)]);
    await d.ok("admin: cancel both sides while Closed", maker.key, [
      ix.cancelUpTo(m, maker, cancelUpToParams(BID)),
      ix.cancelUpTo(m, maker, cancelUpToParams(ASK)),
    ]);
    await rejects(d, "admin: evict a seat still approved", successor, [ix.evictSeat(m, maker, successor)]);
    await d.ok("admin: seat NotApproved", successor, [ix.changeSeatStatus(m, maker.seat, 0, successor)]);
    await d.ok("admin: evict the seat", successor, [ix.evictSeat(m, maker, successor)]);
    await rejects(d, "admin: tombstone with uncollected fees", successor, [ix.changeMarketStatus(m, 5, undefined, successor)]);
    await d.ok("admin: collect the fees", admin, [ix.collectFees(m, admin, adminQuote)]);
    await d.ok("admin: tombstone", successor, [ix.changeMarketStatus(m, 5, undefined, successor)]);
  });

  it("test_phoenix_basic", async () => {
    const d = await diff();
    const { m, maker, taker } = await bootstrap(d, "basic");
    await layer(d, "basic: layer bids", m, maker, 4000n, 3600n, 5n, 1000n, 500n, BID);
    await layer(d, "basic: layer asks", m, maker, 4001n, 4550n, 5n, 1200n, 300n, ASK);
    await swap(d, "basic: IOC sell 10 units down to 39.70", m, taker, iocLots(ASK, 3970n, 10_000n));
    await d.ok("basic: maker withdraws", maker.key, [ix.withdrawFunds(m, maker)]);
    await d.ok("basic: CancelUpTo every bid", maker.key, [ix.cancelUpTo(m, maker, cancelUpToParams(BID))]);
    await d.ok("basic: deposit a lot of each", maker.key, [ix.depositFunds(m, maker, 1n, 1n)]);
    await d.ok("basic: withdraw a lot of each", maker.key, [ix.withdrawFunds(m, maker, 1n, 1n)]);
  });

  it("test_phoenix_fees", async () => {
    const d = await diff();
    const { m, admin, maker, taker } = await bootstrap(d, "fees", { fee: 5 });
    await place(d, "fees: maker bids 1000 lots at 100", m, maker, limit(BID, 10_000n, 1000n));
    await swap(d, "fees: taker sells into it", m, taker, iocLots(ASK, 10_000n, 1000n));
    const next = await d.trader(m);
    await rejects(d, "fees: ChangeFeeRecipient without the current recipient", admin, [ix.changeFeeRecipient(m, next.key.address)]);
    await d.ok("fees: ChangeFeeRecipient, the current recipient signing", admin, [ix.changeFeeRecipient(m, next.key.address, admin)]);
    await d.ok("fees: CollectFees to the new recipient", admin, [ix.collectFees(m, admin, next.quote)]);
    expect(d.amount(next.quote)).toBe(50_000n);
    await d.ok("fees: ChangeFeeRecipient with nothing uncollected", admin, [ix.changeFeeRecipient(m, (await generateKeyPairSigner()).address)]);
  });

  it("test_phoenix_cancel_with_free_funds", async () => {
    const d = await diff();
    const { m, maker } = await bootstrap(d, "cancel free");
    await d.ok("cancel free: deposit 10000 quote units and 100 base units", maker.key, [ix.depositFunds(m, maker, 10_000n * 100_000n, 100_000n)]);
    const order = ix.placeLimitOrderWithFreeFunds(m, maker, limit(BID, 100n, 10n, { stb: DECREMENT_TAKE, free: true }));
    await d.ok("cancel free: a bid on free funds", maker.key, [order]);
    await d.ok("cancel free: CancelAllOrdersWithFreeFunds", maker.key, [ix.cancelAllOrdersWithFreeFunds(m, maker)]);
    await d.ok("cancel free: two bids, the second cancelled by id", maker.key, [
      order,
      order,
      ix.cancelMultipleOrdersByIdWithFreeFunds(m, maker, [cancelOrderParams(BID, 100n, not(2n))]),
    ]);
    await d.ok("cancel free: a bid, then CancelUpToWithFreeFunds", maker.key, [order, ix.cancelUpToWithFreeFunds(m, maker, cancelUpToParams(BID))]);
    expect(restingOrders(d.data(m.market), m, BID)).toEqual([]);
  });

  it("test_phoenix_orders_with_free_funds", async () => {
    const d = await diff();
    const b = await bootstrap(d, "free funds");
    const { m, maker, taker } = b;
    const second = await newMaker(d, b, "free funds", 1_000_000n, 1_000_000n);
    await layer(d, "free funds: layer bids", m, maker, 4000n, 3000n, 100n, 1000n, 1000n, BID);
    await layer(d, "free funds: layer asks", m, maker, 5000n, 6000n, 100n, 1000n, 1000n, ASK);
    await rejects(d, "free funds: SwapWithFreeFunds by an unseated taker", taker.key, [
      ix.swapWithFreeFunds(m, taker, iocLots(ASK, 3100n, 55_000n, ABORT, { free: true })),
    ]);
    await swap(d, "free funds: taker sells through 10 levels", m, taker, iocLots(ASK, 3100n, 55_000n));
    await swap(d, "free funds: taker buys through 10 levels", m, taker, iocLots(BID, 5900n, 55_000n));
    await swap(d, "free funds: maker self-trades the last bid", m, maker, iocLots(ASK, 3000n, 11_000n, DECREMENT_TAKE));
    await swap(d, "free funds: maker self-trades the last ask", m, maker, iocLots(BID, 6000n, 11_000n, DECREMENT_TAKE));
    await rejects(d, "free funds: second maker's free-funds order with no free funds", second.key, [
      ix.placeLimitOrderWithFreeFunds(m, second, postOnly(BID, 10_000n, 10_000n)),
    ]);
    await place(d, "free funds: second maker bids at 30", m, second, limit(BID, 3000n, 10_000n));
    await place(d, "free funds: second maker asks at 34.1", m, second, limit(ASK, 3410n, 10_000n));
    await swap(d, "free funds: maker buys on free funds", m, maker, iocLots(BID, 3410n, 10_000n, CANCEL_PROVIDE, { free: true }), true);
    await swap(d, "free funds: maker sells on free funds", m, maker, iocLots(ASK, 3000n, 10_000n, CANCEL_PROVIDE, { free: true }), true);
    await place(d, "free funds: maker bids with all its free quote and a unit more", m, maker, limit(BID, 3369n, 101_000n));
    await place(d, "free funds: maker asks with all its free base and a unit more", m, maker, limit(ASK, 5000n, 67_000n));
    await rejects(d, "free funds: second maker's SwapWithFreeFunds, short", second.key, [
      ix.swapWithFreeFunds(m, second, iocLots(BID, 25_000n, 10_000n, CANCEL_PROVIDE, { free: true })),
    ]);
    const freeBid = limit(BID, 3410n, 10_000n, { free: true });
    const freeAsk = limit(ASK, 3500n, 10_000n, { free: true });
    await place(d, "free funds: second maker bids on free funds", m, second, freeBid, true);
    await place(d, "free funds: second maker asks on free funds", m, second, freeAsk, true);
    await place(d, "free funds: second maker bids with tokens", m, second, limit(BID, 3410n, 10_000n));
    await place(d, "free funds: second maker asks with tokens", m, second, limit(ASK, 3500n, 10_000n));
    await d.ok("free funds: second maker cancels all on free funds", second.key, [ix.cancelAllOrdersWithFreeFunds(m, second)]);
    const half = [limit(BID, 3410n, 5000n, { free: true }), limit(ASK, 3500n, 5000n, { free: true })];
    for (const [i, p] of half.entries())
      await rejects(d, `free funds: a free-funds packet through PlaceLimitOrder (${i})`, second.key, [ix.placeLimitOrder(m, second, p)]);
    for (const [i, p] of half.entries()) await place(d, `free funds: a free-funds packet through its instruction (${i})`, m, second, p, true);
    const tokens = [limit(BID, 3410n, 5000n), limit(ASK, 3500n, 5000n)];
    for (const [i, p] of tokens.entries())
      await rejects(d, `free funds: a token packet through PlaceLimitOrderWithFreeFunds (${i})`, second.key, [ix.placeLimitOrderWithFreeFunds(m, second, p)]);
  });

  it("test_phoenix_place_multiple_limit_orders", async () => {
    const d = await diff();
    const b = await bootstrap(d, "multiple");
    const { m, maker } = b;
    const second = await newMaker(d, b, "multiple", 1_000_000n, 1_000_000n);
    const many = (bids: CondensedOrder[], asks: CondensedOrder[], free = false) =>
      free
        ? ix.placeMultiplePostOnlyOrdersWithFreeFunds(m, maker, multipleOrderPacket(bids, asks, null, 1))
        : ix.placeMultiplePostOnlyOrders(m, maker, multipleOrderPacket(bids, asks, null, 1));
    const first = many([level(800n, 10_000n), level(900n, 10_000n)], [level(1000n, 10_000n), level(1100n, 10_000n)]);
    await rejects(d, "multiple: five accounts only", maker.key, [truncate(first, 5)]);
    await d.ok("multiple: two bids and two asks", maker.key, [first]);
    await d.ok("multiple: cancel all on free funds", maker.key, [ix.cancelAllOrdersWithFreeFunds(m, maker)]);
    await rejects(d, "multiple: free funds, base short", maker.key, [
      many([level(800n, 9000n), level(1100n, 10_000n)], [level(1000n, 10_000n), level(1100n, 10_000n), level(1200n, 4000n)], true),
    ]);
    await rejects(d, "multiple: free funds, quote short", maker.key, [
      many([level(800n, 10_000n), level(900n, 10_000n), level(300n, 1000n)], [level(1000n, 10_000n), level(1100n, 10_000n)], true),
    ]);
    await d.ok("multiple: on free funds", maker.key, [
      many([level(800n, 10_000n), level(900n, 10_000n)], [level(1700n, 10_000n), level(1700n, 5000n), level(1200n, 5000n)], true),
    ]);
    await d.ok("multiple: cancel all on free funds again", maker.key, [ix.cancelAllOrdersWithFreeFunds(m, maker)]);
    await rejects(d, "multiple: crossing itself", maker.key, [
      many([level(800n, 10_000n), level(900n, 10_000n)], [level(900n, 10_000n), level(1100n, 10_000n)]),
    ]);
    await rejects(d, "multiple: crossing itself, another way", maker.key, [
      many([level(2900n, 1000n), level(900n, 10_000n), level(1900n, 10_000n)], [level(3000n, 10_000n), level(2500n, 10_000n)]),
    ]);
    await place(d, "multiple: second maker bids at 10", m, second, limit(BID, 1000n, 10_000n));
    await place(d, "multiple: second maker asks at 20", m, second, limit(ASK, 2000n, 10_000n));
    await rejects(d, "multiple: an ask crossing the book", maker.key, [
      many([level(800n, 10_000n), level(900n, 10_000n)], [level(1000n, 10_000n), level(1100n, 10_000n)]),
    ]);
    await rejects(d, "multiple: a bid crossing the book", maker.key, [many([level(2000n, 10_000n), level(900n, 10_000n)], [])]);
    await d.ok("multiple: free funds first, then tokens", maker.key, [
      many(
        [level(500n, 10_000n), level(400n, 10_000n), level(300n, 10_000n), level(500n, 10_000n), level(400n, 10_000n)],
        [level(10_000n, 5000n), level(10_500n, 5000n), level(10_000n, 5000n), level(10_300n, 5000n), level(10_200n, 5000n)],
      ),
    ]);
    await d.ok("multiple: maker cancels all", maker.key, [ix.cancelAllOrdersWithFreeFunds(m, maker)]);
    await d.ok("multiple: second maker cancels all", second.key, [ix.cancelAllOrdersWithFreeFunds(m, second)]);
    const bids = Array.from({ length: 21 }, (_, i) => level(10_000n - 10n * BigInt(i + 1), 10_000n));
    const asks = Array.from({ length: 21 }, (_, i) => level(10_000n + 10n * BigInt(i + 1), 10_000n));
    expect(multipleOrderPacket(bids, asks, null, 1).length).toBe(766);
    await d.ok("multiple: 21 orders a side", maker.key, [BUDGET, many(bids, asks)]);
  });

  it("test_phoenix_place_multiple_memory_management", async () => {
    const d = await diff();
    const { m, maker, taker } = await bootstrap(d, "multiple memory");
    const bids = Array.from({ length: 21 }, (_, i) => level(10_000n - 10n * BigInt(i + 1), 1000n));
    const asks = Array.from({ length: 21 }, (_, i) => level(10_000n + 10n * BigInt(i + 1), 1000n));
    await d.ok("multiple memory: 21 orders a side", maker.key, [BUDGET, ix.placeMultiplePostOnlyOrders(m, maker, multipleOrderPacket(bids, asks, null, 1))]);
    await d.ok("multiple memory: sell u64::MAX lots at any price", taker.key, [BUDGET, ix.swap(m, taker, iocLots(ASK, 0n, U64_MAX, DECREMENT_TAKE))]);
  });

  it("test_phoenix_place_multiple_limit_orders_adversarial", async () => {
    const d = await diff();
    const { m, maker, taker } = await bootstrap(d, "adversarial");
    // 30 one-lot orders a side at one price a transaction: coalesced into one order each.
    const sameLevel = (price: bigint) => Array.from({ length: 30 }, () => level(price, 1n));
    for (let start = 0, size = 30; size <= 4096; start++, size += 30)
      await d.ok(`adversarial: stuff the book (${start + 1})`, maker.key, [
        ix.placeMultiplePostOnlyOrders(m, maker, multipleOrderPacket(sameLevel(9_900n), sameLevel(10_000n), null, 1)),
        getTransferSolInstruction({ source: maker.key, destination: maker.key.address, amount: BigInt(start) }),
      ]);
    await d.ok("adversarial: buy 700 lots", taker.key, [BUDGET, ix.swap(m, taker, iocLots(BID, 10_100n, 700n))]);
  });

  it("test_phoenix_basic_with_raw_base_unit_adjustment", async () => {
    const d = await diff();
    // A raw base unit worth less than a quote atom: 1,000 raw units a base unit, 5 decimals. The maker gets more tokens.
    const [base, quote] = units(1_000_000n, 1_000_000n);
    const { m, maker, taker } = await bootstrap(d, "raw units", {
      quoteLotsPerQuoteUnit: 1_000_000n,
      baseLotsPerBaseUnit: 10n,
      tick: 10n,
      baseDecimals: 5,
      raw: 1000,
      makerTokens: [base + 10n ** 18n, quote + 10n ** 15n],
    });
    // 0.000001358 / 0.000001359 and 0.000001361 / 0.000001362 a raw unit: 135 and 136 ticks (rounded down), 10 lots.
    await d.ok(
      "raw units: two bids and two asks",
      maker.key,
      [
        limit(BID, 135n, 10n, { stb: ABORT }),
        limit(ASK, 136n, 10n, { stb: ABORT }),
        limit(BID, 135n, 10n, { stb: ABORT }),
        limit(ASK, 136n, 10n, { stb: ABORT }),
      ].map((p) => ix.placeLimitOrder(m, maker, p)),
    );
    await swap(d, "raw units: taker sells through both bids", m, taker, iocLots(ASK, 135n, 20n, ABORT, { coid: 19_082_332n }));
    await d.ok("raw units: maker withdraws", maker.key, [ix.withdrawFunds(m, maker)]);
  });

  it("test_phoenix_place_order_quiet_failure", async () => {
    const d = await diff();
    const b = await bootstrap(d, "quiet");
    const { m } = b;
    const maker = await newMaker(d, b, "quiet", 100n, 1000n);
    const silent = (side: 0 | 1, price: bigint, lots: bigint, free = false, fail = true) => limit(side, price, lots, { stb: ABORT, free, silent: fail });
    await d.ok("quiet: deposit 3 of each", maker.key, [ix.depositFunds(m, maker, 300_000n, 3000n)]);
    await place(d, "quiet: ask 97 units, fail-silent", m, maker, silent(ASK, 1000n, 97_000n));
    expect(d.amount(maker.base)).toBe(3_000_000_000n);
    await place(d, "quiet: ask 1 unit, fail-silent", m, maker, silent(ASK, 1000n, 1000n));
    await d.ok("quiet: deposit a unit, ask it on free funds", maker.key, [
      ix.depositFunds(m, maker, 0n, 1000n),
      ix.placeLimitOrderWithFreeFunds(m, maker, silent(ASK, 1000n, 1000n, true)),
    ]);
    expect(restingOrders(d.data(m.market), m, ASK).length).toBe(3);
    await place(d, "quiet: ask 2 units, fails silently", m, maker, silent(ASK, 1000n, 2000n));
    await rejects(d, "quiet: ask 2 units, fails", maker.key, [ix.placeLimitOrder(m, maker, silent(ASK, 1000n, 2000n, false, false))]);
    expect(restingOrders(d.data(m.market), m, ASK).length).toBe(3);
    await d.ok("quiet: cancel all", maker.key, [ix.cancelAllOrders(m, maker)]);
    await place(d, "quiet: bid 99.7 units at 10, fail-silent", m, maker, silent(BID, 1000n, 99_700n));
    expect(d.amount(maker.quote)).toBe(3_000_000n);
    await place(d, "quiet: bid 1 unit at 1, fail-silent", m, maker, silent(BID, 100n, 1000n));
    await d.ok("quiet: deposit a quote unit, bid it on free funds", maker.key, [
      ix.depositFunds(m, maker, 100_000n, 0n),
      ix.placeLimitOrderWithFreeFunds(m, maker, silent(BID, 100n, 1000n, true)),
    ]);
    expect(restingOrders(d.data(m.market), m, BID).length).toBe(3);
    await place(d, "quiet: bid 2 units at 10, fails silently", m, maker, silent(BID, 1000n, 2000n));
    await rejects(d, "quiet: bid 2 units at 10, fails", maker.key, [ix.placeLimitOrder(m, maker, silent(BID, 1000n, 2000n, false, false))]);
    expect(restingOrders(d.data(m.market), m, BID).length).toBe(3);
    await d.ok("quiet: cancel all again", maker.key, [ix.cancelAllOrders(m, maker)]);
  });

  it("test_phoenix_multiple_orders_fail_silently_basic", async () => {
    const d = await diff();
    const b = await bootstrap(d, "fail silently");
    const { m } = b;
    const maker = await newMaker(d, b, "fail silently", 99n, 901n);
    await d.ok("fail silently: deposit 312 quote units and 39 base units", maker.key, [ix.depositFunds(m, maker, 31_200_000n, 39_000n)]);
    const bids = Array.from({ length: 10 }, (_, i) => level(1000n - BigInt(i), 10_000n));
    const asks = Array.from({ length: 10 }, (_, i) => level(1001n + BigInt(i), 10_000n));
    await rejects(d, "fail silently: fail on insufficient funds", maker.key, [
      ix.placeMultiplePostOnlyOrders(m, maker, multipleOrderPacket(bids, asks, null, FAIL_FUNDS_FAIL_CROSS)),
    ]);
    await d.ok("fail silently: skip on insufficient funds", maker.key, [
      ix.placeMultiplePostOnlyOrders(m, maker, multipleOrderPacket(bids, asks, null, SKIP_FUNDS_FAIL_CROSS)),
    ]);
    const data = d.data(m.market);
    expect([restingOrders(data, m, BID).length, restingOrders(data, m, ASK).length]).toEqual([9, 9]);
  });

  for (const [name, bids, asks, amend] of [
    ["test_phoenix_multiple_orders_crossing_existing_book_ignore_crossing_bid", (i: number) => 1001n - BigInt(i), (i: number) => 1002n + BigInt(i), false],
    ["test_phoenix_multiple_orders_crossing_existing_book_amend_bid", (i: number) => 1001n - BigInt(i), (i: number) => 1002n + BigInt(i), true],
    ["test_phoenix_multiple_orders_crossing_existing_book_ignore_crossing_ask", (i: number) => 994n - BigInt(i), (i: number) => 995n + BigInt(i), false],
    ["test_phoenix_multiple_orders_crossing_existing_book_amend_ask", (i: number) => 994n - BigInt(i), (i: number) => 995n + BigInt(i), true],
  ] as const) {
    it(name, async () => {
      const d = await diff();
      const b = await bootstrap(d, name);
      const { m } = b;
      const maker = await newMaker(d, b, name, 101n, 1010n);
      await d.ok(`${name}: a bid at 9.96 and an ask at 10.01`, maker.key, [
        ix.placeLimitOrder(m, maker, postOnly(BID, 996n, 1000n)),
        ix.placeLimitOrder(m, maker, postOnly(ASK, 1001n, 1000n)),
      ]);
      const packet = (behavior: number) =>
        multipleOrderPacket(
          Array.from({ length: 10 }, (_, i) => level(bids(i), 10_000n)),
          Array.from({ length: 10 }, (_, i) => level(asks(i), 10_000n)),
          null,
          behavior,
        );
      await rejects(d, `${name}: fail on cross`, maker.key, [ix.placeMultiplePostOnlyOrders(m, maker, packet(FAIL_FUNDS_FAIL_CROSS))]);
      if (amend) {
        await d.ok(`${name}: skip on insufficient funds, amend on cross`, maker.key, [
          ix.placeMultiplePostOnlyOrders(m, maker, packet(SKIP_FUNDS_AMEND_CROSS)),
        ]);
        const data = d.data(m.market);
        expect([restingOrders(data, m, BID).length, restingOrders(data, m, ASK).length]).toEqual([11, 11]);
      } else
        await rejects(d, `${name}: skip on insufficient funds, fail on cross`, maker.key, [
          ix.placeMultiplePostOnlyOrders(m, maker, packet(SKIP_FUNDS_FAIL_CROSS)),
        ]);
    });
  }
});

// ---- src/state/markets/test_market.rs ------------------------------------------------------------------------------------------

describe("test_market.rs", () => {
  it("test_market_simple", async () => {
    const d = await diff();
    const { m, admin, taker } = await unitMarket(d, "simple");
    // StdRng::seed_from_u64(2) there; this harness's xorshift from 2 here: the same draws, from another generator.
    const rng = new Rng(2n);
    const range = (lo: number, hi: number) => BigInt(lo + rng.int(hi - lo));
    const makers: Trader[] = [];
    for (let k = 0; k < 10; k++) {
      const maker = await d.seated(m, PLENTY, PLENTY, `simple: maker ${k}`);
      const [bidStart, bidEnd, askStart, askEnd] = [range(9996, 10_000), range(9900, 9978), range(10_001, 10_005), range(10_033, 10_100)];
      const [size, step] = [range(1, 10), range(1, 5)];
      // layer_orders there gives sizes in base units (×100 base lots).
      await layer(d, `simple: maker ${k} bids`, m, maker, bidStart, bidEnd, 1n, size * 100n, step * 100n, BID);
      await layer(d, `simple: maker ${k} asks`, m, maker, askStart, askEnd, 1n, size * 100n, step * 100n, ASK);
      makers.push(maker);
    }
    const coid = () => (rng.next() << 64n) | rng.next();
    let l = ladder(d, m, 5);
    await d.ok("simple: buy the best ask level", taker.key, [
      ix.swap(m, taker, iocLots(BID, l.asks[0]!.price, l.asks[0]!.size, DECREMENT_TAKE, { coid: coid() })),
    ]);
    l = ladder(d, m, 5);
    await d.ok("simple: sell into the best bid level", taker.key, [
      ix.swap(m, taker, iocLots(ASK, l.bids[0]!.price, l.bids[0]!.size, DECREMENT_TAKE, { coid: coid() })),
    ]);
    l = ladder(d, m, 5);
    await d.ok("simple: a sell at the best ask matches nothing", taker.key, [
      ix.swap(m, taker, iocLots(ASK, l.asks[0]!.price, l.asks[0]!.size, DECREMENT_TAKE, { coid: coid() })),
    ]);
    expect(ladder(d, m, 5)).toEqual(l);
    const all = l.bids.reduce((n, x) => n + x.size, 0n) - 1n;
    await d.ok("simple: sell five bid levels but a lot", taker.key, [ix.swap(m, taker, iocLots(ASK, l.bids[4]!.price, all, DECREMENT_TAKE, { coid: coid() }))]);
    expect(ladder(d, m, 1).bids[0]).toEqual({ price: l.bids[4]!.price, size: 1n });
    // claim_all_funds for every trader with free funds.
    const index = (t: Trader) => registeredTraders(d.data(m.market), m).find((e) => e.key.equals(key(t.key.address)))!;
    for (const [k, t] of makers.entries()) {
      const e = index(t);
      if (e.baseFree > 0n || e.quoteFree > 0n) await d.ok(`simple: maker ${k} withdraws`, t.key, [ix.withdrawFunds(m, t)]);
    }
    for (const [k, t] of makers.entries()) {
      if (rng.int(2) === 0) await d.ok(`simple: maker ${k} cancels its bids up to`, t.key, [BUDGET, ix.cancelUpTo(m, t, cancelUpToParams(BID))]);
      else {
        const mine = restingOrders(d.data(m.market), m, BID).filter((o) => o.trader === BigInt(index(t).index));
        for (let i = 0; i < mine.length; i += 40)
          await d.ok(`simple: maker ${k} cancels its bids by id (${i / 40 + 1})`, t.key, [
            BUDGET,
            ix.cancelMultipleOrdersById(
              m,
              t,
              mine.slice(i, i + 40).map((o) => cancelOrderParams(BID, o.price, o.seq)),
            ),
          ]);
      }
    }
    for (const [k, t] of makers.entries()) {
      await d.ok(`simple: maker ${k} cancels its asks`, t.key, [BUDGET, ix.cancelUpTo(m, t, cancelUpToParams(ASK))]);
      await d.ok(`simple: maker ${k} withdraws all`, t.key, [ix.withdrawFunds(m, t)]);
      // claim_all_funds there also removes a trader with nothing locked; here the authority evicts it.
      await d.ok(`simple: maker ${k} retired`, admin, [ix.changeSeatStatus(m, t.seat, 2)]);
      await d.ok(`simple: maker ${k} evicted`, admin, [ix.evictSeat(m, t)]);
    }
    // Left registered: unitMarket's own two traders.
    expect(treeSizes(d, m).slice(0, 2)).toEqual([0n, 0n]);
    expect(registeredTraders(d.data(m.market), m).length).toBe(2);
  });

  it("test_post_only_default", async () => {
    const d = await diff();
    const { m, trader } = await unitMarket(d, "post only default");
    await place(d, "post only default: bid at 100", m, trader, postOnly(BID, 100n, 1n));
    await rejects(d, "post only default: ask at 100 would match", trader.key, [ix.placeLimitOrder(m, trader, postOnly(ASK, 100n, 1n))]);
    await place(d, "post only default: ask at 102", m, trader, postOnly(ASK, 102n, 1n));
    await place(d, "post only default: bid at 101", m, trader, postOnly(BID, 101n, 1n));
    await rejects(d, "post only default: bid at 102 would match", trader.key, [ix.placeLimitOrder(m, trader, postOnly(BID, 102n, 1n))]);
    expect(ladder(d, m, 5)).toEqual({
      bids: [
        { price: 101n, size: 1n },
        { price: 100n, size: 1n },
      ],
      asks: [{ price: 102n, size: 1n }],
    });
  });

  it("test_post_only_rejection", async () => {
    const d = await diff();
    const { m, trader } = await unitMarket(d, "post only rejection");
    const po = (side: 0 | 1, price: bigint, reject: boolean) => postOnly(side, price, 1n, { reject });
    await place(d, "post only rejection: bid at 100", m, trader, po(BID, 100n, true));
    await rejects(d, "post only rejection: ask at 100, rejected", trader.key, [ix.placeLimitOrder(m, trader, po(ASK, 100n, true))]);
    await place(d, "post only rejection: ask at 102", m, trader, po(ASK, 102n, true));
    await place(d, "post only rejection: bid at 101", m, trader, po(BID, 101n, true));
    await rejects(d, "post only rejection: bid at 102, rejected", trader.key, [ix.placeLimitOrder(m, trader, po(BID, 102n, true))]);
    await place(d, "post only rejection: ask at 100, amended", m, trader, po(ASK, 100n, false));
    await place(d, "post only rejection: bid at 102, amended", m, trader, po(BID, 102n, false));
    expect(ladder(d, m, 5)).toEqual({
      bids: [
        { price: 101n, size: 2n },
        { price: 100n, size: 1n },
      ],
      asks: [{ price: 102n, size: 2n }],
    });
    await d.ok("post only rejection: cancel all", trader.key, [ix.cancelAllOrders(m, trader)]);
    await place(d, "post only rejection: ask at 1 on an empty book", m, trader, po(ASK, 1n, false));
    await rejects(d, "post only rejection: bid amended below 1 tick", trader.key, [ix.placeLimitOrder(m, trader, po(BID, 1n, false))]);
    await rejects(d, "post only rejection: bid at 0", trader.key, [ix.placeLimitOrder(m, trader, po(BID, 0n, false))]);
    expect(ladder(d, m, 5).asks[0]!.price).toBe(1n);
  });

  it("test_limit_orders_with_self_trade", async () => {
    const d = await diff();
    const { m, trader, taker } = await unitMarket(d, "self trade");
    await place(d, "self trade: bid 5 at 100", m, trader, limit(BID, 100n, 5n));
    await place(d, "self trade: ask 10 at 100 cancels its own bid", m, trader, limit(ASK, 100n, 10n));
    expect(ladder(d, m, 1).asks[0]!.size).toBe(10n);
    await rejects(d, "self trade: bid 15, Abort", trader.key, [ix.placeLimitOrder(m, trader, limit(BID, 100n, 15n, { stb: ABORT, coid: 1n }))]);
    await place(d, "self trade: bid 15, DecrementTake", m, trader, limit(BID, 100n, 15n, { stb: DECREMENT_TAKE, coid: 2n }));
    expect(ladder(d, m, 1).bids[0]!.size).toBe(5n);
    await place(d, "self trade: taker asks 10, DecrementTake", m, taker, limit(ASK, 100n, 10n, { stb: DECREMENT_TAKE, coid: 3n }));
    expect(ladder(d, m, 1).asks[0]!.size).toBe(5n);
    await place(d, "self trade: taker bids 1 into its own ask, DecrementTake", m, taker, limit(BID, 100n, 1n, { stb: DECREMENT_TAKE, coid: 4n }));
    expect(ladder(d, m, 1).asks[0]!.size).toBe(4n);
  });

  it("test_limit_orders_with_free_lots", async () => {
    const d = await diff();
    const { m, trader, taker } = await unitMarket(d, "free lots");
    const steps: [string, Trader, 0 | 1, bigint, bigint][] = [
      ["trader bids 5 at 100", trader, BID, 100n, 5n],
      ["trader bids 15 at 95", trader, BID, 95n, 15n],
      ["taker sells 15 at 95, filling both", taker, ASK, 95n, 15n],
      ["trader asks 5 at 100 on free lots", trader, ASK, 100n, 5n],
      ["trader asks 20 at 100, free lots and new", trader, ASK, 100n, 20n],
      ["trader bids 10 at 100, a self trade freeing lots", trader, BID, 100n, 10n],
      ["taker bids 10 at 101", taker, BID, 101n, 10n],
      ["trader asks 50 at 100, matching then posting on free lots", trader, ASK, 100n, 50n],
      ["taker bids 55 at 105", taker, BID, 105n, 55n],
      ["trader bids 20 at 100 on freed quote", trader, BID, 100n, 20n],
      ["trader bids 50 at 100, the rest of the freed quote", trader, BID, 100n, 50n],
      ["trader bids 50 at 120", trader, BID, 120n, 50n],
      ["trader asks 25 at 120, a self trade", trader, ASK, 120n, 25n],
      ["taker asks 25 at 110", taker, ASK, 110n, 25n],
      ["trader bids 75 at 111, matching then posting on freed quote", trader, BID, 111n, 75n],
    ];
    for (const [label, t, side, price, lots] of steps) await place(d, `free lots: ${label}`, m, t, limit(side, price, lots));
  });

  it("test_orders_with_only_free_funds", async () => {
    const d = await diff();
    const { m, trader, taker } = await unitMarket(d, "only free funds");
    await rejects(d, "only free funds: taker's PostOnly with no free funds", taker.key, [
      ix.placeLimitOrderWithFreeFunds(m, taker, postOnly(BID, 100n, 5n, { reject: false, free: true })),
    ]);
    await place(d, "only free funds: trader bids 5 at 100", m, trader, postOnly(BID, 100n, 5n, { reject: false }));
    await rejects(d, "only free funds: taker's IOC with no free funds", taker.key, [
      ix.swapWithFreeFunds(m, taker, iocLots(ASK, 100n, 5n, CANCEL_PROVIDE, { free: true })),
    ]);
    await swap(d, "only free funds: taker's IOC with tokens", m, taker, iocLots(ASK, 100n, 5n, CANCEL_PROVIDE));
    await place(d, "only free funds: trader asks on the base it bought", m, trader, limit(ASK, 100n, 5n, { stb: ABORT, free: true }), true);
    await place(d, "only free funds: taker buys it", m, taker, limit(BID, 100n, 5n, { stb: ABORT }));
    await place(d, "only free funds: taker asks 5 at 100", m, taker, limit(ASK, 100n, 5n, { stb: ABORT }));
    await swap(d, "only free funds: trader's IOC for 6, funded for the 5 matched", m, trader, iocLots(BID, 100n, 6n, ABORT, { free: true }), true);
  });

  /** seed_market_with_orders: 10 PostOnly bids from 99 down and 10 asks from 101 up, 10 lots each. */
  async function seeded(name: string) {
    const d = await diff();
    const u = await unitMarket(d, name);
    for (const side of [BID, ASK] as const)
      await d.ok(
        `${name}: seed ${side === BID ? "bids" : "asks"}`,
        u.trader.key,
        Array.from({ length: 10 }, (_, i) => ix.placeLimitOrder(u.m, u.trader, postOnly(side, side === BID ? 99n - BigInt(i) : 101n + BigInt(i), 10n))),
      );
    return { d, ...u };
  }
  /** Ticks × tick size × lots / base lots per unit: the quote lots of `lots` at `price` (10,000 and 100 there). */
  const quoteLots = (price: bigint, lots: bigint) => (price * 10_000n * lots) / 100n;

  it("test_fok_and_ioc_limit_1", async () => {
    const { d, m, taker } = await seeded("fok 1");
    await swap(d, "fok 1: FOK buy through 3 levels", m, taker, fok(BID, 103n, 30n, { coid: 1n }));
    await swap(d, "fok 1: FOK sell through 3 levels", m, taker, fok(ASK, 97n, 30n, { coid: 2n }));
  });

  it("test_fok_and_ioc_limit_2", async () => {
    const { d, m, taker } = await seeded("fok 2");
    await rejects(d, "fok 2: FOK buy, price limit too low", taker.key, [ix.swap(m, taker, fok(BID, 102n, 30n))]);
    await rejects(d, "fok 2: FOK sell, price limit too high", taker.key, [ix.swap(m, taker, fok(ASK, 98n, 30n))]);
  });

  it("test_fok_and_ioc_limit_3", async () => {
    const { d, m, taker } = await seeded("ioc 3");
    await swap(d, "ioc 3: IOC buy with a quote lot more than 3 levels", m, taker, ioc(BID, { price: 103n, quote: quoteLots(102n, 30n) + 1n, stb: ABORT }));
    await swap(d, "ioc 3: IOC sell 31 lots, 30 there", m, taker, iocLots(ASK, 97n, 31n));
  });

  it("test_fok_and_ioc_limit_4", async () => {
    const { d, m, taker } = await seeded("ioc 4");
    await swap(d, "ioc 4: IOC buy, two levels in its price", m, taker, ioc(BID, { price: 102n, quote: quoteLots(102n, 30n), stb: ABORT }));
    await swap(d, "ioc 4: IOC sell, two levels in its price", m, taker, iocLots(ASK, 98n, 30n));
  });

  it("test_fok_and_ioc_limit_5", async () => {
    const { d, m, taker } = await seeded("fok 5");
    await rejects(d, "fok 5: FOK buy 31 lots, 30 there", taker.key, [ix.swap(m, taker, fok(BID, 103n, 31n))]);
    await rejects(d, "fok 5: FOK sell 31 lots, 30 there", taker.key, [ix.swap(m, taker, fok(ASK, 97n, 31n))]);
    // The clock at slot 1000, second 1000.
    setClock(d, 1000n, 1000n);
    await swap(d, "fok 5: IOC expired by slot", m, taker, ioc(BID, { base: 100n, stb: ABORT, slot: 2n }));
    await swap(d, "fok 5: IOC expired by timestamp", m, taker, ioc(BID, { base: 100n, stb: ABORT, time: 2n }));
    await swap(d, "fok 5: IOC within both limits", m, taker, ioc(BID, { base: 100n, stb: ABORT, slot: 1200n, time: 1200n }));
    setClock(d, SLOT, UNIX_TIMESTAMP);
    await rejects(d, "fok 5: IOC in base and quote lots", taker.key, [ix.swap(m, taker, ioc(BID, { base: 100n, quote: 1n, stb: ABORT }))]);
  });

  it("test_fok_and_ioc_with_free_funds", async () => {
    const { d, m, taker } = await seeded("fok free");
    // The taker's state: 29 free base lots and the quote lots of one lot at 103.
    await d.ok("fok free: deposit", taker.key, [ix.depositFunds(m, taker, quoteLots(103n, 1n), 29n)]);
    await swap(d, "fok free: FOK sell at 99 with tokens", m, taker, fok(ASK, 99n, 10n));
    await swap(d, "fok free: FOK sell at 98 on free funds", m, taker, fok(ASK, 98n, 10n, { free: true }), true);
    await rejects(d, "fok free: FOK sell at 97 on free funds, short", taker.key, [ix.swapWithFreeFunds(m, taker, fok(ASK, 97n, 10n, { free: true }))]);
    await swap(d, "fok free: FOK buy at 101 with tokens", m, taker, fok(BID, 101n, 10n));
    // Swap pays from a registered trader's free lots first (the bare matching engine there leaves them for the
    // free-funds orders): the 101,000 quote lots it took are deposited back, so the free funds are the unit test's.
    await d.ok("fok free: deposit back what the token buy took from free funds", taker.key, [ix.depositFunds(m, taker, quoteLots(101n, 10n), 0n)]);
    await swap(d, "fok free: FOK buy at 102 on free funds", m, taker, fok(BID, 102n, 10n, { free: true }), true);
    await rejects(d, "fok free: FOK buy at 103 on free funds, short", taker.key, [ix.swapWithFreeFunds(m, taker, fok(BID, 103n, 10n, { free: true }))]);
  });

  /** The slippage tests' book: tick 1,000, 1,000 base lots a unit, 5 bps; bids 99..90 and asks 101..110 of 10,000·i lots. */
  async function slippageBook(name: string, fee = 5) {
    const d = await diff();
    const u = await unitMarket(d, name, 1000n, 1000n, fee);
    const orders: Instruction[] = [];
    for (let i = 1n; i <= 10n; i++) {
      orders.push(ix.placeLimitOrder(u.m, u.trader, postOnly(BID, 100n - i, 10_000n * i)));
      orders.push(ix.placeLimitOrder(u.m, u.trader, postOnly(ASK, 100n + i, 10_000n * i)));
    }
    for (let i = 0; i < orders.length; i += 10) await d.ok(`${name}: seed (${i / 10 + 1})`, u.trader.key, orders.slice(i, i + 10));
    return { d, ...u };
  }

  it("test_fok_with_slippage_1", async () => {
    const { d, m, taker } = await slippageBook("slippage 1");
    // get_min_base_lots_out (f64, as there): 6,000,000 quote lots at 102 ticks, 50 bps slippage.
    const quoteIn = 6_000_000;
    const minBase = BigInt(Math.floor(((quoteIn * 1000) / (1000 * 102)) * (1 - 50 / 10000)));
    await swap(d, "slippage 1: buy for quote lots, a minimum of base lots", m, taker, ioc(BID, { quote: BigInt(quoteIn), minBase }));
  });

  it("test_fok_with_slippage_2", async () => {
    const { d, m, taker } = await slippageBook("slippage 2");
    await rejects(d, "slippage 2: sell 50,000 lots for the quote lots of 98 ticks", taker.key, [
      ix.swap(m, taker, ioc(ASK, { base: 50_000n, minQuote: 98n * 50_000n })),
    ]);
  });

  it("test_fok_with_slippage_3", async () => {
    const { d, m, taker } = await slippageBook("slippage 3");
    // get_min_quote_lots_out (f64): 50 units at 98 ticks, 28 bps slippage.
    const minQuote = BigInt(Math.floor(((1000 * 98 * 50_000) / 1000) * (1 - 28 / 10000)));
    await swap(d, "slippage 3: sell 50 units, a minimum of quote lots", m, taker, ioc(ASK, { base: 50_000n, minQuote }));
  });

  it("test_sell_with_quote_lot_budget", async () => {
    const d = await diff();
    const { m, trader, taker } = await unitMarket(d, "quote budget", 1000n, 1000n, 0);
    await place(d, "quote budget: bid 10,000 at 100", m, trader, postOnly(BID, 100n, 10_000n));
    await place(d, "quote budget: bid 20,000 at 99", m, trader, postOnly(BID, 99n, 20_000n));
    await swap(d, "quote budget: sell for 1,000,000 quote lots", m, taker, ioc(ASK, { quote: 1_000_000n, stb: ABORT }));
    await swap(d, "quote budget: sell for 1,000,000 quote lots again", m, taker, ioc(ASK, { quote: 1_000_000n, stb: ABORT }));
  });

  it("test_fees_basic", async () => {
    const d = await diff();
    const { m, admin, trader, taker } = await unitMarket(d, "fees basic", 10_000n, 1000n, 5);
    await place(d, "fees basic: bid 10 at 9900", m, trader, postOnly(BID, 9900n, 10n));
    await place(d, "fees basic: ask 10 at 10100", m, trader, postOnly(ASK, 10_100n, 10n));
    await swap(d, "fees basic: buy 10", m, taker, iocLots(BID, 10_100n, 10n));
    await swap(d, "fees basic: sell 10", m, taker, iocLots(ASK, 9900n, 10n));
    const account = await d.tokenAccount(m.quoteMint, admin.address);
    await d.ok("fees basic: collect", admin, [ix.collectFees(m, admin, account)]);
    expect(d.data(m.market).readBigUInt64LE(OFF.unclaimedFees)).toBe(0n);
  });

  it("test_tif", async () => {
    const d = await diff();
    const { m, trader: maker, taker } = await unitMarket(d, "tif");
    const exp = UNIX_TIMESTAMP + 1000n;
    for (const [what, packet] of [
      ["timestamp", postOnly(BID, 1000n, 100n, { coid: 11n, time: exp })],
      ["slot", postOnly(BID, 1000n, 100n, { coid: 12n, slot: SLOT + 1000n })],
    ] as const) {
      const at = { slot: SLOT, time: UNIX_TIMESTAMP };
      const advance = (n: bigint) => {
        if (what === "slot") at.slot += n;
        else at.time += n;
        setClock(d, at.slot, at.time);
      };
      setClock(d, SLOT + 2000n, UNIX_TIMESTAMP + 2000n);
      await place(d, `tif ${what}: placed once expired, nothing rests`, m, maker, packet);
      setClock(d, at.slot, at.time);
      await place(d, `tif ${what}: placed`, m, maker, packet);
      const sell = ix.swap(m, taker, iocLots(ASK, 0n, 10n));
      advance(500n);
      await d.ok(`tif ${what}: half way, fills`, taker.key, [sell]);
      advance(500n);
      await d.ok(`tif ${what}: at the last valid ${what}, fills`, taker.key, [sell]);
      advance(1n);
      await d.ok(`tif ${what}: one past, expires`, taker.key, [sell]);
      expect(restingOrders(d.data(m.market), m, BID)).toEqual([]);
    }
    setClock(d, SLOT, UNIX_TIMESTAMP);
  });
});

// ---- src/state/order_schema/order_packet.rs -----------------------------------------------------------------------------------

describe("order_packet.rs", () => {
  it("test_decode_order_packet", async () => {
    const d = await diff();
    const { m, trader, taker } = await unitMarket(d, "decode");
    await d.ok("decode: resting orders", trader.key, [
      ix.placeMultiplePostOnlyOrders(m, trader, multipleOrderPacket([level(100n, 50n), level(90n, 50n)], [level(110n, 50n), level(120n, 50n)], null, 1)),
    ]);
    // The deprecated packets (before the time-in-force fields and fail-silent flag): PostOnly and Limit end 3 bytes
    // earlier, IOC 2. Half of them random over every field, as there; half with prices and sizes the market takes.
    const rng = new Rng(42n);
    const outcomes: Record<string, Set<string>> = { PostOnly: new Set(), Limit: new Set(), ImmediateOrCancel: new Set() };
    for (let i = 0; i < 100; i++) {
      const wild = i % 2 === 0;
      const side = rng.int(2) as 0 | 1;
      const price = wild ? rng.next() : BigInt(80 + rng.int(60));
      const lots = wild ? rng.next() : BigInt(1 + rng.int(20));
      const coid = (rng.next() << 64n) | rng.next();
      const free = rng.chance(wild ? 50 : 10);
      const post = orderPacket({
        kind: "PostOnly",
        side,
        priceInTicks: price,
        numBaseLots: lots,
        clientOrderId: coid,
        rejectPostOnly: rng.chance(50),
        useOnlyDepositedFunds: free,
      });
      const matchLimit = rng.chance(50) ? (wild ? rng.next() : BigInt(rng.int(4))) : null;
      const lim = orderPacket({
        kind: "Limit",
        side,
        priceInTicks: price,
        numBaseLots: lots,
        selfTradeBehavior: rng.int(3) as 0 | 1 | 2,
        matchLimit,
        clientOrderId: coid,
        useOnlyDepositedFunds: free,
      });
      const quoteBudget = rng.chance(30);
      const iocPacket = orderPacket({
        kind: "ImmediateOrCancel",
        side,
        priceInTicks: rng.chance(50) ? price : null,
        numBaseLots: quoteBudget ? 0n : lots,
        numQuoteLots: quoteBudget ? (wild ? rng.next() : lots * 1000n) : 0n,
        minBaseLotsToFill: wild ? rng.next() : BigInt(rng.int(3)),
        minQuoteLotsToFill: wild ? rng.next() : 0n,
        selfTradeBehavior: rng.int(3) as 0 | 1 | 2,
        matchLimit,
        clientOrderId: coid,
        useOnlyDepositedFunds: free,
      });
      const data = (tag: number, p: Buffer, cut: number) => Buffer.concat([u8(tag), p.subarray(0, p.length - cut)]);
      outcomes.PostOnly!.add(await d.both(`decode ${i}: PostOnly`, trader.key, [withData(ix.placeLimitOrder(m, trader, post), data(2, post, 3))]));
      outcomes.Limit!.add(await d.both(`decode ${i}: Limit`, trader.key, [withData(ix.placeLimitOrder(m, trader, lim), data(2, lim, 3))]));
      outcomes.ImmediateOrCancel!.add(await d.both(`decode ${i}: IOC`, taker.key, [withData(ix.swap(m, taker, iocPacket), data(0, iocPacket, 2))]));
    }
    // Each form decoded and went on to succeed at least once.
    for (const [kind, set] of Object.entries(outcomes)) expect([...set], kind).toContain("ok");
  });
});
