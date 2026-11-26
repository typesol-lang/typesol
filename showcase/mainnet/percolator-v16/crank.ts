// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs,
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// PermissionlessCrank (tag 5): `handle_permissionless_crank` and `handle_permissionless_crank_zero_copy`, with the
// observation of each hinted asset (`hybrid_target_for_crank_view`: the EWMA or authenticated mark, the effective price
// of a Manual asset, a hybrid's external read with its fall-back to the mark once the soft-stale window has matured and
// its liveness; `canonical_accrual_path_for_target_view` and the engine's `accrue_asset_path_to_not_atomic`; a matured
// permissionless resolution's terminal accrual, `required_market_resolve_accrual_for_profile_view`), the maintenance
// fee, the health observations every leg needs (`reject_incomplete_account_health_observations_view`), the engine's crank
// (autocrank.ts), the checkpoints, the liquidation fee's destination (`liquidation_penalty_reclaimable_from_profile_view`,
// the cranker's reward, `credit_market_fee_split_across_domains_view`) and the position epoch; FinalizeResetSide (tag 45).
//
// A Resolved market goes to `handle_close_resolved` (closeresolved.ts); a market in Recovery takes the zero-copy
// handler's mode-2 branch (the engine's committed-state work: recovery.ts).
//
// Errors the original looks at. The engine crank's NonProgress is swallowed once a market was accrued
// (`market_accrual_performed`: NOTES.md section 1, site 2): autocrank.ts returns it as a value and every write it made
// before stays, as in the original. The hybrid reader's OracleStale and NotEnoughAccountKeys are looked at (external.ts
// returns them as values).
//
// Copies (NOTES.md section 13). The original reads the wrapper config into `cfg` and writes it back at the end
// (validated); each hinted asset's oracle profile into a copy written back (validated) at the end of its turn, compared
// with the stored one to see whether it changed. Nothing in between reads the bytes those copies change from the
// account, and every failure in between fails the transaction (the swallowed NonProgress is the engine's, after the
// profiles are written), so the port changes both in place: it keeps the fields a crank can change of the profile as it
// was (`Snap`) to tell whether it changed, and validates the config and each profile where the original writes them.
//
// Repeated accounts. The market is held while the portfolio, the oracle accounts and the cranker's portfolio are
// borrowed: an oracle account that is the market fails its borrow (AccountBorrowFailed: the reader's `busy` key), as
// does a cranker portfolio that is the market (its preflight borrows it); the cranker that is the portfolio is refused
// (InvalidInstruction) before; the portfolio's borrow is released while the oracles are read (an oracle account that is
// the portfolio is read: IllegalOwner).
import {
  type FixedArray,
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type i128,
  type i64,
  type u8,
  type u64,
  type u128,
  ProgramError,
  currentSlot,
  fixedArray,
  loadRawAt,
  loadRawMutAt,
  now,
  require,
  u64 as toU64,
  u128 as toU128,
} from "typesol";
import { PercolatorError, V16_OK, checkV16 } from "./errors.js";
import {
  type AssetOracleProfile,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type WrapperConfig,
  EFFECTIVE_PRICE_PROVENANCE_AUTHENTICATED,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  MAX_ORACLE_PRICE,
  portfolioPreflightChecks,
  validateAssetOracleProfile,
  validateWrapperConfig,
} from "./state.js";
import { V16_MAX_PORTFOLIO_ASSETS_N, assetStateErr, closeProgressErr, provenanceHeaderErr } from "./wire.js";
import { LIFECYCLE_ACTIVE, LIFECYCLE_DRAIN_ONLY, engineSlotAt, legErr, marketShapeErr, setAssetRawOracleTarget, validateWithMarket } from "./engine.js";
import { accrueAssetTo, clampTowardEngineDt, permissionlessFundingRate } from "./accrual.js";
import { advanceFundingMarkCheckpoint, mirrorProfileToConfig } from "./oracle.js";
import { type ExternalRead, R_NOT_ENOUGH_ACCOUNT_KEYS, R_OK, R_ORACLE_STALE, failOracle, readExternalPriceProfile } from "./external.js";
import { type AccrualStep, accrueAssetPath, bumpPositionEpoch, canonicalPath, isHybrid, isPriceManaged, softStaleMatured, updatesMarkFromTrade } from "./trading.js";
import { creditMaintenanceFee, feeShareFloor } from "./custody.js";
import { creditAccountFromInsurance, creditDomainInsuranceBudget, syncAccountFeeToSlot } from "./refresh.js";
import {
  type AutoCrank,
  type Observation,
  type Selected,
  type Summary,
  NONE,
  PLAN_DECLARE_RECOVERY,
  PLAN_LIQUIDATE,
  PLAN_NO_ACTION,
  PLAN_REFRESH,
  PLAN_SETTLE_B,
  autoCrank,
  buildSummary,
  finalizeSideReset,
} from "./autocrank.js";
import { NONPROG } from "./liquidation.js";
import {
  authenticatedMarketSlot,
  ensurePortfolioStorage,
  expectPortfolioAccountKey,
  marketViewMut,
  needAccounts,
  ownerCheck,
  permissionlessStaleMatured,
  portfolioViewMut,
  profileFromView,
  readMarketConfigMode,
  signerCheck,
  writableCheck,
} from "./program.js";
import { closeResolved } from "./closeresolved.js";

