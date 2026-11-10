// loadRawAt / loadRawMutAt and rawArrayAt / rawArrayMutAt (test/fixtures/raw-views.ts): views at run-time offsets
// with run-time element counts, their one bounds check (ProgramError::AccountDataTooSmall, overflow included), the
// owner, writability and claim checks they share with loadRaw / loadRawMut, and the compile errors.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, type Deployed, compileErrors, deployFile, fundedSigner, ix, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const key = (i: number) => Buffer.alloc(32, i);

// Layout: Header (40 bytes) at 0; the body at 104; 5 orders (48 bytes) at 200; 4 prices at 448; 16 spare bytes.
const BODY = 104;
const ORDERS = 200;
const PRICES = 448;
function market(): Buffer {
  const d = Buffer.alloc(PRICES + 4 * 8 + 16);
  for (let i = 0; i < d.length; i++) d[i] = (i * 3 + 1) & 0xff;
  [BODY, ORDERS, 5, PRICES, 4].forEach((v, i) => d.writeBigUInt64LE(BigInt(v), i * 8));
  d.writeBigUInt64LE(41n, BODY); // sequence
  d.writeBigUInt64LE(9n, BODY + 8); // fees
  key(7).copy(d, BODY + 16);
  for (let i = 0; i < 5; i++) {
    d.writeBigUInt64LE(BigInt(100 + i), ORDERS + i * 48);
    d.writeBigUInt64LE(BigInt(10 * (i + 1)), ORDERS + i * 48 + 8);
    key(i + 1).copy(d, ORDERS + i * 48 + 16);
  }
  [1n, 2n, 3n, 4n].forEach((p, i) => d.writeBigUInt64LE(p, PRICES + i * 8));
  return d;
}

