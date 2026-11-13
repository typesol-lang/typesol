// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// The program's accounts, the types inside them and the instruction argument types (programs/dynamic-bonding-curve/
// src/state/*.rs, params/*.rs, the parameter structs of instructions/, and the migration metadata states). The
// zero-copy accounts are #[repr(C)] with their padding spelled out, so TypeSOL's fixed layout stores them byte for byte
// (PoolConfig 1,040, ConfigWithTransferHook 1,120, VirtualPool / TransferHookPool 416, Operator 64, TokenBadge and
// ClaimFeeOperator 160, MeteoraDammMigrationMetadata 272, MeteoraDammV2Metadata 222 bytes after the discriminator).
import { type FixedArray, type FixedVec, type Vec, type Option, type Pubkey, type u8, type u16, type u32, type u64, type u128 } from "typesol";

// ---- enums kept as u8 in account data (num_enum TryFromPrimitive in the original) --------------------------------

/** BaseFeeMode (state/config.rs). */
export const BASE_FEE_FEE_SCHEDULER_LINEAR: u8 = 0n;
export const BASE_FEE_FEE_SCHEDULER_EXPONENTIAL: u8 = 1n;
/** Deprecated for new configs; existing pools still swap with it. */
export const BASE_FEE_RATE_LIMITER: u8 = 2n;
/** CollectFeeMode (state/virtual_pool.rs): 0 QuoteToken, 1 OutputToken. */
export const COLLECT_FEE_MODE_COUNT: u8 = 2n;
/** MigratedCollectFeeMode (migration_handler/mod.rs): 0 QuoteToken, 1 OutputToken, 2 Compounding. */
export const MIGRATED_COLLECT_FEE_MODE_COMPOUNDING: u8 = 2n;
/** MigrationOption: 0 MeteoraDamm (deprecated for new configs), 1 DammV2. */
export const MIGRATION_OPTION_METEORA_DAMM: u8 = 0n;
export const MIGRATION_OPTION_DAMM_V2: u8 = 1n;
/** TokenType: 0 SplToken, 1 Token2022. */
export const TOKEN_TYPE_SPL: u8 = 0n;
export const TOKEN_TYPE_TOKEN_2022: u8 = 1n;
/** MigrationFeeOption: FixedBps25 … FixedBps600 (0 … 5), Customizable (6). */
export const MIGRATION_FEE_OPTION_CUSTOMIZABLE: u8 = 6n;
/** TokenAuthorityOption: CreatorUpdateAuthority, Immutable, PartnerUpdateAuthority, CreatorUpdateAndMintAuthority, PartnerUpdateAndMintAuthority. */
export const TOKEN_AUTHORITY_CREATOR_UPDATE: u8 = 0n;
export const TOKEN_AUTHORITY_IMMUTABLE: u8 = 1n;
export const TOKEN_AUTHORITY_PARTNER_UPDATE: u8 = 2n;
export const TOKEN_AUTHORITY_CREATOR_UPDATE_AND_MINT: u8 = 3n;
export const TOKEN_AUTHORITY_PARTNER_UPDATE_AND_MINT: u8 = 4n;
/** TransferFeeWithheldAuthority: 0 Partner, 1 Creator. */
export const TRANSFER_FEE_WITHHELD_PARTNER: u8 = 0n;
/** MigratedTransferFeeAuthorityOption: Immutable, RevokeZeroFee, Creator, Partner. */
export const MIGRATED_TRANSFER_FEE_IMMUTABLE: u8 = 0n;
export const MIGRATED_TRANSFER_FEE_REVOKE_ZERO_FEE: u8 = 1n;
export const MIGRATED_TRANSFER_FEE_PARTNER: u8 = 3n;
/** ActivationType: 0 Slot, 1 Timestamp. */
export const ACTIVATION_TYPE_COUNT: u8 = 2n;
/** DAMM v2's BaseFeeMode (utils/damm_v2_utils.rs). */
export const DAMM_V2_FEE_TIME_SCHEDULER_LINEAR: u8 = 0n;
export const DAMM_V2_FEE_TIME_SCHEDULER_EXPONENTIAL: u8 = 1n;
export const DAMM_V2_RATE_LIMITER: u8 = 2n;
export const DAMM_V2_FEE_MARKET_CAP_SCHEDULER_LINEAR: u8 = 3n;
export const DAMM_V2_FEE_MARKET_CAP_SCHEDULER_EXPONENTIAL: u8 = 4n;
/** OperatorPermission (state/operator.rs): ClaimProtocolFee, ZapProtocolFee (deprecated), CreateTokenBadge, CloseTokenBadge. */
export const OPERATOR_CLAIM_PROTOCOL_FEE: u128 = 0n;
export const OPERATOR_CREATE_TOKEN_BADGE: u128 = 2n;
export const OPERATOR_CLOSE_TOKEN_BADGE: u128 = 3n;
export const OPERATOR_PERMISSION_COUNT: u128 = 4n;
/** PoolType: 0 SplToken, 1 Token2022. MigrationProgress: PreBondingCurve, PostBondingCurve, LockedVesting, CreatedPool. */
export const MIGRATION_PROGRESS_CREATED_POOL: u8 = 3n;

