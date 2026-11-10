// The compute units of what Phoenix's matching engine and cancels repeat (test/language/phx-costs.test.ts): a cancel
// that finds an order's node and removes it, walks of a book, min / get, views of one market account made again and
// again (its owner checked each time), a read-only struct handed to helpers that also take accounts, and an event
// written with pushBorsh against the same bytes written with pushLE. One operation per instruction; what it returned
// goes into the account's first 24 bytes.
import {
  type FixedVec,
  type InstructionBytes,
  type RemainingAccount,
  type RemainingAccounts,
  type i8,
  type i64,
  type Pubkey,
  type u8,
  type u32,
  type i16,
  u16,
  ProgramError,
  fixedVec,
  instructionData,
  loadRaw,
  loadRawAt,
  loadRawMutAt,
  programId,
  rbTreeAt,
  rbTreeMutAt,
  remainingAccounts,
  require,
  setReturnData,
  u64,
} from "typesol";

export const NATIVE_ACCOUNT_WRITES = true;

/** What the operation returned. */
export interface Out {
  a: u64;
  b: u64;
  c: u64;
}

/** Bytes 24..40: a header the view loops read. */
export interface Head {
  x: u64;
  y: u64;
}

export interface FIFOOrderId {
  price_in_ticks: u64;
  order_sequence_number: u64;
}

export interface FIFORestingOrder {
  trader_index: u64;
  num_base_lots: u64;
  last_valid_slot: u64;
  last_valid_unix_timestamp_in_seconds: u64;
}

/** What Phoenix's book helpers read again and again (book.ts's MarketShape). */
export interface Shape {
  bids: u64;
  asks: u64;
  asksAt: u64;
  tradersAt: u64;
  seats: u64;
  tick: u64;
  perUnit: u64;
}

/** Part of Phoenix's PhoenixMarketEvent: its largest variant (Header, 91 bytes) sets the enum's size. */
export type Event =
  | { kind: "Uninitialized" }
  | { kind: "Header"; instruction: u8; sequence_number: u64; timestamp: i64; slot: u64; market: Pubkey; signer: Pubkey; total_events: u16 }
  | { kind: "Fill"; index: u16; maker_id: Pubkey; order_sequence_number: u64; price_in_ticks: u64; base_lots_filled: u64; base_lots_remaining: u64 }
  | { kind: "Reduce"; index: u16; order_sequence_number: u64; price_in_ticks: u64; base_lots_removed: u64; base_lots_remaining: u64 }
  | { kind: "Moved"; at: Point; flag: boolean; side: Side; who: Pubkey };

export interface Point {
  x: u32;
  y: i16;
}

export enum Side {
  Bid,
  Ask,
}

const TREE = 40n;

function fifoCmp(a: FIFOOrderId, b: FIFOOrderId): i8 {
  if (a.order_sequence_number >> 63n === 1n) {
    if (a.price_in_ticks !== b.price_in_ticks) return b.price_in_ticks < a.price_in_ticks ? -1n : 1n;
    if (a.order_sequence_number !== b.order_sequence_number) return b.order_sequence_number < a.order_sequence_number ? -1n : 1n;
    return 0n;
  }
  if (a.price_in_ticks !== b.price_in_ticks) return a.price_in_ticks < b.price_in_ticks ? -1n : 1n;
  if (a.order_sequence_number !== b.order_sequence_number) return a.order_sequence_number < b.order_sequence_number ? -1n : 1n;
  return 0n;
}

/** The market's Shape, from its header (a helper's result, as Phoenix's marketShape). */
function shapeOf(rest: RemainingAccounts): Shape {
  const h = loadRaw<Head>(rest.get(0n));
  return { bids: h.x, asks: h.y, asksAt: 1n, tradersAt: 2n, seats: 3n, tick: 4n, perUnit: 5n };
}

/** A helper that reads the shape and takes the accounts (Phoenix's traderIndexOf, reduceOrderInner …). */
function useShape(m: Shape, rest: RemainingAccounts, k: u64): u64 {
  const h = loadRawAt<Head>(rest.get(0n), 24n);
  return m.bids + m.tick + k + h.x;
}

/** Passes its shape on to another helper that takes accounts. */
function passShape(m: Shape, rest: RemainingAccounts, k: u64): u64 {
  return useShape(m, rest, k);
}

