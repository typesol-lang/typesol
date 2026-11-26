// The engine functions of Percolator v16 at commit 7b110913 (engine 5e3af07; aeyakovenko/percolator, Apache-2.0) that
// the settlement of a portfolio's open legs is built from, compared one function at a time: the table both sides
// share (scripts/percolator-v16-reference/kernels/typesol_harness.rs on the original's side,
// fixtures/percolator-v16-kernels.ts on the port's), and the seeded vectors they are run on.
//
// A vector is a function id, eight 16-byte arguments and a 2,020-byte scratch (an engine asset slot, a portfolio leg, a
// portfolio source domain, a resolved-payout ledger and an engine config, at SCRATCH below). The struct values come
// from percolator-v16-states.ts (`structBytes`); the arguments are drawn per function, often from the scratch's own
// values (an amount equal to a field, one atom off, a multiple of BOUND_SCALE) so that both the refusals and the
// successes of each function are reached, at ordinary sizes and at the limits of the types.
import { createHash } from "node:crypto";
import { Rng } from "./fuzz-rng.ts";
import { offsetOf, sizeOf } from "./percolator-v16-layout.ts";
import { type Values, configBytes, structBytes } from "./percolator-v16-values.ts";

/** Where each struct is in the scratch. */
export const SCRATCH = {
  slot: 0,
  leg: 1333,
  source: 1485,
  ledger: 1681,
  config: 1771,
  len: 2020,
} as const;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I128_MAX = (1n << 127n) - 1n;
const BOUND_SCALE = 1_000_000_000_000n;
const ADL_ONE = 1_000_000_000_000_000n;
const SOCIAL_LOSS_DEN = 1_000_000_000_000_000_000_000n;
const CREDIT_RATE_SCALE = 1_000_000_000_000n;
const POS_SCALE = 1_000_000n;

export interface Vector {
  fn: number;
  args: bigint[];
  scratch: Buffer;
}

/** A field of the scratch: `struct` at `base`, `path` inside it. */
function at(scratch: Buffer, base: number, struct: string, path: string, size: number): bigint {
  let v = 0n;
  const o = base + offsetOf(struct, path);
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(scratch[o + i]!);
  return v;
}
const signed = (v: bigint) => (v >= 1n << 127n ? v - (1n << 128n) : v);

/** A value near `ref`: itself, one either side, a fraction of it, zero, or something unrelated. */
function near(rng: Rng, ref: bigint, max = U128_MAX): bigint {
  const r = rng.int(10);
  const v =
    r < 3
      ? ref
      : r === 3
        ? ref + 1n
        : r === 4
          ? ref - 1n
          : r === 5
            ? ref === 0n
              ? 0n
              : ((rng.next() << 64n) | rng.next()) % (ref + 1n)
            : r === 6
              ? 0n
              : r === 7
                ? BigInt(rng.int(1_000_000))
                : r === 8
                  ? (((rng.next() << 64n) | rng.next()) % (ref / BOUND_SCALE + 2n)) * BOUND_SCALE
                  : ((rng.next() << 64n) | rng.next()) & max;
  return v < 0n ? 0n : v > max ? max : v;
}

/** An unsigned value of any scale, at most `max`. */
function any(rng: Rng, max = U128_MAX): bigint {
  switch (rng.int(8)) {
    case 0:
      return 0n;
    case 1:
      return BigInt(1 + rng.int(10));
    case 2:
      return max;
    case 3:
      return max - BigInt(rng.int(3));
    case 4:
      return (BigInt(1 + rng.int(1000)) * BOUND_SCALE) % (max + 1n);
    case 5:
      return BigInt(rng.int(1_000_000_000)) % (max + 1n);
    default:
      return ((rng.next() << 64n) | rng.next()) % (max + 1n);
  }
}

/** A signed value of any scale (never i128::MIN unless asked). */
function anyI(rng: Rng, min = false): bigint {
  if (min && rng.chance(3)) return -(1n << 127n);
  const m = any(rng, I128_MAX);
  return rng.chance(50) ? -m : m;
}