// ---- PoolConfig (state/config.rs) --------------------------------------------------------------------------------

/**
 * @serialization bytemuck
 * @repr c
 */
export interface BaseFeeConfig {
  cliff_fee_numerator: u64;
  second_factor: u64;
  third_factor: u64;
  first_factor: u16;
  base_fee_mode: u8;
  padding_0: FixedArray<u8, 5>;
}

/**
 * @serialization bytemuck
 */
export interface DynamicFeeConfig {
  initialized: u8;
  padding: FixedArray<u8, 7>;
  max_volatility_accumulator: u32;
  variable_fee_control: u32;
  bin_step: u16;
  filter_period: u16;
  decay_period: u16;
  reduction_factor: u16;
  padding2: FixedArray<u8, 8>;
  bin_step_u128: u128;
}

/**
 * @serialization bytemuck
 */
export interface PoolFeesConfig {
  base_fee: BaseFeeConfig;
  dynamic_fee: DynamicFeeConfig;
}

/**
 * @serialization bytemuck
 * @repr c
 */
export interface LockedVestingConfig {
  amount_per_period: u64;
  cliff_duration_from_migration_time: u64;
  frequency: u64;
  number_of_period: u64;
  cliff_unlock_amount: u64;
  /** @idlName _padding */
  padding: u64;
}

/**
 * @serialization bytemuck
 * @repr c
 */
export interface LiquidityVestingInfo {
  is_initialized: u8;
  vesting_percentage: u8;
  /** @idlName _padding */
  padding: FixedArray<u8, 2>;
  bps_per_period: u16;
  number_of_periods: u16;
  frequency: u32;
  cliff_duration_from_migration_time: u32;
}

/**
 * @serialization bytemuck
 */
export interface LiquidityDistributionConfig {
  sqrt_price: u128;
  liquidity: u128;
}

/**
 * @serialization bytemuck
 */
