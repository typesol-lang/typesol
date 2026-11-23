// A port of Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog src/v16_program.rs,
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Changes: rewritten in TypeSOL. Ported here: the managed marks (`handle_configure_managed_mark` for ConfigureEwmaMark and
// ConfigureAuthMark, `handle_push_managed_mark` for PushEwmaMark and PushAuthMark, with `policy_v16::ewma_update`,
// `record_funding_mark_transition_view` and `advance_funding_mark_checkpoint_view`) and `handle_configure_hybrid_oracle`
// for ConfigureHybridOracle (its external reads in external.ts).
//
// The original reads the asset's oracle profile and the wrapper config into copies, changes them and writes them back
// after validating them (`write_oracle_profile_to_view`, `state::write_wrapper_config`). The port changes them in place:
// nothing between the change and the write-back reads the profile's or the config's bytes from the account, and every
// failure in between fails the transaction (NOTES.md, section 1). Where the original validates what it writes, the port
// validates the view after changing it, at the same point.
//
// Repeated accounts. Each handler takes two accounts, the signer and the market; the market's data is borrowed twice in
// sequence (the view, then the config's write-back), never twice at once, so a repeated pair reaches no borrow conflict:
// a signer passed as the market is refused by the market's owner or header check first. ConfigureHybridOracle also reads
// one oracle account per leg while it holds the market's data: the market passed as a leg fails that borrow
// (AccountBorrowFailed, external.ts compares the keys).
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type u8,
  type u64,
  currentSlot,
  loadRawAt,
  loadRawMutAt,
  now,
  require,
  u64 as toU64,
  u128 as toU128,
  zeroData,
} from "typesol";
import { PercolatorError, checkV16 } from "./errors.js";
import {
  type AssetOracleProfile,
  type EngineAssetSlot,
  type GroupHeader,
  type WrapperConfig,
  ASSET_ORACLE_PROFILE_LEN,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  MAX_ORACLE_PRICE,
  ORACLE_LEG_CAP,
  ORACLE_MODE_AUTH_MARK,
  ORACLE_MODE_EWMA_MARK,
  ORACLE_MODE_HYBRID_AFTER_HOURS,
  oracleLegFeedsOk,
  validateAssetOracleProfile,
  validateWrapperConfig,
} from "./state.js";
import { LIFECYCLE_ACTIVE, LIFECYCLE_DRAIN_ONLY, engineSlotAt, marketShapeErr, setAssetRawOracleTarget } from "./engine.js";
import { optionalRecoveryReasonErr } from "./wire.js";
import { type ExternalRead, failOracle, readExternalPriceProfile } from "./external.js";
import {
  LANE_ORACLE_OBSERVATION,
  advanceControlSequence,
  expectLiveAuthority,
  marketViewMut,
  needAccounts,
  ownerCheck,
  permissionlessStaleMatured,
  profileFromView,
  requireAssetGeneration,
  requireAuthorityEpoch,
  signerCheck,
  writableCheck,
} from "./program.js";

const U64_MAX_O = 0xffffffffffffffffn;

// ---- EWMA ---------------------------------------------------------------------------------------------------------------

/**
 * `policy_v16::ewma_update(old, price, halflife_slots, last_slot, now_slot, fee_paid, mark_min_fee)`: the mark moved
 * towards `price` by α = 10,000·dt / (dt + halflife) bps (scaled down when the fee paid is below the minimum fee).
 */
export function ewmaUpdate(old: u64, price: u64, halflife: u64, lastSlot: u64, nowSlot: u64, feePaid: u64, minFee: u64): u64 {
  if (old === 0n) {
    if (minFee > 0n && feePaid < minFee) return 0n;
    return price;
  }
  const dt = nowSlot > lastSlot ? nowSlot - lastSlot : 0n;
  if (dt === 0n) return old;
  if (halflife === 0n) return price;
  if (feePaid === 0n && minFee > 0n) return old;
  const dtw = toU128(dt);
  let alpha = (10000n * dtw) / (dtw + toU128(halflife));
  // ewma_effective_alpha_bps: α · fee / min (α ≤ 10,000 and the fee a u64: the saturating product cannot saturate).
  if (!(minFee === 0n || feePaid >= minFee)) alpha = (alpha * toU128(feePaid)) / toU128(minFee);
  const o = toU128(old);
  const p = toU128(price);
  const out = price >= old ? o + ((p - o) * alpha) / 10000n : o - ((o - p) * alpha) / 10000n;
  return out > U64_MAX_O ? U64_MAX_O : toU64(out);
}

