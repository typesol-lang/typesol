// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs and
// src/wide_math.rs (the engine of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License,
// Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The arithmetic and the value kernels the settlement of a portfolio's open legs is built from (the leaf layer of the
// map in NOTES.md, section 10): the source-lien face and backing arithmetic, the backing-bucket, counterparty-lien and
// insurance-lien deltas, the source-credit recompute and positive-claim burn, the K/F stale cohort, the full-drain
// reset, the social-loss carry, the resolved-payout rate, the leg's B snapshot, the K/F and B targets of a leg and its
// K/F delta components with the F snapshot after settlement, the B chunk of a leg, the backing utilization rate and
// fee, the settlement plan keys, and the v16 wide_math helpers they use.
//
// Wired through the settlement of open legs (`settle_account_side_effects_not_atomic`, settlement.ts), which
// SyncMaintenanceFee and Withdraw run and which is compared with the reference binary on generated states with open
// legs. Each function is also compared alone with the original's own function compiled for the host
// (showcase/test/percolator-v16-kernels.test.ts).
//
// Copies. The original takes most of these structs by value (`mut asset: AssetStateV16`, a bucket and a source credit
// state) and its caller writes the value back after `?`. The port changes the caller's place (`Inout<…>`) instead. That
// is the same bytes because no caller of any function here looks at its error and goes on: every direct caller
// propagates it with `?`, and the one swallow site that reaches some of them (`permissionless_auto_crank_not_atomic`
// matching `clear_leg`'s Stale, NOTES.md section 1 site 3) matches Stale only, which of these only the expiry delta
// returns, reached through `expire_source_backing_bucket_not_atomic` (whether it can reach `clear_leg` is checked
// with the crank, NOTES.md section 10). So each fails in place (`failV16`, the program's `map_v16_error`), and a write made before a refusal is discarded with the
// transaction, as the original's copy is. Where a function returns several values the port returns a small struct.
//
// Arithmetic. The engine is built inside the program without overflow checks (the program's release profile), so an
// unchecked `+`/`-` of the original would wrap; every one here is guarded by a comparison just before it (each says
// so), so none can, and TypeSOL's checked operators never fire. Every `checked_*` is a comparison before the operation
// with the original's error. Products of two u128s are formed in u256, where they cannot overflow.
import {
  type Inout,
  type i128,
  type u8,
  type u64,
  type u128,
  type u256,
  i128 as toI128,
  panic,
  u8 as toU8,
  u64 as toU64,
  u128 as toU128,
  u256 as toU256,
} from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_RECOVERY_REQUIRED,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type AssetState,
  type BackingBucket,
  type Config,
  type InsuranceCreditReservation,
  type PortfolioLeg,
  type PortfolioSourceDomain,
  type ResolvedPayoutLedger,
  type SourceCreditState,
} from "./state.js";
import { ADL_ONE, BOUND_SCALE, MAX_BACKING_FEE_RATE_E9_PER_SLOT, MAX_BACKING_FEE_UTIL_BPS, configShapeErr } from "./wire.js";
import { CREDIT_RATE_SCALE, LIFECYCLE_ACTIVE, LIFECYCLE_DRAIN_ONLY, SOCIAL_LOSS_DEN, amountFromBoundNum, sourceCreditShapeErr } from "./engine.js";

const U128_MAX_K: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MAX_K: u128 = 0x7fffffffffffffffffffffffffffffffn;
const U128_MAX_KW: u256 = 340282366920938463463374607431768211455n;
const I128_MAX_KW: u256 = 170141183460469231731687303715884105727n;
const U64_MAX_K: u64 = 0xffffffffffffffffn;
/** `POS_SCALE` (src/lib.rs). */
const POS_SCALE: u128 = 1000000n;
/** `BACKING_FEE_RATE_DEN_E9` (src/v16.rs). */
const BACKING_FEE_RATE_DEN_E9: u128 = 1000000000n;
/** The account K/F settlement plan's key bounds (src/v16.rs 7347–7349). */
const PLAN_DOMAIN_MAX: u64 = 0x1ffffffffn;
const PLAN_PHASE_SHIFT: u64 = 37n;
const PLAN_KEY_MAX: u64 = 0x3fffffffffn;
/** `SideModeV16::ResetPending`, `BackingBucketStatusV16` bytes. */
const MODE_RESET_PENDING: u8 = 2n;
const BUCKET_EMPTY: u8 = 0n;
const BUCKET_FRESH: u8 = 1n;
const BUCKET_EXPIRED: u8 = 2n;
const BUCKET_IMPAIRED: u8 = 3n;

// ---- Results with several values --------------------------------------------------------------------------------------

export interface FeeCharge {
  charged: u128;
  capital: u128;
  c_tot: u128;
  earnings: u128;
}
export interface Pair {
  a: u128;
  b: u128;
}
export interface BurnPlan {
  counterparty_face_burn: u128;
  insurance_face_burn: u128;
  counterparty_backing_release: u128;
  insurance_backing_release: u128;
  backing_release: u128;
}
export interface FaceSettlement {
  pnl: i128;
  face_burned: u128;
}
export interface KfTarget {
  k: i128;
  f: i128;
}
export interface KfDelta {
  k_now: i128;
  f_now: i128;
  k_delta: i128;
  f_delta: i128;
  net: i128;
  f_snap_next: i128;
}
export interface BChunk {
  delta_b: u128;
  loss: u128;
  new_remainder: u128;
  remaining_after: u128;
}
export interface PlanKey {
  phase: u8;
  domain: u64;
  slot: u64;
}
export interface MaybeI128 {
  some: u8;
  value: i128;
}

// ---- wide_math.rs (v16) -------------------------------------------------------------------------------------------------

/** |v| as u128 (i128::MIN's is 2^127). */
function absI(v: i128): u128 {
  return v < 0n ? toU128(-(v + 1n)) + 1n : toU128(v);
}

/** `wide_mul_div_floor_u128`: ⌊a·b / d⌋ through 256 bits; panics for d = 0 and for a result above u128. */
export function wideMulDivFloorU128(a: u128, b: u128, d: u128): u128 {
  if (d === 0n) panic("wide_mul_div_floor_u128: division by zero", "src/wide_math.rs:1621:5");
  const q = (toU256(a) * toU256(b)) / toU256(d);
  if (q > U128_MAX_KW) panic("wide_mul_div_floor_u128: result exceeds u128", "src/wide_math.rs:1625:10");
  return toU128(q);
}

/** `checked_mul_div_ceil_u256` on u128 factors (the product fits 256 bits), then `try_into_u128`: false for d = 0 or
 * a result above u128 (both callers map that to ArithmeticOverflow). */
function mulDivCeilFits(a: u128, b: u128, d: u128): boolean {
  if (d === 0n) return false;
  const p = toU256(a) * toU256(b);
  const q = p / toU256(d);
  const c = p % toU256(d) === 0n ? q : q + 1n;
  return c <= U128_MAX_KW;
}
function mulDivCeil(a: u128, b: u128, d: u128): u128 {
  const p = toU256(a) * toU256(b);
  const q = p / toU256(d);
  return toU128(p % toU256(d) === 0n ? q : q + 1n);
}

