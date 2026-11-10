// `const ERROR_LOG_PREFIX = null` / `PROGRAM_ERROR_LOG_PREFIX = null` (test/fixtures/quiet-errors.ts): failures return
// their error and log nothing, as a native program's do; the same program built with "" for both still logs a line
// for each (the message alone) and costs the log syscall more.
import { type Address, type Instruction, type KeyPairSigner, AccountRole, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type TransactionMetadata } from "litesvm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Deployed, compileErrors, deployFile, fundedSigner, send } from "../harness.js";

type Result = TransactionMetadata | FailedTransactionMetadata;
const FIXTURE = fileURLToPath(new URL("../fixtures/quiet-errors.ts", import.meta.url));
const meta = (r: Result) => (r instanceof FailedTransactionMetadata ? r.meta() : r);
const err = (r: Result) => (r instanceof FailedTransactionMetadata ? String(r.err()) : "ok");
const programLogs = (r: Result) =>
  meta(r)
    .logs()
    .filter((l) => l.startsWith("Program log:"));
const STAKE = "Stake11111111111111111111111111111111111111" as Address;

describe("failures that log nothing", () => {
  let quiet: Deployed;
  let logged: Deployed;
  let payer: KeyPairSigner;
  let dir: string;
  beforeAll(async () => {
    quiet = await deployFile(FIXTURE);
    // The same program with "" prefixes: each failure logs its message alone.
    dir = mkdtempSync(path.join(os.tmpdir(), "typesol-quiet-"));
    const file = path.join(dir, "logged.ts");
    writeFileSync(file, readFileSync(FIXTURE, "utf8").replace(/_PREFIX = null;/g, '_PREFIX = "";'));
    logged = await deployFile(file);
    payer = await fundedSigner(quiet.svm);
    logged.svm.airdrop(payer.address, 10_000_000_000n as never);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const call = async (d: Deployed, tag: number, rest: Address[] = []) => {
    const other = (await generateKeyPairSigner()).address;
    return send(d.svm, payer, [
      {
        programAddress: d.programId,
        accounts: rest.map((address) => ({ address, role: AccountRole.READONLY })),
        // A distinct second byte keeps every transaction's signature fresh.
        data: new Uint8Array([tag, ...Buffer.from(other).subarray(0, 4)]),
      } as Instruction,
    ]);
  };

  const cases: [string, number, string, Address[]][] = [
    ["an error with code 0 (Custom(0))", 0, "Custom { code: 0 }", []],
    ["an error enum member", 1, "Custom { code: 1 }", []],
    ["a built-in ProgramError", 2, "IllegalOwner", []],
    ["a code a helper returned", 3, "Custom { code: 40 }", []],
    ["a returned code of 0 (an overflow, as require(c, code) fails)", 4, "Custom { code: 5100 }", []],
    ["programAt's check", 5, "IncorrectProgramId", ["11111111111111111111111111111111" as Address]],
  ];
  for (const [what, tag, code, rest] of cases)
    it(`${what}: the error, and no failure line`, async () => {
      const q = await call(quiet, tag, rest);
      expect(err(q)).toContain(code);
      expect(programLogs(q)).toEqual(["Program log: checked by the program itself"]);
      const l = await call(logged, tag, rest);
      expect(err(l)).toContain(code);
      // "" keeps the failure line: the message alone ("Program log: " for a built-in ProgramError).
      expect(programLogs(l)).toHaveLength(2);
      // The log syscall (100 CU) and the message's length (sol_strlen) are gone.
      expect(meta(l).computeUnitsConsumed() - meta(q).computeUnitsConsumed()).toBeGreaterThanOrEqual(100n);
    });

  it("succeeds unchanged", async () => {
    const r = await call(quiet, 5, [STAKE]);
    expect(err(r)).toBe("ok");
    expect(programLogs(r)).toEqual(["Program log: checked by the program itself", `Program log: ${STAKE}`]);
  });

  it("only the two prefixes may be null, without a type, and are not values", () => {
    const head = 'import { log } from "typesol";\n';
    expect(compileErrors(`${head}export const HEAP_SIZE_KIB = null;\n/** @fallback */ export function f(): void {}`)).toContain(
      "only ERROR_LOG_PREFIX and PROGRAM_ERROR_LOG_PREFIX can be null",
    );
    expect(compileErrors(`${head}export const ERROR_LOG_PREFIX: string | null = null;\n/** @fallback */ export function f(): void {}`)).toContain(
      "leave the type out: const ERROR_LOG_PREFIX = null",
    );
    expect(compileErrors(`${head}export const ERROR_LOG_PREFIX = null;\n/** @fallback */ export function f(): void { const p = ERROR_LOG_PREFIX; }`)).toContain(
      "ERROR_LOG_PREFIX = null only tells failures to log nothing; it is not a value",
    );
  });
});
