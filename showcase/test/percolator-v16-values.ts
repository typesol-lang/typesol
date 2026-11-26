// Struct values of Percolator v16 at commit 7b110913 (engine 5e3af07; aeyakovenko/percolator, Apache-2.0) for the
// function-level comparisons of the port (percolator-v16-kernels.ts): an extension of the state generator
// (percolator-v16-states.ts re-exports it) that writes one engine struct at a time instead of whole accounts. It imports
// only plain modules, so scripts/percolator-v16-reference/kernels.ts can run it under Node.
import { Rng } from "./fuzz-rng.ts";
import { STRUCTS, layout, offsetOf, sizeOf } from "./percolator-v16-layout.ts";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I128_MAX = (1n << 127n) - 1n;

/** A random u128 at most `max` (high bits from two draws). */
function wide(rng: Rng, max: bigint): bigint {
  if (max <= 0n) return 0n;
  const v = (rng.next() << 64n) | rng.next();
  return v % (max + 1n);
}

/** Shared magnitudes: struct fields drawn near the same few values, so that the engine's relations between fields
 * (one counter at most another, two equal) hold or fail by one in a useful share of the states. */
export interface Values {
  magnitudes: bigint[];
}

/** Enum and bool bytes of the engine's structs and their ranges (`decode_*` refuses anything above). */
const ENUM_BYTES: Record<string, number> = {
  lifecycle: 6,
  mode_long: 3,
  mode_short: 3,
  status: 4,
  side: 2,
  active: 2,
  b_stale: 2,
  stale: 2,
  payout_halted: 2,
  finalized: 2,
};

function pooled(rng: Rng, v: Values, max: bigint): bigint {
  const m = rng.pick(v.magnitudes);
  const r = rng.int(10);
  let x = r < 2 ? 0n : r < 5 ? m : r < 6 ? m + 1n : r < 7 ? m - 1n : r < 8 ? wide(rng, m) : r < 9 ? BigInt(rng.int(1000)) : wide(rng, max);
  if (x < 0n) x = 0n;
  return x > max ? max : x;
}

/**
 * The bytes of one value of `struct` (a struct of the layout table): every integer field drawn from `v` at its type's
 * width (signed ones of either sign, never i128::MIN), enum and bool bytes within their range (out of it one time in
 * fifty), keys zero.
 */
export function structBytes(rng: Rng, struct: string, v: Values): Buffer {
  const b = Buffer.alloc(sizeOf(struct));
  const write = (at: number, size: number, value: bigint) => {
    let x = value < 0n ? (1n << BigInt(8 * size)) + value : value;
    for (let i = 0; i < size; i++) {
      b[at + i] = Number(x & 0xffn);
      x >>= 8n;
    }
  };
  const fill = (type: string, base: number) => {
    for (const f of layout(type)) {
      const one = f.size / f.count;
      for (let k = 0; k < f.count; k++) {
        const at = base + f.offset + k * one;
        if (f.type in STRUCTS) {
          fill(f.type, at);
          continue;
        }
        const range = ENUM_BYTES[f.name];
        if (range !== undefined) b[at] = rng.chance(2) ? 255 : rng.int(range);
        else if (f.type === "key") continue;
        else if (f.type === "pi128") {
          const m = pooled(rng, v, I128_MAX);
          write(at, 16, rng.chance(50) ? -m : m);
        } else if (one === 16) write(at, 16, pooled(rng, v, U128_MAX));
        else if (one === 8) write(at, 8, rng.chance(60) ? BigInt(rng.int(20)) : pooled(rng, v, U64_MAX));
        else write(at, one, BigInt(rng.int(1 << Math.min(16, 8 * one))));
      }
    }
  };
  fill(struct, 0);
  return b;
}

/**
 * A `V16ConfigAccount` that `validate_public_user_fund_shape` accepts (the author's default market's limits), with the
 * backing-fee curve drawn at random (its sum over the maximum, or a field broken, now and then).
 */
export function configBytes(rng: Rng): Buffer {
  const b = Buffer.alloc(sizeOf("Config"));
  const put = (path: string, size: number, value: bigint) => {
    const at = offsetOf("Config", path);
    let x = value;
    for (let i = 0; i < size; i++) {
      b[at + i] = Number(x & 0xffn);
      x >>= 8n;
    }
  };
  const base: [string, number, bigint][] = [
    ["max_portfolio_assets", 2, 2n],
    ["max_market_slots", 4, 4n],
    ["min_nonzero_mm_req", 16, 1n],
    ["min_nonzero_im_req", 16, 2n],
    ["h_min", 8, 1n],
    ["h_max", 8, 10n],
    ["maintenance_margin_bps", 8, 500n],
    ["initial_margin_bps", 8, 1000n],
    ["max_trading_fee_bps", 8, 100n],
    ["liquidation_fee_bps", 8, 100n],
    ["liquidation_fee_cap", 16, 1_000_000_000_000n],
    ["min_liquidation_abs", 16, 0n],
    ["max_accrual_dt_slots", 8, 100n],
    ["max_abs_funding_e9_per_slot", 8, 100n],
    ["min_funding_lifetime_slots", 8, 1000n],
    ["max_price_move_bps_per_slot", 8, 100n],
    ["max_account_b_settlement_chunks", 8, 4n],
    ["max_bankrupt_close_chunks", 8, 4n],
    ["max_bankrupt_close_lifetime_slots", 8, 100n],
    ["asset_activation_cooldown_slots", 8, 10n],
    ["public_b_chunk_atoms", 16, 1_000_000_000n],
    ["max_recovery_fallback_deviation_bps", 8, 100n],
    ["backing_freshness_buckets", 1, 1n],
  ];
  for (const [p, s, x] of base) put(p, s, x);
  for (const f of layout("Config")) if (f.size === 1 && f.name !== "backing_freshness_buckets") b[f.offset] = 1;
  const MAX_RATE = 1_000_000_000n;
  const r = () => (rng.chance(10) ? BigInt(rng.int(3)) : rng.chance(10) ? MAX_RATE : BigInt(rng.int(400_000_000)));
  put("backing_fee_base_rate_e9_per_slot", 8, r());
  put("backing_fee_kink_util_bps", 8, BigInt(rng.pick([1, 5000, 9999, 1 + rng.int(9999)])));
  put("backing_fee_slope_at_kink_e9_per_slot", 8, r());
  put("backing_fee_slope_above_kink_e9_per_slot", 8, r());
  if (rng.chance(5)) put("backing_fee_kink_util_bps", 8, rng.chance(50) ? 0n : 10_000n);
  if (rng.chance(3)) b[offsetOf("Config", "source_credit_lien_required")] = rng.int(3) as number;
  return b;
}
