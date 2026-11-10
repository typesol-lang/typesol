// Views at offsets and with element counts known only at run time (a native account whose parts start where its
// header says, as Phoenix's market does): loadRawAt / loadRawMutAt and rawArrayAt / rawArrayMutAt.
import {
  type AccountInfo,
  type Mut,
  type Pubkey,
  ProgramError,
  instructionData,
  loadRaw,
  loadRawAt,
  loadRawMut,
  loadRawMutAt,
  log,
  rawArrayAt,
  rawArrayMutAt,
  remainingAccounts,
  require,
  u64,
} from "typesol";

/** At byte 0: where the body and the orders are, and how many orders there is room for. */
export interface Header {
  body_offset: u64;
  orders_offset: u64;
  orders_cap: u64;
  prices_offset: u64;
  prices_cap: u64;
}

export interface Body {
  sequence: u64;
  fees: u64;
  authority: Pubkey;
}

export interface Order {
  id: u64;
  qty: u64;
  owner: Pubkey;
}

/** The body's sequence number, through an AccountInfo parameter. */
export function readBody(market: AccountInfo): void {
  const h = loadRaw<Header>(market);
  const b = loadRawAt<Body>(market, h.body_offset);
  log(b.sequence);
  log(b.authority);
}

/** Bump the body's sequence (writable parameter, claimed once). */
export function bumpBody(market: Mut<AccountInfo>, by: u64): void {
  const h = loadRaw<Header>(market);
  const b = loadRawMutAt<Body>(market, h.body_offset);
  b.sequence += by;
  b.fees = b.fees + 1n;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const rest = remainingAccounts();
  if (tag === 0n) {
    // the orders: count, total quantity, the first with a quantity of at least `min`, one by index
    const h = loadRaw<Header>(rest.get(0n));
    const orders = rawArrayAt<Order>(rest.get(0n), h.orders_offset, h.orders_cap);
    let total = 0n;
    for (const o of orders) total += o.qty;
    const min = data.readU64(1n);
    const i = orders.findIndex((o) => o.qty >= min);
    log(`orders ${orders.length} total ${total} first ${i}`);
    if (i >= 0n) log(orders.get(u64(i)).owner);
    return;
  }
  if (tag === 1n) {
    // write order i (a whole struct), then one field of order j
    const h = loadRaw<Header>(rest.get(0n));
    const orders = rawArrayMutAt<Order>(rest.get(0n), h.orders_offset, h.orders_cap);
    orders.set(data.readU64(1n), { id: data.readU64(9n), qty: data.readU64(17n), owner: data.readPubkey(25n) });
    orders.get(data.readU64(57n)).qty = data.readU64(65n);
    return;
  }
  if (tag === 2n) {
    // scalar elements: a sum with reduce, a set, some()
    const h = loadRaw<Header>(rest.get(0n));
    const prices = rawArrayMutAt<u64>(rest.get(0n), h.prices_offset, h.prices_cap);
    prices.set(data.readU64(1n), data.readU64(9n));
    const sum = prices.reduce((acc, p) => acc + p, 0n);
    log(`prices ${prices.length} sum ${sum} big ${prices.some((p) => p > 1000n)}`);
    return;
  }
  if (tag === 3n) {
    // raw offset and count from the data (bounds checks)
    const a = rawArrayAt<u64>(rest.get(0n), data.readU64(1n), data.readU64(9n));
    log(`n ${a.length}`);
    if (a.length > 0n) log(a.get(a.length - 1n));
    return;
  }
  if (tag === 4n) {
    const b = loadRawAt<Body>(rest.get(0n), data.readU64(1n));
    log(b.fees);
    return;
  }
  if (tag === 5n) {
    // two mutable views of one account: the second is refused (2040) without NATIVE_ACCOUNT_WRITES
    const h = loadRawMut<Header>(rest.get(0n));
    const b = loadRawMutAt<Body>(rest.get(0n), h.body_offset);
    b.fees = 7n;
    return;
  }
}