/** `floor_div_signed_conservative_i128(n, d)`: ⌊n / d⌋, d > 0. */
export function floorDivSigned(n: i128, d: u128): i128 {
  if (d === 0n) panic("floor_div_signed_conservative_i128: zero denominator", "src/wide_math.rs:1424:5");
  if (n === 0n) return 0n;
  if (n > 0n) return toI128(toU128(n) / d);
  const abs = absI(n);
  const q = abs / d;
  const qFinal = abs % d !== 0n ? q + 1n : q;
  if (qFinal > I128_MAX_K) panic("floor_div_signed_conservative_i128: result out of range", "src/wide_math.rs:1442:9");
  return -toI128(qFinal);
}

/**
 * `wide_signed_mul_div_floor_from_k_pair(abs_basis, k_then, k_now, den)`: ⌊abs_basis · (k_now − k_then) / den⌋ with
 * the difference in 256 bits. The difference of two i128s fits 129 bits and the product 256 (the original's "K-diff
 * overflow" and "wide product overflow" cannot fire); the quotient must fit i128 (its panics).
 */
export function wideSignedMulDivFloorFromKPair(absBasis: u128, kThen: i128, kNow: i128, den: u128): i128 {
  if (den === 0n) panic("wide_signed_mul_div_floor_from_k_pair: den == 0", "src/wide_math.rs:1636:5");
  if (kNow === kThen || absBasis === 0n) return 0n;
  const negative = kNow < kThen;
  // |k_now − k_then| in u256: the two magnitudes added when the signs differ, subtracted when they agree.
  let absD: u256 = 0n;
  if (kNow < 0n !== kThen < 0n) absD = toU256(absI(kNow)) + toU256(absI(kThen));
  else if (negative) absD = kNow < 0n ? toU256(absI(kNow)) - toU256(absI(kThen)) : toU256(absI(kThen) - absI(kNow));
  else absD = kNow < 0n ? toU256(absI(kThen)) - toU256(absI(kNow)) : toU256(absI(kNow) - absI(kThen));
  const p = toU256(absBasis) * absD;
  const q = p / toU256(den);
  if (negative) {
    const mag = p % toU256(den) !== 0n ? q + 1n : q;
    if (mag > U128_MAX_KW) panic("mag exceeds u128", "src/wide_math.rs:1661:44");
    if (mag > I128_MAX_KW) panic("wide_signed_mul_div_floor_from_k_pair: mag > i128::MAX", "src/wide_math.rs:1662:9");
    return -toI128(toU128(mag));
  }
  if (q > U128_MAX_KW) panic("quotient exceeds u128", "src/wide_math.rs:1668:40");
  if (q > I128_MAX_KW) panic("wide_signed_mul_div_floor_from_k_pair: q > i128::MAX", "src/wide_math.rs:1669:9");
  return toI128(toU128(q));
}

// ---- Bound numbers and products (V16Core) -------------------------------------------------------------------------------

/** `bound_num_from_amount`: amount · BOUND_SCALE (ArithmeticOverflow). */
export function boundNumFromAmount(amount: u128): u128 {
  if (amount > U128_MAX_K / BOUND_SCALE) failV16(V16_ARITHMETIC_OVERFLOW);
  return amount * BOUND_SCALE;
}

/** `validate_bound_num_atom_aligned` (InvalidConfig). */
export function requireAtomAligned(n: u128): void {
  if (n !== 0n && n % BOUND_SCALE !== 0n) failV16(V16_INVALID_CONFIG);
}

/** `mul_div_floor_u128_or_wide(a, b, d)`: d = 0 InvalidConfig; ⌊a·b / d⌋, ArithmeticOverflow above u128. */
export function mulDivFloorOrWide(a: u128, b: u128, d: u128): u128 {
  if (d === 0n) failV16(V16_INVALID_CONFIG);
  const q = (toU256(a) * toU256(b)) / toU256(d);
  if (q > U128_MAX_KW) failV16(V16_ARITHMETIC_OVERFLOW);
  return toU128(q);
}

/** `mul_div_ceil_u128_or_wide(a, b, d)`: d = 0 InvalidConfig; ⌈a·b / d⌉, ArithmeticOverflow above u128. (The u128 path's
 * `quotient + 1` cannot overflow: a fitting product over d ≥ 1 rounded up is at most the product.) */
export function mulDivCeilOrWide(a: u128, b: u128, d: u128): u128 {
  if (d === 0n) failV16(V16_INVALID_CONFIG);
  if (!mulDivCeilFits(a, b, d)) failV16(V16_ARITHMETIC_OVERFLOW);
  return mulDivCeil(a, b, d);
}

// ---- Source liens -----------------------------------------------------------------------------------------------------

/** `source_credit_lien_amounts_for_effective(effective, rate)` → (required face, required backing). */
export function sourceCreditLienAmounts(effective: u128, rate: u128): Pair {
  if (rate === 0n) failV16(V16_LOCK_ACTIVE);
  if (rate > CREDIT_RATE_SCALE) failV16(V16_INVALID_CONFIG);
  const backing = boundNumFromAmount(effective);
  if (rate === CREDIT_RATE_SCALE) return { a: backing, b: backing };
  return { a: mulDivCeilOrWide(backing, CREDIT_RATE_SCALE, rate), b: backing };
}

/** `source_lien_backing_release_for_face_burn(face_locked, backing_reserved, face_burn)`. */
export function sourceLienBackingRelease(faceLocked: u128, backingReserved: u128, faceBurn: u128): u128 {
  if (faceBurn > faceLocked || backingReserved % BOUND_SCALE !== 0n) failV16(V16_INVALID_LEG);
  const effectiveReserved = backingReserved / BOUND_SCALE;
  if (effectiveReserved > amountFromBoundNum(faceLocked)) failV16(V16_INVALID_LEG);
  // faceLocked − faceBurn: faceBurn ≤ faceLocked was just checked (the original's CounterUnderflow cannot fire).
  const maxRemaining = amountFromBoundNum(faceLocked - faceBurn);
  const release = effectiveReserved > maxRemaining ? effectiveReserved - maxRemaining : 0n;
  return boundNumFromAmount(release);
}

/** `source_lien_fee_after_backing_release(fee, backing_before, backing_after)`. */
export function sourceLienFeeAfterRelease(fee: u128, before: u128, after: u128): u128 {
  if (after > before) failV16(V16_INVALID_LEG);
  if (after === 0n || fee === 0n) return 0n;
  if (after === before) return fee;
  // before > after > 0 here, so the original's `before == 0` refusal cannot fire.
  return wideMulDivFloorU128(fee, after, before);
}

/** `source_lien_face_burn_partition(counterparty_face, insurance_face, burn)` → (counterparty burn, insurance burn). */
export function sourceLienFaceBurnPartition(counterpartyFace: u128, insuranceFace: u128, burn: u128): Pair {
  if (counterpartyFace > U128_MAX_K - insuranceFace) failV16(V16_ARITHMETIC_OVERFLOW);
  if (burn > counterpartyFace + insuranceFace) failV16(V16_COUNTER_UNDERFLOW);
  const cp = burn < counterpartyFace ? burn : counterpartyFace;
  return { a: cp, b: burn - cp };
}

