// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// The matching engine (state/markets/fifo.rs, state/inflight_order.rs, state/matching_engine_response.rs): an order
// packet is matched against the opposite book, best price first and FIFO within a price, then what is left rests on
// its own book (PostOnly and Limit orders) or is dropped (ImmediateOrCancel). The FIFOMarket's fields are read and
// written in place (loadRawMutAt at byte 576) and its three trees are lib-sokoban's (rbTreeMutAt); a tree is a view
// of the function that makes it, so each helper makes the ones it needs from the market account.
//
// Quantities are plain u64s. Rust's newtype operators panic at their `impl`, the macro invocation in quantities.rs:
// QuoteLots and BaseLots (util.ts's helpers, lines 233 and 234), AdjustedQuoteLots (257), and the products of
// allow_multiply!: QuoteLotsPerBaseUnitPerTick × Ticks (287), QuoteLots × BaseLotsPerBaseUnit (290) and
// QuoteLotsPerBaseUnit × BaseLots (293). The divisions of an AdjustedQuoteLots by the base lots per base unit are exact
// in every market InitializeMarket accepts (the tick size is a multiple of it), so their "Expected clean division"
// warning is never logged.
//
// Orders leave the book through book.ts's reduceOrderInner (reduce_order_inner), shared with the reductions and
// cancels: an expired order met while matching or checking for a cross (an ExpiredOrder event), and the taker's own
// order a self trade cancels (CancelProvide) or decrements (DecrementTake). None of them claims funds. The market's
// shape (MarketShape: tree capacities and offsets, tick size, base lots per base unit) is read on those paths only.
//
// Every event goes through the recorder (recordEvent; book.ts appends a Reduce to the batch itself, with the same
// flush), which sends a batch in a Log self-CPI whenever the next event would not fit: a long match flushes in the
// middle, before the token transfers, as Phoenix's does.
import {
  type FixedVec,
  type Inout,
  type Pubkey,
  type RemainingAccounts,
  type u8,
  loadRaw,
  loadRawAt,
  loadRawMutAt,
  log,
  panicsAt,
  rbTreeAt,
  rbTreeMutAt,
  u16,
  u32,
  u64,
  u128,
} from "typesol";
import {
  type FifoMarketPrefix,
  type FIFOOrderId,
  type FIFORestingOrder,
  type MarketHeader,
  type TraderState,
  BIDS_OFFSET,
  FIFO_MARKET_OFFSET,
  asksOffset,
  tradersOffset,
} from "./state.js";
import { type Recorder, recordEvent } from "./recorder.js";
import { type Released, EXPIRED, KEEP_FUNDS, marketShape, reduceOrderInner } from "./book.js";
import { U64_MAX, addBaseLots, addQuoteLots, emptyTraderState, orderCmp, subBaseLots, subQuoteLots } from "./util.js";

/** Side, as OrderPacket carries it. */
export const BID: u8 = 0n;
export const ASK: u8 = 1n;
/** OrderPacket's variants. */
export const POST_ONLY: u8 = 0n;
export const LIMIT: u8 = 1n;
export const IMMEDIATE_OR_CANCEL: u8 = 2n;
/** SelfTradeBehavior. */
export const ABORT: u8 = 0n;
export const CANCEL_PROVIDE: u8 = 1n;
export const DECREMENT_TAKE: u8 = 2n;
/** `u32::MAX`: the trader index of a taker with no seat on the market. */
const NO_TRADER = 4294967295n;
/** `u64::MAX >> 1`: the order sequence number past which no order is placed. */
const MAX_SEQUENCE_NUMBER = 9223372036854775807n;

/**
 * An OrderPacket, flattened: every variant's fields, `kind` saying which (POST_ONLY, LIMIT, IMMEDIATE_OR_CANCEL) and
 * the `has_*` flags its Options. The fields a variant does not have stay zero (num_quote_lots of a PostOnly, …).
 */
export interface Packet {
  kind: u8;
  side: u8;
  /** An ImmediateOrCancel's price is an Option; the other variants always have one. */
  has_price: boolean;
  price_in_ticks: u64;
  num_base_lots: u64;
  num_quote_lots: u64;
  min_base_lots_to_fill: u64;
  min_quote_lots_to_fill: u64;
  self_trade_behavior: u8;
  has_match_limit: boolean;
  match_limit: u64;
  client_order_id: u128;
  reject_post_only: boolean;
  use_only_deposited_funds: boolean;
  has_last_valid_slot: boolean;
  last_valid_slot: u64;
  has_last_valid_unix_timestamp: boolean;
  last_valid_unix_timestamp_in_seconds: u64;
  fail_silently_on_insufficient_funds: boolean;
}

