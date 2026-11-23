// What the PermissionlessCrank tests of the Percolator v16 port share (percolator-v16-crank.test.ts,
// percolator-v16-crank-walk.test.ts): a world of three assets (AuthMark, EwmaMark, and a hybrid on the world's external
// oracles) with funding and a moving Clock, built through `Diff` against the reference (Percolator v16 at commit
// 7b110913, engine 5e3af07; test/programs/percolator_v16.so, the Rust build of those commits, not a deployed program);
// readers of the reference's state; trades at the effective price; a crank with the hints a keeper would send.
import { type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { Rng } from "./fuzz-rng.js";
import { ix, marketAt, portfolioAt } from "./percolator-v16-helpers.js";
import { offsetOf, sizeOf } from "./percolator-v16-layout.js";
import { keyBytes } from "./percolator-v16-oracles.js";
import { World } from "./percolator-v16-world.js";

export const LEGS = portfolioAt("legs");
export const LEG = sizeOf("PortfolioLeg");
export const legAt = (i: number, f: string) => LEGS + i * LEG + offsetOf("PortfolioLeg", f);
export const CERT = portfolioAt("health_cert");

export function i128At(b: Buffer, at: number): bigint {
  return BigInt.asIntN(128, b.readBigUInt64LE(at) | (b.readBigUInt64LE(at + 8) << 64n));
}
export function u128At(b: Buffer, at: number): bigint {
  return b.readBigUInt64LE(at) | (b.readBigUInt64LE(at + 8) << 64n);
}

/** The market of the crank tests: four assets' capacity, three configured, funding, a per-slot price cap. */
export const CRANK_MARKET = {
  capacity: 4,
  portfolios: 4,
  deposit: 10_000_000_000n,
  mark: 1_000_000n,
  market: {
    maxPortfolioAssets: 3,
    maxAbsFundingE9PerSlot: 10_000n,
    maxPriceMoveBpsPerSlot: 50n,
    maxAccrualDtSlots: 8n,
    initialMarginBps: 1000n,
    maintenanceMarginBps: 500n,
    minFundingLifetimeSlots: 100n,
    maxTradingFeeBps: 500n,
    maintenanceFeePerSlot: 1n,
    liquidationFeeBps: 100n,
    liquidationFeeCap: 100_000n,
    minNonzeroMmReq: 1_000_000n,
    minNonzeroImReq: 2_000_000n,
  },
};

/** A portfolio's signed position on `asset` (0 for none) in the reference. */
export function position(w: World, p: Address, asset: number): bigint {
  const b = w.d.data(p);
  if (b.length < 9555) return 0n;
  for (let i = 0; i < 16; i++) {
    if (b[legAt(i, "active")] !== 1 || b.readUInt32LE(legAt(i, "asset_index")) !== asset) continue;
    const q = i128At(b, legAt(i, "basis_pos_q"));
    const abs = q < 0n ? -q : q;
    return b[legAt(i, "side")] === 1 ? -abs : abs;
  }
  return 0n;
}

/** The assets a portfolio holds legs of. */
export function legAssets(w: World, p: Address): number[] {
  const b = w.d.data(p);
  const out: number[] = [];
  if (b.length < 9555) return out;
  for (let i = 0; i < 16; i++) if (b[legAt(i, "active")] === 1) out.push(b.readUInt32LE(legAt(i, "asset_index")));
  return out;
}

export function effectivePrice(w: World, asset: number): bigint {
  return w.d.data(w.m.market).readBigUInt64LE(marketAt.engine(asset, "asset.effective_price"));
}

/** The oracle accounts of asset `asset`'s hybrid profile, in leg order (none for another mode). */
export function legAccounts(w: World, asset: number): Address[] {
  const b = w.d.data(w.m.market);
  if (b[marketAt.profile(asset, "oracle_mode")] !== 1) return [];
  const count = b[marketAt.profile(asset, "oracle_leg_count")]!;
  const out: Address[] = [];
  for (let i = 0; i < count; i++) {
    const at = marketAt.profile(asset, "oracle_leg_feeds") + 32 * i;
    const feed = b.subarray(at, at + 32);
    const o = w.oracles.find((x) => (x.kind === "pyth" ? Buffer.from(x.feedId).equals(feed) : keyBytes(x.key).equals(feed)));
    if (o) out.push(o.key);
  }
  return out;
}

/** A trade of `size` on `asset` between portfolios `i` (long for a positive size) and `j`, at the effective price and
 * the base fee. */
export function tradeOf(w: World, i: number, j: number, asset: number, size: bigint, exec?: bigint): { payer: KeyPairSigner; ix: Instruction } {
  const [oa, ob, pa, pb] = [w.owners[i]!, w.owners[j]!, w.portfolios[i]!, w.portfolios[j]!];
  const base = w.d.data(w.m.market).readBigUInt64LE(marketAt.wrapper("trade_fee_base_bps"));
  return {
    payer: oa,
    ix: ix.tradeNoCpi(w.m, oa, ob, pa, pb, {
      aId: w.d.portfolioId(pa),
      aEpoch: w.d.positionEpoch(pa),
      bId: w.d.portfolioId(pb),
      bEpoch: w.d.positionEpoch(pb),
      asset,
      marketId: w.marketId(asset),
      size,
      exec: exec ?? effectivePrice(w, asset),
      fee: base,
      cap: 10_000,
    }),
  };
}

/** A keeper's crank of portfolio `k`: a hint for each of `assets` (the hybrid's oracle accounts after its hint), sent by
 * the stranger (or by the owner with the cranker's portfolio `cranker`). */
export function crankOf(
  w: World,
  k: number,
  assets: number[],
  o: { by?: KeyPairSigner; cranker?: Address; now?: bigint } = {},
): { payer: KeyPairSigner; ix: Instruction } {
  const tail: Address[] = [];
  const hints = assets.map((asset) => {
    const legs = legAccounts(w, asset);
    tail.push(...legs);
    return { asset, accounts: legs.length };
  });
  const by = o.by ?? w.stranger;
  return { payer: by, ix: ix.crank(w.m, by, w.portfolios[k]!, o.now ?? 0n, hints, tail, o.cranker) };
}

/** The world of the crank tests: asset 1 an EWMA mark, asset 2 a hybrid on the oracle accounts. */
export async function crankWorld(seed: bigint, options: object = CRANK_MARKET): Promise<World> {
  const w = await World.build(seed, options as never);
  await setUpAssets(w, new Rng(seed ^ 0x5eedn));
  return w;
}

/** Asset 1 to an EWMA mark and asset 2 to a hybrid (a fresh market of the world). */
export async function setUpAssets(w: World, rng: Rng): Promise<void> {
  const mark = w.d.data(w.m.market).readBigUInt64LE(marketAt.profile(1, "mark_ewma_e6")) || 1_000_000n;
  await w.d.ok("crank world ConfigureEwmaMark", w.m.admin, [
    ix.configureEwmaMark(w.m, w.m.admin, {
      asset: 1,
      marketId: w.marketId(1),
      mark,
      halflife: BigInt(1 + rng.int(50)),
      minFee: 0n,
      sequence: w.seq(1, "oracleObservation") + 1n,
      epoch: w.epoch(1),
    }),
  ]);
  w.refreshOracles();
  for (let n = 0; n < 8; n++) {
    const h = w.hybrid(2, rng);
    if ((await w.d.send("crank world ConfigureHybridOracle", h.payer, [h.ix])) === "ok") return;
  }
  throw new Error("no hybrid configuration succeeded");
}

/** Push asset `asset`'s managed mark (EWMA or AuthMark) to `mark`. */
export async function pushMark(w: World, asset: number, mark: bigint, label = "push"): Promise<string> {
  const mode = w.d.data(w.m.market)[marketAt.profile(asset, "oracle_mode")]!;
  if (mode !== 2 && mode !== 3) return "not managed";
  const auth = w.oracleAuthority(asset);
  const tag = mode === 2 ? 36 : 63;
  return w.d.send(label, auth, [
    ix.pushMark(tag as 36 | 63, w.m, auth, {
      asset,
      marketId: w.marketId(asset),
      mark,
      sequence: w.seq(asset, "oracleObservation") + 1n,
      epoch: w.epoch(asset),
    }),
  ]);
}

export { portfolioAt, marketAt };
