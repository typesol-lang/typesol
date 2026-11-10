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

  it("a comma anywhere else is still refused", () => {
    const f = (body: string) => compileErrors(`import { type u64 } from "typesol";\nexport function f(a: u64): void { let x = a; let y = a; ${body} }`);
    expect(f(`x++, y++;`)).toContain("this expression has no effect");
  });
});
