// PermissionlessCrank (tag 5) of the Percolator v16 port on a market in Recovery and on a Resolved market
// (showcase/mainnet/percolator-v16/recovery.ts, resolved.ts, crank.ts, autocrank.ts) against the reference: Percolator
// v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0;
// test/programs/percolator_v16.so, the Rust build of those commits, not a deployed program. Every transaction is
// compared whole (outcome, logs, inner instructions, return data, every named account's bytes; fewer compute units on
// success).
import { type Instruction, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { HAVE_PORT, HAVE_REFERENCE, ix } from "./percolator-v16-helpers.js";
import { SEED } from "./percolator-v16-world.js";
import { crankOf, crankWorld, legAssets, marketAt, portfolioAt, position } from "./percolator-v16-crank-world.js";
import { offsetOf } from "./percolator-v16-layout.js";
import { adminResolve, closeOut, conservation, declareRecovery, openAndMove, recoveryRounds, staleResolve, sweep } from "./percolator-v16-terminal.js";

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: the crank on a market in Recovery and a Resolved one", () => {
  const routes = ["declared Recovery", "ResolveMarket", "ResolveStalePermissionless"] as const;
  for (const k of [0, 1, 2, 3, 4, 5]) {
    const route = routes[k % 3]!;
    it(`${route}, then every portfolio closed out (seed ${k})`, async () => {
      const seed = SEED + 900n + BigInt(k) * 31n;
      const w = await crankWorld(seed);
      const rng = new Rng(seed);
      await openAndMove(w, rng, route);
      const outcomes = new Map<string, number>();
      const broken: string[] = [];
      let resolved = w.d.data(w.m.market)[marketAt.group("mode")] === 1;
      if (!resolved && route === "declared Recovery") {
        if (w.d.data(w.m.market)[marketAt.group("mode")] === 0) declareRecovery(w);
        resolved = (await recoveryRounds(w, rng, outcomes)) >= 0;
      } else if (!resolved && w.d.data(w.m.market)[marketAt.group("mode")] === 0) {
        resolved = route === "ResolveMarket" ? await adminResolve(w, rng, outcomes) : await staleResolve(w, rng, outcomes);
      } else if (!resolved) resolved = (await recoveryRounds(w, rng, outcomes)) >= 0;
      broken.push(...conservation(w));
      const legsAtResolution = w.portfolios.reduce((t, p) => t + legAssets(w, p).length, 0);
      const paid = resolved ? await closeOut(w, rng, outcomes, broken) : 0n;
      console.log(
        `resolution seed ${seed} (${route}): resolved ${resolved} with ${legsAtResolution} legs open; paid ${paid}; ${w.d.compared} compared; conservation failures ${broken.length}${broken.length ? ` (${broken[0]})` : ""}; outcomes ${[...outcomes].map(([o, n]) => `${o} ×${n}`).join(", ")}`,
      );
      expect(resolved).toBe(true);
      expect(broken).toEqual([]);
    }, 900_000);
  }
});

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)(
  "Percolator v16 port: account and data sweeps of ForfeitRecoveryLeg, CloseResolved, ResolveMarket, ResolveStalePermissionless and the crank's Recovery and Resolved paths",
  () => {
    it("in Recovery: ForfeitRecoveryLeg and the crank", async () => {
      const seed = SEED + 1777n;
      const w = await crankWorld(seed);
      const rng = new Rng(seed);
      await openAndMove(w, rng, "sweep");
      if (w.d.data(w.m.market)[marketAt.group("mode")] === 0) declareRecovery(w);
      const tally = { sent: 0, ok: 0 };
      const k = w.portfolios.findIndex((p) => legAssets(w, p).length > 0);
      const p = w.portfolios[k]!;
      const asset = legAssets(w, p)[0]!;
      await sweep(
        w,
        rng,
        "ForfeitRecoveryLeg",
        w.owners[k]!,
        ix.forfeitRecoveryLeg(w.m, w.owners[k]!, p, w.d.portfolioId(p), w.d.positionEpoch(p), asset, 1n << 64n),
        tally,
      );
      const c = crankOf(w, k, legAssets(w, p));
      await sweep(w, rng, "Recovery crank", c.payer, c.ix, tally);
      // A Live market: ForfeitRecoveryLeg of a live leg (LockActive) and its other refusals.
      w.d.patch(w.m.market, (b) => {
        b[marketAt.group("mode")] = 0;
        b[marketAt.group("recovery_reason")] = 0;
        b[marketAt.group("recovery_reason") + 1] = 0;
      });
      await sweep(
        w,
        rng,
        "ForfeitRecoveryLeg (Live)",
        w.owners[k]!,
        ix.forfeitRecoveryLeg(w.m, w.owners[k]!, p, w.d.portfolioId(p), w.d.positionEpoch(p), asset, 1_000n),
        tally,
      );
      console.log(`Recovery sweeps: ${tally.sent} transactions compared, ${tally.ok} succeeded in both`);
      expect(tally.sent).toBeGreaterThan(500);
    }, 1_800_000);

    it("Resolved: CloseResolved and the crank", async () => {
      const seed = SEED + 1888n;
      const w = await crankWorld(seed);
      const rng = new Rng(seed);
      await openAndMove(w, rng, "sweep");
      const outcomes = new Map<string, number>();
      if (w.d.data(w.m.market)[marketAt.group("mode")] === 0) await adminResolve(w, rng, outcomes);
      if (w.d.data(w.m.market)[marketAt.group("mode")] === 2) await recoveryRounds(w, rng, outcomes);
      const tally = { sent: 0, ok: 0 };
      for (const kk of [0, 1]) {
        const p = w.portfolios[kk]!;
        await sweep(w, rng, `CloseResolved ${kk}`, w.owners[kk]!, ix.closeResolved(w.m, w.owners[kk]!, p, w.sources[kk]!), tally);
        await sweep(w, rng, `Resolved crank ${kk}`, w.owners[kk]!, ix.resolvedCrank(w.m, w.owners[kk]!, p, w.sources[kk]!, kk), tally);
      }
      console.log(`Resolved sweeps: ${tally.sent} transactions compared, ${tally.ok} succeeded in both`);
      expect(tally.sent).toBeGreaterThan(500);
    }, 1_800_000);

    it("Live: ResolveMarket and ResolveStalePermissionless", async () => {
      const seed = SEED + 1999n;
      const w = await crankWorld(seed);
      const rng = new Rng(seed);
      await openAndMove(w, rng, "sweep", 4);
      const tally = { sent: 0, ok: 0 };
      const a = w.marketAuthority();
      await sweep(w, rng, "ResolveMarket", a, ix.resolveMarket(w.m, a, w.u64At(marketAt.group("next_market_id")), w.epoch(0)), tally);
      await w.d.ok("ConfigurePermissionlessResolve (short window)", a, [
        ix.permissionlessResolve(w.m, a, w.u64At(marketAt.group("next_market_id")), 30n, 10n, w.seq(0, "permissionlessResolve") + 1n, w.epoch(0)),
      ]);
      await sweep(w, rng, "ResolveStalePermissionless (not matured)", w.stranger, ix.resolveStalePermissionless(w.m), tally);
      const last = w.d.data(w.m.market).readBigUInt64LE(marketAt.wrapper("last_good_oracle_slot"));
      w.d.setClock(last + 40n, w.d.unixTimestamp + 40n);
      await sweep(w, rng, "ResolveStalePermissionless (matured)", w.stranger, ix.resolveStalePermissionless(w.m, BigInt(rng.int(1000))), tally);
      console.log(`resolution sweeps: ${tally.sent} transactions compared, ${tally.ok} succeeded in both`);
      expect(tally.sent).toBeGreaterThan(150);
    }, 1_800_000);
  },
);

