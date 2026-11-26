// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs,
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// ResolveMarket (tag 19) and ResolveStalePermissionless (tag 39): `handle_resolve_market`,
// `handle_resolve_stale_permissionless` and `resolve_market_view` (`reject_market_resolve_before_committed_accrual_view`,
// then the engine's `resolve_market_not_atomic`: recovery.ts). Nothing is copied or swallowed: the profiles are read
// (unchecked, then validated where the original validates them) and nothing is written before the engine's resolution.
import { type InstructionBytes, type Pubkey, type RemainingAccount, type RemainingAccounts, type u64, currentSlot, loadRawAt, rawArrayAt, require, u64 as toU64 } from "typesol";
import { PercolatorError } from "./errors.js";
import { type AssetSlot, type GroupHeader, type WrapperConfig, HEADER_LEN, MARKET_GROUP_LEN, MARKET_GROUP_OFF, dynamicSlotOffset, validateAssetOracleProfile } from "./state.js";
import { type ResolveAccrual, resolveAccrual } from "./crank.js";
import { resolveMarket } from "./recovery.js";
import { expectLiveAuthority, marketViewMut, needAccounts, ownerCheck, permissionlessStaleMatured, requireAuthorityEpoch, signerCheck, writableCheck } from "./program.js";

/**
 * `resolve_market_view(cfg, group, slot, include_pending_mark)`: `reject_market_resolve_before_committed_accrual_view`
 * (EngineInvalidConfig for more configured slots than the view; each configured asset with exposure behind the slot:
 * its profile read unchecked; a zero-value interval (funding disabled, the mark at the effective price) passes; else the
 * profile validated and a required resolve accrual is EngineStale), then the engine's resolution (map_v16_error).
 */
function resolveMarketView(ma: RemainingAccount, markets: u64, slot: u64, include: boolean): void {
  const h = loadRawAt<GroupHeader>(ma, MARKET_GROUP_OFF);
  const configured = toU64(h.config.max_market_slots);
  require(configured <= markets, PercolatorError.EngineInvalidConfig);
  // The view's slots (`group.markets`): their bounds were checked by the market view (the capacity is the length's), so
  // the scan reads each slot in place without a check of its own, as the original indexes the slice.
  const slots = rawArrayAt<AssetSlot>(ma, MARKET_GROUP_OFF + MARKET_GROUP_LEN, markets);
  for (let asset = 0n; asset < configured; asset++) {
    const s = slots.get(asset);
    const a = s.engine.asset;
    if ((a.oi_eff_long_q === 0n && a.oi_eff_short_q === 0n) || a.slot_last >= slot) continue;
    const p = s.wrapper.profile;
    if (h.config.max_abs_funding_e9_per_slot === 0n && p.mark_ewma_e6 === a.effective_price) continue;
    validateAssetOracleProfile(p);
    const ra: ResolveAccrual = { some: false, slot: 0n, price: 0n, rate: 0n };
    resolveAccrual(ma, markets, dynamicSlotOffset(asset), asset, slot, include, ra);
    require(!ra.some, PercolatorError.EngineStale);
  }
  resolveMarket(ma, markets, slot);
}

/**
 * `handle_resolve_market(asset_generation_frontier, authority_epoch)`: accounts admin (signer), market (w); the market
 * writable and the program's; the market view; the frontier (AssetGenerationMismatch); EngineLockActive unless Live; the
 * market authority (Unauthorized); its authority epoch; the Clock's slot not behind the market's (EngineStale); the
 * resolution without the pending mark's activation step.
 *
 * @noinline
 */
export function resolveMarketHandler(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 2n);
  const admin = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(admin);
  writableCheck(m);
  ownerCheck(m, programId);
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.next_market_id === data.readU64(1n), PercolatorError.AssetGenerationMismatch);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  expectLiveAuthority(loadRawAt<WrapperConfig>(m, HEADER_LEN).marketauth, admin.key);
  requireAuthorityEpoch(m, markets, 0n, data.readU64(9n));
  const slot = currentSlot();
  require(slot >= h.current_slot, PercolatorError.EngineStale);
  resolveMarketView(m, markets, slot, false);
}

/**
 * `handle_resolve_stale_permissionless(now_slot)`: accounts market (w); writable and the program's; the Clock's slot;
 * the market view; EngineLockActive unless Live; EngineStale for a slot behind the market's; OracleStale unless the
 * permissionless stale window has matured at it; the resolution with the pending mark's activation step.
 *
 * @noinline
 */
export function resolveStalePermissionless(rest: RemainingAccounts, programId: Pubkey): void {
  needAccounts(rest, 1n);
  const m = rest.get(0n);
  writableCheck(m);
  ownerCheck(m, programId);
  const slot = currentSlot();
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  require(slot >= h.current_slot, PercolatorError.EngineStale);
  require(permissionlessStaleMatured(loadRawAt<WrapperConfig>(m, HEADER_LEN), slot), PercolatorError.OracleStale);
  resolveMarketView(m, markets, slot, true);
}
