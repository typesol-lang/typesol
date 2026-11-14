// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// Config creation: ConfigParameters::validate and the validators it calls, process_create_config and PoolConfig::init
// (instructions/partner/create_config/process_create_config.rs), the curve integrals (params/liquidity_distribution.rs)
// and the PoolConfig methods they use (state/config.rs). Checks run in the original's order, with its error codes.
import { type Inout, type Mint, type Pubkey, pubkey, require, u8, u16, u32, u64, u128, u256 } from "typesol";
import { getDeltaAmountBaseUnsigned256, getDeltaAmountQuoteUnsigned256, getNextSqrtPriceFromInput } from "./curve";
import { PoolError } from "./errors";
import {
  DAMM_V2_FEE_DENOMINATOR,
  type DammV2VestingParameters,
  maxUnlockedLiquidityAt,
  toNumerator,
  validateMarketCapScheduler,
  validatePoolFeeParameters,
  validateVestingParameters,
  writePoolFeesConfig,
} from "./fees";
import { U128_MAX, U64_MAX, addU256, addU64, addU8, castU256ToU64, divU128, mulU128, mulU16, mulU64, addU16, safeMulDivCastU128, subU128, subU64 } from "./math";
import {
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  compoundingDepositAmounts,
  compoundingProtocolFees,
  includedProtocolFeeMigrationAmounts1,
  isCompoundingMigration,
  validateCompoundingInitialPool,
} from "./migration";
import {
  type ConfigParameters,
  type LiquidityVestingInfo,
  type LiquidityVestingInfoParams,
  type LockedVestingParams,
  type PoolConfig,
  type TransferFeeParameters,
  DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL,
  DAMM_V2_FEE_MARKET_CAP_SCHEDULER_LINEAR,
  DAMM_V2_FEE_TIME_SCHEDULER_EXPONENTIAL,
  DAMM_V2_FEE_TIME_SCHEDULER_LINEAR,
  MIGRATED_COLLECT_FEE_MODE_COMPOUNDING,
  MIGRATED_TRANSFER_FEE_IMMUTABLE,
  MIGRATED_TRANSFER_FEE_PARTNER,
  MIGRATED_TRANSFER_FEE_REVOKE_ZERO_FEE,
  MIGRATION_FEE_OPTION_CUSTOMIZABLE,
  MIGRATION_OPTION_METEORA_DAMM,
  TOKEN_AUTHORITY_CREATOR_UPDATE_AND_MINT,
  TOKEN_AUTHORITY_PARTNER_UPDATE,
  TOKEN_AUTHORITY_PARTNER_UPDATE_AND_MINT,
  TOKEN_TYPE_TOKEN_2022,
  TRANSFER_FEE_WITHHELD_PARTNER,
} from "./state";
import { hasTransferFeeOrConfigAuthority, quoteTransferFeeExcludedAmount, tokenProgramFlag, transferFeeExcludedAmount } from "./token";

/** constants.rs */
export const MAX_CURVE_POINT: u64 = 16n;
export const MAX_CURVE_POINT_CONFIG: u64 = 20n;
export const SWAP_BUFFER_PERCENTAGE: u128 = 25n;
export const MAX_MIGRATION_FEE_PERCENTAGE: u8 = 99n;
export const CONFIG_VERSION: u8 = 1n;
export const MIN_LOCKED_LIQUIDITY_BPS: u16 = 1000n;
export const MAX_LOCK_DURATION_IN_SECONDS: u64 = 63072000n;
export const MIN_MIGRATED_POOL_FEE_BPS: u16 = 10n;
export const MAX_MIGRATED_POOL_FEE_BPS: u16 = 1000n;
export const MAX_BASE_TRANSFER_FEE_BPS: u16 = 1000n;
export const MIN_POOL_CREATION_FEE: u64 = 1_000_000n;
export const MAX_POOL_CREATION_FEE: u64 = 100_000_000_000n;
export const PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS: u16 = 20n;
/** solana_program::clock::SECONDS_PER_DAY */
const SECONDS_PER_DAY: u64 = 86400n;
/** DAMM v2's MAX_BASIS_POINT (u16). */
const DAMM_V2_MAX_BASIS_POINT: u16 = 10000n;

// ---- params/liquidity_distribution.rs ---------------------------------------------------------------------------

