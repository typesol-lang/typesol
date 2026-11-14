// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// What the graduation instructions need beyond the swap: the DAMM v2 accounts the migration reads (the pool config it
// is given, the pool and the second position it creates; their layouts from DBC's `idls/damm_v2.json`, which its
// `declare_program!` builds them from), the config validation of migrate_damm_v2_initialize_pool.rs, the liquidity
// split of state/config.rs (LiquidityDistribution, LiquidityDistributionItem), the migrated pool's fee parameters
// (PoolConfig::build_damm_v2_pool_fee_params), the migration fee split, and the mint reads of utils/token.rs on
// accounts the migration takes unchecked.
import { type AccountInfo, type Inout, type Pubkey, type RemainingAccount, AnchorError, currentEpoch, pubkey, readData, require, u8, u16, u32, u64, u128 } from "typesol";
import { DEFAULT_PUBKEY } from "./config";
import { PoolError } from "./errors";
import { DAMM_V2_FEE_DENOMINATOR, MAX_DYNAMIC_FEE_PERCENT, SQUARE_VFA_BIN, marketCapMinBaseFeeNumerator, toBps, toNumerator } from "./fees";
import { type U64Pair, addU128, addU8, safeMulDivCastU128, safeMulDivCastU64, subU128, subU64 } from "./math";
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE, migrationQuoteAmount } from "./migration";
import { POOL_AUTHORITY } from "./process_swap";
import {
  type PoolConfig,
  DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL,
  DAMM_V2_FEE_MARKET_CAP_SCHEDULER_LINEAR,
  DAMM_V2_FEE_TIME_SCHEDULER_EXPONENTIAL,
  DAMM_V2_FEE_TIME_SCHEDULER_LINEAR,
  MIGRATION_FEE_OPTION_CUSTOMIZABLE,
} from "./state";
import { EXT_TRANSFER_FEE_CONFIG, TLV_START, TOKEN_PROGRAM_ID } from "./token";

export const DAMM_V2_PROGRAM_ID = pubkey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const LOCKER_PROGRAM_ID = pubkey("LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn");
/** damm_v2::constants::SPLIT_POSITION_DENOMINATOR */
export const SPLIT_POSITION_DENOMINATOR: u32 = 1_000_000_000n;
/** constants.rs PARTNER_AND_CREATOR_SURPLUS_SHARE */
const PARTNER_AND_CREATOR_SURPLUS_SHARE: u64 = 80n;

/** sha256("account:<Name>")[..8] of DAMM v2's Config, Pool and Position, as little-endian u64s. */
const DISC_DAMM_CONFIG: u64 = 9425183130704809115n;
const DISC_DAMM_POOL: u64 = 13577703138238765809n;
const DISC_DAMM_POSITION: u64 = 15057574775701355690n;

/** Anchor's AccountLoader::try_from of another program's zero-copy account: owner, then the discriminator. */
function requireDammAccount(owner: Pubkey, dataLen: u64, disc: u64, want: u64): void {
  require(owner === DAMM_V2_PROGRAM_ID, AnchorError.AccountOwnedByWrongProgram);
  require(dataLen >= 8n, AnchorError.AccountDiscriminatorNotFound);
  require(disc === want, AnchorError.AccountDiscriminatorMismatch);
}

// ---- migrate_damm_v2_initialize_pool.rs: validate_config_key ----------------------------------------------------

/**
 * validate_config_key on the DAMM v2 config (remaining account 0), loaded as AccountLoader<damm_v2::Config>. Config:
 * vault_config_key @8, pool_creator_authority @40, pool_fees.base_fee.data @72 (as PodAlignedFeeTimeScheduler:
 * cliff_fee_numerator @72, base_fee_mode @80, number_of_period @86, period_frequency @88, reduction_factor @96),
 * activation_type @200, sqrt_min_price @216, sqrt_max_price @232.
 */
