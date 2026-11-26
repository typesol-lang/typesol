// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The account refresh as far as a portfolio without open legs needs it, and the maintenance fee:
// `sync_account_fee_to_slot_not_atomic` (with `account_fee_anchor_for_loss_currentness`),
// `settle_negative_pnl_from_principal_core_not_atomic` (`V16Core::kernel_settle_principal`,
// `set_account_pnl_after_principal_settlement`, `sync_unattributed_loss_lock`, `record_account_residual_crystallized_loss`),
// `charge_account_fee_current_not_atomic`, `credit_account_from_insurance_not_atomic`
// (`credit_account_from_insurance_delta`), `credit_domain_insurance_budget_not_atomic` (`set_domain_insurance_budget_core`,
// `set_domain_insurance_budget_delta`, `apply_total_delta`), `withdraw_not_atomic` and `account_equity_from_parts`.
//
// The settlement of an account's open legs (`settle_account_side_effects_not_atomic`, settlement.ts), which
// `sync_account_fee_to_slot_not_atomic` runs on a Live market for a portfolio with an active leg whose fee anchor has
// moved, is ported with the layers below it (NOTES.md, section 10).
//
// Errors. Every engine error here reaches the processor through `map_v16_error` (failV16 / checkV16): each function
// fails in place. No caller looks at one of these errors and goes on.
//
// Token-value proofs. Each money move here builds a `TokenValueFlowProofV16` and validates it: debits equal credits and
// the external flow equals the vault's change. Every proof built here moves one amount between two classes (account
// capital, insurance, realized loss) with the vault unchanged, or one amount out of account capital to the outside with
// the vault lowered by it: each balances by construction and its validation cannot refuse, so none is formed.
import { type FixedArray, type RemainingAccount, type i128, type u64, type u128, type u256, loadRawAt, loadRawMutAt, u64 as toU64, u128 as toU128, i128 as toI128, u256 as toU256 } from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_B_STALE,
  V16_COUNTER_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_HIDDEN_LEG,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import { type EngineAssetSlot, type GroupHeader, type Portfolio, HEADER_LEN, MARKET_GROUP_OFF } from "./state.js";
import { V16_MAX_PORTFOLIO_ASSETS_N, assetStateErr, closeProgressErr } from "./wire.js";
import { LIFECYCLE_ACTIVE, LIFECYCLE_DRAIN_ONLY, MARKET_MODE_RESOLVED, engineSlotAt, legErr, marketShapeErr, validateWithMarket } from "./engine.js";
import { validateSourceDomainLedger } from "./lifecycle.js";
import { settleAccountSideEffects } from "./settlement.js";

/** MarketModeV16::Live and ::Recovery bytes. */
const MODE_LIVE = 0n;
const MODE_RECOVERY = 2n;
const U128_MAX_R: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MAX_R: u128 = 0x7fffffffffffffffffffffffffffffffn;
const U128_MAX_RW: u256 = 340282366920938463463374607431768211455n;

// ---- The maintenance fee ------------------------------------------------------------------------------------------------

/**
 * `account_fee_anchor_for_loss_currentness(account, now)`: the earliest `slot_last` of the assets of the portfolio's
 * active legs that still carry positions or loss state (`asset_contributes_to_loss_stale_summary`), and `now` at most.
 * Its refusals (a bitmap bit over an inactive leg: HiddenLeg; an asset out of range: InvalidLeg; the decodings) were
 * checked by `validate_with_market` just before; they are kept, at the cost of a comparison each.
 */
function feeAnchor(m: RemainingAccount, pa: RemainingAccount, markets: u64, now: u64): u64 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const configured = toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots);
  const bitmap = p.active_bitmap.get(0n);
  let anchor = now;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    if (((bitmap >> slot) & 1n) === 0n) continue;
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) failV16(V16_HIDDEN_LEG);
    const asset = toU64(leg.asset_index);
    if (asset >= configured || asset >= markets) failV16(V16_INVALID_LEG);
    const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
    checkV16(assetStateErr(a));
    const live = a.lifecycle === LIFECYCLE_ACTIVE || a.lifecycle === LIFECYCLE_DRAIN_ONLY;
    const exposed =
      a.oi_eff_long_q !== 0n ||
      a.oi_eff_short_q !== 0n ||
      a.stored_pos_count_long !== 0n ||
      a.stored_pos_count_short !== 0n ||
      a.stale_account_count_long !== 0n ||
      a.stale_account_count_short !== 0n ||
      a.pending_obligation_count_long !== 0n ||
      a.pending_obligation_count_short !== 0n ||
      a.loss_weight_sum_long !== 0n ||
      a.loss_weight_sum_short !== 0n;
    if (live && exposed && a.slot_last < anchor) anchor = a.slot_last;
  }
  return anchor;
}

