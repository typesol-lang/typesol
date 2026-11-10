// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// New orders (processor/new_order.rs): Swap and SwapWithFreeFunds (ImmediateOrCancel orders only), PlaceLimitOrder and
// PlaceLimitOrderWithFreeFunds (PostOnly and Limit orders), PlaceMultiplePostOnlyOrders and its free-funds form. Each
// checks its accounts, decodes its packet, runs the matching engine (matching.ts) and settles: the tokens the trade
// pays out leave the vaults and what it takes (and what rests) comes in, or, with free funds, everything stays on the
// market in the trader's TraderState.
//
// Accounts, after the entry's four (program, log authority, market, trader):
// - Swap: base account, quote account, base vault, quote vault, SPL Token;
// - SwapWithFreeFunds, PlaceLimitOrderWithFreeFunds, PlaceMultiplePostOnlyOrdersWithFreeFunds: seat;
// - PlaceLimitOrder, PlaceMultiplePostOnlyOrders: seat, then the five of Swap.
//
// The instructions that can rest orders return their ids (a Borsh Vec<FIFOOrderId>) as return data, which must be set
// after the recorder's last Log CPI: they finish the recorder themselves, and the entry returns after them.
import {
  type FixedVec,
  type InstructionBytes,
  type Inout,
  type Pubkey,
  type RemainingAccounts,
  type TokenProgram,
  ProgramError,
  currentSlot,
  fixedVec,
  loadRaw,
  loadRawAt,
  log,
  logComputeUnits,
  now,
  panicsAt,
  programAt,
  rbTreeAt,
  readData,
  require,
  setReturnData,
  u8,
  u32,
  u64,
  u128,
} from "typesol";
import { PhoenixError } from "./errors.js";
import { type FifoMarketPrefix, type MarketHeader, type TraderState, FIFO_MARKET_OFFSET, MARKET_STATUS_ACTIVE, tradersOffset } from "./state.js";
import { type Recorder, finishRecorder } from "./recorder.js";
import { assertCrossAllowed, assertPostAllowed, checkSeatWithContext, checkVaultContext, dispatchLoadedMarket, statusName } from "./checkers.js";
import { sendFromVault } from "./funds.js";
import { addBaseLots, addQuoteLots, baseLotsToAtoms, need, quoteLotsFor, quoteLotsToAtoms, subBaseLots, subQuoteLots } from "./util.js";
import { type Packet, type Response, ASK, BID, IMMEDIATE_OR_CANCEL, LIMIT, POST_ONLY, placeOrder } from "./matching.js";

/** A packet with every field zero (filled by the decoder or the multiple-order loop). */
function emptyPacket(): Packet {
  return {
    kind: 0n,
    side: 0n,
    has_price: false,
    price_in_ticks: 0n,
    num_base_lots: 0n,
    num_quote_lots: 0n,
    min_base_lots_to_fill: 0n,
    min_quote_lots_to_fill: 0n,
    self_trade_behavior: 0n,
    has_match_limit: false,
    match_limit: 0n,
    client_order_id: 0n,
    reject_post_only: false,
    use_only_deposited_funds: false,
    has_last_valid_slot: false,
    last_valid_slot: 0n,
    has_last_valid_unix_timestamp: false,
    last_valid_unix_timestamp_in_seconds: 0n,
    fail_silently_on_insufficient_funds: false,
  };
}

/** MatchingEngineResponse::default(), no order placed. */
function emptyResponse(): Response {
  return {
    num_quote_lots_in: 0n,
    num_base_lots_in: 0n,
    num_quote_lots_out: 0n,
    num_base_lots_out: 0n,
    num_quote_lots_posted: 0n,
    num_base_lots_posted: 0n,
    num_free_quote_lots_used: 0n,
    num_free_base_lots_used: 0n,
    placed: false,
    placed_price_in_ticks: 0n,
    placed_order_sequence_number: 0n,
  };
}

