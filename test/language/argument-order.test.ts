// Built-ins evaluate their arguments left to right, each once, as JS does: a later argument that runs code changing an
// earlier one's value (a helper that bumps an account field) does not change what the earlier one read.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSigner, lamports } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, customError, deployFile, expectOk, fundedSigner, ix, send, type Deployed } from "../harness.js";

const SOURCE = `import { type Mut, type u32, type u64, log64, require } from "typesol";

export interface Counter {
  count: u64;
}

function bump(c: Mut<Counter>): u64 {
  c.count += 1n;
  return c.count;
}

function bumpCode(c: Mut<Counter>): u32 {
  c.count += 1n;
  return 6001n;
}

/** Logs the count before and after a bump: 4 and 5 from 4. */
export function logs(c: Mut<Counter>): void {
  log64(c.count, bump(c), c.count, bump(c), 0n);
}

/** The condition reads the count before the error code's helper bumps it. */
export function checks(c: Mut<Counter>, want: u64): void {
  require(c.count === want, bumpCode(c));
}
`;

describe("argument order of built-ins", () => {
  let d: Deployed;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "typesol-argument-order-"));
    writeFileSync(path.join(dir, "order.ts"), SOURCE);
    d = await deployFile(path.join(dir, "order.ts"));
  });

  const counter = async (count: bigint) => {
    const address = (await generateKeyPairSigner()).address;
    const data = Buffer.alloc(16);
    createHash("sha256").update("account:Counter").digest().copy(data, 0, 0, 8);
    data.writeBigUInt64LE(count, 8);
    d.svm.setAccount({ address, data: new Uint8Array(data), executable: false, lamports: lamports(10_000_000n), programAddress: d.programId, space: 16n });
    return address;
  };

  it("log64 logs each argument as it was when it was evaluated", async () => {
    const payer = await fundedSigner(d.svm);
    const c = await counter(4n);
    const r = expectOk(await send(d.svm, payer, [ix(d, "logs", {}, [{ address: c, writable: true }])]));
    expect(r.logs()).toContain("Program log: 0x4, 0x5, 0x5, 0x6, 0x0");
  });

  it("require evaluates its condition before a computed error code", async () => {
    const payer = await fundedSigner(d.svm);
    const c = await counter(4n);
    expectOk(await send(d.svm, payer, [ix(d, "checks", { want: new BN(4) }, [{ address: c, writable: true }])]));
    const e = await counter(4n);
    expect(customError(await send(d.svm, payer, [ix(d, "checks", { want: new BN(5) }, [{ address: e, writable: true }])]))).toBe(6001);
  });
});
