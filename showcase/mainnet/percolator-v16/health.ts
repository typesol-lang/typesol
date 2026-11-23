// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// Margin and health certificates (NOTES.md, sections 11 and 12): the requirements of a leg (`risk_notional_ceil`,
// `margin_requirement`, `V16Core::effective_abs_quantity_for_leg`, the target-effective lag penalty), the haircut equity
// (`account_haircut_equity`, `account_source_realizable_support`, `source_lien_effective_reserved_supporting`), the
// certificate (`compute_account_health_cert_with_price_override`, `recertify_account_after_trade_delta`,
// `recertify_account_after_source_lien_change`), its currentness (`kernel_cert_is_current`,
// `ensure_favorable_action_current_certificate`), the H-lock lane of an account (`h_lock_lane`) with the loss-stale and
// domain-barrier scans, and the refresh that settles an account and certifies it before a position action
// (`settle_account_for_position_action_and_refresh_not_atomic`, `refresh_account_and_certify_not_atomic` with the crank's
// price override and B chunk, and the lapsed-backing scans the crank's refresh and classification use).
//
// The certificate. The original builds a `HealthCertV16` value and every caller reached from a ported instruction writes
// it into the portfolio (`account.header.health_cert = from_runtime(&cert)`) before anything else reads it; the port
// writes it where the value is formed (`writeCert`). No error on these paths is swallowed after a write, except the
// read-only `ensure_favorable_action_current_certificate(...).is_ok()` of the position-action refresh (section 1 site 7).
import {
  type FixedArray,
  type RemainingAccount,
  type i128,
  type u8,
  type u64,
  type u128,
  type u256,
  fixedArray,
  loadRawAt,
  loadRawMutAt,
  i128 as toI128,
  u64 as toU64,
  u128 as toU128,
  u256 as toU256,
} from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_B_STALE,
  V16_COUNTER_UNDERFLOW,
  V16_HIDDEN_LEG,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_PROVENANCE_MISMATCH,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type AssetState,
  type BackingBucket,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type PortfolioLeg,
  type PortfolioSourceDomain,
  type SourceCreditState,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  MAX_ORACLE_PRICE,
} from "./state.js";
import {
  ADL_ONE,
  BOUND_SCALE,
  I128_MIN,
  MAX_MARGIN_BPS,
  V16_ACCOUNT_VERSION,
  V16_LAYOUT_DISCRIMINATOR,
  V16_MAX_PORTFOLIO_ASSETS_N,
  assetStateErr,
  backingBucketStatusErr,
  boolErr,
  closeProgressErr,
  configShapeErr,
  healthCertErr,
  marketModeErr,
  nonMinI128Err,
  sideErr,
} from "./wire.js";
import {
  LIFECYCLE_ACTIVE,
  LIFECYCLE_DRAIN_ONLY,
  LIFECYCLE_RECOVERY,
  MIN_A_SIDE,
  MAX_POSITION_ABS_Q,
  PORTFOLIO_SOURCE_DOMAIN_CAP,
  closeProgressWithMarket,
  compactSourceDomains,
  engineSlotAt,
  legBoundToAsset,
  legErr,
  receiptStaticCheck,
  sourceCreditShapeWithMarket,
} from "./engine.js";
import { assetIsLossStaleAt, bTargetForLeg, boundNumFromAmount, mulDivCeilOrWide, sourceRealizableSupport } from "./kernels.js";
import {
  accountSourceClaimBoundSum,
  assetStateOf,
  bucketAt,
  bucketForDomain,
  bucketRawStatusExpiry,
  closeHasPendingResidual,
  collectBackingUtilizationFee,
  domainAssetSide,
  domainHasDefaultTag,
  domainIsOccupied,
  domainIsSparseTailDefault,
  expireSourceBackingBucket,
  hasBStaleLeg,
  hasPendingDomainLossBarrier,
  insuranceDomainIndex,
  sourceAt,
  sourceForDomain,
  validateDomainLedgerCurrent,
} from "./primitives.js";
import { markLegBStale, settleAccountBChunk, settleAccountKfEffects } from "./settlement.js";
import { settleNegativePnlFromPrincipal } from "./refresh.js";
import { clearLeg } from "./trade.js";

const U128_MAX_H: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MAX_H: u128 = 0x7fffffffffffffffffffffffffffffffn;
const U128_MAX_HW: u256 = 340282366920938463463374607431768211455n;
const U64_MAX_H: u64 = 0xffffffffffffffffn;
/** `POS_SCALE`. */
const POS_SCALE_H: u128 = 1000000n;
/** `SideModeV16::ResetPending`. */
const SIDE_MODE_RESET_PENDING_H: u8 = 2n;
/** `MarketModeV16::Recovery`. */
const MODE_RECOVERY_H: u8 = 2n;
/** `BackingBucketStatusV16::Fresh`. */
const BUCKET_FRESH_H: u8 = 1n;

