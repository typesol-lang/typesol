// showcase/mainnet/percolator against Percolator v12.20 as deployed on mainnet (test/programs/percolator_v12.so): a
// seeded random walk over markets of random shape (unit scale, account fee, maintenance fee, warm-up bounds, oracle
// cap, trading fee, margins, Pyth or Hyperp) and random sequences of account opens (InitUser, InitLP bound to the
// matcher or to nothing), deposits, withdrawals, closes, settles, reclaims, insurance top-ups, fee-credit payments,
// trades between users and LPs (TradeNoCpi, and TradeCpi through the TypeSOL matcher, Passive or vAMM, run under both
// programs), conversions of released PnL, config updates, price moves (fresh, older, stale, wide) and clock moves, so
// that accrual, funding from the trade mark, warm-up, the haircut, loss settlement and the margin checks run on varied
// state. Every step goes to both programs through `Diff.both` (outcome, error code, logs, inner instructions, return
// data, the whole slab and every named account); refusals are part of the walk, not skipped. Each walk ends with the end
// of its market (`endOfLife`): resolution, every account closed out, the insurance withdrawn, CloseSlab.
//
// Seeds 1 to 6 by default; PERCOLATOR_FUZZ_RUNS=<n> walks seeds 1 to n, PERCOLATOR_FUZZ_SEED=<seed> that one only,
// PERCOLATOR_FUZZ_STEPS=<n> changes the length (160).
import { type Address, type KeyPairSigner, createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import {
  A,
  C,
  CHAINLINK,
  Diff,
  E,
  HAVE_ORIGINAL,
  type InitMarketArgs,
  type Market,
  SOL,
  SYSTEM,
  type CuRow,
  type Lp,
  MATCHER,
  MATCHER_CTX_LEN,
  PYTH_RECEIVER,
  type User,
  accountAt,
  computeUnits,
  cuSummary,
  ix,
  lpPda,
  matcherInit,
  key,
  passiveMatcher,
  pythBytes,
  readI128,
  readU128,
  writeU128,
} from "./percolator-helpers.js";

const RUNS = Number(process.env.PERCOLATOR_FUZZ_RUNS ?? 6);
const SEEDS = process.env.PERCOLATOR_FUZZ_SEED ? [BigInt(process.env.PERCOLATOR_FUZZ_SEED)] : Array.from({ length: RUNS }, (_, i) => BigInt(i + 1));
const STEPS = Number(process.env.PERCOLATOR_FUZZ_STEPS ?? 160);

/**
 * The oracle a walk's market reads. "default": a Pyth feed at exponent -6 without a confidence interval (the account
 * walk's own markets, Hyperp in a quarter of them); the others force one shape on every market of the oracle walk:
 * a Chainlink OCR2 feed, an inverted Pyth market, a Pyth feed at another exponent with its confidence at the market's
 * limit (past it when the walk asks for a wide one), a Hyperp market.
 */
type OracleKind = "default" | "chainlink" | "inverted" | "pyth-expo" | "hyperp";
interface Oracle {
  kind: OracleKind;
  /** Pyth's exponent (pyth-expo). */
  expo: number;
  /** The market's conf_filter_bps (pyth-expo). */
  confBps: number;
  /** Chainlink's decimals. */
  decimals: number;
}
const DEFAULT_ORACLE: Oracle = { kind: "default", expo: -6, confBps: 500, decimals: 8 };

/** Publish `price` (e6, before any inversion) at `when`; `wide`: a confidence interval past the market's limit (Pyth). */
function quote(d: Diff, m: Market, o: Oracle, price: bigint, when = d.unixTimestamp, wide = false): void {
  if (o.kind === "chainlink") {
    const b = Buffer.alloc(232);
    b[138] = o.decimals;
    b.writeBigUInt64LE(when, 208);
    writeU128(b, 216, price * 10n ** BigInt(o.decimals - 6));
    d.write(m.oracle, CHAINLINK, b);
  } else if (o.kind === "pyth-expo") {
    const raw = o.expo <= -6 ? price * 10n ** BigInt(-6 - o.expo) : price / 10n ** BigInt(o.expo + 6);
    // conf · 10_000 <= price · conf_filter_bps passes: the largest conf that does, or one more.
    const limit = (raw * BigInt(o.confBps)) / 10_000n;
    d.write(m.oracle, PYTH_RECEIVER, pythBytes({ feedId: m.feedId, price: raw, expo: o.expo, conf: wide ? limit + 1n : limit, publishTime: when }));
  } else d.setPrice(m, price, when, -6, wide ? price / 10n : 0n);
}

/** What a step's ADL events are read against: the engine's side state before the step. */
interface Sides {
  price: bigint;
  a: bigint[];
  k: bigint[];
  oi: bigint[];
  epoch: bigint[];
  mode: number[];
}

function snapshot(s: Buffer): Sides {
  return {
    price: s.readBigUInt64LE(E.lastOraclePrice),
    a: [readU128(s, E.adlMultLong), readU128(s, E.adlMultShort)],
    k: [readI128(s, E.adlCoeffLong), readI128(s, E.adlCoeffShort)],
    oi: [readU128(s, E.oiEffLongQ), readU128(s, E.oiEffShortQ)],
    epoch: [s.readBigUInt64LE(E.adlEpochLong), s.readBigUInt64LE(E.adlEpochShort)],
    mode: [s[E.sideModeLong]!, s[E.sideModeShort]!],
  };
}

/** The ADL events over every walk (PERCOLATOR_FUZZ_VERBOSE prints them). */
const events = new Map<string, number>();

/**
 * The ADL events of one step, from the slab before and after it: A shrunk; K lowered past the step's mark-to-market
 * (K_before ± A_before · Δprice while the side had open interest: the loss of a bankruptcy past insurance written
 * into the side's K); a side turned drain-only; a reset begun (the epoch moved); a reset finished (a reset-pending
 * side back to normal, its stale accounts settled).
 */
function countEvents(before: Sides, e: Buffer, reached: Map<string, number>): void {
  const dp = e.readBigUInt64LE(E.lastOraclePrice) - before.price;
  for (const [side, name] of [
    [0, "long"],
    [1, "short"],
  ] as const) {
    const count = (what: string) => {
      reached.set(`event: ${what}`, (reached.get(`event: ${what}`) ?? 0) + 1);
      events.set(what, (events.get(what) ?? 0) + 1);
    };
    const a = readU128(e, side === 0 ? E.adlMultLong : E.adlMultShort);
    const k = readI128(e, side === 0 ? E.adlCoeffLong : E.adlCoeffShort);
    const epoch = e.readBigUInt64LE(side === 0 ? E.adlEpochLong : E.adlEpochShort);
    const mode = e[side === 0 ? E.sideModeLong : E.sideModeShort]!;
    if (epoch !== before.epoch[side]) count(`reset begun (${name})`);
    else {
      if (a < before.a[side]!) count(`A shrunk (${name})`);
      const marked = before.k[side]! + (before.oi[side] !== 0n ? (side === 0 ? 1n : -1n) * before.a[side]! * dp : 0n);
      if (k < marked) count(`loss socialised into K (${name})`);
    }
    if (mode === 1 && before.mode[side] !== 1) count(`drain-only (${name})`);
    if (mode === 0 && before.mode[side] === 2) count(`reset finished (${name})`);
  }
}

/** Full life cycles that reached CloseSlab (PERCOLATOR_FUZZ_VERBOSE prints them). */
let lifeCycles = 0;
/** Full life cycles by market shape: the oracle kind (Pyth -6 and Hyperp apart for the default walks). */
const cyclesByShape = new Map<string, number>();
const endReached = new Map<string, number>();

/**
 * The end of a market's life, after a walk: a few bounded insurance withdrawals (WithdrawInsuranceLimited, when the
 * market allows them), then resolution, by the admin (the oracle fresh at a moved price, stale or too wide; catch-ups
 * and retries where the original refuses) or permissionless after the hard timeout (an early try first); then, in random
 * order, the three resolved closes (CloseAccount, ForceCloseResolved before and after its delay, AdminForceCloseAccount),
 * insurance withdrawals and CloseSlab tried too early, live instructions refused, cranks, clock moves; then every account
 * still open closed (winners stay open, reconciled, until the market is terminal-ready), WithdrawInsurance, CloseSlab.
 * Every transaction goes to both programs; at the end the vault and every token account are compared once more.
 */
async function endOfLife(
  d: Diff,
  m: Market,
  owners: Map<number, User>,
  tokenAccounts: Address[],
  rng: Rng,
  label: string,
  o: { hyperp: boolean; permissionless: boolean; price: bigint; oracle: Oracle },
): Promise<void> {
  const count = (k: string) => endReached.set(k, (endReached.get(k) ?? 0) + 1);
  const used = (idx: number) => ((d.data(m.slab).readBigUInt64LE(E.used + 8 * (idx >> 6)) >> BigInt(idx & 63)) & 1n) === 1n;
  const prune = () => {
    for (const idx of [...owners.keys()]) if (!used(idx)) owners.delete(idx);
  };
  prune();
  const keeper = await d.funded(10n);
  const adminAta = await d.tokenAccount(m.mint, m.admin.address);
  const unitScale = BigInt(Math.max(d.data(m.slab).readUInt32LE(C.unitScale), 1));
  let price = o.price;
  const both = async (name: string, payer: KeyPairSigner, ixs: Parameters<Diff["both"]>[2]) => {
    const res = await d.both(`${label}: ${name}`, payer, ixs);
    count(`${name.split(" ")[0]} ${res === "ok" ? "ok" : res.replace(/.*error: /, "").replace(/ }.*/, "")}`);
    return res;
  };
  // Bounded withdrawals on the live market (refused when turned off, too large, too soon, or with nothing left).
  if (d.data(m.slab).readUInt16LE(C.insuranceWithdrawMaxBps) > 0)
    for (let i = rng.int(4); i > 0; i--) {
      const ins = readU128(d.data(m.slab), E.insurance);
      const units = rng.pick([1n, 10n, ins / 20n + 1n, ins / 5n, ins + 1n]);
      await both("WithdrawInsuranceLimited", m.admin, [ix.withdrawInsuranceLimited(m, m.admin, adminAta, units * unitScale)]);
      d.setClock(d.slot + BigInt(rng.pick([1, 10, 60])));
      if (!o.hyperp) quote(d, m, o.oracle, price);
    }
  const resolvedNow = () => d.data(m.slab)[E.marketMode] === 1;
  if (o.permissionless && rng.chance(40)) {
    if (rng.chance(50)) await both("ResolvePermissionless (early)", keeper, [ix.resolvePermissionless(m)]);
    if (!resolvedNow()) {
      d.setClock(d.slot + 5000n + BigInt(rng.int(3000)));
      await both("ResolvePermissionless", keeper, [ix.resolvePermissionless(m)]);
    }
  } else {
    // The oracle at resolution: a move, an older observation, stale, or too wide.
    const mv = rng.int(8);
    price = mv < 5 ? (price * BigInt(rng.pick([60, 85, 97, 100, 103, 115, 160]))) / 100n + 1n : price;
    const when = mv === 5 ? d.unixTimestamp - 4000n : mv === 6 ? d.unixTimestamp - BigInt(rng.int(50)) : d.unixTimestamp;
    if (!o.hyperp) quote(d, m, o.oracle, price, when, mv === 7);
    else if (rng.chance(60)) await both("PushHyperpMark", m.admin, [ix.pushHyperpMark(m, m.admin, price / 100n + 1n, 0n)]);
    for (let attempt = 0; attempt < 30 && !resolvedNow(); attempt++) {
      const res = await both("ResolveMarket", m.admin, [ix.resolveMarket(m, m.admin)]);
      if (res === "ok") break;
      if (res.includes(`code: ${29} }`)) await both("CatchupAccrue", keeper, [ix.catchupAccrue(m)]);
      else {
        // Past the Hyperp deviation band: let the index catch up with the mark.
        d.setClock(d.slot + 300n);
        if (o.hyperp) await both("PushHyperpMark", m.admin, [ix.pushHyperpMark(m, m.admin, price / 100n + 1n, 0n)]);
        else quote(d, m, o.oracle, price);
      }
    }
  }
  if (!resolvedNow() && o.permissionless) {
    d.setClock(d.slot + 6000n);
    await both("ResolveMarket (hard timeout)", m.admin, [ix.resolveMarket(m, m.admin)]);
  }
  expect(resolvedNow(), `${label}: resolved`).toBe(true);
  count(
    `resolved: ${d.data(m.slab).readBigUInt64LE(E.resolvedPrice) === d.data(m.slab).readBigUInt64LE(E.resolvedLivePrice) ? "at the live price" : "a terminal delta"}`,
  );
  for (const side of [E.sideModeLong, E.sideModeShort])
    if (d.data(m.slab).readBigUInt64LE(side === E.sideModeLong ? E.staleAccountCountLong : E.staleAccountCountShort) > 0n) count("resolved: stale accounts");

  const close = async (idx: number, how: number) => {
    const u = owners.get(idx)!;
    let res = "";
    if (how === 0) res = await both(`CloseAccount ${idx}`, u.key, [ix.closeAccount(m, u, idx)]);
    else if (how === 1) res = await both(`ForceCloseResolved ${idx}`, keeper, [ix.forceCloseResolved(m, idx, u.ata)]);
    else res = await both(`AdminForceCloseAccount ${idx}`, m.admin, [ix.adminForceCloseAccount(m, m.admin, idx, u.ata)]);
    if (res === "ok") {
      if (used(idx)) count("close: progress only");
      else {
        owners.delete(idx);
        if (d.data(m.slab)[E.resolvedPayoutReady] === 1 && readU128(d.data(m.slab), E.resolvedPayoutHNum) < readU128(d.data(m.slab), E.resolvedPayoutHDen))
          count("close: paid below a haircut of 1");
      }
    }
  };
  // The random part.
  for (let step = 0, n = owners.size * 3 + 6; step < n; step++) {
    const a = rng.int(12);
    if (a < 5 && owners.size > 0) await close(rng.pick([...owners.keys()]), rng.int(3));
    else if (a === 5) d.setClock(d.slot + BigInt(rng.pick([1, 30, 120])));
    else if (a === 6) await both("WithdrawInsurance", m.admin, [ix.withdrawInsurance(m, m.admin, adminAta)]);
    else if (a === 7) {
      // Too early, unless every account is closed and the insurance withdrawn already: then the market ends here.
      if ((await both("CloseSlab", m.admin, [ix.closeSlab(m, adminAta)])) === "ok") break;
    } else if (a === 8)
      await both("KeeperCrank", keeper, [
        ix.crank(
          m,
          keeper,
          65535,
          [...owners.keys()].slice(0, 4).map((i) => [i, 0] as [number, number]),
        ),
      ]);
    else if (a === 9) await both(`ForceCloseResolved ${a}`, keeper, [ix.forceCloseResolved(m, rng.int(4097), adminAta)]);
    else if (owners.size > 0) {
      // A live instruction on the resolved market: refused.
      const idx = rng.pick([...owners.keys()]);
      const u = owners.get(idx)!;
      const live = rng.int(5);
      if (live === 0) await both(`Deposit ${idx}`, u.key, [ix.deposit(m, u, idx, unitScale)]);
      else if (live === 1) await both(`Withdraw ${idx}`, u.key, [ix.withdraw(m, u, idx, unitScale)]);
      else if (live === 2) await both(`SettleAccount ${idx}`, keeper, [ix.settleAccount(m, idx)]);
      else if (live === 3) await both(`LiquidateAtOracle ${idx}`, keeper, [ix.liquidate(m, keeper, idx)]);
      else await both("WithdrawInsuranceLimited", m.admin, [ix.withdrawInsuranceLimited(m, m.admin, adminAta, unitScale)]);
    }
  }
  const slabClosed = !d.original.getAccount(m.slab).exists;
  if (slabClosed) count("CloseSlab during the random part");
  // Everything still open, losers first; winners reconciled earlier are paid once the market is terminal-ready.
  d.setClock(d.slot + 10_000n);
  for (let pass = 0; pass < 6 && owners.size > 0; pass++) {
    const s = d.data(m.slab);
    const order = [...owners.keys()].sort((x, y) => (readI128(s, accountAt(x) + A.pnl) < readI128(s, accountAt(y) + A.pnl) ? -1 : 1));
    for (const idx of order) await close(idx, rng.int(3));
  }
  expect(owners.size, `${label}: every account closed`).toBe(0);
  if (!slabClosed) {
    expect(d.data(m.slab).readUInt16LE(E.numUsedAccounts), `${label}: no account left`).toBe(0);
    await both("WithdrawInsurance", m.admin, [ix.withdrawInsurance(m, m.admin, adminAta)]);
    expect(await both("CloseSlab", m.admin, [ix.closeSlab(m, adminAta)]), `${label}: CloseSlab`).toBe("ok");
  }
  for (const a of [m.vault, m.slab, adminAta, ...tokenAccounts]) d.expectSame(a, `${label}: ${a} at the end`);
  lifeCycles++;
  const shape = o.oracle.kind === "default" ? (o.hyperp ? "Hyperp (account walk)" : "Pyth -6") : o.oracle.kind;
  cyclesByShape.set(shape, (cyclesByShape.get(shape) ?? 0) + 1);
}

/**
 * The account walk on one market: `steps` random steps, then the end of the market (endOfLife). The market's shape is
 * drawn from the seed; `oracle` forces its oracle (see Oracle). Returns the walk's compared transactions.
 */
async function accountWalk(seed: bigint, steps: number, oracle: Oracle, reached: Map<string, number>): Promise<CuRow[]> {
  const rng = new Rng(seed);
  const keys = new Rng(seed ^ 0x6b657973n);
  const d = await Diff.create(async () => createKeyPairSignerFromPrivateKeyBytes(keys.bytes(32)));
  const endRng = new Rng(seed ^ 0xe0dn);
  const drawnHyperp = rng.chance(25);
  const hyperp = oracle.kind === "default" ? drawnHyperp : oracle.kind === "hyperp";
  const tag = oracle.kind === "default" ? `seed ${seed}` : `${oracle.kind} seed ${seed}`;
  const start = oracle.kind === "inverted" ? 2_000_000n : 100_000_000n;
  // Some markets without permissionless resolution (a price-cap floor instead), so that the clock can run past the
  // accrual envelope without the oracle going terminally stale.
  const noStale = !hyperp && rng.chance(30);
  const imBps = rng.pick([1000n, 2000n, 5000n]);
  const unitScale = rng.pick([0, 0, 0, 1, 1000]);
  const edit = (a: InitMarketArgs) => {
    a.unitScale = unitScale;
    a.newAccountFee = rng.pick([0n, 0n, 1000n, 50_000n]);
    a.maintenanceFeePerSlot = rng.pick([0n, 0n, 1n, 100n, 10_000n]);
    a.hMin = rng.pick([0n, 1n, 10n]);
    a.hMax = a.hMin + rng.pick([1n, 50n, 400n, 3000n]);
    a.minOraclePriceCapE2bps = noStale ? rng.pick([5_000n, 100_000n, 1_000_000n]) : rng.pick([0n, 0n, 5_000n, 100_000n]);
    if (noStale) a.tail!.permissionlessResolveStaleSlots = 0n;
    a.maxAccounts = rng.pick([4096n, 6n]);
    a.initialMarginBps = imBps;
    a.tradingFeeBps = rng.pick([0n, 0n, 1n, 10n, 30n]);
    a.maintenanceMarginBps = a.initialMarginBps / 2n;
    if (hyperp) {
      a.feedId = Buffer.alloc(32);
      a.initialMarkPriceE6 = 1_000_000n + BigInt(rng.int(100_000_000));
      a.tail!.markMinFee = 10n;
    }
    if (endRng.chance(50)) {
      a.tail!.insuranceWithdrawMaxBps = endRng.pick([1, 500, 10_000]);
      a.tail!.insuranceWithdrawCooldownSlots = endRng.pick([1n, 30n]);
    }
    if (oracle.kind === "inverted") a.invert = 1;
    if (oracle.kind === "pyth-expo") a.confFilterBps = oracle.confBps;
  };
  // A Chainlink feed is named by its account's key; a Pyth feed at another exponent replaces the default account.
  const prepare =
    oracle.kind === "chainlink" || oracle.kind === "pyth-expo"
      ? (mk: Market, a: InitMarketArgs) => {
          if (oracle.kind === "chainlink") a.feedId = key(mk.oracle);
          quote(d, mk, oracle, start);
        }
      : undefined;
  const m: Market = await d.market({ edit, prepare, price: start, label: `${tag}: InitMarket` });
  const users: User[] = [];
  const owners = new Map<number, User>();
  const lps = new Map<number, Lp>();
  let price = start;
  let ok = 0;
  const okBy = new Map<string, number>();
  const amount = (): bigint => {
    const raw = rng.pick([0n, 1n, 999n, 1000n, 123_456n, SOL, 7n * SOL, 1_000_000n * SOL]) + (rng.chance(30) ? BigInt(rng.int(1_000_000)) : 0n);
    return unitScale > 1 && rng.chance(80) ? (raw / BigInt(unitScale)) * BigInt(unitScale) : raw;
  };
  const someIdx = () => (owners.size > 0 && rng.chance(85) ? rng.pick([...owners.keys()]) : rng.int(8));
  const someUser = async (): Promise<User> => {
    if (users.length === 0 || rng.chance(15)) {
      const u = await d.user(m, rng.pick([10n * SOL, 1_000_000n * SOL, 5000n]));
      users.push(u);
      return u;
    }
    return rng.pick(users);
  };
  if (oracle.kind !== "default")
    // The oracle walk opens accounts to trade from the start: two users, an LP bound to the matcher, a plain LP.
    for (const kind of ["user", "user", "matcher", "lp"]) {
      const u = await d.user(m, 1_000_000n * SOL);
      users.push(u);
      const head = d.freeHead(m);
      if (kind === "matcher") {
        const lp = await d.lp(m, u, 100n * SOL, passiveMatcher(), `${tag} opening`);
        lps.set(lp.idx, lp);
      } else
        await d.ok(`${tag} opening: ${kind === "lp" ? "InitLP" : "InitUser"}`, u.key, [
          kind === "lp" ? ix.initLp(m, u, SYSTEM, SYSTEM, 100n * SOL) : ix.initUser(m, u, 100n * SOL),
        ]);
      owners.set(head, u);
    }
  for (let step = 0; step < steps; step++) {
    const label = `${tag} step ${step}`;
    const action = rng.int(34);
    let res = "";
    const before = snapshot(d.data(m.slab));
    if (action === 0 || action === 1) {
      const u = await someUser();
      const head = d.freeHead(m);
      const kind = rng.int(10);
      if (kind < 4) {
        // An LP bound to the matcher: its context, InitLP, the matcher's Init with the LP PDA.
        const ctx = await d.address();
        d.write(ctx, MATCHER, Buffer.alloc(MATCHER_CTX_LEN));
        res = await d.both(`${label}: InitLP (matcher)`, u.key, [ix.initLp(m, u, MATCHER, ctx, amount())]);
        if (res === "ok") {
          owners.set(head, u);
          const pda = await lpPda(m, head);
          const vamm = rng.chance(40);
          const p = passiveMatcher({
            kind: vamm ? 1 : 0,
            tradingFeeBps: rng.pick([0, 5, 20]),
            baseSpreadBps: rng.pick([0, 10, 40]),
            maxTotalBps: 100,
            impactKBps: vamm ? rng.pick([10, 100]) : 0,
            liquidityNotionalE6: vamm ? rng.pick([1_000_000_000n, 1_000_000_000_000n]) : 0n,
            maxFillAbs: rng.pick([0n, 5_000_000n, 1n << 100n, 1n << 100n]),
            maxInventoryAbs: rng.pick([0n, 0n, 50_000_000n]),
          });
          await d.ok(`${label}: matcher Init`, u.key, [matcherInit(pda, ctx, p)]);
          lps.set(head, { idx: head, matcher: MATCHER, ctx, pda });
        }
      } else {
        const lp = kind < 6;
        res = await d.both(`${label}: ${lp ? "InitLP" : "InitUser"}`, u.key, [lp ? ix.initLp(m, u, SYSTEM, SYSTEM, amount()) : ix.initUser(m, u, amount())]);
        if (res === "ok") owners.set(head, u);
      }
    } else if (action === 2 || action === 3) {
      const idx = someIdx();
      const u = owners.get(idx) ?? (await someUser());
      res = await d.both(`${label}: Deposit ${idx}`, u.key, [ix.deposit(m, u, idx, amount())]);
    } else if (action === 4 || action === 5) {
      const idx = someIdx();
      const u = owners.get(idx) ?? (await someUser());
      res = await d.both(`${label}: Withdraw ${idx}`, u.key, [ix.withdraw(m, u, idx, amount())]);
    } else if (action === 6) {
      const idx = someIdx();
      const u = owners.get(idx) ?? (await someUser());
      res = await d.both(`${label}: CloseAccount ${idx}`, u.key, [ix.closeAccount(m, u, idx)]);
      if (res === "ok") {
        owners.delete(idx);
        lps.delete(idx);
      }
    } else if (action === 7) {
      const idx = someIdx();
      res = await d.both(`${label}: SettleAccount ${idx}`, await d.funded(1n), [ix.settleAccount(m, idx)]);
    } else if (action === 8) {
      const idx = someIdx();
      res = await d.both(`${label}: ReclaimEmptyAccount ${idx}`, await d.funded(1n), [ix.reclaimEmptyAccount(m, idx)]);
      if (res === "ok") {
        owners.delete(idx);
        lps.delete(idx);
      }
    } else if (action === 9) {
      const u = await someUser();
      // Small top-ups mostly, so that a bankruptcy can exhaust insurance and the loss reaches the opposite side.
      res = await d.both(`${label}: TopUpInsurance`, u.key, [ix.topUpInsurance(m, u, rng.chance(70) ? rng.pick([1000n, 100_000n, SOL]) : amount())]);
    } else if (action === 10) {
      const idx = someIdx();
      const u = owners.get(idx) ?? (await someUser());
      res = await d.both(`${label}: DepositFeeCredits ${idx}`, u.key, [ix.depositFeeCredits(m, u, idx, amount())]);
    } else if (action === 11) {
      // The clock moves (a few slots, or long enough for fees and warm-up to matter).
      d.setClock(d.slot + BigInt(rng.pick([1, 3, 20, 150, 900])));
      continue;
    } else if (action === 23 || action === 24) {
      // A liquidation at the oracle, of an account or of anything.
      const idx = someIdx();
      const keeper = await d.funded(1n);
      res = await d.both(`${label}: LiquidateAtOracle ${idx}`, keeper, [ix.liquidate(m, keeper, idx)]);
    } else if (action === 25 || action === 26 || action === 27) {
      // A crank: permissionless or by an owner, with random candidates and hints (FullClose, a partial of a random
      // share of the position, touch only), sometimes none, a free slot or a duplicate.
      const open = [...owners.keys()];
      const s = d.data(m.slab);
      const candidates: [number, number, bigint?][] = [];
      const count = rng.pick([0, 1, 3, 8, 20, 70]);
      for (let c = 0; c < count; c++) {
        const idx = open.length > 0 && rng.chance(85) ? rng.pick(open) : rng.int(4097);
        const held = idx < 4096 ? readI128(s, accountAt(idx) + A.positionBasisQ) : 0n;
        const abs = held < 0n ? -held : held;
        const hint = rng.int(4);
        if (hint === 0 || hint === 1) candidates.push([idx, 0]);
        else if (hint === 2) candidates.push([idx, 1, rng.pick([0n, 1n, abs / 2n, abs / 10n + 1n, abs, abs + 1n])]);
        else candidates.push([idx, 0xff]);
      }
      const self = open.length > 0 && rng.chance(40) ? rng.pick(open) : 65535;
      const caller = self === 65535 ? await d.funded(1n) : owners.get(self)!.key;
      res = await d.both(`${label}: KeeperCrank ${self} ${count}`, caller, [computeUnits(1_400_000), ix.crank(m, caller, self, candidates)]);
    } else if (action === 28) {
      res = await d.both(`${label}: CatchupAccrue`, await d.funded(1n), [ix.catchupAccrue(m)]);
    } else if (action === 29 || action >= 31) {
      // A crash or a spike, large enough to bankrupt leveraged accounts (the cap, if any, slows it).
      price = (price * BigInt(rng.pick([40, 55, 65, 75, 85, 88, 92, 110, 115, 125, 140, 170, 220]))) / 100n + 1n;
      quote(d, m, oracle, price);
      if (hyperp) res = await d.both(`${label}: PushHyperpMark`, m.admin, [ix.pushHyperpMark(m, m.admin, price / 100n + 1n, 0n)]);
      else continue;
    } else if (action === 30) {
      // A long stretch of slots: past the accrual envelope (CatchupRequired, then CatchupAccrue) where nothing
      // resolves the market for staleness.
      d.setClock(d.slot + BigInt(noStale ? rng.pick([2_000, 40_000, 10_000_001, 250_000_000]) : rng.pick([300, 1_000])));
      quote(d, m, oracle, price);
      continue;
    } else if (action === 12 || action >= 20) {
      // The oracle moves: fresh, an older observation, stale, or with a wide confidence interval.
      const mv = rng.int(10);
      price = mv < 7 ? (price * BigInt(90 + rng.int(21))) / 100n + 1n : price;
      const when = mv === 7 ? d.unixTimestamp - BigInt(rng.int(100)) : mv === 8 ? d.unixTimestamp - 4000n : d.unixTimestamp;
      quote(d, m, oracle, price, when, mv === 9);
      if (hyperp && rng.chance(50)) res = await d.both(`${label}: PushHyperpMark`, m.admin, [ix.pushHyperpMark(m, m.admin, price / 100n + 1n, 0n)]);
      else continue;
    } else if (action === 13 || action === 15 || action === 19) {
      // A trade: a user (or an LP) against an LP, through its matcher or with both owners signing.
      const open = [...owners.keys()];
      if (open.length < 2) continue;
      const userIdx = rng.chance(90) ? rng.pick(open) : rng.int(8);
      const user = owners.get(userIdx) ?? (await someUser());
      const held = readI128(d.data(m.slab), accountAt(userIdx) + A.positionBasisQ);
      // Close, a random size, or near the most the user's capital allows (leverage, for bankruptcies after a move).
      const capital = readU128(d.data(m.slab), accountAt(userIdx) + A.capital);
      const enginePrice = d.data(m.slab).readBigUInt64LE(E.lastOraclePrice);
      const leveraged = (capital * 10_000n * 1_000_000n * BigInt(60 + rng.int(38))) / (imBps * 100n * (enginePrice > 0n ? enginePrice : 1n));
      const size =
        held !== 0n && rng.chance(25)
          ? -held
          : (rng.chance(50) ? 1n : -1n) *
            (rng.chance(35) && leveraged > 0n ? leveraged : BigInt(1 + rng.int(1000)) * rng.pick([1n, 1000n, 1_000_000n, 1_000_000n, 30_000_000n]));
      const cpi = lps.size > 0 && (hyperp || rng.chance(50));
      if (cpi) {
        const lp = rng.pick([...lps.values()]);
        const lpOwner = owners.get(lp.idx)!;
        const limit = rng.chance(20) ? (price * BigInt(97 + rng.int(7))) / 100n : 0n;
        res = await d.both(`${label}: TradeCpi ${userIdx} ${lp.idx}`, user.key, [ix.tradeCpi(m, user.key, lpOwner.key.address, lp, userIdx, size, limit)]);
      } else {
        const lpIdx = rng.pick(open);
        const lpOwner = owners.get(lpIdx)!;
        res = await d.both(`${label}: TradeNoCpi ${userIdx} ${lpIdx}`, user.key, [ix.tradeNoCpi(m, user.key, lpOwner.key, lpIdx, userIdx, size)]);
      }
    } else if (action === 16) {
      // Convert released PnL: some of it, all of it, or more.
      const idx = someIdx();
      const u = owners.get(idx) ?? (await someUser());
      const s = d.data(m.slab);
      const released = readI128(s, accountAt(idx) + A.pnl) - readU128(s, accountAt(idx) + A.reservedPnl);
      const scale = BigInt(Math.max(unitScale, 1));
      const units = released > 0n ? rng.pick([released, released / 2n + 1n, released + 1n, 1n]) : rng.pick([0n, 1n]);
      res = await d.both(`${label}: ConvertReleasedPnl ${idx}`, u.key, [ix.convertReleasedPnl(m, u, idx, units * scale)]);
    } else if (action === 17) {
      res = await d.both(`${label}: UpdateConfig`, m.admin, [
        ix.updateConfig(m, m.admin, {
          horizon: BigInt(1 + rng.int(1000)),
          kBps: BigInt(rng.int(200)),
          maxPremiumBps: BigInt(rng.int(1000)),
          maxE9PerSlot: BigInt(rng.int(10_001)),
          tvlCapMult: rng.pick([0, 0, 0, 50]),
        }),
      ]);
    } else {
      res = await d.both(`${label}: SetOraclePriceCap`, m.admin, [ix.setOraclePriceCap(m, m.admin, rng.pick([0n, 100n, 10_000n, 1_000_000n]))]);
    }
    if (res === "ok") ok++;
    if (res === "ok") {
      const what = /: Trade(No)?Cpi /.test(d.rows.at(-1)!.label) ? "trade" : d.rows.at(-1)!.label.split(": ").at(-1)!.split(" ")[0]!;
      okBy.set(what, (okBy.get(what) ?? 0) + 1);
    }
    // What the walk reached: outcomes by instruction, and the engine states the numeric paths depend on.
    const name = d.rows.at(-1)!.label.split(": ").at(-1)!.split(" ")[0]!;
    const key = `${name} ${res === "ok" ? "ok" : res.replace(/.*error: /, "").replace(/ }.*/, "")}`;
    reached.set(key, (reached.get(key) ?? 0) + 1);
    const e = d.data(m.slab);
    const residual = readU128(e, E.vault) - readU128(e, E.cTot) - readU128(e, E.insurance);
    if (readU128(e, E.pnlMaturedPosTot) > residual) reached.set("state: haircut below 1", (reached.get("state: haircut below 1") ?? 0) + 1);
    for (const idx of owners.keys()) {
      if (e[accountAt(idx) + A.pendingPresent]) reached.set("state: a pending reserve bucket", (reached.get("state: a pending reserve bucket") ?? 0) + 1);
      if (e[accountAt(idx) + A.schedPresent]) reached.set("state: a scheduled reserve bucket", (reached.get("state: a scheduled reserve bucket") ?? 0) + 1);
      if (readI128(e, accountAt(idx) + A.feeCredits) < 0n) reached.set("state: fee debt", (reached.get("state: fee debt") ?? 0) + 1);
    }
    if (readI128(e, E.fLongNum) !== 0n) reached.set("state: funding accrued", (reached.get("state: funding accrued") ?? 0) + 1);
    countEvents(before, e, reached);
  }
  // The end of the market: resolution, every account closed out, the insurance withdrawn, the slab closed.
  await endOfLife(
    d,
    m,
    owners,
    users.map((u) => u.ata),
    endRng,
    `${tag} end`,
    { hyperp, permissionless: !noStale, price, oracle },
  );
  // Something happened: the walk did not fail every step.
  expect(ok, `${tag}`).toBeGreaterThan(steps / 10);
  if (oracle.kind !== "default") for (const what of ["trade", "KeeperCrank"]) expect(okBy.get(what) ?? 0, `${tag}: a successful ${what}`).toBeGreaterThan(0);
  if (process.env.PERCOLATOR_FUZZ_VERBOSE) console.log(`${tag}: ${d.compared} compared, ${ok} succeeded`);
  return d.rows;
}

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20 fuzz: account sequences against the mainnet binary", () => {
  const rows: CuRow[] = [];
  const reached = new Map<string, number>();
  afterAll(() => {
    if (process.env.PERCOLATOR_CU) console.table(cuSummary(rows));
    if (process.env.PERCOLATOR_FUZZ_VERBOSE) {
      console.table(Object.fromEntries([...reached].sort()));
      console.table(Object.fromEntries([...endReached].sort()));
      console.log(`full life cycles (resolution to CloseSlab): ${lifeCycles}`);
      // Diff.both fails a successful Percolator transaction on which the port does not use fewer units; this counts them.
      const ok = rows.filter((r) => r.ok && r.percolator);
      console.log(`port below the original on ${ok.filter((r) => r.port < r.original).length} of ${ok.length} successful Percolator transactions`);
    }
  });
  for (const seed of SEEDS)
    it(`seed ${seed}: ${STEPS} steps`, { timeout: 600_000 }, async () => {
      rows.push(...(await accountWalk(seed, STEPS, DEFAULT_ORACLE, reached)));
    });
});