/** A little-endian unsigned integer of `size` bytes written at `at`. */
function put(b: Buffer, at: number, size: number, v: bigint): void {
  for (let i = 0; i < size; i++) b[at + i] = Number((v >> BigInt(8 * i)) & 0xffn);
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: RebalanceReduce and CureAndCancelClose", () => {
  it("RebalanceReduce on real state: owners reduce their legs while prices move", async () => {
    const seed = SEED + 2111n;
    const w = await crankWorld(seed);
    const rng = new Rng(seed);
    await openAndMove(w, rng, "rebalance", 6);
    const outcomes = new Map<string, number>();
    const tally = { sent: 0, ok: 0 };
    const k0 = w.portfolios.findIndex((p) => legAssets(w, p).length > 0);
    if (k0 >= 0) {
      const p = w.portfolios[k0]!;
      await sweep(
        w,
        rng,
        "RebalanceReduce",
        w.owners[k0]!,
        ix.rebalanceReduce(w.m, w.owners[k0]!, p, w.d.portfolioId(p), w.d.positionEpoch(p), legAssets(w, p)[0]!, 1_000_000n),
        tally,
      );
    }
    for (let n = 0; n < 120 && w.d.data(w.m.market)[marketAt.group("mode")] === 0; n++) {
      if (rng.chance(30)) {
        w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
        w.refreshOracles(rng);
        const kk = rng.int(4);
        const c = crankOf(w, kk, legAssets(w, w.portfolios[kk]!));
        await w.d.send(`rebalance crank ${n}`, c.payer, [c.ix]);
      }
      const kk = rng.int(4);
      const p = w.portfolios[kk]!;
      const legs = legAssets(w, p);
      const asset = legs.length && rng.chance(90) ? legs[rng.int(legs.length)]! : rng.int(4);
      const q = position(w, p, asset);
      const abs = q < 0n ? -q : q;
      const reduce = rng.pick([1n, 1_000_000n, abs / 2n || 1n, abs || 1n, abs + 1n, (1n << 128n) - 1n]);
      const got = await w.d.send(`RebalanceReduce ${n} portfolio ${kk} asset ${asset} by ${reduce}`, w.owners[kk]!, [
        ix.rebalanceReduce(w.m, w.owners[kk]!, p, w.d.portfolioId(p), w.d.positionEpoch(p), asset, reduce),
      ]);
      const k = got.replace(/.*code: (\d+).*/, "custom $1");
      outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
    }
    console.log(`RebalanceReduce: ${[...outcomes].map(([o, c]) => `${o} ×${c}`).join(", ")}; sweep ${tally.sent} compared, ${tally.ok} succeeded in both`);
    expect(outcomes.get("ok") ?? 0).toBeGreaterThan(0);
  }, 1_800_000);

  it("CureAndCancelClose on generated close ledgers (no instruction ported so far opens one without progress)", async () => {
    const seed = SEED + 2222n;
    const w = await crankWorld(seed);
    const rng = new Rng(seed);
    await openAndMove(w, rng, "cure", 4);
    w.take();
    const outcomes = new Map<string, number>();
    const tally = { sent: 0, ok: 0 };
    const cp = portfolioAt("close_progress");
    const at = (f: string) => cp + offsetOf("CloseProgressLedger", f);
    let first: { apply: () => void; owner: KeyPairSigner; tx: Instruction } | undefined;
    for (let n = 0; n < 80; n++) {
      const kk = rng.int(4);
      const p = w.portfolios[kk]!;
      const legs = legAssets(w, p);
      const asset = legs.length && rng.chance(80) ? legs[rng.int(legs.length)]! : rng.int(3);
      const q = position(w, p, asset);
      // The ledger's domain is opposite the leg's side (validate_with_market), either side without a leg.
      const domainSide = q > 0n ? 1 : q < 0n ? 0 : rng.int(2);
      const gross = rng.pick([1n, 1_000n, 1_000_000n, 5_000_000_000n, 1n << 70n]);
      const now = w.d.data(w.m.market).readBigUInt64LE(marketAt.group("current_slot"));
      const variant = rng.int(10);
      const escrow = BigInt(rng.int(1_000_000));
      const closeId = BigInt(1 + rng.int(5));
      const apply = () => {
        w.d.patch(p, (b) => {
          b[at("active")] = 1;
          b[at("finalized")] = variant === 0 ? 1 : 0;
          b[at("canceled")] = 0;
          put(b, at("close_id"), 8, closeId);
          put(b, at("asset_index"), 4, BigInt(asset));
          put(b, at("market_id"), 8, w.marketId(asset));
          b[at("domain_side")] = domainSide;
          put(b, at("gross_loss_at_close_start"), 16, gross);
          put(b, at("drift_reference_slot"), 8, now);
          put(b, at("max_close_slot"), 8, now + 1000n);
          put(b, at("residual_remaining"), 16, variant === 1 ? gross - 1n : gross);
          if (variant === 2) put(b, at("insurance_spent"), 16, 1n);
          if (variant === 3) put(b, portfolioAt("cancel_deposit_escrow"), 16, escrow);
        });
        if (variant !== 4)
          w.d.patch(w.m.market, (b) => {
            const f = marketAt.engine(asset, domainSide === 1 ? "pending_domain_loss_barrier_short" : "pending_domain_loss_barrier_long");
            put(b, f, 8, b.readBigUInt64LE(f) + 1n);
            const t = marketAt.group("resolved_payout_blocker_count");
            put(b, t, 8, b.readBigUInt64LE(t) + 1n);
          });
      };
      apply();
      const deposit = rng.pick([0n, 0n, 1n, 1_000_000n, 1n << 40n]);
      const owner = w.owners[kk]!;
      const tx = ix.cureAndCancelClose(
        w.m,
        owner,
        p,
        w.d.portfolioId(p),
        w.d.positionEpoch(p),
        deposit,
        deposit !== 0n || rng.chance(20) ? w.sources[kk]! : undefined,
      );
      const got = await w.d.send(`CureAndCancelClose ${n} portfolio ${kk} asset ${asset} gross ${gross} variant ${variant} deposit ${deposit}`, owner, [tx]);
      const k = got.replace(/.*code: (\d+).*/, "custom $1");
      outcomes.set(k, (outcomes.get(k) ?? 0) + 1);
      w.restore();
      if (got === "ok" && deposit !== 0n && !first) first = { apply, owner, tx };
    }
    // The first cure with a deposit that succeeded, again: every account position and data window of its transaction.
    if (first) {
      first.apply();
      await sweep(w, rng, "CureAndCancelClose", first.owner, first.tx, tally);
    }
    console.log(`CureAndCancelClose: ${[...outcomes].map(([o, c]) => `${o} ×${c}`).join(", ")}; sweep ${tally.sent} compared, ${tally.ok} succeeded in both`);
    expect(w.d.compared).toBeGreaterThan(80);
  }, 1_800_000);
});
