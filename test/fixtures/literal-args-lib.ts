// Helpers in a file of their own, called with struct, array and data-enum literals by literal-args.ts.
import { type FixedArray, type RemainingAccount, loadRawMut, u64, type u8 } from "typesol";

export interface Fee {
  denominator: u64;
  numerator: u64;
}

export interface Fees {
  epoch: Fee;
  withdrawal: Fee;
  referral: u8;
}

export type Action = { kind: "Deposit"; amount: u64 } | { kind: "Withdraw"; fee: Fee; amount: u64 } | { kind: "Pause" };

export interface Ledger {
  last: Fee;
  count: u64;
}

/** amount × numerator / denominator, as the stake pool applies a Fee. */
export function applyFee(fee: Fee, amount: u64): u64 {
  return (amount * fee.numerator) / fee.denominator;
}

export function feesTotal(fees: Fees, amount: u64): u64 {
  return applyFee(fees.epoch, amount) + applyFee(fees.withdrawal, amount) + u64(fees.referral);
}

export function sum3(x: FixedArray<u64, 3>): u64 {
  return x.get(0n) + x.get(1n) + x.get(2n);
}

export function actionValue(a: Action): u64 {
  switch (a.kind) {
    case "Deposit":
      return a.amount;
    case "Withdraw":
      return a.amount - applyFee(a.fee, a.amount);
    case "Pause":
      return 0n;
  }
}

/** A helper that takes an account as well (it may write account data): the literal is still its own. */
export function record(acct: RemainingAccount, fee: Fee): void {
  const l = loadRawMut<Ledger>(acct);
  l.last = fee;
  l.count += 1n;
}
