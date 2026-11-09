// NATIVE_ACCOUNT_WRITES (test/fixtures/native-writes.ts): loadRawMut, storeBorsh and BigVec writes with a native
// program's semantics, against the same program without the flag. Read-only accounts that are only read (or written
// with the bytes they hold) succeed, a real change to one is refused by the runtime, and one account passed twice is
// two views of the same bytes. Without the flag the same transactions fail up front with 3006 and 2040.
import { type Address, AccountRole, generateKeyPairSigner, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, type Deployed, compileErrors, customError, deployFile, fundedSigner, ix, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const enc = getAddressEncoder();
const FIXTURE = fileURLToPath(new URL("../fixtures/native-writes.ts", import.meta.url));

describe("NATIVE_ACCOUNT_WRITES", () => {
  let native: Deployed;
  let checked: Deployed;
  let payer: KeyPairSigner;
  let counter: Address;
  let list: Address;
  beforeAll(async () => {
    native = await deployFile(FIXTURE);
    // The same program without the flag: the default checks.
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-native-writes-"));
    const file = path.join(dir, "checked.ts");
    // (Its AccountInfo parameter must then be Mut<AccountInfo>: see the last test.)
    const source = readFileSync(FIXTURE, "utf8")
      .replace("NATIVE_ACCOUNT_WRITES = true", "NATIVE_ACCOUNT_WRITES = false")
      .replace("type AccountInfo,", "type AccountInfo,\n  type Mut,")
      .replace("(counter: AccountInfo,", "(counter: Mut<AccountInfo>,");
    writeFileSync(file, source);
    checked = await deployFile(file, { svm: native.svm });
    payer = await fundedSigner(native.svm);
    counter = (await generateKeyPairSigner()).address;
    list = (await generateKeyPairSigner()).address;
  });
  const putCounter = (d: Deployed, count: bigint) => {
    const data = Buffer.alloc(40);
    Buffer.from(enc.encode(payer.address)).copy(data, 0);
    data.writeBigUInt64LE(count, 32);
    native.svm.setAccount({ address: counter, lamports: 10_000_000n, programAddress: d.programId, executable: false, data } as never);
  };
  const count = () => Buffer.from(native.svm.getAccount(counter)!.data).readBigUInt64LE(32);
  const putList = (d: Deployed) => {
    const data = Buffer.alloc(1 + 4 + 8 * 4); // room for 4 items, 1 stored
    data.writeUInt32LE(1, 1);
    data.writeBigUInt64LE(9n, 5);
    native.svm.setAccount({ address: list, lamports: 10_000_000n, programAddress: d.programId, executable: false, data } as never);
  };
  let nonce = 0;
  const call = (d: Deployed, tag: number, by: number, accounts: { address: Address; writable: boolean }[]) =>
    send(native.svm, payer, [
      {
        programAddress: d.programId,
        accounts: accounts.map((a) => ({ address: a.address, role: a.writable ? AccountRole.WRITABLE : AccountRole.READONLY })),
        data: new Uint8Array([tag, by, nonce++ & 0xff]),
      },
    ]);
  const ro = (address: Address) => ({ address, writable: false });
  const rw = (address: Address) => ({ address, writable: true });

  it("loads a read-only account with loadRawMut and only reads it", async () => {
    putCounter(native, 5n);
    const r = await call(native, 0, 0, [ro(counter)]);
    expect(err(r)).toBe("ok");
    expect(logs(r)).toContain("Program log: count 5");
    putCounter(checked, 5n);
    expect(customError(await call(checked, 0, 0, [ro(counter)]))).toBe(3006);
  });

  it("leaves a real change to a read-only account to the runtime", async () => {
    putCounter(native, 5n);
    const r = await call(native, 0, 2, [ro(counter)]);
    expect(err(r)).toMatch(/ReadonlyDataModified/);
    expect(count()).toBe(5n);
    expect(err(await call(native, 0, 2, [rw(counter)]))).toBe("ok");
    expect(count()).toBe(7n);
  });

  it("views one account passed twice as the same bytes", async () => {
    putCounter(native, 5n);
    const r = await call(native, 1, 3, [rw(counter), rw(counter)]);
    expect(err(r)).toBe("ok");
    expect(logs(r)).toContain("Program log: seen 8");
    expect(count()).toBe(8n);
    putCounter(checked, 5n);
    expect(customError(await call(checked, 1, 3, [rw(counter), rw(counter)]))).toBe(2040);
  });

  it("stores Borsh to a read-only account when the bytes do not change", async () => {
    putCounter(native, 5n);
    const same = await call(native, 2, 0, [ro(counter)]);
    expect(err(same)).toBe("ok");
    expect(logs(same)).toContain("Program log: stored 5");
    expect(err(await call(native, 2, 1, [ro(counter)]))).toMatch(/ReadonlyDataModified/);
    expect(err(await call(native, 2, 1, [rw(counter)]))).toBe("ok");
    expect(count()).toBe(6n);
    putCounter(checked, 5n);
    expect(customError(await call(checked, 2, 0, [ro(counter)]))).toBe(3006);
  });

  it("reads a read-only BigVec list, and leaves a push to it to the runtime", async () => {
    putList(native);
    const r = await call(native, 3, 0, [ro(list)]);
    expect(err(r)).toBe("ok");
    expect(logs(r)).toContain("Program log: items 1");
    expect(err(await call(native, 3, 4, [ro(list)]))).toMatch(/ReadonlyDataModified/);
    const w = await call(native, 3, 4, [rw(list)]);
    expect(logs(w)).toContain("Program log: items 2");
    putList(checked);
    expect(customError(await call(checked, 3, 0, [ro(list)]))).toBe(3006);
  });

  it("takes a plain AccountInfo parameter for loadRawMut", async () => {
    putCounter(native, 5n);
    const bump = (by: number, writable: boolean) => ix(native, "bump", { by: new BN(by) }, [{ address: counter, writable }]);
    expect(err(await send(native.svm, payer, [bump(0, false)]))).toBe("ok");
    expect(err(await send(native.svm, payer, [bump(1, false)]))).toMatch(/ReadonlyDataModified/);
    expect(err(await send(native.svm, payer, [bump(1, true)]))).toBe("ok");
    expect(count()).toBe(6n);
  });

  it("is a boolean, and without it a plain AccountInfo is refused with what to do", () => {
    const src = (flag: string) =>
      `import { type AccountInfo, loadRawMut, storeBorsh, type u64 } from "typesol";\n${flag}export interface C { n: u64 }\n` +
      `export function f(c: AccountInfo): void {\n  const v = loadRawMut<C>(c);\n  v.n += 1n;\n}\n` +
      `export function g(c: AccountInfo): void {\n  storeBorsh<C>(c, { n: 1n });\n}\n`;
    expect(compileErrors(src("export const NATIVE_ACCOUNT_WRITES = true;\n"))).toBe("");
    expect(compileErrors(src(""))).toMatch(/must be Mut<AccountInfo> to load it with loadRawMut \(or declare const NATIVE_ACCOUNT_WRITES = true/);
    expect(compileErrors(src(""))).toMatch(/must be Mut<AccountInfo> to write it with storeBorsh/);
    expect(compileErrors(src('export const NATIVE_ACCOUNT_WRITES = "yes";\n'))).toMatch(/NATIVE_ACCOUNT_WRITES must be true or false/);
  });
});
