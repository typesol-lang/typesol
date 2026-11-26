// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs and
// aeyakovenko/percolator src/v16.rs, Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL. Ported here: the asset lifecycle
// (`handle_update_asset_lifecycle`: activation by appending a slot, with the market's realloc, or of an existing
// disabled or retired slot; drain-only; retirement; shutdown into recovery), `handle_restart_asset_oracle` and
// `handle_canonicalize_spent_backing_history`, with the engine code they reach: `grow_asset_slot_capacity_not_atomic`,
// `activate_empty_market_slot_not_atomic`, `mark_asset_drain_only_not_atomic`, `retire_empty_asset_not_atomic` (with
// `normalize_terminal_empty_asset_history_not_atomic` and `require_empty_asset_lifecycle_state_with_policy`),
// `force_asset_recovery_not_atomic`, `restart_empty_asset_preserving_insurance_budget_not_atomic`,
// `canonicalize_spent_backing_history_not_atomic`, and the asset-state, source-credit and backing-bucket setters with
// their aggregate totals.
//
// A permissionless activation's fee goes into market 0's insurance (`deposit_market_zero_insurance_view`: half into
// asset 0's long domain, the rest into its short one, through `deposit_domain_insurance_not_atomic`), then the SPL Token
// Transfer from the signer's account to the vault. A retirement that finds a Fresh backing bucket whose expiry slot has
// passed expires it first (`expire_source_backing_bucket_not_atomic`, primitives.ts); a Fresh bucket is made only by
// TopUpBackingBucket, not ported yet, so that path is compared on buckets written into the market.
//
// The original copies the group header and the slot (`activate_dynamic_asset_slot`), the wrapper config and the
// oracle profile, changes the copies and writes them back; every failure in between fails the transaction, so the
// port changes them in place (NOTES.md, section 1). The engine's setters that the original calls with a value it built
// (`set_asset_state`, `set_source_credit_for_domain`, `set_backing_bucket_for_domain`) write the same bytes in place,
// and their aggregate totals are kept as the original keeps them.
//
// Repeated accounts. The market's data is borrowed once at a time (the preflights, the realloc, the view, the config's
// write-back), so repeated accounts reach no borrow conflict; the token accounts of a permissionless activation are
// checked by owner and kind before any of their data is read.
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenProgram,
  type u8,
  type u16,
  type u64,
  type u128,
  ProgramError,
  currentSlot,
  loadRawAt,
  loadRawMutAt,
  programAt,
  readData,
  require,
  resizeAccount,
  u32 as toU32,
  u64 as toU64,
  u128 as toU128,
  zeroData,
} from "typesol";
import {
  PercolatorError,
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_NON_PROGRESS,
  V16_OK,
  V16_STALE,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type AssetControlSequences,
  type AssetOracleProfile,
  type BackingBucket,
  type EngineAssetSlot,
  type GroupHeader,
  type InsuranceCreditReservation,
  type SourceCreditState,
  type WrapperConfig,
  ASSET_ORACLE_PROFILE_LEN,
  DEFAULT_MARK_EWMA_HALFLIFE_SLOTS,
  ENGINE_ASSET_SLOT_LEN,
  HEADER_LEN,
  KIND_MARKET,
  MARKET_GROUP_OFF,
  MAX_ORACLE_PRICE,
  ZERO_KEY,
  assetSlotAt,
  checkHeader,
  marketAccountLenForCapacity,
  marketHeaderAt,
  readAssetOracleProfileAt,
  validateAssetOracleProfile,
  validateMarketDynamicLen,
  validateWrapperConfig,
  wrapperConfigAt,
} from "./state.js";
import { ADL_ONE, assetStateErr, backingBucketErr, configShapeErr, insuranceReservationErr, marketModeErr } from "./wire.js";
import {
  CREDIT_RATE_SCALE,
  LIFECYCLE_ACTIVE,
  LIFECYCLE_DRAIN_ONLY,
  LIFECYCLE_RECOVERY,
  LIFECYCLE_RETIRED,
  MAX_VAULT_TVL,
  blockersAfter,
  blockersBefore,
  configFullErr,
  engineSlotAt,
  marketShapeErr,
  sourceCreditEmpty,
  sourceCreditErr,
  sourceCreditShapeErr,
} from "./engine.js";
import { accrueCommittedFundingBeforeShutdown } from "./accrual.js";
import { expireSourceBackingBucket } from "./primitives.js";
import {
  amountToU64,
  expectLiveAuthority,
  liveAuthorityMatches,
  marketViewMut,
  needAccounts,
  ownerCheck,
  permissionlessStaleMatured,
  profileFromView,
  requireAssetGeneration,
  requireAuthorityEpoch,
  signerCheck,
  advanceControlSequence,
  LANE_ORACLE_OBSERVATION,
  vaultAuthorityOf,
  verifyTokenProgramV16,
  verifyUserTokenAccount,
  verifyVaultTokenAccount,
  writableCheck,
} from "./program.js";

const U64_MAX_L = 0xffffffffffffffffn;
const U128_MAX_L = 0xffffffffffffffffffffffffffffffffn;

/** UpdateAssetLifecycle's actions (`ASSET_ACTION_*`). */
const ACTION_ACTIVATE = 0n;
const ACTION_DRAIN_ONLY = 1n;
const ACTION_RETIRE = 2n;
const ACTION_SHUTDOWN = 3n;
/** AssetLifecycleV16::Disabled. */
const LIFECYCLE_DISABLED = 0n;

// ---- Asset state and its aggregate (V16 engine) ---------------------------------------------------------------------

/** `validate_configured_asset_index`: InvalidLeg past the configured assets or the view. */
export function configuredAssetIndex(m: RemainingAccount, markets: u64, asset: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
}

/** `asset_state(i)` (the index checked by the caller): the asset decoded (map_v16_error at every caller). */
function assetStateChecked(m: RemainingAccount, asset: u64): void {
  checkV16(assetStateErr(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset));
}

/** `checked_asset_set_epoch_bump`: both epochs below u64::MAX (CounterOverflow). */
function epochBumpCheck(h: GroupHeader): void {
  if (h.asset_set_epoch === U64_MAX_L || h.risk_epoch === U64_MAX_L) failV16(V16_COUNTER_OVERFLOW);
}

/**
 * `EngineAssetSlotV16Account::empty_for_market(market_id)` with `AssetStateV16::default()` (Active, every price 1,
 * a_long = a_short = ADL_ONE) and that market id: written over slot `asset`'s engine part.
 */
function writeEmptySlot(m: RemainingAccount, asset: u64, marketId: u64): void {
  const at = engineSlotAt(asset);
  zeroData(m, at, ENGINE_ASSET_SLOT_LEN);
  const e = loadRawMutAt<EngineAssetSlot>(m, at);
  e.asset.market_id = marketId;
  e.asset.lifecycle = LIFECYCLE_ACTIVE;
  e.asset.raw_oracle_target_price = 1n;
  e.asset.effective_price = 1n;
  e.asset.fund_px_last = 1n;
  e.asset.a_long = ADL_ONE;
  e.asset.a_short = ADL_ONE;
  e.source_credit_long.credit_rate_num = CREDIT_RATE_SCALE;
  e.source_credit_short.credit_rate_num = CREDIT_RATE_SCALE;
  e.backing_long.market_id = marketId;
  e.backing_short.market_id = marketId;
}

// ---- Domains -------------------------------------------------------------------------------------------------------------

/** `insurance_domain_index(asset, side)` and `domain_asset_side`: InvalidLeg past the configured assets or the view. */
function domainIndex(m: RemainingAccount, markets: u64, asset: u64, short: boolean): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (asset >= toU64(h.config.max_market_slots)) failV16(V16_INVALID_LEG);
  const domain = 2n * asset + (short ? 1n : 0n);
  if (domain >= 2n * toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  return domain;
}

/** `BackingBucketV16::is_empty_amount_shape`. */
function bucketEmptyAmounts(b: BackingBucket): boolean {
  return (
    b.fresh_unliened_backing_num === 0n &&
    b.valid_liened_backing_num === 0n &&
    b.consumed_liened_backing_num === 0n &&
    b.impaired_liened_backing_num === 0n &&
    b.utilization_fee_earnings === 0n &&
    b.expiry_slot === 0n &&
    b.status === 0n
  );
}

