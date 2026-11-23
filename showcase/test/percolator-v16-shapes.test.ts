// The author's largest market shapes, where whole-market scans dominate the compute units: InitMarket, ResolveMarket and
// CloseSlab's terminal scan on markets of up to 5,682 asset slots (the most a 10 MiB account holds,
// `MAX_10M_MARKET_SLOTS` of the author's tests/v16_cu.rs). Against the reference: Percolator v16 at commit 7b110913
// (engine 5e3af07), aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so,
// the Rust build of those commits, not a deployed program. Every transaction is compared whole, and each one that
// succeeds must cost the port fewer compute units than the reference (`Diff`'s rule). The shapes:
//
// - InitMarket into a market account of 1,000 and of 5,682 slots, as the author's
//   `inv_077…public_native_insurance_capacity` makes its maximum market through the public route (its transaction 4);
// - ResolveMarket of such a market with every slot configured, as `inv_077…v16_bpf_10m_market_resolution_stays_bounded`
//   grows it (`grow_market_to_10m_with_high_active_asset`: the configured count and next market id written into the
//   group, the last slot a copy of asset 0's state as asset N-1, its backing buckets empty for that market), then
//   ResolveStalePermissionless of a second such market;
// - CloseSlab's terminal scan of a resolved market of 5,682 configured slots with fresh backing in the market, which
//   scans up to 256 assets a call (`inv_071…generated_terminal_actionability`, `inv_070…generated_prefix_actionability`:
//   their scans run over Empty buckets until a live Fresh one), the bucket here a Fresh one at asset 300 written into
//   the market; then with a claim-free residual instead (every asset's recredit computed).
//
// In the comparison of the author's suite on the binary before these tests (README, "Where the port costs more"), the
// port cost more on exactly these three: per scanned slot it re-checked the account's owner and bounds and recomputed
// the slot's offset with overflow checks, and CloseSlab made both backing expiries effective for every slot.
import { describe, expect, it } from "vitest";
import { type Market, Diff, HAVE_PORT, HAVE_REFERENCE, defaultInitArgs, ix, marketAt } from "./percolator-v16-helpers.js";
import { MARKET, sizeOf } from "./percolator-v16-layout.js";

/** `MAX_10M_MARKET_SLOTS`: the largest capacity whose market account fits in 10 MiB. */
const MAX_10M_MARKET_SLOTS = 5_682;
const BOUND_SCALE = 1_000_000_000_000n;

/** Asset 0's authority epoch (its control sequences after the 424-byte profile). */
const epoch0 = (d: Diff, m: Market) => d.data(m.market).readBigUInt64LE(marketAt.slot(0) + 424 + 16);
const nextMarketId = (d: Diff, m: Market) => d.data(m.market).readBigUInt64LE(marketAt.group("next_market_id"));

/**
 * A market of `n` slots initialized through InitMarket (one configured asset), then grown in place to `n` configured
 * assets as the author's `grow_market_to_10m_with_high_active_asset` does: the configured count and the next market id
 * written into the group; the last slot's asset a copy of asset 0's with its own market id, its two backing buckets
 * empty for that market (every profile is already asset 0's: InitMarket writes it into every slot).
 */
async function grownMarket(d: Diff, n: number): Promise<Market> {
  const m = await d.newMarket({ capacity: n });
  await d.ok(`InitMarket of ${n} slots`, m.admin, [ix.initMarket(m, defaultInitArgs())]);
  const high = n - 1;
  d.patch(m.market, (b) => {
    b.writeUInt32LE(n, marketAt.group("config.max_market_slots"));
    b.writeBigUInt64LE(BigInt(n) + 1n, marketAt.group("next_market_id"));
    const asset = marketAt.engine(0, "asset");
    b.copy(b, marketAt.engine(high, "asset"), asset, asset + sizeOf("AssetState"));
    b.writeBigUInt64LE(BigInt(high) + 1n, marketAt.engine(high, "asset.market_id"));
    b.writeBigUInt64LE(BigInt(high) + 1n, marketAt.engine(high, "backing_long.market_id"));
    b.writeBigUInt64LE(BigInt(high) + 1n, marketAt.engine(high, "backing_short.market_id"));
  });
  return m;
}

