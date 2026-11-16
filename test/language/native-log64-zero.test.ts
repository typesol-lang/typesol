// log64, zeroData and PANIC_STYLE "solana-1.18" (test/fixtures/native-log64-zero.ts), with the lines checked against
// the ones Percolator v12.20's mainnet binary writes (test/programs/percolator_v12.so, fetched by
// scripts/fetch-programs.sh; those comparisons are skipped without it).
import { type Address, type KeyPairSigner, AccountRole, generateKeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { acct as acctOf, compileErrors, deployFile, fundedSigner, send } from "../harness.js";
import { A, Diff, HAVE_ORIGINAL, SLAB_LEN, SOL, accountAt, defaultInitArgs, ix, writeU128 } from "../../showcase/test/percolator-helpers.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/native-log64-zero.ts", import.meta.url));
type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

describe("log64, zeroData, PANIC_STYLE solana-1.18", () => {
  let svm: LiteSVM;
  let programId: Address;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    const d = await deployFile(FIXTURE);
    svm = d.svm;
    programId = d.programId;
    payer = await fundedSigner(svm);
  });
  let nonce = 0n;
  const call = (data: Buffer, accounts: { address: Address; role: AccountRole }[] = []) =>
    send(svm, payer, [{ programAddress: programId, accounts, data: new Uint8Array(Buffer.concat([data, u64(nonce++)])) }]);

  it("log64 writes five lowercase hex words, as sol_log_64", async () => {
    const r = await call(Buffer.concat([Buffer.from([0]), u64(0x1747f8n), u64(1000n), u64(0n), u64(0xffffffffffffffffn), u64(10n)]));
    expect(logs(r)).toContain("Program log: 0x1747f8, 0x3e8, 0x0, 0xffffffffffffffff, 0xa");
  });

  it("zeroData zeroes a range of account data with the memset syscall, and refuses past the end", async () => {
    const acct = (await generateKeyPairSigner()).address;
    const fill = Buffer.alloc(300_000, 0xab);
    svm.setAccount({
      address: acct,
      data: new Uint8Array(fill),
      executable: false,
      lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(fill.length))),
      programAddress: programId,
      space: BigInt(fill.length),
    });
    const w = [{ address: acct, role: AccountRole.WRITABLE }];
    const ok = await call(Buffer.concat([Buffer.from([1]), u64(7n), u64(299_000n)]), w);
    expect(ok).not.toBeInstanceOf(FailedTransactionMetadata);
    const after = Buffer.from(acctOf(svm, acct).data);
    expect(after.subarray(0, 7).every((b) => b === 0xab)).toBe(true);
    expect(after.subarray(7, 299_007).every((b) => b === 0)).toBe(true);
    expect(after.subarray(299_007).every((b) => b === 0xab)).toBe(true);
    // About constant compute units: 299,000 bytes by the syscall, not a store per word.
    expect((ok as TransactionMetadata).computeUnitsConsumed()).toBeLessThan(5_000n);
    const past = await call(Buffer.concat([Buffer.from([1]), u64(1n), u64(300_000n)]), w);
    expect(String((past as FailedTransactionMetadata).err())).toMatch(/code: 3003/);
    const ro = await call(Buffer.concat([Buffer.from([1]), u64(0n), u64(1n)]), [{ address: acct, role: AccountRole.READONLY }]);
    expect(String((ro as FailedTransactionMetadata).err())).toMatch(/code: 3006/);
  });

  it("PANIC_STYLE solana-1.18 logs `panicked at <location>:` and the message on the next line, then aborts", async () => {
    const r = await call(Buffer.from([2]));
    expect(String((r as FailedTransactionMetadata).err())).toMatch(/ProgramFailedToComplete/);
    expect(logs(r)).toContain("Program log: panicked at src/wide_math.rs:1554:30:\nmul_div_floor_u128: a*b overflow");
    expect(logs(r).at(-1)).toMatch(/failed: SBF program panicked$/);
  });

  it.skipIf(!HAVE_ORIGINAL)("the same lines as Percolator v12.20's binary: its sol_log_64 and its panic", async () => {
    const d = await Diff.create();
    const m = await d.newMarket({ slabLen: 1000 });
    const [orig] = d.vms;
    // slab_guard on a 1000-byte slab: sol_log_64(SLAB_LEN, 1000, 0, 0, 0).
    const r = await send(orig, m.admin, [ix.initMarket(m, defaultInitArgs(m.admin.address, m.mint))]);
    expect(logs(r)).toContain(`Program log: 0x${SLAB_LEN.toString(16)}, 0x3e8, 0x0, 0x0, 0x0`);
    const m2 = await d.market();
    const u = await d.user(m2);
    await d.ok("InitUser", u.key, [ix.initUser(m2, u, SOL)]);
    d.patch(m2.slab, (b) => writeU128(b, accountAt(0) + A.positionBasisQ, 1n << 120n));
    const p = await send(orig, u.key, [ix.withdraw(m2, u, 0, 1n)]);
    expect(logs(p)).toContain("Program log: panicked at src/wide_math.rs:1554:30:\nmul_div_floor_u128: a*b overflow");
    expect(logs(p).at(-1)).toMatch(/failed: SBF program panicked$/);
  });

  it("refuses misuse at compile time", () => {
    const head = `import { log64, zeroData, remainingAccounts } from "typesol";\n`;
    expect(compileErrors(`${head}export function f(): void { log64(1n, 2n, 3n, 4n); }`)).toMatch(/takes five u64 values|Expected 5 arguments/);
    expect(compileErrors(`${head}/** @fallback */ export function e(): void { zeroData(remainingAccounts().get(0n), 0n); }`)).toMatch(
      /takes an account, a byte offset and a length|Expected 3 arguments/,
    );
    expect(compileErrors(`export const PANIC_STYLE = "solana-1.19";\nexport function f(): void {}`)).toMatch(/PANIC_STYLE must be/);
  });
});