/** `SourceCreditStateV16::is_empty_amount_shape` (`terminalSpent`: `is_terminal_spent_audit_only_shape`, spent allowed). */
function sourceEmptyAmounts(s: SourceCreditState, terminalSpent: boolean): boolean {
  return (
    s.positive_claim_bound_num === 0n &&
    s.exact_positive_claim_num === 0n &&
    s.fresh_reserved_backing_num === 0n &&
    (terminalSpent || s.spent_backing_num === 0n) &&
    s.provider_receivable_num === 0n &&
    s.valid_liened_backing_num === 0n &&
    s.impaired_liened_backing_num === 0n &&
    s.insurance_credit_reserved_num === 0n &&
    s.valid_liened_insurance_num === 0n &&
    s.impaired_liened_insurance_num === 0n &&
    (s.credit_rate_num === 0n || s.credit_rate_num === CREDIT_RATE_SCALE)
  );
}

/** `InsuranceCreditReservationV16::EMPTY`. */
function reservationEmpty(r: InsuranceCreditReservation): boolean {
  return (
    r.insurance_credit_reserved_num === 0n &&
    r.valid_liened_insurance_num === 0n &&
    r.impaired_liened_insurance_num === 0n &&
    r.consumed_insurance_num === 0n &&
    r.source_credit_epoch === 0n
  );
}

/**
 * `set_source_credit_for_domain(domain, SourceCreditStateV16::EMPTY)` where the old state has no claim bound, no fresh
 * backing and no insurance reserved (every caller proved it): the aggregate totals move by zero
 * (`update_source_credit_aggregate_totals`), the old state's shape is checked again (it passed), the slot takes EMPTY.
 */
function setSourceCreditEmpty(m: RemainingAccount, asset: u64, short: boolean): void {
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  if (short) {
    zeroData(m, engineSlotAt(asset) + SOURCE_SHORT_OFF, SOURCE_CREDIT_LEN);
    e.source_credit_short.credit_rate_num = CREDIT_RATE_SCALE;
  } else {
    zeroData(m, engineSlotAt(asset) + SOURCE_LONG_OFF, SOURCE_CREDIT_LEN);
    e.source_credit_long.credit_rate_num = CREDIT_RATE_SCALE;
  }
}
/** Offsets in EngineAssetSlotV16Account: the asset (515), four u128 budgets and two u64 barriers (80), then the credits. */
const SOURCE_LONG_OFF = 595n;
const SOURCE_CREDIT_LEN = 184n;
const SOURCE_SHORT_OFF = 779n;
const BACKING_LONG_OFF = 963n;
const BACKING_LEN = 97n;
const BACKING_SHORT_OFF = 1060n;

/**
 * `set_backing_bucket_for_domain(domain, BackingBucketV16::empty_for_market(market_id))`: the old bucket decoded
 * (map_v16_error), the earnings total moved by −earnings (`update_backing_aggregate_totals`: CounterUnderflow), the
 * slot's bucket replaced.
 */
function setBucketEmpty(m: RemainingAccount, asset: u64, short: boolean, marketId: u64): void {
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const b = short ? e.backing_short : e.backing_long;
  checkV16(backingBucketErr(b));
  const earnings = b.utilization_fee_earnings;
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.backing_provider_earnings_total < earnings) failV16(V16_COUNTER_UNDERFLOW);
  h.backing_provider_earnings_total -= earnings;
  zeroData(m, engineSlotAt(asset) + (short ? BACKING_SHORT_OFF : BACKING_LONG_OFF), BACKING_LEN);
  const w = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  if (short) w.backing_short.market_id = marketId;
  else w.backing_long.market_id = marketId;
}

// ---- Empty assets ---------------------------------------------------------------------------------------------------------

/**
 * `require_empty_asset_lifecycle_state_with_policy(asset, true, true, true, true)` (every caller passes four trues):
 * the asset, both buckets, both source states' shapes and both reservations decoded in that order (map_v16_error),
 * then no barrier, no side mode, the A shape, no B, OI, positions, stale or pending counts, loss weights, spent budget
 * other than a fully spent one, only spent source history, empty buckets of the asset's market id and empty
 * reservations (LockActive).
 */
function requireEmptyAssetLifecycle(m: RemainingAccount, markets: u64, asset: u64): void {
  configuredAssetIndex(m, markets, asset);
  assetStateChecked(m, asset);
  domainIndex(m, markets, asset, false);
  domainIndex(m, markets, asset, true);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  checkV16(backingBucketErr(e.backing_long));
  checkV16(backingBucketErr(e.backing_short));
  checkV16(sourceCreditShapeErr(e.source_credit_long));
  checkV16(sourceCreditShapeErr(e.source_credit_short));
  checkV16(insuranceReservationErr(e.insurance_reservation_long));
  checkV16(insuranceReservationErr(e.insurance_reservation_short));
  const a = e.asset;
  const spentBlocks =
    (e.insurance_domain_spent_long !== 0n && e.insurance_domain_budget_long !== e.insurance_domain_spent_long) ||
    (e.insurance_domain_spent_short !== 0n && e.insurance_domain_budget_short !== e.insurance_domain_spent_short);
  if (
    e.pending_domain_loss_barrier_long !== 0n ||
    e.pending_domain_loss_barrier_short !== 0n ||
    a.mode_long !== 0n ||
    a.mode_short !== 0n ||
    !((a.a_long === ADL_ONE && a.a_short === ADL_ONE) || (a.a_long === 0n && a.a_short === 0n)) ||
    a.b_long_num !== 0n ||
    a.b_short_num !== 0n ||
    a.b_epoch_start_long_num !== 0n ||
    a.b_epoch_start_short_num !== 0n ||
    a.oi_eff_long_q !== 0n ||
    a.oi_eff_short_q !== 0n ||
    a.stored_pos_count_long !== 0n ||
    a.stored_pos_count_short !== 0n ||
    a.stale_account_count_long !== 0n ||
    a.stale_account_count_short !== 0n ||
    a.pending_obligation_count_long !== 0n ||
    a.pending_obligation_count_short !== 0n ||
    a.loss_weight_sum_long !== 0n ||
    a.loss_weight_sum_short !== 0n ||
    spentBlocks ||
    !sourceEmptyAmounts(e.source_credit_long, true) ||
    !sourceEmptyAmounts(e.source_credit_short, true) ||
    !bucketEmptyAmounts(e.backing_long) ||
    !bucketEmptyAmounts(e.backing_short) ||
    e.backing_long.market_id !== a.market_id ||
    e.backing_short.market_id !== a.market_id ||
    !reservationEmpty(e.insurance_reservation_long) ||
    !reservationEmpty(e.insurance_reservation_short)
  )
    failV16(V16_LOCK_ACTIVE);
}

/**
 * `normalize_terminal_empty_asset_history_not_atomic`: the asset empty; a fully spent domain budget cleared with its
 * spent amount (a partly spent one is LockActive); the social-loss audit and the price and funding history cleared;
 * each side's source credit (only spent history allowed: LockActive) reset to EMPTY; `set_asset_state`; the market's
 * shape.
 */
