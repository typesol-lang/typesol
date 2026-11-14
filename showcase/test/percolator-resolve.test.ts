// Percolator v12.20 (showcase/mainnet/percolator) against the mainnet binary: the end of a market. ResolveMarket by the
// admin (the ordinary arm at a fresh oracle or the Hyperp index with its catch-up and deviation band, the degenerate
// arm at the engine's last price for a stale or too-wide oracle, a silent Hyperp mark or the hard timeout) and
// ResolvePermissionless; then the close-out of every account (CloseAccount's resolved arm, ForceCloseResolved after its
// delay, AdminForceCloseAccount): positions settled at the terminal K deltas, losers first, winners reconciled only
// (ProgressOnly) until the market is terminal-ready, then paid at the payout haircut snapshot (below 1 after a loss past
// insurance), pending warm-up reserves cleared, fee debt swept and forgiven, LPs, sides that were drain-only or
// mid-reset at resolution; WithdrawInsurance (the terminal surplus) and WithdrawInsuranceLimited (its bps cap, the floor,
// the cooldown); every already-ported instruction on a resolved market; the teardown to CloseSlab. Every state comes
// from real instructions.
import { type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  A,
  C,
  Diff,
  E,
  HAVE_ORIGINAL,
  PROGRAM,
  SLAB_LEN,
  type InitMarketArgs,
  type Market,
  SOL,
  SYSTEM,
  TOKEN,
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
  tokenTransfer,
  truncate,
  unsigned,
  withData,
} from "./percolator-helpers.js";

