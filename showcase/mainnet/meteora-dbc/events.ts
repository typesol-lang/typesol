// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// The program's 29 events (programs/dynamic-bonding-curve/src/event.rs), emitted through the event authority's
// self-CPI (emit_cpi!) except EvtClaimProtocolFee2 (emit!). Each is Borsh after sha256("event:<Name>")[..8].
//
// The three config events carry the whole ConfigParameters argument, whose `curve` is a Vec. A TypeSOL event cannot
// nest a struct holding a list, so those three declare ConfigParameters' fields in place (Borsh writes a nested
// struct as its fields one after another, so the bytes are the original's; only this program's IDL describes them
// flat).
import { type FixedArray, type FixedVec, type Option, type Pubkey, type u8, type u16, type u64, type u128 } from "typesol";
import {
  type LiquidityDistributionParameters,
  type LiquidityVestingInfoParams,
  type LockedVestingParams,
  type MigratedPoolFee,
  type MigratedPoolMarketCapFeeSchedulerParams,
  type MigrationFee,
  type PoolFeeParameters,
  type SwapParameters,
  type SwapParameters2,
  type SwapResult,
  type SwapResult2,
  type TokenSupplyParams,
  type TransferFeeParameters,
} from "./state";

/** Create partner metadata */
export interface EvtPartnerMetadata {
  partner_metadata: Pubkey;
  fee_claimer: Pubkey;
}

export interface EvtVirtualPoolMetadata {
  virtual_pool_metadata: Pubkey;
  virtual_pool: Pubkey;
}

/**
 * Deprecated since 0.2.2, still emitted by create_config and create_config2.
 * @layout borsh
 */
export interface EvtCreateConfigV2 {
  config: Pubkey;
  quote_mint: Pubkey;
  fee_claimer: Pubkey;
  leftover_receiver: Pubkey;
  // config_parameters: ConfigParameters
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
  pool_creation_fee: u64;
  partner_liquidity_vesting_info: LiquidityVestingInfoParams;
  creator_liquidity_vesting_info: LiquidityVestingInfoParams;
  migrated_pool_base_fee_mode: u8;
  migrated_pool_market_cap_fee_scheduler_params: MigratedPoolMarketCapFeeSchedulerParams;
  enable_first_swap_with_min_fee: boolean;
  compounding_fee_bps: u16;
  padding: FixedArray<u8, 2>;
  curve: FixedVec<LiquidityDistributionParameters, 24>;
}

/** @layout borsh */
export interface EvtCreateConfigV2WithTransferHook {
  config: Pubkey;
  quote_mint: Pubkey;
  fee_claimer: Pubkey;
  leftover_receiver: Pubkey;
  // config_parameters: ConfigParameters
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
  pool_creation_fee: u64;
  partner_liquidity_vesting_info: LiquidityVestingInfoParams;
  creator_liquidity_vesting_info: LiquidityVestingInfoParams;
  migrated_pool_base_fee_mode: u8;
  migrated_pool_market_cap_fee_scheduler_params: MigratedPoolMarketCapFeeSchedulerParams;
  enable_first_swap_with_min_fee: boolean;
  compounding_fee_bps: u16;
  padding: FixedArray<u8, 2>;
  curve: FixedVec<LiquidityDistributionParameters, 24>;
  // end of config_parameters
  transfer_hook_program: Pubkey;
}

/** @layout borsh */
export interface EvtCreateConfig3 {
  config: Pubkey;
  quote_mint: Pubkey;
  fee_claimer: Pubkey;
  leftover_receiver: Pubkey;
  // config_parameters: ConfigParameters
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
  pool_creation_fee: u64;
  partner_liquidity_vesting_info: LiquidityVestingInfoParams;
  creator_liquidity_vesting_info: LiquidityVestingInfoParams;
  migrated_pool_base_fee_mode: u8;
  migrated_pool_market_cap_fee_scheduler_params: MigratedPoolMarketCapFeeSchedulerParams;
  enable_first_swap_with_min_fee: boolean;
  compounding_fee_bps: u16;
  padding: FixedArray<u8, 2>;
  curve: FixedVec<LiquidityDistributionParameters, 24>;
  // end of config_parameters
  transfer_fee_parameters: Option<TransferFeeParameters>;
}

/** Create claim fee operator */
export interface EvtCreateClaimFeeOperator {
  operator: Pubkey;
}

/** Close claim fee operator */
export interface EvtCloseClaimFeeOperator {
  claim_fee_operator: Pubkey;
  operator: Pubkey;
}