/**
 * `sync_account_fee_to_slot_not_atomic(account, now_slot, fee_rate_per_slot)`: validated with the market; a market in
 * Recovery refused (LockActive), a `now` behind the portfolio's fee slot refused (Stale); the fee anchor (Live with an
 * active leg: `account_fee_anchor_for_loss_currentness`; Resolved: the resolved slot; otherwise `now`), nothing charged
 * when it has not passed the fee slot; the fee rate · elapsed slots in 256 bits (a u128 times a u64 never leaves them),
 * saturated to u128; then (Live with an active leg) the legs settled (`settle_account_side_effects_not_atomic` with the
 * config's public B chunk as the loss budget; a settlement that stops at a B chunk is BStale); the negative PnL settled from principal; the fee charged from capital; the fee slot moved to the
 * anchor; validated with the market and the market's shape. Returns the fee charged.
 *
 * The market's mode was decoded by `read_market_config_mode_and_capacity` at both callers (its `decode_market_mode`
 * here cannot refuse).
 */
export function syncAccountFeeToSlot(m: RemainingAccount, pa: RemainingAccount, markets: u64, now: u64, rate: u128): u128 {
  validateWithMarket(m, pa, markets);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const mode = h.mode;
  if (mode === MODE_RECOVERY) failV16(V16_LOCK_ACTIVE);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const last = p.last_fee_slot;
  if (now < last) failV16(V16_STALE);
  const legs = mode === MODE_LIVE && p.active_bitmap.get(0n) !== 0n;
  let anchor = now;
  if (legs) anchor = feeAnchor(m, pa, markets, now);
  else if (mode === MARKET_MODE_RESOLVED) anchor = h.resolved_slot;
  if (anchor <= last) return 0n;
  const raw: u256 = toU256(rate) * toU256(anchor - last);
  const requested: u128 = raw > U128_MAX_RW ? U128_MAX_R : toU128(raw);
  if (legs && settleAccountSideEffects(m, markets, pa, h.config.public_b_chunk_atoms).current === 0n) failV16(V16_B_STALE);
  settleNegativePnlFromPrincipal(m, pa);
  const charged = chargeAccountFeeCurrent(m, pa, requested);
  p.last_fee_slot = anchor;
  validateWithMarket(m, pa, markets);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  return charged;
}

/**
 * `settle_negative_pnl_from_principal_core_not_atomic`: for a negative PnL, the capital pays as much of the loss as it
 * holds (`kernel_settle_principal`: c_tot lowered by the same, CounterUnderflow). Nothing paid: the market's bankruptcy
 * lock set. Otherwise the capital and c_tot lowered, the PnL raised by the amount paid
 * (`set_account_pnl_after_principal_settlement`: a PnL brought to zero leaves the market's count of negative-PnL
 * accounts, CounterUnderflow; the unattributed-loss lock recomputed), the residual crystallized loss raised
 * (CounterOverflow), the bankruptcy lock set if a loss remains, the health certificate invalidated.
 *
 * `paid` fits i128 (it is at most the loss, |pnl| ≤ i128::MAX: validate_with_market refused i128::MIN), and the new PnL
 * lies between the old and zero: `kernel_settle_principal`'s conversions and `set_account_pnl_after_principal_settlement`'s
 * shape checks (InvalidConfig, `validate_non_min_i128`) cannot refuse and are not repeated.
 */
export function settleNegativePnlFromPrincipal(m: RemainingAccount, pa: RemainingAccount): u128 {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const pnl = p.pnl;
  if (pnl >= 0n) return 0n;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const loss = toU128(-(pnl + 1n)) + 1n;
  const capital = p.capital;
  const paid = capital < loss ? capital : loss;
  if (h.c_tot < paid) failV16(V16_COUNTER_UNDERFLOW);
  if (paid === 0n) {
    h.bankruptcy_hlock_active = 1n;
    return 0n;
  }
  const newPnl: i128 = pnl + toI128(paid);
  p.capital = capital - paid;
  h.c_tot -= paid;
  if (newPnl === 0n) {
    if (h.negative_pnl_account_count === 0n) failV16(V16_COUNTER_UNDERFLOW);
    h.negative_pnl_account_count -= 1n;
  }
  // sync_unattributed_loss_lock (its bool was decoded by validate_with_market): locked while a loss remains and the
  // account was locked or holds more than one active leg (the bitmap's count of ones above one).
  const bitmap = p.active_bitmap.get(0n);
  const several = bitmap !== 0n && (bitmap & (bitmap - 1n)) !== 0n;
  p.liquidation_lock = newPnl < 0n && (p.liquidation_lock === 1n || several) ? 1n : 0n;
  p.pnl = newPnl;
  if (p.residual_crystallized_loss_atoms_total > U128_MAX_R - paid) failV16(V16_COUNTER_OVERFLOW);
  p.residual_crystallized_loss_atoms_total += paid;
  if (newPnl < 0n) h.bankruptcy_hlock_active = 1n;
  p.health_cert.valid = 0n;
  return paid;
}