/** |x| of an i128 that is not i128::MIN. */
export function absH(x: i128): u128 {
  return x < 0n ? toU128(-x) : toU128(x);
}

// ---- A leg's requirements --------------------------------------------------------------------------------------------

/**
 * `risk_notional_ceil(abs_pos_q, price)`: ⌈q · price / POS_SCALE⌉, 0 for no quantity; in 256 bits when the product
 * leaves u128 (`checked_mul_div_ceil_u256`), ArithmeticOverflow when the quotient does not fit u128.
 */
export function riskNotionalCeil(q: u128, price: u64): u128 {
  if (q === 0n) return 0n;
  const p: u256 = toU256(q) * toU256(price);
  const r: u256 = p / toU256(POS_SCALE_H) + (p % toU256(POS_SCALE_H) !== 0n ? 1n : 0n);
  if (r > U128_MAX_HW) failV16(V16_ARITHMETIC_OVERFLOW);
  return toU128(r);
}

/** `margin_requirement(notional, bps, floor)`: 0 for no notional, else max(⌈notional · bps / 10,000⌉, floor). */
export function marginRequirement(notional: u128, bps: u64, floor: u128): u128 {
  if (notional === 0n) return 0n;
  const raw = mulDivCeilOrWide(notional, toU128(bps), MAX_MARGIN_BPS);
  return raw > floor ? raw : floor;
}

/** `kernel_is_prior_reset_obligation(side_mode, asset_epoch, leg_epoch_snap)`. */
export function isPriorResetObligation(mode: u8, assetEpoch: u64, legEpoch: u64): boolean {
  return mode === SIDE_MODE_RESET_PENDING_H && legEpoch !== U64_MAX_H && legEpoch + 1n === assetEpoch;
}

/** `leg_is_prior_reset_obligation(asset, leg)`. */
export function legIsPriorResetObligation(a: AssetState, l: PortfolioLeg): boolean {
  const short = l.side === 1n;
  return isPriorResetObligation(short ? a.mode_short : a.mode_long, short ? a.epoch_short : a.epoch_long, l.epoch_snap);
}

/** `kernel_adl_effective_quantity_ceil(raw, a_basis, current_a)`: InvalidLeg out of range, else ⌈raw · current_a / a_basis⌉. */
export function adlEffectiveQuantityCeil(raw: u128, aBasis: u128, currentA: u128): u128 {
  if (raw > MAX_POSITION_ABS_Q || aBasis < MIN_A_SIDE || aBasis > ADL_ONE || currentA < 1n || currentA > aBasis) failV16(V16_INVALID_LEG);
  return mulDivCeilOrWide(raw, currentA, aBasis);
}

/**
 * `V16Core::effective_abs_quantity_for_leg(asset, leg)`: InvalidLeg for an inactive leg; a leg of the side's epoch scales
 * its basis by the side's A (`kernel_adl_effective_quantity_ceil`); a prior-reset obligation owns nothing; any other
 * epoch is InvalidLeg.
 */
export function effectiveAbsQuantityForLeg(a: AssetState, l: PortfolioLeg): u128 {
  if (l.active !== 1n) failV16(V16_INVALID_LEG);
  const short = l.side === 1n;
  const currentA = short ? a.a_short : a.a_long;
  const epoch = short ? a.epoch_short : a.epoch_long;
  const mode = short ? a.mode_short : a.mode_long;
  if (l.epoch_snap === epoch) return adlEffectiveQuantityCeil(absH(l.basis_pos_q), l.a_basis, currentA);
  if (isPriorResetObligation(mode, epoch, l.epoch_snap)) return 0n;
  failV16(V16_INVALID_LEG);
  return 0n;
}

/** `target_effective_lag_loss_penalty(q, side, effective, target)`: the notional of the adverse gap between the stored
 * target and the effective price (`target_effective_lag_adverse_delta`: a long below, a short above). */
export function targetLagPenalty(q: u128, short: boolean, effective: u64, target: u64): u128 {
  let adverse: u64 = 0n;
  if (!short && target < effective) adverse = effective - target;
  else if (short && target > effective) adverse = target - effective;
  return riskNotionalCeil(q, adverse);
}

/** A leg's initial, maintenance and worst-case requirements (`health_requirements_from_notional_and_target_lag`). */
export interface Requirements {
  initial: u128;
  maintenance: u128;
  worst: u128;
}

/** `health_requirements_from_notional_and_target_lag(config, notional, penalty)`: the margins raised by the penalty
 * (ArithmeticOverflow each). */
export function healthRequirements(m: RemainingAccount, notional: u128, penalty: u128): Requirements {
  const c = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config;
  const initial = marginRequirement(notional, c.initial_margin_bps, c.min_nonzero_im_req);
  const maintenance = marginRequirement(notional, c.maintenance_margin_bps, c.min_nonzero_mm_req);
  if (initial > U128_MAX_H - penalty || maintenance > U128_MAX_H - penalty || notional > U128_MAX_H - penalty) failV16(V16_ARITHMETIC_OVERFLOW);
  return { initial: initial + penalty, maintenance: maintenance + penalty, worst: notional + penalty };
}

