// tokenProgram.transferCheckedWithHook: a transfer by CPI of a Token-2022 mint with a transfer hook, the hook's extra
// accounts resolved from its validation account among the given remaining accounts as spl-transfer-hook-interface's
// add_extra_accounts_for_execute_cpi resolves them (its refusals and codes included). The hook here is a TypeSOL one
// whose list holds a fixed address, a literal PDA and a PDA from an account key and the instruction data; a plain mint
// gets a plain TransferChecked. showcase/test/meteora-dbc-hook.test.ts checks the same resolution against Meteora's
// Rust program, with every kind of meta and each refusal.
import { type Address, AccountRole, generateKeyPairSigner } from "@solana/kit";
import * as t22 from "@solana-program/token-2022";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, pda, send, SYSTEM_PROGRAM, TOKEN_2022, type Deployed } from "../harness.js";
import { ataFor, hookMint, validationAccount } from "../hook-helpers.js";

const RENT = "SysvarRent111111111111111111111111111111111" as Address;

const HOOK = `import { type AccountInfo, type Mint, type Mut, type Signer, type SystemProgram, type TokenAccount, type u64, initExtraAccountMetas, pubkey, require, seedAccountKey, seedInstructionData } from "typesol";
/** @discriminator spl-transfer-hook-interface:initialize-extra-account-metas */
export function initializeExtraAccountMetaList(payer: Mut<Signer>, extraMetas: Mut<AccountInfo>, mint: Mint, systemProgram: SystemProgram): void {
  initExtraAccountMetas(payer, extraMetas, mint, systemProgram, [
    { address: pubkey("${RENT}") },
    { seeds: ["fixed"] },
    { seeds: [seedAccountKey(2n), seedInstructionData(8n, 8n)], isWritable: true },
  ]);
}
/** @discriminator spl-transfer-hook-interface:execute */
export function execute(source: TokenAccount, mint: Mint, destination: TokenAccount, owner: AccountInfo, extraMetas: AccountInfo, rent: AccountInfo, fixed: AccountInfo, byDestination: AccountInfo, amount: u64): void {
  require(amount !== 13n, "13");
}
`;

const CALLER = `import { type Mint, type Mut, type Signer, type TokenAccount, type TokenInterface, type u64, remainingAccounts } from "typesol";
export function send(from: Mut<TokenAccount>, mint: Mint, to: Mut<TokenAccount>, owner: Signer, tokenProgram: TokenInterface, amount: u64): void {
  tokenProgram.transferCheckedWithHook(from, mint, to, owner, amount, remainingAccounts());
}
export function sendTail(from: Mut<TokenAccount>, mint: Mint, to: Mut<TokenAccount>, owner: Signer, tokenProgram: TokenInterface, amount: u64, skip: u64): void {
  tokenProgram.transferCheckedWithHook(from, mint, to, owner, amount, remainingAccounts().slice(skip));
}
`;

