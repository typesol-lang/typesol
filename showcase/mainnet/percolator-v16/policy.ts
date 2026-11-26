// A port of Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog src/v16_program.rs,
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Changes: rewritten in TypeSOL. Ported here: the authority, policy and ledger handlers (`handle_update_authority`,
// `handle_update_asset_authority`, `handle_update_market_authority_policy` for UpdateLiquidationFeePolicy,
// UpdateMaintenanceFeePolicy, UpdateFeeRedirectPolicy and UpdateMarketInitFeePolicy, `handle_update_backing_fee_policy`,
// `handle_update_trade_fee_policy`, `handle_configure_permissionless_resolve`, `handle_update_base_unit_mints`,
// `handle_sync_backing_domain_ledger`, `handle_sync_insurance_ledger`).
//
// Each handler is the original's, check for check in its order; the arguments are read at fixed offsets after decode
// has checked the length. The wrapper config, the oracle profiles and the control sequences change in place
// (program.ts says why that is the same bytes). `write_wrapper_config` and `write_oracle_profile_to_view` validate the
// value they write; where only fields their validation does not look at changed, or values already held to the same
// bounds, the handler says so and does not validate again.
//
// Repeated accounts. The two ledger handlers hold a mutable borrow of the market's data while they borrow the ledger's:
// the market passed again as the ledger fails that borrow with AccountBorrowFailed, which the port checks by key at
// the same point. No other repeated pair reaches a borrow conflict: the token and mint accounts are owner-checked
// before their data is borrowed, and a market is never one of them.
import {
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type u64,
  type u128,
  ProgramError,
  currentSlot,
  loadRawAt,
  loadRawMutAt,
  readData,
  require,
  u64 as toU64,
} from "typesol";
import { PercolatorError, checkV16 } from "./errors.js";
import {
  type AccountHeader,
  type AssetOracleProfile,
  type BackingBucket,
  type BackingDomainLedger,
  type EngineAssetSlot,
  type GroupHeader,
  type InsuranceLedger,
  type WrapperConfig,
  BACKING_DOMAIN_LEDGER_ACCOUNT_LEN,
  HEADER_LEN,
  INSURANCE_LEDGER_ACCOUNT_LEN,
  KIND_BACKING_DOMAIN_LEDGER,
  KIND_INSURANCE_LEDGER,
  MARKET_GROUP_OFF,
  MAX_DYNAMIC_TRADE_FEE_BPS,
  MAX_FORCE_CLOSE_DELAY_SLOTS,
  MAX_PERMISSIONLESS_RESOLVE_STALE_SLOTS,
  ZERO_KEY,
  assetSlotAt,
  backingDomainLedgerAt,
  insuranceLedgerAt,
  isInitialized,
  validateBackingDomainLedger,
  validateInsuranceLedger,
  validateWrapperConfig,
  writeHeaderView,
} from "./state.js";
import { LIFECYCLE_ACTIVE, LIFECYCLE_RETIRED, domainInsuranceBudgetRemaining, engineSlotAt } from "./engine.js";
import {
  LANE_FEE_REDIRECT,
  LANE_LIQUIDATION_FEE,
  LANE_MAINTENANCE_FEE,
  LANE_MARKET_INIT_FEE,
  LANE_PERMISSIONLESS_RESOLVE,
  LANE_TRADE_FEE,
  advanceAuthorityEpoch,
  advanceBackingFeeSequence,
  advanceControlSequence,
  backingDomainPartsCheck,
  backingUnavailableAtoms,
  expectIncomingAuthority,
  expectLiveAuthority,
  keyCheck,
  liveAuthorityMatches,
  marketViewMut,
  needAccounts,
  ownerCheck,
  permissionlessStaleMatured,
  profileFromView,
  readAssetOracleProfileState,
  readMarketTradePreflight,
  requireAssetGeneration,
  requireAuthorityEpoch,
  signerCheck,
  unpackMintV16,
  vaultAuthorityOf,
  verifyVaultTokenAccount,
  writableCheck,
} from "./program.js";

const U128_MAX_Q = 0xffffffffffffffffffffffffffffffffn;
/** The asset-authority kinds of UpdateAssetAuthority. */
const ASSET_AUTH_ADMIN = 0n;
const ASSET_AUTH_INSURANCE = 1n;
const ASSET_AUTH_INSURANCE_OPERATOR = 2n;
const ASSET_AUTH_BACKING_BUCKET = 3n;
const ASSET_AUTH_ORACLE = 4n;

// ---- UpdateAuthority (tag 32) --------------------------------------------------------------------------------------------

/**
 * `handle_update_authority(authority_epoch, new_pubkey)`: accounts current (signer), new authority, market. The new
 * key signs (a zero key is refused); the current market authority signs; asset 0's roles held by the old authority
 * move to the new one; asset 0's authority epoch advances; the market authority becomes the new key.
 *
 * @noinline
 */
export function updateAuthority(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 3n);
  const current = rest.get(0n);
  const newAuthority = rest.get(1n);
  const m = rest.get(2n);
  signerCheck(current);
  writableCheck(m);
  ownerCheck(m, programId);
  const expectedEpoch = data.readU64(1n);
  const newKey = data.readPubkey(9n);
  expectIncomingAuthority(newAuthority, newKey, false);
  const markets = marketViewMut(m);
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  expectLiveAuthority(cfg.marketauth, current.key);
  const old = cfg.marketauth;
  const p = loadRawMutAt<AssetOracleProfile>(m, profileFromView(m, markets, 0n));
  if (p.asset_admin === old) p.asset_admin = newKey;
  if (p.insurance_authority === old) p.insurance_authority = newKey;
  if (p.insurance_operator === old) p.insurance_operator = newKey;
  if (p.backing_bucket_authority === old) p.backing_bucket_authority = newKey;
  if (p.oracle_authority === old) p.oracle_authority = newKey;
  advanceAuthorityEpoch(m, markets, 0n, expectedEpoch);
  // write_oracle_profile_to_view and write_wrapper_config validate what they write: only authority keys changed,
  // which neither validation looks at.
  cfg.marketauth = newKey;
}