// The oracle walk: the account walk on markets of one oracle shape each (a Chainlink feed, an inverted Pyth market, a
// Pyth feed at another exponent with its confidence at the market's limit, a Hyperp market), each to its end, so that
// trades, cranks, liquidations, resolution and the teardown run on every shape. PERCOLATOR_ORACLE_RUNS=<n> seeds per
// shape (2), PERCOLATOR_ORACLE_STEPS=<n> steps (200); the Pyth exponent (-8, -10 or -5), the confidence limit (50, 200
// or 500 bps) and Chainlink's decimals (8, 9 or 18) are drawn from the seed. Each walk requires at least one
// successful trade and one successful crank.
const ORACLE_RUNS = Number(process.env.PERCOLATOR_ORACLE_RUNS ?? 2);
const ORACLE_STEPS = Number(process.env.PERCOLATOR_ORACLE_STEPS ?? 200);
const ORACLE_KINDS: OracleKind[] = ["chainlink", "inverted", "pyth-expo", "hyperp"];

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20 fuzz: oracle and market shapes against the mainnet binary", () => {
  const rows: CuRow[] = [];
  const reached = new Map<string, number>();
  afterAll(() => {
    if (process.env.PERCOLATOR_CU) console.table(cuSummary(rows));
    if (process.env.PERCOLATOR_FUZZ_VERBOSE) {
      console.table(Object.fromEntries([...reached].sort()));
      console.table(Object.fromEntries([...cyclesByShape].sort()));
    }
  });
  for (const kind of ORACLE_KINDS)
    for (let i = 1; i <= ORACLE_RUNS; i++)
      it(`${kind} seed ${i}: ${ORACLE_STEPS} steps`, { timeout: 600_000 }, async () => {
        const seed = BigInt(i) * 0x10001n + 0xac1en;
        const pick = new Rng(seed ^ 0x0e9n);
        const oracle: Oracle = { kind, expo: pick.pick([-8, -10, -5]), confBps: pick.pick([50, 200, 500]), decimals: pick.pick([8, 9, 18]) };
        rows.push(...(await accountWalk(seed, ORACLE_STEPS, oracle, reached)));
      });
});

