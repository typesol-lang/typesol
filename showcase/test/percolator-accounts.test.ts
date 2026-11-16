// Percolator v12.20 (showcase/mainnet/percolator) against the mainnet binary: the oracle-priced account instructions,
// WithdrawCollateral, CloseAccount, SettleAccount, and ReclaimEmptyAccount, with the engine work behind them: market
// accrual (mark-to-market into K, funding into F), the live touch (warm-up buckets, side settlement, loss settlement,
// flat-negative absorption), finalize (whole-only conversion, fee-debt sweep), the margin check, maintenance fees.
// Positions come from real trades (TradeNoCpi, and TradeCpi through the matcher to move the mark for funding); a flat
// account with a loss past its capital comes from liquidations, the loss socialised over the shorts and a side reset.
// One state no instruction can make is written into both slabs: a position basis whose arithmetic overflows (for the
// panic).
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { send } from "../../test/harness.js";
import {
  A,
  C,
  CHAINLINK,
  Diff,
  E,
  HAVE_ORIGINAL,
  type Market,
  PYTH_RECEIVER,
  SOL,
  SYSTEM,
  type User,
  accountAt,
  builtin,
  cuSummary,
  ix,
  meta,
  outcome,
  passiveMatcher,
  pe,
  pythBytes,
  readI128,
  readonly,
  readU128,
  replace,
  truncate,
  unsigned,
  writeU128,
} from "./percolator-helpers.js";

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: withdraw, close, settle, reclaim", () => {
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

  it("withdraw and close, flat", async () => {
    const m = await d.market();
    const alice = await funded(m, 10n * SOL, "alice");
    await d.ok("Withdraw", alice.key, [ix.withdraw(m, alice, 0, 4n * SOL)]);
    await d.ok("Withdraw 0", alice.key, [ix.withdraw(m, alice, 0, 0n)]);
    await d.fails("Withdraw: more than the capital", alice.key, [ix.withdraw(m, alice, 0, 7n * SOL)], pe("EngineInsufficientBalance"));
    const bob = await funded(m, SOL, "bob");
    await d.fails("Withdraw: another's account", bob.key, [ix.withdraw(m, bob, 0, 1n)], pe("EngineUnauthorized"));
    await d.fails("Withdraw: free slot", bob.key, [ix.withdraw(m, bob, 7, 1n)], pe("EngineAccountNotFound"));
    await d.fails("Withdraw: index past 4096", bob.key, [ix.withdraw(m, bob, 4096, 1n)], pe("EngineAccountNotFound"));
    // The oracle as each read sees it.
    d.setClock(d.slot + 3n);
    d.setPrice(m, 150_000_000n);
    await d.ok("Withdraw at a new price", alice.key, [ix.withdraw(m, alice, 0, SOL)]);
    d.setPrice(m, 160_000_000n, d.unixTimestamp - 10n);
    await d.ok("Withdraw with an older publish time (the stored price)", alice.key, [ix.withdraw(m, alice, 0, 1n)]);
    d.setPrice(m, 150_000_000n, d.unixTimestamp - 4000n);
    await d.fails("Withdraw: stale oracle", alice.key, [ix.withdraw(m, alice, 0, 1n)], pe("OracleStale"));
    d.setPrice(m, 150_000_000n, d.unixTimestamp, -6, 8_000_000n);
    await d.fails("Withdraw: confidence too wide", alice.key, [ix.withdraw(m, alice, 0, 1n)], pe("OracleConfTooWide"));
    d.write(m.oracle, PYTH_RECEIVER, pythBytes({ feedId: Buffer.alloc(32, 9), price: 1n, expo: 0, publishTime: d.unixTimestamp }));
    await d.fails("Withdraw: another feed", alice.key, [ix.withdraw(m, alice, 0, 1n)], pe("InvalidOracleKey"));
    d.write(m.oracle, SYSTEM, pythBytes({ feedId: m.feedId, price: 1n, expo: 0, publishTime: d.unixTimestamp }));
    await d.fails("Withdraw: oracle of another owner", alice.key, [ix.withdraw(m, alice, 0, 1n)], builtin("IllegalOwner"));
    d.write(m.oracle, CHAINLINK, Buffer.alloc(232));
    await d.fails("Withdraw: a Chainlink account for a Pyth feed", alice.key, [ix.withdraw(m, alice, 0, 1n)], pe("InvalidOracleKey"));
    d.setPrice(m, 151_000_000n);
    await d.fails("Withdraw: 7 accounts", alice.key, [truncate(ix.withdraw(m, alice, 0, 1n), 7)], builtin("NotEnoughAccountKeys"));
    await d.fails("Withdraw: not signed", bob.key, [unsigned(ix.withdraw(m, alice, 0, 1n), 0)], pe("ExpectedSigner"));
    await d.fails("Withdraw: wrong vault PDA", alice.key, [replace(ix.withdraw(m, alice, 0, 1n), 4, bob.key.address)], builtin("InvalidArgument"));
    await d.fails("Withdraw: wrong vault", alice.key, [replace(ix.withdraw(m, alice, 0, 1n), 2, bob.ata)], pe("InvalidVaultAta"));
    await d.ok("CloseAccount", alice.key, [ix.closeAccount(m, alice, 0)]);
    await d.fails("CloseAccount: closed", alice.key, [ix.closeAccount(m, alice, 0)], pe("EngineAccountNotFound"));
    await d.fails("CloseAccount: another's", alice.key, [ix.closeAccount(m, alice, 1)], pe("EngineUnauthorized"));
    await d.fails("CloseAccount: wrong PDA", bob.key, [replace(ix.closeAccount(m, bob, 1), 4, alice.key.address)], builtin("InvalidArgument"));
    await d.ok("CloseAccount, the last one", bob.key, [ix.closeAccount(m, bob, 1)]);
    expect(d.data(m.slab).readUInt16LE(E.numUsedAccounts)).toBe(0);
  });

  it("the price cap, the unit scale and a stale market", async () => {
    const m = await d.market({ edit: (a) => Object.assign(a, { minOraclePriceCapE2bps: 10_000n, unitScale: 1000 }) });
    const alice = await funded(m, 10_000_000n, "alice");
    d.setClock(d.slot + 4n);
    d.setPrice(m, 200_000_000n);
    await d.ok("Withdraw: the price clamped to 1%", alice.key, [ix.withdraw(m, alice, 0, 1000n)]);
    expect(d.data(m.slab).readBigUInt64LE(C.lastEffectivePriceE6)).toBe(101_000n);
    await d.fails("Withdraw: off the unit scale", alice.key, [ix.withdraw(m, alice, 0, 1500n)], builtin("InvalidInstructionData"));
    d.setClock(d.slot + 5001n);
    await d.fails("Withdraw: matured stale", alice.key, [ix.withdraw(m, alice, 0, 1000n)], pe("OracleStale"));
    await d.fails("CloseAccount: matured stale", alice.key, [ix.closeAccount(m, alice, 0)], pe("OracleStale"));
    await d.fails("SettleAccount: matured stale", alice.key, [ix.settleAccount(m, 0)], pe("OracleStale"));
    await d.fails("ReclaimEmptyAccount: matured stale", alice.key, [ix.reclaimEmptyAccount(m, 0)], pe("OracleStale"));
  });

  it("positions: mark-to-market, warm-up, margin, funding", async () => {
    // A 100% circuit breaker: trades then move the mark EWMA, which funding follows.
    const m = await d.market({ edit: (a) => Object.assign(a, { hMin: 5n, hMax: 200n, minOraclePriceCapE2bps: 1_000_000n }) });
    const alice = await funded(m, 100n * SOL, "alice");
    const bob = await funded(m, 100n * SOL, "bob");
    const q = 50_000_000n; // 50 units of base at POS_SCALE 1e6
    await d.ok("TradeNoCpi: alice long, bob short", alice.key, [ix.tradeNoCpi(m, alice.key, bob.key, 1, 0, q)]);
    // The price rises: alice gains, bob loses; the gain warms up (h_max reserve) before it can be withdrawn.
    d.setClock(d.slot + 10n);
    d.setPrice(m, 110_000_000n);
    await d.ok("SettleAccount long (profit into reserve)", alice.key, [ix.settleAccount(m, 0)]);
    await d.ok("SettleAccount short (loss from capital)", bob.key, [ix.settleAccount(m, 1)]);
    const s = d.data(m.slab);
    expect(readI128(s, accountAt(0) + A.pnl) > 0n).toBe(true);
    expect(s[accountAt(0) + A.schedPresent] + s[accountAt(0) + A.pendingPresent]).toBeGreaterThan(0);
    d.setClock(d.slot + 50n);
    d.setPrice(m, 112_000_000n);
    await d.ok("Withdraw with a position (margin checked)", alice.key, [ix.withdraw(m, alice, 0, SOL)]);
    await d.fails("Withdraw below initial margin", bob.key, [ix.withdraw(m, bob, 1, 99n * SOL)], pe("EngineUndercollateralized"));
    await d.fails("CloseAccount with a position", alice.key, [ix.closeAccount(m, alice, 0)], pe("EngineUndercollateralized"));
    // Funding: buys from a matcher quoting above the oracle lift the trade mark over the index; longs pay shorts.
    const lpOwner = await d.user(m);
    const lp = await d.lp(m, lpOwner, 100n * SOL, passiveMatcher({ baseSpreadBps: 90, tradingFeeBps: 5, maxTotalBps: 95 }));
    await d.ok("TradeCpi: alice buys over the oracle", alice.key, [ix.tradeCpi(m, alice.key, lpOwner.key.address, lp, 0, 1_000_000n)]);
    d.setClock(d.slot + 40n);
    await d.ok("TradeCpi: alice buys again (the mark moves)", alice.key, [ix.tradeCpi(m, alice.key, lpOwner.key.address, lp, 0, 1_000_000n)]);
    d.setClock(d.slot + 300n);
    d.setPrice(m, 111_000_000n);
    await d.ok("SettleAccount with funding", alice.key, [ix.settleAccount(m, 0)]);
    d.setClock(d.slot + 300n);
    await d.ok("SettleAccount short with funding", bob.key, [ix.settleAccount(m, 1)]);
    expect(readI128(d.data(m.slab), E.fLongNum)).not.toBe(0n);
    // The reserve matures linearly over h_max slots.
    d.setClock(d.slot + 250n);
    await d.ok("SettleAccount after the warm-up", alice.key, [ix.settleAccount(m, 0)]);
    await d.ok("Withdraw matured profit", alice.key, [ix.withdraw(m, alice, 0, 2n * SOL)]);
    // The price falls hard: bob's loss eats his capital; alice's position shrinks nothing (no ADL here).
    d.setClock(d.slot + 10n);
    d.setPrice(m, 60_000_000n);
    await d.ok("SettleAccount after the crash (long)", alice.key, [ix.settleAccount(m, 0)]);
    await d.ok("SettleAccount after the crash (short)", bob.key, [ix.settleAccount(m, 1)]);
  });

  it("losses past capital: flat-negative absorbed by insurance", async () => {
    const m = await d.market();
    const alice = await funded(m, 2n * SOL, "alice");
    const bob = await funded(m, 2n * SOL, "bob");
    const ins = await d.user(m);
    await d.ok("TopUpInsurance", ins.key, [ix.topUpInsurance(m, ins, SOL)]);
    // Alice's short ends flat with a loss past her capital: a long she did not trade against (x) goes bankrupt past
    // insurance, the shorts share the rest of the loss (alice opened at the low, so the share is all loss), and the
    // last long's liquidation resets the short side, alice's position stale at the frozen K.
    const lp = await funded(m, 200n * SOL, "lp");
    const x = await funded(m, 10n * SOL, "x");
    await d.ok("TradeNoCpi: x long 9 against the LP", x.key, [ix.tradeNoCpi(m, x.key, lp.key, 2, 3, 900_000_000n)]);
    d.setClock(d.slot + 2n);
    d.setPrice(m, 70_000_000n);
    await d.ok("TradeNoCpi: bob long 2 against alice at the low", bob.key, [ix.tradeNoCpi(m, bob.key, alice.key, 0, 1, 200_000_000n)]);
    await d.ok("LiquidateAtOracle: x, past insurance", bob.key, [ix.liquidate(m, bob.key, 3)]);
    d.setClock(d.slot + 2n);
    d.setPrice(m, 63_000_000n);
    await d.ok("LiquidateAtOracle: bob, the last long (the shorts reset)", bob.key, [ix.liquidate(m, bob.key, 1)]);
    await d.ok("TopUpInsurance again", ins.key, [ix.topUpInsurance(m, ins, 5n * SOL)]);
    const insBefore = readU128(d.data(m.slab), E.insurance);
    // The touch settles alice's stale position (flat), her capital pays, insurance absorbs the rest.
    d.setClock(d.slot + 2n);
    await d.ok("SettleAccount flat negative", bob.key, [ix.settleAccount(m, 0)]);
    expect(readU128(d.data(m.slab), accountAt(0) + A.capital)).toBe(0n);
    expect(readI128(d.data(m.slab), accountAt(0) + A.pnl)).toBe(0n);
    expect(readU128(d.data(m.slab), E.insurance) < insBefore).toBe(true);
    await d.ok("ReclaimEmptyAccount", bob.key, [ix.reclaimEmptyAccount(m, 0)]);
    await d.fails("ReclaimEmptyAccount: free slot", bob.key, [ix.reclaimEmptyAccount(m, 0)], pe("EngineAccountNotFound"));
    await d.fails("ReclaimEmptyAccount: capital left", bob.key, [ix.reclaimEmptyAccount(m, 1)], pe("EngineUndercollateralized"));
    await d.ok("SettleAccount: the LP's stale short (the side reopens)", bob.key, [ix.settleAccount(m, 2)]);
    // Positive PnL on a flat account converts to capital when the haircut is whole (not in this market any more: the
    // loss past insurance left the matured profit above the residual). On a new market: bob gains against carol and
    // sells to dave, after carol paid her loss: that residual backs his profit at once (h_min 0), so the trade's own
    // finalize converts it; the close-refusal test below has a profit that stays reserved.
    const n = await d.market();
    const bob2 = await funded(n, SOL, "bob");
    const carol = await funded(n, 5n * SOL, "carol");
    const dave = await funded(n, 5n * SOL, "dave");
    await d.ok("TradeNoCpi: bob long, carol short", bob2.key, [ix.tradeNoCpi(n, bob2.key, carol.key, 1, 0, 50_000_000n)]);
    d.setClock(d.slot + 2n);
    d.setPrice(n, 110_000_000n);
    await d.ok("SettleAccount: carol pays her loss", carol.key, [ix.settleAccount(n, 1)]);
    await d.ok("TradeNoCpi: bob sells to dave at a profit (converted)", bob2.key, [ix.tradeNoCpi(n, dave.key, bob2.key, 0, 2, 50_000_000n)]);
    expect(readI128(d.data(n.slab), accountAt(0) + A.pnl)).toBe(0n);
    expect(readU128(d.data(n.slab), accountAt(0) + A.capital) > SOL).toBe(true);
    await d.ok("SettleAccount: bob, flat", bob2.key, [ix.settleAccount(n, 0)]);
    await d.ok("CloseAccount after conversion", bob2.key, [ix.closeAccount(n, bob2, 0)]);
    await d.fails("SettleAccount: free slot", bob.key, [ix.settleAccount(n, 0)], pe("EngineAccountNotFound"));
    await d.fails("SettleAccount: 2 accounts", bob.key, [truncate(ix.settleAccount(m, 1), 2)], builtin("NotEnoughAccountKeys"));
    await d.fails("ReclaimEmptyAccount: 1 account", bob.key, [truncate(ix.reclaimEmptyAccount(m, 1), 1)], builtin("NotEnoughAccountKeys"));
  });

  it("the account and envelope refusals of the oracle-priced instructions", async () => {
    // No permissionless resolution (a cap floor instead), so that the clock can run past the accrual envelope.
    const m = await d.market({ edit: (a) => Object.assign(a, { minOraclePriceCapE2bps: 1_000_000n }) && (a.tail!.permissionlessResolveStaleSlots = 0n) });
    const alice = await funded(m, 10n * SOL, "alice");
    const other = await d.funded();
    const stranger = await d.tokenAccount(m.mint, other.address, SOL);
    for (const [name, i] of [
      ["Withdraw", ix.withdraw(m, alice, 0, 1n)],
      ["CloseAccount", ix.closeAccount(m, alice, 0)],
    ] as const) {
      await d.fails(`${name}: slab read-only`, alice.key, [readonly(i, 1)], pe("ExpectedWritable"));
      await d.fails(`${name}: not the token program`, alice.key, [replace(i, 5, SYSTEM)], pe("InvalidTokenProgram"));
      await d.fails(`${name}: another's token account`, alice.key, [replace(i, 3, stranger)], pe("InvalidTokenAccount"));
      await d.fails(`${name}: wrong clock`, alice.key, [replace(i, 6, other.address)], builtin("InvalidArgument"));
    }
    await d.fails("SettleAccount: slab read-only", alice.key, [readonly(ix.settleAccount(m, 0), 0)], pe("ExpectedWritable"));
    await d.fails("SettleAccount: wrong clock", alice.key, [replace(ix.settleAccount(m, 0), 1, other.address)], builtin("InvalidArgument"));
    await d.fails("ReclaimEmptyAccount: slab read-only", alice.key, [readonly(ix.reclaimEmptyAccount(m, 0), 0)], pe("ExpectedWritable"));
    // Past max_accrual_dt_slots (10M) with no accrual: the no-oracle paths refuse to move current_slot that far.
    d.setClock(d.slot + 10_000_001n);
    await d.fails("Deposit past the accrual envelope", alice.key, [ix.deposit(m, alice, 0, SOL)], pe("EngineOverflow"));
    // TopUpInsurance anchors at min(clock, last_market_slot): no envelope to cross.
    await d.ok("TopUpInsurance past the accrual envelope (bounded to the market slot)", alice.key, [ix.topUpInsurance(m, alice, SOL)]);
    // An oracle-priced instruction accrues the whole gap in one step (no open interest: no envelope for funding).
    d.setPrice(m, 100_000_000n);
    await d.ok("SettleAccount across the gap", alice.key, [ix.settleAccount(m, 0)]);
    await d.ok("Deposit after the accrual", alice.key, [ix.deposit(m, alice, 0, SOL)]);
  });

  it("close refusals: unwarmed PnL, then the close once it has warmed", async () => {
    const m = await d.market({ edit: (a) => Object.assign(a, { hMin: 10n, hMax: 50n }) });
    const alice = await funded(m, 10n * SOL, "alice");
    const bob = await funded(m, 10n * SOL, "bob");
    const carol = await funded(m, 10n * SOL, "carol");
    await d.ok("TradeNoCpi: alice long, bob short", alice.key, [ix.tradeNoCpi(m, alice.key, bob.key, 1, 0, 100_000_000n)]);
    d.setClock(d.slot + 2n);
    d.setPrice(m, 105_000_000n);
    // Alice sells to carol: flat with a profit that bob, not touched, has not paid yet (reserved for h_max slots).
    await d.ok("TradeNoCpi: alice sells to carol at a profit", alice.key, [ix.tradeNoCpi(m, alice.key, carol.key, 2, 0, -100_000_000n)]);
    // A reserve still warming refuses the close (fee debt, the other refusal, is in "maintenance fees").
    await d.fails("CloseAccount with positive PnL", alice.key, [ix.closeAccount(m, alice, 0)], pe("EnginePnlNotWarmedUp"));
    await d.ok("SettleAccount: bob pays his loss", bob.key, [ix.settleAccount(m, 1)]);
    d.setClock(d.slot + 60n);
    await d.ok("CloseAccount after the warm-up (converted on the touch)", alice.key, [ix.closeAccount(m, alice, 0)]);
  });

  it("maintenance fees", async () => {
    const m = await d.market({ edit: (a) => (a.maintenanceFeePerSlot = 1000n) });
    const alice = await funded(m, 1_000_000n, "alice");
    const bob = await funded(m, 600_000n, "bob");
    d.setClock(d.slot + 100n);
    await d.ok("Deposit (fees anchored at the market slot)", alice.key, [ix.deposit(m, alice, 0, 1000n)]);
    await d.ok("Withdraw realizes the fees", alice.key, [ix.withdraw(m, alice, 0, 1000n)]);
    d.setClock(d.slot + 700n);
    await d.ok("SettleAccount: fees past the capital become debt", bob.key, [ix.settleAccount(m, 1)]);
    expect(readI128(d.data(m.slab), accountAt(1) + A.feeCredits) < 0n).toBe(true);
    await d.fails("CloseAccount with fee debt", bob.key, [ix.closeAccount(m, bob, 1)], pe("EngineUndercollateralized"));
    await d.ok("DepositFeeCredits", bob.key, [ix.depositFeeCredits(m, bob, 1, 100_000n)]);
    await d.ok("ReclaimEmptyAccount: syncs, then frees the drained account", bob.key, [ix.reclaimEmptyAccount(m, 1)]);
    d.setClock(d.slot + 10n);
    await d.ok("CloseAccount pays the fees first", alice.key, [ix.closeAccount(m, alice, 0)]);
  });

  it("panics as the original reports them (solana-program 1.18: location, then message)", async () => {
    const m = await d.market();
    const alice = await funded(m, SOL, "alice");
    // A position basis whose |basis| · A overflows u128: mul_div_floor_u128 panics in the touch.
    d.patch(m.slab, (b) => writeU128(b, accountAt(0) + A.positionBasisQ, 1n << 120n));
    await d.fails("Withdraw: mul_div_floor_u128 overflow", alice.key, [ix.withdraw(m, alice, 0, 1n)], builtin("ProgramFailedToComplete"));
    expect(d.lastLogs).toContain("Program log: panicked at src/wide_math.rs:1554:30:\nmul_div_floor_u128: a*b overflow");
  });

  it("a patched freelist index past the 4,096 slots: a difference, pinned", async () => {
    // free_slot pushes the freed slot onto the free list: `self.prev_free[self.free_head as usize] = idx`. A free head of
    // 4,096 to 65,534 (no instruction writes one: the head is always a slot or u16::MAX) is past the array: the original
    // panics there (Rust's bounds check, "index out of bounds: the len is 4096 but the index is <n>", a message with the
    // index in it); the port's fixed-array write fails TypeSOL's bounds check instead. Both fail the instruction and
    // leave every account as it was; the outcome and the log lines differ. Written into both slabs the same way.
    const m = await d.market();
    const alice = await funded(m, SOL, "alice");
    d.patch(m.slab, (b) => b.writeUInt16LE(5000, E.freeHead));
    const before = d.bytes(d.original, m.slab);
    const close = ix.closeAccount(m, alice, 0);
    const [a, b] = [await send(d.original, alice.key, [close]), await send(d.port, alice.key, [close])];
    expect(outcome(a)).toBe(builtin("ProgramFailedToComplete"));
    expect(meta(a).logs().join("\n")).toContain("panicked at src/percolator.rs:1127:13:\nindex out of bounds: the len is 4096 but the index is 5000");
    // TypeSOL's bounds check: error 5104, "TypeSOL: array index out of bounds" with the port's line.
    expect(outcome(b)).toBe("error: TransactionErrorInstructionError { index: 0, error: InstructionErrorCustom { code: 5104 } }");
    expect(meta(b).logs().join("\n")).toContain("TypeSOL: array index out of bounds");
    expect(d.bytes(d.port, m.slab)).toBe(before);
    expect(d.bytes(d.original, m.slab)).toBe(before);
  });

  it("a Hyperp market: the index follows the mark", async () => {
    const m = await d.market({
      edit: (a) => {
        a.feedId = Buffer.alloc(32);
        a.initialMarkPriceE6 = 1_000_000n;
        a.tail!.markMinFee = 10n;
      },
    });
    const alice = await funded(m, 10n * SOL, "alice");
    await d.ok("PushHyperpMark", m.admin, [ix.pushHyperpMark(m, m.admin, 1_300_000n, 0n)]);
    d.setClock(d.slot + 40n);
    await d.ok("Withdraw (index moves toward the mark)", alice.key, [ix.withdraw(m, alice, 0, SOL)]);
    await d.ok("SettleAccount", alice.key, [ix.settleAccount(m, 0)]);
    d.setClock(d.slot + 20_000n);
    await d.fails("Withdraw: mark stale", alice.key, [ix.withdraw(m, alice, 0, SOL)], pe("OracleStale"));
  });

  it("the bounds of a withdrawal: units_to_base at u64::MAX, equity exactly the initial margin", async () => {
    // Unit scale 10^9 (MAX_UNIT_SCALE): the most units a u64 of base can pay out, floor((2^64 - 1) / 10^9), withdrawn
    // whole (units_to_base_checked's bound itself). The oracle at 10^12 (e6) so the scaled price is not 0.
    const units = 18_446_744_073n;
    const m = await d.market({ price: 1_000_000_000_000n, edit: (a) => (a.unitScale = 1_000_000_000) });
    const whale = await d.user(m, units * 1_000_000_000n);
    await d.ok("InitUser: the most a u64 of base pays out", whale.key, [ix.initUser(m, whale, units * 1_000_000_000n)]);
    await d.ok("Withdraw: all of it", whale.key, [ix.withdraw(m, whale, 0, units * 1_000_000_000n)]);
    // A long of 100 at 100 (notional 10^10, initial margin 10% = 10^9) with 2 * 10^9 of capital: withdrawing 10^9
    // leaves the equity exactly at the requirement (allowed), one more is refused.
    const n = await d.market();
    const lp = await funded(n, 100n * SOL, "lp");
    const alice = await funded(n, 2_000_000_000n, "alice");
    await d.ok("TradeNoCpi: alice long 100", alice.key, [ix.tradeNoCpi(n, alice.key, lp.key, 0, 1, 100_000_000n)]);
    await d.ok("Withdraw: down to the initial margin exactly", alice.key, [ix.withdraw(n, alice, 1, 1_000_000_000n)]);
    await d.fails("Withdraw: one past it", alice.key, [ix.withdraw(n, alice, 1, 1n)], pe("EngineUndercollateralized"));
  });

  it("warm-up: a reserve added to a pending bucket of a shorter horizon lengthens it (a slab written in)", async () => {
    // h_min 1, h_max 10. Alice's account is given a scheduled bucket (100, horizon 10) and a pending one (200, horizon
    // 5, a horizon only a written slab has): a mark-to-market profit admitted at h_max goes to the pending bucket,
    // whose horizon becomes the larger, 10.
    const m = await d.market({ edit: (a) => Object.assign(a, { hMin: 1n, hMax: 10n }) });
    const lp = await funded(m, 100n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    await d.ok("TradeNoCpi: alice long 100", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 1, 100_000_000n)]);
    const now = d.data(m.slab).readBigUInt64LE(E.currentSlot);
    d.patch(m.slab, (b) => {
      const at = accountAt(1);
      writeU128(b, at + A.pnl, 300n);
      writeU128(b, at + A.reservedPnl, 300n);
      b[at + A.schedPresent] = 1;
      writeU128(b, at + A.schedRemainingQ, 100n);
      writeU128(b, at + A.schedAnchorQ, 100n);
      b.writeBigUInt64LE(now, at + A.schedStartSlot);
      b.writeBigUInt64LE(10n, at + A.schedHorizon);
      b[at + A.pendingPresent] = 1;
      writeU128(b, at + A.pendingRemainingQ, 200n);
      b.writeBigUInt64LE(5n, at + A.pendingHorizon);
      b.writeBigUInt64LE(now, at + A.pendingCreatedSlot);
      writeU128(b, E.pnlPosTot, readU128(b, E.pnlPosTot) + 300n);
    });
    d.setClock(d.slot + 2n);
    d.setPrice(m, 101_000_000n);
    await d.ok("SettleAccount: a profit into the pending bucket", alice.key, [ix.settleAccount(m, 1)]);
    expect(d.data(m.slab).readBigUInt64LE(accountAt(1) + A.pendingHorizon)).toBe(10n);
  });
});
