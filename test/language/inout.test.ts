// Inout<T> helper parameters (test/fixtures/inout.ts, helpers in inout-lib.ts; inout-native.ts under
// NATIVE_ACCOUNT_WRITES): the helper changes the caller's place itself, for every kind of place a caller passes; two
// arguments may not share storage; places that may move are refused; Dup accounts and native views are compared at run
// time; a helper costs about what the same code inline does.
import { type Address, AccountRole, type Instruction, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../src/compiler/index.js";
import {
  BN,
  SYSTEM_PROGRAM,
  type Deployed,
  acct,
  compileErrors,
  customError,
  decodeAccount,
  deployFile,
  expectOk,
  fundedSigner,
  ix,
  pda,
  send,
} from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const said = (r: Result) => expectOk(r).logs();
const u64s = (...v: number[]) => Buffer.concat(v.map((n) => Buffer.from(BigUint64Array.of(BigInt(n)).buffer)));
type Num = { toNumber(): number };
type Book = {
  levels: { price: Num; qty: Num }[];
  rec: { count: Num; total: Num; last: Num };
  buf: { len: number; items: Num[] };
  open: { price: Num; qty: Num }[];
};

const FIXTURE = fileURLToPath(new URL("../fixtures/inout.ts", import.meta.url));

describe("Inout<T> helper parameters", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let book: Address;
  const P = () => ({ address: payer.address, signer: payer, writable: true });
  const B = () => ({ address: book, writable: true });
  const read = () => decodeAccount<Book>(d, d.svm, "Book", book);
  const run = (name: string, args: Record<string, number>, accounts: { address: Address; writable?: boolean; signer?: KeyPairSigner }[]) =>
    send(d.svm, payer, [ix(d, name, Object.fromEntries(Object.entries(args).map(([k, v]) => [k, new BN(v)])), accounts)]);
  /** An account of this program's with these bytes (for loadBorsh / loadRawMut). */
  const raw = async (data: Buffer) => {
    const a = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: a, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: new Uint8Array(data) } as never);
    return a;
  };

  beforeAll(async () => {
    d = await deployFile(FIXTURE);
    payer = await fundedSigner(d.svm);
    [book] = await pda(d.programId, ["book", payer.address]);
    expectOk(await run("create", {}, [P(), B(), { address: SYSTEM_PROGRAM }]));
  });

  it("changes a local struct, through a helper that forwards its parameter too", async () => {
    const r = said(await run("local", { price: 5, qty: 4 }, []));
    expect(r).toContain("Program log: local 3 12 11");
    expect(r).toContain("Program log: level 3 1");
  });

  it("changes fields, list elements, a FixedVec and a FixedArray of a Mut<T> account", async () => {
    expect(said(await run("fields", { i: 1, qty: 4 }, [B()]))).toContain("Program log: after 5");
    const b = read();
    expect([b.rec.count, b.rec.total, b.rec.last].map((x) => x.toNumber())).toEqual([2, 8, 101]);
    expect(b.levels.map((l) => [l.price.toNumber(), l.qty.toNumber()])).toEqual([
      [1100, 10],
      [1101, 5],
      [1102, 10],
      [1103, 10],
    ]);
    expect(b.buf.len).toBe(1);
    expect(b.buf.items[0]!.toNumber()).toBe(4);
  });

  it("changes an element of the account's growable Vec when the helper takes no account", async () => {
    expectOk(await run("open_order", { price: 50, qty: 9 }, [P(), B(), { address: SYSTEM_PROGRAM }]));
    expect(said(await run("fill_open", { i: 0, qty: 4 }, [B()]))).toContain("Program log: open 4 5");
    expect(read().open[0]!.qty.toNumber()).toBe(5);
  });

  it("changes local lists: a FixedVec it pushes to and pops, a FixedArray and its element", async () => {
    const r = said(await run("lists", { a: 2, b: 3 }, []));
    expect(r).toContain("Program log: buf 2 5 3");
    expect(r).toContain("Program log: levels 4 4 1");
  });

  it("changes a loadBorsh local (stored back) and a loadRawMut view", async () => {
    const a = await raw(u64s(1, 10, 0));
    expectOk(await run("borsh", { qty: 6 }, [{ address: a, writable: true }]));
    let data = Buffer.from(acct(d.svm, a).data);
    expect([0, 8, 16].map((o) => Number(data.readBigUInt64LE(o)))).toEqual([3, 22, 4]);
    expectOk(await run("raw", { qty: 5 }, [{ address: a, writable: true }]));
    data = Buffer.from(acct(d.svm, a).data);
    expect([0, 8, 16].map((o) => Number(data.readBigUInt64LE(o)))).toEqual([4, 27, 9]);
  });

  it("changes BigVec elements in a loop moved into a function of its own", async () => {
    expect(generate(FIXTURE).c).toMatch(/ix_sweep__loop0\(TsParams \*params[^\n]*TSS_Recorder \*l_rec_\d+\)/);
    const levels = Buffer.alloc(1 + 4 + 3 * 16);
    levels.writeUInt32LE(3, 1);
    [
      [10, 3],
      [11, 0],
      [12, 7],
    ].forEach(([p, q], i) => u64s(p!, q!).copy(levels, 5 + i * 16));
    const a = await raw(levels);
    expect(said(await run("sweep", { qty: 5 }, [{ address: a, writable: true }]))).toContain("Program log: swept 2 8 12");
    const data = Buffer.from(acct(d.svm, a).data);
    expect([0, 1, 2].map((i) => Number(data.readBigUInt64LE(5 + i * 16 + 8)))).toEqual([0, 0, 2]);
    // A helper's own loop, moved out too, pushing to its Inout list: the caller's list holds both calls' elements.
    expect(generate(FIXTURE).c).toMatch(/fn_gather__loop0\(TsParams \*params[^\n]*TSF_FixedVec8_u64 \*p_buf\)/);
    expect(said(await run("collect", {}, [{ address: a }]))).toContain("Program log: collected 6 10 14");
  });

  it("works with local functions, helpers expanded with a closure, closures, struct results and generics", async () => {
    // bump +10; applyEach total += 3 × 4, count +1; note addEvent count +1 total +3 last 3; stamp count +1; addBoth total +7.
    expect(said(await run("closures", { v: 3, k: 4 }, []))).toContain("Program log: closures 13 22 3 1 13");
  });

  it("costs about what the same code written inline costs", async () => {
    const cu = async (name: string) => expectOk(await run(name, { n: 50 }, [B()])).computeUnitsConsumed();
    const helper = await cu("via_helper");
    const inline = await cu("inlined");
    // A pointer pass, no copy: clang inlines the helper (839 against 841 CU when this was written). A copy in and out
    // per call would cost far more than the margin.
    expect(Math.abs(Number(helper) - Number(inline))).toBeLessThanOrEqual(20);
    expect(read().rec.count.toNumber()).toBe(102);
  });

  it("compares two Dup accounts' places at run time (2040 when they are one account)", async () => {
    const other = await fundedSigner(d.svm);
    const [book2] = await pda(d.programId, ["book", other.address]);
    expectOk(
      await send(d.svm, other, [
        ix(d, "create", {}, [{ address: other.address, signer: other, writable: true }, { address: book2, writable: true }, { address: SYSTEM_PROGRAM }]),
      ]),
    );
    const before = read().rec.count.toNumber();
    expectOk(await run("merge_books", {}, [{ address: book2, writable: true }, B()]));
    expect(read().rec.count.toNumber()).toBe(0);
    expect(decodeAccount<Book>(d, d.svm, "Book", book2).rec.count.toNumber()).toBe(before);
    const same = await run("merge_books", {}, [B(), B()]);
    expect(customError(same)).toBe(2040);
    expect(logs(same).join("\n")).toContain("merge() was given a.rec and b.rec, which share storage");
  });
});