// ---- UpdateAssetAuthority (tag 65) ---------------------------------------------------------------------------------------

/**
 * `asset_authority_role_has_funded_value_view`: the insurance roles while either domain has an insurance budget, the
 * backing role while either bucket holds anything, the oracle while the asset has exposure or loss state, never the
 * admin (InvalidInstruction for another kind, unreachable after the caller's own check).
 */
function roleHasFundedValue(ma: RemainingAccount, markets: u64, asset: u64, kind: u64): boolean {
  require(asset < markets, PercolatorError.InvalidInstruction);
  const e = loadRawAt<EngineAssetSlot>(ma, engineSlotAt(asset));
  if (kind === ASSET_AUTH_INSURANCE || kind === ASSET_AUTH_INSURANCE_OPERATOR)
    return e.insurance_domain_budget_long !== 0n || e.insurance_domain_budget_short !== 0n;
  if (kind === ASSET_AUTH_BACKING_BUCKET) {
    const l = e.backing_long;
    const s = e.backing_short;
    return (
      l.fresh_unliened_backing_num !== 0n ||
      l.valid_liened_backing_num !== 0n ||
      l.consumed_liened_backing_num !== 0n ||
      l.impaired_liened_backing_num !== 0n ||
      l.utilization_fee_earnings !== 0n ||
      s.fresh_unliened_backing_num !== 0n ||
      s.valid_liened_backing_num !== 0n ||
      s.consumed_liened_backing_num !== 0n ||
      s.impaired_liened_backing_num !== 0n ||
      s.utilization_fee_earnings !== 0n
    );
  }
  if (kind === ASSET_AUTH_ORACLE) {
    // asset_local_has_exposure_or_loss_state_view (the asset is configured and in the view here).
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
      e.pending_domain_loss_barrier_long !== 0n ||
      e.pending_domain_loss_barrier_short !== 0n
    );
  }
  require(kind === ASSET_AUTH_ADMIN, PercolatorError.InvalidInstruction);
  return false;
}

