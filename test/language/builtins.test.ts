// The compiler builtins of runtime/typesol_builtins.c, run as SBF in LiteSVM: every function against a BigInt reference
// on edge cases and a seeded random set, against platform-tools' compiler-builtins on the same inputs (the results, and
// the compute units: never more), division by zero, and the set of builtins C integer code can reference.
import { AccountRole, address, generateKeyPairSigner, lamports, type Address } from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTINS_SOURCE, builtinsCflags, findToolchain, linkSharedObject, sbfCflags, type Sbpf, unresolvedSymbols } from "../../src/compiler/toolchain.js";
import { expectOk, fundedSigner, send } from "../harness.js";

const HARNESS = fileURLToPath(new URL("../fixtures/builtins/harness.c", import.meta.url));
const SEED = BigInt(process.env.FUZZ_SEED ?? 20261112);
const RANDOM = Number(process.env.BUILTINS_RANDOM ?? 20_000);

const M64 = (1n << 64n) - 1n;
const M128 = (1n << 128n) - 1n;
const s128 = (x: bigint) => (x >> 127n ? x - (1n << 128n) : x);
const s64 = (x: bigint) => ((x & M64) >> 63n ? (x & M64) - (1n << 64n) : x & M64);
const trunc = (a: bigint, b: bigint) => a / b; // BigInt division rounds toward zero, % takes the dividend's sign, as C

/** The builtins the harness calls, by op byte: the name and the reference result for operands a, b (128-bit unsigned). */
const OPS: { name: string; ref: (a: bigint, b: bigint) => bigint; zeroDivisor?: boolean; shift?: boolean; bits64?: boolean; notV2?: boolean }[] = [
  // SBPF v2 multiplies with its own instructions (no __multi3) and has signed 64-bit division (no __divdi3, __moddi3).
  { name: "__multi3", ref: (a, b) => (a * b) & M128, notV2: true },
  { name: "__udivti3", ref: (a, b) => a / b, zeroDivisor: true },
  { name: "__umodti3", ref: (a, b) => a % b, zeroDivisor: true },
  // MIN / -1 wraps to MIN, as the C the builtin implements (TypeSOL checks it before the call).
  { name: "__divti3", ref: (a, b) => trunc(s128(a), s128(b)) & M128, zeroDivisor: true },
  { name: "__modti3", ref: (a, b) => (s128(a) % s128(b)) & M128, zeroDivisor: true },
  { name: "__ashlti3", ref: (a, b) => (a << (b & 127n)) & M128, shift: true },
  { name: "__lshrti3", ref: (a, b) => a >> (b & 127n), shift: true },
  { name: "__ashrti3", ref: (a, b) => (s128(a) >> (b & 127n)) & M128, shift: true },
  { name: "__divdi3", ref: (a, b) => trunc(s64(a), s64(b)) & M64, zeroDivisor: true, bits64: true, notV2: true },
  { name: "__moddi3", ref: (a, b) => (s64(a) % s64(b)) & M64, zeroDivisor: true, bits64: true, notV2: true },
];

/** SplitMix64: the seeded generator of the random cases. */
function rng(seed: bigint) {
  let s = seed & M64;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & M64;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    return z ^ (z >> 31n);
  };
}

/** Edge values of a 128-bit operand: 0, 1, max, signed min and max, powers of two and their neighbours, one half only. */
function edges(): bigint[] {
  const v = new Set<bigint>([0n, 1n, 2n, 3n, 7n, 10n, M128, M128 - 1n, 1n << 127n, (1n << 127n) - 1n, (1n << 127n) + 1n]);
  for (let i = 0n; i < 128n; i++) for (const d of [-1n, 0n, 1n]) v.add(((1n << i) + d) & M128);
  for (const x of [M64, 1n << 63n, (1n << 63n) - 1n, 0xffff_ffffn, 1n << 32n, 0x1234_5678_9abc_def0n, 10n ** 18n, 10_000n])
    for (const y of [x, x << 64n, (x << 64n) | x, (x << 64n) | 1n, M64 << 64n]) v.add(y & M128);
  for (const x of [...v]) v.add((M128 + 1n - x) & M128); // the negations
  return [...v];
}

