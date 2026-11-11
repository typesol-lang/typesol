// A read-only struct argument of a helper that also takes accounts is copied at the call only when it may be account
// data, which the helper's writes could change under it (JS passes the object as it was). A struct the caller owns (a
// local, a helper's result, an instruction argument, return data, or a struct parameter of a helper that itself takes
// accounts, which arrived as such a copy or owned struct) is passed in place.
//
// Pubkey, Option, string and u256 arguments are C structs, which the SBF target passes as a pointer to the caller's
// object without copying it: they are passed as pointers, and copied at the call when the helper can write (it takes
// accounts or Inout places) and the argument is not a named C object out of its reach. Run with and without
// `@noinline`: an inlined helper hid the missing copy.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { web3 } from "@anchor-lang/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../src/compiler/index.js";
import { customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, SYSTEM_PROGRAM, type Deployed } from "../harness.js";

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

// The helpers write the place their argument was read from, then use the argument: JS gives them the old value.
const BYVAL = (noinline: boolean) => {
  const tag = noinline ? "/** @noinline */\n" : "";
  return `import { type u64, type u256, type Pubkey, type Mut, type Signer, type Init, type SystemProgram, type Option, type Inout, require, u256 as U256, u64 as U64 } from "typesol";
export interface Vault { admin: Pubkey; pending: Pubkey; fee: Option<u64>; n: u64 }
export interface Pair { key: Pubkey; fee: Option<u64> }
${tag}function rotate(v: Mut<Vault>, prev: Pubkey, caller: Signer): void {
  v.admin = v.pending;
  require(prev === caller.key, "only the current admin may rotate");
}
${tag}function setFee(v: Mut<Vault>, old: Option<u64>, next: u64): u64 { v.fee = next; return old ?? 0n; }
${tag}function grow(v: Mut<Vault>, old: u256): u64 { v.n = U64(old) + 1000n; return U64(old); }
${tag}function swapIn(p: Inout<Pair>, f: Option<u64>): u64 { p.fee = 9n; return f ?? 0n; }
${tag}function rekey(p: Inout<Pair>, k: Pubkey, other: Pubkey): boolean { p.key = other; return k === other; }
${tag}function peek(old: Option<u64>): u64 { return old ?? 0n; }
export function setup(payer: Mut<Signer>, v: Init<Vault>, sys: SystemProgram, pending: Pubkey): void {
  v.create(payer, ["v"]);
  v.admin = payer.key;
  v.pending = pending;
  v.fee = 30n;
}
export function accept(v: Mut<Vault>, caller: Signer): void { rotate(v, v.admin, caller); }
export function fee(v: Mut<Vault>): u64 { return setFee(v, v.fee, 500n); }
export function bigger(v: Mut<Vault>): u64 { const b = U256(5n); return grow(v, b); }
export function local(v: Mut<Vault>, other: Pubkey): u64 {
  const p: Pair = { key: v.admin, fee: 7n };
  const r = swapIn(p, p.fee);
  return rekey(p, p.key, other) ? r + 1000n : r;
}
export function plain(v: Mut<Vault>): u64 { return peek(v.fee) + setFee(v, 40n, 41n); }
`;
};

for (const noinline of [false, true])
  describe(`Pubkey, Option and u256 arguments of a helper that writes where they came from${noinline ? " (@noinline)" : ""}`, () => {
    let d: Deployed;
    let src: string;
    let admin: Awaited<ReturnType<typeof fundedSigner>>;
    let pending: Awaited<ReturnType<typeof fundedSigner>>;
    let v: Awaited<ReturnType<typeof pda>>[0];
    beforeAll(async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-byval-"));
      writeFileSync(path.join(dir, "byval.ts"), BYVAL(noinline));
      src = generate(path.join(dir, "byval.ts")).c;
      d = await deployFile(path.join(dir, "byval.ts"));
      admin = await fundedSigner(d.svm);
      pending = await fundedSigner(d.svm);
      [v] = await pda(d.programId, ["v"]);
      expectOk(
        await send(d.svm, admin, [
          ix(d, "setup", { pending: new web3.PublicKey(pending.address) }, [
            { address: admin.address, signer: admin, writable: true },
            { address: v, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      );
    });
    const ret = (res: Awaited<ReturnType<typeof send>>) => Buffer.from(expectOk(res).returnData().data()).readBigUInt64LE(0);

    it("a Pubkey read before the helper changes its field: the pending key cannot pass as the admin", async () => {
      const res = await send(d.svm, pending, [
        ix(d, "accept", {}, [
          { address: v, writable: true },
          { address: pending.address, signer: pending },
        ]),
      ]);
      expect(customError(res)).toBe(6000);
    });

    it("an Option keeps its value from the call", async () => {
      expect(ret(await send(d.svm, admin, [ix(d, "fee", {}, [{ address: v, writable: true }])]))).toBe(30n);
      // A u256 cannot be stored: it is always a local or a temporary, passed in place.
      expect(ret(await send(d.svm, admin, [ix(d, "bigger", {}, [{ address: v, writable: true }])]))).toBe(5n);
    });

    it("values read from a local struct given to the helper as Inout keep theirs", async () => {
      const other = (await fundedSigner(d.svm)).address;
      // swapIn returns the old fee (7); rekey compares the old key with `other` (false): 7, not 9 or 1009.
      expect(ret(await send(d.svm, admin, [ix(d, "local", { other: new web3.PublicKey(other) }, [{ address: v, writable: true }])]))).toBe(7n);
    });

    it("the legitimate forms still work: the right admin rotates, a helper that writes nothing reads in place", async () => {
      const before = String(decodeAccount<{ admin: unknown }>(d, d.svm, "Vault", v).admin);
      expectOk(
        await send(d.svm, admin, [
          ix(d, "accept", {}, [
            { address: v, writable: true },
            { address: admin.address, signer: admin },
          ]),
        ]),
      );
      expect(String(decodeAccount<{ admin: unknown }>(d, d.svm, "Vault", v).admin)).not.toBe(before);
      expect(ret(await send(d.svm, admin, [ix(d, "plain", {}, [{ address: v, writable: true }])]))).toBe(500n + 40n);
      // Copies only where the helper may write the argument's storage: the fields given to rotate / setFee and the
      // fields of the local given as Inout, not the field given to peek (it writes nothing) nor a local u256.
      const body = (fn: string) => src.slice(src.indexOf(`static uint64_t ${fn}(TsParams *params`) + 1).split("\n}\n")[0]!;
      expect(body("ix_accept")).toMatch(/SolPubkey argk\d+ = \*\(\(&d_v->admin\)\);/);
      expect(body("ix_fee")).toMatch(/TS_Opt_u64 argv\d+ = d_v->fee;/);
      expect(body("ix_bigger")).toMatch(/fn_grow\(params, a_v, \(&l_b_\d+\)/);
      expect(body("ix_plain")).toMatch(/fn_peek\(params, \(&d_v->fee\)/);
      expect(body("ix_local")).toMatch(/TS_Opt_u64 argv\d+ = \(\*l_p_\d+\)\.fee;/);
      expect(body("ix_local")).toMatch(/SolPubkey argk\d+ = \*\(\(&\(\*l_p_\d+\)\.key\)\);/);
      expect(src).toMatch(/fn_rotate\(TsParams \*params, TsAccount \*a_v, const SolPubkey \*restrict p_prev, TsAccount \*a_caller\)/);
    });
  });