function normalizeTerminalEmptyAsset(m: RemainingAccount, markets: u64, asset: u64): void {
  configuredAssetIndex(m, markets, asset);
  requireEmptyAssetLifecycle(m, markets, asset);
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  // clear_terminal_spent_domain_budget_pair, both sides, before anything is written.
  let budgetLong = e.insurance_domain_budget_long;
  let spentLong = e.insurance_domain_spent_long;
  if (spentLong !== 0n) {
    if (budgetLong !== spentLong) failV16(V16_LOCK_ACTIVE);
    budgetLong = 0n;
    spentLong = 0n;
  }
  let budgetShort = e.insurance_domain_budget_short;
  let spentShort = e.insurance_domain_spent_short;
  if (spentShort !== 0n) {
    if (budgetShort !== spentShort) failV16(V16_LOCK_ACTIVE);
    budgetShort = 0n;
    spentShort = 0n;
  }
  const before = blockersBefore(m, asset);
  // clear_terminal_social_loss_audit and clear_terminal_price_funding_history on the asset (written by set_asset_state
  // after the source states, which only the source states can refuse).
  // clear_terminal_source_spent_audit: each side's shape (passed above) and audit-only shape (passed above), then EMPTY.
  setSourceCreditEmpty(m, asset, false);
  setSourceCreditEmpty(m, asset, true);
  const sa = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const a = sa.asset;
  a.social_loss_remainder_long_num = 0n;
  a.social_loss_remainder_short_num = 0n;
  a.social_loss_dust_long_num = 0n;
  a.social_loss_dust_short_num = 0n;
  a.explicit_unallocated_loss_long = 0n;
  a.explicit_unallocated_loss_short = 0n;
  a.k_long = 0n;
  a.k_short = 0n;
  a.f_long_num = 0n;
  a.f_short_num = 0n;
  a.kf_epoch_long = 0n;
  a.kf_epoch_short = 0n;
  a.k_epoch_start_long = 0n;
  a.k_epoch_start_short = 0n;
  a.f_epoch_start_long_num = 0n;
  a.f_epoch_start_short_num = 0n;
  blockersAfter(m, asset, before);
  const w = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  w.insurance_domain_budget_long = budgetLong;
  w.insurance_domain_spent_long = spentLong;
  w.insurance_domain_budget_short = budgetShort;
  w.insurance_domain_spent_short = spentShort;
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `expire_lapsed_source_backing_for_asset_not_atomic`: per side, a Fresh bucket whose expiry slot has passed is
 * expired (`expire_source_backing_bucket_not_atomic`), then the bucket read again and an Expired one with nothing left
 * becomes the empty bucket of its market (`kernel_retirement_backing_normalization`).
 */
function expireLapsedBacking(m: RemainingAccount, markets: u64, asset: u64, now: u64): void {
  for (let side = 0n; side < 2n; side++) {
    const short = side === 1n;
    const domain = domainIndex(m, markets, asset, short);
    // backing_bucket_for_domain: decoded; the market is Live (every caller refused another mode), so the expiry is
    // the stored one.
    const f = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
    const lapsed = short ? f.backing_short : f.backing_long;
    checkV16(backingBucketErr(lapsed));
    if (lapsed.status === 1n && lapsed.expiry_slot <= now) expireSourceBackingBucket(m, markets, domain, now);
    const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
    const b = short ? e.backing_short : e.backing_long;
    checkV16(backingBucketErr(b));
    const empty =
      b.status === 2n &&
      b.fresh_unliened_backing_num === 0n &&
      b.valid_liened_backing_num === 0n &&
      b.consumed_liened_backing_num === 0n &&
      b.impaired_liened_backing_num === 0n &&
      b.utilization_fee_earnings === 0n;
    if (empty) setBucketEmpty(m, asset, short, b.market_id);
  }
}

// ---- Engine transitions ---------------------------------------------------------------------------------------------------

/**
 * `MarketGroupV16HeaderAccount::grow_asset_slot_capacity_not_atomic(capacity, new_max)`, as a V16Error value (the
 * caller maps it with map_account_wire_error): the config's shape, Live, the capacity not shrinking, the configured
 * count growing within it, the grown config's shape, both epochs below u64::MAX; then written.
 */
function growCapacityErr(m: RemainingAccount, capacity: u64, newMax: u64): u64 {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  let e = configShapeErr(h.config);
  if (e === V16_OK) e = marketModeErr(h.mode);
  if (e !== V16_OK) return e;
  if (h.mode !== 0n || capacity < toU64(h.asset_slot_capacity) || newMax < toU64(h.config.max_market_slots) || newMax > capacity) return V16_INVALID_CONFIG;
  // validate_public_user_fund_shape of the config with the new count: only the count's own rules can change.
  if (toU64(h.config.max_portfolio_assets) > newMax) return V16_INVALID_CONFIG;
  if (h.asset_set_epoch === U64_MAX_L || h.risk_epoch === U64_MAX_L) return V16_COUNTER_OVERFLOW;
  h.asset_slot_capacity = toU32(capacity);
  h.config.max_market_slots = toU32(newMax);
  h.asset_set_epoch += 1n;
  h.risk_epoch += 1n;
  return V16_OK;
}

/**
 * `activate_empty_market_slot_not_atomic(asset, slot, price, now)` as a V16Error value (map_account_wire_error when
 * appending, map_v16_error when reusing a configured slot). Every refusal comes before any write.
 */
function activateEmptySlotErr(m: RemainingAccount, asset: u64, price: u64, now: u64): u64 {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  let err = configShapeErr(h.config);
  if (err !== V16_OK) return err;
  if (asset >= toU64(h.asset_slot_capacity) || asset >= toU64(h.config.max_market_slots)) return V16_INVALID_LEG;
  err = marketModeErr(h.mode);
  if (err !== V16_OK) return err;
  if (h.mode !== 0n || price === 0n || price > MAX_ORACLE_PRICE || now < h.current_slot) return V16_INVALID_CONFIG;
  // The config's shape again (validate_public_user_fund_shape): it passed above.
  if (h.asset_activation_count !== 0n) {
    if (now < h.last_asset_activation_slot) return V16_STALE;
    if (now - h.last_asset_activation_slot < h.config.asset_activation_cooldown_slots) return V16_LOCK_ACTIVE;
  }
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const a = e.asset;
  err = assetStateErr(a);
  if (err !== V16_OK) return err;
  // asset_state_is_empty_for_activation.
  const empty =
    ((a.a_long === 0n && a.a_short === 0n) || (a.a_long === ADL_ONE && a.a_short === ADL_ONE)) &&
    a.k_long === 0n &&
    a.k_short === 0n &&
    a.f_long_num === 0n &&
    a.f_short_num === 0n &&
    a.kf_epoch_long === 0n &&
    a.kf_epoch_short === 0n &&
    a.k_epoch_start_long === 0n &&
    a.k_epoch_start_short === 0n &&
    a.f_epoch_start_long_num === 0n &&
    a.f_epoch_start_short_num === 0n &&
    a.b_long_num === 0n &&
    a.b_short_num === 0n &&
    a.b_epoch_start_long_num === 0n &&
    a.b_epoch_start_short_num === 0n &&
    a.oi_eff_long_q === 0n &&
    a.oi_eff_short_q === 0n &&
    a.stored_pos_count_long === 0n &&
    a.stored_pos_count_short === 0n &&
    a.stale_account_count_long === 0n &&
    a.stale_account_count_short === 0n &&
    a.pending_obligation_count_long === 0n &&
    a.pending_obligation_count_short === 0n &&
    a.loss_weight_sum_long === 0n &&
    a.loss_weight_sum_short === 0n &&
    a.social_loss_remainder_long_num === 0n &&
    a.social_loss_remainder_short_num === 0n &&
    a.social_loss_dust_long_num === 0n &&
    a.social_loss_dust_short_num === 0n &&
    a.explicit_unallocated_loss_long === 0n &&
    a.explicit_unallocated_loss_short === 0n &&
    a.mode_long === 0n &&
    a.mode_short === 0n;
  if (!empty) return V16_LOCK_ACTIVE;
  if (a.lifecycle === LIFECYCLE_DISABLED) {
    const bl = e.insurance_domain_budget_long;
    const bs = e.insurance_domain_budget_short;
    if (a.market_id !== 0n || !(bl === 0n || bl === MAX_VAULT_TVL) || !(bs === 0n || bs === MAX_VAULT_TVL)) return V16_LOCK_ACTIVE;
  } else if (a.lifecycle === LIFECYCLE_RETIRED) {
    if (a.market_id === 0n || a.retired_slot === 0n || e.insurance_domain_budget_long !== 0n || e.insurance_domain_budget_short !== 0n) return V16_LOCK_ACTIVE;
    if (now < a.retired_slot) return V16_STALE;
    if (now - a.retired_slot < h.config.asset_activation_cooldown_slots) return V16_LOCK_ACTIVE;
    // validate_market_id_binding: the asset and both buckets decoded, the buckets of the asset's market.
    err = backingBucketErr(e.backing_long);
    if (err === V16_OK) err = backingBucketErr(e.backing_short);
    if (err !== V16_OK) return err;
    if (e.backing_long.market_id !== a.market_id || e.backing_short.market_id !== a.market_id) return V16_INVALID_CONFIG;
  } else return V16_LOCK_ACTIVE;
  if (
    e.insurance_domain_spent_long !== 0n ||
    e.insurance_domain_spent_short !== 0n ||
    e.pending_domain_loss_barrier_long !== 0n ||
    e.pending_domain_loss_barrier_short !== 0n ||
    !sourceEmptyAmounts(e.source_credit_long, false) ||
    !sourceEmptyAmounts(e.source_credit_short, false)
  )
    return V16_LOCK_ACTIVE;
  // The buckets and reservations decoded in the `||` chain's order, each refusal before the next's decoding.
  err = backingBucketErr(e.backing_long);
  if (err !== V16_OK) return err;
  if (!bucketEmptyAmounts(e.backing_long)) return V16_LOCK_ACTIVE;
  err = backingBucketErr(e.backing_short);
  if (err !== V16_OK) return err;
  if (!bucketEmptyAmounts(e.backing_short)) return V16_LOCK_ACTIVE;
  err = insuranceReservationErr(e.insurance_reservation_long);
  if (err !== V16_OK) return err;
  if (!reservationEmpty(e.insurance_reservation_long)) return V16_LOCK_ACTIVE;
  err = insuranceReservationErr(e.insurance_reservation_short);
  if (err !== V16_OK) return err;
  if (!reservationEmpty(e.insurance_reservation_short)) return V16_LOCK_ACTIVE;
  const marketId = h.next_market_id;
  if (marketId === 0n) return V16_INVALID_CONFIG;
  if (marketId === U64_MAX_L || h.asset_activation_count === U64_MAX_L || h.asset_set_epoch === U64_MAX_L || h.risk_epoch === U64_MAX_L)
    return V16_COUNTER_OVERFLOW;
  writeEmptySlot(m, asset, marketId);
  const n = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  n.asset.raw_oracle_target_price = price;
  n.asset.effective_price = price;
  n.asset.fund_px_last = price;
  n.asset.slot_last = now;
  const w = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  w.next_market_id = marketId + 1n;
  w.current_slot = now;
  w.asset_activation_count += 1n;
  w.last_asset_activation_slot = now;
  w.asset_set_epoch += 1n;
  w.risk_epoch += 1n;
  return V16_OK;
}

/** `mark_asset_drain_only_not_atomic` (map_v16_error). */
function markDrainOnly(m: RemainingAccount, markets: u64, asset: u64): void {
  configuredAssetIndex(m, markets, asset);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== 0n) failV16(V16_LOCK_ACTIVE);
  assetStateChecked(m, asset);
  const sa = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const a = sa.asset;
  if (a.lifecycle === LIFECYCLE_DRAIN_ONLY) return;
  if (a.lifecycle !== LIFECYCLE_ACTIVE) failV16(V16_LOCK_ACTIVE);
  epochBumpCheck(h);
  const before = blockersBefore(m, asset);
  a.lifecycle = LIFECYCLE_DRAIN_ONLY;
  blockersAfter(m, asset, before);
  h.asset_set_epoch += 1n;
  h.risk_epoch += 1n;
  checkV16(marketShapeErr(h, markets));
}