// ---- Funding mark transitions ------------------------------------------------------------------------------------------

/** `advance_funding_mark_checkpoint_view`: the pending funding mark activated once the asset has accrued to its slot. */
export function advanceFundingMarkCheckpoint(m: RemainingAccount, at: u64, assetSlot: u64): void {
  const p = loadRawMutAt<AssetOracleProfile>(m, at);
  if (p.funding_mark_e6 === 0n && p.mark_ewma_last_slot <= assetSlot) p.funding_mark_e6 = p.mark_ewma_e6;
  if (p.funding_mark_pending_e6 !== 0n && p.funding_mark_pending_slot <= assetSlot) {
    const activated = p.funding_mark_pending_slot;
    p.funding_mark_e6 = p.funding_mark_pending_e6;
    p.funding_mark_pending_e6 = 0n;
    p.funding_mark_pending_slot = 0n;
    if (p.mark_ewma_last_slot > activated) {
      if (p.mark_ewma_last_slot <= assetSlot) p.funding_mark_e6 = p.mark_ewma_e6;
      else {
        p.funding_mark_pending_e6 = p.mark_ewma_e6;
        p.funding_mark_pending_slot = p.mark_ewma_last_slot;
      }
    }
  }
}

/**
 * `record_funding_mark_transition_view(profile, asset_slot, next_mark, mark_slot)`: the checkpoint first; then a mark
 * at or before the asset's slot becomes the funding mark, a later one is pending (the first pending boundary is kept;
 * a pending mark at the same slot is replaced; an earlier slot than the pending one is EngineStale).
 */
export function recordFundingMarkTransition(m: RemainingAccount, at: u64, assetSlot: u64, nextMark: u64, markSlot: u64): void {
  advanceFundingMarkCheckpoint(m, at, assetSlot);
  const p = loadRawMutAt<AssetOracleProfile>(m, at);
  if (p.funding_mark_e6 === 0n) return;
  if (p.funding_mark_pending_e6 !== 0n) {
    require(markSlot >= p.funding_mark_pending_slot, PercolatorError.EngineStale);
    if (markSlot === p.funding_mark_pending_slot) p.funding_mark_pending_e6 = nextMark;
    return;
  }
  if (markSlot <= assetSlot) p.funding_mark_e6 = nextMark;
  else {
    p.funding_mark_pending_e6 = nextMark;
    p.funding_mark_pending_slot = markSlot;
  }
}

// ---- Shared checks -----------------------------------------------------------------------------------------------------

/** `reject_non_base_oracle_update_after_global_resolve_matured`: an asset other than 0 once the stale window matured. */
export function rejectNonBaseAfterStale(m: RemainingAccount, asset: u64, slot: u64): void {
  if (asset === 0n) return;
  require(!permissionlessStaleMatured(loadRawAt<WrapperConfig>(m, HEADER_LEN), slot), PercolatorError.OracleStale);
}

/** `asset_local_has_position_or_loss_state_view` (true past the configured assets or the view). */
export function assetHasPositionOrLossState(m: RemainingAccount, markets: u64, asset: u64): boolean {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) return true;
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const a = e.asset;
  return (
    a.oi_eff_long_q !== 0n ||
    a.oi_eff_short_q !== 0n ||
    a.stored_pos_count_long !== 0n ||
    a.stored_pos_count_short !== 0n ||
    a.stale_account_count_long !== 0n ||
    a.stale_account_count_short !== 0n ||
    a.b_long_num !== 0n ||
    a.b_short_num !== 0n ||
    a.b_epoch_start_long_num !== 0n ||
    a.b_epoch_start_short_num !== 0n ||
    a.loss_weight_sum_long !== 0n ||
    a.loss_weight_sum_short !== 0n ||
    a.social_loss_remainder_long_num !== 0n ||
    a.social_loss_remainder_short_num !== 0n ||
    a.social_loss_dust_long_num !== 0n ||
    a.social_loss_dust_short_num !== 0n ||
    a.explicit_unallocated_loss_long !== 0n ||
    a.explicit_unallocated_loss_short !== 0n ||
    a.mode_long !== 0n ||
    a.mode_short !== 0n ||
    e.pending_domain_loss_barrier_long !== 0n ||
    e.pending_domain_loss_barrier_short !== 0n
  );
}

/**
 * `require_asset_active_for_oracle_reconfiguration_view`: the asset in the view and Active, with no position or loss
 * state, no bankruptcy h-lock, no threshold stress and no recovery reason (its decoding through map_v16_error); for
 * asset 0 (mirrored into the base config) the whole market quiet. EngineLockActive otherwise.
 */
