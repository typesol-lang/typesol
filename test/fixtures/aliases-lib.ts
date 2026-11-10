// Plain type aliases (test/language/aliases.test.ts), used from test/fixtures/aliases.ts: of an integer under a renamed
// import, of another alias, of Pubkey, an Option of a struct, a FixedVec, and one this file keeps to itself.
import { type FixedVec, type Pubkey, type u64 as U64, type u8 } from "typesol";
export type Price = U64;
export type Lots = Price;
export type Key = Pubkey;
export interface Point {
  x: Price;
  y: Lots;
}
export type MaybePoint = Point | null;
export type Buf = FixedVec<u8, 32>;
type Hidden = u8;
export interface Order {
  price: Price;
  owner: Key;
  at: MaybePoint;
  small: Hidden;
}