/** `retire_empty_asset_not_atomic(asset, now)` (map_v16_error). */
function retireEmptyAsset(m: RemainingAccount, markets: u64, asset: u64, now: u64): void {
  configuredAssetIndex(m, markets, asset);
  if (now < loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot) failV16(V16_STALE);
  assetStateChecked(m, asset);
  const life = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle;
  if (life === LIFECYCLE_ACTIVE || life === LIFECYCLE_DRAIN_ONLY || life === LIFECYCLE_RECOVERY) {
    expireLapsedBacking(m, markets, asset, now);
    normalizeTerminalEmptyAsset(m, markets, asset);
    const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
    epochBumpCheck(h);
    assetStateChecked(m, asset);
    const before = blockersBefore(m, asset);
    const sa = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
    const a = sa.asset;
    a.lifecycle = LIFECYCLE_RETIRED;
    a.retired_slot = now;
    blockersAfter(m, asset, before);
    h.current_slot = now;
    h.asset_set_epoch += 1n;
    h.risk_epoch += 1n;
    checkV16(marketShapeErr(h, markets));
  } else if (life === LIFECYCLE_RETIRED) {
    expireLapsedBacking(m, markets, asset, now);
    normalizeTerminalEmptyAsset(m, markets, asset);
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  } else failV16(V16_LOCK_ACTIVE);
}

/**
 * The program's `canonicalize_retired_asset_slot_view`: a retired asset (decoded: map_v16_error) with a market id and
 * a retired slot, no budgets, spent amounts, barriers or bucket earnings (EngineLockActive), rewritten as the empty
 * slot of its market keeping its market id, retired slot, prices and slot (written directly, not by `set_asset_state`).
 */
function canonicalizeRetiredSlot(m: RemainingAccount, markets: u64, asset: u64): void {
  require(asset < markets, PercolatorError.InvalidInstruction);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  checkV16(assetStateErr(e.asset));
  const a = e.asset;
  require(
    !(
      a.lifecycle !== LIFECYCLE_RETIRED ||
      a.market_id === 0n ||
      a.retired_slot === 0n ||
      e.insurance_domain_budget_long !== 0n ||
      e.insurance_domain_budget_short !== 0n ||
      e.insurance_domain_spent_long !== 0n ||
      e.insurance_domain_spent_short !== 0n ||
      e.pending_domain_loss_barrier_long !== 0n ||
      e.pending_domain_loss_barrier_short !== 0n
    ),
    PercolatorError.EngineLockActive,
  );
  checkV16(backingBucketErr(e.backing_long));
  checkV16(backingBucketErr(e.backing_short));
  require(e.backing_long.utilization_fee_earnings === 0n && e.backing_short.utilization_fee_earnings === 0n, PercolatorError.EngineLockActive);
  const marketId = a.market_id;
  const retiredSlot = a.retired_slot;
  const raw = a.raw_oracle_target_price;
  const effective = a.effective_price;
  const fund = a.fund_px_last;
  const slotLast = a.slot_last;
  writeEmptySlot(m, asset, marketId);
  const sn = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const n = sn.asset;
  n.retired_slot = retiredSlot;
  n.lifecycle = LIFECYCLE_RETIRED;
  n.raw_oracle_target_price = raw;
  n.effective_price = effective;
  n.fund_px_last = fund;
  n.slot_last = slotLast;
}

/**
 * `force_asset_recovery_not_atomic(asset, now)` (map_v16_error): Active or DrainOnly become Recovery
 * (`prepare_asset_recovery_transition`: the effective price valid, the raw target set to it, both epochs bumped);
 * Recovery stays; anything else LockActive.
 */
function forceAssetRecovery(m: RemainingAccount, markets: u64, asset: u64, now: u64): void {
  configuredAssetIndex(m, markets, asset);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== 0n || now < h.current_slot) failV16(V16_INVALID_CONFIG);
  assetStateChecked(m, asset);
  const sa = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const a = sa.asset;
  if (a.lifecycle === LIFECYCLE_ACTIVE || a.lifecycle === LIFECYCLE_DRAIN_ONLY) {
    if (a.effective_price === 0n || a.effective_price > MAX_ORACLE_PRICE) failV16(V16_INVALID_CONFIG);
    epochBumpCheck(h);
    const before = blockersBefore(m, asset);
    a.lifecycle = LIFECYCLE_RECOVERY;
    a.raw_oracle_target_price = a.effective_price;
    blockersAfter(m, asset, before);
    h.asset_set_epoch += 1n;
    h.risk_epoch += 1n;
  } else if (a.lifecycle !== LIFECYCLE_RECOVERY) failV16(V16_LOCK_ACTIVE);
  checkV16(marketShapeErr(h, markets));
}

// ---- Profiles ---------------------------------------------------------------------------------------------------------------

/**
 * `state::manual_asset_oracle_profile(price, slot)` written over the profile at `at` (Manual, no authorities, the
 * price as mark, target and funding mark, the slot as the mark's and the liveness slot, the default half-life), with
 * the backing-fee policy and the four domain authorities of the profile that was there when `preserve`
 * (`preserve_backing_fee_policy`), and `admin` as the asset admin.
 */
