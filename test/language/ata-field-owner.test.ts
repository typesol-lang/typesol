// Ata<TokenAccount, "@acct.field", "mint">: the associated token account of a Pubkey stored in a struct account
// (Anchor's `associated_token::authority = config.load()?.wallet`). The IDL records the account, as Anchor's does.
import { web3 } from "@anchor-lang/core";
import { type Address, getAddressEncoder, getProgramDerivedAddress, lamports } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ATA_PROGRAM,
  BN,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  compileErrors,
  customError,
  deployFile,
  expectOk,
  fundedSigner,
  ix,
  pda,
  send,
  type Deployed,
} from "../harness.js";

const SOURCE = `import { type Account, type Ata, type Init, type Mint, type Mut, type Pubkey, type Signer, type SystemProgram, type TokenAccount, type TokenInterface, type u64 } from "typesol";

export interface Config { wallet: Pubkey }

export function setup(payer: Mut<Signer>, config: Init<Config>, systemProgram: SystemProgram, wallet: Pubkey): void {
  config.create(payer, ["config"]);
  config.wallet = wallet;
}
export function pay(config: Account<Config>, mint: Mint, destination: Ata<Mut<TokenAccount>, "@config.wallet", "mint">, tokenProgram: TokenInterface): u64 {
  return destination.amount;
}
`;

const key = (a: Address) => Buffer.from(getAddressEncoder().encode(a));
const ata = async (owner: Address, mint: Address) =>
  (await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [key(owner), key(TOKEN_PROGRAM), key(mint)] }))[0];

describe('Ata<…, "@acct.field", …>', () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-ata-field-"));
    writeFileSync(path.join(dir, "a.ts"), SOURCE);
    d = await deployFile(path.join(dir, "a.ts"));
  });

  it("takes the owner from the struct's field and records the account in the IDL", async () => {
    const payer = await fundedSigner(d.svm);
    const wallet = (await fundedSigner(d.svm)).address;
    const [config] = await pda(d.programId, ["config"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", { wallet: new web3.PublicKey(wallet) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: config, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const mint = (await fundedSigner(d.svm)).address;
    const m = Buffer.alloc(82);
    m[45] = 1;
    d.svm.setAccount({ address: mint, data: new Uint8Array(m), executable: false, lamports: lamports(1_461_600n), programAddress: TOKEN_PROGRAM, space: 82n });
    const tokenAccount = (at: Address, owner: Address, amount: bigint) => {
      const t = Buffer.alloc(165);
      key(mint).copy(t, 0);
      key(owner).copy(t, 32);
      t.writeBigUInt64LE(amount, 64);
      t[108] = 1;
      d.svm.setAccount({ address: at, data: new Uint8Array(t), executable: false, lamports: lamports(2_039_280n), programAddress: TOKEN_PROGRAM, space: 165n });
      return at;
    };
    const pay = (destination: Address) =>
      ix(d, "pay", {}, [{ address: config }, { address: mint }, { address: destination, writable: true }, { address: TOKEN_PROGRAM }]);
    const right = tokenAccount(await ata(wallet, mint), wallet, 7n);
    expectOk(await send(d.svm, payer, [pay(right)]));
    // The payer's ATA is not the wallet's (owner first: 2015), nor one the wallet owns at another address (2009).
    const payers = tokenAccount(await ata(payer.address, mint), payer.address, 0n);
    expect(customError(await send(d.svm, payer, [pay(payers)]))).toBe(2015);
    const elsewhere = tokenAccount((await fundedSigner(d.svm)).address, wallet, 0n);
    expect(customError(await send(d.svm, payer, [pay(elsewhere)]))).toBe(2009);
    const entry = d.idl.instructions.find((i) => i.name === "pay")!.accounts.find((a) => a.name === "destination") as {
      pda: { seeds: { kind: string; path: string }[] };
    };
    expect(entry.pda.seeds).toEqual([
      { kind: "account", path: "config" },
      { kind: "account", path: "token_program" },
      { kind: "account", path: "mint" },
    ]);
    void BN;
  });

  it("needs a Pubkey field of a struct account parameter", () => {
    const head = `import { type Account, type Ata, type Mint, type Mut, type Pubkey, type TokenAccount, type TokenInterface, type u64 } from "typesol";\nexport interface Config { wallet: Pubkey; n: u64 }\n`;
    expect(
      compileErrors(
        `${head}export function f(config: Account<Config>, mint: Mint, d: Ata<Mut<TokenAccount>, "@config.n", "mint">, t: TokenInterface): void {}`,
      ),
    ).toMatch(/no Pubkey field "n"/);
    expect(compileErrors(`${head}export function f(mint: Mint, d: Ata<Mut<TokenAccount>, "@config.wallet", "mint">, t: TokenInterface): void {}`)).toMatch(
      /add an account parameter named "config"/,
    );
  });
});
