// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// Meteora's Dynamic Bonding Curve, release 0.2.2 (programs/dynamic-bonding-curve/src/lib.rs and instructions/):
// launch pools that sell a base token along a curve of up to 16 constant-liquidity segments and migrate to a DAMM
// pool when the quote threshold is reached.
//
// All 35 of the program's instructions are here (README.md lists them by stage).
//
// Anchor checks each instruction's accounts first (the `init` accounts created among them), then its
// `#[access_control]` function, then the handler; the bodies below keep that order: creates first, then the access
// check, then the handler's own checks.
import {
  type Account,
  type AccountInfo,
  type Address,
  type Ata,
  type Seeds,
  type Dup,
  type HasOne,
  type Owner,
  type TokenAccount,
  type TokenInterface,
  type TokenOf,
  type MintOf,
  type TokenProgram,
  type UncheckedProgram,
  type CloseTo,
  type EventAuthority,
  type Executable,
  type Inout,
  type Init,
  type Mint,
  type Mut,
  type Option,
  type Pubkey,
  type RemainingAccounts,
  type SelfProgram,
  type Signer,
  type SignerSeeds,
  type SystemProgram,
  type Token2022Program,
  AnchorError,
  AuthorityType,
  ProgramError,
  currentSlot,
  invoke,
  log,
  panic,
  sighash,
  u32,
  readonly,
  readonlySigner,
  readData,
  writable,
  writableSigner,
  u16,
  byteLength,
  constraint,
  loadAccount,
  rentExempt,
  loadRawAt,
  loadRawMutAt,
  emit,
  emitCpi,
  findProgramAddress,
  findProgramAddressBump,
  instructionData,
  now,
  programId,
  pubkey,
  remainingAccounts,
  require,
  signer,
  u8,
  u64,
  u128,
} from "typesol";
import { type DammV2VestingParameters } from "./fees";
import { type DammV1LockEscrow, DAMM_V1_CONFIG_SIZE, DAMM_V1_PROGRAM_ID, DISC_DAMM_V1_CONFIG, validateDammV1Config } from "./damm_v1";
import { DEFAULT_PUBKEY, dammV2VestingParameters, validateTransferFeeRestrictions, initialBaseSupply, totalLiquidityLockedBpsAtNSeconds, processCreateConfig, validateConfigParameters, validateTransferFeeParameters } from "./config";
import { PoolError } from "./errors";
import { type EvtCreateMeteoraMigrationMetadata, type EvtPartnerWithdrawSurplus, type EvtCreatorWithdrawSurplus, type EvtWithdrawLeftover, type EvtWithdrawMigrationFee, type EvtInitializePool, type EvtInitializePoolWithTransferHook, type EvtSwap2WithTransferHook, type EvtSwap3WithTransferHook, type EvtCurveCompleteWithTransferHook, type EvtClaimProtocolFee2, type EvtVirtualPoolMetadata, type EvtClaimCreatorTradingFee, type EvtClaimPoolCreationFee, type EvtClaimTradingFee, type EvtPartnerClaimPoolCreationFee, type EvtUpdatePoolCreator, type EvtCurveComplete, type EvtSwap, type EvtSwap2, type EvtSwap3, type EvtCreateConfig3, type EvtCreateConfigV2, type EvtCreateConfigV2WithTransferHook, type EvtCloseClaimFeeOperator, type EvtCloseTokenBadge, type EvtCreateTokenBadge, type EvtPartnerMetadata } from "./events";
import { U64_MAX, addU128, addU64, addU8, safeMulDivCastU128, safeMulDivCastU64, subU128, subU64 } from "./math";
import {
  type LiquidityItem,
  SPLIT_POSITION_DENOMINATOR,
  adjustLiquidity,
  dammPoolReserves,
  dammPositionUnlockedLiquidity,
  epochFeeOf,
  mintFeeIsZero,
  hasTransferFeeOrConfigAuthorityOf,
  itemLocked,
  itemTotal,
  liquidityItem,
  migratedBaseFee,
  migratedDynamicFeeControl,
  migrationFeeDistribution,
  surplusSplit,
  validateDammConfig,
} from "./damm_v2";
import {
  DAMM_V2_COMPOUNDING_DEAD_LIQUIDITY,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  compoundingDepositAmounts,
  compoundingInitialSqrtPriceAndLiquidity,
  compoundingLiquidityDelta,
  compoundingProtocolFees,
  concentratedInitialLiquidity,
  concentratedProtocolFees,
  includedProtocolFeeMigrationAmounts2,
} from "./migration";
import { BIN_STEP_BPS_DEFAULT, BIN_STEP_BPS_U128_DEFAULT, DECAY_PERIOD_DEFAULT, FILTER_PERIOD_DEFAULT, MAX_VOLATILITY_ACCUMULATOR, REDUCTION_FACTOR_DEFAULT, validateMinBaseFee } from "./fees";
import {
  type HookAccounts,
  POOL_AUTHORITY_BUMP,
  checkConfigAccount,
  checkPoolAccount,
  finishSwap,
  noHookAccounts,
  parseHookSlice,
  processSwap,
  requireHookParsed,
  requireNoTransferHook,
  transferFromPoolAuthority,
} from "./process_swap";
import {
  type ClaimFeeOperator,
  type MeteoraDammMigrationMetadata,
  type ConfigParameters,
  type ConfigWithTransferHook,
  type CreatePartnerMetadataParameters,
  type CreateVirtualPoolMetadataParameters,
  type InitializePoolParameters,
  type VirtualPool,
  type VirtualPoolMetadata,
  type Operator,
  type PartnerMetadata,
  type PoolConfig,
  type PoolConfigAccount,
  type PoolState,
  type TokenBadge,
  type TransferHookPool,
  type TransferHookAccountsInfo,
  AccountsType,
  type SwapParameters,
  type SwapParameters2,
  type TransferFeeParameters,
  MIGRATED_COLLECT_FEE_MODE_COMPOUNDING,
  MIGRATION_FEE_OPTION_CUSTOMIZABLE,
  MIGRATION_OPTION_DAMM_V2,
  MIGRATION_OPTION_METEORA_DAMM,
  MIGRATION_PROGRESS_CREATED_POOL,
  OPERATOR_CLAIM_PROTOCOL_FEE,
  OPERATOR_CLOSE_TOKEN_BADGE,
  OPERATOR_CREATE_TOKEN_BADGE,
  OPERATOR_PERMISSION_COUNT,
  TOKEN_TYPE_TOKEN_2022,
} from "./state";
import {
  MINT_SCORE_PERMISSIONED_WITH_TRANSFER_FEE,
  MINT_SCORE_PERMISSIONED_WITHOUT_TRANSFER_FEE,
  MINT_SCORE_UNSUPPORTED,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  calculateFee,
  epochFee,
  mintScore,
  mintScoreWithBadge,
  token2022BaseMintSpace,
  token2022BaseVaultSpace,
  tokenAccountSpace,
} from "./token";

/** Rust's arithmetic under `overflow-checks = true`: a bare operator that overflows panics. */
export const PANIC_ON_OVERFLOW = true;
/** Anchor 1.0.2's #[event_cpi]: the event authority checked by address (2012), the program account not checked. */
export const EVENT_AUTHORITY_CHECK = "address";

/** instructions/admin/auth.rs: the two admins (mainnet). */
const ADMIN_1 = pubkey("5unTfT2kssBuNvHPY6LbJfJpLqEcdMxGYLWHwShaeTLi");
const ADMIN_2 = pubkey("DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX");

/** access_control.rs is_admin */
function isAdmin(signer: Pubkey): void {
  require(signer === ADMIN_1 || signer === ADMIN_2, PoolError.InvalidAdmin);
}

/** access_control.rs is_valid_operator_role: the operator's whitelisted key signed and holds the permission bit. */
function isValidOperatorRole(operator: Account<Operator>, signer: Pubkey, permission: u128): void {
  require(operator.whitelisted_address === signer && (operator.permission & (1n << permission)) !== 0n, PoolError.InvalidPermission);
}

/** `Clock::get()?.unix_timestamp as u64` (a wrapping cast). */
function nowAsU64(): u64 {
  const t = now();
  if (t >= 0n) return u64(t);
  return U64_MAX - u64(-(t + 1n));
}

/** get_mint_score with the token badge a config instruction may pass as its first remaining account. */
function firstRemainingAccountScore(quoteMint: Mint, rest: RemainingAccounts): u64 {
  if (rest.length > 0n) return mintScoreWithBadge(quoteMint, rest.get(0n));
  return mintScore(quoteMint);
}

/** The transfer fee parameters create_config and create_config_with_transfer_hook do not take. */
function noTransferFee(): TransferFeeParameters {
  return { transfer_fee_basis_points: 0n, withheld_authority: 0n, migrated_transfer_fee_authority_option: 0n };
}

// ---- admin ------------------------------------------------------------------------------------------------------

/** Create an operator account (PDA ["operator", whitelisted address]) with a permission bitmask. Admin only. */
export function createOperatorAccount(
  operator: Init<Operator>,
  whitelistedAddress: AccountInfo,
  signer: Signer,
  payer: Mut<Signer>,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  permission: u128,
): void {
  operator.create(payer, ["operator", whitelistedAddress.key]);
  isAdmin(signer.key);
  // bitmask_max(OperatorPermission::VARIANT_COUNT) = (1 << 4) - 1
  require(permission > 0n && permission <= (1n << OPERATOR_PERMISSION_COUNT) - 1n, PoolError.InvalidPermission);
  operator.whitelisted_address = whitelistedAddress.key;
  operator.permission = permission;
}

/** Close an operator account, its rent to `rent_receiver`. Admin only. */
export function closeOperatorAccount(operator: CloseTo<Mut<Operator>, "rentReceiver">, signer: Signer, rentReceiver: Mut<AccountInfo>): void {
  isAdmin(signer.key);
}

/** Close a legacy ClaimFeeOperator account, its rent to `rent_receiver`. Admin only. */
export function closeClaimProtocolFeeOperator(
  claimFeeOperator: CloseTo<Mut<ClaimFeeOperator>, "rentReceiver">,
  rentReceiver: Mut<AccountInfo>,
  signer: Signer,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  isAdmin(signer.key);
  emitCpi<EvtCloseClaimFeeOperator>({ claim_fee_operator: claimFeeOperator.key, operator: claimFeeOperator.operator }, eventAuthority, program);
}

// ---- operator ---------------------------------------------------------------------------------------------------

/** Whitelist a quote mint the permissionless rules refuse (PDA ["token_badge", mint]). Operators with CreateTokenBadge. */
export function createTokenBadge(
  tokenBadge: Init<TokenBadge>,
  tokenMint: Mint,
  operator: Account<Operator>,
  signer: Signer,
  payer: Mut<Signer>,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  tokenBadge.create(payer, ["token_badge", tokenMint.key]);
  isValidOperatorRole(operator, signer.key, OPERATOR_CREATE_TOKEN_BADGE);
  require(mintScore(tokenMint) === MINT_SCORE_UNSUPPORTED, PoolError.CannotCreateTokenBadgeOnSupportedMint);
  tokenBadge.token_mint = tokenMint.key;
  emitCpi<EvtCreateTokenBadge>({ token_mint: tokenMint.key }, eventAuthority, program);
}

/** Close a token badge, its rent to `rent_receiver`. Operators with CloseTokenBadge. */
export function closeTokenBadge(
  tokenBadge: CloseTo<Mut<TokenBadge>, "rentReceiver">,
  operator: Account<Operator>,
  signer: Signer,
  rentReceiver: Mut<AccountInfo>,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  isValidOperatorRole(operator, signer.key, OPERATOR_CLOSE_TOKEN_BADGE);
  emitCpi<EvtCloseTokenBadge>({ token_mint: tokenBadge.token_mint }, eventAuthority, program);
}

// ---- partner ----------------------------------------------------------------------------------------------------

/** A partner's name, website and logo (PDA ["partner_metadata", fee claimer]), sized to them. */
export function createPartnerMetadata(
  partnerMetadata: Init<PartnerMetadata>,
  payer: Mut<Signer>,
  feeClaimer: Signer,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  metadata: CreatePartnerMetadataParameters,
): void {
  // 8 + PartnerMetadata::space: the key, 6 × u128 of padding and the three Strings
  partnerMetadata.create(
    payer,
    ["partner_metadata", feeClaimer.key],
    8n + 32n + 96n + 4n + byteLength(metadata.name) + 4n + byteLength(metadata.website) + 4n + byteLength(metadata.logo),
  );
  partnerMetadata.fee_claimer = feeClaimer.key;
  // The Strings' bytes, as the instruction data carries them after the discriminator and the 96 bytes of padding.
  const data = instructionData();
  const nameAt = 8n + 96n;
  const websiteAt = nameAt + 4n + byteLength(metadata.name);
  const logoAt = websiteAt + 4n + byteLength(metadata.website);
  for (const b of data.slice(nameAt + 4n, websiteAt)) partnerMetadata.name.push(b);
  for (const b of data.slice(websiteAt + 4n, logoAt)) partnerMetadata.website.push(b);
  for (const b of data.slice(logoAt + 4n, logoAt + 4n + byteLength(metadata.logo))) partnerMetadata.logo.push(b);
  emitCpi<EvtPartnerMetadata>({ partner_metadata: partnerMetadata.key, fee_claimer: feeClaimer.key }, eventAuthority, program);
}

/** create_config (deprecated since 0.2.2, still deployed): a config at a new keypair account. */
export function createConfig(
  config: Init<PoolConfigAccount>,
  feeClaimer: AccountInfo,
  leftoverReceiver: AccountInfo,
  quoteMint: Mint,
  payer: Mut<Signer>,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  configParameters: ConfigParameters,
): void {
  config.create(payer, null);
  require(firstRemainingAccountScore(quoteMint, remainingAccounts()) >= MINT_SCORE_PERMISSIONED_WITHOUT_TRANSFER_FEE, PoolError.InvalidQuoteMint);
  validateConfigParameters(configParameters, nowAsU64(), false, feeClaimer.key);
  processCreateConfig(config.config, configParameters, false, noTransferFee(), quoteMint, feeClaimer.key, leftoverReceiver.key);
  {
    emitCpi<EvtCreateConfigV2>(
      {
        config: config.key,
        quote_mint: quoteMint.key,
        fee_claimer: feeClaimer.key,
        leftover_receiver: leftoverReceiver.key,
        pool_fees: configParameters.pool_fees,
        collect_fee_mode: configParameters.collect_fee_mode,
        migration_option: configParameters.migration_option,
        activation_type: configParameters.activation_type,
        token_type: configParameters.token_type,
        token_decimal: configParameters.token_decimal,
        partner_liquidity_percentage: configParameters.partner_liquidity_percentage,
        partner_permanent_locked_liquidity_percentage: configParameters.partner_permanent_locked_liquidity_percentage,
        creator_liquidity_percentage: configParameters.creator_liquidity_percentage,
        creator_permanent_locked_liquidity_percentage: configParameters.creator_permanent_locked_liquidity_percentage,
        migration_quote_threshold: configParameters.migration_quote_threshold,
        sqrt_start_price: configParameters.sqrt_start_price,
        locked_vesting: configParameters.locked_vesting,
        migration_fee_option: configParameters.migration_fee_option,
        token_supply: configParameters.token_supply,
        creator_trading_fee_percentage: configParameters.creator_trading_fee_percentage,
        token_update_authority: configParameters.token_update_authority,
        migration_fee: configParameters.migration_fee,
        migrated_pool_fee: configParameters.migrated_pool_fee,
        pool_creation_fee: configParameters.pool_creation_fee,
        partner_liquidity_vesting_info: configParameters.partner_liquidity_vesting_info,
        creator_liquidity_vesting_info: configParameters.creator_liquidity_vesting_info,
        migrated_pool_base_fee_mode: configParameters.migrated_pool_base_fee_mode,
        migrated_pool_market_cap_fee_scheduler_params: configParameters.migrated_pool_market_cap_fee_scheduler_params,
        enable_first_swap_with_min_fee: configParameters.enable_first_swap_with_min_fee,
        compounding_fee_bps: configParameters.compounding_fee_bps,
        padding: configParameters.padding,
        curve: configParameters.curve,
      },
      eventAuthority,
      program,
    );
  }
  emitCpi<EvtCreateConfig3>(
    {
      config: config.key,
      quote_mint: quoteMint.key,
      fee_claimer: feeClaimer.key,
      leftover_receiver: leftoverReceiver.key,
      pool_fees: configParameters.pool_fees,
      collect_fee_mode: configParameters.collect_fee_mode,
      migration_option: configParameters.migration_option,
      activation_type: configParameters.activation_type,
      token_type: configParameters.token_type,
      token_decimal: configParameters.token_decimal,
      partner_liquidity_percentage: configParameters.partner_liquidity_percentage,
      partner_permanent_locked_liquidity_percentage: configParameters.partner_permanent_locked_liquidity_percentage,
      creator_liquidity_percentage: configParameters.creator_liquidity_percentage,
      creator_permanent_locked_liquidity_percentage: configParameters.creator_permanent_locked_liquidity_percentage,
      migration_quote_threshold: configParameters.migration_quote_threshold,
      sqrt_start_price: configParameters.sqrt_start_price,
      locked_vesting: configParameters.locked_vesting,
      migration_fee_option: configParameters.migration_fee_option,
      token_supply: configParameters.token_supply,
      creator_trading_fee_percentage: configParameters.creator_trading_fee_percentage,
      token_update_authority: configParameters.token_update_authority,
      migration_fee: configParameters.migration_fee,
      migrated_pool_fee: configParameters.migrated_pool_fee,
      pool_creation_fee: configParameters.pool_creation_fee,
      partner_liquidity_vesting_info: configParameters.partner_liquidity_vesting_info,
      creator_liquidity_vesting_info: configParameters.creator_liquidity_vesting_info,
      migrated_pool_base_fee_mode: configParameters.migrated_pool_base_fee_mode,
      migrated_pool_market_cap_fee_scheduler_params: configParameters.migrated_pool_market_cap_fee_scheduler_params,
      enable_first_swap_with_min_fee: configParameters.enable_first_swap_with_min_fee,
      compounding_fee_bps: configParameters.compounding_fee_bps,
      padding: configParameters.padding,
      curve: configParameters.curve,
      transfer_fee_parameters: null,
    },
    eventAuthority,
    program,
  );
}