export interface PoolConfig {
  /** quote mint */
  quote_mint: Pubkey;
  /** Address to get the fee */
  fee_claimer: Pubkey;
  /** Address to receive extra base token after migration, in case token is fixed supply */
  leftover_receiver: Pubkey;
  /** Pool fee */
  pool_fees: PoolFeesConfig;
  partner_liquidity_vesting_info: LiquidityVestingInfo;
  creator_liquidity_vesting_info: LiquidityVestingInfo;
  /** Base mint transfer fee in basis points */
  transfer_fee_basis_points: u16;
  /** See TransferFeeWithheldAuthority (0 means partner, 1 means creator) */
  transfer_fee_withheld_authority: u8;
  /** See MigratedTransferFeeAuthorityOption */
  migrated_transfer_fee_authority_option: u8;
  /** Transfer fee flag */
  transfer_fee_flag: u8;
  /** Padding for future use */
  padding_0: FixedArray<u8, 9>;
  /** Previously was protocol and referral fee percent. Beware of tombstone. */
  padding_1: u16;
  /** Collect fee mode */
  collect_fee_mode: u8;
  /** migration option */
  migration_option: u8;
  /** whether mode slot or timestamp */
  activation_type: u8;
  /** token decimals */
  token_decimal: u8;
  /** config version, see `CONFIG_VERSION` */
  version: u8;
  /** token type of base token */
  token_type: u8;
  /** quote token flag */
  quote_token_flag: u8;
  /** partner locked liquidity percentage */
  partner_permanent_locked_liquidity_percentage: u8;
  /** partner liquidity percentage */
  partner_liquidity_percentage: u8;
  /** creator post migration fee percentage */
  creator_permanent_locked_liquidity_percentage: u8;
  /** creator liquidity percentage */
  creator_liquidity_percentage: u8;
  /** migration fee option */
  migration_fee_option: u8;
  /** flag to indicate whether token is dynamic supply (0) or fixed supply (1) */
  fixed_token_supply_flag: u8;
  /** creator trading fee percentage */
  creator_trading_fee_percentage: u8;
  /** token update authority */
  token_update_authority: u8;
  /** migration fee percentage */
  migration_fee_percentage: u8;
  /** creator migration fee percentage */
  creator_migration_fee_percentage: u8;
  padding_2: FixedArray<u8, 7>;
  /** swap base amount */
  swap_base_amount: u64;
  /** migration quote threshold (in quote token) */
  migration_quote_threshold: u64;
  /** migration base threshold (in base token) */
  migration_base_threshold: u64;
  /** migration sqrt price */
  migration_sqrt_price: u128;
  /** locked vesting config */
  locked_vesting_config: LockedVestingConfig;
  /** pre migration token supply */
  pre_migration_token_supply: u64;
  /** post migration token supply */
  post_migration_token_supply: u64;
  /** migrated pool collect fee mode */
  migrated_collect_fee_mode: u8;
  /** migrated dynamic fee option. */
  migrated_dynamic_fee: u8;
  /** migrated pool fee in bps */
  migrated_pool_fee_bps: u16;
  migrated_pool_base_fee_mode: u8;
  enable_first_swap_with_min_fee: u8;
  /** compounding fee bps for migrated DAMM v2 pool, should only be non-zero if migrated_collect_fee_mode is 2 (Compounding) */
  migrated_compounding_fee_bps: u16;
  /** pool creation fee in lamports value */
  pool_creation_fee: u64;
  /** serialized MigratedPoolMarketCapFeeSchedulerParams, only used when migrated_pool_base_fee_mode is market cap scheduler */
  migrated_pool_base_fee_bytes: FixedArray<u8, 16>;
  /** minimum price */
  sqrt_start_price: u128;
  /** curve, only use 20 point firstly, we can extend that latter */
  curve: FixedArray<LiquidityDistributionConfig, 20>;
}

/**
 * The PoolConfig account: one PoolConfig at offset 0 under PoolConfig's discriminator. It is declared as a wrapper so
 * that config creation fills it and ConfigWithTransferHook's nested PoolConfig the same way (a helper changes a
 * struct place, not an account); the bytes are PoolConfig's.
 * @discriminator account:PoolConfig
 * @serialization bytemuck
 */
export interface PoolConfigAccount {
  config: PoolConfig;
}

/**
 * @serialization bytemuck
 */
export interface ConfigWithTransferHook {
  config: PoolConfig;
  transfer_hook_program: Pubkey;
  padding_0: FixedArray<u64, 6>;
}

// ---- pools (state/virtual_pool.rs, state/fee.rs) -----------------------------------------------------------------

/**
 * @serialization bytemuck
 */
export interface VolatilityTracker {
  last_update_timestamp: u64;
  padding: FixedArray<u8, 8>;
  sqrt_price_reference: u128;
  volatility_accumulator: u128;
  volatility_reference: u128;
}

/**
 * @serialization bytemuck
 * @repr c
 */
export interface PoolMetrics {
  total_protocol_base_fee: u64;
  total_protocol_quote_fee: u64;
  total_trading_base_fee: u64;
  total_trading_quote_fee: u64;
}

