// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// New orders and the matching engine (processor/new_order.rs, state/markets/fifo.rs): Swap, SwapWithFreeFunds,
// PlaceLimitOrder, PlaceLimitOrderWithFreeFunds, PlaceMultiplePostOnlyOrders and its free-funds form. Not ported yet:
// the entry checks their accounts and logs the instruction as Phoenix does, then each stops here with a panic.
import { panic } from "typesol";

/** Tag 0. */
export function swap(): void {
  panic("not ported yet");
}

/** Tag 1. */
export function swapWithFreeFunds(): void {
  panic("not ported yet");
}

/** Tag 2. */
export function placeLimitOrder(): void {
  panic("not ported yet");
}

/** Tag 3. */
export function placeLimitOrderWithFreeFunds(): void {
  panic("not ported yet");
}

/** Tag 16. */
export function placeMultiplePostOnlyOrders(): void {
  panic("not ported yet");
}

/** Tag 17. */
export function placeMultiplePostOnlyOrdersWithFreeFunds(): void {
  panic("not ported yet");
}
