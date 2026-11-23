// The trading worlds of the batch and matcher tests of the Percolator v16 port (percolator-v16-batch.test.ts,
// percolator-v16-cpi.test.ts): a market of several assets with funded portfolios, BatchTradeNoCpi requests, the
// matchers' contexts and the LP's matcher config. Reference: Percolator v16 at commit 7b110913 (engine 5e3af07), the
// Rust build of those commits, not a deployed program.
import { AccountRole, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { pda } from "../../test/harness.js";
import { i128At, legAt } from "./percolator-v16-crank-world.js";
import { type Diff, type InitMarketArgs, type Market, MATCHERS, PROGRAM, ix, marketAt } from "./percolator-v16-helpers.js";

export interface Trader {
  owner: KeyPairSigner;
  portfolio: Address;
  source: Address;
}
export interface Leg {
  asset: number;
  size: bigint;
  exec?: bigint;
  fee?: bigint;
  marketId?: bigint;
}

/**
 * A market of `assets` assets (even ones AuthMark at `mark`, odd ones an EWMA mark when `ewma`), `n` funded portfolios.
 */
export async function batchWorld(
  d: Diff,
  o: { assets?: number; capacity?: number; n?: number; ewma?: boolean; args?: Partial<InitMarketArgs>; deposit?: bigint; mark?: bigint } = {},
): Promise<{ m: Market; t: Trader[] }> {
  const assets = o.assets ?? 4;
  const m = await d.market({ capacity: o.capacity ?? assets, args: { maxPortfolioAssets: assets, maxTradingFeeBps: 500n, ...o.args } });
  const mark = o.mark ?? 1_000_000n;
  for (let asset = 0; asset < assets; asset++) {
    if (o.ewma && asset % 2 === 1)
      await d.ok(`ConfigureEwmaMark ${asset}`, m.admin, [
        ix.configureEwmaMark(m, m.admin, { asset, marketId: BigInt(asset + 1), mark, halflife: 4n, minFee: 0n, sequence: 1n, epoch: 0n }),
      ]);
    else
      await d.ok(`ConfigureAuthMark ${asset}`, m.admin, [
        ix.configureAuthMark(m, m.admin, { asset, marketId: BigInt(asset + 1), mark, sequence: 1n, epoch: 0n }),
      ]);
  }
  const t: Trader[] = [];
  for (let i = 0; i < (o.n ?? 3); i++) {
    const { owner, portfolio } = await d.newPortfolio();
    await d.ok(`InitPortfolio ${i}`, owner, [ix.initPortfolio(m, owner, portfolio)]);
    const source = await d.tokenAccount(m.mint, owner.address, 100_000_000_000n);
    await d.ok(`Deposit ${i}`, owner, [ix.deposit(m, owner, portfolio, source, d.portfolioId(portfolio), 0n, o.deposit ?? 10_000_000_000n)]);
    t.push({ owner, portfolio, source });
  }
  return { m, t };
}

export function batch(
  d: Diff,
  m: Market,
  a: Trader,
  b: Trader,
  legs: Leg[],
  o: { aEpoch?: bigint; bEpoch?: bigint; aId?: bigint; bId?: bigint } = {},
): Instruction {
  return ix.batchTradeNoCpi(m, a.owner, b.owner, a.portfolio, b.portfolio, {
    aId: o.aId ?? d.portfolioId(a.portfolio),
    aEpoch: o.aEpoch ?? d.positionEpoch(a.portfolio),
    bId: o.bId ?? d.portfolioId(b.portfolio),
    bEpoch: o.bEpoch ?? d.positionEpoch(b.portfolio),
    legs: legs.map((l) => ({ asset: l.asset, marketId: l.marketId ?? BigInt(l.asset + 1), size: l.size, exec: l.exec ?? 1_000_000n, fee: l.fee ?? 0n })),
  });
}

/** The signed position of `portfolio` on `asset` in the reference (its leg's basis by side; 0 for none). */
export function position(d: Diff, portfolio: Address, asset: number): bigint {
  const b = d.data(portfolio);
  if (b.length < 9555) return 0n;
  for (let i = 0; i < 16; i++) {
    if (b[legAt(i, "active")] !== 1 || b.readUInt32LE(legAt(i, "asset_index")) !== asset) continue;
    const q = i128At(b, legAt(i, "basis_pos_q"));
    const abs = q < 0n ? -q : q;
    return b[legAt(i, "side")] === 1 ? -abs : abs;
  }
  return 0n;
}

// ---- The matchers ---------------------------------------------------------------------------------------------------

/** The matchers the tests load: the author's auth and hostile fixtures, and percolator-match (passive kind). */
export type MatcherKind = keyof typeof MATCHERS;
/** An LP's matcher: the program, its context account and the delegate PDA the program signs with. */
export interface Lp {
  program: Address;
  context: Address;
  delegate: Address;
}

/** A matcher instruction (not the program's). */
export function matcherIx(program: Address, data: number[] | Buffer, accounts: { address: Address; role: AccountRole; signer?: KeyPairSigner }[]): Instruction {
  return { programAddress: program, accounts: accounts as Instruction["accounts"], data: new Uint8Array(data) };
}

const le = (v: bigint, bytes: number) => {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return b;
};

/**
 * `lp`'s matcher of kind `kind` (at `program`, default the kind's id): a context account written owned by it
 * (auth: 147 bytes, hostile: 128, percolator-match: 320), initialised by the matcher's own instruction (auth: tag 2,
 * with the LP's owner signing; hostile: its control init, tag 10; percolator-match: tag 2, a passive matcher with
 * `spread` bps), the auth matcher's spreads and backing-fee cap configured, then the LP's matcher config enabled with
 * `cap` and `expiry` (SetMatcherConfig).
 */
export async function lpMatcher(
  d: Diff,
  m: Market,
  lp: Trader,
  kind: MatcherKind,
  o: {
    program?: Address;
    cap?: number;
    expiry?: bigint;
    bid?: bigint;
    ask?: bigint;
    backingCap?: number;
    spread?: number;
    contextLen?: number;
    skipInit?: boolean;
  } = {},
): Promise<Lp> {
  const program = o.program ?? MATCHERS[kind].id;
  const context = await d.address();
  d.write(context, program, new Uint8Array(o.contextLen ?? (kind === "auth" ? 147 : kind === "hostile" ? 128 : 320)));
  const [delegate] = await pda(PROGRAM, ["matcher", m.market, lp.portfolio, lp.owner.address, program, context]);
  const owner = { address: lp.owner.address, role: AccountRole.READONLY_SIGNER, signer: lp.owner };
  const ctx = { address: context, role: AccountRole.WRITABLE };
  if (o.skipInit) {
    // A matcher of the test's own (its context written by the test).
  } else if (kind === "auth") {
    await d.ok("auth matcher: init", lp.owner, [
      matcherIx(
        program,
        [2],
        [
          owner,
          { address: delegate, role: AccountRole.READONLY },
          ctx,
          { address: PROGRAM, role: AccountRole.READONLY },
          { address: m.market, role: AccountRole.READONLY },
          { address: lp.portfolio, role: AccountRole.READONLY },
        ],
      ),
    ]);
    if (o.bid !== undefined || o.ask !== undefined)
      await d.ok("auth matcher: spreads", lp.owner, [
        matcherIx(program, Buffer.concat([Buffer.from([4]), le(o.bid ?? 0n, 8), le(o.ask ?? 0n, 8)]), [owner, ctx]),
      ]);
    if (o.backingCap !== undefined)
      await d.ok("auth matcher: backing-fee cap", lp.owner, [matcherIx(program, Buffer.concat([Buffer.from([5]), le(BigInt(o.backingCap), 2)]), [owner, ctx])]);
  } else if (kind === "hostile") {
    await d.ok("hostile matcher: control init", lp.owner, [matcherIx(program, [10], [owner, ctx])]);
  } else {
    const spread = BigInt(o.spread ?? 10);
    await d.ok("percolator-match: init passive", lp.owner, [
      matcherIx(
        program,
        Buffer.concat([Buffer.from([2, 0]), le(0n, 4), le(spread, 4), le(spread + 100n, 4), le(0n, 4), le(0n, 16), le(1n << 100n, 16), le(1n << 100n, 16)]),
        [{ address: delegate, role: AccountRole.READONLY }, ctx],
      ),
    ]);
  }
  await setLpMatcher(d, m, lp, { program, context, delegate }, o.cap ?? 10_000, o.expiry ?? 0xffff_ffff_ffff_ffffn);
  return { program, context, delegate };
}

/** SetMatcherConfig of `lp` for `matcher` (enabled; disabled with `enabled` 0). */
export async function setLpMatcher(d: Diff, m: Market, lp: Trader, matcher: Lp, cap: number, expiry: bigint, enabled = 1): Promise<string> {
  return d.send("SetMatcherConfig", lp.owner, [
    ix.setMatcherConfig(
      m,
      lp.owner,
      lp.portfolio,
      {
        id: d.portfolioId(lp.portfolio),
        sequence: d.portfolioSequence(lp.portfolio),
        epoch: d.positionEpoch(lp.portfolio),
        frontier: d.data(m.market).readBigUInt64LE(marketAt.group("next_market_id")),
        enabled,
        cap,
        expiry,
      },
      matcher,
    ),
  ]);
}

/** The hostile matcher's attack mode and partial-fill numerator (its control configure, tag 11). */
export function hostileMode(lp: Trader, matcher: Lp, mode: number, ratio = 0): Instruction {
  return matcherIx(
    matcher.program,
    [11, mode, ratio],
    [
      { address: lp.owner.address, role: AccountRole.READONLY_SIGNER, signer: lp.owner },
      { address: matcher.context, role: AccountRole.WRITABLE },
    ],
  );
}

/** TradeCpi of taker `a` against `lp` through `matcher`. */
export function tradeCpi(
  d: Diff,
  m: Market,
  a: Trader,
  lp: Trader,
  matcher: Lp,
  t: {
    asset: number;
    size: bigint;
    fee?: bigint;
    limit?: bigint;
    cap?: number;
    marketId?: bigint;
    aEpoch?: bigint;
    bEpoch?: bigint;
    bSequence?: bigint;
    aId?: bigint;
    bId?: bigint;
  },
  tail: { address: Address; writable?: boolean; signer?: KeyPairSigner }[] = [],
): Instruction {
  return ix.tradeCpi(
    m,
    a.owner,
    a.portfolio,
    lp.portfolio,
    matcher,
    {
      aId: t.aId ?? d.portfolioId(a.portfolio),
      aEpoch: t.aEpoch ?? d.positionEpoch(a.portfolio),
      bId: t.bId ?? d.portfolioId(lp.portfolio),
      bEpoch: t.bEpoch ?? d.positionEpoch(lp.portfolio),
      bSequence: t.bSequence ?? d.portfolioSequence(lp.portfolio),
      asset: t.asset,
      marketId: t.marketId ?? BigInt(t.asset + 1),
      size: t.size,
      fee: t.fee ?? 0n,
      limit: t.limit ?? 0n,
      cap: t.cap ?? 0,
    },
    tail,
  );
}

/** BatchTradeCpi of taker `a` against `lp` through `matcher`. */
export function batchCpi(
  d: Diff,
  m: Market,
  a: Trader,
  lp: Trader,
  matcher: Lp,
  legs: { asset: number; size: bigint; fee?: bigint; limit?: bigint; marketId?: bigint }[],
  o: { maxSlippage?: bigint; maxFee?: bigint; aEpoch?: bigint; bEpoch?: bigint; bSequence?: bigint } = {},
  tail: { address: Address; writable?: boolean; signer?: KeyPairSigner }[] = [],
): Instruction {
  return ix.batchTradeCpi(
    m,
    a.owner,
    a.portfolio,
    lp.portfolio,
    matcher,
    {
      aId: d.portfolioId(a.portfolio),
      aEpoch: o.aEpoch ?? d.positionEpoch(a.portfolio),
      bId: d.portfolioId(lp.portfolio),
      bEpoch: o.bEpoch ?? d.positionEpoch(lp.portfolio),
      bSequence: o.bSequence ?? d.portfolioSequence(lp.portfolio),
      maxSlippage: o.maxSlippage ?? (1n << 128n) - 1n,
      maxFee: o.maxFee ?? (1n << 128n) - 1n,
      legs: legs.map((l) => ({ asset: l.asset, marketId: l.marketId ?? BigInt(l.asset + 1), size: l.size, fee: l.fee ?? 0n, limit: l.limit ?? 0n })),
    },
    tail,
  );
}
