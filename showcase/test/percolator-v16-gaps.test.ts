// Bankruptcies on real state (every state made by instructions, none written into the accounts): a portfolio at its
// initial margin left uncranked while the marks run against it, on a market whose B chunks and bankrupt-close steps are
// small and with little or no insurance, then cranked, resolved, closed out and closed by CloseSlab. What each seed is
// asserted to reach, in both VMs' state (every account is compared after each transaction): the market resolved;
// portfolio 0 left with negative PnL and no capital (an uncovered loss) on the seeds `UNCOVERED` names, liquidated
// before its loss passed its capital on the others; the market closed by CloseSlab on all but seed 3 (its wind-down
// stops on a portfolio it cannot close, alike in both). The test was written to reach multi-step closes, AdvanceClose,
// B chunks and a crank-declared Recovery: it does not. The tallies printed for them (close ledgers opened and
// advanced, B-index changes, declarations) are exploratory and not asserted; in every run so far all were 0
// (TESTING.md, "Paths driven on purpose", says why). Against the
// reference: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so, the Rust build of those commits, not a deployed
// program. Every transaction is compared whole.
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { HAVE_PORT, HAVE_REFERENCE } from "./percolator-v16-helpers.js";
import { SEED } from "./percolator-v16-world.js";
import {
  CRANK_MARKET,
  crankOf,
  crankWorld,
  effectivePrice,
  i128At,
  legAssets,
  marketAt,
  portfolioAt,
  position,
  pushMark,
  tradeOf,
} from "./percolator-v16-crank-world.js";
import { offsetOf } from "./percolator-v16-layout.js";
import { Reserves, adminResolve, bump, closeOut, conservation, key, openAndMove, recoveryRounds, windDown } from "./percolator-v16-terminal.js";

const SEEDS = Number(process.env.PERCOLATOR_V16_GAP_SEEDS ?? 6);
/** The seeds (by index) on which portfolio 0 is left with an uncovered loss, and those whose market CloseSlab closes. */
const UNCOVERED = new Set([0, 1, 2]);
const CLOSED = new Set([0, 1, 2, 4, 5]);