const U64_MAX_CK: u64 = 0xffffffffffffffffn;
const I64_MAX_CK: u64 = 0x7fffffffffffffffn;
/** MarketModeV16: Live 0, Resolved 1, Recovery 2. */
const MODE_LIVE_CK: u8 = 0n;
const MODE_RESOLVED_CK: u8 = 1n;
const MODE_RECOVERY_CK: u8 = 2n;
/** Oracle modes: Manual 0, hybrid 1, EWMA mark 2, AuthMark 3. */
const ORACLE_MODE_EWMA_CK: u8 = 2n;
const ORACLE_MODE_AUTH_CK: u8 = 3n;

// ---- The profile's fields a crank changes ------------------------------------------------------------------------------

/** The fields of an AssetOracleProfile that a crank's turn can change: the checkpoint, the target and its liveness, the
 * legs' observations, the mark, the provenance and the price-move remainder. Every other field it leaves alone. */
interface Snap {
  funding_mark: u64;
  pending: u64;
  pending_slot: u64;
  target: u64;
  publish: i64;
  last_good: u64;
  p0: u64;
  p1: u64;
  p2: u64;
  t0: i64;
  t1: i64;
  t2: i64;
  ewma: u64;
  ewma_slot: u64;
  provenance: u8;
  remainder: u64;
}

function snap(p: AssetOracleProfile): Snap {
  return {
    funding_mark: p.funding_mark_e6,
    pending: p.funding_mark_pending_e6,
    pending_slot: p.funding_mark_pending_slot,
    target: p.oracle_target_price_e6,
    publish: p.oracle_target_publish_time,
    last_good: p.last_good_oracle_slot,
    p0: p.oracle_leg_prices_e6.get(0n),
    p1: p.oracle_leg_prices_e6.get(1n),
    p2: p.oracle_leg_prices_e6.get(2n),
    t0: p.oracle_leg_publish_times.get(0n),
    t1: p.oracle_leg_publish_times.get(1n),
    t2: p.oracle_leg_publish_times.get(2n),
    ewma: p.mark_ewma_e6,
    ewma_slot: p.mark_ewma_last_slot,
    provenance: p.effective_price_provenance,
    remainder: toU64(p.price_move_remainder_bps_num),
  };
}

/** The profile differs from the snapshot (the original's `profile != profile_before`, on the fields a crank changes). */
function changedFrom(p: AssetOracleProfile, s: Snap): boolean {
  return (
    p.funding_mark_e6 !== s.funding_mark ||
    p.funding_mark_pending_e6 !== s.pending ||
    p.funding_mark_pending_slot !== s.pending_slot ||
    p.oracle_target_price_e6 !== s.target ||
    p.oracle_target_publish_time !== s.publish ||
    p.last_good_oracle_slot !== s.last_good ||
    p.oracle_leg_prices_e6.get(0n) !== s.p0 ||
    p.oracle_leg_prices_e6.get(1n) !== s.p1 ||
    p.oracle_leg_prices_e6.get(2n) !== s.p2 ||
    p.oracle_leg_publish_times.get(0n) !== s.t0 ||
    p.oracle_leg_publish_times.get(1n) !== s.t1 ||
    p.oracle_leg_publish_times.get(2n) !== s.t2 ||
    p.mark_ewma_e6 !== s.ewma ||
    p.mark_ewma_last_slot !== s.ewma_slot ||
    p.effective_price_provenance !== s.provenance ||
    toU64(p.price_move_remainder_bps_num) !== s.remainder
  );
}

// ---- The processor's helpers -------------------------------------------------------------------------------------------------

/** `global_or_profile_resolve_matured_at_slot(cfg, profile, now)`: the market's stale window, or a price-managed profile's. */
function resolveMatured(cfg: WrapperConfig, p: AssetOracleProfile, slot: u64): boolean {
  if (permissionlessStaleMatured(cfg, slot)) return true;
  return isPriceManaged(p) && cfg.permissionless_resolve_stale_slots !== 0n && (slot > p.last_good_oracle_slot ? slot - p.last_good_oracle_slot : 0n) >= cfg.permissionless_resolve_stale_slots;
}

/** `asset_segment_dt_view(group, asset, slot)`: EngineStale for a slot behind the asset's; the gap within the accrual cap. */
function segmentDt(m: RemainingAccount, asset: u64, slot: u64): u64 {
  const last = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.slot_last;
  require(slot >= last, PercolatorError.EngineStale);
  const cap = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_accrual_dt_slots;
  return slot - last < cap ? slot - last : cap;
}

/** `oracle_v16::effective_price_from_target(anchor, target, bps, dt, exposed)`. */
function priceFromTarget(anchor: u64, target: u64, bps: u64, dt: u64, exposed: boolean): u64 {
  return exposed ? clampTowardEngineDt(anchor, target, bps, dt) : target;
}

/** `required_market_resolve_accrual_for_profile_view(profile, group, asset, resolved_slot, include_pending_mark)`'s result. */
export interface ResolveAccrual {
  some: boolean;
  slot: u64;
  price: u64;
  rate: i128;
}