/** A pair (then, now) of K or F values: equal, a small step, an ADL_ONE multiple, or far apart. */
function kPair(rng: Rng): [bigint, bigint] {
  const then = rng.chance(20) ? anyI(rng) : BigInt(rng.int(2_000_000_000)) - 1_000_000_000n;
  const step = rng.pick([0n, 1n, -1n, ADL_ONE, -ADL_ONE, ADL_ONE * BigInt(rng.int(1000)), BigInt(rng.int(1_000_000)) - 500_000n, anyI(rng)]);
  let now = then + step;
  if (now > I128_MAX) now = I128_MAX;
  if (now < -I128_MAX) now = -I128_MAX;
  return [then, now];
}

/** One kernel of the table: id, the engine's name, and how its arguments are drawn. */
interface Kernel {
  id: number;
  name: string;
  args: (rng: Rng, s: Buffer) => bigint[];
}

const slotField = (s: Buffer, path: string, size = 16) => at(s, SCRATCH.slot, "EngineAssetSlot", path, size);
function writeSlot(s: Buffer, path: string, size: number, v: bigint): void {
  for (let i = 0; i < size; i++) s[SCRATCH.slot + offsetOf("EngineAssetSlot", path) + i] = Number((v >> BigInt(8 * i)) & 0xffn);
}
const legField = (s: Buffer, path: string, size = 16) => at(s, SCRATCH.leg, "PortfolioLeg", path, size);