describe("transferCheckedWithHook", () => {
  let hook: Deployed;
  let caller: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-hook-cpi-"));
    writeFileSync(path.join(dir, "hook.ts"), HOOK);
    writeFileSync(path.join(dir, "caller.ts"), CALLER);
    hook = await deployFile(path.join(dir, "hook.ts"));
    caller = await deployFile(path.join(dir, "caller.ts"), { svm: hook.svm });
  });

  it("resolves the hook's extra accounts among the remaining accounts, in the list's order", async () => {
    const { svm } = hook;
    const admin = await fundedSigner(svm, 20n);
    const mint = await hookMint(svm, admin, hook.programId);
    const metas = await validationAccount(hook.programId, mint);
    expectOk(
      await send(svm, admin, [
        {
          programAddress: hook.programId,
          accounts: [
            { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin },
            { address: metas, role: AccountRole.WRITABLE },
            { address: mint, role: AccountRole.READONLY },
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
          ],
          data: Uint8Array.from([43, 34, 13, 49, 167, 88, 235, 235, 0, 0, 0, 0]),
        } as never,
      ]),
    );
    const alice = await fundedSigner(svm);
    const bob = (await generateKeyPairSigner()).address;
    const from = await ataFor(svm, admin, alice.address, mint, 5000n);
    const to = await ataFor(svm, admin, bob, mint, 0n);
    const [fixed] = await pda(hook.programId, ["fixed"]);
    const byDestination = async (amount: bigint) => {
      const le = Buffer.alloc(8);
      le.writeBigUInt64LE(amount);
      return (await pda(hook.programId, [to, new Uint8Array(le)]))[0];
    };
    const call = async (name: string, amount: bigint, rest: { address: Address; writable?: boolean }[], args: Record<string, unknown> = {}) =>
      send(svm, alice, [
        ix(caller, name, { amount: new BN(amount.toString()), ...args }, [
          { address: from, writable: true },
          { address: mint },
          { address: to, writable: true },
          { address: alice.address, signer: alice },
          { address: TOKEN_2022 },
          ...rest,
        ]),
      ]);
    const all = async (amount: bigint) => [
      { address: hook.programId },
      { address: await byDestination(amount), writable: true },
      { address: fixed },
      { address: metas },
      { address: RENT },
    ];
    expectOk(await call("send", 700n, await all(700n)));
    // a slice of the remaining accounts, past an unrelated one
    expectOk(await call("send_tail", 300n, [{ address: SYSTEM_PROGRAM }, ...(await all(300n))], { skip: new BN(1) }));
    const bal = (a: Address) => Buffer.from((svm.getAccount(a) as { data: Uint8Array }).data).readBigUInt64LE(64);
    expect([bal(from), bal(to)]).toEqual([4000n, 1000n]);
    // the refusals of add_extra_accounts_for_execute_cpi: no hook program (TransferHookError::IncorrectAccount), an
    // extra account missing (AccountResolutionError::IncorrectAccount); the hook's own refusal goes through
    expect(customError(await call("send", 10n, (await all(10n)).slice(1)))).toBe(2_110_272_652);
    expect(
      customError(
        await call(
          "send",
          10n,
          (await all(10n)).filter((a) => a.address !== fixed),
        ),
      ),
    ).toBe(2_724_315_840);
    expect(customError(await call("send", 13n, await all(13n)))).toBe(6000);
  });

  it("a mint without a hook: a plain TransferChecked", async () => {
    const svm = caller.svm;
    const admin = await fundedSigner(svm, 20n);
    const m = await generateKeyPairSigner();
    const { getCreateAccountInstruction } = await import("@solana-program/system");
    expectOk(
      await send(svm, admin, [
        getCreateAccountInstruction({ payer: admin, newAccount: m, lamports: svm.minimumBalanceForRentExemption(82n), space: 82, programAddress: TOKEN_2022 }),
        t22.getInitializeMint2Instruction({ mint: m.address, decimals: 2, mintAuthority: admin.address }),
      ] as never),
    );
    const alice = await fundedSigner(svm);
    const from = await ataFor(svm, admin, alice.address, m.address, 100n);
    const to = await ataFor(svm, admin, (await generateKeyPairSigner()).address, m.address, 0n);
    expectOk(
      await send(svm, alice, [
        ix(caller, "send", { amount: new BN(40) }, [
          { address: from, writable: true },
          { address: m.address },
          { address: to, writable: true },
          { address: alice.address, signer: alice },
          { address: TOKEN_2022 },
        ]),
      ]),
    );
  });

  it("takes the remaining accounts or a slice of them", () => {
    const errors = compileErrors(`import { type Mint, type Mut, type Signer, type TokenAccount, type TokenInterface, type u64 } from "typesol";
export function f(from: Mut<TokenAccount>, mint: Mint, to: Mut<TokenAccount>, owner: Signer, tokenProgram: TokenInterface, amount: u64): void {
  tokenProgram.transferCheckedWithHook(from, mint, to, owner, amount, from as never);
}`);
    expect(errors).toContain("pass the hook's accounts as remainingAccounts() or rest.slice(a, b)");
  });
});