function writeManualProfile(m: RemainingAccount, at: u64, price: u64, slot: u64, preserve: boolean, admin: Pubkey): void {
  const p = loadRawAt<AssetOracleProfile>(m, at);
  const feeLong = preserve ? p.backing_trade_fee_bps_long : 0n;
  const feeShort = preserve ? p.backing_trade_fee_bps_short : 0n;
  const shareLong = preserve ? p.backing_trade_fee_insurance_share_bps_long : 0n;
  const shareShort = preserve ? p.backing_trade_fee_insurance_share_bps_short : 0n;
  const ia = preserve ? p.insurance_authority : ZERO_KEY;
  const io = preserve ? p.insurance_operator : ZERO_KEY;
  const ba = preserve ? p.backing_bucket_authority : ZERO_KEY;
  const oa = preserve ? p.oracle_authority : ZERO_KEY;
  zeroData(m, at, ASSET_ORACLE_PROFILE_LEN);
  const n = loadRawMutAt<AssetOracleProfile>(m, at);
  n.backing_trade_fee_bps_long = feeLong;
  n.backing_trade_fee_bps_short = feeShort;
  n.backing_trade_fee_insurance_share_bps_long = shareLong;
  n.backing_trade_fee_insurance_share_bps_short = shareShort;
  n.insurance_authority = ia;
  n.insurance_operator = io;
  n.backing_bucket_authority = ba;
  n.oracle_authority = oa;
  n.mark_ewma_e6 = price;
  n.mark_ewma_last_slot = slot;
  n.mark_ewma_halflife_slots = DEFAULT_MARK_EWMA_HALFLIFE_SLOTS;
  n.oracle_target_price_e6 = price;
  n.last_good_oracle_slot = slot;
  n.asset_admin = admin;
  n.funding_mark_e6 = price;
}

/** The four domain authorities set on the profile at `at`. */
function setAuthorities(m: RemainingAccount, at: u64, ia: Pubkey, io: Pubkey, ba: Pubkey, oa: Pubkey): void {
  const p = loadRawMutAt<AssetOracleProfile>(m, at);
  p.insurance_authority = ia;
  p.insurance_operator = io;
  p.backing_bucket_authority = ba;
  p.oracle_authority = oa;
}

/** `mirror_manual_profile_to_base_config(cfg, profile, refresh_liveness)`: asset 0's manual profile into the config. */
function mirrorManualToConfig(m: RemainingAccount, at: u64, refreshLiveness: boolean): void {
  const p = loadRawAt<AssetOracleProfile>(m, at);
  const c = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  c.oracle_mode = 0n;
  c.oracle_leg_count = 0n;
  c.oracle_leg_flags = 0n;
  c.invert = 0n;
  c.unit_scale = 0n;
  c.conf_filter_bps = 0n;
  c.max_staleness_secs = 0n;
  c.hybrid_soft_stale_slots = 0n;
  c.mark_ewma_e6 = p.mark_ewma_e6;
  c.mark_ewma_last_slot = p.mark_ewma_last_slot;
  c.mark_ewma_halflife_slots = p.mark_ewma_halflife_slots;
  c.mark_min_fee = 0n;
  c.oracle_target_price_e6 = p.oracle_target_price_e6;
  c.oracle_target_publish_time = 0n;
  if (refreshLiveness) c.last_good_oracle_slot = p.last_good_oracle_slot;
  for (let i = 0n; i < 3n; i++) {
    c.oracle_leg_feeds.set(i, ZERO_KEY);
    c.oracle_leg_prices_e6.set(i, 0n);
    c.oracle_leg_publish_times.set(i, 0n);
  }
}

/** `backing_fee_policy_count_from_profile`. */
function policyCount(p: AssetOracleProfile): u16 {
  let n: u16 = 0n;
  if (p.backing_trade_fee_bps_long !== 0n) n += 1n;
  if (p.backing_trade_fee_bps_short !== 0n) n += 1n;
  return n;
}

/** `write_control_sequences_to_view(…, AssetControlSequencesV16::default())` (their validation accepts every value). */
function resetControls(m: RemainingAccount, asset: u64): void {
  zeroData(m, engineSlotAt(asset) - 88n, 88n);
}

/**
 * `policy_v16::permissionless_market_init_fee_for_asset(…).ok_or(EngineArithmeticOverflow)?`: the base fee doubled once
 * per 32 assets; any doubling that overflows u128 is the refusal (the caller's `ok_or`), whatever the base.
 */
function initFeeFor(base: u128, asset: u64): u128 {
  if (base === 0n) return 0n;
  let fee = base;
  for (let d = asset / 32n; d !== 0n; d--) {
    require(fee <= U128_MAX_L / 2n, PercolatorError.EngineArithmeticOverflow);
    fee *= 2n;
  }
  return fee;
}

// ---- UpdateAssetLifecycle (tag 40) ----------------------------------------------------------------------------------------

/**
 * `handle_update_asset_lifecycle(action, asset_index, market_id, authority_epoch, now_slot, initial_price,
 * max_init_fee, insurance_authority, insurance_operator, backing_bucket_authority, oracle_authority)`: accounts
 * authority (signer), market (w), then for a permissionless activation the source token account (w), the vault (w)
 * and SPL Token. The generation preflight (activation: the market's next id; otherwise the asset's id); the market Live.
 * Then by action:
 *
 * - Activate at the next slot (appending; by the market authority, fee-free, or by anyone paying the permissionless
 *   fee), or of a retired slot by anyone while free slots exist: the stale window, the fee (Unauthorized above
 *   `max_init_fee`), the token accounts; the market reallocated by one slot when the index is at its capacity; under
 *   the view the generation and the authority epoch (the market authority's, or 0), Live; then the slot activated
 *   (`activate_dynamic_asset_slot`, or `activate_empty_market_slot_not_atomic` for reuse), a manual profile with the
 *   four authorities and the signer as admin, and the fee into market 0's insurance domains and the SPL Token
 *   Transfer.
 * - Shutdown (by the market authority or the asset's admin; the market's force-close delay set): the asset's
 *   committed funding accrued to the Clock (accrual.ts), the asset into Recovery at its effective price, the profile's
 *   marks frozen there (mirrored for asset 0).
 * - Activate an existing disabled or retired slot, drain-only, retire (by the market authority): the engine
 *   transition, the profile reset to manual (keeping the backing-fee policy and authorities), the config's free-slot
 *   and policy counts.
 *
 * @noinline
 */