export const KERNELS: Kernel[] = [
  {
    id: 0,
    name: "apply_backing_utilization_fee_charge",
    args: (rng) => {
      const cap = any(rng);
      return [cap, near(rng, cap), any(rng), rng.chance(20) ? -any(rng, I128_MAX) : any(rng, I128_MAX), near(rng, cap)];
    },
  },
  { id: 1, name: "V16Core::mul_div_floor_u128_or_wide", args: (rng) => [any(rng), any(rng), rng.chance(5) ? 0n : any(rng)] },
  { id: 2, name: "V16Core::mul_div_ceil_u128_or_wide", args: (rng) => [any(rng), any(rng), rng.chance(5) ? 0n : any(rng)] },
  {
    id: 3,
    name: "V16Core::source_credit_lien_amounts_for_effective",
    args: (rng) => [any(rng), rng.pick([0n, CREDIT_RATE_SCALE, CREDIT_RATE_SCALE + 1n, any(rng, CREDIT_RATE_SCALE), any(rng)])],
  },
  {
    id: 4,
    name: "V16Core::source_lien_backing_release_for_face_burn",
    args: (rng) => {
      const face = any(rng);
      const backing = rng.chance(70) ? (near(rng, face) / BOUND_SCALE) * BOUND_SCALE : any(rng);
      return [face, backing, near(rng, face)];
    },
  },
  {
    id: 5,
    name: "V16Core::source_lien_fee_after_backing_release",
    args: (rng) => {
      const before = any(rng);
      return [any(rng), before, near(rng, before)];
    },
  },
  {
    id: 6,
    name: "V16Core::source_lien_face_burn_partition",
    args: (rng) => {
      const c = any(rng);
      const i = any(rng);
      return [c, i, near(rng, c + i > U128_MAX ? c : c + i)];
    },
  },
  {
    id: 7,
    name: "V16Core::source_lien_face_burn_plan",
    args: (rng) => {
      const c = any(rng, U128_MAX >> 1n);
      const i = any(rng, U128_MAX >> 1n);
      const cb = rng.chance(80) ? (near(rng, c) / BOUND_SCALE) * BOUND_SCALE : any(rng);
      const ib = rng.chance(80) ? (near(rng, i) / BOUND_SCALE) * BOUND_SCALE : any(rng);
      return [c, i, cb, ib, near(rng, c + i)];
    },
  },
  {
    id: 8,
    name: "V16Core::crystallize_source_lien_fee_for_effective",
    args: (rng, s) => [near(rng, at(s, SCRATCH.source, "PortfolioSourceDomain", "source_lien_effective_reserved", 16))],
  },
  {
    id: 9,
    name: "V16Core::kernel_settle_kf_stale_cohort",
    args: (rng, s) => {
      const side = rng.pick([0n, 1n, 1n, 0n, 2n]);
      const epoch = slotField(s, side === 1n ? "asset.kf_epoch_short" : "asset.kf_epoch_long", 8);
      return [side, near(rng, epoch, U64_MAX)];
    },
  },
  {
    id: 10,
    name: "V16Core::prepare_source_credit_domain_recompute_for_epoch_steps",
    args: (rng) => [any(rng, U64_MAX), rng.pick([0n, 1n, 1n, 2n, any(rng, U64_MAX)])],
  },
  {
    id: 11,
    name: "V16Core::prepare_source_positive_claim_burn_delta",
    args: (rng, s) => [near(rng, slotField(s, "source_credit_long.positive_claim_bound_num"))],
  },
  {
    id: 12,
    name: "V16Core::source_claim_domain_first_burn_partition",
    args: (rng) => {
      const c = any(rng);
      return [c, near(rng, c)];
    },
  },
  {
    id: 13,
    name: "V16Core::kernel_settle_positive_face_after_support",
    args: (rng) => {
      const face = rng.chance(10) ? any(rng) : any(rng, I128_MAX);
      return [face, near(rng, face), rng.chance(10) ? any(rng) : near(rng, face, I128_MAX)];
    },
  },
  { id: 14, name: "V16Core::kernel_recompute_resolved_payout_rate", args: () => [] },
  { id: 15, name: "V16Core::kernel_credit_post_snapshot_residual", args: (rng) => [any(rng), any(rng)] },
  {
    id: 16,
    name: "V16Core::kernel_advance_leg_b_snap",
    args: (rng, s) => [near(rng, U128_MAX - legField(s, "b_snap")), any(rng), rng.pick([0n, 0n, any(rng)])],
  },
  {
    id: 17,
    name: "V16Core::kernel_normalize_social_loss_carry",
    args: (rng) => [near(rng, SOCIAL_LOSS_DEN - 1n), near(rng, SOCIAL_LOSS_DEN - 1n), rng.chance(20) ? U128_MAX : any(rng)],
  },
  { id: 18, name: "V16Core::kernel_begin_full_drain_reset", args: (rng) => [rng.pick([0n, 1n, 0n, 1n, 3n])] },
  {
    id: 19,
    name: "V16Core::prepare_counterparty_lien_create_delta",
    args: (rng, s) => [near(rng, slotField(s, "backing_long.expiry_slot", 8), U64_MAX), near(rng, slotField(s, "backing_long.fresh_unliened_backing_num"))],
  },
  {
    id: 20,
    name: "V16Core::prepare_counterparty_backing_add_delta",
    args: (rng, s) => {
      // The deposit's preconditions met often: the bucket's status, the receivable equal to the consumed backing and
      // within the spent backing (the scratch is changed here, before the vector is recorded).
      const statusAt = SCRATCH.slot + offsetOf("EngineAssetSlot", "backing_long.status");
      if (rng.chance(70)) s[statusAt] = rng.pick([0, 1, 2, 1]);
      const receivable = slotField(s, "source_credit_long.provider_receivable_num");
      if (rng.chance(70)) {
        writeSlot(s, "backing_long.consumed_liened_backing_num", 16, receivable);
        if (slotField(s, "source_credit_long.spent_backing_num") < receivable) writeSlot(s, "source_credit_long.spent_backing_num", 16, receivable);
      }
      const expiry = slotField(s, "backing_long.expiry_slot", 8);
      const slot = rng.chance(70) && expiry > 0n ? expiry - 1n - BigInt(rng.int(Number(expiry > 1000n ? 1000n : expiry))) : near(rng, expiry, U64_MAX);
      return [near(rng, receivable), slot < 0n ? 0n : slot, rng.chance(60) ? expiry : any(rng, U64_MAX)];
    },
  },
  {
    id: 21,
    name: "V16Core::prepare_counterparty_backing_expiry_delta",
    args: (rng, s) => {
      // A Fresh bucket most of the time (the scratch is changed here, before the vector is recorded).
      if (rng.chance(70)) s[SCRATCH.slot + offsetOf("EngineAssetSlot", "backing_long.status")] = 1;
      return [near(rng, slotField(s, "backing_long.expiry_slot", 8), U64_MAX)];
    },
  },
  {
    id: 22,
    name: "V16Core::prepare_counterparty_lien_terminal_release_delta",
    args: (rng, s) => [near(rng, slotField(s, "backing_long.valid_liened_backing_num"))],
  },
  { id: 23, name: "V16Core::prepare_counterparty_lien_consume_delta", args: (rng, s) => [near(rng, slotField(s, "backing_long.valid_liened_backing_num"))] },
  {
    id: 24,
    name: "V16Core::prepare_insurance_lien_consume_delta",
    args: (rng, s) => {
      const amount = near(rng, slotField(s, "insurance_reservation_long.valid_liened_insurance_num"));
      return [any(rng), near(rng, amount / BOUND_SCALE + 1n), amount];
    },
  },
  {
    id: 25,
    name: "V16Core::prepare_insurance_lien_create_delta",
    args: (rng, s) => [near(rng, slotField(s, "insurance_reservation_long.insurance_credit_reserved_num"))],
  },
  {
    id: 26,
    name: "V16Core::prepare_insurance_lien_release_delta",
    args: (rng, s) => [near(rng, slotField(s, "insurance_reservation_long.valid_liened_insurance_num"))],
  },
  {
    id: 27,
    name: "V16Core::prepare_insurance_lien_terminal_release_delta",
    args: (rng, s) => [near(rng, slotField(s, "insurance_reservation_long.insurance_credit_reserved_num"))],
  },
  {
    id: 28,
    name: "V16Core::source_credit_state_realizable_support_for_claim_num",
    args: (rng, s) => [near(rng, slotField(s, "source_credit_long.positive_claim_bound_num"))],
  },
  { id: 29, name: "V16Core::backing_utilization_rate_e9_for_source_state", args: () => [] },
  {
    id: 30,
    name: "V16Core::backing_utilization_fee_quote_atoms_for_lien",
    args: (rng, s) => {
      const from = any(rng, U64_MAX);
      return [near(rng, slotField(s, "source_credit_long.valid_liened_backing_num")), from, near(rng, from + BigInt(rng.int(1_000_000)), U64_MAX)];
    },
  },
  {
    id: 31,
    name: "account_kf_settlement_plan_key",
    args: (rng) => [
      rng.pick([0n, 1n, 1n, 2n, 255n]),
      rng.pick([0n, BigInt(rng.int(64)), 0x1_ffff_ffffn, 0x2_0000_0000n, any(rng, U64_MAX)]),
      rng.pick([0n, BigInt(rng.int(16)), 15n, 16n]),
    ],
  },
  {
    id: 32,
    name: "decode_account_kf_settlement_plan_key",
    args: (rng) => [rng.pick([BigInt(rng.int(1 << 20)), (1n << 38n) - 1n, 1n << 38n, (1n << 37n) | BigInt(rng.int(1 << 20)), any(rng, U64_MAX)])],
  },
  {
    id: 33,
    name: "scaled_adl_delta_fast",
    args: (rng) => {
      const [then, now] = kPair(rng);
      return [
        rng.pick([0n, BigInt(rng.int(1_000_000_000)), any(rng, 100_000_000_000_000n), any(rng)]),
        rng.pick([ADL_ONE, ADL_ONE, any(rng, ADL_ONE)]),
        then,
        now,
      ];
    },
  },
  {
    id: 34,
    name: "f_snap_after_settlement",
    args: (rng) => {
      const [snap, now] = kPair(rng);
      const abs = rng.pick([0n, BigInt(1 + rng.int(1_000_000_000)), any(rng, 100_000_000_000_000n), any(rng)]);
      const a = rng.pick([ADL_ONE, any(rng, ADL_ONE), any(rng)]);
      // The delta the settlement would compute (floor(abs · (now − snap) / (a · POS_SCALE))), or something near it.
      const den = a * POS_SCALE;
      const exact = den === 0n ? 0n : (abs * (now - snap)) / den - ((abs * (now - snap)) % den < 0n ? 1n : 0n);
      const delta = rng.chance(75) && exact <= I128_MAX && exact >= -I128_MAX ? exact : anyI(rng);
      return [abs, a, snap, now, delta];
    },
  },
  {
    id: 35,
    name: "f_snap_residual_is_sub_atom",
    args: (rng) => {
      const [snap, target] = kPair(rng);
      return [rng.pick([0n, BigInt(1 + rng.int(1_000_000)), any(rng)]), rng.pick([ADL_ONE, any(rng, ADL_ONE), any(rng)]), snap, target];
    },
  },
  {
    id: 36,
    name: "MarketGroupV16ViewMut::haircut_effective_support",
    args: (rng) => {
      const junior = any(rng);
      return [any(rng), near(rng, junior), junior];
    },
  },
  {
    id: 37,
    name: "asset_is_loss_stale_at_slot (with asset_contributes_to_loss_stale_summary)",
    args: (rng, s) => [near(rng, slotField(s, "asset.slot_last", 8), U64_MAX)],
  },
  { id: 38, name: "MarketGroupV16ViewMut::kf_target_for_leg_from_asset", args: () => [] },
  { id: 39, name: "MarketGroupV16ViewMut::b_target_for_leg_from_asset", args: () => [] },
  { id: 40, name: "MarketGroupV16ViewMut::leg_kf_delta_components_for_settlement_from_asset", args: () => [] },
  {
    id: 41,
    name: "MarketGroupV16ViewMut::account_b_settlement_chunk_from_leg",
    args: (rng, s) => [
      near(rng, legField(s, "b_snap") + BigInt(rng.int(1_000_000))),
      rng.pick([0n, any(rng), BigInt(1 + rng.int(1_000_000))]),
      rng.pick([1n, BigInt(1 + rng.int(1_000_000_000)), any(rng)]),
    ],
  },
  { id: 42, name: "MarketGroupV16ViewMut::leg_has_exhausted_effective_oi", args: () => [] },
  {
    id: 43,
    name: "wide_signed_mul_div_floor_from_k_pair (wide_math.rs)",
    args: (rng) => {
      const [then, now] = rng.chance(20) ? [anyI(rng, true), anyI(rng, true)] : kPair(rng);
      return [any(rng), then, now, rng.chance(3) ? 0n : any(rng)];
    },
  },
  { id: 44, name: "floor_div_signed_conservative_i128 (wide_math.rs)", args: (rng) => [anyI(rng, true), rng.chance(3) ? 0n : any(rng)] },
];

