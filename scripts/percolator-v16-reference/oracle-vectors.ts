/**
 * Runs Percolator v16's external oracle reader (aeyakovenko/percolator-prog 7b110913, `oracle_v16::
 * read_external_price_e6_profile` and `profile_hybrid_soft_stale_matured`) on the seeded vectors of
 * showcase/test/percolator-v16-oracles.ts and writes its answers to showcase/test/fixtures/percolator-v16-oracle-vectors.txt,
 * which showcase/test/percolator-v16-external.test.ts compares with the port's reader (external.ts) on the same inputs.
 *
 *   node scripts/percolator-v16-reference/oracle-vectors.ts [count]
 *
 * Why: the reader's branches that only the crank reaches (a profile whose legs already hold observations: an older
 * publish time, the same time with another price, the legs that advance) cannot be compared through any ported
 * instruction yet, since ConfigureHybridOracle always starts from empty legs. The original's own code answers them here,
 * compiled for the host from the pinned sources (not the SBF reference binary): an example of the pinned
 * percolator-prog that reads the vectors' bytes, builds `AccountInfo`s and an `AssetOracleProfileV16` from them and
 * prints the result, the profile's stored legs after the call, and the soft-stale predicate. It runs in Docker only
 * (`rust:1.89-slim-bookworm`, 2 CPUs), fetching the pinned commit itself, like layout.ts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vectorDigest, vectorInput, vectors } from "../../showcase/test/percolator-v16-oracles.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.join(ROOT, "showcase/test/fixtures/percolator-v16-oracle-vectors.txt");
// The pin and the image of layout.ts (which runs when imported, so they are repeated here).
const PROG_COMMIT = "7b11091328de23cded2e4afe96592bbd060a6828";
const ENGINE_COMMIT = "5e3af0710ec7e9b7077393012f8a94a31b2f07ef";
const RUST_IMAGE = "rust:1.89-slim-bookworm@sha256:d7fc7de78bb8c1469933aeecbf801314d30d7d6e9f0578bba4cfa285bfa37fe6";
const VECTOR_SEED = 1618n;
const count = Number(process.argv[2] ?? 1200);

const rust = `use percolator_prog::oracle_v16;
use percolator_prog::state::AssetOracleProfileV16;
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

fn take<'a>(b: &'a [u8], at: &mut usize, n: usize) -> &'a [u8] {
    let s = &b[*at..*at + n];
    *at += n;
    s
}

fn main() {
    let buf = std::fs::read("/vectors/input.bin").unwrap();
    let mut at = 0usize;
    let n = u32::from_le_bytes(take(&buf, &mut at, 4).try_into().unwrap());
    for i in 0..n {
        let accounts = take(&buf, &mut at, 1)[0] as usize;
        let now_ts = i64::from_le_bytes(take(&buf, &mut at, 8).try_into().unwrap());
        let now_slot = u64::from_le_bytes(take(&buf, &mut at, 8).try_into().unwrap());
        let mut profile: AssetOracleProfileV16 = bytemuck::pod_read_unaligned(take(&buf, &mut at, 424));
        let mut keys = Vec::new();
        let mut owners = Vec::new();
        let mut datas: Vec<Vec<u8>> = Vec::new();
        let mut lamports = vec![1u64; accounts];
        for _ in 0..accounts {
            keys.push(Pubkey::new_from_array(take(&buf, &mut at, 32).try_into().unwrap()));
            owners.push(Pubkey::new_from_array(take(&buf, &mut at, 32).try_into().unwrap()));
            let len = u32::from_le_bytes(take(&buf, &mut at, 4).try_into().unwrap()) as usize;
            datas.push(take(&buf, &mut at, len).to_vec());
        }
        let soft = oracle_v16::profile_hybrid_soft_stale_matured(&profile, now_slot);
        let infos: Vec<AccountInfo> = lamports
            .iter_mut()
            .zip(datas.iter_mut())
            .zip(keys.iter().zip(owners.iter()))
            .map(|((l, d), (k, o))| AccountInfo::new(k, false, false, l, d, o, false, 0))
            .collect();
        let result = oracle_v16::read_external_price_e6_profile(&mut profile, &infos, now_ts);
        let head = match result {
            Ok((price, time, advanced)) => format!("ok {} {} {}", price, time, advanced as u8),
            Err(e) => format!("{:?} 0 0 0", e),
        };
        let p = profile.oracle_leg_prices_e6;
        let t = profile.oracle_leg_publish_times;
        println!("V {} {} {} {} {} {} {} {} {}", i, head, p[0], p[1], p[2], t[0], t[1], t[2], soft as u8);
    }
}
`;

const vs = vectors(VECTOR_SEED, count);
const dir = mkdtempSync(path.join(os.tmpdir(), "percolator-v16-oracle-vectors-"));
try {
  writeFileSync(path.join(dir, "typesol_oracle_vectors.rs"), rust);
  writeFileSync(path.join(dir, "input.bin"), vectorInput(vs));
  const script = [
    "set -euo pipefail",
    "git init -q /work/percolator-prog && cd /work/percolator-prog",
    `for i in 1 2 3; do git fetch -q --depth 1 https://github.com/aeyakovenko/percolator-prog ${PROG_COMMIT} && break; sleep 15; done`,
    "git checkout -q --detach FETCH_HEAD",
    `[[ "$(git rev-parse HEAD)" == ${PROG_COMMIT} ]]`,
    `grep -q 'percolator?rev=${ENGINE_COMMIT}#${ENGINE_COMMIT}' Cargo.lock`,
    "cp /vectors/typesol_oracle_vectors.rs examples/",
    "cargo run -q --locked -j 2 --example typesol_oracle_vectors",
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
  const lines = out.split("\n").filter((l) => l.startsWith("V "));
  if (lines.length !== vs.length) throw new Error(`${lines.length} answers for ${vs.length} vectors`);
  const header = [
    `# read_external_price_e6_profile and profile_hybrid_soft_stale_matured of aeyakovenko/percolator-prog ${PROG_COMMIT}`,
    `# (engine ${ENGINE_COMMIT}), compiled for the host in ${RUST_IMAGE};`,
    `# written by scripts/percolator-v16-reference/oracle-vectors.ts from the vectors of showcase/test/percolator-v16-oracles.ts.`,
    `# seed ${VECTOR_SEED} count ${vs.length} input-sha256 ${vectorDigest(vs)}`,
    "# V index result price publish_time advanced stored_price0 stored_price1 stored_price2 stored_time0 stored_time1 stored_time2 soft_stale_matured",
  ];
  writeFileSync(OUT, `${[...header, ...lines].join("\n")}\n`);
  console.log(`${lines.length} answers written to ${path.relative(ROOT, OUT)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