export function validateDammConfig(cfg: RemainingAccount, migrationFeeOption: u8): void {
  requireDammAccount(cfg.owner, cfg.dataLen, cfg.dataLen >= 8n ? readData<u64>(cfg, 0n) : 0n, DISC_DAMM_CONFIG);
  if (migrationFeeOption !== MIGRATION_FEE_OPTION_CUSTOMIZABLE) {
    const baseFeeMode = readData<u8>(cfg, 80n);
    // DammV2BaseFeeMode::try_from: five modes
    require(baseFeeMode <= 4n, PoolError.TypeCastFailed);
    require(baseFeeMode === DAMM_V2_FEE_TIME_SCHEDULER_LINEAR || baseFeeMode === DAMM_V2_FEE_TIME_SCHEDULER_EXPONENTIAL, PoolError.InvalidConfigAccount);
    const baseFeeBps = toBps(u128(readData<u64>(cfg, 72n)), u128(DAMM_V2_FEE_DENOMINATOR));
    require(readData<u64>(cfg, 88n) === 0n && readData<u64>(cfg, 96n) === 0n && readData<u16>(cfg, 86n) === 0n, PoolError.InvalidConfigAccount);
    // MigrationFeeOption::validate_base_fee
    const want: u64 =
      migrationFeeOption === 0n ? 25n : migrationFeeOption === 1n ? 30n : migrationFeeOption === 2n ? 100n : migrationFeeOption === 3n ? 200n : migrationFeeOption === 4n ? 400n : 600n;
    require(baseFeeBps === want, PoolError.InvalidMigrationFeeOption);
    require(readData<u128>(cfg, 216n) === MIN_SQRT_PRICE, PoolError.InvalidConfigAccount);
    require(readData<u128>(cfg, 232n) === MAX_SQRT_PRICE, PoolError.InvalidConfigAccount);
    require(readData<Pubkey>(cfg, 8n) === DEFAULT_PUBKEY, PoolError.InvalidConfigAccount);
    const activationType = readData<u8>(cfg, 200n);
    require(activationType <= 1n, PoolError.TypeCastFailed);
    require(activationType === 1n, PoolError.InvalidConfigAccount);
  }
  require(readData<Pubkey>(cfg, 40n) === POOL_AUTHORITY, PoolError.InvalidConfigAccount);
}

/** A DAMM v2 Pool's token_a_amount (@680), token_b_amount (@688) and liquidity (@360), loaded as AccountLoader<Pool>. */
export interface DammPoolReserves {
  token_a_amount: u64;
  token_b_amount: u64;
  liquidity: u128;
}

export function dammPoolReserves(pool: AccountInfo): DammPoolReserves {
  requireDammAccount(pool.owner, pool.dataLen, pool.dataLen >= 8n ? readData<u64>(pool, 0n) : 0n, DISC_DAMM_POOL);
  return { token_a_amount: readData<u64>(pool, 680n), token_b_amount: readData<u64>(pool, 688n), liquidity: readData<u128>(pool, 360n) };
}

/** A DAMM v2 Position's unlocked_liquidity (@152), loaded as AccountLoader<Position>. */
export function dammPositionUnlockedLiquidity(position: AccountInfo): u128 {
  requireDammAccount(position.owner, position.dataLen, position.dataLen >= 8n ? readData<u64>(position, 0n) : 0n, DISC_DAMM_POSITION);
  return readData<u128>(position, 152n);
}

// ---- state/config.rs: LiquidityDistribution ---------------------------------------------------------------------

/** LiquidityDistributionItem, its LiquidityVestingInfo's fields inline. */
export interface LiquidityItem {
  unlocked_liquidity: u128;
  permanent_locked_liquidity: u128;
  vested_liquidity: u128;
  permanent_locked_liquidity_percentage: u8;
  vesting_percentage: u8;
  bps_per_period: u16;
  number_of_periods: u16;
  frequency: u32;
  cliff_duration_from_migration_time: u32;
}