export function requireAssetActiveForReconfiguration(m: RemainingAccount, markets: u64, asset: u64): void {
  require(asset < markets, PercolatorError.EngineLockActive);
  require(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle === LIFECYCLE_ACTIVE, PercolatorError.EngineLockActive);
  require(!assetHasPositionOrLossState(m, markets, asset), PercolatorError.EngineLockActive);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.bankruptcy_hlock_active === 0n && h.threshold_stress_active === 0n, PercolatorError.EngineLockActive);
  // recovery_reason.try_to_runtime().map_err(map_v16_error)?.is_some().
  checkV16(optionalRecoveryReasonErr(h.recovery_reason));
  require(h.recovery_reason.present === 0n, PercolatorError.EngineLockActive);
  if (asset === 0n)
    require(
      h.pnl_pos_tot === 0n && h.stale_certificate_count === 0n && h.b_stale_account_count === 0n && h.negative_pnl_account_count === 0n && h.loss_stale_active === 0n,
      PercolatorError.EngineLockActive,
    );
}

/**
 * `mirror_oracle_profile_to_base_config(cfg, profile, refresh_liveness)`: asset 0's oracle fields copied into the
 * wrapper config (the liveness slot only raised, and only when asked).
 */
export function mirrorProfileToConfig(m: RemainingAccount, at: u64, refreshLiveness: boolean): void {
  const p = loadRawAt<AssetOracleProfile>(m, at);
  const c = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  c.oracle_mode = p.oracle_mode;
  c.oracle_leg_count = p.oracle_leg_count;
  c.oracle_leg_flags = p.oracle_leg_flags;
  c.invert = p.invert;
  c.unit_scale = p.unit_scale;
  c.conf_filter_bps = p.conf_filter_bps;
  c.max_staleness_secs = p.max_staleness_secs;
  c.hybrid_soft_stale_slots = p.hybrid_soft_stale_slots;
  c.mark_ewma_e6 = p.mark_ewma_e6;
  c.mark_ewma_last_slot = p.mark_ewma_last_slot;
  c.mark_ewma_halflife_slots = p.mark_ewma_halflife_slots;
  c.mark_min_fee = p.mark_min_fee;
  c.oracle_target_price_e6 = p.oracle_target_price_e6;
  c.oracle_target_publish_time = p.oracle_target_publish_time;
  if (refreshLiveness && p.last_good_oracle_slot > c.last_good_oracle_slot) c.last_good_oracle_slot = p.last_good_oracle_slot;
  for (let i = 0n; i < 3n; i++) {
    c.oracle_leg_feeds.set(i, p.oracle_leg_feeds.get(i));
    c.oracle_leg_prices_e6.set(i, p.oracle_leg_prices_e6.get(i));
    c.oracle_leg_publish_times.set(i, p.oracle_leg_publish_times.get(i));
  }
}

/**
 * `reset_empty_asset_oracle_anchor_view(group, asset, price, slot)` where its checks hold (each caller made them: the
 * asset configured and in the view, Live, the price valid, the Clock not behind the market; its repeat of the
 * quiet-asset check sees what passed before, only the control sequences having changed since): the asset's oracle
 * anchor and the market's clock at the slot.
 */
function resetEmptyAssetOracleAnchor(m: RemainingAccount, asset: u64, price: u64, slot: u64): void {
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  e.asset.raw_oracle_target_price = price;
  e.asset.effective_price = price;
  e.asset.fund_px_last = price;
  e.asset.slot_last = slot;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  h.current_slot = slot;
  h.slot_last = slot;
}

/**
 * A new profile (`AssetOracleProfileV16 { … }`) of `mode` at `at`: the backing-fee policy and the five authorities kept,
 * every other field zero (the effective-price provenance Authenticated, 0).
 */