/** The crank world with B settled and bankrupt residuals booked in small chunks. */
const SMALL_CHUNKS = {
  ...CRANK_MARKET,
  market: {
    ...CRANK_MARKET.market,
    publicBChunkAtoms: 200_000_000n,
    maxBankruptCloseChunks: 1n,
    maxAccountBSettlementChunks: 1n,
    maxBankruptCloseLifetimeSlots: 400n,
  },
};

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: bankruptcies in small chunks, on real state", () => {
  for (let k = 0; k < SEEDS; k++) {
    it(`seed ${k}: a loss past the capital cranked, the market resolved and closed`, async () => {
      const seed = SEED + 5100n + BigInt(k) * 19n;
      const w = await crankWorld(seed, SMALL_CHUNKS);
      const rng = new Rng(seed);
      const r = await Reserves.create(w);
      const outcomes = new Map<string, number>();
      const broken: string[] = [];
      // Backing on some domains only, insurance on half the seeds (none: uncovered losses).
      for (const asset of [0, 1]) {
        const t = tradeOf(w, 0, 1 + rng.int(3), asset, (rng.chance(50) ? 1n : -1n) * BigInt(35 + rng.int(10)) * 1_000_000_000n);
        bump(outcomes, `leveraged trade ${key(await w.d.send(`gap leverage ${asset}`, t.payer, [t.ix]))}`);
      }
      await r.fund(rng, { insurance: k % 2 === 0 ? 0n : 2_000_000_000n, expiry: w.d.slot + 1_000_000n, domains: [rng.int(6), rng.int(6)] });
      await openAndMove(w, rng, "gaps", 2);
      // Portfolio 0 near its initial margin on assets 0 and 1 (the counterparties 1 to 3), then left uncranked while
      // both managed marks run against it and the others are cranked: a loss well past its capital.
      const steer = 25 + rng.int(40);
      for (let s = 0; s < steer; s++) {
        w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
        w.refreshOracles(rng);
        for (const a of [0, 1]) {
          const q = position(w, w.portfolios[0]!, a);
          if (q !== 0n) bump(outcomes, `push ${key(await pushMark(w, a, (effectivePrice(w, a) * (q > 0n ? 9_900n : 10_100n)) / 10_000n, `gap steer ${s}`))}`);
        }
        for (let kk = 1; kk < 4; kk++) {
          const c = crankOf(w, kk, legAssets(w, w.portfolios[kk]!));
          bump(outcomes, `steer crank ${key(await w.d.send(`gap steer crank ${s} ${kk}`, c.payer, [c.ix]))}`);
        }
      }
      const closeActive = (p: string) => w.d.data(p as never)[portfolioAt("close_progress") + offsetOf("CloseProgressLedger", "active")] === 1;
      const tally = { declared: 0, closeLedgers: 0, advanced: 0, bChunks: 0 };
      for (let s = 0; s < 120 && w.d.data(w.m.market)[marketAt.group("mode")] === 0; s++) {
        w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
        w.refreshOracles(rng);
        if (rng.chance(30)) {
          const i = rng.int(4);
          const t = tradeOf(w, i, (i + 1 + rng.int(3)) % 4, rng.int(3), BigInt(1 + rng.int(20_000)) * 1_000_000n * (rng.chance(50) ? 1n : -1n));
          bump(outcomes, `trade ${key(await w.d.send(`gap trade ${s}`, t.payer, [t.ix]))}`);
        }
        for (let kk = 0; kk < 4; kk++)
          for (let round = 0; round < 2; round++) {
            const p = w.portfolios[kk]!;
            const before = closeActive(p);
            const bBefore = w.d
              .data(w.m.market)
              .subarray(marketAt.engine(0, "asset.b_long_num"), marketAt.engine(0, "asset.b_long_num") + 64)
              .toString("hex");
            const c = crankOf(w, kk, legAssets(w, p));
            const got = await w.d.send(`gap crank ${s} ${kk} ${round}`, c.payer, [c.ix]);
            bump(outcomes, `crank ${key(got)}`);
            if (got !== "ok") continue;
            broken.push(...conservation(w));
            if (!before && closeActive(p)) tally.closeLedgers++;
            if (before && closeActive(p)) tally.advanced++;
            if (
              w.d
                .data(w.m.market)
                .subarray(marketAt.engine(0, "asset.b_long_num"), marketAt.engine(0, "asset.b_long_num") + 64)
                .toString("hex") !== bBefore
            )
              tally.bChunks++;
            if (w.d.data(w.m.market)[marketAt.group("mode")] === 2) {
              tally.declared++;
              break;
            }
          }
      }
      const p0 = w.d.data(w.portfolios[0]!);
      const bankrupt = i128At(p0, portfolioAt("pnl")) < 0n && p0.readBigUInt64LE(portfolioAt("capital")) === 0n;
      const mode = w.d.data(w.m.market)[marketAt.group("mode")];
      if (mode === 2) bump(outcomes, `Recovery resolved at round ${await recoveryRounds(w, rng, outcomes)}`);
      else if (mode === 0) await adminResolve(w, rng, outcomes);
      const resolved = w.d.data(w.m.market)[marketAt.group("mode")] === 1;
      let closed = false;
      if (w.d.data(w.m.market)[marketAt.group("mode")] === 1) {
        await closeOut(w, rng, outcomes, broken);
        closed = await windDown(w, rng, r, outcomes, broken);
      }
      console.log(
        `gaps seed ${seed}: ${JSON.stringify(tally)}; portfolio 0 left bankrupt ${bankrupt}; closed ${closed}; ${w.d.compared} compared; outcomes ${[
          ...outcomes,
        ]
          .sort()
          .map(([o, c]) => `${o} ×${c}`)
          .join(", ")}`,
      );
      expect(broken).toEqual([]);
      expect(resolved).toBe(true);
      if (k < 6) expect({ bankrupt, closed }).toEqual({ bankrupt: UNCOVERED.has(k), closed: CLOSED.has(k) });
    }, 1_800_000);
  }
});