/** PoolConfig::get_liquidity_distribution, the partner's item (`partner`) or the creator's. */
export function liquidityItem(c: PoolConfig, liquidity: u128, partner: boolean): LiquidityItem {
  const partnerPermanent = safeMulDivCastU128(liquidity, u128(c.partner_permanent_locked_liquidity_percentage), 100n, false);
  const partnerVested = safeMulDivCastU128(liquidity, u128(c.partner_liquidity_vesting_info.vesting_percentage), 100n, false);
  const partnerLiquidity = safeMulDivCastU128(liquidity, u128(c.partner_liquidity_percentage), 100n, false);
  const creatorPermanent = safeMulDivCastU128(liquidity, u128(c.creator_permanent_locked_liquidity_percentage), 100n, false);
  const creatorVested = safeMulDivCastU128(liquidity, u128(c.creator_liquidity_vesting_info.vesting_percentage), 100n, false);
  const creatorLiquidity = subU128(subU128(subU128(subU128(subU128(liquidity, partnerLiquidity), partnerPermanent), partnerVested), creatorPermanent), creatorVested);
  if (partner) {
    const v = c.partner_liquidity_vesting_info;
    return {
      unlocked_liquidity: partnerLiquidity,
      permanent_locked_liquidity: partnerPermanent,
      vested_liquidity: partnerVested,
      permanent_locked_liquidity_percentage: c.partner_permanent_locked_liquidity_percentage,
      vesting_percentage: v.vesting_percentage,
      bps_per_period: v.bps_per_period,
      number_of_periods: v.number_of_periods,
      frequency: v.frequency,
      cliff_duration_from_migration_time: v.cliff_duration_from_migration_time,
    };
  }
  const v = c.creator_liquidity_vesting_info;
  return {
    unlocked_liquidity: creatorLiquidity,
    permanent_locked_liquidity: creatorPermanent,
    vested_liquidity: creatorVested,
    permanent_locked_liquidity_percentage: c.creator_permanent_locked_liquidity_percentage,
    vesting_percentage: v.vesting_percentage,
    bps_per_period: v.bps_per_period,
    number_of_periods: v.number_of_periods,
    frequency: v.frequency,
    cliff_duration_from_migration_time: v.cliff_duration_from_migration_time,
  };
}

/** LiquidityDistributionItem::get_total_liquidity */
export function itemTotal(i: LiquidityItem): u128 {
  return addU128(addU128(i.unlocked_liquidity, i.permanent_locked_liquidity), i.vested_liquidity);
}

/** LiquidityDistributionItem::get_total_locked_liquidity */
export function itemLocked(i: LiquidityItem): u128 {
  return addU128(i.permanent_locked_liquidity, i.vested_liquidity);
}

/** LiquidityDistributionItem::adjust_liquidity */
export function adjustLiquidity(i: Inout<LiquidityItem>, adjustedTotal: u128): void {
  const totalLockedPercentage = addU8(i.vesting_percentage, i.permanent_locked_liquidity_percentage);
  if (totalLockedPercentage === 0n) {
    i.unlocked_liquidity = adjustedTotal;
    i.permanent_locked_liquidity = 0n;
    i.vested_liquidity = 0n;
    return;
  }
  const unlocked = adjustedTotal < i.unlocked_liquidity ? adjustedTotal : i.unlocked_liquidity;
  const subjectToLock = subU128(adjustedTotal, unlocked);
  const vested = safeMulDivCastU128(subjectToLock, u128(i.vesting_percentage), u128(totalLockedPercentage), false);
  i.unlocked_liquidity = unlocked;
  i.permanent_locked_liquidity = subU128(subjectToLock, vested);
  i.vested_liquidity = vested;
}

// ---- state/config.rs: the migrated pool's fees (build_damm_v2_pool_fee_params) --------------------------------------

/** The market cap scheduler parameters stored in migrated_pool_base_fee_bytes (Borsh, 16 bytes). */
function marketCapBytes(c: PoolConfig, at: u64, n: u64): u64 {
  let v: u64 = 0n;
  for (let i = 0n; i < n; i++) v = v | (u64(c.migrated_pool_base_fee_bytes.get(at + i)) << (8n * i));
  return v;
}