/** MatchingEngineResponse, and the id of the order that rested (place_order's `Option<FIFOOrderId>`). */
export interface Response {
  num_quote_lots_in: u64;
  num_base_lots_in: u64;
  num_quote_lots_out: u64;
  num_base_lots_out: u64;
  num_quote_lots_posted: u64;
  num_base_lots_posted: u64;
  num_free_quote_lots_used: u64;
  num_free_base_lots_used: u64;
  placed: boolean;
  placed_price_in_ticks: u64;
  placed_order_sequence_number: u64;
}

/** InflightOrder. The two Options of the original end as `unwrap_or(0)` in the resting order: 0 is None. */
export interface Inflight {
  side: u8;
  self_trade_behavior: u8;
  should_terminate: boolean;
  limit_price_in_ticks: u64;
  match_limit: u64;
  base_lot_budget: u64;
  adjusted_quote_lot_budget: u64;
  matched_base_lots: u64;
  matched_adjusted_quote_lots: u64;
  quote_lot_fees: u64;
  last_valid_slot: u64;
  last_valid_unix_timestamp_in_seconds: u64;
}

// ---- Quantities (quantities.rs) ----------------------------------------------------------------------------------

/** AdjustedQuoteLots + AdjustedQuoteLots (`basic_u64_struct!(AdjustedQuoteLots)`). */
function addAdjusted(a: u64, b: u64): u64 {
  return panicsAt("src/quantities.rs:257:1", a + b);
}

/** AdjustedQuoteLots - AdjustedQuoteLots. */
function subAdjusted(a: u64, b: u64): u64 {
  return panicsAt("src/quantities.rs:257:1", a - b);
}

/** QuoteLotsPerBaseUnitPerTick × Ticks = QuoteLotsPerBaseUnit, a price in quote lots per base unit. */
export function ticksToPrice(tickSize: u64, ticks: u64): u64 {
  return panicsAt("src/quantities.rs:287:1", tickSize * ticks);
}

/** QuoteLotsPerBaseUnit × BaseLots = AdjustedQuoteLots. */
export function adjustedQuoteLots(price: u64, baseLots: u64): u64 {
  return panicsAt("src/quantities.rs:293:1", price * baseLots);
}

/** QuoteLots × BaseLotsPerBaseUnit = AdjustedQuoteLots. */
function quoteLotsToAdjusted(quoteLots: u64, baseLotsPerBaseUnit: u64): u64 {
  return panicsAt("src/quantities.rs:290:1", quoteLots * baseLotsPerBaseUnit);
}

/** `ticks × tick size × lots / base lots per base unit`: the quote lots a resting order of `lots` at `ticks` locks. */
export function quoteLotsFor(ticks: u64, tickSize: u64, lots: u64, baseLotsPerBaseUnit: u64): u64 {
  return adjustedQuoteLots(ticksToPrice(tickSize, ticks), lots) / baseLotsPerBaseUnit;
}

/** compute_fee: the fee on `adjusted` rounded up, in u128 and cast back (`as u64`). */
function computeFee(adjusted: u64, feeBps: u64): u64 {
  if (feeBps === 0n) return 0n;
  // Below 2^48 × 2^16 the u128 product fits a u64 and the result is the same.
  if (adjusted < 281474976710656n && feeBps < 65536n) return (adjusted * feeBps + 9999n) / 10000n;
  return u64(((u128(adjusted) * u128(feeBps) + 9999n) / 10000n) & 18446744073709551615n);
}

/** adjusted_quote_lot_budget_post_fee_adjustment_for_buys: `adjusted × u64::MAX / (u64::MAX + fee(u64::MAX))`. */
function budgetForBuys(adjusted: u64, feeBps: u64): u64 {
  if (feeBps === 0n) return adjusted;
  const feeAdjustment = u128(computeFee(U64_MAX, feeBps)) + u128(U64_MAX);
  // Never above `adjusted`: it fits.
  return u64((u128(adjusted) * u128(U64_MAX)) / feeAdjustment);
}

