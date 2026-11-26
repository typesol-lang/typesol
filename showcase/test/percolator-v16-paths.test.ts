// Paths of the Percolator v16 port that the walks do not enter by chance, driven on purpose by real instructions and
// compared with the reference: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so is the Rust build of those commits, not a deployed
// program. Every transaction is compared whole (outcome, logs, inner instructions, return data, every named account).
//
// - A trade's initial-margin source lien on a counterparty-backed domain and its backing-domain fee: a portfolio whose
//   positive PnL is a source claim on the other side's domain (Fresh backing in its bucket) grows its position past
//   what its capital margins; the trade liens the claim against the bucket, under a backing-fee policy on that domain
//   (TradeNoCpi, and TradeCpi with the matcher's backing-fee cap), and the bucket's utilization fee then accrues to its
//   provider, who withdraws it (WithdrawBackingBucketEarnings).
//
// Agreement alone would also pass where both refuse early, so the test asserts each path's own evidence, read from both
// VMs' state: the counterparty-backed liens grow from none and the backing-domain fee reaches the bucket's earnings and
// the domain's insurance budget (all eight trades succeed); TradeCpi is refused at the cap below the policy
// (Unauthorized) and filled at it; the flat portfolio's first crank succeeds and leaves no lien; and from the same state
// the market resolves and the close-out leaves no lien, in the portfolio or the bucket.
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { CRANK_MARKET, crankOf, crankWorld, legAssets, position, pushMark, tradeOf } from "./percolator-v16-crank-world.js";
import { HAVE_PORT, HAVE_REFERENCE, err, ix, marketAt, portfolioAt } from "./percolator-v16-helpers.js";
import { offsetOf, sizeOf } from "./percolator-v16-layout.js";
import { Reserves, adminResolve, closeOut, engineField } from "./percolator-v16-terminal.js";
import { World } from "./percolator-v16-world.js";
import { type Trader, lpMatcher, tradeCpi } from "./percolator-v16-batch-world.js";

const SEED = 9_100n;
/** PercolatorError::Unauthorized (src/v16_program.rs `mod error`). */
const UNAUTHORIZED = 8;

/** The u128 at `at` of an account's data in the reference. */
function u128(w: World, account: string, at: number): bigint {
  const b = w.d.data(account as never);
  return b.readBigUInt64LE(at) | (b.readBigUInt64LE(at + 8) << 64n);
}

/**
 * The u128 at `at` of an account in both VMs: the reference's and the port's must be equal (each compared transaction
 * already requires it of every account it names; this reads the evidence a test asserts from both binaries' state).
 * A missing account reads as 0.
 */
function both(w: World, account: string, at: number): bigint {
  const [a, b] = w.d.vms.map((vm) => {
    const acct = vm.getAccount(account as never);
    if (!acct.exists) return 0n;
    const d = Buffer.from(acct.data);
    return d.readBigUInt64LE(at) | (d.readBigUInt64LE(at + 8) << 64n);
  });
  expect(b, `${account}@${at}: the port's value (left) is the reference's`).toBe(a);
  return a!;
}

