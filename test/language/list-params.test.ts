// Read-only FixedVec / Vec helper parameters given the caller's lists (test/fixtures/list-params.ts), and the calls
// that are refused.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, compileErrors, deployFile, fundedSigner, send } from "../harness.js";

describe("lists as read-only helper parameters", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  let nonce = 0;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/list-params.ts", import.meta.url)));
    payer = await fundedSigner(d.svm);
  });
  const call = async (tag: number, accounts: { address: Address; writable?: boolean; signer?: KeyPairSigner }[]) => {
    const r = await send(d.svm, payer, [
      {
        programAddress: d.programId,
        accounts: accounts.map((a) => ({
          address: a.address,
          role: a.signer ? AccountRole.READONLY_SIGNER : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
          ...(a.signer ? { signer: a.signer } : {}),
        })),
        data: new Uint8Array([tag, nonce++ & 0xff, nonce >> 8]),
      } as Instruction,
    ]);
    if (r instanceof FailedTransactionMetadata) throw new Error(`${String(r.err())}\n${r.meta().logs().join("\n")}`);
    return Buffer.from(r.returnData().data());
  };

  it("takes local FixedVecs of integers and structs, a local struct's FixedVec field, and a FixedVec for a Vec<T>", async () => {
    const other = (await generateKeyPairSigner()).address;
    const out = await call(0, [{ address: payer.address, signer: payer }, { address: other }]);
    expect(out.readBigUInt64LE(0)).toBe(10n); // 1 + 2 + 3 + 4
    expect(out[8]).toBe(1); // one signer among the metas
    expect(out.readBigUInt64LE(9)).toBe(40n); // 10 + 20, then the local list again through Vec<u64>
  });

  it("takes a FixedVec in account data, in place, or copied for a helper that also takes accounts", async () => {
    const store = (await generateKeyPairSigner()).address;
    const data = Buffer.alloc(4 + 8 * 8);
    data.writeUInt32LE(3, 0);
    [5n, 6n, 7n, 99n].forEach((v, i) => data.writeBigUInt64LE(v, 4 + 8 * i)); // the 4th slot is past the length
    d.svm.setAccount({ address: store, lamports: 10_000_000n, programAddress: d.programId, executable: false, data } as never);
    const out = await call(1, [{ address: store, writable: true }]);
    expect(out.readBigUInt64LE(0)).toBe(18n);
    expect(out.readBigUInt64LE(8)).toBe(118n);
  });

  const program = (body: string, extra = "") => `import { type FixedVec, type Inout, type Vec, type u64, fixedVec, log } from "typesol";
function sum(ids: FixedVec<u64, 4>): u64 { return ids.reduce((a, x) => a + x, 0n); }
function both(out: Inout<FixedVec<u64, 4>>, ids: FixedVec<u64, 4>): void { out.push(ids.length); }
${extra}
/** @fallback */
export function entry(): void {
${body}
}`;

  it("refuses an element type that differs, and a list given for its own Inout parameter", () => {
    expect(compileErrors(program("  const xs: FixedVec<u64, 4> = fixedVec([1n]);\n  log(sum(xs));"))).toBe("");
    expect(compileErrors(program("  const xs: FixedVec<u32, 4> = fixedVec([1n]);\n  log(sum(xs));").replace("type u64,", "type u64, type u32,"))).toContain(
      "expected a list of u64",
    );
    expect(compileErrors(program("  const xs: FixedVec<u64, 4> = fixedVec([1n]);\n  both(xs, xs);"))).toContain("share storage");
  });

  it("refuses a list with room for more than the parameter holds", () => {
    expect(
      // TypeScript takes a stored map (FixedVec<u64, never>) for any capacity.
      compileErrors(program("  const xs: FixedVec<u64, 8> = fixedVec([1n]);\n  const ys = xs.map((x) => x + 1n);\n  log(sum(ys));")),
    ).toContain("sum() takes at most 4 elements here (FixedVec<u64, 4>) and this list holds up to 8");
  });
});
