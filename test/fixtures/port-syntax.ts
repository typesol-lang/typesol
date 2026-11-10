// Forms a native port writes as the Rust reads (test/language/port-syntax.test.ts): for loops with two counters.
import { type u64 } from "typesol";

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
