// Dup<…> (Anchor's `dup`): a writable account that may be the same account as another writable parameter, for
// accounts read and written in place only.
import { getU64Encoder } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, compileErrors, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send } from "../harness.js";

const HEAD = `import { type CloseTo, type Dup, type FixedString, type Init, type Mut, type Signer, type SystemProgram, type u64 } from "typesol";
export interface Wallet { id: u64; balance: u64; }
/** @layout borsh */
export interface Note { id: u64; text: FixedString<16>; }
`;

describe("Dup<…>", () => {
  it.each([
    ["a @layout borsh account", "export function f(a: Dup<Mut<Note>>, b: Mut<Note>): void {}"],
    ["an account it closes", 'export function f(a: Dup<CloseTo<Mut<Wallet>, "b">>, b: Mut<Signer>): void {}'],
    ["an account created here", "export function f(p: Mut<Signer>, a: Dup<Init<Wallet>>, s: SystemProgram): void { a.create(p, null); }"],
    ["an account closed with close()", "import { close } from 'typesol';\nexport function f(a: Dup<Mut<Wallet>>, b: Mut<Wallet>): void { close(a, b); }"],
  ])("is refused on %s", (_, fn) => {
    expect(compileErrors(HEAD + fn)).toMatch(/Dup<…> is for accounts read and written in place/);
  });

  it("is refused on a read-only account", () => {
    expect(compileErrors(HEAD + "import type { Account } from 'typesol';\nexport function f(a: Dup<Account<Wallet>>, b: Mut<Wallet>): void {}")).toMatch(
      /this one is not writable/,
    );
  });

  it("lets two slots name one account; reads through either see writes through the other", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-dup-"));
    writeFileSync(
      path.join(dir, "dup.ts"),
      `${HEAD}export function open(payer: Mut<Signer>, w: Init<Wallet>, systemProgram: SystemProgram, id: u64): void {
  w.create(payer, ["w", id]);
  w.id = id;
  w.balance = 100n;
}
/** Moves amount from one wallet to the other, in place: from one wallet to itself it changes nothing. */
export function move(from: Dup<Mut<Wallet>>, to: Mut<Wallet>, amount: u64): void {
  from.balance -= amount;
  to.balance += amount;
}
export function strict(from: Mut<Wallet>, to: Mut<Wallet>, amount: u64): void {
  from.balance -= amount;
  to.balance += amount;
}
/** Closes the wallet into \`to\`, which may be the transaction's payer too (a keeper settling its own record). */
export function sweep(to: Mut<Signer>, w: CloseTo<Mut<Wallet>, "to">, payer: Dup<Mut<Signer>>): void {}
`,
    );
    const d = await deployFile(path.join(dir, "dup.ts"));
    const payer = await fundedSigner(d.svm);
    const le64 = (n: bigint) => new Uint8Array(getU64Encoder().encode(n));
    const wallet = async (id: bigint) => {
      const [w] = await pda(d.programId, ["w", le64(id)]);
      expectOk(
        await send(d.svm, payer, [
          ix(d, "open", { id: new BN(id.toString()) }, [
            { address: payer.address, signer: payer, writable: true },
            { address: w, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      );
      return w;
    };
    const a = await wallet(1n);
    const b = await wallet(2n);
    const balance = (w: typeof a) => decodeAccount<{ balance: BN }>(d, d.svm, "Wallet", w).balance.toString();
    const call = (name: string, from: typeof a, to: typeof a) =>
      send(d.svm, payer, [
        ix(d, name, { amount: new BN(30) }, [
          { address: from, writable: true },
          { address: to, writable: true },
        ]),
      ]);
    expectOk(await call("move", a, b));
    expect([balance(a), balance(b)]).toEqual(["70", "130"]);
    expectOk(await call("move", a, a)); // allowed: in place, so -30 then +30
    expect(balance(a)).toBe("70");
    expect(customError(await call("strict", a, a))).toBe(2040); // without Dup, still refused
    // A close destination may be a Dup account's twin: the rent reaches the one account.
    const before = d.svm.getBalance(payer.address)!;
    const rent = d.svm.getBalance(b)!;
    const sweep = (to: { address: typeof a; signer: typeof payer }, w: typeof a) =>
      send(d.svm, payer, [
        ix(d, "sweep", {}, [
          { address: to.address, signer: to.signer, writable: true },
          { address: w, writable: true },
          { address: payer.address, signer: payer, writable: true },
        ]),
      ]);
    expectOk(await sweep({ address: payer.address, signer: payer }, b));
    expect(d.svm.getBalance(payer.address)! - before).toBe(rent - 5000n);
  });

  it("a helper closing an account into the same account (two Dup slots) fails at run time with 2040", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-dup-close-"));
    writeFileSync(
      path.join(dir, "close.ts"),
      HEAD +
        `import { close } from "typesol";
function shut(a: Mut<Wallet>, b: Mut<Wallet>): void { close(a, b); }
export function make(p: Mut<Signer>, w: Init<Wallet>, s: SystemProgram, id: u64): void { w.create(p, ["w", id]); w.id = id; }
export function both(a: Dup<Mut<Wallet>>, b: Dup<Mut<Wallet>>): void { shut(a, b); }
`,
    );
    const d = await deployFile(path.join(dir, "close.ts"));
    const p = await fundedSigner(d.svm);
    const mk = async (id: number) => {
      const [w] = await pda(d.programId, ["w", new Uint8Array(getU64Encoder().encode(BigInt(id)))]);
      expectOk(
        await send(d.svm, p, [
          ix(d, "make", { id: new BN(id) }, [{ address: p.address, signer: p, writable: true }, { address: w, writable: true }, { address: SYSTEM_PROGRAM }]),
        ]),
      );
      return w;
    };
    const w1 = await mk(1);
    expect(
      customError(
        await send(d.svm, p, [
          ix(d, "both", {}, [
            { address: w1, writable: true },
            { address: w1, writable: true },
          ]),
        ]),
      ),
    ).toBe(2040);
    const w2 = await mk(2);
    expectOk(
      await send(d.svm, p, [
        ix(d, "both", {}, [
          { address: w1, writable: true },
          { address: w2, writable: true },
        ]),
      ]),
    );
    expect(d.svm.getAccount(w1).exists).toBe(false);
  });
});

// A reference into account data must not be used after something moves that data (a Vec of the account resized, so
// the Vecs after it shift; a helper given the account): the same rule whichever parameter names the account. Two
// parameters that may be one account (a Dup<…> pair, a read-only and a writable account of one type, a struct loaded
// from a remaining account or an AccountInfo) count as one.
describe("references across a resize through another slot that may be the same account", () => {
  const BAG = `import { type Account, type AccountInfo, type Dup, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type Vec, type u64, loadAccount, remainingAccounts } from "typesol";
export interface Entry { id: u64; score: u64 }
export interface Bag { owner: Pubkey; tags: Vec<u64>; count: u64; entries: Vec<Entry> }
export interface Other { owner: Pubkey; tags: Vec<u64>; count: u64; entries: Vec<Entry> }
function shrink(b: Mut<Bag>): void { b.tags.pop(); }
`;
  const fn = (params: string, body: string) =>
    `${BAG}export function f(payer: Mut<Signer>, ${params}, systemProgram: SystemProgram, v: u64): u64 {\n${body}\n}\n`;
  const DUP = "a: Dup<Mut<Bag>>, b: Mut<Bag>";
  const RO = "a: Account<Bag>, b: Mut<Bag>";
  it.each([
    ["Dup, a push before a write", DUP, "const e = a.entries.get(0n); b.tags.push(v, payer); e.score = 777n; return 0n;"],
    ["Dup, pops", DUP, "const e = a.entries.get(1n); b.tags.pop(); b.tags.pop(); e.score = v; return a.entries.get(1n).score;"],
    ["Dup, clear", DUP, "const e = a.entries.get(1n); b.entries.clear(); b.tags.clear(); e.score = v; return a.count;"],
    ["read-only and writable, pop", RO, "const e = a.entries.get(1n); b.tags.pop(); return e.score;"],
    ["read-only and writable, push", RO, "const e = a.entries.get(1n); b.tags.push(v, payer); return e.id;"],
    ["read-only and writable, a loop", RO, "let s = 0n; for (const x of a.entries) { if (b.tags.length > 0n) b.tags.pop(); s += x.score; } return s;"],
    ["read-only and writable, a helper given the account", RO, "const e = a.entries.get(1n); shrink(b); return e.score;"],
    [
      "a remaining account loaded",
      "b: Mut<Bag>",
      "const x = loadAccount<Bag>(remainingAccounts().get(0n)); const e = x.entries.get(1n); b.tags.pop(); return e.score;",
    ],
    ["an AccountInfo loaded", "b: Mut<Bag>, i: AccountInfo", "const x = loadAccount<Bag>(i); const e = x.entries.get(1n); b.tags.pop(); return e.score;"],
  ])("%s: refused", (_, params, body) => {
    expect(compileErrors(fn(params, body))).toMatch(/may be the same account as b .*this moves that data|may be the same account as b .*may move that data/);
  });

  it.each([
    ["fields copied first", RO, "const s = a.entries.get(1n).score; b.tags.pop(); return s;"],
    ["a reference read only before the resize", RO, "const e = a.entries.get(1n); const s = e.score; b.tags.pop(); return s;"],
    ["a loop that reads before it resizes", DUP, "let s = 0n; for (const x of a.entries) { s += x.score; if (b.tags.length > 0n) b.tags.pop(); } return s;"],
    ["accounts of different types", "a: Account<Other>, b: Mut<Bag>", "const e = a.entries.get(1n); b.tags.pop(); return e.score;"],
    ["two writable accounts (2040 keeps them apart)", "a: Mut<Bag>, b: Mut<Bag>", "const e = a.entries.get(1n); b.tags.pop(); return e.score;"],
  ])("%s: compiles", (_, params, body) => {
    expect(compileErrors(fn(params, body))).toBe("");
  });

  it("a program that copies first reads the moved data right with one account in both slots", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-dup-vec-"));
    writeFileSync(
      path.join(dir, "bag.ts"),
      `${BAG}export function open(payer: Mut<Signer>, bag: Init<Bag>, systemProgram: SystemProgram, id: u64): void { bag.create(payer, ["bag", id]); }
export function add(payer: Mut<Signer>, bag: Mut<Bag>, systemProgram: SystemProgram, tag: u64): void { bag.tags.push(tag, payer); bag.entries.push({ id: tag, score: tag * 2n }, payer); }
export function f(payer: Mut<Signer>, ${RO}, systemProgram: SystemProgram): u64 {
  const s = a.entries.get(1n).score;
  b.tags.pop();
  return s * 1000n + a.entries.get(1n).score;
}
`,
    );
    const d = await deployFile(path.join(dir, "bag.ts"));
    const payer = await fundedSigner(d.svm);
    const [bag] = await pda(d.programId, ["bag", new Uint8Array(getU64Encoder().encode(1n))]);
    const base = [{ address: payer.address, signer: payer, writable: true }, { address: bag, writable: true }, { address: SYSTEM_PROGRAM }];
    expectOk(await send(d.svm, payer, [ix(d, "open", { id: new BN(1) }, base)]));
    for (const t of [10, 20, 30]) expectOk(await send(d.svm, payer, [ix(d, "add", { tag: new BN(t) }, base)]));
    const r = expectOk(
      await send(d.svm, payer, [
        ix(d, "f", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: bag },
          { address: bag, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(Buffer.from(r.returnData().data()).readBigUInt64LE()).toBe(40_040n);
    expect(decodeAccount<{ tags: BN[] }>(d, d.svm, "Bag", bag).tags.map(String)).toEqual(["10", "20"]);
  });
});
