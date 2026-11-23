// Accounts per instruction: 32 by default (5113 beyond), up to 255 with `const MAX_ACCOUNTS = …n`. Above 32 the CPI
// scratch lists live on the heap; reads, CPIs that pass every account on, and loadAccountMut past index 64 all work.
import { type Address, AccountRole, generateKeyPairSigner, getAddressEncoder, lamports } from "@solana/kit";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, acct, compileErrors, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed, type Meta } from "../harness.js";

const body = `
export interface Note { n: u64 }
export function count(): u64 {
  return remainingAccounts().length;
}
export function total(): u64 {
  const rest = remainingAccounts();
  let t = 0n;
  for (let i = 0n; i < rest.length; i++) t += rest.get(i).lamports;
  return t;
}
/** Passes every remaining account on to count(), in a CPI to this program. */
export function relay(self: UncheckedProgram): u64 {
  invoke(self, [...remainingAccounts()], [sighash("count")]);
  return returnData<u64>(self);
}
export interface Meta { pubkey: Pubkey; isSigner: boolean; isWritable: boolean }
/** count() through invokeInstruction, its metas and data from the arguments. */
export function relayDyn(self: UncheckedProgram, metas: Vec<Meta>, data: Vec<u8>): u64 {
  invokeInstruction(self.key, metas, data, remainingAccounts());
  return returnData<u64>(self);
}
export function bump(i: u64): void {
  const note = loadAccountMut<Note>(remainingAccounts().get(i));
  note.n += 1n;
}
export function twice(i: u64): void {
  const a = loadAccountMut<Note>(remainingAccounts().get(i));
  a.n += 1n;
  const b = loadAccountMut<Note>(remainingAccounts().get(i));
  b.n += 1n;
}
`;
const head = `import { type Pubkey, type UncheckedProgram, type Vec, type u8, type u64, invoke, invokeInstruction, loadAccountMut, remainingAccounts, returnData, sighash } from "typesol";\n`;

describe("accounts per instruction", () => {
  let big: Deployed;
  let small: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-accounts-"));
    writeFileSync(path.join(dir, "big.ts"), `${head}export const MAX_ACCOUNTS = 128n;\n${body}`);
    writeFileSync(path.join(dir, "small.ts"), `${head}${body}`);
    big = await deployFile(path.join(dir, "big.ts"));
    small = await deployFile(path.join(dir, "small.ts"));
  });
  const u64 = (r: { returnData(): { data(): Uint8Array } }) => {
    const b = Buffer.alloc(8);
    Buffer.from(r.returnData().data()).copy(b);
    return b.readBigUInt64LE();
  };
  /** `n` remaining accounts from a few distinct ones (an instruction may name an account more than once). */
  async function rest(d: Deployed, n: number): Promise<Meta[]> {
    const keys: Address[] = [];
    for (let i = 0; i < 6; i++) {
      const k = (await generateKeyPairSigner()).address;
      d.svm.setAccount({
        address: k,
        data: new Uint8Array(0),
        executable: false,
        lamports: lamports(BigInt(1000 + i)),
        programAddress: "11111111111111111111111111111111" as Address,
        space: 0n,
      });
      keys.push(k);
    }
    return Array.from({ length: n }, (_, i) => ({ address: keys[i % keys.length]! }));
  }

  it("takes 32 by default and refuses more with 5113", async () => {
    const payer = await fundedSigner(small.svm);
    expect(u64(expectOk(await send(small.svm, payer, [ix(small, "count", {}, await rest(small, 32))])))).toBe(32n);
    expect(customError(await send(small.svm, payer, [ix(small, "count", {}, await rest(small, 33))]))).toBe(5113);
  });

  it("takes up to MAX_ACCOUNTS when the program declares it: reads, CPIs passing them all on", async () => {
    const payer = await fundedSigner(big.svm);
    const many = await rest(big, 100);
    expect(u64(expectOk(await send(big.svm, payer, [ix(big, "count", {}, many)])))).toBe(100n);
    // 100 mentions of six accounts holding 1000..1005 lamports.
    const expected = many.reduce((t, m) => t + acct(big.svm, m.address).lamports, 0n);
    expect(u64(expectOk(await send(big.svm, payer, [ix(big, "total", {}, many)])))).toBe(expected);
    // The program first, then 90 accounts handed on to count() (which sees the 90).
    expect(u64(expectOk(await send(big.svm, payer, [ix(big, "relay", {}, [{ address: big.programId }, ...(await rest(big, 90))])])))).toBe(90n);
    // The same through invokeInstruction: 60 metas built from the arguments (Borsh-encoded by hand: the Anchor coder's
    // buffer is smaller than this instruction).
    const sixty = await rest(big, 60);
    const enc = getAddressEncoder();
    const call = Buffer.from(big.coder.instruction.encode("count", {}));
    const data = Buffer.concat([
      Buffer.from(big.coder.instruction.encode("relay_dyn", { metas: [], data: Buffer.alloc(0) }).subarray(0, 8)),
      Buffer.from(Uint32Array.of(60).buffer),
      ...sixty.map((m) => Buffer.concat([Buffer.from(enc.encode(m.address)), Buffer.from([0, 0])])),
      Buffer.from(Uint32Array.of(call.length).buffer),
      call,
    ]);
    const dyn = { ...ix(big, "relay_dyn", { metas: [], data: Buffer.alloc(0) }, [{ address: big.programId }, ...sixty]), data: new Uint8Array(data) };
    expect(u64(expectOk(await send(big.svm, payer, [dyn])))).toBe(60n);
    expect(customError(await send(big.svm, payer, [ix(big, "count", {}, await rest(big, 129))]))).toBe(5113);
  });

  it("loadAccountMut past index 64, and once per account", async () => {
    const payer = await fundedSigner(big.svm);
    const note = (await generateKeyPairSigner()).address;
    const disc = (big.idl.accounts ?? []).find((a) => a.name === "Note")!.discriminator;
    big.svm.setAccount({
      address: note,
      data: new Uint8Array([...disc, ...new Uint8Array(8)]),
      executable: false,
      lamports: lamports(big.svm.minimumBalanceForRentExemption(16n)),
      programAddress: big.programId,
      space: 16n,
    });
    const filler = await rest(big, 70);
    const accounts = [...filler, { address: note, writable: true }];
    expectOk(await send(big.svm, payer, [ix(big, "bump", { i: new BN(70) }, accounts)]));
    expect(Buffer.from(acct(big.svm, note).data).readBigUInt64LE(8)).toBe(1n);
    // The same account loaded mutably twice in one instruction: refused (2040).
    expect(customError(await send(big.svm, payer, [ix(big, "twice", { i: new BN(70) }, accounts)]))).toBe(2040);
  });

  it("MAX_ACCOUNTS is a number from 32 to 255", () => {
    expect(compileErrors(`${head}export const MAX_ACCOUNTS = 300n;\nexport function f(): void {}`)).toMatch(/MAX_ACCOUNTS must be an integer from 32 to 255/);
  });
});

