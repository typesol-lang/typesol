// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// A dead leg's forfeit and the market's resolution (NOTES.md section 13): `forfeit_recovery_leg_not_atomic` with its
// helpers (`leg_is_dead_for_forfeit`, `settle_forfeited_leg_kf_effects`, `forfeit_loss_backing_capacity_atoms`,
// `retain_recovery_loss_weight_before_detach`, `retain_leg_as_pending_obligation`, `remaining_effective_oi_for_leg`,
// `clear_forfeited_leg`, `kernel_forfeit_residual_step`, `settle_negative_pnl_from_principal_not_atomic`), and
// `resolve_market_not_atomic`.
//
// Errors. Every caller of these functions propagates their error (the crank's Recovery branch, the Refresh of a
// released obligation on a Recovery asset), and the processor maps it and fails, so the port fails in place. Where a
// lower function declares Recovery and returns RecoveryRequired (the close ledger's expiry guard, a residual no step can
// book), the forfeit fails with RecoveryRequired too: the declaration is discarded with the transaction, as in the
// original. The one declaration that is a success is the forfeit's own CommitRecovery step.
//
// Copies. `settle_forfeited_leg_kf_effects` reads the leg at its start and writes it back at its end, and the asset
// through `kernel_settle_kf_stale_cohort` and `set_asset_state`; nothing in between writes either (the PnL paths never
// write a leg or an asset), so the port changes both in place. `retain_leg_as_pending_obligation` changes a copy of the
// leg and the asset read just before and writes both back after the kernel's checks: in place after the same checks.
import { type RemainingAccount, type i128, type u64, type u128, loadRawAt, loadRawMutAt, i128 as toI128, u64 as toU64 } from "typesol";
import { V16_ARITHMETIC_OVERFLOW, V16_INVALID_CONFIG, V16_INVALID_LEG, V16_LOCK_ACTIVE, V16_RECOVERY_REQUIRED, V16_STALE, checkV16, failV16 } from "./errors.js";
import { type AssetState, type EngineAssetSlot, type GroupHeader, type PortfolioLeg, type Portfolio, type SourceCreditState, HEADER_LEN, MARKET_GROUP_OFF } from "./state.js";
import { BOUND_SCALE, closeProgressErr, marketModeErr } from "./wire.js";
import { LIFECYCLE_RECOVERY, legErr, marketShapeErr, slotBlockers, validateWithMarket } from "./engine.js";
import { assetIsLossStaleAt, bTargetForLeg, fSnapResidualIsSubAtom, kfTargetForLeg, legHasExhaustedEffectiveOi, legKfDeltaComponents, settleKfStaleCohort } from "./kernels.js";
import {
  NO_SLOT,
  activeLegForAsset,
  activeLegSlotForAssetBitmap,
  closeHasPendingResidual,
  hasPendingDomainLossBarrier,
  insuranceDomainIndex,
  requireActiveLegSlotForAsset,
  sourceAt,
  sourceForDomain,
} from "./primitives.js";
import { NO_DOMAIN, availableBacking, setAccountPnl } from "./claims.js";
import { applyHaircutBoundedCloseLoss, beginFullDrainResetInner, recordAccountFundingFlow, reserveNewCapitalBackedLoss } from "./kfsettle.js";
import { absH, effectiveAbsQuantityForLeg, legIsPriorResetObligation } from "./health.js";
import { assetSlot, beginCloseProgressLedger, beginZeroOiResidueResets, clearLegAtSlotInner, retainLegAsPendingObligation, setAssetState } from "./trade.js";
import { markLegBStale, settleAccountBChunk } from "./settlement.js";
import { settleNegativePnlFromPrincipal } from "./refresh.js";
import { DECLARED, REASON_ACTIVE_BANKRUPT_CLOSE, advanceCloseLedgerFull, bankruptcyCapacity, bookResidualForAccount, consumeDomainInsurance, declareRecovery } from "./liquidation.js";

const U128_MAX_RC: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MAX_RC: u128 = 0x7fffffffffffffffffffffffffffffffn;
/** MarketModeV16: Resolved 1, Recovery 2. */
const MODE_RECOVERY_RC = 2n;
/** SideModeV16: DrainOnly 1, ResetPending 2. */
const SIDE_DRAIN_ONLY_RC = 1n;
const SIDE_RESET_PENDING_RC = 2n;