/** A field of portfolio `p`'s 32 source domains, summed, in both VMs. */
function sourceDomains(w: World, p: string, field: string): bigint {
  let sum = 0n;
  for (let i = 0; i < 32; i++)
    sum += both(w, p, portfolioAt("source_domains") + i * sizeOf("PortfolioSourceDomain") + offsetOf("PortfolioSourceDomain", field));
  return sum;
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: paths driven on purpose", () => {
  it("a trade's counterparty-backed source lien, its backing-domain fee, the provider's earnings withdrawn", async () => {
    const w = await crankWorld(SEED, { ...CRANK_MARKET, deposit: 2_000_000_000n });
    const rng = new Rng(SEED);
    const r = await Reserves.create(w);
    // A backing-fee policy on both domains of asset 0 (25 bps, a fifth to the insurance), then insurance and Fresh
    // backing everywhere.
    for (const domain of [0, 1]) {
      const ins = w.roleAuthority(0, "insurance_authority");
      const b = w.seq(0, "backingFee");
      const e = w.epoch(0);
      await w.d.ok(`backing fee policy ${domain}`, ins, [ix.backingFeePolicy(w.m, ins, domain, w.marketId(0), 25, 2_000, (b > e ? b : e) + 1n, e)]);
    }
    await r.fund(rng);
    // Portfolio 0 long, 1 short, near portfolio 0's initial margin; the mark then rises a few percent and both are
    // cranked: portfolio 0's gain is a source claim on asset 0's short domain.
    const open = tradeOf(w, 0, 1, 0, 15_000_000_000n);
    await w.d.ok("open near the margin", open.payer, [open.ix]);
    for (let s = 0; s < 6; s++) {
      w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
      await pushMark(w, 0, (w.d.data(w.m.market).readBigUInt64LE(marketAt.engine(0, "asset.effective_price")) * 10_050n) / 10_000n, `push ${s}`);
      for (const k of [0, 1]) {
        const c = crankOf(w, k, legAssets(w, w.portfolios[k]!));
        await w.d.send(`crank ${s} ${k}`, c.payer, [c.ix]);
      }
    }
    const pnl = u128(w, w.portfolios[0]!, portfolioAt("pnl"));
    const p0 = w.portfolios[0]!;
    // The evidence of the paths below, before the trades that should take them: portfolio 0's counterparty-backed
    // source liens, the short domain's (domain 1) bucket earnings and insurance budget.
    const liensBefore = sourceDomains(w, p0, "source_claim_counterparty_liened_num");
    const budget = () => both(w, w.m.market, marketAt.engine(0, "insurance_domain_budget_short"));
    const earned = () => both(w, w.m.market, marketAt.engine(0, "backing_short.utilization_fee_earnings"));
    const [budgetBefore, earnedBefore] = [budget(), earned()];
    // Growing the position by steps: each needs initial margin the capital alone does not give.
    const outcomes: string[] = [];
    for (const size of [1_000_000_000n, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n, 1_000_000_000n, 500_000_000n, 500_000_000n, 250_000_000n]) {
      const t = tradeOf(w, 0, 2, 0, size);
      outcomes.push(`grow ${size}: ${await w.d.send(`grow ${size}`, t.payer, [t.ix])}`);
    }
    const liensAfter = sourceDomains(w, p0, "source_claim_counterparty_liened_num");
    const [budgetAfter, earnedAfter] = [budget(), earned()];
    // The grows succeeded and took the paths: each liened the claim against the counterparty's bucket (the
    // counterparty-backed liens grew from none) and paid the backing-domain fee, its provider part to the bucket's
    // earnings and its insurance part (a fifth) to the domain's insurance budget.
    expect(outcomes.filter((o) => o.endsWith(": ok")).length, outcomes.join("; ")).toBe(8);
    expect(liensBefore).toBe(0n);
    expect(liensAfter).toBeGreaterThan(0n);
    expect(earnedAfter).toBeGreaterThan(earnedBefore);
    expect(budgetAfter).toBeGreaterThan(budgetBefore);
    // The same through TradeCpi: the taker's signed backing cap (below the policy's 25 bps, then at it) and the LP's
    // matcher's cap.
    const lp: Trader = { owner: w.owners[3]!, portfolio: w.portfolios[3]!, source: w.sources[3]! };
    const taker: Trader = { owner: w.owners[0]!, portfolio: w.portfolios[0]!, source: w.sources[0]! };
    const mt = await lpMatcher(w.d, w.m, lp, "auth", { backingCap: 25 });
    for (const cap of [24, 25])
      outcomes.push(
        `TradeCpi cap ${cap}: ${await w.d.send(`TradeCpi cap ${cap}`, taker.owner, [tradeCpi(w.d, w.m, taker, lp, mt, { asset: 0, size: 250_000_000n, cap, marketId: w.marketId(0) })])}`,
      );
    // The taker's cap below the policy's 25 bps is refused (Unauthorized), at it filled.
    expect(outcomes.slice(-2)).toEqual([`TradeCpi cap 24: ${err(UNAUTHORIZED)}`, "TradeCpi cap 25: ok"]);
    const earnings = [0, 1].map((d) => engineField(w, 0, `${d === 0 ? "backing_long" : "backing_short"}.utilization_fee_earnings`));
    console.log(
      `source lien: pnl ${BigInt.asIntN(128, pnl)}, position ${position(w, w.portfolios[0]!, 0)}; ${outcomes.join("; ")}; earnings ${earnings.join(", ")}`,
    );
    // The provider withdraws half its earnings and one atom (deterministic: the earnings come from the fees above).
    const [signer, withdraw] = r.withdrawEarnings(rng, 1, true);
    await w.d.ok("WithdrawBackingBucketEarnings", signer, withdraw);
    expect(earnings[1]).toBeGreaterThan(0n);
    w.take();
    // Then (a) portfolio 0 closes every leg while its liens stand, and cranks of the flat portfolio release them
    // (ReleaseSourceLiens); (b) from the same state, the market resolved by its authority and every portfolio closed
    // out: a liened source domain's release at the resolved close.
    const liensHeld = sourceDomains(w, p0, "source_claim_liened_num");
    const after: string[] = [];
    for (let round = 0; round < 3; round++) {
      const q = position(w, w.portfolios[0]!, 0);
      if (q === 0n) break;
      for (const k of [1, 2, 3]) {
        const o = position(w, w.portfolios[k]!, 0);
        if (o === 0n || o > 0n === q > 0n) continue;
        const size = (o < 0n ? -o : o) < (q < 0n ? -q : q) ? o : -q;
        const t = tradeOf(w, 0, k, 0, size);
        after.push(`close against ${k}: ${await w.d.send(`close against ${k}`, t.payer, [t.ix])}`);
        break;
      }
    }
    for (let s = 0; s < 4; s++) {
      w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
      const c = crankOf(w, 0, []);
      after.push(`flat crank ${s}: ${await w.d.send(`flat crank ${s}`, c.payer, [c.ix])}`);
    }
    const liensFlat = sourceDomains(w, p0, "source_claim_liened_num");
    // (a) The position closed, the flat portfolio's first crank succeeded and released every lien (ReleaseSourceLiens).
    expect(position(w, p0, 0)).toBe(0n);
    expect(after.find((o) => o.startsWith("flat crank 0"))).toBe("flat crank 0: ok");
    expect(liensHeld).toBeGreaterThan(0n);
    expect(liensFlat).toBe(0n);
    w.restore();
    expect(sourceDomains(w, p0, "source_claim_liened_num")).toBe(liensHeld);
    const bucketLiened = () => both(w, w.m.market, marketAt.engine(0, "backing_short.valid_liened_backing_num"));
    expect(bucketLiened()).toBeGreaterThan(0n);
    const outcomes2 = new Map<string, number>();
    const broken: string[] = [];
    // (b) The market resolved, every portfolio closed out: the liened domain released at the resolved close.
    expect(await adminResolve(w, rng, outcomes2)).toBe(true);
    await closeOut(w, rng, outcomes2, broken);
    expect(sourceDomains(w, p0, "source_claim_liened_num")).toBe(0n);
    expect(bucketLiened()).toBe(0n);
    console.log(`after the liens: ${after.join("; ")}; resolved: ${[...outcomes2].map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    expect(broken).toEqual([]);
  }, 900_000);
});
