// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// Reducing and cancelling orders (processor/reduce_order.rs, processor/cancel_multiple_orders.rs) and the authority's
// ForceCancelOrders and EvictSeat (processor/governance.rs). The order book work is book.ts's.
//
// Each reduce and cancel instruction comes in two forms: the plain one sends what the orders held back to the
// trader's token accounts (CancelOrWithdrawContext: the market must allow reductions, then the vault context), the
// WithFreeFunds one leaves it in the trader's free funds on the market and takes no accounts past the entry's four
// (and makes no status check). Phoenix logs the compute units left (sol_log_compute_units) around the book work.
//
// Accounts, after the entry's four (program, log authority, market, signer):
// - ReduceOrder, CancelAllOrders, CancelUpTo, CancelMultipleOrdersById: base account, quote account, base vault,
//   quote vault, SPL Token (the signer is the trader);
// - ForceCancelOrders, EvictSeat (the signer is the market authority): the trader, its seat (not approved), then the
//   trader's base and quote accounts, the vaults and SPL Token.
import { type FixedVec, type Inout, type InstructionBytes, type RemainingAccounts, type u8, ProgramError, log, logComputeUnits, require, u64 } from "typesol";
import { PhoenixError } from "./errors.js";
import { type Recorder } from "./recorder.js";
import { assertReduceAllowed, assertValidAuthority, checkSeatWithContext, checkVaultContext, dispatchLoadedMarket } from "./checkers.js";
import { processWithdraw } from "./funds.js";
import {
  type CancelUpTo,
  type Released,
  cancelAllInner,
  cancelByIdInner,
  cancelUpToInner,
  marketShape,
  reduceOrderInner,
  traderIndexOf,
  withdrawReleased,
} from "./book.js";
import { need } from "./util.js";

/** Where the vault context starts for the trader's own instructions. */
const TRADER_VAULTS = 4n;
/** Where it starts for the authority's (after the trader and its seat). */
const AUTHORIZED_VAULTS = 6n;

/** CancelOrWithdrawContext::load: reductions allowed, then the trader's vault context. */
function loadCancelContext(rest: RemainingAccounts): void {
  const market = rest.get(2n);
  assertReduceAllowed(market);
  checkVaultContext(rest, TRADER_VAULTS, market, rest.get(3n).key);
}

/**
 * AuthorizedActionContext::load: the signer is the market's authority, then the trader (any account), its seat (owned
 * by Phoenix, at its PDA, not approved) and the trader's vault context.
 */
function loadAuthorizedContext(rest: RemainingAccounts): void {
  const market = rest.get(2n);
  assertValidAuthority(market, rest.get(3n).key);
  need(rest, 5n);
  const trader = rest.get(4n).key;
  need(rest, 6n);
  checkSeatWithContext(rest.get(5n), market.key, trader, false);
  checkVaultContext(rest, AUTHORIZED_VAULTS, market, trader);
}

/**
 * The end of every reduce and cancel: the plain forms send what was released to the trader. (The WithFreeFunds forms
 * then assert that nothing was released, "WARNING: num_quote_lots_out must be 0", which cannot fail: without a claim
 * reduce_order_inner releases nothing.)
 */
function finish(rest: RemainingAccounts, withdraw: boolean, vaults: u64, released: Released): void {
  if (withdraw) withdrawReleased(rest, vaults, released);
}

/**
 * Tags 4 (ReduceOrder) and 5 (ReduceOrderWithFreeFunds): ReduceOrderParams { base_params: CancelOrderParams { side,
 * price_in_ticks, order_sequence_number }, size } after the tag. The side picks the book; the order is the trader's
 * or the instruction fails (ReduceOrderError, as for a trader with no state on the market); an order that is not
 * there reduces nothing.
 */
export function reduceOrder(
  rest: RemainingAccounts,
  data: InstructionBytes,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  withdraw: boolean,
): void {
  logComputeUnits();
  require(data.length === 26n && data.readU8(1n) <= 1n, ProgramError.BorshIoError);
  if (withdraw) loadCancelContext(rest);
  const market = rest.get(2n);
  dispatchLoadedMarket(market);
  logComputeUnits();
  const m = marketShape(rest);
  const traderIndex = traderIndexOf(m, rest, rest.get(3n).key);
  require(traderIndex !== 0n, PhoenixError.ReduceOrderError);
  const released: Released = { quote: 0n, base: 0n };
  const ok = reduceOrderInner(
    m,
    rest,
    rec,
    logData,
    traderIndex,
    data.readU64(2n),
    data.readU64(10n),
    data.readU8(1n) === 0n,
    true,
    data.readU64(18n),
    false,
    withdraw,
    released,
  );
  require(ok, PhoenixError.ReduceOrderError);
  logComputeUnits();
  finish(rest, withdraw, TRADER_VAULTS, released);
}

/** Tags 6 (CancelAllOrders) and 7 (CancelAllOrdersWithFreeFunds): no arguments (any data after the tag is ignored). */
export function cancelAllOrders(rest: RemainingAccounts, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>, withdraw: boolean): void {
  if (withdraw) loadCancelContext(rest);
  dispatchLoadedMarket(rest.get(2n));
  logComputeUnits();
  const released: Released = { quote: 0n, base: 0n };
  // A trader with no state on the market cancels nothing (unwrap_or_default).
  const m = marketShape(rest);
  const traderIndex = traderIndexOf(m, rest, rest.get(3n).key);
  if (traderIndex !== 0n) cancelAllInner(m, rest, rec, logData, traderIndex, withdraw, released);
  logComputeUnits();
  finish(rest, withdraw, TRADER_VAULTS, released);
}