/** `recovery_pending_obligation_release_allowed(asset, side)`: the asset decoded; InvalidConfig when the other side's
 * pending obligations exceed its stored legs; outside Recovery always, in Recovery only when they are equal. */
export function obligationReleaseAllowed(m: RemainingAccount, markets: u64, asset: u64, isShort: boolean): boolean {
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const stored = isShort ? a.stored_pos_count_long : a.stored_pos_count_short;
  const pending = isShort ? a.pending_obligation_count_long : a.pending_obligation_count_short;
  if (pending > stored) failV16(V16_INVALID_CONFIG);
  return a.lifecycle !== LIFECYCLE_RECOVERY || stored === pending;
}

/** The leg at `slot` (`try_to_runtime` passed in the scan that found it). */
function legAt(pa: RemainingAccount, slot: u64): PortfolioLeg {
  return loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
}

/** `leg_kf_epoch_is_current(asset, leg)`. */
function kfEpochCurrent(a: AssetState, leg: PortfolioLeg): boolean {
  return leg.kf_epoch_snap === (leg.side === 1n ? a.kf_epoch_short : a.kf_epoch_long);
}

/** `leg_f_snap_is_settled(leg, f_target)`. */
function fSnapSettled(leg: PortfolioLeg, target: i128): boolean {
  return fSnapResidualIsSubAtom(absH(leg.basis_pos_q), leg.a_basis, leg.f_snap, target);
}

/** `b_target_for_leg(asset, leg)` for an asset already known configured and in the view: decoded again, the target. */
function bTargetOf(m: RemainingAccount, markets: u64, asset: u64, leg: PortfolioLeg): u128 {
  return bTargetForLeg(loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset, leg);
}

/**
 * `leg_is_dead_for_forfeit(asset, leg)`: the asset decoded (twice: `side_mode_for`, `asset_state`); dead in a market or
 * an asset in Recovery, or on a ResetPending side; on a DrainOnly side only when the leg's effective quantity is zero;
 * alive otherwise.
 */
function legIsDeadForForfeit(m: RemainingAccount, markets: u64, asset: u64, leg: PortfolioLeg): boolean {
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const sideMode = leg.side === 1n ? a.mode_short : a.mode_long;
  assetSlot(m, markets, asset);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode === MODE_RECOVERY_RC || a.lifecycle === LIFECYCLE_RECOVERY) return true;
  if (sideMode === SIDE_RESET_PENDING_RC) return true;
  if (sideMode !== SIDE_DRAIN_ONLY_RC) return false;
  return effectiveAbsQuantityForLeg(a, leg) === 0n;
}

/** `remaining_effective_oi_for_leg(asset, leg)`: the leg's effective quantity, at most its side's effective OI. */
function remainingEffectiveOi(a: AssetState, leg: PortfolioLeg): u128 {
  const side = leg.side === 1n ? a.oi_eff_short_q : a.oi_eff_long_q;
  const q = effectiveAbsQuantityForLeg(a, leg);
  return q < side ? q : side;
}

/** `retain_recovery_loss_weight_before_detach(asset, leg)`: false for a prior-reset obligation (the asset decoded);
 * else a pending barrier on the leg's side, or the release of its obligation not allowed. */
function retainLossWeight(m: RemainingAccount, markets: u64, asset: u64, leg: PortfolioLeg): boolean {
  if (legIsPriorResetObligation(loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset, leg)) return false;
  const short = leg.side === 1n;
  return hasPendingDomainLossBarrier(m, markets, asset, short) || !obligationReleaseAllowed(m, markets, asset, short);
}

/**
 * `retain_leg_as_pending_obligation(account, asset)`: the asset's active leg (InvalidLeg for none), decoded; the asset
 * decoded; InvalidLeg for a prior-reset obligation; Stale for a B-stale or stale leg, or one whose K/F epoch, K, F or B
 * is not current (the asset configured, decoded); the F snapshot set to its target (the sub-atom remainder dropped);
 * `kernel_retain_leg_as_pending_obligation` with the leg's remaining effective OI; the leg written, the certificate
 * invalidated, the asset written (`set_asset_state`).
 */
