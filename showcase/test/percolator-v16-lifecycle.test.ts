// The asset lifecycle (UpdateAssetLifecycle 40), RestartAssetOracle (69) and CanonicalizeSpentBackingHistory (70) of
// the Percolator v16 port (showcase/mainnet/percolator-v16) against the reference: Percolator v16 at commit 7b110913
// (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so
// is the Rust build of those commits, not a deployed program. Every transaction is compared whole
// (percolator-v16-helpers.ts `Diff`; the market's length too: activation grows it by one slot); the port must use
// fewer compute units on each success. Success paths, the refusals in order, then a seeded numeric fuzz of the
// committed-funding accrual a shutdown makes (PERCOLATOR_V16_ACCRUAL_FUZZ, 400 by default): rates from the mark's
// premium at the bounds, gaps up to and past one segment, A, K, F and cohort epochs at their limits; the asset on
// AuthMark or (a third of the time) on the hybrid oracle (ConfigureHybridOracle reading one external leg).
//
// Permissionless activations with their fee are compared whole (the fee into market 0's insurance domains, the SPL Token
// Transfer as an inner instruction): appending past the market's first slots (each a realloc), the fee doubled from
// asset 32 on, an odd fee split between the two domains, the reuse of a retired slot, and the deposit's refusals on
// patched insurance state. A retirement that must expire a lapsed Fresh backing bucket (which only TopUpBackingBucket,
// not ported, makes) is compared on buckets written into the market, in both VMs alike.
import { type Address, type Instruction, type KeyPairSigner, AccountRole } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { Diff, HAVE_PORT, HAVE_REFERENCE, type Market, SLOT, err, errB, ix, marketAt } from "./percolator-v16-helpers.js";
import { MARKET, marketLen } from "./percolator-v16-layout.js";
import { legAt } from "./percolator-v16-oracles.js";

const E = {
  ExpectedSigner: 6,
  ExpectedWritable: 7,
  Unauthorized: 8,
  InvalidInstruction: 9,
  EngineStale: 19,
  EngineLockActive: 21,
  EngineNonProgress: 22,
  OracleStale: 27,
  AssetGenerationMismatch: 30,
} as const;
const ADL_ONE = 1_000_000_000_000_000n;
const I128_MAX = (1n << 127n) - 1n;
const ACCRUAL_FUZZ = Number(process.env.PERCOLATOR_V16_ACCRUAL_FUZZ ?? 400);
const SEED = BigInt(process.env.PERCOLATOR_FUZZ_SEED ?? "1618");
const LAPSED_FUZZ = Number(process.env.PERCOLATOR_V16_LAPSED_FUZZ ?? 300);
const ACTIVATE = 0;
const DRAIN = 1;
const RETIRE = 2;
const SHUTDOWN = 3;

const controls = (i: number) => MARKET.slots + i * MARKET.slotLen + MARKET.controlSequences;

function role(i: Instruction, at: number, r: AccountRole): Instruction {
  const accounts = [...(i.accounts ?? [])] as { address: Address; role: AccountRole }[];
  accounts[at] = { address: accounts[at]!.address, role: r };
  return { ...i, accounts: accounts as Instruction["accounts"] };
}

