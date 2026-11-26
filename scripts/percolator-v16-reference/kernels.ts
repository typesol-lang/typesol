/**
 * Runs engine functions of Percolator v16 (aeyakovenko/percolator 5e3af071, the engine of percolator-prog 7b110913) on
 * the seeded vectors of showcase/test/percolator-v16-kernels.ts and writes their answers, which
 * showcase/test/percolator-v16-kernels.test.ts compares with the port's functions on the same inputs.
 *
 *   node scripts/percolator-v16-reference/kernels.ts [--primitives] [count per function] [output]
 *
 * Default: 60 vectors per function into showcase/test/fixtures/percolator-v16-kernel-vectors.txt (committed). A larger
 * run writes elsewhere and the test reads it from PERCOLATOR_V16_KERNEL_ANSWERS. With --primitives: the functions of
 * showcase/test/percolator-v16-primitives.ts, on whole markets and portfolios, into
 * showcase/test/fixtures/percolator-v16-primitive-vectors.txt (PERCOLATOR_V16_PRIMITIVE_ANSWERS for a larger run).
 *
 * Why: the settlement of a portfolio's open legs (`settle_account_side_effects_not_atomic`) is about a third of the
 * engine, and the reference binary runs it only as a whole, so it cannot be compared through any instruction until all
 * of it is ported. Until then each function is compared with the original's own function, compiled for the host from
 * the pinned sources (not the SBF reference binary): interim evidence.
 *
 * How the private functions are reached: the container fetches the pinned engine commit itself (nothing on the host is
 * used or changed), appends one line to the copy's src/v16.rs declaring kernels/typesol_harness.rs as a child module
 * of `v16` (a child module may call its ancestors' private items, so no visibility is edited), re-exports that module
 * from the copy's src/lib.rs, and adds kernels/typesol_kernels.rs as an example of the copy. The example is built in
 * release with overflow checks off, as the engine is built inside the program (the program's profile governs; the
 * engine crate's own `overflow-checks = true` applies only when it is the root), so the engine's unchecked arithmetic
 * wraps as it does in the reference binary. Docker only (`rust:1.89-slim-bookworm`, 2 CPUs, 6 GiB).
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vectorDigest, vectorInput, vectors } from "../../showcase/test/percolator-v16-kernels.ts";
import { marketVectorDigest, marketVectorInput, marketVectors } from "../../showcase/test/percolator-v16-primitives.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const ENGINE_COMMIT = "5e3af0710ec7e9b7077393012f8a94a31b2f07ef";
const RUST_IMAGE = "rust:1.89-slim-bookworm@sha256:d7fc7de78bb8c1469933aeecbf801314d30d7d6e9f0578bba4cfa285bfa37fe6";
export const KERNEL_SEED = 1717n;
export const PRIMITIVE_SEED = 1919n;
const argv = process.argv.slice(2);
const primitives = argv[0] === "--primitives";
if (primitives) argv.shift();
const count = Number(argv[0] ?? 60);
const OUT = path.resolve(argv[1] ?? path.join(ROOT, `showcase/test/fixtures/percolator-v16-${primitives ? "primitive" : "kernel"}-vectors.txt`));
const seed = primitives ? PRIMITIVE_SEED : KERNEL_SEED;
const example = primitives ? "typesol_primitives" : "typesol_kernels";

const vs = primitives ? marketVectors(seed, count) : vectors(seed, count);
const input = primitives ? marketVectorInput(vs as ReturnType<typeof marketVectors>) : vectorInput(vs as ReturnType<typeof vectors>);
const digest = primitives ? marketVectorDigest(vs as ReturnType<typeof marketVectors>) : vectorDigest(vs as ReturnType<typeof vectors>);
const dir = mkdtempSync(path.join(os.tmpdir(), "percolator-v16-kernels-"));
try {
  copyFileSync(path.join(HERE, "kernels/typesol_harness.rs"), path.join(dir, "typesol_harness.rs"));
  copyFileSync(path.join(HERE, `kernels/${example}.rs`), path.join(dir, `${example}.rs`));
  writeFileSync(path.join(dir, "input.bin"), input);
  const script = [
    "set -euo pipefail",
    "git init -q /work/percolator && cd /work/percolator",
    `for i in 1 2 3; do git fetch -q --depth 1 https://github.com/aeyakovenko/percolator ${ENGINE_COMMIT} && break; sleep 15; done`,
    "git checkout -q --detach FETCH_HEAD",
    `[[ "$(git rev-parse HEAD)" == ${ENGINE_COMMIT} ]]`,
    `mkdir -p /harness examples && cp /vectors/typesol_harness.rs /harness/ && cp /vectors/${example}.rs examples/`,
    `printf '\\n#[path = "/harness/typesol_harness.rs"]\\npub mod typesol_harness;\\n' >> src/v16.rs`,
    `printf '\\npub use v16::typesol_harness;\\n' >> src/lib.rs`,
    `CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS=false CARGO_PROFILE_RELEASE_LTO=false cargo run -q --release --locked -j 2 --example ${example}`,
  ].join("\n");
  const out = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--cpus",
      "2",
      "--memory",
      "6g",
      "-v",
      `${dir}:/vectors:ro`,
      "-v",
      "typesol-percolator-v16-host-cargo:/usr/local/cargo/registry",
      "-v",
      "typesol-percolator-v16-host-cargo-git:/usr/local/cargo/git",
      "-v",
      "typesol-percolator-v16-host-kernels-target:/work/target",
      "-e",
      "CARGO_TARGET_DIR=/work/target",
      RUST_IMAGE,
      "bash",
      "-c",
      `apt-get update -qq && apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null\n${script}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1024 << 20 },
  );
  const lines = out.split("\n").filter((l) => l.startsWith("V "));
  if (lines.length !== vs.length) throw new Error(`${lines.length} answers for ${vs.length} vectors`);
  const header = [
    `# Engine functions of aeyakovenko/percolator ${ENGINE_COMMIT} (the engine of percolator-prog 7b110913), compiled for`,
    `# the host in ${RUST_IMAGE}, release, overflow checks off;`,
    `# written by scripts/percolator-v16-reference/kernels.ts${primitives ? " --primitives" : ""} from the vectors of showcase/test/percolator-v16-${primitives ? "primitives" : "kernels"}.ts.`,
    `# seed ${seed} count ${count} input-sha256 ${digest}`,
    "# V index answer: ok <outputs> | <changed scratch bytes offset:hex> / Err(<V16Error>) / panic <location> <message> / decode",
  ];
  writeFileSync(OUT, `${[...header, ...lines].join("\n")}\n`);
  console.log(`${lines.length} answers written to ${path.relative(ROOT, OUT)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
