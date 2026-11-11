// Inout<T> places reached through two run-time offset views (loadRawMutAt, rawArrayMutAt, rbTreeMutAt) under
// NATIVE_ACCOUNT_WRITES: the views may be one account and the same bytes, so a helper given a place in each, or a
// place in one and a read-only struct in the other, has them compared at run time (2040 when they overlap).
// test/language/inout.test.ts runs it.
import { type Inout, type u64, instructionData, loadRawMutAt, log, rawArrayMutAt, rbTreeMutAt, remainingAccounts } from "typesol";

export const NATIVE_ACCOUNT_WRITES = true;

export interface Out {
  a: u64;
  b: u64;
}

function both(x: Inout<Out>, y: Inout<Out>): void {
  x.a += y.a;
  y.b = 0n;
}

function stamp(x: Inout<Out>, y: Out): u64 {
  x.a = 5n;
  return y.a;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  const tag = data.readU8(0n);
  if (tag === 0n) {
    // Two struct views of one account at the offsets the data gives.
    const p = loadRawMutAt<Out>(rest.get(0n), data.readU64(1n));
    const q = loadRawMutAt<Out>(rest.get(0n), data.readU64(9n));
    both(p, q);
    log(`views ${p.a} ${q.b}`);
  } else if (tag === 1n) {
    const p = loadRawMutAt<Out>(rest.get(0n), data.readU64(1n));
    const q = loadRawMutAt<Out>(rest.get(0n), data.readU64(9n));
    log(`stamped ${stamp(p, q)}`);
  } else if (tag === 2n) {
    // Elements of two raw arrays, of the accounts given.
    const xs = rawArrayMutAt<Out>(rest.get(0n), 0n, 2n);
    const ys = rawArrayMutAt<Out>(rest.get(1n), 0n, 2n);
    both(xs.get(0n), ys.get(0n));
    log(`arrays ${xs.get(0n).a}`);
  } else if (tag === 3n) {
    const t = rbTreeMutAt<u64, Out>(rest.get(0n), 0n, 2n);
    t.initialize();
    t.insert(1n, { a: 3n, b: 4n });
  } else {
    // Nodes of two trees, of the accounts given.
    const t = rbTreeMutAt<u64, Out>(rest.get(0n), 0n, 2n);
    const u = rbTreeMutAt<u64, Out>(rest.get(1n), 0n, 2n);
    both(t.get(1n)!, u.get(1n)!);
    log(`trees ${t.get(1n)!.a}`);
  }
}
