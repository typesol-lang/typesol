// The RedBlackTree surface beyond the trace replay: references into nodes (get, min / max, nodeAt, for … of entries),
// writes through them, reverse iteration with break and continue, a read-only tree, Phoenix's book order, the panics
// lib-sokoban raises (as solana-program up to 1.17 logs them) and the bounds check.
import {
  type AccountInfo,
  type Mut,
  type Pubkey,
  type i8,
  ProgramError,
  instructionData,
  log,
  rbTreeAt,
  rbTreeMutAt,
  remainingAccounts,
  require,
  u32,
  u64,
} from "typesol";

/** Phoenix's FIFOOrderId and FIFORestingOrder. */
export interface OrderId {
  price_in_ticks: u64;
  order_sequence_number: u64;
}
export interface Resting {
  trader_index: u64;
  num_base_lots: u64;
  last_valid_slot: u64;
  last_valid_unix_timestamp_in_seconds: u64;
}

function fifo(a: OrderId, b: OrderId): i8 {
  if (a.order_sequence_number >> 63n === 1n) {
    if (a.price_in_ticks !== b.price_in_ticks) return b.price_in_ticks < a.price_in_ticks ? -1n : 1n;
    if (a.order_sequence_number !== b.order_sequence_number) return b.order_sequence_number < a.order_sequence_number ? -1n : 1n;
    return 0n;
  }
  if (a.price_in_ticks !== b.price_in_ticks) return a.price_in_ticks < b.price_in_ticks ? -1n : 1n;
  if (a.order_sequence_number !== b.order_sequence_number) return a.order_sequence_number < b.order_sequence_number ? -1n : 1n;
  return 0n;
}

const BOOK = 8n; // the book starts at byte 8, after a u64 the instructions leave alone

/** NodeAllocator::initialize on the book's bytes. */
export function init(market: Mut<AccountInfo>, cap: u64): void {
  const book = rbTreeMutAt<OrderId, Resting>(market, BOOK, cap, fifo);
  book.initialize();
}

/** Phoenix's book: post orders (bid or ask by the top bit of the stored sequence number), then list them best first. */
export function post(market: Mut<AccountInfo>, cap: u64, prices: u64, count: u64, bid: boolean): void {
  const book = rbTreeMutAt<OrderId, Resting>(market, BOOK, cap, fifo);
  for (let i = 0n; i < count; i++) {
    const seq = 100n + i;
    const r = book.insert(
      { price_in_ticks: (prices >> (8n * (i % 8n))) & 0xffn, order_sequence_number: bid ? seq ^ 0xffffffffffffffffn : seq },
      { trader_index: i + 1n, num_base_lots: 10n * (i + 1n), last_valid_slot: 0n, last_valid_unix_timestamp_in_seconds: 0n },
    );
    require(r !== null, ProgramError.InvalidArgument);
  }
  let line = "";
  for (const e of book) line += ` ${e.key.price_in_ticks}/${e.value.trader_index}`;
  log(`book${line}`);
}

/** Read-only walks of a book: reversed with continue and break, min / max, addrOf / nodeAt. */
export function inspect(market: AccountInfo, cap: u64, skipTrader: u64, stopAfter: u64): void {
  const book = rbTreeAt<OrderId, Resting>(market, BOOK, cap, fifo);
  let line = "";
  let n = 0n;
  for (const e of book.reversed()) {
    if (e.value.trader_index === skipTrader) continue;
    line += ` ${e.value.trader_index}@${e.index}`;
    n++;
    if (n === stopAfter) break;
  }
  log(`rev${line}`);
  const lo = book.min();
  const hi = book.max();
  if (lo !== null && hi !== null) {
    log(`min ${lo.key.price_in_ticks} max ${hi.key.price_in_ticks}`);
    const at = book.addrOf(lo.key);
    log(`addr ${at} same ${book.nodeAt(at).value.trader_index === lo.value.trader_index}`);
  } else log("empty");
}

/** Change an order through get's reference, cancel another and read what remove returns, then reduce the best. */
export function amend(market: Mut<AccountInfo>, cap: u64, price: u64, seq: u64, lots: u64, cancelPrice: u64, cancelSeq: u64): void {
  const book = rbTreeMutAt<OrderId, Resting>(market, BOOK, cap, fifo);
  const o = book.get({ price_in_ticks: price, order_sequence_number: seq });
  if (o === null) {
    log("no such order");
    return;
  }
  o.num_base_lots = lots;
  const gone = book.remove({ price_in_ticks: cancelPrice, order_sequence_number: cancelSeq });
  log(gone === null ? "cancel: none" : `cancel: trader ${gone.trader_index} lots ${gone.num_base_lots}`);
  const best = book.min();
  if (best !== null) best.value.last_valid_slot = 77n;
  log(`len ${book.length}`);
}

/** Cancel the best order by its node (removeAt), or by its key (remove) when `byKey`; then a stale index and 0 change nothing. */
export function cancelBest(market: Mut<AccountInfo>, cap: u64, byKey: boolean): void {
  const book = rbTreeMutAt<OrderId, Resting>(market, BOOK, cap, fifo);
  const best = book.min();
  if (best === null) {
    log("empty");
    return;
  }
  const at = best.index;
  const key: OrderId = { price_in_ticks: best.key.price_in_ticks, order_sequence_number: best.key.order_sequence_number };
  if (byKey) {
    const gone = book.remove(key);
    log(`removed ${gone === null ? "none" : `${gone.trader_index}`} at ${at} len ${book.length}`);
  } else {
    const gone = book.removeAt(at);
    log(`removed ${gone === null ? "none" : `${gone.trader_index}`} at ${at} len ${book.length}`);
    const again = book.removeAt(at);
    const zero = book.removeAt(0n);
    log(`again ${again === null} zero ${zero === null} len ${book.length}`);
  }
}

/** u64 keys and values: an equal key replaces the value (also when full), a new key on a full tree gives null. */
export function scalars(market: Mut<AccountInfo>, cap: u64, k: u64, v: u64): void {
  const t = rbTreeMutAt<u64, u64>(market, BOOK, cap);
  const r = t.insert(k, v);
  const got = t.get(k);
  log(`insert ${r === null ? "full" : `${r!}`} get ${got === null ? "none" : `${got!}`} len ${t.length}`);
}

/** Pubkey keys ordered bytewise (Phoenix's traders), values counting their seats. */
export function seat(market: Mut<AccountInfo>, cap: u64, trader: Pubkey): void {
  const t = rbTreeMutAt<Pubkey, u64>(market, BOOK, cap);
  t.insert(trader, t.length + 1n);
  let line = "";
  for (const e of t) line += ` ${e.value}`;
  log(`seats${line}`);
}

/** @fallback */
export function panics(): void {
  const data = instructionData();
  require(data.length >= 9n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const acct = remainingAccounts().get(0n);
  const t = rbTreeMutAt<u64, u64>(acct, 0n, data.readU64(1n));
  if (tag === 0n) t.initialize();
  else if (tag === 1n) t.insert(5n, 6n);
  else if (tag === 2n) log(t.nodeAt(u32(data.readU64(9n))).value);
  else if (tag === 3n) log(t.removeAt(u32(data.readU64(9n))) === null ? "none" : "some");
}
