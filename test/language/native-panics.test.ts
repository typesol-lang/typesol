// panic(null, location) and abort() (test/fixtures/native-panics.ts): a native program's panics that log no line of
// their own, with exactly the runtime's last line ("SBF program Panicked in <file> at <line>:<col>" / "SBF program
// panicked").
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, compileErrors, deployFile, fundedSigner, send } from "../harness.js";
import type { KeyPairSigner } from "@solana/kit";

type Result = TransactionMetadata | FailedTransactionMetadata;
const logs = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r).logs();
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const FIXTURE = fileURLToPath(new URL("../fixtures/native-panics.ts", import.meta.url));

describe("native panics", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(FIXTURE);
    payer = await fundedSigner(d.svm);
  });
  let nonce = 0;
  const call = (tag: number) => send(d.svm, payer, [{ programAddress: d.programId, accounts: [], data: new Uint8Array([tag, nonce++ & 0xff]) }]);
  // The program's own lines: everything between its invoke line and its failure line.
  const own = (r: Result) => logs(r).filter((l) => !l.startsWith(`Program ${d.programId}`));

  it("panics at a given location with no log line of its own", async () => {
    const r = await call(0);
    expect(err(r)).toMatch(/ProgramFailedToComplete/);
    expect(own(r)).toEqual([]);
    expect(logs(r).at(-1)).toBe(`Program ${d.programId} failed: SBF program Panicked in src/lib.rs at 105:19`);
  });

  it("panics at its own source line by default", async () => {
    const r = await call(1);
    expect(own(r)).toEqual([]);
    expect(logs(r).at(-1)).toBe(`Program ${d.programId} failed: SBF program Panicked in native-panics.ts at 13:0`);
  });

  it('aborts as Rust\'s abort: "SBF program panicked", no location', async () => {
    const r = await call(2);
    expect(err(r)).toMatch(/ProgramFailedToComplete/);
    expect(own(r)).toEqual(["Program log: Error: memory allocation failed, out of memory"]);
    expect(logs(r).at(-1)).toBe(`Program ${d.programId} failed: SBF program panicked`);
    const bare = await call(3);
    expect(own(bare)).toEqual([]);
    expect(logs(bare).at(-1)).toBe(`Program ${d.programId} failed: SBF program panicked`);
    expect(err(await call(4))).toBe("ok");
  });

  it("refuses other arguments", () => {
    const head = `import { abort, panic } from "typesol";\n/** @fallback */ export function entry(): void { `;
    expect(compileErrors(`${head}abort(1n); }`)).toMatch(/Expected 0 arguments|abort\(\) takes no arguments/);
    expect(compileErrors(`${head}const m = "x" + "y"; panic(m, "a.rs:1:2"); }`)).toMatch(/or null to log nothing/);
    expect(compileErrors(`${head}panic("a", null); }`)).toMatch(/Argument of type 'null'|or null to log nothing/);
  });
});
