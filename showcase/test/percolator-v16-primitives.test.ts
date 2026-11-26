// The market-view accessors and the backing and lien primitives of the Percolator v16 port
// (showcase/mainnet/percolator-v16/primitives.ts), each against the original's own function on whole markets and
// portfolios: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator, Apache-2.0.
//
// INTERIM EVIDENCE. The expected answers are the original's functions compiled for the host from the pinned engine
// (scripts/percolator-v16-reference/kernels.ts --primitives, recorded in fixtures/percolator-v16-primitive-vectors.txt
// with the digest of the inputs), not the SBF reference binary: the binary runs these functions only inside the whole
// settlement of open legs, which is not ported yet (the one exception, the expiry of a lapsed bucket at retirement, is
// compared with the binary in percolator-v16-lifecycle.test.ts).
//
// Each vector runs on chain in LiteSVM through a test program (fixtures/percolator-v16-primitives.ts) over a market
// account and a portfolio account holding the vector's bytes, and must give the same answer: the same outputs and the
// same changed bytes of both accounts, or the same engine error (as the program maps it). Inputs the original cannot
// hold (an enum byte that does not decode as an argument) are only counted. PERCOLATOR_V16_PRIMITIVE_ANSWERS names a
// larger answers file written by the script.
//
// PERCOLATOR_V16_COVERAGE=<report file>: the same run on a copy of the port with branch probes
// (scripts/percolator-v16-reference/coverage.ts), and a report of the probes of the settlement's port files each
// function reached and missed.
import { type Address, type KeyPairSigner, lamports } from "@solana/kit";
import { ComputeBudget, FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { type Probe, coverageReport, instrumentPort, probesInLogs } from "../../scripts/percolator-v16-reference/coverage.ts";
import { send } from "../../test/harness.js";
import { countVectors, deployV16, Diff, HAVE_PORT, HAVE_REFERENCE, instruction, outcome } from "./percolator-v16-helpers.js";
import { type MarketVector, PRIMITIVES, marketVectorDigest, marketVectors, primitiveName } from "./percolator-v16-primitives.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/percolator-v16-primitives.ts", import.meta.url));
const COVERAGE = process.env.PERCOLATOR_V16_COVERAGE;
/** The port files the coverage run probes: the settlement's layers 2 to 7. */
const PROBED = ["primitives.ts", "impairment.ts", "claims.ts", "kfsettle.ts", "settlement.ts"];
const ANSWERS = process.env.PERCOLATOR_V16_PRIMITIVE_ANSWERS ?? fileURLToPath(new URL("./fixtures/percolator-v16-primitive-vectors.txt", import.meta.url));

