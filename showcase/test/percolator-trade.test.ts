// Percolator v12.20 (showcase/mainnet/percolator) against the mainnet binary: TradeNoCpi, TradeCpi and
// ConvertReleasedPnl, with the engine work behind them (trade PnL, trading fees, the margin checks, the open-interest
// decomposition, warm-up of trade profit, the haircut on conversion, the mark EWMA, the risk buffer).
//
// TradeCpi calls a matcher. No build of the author's matcher (aeyakovenko/percolator-match) is deployed for v12.20, so
// both programs call the same TypeSOL port of it (showcase/mainnet/percolator/matcher, commit 199b139: the Passive and
// vAMM kinds); answers the real matcher never gives (for the refusals of the answer) come from a matcher that writes
// what its context says (showcase/test/fixtures/percolator-rogue-matcher.ts). Drain-only and reset-pending sides come
// from liquidations and a resolved market from ResolveMarket; the request nonce at u64::MAX is written into both slabs
// the same way, and said so where it is done.
import { type Address } from "@solana/kit";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  A,
  C,
  CLOCK,
  Diff,
  E,
  H,
  HAVE_ORIGINAL,
  type Lp,
  MATCHER,
  MATCHER_CTX_LEN,
  type Market,
  P,
  PROGRAM,
  ROGUE,
  SOL,
  SYSTEM,
  type User,
  accountAt,
  builtin,
  cuSummary,
  i128,
  ix,
  lpPda,
  passiveMatcher,
  pe,
  r,
  readI128,
  readU128,
  readonly,
  replace,
  truncate,
  u32,
  u64,
  unsigned,
  w,
} from "./percolator-helpers.js";

