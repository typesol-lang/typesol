// PANIC_STYLE "pinocchio": a Rust panic as pinocchio's `entrypoint!` panic hook reports it under std (Percolator v16):
// the location's file verbatim, "** PANICKED **", then abort. Compared line for line with a binary built with that
// entrypoint and the reference's toolchain (test/programs/percolator_v16_probe.so, scripts/percolator-v16-reference/
// probe.sh) when it is present; the expected lines are also written out, so the test checks them without it.
import { type Address, AccountRole, type KeyPairSigner, generateKeyPairSigner } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "../../src/compiler/index.js";
import { present } from "../binaries.js";
import { type Deployed, compileErrors, deployFile, expectOk, fundedSigner, send } from "../harness.js";

const PROBE = fileURLToPath(new URL("../programs/percolator_v16_probe.so", import.meta.url));
const HAVE_PROBE = present(PROBE);

const head = `import { type u64, ProgramError, instructionData, log, panic, panicsAt, require } from "typesol";\n`;
const fixture = `${head}
export const PANIC_STYLE = "pinocchio";
const ACCOUNT_INFO = "src/account_info.rs";
const RAW_VEC = "/home/runner/work/platform-tools/platform-tools/out/rust/library/alloc/src/raw_vec/mod.rs";

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  // The probe's \`panic!("probe")\`, its index out of bounds and its RefCell::borrow_mut, all in its src/lib.rs.
  if (tag === 0n) panic("probe", "src/lib.rs:41:17");
  if (tag === 1n) panic(null, "src/lib.rs");
  // solana-program's AccountInfo::lamports() on an account mutably borrowed: reported inside solana-program.
  if (tag === 2n) panic("already mutably borrowed: BorrowError", ACCOUNT_INFO);
  // A panic inside the standard library that is not reported at its caller: the toolchain's absolute path.
  if (tag === 3n) panic("capacity overflow", RAW_VEC);
  // Rust's division by zero check, at the original's expression.
  if (tag === 4n) log(panicsAt("src/v16.rs:812:9", data.readU64(1n) / data.readU64(9n)));
  // No location: this source file.
  if (tag === 5n) panic("here");
}
`;