/**
 * `handle_update_asset_authority(asset_index, market_id, authority_epoch, kind, new_pubkey)`: accounts current
 * (signer), new authority, market. The new key signs unless it burns (zero); the asset is configured and of the
 * expected generation; the asset's admin or the role's incumbent signs (the admin alone cannot move a role that holds
 * funded value: EngineLockActive); a zero key only for the admin role; the asset's authority epoch advances and the
 * role takes the new key.
 *
 * @noinline
 */
export function updateAssetAuthority(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 3n);
  const current = rest.get(0n);
  const newAuthority = rest.get(1n);
  const m = rest.get(2n);
  signerCheck(current);
  writableCheck(m);
  ownerCheck(m, programId);
  const asset = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const expectedEpoch = data.readU64(11n);
  const kind = toU64(data.readU8(19n));
  const newKey = data.readPubkey(20n);
  expectIncomingAuthority(newAuthority, newKey, true);
  const markets = marketViewMut(m);
  require(asset < toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots), PercolatorError.InvalidInstruction);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  const p = loadRawMutAt<AssetOracleProfile>(m, profileFromView(m, markets, asset));
  const adminSigned = p.asset_admin !== ZERO_KEY && p.asset_admin === current.key;
  require(kind <= ASSET_AUTH_ORACLE, PercolatorError.InvalidInstruction);
  const currentValue =
    kind === ASSET_AUTH_ADMIN
      ? p.asset_admin
      : kind === ASSET_AUTH_INSURANCE
        ? p.insurance_authority
        : kind === ASSET_AUTH_INSURANCE_OPERATOR
          ? p.insurance_operator
          : kind === ASSET_AUTH_BACKING_BUCKET
            ? p.backing_bucket_authority
            : p.oracle_authority;
  require(!(newKey === ZERO_KEY && kind !== ASSET_AUTH_ADMIN), PercolatorError.InvalidInstruction);
  const currentSigned = liveAuthorityMatches(currentValue, current.key);
  require(adminSigned || currentSigned, PercolatorError.Unauthorized);
  if (adminSigned && !currentSigned) require(!roleHasFundedValue(m, markets, asset, kind), PercolatorError.EngineLockActive);
  advanceAuthorityEpoch(m, markets, asset, expectedEpoch);
  if (kind === ASSET_AUTH_ADMIN) p.asset_admin = newKey;
  else if (kind === ASSET_AUTH_INSURANCE) p.insurance_authority = newKey;
  else if (kind === ASSET_AUTH_INSURANCE_OPERATOR) p.insurance_operator = newKey;
  else if (kind === ASSET_AUTH_BACKING_BUCKET) p.backing_bucket_authority = newKey;
  else p.oracle_authority = newKey;
  // write_oracle_profile_to_view: one authority key changed, which validate_asset_oracle_profile does not look at.
}

// ---- The market-authority policies (tags 37, 49, 58, 59) ----------------------------------------------------------------

/**
 * `handle_update_market_authority_policy`: accounts admin (signer), market. The value's own check (`validate`: a bps
 * share at most 10,000, a market-init fee within u64: InvalidInstruction); the market authority signs; asset 0's
 * authority epoch as expected; the policy's control sequence advances; the config field takes the value.
 *
 * @noinline
 */
