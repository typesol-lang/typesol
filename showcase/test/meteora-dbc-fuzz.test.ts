// Random config parameters against showcase/mainnet/meteora-dbc (a port subject to Meteora's Non-commercial Licence, see
// that directory's LICENSE.md) and Meteora's Dynamic Bonding Curve 0.2.2 as deployed on mainnet, side by side
// (showcase/test/meteora-dbc-helpers.ts). Each case starts from a valid config and draws every field from a range
// around its valid values and edges, so accepted and refused configs both come up; the curve, fee and vesting math
// runs on whatever the draw gives. Both programs must give the same outcome, config bytes and events. Reproduce a run
// with FUZZ_SEED=<seed>; lengthen it with FUZZ_RUNS=<n>.
import { generateKeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { present } from "../../test/binaries.js";
import { Rng } from "./fuzz-rng.js";
import {
  type Pair,
  type Params,
  type Vesting,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  ORIGINAL,
  PROGRAM,
  SYSTEM,
  TOKEN,
  TOKEN_2022,
  baseParams,
  coded,
  mint,
  pair,
} from "./meteora-dbc-helpers.js";

const SEED = BigInt(process.env.FUZZ_SEED ?? Date.now());
const RUNS = Number(process.env.FUZZ_RUNS ?? 200);

/** How often a field takes an edge value in the current case (0 in about half the cases: mostly valid configs). */
let edgePercent = 0;

/** A value from `valid` most of the time, else from `edges`. */
function draw<T>(rng: Rng, valid: readonly T[], edges: readonly T[]): T {
  return rng.chance(edgePercent) ? rng.pick(edges) : rng.pick(valid);
}

function big(rng: Rng, max: bigint): bigint {
  return ((rng.next() << 64n) | rng.next()) % (max + 1n);
}

function vesting(rng: Rng, pct: number): Vesting {
  if (pct === 0 && !rng.chance(edgePercent))
    return { vesting_percentage: 0, bps_per_period: 0, number_of_periods: 0, cliff_duration_from_migration_time: 0, frequency: 0 };
  return {
    vesting_percentage: pct,
    bps_per_period: draw(rng, [0, 1, 50, 100], [1000, 10_001, 65_535]),
    number_of_periods: draw(rng, [0, 1, 10, 50], [100, 65_535]),
    cliff_duration_from_migration_time: draw(rng, [0, 1, 3600, 86_400], [10_000_000, 63_072_001, 4_294_967_295]),
    frequency: draw(rng, [0, 1, 60, 86_400], [1_000_000, 4_294_967_295]),
  };
}

/** A config parameter set drawn around valid values. */
function drawParams(rng: Rng): Params {
  edgePercent = rng.chance(50) ? 0 : rng.pick([2, 5, 15]);
  const p = baseParams();
  const start = draw(
    rng,
    [p.sqrt_start_price, MIN_SQRT_PRICE, p.sqrt_start_price * 1000n, 1n << 64n],
    [MIN_SQRT_PRICE - 1n, MAX_SQRT_PRICE - 1n, MAX_SQRT_PRICE],
  );
  p.sqrt_start_price = start;
  // a curve of 1..17 points, rising from the start price (now and then not)
  const n = draw(rng, [1, 2, 3, 5, 8, 16], [0, 17]);
  const curve = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    price = rng.chance(edgePercent) ? price : price + 1n + big(rng, price * 3n);
    if (price > MAX_SQRT_PRICE && !rng.chance(edgePercent)) price = MAX_SQRT_PRICE;
    if (price >= 1n << 128n) price = (1n << 128n) - 1n;
    const liquidity = rng.chance(edgePercent)
      ? 0n
      : draw(rng, [big(rng, 1n << 110n) + 1n, (big(rng, 100_000_000_000_000n) + 1n) << 64n], [1n, (1n << 128n) - 1n]);
    curve.push({ sqrt_price: price, liquidity });
  }
  p.curve = curve;
  p.migration_quote_threshold = draw(rng, [1n + big(rng, 200_000_000_000n), 80_000_000_000n, 1n + big(rng, 1_000_000_000n)], [0n, 1n, (1n << 64n) - 1n]);
  p.activation_type = draw(rng, [0, 1], [2, 255]);
  p.collect_fee_mode = draw(rng, [0, 1], [2]);
  p.token_type = draw(rng, [0, 1], [2]);
  p.token_decimal = draw(rng, [6, 7, 8, 9], [0, 5, 10]);
  p.migration_option = draw(rng, [1], [0, 2]);
  const mode = draw(rng, [0, 1], [2, 3]);
  const scheduled = rng.chance(50);
  p.pool_fees.base_fee = {
    cliff_fee_numerator: draw(
      rng,
      [25_000_000n, 500_000_000n, 990_000_000n, 2_500_000n + big(rng, 987_500_000n)],
      [0n, 2_499_999n, 990_000_001n, 1_000_000_000n],
    ),
    first_factor: scheduled ? draw(rng, [1, 10, 20], [1000, 65_535]) : draw(rng, [0], [1, 60]),
    second_factor: scheduled ? draw(rng, [1n, 60n], [(1n << 64n) - 1n]) : draw(rng, [0n], [1n]),
    third_factor: scheduled
      ? mode === 1
        ? draw(rng, [100n, 1000n, 2000n], [5000n, 10_000n, 10_001n])
        : draw(rng, [1000n, 100_000n, 1_000_000n], [49_000_000n, (1n << 64n) - 1n])
      : draw(rng, [0n], [1000n]),
    base_fee_mode: mode,
  };
  if (rng.chance(30))
    p.pool_fees.dynamic_fee = {
      bin_step: draw(rng, [1], [0, 2]),
      bin_step_u128: draw(rng, [1844674407370955n], [0n]),
      filter_period: draw(rng, [10, 0], [200]),
      decay_period: draw(rng, [120, 11], [5]),
      reduction_factor: draw(rng, [5000, 0, 10_000], [10_001]),
      max_volatility_accumulator: draw(rng, [14_460_000, 0], [16_777_216]),
      variable_fee_control: draw(rng, [1000, 16_777_215], [16_777_216]),
    };
  // liquidity shares that sum to 100 (sometimes not)
  const shares = [0, 0, 0, 0, 0, 0];
  let left = 100;
  for (let i = 0; i < 5; i++) {
    const s = rng.int(left + 1);
    shares[i] = s;
    left -= s;
  }
  shares[5] = left;
  for (let i = 5; i > 0; i--) {
    const j = rng.int(i + 1);
    [shares[i], shares[j]] = [shares[j]!, shares[i]!];
  }
  if (rng.chance(edgePercent)) shares[rng.int(6)] = rng.int(256);
  p.partner_liquidity_percentage = shares[0]!;
  p.partner_permanent_locked_liquidity_percentage = shares[1]!;
  p.creator_liquidity_percentage = shares[2]!;
  p.creator_permanent_locked_liquidity_percentage = shares[3]!;
  p.partner_liquidity_vesting_info = vesting(rng, shares[4]!);
  p.creator_liquidity_vesting_info = vesting(rng, shares[5]!);
  if (rng.chance(30))
    p.locked_vesting = {
      amount_per_period: draw(rng, [0n, 1n, 1_000_000n], [(1n << 64n) - 1n]),
      cliff_duration_from_migration_time: draw(rng, [0n, 100n], [(1n << 64n) - 1n]),
      frequency: draw(rng, [0n, 1n, 60n], [(1n << 64n) - 1n]),
      number_of_period: draw(rng, [0n, 1n, 10n], [(1n << 64n) - 1n]),
      cliff_unlock_amount: draw(rng, [0n, 1n, 1_000_000_000n], [(1n << 64n) - 1n]),
    };
  p.migration_fee_option = draw(rng, [0, 1, 2, 3, 4, 5, 6, 6, 6], [7]);
  if (p.migration_fee_option === 6 || rng.chance(edgePercent)) {
    p.migrated_pool_fee = {
      collect_fee_mode: draw(rng, [0, 1, 2], [3]),
      dynamic_fee: draw(rng, [0, 1], [2]),
      pool_fee_bps: draw(rng, [10, 25, 100, 1000], [0, 9, 1001]),
    };
    p.compounding_fee_bps = p.migrated_pool_fee.collect_fee_mode === 2 ? draw(rng, [0, 5000, 10_000], [10_001]) : draw(rng, [0], [1]);
    p.migrated_pool_base_fee_mode = draw(rng, [0, 1, 3, 4], [2, 5]);
    p.migrated_pool_market_cap_fee_scheduler_params =
      p.migrated_pool_base_fee_mode >= 3 || rng.chance(edgePercent)
        ? {
            number_of_period: draw(rng, [1, 20, 100], [0, 65_535]),
            sqrt_price_step_bps: draw(rng, [1, 100], [0]),
            scheduler_expiration_duration: draw(rng, [1, 86_400], [0]),
            reduction_factor: draw(rng, [1n, 100n, 1_000_000n], [0n, 10_001n]),
          }
        : p.migrated_pool_market_cap_fee_scheduler_params;
  }
  p.migration_fee = { fee_percentage: draw(rng, [0, 1, 50, 99], [100]), creator_fee_percentage: draw(rng, [0, 50, 100], [101]) };
  if (p.migration_fee.fee_percentage === 0 && !rng.chance(edgePercent)) p.migration_fee.creator_fee_percentage = 0;
  p.creator_trading_fee_percentage = draw(rng, [0, 50, 100], [101]);
  p.token_update_authority = draw(rng, [0, 1, 2], [3, 4, 5]);
  p.pool_creation_fee = draw(rng, [0n, 1_000_000n, 100_000_000_000n], [1n, 999_999n, 100_000_000_001n]);
  p.enable_first_swap_with_min_fee = rng.chance(50);
  if (rng.chance(30)) {
    const s = draw(rng, [10n ** 17n, 10n ** 16n, big(rng, 10n ** 18n)], [0n, (1n << 64n) - 1n]);
    const pre = rng.chance(80) ? s : s + big(rng, 10n ** 15n);
    p.token_supply = { pre_migration_token_supply: pre < 1n << 64n ? pre : s, post_migration_token_supply: s };
  }
  return p;
}

