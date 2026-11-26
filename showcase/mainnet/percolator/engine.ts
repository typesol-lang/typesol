// A port of Percolator v12.20's risk engine (aeyakovenko/percolator 3f55f87, src/percolator.rs), Copyright Anatoly
// Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// The engine's state lives in the slab (state.ts `RiskEngine`); every function here takes it in place
// (`e: Inout<RiskEngine>`, the original's `&mut self`). Statement for statement the original's, in its order:
//
// - an engine error (`Err(RiskError::…)`) ends the instruction with the code the program maps it to (errors.ts), at
//   the point where the original returns it; the program never looks at these errors, it passes them on with `?`;
// - `assert!` / `expect` are panics with the original's messages (wide.ts for the arithmetic helpers);
// - Rust's release build has no overflow checks: the few plain `+ - *` of the original that could wrap are guarded
//   by the checks before them, so the port's checked operators never fail where the original would wrap.
//
// This file holds what the live instructions need: slot management (bitmap, freelists, materialize, free), PnL /
// capital / reserve bookkeeping, the two-bucket warm-up, live touch and finalize, market accrual (the A/K/F indices),
// fees, deposit, withdraw, settle, close, reclaim, insurance top-up, fee credits, trades (margin checks, the
// open-interest decomposition, trade PnL, trading fees), the conversion of released PnL, liquidation at the oracle
// (full close and the crank's exact partial), enqueue_adl (the A/K loss socialisation, drain-only, the side resets)
// and keeper_crank_not_atomic with its hint validation (resolution is in resolve.ts). The engine's
// garbage_collect_dust is not ported: v12.20's program never calls it (keeper_crank_not_atomic reports
// num_gc_closed 0, "dust GC is NOT part of keeper_crank"); the crank's fee sweep reclaims drained accounts instead.
import { type FixedArray, type FixedVec, type Inout, type InstructionBytes, type Pubkey, type i128, type u8, type u16, type u64, type u128, fixedArray, fixedVec, i128 as toI128, panic, pubkey, require, u16 as toU16, u128 as toU128, u256, u64 as toU64 } from "typesol";
import { PercolatorError, failCorrupt, failOverflow, failUnauthorized } from "./errors.js";
import { type Account, type RiskBuffer, type RiskEngine, type RiskParams, ENGINE_MAX_ACCOUNTS, LIVE, NORMAL, RESET_PENDING, RESOLVED, DRAIN_ONLY, KIND_USER } from "./state.js";
import { I128_MAX, I256_MIN_MAG, U256_MAX, absI128, addWideToI128, feeDebt, mulDivCeilU128, mulDivFloorU128, mulI256Mag, mulU256, signedI128, wideMulDivFloorU128 } from "./wide.js";

// ---- Constants (engine lines 85-142) -----------------------------------------------------------------------------------

export const POS_SCALE = 1000000n;
export const ADL_ONE = 1000000000000000n;
export const MAX_ORACLE_PRICE = 1000000000000n;
export const FUNDING_DEN = 1000000000n;
export const MAX_ABS_FUNDING_E9_PER_SLOT = 10000n;
export const MAX_VAULT_TVL = 10000000000000000n;
export const MAX_POSITION_ABS_Q = 100000000000000n;
export const MAX_MATERIALIZED_ACCOUNTS = 1000000n;
export const MAX_ACCOUNT_POSITIVE_PNL = 100000000000000000000000000000000n;
export const MAX_PNL_POS_TOT = 100000000000000000000000000000000000000n;
export const MAX_PROTOCOL_FEE_ABS = 1000000000000000000000000000000000000n;
export const MAX_RESOLVE_PRICE_DEVIATION_BPS = 10000n;
export const MAX_TOUCHED_PER_INSTRUCTION = 64n;
export const MAX_ACCOUNT_NOTIONAL = 100000000000000000000n;
/** MAX_TRADE_SIZE_Q = MAX_POSITION_ABS_Q; MAX_OI_SIDE_Q has the same value. */
export const MAX_TRADE_SIZE_Q = 100000000000000n;
export const MAX_OI_SIDE_Q = 100000000000000n;
export const U16_MAX = 65535n;
export const ZERO_KEY = pubkey("11111111111111111111111111111111");
const I128_MIN = -170141183460469231731687303715884105728n;

/** Side: positive basis is long, negative short. */
export const LONG = 0n;
export const SHORT = 1n;

// ---- InstructionContext (engine lines 225-304) -------------------------------------------------------------------------

export interface InstructionContext {
  pending_reset_long: boolean;
  pending_reset_short: boolean;
  admit_h_min_shared: u64;
  admit_h_max_shared: u64;
  /** The touched accounts; the original's [u16; 64] and touched_count, as a list of at most 64 (its length the count). */
  touched_accounts: FixedVec<u16, 64>;
  /** The accounts admitted at h_max in this instruction (h_max_sticky_accounts and its count, likewise). */
  h_max_sticky_accounts: FixedVec<u16, 64>;
}

export function isHMaxSticky(ctx: InstructionContext, idx: u16): boolean {
  for (let i = 0n; i < ctx.h_max_sticky_accounts.length; i++) if (ctx.h_max_sticky_accounts.get(i) === idx) return true;
  return false;
}

export function markHMaxSticky(ctx: Inout<InstructionContext>, idx: u16): boolean {
  if (isHMaxSticky(ctx, idx)) return true;
  if (ctx.h_max_sticky_accounts.length < MAX_TOUCHED_PER_INSTRUCTION) {
    ctx.h_max_sticky_accounts.push(idx);
    return true;
  }
  return false;
}

export function addTouched(ctx: Inout<InstructionContext>, idx: u16): boolean {
  const count = ctx.touched_accounts.length;
  for (let i = 0n; i < count; i++) if (ctx.touched_accounts.get(i) === idx) return true;
  if (count < MAX_TOUCHED_PER_INSTRUCTION) {
    ctx.touched_accounts.push(idx);
    return true;
  }
  return false;
}

// ---- Bitmap (engine lines 1031-1050) -----------------------------------------------------------------------------------

export function isUsed(e: RiskEngine, idx: u64): boolean {
  if (idx >= ENGINE_MAX_ACCOUNTS) return false;
  return ((e.used.get(idx >> 6n) >> (idx & 63n)) & 1n) === 1n;
}

function setUsed(e: Inout<RiskEngine>, idx: u64): void {
  const w = idx >> 6n;
  e.used.set(w, e.used.get(w) | (1n << (idx & 63n)));
}

function clearUsed(e: Inout<RiskEngine>, idx: u64): void {
  const w = idx >> 6n;
  e.used.set(w, e.used.get(w) & ~(1n << (idx & 63n)));
}

// ---- init_in_place and validate_params (engine lines 699-1025) --------------------------------------------------------

/** validate_params's asserts, as panics (the program checks the same first, so these do not fire from InitMarket). */
function validateParams(p: RiskParams): void {
  if (!(p.max_accounts <= ENGINE_MAX_ACCOUNTS && p.max_accounts > 0n)) panic("max_accounts must be in 1..=MAX_ACCOUNTS", "src/percolator.rs:701:9");
  if (!(p.max_active_positions_per_side > 0n)) panic("max_active_positions_per_side must be > 0 (spec §1.4)", "src/percolator.rs:708:9");
  if (!(p.max_active_positions_per_side <= p.max_accounts))
    panic("max_active_positions_per_side must be <= max_accounts (spec §1.4)", "src/percolator.rs:712:9");
  if (!(p.maintenance_margin_bps <= p.initial_margin_bps))
    panic("maintenance_margin_bps must be <= initial_margin_bps (spec §1.4)", "src/percolator.rs:718:9");
  if (!(p.initial_margin_bps <= 10000n)) panic("initial_margin_bps must be <= 10_000", "src/percolator.rs:722:9");
  if (!(p.trading_fee_bps <= 10000n)) panic("trading_fee_bps must be <= 10_000", "src/percolator.rs:728:9");
  if (!(p.liquidation_fee_bps <= 10000n)) panic("liquidation_fee_bps must be <= 10_000", "src/percolator.rs:732:9");
  if (!(p.min_nonzero_mm_req > 0n)) panic("min_nonzero_mm_req must be > 0", "src/percolator.rs:740:9");
  if (!(p.min_nonzero_mm_req < p.min_nonzero_im_req))
    panic("min_nonzero_mm_req must be strictly less than min_nonzero_im_req", "src/percolator.rs:744:9");
  if (!(p.min_liquidation_abs <= p.liquidation_fee_cap))
    panic("min_liquidation_abs must be <= liquidation_fee_cap (spec §1.4)", "src/percolator.rs:750:9");
  if (!(p.liquidation_fee_cap <= MAX_PROTOCOL_FEE_ABS))
    panic("liquidation_fee_cap must be <= MAX_PROTOCOL_FEE_ABS (spec §1.4)", "src/percolator.rs:754:9");
  if (!(p.h_min <= p.h_max)) panic("h_min must be <= h_max (spec §6.1)", "src/percolator.rs:760:9");
  if (!(p.h_max > 0n)) panic("h_max must be > 0 (live admission_pair requires h_max > 0 per spec §1.4)", "src/percolator.rs:770:9");
  if (!(p.resolve_price_deviation_bps <= MAX_RESOLVE_PRICE_DEVIATION_BPS))
    panic("resolve_price_deviation_bps must be <= MAX_RESOLVE_PRICE_DEVIATION_BPS", "src/percolator.rs:776:9");
  if (!(p.max_accrual_dt_slots > 0n)) panic("max_accrual_dt_slots must be > 0 (spec §1.4)", "src/percolator.rs:785:9");
  if (!(p.max_abs_funding_e9_per_slot <= MAX_ABS_FUNDING_E9_PER_SLOT))
    panic("max_abs_funding_e9_per_slot must be <= MAX_ABS_FUNDING_E9_PER_SLOT", "src/percolator.rs:789:9");
  // ADL_ONE · MAX_ORACLE_PRICE · rate · dt must fit i128 (computed exactly in U256: a None product fails too).
  const base = u256(ADL_ONE) * u256(MAX_ORACLE_PRICE) * u256(p.max_abs_funding_e9_per_slot);
  const envelopeOk = (u256(p.max_accrual_dt_slots) === 0n || base <= U256_MAX / u256(p.max_accrual_dt_slots)) && base * u256(p.max_accrual_dt_slots) <= u256(I128_MAX);
  if (!envelopeOk)
    panic(
      "funding envelope: ADL_ONE * MAX_ORACLE_PRICE * max_abs_funding_e9_per_slot * max_accrual_dt_slots must fit i128 (spec §1.4)",
      "src/percolator.rs:808:9",
    );
  if (!(p.min_funding_lifetime_slots >= p.max_accrual_dt_slots))
    panic(
      "min_funding_lifetime_slots must be >= max_accrual_dt_slots (cumulative bound must be at least as strong as per-call, spec §1.4)",
      "src/percolator.rs:818:9",
    );
  const lifetimeOk = (base === 0n || u256(p.min_funding_lifetime_slots) <= U256_MAX / base) && base * u256(p.min_funding_lifetime_slots) <= u256(I128_MAX);
  if (!lifetimeOk)
    panic(
      "funding lifetime: ADL_ONE * MAX_ORACLE_PRICE * max_abs_funding_e9_per_slot * min_funding_lifetime_slots must fit i128 (spec §1.4)",
      "src/percolator.rs:837:9",
    );
}

/** init_in_place: every field set, every account canonicalized, the freelist 0 → 1 → … → 4095 → NIL. */
export function initInPlace(e: Inout<RiskEngine>, params: RiskParams, initSlot: u64, initOraclePrice: u64): void {
  validateParams(params);
  if (!(initOraclePrice > 0n && initOraclePrice <= MAX_ORACLE_PRICE))
    panic("init_oracle_price must be in (0, MAX_ORACLE_PRICE] per spec §2.7", "src/percolator.rs:934:9");
  e.vault = 0n;
  e.insurance_balance = 0n;
  e.params = params;
  e.current_slot = initSlot;
  e.market_mode = LIVE;
  e.resolved_price = 0n;
  e.resolved_slot = 0n;
  e.resolved_payout_h_num = 0n;
  e.resolved_payout_h_den = 0n;
  e.resolved_payout_ready = 0n;
  e.resolved_k_long_terminal_delta = 0n;
  e.resolved_k_short_terminal_delta = 0n;
  e.resolved_live_price = 0n;
  e.last_crank_slot = 0n;
  e.c_tot = 0n;
  e.pnl_pos_tot = 0n;
  e.pnl_matured_pos_tot = 0n;
  e.gc_cursor = 0n;
  e.adl_mult_long = ADL_ONE;
  e.adl_mult_short = ADL_ONE;
  e.adl_coeff_long = 0n;
  e.adl_coeff_short = 0n;
  e.adl_epoch_long = 0n;
  e.adl_epoch_short = 0n;
  e.adl_epoch_start_k_long = 0n;
  e.adl_epoch_start_k_short = 0n;
  e.oi_eff_long_q = 0n;
  e.oi_eff_short_q = 0n;
  e.side_mode_long = NORMAL;
  e.side_mode_short = NORMAL;
  e.stored_pos_count_long = 0n;
  e.stored_pos_count_short = 0n;
  e.stale_account_count_long = 0n;
  e.stale_account_count_short = 0n;
  e.phantom_dust_bound_long_q = 0n;
  e.phantom_dust_bound_short_q = 0n;
  e.materialized_account_count = 0n;
  e.neg_pnl_account_count = 0n;
  e.last_oracle_price = initOraclePrice;
  e.fund_px_last = initOraclePrice;
  e.last_market_slot = initSlot;
  e.f_long_num = 0n;
  e.f_short_num = 0n;
  e.f_epoch_start_long_num = 0n;
  e.f_epoch_start_short_num = 0n;
  for (let w = 0n; w < 64n; w++) e.used.set(w, 0n);
  e.num_used_accounts = 0n;
  e.free_head = 0n;
  // Every account canonicalized field by field in the original; here one canonical Account copied into each slot (a
  // memcpy). The fields end the same; the padding bytes between them, which the original leaves as they were, are
  // zero either way: InitMarket, the only caller, zeroes the whole slab first.
  const canon: Account = {
    capital: 0n,
    kind: KIND_USER,
    pad0: fixedArray<u8, 7>(0n),
    pnl: 0n,
    reserved_pnl: 0n,
    position_basis_q: 0n,
    adl_a_basis: ADL_ONE,
    adl_k_snap: 0n,
    f_snap: 0n,
    adl_epoch_snap: 0n,
    matcher_program: ZERO_KEY,
    matcher_context: ZERO_KEY,
    owner: ZERO_KEY,
    fee_credits: 0n,
    last_fee_slot: 0n,
    sched_present: 0n,
    pad1: fixedArray<u8, 7>(0n),
    sched_remaining_q: 0n,
    sched_anchor_q: 0n,
    sched_start_slot: 0n,
    sched_horizon: 0n,
    sched_release_q: 0n,
    pending_present: 0n,
    pad2: fixedArray<u8, 7>(0n),
    pending_remaining_q: 0n,
    pending_horizon: 0n,
    pending_created_slot: 0n,
  };
  for (let i = 0n; i < ENGINE_MAX_ACCOUNTS; i++) e.accounts.set(i, canon);
  e.prev_free.set(0n, U16_MAX);
  for (let i = 0n; i < ENGINE_MAX_ACCOUNTS - 1n; i++) {
    e.next_free.set(i, toU16(i + 1n));
    e.prev_free.set(i + 1n, toU16(i));
  }
  e.next_free.set(ENGINE_MAX_ACCOUNTS - 1n, U16_MAX);
}

// ---- Freelist (engine lines 1072-1267) ---------------------------------------------------------------------------------

/** Every field of the account at `i` back to its free state (free_slot and materialize_at write the same). */
function resetAccount(e: Inout<RiskEngine>, i: u64, lastFeeSlot: u64): void {
  const a = e.accounts.get(i);
  a.capital = 0n;
  a.kind = KIND_USER;
  a.pnl = 0n;
  a.reserved_pnl = 0n;
  a.position_basis_q = 0n;
  a.adl_a_basis = ADL_ONE;
  a.adl_k_snap = 0n;
  a.f_snap = 0n;
  a.adl_epoch_snap = 0n;
  a.matcher_program = ZERO_KEY;
  a.matcher_context = ZERO_KEY;
  a.owner = ZERO_KEY;
  a.fee_credits = 0n;
  a.last_fee_slot = lastFeeSlot;
  a.sched_present = 0n;
  a.sched_remaining_q = 0n;
  a.sched_anchor_q = 0n;
  a.sched_start_slot = 0n;
  a.sched_horizon = 0n;
  a.sched_release_q = 0n;
  a.pending_present = 0n;
  a.pending_remaining_q = 0n;
  a.pending_horizon = 0n;
  a.pending_created_slot = 0n;
}