// ---- Decoding an OrderPacket (order_packet.rs decode_order_packet) -----------------------------------------------------

/** Byte `at` of the packet (the data after the tag) as decoded with zero padding: zero past the `real` bytes. */
function byteAt(data: InstructionBytes, real: u64, at: u64): u8 {
  return at < real ? data.readU8(1n + at) : 0n;
}

/** The u64 at `at`, its bytes past the `real` ones zero. */
function u64At(data: InstructionBytes, real: u64, at: u64): u64 {
  if (at + 8n <= real) return data.readU64(1n + at);
  let v = 0n;
  for (let i = 0n; i < 8n && at + i < real; i++) v |= u64(data.readU8(1n + at + i)) << (8n * i);
  return v;
}

/**
 * Borsh-decode the packet as if `pad` zero bytes followed the data: every field must fit and the bytes must be used up
 * exactly (try_from_slice); Options and booleans take 0 or 1 only, enum tags their variants'. False when it does not
 * decode.
 */
function decodeWith(data: InstructionBytes, pad: u64, pk: Inout<Packet>): boolean {
  const real = data.length - 1n;
  const end = real + pad;
  if (end < 2n) return false;
  const kind = byteAt(data, real, 0n);
  const side = byteAt(data, real, 1n);
  if (kind > 2n || side > 1n) return false;
  pk.kind = kind;
  pk.side = side;
  pk.has_price = true;
  pk.num_quote_lots = 0n;
  pk.min_base_lots_to_fill = 0n;
  pk.min_quote_lots_to_fill = 0n;
  pk.self_trade_behavior = 0n;
  pk.has_match_limit = false;
  pk.match_limit = 0n;
  pk.reject_post_only = false;
  pk.fail_silently_on_insufficient_funds = false;
  let at = 2n;
  if (kind === IMMEDIATE_OR_CANCEL) {
    // price_in_ticks: Option<Ticks>.
    if (at + 1n > end) return false;
    const tag = byteAt(data, real, at);
    if (tag > 1n) return false;
    at += 1n;
    pk.has_price = tag === 1n;
    pk.price_in_ticks = 0n;
    if (pk.has_price) {
      if (at + 8n > end) return false;
      pk.price_in_ticks = u64At(data, real, at);
      at += 8n;
    }
    if (at + 33n > end) return false;
    pk.num_base_lots = u64At(data, real, at);
    pk.num_quote_lots = u64At(data, real, at + 8n);
    pk.min_base_lots_to_fill = u64At(data, real, at + 16n);
    pk.min_quote_lots_to_fill = u64At(data, real, at + 24n);
    pk.self_trade_behavior = byteAt(data, real, at + 32n);
    if (pk.self_trade_behavior > 2n) return false;
    at += 33n;
  } else {
    if (at + 16n > end) return false;
    pk.price_in_ticks = u64At(data, real, at);
    pk.num_base_lots = u64At(data, real, at + 8n);
    at += 16n;
    if (kind === LIMIT) {
      if (at + 1n > end) return false;
      pk.self_trade_behavior = byteAt(data, real, at);
      if (pk.self_trade_behavior > 2n) return false;
      at += 1n;
    }
  }
  if (kind !== POST_ONLY) {
    // match_limit: Option<u64>.
    if (at + 1n > end) return false;
    const tag = byteAt(data, real, at);
    if (tag > 1n) return false;
    at += 1n;
    pk.has_match_limit = tag === 1n;
    if (pk.has_match_limit) {
      if (at + 8n > end) return false;
      pk.match_limit = u64At(data, real, at);
      at += 8n;
    }
  }
  // client_order_id: u128.
  if (at + 16n > end) return false;
  pk.client_order_id = (u128(u64At(data, real, at + 8n)) << 64n) | u128(u64At(data, real, at));
  at += 16n;
  if (kind === POST_ONLY) {
    if (at + 1n > end) return false;
    const reject = byteAt(data, real, at);
    if (reject > 1n) return false;
    pk.reject_post_only = reject === 1n;
    at += 1n;
  }
  if (at + 1n > end) return false;
  const deposited = byteAt(data, real, at);
  if (deposited > 1n) return false;
  pk.use_only_deposited_funds = deposited === 1n;
  at += 1n;
  // last_valid_slot, last_valid_unix_timestamp_in_seconds: Option<u64>.
  if (at + 1n > end) return false;
  const slotTag = byteAt(data, real, at);
  if (slotTag > 1n) return false;
  at += 1n;
  pk.has_last_valid_slot = slotTag === 1n;
  pk.last_valid_slot = 0n;
  if (pk.has_last_valid_slot) {
    if (at + 8n > end) return false;
    pk.last_valid_slot = u64At(data, real, at);
    at += 8n;
  }
  if (at + 1n > end) return false;
  const timeTag = byteAt(data, real, at);
  if (timeTag > 1n) return false;
  at += 1n;
  pk.has_last_valid_unix_timestamp = timeTag === 1n;
  pk.last_valid_unix_timestamp_in_seconds = 0n;
  if (pk.has_last_valid_unix_timestamp) {
    if (at + 8n > end) return false;
    pk.last_valid_unix_timestamp_in_seconds = u64At(data, real, at);
    at += 8n;
  }
  if (kind !== IMMEDIATE_OR_CANCEL) {
    if (at + 1n > end) return false;
    const silent = byteAt(data, real, at);
    if (silent > 1n) return false;
    pk.fail_silently_on_insufficient_funds = silent === 1n;
    at += 1n;
  }
  return at === end;
}

