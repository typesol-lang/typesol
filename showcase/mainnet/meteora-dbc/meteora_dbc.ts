// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// Meteora's Dynamic Bonding Curve, release 0.2.2 (programs/dynamic-bonding-curve/src/lib.rs and instructions/):
// launch pools that sell a base token along a curve of up to 16 constant-liquidity segments and migrate to a DAMM
// pool when the quote threshold is reached.
//
// This stage ports 9 of its 35 instructions: the admin's operator accounts and the legacy claim-fee operator, token
// badges, partner metadata, and the three config instructions. The others are not here yet: their discriminators fail
// with Anchor's InstructionFallbackNotFound (101).
//
// Anchor checks each instruction's accounts first (the `init` accounts created among them), then its
// `#[access_control]` function, then the handler; the bodies below keep that order: creates first, then the access
// check, then the handler's own checks.
import {
  type Account,
  type AccountInfo,
  type CloseTo,
  type EventAuthority,
  type Executable,
  type Init,
  type Mint,
  type Mut,
  type Option,
  type Pubkey,
  type RemainingAccounts,
  type SelfProgram,
  type Signer,
  type SystemProgram,
  byteLength,
  emitCpi,
  instructionData,
  now,
  programId,
  pubkey,
  remainingAccounts,
  require,
  u64,
  u128,
} from "typesol";
import { DEFAULT_PUBKEY, processCreateConfig, validateConfigParameters, validateTransferFeeParameters } from "./config";
import { PoolError } from "./errors";
import { type EvtCreateConfig3, type EvtCreateConfigV2, type EvtCreateConfigV2WithTransferHook, type EvtCloseClaimFeeOperator, type EvtCloseTokenBadge, type EvtCreateTokenBadge, type EvtPartnerMetadata } from "./events";
import { U64_MAX } from "./math";
import {
  type ClaimFeeOperator,
  type ConfigParameters,
  type ConfigWithTransferHook,
  type CreatePartnerMetadataParameters,
  type Operator,
  type PartnerMetadata,
  type PoolConfigAccount,
  type TokenBadge,
  type TransferFeeParameters,
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
  mintScore,
  mintScoreWithBadge,
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
