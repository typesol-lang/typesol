import { getCreateAccountInstruction } from "@solana-program/system";
import * as t22 from "@solana-program/token-2022";
import { type Address, AccountRole, generateKeyPairSigner, lamports } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed, TOKEN_2022 } from "../harness.js";

describe("Token-2022 transfer hook written in TypeSOL (test/fixtures/hook.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/hook.ts", import.meta.url)));
  });

  it("Token-2022 calls the hook on every transfer; the hook blocks large ones", async () => {
    const { svm } = d;
    const admin = await fundedSigner(svm, 20n);
    const mint = await generateKeyPairSigner();
    const space = t22.getMintSize([{ __kind: "TransferHook", authority: admin.address, programId: d.programId }]);
    expectOk(
      await send(svm, admin, [
        getCreateAccountInstruction({
          payer: admin,
          newAccount: mint,
          lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(space))),
          space,
          programAddress: TOKEN_2022,
        }),
        t22.getInitializeTransferHookInstruction({ mint: mint.address, authority: admin.address, programId: d.programId }),
        t22.getInitializeMint2Instruction({ mint: mint.address, decimals: 0, mintAuthority: admin.address }),
      ]),
    );
    // The validation account, created by the hook program itself.
    const [extraMetas] = await pda(d.programId, ["extra-account-metas", mint.address]);
    const initData = Uint8Array.from([43, 34, 13, 49, 167, 88, 235, 235, 0, 0, 0, 0]); // discriminator + empty Vec
    expectOk(
      await send(svm, admin, [
        {
          programAddress: d.programId,
          accounts: [
            { address: admin.address, role: AccountRole.WRITABLE_SIGNER, signer: admin },
            { address: extraMetas, role: AccountRole.WRITABLE },
            { address: mint.address, role: AccountRole.READONLY },
            { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
          ],
          data: initData,
        } as never,
      ]),
    );
    expect(Buffer.from((svm.getAccount(extraMetas) as { data: Uint8Array }).data)).toEqual(
      Buffer.from([105, 37, 101, 197, 75, 251, 102, 26, 4, 0, 0, 0, 0, 0, 0, 0]),
    );

    const alice = await fundedSigner(svm);
    const bob = await generateKeyPairSigner();
    const ata = async (owner: Address) => {
      const c = await t22.getCreateAssociatedTokenIdempotentInstructionAsync({ payer: admin, owner, mint: mint.address, tokenProgram: TOKEN_2022 });
      expectOk(await send(svm, admin, [c]));
      return c.accounts[1].address as Address;
    };
    const [from, to] = [await ata(alice.address), await ata(bob.address)];
    expectOk(await send(svm, admin, [t22.getMintToInstruction({ mint: mint.address, token: from, mintAuthority: admin, amount: 5000n })]));

    const transfer = (amount: bigint) => {
      const base = t22.getTransferCheckedInstruction({ source: from, mint: mint.address, destination: to, authority: alice, amount, decimals: 0 });
      // Token-2022 needs the hook program and its validation account appended.
      return {
        ...base,
        accounts: [...base.accounts, { address: d.programId, role: AccountRole.READONLY }, { address: extraMetas, role: AccountRole.READONLY }],
      };
    };
    expectOk(await send(svm, alice, [transfer(700n) as never]));
    expect(customError(await send(svm, alice, [transfer(1500n) as never]))).toBe(6000);
    const bal = (a: Address) => Buffer.from((svm.getAccount(a) as { data: Uint8Array }).data).readBigUInt64LE(64);
    expect([bal(from), bal(to)]).toEqual([4300n, 700n]);
  });
});

// updateExtraAccountMetas grows the list at most 10 KiB past the account's length when the instruction started (the
// room the runtime leaves after each account), not past its current length: after resizeAccount(+10240), 10 KiB more
// would write into the next account's record.
describe("updateExtraAccountMetas and the 10 KiB growth limit", () => {
  const list = (n: number) =>
    `[${Array.from({ length: n }, () => `{ seeds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], isSigner: false, isWritable: false }`).join(", ")}]`;
  const source = (
    n: number,
  ) => `import { type AccountInfo, type Mut, type Signer, type SystemProgram, initExtraAccountMetas, updateExtraAccountMetas, resizeAccount } from "typesol";
export function setup(payer: Mut<Signer>, mint: AccountInfo, metas: Mut<AccountInfo>, systemProgram: SystemProgram): void { initExtraAccountMetas(payer, metas, mint, systemProgram, []); }
export function grow(payer: Mut<Signer>, mint: AccountInfo, metas: Mut<AccountInfo>, systemProgram: SystemProgram, first: boolean): void {
  if (first) resizeAccount(metas, metas.dataLen + 10240n);
  updateExtraAccountMetas(payer, metas, mint, systemProgram, ${list(n)});
  updateExtraAccountMetas(payer, metas, mint, systemProgram, []);
}
function update(payer: Mut<Signer>, metas: Mut<AccountInfo>, mint: AccountInfo, systemProgram: SystemProgram): void { updateExtraAccountMetas(payer, metas, mint, systemProgram, ${list(n)}); }
export function viaHelper(payer: Mut<Signer>, mint: AccountInfo, metas: Mut<AccountInfo>, systemProgram: SystemProgram): void {
  resizeAccount(metas, metas.dataLen + 10240n);
  update(payer, metas, mint, systemProgram);
}
`;
  it("counts from the length at entry, in an instruction and in a helper (3016)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-extra-metas-"));
    const data = Buffer.alloc(5);
    data[0] = 2; // ComputeBudget SetComputeUnitLimit
    data.writeUInt32LE(1_400_000, 1);
    const cuLimit = { programAddress: "ComputeBudget111111111111111111111111111111" as Address, accounts: [], data: new Uint8Array(data) };
    // 292 records end within 10 KiB of the 16-byte list; 293 end past it.
    for (const [n, fits] of [
      [292, true],
      [293, false],
    ] as const) {
      writeFileSync(path.join(dir, `m${n}.ts`), source(n));
      const d = await deployFile(path.join(dir, `m${n}.ts`));
      const payer = await fundedSigner(d.svm, 20n);
      const mint = (await generateKeyPairSigner()).address;
      const [metas] = await pda(d.programId, ["extra-account-metas", mint]);
      const accounts = [
        { address: payer.address, signer: payer, writable: true },
        { address: mint },
        { address: metas, writable: true },
        { address: SYSTEM_PROGRAM },
      ];
      expectOk(await send(d.svm, payer, [ix(d, "setup", {}, accounts)]));
      for (const first of [false, true]) {
        d.svm.expireBlockhash();
        const r = await send(d.svm, payer, [cuLimit as never, ix(d, "grow", { first }, accounts)]);
        // The same limit whether or not resizeAccount grew the account first (it then ends past 10 KiB: 10256).
        if (fits) expectOk(r);
        else expect(customError(r)).toBe(3016);
      }
      d.svm.expireBlockhash();
      const helper = await send(d.svm, payer, [cuLimit as never, ix(d, "via_helper", {}, accounts)]);
      if (fits) expectOk(helper);
      else expect(customError(helper)).toBe(3016);
    }
  });
});