export function freeSlot(e: Inout<RiskEngine>, idx: u16): void {
  const i = toU64(idx);
  if (i >= ENGINE_MAX_ACCOUNTS) failAccountNotFoundHere();
  if (!isUsed(e, i)) failCorrupt();
  const a = e.accounts.get(i);
  if (a.pnl !== 0n) failCorrupt();
  if (a.reserved_pnl !== 0n) failCorrupt();
  if (a.position_basis_q !== 0n) failCorrupt();
  if (a.sched_present !== 0n || a.pending_present !== 0n) failCorrupt();
  if (a.capital !== 0n) failCorrupt();
  if (a.fee_credits !== 0n) failCorrupt();
  resetAccount(e, i, 0n);
  clearUsed(e, i);
  e.next_free.set(i, e.free_head);
  e.prev_free.set(i, U16_MAX);
  if (e.free_head !== U16_MAX) e.prev_free.set(toU64(e.free_head), idx);
  e.free_head = idx;
  require(e.num_used_accounts !== 0n, PercolatorError.EngineCorruptState);
  e.num_used_accounts -= 1n;
  require(e.materialized_account_count !== 0n, PercolatorError.EngineCorruptState);
  e.materialized_account_count -= 1n;
}

function failAccountNotFoundHere(): void {
  require(false, PercolatorError.EngineAccountNotFound);
}

export function materializeAt(e: Inout<RiskEngine>, idx: u16, slotAnchor: u64): void {
  const i = toU64(idx);
  if (i >= ENGINE_MAX_ACCOUNTS) failAccountNotFoundHere();
  if (i >= e.params.max_accounts) failAccountNotFoundHere();
  if (toU64(e.num_used_accounts) >= e.params.max_accounts) failOverflow();
  require(e.materialized_account_count !== 0xffffffffffffffffn, PercolatorError.EngineOverflow);
  e.materialized_account_count += 1n;
  if (e.materialized_account_count > MAX_MATERIALIZED_ACCOUNTS) {
    e.materialized_account_count -= 1n;
    failOverflow();
  }
  if (isUsed(e, i)) {
    e.materialized_account_count -= 1n;
    failCorrupt();
  }
  const next = e.next_free.get(i);
  const prev = e.prev_free.get(i);
  if (prev === U16_MAX) {
    if (e.free_head !== idx) {
      e.materialized_account_count -= 1n;
      failCorrupt();
    }
  } else {
    if (e.next_free.get(toU64(prev)) !== idx || isUsed(e, toU64(prev))) {
      e.materialized_account_count -= 1n;
      failCorrupt();
    }
  }
  if (next !== U16_MAX) {
    if (e.prev_free.get(toU64(next)) !== idx || isUsed(e, toU64(next))) {
      e.materialized_account_count -= 1n;
      failCorrupt();
    }
  }
  if (prev === U16_MAX) e.free_head = next;
  else e.next_free.set(toU64(prev), next);
  if (next !== U16_MAX) e.prev_free.set(toU64(next), prev);
  e.next_free.set(i, U16_MAX);
  e.prev_free.set(i, U16_MAX);
  setUsed(e, i);
  if (e.num_used_accounts === U16_MAX) panic("num_used_accounts overflow — slot leak corruption", "src/percolator.rs:1229:14");
  e.num_used_accounts += 1n;
  resetAccount(e, i, slotAnchor);
}

// ---- Reserve admission (engine lines 1281-1384) ------------------------------------------------------------------------

function residualAfterSenior(e: RiskEngine): u128 {
  // senior = c_tot + insurance (checked: Overflow); residual = vault - senior (checked: CorruptState).
  require(e.c_tot <= 340282366920938463463374607431768211455n - e.insurance_balance, PercolatorError.EngineOverflow);
  const senior = e.c_tot + e.insurance_balance;
  require(e.vault >= senior, PercolatorError.EngineCorruptState);
  return e.vault - senior;
}

function admitFreshReserveHLock(e: RiskEngine, idx: u64, fresh: u128, ctx: Inout<InstructionContext>, hMin: u64, hMax: u64): u64 {
  if (isHMaxSticky(ctx, toU16(idx))) return hMax;
  const residual = residualAfterSenior(e);
  require(e.pnl_matured_pos_tot <= 340282366920938463463374607431768211455n - fresh, PercolatorError.EngineOverflow);
  const maturedPlusFresh = e.pnl_matured_pos_tot + fresh;
  const admitted = maturedPlusFresh <= residual ? hMin : hMax;
  if (admitted === hMax) {
    if (!markHMaxSticky(ctx, toU16(idx))) failOverflow();
  }
  return admitted;
}

/**
 * admit_outstanding_reserve_on_touch. Its first statement after the mode check, validate_reserve_shape, is left out:
 * the only caller (the live touch) has just validated the same account, unchanged since, so it cannot fail.
 */
function admitOutstandingReserveOnTouch(e: Inout<RiskEngine>, idx: u64): void {
  if (e.market_mode !== LIVE) return;
  const a = e.accounts.get(idx);
  const schedR = a.sched_present !== 0n ? a.sched_remaining_q : 0n;
  const pendR = a.pending_present !== 0n ? a.pending_remaining_q : 0n;
  require(schedR <= 340282366920938463463374607431768211455n - pendR, PercolatorError.EngineCorruptState);
  const reserveTotal = schedR + pendR;
  if (reserveTotal === 0n) return;
  const residual = residualAfterSenior(e);
  require(e.pnl_matured_pos_tot <= 340282366920938463463374607431768211455n - reserveTotal, PercolatorError.EngineOverflow);
  const newMatured = e.pnl_matured_pos_tot + reserveTotal;
  if (newMatured > residual) return;
  if (newMatured > e.pnl_pos_tot) failCorrupt();
  e.pnl_matured_pos_tot = newMatured;
  a.sched_present = 0n;
  a.sched_remaining_q = 0n;
  a.sched_anchor_q = 0n;
  a.sched_start_slot = 0n;
  a.sched_horizon = 0n;
  a.sched_release_q = 0n;
  a.pending_present = 0n;
  a.pending_remaining_q = 0n;
  a.pending_horizon = 0n;
  a.pending_created_slot = 0n;
  a.reserved_pnl = 0n;
}

// ---- set_pnl_with_reserve (engine lines 1391-1544) ---------------------------------------------------------------------

function clampPos(v: i128): u128 {
  return v > 0n ? toU128(v) : 0n;
}

/** neg_pnl_account_count's sign-transition bookkeeping (both arms of set_pnl_with_reserve). */
function trackNegCount(e: Inout<RiskEngine>, old: i128, newPnl: i128): void {
  if (old < 0n && newPnl >= 0n) {
    require(e.neg_pnl_account_count !== 0n, PercolatorError.EngineCorruptState);
    e.neg_pnl_account_count -= 1n;
  } else if (old >= 0n && newPnl < 0n) {
    require(e.neg_pnl_account_count !== 0xffffffffffffffffn, PercolatorError.EngineCorruptState);
    e.neg_pnl_account_count += 1n;
  }
}

/** ReserveMode as the port passes it. */
export const RESERVE_IMMEDIATE_RESOLVED_ONLY = 0n;
export const RESERVE_ADMISSION_PAIR = 1n;
export const RESERVE_NO_POSITIVE_INCREASE = 2n;

/**
 * set_pnl_with_reserve. `mode` is a ReserveMode; for UseAdmissionPair the pair is the context's shared one (every
 * caller in the original passes `ctx.admit_h_min_shared, ctx.admit_h_max_shared` with `Some(ctx)`).
 */
export function setPnlWithReserve(e: Inout<RiskEngine>, idx: u64, newPnl: i128, mode: u64, ctx: Inout<InstructionContext>): void {
  if (newPnl === I128_MIN) failOverflow();
  const a = e.accounts.get(idx);
  const old = a.pnl;
  const reservedBefore = a.reserved_pnl;
  const oldPos = clampPos(old);
  if (reservedBefore > oldPos) failCorrupt();
  if (e.market_mode === LIVE) {
    // old_rel = old_pos - reserved (checked; the check above makes it succeed).
  } else if (reservedBefore !== 0n) failCorrupt();
  const newPos = clampPos(newPnl);
  if (newPos > oldPos) {
    if (mode === RESERVE_NO_POSITIVE_INCREASE) failOverflow();
    else if (mode === RESERVE_IMMEDIATE_RESOLVED_ONLY) {
      if (e.market_mode === LIVE) failUnauthorized();
    } else if (e.market_mode !== LIVE) failUnauthorized();
  }
  if (e.market_mode === LIVE && newPos > MAX_ACCOUNT_POSITIVE_PNL) failOverflow();
  if (newPos > oldPos) {
    const delta = newPos - oldPos;
    require(e.pnl_pos_tot <= 340282366920938463463374607431768211455n - delta, PercolatorError.EngineOverflow);
    if (e.market_mode === LIVE && e.pnl_pos_tot + delta > MAX_PNL_POS_TOT) failOverflow();
  }
  if (newPos > oldPos) e.pnl_pos_tot = e.pnl_pos_tot + (newPos - oldPos);
  else if (oldPos > newPos) {
    require(e.pnl_pos_tot >= oldPos - newPos, PercolatorError.EngineOverflow);
    e.pnl_pos_tot = e.pnl_pos_tot - (oldPos - newPos);
  }

  if (newPos > oldPos) {
    const reserveAdd = newPos - oldPos;
    trackNegCount(e, old, newPnl);
    e.accounts.get(idx).pnl = newPnl;
    if (mode === RESERVE_IMMEDIATE_RESOLVED_ONLY) {
      require(e.pnl_matured_pos_tot <= 340282366920938463463374607431768211455n - reserveAdd, PercolatorError.EngineOverflow);
      e.pnl_matured_pos_tot += reserveAdd;
    } else {
      const hEff = admitFreshReserveHLock(e, idx, reserveAdd, ctx, ctx.admit_h_min_shared, ctx.admit_h_max_shared);
      if (hEff === 0n) {
        require(e.pnl_matured_pos_tot <= 340282366920938463463374607431768211455n - reserveAdd, PercolatorError.EngineOverflow);
        e.pnl_matured_pos_tot += reserveAdd;
      } else appendOrRouteNewReserve(e, idx, reserveAdd, e.current_slot, hEff);
    }
    if (e.pnl_matured_pos_tot > e.pnl_pos_tot) failCorrupt();
    if (e.accounts.get(idx).reserved_pnl > clampPos(newPnl)) failCorrupt();
    return;
  }
  // Case B: no positive increase.
  const posLoss = oldPos - newPos;
  if (e.market_mode === LIVE) {
    const reserveLoss = posLoss < reservedBefore ? posLoss : reservedBefore;
    if (reserveLoss > 0n) applyReserveLossNewestFirst(e, idx, reserveLoss);
    const maturedLoss = posLoss - reserveLoss;
    if (maturedLoss > 0n) {
      require(e.pnl_matured_pos_tot >= maturedLoss, PercolatorError.EngineCorruptState);
      e.pnl_matured_pos_tot -= maturedLoss;
    }
  } else {
    if (reservedBefore !== 0n) failCorrupt();
    if (posLoss > 0n) {
      require(e.pnl_matured_pos_tot >= posLoss, PercolatorError.EngineCorruptState);
      e.pnl_matured_pos_tot -= posLoss;
    }
  }
  trackNegCount(e, old, newPnl);
  const b = e.accounts.get(idx);
  b.pnl = newPnl;
  if (newPos === 0n && e.market_mode === LIVE) {
    if (b.reserved_pnl !== 0n) failCorrupt();
    if (b.sched_present !== 0n) failCorrupt();
    if (b.pending_present !== 0n) failCorrupt();
  }
  if (e.pnl_matured_pos_tot > e.pnl_pos_tot) failCorrupt();
  if (b.reserved_pnl > clampPos(newPnl)) failCorrupt();
}

/** A context for set_pnl's `None` (ImmediateReleaseResolvedOnly never reads it). */
export function emptyContext(hMin: u64, hMax: u64): InstructionContext {
  return {
    pending_reset_long: false,
    pending_reset_short: false,
    admit_h_min_shared: hMin,
    admit_h_max_shared: hMax,
    touched_accounts: fixedVec([]),
    h_max_sticky_accounts: fixedVec([]),
  };
}

/**
 * set_pnl: set_pnl_with_reserve(ImmediateReleaseResolvedOnly, None). That mode never reads or writes the context, so
 * the caller passes the one it has (the same result as None, without building an empty context for each call).
 */
export function setPnl(e: Inout<RiskEngine>, idx: u64, newPnl: i128, unused: Inout<InstructionContext>): void {
  setPnlWithReserve(e, idx, newPnl, RESERVE_IMMEDIATE_RESOLVED_ONLY, unused);
}

/** consume_released_pnl (engine lines 1549-1579). */
export function consumeReleasedPnl(e: Inout<RiskEngine>, idx: u64, x: u128): void {
  if (x === 0n) failCorrupt();
  const a = e.accounts.get(idx);
  const oldPos = clampPos(a.pnl);
  const oldR = a.reserved_pnl;
  require(oldPos >= oldR, PercolatorError.EngineCorruptState);
  const oldRel = oldPos - oldR;
  if (x > oldRel) failCorrupt();
  const newPos = oldPos - x;
  if (newPos < oldR) failCorrupt();
  require(e.pnl_pos_tot >= x, PercolatorError.EngineCorruptState);
  e.pnl_pos_tot -= x;
  require(e.pnl_matured_pos_tot >= x, PercolatorError.EngineCorruptState);
  e.pnl_matured_pos_tot -= x;
  if (e.pnl_matured_pos_tot > e.pnl_pos_tot) failCorrupt();
  require(x <= I128_MAX, PercolatorError.EngineOverflow);
  const xi = toI128(x);
  require(a.pnl >= I128_MIN + xi, PercolatorError.EngineOverflow);
  const newPnl = a.pnl - xi;
  if (newPnl === I128_MIN) failOverflow();
  a.pnl = newPnl;
}

/** set_capital (engine lines 1583-1597). */
export function setCapital(e: Inout<RiskEngine>, idx: u64, newCapital: u128): void {
  const a = e.accounts.get(idx);
  const old = a.capital;
  if (newCapital >= old) {
    const delta = newCapital - old;
    require(e.c_tot <= 340282366920938463463374607431768211455n - delta, PercolatorError.EngineOverflow);
    e.c_tot += delta;
  } else {
    const delta = old - newCapital;
    require(e.c_tot >= delta, PercolatorError.EngineCorruptState);
    e.c_tot -= delta;
  }
  a.capital = newCapital;
}

const I64_SIGN = 0x8000000000000000n;

/** `(count as i64) + after - before` in wrapping i64 arithmetic, as its u64 bit pattern (I64_SIGN and up: negative). */
function wrapNetCount(count: u64, after: u64, before: u64): u64 {
  return toU64((toU128(count) + toU128(after) + 0x10000000000000000n - toU128(before)) & 0xffffffffffffffffn);
}

/** set_position_basis_q (engine lines 1612-1648). */
export function setPositionBasisQ(e: Inout<RiskEngine>, idx: u64, newBasis: i128): void {
  const a = e.accounts.get(idx);
  const old = a.position_basis_q;
  if (old > 0n) {
    require(e.stored_pos_count_long !== 0n, PercolatorError.EngineCorruptState);
    e.stored_pos_count_long -= 1n;
  } else if (old < 0n) {
    require(e.stored_pos_count_short !== 0n, PercolatorError.EngineCorruptState);
    e.stored_pos_count_short -= 1n;
  }
  if (newBasis > 0n) {
    require(e.stored_pos_count_long !== 0xffffffffffffffffn, PercolatorError.EngineCorruptState);
    e.stored_pos_count_long += 1n;
  } else if (newBasis < 0n) {
    require(e.stored_pos_count_short !== 0xffffffffffffffffn, PercolatorError.EngineCorruptState);
    e.stored_pos_count_short += 1n;
  }
  a.position_basis_q = newBasis;
}

// ---- Side accessors (engine lines 1719-1801, 1911-1964) ----------------------------------------------------------------

