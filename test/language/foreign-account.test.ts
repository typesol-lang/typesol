// Owner<Account<T>, "…">: a struct account of another program (Anchor's Account / AccountLoader of a
// declare_program! type), loaded with that program as its owner (3007 otherwise), its discriminator Anchor's for T's
// name, and usable with HasOne and its fields as any account.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Address, getAddressEncoder, lamports } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const OTHER = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";
const SOURCE = `import { type Account, type AccountInfo, type HasOne, type Owner, type Pubkey, type u16, type u8, u64, require } from "typesol";

/**
 * @repr c packed
 * @serialization bytemuck
 */
export interface Lending {
  mint: Pubkey;
  id: u16;
  decimals: u8;
  price: u64;
}

export enum E {
  WrongMint = "wrong mint",
}

/**
 * @repr c packed
 * @serialization bytemuck
 * @discriminator 0x01
 */
export interface Reserve {
  slot: u64;
  mint: Pubkey;
}

export function check(reserve: Owner<Account<Reserve>, "${OTHER}">, slot: u64): void {
  require(reserve.slot === slot, E.WrongMint);
}

export function read(lending: HasOne<Owner<Account<Lending>, "${OTHER}">, "mint", E.WrongMint>, mint: AccountInfo): u64 {
  return lending.price + u64(lending.decimals);
}
`;

const key = (a: Address) => Buffer.from(getAddressEncoder().encode(a));

describe('Owner<Account<T>, "…">', () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-foreign-account-"));
    writeFileSync(path.join(dir, "a.ts"), SOURCE);
    d = await deployFile(path.join(dir, "a.ts"));
  });

  it("loads another program's account and checks it as Anchor's AccountLoader does", async () => {
    const payer = await fundedSigner(d.svm);
    const mint = (await fundedSigner(d.svm)).address;
    const put = (disc = createHash("sha256").update("account:Lending").digest().subarray(0, 8), m = mint) => {
      const at = Buffer.alloc(8 + 32 + 2 + 1 + 8);
      disc.copy(at, 0);
      key(m).copy(at, 8);
      at[42] = 6;
      at.writeBigUInt64LE(1_000n, 43);
      return at;
    };
    const lending = (await fundedSigner(d.svm)).address;
    const set = (data: Buffer, owner: string) =>
      d.svm.setAccount({
        address: lending,
        data: new Uint8Array(data),
        executable: false,
        lamports: lamports(10_000_000n),
        programAddress: owner as Address,
        space: BigInt(data.length),
      });
    const read = () => ix(d, "read", {}, [{ address: lending }, { address: mint }]);
    set(put(), OTHER);
    expectOk(await send(d.svm, payer, [read()]));
    set(put(), d.programId);
    expect(customError(await send(d.svm, payer, [read()]))).toBe(3007);
    set(put(Buffer.alloc(8)), OTHER);
    expect(customError(await send(d.svm, payer, [read()]))).toBe(3002);
    set(put(undefined, payer.address), OTHER);
    expect(customError(await send(d.svm, payer, [read()]))).toBe(6000);
    // Anchor's IDL lists another program's type among the types, not the accounts.
    expect(d.idl.accounts ?? []).toEqual([]);
    expect(d.idl.types!.map((t) => t.name)).toContain("Lending");
  });

  it("takes a shorter discriminator for another program's account, its fields after it", async () => {
    const payer = await fundedSigner(d.svm);
    const reserve = (await fundedSigner(d.svm)).address;
    const put = (data: Buffer, owner: string) =>
      d.svm.setAccount({
        address: reserve,
        data: new Uint8Array(data),
        executable: false,
        lamports: lamports(10_000_000n),
        programAddress: owner as Address,
        space: BigInt(data.length),
      });
    const body = (version: number, slot: bigint, len = 1 + 8 + 32) => {
      const b = Buffer.alloc(len);
      b[0] = version;
      if (len >= 9) b.writeBigUInt64LE(slot, 1);
      return b;
    };
    const check = (slot: bigint) => ix(d, "check", { slot: new BN(slot.toString()) }, [{ address: reserve }]);
    put(body(1, 77n), OTHER);
    expectOk(await send(d.svm, payer, [check(77n)]));
    expect(customError(await send(d.svm, payer, [check(78n)]))).toBe(6000);
    put(body(1, 77n), d.programId);
    expect(customError(await send(d.svm, payer, [check(77n)]))).toBe(3007);
    put(Buffer.alloc(0), OTHER);
    expect(customError(await send(d.svm, payer, [check(77n)]))).toBe(3001);
    put(body(2, 77n), OTHER);
    expect(customError(await send(d.svm, payer, [check(77n)]))).toBe(3002);
    put(body(1, 77n, 20), OTHER);
    expect(customError(await send(d.svm, payer, [check(77n)]))).toBe(3003);
  });

  it("refuses a shorter discriminator on this program's own account", () => {
    const head = `import { type Account, type u64 } from "typesol";\n/**\n * @discriminator 0x01\n */\nexport interface R { slot: u64 }\n`;
    expect(compileErrors(`${head}export function f(r: Account<R>): void {}`)).toMatch(/shorter than 8 bytes/);
  });
});