const ZERO = "11111111111111111111111111111111" as Address;

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: resolution and the end of a market", () => {
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
  const used = (m: Market, idx: number) => ((slab(m).readBigUInt64LE(E.used + 8 * (idx >> 6)) >> BigInt(idx & 63)) & 1n) === 1n;
  const u128At = (m: Market, at: number) => readU128(slab(m), at);

  it("the admin resolves at a fresh price; losers, then winners, closed out; the teardown to CloseSlab", async () => {
    const m = await d.market();
    const lp = await funded(m, 200n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    const bob = await funded(m, 10n * SOL, "bob");
    const ins = await d.user(m);
    await d.ok("TopUpInsurance", ins.key, [ix.topUpInsurance(m, ins, SOL)]);
    await d.ok("TradeNoCpi: alice long 5", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 500_000_000n)]);
    await d.ok("TradeNoCpi: bob short 3", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, -300_000_000n)]);
    const adminAta = await d.tokenAccount(m.mint, m.admin.address);
    const r = ix.resolveMarket(m, m.admin);
    const other = await d.funded();
    // ResolveMarket's refusals before anything moves.
    await d.fails("ResolveMarket: 3 accounts", m.admin, [truncate(r, 3)], builtin("NotEnoughAccountKeys"));
    await d.fails("ResolveMarket: unsigned", other, [unsigned(r, 0)], pe("ExpectedSigner"));
    await d.fails("ResolveMarket: slab read-only", m.admin, [readonly(r, 1)], pe("ExpectedWritable"));
    await d.fails("ResolveMarket: not the admin", other, [ix.resolveMarket(m, other)], pe("EngineUnauthorized"));
    await d.fails("ResolveMarket: data", m.admin, [withData(r, Buffer.from([19, 0]))], builtin("InvalidInstructionData"));
    await d.fails("ResolveMarket: wrong clock", m.admin, [replace(r, 2, other.address)], builtin("InvalidArgument"));
    d.write(m.oracle, SYSTEM, Buffer.alloc(134));
    await d.fails("ResolveMarket: oracle of another owner", m.admin, [r], builtin("IllegalOwner"));
    const wrongFeed = await d.pyth({ feedId: Buffer.alloc(32, 0x11), price: 104_000_000n, expo: -6, publishTime: d.unixTimestamp });
    await d.fails("ResolveMarket: another feed", m.admin, [replace(r, 3, wrongFeed)], pe("InvalidOracleKey"));
    const unowned = await d.address();
    d.write(unowned, other.address, Buffer.alloc(1_525_624));
    await d.fails("ResolveMarket: a slab of another owner", m.admin, [replace(r, 1, unowned)], builtin("IllegalOwner"));
    // The ordinary arm: accrued to now at the fresh price (104), resolved there.
    d.setClock(d.slot + 10n);
    d.setPrice(m, 104_000_000n);
    await d.ok("ResolveMarket at 104", m.admin, [r]);
    const s = slab(m);
    expect(s[E.marketMode]).toBe(1);
    expect(s.readBigUInt64LE(E.resolvedPrice)).toBe(104_000_000n);
    expect(s.readBigUInt64LE(E.resolvedSlot)).toBe(d.slot);
    expect(u128At(m, E.oiEffLongQ)).toBe(0n);
    expect(s[E.sideModeLong]).toBe(2);
    expect(s[E.sideModeShort]).toBe(2);
    await d.fails("ResolveMarket: again", m.admin, [r], builtin("InvalidAccountData"));
    await d.fails("ResolvePermissionless: resolved", other, [ix.resolvePermissionless(m)], builtin("InvalidAccountData"));

    // Every live instruction refuses a resolved market; the crank does nothing.
    const refused: [string, KeyPairSigner, Instruction][] = [
      ["InitUser", alice.key, ix.initUser(m, alice, SOL)],
      ["InitLP", alice.key, ix.initLp(m, alice, SYSTEM, SYSTEM, SOL)],
      ["DepositCollateral", alice.key, ix.deposit(m, alice, 1, SOL)],
      ["WithdrawCollateral", alice.key, ix.withdraw(m, alice, 1, SOL)],
      ["TradeNoCpi", alice.key, ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 1n)],
      ["LiquidateAtOracle", alice.key, ix.liquidate(m, alice.key, 1)],
      ["TopUpInsurance", ins.key, ix.topUpInsurance(m, ins, SOL)],
      ["UpdateConfig", m.admin, ix.updateConfig(m, m.admin, { horizon: 500n, kBps: 100n, maxPremiumBps: 500n, maxE9PerSlot: 1000n, tvlCapMult: 0 })],
      ["SetOraclePriceCap", m.admin, ix.setOraclePriceCap(m, m.admin, 0n)],
      ["PushHyperpMark", m.admin, ix.pushHyperpMark(m, m.admin, 1_000_000n, 0n)],
      ["ReclaimEmptyAccount", alice.key, ix.reclaimEmptyAccount(m, 1)],
      ["SettleAccount", alice.key, ix.settleAccount(m, 1)],
      ["DepositFeeCredits", alice.key, ix.depositFeeCredits(m, alice, 1, 1n)],
      ["ConvertReleasedPnl", alice.key, ix.convertReleasedPnl(m, alice, 1, 1n)],
      ["CatchupAccrue", alice.key, ix.catchupAccrue(m)],
      ["WithdrawInsuranceLimited", m.admin, ix.withdrawInsuranceLimited(m, m.admin, adminAta, 1n)],
    ];
    for (const [name, payer, i] of refused) await d.fails(`${name}: resolved`, payer, [i], builtin("InvalidAccountData"));
    await d.ok("KeeperCrank: resolved (nothing to do)", other, [ix.crank(m, other, 65535, [[1, 0]])]);
    await d.fails("CloseSlab: accounts left", m.admin, [ix.closeSlab(m, adminAta)], pe("EngineInsufficientBalance"));
    await d.fails("WithdrawInsurance: accounts left", m.admin, [ix.withdrawInsurance(m, m.admin, adminAta)], builtin("InvalidAccountData"));
    // An admin burn needs a force-close delay while accounts are open (it has one).
    // ForceCloseResolved waits for resolved_slot + force_close_delay_slots (100).
    await d.fails("ForceCloseResolved: before the delay", other, [ix.forceCloseResolved(m, 2, bob.ata)], builtin("InvalidAccountData"));

    // Alice won (long from 100 to 104): reconciled, but not paid while losers remain (ProgressOnly).
    await d.ok("CloseAccount: alice, a winner before the losers (progress only)", alice.key, [ix.closeAccount(m, alice, 1)]);
    expect(used(m, 1)).toBe(true);
    expect(acct(m, 1, "positionBasisQ")).toBe(0n);
    expect(acct(m, 1, "pnl")).toBe(2n * SOL);
    expect(slab(m).readBigUInt64LE(E.staleAccountCountLong)).toBe(0n);
    // Bob lost (short 3 from 100 to 104: 1.2): closed at once with what is left.
    const bobBefore = d.amount(bob.ata);
    await d.ok("CloseAccount: bob, a loser", bob.key, [ix.closeAccount(m, bob, 2)]);
    expect(used(m, 2)).toBe(false);
    expect(d.amount(bob.ata) - bobBefore).toBe(10n * SOL - 1_200_000_000n);
    // The LP (short 2 net: lost 0.8) by the admin.
    const lpBefore = d.amount(lp.ata);
    await d.ok("AdminForceCloseAccount: the LP", m.admin, [ix.adminForceCloseAccount(m, m.admin, 0, lp.ata)]);
    expect(d.amount(lp.ata) - lpBefore).toBe(200n * SOL - 800_000_000n);
    // Terminal-ready: alice is paid in full (haircut 1: the losers paid her 2).
    const aliceBefore = d.amount(alice.ata);
    await d.ok("CloseAccount: alice, paid", alice.key, [ix.closeAccount(m, alice, 1)]);
    expect(d.amount(alice.ata) - aliceBefore).toBe(12n * SOL);
    expect(slab(m).readUInt16LE(E.numUsedAccounts)).toBe(0);
    await d.fails("CloseSlab: insurance left", m.admin, [ix.closeSlab(m, adminAta)], pe("EngineInsufficientBalance"));
    // The insurance (and any rounding residue) to the insurance authority, then the slab closed.
    await d.ok("WithdrawInsurance", m.admin, [ix.withdrawInsurance(m, m.admin, adminAta)]);
    expect(d.amount(adminAta)).toBe(SOL);
    await d.ok("WithdrawInsurance: nothing left", m.admin, [ix.withdrawInsurance(m, m.admin, adminAta)]);
    // Tokens sent to the vault without the program are stranded; CloseSlab gives them to the admin.
    await d.ok("SPL Token transfer into the vault", ins.key, [tokenTransfer(ins.ata, m.vault, ins.key, 777n)]);
    await d.fails("CloseSlab: wrong vault authority", m.admin, [replace(ix.closeSlab(m, adminAta), 3, other.address)], builtin("InvalidSeeds"));
    await d.ok("CloseSlab", m.admin, [ix.closeSlab(m, adminAta)], [m.vault, m.slab]);
    expect(d.original.getAccount(m.slab).exists).toBe(false);
    expect(d.amount(adminAta)).toBe(SOL + 777n);
  });

  it("a shortfall: a loss past insurance, the payout haircut below 1, pending reserves, fee debt, an LP", async () => {
    // Warm-up up to 1000 slots (fresh profit is reserved), a maintenance fee of 10 units a slot.
    const m = await d.market({
      edit: (a) => {
        a.hMax = 1000n;
        a.maintenanceFeePerSlot = 10n;
      },
    });
    const lpOwner = await d.user(m);
    await d.ok("InitLP", lpOwner.key, [ix.initLp(m, lpOwner, SYSTEM, SYSTEM, 20n * SOL)]);
    const alice = await funded(m, 10n * SOL, "alice");
    const carol = await funded(m, 5n * SOL, "carol");
    const dave = await funded(m, 1000n, "dave");
    const ins = await d.user(m);
    await d.ok("TopUpInsurance", ins.key, [ix.topUpInsurance(m, ins, SOL)]);
    await d.ok("TradeNoCpi: alice long 9", alice.key, [ix.tradeNoCpi(m, alice.key, lpOwner.key, 0, 1, 900_000_000n)]);
    await d.ok("TradeNoCpi: carol short 1", carol.key, [ix.tradeNoCpi(m, carol.key, lpOwner.key, 0, 2, -100_000_000n)]);
    // Carol's profit at 98 is fresh and unbacked: reserved for the warm-up (a scheduled bucket), then a pending one.
    d.setClock(d.slot + 5n);
    d.setPrice(m, 98_000_000n);
    await d.ok("SettleAccount: carol's profit reserved", carol.key, [ix.settleAccount(m, 2)]);
    d.setClock(d.slot + 5n);
    d.setPrice(m, 97_000_000n);
    await d.ok("SettleAccount: carol again (a second bucket)", carol.key, [ix.settleAccount(m, 2)]);
    expect(slab(m)[accountAt(2) + A.schedPresent]).toBe(1);
    expect(slab(m)[accountAt(2) + A.pendingPresent]).toBe(1);
    // A crash to 85, 200 slots on (still inside carol's warm-up), resolved at once: alice (long 9 from 100) loses 13.5
    // against 10 of capital.
    d.setClock(d.slot + 200n);
    d.setPrice(m, 85_000_000n);
    await d.ok("ResolveMarket at 85", m.admin, [ix.resolveMarket(m, m.admin)]);
    expect(readU128(slab(m), E.pnlMaturedPosTot)).toBe(readU128(slab(m), E.pnlPosTot));
    // Winners first: reconciled (their reserves cleared, the PnL theirs), not paid.
    await d.ok("CloseAccount: carol (progress only)", carol.key, [ix.closeAccount(m, carol, 2)]);
    expect(acct(m, 2, "reservedPnl")).toBe(0n);
    expect(slab(m)[accountAt(2) + A.schedPresent]).toBe(0);
    expect(slab(m)[accountAt(2) + A.pendingPresent]).toBe(0);
    expect(acct(m, 2, "pnl")).toBe(1_500_000_000n);
    const other = await d.funded();
    d.setClock(d.slot + 100n);
    await d.ok("ForceCloseResolved: the LP (progress only)", other, [ix.forceCloseResolved(m, 0, lpOwner.ata)]);
    expect(used(m, 0)).toBe(true);
    // Dave, flat, owes more in fees (10 a slot to the resolution slot) than his 1000 units: the rest is forgiven.
    const insuranceBefore = u128At(m, E.insurance);
    await d.ok("ForceCloseResolved: dave (fee debt forgiven)", other, [ix.forceCloseResolved(m, 3, dave.ata)]);
    expect(used(m, 3)).toBe(false);
    expect(u128At(m, E.insurance)).toBe(insuranceBefore + 1000n);
    // Alice: 13.5 lost, 10 from her capital, 1 (and the fees insurance holds) from insurance, the rest uninsured.
    // A zero payout: the owner's token account is not checked.
    const nobody = await d.tokenAccount(m.mint, other.address);
    await d.ok("AdminForceCloseAccount: alice, bankrupt (no payout, any token account)", m.admin, [ix.adminForceCloseAccount(m, m.admin, 1, nobody)]);
    expect(used(m, 1)).toBe(false);
    expect(u128At(m, E.insurance)).toBe(0n);
    // Terminal-ready now: the first winner's close takes the payout snapshot, below 1.
    const lpBefore = d.amount(lpOwner.ata);
    await d.ok("ForceCloseResolved: the LP, paid at the haircut", other, [ix.forceCloseResolved(m, 0, lpOwner.ata)]);
    const hNum = u128At(m, E.resolvedPayoutHNum);
    const hDen = u128At(m, E.resolvedPayoutHDen);
    expect(slab(m)[E.resolvedPayoutReady]).toBe(1);
    expect(hNum < hDen).toBe(true);
    const lpGain = d.amount(lpOwner.ata) - lpBefore;
    expect(lpGain > 20n * SOL && lpGain < 20n * SOL + 12_000_000_000n).toBe(true);
    await d.fails("ForceCloseResolved: a closed slot", other, [ix.forceCloseResolved(m, 0, lpOwner.ata)], pe("EngineAccountNotFound"));
    // Carol's payout at the same snapshot; her token account must be hers.
    await d.fails("CloseAccount: carol, another's token account", carol.key, [replace(ix.closeAccount(m, carol, 2), 3, nobody)], pe("InvalidTokenAccount"));
    await d.fails("ForceCloseResolved: carol, another's token account", other, [ix.forceCloseResolved(m, 2, nobody)], pe("InvalidTokenAccount"));
    await d.fails(
      "AdminForceCloseAccount: carol, another's token account",
      m.admin,
      [ix.adminForceCloseAccount(m, m.admin, 2, nobody)],
      pe("InvalidTokenAccount"),
    );
    await d.ok("CloseAccount: carol, paid at the haircut", carol.key, [ix.closeAccount(m, carol, 2)]);
    expect(slab(m).readUInt16LE(E.numUsedAccounts)).toBe(0);
    const adminAta = await d.tokenAccount(m.mint, m.admin.address);
    await d.ok("WithdrawInsurance (the haircut paid out the whole residual)", m.admin, [ix.withdrawInsurance(m, m.admin, adminAta)]);
    expect(u128At(m, E.vault)).toBe(0n);
    await d.ok("CloseSlab", m.admin, [ix.closeSlab(m, adminAta)], [m.vault, m.slab]);
  });

  /** Every open account closed: losers (and flat accounts) first, then winners, by the three resolved closes in turn. */
  async function closeOut(m: Market, owners: Map<number, User>, label: string): Promise<void> {
    const other = await d.funded();
    d.setClock(d.slot + 100n);
    const order = [...owners.keys()].sort((a, b) => (acct(m, a, "pnl") > acct(m, b, "pnl") ? 1 : -1));
    let n = 0;
    for (const idx of order) {
      const u = owners.get(idx)!;
      const how = n++ % 3;
      if (how === 0) await d.ok(`${label}: CloseAccount ${idx}`, u.key, [ix.closeAccount(m, u, idx)]);
      else if (how === 1) await d.ok(`${label}: ForceCloseResolved ${idx}`, other, [ix.forceCloseResolved(m, idx, u.ata)]);
      else await d.ok(`${label}: AdminForceCloseAccount ${idx}`, m.admin, [ix.adminForceCloseAccount(m, m.admin, idx, u.ata)]);
    }
    // Winners reconciled before the last loser were only reconciled: close what is still open.
    for (const idx of order)
      if (used(m, idx)) await d.ok(`${label}: CloseAccount ${idx} (paid)`, owners.get(idx)!.key, [ix.closeAccount(m, owners.get(idx)!, idx)]);
    expect(slab(m).readUInt16LE(E.numUsedAccounts)).toBe(0);
    const adminAta = await d.tokenAccount(m.mint, m.admin.address);
    await d.ok(`${label}: WithdrawInsurance`, m.admin, [ix.withdrawInsurance(m, m.admin, adminAta)]);
    await d.ok(`${label}: CloseSlab`, m.admin, [ix.closeSlab(m, adminAta)], [m.vault, m.slab]);
  }

  it("sides drain-only or mid-reset at resolution", async () => {
    // Drain-only: alice's liquidation leaves the shorts' A below MIN_A_SIDE.
    const m = await d.market();
    const owners = new Map<number, User>();
    owners.set(0, await funded(m, 300n * SOL, "lp"));
    owners.set(1, await funded(m, 10n * SOL, "alice"));
    owners.set(2, await funded(m, SOL, "bob"));
    owners.set(3, await funded(m, 10n * SOL, "carol"));
    const [lp, alice, bob] = [owners.get(0)!, owners.get(1)!, owners.get(2)!];
    await d.ok("TradeNoCpi: alice long 9.5", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 950_000_000n)]);
    await d.ok("TradeNoCpi: bob long 0.5", bob.key, [ix.tradeNoCpi(m, bob.key, lp.key, 0, 2, 50_000_000n)]);
    d.setClock(d.slot + 3n);
    d.setPrice(m, 89_000_000n);
    await d.ok("LiquidateAtOracle: alice", bob.key, [ix.liquidate(m, bob.key, 1)]);
    expect(slab(m)[E.sideModeShort]).toBe(1);
    d.setClock(d.slot + 3n);
    d.setPrice(m, 91_000_000n);
    await d.ok("ResolveMarket: the shorts drain-only", m.admin, [ix.resolveMarket(m, m.admin)]);
    expect(slab(m)[E.sideModeShort]).toBe(2);
    expect(slab(m).readBigUInt64LE(E.staleAccountCountShort)).toBe(1n);
    await closeOut(m, owners, "drain-only");

    // Mid-reset: both longs liquidated past insurance; the shorts reset with two stale accounts (lp2's loss past its
    // capital), resolved before they settle.
    const r = await d.market();
    const o2 = new Map<number, User>();
    o2.set(0, await funded(r, 200n * SOL, "lp1"));
    o2.set(1, await funded(r, 10n * SOL, "alice"));
    o2.set(2, await funded(r, 2n * SOL, "lp2"));
    o2.set(3, await funded(r, 2n * SOL, "bob"));
    await d.ok("TradeNoCpi: alice long 9 against lp1", o2.get(1)!.key, [ix.tradeNoCpi(r, o2.get(1)!.key, o2.get(0)!.key, 0, 1, 900_000_000n)]);
    d.setClock(d.slot + 5n);
    d.setPrice(r, 70_000_000n);
    await d.ok("TradeNoCpi: bob long 2 against lp2", o2.get(3)!.key, [ix.tradeNoCpi(r, o2.get(3)!.key, o2.get(2)!.key, 2, 3, 200_000_000n)]);
    await d.ok("LiquidateAtOracle: alice past insurance", o2.get(3)!.key, [ix.liquidate(r, o2.get(3)!.key, 1)]);
    d.setClock(d.slot + 5n);
    d.setPrice(r, 63_000_000n);
    await d.ok("LiquidateAtOracle: bob, the last long", o2.get(0)!.key, [ix.liquidate(r, o2.get(0)!.key, 3)]);
    expect(slab(r)[E.sideModeShort]).toBe(2);
    const epochShort = slab(r).readBigUInt64LE(E.adlEpochShort);
    d.setClock(d.slot + 5n);
    d.setPrice(r, 66_000_000n);
    await d.ok("ResolveMarket: the shorts mid-reset", r.admin, [ix.resolveMarket(r, r.admin)]);
    // The reset-pending side keeps its epoch and gets no terminal delta; the empty long side reopens at once.
    expect(slab(r).readBigUInt64LE(E.adlEpochShort)).toBe(epochShort);
    expect(readI128(slab(r), E.resolvedKShortTerminalDelta)).toBe(0n);
    expect(slab(r)[E.sideModeLong]).toBe(0);
    expect(slab(r).readBigUInt64LE(E.staleAccountCountShort)).toBe(2n);
    await closeOut(r, o2, "mid-reset");
  });

  it("Hyperp: the ordinary arm (a terminal delta), the deviation band, a silent mark (degenerate)", async () => {
    const hyperp =
      (dev: bigint, staleness = 3600n) =>
      (a: InitMarketArgs) => {
        a.feedId = Buffer.alloc(32);
        a.initialMarkPriceE6 = 2_000_000n;
        a.tail!.markMinFee = 10n;
        a.resolvePriceDeviationBps = dev;
        a.maxStalenessSecs = staleness;
      };
    const open = async (h: Market) => {
      const owners = new Map<number, User>();
      const hu = await d.user(h);
      const hlp = await d.lp(h, hu, 100n * SOL, passiveMatcher({ baseSpreadBps: 0, tradingFeeBps: 0 }));
      owners.set(0, hu);
      const bob = await funded(h, SOL, "bob");
      owners.set(1, bob);
      const carol = await funded(h, 2n * SOL, "carol");
      owners.set(2, carol);
      await d.ok("TradeCpi Hyperp: bob long", bob.key, [ix.tradeCpi(h, bob.key, hu.key.address, hlp, 1, 4_000_000_000n)]);
      await d.ok("TradeCpi Hyperp: carol short", carol.key, [ix.tradeCpi(h, carol.key, hu.key.address, hlp, 2, -3_000_000_000n)]);
      return owners;
    };
    // The mark pushed 100 slots on: the EWMA moves half way, the index is flushed toward the old mark only.
    const h = await d.market({ edit: hyperp(100n) });
    const o = await open(h);
    d.setClock(d.slot + 100n);
    await d.ok("PushHyperpMark up", h.admin, [ix.pushHyperpMark(h, h.admin, 2_100_000n, 0n)]);
    await d.ok("ResolveMarket Hyperp at the mark", h.admin, [ix.resolveMarket(h, h.admin)]);
    const s = slab(h);
    expect(s.readBigUInt64LE(E.resolvedPrice)).toBe(s.readBigUInt64LE(C.markEwmaE6));
    expect(s.readBigUInt64LE(E.resolvedLivePrice)).toBe(s.readBigUInt64LE(C.lastEffectivePriceE6));
    expect(readI128(s, E.resolvedKLongTerminalDelta)).not.toBe(0n);
    expect(readI128(s, E.resolvedKShortTerminalDelta)).toBe(-readI128(s, E.resolvedKLongTerminalDelta));
    await closeOut(h, o, "Hyperp");
    // The same with a band of 10 bps: the mark is past it.
    const narrow = await d.market({ edit: hyperp(10n) });
    await open(narrow);
    d.setClock(d.slot + 100n);
    await d.ok("PushHyperpMark up (narrow band)", narrow.admin, [ix.pushHyperpMark(narrow, narrow.admin, 2_100_000n, 0n)]);
    await d.fails("ResolveMarket: the mark past the band", narrow.admin, [ix.resolveMarket(narrow, narrow.admin)], pe("EngineOverflow"));
    // A mark silent for more than 3 · max_staleness_secs slots (50 · 3): the degenerate arm, at P_last with the
    // mark as the resolution price.
    const q = await d.market({ edit: hyperp(10_000n, 50n) });
    const oq = await open(q);
    d.setClock(d.slot + 100n);
    await d.ok("PushHyperpMark (silent after)", q.admin, [ix.pushHyperpMark(q, q.admin, 2_050_000n, 0n)]);
    d.setClock(d.slot + 151n);
    const pLast = slab(q).readBigUInt64LE(E.lastOraclePrice);
    const lastMarketSlot = slab(q).readBigUInt64LE(E.lastMarketSlot);
    await d.ok("ResolveMarket Hyperp, the mark silent (degenerate)", q.admin, [ix.resolveMarket(q, q.admin)]);
    // Not accrued (the price and F as they were), resolved at the mark with P_last as the live price.
    expect(slab(q).readBigUInt64LE(E.resolvedLivePrice)).toBe(pLast);
    expect(slab(q).readBigUInt64LE(E.lastOraclePrice)).toBe(pLast);
    expect(slab(q).readBigUInt64LE(E.resolvedPrice)).toBe(slab(q).readBigUInt64LE(C.markEwmaE6));
    expect(slab(q).readBigUInt64LE(E.lastMarketSlot)).toBe(d.slot);
    expect(lastMarketSlot < d.slot).toBe(true);
    await closeOut(q, oq, "Hyperp silent");
  });

  it("the degenerate arm: a stale or too-wide oracle, the hard timeout; ResolvePermissionless", async () => {
    const setup = async (edit?: (a: InitMarketArgs) => void) => {
      const m = await d.market({ edit });
      const owners = new Map<number, User>();
      owners.set(0, await funded(m, 100n * SOL, "lp"));
      owners.set(1, await funded(m, 10n * SOL, "alice"));
      await d.ok("TradeNoCpi: alice long 4", owners.get(1)!.key, [ix.tradeNoCpi(m, owners.get(1)!.key, owners.get(0)!.key, 0, 1, 400_000_000n)]);
      d.setClock(d.slot + 20n);
      return { m, owners };
    };
    // A stale oracle: resolved at the engine's last price (100), not at the stale reading.
    const a = await setup();
    d.setPrice(a.m, 120_000_000n, d.unixTimestamp - 4000n);
    await d.ok("ResolveMarket: stale oracle (degenerate)", a.m.admin, [ix.resolveMarket(a.m, a.m.admin)]);
    expect(slab(a.m).readBigUInt64LE(E.resolvedPrice)).toBe(100_000_000n);
    await closeOut(a.m, a.owners, "stale");
    // A confidence interval past the filter: the same.
    const b = await setup();
    d.setPrice(b.m, 97_000_000n, d.unixTimestamp, -6, 9_000_000n);
    await d.ok("ResolveMarket: too-wide oracle (degenerate)", b.m.admin, [ix.resolveMarket(b.m, b.m.admin)]);
    expect(slab(b.m).readBigUInt64LE(E.resolvedPrice)).toBe(100_000_000n);
    await closeOut(b.m, b.owners, "wide");
    // An observation no newer than the last: the stored price stands for it (ordinary arm, no funding moved).
    const c = await setup();
    const published = slab(c.m).readBigInt64LE(C.lastOraclePublishTime);
    d.setPrice(c.m, 130_000_000n, published);
    await d.ok("ResolveMarket: an old observation (the stored price)", c.m.admin, [ix.resolveMarket(c.m, c.m.admin)]);
    expect(slab(c.m).readBigUInt64LE(E.resolvedPrice)).toBe(100_000_000n);
    await closeOut(c.m, c.owners, "old observation");
    // The hard timeout (no fresh price for 5000 slots): the admin's resolution takes the degenerate arm too, and
    // anyone may resolve.
    const t = await setup();
    const other = await d.funded();
    const p = ix.resolvePermissionless(t.m);
    await d.fails("ResolvePermissionless: not stale yet", other, [p], pe("OracleStale"));
    await d.fails("ResolvePermissionless: 1 account", other, [truncate(p, 1)], builtin("NotEnoughAccountKeys"));
    await d.fails("ResolvePermissionless: slab read-only", other, [readonly(p, 0)], pe("ExpectedWritable"));
    await d.fails("ResolvePermissionless: wrong clock", other, [replace(p, 1, other.address)], builtin("InvalidArgument"));
    await d.fails("ResolvePermissionless: data", other, [withData(p, Buffer.from([29, 1]))], builtin("InvalidInstructionData"));
    d.setClock(d.slot + 4979n);
    d.setPrice(t.m, 90_000_000n);
    await d.fails("ResolvePermissionless: one slot short", other, [p], pe("OracleStale"));
    d.setClock(d.slot + 1n);
    d.setPrice(t.m, 90_000_000n);
    const t2 = await setup();
    d.setClock(d.slot + 5000n);
    d.setPrice(t2.m, 90_000_000n);
    await d.ok("ResolveMarket: past the hard timeout (degenerate, a fresh price ignored)", t2.m.admin, [ix.resolveMarket(t2.m, t2.m.admin)]);
    expect(slab(t2.m).readBigUInt64LE(E.resolvedPrice)).toBe(100_000_000n);
    expect(slab(t2.m).readBigUInt64LE(C.hyperpMarkE6)).toBe(100_000_000n);
    await d.ok("ResolvePermissionless", other, [p]);
    expect(slab(t.m)[E.marketMode]).toBe(1);
    expect(slab(t.m).readBigUInt64LE(E.resolvedPrice)).toBe(100_000_000n);
    await d.fails("ResolvePermissionless: again", other, [p], builtin("InvalidAccountData"));
    await closeOut(t.m, t.owners, "permissionless");
    await closeOut(t2.m, t2.owners, "timeout");
    // Without a staleness window (a price-cap floor instead) permissionless resolution is off.
    const off = await setup((x) => {
      x.minOraclePriceCapE2bps = 1_000_000n;
      x.tail!.permissionlessResolveStaleSlots = 0n;
    });
    await d.fails("ResolvePermissionless: turned off", other, [ix.resolvePermissionless(off.m)], pe("InvalidConfigParam"));
    d.setClock(d.slot + 1_000_000n);
    await d.fails("ResolvePermissionless: turned off, long silent", other, [ix.resolvePermissionless(off.m)], pe("InvalidConfigParam"));
  });

  it("ResolveMarket catches up the market clock; past 20 envelopes it needs CatchupAccrue first", async () => {
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
    d.setClock(d.slot + 450_000_000n);
    d.setPrice(m, 101_000_000n);
    await d.fails("ResolveMarket: 45 envelopes", m.admin, [ix.resolveMarket(m, m.admin)], pe("CatchupRequired"));
    await d.ok("CatchupAccrue: partial", alice.key, [ix.catchupAccrue(m)]);
    await d.ok("CatchupAccrue: partial again", alice.key, [ix.catchupAccrue(m)]);
    // Five envelopes left: caught up inline, then the final accrual at the fresh price.
    await d.ok("ResolveMarket: the rest caught up inline", m.admin, [ix.resolveMarket(m, m.admin)]);
    expect(slab(m).readBigUInt64LE(E.lastMarketSlot)).toBe(d.slot);
    await closeOut(
      m,
      new Map([
        [0, lp],
        [1, alice],
      ]),
      "caught up",
    );
  });

  it("the resolved closes' refusals; UpdateAuthority on a resolved market", async () => {
    const m = await d.market();
    const lp = await funded(m, 100n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    const other = await d.funded();
    await d.ok("TradeNoCpi: alice long", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 300_000_000n)]);
    const f = ix.forceCloseResolved(m, 1, alice.ata);
    const af = ix.adminForceCloseAccount(m, m.admin, 1, alice.ata);
    await d.fails("ForceCloseResolved: live market", other, [f], builtin("InvalidAccountData"));
    await d.fails("AdminForceCloseAccount: live market", m.admin, [af], builtin("InvalidAccountData"));
    d.setClock(d.slot + 5n);
    d.setPrice(m, 95_000_000n);
    await d.ok("ResolveMarket", m.admin, [ix.resolveMarket(m, m.admin)]);
    d.setClock(d.slot + 100n);
    const vaultPda = 4;
    for (const [label, i, payer, err] of [
      ["ForceCloseResolved: 6 accounts", truncate(f, 6), other, builtin("NotEnoughAccountKeys")],
      ["ForceCloseResolved: slab read-only", readonly(f, 0), other, pe("ExpectedWritable")],
      ["ForceCloseResolved: wrong token program", replace(f, 4, SYSTEM), other, pe("InvalidTokenProgram")],
      ["ForceCloseResolved: wrong clock", replace(f, 5, other.address), other, builtin("InvalidArgument")],
      ["ForceCloseResolved: wrong vault", replace(f, 1, alice.ata), other, pe("InvalidVaultAta")],
      ["ForceCloseResolved: wrong vault authority", replace(f, 3, other.address), other, builtin("InvalidArgument")],
      ["ForceCloseResolved: free slot", ix.forceCloseResolved(m, 7, alice.ata), other, pe("EngineAccountNotFound")],
      ["ForceCloseResolved: index past 4096", ix.forceCloseResolved(m, 4096, alice.ata), other, pe("EngineAccountNotFound")],
      ["ForceCloseResolved: short data", withData(f, Buffer.from([30, 1])), other, builtin("InvalidInstructionData")],
      ["AdminForceCloseAccount: 7 accounts", truncate(af, 7), m.admin, builtin("NotEnoughAccountKeys")],
      ["AdminForceCloseAccount: unsigned", unsigned(af, 0), other, pe("ExpectedSigner")],
      ["AdminForceCloseAccount: not the admin", ix.adminForceCloseAccount(m, other, 1, alice.ata), other, pe("EngineUnauthorized")],
      ["AdminForceCloseAccount: slab read-only", readonly(af, 1), m.admin, pe("ExpectedWritable")],
      ["AdminForceCloseAccount: wrong token program", replace(af, 5, SYSTEM), m.admin, pe("InvalidTokenProgram")],
      ["AdminForceCloseAccount: wrong vault", replace(af, 2, alice.ata), m.admin, pe("InvalidVaultAta")],
      ["AdminForceCloseAccount: wrong vault authority", replace(af, vaultPda, other.address), m.admin, builtin("InvalidArgument")],
      ["AdminForceCloseAccount: wrong clock", replace(af, 6, other.address), m.admin, builtin("InvalidArgument")],
      ["AdminForceCloseAccount: free slot", ix.adminForceCloseAccount(m, m.admin, 9, alice.ata), m.admin, pe("EngineAccountNotFound")],
      ["CloseAccount: resolved, not the owner", replace(ix.closeAccount(m, alice, 1), 0, other.address), alice.key, pe("ExpectedSigner")],
      ["CloseAccount: resolved, another's token account", replace(ix.closeAccount(m, alice, 1), 3, lp.ata), alice.key, pe("InvalidTokenAccount")],
      ["CloseAccount: resolved, free slot", ix.closeAccount(m, alice, 9), alice.key, pe("EngineAccountNotFound")],
    ] as [string, Instruction, KeyPairSigner, string][])
      await d.fails(label, payer, [i], err);
    // The slab checks, for each of the six: another owner's, the wrong length, not initialized.
    const fresh = await d.newMarket();
    const wrongLen = await d.address();
    d.write(wrongLen, PROGRAM, Buffer.alloc(1000));
    const foreign = await d.address();
    d.write(foreign, other.address, Buffer.alloc(SLAB_LEN));
    const ata0 = await d.tokenAccount(m.mint, m.admin.address);
    const six: [string, KeyPairSigner, (x: Market) => Instruction][] = [
      ["ResolveMarket", m.admin, (x) => ix.resolveMarket(x, m.admin)],
      ["ResolvePermissionless", other, (x) => ix.resolvePermissionless(x)],
      ["ForceCloseResolved", other, (x) => ix.forceCloseResolved(x, 1, alice.ata)],
      ["AdminForceCloseAccount", m.admin, (x) => ix.adminForceCloseAccount(x, m.admin, 1, alice.ata)],
      ["WithdrawInsurance", m.admin, (x) => ix.withdrawInsurance(x, m.admin, ata0)],
      ["WithdrawInsuranceLimited", m.admin, (x) => ix.withdrawInsuranceLimited(x, m.admin, ata0, 1n)],
    ];
    for (const [name, payer, build] of six) {
      await d.fails(`${name}: not initialized`, payer, [build({ ...fresh, admin: m.admin })], pe("NotInitialized"));
      await d.fails(`${name}: slab of another owner`, payer, [build({ ...m, slab: foreign })], builtin("IllegalOwner"));
      await d.fails(`${name}: slab of the wrong length`, payer, [build({ ...m, slab: wrongLen })], pe("InvalidSlabLen"));
    }
    // The LP won: reconciled, not paid, while alice (a loser) is open.
    await d.ok("AdminForceCloseAccount: the LP, a winner before the loser (progress only)", m.admin, [ix.adminForceCloseAccount(m, m.admin, 0, lp.ata)]);
    expect(used(m, 0)).toBe(true);
    expect(acct(m, 0, "positionBasisQ")).toBe(0n);
    // The LP's own token account but alice's slot: not hers to close.
    const lpOwnSlot = ix.closeAccount(m, { key: lp.key, ata: lp.ata }, 1);
    await d.fails("CloseAccount: resolved, another owner's slot", lp.key, [lpOwnSlot], pe("EngineUnauthorized"));
    // Burning the admin of a resolved market with accounts left needs the force-close delay (it has one).
    const next = await d.funded();
    await d.ok("UpdateAuthority: admin to next (resolved)", m.admin, [ix.updateAuthority(m, m.admin, 0, next.address, next)]);
    await d.fails("AdminForceCloseAccount: the old admin", m.admin, [af], pe("EngineUnauthorized"));
    await d.ok("AdminForceCloseAccount: the new admin", next, [ix.adminForceCloseAccount({ ...m, admin: next }, next, 1, alice.ata)]);
    await d.ok("UpdateAuthority: admin burned (resolved, accounts left, a delay)", next, [ix.updateAuthority(m, next, 0, ZERO)]);
    await d.fails("ResolveMarket: the admin burned", next, [ix.resolveMarket(m, next)], pe("EngineUnauthorized"));
    await d.fails(
      "AdminForceCloseAccount: the admin burned",
      next,
      [ix.adminForceCloseAccount({ ...m, admin: next }, next, 0, lp.ata)],
      pe("EngineUnauthorized"),
    );
    await d.ok("ForceCloseResolved: the LP after the burn", other, [ix.forceCloseResolved(m, 0, lp.ata)]);
    const ata = await d.tokenAccount(m.mint, m.admin.address);
    // The insurance authority is still the first admin; with the admin burned the slab can never be closed.
    await d.ok("WithdrawInsurance after the admin burn", m.admin, [ix.withdrawInsurance(m, m.admin, ata)]);
    await d.fails("CloseSlab: admin burned", next, [ix.closeSlab({ ...m, admin: next }, ata)], pe("EngineUnauthorized"));

    // Without a force-close delay: ForceCloseResolved is off, and the admin cannot be burned while accounts are open.
    const n = await d.market({
      edit: (a) => {
        a.minOraclePriceCapE2bps = 1_000_000n;
        a.tail!.permissionlessResolveStaleSlots = 0n;
        a.tail!.forceCloseDelaySlots = 0n;
      },
    });
    const bob = await funded(n, SOL, "bob");
    await d.ok("ResolveMarket (no delay)", n.admin, [ix.resolveMarket(n, n.admin)]);
    await d.fails("ForceCloseResolved: no delay configured", other, [ix.forceCloseResolved(n, 0, bob.ata)], pe("InvalidConfigParam"));
    await d.fails("UpdateAuthority: admin burn, accounts left, no delay", n.admin, [ix.updateAuthority(n, n.admin, 0, ZERO)], pe("InvalidConfigParam"));
    await d.ok("CloseAccount: bob", bob.key, [ix.closeAccount(n, bob, 0)]);
    await d.ok("UpdateAuthority: admin burn, no accounts", n.admin, [ix.updateAuthority(n, n.admin, 0, ZERO)]);
  });

  it("WithdrawInsurance and WithdrawInsuranceLimited", async () => {
    // 10% of the balance per call, every 50 slots.
    const m = await d.market({
      edit: (a) => {
        a.tail!.insuranceWithdrawMaxBps = 1000;
        a.tail!.insuranceWithdrawCooldownSlots = 50n;
      },
    });
    const ins = await d.user(m);
    await d.ok("TopUpInsurance 10", ins.key, [ix.topUpInsurance(m, ins, 10n * SOL)]);
    const alice = await funded(m, 5n * SOL, "alice");
    const ata = await d.tokenAccount(m.mint, m.admin.address);
    const other = await d.funded();
    const otherAta = await d.tokenAccount(m.mint, other.address);
    const l = (amount: bigint, signer = m.admin, to = ata) => ix.withdrawInsuranceLimited(m, signer, to, amount);
    for (const [label, i, payer, err] of [
      ["6 accounts", truncate(l(1n), 6), m.admin, builtin("NotEnoughAccountKeys")],
      ["unsigned", unsigned(l(1n), 0), other, pe("ExpectedSigner")],
      ["slab read-only", readonly(l(1n), 1), m.admin, pe("ExpectedWritable")],
      ["wrong token program", replace(l(1n), 4, SYSTEM), m.admin, pe("InvalidTokenProgram")],
      ["not the operator", l(1n, other, otherAta), other, pe("EngineUnauthorized")],
      ["wrong clock", replace(l(1n), 6, other.address), m.admin, builtin("InvalidArgument")],
      ["amount 0", l(0n), m.admin, builtin("InvalidArgument")],
      ["above 10%", l(SOL + 1n), m.admin, pe("InsuranceWithdrawCapExceeded")],
      ["wrong vault", replace(l(1n), 3, ata), m.admin, pe("InvalidVaultAta")],
      ["another's token account", l(1n, m.admin, otherAta), m.admin, pe("InvalidTokenAccount")],
      ["wrong vault authority", replace(l(1n), 5, other.address), m.admin, builtin("InvalidArgument")],
      ["short data", withData(l(1n), Buffer.from([23, 1])), m.admin, builtin("InvalidInstructionData")],
    ] as [string, Instruction, KeyPairSigner, string][])
      await d.fails(`WithdrawInsuranceLimited: ${label}`, payer, [i], err);
    await d.ok("WithdrawInsuranceLimited: 10%", m.admin, [l(SOL)]);
    expect(d.amount(ata)).toBe(SOL);
    expect(slab(m).readBigUInt64LE(C.lastInsuranceWithdrawSlot)).toBe(d.slot);
    await d.fails("WithdrawInsuranceLimited: the cooldown", m.admin, [l(1n)], pe("InsuranceWithdrawCooldown"));
    d.setClock(d.slot + 49n);
    await d.fails("WithdrawInsuranceLimited: one slot short", m.admin, [l(1n)], pe("InsuranceWithdrawCooldown"));
    d.setClock(d.slot + 1n);
    await d.fails("WithdrawInsuranceLimited: 10% of 9, and one more", m.admin, [l(900_000_001n)], pe("InsuranceWithdrawCapExceeded"));
    await d.ok("WithdrawInsuranceLimited: 10% of 9", m.admin, [l(900_000_000n)]);
    // Another operator; the admin no longer is one.
    const op = await d.funded();
    const opAta = await d.tokenAccount(m.mint, op.address);
    await d.ok("UpdateAuthority: insurance operator", m.admin, [ix.updateAuthority(m, m.admin, 4, op.address, op)]);
    d.setClock(d.slot + 50n);
    await d.fails("WithdrawInsuranceLimited: the old operator", m.admin, [l(1n)], pe("EngineUnauthorized"));
    await d.ok("WithdrawInsuranceLimited: the new operator", op, [l(1000n, op, opAta)]);
    // A separate insurance authority (WithdrawInsurance's); the admin no longer is one. (A transfer is refused once the
    // market is past its hard timeout: set it now.)
    const auth = await d.funded();
    const authAta = await d.tokenAccount(m.mint, auth.address);
    await d.ok("UpdateAuthority: insurance authority", m.admin, [ix.updateAuthority(m, m.admin, 2, auth.address, auth)]);
    // Limited withdrawals are for live markets; WithdrawInsurance (the insurance authority) for resolved ones.
    await d.fails("WithdrawInsurance: live market", auth, [ix.withdrawInsurance(m, auth, authAta)], builtin("InvalidAccountData"));
    d.setClock(d.slot + 5000n);
    await d.fails("WithdrawInsuranceLimited: past the hard timeout", op, [l(1000n, op, opAta)], pe("OracleStale"));
    await d.ok("ResolvePermissionless", other, [ix.resolvePermissionless(m)]);
    await d.fails("WithdrawInsuranceLimited: resolved", op, [l(1000n, op, opAta)], builtin("InvalidAccountData"));
    const w = ix.withdrawInsurance(m, auth, authAta);
    for (const [label, i, payer, err] of [
      ["5 accounts", truncate(w, 5), auth, builtin("NotEnoughAccountKeys")],
      ["unsigned", unsigned(w, 0), other, pe("ExpectedSigner")],
      ["slab read-only", readonly(w, 1), auth, pe("ExpectedWritable")],
      ["wrong token program", replace(w, 4, SYSTEM), auth, pe("InvalidTokenProgram")],
      ["the admin, not the insurance authority", ix.withdrawInsurance(m, m.admin, ata), m.admin, pe("EngineUnauthorized")],
      ["accounts left", w, auth, builtin("InvalidAccountData")],
      ["data", withData(w, Buffer.from([20, 0])), auth, builtin("InvalidInstructionData")],
    ] as [string, Instruction, KeyPairSigner, string][])
      await d.fails(`WithdrawInsurance: ${label}`, payer, [i], err);
    await d.ok("CloseAccount: alice", alice.key, [ix.closeAccount(m, alice, 0)]);
    for (const [label, i, err] of [
      ["wrong vault", replace(w, 3, authAta), pe("InvalidVaultAta")],
      ["another's token account", ix.withdrawInsurance(m, auth, otherAta), pe("InvalidTokenAccount")],
      ["wrong vault authority", replace(w, 5, other.address), builtin("InvalidArgument")],
    ] as [string, Instruction, string][])
      await d.fails(`WithdrawInsurance: ${label}`, auth, [i], err);
    // The insurance authority takes it all.
    const left = readU128(slab(m), E.insurance);
    await d.ok("WithdrawInsurance: the new authority", auth, [ix.withdrawInsurance(m, auth, authAta)]);
    expect(d.amount(authAta)).toBe(left);
    await d.ok("CloseSlab", m.admin, [ix.closeSlab(m, ata)], [m.vault, m.slab]);

    // The floor: at least 10 units a call even when 10% is less; never more than the balance; nothing left.
    const f = await d.market({
      edit: (a) => {
        a.unitScale = 1000;
        a.tail!.insuranceWithdrawMaxBps = 1000;
        a.tail!.insuranceWithdrawCooldownSlots = 1n;
      },
    });
    const fi = await d.user(f);
    await d.ok("TopUpInsurance 15 units", fi.key, [ix.topUpInsurance(f, fi, 15_000n)]);
    const fAta = await d.tokenAccount(f.mint, f.admin.address);
    const fl = (amount: bigint) => ix.withdrawInsuranceLimited(f, f.admin, fAta, amount);
    await d.fails("WithdrawInsuranceLimited: dust", f.admin, [fl(10_500n)], builtin("InvalidArgument"));
    await d.fails("WithdrawInsuranceLimited: below one unit", f.admin, [fl(999n)], builtin("InvalidArgument"));
    await d.fails("WithdrawInsuranceLimited: 11 units", f.admin, [fl(11_000n)], pe("InsuranceWithdrawCapExceeded"));
    await d.ok("WithdrawInsuranceLimited: the 10-unit floor", f.admin, [fl(10_000n)]);
    d.setClock(d.slot + 1n);
    await d.fails("WithdrawInsuranceLimited: 6 of 5 units", f.admin, [fl(6000n)], pe("InsuranceWithdrawCapExceeded"));
    await d.ok("WithdrawInsuranceLimited: the last 5 units", f.admin, [fl(5000n)]);
    d.setClock(d.slot + 1n);
    await d.fails("WithdrawInsuranceLimited: nothing left", f.admin, [fl(1000n)], pe("EngineInsufficientBalance"));
    expect(d.amount(fAta)).toBe(15_000n);
    // Turned off (max bps 0, the default).
    const z = await d.market();
    await d.fails("WithdrawInsuranceLimited: turned off", z.admin, [ix.withdrawInsuranceLimited(z, z.admin, ata, 1n)], pe("InvalidConfigParam"));
  });

  it("a cluster restart since InitMarket: the market frozen, resolvable by anyone even with staleness turned off", async () => {
    const m = await d.market({
      edit: (a) => {
        a.minOraclePriceCapE2bps = 1_000_000n;
        a.tail!.permissionlessResolveStaleSlots = 0n;
      },
    });
    const lp = await funded(m, 100n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    await d.ok("TradeNoCpi: alice long", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 200_000_000n)]);
    const other = await d.funded();
    await d.fails("ResolvePermissionless: turned off, no restart", other, [ix.resolvePermissionless(m)], pe("InvalidConfigParam"));
    // LastRestartSlot moves past the one InitMarket recorded (both VMs).
    const restart = d.original.getLastRestartSlot() + 1000n;
    for (const vm of d.vms) vm.setLastRestartSlot(restart);
    d.setClock(d.slot + 5n);
    d.setPrice(m, 103_000_000n);
    await d.fails("TradeNoCpi: after a restart", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 1n)], pe("OracleStale"));
    await d.fails("Deposit: after a restart", alice.key, [ix.deposit(m, alice, 1, SOL)], pe("OracleStale"));
    await d.ok("ResolvePermissionless: after a restart (degenerate, at P_last)", other, [ix.resolvePermissionless(m)]);
    expect(slab(m).readBigUInt64LE(E.resolvedPrice)).toBe(100_000_000n);
    await closeOut(
      m,
      new Map([
        [0, lp],
        [1, alice],
      ]),
      "restart",
    );
    // A market made after the restart records it: not frozen.
    const n = await d.market();
    const bob = await funded(n, SOL, "bob");
    await d.ok("Deposit: a market made after the restart", bob.key, [ix.deposit(n, bob, 0, SOL)]);
    await d.fails("ResolvePermissionless: a market made after the restart", other, [ix.resolvePermissionless(n)], pe("OracleStale"));
  });

  it("the port used fewer compute units than the original on every successful transaction", () => {
    // Diff.both asserts it transaction by transaction; this checks the rows once more. Transactions without a
    // top-level Percolator instruction (an SPL Token transfer, the matcher's Init: the same program on both sides) aside.
    const above = d.rows.filter((r) => r.ok && r.percolator && r.port >= r.original);
    expect(above.map((r) => `${r.label}: ${r.original} / ${r.port}`)).toEqual([]);
    expect(d.rows.filter((r) => r.ok && r.percolator).length).toBeGreaterThan(150);
  });
});
