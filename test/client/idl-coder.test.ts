// typesol/testing's own IDL coder (src/idl-coder.ts) against Anchor's BorshCoder: for the IDLs of the examples, the
// `typesol init` templates, the Borsh / Option / zero-copy shape programs of test/language and a hand-written IDL with
// the shapes TypeSOL does not emit (tuples, aliases, generics, 256-bit integers, f32, recursion), seeded random values
// are encoded by both (same bytes) and decoded by both (same values): instructions, accounts and defined types; events
// (which Anchor's coder only decodes) are decoded by both from the same bytes.
import anchor from "@anchor-lang/core";
import { getAddressDecoder } from "@solana/kit";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { generate } from "../../src/compiler/index.js";
import { buildIdl } from "../../src/compiler/idl.js";
import { IdlCoder, type IdlTypeDefSpec, type IdlTypeSpec } from "../../src/idl-coder.js";
import { TEMPLATES, TEMPLATE_NAMES } from "../../src/templates.js";

const { BN, BorshCoder, web3 } = anchor;
type AnyIdl = {
  instructions: { name: string; args: { name: string; type: IdlTypeSpec }[] }[];
  accounts?: { name: string }[];
  events?: { name: string; discriminator: number[] }[];
  types?: IdlTypeDefSpec[];
};

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ADDRESS = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const idlOf = (file: string) => buildIdl(generate(file).model, ADDRESS) as unknown as AnyIdl;
function idlOfSource(name: string, source: string): AnyIdl {
  const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-idl-coder-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, `${name}.ts`), source);
  return idlOf(path.join(dir, `${name}.ts`));
}
/** The program sources a test file keeps in top-level template strings (`const SOURCE = \`…\``). */
function sourcesIn(testFile: string): [string, string][] {
  const file = path.join(ROOT, "test/language", testFile);
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const out: [string, string][] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations)
      if (
        ts.isIdentifier(d.name) &&
        /^[A-Z_]+$/.test(d.name.text) &&
        d.initializer &&
        ts.isNoSubstitutionTemplateLiteral(d.initializer) &&
        /from "typesol"/.test(d.initializer.text)
      )
        out.push([`${testFile}:${d.name.text}`, d.initializer.text]);
  }
  return out;
}

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const bits = (n: number) => {
    let x = 0n;
    for (let i = 0; i < n; i += 16) x = (x << 16n) | BigInt(int(65536));
    return BigInt.asUintN(n, x);
  };
  return { next, int, bits };
}

const INT_WIDTH: Record<string, [number, boolean]> = {
  u8: [8, false],
  i8: [8, true],
  u16: [16, false],
  i16: [16, true],
  u32: [32, false],
  i32: [32, true],
  u64: [64, false],
  i64: [64, true],
  u128: [128, false],
  i128: [128, true],
  u256: [256, false],
  i256: [256, true],
};
const TEXT = ["", "a", "hello", "naïve", "日本", "🙂x", "0123456789abcdef"];

type Gen = { mine: unknown; theirs: unknown };
type Env = Map<string, { kind: "type"; type: IdlTypeSpec } | { kind: "const"; value: string }>;