// ---- The haircut equity ----------------------------------------------------------------------------------------------

/**
 * `source_lien_effective_reserved_supporting(source)`: a lien's effective reserve; without counterparty backing all of
 * it; with counterparty backing, all of it while the domain's bucket is Fresh and not lapsed at the market's slot (the
 * raw status and expiry, not decoded), else less the counterparty part (CounterUnderflow). The domain is checked
 * (`domain_asset_side`).
 */
export function lienEffectiveSupporting(m: RemainingAccount, markets: u64, s: PortfolioSourceDomain): u128 {
  const effective = s.source_lien_effective_reserved;
  const cp = s.source_lien_counterparty_backing_num;
  if (cp === 0n) return effective;
  const d = toU64(s.domain);
  domainAssetSide(m, markets, d);
  const b = loadRawAt<BackingBucket>(m, bucketAt(d));
  if (b.status === BUCKET_FRESH_H && b.expiry_slot > loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot) return effective;
  const part = cp / BOUND_SCALE;
  if (effective < part) failV16(V16_COUNTER_UNDERFLOW);
  return effective - part;
}

/**
 * `account_source_realizable_support(account, face)`: what the portfolio's source claims can realize of a face, slot by
 * slot until the face is covered or the compacted tail: the valid lien reserve that supports (at most the face left),
 * then the unliened claim at the domain's credit (the ledger current, `source_credit_state_realizable_support_for_claim_num`).
 * A slot whose liened and impaired claim exceed its bound is InvalidLeg.
 */
export function accountSourceRealizableSupport(m: RemainingAccount, markets: u64, pa: RemainingAccount, face: u128): u128 {
  if (face === 0n) return 0n;
  let remaining = boundNumFromAmount(face);
  let support: u128 = 0n;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP && remaining !== 0n; slot++) {
    const s = p.source_domains.get(slot);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) break;
    if (!occupied) continue;
    const d = toU64(s.domain);
    if (s.source_claim_liened_num > U128_MAX_H - s.source_claim_impaired_num) failV16(V16_ARITHMETIC_OVERFLOW);
    const locked = s.source_claim_liened_num + s.source_claim_impaired_num;
    if (locked > s.source_claim_bound_num) failV16(V16_INVALID_LEG);
    let lien = lienEffectiveSupporting(m, markets, s);
    const cap = remaining / BOUND_SCALE;
    if (lien > cap) lien = cap;
    if (lien !== 0n) {
      if (support > U128_MAX_H - lien) failV16(V16_ARITHMETIC_OVERFLOW);
      support += lien;
      // lien ≤ remaining / BOUND_SCALE: the product fits and is at most `remaining`.
      remaining -= lien * BOUND_SCALE;
    }
    let claim = s.source_claim_bound_num - locked;
    if (claim > remaining) claim = remaining;
    if (claim !== 0n) {
      validateDomainLedgerCurrent(m, markets, d);
      sourceForDomain(m, markets, d);
      const credited = sourceRealizableSupport(loadRawAt<SourceCreditState>(m, sourceAt(d)), claim);
      if (support > U128_MAX_H - credited) failV16(V16_ARITHMETIC_OVERFLOW);
      support += credited;
      remaining -= claim;
    }
  }
  return support;
}

/**
 * `account_haircut_equity(account)`: capital + min(PnL, 0) − fee debt for a PnL at or below zero; for a positive PnL the
 * capital plus what its source claims realize of it (nothing without claims) less the fee debt (ArithmeticOverflow).
 */
export function accountHaircutEquity(m: RemainingAccount, markets: u64, pa: RemainingAccount): i128 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(nonMinI128Err(p.pnl));
  // validate_fee_credits.
  checkV16(nonMinI128Err(p.fee_credits));
  if (p.fee_credits > 0n) failV16(V16_INVALID_LEG);
  if (p.capital > I128_MAX_H) failV16(V16_ARITHMETIC_OVERFLOW);
  const capital = toI128(p.capital);
  const debt = toI128(absH(p.fee_credits));
  if (p.pnl <= 0n) {
    // capital ≥ 0 and pnl > i128::MIN: the sum cannot leave i128 downwards, and neither can the difference fall below
    // i128::MIN unless capital + pnl is below i128::MIN + debt.
    const sum = capital + p.pnl;
    if (sum < I128_MIN + debt) failV16(V16_ARITHMETIC_OVERFLOW);
    return sum - debt;
  }
  let support: u128 = 0n;
  if (accountSourceClaimBoundSum(pa) !== 0n) support = accountSourceRealizableSupport(m, markets, pa, toU128(p.pnl));
  if (support > I128_MAX_H) failV16(V16_ARITHMETIC_OVERFLOW);
  if (toU128(capital) > I128_MAX_H - support) failV16(V16_ARITHMETIC_OVERFLOW);
  return capital + toI128(support) - debt;
}

