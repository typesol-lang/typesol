// Forms a native port writes as the Rust reads (test/language/port-syntax.test.ts): for loops with two counters, a
// local list of 2 KiB of elements, reads through a view without binding it, a struct of the file's own for helpers.
import { type AccountInfo, type FixedVec, type Inout, fixedVec, loadRaw, loadRawAt, rbTreeAt, u32, u64 } from "typesol";

export interface Inner {
  a: u64;
  b: u64;
}

/** A market header: a u64, then a nested struct; a RedBlackTree<u64, u64> follows at byte 24. */
export interface Header {
  x: u64;
  inner: Inner;
}

/** Two counters meeting in the middle: `for (let i = 0n, j = n; i < j; i++, j--)`, skipping a step with continue. */
export function meet(n: u64, skip: u64): u64 {
  let s = 0n;
  for (let i = 0n, j = n; i < j; i++, j--) {
    if (i === skip) continue;
    s += j - i;
  }
  return s;
}

/** An initializer of assignments: `for (i = 1n, j = 1n; …; i++, j += i)`. */
export function triangle(n: u64): u64 {
  let i = 0n;
  let j = 0n;
  for (i = 1n, j = 1n; i < n; i++, j += i) {}
  return j;
}

/** Phoenix's 512 collected order ids: `FixedVec<u32, 512>`, 2 KiB of elements plus its length. */
export function collect(n: u64): u64 {
  const ids: FixedVec<u32, 512> = fixedVec([]);
  for (let i = 0n; i < n; i++) ids.push(u32(i * 3n));
  let s = 0n;
  for (const id of ids) s += u64(id);
  return s + ids.length;
}

/** Reads through views made in the expression: `loadRaw<Header>(m).inner.b`, `loadRawAt<…>(m, 8n).a`, `rbTreeAt(…).length`. */
export function peek(market: AccountInfo): u64 {
  return loadRaw<Header>(market).inner.b * 1000n + loadRawAt<Inner>(market, 8n).a * 100n + rbTreeAt<u64, u64>(market, 24n, 2n).length * 10n + rbTreeAt<u64, u64>(market, 24n, 2n).capacity;
}

/** Not exported: the file's own struct, for its helpers (out of the IDL). */
interface Pair {
  a: u64;
  b: u64;
}

function pairOf(x: u64): Pair {
  return { a: x, b: x + 1n };
}

function bump(p: Inout<Pair>): void {
  p.a += 10n;
}

export function pairs(x: u64): u64 {
  const p = pairOf(x);
  bump(p);
  const q: Pair = { a: 1n, b: 2n };
  return p.a + p.b + q.b;
}