/** DammV2BaseFeeParameters: the 27 bytes of a BorshFeeTimeScheduler or BorshFeeMarketCapScheduler. */
export interface MigratedBaseFee {
  cliff_fee_numerator: u64;
  number_of_period: u16;
  sqrt_price_step_bps: u32;
  scheduler_expiration_duration: u32;
  reduction_factor: u64;
  base_fee_mode: u8;
}

/** build_damm_v2_base_fee_params */
export function migratedBaseFee(c: PoolConfig): MigratedBaseFee {
  const cliff = toNumerator(u128(c.migrated_pool_fee_bps), u128(DAMM_V2_FEE_DENOMINATOR));
  const mode = c.migrated_pool_base_fee_mode;
  require(mode <= 4n, PoolError.TypeCastFailed);
  if (mode === DAMM_V2_FEE_TIME_SCHEDULER_EXPONENTIAL || mode === DAMM_V2_FEE_TIME_SCHEDULER_LINEAR)
    return { cliff_fee_numerator: cliff, number_of_period: 0n, sqrt_price_step_bps: 0n, scheduler_expiration_duration: 0n, reduction_factor: 0n, base_fee_mode: mode };
  require(mode === DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL || mode === DAMM_V2_FEE_MARKET_CAP_SCHEDULER_LINEAR, PoolError.UndeterminedError);
  return {
    cliff_fee_numerator: cliff,
    number_of_period: u16(marketCapBytes(c, 0n, 2n)),
    sqrt_price_step_bps: u32(marketCapBytes(c, 2n, 2n)),
    scheduler_expiration_duration: u32(marketCapBytes(c, 4n, 4n)),
    reduction_factor: marketCapBytes(c, 8n, 8n),
    base_fee_mode: mode,
  };
}

/** get_damm_v2_migrated_pool_min_base_fee_numerator */
function migratedMinBaseFeeNumerator(c: PoolConfig): u64 {
  const mode = c.migrated_pool_base_fee_mode;
  require(mode <= 4n, PoolError.TypeCastFailed);
  const cliff = toNumerator(u128(c.migrated_pool_fee_bps), u128(DAMM_V2_FEE_DENOMINATOR));
  if (mode === DAMM_V2_FEE_TIME_SCHEDULER_EXPONENTIAL || mode === DAMM_V2_FEE_TIME_SCHEDULER_LINEAR) return cliff;
  require(mode === DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL || mode === DAMM_V2_FEE_MARKET_CAP_SCHEDULER_LINEAR, PoolError.UndeterminedError);
  return marketCapMinBaseFeeNumerator({
    cliff_fee_numerator: cliff,
    base_fee_mode: mode,
    number_of_period: u16(marketCapBytes(c, 0n, 2n)),
    sqrt_price_step_bps: u32(marketCapBytes(c, 2n, 2n)),
    scheduler_expiration_duration: u32(marketCapBytes(c, 4n, 4n)),
    reduction_factor: marketCapBytes(c, 8n, 8n),
  });
}

/**
 * build_damm_v2_dynamic_fee_params: the variable fee control of calculate_dynamic_fee_params, or -1 for None (the
 * dynamic fee disabled, or enabled with a minimum fee calculate_dynamic_fee_params fails on: the original logs that
 * and falls back to none).
 */
export function migratedDynamicFeeControl(c: PoolConfig): OptionU32 {
  const minBaseFeeNumerator = migratedMinBaseFeeNumerator(c);
  require(c.migrated_dynamic_fee <= 1n, PoolError.TypeCastFailed);
  if (c.migrated_dynamic_fee === 0n) return { some: false, value: 0n };
  // calculate_dynamic_fee_params, every step checked: a failure is the None fallback
  const maxDynamicFeeNumerator = (u128(minBaseFeeNumerator) * MAX_DYNAMIC_FEE_PERCENT) / 100n;
  const scaled = maxDynamicFeeNumerator * 100_000_000_000n;
  if (scaled < 99_999_999_999n) return { some: false, value: 0n };
  const control = (scaled - 99_999_999_999n) / SQUARE_VFA_BIN;
  if (control > 4294967295n) return { some: false, value: 0n };
  return { some: true, value: u32(control) };
}