export function updateMarketAuthorityPolicy(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey, tag: u64): void {
  needAccounts(rest, 2n);
  const admin = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(admin);
  writableCheck(m);
  ownerCheck(m, programId);
  const initFee = tag === 59n;
  const bps = initFee ? 0n : data.readU16(1n);
  const fee = initFee ? data.readU128(1n) : 0n;
  const sequence = data.readU64(initFee ? 17n : 3n);
  const expectedEpoch = data.readU64(initFee ? 25n : 11n);
  if (initFee) require(fee <= 0xffffffffffffffffn, PercolatorError.InvalidInstruction);
  else require(bps <= 10000n, PercolatorError.InvalidInstruction);
  const markets = marketViewMut(m);
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  expectLiveAuthority(cfg.marketauth, admin.key);
  requireAuthorityEpoch(m, markets, 0n, expectedEpoch);
  const lane = tag === 37n ? LANE_LIQUIDATION_FEE : tag === 49n ? LANE_MAINTENANCE_FEE : tag === 58n ? LANE_FEE_REDIRECT : LANE_MARKET_INIT_FEE;
  advanceControlSequence(m, markets, 0n, lane, sequence);
  // write_wrapper_config: the bps values were held to 10,000 above, as validate_wrapper_config holds them; the
  // market-init fee is not validated.
  if (tag === 37n) cfg.liquidation_cranker_fee_share_bps = bps;
  else if (tag === 49n) cfg.maintenance_cranker_fee_share_bps = bps;
  else if (tag === 58n) cfg.fee_redirect_to_market_0_bps = bps;
  else cfg.permissionless_market_init_fee = fee;
}

// ---- UpdateBackingFeePolicy (tag 51) ---------------------------------------------------------------------------------------

/**
 * `handle_update_backing_fee_policy(domain, market_id, fee_bps, insurance_share_bps, policy_sequence,
 * authority_epoch)`: accounts authority (signer), market. The trade preflight of the domain's asset (generation, Live);
 * the asset's insurance authority signs; the policy's shape and the market's maximum trading fee
 * (InvalidInstruction); under the market view: the asset in the view, its generation and authority epoch, not retired
 * (and Active for a nonzero fee), the bucket empty unless the policy is unchanged (EngineLockActive), the backing-fee
 * sequence advanced; then the config's policy count and (for asset 0) its fields, and the asset's profile.
 *
 * @noinline
 */
