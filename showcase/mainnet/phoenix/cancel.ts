// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// Reducing and cancelling orders (processor/reduce_order.rs, processor/cancel_multiple_orders.rs) and the authority's
// ForceCancelOrders and EvictSeat (processor/governance.rs; EvictSeat withdraws through funds.ts's processWithdraw).
// Not ported yet: the entry checks their accounts and logs the instruction as Phoenix does, then each stops here with
// a panic.
import { panic } from "typesol";

/** Tags 4 (ReduceOrder) and 5 (ReduceOrderWithFreeFunds). */
export function reduceOrder(): void {
  panic("not ported yet");
}

/** Tags 6 (CancelAllOrders) and 7 (CancelAllOrdersWithFreeFunds). */
export function cancelAllOrders(): void {
  panic("not ported yet");
}

/** Tags 8 (CancelUpTo) and 9 (CancelUpToWithFreeFunds). */
export function cancelUpTo(): void {
  panic("not ported yet");
}

/** Tags 10 (CancelMultipleOrdersById) and 11 (CancelMultipleOrdersByIdWithFreeFunds). */
export function cancelMultipleOrdersById(): void {
  panic("not ported yet");
}

/** Tag 106. */
export function evictSeat(): void {
  panic("not ported yet");
}

/** Tag 107. */
export function forceCancelOrders(): void {
  panic("not ported yet");
}
