// Local lists of structs and bytes, the instruction data as a list, and invokeInstruction from a helper
// (test/fixtures/native-lists.ts), with their compute units: a bulk copy into a FixedVec is a memcpy.
import { type Address, generateKeyPairSigner, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, SYSTEM_PROGRAM, acct, compileErrors, customError, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const cu = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).computeUnitsConsumed();
const enc = getAddressEncoder();
const FIXTURE = fileURLToPath(new URL("../fixtures/native-lists.ts", import.meta.url));

describe("native lists", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let other: Address;
  beforeAll(async () => {
    d = await deployFile(FIXTURE);
    payer = await fundedSigner(d.svm);
    other = (await generateKeyPairSigner()).address;
  });
  const call = (data: Uint8Array, accounts: { address: Address; signer?: boolean; writable?: boolean }[] = []) =>
    send(d.svm, payer, [
      {
        programAddress: d.programId,
        accounts: accounts.map((a) => ({ address: a.address, role: (a.writable ? 1 : 0) | (a.signer ? 2 : 0) })),
        data,
      } as never,
    ]);
  const bytes = (tag: number, body: number[] | Uint8Array) => new Uint8Array([tag, ...body]);
  const ramp = (n: number) => Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);

  it("copies bytes into a local list in one memcpy: well under 1 CU a byte", async () => {
    const measure = async (tag: number, n: number) => {
      const body = ramp(n);
      const r = await call(bytes(tag, body));
      expect(err(r)).toBe("ok");
      expect(logs(r)).toContain(`Program log: copied ${n} last ${body.at(-1)}`);
      return Number(cu(r));
    };
    // The cost per byte: the difference between two lengths, so the fixed part (the call, the log) drops out.
    const perByte = async (tag: number) => ((await measure(tag, 1000)) - (await measure(tag, 100))) / 900;
    const bulk = await perByte(0);
    const loop = await perByte(1);
    console.log(`CU per byte: pushAll ${bulk.toFixed(3)}, a push per byte ${loop.toFixed(3)}`);
    expect(bulk).toBeLessThan(0.1);
    expect(loop).toBeGreaterThan(5);
  });

  it("invokes from a helper with metas built there", async () => {
    const to = (await generateKeyPairSigner()).address;
    d.svm.airdrop(to, 1_000_000_000n as never);
    const lamports = Buffer.alloc(8);
    lamports.writeBigUInt64LE(12345n);
    const before = acct(d.svm, to).lamports;
    const r = await call(bytes(2, lamports), [
      { address: payer.address, signer: true, writable: true },
      { address: to, writable: true },
      { address: SYSTEM_PROGRAM },
    ]);
    expect(err(r)).toBe("ok");
    expect(logs(r)).toContain("Program log: transferred");
    expect(acct(d.svm, to).lamports - before).toBe(12345n);
  });

  it("lets a meta name an account the transaction does not hold: the runtime refuses the CPI, as under Rust", async () => {
    const lamports = Buffer.alloc(8);
    lamports.writeBigUInt64LE(1n);
    const r = await call(bytes(3, Buffer.concat([lamports, Buffer.from(enc.encode(other))])), [
      { address: payer.address, signer: true, writable: true },
      { address: (await generateKeyPairSigner()).address, writable: true },
      { address: SYSTEM_PROGRAM },
    ]);
    expect(err(r)).toMatch(/MissingAccount/);
    expect(logs(r).some((l) => /unknown account/i.test(l))).toBe(true);
  });

  it("builds lists of structs on the stack", async () => {
    const a = (await generateKeyPairSigner()).address;
    const b = (await generateKeyPairSigner()).address;
    const r = await call(bytes(4, []), [{ address: a }, { address: b }]);
    expect(err(r)).toBe("ok");
    const l = logs(r);
    expect(l).toContain("Program log: metas 2 writable 2 signer 1");
    expect(l).toContain(`Program log: ${a}`);
    expect(l).toContain(`Program log: ${b}`);
    expect(l).toContain("Program log: after pop 1 empty 0");
    expect(l).toContain("Program log: pair false true");
    expect(l).toContain("Program log: all 3 true true");
    expect(l).toContain("Program log: inline 30 12 true");
  });

  it("reads slices of the instruction data as lists, range-checked", async () => {
    const r = await call(bytes(5, [4, 1, 7, 2]));
    expect(err(r)).toBe("ok");
    const l = logs(r);
    expect(l).toContain("Program log: len 4 head 2 1 sum 14 8");
    expect(l).toContain(`Program log: le ${4 + 256} max 2 has true`);
    expect(l).toContain("Program log: out 4 1");
    expect(l).toContain("Program log: far 4");
    // end past the length: 5104, not clamped.
    expect(customError(await call(bytes(5, [9, 1, 7, 2])))).toBe(5104);
  });

  it("fails a pushAll past the room left (5104)", async () => {
    expect(err(await call(bytes(6, [1, 2, 3])))).toBe("ok");
    expect(customError(await call(bytes(6, [1, 2, 3, 4])))).toBe(5104);
  });

  it("refuses what it cannot hold, with hints", () => {
    const head = `import { type FixedVec, type FixedArray, type Pubkey, type u8, fixedVec, fixedArray, instructionData, log } from "typesol";
export interface Meta { pubkey: Pubkey; isSigner: boolean; isWritable: boolean }
/** @fallback */ export function entry(): void { `;
    expect(compileErrors(`${head}const xs: FixedVec<Meta, 100> = fixedVec([]); log(\`\${xs.length}\`); }`)).toMatch(
      /FixedVec<Meta, 100> takes 3404 bytes; locals live on the 4 KiB stack, so keep it under 2 KiB/,
    );
    expect(
      compileErrors(`${head}const xs = fixedArray<Meta, 80>({ pubkey: instructionData().readPubkey(0n), isSigner: false, isWritable: false }); }`),
    ).toMatch(/FixedArray<Meta, 80> takes 2720 bytes/);
    expect(compileErrors(`${head}const xs: FixedVec<string, 4> = fixedVec([]); }`)).toMatch(
      /as a local: T is an integer, boolean, Pubkey, enum, FixedString<N> or a struct/,
    );
    expect(
      compileErrors(`${head}const data = instructionData(); const xs: FixedVec<u8, 4> = fixedVec([]); xs.pushAll(data.slice(0n).map((b) => b)); }`),
    ).toMatch(/pushAll takes a list of u8/);
    expect(compileErrors(`${head}const data = instructionData(); const ys = data.slice(1n).map((b) => b); }`)).toMatch(
      /annotate the new one with its capacity/,
    );
  });
});
