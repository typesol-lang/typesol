// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): the wire conversions of aeyakovenko/percolator
// src/v16.rs, Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL. Ported: the `*Account::try_to_runtime`
// decoders and `decode_bool`, `decode_side`, `decode_side_mode`, `decode_asset_lifecycle`, `decode_market_mode`,
// `decode_backing_bucket_status`, `decode_recovery_reason`, `validate_non_min_i128`.
//
// The engine stores integers as byte arrays (`V16PodU64 { bytes: [u8; 8] }`): `get` is `u64::from_le_bytes` and `new`
// is `to_le_bytes`, so in the packed structs of state.ts they are plain integer fields, read and written as they are.
// What the conversion to the engine's runtime types adds is validation: enum and bool bytes must name a variant and
// some signed fields must not be i128::MIN. Each `…Err` function below makes the checks of one `try_to_runtime` in the
// order the original evaluates them (the fields of a struct literal in order, then the checks after it) and returns the
// first failure as a V16Error code (errors.ts; 0 when the bytes convert). The callers map it as the original does at
// each site: `map_account_wire_error` (always InvalidAccountData) in `mod state`, `map_v16_error` in the processor.
//
// Not here, because they are engine logic ported with the code that needs them (NOTES.md): the checks after decoding
// in `V16ConfigAccount::try_to_runtime` (`validate_exact_solvency_envelope`, wide arithmetic),
// `SourceCreditStateV16Account::try_to_runtime` (`validate_source_credit_state_static`, the expected credit rate) and
// `PortfolioLegV16Account::try_to_runtime` for an active leg (`validate_active_leg`).
//
// The instruction data's signed integers (`read_i64`, `read_i128`: `i64::from_le_bytes`, `i128::from_le_bytes`) are
// read with the v12.20 port's `readI64` / `readI128` (showcase/mainnet/percolator/wire.ts), imported from there as they
// are (TypeSOL names are program-wide, so they are not redefined here): that file and the v12.20 binary are unchanged.
import { type i128, type u8, type u64, type u128, u64 as toU64 } from "typesol";
import {
  type AssetState,
  type BackingBucket,
  type CloseProgressLedger,
  type Config,
  type HealthCert,
  type InsuranceCreditReservation,
  type OptionalRecoveryReason,
  type PortfolioLeg,
  type ProvenanceHeader,
  type ResolvedPayoutLedger,
  type ResolvedPayoutReceipt,
} from "./state.js";
import { V16_ARITHMETIC_OVERFLOW, V16_HIDDEN_LEG, V16_INVALID_CONFIG, V16_OK, V16_PROVENANCE_MISMATCH } from "./errors.js";

// ---- Enum and bool bytes --------------------------------------------------------------------------------------------

/** `V16_LAYOUT_DISCRIMINATOR` and `V16_ACCOUNT_VERSION` (engine src/v16.rs). */
export const V16_LAYOUT_DISCRIMINATOR = 18n;
export const V16_ACCOUNT_VERSION = 1n;
/** i128::MIN, which `validate_non_min_i128` refuses. */
export const I128_MIN = -0x80000000000000000000000000000000n;

/** `decode_bool`: 0 or 1. */
export function boolErr(v: u8): u64 {
  return v <= 1n ? V16_OK : V16_INVALID_CONFIG;
}
/** `decode_side`: Long 0, Short 1. */
export function sideErr(v: u8): u64 {
  return v <= 1n ? V16_OK : V16_INVALID_CONFIG;
}
/** `decode_side_mode`: Normal 0, DrainOnly 1, ResetPending 2. */
export function sideModeErr(v: u8): u64 {
  return v <= 2n ? V16_OK : V16_INVALID_CONFIG;
}
/** `decode_asset_lifecycle`: Disabled 0, PendingActivation 1, Active 2, DrainOnly 3, Retired 4, Recovery 5. */
export function assetLifecycleErr(v: u8): u64 {
  return v <= 5n ? V16_OK : V16_INVALID_CONFIG;
}
/** The engine's `decode_market_mode`: Live 0, Resolved 1, Recovery 2. */
export function marketModeErr(v: u8): u64 {
  return v <= 2n ? V16_OK : V16_INVALID_CONFIG;
}
/** `decode_backing_bucket_status`: Empty 0, Fresh 1, Expired 2, Impaired 3. */
export function backingBucketStatusErr(v: u8): u64 {
  return v <= 3n ? V16_OK : V16_INVALID_CONFIG;
}
/** `decode_recovery_reason`: the eight PermissionlessRecoveryReasonV16 variants, 0 to 7. */
export function recoveryReasonErr(v: u8): u64 {
  return v <= 7n ? V16_OK : V16_INVALID_CONFIG;
}
/** `validate_non_min_i128`. */
export function nonMinI128Err(v: i128): u64 {
  return v === I128_MIN ? V16_ARITHMETIC_OVERFLOW : V16_OK;
}