function retainAsPendingObligation(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64): void {
  const slot = requireActiveLegSlotForAsset(pa, asset);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const leg = p.legs.get(slot);
  checkV16(legErr(leg));
  const at = assetSlot(m, markets, asset);
  const e = loadRawMutAt<EngineAssetSlot>(m, at);
  if (legIsPriorResetObligation(e.asset, leg)) failV16(V16_INVALID_LEG);
  if (leg.b_stale === 1n || leg.stale === 1n) failV16(V16_STALE);
  // kf_target_for_leg(asset, leg): the index configured (it is), the asset decoded again, the target.
  assetSlot(m, markets, asset);
  const t = kfTargetForLeg(e.asset, leg);
  if (!kfEpochCurrent(e.asset, leg) || t.k !== leg.k_snap || !fSnapSettled(leg, t.f) || bTargetOf(m, markets, asset, leg) !== leg.b_snap) failV16(V16_STALE);
  leg.f_snap = t.f;
  const retained = remainingEffectiveOi(e.asset, leg);
  const before = slotBlockers(e);
  retainLegAsPendingObligation(e.asset, leg, retained);
  p.health_cert.valid = 0n;
  setAssetState(m, asset, before);
}

/** `clear_forfeited_leg(account, asset)`: the asset's active leg (InvalidLeg for none), decoded; cleared of the effective
 * OI it still owns on its side (`clear_leg_at_slot_inner` with that amount). */
function clearForfeitedLeg(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64): void {
  const slot = requireActiveLegSlotForAsset(pa, asset);
  const leg = legAt(pa, slot);
  checkV16(legErr(leg));
  const q = remainingEffectiveOi(loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset, leg);
  clearLegAtSlotInner(m, markets, pa, asset, slot, false, true, q, false);
}

/** The detachment both exits of the forfeit end in: the loss weight retained as a pending obligation, or the leg
 * cleared and the asset's residue resets begun. Returns whether the leg was detached. */
function detach(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, leg: PortfolioLeg): boolean {
  if (retainLossWeight(m, markets, asset, leg)) {
    retainAsPendingObligation(m, markets, pa, asset);
    return false;
  }
  clearForfeitedLeg(m, markets, pa, asset);
  beginZeroOiResidueResets(m, markets, asset);
  return true;
}

/** `forfeit_loss_backing_capacity_atoms(domain)`: the domain's source state (checked), its claim bound beyond its
 * available backing (saturating) plus the provider receivable (ArithmeticOverflow), in whole atoms. */
function forfeitLossBackingCapacity(m: RemainingAccount, markets: u64, domain: u64): u128 {
  sourceForDomain(m, markets, domain);
  const s = loadRawAt<SourceCreditState>(m, sourceAt(domain));
  const available = availableBacking(s);
  const gap = s.positive_claim_bound_num > available ? s.positive_claim_bound_num - available : 0n;
  if (gap > U128_MAX_RC - s.provider_receivable_num) failV16(V16_ARITHMETIC_OVERFLOW);
  return (gap + s.provider_receivable_num) / BOUND_SCALE;
}

/** What `settle_forfeited_leg_kf_effects` returns that the forfeit uses. */
interface ForfeitSettlement {
  loss: u128;
  support: u128;
  junior: u128;
}

/**
 * `settle_forfeited_leg_kf_effects(account, asset)`: nothing without an active leg of the asset; the leg decoded; the
 * asset configured (InvalidLeg); the leg's K/F delta. A loss goes through the haircut-bounded close loss (no K/F loss
 * domain); the capital-covered part of the new negative PnL, up to what the leg's domain's claimants own
 * (`forfeit_loss_backing_capacity_atoms`), is reserved for that domain. A gain is forfeited. The funding flow recorded,
 * the stale K/F cohort settled, the leg's K and F snapshots and K/F epoch written, the certificate invalidated, the
 * asset written (`set_asset_state`), the market's loss-stale flag set from the asset.
 */