describe('PANIC_STYLE "pinocchio"', () => {
  let dir: string;
  let d: Deployed;
  let svm: LiteSVM;
  let payer: KeyPairSigner;
  let probeAccount: Address;
  const probeId = "Probe11111111111111111111111111111111111111" as Address;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "typesol-pinocchio-panics-"));
    writeFileSync(path.join(dir, "pinocchio-panics.ts"), fixture);
    d = await deployFile(path.join(dir, "pinocchio-panics.ts"));
    svm = d.svm;
    if (HAVE_PROBE) svm.addProgram(probeId, new Uint8Array(readFileSync(PROBE)));
    payer = await fundedSigner(svm);
    probeAccount = (await generateKeyPairSigner()).address;
    svm.setAccount({ address: probeAccount, data: new Uint8Array(8), executable: false, lamports: 1_000_000n as never, programAddress: probeId, space: 8n });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  let nonce = 0;
  const call = (program: Address, data: number[], accounts: Address[] = []) =>
    send(svm, payer, [
      {
        programAddress: program,
        accounts: accounts.map((a) => ({ address: a, role: AccountRole.WRITABLE })) as never,
        // A trailing nonce byte keeps repeated transactions distinct (neither program reads past what it needs).
        data: new Uint8Array([...data, nonce++ & 0xff]),
      },
    ]);
  /** The error and every log line, the program id written <program>, the compute-unit line dropped. */
  const panicOf = (r: Awaited<ReturnType<typeof call>>, program: Address) => {
    const m = r instanceof FailedTransactionMetadata ? r.meta() : r;
    return {
      err: r instanceof FailedTransactionMetadata ? String(r.err()) : "ok",
      logs: m
        .logs()
        .filter((l) => !/ consumed \d+ of \d+ compute units$/.test(l))
        .map((l) => l.replaceAll(program, "<program>")),
    };
  };
  const expected = (file: string) => ({
    err: "TransactionErrorInstructionError { index: 0, error: ProgramFailedToComplete }",
    logs: ["Program <program> invoke [1]", `Program log: ${file}`, "Program log: ** PANICKED **", "Program <program> failed: SBF program panicked"],
  });
  const le = (v: bigint) => [...Buffer.from(BigInt.asUintN(64, v).toString(16).padStart(16, "0"), "hex").reverse()];

  it("logs the file, then ** PANICKED **, then aborts", async () => {
    expect(panicOf(await call(d.programId, [0]), d.programId)).toEqual(expected("src/lib.rs"));
    expect(panicOf(await call(d.programId, [1]), d.programId)).toEqual(expected("src/lib.rs"));
    expect(panicOf(await call(d.programId, [2]), d.programId)).toEqual(expected("src/account_info.rs"));
    expect(panicOf(await call(d.programId, [3]), d.programId)).toEqual(
      expected("/home/runner/work/platform-tools/platform-tools/out/rust/library/alloc/src/raw_vec/mod.rs"),
    );
    expect(panicOf(await call(d.programId, [4, ...le(7n), ...le(0n)]), d.programId)).toEqual(expected("src/v16.rs"));
    expect(panicOf(await call(d.programId, [5]), d.programId)).toEqual(expected("pinocchio-panics.ts"));
    // Within range the values as computed, and no panic.
    const ok = expectOk(await call(d.programId, [4, ...le(14n), ...le(2n)]));
    expect(ok.logs()).toContain("Program log: 7");
  });

  it.skipIf(!HAVE_PROBE)("logs exactly what pinocchio 0.11.1's entrypoint logs (the probe binary)", async () => {
    // The probe's panic! in its src/lib.rs, its index out of bounds and its Vec capacity overflow (both reported at
    // the caller, src/lib.rs), and the RefCell panics through the account shim: borrow_mut in src/lib.rs, then
    // AccountInfo::lamports() inside solana-program.
    const ours0 = panicOf(await call(d.programId, [0]), d.programId);
    expect(panicOf(await call(probeId, [0]), probeId)).toEqual(ours0);
    expect(panicOf(await call(probeId, [1, 9]), probeId)).toEqual(ours0);
    expect(panicOf(await call(probeId, [2, ...le(1n << 62n)]), probeId)).toEqual(ours0);
    expect(panicOf(await call(probeId, [5], [probeAccount, probeAccount]), probeId)).toEqual(ours0);
    expect(panicOf(await call(probeId, [6], [probeAccount, probeAccount]), probeId)).toEqual(panicOf(await call(d.programId, [2]), d.programId));
  });

  it("calls one shared helper per panic site", () => {
    const c = generate(path.join(dir, "pinocchio-panics.ts")).c;
    expect(c).toContain("#define TS_PANIC_PINOCCHIO 1");
    expect(c).toContain('ts_panic_file("src/lib.rs", 10);');
    expect(c).toContain('ts_panic_file("src/account_info.rs", 19);');
    expect(c).toContain('ts_panic_file("src/v16.rs", 10);');
    expect(c).not.toContain("PANICKED");
  });

  it("refuses PANIC_ON_OVERFLOW beside it, and names it among the styles", () => {
    expect(compileErrors(`${head}export const PANIC_STYLE = "pinocchio";\nexport const PANIC_ON_OVERFLOW = true;\nexport function f(): void {}`)).toMatch(
      /PANIC_ON_OVERFLOW cannot be used with PANIC_STYLE = "pinocchio"/,
    );
    expect(compileErrors(`${head}export const PANIC_STYLE = "pinocchio-0.11";\nexport function f(): void {}`)).toMatch(/or "pinocchio" \(the file alone/);
  });
});