export function aSide(e: RiskEngine, s: u64): u128 {
  return s === LONG ? e.adl_mult_long : e.adl_mult_short;
}
export function kSide(e: RiskEngine, s: u64): i128 {
  return s === LONG ? e.adl_coeff_long : e.adl_coeff_short;
}
export function epochSide(e: RiskEngine, s: u64): u64 {
  return s === LONG ? e.adl_epoch_long : e.adl_epoch_short;
}
export function kEpochStart(e: RiskEngine, s: u64): i128 {
  return s === LONG ? e.adl_epoch_start_k_long : e.adl_epoch_start_k_short;
}
export function fSide(e: RiskEngine, s: u64): i128 {
  return s === LONG ? e.f_long_num : e.f_short_num;
}
export function fEpochStart(e: RiskEngine, s: u64): i128 {
  return s === LONG ? e.f_epoch_start_long_num : e.f_epoch_start_short_num;
}
export function sideMode(e: RiskEngine, s: u64): u8 {
  return s === LONG ? e.side_mode_long : e.side_mode_short;
}
export function oiEff(e: RiskEngine, s: u64): u128 {
  return s === LONG ? e.oi_eff_long_q : e.oi_eff_short_q;
}
export function staleCount(e: RiskEngine, s: u64): u64 {
  return s === LONG ? e.stale_account_count_long : e.stale_account_count_short;
}
export function storedPosCount(e: RiskEngine, s: u64): u64 {
  return s === LONG ? e.stored_pos_count_long : e.stored_pos_count_short;
}

/** inc_phantom_dust_bound (engine lines 1933-1947). */
export function incPhantomDustBound(e: Inout<RiskEngine>, s: u64): void {
  if (s === LONG) {
    require(e.phantom_dust_bound_long_q !== 340282366920938463463374607431768211455n, PercolatorError.EngineOverflow);
    e.phantom_dust_bound_long_q += 1n;
  } else {
    require(e.phantom_dust_bound_short_q !== 340282366920938463463374607431768211455n, PercolatorError.EngineOverflow);
    e.phantom_dust_bound_short_q += 1n;
  }
}

/**
 * compute_kf_pnl_delta (engine lines 1810-1860): floor(abs_basis · ((k_now - k_snap) · FUNDING_DEN + (f_now - f_snap))
 * / (den · FUNDING_DEN)), one floor on the combined numerator, exact in 256 bits.
 */
export function computeKfPnlDelta(absBasis: u128, kSnap: i128, kNow: i128, fSnap: i128, fNow: i128, den: u128): i128 {
  if (absBasis === 0n) return 0n;
  // combined = (k_now - k_snap) · FUNDING_DEN + (f_now - f_snap), exact (the I256 steps cannot overflow: every term
  // is below 2^158), as its positive and negative parts.
  const fd = u256(FUNDING_DEN);
  const plus = u256(posPart(kNow)) * fd + u256(negPart(kSnap)) * fd + u256(posPart(fNow)) + u256(negPart(fSnap));
  const minus = u256(negPart(kNow)) * fd + u256(posPart(kSnap)) * fd + u256(negPart(fNow)) + u256(posPart(fSnap));
  if (plus === minus) return 0n;
  const cNeg = plus < minus;
  const cMag = cNeg ? minus - plus : plus - minus;
  // den · FUNDING_DEN (den < 2^128: fits).
  const denWide = u256(den) * fd;
  const p = mulU256(u256(absBasis), cMag);
  const q = p / denWide;
  const rem = p % denWide;
  if (cNeg) {
    const mag = rem !== 0n ? q + 1n : q;
    require(mag <= u256(I128_MAX), PercolatorError.EngineOverflow);
    return signedI128(true, toU128(mag));
  }
  require(q <= u256(I128_MAX), PercolatorError.EngineOverflow);
  return toI128(toU128(q));
}

function posPart(v: i128): u128 {
  return v > 0n ? toU128(v) : 0n;
}

function negPart(v: i128): u128 {
  return v < 0n ? absI128(v) : 0n;
}

/** effective_pos_q (engine lines 1971-2011). */
export function effectivePosQ(e: RiskEngine, idx: u64): i128 {
  const a = e.accounts.get(idx);
  const basis = a.position_basis_q;
  if (basis === 0n) return 0n;
  const side = basis > 0n ? LONG : SHORT;
  if (a.adl_epoch_snap !== epochSide(e, side)) return 0n;
  const aBasis = a.adl_a_basis;
  if (aBasis === 0n) return 0n;
  const effAbs = mulDivFloorU128(absI128(basis), aSide(e, side), aBasis);
  if (basis < 0n) {
    if (effAbs === 0n) return 0n;
    if (effAbs > I128_MAX) return 0n;
    return -toI128(effAbs);
  }
  if (effAbs > I128_MAX) return 0n;
  return toI128(effAbs);
}

/** settle_side_effects_live (engine lines 2016-2089). */
function settleSideEffectsLive(e: Inout<RiskEngine>, idx: u64, ctx: Inout<InstructionContext>): void {
  const a = e.accounts.get(idx);
  const basis = a.position_basis_q;
  if (basis === 0n) return;
  const side = basis > 0n ? LONG : SHORT;
  const epochSnap = a.adl_epoch_snap;
  const eSide = epochSide(e, side);
  const aBasis = a.adl_a_basis;
  const kSnap = a.adl_k_snap;
  const fSnap = a.f_snap;
  const pnl = a.pnl;
  if (aBasis === 0n) failCorrupt();
  const absBasis = absI128(basis);
  if (epochSnap === eSide) {
    const aS = aSide(e, side);
    const kS = kSide(e, side);
    const qEffNew = mulDivFloorU128(absBasis, aS, aBasis);
    require(aBasis <= 340282366920938463463374607431768211455n / POS_SCALE, PercolatorError.EngineOverflow);
    const den = aBasis * POS_SCALE;
    const fS = fSide(e, side);
    const delta = computeKfPnlDelta(absBasis, kSnap, kS, fSnap, fS, den);
    const newPnl = checkedAddI128(pnl, delta);
    if (newPnl === I128_MIN) failOverflow();
    setPnlWithReserve(e, idx, newPnl, RESERVE_ADMISSION_PAIR, ctx);
    if (qEffNew === 0n) {
      incPhantomDustBound(e, side);
      setPositionBasisQ(e, idx, 0n);
      resetPositionSnapshots(e, idx);
    } else {
      const b = e.accounts.get(idx);
      b.adl_k_snap = kS;
      b.f_snap = fS;
      b.adl_epoch_snap = eSide;
    }
    return;
  }
  // Epoch mismatch: validate, then mutate.
  if (sideMode(e, side) !== RESET_PENDING) failCorrupt();
  if (epochSnap === 0xffffffffffffffffn || epochSnap + 1n !== eSide) failCorrupt();
  const kStart = kEpochStart(e, side);
  require(aBasis <= 340282366920938463463374607431768211455n / POS_SCALE, PercolatorError.EngineOverflow);
  const den = aBasis * POS_SCALE;
  const fEnd = fEpochStart(e, side);
  const delta = computeKfPnlDelta(absBasis, kSnap, kStart, fSnap, fEnd, den);
  const newPnl = checkedAddI128(pnl, delta);
  if (newPnl === I128_MIN) failOverflow();
  const oldStale = staleCount(e, side);
  require(oldStale !== 0n, PercolatorError.EngineCorruptState);
  setPnlWithReserve(e, idx, newPnl, RESERVE_ADMISSION_PAIR, ctx);
  setPositionBasisQ(e, idx, 0n);
  if (side === LONG) e.stale_account_count_long = oldStale - 1n;
  else e.stale_account_count_short = oldStale - 1n;
  resetPositionSnapshots(e, idx);
}

/** The canonical zero-position snapshots (a_basis ADL_ONE, K, F and the epoch 0). */
function resetPositionSnapshots(e: Inout<RiskEngine>, idx: u64): void {
  const b = e.accounts.get(idx);
  b.adl_a_basis = ADL_ONE;
  b.adl_k_snap = 0n;
  b.f_snap = 0n;
  b.adl_epoch_snap = 0n;
}

/** i128 checked_add with None as RiskError::Overflow. */
export function checkedAddI128(a: i128, b: i128): i128 {
  if (b > 0n) require(a <= I128_MAX - b, PercolatorError.EngineOverflow);
  else require(a >= I128_MIN - b, PercolatorError.EngineOverflow);
  return a + b;
}

// ---- Accrual (engine lines 2116-2282) ----------------------------------------------------------------------------------

export function checkLiveAccrualEnvelope(e: RiskEngine, nowSlot: u64): void {
  const top = e.last_market_slot > 0xffffffffffffffffn - e.params.max_accrual_dt_slots ? 0xffffffffffffffffn : e.last_market_slot + e.params.max_accrual_dt_slots;
  if (nowSlot > top) failOverflow();
}

/** accrue_market_to (spec §5.4): mark-to-market into K, funding into F, all committed only when everything fits. */
export function accrueMarketTo(e: Inout<RiskEngine>, nowSlot: u64, oraclePrice: u64, fundingRateE9: i128): void {
  if (e.market_mode !== LIVE) failUnauthorized();
  if (oraclePrice === 0n || oraclePrice > MAX_ORACLE_PRICE) failOverflow();
  if (absI128(fundingRateE9) > toU128(e.params.max_abs_funding_e9_per_slot)) failOverflow();
  if (nowSlot < e.current_slot) failOverflow();
  if (nowSlot < e.last_market_slot) failOverflow();
  const longLive = e.oi_eff_long_q !== 0n;
  const shortLive = e.oi_eff_short_q !== 0n;
  const totalDt = nowSlot - e.last_market_slot;
  if (totalDt === 0n && e.last_oracle_price === oraclePrice) {
    e.current_slot = nowSlot;
    return;
  }
  const fundingActive = fundingRateE9 !== 0n && longLive && shortLive && e.fund_px_last > 0n;
  if (fundingActive && totalDt > e.params.max_accrual_dt_slots) failOverflow();

  let kLong = e.adl_coeff_long;
  let kShort = e.adl_coeff_short;
  // delta_p = oracle - last (both below 2^64: fits i128).
  const deltaP = toI128(oraclePrice) - toI128(e.last_oracle_price);
  if (deltaP !== 0n) {
    const dpNeg = deltaP < 0n;
    const dpMag = u256(absI128(deltaP));
    // A_side · delta_p in I256. The original's checked_mul_i256 refuses a negative product above 2^127 (its bound is
    // `1u128 << 127`, not 2^255: wide_math.rs), but none is reached: A <= ADL_ONE (1e15: set to it, then only shrunk) and
    // |delta_p| <= MAX_ORACLE_PRICE (1e12, both prices checked against it), so |A · delta_p| <= 1e27 < 2^127.
    if (longLive) kLong = addWideToI128(kLong, dpNeg, u256(e.adl_mult_long) * dpMag);
    if (shortLive) kShort = addWideToI128(kShort, !dpNeg, u256(e.adl_mult_short) * dpMag);
  }

  let fLong = e.f_long_num;
  let fShort = e.f_short_num;
  if (fundingRateE9 !== 0n && totalDt > 0n && longLive && shortLive) {
    const px0 = e.fund_px_last;
    if (px0 > 0n) {
      // fund_num_total = px · rate · dt in I256, then A · fund_num_total. The original's checked_mul_i256 refuses a
      // negative product above 2^127 (see above); none is reached: px <= MAX_ORACLE_PRICE, |rate| <=
      // max_abs_funding_e9_per_slot (checked on entry), dt <= max_accrual_dt_slots (funding is active here, checked
      // above) and A <= ADL_ONE, and InitMarket's envelope bounds ADL_ONE · MAX_ORACLE_PRICE · max_abs_funding ·
      // max_accrual_dt by i128::MAX < 2^127, so every product here is below 2^127. Past that bound (a patched slab
      // only) the original fails with EngineOverflow where mulI256Mag multiplies exactly (README, "Differences").
      const rNeg = fundingRateE9 < 0n;
      const fundMag = mulI256Mag(rNeg, mulI256Mag(false, u256(px0), rNeg, u256(absI128(fundingRateE9))), false, u256(totalDt));
      // F_long -= A_long · fund_num_total; F_short += A_short · fund_num_total.
      const dfLong = mulI256Mag(false, u256(e.adl_mult_long), rNeg, fundMag);
      fLong = addWideToI128(fLong, !rNeg, dfLong);
      const dfShort = mulI256Mag(false, u256(e.adl_mult_short), rNeg, fundMag);
      fShort = addWideToI128(fShort, rNeg, dfShort);
    }
  }
  e.adl_coeff_long = kLong;
  e.adl_coeff_short = kShort;
  e.f_long_num = fLong;
  e.f_short_num = fShort;
  e.current_slot = nowSlot;
  e.last_market_slot = nowSlot;
  e.last_oracle_price = oraclePrice;
  e.fund_px_last = oraclePrice;
}

export function validateAdmissionPair(hMin: u64, hMax: u64, p: RiskParams): void {
  if (hMax === 0n) failOverflow();
  if (hMax < p.h_min) failOverflow();
  if (hMin > hMax) failOverflow();
  if (hMax > p.h_max) failOverflow();
  if (hMin > 0n && hMin < p.h_min) failOverflow();
}

// ---- Losses and fees (engine lines 2291-2407, 4127-4164) ---------------------------------------------------------------

function useInsuranceBuffer(e: Inout<RiskEngine>, loss: u128): u128 {
  if (loss === 0n) return 0n;
  const bal = e.insurance_balance;
  const pay = loss < bal ? loss : bal;
  if (pay > 0n) e.insurance_balance = bal - pay;
  return loss - pay;
}

export function absorbProtocolLoss(e: Inout<RiskEngine>, loss: u128): void {
  if (loss === 0n) return;
  useInsuranceBuffer(e, loss);
}

/**
 * charge_fee_to_insurance: capital pays what it can, the rest becomes fee debt down to -(i128::MAX), the rest dropped.
 * Returns the equity impact (capital paid plus the debt booked), the middle of the original's three results.
 */
export function chargeFeeToInsurance(e: Inout<RiskEngine>, idx: u64, fee: u128): u128 {
  if (fee > MAX_PROTOCOL_FEE_ABS) failOverflow();
  const a = e.accounts.get(idx);
  const cap = a.capital;
  const paid = fee < cap ? fee : cap;
  if (paid > 0n) {
    setCapital(e, idx, cap - paid);
    require(e.insurance_balance <= 340282366920938463463374607431768211455n - paid, PercolatorError.EngineOverflow);
    e.insurance_balance += paid;
  }
  const shortfall = fee - paid;
  if (shortfall > 0n) {
    const b = e.accounts.get(idx);
    const fc = b.fee_credits;
    // headroom = fc.checked_add(i128::MAX) when it is Some and positive, else 0.
    let headroom: u128 = 0n;
    if (fc <= 0n && fc + I128_MAX > 0n) headroom = toU128(fc + I128_MAX);
    const collectible = shortfall < headroom ? shortfall : headroom;
    if (collectible > 0n) b.fee_credits = fc - toI128(collectible);
    return paid + collectible;
  }
  return paid;
}

/** sync_account_fee_to_slot (the explicit-anchor helper). */
function syncAccountFeeToSlot(e: Inout<RiskEngine>, idx: u64, anchor: u64, rate: u128): void {
  if (idx >= ENGINE_MAX_ACCOUNTS || !isUsed(e, idx)) failAccountNotFoundHere();
  const a = e.accounts.get(idx);
  const last = a.last_fee_slot;
  if (anchor < last) failOverflow();
  if (e.market_mode === LIVE) {
    if (anchor > e.current_slot) failOverflow();
  } else if (anchor > e.resolved_slot) failOverflow();
  const dt = anchor - last;
  if (dt === 0n) return;
  if (rate === 0n) {
    a.last_fee_slot = anchor;
    return;
  }
  // rate · dt exactly (below 2^192), capped at MAX_PROTOCOL_FEE_ABS.
  const raw = u256(rate) * u256(dt);
  let feeAbs: u128 = MAX_PROTOCOL_FEE_ABS;
  if (raw <= u256(MAX_PROTOCOL_FEE_ABS)) feeAbs = toU128(raw);
  if (feeAbs > 0n) chargeFeeToInsurance(e, idx, feeAbs);
  e.accounts.get(idx).last_fee_slot = anchor;
}

/** sync_account_fee_to_slot_not_atomic: the anchor is current_slot (after moving it to now) or resolved_slot. */
export function syncAccountFeeToSlotNotAtomic(e: Inout<RiskEngine>, idx: u16, nowSlot: u64, rate: u128): void {
  const i = toU64(idx);
  if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) failAccountNotFoundHere();
  if (nowSlot < e.current_slot) failOverflow();
  if (e.market_mode === LIVE) checkLiveAccrualEnvelope(e, nowSlot);
  let anchor = e.resolved_slot;
  if (e.market_mode === LIVE) {
    e.current_slot = nowSlot;
    anchor = e.current_slot;
  }
  syncAccountFeeToSlot(e, i, anchor, rate);
  assertPublicPostconditions(e);
}