/** get_base_token_for_swap: the base the curve sells from the start price up to `sqrtMigrationPrice`, rounded up. */
export function baseTokenForSwap(sqrtStartPrice: u128, sqrtMigrationPrice: u128, p: ConfigParameters): u256 {
  let total: u256 = 0n;
  for (let i = 0n; i < p.curve.length; i++) {
    const lower = i === 0n ? sqrtStartPrice : p.curve.get(i - 1n).sqrt_price;
    const point = p.curve.get(i);
    if (point.sqrt_price > sqrtMigrationPrice) {
      total = addU256(total, getDeltaAmountBaseUnsigned256(lower, sqrtMigrationPrice, point.liquidity, true));
      break;
    }
    total = addU256(total, getDeltaAmountBaseUnsigned256(lower, point.sqrt_price, point.liquidity, true));
  }
  return total;
}

/** get_migration_threshold_price: where the curve has taken `migrationThreshold` of quote. */
export function migrationThresholdPrice(migrationThreshold: u64, sqrtStartPrice: u128, p: ConfigParameters): u128 {
  let nextSqrtPrice = sqrtStartPrice;
  const first = p.curve.get(0n);
  const totalAmount = getDeltaAmountQuoteUnsigned256(nextSqrtPrice, first.sqrt_price, first.liquidity, true);
  if (totalAmount > u256(migrationThreshold)) {
    nextSqrtPrice = getNextSqrtPriceFromInput(nextSqrtPrice, first.liquidity, migrationThreshold, false);
  } else {
    let amountLeft = subU64(migrationThreshold, castU256ToU64(totalAmount));
    nextSqrtPrice = first.sqrt_price;
    for (let i = 1n; i < p.curve.length; i++) {
      const point = p.curve.get(i);
      const maxAmount = getDeltaAmountQuoteUnsigned256(nextSqrtPrice, point.sqrt_price, point.liquidity, true);
      if (maxAmount > u256(amountLeft)) {
        nextSqrtPrice = getNextSqrtPriceFromInput(nextSqrtPrice, point.liquidity, amountLeft, false);
        amountLeft = 0n;
        break;
      }
      amountLeft = subU64(amountLeft, castU256ToU64(maxAmount));
      nextSqrtPrice = point.sqrt_price;
    }
    require(amountLeft === 0n, PoolError.NotEnoughLiquidity);
  }
  return nextSqrtPrice;
}

// ---- state/config.rs: LiquidityVestingInfo, LockedVestingParams, PoolConfig statics -------------------------------

/** LiquidityVestingInfo::get_damm_v2_vesting_parameters (on the stored info or the parameters it is built from). */
export function dammV2VestingParameters(
  bpsPerPeriod: u16,
  numberOfPeriods: u16,
  frequency: u32,
  cliffDurationFromMigrationTime: u32,
  totalVestedLiquidity: u128,
  currentTimestamp: u64,
): DammV2VestingParameters {
  let freq = frequency;
  let numberOfPeriod = numberOfPeriods;
  let cliffDuration = cliffDurationFromMigrationTime;
  const totalBpsAfterCliff = mulU16(bpsPerPeriod, numberOfPeriod);
  const afterCliff = safeMulDivCastU128(totalVestedLiquidity, u128(totalBpsAfterCliff), 10000n, false);
  const liquidityPerPeriod: u128 = numberOfPeriod > 0n ? divU128(afterCliff, u128(numberOfPeriod)) : 0n;
  if (liquidityPerPeriod === 0n) {
    numberOfPeriod = 0n;
    freq = 0n;
    if (cliffDuration < 1n) cliffDuration = 1n;
  }
  const cliffUnlockLiquidity = subU128(totalVestedLiquidity, mulU128(liquidityPerPeriod, u128(numberOfPeriod)));
  const cliffPoint = addU64(currentTimestamp, u64(cliffDuration));
  return {
    cliff_point: cliffPoint,
    period_frequency: u64(freq),
    cliff_unlock_liquidity: cliffUnlockLiquidity,
    liquidity_per_period: liquidityPerPeriod,
    number_of_period: numberOfPeriod,
  };
}

function vestingParamsIsZero(v: LiquidityVestingInfoParams): boolean {
  return v.vesting_percentage === 0n && v.bps_per_period === 0n && v.number_of_periods === 0n && v.cliff_duration_from_migration_time === 0n && v.frequency === 0n;
}

