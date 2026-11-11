// The client generator against hostile and unusual IDLs (src/tools/clientgen.ts): shapes it must refuse with a
// ClientIdlError rather than crash or hang on, notes that are safe to print, account names that are also
// Object.prototype properties, and resolve filling in has_one accounts read from a PDA the builder derives. Also
// typesol/testing's returned() on the return types it decodes by hand.
import { type Address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { ClientIdlError, generateClient, type ClientIdl } from "../../src/tools/clientgen.js";
import { programHarness } from "../../src/testing.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
mkdirSync(path.join(ROOT, "target"), { recursive: true });
const OUT = mkdtempSync(path.join(ROOT, "target", "client-hardening-"));
afterAll(() => rmSync(OUT, { recursive: true, force: true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const PROGRAM = "11111111111111111111111111111112" as Address;
const idl = (parts: Partial<ClientIdl>): ClientIdl => ({ address: PROGRAM, metadata: { name: "probe", spec: "0.1.0" }, instructions: [], ...parts });

/** Write a generated client, check it under strict TypeScript, and import it (the program object). */
async function importClient(name: string, source: string): Promise<Any> {
  return (await importModule(name, source)).probe;
}

/** The same, the whole module (its exported codecs too). */
async function importModule(name: string, source: string): Promise<Record<string, Any>> {
  const file = path.join(OUT, `${name}.client.ts`);
  writeFileSync(file, source);
  const program = ts.createProgram([file], {
    strict: true,
    noUnusedLocals: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    erasableSyntaxOnly: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  });
  expect(ts.getPreEmitDiagnostics(program).map((x) => ts.flattenDiagnosticMessageText(x.messageText, "\n"))).toEqual([]);
  return (await import(pathToFileURL(file).href)) as Record<string, Any>;
}

const refused = (i: ClientIdl) => {
  try {
    generateClient(i);
  } catch (e) {
    expect(e).toBeInstanceOf(ClientIdlError);
    return (e as Error).message;
  }
  throw new Error("expected the IDL to be refused");
};

describe("client generator: IDLs it must refuse cleanly", () => {
  it("sizes a deep chain of structs that each hold the next one twice in linear time", () => {
    const types = Array.from({ length: 32 }, (_, i) => ({
      name: `T${i}`,
      type: {
        kind: "struct",
        fields:
          i === 31
            ? [
                { name: "a", type: "u64" },
                { name: "b", type: "u64" },
              ]
            : [
                { name: "a", type: { defined: { name: `T${i + 1}` } } },
                { name: "b", type: { defined: { name: `T${i + 1}` } } },
              ],
      },
    }));
    const start = Date.now();
    const { source } = generateClient(
      idl({ types, instructions: [{ name: "go", discriminator: [1], accounts: [], args: [{ name: "x", type: { coption: { defined: { name: "T0" } } } }] }] }),
    );
    expect(Date.now() - start).toBeLessThan(2000);
    expect(source).toContain(`fixedOption(getT0Codec(), ${2 ** 35}, getU32Codec(), 4)`);
    // A struct that holds itself has no fixed size (not a stack overflow).
    expect(
      refused(
        idl({
          types: [{ name: "Loop", type: { kind: "struct", fields: [{ name: "me", type: { defined: { name: "Loop" } } }] } }],
          instructions: [{ name: "go", discriminator: [1], accounts: [], args: [{ name: "x", type: { coption: { defined: { name: "Loop" } } } }] }],
        }),
      ),
    ).toMatch(/fixed-size/);
  });

  it("refuses bad generic arguments and generic types that instantiate without end", () => {
    const uses = (generics: unknown) =>
      idl({
        types: [
          { name: "Wrap", generics: [{ kind: "type", name: "T" }], type: { kind: "struct", fields: [{ name: "v", type: { generic: "T" } }] } },
          { name: "Uses", type: { kind: "struct", fields: [{ name: "w", type: { defined: { name: "Wrap", generics: generics as never } } }] } },
        ],
      });
    expect(refused(uses([{ kind: "type", type: null }]))).toMatch(/bad type null/);
    expect(refused(uses([{ kind: "type" }]))).toMatch(/bad type/);
    expect(refused(uses([{ kind: "const", value: "abc" }]))).toMatch(/bad generic argument/);
    expect(refused(uses([null]))).toMatch(/bad generic argument/);
    expect(refused(uses("u64"))).toMatch(/generic arguments must be a list/);
    expect(generateClient(uses([{ kind: "type", type: "u64" }])).source).toContain("export interface WrapU64 {");

    // A<T> { n: Option<A<Vec<T>>> }: every instantiation asks for a new one.
    const growing = idl({
      types: [
        {
          name: "A",
          generics: [{ kind: "type", name: "T" }],
          type: {
            kind: "struct",
            fields: [{ name: "n", type: { option: { defined: { name: "A", generics: [{ kind: "type", type: { vec: { generic: "T" } } }] } } } }],
          },
        },
        { name: "B", type: { kind: "struct", fields: [{ name: "a", type: { defined: { name: "A", generics: [{ kind: "type", type: "u64" }] } } }] } },
      ],
    });
    expect(refused(growing)).toMatch(/generic type A is instantiated more than 16 levels deep/);
    // Many distinct uses: capped too.
    const many = idl({
      types: [
        {
          name: "Wrap",
          generics: [{ kind: "const", name: "N", type: "usize" }],
          type: { kind: "struct", fields: [{ name: "v", type: { array: ["u8", { generic: "N" }] } }] },
        },
        {
          name: "Uses",
          type: {
            kind: "struct",
            fields: Array.from({ length: 300 }, (_, i) => ({
              name: `f${i}`,
              type: { defined: { name: "Wrap", generics: [{ kind: "const", value: String(i) }] } },
            })),
          },
        },
      ],
    });
    expect(refused(many)).toMatch(/more than 256 times/);
    // Anything else that throws is still a ClientIdlError, with the original as its cause.
    let caught: unknown;
    const throwing = idl({});
    Object.defineProperty(throwing, "events", {
      get() {
        throw new TypeError("boom");
      },
    });
    try {
      generateClient(throwing);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClientIdlError);
    expect((caught as Error).cause).toBeInstanceOf(TypeError);
    // A null instruction is refused by the IDL check itself, by name.
    expect(refused(idl({ instructions: [null as never] }))).toMatch(/an instruction is not an object/);
  });

  it("refuses array lengths that are not whole numbers and alignments that are not powers of two", () => {
    const withLen = (len: unknown) => idl({ types: [{ name: "S", type: { kind: "struct", fields: [{ name: "a", type: { array: ["u8", len] } }] } }] });
    expect(refused(withLen(-1))).toMatch(/array length -1 is not a whole number/);
    expect(refused(withLen("abc"))).toMatch(/array length "abc" is not a whole number/);
    expect(refused(withLen(1.5))).toMatch(/array length 1.5/);
    expect(refused(withLen({ generic: "1x" }))).toMatch(/is not an identifier/);
    expect(generateClient(withLen(4)).source).toContain("fixCodecSize(getBytesCodec(), 4)");
    const aligned = (repr: unknown) =>
      idl({ types: [{ name: "Z", serialization: "bytemuck", repr, type: { kind: "struct", fields: [{ name: "a", type: "u8" }] } }] });
    expect(refused(aligned({ kind: "c", align: 3 }))).toMatch(/repr align 3 is not a power of two/);
    expect(refused(aligned({ kind: "c", align: 0 }))).toMatch(/repr align 0/);
    expect(refused(aligned("c"))).toMatch(/bad repr/);
    expect(generateClient(aligned({ kind: "c", align: 8 })).source).toContain("Zero-copy (#[repr(C)]) layout: 8 bytes");
  });

  it("escapes control characters from the IDL in notes and errors", () => {
    const { notes } = generateClient(
      idl({
        types: [
          { name: "Weird", type: { kind: "struct", fields: [{ name: "x", type: "u256\u001b[2J\u009b31m‮" }] } },
          { name: "Kind", type: { kind: "evil\u001b]0;title\u0007" } },
          { name: "Ser", serialization: "x\u009b", type: { kind: "struct", fields: [] } },
        ],
      }),
    );
    expect(notes.length).toBe(3);
    for (const n of notes) expect(n).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]/);
    expect(notes[0]).toContain('type "u256\\u001b[2J\\u009b31m\\u202e" is not supported');
    expect(refused(idl({ instructions: [{ name: "go\u009b", discriminator: [1], accounts: [], args: [] }] }))).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("client generator: generated code", () => {
  it("reads accounts named after Object.prototype properties as given, never inherited", async () => {
    const FEE = "SysvarRent111111111111111111111111111111111";
    const c = await importClient(
      "proto",
      generateClient(
        idl({
          instructions: [
            {
              name: "go",
              discriminator: [1],
              accounts: [
                { name: "constructor", writable: true },
                { name: "to_string" },
                { name: "value_of", address: FEE },
                { name: "has_own_property", optional: true },
              ],
              args: [],
            },
            { name: "sign", discriminator: [2], accounts: [{ name: "constructor", signer: true }], args: [] },
          ],
        }),
      ).source,
    );
    await expect(c.go({ toString: PROGRAM })).rejects.toThrow(/account constructor is required/);
    const a = (await generateKeyPairSigner()).address;
    const b = (await generateKeyPairSigner()).address;
    const ix = await c.go({ constructor: a, toString: b });
    // valueOf is filled in with its fixed address; hasOwnProperty is optional and left out (the program id).
    expect(ix.accounts.map((m: Any) => m.address)).toEqual([a, b, FEE, PROGRAM]);
    const signer = await generateKeyPairSigner();
    expect(await c.resolve.sign({}, {}, { signer })).toEqual({ constructor: signer });
  });

  it("derives a has_one source that is a PDA before reading the relation (resolve)", async () => {
    const CONFIG = [1, 1, 1, 1, 1, 1, 1, 1];
    const POOL = [2, 2, 2, 2, 2, 2, 2, 2];
    const FEE = "SysvarRent111111111111111111111111111111111" as Address;
    const config = [...new TextEncoder().encode("config")];
    const c = await importClient(
      "relations",
      generateClient(
        idl({
          accounts: [
            { name: "Config", discriminator: CONFIG },
            { name: "Pool", discriminator: POOL },
          ],
          types: [
            { name: "Config", type: { kind: "struct", fields: [{ name: "vault", type: "pubkey" }] } },
            { name: "Pool", type: { kind: "struct", fields: [{ name: "treasury", type: "pubkey" }] } },
          ],
          instructions: [
            {
              name: "withdraw",
              discriminator: [1],
              accounts: [
                { name: "config", pda: { seeds: [{ kind: "const", value: config }] } },
                { name: "vault", writable: true, relations: ["config"] },
              ],
              args: [],
            },
            {
              // A pool PDA seeded from the signer, a fixed address and an argument.
              name: "sweep",
              discriminator: [2],
              accounts: [
                { name: "user", signer: true },
                { name: "fee", address: FEE },
                {
                  name: "pool",
                  pda: {
                    seeds: [
                      { kind: "account", path: "user" },
                      { kind: "account", path: "fee" },
                      { kind: "arg", path: "id" },
                    ],
                  },
                },
                { name: "treasury", writable: true, relations: ["pool"] },
              ],
              args: [{ name: "id", type: "u8" }],
            },
            {
              name: "poke",
              discriminator: [3],
              accounts: [{ name: "holder" }, { name: "vault", relations: ["holder"] }],
              args: [],
            },
          ],
        }),
      ).source,
    );
    const user = await generateKeyPairSigner();
    const vault = (await generateKeyPairSigner()).address;
    const treasury = (await generateKeyPairSigner()).address;
    const [configPda] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [new Uint8Array(config)] });
    const [poolPda] = await getProgramDerivedAddress({
      programAddress: PROGRAM,
      seeds: [getAddressEncoder().encode(user.address), getAddressEncoder().encode(FEE), new Uint8Array([7])],
    });
    const stored: Record<string, Uint8Array> = {
      [configPda]: new Uint8Array([...CONFIG, ...getAddressEncoder().encode(vault)]),
      [poolPda]: new Uint8Array([...POOL, ...getAddressEncoder().encode(treasury)]),
    };
    const rpc = {
      getAccountInfo: (a: Address) => ({
        send: async () => ({
          context: { slot: 1n },
          value: stored[a]
            ? {
                data: [Buffer.from(stored[a]).toString("base64"), "base64"],
                executable: false,
                lamports: 1n,
                owner: PROGRAM,
                space: BigInt(stored[a].length),
                rentEpoch: 0n,
              }
            : null,
        }),
      }),
    };
    expect(await c.resolve.withdraw(rpc, {})).toEqual({ config: configPda, vault });
    // The builder derives the same config.
    expect((await c.withdraw(await c.resolve.withdraw(rpc, {}))).accounts.map((m: Any) => m.address)).toEqual([configPda, vault]);
    expect(await c.resolve.sweep(rpc, {}, { id: 7 }, { signer: user })).toEqual({ user, pool: poolPda, treasury });
    // A source that is neither given nor derived: a clear error naming it.
    await expect(c.resolve.poke(rpc, {})).rejects.toThrow(/cannot fill in vault: pass holder, the account it is read from/);
  });

  it("encodes a type that holds itself (lazily: building its codec used to recurse until the stack overflowed)", async () => {
    const shape = { defined: { name: "Shape" } };
    const { res, m } = await (async () => {
      const res = generateClient(
        idl({
          instructions: [{ name: "draw", discriminator: [9], accounts: [], args: [{ name: "shape", type: shape }] }],
          accounts: [{ name: "Canvas", discriminator: [7, 7, 7, 7, 7, 7, 7, 7] }],
          types: [
            { name: "Shape", type: { kind: "enum", variants: [{ name: "Dot" }, { name: "Rec", fields: [{ name: "kids", type: { vec: shape } }] }] } },
            { name: "Canvas", type: { kind: "struct", fields: [{ name: "root", type: { option: shape } }] } },
          ],
        }),
      );
      return { res, m: await importModule("recursive", res.source) };
    })();
    expect(res.notes).toEqual([]);
    const tree = { __kind: "Rec", kids: [{ __kind: "Dot" }, { __kind: "Rec", kids: [{ __kind: "Dot" }] }] };
    // Borsh: variant index, then the Vec's u32 length and its elements.
    const bytes = [1, 2, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
    expect([...m.getShapeCodec().encode(tree)]).toEqual(bytes);
    expect(m.getShapeCodec().decode(new Uint8Array(bytes))).toEqual(tree);
    expect([...(await m.probe.draw({}, { shape: tree })).data]).toEqual([9, ...bytes]);
    expect(m.getCanvasCodec().decode(new Uint8Array([1, ...bytes]))).toEqual({ root: tree });
  });

  it("encodes u256 / i256 arguments (32 bytes, little-endian) instead of leaving the instruction out", async () => {
    const res = generateClient(
      idl({
        instructions: [
          {
            name: "wide",
            discriminator: [3],
            accounts: [],
            args: [
              { name: "u", type: "u256" },
              { name: "i", type: "i256" },
            ],
          },
        ],
        types: [
          {
            name: "Pair",
            type: {
              kind: "struct",
              fields: [
                { name: "u", type: "u256" },
                { name: "i", type: "i256" },
              ],
            },
          },
        ],
      }),
    );
    expect(res.notes).toEqual([]);
    const m = await importModule("wide", res.source);
    const max = (1n << 256n) - 1n;
    const data = (await m.probe.wide({}, { u: max, i: -2n })).data as Uint8Array;
    expect([...data]).toEqual([3, ...new Array(32).fill(255), 254, ...new Array(31).fill(255)]);
    const one = [...(await m.probe.wide({}, { u: 0x0102n, i: (1n << 255n) - 1n })).data];
    expect(one.slice(1, 4)).toEqual([2, 1, 0]);
    expect(one.slice(33)).toEqual([...new Array(31).fill(255), 127]);
    expect(m.getPairCodec().decode(Uint8Array.from(data.slice(1)))).toEqual({ u: max, i: -2n });
    expect(m.getPairCodec().decode(new Uint8Array(64).fill(0x80, 63))).toEqual({ u: 0n, i: -(1n << 255n) });
    await expect(m.probe.wide({}, { u: max + 1n, i: 0n })).rejects.toThrow(/does not fit in u256/);
    await expect(m.probe.wide({}, { u: 0n, i: -(1n << 255n) - 1n })).rejects.toThrow(/does not fit in i256/);
    await expect(m.probe.wide({}, { u: -1n, i: 0n })).rejects.toThrow(/does not fit in u256/);
  });

  it("keeps Some(None) apart from None in an Option<Option<T>>, and refuses one level more with a note", async () => {
    const deep = { option: { option: "u8" } };
    const res = generateClient(
      idl({
        instructions: [
          { name: "set", discriminator: [4], accounts: [], args: [{ name: "v", type: deep }] },
          { name: "deeper", discriminator: [5], accounts: [], args: [{ name: "v", type: { option: deep } }] },
        ],
        types: [{ name: "Holder", type: { kind: "struct", fields: [{ name: "v", type: deep }] } }],
      }),
    );
    expect(res.notes).toEqual(["instruction deeper: Option<Option<Option<…>>> is not supported; it is left out"]);
    const m = await importModule("nested-option", res.source);
    const { none, some } = await import("@solana/kit");
    const data = async (v: unknown) => [...(await m.probe.set({}, { v })).data].slice(1);
    expect(await data(null)).toEqual([0]);
    expect(await data(none())).toEqual([1, 0]);
    expect(await data(some(5))).toEqual([1, 1, 5]);
    expect(await data(5)).toEqual([1, 1, 5]);
    expect(m.getHolderCodec().decode(new Uint8Array([0]))).toEqual({ v: null });
    expect(m.getHolderCodec().decode(new Uint8Array([1, 0]))).toEqual({ v: none() });
    expect(m.getHolderCodec().decode(new Uint8Array([1, 1, 5]))).toEqual({ v: some(5) });
  });

  it("fills in a PDA seeded from a field of a field of a struct argument (no note)", async () => {
    const res = generateClient(
      idl({
        instructions: [
          {
            name: "go",
            discriminator: [6],
            accounts: [
              {
                name: "spot",
                pda: {
                  seeds: [
                    { kind: "const", value: [115] },
                    { kind: "arg", path: "params.inner.deep_value" },
                  ],
                },
              },
            ],
            args: [{ name: "params", type: { defined: { name: "Params" } } }],
          },
        ],
        types: [
          { name: "Params", type: { kind: "struct", fields: [{ name: "inner", type: { defined: { name: "Inner" } } }] } },
          { name: "Inner", type: { kind: "struct", fields: [{ name: "deep_value", type: "u32" }] } },
        ],
      }),
    );
    expect(res.notes).toEqual([]);
    const m = await importModule("nested-seed", res.source);
    const params = { inner: { deepValue: 0x01020304 } };
    const [expected] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds: [new Uint8Array([115]), new Uint8Array([4, 3, 2, 1])] });
    expect((await m.probe.go({}, { params })).accounts[0].address).toBe(expected);
    expect((await m.probe.pdas.spot({ params }))[0]).toBe(expected);
  });

  it("reads custom codes from the JSON errors RPC nodes return", async () => {
    const c = await importClient("errors", generateClient(idl({ errors: [{ code: 6000, name: "Nope" }] })).source);
    expect(c.errorCode({ InstructionError: [0, { Custom: 6000 }] })).toBe(6000);
    expect(c.errorCode({ InstructionError: [2, { Custom: 6000n }] })).toBe(6000);
    expect(c.isError(new Error("failed", { cause: { InstructionError: [0, { Custom: 6000 }] } }), "Nope")).toBe(true);
    expect(c.errorCode({ InstructionError: [0, "InvalidArgument"] })).toBeNull();
  });
});

describe("typesol/testing: returned()", () => {
  it("decodes string, bytes and float return values, and refuses what it cannot decode", () => {
    const returns = ["string", "bytes", "f32", "f64", "i16", "u128", { vec: "u8" }];
    const t = programHarness(new LiteSVM(), PROGRAM, {
      ...idl({}),
      instructions: returns.map((r, i) => ({ name: `r${i}`, discriminator: [i], accounts: [], args: [], returns: r })),
    } as never);
    const result = (bytes: number[]) => ({ returnData: () => ({ data: () => new Uint8Array(bytes) }) }) as never;
    const f32 = Buffer.alloc(4);
    f32.writeFloatLE(1.5);
    const f64 = Buffer.alloc(8);
    f64.writeDoubleLE(-2.25);
    expect(t.returned("r0", result([4, 0, 0, 0, ...Buffer.from("héy")]))).toBe("héy");
    expect(t.returned("r1", result([2, 0, 0, 0, 9, 8]))).toEqual(new Uint8Array([9, 8]));
    expect(t.returned("r2", result([...f32]))).toBe(1.5);
    expect(t.returned("r3", result([...f64]))).toBe(-2.25);
    expect(t.returned("r4", result([0xfe, 0xff]))).toBe(-2);
    expect(t.returned("r5", result([1, ...new Array(15).fill(0)]))).toBe(1n);
    expect(() => t.returned("r0", result([9, 0, 0, 0, 1]))).toThrow(/returned 5 bytes; a string needs 13/);
    expect(() => t.returned("r3", result([1, 2]))).toThrow(/a f64 needs 8/);
    expect(() => t.returned("r6", result([0]))).toThrow(/decode r6's return data yourself/);
  });
});
