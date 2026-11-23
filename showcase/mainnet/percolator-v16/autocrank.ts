// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The engine's permissionless crank (NOTES.md section 13): `permissionless_auto_crank_not_atomic` with its classifier
// (`build_actionable_summary_and_selected_assets`, `auto_crank_selected_assets` and their kernels), the plan
// (`select_auto_crank_plan`, `highest_risk_liquidatable_asset`), a released reset obligation's detachment (`clear_leg`
// with its Stale swallowed: NOTES.md section 1, site 3), and the dispatch (`permissionless_crank_not_atomic`: Refresh
// with the observation's accrual and the crank's refresh, SettleB, Liquidate (liquidation.ts), Recover), ReleaseSourceLiens
// (`release_account_source_credit_liens_if_unneeded_core_not_atomic`), AdvanceClose; and FinalizeResetSide's engine call
// (`finalize_side_reset_not_atomic`).
//
// A market in Recovery (the forfeit of a released obligation, or the market's resolution: recovery.ts) and a Resolved
// market's CloseResolved plan (resolved.ts) are dispatched here too; the committed-state refresh of a Recovery asset's
// leg (`refresh_recovery_account_from_committed_state_not_atomic`) is ported.
//
// Errors as values. The processor swallows the engine's NonProgress once it has accrued a market (NOTES.md section 1,
// site 2), keeping every write made before it, so the functions here and in liquidation.ts return NONPROG where the
// original returns NonProgress; every other error fails in place (the processor maps it and fails).
import { type FixedArray, type Inout, type RemainingAccount, type i128, type u8, type u64, type u128, loadRawAt, loadRawMutAt, u64 as toU64, u128 as toU128 } from "typesol";
import {
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_OVERFLOW,
  V16_HIDDEN_LEG,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_RECOVERY_REQUIRED,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type BackingBucket,
  type EngineAssetSlot,
  type GroupHeader,
  type InsuranceCreditReservation,
  type Portfolio,
  type SourceCreditState,
  HEADER_LEN,
  MARKET_GROUP_OFF,
} from "./state.js";
import { BOUND_SCALE, V16_MAX_PORTFOLIO_ASSETS_N, boolErr, closeProgressErr, healthCertErr, marketModeErr, optionalRecoveryReasonErr } from "./wire.js";
import {
  LIFECYCLE_ACTIVE,
  LIFECYCLE_DRAIN_ONLY,
  LIFECYCLE_RECOVERY,
  PORTFOLIO_SOURCE_DOMAIN_CAP,
  compactSourceDomains,
  engineSlotAt,
  legErr,
  marketShapeErr,
  validateWithMarket,
} from "./engine.js";
import { bTargetForLeg, legHasExhaustedEffectiveOi } from "./kernels.js";
import {
  bucketAt,
  bucketForDomain,
  closeHasPendingResidual,
  collectBackingUtilizationFee,
  domainAssetSide,
  domainHasDefaultTag,
  domainIsOccupied,
  expireSourceBackingBucket,
  hasPendingDomainLossBarrier,
  pendingDomainLossBarrierCount,
  releaseCounterpartyLienCore,
  releaseInsuranceLien,
  reservationAt,
  reservationForDomain,
  resetSourceDomainSlotIfEmpty,
  sourceAt,
  sourceForDomain,
  sourceDomainAt,
} from "./primitives.js";
import { impairAccountCounterpartyLienFields, retireCounterpartyImpairedLien } from "./impairment.js";
import { settleAccountBChunk, settleAccountSideEffects } from "./settlement.js";
import { accrueAssetToOrNonProgress } from "./accrual.js";
import { NO_LAPSED, NO_OVERRIDE, REFRESH_CERTIFIED, effectiveAbsQuantityForLeg, firstLapsed, firstLapsedLatent, firstLapsedRoster, recertifyAfterSourceLienChange, refreshAndCertify } from "./health.js";
import { assetSlot, beginZeroOiResidueResets, clearLegOrStale, noPositiveCreditEquity, positionChangeTouchesBarrier, setAssetState, signedPosition } from "./trade.js";
import { hasActiveSourceClaimExposure, hasSourceLiens } from "./convert.js";
import { DECLARED, DONE, NONPROG, advancePendingClose, certifyAfterLocalSettlement, commitDeclared, declareRecovery, liquidate, REASON_ACTIVE_BANKRUPT_CLOSE } from "./liquidation.js";
import { blockersAfter, blockersBefore } from "./engine.js";
import { forfeitRecoveryLeg, obligationReleaseAllowed, resolveMarket } from "./recovery.js";
import { type ResolvedClose, NONPROG_RS, crankCloseResolved, headerAggregateTotals, resolvedWinner } from "./resolved.js";

