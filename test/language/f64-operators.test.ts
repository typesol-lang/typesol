// An f64 is held as its IEEE 754 bits in a u64, and TypeSOL has no float arithmetic: every operator with an f64
// operand is a compile error (the integer operator would compute on the bits), equality included (equal bits are not
// equal numbers). f64Bits / f64FromBits convert, and work on the bits as integers.
import { describe, expect, it } from "vitest";
import { compileErrors } from "../harness.js";

const HEADER = `import { type Mut, type Option, type f64, type u64, f64Bits, f64FromBits, isqrt, max, min, mulDiv } from "typesol";
export interface A { x: f64; y: f64; n: u64; o: Option<f64> }
`;
const body = (stmts: string) => `${HEADER}export function f(a: Mut<A>): void { ${stmts} }`;
const ARITH =
  /on an f64 is not supported: an f64 is held as its IEEE 754 bits and there is no float arithmetic \(this would compute on the bits\); compute in integers and make the result with f64FromBits\(bits\), or take an f64's bits with f64Bits\(x\)/;
const EQUALITY =
  /on an f64 is not supported: an f64 is held as its IEEE 754 bits, and equal bits are not equal numbers \(NaN would equal itself, 0 would not equal -0\); to compare the bits, write f64Bits\(a\) === f64Bits\(b\)/;

describe("operators on f64", () => {
  const arithmetic: [string, string][] = [
    ["+", "a.n = a.x + a.y;"],
    ["-", "a.n = a.x - a.y;"],
    ["*", "a.n = a.x * 2n;"],
    ["/", "a.n = a.x / 2n;"],
    ["%", "a.n = a.x % 2n;"],
    ["**", "a.n = a.x ** 2n;"],
    ["**", "a.n = a.x ** 1n;"],
    ["&", "a.n = a.x & 1n;"],
    ["|", "a.n = a.x | 1n;"],
    ["^", "a.n = a.x ^ a.y;"],
    ["<<", "a.n = a.x << 1n;"],
    [">>", "a.n = a.x >> 1n;"],
    ["<<", "a.n = a.n << a.x;"],
    ["+", "a.n = a.n + a.x;"],
    ["unary -", "a.n = -a.x;"],
    ["~", "a.n = ~a.x;"],
    ["<", "if (a.x < a.y) a.n = 1n;"],
    ["<=", "if (a.x <= a.y) a.n = 1n;"],
    [">", "if (a.x > 0n) a.n = 1n;"],
    [">=", "if (a.x >= a.y) a.n = 1n;"],
    ["+=", "a.n += a.x;"],
    ["<<=", "a.n <<= a.x;"],
    ["++", "a.x++;"],
    ["--", "--a.x;"],
    ["*", "const z = a.x; a.n = z * 2n;"],
    ["min()", "a.n = min(a.x, a.y);"],
    ["max()", "a.n = max(a.x, a.y);"],
    ["isqrt()", "a.n = isqrt(a.x);"],
    ["mulDiv()", "a.n = mulDiv(a.x, 2n, 3n);"],
  ];
  for (const [op, stmts] of arithmetic)
    it(`refuses ${op} (${stmts})`, () => {
      const errs = compileErrors(body(stmts));
      expect(errs).toMatch(ARITH);
      expect(errs.startsWith(`${op} on an f64`)).toBe(true);
    });

  const equality: [string, string][] = [
    ["===", "if (a.x === a.y) a.n = 1n;"],
    ["!==", "if (a.x !== 0n) a.n = 1n;"],
    ["==", "if (a.x == a.y) a.n = 1n;"],
    ["!=", "if (a.x != a.y) a.n = 1n;"],
    ["===", "if (a.o === a.x) a.n = 1n;"],
    ["switch", "switch (a.x) { case 0n: a.n = 1n; break; }"],
  ];
  for (const [op, stmts] of equality)
    it(`refuses ${op} (${stmts})`, () => {
      const errs = compileErrors(body(stmts));
      expect(errs).toMatch(EQUALITY);
      expect(errs.startsWith(`${op} on an f64`)).toBe(true);
    });

  it("computes on the bits through f64Bits and f64FromBits, and still checks an Option<f64> against null", () => {
    expect(
      compileErrors(body("a.n = f64Bits(a.x) + 1n; if (f64Bits(a.x) === f64Bits(a.y)) a.y = f64FromBits(a.n); if (a.o !== null) a.n = 0n; a.x = a.y;")),
    ).toBe("");
  });
});