export function updateBackingFeePolicy(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 2n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(authority);
  writableCheck(m);
  ownerCheck(m, programId);
  const domain = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const feeBps = data.readU16(11n);
  const shareBps = data.readU16(13n);
  const sequence = data.readU64(15n);
  const expectedEpoch = data.readU64(23n);
  const asset = domain / 2n;
  const mode = readMarketTradePreflight(m, asset);
  require(readData<u64>(m, assetSlotAt(m, asset)) === expectedMarketId, PercolatorError.AssetGenerationMismatch);
  require(mode === 0n, PercolatorError.EngineLockActive);
  const maxTradingFeeBps = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_trading_fee_bps;
  const p = loadRawMutAt<AssetOracleProfile>(m, readAssetOracleProfileState(m, asset));
  expectLiveAuthority(p.insurance_authority, authority.key);
  const long = domain % 2n === 0n;
  const currentFee = long ? p.backing_trade_fee_bps_long : p.backing_trade_fee_bps_short;
  const currentShare = long ? p.backing_trade_fee_insurance_share_bps_long : p.backing_trade_fee_insurance_share_bps_short;
  require(
    !(feeBps > 10000n || shareBps > 10000n || (feeBps === 0n && shareBps !== 0n) || toU64(feeBps) > maxTradingFeeBps || toU64(feeBps) > MAX_DYNAMIC_TRADE_FEE_BPS),
    PercolatorError.InvalidInstruction,
  );
  const markets = marketViewMut(m);
  require(asset < markets, PercolatorError.EngineLockActive);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  requireAuthorityEpoch(m, markets, asset, expectedEpoch);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const lifecycle = e.asset.lifecycle;
  require(!(lifecycle === LIFECYCLE_RETIRED || (feeBps !== 0n && lifecycle !== LIFECYCLE_ACTIVE)), PercolatorError.EngineLockActive);
  backingDomainPartsCheck(m, markets, domain);
  const b = long ? e.backing_long : e.backing_short;
  // policy_v16::backing_fee_policy_change_allowed.
  const unchanged = currentFee === feeBps && currentShare === shareBps;
  const empty =
    b.fresh_unliened_backing_num === 0n &&
    b.valid_liened_backing_num === 0n &&
    b.consumed_liened_backing_num === 0n &&
    b.impaired_liened_backing_num === 0n &&
    b.utilization_fee_earnings === 0n;
  require(unchanged || empty, PercolatorError.EngineLockActive);
  advanceBackingFeeSequence(m, markets, asset, sequence);
  // state::read_asset_oracle_profile again (the same checks, passed above), then adjust_policy_count on the config.
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  if (currentFee === 0n && feeBps !== 0n) {
    require(cfg.backing_trade_fee_policy_count !== 0xffffn, PercolatorError.EngineArithmeticOverflow);
    cfg.backing_trade_fee_policy_count += 1n;
  } else if (currentFee !== 0n && feeBps === 0n) {
    require(cfg.backing_trade_fee_policy_count !== 0n, PercolatorError.EngineCounterUnderflow);
    cfg.backing_trade_fee_policy_count -= 1n;
  }
  if (asset === 0n) {
    if (long) {
      cfg.backing_trade_fee_bps_long = feeBps;
      cfg.backing_trade_fee_insurance_share_bps_long = shareBps;
    } else {
      cfg.backing_trade_fee_bps_short = feeBps;
      cfg.backing_trade_fee_insurance_share_bps_short = shareBps;
    }
  }
  if (long) {
    p.backing_trade_fee_bps_long = feeBps;
    p.backing_trade_fee_insurance_share_bps_long = shareBps;
  } else {
    p.backing_trade_fee_bps_short = feeBps;
    p.backing_trade_fee_insurance_share_bps_short = shareBps;
  }
  // write_wrapper_config validates the config: the policy count against the config's own fees can fail here (an
  // asset other than 0 changes the count alone). write_asset_oracle_profile's validation holds: the policy's shape was
  // checked above.
  validateWrapperConfig(cfg);
}

// ---- UpdateTradeFeePolicy (tag 55) ---------------------------------------------------------------------------------------

/**
 * `handle_update_trade_fee_policy(trade_fee_base_bps, policy_sequence, authority_epoch)`: accounts authority (signer),
 * market. Asset 0's trade preflight and profile; its insurance authority signs; the fee within the market's maximum
 * and 10,000 (InvalidInstruction); asset 0's authority epoch; the trade-fee sequence advances; the config's base fee.
 *
 * @noinline
 */
export function updateTradeFeePolicy(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 2n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(authority);
  writableCheck(m);
  ownerCheck(m, programId);
  const fee = data.readU64(1n);
  const sequence = data.readU64(9n);
  const expectedEpoch = data.readU64(17n);
  readMarketTradePreflight(m, 0n);
  const maxTradingFeeBps = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_trading_fee_bps;
  const p = loadRawAt<AssetOracleProfile>(m, readAssetOracleProfileState(m, 0n));
  expectLiveAuthority(p.insurance_authority, authority.key);
  require(fee <= maxTradingFeeBps && fee <= MAX_DYNAMIC_TRADE_FEE_BPS, PercolatorError.InvalidInstruction);
  const markets = marketViewMut(m);
  requireAuthorityEpoch(m, markets, 0n, expectedEpoch);
  advanceControlSequence(m, markets, 0n, LANE_TRADE_FEE, sequence);
  // write_wrapper_config: trade_fee_base_bps is not validated.
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  cfg.trade_fee_base_bps = fee;
}

// ---- ConfigurePermissionlessResolve (tag 38) --------------------------------------------------------------------------------