function rebuildProfile(m: RemainingAccount, at: u64, mode: u8): void {
  const p = loadRawAt<AssetOracleProfile>(m, at);
  const feeLong = p.backing_trade_fee_bps_long;
  const feeShort = p.backing_trade_fee_bps_short;
  const shareLong = p.backing_trade_fee_insurance_share_bps_long;
  const shareShort = p.backing_trade_fee_insurance_share_bps_short;
  const insuranceAuthority = p.insurance_authority;
  const insuranceOperator = p.insurance_operator;
  const assetAdmin = p.asset_admin;
  const backingAuthority = p.backing_bucket_authority;
  const oracleAuthority = p.oracle_authority;
  zeroData(m, at, ASSET_ORACLE_PROFILE_LEN);
  const n = loadRawMutAt<AssetOracleProfile>(m, at);
  n.oracle_mode = mode;
  n.backing_trade_fee_bps_long = feeLong;
  n.backing_trade_fee_bps_short = feeShort;
  n.backing_trade_fee_insurance_share_bps_long = shareLong;
  n.backing_trade_fee_insurance_share_bps_short = shareShort;
  n.insurance_authority = insuranceAuthority;
  n.insurance_operator = insuranceOperator;
  n.asset_admin = assetAdmin;
  n.backing_bucket_authority = backingAuthority;
  n.oracle_authority = oracleAuthority;
}

// ---- ConfigureEwmaMark (tag 35), ConfigureAuthMark (tag 62) ---------------------------------------------------------------

/**
 * `handle_configure_managed_mark(kind, asset_index, market_id, now_slot, initial_mark_e6, mark_ewma_halflife_slots,
 * mark_min_fee, observation_sequence, authority_epoch)`: accounts authority (signer), market (w). The initial mark a
 * valid price and (EWMA) a nonzero half-life (InvalidInstruction); under the market view: the asset configured and of
 * the expected generation, the Clock not behind the market (EngineStale), Live, not an asset other than 0 after the
 * stale window matured, the asset Active and quiet; its oracle authority signs; its authority epoch; the observation
 * sequence advances; the asset's oracle anchor reset to the mark at the Clock's slot, the profile rewritten in the
 * managed mode (keeping the backing-fee policy and the authorities), mirrored into the config for asset 0; the
 * market's shape. ConfigureAuthMark passes a half-life and minimum fee of 0.
 *
 * @noinline
 */