const U128_MAX_AC: u128 = 0xffffffffffffffffffffffffffffffffn;
const U64_MAX_AC: u64 = 0xffffffffffffffffn;
/** No asset (`None`). */
export const NONE: u64 = 0xffffffffffffffffn;
/** MarketModeV16. */
const MODE_LIVE_AC: u8 = 0n;
const MODE_RECOVERY_AC: u8 = 2n;
/** SideModeV16. */
const SIDE_NORMAL_AC: u8 = 0n;
const SIDE_DRAIN_ONLY_AC: u8 = 1n;
const SIDE_RESET_PENDING_AC: u8 = 2n;
/** BackingBucketStatusV16. */
const BUCKET_FRESH_AC: u8 = 1n;
const BUCKET_IMPAIRED_AC: u8 = 3n;
/** `PermissionlessRecoveryReasonV16::ExplicitLossOrDustAuditOverflow`. */
const REASON_EXPLICIT_LOSS_AC: u8 = 5n;

/** `AutoCrankPlanV16`. */
export const PLAN_NO_ACTION = 0n;
export const PLAN_RELEASE_SOURCE_LIENS = 1n;
export const PLAN_REFRESH = 2n;
export const PLAN_SETTLE_B = 3n;
export const PLAN_LIQUIDATE = 4n;
export const PLAN_ADVANCE_CLOSE = 5n;
export const PLAN_DECLARE_RECOVERY = 6n;
export const PLAN_FINALIZE_RECOVERY = 7n;
export const PLAN_CLOSE_RESOLVED = 8n;

/** What the processor reads of an `ActionableSummaryV16`. */
export interface Summary {
  stale: boolean;
  b_stale: boolean;
  pending_close: boolean;
  expired_close: boolean;
  liquidatable: boolean;
  releasable: boolean;
  resolved_winner: boolean;
}

/** `auto_crank_selected_assets`' result (NONE for None). */
export interface Selected {
  b_stale: u64;
  refresh: u64;
  liquidatable: u64;
  reset_obligation: u64;
  released: u64;
  mask: u64;
}

/** `AutoCrankResultV16` as the processor reads it: the plan, its asset (NONE for none), and whether the outcome is
 * `Progressed(AccountCurrent)`; `status` DONE, or NONPROG for a NonProgress the processor may swallow. */
export interface AutoCrank {
  plan: u64;
  asset: u64;
  current: boolean;
  status: u64;
  /** CloseResolved's outcome: Closed (with its payout) or ProgressOnly. */
  closed: boolean;
  payout: u128;
}

// ---- The classifier ---------------------------------------------------------------------------------------------------------

/**
 * `auto_crank_selected_assets(account)`: the close ledger decoded (a pending residual forbids releasing obligations);
 * each of the 16 legs decoded; for an active one (its bit and its flag) the asset decoded, the B target and
 * `kernel_b_settlement_pending` (RecoveryRequired for a target behind the snapshot), `kernel_auto_crank_leg_flags`
 * (B-stale, refresh for a dispatchable lifecycle, liquidatable with a basis and matched OI and not a prior-reset
 * obligation, the obligation), an exhausted effective OI as an obligation too, and the first released obligation (no
 * pending residual, the leg unstale, a zero basis with weight, no barrier on its side, its release allowed). The first
 * slot of each flag, as its leg's asset (decoded again); the refresh asset falls back to the first Recovery leg's; the
 * liquidatable slots as a mask.
 */
