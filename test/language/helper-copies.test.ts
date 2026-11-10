// A read-only struct argument of a helper that also takes accounts is copied at the call only when it may be account
// data, which the helper's writes could change under it (JS passes the object as it was). A struct the caller owns (a
// local, a helper's result, an instruction argument, return data, or a struct parameter of a helper that itself takes
// accounts, which arrived as such a copy or owned struct) is passed in place.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate } from "../../src/compiler/index.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-struct-args-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
/** The C of `body`'s functions, after a shared header. */
function c(body: string): string {
  const file = path.join(dir, `p${n++}.ts`);
  writeFileSync(
    file,
    `import { type AccountInfo, type Mut, type RemainingAccounts, type u64, loadRaw, loadRawMut, remainingAccounts } from "typesol";
export const NATIVE_ACCOUNT_WRITES = true;
export interface Shape { a: u64; b: u64; c: u64; }
export interface Holder { shape: Shape; n: u64; }
function use(m: Shape, rest: RemainingAccounts): u64 {
  const h = loadRawMut<Holder>(rest.get(0n));
  h.n += 1n;
  return m.a + m.b;
}
function pass(m: Shape, rest: RemainingAccounts): u64 { return use(m, rest); }
function make(rest: RemainingAccounts): Shape { const h = loadRaw<Holder>(rest.get(0n)); return { a: h.n, b: 2n, c: 3n }; }
${body}`,
  );
  return generate(file).c;
}
const copies = (src: string, fn: string) => {
  const body = src.slice(src.indexOf(`${fn}(TsParams`), src.indexOf("\n}\n", src.indexOf(`${fn}(TsParams`)));
  return /\bargc\d+\b/.test(body); // snapshotPlace's copy
};

describe("struct arguments of helpers that take accounts", () => {
  it("are passed in place when the caller owns them", () => {
    const src = c(`export function local(acct: Mut<AccountInfo>, s: Shape): u64 {
  const rest = remainingAccounts();
  const m: Shape = { a: 1n, b: 2n, c: 3n };
  const r = make(rest);
  return use(m, rest) + use(r, rest) + use(s, rest);
}`);
    expect(copies(src, "ix_local")).toBe(false);
    // a struct parameter of a helper taking accounts arrived as a copy or an owned struct: passed on in place
    expect(copies(src, "fn_pass")).toBe(false);
  });

  it("are copied when they are account data", () => {
    const src = c(`export function view(acct: Mut<AccountInfo>): u64 {
  const rest = remainingAccounts();
  const h = loadRaw<Holder>(rest.get(0n));
  return use(h.shape, rest);
}`);
    expect(copies(src, "ix_view")).toBe(true);
  });
});