/** LiquidityVestingInfoParams::validate */
function validateLiquidityVestingInfoParams(v: LiquidityVestingInfoParams, currentTimestamp: u64): void {
  if (vestingParamsIsZero(v)) return;
  const totalVestedLiquidity = safeMulDivCastU128(U128_MAX, u128(v.vesting_percentage), 100n, false);
  const params = dammV2VestingParameters(v.bps_per_period, v.number_of_periods, v.frequency, v.cliff_duration_from_migration_time, totalVestedLiquidity, currentTimestamp);
  validateVestingParameters(params, currentTimestamp, MAX_LOCK_DURATION_IN_SECONDS);
}

/** LiquidityVestingParams::to_liquidity_vesting_info, written into a config's (zeroed) info. */
function writeLiquidityVestingInfo(out: Inout<LiquidityVestingInfo>, v: LiquidityVestingInfoParams): void {
  out.is_initialized = vestingParamsIsZero(v) ? 0n : 1n;
  out.vesting_percentage = v.vesting_percentage;
  out.cliff_duration_from_migration_time = v.cliff_duration_from_migration_time;
  out.bps_per_period = v.bps_per_period;
  out.frequency = v.frequency;
  out.number_of_periods = v.number_of_periods;
}

/** LiquidityVestingInfo::get_liquidity_locked_bps_at_n_seconds */
function liquidityLockedBpsAtNSeconds(info: LiquidityVestingInfo, nSeconds: u64): u16 {
  if (info.is_initialized === 0n) return 0n;
  const totalLiquidity = U128_MAX;
  const totalVestedLiquidity = safeMulDivCastU128(totalLiquidity, u128(info.vesting_percentage), 100n, false);
  const params = dammV2VestingParameters(info.bps_per_period, info.number_of_periods, info.frequency, info.cliff_duration_from_migration_time, totalVestedLiquidity, 0n);
  const unlocked = maxUnlockedLiquidityAt(params, nSeconds);
  const locked = subU128(totalVestedLiquidity, unlocked);
  const bps = safeMulDivCastU128(locked, 10000n, totalLiquidity, false);
  require(bps <= 65535n, PoolError.TypeCastFailed);
  return u16(bps);
}

/** LockedVestingParams::get_total_amount */
export function lockedVestingTotalAmount(v: LockedVestingParams): u64 {
  return addU64(v.cliff_unlock_amount, mulU64(v.amount_per_period, v.number_of_period));
}

function lockedVestingHasVesting(v: LockedVestingParams): boolean {
  return v.amount_per_period !== 0n || v.cliff_duration_from_migration_time !== 0n || v.frequency !== 0n || v.number_of_period !== 0n || v.cliff_unlock_amount !== 0n;
}

/** PoolConfig::get_swap_amount_with_buffer: the swap amount plus 25%, at most the whole curve's base. */
export function swapAmountWithBuffer(swapBaseAmount: u64, sqrtStartPrice: u128, p: ConfigParameters): u64 {
  // u128 checked arithmetic on a u64 times 25: cannot overflow
  const buffer = divU128(mulU128(u128(swapBaseAmount), SWAP_BUFFER_PERCENTAGE), 100n) + u128(swapBaseAmount);
  const maxBaseAmountOnCurve = baseTokenForSwap(sqrtStartPrice, MAX_SQRT_PRICE, p);
  if (u256(buffer) < maxBaseAmountOnCurve) {
    require(buffer <= u128(U64_MAX), PoolError.MathOverflow);
    return u64(buffer);
  }
  require(maxBaseAmountOnCurve <= u256(U64_MAX), PoolError.MathOverflow);
  return u64(maxBaseAmountOnCurve);
}

/** PoolConfig::get_total_token_supply */
export function totalTokenSupply(swapBaseAmount: u64, migrationBaseThreshold: u64, v: LockedVestingParams): u64 {
  const circulating = addU64(swapBaseAmount, migrationBaseThreshold);
  return addU64(circulating, lockedVestingTotalAmount(v));
}

// ---- process_create_config.rs: ConfigParameters::validate --------------------------------------------------------

/** MigrationFee::validate */
function validateMigrationFee(p: ConfigParameters): void {
  const f = p.migration_fee;
  require(f.fee_percentage <= MAX_MIGRATION_FEE_PERCENTAGE, PoolError.InvalidMigratorFeePercentage);
  if (f.fee_percentage === 0n) require(f.creator_fee_percentage === 0n, PoolError.InvalidMigratorFeePercentage);
  else require(f.creator_fee_percentage <= 100n, PoolError.InvalidMigratorFeePercentage);
}