function selectedAssets(m: RemainingAccount, markets: u64, pa: RemainingAccount): Selected {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  checkV16(closeProgressErr(p.close_progress));
  const releaseAllowed = !closeHasPendingResidual(p.close_progress);
  let bStale = NONE;
  let refresh = NONE;
  let recoveryRefresh = NONE;
  let liq = NONE;
  let reset = NONE;
  let released = NONE;
  let mask: u64 = 0n;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (((bitmap >> slot) & 1n) === 0n || leg.active !== 1n) continue;
    const asset = toU64(leg.asset_index);
    const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
    const isShort = leg.side === 1n;
    const sideMode = isShort ? a.mode_short : a.mode_long;
    const sideEpoch = isShort ? a.epoch_short : a.epoch_long;
    const matched = a.oi_eff_long_q < a.oi_eff_short_q ? a.oi_eff_long_q : a.oi_eff_short_q;
    const target = bTargetForLeg(a, leg);
    if (target < leg.b_snap) failV16(V16_RECOVERY_REQUIRED);
    const bPending = leg.b_stale === 1n || target > leg.b_snap;
    const dispatchable = a.lifecycle === LIFECYCLE_ACTIVE || a.lifecycle === LIFECYCLE_DRAIN_ONLY;
    const prior = sideMode === SIDE_RESET_PENDING_AC && leg.epoch_snap !== U64_MAX_AC && leg.epoch_snap + 1n === sideEpoch;
    if (bPending && bStale === NONE) bStale = asset;
    if (dispatchable && refresh === NONE) refresh = asset;
    if (a.lifecycle === LIFECYCLE_RECOVERY && recoveryRefresh === NONE) recoveryRefresh = asset;
    if (dispatchable && leg.basis_pos_q !== 0n && matched !== 0n && !prior) {
      if (liq === NONE) liq = asset;
      mask |= 1n << slot;
    }
    if ((prior || legHasExhaustedEffectiveOi(a, leg)) && reset === NONE) reset = asset;
    if (
      releaseAllowed &&
      leg.stale === 0n &&
      leg.b_stale === 0n &&
      leg.basis_pos_q === 0n &&
      leg.loss_weight !== 0n &&
      !hasPendingDomainLossBarrier(m, markets, asset, isShort) &&
      obligationReleaseAllowed(m, markets, asset, isShort) &&
      released === NONE
    )
      released = asset;
  }
  // asset_of(first slot): the slot's leg decoded again (it passed); the first match's asset is the one recorded.
  return { b_stale: bStale, refresh: refresh !== NONE ? refresh : recoveryRefresh, liquidatable: liq, reset_obligation: reset, released, mask };
}

/**
 * `kernel_flat_source_lien_normalization(...)`: none without a liened claim and backing; ImpairCounterparty (2) when
 * the bucket is Impaired and its and the source's impaired liens cover the counterparty backing; Release (1) when the
 * counterparty part is releasable (a Fresh, unexpired bucket whose and whose source's valid liens cover it) and the
 * insurance part is (a whole number of atoms, covered by the reservation's and the source's valid insurance liens);
 * none (0) otherwise.
 */
function flatLienNormalization(m: RemainingAccount, markets: u64, liened: u128, counterparty: u128, insurance: u128, domain: u64, now: u64): u64 {
  if (liened === 0n || (counterparty === 0n && insurance === 0n)) return 0n;
  const expiry = bucketForDomain(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  const s = loadRawAt<SourceCreditState>(m, sourceAt(domain));
  const r = loadRawAt<InsuranceCreditReservation>(m, reservationAt(domain));
  if (counterparty !== 0n && b.status === BUCKET_IMPAIRED_AC && b.impaired_liened_backing_num >= counterparty && s.impaired_liened_backing_num >= counterparty) return 2n;
  const cpOk = counterparty === 0n || (b.status === BUCKET_FRESH_AC && expiry > now && b.valid_liened_backing_num >= counterparty && s.valid_liened_backing_num >= counterparty);
  const insOk =
    insurance === 0n || (insurance % BOUND_SCALE === 0n && r.valid_liened_insurance_num >= insurance && s.valid_liened_insurance_num >= insurance);
  return cpOk && insOk ? 1n : 0n;
}

/** The source state, bucket and reservation of a domain read as the normalization reads them (each decoded, in the
 * original's order: `source_credit_for_domain`, `backing_bucket_for_domain`, `insurance_reservation_for_domain`). */
function readDomainParts(m: RemainingAccount, markets: u64, domain: u64): void {
  sourceForDomain(m, markets, domain);
  bucketForDomain(m, markets, domain);
  reservationForDomain(m, markets, domain);
}

/** `account_has_normalizable_source_credit_lien(account, now)`: a liened claim before the compacted tail whose
 * normalization is not none (the domain configured; its parts decoded). */
function hasNormalizableLien(m: RemainingAccount, markets: u64, pa: RemainingAccount, now: u64): boolean {
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP; slot++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) break;
    if (!occupied || s.source_claim_liened_num === 0n) continue;
    const d = toU64(s.domain);
    domainAssetSide(m, markets, d);
    readDomainParts(m, markets, d);
    if (flatLienNormalization(m, markets, s.source_claim_liened_num, s.source_lien_counterparty_backing_num, s.source_lien_insurance_backing_num, d, now) !== 0n)
      return true;
  }
  return false;
}

/**
 * `build_actionable_summary_and_selected_assets(account, now)` (a market in Recovery never reaches it): InvalidConfig for a slot behind the market's; the mode decoded; the
 * certificate decoded and its currentness; the ledger decoded; the selected assets; the lapsed roster and latent
 * backing; the flags (`kernel_live_account_refresh_required`, B-stale, pending and expired close, the liquidation's,
 * the flat account's source-lien release with its margin safety), each false unless Live; the Resolved winner (resolved.ts
 * `resolvedWinner`, whose decodes run on every market).
 */
