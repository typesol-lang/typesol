// Inout<T> helper parameters (helpers in inout-lib.ts and here): each kind of place a caller passes (a local struct,
// fields and list elements of a Mut<T> account, an element of its growable Vec, local FixedVec / FixedArray lists, a
// loadBorsh local, a loadRawMut view, BigVec elements in a loop moved out of the function), forwarding, closures and
// generic helpers, the CU of a helper against the same code inline, and Dup accounts compared at run time.
// test/language/inout.test.ts runs it.
import {
  type AccountInfo,
  type BigVec,
  type Dup,
  type FixedArray,
  type FixedVec,
  type Init,
  type Inout,
  type Mut,
  type RemainingAccount,
  type Signer,
  type SystemProgram,
  type Vec,
  type u8,
  type u64,
  fixedArray,
  fixedVec,
  loadBorsh,
  loadRaw,
  loadRawMut,
  remainingAccounts,
  log,
  storeBorsh,
} from "typesol";
import { type Event, type Level, type Recorder, addEvent, addTwice, addValues, fill, fillAndRecord, merge, popValue, pushValue, raiseAll } from "./inout-lib.js";

export interface Book {
  bump: u8;
  levels: FixedArray<Level, 4>;
  rec: Recorder;
  buf: FixedVec<u64, 8>;
  open: Vec<Level>;
}

/** A native account: a tag, then levels to the end of the account (loadRawMut). */
export interface Levels {
  tag: u8;
  items: BigVec<Level>;
}

export function create(payer: Mut<Signer>, book: Init<Book>, systemProgram: SystemProgram): void {
  book.bump = book.create(payer, ["book", payer.key]);
  for (let i = 0n; i < 4n; i++) book.levels.set(i, { price: 100n + i, qty: 10n });
}

export function openOrder(payer: Mut<Signer>, book: Mut<Book>, systemProgram: SystemProgram, price: u64, qty: u64): void {
  book.open.push({ price, qty }, payer);
}

/** Local structs: the helper's writes are the caller's, through a helper that forwards its parameter too. */
export function local(price: u64, qty: u64): void {
  const rec: Recorder = { count: 0n, total: 0n, last: 0n };
  addEvent(rec, { price, qty });
  addTwice(rec, { price: price * 2n, qty });
  log(`local ${rec.count} ${rec.total} ${rec.last}`);
  const lv: Level = { price, qty };
  const took = fill(lv, qty - 1n);
  log(`level ${took} ${lv.qty}`);
}

/** Fields of a Mut<T> account: a struct, a FixedArray element (with the struct beside it), a FixedVec, the array. */
export function fields(book: Mut<Book>, i: u64, qty: u64): void {
  addEvent(book.rec, { price: 7n, qty });
  fillAndRecord(book.levels.get(i), book.rec, qty);
  const lv = book.levels.get(i);
  fill(lv, 1n);
  log(`after ${lv.qty}`);
  pushValue(book.buf, qty);
  raiseAll(book.levels, 1000n);
}

/** An element of the account's growable Vec, to a helper that takes no account: nothing can move it meanwhile. */
export function fillOpen(book: Mut<Book>, i: u64, qty: u64): void {
  const took = fill(book.open.get(i), qty);
  log(`open ${took} ${book.open.get(i).qty}`);
}

/** Local lists: a FixedVec the helper pushes to and pops, a FixedArray and one of its elements. */
export function lists(a: u64, b: u64): void {
  const buf: FixedVec<u64, 8> = fixedVec([]);
  pushValue(buf, a);
  pushValue(buf, b);
  pushValue(buf, a + b);
  const top = popValue(buf);
  log(`buf ${buf.length} ${top} ${buf.get(1n)}`);
  const levels = fixedArray<Level, 4>({ price: 1n, qty: a });
  raiseAll(levels, b);
  fill(levels.get(2n), 1n);
  log(`levels ${levels.get(0n).price} ${levels.get(3n).price} ${levels.get(2n).qty}`);
}

/** A loadBorsh local (written back with storeBorsh). */
export function borsh(acct: Mut<AccountInfo>, qty: u64): void {
  const rec = loadBorsh<Recorder>(acct);
  addTwice(rec, { price: 3n, qty });
  storeBorsh(acct, rec);
}

/** A loadRawMut view, and a field path into it. */
export function raw(acct: Mut<AccountInfo>, qty: u64): void {
  const rec = loadRawMut<Recorder>(acct);
  addEvent(rec, { price: 9n, qty });
}

/** BigVec elements in a loop moved into a function of its own, with a local recorder. */
export function sweep(acct: Mut<AccountInfo>, qty: u64): void {
  const l = loadRawMut<Levels>(acct);
  const rec: Recorder = { count: 0n, total: 0n, last: 0n };
  for (const x of l.items) fillAndRecord(x, rec, qty);
  log(`swept ${rec.count} ${rec.total} ${rec.last}`);
}

/** A helper whose BigVec loop (moved into a function of its own) pushes to its Inout list. */
function gather(acct: RemainingAccount, buf: Inout<FixedVec<u64, 8>>): void {
  const l = loadRaw<Levels>(acct);
  for (const x of l.items) buf.push(x.price + x.qty);
}

export function collect(): void {
  const acct = remainingAccounts().get(0n);
  const buf: FixedVec<u64, 8> = fixedVec([]);
  gather(acct, buf);
  gather(acct, buf);
  log(`collected ${buf.length} ${buf.get(0n)} ${buf.get(5n)}`);
}

function applyEach(rec: Inout<Recorder>, f: (x: u64) => u64, v: u64): void {
  rec.total += f(v);
  rec.count += 1n;
}

function stamp(rec: Inout<Recorder>): Recorder {
  rec.count += 1n;
  return { count: rec.count, total: rec.total, last: rec.last };
}

function addBoth<T extends bigint>(rec: Inout<Recorder>, a: T, b: T): void {
  rec.total += (a + b) as u64;
}

/** A local function taking Inout (a helper), a helper expanded with a closure, a closure, a struct result, a generic. */
export function closures(v: u64, k: u64): void {
  const rec: Recorder = { count: 0n, total: 0n, last: 0n };
  const bump = (r: Inout<Recorder>): void => {
    r.count += 10n;
  };
  bump(rec);
  applyEach(rec, (x) => x * k, v);
  let seen = 0n;
  const note = (r: Inout<Recorder>, e: Event): void => {
    addEvent(r, e);
    seen += 1n;
  };
  const e: Event = { price: v, qty: v };
  note(rec, e);
  const s = stamp(rec);
  addBoth(rec, v, k);
  log(`closures ${rec.count} ${rec.total} ${rec.last} ${seen} ${s.count}`);
}

/** The CU comparison: a helper given the account's recorder n times, and the same code written inline. */
export function viaHelper(book: Mut<Book>, n: u64): void {
  for (let i = 0n; i < n; i++) addValues(book.rec, i, i);
}

export function inlined(book: Mut<Book>, n: u64): void {
  for (let i = 0n; i < n; i++) {
    book.rec.count += 1n;
    book.rec.total += i;
    book.rec.last = i;
  }
}

/** Two Dup accounts may be one: their recorders are compared at run time before the helper gets both. */
export function mergeBooks(a: Dup<Mut<Book>>, b: Dup<Mut<Book>>): void {
  merge(a.rec, b.rec);
}
