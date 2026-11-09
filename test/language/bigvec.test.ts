// BigVec<T> (test/fixtures/bigvec.ts): SPL's big_vec over a preallocated native account, checked byte for byte
// against a model of big_vec.rs (push, retain's memmoves, deserialize_mut_slice's range check), plus the load check,
// lists of 1,000 and 10,000 73-byte elements (their compute units), and the compile errors.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, address, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, type Deployed, compileErrors, customError, deployFile, fundedSigner, ix, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

const SIZE = 73; // ValidatorStakeInfo
const HEADER = 5; // ValidatorListHeader: account_type u8, max_validators u32
const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

/** A validator's vote account key: its index in the first 4 bytes. */
const vote = (i: number) => {
  const k = Buffer.alloc(32, 0xab);
  k.writeUInt32LE(i + 1, 0);
  return k;
};
const element = (i: number, status = 0) => {
  const e = Buffer.alloc(SIZE);
  e.writeBigUInt64LE(BigInt(i * 1000 + 1), 0); // active_stake_lamports
  e.writeBigUInt64LE(BigInt(i), 8); // transient_stake_lamports
  e.writeBigUInt64LE(3n, 16); // last_update_epoch
  e.writeUInt32LE(i, 36); // validator_seed_suffix
  e[40] = status;
  vote(i).copy(e, 41);
  return e;
};

/**
 * A ValidatorList account: the header, `n` elements (status from `status(i)`), room for `cap`, `extra` bytes more.
 * The unused room is filled with a pattern (not zeros), so stale bytes left by retain are visible.
 */
const listBytes = (n: number, cap: number, status: (i: number) => number = () => 0, extra = 0) => {
  const data = Buffer.alloc(HEADER + 4 + cap * SIZE + extra);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 3) & 0xff;
  data[0] = 2; // AccountType::ValidatorList
  data.writeUInt32LE(cap, 1);
  data.writeUInt32LE(n, HEADER);
  for (let i = 0; i < n; i++) element(i, status(i)).copy(data, HEADER + 4 + i * SIZE);
  return data;
};

/** big_vec.rs's retain, step for step (its sol_memmoves as copyWithin), on the BigVec's bytes at `off`. */
function retainModel(buf: Buffer, off: number, size: number, keep: (el: Buffer) => boolean) {
  const data = buf.subarray(off);
  let vecLen = data.readUInt32LE(0);
  let removals = 0;
  let dst = 0;
  const end = 4 + vecLen * size;
  for (let start = 4; start < end; start += size) {
    if (!keep(data.subarray(start, start + size))) {
      const gap = removals * size;
      if (removals > 0) data.copyWithin(dst, dst + gap, start);
      dst = start - gap;
      removals += 1;
      vecLen -= 1;
    }
  }
  if (removals > 0) data.copyWithin(dst, dst + removals * size, end);
  data.writeUInt32LE(vecLen, 0);
}

/** big_vec.rs's push. */
function pushModel(buf: Buffer, off: number, el: Buffer): boolean {
  const len = buf.readUInt32LE(off);
  const start = off + 4 + len * el.length;
  if (buf.length < start + el.length) return false;
  buf.writeUInt32LE(len + 1, off);
  el.copy(buf, start);
  return true;
}

