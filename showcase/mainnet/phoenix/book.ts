// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// Taking orders off the books (state/markets/fifo.rs): reduce_order_inner, which reduces or removes one resting
// order, records a Reduce (or ExpiredOrder) event, unlocks what the order held and optionally claims it, and the
// cancels built on it: cancel_multiple_orders_by_id_inner, cancel_all_orders_inner and cancel_up_to_inner.
//
// Phoenix first collects the ids to cancel in a heap Vec (FIFOOrderId, 16 bytes, grown by doubling from 4 under
// solana-program's bump allocator, which never frees), then cancels them one by one, each looked up again by its id.
// The 513th id needs a 16 KiB allocation after the 16,320 bytes of the smaller ones, which the 32 KiB heap never has
// room for: Phoenix runs out of memory there, before it cancels anything (the test measures it on the binary). The
// port collects node indices (sokoban never moves a node, and a freed node keeps its key; a book holds at most 4096
// orders, so an index fits a u16) in a 512-entry list and fails the same way on the 513th; each id is then read back
// from its node and looked up as Phoenix looks it up.
import {
  type FixedVec,
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccounts,
  type TokenProgram,
  type u8,
  abort,
  fixedVec,
  loadRaw,
  loadRawAt,
  log,
  panicsAt,
  programAt,
  rbTreeAt,
  rbTreeMutAt,
  u16,
  u32,
  u64,
} from "typesol";
import {
  type FIFOOrderId,
  type FIFORestingOrder,
  type FifoMarketPrefix,
  type MarketHeader,
  type TraderState,
  BIDS_OFFSET,
  FIFO_MARKET_OFFSET,
  asksOffset,
  tradersOffset,
} from "./state.js";
import { type Recorder, flush, recordEvent } from "./recorder.js";
import { sendFromVault } from "./funds.js";
import { addBaseLots, addQuoteLots, baseLotsToAtoms, orderCmp, quoteLotsToAtoms, subBaseLots, subQuoteLots } from "./util.js";

/** The lots a reduction or cancel gives back to the trader's wallet: MatchingEngineResponse's *_out. */
export interface Released {
  quote: u64;
  base: u64;
}

/**
 * What the book work reads of the market again and again, read once: the trees' capacities and offsets, the
 * FIFOMarket's tick size and base lots per base unit.
 */
export interface MarketShape {
  bids: u64;
  asks: u64;
  asksAt: u64;
  tradersAt: u64;
  seats: u64;
  tick: u64;
  perUnit: u64;
}

/** The market's MarketShape (after dispatchLoadedMarket checked its sizes). */
export function marketShape(rest: RemainingAccounts): MarketShape {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  const fifo = loadRawAt<FifoMarketPrefix>(market, FIFO_MARKET_OFFSET);
  const n = h.market_size_params.bids_size;
  return {
    bids: n,
    asks: h.market_size_params.asks_size,
    asksAt: asksOffset(n),
    tradersAt: tradersOffset(n),
    seats: h.market_size_params.num_seats,
    tick: fifo.tick_size_in_quote_lots_per_base_unit,
    perUnit: fifo.base_lots_per_base_unit,
  };
}

/** The ids Phoenix's Vec holds before its next growth runs out of memory (see the file's notes). */
const MAX_COLLECTED = 512n;

/** Side::from_order_sequence_number: a bid's stored sequence number has its top bit set. */
export function isBidSequence(seq: u64): boolean {
  return seq >> 63n === 1n;
}

/** get_trader_index: the trader's node index in the traders tree, 0 when it holds no state. */
export function traderIndexOf(m: Inout<MarketShape>, rest: RemainingAccounts, trader: Pubkey): u32 {
  const traders = rbTreeAt<Pubkey, TraderState>(rest.get(2n), m.tradersAt, m.seats);
  return traders.addrOf(trader);
}