/** The program's mapping of V16Error (`map_v16_error`): PercolatorError::Engine* codes 14 to 25, in V16Error's order. */
const V16_ERRORS = [
  "InvalidConfig",
  "ArithmeticOverflow",
  "ProvenanceMismatch",
  "HiddenLeg",
  "InvalidLeg",
  "Stale",
  "BStale",
  "LockActive",
  "NonProgress",
  "RecoveryRequired",
  "CounterOverflow",
  "CounterUnderflow",
];

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: the backing and lien primitives against the original's code compiled for the host", () => {
  let vm: LiteSVM;
  let program: Address;
  let payer: KeyPairSigner;
  let out: Address;
  let market: Address;
  let portfolio: Address;
  let probes: Probe[] = [];
  const hit = new Map<number, number>();

  beforeAll(async () => {
    const d = await Diff.create({ port: "reference" });
    let fixture = FIXTURE;
    if (COVERAGE) {
      const c = instrumentPort(FIXTURE, PROBED);
      fixture = c.fixture;
      probes = c.probes;
    }
    const deployed = await deployV16(fixture);
    // The probes cost compute units and log lines: the probed program runs without either limit.
    const budget = new ComputeBudget();
    budget.computeUnitLimit = 100_000_000n;
    vm = COVERAGE ? deployed.svm.withComputeBudget(budget).withLogBytesLimit() : deployed.svm;
    program = deployed.programId;
    payer = await d.funded();
    vm.airdrop(payer.address, lamports(1_000_000_000_000n));
    out = await d.address();
    market = await d.address();
    portfolio = await d.address();
  }, 180_000);

  function put(at: Address, data: Buffer): void {
    vm.setAccount({
      address: at,
      data: new Uint8Array(data),
      executable: false,
      lamports: lamports(1_000_000_000n),
      programAddress: program,
      space: BigInt(data.length),
    });
  }

  /** The port's answer to one vector, in the host program's words. */
  async function run(v: MarketVector): Promise<string> {
    put(out, Buffer.alloc(96));
    put(market, v.market);
    put(portfolio, v.portfolio);
    const data = Buffer.alloc(1 + 8 * 16);
    data[0] = v.fn;
    v.args.forEach((a, i) => {
      for (let j = 0; j < 16; j++) data[1 + i * 16 + j] = Number((a >> BigInt(8 * j)) & 0xffn);
    });
    const ix = instruction(data, [
      { address: out, writable: true },
      { address: market, writable: true },
      { address: portfolio, writable: true },
    ]);
    const res = await send(vm, payer, [{ ...ix, programAddress: program }]);
    if (COVERAGE) probesInLogs(res instanceof FailedTransactionMetadata ? res.meta().logs() : res.logs(), hit);
    if (res instanceof FailedTransactionMetadata) {
      const o = outcome(res);
      const custom = /InstructionErrorCustom \{ code: (\d+) \}/.exec(o);
      if (custom) {
        const code = Number(custom[1]);
        return code >= 14 && code < 26 ? `Err(${V16_ERRORS[code - 14]})` : `custom ${code}`;
      }
      const logs = res.meta().logs().join("\n");
      const p = /panicked at ([^\n]+):\n([^\n]*)/.exec(logs);
      if (p) return `panic ${p[1]} ${p[2]}`;
      return `failed ${o}\n${logs}`;
    }
    const acct = (a: Address) => Buffer.from((vm.getAccount(a) as { data: Uint8Array }).data);
    const o = acct(out);
    const after = Buffer.concat([acct(market), acct(portfolio)]);
    const before = Buffer.concat([v.market, v.portfolio]);
    const values = Array.from({ length: 6 }, (_, i) => {
      let x = 0n;
      for (let j = 15; j >= 0; j--) x = (x << 8n) | BigInt(o[i * 16 + j]!);
      return x.toString();
    });
    const diff: string[] = [];
    for (let i = 0; i < before.length; i++) if (after[i] !== before[i]) diff.push(`${i}:${after[i]!.toString(16).padStart(2, "0")}`);
    return `ok ${values.join(" ")} | ${diff.length ? diff.join(",") : "-"}`;
  }

  /** The port's line trimmed to the original's count of outputs (unused outputs are zero on the port's side). */
  function sameAnswer(expected: string, got: string): boolean {
    if (!expected.startsWith("ok ")) return expected === got;
    if (!got.startsWith("ok ")) return false;
    const parse = (line: string) => /^ok ?(.*?) ?\| (.*)$/.exec(line)!;
    const [, ev, ed] = parse(expected);
    const [, gv, gd] = parse(got);
    const e = ev!.length ? ev!.split(" ") : [];
    const g = gv!.split(" ");
    return ed === gd && e.every((x, i) => x === g[i]) && g.slice(e.length).every((x) => x === "0");
  }

  it("every function on the recorded vectors, answer for answer", async () => {
    const lines = readFileSync(ANSWERS, "utf8").split("\n");
    const meta = lines.find((l) => l.startsWith("# seed "))!.split(" ");
    const seed = BigInt(meta[2]!);
    const count = Number(meta[4]!);
    const vs = marketVectors(seed, count);
    // The inputs the original answered are the ones regenerated here.
    expect(marketVectorDigest(vs)).toBe(meta[6]);
    const answers = lines.filter((l) => l.startsWith("V ")).map((l) => l.split(" ").slice(2).join(" "));
    expect(answers.length).toBe(vs.length);
    const tally = new Map<number, Record<string, number>>();
    const failures: string[] = [];
    for (let n = 0; n < vs.length; n++) {
      const v = vs[n]!;
      const expected = answers[n]!;
      const t = tally.get(v.fn) ?? {};
      // A success that changes the accounts is "write"; one that changes nothing "ok".
      const kind = expected.startsWith("Err(") ? expected : expected.startsWith("ok") && !expected.endsWith("| -") ? "write" : expected.split(" ")[0]!;
      t[kind] = (t[kind] ?? 0) + 1;
      tally.set(v.fn, t);
      if (expected === "decode") continue;
      const got = await run(v);
      if (!sameAnswer(expected, got))
        failures.push(`vector ${n}, ${primitiveName(v.fn)}:\n  original: ${expected.slice(0, 600)}\n  port:     ${got.slice(0, 600)}`);
    }
    const rows = PRIMITIVES.map((k) => `  ${String(k.id).padStart(2)} ${k.name}: ${JSON.stringify(tally.get(k.id))}`);
    console.log(`${vs.length} vectors (${count} per function):\n${rows.join("\n")}`);
    if (COVERAGE) writeFileSync(COVERAGE, `${rows.join("\n")}\n\n${coverageReport(probes, hit)}\n`);
    expect(failures.slice(0, 5).join("\n"), `${failures.length} vectors differ`).toBe("");
    countVectors(vs.filter((_, n) => answers[n] !== "decode").length);
    // Each function reaches a success on some vector.
    for (const k of PRIMITIVES) expect((tally.get(k.id)?.ok ?? 0) + (tally.get(k.id)?.write ?? 0), k.name).toBeGreaterThan(0);
  }, 3_600_000);
});