// ---- try_to_runtime, struct by struct -------------------------------------------------------------------------------

/** `V16OptionalRecoveryReasonAccount::try_to_runtime`: absent (both bytes 0) or present (1) with a valid reason. */
export function optionalRecoveryReasonErr(r: OptionalRecoveryReason): u64 {
  if (r.present === 0n && r.value === 0n) return V16_OK;
  if (r.present === 1n) return recoveryReasonErr(r.value);
  return V16_INVALID_CONFIG;
}

/** `ProvenanceHeaderV16Account::try_to_runtime`: the version and the layout discriminator. */
export function provenanceHeaderErr(h: ProvenanceHeader): u64 {
  if (h.version !== V16_ACCOUNT_VERSION || h.layout_discriminator !== V16_LAYOUT_DISCRIMINATOR) return V16_PROVENANCE_MISMATCH;
  return V16_OK;
}

/**
 * `V16ConfigAccount::decode_runtime`: the ten bool bytes in order (`backing_freshness_buckets` is a plain u8). Both
 * `try_to_runtime` and `try_to_runtime_shape` start with it; `configShapeErr` adds the shape check.
 */
export function configDecodeErr(c: Config): u64 {
  // Every refusal is the same InvalidConfig, so the order of the ten does not show.
  if (
    c.margin_mode_realizable_full_shared_cross_margin > 1n ||
    c.source_credit_lien_required > 1n ||
    c.insurance_credit_reservation_required > 1n ||
    c.permissionless_recovery_enabled > 1n ||
    c.recovery_fallback_price_enabled > 1n ||
    c.recovery_fallback_envelope_enabled > 1n ||
    c.credit_lien_revalidation_required > 1n ||
    c.stale_certificate_penalty_enabled > 1n ||
    c.full_refresh_required_for_favorable_actions > 1n ||
    c.public_liveness_profile_crank_forward > 1n
  )
    return V16_INVALID_CONFIG;
  return V16_OK;
}

/** Engine constants `validate_public_user_fund_shape` uses (src/v16.rs). */
export const V16_MAX_PORTFOLIO_ASSETS_N = 16n;
export const MAX_MARGIN_BPS = 10000n;
export const MAX_PROTOCOL_FEE_ABS = 1000000000000000000000000000000000000n;
export const MAX_RECOVERY_FALLBACK_DEVIATION_BPS = 10000n;
export const MAX_BACKING_FEE_UTIL_BPS = 10000n;
export const MAX_BACKING_FEE_RATE_E9_PER_SLOT = 1000000000n;
export const V16_BACKING_BUCKETS_PER_DOMAIN = 1n;

/**
 * `V16ConfigAccount::try_to_runtime_shape`: `decode_runtime`, then `V16Config::validate_public_user_fund_shape`, every
 * refusal InvalidConfig. (`try_to_runtime` then adds `validate_exact_solvency_envelope`, ported with InitMarket.)
 */