// ---- The certificate -------------------------------------------------------------------------------------------------

/** The certificate's write-back (`HealthCertV16Account::from_runtime`): the equity, the requirements, the deficit, the
 * market's four epochs and the portfolio's bitmap, valid. */
function writeCert(m: RemainingAccount, pa: RemainingAccount, equity: i128, initial: u128, maintenance: u128, worst: u128): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const c = p.health_cert;
  c.certified_equity = equity;
  c.certified_initial_req = initial;
  c.certified_maintenance_req = maintenance;
  if (equity < 0n) c.certified_liq_deficit = absH(equity);
  else c.certified_liq_deficit = maintenance > toU128(equity) ? maintenance - toU128(equity) : 0n;
  c.certified_worst_case_loss = worst;
  c.cert_oracle_epoch = h.oracle_epoch;
  c.cert_funding_epoch = h.funding_epoch;
  c.cert_risk_epoch = h.risk_epoch;
  c.cert_asset_set_epoch = h.asset_set_epoch;
  c.active_bitmap_at_cert.set(0n, p.active_bitmap.get(0n));
  c.valid = 1n;
}

/**
 * `compute_account_health_cert_with_price_override(account, require_b_current, None)` and its write-back: the config's
 * shape, then each active leg: (with `requireB`) BStale when its B target is ahead of its snapshot, the asset decoded,
 * the effective quantity, the risk notional at the effective price, the lag penalty, the requirements summed
 * (ArithmeticOverflow); then the haircut equity. No caller reached from a ported instruction passes a price override.
 */
export function computeHealthCert(m: RemainingAccount, markets: u64, pa: RemainingAccount, requireB: boolean): void {
  checkV16(configShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config));
  let initial: u128 = 0n;
  let maintenance: u128 = 0n;
  let worst: u128 = 0n;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) continue;
    const asset = toU64(leg.asset_index);
    if (requireB) {
      assetStateOf(m, markets, asset);
      if (bTargetForLeg(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset, leg) > leg.b_snap) failV16(V16_B_STALE);
    }
    assetStateOf(m, markets, asset);
    const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
    const q = effectiveAbsQuantityForLeg(a, leg);
    const notional = riskNotionalCeil(q, a.effective_price);
    const penalty = targetLagPenalty(q, leg.side === 1n, a.effective_price, a.raw_oracle_target_price);
    const r = healthRequirements(m, notional, penalty);
    if (initial > U128_MAX_H - r.initial || maintenance > U128_MAX_H - r.maintenance || worst > U128_MAX_H - r.worst) failV16(V16_ARITHMETIC_OVERFLOW);
    initial += r.initial;
    maintenance += r.maintenance;
    worst += r.worst;
  }
  writeCert(m, pa, accountHaircutEquity(m, markets, pa), initial, maintenance, worst);
}

/**
 * `recertify_account_after_trade_delta(account, asset, old_abs_q, new_abs_q, price)`: InvalidConfig for an asset past
 * the configured slots or a price out of range; with a target-effective lag on the asset the whole certificate is
 * computed again; otherwise the stored certificate (decoded) has the old quantity's requirements replaced by the new
 * one's at the price (ArithmeticOverflow for a subtraction below zero or a sum past u128), the equity taken again.
 */
export function recertifyAfterTradeDelta(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, oldQ: u128, newQ: u128, price: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || price === 0n || price > MAX_ORACLE_PRICE) failV16(V16_INVALID_CONFIG);
  assetStateOf(m, markets, asset);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  if (a.raw_oracle_target_price !== a.effective_price) {
    computeHealthCert(m, markets, pa, false);
    return;
  }
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(healthCertErr(p.health_cert));
  const oldNotional = riskNotionalCeil(oldQ, price);
  const newNotional = riskNotionalCeil(newQ, price);
  checkV16(configShapeErr(h.config));
  const c = h.config;
  const oldInitial = marginRequirement(oldNotional, c.initial_margin_bps, c.min_nonzero_im_req);
  const oldMaintenance = marginRequirement(oldNotional, c.maintenance_margin_bps, c.min_nonzero_mm_req);
  const newInitial = marginRequirement(newNotional, c.initial_margin_bps, c.min_nonzero_im_req);
  const newMaintenance = marginRequirement(newNotional, c.maintenance_margin_bps, c.min_nonzero_mm_req);
  const cert = p.health_cert;
  const initial = replaceTerm(cert.certified_initial_req, oldInitial, newInitial);
  const maintenance = replaceTerm(cert.certified_maintenance_req, oldMaintenance, newMaintenance);
  const worst = replaceTerm(cert.certified_worst_case_loss, oldNotional, newNotional);
  writeCert(m, pa, accountHaircutEquity(m, markets, pa), initial, maintenance, worst);
}