/**
 * The quote lots a bid of `lots` at `price` holds: `(price × tick × lots) / base_lots_per_base_unit` (fifo.rs:1616,
 * reduce_order_inner). The products panic at their quantities.rs impls; the division is `#[track_caller]`, so its
 * remainder check panics, and its warning names, the caller's location.
 */
function reducedBidQuoteLots(price: u64, tick: u64, lots: u64, perUnit: u64): u64 {
  const adjusted = panicsAt("src/quantities.rs:293:1", panicsAt("src/quantities.rs:287:1", price * tick) * lots);
  if (panicsAt("src/state/markets/fifo.rs:1616:38", adjusted % perUnit) !== 0n) {
    log(
      `WARNING: Expected clean division, but received AdjustedQuoteLots { inner: ${adjusted} } / BaseLotsPerBaseUnit { inner: ${perUnit} }. Caller: Location { file: "src/state/markets/fifo.rs", line: 1616, col: 38 }`,
    );
  }
  return adjusted / perUnit;
}

/** A Reduce event's bytes: its PhoenixMarketEvent tag, the index (u16) and four u64s. */
const REDUCE_EVENT_LEN = 35n;
/** recorder.ts's limit: the inner instruction's 1280 bytes, less the Log instruction's one account meta (34). */
const EVENT_ROOM = 1246n;

/**
 * recordEvent of a Reduce event { index, order_sequence_number, price_in_ticks, base_lots_removed,
 * base_lots_remaining }, its Borsh bytes appended to the batch directly (the bulk cancels record one per order).
 */
function recordReduce(
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  rest: RemainingAccounts,
  seq: u64,
  price: u64,
  removed: u64,
  remaining: u64,
): void {
  if (logData.length + REDUCE_EVENT_LEN > EVENT_ROOM) flush(rec, logData, rest);
  logData.pushLE<u8>(4n); // PhoenixMarketEvent::Reduce
  logData.pushLE(u16(rec.eventsAdded));
  logData.pushLE(seq);
  logData.pushLE(price);
  logData.pushLE(removed);
  logData.pushLE(remaining);
  rec.eventsAdded++;
}

/**
 * reduce_order_inner: the order (price, seq) on the bid or ask book, if it is there, reduced by `size` (all of it
 * when `hasSize` is false or the size covers it, which removes it from the book), its Reduce event recorded, what it
 * held unlocked into the trader's free funds and, with `claim`, claimed back out of them into `out`. An order that is
 * not on the book releases nothing; one of another trader is None (false). `expired` is the matching engine's case:
 * the whole order is removed and an ExpiredOrder event names its maker.
 */
export function reduceOrderInner(
  m: Inout<MarketShape>,
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  traderIndex: u32,
  price: u64,
  seq: u64,
  bid: boolean,
  hasSize: boolean,
  size: u64,
  expired: boolean,
  claim: boolean,
  out: Inout<Released>,
): boolean {
  out.quote = 0n;
  out.base = 0n;
  const market = rest.get(2n);
  const book = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, bid ? BIDS_OFFSET : m.asksAt, bid ? m.bids : m.asks, orderCmp);
  const id: FIFOOrderId = { price_in_ticks: price, order_sequence_number: seq };
  const order = book.get(id);
  if (order === null) return true;
  const resting = order.num_base_lots;
  let removed = hasSize && size < resting ? size : resting;
  if (order.trader_index !== u64(traderIndex)) return false;
  if (expired) removed = resting;
  let remaining = 0n;
  if (removed === resting) book.remove(id);
  else {
    remaining = subBaseLots(resting, removed);
    order.num_base_lots = remaining;
  }
  const traders = rbTreeMutAt<Pubkey, TraderState>(market, m.tradersAt, m.seats);
  if (expired) {
    recordEvent(rec, logData, rest, {
      kind: "ExpiredOrder",
      index: u16(rec.eventsAdded),
      maker_id: traders.nodeAt(traderIndex).key,
      order_sequence_number: seq,
      price_in_ticks: price,
      base_lots_removed: removed,
    });
  } else recordReduce(rec, logData, rest, seq, price, removed, remaining);

  // Unlock: a bid held quote lots, an ask base lots.
  const state = traders.nodeAt(traderIndex).value;
  let quoteLots = 0n;
  let baseLots = 0n;
  if (bid) {
    quoteLots = reducedBidQuoteLots(price, m.tick, removed, m.perUnit);
    state.quote_lots_locked = subQuoteLots(state.quote_lots_locked, quoteLots);
    state.quote_lots_free = addQuoteLots(state.quote_lots_free, quoteLots);
  } else {
    baseLots = removed;
    state.base_lots_locked = subBaseLots(state.base_lots_locked, removed);
    state.base_lots_free = addBaseLots(state.base_lots_free, removed);
  }
  // claim_funds_inner (no eviction): at most what is free.
  if (claim) {
    const quoteFree = state.quote_lots_free;
    const baseFree = state.base_lots_free;
    out.quote = quoteLots < quoteFree ? quoteLots : quoteFree;
    out.base = baseLots < baseFree ? baseLots : baseFree;
    state.quote_lots_free = subQuoteLots(quoteFree, out.quote);
    state.base_lots_free = subBaseLots(baseFree, out.base);
  }
  return true;
}