function setInt(b: Buffer, at: number, size: number, v: bigint): void {
  let x = v < 0n ? (1n << BigInt(8 * size)) + v : v;
  for (let i = 0; i < size; i++) {
    b[at + i] = Number(x & 0xffn);
    x >>= 8n;
  }
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: asset lifecycle, restart, spent-backing history", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });
  const u64At = (m: Market, at: number) => d.data(m.market).readBigUInt64LE(at);
  const nextId = (m: Market) => u64At(m, marketAt.group("next_market_id"));
  const idOf = (m: Market, asset: number) => u64At(m, marketAt.engine(asset, "asset.market_id"));
  const epochOf = (m: Market, asset: number) => u64At(m, controls(asset) + 16);
  const obsOf = (m: Market, asset: number) => u64At(m, controls(asset));
  /** Market lamports raised to the rent of `capacity` slots (the original reallocates and the runtime wants rent). */
  const fund = (m: Market, capacity: number) =>
    d.patch(m.market, () => {}, { lamports: d.reference.minimumBalanceForRentExemption(BigInt(marketLen(capacity))) });
  const act = (m: Market, who: KeyPairSigner, o: Partial<Parameters<typeof ix.assetLifecycle>[2]> = {}) =>
    ix.assetLifecycle(m, who, { action: ACTIVATE, asset: 0, marketId: nextId(m), epoch: 0n, nowSlot: 1n, price: 1_000_000n, ...o });

  it("activation by appending a slot: the realloc, the rent, the spare capacity, the cooldown, every check", async () => {
    d.setClock(SLOT);
    const m = await d.market({ capacity: 1 });
    const a = m.admin;
    // Without the rent of the grown account the runtime refuses it after the program returns.
    await d.send("append without the rent", a, [act(m, a, { asset: 1 })]);
    fund(m, 2);
    await d.fails(
      "append asset 1: zero insurance authority",
      a,
      [act(m, a, { asset: 1, authorities: [ZERO, a.address, a.address, a.address] })],
      err(E.InvalidInstruction),
    );
    await d.fails("append asset 1: wrong generation", a, [act(m, a, { asset: 1, marketId: nextId(m) + 1n })], err(E.AssetGenerationMismatch));
    await d.fails("append asset 2 (past the next slot)", a, [act(m, a, { asset: 2 })], err(E.InvalidInstruction));
    await d.fails("append asset 1: wrong epoch", a, [act(m, a, { asset: 1, epoch: 1n })], err(E.EngineStale));
    await d.fails("append asset 1: price 0", a, [act(m, a, { asset: 1, price: 0n })], errB("InvalidAccountData"));
    await d.fails("append asset 1: price above MAX", a, [act(m, a, { asset: 1, price: 1_000_000_000_001n })], errB("InvalidAccountData"));
    await d.ok("append asset 1 (the market grows by one slot)", a, [act(m, a, { asset: 1, price: 7n })]);
    expect(d.data(m.market).length).toBe(marketLen(2));
    fund(m, 3);
    await d.fails("append asset 2 in the cooldown slot", a, [act(m, a, { asset: 2 })], errB("InvalidAccountData"));
    d.setClock(SLOT + 1n);
    const other = await d.funded();
    await d.ok("append asset 2 with other authorities", a, [
      act(m, a, { asset: 2, authorities: [other.address, other.address, other.address, other.address] }),
    ]);
    // A market with spare capacity: no realloc.
    d.setClock(SLOT + 10n);
    const s = await d.market({ capacity: 3 });
    await d.ok("append into a spare slot", s.admin, [act(s, s.admin, { asset: 1, price: 1_000_000_000_000n })]);
    await d.fails("append: the market not writable", s.admin, [role(act(s, s.admin, { asset: 2 }), 1, AccountRole.READONLY)], err(E.ExpectedWritable));
    await d.fails("append: unsigned", other, [role(act(s, s.admin, { asset: 2 }), 0, AccountRole.WRITABLE)], err(E.ExpectedSigner));
    d.patch(s.market, (b) => (b[marketAt.group("mode")] = 1));
    await d.fails("append on a resolved market", s.admin, [act(s, s.admin, { asset: 2 })], err(E.EngineLockActive));
    d.patch(s.market, (b) => (b[marketAt.group("mode")] = 0));
    await d.ok("permissionless resolve window", s.admin, [ix.permissionlessResolve(s, s.admin, nextId(s), 5n, 1n, 1n, 0n)]);
    d.setClock(SLOT + 100n);
    await d.fails("append after the stale window matured", s.admin, [act(s, s.admin, { asset: 2 })], err(E.OracleStale));
  });

  it("drain-only, retirement, reactivation of a retired slot, and their checks", async () => {
    d.setClock(SLOT);
    const m = await d.market({ capacity: 3, args: { maxPortfolioAssets: 2 } });
    const a = m.admin;
    const stranger = await d.funded();
    const life = (o: Partial<Parameters<typeof ix.assetLifecycle>[2]>) =>
      ix.assetLifecycle(m, a, { action: DRAIN, asset: 1, marketId: idOf(m, 1), epoch: 0n, ...o });
    await d.fails(
      "drain: another signer",
      stranger,
      [ix.assetLifecycle(m, stranger, { action: DRAIN, asset: 1, marketId: 2n, epoch: 0n })],
      err(E.Unauthorized),
    );
    await d.fails("drain: a slot argument", a, [life({ nowSlot: 1n })], err(E.InvalidInstruction));
    await d.fails("drain: a price", a, [life({ price: 1n })], err(E.InvalidInstruction));
    await d.fails("drain: wrong generation", a, [life({ marketId: 9n })], err(E.AssetGenerationMismatch));
    await d.fails("drain: asset 2 (not configured)", a, [life({ asset: 2, marketId: 0n })], err(E.InvalidInstruction));
    await d.fails("action 4", a, [life({ action: 4 })], err(E.InvalidInstruction));
    await d.fails("action 255", a, [life({ action: 255 })], err(E.InvalidInstruction));
    await d.ok("drain asset 1", a, [life({})]);
    await d.ok("drain asset 1 again", a, [life({})]);
    await d.ok("drain asset 0", a, [life({ asset: 0, marketId: 1n })]);
    // Retirement.
    await d.fails("retire asset 0", a, [life({ action: RETIRE, asset: 0, marketId: 1n, nowSlot: 1n })], err(E.InvalidInstruction));
    await d.fails("retire: no slot argument", a, [life({ action: RETIRE })], err(E.InvalidInstruction));
    await d.fails("retire: a price", a, [life({ action: RETIRE, nowSlot: 1n, price: 1n })], err(E.InvalidInstruction));
    const before = d.data(m.market);
    for (const [f, v] of [
      ["asset.oi_eff_long_q", 1n],
      ["asset.stored_pos_count_short", 1n],
      ["asset.mode_long", 2n],
      ["insurance_domain_spent_long", 5n],
      ["pending_domain_loss_barrier_short", 1n],
      ["backing_long.status", 2n],
      ["source_credit_long.spent_backing_num", 1_000_000_000_000n],
      ["insurance_domain_budget_long", 3n],
    ] as const) {
      d.patch(m.market, (b) => setInt(b, marketAt.engine(1, f), 1, v));
      await d.send(`retire with ${f} = ${v}`, a, [life({ action: RETIRE, nowSlot: 1n })]);
      d.patch(m.market, (b) => before.copy(b));
    }
    await d.ok("retire asset 1", a, [life({ action: RETIRE, nowSlot: 1n })]);
    await d.ok("retire asset 1 again", a, [life({ action: RETIRE, nowSlot: 1n })]);
    await d.fails("drain a retired asset", a, [life({})], err(E.EngineLockActive));
    // Reactivation by the market authority, after the cooldown.
    const re = (o: Partial<Parameters<typeof ix.assetLifecycle>[2]> = {}) =>
      ix.assetLifecycle(m, a, { action: ACTIVATE, asset: 1, marketId: nextId(m), epoch: 0n, nowSlot: 1n, price: 5n, ...o });
    await d.fails("reactivate in the retirement slot", a, [re()], err(E.EngineLockActive));
    d.setClock(SLOT + 2n);
    await d.fails("reactivate: zero oracle authority", a, [re({ authorities: [a.address, a.address, a.address, ZERO] })], err(E.InvalidInstruction));
    await d.ok("reactivate asset 1", a, [re()]);
    await d.fails("reactivate an active asset", a, [re()], err(E.EngineLockActive));
    // Asset 0 activated in place is refused (it is Active, not empty for activation); activation binds the next id.
    await d.fails("activate asset 0 in place", a, [re({ asset: 0 })], err(E.EngineLockActive));
    await d.fails("activate asset 0 in place, its own id", a, [re({ asset: 0, marketId: 1n })], err(E.AssetGenerationMismatch));
  });

  it(`retirement with lapsed Fresh backing buckets: ${LAPSED_FUZZ} generated buckets expired, then the asset retired or refused`, async () => {
    d.setClock(SLOT);
    const m = await d.market({ capacity: 3, args: { maxPortfolioAssets: 2 } });
    const a = m.admin;
    const now = d.slot;
    const BOUND = 1_000_000_000_000n;
    const retire = ix.assetLifecycle(m, a, { action: RETIRE, asset: 1, marketId: idOf(m, 1), epoch: 0n, nowSlot: 1n });
    const before = d.data(m.market);
    const rng = new Rng(SEED + 40n);
    const get = (b: Buffer, at: number) => {
      let v = 0n;
      for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]!);
      return v;
    };
    const tally: Record<string, number> = {};
    for (let n = 0; n < LAPSED_FUZZ; n++) {
      d.patch(m.market, (b) => {
        before.copy(b);
        let freshTotal = 0n;
        for (const side of ["long", "short"]) {
          if (rng.chance(side === "long" ? 20 : 60)) continue;
          const e = (f: string) => marketAt.engine(1, f);
          // A Fresh bucket: unliened backing (an atom multiple mostly), a valid lien now and then (it becomes impaired:
          // the asset is then not empty), an expiry passed, now, or ahead; the source state matching it.
          const fresh = rng.pick([BOUND, BigInt(1 + rng.int(1_000_000)) * BOUND, BigInt(1 + rng.int(1_000_000_000)), 0n]);
          const valid = rng.chance(80) ? 0n : BigInt(1 + rng.int(1000)) * BOUND;
          const expiry = rng.pick([now, now - 1n, now - BigInt(rng.int(1_000_000)), 1n, now + 1n]);
          setInt(b, e(`backing_${side}.status`), 1, 1n);
          setInt(b, e(`backing_${side}.fresh_unliened_backing_num`), 16, fresh + (fresh + valid === 0n ? 1n : 0n));
          setInt(b, e(`backing_${side}.valid_liened_backing_num`), 16, valid);
          setInt(b, e(`backing_${side}.expiry_slot`), 8, expiry < 1n ? 1n : expiry);
          if (rng.chance(10)) setInt(b, e(`backing_${side}.utilization_fee_earnings`), 16, BigInt(rng.int(100)));
          const reserved = fresh + (fresh + valid === 0n ? 1n : 0n) + valid;
          setInt(b, e(`source_credit_${side}.fresh_reserved_backing_num`), 16, reserved);
          setInt(b, e(`source_credit_${side}.valid_liened_backing_num`), 16, valid);
          setInt(b, e(`source_credit_${side}.credit_epoch`), 8, BigInt(rng.int(5)));
          setInt(b, e(`provider_principal_${side}_num`), 16, rng.pick([0n, reserved, reserved / 2n, reserved + 5n]));
          freshTotal += reserved;
        }
        const g = (f: string) => marketAt.group(f);
        setInt(b, g("source_fresh_backing_total_num"), 16, get(b, g("source_fresh_backing_total_num")) + freshTotal - (rng.chance(5) ? 1n : 0n));
        setInt(b, g("vault"), 16, get(b, g("vault")) + freshTotal / BOUND + 1n + (rng.chance(30) ? BigInt(rng.int(1000)) : 0n));
        if (rng.chance(25)) {
          // A captured payout snapshot: the residual the expiry releases is credited to the resolved-payout ledger.
          setInt(b, g("payout_snapshot_captured"), 1, 1n);
          setInt(b, g("payout_snapshot"), 16, BigInt(rng.int(1_000_000)));
          setInt(b, g("resolved_payout_ledger.snapshot_residual"), 16, BigInt(rng.int(1_000_000)));
          setInt(b, g("resolved_payout_ledger.terminal_claim_bound_unreceipted_num"), 16, rng.chance(50) ? 0n : BigInt(rng.int(1_000_000)) * BOUND);
        }
      });
      const got = await d.send(`retire with lapsed backing ${n}`, a, [retire]);
      tally[got] = (tally[got] ?? 0) + 1;
    }
    d.patch(m.market, (b) => before.copy(b));
    console.log(`retirement with lapsed buckets: ${JSON.stringify(tally)}`);
    expect(tally.ok ?? 0).toBeGreaterThan(0);
  });

  it("shutdown into recovery, restart, spent-backing history", async () => {
    d.setClock(SLOT);
    const m = await d.market({ capacity: 3, args: { maxPortfolioAssets: 2 } });
    const a = m.admin;
    const shut = (o: Partial<Parameters<typeof ix.assetLifecycle>[2]> = {}) =>
      ix.assetLifecycle(m, a, { action: SHUTDOWN, asset: 1, marketId: idOf(m, 1), epoch: 0n, nowSlot: 1n, ...o });
    await d.fails("shutdown without a force-close delay", a, [shut()], err(E.InvalidInstruction));
    await d.ok("force-close delay", a, [ix.permissionlessResolve(m, a, nextId(m), 1_000_000n, 10n, 1n, 0n)]);
    await d.fails("shutdown: no slot argument", a, [shut({ nowSlot: 0n })], err(E.InvalidInstruction));
    await d.fails("shutdown: a price", a, [shut({ price: 1n })], err(E.InvalidInstruction));
    await d.fails("shutdown: wrong generation", a, [shut({ marketId: 1n })], err(E.AssetGenerationMismatch));
    const stranger = await d.funded();
    await d.fails(
      "shutdown: another signer",
      stranger,
      [ix.assetLifecycle(m, stranger, { action: SHUTDOWN, asset: 1, marketId: 2n, epoch: 0n, nowSlot: 1n })],
      err(E.Unauthorized),
    );
    await d.fails("shutdown: wrong epoch", a, [shut({ epoch: 3n })], err(E.EngineStale));
    await d.ok("shutdown asset 1", a, [shut()]);
    await d.ok("shutdown asset 1 again (Recovery)", a, [shut()]);
    await d.ok("shutdown asset 0", a, [shut({ asset: 0, marketId: 1n })]);
    // Restart.
    const restart = (o: Partial<Parameters<typeof ix.restartAssetOracle>[2]> = {}) =>
      ix.restartAssetOracle(m, a, { asset: 1, marketId: idOf(m, 1), price: 3_000_000n, sequence: obsOf(m, 1) + 1n, epoch: epochOf(m, 1), ...o });
    await d.fails("restart: slot argument 0", a, [restart({ nowSlot: 0n })], err(E.InvalidInstruction));
    await d.fails("restart: price 0", a, [restart({ price: 0n })], err(E.InvalidInstruction));
    await d.fails("restart: wrong generation", a, [restart({ marketId: 9n })], err(E.AssetGenerationMismatch));
    await d.fails("restart: stale sequence", a, [restart({ sequence: 0n })], err(E.EngineStale));
    await d.fails(
      "restart: another signer",
      stranger,
      [ix.restartAssetOracle(m, stranger, { asset: 1, marketId: 2n, price: 5n, sequence: 9n, epoch: 0n })],
      err(E.Unauthorized),
    );
    // Spent-backing history: none (NonProgress), then a matched round trip on asset 1's long domain.
    const canon = (who: KeyPairSigner = a) => ix.canonicalizeSpentBacking(m, who, 1, idOf(m, 1), epochOf(m, 1));
    await d.fails("canonicalize with no history", a, [canon()], err(E.EngineNonProgress));
    await d.fails("canonicalize by another signer", stranger, [canon(stranger)], err(E.Unauthorized));
    const before = d.data(m.market);
    d.patch(m.market, (b) => {
      setInt(b, marketAt.engine(1, "backing_long.consumed_liened_backing_num"), 16, 5_000_000_000_000n);
      setInt(b, marketAt.engine(1, "backing_long.status"), 1, 2n);
      setInt(b, marketAt.engine(1, "source_credit_long.provider_receivable_num"), 16, 5_000_000_000_000n);
      setInt(b, marketAt.engine(1, "source_credit_long.spent_backing_num"), 16, 6_000_000_000_000n);
    });
    await d.ok("canonicalize a matched round trip", a, [canon()]);
    d.patch(m.market, (b) => before.copy(b));
    d.patch(m.market, (b) => setInt(b, marketAt.engine(1, "source_credit_long.provider_receivable_num"), 16, 1n));
    await d.send("canonicalize an unmatched receivable", a, [canon()]);
    d.patch(m.market, (b) => before.copy(b));
    await d.ok("restart asset 1", a, [restart()]);
    await d.fails("restart an active asset", a, [restart()], err(E.EngineLockActive));
    await d.fails("canonicalize an active asset", a, [canon()], err(E.EngineLockActive));
    await d.ok("restart asset 0", a, [restart({ asset: 0, marketId: 1n, sequence: obsOf(m, 0) + 1n, epoch: epochOf(m, 0) })]);
    // Retire the restarted asset after a shutdown (Recovery → Retired), then restart is refused (not Recovery).
    await d.ok("shutdown asset 1 again", a, [shut()]);
    await d.ok("retire a recovering asset", a, [ix.assetLifecycle(m, a, { action: RETIRE, asset: 1, marketId: idOf(m, 1), epoch: 0n, nowSlot: 1n })]);
    await d.fails("restart a retired asset", a, [restart()], err(E.EngineLockActive));
  });

  it(`a seeded fuzz of ${ACCRUAL_FUZZ} shutdowns with committed funding: rates, gaps, A, K, F and epochs at their bounds`, async () => {
    d.setClock(SLOT);
    const m = await d.market({
      capacity: 3,
      args: { maxPortfolioAssets: 2, maxAbsFundingE9PerSlot: 1000n, maxAccrualDtSlots: 100n, minFundingLifetimeSlots: 100n, maxPriceMoveBpsPerSlot: 10n },
    });
    const a = m.admin;
    await d.ok("fuzz: force-close delay", a, [ix.permissionlessResolve(m, a, nextId(m), 6_000_000n, 10n, 1n, 0n)]);
    const rng = new Rng(SEED + 40n);
    const pick = <T>(xs: readonly T[]) => xs[rng.int(xs.length)]!;
    const marks = [1n, 2n, 999_999n, 1_000_000n, 1_000_001n, 2_000_000n, 1_000_000_000_000n, 999_999_999_999n];
    let ok = 0;
    let accrued = 0;
    for (let n = 0; n < ACCRUAL_FUZZ; n++) {
      const asset = rng.int(2);
      d.setClock(d.slot + BigInt(1 + rng.int(3)));
      // A managed mark for the asset at a mark (sets the asset's anchor to it at the Clock's slot).
      const mark = pick(marks);
      // AuthMark, or (a third of the time) the hybrid oracle reading one leg at the same price: both price-managed.
      const hybrid = rng.chance(33);
      const leg = legAt(rng, pick(["pyth", "switchboard", "chainlink"] as const), mark, d.unixTimestamp - 1n);
      if (hybrid) d.write(leg.key, leg.owner, leg.data);
      const cfgOk = await d.send(`fuzz ${n} configure${hybrid ? " hybrid" : ""}`, a, [
        hybrid
          ? ix.configureHybridOracle(
              m,
              a,
              {
                asset,
                marketId: idOf(m, asset),
                count: 1,
                flags: 0,
                maxStaleness: 60n,
                softStale: pick([1n, 100n]),
                halflife: 600n,
                minFee: 0n,
                invert: 0,
                unitScale: 0n,
                confBps: 0n,
                feeds: [leg.feed],
                sequence: obsOf(m, asset) + 1n,
                epoch: epochOf(m, asset),
              },
              [leg.key],
            )
          : ix.configureAuthMark(m, a, { asset, marketId: idOf(m, asset), mark, sequence: obsOf(m, asset) + 1n, epoch: epochOf(m, asset) }),
      ]);
      if (cfgOk !== "ok") continue;
      const snapshot = d.data(m.market);
      const effective = pick([mark, ...marks, BigInt(1 + rng.int(3_000_000))]);
      const dt = BigInt(pick([0, 1, 2, 50, 99, 100, 101, 1000, rng.int(150)]));
      d.patch(m.market, (b) => {
        const e = (f: string) => marketAt.engine(asset, f);
        setInt(b, e("asset.effective_price"), 8, effective);
        setInt(b, e("asset.slot_last"), 8, d.slot - dt);
        setInt(b, e("asset.oi_eff_long_q"), 16, rng.chance(85) ? BigInt(1 + rng.int(1_000_000)) : 0n);
        setInt(b, e("asset.oi_eff_short_q"), 16, rng.chance(85) ? BigInt(1 + rng.int(1_000_000)) : 0n);
        if (rng.chance(40)) setInt(b, e("asset.a_long"), 16, pick([ADL_ONE, 100_000_000_000_000n, 1n, 0n, I128_MAX, I128_MAX + 1n]));
        if (rng.chance(40)) setInt(b, e("asset.a_short"), 16, pick([ADL_ONE, 100_000_000_000_000n, 1n, 0n, I128_MAX]));
        if (rng.chance(30)) setInt(b, e("asset.k_long"), 16, pick([0n, 1n, -1n, I128_MAX, -I128_MAX, I128_MAX - 1_000_000_000n]));
        if (rng.chance(30)) setInt(b, e("asset.f_short_num"), 16, pick([0n, I128_MAX, -I128_MAX, -I128_MAX + 1_000_000n]));
        if (rng.chance(30)) setInt(b, e("asset.f_long_num"), 16, pick([0n, I128_MAX, -I128_MAX]));
        if (rng.chance(20)) setInt(b, e("asset.kf_epoch_long"), 8, pick([0n, d.slot, d.slot + 1000n]));
        if (rng.chance(20)) setInt(b, e("asset.kf_epoch_short"), 8, pick([0n, d.slot, d.slot + 1000n]));
        if (rng.chance(30)) setInt(b, e("asset.stored_pos_count_long"), 8, BigInt(rng.int(5)));
        if (rng.chance(30)) setInt(b, e("asset.stored_pos_count_short"), 8, BigInt(rng.int(5)));
        if (rng.chance(10)) setInt(b, e("asset.fund_px_last"), 8, 0n);
        if (rng.chance(10)) setInt(b, marketAt.group("funding_epoch"), 8, 0xffff_ffff_ffff_ffffn);
        if (rng.chance(10)) setInt(b, marketAt.group("resolved_payout_blocker_count"), 8, BigInt(rng.int(3)));
        if (rng.chance(15)) {
          // A pending funding boundary (before or after the Clock).
          setInt(b, marketAt.profile(asset, "funding_mark_pending_e6"), 8, pick(marks));
          setInt(b, marketAt.profile(asset, "funding_mark_pending_slot"), 8, d.slot + BigInt(rng.int(5)) - 2n);
        }
      });
      const got = await d.send(`fuzz ${n} shutdown asset ${asset} dt ${dt} mark ${mark} price ${effective}`, a, [
        ix.assetLifecycle(m, a, { action: SHUTDOWN, asset, marketId: idOf(m, asset), epoch: 0n, nowSlot: 1n }),
      ]);
      if (got === "ok") {
        ok++;
        if (d.data(m.market).readBigUInt64LE(marketAt.group("funding_epoch")) !== snapshot.readBigUInt64LE(marketAt.group("funding_epoch"))) accrued++;
      }
      // Back to the live asset for the next round.
      d.patch(m.market, (b) => snapshot.copy(b));
    }
    console.log(`accrual fuzz: ${ACCRUAL_FUZZ} shutdowns compared, ${ok} succeeded in both, ${accrued} of them accrued funding`);
    expect(accrued).toBeGreaterThan(ACCRUAL_FUZZ / 20);
  }, 600_000);

  it("permissionless activations with their fee: appends past three slots, the fee doubled from asset 32, reuse, the deposit's refusals", async () => {
    d.setClock(SLOT);
    const m = await d.market({ capacity: 2 });
    const a = m.admin;
    await d.ok("market-init fee 1001", a, [ix.marketPolicy(m, a, 59, 1001n, 1n, 0n)]);
    const creator = await d.funded();
    const source = await d.tokenAccount(m.mint, creator.address, 1_000_000n);
    const tx = (o: Partial<Parameters<typeof ix.assetLifecycle>[2]> = {}, fee = true) =>
      ix.assetLifecycle(
        m,
        creator,
        { action: ACTIVATE, asset: Number(nextId(m)) - 1, marketId: nextId(m), epoch: 0n, nowSlot: 1n, price: 1_000_000n, maxInitFee: 1001n, ...o },
        fee ? { source } : undefined,
      );
    await d.fails("permissionless: the fee above the maximum", creator, [tx({ maxInitFee: 1000n })], err(E.Unauthorized));
    await d.fails("permissionless: no token accounts", creator, [tx({}, false)], errB("NotEnoughAccountKeys"));
    await d.fails("permissionless: a nonzero epoch", creator, [tx({ epoch: 1n })], err(E.EngineStale));
    await d.fails("permissionless: wrong generation", creator, [tx({ marketId: 9n })], err(E.AssetGenerationMismatch));
    // The deposit's refusals on patched insurance state (compared whatever they answer), then restored.
    const before = d.data(m.market);
    for (const [label, edit] of [
      ["the vault at u128::MAX", (b: Buffer) => setInt(b, marketAt.group("vault"), 16, (1n << 128n) - 1n)],
      ["the insurance at u128::MAX", (b: Buffer) => setInt(b, marketAt.group("insurance"), 16, (1n << 128n) - 1n)],
      ["asset 0's long budget at u128::MAX", (b: Buffer) => setInt(b, marketAt.engine(0, "insurance_domain_budget_long"), 16, (1n << 128n) - 1n)],
      ["asset 0's short spent above its budget", (b: Buffer) => setInt(b, marketAt.engine(0, "insurance_domain_spent_short"), 16, 1n)],
      ["the remaining-budget total at u128::MAX", (b: Buffer) => setInt(b, marketAt.group("insurance_domain_budget_remaining_total"), 16, (1n << 128n) - 1n)],
      ["the remaining-budget total above the insurance", (b: Buffer) => setInt(b, marketAt.group("insurance_domain_budget_remaining_total"), 16, 1n)],
      ["asset 0's long source state out of shape", (b: Buffer) => setInt(b, marketAt.engine(0, "source_credit_long.exact_positive_claim_num"), 16, 1n)],
      ["asset 0's short bucket of another market", (b: Buffer) => setInt(b, marketAt.engine(0, "backing_short.market_id"), 8, 9n)],
      [
        "asset 0's long reservation not matching its source",
        (b: Buffer) => setInt(b, marketAt.engine(0, "insurance_reservation_long.consumed_insurance_num"), 16, 5n),
      ],
    ] as [string, (b: Buffer) => void][]) {
      d.patch(m.market, edit);
      await d.send(`permissionless deposit: ${label}`, creator, [tx()]);
      d.patch(m.market, (b) => before.copy(b));
    }
    // Appends: asset 1 into the spare slot, then 2 to 34 each growing the market by one slot; the fee doubles at 32.
    let appended = 0;
    // (A patched transaction above may have succeeded and paid its fee: the vault is not restored.)
    const vaultBefore = d.amount(m.vault);
    for (let asset = 1; asset <= 34; asset++) {
      const fee = asset >= 32 ? 2002n : 1001n;
      // The rent of the grown market (the runtime refuses the realloc without it).
      d.patch(m.market, () => {}, { lamports: d.reference.minimumBalanceForRentExemption(BigInt(marketLen(asset + 1))) });
      if (asset === 32) await d.fails("permissionless: asset 32 under the old maximum", creator, [tx({ maxInitFee: 1001n })], err(E.Unauthorized));
      await d.ok(`permissionless append asset ${asset}`, creator, [tx({ maxInitFee: fee })]);
      appended++;
      d.setClock(d.slot + 1n);
    }
    expect(d.data(m.market).length).toBe(marketLen(35));
    expect(d.amount(m.vault) - vaultBefore).toBe(31n * 1001n + 3n * 2002n);
    // A balance short of the fee.
    const poor = await d.funded();
    const poorSource = await d.tokenAccount(m.mint, poor.address, 2001n);
    await d.fails(
      "permissionless: a balance below the fee",
      poor,
      [
        ix.assetLifecycle(
          m,
          poor,
          { action: ACTIVATE, asset: 35, marketId: nextId(m), epoch: 0n, nowSlot: 1n, price: 7n, maxInitFee: 5000n },
          { source: poorSource },
        ),
      ],
      err(11),
    );
    // Reuse: asset 5 retired by the market authority, then taken again by anyone for the fee (through the reuse path).
    const id5 = d.data(m.market).readBigUInt64LE(marketAt.engine(5, "asset.market_id"));
    await d.ok("retire asset 5", a, [ix.assetLifecycle(m, a, { action: RETIRE, asset: 5, marketId: id5, epoch: 0n, nowSlot: 1n })]);
    let reused = "";
    for (let gap = 0; gap < 4 && reused !== "ok"; gap++) {
      d.setClock(d.slot + 1_000n * BigInt(gap + 1));
      reused = await d.send(`permissionless reuse of asset 5 (+${gap})`, creator, [tx({ asset: 5, maxInitFee: 1001n })]);
    }
    expect(reused).toBe("ok");
    console.log(`permissionless activations: ${appended} appends and one reuse succeeded in both`);
  });
});

const ZERO = "11111111111111111111111111111111" as Address;