/** `v.checked_sub(old).and_then(|v| v.checked_add(new))`, ArithmeticOverflow for either. */
function replaceTerm(v: u128, old: u128, next: u128): u128 {
  if (v < old) failV16(V16_ARITHMETIC_OVERFLOW);
  const rest = v - old;
  if (rest > U128_MAX_H - next) failV16(V16_ARITHMETIC_OVERFLOW);
  return rest + next;
}

/**
 * `recertify_account_after_source_lien_change(account)`: the stored certificate decoded; Stale when its bitmap is not
 * the portfolio's; the requirements kept, the equity and the deficit taken again, the market's epochs and the bitmap.
 */
export function recertifyAfterSourceLienChange(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(healthCertErr(p.health_cert));
  if (p.health_cert.active_bitmap_at_cert.get(0n) !== p.active_bitmap.get(0n)) failV16(V16_STALE);
  const initial = p.health_cert.certified_initial_req;
  const maintenance = p.health_cert.certified_maintenance_req;
  const worst = p.health_cert.certified_worst_case_loss;
  writeCert(m, pa, accountHaircutEquity(m, markets, pa), initial, maintenance, worst);
}

/**
 * `kernel_cert_is_current` on the stored certificate (decoded: `HealthCertV16Account::try_to_runtime`): valid, the four
 * epochs the market's and the bitmap the portfolio's. Returns the decoding's error, or V16_OK / V16_STALE.
 */
export function certCurrentErr(m: RemainingAccount, pa: RemainingAccount): u64 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const c = p.health_cert;
  const e = healthCertErr(c);
  if (e !== 0n) return e;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const current =
    c.valid === 1n &&
    c.cert_oracle_epoch === h.oracle_epoch &&
    c.cert_funding_epoch === h.funding_epoch &&
    c.cert_risk_epoch === h.risk_epoch &&
    c.cert_asset_set_epoch === h.asset_set_epoch &&
    c.active_bitmap_at_cert.get(0n) === p.active_bitmap.get(0n);
  return current ? 0n : V16_STALE;
}

/** `ensure_favorable_action_current_certificate(account)`. */
export function ensureFavorableCurrentCert(m: RemainingAccount, pa: RemainingAccount): void {
  checkV16(certCurrentErr(m, pa));
}

// ---- The H-lock lane -----------------------------------------------------------------------------------------------------

/** `asset_has_target_effective_lag(asset)`: the asset decoded, its stored target not its effective price. */
export function assetHasTargetLag(m: RemainingAccount, markets: u64, asset: u64): boolean {
  assetStateOf(m, markets, asset);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  return a.raw_oracle_target_price !== a.effective_price;
}

/** `asset_is_loss_stale(asset)`: the asset decoded, loss-stale at the market's slot. */
export function assetIsLossStale(m: RemainingAccount, markets: u64, asset: u64): boolean {
  assetStateOf(m, markets, asset);
  return assetIsLossStaleAt(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot);
}

/** `account_has_loss_stale_live_leg(account)`: over the bitmap's slots, each leg decoded and active (HiddenLeg), its
 * asset loss-stale. */
export function accountHasLossStaleLiveLeg(m: RemainingAccount, markets: u64, pa: RemainingAccount): boolean {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    if (((bitmap >> slot) & 1n) === 0n) continue;
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) failV16(V16_HIDDEN_LEG);
    if (assetIsLossStale(m, markets, toU64(leg.asset_index))) return true;
  }
  return false;
}

/** `account_touches_pending_domain_loss_barrier(account)`: over all slots, each leg decoded, an active one whose side of
 * its asset holds a pending domain-loss barrier. */
export function accountTouchesBarrier(m: RemainingAccount, markets: u64, pa: RemainingAccount): boolean {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active === 1n && hasPendingDomainLossBarrier(m, markets, toU64(leg.asset_index), leg.side === 1n)) return true;
  }
  return false;
}

/**
 * `h_lock_lane(Some(account), false) == HMax`: the market's bankruptcy flag decoded first; then the account's locks
 * (liquidation, stale, B-stale, each decoded in turn), a loss-stale live leg, a pending close residual or a touched
 * barrier; then the market's threshold stress (decoded) or Recovery mode. The account-scoped lane ignores the bankruptcy
 * flag's value.
 */