/** MigratedPoolFeeValidator::is_none */
function migratedPoolFeeIsNone(p: ConfigParameters): boolean {
  const s = p.migrated_pool_market_cap_fee_scheduler_params;
  return (
    p.migrated_pool_fee.collect_fee_mode === 0n &&
    p.migrated_pool_fee.dynamic_fee === 0n &&
    p.migrated_pool_fee.pool_fee_bps === 0n &&
    p.compounding_fee_bps === 0n &&
    p.migrated_pool_base_fee_mode === 0n &&
    s.number_of_period === 0n &&
    s.sqrt_price_step_bps === 0n &&
    s.scheduler_expiration_duration === 0n &&
    s.reduction_factor === 0n
  );
}

/** MigratedPoolFeeValidator::validate */
function validateMigratedPoolFee(p: ConfigParameters): void {
  const fee = p.migrated_pool_fee;
  const s = p.migrated_pool_market_cap_fee_scheduler_params;
  require(fee.pool_fee_bps >= MIN_MIGRATED_POOL_FEE_BPS && fee.pool_fee_bps <= MAX_MIGRATED_POOL_FEE_BPS, PoolError.InvalidMigratedPoolFee);
  require(fee.collect_fee_mode <= MIGRATED_COLLECT_FEE_MODE_COMPOUNDING, PoolError.InvalidCollectFeeMode);
  if (fee.collect_fee_mode === MIGRATED_COLLECT_FEE_MODE_COMPOUNDING)
    require(p.compounding_fee_bps <= DAMM_V2_MAX_BASIS_POINT, PoolError.InvalidMigratedPoolFee);
  else require(p.compounding_fee_bps === 0n, PoolError.InvalidMigratedPoolFee);
  // DammV2DynamicFee::try_from: Disable, Enable
  require(fee.dynamic_fee <= 1n, PoolError.InvalidMigratedPoolFee);
  const mode = p.migrated_pool_base_fee_mode;
  require(mode <= DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL, PoolError.TypeCastFailed);
  if (mode === DAMM_V2_FEE_TIME_SCHEDULER_LINEAR || mode === DAMM_V2_FEE_TIME_SCHEDULER_EXPONENTIAL) {
    require(
      s.number_of_period === 0n && s.sqrt_price_step_bps === 0n && s.scheduler_expiration_duration === 0n && s.reduction_factor === 0n,
      PoolError.InvalidMigratedPoolFee,
    );
  } else if (mode === DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL || mode === DAMM_V2_FEE_MARKET_CAP_SCHEDULER_LINEAR) {
    const cliffFeeNumerator = toNumerator(u128(fee.pool_fee_bps), u128(DAMM_V2_FEE_DENOMINATOR));
    validateMarketCapScheduler({
      cliff_fee_numerator: cliffFeeNumerator,
      base_fee_mode: mode,
      number_of_period: s.number_of_period,
      sqrt_price_step_bps: u32(s.sqrt_price_step_bps),
      scheduler_expiration_duration: s.scheduler_expiration_duration,
      reduction_factor: s.reduction_factor,
    });
  } else {
    require(false, PoolError.InvalidMigratedPoolFee);
  }
}