// ---- End-of-instruction resets (engine lines 2591-2793) ----------------------------------------------------------------

function beginFullDrainReset(e: Inout<RiskEngine>, side: u64): void {
  if (oiEff(e, side) !== 0n) failCorrupt();
  if (side === LONG) {
    e.adl_epoch_start_k_long = e.adl_coeff_long;
    e.f_epoch_start_long_num = e.f_long_num;
    e.adl_coeff_long = 0n;
    e.f_long_num = 0n;
    require(e.adl_epoch_long !== 0xffffffffffffffffn, PercolatorError.EngineOverflow);
    e.adl_epoch_long += 1n;
    e.adl_mult_long = ADL_ONE;
    e.stale_account_count_long = e.stored_pos_count_long;
    e.phantom_dust_bound_long_q = 0n;
    e.side_mode_long = RESET_PENDING;
  } else {
    e.adl_epoch_start_k_short = e.adl_coeff_short;
    e.f_epoch_start_short_num = e.f_short_num;
    e.adl_coeff_short = 0n;
    e.f_short_num = 0n;
    require(e.adl_epoch_short !== 0xffffffffffffffffn, PercolatorError.EngineOverflow);
    e.adl_epoch_short += 1n;
    e.adl_mult_short = ADL_ONE;
    e.stale_account_count_short = e.stored_pos_count_short;
    e.phantom_dust_bound_short_q = 0n;
    e.side_mode_short = RESET_PENDING;
  }
}

export function scheduleEndOfInstructionResets(e: Inout<RiskEngine>, ctx: Inout<InstructionContext>): void {
  if (e.stored_pos_count_long === 0n && e.stored_pos_count_short === 0n) {
    require(e.phantom_dust_bound_long_q <= 340282366920938463463374607431768211455n - e.phantom_dust_bound_short_q, PercolatorError.EngineCorruptState);
    const clearBound = e.phantom_dust_bound_long_q + e.phantom_dust_bound_short_q;
    const hasResidual = e.oi_eff_long_q !== 0n || e.oi_eff_short_q !== 0n || e.phantom_dust_bound_long_q !== 0n || e.phantom_dust_bound_short_q !== 0n;
    if (hasResidual) {
      if (e.oi_eff_long_q !== e.oi_eff_short_q) failCorrupt();
      if (e.oi_eff_long_q <= clearBound && e.oi_eff_short_q <= clearBound) {
        e.oi_eff_long_q = 0n;
        e.oi_eff_short_q = 0n;
        ctx.pending_reset_long = true;
        ctx.pending_reset_short = true;
      } else failCorrupt();
    }
  } else if (e.stored_pos_count_long === 0n && e.stored_pos_count_short > 0n) {
    const hasResidual = e.oi_eff_long_q !== 0n || e.oi_eff_short_q !== 0n || e.phantom_dust_bound_long_q !== 0n;
    if (hasResidual) {
      if (e.oi_eff_long_q !== e.oi_eff_short_q) failCorrupt();
      if (e.oi_eff_long_q <= e.phantom_dust_bound_long_q) {
        e.oi_eff_long_q = 0n;
        e.oi_eff_short_q = 0n;
        ctx.pending_reset_long = true;
        ctx.pending_reset_short = true;
      } else failCorrupt();
    }
  } else if (e.stored_pos_count_short === 0n && e.stored_pos_count_long > 0n) {
    const hasResidual = e.oi_eff_long_q !== 0n || e.oi_eff_short_q !== 0n || e.phantom_dust_bound_short_q !== 0n;
    if (hasResidual) {
      if (e.oi_eff_long_q !== e.oi_eff_short_q) failCorrupt();
      if (e.oi_eff_short_q <= e.phantom_dust_bound_short_q) {
        e.oi_eff_long_q = 0n;
        e.oi_eff_short_q = 0n;
        ctx.pending_reset_long = true;
        ctx.pending_reset_short = true;
      } else failCorrupt();
    }
  }
  if (e.side_mode_long === DRAIN_ONLY && e.oi_eff_long_q === 0n) ctx.pending_reset_long = true;
  if (e.side_mode_short === DRAIN_ONLY && e.oi_eff_short_q === 0n) ctx.pending_reset_short = true;
}

export function finalizeEndOfInstructionResets(e: Inout<RiskEngine>, ctx: InstructionContext): void {
  if (ctx.pending_reset_long && e.side_mode_long !== RESET_PENDING) beginFullDrainReset(e, LONG);
  if (ctx.pending_reset_short && e.side_mode_short !== RESET_PENDING) beginFullDrainReset(e, SHORT);
  maybeFinalizeReadyResetSides(e);
}

export function maybeFinalizeReadyResetSides(e: Inout<RiskEngine>): void {
  if (e.side_mode_long === RESET_PENDING && e.oi_eff_long_q === 0n && e.stale_account_count_long === 0n && e.stored_pos_count_long === 0n)
    e.side_mode_long = NORMAL;
  if (e.side_mode_short === RESET_PENDING && e.oi_eff_short_q === 0n && e.stale_account_count_short === 0n && e.stored_pos_count_short === 0n)
    e.side_mode_short = NORMAL;
}

// ---- Haircut and equity (engine lines 2801-2968) -----------------------------------------------------------------------

/** haircut_ratio: (min(Residual, matured), matured), or (1, 1) with nothing matured. */
export function haircutNum(e: RiskEngine): u128 {
  if (e.pnl_matured_pos_tot === 0n) return 1n;
  let residual: u128 = 0n;
  if (e.c_tot <= 340282366920938463463374607431768211455n - e.insurance_balance) {
    const ss = e.c_tot + e.insurance_balance;
    if (e.vault >= ss) residual = e.vault - ss;
  }
  return residual < e.pnl_matured_pos_tot ? residual : e.pnl_matured_pos_tot;
}
export function haircutDen(e: RiskEngine): u128 {
  return e.pnl_matured_pos_tot === 0n ? 1n : e.pnl_matured_pos_tot;
}

/** released_pos: max(PNL, 0) - R, saturating. */
export function releasedPos(e: RiskEngine, idx: u64): u128 {
  const a = e.accounts.get(idx);
  const pos = clampPos(a.pnl);
  return pos > a.reserved_pnl ? pos - a.reserved_pnl : 0n;
}

export function effectiveMaturedPnl(e: RiskEngine, idx: u64): u128 {
  const released = releasedPos(e, idx);
  if (released === 0n) return 0n;
  const hDen = haircutDen(e);
  if (hDen === 0n) return released;
  return wideMulDivFloorU128(released, haircutNum(e), hDen);
}

/**
 * Eq_withdraw_raw (= Eq_init_raw): C + min(PNL, 0) + PNL_eff_matured - FeeDebt in I256, then i128 (i128::MIN + 1 when
 * it does not fit). The sum's magnitude stays far below 2^255, so the `expect`s on the I256 adds never fire.
 */
export function accountEquityWithdrawRaw(e: RiskEngine, idx: u64): i128 {
  const a = e.accounts.get(idx);
  // positive part: C + eff_matured; negative part: |min(PNL, 0)| + FeeDebt.
  const pos = u256(a.capital) + u256(effectiveMaturedPnl(e, idx));
  const neg = u256(a.pnl < 0n ? absI128(a.pnl) : 0n) + u256(feeDebt(a.fee_credits));
  if (pos >= neg) {
    const d = pos - neg;
    return d <= u256(I128_MAX) ? toI128(toU128(d)) : I128_MIN + 1n;
  }
  const d = neg - pos;
  return d <= u256(I128_MAX) + 1n ? signedI128(true, toU128(d)) : I128_MIN + 1n;
}

/** Eq_maint_raw: C + PNL - FeeDebt, as i128 (i128::MIN + 1 when it does not fit). */
export function accountEquityMaintRaw(e: RiskEngine, idx: u64): i128 {
  const a = e.accounts.get(idx);
  const pos = u256(a.capital) + u256(a.pnl > 0n ? toU128(a.pnl) : 0n);
  const neg = u256(a.pnl < 0n ? absI128(a.pnl) : 0n) + u256(feeDebt(a.fee_credits));
  if (pos >= neg) {
    const d = pos - neg;
    return d <= u256(I128_MAX) ? toI128(toU128(d)) : I128_MIN + 1n;
  }
  const d = neg - pos;
  return d <= u256(I128_MAX) + 1n ? signedI128(true, toU128(d)) : I128_MIN + 1n;
}

/** notional: floor(|effective_pos_q| · price / POS_SCALE). */
export function notional(e: RiskEngine, idx: u64, oraclePrice: u64): u128 {
  const eff = effectivePosQ(e, idx);
  if (eff === 0n) return 0n;
  return mulDivFloorU128(absI128(eff), toU128(oraclePrice), POS_SCALE);
}

// ---- Conservation (engine lines 3051-3126) -----------------------------------------------------------------------------

export function checkConservation(e: RiskEngine): boolean {
  if (e.c_tot > 340282366920938463463374607431768211455n - e.insurance_balance) return false;
  return e.vault >= e.c_tot + e.insurance_balance;
}

function sweepEmptyMarketSurplusToInsurance(e: Inout<RiskEngine>): void {
  if (e.num_used_accounts !== 0n) return;
  if (e.c_tot !== 0n || e.pnl_pos_tot !== 0n || e.pnl_matured_pos_tot !== 0n || e.oi_eff_long_q !== 0n || e.oi_eff_short_q !== 0n) return;
  const v = e.vault;
  const i = e.insurance_balance;
  if (v < i) failCorrupt();
  const surplus = v - i;
  if (surplus !== 0n) e.insurance_balance = i + surplus;
}

export function assertPublicPostconditions(e: RiskEngine): void {
  if (!checkConservation(e)) failCorrupt();
  if (e.oi_eff_long_q !== e.oi_eff_short_q) failCorrupt();
}

// ---- Two-bucket warm-up (engine lines 3148-3447) -----------------------------------------------------------------------

function appendOrRouteNewReserve(e: Inout<RiskEngine>, idx: u64, reserveAdd: u128, nowSlot: u64, hLock: u64): void {
  validateReserveShape(e, idx);
  const a = e.accounts.get(idx);
  if (a.sched_present === 0n && a.pending_present !== 0n) {
    a.sched_present = 1n;
    a.sched_remaining_q = a.pending_remaining_q;
    a.sched_anchor_q = a.pending_remaining_q;
    a.sched_start_slot = nowSlot;
    a.sched_horizon = a.pending_horizon;
    a.sched_release_q = 0n;
    a.pending_present = 0n;
    a.pending_remaining_q = 0n;
    a.pending_horizon = 0n;
    a.pending_created_slot = 0n;
  }
  if (a.sched_present === 0n) {
    a.sched_present = 1n;
    a.sched_remaining_q = reserveAdd;
    a.sched_anchor_q = reserveAdd;
    a.sched_start_slot = nowSlot;
    a.sched_horizon = hLock;
    a.sched_release_q = 0n;
  } else if (a.sched_present !== 0n && a.pending_present === 0n && a.sched_start_slot === nowSlot && a.sched_horizon === hLock && a.sched_release_q === 0n) {
    require(a.sched_remaining_q <= 340282366920938463463374607431768211455n - reserveAdd, PercolatorError.EngineOverflow);
    a.sched_remaining_q += reserveAdd;
    require(a.sched_anchor_q <= 340282366920938463463374607431768211455n - reserveAdd, PercolatorError.EngineOverflow);
    a.sched_anchor_q += reserveAdd;
  } else if (a.pending_present === 0n) {
    a.pending_present = 1n;
    a.pending_remaining_q = reserveAdd;
    a.pending_horizon = hLock;
    a.pending_created_slot = nowSlot;
  } else {
    require(a.pending_remaining_q <= 340282366920938463463374607431768211455n - reserveAdd, PercolatorError.EngineOverflow);
    a.pending_remaining_q += reserveAdd;
    if (hLock > a.pending_horizon) a.pending_horizon = hLock;
  }
  require(a.reserved_pnl <= 340282366920938463463374607431768211455n - reserveAdd, PercolatorError.EngineOverflow);
  a.reserved_pnl += reserveAdd;
}

function applyReserveLossNewestFirst(e: Inout<RiskEngine>, idx: u64, reserveLoss: u128): void {
  validateReserveShape(e, idx);
  const a = e.accounts.get(idx);
  const pendAvail = a.pending_present !== 0n ? a.pending_remaining_q : 0n;
  const schedAvail = a.sched_present !== 0n ? a.sched_remaining_q : 0n;
  require(pendAvail <= 340282366920938463463374607431768211455n - schedAvail, PercolatorError.EngineCorruptState);
  if (reserveLoss > pendAvail + schedAvail) failCorrupt();
  require(a.reserved_pnl >= reserveLoss, PercolatorError.EngineCorruptState);
  const newReserved = a.reserved_pnl - reserveLoss;
  const takePend = reserveLoss < pendAvail ? reserveLoss : pendAvail;
  const takeSched = reserveLoss - takePend;
  if (takePend > 0n) {
    a.pending_remaining_q -= takePend;
    if (a.pending_remaining_q === 0n) {
      a.pending_present = 0n;
      a.pending_horizon = 0n;
      a.pending_created_slot = 0n;
    }
  }
  if (takeSched > 0n) {
    a.sched_remaining_q -= takeSched;
    if (a.sched_remaining_q === 0n) {
      a.sched_present = 0n;
      a.sched_anchor_q = 0n;
      a.sched_start_slot = 0n;
      a.sched_horizon = 0n;
      a.sched_release_q = 0n;
    }
  }
  a.reserved_pnl = newReserved;
}

function validateReserveShape(e: RiskEngine, idx: u64): void {
  const a = e.accounts.get(idx);
  if (a.sched_present === 0n) {
    if (a.sched_remaining_q !== 0n || a.sched_anchor_q !== 0n || a.sched_start_slot !== 0n || a.sched_horizon !== 0n || a.sched_release_q !== 0n) failCorrupt();
  } else {
    if (a.sched_horizon === 0n) failCorrupt();
    if (a.sched_horizon < e.params.h_min) failCorrupt();
    if (a.sched_horizon > e.params.h_max) failCorrupt();
    if (a.sched_release_q > a.sched_anchor_q) failCorrupt();
    require(a.sched_remaining_q <= 340282366920938463463374607431768211455n - a.sched_release_q, PercolatorError.EngineCorruptState);
    if (a.sched_remaining_q + a.sched_release_q > a.sched_anchor_q) failCorrupt();
  }
  if (a.sched_present !== 0n && a.sched_remaining_q === 0n) failCorrupt();
  if (a.pending_present === 0n) {
    if (a.pending_remaining_q !== 0n || a.pending_horizon !== 0n || a.pending_created_slot !== 0n) failCorrupt();
  } else {
    if (a.pending_horizon === 0n) failCorrupt();
    if (a.pending_horizon < e.params.h_min) failCorrupt();
    if (a.pending_horizon > e.params.h_max) failCorrupt();
    if (a.pending_remaining_q === 0n) failCorrupt();
  }
  const schedR = a.sched_present !== 0n ? a.sched_remaining_q : 0n;
  const pendR = a.pending_present !== 0n ? a.pending_remaining_q : 0n;
  require(schedR <= 340282366920938463463374607431768211455n - pendR, PercolatorError.EngineCorruptState);
  if (schedR + pendR !== a.reserved_pnl) failCorrupt();
  if (a.reserved_pnl > clampPos(a.pnl)) failCorrupt();
}

function promotePending(a: Inout<Account>, startSlot: u64): void {
  a.sched_present = 1n;
  a.sched_remaining_q = a.pending_remaining_q;
  a.sched_anchor_q = a.pending_remaining_q;
  a.sched_start_slot = startSlot;
  a.sched_horizon = a.pending_horizon;
  a.sched_release_q = 0n;
  a.pending_present = 0n;
  a.pending_remaining_q = 0n;
  a.pending_horizon = 0n;
  a.pending_created_slot = 0n;
}

/**
 * advance_profit_warmup. Its first statement, validate_reserve_shape, is left out: the only caller (the live touch)
 * validated the account just before admit_outstanding_reserve_on_touch, which either left it unchanged or cleared every
 * reserve field (a valid shape), so the check cannot fail.
 */