// The liquidation walk: a market of leveraged traders against a few counterparties with little insurance, and
// sequences of leveraged trades (both programs' margin checks decide what opens), price moves from a few percent to
// crashes and spikes that bankrupt accounts, LiquidateAtOracle, KeeperCrank with random candidates and hints, catch-up
// accruals, settlements, deposits, withdrawals, conversions, new accounts, closes, top-ups and clock moves (past the
// accrual envelope where nothing resolves the market for staleness), so that liquidations leave bad debt, insurance
// runs out, losses are socialised over the opposite side (K and A), sides turn drain-only, reset and reopen.
// Seeds 1 to 6 by default (PERCOLATOR_ADL_RUNS, PERCOLATOR_ADL_SEED), 240 steps (PERCOLATOR_ADL_STEPS);
// PERCOLATOR_FUZZ_VERBOSE=1 prints how often each ADL event occurred.
const ADL_RUNS = Number(process.env.PERCOLATOR_ADL_RUNS ?? 6);
const ADL_SEEDS = process.env.PERCOLATOR_ADL_SEED ? [BigInt(process.env.PERCOLATOR_ADL_SEED)] : Array.from({ length: ADL_RUNS }, (_, i) => BigInt(i + 1));
const ADL_STEPS = Number(process.env.PERCOLATOR_ADL_STEPS ?? 240);

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20 fuzz: liquidations, the crank and ADL against the mainnet binary", () => {
  const rows: CuRow[] = [];
  const reached = new Map<string, number>();
  const perSeed: Record<string, number>[] = [];
  afterAll(() => {
    if (process.env.PERCOLATOR_CU) console.table(cuSummary(rows));
    if (process.env.PERCOLATOR_FUZZ_VERBOSE) {
      console.table(Object.fromEntries([...reached].sort()));
      console.table(Object.fromEntries([...events].sort()));
      console.table(perSeed);
      console.table(Object.fromEntries([...endReached].sort()));
      console.log(`full life cycles (resolution to CloseSlab), both walks so far: ${lifeCycles}`);
      console.table(Object.fromEntries([...cyclesByShape].sort()));
      const ok = rows.filter((r) => r.ok && r.percolator);
      console.log(`port below the original on ${ok.filter((r) => r.port < r.original).length} of ${ok.length} successful Percolator transactions`);
    }
  });
  for (const seed of ADL_SEEDS)
    it(`seed ${seed}: ${ADL_STEPS} steps`, { timeout: 900_000 }, async () => {
      const rng = new Rng(seed ^ 0xad1n);
      const keys = new Rng(seed ^ 0x6b657973ad1n);
      const d = await Diff.create(async () => createKeyPairSignerFromPrivateKeyBytes(keys.bytes(32)));
      const endRng = new Rng(seed ^ 0xe0d0ad1n);
      const noStale = rng.chance(40);
      const imBps = rng.pick([1000n, 2000n, 5000n]);
      const m = await d.market({
        label: `adl seed ${seed}: InitMarket`,
        edit: (a) => {
          a.initialMarginBps = imBps;
          a.maintenanceMarginBps = imBps / 2n;
          a.tradingFeeBps = rng.pick([0n, 0n, 10n]);
          a.liquidationFeeBps = rng.pick([0n, 50n, 100n]);
          a.maintenanceFeePerSlot = rng.pick([0n, 0n, 0n, 100n, 100_000n]);
          a.hMax = rng.pick([1n, 50n, 300n]);
          a.maxAccounts = rng.pick([4096n, 24n]);
          a.minOraclePriceCapE2bps = noStale ? 1_000_000n : 0n;
          if (noStale) a.tail!.permissionlessResolveStaleSlots = 0n;
          if (endRng.chance(50)) {
            a.tail!.insuranceWithdrawMaxBps = endRng.pick([1, 500, 10_000]);
            a.tail!.insuranceWithdrawCooldownSlots = endRng.pick([1n, 30n]);
          }
        },
      });
      const everyone: User[] = [];
      const adhoc = async () => {
        const u = await d.user(m);
        everyone.push(u);
        return u;
      };
      const owners = new Map<number, User>();
      let price = 100_000_000n;
      let ok = 0;
      const seedEvents = new Map<string, number>();
      const open = async (capital: bigint, label: string) => {
        const u = await d.user(m, 1_000_000n * SOL);
        everyone.push(u);
        const head = d.freeHead(m);
        if ((await d.both(`${label}: InitUser`, u.key, [ix.initUser(m, u, capital)])) === "ok") owners.set(head, u);
      };
      for (let i = 0; i < 3; i++) await open(BigInt(50 + rng.int(500)) * SOL, `seed ${seed} counterparty ${i}`);
      for (let i = 0; i < 4 + rng.int(9); i++) await open(BigInt(1 + rng.int(50)) * SOL, `seed ${seed} trader ${i}`);
      const ins = await d.user(m);
      await d.both(`seed ${seed}: TopUpInsurance`, ins.key, [ix.topUpInsurance(m, ins, rng.pick([0n, 1000n, SOL / 10n, SOL]))]);
      const some = () => (owners.size > 0 && rng.chance(92) ? rng.pick([...owners.keys()]) : rng.int(30));
      for (let step = 0; step < ADL_STEPS; step++) {
        const label = `adl seed ${seed} step ${step}`;
        const before = snapshot(d.data(m.slab));
        const action = rng.int(24);
        const s = d.data(m.slab);
        let res = "";
        if (action < 6) {
          // A leveraged trade: up to the initial margin of the smaller capital, at the engine's price.
          const ids = [...owners.keys()];
          if (ids.length < 2) continue;
          const a = rng.pick(ids);
          const b = rng.pick(ids.filter((x) => x !== a));
          const cap = (x: number) => readU128(s, accountAt(x) + A.capital);
          const smaller = cap(a) < cap(b) ? cap(a) : cap(b);
          const px = s.readBigUInt64LE(E.lastOraclePrice);
          const q = (smaller * 10_000n * 1_000_000n * BigInt(30 + rng.int(68))) / (imBps * 100n * (px > 0n ? px : 1n));
          const size = (rng.chance(50) ? 1n : -1n) * (q > 0n ? q : 1n);
          res = await d.both(`${label}: TradeNoCpi ${a} ${b}`, owners.get(a)!.key, [ix.tradeNoCpi(m, owners.get(a)!.key, owners.get(b)!.key, b, a, size)]);
        } else if (action < 9) {
          // The price: a few percent, or a crash or a spike.
          const big = rng.chance(45);
          const pct = big ? rng.pick([45, 60, 75, 82, 125, 140, 170, 210]) : 95 + rng.int(11);
          price = (price * BigInt(pct)) / 100n + 1n;
          d.setClock(d.slot + BigInt(1 + rng.int(5)));
          d.setPrice(m, price);
          continue;
        } else if (action < 12) {
          const ids = [...owners.keys()];
          const candidates: [number, number, bigint?][] = [];
          const count = rng.pick([0, 1, 2, 4, 8, 16]);
          for (let c = 0; c < count; c++) {
            const idx = ids.length > 0 && rng.chance(90) ? rng.pick(ids) : rng.int(4097);
            const held = idx < 4096 ? readI128(s, accountAt(idx) + A.positionBasisQ) : 0n;
            const abs = held < 0n ? -held : held;
            const hint = rng.int(5);
            if (hint < 2) candidates.push([idx, 0]);
            else if (hint < 4) candidates.push([idx, 1, rng.pick([0n, 1n, abs / 2n, abs / 4n + 1n, (abs * 9n) / 10n, abs])]);
            else candidates.push([idx, 0xff]);
          }
          const self = ids.length > 0 && rng.chance(30) ? rng.pick(ids) : 65535;
          const caller = self === 65535 ? await d.funded(1n) : owners.get(self)!.key;
          res = await d.both(`${label}: KeeperCrank ${self} ${count}`, caller, [computeUnits(1_400_000), ix.crank(m, caller, self, candidates)]);
        } else if (action < 14) {
          const idx = some();
          const keeper = await d.funded(1n);
          res = await d.both(`${label}: LiquidateAtOracle ${idx}`, keeper, [ix.liquidate(m, keeper, idx)]);
        } else if (action === 14) {
          res = await d.both(`${label}: SettleAccount`, await d.funded(1n), [ix.settleAccount(m, some())]);
        } else if (action === 15) {
          const idx = some();
          const u = owners.get(idx) ?? (await adhoc());
          res = await d.both(`${label}: Deposit ${idx}`, u.key, [ix.deposit(m, u, idx, rng.pick([1000n, SOL, 10n * SOL]))]);
        } else if (action === 16) {
          const idx = some();
          const u = owners.get(idx) ?? (await adhoc());
          const c = idx < 4096 ? readU128(s, accountAt(idx) + A.capital) : 0n;
          res = await d.both(`${label}: Withdraw ${idx}`, u.key, [ix.withdraw(m, u, idx, rng.pick([1n, c / 3n, c, c + 1n]))]);
        } else if (action === 17) {
          const idx = some();
          const u = owners.get(idx) ?? (await adhoc());
          const released = idx < 4096 ? readI128(s, accountAt(idx) + A.pnl) - readU128(s, accountAt(idx) + A.reservedPnl) : 0n;
          res = await d.both(`${label}: ConvertReleasedPnl ${idx}`, u.key, [
            ix.convertReleasedPnl(m, u, idx, released > 0n ? rng.pick([released, released / 2n + 1n, released + 1n]) : 1n),
          ]);
        } else if (action === 18) {
          res = await d.both(`${label}: CatchupAccrue`, await d.funded(1n), [ix.catchupAccrue(m)]);
        } else if (action === 19) {
          d.setClock(d.slot + BigInt(noStale && rng.chance(25) ? rng.pick([10_000_001, 30_000_000, 250_000_000]) : rng.pick([1, 20, 300, 1500])));
          d.setPrice(m, price);
          continue;
        } else if (action === 20) {
          await open(BigInt(1 + rng.int(80)) * SOL, `${label}: trader`);
          continue;
        } else if (action === 21) {
          const idx = some();
          const u = owners.get(idx) ?? (await adhoc());
          res = await d.both(`${label}: CloseAccount ${idx}`, u.key, [ix.closeAccount(m, u, idx)]);
          if (res === "ok") owners.delete(idx);
        } else if (action === 22) {
          res = await d.both(`${label}: TopUpInsurance`, ins.key, [ix.topUpInsurance(m, ins, rng.pick([1000n, SOL / 10n, SOL]))]);
        } else {
          res = await d.both(`${label}: ReclaimEmptyAccount`, await d.funded(1n), [ix.reclaimEmptyAccount(m, some())]);
        }
        if (res === "ok") ok++;
        const name = d.rows.at(-1)!.label.split(": ").at(-1)!.split(" ")[0]!;
        const key = `${name} ${res === "ok" ? "ok" : res.replace(/.*error: /, "").replace(/ }.*/, "")}`;
        reached.set(key, (reached.get(key) ?? 0) + 1);
        const e = d.data(m.slab);
        // Accounts the crank's sweep or a reclaim freed are no longer owned.
        for (const idx of [...owners.keys()]) if (((e.readBigUInt64LE(E.used + 8 * (idx >> 6)) >> BigInt(idx & 63)) & 1n) === 0n) owners.delete(idx);
        const local = new Map<string, number>();
        countEvents(before, e, local);
        for (const [k, v] of local) {
          reached.set(k, (reached.get(k) ?? 0) + v);
          seedEvents.set(k, (seedEvents.get(k) ?? 0) + v);
        }
        if (/0x1, 0x0, 0x0, 0x0, 0x4/.test(d.lastLogs)) reached.set("liquidated (LiquidateAtOracle)", (reached.get("liquidated (LiquidateAtOracle)") ?? 0) + 1);
        const stats = /Program log: 0xc8a4c, (0x[0-9a-f]+)/.exec(d.lastLogs);
        if (res === "ok" && stats && BigInt(stats[1]!) > 0n)
          reached.set("liquidated (KeeperCrank)", (reached.get("liquidated (KeeperCrank)") ?? 0) + Number(BigInt(stats[1]!)));
      }
      await endOfLife(d, m, owners, [...everyone.map((u) => u.ata), ins.ata], endRng, `adl seed ${seed} end`, {
        hyperp: false,
        permissionless: !noStale,
        price,
        oracle: DEFAULT_ORACLE,
      });
      rows.push(...d.rows);
      perSeed.push({ seed: Number(seed), ok, ...Object.fromEntries(seedEvents) });
      expect(ok, `seed ${seed}`).toBeGreaterThan(ADL_STEPS / 10);
    });
});