/** A rogue answer (the matcher's 64 bytes) and the mode bits that replace its fields with the request's. */
interface Rogue {
  mode: bigint;
  deltaBps?: bigint;
  abi?: number;
  flags?: number;
  price?: bigint;
  size?: bigint;
  reqId?: bigint;
  lpId?: bigint;
  oracle?: bigint;
  reserved?: bigint;
}
const ECHO = 1n | 2n | 4n;
const FILL = 8n;
const PRICED = 16n;
const REENTER = 32n;
const HALF = 64n;
const OBSERVE = 128n;

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: trading", () => {
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

  /** An LP bound to the rogue matcher (a 320-byte context it owns; its template set by `rogue`). */
  async function rogueLp(m: Market, u: User, deposit: bigint): Promise<Lp> {
    const ctx = await d.address();
    d.write(ctx, ROGUE, Buffer.alloc(MATCHER_CTX_LEN));
    const idx = d.freeHead(m);
    await d.ok("rogue LP: InitLP", u.key, [ix.initLp(m, u, ROGUE, ctx, deposit)]);
    return { idx, matcher: ROGUE, ctx, pda: await lpPda(m, idx) };
  }

  function rogue(lp: Lp, a: Rogue): void {
    d.patch(lp.ctx, (b) => {
      b.writeBigUInt64LE(a.mode, 128);
      b.writeBigInt64LE(a.deltaBps ?? 0n, 136);
      Buffer.concat([
        u32(a.abi ?? 2),
        u32(a.flags ?? 1),
        u64(a.price ?? 1n),
        i128(a.size ?? 0n),
        u64(a.reqId ?? 0n),
        u64(a.lpId ?? 0n),
        u64(a.oracle ?? 0n),
        u64(a.reserved ?? 0n),
      ]).copy(b, 144);
    });
  }

  const basis = (m: Market, idx: number) => readI128(d.data(m.slab), accountAt(idx) + A.positionBasisQ);

  it("TradeNoCpi: fills at the oracle, flips, closes; fees, the mark EWMA and the risk buffer", async () => {
    const m = await d.market({
      edit: (a) => {
        Object.assign(a, { tradingFeeBps: 10n, hMax: 100n, minOraclePriceCapE2bps: 20_000n, maintenanceFeePerSlot: 3n });
        a.tail!.markMinFee = 1000n;
      },
    });
    const lpUser = await d.user(m);
    const lp = await d.lp(m, lpUser, 500n * SOL);
    const users: User[] = [];
    for (let i = 0; i < 6; i++) users.push(await funded(m, 20n * SOL, `user ${i}`));
    // Six traders of growing size: the risk buffer keeps the four largest notionals.
    for (let i = 0; i < 6; i++) {
      d.setClock(d.slot + 3n);
      await d.ok(`user ${i}: TradeNoCpi`, users[i]!.key, [ix.tradeNoCpi(m, users[i]!.key, lpUser.key, lp.idx, i + 1, BigInt(i + 1) * 10_000_000n)]);
    }
    expect(d.data(m.slab)[accountAt(0) + 0]).toBeGreaterThanOrEqual(0);
    expect(basis(m, lp.idx)).toBe(-210_000_000n);
    expect(d.data(m.slab).readBigUInt64LE(C.markEwmaE6)).toBeGreaterThan(0n);
    // A move, then flips and closes.
    d.setClock(d.slot + 10n);
    d.setPrice(m, 101_000_000n);
    await d.ok("user 0: flip short TradeNoCpi", users[0]!.key, [ix.tradeNoCpi(m, users[0]!.key, lpUser.key, lp.idx, 1, -30_000_000n)]);
    expect(basis(m, 1)).toBe(-20_000_000n);
    await d.ok("user 0: close TradeNoCpi", users[0]!.key, [ix.tradeNoCpi(m, users[0]!.key, lpUser.key, lp.idx, 1, 20_000_000n)]);
    expect(basis(m, 1)).toBe(0n);
    await d.ok("user 5: reduce TradeNoCpi", users[5]!.key, [ix.tradeNoCpi(m, users[5]!.key, lpUser.key, lp.idx, 6, -1_000_000n)]);
    d.setClock(d.slot + 200n);
    d.setPrice(m, 99_000_000n);
    for (let i = 1; i < 6; i++)
      await d.ok(`user ${i}: close TradeNoCpi`, users[i]!.key, [ix.tradeNoCpi(m, users[i]!.key, lpUser.key, lp.idx, i + 1, -basis(m, i + 1))]);
    expect(readU128(d.data(m.slab), E.oiEffLongQ)).toBe(0n);
    await d.ok("user 1: CloseAccount after trading", users[1]!.key, [ix.closeAccount(m, users[1]!, 2)]);
  });

  it("TradeNoCpi refusals", async () => {
    const m = await d.market({ edit: (a) => Object.assign(a, { tradingFeeBps: 5n, hMax: 50n }) });
    const lpUser = await d.user(m);
    const lp = await d.lp(m, lpUser, 100n * SOL);
    const alice = await funded(m, 10n * SOL, "alice");
    const other = await d.funded();
    const t = (size: bigint, userIdx = 1) => ix.tradeNoCpi(m, alice.key, lpUser.key, lp.idx, userIdx, size);
    await d.fails("TradeNoCpi: 4 accounts", alice.key, [truncate(t(1n), 4)], builtin("NotEnoughAccountKeys"));
    await d.fails("TradeNoCpi: user not signed", lpUser.key, [unsigned(t(1n), 0)], pe("ExpectedSigner"));
    await d.fails("TradeNoCpi: LP not signed", alice.key, [unsigned(t(1n), 1)], pe("ExpectedSigner"));
    await d.fails("TradeNoCpi: slab read-only", alice.key, [readonly(t(1n), 2)], pe("ExpectedWritable"));
    await d.fails("TradeNoCpi: wrong clock", alice.key, [replace(t(1n), 3, other.address)], builtin("InvalidArgument"));
    await d.fails("TradeNoCpi: free user slot", alice.key, [t(1_000_000n, 9)], pe("EngineAccountNotFound"));
    await d.fails("TradeNoCpi: free LP slot", alice.key, [ix.tradeNoCpi(m, alice.key, lpUser.key, 9, 1, 1n)], pe("EngineAccountNotFound"));
    await d.fails("TradeNoCpi: index past 4096", alice.key, [t(1n, 4096)], pe("EngineAccountNotFound"));
    await d.fails("TradeNoCpi: another's account", lpUser.key, [ix.tradeNoCpi(m, lpUser.key, lpUser.key, lp.idx, 1, 1n)], pe("EngineUnauthorized"));
    await d.fails("TradeNoCpi: not the LP's owner", alice.key, [ix.tradeNoCpi(m, alice.key, alice.key, lp.idx, 1, 1n)], pe("EngineUnauthorized"));
    await d.fails("TradeNoCpi: size 0", alice.key, [t(0n)], pe("EngineOverflow"));
    await d.fails("TradeNoCpi: size i128::MIN", alice.key, [t(-(1n << 127n))], pe("EngineOverflow"));
    await d.fails("TradeNoCpi: past MAX_TRADE_SIZE_Q", alice.key, [t(100_000_000_000_001n)], pe("EngineOverflow"));
    await d.fails("TradeNoCpi: past MAX_TRADE_SIZE_Q, short", alice.key, [t(-100_000_000_000_001n)], pe("EngineOverflow"));
    await d.fails(
      "TradeNoCpi: self-trade (the LP with itself)",
      lpUser.key,
      [ix.tradeNoCpi(m, lpUser.key, lpUser.key, lp.idx, lp.idx, 1_000_000n)],
      pe("EngineOverflow"),
    );
    await d.fails("TradeNoCpi: above initial margin", alice.key, [t(1_000_000_000n)], pe("EngineUndercollateralized"));
    await d.fails("TradeNoCpi: the LP above initial margin", alice.key, [t(-1_100_000_000n)], pe("EngineUndercollateralized"));
    await d.ok("TradeNoCpi: at the margin", alice.key, [t(900_000_000n)]);
    await d.fails("TradeNoCpi: past the margin", alice.key, [t(200_000_000n)], pe("EngineUndercollateralized"));
    // Oracle refusals.
    d.setPrice(m, 100_000_000n, d.unixTimestamp - 4000n);
    await d.fails("TradeNoCpi: stale oracle", alice.key, [t(1n)], pe("OracleStale"));
    d.setPrice(m, 100_000_000n, d.unixTimestamp, -6, 8_000_000n);
    await d.fails("TradeNoCpi: confidence too wide", alice.key, [t(1n)], pe("OracleConfTooWide"));
    d.setPrice(m, 100_000_000n);
    // A crash past the long's capital: closing would leave a negative PnL on a flat account.
    d.setClock(d.slot + 5n);
    d.setPrice(m, 85_000_000n);
    await d.fails("TradeNoCpi: flat close with a loss past the capital", alice.key, [t(-900_000_000n)], pe("EngineUndercollateralized"));
    await d.fails("TradeNoCpi: risk-increasing below margin", alice.key, [t(1_000_000n)], pe("EngineUndercollateralized"));
    await d.both("TradeNoCpi: reducing below maintenance", alice.key, [t(-100_000_000n)]);
    // The hard timeout: no live price for permissionless_resolve_stale_slots.
    d.setClock(d.slot + 5001n);
    d.setPrice(m, 85_000_000n);
    await d.fails("TradeNoCpi: matured stale", alice.key, [t(1n)], pe("OracleStale"));
  });

  it("TradeNoCpi: the circuit breaker, Hyperp, drain-only and reset-pending sides, a resolved market", async () => {
    const capped = await d.market({ edit: (a) => (a.minOraclePriceCapE2bps = 10_000n) });
    const lpUser = await d.user(capped);
    const lp = await d.lp(capped, lpUser, 100n * SOL);
    const alice = await funded(capped, 10n * SOL, "alice");
    d.setClock(d.slot + 2n);
    d.setPrice(capped, 150_000_000n);
    // The price moves at most 1% per read: the trade fills at the clamped price.
    await d.ok("TradeNoCpi: price clamped by the breaker", alice.key, [ix.tradeNoCpi(capped, alice.key, lpUser.key, lp.idx, 1, 5_000_000n)]);
    expect(d.data(capped.slab).readBigUInt64LE(C.lastEffectivePriceE6)).toBe(101_000_000n);

    const hyperp = await d.market({
      edit: (a) => {
        a.feedId = Buffer.alloc(32);
        a.initialMarkPriceE6 = 1_000_000n;
        a.tail!.markMinFee = 10n;
      },
    });
    const hl = await d.user(hyperp);
    const hlp = await d.lp(hyperp, hl, 10n * SOL);
    const hu = await funded(hyperp, SOL, "hyperp user");
    await d.fails("TradeNoCpi: Hyperp", hu.key, [ix.tradeNoCpi(hyperp, hu.key, hl.key, hlp.idx, 1, 1n)], pe("HyperpTradeNoCpiDisabled"));

    // A drain-only side: a liquidation took 95% of the shorts, so the longs' A fell below MIN_A_SIDE. It refuses trades
    // that grow it; reducing and closing it go through.
    const dm = await d.market();
    const dlp = await funded(dm, 300n * SOL, "drain LP");
    const big = await funded(dm, 10n * SOL, "big");
    const small = await funded(dm, SOL, "small");
    const carol = await funded(dm, 10n * SOL, "carol");
    const dave = await funded(dm, 10n * SOL, "dave");
    await d.ok("TradeNoCpi: big short 9.5", big.key, [ix.tradeNoCpi(dm, big.key, dlp.key, 0, 1, -950_000_000n)]);
    await d.ok("TradeNoCpi: small short 0.5", small.key, [ix.tradeNoCpi(dm, small.key, dlp.key, 0, 2, -50_000_000n)]);
    d.setClock(d.slot + 2n);
    d.setPrice(dm, 111_000_000n);
    await d.ok("LiquidateAtOracle: big", small.key, [ix.liquidate(dm, small.key, 1)]);
    expect(d.data(dm.slab)[E.sideModeLong]).toBe(1);
    await d.fails("TradeNoCpi: long side drain-only", carol.key, [ix.tradeNoCpi(dm, carol.key, dave.key, 4, 3, 1_000_000n)], pe("EngineRiskReductionOnlyMode"));
    await d.ok("TradeNoCpi: reducing a drain-only side", small.key, [ix.tradeNoCpi(dm, small.key, dlp.key, 0, 2, 10_000_000n)]);
    // The last short is liquidated: the long side (the LP, stored) resets, its position stale until touched.
    d.setClock(d.slot + 2n);
    d.setPrice(dm, 125_000_000n);
    await d.ok("LiquidateAtOracle: small, the last short", carol.key, [ix.liquidate(dm, carol.key, 2)]);
    expect(d.data(dm.slab)[E.sideModeLong]).toBe(2);
    await d.fails(
      "TradeNoCpi: long side reset-pending",
      carol.key,
      [ix.tradeNoCpi(dm, carol.key, dave.key, 4, 3, 1_000_000n)],
      pe("EngineRiskReductionOnlyMode"),
    );
    await d.ok("TradeNoCpi: a reset-pending side with nothing stale after the touch reopens (the preflight finalize)", carol.key, [
      ix.tradeNoCpi(dm, carol.key, dlp.key, 0, 3, 1_000_000n),
    ]);
    expect(d.data(dm.slab)[E.sideModeLong]).toBe(0);
    // A resolved market.
    await d.ok("ResolveMarket", capped.admin, [ix.resolveMarket(capped, capped.admin)]);
    await d.fails("TradeNoCpi: resolved", alice.key, [ix.tradeNoCpi(capped, alice.key, lpUser.key, lp.idx, 1, 1n)], builtin("InvalidAccountData"));
    await d.fails("TradeCpi: resolved", alice.key, [ix.tradeCpi(capped, alice.key, lpUser.key.address, lp, 1, 1n)], builtin("InvalidAccountData"));
    await d.fails("ConvertReleasedPnl: resolved", alice.key, [ix.convertReleasedPnl(capped, alice, 1, 1n)], builtin("InvalidAccountData"));
  });

  it("TradeCpi through the matcher: Passive and vAMM, partial and zero fills, the limit price", async () => {
    const m = await d.market({ edit: (a) => Object.assign(a, { tradingFeeBps: 10n, hMax: 100n, minOraclePriceCapE2bps: 50_000n }) });
    const lpUser = await d.user(m);
    const lp = await d.lp(m, lpUser, 500n * SOL, passiveMatcher({ maxFillAbs: 40_000_000n, maxInventoryAbs: 60_000_000n }));
    const vUser = await d.user(m);
    const vamm = await d.lp(
      m,
      vUser,
      500n * SOL,
      passiveMatcher({ kind: 1, impactKBps: 50, liquidityNotionalE6: 10_000_000_000n, maxTotalBps: 100 }),
      "vAMM LP",
    );
    const alice = await funded(m, 50n * SOL, "alice");
    const aliceIdx = 2;
    const t = (l: Lp, owner: Address, size: bigint, limit = 0n) => ix.tradeCpi(m, alice.key, owner, l, aliceIdx, size, limit);
    await d.ok("TradeCpi: Passive buy", alice.key, [t(lp, lpUser.key.address, 10_000_000n)]);
    await d.ok("TradeCpi: Passive buy, partial (max fill)", alice.key, [t(lp, lpUser.key.address, 100_000_000n)]);
    await d.ok("TradeCpi: Passive buy, cut by the inventory limit", alice.key, [t(lp, lpUser.key.address, 40_000_000n)]);
    await d.ok("TradeCpi: Passive buy at the inventory limit (zero fill)", alice.key, [t(lp, lpUser.key.address, 40_000_000n)]);
    expect(basis(m, aliceIdx)).toBe(60_000_000n);
    d.setClock(d.slot + 4n);
    await d.ok("TradeCpi: vAMM sell (impact)", alice.key, [t(vamm, vUser.key.address, -80_000_000n)]);
    await d.ok("TradeCpi: vAMM buy, capped impact", alice.key, [t(vamm, vUser.key.address, 300_000_000n)]);
    // Limits: a buy pays at most the limit, a sell gets at least it.
    await d.fails("TradeCpi: buy above the limit", alice.key, [t(vamm, vUser.key.address, 1_000_000n, 100_000_000n)], builtin("InvalidAccountData"));
    await d.ok("TradeCpi: buy within the limit", alice.key, [t(vamm, vUser.key.address, 1_000_000n, 102_000_000n)]);
    await d.fails("TradeCpi: sell below the limit", alice.key, [t(vamm, vUser.key.address, -1_000_000n, 100_000_000n)], builtin("InvalidAccountData"));
    await d.ok("TradeCpi: sell within the limit", alice.key, [t(vamm, vUser.key.address, -1_000_000n, 98_000_000n)]);
    // A zero fill advances the engine clock and keeps the oracle state, nothing else (the nonce moves).
    const zero = await d.user(m);
    const zlp = await d.lp(m, zero, 10n * SOL, passiveMatcher({ maxFillAbs: 0n }), "zero LP");
    d.setClock(d.slot + 7n);
    d.setPrice(m, 103_000_000n);
    const nonce = d.data(m.slab).readBigUInt64LE(H.nonce);
    await d.ok("TradeCpi: zero fill", alice.key, [t(zlp, zero.key.address, 5_000_000n)]);
    expect(d.data(m.slab).readBigUInt64LE(H.nonce)).toBe(nonce + 1n);
    await d.ok("TradeCpi: zero fill with a limit (not checked)", alice.key, [t(zlp, zero.key.address, 5_000_000n, 1n)]);
    // Funding: the trades moved the mark EWMA off the index.
    d.setClock(d.slot + 300n);
    await d.ok("TradeCpi after funding accrued", alice.key, [t(lp, lpUser.key.address, -5_000_000n)]);
    expect(readI128(d.data(m.slab), E.fLongNum)).not.toBe(0n);
  });

  it("TradeCpi on an inverted market and on a Hyperp market", async () => {
    const inv = await d.market({ edit: (a) => Object.assign(a, { invert: 1, tradingFeeBps: 20n }) });
    const lu = await d.user(inv);
    const lp = await d.lp(inv, lu, 100n * SOL, passiveMatcher({ baseSpreadBps: 30 }));
    const alice = await funded(inv, 10n * SOL, "alice");
    // Engine price 10_000 (1e12 / 1e8). A raw limit maps through the inversion, which flips the order.
    // A buy fills at 10_035 (35 bps over): a raw limit of 99 (engine 10_101) is above it, so it is refused.
    await d.fails(
      "TradeCpi inverted: buy past the limit",
      alice.key,
      [ix.tradeCpi(inv, alice.key, lu.key.address, lp, 1, 1_000_000_000n, 99_000_000n)],
      builtin("InvalidAccountData"),
    );
    await d.ok("TradeCpi inverted: buy within the limit", alice.key, [ix.tradeCpi(inv, alice.key, lu.key.address, lp, 1, 1_000_000_000n, 100_000_000n)]);
    await d.fails(
      "TradeCpi inverted: sell past the limit",
      alice.key,
      [ix.tradeCpi(inv, alice.key, lu.key.address, lp, 1, -1_000_000n, 101_000_000n)],
      builtin("InvalidAccountData"),
    );
    await d.ok("TradeCpi inverted: sell within the limit", alice.key, [ix.tradeCpi(inv, alice.key, lu.key.address, lp, 1, -1_000_000n, 99_000_000n)]);
    await d.fails(
      "TradeCpi inverted: a limit that inverts to nothing",
      alice.key,
      [ix.tradeCpi(inv, alice.key, lu.key.address, lp, 1, 1_000_000n, 1n << 63n)],
      pe("OracleInvalid"),
    );

    const h = await d.market({
      edit: (a) => {
        a.feedId = Buffer.alloc(32);
        a.initialMarkPriceE6 = 2_000_000n;
        a.minOraclePriceCapE2bps = 10_000n;
        a.tradingFeeBps = 30n;
        a.tail!.markMinFee = 100n;
      },
    });
    const hu = await d.user(h);
    const hlp = await d.lp(h, hu, 100n * SOL, passiveMatcher({ baseSpreadBps: 40 }));
    const bob = await funded(h, 10n * SOL, "bob");
    d.setClock(d.slot + 5n);
    await d.ok("TradeCpi Hyperp: the mark follows the fill", bob.key, [ix.tradeCpi(h, bob.key, hu.key.address, hlp, 1, 100_000_000n)]);
    d.setClock(d.slot + 5n);
    await d.ok("TradeCpi Hyperp: a dust fill (below mark_min_fee)", bob.key, [ix.tradeCpi(h, bob.key, hu.key.address, hlp, 1, 1_000n)]);
    const zero = await d.user(h);
    const zlp = await d.lp(h, zero, SOL, passiveMatcher({ maxFillAbs: 0n }), "zero LP");
    d.setClock(d.slot + 5n);
    await d.ok("TradeCpi Hyperp: zero fill (the index moved, the config rolled back)", bob.key, [
      ix.tradeCpi(h, bob.key, zero.key.address, zlp, 1, 1_000_000n),
    ]);
    d.setClock(d.slot + 20_000n);
    await d.fails("TradeCpi Hyperp: mark stale", bob.key, [ix.tradeCpi(h, bob.key, hu.key.address, hlp, 1, 1_000n)], pe("OracleStale"));
  });

  it("TradeCpi refusals of the accounts, the binding and the matcher's answer", async () => {
    const m = await d.market({ edit: (a) => Object.assign(a, { tradingFeeBps: 10n, hMax: 100n }) });
    const lpUser = await d.user(m);
    const lp = await d.lp(m, lpUser, 100n * SOL);
    const alice = await funded(m, 10n * SOL, "alice");
    const plain = await funded(m, 10n * SOL, "plain");
    const ru = await d.user(m);
    const rlp = await rogueLp(m, ru, 100n * SOL);
    const other = await d.funded();
    const t = (size = 1_000_000n) => ix.tradeCpi(m, alice.key, lpUser.key.address, lp, 1, size);
    const tr = (size = 1_000_000n, limit = 0n, tail: Parameters<typeof ix.tradeCpi>[7] = []) =>
      ix.tradeCpi(m, alice.key, ru.key.address, rlp, 1, size, limit, tail);

    await d.fails("TradeCpi: 7 accounts", alice.key, [truncate(t(), 7)], builtin("NotEnoughAccountKeys"));
    await d.fails("TradeCpi: user not signed", lpUser.key, [unsigned(t(), 0)], pe("ExpectedSigner"));
    await d.fails("TradeCpi: size 0", alice.key, [t(0n)], builtin("InvalidInstructionData"));
    await d.fails("TradeCpi: slab read-only", alice.key, [readonly(t(), 2)], pe("ExpectedWritable"));
    await d.fails("TradeCpi: matcher context read-only", alice.key, [readonly(t(), 6)], pe("ExpectedWritable"));
    await d.fails("TradeCpi: matcher program not executable", alice.key, [replace(t(), 5, other.address)], builtin("InvalidAccountData"));
    await d.fails("TradeCpi: context of another owner", alice.key, [replace(t(), 6, other.address)], builtin("InvalidAccountData"));
    await d.fails("TradeCpi: context executable", alice.key, [replace(t(), 6, MATCHER)], builtin("InvalidAccountData"));
    const small = await d.address();
    d.write(small, MATCHER, Buffer.alloc(MATCHER_CTX_LEN - 1));
    await d.fails("TradeCpi: context too short", alice.key, [replace(t(), 6, small)], builtin("InvalidAccountData"));
    await d.fails("TradeCpi: wrong LP PDA", alice.key, [replace(t(), 7, other.address)], builtin("InvalidSeeds"));
    await d.fails("TradeCpi: wrong clock", alice.key, [replace(t(), 3, other.address)], builtin("InvalidArgument"));
    await d.fails("TradeCpi: free user slot", alice.key, [ix.tradeCpi(m, alice.key, lpUser.key.address, lp, 9, 1n)], pe("EngineAccountNotFound"));
    await d.fails("TradeCpi: another's account", alice.key, [ix.tradeCpi(m, alice.key, lpUser.key.address, lp, 2, 1n)], pe("EngineUnauthorized"));
    await d.fails("TradeCpi: not the LP's owner", alice.key, [ix.tradeCpi(m, alice.key, alice.key.address, lp, 1, 1n)], pe("EngineUnauthorized"));
    const plainLp: Lp = { idx: 2, matcher: MATCHER, ctx: lp.ctx, pda: await lpPda(m, 2) };
    await d.fails(
      "TradeCpi: an account without a matcher",
      alice.key,
      [ix.tradeCpi(m, alice.key, plain.key.address, plainLp, 1, 1n)],
      pe("EngineAccountKindMismatch"),
    );
    await d.fails(
      "TradeCpi: another LP's matcher context",
      alice.key,
      [ix.tradeCpi(m, alice.key, lpUser.key.address, { ...lp, ctx: rlp.ctx, matcher: ROGUE }, 1, 1n)],
      pe("EngineInvalidMatchingEngine"),
    );
    await d.fails(
      "TradeCpi: another matcher program",
      alice.key,
      [ix.tradeCpi(m, alice.key, ru.key.address, { ...rlp, matcher: MATCHER }, 1, 1n)],
      builtin("InvalidAccountData"),
    );
    // The matcher's own refusal (its context never initialized) fails the trade with the matcher's error.
    const blank = await d.user(m);
    const bctx = await d.address();
    d.write(bctx, MATCHER, Buffer.alloc(MATCHER_CTX_LEN));
    const bidx = d.freeHead(m);
    await d.ok("InitLP (matcher context not initialized)", blank.key, [ix.initLp(m, blank, MATCHER, bctx, SOL)]);
    const blankLp: Lp = { idx: bidx, matcher: MATCHER, ctx: bctx, pda: await lpPda(m, bidx) };
    await d.fails(
      "TradeCpi: the matcher refuses",
      alice.key,
      [ix.tradeCpi(m, alice.key, blank.key.address, blankLp, 1, 1_000_000n)],
      builtin("UninitializedAccount"),
    );
    // The answer.
    const good: Rogue = { mode: ECHO | FILL | PRICED };
    rogue(rlp, good);
    await d.ok("TradeCpi: a valid answer", alice.key, [tr()]);
    for (const [label, a, err] of [
      ["ABI version 1", { ...good, abi: 1 }, builtin("InvalidAccountData")],
      ["an unknown flag", { ...good, flags: 1 | 8 }, builtin("InvalidAccountData")],
      ["no VALID flag", { ...good, flags: 2 }, builtin("InvalidAccountData")],
      ["REJECTED", { ...good, flags: 1 | 4 }, builtin("InvalidAccountData")],
      ["another lp_account_id", { ...good, mode: 1n | 4n | FILL | PRICED, lpId: 77n }, builtin("InvalidAccountData")],
      ["another oracle price", { ...good, mode: 1n | 2n | FILL | PRICED, oracle: 5n }, builtin("InvalidAccountData")],
      ["reserved set", { ...good, reserved: 1n }, builtin("InvalidAccountData")],
      ["another req_id", { ...good, mode: 2n | 4n | FILL | PRICED, reqId: 1n }, builtin("InvalidAccountData")],
      ["exec price 0", { mode: ECHO | FILL, price: 0n }, builtin("InvalidAccountData")],
      ["zero size without PARTIAL_OK", { mode: ECHO | PRICED, size: 0n }, builtin("InvalidAccountData")],
      ["more than requested", { mode: ECHO | PRICED, size: 2_000_000n }, builtin("InvalidAccountData")],
      ["the other sign", { mode: ECHO | PRICED, size: -1_000_000n }, builtin("InvalidAccountData")],
      ["past MAX_ORACLE_PRICE", { mode: ECHO | FILL, price: 1_000_000_000_001n }, pe("OracleInvalid")],
      ["off the band (1%)", { mode: ECHO | FILL | PRICED, deltaBps: 101n }, pe("OracleInvalid")],
      ["off the band, below", { mode: ECHO | FILL | PRICED, deltaBps: -101n }, pe("OracleInvalid")],
    ] as [string, Rogue, string][]) {
      rogue(rlp, a);
      await d.fails(`TradeCpi: answer with ${label}`, alice.key, [tr()], err);
    }
    rogue(rlp, { mode: ECHO | FILL | PRICED, deltaBps: 100n });
    await d.ok("TradeCpi: at the edge of the band", alice.key, [tr()]);
    rogue(rlp, { mode: ECHO | HALF | PRICED, deltaBps: -20n });
    await d.ok("TradeCpi: a partial fill", alice.key, [tr(-4_000_000n)]);
    rogue(rlp, { mode: ECHO | PRICED, flags: 3, size: 0n });
    await d.ok("TradeCpi: zero fill with PARTIAL_OK", alice.key, [tr()]);
    // The tail goes to the matcher as it was passed. A matcher calling back into Percolator is stopped by the runtime
    // (Solana refuses A → B → A) before Percolator's own reentrancy flag is read: the flag cannot be reached this way.
    rogue(rlp, { mode: ECHO | FILL | PRICED | REENTER });
    await d.fails(
      "TradeCpi: the matcher re-enters Percolator",
      alice.key,
      [tr(1_000_000n, 0n, [r(PROGRAM), w(m.slab), r(CLOCK), r(m.oracle)])],
      builtin("ReentrancyNotAllowed"),
    );
    rogue(rlp, { mode: ECHO | FILL | PRICED });
    await d.ok("TradeCpi: a tail the matcher ignores", alice.key, [tr(1_000_000n, 0n, [r(SYSTEM), w(other.address)])]);
    // The nonce at u64::MAX refuses the trade (written in: 2^64 trades are out of reach).
    d.patch(m.slab, (b) => b.writeBigUInt64LE(0xffffffffffffffffn, H.nonce));
    await d.fails("TradeCpi: the nonce exhausted", alice.key, [tr()], pe("EngineOverflow"));
  });

  it("a patched slab: per-side position counts past i64", async () => {
    // The original adds the trade's net change to each side's position count as i64 (`count as i64 + after - before`,
    // wrapping: no overflow checks), refuses a negative result (EngineCorruptState), then compares it with `cap as
    // i64` (EngineOverflow). No instruction makes a count past max_accounts; these counts are written into both slabs.
    const m = await d.market();
    const lpUser = await funded(m, 100n * SOL, "lp");
    const alice = await funded(m, 10n * SOL, "alice");
    const long = () => ix.tradeNoCpi(m, alice.key, lpUser.key, 0, 1, 1_000_000n);
    const counts = (l: bigint, sh: bigint, cap?: bigint) =>
      d.patch(m.slab, (b) => {
        b.writeBigUInt64LE(l, E.storedPosCountLong);
        b.writeBigUInt64LE(sh, E.storedPosCountShort);
        if (cap !== undefined) b.writeBigUInt64LE(cap, E.params + P.maxActivePositionsPerSide);
      });
    for (const [label, l, sh, cap, err] of [
      ["long count 2^63 (i64::MIN)", 1n << 63n, 0n, undefined, pe("EngineCorruptState")],
      ["long count i64::MAX (wraps to MIN)", (1n << 63n) - 1n, 0n, undefined, pe("EngineCorruptState")],
      ["short count 2^64 - 1 (-1, then 0 net: the cap passes, the increment overflows)", 0n, (1n << 64n) - 1n, undefined, pe("EngineCorruptState")],
      ["long count 2^64 - 1 (-1 + 1 = 0: the cap passes, the increment overflows)", (1n << 64n) - 1n, 0n, undefined, pe("EngineCorruptState")],
      ["cap 2^63 (negative as i64)", 0n, 0n, 1n << 63n, pe("EngineOverflow")],
      ["cap u64::MAX", 0n, 0n, (1n << 64n) - 1n, pe("EngineOverflow")],
    ] as [string, bigint, bigint, bigint | undefined, string][]) {
      const before = Buffer.from(d.data(m.slab));
      counts(l, sh, cap);
      await d.fails(`TradeNoCpi: ${label}`, alice.key, [long()], err);
      d.patch(m.slab, (b) => before.copy(b));
    }
    await d.ok("TradeNoCpi: the counts as they were", alice.key, [long()]);
  });

  it("TradeCpi: the slab as the matcher sees it during the call", async () => {
    // The rogue matcher, given the slab as the first tail account, logs what it reads there during the call: the flags
    // byte, the nonce, fingerprints of the header, the config, the engine's state before its accounts and the LP's
    // entry, and the config's 400 bytes word by word. Both programs pass the same tail, so `both` compares those lines:
    // the port exposes the same intermediate slab as the original. The original reads the price into a copy of the
    // config and writes it back only after the call, so a price that moves the config (a newer observation, a Hyperp
    // index moving toward its mark) must not show in the slab yet; the matcher's lines are checked for that too.
    const fromLogs = (prefix: string) => {
      const line = d.lastLogs.split("\n").find((l) => l.startsWith(`Program log: ${prefix}, `));
      expect(line, `${prefix} logged`).toBeDefined();
      return line!
        .replace(/^Program log: /, "")
        .split(", ")
        .map((x) => BigInt(x));
    };
    const configWords = () => {
      const all = d.lastLogs.split("\n");
      const at = all.findIndex((l) => l.startsWith("Program log: 0xb5e7e1, "));
      const words = all.slice(at + 1, at + 11).flatMap((l) =>
        l
          .replace(/^Program log: /, "")
          .split(", ")
          .map((x) => BigInt(x)),
      );
      expect(words.length).toBe(50);
      const b = Buffer.alloc(400);
      words.forEach((v, i) => b.writeBigUInt64LE(v, i * 8));
      return b;
    };
    for (const hyperp of [false, true]) {
      const m = await d.market({
        edit: (a) => {
          Object.assign(a, { tradingFeeBps: 10n, hMax: 100n, minOraclePriceCapE2bps: 10_000n });
          if (hyperp) {
            a.feedId = Buffer.alloc(32);
            a.initialMarkPriceE6 = 100_000_000n;
            a.tail!.markMinFee = 10n;
          }
        },
      });
      const name = hyperp ? "Hyperp" : "Pyth";
      const ru = await d.user(m);
      const rlp = await rogueLp(m, ru, 100n * SOL);
      const alice = await funded(m, 10n * SOL, "alice");
      for (const [label, tail] of [
        ["writable", [w(m.slab)]],
        ["read-only", [r(m.slab)]],
      ] as const) {
        // A newer price (or, on Hyperp, slots for the index to move): the config read during the call differs from
        // the slab's.
        d.setClock(d.slot + 7n);
        if (!hyperp) d.setPrice(m, 100_500_000n + BigInt(d.slot % 1000n));
        const before = Buffer.from(d.data(m.slab).subarray(C.collateralMint, C.collateralMint + 400));
        const nonce = d.data(m.slab).readBigUInt64LE(H.nonce);
        rogue(rlp, { mode: ECHO | FILL | PRICED | OBSERVE });
        await d.ok(`TradeCpi ${name}: the slab in the tail (${label})`, alice.key, [
          ix.tradeCpi(m, alice.key, ru.key.address, rlp, 1, 1_000_000n, 0n, [...tail]),
        ]);
        const [, flags, seenNonce, len] = fromLogs("0xb5e7e0");
        expect(flags! & 4n, "FLAG_CPI_IN_PROGRESS set during the call").toBe(4n);
        expect(seenNonce, "the nonce not yet advanced").toBe(nonce);
        expect(len).toBe(BigInt(d.data(m.slab).length));
        const seen = configWords();
        expect(seen.equals(before), "the config during the call is the one from before the price read").toBe(true);
        const after = d.data(m.slab).subarray(C.collateralMint, C.collateralMint + 400);
        expect(Buffer.compare(after, before) !== 0, "the price read changed the config after the call").toBe(true);
        expect(d.data(m.slab)[H.flags]! & 4, "the flag cleared after the call").toBe(0);
      }
      // A zero fill (the config rolled back but for the oracle state): the same view during the call.
      d.setClock(d.slot + 7n);
      if (!hyperp) d.setPrice(m, 100_900_000n);
      rogue(rlp, { mode: ECHO | PRICED | OBSERVE, flags: 3, size: 0n });
      await d.ok(`TradeCpi ${name}: zero fill, the slab in the tail`, alice.key, [
        ix.tradeCpi(m, alice.key, ru.key.address, rlp, 1, 1_000_000n, 0n, [w(m.slab)]),
      ]);
      // A refused answer: the flag was set during the call; the refusal rolls the whole transaction back.
      rogue(rlp, { mode: PRICED | OBSERVE });
      await d.fails(
        `TradeCpi ${name}: refused answer, the slab in the tail`,
        alice.key,
        [ix.tradeCpi(m, alice.key, ru.key.address, rlp, 1, 1_000_000n, 0n, [w(m.slab)])],
        builtin("InvalidAccountData"),
      );
      expect(fromLogs("0xb5e7e0")[1]! & 4n).toBe(4n);
    }
  });

  it("ConvertReleasedPnl: warm-up, conversion, the haircut, refusals", async () => {
    const m = await d.market({ edit: (a) => Object.assign(a, { hMin: 0n, hMax: 40n, unitScale: 1000, initialMarginBps: 1000n, maintenanceMarginBps: 500n }) });
    const lpUser = await d.user(m);
    const lp = await d.lp(m, lpUser, 2_000_000_000n);
    const alice = await funded(m, 1_000_000_000n, "alice");
    const bob = await funded(m, 1_000_000_000n, "bob");
    // Alice long, against the LP; the price rises: her profit warms up over h_max slots.
    await d.ok("TradeNoCpi: alice long", alice.key, [ix.tradeNoCpi(m, alice.key, lpUser.key, lp.idx, 1, 50_000_000n)]);
    d.setClock(d.slot + 2n);
    d.setPrice(m, 110_000_000n);
    await d.ok("SettleAccount: alice (profit reserved)", alice.key, [ix.settleAccount(m, 1)]);
    await d.fails("ConvertReleasedPnl: nothing released yet", alice.key, [ix.convertReleasedPnl(m, alice, 1, 1000n)], pe("EngineOverflow"));
    await d.ok("SettleAccount: the LP (loss from capital)", lpUser.key, [ix.settleAccount(m, lp.idx)]);
    d.setClock(d.slot + 20n);
    await d.ok("SettleAccount: alice, half warmed", alice.key, [ix.settleAccount(m, 1)]);
    await d.fails("ConvertReleasedPnl: 0", alice.key, [ix.convertReleasedPnl(m, alice, 1, 0n)], pe("EngineOverflow"));
    await d.fails("ConvertReleasedPnl: off the unit scale", alice.key, [ix.convertReleasedPnl(m, alice, 1, 1500n)], builtin("InvalidArgument"));
    // Once the LP's loss is paid, alice's whole reserve is backed and matures on her next touch (admission on touch).
    const releasedNow = () => readI128(d.data(m.slab), accountAt(1) + A.pnl) - readI128(d.data(m.slab), accountAt(1) + A.reservedPnl);
    await d.fails(
      "ConvertReleasedPnl: more than released",
      alice.key,
      [ix.convertReleasedPnl(m, alice, 1, (releasedNow() + 1n) * 1000n)],
      pe("EngineOverflow"),
    );
    await d.ok("ConvertReleasedPnl: part of it", alice.key, [ix.convertReleasedPnl(m, alice, 1, 100_000_000n)]);
    await d.fails("ConvertReleasedPnl: another's account", bob.key, [ix.convertReleasedPnl(m, bob, 1, 1000n)], pe("EngineUnauthorized"));
    await d.fails("ConvertReleasedPnl: not signed", bob.key, [unsigned(ix.convertReleasedPnl(m, alice, 1, 1000n), 0)], pe("ExpectedSigner"));
    await d.fails("ConvertReleasedPnl: slab read-only", alice.key, [readonly(ix.convertReleasedPnl(m, alice, 1, 1000n), 1)], pe("ExpectedWritable"));
    await d.fails("ConvertReleasedPnl: 3 accounts", alice.key, [truncate(ix.convertReleasedPnl(m, alice, 1, 1000n), 3)], builtin("NotEnoughAccountKeys"));
    await d.fails("ConvertReleasedPnl: free slot", alice.key, [ix.convertReleasedPnl(m, alice, 9, 1000n)], pe("EngineAccountNotFound"));
    d.setClock(d.slot + 30n);
    await d.ok("ConvertReleasedPnl: the rest, warmed", alice.key, [ix.convertReleasedPnl(m, alice, 1, 150_000_000n)]);

    // The haircut: the LP's loss runs past its capital (an open short is not absorbed), so profit is backed by less
    // than it says. Bob takes alice's long; she is flat with released profit that is converted at the haircut.
    d.setClock(d.slot + 2n);
    d.setPrice(m, 160_000_000n);
    await d.ok("SettleAccount: the LP past its capital", lpUser.key, [ix.settleAccount(m, lp.idx)]);
    await d.ok("SettleAccount: alice, more profit", alice.key, [ix.settleAccount(m, 1)]);
    d.setClock(d.slot + 50n);
    await d.ok("SettleAccount: alice warmed", alice.key, [ix.settleAccount(m, 1)]);
    await d.both("TradeNoCpi: bob takes alice's long", alice.key, [ix.tradeNoCpi(m, bob.key, alice.key, 1, 2, 50_000_000n)]);
    const s = d.data(m.slab);
    const released = readI128(s, accountAt(1) + A.pnl) - readI128(s, accountAt(1) + A.reservedPnl);
    expect(released > 0n).toBe(true);
    await d.both("ConvertReleasedPnl: all of it at the haircut", alice.key, [ix.convertReleasedPnl(m, alice, 1, released * 1000n)]);
    await d.both("ConvertReleasedPnl: a part at the haircut", alice.key, [ix.convertReleasedPnl(m, alice, 1, 1_000_000n)]);
  });

  it("ConvertReleasedPnl: the flat-account cap (fee debt past the haircut profit)", async () => {
    // Maintenance fees drain alice's capital into debt while her profit is backed at a haircut: converting all of it
    // would leave her maintenance equity negative (max_safe_flat_conversion_released), so it is refused.
    const m = await d.market({ edit: (a) => Object.assign(a, { hMin: 0n, hMax: 10n, maintenanceFeePerSlot: 10_000_000n }) });
    const lpUser = await d.user(m);
    const lp = await d.lp(m, lpUser, SOL);
    const alice = await funded(m, SOL, "alice");
    const bob = await funded(m, 10n * SOL, "bob");
    await d.ok("TradeNoCpi: alice long", alice.key, [ix.tradeNoCpi(m, alice.key, lpUser.key, lp.idx, 1, 50_000_000n)]);
    d.setClock(d.slot + 2n);
    d.setPrice(m, 130_000_000n);
    await d.ok("SettleAccount: the LP past its capital", lpUser.key, [ix.settleAccount(m, lp.idx)]);
    await d.ok("TradeNoCpi: alice sells to bob (flat, profit not converted)", alice.key, [ix.tradeNoCpi(m, bob.key, alice.key, 1, 2, 50_000_000n)]);
    d.setClock(d.slot + 200n);
    await d.ok("SettleAccount: alice, fees past her capital", alice.key, [ix.settleAccount(m, 1)]);
    const s = d.data(m.slab);
    expect(readI128(s, accountAt(1) + A.feeCredits) < 0n).toBe(true);
    const released = readI128(s, accountAt(1) + A.pnl) - readI128(s, accountAt(1) + A.reservedPnl);
    await d.fails("ConvertReleasedPnl: past the flat-account cap", alice.key, [ix.convertReleasedPnl(m, alice, 1, released)], pe("EngineUndercollateralized"));
    await d.both("ConvertReleasedPnl: within the cap", alice.key, [ix.convertReleasedPnl(m, alice, 1, released / 10n)]);
  });
});
