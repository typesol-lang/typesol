// TradeCpi and BatchTradeCpi of the Percolator v16 port (showcase/mainnet/percolator-v16/matcher.ts, with trading.ts and
// batch.ts after the call) against the reference: Percolator v16 at commit 7b110913 (engine 5e3af07),
// aeyakovenko/percolator-prog and aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so is the Rust build of
// those commits, not a deployed program. Both VMs load the same three matcher binaries (test/programs/SOURCES.md): the
// author's auth matcher (prices at the oracle with configured spreads and a backing-fee cap), his hostile matcher (one
// attack per mode: over-fills, reversed fills, forged echoes, a zero price, unflagged and matcher-chosen partials, a short
// batch reply, a stale answer, a CPI that drains a tail account, return data from another program before or after its
// own) and percolator-match (a passive LP). Every transaction is compared whole: outcome, logs, inner instructions (the
// matcher call and what the matcher calls), return data, every named account's bytes.
import { AccountRole, type Address, type KeyPairSigner } from "@solana/kit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddressEncoder } from "@solana/kit";
import { build } from "../../src/compiler/index.js";
import { describe, expect, it } from "vitest";
import { Rng } from "./fuzz-rng.js";
import {
  type Lp,
  type Trader,
  batch,
  batchCpi,
  batchWorld,
  hostileMode,
  lpMatcher,
  matcherIx,
  position,
  setLpMatcher,
  tradeCpi,
} from "./percolator-v16-batch-world.js";
import { Diff, FUZZ_SEED, HAVE_PORT, HAVE_REFERENCE, MATCHERS, type Market, PROGRAM, SLOT, TOKEN, ix } from "./percolator-v16-helpers.js";

const ROGUE_SRC = fileURLToPath(new URL("./fixtures/percolator-v16-rogue-matcher.ts", import.meta.url));
const addressBytes = (a: Address) => getAddressEncoder().encode(a);
const short = (o: string) => (o === "ok" ? "ok" : o.replace(/.*error: /, "").replace(/ \}+$/, ""));

/** PERCOLATOR_V16_CPI_FUZZ: the random matcher trades (300 by default). */
const CPI_FUZZ = Number(process.env.PERCOLATOR_V16_CPI_FUZZ ?? "300");

async function cpiWorld(d: Diff, o: Parameters<typeof batchWorld>[1] = {}): Promise<{ m: Market; t: Trader[] }> {
  return batchWorld(d, { ewma: true, n: 4, ...o });
}