export function buildSummary(m: RemainingAccount, markets: u64, pa: RemainingAccount, now: u64, out: Inout<Summary>, sel: Inout<Selected>): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (now < h.current_slot) failV16(V16_INVALID_CONFIG);
  checkV16(marketModeErr(h.mode));
  const live = h.mode === MODE_LIVE_AC;
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const c = p.health_cert;
  checkV16(healthCertErr(c));
  const current =
    c.valid === 1n &&
    c.cert_oracle_epoch === h.oracle_epoch &&
    c.cert_funding_epoch === h.funding_epoch &&
    c.cert_risk_epoch === h.risk_epoch &&
    c.cert_asset_set_epoch === h.asset_set_epoch &&
    c.active_bitmap_at_cert.get(0n) === p.active_bitmap.get(0n);
  checkV16(closeProgressErr(p.close_progress));
  const s = selectedAssets(m, markets, pa);
  sel.b_stale = s.b_stale;
  sel.refresh = s.refresh;
  sel.liquidatable = s.liquidatable;
  sel.reset_obligation = s.reset_obligation;
  sel.released = s.released;
  sel.mask = s.mask;
  const lapsedRoster = firstLapsedRoster(m, markets, pa, now) !== NO_LAPSED;
  const lapsed = lapsedRoster || firstLapsedLatent(m, markets, pa, now) !== NO_LAPSED;
  const pending = closeHasPendingResidual(p.close_progress);
  out.stale = live && (!current || s.reset_obligation !== NONE || s.released !== NONE || lapsed);
  out.b_stale = live && s.b_stale !== NONE;
  out.pending_close = live && pending;
  out.expired_close = live && pending && now > p.close_progress.max_close_slot;
  out.liquidatable = live && current && c.certified_liq_deficit !== 0n && s.liquidatable !== NONE && s.reset_obligation === NONE && !lapsedRoster;
  const noPositive = noPositiveCreditEquity(pa);
  const flat = p.active_bitmap.get(0n) === 0n;
  const safe = noPositive >= 0n && toU128(noPositive) >= c.certified_initial_req;
  const normalizable = live && current && !lapsed && flat && safe ? hasNormalizableLien(m, markets, pa, now) : false;
  out.releasable = live && current && !lapsed && flat && safe && normalizable;
  out.resolved_winner = resolvedWinner(m, pa, lapsed);
}

/** `highest_risk_liquidatable_asset(account, mask)`: none for fewer than two candidates; else among the masked legs
 * (decoded, their assets decoded) that the unilateral capacity lets reduce, whose position is not zero and whose step
 * toward zero touches no barrier, the largest effective notional (saturating; the first on a tie). */
function highestRiskLiquidatable(m: RemainingAccount, markets: u64, pa: RemainingAccount, mask: u64): u64 {
  let bits = mask;
  let count: u64 = 0n;
  while (bits !== 0n) {
    bits &= bits - 1n;
    count += 1n;
  }
  if (count < 2n) return NONE;
  let best = NONE;
  let bestRisk: u128 = 0n;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    if ((mask & (1n << slot)) === 0n) continue;
    const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
    checkV16(legErr(leg));
    const asset = toU64(leg.asset_index);
    const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
    const q = effectiveAbsQuantityForLeg(a, leg);
    let cap = q;
    if (a.oi_eff_long_q < cap) cap = a.oi_eff_long_q;
    if (a.oi_eff_short_q < cap) cap = a.oi_eff_short_q;
    const current = signedPosition(leg);
    if (cap === 0n || current === 0n) continue;
    const toward = current > 0n ? current - 1n : current + 1n;
    if (positionChangeTouchesBarrier(m, markets, asset, current, toward)) continue;
    const price = toU128(a.effective_price);
    const risk = price !== 0n && q > U128_MAX_AC / price ? U128_MAX_AC : q * price;
    if (best === NONE || risk > bestRisk) {
      best = asset;
      bestRisk = risk;
    }
  }
  return best;
}

// ---- ReleaseSourceLiens -------------------------------------------------------------------------------------------------------

/**
 * `release_account_source_credit_liens_if_unneeded_core_not_atomic(account)`: LockActive unless Live; NonProgress for an
 * account with a leg, without liens, or with active source-claim exposure; the side effects settled (public B chunk); the
 * account certified after local settlement; LockActive below the initial margin without positive credit; then the first
 * liened domain (before the compacted tail) whose normalization is not none: ImpairCounterparty (the domain's utilization
 * fee collected, the impaired lien retired, the account's lien impaired) or Release (the counterparty and insurance liens
 * released, the slot's lien fields zeroed, the slot reset if empty); NonProgress for none; the domains compacted, the
 * certificate invalidated and recertified after the lien change, the account validated with the market, the market's
 * shape. One domain per call (`V16_SOURCE_LIEN_RELEASE_CHUNK_DOMAINS`).
 */