/**
 * `required_market_resolve_accrual_for_profile_view(profile, group, asset, resolved_slot, include)`: InvalidInstruction
 * outside the configured slots and the view; none for an asset without exposure, already at the slot, or not
 * price-managed; with `include`, the pending mark's activation as a step of its own; the target (the funding mark during a pending
 * step, else the mark; OracleInvalid out of range); none with funding disabled and the mark at the price; the segment's
 * price toward the target and its funding rate; none when nothing moves (no activation step, the price unchanged, and
 * one side empty or no funding).
 */
export function resolveAccrual(m: RemainingAccount, markets: u64, at: u64, asset: u64, resolved: u64, include: boolean, out: Inout<ResolveAccrual>): void {
  out.some = false;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  const p = loadRawAt<AssetOracleProfile>(m, at);
  const exposed = a.oi_eff_long_q !== 0n || a.oi_eff_short_q !== 0n;
  if (!exposed || a.slot_last >= resolved || !isPriceManaged(p)) return;
  const pending = p.funding_mark_pending_e6 !== 0n && p.funding_mark_pending_slot > a.slot_last && p.funding_mark_pending_slot <= resolved;
  const activation = include && pending;
  const slot = activation ? p.funding_mark_pending_slot : resolved;
  const target = pending && p.funding_mark_e6 !== 0n ? p.funding_mark_e6 : p.mark_ewma_e6;
  require(target !== 0n && target <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  const current = a.effective_price;
  if (h.config.max_abs_funding_e9_per_slot === 0n && p.mark_ewma_e6 === current) return;
  const dt = segmentDt(m, asset, slot);
  const next = priceFromTarget(current, target, h.config.max_price_move_bps_per_slot, dt, exposed);
  const rate = permissionlessFundingRate(m, markets, at, asset, slot, next);
  const balanced = a.oi_eff_long_q !== 0n && a.oi_eff_short_q !== 0n;
  if (!activation && next === current && (!balanced || rate === 0n)) return;
  out.some = true;
  out.slot = slot;
  out.price = next;
  out.rate = rate;
}

/** The crank's target for an asset and the slot it takes effect. */
interface Target {
  price: u64;
  slot: u64;
}

/**
 * `hybrid_target_for_crank_view(cfg, profile, group, asset, now, now_ts, oracle_accounts)` on the profile at `at`:
 * InvalidInstruction past the configured slots; an EWMA or AuthMark profile targets its mark (OracleInvalid for none)
 * from the slot after the asset's; a Manual one the asset's effective price (OracleInvalid for none) at once; a hybrid
 * past the market's stale window is EngineRecoveryRequired; else the external read (`read_external_price_e6_profile`
 * over the hint's accounts): its price as the target with its publish time, the liveness slot advanced when a leg
 * advanced; OracleStale or NotEnoughAccountKeys fall back to the mark once the soft-stale window has matured (else
 * returned); OracleInvalid for a zero target; the target stored, from the slot after the asset's.
 */
function hybridTarget(m: RemainingAccount, at: u64, asset: u64, slot: u64, ts: i64, rest: RemainingAccounts, first: u64, count: u64, out: Inout<Target>): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(asset < toU64(h.config.max_market_slots), PercolatorError.InvalidInstruction);
  const assetSlot = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.slot_last;
  const next = assetSlot === U64_MAX_CK ? U64_MAX_CK : assetSlot + 1n;
  const p = loadRawMutAt<AssetOracleProfile>(m, at);
  if (p.oracle_mode === ORACLE_MODE_EWMA_CK || p.oracle_mode === ORACLE_MODE_AUTH_CK) {
    const t = p.mark_ewma_e6;
    require(t !== 0n, PercolatorError.OracleInvalid);
    p.oracle_target_price_e6 = t;
    out.price = t;
    out.slot = next;
    return;
  }
  if (!isHybrid(p)) {
    const price = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.effective_price;
    require(price !== 0n, PercolatorError.OracleInvalid);
    p.oracle_target_price_e6 = price;
    out.price = price;
    out.slot = assetSlot;
    return;
  }
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const since = slot > p.last_good_oracle_slot ? slot - p.last_good_oracle_slot : 0n;
  require(!(cfg.permissionless_resolve_stale_slots !== 0n && since >= cfg.permissionless_resolve_stale_slots), PercolatorError.EngineRecoveryRequired);
  const read: ExternalRead = { price: 0n, publish_time: 0n, advanced: 0n };
  const r = count >= toU64(p.oracle_leg_count) ? readExternalPriceProfile(m, at, rest, first, count, m.key, ts, read) : R_NOT_ENOUGH_ACCOUNT_KEYS;
  let target: u64 = 0n;
  if (r === R_OK) {
    p.oracle_target_price_e6 = read.price;
    p.oracle_target_publish_time = read.publish_time;
    if (read.advanced !== 0n) p.last_good_oracle_slot = slot;
    target = read.price;
  } else if (r === R_ORACLE_STALE || r === R_NOT_ENOUGH_ACCOUNT_KEYS) {
    if (!softStaleMatured(p, slot)) failOracle(r);
    target = p.mark_ewma_e6;
  } else failOracle(r);
  require(target !== 0n, PercolatorError.OracleInvalid);
  p.oracle_target_price_e6 = target;
  out.price = target;
  out.slot = next;
}

