// Percolator v12.20 (showcase/mainnet/percolator) against the mainnet binary: KeeperCrank's compute units at several
// account counts. For each count N, a market of N traders (each long against one LP) with a maintenance fee, then: a
// crank with no candidates (the fee sweep of min(N, 128) accounts and the risk buffer's four) and a crank touching up
// to 64 candidates, both under the default 200,000 and under the 1.4M limit, and after a crash cranks liquidating
// batches of up to 64 of them (each with its ADL step) under the 1.4M limit; on a market of its own, 4 liquidations
// under the default limit. Where both outcomes match, the crank goes through `Diff.compare` (everything `Diff.both`
// compares, and fewer units in the port on a success). A crank the original cannot complete within a limit is recorded
// (the port's outcome beside it) and that market is left there, since the two VMs no longer hold the same state.
//
// PERCOLATOR_CRANK_COUNTS=1,16,64,256,1024,4096 sets the counts (the default 1,16,64,256); the table prints with
// PERCOLATOR_CU=1.
import { type Instruction } from "@solana/kit";
import { afterAll, describe, expect, it } from "vitest";
import { send } from "../../test/harness.js";
import { Diff, HAVE_ORIGINAL, SOL, computeUnits, ix, meta, outcome } from "./percolator-helpers.js";

const COUNTS = (process.env.PERCOLATOR_CRANK_COUNTS ?? "1,16,64,256").split(",").map(Number);

interface Row {
  accounts: number;
  crank: string;
  limit: string;
  original: string;
  port: string;
}

describe.skipIf(!HAVE_ORIGINAL)("Percolator v12.20: KeeperCrank compute units by account count", () => {
  const table: Row[] = [];
  afterAll(() => {
    if (process.env.PERCOLATOR_CU) console.table(table);
  });

  const runs: [number, boolean][] = [...COUNTS.map((c) => [c, false] as [number, boolean]), [16, true]];
  for (const [count, defaultLimit] of runs)
    it(`${count} accounts${defaultLimit ? ", liquidations under the default limit" : ""}`, { timeout: 900_000 }, async () => {
      // The LP takes one of the 4,096 slots.
      const n = Math.min(count, 4095);
      const d = await Diff.create();
      const m = await d.market({ edit: (a) => Object.assign(a, { maintenanceFeePerSlot: 1n }) });
      const lpUser = await d.user(m, 1_000_000n * SOL);
      await d.ok("InitUser: lp", lpUser.key, [ix.initUser(m, lpUser, 100_000n * SOL)]);
      for (let i = 0; i < n; i++) {
        const u = await d.user(m);
        await d.ok(`user ${i}: InitUser`, u.key, [ix.initUser(m, u, 10n * SOL)]);
        await d.ok(`user ${i}: TradeNoCpi`, u.key, [ix.tradeNoCpi(m, u.key, lpUser.key, 0, 1 + i, 800_000_000n + BigInt(i) * 1000n)]);
      }
      const keeper = await d.funded();
      let diverged = false;
      /** Both programs under `limit` (null: the default); compared like Diff.both when both complete. */
      const crank = async (name: string, ixs: Instruction[], limit: number | null): Promise<void> => {
        if (diverged) return;
        const all = limit === null ? ixs : [computeUnits(limit), ...ixs];
        const [a, b] = [await send(d.original, keeper, all), await send(d.port, keeper, all)];
        const row: Row = {
          accounts: n + 1,
          crank: name,
          limit: limit === null ? "200,000" : limit.toLocaleString("en"),
          original: `${outcome(a) === "ok" ? "ok" : outcome(a).replace(/.*error: /, "")} ${meta(a).computeUnitsConsumed()}`,
          port: `${outcome(b) === "ok" ? "ok" : outcome(b).replace(/.*error: /, "")} ${meta(b).computeUnitsConsumed()}`,
        };
        table.push(row);
        if (outcome(a) === outcome(b)) {
          // The whole comparison of `Diff.both`: logs, inner instructions, return data, every named account (the
          // keeper's lamports, the slab), and fewer units in the port when both succeed.
          d.compare(`${n + 1} accounts: ${name}`, keeper, all, a, b);
          return;
        }
        // Only a budget the original exhausts may part the two: the port must then have completed.
        expect(meta(a).logs().join("\n"), name).toContain("exceeded CUs meter");
        expect(outcome(b), name).toBe("ok");
        diverged = true;
      };
      const touch = Array.from({ length: Math.min(n, 64) }, (_, i) => [1 + i, 0xff] as [number, number]);
      for (const limit of [null, 1_400_000]) {
        d.setClock(d.slot + 50n);
        d.setPrice(m, 100_000_000n);
        await crank("no candidates (the fee sweep)", [ix.crank(m, keeper, 65535)], limit);
        d.setClock(d.slot + 50n);
        d.setPrice(m, 100_000_000n);
        await crank(`${touch.length} candidates, touch only`, [ix.crank(m, keeper, 65535, touch)], limit);
      }
      // The crash: every trader below maintenance. Liquidations in batches of 4, 8, 16, 32 and 64 (the 1.4M limit), each
      // on traders not liquidated yet (and the risk buffer's entries first); on a market of its own, 4 under the
      // default limit.
      d.setClock(d.slot + 50n);
      d.setPrice(m, 90_000_000n);
      let next = 1;
      const batches: [number, number | null][] = defaultLimit
        ? [[4, null]]
        : [
            [4, 1_400_000],
            [8, 1_400_000],
            [16, 1_400_000],
            [32, 1_400_000],
            [64, 1_400_000],
          ];
      for (const [size, limit] of batches) {
        const batch = Array.from({ length: Math.min(size, n + 1 - next) }, (_, i) => [next + i, 0] as [number, number]);
        if (batch.length === 0) break;
        next += batch.length;
        await crank(`${batch.length} candidates, FullClose`, [ix.crank(m, keeper, 65535, batch)], limit);
      }
    });
});