function releaseSourceLiens(m: RemainingAccount, markets: u64, pa: RemainingAccount): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_LIVE_AC) failV16(V16_LOCK_ACTIVE);
  if (loadRawAt<Portfolio>(pa, HEADER_LEN).active_bitmap.get(0n) !== 0n || !hasSourceLiens(pa) || hasActiveSourceClaimExposure(m, markets, pa)) return NONPROG;
  settleAccountSideEffects(m, markets, pa, h.config.public_b_chunk_atoms);
  certifyAfterLocalSettlement(m, markets, pa);
  const noPositive = noPositiveCreditEquity(pa);
  const cert = loadRawAt<Portfolio>(pa, HEADER_LEN).health_cert;
  checkV16(healthCertErr(cert));
  if (noPositive < 0n || toU128(noPositive) < cert.certified_initial_req) failV16(V16_LOCK_ACTIVE);
  let released = false;
  for (let slot = 0n; slot < PORTFOLIO_SOURCE_DOMAIN_CAP && !released; slot++) {
    const s = loadRawAt<Portfolio>(pa, HEADER_LEN).source_domains.get(slot);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) break;
    if (!occupied || s.source_claim_liened_num === 0n) continue;
    const d = toU64(s.domain);
    domainAssetSide(m, markets, d);
    const counterparty = s.source_lien_counterparty_backing_num;
    const insurance = s.source_lien_insurance_backing_num;
    // backing_bucket_for_domain, source_credit_for_domain, insurance_reservation_for_domain, in this order here.
    bucketForDomain(m, markets, d);
    sourceForDomain(m, markets, d);
    reservationForDomain(m, markets, d);
    const kind = flatLienNormalization(m, markets, s.source_claim_liened_num, counterparty, insurance, d, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot);
    if (kind === 0n) continue;
    if (kind === 2n) {
      collectBackingUtilizationFee(m, markets, pa, d);
      retireCounterpartyImpairedLien(m, markets, d, counterparty);
      impairAccountCounterpartyLienFields(pa, d);
      released = true;
      continue;
    }
    if (counterparty !== 0n) releaseCounterpartyLienCore(m, markets, d, counterparty);
    if (insurance !== 0n) releaseInsuranceLien(m, markets, d, insurance);
    const pv = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
    const w = pv.source_domains.get(slot);
    w.source_claim_liened_num = 0n;
    w.source_claim_counterparty_liened_num = 0n;
    w.source_claim_insurance_liened_num = 0n;
    w.source_lien_effective_reserved = 0n;
    w.source_lien_counterparty_backing_num = 0n;
    w.source_lien_insurance_backing_num = 0n;
    w.source_lien_fee_last_slot = 0n;
    resetSourceDomainSlotIfEmpty(pa, slot);
    released = true;
  }
  if (!released) return NONPROG;
  compactDomains(pa);
  const pc = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  pc.health_cert.valid = 0n;
  recertifyAfterSourceLienChange(m, markets, pa);
  validateWithMarket(m, pa, markets);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  return DONE;
}

// ---- The engine's crank -----------------------------------------------------------------------------------------------------

/** One observation (`AutoCrankObservationV16`): the asset, its effective price, its funding rate. */
export interface Observation {
  asset: u64;
  price: u64;
  rate: i128;
}

/** The dispatch's observation for an asset: the supplied one, else the asset's effective price and no funding. */
function observationFor(m: RemainingAccount, markets: u64, obs: FixedArray<Observation, 16>, count: u64, asset: u64): Observation {
  for (let i = 0n; i < count; i++) {
    const o = obs.get(i);
    if (o.asset === asset) return { asset, price: o.price, rate: o.rate };
  }
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  return { asset, price: a.effective_price, rate: 0n };
}

/** `validate_unconfigured_market_tail`: the view's slot count is the capacity, which covers the configured slots. */
function validateMarketTail(m: RemainingAccount, markets: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (markets !== toU64(h.asset_slot_capacity) || toU64(h.asset_slot_capacity) < toU64(h.config.max_market_slots)) failV16(V16_INVALID_CONFIG);
}

/** `permissionless_crank_not_atomic`'s common start: the tail, then LockActive unless Live (Recover excepted). */
function crankStart(m: RemainingAccount, markets: u64, recover: boolean): void {
  validateMarketTail(m, markets);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_LIVE_AC && !recover) failV16(V16_LOCK_ACTIVE);
}