describe("run-time offset views", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let acct: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/raw-views.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 100n);
    acct = (await generateKeyPairSigner()).address;
  });
  const put = (data: Buffer, owner: Address = d.programId) =>
    d.svm.setAccount({ address: acct, lamports: 1_000_000_000n, programAddress: owner, executable: false, data } as never);
  const bytes = () => Buffer.from((d.svm.getAccount(acct) as { data: Uint8Array }).data);
  const raw = (data: Buffer, writable = true) =>
    send(d.svm, payer, [
      {
        programAddress: d.programId,
        accounts: [{ address: acct, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY }],
        data: new Uint8Array(data),
      } as Instruction,
    ]);
  const ok = (r: Result) => {
    if (r instanceof FailedTransactionMetadata) throw new Error(`failed: ${String(r.err())}\n${logs(r).join("\n")}`);
    return r;
  };

  it("loadRawAt reads a struct at the offset the header gives (AccountInfo parameter)", async () => {
    put(market());
    const r = ok(await send(d.svm, payer, [ix(d, "read_body", {}, [{ address: acct }])]));
    expect(logs(r)).toContain("Program log: 41");
  });

  it("loadRawMutAt writes in place, and needs a writable account", async () => {
    put(market());
    ok(await send(d.svm, payer, [ix(d, "bump_body", { by: new BN(5) }, [{ address: acct, writable: true }])]));
    expect(bytes().readBigUInt64LE(BODY)).toBe(46n);
    expect(bytes().readBigUInt64LE(BODY + 8)).toBe(10n);
  });

  it("rawArrayAt: for … of, findIndex and get over a run-time count", async () => {
    put(market());
    const r = ok(await raw(Buffer.concat([Buffer.from([0]), u64(25)])));
    expect(logs(r)).toContain("Program log: orders 5 total 150 first 2");
  });

  it("rawArrayMutAt: set a whole element and a field, nothing else changes", async () => {
    const before = market();
    put(before);
    ok(await raw(Buffer.concat([Buffer.from([1]), u64(4), u64(900), u64(901), key(9), u64(0), u64(77)])));
    const after = bytes();
    const want = Buffer.from(before);
    u64(900).copy(want, ORDERS + 4 * 48);
    u64(901).copy(want, ORDERS + 4 * 48 + 8);
    key(9).copy(want, ORDERS + 4 * 48 + 16);
    u64(77).copy(want, ORDERS + 8);
    expect(after.equals(want)).toBe(true);
  });

  it("an index past the count fails (5104) and a read-only account cannot be written (3006)", async () => {
    put(market());
    const past = await raw(Buffer.concat([Buffer.from([1]), u64(5), u64(1), u64(1), key(1), u64(0), u64(1)]));
    expect(err(past)).toContain("code: 5104 ");
    const ro = await raw(Buffer.concat([Buffer.from([1]), u64(0), u64(1), u64(1), key(1), u64(0), u64(1)]), false);
    expect(err(ro)).toContain("code: 3006 ");
  });

  it("scalar elements: set, reduce, some", async () => {
    put(market());
    const r = ok(await raw(Buffer.concat([Buffer.from([2]), u64(3), u64(5000)])));
    expect(logs(r)).toContain("Program log: prices 4 sum 5006 big true");
    expect(bytes().readBigUInt64LE(PRICES + 24)).toBe(5000n);
  });

  it("bounds: checked once, with the offset, the count and their product (overflow included)", async () => {
    put(market());
    const size = market().length;
    // exactly to the end: fine; one more element, an offset past the end, a product that overflows: AccountDataTooSmall
    expect(logs(ok(await raw(Buffer.concat([Buffer.from([3]), u64(size - 16), u64(2)]))))).toContain("Program log: n 2");
    expect(logs(ok(await raw(Buffer.concat([Buffer.from([3]), u64(size), u64(0)]))))).toContain("Program log: n 0");
    for (const [off, n] of [
      [size - 16, 3],
      [size + 1, 0],
      [8, 2n ** 61n],
      [2n ** 64n - 8n, 1],
    ] as const) {
      const r = await raw(Buffer.concat([Buffer.from([3]), u64(off), u64(n)]));
      expect(err(r)).toContain("AccountDataTooSmall");
    }
    expect(err(await raw(Buffer.concat([Buffer.from([4]), u64(size - 47)])))).toContain("AccountDataTooSmall");
    expect(logs(ok(await raw(Buffer.concat([Buffer.from([4]), u64(size - 48)])))).length).toBeGreaterThan(0);
  });

  it("owner (3007) and one mutable view per account (2040), as loadRaw / loadRawMut", async () => {
    put(market(), payer.address);
    expect(err(await raw(Buffer.concat([Buffer.from([0]), u64(0)])))).toContain("code: 3007 ");
    put(market());
    expect(err(await raw(Buffer.from([5])))).toContain("code: 2040 ");
  });

  it("compile errors name the fix", () => {
    const head = `import { type AccountInfo, type Mut, loadRawAt, loadRawMutAt, rawArrayAt, rawArrayMutAt, log, type BigVec } from "typesol";
export interface P { a: u64; }
export interface L { n: u64; items: BigVec<u64>; }
import { type u64 } from "typesol";
`;
    expect(compileErrors(`${head}export function f(a: AccountInfo): void { log(loadRawAt<P>(a, 0n).a); }`)).toContain("bind loadRawAt(…) to a const first");
    expect(compileErrors(`${head}export function f(a: AccountInfo): void { const p = loadRawMutAt<P>(a, 0n); p.a = 1n; }`)).toContain(
      "must be Mut<AccountInfo> to load it with loadRawMutAt",
    );
    expect(compileErrors(`${head}export function f(a: AccountInfo): void { const p = loadRawAt<L>(a, 0n); log(p.n); }`)).toContain("ends in a BigVec");
    expect(compileErrors(`${head}export function f(a: AccountInfo): void { const p = rawArrayAt<P>(a, 0n, 2n); p.set(0n, { a: 1n }); }`)).toMatch(
      /set|read-only/,
    );
    expect(compileErrors(`${head}export function f(a: Mut<AccountInfo>): void { const p = rawArrayMutAt<u64>(a, 0n, 2n); p.push(1n); }`)).toContain(
      "Property 'push' does not exist on type 'RawArray<bigint>'",
    );
    expect(compileErrors(`${head}export function f(a: AccountInfo): void { const p = rawArrayAt<string>(a, 0n, 1n); log(p.length); }`)).toContain(
      "rawArrayAt<T>: T is an integer, boolean, Pubkey, enum, FixedString<N> or a fixed-size struct",
    );
    expect(compileErrors(`${head}export function f(a: AccountInfo): void { const p = rawArrayAt<u64>(a, 0n, 1n); const q = p; log(q.length); }`)).toContain(
      "is a list",
    );
  });
});