export function configShapeErr(c: Config): u64 {
  const d = configDecodeErr(c);
  if (d !== V16_OK) return d;
  if (
    c.max_portfolio_assets === 0n ||
    c.max_portfolio_assets > V16_MAX_PORTFOLIO_ASSETS_N ||
    c.max_market_slots === 0n ||
    toU64(c.max_portfolio_assets) > toU64(c.max_market_slots)
  )
    return V16_INVALID_CONFIG;
  if (c.h_max === 0n || c.h_min > c.h_max) return V16_INVALID_CONFIG;
  if (c.min_nonzero_mm_req === 0n || c.min_nonzero_mm_req >= c.min_nonzero_im_req) return V16_INVALID_CONFIG;
  if (
    c.maintenance_margin_bps > c.initial_margin_bps ||
    c.initial_margin_bps > MAX_MARGIN_BPS ||
    c.max_trading_fee_bps > MAX_MARGIN_BPS ||
    c.liquidation_fee_bps > MAX_MARGIN_BPS ||
    c.min_liquidation_abs > c.liquidation_fee_cap ||
    c.liquidation_fee_cap > MAX_PROTOCOL_FEE_ABS ||
    c.max_accrual_dt_slots === 0n ||
    c.min_funding_lifetime_slots < c.max_accrual_dt_slots ||
    c.max_abs_funding_e9_per_slot > 10000n ||
    c.max_price_move_bps_per_slot === 0n ||
    c.max_account_b_settlement_chunks === 0n ||
    c.max_bankrupt_close_chunks === 0n ||
    c.max_bankrupt_close_lifetime_slots === 0n ||
    c.asset_activation_cooldown_slots === 0n ||
    c.public_b_chunk_atoms === 0n ||
    c.max_recovery_fallback_deviation_bps > MAX_RECOVERY_FALLBACK_DEVIATION_BPS ||
    c.backing_fee_kink_util_bps === 0n ||
    c.backing_fee_kink_util_bps >= MAX_BACKING_FEE_UTIL_BPS ||
    c.backing_freshness_buckets === 0n ||
    c.backing_freshness_buckets > V16_BACKING_BUCKETS_PER_DOMAIN
  )
    return V16_INVALID_CONFIG;
  // `a.checked_add(b).and_then(|v| v.checked_add(c)).ok_or(InvalidConfig)? > MAX`: an overflow is InvalidConfig too.
  const m = 0xffffffffffffffffn;
  const base = c.backing_fee_base_rate_e9_per_slot;
  const atKink = c.backing_fee_slope_at_kink_e9_per_slot;
  const above = c.backing_fee_slope_above_kink_e9_per_slot;
  if (base > m - atKink) return V16_INVALID_CONFIG;
  if (base + atKink > m - above) return V16_INVALID_CONFIG;
  if (base + atKink + above > MAX_BACKING_FEE_RATE_E9_PER_SLOT) return V16_INVALID_CONFIG;
  // Every bool must be true (decode_runtime has already refused anything but 0 and 1).
  if (
    c.margin_mode_realizable_full_shared_cross_margin === 0n ||
    c.source_credit_lien_required === 0n ||
    c.insurance_credit_reservation_required === 0n ||
    c.permissionless_recovery_enabled === 0n ||
    c.recovery_fallback_price_enabled === 0n ||
    c.recovery_fallback_envelope_enabled === 0n ||
    c.credit_lien_revalidation_required === 0n ||
    c.stale_certificate_penalty_enabled === 0n ||
    c.full_refresh_required_for_favorable_actions === 0n ||
    c.public_liveness_profile_crank_forward === 0n
  )
    return V16_INVALID_CONFIG;
  return V16_OK;
}

/** `AssetStateV16Account::try_to_runtime`: the lifecycle and both side modes, then eight K/F fields not i128::MIN. */
export function assetStateErr(a: AssetState): u64 {
  let e = assetLifecycleErr(a.lifecycle);
  if (e === V16_OK) e = sideModeErr(a.mode_long);
  if (e === V16_OK) e = sideModeErr(a.mode_short);
  if (e === V16_OK) e = nonMinI128Err(a.k_long);
  if (e === V16_OK) e = nonMinI128Err(a.k_short);
  if (e === V16_OK) e = nonMinI128Err(a.f_long_num);
  if (e === V16_OK) e = nonMinI128Err(a.f_short_num);
  if (e === V16_OK) e = nonMinI128Err(a.k_epoch_start_long);
  if (e === V16_OK) e = nonMinI128Err(a.k_epoch_start_short);
  if (e === V16_OK) e = nonMinI128Err(a.f_epoch_start_long_num);
  if (e === V16_OK) e = nonMinI128Err(a.f_epoch_start_short_num);
  return e;
}

/** `BOUND_SCALE` (engine src/lib.rs). */
export const BOUND_SCALE = 1000000000000n;
/** `ADL_ONE` (engine src/lib.rs): the `a_basis` of an empty leg. */
export const ADL_ONE = 1000000000000000n;
const U128_MAX = 0xffffffffffffffffffffffffffffffffn;

/**
 * `BackingBucketV16Account::try_to_runtime`: the status byte, then `V16Core::validate_backing_bucket_static` (the
 * amounts each status allows).
 */
export function backingBucketErr(b: BackingBucket): u64 {
  const s = b.status;
  if (backingBucketStatusErr(s) !== V16_OK) return V16_INVALID_CONFIG;
  if (s === 0n) {
    // Empty: `is_empty_amount_shape`.
    if (
      b.fresh_unliened_backing_num !== 0n ||
      b.valid_liened_backing_num !== 0n ||
      b.consumed_liened_backing_num !== 0n ||
      b.impaired_liened_backing_num !== 0n ||
      b.utilization_fee_earnings !== 0n ||
      b.expiry_slot !== 0n
    )
      return V16_INVALID_CONFIG;
  } else if (s === 1n) {
    // Fresh: `fresh + valid` checked (ArithmeticOverflow), nonzero.
    if (b.market_id === 0n || b.expiry_slot === 0n) return V16_INVALID_CONFIG;
    if (b.fresh_unliened_backing_num > U128_MAX - b.valid_liened_backing_num) return V16_ARITHMETIC_OVERFLOW;
    if (b.fresh_unliened_backing_num + b.valid_liened_backing_num === 0n) return V16_INVALID_CONFIG;
  } else if (s === 2n) {
    // Expired.
    if (b.market_id === 0n || b.fresh_unliened_backing_num !== 0n || b.valid_liened_backing_num !== 0n || b.impaired_liened_backing_num !== 0n)
      return V16_INVALID_CONFIG;
  } else if (b.market_id === 0n || b.fresh_unliened_backing_num !== 0n || b.valid_liened_backing_num !== 0n || b.impaired_liened_backing_num === 0n) {
    // Impaired.
    return V16_INVALID_CONFIG;
  }
  return V16_OK;
}

