// One of two accounts chosen at run time (`ephemeral ? rest.get(5n) : reserve`): remaining accounts, AccountInfo
// parameters and RemainingAccount helper parameters, used where an account handle goes (CPIs, readData, loadRaw).
import {
  type AccountInfo,
  type Mut,
  type Pubkey,
  type RemainingAccount,
  type Signer,
  type SystemProgram,
  type u64,
  loadRaw,
  log,
  readData,
  remainingAccounts,
} from "typesol";

export interface Counter {
  owner: Pubkey;
  count: u64;
}

/** The first or the second remaining account, read through the choice. */
export function pick(second: boolean): void {
  const rest = remainingAccounts();
  const a = second ? rest.get(1n) : rest.get(0n);
  log(a.key);
  log(`count ${readData<u64>(a, 32n)}`);
  log(`lamports ${a.lamports}`);
}

/** A remaining account or an AccountInfo parameter, then loadRaw through a helper's choice. */
export function pickParam(fallback: AccountInfo, useRest: boolean): void {
  const rest = remainingAccounts();
  const source = useRest ? rest.get(0n) : fallback;
  log(source.key);
  const c = loadRaw<Counter>(source);
  log(`count ${c.count}`);
  log(`helper ${countOf(rest.get(0n), fallback, !useRest)}`);
}

function countOf(a: RemainingAccount, b: AccountInfo, takeB: boolean): u64 {
  const c = loadRaw<Counter>(takeB ? b : a);
  return c.count;
}

/** A transfer from the payer to one of three accounts (a nested choice), inline in the CPI. */
export function pay(payer: Mut<Signer>, system: SystemProgram, which: u64): void {
  const rest = remainingAccounts();
  system.transfer(payer, which === 0n ? rest.get(0n) : which === 1n ? rest.get(1n) : rest.get(2n), 1000n);
}
