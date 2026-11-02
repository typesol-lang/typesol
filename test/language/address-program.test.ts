// invoke into an Address<AccountInfo, "…"> parameter: Anchor's `#[account(address = ID)]` on an UncheckedAccount used
// as a CPI's program. Only the key is checked (2012, ConstraintAddress), not whether the account is executable.
import { BN } from "@anchor-lang/core";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const SOURCE = `import { type AccountInfo, type Address, type Mut, type Signer, type SystemAccount, type u64, invoke, writable, writableSigner, u32 } from "typesol";

export function pay(
  payer: Mut<Signer>,
  recipient: Mut<SystemAccount>,
  system: Address<AccountInfo, "11111111111111111111111111111111">,
  amount: u64,
): void {
  invoke(system, [writableSigner(payer), writable(recipient)], [u32(2n), amount]);
}
`;

describe('invoke into an Address<AccountInfo, "…">', () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-address-program-"));
    writeFileSync(path.join(dir, "a.ts"), SOURCE);
    d = await deployFile(path.join(dir, "a.ts"));
  });

  it("calls the program at that address, and refuses another account (2012)", async () => {
    const payer = await fundedSigner(d.svm);
    const recipient = (await fundedSigner(d.svm)).address;
    const pay = (system: typeof recipient) =>
      ix(d, "pay", { amount: new BN(5_000) }, [
        { address: payer.address, signer: payer, writable: true },
        { address: recipient, writable: true },
        { address: system },
      ]);
    const before = d.svm.getBalance(recipient)!;
    expectOk(await send(d.svm, payer, [pay(SYSTEM_PROGRAM)]));
    expect(d.svm.getBalance(recipient)! - before).toBe(5_000n);
    expect(customError(await send(d.svm, payer, [pay(recipient)]))).toBe(2012);
    expect(d.idl.instructions[0]!.accounts.find((a) => a.name === "system")).toMatchObject({ address: "11111111111111111111111111111111" });
  });

  it("still refuses a plain AccountInfo as the program", () => {
    expect(compileErrors(`import { type AccountInfo, invoke } from "typesol";\nexport function f(p: AccountInfo): void { invoke(p, [], []); }`)).toMatch(
      /invoke's program must be/,
    );
  });
});