/**
 * decode_order_packet: the data as it is, else with the three trailing fields an older client left out padded with
 * zeros (three, then two, then one zero byte), the first that decodes. None fails with InvalidInstructionData.
 */
function decodeOrderPacket(data: InstructionBytes, pk: Inout<Packet>): void {
  if (decodeWith(data, 0n, pk) || decodeWith(data, 3n, pk) || decodeWith(data, 2n, pk) || decodeWith(data, 1n, pk)) return;
  log("Failed to decode order packet");
  require(false, ProgramError.InvalidInstructionData);
}

// ---- Funds (get_available_balances_for_trader, order_packet_has_sufficient_funds) --------------------------------------

/** A trader's lots available for orders: free on the market, plus what its token accounts hold when they are passed. */
export interface Available {
  base_lots: u64;
  quote_lots: u64;
}

/** get_available_balances_for_trader: TraderNotFound for a trader with no state on the market. */
function availableBalances(rest: RemainingAccounts, vaults: u64): Available {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  const traders = rbTreeAt<Pubkey, TraderState>(market, tradersOffset(h.market_size_params.bids_size), h.market_size_params.num_seats);
  const index = traders.addrOf(rest.get(3n).key);
  require(index !== 0n, PhoenixError.TraderNotFound);
  const state = traders.nodeAt(index).value;
  if (vaults === 0n) return { base_lots: state.base_lots_free, quote_lots: state.quote_lots_free };
  const quoteAtoms = readData<u64>(rest.get(vaults + 1n), 64n);
  const baseAtoms = readData<u64>(rest.get(vaults), 64n);
  return {
    base_lots: addBaseLots(state.base_lots_free, baseAtoms / h.base_lot_size),
    quote_lots: addQuoteLots(state.quote_lots_free, quoteAtoms / h.quote_lot_size),
  };
}

/** order_packet_has_sufficient_funds: the lots a post needs (asks: base lots; bids: quote lots at its price), logged when short. */
function hasSufficientFunds(rest: RemainingAccounts, pk: Inout<Packet>, baseLots: u64, quoteLots: u64): boolean {
  if (pk.side === ASK) {
    if (baseLots < pk.num_base_lots) {
      log(`Insufficient funds to place order: ${baseLots} base lots available, ${pk.num_base_lots} base lots required`);
      return false;
    }
    return true;
  }
  const fifo = loadRawAt<FifoMarketPrefix>(rest.get(2n), FIFO_MARKET_OFFSET);
  const required = quoteLotsFor(pk.price_in_ticks, fifo.tick_size_in_quote_lots_per_base_unit, pk.num_base_lots, fifo.base_lots_per_base_unit);
  if (quoteLots < required) {
    log(`Insufficient funds to place order: ${quoteLots} quote lots available, ${required} quote lots required`);
    return false;
  }
  return true;
}

