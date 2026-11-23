// PermissionlessCrank (tag 5) and FinalizeResetSide (tag 45) of the Percolator v16 port
// (showcase/mainnet/percolator-v16/crank.ts, autocrank.ts, liquidation.ts) against the reference: Percolator v16 at
// commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0;
// test/programs/percolator_v16.so, the Rust build of those commits, not a deployed program. Every transaction is
// compared whole (outcome, logs, inner instructions, return data, every named account's bytes; fewer compute units on
// success).
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { HAVE_PORT, HAVE_REFERENCE, PROGRAM, ix, meta, outcome } from "./percolator-v16-helpers.js";
import { send as sendTx } from "../../test/harness.js";
import { SEED, World, withAccount } from "./percolator-v16-world.js";
import {
  CERT,
  CRANK_MARKET,
  crankOf,
  legAccounts,
  crankWorld,
  effectivePrice,
  i128At,
  legAssets,
  marketAt,
  portfolioAt,
  position,
  pushMark,
  tradeOf,
  u128At,
} from "./percolator-v16-crank-world.js";
import { offsetOf } from "./percolator-v16-layout.js";

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: PermissionlessCrank", () => {
  it("cranks of portfolios with legs while prices move", async () => {
    const w = await crankWorld(SEED + 501n);
    const rng = new Rng(SEED + 501n);
    const outcomes = new Map<string, number>();
    const note = (o: string) => outcomes.set(o.replace(/.*code: (\d+).*/, "custom $1"), (outcomes.get(o) ?? 0) + 1);
    // Cranks of portfolios without legs.
    for (let k = 0; k < 4; k++) {
      const c = crankOf(w, k, []);
      note(await w.d.send(`flat crank ${k}`, c.payer, [c.ix]));
    }
    // Legs on all three assets.
    for (let n = 0; n < 12; n++) {
      const i = n % 4;
      const j = (i + 1 + rng.int(3)) % 4;
      const t = tradeOf(w, i, j, n % 3, BigInt(1 + rng.int(50)) * 1_000_000n * (rng.chance(50) ? 1n : -1n));
      note(await w.d.send(`open ${n}`, t.payer, [t.ix]));
    }
    for (let s = 0; s < 30; s++) {
      w.d.setClock(w.d.slot + BigInt(1 + rng.int(3)));
      w.refreshOracles(rng);
      if (rng.chance(40)) await pushMark(w, 0, (effectivePrice(w, 0) * BigInt(9_500 + rng.int(1_001))) / 10_000n);
      if (rng.chance(40)) await pushMark(w, 1, (effectivePrice(w, 1) * BigInt(9_500 + rng.int(1_001))) / 10_000n);
      for (let k = 0; k < 4; k++) {
        const assets = legAssets(w, w.portfolios[k]!);
        const c = crankOf(w, k, rng.chance(80) ? assets : assets.slice(0, rng.int(assets.length + 1)));
        const got = await w.d.send(`crank slot ${s} portfolio ${k} [${assets}]`, c.payer, [c.ix]);
        note(got);
      }
    }
    console.log(`crank smoke: ${w.d.compared} transactions compared; ${[...outcomes].map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    expect(w.d.compared).toBeGreaterThan(100);
  }, 600_000);

  for (const [name, drop, size, hold] of [
    ["a liquidation as the mark falls", 850_000n, 90_000_000_000n, 0],
    ["a bankruptcy as the mark collapses", 500_000n, 95_000_000_000n, 40],
    ["a short squeezed as the mark rises", 1_300_000n, -90_000_000_000n, 0],
    ["a bankrupt short", 1_500_000n, -95_000_000_000n, 30],
  ] as const)
    it(
      name,
      async () => {
        const w = await crankWorld(SEED + 503n + size);
        const outcomes: string[] = [];
        // The liquidation reward: half of the fee to the cranker's portfolio (portfolio 3's, its owner cranking).
        const auth = w.marketAuthority();
        await w.d.send("cranker share", auth, [ix.marketPolicy(w.m, auth, 37, 5_000n, w.seq(0, "liquidationFee") + 1n, w.epoch(0))]);
        const crankerBefore = u128At(w.d.data(w.portfolios[3]!), portfolioAt("capital"));
        const t = tradeOf(w, 0, 1, 0, size);
        outcomes.push(await w.d.send("open", t.payer, [t.ix]));
        const t2 = tradeOf(w, 2, 3, 0, 1_000_000_000n);
        outcomes.push(await w.d.send("open others", t2.payer, [t2.ix]));
        await pushMark(w, 0, drop);
        for (let s = 0; s < 60; s++) {
          w.d.setClock(w.d.slot + 1n);
          // Twice a slot: the first crank of a slot collects the maintenance fee, which invalidates the certificate, so
          // it refreshes; the second finds the certificate current and can liquidate.
          // A portfolio's second crank follows its first directly: another portfolio's settlement between them can move the
          // risk epoch (its source credit recomputed), which makes the first crank's certificate stale again.
          for (const k of [0, 0, 1, 1, 2, 3]) {
            // The bankruptcies: portfolio 0 left uncranked while the others' cranks move the price.
            if (k === 0 && s < hold) continue;
            const c = crankOf(w, k, legAssets(w, w.portfolios[k]!), k === 0 ? { by: w.owners[3]!, cranker: w.portfolios[3]! } : {});
            const q0 = position(w, w.portfolios[k]!, 0);
            const r0 = u128At(w.d.data(w.portfolios[3]!), portfolioAt("capital"));
            const i0 = u128At(w.d.data(w.m.market), marketAt.group("insurance"));
            const got = await w.d.send(`slot ${s} crank ${k} position ${q0}`, c.payer, [c.ix]);
            if (k === 0 && position(w, w.portfolios[0]!, 0) !== q0)
              if (s < 3 || s === hold)
                console.log(
                  `${name}: liquidation at slot ${s}: ${q0} -> ${position(w, w.portfolios[0]!, 0)}, insurance ${i0} -> ${u128At(w.d.data(w.m.market), marketAt.group("insurance"))}, cranker ${r0} -> ${u128At(w.d.data(w.portfolios[3]!), portfolioAt("capital"))}, CU ${w.d.cu[`slot ${s} crank ${k} position ${q0}`]}`,
                );
            outcomes.push(`${s}/${k}:${got.replace(/.*code: (\d+).*/, "custom $1")}`);
            if (k === 0 && s >= hold && s < hold + 2 && hold > 0) {
              const pb0 = w.d.data(w.portfolios[0]!);
              const mk0 = w.d.data(w.m.market);
              console.log(
                `${name} slot ${s}: ${got} capital ${u128At(pb0, portfolioAt("capital"))} pnl ${i128At(pb0, portfolioAt("pnl"))} lock ${pb0[portfolioAt("liquidation_lock")]} pos ${position(w, w.portfolios[0]!, 0)} insurance ${u128At(mk0, marketAt.group("insurance"))} explicit ${u128At(mk0, marketAt.engine(0, "asset.explicit_unallocated_loss_long"))}/${u128At(mk0, marketAt.engine(0, "asset.explicit_unallocated_loss_short"))} winner pnl ${i128At(w.d.data(w.portfolios[1]!), portfolioAt("pnl"))} price ${effectivePrice(w, 0)}`,
              );
            }
          }
          if (s % 10 === 9) await pushMark(w, 0, drop);
        }
        const mk = w.d.data(w.m.market);
        console.log(
          `${name}: B long ${u128At(mk, marketAt.engine(0, "asset.b_long_num"))} short ${u128At(mk, marketAt.engine(0, "asset.b_short_num"))}, modes ${mk[marketAt.engine(0, "asset.mode_long")]}/${mk[marketAt.engine(0, "asset.mode_short")]}, market mode ${mk[marketAt.group("mode")]}, close id ${w.d.data(w.portfolios[0]!).readBigUInt64LE(portfolioAt("close_progress") + offsetOf("CloseProgressLedger", "close_id"))}`,
        );
        console.log(`${name}: the cranker's capital ${crankerBefore} -> ${u128At(w.d.data(w.portfolios[3]!), portfolioAt("capital"))}`);
        const nh = crankOf(w, 0, []);
        console.log(`no-hint crank: ${await w.d.send("no-hint crank", nh.payer, [nh.ix])}`);
        const pb = w.d.data(w.portfolios[0]!);
        console.log(
          `${name}: price ${effectivePrice(w, 0)} target ${w.d.data(w.m.market).readBigUInt64LE(marketAt.engine(0, "asset.raw_oracle_target_price"))} mark ${w.d.data(w.m.market).readBigUInt64LE(marketAt.profile(0, "mark_ewma_e6"))} slot ${w.d.data(w.m.market).readBigUInt64LE(marketAt.engine(0, "asset.slot_last"))} clock ${w.d.slot}; capital ${u128At(pb, portfolioAt("capital"))} pnl ${i128At(pb, portfolioAt("pnl"))} deficit ${u128At(pb, CERT + offsetOf("HealthCert", "certified_liq_deficit"))} valid ${pb[CERT + offsetOf("HealthCert", "valid")]}; ${w.d.compared} compared; position ${position(w, w.portfolios[0]!, 0)}; ${outcomes.filter((o) => !o.endsWith("ok")).join(" ")}`,
        );
      },
      600_000,
    );

  // Aimed at the trade's terminal close ledger (then AdvanceClose) and at a declared Recovery (an uncovered loss with a
  // second leg left); in these runs neither arises (no close ledger opens: TESTING.md lists both as not reached), and
  // every transaction is compared all the same.
  it("a portfolio past its capital closed by a trade, and one with a second leg", async () => {
    for (const second of [false, true]) {
      const w = await crankWorld(SEED + 531n + (second ? 1n : 0n));
      const lines: string[] = [];
      const note = (what: string, got: string) => lines.push(`${what}: ${got.replace(/.*code: (\d+).*/, "custom $1")}`);
      let t = tradeOf(w, 0, 1, 0, 95_000_000_000n);
      note("open", await w.d.send("open", t.payer, [t.ix]));
      if (second) {
        t = tradeOf(w, 0, 2, 1, 1_000_000_000n);
        note("second leg", await w.d.send("second leg", t.payer, [t.ix]));
      }
      t = tradeOf(w, 2, 3, 0, 1_000_000_000n);
      note("others", await w.d.send("others", t.payer, [t.ix]));
      await pushMark(w, 0, 600_000n);
      // Portfolio 0 left alone while the others' cranks move the price past its capital.
      for (let s = 0; s < 35; s++) {
        w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
        for (const k of [1, 2, 3]) {
          const c = crankOf(w, k, legAssets(w, w.portfolios[k]!));
          await w.d.send(`slot ${s} crank ${k}`, c.payer, [c.ix]);
        }
      }
      if (!second) {
        // The leg closed by a trade at the effective price: the terminal trade's close-progress ledger for the loss.
        t = tradeOf(w, 1, 0, 0, 95_000_000_000n);
        note("terminal close", await w.d.send("terminal close", t.payer, [t.ix]));
      }
      for (let s = 0; s < 6 && w.d.data(w.m.market)[marketAt.group("mode")] === 0; s++) {
        w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
        for (const round of [0, 1]) {
          const c = crankOf(w, 0, legAssets(w, w.portfolios[0]!));
          note(`after, slot ${s} round ${round}`, await w.d.send(`after slot ${s} round ${round}`, c.payer, [c.ix]));
          if (w.d.data(w.m.market)[marketAt.group("mode")] !== 0) break;
        }
      }
      const pb = w.d.data(w.portfolios[0]!);
      const cl = (f: string) => portfolioAt("close_progress") + offsetOf("CloseProgressLedger", f);
      console.log(
        `${second ? "second leg" : "terminal close"}: ${lines.join("; ")}; market mode ${w.d.data(w.m.market)[marketAt.group("mode")]}, close id ${pb.readBigUInt64LE(cl("close_id"))}, residual ${u128At(pb, cl("residual_remaining"))}, finalized ${pb[cl("finalized")]}`,
      );
    }
  }, 600_000);

  it("hint shapes, oracle accounts and account lists", async () => {
    const w = await crankWorld(SEED + 511n);
    const rng = new Rng(SEED + 511n);
    for (let n = 0; n < 6; n++) {
      const t = tradeOf(w, n % 2, 2 + (n % 2), n % 3, BigInt(1 + rng.int(20)) * 1_000_000_000n * (n % 2 ? -1n : 1n));
      await w.d.send(`open ${n}`, t.payer, [t.ix]);
    }
    const legs = legAccounts(w, 2);
    const p = w.portfolios[0]!;
    const shapes: [string, { asset: number; accounts: number }[], Address[]][] = [
      ["none", [], []],
      ["asset 0", [{ asset: 0, accounts: 0 }], []],
      ["hybrid with its legs", [{ asset: 2, accounts: legs.length }], legs],
      [
        "all three",
        [
          { asset: 0, accounts: 0 },
          { asset: 1, accounts: 0 },
          { asset: 2, accounts: legs.length },
        ],
        legs,
      ],
      [
        "reversed",
        [
          { asset: 2, accounts: legs.length },
          { asset: 1, accounts: 0 },
          { asset: 0, accounts: 0 },
        ],
        legs,
      ],
      [
        "repeated",
        [
          { asset: 0, accounts: 0 },
          { asset: 0, accounts: 0 },
        ],
        [],
      ],
      ["unconfigured asset", [{ asset: 3, accounts: 0 }], []],
      ["asset past the capacity", [{ asset: 200, accounts: 0 }], []],
      ["hybrid short of a leg", [{ asset: 2, accounts: legs.length - 1 }], legs.slice(0, -1)],
      ["hybrid with a leg too many", [{ asset: 2, accounts: legs.length + 1 }], [...legs, legs[0]!]],
      ["accounts missing", [{ asset: 2, accounts: legs.length }], legs.slice(0, -1)],
      ["an account left over", [{ asset: 0, accounts: 0 }], [legs[0]!]],
      ["legs out of order", [{ asset: 2, accounts: legs.length }], [...legs].reverse()],
      ["a managed asset given an account", [{ asset: 0, accounts: 1 }], [legs[0]!]],
      ["sixteen hints", Array.from({ length: 16 }, (_, i) => ({ asset: i % 3, accounts: 0 })), []],
    ];
    for (let round = 0; round < 3; round++) {
      w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
      w.refreshOracles(rng);
      await pushMark(w, 0, (effectivePrice(w, 0) * 10_100n) / 10_000n);
      for (const [name, hints, tail] of shapes) await w.d.send(`round ${round} ${name}`, w.stranger, [ix.crank(w.m, w.stranger, p, 0n, hints, tail)]);
    }
    // The hybrid's oracle accounts: stale, ahead of the Clock, malformed, foreign-owned, the market, the portfolio.
    const hy = { asset: 2, accounts: legs.length };
    const bad: [string, () => void, (a: Address[]) => Address[]][] = [
      ["stale", () => w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 100_000n), (a) => a],
      ["published ahead", () => w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp - 1_000n), (a) => a],
      ["malformed", () => w.d.patch(legs[0]!, (b) => b.fill(7, 0, Math.min(64, b.length))), (a) => a],
      ["the market as a leg", () => {}, (a) => [w.m.market, ...a.slice(1)]],
      ["the portfolio as a leg", () => {}, (a) => [p, ...a.slice(1)]],
      ["the owner as a leg", () => {}, (a) => [w.stranger.address, ...a.slice(1)]],
    ];
    for (const [name, prepare, legsOf] of bad) {
      w.take();
      prepare();
      await w.d.send(`oracle ${name}`, w.stranger, [ix.crank(w.m, w.stranger, p, 0n, [hy], legsOf(legs))]);
      w.restore();
      w.refreshOracles();
    }
    // The soft-stale window matured (the mark takes over) and the market's stale window matured.
    for (const gap of [20n, 200n, 2_000n, 100_000n]) {
      w.take();
      w.d.setClock(w.d.slot + gap, w.d.unixTimestamp + gap);
      await w.d.send(`gap ${gap} without fresh legs`, w.stranger, [ix.crank(w.m, w.stranger, p, 0n, [{ asset: 0, accounts: 0 }, hy], legs)]);
      await w.d.send(`gap ${gap} with no hint`, w.stranger, [ix.crank(w.m, w.stranger, p, 0n, [], [])]);
      w.refreshOracles();
      await w.d.send(`gap ${gap} with fresh legs`, w.stranger, [ix.crank(w.m, w.stranger, p, 0n, [hy], legs)]);
      w.restore();
    }
    // Every ordered pair of positions of a crank with a hybrid hint and a cranker's portfolio, the later one given the
    // earlier one's account.
    const a = w.marketAuthority();
    await w.d.send("cranker share", a, [ix.marketPolicy(w.m, a, 37, 5_000n, w.seq(0, "liquidationFee") + 1n, w.epoch(0))]);
    const base = ix.crank(w.m, w.owners[1]!, p, 0n, [hy], legs, w.portfolios[1]!);
    const n = base.accounts!.length;
    w.take();
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const from = base.accounts![i]!;
        const tx = withAccount(w, base, j, from.address, base.accounts![j]!.role);
        await w.d.send(`pair ${i}->${j}`, w.owners[1]!, [tx]);
        w.restore();
      }
    // Signer and writability refusals, too few accounts, a portfolio of another market.
    const other = await w.d.newPortfolio();
    await w.d.send("InitPortfolio on the empty market", other.owner, [ix.initPortfolio(w.empty, other.owner, other.portfolio)]);
    const cases: Instruction[] = [
      { ...base, accounts: base.accounts!.slice(0, 2) },
      withAccount(w, base, 1, w.m.market, AccountRole.READONLY),
      withAccount(w, base, 2, p, AccountRole.READONLY),
      withAccount(w, base, 0, w.owners[1]!.address, AccountRole.READONLY),
      withAccount(w, base, 2, other.portfolio, AccountRole.WRITABLE),
      withAccount(w, base, 2, w.blank, AccountRole.WRITABLE),
    ];
    for (const [k, tx] of cases.entries()) await w.d.send(`account case ${k}`, w.owners[1]!, [tx]);
  }, 900_000);

  it("the maximum shape: a portfolio with a leg on each of 14 assets, cranked with 14 hints, liquidated", async () => {
    const w = await World.build(SEED + 521n, {
      capacity: 14,
      portfolios: 4,
      deposit: 10_000_000_000n,
      mark: 1_000_000n,
      market: { ...CRANK_MARKET.market, maxPortfolioAssets: 14 },
    });
    for (let asset = 0; asset < 14; asset++) {
      const t = tradeOf(w, 0, 1 + (asset % 3), asset, (asset % 2 ? -1n : 1n) * 5_000_000_000n);
      await w.d.send(`leg ${asset}`, t.payer, [t.ix]);
    }
    const all = Array.from({ length: 14 }, (_, asset) => ({ asset, accounts: 0 }));
    const rows: string[] = [];
    // One crank, compared whole; where the reference runs out of its 1,400,000 compute units and the port does not,
    // the reference is run again under a raised budget and the port must agree with that run (Diff.send).
    const crank = async (label: string, k: number, hints: { asset: number; accounts: number }[]): Promise<string> => {
      const before = w.d.raised.length;
      const got = await w.d.send(label, w.stranger, [ix.crank(w.m, w.stranger, w.portfolios[k]!, 0n, hints, [])]);
      if (w.d.raised.length > before) {
        const r = w.d.raised.at(-1)!;
        rows.push(`${label}: reference past 1,400,000 (${r.reference} under the raised budget), port ${r.port}`);
        return "reference over the limit";
      }
      return got;
    };
    for (let s = 0; s < 40; s++) {
      w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
      if (s % 5 === 0) for (let asset = 0; asset < 14; asset++) await pushMark(w, asset, asset % 2 ? 1_200_000n : 800_000n, `push ${asset}`);
      for (const k of [0, 0, 1, 2, 3]) {
        const label = `max shape slot ${s} portfolio ${k}`;
        // Portfolio 0 with all 14 hints every fifth slot, else with four (and the others with five).
        const hints = k === 0 && s % 5 === 4 ? all : all.slice((s * 3) % 10, ((s * 3) % 10) + (k === 0 ? 4 : 5));
        const got = await crank(label, k, hints);
        if (k === 0 && got !== "reference over the limit")
          rows.push(
            `${s} (${hints.length} hints): ${got === "ok" ? `ok ${w.d.cu[label]![0]}/${w.d.cu[label]![1]}` : got.replace(/.*code: (\d+).*/, "custom $1")}, legs ${legAssets(w, w.portfolios[0]!).length}`,
          );
      }
    }
    // Then every asset observed every slot (a step of accrual each), portfolio 0 cranked twice a slot with all 14
    // hints: its legs are liquidated one by one, the riskiest first.
    const legsLeft: string[] = [];
    for (let s = 0; s < 30 && legAssets(w, w.portfolios[0]!).length > 0; s++) {
      w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
      // The other portfolios observe the 14 assets between them (five each); portfolio 0 then needs no hint once no
      // price has a move left to make.
      for (const k of [1, 2, 3]) await crank(`max shape phase 2 slot ${s} portfolio ${k}`, k, all.slice((k - 1) * 5, (k - 1) * 5 + 5));
      for (const round of [0, 1]) {
        const label = `max shape phase 2 slot ${s} portfolio 0 round ${round}`;
        const got = await crank(label, 0, s % 10 === 9 ? all : []);
        if (got === "ok") legsLeft.push(`${legAssets(w, w.portfolios[0]!).length} (${w.d.cu[label]![0]}/${w.d.cu[label]![1]})`);
      }
    }
    console.log(
      `maximum shape: ${w.d.raised.length} cranks past the reference's limit, each equal to the reference's run under a raised budget; ${rows.join("; ")}; phase 2 legs after each success: ${legsLeft.join(", ")}`,
    );
  }, 900_000);

  it("FinalizeResetSide on Normal sides and refusals", async () => {
    const w = await crankWorld(SEED + 502n);
    for (const [asset, side] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [2, 1],
      [3, 0],
      [9, 0],
      [0, 2],
    ] as const)
      await w.d.send(`finalize ${asset} ${side}`, w.stranger, [ix.finalizeResetSide(w.m, asset, side)]);
  }, 300_000);
});
