// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): parts of aeyakovenko/percolator src/v16.rs (the engine
// of Percolator v16), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The B chunks and the driver of the settlement of open legs (layers 6 and 7 of the map in NOTES.md, section 10): a
// leg's B target, the account's and a leg's B-stale marks, one chunk of a leg's B settlement (its loss taken from the
// PnL through a domain-first claim burn, the leg's B snapshot advanced), the account's K/F settlement (the impaired
// liens reconciled, then one leg, or every leg in the order of a plan sorted by phase, source domain and slot), and
// `settle_account_side_effects_not_atomic`, which settles the K/F effects, then each leg's B up to its target one chunk
// each, stopping at the first leg a chunk does not finish (`PermissionlessProgressOutcomeV16::AccountBChunk`), and
// books the negative PnL against principal.
//
// Wired through `settle_account_side_effects_not_atomic` (settlement.ts) into SyncMaintenanceFee and Withdraw, compared
// with the reference binary on generated states with open legs (percolator-v16-refresh.test.ts,
// percolator-v16-walk.test.ts); each function is also compared alone with the original's own function compiled for the
// host on generated markets and portfolios (percolator-v16-primitives.test.ts).
//
// Copies. `mark_leg_b_stale` and `settle_account_b_chunk` read a leg into a value, change it and write it back
// (`from_runtime`); nothing in between writes the leg, so the port changes it in place. The K/F plan's prepared values
// are kept per slot as the original keeps them (`prepared_by_slot`). Every caller propagates every error here except
// for the outcome, which is a value: `sync_account_fee_to_slot_not_atomic` turns an AccountBChunk into BStale.
import { type FixedArray, type RemainingAccount, type i128, type u64, type u128, fixedArray, loadRawAt, loadRawMutAt, i128 as toI128, u64 as toU64 } from "typesol";
import { V16_ARITHMETIC_OVERFLOW, V16_B_STALE, V16_COUNTER_OVERFLOW, V16_COUNTER_UNDERFLOW, V16_INVALID_CONFIG, V16_INVALID_LEG, V16_RECOVERY_REQUIRED, checkV16, failV16 } from "./errors.js";
import { type EngineAssetSlot, type GroupHeader, type Portfolio, HEADER_LEN, MARKET_GROUP_OFF } from "./state.js";
import { V16_MAX_PORTFOLIO_ASSETS_N, assetStateErr } from "./wire.js";
import { engineSlotAt, legErr, validateWithMarket } from "./engine.js";
import { accountBChunkFromLeg, advanceLegBSnap, bTargetForLeg } from "./kernels.js";
import { NO_SLOT, activeLegForAsset, hasBStaleLeg, insuranceDomainIndex, requireActiveLegSlotForAsset } from "./primitives.js";
import { reconcileImpairedCounterpartyLiens } from "./impairment.js";
import { setAccountPnlAfterDomainFirstBurn } from "./claims.js";
import { type KfPrepared, applyKfSettlementEntry, prepareKfSettlementEntry } from "./kfsettle.js";
import { settleNegativePnlFromPrincipal } from "./refresh.js";

const I128_MAX_B: u128 = 0x7fffffffffffffffffffffffffffffffn;
const I128_MIN_B: i128 = -170141183460469231731687303715884105728n;
const U64_MAX_B: u64 = 0xffffffffffffffffn;

/** `AccountBSettlementChunkV16`, and for the driver's outcome whether the account is current (`AccountCurrent`, 1) or
 * stopped at a chunk (`AccountBChunk`, 0). */
export interface BSettlement {
  current: u64;
  delta_b: u128;
  loss: u128;
  new_remainder: u128;
  remaining_after: u128;
}

/** `b_target_for_leg(asset, leg)`: the asset configured and in the view (InvalidLeg), decoded, the leg's B target. */
export function bTargetForLegAt(m: RemainingAccount, markets: u64, asset: u64, legSlot: u64, pa: RemainingAccount): u128 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  checkV16(assetStateErr(a));
  return bTargetForLeg(a, loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(legSlot));
}

/** `mark_account_b_stale(account)`: the flag decoded (InvalidConfig); an unmarked account marked, its certificate
 * invalidated, the market's count of B-stale accounts raised (CounterOverflow). */