/** The scratch of one vector: correlated values (a few magnitudes shared between fields), valid enum bytes mostly. */
export function scratch(rng: Rng): Buffer {
  const b = Buffer.alloc(SCRATCH.len);
  const pool: Values = { magnitudes: [any(rng), any(rng, 1_000_000_000_000_000_000n), BigInt(rng.int(1_000_000)) * BOUND_SCALE] };
  structBytes(rng, "EngineAssetSlot", pool).copy(b, SCRATCH.slot);
  structBytes(rng, "PortfolioLeg", pool).copy(b, SCRATCH.leg);
  structBytes(rng, "PortfolioSourceDomain", pool).copy(b, SCRATCH.source);
  structBytes(rng, "ResolvedPayoutLedger", pool).copy(b, SCRATCH.ledger);
  configBytes(rng).copy(b, SCRATCH.config);
  // The leg's epochs bound to its side's, or one behind, now and then (what the K/F and B targets look at).
  const side = b[SCRATCH.leg + offsetOf("PortfolioLeg", "side")]! === 1 ? "short" : "long";
  const epoch = slotField(b, `asset.epoch_${side}`, 8);
  for (const f of ["epoch_snap", "b_epoch_snap"]) {
    const r = rng.int(10);
    const v = r < 5 ? epoch : r < 8 ? epoch - 1n : legField(b, f, 8);
    b.writeBigUInt64LE(v < 0n ? 0n : v, SCRATCH.leg + offsetOf("PortfolioLeg", f));
  }
  if (rng.chance(40)) b[SCRATCH.slot + offsetOf("EngineAssetSlot", `asset.mode_${side}`)] = 2;
  const put = (path: string, size: number, v: bigint) => {
    for (let i = 0; i < size; i++) b[SCRATCH.slot + offsetOf("EngineAssetSlot", path) + i] = Number((v >> BigInt(8 * i)) & 0xffn);
  };
  // Half the source credit states made shape-valid (what `validate_source_credit_state_shape_static` asks: insurance
  // amounts atom-aligned, the exact claim within the bound, the rate within the scale, the receivable within the spent
  // backing, the liens within their reserves), most of those with the rate the state implies.
  if (rng.chance(50)) {
    const sc = (f: string) => slotField(b, `source_credit_long.${f}`);
    const align = (v: bigint) => (v / BOUND_SCALE) * BOUND_SCALE;
    const fresh = sc("fresh_reserved_backing_num");
    put("source_credit_long.valid_liened_backing_num", 16, near(rng, fresh) > fresh ? fresh : near(rng, fresh));
    const reserved = align(sc("insurance_credit_reserved_num") >> 2n);
    const validIns = align(reserved === 0n ? 0n : ((rng.next() << 64n) | rng.next()) % (reserved + 1n));
    const impairedIns = align(reserved - validIns === 0n ? 0n : ((rng.next() << 64n) | rng.next()) % (reserved - validIns + 1n));
    put("source_credit_long.insurance_credit_reserved_num", 16, reserved);
    put("source_credit_long.valid_liened_insurance_num", 16, validIns);
    put("source_credit_long.impaired_liened_insurance_num", 16, impairedIns);
    const bound = sc("positive_claim_bound_num");
    put("source_credit_long.exact_positive_claim_num", 16, sc("exact_positive_claim_num") > bound ? bound : sc("exact_positive_claim_num"));
    const spent = sc("spent_backing_num");
    put("source_credit_long.provider_receivable_num", 16, sc("provider_receivable_num") > spent ? spent : sc("provider_receivable_num"));
    put("source_credit_long.credit_rate_num", 16, rng.chance(70) ? expectedRate(b) : any(rng, CREDIT_RATE_SCALE));
  }
  // The bucket's consumed backing equal to the source's receivable (what a deposit into the bucket needs), often.
  if (rng.chance(50)) put("backing_long.consumed_liened_backing_num", 16, slotField(b, "source_credit_long.provider_receivable_num"));
  // The leg's side drainable (no effective OI, nothing pending, carries below one atom), often.
  if (rng.chance(40)) {
    put(`asset.oi_eff_${side}_q`, 16, 0n);
    put(`asset.pending_obligation_count_${side}`, 8, 0n);
    put(`asset.social_loss_remainder_${side}_num`, 16, near(rng, SOCIAL_LOSS_DEN - 1n) % SOCIAL_LOSS_DEN);
    put(`asset.social_loss_dust_${side}_num`, 16, near(rng, SOCIAL_LOSS_DEN - 1n) % SOCIAL_LOSS_DEN);
    if (rng.chance(70)) b[SCRATCH.slot + offsetOf("EngineAssetSlot", `asset.mode_${side}`)] = rng.int(2);
  }
  return b;
}

