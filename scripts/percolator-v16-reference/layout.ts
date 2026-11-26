/**
 * Asks the Rust compiler for the persisted layouts of Percolator v16 at commit 7b110913 (engine 5e3af07) and writes
 * them to showcase/test/fixtures/percolator-v16-layout.json, which showcase/test/percolator-v16-layout.test.ts
 * compares with the TypeScript table in showcase/test/percolator-v16-layout.ts.
 *
 *   node scripts/percolator-v16-reference/layout.ts
 *
 * The table names every struct and field; from it this script writes a small Rust program that prints `size_of`,
 * `align_of` and, for each named field, `offset_of!` and the field's `size_of_val`, plus the program's layout
 * constants. A misspelt field or type does not compile; a field the table leaves out shows as a gap the test finds.
 * The program runs in Docker only (`rust:1.89-slim-bookworm`, the host's native architecture, 2 CPUs) as an example of
 * the pinned percolator-prog, fetched by the container itself; the build directory is the named volume the
 * author's-suite script uses too (author-suite.sh), so the dependencies build once.
 *
 * The program is built for the host, not for SBF. That gives the SBF offsets as well: every struct is `#[repr(C)]` and
 * derives bytemuck `Pod`, which fails to compile on any target where the struct would have padding, and the program
 * builds for SBF (build.sh). Without padding each offset is the sum of the sizes before it on both targets.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONSTANTS, STRUCTS } from "../../showcase/test/percolator-v16-layout.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "showcase/test/fixtures/percolator-v16-layout.json");
export const PROG_COMMIT = "7b11091328de23cded2e4afe96592bbd060a6828";
export const ENGINE_COMMIT = "5e3af0710ec7e9b7077393012f8a94a31b2f07ef";
/** rust:1.89-slim-bookworm, the multi-platform index (the host's own architecture runs). */
export const RUST_IMAGE = "rust:1.89-slim-bookworm@sha256:d7fc7de78bb8c1469933aeecbf801314d30d7d6e9f0578bba4cfa285bfa37fe6";

const functions = new Set(["backing_domain_ledger_account_len", "insurance_ledger_account_len"]);
const rust = [
  "// Written by scripts/percolator-v16-reference/layout.ts from showcase/test/percolator-v16-layout.ts.",
  "use core::mem::{align_of, offset_of, size_of, size_of_val};",
  "fn main() {",
  ...Object.entries(STRUCTS).flatMap(([name, s]) => [
    "    {",
    `        type T = ${s.rust};`,
    "        let v: T = <T as bytemuck::Zeroable>::zeroed();",
    `        println!("S ${name} {} {}", size_of::<T>(), align_of::<T>());`,
    ...s.fields.map(([f]) => `        println!("F ${name} ${f} {} {}", offset_of!(T, ${f}), size_of_val(&v.${f}));`),
    "    }",
  ]),
  ...Object.keys(CONSTANTS).map((c) =>
    functions.has(c) ? `    println!("C ${c} {}", percolator_prog::state::${c}());` : `    println!("C ${c} {}", percolator_prog::constants::${c});`,
  ),
  '    println!("C MAGIC {}", percolator_prog::constants::MAGIC);',
  '    println!("C VERSION {}", percolator_prog::constants::VERSION);',
  ...["MARKET", "PORTFOLIO", "BACKING_DOMAIN_LEDGER", "INSURANCE_LEDGER", "CLOSED_MARKET"].map(
    (k) => `    println!("C KIND_${k} {}", percolator_prog::constants::KIND_${k});`,
  ),
  "}",
  "",
].join("\n");

const dir = mkdtempSync(path.join(os.tmpdir(), "percolator-v16-layout-"));
try {
  writeFileSync(path.join(dir, "typesol_layout.rs"), rust);
  const script = [
    "set -euo pipefail",
    "git init -q /work/percolator-prog && cd /work/percolator-prog",
    // A fetch over HTTPS can drop mid-transfer: three tries.
    `for i in 1 2 3; do git fetch -q --depth 1 https://github.com/aeyakovenko/percolator-prog ${PROG_COMMIT} && break; sleep 15; done`,
    "git checkout -q --detach FETCH_HEAD",
    `[[ "$(git rev-parse HEAD)" == ${PROG_COMMIT} ]]`,
    `grep -q 'percolator?rev=${ENGINE_COMMIT}#${ENGINE_COMMIT}' Cargo.lock`,
    "cp /layout/typesol_layout.rs examples/",
    "cargo run -q --locked -j 2 --example typesol_layout",
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
      `${dir}:/layout:ro`,
      "-v",
      "typesol-percolator-v16-host-cargo:/usr/local/cargo/registry",
      "-v",
      "typesol-percolator-v16-host-cargo-git:/usr/local/cargo/git",
      "-v",
      "typesol-percolator-v16-host-target:/work/target",
      "-e",
      "CARGO_TARGET_DIR=/work/target",
      "-e",
      "CARGO_NET_GIT_FETCH_WITH_CLI=true",
      RUST_IMAGE,
      "bash",
      "-c",
      `apt-get update -qq && apt-get install -y -qq --no-install-recommends pkg-config libssl-dev libudev-dev git >/dev/null\n${script}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 << 20 },
  );
  const result: {
    source: Record<string, string>;
    structs: Record<string, { size: number; align: number; fields: Record<string, [offset: number, size: number]> }>;
    constants: Record<string, string>;
  } = { source: { "percolator-prog": PROG_COMMIT, percolator: ENGINE_COMMIT, image: RUST_IMAGE }, structs: {}, constants: {} };
  for (const line of out.split("\n")) {
    const [kind, ...rest] = line.trim().split(" ");
    if (kind === "S") result.structs[rest[0]!] = { size: Number(rest[1]), align: Number(rest[2]), fields: {} };
    else if (kind === "F") result.structs[rest[0]!]!.fields[rest[1]!] = [Number(rest[2]), Number(rest[3])];
    else if (kind === "C") result.constants[rest[0]!] = rest[1]!;
  }
  writeFileSync(OUT, `${JSON.stringify(result, null, 1)}\n`);
  console.log(`${Object.keys(result.structs).length} structs and ${Object.keys(result.constants).length} constants written to ${path.relative(ROOT, OUT)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
