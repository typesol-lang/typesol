// getReturnData(): the return data as the runtime holds it (Rust's `get_return_data()`), of any length and from any
// program, checked by the program itself: none, shorter and longer than a reader expects, set by another program than
// the one it expects, set by the program itself, and the 1,024-byte maximum.
import { type Address, AccountRole, type KeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Deployed, compileErrors, customError, deployFile, expectOk, fundedSigner, send } from "../harness.js";

const head = `import { type FixedVec, type u64, ProgramError, fixedVec, getReturnData, instructionData, invoke, log, remainingAccounts, require, setReturnData, u8, u16, u64 as toU64 } from "typesol";\n`;

/** Returns `n` bytes (byte i = i & 0xff) when called with [n: u16]; nothing when called with no data. */
const callee = `${head}
/** @fallback */
export function entry(): void {
  const data = instructionData();
  if (data.length === 0n) return;
  const n = data.readU16(0n);
  const out: FixedVec<u8, 1024> = fixedVec([]);
  for (let i = 0n; i < toU64(n); i++) out.push(u8(i & 0xffn));
  setReturnData(out);
}
`;

/**
 * [mode, n: u16, expected: u16]. Mode 0: read without a CPI. Mode 1: call remaining account 0 with [n], read. Mode 2:
 * call it with no data (it returns nothing), read. Mode 3: set its own return data of n bytes, read. Every read logs the
 * program, the length and a checksum, then checks as BatchTradeCpi does: none is 6001, a length other than `expected`
 * is 6002, a program other than remaining account 1 is 6003.
 */
const caller = `${head}
export enum ReplyError {
  /** @code 6001 */
  NoReply = "no reply",
  BadLength = "bad length",
  WrongProgram = "wrong program",
}
export const ERROR_LOG_PREFIX = null;
/** @fallback */
export function entry(): void {
  const data = instructionData();
  const mode = data.readU8(0n);
  const n = data.readU16(1n);
  const expected = data.readU16(3n);
  const rest = remainingAccounts();
  if (mode === 1n) invoke(rest.get(0n), [], [u16(n)]);
  if (mode === 2n) invoke(rest.get(0n), [], []);
  if (mode === 3n) {
    const out: FixedVec<u8, 1024> = fixedVec([]);
    for (let i = 0n; i < toU64(n); i++) out.push(u8((i + 7n) & 0xffn));
    setReturnData(out);
  }
  const [from, reply] = getReturnData();
  log(from);
  log(reply.length);
  let sum = 0n;
  for (let i = 0n; i < reply.length; i++) sum = (sum * 31n + toU64(reply.get(i))) & 0xffffffffn;
  log(sum);
  require(reply.length > 0n, ReplyError.NoReply);
  require(reply.length === toU64(expected), ReplyError.BadLength);
  require(from === rest.get(1n).key, ReplyError.WrongProgram);
  if (reply.length >= 16n) log(reply.readU64(8n));
  const [, again] = getReturnData();
  require(again.length === reply.length, ProgramError.InvalidArgument);
}
`;