/**
 * adjusted_quote_lot_budget_post_fee_adjustment_for_sells: `adjusted × u64::MAX / (u64::MAX - fee(u64::MAX))`, u64::MAX
 * when it does not fit (the `u64::try_from(..).ok()` that falls back to the maximum). A fee of 100% divides by zero.
 */
function budgetForSells(adjusted: u64, feeBps: u64): u64 {
  if (feeBps === 0n) return adjusted;
  const feeAdjustment = u128(U64_MAX) - u128(computeFee(U64_MAX, feeBps));
  const budget = panicsAt("src/state/markets/fifo.rs:646:23", (u128(adjusted) * u128(U64_MAX)) / feeAdjustment);
  return budget > u128(U64_MAX) ? U64_MAX : u64(budget);
}

/** RestingOrder::is_expired. */
function isExpired(o: FIFORestingOrder, slot: u64, unixTimestamp: u64): boolean {
  return (
    (o.last_valid_slot !== 0n && o.last_valid_slot < slot) ||
    (o.last_valid_unix_timestamp_in_seconds !== 0n && o.last_valid_unix_timestamp_in_seconds < unixTimestamp)
  );
}

/** Where `side`'s book starts. */
export function bookOffset(side: u8, bids: u64): u64 {
  return side === BID ? BIDS_OFFSET : asksOffset(bids);
}

// ---- Taking orders off (book.ts's reduce_order_inner) ---------------------------------------------------------------

/** An expired order met while matching, removed whole (reduce_order_inner, EXPIRED); the market's shape is read here. */
function removeExpired(
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  traderIndex: u32,
  price: u64,
  seq: u64,
  bid: boolean,
): boolean {
  const m = marketShape(rest);
  const none: Released = { quote: 0n, base: 0n };
  return reduceOrderInner(m, rest, rec, logData, traderIndex, price, seq, bid, false, 0n, EXPIRED, none);
}

/** The taker's own resting order in a self trade: cancelled, or reduced by `size`, without claiming its funds. */
function reduceOwn(
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  traderIndex: u32,
  price: u64,
  seq: u64,
  bid: boolean,
  hasSize: boolean,
  size: u64,
): boolean {
  const m = marketShape(rest);
  const none: Released = { quote: 0n, base: 0n };
  return reduceOrderInner(m, rest, rec, logData, traderIndex, price, seq, bid, hasSize, size, KEEP_FUNDS, none);
}

// ---- Crossing and eviction -------------------------------------------------------------------------------------------

/** check_for_cross's result: `crosses` and the price of the opposite order a PostOnly order would take. */
export interface Cross {
  crosses: boolean;
  price_in_ticks: u64;
}

/**
 * check_for_cross: whether a PostOnly order at `ticks` crosses the opposite book, and at which price (the best
 * unexpired order's). Expired orders met on the way are removed (ExpiredOrder events).
 */
function checkForCross(
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  side: u8,
  ticks: u64,
  slot: u64,
  unixTimestamp: u64,
): Cross {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  const n = h.market_size_params.bids_size;
  const opposite = side === BID ? ASK : BID;
  const book = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, bookOffset(opposite, n), n, orderCmp);
  for (;;) {
    const best = book.min();
    if (best === null) break;
    const price = best.key.price_in_ticks;
    if (opposite === BID ? price < ticks : price > ticks) break;
    const seq = best.key.order_sequence_number;
    if (best.value.num_base_lots > 0n) {
      if (!isExpired(best.value, slot, unixTimestamp)) return { crosses: true, price_in_ticks: price };
      if (!removeExpired(rest, rec, logData, u32(best.value.trader_index & 0xffffffffn), price, seq, opposite === BID)) break;
    } else {
      log("WARNING: Empty order found in check_for_cross");
      book.remove({ price_in_ticks: price, order_sequence_number: seq });
    }
  }
  return { crosses: false, price_in_ticks: 0n };
}

/**
 * evict_least_aggressive_order: the book's last order goes (an Evict event with its maker's key; its lots unlocked)
 * when the new order at `placedPrice` is more aggressive. Its result is not used: when nothing is evicted the insert
 * that follows finds the book full.
 */
