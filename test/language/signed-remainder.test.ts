// A signed type's minimum divided by, or reduced modulo, -1: the quotient does not fit, so both fail, at run time
// (5100) and in a typed constant (a compile error), as Rust's checked `/` and `%` do (`i8::MIN % -1` overflows).
// Every other remainder keeps the dividend's sign, in a constant and at run time alike.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const WIDTHS = { i8: 8, i16: 16, i32: 32, i64: 64, i128: 128 } as const;
type Width = keyof typeof WIDTHS;
const min = (t: Width) => -(1n << BigInt(WIDTHS[t] - 1));

const SOURCE = `import { type i8, type i16, type i32, type i64, type i128 } from "typesol";

${(Object.keys(WIDTHS) as Width[])
  .map(
    (t) => `export const REM_${t.toUpperCase()}: ${t} = ${min(t)}n % 3n;
export function rem_${t}(x: ${t}, y: ${t}): ${t} {
  return x % y;
}
export function div_${t}(x: ${t}, y: ${t}): ${t} {
  return x / y;
}
export function rem_const_${t}(): ${t} {
  return REM_${t.toUpperCase()};
}
`,
  )
  .join("\n")}`;

const read = (data: Uint8Array, t: Width): bigint => {
  const b = Buffer.from(data);
  const bytes = WIDTHS[t] / 8;
  let v = 0n;
  for (let i = bytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
  return BigInt.asIntN(WIDTHS[t], v);
};
// The coder takes i64 and i128 as BN, the narrower ones as numbers.
const arg = (t: Width, v: bigint) => (WIDTHS[t] >= 64 ? new BN(v.toString()) : Number(v));

describe("signed remainder and division by -1", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-signed-remainder-"));
    writeFileSync(path.join(dir, "rem.ts"), SOURCE);
    d = await deployFile(path.join(dir, "rem.ts"));
  });

  it("fails with 5100 at run time for the minimum by -1, for % as for /, at every signed width", async () => {
    const payer = await fundedSigner(d.svm);
    for (const t of Object.keys(WIDTHS) as Width[]) {
      const call = (name: string, x: bigint, y: bigint) => send(d.svm, payer, [ix(d, `${name}_${t}`, { x: arg(t, x), y: arg(t, y) }, [])]);
      expect(customError(await call("rem", min(t), -1n)), `${t} min % -1`).toBe(5100);
      expect(customError(await call("div", min(t), -1n)), `${t} min / -1`).toBe(5100);
      for (const [x, y] of [
        [min(t) + 1n, -1n],
        [min(t), 1n],
        [min(t), 3n],
        [-7n, 2n],
        [7n, -2n],
      ] as const)
        expect(
          read(
            expectOk(await call("rem", x, y))
              .returnData()
              .data(),
            t,
          ),
          `${t} ${x} % ${y}`,
        ).toBe(x % y);
      // The folded constant: the same remainder as at run time.
      const c = expectOk(await send(d.svm, payer, [ix(d, `rem_const_${t}`, {}, [])]));
      expect(read(c.returnData().data(), t), `${t} constant`).toBe(min(t) % 3n);
    }
  });

  it("refuses a typed constant of the minimum by -1, for % as for /, at every signed width", () => {
    for (const t of Object.keys(WIDTHS) as Width[]) {
      const head = `import { type ${t} } from "typesol";\n`;
      expect(compileErrors(`${head}export const X: ${t} = ${min(t)}n % -1n;\nexport function f(): ${t} { return X; }`), `${t} %`).toMatch(
        new RegExp(`overflows ${t}`),
      );
      expect(compileErrors(`${head}export const X: ${t} = ${min(t)}n / -1n;\nexport function f(): ${t} { return X; }`), `${t} /`).toMatch(/does not fit/);
      expect(compileErrors(`${head}export const X: ${t} = ${min(t) + 1n}n % -1n;\nexport function f(): ${t} { return X; }`), `${t} min+1`).toBe("");
    }
    // An untyped constant is an integer without a width: its remainder is JS's, and its use is checked where it is used.
    expect(compileErrors(`import { type i8 } from "typesol";\nexport const X = -128n % -1n;\nexport function f(): i8 { return X; }`)).toBe("");
  });
});