describe("BigVec", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let list: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/bigvec.ts", import.meta.url)));
    payer = await fundedSigner(d.svm, 100n);
    list = (await generateKeyPairSigner()).address;
  });
  const put = (data: Buffer, owner: Address = d.programId) =>
    d.svm.setAccount({ address: list, lamports: 1_000_000_000_000n, programAddress: owner, executable: false, data } as never);
  const bytes = () => {
    const a = d.svm.getAccount(list);
    if (!a.exists) throw new Error("the list is gone");
    return Buffer.from(a.data);
  };
  const call = (data: Buffer, writable = true) =>
    send(d.svm, payer, [
      { programAddress: COMPUTE_BUDGET, accounts: [], data: new Uint8Array([2, ...u64(1_400_000).subarray(0, 4)]) } as Instruction,
      {
        programAddress: d.programId,
        accounts: [{ address: list, role: writable ? AccountRole.WRITABLE : AccountRole.READONLY }],
        data: new Uint8Array(data),
      } as Instruction,
    ]);
  /** The compute units the program itself used (its "consumed" log line). */
  const cu = (r: Result) => {
    const line = logs(r).find((l) => l.startsWith(`Program ${d.programId} consumed`));
    return Number(/consumed (\d+)/.exec(line ?? "")?.[1]);
  };
  const ok = (r: Result) => {
    if (r instanceof FailedTransactionMetadata) throw new Error(`failed: ${String(r.err())}\n${logs(r).join("\n")}`);
    return r;
  };
  const push = (i: number, status = 0) => call(Buffer.concat([Buffer.from([0]), vote(i), u64(i * 1000 + 1), Buffer.from([status])]));
  const pushed = (i: number, status = 0) => {
    const e = Buffer.alloc(SIZE);
    e.writeBigUInt64LE(BigInt(i * 1000 + 1), 0);
    e[40] = status;
    vote(i).copy(e, 41);
    return e;
  };
  const find = (i: number) => call(Buffer.concat([Buffer.from([1]), vote(i)]), false);
  const retain = (status: number) => call(Buffer.from([2, status]));
  const tooSmall = (r: Result) => {
    expect(err(r)).toMatch(/AccountDataTooSmall/);
    expect(logs(r)).toContain("Program log: Error: AccountDataTooSmall");
  };

  it("lays the struct out as the stake pool does: the header, then the BigVec's length", () => {
    const t = (d.idl.types as { name: string; type: { fields: unknown[] } }[]).find((x) => x.name === "ValidatorList");
    expect(t?.type.fields).toEqual([
      { name: "account_type", type: "u8" },
      { name: "max_validators", type: "u32" },
      { name: "validators", type: { vec: { defined: { name: "ValidatorStakeInfo" } } } },
    ]);
  });

  it("reads an empty list", async () => {
    put(listBytes(0, 4));
    const before = bytes();
    expect(logs(ok(await call(Buffer.from([5]), false)))).toContain("Program log: len 0 cap 4 total 0");
    expect(logs(ok(await find(0)))).toContain("Program log: not found");
    ok(await retain(1));
    expect(bytes()).toEqual(before);
    expect(customError(await call(Buffer.concat([Buffer.from([3]), u64(0)]), false))).toBe(5104);
  });

  it("pushes up to the account's room, then fails as BigVec::push does", async () => {
    // Room for 3 elements and 50 bytes more: the capacity rounds down.
    const model = listBytes(0, 3, undefined, 50);
    put(Buffer.from(model));
    expect(logs(ok(await call(Buffer.from([5]), false)))).toContain("Program log: len 0 cap 3 total 0");
    for (const i of [0, 1, 2]) {
      ok(await push(i, i));
      expect(pushModel(model, HEADER, pushed(i, i))).toBe(true);
      expect(bytes()).toEqual(model);
    }
    expect(pushModel(Buffer.from(model), HEADER, pushed(3))).toBe(false);
    tooSmall(await push(3));
    expect(bytes()).toEqual(model);
    expect(logs(ok(await call(Buffer.from([5]), false)))).toContain(`Program log: len 3 cap 3 total ${1 + 1001 + 2001}`);
  });

  it("gets and sets elements in place, bounds-checked against the length", async () => {
    put(listBytes(3, 5));
    expect(logs(ok(await call(Buffer.concat([Buffer.from([3]), u64(2)]), false)))).toContain("Program log: active 2001");
    expect(customError(await call(Buffer.concat([Buffer.from([3]), u64(3)]), false))).toBe(5104); // in the room, past the length
    const before = bytes();
    ok(await call(Buffer.concat([Buffer.from([4]), u64(1), u64(77)])));
    const want = Buffer.from(before);
    const e = Buffer.alloc(SIZE);
    e.writeBigUInt64LE(77n, 0);
    e.writeBigUInt64LE(7n, 8);
    vote(1).copy(e, 41);
    e.copy(want, HEADER + 4 + SIZE);
    expect(bytes()).toEqual(want);
    expect(customError(await call(Buffer.concat([Buffer.from([4]), u64(3), u64(1)])))).toBe(5104);
  });

  for (const [what, removed] of [
    ["the first", [0]],
    ["a middle", [3]],
    ["the last", [6]],
    ["runs and singles", [0, 1, 3, 5, 6]],
    ["every", [0, 1, 2, 3, 4, 5, 6]],
    ["no", []],
  ] as const)
    it(`retains in place, removing ${what} element(s), byte for byte as big_vec.rs`, async () => {
      const data = listBytes(7, 9, (i) => ((removed as readonly number[]).includes(i) ? 2 : 0), 11);
      put(data);
      ok(await retain(2));
      retainModel(data, HEADER, SIZE, (el) => el[40] !== 2);
      expect(bytes()).toEqual(data);
      expect(data.readUInt32LE(HEADER)).toBe(7 - removed.length);
    });

  it("finds by key: the index and the element's fields", async () => {
    put(listBytes(5, 5));
    expect(logs(ok(await find(0)))).toContain("Program log: found 0 active 1");
    expect(logs(ok(await find(4)))).toContain("Program log: found 4 active 4001");
    expect(logs(ok(await find(5)))).toContain("Program log: not found");
  });

  it("iterates with for … of, from a remaining account and from an AccountInfo parameter", async () => {
    put(listBytes(4, 6));
    expect(logs(ok(await call(Buffer.from([5]), false)))).toContain(`Program log: len 4 cap 6 total ${1 + 1001 + 2001 + 3001}`);
    const r = ok(await send(d.svm, payer, [ix(d, "touch", { epoch: new BN(42) }, [{ address: list, writable: true }])]));
    expect(logs(r)).toContain("Program log: touched 4");
    const data = bytes();
    for (let i = 0; i < 4; i++) expect(data.readBigUInt64LE(HEADER + 4 + i * SIZE + 16)).toBe(42n);
    expect(data.readBigUInt64LE(HEADER + 4 + 4 * SIZE + 16)).not.toBe(42n); // past the length: untouched
  });

  it("works through chunks: slice(skip, skip + len) as deserialize_mut_slice(skip, len), with its range check", async () => {
    put(listBytes(6, 8, (i) => (i === 3 ? 1 : 0)));
    const chunk = (skip: number, len: number) => call(Buffer.concat([Buffer.from([6]), u64(skip), u64(len)]));
    expect(logs(ok(await chunk(2, 3)))).toContain("Program log: chunk 3 3 some true");
    const data = bytes();
    const epochs = [0, 1, 2, 3, 4, 5].map((i) => data.readBigUInt64LE(HEADER + 4 + i * SIZE + 16));
    expect(epochs).toEqual([3n, 3n, 99n, 99n, 99n, 3n]);
    expect(logs(ok(await chunk(6, 0)))).toContain("Program log: chunk 0 0 some false");
    tooSmall(await chunk(4, 3)); // 4 + 3 > 6
    tooSmall(await chunk(7, 0));
    // slice(from) to the end; get / set through it.
    expect(logs(ok(await call(Buffer.concat([Buffer.from([7]), u64(4)]))))).toContain(`Program log: tail ${4001 + 5001}`);
    expect(bytes().readUInt32LE(HEADER + 4 + 4 * SIZE + 32)).toBe(5);
    expect(logs(ok(await call(Buffer.concat([Buffer.from([7]), u64(6)]))))).toContain("Program log: tail 0");
    tooSmall(await call(Buffer.concat([Buffer.from([7]), u64(7)])));
  });

  it("checks the account when it loads it: owner, header size, and a length that fits", async () => {
    put(listBytes(3, 3));
    expect(logs(ok(await call(Buffer.from([9]), false)))).toContain("Program log: loaded 3 of 3");
    const over = listBytes(3, 3);
    over.writeUInt32LE(4, HEADER);
    put(over);
    tooSmall(await call(Buffer.from([9]), false));
    put(listBytes(0, 0).subarray(0, 8)); // shorter than the header and the length
    expect(customError(await call(Buffer.from([9]), false))).toBe(3003);
    put(listBytes(0, 0));
    expect(logs(ok(await call(Buffer.from([9]), false)))).toContain("Program log: loaded 0 of 0");
    tooSmall(await push(0)); // no room at all
    put(listBytes(1, 2), payer.address);
    expect(customError(await call(Buffer.from([9]), false))).toBe(3007);
  });

  it("holds scalar elements: push, retain, find (an Option) and includes", async () => {
    const data = Buffer.alloc(1 + 4 + 8 * 6 + 3, 0x5a);
    data.writeUInt32LE(0, 1);
    put(data);
    for (const v of [1n, 42n, 7n, 500n, 8n]) ok(await call(Buffer.concat([Buffer.from([8]), u64(v)])));
    const r = ok(await call(Buffer.concat([Buffer.from([8]), u64(0)])));
    expect(logs(r)).toContain("Program log: n 3 first>100 500 has42 true");
    const model = Buffer.alloc(data.length, 0x5a);
    model.writeUInt32LE(0, 1);
    for (const v of [1n, 42n, 7n, 500n, 8n]) pushModel(model, 1, u64(v));
    retainModel(model, 1, 8, (el) => el.readBigUInt64LE(0) % 2n === 0n);
    expect(bytes()).toEqual(model);
    for (const v of [9n, 13n, 15n]) ok(await call(Buffer.concat([Buffer.from([8]), u64(v)])));
    tooSmall(await call(Buffer.concat([Buffer.from([8]), u64(11)]))); // 4 + 6 × 8 + 3: room for 6
  });

  it("runs loops with break, continue, changed locals, a loop inside a loop and a return", async () => {
    // Elements 0..5, the third (status 1) skipped by continue; the first loop moves into a function of its own (the
    // slice's loop inside it too), the one returned from stays in the instruction.
    put(listBytes(6, 8, (i) => (i === 2 ? 1 : 0)));
    const run = (stop: number) => call(Buffer.concat([Buffer.from([10]), u64(stop), Buffer.alloc(32, 0xcd)]), false);
    expect(logs(ok(await run(4)))).toContain("Program log: stopped at 4: seen 3 pairs 2 last 3");
    expect(logs(ok(await run(10)))).toContain("Program log: seen 5 pairs 2 last 5");
    expect(logs(ok(await run(0)))).toContain("Program log: stopped at 0: seen 0 pairs 0 last -1");
  });

  describe("large lists (73-byte elements)", () => {
    const report: string[] = [];
    for (const n of [1_000, 10_000]) {
      it(`${n.toLocaleString("en")} elements: find, push, iterate`, async () => {
        put(listBytes(n, n + 1));
        const last = await find(n - 1);
        expect(logs(ok(last))).toContain(`Program log: found ${n - 1} active ${(n - 1) * 1000 + 1}`);
        const miss = await find(n + 5);
        expect(logs(ok(miss))).toContain("Program log: not found");
        const p = ok(await push(n));
        expect(bytes().readUInt32LE(HEADER)).toBe(n + 1);
        tooSmall(await push(n + 1));
        const it2 = ok(await call(Buffer.from([5]), false));
        report.push(`n=${n}: find (last, two scans) ${cu(last)} CU, find miss (two scans) ${cu(miss)} CU, push ${cu(p)} CU, for…of sum ${cu(it2)} CU`);
      });
    }
    it("1,000 elements: retain removing one (the first, the middle), byte for byte", async () => {
      for (const at of [0, 500]) {
        const data = listBytes(1_000, 1_000, (i) => (i === at ? 2 : 0), 20);
        put(data);
        const r = ok(await retain(2));
        retainModel(data, HEADER, SIZE, (el) => el[40] !== 2);
        expect(bytes()).toEqual(data);
        report.push(`retain 1 of 1,000 at ${at}: ${cu(r)} CU`);
      }
      const data = listBytes(1_000, 1_000, (i) => (i % 2 === 0 ? 2 : 0));
      put(data);
      const r = ok(await retain(2));
      retainModel(data, HEADER, SIZE, (el) => el[40] !== 2);
      expect(bytes()).toEqual(data);
      report.push(`retain removing every other of 1,000: ${cu(r)} CU`);
      if (process.env.BIGVEC_CU) console.log(report.join("\n"));
    });
  });
});