/**
 * `charge_account_fee_current_not_atomic(account, requested)`: nothing for a zero fee or a negative PnL; otherwise as
 * much as the capital holds, moved from the capital and c_tot (CounterUnderflow) into the insurance
 * (ArithmeticOverflow), the health certificate invalidated. Returns the amount charged.
 */
export function chargeAccountFeeCurrent(m: RemainingAccount, pa: RemainingAccount, requested: u128): u128 {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (requested === 0n || p.pnl < 0n) return 0n;
  const charged = requested < p.capital ? requested : p.capital;
  if (charged === 0n) return 0n;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.c_tot < charged) failV16(V16_COUNTER_UNDERFLOW);
  if (h.insurance > U128_MAX_R - charged) failV16(V16_ARITHMETIC_OVERFLOW);
  p.capital -= charged;
  h.c_tot -= charged;
  h.insurance += charged;
  p.health_cert.valid = 0n;
  return charged;
}

// ---- Insurance credits ---------------------------------------------------------------------------------------------------

/**
 * `credit_account_from_insurance_not_atomic(account, amount)`: nothing for zero; validated with the market; the
 * insurance lowered (CounterUnderflow) but not below the remaining domain budgets (LockActive), c_tot and the capital
 * raised (ArithmeticOverflow each), the health certificate invalidated; validated with the market and the market's shape.
 */
