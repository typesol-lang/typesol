// a ** b on integers: exactly JS bigint results inside the type, 5100 on overflow or a negative exponent.
import { FailedTransactionMetadata } from "litesvm";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const RANGE = {
  u8: [0n, 255n],
  u64: [0n, 2n ** 64n - 1n],
  i64: [-(2n ** 63n), 2n ** 63n - 1n],
  u128: [0n, 2n ** 128n - 1n],
} as const;

describe("** on integers", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/pow.ts", import.meta.url)));
  });

  const read = (data: Uint8Array, t: keyof typeof RANGE) => {
    const buf = Buffer.from(data);
    if (t === "u8") return BigInt(buf[0]);
    if (t === "u64") return buf.readBigUInt64LE(0);
    if (t === "i64") return buf.readBigInt64LE(0);
    return buf.readBigUInt64LE(0) + (buf.readBigUInt64LE(8) << 64n);
  };

  it("matches JS bigint ** inside each type and aborts outside it", async () => {
    const payer = await fundedSigner(d.svm);
    const cases: [keyof typeof RANGE, string, bigint, bigint][] = [];
    for (const [b, e] of [
      [0n, 0n],
      [0n, 5n],
      [1n, 200n],
      [2n, 7n],
      [2n, 8n],
      [3n, 5n],
      [3n, 6n],
      [15n, 2n],
      [16n, 2n],
    ] as [bigint, bigint][])
      cases.push(["u8", "pow_u8", b, e]);
    for (const [b, e] of [
      [2n, 63n],
      [2n, 64n],
      [10n, 19n],
      [10n, 20n],
      [7n, 22n],
      [7n, 23n],
      [123456789n, 2n],
      [0n, 1000n],
      [1n, 18446744073709551615n],
    ] as [bigint, bigint][])
      cases.push(["u64", "pow_u64", b, e]);
    for (const [b, e] of [
      [-2n, 63n],
      [2n, 63n],
      [-2n, 62n],
      [-3n, 39n],
      [-3n, 40n],
      [-1n, 1001n],
      [5n, -1n],
      [-7n, 0n],
    ] as [bigint, bigint][])
      cases.push(["i64", "pow_i64", b, e]);
    for (const [b, e] of [
      [10n, 38n],
      [10n, 39n],
      [2n, 127n],
      [2n, 128n],
      [3n, 80n],
      [3n, 81n],
    ] as [bigint, bigint][])
      cases.push(["u128", "pow_u128", b, e]);

    for (const [t, name, b, e] of cases) {
      const arg = (v: bigint) => new BN(v.toString());
      const r = await send(d.svm, payer, [ix(d, name, { b: arg(b), e: arg(e) }, [])]);
      const [min, max] = RANGE[t];
      const fits = e >= 0n && b ** e >= min && b ** e <= max;
      if (fits) expect(read(expectOk(r).returnData().data(), t), `${b} ** ${e} as ${t}`).toBe(b ** e);
      else expect(customError(r), `${b} ** ${e} as ${t}`).toBe(5100);
    }
  });

  it("unrolls literal exponents", async () => {
    const payer = await fundedSigner(d.svm);
    const cube = async (b: bigint) => send(d.svm, payer, [ix(d, "cube", { b: new BN(b.toString()) }, [])]);
    expect(
      read(
        expectOk(await cube(5n))
          .returnData()
          .data(),
        "u64",
      ),
    ).toBe(5n ** 3n + 1024n + 1n);
    expect(customError(await cube(2n ** 22n))).toBe(5100);
    expect(
      read(
        expectOk(await send(d.svm, payer, [ix(d, "ten_to18", {}, [])]))
          .returnData()
          .data(),
        "u128",
      ),
    ).toBe(10n ** 18n);
  });
});

// u256 where C needs more than an operator (min / max, switch, an index, a run-time exponent of a u256 base) and
// compound shifts, whose amount has a type of its own as in `x << n`: accepted before, these failed in clang.
const WIDE = `import { type u8, type u64, type i64, min, max, fixedArray, u256 as U256, u64 as U64 } from "typesol";
export function lo(a: u64, b: u64): u64 { return U64(min(U256(a), U256(b))) * 1000n + U64(max(U256(a), U256(b))); }
export function pick(a: u64): u64 { const s = U256(a); switch (s) { case 1n: return 10n; case 2n: return 20n; default: return 99n; } }
export function at(a: u64): u64 { const xs = fixedArray<u64, 4>(3n); xs.set(2n, 7n); return xs.get(U256(a)); }
export function powWide(a: u64, e: u64): u64 { return U64(U256(a) ** e); }
export function shl(a: u64, n: u8): u64 { let x = a; x <<= n; return x; }
export function shlWide(a: u64): u64 { let x = U256(a); x <<= 1n; x >>= 2n; return U64(x); }
export function sar(a: i64): i64 { let x = a; x >>= 1n; return x; }
`;

describe("u256 in min / max, switch, indexes and **; compound shifts", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-wide-"));
    writeFileSync(path.join(dir, "wide.ts"), WIDE);
    d = await deployFile(path.join(dir, "wide.ts"));
  });
  const run = async (name: string, args: Record<string, unknown>) => {
    const res = await send(d.svm, await fundedSigner(d.svm), [ix(d, name, args, [])]);
    return res instanceof FailedTransactionMetadata ? customError(res) : Buffer.from(res.returnData().data()).readBigUInt64LE(0);
  };

  it("compares, switches on and indexes with u256 values", async () => {
    expect(await run("lo", { a: new BN(9), b: new BN(4) })).toBe(4009n);
    expect(await run("pick", { a: new BN(2) })).toBe(20n);
    expect(await run("pick", { a: new BN(5) })).toBe(99n);
    expect(await run("at", { a: new BN(2) })).toBe(7n);
    expect(await run("at", { a: new BN(4) })).toBe(5104); // out of bounds
    expect(await run("pow_wide", { a: new BN(3), e: new BN(5) })).toBe(243n);
  });

  it("shifts by an amount of another type", async () => {
    expect(await run("shl", { a: new BN(3), n: 4 })).toBe(48n);
    expect(await run("shl_wide", { a: new BN(6) })).toBe(3n);
    const res = expectOk(await send(d.svm, await fundedSigner(d.svm), [ix(d, "sar", { a: new BN(-7) }, [])]));
    expect(Buffer.from(res.returnData().data()).readBigInt64LE(0)).toBe(-4n);
  });
});
