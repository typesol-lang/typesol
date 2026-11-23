// The insurance and backing-bucket instructions of the Percolator v16 port (showcase/mainnet/percolator-v16/reserves.ts:
// TopUpInsurance, TopUpInsuranceDomain, TopUpBackingBucket, WithdrawBackingBucket, WithdrawBackingBucketEarnings,
// WithdrawInsuranceAsset) against the reference: Percolator v16 at commit 7b110913 (engine 5e3af07),
// aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so, the Rust build of
// those commits, not a deployed program. Every transaction is compared whole (outcome, logs, inner instructions, return
// data, every named account's bytes; fewer compute units on success).
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { HAVE_PORT, HAVE_REFERENCE, ix } from "./percolator-v16-helpers.js";
import { SEED } from "./percolator-v16-world.js";
import { crankWorld, legAssets, marketAt } from "./percolator-v16-crank-world.js";
import { Reserves, bump, conservation, key, openAndMove, sweep } from "./percolator-v16-terminal.js";

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: insurance and backing buckets", () => {
  it("top-ups, withdrawals and ledgers on a Live market with legs and moving prices", async () => {
    const seed = SEED + 3100n;
    const w = await crankWorld(seed);
    const rng = new Rng(seed);
    const r = await Reserves.create(w);
    const outcomes = new Map<string, number>();
    const broken: string[] = [];
    await r.policies(rng);
    for (let n = 0; n < 60; n++) {
      const got = await r.random(rng, n);
      bump(outcomes, `${r.lastName} ${key(got)}`);
    }
    await openAndMove(w, rng, "reserves", 8);
    for (let n = 60; n < 260; n++) {
      if (rng.chance(25)) {
        w.d.setClock(w.d.slot + BigInt(1 + rng.int(rng.chance(10) ? 400 : 3)), w.d.unixTimestamp + 1n);
        w.refreshOracles(rng);
        await r.traffic(rng, n);
      }
      const got = await r.random(rng, n);
      bump(outcomes, `${r.lastName} ${key(got)}`);
      broken.push(...conservation(w));
    }
    console.log(
      `reserves seed ${seed}: ${w.d.compared} compared; legs ${w.portfolios.reduce((t, p) => t + legAssets(w, p).length, 0)}; outcomes ${[...outcomes]
        .sort()
        .map(([o, c]) => `${o} ×${c}`)
        .join(", ")}`,
    );
    expect(broken).toEqual([]);
    for (const name of ["TopUpInsurance", "TopUpInsuranceDomain", "TopUpBackingBucket", "WithdrawBackingBucket", "WithdrawInsuranceAsset"])
      expect(outcomes.get(`${name} ok`) ?? 0, name).toBeGreaterThan(0);
  }, 1_800_000);

  it("every account position and data window of each instruction", async () => {
    const seed = SEED + 3200n;
    const w = await crankWorld(seed);
    const rng = new Rng(seed);
    const r = await Reserves.create(w);
    await r.policies(rng);
    await r.fund(rng);
    await openAndMove(w, rng, "reserves sweep", 4);
    const tally = { sent: 0, ok: 0 };
    for (const t of r.successes()) await sweep(w, rng, t.name, t.payer, t.ix, tally);
    console.log(`reserve sweeps: ${tally.sent} transactions compared, ${tally.ok} succeeded in both`);
    expect(tally.ok).toBeGreaterThan(20);
  }, 1_800_000);
});

void ix;
void marketAt;