describe("getReturnData", () => {
  let dir: string;
  let svm: LiteSVM;
  let a: Deployed;
  let b: Deployed;
  let reader: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "typesol-get-return-data-"));
    writeFileSync(path.join(dir, "callee.ts"), callee);
    writeFileSync(path.join(dir, "caller.ts"), caller);
    a = await deployFile(path.join(dir, "callee.ts"));
    svm = a.svm;
    b = await deployFile(path.join(dir, "callee.ts"), { svm });
    reader = await deployFile(path.join(dir, "caller.ts"), { svm });
    payer = await fundedSigner(svm);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const u16 = (n: number) => [n & 0xff, n >> 8];
  let nonce = 0;
  /** mode, n, expected; remaining accounts: the program called, the program expected. */
  const run = (mode: number, n: number, expected: number, called: Address = a.programId, wanted: Address = a.programId) =>
    send(svm, payer, [
      {
        programAddress: reader.programId,
        accounts: [
          { address: called, role: AccountRole.READONLY },
          { address: wanted, role: AccountRole.READONLY },
        ],
        // A trailing nonce byte keeps repeated transactions distinct (the reader ignores it).
        data: new Uint8Array([mode, ...u16(n), ...u16(expected), nonce++ & 0xff]),
      },
    ]);
  const logs = (r: Awaited<ReturnType<typeof run>>) =>
    (r instanceof FailedTransactionMetadata ? r.meta() : r)
      .logs()
      .filter((l) => l.startsWith("Program log: "))
      .map((l) => l.slice("Program log: ".length));
  /** The checksum the reader logs for bytes (start + i) & 0xff, i < n. */
  const sum = (n: number, start = 0) => {
    let s = 0n;
    for (let i = 0; i < n; i++) s = (s * 31n + BigInt((start + i) & 0xff)) & 0xffffffffn;
    return s;
  };
  const ZERO = "11111111111111111111111111111111";

  it("reads the callee's reply of any length, with the program that set it", async () => {
    // 3 records of 64 bytes, as BatchTradeCpi reads its matcher's.
    const r = expectOk(await run(1, 192, 192));
    expect(logs(r)).toEqual([a.programId, "192", String(sum(192)), String(0x0f0e0d0c0b0a0908n)]);
    expect(Buffer.from(r.returnData().data()).length).toBe(192);
    // The runtime's maximum, 1,024 bytes, read whole.
    expect(logs(expectOk(await run(1, 1024, 1024)))).toEqual([a.programId, "1024", String(sum(1024)), String(0x0f0e0d0c0b0a0908n)]);
    expect(logs(expectOk(await run(1, 1, 1)))).toEqual([a.programId, "1", "0"]);
  });

  it("no return data: length 0 and the program all zeros (Rust's None)", async () => {
    // No CPI: nothing set in this instruction.
    let r = await run(0, 0, 0);
    expect(customError(r)).toBe(6001);
    expect(logs(r)).toEqual([ZERO, "0", "0"]);
    // A CPI whose callee sets nothing: the runtime clears the return data when the call starts.
    r = await run(2, 0, 0);
    expect(customError(r)).toBe(6001);
    expect(logs(r)).toEqual([ZERO, "0", "0"]);
  });

  it("shorter and longer than expected: the program's own error, nothing checked by getReturnData", async () => {
    let r = await run(1, 63, 64);
    expect(customError(r)).toBe(6002);
    expect(logs(r).slice(0, 3)).toEqual([a.programId, "63", String(sum(63))]);
    r = await run(1, 65, 64);
    expect(customError(r)).toBe(6002);
    expect(logs(r).slice(0, 3)).toEqual([a.programId, "65", String(sum(65))]);
  });

  it("set by another program than the one expected: the program's own error", async () => {
    const r = await run(1, 64, 64, b.programId, a.programId);
    expect(customError(r)).toBe(6003);
    expect(logs(r).slice(0, 3)).toEqual([b.programId, "64", String(sum(64))]);
    // The same reply expected from b passes.
    expectOk(await run(1, 64, 64, b.programId, b.programId));
  });

  it("reads what the program itself set with setReturnData", async () => {
    const r = await run(3, 20, 20, a.programId, reader.programId);
    expect(logs(r)).toEqual([reader.programId, "20", String(sum(20, 7)), String(0x161514131211100fn)]);
    expectOk(r);
  });

  it("refuses misuse at compile time", () => {
    const f = (s: string) => compileErrors(`${head}/** @fallback */\nexport function entry(): void { ${s} }`);
    expect(f("const x = getReturnData();")).toMatch(/bind both results where it is called: const \[program, data\] = getReturnData\(\)/);
    expect(f("let [p, d] = getReturnData();")).toMatch(/bind them with const/);
    expect(f("const [p, d] = getReturnData(1n);")).toMatch(/Expected 0 arguments, but got 1/);
    expect(f("const [p, d, e] = getReturnData();")).toMatch(/has no element at index '2'/);
  });
});