/** `V16Core::validate_bound_num_atom_aligned`. */
function boundAlignedErr(n: u128): u64 {
  return n === 0n || n % BOUND_SCALE === 0n ? V16_OK : V16_INVALID_CONFIG;
}

/**
 * `InsuranceCreditReservationV16Account::try_to_runtime`: `V16Core::validate_insurance_reservation_static`. The
 * all-zero reservation (`EMPTY`) is valid; otherwise three amounts atom-aligned and the reservation covering the
 * encumbered amount.
 */
export function insuranceReservationErr(r: InsuranceCreditReservation): u64 {
  if (
    r.insurance_credit_reserved_num === 0n &&
    r.valid_liened_insurance_num === 0n &&
    r.impaired_liened_insurance_num === 0n &&
    r.consumed_insurance_num === 0n &&
    r.source_credit_epoch === 0n
  )
    return V16_OK;
  let e = boundAlignedErr(r.insurance_credit_reserved_num);
  if (e === V16_OK) e = boundAlignedErr(r.valid_liened_insurance_num);
  if (e === V16_OK) e = boundAlignedErr(r.impaired_liened_insurance_num);
  if (e !== V16_OK) return e;
  if (r.valid_liened_insurance_num > U128_MAX - r.impaired_liened_insurance_num) return V16_ARITHMETIC_OVERFLOW;
  if (r.insurance_credit_reserved_num < r.valid_liened_insurance_num + r.impaired_liened_insurance_num) return V16_INVALID_CONFIG;
  return V16_OK;
}

/**
 * `PortfolioLegV16Account::try_to_runtime`, its decoding: `active`, `side`, `b_stale`, `stale`, then an inactive leg
 * must be `is_empty` (HiddenLeg). An active leg's `validate_active_leg` is engine logic, not ported here: this returns
 * V16_OK for an active leg whose bytes decode, and the caller adds that check where it is ported.
 */
export function portfolioLegDecodeErr(l: PortfolioLeg): u64 {
  let e = boolErr(l.active);
  if (e === V16_OK) e = sideErr(l.side);
  if (e === V16_OK) e = boolErr(l.b_stale);
  if (e === V16_OK) e = boolErr(l.stale);
  if (e !== V16_OK) return e;
  if (l.active === 1n) return V16_OK;
  // PortfolioLegV16::is_empty: the EMPTY leg (every field zero but `a_basis`, which is ADL_ONE; side Long).
  if (
    l.asset_index !== 0n ||
    l.market_id !== 0n ||
    l.side !== 0n ||
    l.basis_pos_q !== 0n ||
    l.a_basis !== ADL_ONE ||
    l.k_snap !== 0n ||
    l.f_snap !== 0n ||
    l.kf_epoch_snap !== 0n ||
    l.epoch_snap !== 0n ||
    l.loss_weight !== 0n ||
    l.b_snap !== 0n ||
    l.b_rem !== 0n ||
    l.b_epoch_snap !== 0n ||
    l.b_stale !== 0n ||
    l.stale !== 0n
  )
    return V16_HIDDEN_LEG;
  return V16_OK;
}

/** `HealthCertV16Account::try_to_runtime`: `valid` a bool, then the certified equity not i128::MIN. */
export function healthCertErr(h: HealthCert): u64 {
  const e = boolErr(h.valid);
  if (e !== V16_OK) return e;
  return nonMinI128Err(h.certified_equity);
}

/** `CloseProgressLedgerV16Account::try_to_runtime`: three bools and a side. */
export function closeProgressErr(c: CloseProgressLedger): u64 {
  let e = boolErr(c.active);
  if (e === V16_OK) e = boolErr(c.finalized);
  if (e === V16_OK) e = boolErr(c.canceled);
  if (e === V16_OK) e = sideErr(c.domain_side);
  return e;
}

/** `ResolvedPayoutLedgerV16Account::try_to_runtime`: two bools. */
export function resolvedPayoutLedgerErr(r: ResolvedPayoutLedger): u64 {
  const e = boolErr(r.payout_halted);
  if (e !== V16_OK) return e;
  return boolErr(r.finalized);
}

/** `ResolvedPayoutReceiptV16Account::try_to_runtime`: two bools. */
export function resolvedPayoutReceiptErr(r: ResolvedPayoutReceipt): u64 {
  const e = boolErr(r.present);
  if (e !== V16_OK) return e;
  return boolErr(r.finalized);
}
