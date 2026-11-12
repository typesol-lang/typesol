// An f64 is held as its IEEE 754 bits in a u64, and TypeSOL has no float arithmetic: every operator with an f64
// operand is a compile error (the integer operator would compute on the bits), equality included (equal bits are not
// equal numbers). An f64 is not an integer either: it is not converted to one, nor one to it, by an assignment, an
// argument, a return, an index, a cast or text. f64Bits / f64FromBits convert, and work on the bits as integers.
import { describe, expect, it } from "vitest";
import { compileErrors } from "../harness.js";

const HEADER = `import { type Mut, type Option, type f64, type u64, f64Bits, f64FromBits, isqrt, max, min, mulDiv, mulDivCeil } from "typesol";
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
    ["mulDivCeil()", "a.n = mulDivCeil(a.x, 2n, 3n);"],
    ["mulDivCeil()", "a.n = mulDivCeil(2n, 3n, a.x);"],
    // `??` over an Option<f64> gives an f64 whatever the other side expects, so the operator sees one.
    ["*", "a.n = (a.o ?? a.x) * 2n;"],
    ["<", "if (a.n < (a.o ?? a.x)) a.n = 1n;"],
    ["min()", "a.n = min(a.n, a.o ?? a.x);"],
    ["+=", "a.n += a.o ?? a.x;"],
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

const CONVERT = (to: string) =>
  `an f64 is not an integer, so it is not converted to ${to}: it is held as its IEEE 754 bits, and the integer would be those bits; to use the bits, write f64Bits(x)`;
const TEXT =
  "an f64 cannot be written as text: there is no float formatting, and the digits would be its IEEE 754 bits read as an integer; to show the bits, write f64Bits(x)";
const MORE = `import { type FixedArray, type Mut, type Option, type f64, bigEndian, f64Bits, f64FromBits, findProgramAddress, log, min, programId, u64, u8, u128 } from "typesol";
export interface In { v: f64; k: u64 }
export interface A { x: f64; y: f64; n: u64; b: u8; o: Option<f64>; on: Option<u64>; inner: In; other: In; xs: FixedArray<f64, 4>; ns: FixedArray<u64, 4> }
function takes(v: u64): u64 { return v; }
function takesF(v: f64): f64 { return v; }
function pick(c: boolean, p: f64, q: f64): f64 { return c ? p : q; }
`;
const more = (stmts: string, extra = "") => `${MORE}${extra}export function f(a: Mut<A>): void { ${stmts} }`;

describe("an f64 is not an integer", () => {
  const toInteger: [string, string, string?][] = [
    ["u64", "a.n = a.x;"],
    ["u64", "a.inner.k = a.inner.v;"],
    ["u64", "const z: u64 = a.x; a.n = z;"],
    ["u64", "let z: u64 = 0n; z = a.y; a.n = z;"],
    ["u64", "a.n = takes(a.x);"],
    ["u64", "a.n = a.n > 0n ? a.x : a.y;"],
    ["u64", "a.n = a.on ?? a.x;"],
    ["u64", "a.n = 1n;", "function conv(p: f64): u64 { return p; }\n"],
    ["an index", "a.n = a.ns.get(a.x);"],
    ["u8", "a.b = u8(a.x);"],
    ["u64", "a.n = u64(a.x);"],
    ["u128", "a.n = u64(u128(a.x) / 2n);"],
    ["u64", "a.n = a.x as u64;"],
  ];
  for (const [to, stmts, extra] of toInteger)
    it(`refuses ${stmts}${extra ? ` with ${extra.trim()}` : ""}`, () => {
      // The first error (an unread local can add "unknown name" after it).
      expect(compileErrors(more(stmts, extra)).split(" | ")[0]).toBe(CONVERT(to));
    });

  it("refuses an integer made an f64 with `as` (f64FromBits(bits) makes one)", () => {
    expect(compileErrors(more("a.x = a.n as f64;"))).toBe(
      "a u64 is not an f64, so it is not converted: an f64 is made from its IEEE 754 bits with f64FromBits(bits)",
    );
  });

  for (const stmts of ["log(`x = ${a.x}`);", "log(a.x);", "log(`${a.o}`);", "log(`${a.xs.get(0n)}`);"])
    it(`refuses an f64 as text (${stmts})`, () => {
      expect(compileErrors(more(stmts))).toBe(TEXT);
    });

  it("keeps f64 to f64: fields, locals, struct copies, arguments, returns, Option<f64>, ternaries, ?? and the bits", () => {
    const ok = [
      "a.x = a.y;",
      "const z: f64 = a.x; let w = z; w = a.y; a.x = w;",
      "a.inner = a.other; a.inner.v = a.x;",
      "a.x = takesF(a.y); a.y = pick(a.n > 0n, a.x, a.y);",
      "a.o = null; a.o = a.x; a.o = f64FromBits(a.n); if (a.o !== null) a.x = a.o;",
      "a.x = a.n > 0n ? a.x : f64FromBits(0n);",
      "a.x = a.o ?? a.y; a.x = a.o ?? f64FromBits(1n);",
      "a.xs.set(0n, a.x); a.x = a.xs.get(1n);",
      "a.n = f64Bits(a.x); a.x = f64FromBits(4607182418800017408n); if (a.o !== null && f64Bits(a.o) > 0n) a.n = 1n;",
      "log(`${f64Bits(a.x)}`);",
    ];
    for (const stmts of ok) expect(compileErrors(more(stmts)), stmts).toBe("");
  });

  it("keeps an f64 as a seed: its 8 bytes, little-endian or with bigEndian(x), as Rust's to_le_bytes / to_be_bytes", () => {
    expect(compileErrors(more("const k = findProgramAddress([a.x], programId()); const j = findProgramAddress([bigEndian(a.x)], programId());"))).toBe("");
  });
});