describe.skipIf(!present(ORIGINAL))(`fuzz: Meteora DBC config creation against mainnet (seed ${SEED}, ${RUNS} runs)`, () => {
  let p: Pair;
  beforeAll(async () => {
    p = await pair();
  }, 300_000);

  it("random config parameters give the same outcome, config bytes and events in both", async () => {
    const rng = new Rng(SEED);
    const quotes = [
      await mint(p, TOKEN, 9),
      await mint(p, TOKEN_2022, 6),
      await mint(p, TOKEN_2022, 6, [{ kind: "transferFee", bps: 0, max: 0n, authority: false }]),
    ];
    for (let run = 0; run < RUNS; run++) {
      const params = drawParams(rng);
      const ixName = rng.pick(["create_config", "create_config2", "create_config2", "create_config_with_transfer_hook"] as const);
      const payer = await p.funded();
      const config = await generateKeyPairSigner();
      const feeClaimer = rng.chance(5) ? SYSTEM : payer.address;
      const args: Record<string, unknown> = { config_parameters: coded(params) };
      if (ixName === "create_config2")
        args.transfer_fee_parameters = rng.chance(50)
          ? null
          : {
              transfer_fee_basis_points: draw(rng, [0, 1, 100, 1000], [1001]),
              withheld_authority: draw(rng, [0, 1], [2]),
              migrated_transfer_fee_authority_option: draw(rng, [0, 1, 2, 3], [4]),
            };
      const label = `run ${run} (seed ${SEED}): ${ixName}`;
      const o = await p.both(
        label,
        payer,
        [
          p.ix(ixName, args, [
            { address: config.address, signer: config, writable: true },
            { address: feeClaimer },
            { address: rng.chance(5) ? SYSTEM : payer.address },
            { address: rng.pick(quotes) },
            ...(ixName === "create_config_with_transfer_hook" ? [{ address: rng.chance(10) ? TOKEN : SYSTEM }] : []),
            { address: payer.address, signer: payer, writable: true },
            { address: SYSTEM },
            { address: p.eventAuthority },
            { address: PROGRAM },
          ]),
        ],
        [config.address, payer.address],
      );
      expect(o).toBeTypeOf("string");
    }
    console.log(`meteora-dbc fuzz (seed ${SEED}): ${p.stats.compared} configs, outcomes ${JSON.stringify(p.stats.byOutcome)}`);
    // a run covers both sides of the line: accepted configs and refused ones
    expect(p.stats.byOutcome.ok ?? 0, JSON.stringify(p.stats.byOutcome)).toBeGreaterThan(0);
    expect(Object.keys(p.stats.byOutcome).length).toBeGreaterThan(5);
  }, 1_800_000);
});
