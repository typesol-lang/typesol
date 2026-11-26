// Market and portfolio set-ups of the Percolator v16 port over many key sets, each transaction compared whole with
// the reference (Percolator v16 at commit 7b110913, engine 5e3af07, aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0; test/programs/percolator_v16.so, the Rust build of those commits, not a deployed
// program). Each round makes a market of fresh keys (from PERCOLATOR_V16_SEED, printed with every failure) and runs the
// test world's set-up on it (percolator-v16-world.ts): InitMarket, two InitPortfolios, a Deposit, ConfigureAuthMark
// for each configured asset and ConfigurePermissionlessResolve, then a Withdraw that signs for the vault PDA. Varied:
// - the market's capacity (1 to 8 slots, now and then up to 64) and its configured assets;
// - the vault PDA's bump: a third of the markets are the one of 32 candidate keys whose bump is lowest (the more
//   `find_program_address` iterations, the lower the bump), so bumps down to the 240s and below are reached;
// - the heap: the author's 256 KiB preamble, none (the runtime's 32 KiB), or a 32, 64 or 128 KiB request;
// - InitMarket's accounts: in order most of the time; now and then permuted, one repeated, or the list cut or
//   lengthened (each refused alike in both), after which the round continues with the accounts in order.
// PERCOLATOR_V16_SETUP_STRESS (300) is the number of rounds.
import { type Address, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { pda } from "../../test/harness.js";
import { Rng } from "./fuzz-rng.js";
import {
  ATA_PROGRAM,
  Diff,
  HAVE_PORT,
  HAVE_REFERENCE,
  type Market,
  PROGRAM,
  RUN_SEED,
  TOKEN,
  defaultInitArgs,
  ix,
  seededKeys,
} from "./percolator-v16-helpers.js";
import { marketLen } from "./percolator-v16-layout.js";
import { tokenAccountBytes } from "./percolator-helpers.js";

const ROUNDS = Number(process.env.PERCOLATOR_V16_SETUP_STRESS ?? 300);

describe.skipIf(!HAVE_REFERENCE || !HAVE_PORT)("Percolator v16 port: set-ups over many key sets", () => {
  it(`${ROUNDS} market and portfolio set-ups`, async () => {
    const d = await Diff.create();
    const rng = new Rng(RUN_SEED ^ 0x5e7a9n);
    const keys = seededKeys(0x5e7a9n);
    const tally = {
      rounds: 0,
      init: 0,
      initOk: 0,
      mutated: 0,
      steps: 0,
      stepsOk: 0,
      lowestBump: 255,
      bumps: new Map<number, number>(),
      heaps: new Map<string, number>(),
    };

    /** A market account of `capacity` slots at `market`, its mint and its canonical vault (as Diff.newMarket). */
    const marketAt = async (market: KeyPairSigner, capacity: number): Promise<Market> => {
      const admin = await d.funded(100n);
      const mint = await d.mint(6);
      d.write(market.address, PROGRAM, new Uint8Array(marketLen(capacity)));
      const [vaultPda, bump] = await pda(PROGRAM, ["vault", market.address]);
      const [vault] = await pda(ATA_PROGRAM, [vaultPda, TOKEN, mint]);
      d.write(vault, TOKEN, tokenAccountBytes({ mint, owner: vaultPda, amount: 0n }));
      return { market: market.address, admin, mint, vaultPda, bump, vault };
    };

    for (let round = 0; round < ROUNDS; round++) {
      tally.rounds++;
      const capacity = rng.chance(90) ? 1 + rng.int(8) : 9 + rng.int(56);
      const assets = 1 + rng.int(Math.min(capacity, 14));
      // A third of the markets: the lowest-bump key of 32 candidates.
      let key = await keys();
      if (rng.chance(33)) {
        let best = (await pda(PROGRAM, ["vault", key.address]))[1];
        for (let n = 0; n < 31; n++) {
          const k = await keys();
          const b = (await pda(PROGRAM, ["vault", k.address]))[1];
          if (b < best) [key, best] = [k, b];
        }
      }
      const m = await marketAt(key, capacity);
      tally.lowestBump = Math.min(tally.lowestBump, m.bump);
      tally.bumps.set(m.bump, (tally.bumps.get(m.bump) ?? 0) + 1);
      const heap = rng.pick([undefined, undefined, null, 32 * 1024, 64 * 1024, 128 * 1024] as const);
      const heapName = heap === undefined ? "256 KiB" : heap === null ? "none" : `${heap / 1024} KiB`;
      tally.heaps.set(heapName, (tally.heaps.get(heapName) ?? 0) + 1);
      const o = { heap };
      const label = `round ${round} (capacity ${capacity}, ${assets} assets, bump ${m.bump}, heap ${heapName})`;
      const init = ix.initMarket(m, defaultInitArgs({ maxPortfolioAssets: assets, maxTradingFeeBps: 500n, maintenanceFeePerSlot: rng.chance(50) ? 1n : 0n }));
      // Now and then InitMarket's accounts changed first: refused alike, then the round goes on.
      if (rng.chance(15)) {
        const a = [...init.accounts!];
        const r = rng.int(4);
        const accounts = r === 0 ? [a[2]!, a[1]!, a[0]!] : r === 1 ? [a[0]!, a[1]!, a[rng.int(2)]!] : r === 2 ? a.slice(0, rng.int(3)) : [...a, a[rng.int(3)]!];
        tally.mutated++;
        tally.init++;
        if ((await d.send(`${label} InitMarket, accounts changed`, m.admin, [{ ...init, accounts }], o)) === "ok") tally.initOk++;
      }
      tally.init++;
      const got = await d.send(`${label} InitMarket`, m.admin, [init], o);
      if (got !== "ok") continue;
      tally.initOk++;
      const step = async (what: string, payer: KeyPairSigner, i: Parameters<Diff["send"]>[2][number]) => {
        tally.steps++;
        const r = await d.send(`${label} ${what}`, payer, [i], o);
        if (r === "ok") tally.stepsOk++;
        return r;
      };
      const portfolios: { owner: KeyPairSigner; portfolio: Address; source: Address }[] = [];
      for (let i = 0; i < 2; i++) {
        const { owner, portfolio } = await d.newPortfolio();
        if ((await step(`InitPortfolio ${i}`, owner, ix.initPortfolio(m, owner, portfolio))) !== "ok") continue;
        portfolios.push({ owner, portfolio, source: await d.tokenAccount(m.mint, owner.address, 1_000_000_000n) });
      }
      const first = portfolios[0];
      if (first) {
        const amount = BigInt(1 + rng.int(1_000_000));
        await step(
          "Deposit",
          first.owner,
          ix.deposit(m, first.owner, first.portfolio, first.source, d.portfolioId(first.portfolio), d.portfolioSequence(first.portfolio), amount),
        );
      }
      for (let asset = 0; asset < Math.min(assets, 2); asset++)
        await step(
          `ConfigureAuthMark ${asset}`,
          m.admin,
          ix.configureAuthMark(m, m.admin, { asset, marketId: BigInt(asset + 1), mark: 1_000_000n, sequence: 1n, epoch: 0n }),
        );
      await step("ConfigurePermissionlessResolve", m.admin, ix.permissionlessResolve(m, m.admin, BigInt(assets + 1), 6_000_000n, 10n, 1n, 0n));
      if (first)
        await step(
          "Withdraw",
          first.owner,
          ix.withdraw(
            m,
            first.owner,
            first.portfolio,
            first.source,
            d.portfolioId(first.portfolio),
            d.portfolioSequence(first.portfolio),
            BigInt(rng.int(1_000)),
          ),
        );
    }
    const bumps = [...tally.bumps].sort((a, b) => a[0] - b[0]);
    console.log(
      `set-ups: ${tally.rounds} rounds, InitMarket ${tally.initOk}/${tally.init} succeeded in both (${tally.mutated} with changed accounts), ` +
        `${tally.stepsOk}/${tally.steps} later steps; vault PDA bumps from ${tally.lowestBump} (${bumps
          .slice(0, 8)
          .map(([b, n]) => `${b}: ${n}`)
          .join(", ")}, …); ` +
        `heap ${[...tally.heaps].map(([h, n]) => `${h} ${n}`).join(", ")}`,
    );
    expect(tally.initOk).toBeGreaterThan(ROUNDS / 2);
  }, 3_600_000);
});