export function updateAssetLifecycle(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 2n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(authority);
  writableCheck(m);
  ownerCheck(m, programId);
  const action = toU64(data.readU8(1n));
  const asset = toU64(data.readU16(2n));
  const expectedMarketId = data.readU64(4n);
  const expectedEpoch = data.readU64(12n);
  const nowSlot = data.readU64(20n);
  const price = data.readU64(28n);
  const maxInitFee = data.readU128(36n);
  const ia = data.readPubkey(52n);
  const io = data.readPubkey(84n);
  const ba = data.readPubkey(116n);
  const oa = data.readPubkey(148n);
  const activation = action === ACTION_ACTIVATE;
  // state::read_asset_lifecycle_generation_preflight, then asset_lifecycle_generation_binding_matches.
  checkHeader(m, KIND_MARKET);
  validateMarketDynamicLen(m);
  const hp = loadRawAt<GroupHeader>(m, marketHeaderAt(m));
  const configuredPre = toU64(hp.config.max_market_slots);
  require(!(asset > configuredPre || (!activation && asset === configuredPre)), PercolatorError.InvalidInstruction);
  const current = asset < configuredPre ? readData<u64>(m, assetSlotAt(m, asset)) : 0n;
  require((activation ? hp.next_market_id : current) === expectedMarketId, PercolatorError.AssetGenerationMismatch);
  // state::read_market_config_mode_and_capacity: the header, the length, the wrapper config (validated), the engine
  // config (InvalidAccountData), the mode (InvalidAccountData).
  validateWrapperConfig(loadRawAt<WrapperConfig>(m, wrapperConfigAt(m)));
  require(configFullErr(hp.config) === V16_OK, ProgramError.InvalidAccountData);
  require(marketModeErr(hp.mode) === V16_OK, ProgramError.InvalidAccountData);
  const capacityPre = toU64(hp.asset_slot_capacity);
  require(hp.mode === 0n, PercolatorError.EngineLockActive);
  const cfgPre = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const isAuthority = liveAuthorityMatches(cfgPre.marketauth, authority.key);
  const reuseTarget = activation && !isAuthority && asset < configuredPre && cfgPre.free_market_slot_count !== 0n;
  if (activation && (asset === configuredPre || reuseTarget)) {
    activateAppendOrReuse(rest, m, programId, asset, expectedMarketId, expectedEpoch, nowSlot, price, maxInitFee, ia, io, ba, oa, isAuthority, configuredPre, capacityPre);
    return;
  }
  if (action === ACTION_SHUTDOWN) {
    shutdownAsset(m, authority.key, asset, expectedMarketId, expectedEpoch, nowSlot, price);
    return;
  }
  // Activate (privileged, fee-free), drain-only and retire are gated on the market authority alone.
  require(isAuthority, PercolatorError.Unauthorized);
  const slot = currentSlot();
  require(!permissionlessStaleMatured(loadRawAt<WrapperConfig>(m, HEADER_LEN), slot), PercolatorError.OracleStale);
  // state::read_asset_oracle_profile(data, asset): the header, the index within the capacity (InvalidInstruction),
  // the profile validated.
  const at = readAssetOracleProfileAt(m, asset);
  const markets = marketViewMut(m);
  requireLifecycleGeneration(m, markets, asset, activation, expectedMarketId);
  requireAuthorityEpoch(m, markets, 0n, expectedEpoch);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  require(asset < toU64(h.config.max_market_slots), PercolatorError.InvalidInstruction);
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  const existingCount = policyCount(loadRawAt<AssetOracleProfile>(m, at));
  if (action === ACTION_ACTIVATE) {
    require(ia !== ZERO_KEY && io !== ZERO_KEY && ba !== ZERO_KEY && oa !== ZERO_KEY, PercolatorError.InvalidInstruction);
    const wasRetired = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle === LIFECYCLE_RETIRED;
    checkV16(activateEmptySlotErr(m, asset, price, slot));
    if (wasRetired && cfg.free_market_slot_count !== 0n) cfg.free_market_slot_count -= 1n;
    if (wasRetired && existingCount !== 0n) {
      require(cfg.backing_trade_fee_policy_count <= 0xffffn - existingCount, PercolatorError.EngineCounterOverflow);
      cfg.backing_trade_fee_policy_count += existingCount;
    }
    writeManualProfile(m, at, price, slot, true, authority.key);
    setAuthorities(m, at, ia, io, ba, oa);
    if (wasRetired) resetControls(m, asset);
    if (asset === 0n) mirrorManualToConfig(m, at, true);
  } else if (action === ACTION_DRAIN_ONLY) {
    require(nowSlot === 0n && price === 0n, PercolatorError.InvalidInstruction);
    markDrainOnly(m, markets, asset);
  } else if (action === ACTION_RETIRE) {
    require(!(asset === 0n || nowSlot === 0n || price !== 0n), PercolatorError.InvalidInstruction);
    require(slot >= loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot, PercolatorError.EngineStale);
    const life = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle;
    if (life === LIFECYCLE_ACTIVE || life === LIFECYCLE_DRAIN_ONLY || life === LIFECYCLE_RECOVERY) {
      retireEmptyAsset(m, markets, asset, slot);
      canonicalizeRetiredSlot(m, markets, asset);
      require(cfg.free_market_slot_count !== 0xffffn, PercolatorError.EngineCounterOverflow);
      cfg.free_market_slot_count += 1n;
      require(cfg.backing_trade_fee_policy_count >= existingCount, PercolatorError.EngineCounterUnderflow);
      cfg.backing_trade_fee_policy_count -= existingCount;
    } else if (life === LIFECYCLE_RETIRED) {
      retireEmptyAsset(m, markets, asset, slot);
      canonicalizeRetiredSlot(m, markets, asset);
    } else require(false, PercolatorError.EngineLockActive);
    // preserve_backing_fee_policy(manual_asset_oracle_profile(effective price, slot), existing): no admin.
    writeManualProfile(m, at, loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.effective_price, slot, true, ZERO_KEY);
  } else require(false, PercolatorError.InvalidInstruction);
  // write_oracle_profile_to_view validates the profile (activate and retire), then the market's shape, then
  // state::write_wrapper_config validates the config.
  if (action !== ACTION_DRAIN_ONLY) validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWrapperConfig(loadRawAt<WrapperConfig>(m, HEADER_LEN));
}

/** `require_asset_lifecycle_generation_view(group, asset, is_activation, expected)`. */
function requireLifecycleGeneration(m: RemainingAccount, markets: u64, asset: u64, activation: boolean, expected: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const configured = toU64(h.config.max_market_slots);
  require(!(asset > configured || (!activation && asset === configured) || asset >= markets), PercolatorError.InvalidInstruction);
  const current = asset < configured ? loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.market_id : 0n;
  require((activation ? h.next_market_id : current) === expected, PercolatorError.AssetGenerationMismatch);
}

/** UpdateAssetLifecycle's appending or permissionless-reuse activation (the handler's first branch). */
function activateAppendOrReuse(
  rest: RemainingAccounts,
  m: RemainingAccount,
  programId: Pubkey,
  asset: u64,
  expectedMarketId: u64,
  expectedEpoch: u64,
  nowSlot: u64,
  price: u64,
  maxInitFee: u128,
  ia: Pubkey,
  io: Pubkey,
  ba: Pubkey,
  oa: Pubkey,
  isAuthority: boolean,
  configuredPre: u64,
  capacityPre: u64,
): void {
  const authority = rest.get(0n);
  const slot = currentSlot();
  const cfgPre = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  require(!permissionlessStaleMatured(cfgPre, slot), PercolatorError.OracleStale);
  const append = asset === configuredPre;
  require(!(append && cfgPre.free_market_slot_count !== 0n), PercolatorError.EngineLockActive);
  let initFee: u128 = 0n;
  if (!isAuthority) {
    const fee = initFeeFor(cfgPre.permissionless_market_init_fee, asset);
    require(!(fee === 0n || fee > maxInitFee), PercolatorError.Unauthorized);
    initFee = fee;
  }
  if (initFee !== 0n) {
    needAccounts(rest, 5n);
    const source = rest.get(2n);
    const vault = rest.get(3n);
    writableCheck(source);
    writableCheck(vault);
    verifyTokenProgramV16(rest.get(4n));
    const mint = cfgPre.collateral_mint;
    const vaultAuthority = vaultAuthorityOf(m.key, programId);
    const balance = verifyUserTokenAccount(source, authority.key, mint);
    verifyVaultTokenAccount(vault, vaultAuthority, mint);
    // amount_to_u64 and require_token_balance; the transfer comes after the insurance deposit.
    require(balance >= amountToU64(initFee), PercolatorError.InvalidTokenAccount);
  }
  if (asset >= capacityPre) resizeAccount(m, marketAccountLenForCapacity(asset + 1n));
  const markets = marketViewMut(m);
  requireLifecycleGeneration(m, markets, asset, true, expectedMarketId);
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  const still = liveAuthorityMatches(cfg.marketauth, authority.key);
  if (still) requireAuthorityEpoch(m, markets, 0n, expectedEpoch);
  else {
    // Permissionless: the canonical zero epoch, and the same fee again (it cannot have changed).
    require(expectedEpoch === 0n, PercolatorError.EngineStale);
  }
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  const configured = toU64(h.config.max_market_slots);
  if (asset === configured) {
    require(cfg.free_market_slot_count === 0n, PercolatorError.EngineLockActive);
    // state::activate_dynamic_asset_slot, every engine refusal InvalidAccountData (map_account_wire_error).
    require(ia !== ZERO_KEY && io !== ZERO_KEY && ba !== ZERO_KEY && oa !== ZERO_KEY, PercolatorError.InvalidInstruction);
    checkHeader(m, KIND_MARKET);
    const capacity = validateMarketDynamicLen(m);
    require(asset < capacity, PercolatorError.InvalidInstruction);
    require(configFullErr(h.config) === V16_OK, ProgramError.InvalidAccountData);
    require(asset === configured, PercolatorError.InvalidInstruction);
    assetSlotAt(m, asset);
    require(growCapacityErr(m, capacity, asset + 1n) === V16_OK, ProgramError.InvalidAccountData);
    require(activateEmptySlotErr(m, asset, price, slot) === V16_OK, ProgramError.InvalidAccountData);
    const at = dynamicProfileAt(asset);
    writeManualProfile(m, at, price, slot, false, authority.key);
    setAuthorities(m, at, ia, io, ba, oa);
    // state::write_asset_oracle_profile: the header, the profile validated, the index within the capacity.
    validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
    if (initFee !== 0n) {
      const again = marketViewMut(m);
      depositMarketZeroInsurance(m, again, initFee);
      checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), again));
      transferFee(rest, initFee);
    }
    return;
  }
  // The permissionless reuse of a retired slot (a free slot exists; the signer is not the market authority, so it
  // pays a fee).
  require(!still && asset < configured && cfg.free_market_slot_count !== 0n, PercolatorError.EngineLockActive);
  require(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle === LIFECYCLE_RETIRED, PercolatorError.EngineLockActive);
  require(ia !== ZERO_KEY && io !== ZERO_KEY && ba !== ZERO_KEY && oa !== ZERO_KEY, PercolatorError.InvalidInstruction);
  checkV16(activateEmptySlotErr(m, asset, price, slot));
  cfg.free_market_slot_count -= 1n;
  const at = dynamicProfileAt(asset);
  if (asset !== 0n) {
    writeManualProfile(m, at, price, slot, false, authority.key);
    setAuthorities(m, at, ia, io, ba, oa);
    validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
  }
  resetControls(m, asset);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWrapperConfig(cfg);
  // The signer is not the market authority here, so the fee is nonzero.
  const again = marketViewMut(m);
  depositMarketZeroInsurance(m, again, initFee);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), again));
  transferFee(rest, initFee);
}