export function configureManagedMark(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey, ewma: boolean): void {
  needAccounts(rest, 2n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(authority);
  writableCheck(m);
  ownerCheck(m, programId);
  const asset = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const mark = data.readU64(19n);
  const halflife = ewma ? data.readU64(27n) : 0n;
  const minFee = ewma ? data.readU64(35n) : 0n;
  const sequence = data.readU64(ewma ? 43n : 27n);
  const expectedEpoch = data.readU64(ewma ? 51n : 35n);
  require(mark !== 0n && mark <= MAX_ORACLE_PRICE, PercolatorError.InvalidInstruction);
  // ManagedMarkKind::configuration_fields.
  require(!(ewma && halflife === 0n), PercolatorError.InvalidInstruction);
  // authenticated_slot_or_fallback: the Clock's slot.
  const slot = currentSlot();
  const markets = marketViewMut(m);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(asset < toU64(h.config.max_market_slots), PercolatorError.InvalidInstruction);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  require(slot >= h.current_slot, PercolatorError.EngineStale);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  rejectNonBaseAfterStale(m, asset, slot);
  requireAssetActiveForReconfiguration(m, markets, asset);
  const at = profileFromView(m, markets, asset);
  expectLiveAuthority(loadRawAt<AssetOracleProfile>(m, at).oracle_authority, authority.key);
  requireAuthorityEpoch(m, markets, asset, expectedEpoch);
  advanceControlSequence(m, markets, asset, LANE_ORACLE_OBSERVATION, sequence);
  resetEmptyAssetOracleAnchor(m, asset, mark, slot);
  rebuildProfile(m, at, ewma ? ORACLE_MODE_EWMA_MARK : ORACLE_MODE_AUTH_MARK);
  const n = loadRawMutAt<AssetOracleProfile>(m, at);
  n.mark_ewma_e6 = mark;
  n.mark_ewma_last_slot = slot;
  n.mark_ewma_halflife_slots = halflife;
  n.mark_min_fee = minFee;
  n.oracle_target_price_e6 = mark;
  n.last_good_oracle_slot = slot;
  n.funding_mark_e6 = mark;
  // write_oracle_profile_to_view validates the new profile: it holds (a managed mode with no legs, a valid mark as
  // mark, target and funding mark, the half-life nonzero for EWMA and zero for AuthMark, the kept policy valid).
  if (asset === 0n) mirrorProfileToConfig(m, at, true);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  // state::write_wrapper_config validates the config: unchanged for another asset; for asset 0 its oracle fields are
  // the valid profile's (the same mode rules).
}

// ---- ConfigureHybridOracle (tag 34) ----------------------------------------------------------------------------------------

/**
 * `handle_configure_hybrid_oracle(asset_index, market_id, now_slot, now_unix_ts, oracle_leg_count, oracle_leg_flags,
 * max_staleness_secs, hybrid_soft_stale_slots, mark_ewma_halflife_slots, mark_min_fee, invert, unit_scale,
 * conf_filter_bps, oracle_leg_feeds, observation_sequence, authority_epoch)`: accounts admin (signer), market (w), then
 * one oracle account per leg. The leg configuration (1 to 3 legs, the divide flags, distinct nonzero feeds), a nonzero
 * staleness and soft-stale window and invert 0 or 1 (InvalidInstruction); the oracle accounts (NotEnoughAccountKeys);
 * under the market view the checks of ConfigureEwmaMark (the asset, its generation, the Clock, Live, the stale window,
 * the asset Active and quiet, its oracle authority, its epoch, the observation sequence); then a hybrid profile with
 * the given fields (keeping the backing-fee policy and the authorities) whose legs are read at the Clock's unix time
 * (external.ts: each leg's errors, the publish times equal, the composite) and must advance (OracleInvalid otherwise:
 * a publish time of 0 or below); the mark, the EWMA mark, the funding mark and the target at the composite price, the
 * liveness at the Clock's slot; the asset's anchor reset to the price; the profile validated (InvalidAccountData: a
 * half-life of 0, a confidence filter above 10,000 bps), mirrored into the config for asset 0; the market's shape.
 * `now_slot` and `now_unix_ts` are fallbacks for a missing Clock, which the runtime always provides.
 *
 * @noinline
 */
export function configureHybridOracle(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 2n);
  const admin = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(admin);
  writableCheck(m);
  ownerCheck(m, programId);
  const count = data.readU8(27n);
  const flags = data.readU8(28n);
  const maxStaleness = data.readU64(29n);
  const softStale = data.readU64(37n);
  const invert = data.readU8(61n);
  const f0 = data.readPubkey(68n);
  const f1 = data.readPubkey(100n);
  const f2 = data.readPubkey(132n);
  require(
    !(count === 0n || count > ORACLE_LEG_CAP || !oracleLegFeedsOk(count, flags, f0, f1, f2) || maxStaleness === 0n || softStale === 0n || invert > 1n),
    PercolatorError.InvalidInstruction,
  );
  needAccounts(rest, 2n + toU64(count));
  const asset = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const slot = currentSlot();
  const unixTs = now();
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(asset < toU64(h.config.max_market_slots), PercolatorError.InvalidInstruction);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  require(slot >= h.current_slot, PercolatorError.EngineStale);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  rejectNonBaseAfterStale(m, asset, slot);
  requireAssetActiveForReconfiguration(m, markets, asset);
  const at = profileFromView(m, markets, asset);
  expectLiveAuthority(loadRawAt<AssetOracleProfile>(m, at).oracle_authority, admin.key);
  requireAuthorityEpoch(m, markets, asset, data.readU64(172n));
  advanceControlSequence(m, markets, asset, LANE_ORACLE_OBSERVATION, data.readU64(164n));
  // The new profile: a copy in the original, read into before anything is written back; nothing between here and the
  // write-back reads the profile's bytes from the account, so it is built in place.
  rebuildProfile(m, at, ORACLE_MODE_HYBRID_AFTER_HOURS);
  const n = loadRawMutAt<AssetOracleProfile>(m, at);
  n.oracle_leg_count = count;
  n.oracle_leg_flags = flags;
  n.invert = invert;
  n.unit_scale = data.readU32(62n);
  n.conf_filter_bps = data.readU16(66n);
  n.max_staleness_secs = maxStaleness;
  n.hybrid_soft_stale_slots = softStale;
  n.mark_ewma_halflife_slots = data.readU64(45n);
  n.mark_min_fee = data.readU64(53n);
  n.oracle_leg_feeds.set(0n, f0);
  n.oracle_leg_feeds.set(1n, f1);
  n.oracle_leg_feeds.set(2n, f2);
  // oracle_v16::read_external_price_e6_profile on the new profile (its legs' stored observations all zero), the market's
  // data held.
  const read: ExternalRead = { price: 0n, publish_time: 0n, advanced: 0n };
  failOracle(readExternalPriceProfile(m, at, rest, 2n, toU64(count), m.key, unixTs, read));
  require(read.advanced !== 0n && read.price !== 0n, PercolatorError.OracleInvalid);
  n.last_good_oracle_slot = slot;
  n.oracle_target_price_e6 = read.price;
  n.oracle_target_publish_time = read.publish_time;
  n.mark_ewma_e6 = read.price;
  n.mark_ewma_last_slot = slot;
  n.funding_mark_e6 = read.price;
  resetEmptyAssetOracleAnchor(m, asset, read.price, slot);
  // write_oracle_profile_to_view validates the new profile.
  validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
  if (asset === 0n) mirrorProfileToConfig(m, at, true);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  // state::write_wrapper_config validates the config: unchanged for another asset; for asset 0 its oracle fields are
  // the valid profile's (the hybrid rules of the config are a subset of the profile's).
}

