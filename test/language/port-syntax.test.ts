// Forms native ports write as the Rust reads (test/fixtures/port-syntax.ts): comma-separated for-loop updates and
// initializers.
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

  it("a comma anywhere else is still refused", () => {
    const f = (body: string) => compileErrors(`import { type u64 } from "typesol";\nexport function f(a: u64): void { let x = a; let y = a; ${body} }`);
    expect(f(`x++, y++;`)).toContain("this expression has no effect");
  });
});