/** A random value of `type`: the plain form TypeSOL's coder takes, and the BN / PublicKey / Buffer form Anchor's takes. */
function generator(types: IdlTypeDefSpec[], r: ReturnType<typeof rng>) {
  const byName = new Map(types.map((t) => [t.name, t]));
  const addr = getAddressDecoder();
  const fields = (fs: unknown[] | undefined) =>
    !fs?.length
      ? []
      : (fs[0] as { name?: string }).name
        ? (fs as { name: string; type: IdlTypeSpec }[])
        : (fs as IdlTypeSpec[]).map((type, i) => ({ name: String(i), type }));
  const gen = (type: IdlTypeSpec, env: Env, depth: number): Gen => {
    if (typeof type === "object" && "generic" in type) return gen((env.get(type.generic) as { type: IdlTypeSpec }).type, env, depth);
    if (typeof type === "string") {
      const w = INT_WIDTH[type];
      if (w) {
        const [bits, signed] = w;
        // Edges as often as random values: 0, 1, the minimum, the maximum.
        const pick = r.int(6);
        let n = pick === 0 ? 0n : pick === 1 ? 1n : r.bits(bits);
        if (pick === 2) n = signed ? 1n << BigInt(bits - 1) : 0n;
        if (pick === 3) n = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
        if (signed) n = BigInt.asIntN(bits, n);
        return bits <= 32 ? { mine: Number(n), theirs: Number(n) } : { mine: n, theirs: new BN(n.toString()) };
      }
      switch (type) {
        case "bool": {
          const b = r.int(2) === 1;
          return { mine: b, theirs: b };
        }
        case "f32": {
          const f = Math.fround((r.next() - 0.5) * 10 ** r.int(12));
          return { mine: f, theirs: f };
        }
        case "f64": {
          const f = [0, -1.5, Number.MAX_VALUE, Number.MIN_VALUE, Infinity][r.int(8)] ?? (r.next() - 0.5) * 10 ** r.int(300);
          return { mine: f, theirs: f };
        }
        case "pubkey": {
          const bytes = Uint8Array.from({ length: 32 }, () => r.int(256));
          return { mine: addr.decode(bytes), theirs: new web3.PublicKey(bytes) };
        }
        case "string": {
          const s = TEXT[r.int(TEXT.length)]!;
          return { mine: s, theirs: s };
        }
        case "bytes": {
          const b = Buffer.from(Array.from({ length: r.int(9) }, () => r.int(256)));
          return { mine: b, theirs: Buffer.from(b) };
        }
      }
      throw new Error(`no generator for ${type}`);
    }
    if ("option" in type) {
      if (depth > 3 || r.int(3) === 0) return { mine: null, theirs: null };
      return gen(type.option, env, depth + 1);
    }
    if ("vec" in type || "array" in type) {
      const elem = "vec" in type ? type.vec : type.array[0];
      const lenSpec = "array" in type ? type.array[1] : undefined;
      const len =
        lenSpec === undefined
          ? depth > 3
            ? 0
            : r.int(4)
          : typeof lenSpec === "number"
            ? lenSpec
            : Number((env.get(lenSpec.generic) as { value: string }).value);
      const items = Array.from({ length: len }, () => gen(elem, env, depth + 1));
      return { mine: items.map((x) => x.mine), theirs: items.map((x) => x.theirs) };
    }
    if ("defined" in type) {
      const def = byName.get(type.defined.name)!;
      const inner: Env = new Map();
      (def.generics ?? []).forEach((g, i) => {
        const arg = type.defined.generics![i]!;
        inner.set(
          g.name,
          arg.kind === "type"
            ? {
                kind: "type",
                type: typeof arg.type === "object" && "generic" in arg.type ? (env.get(arg.type.generic) as { type: IdlTypeSpec }).type : arg.type,
              }
            : arg,
        );
      });
      if (def.type.kind === "type") return gen(def.type.alias, inner, depth);
      const struct = (fs: unknown[] | undefined): Gen => {
        const mine: Record<string, unknown> = {};
        const theirs: Record<string, unknown> = {};
        for (const f of fields(fs)) {
          const g = gen(f.type, inner, depth + 1);
          mine[f.name] = g.mine;
          theirs[f.name] = g.theirs;
        }
        return { mine, theirs };
      };
      if (def.type.kind === "struct") return struct(def.type.fields);
      const variants = def.type.variants;
      // Deep in a recursive type, the variant with the fewest fields ends it.
      const v = depth > 3 ? [...variants].sort((a, b) => (a.fields?.length ?? 0) - (b.fields?.length ?? 0))[0]! : variants[r.int(variants.length)]!;
      const body = struct(v.fields);
      return { mine: { [v.name]: body.mine }, theirs: { [v.name]: body.theirs } };
    }
    throw new Error(`no generator for ${JSON.stringify(type)}`);
  };
  return gen;
}

/** Anchor's decoded values in the plain form: bigints for BNs, address strings for PublicKeys. */
function fromAnchor(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (BN.isBN(v)) return BigInt((v as InstanceType<typeof BN>).toString());
  if (v instanceof web3.PublicKey) return v.toBase58();
  if (Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) return v.map(fromAnchor);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromAnchor(x)]));
  return v;
}

