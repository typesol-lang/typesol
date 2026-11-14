// Percolator v12.20 (showcase/mainnet/percolator) against the mainnet binary: KeeperCrank. Its candidate list (the
// risk buffer's entries with FullClose, then the instruction's candidates with their hints: FullClose, ExactPartial
// and its pre-flight, touch-only; missing slots and duplicates), the 64-attempt budget and the 128-candidate cap, the
// maintenance-fee syncs (candidates first, then the bitmap sweep from its cursor, at most 128, reclaiming the accounts
// the fees drained), the crank reward, the liquidations inside the crank with their ADL and resets, and the risk
// buffer's upkeep (scrub, refresh, the scan window, the candidates). Cranks run over many accounts and slots (funding,
// warm-up, fee debt). Every state comes from real instructions, but for a resolved market without its price, corrupt enum
// tags and a TradeCpi in progress, which no instruction leaves (written in).
import { type Instruction } from "@solana/kit";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  A,
  C,
  Diff,
  E,
  HAVE_ORIGINAL,
  type Market,
  PROGRAM,
  RISK_BUF_OFF,
  SLAB_LEN,
  SOL,
  type User,
  accountAt,
  builtin,
  computeUnits,
  cuSummary,
  ix,
  pe,
  readI128,
  readU128,
  readonly,
  replace,
  truncate,
  u8,
  u16,
  u128,
  unsigned,
  withData,
} from "./percolator-helpers.js";

