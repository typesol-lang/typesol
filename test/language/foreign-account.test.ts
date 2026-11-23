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
const SOURCE = `import { type Account, type AccountInfo, type FixedString, type HasOne, type Owner, type Pubkey, type Vec, type u16, type u8, byteLength, u64, require } from "typesol";

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

/**
 * @layout borsh
 * @discriminator 0x07
 */
export interface Tagged {
  v: u8;
  name: FixedString<8>;
}

/**
 * @layout borsh
 * @discriminator 0x0a0b0c
 */
export interface Tagged3 {
  v: u64;
}

export function tagged(t: Owner<Account<Tagged>, "${OTHER}">, want: u8, len: u64): void {
  require(t.v === want, E.WrongMint);
  require(byteLength(t.name) === len, E.WrongMint);
}

export function tagged3(t: Owner<Account<Tagged3>, "${OTHER}">, want: u64): void {
  require(t.v === want, E.WrongMint);
}

/** @discriminator 0x05 */
export interface Listed {
  n: u8;
  xs: Vec<u64>;
}

export function listed(l: Owner<Account<Listed>, "${OTHER}">, count: u64, last: u64): void {
  require(l.xs.length === count, E.WrongMint);
  require(l.xs.get(l.xs.length - 1n) === last, E.WrongMint);
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

  it("decodes a @layout borsh account of another program right after a discriminator shorter than 8 bytes", async () => {
    const payer = await fundedSigner(d.svm);
    const account = (await fundedSigner(d.svm)).address;
    const put = (bytes: number[], owner = OTHER) =>
      d.svm.setAccount({
        address: account,
        data: new Uint8Array(bytes),
        executable: false,
        lamports: lamports(10_000_000n),
        programAddress: owner as Address,
        space: BigInt(bytes.length),
      });
    const tagged = (want: number, len: number) => ix(d, "tagged", { want, len: new BN(len) }, [{ address: account }]);
    // [discriminator 7][v][name: u32 length, bytes]: v and the name are read from offset 1, not 8.
    put([7, 42, 2, 0, 0, 0, 0x61, 0x62]);
    expectOk(await send(d.svm, payer, [tagged(42, 2)]));
    expect(customError(await send(d.svm, payer, [tagged(43, 2)]))).toBe(6000);
    // The smallest Borsh form (an empty name): 1 + 1 + 4 bytes; one byte less is too small (3003).
    put([7, 9, 0, 0, 0, 0]);
    expectOk(await send(d.svm, payer, [tagged(9, 0)]));
    put([7, 9, 0, 0, 0]);
    expect(customError(await send(d.svm, payer, [tagged(9, 0)]))).toBe(3003);
    // A name longer than the account holds is not a valid Borsh value (3003), whatever lies past the data.
    put([7, 9, 4, 0, 0, 0, 0x61]);
    expect(customError(await send(d.svm, payer, [tagged(9, 4)]))).toBe(3003);
    put([8, 42, 0, 0, 0, 0]);
    expect(customError(await send(d.svm, payer, [tagged(42, 0)]))).toBe(3002);
    put([], OTHER);
    expect(customError(await send(d.svm, payer, [tagged(42, 0)]))).toBe(3001);
    // Three bytes of discriminator, a u64 after them.
    const v = Buffer.alloc(8);
    v.writeBigUInt64LE(0x0102_0304_0506_0708n);
    put([0x0a, 0x0b, 0x0c, ...v]);
    expectOk(await send(d.svm, payer, [ix(d, "tagged3", { want: new BN("0102030405060708", 16) }, [{ address: account }])]));
    put([0x0a, 0x0b, 0x0c, ...v.subarray(0, 7)]);
    expect(customError(await send(d.svm, payer, [ix(d, "tagged3", { want: new BN("0102030405060708", 16) }, [{ address: account }])]))).toBe(3003);
  });

  it("checks a growable Vec's length against the account's size after a shorter discriminator", async () => {
    const payer = await fundedSigner(d.svm);
    const account = (await fundedSigner(d.svm)).address;
    const put = (bytes: Buffer) =>
      d.svm.setAccount({
        address: account,
        data: new Uint8Array(bytes),
        executable: false,
        lamports: lamports(10_000_000n),
        programAddress: OTHER as Address,
        space: BigInt(bytes.length),
      });
    // [5][n][len: u32][len × u64]: exactly 1 + 1 + 4 + 8 × len bytes.
    const body = (xs: bigint[], extra = 0) => {
      const b = Buffer.alloc(6 + 8 * xs.length + extra);
      b[0] = 5;
      b[1] = 1;
      b.writeUInt32LE(xs.length, 2);
      xs.forEach((x, i) => b.writeBigUInt64LE(x, 6 + 8 * i));
      return b;
    };
    const listed = (count: number, last: number) => ix(d, "listed", { count: new BN(count), last: new BN(last) }, [{ address: account }]);
    put(body([3n, 4n]));
    expectOk(await send(d.svm, payer, [listed(2, 4)]));
    put(body([3n, 4n, 9n]));
    expectOk(await send(d.svm, payer, [listed(3, 9)]));
    put(body([3n, 4n], 1));
    expect(customError(await send(d.svm, payer, [listed(2, 4)]))).toBe(3003);
  });

  it("refuses a shorter discriminator on this program's own account", () => {
    const head = `import { type Account, type u64 } from "typesol";\n/**\n * @discriminator 0x01\n */\nexport interface R { slot: u64 }\n`;
    expect(compileErrors(`${head}export function f(r: Account<R>): void {}`)).toMatch(/shorter than 8 bytes/);
    // initAccount writes this program's 8-byte discriminator: refused too.
    expect(
      compileErrors(
        `import { type Mut, type AccountInfo, type u64, initAccount } from "typesol";\n/**\n * @discriminator 0x01\n */\nexport interface R { slot: u64 }\nexport function f(a: Mut<AccountInfo>): void { const r = initAccount<R>(a); r.slot = 1n; }`,
      ),
    ).toMatch(/shorter than 8 bytes/);
  });
});