export function accountHLockMax(m: RemainingAccount, markets: u64, pa: RemainingAccount): boolean {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(boolErr(h.bankruptcy_hlock_active));
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(boolErr(p.liquidation_lock));
  if (p.liquidation_lock === 1n) return true;
  checkV16(boolErr(p.stale_state));
  if (p.stale_state === 1n) return true;
  checkV16(boolErr(p.b_stale_state));
  if (p.b_stale_state === 1n) return true;
  if (accountHasLossStaleLiveLeg(m, markets, pa)) return true;
  checkV16(closeProgressErr(p.close_progress));
  if (closeHasPendingResidual(p.close_progress)) return true;
  if (accountTouchesBarrier(m, markets, pa)) return true;
  checkV16(boolErr(h.threshold_stress_active));
  if (h.threshold_stress_active === 1n) return true;
  checkV16(marketModeErr(h.mode));
  return h.mode === MODE_RECOVERY_H;
}

// ---- The refresh before a position action ------------------------------------------------------------------------------

/**
 * `validate_account_scalar_preflight(account)`: the provenance (ProvenanceMismatch), the PnL and fee credits, the
 * liquidation lock (decoded; set with a PnL at or above zero: InvalidLeg), the reserved PnL and the residual totals
 * (InvalidLeg), the resolved-payout receipt (decoded and static), and a close-progress ledger that is not EMPTY with the
 * market (`validate_close_progress_ledger_with_market`, which for EMPTY passes: the port calls it in either case).
 */
export function scalarPreflight(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const ph = p.provenance_header;
  if (
    ph.market_group_id !== h.market_group_id ||
    p.owner !== ph.owner ||
    ph.version !== V16_ACCOUNT_VERSION ||
    ph.layout_discriminator !== V16_LAYOUT_DISCRIMINATOR
  )
    failV16(V16_PROVENANCE_MISMATCH);
  checkV16(nonMinI128Err(p.pnl));
  checkV16(nonMinI128Err(p.fee_credits));
  if (p.fee_credits > 0n) failV16(V16_INVALID_LEG);
  checkV16(boolErr(p.liquidation_lock));
  if (p.liquidation_lock === 1n && p.pnl >= 0n) failV16(V16_INVALID_LEG);
  if (p.reserved_pnl > (p.pnl > 0n ? toU128(p.pnl) : 0n)) failV16(V16_INVALID_LEG);
  if (p.residual_spent_principal_atoms_total > p.residual_crystallized_loss_atoms_total) failV16(V16_INVALID_LEG);
  receiptStaticCheck(p);
  checkV16(closeProgressErr(p.close_progress));
  closeProgressWithMarket(m, pa, markets);
}

/** `clear_account_stale(account)`: the flag decoded; a stale account cleared, the market's count lowered (CounterUnderflow). */
export function clearAccountStale(m: RemainingAccount, pa: RemainingAccount): void {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  checkV16(boolErr(p.stale_state));
  if (p.stale_state !== 1n) return;
  p.stale_state = 0n;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.stale_certificate_count === 0n) failV16(V16_COUNTER_UNDERFLOW);
  h.stale_certificate_count -= 1n;
}

/**
 * `collect_account_backing_utilization_fees_not_atomic(account)`: each occupied source domain before the compacted tail
 * charged its utilization fee (the sum checked: ArithmeticOverflow), then the domains compacted.
 */
export function collectBackingUtilizationFees(m: RemainingAccount, markets: u64, pa: RemainingAccount): u128 {
  let total: u128 = 0n;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) break;
    if (!occupied) continue;
    const charged = collectBackingUtilizationFee(m, markets, pa, toU64(s.domain));
    if (total > U128_MAX_H - charged) failV16(V16_ARITHMETIC_OVERFLOW);
    total += charged;
  }
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  compactSourceDomains(p.source_domains);
  return total;
}

/**
 * `refresh_account_and_certify_not_atomic(account, None, 0, false)`: the scalar preflight; with claims (the first source
 * domain not the sparse tail), the source credit shape with the market and the claims at most the positive PnL's
 * attribution; BStale for a B-stale account; the K/F effects settled (normalizing exhausted sides); then each leg slot:
 * past the configured cap empty, the bitmap and the leg agreeing, an active leg valid, on a configured asset in the view,
 * of its market id, Active, DrainOnly or Recovery, its snapshots bound to the side, its asset not seen before (HiddenLeg
 * for each); a B target ahead of the snapshot marks the leg B-stale and is BStale, as is a B-stale leg; the first settled
 * prior-reset obligation (without a pending close residual) is cleared; every other leg's requirements summed at its
 * asset's effective price. Then the negative PnL settled from principal, the utilization fees collected, BStale for a
 * B-stale account, a stale account cleared, the equity, the certificate written.
 *
 * With `allowB` (the crank's: `refresh_account_and_certify_not_atomic(account, price_override, budget, true)`), the
 * first lapsed Fresh backing bucket of the account (its roster, then its legs' latent domains) is expired before any
 * valuation and the refresh stops there (REFRESH_EXPIRED); a B-stale account is not refused; a leg behind its B target
 * settles one chunk of `budget` and the refresh stops there while B remains (REFRESH_B_CHUNK), as it does at a leg still
 * marked B-stale; a leg of `ovAsset` takes `ovPrice` for its requirements. Returns REFRESH_CERTIFIED otherwise. The
 * trade's call is `refreshAccountAndCertify` (no override, no chunk).
 */