/**
 * One id of cancel_multiple_orders_by_id_inner: removed whole from the book its sequence number names, what it
 * released added to `total` (the fold's `+`, quote then base); another trader's order is skipped.
 */
function cancelOne(
  m: Inout<MarketShape>,
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  traderIndex: u32,
  price: u64,
  seq: u64,
  claim: boolean,
  total: Inout<Released>,
): void {
  const one: Released = { quote: 0n, base: 0n };
  if (reduceOrderInner(m, rest, rec, logData, traderIndex, price, seq, isBidSequence(seq), false, 0n, false, claim, one)) {
    total.quote = addQuoteLots(total.quote, one.quote);
    total.base = addBaseLots(total.base, one.base);
  }
}

/** Vec::push past the room the heap has: the allocator's out-of-memory abort. */
function collect(ids: Inout<FixedVec<u16, 512>>, index: u32): void {
  if (ids.length === MAX_COLLECTED) {
    log("Error: memory allocation failed, out of memory");
    abort();
  }
  ids.push(u16(index));
}

/** Cancel the collected nodes `from`..`to` of one book, in order, each by the id its node holds. */
function cancelCollected(
  m: Inout<MarketShape>,
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  traderIndex: u32,
  bid: boolean,
  ids: FixedVec<u16, 512>,
  from: u64,
  to: u64,
  claim: boolean,
  total: Inout<Released>,
): void {
  const book = rbTreeAt<FIFOOrderId, FIFORestingOrder>(rest.get(2n), bid ? BIDS_OFFSET : m.asksAt, bid ? m.bids : m.asks, orderCmp);
  for (let i = from; i < to; i++) {
    const node = book.nodeAt(u32(ids.get(i)));
    const price = node.key.price_in_ticks;
    const seq = node.key.order_sequence_number;
    cancelOne(m, rest, rec, logData, traderIndex, price, seq, claim, total);
  }
}

/**
 * cancel_all_orders_inner: the trader's orders with lots left, bids then asks, each book walked whole, then cancelled
 * in that order.
 * @noinline
 */
export function cancelAllInner(
  m: Inout<MarketShape>,
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  traderIndex: u32,
  claim: boolean,
  total: Inout<Released>,
): void {
  const market = rest.get(2n);
  const ids: FixedVec<u16, 512> = fixedVec([]);
  const owner = u64(traderIndex);
  const bids = rbTreeAt<FIFOOrderId, FIFORestingOrder>(market, BIDS_OFFSET, m.bids, orderCmp);
  for (const e of bids) if (e.value.trader_index === owner && e.value.num_base_lots > 0n) collect(ids, e.index);
  const bidCount = ids.length;
  const asks = rbTreeAt<FIFOOrderId, FIFORestingOrder>(market, m.asksAt, m.asks, orderCmp);
  for (const e of asks) if (e.value.trader_index === owner && e.value.num_base_lots > 0n) collect(ids, e.index);
  cancelCollected(m, rest, rec, logData, traderIndex, true, ids, 0n, bidCount, claim, total);
  cancelCollected(m, rest, rec, logData, traderIndex, false, ids, bidCount, ids.length, claim, total);
}