export function creditAccountFromInsurance(m: RemainingAccount, pa: RemainingAccount, markets: u64, amount: u128): void {
  if (amount === 0n) return;
  validateWithMarket(m, pa, markets);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (h.insurance < amount) failV16(V16_COUNTER_UNDERFLOW);
  const insurance = h.insurance - amount;
  if (h.insurance_domain_budget_remaining_total > insurance) failV16(V16_LOCK_ACTIVE);
  if (h.c_tot > U128_MAX_R - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  if (p.capital > U128_MAX_R - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  h.insurance = insurance;
  h.c_tot += amount;
  p.capital += amount;
  p.health_cert.valid = 0n;
  validateWithMarket(m, pa, markets);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `credit_domain_insurance_budget_not_atomic(domain, amount)` (`credit_domain_insurance_budgets_not_atomic` of one
 * credit): the domain configured and in the view (`domain_asset_side`: InvalidLeg); its budget raised by the amount
 * (ArithmeticOverflow); `set_domain_insurance_budget_core` (the old and new remaining parts, budget − spent:
 * InvalidConfig; the market's remaining-budget total moved by their difference, CounterOverflow, and not above the
 * insurance, LockActive); `validate_source_domain_ledger(domain)`; the market's shape. Already-collected insurance:
 * the vault and the insurance do not move.
 */
export function creditDomainInsuranceBudget(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const asset = domain / 2n;
  if (domain >= 2n * toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const short = domain % 2n === 1n;
  const budget = short ? e.insurance_domain_budget_short : e.insurance_domain_budget_long;
  const spent = short ? e.insurance_domain_spent_short : e.insurance_domain_spent_long;
  if (budget > U128_MAX_R - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  // domain_budget_remaining_parts of the old budget (the new one is larger, so it passes when this does).
  if (budget < spent) failV16(V16_INVALID_CONFIG);
  // apply_total_delta: the remaining part grows by exactly the amount.
  const total = h.insurance_domain_budget_remaining_total;
  if (total > U128_MAX_R - amount) failV16(V16_COUNTER_OVERFLOW);
  if (total + amount > h.insurance) failV16(V16_LOCK_ACTIVE);
  h.insurance_domain_budget_remaining_total = total + amount;
  if (short) e.insurance_domain_budget_short = budget + amount;
  else e.insurance_domain_budget_long = budget + amount;
  validateSourceDomainLedger(m, asset, short);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `credit_domain_insurance_budgets_not_atomic(credits[..n])` (a batch trade's fee credits, the domains distinct): each
 * domain's budget raised in order (as `creditDomainInsuranceBudget` without its validations), then each domain's
 * ledger validated, then the market's shape. InvalidConfig for no credit.
 */
export function creditDomainInsuranceBudgets(m: RemainingAccount, markets: u64, domains: FixedArray<u64, 34>, amounts: FixedArray<u128, 34>, n: u64): void {
  if (n === 0n) failV16(V16_INVALID_CONFIG);
  for (let i = 0n; i < n; i++) {
    const domain = domains.get(i);
    const amount = amounts.get(i);
    const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    const asset = domain / 2n;
    if (domain >= 2n * toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
    const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
    const short = domain % 2n === 1n;
    const budget = short ? e.insurance_domain_budget_short : e.insurance_domain_budget_long;
    const spent = short ? e.insurance_domain_spent_short : e.insurance_domain_spent_long;
    if (budget > U128_MAX_R - amount) failV16(V16_ARITHMETIC_OVERFLOW);
    if (budget < spent) failV16(V16_INVALID_CONFIG);
    const total = h.insurance_domain_budget_remaining_total;
    if (total > U128_MAX_R - amount) failV16(V16_COUNTER_OVERFLOW);
    if (total + amount > h.insurance) failV16(V16_LOCK_ACTIVE);
    h.insurance_domain_budget_remaining_total = total + amount;
    if (short) e.insurance_domain_budget_short = budget + amount;
    else e.insurance_domain_budget_long = budget + amount;
  }
  for (let i = 0n; i < n; i++) validateSourceDomainLedger(m, domains.get(i) / 2n, domains.get(i) % 2n === 1n);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

// ---- Withdrawal --------------------------------------------------------------------------------------------------------

/**
 * `withdraw_not_atomic(account, amount)`: nothing for zero; validated with the market; a market not Live refused
 * (LockActive); a portfolio with an active leg refused (Stale); a close ledger that is neither EMPTY, canceled nor
 * finalized-inert refused (LockActive); the negative PnL settled from principal; a PnL still negative or an amount
 * above the capital refused (LockActive); the equity after (`account_equity_from_parts`: the capital as i128,
 * ArithmeticOverflow; capital + PnL − fee debt, ArithmeticOverflow) negative refused (InvalidConfig); c_tot and the
 * vault lowered (CounterUnderflow each), the capital lowered, the health certificate invalidated; validated with the
 * market and the market's shape.
 *
 * `account_equity_from_parts` repeats `validate_non_min_i128(pnl)` (the PnL is not negative here) and
 * `validate_fee_credits` (validate_with_market checked the unchanged fee credits): neither can refuse. The fee debt
 * |fee_credits| fits i128 for the same reason, and capital + PnL − fee debt cannot go below i128::MIN once the sum
 * fits (both are at least 0), so the equity is compared in u128: capital + PnL against the fee debt.
 */
export function withdrawEngine(m: RemainingAccount, pa: RemainingAccount, markets: u64, amount: u128): void {
  if (amount === 0n) return;
  validateWithMarket(m, pa, markets);
  if (loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode !== MODE_LIVE) failV16(V16_LOCK_ACTIVE);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (p.active_bitmap.get(0n) !== 0n) failV16(V16_STALE);
  const c = p.close_progress;
  checkV16(closeProgressErr(c));
  const irreversible =
    c.support_consumed !== 0n ||
    c.junior_face_burned !== 0n ||
    c.insurance_spent !== 0n ||
    c.b_loss_booked !== 0n ||
    c.explicit_loss_assigned !== 0n ||
    c.quantity_adl_applied_q !== 0n ||
    c.drift_consumed !== 0n;
  const empty =
    c.active === 0n &&
    c.finalized === 0n &&
    c.canceled === 0n &&
    c.close_id === 0n &&
    c.asset_index === 0n &&
    c.market_id === 0n &&
    c.domain_side === 0n &&
    c.gross_loss_at_close_start === 0n &&
    c.drift_reference_slot === 0n &&
    c.max_close_slot === 0n &&
    !irreversible &&
    c.residual_remaining === 0n;
  const finalizedInert = c.active === 1n && c.finalized === 1n && c.canceled === 0n && c.residual_remaining === 0n;
  if (!empty && c.canceled === 0n && !finalizedInert) failV16(V16_LOCK_ACTIVE);
  settleNegativePnlFromPrincipal(m, pa);
  const pnl = p.pnl;
  if (pnl < 0n || amount > p.capital) failV16(V16_LOCK_ACTIVE);
  const post = p.capital - amount;
  if (post > I128_MAX_R) failV16(V16_ARITHMETIC_OVERFLOW);
  const gain = toU128(pnl);
  if (post > I128_MAX_R - gain) failV16(V16_ARITHMETIC_OVERFLOW);
  const debt = toU128(-p.fee_credits);
  if (post + gain < debt) failV16(V16_INVALID_CONFIG);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.c_tot < amount) failV16(V16_COUNTER_UNDERFLOW);
  if (h.vault < amount) failV16(V16_COUNTER_UNDERFLOW);
  p.capital = post;
  h.c_tot -= amount;
  h.vault -= amount;
  p.health_cert.valid = 0n;
  validateWithMarket(m, pa, markets);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}