/** CancelUpToParams { side, tick_limit: Option<u64>, num_orders_to_search: Option<u32>, num_orders_to_cancel: Option<u32> } after the tag. */
function decodeCancelUpTo(data: InstructionBytes): CancelUpTo {
  const p: CancelUpTo = { bid: false, hasTick: false, tick: 0n, hasSearch: false, search: 0n, hasCancel: false, cancel: 0n };
  require(data.length >= 3n && data.readU8(1n) <= 1n && data.readU8(2n) <= 1n, ProgramError.BorshIoError);
  p.bid = data.readU8(1n) === 0n;
  let at = 3n;
  if (data.readU8(2n) === 1n) {
    require(data.length >= 11n, ProgramError.BorshIoError);
    p.hasTick = true;
    p.tick = data.readU64(3n);
    at = 11n;
  }
  require(data.length > at && data.readU8(at) <= 1n, ProgramError.BorshIoError);
  if (data.readU8(at) === 1n) {
    require(data.length >= at + 5n, ProgramError.BorshIoError);
    p.hasSearch = true;
    p.search = data.readU32(at + 1n);
    at += 4n;
  }
  at++;
  require(data.length > at && data.readU8(at) <= 1n, ProgramError.BorshIoError);
  if (data.readU8(at) === 1n) {
    require(data.length >= at + 5n, ProgramError.BorshIoError);
    p.hasCancel = true;
    p.cancel = data.readU32(at + 1n);
    at += 4n;
  }
  require(data.length === at + 1n, ProgramError.BorshIoError);
  return p;
}

/** process_cancel_orders: CancelUpTo's and ForceCancelOrders' book work for the trader `traderAt`, and the withdrawal. */
function cancelOrders(
  rest: RemainingAccounts,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  traderAt: u64,
  params: CancelUpTo,
  withdraw: boolean,
  vaults: u64,
): void {
  dispatchLoadedMarket(rest.get(2n));
  logComputeUnits();
  const released: Released = { quote: 0n, base: 0n };
  const m = marketShape(rest);
  const traderIndex = traderIndexOf(m, rest, rest.get(traderAt).key);
  if (traderIndex !== 0n) cancelUpToInner(m, rest, rec, logData, traderIndex, params, withdraw, released);
  logComputeUnits();
  finish(rest, withdraw, vaults, released);
}

/** Tags 8 (CancelUpTo, logged as "CancelMultipleOrders") and 9 (CancelUpToWithFreeFunds). */
export function cancelUpTo(rest: RemainingAccounts, data: InstructionBytes, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>, withdraw: boolean): void {
  if (withdraw) loadCancelContext(rest);
  const params = decodeCancelUpTo(data);
  cancelOrders(rest, rec, logData, 3n, params, withdraw, TRADER_VAULTS);
}

/**
 * Tags 10 (CancelMultipleOrdersById) and 11 (CancelMultipleOrdersByIdWithFreeFunds): CancelMultipleOrdersByIdParams
 * { orders: Vec<CancelOrderParams> } after the tag. An empty list stops early, before the market is read.
 */
export function cancelMultipleOrdersById(
  rest: RemainingAccounts,
  data: InstructionBytes,
  rec: Inout<Recorder>,
  logData: Inout<FixedVec<u8, 1280>>,
  withdraw: boolean,
): void {
  if (withdraw) loadCancelContext(rest);
  // A u32 count, then that many CancelOrderParams of 17 bytes, each with a side of 0 or 1, and nothing after.
  require(data.length >= 5n, ProgramError.BorshIoError);
  const count = u64(data.readU32(1n));
  require(data.length === 5n + 17n * count, ProgramError.BorshIoError);
  for (let i = 0n; i < count; i++) require(data.readU8(5n + 17n * i) <= 1n, ProgramError.BorshIoError);
  if (count === 0n) {
    log("No orders to cancel");
    return;
  }
  logComputeUnits();
  dispatchLoadedMarket(rest.get(2n));
  const released: Released = { quote: 0n, base: 0n };
  const m = marketShape(rest);
  const traderIndex = traderIndexOf(m, rest, rest.get(3n).key);
  if (traderIndex !== 0n) cancelByIdInner(m, rest, rec, logData, data, count, traderIndex, withdraw, released);
  logComputeUnits();
  finish(rest, withdraw, TRADER_VAULTS, released);
}

/**
 * Tag 106: the authority evicts a trader whose seat it no longer approves and who has no orders left: the trader's
 * free funds go back to its token accounts and its state leaves the traders tree (funds.ts's process_withdraw).
 */
export function evictSeat(rest: RemainingAccounts): void {
  loadAuthorizedContext(rest);
  processWithdraw(rest, AUTHORIZED_VAULTS, rest.get(4n).key, false, 0n, false, 0n, true);
}

/** Tag 107: the authority cancels a trader's orders as CancelUpTo would (CancelUpToParams), sending the funds to the trader. */
export function forceCancelOrders(rest: RemainingAccounts, data: InstructionBytes, rec: Inout<Recorder>, logData: Inout<FixedVec<u8, 1280>>): void {
  loadAuthorizedContext(rest);
  const params = decodeCancelUpTo(data);
  cancelOrders(rest, rec, logData, 4n, params, true, AUTHORIZED_VAULTS);
}
