// Percolator v12.20 (showcase/mainnet/percolator) against the mainnet binary: LiquidateAtOracle and the engine work
// behind it (the touch, the full-close liquidation at the oracle price, the liquidation fee, the bad debt paid by
// insurance, and past insurance the A/K loss socialisation over the opposite side: K lowered for every open position
// there, A shrunk pro rata, the phantom-dust bound, drain-only below MIN_A_SIDE, the side resets, their epochs and the
// settlement of stale accounts), and CatchupAccrue (complete and partial catch-ups of the market clock). Every state
// comes from real instructions.
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  A,
  C,
  Diff,
  E,
  HAVE_ORIGINAL,
  type Market,
  SOL,
  type User,
  accountAt,
  builtin,
  cuSummary,
  ix,
  passiveMatcher,
  pe,
  readI128,
  readU128,
  readonly,
  replace,
  truncate,
  withData,
} from "./percolator-helpers.js";

const ADL_ONE = 1_000_000_000_000_000n;

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: LiquidateAtOracle and CatchupAccrue", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });
  afterAll(() => {
    if (process.env.PERCOLATOR_CU) console.table(cuSummary(d.rows));
  });

  async function funded(m: Market, amount: bigint, label: string): Promise<User> {
    const u = await d.user(m);
    await d.ok(`${label}: InitUser`, u.key, [ix.initUser(m, u, amount)]);
    return u;
  }
  const slab = (m: Market) => d.data(m.slab);
  const acct = (m: Market, idx: number, field: keyof typeof A) => readI128(slab(m), accountAt(idx) + A[field]);
  const u128At = (m: Market, at: number) => readU128(slab(m), at);
  /** The result the handler logs last (sol_log_64(res, 0, 0, 0, 4)). */
  const liquidated = () => d.lastLogs.includes("Program log: 0x1, 0x0, 0x0, 0x0, 0x4");

  it("full closes: healthy, flat, within the capital, and past it with the bad debt paid by insurance", async () => {
    const m = await d.market();
    const lp = await funded(m, 200n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    const bob = await funded(m, 10n * SOL, "bob");
    const ins = await d.user(m);
    await d.ok("TopUpInsurance", ins.key, [ix.topUpInsurance(m, ins, 5n * SOL)]);
    await d.ok("TradeNoCpi: alice long 9", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 900_000_000n)]);
    await d.ok("TradeNoCpi: bob long 5", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, 500_000_000n)]);
    await d.ok("LiquidateAtOracle: healthy (nothing)", alice.key, [ix.liquidate(m, alice.key, 1)]);
    expect(liquidated()).toBe(false);
    d.setClock(d.slot + 5n);
    d.setPrice(m, 92_000_000n);
    // Alice: equity 10 - 7.2 = 2.8 below 5% of 82.8; closed at the oracle, the loss and the fee paid from capital.
    await d.ok("LiquidateAtOracle: alice, within her capital", bob.key, [ix.liquidate(m, bob.key, 1)]);
    expect(liquidated()).toBe(true);
    expect(acct(m, 1, "positionBasisQ")).toBe(0n);
    expect(acct(m, 1, "capital")).toBe(10n * SOL - 7_200_000_000n - 414_000_000n);
    await d.ok("LiquidateAtOracle: alice again (flat: nothing)", bob.key, [ix.liquidate(m, bob.key, 1)]);
    expect(liquidated()).toBe(false);
    // Bob: a loss of 7.5 at 85 past a 6.75 floor... at 80 his loss (10) takes all his capital; the rest is bad debt.
    d.setClock(d.slot + 5n);
    d.setPrice(m, 78_000_000n);
    const insBefore = u128At(m, E.insurance);
    await d.ok("LiquidateAtOracle: bob, past his capital", alice.key, [ix.liquidate(m, alice.key, 2)]);
    expect(liquidated()).toBe(true);
    expect(acct(m, 2, "capital")).toBe(0n);
    expect(acct(m, 2, "pnl")).toBe(0n);
    // The fee became debt (no capital left); insurance paid the 1.0 deficit.
    expect(acct(m, 2, "feeCredits") < 0n).toBe(true);
    expect(u128At(m, E.insurance)).toBe(insBefore - 1_000_000_000n);
    expect(u128At(m, E.oiEffLongQ)).toBe(0n);
    // Both sides closed: the short side (the LP, still stored) resets; its stale position settles on its next touch.
    expect(slab(m)[E.sideModeShort]).toBe(2);
    await d.ok("SettleAccount: the LP's stale position", lp.key, [ix.settleAccount(m, 0)]);
    expect(slab(m)[E.sideModeShort]).toBe(0);
    await d.ok("Withdraw: the liquidated alice takes what is left", alice.key, [ix.withdraw(m, alice, 1, SOL)]);
  });

  it("past insurance: the loss socialised over the shorts, a reset with stale accounts, a loss past capital", async () => {
    const m = await d.market();
    const lp1 = await funded(m, 200n * SOL, "lp1");
    const alice = await funded(m, 10n * SOL, "alice");
    const lp2 = await funded(m, 2n * SOL, "lp2");
    const bob = await funded(m, 2n * SOL, "bob");
    await d.ok("TradeNoCpi: alice long 9 against lp1", alice.key, [ix.tradeNoCpi(m, alice.key, lp1.key, 0, 1, 900_000_000n)]);
    d.setClock(d.slot + 5n);
    d.setPrice(m, 70_000_000n);
    // lp2 sells to bob at the low: it gained nothing from the fall, but shares the socialised loss.
    await d.ok("TradeNoCpi: bob long 2 against lp2 at the low", bob.key, [ix.tradeNoCpi(m, bob.key, lp2.key, 2, 3, 200_000_000n)]);
    const kBefore = readI128(slab(m), E.adlCoeffShort);
    await d.ok("LiquidateAtOracle: alice, bad debt past an empty insurance", bob.key, [ix.liquidate(m, bob.key, 1)]);
    // D = 27 - 10 = 17 into K_short over OI 11 (ceil(D · A · 1e6 / OI)); A_short shrinks to 2/11.
    expect(readI128(slab(m), E.adlCoeffShort)).toBe(kBefore - (17n * SOL * ADL_ONE * 1_000_000n + 1_100_000_000n - 1n) / 1_100_000_000n);
    expect(u128At(m, E.adlMultShort)).toBe((ADL_ONE * 200_000_000n) / 1_100_000_000n);
    expect(u128At(m, E.oiEffShortQ)).toBe(200_000_000n);
    expect(u128At(m, E.phantomDustBoundShortQ)).toBe(2n + 1n);
    expect(slab(m)[E.sideModeShort]).toBe(0);
    // The last long goes too: both sides empty, the shorts (lp1, lp2) stale under a new epoch.
    d.setClock(d.slot + 5n);
    d.setPrice(m, 63_000_000n);
    await d.ok("LiquidateAtOracle: bob, the last long", lp1.key, [ix.liquidate(m, lp1.key, 3)]);
    expect(slab(m)[E.sideModeShort]).toBe(2);
    expect(slab(m)[E.sideModeLong]).toBe(0);
    expect(slab(m).readBigUInt64LE(E.staleAccountCountShort)).toBe(2n);
    expect(slab(m).readBigUInt64LE(E.adlEpochShort)).toBe(1n);
    // A reset-pending side takes no new shorts until its stale accounts settle.
    const carol = await funded(m, 10n * SOL, "carol");
    const dave = await funded(m, 10n * SOL, "dave");
    await d.fails(
      "TradeNoCpi: a new short on the reset-pending side",
      carol.key,
      [ix.tradeNoCpi(m, carol.key, dave.key, 5, 4, 10_000_000n)],
      pe("EngineRiskReductionOnlyMode"),
    );
    // lp2 settles at the frozen K: its share of the loss (about 3.1) is past its capital (2); flat, the rest is absorbed.
    await d.ok("SettleAccount: lp2, stale, a loss past its capital", lp1.key, [ix.settleAccount(m, 2)]);
    expect(acct(m, 2, "capital")).toBe(0n);
    expect(acct(m, 2, "pnl")).toBe(0n);
    expect(acct(m, 2, "positionBasisQ")).toBe(0n);
    expect(slab(m).readBigUInt64LE(E.staleAccountCountShort)).toBe(1n);
    // The last stale short (lp1) settles inside a trade: the preflight finalize reopens the side and the trade goes on.
    await d.ok("TradeNoCpi: lp1 settles, the side reopens, a new short", carol.key, [ix.tradeNoCpi(m, carol.key, lp1.key, 0, 4, 10_000_000n)]);
    expect(slab(m)[E.sideModeShort]).toBe(0);
    expect(slab(m).readBigUInt64LE(E.staleAccountCountShort)).toBe(0n);
  });

  it("drain-only: A below MIN_A_SIDE, the side shrinks only, then empties and resets", async () => {
    const m = await d.market();
    const lp = await funded(m, 300n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    const bob = await funded(m, SOL, "bob");
    const carol = await funded(m, 10n * SOL, "carol");
    await d.ok("TradeNoCpi: alice long 9.5", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 950_000_000n)]);
    await d.ok("TradeNoCpi: bob long 0.5", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, 50_000_000n)]);
    d.setClock(d.slot + 3n);
    d.setPrice(m, 89_000_000n);
    await d.ok("LiquidateAtOracle: alice (95% of the longs)", bob.key, [ix.liquidate(m, bob.key, 1)]);
    expect(u128At(m, E.adlMultShort)).toBe(ADL_ONE / 20n);
    expect(slab(m)[E.sideModeShort]).toBe(1);
    await d.fails(
      "TradeNoCpi: a new short on the drain-only side",
      carol.key,
      [ix.tradeNoCpi(m, carol.key, lp.key, 0, 3, 1_000_000n)],
      pe("EngineRiskReductionOnlyMode"),
    );
    await d.ok("TradeNoCpi: the LP's short shrinks (bob sells)", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, -20_000_000n)]);
    await d.ok("TradeNoCpi: bob closes, the drain-only side empties and resets", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, -30_000_000n)]);
    expect(u128At(m, E.oiEffShortQ)).toBe(0n);
    expect(slab(m)[E.sideModeShort]).toBe(0);
    expect(slab(m).readBigUInt64LE(E.adlEpochShort)).toBe(1n);
    expect(u128At(m, E.adlMultShort)).toBe(ADL_ONE);
    await d.ok("TradeNoCpi: shorts again after the reset", carol.key, [ix.tradeNoCpi(m, carol.key, lp.key, 0, 3, 1_000_000n)]);
  });

  it("maintenance fees synced first, a Hyperp market, the risk buffer", async () => {
    const m = await d.market({ edit: (a) => (a.maintenanceFeePerSlot = 3_000_000n) });
    const lp = await funded(m, 200n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    await d.ok("TradeNoCpi: alice long 9", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 900_000_000n)]);
    d.setPrice(m, 95_000_000n);
    await d.ok("LiquidateAtOracle: healthy at 95", lp.key, [ix.liquidate(m, lp.key, 1)]);
    expect(liquidated()).toBe(false);
    // 600 slots of fees (1.8) take her below maintenance: the fee sync before the check decides it.
    d.setClock(d.slot + 600n);
    d.setPrice(m, 95_000_000n);
    await d.ok("LiquidateAtOracle: below maintenance after the fees", lp.key, [ix.liquidate(m, lp.key, 1)]);
    expect(liquidated()).toBe(true);
    expect(slab(m)[E.sideModeShort]).toBe(2);

    const h = await d.market({
      edit: (a) => {
        a.feedId = Buffer.alloc(32);
        a.initialMarkPriceE6 = 2_000_000n;
        a.tail!.markMinFee = 10n;
      },
    });
    const hu = await d.user(h);
    const hlp = await d.lp(h, hu, 100n * SOL, passiveMatcher({ baseSpreadBps: 0, tradingFeeBps: 0 }));
    const bob = await funded(h, SOL, "bob");
    await d.ok("TradeCpi Hyperp: bob long", bob.key, [ix.tradeCpi(h, bob.key, hu.key.address, hlp, 1, 4_500_000_000n)]);
    await d.ok("LiquidateAtOracle Hyperp: healthy", bob.key, [ix.liquidate(h, bob.key, 1)]);
    // The mark falls (each push clamped by the cap, then smoothed); the index follows it, and bob goes under.
    let done = false;
    for (let i = 0; i < 60 && !done; i++) {
      d.setClock(d.slot + 40n);
      await d.ok(`PushHyperpMark ${i}`, h.admin, [ix.pushHyperpMark(h, h.admin, 1_000_000n, 0n)]);
      await d.ok(`LiquidateAtOracle Hyperp ${i}`, hu.key, [ix.liquidate(h, hu.key, 1)]);
      done = liquidated();
    }
    expect(done).toBe(true);
  });

  it("refusals", async () => {
    const m = await d.market({ edit: (a) => Object.assign(a, { minOraclePriceCapE2bps: 1_000_000n }) && (a.tail!.permissionlessResolveStaleSlots = 0n) });
    const lp = await funded(m, 100n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    const other = await d.funded();
    const l = ix.liquidate(m, alice.key, 1);
    await d.fails("LiquidateAtOracle: 3 accounts", alice.key, [truncate(l, 3)], builtin("NotEnoughAccountKeys"));
    await d.fails("LiquidateAtOracle: 5 accounts", alice.key, [{ ...l, accounts: [...l.accounts!, l.accounts![2]!] }], builtin("NotEnoughAccountKeys"));
    await d.fails("LiquidateAtOracle: slab read-only", alice.key, [readonly(l, 1)], pe("ExpectedWritable"));
    await d.fails("LiquidateAtOracle: wrong clock", alice.key, [replace(l, 2, other.address)], builtin("InvalidArgument"));
    await d.fails("LiquidateAtOracle: free slot", alice.key, [ix.liquidate(m, alice.key, 9)], pe("EngineAccountNotFound"));
    await d.fails("LiquidateAtOracle: index past 4096", alice.key, [ix.liquidate(m, alice.key, 4096)], pe("EngineAccountNotFound"));
    await d.fails("LiquidateAtOracle: short data", alice.key, [withData(l, Buffer.from([7, 1]))], builtin("InvalidInstructionData"));
    await d.fails("LiquidateAtOracle: long data", alice.key, [withData(l, Buffer.from([7, 1, 0, 0]))], builtin("InvalidInstructionData"));
    // The caller need not sign (nor own anything).
    await d.ok("LiquidateAtOracle: an unsigned caller", alice.key, [replace(l, 0, other.address)]);
    const unowned = await d.address();
    d.write(unowned, other.address, Buffer.alloc(1_525_624));
    await d.fails("LiquidateAtOracle: a slab of another owner", alice.key, [replace(l, 1, unowned)], builtin("IllegalOwner"));
    d.setPrice(m, 100_000_000n, d.unixTimestamp - 4000n);
    await d.fails("LiquidateAtOracle: stale oracle", alice.key, [l], pe("OracleStale"));
    d.setPrice(m, 100_000_000n, d.unixTimestamp, -6, 8_000_000n);
    await d.fails("LiquidateAtOracle: confidence too wide", alice.key, [l], pe("OracleConfTooWide"));
    await d.fails("CatchupAccrue: confidence too wide", alice.key, [ix.catchupAccrue(m)], pe("OracleConfTooWide"));
    d.setPrice(m, 100_000_000n);
    await d.ok("TradeNoCpi: alice long", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 500_000_000n)]);
    // Past the accrual envelope with funding inactive (the mark at the index): accrued in one step.
    d.setClock(d.slot + 10_000_001n);
    d.setPrice(m, 100_000_000n);
    await d.ok("LiquidateAtOracle across the envelope (no funding)", alice.key, [l]);
    // CatchupAccrue's refusals.
    const c = ix.catchupAccrue(m);
    await d.fails("CatchupAccrue: 2 accounts", alice.key, [truncate(c, 2)], builtin("NotEnoughAccountKeys"));
    await d.fails("CatchupAccrue: slab read-only", alice.key, [readonly(c, 0)], pe("ExpectedWritable"));
    await d.fails("CatchupAccrue: wrong clock", alice.key, [replace(c, 1, other.address)], builtin("InvalidArgument"));
    await d.fails("CatchupAccrue: data", alice.key, [withData(c, Buffer.from([31, 0]))], builtin("InvalidInstructionData"));
    await d.ok("CatchupAccrue: nothing to catch up", alice.key, [c]);
    // A resolved market.
    await d.ok("ResolveMarket", m.admin, [ix.resolveMarket(m, m.admin)]);
    await d.fails("LiquidateAtOracle: resolved", alice.key, [l], builtin("InvalidAccountData"));
    await d.fails("CatchupAccrue: resolved", alice.key, [c], builtin("InvalidAccountData"));
  });

  it("CatchupAccrue: funding past the envelope, complete and partial catch-ups", async () => {
    // No permissionless resolution (a cap floor instead), so that the clock can run 200M slots.
    const m = await d.market({
      edit: (a) => {
        a.minOraclePriceCapE2bps = 1_000_000n;
        a.tail!.permissionlessResolveStaleSlots = 0n;
      },
    });
    const lp = await funded(m, 1_000n * SOL, "lp");
    const alice = await funded(m, 100n * SOL, "alice");
    await d.ok("TradeNoCpi: alice long", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 100_000_000n)]);
    // The index moves away from the mark: funding runs.
    d.setClock(d.slot + 10n);
    d.setPrice(m, 101_000_000n);
    await d.ok("SettleAccount: the index moves", alice.key, [ix.settleAccount(m, 1)]);
    expect(slab(m).readBigUInt64LE(C.markEwmaE6)).not.toBe(slab(m).readBigUInt64LE(C.lastEffectivePriceE6));
    // A gap of 3 envelopes: an ordinary instruction catches up itself (3 chunks at the stored price).
    d.setClock(d.slot + 30_000_000n);
    d.setPrice(m, 101_000_000n);
    await d.ok("SettleAccount: three envelopes caught up inline", alice.key, [ix.settleAccount(m, 1)]);
    expect(readI128(slab(m), E.fLongNum)).not.toBe(0n);
    // More than 20 envelopes: refused (CatchupRequired); CatchupAccrue moves 20 at a time, keeping the old price.
    d.setClock(d.slot + 450_000_000n);
    d.setPrice(m, 102_000_000n);
    await d.fails("SettleAccount: 45 envelopes", alice.key, [ix.settleAccount(m, 1)], pe("CatchupRequired"));
    await d.fails("LiquidateAtOracle: 45 envelopes", alice.key, [ix.liquidate(m, alice.key, 1)], pe("CatchupRequired"));
    await d.fails("KeeperCrank: 45 envelopes", alice.key, [ix.crank(m, alice.key, 65535)], pe("CatchupRequired"));
    const last = slab(m).readBigUInt64LE(E.lastMarketSlot);
    const effective = slab(m).readBigUInt64LE(C.lastEffectivePriceE6);
    await d.ok("CatchupAccrue: partial", alice.key, [ix.catchupAccrue(m)]);
    expect(slab(m).readBigUInt64LE(E.lastMarketSlot)).toBe(last + 200_000_000n);
    expect(slab(m).readBigUInt64LE(C.lastEffectivePriceE6)).toBe(effective);
    expect(slab(m).readBigUInt64LE(C.lastGoodOracleSlot)).toBe(d.slot);
    await d.ok("CatchupAccrue: partial again", alice.key, [ix.catchupAccrue(m)]);
    await d.ok("CatchupAccrue: complete", alice.key, [ix.catchupAccrue(m)]);
    expect(slab(m).readBigUInt64LE(E.lastMarketSlot)).toBe(d.slot);
    await d.ok("SettleAccount after the catch-up", alice.key, [ix.settleAccount(m, 1)]);
  });

  it("the catch-up bounds: exactly 21 envelopes inline, exactly 20 in one CatchupAccrue", async () => {
    const m = await d.market({
      edit: (a) => {
        a.minOraclePriceCapE2bps = 1_000_000n;
        a.tail!.permissionlessResolveStaleSlots = 0n;
      },
    });
    const lp = await funded(m, 1_000n * SOL, "lp");
    const alice = await funded(m, 100n * SOL, "alice");
    await d.ok("TradeNoCpi: alice long", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 100_000_000n)]);
    d.setClock(d.slot + 10n);
    d.setPrice(m, 101_000_000n);
    await d.ok("SettleAccount: the index moves (funding runs)", alice.key, [ix.settleAccount(m, 1)]);
    // An ordinary instruction catches up 20 envelopes (10^7 slots each) and accrues the 21st itself: a gap of exactly
    // 21 envelopes passes, one slot more is CatchupRequired.
    const envelope = 10_000_000n;
    d.setClock(slab(m).readBigUInt64LE(E.lastMarketSlot) + 21n * envelope);
    d.setPrice(m, 101_000_000n);
    await d.ok("SettleAccount: exactly 21 envelopes", alice.key, [ix.settleAccount(m, 1)]);
    d.setClock(slab(m).readBigUInt64LE(E.lastMarketSlot) + 21n * envelope + 1n);
    d.setPrice(m, 101_000_000n);
    await d.fails("SettleAccount: 21 envelopes and a slot", alice.key, [ix.settleAccount(m, 1)], pe("CatchupRequired"));
    // CatchupAccrue completes a gap of exactly 20 envelopes at the fresh price (one more slot would be partial).
    await d.ok("CatchupAccrue: catch up", alice.key, [ix.catchupAccrue(m)]);
    await d.ok("CatchupAccrue: catch up again", alice.key, [ix.catchupAccrue(m)]);
    d.setClock(slab(m).readBigUInt64LE(E.lastMarketSlot) + 20n * envelope);
    d.setPrice(m, 103_000_000n);
    await d.ok("CatchupAccrue: exactly 20 envelopes (complete)", alice.key, [ix.catchupAccrue(m)]);
    expect(slab(m).readBigUInt64LE(E.lastMarketSlot)).toBe(d.slot);
    expect(slab(m).readBigUInt64LE(C.lastEffectivePriceE6)).toBe(103_000_000n);
  });

  it("the maintenance boundary: equity exactly the requirement is liquidated; A at exactly MIN_A_SIDE", async () => {
    // A long of 100 at 100 with 1.45 * 10^9 of capital; at 90 its equity is 1.45 * 10^9 - 10^9 = 4.5 * 10^8 and its
    // requirement 5% of 9 * 10^9, also 4.5 * 10^8: not above maintenance, so liquidated.
    const m = await d.market();
    const lp = await funded(m, 100n * SOL, "lp");
    const alice = await funded(m, 1_450_000_000n, "alice");
    await d.ok("TradeNoCpi: alice long 100", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 100_000_000n)]);
    d.setClock(d.slot + 2n);
    d.setPrice(m, 90_000_000n);
    await d.ok("LiquidateAtOracle: equity exactly the maintenance requirement", alice.key, [ix.liquidate(m, alice.key, 1)]);
    expect(liquidated()).toBe(true);
    // Longs of 900 and 100 against one short of 1,000; the 900 liquidated: the shorts' A becomes 10^15 * 100 / 1,000 =
    // 10^14, exactly MIN_A_SIDE, which is not below it: the side stays normal.
    const n = await d.market();
    const short = await funded(n, 1_000n * SOL, "short");
    const l1 = await funded(n, 10n * SOL, "l1");
    const l2 = await funded(n, 100n * SOL, "l2");
    await d.ok("TradeNoCpi: l1 long 900", l1.key, [ix.tradeNoCpi(n, l1.key, short.key, 0, 1, 900_000_000n)]);
    await d.ok("TradeNoCpi: l2 long 100", l2.key, [ix.tradeNoCpi(n, l2.key, short.key, 0, 2, 100_000_000n)]);
    d.setClock(d.slot + 2n);
    d.setPrice(n, 90_000_000n);
    await d.ok("LiquidateAtOracle: l1", l1.key, [ix.liquidate(n, l1.key, 1)]);
    expect(liquidated()).toBe(true);
    expect(u128At(n, E.adlMultShort)).toBe(ADL_ONE / 10n);
    expect(slab(n)[E.sideModeShort]).toBe(0);
  });
});