/** `transfer_tokens(token_program, source, vault, authority, fee)`: SPL Token Transfer, the signer the source's owner. */
function transferFee(rest: RemainingAccounts, fee: u128): void {
  programAt<TokenProgram>(rest.get(4n)).transfer(rest.get(2n), rest.get(3n), rest.get(0n), amountToU64(fee));
}

/**
 * `deposit_market_zero_insurance_view(group, amount)`: ⌊amount / 2⌋ into domain 0 (asset 0 long), the rest into
 * domain 1 (asset 0 short); each `deposit_domain_insurance_not_atomic` mapped with map_v16_error.
 */
function depositMarketZeroInsurance(m: RemainingAccount, markets: u64, amount: u128): void {
  const long = amount / 2n;
  depositDomainInsurance(m, markets, 0n, long);
  depositDomainInsurance(m, markets, 1n, amount - long);
}

/**
 * `deposit_domain_insurance_not_atomic(domain, amount)`: the domain configured and in the view (InvalidLeg); the vault,
 * the insurance and the domain's budget raised by the amount (ArithmeticOverflow); `set_domain_insurance_budget_core`
 * (the budget not below its spent part, InvalidConfig; the market's remaining-budget total raised, CounterOverflow, and
 * not above the new insurance, LockActive); the token-flow proof (external quote in, insurance capital: it balances by
 * construction); `validate_source_domain_ledger(domain)`; the market's shape.
 */