/** create_config2: create_config with an optional base-mint transfer fee; badged quote mints may have a transfer fee. */
export function createConfig2(
  config: Init<PoolConfigAccount>,
  feeClaimer: AccountInfo,
  leftoverReceiver: AccountInfo,
  quoteMint: Mint,
  payer: Mut<Signer>,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  configParameters: ConfigParameters,
  transferFeeParameters: Option<TransferFeeParameters>,
): void {
  config.create(payer, null);
  require(firstRemainingAccountScore(quoteMint, remainingAccounts()) >= MINT_SCORE_PERMISSIONED_WITH_TRANSFER_FEE, PoolError.InvalidQuoteMint);
  validateConfigParameters(configParameters, nowAsU64(), false, feeClaimer.key);
  if (transferFeeParameters !== null) validateTransferFeeParameters(transferFeeParameters, configParameters.token_type, feeClaimer.key);
  if (transferFeeParameters !== null) processCreateConfig(config.config, configParameters, true, transferFeeParameters, quoteMint, feeClaimer.key, leftoverReceiver.key);
  else processCreateConfig(config.config, configParameters, false, noTransferFee(), quoteMint, feeClaimer.key, leftoverReceiver.key);
  {
    emitCpi<EvtCreateConfigV2>(
      {
        config: config.key,
        quote_mint: quoteMint.key,
        fee_claimer: feeClaimer.key,
        leftover_receiver: leftoverReceiver.key,
        pool_fees: configParameters.pool_fees,
        collect_fee_mode: configParameters.collect_fee_mode,
        migration_option: configParameters.migration_option,
        activation_type: configParameters.activation_type,
        token_type: configParameters.token_type,
        token_decimal: configParameters.token_decimal,
        partner_liquidity_percentage: configParameters.partner_liquidity_percentage,
        partner_permanent_locked_liquidity_percentage: configParameters.partner_permanent_locked_liquidity_percentage,
        creator_liquidity_percentage: configParameters.creator_liquidity_percentage,
        creator_permanent_locked_liquidity_percentage: configParameters.creator_permanent_locked_liquidity_percentage,
        migration_quote_threshold: configParameters.migration_quote_threshold,
        sqrt_start_price: configParameters.sqrt_start_price,
        locked_vesting: configParameters.locked_vesting,
        migration_fee_option: configParameters.migration_fee_option,
        token_supply: configParameters.token_supply,
        creator_trading_fee_percentage: configParameters.creator_trading_fee_percentage,
        token_update_authority: configParameters.token_update_authority,
        migration_fee: configParameters.migration_fee,
        migrated_pool_fee: configParameters.migrated_pool_fee,
        pool_creation_fee: configParameters.pool_creation_fee,
        partner_liquidity_vesting_info: configParameters.partner_liquidity_vesting_info,
        creator_liquidity_vesting_info: configParameters.creator_liquidity_vesting_info,
        migrated_pool_base_fee_mode: configParameters.migrated_pool_base_fee_mode,
        migrated_pool_market_cap_fee_scheduler_params: configParameters.migrated_pool_market_cap_fee_scheduler_params,
        enable_first_swap_with_min_fee: configParameters.enable_first_swap_with_min_fee,
        compounding_fee_bps: configParameters.compounding_fee_bps,
        padding: configParameters.padding,
        curve: configParameters.curve,
      },
      eventAuthority,
      program,
    );
  }
  emitCpi<EvtCreateConfig3>(
    {
      config: config.key,
      quote_mint: quoteMint.key,
      fee_claimer: feeClaimer.key,
      leftover_receiver: leftoverReceiver.key,
      pool_fees: configParameters.pool_fees,
      collect_fee_mode: configParameters.collect_fee_mode,
      migration_option: configParameters.migration_option,
      activation_type: configParameters.activation_type,
      token_type: configParameters.token_type,
      token_decimal: configParameters.token_decimal,
      partner_liquidity_percentage: configParameters.partner_liquidity_percentage,
      partner_permanent_locked_liquidity_percentage: configParameters.partner_permanent_locked_liquidity_percentage,
      creator_liquidity_percentage: configParameters.creator_liquidity_percentage,
      creator_permanent_locked_liquidity_percentage: configParameters.creator_permanent_locked_liquidity_percentage,
      migration_quote_threshold: configParameters.migration_quote_threshold,
      sqrt_start_price: configParameters.sqrt_start_price,
      locked_vesting: configParameters.locked_vesting,
      migration_fee_option: configParameters.migration_fee_option,
      token_supply: configParameters.token_supply,
      creator_trading_fee_percentage: configParameters.creator_trading_fee_percentage,
      token_update_authority: configParameters.token_update_authority,
      migration_fee: configParameters.migration_fee,
      migrated_pool_fee: configParameters.migrated_pool_fee,
      pool_creation_fee: configParameters.pool_creation_fee,
      partner_liquidity_vesting_info: configParameters.partner_liquidity_vesting_info,
      creator_liquidity_vesting_info: configParameters.creator_liquidity_vesting_info,
      migrated_pool_base_fee_mode: configParameters.migrated_pool_base_fee_mode,
      migrated_pool_market_cap_fee_scheduler_params: configParameters.migrated_pool_market_cap_fee_scheduler_params,
      enable_first_swap_with_min_fee: configParameters.enable_first_swap_with_min_fee,
      compounding_fee_bps: configParameters.compounding_fee_bps,
      padding: configParameters.padding,
      curve: configParameters.curve,
      transfer_fee_parameters: transferFeeParameters,
    },
    eventAuthority,
    program,
  );
}

/** create_config_with_transfer_hook: a Token-2022 config whose pools' base mints carry `transfer_hook_program`. */
export function createConfigWithTransferHook(
  config: Init<ConfigWithTransferHook>,
  feeClaimer: AccountInfo,
  leftoverReceiver: AccountInfo,
  quoteMint: Mint,
  transferHookProgram: Executable<AccountInfo>,
  payer: Mut<Signer>,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  configParameters: ConfigParameters,
): void {
  config.create(payer, null);
  require(firstRemainingAccountScore(quoteMint, remainingAccounts()) >= MINT_SCORE_PERMISSIONED_WITHOUT_TRANSFER_FEE, PoolError.InvalidQuoteMint);
  validateConfigParameters(configParameters, nowAsU64(), true, feeClaimer.key);
  require(configParameters.token_type <= 1n, PoolError.InvalidTokenType);
  require(configParameters.token_type === TOKEN_TYPE_TOKEN_2022, PoolError.InvalidTokenType);
  const hook = transferHookProgram.key;
  require(hook !== programId() && hook !== TOKEN_PROGRAM_ID && hook !== TOKEN_2022_PROGRAM_ID, PoolError.InvalidTransferHookProgram);
  processCreateConfig(config.config, configParameters, false, noTransferFee(), quoteMint, feeClaimer.key, leftoverReceiver.key);
  config.transfer_hook_program = hook;
  emitCpi<EvtCreateConfigV2WithTransferHook>(
    {
      config: config.key,
      quote_mint: quoteMint.key,
      fee_claimer: feeClaimer.key,
      leftover_receiver: leftoverReceiver.key,
      pool_fees: configParameters.pool_fees,
      collect_fee_mode: configParameters.collect_fee_mode,
      migration_option: configParameters.migration_option,
      activation_type: configParameters.activation_type,
      token_type: configParameters.token_type,
      token_decimal: configParameters.token_decimal,
      partner_liquidity_percentage: configParameters.partner_liquidity_percentage,
      partner_permanent_locked_liquidity_percentage: configParameters.partner_permanent_locked_liquidity_percentage,
      creator_liquidity_percentage: configParameters.creator_liquidity_percentage,
      creator_permanent_locked_liquidity_percentage: configParameters.creator_permanent_locked_liquidity_percentage,
      migration_quote_threshold: configParameters.migration_quote_threshold,
      sqrt_start_price: configParameters.sqrt_start_price,
      locked_vesting: configParameters.locked_vesting,
      migration_fee_option: configParameters.migration_fee_option,
      token_supply: configParameters.token_supply,
      creator_trading_fee_percentage: configParameters.creator_trading_fee_percentage,
      token_update_authority: configParameters.token_update_authority,
      migration_fee: configParameters.migration_fee,
      migrated_pool_fee: configParameters.migrated_pool_fee,
      pool_creation_fee: configParameters.pool_creation_fee,
      partner_liquidity_vesting_info: configParameters.partner_liquidity_vesting_info,
      creator_liquidity_vesting_info: configParameters.creator_liquidity_vesting_info,
      migrated_pool_base_fee_mode: configParameters.migrated_pool_base_fee_mode,
      migrated_pool_market_cap_fee_scheduler_params: configParameters.migrated_pool_market_cap_fee_scheduler_params,
      enable_first_swap_with_min_fee: configParameters.enable_first_swap_with_min_fee,
      compounding_fee_bps: configParameters.compounding_fee_bps,
      padding: configParameters.padding,
      curve: configParameters.curve,
      transfer_hook_program: hook,
    },
    eventAuthority,
    program,
  );
}

// ---- swaps (instructions/swap/ix_swap.rs) -----------------------------------------------------------------------

