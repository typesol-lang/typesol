// Helpers in a file of their own that change what they are given (Inout<T>), called by inout.ts.
import { type FixedArray, type FixedVec, type Inout, type u64 } from "typesol";

export interface Event {
  price: u64;
  qty: u64;
}

/** What an order book's event recorder keeps (Phoenix's matching engine adds to one as it fills). */
export interface Recorder {
  count: u64;
  total: u64;
  last: u64;
}

export interface Level {
  price: u64;
  qty: u64;
}

export function addEvent(rec: Inout<Recorder>, e: Event): void {
  rec.count += 1n;
  rec.total += e.qty;
  rec.last = e.price;
}

/** The same, from values: the CU comparison with the code written inline. */
export function addValues(rec: Inout<Recorder>, price: u64, qty: u64): void {
  rec.count += 1n;
  rec.total += qty;
  rec.last = price;
}

/** Two recorders at once: the caller may not pass one place twice. */
export function merge(into: Inout<Recorder>, from: Inout<Recorder>): void {
  into.count += from.count;
  into.total += from.total;
  from.count = 0n;
  from.total = 0n;
}

/** Forwards its own Inout parameter: the caller's recorder gets both events. */
export function addTwice(rec: Inout<Recorder>, e: Event): void {
  addEvent(rec, e);
  addEvent(rec, { price: e.price + 1n, qty: e.qty });
}

/** Takes up to `qty` from a level; returns what it took. */
export function fill(level: Inout<Level>, qty: u64): u64 {
  const took = level.qty < qty ? level.qty : qty;
  level.qty -= took;
  return took;
}

/** Fills a level and records the fill: two places of the caller's at once. */
export function fillAndRecord(level: Inout<Level>, rec: Inout<Recorder>, qty: u64): void {
  const took = fill(level, qty);
  if (took > 0n) addEvent(rec, { price: level.price, qty: took });
}

export function pushValue(buf: Inout<FixedVec<u64, 8>>, v: u64): void {
  buf.push(v);
}

export function popValue(buf: Inout<FixedVec<u64, 8>>): u64 {
  const v = buf.get(buf.length - 1n);
  buf.pop();
  return v;
}

export function raiseAll(levels: Inout<FixedArray<Level, 4>>, by: u64): void {
  for (let i = 0n; i < 4n; i++) levels.get(i).price += by;
}