export function markAccountBStale(m: RemainingAccount, pa: RemainingAccount): void {
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (p.b_stale_state > 1n) failV16(V16_INVALID_CONFIG);
  if (p.b_stale_state === 1n) return;
  p.b_stale_state = 1n;
  p.health_cert.valid = 0n;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.b_stale_account_count === U64_MAX_B) failV16(V16_COUNTER_OVERFLOW);
  h.b_stale_account_count += 1n;
}

/** `clear_account_b_stale(account)`: BStale while a leg is B-stale; the flag decoded; a marked account unmarked, the
 * market's count lowered (CounterUnderflow). */
export function clearAccountBStale(m: RemainingAccount, pa: RemainingAccount): void {
  if (hasBStaleLeg(pa)) failV16(V16_B_STALE);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (p.b_stale_state > 1n) failV16(V16_INVALID_CONFIG);
  if (p.b_stale_state === 0n) return;
  p.b_stale_state = 0n;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.b_stale_account_count === 0n) failV16(V16_COUNTER_UNDERFLOW);
  h.b_stale_account_count -= 1n;
}

/** `mark_leg_b_stale(account, asset)`: the asset's active leg (InvalidLeg for none) decoded and marked B-stale, the
 * account marked. */
export function markLegBStale(m: RemainingAccount, pa: RemainingAccount, asset: u64): void {
  const slot = requireActiveLegSlotForAsset(pa, asset);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const leg = p.legs.get(slot);
  checkV16(legErr(leg));
  leg.b_stale = 1n;
  markAccountBStale(m, pa);
}

/**
 * `account_b_settlement_chunk(account, asset, budget)`: the account validated with the market; the asset's active leg
 * (none: InvalidLeg); its B target (RecoveryRequired below the leg's snapshot); the chunk within the budget and the
 * config's public B chunk.
 */
export function accountBSettlementChunk(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, budget: u128): BSettlement {
  validateWithMarket(m, pa, markets);
  const slot = activeLegForAsset(pa, asset);
  // No active leg: `PortfolioLegV16::EMPTY`, inactive.
  if (slot === NO_SLOT) failV16(V16_INVALID_LEG);
  const target = bTargetForLegAt(m, markets, asset, slot, pa);
  const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
  if (target < leg.b_snap) failV16(V16_RECOVERY_REQUIRED);
  const c = accountBChunkFromLeg(leg, target, budget, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.public_b_chunk_atoms);
  return { current: 0n, delta_b: c.delta_b, loss: c.loss, new_remainder: c.new_remainder, remaining_after: c.remaining_after };
}

/**
 * `settle_account_b_chunk(account, asset, budget)`: the chunk; none to move: the account unmarked if no leg is B-stale.
 * Else the PnL lowered by the chunk's loss (ArithmeticOverflow), the leg's B snapshot advanced (marked B-stale while B
 * remains), the PnL set with the decrease burned from the domain opposite the leg's side first, the account marked or
 * unmarked, its certificate invalidated. (The audit scan is off in the program's build.)
 */
export function settleAccountBChunk(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, budget: u128): BSettlement {
  const chunk = accountBSettlementChunk(m, markets, pa, asset, budget);
  if (chunk.delta_b === 0n) {
    if (!hasBStaleLeg(pa)) clearAccountBStale(m, pa);
    return chunk;
  }
  const oldPnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  if (chunk.loss > I128_MAX_B) failV16(V16_ARITHMETIC_OVERFLOW);
  const loss = toI128(chunk.loss);
  if (oldPnl < I128_MIN_B + loss) failV16(V16_ARITHMETIC_OVERFLOW);
  const slot = requireActiveLegSlotForAsset(pa, asset);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const leg = p.legs.get(slot);
  checkV16(legErr(leg));
  advanceLegBSnap(leg, chunk.delta_b, chunk.new_remainder, chunk.remaining_after);
  const domain = insuranceDomainIndex(m, markets, asset, leg.side !== 1n);
  setAccountPnlAfterDomainFirstBurn(m, markets, pa, oldPnl - loss, domain);
  if (chunk.remaining_after !== 0n) markAccountBStale(m, pa);
  else if (!hasBStaleLeg(pa)) clearAccountBStale(m, pa);
  p.health_cert.valid = 0n;
  return chunk;
}