/**
 * `permissionless_crank_not_atomic` with Refresh: whether the account holds the asset's leg (the asset below the
 * configured count), the asset accrued to the slot at the observation (that leg's presence is the committed progress a
 * move needs: NonProgress otherwise), the crank's refresh with the observation as the asset's price override and a B
 * chunk allowed (it stops at a chunk or an expiry). Returns NONPROG, DONE with `current` (AccountCurrent) or not.
 */
function crankRefresh(m: RemainingAccount, markets: u64, pa: RemainingAccount, now: u64, o: Observation, r: Inout<AutoCrank>): void {
  crankStart(m, markets, false);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const before = o.asset < toU64(h.config.max_market_slots) && legSlotOf(pa, o.asset) !== NONE;
  if (accrueAssetToOrNonProgress(m, markets, o.asset, now, o.price, o.rate, before)) {
    r.status = NONPROG;
    return;
  }
  const outcome = refreshAndCertify(m, markets, pa, o.asset, o.price, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.public_b_chunk_atoms, true);
  r.status = DONE;
  if (outcome !== REFRESH_CERTIFIED) return;
  // kernel_refresh_detached_selected_leg: the leg's presence after (the asset below the configured count) is read
  // either way; both arms return AccountCurrent.
  if (o.asset < toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots)) legSlotOf(pa, o.asset);
  r.current = true;
}

/**
 * `refresh_recovery_account_from_committed_state_not_atomic(account, asset, now)` (a Recovery asset's leg, refreshed
 * from committed state with no accrual): the tail; NonProgress for a slot behind the market's, an asset not in
 * Recovery (decoded) or no leg of it; the first lapsed backing of the account at the slot expired (the account
 * validated with the market; SourceBackingExpired); else the crank's refresh with no price override and a B chunk
 * allowed, the account validated with the market. Returns DONE with AccountCurrent (REFRESH_CERTIFIED) or another
 * outcome (`current` false: DONE + 10), or NONPROG.
 */
function refreshRecoveryAccount(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, now: u64): u64 {
  validateMarketTail(m, markets);
  if (now < loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot) return NONPROG;
  if (loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset.lifecycle !== LIFECYCLE_RECOVERY) return NONPROG;
  if (legSlotOf(pa, asset) === NONE) return NONPROG;
  const d = firstLapsed(m, markets, pa, now);
  if (d !== NO_LAPSED) {
    expireSourceBackingBucket(m, markets, d, now);
    validateWithMarket(m, pa, markets);
    return RECOVERY_REFRESH_OTHER;
  }
  const outcome = refreshAndCertify(m, markets, pa, NO_OVERRIDE, 0n, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.public_b_chunk_atoms, true);
  validateWithMarket(m, pa, markets);
  return outcome === REFRESH_CERTIFIED ? DONE : RECOVERY_REFRESH_OTHER;
}

/** A Recovery refresh that stopped at a B chunk or an expiry (not AccountCurrent). */
const RECOVERY_REFRESH_OTHER = 10n;

/** `Self::active_leg_slot_for_asset(account, asset)` (HiddenLeg for a bit without an active leg or two legs of the
 * asset): the slot or NONE. */
function legSlotOf(pa: RemainingAccount, asset: u64): u64 {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  let found = NONE;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    if (((bitmap >> slot) & 1n) === 0n) continue;
    const l = p.legs.get(slot);
    checkV16(legErr(l));
    if (l.active !== 1n) failV16(V16_HIDDEN_LEG);
    if (toU64(l.asset_index) === asset) {
      if (found !== NONE) failV16(V16_HIDDEN_LEG);
      found = slot;
    }
  }
  return found;
}


/**
 * `permissionless_auto_crank_not_atomic(account, { now, observations, resolved_close_fee_rate })`: on a market in Recovery
 * the forfeit of the first released obligation or the market's resolution; otherwise the summary and the selected
 * assets; the recovery reason (ActiveBankruptCloseCannotProgress for an expired close, else
 * ExplicitLossOrDustAuditOverflow); `select_auto_crank_plan` (DeclareRecovery for an expired close, AdvanceClose for a
 * pending one, SettleB, Liquidate (the riskiest liquidatable leg's asset among several), ReleaseSourceLiens, Refresh
 * (the refresh asset, else the reset obligation's), NoAction); a Refresh with a released obligation first detaches it
 * (`clear_leg`, its Stale swallowed: the dispatch continues; a Recovery asset's obligation is forfeited) and begins the
 * residue resets; then the dispatch. `r` receives the plan, its asset and the outcome.
 */
