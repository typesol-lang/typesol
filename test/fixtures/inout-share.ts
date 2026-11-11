// Inout<T> beside a read-only argument that may be the same bytes: two Dup accounts, or a writable and a read-only
// account (the runtime does not keep those apart). The helper reads its read-only argument after changing the Inout
// one, so the two are compared at run time (2040 when they share bytes). test/language/inout.test.ts runs it.
import { type Account, type Dup, type Init, type Inout, type Mut, type Signer, type SystemProgram, type u8, type u64, log } from "typesol";

export interface Rec {
  count: u64;
  total: u64;
}

export interface Ledger {
  bump: u8;
  rec: Rec;
}

export function create(payer: Mut<Signer>, ledger: Init<Ledger>, systemProgram: SystemProgram): void {
  ledger.bump = ledger.create(payer, ["ledger", payer.key]);
  ledger.rec = { count: 1n, total: 10n };
}

/** Sets `into`, then reads `from`: if they were one place, the read would see the write. */
function stamp(into: Inout<Rec>, from: Rec): u64 {
  into.count = 5n;
  return from.count;
}

export function stampDup(a: Dup<Mut<Ledger>>, b: Dup<Mut<Ledger>>): void {
  log(`stamped ${stamp(a.rec, b.rec)}`);
}

export function stampRead(a: Mut<Ledger>, b: Account<Ledger>): void {
  log(`stamped ${stamp(a.rec, b.rec)}`);
}