function settleForfeitedLegKf(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64): ForfeitSettlement {
  const out: ForfeitSettlement = { loss: 0n, support: 0n, junior: 0n };
  const slot = activeLegSlotForAssetBitmap(pa, asset);
  if (slot === NO_SLOT) return out;
  const leg0 = legAt(pa, slot);
  checkV16(legErr(leg0));
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  const kf = legKfDeltaComponents(loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset, leg0);
  const short = leg0.side === 1n;
  if (kf.net < 0n) {
    const loss = absH(kf.net);
    out.loss = loss;
    const pnl0 = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
    const negBefore = pnl0 < 0n ? absH(pnl0) : 0n;
    const support = applyHaircutBoundedCloseLoss(m, markets, pa, loss, NO_DOMAIN);
    out.support = support.support_consumed;
    out.junior = support.junior_face_burned;
    const pnl1 = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
    const negAfter = pnl1 < 0n ? absH(pnl1) : 0n;
    const domain = insuranceDomainIndex(m, markets, asset, short);
    const owned = forfeitLossBackingCapacity(m, markets, domain);
    const fresh = negAfter > negBefore ? negAfter - negBefore : 0n;
    const take = fresh < owned ? fresh : owned;
    if (negBefore > U128_MAX_RC - take) failV16(V16_ARITHMETIC_OVERFLOW);
    reserveNewCapitalBackedLoss(m, markets, pa, domain, negBefore, negBefore + take);
  }
  recordAccountFundingFlow(pa, short, kf.f_delta);
  const at = assetSlot(m, markets, asset);
  const e = loadRawMutAt<EngineAssetSlot>(m, at);
  const before = slotBlockers(e);
  const epoch = settleKfStaleCohort(e.asset, short, leg0.kf_epoch_snap);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const leg = p.legs.get(slot);
  leg.k_snap = kf.k_now;
  leg.f_snap = kf.f_snap_next;
  leg.kf_epoch_snap = epoch;
  p.health_cert.valid = 0n;
  setAssetState(m, asset, before);
  const hm = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  hm.loss_stale_active = assetIsLossStaleAt(e.asset, hm.current_slot) ? 1n : 0n;
  return out;
}

/** A declaration followed by RecoveryRequired under the forfeit: its error propagates and the transaction fails. */
function failDeclared(status: u64): void {
  if (status === DECLARED) failV16(V16_RECOVERY_REQUIRED);
}

/**
 * `forfeit_recovery_leg_not_atomic(account, asset, b_loss_atom_budget)`: the account validated with the market;
 * InvalidLeg for an asset past the configured slots or the view, a zero budget, or no active leg of it; LockActive for a
 * leg that is not dead. An exhausted side (no pending residual, no barrier) begins its full-drain reset first. A leg
 * already settled (zero PnL, K/F epoch, K, F and B current, no pending residual) is detached at once. Otherwise its K/F
 * effects are settled, then one B chunk (an unfinished chunk ends the call after the shape and the account's check),
 * the loss settled from principal; a gross loss (the residual and the support consumed) opens a close ledger on the
 * other side, advanced by the support; the domain's insurance (the ledger advanced by it); the residual: none, a chunk
 * booked (the PnL raised by what it cleared), or, when no step can book it, Recovery declared
 * (ActiveBankruptCloseCannotProgress) and a success with the debt kept in the ledger. A leg with no loss left and no
 * pending residual is detached. The market's shape, the account validated with the market.
 */
