// constraint(account, condition, error?): Anchor's `constraint = expr @ error`, run with the account's checks (after
// has_one, before the next account), reading arguments; refused anywhere but the start of an instruction.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type Account, type HasOne, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type i64, type u64, constraint, currentSlot, now } from "typesol";

export interface Vault { owner: Pubkey; limit: u64 }
export enum VaultError { OverLimit = "over the limit" }

export function open(payer: Mut<Signer>, vault: Init<Vault>, systemProgram: SystemProgram, limit: u64): void {
  vault.create(payer, ["vault", payer.key]);
  vault.owner = payer.key;
  vault.limit = limit;
}
export function spend(vault: HasOne<Account<Vault>, "owner">, owner: Signer, amount: u64): void {
  constraint(vault, amount <= vault.limit, VaultError.OverLimit);
  constraint(owner, amount > 0n);
}
export interface Stamp { at: i64; slot: u64 }
export function stamp(payer: Mut<Signer>, stamp: Init<Stamp>, systemProgram: SystemProgram, not_before: u64): void {
  constraint(payer, currentSlot() >= not_before);
  stamp.create(payer, ["stamp", payer.key]);
  stamp.at = now();
  stamp.slot = currentSlot();
}
`;

describe("constraint(account, condition, error?)", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-constraint-"));
    writeFileSync(path.join(dir, "c.ts"), SOURCE);
    d = await deployFile(path.join(dir, "c.ts"));
  });

  it("runs with its account's checks, in Anchor's order, with the given error or ConstraintRaw", async () => {
    const owner = await fundedSigner(d.svm);
    const [vault] = await pda(d.programId, ["vault", owner.address]);
    const open = ix(d, "open", { limit: new BN(100) }, [
      { address: owner.address, signer: owner, writable: true },
      { address: vault, writable: true },
      { address: SYSTEM_PROGRAM },
    ]);
    expectOk(await send(d.svm, owner, [open]));
    const spend = (signer: typeof owner, amount: number) =>
      ix(d, "spend", { amount: new BN(amount) }, [{ address: vault }, { address: signer.address, signer }]);
    expectOk(await send(d.svm, owner, [spend(owner, 100)]));
    expect(customError(await send(d.svm, owner, [spend(owner, 101)]))).toBe(6000); // the given error
    expect(customError(await send(d.svm, owner, [spend(owner, 0)]))).toBe(2003); // ConstraintRaw
    // has_one comes before the vault's constraint (2001), and the vault's before the owner's.
    const other = await fundedSigner(d.svm);
    expect(customError(await send(d.svm, other, [spend(other, 101)]))).toBe(2001);
  });

  it("reads the Clock in a constraint and again in the body", async () => {
    const payer = await fundedSigner(d.svm);
    const [stamp] = await pda(d.programId, ["stamp", payer.address]);
    const call = (notBefore: bigint) =>
      ix(d, "stamp", { not_before: new BN(notBefore.toString()) }, [
        { address: payer.address, signer: payer, writable: true },
        { address: stamp, writable: true },
        { address: SYSTEM_PROGRAM },
      ]);
    const clock = d.svm.getClock();
    expect(customError(await send(d.svm, payer, [call(clock.slot + 1n)]))).toBe(2003);
    expectOk(await send(d.svm, payer, [call(clock.slot)]));
    const account = d.svm.getAccount(stamp);
    if (!account.exists) throw new Error("no stamp");
    const data = Buffer.from(account.data);
    expect(data.readBigInt64LE(8)).toBe(clock.unixTimestamp);
    expect(data.readBigUInt64LE(16)).toBe(clock.slot);
  });

  it("is refused anywhere but the start of an instruction, and needs an account parameter", () => {
    const head = `import { type Signer, type u64, constraint, require } from "typesol";\n`;
    expect(compileErrors(`${head}export function f(s: Signer, n: u64): void { require(n > 0n, "x"); constraint(s, n > 1n); }`)).toMatch(
      /at the start of an instruction/,
    );
    expect(compileErrors(`${head}export function f(s: Signer, n: u64): void { constraint(null, n > 1n); }`)).toMatch(/account parameter/);
    expect(compileErrors(`${head}function g(s: Signer): void { constraint(s, true); }\nexport function f(s: Signer): void { g(s); }`)).toMatch(
      /at the start of an instruction/,
    );
  });
});
