// setReturnData and logComputeUnits (test/fixtures/native-entry-io.ts): a native entry's own return data and the
// runtime's "Program consumption" lines, compared with the lines the Phoenix v1 binary writes.
import { type KeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type Deployed, compileErrors, deployFile, expectOk, fundedSigner, send } from "../harness.js";
import { addrBytes } from "../ports-helpers.js";
import { type Result, cancelAllWithFreeFunds, errOf, initializeMarket, logsOf, phoenixMarket } from "../phoenix-helpers.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/native-entry-io.ts", import.meta.url));
const CU_LINE = /^Program consumption: \d+ units remaining$/;

describe("setReturnData and logComputeUnits", () => {
  let d: Deployed;
  let payer: KeyPairSigner;
  beforeAll(async () => {
    d = await deployFile(FIXTURE);
    payer = await fundedSigner(d.svm);
  });
  let nonce = 0;
  const call = (bytes: number[]) => send(d.svm, payer, [{ programAddress: d.programId, accounts: [], data: new Uint8Array(bytes) }]);
  const named = (name: string, extra: number[]) =>
    send(d.svm, payer, [{ programAddress: d.programId, accounts: [], data: new Uint8Array([...d.coder.instruction.encode(name, {}), ...extra]) }]);
  const ret = (r: Result) => Buffer.from(expectOk(r).returnData().data());
  const own = (r: Result) => logsOf(r).filter((l) => !l.startsWith(`Program ${d.programId}`));

  it("logs the compute units left where it is called, as the runtime writes the line for Rust's sol_log_compute_units", async () => {
    const r = expectOk(await call([0, nonce++]));
    const lines = own(r);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(CU_LINE);
    expect(lines[1]).toBe("Program log: between");
    expect(lines[2]).toMatch(CU_LINE);
    const left = lines.filter((l) => CU_LINE.test(l)).map((l) => Number(/\d+/.exec(l)![0]));
    expect(left[0]).toBeGreaterThan(left[1]!);
  });

  it("writes the same line as the Phoenix binary's sol_log_compute_units", async () => {
    const m = await phoenixMarket();
    expectOk(await initializeMarket(m));
    const r = await cancelAllWithFreeFunds(m);
    expect(errOf(r)).toBe("ok");
    const phoenix = logsOf(r).filter((l) => l.startsWith("Program consumption"));
    expect(phoenix).toHaveLength(2);
    for (const l of phoenix) expect(l).toMatch(CU_LINE);
  });

  it("sets return data from the fallback entry: a slice of the instruction data, as it came", async () => {
    expect([...ret(await call([1, 9, 8, 7, nonce++ & 0xff]))].slice(0, 3)).toEqual([9, 8, 7]);
    const r = expectOk(await call([1, 0xaa, nonce++ & 0xff]));
    expect([...r.returnData().programId()]).toEqual([...addrBytes(d.programId)]);
  });

  it("sets return data from a helper's local list (a Borsh Vec<u64>, Phoenix's order ids)", async () => {
    const out = ret(await call([2, 3, nonce++ & 0xff]));
    expect(out.length).toBe(4 + 3 * 8);
    expect(out.readUInt32LE(0)).toBe(3);
    expect([0, 1, 2].map((i) => out.readBigUInt64LE(4 + 8 * i))).toEqual([1n, 2n, 3n]);
  });

  it("keeps the last call: an empty list clears it", async () => {
    expect(ret(await call([3, 1, 2, nonce++ & 0xff])).length).toBe(0);
  });

  it("leaves more than 1024 bytes to the runtime, which refuses it as it refuses the Rust call", async () => {
    const r = await call([4, nonce++ & 0xff]);
    expect(r).toBeInstanceOf(FailedTransactionMetadata);
    expect(logsOf(r).join("\n")).toMatch(/Return data too large \(1025 > 1024\)/);
  });

  it("lets an instruction's return value, set last, replace what a helper set; a void instruction keeps the helper's", async () => {
    expect(ret(await named("answer", [nonce++ & 0xff])).readBigUInt64LE()).toBe(42n);
    const echoed = ret(await named("echo", [nonce++ & 0xff]));
    expect([...echoed]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("refuses misuse at compile time", () => {
    const head = `import { FixedVec, fixedVec, logComputeUnits, setReturnData, u8, u64 } from "typesol";\n`;
    expect(compileErrors(`${head}export function f(): u64 { const b: FixedVec<u8, 2> = fixedVec([]); setReturnData(b); return 1n; }`)).toMatch(
      /f returns a value, which is its return data: return it instead of calling setReturnData/,
    );
    expect(compileErrors(`${head}export function f(): void { const b: FixedVec<u64, 2> = fixedVec([]); setReturnData(b); }`)).toMatch(
      /setReturnData takes a list of u8/,
    );
    expect(compileErrors(`${head}export function f(): void { logComputeUnits(1n); }`)).toMatch(/Expected 0 arguments|takes no arguments/);
  });
});
