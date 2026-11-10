// Forms native ports write as the Rust reads (test/fixtures/port-syntax.ts): comma-separated for-loop updates and
// initializers.
import { generateKeyPairSigner } from "@solana/kit";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, compileErrors, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

describe("port syntax", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/port-syntax.ts", import.meta.url)));
  });
  const u64 = async (name: string, args: Record<string, unknown>) => {
    const payer = await fundedSigner(d.svm);
    return Buffer.from(
      expectOk(await send(d.svm, payer, [ix(d, name, args, [])]))
        .returnData()
        .data(),
    ).readBigUInt64LE(0);
  };

  it("runs every comma-separated update in order, after continue too", async () => {
    // i, j = 0, 9 → 1, 8 → … : 9 + 7 + 5 + 3 + 1
    expect(await u64("meet", { n: new BN(9), skip: new BN(99) })).toBe(25n);
    // skipping i = 1 (j = 8) still steps both counters
    expect(await u64("meet", { n: new BN(9), skip: new BN(1) })).toBe(18n);
    // the initializer's two assignments, then j += i after each i++: 1 + 2 + 3 + 4 + 5
    expect(await u64("triangle", { n: new BN(5) })).toBe(15n);
  });

  it("a local list may hold 2 KiB of elements, its length word aside", async () => {
    // 0 + 3 + … + 3 × 511, plus the length
    expect(await u64("collect", { n: new BN(512) })).toBe(3n * ((511n * 512n) / 2n) + 512n);
    const f = (decl: string) =>
      compileErrors(`import { type FixedVec, type u8, fixedVec, log } from "typesol";\nexport function f(): void {\n  ${decl}\n  log(xs.length);\n}`);
    expect(f(`const xs: FixedVec<u8, 2049> = fixedVec([]);`)).toContain(
      "FixedVec<u8, 2049> takes 2053 bytes; locals live on the 4 KiB stack, so keep it under 2 KiB of elements (2049 here: a smaller FixedVec<T, N>, or /** @heap */ on the declaration to keep it on the heap)",
    );
    expect(f(`/** @heap */ const xs: FixedVec<u8, 2049> = fixedVec([]);`)).toBe("");
  });

  it("reads a field through a read-only view without binding it", async () => {
    const market = (await generateKeyPairSigner()).address;
    const data = Buffer.alloc(24 + 32 + 2 * 32);
    data.writeBigUInt64LE(5n, 8); // inner.a
    data.writeBigUInt64LE(7n, 16); // inner.b
    data.writeBigUInt64LE(1n, 24 + 16); // the tree's size
    d.svm.setAccount({ address: market, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data } as never);
    const payer = await fundedSigner(d.svm);
    const r = expectOk(await send(d.svm, payer, [ix(d, "peek", {}, [{ address: market, writable: false }])]));
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE(0)).toBe(7512n);
    const f = (body: string) =>
      compileErrors(`import { type AccountInfo, type Mut, type u64, loadRawMut, rbTreeMutAt, log } from "typesol";
export interface H { x: u64; y: u64; }
export function f(m: Mut<AccountInfo>): void { ${body} }`);
    expect(f(`log(loadRawMut<H>(m).x);`)).toContain(
      "bind loadRawMut(…) to a const first, as a writable view claims its account once per instruction: const v = loadRawMut<…>(account)",
    );
    expect(f(`log(rbTreeMutAt<u64, u64>(m, 0n, 2n).length);`)).toContain("bind rbTreeMutAt(…) to a const first");
  });

  it("a struct that is not exported serves helpers and stays out of the IDL", async () => {
    expect(await u64("pairs", { x: new BN(5) })).toBe(15n + 6n + 2n);
    const types = (d.idl.types ?? []).map((t) => t.name);
    expect(types).toContain("Header");
    expect(types).not.toContain("Pair");
    const f = (body: string) =>
      compileErrors(`import { type Account, type Mut, type Signer, type u64, emit } from "typesol";
interface Pair { a: u64; b: u64; }
${body}`);
    const fix = (what: string) => `Pair is not exported, but ${what} uses it, which puts it in the IDL: export interface Pair`;
    expect(f(`export function g(p: Pair): void {}`)).toBe(fix("an instruction's arguments or result"));
    expect(f(`export function g(a: u64): Pair { return { a, b: a }; }`)).toBe(fix("an instruction's arguments or result"));
    expect(f(`export function g(s: Mut<Pair>): void { s.a = 1n; }`)).toBe(fix("account data"));
    expect(f(`export function g(a: u64): void { emit<Pair>({ a, b: a }); }`)).toBe(fix("an event"));
    expect(f(`export interface Book { best: Pair; }\nexport function g(s: Mut<Book>): void { s.best.a = 1n; }`)).toBe(
      fix("the exported struct Book (field best)"),
    );
    expect(f(`export type E = { kind: "P"; p: Pair } | { kind: "N" };\nexport function g(e: E): void {}`)).toBe(fix("the data enum E (P.p)"));
  });

  it("a comma anywhere else is still refused", () => {
    const f = (body: string) => compileErrors(`import { type u64 } from "typesol";\nexport function f(a: u64): void { let x = a; let y = a; ${body} }`);
    expect(f(`x++, y++;`)).toContain("this expression has no effect");
  });
});