const NO_CALLER = 65535;
const FULL = 0;
const PARTIAL = 1;
const TOUCH = 0xff;

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: KeeperCrank", () => {
  let d: Diff;
  beforeAll(async () => {
    d = await Diff.create();
  });
  afterAll(() => {
    if (process.env.PERCOLATOR_CU) console.table(cuSummary(d.rows));
  });

  async function funded(m: Market, amount: bigint, label: string): Promise<User> {
    const u = await d.user(m, amount > 1_000n * SOL ? amount : 1_000n * SOL);
    await d.ok(`${label}: InitUser`, u.key, [ix.initUser(m, u, amount)]);
    return u;
  }
  const slab = (m: Market) => d.data(m.slab);
  const acct = (m: Market, idx: number, field: keyof typeof A) => readI128(slab(m), accountAt(idx) + A[field]);
  const used = (m: Market, idx: number) => ((slab(m).readBigUInt64LE(E.used + 8 * (idx >> 6)) >> BigInt(idx & 63)) & 1n) === 1n;
  /** The risk buffer's indexes, in slot order. */
  const buffer = (m: Market) => {
    const s = slab(m);
    return Array.from({ length: s[RISK_BUF_OFF + 2]! }, (_, i) => s.readUInt16LE(RISK_BUF_OFF + 32 + 32 * i));
  };
  /** CRANK_STATS's second log line: the liquidations. */
  const liquidations = () => Number(BigInt(/Program log: 0xc8a4c, (0x[0-9a-f]+)/.exec(d.lastLogs)![1]!));

  it("permissionless and self cranks, and every refusal", async () => {
    const m = await d.market();
    const alice = await funded(m, 10n * SOL, "alice");
    const bob = await funded(m, 10n * SOL, "bob");
    const other = await d.funded();
    await d.ok("KeeperCrank: permissionless, no candidates", other, [ix.crank(m, other, NO_CALLER)]);
    expect(d.lastLogs).toContain("Program log: CRANK_STATS");
    expect(slab(m).readBigUInt64LE(E.lastCrankSlot)).toBe(d.slot);
    await d.ok("KeeperCrank: permissionless, the caller unsigned", other, [unsigned(ix.crank(m, other, NO_CALLER), 0)]);
    d.setClock(d.slot + 1n);
    await d.ok("KeeperCrank: self-crank by the owner", alice.key, [ix.crank(m, alice.key, 0)]);
    await d.fails("KeeperCrank: self-crank unsigned", other, [unsigned(ix.crank(m, alice.key, 0), 0)], pe("ExpectedSigner"));
    await d.fails("KeeperCrank: another's index", alice.key, [ix.crank(m, alice.key, 1)], pe("EngineUnauthorized"));
    await d.fails("KeeperCrank: a free index", alice.key, [ix.crank(m, alice.key, 7)], pe("EngineAccountNotFound"));
    await d.fails("KeeperCrank: index 4096", alice.key, [ix.crank(m, alice.key, 4096)], pe("EngineAccountNotFound"));
    const c = ix.crank(m, other, NO_CALLER);
    await d.fails("KeeperCrank: 3 accounts", other, [truncate(c, 3)], builtin("NotEnoughAccountKeys"));
    await d.fails("KeeperCrank: 5 accounts", other, [{ ...c, accounts: [...c.accounts!, c.accounts![2]!] }], builtin("NotEnoughAccountKeys"));
    await d.fails("KeeperCrank: slab read-only", other, [readonly(c, 1)], pe("ExpectedWritable"));
    await d.fails("KeeperCrank: wrong clock", other, [replace(c, 2, alice.key.address)], builtin("InvalidArgument"));
    // The instruction data: format 1 only, tags 0, 1 (with 16 bytes) and 0xff, nothing left over, at most 128.
    const data = (...parts: Buffer[]) => withData(c, Buffer.concat([u8(5), u16(NO_CALLER), ...parts]));
    await d.fails("KeeperCrank: no format byte", other, [withData(c, Buffer.concat([u8(5), u16(NO_CALLER)]))], builtin("InvalidInstructionData"));
    await d.fails("KeeperCrank: format 0", other, [data(u8(0))], builtin("InvalidInstructionData"));
    await d.fails("KeeperCrank: format 2", other, [data(u8(2), u16(0), u8(0))], builtin("InvalidInstructionData"));
    await d.fails("KeeperCrank: tag 2", other, [data(u8(1), u16(0), u8(2))], builtin("InvalidInstructionData"));
    await d.fails("KeeperCrank: a partial without its quantity", other, [data(u8(1), u16(0), u8(1), u8(1))], builtin("InvalidInstructionData"));
    await d.fails("KeeperCrank: two bytes left over", other, [data(u8(1), u16(0), u8(0), u8(0), u8(0))], builtin("InvalidInstructionData"));
    await d.ok("KeeperCrank: a partial with its quantity", other, [data(u8(1), u16(0), u8(1), u128(5n))]);
    await d.ok("KeeperCrank: a touch-only candidate", other, [data(u8(1), u16(1), u8(TOUCH))]);
    const many = (n: number) =>
      ix.crank(
        m,
        other,
        NO_CALLER,
        Array.from({ length: n }, (_, i) => [i % 3, TOUCH] as [number, number]),
      );
    await d.ok("KeeperCrank: 128 candidates", other, [many(128)]);
    await d.fails("KeeperCrank: 129 candidates", other, [many(129)], builtin("InvalidInstructionData"));
    // The slab: another owner's, the wrong length, not initialized, corrupt enum tags or a TradeCpi in progress
    // (written in: no instruction leaves those), for all three keeper instructions.
    const fresh = await d.newMarket();
    const wrongLen = await d.address();
    d.write(wrongLen, PROGRAM, Buffer.alloc(1000));
    const foreign = await d.address();
    d.write(foreign, other.address, Buffer.alloc(SLAB_LEN));
    const keepers: [string, (slab: Market) => Instruction][] = [
      ["KeeperCrank", (x) => ix.crank(x, other, NO_CALLER)],
      ["LiquidateAtOracle", (x) => ix.liquidate(x, other, 0)],
      ["CatchupAccrue", (x) => ix.catchupAccrue(x)],
    ];
    for (const [name, build] of keepers) {
      await d.fails(`${name}: not initialized`, other, [build(fresh)], pe("NotInitialized"));
      await d.fails(`${name}: slab of another owner`, other, [build({ ...m, slab: foreign })], builtin("IllegalOwner"));
      await d.fails(`${name}: slab of the wrong length`, other, [build({ ...m, slab: wrongLen })], pe("InvalidSlabLen"));
    }
    const snapshot = Buffer.from(slab(m));
    for (const [label, at, v] of [
      ["side mode 3", E.sideModeShort, 3],
      ["market mode 2", E.marketMode, 2],
      ["CPI in progress", 13, 4],
    ] as [string, number, number][]) {
      d.patch(m.slab, (b) => (b[at] = v));
      for (const [name, build] of keepers) await d.fails(`${name}: ${label}`, other, [build(m)], builtin("InvalidAccountData"));
      d.patch(m.slab, (b) => snapshot.copy(b));
    }
    // The oracle.
    d.setPrice(m, 100_000_000n, d.unixTimestamp - 4000n);
    await d.fails("KeeperCrank: stale oracle", other, [c], pe("OracleStale"));
    d.setPrice(m, 100_000_000n, d.unixTimestamp, -6, 8_000_000n);
    await d.fails("KeeperCrank: confidence too wide", other, [c], pe("OracleConfTooWide"));
    d.setPrice(m, 100_000_000n);
    d.setClock(d.slot + 6000n);
    await d.fails("KeeperCrank: matured stale", other, [c], pe("OracleStale"));
    // A resolved market (resolved by anyone past the hard timeout) cranks to nothing, whoever the caller.
    await d.ok("ResolvePermissionless", other, [ix.resolvePermissionless(m)]);
    await d.ok("KeeperCrank: resolved (nothing to do)", other, [ix.crank(m, bob.key, 5)]);
    // Resolved with its price unset: refused. No instruction leaves that state (resolution refuses a zero price), so it
    // is written in.
    d.patch(m.slab, (b) => b.writeBigUInt64LE(0n, E.resolvedPrice));
    await d.fails("KeeperCrank: resolved without a price", other, [c], builtin("InvalidAccountData"));
  });

  it("liquidations in the crank: the risk buffer first, then each hint", async () => {
    const m = await d.market();
    const lp = await funded(m, 2_000n * SOL, "lp");
    // Three healthy whales hold the risk buffer's places beside the LP.
    for (let i = 0; i < 3; i++) {
      const w = await funded(m, 40n * SOL, `whale ${i}`);
      await d.ok(`whale ${i}: TradeNoCpi`, w.key, [ix.tradeNoCpi(m, w.key, lp.key, 0, 1 + i, BigInt(20 + i) * 100_000_000n)]);
    }
    const thin: User[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await funded(m, 10n * SOL, `thin ${i}`);
      thin.push(u);
      await d.ok(`thin ${i}: TradeNoCpi long 9`, u.key, [ix.tradeNoCpi(m, u.key, lp.key, 0, 4 + i, 900_000_000n)]);
    }
    expect(buffer(m).sort()).toEqual([0, 1, 2, 3]);
    d.setClock(d.slot + 4n);
    d.setPrice(m, 92_000_000n);
    const other = await d.funded();
    // Thin 0: FullClose. Thin 1: a partial that leaves it healthy. Thin 2: a partial too small (no action). Thin 3:
    // touch only. A free slot, an index past 4096 and a duplicate are skipped or repeated.
    await d.ok("KeeperCrank: hints", other, [
      ix.crank(m, other, NO_CALLER, [
        [4, FULL],
        [9999, FULL],
        [5, PARTIAL, 600_000_000n],
        [6, PARTIAL, 100_000_000n],
        [7, TOUCH],
        [40, FULL],
        [4, FULL],
        [6, PARTIAL, 900_000_000n],
      ]),
    ]);
    expect(liquidations()).toBe(2);
    expect(acct(m, 4, "positionBasisQ")).toBe(0n);
    expect(acct(m, 5, "positionBasisQ")).toBe(300_000_000n);
    expect(acct(m, 6, "positionBasisQ")).toBe(900_000_000n);
    expect(acct(m, 7, "positionBasisQ")).toBe(900_000_000n);
    // The touched candidates entered the risk buffer if larger than its smallest; flat ones left it.
    expect(buffer(m)).not.toContain(4);
    // A self-crank by thin 2, its own FullClose.
    await d.ok("KeeperCrank: thin 2 liquidates thin 2 and 3", thin[2]!.key, [
      ix.crank(m, thin[2]!.key, 6, [
        [6, FULL],
        [7, FULL],
        [8, FULL],
      ]),
    ]);
    expect(liquidations()).toBe(3);
    // The whales: the price falls further and the buffer's FullClose reaches them without being named.
    d.setClock(d.slot + 4n);
    d.setPrice(m, 82_000_000n);
    await d.ok("KeeperCrank: the risk buffer liquidates the whales", other, [ix.crank(m, other, NO_CALLER)]);
    expect(liquidations()).toBe(3);
    expect(buffer(m)).toEqual([0]);
  });

  it("the attempt budget: 64 valid candidates, the 65th not touched", async () => {
    const m = await d.market({ edit: (a) => (a.maintenanceFeePerSlot = 10n) });
    const users: User[] = [];
    for (let i = 0; i < 70; i++) users.push(await funded(m, SOL, `user ${i}`));
    d.setClock(d.slot + 100n);
    const other = await d.funded();
    // Every candidate is synced (fees) and touched up to 64; the 65th..70th keep their old fee slot.
    await d.ok("KeeperCrank: 70 candidates", other, [
      computeUnits(1_400_000),
      ix.crank(
        m,
        other,
        NO_CALLER,
        Array.from({ length: 70 }, (_, i) => [i, TOUCH] as [number, number]),
      ),
    ]);
    expect(slab(m).readBigUInt64LE(accountAt(63) + A.lastFeeSlot)).toBe(d.slot);
  });

  it("cranks over many accounts and slots: the fee sweep and its cursor, dust reclaimed, fee debt, the reward, funding, warm-up", async () => {
    const m = await d.market({
      edit: (a) => {
        Object.assign(a, { maintenanceFeePerSlot: 1000n, hMax: 200n, minOraclePriceCapE2bps: 1_000_000n, tradingFeeBps: 10n });
        a.tail!.permissionlessResolveStaleSlots = 0n;
      },
    });
    const lp = await funded(m, 5_000n * SOL, "lp");
    const keeper = await funded(m, 10n * SOL, "keeper");
    const users: User[] = [];
    for (let i = 0; i < 150; i++) users.push(await funded(m, i % 3 === 0 ? 200_000n : 50n * SOL, `user ${i}`));
    // Every third user is dust (200,000 units, flat); the others trade both ways.
    for (let i = 1; i < 150; i += 3) {
      const idx = 2 + i;
      await d.ok(`user ${i}: TradeNoCpi`, users[i]!.key, [
        ix.tradeNoCpi(m, users[i]!.key, lp.key, 0, idx, (i % 2 === 0 ? 1n : -1n) * BigInt(1 + (i % 7)) * 10_000_000n),
      ]);
    }
    const before = slab(m).readUInt16LE(E.numUsedAccounts);
    expect(before).toBe(152);
    const cursor = () => [slab(m).readBigUInt64LE(C.feeSweepCursorWord), slab(m).readBigUInt64LE(C.feeSweepCursorBit)];
    // Crank after crank: at most 128 syncs each, the cursor stopping inside a word and resuming there.
    const cranks: bigint[][] = [];
    for (let round = 0; round < 6; round++) {
      d.setClock(d.slot + 25n);
      d.setPrice(m, 100_000_000n + BigInt(round) * 700_000n);
      await d.ok(`round ${round}: KeeperCrank`, keeper.key, [computeUnits(1_400_000), ix.crank(m, keeper.key, 1)]);
      cranks.push(cursor());
    }
    expect(cranks.some(([, bit]) => bit !== 0n)).toBe(true);
    // The keeper was paid half of what the sweep collected.
    expect(acct(m, 1, "capital") > 10n * SOL - 200_000n).toBe(true);
    expect(readI128(slab(m), E.fLongNum)).not.toBe(0n);
    // 200 slots more of fees: the dust accounts' 200,000 is gone, and the sweep frees their slots.
    for (let round = 0; round < 4; round++) {
      d.setClock(d.slot + 60n);
      d.setPrice(m, 103_000_000n);
      await d.ok(`drain ${round}: KeeperCrank`, keeper.key, [computeUnits(1_400_000), ix.crank(m, keeper.key, NO_CALLER)]);
    }
    expect(slab(m).readUInt16LE(E.numUsedAccounts)).toBe(before - 50);
    expect(used(m, 2)).toBe(false);
    // Warm-up: profits reserved by the touches mature over h_max slots, crank after crank.
    const reserved = () => users.reduce((t, _, i) => t + (used(m, 2 + i) ? acct(m, 2 + i, "reservedPnl") : 0n), 0n);
    expect(reserved() > 0n || readU128(slab(m), E.pnlMaturedPosTot) > 0n).toBe(true);
    const all = Array.from({ length: 50 }, (_, k) => [3 + 3 * k, TOUCH] as [number, number]);
    for (let round = 0; round < 3; round++) {
      d.setClock(d.slot + 100n);
      d.setPrice(m, 103_000_000n);
      await d.ok(`warm-up ${round}: KeeperCrank touching the traders`, keeper.key, [computeUnits(1_400_000), ix.crank(m, keeper.key, 1, all)]);
    }
    expect(reserved()).toBe(0n);
  });

  it("fee debt from the sweep on an open position, paid with DepositFeeCredits", async () => {
    const m = await d.market({ edit: (a) => (a.maintenanceFeePerSlot = 1000n) });
    const lp = await funded(m, 100n * SOL, "lp");
    for (let i = 0; i < 4; i++) {
      const w = await funded(m, 100n * SOL, `big ${i}`);
      await d.ok(`big ${i}: TradeNoCpi`, w.key, [ix.tradeNoCpi(m, w.key, lp.key, 0, 1 + i, 100_000_000n)]);
    }
    // Alice's position is the smallest: the risk buffer does not hold her, so no crank touches her.
    const alice = await funded(m, 50_000n, "alice");
    await d.ok("TradeNoCpi: alice, a tiny position", alice.key, [ix.tradeNoCpi(m, alice.key, lp.key, 0, 5, 1_000n)]);
    d.setClock(d.slot + 80n);
    const other = await d.funded();
    await d.ok("KeeperCrank: the sweep charges 80,000 against 50,000", other, [ix.crank(m, other, NO_CALLER)]);
    expect(acct(m, 5, "capital")).toBe(0n);
    expect(acct(m, 5, "feeCredits")).toBe(-30_000n);
    expect(used(m, 5)).toBe(true);
  });
});
