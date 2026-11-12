// Seed lists at Solana's limit: 16 seeds per address, the bump included (MAX_SEEDS in solana-pubkey, checked by the
// runtime's invoke_signed and create_program_address). Signer seeds and createProgramAddress lists end with their
// bump, so they take 16 entries; a list the derivation adds the bump to (create, requirePda, findProgramAddress)
// takes 15.
import { type Address, type KeyPairSigner, generateKeyPairSigner, getAddressDecoder, getProgramDerivedAddress, lamports } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, acct, compileErrors, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";
import { pk } from "../ports-helpers.js";

const SEEDS = "abcdefghijklmno".split("");
const list = (n: number) => Array.from({ length: n }, (_, i) => `"s${i}"`).join(", ");
const HEADER = `import { type AccountInfo, type Mut, type Pubkey, type SystemProgram, type u8, createProgramAddress, findProgramAddress, signer } from "typesol";\n`;

describe("signer seeds at Solana's limit (test/fixtures/signer-seed-limit.ts)", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let vault: Address;
  let bump: number;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/signer-seed-limit.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 5n);
    [vault, bump] = await getProgramDerivedAddress({ programAddress: d.programId, seeds: SEEDS });
    d.svm.airdrop(vault, lamports(2_000_000_000n));
  });

  for (const name of ["withdraw", "withdraw_bound"]) {
    it(`signs a CPI with 15 seeds and the bump (${name})`, async () => {
      const to = (await fundedSigner(d.svm, 1n)).address;
      const before = acct(d.svm, to).lamports;
      expectOk(
        await send(d.svm, payer, [
          ix(d, name, { bump, amount: new BN(1_000_000) }, [{ address: vault, writable: true }, { address: to, writable: true }, { address: SYSTEM_PROGRAM }]),
        ]),
      );
      expect(acct(d.svm, to).lamports - before).toBe(1_000_000n);
    });
  }

  it("gives create_program_address 16 seeds, the bump last", async () => {
    const program = (await generateKeyPairSigner()).address;
    const [expected, b] = await getProgramDerivedAddress({ programAddress: program, seeds: SEEDS });
    const ok = expectOk(await send(d.svm, payer, [ix(d, "address", { program: pk(program), bump: b }, [])]));
    expect(getAddressDecoder().decode(ok.returnData().data())).toBe(expected);
  });

  it("refuses a 17th entry in signer seeds and in createProgramAddress, and a 16th seed before a derived bump", () => {
    const transfer = (seeds: string) =>
      `${HEADER}export function f(v: Mut<AccountInfo>, t: Mut<AccountInfo>, s: SystemProgram, b: u8): void { s.transfer(v, t, 1n, [${seeds}]); }`;
    expect(compileErrors(transfer(`${list(15)}, b`))).toBe("");
    expect(compileErrors(transfer(`${list(16)}, b`))).toMatch(/at most 16 seeds, the bump included \(Solana's limit\)/);
    const bound = (seeds: string) =>
      `${HEADER}export function f(v: Mut<AccountInfo>, t: Mut<AccountInfo>, s: SystemProgram, b: u8): void { const x = signer([${seeds}]); s.transfer(v, t, 1n, x); }`;
    expect(compileErrors(bound(`${list(15)}, b`))).toBe("");
    expect(compileErrors(bound(`${list(16)}, b`))).toMatch(/at most 16 seeds, the bump included/);
    const cpa = (seeds: string) => `${HEADER}export function f(p: Pubkey, b: u8): void { const a = createProgramAddress([${seeds}], p); }`;
    expect(compileErrors(cpa(`${list(15)}, b`))).toBe("");
    expect(compileErrors(cpa(`${list(16)}, b`))).toMatch(/at most 16 seeds, the bump included/);
    const find = (n: number) => `${HEADER}export function f(p: Pubkey): Pubkey { return findProgramAddress([${list(n)}], p); }`;
    expect(compileErrors(find(15))).toBe("");
    expect(compileErrors(find(16))).toMatch(/at most 15 seeds: the bump the derivation adds makes 16, Solana's limit/);
  });
});