/** The credit rate a shape-valid source credit state implies (`expected_source_credit_rate_num_for_state`). */
function expectedRate(b: Buffer): bigint {
  const sc = (f: string) => slotField(b, `source_credit_long.${f}`);
  if (sc("positive_claim_bound_num") === 0n) return CREDIT_RATE_SCALE;
  const available =
    sc("fresh_reserved_backing_num") -
    sc("valid_liened_backing_num") +
    sc("insurance_credit_reserved_num") -
    sc("valid_liened_insurance_num") -
    sc("impaired_liened_insurance_num");
  if (available <= 0n) return 0n;
  const covered = sc("valid_liened_backing_num") + sc("valid_liened_insurance_num");
  const unliened = sc("positive_claim_bound_num") > covered ? sc("positive_claim_bound_num") - covered : 0n;
  if (available >= unliened) return CREDIT_RATE_SCALE;
  return (available * CREDIT_RATE_SCALE) / unliened;
}

/** `count` vectors of every kernel, from `seed`. */
export function vectors(seed: bigint, count: number): Vector[] {
  const rng = new Rng(seed);
  const out: Vector[] = [];
  for (const k of KERNELS)
    for (let i = 0; i < count; i++) {
      const s = scratch(rng);
      const args = k.args(rng, s).map((v) => (v < 0n ? (1n << 128n) + v : v) & U128_MAX);
      while (args.length < 8) args.push(0n);
      out.push({ fn: k.id, args, scratch: s });
    }
  return out;
}

/** The host program's input (typesol_kernels.rs): count, then each vector. */
export function vectorInput(vs: Vector[]): Buffer {
  const parts: Buffer[] = [];
  const n = Buffer.alloc(4);
  n.writeUInt32LE(vs.length);
  parts.push(n);
  for (const v of vs) {
    const head = Buffer.alloc(1 + 8 * 16 + 4);
    head[0] = v.fn;
    v.args.forEach((a, i) => {
      for (let j = 0; j < 16; j++) head[1 + i * 16 + j] = Number((a >> BigInt(8 * j)) & 0xffn);
    });
    head.writeUInt32LE(v.scratch.length, 1 + 8 * 16);
    parts.push(head, v.scratch);
  }
  return Buffer.concat(parts);
}

export function vectorDigest(vs: Vector[]): string {
  return createHash("sha256").update(vectorInput(vs)).digest("hex");
}

export const kernelName = (id: number) => KERNELS.find((k) => k.id === id)!.name;
export { signed, sizeOf };