function evictLeastAggressiveOrder(rest: RemainingAccounts, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>, side: u8, placedPrice: u64): void {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  const n = h.market_size_params.bids_size;
  const book = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, bookOffset(side, n), n, orderCmp);
  const last = book.max();
  if (last === null) return;
  const traders = rbTreeMutAt<Pubkey, TraderState>(market, tradersOffset(n), h.market_size_params.num_seats);
  const traderIndex = last.value.trader_index & 0xffffffffn;
  const makerId = traders.nodeAt(u32(traderIndex)).key;
  const price = last.key.price_in_ticks;
  const seq = last.key.order_sequence_number;
  const lots = last.value.num_base_lots;
  if (side === BID ? price >= placedPrice : price <= placedPrice) {
    log("New order is not aggressive enough to evict an existing order");
    return;
  }
  book.remove({ price_in_ticks: price, order_sequence_number: seq });
  recordEvent(rec, logData, rest, {
    kind: "Evict",
    index: u16(rec.eventsAdded),
    maker_id: makerId,
    order_sequence_number: seq,
    price_in_ticks: price,
    base_lots_evicted: lots,
  });
  const fifo = loadRawAt<FifoMarketPrefix>(market, FIFO_MARKET_OFFSET);
  const state = traders.nodeAt(u32(traderIndex)).value;
  if (side === BID) {
    const quoteLots = quoteLotsFor(price, fifo.tick_size_in_quote_lots_per_base_unit, lots, fifo.base_lots_per_base_unit);
    state.quote_lots_locked = subQuoteLots(state.quote_lots_locked, quoteLots);
    state.quote_lots_free = addQuoteLots(state.quote_lots_free, quoteLots);
  } else {
    state.base_lots_locked = subBaseLots(state.base_lots_locked, lots);
    state.base_lots_free = addBaseLots(state.base_lots_free, lots);
  }
}

// ---- Matching (match_order) -----------------------------------------------------------------------------------------

/**
 * match_order: take from the opposite book while the inflight order has budget, match limit and a crossing price.
 * Expired orders met are removed (ExpiredOrder) and count against the match limit, as self trades do (Abort fails the
 * match; CancelProvide cancels the resting order; DecrementTake reduces it and the budget). Each fill records a Fill
 * and pays the maker; the taker's fee is charged once on the total, rounded up to whole quote lots.
 */