/** ConfigParameters::validate */
export function validateConfigParameters(p: ConfigParameters, currentTimestamp: u64, isTransferHook: boolean, feeClaimer: Pubkey): void {
  // ActivationType::try_from
  require(p.activation_type <= 1n, PoolError.TypeCastFailed);
  validatePoolFeeParameters(p.pool_fees);
  require(p.creator_trading_fee_percentage <= 100n, PoolError.InvalidCreatorTradingFeePercentage);
  validateMigrationFee(p);
  require(p.collect_fee_mode <= 1n, PoolError.InvalidCollectFeeMode);
  require(p.migration_option <= 1n, PoolError.InvalidMigrationOption);
  require(p.migration_fee_option <= MIGRATION_FEE_OPTION_CUSTOMIZABLE, PoolError.InvalidMigrationFeeOption);
  require(p.token_type <= 1n, PoolError.InvalidTokenType);
  require(p.migration_option !== MIGRATION_OPTION_METEORA_DAMM, PoolError.DeprecatedMigrationOption);
  // DammV2
  if (p.migration_fee_option === MIGRATION_FEE_OPTION_CUSTOMIZABLE) validateMigratedPoolFee(p);
  else require(migratedPoolFeeIsNone(p), PoolError.InvalidMigratedPoolFee);
  validateLiquidityVestingInfoParams(p.partner_liquidity_vesting_info, currentTimestamp);
  validateLiquidityVestingInfoParams(p.creator_liquidity_vesting_info, currentTimestamp);
  // TokenAuthorityOption::try_from, then the mint authority variants only for transfer-hook configs
  const authority = p.token_update_authority;
  require(authority <= TOKEN_AUTHORITY_PARTNER_UPDATE_AND_MINT, PoolError.InvalidTokenAuthorityOption);
  const hasMintAuthority = authority === TOKEN_AUTHORITY_CREATOR_UPDATE_AND_MINT || authority === TOKEN_AUTHORITY_PARTNER_UPDATE_AND_MINT;
  require(isTransferHook || !hasMintAuthority, PoolError.InvalidTokenAuthorityOption);
  const isPartnerAuthority = authority === TOKEN_AUTHORITY_PARTNER_UPDATE || authority === TOKEN_AUTHORITY_PARTNER_UPDATE_AND_MINT;
  if (p.token_type === TOKEN_TYPE_TOKEN_2022 && isPartnerAuthority) require(feeClaimer !== DEFAULT_PUBKEY, PoolError.InvalidFeeClaimer);
  require(p.token_decimal >= 6n && p.token_decimal <= 9n, PoolError.InvalidTokenDecimals);
  const sum = addU8(
    addU8(
      addU8(addU8(addU8(p.partner_liquidity_percentage, p.partner_permanent_locked_liquidity_percentage), p.creator_liquidity_percentage), p.creator_permanent_locked_liquidity_percentage),
      p.partner_liquidity_vesting_info.vesting_percentage,
    ),
    p.creator_liquidity_vesting_info.vesting_percentage,
  );
  require(sum === 100n, PoolError.InvalidFeePercentage);
  require(p.migration_quote_threshold > 0n, PoolError.InvalidQuoteThreshold);
  // LockedVestingParams::validate
  if (lockedVestingHasVesting(p.locked_vesting)) {
    const total = lockedVestingTotalAmount(p.locked_vesting);
    require(p.locked_vesting.frequency !== 0n && total !== 0n, PoolError.InvalidVestingParameters);
  }
  if (p.pool_creation_fee > 0n)
    require(p.pool_creation_fee >= MIN_POOL_CREATION_FEE && p.pool_creation_fee <= MAX_POOL_CREATION_FEE, PoolError.InvalidPoolCreationFee);
  require(p.sqrt_start_price >= MIN_SQRT_PRICE && p.sqrt_start_price < MAX_SQRT_PRICE, PoolError.InvalidCurve);
  const curveLength = p.curve.length;
  require(curveLength > 0n && curveLength <= MAX_CURVE_POINT, PoolError.InvalidCurve);
  const first = p.curve.get(0n);
  require(first.sqrt_price > p.sqrt_start_price && first.liquidity > 0n && first.sqrt_price <= MAX_SQRT_PRICE, PoolError.InvalidCurve);
  for (let i = 1n; i < curveLength; i++) {
    const point = p.curve.get(i);
    require(point.sqrt_price > p.curve.get(i - 1n).sqrt_price && point.liquidity > 0n, PoolError.InvalidCurve);
  }
  require(p.curve.get(curveLength - 1n).sqrt_price <= MAX_SQRT_PRICE, PoolError.InvalidCurve);
}

export const DEFAULT_PUBKEY = pubkey("11111111111111111111111111111111");

/** TransferFeeParameters::validate (create_config2) */
export function validateTransferFeeParameters(t: TransferFeeParameters, tokenType: u8, feeClaimer: Pubkey): void {
  require(tokenType <= 1n, PoolError.InvalidTokenType);
  require(tokenType === TOKEN_TYPE_TOKEN_2022, PoolError.InvalidTokenType);
  require(t.transfer_fee_basis_points <= MAX_BASE_TRANSFER_FEE_BPS, PoolError.InvalidTransferFeeParameters);
  // TransferFeeWithheldAuthority::try_from (Partner, Creator), MigratedTransferFeeAuthorityOption::try_from (4 variants)
  require(t.withheld_authority <= 1n, PoolError.InvalidTransferFeeParameters);
  require(t.migrated_transfer_fee_authority_option <= MIGRATED_TRANSFER_FEE_PARTNER, PoolError.InvalidTransferFeeParameters);
  const migrated = t.migrated_transfer_fee_authority_option;
  require(
    !(t.transfer_fee_basis_points === 0n && (migrated === MIGRATED_TRANSFER_FEE_IMMUTABLE || migrated === MIGRATED_TRANSFER_FEE_REVOKE_ZERO_FEE)),
    PoolError.InvalidTransferFeeParameters,
  );
  const isPartnerAuthority = t.withheld_authority === TRANSFER_FEE_WITHHELD_PARTNER || migrated === MIGRATED_TRANSFER_FEE_PARTNER;
  if (isPartnerAuthority) require(feeClaimer !== DEFAULT_PUBKEY, PoolError.InvalidFeeClaimer);
}

