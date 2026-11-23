// The external oracle reader of the Percolator v16 port (showcase/mainnet/percolator-v16/external.ts) against the
// original's own code: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog, Apache-2.0.
//
// ConfigureHybridOracle (percolator-v16-hybrid.test.ts) compares the reader against the reference binary, but always
// on a profile whose legs hold no observation yet. What only the crank reaches (not ported yet) is compared here, on
// vectors: `read_external_price_e6_profile` on a profile whose legs already hold observations (an older publish time
// refused as stale, the same time with another price refused as invalid, the same observation again not advancing,
// newer legs stored), on Manual and managed profiles, on short account lists, and every reader branch again with the
// seeded mutations of percolator-v16-oracles.ts; and `profile_hybrid_soft_stale_matured`. The expected answers are the
// original's, from its source compiled for the host (scripts/percolator-v16-reference/oracle-vectors.ts, recorded in
// fixtures/percolator-v16-oracle-vectors.txt with the digest of the inputs), not from the SBF reference binary. The port
// runs the same inputs on chain in LiteSVM, through a test program (fixtures/percolator-v16-external.ts).
//
// Named cases follow the author's tests of the crank's reading (tests/invariants/cu/inv_020_authenticated_clock_slot_and_
// oracle_provenance.rs): `v16_program_crank_oracle_same_publish_time_price_change_rejects` (the same publish time with
// another price: OracleInvalid, nothing stored) and `v16_program_switchboard_stale_selected_result_cannot_refresh_crank_
// liveness` (an observation not newer than the stored one does not advance).
import { type Address, type KeyPairSigner, lamports } from "@solana/kit";
import { FailedTransactionMetadata, type LiteSVM } from "litesvm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { send } from "../../test/harness.js";
import { Rng } from "./fuzz-rng.js";
import { countVectors, deployV16, Diff, HAVE_PORT, HAVE_REFERENCE, instruction, outcome } from "./percolator-v16-helpers.js";
import { type OracleAccount, type Vector, keyBytes, legAt, profileBytes, storedLegs, vectorDigest, vectors } from "./percolator-v16-oracles.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/percolator-v16-external.ts", import.meta.url));
const ANSWERS = fileURLToPath(new URL("./fixtures/percolator-v16-oracle-vectors.txt", import.meta.url));