function advanceProfitWarmup(e: Inout<RiskEngine>, idx: u64): void {
  const a = e.accounts.get(idx);
  if (a.reserved_pnl === 0n) return;
  if (a.sched_present === 0n && a.pending_present !== 0n) promotePending(a, e.current_slot);
  if (a.sched_present === 0n) failCorrupt();
  if (e.current_slot < a.sched_start_slot) failCorrupt();
  const elapsed = toU128(e.current_slot - a.sched_start_slot);
  if (a.sched_horizon === 0n) failCorrupt();
  const schedTotal = elapsed >= toU128(a.sched_horizon) ? a.sched_anchor_q : mulDivFloorU128(a.sched_anchor_q, elapsed, toU128(a.sched_horizon));
  if (schedTotal < a.sched_release_q) failCorrupt();
  const increment = schedTotal - a.sched_release_q;
  const release = a.sched_remaining_q < increment ? a.sched_remaining_q : increment;
  if (release > 0n) {
    a.sched_remaining_q -= release;
    require(a.reserved_pnl >= release, PercolatorError.EngineCorruptState);
    a.reserved_pnl -= release;
    require(e.pnl_matured_pos_tot <= 340282366920938463463374607431768211455n - release, PercolatorError.EngineOverflow);
    e.pnl_matured_pos_tot += release;
  }
  a.sched_release_q = schedTotal;
  if (a.sched_remaining_q === 0n) {
    a.sched_present = 0n;
    a.sched_anchor_q = 0n;
    a.sched_start_slot = 0n;
    a.sched_horizon = 0n;
    a.sched_release_q = 0n;
    if (a.pending_present !== 0n) promotePending(a, e.current_slot);
  }
  if (a.reserved_pnl === 0n) {
    if (a.sched_present !== 0n || a.pending_present !== 0n) failCorrupt();
  }
  if (e.pnl_matured_pos_tot > e.pnl_pos_tot) failCorrupt();
}

// ---- Loss settlement, fee sweep, touch (engine lines 3454-3613) --------------------------------------------------------

function settleLosses(e: Inout<RiskEngine>, idx: u64, ctx: Inout<InstructionContext>): void {
  const a = e.accounts.get(idx);
  const pnl = a.pnl;
  if (pnl >= 0n) return;
  if (pnl === I128_MIN) failCorrupt();
  const need = absI128(pnl);
  const cap = a.capital;
  const pay = need < cap ? need : cap;
  if (pay > 0n) {
    setCapital(e, idx, cap - pay);
    const newPnl = pnl + toI128(pay);
    setPnl(e, idx, newPnl, ctx);
  }
}

function resolveFlatNegative(e: Inout<RiskEngine>, idx: u64, ctx: Inout<InstructionContext>): void {
  if (effectivePosQ(e, idx) !== 0n) return;
  const pnl = e.accounts.get(idx).pnl;
  if (pnl < 0n) {
    if (pnl === I128_MIN) failCorrupt();
    absorbProtocolLoss(e, absI128(pnl));
    setPnl(e, idx, 0n, ctx);
  }
}

function feeDebtSweep(e: Inout<RiskEngine>, idx: u64): void {
  const a = e.accounts.get(idx);
  const debt = feeDebt(a.fee_credits);
  if (debt === 0n) return;
  const cap = a.capital;
  const pay = debt < cap ? debt : cap;
  if (pay > 0n) {
    setCapital(e, idx, cap - pay);
    const payI: i128 = pay < I128_MAX ? toI128(pay) : I128_MAX;
    const b = e.accounts.get(idx);
    require(b.fee_credits <= I128_MAX - payI, PercolatorError.EngineCorruptState);
    b.fee_credits = b.fee_credits + payI;
    require(e.insurance_balance <= 340282366920938463463374607431768211455n - pay, PercolatorError.EngineOverflow);
    e.insurance_balance += pay;
  }
}

function touchAccountLiveLocal(e: Inout<RiskEngine>, idx: u64, ctx: Inout<InstructionContext>): void {
  if (e.market_mode !== LIVE) failUnauthorized();
  if (idx >= ENGINE_MAX_ACCOUNTS || !isUsed(e, idx)) failAccountNotFoundHere();
  if (!addTouched(ctx, toU16(idx))) failOverflow();
  validateReserveShape(e, idx);
  admitOutstandingReserveOnTouch(e, idx);
  advanceProfitWarmup(e, idx);
  settleSideEffectsLive(e, idx, ctx);
  settleLosses(e, idx, ctx);
  if (effectivePosQ(e, idx) === 0n && e.accounts.get(idx).pnl < 0n) resolveFlatNegative(e, idx, ctx);
}

function finalizeTouchedAccountsPostLive(e: Inout<RiskEngine>, ctx: InstructionContext): void {
  let residual: u128 = 0n;
  if (e.c_tot <= 340282366920938463463374607431768211455n - e.insurance_balance) {
    const ss = e.c_tot + e.insurance_balance;
    if (e.vault >= ss) residual = e.vault - ss;
  } else residual = 0n;
  const hDen = e.pnl_matured_pos_tot;
  const hNum = hDen === 0n ? 0n : residual < hDen ? residual : hDen;
  const isWhole = hDen > 0n && hNum === hDen;
  // The touched set in ascending order (insertion sort, as the original).
  const count = ctx.touched_accounts.length;
  const sorted: FixedVec<u16, 64> = ctx.touched_accounts;
  for (let i = 1n; i < count; i++) {
    let j = i;
    while (j > 0n && sorted.get(j - 1n) > sorted.get(j)) {
      const t = sorted.get(j - 1n);
      sorted.set(j - 1n, sorted.get(j));
      sorted.set(j, t);
      j -= 1n;
    }
  }
  for (let ti = 0n; ti < count; ti++) {
    const idx = toU64(sorted.get(ti));
    if (isWhole && e.accounts.get(idx).position_basis_q === 0n && e.accounts.get(idx).pnl > 0n) {
      const released = releasedPos(e, idx);
      if (released > 0n) {
        consumeReleasedPnl(e, idx, released);
        const cap = e.accounts.get(idx).capital;
        require(cap <= 340282366920938463463374607431768211455n - released, PercolatorError.EngineOverflow);
        setCapital(e, idx, cap + released);
      }
    }
    feeDebtSweep(e, idx);
  }
}

// ---- Public entrypoints (engine lines 3619-3850, 4843-4908, 5296-5356, 5441-5465, 5650-5695) ---------------------------

export function setOwner(e: Inout<RiskEngine>, idx: u16, owner: Pubkey): void {
  const i = toU64(idx);
  if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) failUnauthorized();
  if (owner === ZERO_KEY) failUnauthorized();
  const a = e.accounts.get(i);
  if (a.owner !== ZERO_KEY) failUnauthorized();
  a.owner = owner;
}

export function depositNotAtomic(e: Inout<RiskEngine>, idx: u16, amount: u128, nowSlot: u64): void {
  const i = toU64(idx);
  if (e.market_mode !== LIVE) failUnauthorized();
  if (nowSlot < e.current_slot) failOverflow();
  if (nowSlot < e.last_market_slot) failOverflow();
  checkLiveAccrualEnvelope(e, nowSlot);
  require(e.vault <= 340282366920938463463374607431768211455n - amount, PercolatorError.EngineOverflow);
  const vCandidate = e.vault + amount;
  if (vCandidate > MAX_VAULT_TVL) failOverflow();
  if (!isUsed(e, i)) {
    if (amount === 0n) require(false, PercolatorError.EngineInsufficientBalance);
    materializeAt(e, idx, nowSlot);
  }
  if (isUsed(e, i) && e.accounts.get(i).pnl === I128_MIN) failCorrupt();
  e.current_slot = nowSlot;
  e.vault = vCandidate;
  const cap = e.accounts.get(i).capital;
  require(cap <= 340282366920938463463374607431768211455n - amount, PercolatorError.EngineOverflow);
  setCapital(e, i, cap + amount);
  // settle_losses (a no-op unless PnL is negative: only then is a context built for set_pnl).
  if (e.accounts.get(i).pnl < 0n) {
    const none = emptyContext(0n, 0n);
    settleLosses(e, i, none);
  }
  if (e.accounts.get(i).position_basis_q === 0n && e.accounts.get(i).pnl >= 0n) feeDebtSweep(e, i);
  assertPublicPostconditions(e);
}

export function withdrawNotAtomic(e: Inout<RiskEngine>, idx: u16, amount: u128, oraclePrice: u64, nowSlot: u64, fundingRateE9: i128, hMin: u64, hMax: u64): void {
  const i = toU64(idx);
  validateAdmissionPair(hMin, hMax, e.params);
  if (oraclePrice === 0n || oraclePrice > MAX_ORACLE_PRICE) failOverflow();
  if (!isUsed(e, i)) failAccountNotFoundHere();
  if (e.market_mode !== LIVE) failUnauthorized();
  const ctx = emptyContext(hMin, hMax);
  accrueMarketTo(e, nowSlot, oraclePrice, fundingRateE9);
  e.current_slot = nowSlot;
  touchAccountLiveLocal(e, i, ctx);
  finalizeTouchedAccountsPostLive(e, ctx);
  const a = e.accounts.get(i);
  if (a.capital < amount) require(false, PercolatorError.EngineInsufficientBalance);
  const eff = effectivePosQ(e, i);
  if (eff !== 0n) {
    const eqWithdraw = accountEquityWithdrawRaw(e, i);
    // eq_post = eq_withdraw.saturating_sub(amount as i128); amount < 2^64 here (units of a u64 amount).
    const amt = toI128(amount);
    let eqPost: i128 = I128_MIN;
    if (eqWithdraw >= I128_MIN + amt) eqPost = eqWithdraw - amt;
    const n = notional(e, i, oraclePrice);
    const prop = mulDivFloorU128(n, toU128(e.params.initial_margin_bps), 10000n);
    const imReq = prop > e.params.min_nonzero_im_req ? prop : e.params.min_nonzero_im_req;
    // `im_req as i128` wraps above i128::MAX (release build): the reinterpretation of its bits.
    if (eqPost < asI128(imReq)) require(false, PercolatorError.EngineUndercollateralized);
  }
  setCapital(e, i, a.capital - amount);
  require(e.vault >= amount, PercolatorError.EngineCorruptState);
  e.vault -= amount;
  scheduleEndOfInstructionResets(e, ctx);
  finalizeEndOfInstructionResets(e, ctx);
  assertPublicPostconditions(e);
}

/** `x as i128` for a u128: the same bits. */
export function asI128(x: u128): i128 {
  if (x <= I128_MAX) return toI128(x);
  return -toI128(340282366920938463463374607431768211455n - x) - 1n;
}

export function settleAccountNotAtomic(e: Inout<RiskEngine>, idx: u16, oraclePrice: u64, nowSlot: u64, fundingRateE9: i128, hMin: u64, hMax: u64): void {
  const i = toU64(idx);
  validateAdmissionPair(hMin, hMax, e.params);
  if (oraclePrice === 0n || oraclePrice > MAX_ORACLE_PRICE) failOverflow();
  if (!isUsed(e, i)) failAccountNotFoundHere();
  if (e.market_mode !== LIVE) failUnauthorized();
  const ctx = emptyContext(hMin, hMax);
  accrueMarketTo(e, nowSlot, oraclePrice, fundingRateE9);
  e.current_slot = nowSlot;
  touchAccountLiveLocal(e, i, ctx);
  finalizeTouchedAccountsPostLive(e, ctx);
  scheduleEndOfInstructionResets(e, ctx);
  finalizeEndOfInstructionResets(e, ctx);
  assertPublicPostconditions(e);
}

/** close_account_not_atomic: returns the capital paid out. */
export function closeAccountNotAtomic(e: Inout<RiskEngine>, idx: u16, nowSlot: u64, oraclePrice: u64, fundingRateE9: i128, hMin: u64, hMax: u64): u128 {
  const i = toU64(idx);
  validateAdmissionPair(hMin, hMax, e.params);
  if (e.market_mode !== LIVE) failUnauthorized();
  if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) failAccountNotFoundHere();
  const ctx = emptyContext(hMin, hMax);
  accrueMarketTo(e, nowSlot, oraclePrice, fundingRateE9);
  e.current_slot = nowSlot;
  touchAccountLiveLocal(e, i, ctx);
  finalizeTouchedAccountsPostLive(e, ctx);
  if (effectivePosQ(e, i) !== 0n) require(false, PercolatorError.EngineUndercollateralized);
  const a = e.accounts.get(i);
  if (a.pnl > 0n) require(false, PercolatorError.EnginePnlNotWarmedUp);
  if (a.pnl < 0n) require(false, PercolatorError.EngineUndercollateralized);
  if (a.fee_credits < 0n) require(false, PercolatorError.EngineUndercollateralized);
  if (a.reserved_pnl !== 0n || a.sched_present !== 0n || a.pending_present !== 0n) require(false, PercolatorError.EngineUndercollateralized);
  const capital = a.capital;
  if (capital > e.vault) require(false, PercolatorError.EngineInsufficientBalance);
  e.vault = e.vault - capital;
  setCapital(e, i, 0n);
  scheduleEndOfInstructionResets(e, ctx);
  finalizeEndOfInstructionResets(e, ctx);
  freeSlot(e, idx);
  sweepEmptyMarketSurplusToInsurance(e);
  assertPublicPostconditions(e);
  return capital;
}

export function reclaimEmptyAccountNotAtomic(e: Inout<RiskEngine>, idx: u16, nowSlot: u64): void {
  const i = toU64(idx);
  if (e.market_mode !== LIVE) failUnauthorized();
  if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) failAccountNotFoundHere();
  if (nowSlot < e.current_slot) failOverflow();
  checkLiveAccrualEnvelope(e, nowSlot);
  const a = e.accounts.get(i);
  if (a.position_basis_q !== 0n) require(false, PercolatorError.EngineUndercollateralized);
  if (a.pnl !== 0n) require(false, PercolatorError.EngineUndercollateralized);
  if (a.reserved_pnl !== 0n) require(false, PercolatorError.EngineUndercollateralized);
  if (a.sched_present !== 0n || a.pending_present !== 0n) require(false, PercolatorError.EngineUndercollateralized);
  if (a.fee_credits > 0n) failCorrupt();
  e.current_slot = nowSlot;
  if (a.capital !== 0n) require(false, PercolatorError.EngineUndercollateralized);
  if (a.fee_credits < 0n) a.fee_credits = 0n;
  freeSlot(e, idx);
  sweepEmptyMarketSurplusToInsurance(e);
  assertPublicPostconditions(e);
}

export function topUpInsuranceFund(e: Inout<RiskEngine>, amount: u128, nowSlot: u64): void {
  if (e.market_mode !== LIVE) failUnauthorized();
  if (nowSlot < e.current_slot) failOverflow();
  checkLiveAccrualEnvelope(e, nowSlot);
  require(e.vault <= 340282366920938463463374607431768211455n - amount, PercolatorError.EngineOverflow);
  const newVault = e.vault + amount;
  if (newVault > MAX_VAULT_TVL) failOverflow();
  require(e.insurance_balance <= 340282366920938463463374607431768211455n - amount, PercolatorError.EngineOverflow);
  const newIns = e.insurance_balance + amount;
  e.current_slot = nowSlot;
  e.vault = newVault;
  e.insurance_balance = newIns;
}

export function depositFeeCreditsEngine(e: Inout<RiskEngine>, idx: u16, amount: u128, nowSlot: u64): void {
  const i = toU64(idx);
  if (e.market_mode !== LIVE) failUnauthorized();
  if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) failAccountNotFoundHere();
  if (nowSlot < e.current_slot) failOverflow();
  checkLiveAccrualEnvelope(e, nowSlot);
  const a = e.accounts.get(i);
  const debt = feeDebt(a.fee_credits);
  if (amount > debt) failOverflow();
  if (amount === 0n) {
    e.current_slot = nowSlot;
    return;
  }
  if (amount > I128_MAX) failOverflow();
  require(e.vault <= 340282366920938463463374607431768211455n - amount, PercolatorError.EngineOverflow);
  const newVault = e.vault + amount;
  if (newVault > MAX_VAULT_TVL) failOverflow();
  require(e.insurance_balance <= 340282366920938463463374607431768211455n - amount, PercolatorError.EngineOverflow);
  const newIns = e.insurance_balance + amount;
  const newCredits = checkedAddI128(a.fee_credits, toI128(amount));
  e.current_slot = nowSlot;
  e.vault = newVault;
  e.insurance_balance = newIns;
  a.fee_credits = newCredits;
}

// ---- Margin (engine lines 2853-2861, 2917-2926, 2940-2951, 2974-3045) --------------------------------------------------
//
// The original's I256 values here (Eq_maint_raw in exact width, the margin buffers) are kept as u256 with a bias of
// 2^255 (`v + 2^255`), so that unsigned comparison is signed comparison. Every term is below 2^130 in magnitude: the
// `expect`s on the I256 adds and subtracts cannot fire, and neither can the biased arithmetic leave u256.

const WIDE_ZERO: u256 = I256_MIN_MAG;

