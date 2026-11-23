// TradeNoCpi of the Percolator v16 port (showcase/mainnet/percolator-v16/trading.ts, trade.ts, health.ts) against the
// reference: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator,
// Apache-2.0; test/programs/percolator_v16.so is the Rust build of those commits, not a deployed program. Every
// transaction goes to both and is compared whole (percolator-v16-helpers.ts `Diff`): outcome, logs, inner
// instructions, return data, every named account's bytes; the port must use fewer compute units on each success.
import { AccountRole, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Diff, HAVE_PORT, HAVE_REFERENCE, type InitMarketArgs, type Market, PROGRAM, err, errB, ix, marketAt } from "./percolator-v16-helpers.js";

interface Trader {
  owner: KeyPairSigner;
  portfolio: Address;
  source: Address;
}

async function setup(
  d: Diff,
  args: Partial<InitMarketArgs> = {},
  n = 2,
  deposits: bigint[] = [],
  capacity = 3,
  mark = 1_000_000n,
): Promise<{ m: Market; t: Trader[] }> {
  const assets = args.maxPortfolioAssets ?? 2;
  const m = await d.market({ capacity, args: { maxPortfolioAssets: 2, maxTradingFeeBps: 500n, ...args } });
  for (let asset = 0; asset < assets; asset++)
    await d.ok(`ConfigureAuthMark ${asset}`, m.admin, [
      ix.configureAuthMark(m, m.admin, { asset, marketId: BigInt(asset + 1), mark, sequence: 1n, epoch: 0n }),
    ]);
  const t: Trader[] = [];
  for (let i = 0; i < n; i++) {
    const { owner, portfolio } = await d.newPortfolio();
    await d.ok(`InitPortfolio ${i}`, owner, [ix.initPortfolio(m, owner, portfolio)]);
    const source = await d.tokenAccount(m.mint, owner.address, 10_000_000_000n);
    const amount = deposits[i] ?? 1_000_000_000n;
    if (amount !== 0n) await d.ok(`Deposit ${i}`, owner, [ix.deposit(m, owner, portfolio, source, d.portfolioId(portfolio), 0n, amount)]);
    t.push({ owner, portfolio, source });
  }
  return { m, t };
}

function trade(d: Diff, m: Market, a: Trader, b: Trader, asset: number, size: bigint, exec = 1_000_000n, fee = 0n, cap = 0) {
  return ix.tradeNoCpi(m, a.owner, b.owner, a.portfolio, b.portfolio, {
    aId: d.portfolioId(a.portfolio),
    aEpoch: d.positionEpoch(a.portfolio),
    bId: d.portfolioId(b.portfolio),
    bEpoch: d.positionEpoch(b.portfolio),
    asset,
    marketId: BigInt(asset + 1),
    size,
    exec,
    fee,
    cap,
  });
}