/** `source_lien_face_burn_plan`: the partition, each side's backing release, and their sum. */
export function sourceLienFaceBurnPlan(cpFace: u128, insFace: u128, cpBacking: u128, insBacking: u128, burn: u128): BurnPlan {
  const part = sourceLienFaceBurnPartition(cpFace, insFace, burn);
  const cpRelease = sourceLienBackingRelease(cpFace, cpBacking, part.a);
  const insRelease = sourceLienBackingRelease(insFace, insBacking, part.b);
  if (cpRelease > U128_MAX_K - insRelease) failV16(V16_ARITHMETIC_OVERFLOW);
  return {
    counterparty_face_burn: part.a,
    insurance_face_burn: part.b,
    counterparty_backing_release: cpRelease,
    insurance_backing_release: insRelease,
    backing_release: cpRelease + insRelease,
  };
}

/** `crystallize_source_lien_fee_for_effective(source, impaired)`: the impaired share of the lien's fee revenue moved
 * to the impaired revenue. Returns it. */
export function crystallizeSourceLienFee(source: Inout<PortfolioSourceDomain>, impaired: u128): u128 {
  const live = source.source_lien_effective_reserved;
  if (impaired > live) failV16(V16_COUNTER_UNDERFLOW);
  const liveFee = source.source_lien_capital_at_risk_fee_revenue;
  let fee: u128 = 0n;
  if (impaired === live) fee = liveFee;
  else if (impaired !== 0n && liveFee !== 0n) fee = wideMulDivFloorU128(liveFee, impaired, live);
  // fee ≤ liveFee (impaired < live), so the checked_sub cannot fail.
  source.source_lien_capital_at_risk_fee_revenue = liveFee - fee;
  if (source.source_lien_impaired_capital_at_risk_fee_revenue > U128_MAX_K - fee) failV16(V16_COUNTER_OVERFLOW);
  source.source_lien_impaired_capital_at_risk_fee_revenue += fee;
  return fee;
}

// ---- Source credit states -----------------------------------------------------------------------------------------------

/** `expected_source_credit_rate_num_for_state`: the shape checked; CREDIT_RATE_SCALE without claims; 0 without
 * available backing; else available / unliened claim, capped at the scale. */
export function expectedSourceCreditRate(s: SourceCreditState): u128 {
  checkV16(sourceCreditShapeErr(s));
  if (s.positive_claim_bound_num === 0n) return CREDIT_RATE_SCALE;
  // available_backing_num_for_source_credit_state: its refusals are the shape check's, which passed.
  const available =
    s.fresh_reserved_backing_num -
    s.valid_liened_backing_num +
    (s.insurance_credit_reserved_num - (s.valid_liened_insurance_num + s.impaired_liened_insurance_num));
  if (available === 0n) return 0n;
  if (s.valid_liened_backing_num > U128_MAX_K - s.valid_liened_insurance_num) failV16(V16_ARITHMETIC_OVERFLOW);
  const covered = s.valid_liened_backing_num + s.valid_liened_insurance_num;
  const unliened = s.positive_claim_bound_num > covered ? s.positive_claim_bound_num - covered : 0n;
  if (available >= unliened) return CREDIT_RATE_SCALE;
  return toU128((toU256(available) * toU256(CREDIT_RATE_SCALE)) / toU256(unliened));
}

/** `prepare_source_credit_domain_recompute_for_epoch_steps(source, risk_epoch, steps)`: the rate recomputed, the credit
 * epoch advanced by `steps`; returns the risk epoch advanced by as many. `…_for_epoch` is `steps` 1. */
export function recomputeSourceCreditForEpoch(source: Inout<SourceCreditState>, riskEpoch: u64, steps: u64): u64 {
  if (steps === 0n) failV16(V16_INVALID_CONFIG);
  source.credit_rate_num = expectedSourceCreditRate(source);
  if (source.credit_epoch > U64_MAX_K - steps) failV16(V16_COUNTER_OVERFLOW);
  source.credit_epoch += steps;
  if (riskEpoch > U64_MAX_K - steps) failV16(V16_COUNTER_OVERFLOW);
  return riskEpoch + steps;
}

/** `prepare_source_positive_claim_burn_delta(source, burn)`. */
export function sourcePositiveClaimBurn(source: Inout<SourceCreditState>, burn: u128): void {
  if (source.positive_claim_bound_num < burn) failV16(V16_COUNTER_UNDERFLOW);
  source.positive_claim_bound_num -= burn;
  const exact = source.exact_positive_claim_num;
  source.exact_positive_claim_num = exact - (burn < exact ? burn : exact);
}

/** `source_claim_domain_first_burn_partition(claim, burn)` → (from the source, the rest). */
export function sourceClaimDomainFirstBurnPartition(claim: u128, burn: u128): Pair {
  const fromSource = claim < burn ? claim : burn;
  return { a: fromSource, b: burn - fromSource };
}

/** `source_credit_state_realizable_support_for_claim_num(state, claim)`. */
export function sourceRealizableSupport(s: SourceCreditState, claim: u128): u128 {
  if (claim === 0n || s.positive_claim_bound_num === 0n) return 0n;
  const credited = mulDivFloorOrWide(claim, s.credit_rate_num, CREDIT_RATE_SCALE);
  // available_backing_num_for_source_credit_state, with its own refusals (no shape check before it here).
  if (s.fresh_reserved_backing_num < s.valid_liened_backing_num) failV16(V16_INVALID_CONFIG);
  if (s.valid_liened_insurance_num > U128_MAX_K - s.impaired_liened_insurance_num) failV16(V16_ARITHMETIC_OVERFLOW);
  const encumbered = s.valid_liened_insurance_num + s.impaired_liened_insurance_num;
  if (s.insurance_credit_reserved_num < encumbered) failV16(V16_INVALID_CONFIG);
  const freeBacking = s.fresh_reserved_backing_num - s.valid_liened_backing_num;
  const freeInsurance = s.insurance_credit_reserved_num - encumbered;
  if (freeBacking > U128_MAX_K - freeInsurance) failV16(V16_ARITHMETIC_OVERFLOW);
  const a = credited / BOUND_SCALE;
  const b = (freeBacking + freeInsurance) / BOUND_SCALE;
  return a < b ? a : b;
}

// ---- Backing buckets and counterparty liens ------------------------------------------------------------------------------

