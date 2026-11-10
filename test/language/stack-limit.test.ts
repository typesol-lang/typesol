// SBF's 4 KiB stack frame: a function over it is a build error naming the instruction or helper, not memory corruption.
import { type Instruction, type KeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { build, generate } from "../../src/compiler/index.js";
import { type Deployed, compileErrors, deployFile, fundedSigner, send } from "../harness.js";

const FRAMES = fileURLToPath(new URL("../fixtures/frames.ts", import.meta.url));

const program = (body: string, sbpf: "v0" | "v1" | "v2" = "v0") => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-stack-"));
  const file = path.join(dir, "p.ts");
  writeFileSync(
    file,
    `import { type Account, type FixedArray, type u64, type u8 } from "typesol";
export interface Big { xs: FixedArray<u64, 250>; tag: u64 }
export interface Holder { bump: u8; b: Big }
${body}
`,
  );
  return () => build(file, path.join(dir, "out"), "11111111111111111111111111111112", { sbpf });
};

describe("stack frame limit", () => {
  it("refuses copies that do not fit, naming the instruction", () => {
    const b = program(`export function f(h: Account<Holder>): u64 {
  const q: Big = h.b;
  const r: Big = h.b;
  const s: Big = h.b;
  return q.tag + r.tag + s.tag;
}`);
    expect(b).toThrow(/instruction f \(with the helpers inlined into it\) needs \d+ bytes of stack; SBPF v0 gives each function 4096/);
  });

  it("counts helpers inlined into the instruction", () => {
    const b = program(`function sum(h: Account<Holder>): u64 {
  const q: Big = h.b;
  const r: Big = h.b;
  const s: Big = h.b;
  return q.tag + r.tag + s.tag;
}
export function f(h: Account<Holder>): u64 {
  return sum(h);
}`);
    expect(b).toThrow(/(instruction f \(with the helpers inlined into it\)|helper sum\(\)) needs \d+ bytes of stack/);
  });

  it("leaves SBPF v1 and v2 alone: their frames grow as needed", () => {
    const body = `export function f(h: Account<Holder>): u64 {
  const q: Big = h.b;
  const r: Big = h.b;
  const s: Big = h.b;
  return q.tag + r.tag + s.tag;
}`;
    expect(program(body, "v1")).not.toThrow();
    expect(program(body, "v2")).not.toThrow();
  });

  it("builds the same code with references instead of copies", () => {
    const b = program(`export function f(h: Account<Holder>): u64 {
  const q = h.b;
  const r = h.b;
  const s = h.b;
  return q.tag + r.tag + s.tag;
}`);
    expect(b).not.toThrow();
  });

  it("names the biggest locals, and points at @heap and @noinline", () => {
    const tooBig = readFileSync(FRAMES, "utf8")
      .replace("/** @noinline */\n", "")
      .replace(/\/\*\* @heap \*\/\n\s*/g, "");
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-stack-"));
    const file = path.join(dir, "frames.ts");
    writeFileSync(file, tooBig);
    const b = () => build(file, path.join(dir, "out"), "11111111111111111111111111111112");
    expect(b).toThrow(/instruction entry \(with the helpers inlined into it\) needs \d+ bytes of stack; SBPF v0 gives each function 4096/);
    expect(b).toThrow(/biggest locals: 1284 bytes: `(logData|second)`/);
    expect(b).toThrow(/locals of the helpers inlined into it, among `ids` \(finish\(\)\), `more` \(finish\(\)\)/);
    expect(b).toThrow(/\/\*\* @heap \*\/ .*\/\*\* @noinline \*\//);
  });
});

describe("@noinline helpers and @heap locals", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let nonce = 0;
  beforeAll(async () => {
    d = await deployFile(FRAMES);
    payer = await fundedSigner(d.svm);
  });
  const run = async (tag: number) => {
    const r = await send(d.svm, payer, [{ programAddress: d.programId, accounts: [], data: new Uint8Array([tag, nonce++ & 0xff]) } as Instruction]);
    if (r instanceof FailedTransactionMetadata) throw new Error(`${String(r.err())}\n${r.meta().logs().join("\n")}`);
    return Buffer.from(r.returnData().data());
  };

  it("gives a @noinline helper a frame of its own", async () => {
    expect(await run(0)).toEqual(Buffer.from([0, 9]));
    const c = generate(FRAMES).c;
    expect(c).toContain("__attribute__((noinline)) static uint64_t fn_finish(TsParams *params, uint8_t p_first)");
    expect(c).toMatch(/^static uint64_t fn_record\(/m);
  });

  it("keeps a @heap list on the heap, one allocation per declaration even in a loop", async () => {
    expect(await run(1)).toEqual(Buffer.from([7, 1, 1]));
    // 64 passes: each list and struct built again (1 + 2 + i), in one allocation each.
    expect((await run(2)).readBigUInt64LE(0)).toBe(BigInt(64 * 3 + (63 * 64) / 2));
  });

  const src = (body: string, extra = "") =>
    `import { type FixedVec, type u64, type u8, fixedVec, log } from "typesol";\nexport interface P { x: u64 }\n${extra}\n/** @fallback */\nexport function entry(): void {\n${body}\n}`;

  it("refuses @heap outside an instruction, on values, and past the heap", () => {
    expect(compileErrors(src("  /** @heap */\n  const b: FixedVec<u8, 64> = fixedVec([]);\n  log(b.length);"))).toBe("");
    expect(compileErrors(src("  /** @heap */\n  const p: P = { x: 1n };\n  log(p.x);"))).toBe("");
    expect(compileErrors(src("  h();", "function h(): void {\n  /** @heap */\n  const b: FixedVec<u8, 64> = fixedVec([]);\n  log(b.length);\n}"))).toContain(
      "@heap locals belong to instructions: a helper may run many times per instruction and the heap is never freed",
    );
    expect(compileErrors(src("  /** @heap */\n  const n = 5n;\n  log(n);"))).toContain("@heap is for a local list or struct declared with its type");
    expect(compileErrors(src("  /** @heap */\n  const b: FixedVec<u64, 5000> = fixedVec([]);\n  log(b.length);"))).toContain(
      "this local takes 40004 bytes and the heap holds 32760 (raise HEAP_SIZE_KIB, at most 256)",
    );
  });

  it("refuses a closure for a @noinline helper (it would be expanded where called)", () => {
    const extra = "/** @noinline */\nfunction apply(f: (x: u64) => u64, v: u64): u64 {\n  return f(v);\n}";
    expect(compileErrors(src("  const k = 2n;\n  log(apply((x) => x * k, 3n));", extra))).toContain(
      "apply() is @noinline, but given a closure it is expanded where it is called: pass a named function",
    );
  });
});
