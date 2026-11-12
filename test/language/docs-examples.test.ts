// The language guide's examples compile (docs/language*.md), so the documentation cannot drift from the compiler.
// In those pages a fenced block's info string says what it is:
//   ```ts               a complete program: compiled here, and it must compile without errors
//   ```ts file=<name>   a file a later complete program of the same page imports ("./<name without .ts>")
//   ```ts fragment      part of a program: each one is listed in FRAGMENTS with the compiled file it is taken from,
//                       and every line of it (but comments and lines with "…") must be a line of that file
// Other info strings (sh, json, text, …) are not TypeScript and are not read.
// The "What is refused" table of docs/language-statements.md is checked as well: every row's example is refused with
// the message the row quotes (matched on a stable part of it).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { headings, headingsOf } from "../../scripts/language-builtins.ts";
import { CompileError, generate } from "../../src/compiler/index.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOCS = path.join(ROOT, "docs");
const PAGES = readdirSync(DOCS)
  .filter((f) => /^language(-[a-z-]+)?\.md$/.test(f))
  .sort();

interface Block {
  page: string;
  line: number;
  kind: "program" | "file" | "fragment";
  file?: string;
  code: string;
}

/** The ts blocks of a page, indented ones (inside list items) included. */
function blocks(page: string): Block[] {
  const text = readFileSync(path.join(DOCS, page), "utf8");
  const out: Block[] = [];
  const re = /^( *)```ts([^\n]*)\n([\s\S]*?)^\1```$/gm;
  for (const m of text.matchAll(re)) {
    const indent = m[1]!.length;
    const info = m[2]!.trim();
    const code = m[3]!
      .split("\n")
      .map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length)))
      .join("\n");
    const line = text.slice(0, m.index).split("\n").length;
    const file = /^file=(\S+)$/.exec(info)?.[1];
    if (info === "") out.push({ page, line, kind: "program", code });
    else if (file) out.push({ page, line, kind: "file", file, code });
    else if (info === "fragment") out.push({ page, line, kind: "fragment", code });
    else throw new Error(`${page}:${line}: unknown info string "ts ${info}"`);
  }
  return out;
}

function compileErrors(file: string): string[] {
  try {
    generate(file);
  } catch (e) {
    if (e instanceof CompileError) return e.diagnostics.map((d) => `${path.basename(d.file)}:${d.line}:${d.column} ${d.message}`);
    throw e;
  }
  return [];
}

/**
 * Every fragment in the guide, by its first line, with the compiled file (fixture, showcase port or test) it is taken
 * from. A fragment's lines must all be lines of that file.
 */
const FRAGMENTS: Record<string, string> = {};

const tmp = mkdtempSync(path.join(os.tmpdir(), "typesol-docs-"));