// ---- process_create_config ------------------------------------------------------------------------------------

/** PoolConfig::validate_transfer_fee_restrictions */
export function validateTransferFeeRestrictions(c: PoolConfig): void {
  require(c.fixed_token_supply_flag === 1n && c.pre_migration_token_supply === c.post_migration_token_supply, PoolError.InvalidTokenSupply);
  const v = c.locked_vesting_config;
  require(
    v.amount_per_period === 0n && v.cliff_duration_from_migration_time === 0n && v.frequency === 0n && v.number_of_period === 0n && v.cliff_unlock_amount === 0n,
    PoolError.InvalidVestingParameters,
  );
  require(c.migration_fee_option <= MIGRATION_FEE_OPTION_CUSTOMIZABLE, PoolError.InvalidMigrationFeeOption);
  require(c.migration_fee_option === MIGRATION_FEE_OPTION_CUSTOMIZABLE, PoolError.InvalidMigrationFeeOption);
  require(c.migrated_collect_fee_mode <= MIGRATED_COLLECT_FEE_MODE_COMPOUNDING, PoolError.InvalidCollectFeeMode);
  require(c.migrated_collect_fee_mode === MIGRATED_COLLECT_FEE_MODE_COMPOUNDING, PoolError.InvalidMigratedPoolFee);
}

/** PoolConfig::get_total_liquidity_locked_bps_at_n_seconds */
export function totalLiquidityLockedBpsAtNSeconds(c: PoolConfig, nSeconds: u64): u16 {
  const partnerVested = liquidityLockedBpsAtNSeconds(c.partner_liquidity_vesting_info, nSeconds);
  const creatorVested = liquidityLockedBpsAtNSeconds(c.creator_liquidity_vesting_info, nSeconds);
  const partnerPermanent = mulU16(u16(c.partner_permanent_locked_liquidity_percentage), 100n);
  const creatorPermanent = mulU16(u16(c.creator_permanent_locked_liquidity_percentage), 100n);
  return addU16(addU16(addU16(partnerVested, partnerPermanent), creatorVested), creatorPermanent);
}

/**
 * process_create_config: derives the migration price, the base sold on the curve and the migration base amount, checks
 * the compounding migration and the token supply, then fills the (zeroed) config as PoolConfig::init does. The
 * optional transfer fee parameters are `hasTransferFee` and, when it is set, `transferFee`.
 */
