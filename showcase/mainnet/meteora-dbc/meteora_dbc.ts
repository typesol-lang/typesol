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
  type Address,
  type Dup,
  type TokenAccount,
  type TokenInterface,
  type TokenOf,
  type MintOf,
  type TokenProgram,
  type UncheckedProgram,
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
  AnchorError,
  AuthorityType,
  ProgramError,
  currentSlot,
  invoke,
  readonly,
  readonlySigner,
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
  instructionData,
  now,
  programId,
  pubkey,
  remainingAccounts,
  require,
  u8,
  u64,
  u128,
} from "typesol";
import { DEFAULT_PUBKEY, initialBaseSupply, totalLiquidityLockedBpsAtNSeconds, processCreateConfig, validateConfigParameters, validateTransferFeeParameters } from "./config";
import { PoolError } from "./errors";
import { type EvtInitializePool, type EvtClaimProtocolFee2, type EvtVirtualPoolMetadata, type EvtClaimCreatorTradingFee, type EvtClaimPoolCreationFee, type EvtClaimTradingFee, type EvtPartnerClaimPoolCreationFee, type EvtUpdatePoolCreator, type EvtCurveComplete, type EvtSwap, type EvtSwap2, type EvtSwap3, type EvtCreateConfig3, type EvtCreateConfigV2, type EvtCreateConfigV2WithTransferHook, type EvtCloseClaimFeeOperator, type EvtCloseTokenBadge, type EvtCreateTokenBadge, type EvtPartnerMetadata } from "./events";
import { U64_MAX, addU64, safeMulDivCastU64, subU64 } from "./math";
import { validateMinBaseFee } from "./fees";
import { POOL_AUTHORITY_BUMP, checkConfigAccount, checkPoolAccount, finishSwap, processSwap, requireNoTransferHook } from "./process_swap";
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
  type SwapParameters,
  type SwapParameters2,
  type TransferFeeParameters,
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
  mintScore,
  mintScoreWithBadge,
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