/**
 * @serialization bytemuck
 */
export interface PoolState {
  /** volatility tracker */
  volatility_tracker: VolatilityTracker;
  /** config key */
  config: Pubkey;
  /** creator */
  creator: Pubkey;
  /** base mint */
  base_mint: Pubkey;
  /** base vault */
  base_vault: Pubkey;
  /** quote vault */
  quote_vault: Pubkey;
  /** base reserve */
  base_reserve: u64;
  /** quote reserve */
  quote_reserve: u64;
  /** protocol base fee */
  protocol_base_fee: u64;
  /** protocol quote fee */
  protocol_quote_fee: u64;
  /** partner base fee */
  partner_base_fee: u64;
  /** trading quote fee */
  partner_quote_fee: u64;
  /** current price */
  sqrt_price: u128;
  /** Activation point */
  activation_point: u64;
  /** pool type, spl token or token2022 */
  pool_type: u8;
  /** is migrated */
  is_migrated: u8;
  /** is partner withdraw surplus */
  is_partner_withdraw_surplus: u8;
  /** is protocol withdraw surplus */
  is_protocol_withdraw_surplus: u8;
  /** migration progress */
  migration_progress: u8;
  /** is withdraw leftover */
  is_withdraw_leftover: u8;
  /** is creator withdraw surplus */
  is_creator_withdraw_surplus: u8;
  /** migration fee withdraw status: bit 1 (0b010) creator, bit 2 (0b100) partner */
  migration_fee_withdraw_status: u8;
  /** pool metrics */
  metrics: PoolMetrics;
  /** The time curve is finished */
  finish_curve_timestamp: u64;
  /** creator base fee */
  creator_base_fee: u64;
  /** creator quote fee */
  creator_quote_fee: u64;
  /** legacy creation fee bits, we dont use this now */
  legacy_creation_fee_bits: u8;
  /** pool creation fee claim status */
  creation_fee_bits: u8;
  /** Cached flag */
  has_swap: u8;
  /**
   * Padding for further use
   * @idlName _padding_0
   */
  padding_0: FixedArray<u8, 5>;
  protocol_liquidity_migration_fee_bps: u16;
  /** @idlName _padding_1 */
  padding_1: FixedArray<u8, 6>;
  protocol_migration_base_fee_amount: u64;
  protocol_migration_quote_fee_amount: u64;
  /**
   * Padding for further use
   * @idlName _padding_2
   */
  padding_2: FixedArray<u64, 3>;
}

/**
 * @serialization bytemuck
 */
export interface VirtualPool {
  pool_state: PoolState;
}

/**
 * @serialization bytemuck
 */
export interface TransferHookPool {
  pool_state: PoolState;
}

// ---- admin, operator, partner accounts ---------------------------------------------------------------------------

/**
 * @serialization bytemuck
 */
export interface Operator {
  whitelisted_address: Pubkey;
  permission: u128;
  padding: FixedArray<u64, 2>;
}

/**
 * Parameter that set by the protocol
 * @serialization bytemuck
 * @repr c
 */
export interface TokenBadge {
  /** token mint */
  token_mint: Pubkey;
  /**
   * Reserve
   * @idlName _padding
   */
  padding: FixedArray<u8, 128>;
}

/**
 * Parameter that set by the protocol
 * @serialization bytemuck
 * @repr c
 */
export interface ClaimFeeOperator {
  /** operator */
  operator: Pubkey;
  /**
   * Reserve
   * @idlName _padding
   */
  padding: FixedArray<u8, 128>;
}

/**
 * Metadata for a partner. Anchor's Borsh account, exactly as long as its Strings: each String is held as a Vec<u8>
 * (the same Borsh bytes: u32 length, then the UTF-8), which lets the account be sized to its contents (this
 * program's IDL calls them bytes).
 * @layout borsh
 */
