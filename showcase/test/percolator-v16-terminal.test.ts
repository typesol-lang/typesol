// The terminal instructions of the Percolator v16 port (showcase/mainnet/percolator-v16/terminal.ts: CloseSlab,
// ClaimResolvedPayoutTopup, SwapSecondaryForPrimary, ForceCloseAbandonedAsset) against the reference: Percolator v16 at
// commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0;
// test/programs/percolator_v16.so, the Rust build of those commits, not a deployed program. Every transaction is
// compared whole (outcome, logs, inner instructions, return data, every named account's bytes; fewer compute units on
// success).
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { ATA_PROGRAM, HAVE_PORT, HAVE_REFERENCE, ix } from "./percolator-v16-helpers.js";
import { TOKEN, tokenAccountBytes } from "./percolator-helpers.js";
import { pda } from "../../test/harness.js";
import { SEED } from "./percolator-v16-world.js";
import { crankOf, crankWorld, marketAt, portfolioAt, position, u128At, i128At } from "./percolator-v16-crank-world.js";
import { Reserves, adminResolve, bump, claims, closeOut, conservation, key, openAndMove, sweep, windDown } from "./percolator-v16-terminal.js";

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: the terminal instructions", () => {
  for (const k of [0, 1, 2]) {
    it(`a funded market resolved, closed out and closed by CloseSlab (seed ${k})`, async () => {
      const seed = SEED + 4100n + BigInt(k) * 17n;
      const w = await crankWorld(seed);
      const rng = new Rng(seed);
      const r = await Reserves.create(w);
      const outcomes = new Map<string, number>();
      const broken: string[] = [];
      await r.policies(rng);
      await r.fund(rng);
      await openAndMove(w, rng, "terminal", 10);
      for (let n = 0; n < 40; n++) {
        if (rng.chance(30)) {
          w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
          w.refreshOracles(rng);
          await r.traffic(rng, n);
        }
        const got = await r.random(rng, n);
        bump(outcomes, `${r.lastName} ${key(got)}`);
      }
      const resolved = w.d.data(w.m.market)[marketAt.group("mode")] === 1 || (await adminResolve(w, rng, outcomes));
      expect(resolved).toBe(true);
      await claims(w, rng, outcomes, broken, "resolved");
      await closeOut(w, rng, outcomes, broken);
      await claims(w, rng, outcomes, broken, "closed out");
      const closed = await windDown(w, rng, r, outcomes, broken);
      console.log(
        `terminal seed ${seed}: closed ${closed}; ${w.d.compared} compared; outcomes ${[...outcomes]
          .sort()
          .map(([o, c]) => `${o} ×${c}`)
          .join(", ")}`,
      );
      expect(broken).toEqual([]);
      expect(closed).toBe(true);
    }, 1_800_000);
  }

  it("CloseSlab and ClaimResolvedPayoutTopup: every account position and data window", async () => {
    const seed = SEED + 4200n;
    const w = await crankWorld(seed);
    const rng = new Rng(seed);
    const r = await Reserves.create(w);
    const outcomes = new Map<string, number>();
    const broken: string[] = [];
    await r.fund(rng);
    await openAndMove(w, rng, "terminal sweep", 6);
    await adminResolve(w, rng, outcomes);
    const tally = { sent: 0, ok: 0 };
    for (const kk of [0, 1])
      await sweep(
        w,
        rng,
        `ClaimResolvedPayoutTopup ${kk}`,
        w.stranger,
        ix.claimPayoutTopup(w.m, w.owners[kk]!.address, w.portfolios[kk]!, w.sources[kk]!),
        tally,
      );
    await closeOut(w, rng, outcomes, broken);
    const a = w.marketAuthority();
    const dest = await w.d.tokenAccount(w.m.mint, a.address, 0n);
    w.accounts.push(dest, w.m.vault);
    // CloseSlab with portfolios left (refused), then after they are closed.
    await sweep(w, rng, "CloseSlab (portfolios left)", a, ix.closeSlab(w.m, a, dest, w.epoch(0), [w.m.mint]), tally);
    for (let kk = 0; kk < 4; kk++) {
      const p = w.portfolios[kk]!;
      if (w.d.reference.getAccount(p).exists && w.d.data(p).length >= 9555)
        await w.d.send(`ClosePortfolio ${kk}`, a, [ix.closePortfolio(w.m, a, p, w.d.portfolioId(p), w.d.portfolioSequence(p), w.d.positionEpoch(p))]);
    }
    await r.drain("sweep drain", outcomes);
    for (let n = 0; n < 6; n++) {
      await sweep(w, rng, `CloseSlab ${n}`, a, ix.closeSlab(w.m, a, dest, w.epoch(0), [w.m.mint]), tally);
      await w.d.send(`CloseSlab step ${n}`, a, [ix.closeSlab(w.m, a, dest, w.epoch(0), [w.m.mint])]);
      if (w.d.data(w.m.market).length === 16) break;
      await r.drain(`sweep drain ${n}`, outcomes);
      w.d.setClock(w.d.slot + 20_000n, w.d.unixTimestamp + 1n);
    }
    console.log(`terminal sweeps: ${tally.sent} transactions compared, ${tally.ok} succeeded in both; market closed ${w.d.data(w.m.market).length === 16}`);
    expect(broken).toEqual([]);
    expect(tally.ok).toBeGreaterThan(0);
  }, 1_800_000);

  it("SwapSecondaryForPrimary and CloseSlab with a second mint (the world's empty market)", async () => {
    const seed = SEED + 4300n;
    const w = await crankWorld(seed);
    const rng = new Rng(seed);
    const e = w.empty;
    const a = w.authorityOf(e);
    const secondary = w.mints[1]!;
    const tally = { sent: 0, ok: 0 };
    const epoch0 = () => w.d.data(e.market).readBigUInt64LE(marketAt.slot(0) + 424 + 16);
    // The old primary's vault must be empty: it is (the world's empty market).
    await w.d.ok("UpdateBaseUnitMints (a second mint)", a, [ix.baseUnitMints(e, a, e.mint, secondary, epoch0())]);
    const [secondaryVault] = await pda(ATA_PROGRAM, [e.vaultPda, TOKEN, secondary]);
    w.d.write(secondaryVault, TOKEN, tokenAccountBytes({ mint: secondary, owner: e.vaultPda, amount: 5_000_000n }));
    const primarySource = await w.d.tokenAccount(e.mint, a.address, 10_000_000n);
    const secondaryDest = await w.d.tokenAccount(secondary, a.address, 0n);
    const primaryDest = await w.d.tokenAccount(e.mint, a.address, 0n);
    w.accounts.push(secondaryVault, primarySource, secondaryDest, primaryDest, e.vault);
    for (const amount of [1n, 1_000n, 4_998_999n, 1n, 2n, 0n, 1n << 64n])
      await w.d.send(`SwapSecondaryForPrimary ${amount}`, a, [ix.swapSecondary(e, a, primarySource, secondaryDest, secondaryVault, amount, epoch0())]);
    await sweep(w, rng, "SwapSecondaryForPrimary", a, ix.swapSecondary(e, a, primarySource, secondaryDest, secondaryVault, 1n, epoch0()), tally);
    // Resolved and closed: both vaults swept and closed.
    await w.d.ok("ResolveMarket (empty market)", a, [ix.resolveMarket(e, a, w.d.data(e.market).readBigUInt64LE(marketAt.group("next_market_id")), epoch0())]);
    const close = ix.closeSlab(e, a, primaryDest, epoch0(), [secondaryVault, secondaryDest]);
    await sweep(w, rng, "CloseSlab (two mints)", a, close, tally);
    await w.d.ok("CloseSlab (two mints)", a, [close]);
    console.log(`second-mint sweeps: ${tally.sent} transactions compared, ${tally.ok} succeeded in both`);
    expect(w.d.data(e.market).length).toBe(16);
  }, 1_800_000);

  it("ForceCloseAbandonedAsset: a shut-down asset's legs closed in pairs, then the residue forfeited", async () => {
    const seed = SEED + 4400n;
    const w = await crankWorld(seed);
    const rng = new Rng(seed);
    const r = await Reserves.create(w);
    const outcomes = new Map<string, number>();
    const broken: string[] = [];
    await r.fund(rng);
    await openAndMove(w, rng, "force close", 6);
    const a = w.marketAuthority();
    const asset = 1 + rng.int(2);
    const shut = () => ix.assetLifecycle(w.m, a, { action: 3, asset, marketId: w.marketId(asset), epoch: w.epoch(asset), nowSlot: 1n });
    bump(outcomes, `shutdown ${key(await w.d.send("shutdown", a, [shut()]))}`);
    const tally = { sent: 0, ok: 0 };
    const holders = () => w.portfolios.map((p, i) => ({ i, q: position(w, p, asset) })).filter((x) => x.q !== 0n);
    // Before the delay (EngineLockActive), then past it.
    for (let n = 0; n < 3; n++) {
      const h = holders();
      if (h.length >= 2)
        bump(
          outcomes,
          `ForceCloseAbandonedAsset (early) ${key(await w.d.send(`early ${n}`, w.stranger, [ix.forceCloseAbandoned(w.m, w.stranger, w.portfolios[h[0]!.i]!, w.portfolios[h[1]!.i]!, asset, 1_000_000n)]))}`,
        );
      w.d.setClock(w.d.slot + 4n, w.d.unixTimestamp + 1n);
    }
    const first = holders();
    const long = first.find((x) => x.q > 0n);
    const short = first.find((x) => x.q < 0n);
    if (long && short)
      await sweep(
        w,
        rng,
        "ForceCloseAbandonedAsset",
        w.stranger,
        ix.forceCloseAbandoned(w.m, w.stranger, w.portfolios[long.i]!, w.portfolios[short.i]!, asset, 1_000_000n),
        tally,
      );
    for (let n = 0; n < 80; n++) {
      if (rng.chance(30)) w.d.setClock(w.d.slot + BigInt(1 + rng.int(6)), w.d.unixTimestamp + 1n);
      const h = holders();
      const longs = h.filter((x) => x.q > 0n);
      const shorts = h.filter((x) => x.q < 0n);
      let i = rng.int(4);
      let j = (i + 1 + rng.int(3)) % 4;
      if (longs.length && shorts.length && rng.chance(80)) {
        i = longs[rng.int(longs.length)]!.i;
        j = shorts[rng.int(shorts.length)]!.i;
      } else if (h.length && rng.chance(80)) i = h[rng.int(h.length)]!.i;
      if (i === j) j = (i + 1) % 4;
      if (rng.chance(50)) [i, j] = [j, i];
      const q = rng.pick([1n, 1_000_000n, 1_000_000_000n, 50_000_000_000n, 1n << 100n, 0n]);
      const t = ix.forceCloseAbandoned(w.m, w.stranger, w.portfolios[i]!, w.portfolios[rng.chance(97) ? j : i]!, rng.chance(95) ? asset : rng.int(4), q);
      const got = await w.d.send(`ForceCloseAbandonedAsset ${n}`, w.stranger, [t]);
      bump(outcomes, `ForceCloseAbandonedAsset ${key(got)}`);
      if (got === "ok") broken.push(...conservation(w));
      if (rng.chance(10)) {
        const got2 = await r.random(rng, 100 + n);
        bump(outcomes, `${r.lastName} (shutdown) ${key(got2)}`);
      }
      if (rng.chance(10)) {
        const c = crankOf(w, rng.int(4), []);
        bump(outcomes, `crank (shutdown) ${key(await w.d.send(`shutdown crank ${n}`, c.payer, [c.ix]))}`);
      }
    }
    console.log(
      `force close seed ${seed} asset ${asset}: ${w.d.compared} compared; sweep ${tally.sent} (${tally.ok} ok); outcomes ${[...outcomes]
        .sort()
        .map(([o, c]) => `${o} ×${c}`)
        .join(", ")}`,
    );
    expect(broken).toEqual([]);
    expect(outcomes.get("ForceCloseAbandonedAsset ok") ?? 0).toBeGreaterThan(0);
  }, 1_800_000);

  it("reserves without legs: Live withdrawals, a shut-down asset drained by the admin, the Resolved surplus, CloseSlab parked on live backing", async () => {
    const seed = SEED + 4500n;
    const w = await crankWorld(seed);
    const rng = new Rng(seed);
    const r = await Reserves.create(w);
    const outcomes = new Map<string, number>();
    const broken: string[] = [];
    const tally = { sent: 0, ok: 0 };
    const note = (name: string, got: string) => {
      bump(outcomes, `${name} ${key(got)}`);
      if (got === "ok") broken.push(...conservation(w));
    };
    await r.policies(rng);
    await r.fund(rng, { expiry: w.d.slot + 1_000_000n });
    for (let domain = 0; domain < 6; domain++) {
      const t = r.withdrawBacking(rng, domain, true);
      note("WithdrawBackingBucket (Live)", await w.d.send(`live backing ${domain}`, t[0], t[1]));
    }
    for (const asset of [0, 1, 2]) {
      const t = r.withdrawInsurance(rng, asset, true);
      note("WithdrawInsuranceAsset (Live)", await w.d.send(`live insurance ${asset}`, t[0], t[1]));
    }
    await sweep(w, rng, "WithdrawBackingBucket (Live)", ...(([p, i]) => [p, i[0]!] as const)(r.withdrawBacking(rng, 1, true)), tally);
    await sweep(w, rng, "WithdrawInsuranceAsset (Live)", ...(([p, i]) => [p, i[0]!] as const)(r.withdrawInsurance(rng, 2, true)), tally);
    // Asset 2 shut down into Recovery: empty, so after the delay the market authority may drain its reserves.
    const a = w.marketAuthority();
    note(
      "shutdown",
      await w.d.send("shutdown 2", a, [ix.assetLifecycle(w.m, a, { action: 3, asset: 2, marketId: w.marketId(2), epoch: w.epoch(2), nowSlot: 1n })]),
    );
    const adminBacking = (domain: number) =>
      ix.withdrawReserve(50, w.m, a, r.dests.get(w.roleAuthority(2, "backing_bucket_authority").address)!, {
        index: domain,
        marketId: w.marketId(2),
        epoch: w.epoch(0),
        amount: 1_000_000n,
      });
    const adminInsurance = () =>
      ix.withdrawReserve(57, w.m, a, r.dests.get(w.roleAuthority(2, "insurance_operator").address)!, {
        index: 2,
        marketId: w.marketId(2),
        epoch: w.epoch(0),
        amount: 1_000_000n,
      });
    note("admin drain before the delay", await w.d.send("admin backing early", a, [adminBacking(4)]));
    w.d.setClock(w.d.slot + 11n, w.d.unixTimestamp + 1n);
    for (const domain of [4, 5]) note("WithdrawBackingBucket (admin drain)", await w.d.send(`admin backing ${domain}`, a, [adminBacking(domain)]));
    note("WithdrawInsuranceAsset (admin drain)", await w.d.send("admin insurance", a, [adminInsurance()]));
    await sweep(w, rng, "WithdrawBackingBucket (admin drain)", a, adminBacking(5), tally);
    // Every portfolio emptied and closed by its owner, then the market resolved with its backing live.
    for (let k = 0; k < 4; k++) {
      const p = w.portfolios[k]!;
      const o = w.owners[k]!;
      await w.d.send(`sync ${k}`, w.stranger, [ix.syncMaintenanceFee(w.m, p, 0n)]);
      const capital = w.d.data(p).readBigUInt64LE(portfolioAt("capital"));
      note("Withdraw", await w.d.send(`withdraw ${k}`, o, [ix.withdraw(w.m, o, p, w.sources[k]!, w.d.portfolioId(p), w.d.portfolioSequence(p), capital)]));
      note(
        "ClosePortfolio",
        await w.d.send(`close ${k}`, o, [ix.closePortfolio(w.m, o, p, w.d.portfolioId(p), w.d.portfolioSequence(p), w.d.positionEpoch(p))]),
      );
    }
    note("ResolveMarket", await w.d.send("resolve", a, [ix.resolveMarket(w.m, a, w.u64At(marketAt.group("next_market_id")), w.epoch(0))]));
    // The surplus of a Resolved market with no portfolio: the beneficiary unsigned.
    for (let domain = 0; domain < 6; domain++) {
      const b = w.roleAuthority(domain >> 1, "backing_bucket_authority");
      const side = domain % 2 === 0 ? "backing_long" : "backing_short";
      const fresh = u128At(w.d.data(w.m.market), marketAt.engine(domain >> 1, `${side}.fresh_unliened_backing_num`)) / 1_000_000_000_000n;
      const t = ix.withdrawReserve(
        50,
        w.m,
        b.address,
        r.dests.get(b.address)!,
        { index: domain, marketId: w.marketId(domain >> 1), epoch: w.epoch(domain >> 1), amount: fresh / 3n + 1n },
        r.backingLedgers[domain],
      );
      note("WithdrawBackingBucket (Resolved surplus)", await w.d.send(`surplus ${domain}`, w.stranger, [t]));
      if (domain === 0) await sweep(w, rng, "WithdrawBackingBucket (Resolved surplus)", w.stranger, t, tally);
    }
    const dest = await w.d.tokenAccount(w.m.mint, a.address, 0n);
    w.accounts.push(dest, w.m.vault);
    await r.drain("resolved drain", outcomes);
    const close = () => ix.closeSlab(w.m, a, dest, w.epoch(0), [w.m.mint]);
    note("CloseSlab (live backing)", await w.d.send("CloseSlab live backing", a, [close()]));
    await sweep(w, rng, "CloseSlab (live backing)", a, close(), tally);
    for (let n = 0; n < 30 && w.d.data(w.m.market).length > 16; n++) {
      if (n === 3) w.d.setClock(w.d.slot + 200n, w.d.unixTimestamp + 1n);
      await r.drain(`drain ${n}`, outcomes);
      note("CloseSlab", await w.d.send(`CloseSlab ${n}`, a, [close()]));
    }
    console.log(
      `reserves without legs seed ${seed}: closed ${w.d.data(w.m.market).length === 16}; ${w.d.compared} compared; sweeps ${tally.sent} (${tally.ok} ok); outcomes ${[
        ...outcomes,
      ]
        .sort()
        .map(([o, c]) => `${o} ×${c}`)
        .join(", ")}`,
    );
    expect(broken).toEqual([]);
    expect(w.d.data(w.m.market).length).toBe(16);
  }, 1_800_000);

  for (const k of [0, 1, 2, 3, 4]) {
    it(`a bankrupt loss without insurance: haircut receipts, the Resolved crank's lapsed expiry and the payout top-ups (seed ${k})`, async () => {
      const seed = SEED + 4600n + BigInt(k) * 13n;
      const w = await crankWorld(seed);
      const rng = new Rng(seed);
      const r = await Reserves.create(w);
      const outcomes = new Map<string, number>();
      const broken: string[] = [];
      await r.fund(rng, { insurance: 0n, expiry: w.d.slot + 1_000_000n, domains: [4, 5] });
      await openAndMove(w, rng, "haircut", 48);
      const resolved = w.d.data(w.m.market)[marketAt.group("mode")] === 1 || (await adminResolve(w, rng, outcomes));
      expect(resolved).toBe(true);
      // Close out half the portfolios first (receipts at the snapshot's rate), then let the backing lapse.
      const rateOf = () => {
        const h = w.d.data(w.m.market);
        return {
          num: u128At(h, marketAt.group("resolved_payout_ledger.current_payout_rate_num")),
          den: u128At(h, marketAt.group("resolved_payout_ledger.current_payout_rate_den")),
          captured: h[marketAt.group("payout_snapshot_captured")]!,
        };
      };
      const rate = () => {
        const r = rateOf();
        return `${r.num}/${r.den} captured ${r.captured}`;
      };
      bump(
        outcomes,
        `pnl ${w.portfolios.map((p) => i128At(w.d.data(p), portfolioAt("pnl"))).join("/")} capital ${w.portfolios.map((p) => w.d.data(p).readBigUInt64LE(portfolioAt("capital"))).join("/")}`,
      );
      // A close-out pass within the backing's resolved horizon (the payout snapshot captured while it is live).
      for (let round = 0; round < 3; round++)
        for (let kk = 0; kk < 4; kk++) {
          const tx =
            round === 1
              ? ix.resolvedCrank(w.m, w.owners[kk]!, w.portfolios[kk]!, w.sources[kk]!)
              : ix.closeResolved(w.m, w.owners[kk]!, w.portfolios[kk]!, w.sources[kk]!);
          bump(outcomes, `early close-out ${key(await w.d.send(`early close ${round} ${kk}`, w.owners[kk]!, [tx]))}`);
        }
      bump(outcomes, `rate before the lapse ${rate()}`);
      const rateBefore = rateOf();
      w.d.setClock(w.d.slot + 150n, w.d.unixTimestamp + 1n);
      for (let kk = 0; kk < 4; kk++)
        for (const hint of [0, 1, 2]) {
          const got = await w.d.send(`lapsed crank ${kk} ${hint}`, w.owners[kk]!, [
            ix.resolvedCrank(w.m, w.owners[kk]!, w.portfolios[kk]!, w.sources[kk]!, hint),
          ]);
          bump(outcomes, `Resolved crank with a hint ${key(got)}`);
          if (got === "ok") broken.push(...conservation(w));
          // The other portfolios' receipts may have gained from an expiry: their owners claim at once.
          if (got === "ok") await claims(w, rng, outcomes, broken, `after crank ${kk} ${hint}`);
        }
      bump(outcomes, `rate after the lapse ${rate()}`);
      const rateAfter = rateOf();
      await claims(w, rng, outcomes, broken, "after the lapse");
      await closeOut(w, rng, outcomes, broken);
      await claims(w, rng, outcomes, broken, "closed out");
      const closed = await windDown(w, rng, r, outcomes, broken);
      const h = w.d.data(w.m.market);
      console.log(
        `haircut seed ${seed}: closed ${closed}; ${w.d.compared} compared; outcomes ${[...outcomes]
          .sort()
          .map(([o, c]) => `${o} ×${c}`)
          .join(
            ", ",
          )}${h.length > 16 ? `; rate ${u128At(h, marketAt.group("resolved_payout_ledger.current_payout_rate_num"))}/${u128At(h, marketAt.group("resolved_payout_ledger.current_payout_rate_den"))}` : ""}`,
      );
      expect(broken).toEqual([]);
      // The paths the title names, asserted on the state (the same in both VMs: every account is compared after each
      // transaction). Every seed: a close-out paid with a haircut receipt, the payout snapshot captured by the end of
      // the lapse, the market closed by CloseSlab. Seed 1 (6231): the snapshot captured at a payout rate of 0, the
      // backing's lapse through the Resolved crank's hinted expiry raising it to full, and ClaimResolvedPayoutTopup
      // paying the difference; on the other seeds the snapshot is first captured after the lapse and no top-up is due.
      expect(outcomes.get("payouts with a receipt") ?? 0).toBeGreaterThan(0);
      expect(rateAfter.captured).toBe(1);
      expect(closed).toBe(true);
      if (k === 1) {
        expect(rateBefore).toEqual({ num: 0n, den: rateBefore.den, captured: 1 });
        expect(rateBefore.den).toBeGreaterThan(0n);
        expect(rateAfter.num).toBe(rateAfter.den);
        expect(outcomes.get("ClaimResolvedPayoutTopup paid") ?? 0).toBeGreaterThan(0);
      }
    }, 1_800_000);
  }
});
