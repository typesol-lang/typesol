// InitMarket, InitPortfolio, Deposit and ClosePortfolio of the Percolator v16 port (showcase/mainnet/percolator-v16)
// against the reference: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so is the Rust build of those commits, not a
// deployed program. Every transaction goes to both and is compared whole (percolator-v16-helpers.ts `Diff`): outcome,
// logs, inner instructions, return data, every named account's lamports, owner, length and bytes; the port must use
// fewer compute units on each success. This file covers the success paths across the argument space; the refusals
// are in percolator-v16-setup-refusals.test.ts.
import { type Address, type KeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { Diff, HAVE_PORT, HAVE_REFERENCE, type Market, PORTFOLIO_LEN, defaultInitArgs, err, ix } from "./percolator-v16-helpers.js";

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: market and portfolio set-up, success paths", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });

  it("InitMarket: capacities 1 to 14 and above the configured count, the author's default arguments", async () => {
    for (const [capacity, assets] of [
      [1, 1],
      [2, 1],
      [2, 2],
      [3, 2],
      [5, 5],
      [14, 14],
      [20, 3],
    ] as const) {
      const m = await d.newMarket({ capacity });
      await d.ok(`InitMarket capacity ${capacity} assets ${assets}`, m.admin, [ix.initMarket(m, defaultInitArgs({ maxPortfolioAssets: assets }))]);
    }
  });

  it("InitMarket: risk parameters that need the exact solvency envelope", async () => {
    const cases: [string, Parameters<typeof defaultInitArgs>[0]][] = [
      ["maintenance 5%, no fees", { maintenanceMarginBps: 500n, initialMarginBps: 1000n, maxPriceMoveBpsPerSlot: 10n, maxAccrualDtSlots: 4n }],
      [
        "maintenance 10%, liquidation fee 50 bps capped",
        {
          maintenanceMarginBps: 1000n,
          initialMarginBps: 2000n,
          maxPriceMoveBpsPerSlot: 20n,
          maxAccrualDtSlots: 4n,
          liquidationFeeBps: 50n,
          liquidationFeeCap: 1_000_000n,
          minLiquidationAbs: 10n,
        },
      ],
      [
        "funding 5 e9/slot",
        {
          maintenanceMarginBps: 1000n,
          initialMarginBps: 2000n,
          maxPriceMoveBpsPerSlot: 10n,
          maxAccrualDtSlots: 4n,
          maxAbsFundingE9PerSlot: 5n,
          minFundingLifetimeSlots: 100n,
        },
      ],
      [
        "min mm floor 1e6",
        {
          maintenanceMarginBps: 1000n,
          initialMarginBps: 2000n,
          minNonzeroMmReq: 1_000_000n,
          minNonzeroImReq: 2_000_000n,
          maxPriceMoveBpsPerSlot: 10n,
          maxAccrualDtSlots: 4n,
        },
      ],
      ["maintenance 0", { maintenanceMarginBps: 0n, initialMarginBps: 100n, maxPriceMoveBpsPerSlot: 1n, maxAccrualDtSlots: 1n }],
      ["fees at the cap", { maxTradingFeeBps: 10_000n, tradeFeeBaseBps: 10_000n, maintenanceFeePerSlot: 1_000_000_000_000_000_000_000_000_000_000_000_000n }],
    ];
    for (const [label, args] of cases) {
      const m = await d.newMarket({ capacity: 2 });
      await d.send(`InitMarket ${label}`, m.admin, [ix.initMarket(m, defaultInitArgs({ maxPortfolioAssets: 2, ...args }))]);
    }
  });

  it("InitPortfolio, Deposit, ClosePortfolio: a portfolio's life", async () => {
    const m = await d.market({ capacity: 2, args: { maxPortfolioAssets: 2 } });
    for (const len of [PORTFOLIO_LEN, 0, 100, 9547, 9555]) {
      const { owner, portfolio } = await d.newPortfolio(len);
      await d.ok(`InitPortfolio from ${len} bytes`, owner, [ix.initPortfolio(m, owner, portfolio)]);
    }
    const { owner, portfolio } = await d.newPortfolio();
    await d.ok("InitPortfolio", owner, [ix.initPortfolio(m, owner, portfolio)]);
    const id = d.portfolioId(portfolio);
    const source = await d.tokenAccount(m.mint, owner.address, 1_000_000n);
    await d.ok("Deposit 0", owner, [ix.deposit(m, owner, portfolio, source, id, 0n, 0n)]);
    await d.ok("Deposit 1", owner, [ix.deposit(m, owner, portfolio, source, id, 1n, 1n)]);
    await d.ok("Deposit 999,999 (all)", owner, [ix.deposit(m, owner, portfolio, source, id, 2n, 999_999n)]);
    await d.fails("ClosePortfolio with capital", owner, [ix.closePortfolio(m, owner, portfolio, id, 3n, 0n)], err(21));
    const { owner: o2, portfolio: p2 } = await d.newPortfolio();
    await d.ok("InitPortfolio 2", o2, [ix.initPortfolio(m, o2, p2)]);
    const id2 = d.portfolioId(p2);
    await d.ok("ClosePortfolio", o2, [ix.closePortfolio(m, o2, p2, id2, 0n, 0n)]);
    expect(d.reference.getAccount(p2).exists).toBe(false);
  });
});

export type { Address, KeyPairSigner, Market };