export function processCreateConfig(
  config: Inout<PoolConfig>,
  p: ConfigParameters,
  hasTransferFee: boolean,
  transferFee: TransferFeeParameters,
  quoteMint: Mint,
  feeClaimer: Pubkey,
  leftoverReceiver: Pubkey,
): void {
  const migrationSqrtPrice = migrationThresholdPrice(p.migration_quote_threshold, p.sqrt_start_price, p);
  require(migrationSqrtPrice < MAX_SQRT_PRICE, PoolError.InvalidCurve);
  const swapBaseAmount = castU256ToU64(baseTokenForSwap(p.sqrt_start_price, migrationSqrtPrice, p));
  require(p.migration_option <= 1n, PoolError.InvalidMigrationOption);
  // safe_cast to MigratedCollectFeeMode
  require(p.migrated_pool_fee.collect_fee_mode <= MIGRATED_COLLECT_FEE_MODE_COMPOUNDING, PoolError.TypeCastFailed);
  const compounding = isCompoundingMigration(p.migration_option, p.migrated_pool_fee.collect_fee_mode);
  const included = includedProtocolFeeMigrationAmounts1(compounding, migrationSqrtPrice, p.migration_quote_threshold, p.migration_fee.fee_percentage);
  const includedBase = included.a;
  const includedQuote = included.b;
  require(includedBase > 0n && swapBaseAmount > 0n, PoolError.InvalidCurve);

  if (p.migrated_pool_fee.collect_fee_mode === MIGRATED_COLLECT_FEE_MODE_COMPOUNDING) {
    const protocolFees = compoundingProtocolFees(includedBase, includedQuote, PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS);
    const excludedBase = subU64(includedBase, protocolFees.a);
    const excludedQuote = subU64(includedQuote, protocolFees.b);
    // TransferParameters::to_transfer_fee: maximum fee u64::MAX
    const transferBase = transferFeeExcludedAmount(hasTransferFee, u64(transferFee.transfer_fee_basis_points), U64_MAX, excludedBase);
    const transferQuote = quoteTransferFeeExcludedAmount(quoteMint, excludedQuote);
    const deposit = compoundingDepositAmounts(excludedBase, excludedQuote, transferBase, transferQuote);
    validateCompoundingInitialPool(deposit.a, deposit.b, migrationSqrtPrice);
  }

  let fixedTokenSupplyFlag: u8 = 0n;
  let preMigrationTokenSupply: u64 = 0n;
  let postMigrationTokenSupply: u64 = 0n;
  if (p.token_supply !== null) {
    const pre = p.token_supply.pre_migration_token_supply;
    const post = p.token_supply.post_migration_token_supply;
    const buffer = swapAmountWithBuffer(swapBaseAmount, p.sqrt_start_price, p);
    const minWithBuffer = totalTokenSupply(buffer, includedBase, p.locked_vesting);
    const minWithoutBuffer = totalTokenSupply(swapBaseAmount, includedBase, p.locked_vesting);
    require(leftoverReceiver !== DEFAULT_PUBKEY, PoolError.InvalidLeftoverAddress);
    require(minWithoutBuffer <= post && post <= pre && minWithBuffer <= pre, PoolError.InvalidTokenSupply);
    fixedTokenSupplyFlag = 1n;
    preMigrationTokenSupply = pre;
    postMigrationTokenSupply = post;
  }

  // PoolConfig::init
  config.version = CONFIG_VERSION;
  config.quote_mint = quoteMint.key;
  config.fee_claimer = feeClaimer;
  config.leftover_receiver = leftoverReceiver;
  writePoolFeesConfig(config.pool_fees, p.pool_fees);
  config.creator_trading_fee_percentage = p.creator_trading_fee_percentage;
  config.token_update_authority = p.token_update_authority;
  config.migration_fee_percentage = p.migration_fee.fee_percentage;
  config.creator_migration_fee_percentage = p.migration_fee.creator_fee_percentage;
  config.collect_fee_mode = p.collect_fee_mode;
  config.migration_option = p.migration_option;
  config.activation_type = p.activation_type;
  config.token_decimal = p.token_decimal;
  config.swap_base_amount = swapBaseAmount;
  config.migration_quote_threshold = p.migration_quote_threshold;
  config.migration_base_threshold = includedBase;
  config.migration_sqrt_price = migrationSqrtPrice;
  config.sqrt_start_price = p.sqrt_start_price;
  config.token_type = p.token_type;
  config.quote_token_flag = u8(tokenProgramFlag(quoteMint));
  config.partner_liquidity_percentage = p.partner_liquidity_percentage;
  config.partner_permanent_locked_liquidity_percentage = p.partner_permanent_locked_liquidity_percentage;
  config.creator_liquidity_percentage = p.creator_liquidity_percentage;
  config.creator_permanent_locked_liquidity_percentage = p.creator_permanent_locked_liquidity_percentage;
  config.locked_vesting_config.amount_per_period = p.locked_vesting.amount_per_period;
  config.locked_vesting_config.cliff_duration_from_migration_time = p.locked_vesting.cliff_duration_from_migration_time;
  config.locked_vesting_config.frequency = p.locked_vesting.frequency;
  config.locked_vesting_config.number_of_period = p.locked_vesting.number_of_period;
  config.locked_vesting_config.cliff_unlock_amount = p.locked_vesting.cliff_unlock_amount;
  config.migration_fee_option = p.migration_fee_option;
  config.fixed_token_supply_flag = fixedTokenSupplyFlag;
  config.pre_migration_token_supply = preMigrationTokenSupply;
  config.post_migration_token_supply = postMigrationTokenSupply;
  config.migrated_pool_fee_bps = p.migrated_pool_fee.pool_fee_bps;
  config.migrated_collect_fee_mode = p.migrated_pool_fee.collect_fee_mode;
  config.migrated_dynamic_fee = p.migrated_pool_fee.dynamic_fee;
  config.migrated_compounding_fee_bps = p.compounding_fee_bps;
  config.pool_creation_fee = p.pool_creation_fee;
  writeLiquidityVestingInfo(config.creator_liquidity_vesting_info, p.creator_liquidity_vesting_info);
  writeLiquidityVestingInfo(config.partner_liquidity_vesting_info, p.partner_liquidity_vesting_info);
  config.migrated_pool_base_fee_mode = p.migrated_pool_base_fee_mode;
  // MigratedPoolMarketCapFeeSchedulerParams Borsh-serialized: u16, u16, u32, u64 (16 bytes)
  const s = p.migrated_pool_market_cap_fee_scheduler_params;
  for (let i = 0n; i < 2n; i++) config.migrated_pool_base_fee_bytes.set(i, u8((s.number_of_period >> (8n * i)) & 0xffn));
  for (let i = 0n; i < 2n; i++) config.migrated_pool_base_fee_bytes.set(2n + i, u8((s.sqrt_price_step_bps >> (8n * i)) & 0xffn));
  for (let i = 0n; i < 4n; i++) config.migrated_pool_base_fee_bytes.set(4n + i, u8((s.scheduler_expiration_duration >> (8n * i)) & 0xffn));
  for (let i = 0n; i < 8n; i++) config.migrated_pool_base_fee_bytes.set(8n + i, u8((s.reduction_factor >> (8n * i)) & 0xffn));
  config.enable_first_swap_with_min_fee = p.enable_first_swap_with_min_fee ? 1n : 0n;
  for (let i = 0n; i < p.curve.length; i++) {
    const point = p.curve.get(i);
    config.curve.set(i, { sqrt_price: point.sqrt_price, liquidity: point.liquidity });
  }
  if (hasTransferFee) {
    config.transfer_fee_flag = 1n;
    config.transfer_fee_basis_points = transferFee.transfer_fee_basis_points;
    config.transfer_fee_withheld_authority = transferFee.withheld_authority;
    config.migrated_transfer_fee_authority_option = transferFee.migrated_transfer_fee_authority_option;
  }

  if (hasTransferFee || hasTransferFeeOrConfigAuthority(quoteMint)) validateTransferFeeRestrictions(config);
  require(totalLiquidityLockedBpsAtNSeconds(config, SECONDS_PER_DAY) >= MIN_LOCKED_LIQUIDITY_BPS, PoolError.InvalidMigrationLockedLiquidity);
}