/**
 * `reject_incomplete_asset_health_observation_view(cfg, group, asset, now, observations)`: InvalidInstruction outside
 * the configured slots and the view; the profile (validated); a hybrid not soft-stale that was not observed in this slot
 * is EngineNonProgress; an asset observed in this crank passes; one not price-managed passes; with a segment to accrue,
 * the price the committed target would move it to (OracleInvalid without a target) and its funding rate must both be
 * nil (EngineNonProgress otherwise).
 */
function rejectIncompleteAsset(m: RemainingAccount, markets: u64, asset: u64, slot: u64, obs: FixedArray<Observation, 16>, count: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  const at = profileFromView(m, markets, asset);
  const p = loadRawAt<AssetOracleProfile>(m, at);
  require(!(isHybrid(p) && !softStaleMatured(p, slot) && p.last_good_oracle_slot !== slot), PercolatorError.EngineNonProgress);
  for (let i = 0n; i < count; i++) if (obs.get(i).asset === asset) return;
  if (!isPriceManaged(p)) return;
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  const dt = segmentDt(m, asset, slot);
  if (dt === 0n) return;
  const target = a.raw_oracle_target_price === 0n ? a.effective_price : a.raw_oracle_target_price;
  require(target !== 0n, PercolatorError.OracleInvalid);
  const current = a.effective_price;
  const exposed = a.oi_eff_long_q !== 0n || a.oi_eff_short_q !== 0n;
  const next = priceFromTarget(current, target, h.config.max_price_move_bps_per_slot, dt, exposed);
  const rate = permissionlessFundingRate(m, markets, at, asset, slot, next);
  require(next === current && rate === 0n, PercolatorError.EngineNonProgress);
}

/** `reject_incomplete_account_health_observations_view(cfg, group, portfolio, now, observations)`: each leg slot decoded,
 * its bit its active flag (EngineHiddenLeg), each active leg's asset seen once (EngineHiddenLeg) and observed enough. */
function rejectIncompleteAccount(m: RemainingAccount, markets: u64, pa: RemainingAccount, slot: u64, obs: FixedArray<Observation, 16>, count: u64): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  const seen = fixedArray<u64, 16>(0n);
  let seenCount = 0n;
  for (let s = 0n; s < V16_MAX_PORTFOLIO_ASSETS_N; s++) {
    const leg = p.legs.get(s);
    checkV16(legErr(leg));
    const bit = ((bitmap >> s) & 1n) !== 0n;
    require(bit === (leg.active === 1n), PercolatorError.EngineHiddenLeg);
    if (!bit) continue;
    const asset = toU64(leg.asset_index);
    for (let j = 0n; j < seenCount; j++) require(seen.get(j) !== asset, PercolatorError.EngineHiddenLeg);
    seen.set(seenCount, asset);
    seenCount += 1n;
    rejectIncompleteAsset(m, markets, asset, slot, obs, count);
  }
}

/** `liquidation_penalty_reclaimable_from_profile_view(profile, now)`: the mark is not trade-driven and the effective
 * price's provenance is authenticated. */
function reclaimable(p: AssetOracleProfile, slot: u64): boolean {
  return !updatesMarkFromTrade(p, slot) && p.effective_price_provenance === EFFECTIVE_PRICE_PROVENANCE_AUTHENTICATED;
}

/** `credit_market_insurance_budget_view(group, asset, amount)`: ⌊amount / 2⌋ to the long domain, the rest to the isShort. */
function creditMarketInsuranceBudget(m: RemainingAccount, markets: u64, asset: u64, amount: u128): void {
  if (amount === 0n) return;
  const long = amount / 2n;
  creditDomainInsuranceBudget(m, markets, asset * 2n, long);
  creditDomainInsuranceBudget(m, markets, asset * 2n + 1n, amount - long);
}

/** `credit_market_fee_split_across_domains_view(cfg, group, asset, amount)`: nothing for zero; for an asset other than 0
 * the redirect share to asset 0 (`fee_share_floor`); the rest to the asset's domains, then the redirect to asset 0's. */
function creditFeeSplit(m: RemainingAccount, markets: u64, asset: u64, amount: u128): void {
  if (amount === 0n) return;
  const redirect = asset === 0n ? 0n : feeShareFloor(amount, toU128(loadRawAt<WrapperConfig>(m, HEADER_LEN).fee_redirect_to_market_0_bps));
  creditMarketInsuranceBudget(m, markets, asset, amount - redirect);
  creditMarketInsuranceBudget(m, markets, 0n, redirect);
}

/** A portfolio's legs as `portfolio_position_vector_view` takes them: (active, asset, market id, side, basis) per slot. */
interface Positions {
  legs: FixedArray<u64, 16>;
  basis: FixedArray<i128, 16>;
}

function positionsOf(pa: RemainingAccount, out: Inout<Positions>): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let s = 0n; s < V16_MAX_PORTFOLIO_ASSETS_N; s++) {
    const l = p.legs.get(s);
    // active (u8), side (u8) and the u32 asset index packed with the market id's place kept apart.
    out.legs.set(s, toU64(l.active) | (toU64(l.side) << 8n) | (toU64(l.asset_index) << 16n));
    out.basis.set(s, l.basis_pos_q);
  }
}