export function refreshAccountAndCertify(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  refreshAndCertify(m, markets, pa, NO_OVERRIDE, 0n, 0n, false);
}

/** `AccountRefreshCertOutcomeV16`: Certified, BChunk, SourceBackingExpired. */
export const REFRESH_CERTIFIED = 0n;
export const REFRESH_B_CHUNK = 1n;
export const REFRESH_EXPIRED = 2n;
/** No price override. */
export const NO_OVERRIDE: u64 = 0xffffffffffffffffn;

export function refreshAndCertify(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  ovAsset: u64,
  ovPrice: u64,
  budget: u128,
  allowB: boolean,
): u64 {
  scalarPreflight(m, markets, pa);
  const p0 = loadRawAt<Portfolio>(pa, HEADER_LEN);
  if (!domainIsSparseTailDefault(p0.source_domains.get(0n))) {
    sourceCreditShapeWithMarket(m, pa);
    const sum = accountSourceClaimBoundSum(pa);
    if (sum !== 0n) {
      // validate_positive_pnl_source_attribution(pnl, sum).
      const pnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
      if (pnl > 0n) {
        if (toU128(pnl) > U128_MAX_H / BOUND_SCALE) failV16(V16_ARITHMETIC_OVERFLOW);
        if (sum < toU128(pnl) * BOUND_SCALE) failV16(V16_INVALID_LEG);
      }
    }
  }
  if (allowB && expireFirstLapsedSourceBacking(m, markets, pa) !== NO_LAPSED) return REFRESH_EXPIRED;
  checkV16(boolErr(loadRawAt<Portfolio>(pa, HEADER_LEN).b_stale_state));
  if (!allowB && loadRawAt<Portfolio>(pa, HEADER_LEN).b_stale_state === 1n) failV16(V16_B_STALE);
  settleAccountKfEffects(m, markets, pa, true);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(configShapeErr(h.config));
  const cap = toU64(h.config.max_portfolio_assets);
  const configured = toU64(h.config.max_market_slots);
  let initial: u128 = 0n;
  let maintenance: u128 = 0n;
  let worst: u128 = 0n;
  const bitmap = loadRawAt<Portfolio>(pa, HEADER_LEN).active_bitmap.get(0n);
  let cleared = false;
  // The assets of the legs walked so far (`seen_assets`): a cleared obligation's asset stays seen.
  const seen: FixedArray<u64, 16> = fixedArray<u64, 16>(0n);
  let seenCount = 0n;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    const bit = ((bitmap >> slot) & 1n) !== 0n;
    const active = leg.active === 1n;
    if (slot >= cap) {
      // An inactive leg is empty once decoded (`try_to_runtime`), so `!leg.is_empty()` is `active`.
      if (bit || active) failV16(V16_HIDDEN_LEG);
      continue;
    }
    if (bit !== active) failV16(V16_HIDDEN_LEG);
    if (!active) continue;
    const asset = toU64(leg.asset_index);
    if (asset >= configured || asset >= markets) failV16(V16_HIDDEN_LEG);
    const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
    checkV16(assetStateErr(a));
    const life = a.lifecycle;
    if (
      leg.market_id !== a.market_id ||
      !(life === LIFECYCLE_ACTIVE || life === LIFECYCLE_DRAIN_ONLY || life === LIFECYCLE_RECOVERY) ||
      !legBoundToAsset(a, leg)
    )
      failV16(V16_HIDDEN_LEG);
    for (let j = 0n; j < seenCount; j++) if (seen.get(j) === asset) failV16(V16_HIDDEN_LEG);
    seen.set(seenCount, asset);
    seenCount += 1n;
    const target = bTargetForLeg(a, leg);
    if (target > leg.b_snap) {
      markLegBStale(m, pa, asset);
      if (!allowB) failV16(V16_B_STALE);
      const chunk = settleAccountBChunk(m, markets, pa, asset, budget);
      if (chunk.remaining_after !== 0n) return REFRESH_B_CHUNK;
    }
    // `refreshed`: the leg as it stands now (a chunk advanced its B snapshot); the asset is the copy read above, which
    // the chunk does not change in any field read below.
    const r = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
    if (r.b_stale === 1n) {
      if (allowB) return REFRESH_B_CHUNK;
      failV16(V16_B_STALE);
    }
    if (!cleared && legIsPriorResetObligation(a, r)) {
      checkV16(closeProgressErr(p.close_progress));
      if (!closeHasPendingResidual(p.close_progress)) {
        clearLeg(m, markets, pa, asset);
        cleared = true;
        continue;
      }
    }
    const price = asset === ovAsset ? ovPrice : a.effective_price;
    const q = effectiveAbsQuantityForLeg(a, r);
    const notional = riskNotionalCeil(q, price);
    const penalty = targetLagPenalty(q, r.side === 1n, price, a.raw_oracle_target_price);
    const req = healthRequirements(m, notional, penalty);
    if (initial > U128_MAX_H - req.initial || maintenance > U128_MAX_H - req.maintenance || worst > U128_MAX_H - req.worst) failV16(V16_ARITHMETIC_OVERFLOW);
    initial += req.initial;
    maintenance += req.maintenance;
    worst += req.worst;
  }
  settleNegativePnlFromPrincipal(m, pa);
  collectBackingUtilizationFees(m, markets, pa);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(boolErr(p.b_stale_state));
  if (p.b_stale_state === 1n) failV16(V16_B_STALE);
  clearAccountStale(m, pa);
  writeCert(m, pa, accountHaircutEquity(m, markets, pa), initial, maintenance, worst);
  return REFRESH_CERTIFIED;
}