export interface PartnerMetadata {
  /** fee claimer */
  fee_claimer: Pubkey;
  /** padding for future use */
  padding: FixedArray<u128, 6>;
  /** Name of partner. */
  name: Vec<u8>;
  /** Website of partner. */
  website: Vec<u8>;
  /** Logo of partner */
  logo: Vec<u8>;
}

/**
 * Metadata for a virtual pool (Strings held as Vec<u8>, as in PartnerMetadata).
 * @layout borsh
 */
export interface VirtualPoolMetadata {
  /** virtual pool */
  virtual_pool: Pubkey;
  /** padding for future use */
  padding: FixedArray<u128, 6>;
  /** Name of project. */
  name: Vec<u8>;
  /** Website of project. */
  website: Vec<u8>;
  /** Logo of project */
  logo: Vec<u8>;
}

// ---- migration metadata (instructions/migration/*_metadata_state.rs) ---------------------------------------------

/**
 * @serialization bytemuck
 * @repr c
 */
export interface MeteoraDammMigrationMetadata {
  /** pool */
  virtual_pool: Pubkey;
  /** !!! BE CAREFUL to use tombstone field, previous is pool creator */
  padding_0: FixedArray<u8, 32>;
  /** partner */
  partner: Pubkey;
  /** lp mint */
  lp_mint: Pubkey;
  /** partner locked liquidity */
  partner_locked_liquidity: u64;
  /** partner liquidity */
  partner_liquidity: u64;
  /** creator locked liquidity */
  creator_locked_liquidity: u64;
  /** creator liquidity */
  creator_liquidity: u64;
  /**
   * padding
   * @idlName _padding_0
   */
  padding_0b: u8;
  /** flag to check whether liquidity token is locked for creator */
  creator_locked_status: u8;
  /** flag to check whether liquidity token is locked for partner */
  partner_locked_status: u8;
  /** flag to check whether creator has claimed liquidity token */
  creator_claim_status: u8;
  /** flag to check whether partner has claimed liquidity token */
  partner_claim_status: u8;
  /**
   * Reserve
   * @idlName _padding
   */
  padding: FixedArray<u8, 107>;
}

/**
 * Deprecated (migration_damm_v2_create_metadata).
 * @serialization bytemuck
 * @repr c
 */
export interface MeteoraDammV2Metadata {
  /** pool */
  virtual_pool: Pubkey;
  /** !!! BE CAREFUL to use tomestone field, previous is pool creator */
  padding_0: FixedArray<u8, 32>;
  /** partner */
  partner: Pubkey;
  /**
   * Reserve
   * @idlName _padding
   */
  padding: FixedArray<u8, 126>;
}

// ---- instruction arguments (params/*.rs, create_config/process_create_config.rs, partner and creator metadata) ---

export interface BaseFeeParameters {
  cliff_fee_numerator: u64;
  first_factor: u16;
  second_factor: u64;
  third_factor: u64;
  base_fee_mode: u8;
}

export interface DynamicFeeParameters {
  bin_step: u16;
  bin_step_u128: u128;
  filter_period: u16;
  decay_period: u16;
  reduction_factor: u16;
  max_volatility_accumulator: u32;
  variable_fee_control: u32;
}

/** Information regarding fee charges */
export interface PoolFeeParameters {
  /** Base fee */
  base_fee: BaseFeeParameters;
  /** dynamic fee */
  dynamic_fee: Option<DynamicFeeParameters>;
}

export interface LiquidityDistributionParameters {
  sqrt_price: u128;
  liquidity: u128;
}

export interface LockedVestingParams {
  amount_per_period: u64;
  cliff_duration_from_migration_time: u64;
  frequency: u64;
  number_of_period: u64;
  cliff_unlock_amount: u64;
}

export interface TokenSupplyParams {
  /** pre migration token supply */
  pre_migration_token_supply: u64;
  /** post migration token supply */
  post_migration_token_supply: u64;
}

export interface MigrationFee {
  fee_percentage: u8;
  creator_fee_percentage: u8;
}

export interface MigratedPoolFee {
  collect_fee_mode: u8;
  dynamic_fee: u8;
  pool_fee_bps: u16;
}