function positionsChanged(pa: RemainingAccount, before: Inout<Positions>, ids: FixedArray<u64, 16>): boolean {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let s = 0n; s < V16_MAX_PORTFOLIO_ASSETS_N; s++) {
    const l = p.legs.get(s);
    if (before.legs.get(s) !== (toU64(l.active) | (toU64(l.side) << 8n) | (toU64(l.asset_index) << 16n))) return true;
    if (before.basis.get(s) !== l.basis_pos_q || ids.get(s) !== l.market_id) return true;
  }
  return false;
}

// ---- The handler ---------------------------------------------------------------------------------------------------------------

/**
 * `handle_permissionless_crank(now_slot, hints)`: accounts owner, market (w), portfolio (w), then the oracle accounts
 * and optionally the cranker's portfolio; the market and portfolio writable and the program's; the market's config,
 * mode and capacity (`read_market_config_mode_and_capacity`). A Resolved market takes at most one hint with no oracle
 * accounts on a configured asset (InvalidInstruction) and goes to `handle_close_resolved` (closeresolved.ts) with the
 * Clock's slot and the hinted asset.
 * Otherwise `handle_permissionless_crank_zero_copy`.
 *
 * @noinline
 */
export function permissionlessCrank(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 3n);
  const owner = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  writableCheck(m);
  writableCheck(pa);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  const mode = readMarketConfigMode(m);
  const count = toU64(data.readU8(9n));
  if (mode === MODE_RESOLVED_CK) {
    require(count <= 1n, PercolatorError.InvalidInstruction);
    let hint = NONE;
    if (count === 1n) {
      const configured = toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots);
      require(data.readU8(12n) === 0n && toU64(data.readU16(10n)) < configured, PercolatorError.InvalidInstruction);
      hint = toU64(data.readU16(10n));
    }
    closeResolved(rest, programId, 0n, hint);
    return;
  }
  crankZeroCopy(owner, m, pa, rest, data, count, programId);
}

/**
 * `handle_permissionless_crank_zero_copy`: the portfolio's owner preflight (its header, provenance and owner:
 * InvalidAccountData), its market and account ids (EngineProvenanceMismatch); its storage; the Clock's slot; the market
 * view with the fee carry; the portfolio's view and key. A market in Recovery: the engine's crank with no observation
 * (committed-state work), the shape, the position epoch advanced when a leg changed; nothing else. The close
 * ledger decoded; a Live market whose close has expired moves its clock to the slot; the summary; an expired close runs
 * the engine's crank with no observation, which must declare Recovery (InvalidInstruction), then the shape, and returns
 * (the config not written). A liquidatable account whose market's stale window matured needs a hint (OracleStale).
 * With a liquidation reward share, a last account owned by the program is the cranker's portfolio (the owner signs; it
 * is writable, not the portfolio, the market's and the owner's). Each hint (`observe`); every oracle account consumed
 * (InvalidInstruction). A matured resolution's accrual or a bounded catch-up returns after the shape, with the config
 * written. Then the summary again; the maintenance fee of an account with legs (not B-stale, no close); the health
 * observations of a stale or liquidatable account; the engine's crank (NonProgress swallowed once a market was
 * accrued, and a NoAction too; else EngineNonProgress); each observed asset's checkpoint; the liquidation fee: a
 * completed liquidation whose penalty is reclaimable pays the cranker's share from the insurance; the rest (none for a
 * liquidation whose penalty is not reclaimable) split across the fee asset's domains; a position change advances the
 * portfolio's position epoch after the shape; the config written (validated).
 *
 * @noinline
 */
