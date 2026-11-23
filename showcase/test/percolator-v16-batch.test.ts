// BatchTradeNoCpi of the Percolator v16 port (showcase/mainnet/percolator-v16/batch.ts, the engine's batch in trade.ts)
// against the reference: Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so is the Rust build of those commits, not a deployed
// program. Every transaction goes to both and is compared whole (percolator-v16-helpers.ts `Diff`): outcome, logs,
// inner instructions, return data, every named account's bytes; the port must use fewer compute units on each success.
import { AccountRole, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import { CRANK_MARKET } from "./percolator-v16-crank-world.js";
import { type Leg, type Trader, batch, batchWorld, position } from "./percolator-v16-batch-world.js";
import { Diff, FUZZ_SEED, HAVE_PORT, HAVE_REFERENCE, type InitMarketArgs, type Market, PROGRAM, SLOT, ix, marketAt } from "./percolator-v16-helpers.js";

/** PERCOLATOR_V16_BATCH_FUZZ: the batches of the random sequence (300 by default). */
const BATCH_FUZZ = Number(process.env.PERCOLATOR_V16_BATCH_FUZZ ?? "300");

/** The instruction with account `at` replaced (its signer kept when the replacement can sign). */
function withAccountAt(i: Instruction, at: number, address: Address, role: AccountRole, signer?: KeyPairSigner): Instruction {
  const accounts = [...(i.accounts ?? [])] as { address: Address; role: AccountRole; signer?: KeyPairSigner }[];
  if (!signer && role === AccountRole.READONLY_SIGNER) role = AccountRole.READONLY;
  if (!signer && role === AccountRole.WRITABLE_SIGNER) role = AccountRole.WRITABLE;
  accounts[at] = { address, role, ...(signer ? { signer } : {}) };
  return { ...i, accounts: accounts as Instruction["accounts"] };
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: BatchTradeNoCpi", () => {
  it("legs on several assets: open, grow, reduce, flip and close in one batch, with fees and marks", async () => {
    const d = await Diff.create();
    const { m, t } = await batchWorld(d, { ewma: true });
    const [a, b, c] = t as [Trader, Trader, Trader];
    await d.ok("one leg", a.owner, [batch(d, m, a, b, [{ asset: 0, size: 1_000n }])]);
    await d.ok("two legs, mixed signs", a.owner, [
      batch(d, m, a, b, [
        { asset: 1, size: -2_000n },
        { asset: 2, size: 3_000n },
      ]),
    ]);
    await d.ok("four legs, fees 0 to 50 bps", a.owner, [
      batch(d, m, a, c, [
        { asset: 3, size: 1_000_000n, fee: 50n },
        { asset: 0, size: -500n, fee: 10n },
        { asset: 2, size: 7_000n, fee: 0n, exec: 1_000_500n },
        { asset: 1, size: 1_000_000_000n, fee: 25n, exec: 999_000n },
      ]),
    ]);
    // Closing one leg and opening another reuses the freed slot in the batch's position map.
    await d.ok("close asset 0 and grow 3", a.owner, [
      batch(d, m, a, b, [
        { asset: 0, size: -1_000n },
        { asset: 3, size: 10n },
      ]),
    ]);
    await d.ok("flip asset 2 and reduce 1", a.owner, [
      batch(d, m, a, b, [
        { asset: 2, size: -6_000n },
        { asset: 1, size: 1_000n },
      ]),
    ]);
    // A fee redirect to market 0's domains and a base fee.
    await d.ok("UpdateFeeRedirectPolicy 3000", m.admin, [ix.marketPolicy(m, m.admin, 58, 3_000n, 1n, 0n)]);
    await d.ok("redirected fees", a.owner, [
      batch(d, m, a, c, [
        { asset: 1, size: 5_000n, fee: 100n },
        { asset: 3, size: -5_000n, fee: 499n },
        { asset: 0, size: 9n, fee: 1n },
      ]),
    ]);
    await d.ok("UpdateTradeFeePolicy 30", m.admin, [ix.tradeFeePolicy(m, m.admin, 30n, 1n, 0n)]);
    await d.send("a leg's fee below the base", a.owner, [
      batch(d, m, a, b, [
        { asset: 1, size: 100n, fee: 30n },
        { asset: 2, size: 100n, fee: 29n },
      ]),
    ]);
    await d.ok("fees at the base", a.owner, [
      batch(d, m, a, b, [
        { asset: 1, size: 100n, fee: 30n },
        { asset: 2, size: 100n, fee: 30n },
      ]),
    ]);
    // The marks move with the prints on the EWMA assets; time passes and the next batch accrues.
    for (let k = 1n; k <= 5n; k++) {
      d.setClock(SLOT + k * 3n);
      await d.send(`after ${k * 3n} slots`, a.owner, [
        batch(d, m, a, b, [
          { asset: 1, size: k % 2n === 0n ? 500n : -500n, exec: 1_000_000n + k * 20_000n, fee: 30n },
          { asset: 3, size: -100n, exec: 990_000n, fee: 40n },
        ]),
      ]);
    }
    // Every position closed by two batches.
    for (const [x, y] of [
      [a, b],
      [a, c],
    ] as const) {
      const legs: Leg[] = [];
      for (let asset = 0; asset < 4; asset++) {
        const q = position(d, x.portfolio, asset);
        if (q !== 0n && position(d, y.portfolio, asset) === -q) legs.push({ asset, size: -q, fee: 30n });
      }
      if (legs.length > 0) await d.send(`close ${legs.length} legs`, x.owner, [batch(d, m, x, y, legs)]);
    }
  });

  it("cross margin: 14 legs in one batch, then 14 closed in one, and a mixed 16-leg request refused", async () => {
    const d = await Diff.create();
    const { m, t } = await batchWorld(d, { assets: 14, n: 2, deposit: 50_000_000_000n });
    const [a, b] = t as [Trader, Trader];
    const legs = Array.from({ length: 14 }, (_, asset): Leg => ({ asset, size: asset % 3 === 0 ? -1_000n : 1_000n, fee: BigInt(asset) }));
    // The heap: the reference's allocator assumes 256 KiB whatever the frame; on the runtime's 32 KiB frame its 14-leg
    // batch's vectors (the decoded legs, the requests, the per-leg contexts with each leg's 424-byte profile, the
    // snapshots, the fee credits) must still fit for the two to agree.
    for (const heap of [null, 32 * 1024, 64 * 1024]) await d.send(`14 legs, heap ${heap ?? "default"}`, a.owner, [batch(d, m, a, b, legs)], { heap });
    if (position(d, a.portfolio, 0) === 0n) await d.ok("14 legs", a.owner, [batch(d, m, a, b, legs)]);
    await d.ok("14 legs closed", a.owner, [
      batch(
        d,
        m,
        a,
        b,
        legs.map((l) => ({ ...l, size: -l.size })),
      ),
    ]);
    await d.ok("7 legs", a.owner, [batch(d, m, a, b, legs.slice(0, 7))]);
    await d.send("15 legs (a repeat)", a.owner, [batch(d, m, a, b, [...legs, { asset: 0, size: 1n }])]);
    await d.send("16 legs (repeats)", a.owner, [batch(d, m, a, b, [...legs, { asset: 1, size: 1n }, { asset: 2, size: 1n }])]);
    const id = d.portfolioId(a.portfolio);
    await d.send("17 legs (decode)", a.owner, [batch(d, m, a, b, [...legs, ...legs.slice(0, 3)], { aId: id })]);
    // A batch growing all 14 legs runs the reference past 1,400,000 compute units; the port completes it, and the
    // reference rerun under a raised budget agrees with it (Diff.send).
    console.log(
      `14-leg batches past the reference's limit: ${d.raised.map((r) => `${r.label} (reference ${r.reference}, port ${r.port})`).join("; ") || "none"}`,
    );
  });

  it("refusals: counts, repeats, prints, sizes, market ids, policies, margins", async () => {
    const d = await Diff.create();
    const { m, t } = await batchWorld(d, {
      args: { initialMarginBps: 2000n, maintenanceMarginBps: 1000n, maxPriceMoveBpsPerSlot: 10n, maxAccrualDtSlots: 4n },
      deposit: 1_000_000n,
    });
    const [a, b] = t as [Trader, Trader];
    await d.send("no leg", a.owner, [batch(d, m, a, b, [])]);
    await d.send("a repeated asset", a.owner, [
      batch(d, m, a, b, [
        { asset: 1, size: 1n },
        { asset: 1, size: 2n },
      ]),
    ]);
    await d.send("a repeated asset, later", a.owner, [
      batch(d, m, a, b, [
        { asset: 0, size: 1n },
        { asset: 1, size: 1n },
        { asset: 0, size: -1n },
      ]),
    ]);
    for (const exec of [0n, 1_000_000_000_000n, 1_000_000_000_001n, (1n << 64n) - 1n])
      await d.send(`second leg's print ${exec}`, a.owner, [
        batch(d, m, a, b, [
          { asset: 0, size: 10n },
          { asset: 1, size: 10n, exec },
        ]),
      ]);
    const MAX = 100_000_000_000_000n;
    for (const size of [0n, MAX, -MAX, MAX + 1n, -(1n << 127n), (1n << 127n) - 1n])
      await d.send(`second leg's size ${size}`, a.owner, [
        batch(d, m, a, b, [
          { asset: 0, size: 10n },
          { asset: 1, size },
        ]),
      ]);
    for (const marketId of [0n, 1n, 3n])
      await d.send(`second leg's market id ${marketId}`, a.owner, [
        batch(d, m, a, b, [
          { asset: 0, size: 10n },
          { asset: 1, size: 10n, marketId },
        ]),
      ]);
    for (const asset of [4, 5, 65_535])
      await d.send(`asset ${asset}`, a.owner, [
        batch(d, m, a, b, [
          { asset: 0, size: 10n },
          { asset, size: 10n },
        ]),
      ]);
    for (const fee of [499n, 500n, 501n, (1n << 64n) - 1n]) await d.send(`fee ${fee}`, a.owner, [batch(d, m, a, b, [{ asset: 2, size: 1_000n, fee }])]);
    // The initial margin to the unit: 20% of 1,000,000 at price 1 is 200,000 of each deposit of 1,000,000 (both legs).
    await d.send("IM: legs to 5,000,000 of notional", a.owner, [
      batch(d, m, a, b, [
        { asset: 0, size: 2_500_000n },
        { asset: 1, size: -2_500_000n },
      ]),
    ]);
    await d.send("IM: one atom past", a.owner, [
      batch(d, m, a, b, [
        { asset: 0, size: 2_500_000n },
        { asset: 1, size: -2_500_001n },
      ]),
    ]);
    await d.send("IM: interim legs need not be feasible", a.owner, [
      batch(d, m, a, b, [
        { asset: 2, size: 9_000_000n },
        { asset: 2 + 1, size: 1n },
      ]),
    ]);
    // A backing-fee policy configured: per-leg backing fees are not split in a batch.
    await d.ok("UpdateBackingFeePolicy domain 2", m.admin, [ix.backingFeePolicy(m, m.admin, 2, 2n, 10, 0, 1n, 0n)]);
    await d.send("with a backing-fee policy", a.owner, [batch(d, m, a, b, [{ asset: 0, size: 10n }])]);
    void marketAt;
  });

  it("accounts: flags, owners, repeated pairs, a short list; data: ids, epochs, lengths", async () => {
    const d = await Diff.create();
    const { m, t } = await batchWorld(d, { n: 2 });
    const [a, b] = t as [Trader, Trader];
    const base = batch(d, m, a, b, [
      { asset: 0, size: 1_000n },
      { asset: 2, size: -50n },
    ]);
    const accounts = base.accounts!;
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++) {
        if (i === j) continue;
        const from = accounts[j]! as { address: Address; signer?: KeyPairSigner };
        await d.send(`account ${i} := account ${j}`, a.owner, [withAccountAt(base, i, from.address, accounts[i]!.role, from.signer)]);
      }
    for (let i = 0; i < 5; i++) await d.send(`account ${i} without its flags`, a.owner, [withAccountAt(base, i, accounts[i]!.address, AccountRole.READONLY)]);
    const stranger = await d.funded();
    await d.send("signer A a stranger", a.owner, [withAccountAt(base, 0, stranger.address, AccountRole.READONLY_SIGNER, stranger)]);
    await d.send("signer B a stranger", a.owner, [withAccountAt(base, 1, stranger.address, AccountRole.READONLY_SIGNER, stranger)]);
    for (let n = 0; n < 5; n++) await d.send(`${n} accounts`, a.owner, [{ ...base, accounts: accounts.slice(0, n) }]);
    await d.send("a sixth account", a.owner, [{ ...base, accounts: [...accounts, { address: PROGRAM, role: AccountRole.READONLY }] }]);
    const id = d.portfolioId(a.portfolio);
    await d.send("A's id + 1", a.owner, [batch(d, m, a, b, [{ asset: 0, size: 1n }], { aId: id + 1n })]);
    await d.send("B's id 0", a.owner, [batch(d, m, a, b, [{ asset: 0, size: 1n }], { bId: 0n })]);
    await d.send("A's epoch + 1", a.owner, [batch(d, m, a, b, [{ asset: 0, size: 1n }], { aEpoch: 1n })]);
    await d.send("B's epoch + 1", a.owner, [batch(d, m, a, b, [{ asset: 0, size: 1n }], { bEpoch: 1n })]);
    const fresh = batch(d, m, a, b, [
      { asset: 0, size: 1_000n },
      { asset: 2, size: -50n },
    ]);
    await d.ok("a batch bumps both epochs", a.owner, [fresh]);
    await d.send("the old epochs", a.owner, [fresh]);
    const good = batch(d, m, a, b, [{ asset: 1, size: 1n }]);
    const data = Buffer.from(good.data!);
    await d.send("one byte short", a.owner, [{ ...good, data: new Uint8Array(data.subarray(0, data.length - 1)) }]);
    await d.send("one byte long", a.owner, [{ ...good, data: new Uint8Array(Buffer.concat([data, Buffer.from([0])])) }]);
    await d.send("the count one too high", a.owner, [
      { ...good, data: new Uint8Array(Buffer.concat([data.subarray(0, 1), Buffer.from([2]), data.subarray(2)])) },
    ]);
  });

  it(`a random sequence of ${BATCH_FUZZ} batches with prices moving (seed ${FUZZ_SEED})`, async () => {
    const d = await Diff.create();
    const rng = new Rng(FUZZ_SEED * 66n + 1n);
    const below = (n: bigint) => rng.next() % n;
    const { m, t } = await batchWorld(d, { assets: 5, capacity: 6, n: 4, ewma: true, args: { ...CRANK_MARKET.market, maxPortfolioAssets: 5 } });
    let ok = 0;
    const byLegs = new Map<number, number>();
    const refusals = new Map<string, number>();
    const keeper = await d.funded();
    const hints = [0, 1, 2, 3, 4].map((asset) => ({ asset, accounts: 0 }));
    for (let step = 0; step < BATCH_FUZZ; step++) {
      if (below(4n) === 0n) d.setClock(d.slot + below(6n));
      // A keeper cranks the portfolios now and then (the accrual at the moving marks: without it a lagging target or a
      // loss-stale asset blocks every risk-increasing leg).
      if (step % 3 === 0) for (const p of t) await d.send(`step ${step}: crank`, keeper, [ix.crank(m, keeper, p.portfolio, 0n, hints)]);
      const i = Number(below(4n));
      let j = Number(below(4n));
      if (j === i) j = (j + 1) % 4;
      const n = Number(below(7n));
      // One batch in four carries a corrupted leg (an asset out of range or repeated, a size of 0 or past the cap, a
      // print out of range, a fee past the market's maximum, a wrong market id); the rest are valid requests.
      const corrupt = below(4n) === 0n;
      const assets = [0, 1, 2, 3, 4].sort(() => (below(2n) === 0n ? -1 : 1));
      const legs: Leg[] = [];
      for (let k = 0; k < n; k++) {
        const asset = corrupt && below(6n) === 0n ? Number(below(7n)) : assets[k % 5]!;
        const pick = below(10n);
        let size: bigint = below(20_000n) + 1n;
        if (pick === 0n) size = -position(d, t[i]!.portfolio, asset) || 1n;
        else if (pick === 1n) size = below(100_000_000n) + 1n;
        else if (pick === 2n && corrupt) size = below(3n) === 0n ? 0n : 100_000_000_000_001n;
        if (below(2n) === 0n) size = -size;
        const exec = corrupt && below(6n) === 0n ? rng.next() : 950_000n + below(100_000n);
        const fee = corrupt && below(6n) === 0n ? 500n + below(100n) : below(60n);
        legs.push({ asset, size, exec, fee, marketId: corrupt && below(8n) === 0n ? below(4n) : undefined });
      }
      const got = await d.send(`step ${step}: ${n} legs`, t[i]!.owner, [batch(d, m, t[i]!, t[j]!, legs)]);
      if (got !== "ok") refusals.set(got.replace(/.*error: /, ""), (refusals.get(got.replace(/.*error: /, "")) ?? 0) + 1);
      if (got === "ok") {
        ok++;
        byLegs.set(n, (byLegs.get(n) ?? 0) + 1);
      }
    }
    console.log(
      `batch fuzz: ${BATCH_FUZZ} batches compared, ${ok} succeeded in both; successes by legs: ${[...byLegs]
        .sort((x, y) => x[0] - y[0])
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ")}; refused alike: ${[...refusals].map(([k, v]) => `${k} ×${v}`).join(", ")}`,
    );
    expect(ok).toBeGreaterThan(BATCH_FUZZ / 10);
  }, 1_800_000);
});
