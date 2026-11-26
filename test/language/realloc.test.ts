import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, deployFile, expectOk, fundedSigner, ix, pda, send, acct } from "../harness.js";

const BORSH = `import { type FixedString, type Init, type Mut, type Signer, type SystemProgram, type u64, realloc } from "typesol";

/** @layout borsh */
export interface Note {
  text: FixedString<64>;
}

export function make(payer: Mut<Signer>, note: Init<Note>, systemProgram: SystemProgram): void {
  note.create(payer, ["note", payer.key]);
}

export function resize(payer: Mut<Signer>, note: Mut<Note>, systemProgram: SystemProgram, size: u64): void {
  realloc(note, size, payer);
}

export function write(payer: Mut<Signer>, note: Mut<Note>, systemProgram: SystemProgram, size: u64, text: string): void {
  realloc(note, size, payer);
  note.text = text;
}
`;

describe("realloc (test/fixtures/realloc.ts)", () => {
  it("grows (payer funds rent), shrinks (lamports stay), and enforces the limits", async () => {
    const d = await deployFile(fileURLToPath(new URL("../fixtures/realloc.ts", import.meta.url)));
    const payer = await fundedSigner(d.svm);
    const [doc] = await pda(d.programId, ["doc", payer.address]);
    const metas = [{ address: payer.address, signer: payer, writable: true }, { address: doc, writable: true }, { address: SYSTEM_PROGRAM }];
    expectOk(await send(d.svm, payer, [ix(d, "make", {}, metas)]));
    const resize = (size: number) => send(d.svm, payer, [ix(d, "resize", { size: new BN(size) }, metas)]);
    const rent = (n: number) => d.svm.minimumBalanceForRentExemption(BigInt(n));

    expectOk(await resize(4000));
    expect(acct(d.svm, doc).data.length).toBe(4000);
    expect(d.svm.getBalance(doc)).toBe(rent(4000));
    const before = d.svm.getBalance(payer.address)!;
    expectOk(await resize(100));
    // Shrinking keeps the lamports in the account (only the program may move them out).
    expect(d.svm.getBalance(doc)).toBe(rent(4000));
    expect(before - d.svm.getBalance(payer.address)!).toBe(5000n);
    expect(customError(await resize(100 + 10 * 1024 + 1))).toBe(3016);
    expect(customError(await resize(15))).toBe(3016); // below 8 + sizeof(Doc)
  });

  it("lets a @layout borsh account shrink to its smallest Borsh form, and refuses a value that no longer fits (3004)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-realloc-borsh-"));
    writeFileSync(path.join(dir, "note.ts"), BORSH);
    const d = await deployFile(path.join(dir, "note.ts"));
    const payer = await fundedSigner(d.svm);
    const [note] = await pda(d.programId, ["note", payer.address]);
    const metas = [{ address: payer.address, signer: payer, writable: true }, { address: note, writable: true }, { address: SYSTEM_PROGRAM }];
    expectOk(await send(d.svm, payer, [ix(d, "make", {}, metas)]));
    const resize = (size: number) => send(d.svm, payer, [ix(d, "resize", { size: new BN(size) }, metas)]);
    const write = (size: number, text: string) => send(d.svm, payer, [ix(d, "write", { size: new BN(size), text }, metas)]);
    // An empty FixedString<64> is 4 bytes of Borsh (its length): 8 + 4 is the smallest the account may be, as its
    // load accepts, not 8 + the 68 bytes of the fixed-capacity field it is worked on as.
    expectOk(await resize(12));
    expect(Buffer.from(acct(d.svm, note).data).subarray(8)).toEqual(Buffer.alloc(4));
    expect(customError(await resize(11))).toBe(3016);
    // The value written back must fit: "hello" needs 8 + 4 + 5 bytes.
    expect(customError(await write(16, "hello"))).toBe(3004);
    expectOk(await write(17, "hello"));
    expect(Buffer.from(acct(d.svm, note).data).subarray(8)).toEqual(Buffer.from([5, 0, 0, 0, ...Buffer.from("hello")]));
    expectOk(await resize(12 + 64));
    expectOk(await write(12, ""));
  });
});