export interface EvtInitializePool {
  pool: Pubkey;
  config: Pubkey;
  creator: Pubkey;
  base_mint: Pubkey;
  pool_type: u8;
  activation_point: u64;
}

export interface EvtInitializePoolWithTransferHook {
  pool: Pubkey;
  config: Pubkey;
  creator: Pubkey;
  base_mint: Pubkey;
  pool_type: u8;
  activation_point: u64;
}

export interface EvtSwap {
  pool: Pubkey;
  config: Pubkey;
  trade_direction: u8;
  has_referral: boolean;
  params: SwapParameters;
  swap_result: SwapResult;
  amount_in: u64;
  current_timestamp: u64;
}

export interface EvtSwap2 {
  pool: Pubkey;
  config: Pubkey;
  trade_direction: u8;
  has_referral: boolean;
  swap_parameters: SwapParameters2;
  swap_result: SwapResult2;
  quote_reserve_amount: u64;
  migration_threshold: u64;
  current_timestamp: u64;
}

export interface EvtSwap2WithTransferHook {
  pool: Pubkey;
  config: Pubkey;
  trade_direction: u8;
  has_referral: boolean;
  swap_parameters: SwapParameters2;
  swap_result: SwapResult2;
  quote_reserve_amount: u64;
  migration_threshold: u64;
  current_timestamp: u64;
}

export interface EvtSwap3 {
  pool: Pubkey;
  config: Pubkey;
  trade_direction: u8;
  swap_mode: u8;
  has_referral: boolean;
  fee_on_base_token: boolean;
  included_transfer_fee_amount_in: u64;
  excluded_transfer_fee_amount_in: u64;
  included_transfer_fee_amount_out: u64;
  excluded_transfer_fee_amount_out: u64;
  trading_fee: u64;
  protocol_fee: u64;
  referral_fee: u64;
  next_sqrt_price: u128;
  quote_reserve: u64;
  current_timestamp: u64;
}

export interface EvtSwap3WithTransferHook {
  pool: Pubkey;
  config: Pubkey;
  trade_direction: u8;
  swap_mode: u8;
  has_referral: boolean;
  fee_on_base_token: boolean;
  included_transfer_fee_amount_in: u64;
  excluded_transfer_fee_amount_in: u64;
  included_transfer_fee_amount_out: u64;
  excluded_transfer_fee_amount_out: u64;
  trading_fee: u64;
  protocol_fee: u64;
  referral_fee: u64;
  next_sqrt_price: u128;
  quote_reserve: u64;
  current_timestamp: u64;
}

export interface EvtCurveComplete {
  pool: Pubkey;
  config: Pubkey;
  base_reserve: u64;
  quote_reserve: u64;
}

export interface EvtCurveCompleteWithTransferHook {
  pool: Pubkey;
  config: Pubkey;
  base_reserve: u64;
  quote_reserve: u64;
}

export interface EvtClaimProtocolFee2 {
  pool: Pubkey;
  receiver_token_account: Pubkey;
  token_mint: Pubkey;
  amount: u64;
}

export interface EvtClaimTradingFee {
  pool: Pubkey;
  token_base_amount: u64;
  token_quote_amount: u64;
}

export interface EvtClaimCreatorTradingFee {
  pool: Pubkey;
  token_base_amount: u64;
  token_quote_amount: u64;
}

export interface EvtCreateMeteoraMigrationMetadata {
  virtual_pool: Pubkey;
}

export interface EvtPartnerWithdrawSurplus {
  pool: Pubkey;
  surplus_amount: u64;
}

export interface EvtCreatorWithdrawSurplus {
  pool: Pubkey;
  surplus_amount: u64;
}

export interface EvtWithdrawLeftover {
  pool: Pubkey;
  leftover_receiver: Pubkey;
  leftover_amount: u64;
}

export interface EvtUpdatePoolCreator {
  pool: Pubkey;
  creator: Pubkey;
  new_creator: Pubkey;
}

export interface EvtWithdrawMigrationFee {
  pool: Pubkey;
  fee: u64;
  flag: u8;
}

export interface EvtClaimPoolCreationFee {
  pool: Pubkey;
  receiver: Pubkey;
  creation_fee: u64;
}

export interface EvtPartnerClaimPoolCreationFee {
  pool: Pubkey;
  partner: Pubkey;
  creation_fee: u64;
  fee_receiver: Pubkey;
}

export interface EvtCreateTokenBadge {
  token_mint: Pubkey;
}

export interface EvtCloseTokenBadge {
  token_mint: Pubkey;
}
