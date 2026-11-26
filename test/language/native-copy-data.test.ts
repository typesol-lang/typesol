// copyData (test/fixtures/native-copy-data.ts): a copy within one account's data by the memmove syscall, forward and
// backward overlaps, short copies (the word loop), bounds (3003, nothing copied), a read-only account (3006), and its
// compute units against a whole-struct assignment's word loop.
import { type Address, type KeyPairSigner, AccountRole, generateKeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { acct as acctOf, compileErrors, deployFile, fundedSigner, send } from "../harness.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/native-copy-data.ts", import.meta.url));
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

describe("copyData", () => {
  let svm: LiteSVM;
  let programId: Address;
  let payer: KeyPairSigner;
  let account: Address;
  const LEN = 20_000;
  const pattern = () => Buffer.from(Array.from({ length: LEN }, (_, i) => (i * 7 + 3) & 0xff));
  beforeAll(async () => {
    const d = await deployFile(FIXTURE);
    svm = d.svm;
    programId = d.programId;
    payer = await fundedSigner(svm);
    account = (await generateKeyPairSigner()).address;
  });
  const reset = () =>
    svm.setAccount({
      address: account,
      data: new Uint8Array(pattern()),
      executable: false,
      lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(LEN))),
      programAddress: programId,
      space: BigInt(LEN),
    });
  let nonce = 0;
  const call = (from: bigint, to: bigint, len: bigint, role = AccountRole.WRITABLE) =>
    send(svm, payer, [
      {
        programAddress: programId,
        accounts: [{ address: account, role }],
        data: new Uint8Array(Buffer.concat([u64(from), u64(to), u64(len), Buffer.from([nonce++ & 0xff])])),
      },
    ]);
  const expectCopy = (from: number, to: number, len: number) => {
    const want = pattern();
    want.copyWithin(to, from, from + len);
    expect(Buffer.from(acctOf(svm, account).data).equals(want)).toBe(true);
  };

  it("copies disjoint, overlapping (both directions) and short ranges as copy_within does", async () => {
    for (const [from, to, len] of [
      [0, 10_000, 5_000],
      [100, 150, 4_000],
      [4_000, 3_990, 4_000],
      [7, 1, 31],
      [3, 900, 424],
      [19_000, 0, 1_000],
      [5, 5, 100],
      [0, 0, 0],
    ] as const) {
      reset();
      const r = await call(BigInt(from), BigInt(to), BigInt(len));
      expect(r, `${from} -> ${to} (${len})`).not.toBeInstanceOf(FailedTransactionMetadata);
      expectCopy(from, to, len);
    }
  });

  it("costs about the same at any length: the syscall, not a word loop", async () => {
    reset();
    const small = (await call(0n, 10_000n, 424n)) as TransactionMetadata;
    reset();
    const large = (await call(0n, 10_000n, 9_000n)) as TransactionMetadata;
    expect(large.computeUnitsConsumed() - small.computeUnitsConsumed()).toBeLessThan(100n);
  });

  it("refuses a range past the end (3003), copying nothing, and a read-only account (3006)", async () => {
    for (const [from, to, len] of [
      [LEN - 10, 0, 11],
      [0, LEN - 10, 11],
      [LEN + 1, 0, 0],
      [0, 0xffff_ffff_ffff_fff0n, 32],
    ] as const) {
      reset();
      const r = await call(BigInt(from), BigInt(to), BigInt(len));
      expect(String((r as FailedTransactionMetadata).err())).toMatch(/code: 3003/);
      expect(Buffer.from(acctOf(svm, account).data).equals(pattern())).toBe(true);
    }
    reset();
    const ro = await call(0n, 1n, 1n, AccountRole.READONLY);
    expect(String((ro as FailedTransactionMetadata).err())).toMatch(/code: 3006/);
  });

  it("takes a remaining account or a Mut<AccountInfo>, nothing else", () => {
    const errs = compileErrors(`
      import { type AccountInfo, type u64, copyData } from "typesol";
      export function f(a: AccountInfo, n: u64): void { copyData(a, 0n, 8n, n); }
    `);
    expect(errs).toMatch(/copyData needs a Mut<AccountInfo> parameter or a remaining account/);
    // The TypeScript declaration takes four arguments.
    expect(
      compileErrors(
        `import { copyData, remainingAccounts } from "typesol";\n/** @fallback */\nexport function f(): void { copyData(remainingAccounts().get(0n), 0n, 8n); }`,
      ),
    ).toMatch(/Expected 4 arguments/);
  });
});
