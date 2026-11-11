// Closures (local functions that read the enclosing function's variables), expanded where they are called.
import { FailedTransactionMetadata } from "litesvm";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed, compileErrors } from "../harness.js";

describe("closures", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/closures.ts", import.meta.url)));
  });
  const u64 = (r: Awaited<ReturnType<typeof send>>) => Buffer.from(expectOk(r).returnData().data()).readBigUInt64LE(0);
  const run = async (name: string, args: Record<string, unknown>) => u64(await send(d.svm, await fundedSigner(d.svm), [ix(d, name, args, [])]));

  it("write the enclosing let, and read the names they were declared with", async () => {
    // 5 → 8 → 11 (the inner `inc` is not the captured one) → twice: 14, 1 * 2 + 14.
    expect(await run("counter", { start: new BN(5), step: new BN(3) })).toBe(16n);
  });

  it("return early from block bodies and call each other", async () => {
    expect(await run("classify", { x: new BN(1), limit: new BN(5) })).toBe(92n);
    expect(await run("classify", { x: new BN(0), limit: new BN(5) })).toBe(1n);
    expect(await run("classify", { x: new BN(7), limit: new BN(5) })).toBe(22n);
  });

  it("write through captured accounts and struct references", async () => {
    const payer = await fundedSigner(d.svm);
    const [cart] = await pda(d.programId, ["cart", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: cart, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const r = await send(d.svm, payer, [
      ix(d, "checkout", { discount: new BN(1) }, [
        { address: payer.address, signer: payer },
        { address: cart, writable: true },
      ]),
    ]);
    expect(u64(r)).toBe(25n);
    const c = decodeAccount<{ total: BN; items: { qty: BN }[] }>(d, d.svm, "Cart", cart);
    expect([c.total.toNumber(), c.items[0]!.qty.toNumber()]).toEqual([25, 5]);
  });

  it("call a function chosen at run time, and run a list of functions in turn", async () => {
    // k=1: g = twice. x=5: g 10, h = twice 10, total = 10 + 6 + 25 + 10 = 51.
    expect(await run("chosen", { k: new BN(1), x: new BN(5) })).toBe(10_000_000n + 10_000n + 51n);
    // k=2: g = inc. x=5: g 6, h = twice 10, total = 10 + 6 + 25 + 6 = 47.
    expect(await run("chosen", { k: new BN(2), x: new BN(5) })).toBe(6_000_000n + 10_000n + 47n);
    // k=3: g = sq. x=200: g 40000, h = g 40000; total 400 + 201 + 40000 + 40000 = 80601.
    expect(await run("chosen", { k: new BN(3), x: new BN(200) })).toBe(40_000_000_000n + 40_000_000n + 80_601n);
    // x=0: every f(0) of twice and sq is 0 (skipped by continue); inc(0) = 1, and g = sq: total 1.
    expect(await run("chosen", { k: new BN(3), x: new BN(0) })).toBe(1n);
    // break: x = 2000, k = 3: twice 4000, inc 2001, sq 4,000,000 > 1e6 → break before g.
    expect(await run("chosen", { k: new BN(3), x: new BN(2000) })).toBe(4_000_000n * 1_000_000n + 4_000_000n * 1_000n + 4_006_001n);
  });

  it("read an inner condition of a function choice only when its side is taken", async () => {
    expect(await run("lazy_choice", { x: new BN(0) })).toBe(0n * 1_000_000n + 0n * 10n + 3n); // twice(0); 10 / 0 never runs
    expect(await run("lazy_choice", { x: new BN(2) })).toBe(3n * 1_000_000n + 3n * 10n + 1n); // inc; h = inc
    expect(await run("lazy_choice", { x: new BN(20) })).toBe(400n * 1_000_000n + 400n * 10n + 1n); // sq; h = sq
  });

  it("pass named functions to helpers (an instance per function)", async () => {
    // applyTwice(inc, 5) = 7; compose(dbl, inc, 5) = applyTwice(dbl, 6) = 24.
    expect(await run("higher", { x: new BN(5) })).toBe(7024n);
  });

  it("pass arrow functions written at the call to helpers", async () => {
    // applyTwice(v => 3v, 5) = 45; compose(+10, -1, 5) = applyTwice(+10, 4) = 24.
    expect(await run("lambdas", { x: new BN(5) })).toBe(45024n);
  });

  it("pass closures to helpers: the helper is expanded where it is called", async () => {
    // applyTwice(addX, 1) = 11; compose(v => 5v, addX, 2) = applyTwice(v => 5v, 7) = 175; addX ran 3 times.
    expect(await run("capturing", { x: new BN(5) })).toBe(11_000n + 1_750n + 3n);
  });

  it("make functions, bind them as values, and give closures to generic and account helpers", async () => {
    // add5(2) = 7; triple(2) = 6; adder(1)(2) = 3; applyT(t2, 7) runs track once: seen = 7.
    expect(await run("made", { x: new BN(2) })).toBe(70_000n + 600n + 3n + 7n);
    const payer = await fundedSigner(d.svm);
    const [cart] = await pda(d.programId, ["cart", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "setup", {}, [{ address: payer.address, signer: payer, writable: true }, { address: cart, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const before = decodeAccount<{ total: BN }>(d, d.svm, "Cart", cart).total.toNumber();
    const r = await send(d.svm, payer, [
      ix(d, "bump_total", { by: new BN(4) }, [
        { address: payer.address, signer: payer },
        { address: cart, writable: true },
      ]),
    ]);
    expect(u64(r)).toBe(BigInt(before + 4));
  });

  it("refuses recursion and functions used as values", () => {
    const errors = (body: string) => compileErrors(`import { type u64 } from "typesol";\n${body}\n`);
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => (v === 0n ? x : g(v - 1n)); return g(3n); }`)).toMatch(/calls itself/);
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; const h = g; return h(1n); }`)).toBe("");
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; let h = g; return h(1n); }`)).toMatch(/bind functions with const/);
    expect(errors(`function mk(n: u64): (x: u64) => u64 { return (x: u64): u64 => x + n; }\nexport function f(x: u64): u64 { mk(1n); return x; }`)).toMatch(
      /returns a function: bind it/,
    );
    const apply = "function apply(f: (x: u64) => u64, v: u64): u64 { return f(v); }\n";
    expect(errors(`${apply}export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; return apply(g, 1n); }`)).toBe("");
    const pick = "function pick<T>(f: (x: T) => T, v: T): T { return f(v); }\n";
    expect(errors(`${pick}export function f(x: u64): u64 { return pick<u64>((v: u64): u64 => v + x, 1n); }`)).toBe("");
    expect(errors(`export function f(x: u64): u64 { const g = (v: u64): u64 => v + x; return g(1n, 2n); }`)).toMatch(/Expected 1 arguments/);
  });
});

// JS evaluates operands left to right: a local read before a closure (or a list callback) that writes it keeps the value
// it had. A local was taken as stable and read where it was used, after the closure ran.
const ORDER = `import { type u64, fixedArray } from "typesol";
function two(a: u64, b: u64): u64 { return a * 100n + b; }
export function addAssign(a: u64): u64 { let x = a; const bump = (): u64 => { x += 1n; return x; }; x += bump(); return x; }
export function helperArgs(a: u64): u64 { let x = a; const bump = (): u64 => { x += 1n; return x; }; return two(x, bump()); }
export function product(a: u64): u64 { let x = a; const bump = (): u64 => { x += 1n; return x; }; return x * 100n + bump(); }
export function equal(a: u64): u64 { let x = a; const bump = (): u64 => { x += 1n; return x; }; return x === bump() ? 1n : 0n; }
export function chain(a: u64, c: u64): u64 { let x = a; const bump = (): u64 => { x += 1n; return x; }; return x - bump() + 1000n + c; }
export function callback(a: u64): u64 {
  let x = a;
  const xs = fixedArray<u64, 3>(1n);
  return x * 100n + xs.reduce((acc: u64, v: u64): u64 => { x += v; return acc + v; }, 0n) + x * 10000n;
}
export function untouched(a: u64): u64 { let x = a; const y = a * 2n; const f = (): u64 => y + 1n; return x * 100n + f(); }
`;

describe("a local read before a closure that writes it", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-order-"));
    writeFileSync(path.join(dir, "order.ts"), ORDER);
    d = await deployFile(path.join(dir, "order.ts"));
  });
  const run = async (name: string, args: Record<string, unknown>) => {
    const res = await send(d.svm, await fundedSigner(d.svm), [ix(d, name, args, [])]);
    return res instanceof FailedTransactionMetadata ? customError(res) : Buffer.from(res.returnData().data()).readBigUInt64LE(0);
  };

  it.each([
    ["add_assign", 15n], // 7 + 8
    ["helper_args", 708n], // two(7, 8)
    ["product", 708n],
    ["equal", 0n], // 7 === 8
    ["untouched", 715n], // nothing writes x: read in place
  ])("%s", async (name, want) => {
    expect(await run(name, { a: new BN(7) })).toBe(want);
  });

  it("keeps the value for a later operand of a chain (7 - 8 underflows in u64: 5100)", async () => {
    expect(await run("chain", { a: new BN(7), c: new BN(0) })).toBe(5100);
  });

  it("a list callback writing the local", async () => {
    // 7 * 100 + 3 + 10 * 10000
    expect(await run("callback", { a: new BN(7) })).toBe(100703n);
  });
});
