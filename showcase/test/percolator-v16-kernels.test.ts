// The engine functions of the Percolator v16 port that the settlement of a portfolio's open legs is built from
// (showcase/mainnet/percolator-v16/kernels.ts), each against the original's own function: Percolator v16 at commit
// 7b110913 (engine 5e3af07), aeyakovenko/percolator, Apache-2.0.
//
// INTERIM EVIDENCE. The expected answers are the original's functions compiled for the host from the pinned engine
// (scripts/percolator-v16-reference/kernels.ts, recorded in fixtures/percolator-v16-kernel-vectors.txt with the digest
// of the inputs), not the SBF reference binary: the reference binary runs these functions only inside the whole
// settlement (`settle_account_side_effects_not_atomic`), which is not ported yet, so no instruction can compare them.
// When the settlement is complete, SyncMaintenanceFee and Withdraw compare them against the binary.
//
// Each vector runs on chain in LiteSVM through a test program (fixtures/percolator-v16-kernels.ts) and must give the
// same answer: the same outputs and the same changed scratch bytes, the same engine error (as the program maps it), or
// a panic at the same source location with the same message. Inputs whose enum or bool bytes do not decode are not
// comparisons (the original cannot hold them) and are only counted. PERCOLATOR_V16_KERNEL_ANSWERS names a larger
// answers file written by the script (`node scripts/percolator-v16-reference/kernels.ts 1000 <file>`).
import { type Address, type KeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { send } from "../../test/harness.js";
import { countVectors, deployV16, Diff, HAVE_PORT, HAVE_REFERENCE, instruction, outcome } from "./percolator-v16-helpers.js";
import { KERNELS, SCRATCH, type Vector, kernelName, vectorDigest, vectors } from "./percolator-v16-kernels.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/percolator-v16-kernels.ts", import.meta.url));
const ANSWERS = process.env.PERCOLATOR_V16_KERNEL_ANSWERS ?? fileURLToPath(new URL("./fixtures/percolator-v16-kernel-vectors.txt", import.meta.url));

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

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)(
  "Percolator v16 port: the settlement's engine functions against the original's code compiled for the host",
  () => {
    let vm: LiteSVM;
    let program: Address;
    let payer: KeyPairSigner;
    let out: Address;
    let scratch: Address;

    beforeAll(async () => {
      const d = await Diff.create({ port: "reference" });
      const deployed = await deployV16(FIXTURE);
      vm = deployed.svm;
      program = deployed.programId;
      payer = await d.funded();
      vm.airdrop(payer.address, lamports(1_000_000_000_000n));
      out = await d.address();
      scratch = await d.address();
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
    async function run(v: Vector): Promise<string> {
      put(out, Buffer.alloc(96));
      put(scratch, v.scratch);
      const data = Buffer.alloc(1 + 8 * 16);
      data[0] = v.fn;
      v.args.forEach((a, i) => {
        for (let j = 0; j < 16; j++) data[1 + i * 16 + j] = Number((a >> BigInt(8 * j)) & 0xffn);
      });
      const ix = instruction(data, [
        { address: out, writable: true },
        { address: scratch, writable: true },
      ]);
      const res = await send(vm, payer, [{ ...ix, programAddress: program }]);
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
      const acct = (a: Address) => Buffer.from(vm.getAccount(a).exists ? (vm.getAccount(a) as { data: Uint8Array }).data : []);
      const o = acct(out);
      const after = acct(scratch);
      const values = Array.from({ length: 6 }, (_, i) => {
        let x = 0n;
        for (let j = 15; j >= 0; j--) x = (x << 8n) | BigInt(o[i * 16 + j]!);
        return x.toString();
      });
      const diff: string[] = [];
      for (let i = 0; i < SCRATCH.len; i++) if (after[i] !== v.scratch[i]) diff.push(`${i}:${after[i]!.toString(16).padStart(2, "0")}`);
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
      const vs = vectors(seed, count);
      // The inputs the original answered are the ones regenerated here.
      expect(vectorDigest(vs)).toBe(meta[6]);
      const answers = lines.filter((l) => l.startsWith("V ")).map((l) => l.split(" ").slice(2).join(" "));
      expect(answers.length).toBe(vs.length);
      const tally = new Map<number, Record<string, number>>();
      for (let n = 0; n < vs.length; n++) {
        const v = vs[n]!;
        const expected = answers[n]!;
        const t = tally.get(v.fn) ?? {};
        const kind = expected.startsWith("Err(") ? expected : expected.split(" ")[0]!;
        t[kind] = (t[kind] ?? 0) + 1;
        tally.set(v.fn, t);
        if (expected === "decode") continue;
        const got = await run(v);
        expect(sameAnswer(expected, got), `vector ${n}, ${kernelName(v.fn)}:\n  original: ${expected}\n  port:     ${got}`).toBe(true);
        countVectors(1);
      }
      const rows = KERNELS.map((k) => `  ${String(k.id).padStart(2)} ${k.name}: ${JSON.stringify(tally.get(k.id))}`);
      console.log(`${vs.length} vectors (${count} per function), the port's answer equal to the original's on every one that decodes:\n${rows.join("\n")}`);
      // Each function reaches a success on some vector.
      for (const k of KERNELS) expect(tally.get(k.id)?.ok ?? 0, k.name).toBeGreaterThan(0);
    }, 1_800_000);
  },
);