// ---- Lapsed source backing -----------------------------------------------------------------------------------------------

/** No lapsed bucket found. */
export const NO_LAPSED: u64 = 0xffffffffffffffffn;

/**
 * `first_lapsed_roster_source_backing_for_account_at_slot(account, now)`: the account's source roster in slot order up to
 * the sparse tail (`kernel_lapsed_source_backing_scan_step`), the first occupied domain whose bucket (decoded, its
 * effective expiry) is Fresh at or past its expiry.
 */
export function firstLapsedRoster(m: RemainingAccount, markets: u64, pa: RemainingAccount, now: u64): u64 {
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) return NO_LAPSED;
    if (!occupied) continue;
    const domain = toU64(s.domain);
    const expiry = bucketForDomain(m, markets, domain);
    if (loadRawAt<BackingBucket>(m, bucketAt(domain)).status === BUCKET_FRESH_H && expiry <= now) return domain;
  }
  return NO_LAPSED;
}

/**
 * `first_lapsed_latent_source_backing_for_account_at_slot(account, now)`: none while the market holds no Fresh backing;
 * else each active leg (its bit and its flag decoded) in slot order, the domain opposite its side (`insurance_domain_index`,
 * the side decoded), the bucket's raw status (decoded) and effective expiry: the first Fresh one at or past its expiry.
 * An inactive slot ends the scan with nothing (the scan step's `(None, false)` continues; only a selection stops it).
 */
export function firstLapsedLatent(m: RemainingAccount, markets: u64, pa: RemainingAccount, now: u64): u64 {
  if (loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).source_fresh_backing_total_num === 0n) return NO_LAPSED;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    if (((bitmap >> slot) & 1n) === 0n) continue;
    const leg = p.legs.get(slot);
    checkV16(boolErr(leg.active));
    if (leg.active !== 1n) continue;
    checkV16(sideErr(leg.side));
    const domain = insuranceDomainIndex(m, markets, toU64(leg.asset_index), leg.side === 0n);
    const se = bucketRawStatusExpiry(m, markets, domain);
    checkV16(backingBucketStatusErr(se.status));
    if (se.status === BUCKET_FRESH_H && se.expiry <= now) return domain;
  }
  return NO_LAPSED;
}

/** `first_lapsed_source_backing_for_account_at_slot(account, now)`: the roster's, else the latent domains'. */
export function firstLapsed(m: RemainingAccount, markets: u64, pa: RemainingAccount, now: u64): u64 {
  const d = firstLapsedRoster(m, markets, pa, now);
  if (d !== NO_LAPSED) return d;
  return firstLapsedLatent(m, markets, pa, now);
}

/** `expire_first_lapsed_source_backing_for_account_not_atomic(account)`: at the market's current slot. */
export function expireFirstLapsedSourceBacking(m: RemainingAccount, markets: u64, pa: RemainingAccount): u64 {
  const now = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot;
  const d = firstLapsed(m, markets, pa, now);
  if (d !== NO_LAPSED) expireSourceBackingBucket(m, markets, d, now);
  return d;
}

/**
 * `settle_account_for_position_action_and_refresh_not_atomic(account)`: the scalar preflight; a portfolio that is not
 * stale or B-stale (each decoded), whose certificate is current (its errors read as "not current": the original's
 * `.is_ok()`) and that holds no B-stale leg keeps its certificate; any other is refreshed and certified.
 */
export function settleForPositionAction(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  scalarPreflight(m, markets, pa);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  checkV16(boolErr(p.stale_state));
  if (p.stale_state === 0n) {
    checkV16(boolErr(p.b_stale_state));
    if (p.b_stale_state === 0n && certCurrentErr(m, pa) === 0n && !hasBStaleLeg(pa)) {
      // `account.header.health_cert.try_to_runtime()`: it decoded in the currentness check.
      return;
    }
  }
  refreshAccountAndCertify(m, markets, pa);
}
