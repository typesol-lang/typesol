// Struct, nested-struct, array and data-enum literals passed straight to helpers (here and in another file), as
// `const fee: Fee = { … }; applyFee(fee, x)` would pass them.
import { fixedArray, instructionData, log, remainingAccounts, type u64 } from "typesol";
import { type Fee, actionValue, applyFee, feesTotal, record, sum3 } from "./literal-args-lib.js";

function scaled(fee: Fee, by: u64): u64 {
  return fee.numerator * by + fee.denominator;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  const amount = data.readU64(0n);
  const flag = data.readU8(8n) === 1n;
  const fee: Fee = { denominator: 100n, numerator: 3n };
  log(`flat ${applyFee({ denominator: 10n, numerator: 1n }, amount)}`);
  log(`local ${scaled({ numerator: amount, denominator: 7n }, 2n)}`);
  log(`nested ${feesTotal({ epoch: { denominator: 4n, numerator: 1n }, withdrawal: fee, referral: 5n }, amount)}`);
  log(`array ${sum3(fixedArray<u64, 3>(amount))}`);
  log(`choice ${applyFee(flag ? { denominator: 2n, numerator: 1n } : fee, amount)}`);
  log(`deposit ${actionValue({ kind: "Deposit", amount })}`);
  log(`withdraw ${actionValue({ kind: "Withdraw", fee: { denominator: 4n, numerator: 1n }, amount })}`);
  log(`pause ${actionValue({ kind: "Pause" })}`);
  // Fields read from instruction data, in source order, before the helper runs.
  log(`fields ${applyFee({ denominator: data.readU64(9n), numerator: data.readU64(17n) }, amount)}`);
  // A helper that also takes an account.
  const rest = remainingAccounts();
  if (rest.length > 0n) record(rest.get(0n), { denominator: amount, numerator: data.readU64(17n) });
}