// ---- PushEwmaMark (tag 36), PushAuthMark (tag 63) -------------------------------------------------------------------------

/**
 * `handle_push_managed_mark(kind, asset_index, market_id, now_slot, mark_e6, observation_sequence, authority_epoch)`:
 * accounts authority (signer), market (w). The mark a valid price (OracleInvalid); under the market view: the asset
 * configured and of the expected generation, its profile, Live, not an asset other than 0 after the stale window
 * matured, the asset Active or DrainOnly, the profile of the instruction's mode (Unauthorized), its oracle authority
 * signs, its authority epoch, the Clock not behind the mark or the market (EngineStale); the observation sequence
 * advances; the next mark (EWMA: moved towards the pushed one; AuthMark: the pushed one) recorded as a funding-mark
 * transition when it changes, the target and liveness set, the price-move remainder reset when the target changes, the
 * engine's raw target set; the profile validated and, for asset 0, mirrored into the config.
 *
 * @noinline
 */
export function pushManagedMark(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey, ewma: boolean): void {
  needAccounts(rest, 2n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(authority);
  writableCheck(m);
  ownerCheck(m, programId);
  const asset = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const pushed = data.readU64(19n);
  const sequence = data.readU64(27n);
  const expectedEpoch = data.readU64(35n);
  require(pushed !== 0n && pushed <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  const slot = currentSlot();
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(asset < toU64(h.config.max_market_slots), PercolatorError.InvalidInstruction);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  const at = profileFromView(m, markets, asset);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  rejectNonBaseAfterStale(m, asset, slot);
  // require_asset_mark_pushable_view.
  require(asset < markets, PercolatorError.EngineLockActive);
  const life = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle;
  require(life === LIFECYCLE_ACTIVE || life === LIFECYCLE_DRAIN_ONLY, PercolatorError.EngineLockActive);
  const p = loadRawMutAt<AssetOracleProfile>(m, at);
  // ManagedMarkKind::accepts.
  require(p.oracle_mode === (ewma ? ORACLE_MODE_EWMA_MARK : ORACLE_MODE_AUTH_MARK), PercolatorError.Unauthorized);
  // domain_authorities_from_profile: the profile's oracle authority.
  expectLiveAuthority(p.oracle_authority, authority.key);
  requireAuthorityEpoch(m, markets, asset, expectedEpoch);
  require(slot >= p.mark_ewma_last_slot && slot >= h.current_slot, PercolatorError.EngineStale);
  advanceControlSequence(m, markets, asset, LANE_ORACLE_OBSERVATION, sequence);
  // ManagedMarkKind::next_mark (the fee paid is the minimum fee itself, as the original passes it).
  const next = ewma ? ewmaUpdate(p.mark_ewma_e6, pushed, p.mark_ewma_halflife_slots, p.mark_ewma_last_slot, slot, p.mark_min_fee, p.mark_min_fee) : pushed;
  require(next !== 0n && next <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  if (next !== p.mark_ewma_e6) {
    recordFundingMarkTransition(m, at, loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.slot_last, next, slot);
    p.mark_ewma_e6 = next;
    p.mark_ewma_last_slot = slot;
  }
  p.oracle_target_price_e6 = next;
  p.oracle_target_publish_time = 0n;
  p.last_good_oracle_slot = slot;
  // reset_price_move_remainder_on_target_change_view (the asset is in the view): set_price_move_remainder_bps_num(0).
  if (loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.raw_oracle_target_price !== next) p.price_move_remainder_bps_num = 0n;
  setAssetRawOracleTarget(m, markets, asset, next);
  // write_oracle_profile_to_view validates the profile written back.
  validateAssetOracleProfile(p);
  if (asset === 0n) {
    mirrorProfileToConfig(m, at, true);
    // state::write_wrapper_config validates the config.
    validateWrapperConfig(loadRawAt<WrapperConfig>(m, HEADER_LEN));
  }
}
