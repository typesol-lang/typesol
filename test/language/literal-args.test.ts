// Literals as helper arguments (test/fixtures/literal-args.ts, helpers in literal-args-lib.ts): a struct literal, a
// nested one, a fixedArray(…) fill, a ternary with a literal branch and data-enum literals each passed straight to a
// helper taking the type, here and in another file, with the same results as binding the value to a const first.
import { type Address, AccountRole, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, acct, compileErrors, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const u64 = (n: bigint) => Buffer.from(BigUint64Array.of(n).buffer);

describe("literals as helper arguments", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let ledger: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/literal-args.ts", import.meta.url)));
    payer = await fundedSigner(d.svm);
    ledger = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: ledger, lamports: 10_000_000n, programAddress: d.programId, executable: false, data: new Uint8Array(24) } as never);
  });
  const call = (amount: bigint, flag: boolean, den: bigint, num: bigint, accounts: Address[] = []) =>
    send(d.svm, payer, [
      {
        programAddress: d.programId,
        accounts: accounts.map((address) => ({ address, role: AccountRole.WRITABLE })),
        data: new Uint8Array(Buffer.concat([u64(amount), Buffer.from([flag ? 1 : 0]), u64(den), u64(num)])),
      },
    ]);

  it("passes struct, nested, array and data-enum literals by value", async () => {
    const r = await call(1000n, false, 8n, 2n);
    expect(err(r)).toBe("ok");
    expect(logs(r)).toEqual(
      expect.arrayContaining([
        "Program log: flat 100",
        "Program log: local 2007",
        "Program log: nested 285",
        "Program log: array 3000",
        "Program log: choice 30",
        "Program log: deposit 1000",
        "Program log: withdraw 750",
        "Program log: pause 0",
        "Program log: fields 250",
      ]),
    );
    expect(logs(await call(1000n, true, 8n, 2n))).toContain("Program log: choice 500");
  });

  it("passes a literal to a helper that also takes an account", async () => {
    expect(err(await call(40n, false, 8n, 3n, [ledger]))).toBe("ok");
    const data = Buffer.from(acct(d.svm, ledger).data);
    expect([data.readBigUInt64LE(0), data.readBigUInt64LE(8), data.readBigUInt64LE(16)]).toEqual([40n, 3n, 1n]);
  });

  it("checks the literal as a const of that type would be checked", () => {
    const src = (call: string) =>
      `import { type u64 } from "typesol";\nexport interface Fee { denominator: u64; numerator: u64 }\nfunction f(x: Fee): u64 { return x.numerator; }\nexport function go(): void {\n  ${call};\n}\n`;
    expect(compileErrors(src("f({ denominator: 1n, numerator: 2n })"))).toBe("");
    expect(compileErrors(src("f({ denominator: 1n })"))).toMatch(/numerator/);
    expect(compileErrors(src("f({ denominator: 1n, numerator: 2n, extra: 3n })"))).toMatch(/extra/);
  });
});