/** A second deployment of the hostile matcher (its nested return writer calls another program). */
async function secondHostile(d: Diff): Promise<Address> {
  const id = await d.address();
  d.addProgram(id, new Uint8Array(readFileSync(MATCHERS.hostile.file)));
  return id;
}

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: TradeCpi and BatchTradeCpi", () => {
  it("TradeCpi through the auth matcher: fills both ways, spreads, limits, fees, backing caps", async () => {
    const d = await Diff.create();
    const { m, t } = await cpiWorld(d);
    const [a, lp, c] = t as [Trader, Trader, Trader];
    const mt = await lpMatcher(d, m, lp, "auth");
    await d.ok("open long", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 1_000n })]);
    await d.ok("open short on an EWMA asset", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 1, size: -2_000n })]);
    await d.ok("increase", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 500n })]);
    await d.ok("reduce", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: -700n })]);
    await d.ok("flip", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: -1_800n })]);
    await d.ok("close", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 1_000n })]);
    // Spreads: the ask above the oracle for a buy, the bid below for a sell; limits at and past the quote.
    const spread = await lpMatcher(d, m, c, "auth", { bid: 30n, ask: 70n, backingCap: 25 });
    await d.ok("buy at the ask", a.owner, [tradeCpi(d, m, a, c, spread, { asset: 2, size: 10_000n })]);
    await d.ok("sell at the bid", a.owner, [tradeCpi(d, m, a, c, spread, { asset: 3, size: -10_000n })]);
    for (const limit of [1n, 1_006_999n, 1_007_000n, 1_007_001n])
      await d.send(`buy, limit ${limit}`, a.owner, [tradeCpi(d, m, a, c, spread, { asset: 2, size: 100n, limit })]);
    for (const limit of [997_001n, 997_000n, 996_999n, (1n << 64n) - 1n])
      await d.send(`sell, limit ${limit}`, a.owner, [tradeCpi(d, m, a, c, spread, { asset: 3, size: -100n, limit })]);
    // Fees: the taker's signed fee against the base, the market's maximum and the LP's cap.
    for (const fee of [0n, 1n, 499n, 500n, 501n]) await d.send(`fee ${fee}`, a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 2, size: 10n, fee })]);
    await d.ok("UpdateTradeFeePolicy 30", m.admin, [ix.tradeFeePolicy(m, m.admin, 30n, 1n, 0n)]);
    for (const fee of [29n, 30n, 31n]) await d.send(`fee ${fee} under base 30`, a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 2, size: 1_000_000n, fee })]);
    await setLpMatcher(d, m, lp, mt, 29, 0xffff_ffff_ffff_ffffn);
    await d.send("the LP's fee cap 29 under base 30", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 2, size: 1_000n, fee: 30n })]);
    await setLpMatcher(d, m, lp, mt, 30, 0xffff_ffff_ffff_ffffn);
    await d.ok("the LP's fee cap at the base", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 2, size: 1_000n, fee: 30n })]);
    for (const cap of [0, 10_000, 10_001, 65_535])
      await d.send(`taker's backing cap ${cap}`, a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 2, size: 10n, fee: 30n, cap })]);
    // Time passes on the EWMA asset: the accrual before the matcher, the post-trade mark.
    for (let k = 1n; k <= 4n; k++) {
      d.setClock(SLOT + 5n * k);
      await d.send(`after ${5n * k} slots`, a.owner, [tradeCpi(d, m, a, c, spread, { asset: 1, size: k % 2n === 0n ? 3_000n : -3_000n, fee: 30n })]);
    }
  });

  it("TradeCpi through the hostile matcher: every attack refused alike, the honest and partial answers filled", async () => {
    const d = await Diff.create();
    const { m, t } = await cpiWorld(d);
    const [a, lp] = t as [Trader, Trader];
    const mt = await lpMatcher(d, m, lp, "hostile");
    const second = await secondHostile(d);
    const nested = await d.address();
    d.write(nested, second, new Uint8Array(128));
    for (const mode of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18, 19, 20, 255]) {
      for (const ratio of mode === 19 ? [0, 1, 128, 254, 255] : [0]) {
        await d.ok(`mode ${mode}`, lp.owner, [hostileMode(lp, mt, mode, ratio)]);
        for (const size of [1_000n, -1_000n, 1n, -255n])
          await d.send(`mode ${mode} ratio ${ratio}, size ${size}`, a.owner, [
            tradeCpi(
              d,
              m,
              a,
              lp,
              mt,
              { asset: 0, size },
              mode === 14 || mode === 17 || mode === 18 ? [{ address: second }, { address: nested, writable: true }] : [],
            ),
          ]);
      }
    }
    // Mode 13 answers once (honestly) and then leaves the context as it was: the stale answer echoes an old request.
    await d.ok("mode 13", lp.owner, [hostileMode(lp, mt, 13)]);
    await d.send("mode 13, the first call", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 2, size: 100n })]);
    await d.send("mode 13, the stale answer", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 2, size: 100n })]);
    // The context closed by its owner (the control close): no longer the matcher's.
    await d.ok("mode honest", lp.owner, [hostileMode(lp, mt, 9)]);
    const recipient = await d.funded(1n);
    await d.ok("close the context", lp.owner, [
      matcherIx(
        mt.program,
        [12],
        [
          { address: lp.owner.address, role: AccountRole.READONLY_SIGNER, signer: lp.owner },
          { address: mt.context, role: AccountRole.WRITABLE },
          { address: recipient.address, role: AccountRole.WRITABLE },
        ],
      ),
    ]);
    await d.send("a closed context", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 10n })]);
  });

  it("TradeCpi: accounts, the tail, the LP's matcher config and the data", async () => {
    const d = await Diff.create();
    const { m, t } = await cpiWorld(d);
    const [a, lp, c] = t as [Trader, Trader, Trader];
    const mt = await lpMatcher(d, m, lp, "auth");
    const base = tradeCpi(d, m, a, lp, mt, { asset: 0, size: 100n });
    const accounts = base.accounts! as { address: Address; role: AccountRole; signer?: KeyPairSigner }[];
    const at = (i: number, address: Address, role: AccountRole, signer?: KeyPairSigner) => {
      const list = [...accounts];
      if (!signer && role === AccountRole.READONLY_SIGNER) role = AccountRole.READONLY;
      if (!signer && role === AccountRole.WRITABLE_SIGNER) role = AccountRole.WRITABLE;
      list[i] = { address, role, ...(signer ? { signer } : {}) };
      return { ...base, accounts: list as typeof base.accounts };
    };
    for (let i = 0; i < 7; i++)
      for (let j = 0; j < 7; j++)
        if (i !== j) await d.send(`account ${i} := account ${j}`, a.owner, [at(i, accounts[j]!.address, accounts[i]!.role, accounts[j]!.signer)]);
    for (let i = 0; i < 7; i++) await d.send(`account ${i} read-only`, a.owner, [at(i, accounts[i]!.address, AccountRole.READONLY)]);
    for (let n = 0; n < 7; n++) await d.send(`${n} accounts`, a.owner, [{ ...base, accounts: accounts.slice(0, n) as typeof base.accounts }]);
    // The tail: up to 32 accounts that are not the program's; a signer, one of the seven, the program itself (a
    // re-entrant call would need it), an account it owns, 33 accounts: refused.
    const plain = await Promise.all(Array.from({ length: 33 }, () => d.funded(1n)));
    await d.send("a tail of 32", a.owner, [
      tradeCpi(
        d,
        m,
        a,
        lp,
        mt,
        { asset: 0, size: 100n },
        plain.slice(0, 32).map((k) => ({ address: k.address, writable: true })),
      ),
    ]);
    await d.send("a tail of 33", a.owner, [
      tradeCpi(
        d,
        m,
        a,
        lp,
        mt,
        { asset: 0, size: 100n },
        plain.map((k) => ({ address: k.address })),
      ),
    ]);
    await d.send("a signer in the tail", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 100n }, [{ address: plain[0]!.address, signer: plain[0]! }])]);
    for (const [label, address] of [
      ["the market", m.market],
      ["A", a.portfolio],
      ["B", lp.portfolio],
      ["the matcher", mt.program],
      ["the context", mt.context],
      ["the delegate", mt.delegate],
      ["the program", PROGRAM],
      ["another portfolio", c.portfolio],
      ["the taker", a.owner.address],
      ["the token program", TOKEN],
    ] as const)
      await d.send(`${label} in the tail`, a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 100n }, [{ address }])]);
    // The LP's matcher config: disabled, expired, another context or delegate, a short or foreign context.
    await d.send("the wrong sequence", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 100n, bSequence: d.portfolioSequence(lp.portfolio) + 1n })]);
    await setLpMatcher(d, m, lp, mt, 10_000, SLOT + 2n);
    await d.ok("expiry in two slots", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 100n })]);
    d.setClock(SLOT + 2n);
    await d.send("expired at its slot", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 100n })]);
    await setLpMatcher(d, m, lp, mt, 10_000, 0xffff_ffff_ffff_ffffn, 0);
    await d.send("disabled", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 100n })]);
    const other = await lpMatcher(d, m, lp, "auth");
    await d.send("the old context after a new config", a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 100n })]);
    await d.send("the new context, the old delegate", a.owner, [tradeCpi(d, m, a, lp, { ...other, delegate: mt.delegate }, { asset: 0, size: 100n })]);
    await d.ok("the new context", a.owner, [tradeCpi(d, m, a, lp, other, { asset: 0, size: 100n })]);
    await d.ok("a trade disables nothing of the LP's (its matcher fill)", a.owner, [tradeCpi(d, m, a, lp, other, { asset: 0, size: -100n })]);
    await d.ok("TradeNoCpi disables the LP's matcher", a.owner, [batch(d, m, a, lp, [{ asset: 2, size: 10n }])]);
    await d.send("after TradeNoCpi", a.owner, [tradeCpi(d, m, a, lp, other, { asset: 0, size: 100n })]);
    const short = await lpMatcher(d, m, c, "auth");
    for (const len of [63, 64, 146]) {
      const ctx = await d.address();
      d.write(ctx, MATCHERS.auth.id, new Uint8Array(len));
      await d.send(`a context of ${len} bytes`, a.owner, [tradeCpi(d, m, a, c, { ...short, context: ctx }, { asset: 0, size: 100n })]);
    }
    // The data: ids, epochs, the asset and its market id, sizes, a body a byte short or long.
    await setLpMatcher(d, m, lp, other, 10_000, 0xffff_ffff_ffff_ffffn);
    for (const size of [0n, 1n, -1n, 100_000_000_000_000n, 100_000_000_000_001n, -(1n << 127n), (1n << 127n) - 1n])
      await d.send(`size ${size}`, a.owner, [tradeCpi(d, m, a, lp, other, { asset: 3, size })]);
    for (const asset of [4, 5, 65_535]) await d.send(`asset ${asset}`, a.owner, [tradeCpi(d, m, a, lp, other, { asset, size: 10n })]);
    await d.send("market id 0", a.owner, [tradeCpi(d, m, a, lp, other, { asset: 0, size: 10n, marketId: 0n })]);
    await d.send("A's id + 1", a.owner, [tradeCpi(d, m, a, lp, other, { asset: 0, size: 10n, aId: d.portfolioId(a.portfolio) + 1n })]);
    await d.send("B's epoch + 1", a.owner, [tradeCpi(d, m, a, lp, other, { asset: 0, size: 10n, bEpoch: d.positionEpoch(lp.portfolio) + 1n })]);
    const good = tradeCpi(d, m, a, lp, other, { asset: 0, size: 10n });
    const data = Buffer.from(good.data!);
    await d.send("one byte short", a.owner, [{ ...good, data: new Uint8Array(data.subarray(0, data.length - 1)) }]);
    await d.send("one byte long", a.owner, [{ ...good, data: new Uint8Array(Buffer.concat([data, Buffer.from([0])])) }]);
    // Heap frames: none (the runtime's 32 KiB) to 256 KiB, with a full tail.
    for (const heap of [null, 32 * 1024, 64 * 1024, 128 * 1024])
      await d.send(
        `heap ${heap ?? "default"}`,
        a.owner,
        [
          tradeCpi(
            d,
            m,
            a,
            lp,
            other,
            { asset: 0, size: 10n },
            plain.slice(0, 32).map((k) => ({ address: k.address })),
          ),
        ],
        { heap },
      );
  });

  it("TradeCpi through percolator-match (a passive LP)", async () => {
    const d = await Diff.create();
    const { m, t } = await cpiWorld(d);
    const [a, lp] = t as [Trader, Trader];
    const mt = await lpMatcher(d, m, lp, "match", { spread: 25 });
    for (const [asset, size] of [
      [0, 1_000n],
      [1, -5_000n],
      [0, -2_000n],
      [2, 1n],
      [3, -1_000_000_000n],
      [0, 1_000n],
    ] as const)
      await d.send(`asset ${asset} size ${size}`, a.owner, [tradeCpi(d, m, a, lp, mt, { asset, size })]);
  });

  it("BatchTradeCpi: the auth matcher's fills, slippage and fee caps, legs and tails", async () => {
    const d = await Diff.create();
    const { m, t } = await cpiWorld(d);
    const [a, lp, c] = t as [Trader, Trader, Trader];
    const mt = await lpMatcher(d, m, lp, "auth");
    await d.ok("one leg", a.owner, [batchCpi(d, m, a, lp, mt, [{ asset: 0, size: 1_000n }])]);
    await d.ok("four legs", a.owner, [
      batchCpi(d, m, a, lp, mt, [
        { asset: 1, size: -1_000n },
        { asset: 2, size: 2_000n },
        { asset: 3, size: 3_000n },
        { asset: 0, size: -500n },
      ]),
    ]);
    const spread = await lpMatcher(d, m, c, "auth", { bid: 50n, ask: 50n });
    // Slippage: 50 bps of each leg's notional against the taker; the cap at the total and one below.
    const legs = [
      { asset: 0, size: 1_000_000n },
      { asset: 2, size: -2_000_000n },
    ];
    await d.send("slippage cap 14,999", a.owner, [batchCpi(d, m, a, c, spread, legs, { maxSlippage: 14_999n })]);
    await d.send("slippage cap 15,000", a.owner, [batchCpi(d, m, a, c, spread, legs, { maxSlippage: 15_000n })]);
    await d.ok("UpdateTradeFeePolicy 30", m.admin, [ix.tradeFeePolicy(m, m.admin, 30n, 1n, 0n)]);
    for (const maxFee of [0n, 1n, 8_999n, 9_000n, 9_001n])
      await d.send(`fee cap ${maxFee}`, a.owner, [
        batchCpi(
          d,
          m,
          a,
          c,
          spread,
          legs.map((l) => ({ ...l, fee: 30n })),
          { maxFee },
        ),
      ]);
    for (const limit of [1n, 1_004_999n, 1_005_000n])
      await d.send(`buy leg limit ${limit}`, a.owner, [batchCpi(d, m, a, c, spread, [{ asset: 3, size: 10n, fee: 30n, limit }])]);
    // Leg counts, repeats, sizes, fees, market ids.
    await d.send("no leg", a.owner, [batchCpi(d, m, a, lp, mt, [])]);
    await d.send("a repeated asset", a.owner, [
      batchCpi(d, m, a, lp, mt, [
        { asset: 1, size: 1n, fee: 30n },
        { asset: 1, size: 1n, fee: 30n },
      ]),
    ]);
    await d.send("a size of 0", a.owner, [
      batchCpi(d, m, a, lp, mt, [
        { asset: 1, size: 1n, fee: 30n },
        { asset: 2, size: 0n, fee: 30n },
      ]),
    ]);
    await d.send("a fee past the maximum", a.owner, [batchCpi(d, m, a, lp, mt, [{ asset: 1, size: 1n, fee: 501n }])]);
    await d.send("a wrong market id", a.owner, [
      batchCpi(d, m, a, lp, mt, [
        { asset: 1, size: 1n, fee: 30n },
        { asset: 2, size: 1n, fee: 30n, marketId: 2n },
      ]),
    ]);
    await d.send("asset 4", a.owner, [batchCpi(d, m, a, lp, mt, [{ asset: 4, size: 1n, fee: 30n }])]);
    // The tail fan-out: legs × tail accounts within 64.
    const plain = await Promise.all(Array.from({ length: 32 }, () => d.funded(1n)));
    const four = [0, 1, 2, 3].map((asset) => ({ asset, size: 10n, fee: 30n }));
    await d.send("4 legs, a tail of 16", a.owner, [
      batchCpi(
        d,
        m,
        a,
        lp,
        mt,
        four,
        {},
        plain.slice(0, 16).map((k) => ({ address: k.address })),
      ),
    ]);
    await d.send("4 legs, a tail of 17", a.owner, [
      batchCpi(
        d,
        m,
        a,
        lp,
        mt,
        four,
        {},
        plain.slice(0, 17).map((k) => ({ address: k.address })),
      ),
    ]);
    await d.send("2 legs, a tail of 32", a.owner, [
      batchCpi(
        d,
        m,
        a,
        lp,
        mt,
        four.slice(0, 2),
        {},
        plain.map((k) => ({ address: k.address })),
      ),
    ]);
    await d.send("the program in the tail", a.owner, [batchCpi(d, m, a, lp, mt, four.slice(0, 1), {}, [{ address: PROGRAM }])]);
    // A backing-fee policy configured refuses the batch.
    await d.ok("UpdateBackingFeePolicy domain 0", m.admin, [ix.backingFeePolicy(m, m.admin, 0, 1n, 10, 0, 1n, 0n)]);
    await d.send("with a backing-fee policy", a.owner, [batchCpi(d, m, a, lp, mt, four.slice(0, 1))]);
    for (const heap of [null, 32 * 1024, 64 * 1024])
      await d.send(
        `heap ${heap ?? "default"}, 4 legs and a tail of 16`,
        a.owner,
        [
          batchCpi(
            d,
            m,
            a,
            lp,
            mt,
            four,
            {},
            plain.slice(0, 16).map((k) => ({ address: k.address })),
          ),
        ],
        { heap },
      );
  });

  it("BatchTradeCpi of 14 legs: heap frames from the runtime's default, a full fan-out, past the reference's limit", async () => {
    const d = await Diff.create();
    const { m, t } = await cpiWorld(d, { assets: 14, ewma: false, deposit: 50_000_000_000n });
    const [a, lp] = t as [Trader, Trader];
    const mt = await lpMatcher(d, m, lp, "auth", { bid: 10n, ask: 10n });
    const plain = await Promise.all(Array.from({ length: 4 }, () => d.funded(1n)));
    const legs = Array.from({ length: 14 }, (_, asset) => ({ asset, size: asset % 3 === 0 ? -1_000n : 1_000n, fee: 0n }));
    const tail = plain.map((k) => ({ address: k.address, writable: true }));
    for (const heap of [null, 32 * 1024, 64 * 1024, 256 * 1024]) {
      await d.send(`14 legs, a tail of 4, heap ${heap ?? "default"}`, a.owner, [batchCpi(d, m, a, lp, mt, legs, {}, tail)], { heap });
      await d.send(
        `14 legs back, heap ${heap ?? "default"}`,
        a.owner,
        [
          batchCpi(
            d,
            m,
            a,
            lp,
            mt,
            legs.map((l) => ({ ...l, size: -l.size })),
            {},
            tail,
          ),
        ],
        { heap },
      );
    }
    console.log(`14-leg matcher batches past the reference's limit: ${d.raised.map((r) => `${r.label} (${r.reference} / ${r.port})`).join("; ") || "none"}`);
  });

  it("BatchTradeCpi through the hostile matcher: short, partial, forged and foreign replies", async () => {
    const d = await Diff.create();
    const { m, t } = await cpiWorld(d);
    const [a, lp] = t as [Trader, Trader];
    const mt = await lpMatcher(d, m, lp, "hostile");
    const second = await secondHostile(d);
    const nested = await d.address();
    d.write(nested, second, new Uint8Array(128));
    const legs = [
      { asset: 0, size: 1_000n },
      { asset: 1, size: -2_000n },
      { asset: 2, size: 300n },
    ];
    for (const mode of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 14, 15, 16, 17, 18, 19, 255]) {
      await d.ok(`mode ${mode}`, lp.owner, [hostileMode(lp, mt, mode, 100)]);
      for (const n of [1, 3])
        await d.send(`mode ${mode}, ${n} legs`, a.owner, [
          batchCpi(
            d,
            m,
            a,
            lp,
            mt,
            legs.slice(0, n),
            {},
            mode === 14 || mode === 17 || mode === 18 ? [{ address: second }, { address: nested, writable: true }] : [],
          ),
        ]);
    }
  });

  it("a rogue matcher: failing, changing accounts, re-entering, return data too long, too short or unasked, a resized context", async () => {
    const d = await Diff.create();
    const { m, t } = await cpiWorld(d);
    const [a, lp] = t as [Trader, Trader];
    const rogue = await d.address();
    const out = mkdtempSync(path.join(os.tmpdir(), "typesol-percolator-v16-rogue-"));
    const so = new Uint8Array(readFileSync(build(ROGUE_SRC, out, rogue, {}).soPath));
    rmSync(out, { recursive: true, force: true });
    d.addProgram(rogue, so);
    const mt = await lpMatcher(d, m, lp, "auth", { program: rogue, contextLen: 160, skipInit: true });
    const owned = await d.address();
    d.write(owned, rogue, new Uint8Array(8));
    const set = (mode: bigint, o: { extra?: bigint; cut?: bigint; len?: bigint; price?: bigint } = {}) =>
      d.patch(mt.context, (b) => {
        b.writeBigUInt64LE(mode, 64);
        b.writeBigUInt64LE(o.extra ?? 0n, 72);
        b.writeBigUInt64LE(o.cut ?? 0n, 80);
        b.writeBigUInt64LE(o.len ?? 128n, 88);
        Buffer.from(addressBytes(PROGRAM)).copy(b, 96);
        b.writeBigUInt64LE(o.price ?? 0n, 128);
      });
    const outcomes: string[] = [];
    const single = async (label: string, tail: { address: Address; writable?: boolean }[] = []) =>
      outcomes.push(`${label}: ${short(await d.send(`TradeCpi, ${label}`, a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 0, size: 100n }, tail)]))}`);
    const many = async (label: string, n = 3, tail: { address: Address; writable?: boolean }[] = []) =>
      outcomes.push(
        `${label}: ${short(
          await d.send(`BatchTradeCpi, ${label}`, a.owner, [
            batchCpi(
              d,
              m,
              a,
              lp,
              mt,
              [0, 1, 2].slice(0, n).map((asset) => ({ asset, size: 100n })),
              {},
              tail,
            ),
          ]),
        )}`,
      );
    set(1n);
    await single("honest");
    await many("honest");
    set(0n);
    await single("no answer (the context as it was)");
    await many("no return data");
    // A fill priced at 0, at, above and far above MAX_ORACLE_PRICE (the print's own check, OracleInvalid), on an AuthMark
    // and an EWMA asset.
    for (const price of [0n, 1n, 1_000_000_000_000n, 1_000_000_000_001n, 2_000_000_000_000n, (1n << 64n) - 1n]) {
      set(256n | 1n, { price });
      await single(`priced ${price}`);
      outcomes.push(
        `EWMA priced ${price}: ${short(await d.send(`TradeCpi on asset 1, priced ${price}`, a.owner, [tradeCpi(d, m, a, lp, mt, { asset: 1, size: 100n })]))}`,
      );
      await many(`priced ${price}`);
    }
    set(2n | 1n);
    await single("the matcher fails");
    await many("the matcher fails");
    set(4n | 1n);
    await single("an account of its own changed", [{ address: owned, writable: true }]);
    await many("an account of its own changed", 3, [{ address: owned, writable: true }]);
    set(8n | 1n);
    await single("a call back into the program");
    await many("a call back into the program");
    set(128n | 1n);
    await single("return data on a single call");
    for (const extra of [1n, 63n, 64n, 2000n]) {
      set(16n | 1n, { extra });
      await many(`${extra} bytes too many`);
    }
    for (const cut of [1n, 64n, 192n]) {
      set(32n | 1n, { cut });
      await many(`${cut} bytes too few`);
    }
    set(16n, { extra: 192n });
    await many("192 zero bytes (three answers' length, no answer)");
    for (const len of [0n, 63n, 64n, 200n]) {
      set(64n | 1n, { len: len === 200n ? 200n : len });
      await single(`the context resized to ${len}`);
      d.patch(mt.context, () => undefined);
      if (d.data(mt.context).length !== 160) d.write(mt.context, rogue, new Uint8Array(160));
    }
    console.log(`rogue matcher: ${outcomes.join("; ")}`);
  });

  it(`a random sequence of ${CPI_FUZZ} matcher trades (seed ${FUZZ_SEED})`, async () => {
    const d = await Diff.create();
    const rng = new Rng(FUZZ_SEED * 10n + 67n);
    const below = (n: bigint) => rng.next() % n;
    const { m, t } = await cpiWorld(d, { assets: 5, capacity: 6 });
    const lps: { lp: Trader; mt: Lp }[] = [];
    lps.push({ lp: t[1]!, mt: await lpMatcher(d, m, t[1]!, "auth", { bid: 20n, ask: 40n, backingCap: 100 }) });
    lps.push({ lp: t[2]!, mt: await lpMatcher(d, m, t[2]!, "match", { spread: 15 }) });
    lps.push({ lp: t[3]!, mt: await lpMatcher(d, m, t[3]!, "hostile") });
    const keeper = await d.funded();
    const hints = [0, 1, 2, 3, 4].map((asset) => ({ asset, accounts: 0 }));
    let ok = 0;
    const tally = new Map<string, number>();
    for (let step = 0; step < CPI_FUZZ; step++) {
      if (below(4n) === 0n) d.setClock(d.slot + below(5n));
      if (step % 4 === 0) for (const p of t) await d.send(`step ${step}: crank`, keeper, [ix.crank(m, keeper, p.portfolio, 0n, hints)]);
      const { lp, mt } = lps[Number(below(3n))]!;
      if (mt.program === MATCHERS.hostile.id)
        await d.ok(`step ${step}: hostile mode`, lp.owner, [hostileMode(lp, mt, below(2n) === 0n ? 9 : Number(below(20n)), Number(below(256n)))]);
      const taker = t[0]!;
      const sizeOf = (asset: number) => {
        let s = below(5n) === 0n ? -position(d, taker.portfolio, asset) || 1n : below(30_000n) + 1n;
        if (below(2n) === 0n) s = -s;
        return s;
      };
      let label: string;
      let got: string;
      if (below(2n) === 0n) {
        const asset = Number(below(5n));
        label = "TradeCpi";
        got = await d.send(`step ${step}: ${label}`, taker.owner, [
          tradeCpi(d, m, taker, lp, mt, {
            asset,
            size: sizeOf(asset),
            fee: below(50n),
            limit: below(4n) === 0n ? 990_000n + below(30_000n) : 0n,
            cap: Number(below(10_002n)),
          }),
        ]);
      } else {
        const n = Number(below(5n)) + 1;
        const assets = [0, 1, 2, 3, 4].sort(() => (below(2n) === 0n ? -1 : 1)).slice(0, n);
        label = `BatchTradeCpi ${n}`;
        got = await d.send(`step ${step}: ${label}`, taker.owner, [
          batchCpi(
            d,
            m,
            taker,
            lp,
            mt,
            assets.map((asset) => ({ asset, size: sizeOf(asset), fee: below(50n) })),
            { maxSlippage: below(3n) === 0n ? below(100_000n) : (1n << 128n) - 1n, maxFee: below(3n) === 0n ? below(10_000n) : (1n << 128n) - 1n },
          ),
        ]);
      }
      const key = `${label.split(" ")[0]} ${got === "ok" ? "ok" : got.replace(/.*error: /, "")}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      if (got === "ok") ok++;
    }
    console.log(`matcher fuzz: ${CPI_FUZZ} trades compared, ${ok} succeeded in both; ${[...tally].map(([k, v]) => `${k} ×${v}`).join(", ")}`);
    expect(ok).toBeGreaterThan(CPI_FUZZ / 10);
  }, 1_800_000);
});