/** @noinline */
function matchOrder(
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  o: Inout<Inflight>,
  currentTraderIndex: u64,
  slot: u64,
  unixTimestamp: u64,
): boolean {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  const n = h.market_size_params.bids_size;
  const opposite = o.side === BID ? ASK : BID;
  const offset = bookOffset(opposite, n);
  const fifo = loadRawMutAt<FifoMarketPrefix>(market, FIFO_MARKET_OFFSET);
  const tickSize = fifo.tick_size_in_quote_lots_per_base_unit;
  const baseLotsPerBaseUnit = fifo.base_lots_per_base_unit;
  const book = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, offset, n, orderCmp);
  const traders = rbTreeMutAt<Pubkey, TraderState>(market, tradersOffset(n), h.market_size_params.num_seats);
  const bidBook = opposite === BID;
  let total = 0n;
  while (o.base_lot_budget > 0n && o.adjusted_quote_lot_budget > 0n && o.match_limit > 0n && !o.should_terminate) {
    const best = book.min();
    if (best === null) {
      log("Book is empty");
      break;
    }
    const price = best.key.price_in_ticks;
    const seq = best.key.order_sequence_number;
    if (o.side === BID ? price > o.limit_price_in_ticks : price < o.limit_price_in_ticks) break;
    const quoted = best.value.num_base_lots;
    if (quoted === 0n) {
      // A tombstone (never left by v1): removed, and counted against the match limit.
      book.remove({ price_in_ticks: price, order_sequence_number: seq });
      o.match_limit -= 1n;
      continue;
    }
    const traderIndex = best.value.trader_index;
    if (isExpired(best.value, slot, unixTimestamp)) {
      if (!removeExpired(rest, rec, logData, u32(traderIndex & 0xffffffffn), price, seq, bidBook)) return false;
      o.match_limit -= 1n;
      continue;
    }

    if (traderIndex === currentTraderIndex) {
      if (o.self_trade_behavior === ABORT) return false;
      if (o.self_trade_behavior === CANCEL_PROVIDE) {
        if (!reduceOwn(rest, rec, logData, u32(currentTraderIndex), price, seq, bidBook, false, 0n)) return false;
        o.match_limit -= 1n;
      } else {
        // DecrementTake: the resting order and the budgets go down by what would have matched.
        let removed = o.adjusted_quote_lot_budget / ticksToPrice(tickSize, price);
        if (o.base_lot_budget < removed) removed = o.base_lot_budget;
        if (quoted < removed) removed = quoted;
        if (!reduceOwn(rest, rec, logData, u32(currentTraderIndex), price, seq, bidBook, true, removed)) return false;
        o.base_lot_budget = o.base_lot_budget > removed ? o.base_lot_budget - removed : 0n;
        const adjusted = adjustedQuoteLots(ticksToPrice(tickSize, price), removed);
        o.adjusted_quote_lot_budget = o.adjusted_quote_lot_budget > adjusted ? o.adjusted_quote_lot_budget - adjusted : 0n;
        o.match_limit -= 1n;
        o.should_terminate = removed < quoted;
      }
      continue;
    }

    const quotedAdjusted = adjustedQuoteLots(ticksToPrice(tickSize, price), quoted);
    let matchedBase = quoted;
    let matchedAdjusted = quotedAdjusted;
    let remaining = 0n;
    if (quoted <= o.base_lot_budget && quotedAdjusted <= o.adjusted_quote_lot_budget) {
      // The whole resting order.
      book.remove({ price_in_ticks: price, order_sequence_number: seq });
    } else {
      // What the budget allows; the match ends here.
      matchedBase = o.adjusted_quote_lot_budget / ticksToPrice(tickSize, price);
      if (o.base_lot_budget < matchedBase) matchedBase = o.base_lot_budget;
      matchedAdjusted = adjustedQuoteLots(ticksToPrice(tickSize, price), matchedBase);
      best.value.num_base_lots = subBaseLots(quoted, matchedBase);
      remaining = best.value.num_base_lots;
      o.should_terminate = true;
    }

    // InflightOrder::process_match.
    if (o.match_limit >= 1n) {
      o.base_lot_budget = subBaseLots(o.base_lot_budget, matchedBase);
      o.adjusted_quote_lot_budget = subAdjusted(o.adjusted_quote_lot_budget, matchedAdjusted);
      o.matched_base_lots = addBaseLots(o.matched_base_lots, matchedBase);
      o.matched_adjusted_quote_lots = addAdjusted(o.matched_adjusted_quote_lots, matchedAdjusted);
      o.match_limit -= 1n;
    }
    total = addAdjusted(total, matchedAdjusted);

    const makerIndex = u32(traderIndex & 0xffffffffn);
    if (matchedBase !== 0n) {
      recordEvent(rec, logData, rest, {
        kind: "Fill",
        index: u16(rec.eventsAdded),
        maker_id: traders.nodeAt(makerIndex).key,
        order_sequence_number: seq,
        price_in_ticks: price,
        base_lots_filled: matchedBase,
        base_lots_remaining: remaining,
      });
    } else if (!o.should_terminate) {
      log("WARNING: should_terminate should always be true if matched_base_lots is zero");
    }
    // The maker's side of the trade.
    const state = traders.nodeAt(makerIndex).value;
    const quoteLots = matchedAdjusted / baseLotsPerBaseUnit;
    if (o.side === BID) {
      state.base_lots_locked = subBaseLots(state.base_lots_locked, matchedBase);
      state.quote_lots_free = addQuoteLots(state.quote_lots_free, quoteLots);
    } else {
      state.quote_lots_locked = subQuoteLots(state.quote_lots_locked, quoteLots);
      state.base_lots_free = addBaseLots(state.base_lots_free, matchedBase);
    }
  }
  // The fee on the total, rounded up to a whole quote lot.
  o.quote_lot_fees = addAdjusted(computeFee(total, fifo.taker_fee_bps), baseLotsPerBaseUnit - 1n) / baseLotsPerBaseUnit;
  fifo.unclaimed_quote_lot_fees = addQuoteLots(fifo.unclaimed_quote_lot_fees, o.quote_lot_fees);
  return true;
}

// ---- Placing an order (place_order_inner) ---------------------------------------------------------------------------