/** Random operands by size class: each half random, either half zero, a short (≤ 32-bit or ≤ 64-bit) value, a power of two. */
function randomOperand(next: () => bigint): bigint {
  const r = next();
  const full = (next() << 64n) | next();
  switch (Number(r % 8n)) {
    case 0:
      return full;
    case 1:
      return full & M64; // low half only
    case 2:
      return full & (M64 << 64n); // high half only
    case 3:
      return full & 0xffff_ffffn;
    case 4:
      return full >> ((r >> 8n) % 128n); // any bit length
    case 5:
      return (1n << ((r >> 8n) % 128n)) & M128;
    case 6:
      return (M128 + 1n - (full >> ((r >> 8n) % 128n))) & M128; // a negative of any length
    default:
      return (((full >> 64n) % 1000n) << ((r >> 8n) % 118n)) & M128;
  }
}

type Case = { op: number; a: bigint; b: bigint };

function cases(random: number, sbpf: Sbpf): Case[] {
  const out: Case[] = [];
  const e = edges();
  const next = rng(SEED);
  for (const [op, o] of OPS.entries()) {
    if (sbpf === "v2" && o.notV2) continue;
    const ok = (b: bigint) => (o.zeroDivisor ? (o.bits64 ? b & M64 : b) !== 0n : true);
    if (o.shift) {
      for (const a of e) for (let s = 0n; s < 128n; s += a % 3n === 0n ? 1n : 13n) out.push({ op, a, b: s });
    } else {
      // Every pair of a sample of the edges (all of them against the small divisors), then the random set.
      const pick = e.filter((_, i) => i % 3 === 0);
      for (const a of pick) for (const b of pick) if (ok(b)) out.push({ op, a, b });
    }
    for (let i = 0; i < random; i++) {
      let a = randomOperand(next);
      let b = o.shift ? next() % 128n : randomOperand(next);
      if (o.bits64) [a, b] = [a & M64, b & M64];
      if (!o.shift && next() % 4n === 0n && b !== 0n) a = (a / b) * b + (next() % b); // the divisor below the dividend, mostly
      if (ok(b)) out.push({ op, a: a & M128, b: b & M128 });
    }
  }
  return out;
}

const PER_TX = 1000;

class Harness {
  // Every log line kept: the compute unit lines are the measurement.
  readonly svm = new LiteSVM().withLogBytesLimit();
  constructor(
    readonly programs: Record<string, Address>,
    readonly input: Address,
    readonly output: Address,
  ) {}

  /** Each program's results for `batch`: the 128-bit value and the compute units of the operation. */
  async run(program: Address, batch: Case[]): Promise<{ value: bigint; cu: bigint }[]> {
    const data = Buffer.alloc(8 + batch.length * 40);
    data.writeBigUInt64LE(BigInt(batch.length), 0);
    for (const [i, c] of batch.entries()) {
      const at = 8 + i * 40;
      data[at] = c.op;
      data.writeBigUInt64LE(c.a & M64, at + 8);
      data.writeBigUInt64LE(c.a >> 64n, at + 16);
      data.writeBigUInt64LE(c.b & M64, at + 24);
      data.writeBigUInt64LE(c.b >> 64n, at + 32);
    }
    const account = (addr: Address, bytes: Uint8Array) =>
      this.svm.setAccount({
        address: addr,
        data: bytes,
        executable: false,
        lamports: lamports(1_000_000_000n),
        programAddress: program,
        space: BigInt(bytes.length),
      });
    account(this.input, data);
    account(this.output, new Uint8Array(batch.length * 16));
    const payer = await fundedSigner(this.svm);
    const res = expectOk(await this.send(program, payer));
    const result = this.svm.getAccount(this.output);
    if (!result.exists) throw new Error("no output account");
    const out = Buffer.from(result.data);
    // Two "Program consumption: N units remaining" lines per case: the units between them are the operation's, and the
    // harness's own (the call of run(), one log syscall), the same in every build.
    const left = res
      .logs()
      .flatMap((l) => /^Program consumption: (\d+) units remaining$/.exec(l)?.[1] ?? [])
      .map(BigInt);
    if (left.length !== batch.length * 2) throw new Error(`expected ${batch.length * 2} compute unit lines, got ${left.length}`);
    return batch.map((_, i) => ({
      value: out.readBigUInt64LE(i * 16) | (out.readBigUInt64LE(i * 16 + 8) << 64n),
      cu: left[2 * i]! - left[2 * i + 1]!,
    }));
  }

  /** One case, the transaction's outcome as it is (for the cases that fail). */
  async single(program: Address, c: Case) {
    const account = (addr: Address, bytes: Uint8Array) =>
      this.svm.setAccount({
        address: addr,
        data: bytes,
        executable: false,
        lamports: lamports(1_000_000_000n),
        programAddress: program,
        space: BigInt(bytes.length),
      });
    account(this.input, caseData(c));
    account(this.output, new Uint8Array(16));
    return this.send(program, await fundedSigner(this.svm));
  }