export interface MigratedPoolMarketCapFeeSchedulerParams {
  number_of_period: u16;
  sqrt_price_step_bps: u16;
  scheduler_expiration_duration: u32;
  reduction_factor: u64;
}

export interface LiquidityVestingInfoParams {
  vesting_percentage: u8;
  bps_per_period: u16;
  number_of_periods: u16;
  cliff_duration_from_migration_time: u32;
  frequency: u32;
}

export interface TransferFeeParameters {
  transfer_fee_basis_points: u16;
  withheld_authority: u8;
  migrated_transfer_fee_authority_option: u8;
}

/**
 * ConfigParameters as an instruction argument. Anchor's `curve` is a Vec of any length (validated to 1..=16 points);
 * here a Borsh Vec of at most 24: a transaction (1,232 bytes) carries at most 23 points.
 */
export interface ConfigParameters {
  pool_fees: PoolFeeParameters;
  collect_fee_mode: u8;
  migration_option: u8;
  activation_type: u8;
  token_type: u8;
  token_decimal: u8;
  partner_liquidity_percentage: u8;
  partner_permanent_locked_liquidity_percentage: u8;
  creator_liquidity_percentage: u8;
  creator_permanent_locked_liquidity_percentage: u8;
  migration_quote_threshold: u64;
  sqrt_start_price: u128;
  locked_vesting: LockedVestingParams;
  migration_fee_option: u8;
  token_supply: Option<TokenSupplyParams>;
  creator_trading_fee_percentage: u8;
  token_update_authority: u8;
  migration_fee: MigrationFee;
  migrated_pool_fee: MigratedPoolFee;
  /** pool creation fee in SOL lamports value */
  pool_creation_fee: u64;
  partner_liquidity_vesting_info: LiquidityVestingInfoParams;
  creator_liquidity_vesting_info: LiquidityVestingInfoParams;
  migrated_pool_base_fee_mode: u8;
  migrated_pool_market_cap_fee_scheduler_params: MigratedPoolMarketCapFeeSchedulerParams;
  enable_first_swap_with_min_fee: boolean;
  compounding_fee_bps: u16;
  /** padding for future use */
  padding: FixedArray<u8, 2>;
  curve: FixedVec<LiquidityDistributionParameters, 24>;
}

/** @layout borsh */
export interface CreatePartnerMetadataParameters {
  /** padding for future use */
  padding: FixedArray<u8, 96>;
  name: string;
  website: string;
  logo: string;
}

/** @layout borsh */
export interface CreateVirtualPoolMetadataParameters {
  /** padding for future use */
  padding: FixedArray<u8, 96>;
  name: string;
  website: string;
  logo: string;
}

/** @layout borsh */
export interface InitializePoolParameters {
  name: string;
  symbol: string;
  uri: string;
}

export interface SwapParameters {
  amount_in: u64;
  minimum_amount_out: u64;
}

export interface SwapParameters2 {
  /**
   * When it's exact in, partial fill, this will be amount_in. When it's exact out, this will be amount_out
   * @idlName amount_0
   */
  amount_0: u64;
  /**
   * When it's exact in, partial fill, this will be minimum_amount_out. When it's exact out, this will be maximum_amount_in
   * @idlName amount_1
   */
  amount_1: u64;
  /** Swap mode, refer [SwapMode] */
  swap_mode: u8;
}

/** Encodes all results of swapping */
export interface SwapResult {
  actual_input_amount: u64;
  output_amount: u64;
  next_sqrt_price: u128;
  trading_fee: u64;
  protocol_fee: u64;
  referral_fee: u64;
}

export interface SwapResult2 {
  included_fee_input_amount: u64;
  excluded_fee_input_amount: u64;
  amount_left: u64;
  output_amount: u64;
  next_sqrt_price: u128;
  trading_fee: u64;
  protocol_fee: u64;
  referral_fee: u64;
}

/** @repr rust */
export enum AccountsType {
  TransferHookBase,
  TransferHookBaseReferral,
}

export interface RemainingAccountsSlice {
  accounts_type: AccountsType;
  /** @idlName length */
  length_: u8;
}
