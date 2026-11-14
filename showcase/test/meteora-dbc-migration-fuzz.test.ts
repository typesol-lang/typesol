// A random graduation fuzz of showcase/mainnet/meteora-dbc (a port subject to Meteora's Non-commercial Licence, see
// that directory's LICENSE.md) against Meteora's Dynamic Bonding Curve 0.2.2 on mainnet, side by side
// (meteora-dbc-graduation.ts): a random config (base and quote token programs, a base transfer fee, a transfer hook,
// fee options and the migrated pool's fees, the partner's and creator's liquidity split, vesting, locked vesting, a
// fixed supply, the migration fee), a pool, random swaps to the threshold, then the locker, both surplus withdrawals,
// both migration fee withdrawals, the leftover and the DAMM v2 migration in a random order, each tried more than once.
// Every transaction goes to both programs and must give the same outcome, account bytes, inner instructions and
// events. Reproduce with FUZZ_SEED=<seed>; lengthen with FUZZ_RUNS=<n> (pools per run).
import { type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { present } from "../../test/binaries.js";
import { Rng } from "./fuzz-rng.js";
import { type Graduation, DAMM_SO, LOCKER_SO, MPL_SO, graduation } from "./meteora-dbc-graduation.js";
import { type Params, type Vesting, ORIGINAL, TOKEN, TOKEN_2022, baseParams, constantSupply, mint, noVesting, transferFee } from "./meteora-dbc-helpers.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const RUNS = Number(process.env.FUZZ_RUNS ?? 10);

describe.skipIf(!present(ORIGINAL, MPL_SO, DAMM_SO, LOCKER_SO))("showcase/mainnet/meteora-dbc graduation fuzz against Meteora DBC 0.2.2 on mainnet", () => {
  let g: Graduation;
  let quotes: [Address, Address][];
  beforeAll(async () => {
    g = await graduation();
    quotes = [
      [await mint(g.p, TOKEN, 9), TOKEN],
      [await mint(g.p, TOKEN_2022, 6, [{ kind: "metadataPointer" }]), TOKEN_2022],
    ];
  }, 300_000);

  function vesting(r: Rng, percentage: number): Vesting {
    if (percentage === 0) return noVesting();
    const periods = r.int(3) === 0 ? 0 : 1 + r.int(200);
    return {
      vesting_percentage: percentage,
      bps_per_period: periods === 0 ? 0 : 1 + r.int(Math.floor(10000 / periods)),
      number_of_periods: periods,
      cliff_duration_from_migration_time: periods === 0 ? 2 * 86400 + r.int(86400 * 30) : r.int(86400 * 3),
      frequency: periods === 0 ? 0 : 3600 + r.int(86400),
    };
  }

  /** A random config: [params, transfer fee parameters (create_config2) or undefined, transfer hook]. */
  function randomConfig(r: Rng): [Params, ReturnType<typeof transferFee> | undefined, boolean] {
    let p: Params = { ...baseParams(), collect_fee_mode: r.int(2), creator_trading_fee_percentage: r.pick([0, 0, 25, 50, 100]) };
    if (r.chance(50)) p.migration_fee = { fee_percentage: r.int(51), creator_fee_percentage: 0 };
    if (p.migration_fee.fee_percentage > 0) p.migration_fee.creator_fee_percentage = r.int(101);
    // the liquidity split: at least 10% locked permanently, so the one-day lock rule always holds
    const parts = [0, 0, 0, 0, 0, 0];
    parts[r.int(2) === 0 ? 1 : 3] += 10;
    for (let left = 90; left > 0;) {
      const n = Math.min(left, 1 + r.int(40));
      parts[r.int(6)] += n;
      left -= n;
    }
    p = {
      ...p,
      partner_liquidity_percentage: parts[0]!,
      partner_permanent_locked_liquidity_percentage: parts[1]!,
      creator_liquidity_percentage: parts[2]!,
      creator_permanent_locked_liquidity_percentage: parts[3]!,
      partner_liquidity_vesting_info: vesting(r, parts[4]!),
      creator_liquidity_vesting_info: vesting(r, parts[5]!),
    };
    const kind = r.pick(["spl", "t22", "fee", "hook"] as const);
    if (kind === "t22" || kind === "hook") p.token_type = 1;
    let option = r.int(7);
    if (kind === "fee") {
      p = constantSupply(p);
      option = 6;
    }
    p.migration_fee_option = option;
    if (option === 6) {
      const collect = kind === "fee" ? 2 : r.int(3);
      const mode = r.pick([0, 1, 3, 4]);
      p.migrated_pool_fee = { collect_fee_mode: collect, dynamic_fee: r.int(2), pool_fee_bps: r.pick([10, 25, 100, 250, 500, 1000]) };
      p.migrated_pool_base_fee_mode = mode;
      if (mode >= 3)
        p.migrated_pool_market_cap_fee_scheduler_params = {
          number_of_period: 1 + r.int(50),
          sqrt_price_step_bps: 1 + r.int(500),
          scheduler_expiration_duration: 1 + r.int(86400 * 7),
          reduction_factor: BigInt(1 + r.int(mode === 3 ? 100 : 5000)),
        };
      p.compounding_fee_bps = collect === 2 ? r.pick([0, 100, 5000, 10000]) : 0;
    }
    if (kind !== "fee") {
      if (r.chance(30))
        p.locked_vesting = {
          amount_per_period: BigInt(1 + r.int(1_000_000_000)),
          cliff_duration_from_migration_time: BigInt(r.int(86400)),
          frequency: BigInt(1 + r.int(86400)),
          number_of_period: BigInt(1 + r.int(20)),
          cliff_unlock_amount: BigInt(r.int(5_000_000_000)),
        };
      if (r.chance(30))
        p.token_supply = { pre_migration_token_supply: 10n ** 17n, post_migration_token_supply: r.pick([10n ** 17n, 9n * 10n ** 16n, 6n * 10n ** 16n]) };
    }
    const fee = kind === "fee" ? transferFee(r.pick([0, 10, 100, 1000]), r.int(2), 0) : undefined;
    if (fee) fee.migrated_transfer_fee_authority_option = fee.transfer_fee_basis_points === 0 ? 2 + r.int(2) : r.int(4);
    return [p, fee, kind === "hook"];
  }

  it(`random configs, swaps, withdrawals and migrations (seed ${SEED}, ${RUNS} pools)`, async () => {
    const r = new Rng(SEED);
    const tally: Record<string, number> = {};
    let migrated = 0;
    for (let run = 0; run < RUNS; run++) {
      const [params, fee, hook] = randomConfig(r);
      const [quote, quoteProgram] = r.pick(quotes);
      const pi = await g.maybePool(params, quote, quoteProgram, { fee, hook });
      if (!pi) {
        // a config or pool both programs refused (compared): draw another
        tally["refused config"] = (tally["refused config"] ?? 0) + 1;
        continue;
      }
      for (let i = r.int(4); i > 0; i--) await g.buy(pi, BigInt(1 + r.int(30)) * 1_000_000_000n, "random buy");
      await g.complete(pi);
      const actions = ["locker", "surplus partner", "surplus creator", "fee partner", "fee creator", "leftover", "migrate", "metadata"];
      const shuffled = [...actions, ...actions].map((a) => [r.next(), a] as const).sort((x, y) => (x[0] < y[0] ? -1 : 1));
      // then the locker, the migration and the leftover once more, so that every pool that can graduate does
      for (const a of [...shuffled.map((x) => x[1]), "locker", "migrate", "leftover"]) {
        let o: string;
        if (a === "locker") o = await g.locker(pi);
        else if (a === "surplus partner") o = await g.surplus(pi, "partner");
        else if (a === "surplus creator") o = await g.surplus(pi, "creator");
        else if (a === "fee partner") o = await g.migrationFee(pi, 0, pi.partner);
        else if (a === "fee creator") o = await g.migrationFee(pi, 1, pi.creator);
        else if (a === "leftover") o = await g.leftover(pi, r.chance(70));
        else if (a === "metadata") o = await g.metadata(pi);
        else {
          o = (await g.migrate(pi, { label: `migrate (seed ${SEED}, run ${run})` })).outcome;
          if (o === "ok") migrated++;
        }
        const key = `${a}: ${o === "ok" ? "ok" : (/code: (\d+)/.exec(o)?.[1] ?? o.slice(-40))}`;
        tally[key] = (tally[key] ?? 0) + 1;
      }
    }
    console.log(`seed ${SEED}: ${migrated} of ${RUNS} pools migrated; outcomes ${JSON.stringify(tally)}; compared ${g.p.stats.compared} transactions`);
    expect(migrated).toBeGreaterThan(0);
  }, 1_800_000);
});
