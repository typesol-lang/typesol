// constraint(…) mentioning another, optional account: Anchor evaluates the expression as written, so a check that
// the account is missing (`x === null`) runs when it is. Only the constrained account itself being optional and
// missing skips its constraints. (Declared constraints, HasOne and the like, still run only when every optional
// account they mention was passed.)
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN } from "@anchor-lang/core";
import { SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const SOURCE = `import { type AccountInfo, type Mut, type Signer, type SystemAccount, type SystemProgram, type u64, constraint, invoke, readonly, u32, writable, writableSigner } from "typesol";

export function go(payer: Signer, extra: AccountInfo | null, own: AccountInfo | null, need: boolean): void {
  constraint(payer, !(need && extra === null));
  constraint(own, own!.key === payer.key);
}

/** An optional account in a CPI's list: passed on only when given (the System Program ignores a third account). */
export function pay(payer: Mut<Signer>, to: Mut<SystemAccount>, extra: AccountInfo | null, system: SystemProgram, amount: u64): void {
  invoke(system, [writableSigner(payer), writable(to), readonly(extra)], [u32(2n), amount]);
}
`;

describe("constraint(…) and optional accounts", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-optional-constraint-"));
    writeFileSync(path.join(dir, "a.ts"), SOURCE);
    d = await deployFile(path.join(dir, "a.ts"));
  });

  it("runs a check that another optional account is missing; skips an optional account's own when it is", async () => {
    const payer = await fundedSigner(d.svm);
    const other = (await fundedSigner(d.svm)).address;
    const go = (need: boolean, extra: string | null, own: string | null) =>
      send(d.svm, payer, [
        ix(d, "go", { need }, [
          { address: payer.address, signer: payer },
          { address: (extra ?? d.programId) as never },
          { address: (own ?? d.programId) as never },
        ]),
      ]);
    expect(customError(await go(true, null, null))).toBe(2003);
    expectOk(await go(true, other, null));
    expectOk(await go(false, null, null));
    expectOk(await go(false, null, payer.address));
    expect(customError(await go(false, null, other))).toBe(2003);
  });

  it("leaves an optional account that was not passed out of a CPI's list", async () => {
    const payer = await fundedSigner(d.svm);
    const to = (await fundedSigner(d.svm)).address;
    const pay = (extra: string | null) =>
      send(d.svm, payer, [
        ix(d, "pay", { amount: new BN(1_000) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: to, writable: true },
          { address: (extra ?? d.programId) as never },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const before = d.svm.getBalance(to)!;
    expectOk(await pay(null));
    const res = expectOk(await pay(to));
    expect(d.svm.getBalance(to)! - before).toBe(2_000n);
    // Without the account the CPI lists two (with the program id there instead, the System Program would still take
    // it); the Drift withdrawal tests check the list against the original's.
    expect(res.logs().filter((l) => l.startsWith("Program 11111111111111111111111111111111 invoke"))).toHaveLength(1);
  });
});