/**
 * place_order_inner for `trader`: false where the Rust returns None (the caller fails with NewOrderError), true with
 * `resp` filled otherwise (an expired packet does nothing and is Some too). `pk` is the packet, which this may amend
 * (an ask's price raised to 1, a PostOnly moved off the opposite book).
 */
/** @noinline */
export function placeOrder(
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  trader: Pubkey,
  pk: Inout<Packet>,
  resp: Inout<Response>,
  slot: u64,
  unixTimestamp: u64,
): boolean {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  const n = h.market_size_params.bids_size;
  const seats = h.market_size_params.num_seats;
  const fifo = loadRawMutAt<FifoMarketPrefix>(market, FIFO_MARKET_OFFSET);
  if (fifo.order_sequence_number === 0n) {
    log("Market is uninitialized");
    return false;
  }
  if (fifo.order_sequence_number === MAX_SEQUENCE_NUMBER) {
    log("Sequence number exceeded maximum");
    return false;
  }
  const side = pk.side;
  const takeOnly = pk.kind === IMMEDIATE_OR_CANCEL;
  // get_price_in_ticks: an IOC without a price is a market order (u64::MAX to buy, 0 to sell).
  if (takeOnly && !pk.has_price) pk.price_in_ticks = side === BID ? U64_MAX : 0n;
  if (side === BID) {
    if (pk.price_in_ticks === 0n) {
      log("Bid price is too low");
      return false;
    }
  } else if (!takeOnly && pk.price_in_ticks === 0n) pk.price_in_ticks = 1n;

  const traders = rbTreeMutAt<Pubkey, TraderState>(market, tradersOffset(n), seats);
  let traderIndex = u64(traders.addrOf(trader));
  if (traderIndex === 0n) {
    if (takeOnly) traderIndex = NO_TRADER;
    else {
      // get_or_register_trader: None when the traders tree is full.
      const added = traders.insert(trader, emptyTraderState());
      if (added === null) return false;
      traderIndex = u64(added!);
    }
  }

  if (pk.num_base_lots === 0n && pk.num_quote_lots === 0n) {
    log("Either num_base_lots or num_quote_lots must be nonzero");
    return false;
  }
  if (takeOnly && pk.num_base_lots > 0n && pk.num_quote_lots > 0n) {
    log(
      `Invalid IOC params.\n                        Exactly one of num_base_lots or num_quote_lots must be nonzero.\n                        num_quote_lots: ${pk.num_quote_lots},\n                        num_base_lots: ${pk.num_base_lots}`,
    );
    return false;
  }
  if ((pk.has_last_valid_slot && slot > pk.last_valid_slot) || (pk.has_last_valid_unix_timestamp && unixTimestamp > pk.last_valid_unix_timestamp_in_seconds)) {
    log("Order parameters include a last_valid_slot or last_valid_unix_timestamp_in_seconds in the past, skipping matching and posting");
    return true;
  }
  const lastValidSlot = pk.has_last_valid_slot ? pk.last_valid_slot : 0n;
  const lastValidUnixTimestamp = pk.has_last_valid_unix_timestamp ? pk.last_valid_unix_timestamp_in_seconds : 0n;

  let restingLots = pk.num_base_lots;
  if (pk.kind === POST_ONLY) {
    const cross = checkForCross(rest, rec, logData, side, pk.price_in_ticks, slot, unixTimestamp);
    if (cross.crosses) {
      const ticks = cross.price_in_ticks;
      if (pk.reject_post_only) {
        log("PostOnly order crosses the book - order rejected");
        return false;
      }
      if (side === BID) {
        if (ticks <= 1n) {
          log("PostOnly order crosses the book and can not be amended to a valid price - order rejected");
          return false;
        }
        pk.price_in_ticks = ticks - 1n;
      } else pk.price_in_ticks = panicsAt("src/quantities.rs:237:1", ticks + 1n);
      log("PostOnly order crosses the book - order amended");
    }
  } else {
    // Budgets: base lots (u64::MAX when only quote lots are given), adjusted quote lots net of the fee.
    const baseLotBudget = pk.num_base_lots === 0n ? U64_MAX : pk.num_base_lots;
    let adjustedBudget = U64_MAX;
    if (pk.num_quote_lots !== 0n) {
      const adjusted = quoteLotsToAdjusted(pk.num_quote_lots, fifo.base_lots_per_base_unit);
      adjustedBudget = side === BID ? budgetForBuys(adjusted, fifo.taker_fee_bps) : budgetForSells(adjusted, fifo.taker_fee_bps);
    }
    const o: Inflight = {
      side,
      self_trade_behavior: pk.self_trade_behavior,
      should_terminate: false,
      limit_price_in_ticks: pk.price_in_ticks,
      match_limit: pk.has_match_limit ? pk.match_limit : U64_MAX,
      base_lot_budget: baseLotBudget,
      adjusted_quote_lot_budget: adjustedBudget,
      matched_base_lots: 0n,
      matched_adjusted_quote_lots: 0n,
      quote_lot_fees: 0n,
      last_valid_slot: lastValidSlot,
      last_valid_unix_timestamp_in_seconds: lastValidUnixTimestamp,
    };
    if (!matchOrder(rest, rec, logData, o, traderIndex, slot, unixTimestamp)) {
      log("Encountered error matching order");
      return false;
    }
    restingLots = o.base_lot_budget;
    const baseLotsPerBaseUnit = fifo.base_lots_per_base_unit;
    let matchedQuoteLots = 0n;
    if (side === BID) {
      // Rounded up to whole quote lots, plus the fee.
      matchedQuoteLots = addQuoteLots(addAdjusted(o.matched_adjusted_quote_lots, baseLotsPerBaseUnit - 1n) / baseLotsPerBaseUnit, o.quote_lot_fees);
      resp.num_quote_lots_in = matchedQuoteLots;
      resp.num_base_lots_out = o.matched_base_lots;
    } else {
      // Rounded down, less the fee.
      matchedQuoteLots = subQuoteLots(o.matched_adjusted_quote_lots / baseLotsPerBaseUnit, o.quote_lot_fees);
      resp.num_base_lots_in = o.matched_base_lots;
      resp.num_quote_lots_out = matchedQuoteLots;
    }
    recordEvent(rec, logData, rest, {
      kind: "FillSummary",
      index: u16(rec.eventsAdded),
      client_order_id: pk.client_order_id,
      total_base_lots_filled: o.matched_base_lots,
      total_quote_lots_filled: matchedQuoteLots,
      total_fee_in_quote_lots: o.quote_lot_fees,
    });
  }

  if (takeOnly) {
    // The minimum fill, or the order is void.
    const baseLots = addBaseLots(resp.num_base_lots_in, resp.num_base_lots_out);
    const quoteLots = addQuoteLots(resp.num_quote_lots_in, resp.num_quote_lots_out);
    if (baseLots < pk.min_base_lots_to_fill || quoteLots < pk.min_quote_lots_to_fill) {
      log(
        `IOC order failed to meet minimum fill requirements. \n                        min_base_lots_to_fill: ${pk.min_base_lots_to_fill},\n                        min_quote_lots_to_fill: ${pk.min_quote_lots_to_fill},\n                        matched_base_lots: ${baseLots},\n                        matched_quote_lots: ${quoteLots}`,
      );
      return false;
    }
  } else {
    const price = pk.price_in_ticks;
    const seqNumber = fifo.order_sequence_number;
    const seq = side === BID ? seqNumber ^ U64_MAX : seqNumber;
    // A Limit order still crossing the best unexpired, non-empty opposite order does not rest.
    let crosses = false;
    if (pk.kind === LIMIT) {
      const opposite = rbTreeAt<FIFOOrderId, FIFORestingOrder>(market, bookOffset(side === BID ? ASK : BID, n), n, orderCmp);
      let best = side === BID ? U64_MAX : 0n;
      for (const e of opposite) {
        if (!isExpired(e.value, slot, unixTimestamp) && e.value.num_base_lots > 0n) {
          best = e.key.price_in_ticks;
          break;
        }
      }
      crosses = side === BID ? price >= best : price <= best;
    }
    if (restingLots > 0n && !crosses) {
      resp.placed = true;
      resp.placed_price_in_ticks = price;
      resp.placed_order_sequence_number = seq;
      const own = rbTreeAt<FIFOOrderId, FIFORestingOrder>(market, bookOffset(side, n), n, orderCmp);
      if (own.length === n) {
        log("Book is full. Evicting order");
        evictLeastAggressiveOrder(rest, rec, logData, side, price);
      }
      const book = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, bookOffset(side, n), n, orderCmp);
      const inserted = book.insert(
        { price_in_ticks: price, order_sequence_number: seq },
        { trader_index: traderIndex, num_base_lots: restingLots, last_valid_slot: lastValidSlot, last_valid_unix_timestamp_in_seconds: lastValidUnixTimestamp },
      );
      if (inserted === null) {
        log("Failed to insert order into book");
        return false;
      }
      const state = traders.nodeAt(u32(traderIndex)).value;
      if (side === BID) {
        const quoteLots = quoteLotsFor(price, fifo.tick_size_in_quote_lots_per_base_unit, restingLots, fifo.base_lots_per_base_unit);
        const free = quoteLots < state.quote_lots_free ? quoteLots : state.quote_lots_free;
        state.quote_lots_free = subQuoteLots(state.quote_lots_free, free);
        state.quote_lots_locked = addQuoteLots(state.quote_lots_locked, quoteLots);
        resp.num_quote_lots_posted = addQuoteLots(resp.num_quote_lots_posted, quoteLots);
        resp.num_free_quote_lots_used = addQuoteLots(resp.num_free_quote_lots_used, free);
      } else {
        const free = restingLots < state.base_lots_free ? restingLots : state.base_lots_free;
        state.base_lots_free = subBaseLots(state.base_lots_free, free);
        state.base_lots_locked = addBaseLots(state.base_lots_locked, restingLots);
        resp.num_base_lots_posted = addBaseLots(resp.num_base_lots_posted, restingLots);
        resp.num_free_base_lots_used = addBaseLots(resp.num_free_base_lots_used, free);
      }
      recordEvent(rec, logData, rest, {
        kind: "Place",
        index: u16(rec.eventsAdded),
        order_sequence_number: seq,
        client_order_id: pk.client_order_id,
        price_in_ticks: price,
        base_lots_placed: restingLots,
      });
      if (lastValidSlot !== 0n || lastValidUnixTimestamp !== 0n) {
        recordEvent(rec, logData, rest, {
          kind: "TimeInForce",
          index: u16(rec.eventsAdded),
          order_sequence_number: seq,
          last_valid_slot: lastValidSlot,
          last_valid_unix_timestamp_in_seconds: lastValidUnixTimestamp,
        });
      }
      fifo.order_sequence_number = seqNumber + 1n;
    }
  }

  // A registered trader's free lots pay first.
  if (traderIndex !== NO_TRADER) {
    const state = traders.nodeAt(u32(traderIndex)).value;
    if (side === BID) {
      const quoteLots = addQuoteLots(resp.num_quote_lots_in, resp.num_quote_lots_out);
      const free = state.quote_lots_free < quoteLots ? state.quote_lots_free : quoteLots;
      state.quote_lots_free = subQuoteLots(state.quote_lots_free, free);
      resp.num_free_quote_lots_used = addQuoteLots(resp.num_free_quote_lots_used, free);
    } else {
      const baseLots = addBaseLots(resp.num_base_lots_in, resp.num_base_lots_out);
      const free = state.base_lots_free < baseLots ? state.base_lots_free : baseLots;
      state.base_lots_free = subBaseLots(state.base_lots_free, free);
      resp.num_free_base_lots_used = addBaseLots(resp.num_free_base_lots_used, free);
    }
    if (pk.use_only_deposited_funds) {
      // What the trade pays out stays on the market as free lots.
      if (side === BID) {
        state.base_lots_free = addBaseLots(state.base_lots_free, resp.num_base_lots_out);
        resp.num_base_lots_out = 0n;
      } else {
        state.quote_lots_free = addQuoteLots(state.quote_lots_free, resp.num_quote_lots_out);
        resp.num_quote_lots_out = 0n;
      }
      if (
        addBaseLots(resp.num_base_lots_in, resp.num_base_lots_posted) !== resp.num_free_base_lots_used ||
        addQuoteLots(resp.num_quote_lots_in, resp.num_quote_lots_posted) !== resp.num_free_quote_lots_used
      ) {
        log("Trader does not have enough deposited funds to process order");
        return false;
      }
      if (resp.num_base_lots_out !== 0n || resp.num_quote_lots_out !== 0n) {
        log("Matching engine response withdraws base or quote lots");
        return false;
      }
    }
  }
  return true;
}