function tree(acct: RemainingAccount, data: InstructionBytes): void {
  const op = data.readU8(0n);
  const t = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(acct, TREE, data.readU64(1n), fifoCmp);
  const out = loadRawMutAt<Out>(acct, 0n);
  const key: FIFOOrderId = { price_in_ticks: data.readU64(9n), order_sequence_number: data.readU64(17n) };
  if (op === 0n) {
    t.initialize();
  } else if (op === 1n) {
    const r = t.insert(key, { trader_index: data.readU64(25n), num_base_lots: 1n, last_valid_slot: 0n, last_valid_unix_timestamp_in_seconds: 0n });
    out.a = r === null ? 0n : 1n;
  } else if (op === 2n) {
    // A cancel: find the order's node, check whose it is, remove that node.
    const i = t.addrOf(key);
    if (i !== 0n && t.nodeAt(i).value.trader_index === data.readU64(25n)) {
      const v = t.removeAt(i);
      out.a = v === null ? 0n : v.num_base_lots;
    }
  } else if (op === 12n) {
    // The same cancel removing by key: a second search.
    const i = t.addrOf(key);
    if (i !== 0n && t.nodeAt(i).value.trader_index === data.readU64(25n)) {
      const v = t.remove(key);
      out.a = v === null ? 0n : v.num_base_lots;
    }
  } else if (op === 3n) {
    const v = t.get(key);
    out.a = v === null ? 0n : v.trader_index;
  } else if (op === 4n) {
    const e = t.min();
    out.a = e === null ? 0n : e.value.trader_index;
  } else if (op === 5n) {
    const e = t.max();
    out.a = e === null ? 0n : e.value.trader_index;
  } else if (op === 6n) {
    let n = 0n;
    let s = 0n;
    for (const e of t) {
      n++;
      s += e.value.trader_index;
    }
    out.a = n;
    out.b = s;
  } else if (op === 7n) {
    let n = 0n;
    let s = 0n;
    for (const e of t.reversed()) {
      n++;
      s += e.value.trader_index;
    }
    out.a = n;
    out.b = s;
  } else if (op === 8n) {
    out.a = u64(t.addrOf(key));
  }
  // op 9: nothing (the baseline: making the tree and the result block)
  out.c = t.length;
}

/** A read-only walk (rbTreeAt). */
function walkReadOnly(acct: RemainingAccount, data: InstructionBytes): void {
  const t = rbTreeAt<FIFOOrderId, FIFORestingOrder>(acct, TREE, data.readU64(1n), fifoCmp);
  let s = 0n;
  for (const e of t) s += e.value.trader_index;
  const r: FixedVec<u8, 8> = fixedVec([]);
  r.pushLE(s);
  setReturnData(r);
}

/** `n` views of one account in a loop, and `n` helper calls that each make one. */
function views(rest: RemainingAccounts, data: InstructionBytes): void {
  const op = data.readU8(0n);
  const n = data.readU64(1n);
  const acct = rest.get(0n);
  const out = loadRawMutAt<Out>(acct, 0n);
  let s = 0n;
  if (op === 20n) {
    // Each pass writes the account, as a matching loop writes the book.
    for (let k = 0n; k < n; k++) {
      const h = loadRawAt<Head>(acct, 24n);
      s += h.x;
      out.b = s;
    }
  } else if (op === 21n) {
    for (let k = 0n; k < n; k++) {
      const h = loadRaw<Head>(acct);
      out.b = h.x;
      const g = loadRawAt<Head>(acct, 24n);
      s += h.x + g.y;
      out.c = s;
    }
  } else if (op === 22n) {
    const m = shapeOf(rest);
    for (let k = 0n; k < n; k++) s += useShape(m, rest, k);
  } else if (op === 23n) {
    const m = shapeOf(rest);
    for (let k = 0n; k < n; k++) s += passShape(m, rest, k);
  }
  // op 29: the loop's baseline
  out.a = s;
}

/** `n` Reduce events (35 bytes each) written into a log buffer, by pushBorsh or by pushLE. */
function events(rest: RemainingAccounts, data: InstructionBytes): void {
  const op = data.readU8(0n);
  const n = data.readU64(1n);
  const buf: FixedVec<u8, 1280> = fixedVec([15n]);
  for (let k = 0n; k < n; k++) {
    buf.truncate(1n);
    if (op === 30n) {
      buf.pushBorsh<Event>({
        kind: "Reduce",
        index: u16(k),
        order_sequence_number: k + 7n,
        price_in_ticks: 100n,
        base_lots_removed: k,
        base_lots_remaining: 9n,
      });
    } else if (op === 31n) {
      buf.pushLE<u8>(3n);
      buf.pushLE(u16(k));
      buf.pushLE(k + 7n);
      buf.pushLE<u64>(100n);
      buf.pushLE(k);
      buf.pushLE<u64>(9n);
    } else if (op === 32n) {
      // Every scalar kind (a bool, an enum, a Pubkey) by direct stores, then a variant with a struct field (one copy).
      buf.pushBorsh<Event>({ kind: "Fill", index: u16(k), maker_id: programId(), order_sequence_number: 1n, price_in_ticks: 2n, base_lots_filled: 3n, base_lots_remaining: 4n });
      buf.pushBorsh<Event>({ kind: "Moved", flag: k === 0n, at: { x: 7n, y: -2n }, side: Side.Ask, who: programId() });
    }
  }
  setReturnData(buf);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 9n, ProgramError.InvalidInstructionData);
  const op = data.readU8(0n);
  const rest = remainingAccounts();
  if (op < 10n || op === 12n) tree(rest.get(0n), data);
  else if (op === 10n) walkReadOnly(rest.get(0n), data);
  else if (op < 30n) views(rest, data);
  else events(rest, data);
}