/** The instruction with account `at` replaced (its signer kept when the replacement can sign). */
function withAccountAt(i: Instruction, at: number, address: Address, role: AccountRole, signer?: KeyPairSigner): Instruction {
  const accounts = [...(i.accounts ?? [])] as { address: Address; role: AccountRole; signer?: KeyPairSigner }[];
  // A position that signs keeps signing only with a signer for its new account.
  if (!signer && role === AccountRole.READONLY_SIGNER) role = AccountRole.READONLY;
  if (!signer && role === AccountRole.WRITABLE_SIGNER) role = AccountRole.WRITABLE;
  accounts[at] = { address, role, ...(signer ? { signer } : {}) };
  return { ...i, accounts: accounts as Instruction["accounts"] };
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: TradeNoCpi", () => {
  it("open, increase, reduce, flip and close, long first and short first, on both assets", async () => {
    const d = await Diff.create();
    const { m, t } = await setup(d);
    const [a, b] = t as [Trader, Trader];
    for (const asset of [0, 1])
      for (const sign of [1n, -1n]) {
        await d.ok(`asset ${asset} open ${sign}`, a.owner, [trade(d, m, a, b, asset, sign * 1_000n)]);
        await d.ok(`asset ${asset} increase`, a.owner, [trade(d, m, a, b, asset, sign * 500n)]);
        await d.ok(`asset ${asset} reduce`, a.owner, [trade(d, m, a, b, asset, -sign * 700n)]);
        await d.ok(`asset ${asset} flip`, a.owner, [trade(d, m, a, b, asset, -sign * 1_800n)]);
        await d.ok(`asset ${asset} close`, a.owner, [trade(d, m, a, b, asset, sign * 1_000n)]);
      }
  });

  it("cross margin: one portfolio with a leg on each of 14 assets, then all closed", async () => {
    const d = await Diff.create();
    const { m, t } = await setup(d, { maxPortfolioAssets: 14 }, 3, [], 14);
    const [a, b, c] = t as [Trader, Trader, Trader];
    for (let asset = 0; asset < 14; asset++)
      await d.ok(`leg ${asset + 1} of 14`, a.owner, [trade(d, m, a, asset % 2 === 0 ? b : c, asset, asset % 3 === 0 ? -1_000n : 1_000n)]);
    for (let asset = 0; asset < 14; asset++)
      await d.ok(`close leg ${asset + 1}`, a.owner, [trade(d, m, a, asset % 2 === 0 ? b : c, asset, asset % 3 === 0 ? 1_000n : -1_000n)]);
    // A market of 15 or 16 assets per portfolio is refused at InitMarket (the wrapper's cap of 14).
    for (const n of [15, 16]) {
      const mk = await d.newMarket({ capacity: 16 });
      await d.send(`InitMarket max assets ${n}`, mk.admin, [
        ix.initMarket(mk, (await import("./percolator-v16-helpers.js")).defaultInitArgs({ maxPortfolioAssets: n })),
      ]);
    }
  });

  it("sizes and prints at the bounds, fees from zero to the caps", async () => {
    const d = await Diff.create();
    const { m, t } = await setup(
      d,
      { initialMarginBps: 2000n, maintenanceMarginBps: 1000n, maxPriceMoveBpsPerSlot: 10n, maxAccrualDtSlots: 4n },
      2,
      [5_000_000_000n, 5_000_000_000n],
      3,
      10n,
    );
    const [a, b] = t as [Trader, Trader];
    const MAX = 100_000_000_000_000n;
    for (const size of [0n, 1n, -1n, MAX, -MAX, MAX + 1n, -(MAX + 1n), -(1n << 127n), (1n << 127n) - 1n])
      await d.send(`size ${size}`, a.owner, [trade(d, m, a, b, 0, size)]);
    for (const exec of [0n, 1n, 9n, 10n, 1_000_000_000_000n, 1_000_000_000_001n, (1n << 64n) - 1n])
      await d.send(`exec ${exec}`, a.owner, [trade(d, m, a, b, 1, 1_000_000n, exec)]);
    for (const fee of [0n, 1n, 499n, 500n, 501n, (1n << 64n) - 1n]) await d.send(`fee ${fee}`, a.owner, [trade(d, m, a, b, 1, 1_000_000_000_000n, 10n, fee)]);
    for (const cap of [0, 1, 10_000, 10_001, 65_535]) await d.send(`cap ${cap}`, a.owner, [trade(d, m, a, b, 1, 1_000n, 10n, 0n, cap)]);
    // A base fee policy above the signed fee.
    await d.ok("UpdateTradeFeePolicy 30", m.admin, [ix.tradeFeePolicy(m, m.admin, 30n, 1n, 0n)]);
    for (const fee of [0n, 29n, 30n, 31n]) await d.send(`fee ${fee} under base 30`, a.owner, [trade(d, m, a, b, 1, 1_000_000_000_000n, 10n, fee)]);
  });

  it("the initial margin to the unit, on both parties", async () => {
    // At price 1.0 and 20% initial margin, a trade of 1,000,000 needs 200,000 of each party (no fee).
    for (const [da, db] of [
      [200_000n, 200_000n],
      [199_999n, 200_000n],
      [200_000n, 199_999n],
      [199_999n, 199_999n],
    ] as const) {
      const d = await Diff.create();
      const { m, t } = await setup(d, { initialMarginBps: 2000n, maintenanceMarginBps: 1000n, maxPriceMoveBpsPerSlot: 10n, maxAccrualDtSlots: 4n }, 2, [
        da,
        db,
      ]);
      const [a, b] = t as [Trader, Trader];
      const got = await d.send(`IM ${da} / ${db}`, a.owner, [trade(d, m, a, b, 0, 1_000_000n)]);
      expect(got === "ok").toBe(da === 200_000n && db === 200_000n);
      // A trading fee of 1 bps the margin must also cover.
      const d2 = await Diff.create();
      const s2 = await setup(d2, { initialMarginBps: 2000n, maintenanceMarginBps: 1000n, maxPriceMoveBpsPerSlot: 10n, maxAccrualDtSlots: 4n }, 2, [
        da + 100n,
        db + 100n,
      ]);
      await d2.send(`IM ${da} / ${db} with a fee`, s2.t[0]!.owner, [trade(d2, s2.m, s2.t[0]!, s2.t[1]!, 0, 1_000_000n, 1_000_000n, 1n)]);
    }
  });

  it("accounts: flags, owners, repeated pairs, a short list", async () => {
    const d = await Diff.create();
    const { m, t } = await setup(d);
    const [a, b] = t as [Trader, Trader];
    const base = trade(d, m, a, b, 0, 1_000n);
    const accounts = base.accounts!;
    // Each position replaced by each other position's account (the five repeated pairs both ways).
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++) {
        if (i === j) continue;
        const from = accounts[j]! as { address: Address; signer?: KeyPairSigner };
        await d.send(`account ${i} := account ${j}`, a.owner, [withAccountAt(base, i, from.address, accounts[i]!.role, from.signer)]);
      }
    // Flags dropped, a stranger signing, a portfolio of another owner, a list cut short.
    for (let i = 0; i < 5; i++) {
      const role = accounts[i]!.role;
      const lower = role === AccountRole.WRITABLE_SIGNER || role === AccountRole.WRITABLE ? AccountRole.READONLY : AccountRole.READONLY;
      await d.send(`account ${i} without its flags`, a.owner, [withAccountAt(base, i, accounts[i]!.address, lower)]);
    }
    const stranger = await d.funded();
    await d.send("signer A a stranger", a.owner, [withAccountAt(base, 0, stranger.address, AccountRole.READONLY_SIGNER, stranger)]);
    await d.send("signer B a stranger", a.owner, [withAccountAt(base, 1, stranger.address, AccountRole.READONLY_SIGNER, stranger)]);
    await d.send("signers swapped", a.owner, [trade(d, m, { ...a, owner: b.owner }, { ...b, owner: a.owner }, 0, 1_000n)]);
    for (let n = 0; n < 5; n++) await d.send(`${n} accounts`, a.owner, [{ ...base, accounts: accounts.slice(0, n) }]);
    await d.send("a sixth account", a.owner, [{ ...base, accounts: [...accounts, { address: PROGRAM, role: AccountRole.READONLY }] }]);
    // One owner holding both portfolios trades with itself (two portfolios, one signer).
    const { owner: o2, portfolio: p2 } = await d.newPortfolio();
    await d.ok("InitPortfolio second of A's owner", a.owner, [ix.initPortfolio(m, a.owner, p2)]);
    void o2;
    await d.ok("Deposit second", a.owner, [ix.deposit(m, a.owner, p2, a.source, d.portfolioId(p2), 0n, 1_000_000_000n)]);
    await d.send("one owner, two portfolios", a.owner, [trade(d, m, a, { owner: a.owner, portfolio: p2, source: a.source }, 0, 1_000n)]);
  });

  it("data: ids, epochs, the asset and its market id, lengths", async () => {
    const d = await Diff.create();
    const { m, t } = await setup(d);
    const [a, b] = t as [Trader, Trader];
    const at = (o: Partial<Parameters<typeof ix.tradeNoCpi>[5]>) =>
      ix.tradeNoCpi(m, a.owner, b.owner, a.portfolio, b.portfolio, {
        aId: d.portfolioId(a.portfolio),
        aEpoch: d.positionEpoch(a.portfolio),
        bId: d.portfolioId(b.portfolio),
        bEpoch: d.positionEpoch(b.portfolio),
        asset: 0,
        marketId: 1n,
        size: 1_000n,
        exec: 1_000_000n,
        fee: 0n,
        cap: 0,
        ...o,
      });
    await d.send("A's id + 1", a.owner, [at({ aId: d.portfolioId(a.portfolio) + 1n })]);
    await d.send("B's id 0", a.owner, [at({ bId: 0n })]);
    await d.send("A's epoch + 1", a.owner, [at({ aEpoch: 1n })]);
    await d.send("B's epoch + 1", a.owner, [at({ bEpoch: 1n })]);
    await d.ok("a trade bumps both epochs", a.owner, [at({})]);
    await d.send("the old epochs", a.owner, [at({ aEpoch: 0n, bEpoch: 0n })]);
    for (const asset of [1, 2, 3, 65_535]) await d.send(`asset ${asset}, market id 1`, a.owner, [at({ asset, aEpoch: 1n, bEpoch: 1n })]);
    for (const marketId of [0n, 2n, 3n]) await d.send(`asset 0, market id ${marketId}`, a.owner, [at({ marketId, aEpoch: 1n, bEpoch: 1n })]);
    const good = at({ aEpoch: 1n, bEpoch: 1n });
    const data = Buffer.from(good.data!);
    await d.send("one byte short", a.owner, [{ ...good, data: new Uint8Array(data.subarray(0, data.length - 1)) }]);
    await d.send("one byte long", a.owner, [{ ...good, data: new Uint8Array(Buffer.concat([data, Buffer.from([0])])) }]);
    void err;
    void errB;
    void marketAt;
  });
});