export function forfeitRecoveryLeg(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, budget: u128): void {
  validateWithMarket(m, pa, markets);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets || budget === 0n) failV16(V16_INVALID_LEG);
  let slot = activeLegForAsset(pa, asset);
  if (slot === NO_SLOT) failV16(V16_INVALID_LEG);
  if (!legIsDeadForForfeit(m, markets, asset, legAt(pa, slot))) failV16(V16_LOCK_ACTIVE);
  const short = legAt(pa, slot).side === 1n;
  if (legHasExhaustedEffectiveOi(loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset, legAt(pa, slot))) {
    const c = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
    checkV16(closeProgressErr(c));
    if (!closeHasPendingResidual(c) && !hasPendingDomainLossBarrier(m, markets, asset, short)) {
      beginFullDrainResetInner(m, markets, asset, short);
      slot = activeLegForAsset(pa, asset);
    }
  }
  const leg = legAt(pa, slot);
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  const t = kfTargetForLeg(a, leg);
  const bTarget = bTargetOf(m, markets, asset, leg);
  const p0 = loadRawAt<Portfolio>(pa, HEADER_LEN);
  let settled = p0.pnl === 0n && kfEpochCurrent(a, leg) && t.k === leg.k_snap && fSnapSettled(leg, t.f) && bTarget <= leg.b_snap;
  if (settled) {
    checkV16(closeProgressErr(p0.close_progress));
    settled = !closeHasPendingResidual(p0.close_progress);
  }
  if (settled) {
    detach(m, markets, pa, asset, leg);
    return;
  }
  const s = settleForfeitedLegKf(m, markets, pa, asset);
  const refreshed = activeLegForAsset(pa, asset);
  // `active_leg_for_asset` is the leg settled just now (it stays active).
  if (bTargetOf(m, markets, asset, legAt(pa, refreshed)) > legAt(pa, refreshed).b_snap) {
    markLegBStale(m, pa, asset);
    const chunk = settleAccountBChunk(m, markets, pa, asset, budget);
    if (s.loss > U128_MAX_RC - chunk.loss) failV16(V16_ARITHMETIC_OVERFLOW);
    if (chunk.remaining_after !== 0n) {
      checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
      validateWithMarket(m, pa, markets);
      return;
    }
  }
  // settle_negative_pnl_from_principal_not_atomic: validated with the market first.
  validateWithMarket(m, pa, markets);
  settleNegativePnlFromPrincipal(m, pa);
  const pnl1 = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  const residualAfterPrincipal = pnl1 < 0n ? absH(pnl1) : 0n;
  if (residualAfterPrincipal > U128_MAX_RC - s.support) failV16(V16_ARITHMETIC_OVERFLOW);
  const gross = residualAfterPrincipal + s.support;
  if (gross !== 0n) {
    beginCloseProgressLedger(m, markets, pa, asset, !short, gross);
    if (s.support !== 0n) failDeclared(advanceCloseLedgerFull(m, markets, pa, s.support, s.junior, 0n, 0n, 0n));
  }
  const used = consumeDomainInsurance(m, markets, asset, short, pa);
  if (used !== 0n) failDeclared(advanceCloseLedgerFull(m, markets, pa, 0n, 0n, used, 0n, 0n));
  const pnl2 = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  const residual = pnl2 < 0n ? absH(pnl2) : 0n;
  const capacity = residual === 0n ? 0n : bankruptcyCapacity(m, markets, asset, short, residual);
  // kernel_forfeit_residual_step(residual, capacity).
  if (residual !== 0n && capacity === 0n) {
    declareRecovery(m, markets, REASON_ACTIVE_BANKRUPT_CLOSE);
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    validateWithMarket(m, pa, markets);
    return;
  }
  if (residual !== 0n) {
    const out = bookResidualForAccount(m, markets, pa, asset, short, residual);
    failDeclared(out.status);
    if (out.booked > U128_MAX_RC - out.explicit) failV16(V16_ARITHMETIC_OVERFLOW);
    let cleared = out.booked + out.explicit;
    if (cleared > residual) cleared = residual;
    // cleared ≤ residual ≤ i128::MAX: i128::try_from cannot fail, and the PnL moves toward zero from at least −residual
    // (the booking does not change the PnL), so the sum cannot overflow.
    if (cleared > I128_MAX_RC) failV16(V16_ARITHMETIC_OVERFLOW);
    setAccountPnl(m, markets, pa, loadRawAt<Portfolio>(pa, HEADER_LEN).pnl + toI128(cleared));
  }
  const p3 = loadRawAt<Portfolio>(pa, HEADER_LEN);
  let detached = p3.pnl >= 0n;
  if (detached) {
    checkV16(closeProgressErr(p3.close_progress));
    detached = !closeHasPendingResidual(p3.close_progress);
  }
  if (detached) {
    const now = activeLegForAsset(pa, asset);
    detach(m, markets, pa, asset, legAt(pa, now));
  }
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, pa, markets);
}

/**
 * `resolve_market_not_atomic(resolved_slot)`: the mode decoded; Stale for a slot behind the market's; the market
 * Resolved at the slot (its resolved and current slots), the loss-stale flag cleared, the market's shape.
 */
export function resolveMarket(m: RemainingAccount, markets: u64, slot: u64): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (slot < h.current_slot) failV16(V16_STALE);
  h.mode = 1n;
  h.resolved_slot = slot;
  h.current_slot = slot;
  h.loss_stale_active = 0n;
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}
