// Forms a native port writes as the Rust reads (test/language/port-syntax.test.ts): for loops with two counters, a
// local list of 2 KiB of elements.
import { type FixedVec, fixedVec, u32, u64 } from "typesol";

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
