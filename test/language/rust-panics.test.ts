// PANIC_STYLE "solana-1.14" and panicsAt (test/fixtures/rust-panics.ts, rust-panics-default.ts): Rust's panic lines,
// compared line for line with the panics of the Phoenix v1 binary (solana-program 1.14).
import { type KeyPairSigner } from "@solana/kit";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../src/compiler/index.js";
import { type Deployed, compileErrors, customError, deployFile, expectOk, fundedSigner, send } from "../harness.js";
import { PHOENIX, type Result, errOf, initializeMarket, logsOf, phoenixMarket, tooFewAccounts } from "../phoenix-helpers.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/rust-panics.ts", import.meta.url));
const DEFAULT = fileURLToPath(new URL("../fixtures/rust-panics-default.ts", import.meta.url));

const le = (v: bigint, bytes: number) => {
  const out: number[] = [];
  let x = BigInt.asUintN(bytes * 8, v);
  for (let i = 0; i < bytes; i++, x >>= 8n) out.push(Number(x & 0xffn));
  return out;
};
const U64_MAX = (1n << 64n) - 1n;

describe("Rust panics: PANIC_STYLE and panicsAt", () => {
  let d: Deployed;
  let dflt: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(FIXTURE);
    dflt = await deployFile(DEFAULT, { svm: d.svm });
    payer = await fundedSigner(d.svm);
  });
  let nonce = 0;
  const call = (p: Deployed, data: number[], accounts = 0) =>
    send(d.svm, payer, [
      {
        programAddress: p.programId,
        accounts: Array.from({ length: accounts }, () => ({ address: payer.address, role: 0 })) as never,
        data: new Uint8Array([...data, nonce++ & 0xff]),
      },
    ]);
  /**
   * The panic: the program's own last log line, its failure line (program id left out), the error, and every log line
   * (the program id left out, the "consumed N of M compute units" line dropped: N differs by design).
   */
  const panicOf = (r: Result, program: string) => {
    const logs = logsOf(r);
    const own = logs.filter((l) => l.startsWith("Program log: "));
    return {
      line: own.at(-1),
      failed: logs.at(-1)!.replace(program, "<program>"),
      err: errOf(r),
      logs: logs.filter((l) => !/ consumed \d+ of \d+ compute units$/.test(l)).map((l) => l.replaceAll(program, "<program>")),
    };
  };
  const phoenixPanic = (r: Result) => panicOf(r, PHOENIX);
  const ourPanic = (r: Result, p: Deployed = d) => panicOf(r, p.programId);

  it("logs exactly what the Phoenix binary logs for the entrypoint's assertion (too few accounts)", async () => {
    const m = await phoenixMarket();
    const phoenix = phoenixPanic(await tooFewAccounts(m, 2));
    expect(phoenix).toEqual({
      line: "Program log: panicked at 'assertion failed: mid <= self.len()', src/lib.rs:127:49",
      failed: "Program <program> failed: SBF program panicked",
      err: expect.stringMatching(/ProgramFailedToComplete/),
      logs: [
        "Program <program> invoke [1]",
        "Program log: panicked at 'assertion failed: mid <= self.len()', src/lib.rs:127:49",
        "Program <program> failed: SBF program panicked",
      ],
    });
    expect(ourPanic(await call(d, [0], 1))).toEqual(phoenix);
    expectOk(await call(d, [0], 4));
  });

  it("logs exactly what the Phoenix binary logs for its overflow and remainder checks", async () => {
    // [Phoenix's InitializeMarket input, the same operands for the port]
    const cases: [Parameters<typeof initializeMarket>[1], number, number[]][] = [
      // 10^10 * u32::MAX (base mint with 10 decimals): u64 multiply in initialize.rs
      [{ rawBaseUnitsPerBaseUnit: 0xffffffff }, 10, [1, 10, ...le(0xffffffffn, 4)]],
      // base atoms per base unit % 0 base lots per base unit
      [{ baseLotsPerBaseUnit: 0n }, 9, [2, ...le(1_000_000_000n, 8), ...le(0n, 8)]],
      // quote atoms per quote unit % 0 quote lots per quote unit
      [{ quoteLotsPerQuoteUnit: 0n }, 9, [3, ...le(1_000_000n, 8), ...le(0n, 8)]],
      // quote lot size (10^6 / 1) * tick size u64::MAX
      [{ quoteLotsPerQuoteUnit: 1n, tickSizeInQuoteLotsPerBaseUnit: U64_MAX }, 9, [4, ...le(1_000_000n, 8), ...le(U64_MAX, 8)]],
    ];
    for (const [params, baseDecimals, ours] of cases) {
      const m = await phoenixMarket({ baseDecimals });
      const phoenix = phoenixPanic(await initializeMarket(m, params));
      expect(phoenix.line).toMatch(/^Program log: panicked at 'attempt to /);
      expect(phoenix.failed).toBe("Program <program> failed: SBF program panicked");
      // The whole log: the instruction's name (the fixture logs it as Phoenix's dispatcher does), the panic, the abort.
      expect(phoenix.logs).toEqual(["Program <program> invoke [1]", "Program log: PhoenixInstruction::Initialize", phoenix.line, phoenix.failed]);
      expect(ourPanic(await call(d, ours))).toEqual(phoenix);
    }
  });

  it("gives every operator Rust's message, compound assignments and helpers included", async () => {
    const args = (a: bigint, b: bigint) => [...le(a, 8), ...le(b, 8)];
    const line = async (tag: number, a: bigint, b: bigint) => ourPanic(await call(d, [tag, ...args(a, b)])).line;
    expect(await line(5, U64_MAX, 1n)).toBe("Program log: panicked at 'attempt to add with overflow', src/quantities.rs:233:1");
    expect(await line(6, U64_MAX, 2n)).toBe("Program log: panicked at 'attempt to add with overflow', src/quantities.rs:233:1");
    expect(await line(7, 1n, 2n)).toBe("Program log: panicked at 'attempt to subtract with overflow', src/a.rs:1:2");
    expect(await line(8, 1n, 0n)).toBe("Program log: panicked at 'attempt to divide by zero', src/a.rs:3:4");
    expect(await line(9, 1n, 0n)).toBe("Program log: panicked at 'attempt to negate with overflow', src/a.rs:5:6");
    expect(await line(10, 1n, 1n)).toBe("Program log: panicked at 'attempt to divide with overflow', src/a.rs:7:8");
    expect(await line(11, 1n, 64n)).toBe("Program log: panicked at 'attempt to shift left with overflow', src/a.rs:9:10");
    expect(await line(12, 1n, 1n << 33n)).toBe("Program log: panicked at 'attempt to multiply with overflow', src/inner.rs:2:2");
    expect(await line(12, U64_MAX, 1n)).toBe("Program log: panicked at 'attempt to add with overflow', src/outer.rs:1:1");
    expect(await line(15, 1n, 0n)).toBe("Program log: panicked at 'attempt to calculate the remainder with a divisor of zero', src/a.rs:11:12");
    // Within range, the values as computed.
    const ok = expectOk(await call(d, [5, ...args(2n, 3n)]));
    expect(logsOf(ok)).toContain("Program log: 5");
  });

  it("aborts PANIC_ON_OVERFLOW's panics outside panicsAt and puts this line and column on a panic without a location", async () => {
    const r = await call(d, [13, ...le(U64_MAX, 8), ...le(1n, 8)]);
    expect(ourPanic(r)).toEqual({
      line: "Program log: TypeSOL: arithmetic overflow (rust-panics.ts:81)",
      failed: "Program <program> failed: SBF program panicked",
      err: expect.stringMatching(/ProgramFailedToComplete/),
      logs: ["Program <program> invoke [1]", "Program log: TypeSOL: arithmetic overflow (rust-panics.ts:81)", "Program <program> failed: SBF program panicked"],
    });
    const p = ourPanic(await call(d, [14, ...le(0n, 16)]));
    expect(p.line).toBe("Program log: panicked at 'explicit', rust-panics.ts:83:20");
    expect(p.failed).toBe("Program <program> failed: SBF program panicked");
  });

  it("without PANIC_STYLE: Rust's message, then sol_panic_ at the location; 5100 / 5101 outside panicsAt", async () => {
    const args = (a: bigint, b: bigint) => [...le(a, 8), ...le(b, 8)];
    const add = ourPanic(await call(dflt, [0, ...args(U64_MAX, 1n)]), dflt);
    expect(add.line).toBe("Program log: attempt to add with overflow");
    expect(add.failed).toBe("Program <program> failed: SBF program Panicked in src/quantities.rs at 233:1");
    expect(add.err).toMatch(/ProgramFailedToComplete/);
    const div = ourPanic(await call(dflt, [2, ...args(1n, 0n)]), dflt);
    expect(div.line).toBe("Program log: attempt to divide by zero");
    expect(div.failed).toBe("Program <program> failed: SBF program Panicked in src/quantities.rs at 240:1");
    expect(customError(await call(dflt, [1, ...args(U64_MAX, 1n)]))).toBe(5100);
    expect(customError(await call(dflt, [3, ...args(1n, 0n)]))).toBe(5101);
  });

  it("keeps TypeSOL's failure for u256 arithmetic inside panicsAt, as documented (a Rust U256 type panics with messages of its own)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-u256-"));
    try {
      const file = path.join(dir, "p.ts");
      writeFileSync(
        file,
        `import { type u64, type u128, log, panicsAt, u128 as to128, u256 } from "typesol";
export function f(a: u128, b: u128): void {
  const x = u256(a);
  const y = u256(b);
  log(to128(panicsAt("src/a.rs:1:1", x + y)));
  log(to128(panicsAt("src/a.rs:2:1", x / y)));
  log(panicsAt("src/a.rs:3:1", a + b));
}`,
      );
      const c = generate(file).c;
      expect(c).toMatch(/ts_u256_add\([^\n]*\) TS_FAIL\(TS_ERR_OVERFLOW, "TypeSOL: arithmetic overflow \(p\.ts:5\)"\)/);
      expect(c).toMatch(/ts_u256_is_zero\([^\n]*\) TS_FAIL\(TS_ERR_DIV_ZERO, "TypeSOL: division by zero \(p\.ts:6\)"\)/);
      // A u128 beside it takes Rust's message.
      expect(c).toContain(`{ sol_log("attempt to add with overflow"); sol_panic_("src/a.rs", 8, 3, 1); __builtin_unreachable(); }`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses misuse at compile time", () => {
    const head = `import { panic, panicsAt, u64 } from "typesol";\n`;
    expect(compileErrors(`${head}export const PANIC_STYLE = "solana-1.18";\nexport function f(): void {}`)).toMatch(/PANIC_STYLE must be "solana-1.14"/);
    expect(compileErrors(`${head}export const PANIC_STYLE = "solana-1.14";\nexport function f(): void { panic(null, "a.rs:1:2"); }`)).toMatch(
      /under PANIC_STYLE "solana-1.14" a panic logs its message/,
    );
    expect(compileErrors(`${head}export function f(a: u64): u64 { return panicsAt("a.rs:1", a + 1n); }`)).toMatch(
      /panicsAt\(location, expression\) takes a "file:line:column" string literal/,
    );
    expect(compileErrors(`${head}export function f(a: u64, l: string): u64 { return panicsAt(l, a + 1n); }`)).toMatch(/"file:line:column" string literal/);
    expect(compileErrors(`${head}export function f(a: u64): u64 { let x = a; const y = panicsAt("a.rs:1:2", (x += 1n)); return y; }`)).toMatch(
      /an assignment inside panicsAt is a statement of its own/,
    );
  });
});