// ---- One order (process_new_order) ---------------------------------------------------------------------------------

/**
 * process_new_order: the order matched and placed for the signer (a fail-silent order with too little funds does
 * nothing), then settled. `vaults` is the position of the vault context's first account (the base account), 0 when
 * the instruction uses free funds only. `resp` gets the engine's response, its placed order id included.
 */
/** @noinline */
function processNewOrder(
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  pk: Inout<Packet>,
  resp: Inout<Response>,
  vaults: u64,
): void {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  const quoteLotSize = h.quote_lot_size;
  const baseLotSize = h.base_lot_size;
  const slot = currentSlot();
  const unixTimestamp = u64(now());
  dispatchLoadedMarket(market);
  if (pk.fail_silently_on_insufficient_funds) {
    const available = availableBalances(rest, vaults);
    if (!hasSufficientFunds(rest, pk, available.base_lots, available.quote_lots)) return;
  }
  require(placeOrder(rest, rec, logData, rest.get(3n).key, pk, resp, slot, unixTimestamp), PhoenixError.NewOrderError);

  const quoteOut = quoteLotsToAtoms(resp.num_quote_lots_out, quoteLotSize);
  const quoteIn = quoteLotsToAtoms(subQuoteLots(addQuoteLots(resp.num_quote_lots_in, resp.num_quote_lots_posted), resp.num_free_quote_lots_used), quoteLotSize);
  const baseOut = baseLotsToAtoms(resp.num_base_lots_out, baseLotSize);
  const baseIn = baseLotsToAtoms(subBaseLots(addBaseLots(resp.num_base_lots_in, resp.num_base_lots_posted), resp.num_free_base_lots_used), baseLotSize);
  if ((quoteOut > 0n || baseOut > 0n) && h.status !== MARKET_STATUS_ACTIVE) {
    log(`Market is not active, market status is ${statusName(h.status)}. \nsrc/program/processor/new_order.rs:436:9`);
    require(false, ProgramError.InvalidAccountData);
  }
  if (!pk.use_only_deposited_funds) {
    const token = programAt<TokenProgram>(rest.get(vaults + 4n));
    if (pk.side === BID) {
      sendFromVault(token, market.key, h.base_params.mint_key, h.base_params.vault_bump, rest.get(vaults + 2n), rest.get(vaults), baseOut);
      if (quoteIn > 0n) token.transfer(rest.get(vaults + 1n), rest.get(vaults + 3n), rest.get(3n), quoteIn);
    } else {
      sendFromVault(token, market.key, h.quote_params.mint_key, h.quote_params.vault_bump, rest.get(vaults + 3n), rest.get(vaults + 1n), quoteOut);
      if (baseIn > 0n) token.transfer(rest.get(vaults), rest.get(vaults + 2n), rest.get(3n), baseIn);
    }
  } else if (quoteIn > 0n || baseIn > 0n) {
    log("WARNING: Deposited amount of funds were insufficient to execute the order");
    require(false, ProgramError.InsufficientFunds);
  }
}

/** The return data of one order: a Borsh Vec<FIFOOrderId> of the order that rested, after the recorder's last CPI. */
function finishWithOrderId(rest: RemainingAccounts, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>, resp: Inout<Response>): void {
  finishRecorder(rec, logData, rest);
  if (!resp.placed) return;
  const ids: FixedVec<u8, 20> = fixedVec([]);
  ids.pushLE<u32>(1n);
  ids.pushLE(resp.placed_price_in_ticks);
  ids.pushLE(resp.placed_order_sequence_number);
  setReturnData(ids);
}