function crankZeroCopy(
  owner: RemainingAccount,
  m: RemainingAccount,
  pa: RemainingAccount,
  rest: RemainingAccounts,
  data: InstructionBytes,
  hints: u64,
  programId: Pubkey,
): void {
  // read_portfolio_owner_preflight(portfolio), then the ids.
  portfolioPreflightChecks(pa);
  const ph = loadRawAt<Portfolio>(pa, HEADER_LEN).provenance_header;
  require(provenanceHeaderErr(ph) === V16_OK, ProgramError.InvalidAccountData);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === ph.owner, ProgramError.InvalidAccountData);
  require(ph.market_group_id === m.key && ph.portfolio_account_id === pa.key, PercolatorError.EngineProvenanceMismatch);
  ensurePortfolioStorage(pa);
  const slot = currentSlot();
  const markets = marketViewMut(m);
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  const h0 = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  // The Recovery branch: committed-state work only (the hints and their accounts are ignored): the engine's crank with
  // no observation, the shape, and the position epoch advanced when a leg changed; the config is not written.
  if (h0.mode === MODE_RECOVERY_CK) {
    const before: Positions = { legs: fixedArray<u64, 16>(0n), basis: fixedArray<i128, 16>(0n) };
    const ids = fixedArray<u64, 16>(0n);
    positionsOf(pa, before);
    for (let i = 0n; i < V16_MAX_PORTFOLIO_ASSETS_N; i++) ids.set(i, loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(i).market_id);
    const rr: AutoCrank = { plan: PLAN_NO_ACTION, asset: NONE, current: false, status: 0n, closed: false, payout: 0n };
    const none = fixedArray<Observation, 16>({ asset: 0n, price: 0n, rate: 0n });
    autoCrank(m, markets, pa, slot, none, 0n, 0n, rr);
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    if (positionsChanged(pa, before, ids)) bumpPositionEpoch(pa);
    return;
  }
  const c = loadRawAt<Portfolio>(pa, HEADER_LEN).close_progress;
  checkV16(closeProgressErr(c));
  if (h0.mode === MODE_LIVE_CK && c.active === 1n && c.residual_remaining > 0n && slot > c.max_close_slot && h0.current_slot < slot)
{
    const hc = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    hc.current_slot = slot;
  }
  const s: Summary = { stale: false, b_stale: false, pending_close: false, expired_close: false, liquidatable: false, releasable: false, resolved_winner: false };
  buildSummary(m, markets, pa, slot, s, freshSelected());
  const obs = fixedArray<Observation, 16>({ asset: 0n, price: 0n, rate: 0n });
  const r: AutoCrank = { plan: PLAN_NO_ACTION, asset: NONE, current: false, status: 0n, closed: false, payout: 0n };
  if (s.expired_close) {
    autoCrank(m, markets, pa, slot, obs, 0n, 0n, r);
    require(r.plan === PLAN_DECLARE_RECOVERY, PercolatorError.InvalidInstruction);
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    return;
  }
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  require(
    !(s.liquidatable && !s.b_stale && permissionlessStaleMatured(cfg, authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot)) && hints === 0n),
    PercolatorError.OracleStale,
  );
  // The cranker's portfolio, the last account when a reward is enabled.
  let tailEnd = rest.length;
  let cranker = false;
  if (cfg.liquidation_cranker_fee_share_bps !== 0n && rest.length > 3n) {
    const last = rest.get(rest.length - 1n);
    if (last.owner === programId) {
      signerCheck(owner);
      writableCheck(last);
      require(last.key !== pa.key, PercolatorError.InvalidInstruction);
      // read_portfolio_owner_preflight(&last.try_borrow_data()?): the market is borrowed.
      require(last.key !== m.key, ProgramError.AccountBorrowFailed);
      portfolioPreflightChecks(last);
      const lh = loadRawAt<Portfolio>(last, HEADER_LEN).provenance_header;
      require(provenanceHeaderErr(lh) === V16_OK, ProgramError.InvalidAccountData);
      require(loadRawAt<Portfolio>(last, HEADER_LEN).owner === lh.owner, ProgramError.InvalidAccountData);
      require(lh.market_group_id === m.key && lh.portfolio_account_id === last.key, PercolatorError.EngineProvenanceMismatch);
      require(lh.owner === owner.key, PercolatorError.Unauthorized);
      ensurePortfolioStorage(last);
      cranker = true;
      tailEnd = rest.length - 1n;
    }
  }
  const reclaim = fixedArray<u64, 16>(0n);
  const st: CrankState = { count: 0n, tail: 3n, matured: 0n, settlement: false, catchup: false, accrued: false };
  const ts: i64 = now();
  for (let i = 0n; i < hints; i++) {
    observe(m, markets, rest, tailEnd, toU64(data.readU16(10n + 3n * i)), toU64(data.readU8(12n + 3n * i)), slot, ts, obs, reclaim, st);
  }
  require(st.tail === tailEnd, PercolatorError.InvalidInstruction);
  if (st.settlement || st.catchup) {
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    validateWrapperConfig(loadRawAt<WrapperConfig>(m, HEADER_LEN));
    return;
  }
  crankAfterObservations(owner, m, markets, pa, rest, slot, obs, reclaim, st, cranker);
}

/** The hint loop's state: the observations made, the next oracle account, the resolution's maturity seen (0 none, 1
 * not matured, 2 matured), a matured settlement, a bounded catch-up, a market accrual. */
interface CrankState {
  count: u64;
  tail: u64;
  matured: u64;
  settlement: boolean;
  catchup: boolean;
  accrued: boolean;
}

function freshSelected(): Selected {
  return { b_stale: NONE, refresh: NONE, liquidatable: NONE, reset_obligation: NONE, released: NONE, mask: 0n };
}

/**
 * One hint: the asset configured and not hinted before (InvalidInstruction); its state decoded; an asset neither
 * Active nor DrainOnly skips its oracle accounts (NotEnoughAccountKeys) and is observed at its effective price. Else
 * the profile (validated) and its checkpoint at the asset's slot; the resolution's maturity, the same for every hint
 * (InvalidInstruction); a matured one takes no oracle account (OracleStale), an unmatured one exactly the profile's legs
 * (InvalidInstruction); the accounts there (NotEnoughAccountKeys). A matured resolution's terminal accrual: none
 * writes a changed profile (mirrored into the config for asset 0) and counts as an accrual; some accrues the asset to
 * it after storing the target. Otherwise the non-base and the asset's own stale windows (OracleStale), the target, the
 * canonical path to it, accrued. Then the catch-up flag, the checkpoint at the asset's new slot, the next funding rate;
 * whether anything moved (the slot, the stored target, the price, the funding anchor, the profile); asset 0's config
 * mirrored (price-managed) or its liveness raised; the penalty's reclaimability; the profile written (validated); the
 * observation.
 */
