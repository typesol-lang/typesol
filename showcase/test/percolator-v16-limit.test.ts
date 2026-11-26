// Transactions the reference runs past the 1,400,000 compute-unit limit and the Percolator v16 port completes. The
// reference is Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator,
// Apache-2.0: test/programs/percolator_v16.so, the Rust build of those commits, not a deployed program. Where the
// reference runs out and the port does not, `Diff.send` runs the transaction again in a LiteSVM of the reference whose
// compute budget is raised to 20,000,000 units (the same program, accounts, Clock and 256 KiB heap) and requires the
// port's outcome, logs, inner instructions, return data and every named account to equal that run's. The families:
//
// - the author's `inv_078…force_close_liveness_survives_14_stale_leg_grief_via_precrank` (A): a one-shot
//   ForceCloseAbandonedAsset of two portfolios with 14 legs each, the asset shut down and the Clock moved, which the
//   author's test expects to exceed the limit;
// - a crank of a 14-leg portfolio with 14 hints after the prices moved (the crank test's maximum shape);
// - a batch growing 14 legs at once (percolator-v16-batch.test.ts).
import { describe, expect, it } from "vitest";
import { CRANK_MARKET, legAssets, pushMark, tradeOf } from "./percolator-v16-crank-world.js";
import { HAVE_PORT, HAVE_REFERENCE, ix, marketAt } from "./percolator-v16-helpers.js";
import { World } from "./percolator-v16-world.js";

const SEED = 7_800n;

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: past the reference's compute-unit limit", () => {
  it("inv_078 (A): a one-shot force-close of two 14-leg portfolios, then the pre-crank path (B)", async () => {
    for (const path of ["one-shot", "pre-crank"] as const) {
      const w = await World.build(SEED, {
        capacity: 14,
        portfolios: 2,
        deposit: 10_000_000_000n,
        mark: 1_000_000n,
        market: { ...CRANK_MARKET.market, maxPortfolioAssets: 14 },
      });
      const a = w.marketAuthority();
      await w.d.ok("ConfigurePermissionlessResolve 100, delay 5", a, [
        ix.permissionlessResolve(w.m, a, w.u64At(marketAt.group("next_market_id")), 100n, 5n, w.seq(0, "permissionlessResolve") + 1n, w.epoch(0)),
      ]);
      for (let asset = 0; asset < 14; asset++) {
        const t = tradeOf(w, 0, 1, asset, 10_000_000n);
        await w.d.ok(`leg ${asset}`, t.payer, [t.ix]);
      }
      w.d.setClock(w.d.slot + 4n, w.d.unixTimestamp + 4n);
      await w.d.ok("shutdown 13", a, [ix.assetLifecycle(w.m, a, { action: 3, asset: 13, marketId: w.marketId(13), epoch: w.epoch(13), nowSlot: 1n })]);
      w.d.setClock(w.d.slot + 6n, w.d.unixTimestamp + 6n);
      if (path === "pre-crank") for (const k of [0, 1]) await w.d.send(`refresh ${k}`, w.stranger, [ix.crank(w.m, w.stranger, w.portfolios[k]!, 0n, [], [])]);
      const before = w.d.raised.length;
      const got = await w.d.send(`${path} force-close`, w.stranger, [
        ix.forceCloseAbandoned(w.m, w.stranger, w.portfolios[0]!, w.portfolios[1]!, 13, 10_000_000n),
      ]);
      console.log(
        `inv_078 ${path}: ${got}; ${w.d.raised.length > before ? `the reference past its limit (${w.d.raised.at(-1)!.reference} under the raised budget), the port ${w.d.raised.at(-1)!.port}` : `reference ${w.d.cu[`${path} force-close`]![0]}, port ${w.d.cu[`${path} force-close`]![1]}`}; legs left ${legAssets(w, w.portfolios[0]!).length} / ${legAssets(w, w.portfolios[1]!).length}`,
      );
      expect(got).toBe("ok");
      // The one-shot runs the reference past its limit (the author's test asserts that); the pre-crank path does not.
      expect(w.d.raised.length - before).toBe(path === "one-shot" ? 1 : 0);
    }
  }, 900_000);

  it("a crank of 14 legs with 14 hints after the prices moved", async () => {
    const w = await World.build(SEED + 1n, {
      capacity: 14,
      portfolios: 4,
      deposit: 10_000_000_000n,
      mark: 1_000_000n,
      market: { ...CRANK_MARKET.market, maxPortfolioAssets: 14 },
    });
    for (let asset = 0; asset < 14; asset++) {
      const t = tradeOf(w, 0, 1 + (asset % 3), asset, (asset % 2 ? -1n : 1n) * 5_000_000_000n);
      await w.d.ok(`leg ${asset}`, t.payer, [t.ix]);
    }
    const all = Array.from({ length: 14 }, (_, asset) => ({ asset, accounts: 0 }));
    // As the crank test's maximum shape: marks pushed every fifth slot, portfolio 0 cranked twice a slot with four
    // hints and the others with five, and with all 14 hints once four slots of moves have passed.
    for (let s = 0; s < 10; s++) {
      w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
      if (s % 5 === 0) for (let asset = 0; asset < 14; asset++) await pushMark(w, asset, asset % 2 ? 1_200_000n : 800_000n, `push ${asset}`);
      for (const k of [0, 0, 1, 2, 3]) {
        const hints = k === 0 && s % 5 === 4 ? all : all.slice((s * 3) % 10, ((s * 3) % 10) + (k === 0 ? 4 : 5));
        await w.d.send(`slot ${s} portfolio ${k}, ${hints.length} hints`, w.stranger, [ix.crank(w.m, w.stranger, w.portfolios[k]!, 0n, hints, [])]);
      }
    }
    console.log(`14-hint cranks past the reference's limit: ${w.d.raised.map((r) => `${r.label} (${r.reference} / ${r.port})`).join("; ")}`);
    expect(w.d.raised.length).toBeGreaterThan(0);
  }, 900_000);
});