/** CancelUpToParams, decoded. */
export interface CancelUpTo {
  bid: boolean;
  hasTick: boolean;
  tick: u64;
  hasSearch: boolean;
  search: u32;
  hasCancel: boolean;
  cancel: u32;
}

/**
 * cancel_up_to_inner: on one book, best first, among the first `search` orders (all by default), the trader's at or
 * better than the tick limit (a bid at or above it, an ask at or below it), at most `cancel` of them (all by
 * default), then cancelled.
 * @noinline
 */
export function cancelUpToInner(
  m: Inout<MarketShape>,
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  traderIndex: u32,
  params: CancelUpTo,
  claim: boolean,
  total: Inout<Released>,
): void {
  const ids: FixedVec<u16, 512> = fixedVec([]);
  const owner = u64(traderIndex);
  const bid = params.bid;
  const book = rbTreeAt<FIFOOrderId, FIFORestingOrder>(rest.get(2n), bid ? BIDS_OFFSET : m.asksAt, bid ? m.bids : m.asks, orderCmp);
  const len = book.length;
  // Ticks::MIN for bids, Ticks::MAX for asks.
  const limit = params.hasTick ? params.tick : bid ? 0n : 18446744073709551615n;
  const search = params.hasSearch ? u64(params.search) : len;
  const count = params.hasCancel ? u64(params.cancel) : len;
  let searched = 0n;
  if (count > 0n) {
    for (const e of book) {
      if (searched === search) break;
      searched++;
      if (e.value.trader_index !== owner) continue;
      const price = e.key.price_in_ticks;
      if (bid ? price < limit : price > limit) continue;
      collect(ids, e.index);
      if (ids.length === count) break;
    }
  }
  cancelCollected(m, rest, rec, logData, traderIndex, bid, ids, 0n, ids.length, claim, total);
}

/**
 * cancel_multiple_orders_by_id_inner over a decoded CancelMultipleOrdersByIdParams: its `count` CancelOrderParams
 * (17 bytes each from byte 5: side, price, sequence number), those whose side disagrees with their sequence number
 * dropped (the processor's filter_map), the rest cancelled in order.
 */
export function cancelByIdInner(
  m: Inout<MarketShape>,
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  data: InstructionBytes,
  count: u64,
  traderIndex: u32,
  claim: boolean,
  total: Inout<Released>,
): void {
  for (let i = 0n; i < count; i++) {
    const at = 5n + 17n * i;
    const seq = data.readU64(at + 9n);
    if ((data.readU8(at) === 0n) !== isBidSequence(seq)) continue;
    cancelOne(m, rest, rec, logData, traderIndex, data.readU64(at + 1n), seq, claim, total);
  }
}

/**
 * token_utils.rs try_withdraw of what was released: quote lots × quote lot size, then base lots × base lot size, sent
 * quote first, from the vault context at position `vaults` (base account, quote account, base vault, quote vault,
 * SPL Token).
 */
export function withdrawReleased(rest: RemainingAccounts, vaults: u64, released: Released): void {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  const quoteAtoms = quoteLotsToAtoms(released.quote, h.quote_lot_size);
  const baseAtoms = baseLotsToAtoms(released.base, h.base_lot_size);
  const token = programAt<TokenProgram>(rest.get(vaults + 4n));
  sendFromVault(token, market.key, h.quote_params.mint_key, h.quote_params.vault_bump, rest.get(vaults + 3n), rest.get(vaults + 1n), quoteAtoms);
  sendFromVault(token, market.key, h.base_params.mint_key, h.base_params.vault_bump, rest.get(vaults + 2n), rest.get(vaults), baseAtoms);
}