/**
 * `settle_account_kf_effects_not_atomic(account, normalize_exhausted_sides)`: nothing for a flat account; the impaired
 * counterparty liens reconciled; one active leg (its bit among the 16 slots, else InvalidLeg) prepared and applied;
 * several: each active leg prepared in slot order, its key inserted into a plan sorted ascending (phase, source domain,
 * slot), then applied in the plan's order with its prepared values.
 */
export function settleAccountKfEffects(m: RemainingAccount, markets: u64, pa: RemainingAccount, normalize: boolean): void {
  const bitmap = loadRawAt<Portfolio>(pa, HEADER_LEN).active_bitmap.get(0n);
  if (bitmap === 0n) return;
  reconcileImpairedCounterpartyLiens(m, markets, pa);
  if ((bitmap & (bitmap - 1n)) === 0n) {
    let slot = 0n;
    while (slot < V16_MAX_PORTFOLIO_ASSETS_N && ((bitmap >> slot) & 1n) === 0n) slot++;
    if (slot === V16_MAX_PORTFOLIO_ASSETS_N) failV16(V16_INVALID_LEG);
    applyKfSettlementEntry(m, markets, pa, prepareKfSettlementEntry(m, markets, pa, slot, normalize));
    return;
  }
  const plan: FixedArray<u64, 16> = fixedArray<u64, 16>(0n);
  const entries: FixedArray<u64, 16> = fixedArray<u64, 16>(0n);
  const kNow: FixedArray<i128, 16> = fixedArray<i128, 16>(0n);
  const fNow: FixedArray<i128, 16> = fixedArray<i128, 16>(0n);
  const fSnap: FixedArray<i128, 16> = fixedArray<i128, 16>(0n);
  const fDelta: FixedArray<i128, 16> = fixedArray<i128, 16>(0n);
  const net: FixedArray<i128, 16> = fixedArray<i128, 16>(0n);
  let len = 0n;
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) continue;
    const prep = prepareKfSettlementEntry(m, markets, pa, slot, normalize);
    entries.set(slot, prep.entry);
    kNow.set(slot, prep.k_now);
    fNow.set(slot, prep.f_now);
    fSnap.set(slot, prep.f_snap_next);
    fDelta.set(slot, prep.f_delta);
    net.set(slot, prep.net);
    // insert_account_kf_settlement_plan_entry: an ascending insertion (at most 16 active slots: no overflow).
    let at = len;
    while (at > 0n && prep.entry < plan.get(at - 1n)) {
      plan.set(at, plan.get(at - 1n));
      at--;
    }
    plan.set(at, prep.entry);
    len++;
  }
  for (let i = 0n; i < len; i++) {
    const entry = plan.get(i);
    const slot = entry & 0xfn;
    const prep: KfPrepared = { entry, k_now: kNow.get(slot), f_now: fNow.get(slot), f_snap_next: fSnap.get(slot), f_delta: fDelta.get(slot), net: net.get(slot) };
    applyKfSettlementEntry(m, markets, pa, prep);
  }
}

/**
 * `settle_account_side_effects_not_atomic(account, b_loss_atom_budget)`: the account validated with the market; its K/F
 * effects settled; each active leg below its B target (the asset configured and decoded) marked B-stale and settled by
 * one chunk, returning at the first chunk that leaves B to settle (AccountBChunk); then the negative PnL settled from
 * principal, the certificate invalidated (AccountCurrent).
 */
export function settleAccountSideEffects(m: RemainingAccount, markets: u64, pa: RemainingAccount, budget: u128): BSettlement {
  validateWithMarket(m, pa, markets);
  settleAccountKfEffects(m, markets, pa, false);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active !== 1n) continue;
    const asset = toU64(leg.asset_index);
    // `refreshed`: the same leg decoded again (it passed).
    const target = bTargetForLegAt(m, markets, asset, slot, pa);
    if (target > loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot).b_snap) {
      markLegBStale(m, pa, asset);
      const chunk = settleAccountBChunk(m, markets, pa, asset, budget);
      if (chunk.remaining_after !== 0n) return chunk;
    }
  }
  settleNegativePnlFromPrincipal(m, pa);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  p.health_cert.valid = 0n;
  return { current: 1n, delta_b: 0n, loss: 0n, new_remainder: 0n, remaining_after: 0n };
}