/**
 * `handle_configure_permissionless_resolve(asset_generation_frontier, stale_slots, force_close_delay_slots,
 * policy_sequence, authority_epoch)`: accounts admin (signer), market. Both windows nonzero and within their maxima
 * (InvalidInstruction); the market's next asset generation as expected; the market authority signs; asset 0's
 * authority epoch; Live; not already stale-matured (by the Clock); the sequence advances; both windows stored.
 *
 * @noinline
 */
export function configurePermissionlessResolve(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 2n);
  const admin = rest.get(0n);
  const m = rest.get(1n);
  signerCheck(admin);
  writableCheck(m);
  ownerCheck(m, programId);
  const frontier = data.readU64(1n);
  const staleSlots = data.readU64(9n);
  const forceCloseDelay = data.readU64(17n);
  const sequence = data.readU64(25n);
  const expectedEpoch = data.readU64(33n);
  require(
    !(staleSlots === 0n || staleSlots > MAX_PERMISSIONLESS_RESOLVE_STALE_SLOTS || forceCloseDelay === 0n || forceCloseDelay > MAX_FORCE_CLOSE_DELAY_SLOTS),
    PercolatorError.InvalidInstruction,
  );
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.next_market_id === frontier, PercolatorError.AssetGenerationMismatch);
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  expectLiveAuthority(cfg.marketauth, admin.key);
  requireAuthorityEpoch(m, markets, 0n, expectedEpoch);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  // authenticated_slot_or_fallback(0): the Clock's slot.
  require(!permissionlessStaleMatured(cfg, currentSlot()), PercolatorError.OracleStale);
  advanceControlSequence(m, markets, 0n, LANE_PERMISSIONLESS_RESOLVE, sequence);
  // write_wrapper_config: neither window is validated.
  cfg.permissionless_resolve_stale_slots = staleSlots;
  cfg.force_close_delay_slots = forceCloseDelay;
}

// ---- UpdateBaseUnitMints (tag 60) ------------------------------------------------------------------------------------------

/**
 * `handle_update_base_unit_mints(primary_mint, secondary_mint, authority_epoch)`: accounts authority (signer), market,
 * primary mint, secondary mint, then the old vault of each mint that changes. Two distinct nonzero mints, passed at
 * their keys (InvalidArgument), both SPL Token mints of the same decimals (InvalidMint); the market authority signs;
 * asset 0's authority epoch; an empty market (vault, capital and insurance zero: EngineLockActive); each replaced
 * mint's canonical vault empty; then both mints stored.
 *
 * @noinline
 */
export function updateBaseUnitMints(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 4n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  const primaryAi = rest.get(2n);
  const secondaryAi = rest.get(3n);
  signerCheck(authority);
  writableCheck(m);
  ownerCheck(m, programId);
  const primary = data.readPubkey(1n);
  const secondary = data.readPubkey(33n);
  const expectedEpoch = data.readU64(65n);
  require(!(primary === ZERO_KEY || secondary === ZERO_KEY || primary === secondary), PercolatorError.InvalidMint);
  keyCheck(primaryAi, primary);
  keyCheck(secondaryAi, secondary);
  const primaryDecimals = unpackMintV16(primaryAi);
  require(unpackMintV16(secondaryAi) === primaryDecimals, PercolatorError.InvalidMint);
  const markets = marketViewMut(m);
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  expectLiveAuthority(cfg.marketauth, authority.key);
  requireAuthorityEpoch(m, markets, 0n, expectedEpoch);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.vault === 0n && h.c_tot === 0n && h.insurance === 0n, PercolatorError.EngineLockActive);
  const previousPrimary = cfg.collateral_mint;
  const previousSecondary = cfg.secondary_collateral_mint;
  let next = 4n;
  if (previousPrimary !== primary) {
    needAccounts(rest, next + 1n);
    require(verifyVaultTokenAccount(rest.get(next), vaultAuthorityOf(m.key, programId), previousPrimary) === 0n, PercolatorError.EngineLockActive);
    next += 1n;
  }
  if (previousSecondary !== ZERO_KEY && previousSecondary !== secondary) {
    needAccounts(rest, next + 1n);
    require(verifyVaultTokenAccount(rest.get(next), vaultAuthorityOf(m.key, programId), previousSecondary) === 0n, PercolatorError.EngineLockActive);
  }
  // write_wrapper_config: two distinct nonzero mints pass validate_wrapper_config's mint check.
  cfg.collateral_mint = primary;
  cfg.secondary_collateral_mint = secondary;
}