/** `assert_with_msg(cond, InvalidInstructionData, msg)`: `msg` carries its location. */
function check(cond: boolean, msg: string): void {
  if (!cond) {
    log(msg);
    require(false, ProgramError.InvalidInstructionData);
  }
}

/** Tag 0: an IOC or FOK order paid from (and paid out to) the trader's token accounts. */
export function swap(rest: RemainingAccounts, data: InstructionBytes, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>): void {
  logComputeUnits();
  const market = rest.get(2n);
  // NewOrderContext::load_cross_only (no seat; the vault context).
  assertCrossAllowed(market);
  checkVaultContext(rest, 4n, market, rest.get(3n).key);
  const pk = emptyPacket();
  decodeOrderPacket(data, pk);
  // ("Too many accounts" is checked on a seat this context never has.)
  check(pk.kind === IMMEDIATE_OR_CANCEL, "Order type must be IOC or FOK. \nsrc/program/processor/new_order.rs:158:5");
  check(!pk.use_only_deposited_funds, "Instruction does not allow using deposited funds. \nsrc/program/processor/new_order.rs:163:5");
  const resp = emptyResponse();
  processNewOrder(rest, rec, logData, pk, resp, 4n);
}

/** Tag 1: an IOC or FOK order on the trader's free funds (a seat needed). */
export function swapWithFreeFunds(rest: RemainingAccounts, data: InstructionBytes, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>): void {
  const market = rest.get(2n);
  assertCrossAllowed(market);
  need(rest, 5n);
  checkSeatWithContext(rest.get(4n), market.key, rest.get(3n).key, true);
  const pk = emptyPacket();
  decodeOrderPacket(data, pk);
  check(pk.kind === IMMEDIATE_OR_CANCEL, "Order type must be IOC or FOK. \nsrc/program/processor/new_order.rs:199:5");
  check(pk.use_only_deposited_funds, "Order must be set to use only deposited funds. \nsrc/program/processor/new_order.rs:204:5");
  const resp = emptyResponse();
  processNewOrder(rest, rec, logData, pk, resp, 0n);
}

/** Tag 2: a PostOnly or Limit order with token accounts. Finishes the recorder; the entry returns after it. */
export function placeLimitOrder(rest: RemainingAccounts, data: InstructionBytes, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>): void {
  const market = rest.get(2n);
  // NewOrderContext::load_post_allowed: the seat, then the vault context.
  assertPostAllowed(market);
  need(rest, 5n);
  checkSeatWithContext(rest.get(4n), market.key, rest.get(3n).key, true);
  checkVaultContext(rest, 5n, market, rest.get(3n).key);
  const pk = emptyPacket();
  decodeOrderPacket(data, pk);
  check(pk.kind !== IMMEDIATE_OR_CANCEL, "Order type must be Limit or PostOnly. \nsrc/program/processor/new_order.rs:239:5");
  check(!pk.use_only_deposited_funds, "Instruction does not allow using deposited funds. \nsrc/program/processor/new_order.rs:244:5");
  const resp = emptyResponse();
  processNewOrder(rest, rec, logData, pk, resp, 5n);
  finishWithOrderId(rest, rec, logData, resp);
}

/** Tag 3: a PostOnly or Limit order on free funds. Finishes the recorder; the entry returns after it. */
export function placeLimitOrderWithFreeFunds(rest: RemainingAccounts, data: InstructionBytes, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>): void {
  const market = rest.get(2n);
  assertPostAllowed(market);
  need(rest, 5n);
  checkSeatWithContext(rest.get(4n), market.key, rest.get(3n).key, true);
  const pk = emptyPacket();
  decodeOrderPacket(data, pk);
  check(pk.kind !== IMMEDIATE_OR_CANCEL, "Order type must be Limit or PostOnly. \nsrc/program/processor/new_order.rs:280:5");
  check(pk.use_only_deposited_funds, "Order must be set to use only deposited funds. \nsrc/program/processor/new_order.rs:285:5");
  const resp = emptyResponse();
  processNewOrder(rest, rec, logData, pk, resp, 0n);
  finishWithOrderId(rest, rec, logData, resp);
}