/** `prepare_counterparty_lien_create_delta(bucket, source, slot, amount)`. */
export function counterpartyLienCreate(bucket: Inout<BackingBucket>, source: Inout<SourceCreditState>, slot: u64, amount: u128): void {
  if (amount === 0n) return;
  if (bucket.status !== BUCKET_FRESH || bucket.expiry_slot <= slot || bucket.fresh_unliened_backing_num < amount) failV16(V16_LOCK_ACTIVE);
  bucket.fresh_unliened_backing_num -= amount;
  if (bucket.valid_liened_backing_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  bucket.valid_liened_backing_num += amount;
  if (source.valid_liened_backing_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  source.valid_liened_backing_num += amount;
}

/** `prepare_counterparty_backing_add_delta(bucket, source, amount, slot, expiry)`: a deposit refills the provider's
 * receivable first; a bucket Empty or Expired becomes Fresh with the expiry, a Fresh one must have the same expiry. */
export function counterpartyBackingAdd(bucket: Inout<BackingBucket>, source: Inout<SourceCreditState>, amount: u128, slot: u64, expiry: u64): void {
  if (amount === 0n || expiry <= slot) failV16(V16_INVALID_CONFIG);
  if (source.provider_receivable_num !== bucket.consumed_liened_backing_num || source.spent_backing_num < source.provider_receivable_num)
    failV16(V16_INVALID_CONFIG);
  const status = bucket.status;
  if (status === BUCKET_EMPTY || status === BUCKET_EXPIRED) {
    bucket.status = BUCKET_FRESH;
    bucket.expiry_slot = expiry;
  } else if (!(status === BUCKET_FRESH && bucket.expiry_slot === expiry)) failV16(V16_LOCK_ACTIVE);
  const receivable = source.provider_receivable_num;
  const refill = amount < receivable ? amount : receivable;
  // receivable = consumed (checked above), so refill ≤ consumed: the original's CounterUnderflow cannot fire.
  bucket.consumed_liened_backing_num -= refill;
  source.provider_receivable_num -= refill;
  if (bucket.fresh_unliened_backing_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  bucket.fresh_unliened_backing_num += amount;
  if (source.fresh_reserved_backing_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  source.fresh_reserved_backing_num += amount;
}

/** `prepare_counterparty_backing_expiry_delta(bucket, source, now)`: a Fresh bucket past its expiry: its unliened
 * backing leaves the source's reserve, its liened backing becomes impaired. */
export function counterpartyBackingExpiry(bucket: Inout<BackingBucket>, source: Inout<SourceCreditState>, now: u64): void {
  if (bucket.status !== BUCKET_FRESH || now < bucket.expiry_slot) failV16(V16_STALE);
  const unliened = bucket.fresh_unliened_backing_num;
  const liened = bucket.valid_liened_backing_num;
  if (unliened > U128_MAX_K - liened) failV16(V16_ARITHMETIC_OVERFLOW);
  const total = unliened + liened;
  if (source.fresh_reserved_backing_num < total || source.valid_liened_backing_num < liened) failV16(V16_COUNTER_UNDERFLOW);
  source.fresh_reserved_backing_num -= total;
  source.valid_liened_backing_num -= liened;
  if (source.impaired_liened_backing_num > U128_MAX_K - liened) failV16(V16_COUNTER_OVERFLOW);
  source.impaired_liened_backing_num += liened;
  bucket.fresh_unliened_backing_num = 0n;
  bucket.valid_liened_backing_num = 0n;
  if (bucket.impaired_liened_backing_num > U128_MAX_K - liened) failV16(V16_COUNTER_OVERFLOW);
  bucket.impaired_liened_backing_num += liened;
  bucket.status = liened === 0n && bucket.impaired_liened_backing_num === 0n ? BUCKET_EXPIRED : BUCKET_IMPAIRED;
}

/** `prepare_counterparty_lien_terminal_release_delta(bucket, source, amount)`: a valid lien returned to the bucket's
 * unliened backing. */
export function counterpartyLienTerminalRelease(bucket: Inout<BackingBucket>, source: Inout<SourceCreditState>, amount: u128): void {
  if (amount === 0n) return;
  if (bucket.valid_liened_backing_num < amount || source.valid_liened_backing_num < amount) failV16(V16_COUNTER_UNDERFLOW);
  bucket.valid_liened_backing_num -= amount;
  if (bucket.fresh_unliened_backing_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  bucket.fresh_unliened_backing_num += amount;
  source.valid_liened_backing_num -= amount;
}

/** `prepare_counterparty_lien_release_delta(bucket, source, slot, amount)`: a valid lien of a Fresh, unexpired bucket
 * returned to its unliened backing (CounterUnderflow for a bucket not Fresh, expired, or holding less, or a source state
 * holding less; CounterOverflow). */
export function counterpartyLienRelease(bucket: Inout<BackingBucket>, source: Inout<SourceCreditState>, slot: u64, amount: u128): void {
  if (amount === 0n) return;
  if (bucket.status !== BUCKET_FRESH || bucket.expiry_slot <= slot || bucket.valid_liened_backing_num < amount || source.valid_liened_backing_num < amount)
    failV16(V16_COUNTER_UNDERFLOW);
  bucket.valid_liened_backing_num -= amount;
  if (bucket.fresh_unliened_backing_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  bucket.fresh_unliened_backing_num += amount;
  source.valid_liened_backing_num -= amount;
}

/** `prepare_counterparty_lien_consume_delta(bucket, source, amount)`: a valid lien consumed: spent from the source's
 * reserve and owed to the provider; a bucket left with nothing becomes Expired. */
export function counterpartyLienConsume(bucket: Inout<BackingBucket>, source: Inout<SourceCreditState>, amount: u128): void {
  if (amount === 0n) return;
  if (bucket.valid_liened_backing_num < amount || source.valid_liened_backing_num < amount || source.fresh_reserved_backing_num < amount)
    failV16(V16_COUNTER_UNDERFLOW);
  bucket.valid_liened_backing_num -= amount;
  if (bucket.consumed_liened_backing_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  bucket.consumed_liened_backing_num += amount;
  if (bucket.fresh_unliened_backing_num === 0n && bucket.valid_liened_backing_num === 0n && bucket.impaired_liened_backing_num === 0n)
    bucket.status = BUCKET_EXPIRED;
  source.valid_liened_backing_num -= amount;
  source.fresh_reserved_backing_num -= amount;
  if (source.spent_backing_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  source.spent_backing_num += amount;
  if (source.provider_receivable_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  source.provider_receivable_num += amount;
}

// ---- Insurance liens ----------------------------------------------------------------------------------------------------

/** `prepare_insurance_lien_consume_delta(reservation, source, domain_spent, insurance, amount)` → (domain spent,
 * insurance) after spending the lien's atoms. */
export function insuranceLienConsume(r: Inout<InsuranceCreditReservation>, source: Inout<SourceCreditState>, spent: u128, insurance: u128, amount: u128): Pair {
  if (amount === 0n) return { a: spent, b: insurance };
  requireAtomAligned(amount);
  const atoms = amountFromBoundNum(amount);
  if (
    r.valid_liened_insurance_num < amount ||
    r.insurance_credit_reserved_num < amount ||
    source.valid_liened_insurance_num < amount ||
    source.insurance_credit_reserved_num < amount ||
    insurance < atoms
  )
    failV16(V16_COUNTER_UNDERFLOW);
  r.valid_liened_insurance_num -= amount;
  r.insurance_credit_reserved_num -= amount;
  if (r.consumed_insurance_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  r.consumed_insurance_num += amount;
  source.valid_liened_insurance_num -= amount;
  source.insurance_credit_reserved_num -= amount;
  if (spent > U128_MAX_K - atoms) failV16(V16_COUNTER_OVERFLOW);
  return { a: spent + atoms, b: insurance - atoms };
}

/** `prepare_insurance_lien_create_delta(reservation, source, amount)`: a lien on the reservation's unencumbered part. */
export function insuranceLienCreate(r: Inout<InsuranceCreditReservation>, source: Inout<SourceCreditState>, amount: u128): void {
  if (amount === 0n) return;
  requireAtomAligned(amount);
  if (r.valid_liened_insurance_num > U128_MAX_K - r.impaired_liened_insurance_num) failV16(V16_ARITHMETIC_OVERFLOW);
  const encumbered = r.valid_liened_insurance_num + r.impaired_liened_insurance_num;
  if (r.insurance_credit_reserved_num < encumbered) failV16(V16_COUNTER_UNDERFLOW);
  if (r.insurance_credit_reserved_num - encumbered < amount) failV16(V16_LOCK_ACTIVE);
  // valid ≤ encumbered ≤ reserved − amount, so valid + amount ≤ reserved: the CounterOverflow cannot fire.
  r.valid_liened_insurance_num += amount;
  if (source.valid_liened_insurance_num > U128_MAX_K - amount) failV16(V16_COUNTER_OVERFLOW);
  source.valid_liened_insurance_num += amount;
}

/** `prepare_insurance_lien_release_delta(reservation, source, amount)`. */
export function insuranceLienRelease(r: Inout<InsuranceCreditReservation>, source: Inout<SourceCreditState>, amount: u128): void {
  if (amount === 0n) return;
  requireAtomAligned(amount);
  if (r.valid_liened_insurance_num < amount || source.valid_liened_insurance_num < amount) failV16(V16_COUNTER_UNDERFLOW);
  r.valid_liened_insurance_num -= amount;
  source.valid_liened_insurance_num -= amount;
}

/** `prepare_insurance_lien_terminal_release_delta(reservation, source, amount)`: the reservation released, its valid
 * liens first, then impaired ones. */
export function insuranceLienTerminalRelease(r: Inout<InsuranceCreditReservation>, source: Inout<SourceCreditState>, amount: u128): void {
  if (amount === 0n) return;
  requireAtomAligned(amount);
  if (r.insurance_credit_reserved_num < amount || source.insurance_credit_reserved_num < amount) failV16(V16_COUNTER_UNDERFLOW);
  const valid = amount < r.valid_liened_insurance_num ? amount : r.valid_liened_insurance_num;
  if (source.valid_liened_insurance_num < valid) failV16(V16_COUNTER_UNDERFLOW);
  const impaired = amount - valid;
  if (r.impaired_liened_insurance_num < impaired || source.impaired_liened_insurance_num < impaired) failV16(V16_COUNTER_UNDERFLOW);
  r.valid_liened_insurance_num -= valid;
  source.valid_liened_insurance_num -= valid;
  r.impaired_liened_insurance_num -= impaired;
  source.impaired_liened_insurance_num -= impaired;
  r.insurance_credit_reserved_num -= amount;
  source.insurance_credit_reserved_num -= amount;
}

// ---- Backing utilization fees -------------------------------------------------------------------------------------------

/** `apply_backing_utilization_fee_charge(capital, c_tot, earnings, pnl, fee)` → (charged, capital, c_tot, earnings). */
export function applyBackingUtilizationFeeCharge(capital: u128, cTot: u128, earnings: u128, pnl: i128, fee: u128): FeeCharge {
  if (fee === 0n || pnl < 0n) return { charged: 0n, capital, c_tot: cTot, earnings };
  const charged = fee < capital ? fee : capital;
  if (charged === 0n) return { charged: 0n, capital, c_tot: cTot, earnings };
  // charged ≤ capital, so the capital's checked_sub cannot fail.
  if (cTot < charged) failV16(V16_COUNTER_UNDERFLOW);
  if (earnings > U128_MAX_K - charged) failV16(V16_COUNTER_OVERFLOW);
  return { charged, capital: capital - charged, c_tot: cTot - charged, earnings: earnings + charged };
}

/** `backing_utilization_rate_e9_for_source_state(config, source)`: the kinked utilization curve of the domain's
 * valid liens over its fresh reserve. The config was decoded by the caller (`decode_runtime`); its shape is checked
 * here, as the original does. */
export function backingUtilizationRate(c: Config, s: SourceCreditState): u64 {
  checkV16(configShapeErr(c));
  if (s.valid_liened_backing_num === 0n) return 0n;
  if (s.fresh_reserved_backing_num === 0n || s.valid_liened_backing_num > s.fresh_reserved_backing_num) failV16(V16_INVALID_CONFIG);
  // valid ≤ fresh, so the utilization is at most MAX_BACKING_FEE_UTIL_BPS (its try_into_u128 cannot fail).
  const util = toU64((toU256(s.valid_liened_backing_num) * toU256(MAX_BACKING_FEE_UTIL_BPS)) / toU256(s.fresh_reserved_backing_num));
  const kink = c.backing_fee_kink_util_bps;
  let rate: u64 = 0n;
  if (util <= kink) {
    // checked_div by a zero kink is None (ArithmeticOverflow); the shape check refuses a zero kink before.
    if (kink === 0n) failV16(V16_ARITHMETIC_OVERFLOW);
    const slope = (toU256(c.backing_fee_slope_at_kink_e9_per_slot) * toU256(util)) / toU256(kink);
    // slope ≤ the slope at the kink (util ≤ kink): it fits u64, and the u128 → u64 `as` keeps it.
    const s64 = toU64(slope);
    if (c.backing_fee_base_rate_e9_per_slot > U64_MAX_K - s64) failV16(V16_ARITHMETIC_OVERFLOW);
    rate = c.backing_fee_base_rate_e9_per_slot + s64;
  } else {
    // kink < util ≤ MAX, so neither checked_sub can fail (kink < MAX: the shape check).
    const den = MAX_BACKING_FEE_UTIL_BPS - kink;
    const num = util - kink;
    const above = toU64((toU256(c.backing_fee_slope_above_kink_e9_per_slot) * toU256(num)) / toU256(den));
    const base = c.backing_fee_base_rate_e9_per_slot;
    const atKink = c.backing_fee_slope_at_kink_e9_per_slot;
    if (base > U64_MAX_K - atKink) failV16(V16_ARITHMETIC_OVERFLOW);
    if (base + atKink > U64_MAX_K - above) failV16(V16_ARITHMETIC_OVERFLOW);
    rate = base + atKink + above;
  }
  if (rate > MAX_BACKING_FEE_RATE_E9_PER_SLOT) failV16(V16_INVALID_CONFIG);
  return rate;
}

/** `backing_utilization_fee_quote_atoms_for_lien(config, source, lien, from, to)`: lien · rate · (to − from) /
 * (1e9 · BOUND_SCALE). The product of a u128 and two u64s fits 256 bits; the quotient must fit u128. */
export function backingUtilizationFeeQuote(c: Config, s: SourceCreditState, lien: u128, from: u64, to: u64): u128 {
  if (lien === 0n || to <= from) return 0n;
  const rate = backingUtilizationRate(c, s);
  if (rate === 0n) return 0n;
  const q = (toU256(lien) * toU256(rate) * toU256(to - from)) / toU256(BACKING_FEE_RATE_DEN_E9 * BOUND_SCALE);
  if (q > U128_MAX_KW) failV16(V16_ARITHMETIC_OVERFLOW);
  return toU128(q);
}

// ---- Losses, faces and payouts (V16Core kernels) -------------------------------------------------------------------------

/** `kernel_settle_positive_face_after_support(face, burned, loss)` → (new PnL, face burned in total). */
export function settlePositiveFaceAfterSupport(face: u128, burned: u128, loss: u128): FaceSettlement {
  if (face > I128_MAX_K || burned > face || loss > I128_MAX_K) failV16(V16_ARITHMETIC_OVERFLOW);
  // retained − loss of two values in 0..=i128::MAX cannot overflow i128.
  const pnl = toI128(face - burned) - toI128(loss);
  return { pnl, face_burned: face - (pnl > 0n ? toU128(pnl) : 0n) };
}

/** `kernel_normalize_social_loss_carry(remainder, dust, explicit)` → (dust, explicit loss). */
export function normalizeSocialLossCarry(remainder: u128, dust: u128, explicit: u128): Pair {
  if (remainder >= SOCIAL_LOSS_DEN || dust >= SOCIAL_LOSS_DEN) failV16(V16_INVALID_CONFIG);
  // Both below 1e21: the sum cannot overflow.
  const total = remainder + dust;
  const crossed = total >= SOCIAL_LOSS_DEN;
  return { a: crossed ? total - SOCIAL_LOSS_DEN : total, b: crossed && explicit !== U128_MAX_K ? explicit + 1n : explicit };
}

/** `kernel_settle_kf_stale_cohort(asset, side, leg_kf_epoch_snap)`: a leg of an older K/F epoch leaves its side's stale
 * count. Returns the side's K/F epoch. `short` is SideV16::Short. */
export function settleKfStaleCohort(asset: Inout<AssetState>, short: boolean, snap: u64): u64 {
  const epoch = short ? asset.kf_epoch_short : asset.kf_epoch_long;
  if (snap > epoch) failV16(V16_INVALID_LEG);
  if (snap < epoch) {
    if (short) {
      if (asset.stale_account_count_short === 0n) failV16(V16_COUNTER_UNDERFLOW);
      asset.stale_account_count_short -= 1n;
    } else {
      if (asset.stale_account_count_long === 0n) failV16(V16_COUNTER_UNDERFLOW);
      asset.stale_account_count_long -= 1n;
    }
  }
  return epoch;
}

/** `kernel_begin_full_drain_reset(asset, side)`: an exhausted side moved behind a reset epoch (its K, F and B indices
 * kept as the epoch's start, the social-loss carry normalized, A back to ADL_ONE, the epoch advanced, ResetPending). */
export function beginFullDrainReset(asset: Inout<AssetState>, short: boolean): void {
  if (!short) {
    if (asset.mode_long === MODE_RESET_PENDING || asset.oi_eff_long_q !== 0n || asset.pending_obligation_count_long !== 0n) failV16(V16_LOCK_ACTIVE);
    const carry = normalizeSocialLossCarry(asset.social_loss_remainder_long_num, asset.social_loss_dust_long_num, asset.explicit_unallocated_loss_long);
    asset.social_loss_remainder_long_num = 0n;
    asset.social_loss_dust_long_num = carry.a;
    asset.explicit_unallocated_loss_long = carry.b;
    asset.k_epoch_start_long = asset.k_long;
    asset.f_epoch_start_long_num = asset.f_long_num;
    asset.b_epoch_start_long_num = asset.b_long_num;
    asset.k_long = 0n;
    asset.f_long_num = 0n;
    asset.b_long_num = 0n;
    asset.loss_weight_sum_long = 0n;
    asset.a_long = ADL_ONE;
    if (asset.epoch_long === U64_MAX_K) failV16(V16_COUNTER_OVERFLOW);
    asset.epoch_long += 1n;
    asset.mode_long = MODE_RESET_PENDING;
  } else {
    if (asset.mode_short === MODE_RESET_PENDING || asset.oi_eff_short_q !== 0n || asset.pending_obligation_count_short !== 0n) failV16(V16_LOCK_ACTIVE);
    const carry = normalizeSocialLossCarry(asset.social_loss_remainder_short_num, asset.social_loss_dust_short_num, asset.explicit_unallocated_loss_short);
    asset.social_loss_remainder_short_num = 0n;
    asset.social_loss_dust_short_num = carry.a;
    asset.explicit_unallocated_loss_short = carry.b;
    asset.k_epoch_start_short = asset.k_short;
    asset.f_epoch_start_short_num = asset.f_short_num;
    asset.b_epoch_start_short_num = asset.b_short_num;
    asset.k_short = 0n;
    asset.f_short_num = 0n;
    asset.b_short_num = 0n;
    asset.loss_weight_sum_short = 0n;
    asset.a_short = ADL_ONE;
    if (asset.epoch_short === U64_MAX_K) failV16(V16_COUNTER_OVERFLOW);
    asset.epoch_short += 1n;
    asset.mode_short = MODE_RESET_PENDING;
  }
}

/** `kernel_recompute_resolved_payout_rate(ledger)`: residual · BOUND_SCALE over the outstanding claim bound, capped at
 * one (1/1 without claims). */
export function recomputeResolvedPayoutRate(l: Inout<ResolvedPayoutLedger>): void {
  if (l.terminal_claim_exact_receipts_num > U128_MAX_K - l.terminal_claim_bound_unreceipted_num) failV16(V16_ARITHMETIC_OVERFLOW);
  const total = l.terminal_claim_exact_receipts_num + l.terminal_claim_bound_unreceipted_num;
  if (total === 0n) {
    l.current_payout_rate_num = 1n;
    l.current_payout_rate_den = 1n;
    return;
  }
  if (l.snapshot_residual > U128_MAX_K / BOUND_SCALE) failV16(V16_ARITHMETIC_OVERFLOW);
  const num = l.snapshot_residual * BOUND_SCALE;
  l.current_payout_rate_num = num < total ? num : total;
  l.current_payout_rate_den = total;
}

/** `kernel_credit_post_snapshot_residual(ledger, legacy_snapshot, released)`: both snapshots raised by the released
 * residual and the rate recomputed. Returns the legacy snapshot. */
export function creditPostSnapshotResidual(l: Inout<ResolvedPayoutLedger>, legacy: u128, released: u128): u128 {
  if (l.snapshot_residual > U128_MAX_K - released) failV16(V16_ARITHMETIC_OVERFLOW);
  l.snapshot_residual += released;
  if (legacy > U128_MAX_K - released) failV16(V16_ARITHMETIC_OVERFLOW);
  recomputeResolvedPayoutRate(l);
  return legacy + released;
}

// ---- Legs: targets, deltas, B ------------------------------------------------------------------------------------------

/** `kernel_advance_leg_b_snap(leg, delta_b, new_remainder, remaining_after)`. */
export function advanceLegBSnap(leg: Inout<PortfolioLeg>, deltaB: u128, remainder: u128, remainingAfter: u128): void {
  if (leg.b_snap > U128_MAX_K - deltaB) failV16(V16_ARITHMETIC_OVERFLOW);
  leg.b_snap += deltaB;
  leg.b_rem = remainder;
  leg.b_stale = remainingAfter !== 0n ? 1n : 0n;
}

/** `kf_target_for_leg_from_asset(asset, leg)`: the side's K and F when the leg is of its epoch, the epoch's start when
 * the side is ResetPending and the leg one epoch behind; InvalidLeg otherwise. */
export function kfTargetForLeg(asset: AssetState, leg: PortfolioLeg): KfTarget {
  const short = leg.side === 1n;
  const sideEpoch = short ? asset.epoch_short : asset.epoch_long;
  if (leg.epoch_snap === sideEpoch) return short ? { k: asset.k_short, f: asset.f_short_num } : { k: asset.k_long, f: asset.f_long_num };
  const mode = short ? asset.mode_short : asset.mode_long;
  if (mode === MODE_RESET_PENDING && leg.epoch_snap !== U64_MAX_K && leg.epoch_snap + 1n === sideEpoch)
    return short ? { k: asset.k_epoch_start_short, f: asset.f_epoch_start_short_num } : { k: asset.k_epoch_start_long, f: asset.f_epoch_start_long_num };
  failV16(V16_INVALID_LEG);
  return { k: 0n, f: 0n };
}

/** `b_target_for_leg_from_asset(asset, leg)`: as the K/F target, for B and the leg's B epoch. */
export function bTargetForLeg(asset: AssetState, leg: PortfolioLeg): u128 {
  const short = leg.side === 1n;
  const sideEpoch = short ? asset.epoch_short : asset.epoch_long;
  if (leg.b_epoch_snap === sideEpoch) return short ? asset.b_short_num : asset.b_long_num;
  const mode = short ? asset.mode_short : asset.mode_long;
  if (mode === MODE_RESET_PENDING && leg.b_epoch_snap !== U64_MAX_K && leg.b_epoch_snap + 1n === sideEpoch)
    return short ? asset.b_epoch_start_short_num : asset.b_epoch_start_long_num;
  failV16(V16_INVALID_LEG);
  return 0n;
}

/** `scaled_adl_delta_fast(abs_basis, a_basis, then, now)`: the fast exact path of a K/F delta, None when it does not
 * apply (an A other than ADL_ONE, or a product that does not fit). */
export function scaledAdlDeltaFast(absBasis: u128, aBasis: u128, then: i128, now: i128): MaybeI128 {
  if (absBasis === 0n) return { some: 1n, value: 0n };
  if (aBasis !== ADL_ONE) return { some: 0n, value: 0n };
  const adlOne: i128 = 1000000000000000n;
  // now.checked_sub(then)?
  if (then < 0n ? now > toI128(I128_MAX_K) + then : now < -toI128(I128_MAX_K) - 1n + then) return { some: 0n, value: 0n };
  const delta = now - then;
  // i128::try_from(abs_basis)?
  if (absBasis > I128_MAX_K) return { some: 0n, value: 0n };
  const basis = toI128(absBasis);
  if (delta % adlOne !== 0n) {
    // delta.checked_mul(basis)?: |delta · basis| ≤ i128::MAX (or exactly i128::MIN for a negative product).
    if (!mulFitsI128(delta, basis)) return { some: 0n, value: 0n };
    // ADL_ONE · POS_SCALE = 1e21 fits u128.
    return { some: 1n, value: floorDivSigned(delta * basis, ADL_ONE * POS_SCALE) };
  }
  const scaled = delta / adlOne;
  if (!mulFitsI128(scaled, basis)) return { some: 0n, value: 0n };
  return { some: 1n, value: floorDivSigned(scaled * basis, POS_SCALE) };
}

/** Whether a·b fits i128 (b ≥ 0): Rust's `checked_mul`. */
function mulFitsI128(a: i128, b: i128): boolean {
  if (a === 0n || b === 0n) return true;
  const p = toU256(absI(a)) * toU256(absI(b));
  return a < 0n ? p <= I128_MAX_KW + 1n : p <= I128_MAX_KW;
}

/** `f_snap_residual_is_sub_atom(abs_basis, a_basis, f_snap, f_target)`. */
export function fSnapResidualIsSubAtom(absBasis: u128, aBasis: u128, snap: i128, target: i128): boolean {
  if (snap === target) return true;
  if (absBasis === 0n || snap > target) return false;
  // target − snap > 0: checked_sub fails only past i128::MAX.
  if (snap < 0n && target > toI128(I128_MAX_K) + snap) failV16(V16_ARITHMETIC_OVERFLOW);
  const gap = toU128(target - snap);
  if (aBasis > U128_MAX_K / POS_SCALE) failV16(V16_ARITHMETIC_OVERFLOW);
  const den = aBasis * POS_SCALE;
  // gap.checked_mul(abs_basis): an overflow is "not sub-atom".
  if (gap > U128_MAX_K / absBasis) return false;
  return gap * absBasis < den;
}

/** `f_snap_after_settlement(abs_basis, a_basis, f_snap, f_now, f_delta)`: the F snapshot advanced by the signed ceiling
 * of f_delta · den / abs_basis, which must not pass f_now and must leave a sub-atom residual (ArithmeticOverflow). */
export function fSnapAfterSettlement(absBasis: u128, aBasis: u128, snap: i128, now: i128, delta: i128): i128 {
  if (absBasis === 0n || snap === now) return now;
  if (aBasis > U128_MAX_K / POS_SCALE) failV16(V16_ARITHMETIC_OVERFLOW);
  const den = aBasis * POS_SCALE;
  const absDelta = absI(delta);
  // The 256-bit product's quotient and remainder (the original's u128 path gives the same when it fits).
  const p = toU256(absDelta) * toU256(den);
  const qw = p / toU256(absBasis);
  if (qw > U128_MAX_KW) failV16(V16_ARITHMETIC_OVERFLOW);
  const q = toU128(qw);
  const r = p % toU256(absBasis);
  let step: i128 = 0n;
  if (delta >= 0n) {
    if (r !== 0n && q === U128_MAX_K) failV16(V16_ARITHMETIC_OVERFLOW);
    const mag = r !== 0n ? q + 1n : q;
    if (mag > I128_MAX_K) failV16(V16_ARITHMETIC_OVERFLOW);
    step = toI128(mag);
  } else {
    // i128::try_from(q)?.checked_neg(): q ≤ i128::MAX makes the negation fit.
    if (q > I128_MAX_K) failV16(V16_ARITHMETIC_OVERFLOW);
    step = -toI128(q);
  }
  // f_snap.checked_add(step).
  if (step > 0n ? snap > toI128(I128_MAX_K) - step : snap < -toI128(I128_MAX_K) - 1n - step) failV16(V16_ARITHMETIC_OVERFLOW);
  const next = snap + step;
  if (next > now || !fSnapResidualIsSubAtom(absBasis, aBasis, next, now)) failV16(V16_ARITHMETIC_OVERFLOW);
  return next;
}

/** `leg_kf_delta_components_for_settlement_from_asset(asset, leg)`: the leg's K/F target, the K and F deltas (the fast
 * path, else the wide one), their sum (not i128::MIN), and the F snapshot after settlement. */
export function legKfDeltaComponents(asset: AssetState, leg: PortfolioLeg): KfDelta {
  const t = kfTargetForLeg(asset, leg);
  if (leg.a_basis > U128_MAX_K / POS_SCALE) failV16(V16_ARITHMETIC_OVERFLOW);
  const den = leg.a_basis * POS_SCALE;
  const abs = absI(leg.basis_pos_q);
  const kFast = scaledAdlDeltaFast(abs, leg.a_basis, leg.k_snap, t.k);
  const kDelta = kFast.some === 1n ? kFast.value : wideSignedMulDivFloorFromKPair(abs, leg.k_snap, t.k, den);
  const fFast = scaledAdlDeltaFast(abs, leg.a_basis, leg.f_snap, t.f);
  const fDelta = fFast.some === 1n ? fFast.value : wideSignedMulDivFloorFromKPair(abs, leg.f_snap, t.f, den);
  const min: i128 = -toI128(I128_MAX_K) - 1n;
  if (fDelta > 0n ? kDelta > toI128(I128_MAX_K) - fDelta : kDelta < min - fDelta) failV16(V16_ARITHMETIC_OVERFLOW);
  const net = kDelta + fDelta;
  // validate_non_min_i128(net).
  if (net === min) failV16(V16_ARITHMETIC_OVERFLOW);
  const next = fSnapAfterSettlement(abs, leg.a_basis, leg.f_snap, t.f, fDelta);
  return { k_now: t.k, f_now: t.f, k_delta: kDelta, f_delta: fDelta, net, f_snap_next: next };
}

/** `MarketGroupV16ViewMut::account_b_settlement_chunk_from_leg(leg, target, budget)`: how far one chunk moves the leg's
 * B snapshot towards `target` within the loss budget (the config's public B chunk, `publicChunk`, and the caller's). */
export function accountBChunkFromLeg(leg: PortfolioLeg, target: u128, budget: u128, publicChunk: u128): BChunk {
  if (target < leg.b_snap) failV16(V16_RECOVERY_REQUIRED);
  const remaining = target - leg.b_snap;
  if (remaining === 0n) return { delta_b: 0n, loss: 0n, new_remainder: leg.b_rem, remaining_after: 0n };
  if (leg.loss_weight === 0n || budget === 0n) failV16(V16_RECOVERY_REQUIRED);
  const limit = publicChunk < budget ? publicChunk : budget;
  // (limit + 1) · SOCIAL_LOSS_DEN − 1, each step checked.
  if (limit === U128_MAX_K || limit + 1n > U128_MAX_K / SOCIAL_LOSS_DEN) failV16(V16_ARITHMETIC_OVERFLOW);
  const maxNum = (limit + 1n) * SOCIAL_LOSS_DEN - 1n;
  if (leg.b_rem > maxNum) failV16(V16_RECOVERY_REQUIRED);
  const maxDelta = (maxNum - leg.b_rem) / leg.loss_weight;
  const delta = remaining < maxDelta ? remaining : maxDelta;
  if (delta === 0n) failV16(V16_RECOVERY_REQUIRED);
  if (delta > U128_MAX_K / leg.loss_weight) failV16(V16_ARITHMETIC_OVERFLOW);
  const product = leg.loss_weight * delta;
  if (product > U128_MAX_K - leg.b_rem) failV16(V16_ARITHMETIC_OVERFLOW);
  const num = product + leg.b_rem;
  return { delta_b: delta, loss: num / SOCIAL_LOSS_DEN, new_remainder: num % SOCIAL_LOSS_DEN, remaining_after: remaining - delta };
}

/** `leg_has_exhausted_effective_oi(asset, leg)`: an active leg with a position on a side whose effective OI is gone
 * while stored positions remain, nothing pending, and no reset under way. */
export function legHasExhaustedEffectiveOi(asset: AssetState, leg: PortfolioLeg): boolean {
  const short = leg.side === 1n;
  const oi = short ? asset.oi_eff_short_q : asset.oi_eff_long_q;
  const stored = short ? asset.stored_pos_count_short : asset.stored_pos_count_long;
  const pending = short ? asset.pending_obligation_count_short : asset.pending_obligation_count_long;
  const mode = short ? asset.mode_short : asset.mode_long;
  return leg.active === 1n && leg.basis_pos_q !== 0n && oi === 0n && stored !== 0n && pending === 0n && mode !== MODE_RESET_PENDING;
}

/** `asset_contributes_to_loss_stale_summary(asset)`. */
export function assetContributesToLossStale(a: AssetState): boolean {
  return (
    (a.lifecycle === LIFECYCLE_ACTIVE || a.lifecycle === LIFECYCLE_DRAIN_ONLY) &&
    (a.oi_eff_long_q !== 0n ||
      a.oi_eff_short_q !== 0n ||
      a.stored_pos_count_long !== 0n ||
      a.stored_pos_count_short !== 0n ||
      a.stale_account_count_long !== 0n ||
      a.stale_account_count_short !== 0n ||
      a.pending_obligation_count_long !== 0n ||
      a.pending_obligation_count_short !== 0n ||
      a.loss_weight_sum_long !== 0n ||
      a.loss_weight_sum_short !== 0n)
  );
}

/** `asset_is_loss_stale_at_slot(asset, slot)`. */
export function assetIsLossStaleAt(a: AssetState, slot: u64): boolean {
  return a.stale_account_count_long !== 0n || a.stale_account_count_short !== 0n || (assetContributesToLossStale(a) && a.slot_last < slot);
}

/** `MarketGroupV16ViewMut::haircut_effective_support(face, residual, junior_bound)`. */
export function haircutEffectiveSupport(face: u128, residual: u128, junior: u128): u128 {
  if (face === 0n || residual === 0n || junior === 0n) return 0n;
  if (residual >= junior) return face;
  return wideMulDivFloorU128(face, residual, junior);
}

// ---- The account K/F settlement plan's keys ---------------------------------------------------------------------------

/** `account_kf_settlement_plan_key(phase, source_domain, leg_slot)`. */
export function planKey(phase: u8, domain: u64, slot: u64): u64 {
  if (phase > 1n || domain > PLAN_DOMAIN_MAX || slot >= 16n) failV16(V16_INVALID_LEG);
  return (toU64(phase) << PLAN_PHASE_SHIFT) | (domain << 4n) | slot;
}

/** `decode_account_kf_settlement_plan_key(key)` → (phase, source domain, leg slot); a key that does not round-trip
 * is InvalidLeg. */
export function decodePlanKey(key: u64): PlanKey {
  if (key > PLAN_KEY_MAX) failV16(V16_INVALID_LEG);
  // `(key >> 37) as u8`: key ≤ 2^38 − 1, so the phase is 0 or 1.
  const phase = toU8(key >> PLAN_PHASE_SHIFT);
  const domain = (key >> 4n) & PLAN_DOMAIN_MAX;
  const slot = key & 0xfn;
  if (planKey(phase, domain, slot) !== key) failV16(V16_INVALID_LEG);
  return { phase, domain, slot };
}