// ---- The ledgers (tags 53, 54) ---------------------------------------------------------------------------------------------

/** Whether all `n` bytes of an account's data are zero (`data.iter().any(|b| *b != 0)` negated), word by word. */
export function allZero(a: RemainingAccount, n: u64): boolean {
  for (let at = 0n; at < n; at += 8n) if (readData<u64>(a, at) !== 0n) return false;
  return true;
}

/**
 * `handle_sync_backing_domain_ledger(domain)`: accounts authority (signer), market (w), ledger (w), both the program's.
 * The domain's backing authority signs; the domain's bucket; the ledger read (its market, authority and domain:
 * Unauthorized) or, all zero, created; synced with the bucket (earnings, losses, recoveries); written.
 *
 * @noinline
 */
export function syncBackingDomainLedger(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 3n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  const la = rest.get(2n);
  signerCheck(authority);
  writableCheck(m);
  writableCheck(la);
  ownerCheck(m, programId);
  ownerCheck(la, programId);
  const domain = toU64(data.readU16(1n));
  const markets = marketViewMut(m);
  // domain_authorities_from_view.
  require(domain < 2n * toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots) && domain / 2n < markets, PercolatorError.InvalidInstruction);
  const backingAuthority = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, domain / 2n)).backing_bucket_authority;
  expectLiveAuthority(backingAuthority, authority.key);
  backingDomainPartsCheck(m, markets, domain);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(domain / 2n));
  const b = domain % 2n === 0n ? e.backing_long : e.backing_short;
  // The ledger's data borrowed while the market's is: the market again fails the borrow.
  require(la.key !== m.key, ProgramError.AccountBorrowFailed);
  require(la.dataLen === BACKING_DOMAIN_LEDGER_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  if (isInitialized(la)) {
    const l = loadRawMutAt<BackingDomainLedger>(la, backingDomainLedgerAt(la));
    validateBackingDomainLedger(l);
    require(l.market_group === m.key && l.authority === backingAuthority && toU64(l.domain) === domain, PercolatorError.Unauthorized);
    // sync_backing_domain_ledger: the earnings first, then the unavailable principal (its sum can overflow).
    syncBacking(l, b.utilization_fee_earnings, b);
    // write_backing_domain_ledger validates it again: the keys and padding did not change.
    return;
  }
  require(allZero(la, BACKING_DOMAIN_LEDGER_ACCOUNT_LEN), ProgramError.InvalidAccountData);
  const unavailable = backingUnavailableAtoms(b);
  // A new ledger (its observations the bucket's now, so the sync adds nothing), then init_backing_domain_ledger: the
  // account is zero, so only the header and the nonzero fields are written; its validation holds (two set keys: the
  // market's and a live authority's).
  const header = loadRawMutAt<AccountHeader>(la, 0n);
  writeHeaderView(header, KIND_BACKING_DOMAIN_LEDGER);
  const l = loadRawMutAt<BackingDomainLedger>(la, HEADER_LEN);
  l.market_group = m.key;
  l.authority = backingAuthority;
  l.last_observed_bucket_earnings_atoms = b.utilization_fee_earnings;
  l.last_observed_unavailable_principal_atoms = unavailable;
  l.domain = data.readU16(1n);
}