export function depositDomainInsurance(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const asset = domain / 2n;
  if (domain >= 2n * toU64(h.config.max_market_slots) || asset >= markets) failV16(V16_INVALID_LEG);
  if (h.vault > U128_MAX_L - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  if (h.insurance > U128_MAX_L - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  const nextInsurance = h.insurance + amount;
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const short = domain % 2n === 1n;
  const budget = short ? e.insurance_domain_budget_short : e.insurance_domain_budget_long;
  const spent = short ? e.insurance_domain_spent_short : e.insurance_domain_spent_long;
  if (budget > U128_MAX_L - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  // set_domain_insurance_budget_delta: the remaining part grows by exactly the amount.
  if (budget < spent) failV16(V16_INVALID_CONFIG);
  const total = h.insurance_domain_budget_remaining_total;
  if (total > U128_MAX_L - amount) failV16(V16_COUNTER_OVERFLOW);
  if (total + amount > nextInsurance) failV16(V16_LOCK_ACTIVE);
  h.insurance_domain_budget_remaining_total = total + amount;
  if (short) e.insurance_domain_budget_short = budget + amount;
  else e.insurance_domain_budget_long = budget + amount;
  h.vault += amount;
  h.insurance = nextInsurance;
  validateSourceDomainLedger(m, asset, short);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `validate_source_domain_ledger(domain)`: the source state's shape, the backing bucket decoded (its expiry unchanged
 * in a Live market), the insurance reservation decoded, then `validate_source_domain_ledger_parts`: the source state
 * whole (its credit rate), and for the asset's market id (none: all three EMPTY) the bucket's id and the source's
 * amounts equal to the bucket's and the reservation's (InvalidConfig).
 */
export function validateSourceDomainLedger(m: RemainingAccount, asset: u64, short: boolean): void {
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const s = short ? e.source_credit_short : e.source_credit_long;
  const b = short ? e.backing_short : e.backing_long;
  const r = short ? e.insurance_reservation_short : e.insurance_reservation_long;
  checkV16(sourceCreditShapeErr(s));
  checkV16(backingBucketErr(b));
  checkV16(insuranceReservationErr(r));
  checkV16(sourceCreditErr(s));
  const id = e.asset.market_id;
  if (id === 0n) {
    if (!(sourceCreditEmpty(s) && bucketEmptyAmounts(b) && b.market_id === 0n && reservationEmpty(r))) failV16(V16_INVALID_CONFIG);
    return;
  }
  if (b.market_id !== id) failV16(V16_INVALID_CONFIG);
  if (b.fresh_unliened_backing_num > U128_MAX_L - b.valid_liened_backing_num) failV16(V16_ARITHMETIC_OVERFLOW);
  if (
    s.fresh_reserved_backing_num !== b.fresh_unliened_backing_num + b.valid_liened_backing_num ||
    s.provider_receivable_num !== b.consumed_liened_backing_num ||
    s.valid_liened_backing_num !== b.valid_liened_backing_num ||
    s.impaired_liened_backing_num !== b.impaired_liened_backing_num ||
    s.insurance_credit_reserved_num !== r.insurance_credit_reserved_num ||
    s.valid_liened_insurance_num !== r.valid_liened_insurance_num ||
    s.impaired_liened_insurance_num !== r.impaired_liened_insurance_num
  )
    failV16(V16_INVALID_CONFIG);
}

/** Where slot `asset`'s oracle profile starts. */
function dynamicProfileAt(asset: u64): u64 {
  return engineSlotAt(asset) - 512n;
}

/** UpdateAssetLifecycle's shutdown (the handler's second branch). */
function shutdownAsset(m: RemainingAccount, signer: Pubkey, asset: u64, expectedMarketId: u64, expectedEpoch: u64, nowSlot: u64, price: u64): void {
  const cfgPre = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  require(!(nowSlot === 0n || price !== 0n || cfgPre.force_close_delay_slots === 0n), PercolatorError.InvalidInstruction);
  const slot = currentSlot();
  require(!permissionlessStaleMatured(cfgPre, slot), PercolatorError.OracleStale);
  const markets = marketViewMut(m);
  requireLifecycleGeneration(m, markets, asset, false, expectedMarketId);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  const at = profileFromView(m, markets, asset);
  const p = loadRawMutAt<AssetOracleProfile>(m, at);
  const byAuthority = liveAuthorityMatches(loadRawAt<WrapperConfig>(m, HEADER_LEN).marketauth, signer);
  const byAdmin = liveAuthorityMatches(p.asset_admin, signer);
  require(byAuthority || byAdmin, PercolatorError.Unauthorized);
  requireAuthorityEpoch(m, markets, byAuthority ? 0n : asset, expectedEpoch);
  require(slot >= h.current_slot, PercolatorError.EngineStale);
  const life = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle;
  if (life === LIFECYCLE_ACTIVE || life === LIFECYCLE_DRAIN_ONLY) {
    accrueCommittedFundingBeforeShutdown(m, markets, at, asset, slot);
    const frozen = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.effective_price;
    require(frozen !== 0n && frozen <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
    forceAssetRecovery(m, markets, asset, slot);
    p.mark_ewma_e6 = frozen;
    p.mark_ewma_last_slot = slot;
    p.funding_mark_e6 = frozen;
    p.funding_mark_pending_e6 = 0n;
    p.funding_mark_pending_slot = 0n;
    p.oracle_target_price_e6 = frozen;
    p.oracle_target_publish_time = 0n;
    p.last_good_oracle_slot = slot;
    if (asset === 0n) mirrorManualToConfig(m, at, true);
    // write_oracle_profile_to_view validates the profile.
    validateAssetOracleProfile(p);
  } else require(life === LIFECYCLE_RECOVERY, PercolatorError.EngineLockActive);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWrapperConfig(loadRawAt<WrapperConfig>(m, HEADER_LEN));
}

// ---- RestartAssetOracle (tag 69) ------------------------------------------------------------------------------------------

/**
 * `restart_empty_asset_preserving_insurance_budget_not_atomic(asset, price, now)` (map_v16_error): an empty Recovery
 * or Retired asset of a market id normalized, then the slot rebuilt for the market's next id at the price, keeping
 * the domain insurance budgets; the counters advanced.
 */
function restartEmptyAsset(m: RemainingAccount, markets: u64, asset: u64, price: u64, now: u64): void {
  configuredAssetIndex(m, markets, asset);
  const h0 = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h0.mode));
  if (h0.mode !== 0n || price === 0n || price > MAX_ORACLE_PRICE || now < h0.current_slot) failV16(V16_INVALID_CONFIG);
  assetStateChecked(m, asset);
  const old = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  if (!(old.lifecycle === LIFECYCLE_RECOVERY || old.lifecycle === LIFECYCLE_RETIRED) || old.market_id === 0n) failV16(V16_LOCK_ACTIVE);
  normalizeTerminalEmptyAsset(m, markets, asset);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const marketId = h.next_market_id;
  if (marketId === 0n) failV16(V16_INVALID_CONFIG);
  if (marketId === U64_MAX_L || h.asset_activation_count === U64_MAX_L || h.asset_set_epoch === U64_MAX_L || h.risk_epoch === U64_MAX_L)
    failV16(V16_COUNTER_OVERFLOW);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const budgetLong = e.insurance_domain_budget_long;
  const budgetShort = e.insurance_domain_budget_short;
  writeEmptySlot(m, asset, marketId);
  const n = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  n.asset.raw_oracle_target_price = price;
  n.asset.effective_price = price;
  n.asset.fund_px_last = price;
  n.asset.slot_last = now;
  n.insurance_domain_budget_long = budgetLong;
  n.insurance_domain_budget_short = budgetShort;
  h.next_market_id = marketId + 1n;
  h.current_slot = now;
  h.asset_activation_count += 1n;
  h.last_asset_activation_slot = now;
  h.asset_set_epoch += 1n;
  h.risk_epoch += 1n;
  checkV16(marketShapeErr(h, markets));
}

/**
 * `handle_restart_asset_oracle(asset_index, market_id, now_slot, initial_price, observation_sequence,
 * authority_epoch)`: accounts authority (signer), market (w). A nonzero slot argument and a valid price
 * (InvalidInstruction); under the view: Live, not stale-matured, the asset configured and of the generation, the
 * Clock not behind the market, the asset in Recovery (EngineLockActive), its admin signs, its authority epoch, the
 * observation sequence advances; the engine's restart; the profile manual at the price keeping the policy and every
 * authority (mirrored for asset 0); the market's shape.
 *
 * @noinline
 */
export function restartAssetOracle(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 2n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(authority);
  writableCheck(m);
  ownerCheck(m, programId);
  const asset = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const nowSlot = data.readU64(11n);
  const price = data.readU64(19n);
  const sequence = data.readU64(27n);
  const expectedEpoch = data.readU64(35n);
  require(!(nowSlot === 0n || price === 0n || price > MAX_ORACLE_PRICE), PercolatorError.InvalidInstruction);
  const slot = currentSlot();
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  require(!permissionlessStaleMatured(loadRawAt<WrapperConfig>(m, HEADER_LEN), slot), PercolatorError.OracleStale);
  require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  require(slot >= h.current_slot, PercolatorError.EngineStale);
  require(loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle === LIFECYCLE_RECOVERY, PercolatorError.EngineLockActive);
  const at = profileFromView(m, markets, asset);
  const admin = loadRawAt<AssetOracleProfile>(m, at).asset_admin;
  expectLiveAuthority(admin, authority.key);
  requireAuthorityEpoch(m, markets, asset, expectedEpoch);
  advanceControlSequence(m, markets, asset, LANE_ORACLE_OBSERVATION, sequence);
  restartEmptyAsset(m, markets, asset, price, slot);
  writeManualProfile(m, at, price, slot, true, admin);
  if (asset === 0n) mirrorManualToConfig(m, at, true);
  validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWrapperConfig(loadRawAt<WrapperConfig>(m, HEADER_LEN));
}

// ---- CanonicalizeSpentBackingHistory (tag 70) ------------------------------------------------------------------------------

/**
 * `canonicalize_spent_backing_history_not_atomic(asset)` (map_v16_error): a Recovery or Retired asset whose domains
 * hold only matched spent-backing history (consumed = provider receivable ≤ spent, nothing else) get the empty bucket
 * and source state; NonProgress when neither domain has any; then the asset must be empty.
 */
function canonicalizeSpentBacking(m: RemainingAccount, markets: u64, asset: u64): void {
  configuredAssetIndex(m, markets, asset);
  assetStateChecked(m, asset);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  if (!(a.lifecycle === LIFECYCLE_RECOVERY || a.lifecycle === LIFECYCLE_RETIRED)) failV16(V16_LOCK_ACTIVE);
  const marketId = a.market_id;
  let changed = false;
  for (let side = 0n; side < 2n; side++) {
    const short = side === 1n;
    domainIndex(m, markets, asset, short);
    const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
    const b = short ? e.backing_short : e.backing_long;
    checkV16(backingBucketErr(b));
    const s = short ? e.source_credit_short : e.source_credit_long;
    checkV16(sourceCreditShapeErr(s));
    if (b.consumed_liened_backing_num === 0n && s.provider_receivable_num === 0n) continue;
    const historyOnly =
      b.fresh_unliened_backing_num === 0n &&
      b.valid_liened_backing_num === 0n &&
      b.impaired_liened_backing_num === 0n &&
      b.utilization_fee_earnings === 0n &&
      b.market_id === marketId &&
      s.provider_receivable_num === b.consumed_liened_backing_num &&
      s.spent_backing_num >= s.provider_receivable_num &&
      s.positive_claim_bound_num === 0n &&
      s.exact_positive_claim_num === 0n &&
      s.fresh_reserved_backing_num === 0n &&
      s.valid_liened_backing_num === 0n &&
      s.impaired_liened_backing_num === 0n &&
      s.insurance_credit_reserved_num === 0n &&
      s.valid_liened_insurance_num === 0n &&
      s.impaired_liened_insurance_num === 0n;
    if (!historyOnly) failV16(V16_LOCK_ACTIVE);
    const r = short ? e.insurance_reservation_short : e.insurance_reservation_long;
    checkV16(insuranceReservationErr(r));
    if (!reservationEmpty(r)) failV16(V16_LOCK_ACTIVE);
    setBucketEmpty(m, asset, short, b.market_id);
    // set_source_credit_for_domain(EMPTY): the shape again (passed), the totals move by zero (no claim bound, fresh
    // backing or insurance in a history-only state).
    setSourceCreditEmpty(m, asset, short);
    changed = true;
  }
  if (!changed) failV16(V16_NON_PROGRESS);
  requireEmptyAssetLifecycle(m, markets, asset);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `handle_canonicalize_spent_backing_history(asset_index, market_id, authority_epoch)`: accounts authority (signer),
 * market (w). Under the view: Live, the asset configured and in the view, its generation, the long domain's backing
 * authority signs (Unauthorized), the asset's authority epoch; the engine's canonicalization; the market's shape.
 *
 * @noinline
 */
export function canonicalizeSpentBackingHistory(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 2n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(authority);
  writableCheck(m);
  ownerCheck(m, programId);
  const asset = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const expectedEpoch = data.readU64(11n);
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  // domain_authorities_from_view(2 · asset): the domain configured and in the view (it is), the profile validated.
  const backing = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, asset)).backing_bucket_authority;
  require(liveAuthorityMatches(backing, authority.key), PercolatorError.Unauthorized);
  requireAuthorityEpoch(m, markets, asset, expectedEpoch);
  canonicalizeSpentBacking(m, markets, asset);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}
