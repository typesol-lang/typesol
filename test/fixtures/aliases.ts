// Plain type aliases from another file (test/fixtures/aliases-lib.ts) in account data, a data enum's fields, arguments,
// locals, a helper's parameter and return type, and a generic helper whose type parameter hides one.
import { type Init, type Mut, type Signer, type SystemProgram, fixedVec, log, u64 } from "typesol";
import { type Buf, type Lots, type Order, type Point, type Price } from "./aliases-lib.js";

export interface Book {
  best: Price;
  last: Order;
  p: Point;
}
export type Event = { kind: "Fill"; price: Price; lots: Lots } | { kind: "Cancel"; at: Price };

function twice<Price>(x: Price): Price {
  return x;
}

function sum(b: Buf): Price {
  return b.reduce((a, x) => a + u64(x), 0n);
}

export function create(user: Mut<Signer>, book: Init<Book>, systemProgram: SystemProgram): void {
  book.create(user, ["book"]);
}

export function place(user: Mut<Signer>, book: Mut<Book>, price: Price, lots: Lots): Lots {
  const p: Price = price + lots;
  const b: Buf = fixedVec([1n, 2n]);
  log(sum(b));
  const e: Event = { kind: "Fill", price: p, lots };
  if (e.kind === "Fill") book.best = e.price;
  book.last = { price: p, owner: user.key, at: { x: 1n, y: 2n }, small: 3n };
  log(twice<Lots>(lots));
  return p;
}