describe("the language guide's examples compile", () => {
  it("has pages, each with examples", () => {
    expect(PAGES).toContain("language.md");
    expect(PAGES.length).toBeGreaterThan(5);
    // Every page of the guide but its entry page and the generated built-ins list has a program compiled here.
    for (const page of PAGES.filter((p) => p !== "language.md" && p !== "language-builtins.md"))
      expect(
        blocks(page).some((b) => b.kind === "program"),
        `${page} has no complete program`,
      ).toBe(true);
  });

  it("reads every TypeScript block: none is fenced with ~~~ or labelled typescript, which would be skipped", () => {
    const skipped: string[] = [];
    for (const page of PAGES) {
      const text = readFileSync(path.join(DOCS, page), "utf8");
      for (const m of text.matchAll(/^ *(~~~.*|```(?:typescript|tsx|js|javascript)\b.*)$/gm))
        skipped.push(`${page}:${text.slice(0, m.index).split("\n").length}: ${m[1]}`);
    }
    expect(skipped).toEqual([]);
  });

  for (const page of PAGES) {
    const all = blocks(page);
    const files = all.filter((b) => b.kind === "file");
    for (const b of all.filter((x) => x.kind === "program")) {
      it(`${page}:${b.line}`, () => {
        const dir = path.join(tmp, page.replace(/\.md$/, ""), String(b.line));
        mkdirSync(dir, { recursive: true });
        for (const f of files) writeFileSync(path.join(dir, f.file!), f.code);
        const file = path.join(dir, "program.ts");
        writeFileSync(file, b.code);
        expect(compileErrors(file)).toEqual([]);
      });
    }
    for (const b of all.filter((x) => x.kind === "fragment")) {
      it(`${page}:${b.line} (fragment)`, () => {
        const first = b.code
          .split("\n")
          .find((l) => l.trim() !== "")!
          .trim();
        const source = FRAGMENTS[first];
        expect(source, `list the fragment starting "${first}" in FRAGMENTS`).toBeDefined();
        const lines = new Set(
          readFileSync(path.join(ROOT, source!), "utf8")
            .split("\n")
            .map((l) => l.trim()),
        );
        const missing = b.code
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "" && !l.startsWith("//") && !l.includes("…"))
          .map((l) => l.replace(/\s+\/\/.*$/, ""))
          .filter((l) => ![...lines].some((s) => s === l || s.startsWith(l)));
        expect(missing, `${source}`).toEqual([]);
      });
    }
  }
});

// The "What is refused" table: each row's example (the code in its Example cell) compiled in a program around it,
// and the stable part of the message expected from the compiler and quoted in the row.
const H = `import { type Mut, type Signer, type Pubkey, type u64, type u8, type Vec, type FixedArray, log, require, fixedVec } from "typesol";
export interface Point { x: u64; y: u64; }
export interface Box { owner: Pubkey; value: u64; xs: FixedArray<u64, 4>; home: Point; }
`;
const body = (code: string) => `${H}export function f(b: Mut<Box>, s: Signer, n: u64, t: string, x: u8): void {\n${code}\n}\n`;
const top = (code: string) => `${H}${code}\nexport function f(b: Mut<Box>): void { b.value = 1n; }\n`;
const REFUSED: [example: string, program: string, stable: string][] = [
  ["class Counter { n = 0n; }", top("class Counter { n = 0n; }"), "classes are not supported"],
  ["export async function f(): Promise<void> {}", `${H}export async function f(): Promise<void> {}`, "instructions cannot be async or generators"],
  ["async function h(): Promise<void> {}", top("async function h(): Promise<void> {}"), "helper functions cannot be async"],
  ["function* ids(): Generator<u64> { yield 1n; }", top("function* ids(): Generator<u64> { yield 1n; }"), "helper functions cannot be generators"],
  ["const y = await n;", body("const y = await n;"), "'await' expressions are only allowed"],
  ['throw new Error("bad");', body('throw new Error("bad");'), "throw is not supported"],
  ["try { b.value = 1n; } catch { b.value = 2n; }", body("try { b.value = 1n; } catch { b.value = 2n; }"), "try/catch is not supported"],
  ["b.value = 1;", body("b.value = 1;"), "Type 'number' is not assignable to type 'bigint'"],
  ["b.value = 1.5;", body("b.value = 1.5;"), "Type 'number' is not assignable to type 'bigint'"],
  ["for (let i = 0; i < 3; i++) {}", body("for (let i = 0; i < 3; i++) {}"), "use a bigint literal (0n)"],
  [
    "export function f(x: number): void {}",
    `${H}export function f(x: number): void {}`,
    "parameter type must be an integer, boolean, Pubkey, string, or an account type",
  ],
  ["const y: any = n;", body("const y: any = n;"), "local type must be an integer, boolean, Pubkey, enum, option or string"],
  ["var y = n;", body("var y = n;"), "use const or let, not var"],
  ["let x: u64;", body("let z: u64;"), "declare one plain name with an initializer"],
  ["let total = 0n;", top("let total = 0n;"), "top-level variables must be const literals"],
  ['log("start");', top('log("start");'), "is not supported at the top level of a TypeSOL file"],
  ["n = 3n;", body("n = 3n;"), "cannot be reassigned"],
  ["p.x = 3n;", `${H}export function f(p: Point): void { p.x = 3n; }`, "instruction arguments are read-only"],
  ["for (const k in b) {}", body("for (const k in b) {}"), "for … in is not supported"],
  ["outer: for (…) { break outer; }", body("outer: for (let i = 0n; i < n; i++) { break outer; }"), "LabeledStatement is not supported"],
  ['if (n) log("x");', body('if (n) log("x");'), "expected boolean, got u64"],
  ["b.value = b.xs[0];", body("b.value = b.xs[0];"), "indexing with [ ] is not supported"],
  ["const a = [1n, 2n];", body("const a = [1n, 2n];"), "arrays are only allowed inline"],
  ["const o = { a: 1n };", body("const o = { a: 1n };"), "an object literal needs a struct type here"],
  ["const m = new Map<u64, u64>();", body("const m = new Map<u64, u64>();"), "(NewExpression) is not supported"],
  ["const t = typeof n;", body("const tt = typeof n;"), "typeof is not supported at run time"],
  ["const k = delete b.value;", body("const k = delete b.value;"), "The operand of a 'delete' operator must be optional"],
  // An operand TypeScript accepts reaches TypeSOL's own refusal, which the row quotes too.
  ["const k = delete b.value;", body("const k = delete (b as never as { value?: u64 }).value;"), "delete is not supported"],
  ["const v = void n;", body("const v = void n;"), "(VoidExpression) is not supported"],
  ["if (b instanceof Object) {}", body("if (b instanceof Object) {}"), "operator instanceof is not supported"],
  ['if ("value" in b) {}', body('if ("value" in b) {}'), "operator in is not supported"],
  ["y = (b.value = 1n, 2n);", body("let y = 0n; y = (b.value = 1n, 2n); b.value = y;"), "operator , is not supported"],
  ["const r = /a/;", body("const r = /a/;"), "(RegularExpressionLiteral) is not supported"],
  ["const t = String.raw`x`;", body("const t2 = String.raw`x`;"), "(TaggedTemplateExpression) is not supported"],
  ["if (b.value === undefined) {}", body("if (b.value === undefined) {}"), 'unknown name "undefined"'],
  ["export function f(x?: u64): void {}", `${H}export function f(x?: u64): void {}`, "optional parameters are not supported"],
  ["export function f(x: u64 = 1n): void {}", `${H}export function f(x: u64 = 1n): void {}`, "default values are not supported"],
  ["export function f(...x: u64[]): void {}", `${H}export function f(...x: u64[]): void {}`, "...rest parameters are not supported"],
  ["export interface O { v?: u64 }", top("export interface O { v?: u64 }"), "optional fields are not supported"],
  ["export interface G { v(): u64 }", top("export interface G { v(): u64 }"), "structs may only contain plain fields"],
  ["export enum E { A = 1, B = 2 }", top("export enum E { A = 1, B = 2 }"), "value enum members are numbered 0, 1, 2"],
  ["function inner(x: u64): u64 { return x; }", body("function inner(x: u64): u64 { return x; }\nb.value = inner(n);"), "FunctionDeclaration is not supported"],
  [
    "function a(x: u64): u64 { return x === 0n ? 0n : a(x - 1n); }",
    `${H}function a(x: u64): u64 { return x === 0n ? 0n : a(x - 1n); }\nexport function f(b: Mut<Box>): void { b.value = a(3n); }`,
    "recursion is not supported: a -> a",
  ],
  [
    "function h(x: u64) { return x; }",
    `${H}function h(x: u64) { return x; }\nexport function f(b: Mut<Box>): void { b.value = h(1n); }`,
    "helper functions need an explicit return type",
  ],
  ["namespace N { export const x = 1n; }", top("namespace N { export const x = 1n; }"), "namespaces are not supported"],
  ['import { x } from "lodash";', `import { x } from "lodash";\nexport function f(): void {}`, 'only imports from "typesol" and relative TypeSOL files'],
  ['import * as ts from "typesol";', `import * as ts from "typesol";\nexport function f(): void {}`, "use named imports"],
  ['console.log("x");', body('console.log("x");'), "'console' does not exist in a Solana program"],
  ["const m = Math.max(1, 2);", body("const m = Math.max(1, 2);"), "unsupported call: Math.max"],
  ["b.value = BigInt(5);", body("b.value = BigInt(5);"), "unsupported call: BigInt"],
  ["const d = Date.now();", body("const d = Date.now();"), "unsupported call: Date.now"],
  ["log(JSON.stringify(n));", body("log(JSON.stringify(n));"), "unsupported call: JSON.stringify"],
  ["const l = t.length;", body("const l = t.length;"), "use byteLength(s) for strings"],
  ["const c = t.slice(0, 1);", body("const c = t.slice(0, 1);"), "unsupported call: t.slice"],
  ["b.value = x as u64;", body("b.value = x as u64;"), "does not convert"],
  ["b.value = b.value + x;", body("b.value = b.value + x;"), "operands have different types: u64 and u8"],
  ["b.value = -n;", body("b.value = -n;"), "unary minus needs a signed integer"],
  [
    "b.value = r.x + r.x;",
    `${H}export interface R { x: f64; y: f64; }\nexport function f(b: Mut<Box>, r: Mut<R>): void { b.value = r.x + r.x; }`.replace(
      "type u64,",
      "type u64, type f64,",
    ),
    "+ on an f64 is not supported: an f64 is held as its IEEE 754 bits and there is no float arithmetic",
  ],
  [
    "b.value = r.x;",
    `${H}export interface R { x: f64; }\nexport function f(b: Mut<Box>, r: Mut<R>): void { b.value = r.x; }`.replace("type u64,", "type u64, type f64,"),
    "an f64 is not an integer, so it is not converted to u64",
  ],
  [
    "log(`${r.x}`);",
    `${H}export interface R { x: f64; }\nexport function f(r: Mut<R>): void { log(\`\${r.x}\`); }`.replace("type u64,", "type u64, type f64,"),
    "an f64 cannot be written as text",
  ],
  [
    "if (r.x === r.y) {}",
    `${H}export interface R { x: f64; y: f64; }\nexport function f(r: Mut<R>): void { if (r.x === r.y) {} }`.replace("type u64,", "type u64, type f64,"),
    "to compare the bits, write f64Bits(a) === f64Bits(b)",
  ],
  ["const v = b?.value;", body("const v = b?.value;"), "?. works on optional accounts and Option<struct> values"],
  ["let q = b.home;", body("let q = b.home;"), "bind struct references with const"],
  ["const { home: { x } } = b;", body("const { home: { x: hx } } = b;"), "nested destructuring is not supported"],
  ["const { value, ...rest } = b;", body("const { value, ...rest } = b;"), "...rest is not supported in destructuring"],
  ["const { value = 3n } = b;", body("const { value = 3n } = b;"), "default values are not supported in destructuring"],
  ["const [p, q] = [1n, 2n];", body("const [p, q] = [1n, 2n];"), "array destructuring is only for"],
  ['switch (t) { case "a": break; }', body('switch (t) { case "a": break; }'), "switch works on integers and enums"],
  ["case b.value:", body("switch (n) { case b.value: break; }"), "case labels must be literals, constants or enum members"],
  [
    "function h(p: Point): void { p.x = 1n; }",
    `${H}function h(p: Point): void { p.x = 1n; }\nexport function f(b: Mut<Box>): void { h(b.home); }`,
    "helper parameters are read-only",
  ],
  ["const v: Vec<u64> = fixedVec([]);", body("const v: Vec<u64> = fixedVec([]);"), "local type must be an integer, boolean, Pubkey, enum, option or string"],
  [
    "merkleVerify(leaf, proof, root);",
    `import { type Hash, type Vec, merkleVerify } from "typesol";\nexport function f(leaf: Hash, proof: Vec<Hash>, root: Hash): void {\n  merkleVerify(leaf, proof, root);\n}\n`,
    "the result of merkleVerify is discarded, so nothing is checked",
  ],
  [
    "if (merkleVerify(leaf, proof, root)) {}",
    `import { type Hash, type Vec, merkleVerify } from "typesol";\nexport function f(leaf: Hash, proof: Vec<Hash>, root: Hash): void {\n  if (merkleVerify(leaf, proof, root)) {}\n}\n`,
    "the result of merkleVerify is not acted on: the if around it has an empty body",
  ],
  [
    "const ok = merkleVerify(leaf, proof, root);",
    `import { type Hash, type Vec, merkleVerify } from "typesol";\nexport function f(leaf: Hash, proof: Vec<Hash>, root: Hash): void {\n  const ok = merkleVerify(leaf, proof, root);\n}\n`,
    "the result of merkleVerify is never read (ok is not used), so nothing is checked",
  ],
  [
    'export enum E { A = "a", /* @code 6100 */ B = "b" }',
    'export enum E { A = "a", /* @code 6100 */ B = "b" }\nexport function f(): void {}\n',
    "this @code tag is not read: only a doc comment (/** … */) is, not a /* … */ comment",
  ],
  [
    'export enum E { A = "a", /** @code 6100 */ B = "b" }',
    'export enum E { A = "a", /** @code 6100 */ B = "b" }\nexport function f(): void {}\n',
    "this @code tag is not read: other code comes before it on its line",
  ],
];

describe("what docs/language-statements.md says is refused, is", () => {
  const text = readFileSync(path.join(DOCS, "language-statements.md"), "utf8");
  const table = text.slice(text.indexOf("## What is refused"));
  const rows = [...table.matchAll(/^\| (?!Construct|---)(.*)$/gm)].map((m) => {
    const cells = m[1]!.split(/ \| /);
    const code = /^(`+)(.+?)\1/.exec(cells[1]!.trim());
    return { example: code ? code[2]!.trim() : cells[1]!, row: m[0] };
  });

  it("lists exactly the cases tested here", () => {
    expect(rows.map((r) => r.example).sort()).toEqual([...new Set(REFUSED.map(([e]) => e))].sort());
  });

  for (const [i, [example, program, stable]] of REFUSED.entries()) {
    it(`${example} (${i})`, () => {
      const dir = path.join(tmp, "refused");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `case${i}.ts`);
      writeFileSync(file, program);
      expect(compileErrors(file).join("\n")).toContain(stable);
      expect(rows.find((r) => r.example === example)?.row).toContain(stable);
    });
  }
});

describe("links into the docs land on a heading", () => {
  it("anchors as GitHub makes them: a repeated heading's are #name-1, #name-2", () => {
    const h = headingsOf("# Page\n\n## Notes\n\n```sh\n## not a heading\n```\n\n### Notes\n\n## Notes\n\n## Other\n");
    expect([...h.keys()]).toEqual(["", "notes", "notes-1", "notes-2", "other"]);
  });

  // Heading anchors as GitHub and the docs site make them (scripts/language-builtins.ts: slug). Every docs page, the
  // README and the declaration file's comments are read.
  const sources = [
    ...readdirSync(DOCS)
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/${f}`),
    "README.md",
    "lib/typesol.d.ts",
  ];
  for (const source of sources) {
    it(source, () => {
      const text = readFileSync(path.join(ROOT, source), "utf8").replace(/^ *```[\s\S]*?^ *```/gm, "");
      const bad: string[] = [];
      for (const [, target] of text.matchAll(/\]\(([^)\s]*#[^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        const [file, anchor] = target!.split("#") as [string, string];
        const page = file === "" ? path.basename(source) : path.posix.basename(file);
        const inDocs = file === "" ? source.startsWith("docs/") : path.posix.normalize(path.posix.join(path.posix.dirname(source), file)).startsWith("docs/");
        if (!inDocs) continue;
        if (!headings(page).has(anchor)) bad.push(target!);
      }
      expect(bad).toEqual([]);
    });
  }
});