// ---- Many PostOnly orders (process_multiple_new_orders) ----------------------------------------------------------------

/** The most CondensedOrders a transaction can carry (18 bytes each at least, in at most 1232). */
const MAX_CONDENSED = 72n;

/**
 * One side's orders sorted best first, stably, as `sorted_by` sorts them (bids by price descending, asks ascending):
 * `prices` and `starts` (where each order's bytes start) move together. A side already in order stays as it is and
 * one in strictly the opposite order is reversed (the runs the standard library's merge sort finds first); anything
 * else is sorted by insertion.
 */
function sortSide(prices: Inout<FixedVec<u64, 72>>, starts: Inout<FixedVec<u64, 72>>, first: u64, last: u64, descending: boolean): void {
  let ordered = true;
  let reversed = true;
  for (let i = first + 1n; i < last; i++) {
    const before = prices.get(i - 1n);
    const p = prices.get(i);
    if (descending ? before < p : before > p) ordered = false;
    if (descending ? before >= p : before <= p) reversed = false;
  }
  if (ordered) return;
  if (reversed) {
    let i = first;
    let j = last - 1n;
    while (i < j) {
      const p = prices.get(i);
      const s = starts.get(i);
      prices.set(i, prices.get(j));
      starts.set(i, starts.get(j));
      prices.set(j, p);
      starts.set(j, s);
      i++;
      j--;
    }
    return;
  }
  for (let i = first + 1n; i < last; i++) {
    const p = prices.get(i);
    const s = starts.get(i);
    let j = i;
    while (j > first && (descending ? prices.get(j - 1n) < p : prices.get(j - 1n) > p)) {
      prices.set(j, prices.get(j - 1n));
      starts.set(j, starts.get(j - 1n));
      j--;
    }
    prices.set(j, p);
    starts.set(j, s);
  }
}

/** Whether the CondensedOrders at `a` and `b` have the same (price, last_valid_slot, last_valid_unix_timestamp). */
function sameLevel(data: InstructionBytes, a: u64, b: u64): boolean {
  if (data.readU64(a) !== data.readU64(b)) return false;
  // Option<u64> ‖ Option<u64> from byte 16: equal when the tags and the values they carry are.
  let pa = a + 16n;
  let pb = b + 16n;
  for (let i = 0n; i < 2n; i++) {
    const ta = data.readU8(pa);
    if (ta !== data.readU8(pb)) return false;
    if (ta === 1n) {
      if (data.readU64(pa + 1n) !== data.readU64(pb + 1n)) return false;
      pa += 9n;
      pb += 9n;
    } else {
      pa += 1n;
      pb += 1n;
    }
  }
  return true;
}

/** Tag 16: PostOnly orders with token accounts. Finishes the recorder; the entry returns after it. */
export function placeMultiplePostOnlyOrders(rest: RemainingAccounts, data: InstructionBytes, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>): void {
  multiplePostOnlyOrders(rest, data, rec, logData, false);
}

/** Tag 17: PostOnly orders on free funds. Finishes the recorder; the entry returns after it. */
export function placeMultiplePostOnlyOrdersWithFreeFunds(
  rest: RemainingAccounts,
  data: InstructionBytes,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
): void {
  multiplePostOnlyOrders(rest, data, rec, logData, true);
}

/**
 * process_place_multiple_post_only_orders (tags 16 and 17): MultipleOrderPacket { bids, asks, client_order_id,
 * failed_multiple_limit_order_behavior }. Each side is sorted best first (stably) and the orders of one level (price,
 * last valid slot and timestamp, adjacent after the sort) are merged into one PostOnly order. Finishes the recorder and
 * returns the ids of the orders that rested.
 */