/** The port's result code (external.ts R_*) as the original's `{:?}` of its ProgramError. */
function codeName(code: bigint): string {
  if (code === 0n) return "ok";
  if (code === 1n) return "InvalidAccountData";
  if (code === 2n) return "IllegalOwner";
  if (code === 3n) return "NotEnoughAccountKeys";
  if (code === 4n) return "AccountBorrowFailed";
  if (code >= 100n) return `Custom(${code - 100n})`;
  return `code ${code}`;
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: the external oracle reader against the original's code on vectors", () => {
  let vm: LiteSVM;
  let program: Address;
  let payer: KeyPairSigner;
  let out: Address;
  let profile: Address;
  let d: Diff;

  beforeAll(async () => {
    d = await Diff.create({ port: "reference" });
    const deployed = await deployV16(FIXTURE);
    vm = deployed.svm;
    program = deployed.programId;
    payer = await d.funded();
    vm.airdrop(payer.address, lamports(1_000_000_000_000n));
    out = await d.address();
    profile = await d.address();
  }, 120_000);

  function put(at: Address, owner: Address, data: Buffer): void {
    vm.setAccount({
      address: at,
      data: new Uint8Array(data),
      executable: false,
      lamports: lamports(1_000_000_000n),
      programAddress: owner,
      space: BigInt(data.length),
    });
  }

  /** The port's answer to one vector: the line the original's would be. */
  async function run(v: Vector): Promise<string> {
    put(out, program, Buffer.alloc(26));
    put(profile, program, v.profile);
    for (const a of v.accounts) put(a.key, a.owner, a.data);
    const data = Buffer.alloc(16);
    data.writeBigInt64LE(v.nowTs, 0);
    data.writeBigUInt64LE(v.nowSlot, 8);
    const i = instruction(data, [{ address: out, writable: true }, { address: profile, writable: true }, ...v.accounts.map((a) => ({ address: a.key }))]);
    const res = await send(vm, payer, [{ ...i, programAddress: program }]);
    if (res instanceof FailedTransactionMetadata) throw new Error(`the reader failed: ${outcome(res)}\n${res.meta().logs().join("\n")}`);
    const bytes = (a: Address) => {
      const acct = vm.getAccount(a);
      if (!acct.exists) throw new Error(`${a} missing`);
      return Buffer.from(acct.data);
    };
    const o = bytes(out);
    const code = o.readBigUInt64LE(0);
    const head = code === 0n ? `ok ${o.readBigUInt64LE(8)} ${o.readBigInt64LE(16)} ${o[24]}` : `${codeName(code)} 0 0 0`;
    return `${head} ${storedLegs(bytes(profile)).join(" ")} ${o[25]}`;
  }

  it("read_external_price_e6_profile and profile_hybrid_soft_stale_matured: the recorded vectors, answer for answer", async () => {
    const lines = readFileSync(ANSWERS, "utf8").split("\n");
    const meta = lines.find((l) => l.startsWith("# seed "))!.split(" ");
    const seed = BigInt(meta[2]!);
    const count = Number(meta[4]!);
    const vs = vectors(seed, count);
    // The inputs the original answered are the ones regenerated here.
    expect(vectorDigest(vs)).toBe(meta[6]);
    const answers = lines.filter((l) => l.startsWith("V ")).map((l) => l.split(" ").slice(2).join(" "));
    expect(answers.length).toBe(count);
    const tally: Record<string, number> = {};
    let advanced = 0;
    let withStored = 0;
    for (let i = 0; i < count; i++) {
      const got = await run(vs[i]!);
      expect(got, `vector ${i}: ${vs[i]!.accounts.map((a) => a.what).join(", ")}`).toBe(answers[i]);
      countVectors(1);
      const result = answers[i]!.split(" ")[0]!;
      tally[result] = (tally[result] ?? 0) + 1;
      if (result === "ok" && answers[i]!.split(" ")[3] === "1") advanced++;
      if (storedLegs(vs[i]!.profile).some((x) => x !== 0n)) withStored++;
    }
    console.log(
      `external reader: ${count} vectors equal to the original's answers (${withStored} with stored legs; ${advanced} advanced):`,
      JSON.stringify(tally),
    );
    expect(tally.ok ?? 0).toBeGreaterThan(count / 10);
  }, 600_000);

  it("named cases: an observation not newer does not advance; the same publish time with another price is refused", async () => {
    const rng = new Rng(77n);
    const now = 1_770_000_000n;
    const leg = legAt(rng, "switchboard", 2_000_000n, now - 5n);
    const base = {
      mode: 1,
      count: 1,
      flags: 0,
      invert: 0,
      unitScale: 0n,
      confBps: 0n,
      maxStaleness: 60n,
      softStale: 10n,
      lastGoodSlot: 100n,
      feeds: [leg.feed],
    };
    const v = (prices: bigint[], times: bigint[], accounts: OracleAccount[] = [leg]): Vector => ({
      nowTs: now,
      nowSlot: 111n,
      profile: profileBytes({ ...base, prices, times }),
      accounts,
    });
    // Empty legs: advances and stores; soft-stale matured (111 − 100 > 10).
    expect(await run(v([], []))).toBe(`ok 2000000 ${now - 5n} 1 2000000 0 0 ${now - 5n} 0 0 1`);
    // The same observation stored: not advanced.
    expect(await run(v([2_000_000n], [now - 5n]))).toBe(`ok 2000000 ${now - 5n} 0 2000000 0 0 ${now - 5n} 0 0 1`);
    // The same publish time with another stored price: OracleInvalid (26), nothing stored.
    expect(await run(v([1_999_999n], [now - 5n]))).toBe(`Custom(26) 0 0 0 1999999 0 0 ${now - 5n} 0 0 1`);
    // A newer stored observation: OracleStale (27).
    expect(await run(v([2_000_000n], [now - 4n]))).toBe(`Custom(27) 0 0 0 2000000 0 0 ${now - 4n} 0 0 1`);
    // An older stored one: advanced to the new.
    expect(await run(v([5n], [now - 6n]))).toBe(`ok 2000000 ${now - 5n} 1 2000000 0 0 ${now - 5n} 0 0 1`);
    // The leg's key no longer the feed (a Switchboard leg binds by key): InvalidOracleKey (29).
    expect(await run(v([], [], [{ ...leg, key: await d.address() }]))).toBe(`Custom(29) 0 0 0 0 0 0 0 0 0 1`);
    expect(keyBytes(leg.key)).toEqual(Buffer.from(leg.feed));
  });
});
