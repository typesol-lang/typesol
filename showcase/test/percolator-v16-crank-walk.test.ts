// A random walk on real state for the Percolator v16 port's PermissionlessCrank and FinalizeResetSide
// (showcase/mainnet/percolator-v16/crank.ts, autocrank.ts, liquidation.ts), against the reference: Percolator v16 at
// commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0;
// test/programs/percolator_v16.so, the Rust build of those commits, not a deployed program. Every transaction is
// compared whole at every step (outcome, logs, inner instructions, return data, every named account's bytes; fewer
// compute units on success).
//
// The world (percolator-v16-crank-world.ts): three assets (AuthMark, EwmaMark, and a hybrid on the world's external
// oracles) with funding, four funded portfolios, a Clock that moves. Each episode opens legs by trades, then moves the
// prices slot by slot: marks pushed along a drifting target (now and then a jump, or a steered move against the
// largest position of one portfolio, which makes liquidations and bankruptcies), the hybrid's oracle accounts
// refreshed with moving prices (sometimes left stale, sometimes published in the future), and cranks of every
// portfolio (its legs' hints, sometimes none, too many, repeated, out of order, or with a cranker's portfolio taking
// the liquidation reward); between them trades at the moving prices, conversions, maintenance-fee syncs, withdrawals,
// FinalizeResetSide on sides waiting to reset, lifecycle changes of asset 1 with open legs, policy updates. Now and then
// the market is resolved with its legs open (ResolveMarket, or ResolveStalePermissionless once its stale window is
// shortened and passed); a market in Recovery (declared by a crank) has its legs forfeited by their owners
// (ForfeitRecoveryLeg) until a crank resolves it; a Resolved market has every portfolio closed out by its owner (the
// crank and CloseResolved, paying out to its token account) before the next episode. The conservation the original's
// tests assert (percolator-v16-terminal.ts `conservation`) is checked in both VMs at the end of each episode and after
// every close-out.
//
// PERCOLATOR_V16_CRANK_STEPS (1,500) and PERCOLATOR_V16_CRANK_SEEDS (2) size it, PERCOLATOR_V16_CRANK_MUTATIONS (600)
// the mutation fuzzer; a run is replayed from the seed it prints (percolator-v16-helpers.ts).
import { AccountRole, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { HAVE_PORT, HAVE_REFERENCE, PROGRAM, ix } from "./percolator-v16-helpers.js";
import { MARKET, PORTFOLIO, layout, offsetOf, sizeOf } from "./percolator-v16-layout.js";
import { SEED, type World, withAccount } from "./percolator-v16-world.js";
import { Reserves, adminResolve, closeOut, conservation, recoveryRounds, staleResolve, windDown } from "./percolator-v16-terminal.js";
import { type Lp, type Trader, batch, batchCpi, lpMatcher, setLpMatcher, tradeCpi } from "./percolator-v16-batch-world.js";
import {
  CERT,
  CRANK_MARKET,
  crankOf,
  crankWorld,
  effectivePrice,
  i128At,
  legAssets,
  legAt,
  marketAt,
  portfolioAt,
  position,
  pushMark,
  setUpAssets,
  tradeOf,
  u128At,
} from "./percolator-v16-crank-world.js";

const STEPS = Number(process.env.PERCOLATOR_V16_CRANK_STEPS ?? 1500);
const SEEDS = Number(process.env.PERCOLATOR_V16_CRANK_SEEDS ?? 2);
/** A tag's name (the world's names, and those of the instructions it does not draw). */
const NAME_OF = (tag: number) =>
  NAMES[tag] ??
  (
    {
      5: "PermissionlessCrank",
      6: "TradeNoCpi",
      10: "TradeCpi",
      66: "BatchTradeNoCpi",
      67: "BatchTradeCpi",
      9: "TopUpInsurance",
      24: "TopUpBackingBucket",
      28: "ConvertReleasedPnl",
      45: "FinalizeResetSide",
      50: "WithdrawBackingBucket",
      52: "WithdrawBackingBucketEarnings",
      56: "TopUpInsuranceDomain",
      57: "WithdrawInsuranceAsset",
      64: "ForceCloseAbandonedAsset",
    } as Record<number, string>
  )[tag] ??
  `tag ${tag}`;
/** How often an episode still Live after its moves is resolved by ResolveMarket or ResolveStalePermissionless. */
const RESOLVE_PERCENT = Number(process.env.PERCOLATOR_V16_CRANK_RESOLVE ?? 75);
const MUTATIONS = Number(process.env.PERCOLATOR_V16_CRANK_MUTATIONS ?? 600);
const BOUNDARY = [0n, 1n, 2n, 0x7fn, 0xffn, 0xffffn, 10_000n, 10_001n, 0xffff_ffffn, 1n << 63n, (1n << 64n) - 1n, 1n << 127n, (1n << 128n) - 1n];

const NAMES: Record<number, string> = {
  3: "Deposit",
  4: "Withdraw",
  5: "PermissionlessCrank",
  6: "TradeNoCpi",
  28: "ConvertReleasedPnl",
  34: "ConfigureHybridOracle",
  36: "PushEwmaMark",
  37: "UpdateLiquidationFeePolicy",
  40: "UpdateAssetLifecycle",
  45: "FinalizeResetSide",
  48: "SyncMaintenanceFee",
  49: "UpdateMaintenanceFeePolicy",
  58: "UpdateFeeRedirectPolicy",
  63: "PushAuthMark",
};

/** What the walk produced, from the reference's accounts before and after each success. */
interface Tally {
  settled: number;
  accrualsWithOi: number;
  priceMoves: number;
  pnlChanges: number;
  certWrites: number;
  haircut: number;
  partialLiquidations: number;
  fullLiquidations: number;
  socialisedLosses: number;
  sideResets: number;
  finalizedSides: number;
  bChunks: number;
  closeLedgers: number;
  recoveries: number;
  crankerRewards: number;
  impairedLiens: number;
  conversions: number;
  withdrawalsAfterLegs: number;
  lifecycleWithLegs: number;
  adminResolutions: number;
  staleResolutions: number;
  recoveryResolutions: number;
  closedMarkets: number;
  closedSlabs: number;
  legsAtResolution: number;
  winnersAtResolution: number;
  losersAtResolution: number;
  bankruptAtResolution: number;
  paidOut: bigint;
}

function observe(w: World, before: Map<Address, Buffer>, m0: Buffer, tag: number, crankTarget: Address | null, t: Tally, hadLegs: Set<Address>): void {
  const m1 = w.d.data(w.m.market);
  for (let a = 0; a < 3; a++) {
    const oi = m0.readBigUInt64LE(marketAt.engine(a, "asset.oi_eff_long_q")) !== 0n || m0.readBigUInt64LE(marketAt.engine(a, "asset.oi_eff_short_q")) !== 0n;
    if (oi && m1.readBigUInt64LE(marketAt.engine(a, "asset.slot_last")) > m0.readBigUInt64LE(marketAt.engine(a, "asset.slot_last"))) t.accrualsWithOi++;
    if (m1.readBigUInt64LE(marketAt.engine(a, "asset.effective_price")) !== m0.readBigUInt64LE(marketAt.engine(a, "asset.effective_price"))) t.priceMoves++;
    for (const side of ["long", "short"]) {
      if (u128At(m1, marketAt.engine(a, `asset.b_${side}_num`)) > u128At(m0, marketAt.engine(a, `asset.b_${side}_num`))) t.socialisedLosses++;
      if (m1[marketAt.engine(a, `asset.mode_${side}`)] === 2 && m0[marketAt.engine(a, `asset.mode_${side}`)] !== 2) t.sideResets++;
      if (tag === 45 && m1[marketAt.engine(a, `asset.mode_${side}`)] === 0 && m0[marketAt.engine(a, `asset.mode_${side}`)] === 2) t.finalizedSides++;
    }
  }
  if (m1[marketAt.group("mode")] === 2 && m0[marketAt.group("mode")] !== 2) t.recoveries++;
  for (const [p, b0] of before) {
    const b1 = w.d.data(p);
    if (b1.length < 9555 || b0.length < 9555) continue;
    for (let i = 0; i < 16; i++) {
      const was = b0[legAt(i, "active")] === 1;
      const is = b1[legAt(i, "active")] === 1;
      if (was && is && b0.readUInt32LE(legAt(i, "asset_index")) === b1.readUInt32LE(legAt(i, "asset_index"))) {
        if (i128At(b0, legAt(i, "k_snap")) !== i128At(b1, legAt(i, "k_snap")) || i128At(b0, legAt(i, "f_snap")) !== i128At(b1, legAt(i, "f_snap"))) t.settled++;
        if (u128At(b0, legAt(i, "b_snap")) !== u128At(b1, legAt(i, "b_snap"))) t.bChunks++;
      }
    }
    if (i128At(b0, portfolioAt("pnl")) !== i128At(b1, portfolioAt("pnl"))) t.pnlChanges++;
    const certLen = sizeOf("HealthCert");
    if (!b0.subarray(CERT, CERT + certLen).equals(b1.subarray(CERT, CERT + certLen)) && b1[CERT + offsetOf("HealthCert", "valid")] === 1) {
      t.certWrites++;
      const equity = i128At(b1, CERT + offsetOf("HealthCert", "certified_equity"));
      if (equity < u128At(b1, portfolioAt("capital")) + i128At(b1, portfolioAt("pnl")) + i128At(b1, portfolioAt("fee_credits"))) t.haircut++;
    }
    const cl = portfolioAt("close_progress") + offsetOf("CloseProgressLedger", "close_id");
    if (b1.readBigUInt64LE(cl) !== b0.readBigUInt64LE(cl)) t.closeLedgers++;
    const imp = portfolioAt("source_domains") + offsetOf("PortfolioSourceDomain", "source_claim_impaired_num");
    if (u128At(b1, imp) > u128At(b0, imp)) t.impairedLiens++;
    if (tag === 5 && p !== crankTarget && u128At(b1, portfolioAt("capital")) > u128At(b0, portfolioAt("capital"))) t.crankerRewards++;
    if (tag === 5 && p === crankTarget) {
      for (let a = 0; a < 3; a++) {
        const q0 = position(w, p, a);
        void q0;
      }
    }
  }
  if (tag === 28) t.conversions++;
  if (tag === 4 && crankTarget && hadLegs.has(crankTarget)) t.withdrawalsAfterLegs++;
}

/** The absolute position of `p` on each asset, from bytes. */
function positions(b: Buffer): bigint[] {
  const out = [0n, 0n, 0n, 0n];
  if (b.length < 9555) return out;
  for (let i = 0; i < 16; i++) {
    if (b[legAt(i, "active")] !== 1) continue;
    const q = i128At(b, legAt(i, "basis_pos_q"));
    out[b.readUInt32LE(legAt(i, "asset_index"))] = q < 0n ? -q : q;
  }
  return out;
}

/** One change to a crank: a data byte, an account replaced or dropped, the accounts cut. */
function mutate(w: World, rng: Rng, t: Instruction): Instruction {
  const accounts = t.accounts ?? [];
  if (rng.chance(40)) {
    const data = Buffer.from(t.data ?? new Uint8Array());
    data[1 + rng.int(data.length - 1)] = rng.int(256);
    return { ...t, data: new Uint8Array(data) };
  }
  const pool = w.pool();
  const at = rng.int(accounts.length);
  const k = rng.int(4);
  if (k === 0) return withAccount(w, t, at, accounts[rng.int(accounts.length)]!.address, accounts[at]!.role);
  if (k === 1) {
    const a = pool[rng.int(pool.length)]!;
    // A program's address cannot be writable in a transaction that invokes it.
    return withAccount(w, t, at, a, a === PROGRAM ? AccountRole.READONLY : accounts[at]!.role);
  }
  if (k === 2) return withAccount(w, t, at, accounts[at]!.address, AccountRole.READONLY);
  return { ...t, accounts: accounts.slice(0, rng.int(accounts.length + 1)) };
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: PermissionlessCrank on real state, a random walk", () => {
  for (let k = 0; k < SEEDS; k++) {
    const seed = SEED + 77n + BigInt(k) * 2027n;
    it(`seed ${seed}, ${STEPS} steps`, async () => {
      const w = await crankWorld(seed);
      const rng = new Rng(seed);
      const tally: Tally = {
        settled: 0,
        accrualsWithOi: 0,
        priceMoves: 0,
        pnlChanges: 0,
        certWrites: 0,
        haircut: 0,
        partialLiquidations: 0,
        fullLiquidations: 0,
        socialisedLosses: 0,
        sideResets: 0,
        finalizedSides: 0,
        bChunks: 0,
        closeLedgers: 0,
        recoveries: 0,
        crankerRewards: 0,
        impairedLiens: 0,
        conversions: 0,
        withdrawalsAfterLegs: 0,
        lifecycleWithLegs: 0,
        adminResolutions: 0,
        staleResolutions: 0,
        recoveryResolutions: 0,
        closedMarkets: 0,
        closedSlabs: 0,
        legsAtResolution: 0,
        winnersAtResolution: 0,
        losersAtResolution: 0,
        bankruptAtResolution: 0,
        paidOut: 0n,
      };
      const terminal = new Map<string, number>();
      const broken: string[] = [];
      const byTag = new Map<number, [number, number]>();
      const outcomes = new Map<string, number>();
      const hadLegs = new Set<Address>();
      let step = 0;
      let episode = 0;
      const cuCrank: [bigint, bigint][] = [];
      const send = async (tag: number, payer: KeyPairSigner, tx: Instruction, what = "", target: Address | null = null): Promise<string> => {
        const before = new Map<Address, Buffer>();
        for (const p of w.portfolios) if (w.d.reference.getAccount(p).exists) before.set(p, Buffer.from(w.d.data(p)));
        for (const p of w.portfolios) if (legAssets(w, p).length) hadLegs.add(p);
        const m0 = Buffer.from(w.d.data(w.m.market));
        const got = await w.d.send(`crank walk ${seed} episode ${episode} step ${step} ${NAME_OF(tag)} ${what}`, payer, [tx]);
        step++;
        const c = byTag.get(tag) ?? [0, 0];
        c[0]++;
        if (got === "ok") {
          c[1]++;
          observe(w, before, m0, tag, target, tally, hadLegs);
          if (tag === 5 && target) {
            const q0 = positions(before.get(target) ?? Buffer.alloc(0));
            const q1 = positions(Buffer.from(w.d.data(target)));
            for (let a = 0; a < 4; a++)
              if (q1[a]! < q0[a]!) {
                if (q1[a] === 0n) tally.fullLiquidations++;
                else tally.partialLiquidations++;
              }
          }
          if (tag === 40) {
            const sp = (side: string) => m0.readBigUInt64LE(marketAt.engine(1, `asset.stored_pos_count_${side}`));
            if (sp("long") !== 0n || sp("short") !== 0n) tally.lifecycleWithLegs++;
          }
        }
        if (tag === 5) {
          const cu = w.d.cu[`crank walk ${seed} episode ${episode} step ${step - 1} ${NAME_OF(tag)} ${what}`];
          if (cu && got === "ok") cuCrank.push(cu);
        }
        byTag.set(tag, c);
        if (tag === 5 || tag === 45 || tag === 10 || tag === 66 || tag === 67) {
          const key = `${NAME_OF(tag)} ${got === "ok" ? "ok" : got.replace(/.*code: (\d+).*/, "custom $1").replace(/.*error: (\w+) }.*/, "$1")}`;
          outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
        }
        return got;
      };
      const crank = async (kk: number, mode: number): Promise<string> => {
        const p = w.portfolios[kk]!;
        const legs = legAssets(w, p);
        let assets = legs;
        if (mode === 1) assets = [];
        else if (mode === 2) assets = [0, 1, 2];
        else if (mode === 3) assets = [...legs].reverse();
        else if (mode === 4 && legs.length) assets = [...legs, legs[0]!];
        else if (mode === 5) assets = legs.slice(0, Math.max(0, legs.length - 1));
        const share = w.d.data(w.m.market).readUInt16LE(marketAt.wrapper("liquidation_cranker_fee_share_bps"));
        const other = (kk + 1 + rng.int(3)) % 4;
        const withCranker = share !== 0 && rng.chance(50);
        const c = crankOf(w, kk, assets, withCranker ? { by: w.owners[other]!, cranker: w.portfolios[other]! } : {});
        return send(5, c.payer, c.ix, `portfolio ${kk} hints [${assets}]${withCranker ? ` cranker ${other}` : ""}`, p);
      };
      // The drifting targets of the managed marks.
      const target = [1_000_000n, 1_000_000n];
      let reserves = await Reserves.create(w);
      while (step < STEPS) {
        if (episode > 0) {
          await w.mainMarket();
          await setUpAssets(w, rng);
          reserves = await Reserves.create(w);
          target[0] = 1_000_000n;
          target[1] = 1_000_000n;
        }
        // Backing fee policies, then insurance and fresh backing on every domain (most episodes).
        if (rng.chance(80)) {
          // Half the episodes without backing-fee policies: a batch refuses any (InvalidInstruction), so only those
          // episodes fill batches.
          if (rng.chance(50)) await reserves.policies(rng);
          await reserves.fund(rng);
        }
        if (rng.chance(60)) {
          const a = w.marketAuthority();
          await send(37, a, ix.marketPolicy(w.m, a, 37, BigInt(rng.pick([0, 500, 5_000, 10_000])), w.seq(0, "liquidationFee") + 1n, w.epoch(0)));
        }
        // Portfolio 3 is also the LP of matcher trades (the author's auth matcher), enabled again whenever a trade
        // without the matcher disabled it.
        const lp: Trader = { owner: w.owners[3]!, portfolio: w.portfolios[3]!, source: w.sources[3]! };
        const mt = await lpMatcher(w.d, w.m, lp, "auth", { bid: BigInt(rng.int(30)), ask: BigInt(rng.int(30)) });
        // A trade between `i` and `j`: TradeNoCpi, a BatchTradeNoCpi (with up to two more legs of other assets, each a
        // fraction of the first), or, with `j` the LP, TradeCpi or BatchTradeCpi.
        const anyTrade = async (i: number, j: number, a: number, size: bigint, what: string): Promise<string> => {
          const kind = rng.int(10);
          const others = [0, 1, 2].filter((x) => x !== a).slice(0, rng.int(3));
          const legs = [{ asset: a, size }, ...others.map((x) => ({ asset: x, size: (size / BigInt(2 + rng.int(8))) * (rng.chance(50) ? 1n : -1n) || 1n }))];
          const base = w.d.data(w.m.market).readBigUInt64LE(marketAt.wrapper("trade_fee_base_bps"));
          const ti: Trader = { owner: w.owners[i]!, portfolio: w.portfolios[i]!, source: w.sources[i]! };
          if (kind < 2) {
            const tj: Trader = { owner: w.owners[j]!, portfolio: w.portfolios[j]!, source: w.sources[j]! };
            return send(
              66,
              ti.owner,
              batch(
                w.d,
                w.m,
                ti,
                tj,
                legs.map((l) => ({ ...l, marketId: w.marketId(l.asset), exec: effectivePrice(w, l.asset), fee: base })),
              ),
              what,
            );
          }
          if (kind < 4 && i !== 3) {
            if ((w.d.data(lp.portfolio).readBigUInt64LE(PORTFOLIO.matcherConfig + 96) & 1n) === 0n)
              await setLpMatcher(w.d, w.m, lp, mt, 10_000, 0xffff_ffff_ffff_ffffn);
            if (kind === 2) return send(10, ti.owner, tradeCpi(w.d, w.m, ti, lp, mt, { asset: a, size, fee: base, marketId: w.marketId(a) }), what);
            return send(
              67,
              ti.owner,
              batchCpi(
                w.d,
                w.m,
                ti,
                lp,
                mt,
                legs.map((l) => ({ ...l, marketId: w.marketId(l.asset), fee: base })),
              ),
              what,
            );
          }
          const t = tradeOf(w, i, j, a, size);
          return send(6, t.payer, t.ix, what);
        };
        // Phase 1: legs on the three assets, sizes up to near the initial margin.
        const opens = 10 + rng.int(20);
        for (let n = 0; n < opens && step < STEPS; n++) {
          const i = rng.int(4);
          const j = (i + 1 + rng.int(3)) % 4;
          const big = rng.chance(30);
          const size = (big ? BigInt(30 + rng.int(60)) * 1_000_000_000n : BigInt(1 + rng.int(5_000)) * 1_000_000n) * (rng.chance(50) ? 1n : -1n);
          await anyTrade(i, j, rng.int(3), size, "open");
        }
        // Phase 2: prices move, cranks keep the market current.
        const slots = 15 + rng.int(50);
        let steer = -1;
        let hold = 0;
        for (let s = 0; s < slots && step < STEPS && w.d.data(w.m.market)[marketAt.group("mode")] === 0; s++) {
          const dt = BigInt(rng.chance(85) ? 1 : 2 + rng.int(20));
          w.d.setClock(w.d.slot + dt, w.d.unixTimestamp + dt);
          // Targets drift; now and then a jump, or a steered move against one portfolio's largest position.
          if (steer < 0 && rng.chance(15)) {
            // The portfolio with the largest position (the likeliest to pass its capital).
            let most = -1n;
            for (let kk = 0; kk < 4; kk++) {
              const total = [0, 1, 2].reduce((t, a) => {
                const q = position(w, w.portfolios[kk]!, a);
                return t + (q < 0n ? -q : q);
              }, 0n);
              if (total > most) [most, steer] = [total, kk];
            }
            // Half the time the steered portfolio is left uncranked for a while, so that its loss runs past its
            // capital before anything liquidates it (a bankruptcy, its residual booked against the other side).
            hold = rng.chance(50) ? 6 + rng.int(20) : 0;
          }
          for (const a of [0, 1]) {
            let next = (target[a]! * BigInt(9_800 + rng.int(401))) / 10_000n;
            if (rng.chance(3)) next = (target[a]! * BigInt(rng.chance(50) ? 8_500 : 11_500)) / 10_000n;
            if (steer >= 0) {
              const q = position(w, w.portfolios[steer]!, a);
              if (q !== 0n) next = (target[a]! * (q > 0n ? 9_500n : 10_500n)) / 10_000n;
            }
            target[a] = next < 1_000n ? 1_000n : next;
            if (rng.chance(70)) await send(a === 1 ? 36 : 63, w.oracleAuthority(a), (await pushIx(w, a, target[a]!))!, `target ${target[a]}`);
          }
          if (hold > 0) hold--;
          if (steer >= 0 && hold === 0 && rng.chance(7)) steer = -1;
          // The hybrid's accounts: fresh most of the time, left stale, or a publish time ahead of the Clock.
          const r = rng.int(10);
          if (r < 7) w.refreshOracles(rng);
          else if (r === 7) {
            w.d.setClock(w.d.slot, w.d.unixTimestamp + 1n);
            w.refreshOracles(rng);
            w.d.setClock(w.d.slot, w.d.unixTimestamp - 1n);
          }
          // Cranks of every portfolio, mostly with their legs' hints; a second round now and then (the first crank of
          // a slot collects the maintenance fee, which invalidates the certificate).
          // While a portfolio is steered under water, its cranks are now and then left out, so that its loss runs past its
          // capital before a liquidation (a bankruptcy).
          // A second crank, when there is one, follows the first directly: another portfolio's settlement in between can
          // move the risk epoch, which makes the certificate stale again.
          for (let kk = 0; kk < 4; kk++) {
            if (kk === steer && (hold > 0 || rng.chance(30))) continue;
            for (let round = 0; round < (rng.chance(60) ? 2 : 1); round++) await crank(kk, rng.chance(75) ? 0 : rng.int(6));
          }
          const x = rng.int(100);
          if (x < 25) {
            const i = rng.int(4);
            const j = (i + 1 + rng.int(3)) % 4;
            const a = rng.int(3);
            const q = position(w, w.portfolios[i]!, a);
            const size =
              q !== 0n && rng.chance(60)
                ? (-q * BigInt(1 + rng.int(100))) / 100n || -q
                : BigInt(1 + rng.int(20_000)) * 1_000_000n * (rng.chance(50) ? 1n : -1n);
            await anyTrade(i, j, a, size === 0n ? 1n : size, "moving");
          } else if (x < 32) {
            const kk = rng.int(4);
            const p = w.portfolios[kk]!;
            await send(28, w.owners[kk]!, ix.convertReleasedPnl(w.m, w.owners[kk]!, p, w.d.portfolioId(p), w.d.positionEpoch(p), (1n << 64n) - 1n));
          } else if (x < 38) await send(48, w.stranger, ix.syncMaintenanceFee(w.m, w.portfolios[rng.int(4)]!, 0n));
          else if (x < 43) {
            const kk = rng.int(4);
            const p = w.portfolios[kk]!;
            const capital = w.d.data(p).readBigUInt64LE(portfolioAt("capital"));
            await send(
              4,
              w.owners[kk]!,
              ix.withdraw(w.m, w.owners[kk]!, p, w.sources[kk]!, w.d.portfolioId(p), w.d.portfolioSequence(p), capital / 4n + 1n),
              "",
              p,
            );
          } else if (x < 50) {
            // FinalizeResetSide where a side waits to reset (or anywhere).
            const b = w.d.data(w.m.market);
            let done = false;
            for (let a = 0; a < 3 && !done; a++)
              for (const [side, name] of [
                [0, "long"],
                [1, "short"],
              ] as const)
                if (!done && (b[marketAt.engine(a, `asset.mode_${name}`)] === 2 || rng.chance(5))) {
                  await send(45, w.stranger, ix.finalizeResetSide(w.m, a, side), `asset ${a} side ${side}`);
                  done = true;
                }
          } else if (x < 53) {
            const { payer, ix: tx } = await w.base(40, rng);
            await send(40, payer, tx);
          } else if (x < 56) {
            const tag = rng.pick([49, 58, 37] as const);
            const a = w.marketAuthority();
            const lane = tag === 37 ? "liquidationFee" : tag === 49 ? "maintenanceFee" : "feeRedirect";
            await send(tag, a, ix.marketPolicy(w.m, a, tag, BigInt(rng.int(10_001)), w.seq(0, lane) + 1n, w.epoch(0)));
          } else if (x < 60) {
            const kk = rng.int(4);
            const p = w.portfolios[kk]!;
            await send(
              3,
              w.owners[kk]!,
              ix.deposit(w.m, w.owners[kk]!, p, w.sources[kk]!, w.d.portfolioId(p), w.d.portfolioSequence(p), BigInt(1 + rng.int(1_000_000_000))),
            );
          }
          // The reserves move: top-ups and withdrawals of insurance and backing, their ledgers.
          if (rng.chance(35)) {
            const t = reserves.next(rng);
            const got = await send(t.tag, t.payer, t.ix, reserves.lastName);
            if (got === "ok") broken.push(...conservation(w));
          }
          // An asset shut down into Recovery now and then; its legs force-closed in pairs once the delay has passed.
          if (rng.chance(2)) {
            const asset = 1 + rng.int(2);
            const a = w.marketAuthority();
            await send(
              40,
              a,
              ix.assetLifecycle(w.m, a, { action: 3, asset, marketId: w.marketId(asset), epoch: w.epoch(asset), nowSlot: 1n }),
              `shutdown ${asset}`,
            );
          }
          for (let asset = 1; asset < 3; asset++) {
            if (w.d.data(w.m.market)[marketAt.engine(asset, "asset.lifecycle")] !== 5 || !rng.chance(50)) continue;
            const holders = w.portfolios.map((p, i) => ({ i, q: position(w, p, asset) })).filter((x) => x.q !== 0n);
            const l = holders.find((x) => x.q > 0n);
            const sh = holders.find((x) => x.q < 0n);
            const pa = l ?? holders[0];
            const pb = sh ?? holders[1] ?? { i: ((pa?.i ?? 0) + 1) % 4 };
            if (!pa) continue;
            const q = rng.pick([1_000_000n, 1_000_000_000n, 1n << 100n]);
            const got = await send(
              64,
              w.stranger,
              ix.forceCloseAbandoned(w.m, w.stranger, w.portfolios[pa.i]!, w.portfolios[pb.i]!, asset, q),
              `asset ${asset}`,
            );
            if (got === "ok") broken.push(...conservation(w));
          }
          const keep = await w.keepLive(rng, `crank walk ${seed} keeper`);
          if (keep !== null) step++;
        }
        // Now and then the market is resolved with its legs open: by its authority (ResolveMarket) or, its stale window
        // shortened and passed, by anyone (ResolveStalePermissionless).
        if (w.d.data(w.m.market)[marketAt.group("mode")] === 0 && step < STEPS && rng.chance(RESOLVE_PERCENT)) {
          if (rng.chance(50)) {
            if (await adminResolve(w, rng, terminal)) tally.adminResolutions++;
          } else if (await staleResolve(w, rng, terminal)) tally.staleResolutions++;
        }
        // A market in Recovery: the owners forfeit their legs, the crank resolves it.
        if (w.d.data(w.m.market)[marketAt.group("mode")] === 2 && (await recoveryRounds(w, rng, terminal)) >= 0) tally.recoveryResolutions++;
        // A Resolved market: winners, losers and bankrupt portfolios as resolved, then every portfolio closed out.
        if (w.d.data(w.m.market)[marketAt.group("mode")] === 1) {
          for (const p of w.portfolios) {
            const b = w.d.data(p);
            if (b.length < 9555) continue;
            const pnl = i128At(b, portfolioAt("pnl"));
            if (legAssets(w, p).length) tally.legsAtResolution++;
            if (pnl > 0n) tally.winnersAtResolution++;
            if (pnl < 0n) tally.losersAtResolution++;
            if (pnl < 0n && -pnl > u128At(b, portfolioAt("capital"))) tally.bankruptAtResolution++;
          }
          tally.paidOut += await closeOut(w, rng, terminal, broken);
          tally.closedMarkets++;
          // Its end: the claims and the reserves' drains, every portfolio closed, then CloseSlab to a tombstone.
          if (await windDown(w, rng, reserves, terminal, broken)) tally.closedSlabs++;
        }
        broken.push(...conservation(w));
        // Phase 3: unwind what remains, then withdraw.
        for (let round = 0; round < 6 && step < STEPS && w.d.data(w.m.market)[marketAt.group("mode")] === 0; round++) {
          w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
          for (let kk = 0; kk < 4; kk++) await crank(kk, 0);
          for (let a = 0; a < 3; a++)
            for (let i = 0; i < 4; i++) {
              const q = position(w, w.portfolios[i]!, a);
              if (q === 0n) continue;
              let other = -1;
              for (let j = 0; j < 4; j++) if (j !== i && (q > 0n ? position(w, w.portfolios[j]!, a) < 0n : position(w, w.portfolios[j]!, a) > 0n)) other = j;
              if (other < 0) continue;
              const oq = position(w, w.portfolios[other]!, a);
              const size = (q < 0n ? -q : q) < (oq < 0n ? -oq : oq) ? -q : oq;
              const t = q > 0n ? tradeOf(w, other, i, a, -size) : tradeOf(w, i, other, a, size);
              await send(6, t.payer, t.ix, "close");
            }
        }
        for (let kk = 0; kk < 4 && w.d.data(w.m.market)[marketAt.group("mode")] === 0; kk++) {
          const p = w.portfolios[kk]!;
          await send(48, w.stranger, ix.syncMaintenanceFee(w.m, p, 0n));
          const capital = w.d.data(p).readBigUInt64LE(portfolioAt("capital"));
          await send(4, w.owners[kk]!, ix.withdraw(w.m, w.owners[kk]!, p, w.sources[kk]!, w.d.portfolioId(p), w.d.portfolioSequence(p), capital), "", p);
        }
        episode++;
      }
      const per = [...byTag].map(([t, [n, ok]]) => `${NAME_OF(t)} ${ok}/${n}`).join(", ");
      cuCrank.sort((a, b) => Number(b[0] - a[0]));
      const mean = (i: 0 | 1) => (cuCrank.length ? cuCrank.reduce((s, c) => s + c[i], 0n) / BigInt(cuCrank.length) : 0n);
      console.log(
        `crank walk seed ${seed}: ${episode} episodes, ${w.d.compared} transactions compared; ${per}; produced: ${JSON.stringify(tally, (_, v) => (typeof v === "bigint" ? String(v) : v))}; leaving Live: ${[...terminal].map(([o, n]) => `${o} ×${n}`).join(", ")}; conservation failures ${broken.length}${broken.length ? ` (${broken[0]})` : ""}; outcomes: ${[...outcomes].map(([key, v]) => `${key} ×${v}`).join(", ")}; crank successes ${cuCrank.length}, mean CU ${mean(0)} reference, ${mean(1)} port; worst ${cuCrank[0]?.[0]} / ${cuCrank[0]?.[1]}`,
      );
      const cranks = byTag.get(5) ?? [0, 0];
      expect(cranks[1], `PermissionlessCrank ${cranks[1]}/${cranks[0]}`).toBeGreaterThan(cranks[0] / 10);
      expect(broken).toEqual([]);
    }, 7_200_000);
  }

  it(`mutations of cranks from snapshots with positions under water, ${MUTATIONS} transactions`, async () => {
    const seed = SEED + 4321n;
    const w = await crankWorld(seed, CRANK_MARKET);
    const rng = new Rng(seed);
    // Large opposite legs on all three assets, then the marks moved against the longs over several slots (cranked
    // once a slot), so that the snapshot holds stale certificates, deficits and a bankrupt portfolio.
    for (let n = 0; n < 6; n++) {
      const t = tradeOf(w, n % 2 === 0 ? 0 : 2, n % 2 === 0 ? 1 : 3, n % 3, BigInt(20 + rng.int(60)) * 1_000_000_000n);
      await w.d.send(`mutation world open ${n}`, t.payer, [t.ix]);
    }
    const snapshots: number[] = [];
    for (let s = 0; s < 24; s++) {
      w.d.setClock(w.d.slot + 1n, w.d.unixTimestamp + 1n);
      for (const a of [0, 1]) await pushMark(w, a, (effectivePrice(w, a) * 9_800n) / 10_000n, `mutation world push ${s}`);
      w.refreshOracles(rng);
      if (s % 2 === 0)
        for (let kk = 0; kk < 4; kk++) {
          const c = crankOf(w, kk, legAssets(w, w.portfolios[kk]!));
          await w.d.send(`mutation world crank ${s} ${kk}`, c.payer, [c.ix]);
        }
      if (s === 10 || s === 23) snapshots.push(s);
    }
    w.take();
    const tally = { sent: 0, ok: 0, kinds: [0, 0, 0] };
    const modes = [0, 0, 0];
    for (let n = 0; n < MUTATIONS; n++) {
      const kk = rng.int(4);
      const legs = legAssets(w, w.portfolios[kk]!);
      const other = (kk + 1) % 4;
      let { payer, ix: tx } = crankOf(
        w,
        kk,
        rng.chance(70) ? legs : [rng.int(3)],
        rng.chance(30) ? { by: w.owners[other]!, cranker: w.portfolios[other]! } : {},
      );
      if (rng.chance(10)) w.d.setClock(w.d.slot + BigInt(rng.int(10)));
      // One in five from the snapshot with the market in Recovery (a recorded reason) or Resolved (at the market's slot),
      // a Resolved one cranked by the portfolio's owner with the payout accounts, now and then with a hint.
      const terminalMode = rng.chance(20) ? (rng.chance(50) ? 1 : 2) : 0;
      if (terminalMode !== 0) {
        w.d.patch(w.m.market, (b) => {
          b[marketAt.group("mode")] = terminalMode;
          if (terminalMode === 2) {
            b[marketAt.group("recovery_reason")] = 1;
            b[marketAt.group("recovery_reason") + 1] = 5;
          } else b.writeBigUInt64LE(b.readBigUInt64LE(marketAt.group("current_slot")), marketAt.group("resolved_slot"));
        });
        modes[terminalMode]!++;
        if (terminalMode === 1 && rng.chance(60)) {
          payer = w.owners[kk]!;
          tx = ix.resolvedCrank(w.m, w.owners[kk]!, w.portfolios[kk]!, w.sources[kk]!, rng.chance(30) ? rng.int(3) : undefined);
        }
      }
      const kind = rng.int(3);
      let what = "";
      if (kind === 0) tx = mutate(w, rng, tx);
      else if (kind === 1) {
        const data = Buffer.from(tx.data ?? new Uint8Array());
        const size = rng.pick([1, 2, 8]);
        const at = 1 + rng.int(Math.max(1, data.length - size));
        const v = BOUNDARY[rng.int(BOUNDARY.length)]!;
        for (let b = 0; b < size && at + b < data.length; b++) data[at + b] = Number((v >> BigInt(8 * b)) & 0xffn);
        tx = { ...tx, data: new Uint8Array(data) };
      } else {
        // A field of a portfolio, the group header, an asset slot or an oracle profile set to a boundary value.
        const target = rng.chance(50) ? w.portfolios[rng.int(4)]! : w.m.market;
        let struct = "Portfolio";
        let base: number = PORTFOLIO.state;
        if (target === w.m.market) {
          const r = rng.int(4);
          const slot = rng.int(3);
          [struct, base] =
            r === 0
              ? ["GroupHeader", MARKET.group]
              : r === 1
                ? ["EngineAssetSlot", MARKET.slots + slot * MARKET.slotLen + 512]
                : r === 2
                  ? ["AssetOracleProfile", MARKET.slots + slot * MARKET.slotLen]
                  : ["WrapperConfig", MARKET.wrapper];
        }
        let rows = layout(struct);
        let row = rows[rng.int(rows.length)]!;
        let at = base + row.offset;
        for (let depth = 0; depth < 4; depth++) {
          let nested: ReturnType<typeof layout> | undefined;
          try {
            nested = layout(row.type);
          } catch {
            nested = undefined;
          }
          if (!nested || nested.length === 0) break;
          rows = nested;
          row = rows[rng.int(rows.length)]!;
          at += row.offset;
        }
        let size = 8;
        try {
          size = Math.min(16, sizeOf(row.type));
        } catch {
          size = 8;
        }
        let v = BOUNDARY[rng.int(BOUNDARY.length)]!;
        // The market's mode now and then Resolved (1) or Recovery (2), whatever the boundary value drawn.
        if (struct === "GroupHeader" && row.name === "mode" && rng.chance(50)) v = rng.chance(50) ? 1n : 2n;
        w.d.patch(target, (b) => {
          for (let i = 0; i < size && at + i < b.length; i++) b[at + i] = Number((v >> BigInt(8 * i)) & 0xffn);
        });
        what = `${struct}.${row.name}=${v}`;
      }
      const got = await w.d.send(`crank mutation ${n} ${["accounts", "data", "state " + what][kind]}`, payer, [tx]);
      tally.sent++;
      tally.kinds[kind]!++;
      if (got === "ok") tally.ok++;
      w.restore();
    }
    console.log(
      `crank mutations: ${tally.sent} transactions compared (accounts ${tally.kinds[0]}, data ${tally.kinds[1]}, state ${tally.kinds[2]}; market Resolved ${modes[1]}, in Recovery ${modes[2]}), ${tally.ok} succeeded in both; snapshot slots ${snapshots}`,
    );
    expect(tally.sent).toBe(MUTATIONS);
  }, 3_600_000);
});

/** A push of asset `a`'s managed mark (PushEwmaMark for an EWMA asset, PushAuthMark otherwise). */
async function pushIx(w: World, a: number, mark: bigint): Promise<Instruction | undefined> {
  const mode = w.d.data(w.m.market)[marketAt.profile(a, "oracle_mode")]!;
  const auth = w.oracleAuthority(a);
  return ix.pushMark(mode === 2 ? 36 : 63, w.m, auth, {
    asset: a,
    marketId: w.marketId(a),
    mark,
    sequence: w.seq(a, "oracleObservation") + 1n,
    epoch: w.epoch(a),
  });
}
