// Which error a transaction that breaks several checks gets: each account's constraints in the order of Anchor's
// generated try_accounts (anchor-syn's linearize), and Anchor's codes (docs/errors.md, "Which error a transaction gets").
import { type Address, getU64Encoder, lamports } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const SOURCE = `import { type HasOne, type Init, type Mut, type Pubkey, type Seeds, type Signer, type SystemProgram, type u8, type u64 } from "typesol";
export interface Box { owner: Pubkey; id: u64; bump: u8; }
export function open(owner: Mut<Signer>, box: Init<Box>, systemProgram: SystemProgram, id: u64): void {
  box.bump = box.create(owner, ["box", owner.key, id]);
  box.owner = owner.key;
  box.id = id;
}
export function bump(owner: Signer, box: Seeds<HasOne<Mut<Box>, "owner">, ["box", "@owner", "@box.id"], "bump">, by: u64): void {
  box.id = box.id + by - by;
}
`;

describe("check order (Anchor's)", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-order-"));
    writeFileSync(path.join(dir, "order.ts"), SOURCE);
    d = await deployFile(path.join(dir, "order.ts"));
  });

  it("a read-only Mut (2000, ConstraintMut), seeds before has_one (2006)", async () => {
    const owner = await fundedSigner(d.svm);
    const [box] = await pda(d.programId, ["box", owner.address, new Uint8Array(getU64Encoder().encode(1n))]);
    const O = { address: owner.address, signer: owner, writable: true };
    expectOk(await send(d.svm, owner, [ix(d, "open", { id: new BN(1) }, [O, { address: box, writable: true }, { address: SYSTEM_PROGRAM }])]));
    const call = (accounts: Parameters<typeof ix>[3], data?: Uint8Array) => {
      const i = ix(d, "bump", { by: new BN(1) }, accounts);
      return send(d.svm, owner, [data ? { ...i, data: data.slice() } : i]);
    };
    expectOk(await call([O, { address: box, writable: true }]));
    // The box passed read-only: ConstraintMut, as Anchor's #[account(mut)].
    expect(customError(await call([O, { address: box }]))).toBe(2000);
    // Another signer: the seeds (derived from the signer) fail before has_one.
    const mallory = await fundedSigner(d.svm);
    const M = { address: mallory.address, signer: mallory };
    expect(customError(await send(d.svm, mallory, [ix(d, "bump", { by: new BN(1) }, [M, { address: box, writable: true }])]))).toBe(2006);
  });

  // runtime/typesol_rt.h ts_check_program_account: 3012, 3007, then the size (3003) before the discriminator (3002).
  // Anchor's Account::try_from reads the discriminator first (3001 under 8 bytes, 3002), then decodes (3003), so the
  // two short cases below get 3003 here and 3001 / 3002 under Anchor (docs/errors.md).
  it("a program account: not initialized (3012), owner (3007), size (3003), then discriminator (3002)", async () => {
    const owner = await fundedSigner(d.svm);
    const box = (await fundedSigner(d.svm)).address;
    const put = (data: Buffer, programAddress: string, amount = 10_000_000n) =>
      d.svm.setAccount({
        address: box,
        data: new Uint8Array(data),
        executable: false,
        lamports: lamports(amount),
        programAddress: programAddress as Address,
        space: BigInt(data.length),
      });
    const call = () =>
      send(d.svm, owner, [
        ix(d, "bump", { by: new BN(1) }, [
          { address: owner.address, signer: owner },
          { address: box, writable: true },
        ]),
      ]);
    const full = 8 + 32 + 8 + 1;
    put(Buffer.alloc(0), SYSTEM_PROGRAM, 0n);
    expect(customError(await call())).toBe(3012);
    put(Buffer.alloc(full), SYSTEM_PROGRAM);
    expect(customError(await call())).toBe(3007);
    // Another discriminator and fewer bytes than Box: the size fails first.
    put(Buffer.alloc(full - 1, 7), d.programId);
    expect(customError(await call())).toBe(3003);
    put(Buffer.alloc(4, 7), d.programId);
    expect(customError(await call())).toBe(3003);
    // Another discriminator at full size.
    put(Buffer.alloc(full, 7), d.programId);
    expect(customError(await call())).toBe(3002);
  });
});