/** account_equity_maint_raw_wide: C + PNL - FeeDebt, exact (biased). */
function maintRawWide(e: RiskEngine, idx: u64): u256 {
  const a = e.accounts.get(idx);
  const plus = WIDE_ZERO + u256(a.capital) + u256(a.pnl > 0n ? toU128(a.pnl) : 0n);
  return plus - u256(a.pnl < 0n ? absI128(a.pnl) : 0n) - u256(feeDebt(a.fee_credits));
}

/** max(mul_div_floor_u128(notional, bps, 10_000), floor): a margin requirement. */
function marginReq(notionalValue: u128, bps: u64, floor: u128): u128 {
  const prop = mulDivFloorU128(notionalValue, toU128(bps), 10000n);
  return prop > floor ? prop : floor;
}

/** `if req > i128::MAX as u128 { i128::MAX } else { req as i128 }`. */
function reqI128(req: u128): i128 {
  return req > I128_MAX ? I128_MAX : toI128(req);
}

/** is_above_maintenance_margin: Eq_net > MM_req (Eq_net > 0 when flat). */
export function isAboveMaintenanceMargin(e: RiskEngine, idx: u64, oraclePrice: u64): boolean {
  const raw = accountEquityMaintRaw(e, idx);
  const eqNet: i128 = raw < 0n ? 0n : raw;
  if (effectivePosQ(e, idx) === 0n) return eqNet > 0n;
  const mm = marginReq(notional(e, idx, oraclePrice), e.params.maintenance_margin_bps, e.params.min_nonzero_mm_req);
  return eqNet > reqI128(mm);
}

/** account_equity_trade_open_raw: the counterfactual equity with the candidate trade's own positive slippage removed. */
function accountEquityTradeOpenRaw(e: RiskEngine, idx: u64, candidateTradePnl: i128): i128 {
  const a = e.accounts.get(idx);
  const tradeGain: u128 = candidateTradePnl > 0n ? toU128(candidateTradePnl) : 0n;
  const posPnl = clampPos(a.pnl);
  const posPnlTradeOpen = posPnl > tradeGain ? posPnl - tradeGain : 0n;
  // pnl.checked_sub(trade_gain as i128).unwrap_or(i128::MIN + 1); trade_gain <= i128::MAX.
  const gainI = toI128(tradeGain);
  const pnlTradeOpen: i128 = a.pnl >= I128_MIN + gainI ? a.pnl - gainI : I128_MIN + 1n;
  if (e.pnl_pos_tot < posPnl) return I128_MIN + 1n;
  const base = e.pnl_pos_tot - posPnl;
  if (base > 340282366920938463463374607431768211455n - posPnlTradeOpen) return I128_MIN + 1n;
  const pnlPosTotTradeOpen = base + posPnlTradeOpen;
  let pnlEffTradeOpen = posPnlTradeOpen;
  if (pnlPosTotTradeOpen !== 0n) {
    const seniorSum = e.c_tot <= 340282366920938463463374607431768211455n - e.insurance_balance ? e.c_tot + e.insurance_balance : 340282366920938463463374607431768211455n;
    const residual = e.vault >= seniorSum ? e.vault - seniorSum : 0n;
    const gNum = residual < pnlPosTotTradeOpen ? residual : pnlPosTotTradeOpen;
    pnlEffTradeOpen = mulDivFloorU128(posPnlTradeOpen, gNum, pnlPosTotTradeOpen);
  }
  const pos = u256(a.capital) + u256(pnlEffTradeOpen);
  const neg = u256(pnlTradeOpen < 0n ? absI128(pnlTradeOpen) : 0n) + u256(feeDebt(a.fee_credits));
  if (pos >= neg) {
    const d = pos - neg;
    return d <= u256(I128_MAX) ? toI128(toU128(d)) : I128_MIN + 1n;
  }
  const d = neg - pos;
  return d <= u256(I128_MAX) + 1n ? signedI128(true, toU128(d)) : I128_MIN + 1n;
}

/** is_above_initial_margin_trade_open: Eq_trade_open_raw >= IM_req (>= 0 when flat). */
function isAboveInitialMarginTradeOpen(e: RiskEngine, idx: u64, oraclePrice: u64, candidateTradePnl: i128): boolean {
  const eq = accountEquityTradeOpenRaw(e, idx, candidateTradePnl);
  if (effectivePosQ(e, idx) === 0n) return eq >= 0n;
  const im = marginReq(notional(e, idx, oraclePrice), e.params.initial_margin_bps, e.params.min_nonzero_im_req);
  return eq >= reqI128(im);
}

/** max_safe_flat_conversion_released (spec §4.12). */
function maxSafeFlatConversionReleased(e: RiskEngine, idx: u64, xCap: u128, hNum: u128, hDen: u128): u128 {
  if (xCap === 0n) return 0n;
  const eBefore = accountEquityMaintRaw(e, idx);
  if (eBefore <= 0n) return 0n;
  if (hDen === 0n || hNum === hDen) return xCap;
  const safe = wideMulDivFloorU128(toU128(eBefore), hDen, hDen - hNum);
  return xCap < safe ? xCap : safe;
}

// ---- Trades (engine lines 1652-1712, 3856-4332, 5766-5809) -------------------------------------------------------------

/** attach_effective_position: the orphaned fraction of a replaced basis counted as dust, then the new basis attached. */
function attachEffectivePosition(e: Inout<RiskEngine>, idx: u64, newEff: i128): void {
  const a = e.accounts.get(idx);
  const oldBasis = a.position_basis_q;
  if (oldBasis !== 0n) {
    const oldSide = oldBasis > 0n ? LONG : SHORT;
    if (a.adl_epoch_snap === epochSide(e, oldSide)) {
      const aBasis = a.adl_a_basis;
      // |basis| · A_side (both below 2^128: the U256 product always exists), its remainder by a_basis.
      if (aBasis !== 0n && (u256(absI128(oldBasis)) * u256(aSide(e, oldSide))) % u256(aBasis) !== 0n) incPhantomDustBound(e, oldSide);
    }
  }
  if (newEff === 0n) {
    setPositionBasisQ(e, idx, 0n);
    resetPositionSnapshots(e, idx);
    return;
  }
  if (absI128(newEff) > MAX_POSITION_ABS_Q) failOverflow();
  setPositionBasisQ(e, idx, newEff);
  const b = e.accounts.get(idx);
  if (newEff > 0n) {
    b.adl_a_basis = e.adl_mult_long;
    b.adl_k_snap = e.adl_coeff_long;
    b.f_snap = e.f_long_num;
    b.adl_epoch_snap = e.adl_epoch_long;
  } else {
    b.adl_a_basis = e.adl_mult_short;
    b.adl_k_snap = e.adl_coeff_short;
    b.f_snap = e.f_short_num;
    b.adl_epoch_snap = e.adl_epoch_short;
  }
}

/** compute_trade_pnl: floor(size_q · price_diff / POS_SCALE), toward -inf, refused past ±i128::MAX. */
export function computeTradePnl(sizeQ: i128, priceDiff: i128): i128 {
  if (sizeQ === 0n || priceDiff === 0n) return 0n;
  const neg = sizeQ < 0n !== priceDiff < 0n;
  const p = u256(absI128(sizeQ)) * u256(absI128(priceDiff));
  const q = p / u256(POS_SCALE);
  const r = p % u256(POS_SCALE);
  if (neg) {
    const mag = r !== 0n ? q + 1n : q;
    require(mag <= u256(I128_MAX), PercolatorError.EngineOverflow);
    return -toI128(toU128(mag));
  }
  require(q <= u256(I128_MAX), PercolatorError.EngineOverflow);
  return toI128(toU128(q));
}

function oiLong(pos: i128): u128 {
  return pos > 0n ? toU128(pos) : 0n;
}
function oiShort(pos: i128): u128 {
  return pos < 0n ? absI128(pos) : 0n;
}

/** bilateral_oi_after's two chains: the subtractions refused as CorruptState, the additions as Overflow. */
function oiAfter(oi: u128, oldA: u128, oldB: u128, newA: u128, newB: u128): u128 {
  require(oi >= oldA, PercolatorError.EngineCorruptState);
  const x = oi - oldA;
  require(x >= oldB, PercolatorError.EngineCorruptState);
  const y = x - oldB;
  require(y <= 340282366920938463463374607431768211455n - newA, PercolatorError.EngineOverflow);
  const z = y + newA;
  require(z <= 340282366920938463463374607431768211455n - newB, PercolatorError.EngineOverflow);
  return z + newB;
}

/** MM_req of a pre-trade effective position (0 when flat). */
function mmReqOf(e: RiskEngine, eff: i128, oraclePrice: u64): u128 {
  if (eff === 0n) return 0n;
  return marginReq(mulDivFloorU128(absI128(eff), toU128(oraclePrice), POS_SCALE), e.params.maintenance_margin_bps, e.params.min_nonzero_mm_req);
}

/** enforce_one_side_margin (spec §10.5 step 29). `bufferPre` is biased. */
function enforceOneSideMargin(e: RiskEngine, idx: u64, oraclePrice: u64, oldEff: i128, newEff: i128, bufferPre: u256, fee: u128, candidateTradePnl: i128): void {
  if (newEff === 0n) {
    // min(Eq_maint_raw_post + fee, 0) >= min(Eq_maint_raw_pre, 0).
    const eqPre = bufferPre + u256(mmReqOf(e, oldEff, oraclePrice));
    const shortfallPre = eqPre < WIDE_ZERO ? eqPre : WIDE_ZERO;
    const feeNeutral = maintRawWide(e, idx) + u256(fee);
    const shortfallPost = feeNeutral < WIDE_ZERO ? feeNeutral : WIDE_ZERO;
    if (shortfallPost < shortfallPre) require(false, PercolatorError.EngineUndercollateralized);
    return;
  }
  const absOld = absI128(oldEff);
  const absNew = absI128(newEff);
  const riskIncreasing = absNew > absOld || (oldEff > 0n && newEff < 0n) || (oldEff < 0n && newEff > 0n) || oldEff === 0n;
  const strictlyReducing = oldEff !== 0n && newEff !== 0n && ((oldEff > 0n && newEff > 0n) || (oldEff < 0n && newEff < 0n)) && absNew < absOld;
  if (riskIncreasing) {
    if (!isAboveInitialMarginTradeOpen(e, idx, oraclePrice, candidateTradePnl)) require(false, PercolatorError.EngineUndercollateralized);
  } else if (isAboveMaintenanceMargin(e, idx, oraclePrice)) {
    // Maintenance healthy.
  } else if (strictlyReducing) {
    const feeNeutral = maintRawWide(e, idx) + u256(fee);
    const mmPost = marginReq(notional(e, idx, oraclePrice), e.params.maintenance_margin_bps, e.params.min_nonzero_mm_req);
    const bufferPost = feeNeutral - u256(mmPost);
    const notPre = oldEff === 0n ? 0n : mulDivFloorU128(absI128(oldEff), toU128(oraclePrice), POS_SCALE);
    const maintPre = bufferPre + u256(marginReq(notPre, e.params.maintenance_margin_bps, e.params.min_nonzero_mm_req));
    const cond1 = bufferPost > bufferPre;
    const shortfallPost = feeNeutral < WIDE_ZERO ? feeNeutral : WIDE_ZERO;
    const shortfallPre = maintPre < WIDE_ZERO ? maintPre : WIDE_ZERO;
    if (!(cond1 && shortfallPost >= shortfallPre)) require(false, PercolatorError.EngineUndercollateralized);
  } else require(false, PercolatorError.EngineUndercollateralized);
}

/** execute_trade_not_atomic: `a` buys `sizeQ` (> 0) from `b` at `execPrice`. */
export function executeTradeNotAtomic(
  e: Inout<RiskEngine>,
  a: u16,
  b: u16,
  oraclePrice: u64,
  nowSlot: u64,
  sizeQ: i128,
  execPrice: u64,
  fundingRateE9: i128,
  hMin: u64,
  hMax: u64,
): void {
  validateAdmissionPair(hMin, hMax, e.params);
  if (oraclePrice === 0n || oraclePrice > MAX_ORACLE_PRICE) failOverflow();
  if (execPrice === 0n || execPrice > MAX_ORACLE_PRICE) failOverflow();
  if (sizeQ <= 0n) failOverflow();
  if (toU128(sizeQ) > MAX_TRADE_SIZE_Q) failOverflow();
  if (mulDivFloorU128(toU128(sizeQ), toU128(execPrice), POS_SCALE) > MAX_ACCOUNT_NOTIONAL) failOverflow();
  const ia = toU64(a);
  const ib = toU64(b);
  if (!isUsed(e, ia) || !isUsed(e, ib)) failAccountNotFoundHere();
  if (a === b) failOverflow();
  if (e.market_mode !== LIVE) failUnauthorized();
  const ctx = emptyContext(hMin, hMax);
  accrueMarketTo(e, nowSlot, oraclePrice, fundingRateE9);
  e.current_slot = nowSlot;
  touchAccountLiveLocal(e, ia, ctx);
  touchAccountLiveLocal(e, ib, ctx);
  // Step 12a: flush dust-only empty sides with a context of its own.
  const resetCtx = emptyContext(0n, 0n);
  scheduleEndOfInstructionResets(e, resetCtx);
  finalizeEndOfInstructionResets(e, resetCtx);

  const oldEffA = effectivePosQ(e, ia);
  const oldEffB = effectivePosQ(e, ib);
  const bufferPreA = maintRawWide(e, ia) - u256(mmReqOf(e, oldEffA, oraclePrice));
  const bufferPreB = maintRawWide(e, ib) - u256(mmReqOf(e, oldEffB, oraclePrice));
  const newEffA = checkedAddI128(oldEffA, sizeQ);
  const newEffB = checkedAddI128(oldEffB, -sizeQ);
  if (newEffA !== 0n && absI128(newEffA) > MAX_POSITION_ABS_Q) failOverflow();
  if (newEffB !== 0n && absI128(newEffB) > MAX_POSITION_ABS_Q) failOverflow();
  if (mulDivFloorU128(absI128(newEffA), toU128(oraclePrice), POS_SCALE) > MAX_ACCOUNT_NOTIONAL) failOverflow();
  if (mulDivFloorU128(absI128(newEffB), toU128(oraclePrice), POS_SCALE) > MAX_ACCOUNT_NOTIONAL) failOverflow();
  maybeFinalizeReadyResetSides(e);
  const oiLongAfter = oiAfter(e.oi_eff_long_q, oiLong(oldEffA), oiLong(oldEffB), oiLong(newEffA), oiLong(newEffB));
  const oiShortAfter = oiAfter(e.oi_eff_short_q, oiShort(oldEffA), oiShort(oldEffB), oiShort(newEffA), oiShort(newEffB));
  if (oiLongAfter > MAX_OI_SIDE_Q || oiShortAfter > MAX_OI_SIDE_Q) failOverflow();
  if ((e.side_mode_long === DRAIN_ONLY || e.side_mode_long === RESET_PENDING) && oiLongAfter > e.oi_eff_long_q) require(false, PercolatorError.EngineRiskReductionOnlyMode);
  if ((e.side_mode_short === DRAIN_ONLY || e.side_mode_short === RESET_PENDING) && oiShortAfter > e.oi_eff_short_q)
    require(false, PercolatorError.EngineRiskReductionOnlyMode);
  // The per-side active-position cap on the net change of both legs, counted as the original counts: `count as i64 +
  // after - before` in i64, wrapping (no overflow checks), negative is CorruptState, then above `cap as i64` is
  // Overflow. The stored counts never exceed max_accounts, so only a patched slab (a count of 2^63 or more) can tell
  // this from plain u64 arithmetic.
  const longBefore = (oldEffA > 0n ? 1n : 0n) + (oldEffB > 0n ? 1n : 0n);
  const longAfter = (newEffA > 0n ? 1n : 0n) + (newEffB > 0n ? 1n : 0n);
  const shortBefore = (oldEffA < 0n ? 1n : 0n) + (oldEffB < 0n ? 1n : 0n);
  const shortAfter = (newEffA < 0n ? 1n : 0n) + (newEffB < 0n ? 1n : 0n);
  const finalLong = wrapNetCount(e.stored_pos_count_long, longAfter, longBefore);
  const finalShort = wrapNetCount(e.stored_pos_count_short, shortAfter, shortBefore);
  if (finalLong >= I64_SIGN || finalShort >= I64_SIGN) failCorrupt();
  const cap = e.params.max_active_positions_per_side;
  if (cap >= I64_SIGN || finalLong > cap || finalShort > cap) failOverflow();

  const tradePnlA = computeTradePnl(sizeQ, toI128(oraclePrice) - toI128(execPrice));
  const tradePnlB = -tradePnlA;
  const pnlA = checkedAddI128(e.accounts.get(ia).pnl, tradePnlA);
  if (pnlA === I128_MIN) failOverflow();
  setPnlWithReserve(e, ia, pnlA, RESERVE_ADMISSION_PAIR, ctx);
  const pnlB = checkedAddI128(e.accounts.get(ib).pnl, tradePnlB);
  if (pnlB === I128_MIN) failOverflow();
  setPnlWithReserve(e, ib, pnlB, RESERVE_ADMISSION_PAIR, ctx);
  attachEffectivePosition(e, ia, newEffA);
  attachEffectivePosition(e, ib, newEffB);
  e.oi_eff_long_q = oiLongAfter;
  e.oi_eff_short_q = oiShortAfter;
  settleLosses(e, ia, ctx);
  settleLosses(e, ib, ctx);
  const tradeNotional = mulDivFloorU128(toU128(sizeQ), toU128(execPrice), POS_SCALE);
  let fee: u128 = 0n;
  if (tradeNotional > 0n && e.params.trading_fee_bps > 0n) fee = mulDivCeilU128(tradeNotional, toU128(e.params.trading_fee_bps), 10000n);
  let impactA: u128 = 0n;
  let impactB: u128 = 0n;
  if (fee > 0n) {
    if (fee > MAX_PROTOCOL_FEE_ABS) failOverflow();
    impactA = chargeFeeToInsurance(e, ia, fee);
    impactB = chargeFeeToInsurance(e, ib, fee);
  }
  if (newEffA === 0n && e.accounts.get(ia).pnl < 0n) require(false, PercolatorError.EngineUndercollateralized);
  if (newEffB === 0n && e.accounts.get(ib).pnl < 0n) require(false, PercolatorError.EngineUndercollateralized);
  enforceOneSideMargin(e, ia, oraclePrice, oldEffA, newEffA, bufferPreA, impactA, tradePnlA);
  enforceOneSideMargin(e, ib, oraclePrice, oldEffB, newEffB, bufferPreB, impactB, tradePnlB);
  finalizeTouchedAccountsPostLive(e, ctx);
  scheduleEndOfInstructionResets(e, ctx);
  finalizeEndOfInstructionResets(e, ctx);
  assertPublicPostconditions(e);
}