describe("BigVec compile errors", () => {
  const program = (decls: string, body: string, params = "") => `
import { type AccountInfo, type Account, type BigVec, type Vec, type FixedArray, type Mut, type Pubkey, type u8, type u32, type u64, loadRaw, loadRawMut, loadAccount, remainingAccounts } from "typesol";
${decls}
export function go(${params}): void {
  ${body}
}
`;
  const list = `export interface Item { a: u64; who: Pubkey }
export interface List { kind: u8; items: BigVec<Item> }`;

  it("is the last field of a fixed-layout struct", () => {
    expect(compileErrors(program(`export interface L { items: BigVec<u64>; kind: u8 }`, ""))).toMatch(
      /BigVec<T> must be the last field of L: its elements run to the end of the account/,
    );
    expect(compileErrors(program(`/** @layout borsh */\nexport interface L { kind: u8; items: BigVec<u64> }`, ""))).toMatch(
      /a @layout borsh struct cannot hold a BigVec/,
    );
    expect(compileErrors(program(`export interface L { kind: u8; log: Vec<u64>; items: BigVec<u64> }`, ""))).toMatch(/has a Vec and a BigVec/);
  });

  it("is not nested", () => {
    expect(compileErrors(program(`${list}\nexport interface Outer { inner: List }`, ""))).toMatch(/List ends in a BigVec and cannot be nested/);
    expect(compileErrors(program(`export interface L { kind: u8; items: FixedArray<BigVec<u64>, 2> }`, ""))).toMatch(
      /BigVec<T> is only the last field of a struct/,
    );
    expect(compileErrors(program(`export interface L { kind: u8; items: BigVec<BigVec<u64>> }`, ""))).toMatch(/BigVec<T> is only the last field of a struct/);
  });

  it("is not an account parameter or an argument", () => {
    expect(compileErrors(program(list, "", "l: Account<List>"))).toMatch(/List ends in a BigVec.*take the account as AccountInfo.*loadRaw<List>/);
    expect(compileErrors(program(list, "", "l: Mut<List>"))).toMatch(/List ends in a BigVec/);
    expect(compileErrors(program(list, "", "l: List"))).toMatch(/List ends in a BigVec, so it is account data, not an argument/);
    expect(compileErrors(program(list, "", "xs: BigVec<u64>"))).toMatch(/BigVec<T> is the last field of a native account's struct.*a Vec<T>/);
    expect(compileErrors(program(`${list}\nfunction h(l: Account<List>): u64 { return l.items.length; }`, ""))).toMatch(/List ends in a BigVec/);
    expect(compileErrors(program(list, "const x: List = { kind: 0n, items: [] as never };"))).toMatch(/cannot be a local/);
    expect(compileErrors(program(list, "const l = loadAccount<List>(remainingAccounts().get(0n));"))).toMatch(
      /List ends in a BigVec.*read it with loadRaw \/ loadRawMut/,
    );
  });

  it("has push without a payer, retain instead of pop / clear, and slices used in place", () => {
    const load = "const l = loadRawMut<List>(remainingAccounts().get(0n));";
    expect(compileErrors(program(list, `${load} l.items.pop();`))).toMatch(/Property 'pop' does not exist on type 'BigVec<Item>'/);
    expect(compileErrors(program(list, `${load} l.items.clear();`))).toMatch(/Property 'clear' does not exist/);
    expect(compileErrors(program(list, `${load} const s = l.items.slice(0n, 1n);`))).toMatch(/a slice is not stored/);
    expect(compileErrors(program(list, `${load} l.items.slice(0n, 1n).push({ a: 1n, who: l.items.get(0n).who });`))).toMatch(
      /Property 'push' does not exist on type 'BigVecSlice<Item>'/,
    );
    expect(compileErrors(program(list, `const l = loadRaw<List>(remainingAccounts().get(0n)); l.items.retain((x) => x.a > 0n);`))).toMatch(/read-only|Mut/);
    expect(compileErrors(program(list, `${load} l.items.retain((x) => x.a > 0n);`))).toBe("");
  });
});