// ---- PoolConfig::get_initial_base_supply (pool creation) ---------------------------------------------------------

/** get_base_token_for_swap over a stored config's curve (its points up to the first with no liquidity). */
function storedBaseTokenForSwap(c: PoolConfig, sqrtMigrationPrice: u128): u256 {
  let total: u256 = 0n;
  for (let i = 0n; i < MAX_CURVE_POINT_CONFIG; i++) {
    const point = c.curve.get(i);
    if (point.liquidity === 0n) break;
    const lower = i === 0n ? c.sqrt_start_price : c.curve.get(i - 1n).sqrt_price;
    if (point.sqrt_price > sqrtMigrationPrice) {
      total = addU256(total, getDeltaAmountBaseUnsigned256(lower, sqrtMigrationPrice, point.liquidity, true));
      break;
    }
    total = addU256(total, getDeltaAmountBaseUnsigned256(lower, point.sqrt_price, point.liquidity, true));
  }
  return total;
}

/** PoolConfig::get_initial_base_supply: the fixed supply, or the swap amount with its buffer, the migration base and the locked vesting. */
export function initialBaseSupply(c: PoolConfig): u64 {
  if (c.fixed_token_supply_flag === 1n) return c.pre_migration_token_supply;
  const buffer = divU128(mulU128(u128(c.swap_base_amount), SWAP_BUFFER_PERCENTAGE), 100n) + u128(c.swap_base_amount);
  const maxBaseAmountOnCurve = storedBaseTokenForSwap(c, MAX_SQRT_PRICE);
  let withBuffer: u64 = 0n;
  if (u256(buffer) < maxBaseAmountOnCurve) {
    require(buffer <= u128(U64_MAX), PoolError.MathOverflow);
    withBuffer = u64(buffer);
  } else {
    require(maxBaseAmountOnCurve <= u256(U64_MAX), PoolError.MathOverflow);
    withBuffer = u64(maxBaseAmountOnCurve);
  }
  const v = c.locked_vesting_config;
  const vesting = addU64(v.cliff_unlock_amount, mulU64(v.amount_per_period, v.number_of_period));
  return addU64(addU64(withBuffer, c.migration_base_threshold), vesting);
}