// ---- enqueue_adl: the A/K loss socialisation (engine lines 1950-1964, 2415-2583) ---------------------------------------

/** MIN_A_SIDE: below it the side drains only. */
export const MIN_A_SIDE = 100000000000000n;

function setPendingReset(ctx: Inout<InstructionContext>, side: u64): void {
  if (side === LONG) ctx.pending_reset_long = true;
  else ctx.pending_reset_short = true;
}

function setOiEff(e: Inout<RiskEngine>, s: u64, v: u128): void {
  if (s === LONG) e.oi_eff_long_q = v;
  else e.oi_eff_short_q = v;
}

/** inc_phantom_dust_bound_by (checked: Overflow). */
function incPhantomDustBoundBy(e: Inout<RiskEngine>, s: u64, amount: u128): void {
  if (s === LONG) {
    require(e.phantom_dust_bound_long_q <= 340282366920938463463374607431768211455n - amount, PercolatorError.EngineOverflow);
    e.phantom_dust_bound_long_q += amount;
  } else {
    require(e.phantom_dust_bound_short_q <= 340282366920938463463374607431768211455n - amount, PercolatorError.EngineOverflow);
    e.phantom_dust_bound_short_q += amount;
  }
}

/**
 * enqueue_adl (spec §5.6): the liquidated side's OI falls by `qClose`; the deficit `d` is paid by insurance first and
 * what remains (D_rem) is written into the opposite side's K (every open position there pays its share at its next
 * touch), unless K has no room for it (then it is left to the haircut, record_uninsured_protocol_loss being a no-op);
 * the opposite side's A shrinks by OI_post / OI (its positions shrink pro rata), and a side whose OI reaches zero is
 * scheduled for a reset.
 */
function enqueueAdl(e: Inout<RiskEngine>, ctx: Inout<InstructionContext>, liqSide: u64, qClose: u128, d: u128): void {
  const opp = liqSide === LONG ? SHORT : LONG;
  if (qClose !== 0n) {
    const oldOi = oiEff(e, liqSide);
    require(oldOi >= qClose, PercolatorError.EngineCorruptState);
    setOiEff(e, liqSide, oldOi - qClose);
  }
  const dRem = d > 0n ? useInsuranceBuffer(e, d) : 0n;
  const oi = oiEff(e, opp);
  if (oi === 0n) {
    if (oiEff(e, liqSide) === 0n) {
      setPendingReset(ctx, liqSide);
      setPendingReset(ctx, opp);
    }
    return;
  }
  if (storedPosCount(e, opp) === 0n) {
    if (qClose > oi) failCorrupt();
    const oiPost0 = oi - qClose;
    setOiEff(e, opp, oiPost0);
    if (oiPost0 === 0n) {
      setPendingReset(ctx, opp);
      if (oiEff(e, liqSide) === 0n) setPendingReset(ctx, liqSide);
    }
    return;
  }
  if (qClose > oi) failCorrupt();
  const aOld = aSide(e, opp);
  const oiPost = oi - qClose;
  if (dRem !== 0n) {
    require(aOld <= 340282366920938463463374607431768211455n / POS_SCALE, PercolatorError.EngineOverflow);
    const aPs = aOld * POS_SCALE;
    // wide_mul_div_ceil_u128_or_over_i128max(D_rem, A_old · POS_SCALE, OI): both factors below 2^128.
    const p = u256(dRem) * u256(aPs);
    const q = p / u256(oi);
    const deltaKAbs = p % u256(oi) !== 0n ? q + 1n : q;
    if (deltaKAbs <= u256(I128_MAX)) {
      const kOpp = kSide(e, opp);
      const deltaK = -toI128(toU128(deltaKAbs));
      // K + delta_K must fit i128 and leave room for a mark-to-market at MAX_ORACLE_PRICE: |new K| + A_old · MAX <=
      // i128::MAX. Otherwise D_rem goes to the haircut.
      if (kOpp >= I128_MIN - deltaK) {
        const newK = kOpp + deltaK;
        const absNewK = absI128(newK);
        if (absNewK <= I128_MAX && u256(aOld) * u256(MAX_ORACLE_PRICE) <= u256(I128_MAX - absNewK)) {
          if (opp === LONG) e.adl_coeff_long = newK;
          else e.adl_coeff_short = newK;
        }
      }
    }
  }
  if (oiPost === 0n) {
    setOiEff(e, opp, 0n);
    setPendingReset(ctx, opp);
    if (oiEff(e, liqSide) === 0n) setPendingReset(ctx, liqSide);
    return;
  }
  // A_candidate = floor(A_old · OI_post / OI) (the product below 2^256).
  const aCandidate = (u256(aOld) * u256(oiPost)) / u256(oi);
  if (aCandidate !== 0n) {
    const aNew = toU128(aCandidate);
    if (opp === LONG) e.adl_mult_long = aNew;
    else e.adl_mult_short = aNew;
    setOiEff(e, opp, oiPost);
    if (oiPost < oi) {
      // global_a_dust_bound = N_opp + ceil((OI + N_opp) / A_old), saturating at u128::MAX.
      const nOpp = u256(storedPosCount(e, opp));
      if (aOld === 0n) panic("ceil_div_positive_checked: zero denominator", "src/wide_math.rs:1417:5");
      const n = u256(oi) + nOpp;
      const cq = n / u256(aOld);
      const ceilTerm = n % u256(aOld) !== 0n ? cq + 1n : cq;
      const bound = nOpp + ceilTerm;
      incPhantomDustBoundBy(e, opp, bound <= u256(340282366920938463463374607431768211455n) ? toU128(bound) : 340282366920938463463374607431768211455n);
    }
    if (aNew < MIN_A_SIDE) {
      if (opp === LONG) e.side_mode_long = DRAIN_ONLY;
      else e.side_mode_short = DRAIN_ONLY;
    }
    return;
  }
  // Precision exhausted: both sides drain to zero and reset.
  setOiEff(e, opp, 0n);
  setOiEff(e, liqSide, 0n);
  setPendingReset(ctx, opp);
  setPendingReset(ctx, liqSide);
}

// ---- Liquidation (engine lines 4340-4521) ------------------------------------------------------------------------------

/** LiquidationPolicy as the port passes it: FullClose, or ExactPartial with its quantity. */
export const POLICY_FULL_CLOSE = 0n;
export const POLICY_EXACT_PARTIAL = 1n;
export const POLICY_NONE = 0xffn;

/** The liquidation fee on `qClose` closed at `price`: ceil(notional · bps / 10_000), at least the floor, at most the cap. */
function liquidationFee(e: RiskEngine, qClose: u128, price: u64): u128 {
  const n = mulDivFloorU128(qClose, toU128(price), POS_SCALE);
  const raw = mulDivCeilU128(n, toU128(e.params.liquidation_fee_bps), 10000n);
  const floored = raw > e.params.min_liquidation_abs ? raw : e.params.min_liquidation_abs;
  return floored < e.params.liquidation_fee_cap ? floored : e.params.liquidation_fee_cap;
}

/** liquidate_at_oracle_not_atomic with LiquidationPolicy::FullClose (the program's only policy here): Ok(liquidated). */
export function liquidateAtOracleNotAtomic(e: Inout<RiskEngine>, idx: u16, nowSlot: u64, oraclePrice: u64, fundingRateE9: i128, hMin: u64, hMax: u64): boolean {
  const i = toU64(idx);
  validateAdmissionPair(hMin, hMax, e.params);
  if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) failAccountNotFoundHere();
  if (e.market_mode !== LIVE) failUnauthorized();
  const ctx = emptyContext(hMin, hMax);
  accrueMarketTo(e, nowSlot, oraclePrice, fundingRateE9);
  e.current_slot = nowSlot;
  touchAccountLiveLocal(e, i, ctx);
  const result = liquidateAtOracleInternal(e, idx, oraclePrice, POLICY_FULL_CLOSE, 0n, ctx);
  finalizeTouchedAccountsPostLive(e, ctx);
  scheduleEndOfInstructionResets(e, ctx);
  finalizeEndOfInstructionResets(e, ctx);
  assertPublicPostconditions(e);
  return result;
}

/** liquidate_at_oracle_internal: the account already touched; resets left to the caller. */
function liquidateAtOracleInternal(e: Inout<RiskEngine>, idx: u16, oraclePrice: u64, policy: u64, qPartial: u128, ctx: Inout<InstructionContext>): boolean {
  const i = toU64(idx);
  if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) return false;
  if (oraclePrice === 0n || oraclePrice > MAX_ORACLE_PRICE) failOverflow();
  const oldEff = effectivePosQ(e, i);
  if (oldEff === 0n) return false;
  if (isAboveMaintenanceMargin(e, i, oraclePrice)) return false;
  const liqSide = oldEff > 0n ? LONG : SHORT;
  const absOld = absI128(oldEff);
  if (policy === POLICY_EXACT_PARTIAL) {
    if (qPartial === 0n || qPartial >= absOld) failOverflow();
    const newAbs = absOld - qPartial;
    const newEff: i128 = oldEff > 0n ? toI128(newAbs) : -toI128(newAbs);
    attachEffectivePosition(e, i, newEff);
    settleLosses(e, i, ctx);
    chargeFeeToInsurance(e, i, liquidationFee(e, qPartial, oraclePrice));
    enqueueAdl(e, ctx, liqSide, qPartial, 0n);
    if (!isAboveMaintenanceMargin(e, i, oraclePrice)) require(false, PercolatorError.EngineUndercollateralized);
    return true;
  }
  attachEffectivePosition(e, i, 0n);
  settleLosses(e, i, ctx);
  chargeFeeToInsurance(e, i, liquidationFee(e, absOld, oraclePrice));
  let d: u128 = 0n;
  const pnl = e.accounts.get(i).pnl;
  if (effectivePosQ(e, i) === 0n && pnl < 0n) {
    if (pnl === I128_MIN) failCorrupt();
    d = absI128(pnl);
  }
  enqueueAdl(e, ctx, liqSide, absOld, d);
  if (d !== 0n) setPnlWithReserve(e, i, 0n, RESERVE_NO_POSITIVE_INCREASE, ctx);
  return true;
}

// ---- keeper_crank_not_atomic (engine lines 4530-4737) ------------------------------------------------------------------

/**
 * validate_keeper_hint (spec §11.1 rule 3): no hint (0xff) is no action; FullClose stands; an ExactPartial stands when
 * 0 < q < |eff| and the predicted post-partial maintenance equity (Eq_maint_raw less the fee the account can bear)
 * stays above the remainder's requirement. Returns the policy to apply, or POLICY_NONE.
 */
function validateKeeperHint(e: RiskEngine, i: u64, eff: i128, policy: u64, q: u128, oraclePrice: u64): u64 {
  if (policy === POLICY_NONE) return POLICY_NONE;
  if (policy === POLICY_FULL_CLOSE) return POLICY_FULL_CLOSE;
  const absEff = absI128(eff);
  if (q === 0n || q >= absEff) return POLICY_NONE;
  const a = e.accounts.get(i);
  const liqFee = liquidationFee(e, q, oraclePrice);
  const cap = a.capital;
  const fromCapital = liqFee < cap ? liqFee : cap;
  const shortfall = liqFee - fromCapital;
  const fc = a.fee_credits;
  let headroom: u128 = 0n;
  if (fc <= 0n && fc + I128_MAX > 0n) headroom = toU128(fc + I128_MAX);
  const fromDebt = shortfall < headroom ? shortfall : headroom;
  // Biased I256 (see the margin section): the subtraction cannot leave I256.
  const predictedEq = maintRawWide(e, i) - u256(fromCapital + fromDebt);
  const remEff = absEff - q;
  const remNotional = mulDivFloorU128(remEff, toU128(oraclePrice), POS_SCALE);
  const prop = mulDivFloorU128(remNotional, toU128(e.params.maintenance_margin_bps), 10000n);
  const mm: u128 = remEff === 0n ? 0n : prop > e.params.min_nonzero_mm_req ? prop : e.params.min_nonzero_mm_req;
  if (predictedEq <= WIDE_ZERO + u256(mm)) return POLICY_NONE;
  return POLICY_EXACT_PARTIAL;
}

/**
 * keeper_crank_not_atomic (spec §10.8): accrue once, then each candidate in order (missing slots skipped without
 * counting), at most `maxRevalidations` attempts, stopping once a reset is pending: touch it, and liquidate it when it
 * is below maintenance and its hint says how. Then finalize the touched accounts and the end-of-instruction resets.
 * Returns the number of liquidations.
 *
 * The candidate list is the program's `combined`: the risk buffer's first `bufCount` entries, each with FullClose,
 * then the instruction's candidates (`cands`, as KeeperCrank's handler parsed them: the index in bits 0-15, the policy
 * tag in bits 16-23, and for ExactPartial the offset of its u128 quantity in the instruction data from bit 24), read
 * in that order by two loops sharing one step.
 */
export function keeperCrankNotAtomic(
  e: Inout<RiskEngine>,
  nowSlot: u64,
  oraclePrice: u64,
  buf: RiskBuffer,
  bufCount: u64,
  cands: FixedVec<u64, 128>,
  data: InstructionBytes,
  maxRevalidations: u64,
  fundingRateE9: i128,
  hMin: u64,
  hMax: u64,
): u64 {
  validateAdmissionPair(hMin, hMax, e.params);
  if (oraclePrice === 0n || oraclePrice > MAX_ORACLE_PRICE) failOverflow();
  if (e.market_mode !== LIVE) failUnauthorized();
  if (maxRevalidations > MAX_TOUCHED_PER_INSTRUCTION) failOverflow();
  const ctx = emptyContext(hMin, hMax);
  if (nowSlot < e.current_slot) failOverflow();
  if (nowSlot < e.last_market_slot) failOverflow();
  accrueMarketTo(e, nowSlot, oraclePrice, fundingRateE9);
  e.current_slot = nowSlot;
  if (nowSlot > e.last_crank_slot) e.last_crank_slot = nowSlot;
  let attempts = 0n;
  let liquidations = 0n;
  let stop = false;
  for (let k = 0n; k < bufCount; k++) {
    if (attempts >= maxRevalidations || ctx.pending_reset_long || ctx.pending_reset_short) {
      stop = true;
      break;
    }
    const idx = buf.entries.get(k).idx;
    if (toU64(idx) >= ENGINE_MAX_ACCOUNTS || !isUsed(e, toU64(idx))) continue;
    attempts += 1n;
    if (crankStep(e, ctx, idx, POLICY_FULL_CLOSE, 0n, oraclePrice)) liquidations += 1n;
  }
  if (!stop) {
    for (let k = 0n; k < cands.length; k++) {
      if (attempts >= maxRevalidations || ctx.pending_reset_long || ctx.pending_reset_short) break;
      const c = cands.get(k);
      const idx = toU16(c & 0xffffn);
      if (toU64(idx) >= ENGINE_MAX_ACCOUNTS || !isUsed(e, toU64(idx))) continue;
      attempts += 1n;
      const policy = (c >> 16n) & 0xffn;
      const q: u128 = policy === POLICY_EXACT_PARTIAL ? data.readU128(c >> 24n) : 0n;
      if (crankStep(e, ctx, idx, policy, q, oraclePrice)) liquidations += 1n;
    }
  }
  finalizeTouchedAccountsPostLive(e, ctx);
  scheduleEndOfInstructionResets(e, ctx);
  finalizeEndOfInstructionResets(e, ctx);
  assertPublicPostconditions(e);
  return liquidations;
}