  send(program: Address, payer: Awaited<ReturnType<typeof generateKeyPairSigner>>) {
    return send(this.svm, payer, [
      { programAddress: address("ComputeBudget111111111111111111111111111111"), data: new Uint8Array([2, 0xc0, 0x5c, 0x15, 0x00]) }, // 1.4M units
      {
        programAddress: program,
        accounts: [
          { address: this.input, role: AccountRole.READONLY },
          { address: this.output, role: AccountRole.WRITABLE },
        ],
        data: new Uint8Array(),
      },
    ]);
  }
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "typesol-builtins-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The harness linked with the runtime's builtins ("runtime") or with platform-tools' compiler-builtins ("toolchain"). */
function buildHarness(sbpf: Sbpf = "v0"): Record<"runtime" | "toolchain", string> {
  const tc = findToolchain(sbpf);
  const cflags = sbfCflags(sbpf);
  const incs = tc.includes.flatMap((i, n) => (n < 2 ? ["-isystem", i] : ["-I", i]));
  const obj = path.join(tmp, `harness-${sbpf}.o`);
  const builtins = path.join(tmp, `builtins-${sbpf}.o`);
  execFileSync(tc.clang, [...cflags, ...incs, "-o", obj, "-c", HARNESS]);
  execFileSync(tc.clang, [...builtinsCflags(sbpf), "-o", builtins, "-c", BUILTINS_SOURCE]);
  const runtime = path.join(tmp, `runtime-${sbpf}.so`);
  const toolchain = path.join(tmp, `toolchain-${sbpf}.so`);
  linkSharedObject([obj, builtins], runtime, tc);
  linkSharedObject([obj], toolchain, tc, [tc.compilerBuiltins]);
  return { runtime, toolchain };
}

// SBPF v0 (the default) with the whole random set; v1 and v2 (their own assembly, __multi3 in C) with a tenth of it.
describe.each([
  ["v0", RANDOM],
  ["v1", RANDOM / 10],
  ["v2", RANDOM / 10],
] as const)("compiler builtins, SBPF %s", (sbpf, random) => {
  let h: Harness;
  let all: Case[];
  const results: Record<"runtime" | "toolchain", { value: bigint; cu: bigint }[]> = { runtime: [], toolchain: [] };

  beforeAll(async () => {
    const so = buildHarness(sbpf);
    const ids = { runtime: (await generateKeyPairSigner()).address, toolchain: (await generateKeyPairSigner()).address };
    h = new Harness(ids, (await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address);
    h.svm.addProgramFromFile(ids.runtime, so.runtime);
    h.svm.addProgramFromFile(ids.toolchain, so.toolchain);
    all = cases(random, sbpf);
    for (let i = 0; i < all.length; i += PER_TX) {
      const batch = all.slice(i, i + PER_TX);
      for (const k of ["runtime", "toolchain"] as const) results[k].push(...(await h.run(ids[k], batch)));
    }
  }, 600_000);

  it("give the reference result for every case, edge and random", () => {
    const wrong: string[] = [];
    for (const [i, c] of all.entries()) {
      const want = OPS[c.op]!.ref(c.a, c.b);
      const got = results.runtime[i]!.value & (OPS[c.op]!.bits64 ? M64 : M128);
      if (got !== want && wrong.length < 10)
        wrong.push(`${OPS[c.op]!.name}(0x${c.a.toString(16)}, 0x${c.b.toString(16)}) = 0x${got.toString(16)}, expected 0x${want.toString(16)}`);
    }
    expect(wrong).toEqual([]);
    // Each function was exercised, edge cases and random ones (seed in FUZZ_SEED).
    for (const [op, o] of OPS.entries()) if (sbpf !== "v2" || !o.notV2) expect(all.filter((c) => c.op === op).length).toBeGreaterThan(random / 2);
  });

  it("give the results platform-tools' compiler-builtins gives", () => {
    const differ = all.flatMap((c, i) =>
      results.runtime[i]!.value !== results.toolchain[i]!.value ? [`${OPS[c.op]!.name}(0x${c.a.toString(16)}, 0x${c.b.toString(16)})`] : [],
    );
    expect(differ.slice(0, 10)).toEqual([]);
  });

  it("cost no more compute units than compiler-builtins on any case", () => {
    const rows: string[] = [];
    const worse: string[] = [];
    for (const [op, o] of OPS.entries()) {
      const idx = all.flatMap((c, i) => (c.op === op ? [i] : []));
      if (!idx.length) continue;
      const cu = (k: "runtime" | "toolchain") => idx.map((i) => Number(results[k][i]!.cu));
      const [r, t] = [cu("runtime"), cu("toolchain")];
      const sum = (x: number[]) => x.reduce((a, b) => a + b, 0);
      rows.push(
        `${o.name.padEnd(10)} cases ${String(idx.length).padStart(6)}  mean ${(sum(r) / r.length).toFixed(1).padStart(7)} vs ${(sum(t) / t.length).toFixed(1).padStart(7)}` +
          `  max ${String(r.reduce((m, x) => Math.max(m, x), 0)).padStart(4)} vs ${String(t.reduce((m, x) => Math.max(m, x), 0)).padStart(4)}`,
      );
      if (process.env.BUILTINS_WORSE) {
        const w = idx.flatMap((i, j) => (r[j]! > t[j]! ? [{ i, d: r[j]! - t[j]!, r: r[j]!, t: t[j]! }] : []));
        console.log(
          `${o.name}: ${w.length} worse`,
          w
            .sort((x, y) => y.d - x.d)
            .slice(0, 12)
            .map((x) => `0x${all[x.i]!.a.toString(16)} 0x${all[x.i]!.b.toString(16)} ${x.r}/${x.t}`)
            .join("\n  "),
        );
      }
      for (const [j, i] of idx.entries())
        if (r[j]! > t[j]! && worse.length < 10) worse.push(`${o.name}(0x${all[i]!.a.toString(16)}, 0x${all[i]!.b.toString(16)}): ${r[j]} > ${t[j]}`);
    }
    console.log([`SBPF ${sbpf}: compute units per call, runtime vs compiler-builtins (the harness's measuring included):`, ...rows].join("\n"));
    expect(worse).toEqual([]);
  });

  it("stop with the VM's division-by-zero error on a zero divisor", async () => {
    // TypeSOL checks every divisor before dividing (TS_ERR_DIV_ZERO), so a builtin never sees zero; if one did, it divides
    // by zero with the 64-bit instruction.
    for (const [op, o] of OPS.entries()) {
      if (!o.zeroDivisor || (sbpf === "v2" && o.notV2)) continue;
      for (const a of [0n, 5n, M64, M128]) {
        const res = await h.single(h.programs.runtime!, { op, a, b: 0n });
        expect(res).toBeInstanceOf(FailedTransactionMetadata);
        expect((res as FailedTransactionMetadata).meta().logs().join("\n"), `${o.name}(${a}, 0)`).toMatch(/divide by zero|DivideByZero/i);
      }
    }
  });
});

function caseData(c: Case): Uint8Array {
  const data = Buffer.alloc(48);
  data.writeBigUInt64LE(1n, 0);
  data[8] = c.op;
  data.writeBigUInt64LE(c.a & M64, 16);
  data.writeBigUInt64LE(c.a >> 64n, 24);
  data.writeBigUInt64LE(c.b & M64, 32);
  data.writeBigUInt64LE(c.b >> 64n, 40);
  return data;
}

describe("the builtins C can reference", () => {
  it("are the ones the runtime defines, for SBPF v0, v1 and v2", () => {
    // Every C integer operation TypeSOL's code generator or runtime can produce, on every width: arithmetic, shifts,
    // the overflow builtins, and the bit operations.
    const src = path.join(tmp, "matrix.c");
    const ops = (t: string, n: string) =>
      `${t} ${n}_mul(${t} a, ${t} b) { return a * b; } ${t} ${n}_div(${t} a, ${t} b) { return a / b; } ${t} ${n}_rem(${t} a, ${t} b) { return a % b; } ` +
      `${t} ${n}_shl(${t} a, unsigned long long b) { return a << b; } ${t} ${n}_shr(${t} a, unsigned long long b) { return a >> b; } ` +
      `_Bool ${n}_addo(${t} a, ${t} b, ${t} *o) { return __builtin_add_overflow(a, b, o); } _Bool ${n}_subo(${t} a, ${t} b, ${t} *o) { return __builtin_sub_overflow(a, b, o); } ` +
      `_Bool ${n}_mulo(${t} a, ${t} b, ${t} *o) { return __builtin_mul_overflow(a, b, o); } ${t} ${n}_divc(${t} a) { return a / 10; } ${t} ${n}_remc(${t} a) { return a % 1000000007; }\n`;
    const types: [string, string][] = [
      ["unsigned char", "u8"],
      ["signed char", "i8"],
      ["unsigned short", "u16"],
      ["short", "i16"],
      ["unsigned int", "u32"],
      ["int", "i32"],
      ["unsigned long long", "u64"],
      ["long long", "i64"],
      ["unsigned __int128", "u128"],
      ["__int128", "i128"],
    ];
    // The bit operations: counts of leading and trailing zeros and of ones, byte swaps, ffs and parity. clang emits
    // them inline on SBF (no libcall) today; listed so that a libcall from another clang shows here.
    const bits = (t: string, n: string) =>
      `int ${n}_clz(${t} a) { return __builtin_clzg(a, -1); } int ${n}_ctz(${t} a) { return __builtin_ctzg(a, -1); } int ${n}_pop(${t} a) { return __builtin_popcountg(a); }\n`;
    const swaps =
      "unsigned short b16(unsigned short a) { return __builtin_bswap16(a); } unsigned int b32(unsigned int a) { return __builtin_bswap32(a); } " +
      "unsigned long long b64(unsigned long long a) { return __builtin_bswap64(a); } int ffs64(long long a) { return __builtin_ffsll(a); } " +
      "int parity64(unsigned long long a) { return __builtin_parityll(a); }\n";
    writeFileSync(
      src,
      types.map(([t, n]) => ops(t, n)).join("") +
        types
          .filter(([t]) => t.startsWith("unsigned"))
          .map(([t, n]) => bits(t, n))
          .join("") +
        swaps,
    );
    // The functions the file defines, in C or in assembly.
    const text = readFileSync(BUILTINS_SOURCE, "utf8");
    const inC = [...text.matchAll(/^TS_BUILTIN \w+ (__\w+)\(/gm)].map((m) => m[1]!);
    const inAsm = [...text.matchAll(/^ {2}"\.globl (__\w+)\\n"$/gm)].map((m) => m[1]!);
    const defined = [...new Set([...inC, ...inAsm])];
    for (const sbpf of ["v0", "v1", "v2"] as const) {
      const tc = findToolchain(sbpf);
      const obj = path.join(tmp, `matrix-${sbpf}.o`);
      execFileSync(tc.clang, [...sbfCflags(sbpf), "-o", obj, "-c", src]);
      const readelf = path.join(path.dirname(tc.clang), "llvm-readelf");
      const undefinedSyms = (o: string) =>
        execFileSync(readelf, ["-s", "-W", o], { encoding: "utf8" })
          .split("\n")
          .filter((l) => / UND \S/.test(l))
          .map((l) => l.trim().split(/\s+/).at(-1)!);
      const needed = undefinedSyms(obj);
      // The builtins' object for this version defines each of them, and calls nothing outside itself.
      const b = path.join(tmp, `builtins-only-${sbpf}.o`);
      execFileSync(tc.clang, [...builtinsCflags(sbpf), "-o", b, "-c", BUILTINS_SOURCE]);
      const definedHere = execFileSync(readelf, ["-s", "-W", b], { encoding: "utf8" })
        .split("\n")
        .filter((l) => / FUNC +GLOBAL +HIDDEN +\d+ __\w+$/.test(l))
        .map((l) => l.trim().split(/\s+/).at(-1)!);
      expect(
        needed.filter((s) => !definedHere.includes(s)),
        `SBPF ${sbpf}`,
      ).toEqual([]);
      expect(definedHere.sort(), `SBPF ${sbpf}`).toEqual(defined.slice().sort());
      expect(undefinedSyms(b), `SBPF ${sbpf}`).toEqual([]);
      // Linked into a program, nothing is left for the loader but syscalls.
      const so = path.join(tmp, `matrix-${sbpf}.so`);
      writeFileSync(path.join(tmp, "entry.c"), `extern unsigned long long entrypoint(const unsigned char *in) { return 0; }\n`);
      execFileSync(tc.clang, [...sbfCflags(sbpf), "-o", path.join(tmp, "entry.o"), "-c", path.join(tmp, "entry.c")]);
      linkSharedObject([path.join(tmp, "entry.o"), b], so, tc, ["--undefined=__udivti3"]);
      expect(unresolvedSymbols(readFileSync(so))).toEqual([]);
    }
    expect(defined.sort()).toEqual([
      "__ashlti3",
      "__ashrti3",
      "__divdi3",
      "__divti3",
      "__lshrti3",
      "__moddi3",
      "__modti3",
      "__multi3",
      "__udivti3",
      "__umodti3",
    ]);
  });
});