function observe(
  m: RemainingAccount,
  markets: u64,
  rest: RemainingAccounts,
  tailEnd: u64,
  asset: u64,
  accounts: u64,
  slot: u64,
  ts: i64,
  obs: Inout<FixedArray<Observation, 16>>,
  reclaim: Inout<FixedArray<u64, 16>>,
  st: Inout<CrankState>,
): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(asset < toU64(h.config.max_market_slots), PercolatorError.InvalidInstruction);
  for (let j = 0n; j < st.count; j++) require(obs.get(j).asset !== asset, PercolatorError.InvalidInstruction);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  checkV16(assetStateErr(e.asset));
  const life = e.asset.lifecycle;
  if (life !== LIFECYCLE_ACTIVE && life !== LIFECYCLE_DRAIN_ONLY) {
    require(tailEnd - st.tail >= accounts, ProgramError.NotEnoughAccountKeys);
    st.tail += accounts;
    const o = obs.get(st.count);
    o.asset = asset;
    o.price = e.asset.effective_price;
    o.rate = 0n;
    // No entry in the reclaimability list for this asset.
    reclaim.set(st.count, 0n);
    st.count += 1n;
    return;
  }
  const at = profileFromView(m, markets, asset);
  const p = loadRawMutAt<AssetOracleProfile>(m, at);
  const before = snap(p);
  const rawTargetBefore = e.asset.raw_oracle_target_price;
  const priceBefore = e.asset.effective_price;
  const anchorBefore = e.asset.fund_px_last;
  const slotBefore = e.asset.slot_last;
  advanceFundingMarkCheckpoint(m, at, slotBefore);
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const matured = resolveMatured(cfg, p, slot);
  if (st.matured !== 0n) require((st.matured === 2n) === matured, PercolatorError.InvalidInstruction);
  else st.matured = matured ? 2n : 1n;
  require(!(matured && accounts !== 0n), PercolatorError.OracleStale);
  require(matured || accounts === toU64(p.oracle_leg_count), PercolatorError.InvalidInstruction);
  require(tailEnd - st.tail >= accounts, ProgramError.NotEnoughAccountKeys);
  const first = st.tail;
  st.tail += accounts;
  let accrualSlot = slot;
  let price: u64 = 0n;
  if (matured) {
    const ra: ResolveAccrual = { some: false, slot: 0n, price: 0n, rate: 0n };
    resolveAccrual(m, markets, at, asset, slot, true, ra);
    if (!ra.some) {
      if (changedFrom(p, before)) {
        if (asset === 0n) mirrorProfileToConfig(m, at, true);
        validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
        st.accrued = true;
      }
      return;
    }
    st.settlement = true;
    accrualSlot = ra.slot;
    price = ra.price;
    setAssetRawOracleTarget(m, markets, asset, p.oracle_target_price_e6);
    accrueAssetTo(m, markets, asset, accrualSlot, price, ra.rate, true);
  } else {
    require(!(asset !== 0n && permissionlessStaleMatured(cfg, slot)), PercolatorError.OracleStale);
    // reject_permissionless_resolve_matured_live_for_profile_view.
    const hm = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
    require(!(hm.mode === MODE_LIVE_CK && resolveMatured(cfg, p, authenticatedMarketSlot(hm.current_slot))), PercolatorError.OracleStale);
    const t: Target = { price: 0n, slot: 0n };
    hybridTarget(m, at, asset, slot, ts, rest, first, accounts, t);
    const steps = fixedArray<AccrualStep, 32>({ price: 0n, rate: 0n, rem_before: 0n, rem_after: 0n });
    const n = canonicalPath(m, markets, p, asset, slot, t.price, t.slot, steps, true);
    price = n === 0n ? loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.effective_price : steps.get(n - 1n).price;
    accrueAssetPath(m, markets, asset, slot, p.oracle_target_price_e6, steps, n);
  }
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  if (a.slot_last < slot) st.catchup = true;
  advanceFundingMarkCheckpoint(m, at, a.slot_last);
  const rate = permissionlessFundingRate(m, markets, at, asset, accrualSlot, price);
  // read_oracle_profile_from_view(...)? != oracle_profile: the stored profile (validated) is the one before this turn.
  if (
    a.slot_last !== slotBefore ||
    a.raw_oracle_target_price !== rawTargetBefore ||
    a.effective_price !== priceBefore ||
    a.fund_px_last !== anchorBefore ||
    changedFrom(p, before)
  )
    st.accrued = true;
  if (asset === 0n) {
    if (isPriceManaged(p)) mirrorProfileToConfig(m, at, true);
    else {
      const w = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
      if (p.last_good_oracle_slot > w.last_good_oracle_slot) w.last_good_oracle_slot = p.last_good_oracle_slot;
    }
  }
  reclaim.set(st.count, reclaimable(p, slot) ? 2n : 1n);
  validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
  const o = obs.get(st.count);
  o.asset = asset;
  o.price = price;
  o.rate = rate;
  st.count += 1n;
}

/**
 * The zero-copy handler after the hints: the portfolio's view and key again; the summary at the slot; the maintenance
 * fee (`collect_maintenance_fee_before_value_debit_view` at the market's authenticated slot) and the summary again; the
 * health observations; the insurance and the positions before; the engine's crank; the checkpoints; the fee's
 * destination; the position epoch; the config validated.
 *
 * @noinline
 */