/** swap (ExactIn with the legacy parameters) and swap2 share their accounts; the pool must be a VirtualPool. */
export function swap(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  config: AccountInfo,
  pool: Mut<AccountInfo>,
  inputTokenAccount: Mut<TokenAccount>,
  outputTokenAccount: Mut<TokenAccount>,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenBaseProgram">,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  baseMint: Mint,
  quoteMint: Mint,
  payer: Signer,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  referralTokenAccount: Dup<Mut<TokenAccount>> | null,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  params: SwapParameters,
): void {
  require(!checkPoolAccount(pool), PoolError.PoolTypeMismatch);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  const o = processSwap(
    p,
    c,
    pool.key,
    poolAuthority,
    inputTokenAccount,
    outputTokenAccount,
    baseVault,
    quoteVault,
    baseMint,
    quoteMint,
    payer,
    tokenBaseProgram,
    tokenQuoteProgram,
    referralTokenAccount !== null,
    remainingAccounts(),
    noHookAccounts(),
    params.amount_in,
    params.minimum_amount_out,
    0n,
  );
  // the referral's share, from the vault of the token the fee was taken in
  if (referralTokenAccount !== null && o.result.referral_fee > 0n) {
    if (o.fee_on_base_token) {
      requireNoTransferHook(baseMint);
      tokenBaseProgram.transferChecked(baseVault, baseMint, referralTokenAccount, poolAuthority, o.result.referral_fee, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
    } else {
      requireNoTransferHook(quoteMint);
      tokenQuoteProgram.transferChecked(quoteVault, quoteMint, referralTokenAccount, poolAuthority, o.result.referral_fee, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
    }
  }
  finishSwap(p, c, baseVault, o);
  const direction: u8 = o.quote_to_base ? 1n : 0n;
  {
    emitCpi<EvtSwap>(
      {
        pool: pool.key,
        config: config.key,
        trade_direction: direction,
        has_referral: o.has_referral,
        params: { amount_in: o.in_amount_in, minimum_amount_out: o.in_minimum_amount_out },
        swap_result: {
          actual_input_amount: o.result.excluded_fee_input_amount,
          output_amount: o.result.output_amount,
          next_sqrt_price: o.result.next_sqrt_price,
          trading_fee: o.result.trading_fee,
          protocol_fee: o.result.protocol_fee,
          referral_fee: o.result.referral_fee,
        },
        amount_in: o.result.included_fee_input_amount,
        current_timestamp: o.current_timestamp,
      },
      eventAuthority,
      program,
    );
  }
  {
    emitCpi<EvtSwap2>(
      {
        pool: pool.key,
        config: config.key,
        trade_direction: direction,
        has_referral: o.has_referral,
        swap_parameters: { amount_0: params.amount_in, amount_1: params.minimum_amount_out, swap_mode: 0n },
        swap_result: {
          included_fee_input_amount: o.result.included_fee_input_amount,
          excluded_fee_input_amount: o.result.excluded_fee_input_amount,
          amount_left: o.result.amount_left,
          output_amount: o.result.output_amount,
          next_sqrt_price: o.result.next_sqrt_price,
          trading_fee: o.result.trading_fee,
          protocol_fee: o.result.protocol_fee,
          referral_fee: o.result.referral_fee,
        },
        quote_reserve_amount: o.quote_reserve_amount,
        migration_threshold: o.migration_threshold,
        current_timestamp: o.current_timestamp,
      },
      eventAuthority,
      program,
    );
  }
  {
    emitCpi<EvtSwap3>(
      {
        pool: pool.key,
        config: config.key,
        trade_direction: direction,
        swap_mode: 0n,
        has_referral: o.has_referral,
        fee_on_base_token: o.fee_on_base_token,
        included_transfer_fee_amount_in: o.in_amount_in,
        excluded_transfer_fee_amount_in: o.result.included_fee_input_amount,
        included_transfer_fee_amount_out: o.result.output_amount,
        excluded_transfer_fee_amount_out: o.excluded_transfer_fee_amount_out,
        trading_fee: o.result.trading_fee,
        protocol_fee: o.result.protocol_fee,
        referral_fee: o.result.referral_fee,
        next_sqrt_price: o.result.next_sqrt_price,
        quote_reserve: o.quote_reserve_amount,
        current_timestamp: o.current_timestamp,
      },
      eventAuthority,
      program,
    );
  }
  if (o.curve_complete)
    emitCpi<EvtCurveComplete>(
      { pool: pool.key, config: config.key, base_reserve: o.base_reserve, quote_reserve: o.quote_reserve_amount },
      eventAuthority,
      program,
    );
}

/** swap2: ExactIn (0), PartialFill (1) or ExactOut (2); a VirtualPool. */
export function swap2(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  config: AccountInfo,
  pool: Mut<AccountInfo>,
  inputTokenAccount: Mut<TokenAccount>,
  outputTokenAccount: Mut<TokenAccount>,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenBaseProgram">,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  baseMint: Mint,
  quoteMint: Mint,
  payer: Signer,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  referralTokenAccount: Dup<Mut<TokenAccount>> | null,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  params: SwapParameters2,
): void {
  require(!checkPoolAccount(pool), PoolError.PoolTypeMismatch);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  const o = processSwap(
    p,
    c,
    pool.key,
    poolAuthority,
    inputTokenAccount,
    outputTokenAccount,
    baseVault,
    quoteVault,
    baseMint,
    quoteMint,
    payer,
    tokenBaseProgram,
    tokenQuoteProgram,
    referralTokenAccount !== null,
    remainingAccounts(),
    noHookAccounts(),
    params.amount_0,
    params.amount_1,
    u64(params.swap_mode),
  );
  // the referral's share, from the vault of the token the fee was taken in
  if (referralTokenAccount !== null && o.result.referral_fee > 0n) {
    if (o.fee_on_base_token) {
      requireNoTransferHook(baseMint);
      tokenBaseProgram.transferChecked(baseVault, baseMint, referralTokenAccount, poolAuthority, o.result.referral_fee, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
    } else {
      requireNoTransferHook(quoteMint);
      tokenQuoteProgram.transferChecked(quoteVault, quoteMint, referralTokenAccount, poolAuthority, o.result.referral_fee, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
    }
  }
  finishSwap(p, c, baseVault, o);
  const direction: u8 = o.quote_to_base ? 1n : 0n;
  {
    emitCpi<EvtSwap>(
      {
        pool: pool.key,
        config: config.key,
        trade_direction: direction,
        has_referral: o.has_referral,
        params: { amount_in: o.in_amount_in, minimum_amount_out: o.in_minimum_amount_out },
        swap_result: {
          actual_input_amount: o.result.excluded_fee_input_amount,
          output_amount: o.result.output_amount,
          next_sqrt_price: o.result.next_sqrt_price,
          trading_fee: o.result.trading_fee,
          protocol_fee: o.result.protocol_fee,
          referral_fee: o.result.referral_fee,
        },
        amount_in: o.result.included_fee_input_amount,
        current_timestamp: o.current_timestamp,
      },
      eventAuthority,
      program,
    );
  }
  {
    emitCpi<EvtSwap2>(
      {
        pool: pool.key,
        config: config.key,
        trade_direction: direction,
        has_referral: o.has_referral,
        swap_parameters: { amount_0: params.amount_0, amount_1: params.amount_1, swap_mode: params.swap_mode },
        swap_result: {
          included_fee_input_amount: o.result.included_fee_input_amount,
          excluded_fee_input_amount: o.result.excluded_fee_input_amount,
          amount_left: o.result.amount_left,
          output_amount: o.result.output_amount,
          next_sqrt_price: o.result.next_sqrt_price,
          trading_fee: o.result.trading_fee,
          protocol_fee: o.result.protocol_fee,
          referral_fee: o.result.referral_fee,
        },
        quote_reserve_amount: o.quote_reserve_amount,
        migration_threshold: o.migration_threshold,
        current_timestamp: o.current_timestamp,
      },
      eventAuthority,
      program,
    );
  }
  {
    emitCpi<EvtSwap3>(
      {
        pool: pool.key,
        config: config.key,
        trade_direction: direction,
        swap_mode: params.swap_mode,
        has_referral: o.has_referral,
        fee_on_base_token: o.fee_on_base_token,
        included_transfer_fee_amount_in: o.in_amount_in,
        excluded_transfer_fee_amount_in: o.result.included_fee_input_amount,
        included_transfer_fee_amount_out: o.result.output_amount,
        excluded_transfer_fee_amount_out: o.excluded_transfer_fee_amount_out,
        trading_fee: o.result.trading_fee,
        protocol_fee: o.result.protocol_fee,
        referral_fee: o.result.referral_fee,
        next_sqrt_price: o.result.next_sqrt_price,
        quote_reserve: o.quote_reserve_amount,
        current_timestamp: o.current_timestamp,
      },
      eventAuthority,
      program,
    );
  }
  if (o.curve_complete)
    emitCpi<EvtCurveComplete>(
      { pool: pool.key, config: config.key, base_reserve: o.base_reserve, quote_reserve: o.quote_reserve_amount },
      eventAuthority,
      program,
    );
}

// ---- fee claims and the pool creator (instructions/partner, creator, operator) ---------------------------------

/** utils/accounts.rs transfer_lamports_from_pool_account: lamports out of the pool, which must stay rent-exempt. */
function lamportsFromPool(pool: Mut<AccountInfo>, to: Mut<AccountInfo>, lamports: u64): void {
  require(pool.lamports >= lamports, ProgramError.ArithmeticOverflow);
  pool.lamports = pool.lamports - lamports;
  require(to.lamports <= U64_MAX - lamports, ProgramError.ArithmeticOverflow);
  to.lamports = to.lamports + lamports;
  require(pool.lamports >= rentExempt(424n), PoolError.InsufficientPoolLamports);
}

/** PoolConfig::split_pool_creation_fee: the protocol's 10%, rounded down. */
function protocolCreationFee(poolCreationFee: u64): u64 {
  return safeMulDivCastU64(poolCreationFee, 10n, 100n, false);
}

/** claim_trading_fee: the partner's base and quote trading fees, up to the maximums. A VirtualPool only. */
export function claimTradingFee(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  config: AccountInfo,
  pool: Mut<AccountInfo>,
  tokenAAccount: Mut<TokenAccount>,
  tokenBAccount: Mut<TokenAccount>,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenBaseProgram">,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  baseMint: Mint,
  quoteMint: Mint,
  feeClaimer: Signer,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  maxAmountA: u64,
  maxAmountB: u64,
): void {
  // access control: is_partner_fee_claimer
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  require(c.fee_claimer === feeClaimer.key, PoolError.Unauthorized);
  require(c.quote_mint === quoteMint.key, AnchorError.ConstraintHasOne);
  require(!checkPoolAccount(pool), PoolError.PoolTypeMismatch);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.base_mint === baseMint.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  require(remainingAccounts().length === 0n, PoolError.InvalidRemainingAccountsLength);
  const baseAmount = p.partner_base_fee < maxAmountA ? p.partner_base_fee : maxAmountA;
  const quoteAmount = p.partner_quote_fee < maxAmountB ? p.partner_quote_fee : maxAmountB;
  p.partner_base_fee = p.partner_base_fee - baseAmount;
  p.partner_quote_fee = p.partner_quote_fee - quoteAmount;
  if (baseAmount > 0n) {
    requireNoTransferHook(baseMint);
    tokenBaseProgram.transferChecked(baseVault, baseMint, tokenAAccount, poolAuthority, baseAmount, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  }
  if (quoteAmount > 0n) {
    requireNoTransferHook(quoteMint);
    tokenQuoteProgram.transferChecked(quoteVault, quoteMint, tokenBAccount, poolAuthority, quoteAmount, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  }
  emitCpi<EvtClaimTradingFee>({ pool: pool.key, token_base_amount: baseAmount, token_quote_amount: quoteAmount }, eventAuthority, program);
}

/** claim_creator_trading_fee: the creator's share of the trading fees, up to the maximums. A VirtualPool only. */
export function claimCreatorTradingFee(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  pool: Mut<AccountInfo>,
  tokenAAccount: Mut<TokenAccount>,
  tokenBAccount: Mut<TokenAccount>,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenBaseProgram">,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  baseMint: Mint,
  quoteMint: Mint,
  creator: Signer,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  maxBaseAmount: u64,
  maxQuoteAmount: u64,
): void {
  // access control: is_pool_creator
  const hook = checkPoolAccount(pool);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.creator === creator.key, PoolError.Unauthorized);
  require(!hook, PoolError.PoolTypeMismatch);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.base_mint === baseMint.key, AnchorError.ConstraintHasOne);
  require(remainingAccounts().length === 0n, PoolError.InvalidRemainingAccountsLength);
  const baseAmount = p.creator_base_fee < maxBaseAmount ? p.creator_base_fee : maxBaseAmount;
  const quoteAmount = p.creator_quote_fee < maxQuoteAmount ? p.creator_quote_fee : maxQuoteAmount;
  p.creator_base_fee = p.creator_base_fee - baseAmount;
  p.creator_quote_fee = p.creator_quote_fee - quoteAmount;
  if (baseAmount > 0n) {
    requireNoTransferHook(baseMint);
    tokenBaseProgram.transferChecked(baseVault, baseMint, tokenAAccount, poolAuthority, baseAmount, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  }
  if (quoteAmount > 0n) {
    requireNoTransferHook(quoteMint);
    tokenQuoteProgram.transferChecked(quoteVault, quoteMint, tokenBAccount, poolAuthority, quoteAmount, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  }
  emitCpi<EvtClaimCreatorTradingFee>({ pool: pool.key, token_base_amount: baseAmount, token_quote_amount: quoteAmount }, eventAuthority, program);
}

/** claim_partner_pool_creation_fee: the partner's 90% of the pool creation fee, in lamports, once. */
export function claimPartnerPoolCreationFee(
  config: AccountInfo,
  pool: Mut<AccountInfo>,
  feeClaimer: Signer,
  feeReceiver: Mut<AccountInfo>,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  require(c.fee_claimer === feeClaimer.key, PoolError.Unauthorized);
  const partnerFee = c.pool_creation_fee - protocolCreationFee(c.pool_creation_fee);
  require(partnerFee > 0n, PoolError.ZeroPoolCreationFee);
  checkPoolAccount(pool);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  // PARTNER_CREATION_FEE_CLAIMED_MASK = 0b10
  require((p.creation_fee_bits & 2n) === 0n, PoolError.PoolCreationFeeHasBeenClaimed);
  p.creation_fee_bits = p.creation_fee_bits ^ 2n;
  lamportsFromPool(pool, feeReceiver, partnerFee);
  emitCpi<EvtPartnerClaimPoolCreationFee>(
    { pool: pool.key, partner: feeClaimer.key, creation_fee: partnerFee, fee_receiver: feeReceiver.key },
    eventAuthority,
    program,
  );
}

/** claim_protocol_pool_creation_fee: the protocol's 10% (and a legacy Token-2022 fee) to the treasury. Operators with ClaimProtocolFee. */
export function claimProtocolPoolCreationFee(
  config: AccountInfo,
  pool: Mut<AccountInfo>,
  operator: Account<Operator>,
  signer: Signer,
  treasury: Address<Mut<AccountInfo>, "6aYhxiNGmG8AyU25rh2R7iFu4pBrqnQHpNUGhmsEXRcm">,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  isValidOperatorRole(operator, signer.key, OPERATOR_CLAIM_PROTOCOL_FEE);
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  checkPoolAccount(pool);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  let protocolFee: u64 = 0n;
  // PROTOCOL_CREATION_FEE_CLAIMED_MASK = 0b01
  if ((p.creation_fee_bits & 1n) === 0n) {
    p.creation_fee_bits = p.creation_fee_bits ^ 1n;
    protocolFee = protocolCreationFee(c.pool_creation_fee);
  }
  // the legacy creation fee: charged (0b01) and not yet claimed (0b10)
  if ((p.legacy_creation_fee_bits & 1n) !== 0n && (p.legacy_creation_fee_bits & 2n) === 0n) {
    p.legacy_creation_fee_bits = p.legacy_creation_fee_bits ^ 2n;
    protocolFee = addU64(protocolFee, 10_000_000n);
  }
  if (protocolFee > 0n) lamportsFromPool(pool, treasury, protocolFee);
  emitCpi<EvtClaimPoolCreationFee>({ pool: pool.key, receiver: treasury.key, creation_fee: protocolFee }, eventAuthority, program);
}

/** transfer_pool_creator: hand the pool's creator role to another key, before the curve completes or after migration. */
export function transferPoolCreator(
  virtualPool: Mut<AccountInfo>,
  config: AccountInfo,
  creator: Signer,
  newCreator: AccountInfo,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  constraint(newCreator, newCreator.key !== creator.key, PoolError.InvalidNewCreator);
  // access control: is_pool_creator
  checkPoolAccount(virtualPool);
  const p = loadRawMutAt<PoolState>(virtualPool, 8n);
  require(p.creator === creator.key, PoolError.Unauthorized);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  require(p.migration_progress <= MIGRATION_PROGRESS_CREATED_POOL, PoolError.TypeCastFailed);
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  if (p.migration_progress === MIGRATION_PROGRESS_CREATED_POOL) {
    require(c.migration_option <= 1n, PoolError.InvalidMigrationOption);
    if (c.migration_option === 0n) checkDammV1Claimed(virtualPool.key, remainingAccounts());
  } else {
    require(p.migration_progress === 0n, PoolError.NotPermitToDoThisAction);
  }
  p.creator = newCreator.key;
  emitCpi<EvtUpdatePoolCreator>({ pool: virtualPool.key, creator: creator.key, new_creator: newCreator.key }, eventAuthority, program);
}

/** A DAMM v1 migration's LP tokens, claimed and locked, before the creator role moves (its metadata: remaining account 0). */
function checkDammV1Claimed(pool: Pubkey, rest: RemainingAccounts): void {
  require(rest.length > 0n, PoolError.InvalidAccount);
  const m = loadAccount<MeteoraDammMigrationMetadata>(rest.get(0n));
  require(m.virtual_pool === pool, PoolError.InvalidAccount);
  require(m.partner_locked_liquidity === 0n || m.partner_locked_status === 1n, PoolError.NotPermitToDoThisAction);
  require(m.creator_locked_liquidity === 0n || m.creator_locked_status === 1n, PoolError.NotPermitToDoThisAction);
  require(m.creator_liquidity === 0n || m.creator_claim_status === 1n, PoolError.NotPermitToDoThisAction);
  require(m.partner_liquidity === 0n || m.partner_claim_status === 1n, PoolError.NotPermitToDoThisAction);
}

/** create_virtual_pool_metadata: a pool's name, website and logo (PDA ["virtual_pool_metadata", pool]). Its creator only. */
export function createVirtualPoolMetadata(
  virtualPool: AccountInfo,
  virtualPoolMetadata: Init<VirtualPoolMetadata>,
  creator: Signer,
  payer: Mut<Signer>,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  metadata: CreateVirtualPoolMetadataParameters,
): void {
  virtualPoolMetadata.create(
    payer,
    ["virtual_pool_metadata", virtualPool.key],
    8n + 32n + 96n + 4n + byteLength(metadata.name) + 4n + byteLength(metadata.website) + 4n + byteLength(metadata.logo),
  );
  // access control: is_pool_creator
  checkPoolAccount(virtualPool);
  const p = loadRawAt<PoolState>(virtualPool, 8n);
  require(p.creator === creator.key, PoolError.Unauthorized);
  virtualPoolMetadata.virtual_pool = virtualPool.key;
  const data = instructionData();
  const nameAt = 8n + 96n;
  const websiteAt = nameAt + 4n + byteLength(metadata.name);
  const logoAt = websiteAt + 4n + byteLength(metadata.website);
  for (const b of data.slice(nameAt + 4n, websiteAt)) virtualPoolMetadata.name.push(b);
  for (const b of data.slice(websiteAt + 4n, logoAt)) virtualPoolMetadata.website.push(b);
  for (const b of data.slice(logoAt + 4n, logoAt + 4n + byteLength(metadata.logo))) virtualPoolMetadata.logo.push(b);
  emitCpi<EvtVirtualPoolMetadata>({ virtual_pool_metadata: virtualPoolMetadata.key, virtual_pool: virtualPool.key }, eventAuthority, program);
}

/**
 * claim_protocol_fee2: the protocol's trading and migration fees (and its 20% of the surplus, in quote) to a receiver,
 * signed by the protocol fee program's authority PDA (so only by CPI from that program). Either pool type.
 */
export function claimProtocolFee2(
  receiverTokenAccount: Mut<TokenAccount>,
  baseMint: Mint,
  quoteMint: Mint,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  config: AccountInfo,
  pool: Mut<AccountInfo>,
  baseVault: Mut<TokenAccount>,
  quoteVault: Mut<TokenAccount>,
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  signer: Address<Signer, "FkU5rQCWQM131skHCpcEbK8P1JrQGsBgqXe55w525SSF">,
  maxAmount: u64,
): void {
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  require(c.quote_mint === quoteMint.key, AnchorError.ConstraintHasOne);
  const hook = checkPoolAccount(pool);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.base_mint === baseMint.key, AnchorError.ConstraintHasOne);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  // get_claim_direction_and_validate_accounts
  const claimingBase = receiverTokenAccount.mint === p.base_mint;
  require(claimingBase || receiverTokenAccount.mint === c.quote_mint, PoolError.InvalidClaimProtocolFeeAccounts);
  require(receiverTokenAccount.tokenProgram === (claimingBase ? tokenBaseProgram.key : tokenQuoteProgram.key), PoolError.InvalidClaimProtocolFeeAccounts);
  let amount: u64 = 0n;
  if (claimingBase) {
    if (hook) require(p.quote_reserve >= c.migration_quote_threshold, PoolError.PoolIsIncompleted);
    // claim_protocol_base_fee: the trading fee first, then the migration fee, up to max_amount
    const trading = p.protocol_base_fee < maxAmount ? p.protocol_base_fee : maxAmount;
    p.protocol_base_fee = p.protocol_base_fee - trading;
    const rest = maxAmount - trading;
    const migration = p.protocol_migration_base_fee_amount < rest ? p.protocol_migration_base_fee_amount : rest;
    p.protocol_migration_base_fee_amount = p.protocol_migration_base_fee_amount - migration;
    amount = addU64(trading, migration);
  } else {
    const trading = p.protocol_quote_fee < maxAmount ? p.protocol_quote_fee : maxAmount;
    p.protocol_quote_fee = p.protocol_quote_fee - trading;
    const rest = maxAmount - trading;
    const migration = p.protocol_migration_quote_fee_amount < rest ? p.protocol_migration_quote_fee_amount : rest;
    p.protocol_migration_quote_fee_amount = p.protocol_migration_quote_fee_amount - migration;
    amount = addU64(trading, migration);
    // claim_protocol_quote_fee_and_surplus: the protocol's share of the surplus, once the curve is complete
    if (p.is_protocol_withdraw_surplus === 0n && p.quote_reserve >= c.migration_quote_threshold) {
      p.is_protocol_withdraw_surplus = 1n;
      const total = subU64(p.quote_reserve, c.migration_quote_threshold);
      const partnerAndCreator = safeMulDivCastU64(total, 80n, 100n, false);
      amount = addU64(amount, subU64(total, partnerAndCreator));
    }
  }
  if (amount === 0n) return;
  if (claimingBase) {
    tokenBaseProgram.transferChecked(baseVault, baseMint, receiverTokenAccount, poolAuthority, amount, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
    emit<EvtClaimProtocolFee2>({ pool: pool.key, receiver_token_account: receiverTokenAccount.key, token_mint: baseMint.key, amount });
  } else {
    tokenQuoteProgram.transferChecked(quoteVault, quoteMint, receiverTokenAccount, poolAuthority, amount, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
    emit<EvtClaimProtocolFee2>({ pool: pool.key, receiver_token_account: receiverTokenAccount.key, token_mint: quoteMint.key, amount });
  }
}

// ---- pool creation (instructions/initialize_pool/) --------------------------------------------------------------

/**
 * initialize_virtual_pool_with_spl_token: a pool of `config` with a new SPL base mint (a keypair that signs) whose
 * supply is minted to the pool's base vault, with Metaplex metadata, the mint authority then revoked. Pool and vaults
 * are PDAs (["pool", config, larger mint, smaller mint], ["token_vault", mint, pool]).
 */
export function initializeVirtualPoolWithSplToken(
  config: Account<PoolConfigAccount>,
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  creator: Signer,
  baseMint: Init<Mint>,
  quoteMint: MintOf<Mint, never, never, "tokenQuoteProgram">,
  pool: Init<VirtualPool>,
  baseVault: Init<TokenAccount>,
  quoteVault: Mut<AccountInfo>,
  mintMetadata: Mut<AccountInfo>,
  metadataProgram: Address<UncheckedProgram, "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s">,
  payer: Mut<Signer>,
  tokenQuoteProgram: TokenInterface,
  tokenProgram: TokenProgram,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  params: InitializePoolParameters,
): void {
  // has_one = quote_mint, among the constraints (after the creates below, as Anchor runs init first)
  constraint(config, config.config.quote_mint === quoteMint.key, AnchorError.ConstraintHasOne);
  baseMint.create(payer, null, config.config.token_decimal, poolAuthority.key, null, tokenProgram);
  pool.create(payer, [
    "pool",
    config.key,
    baseMint.key.compare(quoteMint.key) > 0n ? baseMint.key : quoteMint.key,
    baseMint.key.compare(quoteMint.key) > 0n ? quoteMint.key : baseMint.key,
  ]);
  baseVault.create(payer, ["token_vault", baseMint.key, pool.key], baseMint, poolAuthority.key, tokenProgram);
  // the quote vault as Anchor's init makes it: sized from the mint, then InitializeAccount3
  systemProgram.createPda(payer, quoteVault, tokenAccountSpace(quoteMint), tokenQuoteProgram.key, ["token_vault", quoteMint.key, pool.key]);
  tokenQuoteProgram.initializeAccount3(quoteVault, quoteMint, poolAuthority.key);
  const c = config.config;
  // the quote mint: a legacy config (version 0) takes only quote mints without a transfer fee
  const score = firstRemainingAccountScore(quoteMint, remainingAccounts());
  if (c.version === 0n) require(score >= MINT_SCORE_PERMISSIONED_WITHOUT_TRANSFER_FEE, PoolError.InvalidQuoteMint);
  else require(score >= MINT_SCORE_PERMISSIONED_WITH_TRANSFER_FEE, PoolError.InvalidQuoteMint);
  require(totalLiquidityLockedBpsAtNSeconds(c, 86400n) >= 1000n, PoolError.InvalidMigrationLockedLiquidity);
  require(c.pool_fees.base_fee.base_fee_mode <= 2n, PoolError.InvalidBaseFeeMode);
  require(c.pool_fees.base_fee.base_fee_mode !== 2n, PoolError.DeprecatedBaseFeeMode);
  require(c.migration_option <= 1n, PoolError.InvalidMigrationOption);
  require(c.migration_option !== 0n, PoolError.DeprecatedMigrationOption);
  validateMinBaseFee(c.pool_fees.base_fee);
  const supply = initialBaseSupply(c);
  require(c.token_type <= 1n, PoolError.InvalidTokenType);
  require(c.token_type === 0n, PoolError.InvalidTokenType);
  require(c.token_update_authority <= 4n, PoolError.InvalidTokenAuthorityOption);
  require(c.token_update_authority !== 3n && c.token_update_authority !== 4n, PoolError.InvalidTokenAuthorityOption);

  // Metaplex metadata (process_create_token_metadata), the pool authority's lamports, owner and size unchanged by it
  const lamportsBefore = poolAuthority.lamports;
  const ownerBefore = poolAuthority.owner;
  const sizeBefore = poolAuthority.dataLen;
  const mutable = c.token_update_authority !== 1n;
  // CreateMetadataAccountV3 as mpl-token-metadata's CPI builder sends it (the optional rent account left out; the pool
  // authority as mint authority, signing, and as update authority)
  invoke(
    metadataProgram,
    [writable(mintMetadata), readonly(baseMint), readonlySigner(poolAuthority), writableSigner(payer), readonly(poolAuthority), readonly(systemProgram)],
    [u8(33n), params.name, params.symbol, params.uri, u16(0n), u8(0n), u8(0n), u8(0n), mutable, u8(0n)],
    ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
  );
  // UpdateMetadataAccountV2: the update authority to the creator, the partner, or nobody (the System Program's id)
  const updateAuthority =
    c.token_update_authority === 0n ? creator.key : c.token_update_authority === 2n ? c.fee_claimer : pubkey("11111111111111111111111111111111");
  invoke(metadataProgram, [writable(mintMetadata), readonlySigner(poolAuthority)], [u8(15n), u8(0n), u8(1n), updateAuthority, u8(0n), u8(0n)], [
    "pool_authority",
    u8(POOL_AUTHORITY_BUMP),
  ]);
  require(poolAuthority.lamports >= lamportsBefore, PoolError.AccountInvariantViolation);
  require(poolAuthority.owner === ownerBefore, PoolError.AccountInvariantViolation);
  require(poolAuthority.dataLen === sizeBefore, PoolError.AccountInvariantViolation);

  tokenProgram.mintTo(baseMint, baseVault, poolAuthority, supply, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  tokenProgram.setAuthority(baseMint, poolAuthority, AuthorityType.MintTokens, null, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  if (c.pool_creation_fee > 0n) systemProgram.transfer(payer, pool, c.pool_creation_fee);

  require(c.activation_type <= 1n, PoolError.InvalidActivationType);
  const activationPoint = c.activation_type === 0n ? currentSlot() : nowAsU64();
  pool.pool_state.config = config.key;
  pool.pool_state.creator = creator.key;
  pool.pool_state.base_mint = baseMint.key;
  pool.pool_state.base_vault = baseVault.key;
  pool.pool_state.quote_vault = quoteVault.key;
  pool.pool_state.sqrt_price = c.sqrt_start_price;
  pool.pool_state.pool_type = 0n;
  pool.pool_state.activation_point = activationPoint;
  pool.pool_state.base_reserve = supply;
  pool.pool_state.protocol_liquidity_migration_fee_bps = 20n;
  emitCpi<EvtInitializePool>(
    { pool: pool.key, config: config.key, creator: creator.key, base_mint: baseMint.key, pool_type: 0n, activation_point: activationPoint },
    eventAuthority,
    program,
  );
}

/**
 * utils/accounts.rs create_account (Anchor 1.0's `init` written out) for a keypair account: CreateAccount for a new
 * address, or for one someone funded first a top-up to the rent (at least 1 lamport), Allocate and Assign.
 */
function createKeypairAccountAsAnchor(account: Mut<Signer>, space: u64, owner: Pubkey, payer: Mut<Signer>, systemProgram: SystemProgram): void {
  if (account.lamports === 0n) {
    systemProgram.createAccount(payer, account, rentExempt(space), space, owner);
    return;
  }
  require(payer.key !== account.key, AnchorError.TryingToInitPayerAsProgramAccount);
  const rent = rentExempt(space) > 1n ? rentExempt(space) : 1n;
  if (rent > account.lamports) systemProgram.transfer(payer, account, rent - account.lamports);
  systemProgram.allocate(account, space);
  systemProgram.assign(account, owner);
}

/** create_account for a PDA of this program, signed by `seeds`. */
function createPdaAccountAsAnchor(account: Mut<AccountInfo>, space: u64, owner: Pubkey, payer: Mut<Signer>, systemProgram: SystemProgram, seeds: SignerSeeds): void {
  if (account.lamports === 0n) {
    systemProgram.createAccount(payer, account, rentExempt(space), space, owner, seeds);
    return;
  }
  require(payer.key !== account.key, AnchorError.TryingToInitPayerAsProgramAccount);
  const rent = rentExempt(space) > 1n ? rentExempt(space) : 1n;
  if (rent > account.lamports) systemProgram.transfer(payer, account, rent - account.lamports);
  systemProgram.allocate(account, space, seeds);
  systemProgram.assign(account, owner, seeds);
}

/** BaseMintTransferFee::from_config: whether the base mint gets a transfer fee (the config's transfer fee flag). */
function hasBaseTransferFee(c: PoolConfig): boolean {
  return c.transfer_fee_flag === 1n;
}

/**
 * create_token_2022_base_mint and create_token_2022_base_vault: the base mint (MetadataPointer to itself, the config's
 * transfer fee, the hook program) with the pool authority as its mint authority, then the base vault at
 * ["token_vault", base mint, pool] owned by the pool authority. BaseMintTransferFee::from_config's checks come first.
 */
function createToken2022BaseMintAndVault(
  c: PoolConfig,
  creator: Pubkey,
  poolKey: Pubkey,
  poolAuthority: AccountInfo,
  baseMint: Mut<Signer>,
  baseVault: Mut<AccountInfo>,
  payer: Mut<Signer>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  hookProgram: Pubkey,
  withHook: boolean,
): void {
  const fee = hasBaseTransferFee(c);
  if (fee) {
    require(c.migrated_transfer_fee_authority_option <= 3n, PoolError.InvalidTransferFeeParameters);
    require(c.transfer_fee_withheld_authority <= 1n, PoolError.InvalidTransferFeeParameters);
  }
  createKeypairAccountAsAnchor(baseMint, token2022BaseMintSpace(fee, withHook), TOKEN_2022_PROGRAM_ID, payer, systemProgram);
  tokenProgram.initializeMetadataPointer(baseMint, poolAuthority.key, baseMint.key);
  if (fee) {
    const withheld = c.transfer_fee_withheld_authority === 0n ? c.fee_claimer : creator;
    // MigratedTransferFeeAuthorityOption::Immutable: no config authority
    if (c.migrated_transfer_fee_authority_option === 0n) tokenProgram.initializeTransferFeeConfig(baseMint, null, withheld, c.transfer_fee_basis_points, U64_MAX);
    else tokenProgram.initializeTransferFeeConfig(baseMint, poolAuthority.key, withheld, c.transfer_fee_basis_points, U64_MAX);
  }
  if (withHook) tokenProgram.initializeTransferHook(baseMint, poolAuthority.key, hookProgram);
  tokenProgram.initializeMint2(baseMint, c.token_decimal, poolAuthority.key, null);
  const vaultBump = findProgramAddressBump(["token_vault", baseMint.key, poolKey], programId());
  createPdaAccountAsAnchor(baseVault, token2022BaseVaultSpace(fee, withHook), TOKEN_2022_PROGRAM_ID, payer, systemProgram, signer(["token_vault", baseMint.key, poolKey, u8(vaultBump)]));
  tokenProgram.initializeAccount3(baseVault, baseMint, poolAuthority.key);
}

/**
 * process_initialize_virtual_pool_with_token2022: the config's checks, the mint's metadata (in the mint, Token
 * Metadata interface) and its rent, the metadata pointer and metadata update authorities, the supply minted to the base
 * vault, the mint authority (kept only by a transfer hook config). The creation fee and the activation point follow
 * in the instruction.
 */
function processInitializeWithToken2022(
  c: PoolConfig,
  isHookConfig: boolean,
  poolAuthority: AccountInfo,
  creator: Signer,
  baseMint: Mut<Signer>,
  baseVault: Mut<AccountInfo>,
  payer: Mut<Signer>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  params: InitializePoolParameters,
): void {
  require(totalLiquidityLockedBpsAtNSeconds(c, 86400n) >= 1000n, PoolError.InvalidMigrationLockedLiquidity);
  require(c.pool_fees.base_fee.base_fee_mode <= 2n, PoolError.InvalidBaseFeeMode);
  require(c.pool_fees.base_fee.base_fee_mode !== 2n, PoolError.DeprecatedBaseFeeMode);
  validateMinBaseFee(c.pool_fees.base_fee);
  require(c.token_type <= 1n, PoolError.InvalidTokenType);
  require(c.token_type === TOKEN_TYPE_TOKEN_2022, PoolError.InvalidTokenType);
  tokenProgram.initializeMetadata(baseMint, creator, poolAuthority, params.name, params.symbol, params.uri, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  // update_account_lamports_to_minimum_balance: the metadata grew the mint
  const minimum = rentExempt(baseMint.dataLen);
  if (minimum > baseMint.lamports) systemProgram.transfer(payer, baseMint, minimum - baseMint.lamports);
  require(c.token_update_authority <= 4n, PoolError.InvalidTokenAuthorityOption);
  // get_update_authority: the creator (0, 3), the partner (2, 4), nobody (1)
  const creatorUpdates = c.token_update_authority === 0n || c.token_update_authority === 3n;
  const partnerUpdates = c.token_update_authority === 2n || c.token_update_authority === 4n;
  // AuthorityType::MetadataPointer (12)
  if (creatorUpdates) tokenProgram.setAuthority(baseMint, poolAuthority, 12n, creator.key, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  else if (partnerUpdates) tokenProgram.setAuthority(baseMint, poolAuthority, 12n, c.fee_claimer, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  else tokenProgram.setAuthority(baseMint, poolAuthority, 12n, null, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  if (creatorUpdates) tokenProgram.updateMetadataAuthority(baseMint, creator, creator.key);
  else if (partnerUpdates) tokenProgram.updateMetadataAuthority(baseMint, creator, c.fee_claimer);
  else tokenProgram.updateMetadataAuthority(baseMint, creator, null);
  const supply = initialBaseSupply(c);
  tokenProgram.mintTo(baseMint, baseVault, poolAuthority, supply, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  // get_mint_authority: the creator (3), the partner (4), nobody otherwise; only a transfer hook config may keep one
  if (!isHookConfig) require(c.token_update_authority !== 3n && c.token_update_authority !== 4n, PoolError.InvalidTokenAuthorityOption);
  if (c.token_update_authority === 3n) tokenProgram.setAuthority(baseMint, poolAuthority, AuthorityType.MintTokens, creator.key, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  else if (c.token_update_authority === 4n)
    tokenProgram.setAuthority(baseMint, poolAuthority, AuthorityType.MintTokens, c.fee_claimer, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  else tokenProgram.setAuthority(baseMint, poolAuthority, AuthorityType.MintTokens, null, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
}

/** The quote mint's score for a pool: a legacy config (version 0) takes only quote mints without a transfer fee. */
function requirePoolQuoteMint(c: PoolConfig, quoteMint: Mint, rest: RemainingAccounts, legacyRule: boolean): void {
  const score = firstRemainingAccountScore(quoteMint, rest);
  if (!legacyRule || c.version === 0n) require(score >= MINT_SCORE_PERMISSIONED_WITHOUT_TRANSFER_FEE, PoolError.InvalidQuoteMint);
  else require(score >= MINT_SCORE_PERMISSIONED_WITH_TRANSFER_FEE, PoolError.InvalidQuoteMint);
}

/**
 * initialize_virtual_pool_with_token2022: a pool of `config` with a new Token-2022 base mint (a keypair that signs)
 * carrying its metadata in itself, the config's transfer fee, the supply minted to the base vault and the mint
 * authority revoked. A VirtualPool.
 */
export function initializeVirtualPoolWithToken2022(
  config: Account<PoolConfigAccount>,
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  creator: Signer,
  // Dup: Anchor 1.0.2 compares only typed accounts for duplicates, so the payer as the base mint reaches init (4101)
  baseMint: Dup<Mut<Signer>>,
  quoteMint: MintOf<Mint, never, never, "tokenQuoteProgram">,
  pool: Init<VirtualPool>,
  baseVault: Mut<AccountInfo>,
  quoteVault: Mut<AccountInfo>,
  payer: Mut<Signer>,
  tokenQuoteProgram: TokenInterface,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  params: InitializePoolParameters,
): void {
  constraint(config, config.config.quote_mint === quoteMint.key, AnchorError.ConstraintHasOne);
  constraint(baseVault, baseVault.key === findProgramAddress(["token_vault", baseMint.key, pool.key], programId()), AnchorError.ConstraintSeeds);
  pool.create(payer, [
    "pool",
    config.key,
    baseMint.key.compare(quoteMint.key) > 0n ? baseMint.key : quoteMint.key,
    baseMint.key.compare(quoteMint.key) > 0n ? quoteMint.key : baseMint.key,
  ]);
  systemProgram.createPda(payer, quoteVault, tokenAccountSpace(quoteMint), tokenQuoteProgram.key, ["token_vault", quoteMint.key, pool.key]);
  tokenQuoteProgram.initializeAccount3(quoteVault, quoteMint, poolAuthority.key);
  const c = config.config;
  requirePoolQuoteMint(c, quoteMint, remainingAccounts(), true);
  createToken2022BaseMintAndVault(c, creator.key, pool.key, poolAuthority, baseMint, baseVault, payer, tokenProgram, systemProgram, DEFAULT_PUBKEY, false);
  processInitializeWithToken2022(c, false, poolAuthority, creator, baseMint, baseVault, payer, tokenProgram, systemProgram, params);
  if (c.pool_creation_fee > 0n) systemProgram.transfer(payer, pool, c.pool_creation_fee);
  require(c.activation_type <= 1n, PoolError.InvalidActivationType);
  const activationPoint = c.activation_type === 0n ? currentSlot() : nowAsU64();
  const supply = initialBaseSupply(c);
  pool.pool_state.config = config.key;
  pool.pool_state.creator = creator.key;
  pool.pool_state.base_mint = baseMint.key;
  pool.pool_state.base_vault = baseVault.key;
  pool.pool_state.quote_vault = quoteVault.key;
  pool.pool_state.sqrt_price = c.sqrt_start_price;
  pool.pool_state.pool_type = 1n;
  pool.pool_state.activation_point = activationPoint;
  pool.pool_state.base_reserve = supply;
  pool.pool_state.protocol_liquidity_migration_fee_bps = 20n;
  emitCpi<EvtInitializePool>(
    { pool: pool.key, config: config.key, creator: creator.key, base_mint: baseMint.key, pool_type: 1n, activation_point: activationPoint },
    eventAuthority,
    program,
  );
}

/**
 * initialize_virtual_pool_with_token2022_transfer_hook: as initialize_virtual_pool_with_token2022 for a
 * ConfigWithTransferHook, the base mint also carrying the config's transfer hook program (its authority the pool
 * authority, revoked when the curve completes); the config's creator or partner mint authority options are kept. A
 * TransferHookPool.
 */
export function initializeVirtualPoolWithToken2022TransferHook(
  config: Account<ConfigWithTransferHook>,
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  creator: Signer,
  // Dup: Anchor 1.0.2 compares only typed accounts for duplicates, so the payer as the base mint reaches init (4101)
  baseMint: Dup<Mut<Signer>>,
  quoteMint: MintOf<Mint, never, never, "tokenQuoteProgram">,
  pool: Init<TransferHookPool>,
  baseVault: Mut<AccountInfo>,
  quoteVault: Mut<AccountInfo>,
  transferHookProgram: AccountInfo,
  payer: Mut<Signer>,
  tokenQuoteProgram: TokenInterface,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  params: InitializePoolParameters,
): void {
  constraint(config, config.config.quote_mint === quoteMint.key, AnchorError.ConstraintHasOne);
  constraint(baseVault, baseVault.key === findProgramAddress(["token_vault", baseMint.key, pool.key], programId()), AnchorError.ConstraintSeeds);
  // #[account(executable, address = config.transfer_hook_program)], in that order
  constraint(transferHookProgram, transferHookProgram.executable, AnchorError.ConstraintExecutable);
  constraint(transferHookProgram, transferHookProgram.key === config.transfer_hook_program, AnchorError.ConstraintAddress);
  pool.create(payer, [
    "pool",
    config.key,
    baseMint.key.compare(quoteMint.key) > 0n ? baseMint.key : quoteMint.key,
    baseMint.key.compare(quoteMint.key) > 0n ? quoteMint.key : baseMint.key,
  ]);
  systemProgram.createPda(payer, quoteVault, tokenAccountSpace(quoteMint), tokenQuoteProgram.key, ["token_vault", quoteMint.key, pool.key]);
  tokenQuoteProgram.initializeAccount3(quoteVault, quoteMint, poolAuthority.key);
  const c = config.config;
  requirePoolQuoteMint(c, quoteMint, remainingAccounts(), false);
  createToken2022BaseMintAndVault(c, creator.key, pool.key, poolAuthority, baseMint, baseVault, payer, tokenProgram, systemProgram, config.transfer_hook_program, true);
  processInitializeWithToken2022(c, true, poolAuthority, creator, baseMint, baseVault, payer, tokenProgram, systemProgram, params);
  if (c.pool_creation_fee > 0n) systemProgram.transfer(payer, pool, c.pool_creation_fee);
  require(c.activation_type <= 1n, PoolError.InvalidActivationType);
  const activationPoint = c.activation_type === 0n ? currentSlot() : nowAsU64();
  const supply = initialBaseSupply(c);
  pool.pool_state.config = config.key;
  pool.pool_state.creator = creator.key;
  pool.pool_state.base_mint = baseMint.key;
  pool.pool_state.base_vault = baseVault.key;
  pool.pool_state.quote_vault = quoteVault.key;
  pool.pool_state.sqrt_price = c.sqrt_start_price;
  pool.pool_state.pool_type = 1n;
  pool.pool_state.activation_point = activationPoint;
  pool.pool_state.base_reserve = supply;
  pool.pool_state.protocol_liquidity_migration_fee_bps = 20n;
  emitCpi<EvtInitializePoolWithTransferHook>(
    { pool: pool.key, config: config.key, creator: creator.key, base_mint: baseMint.key, pool_type: 1n, activation_point: activationPoint },
    eventAuthority,
    program,
  );
}

// ---- the transfer-hook instructions (ix_swap2_with_transfer_hook.rs, the claims' TransferHookAccountsInfo) -------

/**
 * swap2_with_transfer_hook: swap2 on a TransferHookPool, the base mint's transfers carrying the hook's extra accounts
 * (the TransferHookBase slice of the remaining accounts, after the instructions sysvar if any; the referral's base
 * transfer the TransferHookBaseReferral slice). The swap that completes the curve revokes the hook program and its
 * authority.
 */
export function swap2WithTransferHook(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  config: AccountInfo,
  pool: Mut<AccountInfo>,
  inputTokenAccount: Mut<TokenAccount>,
  outputTokenAccount: Mut<TokenAccount>,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenBaseProgram">,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  baseMint: Mut<Mint>,
  quoteMint: Mint,
  payer: Signer,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  referralTokenAccount: Dup<Mut<TokenAccount>> | null,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  params: SwapParameters2,
  transferHookAccountsInfo: TransferHookAccountsInfo,
): void {
  require(checkPoolAccount(pool), PoolError.PoolTypeMismatch);
  const rest = remainingAccounts();
  const h = noHookAccounts();
  for (const s of transferHookAccountsInfo.slices) h.total = h.total + u64(s.length_);
  h.end = rest.length >= h.total ? rest.length - h.total : 0n;
  for (const s of transferHookAccountsInfo.slices) parseHookSlice(h, s.accounts_type === AccountsType.TransferHookBaseReferral, u64(s.length_), true, rest.length);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  const o = processSwap(
    p,
    c,
    pool.key,
    poolAuthority,
    inputTokenAccount,
    outputTokenAccount,
    baseVault,
    quoteVault,
    baseMint,
    quoteMint,
    payer,
    tokenBaseProgram,
    tokenQuoteProgram,
    referralTokenAccount !== null,
    rest,
    h,
    params.amount_0,
    params.amount_1,
    u64(params.swap_mode),
  );
  // the referral's share, from the vault of the token the fee was taken in
  if (referralTokenAccount !== null && o.result.referral_fee > 0n) {
    if (o.fee_on_base_token)
      transferFromPoolAuthority(tokenBaseProgram, baseVault, baseMint, referralTokenAccount, poolAuthority, o.result.referral_fee, rest, h.has_referral, h.referral_from, h.referral_to);
    else transferFromPoolAuthority(tokenQuoteProgram, quoteVault, quoteMint, referralTokenAccount, poolAuthority, o.result.referral_fee, rest, false, 0n, 0n);
  }
  finishSwap(p, c, baseVault, o);
  // revoke_transfer_hook: the hook program, then its authority (AuthorityType::TransferHookProgramId, 10)
  if (o.curve_complete) {
    tokenBaseProgram.updateTransferHook(baseMint, poolAuthority, null, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
    tokenBaseProgram.setAuthority(baseMint, poolAuthority, 10n, null, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  }
  const direction: u8 = o.quote_to_base ? 1n : 0n;
  {
    emitCpi<EvtSwap2WithTransferHook>(
      {
        pool: pool.key,
        config: config.key,
        trade_direction: direction,
        has_referral: o.has_referral,
        swap_parameters: { amount_0: params.amount_0, amount_1: params.amount_1, swap_mode: params.swap_mode },
        swap_result: {
          included_fee_input_amount: o.result.included_fee_input_amount,
          excluded_fee_input_amount: o.result.excluded_fee_input_amount,
          amount_left: o.result.amount_left,
          output_amount: o.result.output_amount,
          next_sqrt_price: o.result.next_sqrt_price,
          trading_fee: o.result.trading_fee,
          protocol_fee: o.result.protocol_fee,
          referral_fee: o.result.referral_fee,
        },
        quote_reserve_amount: o.quote_reserve_amount,
        migration_threshold: o.migration_threshold,
        current_timestamp: o.current_timestamp,
      },
      eventAuthority,
      program,
    );
  }
  {
    emitCpi<EvtSwap3WithTransferHook>(
      {
        pool: pool.key,
        config: config.key,
        trade_direction: direction,
        swap_mode: params.swap_mode,
        has_referral: o.has_referral,
        fee_on_base_token: o.fee_on_base_token,
        included_transfer_fee_amount_in: o.in_amount_in,
        excluded_transfer_fee_amount_in: o.result.included_fee_input_amount,
        included_transfer_fee_amount_out: o.result.output_amount,
        excluded_transfer_fee_amount_out: o.excluded_transfer_fee_amount_out,
        trading_fee: o.result.trading_fee,
        protocol_fee: o.result.protocol_fee,
        referral_fee: o.result.referral_fee,
        next_sqrt_price: o.result.next_sqrt_price,
        quote_reserve: o.quote_reserve_amount,
        current_timestamp: o.current_timestamp,
      },
      eventAuthority,
      program,
    );
  }
  if (o.curve_complete)
    emitCpi<EvtCurveCompleteWithTransferHook>(
      { pool: pool.key, config: config.key, base_reserve: o.base_reserve, quote_reserve: o.quote_reserve_amount },
      eventAuthority,
      program,
    );
}

/** The claims' TransferHookAccountsInfo: TransferHookBase slices only, and no remaining account beyond them. */
function parseClaimHookAccounts(h: Inout<HookAccounts>, count: u64): void {
  requireHookParsed(h);
  require(h.end === count, PoolError.InvalidRemainingAccountsLength);
}

/** claim_trading_fee2: claim_trading_fee for either pool type, the base transfer carrying the hook's accounts. */
export function claimTradingFee2(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  config: AccountInfo,
  pool: Mut<AccountInfo>,
  tokenAAccount: Mut<TokenAccount>,
  tokenBAccount: Mut<TokenAccount>,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenBaseProgram">,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  baseMint: Mint,
  quoteMint: Mint,
  feeClaimer: Signer,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  maxAmountA: u64,
  maxAmountB: u64,
  transferHookAccountsInfo: TransferHookAccountsInfo,
): void {
  // access control: is_partner_fee_claimer
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  require(c.fee_claimer === feeClaimer.key, PoolError.Unauthorized);
  require(c.quote_mint === quoteMint.key, AnchorError.ConstraintHasOne);
  checkPoolAccount(pool);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.base_mint === baseMint.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  const rest = remainingAccounts();
  const h = noHookAccounts();
  for (const s of transferHookAccountsInfo.slices) parseHookSlice(h, s.accounts_type === AccountsType.TransferHookBaseReferral, u64(s.length_), false, rest.length);
  parseClaimHookAccounts(h, rest.length);
  const baseAmount = p.partner_base_fee < maxAmountA ? p.partner_base_fee : maxAmountA;
  const quoteAmount = p.partner_quote_fee < maxAmountB ? p.partner_quote_fee : maxAmountB;
  p.partner_base_fee = p.partner_base_fee - baseAmount;
  p.partner_quote_fee = p.partner_quote_fee - quoteAmount;
  if (baseAmount > 0n) transferFromPoolAuthority(tokenBaseProgram, baseVault, baseMint, tokenAAccount, poolAuthority, baseAmount, rest, h.has_base, h.base_from, h.base_to);
  if (quoteAmount > 0n) transferFromPoolAuthority(tokenQuoteProgram, quoteVault, quoteMint, tokenBAccount, poolAuthority, quoteAmount, rest, false, 0n, 0n);
  emitCpi<EvtClaimTradingFee>({ pool: pool.key, token_base_amount: baseAmount, token_quote_amount: quoteAmount }, eventAuthority, program);
}

/** claim_creator_trading_fee2: claim_creator_trading_fee for either pool type, the base transfer carrying the hook's accounts. */
export function claimCreatorTradingFee2(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  pool: Mut<AccountInfo>,
  tokenAAccount: Mut<TokenAccount>,
  tokenBAccount: Mut<TokenAccount>,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenBaseProgram">,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  baseMint: Mint,
  quoteMint: Mint,
  creator: Signer,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  maxBaseAmount: u64,
  maxQuoteAmount: u64,
  transferHookAccountsInfo: TransferHookAccountsInfo,
): void {
  // access control: is_pool_creator
  checkPoolAccount(pool);
  const p = loadRawMutAt<PoolState>(pool, 8n);
  require(p.creator === creator.key, PoolError.Unauthorized);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.base_mint === baseMint.key, AnchorError.ConstraintHasOne);
  const rest = remainingAccounts();
  const h = noHookAccounts();
  for (const s of transferHookAccountsInfo.slices) parseHookSlice(h, s.accounts_type === AccountsType.TransferHookBaseReferral, u64(s.length_), false, rest.length);
  parseClaimHookAccounts(h, rest.length);
  const baseAmount = p.creator_base_fee < maxBaseAmount ? p.creator_base_fee : maxBaseAmount;
  const quoteAmount = p.creator_quote_fee < maxQuoteAmount ? p.creator_quote_fee : maxQuoteAmount;
  p.creator_base_fee = p.creator_base_fee - baseAmount;
  p.creator_quote_fee = p.creator_quote_fee - quoteAmount;
  if (baseAmount > 0n) transferFromPoolAuthority(tokenBaseProgram, baseVault, baseMint, tokenAAccount, poolAuthority, baseAmount, rest, h.has_base, h.base_from, h.base_to);
  if (quoteAmount > 0n) transferFromPoolAuthority(tokenQuoteProgram, quoteVault, quoteMint, tokenBAccount, poolAuthority, quoteAmount, rest, false, 0n, 0n);
  emitCpi<EvtClaimCreatorTradingFee>({ pool: pool.key, token_base_amount: baseAmount, token_quote_amount: quoteAmount }, eventAuthority, program);
}

// ---- stage 3: surplus, migration fee, leftover, locker (instructions/partner, creator, migration) ---------------

/** partner_withdraw_surplus: the partner's share of the quote above the threshold, once, after the curve completes. */
export function partnerWithdrawSurplus(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  config: AccountInfo,
  virtualPool: Mut<AccountInfo>,
  tokenQuoteAccount: Mut<TokenAccount>,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  quoteMint: Mint,
  feeClaimer: Signer,
  tokenQuoteProgram: TokenInterface,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  // access control: is_partner_fee_claimer
  checkConfigAccount(config);
  require(loadRawAt<PoolConfig>(config, 8n).fee_claimer === feeClaimer.key, PoolError.Unauthorized);
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  require(c.quote_mint === quoteMint.key, AnchorError.ConstraintHasOne);
  checkPoolAccount(virtualPool);
  const p = loadRawMutAt<PoolState>(virtualPool, 8n);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  require(p.quote_reserve >= c.migration_quote_threshold, PoolError.NotPermitToDoThisAction);
  require(p.is_partner_withdraw_surplus === 0n, PoolError.SurplusHasBeenWithdraw);
  const amount = surplusSplit(c, subU64(p.quote_reserve, c.migration_quote_threshold)).a;
  transferFromPoolAuthority(tokenQuoteProgram, quoteVault, quoteMint, tokenQuoteAccount, poolAuthority, amount, remainingAccounts(), false, 0n, 0n);
  p.is_partner_withdraw_surplus = 1n;
  emitCpi<EvtPartnerWithdrawSurplus>({ pool: virtualPool.key, surplus_amount: amount }, eventAuthority, program);
}

/** creator_withdraw_surplus: the creator's share of the quote above the threshold, once, after the curve completes. */
export function creatorWithdrawSurplus(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  config: AccountInfo,
  virtualPool: Mut<AccountInfo>,
  tokenQuoteAccount: Mut<TokenAccount>,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  quoteMint: Mint,
  creator: Signer,
  tokenQuoteProgram: TokenInterface,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  // access control: is_pool_creator
  checkPoolAccount(virtualPool);
  require(loadRawAt<PoolState>(virtualPool, 8n).creator === creator.key, PoolError.Unauthorized);
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  require(c.quote_mint === quoteMint.key, AnchorError.ConstraintHasOne);
  checkPoolAccount(virtualPool);
  const p = loadRawMutAt<PoolState>(virtualPool, 8n);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  require(p.quote_reserve >= c.migration_quote_threshold, PoolError.NotPermitToDoThisAction);
  require(p.is_creator_withdraw_surplus === 0n, PoolError.SurplusHasBeenWithdraw);
  const amount = surplusSplit(c, subU64(p.quote_reserve, c.migration_quote_threshold)).b;
  transferFromPoolAuthority(tokenQuoteProgram, quoteVault, quoteMint, tokenQuoteAccount, poolAuthority, amount, remainingAccounts(), false, 0n, 0n);
  p.is_creator_withdraw_surplus = 1n;
  emitCpi<EvtCreatorWithdrawSurplus>({ pool: virtualPool.key, surplus_amount: amount }, eventAuthority, program);
}

/** withdraw_migration_fee: the partner's (`flag` 0) or the creator's (1) share of the migration fee, once each. */
export function withdrawMigrationFee(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  config: AccountInfo,
  virtualPool: Mut<AccountInfo>,
  tokenQuoteAccount: Mut<TokenAccount>,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  quoteMint: Mint,
  sender: Signer,
  tokenQuoteProgram: TokenInterface,
  eventAuthority: EventAuthority,
  program: SelfProgram,
  flag: u8,
): void {
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  require(c.quote_mint === quoteMint.key, AnchorError.ConstraintHasOne);
  checkPoolAccount(virtualPool);
  const p = loadRawMutAt<PoolState>(virtualPool, 8n);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  require(p.quote_reserve >= c.migration_quote_threshold, PoolError.NotPermitToDoThisAction);
  const split = migrationFeeDistribution(c);
  require(flag <= 1n, PoolError.TypeCastFailed);
  // PARTNER_MIGRATION_FEE_MASK 0b100, CREATOR_MIGRATION_FEE_MASK 0b010
  let fee: u64 = 0n;
  if (flag === 0n) {
    require(sender.key === c.fee_claimer, PoolError.NotPermitToDoThisAction);
    require((p.migration_fee_withdraw_status & 4n) === 0n, PoolError.MigrationFeeHasBeenWithdraw);
    p.migration_fee_withdraw_status = p.migration_fee_withdraw_status ^ 4n;
    fee = split.a;
  } else {
    require(sender.key === p.creator, PoolError.NotPermitToDoThisAction);
    require((p.migration_fee_withdraw_status & 2n) === 0n, PoolError.MigrationFeeHasBeenWithdraw);
    p.migration_fee_withdraw_status = p.migration_fee_withdraw_status ^ 2n;
    fee = split.b;
  }
  transferFromPoolAuthority(tokenQuoteProgram, quoteVault, quoteMint, tokenQuoteAccount, poolAuthority, fee, remainingAccounts(), false, 0n, 0n);
  emitCpi<EvtWithdrawMigrationFee>({ pool: virtualPool.key, fee, flag }, eventAuthority, program);
}

/** withdraw_leftover: the base a fixed-supply pool did not migrate, to the leftover receiver's ATA, once, after migration. */
export function withdrawLeftover(
  poolAuthority: Address<AccountInfo, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  config: AccountInfo,
  virtualPool: Mut<AccountInfo>,
  tokenBaseAccount: Ata<TokenOf<Mut<TokenAccount>, never, never, "tokenBaseProgram">, "leftoverReceiver", "baseMint">,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenBaseProgram">,
  baseMint: Mint,
  leftoverReceiver: AccountInfo,
  tokenBaseProgram: TokenInterface,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  require(c.leftover_receiver === leftoverReceiver.key, AnchorError.ConstraintHasOne);
  checkPoolAccount(virtualPool);
  const p = loadRawMutAt<PoolState>(virtualPool, 8n);
  require(p.base_mint === baseMint.key, AnchorError.ConstraintHasOne);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  require(p.migration_progress <= MIGRATION_PROGRESS_CREATED_POOL, PoolError.TypeCastFailed);
  require(p.migration_progress === MIGRATION_PROGRESS_CREATED_POOL, PoolError.NotPermitToDoThisAction);
  require(c.fixed_token_supply_flag === 1n, PoolError.NotPermitToDoThisAction);
  require(p.is_withdraw_leftover === 0n, PoolError.LeftoverHasBeenWithdraw);
  const fees = addU64(addU64(p.partner_base_fee, p.protocol_base_fee), p.creator_base_fee);
  const amount = subU64(subU64(baseVault.amount, fees), p.protocol_migration_base_fee_amount);
  const baseFee = epochFee(baseMint);
  if (baseFee.has && calculateFee(baseFee.bps, baseFee.max, amount) > 0n) require(leftoverReceiver.isSigner, AnchorError.AccountNotSigner);
  transferFromPoolAuthority(tokenBaseProgram, baseVault, baseMint, tokenBaseAccount, poolAuthority, amount, remainingAccounts(), false, 0n, 0n);
  p.is_withdraw_leftover = 1n;
  emitCpi<EvtWithdrawLeftover>({ pool: virtualPool.key, leftover_receiver: leftoverReceiver.key, leftover_amount: amount }, eventAuthority, program);
}

/**
 * flash_rent around a CPI the pool authority pays rent in, inside cpi_with_account_lamport_and_owner_checking: what
 * the call took from the pool authority comes back from the payer (a System transfer), and its lamports (not less),
 * owner and size must be as before. `before` is the pool authority's lamports before the call.
 */
function repayFlashRent(poolAuthority: Mut<AccountInfo>, payer: Mut<Signer>, systemProgram: SystemProgram, before: u64): void {
  const after = poolAuthority.lamports;
  if (before > after) invoke(systemProgram, [writableSigner(payer), writable(poolAuthority)], [u32(2n), before - after]);
}

function requireInvariant(poolAuthority: AccountInfo, lamports: u64, owner: Pubkey, size: u64): void {
  require(poolAuthority.lamports >= lamports, PoolError.AccountInvariantViolation);
  require(poolAuthority.owner === owner, PoolError.AccountInvariantViolation);
  require(poolAuthority.dataLen === size, PoolError.AccountInvariantViolation);
}

/** create_locker: the config's locked vesting moves from the base vault to a Jupiter lock escrow for the creator. */
export function createLocker(
  virtualPool: Dup<Mut<AccountInfo>>,
  config: AccountInfo,
  poolAuthority: Address<Mut<AccountInfo>, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenProgram">,
  baseMint: Dup<Mut<AccountInfo>>,
  base: Seeds<Mut<AccountInfo>, ["base_locker", "@virtualPool"]>,
  creator: AccountInfo,
  escrow: Dup<Mut<AccountInfo>>,
  escrowToken: Dup<Mut<AccountInfo>>,
  payer: Mut<Signer>,
  tokenProgram: TokenInterface,
  lockerProgram: Address<AccountInfo, "LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn">,
  lockerEventAuthority: AccountInfo,
  systemProgram: SystemProgram,
): void {
  checkPoolAccount(virtualPool);
  const p = loadRawMutAt<PoolState>(virtualPool, 8n);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  require(p.creator === creator.key, AnchorError.ConstraintHasOne);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.base_mint === baseMint.key, AnchorError.ConstraintHasOne);
  require(p.migration_progress <= MIGRATION_PROGRESS_CREATED_POOL, PoolError.TypeCastFailed);
  require(p.migration_progress === 1n, PoolError.NotPermitToDoThisAction);
  checkConfigAccount(config);
  const v = loadRawAt<PoolConfig>(config, 8n).locked_vesting_config;
  // LockedVestingParams::to_create_vesting_escrow_params
  const start = p.finish_curve_timestamp;
  const cliffTime = start > U64_MAX - v.cliff_duration_from_migration_time ? U64_MAX : start + v.cliff_duration_from_migration_time;
  const lamports = poolAuthority.lamports;
  const owner = poolAuthority.owner;
  const size = poolAuthority.dataLen;
  log("create vesting escrow for creator");
  // create_vesting_escrow_v2 (base, escrow, token_mint, escrow_token, sender, sender_token, recipient, token_program,
  // system_program, event_authority, program), update_recipient_mode 2, cancel_mode 1, no remaining accounts info
  invoke(
    lockerProgram,
    [
      writableSigner(base),
      writable(escrow),
      readonly(baseMint),
      writable(escrowToken),
      writableSigner(poolAuthority),
      writable(baseVault),
      readonly(creator),
      readonly(tokenProgram),
      readonly(systemProgram),
      readonly(lockerEventAuthority),
      readonly(lockerProgram),
    ],
    [sighash("create_vesting_escrow_v2"), start, cliffTime, v.frequency, v.cliff_unlock_amount, v.amount_per_period, v.number_of_period, u8(2n), u8(1n), u8(0n)],
    [
      ["base_locker", virtualPool.key, u8(base.pdaBump)],
      ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
    ],
  );
  repayFlashRent(poolAuthority, payer, systemProgram, lamports);
  requireInvariant(poolAuthority, lamports, owner, size);
  p.migration_progress = 2n;
}

/** migration_damm_v2_create_metadata (deprecated): accepts its accounts and does nothing. */
export function migrationDammV2CreateMetadata(
  virtualPool: AccountInfo,
  config: AccountInfo,
  migrationMetadata: AccountInfo,
  payer: AccountInfo,
  systemProgram: AccountInfo,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {}

// ---- stage 3: migration_damm_v2 (instructions/migration/dynamic_amm_v2/migrate_damm_v2_initialize_pool.rs) -------

/** LiquidityDistributionItem::get_damm_v2_vesting_parameters: the vested part's DAMM v2 vesting from the migration time. */
function itemVesting(item: LiquidityItem, currentTimestamp: u64): DammV2VestingParameters {
  return dammV2VestingParameters(item.bps_per_period, item.number_of_periods, item.frequency, item.cliff_duration_from_migration_time, item.vested_liquidity, currentTimestamp);
}

/** set_authority_for_position: the position NFT account's owner (Token-2022 SetAuthority, AccountOwner) to `owner`. */
function setPositionOwner(positionNftAccount: Mut<AccountInfo>, poolAuthority: AccountInfo, token2022Program: TokenInterface, owner: Pubkey): void {
  invoke(token2022Program, [writable(positionNftAccount), readonlySigner(poolAuthority)], [u8(6n), u8(2n), u8(1n), owner], [
    "pool_authority",
    u8(POOL_AUTHORITY_BUMP),
  ]);
}

/** apply_transfer_fee_authority_option: after a migration with a base transfer fee, the fee config authority as the config says. */
function applyTransferFeeAuthorityOption(c: PoolConfig, creator: Pubkey, baseMint: Mut<AccountInfo>, poolAuthority: AccountInfo, tokenBaseProgram: TokenInterface): void {
  if (c.transfer_fee_flag !== 1n) return;
  const option = c.migrated_transfer_fee_authority_option;
  require(option <= 3n, PoolError.InvalidTransferFeeParameters);
  if (option === 0n) return;
  // transfer_fee_set(0, 0): TransferFeeExtension (26), SetTransferFee (5)
  if (option === 1n)
    invoke(tokenBaseProgram, [writable(baseMint), readonlySigner(poolAuthority)], [u8(26n), u8(5n), u16(0n), 0n], ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  // SetAuthority TransferFeeConfig (4): the creator (2) or the partner (3), revoked when that key is the default
  const next = option === 2n ? creator : option === 3n ? c.fee_claimer : DEFAULT_PUBKEY;
  if (next === DEFAULT_PUBKEY)
    invoke(tokenBaseProgram, [writable(baseMint), readonlySigner(poolAuthority)], [u8(6n), u8(4n), u8(0n)], ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  else
    invoke(tokenBaseProgram, [writable(baseMint), readonlySigner(poolAuthority)], [u8(6n), u8(4n), u8(1n), next], ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
}

/**
 * migration_damm_v2: a completed pool's quote and base move into a new DAMM v2 pool (remaining account 0 is its
 * config): the first position (the larger of the partner's and the creator's liquidity) is created with the pool,
 * the second gets the rest (add_liquidity) or, when either mint charges a transfer fee, is split out of the first
 * (split_position2); each is locked as the config says (permanently, vested) and handed to its owner. The pool
 * authority pays the rent of DAMM v2's accounts and the payer pays it back (flash rent).
 */
export function migrationDammV2(
  virtualPool: Dup<Mut<AccountInfo>>,
  migrationMetadata: AccountInfo,
  config: AccountInfo,
  poolAuthority: Address<Mut<AccountInfo>, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  pool: Dup<Mut<AccountInfo>>,
  firstPositionNftMint: Mut<Signer>,
  firstPositionNftAccount: Dup<Mut<AccountInfo>>,
  firstPosition: Dup<Mut<AccountInfo>>,
  secondPositionNftMint: Dup<Mut<Signer>> | null,
  secondPositionNftAccount: Dup<Mut<AccountInfo>> | null,
  secondPosition: Dup<Mut<AccountInfo>> | null,
  dammPoolAuthority: AccountInfo,
  ammProgram: Address<AccountInfo, "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG">,
  baseMint: Dup<Mut<AccountInfo>>,
  quoteMint: Dup<Mut<AccountInfo>>,
  tokenAVault: Dup<Mut<AccountInfo>>,
  tokenBVault: Dup<Mut<AccountInfo>>,
  baseVault: TokenOf<Mut<TokenAccount>, "baseMint", never, "tokenBaseProgram">,
  quoteVault: TokenOf<Mut<TokenAccount>, "quoteMint", never, "tokenQuoteProgram">,
  payer: Mut<Signer>,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  token2022Program: TokenInterface,
  dammEventAuthority: AccountInfo,
  systemProgram: SystemProgram,
): void {
  constraint(secondPositionNftMint, secondPositionNftMint === null || firstPositionNftMint.key !== secondPositionNftMint.key, AnchorError.ConstraintRaw);
  // handle_migrate_damm_v2: the path (legacy configs and configs without transfer fees take the original one)
  checkConfigAccount(config);
  const c = loadRawAt<PoolConfig>(config, 8n);
  const quoteFee = epochFeeOf(quoteMint);
  let feePath = false;
  if (c.version === 0n) require(!quoteFee.has || mintFeeIsZero(quoteFee), PoolError.QuoteMintHasNonZeroTransferFee);
  else feePath = c.transfer_fee_flag === 1n || hasTransferFeeOrConfigAuthorityOf(quoteMint);
  const currentTimestamp = nowAsU64();
  if (feePath) validateTransferFeeRestrictions(c);
  require(c.migration_fee_option <= MIGRATION_FEE_OPTION_CUSTOMIZABLE, PoolError.InvalidMigrationFeeOption);
  checkPoolAccount(virtualPool);
  const p = loadRawMutAt<PoolState>(virtualPool, 8n);
  // validate
  const rest = remainingAccounts();
  require(rest.length >= 1n, PoolError.MissingPoolConfigInRemainingAccount);
  validateDammConfig(rest.get(0n), c.migration_fee_option);
  require(p.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  require(p.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  require(p.config === config.key, AnchorError.ConstraintHasOne);
  require(p.migration_progress <= MIGRATION_PROGRESS_CREATED_POOL, PoolError.TypeCastFailed);
  require(p.migration_progress === 2n, PoolError.NotPermitToDoThisAction);
  require(p.quote_reserve >= c.migration_quote_threshold, PoolError.PoolIsIncompleted);
  require(c.migration_option <= 1n, PoolError.InvalidMigrationOption);
  require(c.migration_option === MIGRATION_OPTION_DAMM_V2, PoolError.InvalidMigrationOption);

  const initialQuote = quoteVault.amount;
  const initialBase = baseVault.amount;
  const baseFees = addU64(addU64(p.partner_base_fee, p.protocol_base_fee), p.creator_base_fee);
  require(c.migrated_collect_fee_mode <= 2n, PoolError.TypeCastFailed);
  const compounding = feePath || c.migrated_collect_fee_mode === MIGRATED_COLLECT_FEE_MODE_COMPOUNDING;
  const msp = c.migration_sqrt_price;
  const included = includedProtocolFeeMigrationAmounts2(compounding, c.migration_base_threshold, c.migration_quote_threshold, c.migration_fee_percentage, subU64(initialBase, baseFees));
  const bps = p.protocol_liquidity_migration_fee_bps;
  const protocolFees = compounding ? compoundingProtocolFees(included.a, included.b, bps) : concentratedProtocolFees(included.b, bps, msp);
  if (!feePath) {
    p.protocol_migration_base_fee_amount = protocolFees.a;
    p.protocol_migration_quote_fee_amount = protocolFees.b;
  }
  const excludedBase = subU64(included.a, protocolFees.a);
  const excludedQuote = subU64(included.b, protocolFees.b);
  let depositBase = excludedBase;
  let depositQuote = excludedQuote;
  if (feePath) {
    // get_migration_transfer_fee_amounts: the base fee as the config fixes it, the quote mint's for this epoch
    const baseTransferFee = c.transfer_fee_flag === 1n ? calculateFee(u64(c.transfer_fee_basis_points), U64_MAX, excludedBase) : 0n;
    const quoteTransferFee = quoteFee.has ? calculateFee(quoteFee.bps, quoteFee.max, excludedQuote) : 0n;
    const d = compoundingDepositAmounts(excludedBase, excludedQuote, subU64(excludedBase, baseTransferFee), subU64(excludedQuote, quoteTransferFee));
    depositBase = d.a;
    depositQuote = d.b;
  }
  let sqrtPrice: u128 = msp;
  let distributable: u128 = 0n;
  let dead: u128 = 0n;
  if (compounding) {
    const r = compoundingInitialSqrtPriceAndLiquidity(depositBase, depositQuote);
    require(r.some, PoolError.MathOverflow);
    sqrtPrice = r.sqrt_price;
    distributable = subU128(r.liquidity, DAMM_V2_COMPOUNDING_DEAD_LIQUIDITY);
    dead = DAMM_V2_COMPOUNDING_DEAD_LIQUIDITY;
  } else {
    distributable = concentratedInitialLiquidity(depositBase, depositQuote, msp);
  }
  const partnerFirst = itemTotal(liquidityItem(c, distributable, true)) > itemTotal(liquidityItem(c, distributable, false));
  let secondPercentage: u8 = 0n;
  if (feePath) {
    const partnerPercentage = addU8(addU8(c.partner_liquidity_percentage, c.partner_permanent_locked_liquidity_percentage), c.partner_liquidity_vesting_info.vesting_percentage);
    require(partnerPercentage <= 100n, PoolError.MathOverflow);
    secondPercentage = partnerFirst ? u8(100n - partnerPercentage) : partnerPercentage;
  }
  const first = liquidityItem(c, distributable, partnerFirst);
  const second = liquidityItem(c, distributable, !partnerFirst);
  const firstOwner = partnerFirst ? c.fee_claimer : p.creator;
  const secondOwner = partnerFirst ? p.creator : c.fee_claimer;

  // create_pool: initialize_pool on a static config, initialize_pool_with_dynamic_config on a customizable one
  log("create pool");
  const poolLiquidity = feePath ? addU128(distributable, dead) : addU128(itemTotal(first), dead);
  const cfg = rest.get(0n);
  {
    const lamports = poolAuthority.lamports;
    const owner = poolAuthority.owner;
    const size = poolAuthority.dataLen;
    if (c.migration_fee_option === MIGRATION_FEE_OPTION_CUSTOMIZABLE) {
      const baseFee = migratedBaseFee(c);
      const dynamicFee = migratedDynamicFeeControl(c);
      // MigratedCollectFeeMode::to_dammv2_collect_fee_mode: QuoteToken 1 (OnlyB), OutputToken 0 (BothToken), Compounding 2
      const collectFeeMode: u8 = c.migrated_collect_fee_mode === 0n ? 1n : c.migrated_collect_fee_mode === 1n ? 0n : 2n;
      // BaseFeeParameters' 27 bytes: cliff_fee_numerator u64, number_of_period u16, then period_frequency u64 and
      // reduction_factor u64 (BorshFeeTimeScheduler, zero) or sqrt_price_step_bps u32, scheduler_expiration_duration
      // u32 and reduction_factor u64 (BorshFeeMarketCapScheduler), then base_fee_mode u8
      const middle = u64(baseFee.sqrt_price_step_bps) | (u64(baseFee.scheduler_expiration_duration) << 32n);
      if (dynamicFee.some)
        invoke(
          ammProgram,
          [
          readonly(poolAuthority),
          writableSigner(firstPositionNftMint),
          writable(firstPositionNftAccount),
          writableSigner(poolAuthority),
          readonlySigner(poolAuthority),
          readonly(cfg),
          readonly(dammPoolAuthority),
          writable(pool),
          writable(firstPosition),
          readonly(baseMint),
          readonly(quoteMint),
          writable(tokenAVault),
          writable(tokenBVault),
          writable(baseVault),
          writable(quoteVault),
          readonly(tokenBaseProgram),
          readonly(tokenQuoteProgram),
          readonly(token2022Program),
          readonly(systemProgram),
          readonly(dammEventAuthority),
          readonly(ammProgram),
        ],
          [
            sighash("initialize_pool_with_dynamic_config"),
            baseFee.cliff_fee_numerator,
            u16(baseFee.number_of_period),
            u64(middle),
            baseFee.reduction_factor,
            u8(baseFee.base_fee_mode),
            u16(c.migrated_compounding_fee_bps),
            u8(0n),
            u8(1n),
            u16(BIN_STEP_BPS_DEFAULT),
            u128(BIN_STEP_BPS_U128_DEFAULT),
            u16(FILTER_PERIOD_DEFAULT),
            u16(DECAY_PERIOD_DEFAULT),
            u16(REDUCTION_FACTOR_DEFAULT),
            u32(MAX_VOLATILITY_ACCUMULATOR),
            u32(dynamicFee.value),
            u128(MIN_SQRT_PRICE),
            u128(MAX_SQRT_PRICE),
            false,
            u128(poolLiquidity),
            u128(sqrtPrice),
            u8(1n),
            u8(collectFeeMode),
            u8(0n),
          ],
          ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
        );
      else
        invoke(
          ammProgram,
          [
          readonly(poolAuthority),
          writableSigner(firstPositionNftMint),
          writable(firstPositionNftAccount),
          writableSigner(poolAuthority),
          readonlySigner(poolAuthority),
          readonly(cfg),
          readonly(dammPoolAuthority),
          writable(pool),
          writable(firstPosition),
          readonly(baseMint),
          readonly(quoteMint),
          writable(tokenAVault),
          writable(tokenBVault),
          writable(baseVault),
          writable(quoteVault),
          readonly(tokenBaseProgram),
          readonly(tokenQuoteProgram),
          readonly(token2022Program),
          readonly(systemProgram),
          readonly(dammEventAuthority),
          readonly(ammProgram),
        ],
          [
            sighash("initialize_pool_with_dynamic_config"),
            baseFee.cliff_fee_numerator,
            u16(baseFee.number_of_period),
            u64(middle),
            baseFee.reduction_factor,
            u8(baseFee.base_fee_mode),
            u16(c.migrated_compounding_fee_bps),
            u8(0n),
            u8(0n),
            u128(MIN_SQRT_PRICE),
            u128(MAX_SQRT_PRICE),
            false,
            u128(poolLiquidity),
            u128(sqrtPrice),
            u8(1n),
            u8(collectFeeMode),
            u8(0n),
          ],
          ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
        );
    } else
      invoke(
        ammProgram,
        [
          readonly(poolAuthority),
          writableSigner(firstPositionNftMint),
          writable(firstPositionNftAccount),
          writableSigner(poolAuthority),
          readonly(cfg),
          readonly(dammPoolAuthority),
          writable(pool),
          writable(firstPosition),
          readonly(baseMint),
          readonly(quoteMint),
          writable(tokenAVault),
          writable(tokenBVault),
          writable(baseVault),
          writable(quoteVault),
          readonly(tokenBaseProgram),
          readonly(tokenQuoteProgram),
          readonly(token2022Program),
          readonly(systemProgram),
          readonly(dammEventAuthority),
          readonly(ammProgram),
        ],
        [sighash("initialize_pool"), u128(poolLiquidity), u128(sqrtPrice), u8(0n)],
        ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
      );
    repayFlashRent(poolAuthority, payer, systemProgram, lamports);
    requireInvariant(poolAuthority, lamports, owner, size);
  }

  if (!feePath) {
    if (itemLocked(first) > 0n)
      {
        // lock_liquidity_position: permanent_lock_position, then lock_inner_position for the vested part, under flash rent
        const vesting = itemVesting(first, currentTimestamp);
        const lamports = poolAuthority.lamports;
        const owner = poolAuthority.owner;
        const size = poolAuthority.dataLen;
        if (first.permanent_locked_liquidity > 0n)
          invoke(
            ammProgram,
            [writable(pool), writable(firstPosition), readonly(firstPositionNftAccount), readonlySigner(poolAuthority), readonly(dammEventAuthority), readonly(ammProgram)],
            [sighash("permanent_lock_position"), u128(first.permanent_locked_liquidity)],
            ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
          );
        if (first.vested_liquidity > 0n)
          invoke(
            ammProgram,
            [readonly(pool), writable(firstPosition), readonly(firstPositionNftAccount), readonlySigner(poolAuthority), readonly(dammEventAuthority), readonly(ammProgram)],
            [
              sighash("lock_inner_position"),
              u8(1n),
              vesting.cliff_point,
              vesting.period_frequency,
              u128(vesting.cliff_unlock_liquidity),
              u128(vesting.liquidity_per_period),
              u16(vesting.number_of_period),
            ],
            ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
          );
        repayFlashRent(poolAuthority, payer, systemProgram, lamports);
        requireInvariant(poolAuthority, lamports, owner, size);
      }
    log("transfer ownership of the first position");
    setPositionOwner(firstPositionNftAccount, poolAuthority, token2022Program, firstOwner);
    const leftoverBase = subU64(excludedBase, subU64(initialBase, baseVault.amount));
    const leftoverQuote = subU64(excludedQuote, subU64(initialQuote, quoteVault.amount));
    const reserves = dammPoolReserves(pool);
    const secondLiquidity = compounding
      ? compoundingLiquidityDelta(leftoverBase, leftoverQuote, reserves.token_a_amount, reserves.token_b_amount, reserves.liquidity)
      : concentratedInitialLiquidity(leftoverBase, leftoverQuote, msp);
    if (secondLiquidity > 0n) {
      adjustLiquidity(second, secondLiquidity);
      log("create second position");
      if (secondPositionNftMint === null || secondPositionNftAccount === null || secondPosition === null) panic("called `Option::unwrap()` on a `None` value");
      // create_second_position_without_liquidity: create_position for the pool authority, the payer paying
      log("create position");
      invoke(
        ammProgram,
        [
          readonly(poolAuthority),
          writableSigner(secondPositionNftMint),
          writable(secondPositionNftAccount),
          writable(pool),
          writable(secondPosition),
          readonly(dammPoolAuthority),
          writableSigner(payer),
          readonly(token2022Program),
          readonly(systemProgram),
          readonly(dammEventAuthority),
          readonly(ammProgram),
        ],
        [sighash("create_position")],
      );
      log("add liquidity");
      const lamports = poolAuthority.lamports;
      const owner = poolAuthority.owner;
      const size = poolAuthority.dataLen;
      invoke(
        ammProgram,
        [
          writable(pool),
          writable(secondPosition),
          writable(baseVault),
          writable(quoteVault),
          writable(tokenAVault),
          writable(tokenBVault),
          readonly(baseMint),
          readonly(quoteMint),
          readonly(secondPositionNftAccount),
          readonlySigner(poolAuthority),
          readonly(tokenBaseProgram),
          readonly(tokenQuoteProgram),
          readonly(dammEventAuthority),
          readonly(ammProgram),
        ],
        [sighash("add_liquidity"), u128(secondLiquidity), U64_MAX, U64_MAX],
        ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
      );
      requireInvariant(poolAuthority, lamports, owner, size);
      if (itemLocked(second) > 0n)
        {
          // lock_liquidity_position: permanent_lock_position, then lock_inner_position for the vested part, under flash rent
          const vesting = itemVesting(second, currentTimestamp);
          const lamports = poolAuthority.lamports;
          const owner = poolAuthority.owner;
          const size = poolAuthority.dataLen;
          if (second.permanent_locked_liquidity > 0n)
            invoke(
              ammProgram,
              [writable(pool), writable(secondPosition), readonly(secondPositionNftAccount), readonlySigner(poolAuthority), readonly(dammEventAuthority), readonly(ammProgram)],
              [sighash("permanent_lock_position"), u128(second.permanent_locked_liquidity)],
              ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
            );
          if (second.vested_liquidity > 0n)
            invoke(
              ammProgram,
              [readonly(pool), writable(secondPosition), readonly(secondPositionNftAccount), readonlySigner(poolAuthority), readonly(dammEventAuthority), readonly(ammProgram)],
              [
                sighash("lock_inner_position"),
                u8(1n),
                vesting.cliff_point,
                vesting.period_frequency,
                u128(vesting.cliff_unlock_liquidity),
                u128(vesting.liquidity_per_period),
                u16(vesting.number_of_period),
              ],
              ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
            );
          repayFlashRent(poolAuthority, payer, systemProgram, lamports);
          requireInvariant(poolAuthority, lamports, owner, size);
        }
      log("set authority for second position");
      setPositionOwner(secondPositionNftAccount, poolAuthority, token2022Program, secondOwner);
    }
    p.is_migrated = 1n;
    // burn what is left of the base beyond the fees owed, up to the supply the config lets go
    const left = subU64(baseVault.amount, addU64(baseFees, protocolFees.a));
    let burnable = left;
    if (c.fixed_token_supply_flag === 1n) {
      const max = subU64(c.pre_migration_token_supply, c.post_migration_token_supply);
      if (max < burnable) burnable = max;
    }
    if (burnable > 0n)
      invoke(tokenBaseProgram, [writable(baseVault), writable(baseMint), readonlySigner(poolAuthority)], [u8(8n), burnable], ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
    p.migration_progress = MIGRATION_PROGRESS_CREATED_POOL;
    return;
  }

  // the transfer fee path: the second position is split out of the first, so the fee is not charged twice
  const numerator = 10_000_000n * u64(secondPercentage);
  const split = safeMulDivCastU128(distributable, u128(numerator), u128(SPLIT_POSITION_DENOMINATOR), false);
  const hasSecond = split > 0n;
  if (hasSecond) {
    log("create second position");
    if (secondPositionNftMint === null || secondPositionNftAccount === null || secondPosition === null) panic("called `Option::unwrap()` on a `None` value");
    // create_second_position_without_liquidity: create_position for the pool authority, the payer paying
    log("create position");
    invoke(
      ammProgram,
      [
        readonly(poolAuthority),
        writableSigner(secondPositionNftMint),
        writable(secondPositionNftAccount),
        writable(pool),
        writable(secondPosition),
        readonly(dammPoolAuthority),
        writableSigner(payer),
        readonly(token2022Program),
        readonly(systemProgram),
        readonly(dammEventAuthority),
        readonly(ammProgram),
      ],
      [sighash("create_position")],
    );
    log("split position");
    invoke(
      ammProgram,
      [
        writable(pool),
        writable(firstPosition),
        readonly(firstPositionNftAccount),
        writable(secondPosition),
        readonly(secondPositionNftAccount),
        readonlySigner(poolAuthority),
        readonlySigner(poolAuthority),
        readonly(dammEventAuthority),
        readonly(ammProgram),
      ],
      [sighash("split_position2"), u32(numerator)],
      ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
    );
    adjustLiquidity(second, dammPositionUnlockedLiquidity(secondPosition));
  }
  if (itemLocked(first) > 0n)
    {
      // lock_liquidity_position: permanent_lock_position, then lock_inner_position for the vested part, under flash rent
      const vesting = itemVesting(first, currentTimestamp);
      const lamports = poolAuthority.lamports;
      const owner = poolAuthority.owner;
      const size = poolAuthority.dataLen;
      if (first.permanent_locked_liquidity > 0n)
        invoke(
          ammProgram,
          [writable(pool), writable(firstPosition), readonly(firstPositionNftAccount), readonlySigner(poolAuthority), readonly(dammEventAuthority), readonly(ammProgram)],
          [sighash("permanent_lock_position"), u128(first.permanent_locked_liquidity)],
          ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
        );
      if (first.vested_liquidity > 0n)
        invoke(
          ammProgram,
          [readonly(pool), writable(firstPosition), readonly(firstPositionNftAccount), readonlySigner(poolAuthority), readonly(dammEventAuthority), readonly(ammProgram)],
          [
            sighash("lock_inner_position"),
            u8(1n),
            vesting.cliff_point,
            vesting.period_frequency,
            u128(vesting.cliff_unlock_liquidity),
            u128(vesting.liquidity_per_period),
            u16(vesting.number_of_period),
          ],
          ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
        );
      repayFlashRent(poolAuthority, payer, systemProgram, lamports);
      requireInvariant(poolAuthority, lamports, owner, size);
    }
  if (hasSecond && secondPosition !== null && secondPositionNftAccount !== null && itemLocked(second) > 0n)
    {
      // lock_liquidity_position: permanent_lock_position, then lock_inner_position for the vested part, under flash rent
      const vesting = itemVesting(second, currentTimestamp);
      const lamports = poolAuthority.lamports;
      const owner = poolAuthority.owner;
      const size = poolAuthority.dataLen;
      if (second.permanent_locked_liquidity > 0n)
        invoke(
          ammProgram,
          [writable(pool), writable(secondPosition), readonly(secondPositionNftAccount), readonlySigner(poolAuthority), readonly(dammEventAuthority), readonly(ammProgram)],
          [sighash("permanent_lock_position"), u128(second.permanent_locked_liquidity)],
          ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
        );
      if (second.vested_liquidity > 0n)
        invoke(
          ammProgram,
          [readonly(pool), writable(secondPosition), readonly(secondPositionNftAccount), readonlySigner(poolAuthority), readonly(dammEventAuthority), readonly(ammProgram)],
          [
            sighash("lock_inner_position"),
            u8(1n),
            vesting.cliff_point,
            vesting.period_frequency,
            u128(vesting.cliff_unlock_liquidity),
            u128(vesting.liquidity_per_period),
            u16(vesting.number_of_period),
          ],
          ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
        );
      repayFlashRent(poolAuthority, payer, systemProgram, lamports);
      requireInvariant(poolAuthority, lamports, owner, size);
    }
  log("transfer ownership of the first position");
  setPositionOwner(firstPositionNftAccount, poolAuthority, token2022Program, firstOwner);
  if (hasSecond && secondPositionNftAccount !== null) {
    log("set authority for second position");
    setPositionOwner(secondPositionNftAccount, poolAuthority, token2022Program, secondOwner);
  }
  log("apply the transfer fee authority option");
  applyTransferFeeAuthorityOption(c, p.creator, baseMint, poolAuthority, tokenBaseProgram);
  p.is_migrated = 1n;
  // what the transfer fees kept out of DAMM v2 is the protocol's
  const depositedBase = subU64(initialBase, baseVault.amount);
  const depositedQuote = subU64(initialQuote, quoteVault.amount);
  p.protocol_migration_base_fee_amount = addU64(protocolFees.a, excludedBase > depositedBase ? excludedBase - depositedBase : 0n);
  p.protocol_migration_quote_fee_amount = addU64(protocolFees.b, excludedQuote > depositedQuote ? excludedQuote - depositedQuote : 0n);
  p.migration_progress = MIGRATION_PROGRESS_CREATED_POOL;
}

// ---- stage 4: the DAMM v1 migration (instructions/migration/meteora_damm/) -----------------------------------------
// Deprecated for new configs (create_config refuses migration option 0); pools of configs made before 0.2.1 still
// migrate this way. The accounts are Anchor's AccountLoader<VirtualPool> / AccountLoader<PoolConfig> here (not the
// custom loaders of the other instructions): a transfer hook pool or config fails their discriminator check (3002).

// Their token accounts are Anchor's Account<anchor_spl::token::TokenAccount>, SPL Token's only: a Token-2022 account
// is owned by another program (3007), checked first.

/** migration_meteora_damm_create_metadata: the DAMM v1 migration metadata (PDA ["meteora", pool]), its partner the config's fee claimer. */
export function migrationMeteoraDammCreateMetadata(
  virtualPool: Account<VirtualPool>,
  config: Account<PoolConfigAccount>,
  migrationMetadata: Init<MeteoraDammMigrationMetadata>,
  payer: Mut<Signer>,
  systemProgram: SystemProgram,
  eventAuthority: EventAuthority,
  program: SelfProgram,
): void {
  constraint(virtualPool, virtualPool.pool_state.config === config.key, AnchorError.ConstraintHasOne);
  migrationMetadata.create(payer, ["meteora", virtualPool.key]);
  const c = config.config;
  require(c.migration_option <= 1n, PoolError.InvalidMigrationOption);
  require(c.migration_option === MIGRATION_OPTION_METEORA_DAMM, PoolError.InvalidMigrationOption);
  migrationMetadata.virtual_pool = virtualPool.key;
  migrationMetadata.partner = c.fee_claimer;
  emitCpi<EvtCreateMeteoraMigrationMetadata>({ virtual_pool: virtualPool.key }, eventAuthority, program);
}

/**
 * migrate_meteora_damm: a completed pool's quote and base (the compounding amounts, less the protocol's migration
 * fee) go into a new DAMM v1 constant product pool on the config's DAMM v1 config
 * (initialize_permissionless_constant_product_pool_with_config2, the pool authority paying and lending the rent, the
 * payer paying it back), the base left beyond the fees burns up to what the config lets go, and the LP minted to the
 * pool authority is split between the partner and the creator in the migration metadata, to be locked or claimed.
 */
export function migrateMeteoraDamm(
  virtualPool: Dup<Mut<VirtualPool>>,
  migrationMetadata: Dup<Mut<MeteoraDammMigrationMetadata>>,
  config: Account<PoolConfigAccount>,
  poolAuthority: Address<Dup<Mut<AccountInfo>>, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  pool: Dup<Mut<AccountInfo>>,
  dammConfig: AccountInfo,
  lpMint: Dup<Mut<AccountInfo>>,
  tokenAMint: Dup<Mut<AccountInfo>>,
  tokenBMint: AccountInfo,
  aVault: Dup<Mut<AccountInfo>>,
  bVault: Dup<Mut<AccountInfo>>,
  aTokenVault: Dup<Mut<AccountInfo>>,
  bTokenVault: Dup<Mut<AccountInfo>>,
  aVaultLpMint: Dup<Mut<AccountInfo>>,
  bVaultLpMint: Dup<Mut<AccountInfo>>,
  aVaultLp: Dup<Mut<AccountInfo>>,
  bVaultLp: Dup<Mut<AccountInfo>>,
  baseVault: Mut<TokenAccount>,
  quoteVault: Mut<TokenAccount>,
  virtualPoolLp: Dup<Mut<AccountInfo>>,
  protocolTokenAFee: Dup<Mut<AccountInfo>>,
  protocolTokenBFee: Dup<Mut<AccountInfo>>,
  payer: Dup<Mut<Signer>>,
  rent: AccountInfo,
  mintMetadata: Dup<Mut<AccountInfo>>,
  metadataProgram: AccountInfo,
  ammProgram: Address<AccountInfo, "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB">,
  vaultProgram: AccountInfo,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AccountInfo,
  systemProgram: SystemProgram,
): void {
  // Account<dynamic_amm::accounts::Config>::try_from (a Borsh account): never created (3012), owner (3007), a
  // discriminator to read (3001) and match (3002), the struct's bytes (3003); then the SPL Token accounts
  constraint(virtualPool, dammConfig.owner !== DEFAULT_PUBKEY || dammConfig.lamports !== 0n, AnchorError.AccountNotInitialized);
  constraint(virtualPool, dammConfig.owner === DAMM_V1_PROGRAM_ID, AnchorError.AccountOwnedByWrongProgram);
  constraint(virtualPool, dammConfig.dataLen >= 8n, AnchorError.AccountDiscriminatorNotFound);
  constraint(virtualPool, readData<u64>(dammConfig, 0n) === DISC_DAMM_V1_CONFIG, AnchorError.AccountDiscriminatorMismatch);
  constraint(virtualPool, dammConfig.dataLen >= DAMM_V1_CONFIG_SIZE, AnchorError.AccountDidNotDeserialize);
  constraint(virtualPool, baseVault.tokenProgram === TOKEN_PROGRAM_ID, AnchorError.AccountOwnedByWrongProgram);
  constraint(virtualPool, quoteVault.tokenProgram === TOKEN_PROGRAM_ID, AnchorError.AccountOwnedByWrongProgram);
  constraint(virtualPool, virtualPool.pool_state.base_vault === baseVault.key, AnchorError.ConstraintHasOne);
  constraint(virtualPool, virtualPool.pool_state.quote_vault === quoteVault.key, AnchorError.ConstraintHasOne);
  constraint(virtualPool, virtualPool.pool_state.config === config.key, AnchorError.ConstraintHasOne);
  constraint(migrationMetadata, migrationMetadata.virtual_pool === virtualPool.key, AnchorError.ConstraintHasOne);
  const c = config.config;
  validateDammV1Config(dammConfig, c.migration_fee_option);
  const p = virtualPool.pool_state;
  require(p.migration_progress <= MIGRATION_PROGRESS_CREATED_POOL, PoolError.TypeCastFailed);
  require(p.migration_progress === 2n, PoolError.NotPermitToDoThisAction);
  require(p.quote_reserve >= c.migration_quote_threshold, PoolError.PoolIsIncompleted);
  require(c.migration_option <= 1n, PoolError.InvalidMigrationOption);
  require(c.migration_option === MIGRATION_OPTION_METEORA_DAMM, PoolError.InvalidMigrationOption);

  // CompoundingLiquidity at the migration price: the base threshold and the quote less the migration fee
  const baseFees = addU64(addU64(p.partner_base_fee, p.protocol_base_fee), p.creator_base_fee);
  const included = includedProtocolFeeMigrationAmounts2(true, c.migration_base_threshold, c.migration_quote_threshold, c.migration_fee_percentage, subU64(baseVault.amount, baseFees));
  const protocolFees = compoundingProtocolFees(included.a, included.b, p.protocol_liquidity_migration_fee_bps);
  p.protocol_migration_base_fee_amount = protocolFees.a;
  p.protocol_migration_quote_fee_amount = protocolFees.b;
  const excludedBase = subU64(included.a, protocolFees.a);
  const excludedQuote = subU64(included.b, protocolFees.b);

  // create_pool: initialize_permissionless_constant_product_pool_with_config2 (token_a_amount, token_b_amount,
  // activation_point None), the pool authority its payer, under flash rent
  {
    const lamports = poolAuthority.lamports;
    const owner = poolAuthority.owner;
    const size = poolAuthority.dataLen;
    log("create pool");
    invoke(
      ammProgram,
      [
        writable(pool),
        readonly(dammConfig),
        writable(lpMint),
        readonly(tokenAMint),
        readonly(tokenBMint),
        writable(aVault),
        writable(bVault),
        writable(aTokenVault),
        writable(bTokenVault),
        writable(aVaultLpMint),
        writable(bVaultLpMint),
        writable(aVaultLp),
        writable(bVaultLp),
        writable(baseVault),
        writable(quoteVault),
        writable(virtualPoolLp),
        writable(protocolTokenAFee),
        writable(protocolTokenBFee),
        writableSigner(poolAuthority),
        readonly(rent),
        writable(mintMetadata),
        readonly(metadataProgram),
        readonly(vaultProgram),
        readonly(tokenProgram),
        readonly(associatedTokenProgram),
        readonly(systemProgram),
      ],
      [sighash("initialize_permissionless_constant_product_pool_with_config2"), excludedBase, excludedQuote, u8(0n)],
      ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
    );
    repayFlashRent(poolAuthority, payer, systemProgram, lamports);
    requireInvariant(poolAuthority, lamports, owner, size);
  }
  p.is_migrated = 1n;

  // burn what is left of the base beyond the fees owed, up to the supply the config lets go
  const left = subU64(baseVault.amount, addU64(baseFees, protocolFees.a));
  let burnable = left;
  if (c.fixed_token_supply_flag === 1n) {
    const max = subU64(c.pre_migration_token_supply, c.post_migration_token_supply);
    if (max < burnable) burnable = max;
  }
  if (burnable > 0n)
    invoke(tokenProgram, [writable(baseVault), writable(tokenAMint), readonlySigner(poolAuthority)], [u8(8n), burnable], ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);

  // the LP the pool authority got (anchor_spl's accessor::amount: bytes 64..72), split as the config says; DAMM v1
  // has no vesting, so a vested share stays with the pool authority
  const lpMinted = readData<u64>(virtualPoolLp, 64n);
  const partner = liquidityItem(c, u128(lpMinted), true);
  const creator = liquidityItem(c, u128(lpMinted), false);
  migrationMetadata.lp_mint = lpMint.key;
  migrationMetadata.partner_locked_liquidity = castU128ToU64(partner.permanent_locked_liquidity);
  migrationMetadata.partner_liquidity = castU128ToU64(partner.unlocked_liquidity);
  migrationMetadata.creator_locked_liquidity = castU128ToU64(creator.permanent_locked_liquidity);
  migrationMetadata.creator_liquidity = castU128ToU64(creator.unlocked_liquidity);
  p.migration_progress = MIGRATION_PROGRESS_CREATED_POOL;
}

/** SafeCast<u64> for u128: TypeCastFailed past u64. */
function castU128ToU64(x: u128): u64 {
  require(x <= u128(U64_MAX), PoolError.TypeCastFailed);
  return u64(x);
}

/**
 * migrate_meteora_damm_lock_lp_token: the partner's or the creator's locked LP (both, for a creator who is the
 * partner) into the owner's DAMM v1 lock escrow (DAMM v1's `lock`, signed by the pool authority), once each.
 */
export function migrateMeteoraDammLockLpToken(
  virtualPool: Account<VirtualPool>,
  migrationMetadata: Dup<Mut<MeteoraDammMigrationMetadata>>,
  poolAuthority: Address<Dup<Mut<AccountInfo>>, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  pool: Dup<Mut<AccountInfo>>,
  lpMint: AccountInfo,
  lockEscrow: HasOne<HasOne<Owner<Mut<DammV1LockEscrow>, "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB">, "pool">, "owner">,
  owner: AccountInfo,
  sourceTokens: Ata<Mut<TokenAccount>, "poolAuthority", "lpMint">,
  escrowVault: Dup<Mut<AccountInfo>>,
  ammProgram: Address<AccountInfo, "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB">,
  aVault: AccountInfo,
  bVault: AccountInfo,
  aVaultLp: AccountInfo,
  bVaultLp: AccountInfo,
  aVaultLpMint: AccountInfo,
  bVaultLpMint: AccountInfo,
  tokenProgram: TokenProgram,
): void {
  constraint(virtualPool, sourceTokens.tokenProgram === TOKEN_PROGRAM_ID, AnchorError.AccountOwnedByWrongProgram);
  constraint(migrationMetadata, migrationMetadata.lp_mint === lpMint.key, AnchorError.ConstraintHasOne);
  constraint(migrationMetadata, migrationMetadata.virtual_pool === virtualPool.key, AnchorError.ConstraintHasOne);
  const p = virtualPool.pool_state;
  require(p.migration_progress <= MIGRATION_PROGRESS_CREATED_POOL, PoolError.TypeCastFailed);
  require(p.migration_progress === MIGRATION_PROGRESS_CREATED_POOL, PoolError.NotPermitToDoThisAction);
  const isPartner = owner.key === migrationMetadata.partner;
  const isCreator = owner.key === p.creator;
  require(isPartner || isCreator, PoolError.InvalidOwnerAccount);
  let amount: u64 = 0n;
  if (isPartner && isCreator) {
    // lock_as_self_partnered_creator
    require(migrationMetadata.creator_locked_status !== 1n && migrationMetadata.partner_locked_status !== 1n, PoolError.NotPermitToDoThisAction);
    amount = addU64(migrationMetadata.partner_locked_liquidity, migrationMetadata.creator_locked_liquidity);
    require(amount !== 0n, PoolError.NotPermitToDoThisAction);
    migrationMetadata.creator_locked_status = 1n;
    migrationMetadata.partner_locked_status = 1n;
  } else if (isPartner) {
    require(migrationMetadata.partner_locked_status !== 1n, PoolError.NotPermitToDoThisAction);
    require(migrationMetadata.partner_locked_liquidity !== 0n, PoolError.NotPermitToDoThisAction);
    migrationMetadata.partner_locked_status = 1n;
    amount = migrationMetadata.partner_locked_liquidity;
  } else {
    require(migrationMetadata.creator_locked_status !== 1n, PoolError.NotPermitToDoThisAction);
    require(migrationMetadata.creator_locked_liquidity !== 0n, PoolError.NotPermitToDoThisAction);
    migrationMetadata.creator_locked_status = 1n;
    amount = migrationMetadata.creator_locked_liquidity;
  }
  // DAMM v1's lock (max_amount), the pool authority the owner of the tokens, with its lamports, owner and size kept
  const lamports = poolAuthority.lamports;
  const authorityOwner = poolAuthority.owner;
  const size = poolAuthority.dataLen;
  invoke(
    ammProgram,
    [
      writable(pool),
      readonly(lpMint),
      writable(lockEscrow),
      writableSigner(poolAuthority),
      writable(sourceTokens),
      writable(escrowVault),
      readonly(tokenProgram),
      readonly(aVault),
      readonly(bVault),
      readonly(aVaultLp),
      readonly(bVaultLp),
      readonly(aVaultLpMint),
      readonly(bVaultLpMint),
    ],
    [sighash("lock"), amount],
    ["pool_authority", u8(POOL_AUTHORITY_BUMP)],
  );
  requireInvariant(poolAuthority, lamports, authorityOwner, size);
}

/**
 * migrate_meteora_damm_claim_lp_token: the partner's or the creator's unlocked LP (both, for a creator who is the
 * partner) from the pool authority's LP account to the owner's, once each. Anyone may send it.
 */
export function migrateMeteoraDammClaimLpToken(
  virtualPool: Account<VirtualPool>,
  migrationMetadata: Dup<Mut<MeteoraDammMigrationMetadata>>,
  poolAuthority: Address<Dup<Mut<AccountInfo>>, "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM">,
  lpMint: AccountInfo,
  sourceToken: Ata<Mut<TokenAccount>, "poolAuthority", "lpMint">,
  destinationToken: Ata<Mut<TokenAccount>, "owner", "lpMint">,
  owner: AccountInfo,
  sender: Signer,
  tokenProgram: TokenProgram,
): void {
  constraint(virtualPool, sourceToken.tokenProgram === TOKEN_PROGRAM_ID, AnchorError.AccountOwnedByWrongProgram);
  constraint(virtualPool, destinationToken.tokenProgram === TOKEN_PROGRAM_ID, AnchorError.AccountOwnedByWrongProgram);
  constraint(migrationMetadata, migrationMetadata.lp_mint === lpMint.key, AnchorError.ConstraintHasOne);
  constraint(migrationMetadata, migrationMetadata.virtual_pool === virtualPool.key, AnchorError.ConstraintHasOne);
  const p = virtualPool.pool_state;
  require(p.migration_progress <= MIGRATION_PROGRESS_CREATED_POOL, PoolError.TypeCastFailed);
  require(p.migration_progress === MIGRATION_PROGRESS_CREATED_POOL, PoolError.NotPermitToDoThisAction);
  const isPartner = owner.key === migrationMetadata.partner;
  const isCreator = owner.key === p.creator;
  require(isPartner || isCreator, PoolError.InvalidOwnerAccount);
  let amount: u64 = 0n;
  if (isPartner && isCreator) {
    // claim_as_self_partnered_creator
    require(migrationMetadata.creator_claim_status !== 1n && migrationMetadata.partner_claim_status !== 1n, PoolError.NotPermitToDoThisAction);
    amount = addU64(migrationMetadata.partner_liquidity, migrationMetadata.creator_liquidity);
    require(amount !== 0n, PoolError.NotPermitToDoThisAction);
    migrationMetadata.creator_claim_status = 1n;
    migrationMetadata.partner_claim_status = 1n;
  } else if (isPartner) {
    require(migrationMetadata.partner_claim_status !== 1n, PoolError.NotPermitToDoThisAction);
    require(migrationMetadata.partner_liquidity !== 0n, PoolError.NotPermitToDoThisAction);
    migrationMetadata.partner_claim_status = 1n;
    amount = migrationMetadata.partner_liquidity;
  } else {
    require(migrationMetadata.creator_claim_status !== 1n, PoolError.NotPermitToDoThisAction);
    require(migrationMetadata.creator_liquidity !== 0n, PoolError.NotPermitToDoThisAction);
    migrationMetadata.creator_claim_status = 1n;
    amount = migrationMetadata.creator_liquidity;
  }
  // SPL Token Transfer (3), signed by the pool authority
  invoke(tokenProgram, [writable(sourceToken), writable(destinationToken), readonlySigner(poolAuthority)], [u8(3n), amount], ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
}