/** Hand-written IDL: what Anchor IDLs can hold beyond what TypeSOL emits. */
const SHAPES_IDL = {
  address: ADDRESS,
  metadata: { name: "shapes", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    {
      name: "all",
      discriminator: [1, 2, 3, 4, 5, 6, 7, 8],
      accounts: [],
      args: [
        { name: "wide", type: "u256" },
        { name: "wide_signed", type: "i256" },
        { name: "single", type: "f32" },
        { name: "pair", type: { defined: { name: "Pair" } } },
        { name: "alias", type: { defined: { name: "Amounts" } } },
        { name: "boxed", type: { defined: { name: "Boxed", generics: [{ kind: "type", type: "u64" }] } } },
        {
          name: "sized",
          type: {
            defined: {
              name: "Sized",
              generics: [
                { kind: "type", type: "i16" },
                { kind: "const", value: "3" },
              ],
            },
          },
        },
        { name: "tree", type: { defined: { name: "Tree" } } },
        { name: "shape", type: { defined: { name: "Shape" } } },
        { name: "maybe", type: { option: { vec: { option: "string" } } } },
      ],
    },
    { name: "nothing", discriminator: [9], accounts: [], args: [] },
  ],
  accounts: [{ name: "Holder", discriminator: [7, 7] }],
  events: [{ name: "Tree", discriminator: [5, 5, 5, 5, 5, 5, 5, 5] }],
  types: [
    { name: "Pair", type: { kind: "struct", fields: ["u8", "pubkey"] } },
    { name: "Amounts", type: { kind: "type", alias: { vec: "u64" } } },
    { name: "Boxed", generics: [{ kind: "type", name: "T" }], type: { kind: "struct", fields: [{ name: "value", type: { generic: "T" } }] } },
    {
      name: "Sized",
      generics: [
        { kind: "type", name: "T" },
        { kind: "const", name: "N", type: "usize" },
      ],
      type: { kind: "struct", fields: [{ name: "items", type: { array: [{ generic: "T" }, { generic: "N" }] } }] },
    },
    {
      name: "Tree",
      type: {
        kind: "struct",
        fields: [
          { name: "label", type: "string" },
          { name: "children", type: { vec: { defined: { name: "Tree" } } } },
        ],
      },
    },
    {
      name: "Shape",
      type: {
        kind: "enum",
        variants: [
          { name: "Empty" },
          { name: "Circle", fields: ["f64"] },
          {
            name: "Rect",
            fields: [
              { name: "w", type: "u32" },
              { name: "h", type: { option: "i64" } },
            ],
          },
          { name: "Nested", fields: [{ defined: { name: "Pair" } }, { array: ["bool", 2] }] },
        ],
      },
    },
    {
      name: "Holder",
      type: {
        kind: "struct",
        fields: [
          { name: "shape", type: { defined: { name: "Shape" } } },
          { name: "tree", type: { option: { defined: { name: "Tree" } } } },
        ],
      },
    },
  ],
} as unknown as AnyIdl;

const programs: [string, () => AnyIdl][] = [
  ...["airdrop", "caller", "counter", "escrow", "ledgerbook", "minter", "profiles", "relay", "vault"].map((n): [string, () => AnyIdl] => [
    `examples/${n}`,
    () => idlOf(path.join(ROOT, "examples", `${n}.ts`)),
  ]),
  ["examples/orderbook", () => idlOf(path.join(ROOT, "examples/orderbook/orderbook.ts"))],
  ...TEMPLATE_NAMES.map((n): [string, () => AnyIdl] => [`template ${n}`, () => idlOfSource(n, TEMPLATES[n].program)]),
  ...["borsh-enums", "borsh-features", "borsh-native", "borsh-values", "option-text", "optional"].map((n): [string, () => AnyIdl] => [
    `fixtures/${n}`,
    () => idlOf(path.join(ROOT, "test/fixtures", `${n}.ts`)),
  ]),
  ...[
    "anchor-shapes.test.ts",
    "borsh-nested.test.ts",
    "borsh-vec.test.ts",
    "option-helper-args.test.ts",
    "option-seeds.test.ts",
    "option-struct-args.test.ts",
    "option-vec-args.test.ts",
    "zero-copy-shapes.test.ts",
  ].flatMap((f) => sourcesIn(f).map(([name, src]): [string, () => AnyIdl] => [name, () => idlOfSource("p", src)])),
  ["hand-written shapes", () => SHAPES_IDL],
];