function crankAfterObservations(
  owner: RemainingAccount,
  m: RemainingAccount,
  markets: u64,
  pa: RemainingAccount,
  rest: RemainingAccounts,
  slot: u64,
  obs: FixedArray<Observation, 16>,
  reclaim: FixedArray<u64, 16>,
  st: Inout<CrankState>,
  cranker: boolean,
): void {
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  const s: Summary = { stale: false, b_stale: false, pending_close: false, expired_close: false, liquidatable: false, releasable: false, resolved_winner: false };
  buildSummary(m, markets, pa, slot, s, freshSelected());
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const rate = cfg.maintenance_fee_per_slot;
  const p0 = loadRawAt<Portfolio>(pa, HEADER_LEN);
  if (rate !== 0n && p0.active_bitmap.get(0n) !== 0n && p0.last_fee_slot < slot && !s.b_stale && !s.pending_close && !s.expired_close) {
    const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
    if (h.mode === MODE_LIVE_CK) creditMaintenanceFee(m, markets, syncAccountFeeToSlot(m, pa, markets, authenticatedMarketSlot(h.current_slot), rate));
    buildSummary(m, markets, pa, slot, s, freshSelected());
  }
  if ((s.stale || s.liquidatable) && !s.b_stale) rejectIncompleteAccount(m, markets, pa, slot, obs, st.count);
  const insuranceBefore = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).insurance;
  const before: Positions = { legs: fixedArray<u64, 16>(0n), basis: fixedArray<i128, 16>(0n) };
  const ids = fixedArray<u64, 16>(0n);
  positionsOf(pa, before);
  for (let i = 0n; i < V16_MAX_PORTFOLIO_ASSETS_N; i++) ids.set(i, loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(i).market_id);
  const r: AutoCrank = { plan: PLAN_NO_ACTION, asset: NONE, current: false, status: 0n, closed: false, payout: 0n };
  autoCrank(m, markets, pa, slot, obs, st.count, 0n, r);
  // The engine's result: None for a swallowed NonProgress or a NoAction after an accrual.
  let some = true;
  if (r.status === NONPROG || r.plan === PLAN_NO_ACTION) {
    require(st.accrued, PercolatorError.EngineNonProgress);
    some = false;
  }
  for (let i = 0n; i < st.count; i++) {
    const asset = obs.get(i).asset;
    const at = profileFromView(m, markets, asset);
    advanceFundingMarkCheckpoint(m, at, loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.slot_last);
    validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
  }
  let feeAsset = st.count === 0n ? 0n : obs.get(0n).asset;
  if (some && ((r.plan === PLAN_REFRESH && r.asset !== NONE) || r.plan === PLAN_SETTLE_B || r.plan === PLAN_LIQUIDATE)) feeAsset = r.asset;
  const completed = some && r.plan === PLAN_LIQUIDATE && r.current;
  const selectedLiquidation = some && r.plan === PLAN_LIQUIDATE;
  let penaltyReclaimable = false;
  if (selectedLiquidation) {
    let found = false;
    // The list holds the observed Active and DrainOnly assets (0: no entry, 1: not reclaimable, 2: reclaimable).
    for (let i = 0n; i < st.count && !found; i++)
      if (obs.get(i).asset === feeAsset && reclaim.get(i) !== 0n) {
        found = true;
        penaltyReclaimable = reclaim.get(i) === 2n;
      }
    if (!found) penaltyReclaimable = reclaimable(loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, feeAsset)), slot);
  }
  const changed = completed ? true : positionsChanged(pa, before, ids);
  const insurance = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).insurance;
  const retained = insurance > insuranceBefore ? insurance - insuranceBefore : 0n;
  let forDomains = retained;
  if (completed && penaltyReclaimable && cranker) {
    const cp = rest.get(rest.length - 1n);
    portfolioViewMut(cp);
    expectPortfolioAccountKey(cp);
    require(loadRawAt<Portfolio>(cp, HEADER_LEN).owner === owner.key, PercolatorError.Unauthorized);
    validateWithMarket(m, cp, markets);
    let reward = feeShareFloor(retained, toU128(loadRawAt<WrapperConfig>(m, HEADER_LEN).liquidation_cranker_fee_share_bps));
    if (reward > retained) reward = retained;
    if (reward !== 0n) creditAccountFromInsurance(m, cp, markets, reward);
    forDomains = retained - reward;
    validateWithMarket(m, cp, markets);
  }
  if (selectedLiquidation && !penaltyReclaimable) forDomains = 0n;
  creditFeeSplit(m, markets, feeAsset, forDomains);
  if (changed) {
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    bumpPositionEpoch(pa);
  }
  validateWrapperConfig(loadRawAt<WrapperConfig>(m, HEADER_LEN));
}

// ---- FinalizeResetSide (tag 45) ---------------------------------------------------------------------------------------------------

/**
 * `handle_finalize_reset_side(asset, side)`: the market writable and the program's; the side decoded (InvalidInstruction
 * above 1); the market view; the engine's `finalize_side_reset_not_atomic` (map_v16_error).
 *
 * @noinline
 */
export function finalizeResetSide(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 1n);
  const m = rest.get(0n);
  writableCheck(m);
  ownerCheck(m, programId);
  const side = data.readU8(3n);
  require(side <= 1n, PercolatorError.InvalidInstruction);
  const markets = marketViewMut(m);
  finalizeSideReset(m, markets, toU64(data.readU16(1n)), side === 1n);
}