/** @noinline */
function multiplePostOnlyOrders(
  rest: RemainingAccounts,
  data: InstructionBytes,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  freeFunds: boolean,
): void {
  const market = rest.get(2n);
  const trader = rest.get(3n);
  assertPostAllowed(market);
  need(rest, 5n);
  checkSeatWithContext(rest.get(4n), market.key, trader.key, true);
  if (!freeFunds) checkVaultContext(rest, 5n, market, trader.key);

  // MultipleOrderPacket::try_from_slice: where each CondensedOrder starts, bids then asks.
  const starts: FixedVec<u64, 72> = fixedVec([]);
  const prices: FixedVec<u64, 72> = fixedVec([]);
  let at = 1n;
  let bidCount = 0n;
  for (let side = 0n; side < 2n; side++) {
    require(at + 4n <= data.length, ProgramError.BorshIoError);
    const count = u64(data.readU32(at));
    at += 4n;
    for (let i = 0n; i < count; i++) {
      require(at + 17n <= data.length, ProgramError.BorshIoError);
      if (starts.length === MAX_CONDENSED) require(false, ProgramError.BorshIoError);
      starts.push(at);
      prices.push(data.readU64(at));
      at += 16n;
      for (let f = 0n; f < 2n; f++) {
        require(at + 1n <= data.length, ProgramError.BorshIoError);
        const tag = data.readU8(at);
        require(tag <= 1n, ProgramError.BorshIoError);
        at += tag === 1n ? 9n : 1n;
        require(at <= data.length, ProgramError.BorshIoError);
      }
    }
    if (side === 0n) bidCount = count;
  }
  require(at + 1n <= data.length, ProgramError.BorshIoError);
  const idTag = data.readU8(at);
  require(idTag <= 1n, ProgramError.BorshIoError);
  at += 1n;
  let clientOrderId: u128 = 0n;
  if (idTag === 1n) {
    require(at + 16n <= data.length, ProgramError.BorshIoError);
    clientOrderId = data.readU128(at);
    at += 16n;
  }
  require(at + 1n === data.length, ProgramError.BorshIoError);
  const behavior = data.readU8(at);
  require(behavior <= 3n, ProgramError.BorshIoError);
  // FailOnInsufficientFundsAndFailOnCross (1), SkipOnInsufficientFundsAndFailOnCross (3) reject crossing orders; the
  // Skip… behaviors (2, 3) skip orders the trader cannot fund.
  const failOnCross = behavior === 1n || behavior === 3n;
  const skip = behavior >= 2n;

  let highestBid = 0n;
  let lowestAsk = 18446744073709551615n;
  for (let i = 0n; i < prices.length; i++) {
    const price = prices.get(i);
    if (i < bidCount) {
      if (price > highestBid) highestBid = price;
    } else if (price < lowestAsk) lowestAsk = price;
  }
  if (highestBid >= lowestAsk) {
    log("Invalid input. MultipleOrderPacket contains crossing bids and asks");
    require(false, ProgramError.InvalidArgument);
  }

  const h = loadRaw<MarketHeader>(market);
  const quoteLotSize = h.quote_lot_size;
  const baseLotSize = h.base_lot_size;
  const slot = currentSlot();
  const unixTimestamp = u64(now());
  dispatchLoadedMarket(market);
  const available = availableBalances(rest, freeFunds ? 0n : 5n);
  let baseAvailable = available.base_lots;
  let quoteAvailable = available.quote_lots;
  let quoteToDeposit = 0n;
  let baseToDeposit = 0n;
  const ids: FixedVec<u8, 1028> = fixedVec([]);
  ids.pushLE<u32>(0n);
  let placed = 0n;

  for (let side = 0n; side < 2n; side++) {
    const first = side === 0n ? 0n : bidCount;
    const last = side === 0n ? bidCount : starts.length;
    sortSide(prices, starts, first, last, side === 0n);
    let i = first;
    while (i < last) {
      // One level: the adjacent orders with its price and time in force, their sizes summed.
      const s = starts.get(i);
      const price = prices.get(i);
      let size = data.readU64(s + 8n);
      let k = i + 1n;
      while (k < last && sameLevel(data, s, starts.get(k))) {
        size = panicsAt("src/program/processor/new_order.rs:590:67", size + data.readU64(starts.get(k) + 8n));
        k++;
      }
      i = k;
      const pk = emptyPacket();
      pk.kind = POST_ONLY;
      pk.side = u8(side);
      pk.price_in_ticks = price;
      pk.num_base_lots = size;
      pk.client_order_id = clientOrderId;
      pk.reject_post_only = failOnCross;
      pk.use_only_deposited_funds = freeFunds;
      let t = s + 16n;
      pk.has_last_valid_slot = data.readU8(t) === 1n;
      if (pk.has_last_valid_slot) {
        pk.last_valid_slot = data.readU64(t + 1n);
        t += 9n;
      } else t += 1n;
      pk.has_last_valid_unix_timestamp = data.readU8(t) === 1n;
      if (pk.has_last_valid_unix_timestamp) pk.last_valid_unix_timestamp_in_seconds = data.readU64(t + 1n);
      pk.fail_silently_on_insufficient_funds = skip;
      if (skip && !hasSufficientFunds(rest, pk, baseAvailable, quoteAvailable)) continue;
      const resp = emptyResponse();
      require(placeOrder(rest, rec, logData, trader.key, pk, resp, slot, unixTimestamp), PhoenixError.NewOrderError);
      if (resp.placed) {
        ids.pushLE(resp.placed_price_in_ticks);
        ids.pushLE(resp.placed_order_sequence_number);
        placed++;
      }
      const quoteDeposited = subQuoteLots(addQuoteLots(resp.num_quote_lots_in, resp.num_quote_lots_posted), resp.num_free_quote_lots_used);
      const baseDeposited = subBaseLots(addBaseLots(resp.num_base_lots_in, resp.num_base_lots_posted), resp.num_free_base_lots_used);
      if (skip) {
        quoteAvailable = subQuoteLots(quoteAvailable, addQuoteLots(quoteDeposited, resp.num_free_quote_lots_used));
        baseAvailable = subBaseLots(baseAvailable, addBaseLots(baseDeposited, resp.num_free_base_lots_used));
      }
      quoteToDeposit = addQuoteLots(quoteToDeposit, quoteDeposited);
      baseToDeposit = addBaseLots(baseToDeposit, baseDeposited);
    }
  }

  if (!freeFunds) {
    const token = programAt<TokenProgram>(rest.get(9n));
    if (bidCount > 0n) {
      const atoms = quoteLotsToAtoms(quoteToDeposit, quoteLotSize);
      if (atoms > 0n) token.transfer(rest.get(6n), rest.get(8n), trader, atoms);
    } else if (quoteToDeposit !== 0n) {
      log("WARNING: Expected quote_lots_to_deposit to be zero. \nsrc/program/processor/new_order.rs:671:17");
      require(false, PhoenixError.NewOrderError);
    }
    if (starts.length > bidCount) {
      const atoms = baseLotsToAtoms(baseToDeposit, baseLotSize);
      if (atoms > 0n) token.transfer(rest.get(5n), rest.get(7n), trader, atoms);
    } else if (baseToDeposit !== 0n) {
      log("WARNING: Expected base_lots_to_deposit to be zero. \nsrc/program/processor/new_order.rs:686:17");
      require(false, PhoenixError.NewOrderError);
    }
  } else if (baseToDeposit > 0n || quoteToDeposit > 0n) {
    log("Deposited amount of funds were insufficient to execute the order");
    require(false, ProgramError.InsufficientFunds);
  }

  finishRecorder(rec, logData, rest);
  if (placed > 0n) {
    ids.setLE(0n, u32(placed));
    setReturnData(ids);
  }
}