/** An Option<u32>. */
export interface OptionU32 {
  some: boolean;
  value: u32;
}

// ---- migration fee, surplus (state/config.rs, state/virtual_pool.rs) -------------------------------------------

/** PoolConfig::get_migration_fee_distribution: [partner, creator]. */
export function migrationFeeDistribution(c: PoolConfig): U64Pair {
  const fee = migrationQuoteAmount(c.migration_quote_threshold, c.migration_fee_percentage).b;
  const creator = safeMulDivCastU64(fee, u64(c.creator_migration_fee_percentage), 100n, false);
  return { a: subU64(fee, creator), b: creator };
}

/** get_partner_surplus / get_creator_surplus of a total surplus: [partner, creator]. */
export function surplusSplit(c: PoolConfig, totalSurplus: u64): U64Pair {
  const shared = safeMulDivCastU64(totalSurplus, PARTNER_AND_CREATOR_SURPLUS_SHARE, 100n, false);
  // split_partner_and_creator_fee
  if (c.creator_trading_fee_percentage === 0n) return { a: shared, b: 0n };
  const creator = safeMulDivCastU64(shared, u64(c.creator_trading_fee_percentage), 100n, false);
  return { a: subU64(shared, creator), b: creator };
}

// ---- utils/token.rs on unchecked mint accounts ------------------------------------------------------------------

/** The offset of the value of a Token-2022 mint's TransferFeeConfig, or 0 when it has none. */
function transferFeeConfigOffset(mint: AccountInfo): u64 {
  if (mint.dataLen <= TLV_START) return 0n;
  let off = TLV_START;
  while (off + 4n <= mint.dataLen) {
    const t = u64(readData<u16>(mint, off));
    if (t === 0n) return 0n;
    const len = u64(readData<u16>(mint, off + 2n));
    if (t === EXT_TRANSFER_FEE_CONFIG) return off + 4n;
    off = off + 4n + len;
  }
  return 0n;
}

/** get_epoch_transfer_fee of an unchecked mint: [bps, maximum fee], `has` false for none. */
export interface MintFee {
  has: boolean;
  bps: u64;
  max: u64;
}

export function epochFeeOf(mint: AccountInfo): MintFee {
  if (mint.owner === TOKEN_PROGRAM_ID) return { has: false, bps: 0n, max: 0n };
  const cfg = transferFeeConfigOffset(mint);
  if (cfg === 0n) return { has: false, bps: 0n, max: 0n };
  const fee = currentEpoch() >= readData<u64>(mint, cfg + 90n) ? cfg + 90n : cfg + 72n;
  return { has: true, bps: u64(readData<u16>(mint, fee + 16n)), max: readData<u64>(mint, fee + 8n) };
}

/** ZeroTransferFee::is_zero */
export function mintFeeIsZero(f: MintFee): boolean {
  return f.bps === 0n || f.max === 0n;
}

/** has_transfer_fee_or_config_authority of an unchecked mint. */
export function hasTransferFeeOrConfigAuthorityOf(mint: AccountInfo): boolean {
  if (mint.owner === TOKEN_PROGRAM_ID) return false;
  const cfg = transferFeeConfigOffset(mint);
  if (cfg === 0n) return false;
  if (readData<Pubkey>(mint, cfg) !== DEFAULT_PUBKEY) return true;
  const newerZero = readData<u16>(mint, cfg + 106n) === 0n || readData<u64>(mint, cfg + 98n) === 0n;
  if (currentEpoch() < readData<u64>(mint, cfg + 90n)) {
    const olderZero = readData<u16>(mint, cfg + 88n) === 0n || readData<u64>(mint, cfg + 80n) === 0n;
    return !(olderZero && newerZero);
  }
  return !newerZero;
}
