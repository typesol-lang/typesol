// A native program's shape (test/fixtures/native.ts): a @fallback entry over raw instruction data, accounts by position,
// a discriminator-less account (loadRaw / loadRawMut), built-in ProgramErrors, panics with a location, overflow as a
// panic, errors from code 0 logged with the entrypoint's prefix, and a struct logged as base64.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner, getAddressEncoder } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, customError, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const enc = getAddressEncoder();
const u64 = (n: bigint) => Buffer.from(BigUint64Array.of(n).buffer);
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");

describe("native programs", () => {
  let d: Deployed;
  let owner: KeyPairSigner;
  let counter: Address;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/native.ts", import.meta.url)));
    owner = await fundedSigner(d.svm);
    counter = (await generateKeyPairSigner()).address;
  });
  const put = (count: bigint, total: bigint, programOwner: Address = d.programId, size = 56) => {
    const data = Buffer.alloc(size);
    Buffer.from(enc.encode(owner.address)).copy(data, 0);
    if (size >= 40) data.writeBigUInt64LE(count, 32);
    if (size >= 56) {
      data.writeBigUInt64LE(total & ((1n << 64n) - 1n), 40);
      data.writeBigUInt64LE(total >> 64n, 48);
    }
    d.svm.setAccount({ address: counter, lamports: 10_000_000n, programAddress: programOwner, executable: false, data } as never);
  };
  const call = (
    data: Buffer,
    signer = owner,
    accounts: { address: Address; signer?: boolean; writable?: boolean }[] = [
      { address: counter, writable: true },
      { address: owner.address, signer: true },
    ],
  ) =>
    send(d.svm, signer, [
      {
        programAddress: d.programId,
        accounts: accounts.map((a) => ({
          address: a.address,
          role: a.signer ? AccountRole.READONLY_SIGNER : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
          ...(a.signer ? { signer } : {}),
        })),
        data: new Uint8Array(data),
      } as Instruction,
    ]);

  it("reads the account from byte 0 and logs a struct as base64", async () => {
    put(0n, 0n);
    const r = await call(Buffer.concat([Buffer.from([0]), u64(5n)]));
    expect(err(r)).toBe("ok");
    const acct = d.svm.getAccount(counter);
    if (!acct.exists) throw new Error("counter is gone");
    const data = Buffer.from(acct.data);
    expect([data.readBigUInt64LE(32), data.readBigUInt64LE(40)]).toEqual([5n, 25n]);
    const record = Buffer.concat([Buffer.from([7]), u64(5n), Buffer.from(enc.encode(owner.address))]);
    expect(logs(r)).toContain(`Program log: record: ${record.toString("base64")}`);
  });

  it("fails with its errors from code 0, logged with the entrypoint's prefix", async () => {
    put(0n, 0n);
    const stranger = await fundedSigner(d.svm);
    const r = await call(Buffer.concat([Buffer.from([0]), u64(1n)]), stranger, [
      { address: counter, writable: true },
      { address: stranger.address, signer: true },
    ]);
    expect(customError(r)).toBe(0);
    expect(logs(r)).toContain("Program log: Native error: Not the owner.");
    expect(customError(await call(Buffer.concat([Buffer.from([0]), u64(0n)])))).toBe(1);
  });

  it("fails with built-in ProgramErrors", async () => {
    put(0n, 0n);
    const short = await call(Buffer.from([0]), owner, [{ address: counter, writable: true }]);
    expect(err(short)).toMatch(/NotEnoughAccountKeys/);
    expect(logs(short)).toContain("Program log: Program error: NotEnoughAccountKeys");
    expect(err(await call(Buffer.alloc(0)))).toMatch(/InvalidInstructionData/);
    expect(err(await call(Buffer.from([0, 1, 2])))).toMatch(/InvalidInstructionData|Custom/); // readU64 past the end: 5104
  });

  it("panics with the location given, and on overflow", async () => {
    const p = await call(Buffer.from([2]));
    expect(err(p)).toMatch(/ProgramFailedToComplete/);
    expect(logs(p)).toContain("Program log: not implemented: tag 2");
    expect(logs(p).some((l) => l.endsWith("failed: SBF program Panicked in program/src/lib.rs at 12:5"))).toBe(true);
    put(2n ** 64n - 1n, 0n);
    expect(err(await call(Buffer.concat([Buffer.from([0]), u64(1n)])))).toMatch(/ProgramFailedToComplete/);
  });

  it("checks the owner and size of a discriminator-less account", async () => {
    put(0n, 0n, owner.address);
    expect(customError(await call(Buffer.concat([Buffer.from([0]), u64(1n)])))).toBe(3007);
    put(0n, 0n, d.programId, 40);
    expect(customError(await call(Buffer.concat([Buffer.from([0]), u64(1n)])))).toBe(3003);
  });

  it("computes a program address with an explicit bump, and a u256 square root", async () => {
    put(0n, 3n * 2n ** 100n);
    const r = await call(Buffer.from([1, 255]), owner, [{ address: counter }]);
    expect(err(r)).toBe("ok");
    expect(logs(r).some((l) => /^Program log: ([1-9A-HJ-NP-Za-km-z]{32,44}|no address)$/.test(l))).toBe(true);
    expect(logs(r)).toContain(`Program log: sqrt ${3n * 2n ** 100n}`);
  });
});