const CASES = 200;
/** Event cases compared across all programs (checked after them). */
let eventCases = 0;

describe("typesol/testing's IDL coder matches Anchor's BorshCoder", () => {
  it("finds the shape programs in the test files", () => {
    expect(programs.length).toBeGreaterThan(25);
  });

  for (const [name, load] of programs)
    it(name, async () => {
      const idl = load();
      const mine = new IdlCoder(idl as never);
      const theirs = new BorshCoder(idl as never);
      const types = (idl.types ?? []) as IdlTypeDefSpec[];
      let seed = 0;
      for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
      const r = rng(seed);
      const gen = generator(types, r);
      let compared = 0;

      for (const ix of idl.instructions) {
        for (let i = 0; i < CASES; i++) {
          const args = ix.args.map((a) => [a.name, gen(a.type, new Map(), 0)] as const);
          const a = mine.encodeInstruction(ix.name, Object.fromEntries(args.map(([k, g]) => [k, g.mine])));
          const b = theirs.instruction.encode(ix.name, Object.fromEntries(args.map(([k, g]) => [k, g.theirs])));
          expect(a.toString("hex"), `${ix.name} #${i}`).toBe(Buffer.from(b).toString("hex"));
          expect(mine.decodeInstruction(ix.name, a)).toEqual(Object.fromEntries(args.map(([k, g]) => [k, g.mine])));
          compared++;
        }
      }

      const decodeBoth = (what: string, bytes: Buffer, ours: () => unknown, anchors: () => unknown) => {
        expect(ours(), what).toEqual(fromAnchor(anchors()));
      };
      for (const acc of idl.accounts ?? []) {
        const cases = JSON.stringify(types.find((t) => t.name === acc.name)).length > 4000 ? 10 : CASES;
        for (let i = 0; i < cases; i++) {
          const g = gen({ defined: { name: acc.name } }, new Map(), 0);
          const a = mine.encodeAccount(acc.name, g.mine);
          // Anchor's account encoder writes into a 1000-byte buffer: larger accounts are compared by decoding only.
          if (a.length <= 1000)
            expect(a.toString("hex"), `${acc.name} #${i}`).toBe(Buffer.from(await theirs.accounts.encode(acc.name, g.theirs)).toString("hex"));
          decodeBoth(
            `${acc.name} #${i}`,
            a,
            () => mine.decodeAccount(acc.name, a),
            () => theirs.accounts.decode(acc.name, a),
          );
          expect(mine.decodeAccount(acc.name, a)).toEqual(g.mine);
          compared++;
        }
      }

      // Events: the discriminator, then the fields, as `emit` writes them; Anchor's coder takes them in base64.
      for (const ev of idl.events ?? []) {
        for (let i = 0; i < CASES; i++) {
          const g = gen({ defined: { name: ev.name } }, new Map(), 0);
          const bytes = Buffer.concat([Buffer.from(ev.discriminator), mine.encodeType(ev.name, g.mine)]);
          const anchors = theirs.events.decode(bytes.toString("base64"))!;
          expect(mine.decodeEvent(bytes), `${ev.name} #${i}`).toEqual({ name: anchors.name, data: fromAnchor(anchors.data) });
          expect(mine.decodeEvent(bytes)).toEqual({ name: ev.name, data: g.mine });
          // Another discriminator (the first byte changed), or too few bytes for one: not an event, null from both.
          const wrong = Buffer.from(bytes);
          wrong[0] = (wrong[0]! + 1) % 256;
          if (!(idl.events ?? []).some((e) => Buffer.from(e.discriminator).equals(wrong.subarray(0, e.discriminator.length)))) {
            expect(mine.decodeEvent(wrong)).toBeNull();
            expect(theirs.events.decode(wrong.toString("base64"))).toBeNull();
          }
          const short = bytes.subarray(0, ev.discriminator.length - 1);
          expect(mine.decodeEvent(short)).toBeNull();
          expect(theirs.events.decode(short.toString("base64"))).toBeNull();
          compared++;
          eventCases++;
        }
      }

      for (const t of types) {
        if (t.generics?.length) continue;
        const cases = JSON.stringify(t).length > 4000 ? 10 : CASES;
        for (let i = 0; i < cases; i++) {
          const g = gen({ defined: { name: t.name } }, new Map(), 0);
          const a = mine.encodeType(t.name, g.mine);
          if (a.length <= 1000) expect(a.toString("hex"), `${t.name} #${i}`).toBe(Buffer.from(theirs.types.encode(t.name, g.theirs)).toString("hex"));
          // A few extra bytes after the value are ignored by both.
          const padded = Buffer.concat([a, Buffer.from([1, 2, 3])]);
          decodeBoth(
            `${t.name} #${i}`,
            padded,
            () => mine.decodeType(t.name, padded),
            () => theirs.types.decode(t.name, padded),
          );
          expect(mine.decodeType(t.name, a)).toEqual(g.mine);
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(0);
    });

  it("compared events of several programs", () => {
    expect(eventCases).toBeGreaterThan(CASES * 5);
  });

  it("random bytes: both decoders give the same value or both refuse", () => {
    const coders = programs.map(([, load]) => load()).map((idl) => ({ idl, mine: new IdlCoder(idl as never), theirs: new BorshCoder(idl as never) }));
    const r = rng(7);
    let agreed = 0;
    for (const { idl, mine, theirs } of coders)
      for (const t of idl.types ?? []) {
        if ((t as IdlTypeDefSpec).generics?.length) continue;
        for (let i = 0; i < 40; i++) {
          const bytes = Buffer.from(Array.from({ length: r.int(80) }, () => (r.int(3) === 0 ? r.int(3) : r.int(256))));
          let ours: unknown, anchors: unknown;
          let oursFailed = false,
            anchorsFailed = false;
          try {
            ours = mine.decodeType(t.name, bytes);
          } catch {
            oursFailed = true;
          }
          try {
            anchors = fromAnchor(theirs.types.decode(t.name, bytes));
          } catch {
            anchorsFailed = true;
          }
          expect(oursFailed, `${t.name} ${bytes.toString("hex")}`).toBe(anchorsFailed);
          if (!oursFailed) expect(ours).toEqual(anchors);
          agreed++;
        }
      }
    expect(agreed).toBeGreaterThan(1000);
  });

  it("odd inputs: fractions, missing fixed-size fields, wrong array lengths, a wrong discriminator", () => {
    const idl = idlOfSource(
      "odd",
      `import { type FixedArray, type Mut, type Pubkey, type Signer, type u8, type u16, type u64 } from "typesol";
export interface Point { x: u16; y: u16 }
export interface Holder { owner: Pubkey; n: u64; small: u8 }
export function set(payer: Signer, holder: Mut<Holder>, small: u8, wide: u16, flag: boolean, at: Point, three: FixedArray<u8, 3>): void {
  holder.small = small;
}
`,
    );
    const mine = new IdlCoder(idl as never);
    const theirs = new BorshCoder(idl as never);
    const both = (args: Record<string, unknown>) => {
      let a: string | Error, b: string | Error;
      try {
        a = mine.encodeInstruction("set", args).toString("hex");
      } catch (e) {
        a = e as Error;
      }
      try {
        b = Buffer.from(theirs.instruction.encode("set", args)).toString("hex");
      } catch (e) {
        b = e as Error;
      }
      return [a, b] as const;
    };
    // Fractions are cut as Buffer's writers cut them; a missing fixed-size field is zeros.
    for (const args of [
      { small: 1.7, wide: 300.2, flag: 1, at: { x: 1, y: 2 }, three: [1, 2, 3] },
      { small: 1, wide: 2, flag: undefined, at: { x: 5 }, three: [1, 2, 3] },
      { small: 1, wide: 2, flag: true, at: undefined, three: [9, 9, 9] },
    ]) {
      const [a, b] = both(args);
      expect(typeof a).toBe("string");
      expect(a).toBe(b);
    }
    // Both refuse a wrong array length, an integer out of range and a missing argument.
    for (const args of [
      { small: 1, wide: 2, flag: true, at: { x: 1, y: 2 }, three: [1, 2] },
      { small: 256, wide: 2, flag: true, at: { x: 1, y: 2 }, three: [1, 2, 3] },
      { small: 1, wide: 2, flag: true, three: [1, 2, 3] },
    ]) {
      const [a, b] = both(args);
      expect(a).toBeInstanceOf(Error);
      expect(b).toBeInstanceOf(Error);
    }
    const data = Buffer.alloc(8 + 32 + 8 + 1);
    expect(() => mine.decodeAccount("Holder", data)).toThrow("Invalid account discriminator");
    expect(() => theirs.accounts.decode("Holder", data)).toThrow("Invalid account discriminator");
    expect(() => mine.decodeAccount("Nope", data)).toThrow("Account not found: Nope");
    expect(() => mine.encodeInstruction("nope", {})).toThrow("Unknown method: nope");
    expect(() => mine.decodeType("Nope", data)).toThrow("Unknown type: Nope");
  });

  it("strict: a missing field or argument that is not an Option, or a key that names none, is an error", () => {
    const idl = idlOfSource(
      "strict",
      `import { type FixedArray, type Option, type Signer, type u8, type u16 } from "typesol";
export interface Point { x: u16; y: u16 }
export type Shape = { kind: "Dot"; at: Point } | { kind: "None" };
export function set(payer: Signer, small: u8, at: Point, cap: Option<u16>, shape: Shape, three: FixedArray<u8, 3>): void {}
`,
    );
    const loose = new IdlCoder(idl as never);
    const strict = new IdlCoder(idl as never, { strict: true });
    const theirs = new BorshCoder(idl as never);
    const full = { small: 1, at: { x: 1, y: 2 }, cap: 5, shape: { Dot: { at: { x: 3, y: 4 } } }, three: [1, 2, 3] };
    // The same bytes as Anchor's for complete arguments, an Option left out included.
    const { cap: _, ...noCap } = full;
    for (const args of [full, noCap]) expect(strict.encodeInstruction("set", args).equals(Buffer.from(theirs.instruction.encode("set", args)))).toBe(true);
    // What the loose coder writes as zeros (as Anchor's does) or ignores, the strict one refuses, naming it.
    const cases: [Record<string, unknown>, string][] = [
      [{ ...full, small: undefined }, "set.small: missing (only an Option may be left out)"],
      [{ ...full, at: { x: 1 } }, "set.at.y: missing (only an Option may be left out)"],
      [{ ...full, shape: { Dot: { at: { y: 4 } } } }, "set.shape.Dot.at.x: missing"],
      [{ ...full, at: { x: 1, y: 2, z: 3 } }, 'set.at: no field "z" (the fields are x, y)'],
      [{ ...full, shape: { Dot: { at: { x: 3, y: 4 }, extra: 1 } } }, 'set.shape.Dot: no field "extra" (the fields are at)'],
      [{ ...full, capp: 5 }, 'Invalid arguments for instruction "set": no argument `capp` (it takes small, at, cap, shape, three)'],
    ];
    for (const [args, message] of cases) {
      expect(loose.encodeInstruction("set", args).equals(Buffer.from(theirs.instruction.encode("set", args)))).toBe(true);
      expect(() => strict.encodeInstruction("set", args)).toThrow(message);
    }
  });

  it("refuses at construction an IDL type it does not read, naming it", () => {
    const idl = {
      ...SHAPES_IDL,
      instructions: [{ name: "c", discriminator: [1], accounts: [], args: [{ name: "x", type: { coption: "u64" } }] }],
      accounts: [],
    };
    expect(() => new IdlCoder(idl as never)).toThrow(/coption/);
    expect(() => new BorshCoder(idl as never)).toThrow();
    const unknown = { ...idl, instructions: [{ name: "c", discriminator: [1], accounts: [], args: [{ name: "x", type: "u512" }] }] };
    expect(() => new IdlCoder(unknown as never)).toThrow(/u512/);
  });
});