describe("Inout<T> under NATIVE_ACCOUNT_WRITES", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/inout-native.ts", import.meta.url)));
    payer = await fundedSigner(d.svm);
  });
  const account = async (data: Buffer) => {
    const a = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: a, lamports: 1_000_000_000n, programAddress: d.programId, executable: false, data: new Uint8Array(data) } as never);
    return a;
  };
  const call = (accounts: Address[]) =>
    send(d.svm, payer, [
      { programAddress: d.programId, accounts: accounts.map((address) => ({ address, role: AccountRole.WRITABLE })), data: new Uint8Array([0]) } as Instruction,
    ]);

  it("lets two views of different accounts through and refuses one account viewed twice (2040)", async () => {
    const a = await account(u64s(1, 2, 0));
    const b = await account(u64s(3, 4, 0));
    expect(said(await call([a, b]))).toContain("Program log: merged 4 6 0 1");
    const twice = await call([a, a]);
    expect(customError(twice)).toBe(2040);
    expect(logs(twice).join("\n")).toContain("merge() was given a and b, which share storage");
  });
});

describe("Inout<T> compile errors", () => {
  const program = (decls: string, body: string, params = "") => `
import { type AccountInfo, type Account, type Inout, type FixedArray, type FixedVec, type Mut, type Signer, type SystemProgram, type Vec, type BigVec, type Pubkey, type u8, type u64, fixedVec, loadRaw, loadRawMut, remainingAccounts } from "typesol";
export interface Rec { count: u64; total: u64 }
export interface Pair { a: Rec; b: Rec; list: FixedVec<Rec, 4> }
export interface Book { pair: Pair; recs: FixedArray<Rec, 4>; open: Vec<Rec> }
function bump(r: Inout<Rec>): void { r.count += 1n; }
function both(x: Inout<Rec>, y: Inout<Rec>): void { x.count += y.count; }
function look(x: Inout<Rec>, y: Rec): void { x.count += y.count; }
function withBook(x: Inout<Rec>, b: Mut<Book>, payer: Mut<Signer>): void { b.open.push({ count: 0n, total: 0n }, payer); x.count += 1n; }
function swap(p: Inout<Pair>): void { p.a = { count: p.b.count, total: 0n }; }
${decls}
export function go(${params}): void {
  ${body}
}
`;
  const ok = (decls: string, body: string, params = "") => expect(compileErrors(program(decls, body, params))).toBe("");
  const err = (decls: string, body: string, params = "") => compileErrors(program(decls, body, params));

  it("accepts every kind of writable place", () => {
    ok("", "const r: Rec = { count: 0n, total: 0n };\n  bump(r);\n  const p: Pair = { a: r, b: r, list: fixedVec([]) };\n  bump(p.a);\n  both(p.a, p.b);");
    ok("", "bump(book.pair.a);\n  bump(book.recs.get(1n));\n  both(book.pair.a, book.recs.get(0n));", "book: Mut<Book>");
    ok("", "const v = loadRawMut<Rec>(remainingAccounts().get(0n));\n  bump(v);");
    ok("", "const p: Pair = { a: { count: 0n, total: 0n }, b: { count: 0n, total: 0n }, list: fixedVec([]) };\n  bump(p.list.get(0n));\n  swap(p);");
    ok("", "bump({ count: 1n, total: 2n });");
    // BigVec elements, in place and through a slice (a view of the same elements).
    const big = "export interface Recs { tag: u8; items: BigVec<Rec> }";
    ok(big, "const l = loadRawMut<Recs>(remainingAccounts().get(0n));\n  bump(l.items.get(0n));\n  for (const x of l.items.slice(1n, 3n)) bump(x);");
    // A generic helper whose Inout<T> stands for a struct.
    ok(
      "function touch<T>(x: Inout<T>, v: T): void {}",
      "const r: Rec = { count: 0n, total: 0n };\n  const s: Rec = { count: 1n, total: 1n };\n  touch<Rec>(r, s);",
    );
    expect(err("function touch<T>(x: Inout<T>, v: T): void {}", "const r: Rec = { count: 0n, total: 0n };\n  touch<Rec>(r, r);")).toMatch(
      /r and r share storage/,
    );
  });

  it("refuses read-only places, with what to change", () => {
    expect(err("", "bump(book.pair.a);", "book: Account<Book>")).toMatch(/bump\(\) changes r \(Inout\): "book" is read-only; declare it Mut<...>/);
    expect(err("", "bump(r);", "r: Rec")).toMatch(/bump\(\) changes r \(Inout\): instruction arguments are read-only; copy the value into a local first/);
    expect(err("", "bump(orders.get(0n));", "orders: Vec<Rec>")).toMatch(/bump\(\) changes r \(Inout\): Vec arguments are read-only/);
    expect(err("", "const v = loadRaw<Rec>(remainingAccounts().get(0n));\n  bump(v);")).toMatch(/bump\(\) changes r \(Inout\)/);
    // A read-only helper parameter, written or passed on to Inout.
    expect(err("function peek(x: Rec): void { x.count = 1n; }", "")).toMatch(/helper parameters are read-only: declare x as Inout<T>/);
    expect(err("function peek(x: Rec): void { bump(x); }", "")).toMatch(/helper parameters are read-only: declare x as Inout<T>/);
  });

  it("refuses two arguments that share storage", () => {
    const r = "const p: Pair = { a: { count: 0n, total: 0n }, b: { count: 0n, total: 0n }, list: fixedVec([]) };\n  ";
    expect(err("", `${r}both(p.a, p.a);`)).toMatch(/p\.a and p\.a share storage, and both\(\) changes x \(Inout\) in place/);
    expect(err("", "both(book.recs.get(0n), book.recs.get(1n));", "book: Mut<Book>")).toMatch(
      /share storage.*Two elements of one list count as one place whatever their indexes/,
    );
    expect(err("", `${r}look(p.a, p.a);`)).toMatch(/Copy p\.a into a local first \(const copy: T = p\.a\)/);
    expect(err("function inner(p: Inout<Pair>, x: Inout<Rec>): void { p.a.count = x.count; }", `${r}inner(p, p.b);`)).toMatch(/p and p\.b share storage/);
    expect(err("function acc(x: Inout<Rec>, b: Mut<Book>): void { x.count = 1n; }", "acc(book.pair.a, book);", "book: Mut<Book>")).toMatch(
      /Pass the account alone and reach book\.pair\.a through it in the helper/,
    );
    // Forwarding an Inout parameter together with a place inside it.
    expect(err("function fwd(p: Inout<Pair>): void { both(p.a, p.a); }", "")).toMatch(/share storage/);
    // A BigVec element through a slice is the same element.
    expect(
      err(
        "export interface Recs { tag: u8; items: BigVec<Rec> }",
        "const l = loadRawMut<Recs>(remainingAccounts().get(0n));\n  both(l.items.slice(0n, 2n).get(0n), l.items.get(0n));",
      ),
    ).toMatch(/share storage/);
  });

  it("refuses a place in a list whose elements can move while the helper holds it", () => {
    const accts = "payer: Mut<Signer>, book: Mut<Book>, other: Mut<Book>, systemProgram: SystemProgram";
    expect(err("", "withBook(book.open.get(0n), other, payer);", accts)).toMatch(
      /book\.open\.get\(0n\) is in a list whose elements move when it grows.*copy the element into a local/,
    );
    // Given the account too, the place is inside an argument already.
    expect(err("", "withBook(book.open.get(0n), book, payer);", accts)).toMatch(/book\.open\.get\(0n\) and book share storage/);
    expect(
      err(
        "",
        "const o = book.open.get(0n);\n  withBook(o, other, payer);",
        "payer: Mut<Signer>, book: Mut<Book>, other: Mut<Book>, systemProgram: SystemProgram",
      ),
    ).toMatch(/o is in a list whose elements move/);
    // Without an account to resize the list, an element of it is fine.
    ok("", "bump(book.open.get(0n));", "book: Mut<Book>");
  });

  it("refuses a reference into the place read after the call", () => {
    expect(
      err("", "const p: Pair = { a: { count: 0n, total: 0n }, b: { count: 0n, total: 0n }, list: fixedVec([]) };\n  const a = p.a;\n  swap(p);\n  bump(a);"),
    ).toMatch(/"a" refers to data inside p, which swap\(\) may change in place/);
    // The place itself, or one read only before the call, is fine.
    ok(
      "",
      "const p: Pair = { a: { count: 0n, total: 0n }, b: { count: 0n, total: 0n }, list: fixedVec([]) };\n  const a = p.a;\n  bump(a);\n  swap(p);\n  bump(p.a);",
    );
  });

  it("checks references into an Inout list inside the helper", () => {
    expect(err("function drop(p: Inout<Pair>): u64 { const e = p.list.get(0n); p.list.pop(); return e.count; }", "")).toMatch(
      /"e" still refers to p\.list\[\]; replacing it here/,
    );
  });

  it("refuses values, growable lists, accounts and Inout outside helper parameters", () => {
    expect(err("function inc(x: Inout<u64>): void {}", "")).toMatch(/Inout<u64>: a u64 is a value, which JS copies into a function too.*Return the new value/);
    expect(err("function inc(x: Inout<Pubkey>): void {}", "")).toMatch(/Inout<Pubkey>: a Pubkey is a value/);
    expect(err("function inc<T extends bigint>(x: Inout<T>): void {}", "const r: Rec = { count: 0n, total: 0n };\n  inc<u64>(r.count);")).toMatch(
      /Inout<T>: a u64 is a value/,
    );
    expect(err("function grow(x: Inout<Vec<Rec>>): void {}", "")).toMatch(/Inout<Vec<Rec>>: a growable list's elements move.*Inout<FixedVec<T, N>>/);
    expect(err("function acc(x: Inout<Mut<Book>>): void {}", "")).toMatch(/accounts are passed as they are/);
    expect(err("", "", "r: Inout<Rec>")).toMatch(/Inout<T> is for helper parameters/);
    expect(err("", "const r: Inout<Rec> = { count: 0n, total: 0n };")).toMatch(/Inout<T> is for helper parameters; a local needs none/);
    expect(err("function f(x: Inout<FixedVec<Rec, 0>>): void {}", "")).toMatch(/Inout<FixedVec<T, N>>: T is an integer.*N a literal of at least 1/);
  });
});
