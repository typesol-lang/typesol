// A random graduation fuzz of showcase/mainnet/meteora-dbc (a port subject to Meteora's Non-commercial Licence, see
// that directory's LICENSE.md) against Meteora's Dynamic Bonding Curve 0.2.2 on mainnet, side by side
// (meteora-dbc-graduation.ts): a random config (base and quote token programs, a base transfer fee, a transfer hook,
// fee options and the migrated pool's fees, the partner's and creator's liquidity split, vesting, locked vesting, a
// fixed supply, the migration fee, a creator who is the partner), a pool, random swaps to the threshold, then the
// locker, both surplus withdrawals, both migration fee withdrawals, the leftover and the migration in a random order,
// each tried more than once. Each pool takes the DAMM v2 path or (when DAMM v1 and the dynamic vault are present,
// meteora-dbc-graduation-v1.ts) the DAMM v1 path: its config's migration option rewritten to DAMM v1, the DAMM v1
// metadata and migration on the option's DAMM v1 config (now and then another), and the partner's and creator's LP
// locked and claimed among the other steps. Every transaction goes to both programs and must give the same outcome,
// account bytes, inner instructions and events. Reproduce with FUZZ_SEED=<seed>; lengthen with FUZZ_RUNS=<n> (pools
// per run).
import { type Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { present } from "../../test/binaries.js";
import { Rng } from "./fuzz-rng.js";
import { type Graduation, DAMM_SO, LOCKER_SO, MPL_SO, graduation } from "./meteora-dbc-graduation.js";
import { type V1, type V1Migrated, CONFIG_MIGRATION_OPTION, DAMM_V1_CONFIGS, DAMM_V1_SO, VAULT_SO, WSOL, graduationV1 } from "./meteora-dbc-graduation-v1.js";
import { type Params, type Vesting, ORIGINAL, TOKEN, TOKEN_2022, baseParams, constantSupply, mint, noVesting, transferFee } from "./meteora-dbc-helpers.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const RUNS = Number(process.env.FUZZ_RUNS ?? 10);

describe.skipIf(!present(ORIGINAL, MPL_SO, DAMM_SO, LOCKER_SO))("showcase/mainnet/meteora-dbc graduation fuzz against Meteora DBC 0.2.2 on mainnet", () => {
  let g: Graduation;
  let v: V1 | null = null;
  let quotes: [Address, Address][];
  beforeAll(async () => {
    g = await graduation();
    if (present(DAMM_V1_SO, VAULT_SO)) v = graduationV1(g);
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
  function randomConfig(r: Rng, v1: boolean): [Params, ReturnType<typeof transferFee> | undefined, boolean] {
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
    // DAMM v1 takes SPL Token pools only: mostly those, now and then another (refused, compared)
    const kind = v1 && r.chance(90) ? "spl" : r.pick(["spl", "t22", "fee", "hook"] as const);
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
      const useV1 = v !== null && r.chance(50);
      const [params, fee, hook] = randomConfig(r, useV1);
      const [quote, quoteProgram] = useV1 && r.chance(90) ? r.pick<[Address, Address]>([quotes[0]!, [WSOL, TOKEN]]) : r.pick(quotes);
      const pi = await g.maybePool(params, quote, quoteProgram, { fee, hook, selfPartnered: r.chance(20) });
      if (!pi) {
        // a config or pool both programs refused (compared): draw another
        tally["refused config"] = (tally["refused config"] ?? 0) + 1;
        continue;
      }
      // the DAMM v1 path: the config's migration option rewritten to DAMM v1, as configs made before 0.2.1 hold it
      if (useV1) v!.patch(pi.config, (d) => (d[CONFIG_MIGRATION_OPTION] = 0));
      const path = useV1 ? "v1" : "v2";
      const splOnly = pi.baseProgram === TOKEN && pi.quoteProgram === TOKEN;
      let v1Pool: V1Migrated | null = null;
      // random buys short of the threshold (at most 3 × 25 of its 80), then one to complete the curve
      for (let i = r.int(4); i > 0; i--) await g.buy(pi, BigInt(1 + r.int(25)) * 1_000_000_000n, "random buy");
      await g.complete(pi);
      const lp = ["lock partner", "lock creator", "claim partner", "claim creator"];
      const actions = ["locker", "surplus partner", "surplus creator", "fee partner", "fee creator", "leftover", "migrate", "metadata", ...(useV1 ? lp : [])];
      const shuffled = [...actions, ...actions].map((a) => [r.next(), a] as const).sort((x, y) => (x[0] < y[0] ? -1 : 1));
      // then the locker, the migration and the leftover once more, so that every pool that can graduate does (and on
      // the DAMM v1 path, its metadata before and its LP after)
      const last = useV1 ? ["locker", "metadata", "migrate", "leftover", ...lp] : ["locker", "migrate", "leftover"];
      for (const a of [...shuffled.map((x) => x[1]), ...last]) {
        let o: string;
        if (a === "locker") o = await g.locker(pi);
        else if (a === "surplus partner") o = await g.surplus(pi, "partner");
        else if (a === "surplus creator") o = await g.surplus(pi, "creator");
        else if (a === "fee partner") o = await g.migrationFee(pi, 0, pi.partner);
        else if (a === "fee creator") o = await g.migrationFee(pi, 1, pi.creator);
        else if (a === "leftover") o = await g.leftover(pi, r.chance(70));
        else if (a === "metadata") o = useV1 ? await v!.metadata(pi) : await g.metadata(pi);
        else if (a.startsWith("lock ") || a.startsWith("claim ")) {
          // the LP exists once the pool migrated (its lock escrows and LP accounts are made then)
          if (!v1Pool) continue;
          const owner = a.endsWith("partner") ? pi.partner.address : pi.creator.address;
          o = a.startsWith("lock ") ? await v!.lock(pi, v1Pool, owner) : await v!.claim(pi, v1Pool, owner);
        } else if (useV1) {
          const option = params.migration_fee_option;
          const dammConfig = option < 6 && r.chance(90) ? DAMM_V1_CONFIGS[option]! : r.pick(DAMM_V1_CONFIGS);
          const res = await v!.migrate(pi, { dammConfig, makeVaults: splOnly, label: `migrate_meteora_damm (seed ${SEED}, run ${run})` });
          o = res.outcome;
          if (o === "ok") {
            migrated++;
            v1Pool = res.m;
          }
        } else {
          o = (await g.migrate(pi, { label: `migrate (seed ${SEED}, run ${run})` })).outcome;
          if (o === "ok") migrated++;
        }
        const key = `${path} ${a}: ${o === "ok" ? "ok" : (/code: (\d+)/.exec(o)?.[1] ?? o.slice(-40))}`;
        tally[key] = (tally[key] ?? 0) + 1;
      }
    }
    console.log(`seed ${SEED}: ${migrated} of ${RUNS} pools migrated; outcomes ${JSON.stringify(tally)}; compared ${g.p.stats.compared} transactions`);
    expect(migrated).toBeGreaterThan(0);
  }, 1_800_000);
});