/** `sync_backing_domain_ledger`: earnings since the last observation, unavailable principal as loss or recovery. */
export function syncBacking(l: Inout<BackingDomainLedger>, earnings: u128, b: BackingBucket): void {
  if (earnings >= l.last_observed_bucket_earnings_atoms) {
    const delta = earnings - l.last_observed_bucket_earnings_atoms;
    require(l.total_earnings_atoms <= U128_MAX_Q - delta, PercolatorError.EngineArithmeticOverflow);
    l.total_earnings_atoms += delta;
  }
  l.last_observed_bucket_earnings_atoms = earnings;
  const unavailable = backingUnavailableAtoms(b);
  if (unavailable >= l.last_observed_unavailable_principal_atoms) {
    const delta = unavailable - l.last_observed_unavailable_principal_atoms;
    require(l.cumulative_loss_atoms <= U128_MAX_Q - delta, PercolatorError.EngineArithmeticOverflow);
    l.cumulative_loss_atoms += delta;
  } else {
    const delta = l.last_observed_unavailable_principal_atoms - unavailable;
    require(l.cumulative_recovery_atoms <= U128_MAX_Q - delta, PercolatorError.EngineArithmeticOverflow);
    l.cumulative_recovery_atoms += delta;
  }
  l.last_observed_unavailable_principal_atoms = unavailable;
}

/**
 * `handle_sync_insurance_ledger`: accounts authority (signer), market (w), ledger (w), both the program's. Asset 0's
 * insurance authority signs; the market's insurance remaining for asset 0 (both domains' budgets, at most the
 * insurance); the ledger read (its market and authority: Unauthorized) or, all zero, created; synced; written.
 *
 * @noinline
 */
export function syncInsuranceLedger(rest: RemainingAccounts, programId: Pubkey): void {
  needAccounts(rest, 3n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  const la = rest.get(2n);
  signerCheck(authority);
  writableCheck(m);
  writableCheck(la);
  ownerCheck(m, programId);
  ownerCheck(la, programId);
  const markets = marketViewMut(m);
  // domain_authorities_from_view(0): domain 0 is configured and asset 0 in the view (the view has a slot).
  const insuranceAuthority = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, 0n)).insurance_authority;
  expectLiveAuthority(insuranceAuthority, authority.key);
  require(la.key !== m.key, ProgramError.AccountBorrowFailed);
  // market_insurance_remaining_view(0).
  const long = domainInsuranceBudgetRemaining(m, markets, 0n);
  const short = domainInsuranceBudgetRemaining(m, markets, 1n);
  require(long <= U128_MAX_Q - short, PercolatorError.EngineArithmeticOverflow);
  const insurance = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).insurance;
  const observed = long + short < insurance ? long + short : insurance;
  require(la.dataLen === INSURANCE_LEDGER_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  if (isInitialized(la)) {
    const l = loadRawMutAt<InsuranceLedger>(la, insuranceLedgerAt(la));
    validateInsuranceLedger(l);
    require(l.market_group === m.key && l.authority === insuranceAuthority, PercolatorError.Unauthorized);
    // sync_insurance_ledger; write_insurance_ledger's validation holds (the keys did not change).
    if (observed >= l.last_observed_insurance_atoms) {
      const delta = observed - l.last_observed_insurance_atoms;
      require(l.cumulative_profit_atoms <= U128_MAX_Q - delta, PercolatorError.EngineArithmeticOverflow);
      l.cumulative_profit_atoms += delta;
    } else {
      const delta = l.last_observed_insurance_atoms - observed;
      require(l.cumulative_loss_atoms <= U128_MAX_Q - delta, PercolatorError.EngineArithmeticOverflow);
      l.cumulative_loss_atoms += delta;
    }
    l.last_observed_insurance_atoms = observed;
    return;
  }
  require(allZero(la, INSURANCE_LEDGER_ACCOUNT_LEN), ProgramError.InvalidAccountData);
  const header = loadRawMutAt<AccountHeader>(la, 0n);
  writeHeaderView(header, KIND_INSURANCE_LEDGER);
  const l = loadRawMutAt<InsuranceLedger>(la, HEADER_LEN);
  l.market_group = m.key;
  l.authority = insuranceAuthority;
  l.last_observed_insurance_atoms = observed;
}
