// Plain type aliases (`type Price = u64`): replaced by the type they name everywhere (test/fixtures/aliases.ts and
// aliases-lib.ts), so layouts and the IDL are those of the type; and the declarations that are not aliases or data enums.
import { type KeyPairSigner } from "@solana/kit";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CompileError, generate } from "../../src/compiler/index.js";
import { buildIdl } from "../../src/compiler/idl.js";
import { BN, type Deployed, compileErrors, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send } from "../harness.js";
import { SYSTEM_PROGRAM } from "../harness.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/aliases.ts", import.meta.url));

describe("type aliases", () => {
  let d: Deployed;
  let user: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(FIXTURE);
    user = await fundedSigner(d.svm);
  });

  it("are the types they name in account data, arguments, data enums and helpers", async () => {
    const [book] = await pda(d.programId, ["book"]);
    expectOk(
      await send(d.svm, user, [
        ix(d, "create", {}, [{ address: user.address, signer: user, writable: true }, { address: book, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const r = expectOk(
      await send(d.svm, user, [
        ix(d, "place", { price: new BN(40), lots: new BN(2) }, [
          { address: user.address, signer: user, writable: true },
          { address: book, writable: true },
        ]),
      ]),
    );
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE(0)).toBe(42n);
    expect(r.logs()).toContain("Program log: 3");
    type Book = { best: BN; last: { price: BN; at: { is_some: boolean; value: { x: BN; y: BN } }; small: number } };
    const b = decodeAccount<Book>(d, d.svm, "Book", book);
    expect(b.best.toNumber()).toBe(42);
    expect(b.last.price.toNumber()).toBe(42);
    expect(b.last.at.is_some).toBe(true);
    expect(b.last.at.value.y.toNumber()).toBe(2);
    expect(b.last.small).toBe(3);
  });

  it("leave no trace in the IDL, and compile the same each time (the sources are parsed again per build)", () => {
    const first = generate(FIXTURE);
    expect(generate(FIXTURE).c).toBe(first.c);
    const idl = buildIdl(first.model, "11111111111111111111111111111111");
    const types = Object.fromEntries(idl.types!.map((t) => [t.name, t]));
    expect(JSON.stringify(types.Order)).toContain('"type":"u64"');
    expect(JSON.stringify(types.Order)).toContain("FixedOption_s_Point");
    expect(Object.keys(types)).not.toContain("Price");
    expect(idl.instructions.find((i) => i.name === "place")!.args).toEqual([
      { name: "price", type: "u64" },
      { name: "lots", type: "u64" },
    ]);
  });

  const T = `import { type Mut, type Signer, type u64, type u8, log } from "typesol";\nexport interface Fill { price: u64 }\nexport interface Place { price: u64 }\n`;
  const body = `export function f(s: Signer): void {}`;

  it("refuses a union of named types, generic aliases and null among a data enum's variants, saying what is supported", () => {
    expect(compileErrors(`${T}export type Event = Fill | Place;\n${body}`)).toContain(
      "a union of named types is not a data enum: list the variants as object types",
    );
    expect(compileErrors(`${T}export type Event = Fill | { kind: "Place"; price: u64 };\n${body}`)).toContain("a union of named types is not a data enum");
    expect(compileErrors(`${T}export type Wrap<T> = T;\n${body}`)).toContain("type aliases cannot be generic: name one type, type Price = u64");
    expect(compileErrors(`${T}export type E = { kind: "A" } | null;\n${body}`)).toContain("null is not a variant: use Option<Enum>");
    expect(compileErrors(`${T}type E = { kind: "A" };\n${body}`)).toContain("data enums (type X = { kind: ... } | ...) must be exported");
    // A plain alias may stay in its file, and may be an Option of a struct.
    expect(compileErrors(`${T}type Price = u64;\ntype MaybeFill = Fill | null;\nexport function g(s: Signer, p: Price): void { log(p); }`)).toBe("");
  });

  it("keep the names of the file that declares them, and refuse an import that names something else where used", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-alias-"));
    try {
      writeFileSync(path.join(dir, "lib.ts"), `import { type u64 as Amount } from "typesol";\nexport type Price = Amount;\n`);
      const main = (imp: string) =>
        `import { type Signer, log${imp} } from "typesol";\nimport { type Price } from "./lib.js";\nexport function f(s: Signer, p: Price): void { log(p); }\n`;
      const errors = (imp: string) => {
        writeFileSync(path.join(dir, "main.ts"), main(imp));
        try {
          generate(path.join(dir, "main.ts"));
          return "";
        } catch (e) {
          if (e instanceof CompileError) return e.diagnostics.map((x) => x.message).join(" | ");
          throw e;
        }
      };
      expect(errors("")).toBe("");
      expect(errors(", type u8 as Amount")).toContain('type Price uses Amount (u64 from "typesol"), which names u8 in this file; rename one import');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("report a problem with an aliased type where the alias is used, not where it is declared", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-alias-"));
    try {
      writeFileSync(path.join(dir, "lib.ts"), `import { type BigVec, type u64 } from "typesol";\nexport type Buf = BigVec<u64>;\n`);
      writeFileSync(
        path.join(dir, "main.ts"),
        `import { type u64 } from "typesol";\nimport { type Buf } from "./lib.js";\n\nexport function g(y: u64, z: Buf): void {}\nexport function h(z: Buf): void {}\n`,
      );
      let diagnostics: { file: string; line: number; column: number; message: string }[] = [];
      try {
        generate(path.join(dir, "main.ts"));
      } catch (e) {
        if (!(e instanceof CompileError)) throw e;
        diagnostics = e.diagnostics;
      }
      const bigVec = "BigVec<T> is the last field of a native account's struct (read with loadRaw), not an argument; a list argument is a Vec<T>";
      // Each use gets its own report, at the use.
      expect(diagnostics.map((d) => [path.basename(d.file), d.line, d.column, d.message])).toEqual([
        ["main.ts", 4, 30, bigVec],
        ["main.ts", 5, 22, bigVec],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