export function autoCrank(
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  now: u64,
  obs: FixedArray<Observation, 16>,
  count: u64,
  feeRate: u128,
  r: Inout<AutoCrank>,
): void {
  r.plan = PLAN_NO_ACTION;
  r.asset = NONE;
  r.current = false;
  r.status = DONE;
  r.closed = false;
  r.payout = 0n;
  const h0 = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h0.mode));
  // A market in Recovery: the forfeit of the first released obligation (its asset's tail checked; no residue resets
  // here), else the market resolved at the slot; the account validated with the market either way.
  if (h0.mode === MODE_RECOVERY_AC) {
    validateWithMarket(m, pa, markets);
    const released = selectedAssets(m, markets, pa).released;
    if (released !== NONE) {
      validateMarketTail(m, markets);
      forfeitRecoveryLeg(m, markets, pa, released, h0.config.public_b_chunk_atoms);
      validateWithMarket(m, pa, markets);
      r.plan = PLAN_REFRESH;
      r.asset = released;
      r.current = true;
      return;
    }
    resolveMarket(m, markets, now);
    validateWithMarket(m, pa, markets);
    r.plan = PLAN_FINALIZE_RECOVERY;
    return;
  }
  const s: Summary = { stale: false, b_stale: false, pending_close: false, expired_close: false, liquidatable: false, releasable: false, resolved_winner: false };
  const sel: Selected = { b_stale: NONE, refresh: NONE, liquidatable: NONE, reset_obligation: NONE, released: NONE, mask: 0n };
  buildSummary(m, markets, pa, now, s, sel);
  const reason: u8 = s.expired_close ? REASON_ACTIVE_BANKRUPT_CLOSE : REASON_EXPLICIT_LOSS_AC;
  let plan = PLAN_NO_ACTION;
  let asset = NONE;
  if (s.expired_close) plan = PLAN_DECLARE_RECOVERY;
  else if (s.resolved_winner) plan = PLAN_CLOSE_RESOLVED;
  else if (s.pending_close) plan = PLAN_ADVANCE_CLOSE;
  else if (s.b_stale) {
    plan = PLAN_SETTLE_B;
    asset = sel.b_stale;
  } else if (s.liquidatable) {
    plan = PLAN_LIQUIDATE;
    const riskiest = highestRiskLiquidatable(m, markets, pa, sel.mask);
    asset = riskiest !== NONE ? riskiest : sel.liquidatable;
  } else if (s.releasable) plan = PLAN_RELEASE_SOURCE_LIENS;
  else if (s.stale) {
    plan = PLAN_REFRESH;
    asset = sel.refresh !== NONE ? sel.refresh : sel.reset_obligation;
  }
  r.plan = plan;
  r.asset = asset;
  if (plan === PLAN_REFRESH && sel.released !== NONE) {
    const ob = sel.released;
    validateMarketTail(m, markets);
    const life = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, ob)).asset.lifecycle;
    // A Recovery asset's obligation is forfeited (any K/F/B delta settled first); another's is cleared, its Stale
    // swallowed (the ordinary refresh below settles it).
    let advanced = true;
    if (life === LIFECYCLE_RECOVERY) forfeitRecoveryLeg(m, markets, pa, ob, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.public_b_chunk_atoms);
    else advanced = clearLegOrStale(m, markets, pa, ob);
    if (advanced) {
      beginZeroOiResidueResets(m, markets, ob);
      validateWithMarket(m, pa, markets);
      r.asset = ob;
      r.current = true;
      return;
    }
  }
  if (plan === PLAN_NO_ACTION) return;
  if (plan === PLAN_CLOSE_RESOLVED) {
    const hint = count === 0n ? NONE : obs.get(0n).asset;
    const out: ResolvedClose = { closed: false, payout: 0n };
    r.status = crankCloseResolved(m, markets, pa, now, hint, feeRate, out) === NONPROG_RS ? NONPROG : DONE;
    r.closed = out.closed;
    r.payout = out.payout;
    return;
  }
  if (plan === PLAN_RELEASE_SOURCE_LIENS) {
    r.status = releaseSourceLiens(m, markets, pa);
    r.current = true;
    return;
  }
  if (plan === PLAN_REFRESH) {
    const o: Observation = { asset: 0n, price: 0n, rate: 0n };
    if (asset !== NONE) {
      if (loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset.lifecycle === LIFECYCLE_RECOVERY) {
        const st = refreshRecoveryAccount(m, markets, pa, asset, now);
        r.current = st === DONE;
        r.status = st === NONPROG ? NONPROG : DONE;
        return;
      }
      const f = observationFor(m, markets, obs, count, asset);
      o.asset = f.asset;
      o.price = f.price;
      o.rate = f.rate;
    } else {
      if (count === 0n) {
        r.status = NONPROG;
        return;
      }
      const f = obs.get(0n);
      o.asset = f.asset;
      o.price = f.price;
      o.rate = f.rate;
    }
    crankRefresh(m, markets, pa, now, o, r);
    return;
  }
  if (plan === PLAN_SETTLE_B) {
    observationFor(m, markets, obs, count, asset);
    crankStart(m, markets, false);
    settleAccountBChunk(m, markets, pa, asset, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.public_b_chunk_atoms);
    return;
  }
  if (plan === PLAN_LIQUIDATE) {
    const o = observationFor(m, markets, obs, count, asset);
    crankStart(m, markets, false);
    const st = liquidate(m, markets, pa, asset);
    if (st === NONPROG) {
      // kernel_commit_declared_liquidation_recovery decodes the mode and the reason before it returns the error.
      commitDecodes(m);
      r.status = NONPROG;
      return;
    }
    if (st === DECLARED) {
      commitDeclared(m);
      return;
    }
    // The trailing accrual at the observation, the liquidated asset's progress committed.
    if (accrueAssetToOrNonProgress(m, markets, asset, now, o.price, o.rate, true)) {
      r.status = NONPROG;
      return;
    }
    r.current = true;
    return;
  }
  if (plan === PLAN_ADVANCE_CLOSE) {
    const st = advancePendingClose(m, markets, pa);
    if (st === NONPROG) {
      commitDecodes(m);
      r.status = NONPROG;
      return;
    }
    if (st === DECLARED) {
      commitDeclared(m);
      return;
    }
    return;
  }
  // PLAN_DECLARE_RECOVERY.
  crankStart(m, markets, true);
  declareRecovery(m, markets, reason);
}

