// Helpers for the Phoenix tests of its limits (phoenix-limits.test.ts), beside phoenix-helpers.ts:
//
// - Phoenix called by another program, for what only a CPI reaches: instruction data past what a transaction carries
//   (a CPI takes up to 10,240 bytes). The caller is fixtures/cpi-forwarder.ts, loaded into both VMs of a Diff at the
//   same address; the instruction data it passes on is kept in an account (the same bytes in both VMs).
// - Account lists padded past what Phoenix reads (it ignores the rest), duplicates of an account it reads or accounts
//   of their own: the entrypoint takes heap for every entry, more for a distinct account.
// - The original alone, simulated (nothing changes), to find where it starts to run out of memory.
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { deployFile } from "../../test/harness.js";
import { type Diff, PROGRAM } from "./phoenix-helpers.js";

const FORWARDER_SOURCE = fileURLToPath(new URL("./fixtures/cpi-forwarder.ts", import.meta.url));

/** The forwarder, loaded into both VMs of `d`; its address. */
export async function forwarder(d: Diff): Promise<Address> {
  const programId = (await generateKeyPairSigner()).address;
  for (const svm of d.vms) await deployFile(FORWARDER_SOURCE, { svm, programId });
  return programId;
}

/**
 * ComputeBudget's SetComputeUnitLimit(1.4M) and RequestHeapFrame(256 KiB): the transaction of a forwarded instruction
 * (the frame is the forwarder's; Phoenix's allocator uses its own 32 KiB of it whatever the frame).
 */
export const CPI_BUDGET: Instruction[] = [
  { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data: new Uint8Array([2, 0xc0, 0x5c, 0x15, 0]) },
  { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data: new Uint8Array([1, 0, 0, 4, 0]) },
];

/** The transaction that forwards `i`: CPI_BUDGET, then viaCpi(i). Phoenix's failures are the third instruction's. */
export async function cpiTx(d: Diff, caller: Address, i: Instruction): Promise<Instruction[]> {
  return [...CPI_BUDGET, await viaCpi(d, caller, i)];
}

/**
 * `i` (an instruction to Phoenix) sent through the forwarder at `caller`: its data written to a new account in both
 * VMs, its accounts passed on with their roles and signers.
 */
export async function viaCpi(d: Diff, caller: Address, i: Instruction): Promise<Instruction> {
  const data = Buffer.from(i.data ?? new Uint8Array());
  const holder = (await generateKeyPairSigner()).address;
  const bytes = Buffer.alloc(4 + data.length);
  bytes.writeUInt32LE(data.length, 0);
  data.copy(bytes, 4);
  d.write(holder, caller, bytes);
  return {
    programAddress: caller,
    accounts: [{ address: PROGRAM, role: AccountRole.READONLY }, { address: holder, role: AccountRole.READONLY }, ...(i.accounts ?? [])],
    data: new Uint8Array(0),
  };
}

/** Addresses of no account, to pad account lists with distinct entries. */
export async function strangers(n: number): Promise<Address[]> {
  return Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
}

/**
 * `i` with more accounts after its own, read-only: `distinct` of `pool` (one entry each), then duplicates of its
 * account `of` up to `entries` added in all.
 */
export function pad(i: Instruction, entries: number, pool: Address[] = [], distinct = 0, of = 2): Instruction {
  const list = [...(i.accounts ?? [])];
  const dup = list[of]!.address;
  for (let k = 0; k < entries; k++) list.push({ address: k < distinct ? pool[k]! : dup, role: AccountRole.READONLY });
  return { ...i, accounts: list as Instruction["accounts"] };
}

/** The original alone, simulated: whether it succeeds, and its log lines. */
export async function simulate(svm: LiteSVM, payer: KeyPairSigner, ixs: Instruction[]): Promise<{ ok: boolean; logs: string[] }> {
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (t) => setTransactionMessageFeePayerSigner(payer, t),
    (t) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(t),
    (t) => appendTransactionMessageInstructions(ixs, t),
    (t) => signTransactionMessageWithSigners(t),
  );
  const r = svm.simulateTransaction(tx);
  return r instanceof FailedTransactionMetadata ? { ok: false, logs: r.meta().logs() } : { ok: true, logs: r.meta().logs() };
}

export const OUT_OF_MEMORY = "Program log: Error: memory allocation failed, out of memory";

/**
 * The fewest padding entries (from `from`, at most `to`) with which the original runs out of memory, found on the
 * original alone (simulated). With fewer it must not, nor with `from` (so the boundary is inside the range).
 */
export async function oomBoundary(d: Diff, payer: KeyPairSigner, make: (entries: number) => Instruction[], from: number, to: number): Promise<number> {
  const oom = async (n: number) => (await simulate(d.original, payer, make(n))).logs.includes(OUT_OF_MEMORY);
  expect(await oom(from), `out of memory already with ${from} padding entries`).toBe(false);
  expect(await oom(to), `not out of memory with ${to} padding entries`).toBe(true);
  let lo = from;
  let hi = to;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await oom(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Both sides of the original's out-of-memory boundary compared (phoenix-helpers.ts's both()): `n` padding entries,
 * where it runs out of memory, then `n - 1`, where it does not (sent second: it may change the market). The outcome of
 * the second is returned.
 */
export async function bothSides(d: Diff, label: string, payer: KeyPairSigner, make: (entries: number) => Instruction[], n: number): Promise<string> {
  await d.both(`${label}: ${n} more accounts`, payer, make(n));
  expect(d.lastLogs, `${label}: ${n} more accounts`).toContain(OUT_OF_MEMORY);
  const before = await d.both(`${label}: ${n - 1} more accounts`, payer, make(n - 1));
  expect(d.lastLogs, `${label}: ${n - 1} more accounts`).not.toContain(OUT_OF_MEMORY);
  return before;
}

/** The accounts' bytes in the original copied into the port's VM (after setup the original alone ran). */
export function sync(d: Diff, ...addresses: Address[]): void {
  for (const a of addresses) {
    const acct = d.original.getAccount(a);
    if (!acct.exists) throw new Error(`${a} does not exist`);
    d.port.setAccount({
      address: a,
      data: new Uint8Array(acct.data),
      executable: acct.executable,
      lamports: acct.lamports,
      programAddress: acct.programAddress,
      space: BigInt(acct.data.length),
    });
  }
}
