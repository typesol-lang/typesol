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
/**
 * Whether `fn`'s body copies a struct argument (snapshotPlace's `argcN`). The body is the definition's, not the
 * prototype's: prototypes are emitted before any body, so the first `fn(TsParams` is the declaration ending in `;`.
 */
const copies = (src: string, fn: string) => {
  const def = new RegExp(`^[^\\n;]*\\b${fn}\\(TsParams[^\\n;]*\\) \\{$`, "m").exec(src);
  expect(def, `the definition of ${fn}`).not.toBeNull();
  const start = def!.index;
  const end = src.indexOf("\n}\n", start);
  expect(end, `the end of ${fn}`).toBeGreaterThan(start);
  const body = src.slice(start, end);
  // The body calls a helper, so a copy would be visible; a body that calls nothing would make the check vacuous.
  expect(body, `${fn}'s body`).toMatch(/\bfn_\w+\(params,/);
  return /\bargc\d+\b/.test(body);
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