/** `PortfolioV16ViewMut::compact_source_domains`. */
function compactDomains(pa: RemainingAccount): void {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  compactSourceDomains(p.source_domains);
}

/** The decodes `kernel_commit_declared_liquidation_recovery` makes before it returns another error unchanged. */
function commitDecodes(m: RemainingAccount): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  checkV16(optionalRecoveryReasonErr(h.recovery_reason));
}

// ---- FinalizeResetSide --------------------------------------------------------------------------------------------------------

/**
 * `finalize_side_reset_not_atomic(asset, side)`: the asset configured (InvalidLeg); the side's pending barrier count
 * (`pending_domain_loss_barrier_count`); the asset decoded; a Normal side is a success with nothing written, a DrainOnly
 * one LockActive; a ResetPending side with stored legs, stale accounts, pending obligations or a barrier is Stale;
 * otherwise its K, F and B epoch starts zeroed and the side Normal (`set_asset_state`), the market's risk epoch raised
 * (CounterOverflow), the header's aggregate totals validated.
 */
export function finalizeSideReset(m: RemainingAccount, markets: u64, asset: u64, isShort: boolean): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  const barrier = pendingDomainLossBarrierCount(m, markets, asset, isShort);
  const at = assetSlot(m, markets, asset);
  const a = loadRawAt<EngineAssetSlot>(m, at).asset;
  const mode = isShort ? a.mode_short : a.mode_long;
  if (mode === SIDE_NORMAL_AC) return;
  if (mode === SIDE_DRAIN_ONLY_AC) failV16(V16_LOCK_ACTIVE);
  if (isShort) {
    if (a.stored_pos_count_short !== 0n || a.stale_account_count_short !== 0n || a.pending_obligation_count_short !== 0n || barrier !== 0n) failV16(V16_STALE);
  } else if (a.stored_pos_count_long !== 0n || a.stale_account_count_long !== 0n || a.pending_obligation_count_long !== 0n || barrier !== 0n) failV16(V16_STALE);
  const before = blockersBefore(m, asset);
  const e = loadRawMutAt<EngineAssetSlot>(m, at);
  if (isShort) {
    e.asset.k_epoch_start_short = 0n;
    e.asset.f_epoch_start_short_num = 0n;
    e.asset.b_epoch_start_short_num = 0n;
    e.asset.mode_short = SIDE_NORMAL_AC;
  } else {
    e.asset.k_epoch_start_long = 0n;
    e.asset.f_epoch_start_long_num = 0n;
    e.asset.b_epoch_start_long_num = 0n;
    e.asset.mode_long = SIDE_NORMAL_AC;
  }
  blockersAfter(m, asset, before);
  const hm = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (hm.risk_epoch === U64_MAX_AC) failV16(V16_COUNTER_OVERFLOW);
  hm.risk_epoch += 1n;
  headerAggregateTotals(m);
}