// A native program at the most accounts one instruction can name, 255 (the runtime refuses an instruction naming more
// with MaxAccountsExceeded before any program runs): a fixed prefix the program checks by position, then a tail of
// remaining accounts, read, written and forwarded whole in a CPI. 39 accounts is TradeCpi's 7 plus its 32-account
// tail in Percolator v16; 255 is the entrypoint's own maximum there.
const native = `import { type FixedVec, type u64, ProgramError, fixedVec, getReturnData, instructionData, invoke, loadRawMut, log, remainingAccounts, require, setReturnData, u8 } from "typesol";
export const MAX_ACCOUNTS = 255n;
export const NATIVE_ACCOUNT_WRITES = true;
export interface Counter { n: u64 }
/** @fallback */
export function entry(): void {
  const rest = remainingAccounts();
  const data = instructionData();
  // Mode 1 (the CPI's callee): the number of accounts it was given, as return data.
  if (data.readU8(0n) === 1n) {
    const out: FixedVec<u8, 2> = fixedVec([]);
    out.push(u8(rest.length & 0xffn));
    out.push(u8(rest.length >> 8n));
    setReturnData(out);
    return;
  }
  // The prefix: a signer, a writable account of this program, this program.
  require(rest.length >= 3n, ProgramError.NotEnoughAccountKeys);
  require(rest.get(0n).isSigner, ProgramError.MissingRequiredSignature);
  require(rest.get(1n).isWritable, ProgramError.InvalidArgument);
  // The tail: every account read, the last one's key logged, the count added into the prefix account.
  const n = rest.length - 3n;
  let lamports = 0n;
  for (let i = 3n; i < rest.length; i++) lamports += rest.get(i).lamports;
  const counter = loadRawMut<Counter>(rest.get(1n));
  counter.n += n;
  log(n);
  log(lamports);
  log(rest.get(rest.length - 1n).key);
  // The tail forwarded whole to this program, which counts it.
  invoke(rest.get(2n), [...rest.slice(3n)], [u8(1n)]);
  const [, reply] = getReturnData();
  log(reply.readU16(0n));
}
`;

describe("a native program's fixed prefix and a long tail, at 39 and 255 accounts", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-accounts-native-"));
    writeFileSync(path.join(dir, "native.ts"), native);
    d = await deployFile(path.join(dir, "native.ts"));
  });

  it("checks the prefix, reads the tail, forwards it in a CPI", async () => {
    const payer = await fundedSigner(d.svm);
    const state = (await generateKeyPairSigner()).address;
    d.svm.setAccount({ address: state, data: new Uint8Array(8), executable: false, lamports: lamports(1_000_000n), programAddress: d.programId, space: 8n });
    // 59 distinct tail accounts at most (a transaction locks at most 64: the payer, the state, the program, the tail),
    // each named several times.
    const keys: Address[] = [];
    for (let i = 0; i < 59; i++) {
      const k = (await generateKeyPairSigner()).address;
      d.svm.setAccount({
        address: k,
        data: new Uint8Array(0),
        executable: false,
        lamports: lamports(BigInt(1000 + i)),
        programAddress: "11111111111111111111111111111111" as Address,
        space: 0n,
      });
      keys.push(k);
    }
    let count = 0n;
    for (const [total, distinct] of [
      [39, 36],
      [39, 5],
      [255, 59],
      [255, 3],
    ] as const) {
      const tail = Array.from({ length: total - 3 }, (_, i) => keys[i % distinct]!);
      const accounts = [
        { address: payer.address, role: AccountRole.READONLY_SIGNER, signer: payer },
        { address: state, role: AccountRole.WRITABLE },
        { address: d.programId, role: AccountRole.READONLY },
        ...tail.map((address) => ({ address, role: AccountRole.READONLY })),
      ];
      const res = expectOk(await send(d.svm, payer, [{ programAddress: d.programId, accounts, data: new Uint8Array([0, total]) }]));
      const sum = tail.reduce((t, k) => t + BigInt(1000 + keys.indexOf(k)), 0n);
      expect(res.logs().filter((l) => l.startsWith("Program log: "))).toEqual([
        `Program log: ${total - 3}`,
        `Program log: ${sum}`,
        `Program log: ${tail.at(-1)}`,
        `Program log: ${total - 3}`,
      ]);
      count += BigInt(total - 3);
      expect(Buffer.from(acct(d.svm, state).data).readBigUInt64LE(0)).toBe(count);
    }
  });
});