const report = (d: Diff, label: string) => `${label}: reference ${d.cu[label]![0]}, port ${d.cu[label]![1]}`;

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: the author's largest market shapes", () => {
  it("InitMarket of 1,000 and of 5,682 slots", async () => {
    const d = await Diff.create();
    for (const n of [1_000, MAX_10M_MARKET_SLOTS]) {
      const m = await d.newMarket({ capacity: n });
      expect(d.data(m.market).length).toBe(MARKET.slots + n * MARKET.slotLen);
      await d.ok(`InitMarket of ${n} slots`, m.admin, [ix.initMarket(m, defaultInitArgs())]);
      console.log(report(d, `InitMarket of ${n} slots`));
    }
  }, 600_000);

  it("ResolveMarket and ResolveStalePermissionless of markets with every slot configured", async () => {
    const d = await Diff.create();
    for (const n of [1_000, MAX_10M_MARKET_SLOTS]) {
      const m = await grownMarket(d, n);
      d.setClock(d.slot + 2n);
      const label = `ResolveMarket of ${n} configured slots`;
      await d.ok(label, m.admin, [ix.resolveMarket(m, m.admin, nextMarketId(d, m), epoch0(d, m))]);
      expect(d.data(m.market)[marketAt.group("mode")]).toBe(1);
      console.log(report(d, label));
    }
    // ResolveStalePermissionless walks the same scan once the permissionless stale window has matured.
    const m = await grownMarket(d, MAX_10M_MARKET_SLOTS);
    await d.ok("ConfigurePermissionlessResolve 100, delay 5", m.admin, [ix.permissionlessResolve(m, m.admin, nextMarketId(d, m), 100n, 5n, 1n, epoch0(d, m))]);
    d.setClock(d.slot + 1_000n);
    const label = `ResolveStalePermissionless of ${MAX_10M_MARKET_SLOTS} configured slots`;
    await d.ok(label, m.admin, [ix.resolveStalePermissionless(m)]);
    console.log(report(d, label));
  }, 900_000);

  it("CloseSlab's terminal scan of 5,682 configured slots: fresh backing, then a claim-free residual", async () => {
    const d = await Diff.create();
    const n = MAX_10M_MARKET_SLOTS;
    const m = await grownMarket(d, n);
    d.setClock(d.slot + 2n);
    await d.ok("ResolveMarket", m.admin, [ix.resolveMarket(m, m.admin, nextMarketId(d, m), epoch0(d, m))]);
    const dest = await d.tokenAccount(m.mint, m.admin.address, 0n);
    const progress = () => d.data(m.market).readBigUInt64LE(marketAt.wrapper("terminal_slab_scan_progress"));
    // Fresh backing of one atom in the market (the vault holds it: no residual) and asset 300's long bucket Fresh with
    // an expiry far ahead: the scan runs over Empty buckets 256 at a time until that live bucket, where it waits.
    d.patch(m.market, (b) => {
      b.writeBigUInt64LE(1n, marketAt.group("vault"));
      b.writeBigUInt64LE(BOUND_SCALE, marketAt.group("source_fresh_backing_total_num"));
      b.writeBigUInt64LE(301n, marketAt.engine(300, "backing_long.market_id"));
      b.writeBigUInt64LE(1n << 40n, marketAt.engine(300, "backing_long.expiry_slot"));
      b[marketAt.engine(300, "backing_long.status")] = 1;
    });
    await d.ok("CloseSlab: a scan of assets 0 to 255", m.admin, [ix.closeSlab(m, m.admin, dest, epoch0(d, m))]);
    expect(progress()).toBe(256n);
    await d.ok("CloseSlab: a scan from 256 to the live Fresh bucket", m.admin, [ix.closeSlab(m, m.admin, dest, epoch0(d, m))]);
    expect(progress()).toBe(300n);
    // From the live bucket itself: LockActive (kernel_terminal_slab_wait_continuation).
    await d.send("CloseSlab: from the live Fresh bucket", m.admin, [ix.closeSlab(m, m.admin, dest, epoch0(d, m))]);
    for (const label of ["CloseSlab: a scan of assets 0 to 255", "CloseSlab: a scan from 256 to the live Fresh bucket"]) console.log(report(d, label));
    // Without fresh backing and with a claim-free residual: every scanned asset's recredit is computed (none here).
    d.patch(m.market, (b) => {
      b.writeBigUInt64LE(1_000n, marketAt.group("vault"));
      b.writeBigUInt64LE(0n, marketAt.group("source_fresh_backing_total_num"));
      b[marketAt.engine(300, "backing_long.status")] = 0;
    });
    await d.ok("CloseSlab: a residual scan from 300", m.admin, [ix.closeSlab(m, m.admin, dest, epoch0(d, m))]);
    expect(progress()).toBe(556n);
    console.log(report(d, "CloseSlab: a residual scan from 300"));
  }, 900_000);
});