/** One existing candidate of the crank, an attempt: touched, then liquidated if it is below maintenance and its hint says how. */
function crankStep(e: Inout<RiskEngine>, ctx: Inout<InstructionContext>, idx: u16, policy: u64, q: u128, oraclePrice: u64): boolean {
  const i = toU64(idx);
  touchAccountLiveLocal(e, i, ctx);
  if (ctx.pending_reset_long || ctx.pending_reset_short) return false;
  const eff = effectivePosQ(e, i);
  if (eff === 0n || isAboveMaintenanceMargin(e, i, oraclePrice)) return false;
  const p = validateKeeperHint(e, i, eff, policy, q, oraclePrice);
  return p !== POLICY_NONE && liquidateAtOracleInternal(e, idx, oraclePrice, p, q, ctx);
}

// ---- Conversion of released PnL (engine lines 4745-4837) ---------------------------------------------------------------

export function convertReleasedPnlNotAtomic(e: Inout<RiskEngine>, idx: u16, xReq: u128, oraclePrice: u64, nowSlot: u64, fundingRateE9: i128, hMin: u64, hMax: u64): void {
  const i = toU64(idx);
  validateAdmissionPair(hMin, hMax, e.params);
  if (oraclePrice === 0n || oraclePrice > MAX_ORACLE_PRICE) failOverflow();
  if (!isUsed(e, i)) failAccountNotFoundHere();
  if (e.market_mode !== LIVE) failUnauthorized();
  const ctx = emptyContext(hMin, hMax);
  accrueMarketTo(e, nowSlot, oraclePrice, fundingRateE9);
  e.current_slot = nowSlot;
  touchAccountLiveLocal(e, i, ctx);
  const released = releasedPos(e, i);
  if (xReq === 0n || xReq > released) failOverflow();
  const hNum = haircutNum(e);
  const hDen = haircutDen(e);
  if (e.accounts.get(i).position_basis_q === 0n) {
    if (xReq > maxSafeFlatConversionReleased(e, i, xReq, hNum, hDen)) require(false, PercolatorError.EngineUndercollateralized);
  }
  const y = wideMulDivFloorU128(xReq, hNum, hDen);
  consumeReleasedPnl(e, i, xReq);
  const cap = e.accounts.get(i).capital;
  require(cap <= 340282366920938463463374607431768211455n - y, PercolatorError.EngineOverflow);
  setCapital(e, i, cap + y);
  feeDebtSweep(e, i);
  if (effectivePosQ(e, i) !== 0n) {
    if (!isAboveMaintenanceMargin(e, i, oraclePrice)) require(false, PercolatorError.EngineUndercollateralized);
  } else if (accountEquityMaintRaw(e, i) < 0n) require(false, PercolatorError.EngineUndercollateralized);
  finalizeTouchedAccountsPostLive(e, ctx);
  scheduleEndOfInstructionResets(e, ctx);
  finalizeEndOfInstructionResets(e, ctx);
  assertPublicPostconditions(e);
}

// ---- Resolution (engine lines 4932-5287, 5737-5762) --------------------------------------------------------------------

/**
 * checked_u128_mul_i128: a · b, refused (Overflow) when its magnitude passes i128::MAX. The callers' factors (an A
 * below 2^128, a price difference below 2^64) make the 256-bit product exact.
 */
export function checkedU128MulI128(a: u128, b: i128): i128 {
  if (a === 0n || b === 0n) return 0n;
  if (b === I128_MIN) failOverflow();
  const p = u256(a) * u256(absI128(b));
  if (p > u256(I128_MAX)) failOverflow();
  return signedI128(b < 0n, toU128(p));
}

/**
 * resolve_market_not_atomic. `degenerate` is ResolveMode::Degenerate (the live price must be P_last and the rate 0;
 * no accrual), otherwise Ordinary (accrue to now with the live inputs, then the deviation band). The terminal K deltas
 * A_side · (resolved - live) are stored apart from K, every position goes stale under a new epoch, OI is zeroed.
 */
export function resolveMarketNotAtomic(e: Inout<RiskEngine>, degenerate: boolean, resolvedPrice: u64, liveOraclePrice: u64, nowSlot: u64, fundingRateE9: i128): void {
  if (e.market_mode !== LIVE) failUnauthorized();
  if (nowSlot < e.current_slot) failOverflow();
  if (nowSlot < e.last_market_slot) failOverflow();
  if (resolvedPrice === 0n || resolvedPrice > MAX_ORACLE_PRICE) failOverflow();
  if (liveOraclePrice === 0n || liveOraclePrice > MAX_ORACLE_PRICE) failOverflow();
  if (degenerate) {
    if (liveOraclePrice !== e.last_oracle_price) failOverflow();
    if (fundingRateE9 !== 0n) failOverflow();
    e.current_slot = nowSlot;
    e.last_market_slot = nowSlot;
  } else {
    accrueMarketTo(e, nowSlot, liveOraclePrice, fundingRateE9);
    // The band: |resolved - P_last| · 10_000 <= dev_bps · P_last (both products below 2^128: the checked_muls hold).
    const pLast = e.last_oracle_price;
    const diffAbs = resolvedPrice > pLast ? resolvedPrice - pLast : pLast - resolvedPrice;
    if (toU128(diffAbs) * 10000n > toU128(e.params.resolve_price_deviation_bps) * toU128(pLast)) failOverflow();
  }
  // The terminal deltas (|price_diff| < 2^64: its checked_neg holds).
  const priceDiff = toI128(resolvedPrice) - toI128(liveOraclePrice);
  const tdLong = e.side_mode_long === RESET_PENDING ? 0n : checkedU128MulI128(e.adl_mult_long, priceDiff);
  const tdShort = e.side_mode_short === RESET_PENDING ? 0n : checkedU128MulI128(e.adl_mult_short, -priceDiff);
  e.current_slot = nowSlot;
  e.market_mode = RESOLVED;
  e.resolved_price = resolvedPrice;
  e.resolved_live_price = liveOraclePrice;
  e.resolved_slot = nowSlot;
  e.resolved_k_long_terminal_delta = tdLong;
  e.resolved_k_short_terminal_delta = tdShort;
  e.resolved_payout_h_num = 0n;
  e.resolved_payout_h_den = 0n;
  e.resolved_payout_ready = 0n;
  e.pnl_matured_pos_tot = e.pnl_pos_tot;
  e.oi_eff_long_q = 0n;
  e.oi_eff_short_q = 0n;
  if (e.side_mode_long !== RESET_PENDING) beginFullDrainReset(e, LONG);
  if (e.side_mode_short !== RESET_PENDING) beginFullDrainReset(e, SHORT);
  // finalize_side_reset's checks (reset pending, OI zero, no stale or stored positions) hold where it is called.
  if (e.side_mode_long === RESET_PENDING && e.stale_account_count_long === 0n && e.stored_pos_count_long === 0n) e.side_mode_long = NORMAL;
  if (e.side_mode_short === RESET_PENDING && e.stale_account_count_short === 0n && e.stored_pos_count_short === 0n) e.side_mode_short = NORMAL;
  // Step 21 (both OI zero) holds: they were zeroed above.
  assertPublicPostconditions(e);
}

/** prepare_account_for_resolved_touch: both reserve buckets and R cleared (PNL_matured_pos_tot left as it is). */
function prepareAccountForResolvedTouch(e: Inout<RiskEngine>, idx: u64): void {
  const a = e.accounts.get(idx);
  a.sched_present = 0n;
  a.sched_remaining_q = 0n;
  a.sched_anchor_q = 0n;
  a.sched_start_slot = 0n;
  a.sched_horizon = 0n;
  a.sched_release_q = 0n;
  a.pending_present = 0n;
  a.pending_remaining_q = 0n;
  a.pending_horizon = 0n;
  a.pending_created_slot = 0n;
  a.reserved_pnl = 0n;
}

/**
 * compute_kf_pnl_delta_wide with K_now = K_epoch_start + the terminal delta (two i128s, exact in I256) and F_now =
 * F_epoch_start: as computeKfPnlDelta, the delta one more term of the combined numerator.
 */
function computeKfPnlDeltaTerminal(absBasis: u128, kSnap: i128, kStart: i128, kDelta: i128, fSnap: i128, fNow: i128, den: u128): i128 {
  if (absBasis === 0n) return 0n;
  const fd = u256(FUNDING_DEN);
  const plus = (u256(posPart(kStart)) + u256(posPart(kDelta)) + u256(negPart(kSnap))) * fd + u256(posPart(fNow)) + u256(negPart(fSnap));
  const minus = (u256(negPart(kStart)) + u256(negPart(kDelta)) + u256(posPart(kSnap))) * fd + u256(negPart(fNow)) + u256(posPart(fSnap));
  if (plus === minus) return 0n;
  const cNeg = plus < minus;
  const cMag = cNeg ? minus - plus : plus - minus;
  const denWide = u256(den) * fd;
  const p = mulU256(u256(absBasis), cMag);
  const q = p / denWide;
  const rem = p % denWide;
  if (cNeg) {
    const mag = rem !== 0n ? q + 1n : q;
    require(mag <= u256(I128_MAX), PercolatorError.EngineOverflow);
    return signedI128(true, toU128(mag));
  }
  require(q <= u256(I128_MAX), PercolatorError.EngineOverflow);
  return toI128(toU128(q));
}

/**
 * reconcile_resolved_not_atomic: the account's stale position settled at K_epoch_start + the terminal delta and F_epoch_
 * start, the position zeroed, losses paid from capital, a flat loss past it absorbed by insurance.
 */
export function reconcileResolvedNotAtomic(e: Inout<RiskEngine>, idx: u16): void {
  const i = toU64(idx);
  if (e.market_mode !== RESOLVED) failUnauthorized();
  if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) failAccountNotFoundHere();
  e.current_slot = e.resolved_slot;
  prepareAccountForResolvedTouch(e, i);
  // set_pnl's ImmediateReleaseResolvedOnly never reads the context (settle_losses and resolve_flat_negative call it).
  const none = emptyContext(0n, 0n);
  const a = e.accounts.get(i);
  const basis = a.position_basis_q;
  if (basis !== 0n) {
    const absBasis = absI128(basis);
    const aBasis = a.adl_a_basis;
    if (aBasis === 0n) failCorrupt();
    const side = basis > 0n ? LONG : SHORT;
    const epochSnap = a.adl_epoch_snap;
    const eSide = epochSide(e, side);
    const td = side === LONG ? e.resolved_k_long_terminal_delta : e.resolved_k_short_terminal_delta;
    require(aBasis <= 340282366920938463463374607431768211455n / POS_SCALE, PercolatorError.EngineOverflow);
    const den = aBasis * POS_SCALE;
    if (epochSnap === eSide) failCorrupt();
    if (epochSnap === 0xffffffffffffffffn || epochSnap + 1n !== eSide) failCorrupt();
    if (staleCount(e, side) === 0n) failCorrupt();
    const delta = computeKfPnlDeltaTerminal(absBasis, a.adl_k_snap, kEpochStart(e, side), td, a.f_snap, fEpochStart(e, side), den);
    const newPnl = checkedAddI128(a.pnl, delta);
    if (newPnl === I128_MIN) failOverflow();
    if (delta !== 0n) {
      setPnl(e, i, newPnl, none);
      e.pnl_matured_pos_tot = e.pnl_pos_tot;
    }
    // The stale count is not zero (checked above).
    if (side === LONG) e.stale_account_count_long -= 1n;
    else e.stale_account_count_short -= 1n;
    setPositionBasisQ(e, i, 0n);
    resetPositionSnapshots(e, i);
  }
  settleLosses(e, i, none);
  resolveFlatNegative(e, i, none);
  assertPublicPostconditions(e);
}

/** is_terminal_ready: the payout snapshot taken, or no positions, no stale accounts and no negative PnL left. */
export function isTerminalReady(e: RiskEngine): boolean {
  if (e.resolved_payout_ready !== 0n) return true;
  if (e.stored_pos_count_long !== 0n || e.stored_pos_count_short !== 0n) return false;
  if (e.stale_account_count_long !== 0n || e.stale_account_count_short !== 0n) return false;
  return e.neg_pnl_account_count === 0n;
}

/**
 * close_resolved_terminal_not_atomic: a positive PnL paid at the payout haircut (the snapshot min(residual, matured) /
 * matured, taken by the first such close), fee debt swept and the rest forgiven, the capital paid out, the slot freed.
 */
export function closeResolvedTerminalNotAtomic(e: Inout<RiskEngine>, idx: u16): u128 {
  const i = toU64(idx);
  if (e.market_mode !== RESOLVED) failUnauthorized();
  if (i >= ENGINE_MAX_ACCOUNTS || !isUsed(e, i)) failAccountNotFoundHere();
  if (e.accounts.get(i).position_basis_q !== 0n) require(false, PercolatorError.EngineUndercollateralized);
  const pnl = e.accounts.get(i).pnl;
  if (pnl < 0n) require(false, PercolatorError.EngineUndercollateralized);
  prepareAccountForResolvedTouch(e, i);
  if (pnl > 0n) {
    if (!isTerminalReady(e)) failUnauthorized();
    if (e.resolved_payout_ready === 0n) {
      e.pnl_matured_pos_tot = e.pnl_pos_tot;
      const senior = e.c_tot <= 340282366920938463463374607431768211455n - e.insurance_balance ? e.c_tot + e.insurance_balance : 340282366920938463463374607431768211455n;
      const residual = e.vault >= senior ? e.vault - senior : 0n;
      const hDen = e.pnl_matured_pos_tot;
      const hNum = hDen === 0n ? 0n : residual < hDen ? residual : hDen;
      e.resolved_payout_h_num = hNum;
      e.resolved_payout_h_den = hDen;
      e.resolved_payout_ready = 1n;
    }
    // R is zero here (cleared just above): released_pos is the PnL.
    const released = toU128(pnl);
    if (e.resolved_payout_h_den === 0n) failCorrupt();
    const y = wideMulDivFloorU128(released, e.resolved_payout_h_num, e.resolved_payout_h_den);
    const none = emptyContext(0n, 0n);
    setPnlWithReserve(e, i, 0n, RESERVE_NO_POSITIVE_INCREASE, none);
    const cap = e.accounts.get(i).capital;
    require(cap <= 340282366920938463463374607431768211455n - y, PercolatorError.EngineOverflow);
    setCapital(e, i, cap + y);
  }
  feeDebtSweep(e, i);
  const b = e.accounts.get(i);
  if (b.fee_credits < 0n) b.fee_credits = 0n;
  const capital = b.capital;
  if (capital > e.vault) require(false, PercolatorError.EngineInsufficientBalance);
  e.vault = e.vault - capital;
  setCapital(e, i, 0n);
  freeSlot(e, idx);
  sweepEmptyMarketSurplusToInsurance(e);
  assertPublicPostconditions(e);
  return capital;
}

/** ResolvedCloseResult::ProgressOnly as forceCloseResolvedNotAtomic returns it (no payout reaches u128::MAX). */
export const PROGRESS_ONLY: u128 = 340282366920938463463374607431768211455n;

/**
 * force_close_resolved_not_atomic: reconcile (always kept), finalize the sides that are ready, then the terminal close
 * unless the PnL is positive and the market not terminal-ready yet (PROGRESS_ONLY).
 */
export function forceCloseResolvedNotAtomic(e: Inout<RiskEngine>, idx: u16): u128 {
  reconcileResolvedNotAtomic(e, idx);
  maybeFinalizeReadyResetSides(e);
  if (e.accounts.get(toU64(idx)).pnl > 0n && !isTerminalReady(e)) return PROGRESS_ONLY;
  return closeResolvedTerminalNotAtomic(e, idx);
}
