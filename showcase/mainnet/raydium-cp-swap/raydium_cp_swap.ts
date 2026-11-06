// A port of Raydium CP-Swap (raydium-io/raydium-cp-swap, programs/cp-swap, Anchor 1.0.2), Copyright Raydium, licensed
// under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL;
// this file ports all 21 of its instructions (see docs/case-study-raydium-cp-swap.md).
//
// A constant-product AMM: pools of two tokens (SPL Token or Token-2022 with the extensions it accepts) whose LP tokens
// are minted on deposit and burned on withdrawal; swaps take a trade fee, part of which goes to the protocol and a fund.
import {
  type Account,
  type AccountInfo,
  type AssociatedTokenProgram,
  type Ata,
  type CloseTo,
  type Init,
  type InitIfNeeded,
  type Option,
  type Owner,
  type RemainingAccount,
  type RemainingAccounts,
  type MintOf,
  type TokenOf,
  type Address,
  type Mint,
  type Mut,
  type Seeds,
  type Signer,
  type SignerSeeds,
  type SystemProgram,
  type TokenAccount,
  type TokenInterface,
  type TokenProgram,
  type Token2022Program,
  type u16,
  AnchorError,
  ProgramError,
  constraint,
  currentEpoch,
  emit,
  extensionsWithin,
  findProgramAddress,
  findProgramAddressBump,
  initAccount,
  invoke,
  isqrt,
  loadAccount,
  log,
  now,
  programId,
  pubkey,
  readData,
  readonlySigner,
  remainingAccounts,
  rentExempt,
  require,
  signer,
  transferFee,
  transferFeeBasisPoints,
  transferFeeInverse,
  transferFeeMaximum,
  u8,
  u32,
  u64,
  u128,
  writable,
} from "typesol";
import { FEE_RATE_DENOMINATOR_VALUE, curveSwapBaseInput, curveSwapBaseOutput, lpTokensToTradingTokens } from "./curve";
import {
  type AmmConfig,
  type CreatorFeeShare,
  type LpChangeEvent,
  type ObservationState,
  type Permission,
  type PoolState,
  type SupportMintAssociated,
  type SwapEvent,
  CreatorFeeOn,
  ErrorCode,
} from "./state";

/** The admin (mainnet), the only signer of the configuration instructions. */
const ADMIN = pubkey("GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ");
const TOKEN_PROGRAM_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const PROTOCOL_FEE_OWNER = pubkey("ProCXqRcXJjoUd1RNoo28bSizAA6EEqt9wURZYPDc5u");
const FUND_FEE_OWNER = pubkey("FUNDduJTA7XcckKHKfAoEnnhuSud2JUCUZv6opWEjrBU");
const MAX_U128 = 340282366920938463463374607431768211455n;
const MAX_U64 = 18446744073709551615n;
const TOKEN_2022_PROGRAM_ID = pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** The keys besides the admin that may sign the permission, fee share, supported mint and lamport instructions. */
const PERMISSION_OWNER = pubkey("RayqjDRsNEFuPcDE4JpEScwJvwusmHYuNZ3MgET4D7U");
const CREATOR_FEE_SHARE_OWNER = pubkey("RayFfEhJHWToYRsr8sjVZZkdddBeYxyJazDitpdE7zJ");
const SUPPORT_MINT_OWNER = pubkey("Rayv2LG4tFSMizZhMP8aSUYxDPjV8qJtx2NQY9RKYZy");
const COLLECT_LAMPORTS = pubkey("RayGkhY93thaTgCv98sx1pNLgBHhJDxWUeZXp4bjmnp");

// ---- pool state helpers (states/pool.rs) ------------------------------------------------------------------------

/** Whether the pool allows deposits (bit 0), withdrawals (bit 1) or swaps (bit 2). */
function enabled(pool: Mut<PoolState>, bit: u64): boolean {
  return (pool.status & u8(1n << bit)) === 0n;
}

/** The vault balances without the fees owed to the protocol, fund and creator. */
function withoutFee0(pool: Mut<PoolState>, vault: u64): u64 {
  const fees = pool.protocol_fees_token_0 + pool.fund_fees_token_0 + pool.creator_fees_token_0;
  require(vault >= fees, ErrorCode.InsufficientVault);
  return vault - fees;
}
function withoutFee1(pool: Mut<PoolState>, vault: u64): u64 {
  const fees = pool.protocol_fees_token_1 + pool.fund_fees_token_1 + pool.creator_fees_token_1;
  require(vault >= fees, ErrorCode.InsufficientVault);
  return vault - fees;
}

/** Whether the creator fee is taken from the input (`zeroForOne`: token_0 in). */
function creatorFeeOnInput(pool: Mut<PoolState>, zeroForOne: boolean): boolean {
  const on = pool.creator_fee_on;
  require(on <= 2n, ErrorCode.InvalidFeeModel);
  return on === 0n || (on === 1n && zeroForOne) || (on === 2n && !zeroForOne);
}

/** Book the fees of a swap on the pool. */
function updateFees(pool: Mut<PoolState>, protocolFee: u64, fundFee: u64, creatorFee: u64, zeroForOne: boolean): void {
  if (!pool.enable_creator_fee) require(creatorFee === 0n, AnchorError.RequireEqViolated);
  const onInput = creatorFeeOnInput(pool, zeroForOne);
  if (zeroForOne) {
    pool.protocol_fees_token_0 += protocolFee;
    pool.fund_fees_token_0 += fundFee;
    if (onInput) pool.creator_fees_token_0 += creatorFee;
    else pool.creator_fees_token_1 += creatorFee;
  } else {
    pool.protocol_fees_token_1 += protocolFee;
    pool.fund_fees_token_1 += fundFee;
    if (onInput) pool.creator_fees_token_1 += creatorFee;
    else pool.creator_fees_token_0 += creatorFee;
  }
}

/** u128 addition that wraps, as the oracle's cumulative prices do. */
function wrappingAdd(a: u128, b: u128): u128 {
  return a > MAX_U128 - b ? a - (MAX_U128 - b) - 1n : a + b;
}

/** Record the price before a swap in the observation ring (states/oracle.rs). */
function observe(state: Mut<ObservationState>, blockTimestamp: u64, price0: u128, price1: u128): void {
  const index = state.observation_index;
  if (!state.initialized) {
    state.initialized = true;
    const first = state.observations.get(index);
    first.block_timestamp = blockTimestamp;
    first.cumulative_token_0_price_x32 = 0n;
    first.cumulative_token_1_price_x32 = 0n;
    state.last_update_timestamp = blockTimestamp;
    return;
  }
  const last = state.observations.get(index);
  const lastTimestamp = last.block_timestamp;
  const last0 = last.cumulative_token_0_price_x32;
  const last1 = last.cumulative_token_1_price_x32;
  const next = index === 99n ? 0n : index + 1n;
  if (state.last_update_timestamp === 0n) state.last_update_timestamp = lastTimestamp;
  const sinceObservation = blockTimestamp > lastTimestamp ? blockTimestamp - lastTimestamp : 0n;
  const sinceUpdate = blockTimestamp > state.last_update_timestamp ? blockTimestamp - state.last_update_timestamp : 0n;
  if (sinceUpdate === 0n || sinceObservation === 0n) return;
  const delta0 = price0 * u128(sinceUpdate);
  const delta1 = price1 * u128(sinceUpdate);
  if (sinceObservation < 15n) {
    last.cumulative_token_0_price_x32 = wrappingAdd(last0, delta0);
    last.cumulative_token_1_price_x32 = wrappingAdd(last1, delta1);
  } else {
    const slot = state.observations.get(next);
    slot.block_timestamp = blockTimestamp;
    slot.cumulative_token_0_price_x32 = wrappingAdd(last0, delta0);
    slot.cumulative_token_1_price_x32 = wrappingAdd(last1, delta1);
    state.observation_index = next;
  }
  state.last_update_timestamp = blockTimestamp;
}

// ---- token helpers (utils/token.rs) ------------------------------------------------------------------------------

/** The fee to add so the recipient gets `postFeeAmount` (get_transfer_inverse_fee). */
function inverseFee(mint: Mint, postFeeAmount: u64): u64 {
  if (mint.tokenProgram !== TOKEN_PROGRAM_ID) {
    require(postFeeAmount !== 0n, ErrorCode.InvalidInput);
    if (transferFeeBasisPoints(mint) === 10_000n) return transferFeeMaximum(mint);
    const fee = transferFeeInverse(mint, postFeeAmount);
    require(fee === transferFee(mint, postFeeAmount + fee), ErrorCode.TransferFeeCalculateNotMatch);
    return fee;
  }
  return 0n;
}

/** Pay out of a vault, signed by the pool authority, through the vault mint's token program. */
function fromVault(
  authority: AccountInfo,
  vault: Mut<TokenAccount>,
  to: Mut<TokenAccount>,
  mint: Mint,
  tokenProgram: TokenProgram,
  token2022: Token2022Program,
  amount: u64,
  seeds: SignerSeeds,
): void {
  if (amount === 0n) return;
  if (mint.tokenProgram === tokenProgram.key) tokenProgram.transferChecked(vault, mint, to, authority, amount, seeds);
  else token2022.transferChecked(vault, mint, to, authority, amount, seeds);
}
function toVault(
  owner: Signer,
  from: Mut<TokenAccount>,
  vault: Mut<TokenAccount>,
  mint: Mint,
  tokenProgram: TokenProgram,
  token2022: Token2022Program,
  amount: u64,
): void {
  if (amount === 0n) return;
  if (mint.tokenProgram === tokenProgram.key) tokenProgram.transferChecked(from, mint, vault, owner, amount);
  else token2022.transferChecked(from, mint, vault, owner, amount);
}

// ---- pool creation helpers (instructions/initialize.rs) ---------------------------------------------------------

/** Whether the admin listed `mint` (a SupportMintAssociated account at its PDA among the remaining accounts). */
function listed(rest: RemainingAccounts, mint: Mint): boolean {
  const expect = findProgramAddress(["support_mint", mint.key], programId());
  for (let i = 0n; i < rest.length; i++) {
    const r = rest.get(i);
    if (r.owner !== programId() || r.key !== expect) continue;
    const entry = loadAccount<SupportMintAssociated>(r);
    if (entry.mint === mint.key) return true;
  }
  return false;
}

/**
 * A Token-2022 mint is supported when its extensions are all ones the pool handles, or the admin listed it.
 */
function requireSupported(rest: RemainingAccounts, token_0_mint: Mint, token_1_mint: Mint): void {
  const listed_0 = rest.length > 0n && listed(rest, token_0_mint);
  const listed_1 = rest.length > 0n && listed(rest, token_1_mint);
  const supported_0 = token_0_mint.tokenProgram === TOKEN_PROGRAM_ID || listed_0 || extensionsWithin(token_0_mint, [1n, 18n, 19n, 10n, 25n]);
  const supported_1 = token_1_mint.tokenProgram === TOKEN_PROGRAM_ID || listed_1 || extensionsWithin(token_1_mint, [1n, 18n, 19n, 10n, 25n]);
  require(supported_0 && supported_1, ErrorCode.NotSupportMint);
}

// ---- admin ---------------------------------------------------------------------------------------------------------

/** Create a config: fee rates for the pools that use it. Admin only. */
export function createAmmConfig(
  owner: Mut<Signer>,
  amm_config: Init<AmmConfig>,
  system_program: SystemProgram,
  index: u16,
  trade_fee_rate: u64,
  protocol_fee_rate: u64,
  fund_fee_rate: u64,
  create_pool_fee: u64,
  creator_fee_rate: u64,
): void {
  constraint(owner, owner.key === ADMIN, ErrorCode.InvalidOwner);
  require(trade_fee_rate + creator_fee_rate < FEE_RATE_DENOMINATOR_VALUE, ErrorCode.InvalidInput);
  require(protocol_fee_rate <= FEE_RATE_DENOMINATOR_VALUE && fund_fee_rate + protocol_fee_rate <= FEE_RATE_DENOMINATOR_VALUE, ErrorCode.InvalidInput);
  // The seed is the index's big-endian bytes: the little-endian bytes of the swapped u16.
  const be = ((index & 0xffn) << 8n) | (index >> 8n);
  const bump = amm_config.create(owner, ["amm_config", be]);
  amm_config.protocol_owner = PROTOCOL_FEE_OWNER;
  amm_config.bump = bump;
  amm_config.disable_create_pool = false;
  amm_config.index = index;
  amm_config.trade_fee_rate = trade_fee_rate;
  amm_config.protocol_fee_rate = protocol_fee_rate;
  amm_config.fund_fee_rate = fund_fee_rate;
  amm_config.create_pool_fee = create_pool_fee;
  amm_config.fund_owner = FUND_FEE_OWNER;
  amm_config.creator_fee_rate = creator_fee_rate;
}

/** Change one setting of a config (param 0–8). Admin only. */
export function updateAmmConfig(owner: Signer, amm_config: Mut<AmmConfig>, param: u8, value: u64): void {
  constraint(owner, owner.key === ADMIN, ErrorCode.InvalidOwner);
  if (param === 0n) {
    require(value + amm_config.creator_fee_rate < FEE_RATE_DENOMINATOR_VALUE, ErrorCode.InvalidInput);
    amm_config.trade_fee_rate = value;
  } else if (param === 1n) {
    require(value <= FEE_RATE_DENOMINATOR_VALUE && value + amm_config.fund_fee_rate <= FEE_RATE_DENOMINATOR_VALUE, ErrorCode.InvalidInput);
    amm_config.protocol_fee_rate = value;
  } else if (param === 2n) {
    require(value <= FEE_RATE_DENOMINATOR_VALUE && value + amm_config.protocol_fee_rate <= FEE_RATE_DENOMINATOR_VALUE, ErrorCode.InvalidInput);
    amm_config.fund_fee_rate = value;
  } else if (param === 3n || param === 4n) {
    const next = remainingAccounts().get(0n).key;
    require(next !== pubkey("11111111111111111111111111111111"), AnchorError.RequireKeysNeqViolated);
    if (param === 3n) amm_config.protocol_owner = next;
    else amm_config.fund_owner = next;
  } else if (param === 5n) amm_config.create_pool_fee = value;
  else if (param === 6n) amm_config.disable_create_pool = value !== 0n;
  else if (param === 7n) {
    require(value + amm_config.trade_fee_rate < FEE_RATE_DENOMINATOR_VALUE, ErrorCode.InvalidInput);
    amm_config.creator_fee_rate = value;
  } else if (param === 8n) {
    require(value <= FEE_RATE_DENOMINATOR_VALUE, ErrorCode.InvalidInput);
    amm_config.creator_fee_share_rate = value;
  } else require(false, ErrorCode.InvalidInput);
}

/** Update the pool status: bit0 disables deposit, bit1 withdraw, bit2 swap. */
export function updatePoolStatus(authority: Address<Signer, "GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ">, pool_state: Mut<PoolState>, status: u8): void {
  pool_state.status = status;
  pool_state.recent_epoch = currentEpoch();
}

// ---- pools -----------------------------------------------------------------------------------------------------------

/**
 * Create a pool of two mints (token_0 < token_1) with its first liquidity. The pool account is the PDA
 * ["pool", amm_config, token_0_mint, token_1_mint] or any keypair that signs, created here; the LP mint, the creator's
 * LP account and the observation account are created first, as Anchor's `init` does before the body.
 */
export function initialize(
  creator: Mut<Signer>,
  amm_config: Account<AmmConfig>,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  pool_state: Mut<AccountInfo>,
  token_0_mint: MintOf<Mint, never, never, "token_0_program">,
  token_1_mint: MintOf<Mint, never, never, "token_1_program">,
  lp_mint: Init<Mint>,
  creator_token_0: TokenOf<Mut<TokenAccount>, "token_0_mint", "creator">,
  creator_token_1: TokenOf<Mut<TokenAccount>, "token_1_mint", "creator">,
  creator_lp_token: Ata<Init<TokenAccount>, "creator", "lp_mint">,
  token_0_vault: Init<TokenAccount>,
  token_1_vault: Init<TokenAccount>,
  create_pool_fee: Address<Mut<TokenAccount>, "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8">,
  observation_state: Init<ObservationState>,
  token_program: TokenProgram,
  token_0_program: TokenInterface,
  token_1_program: TokenInterface,
  associated_token_program: AssociatedTokenProgram,
  system_program: SystemProgram,
  rent: AccountInfo,
  init_amount_0: u64,
  init_amount_1: u64,
  open_time: u64,
): void {
  constraint(token_0_mint, token_0_mint.key.compare(token_1_mint.key) < 0n);
  constraint(rent, rent.key === pubkey("SysvarRent111111111111111111111111111111111"), AnchorError.AccountSysvarMismatch);
  lp_mint.create(creator, ["pool_lp_mint", pool_state.key], 9n, authority.key, null, token_program);
  creator_lp_token.create(creator, token_program);
  observation_state.create(creator, ["observation", pool_state.key]);

  requireSupported(remainingAccounts(), token_0_mint, token_1_mint);
  require(!amm_config.disable_create_pool, ErrorCode.NotApproved);
  const block_timestamp = u64(now());
  const opens = open_time <= block_timestamp ? block_timestamp + 1n : open_time;

  token_0_vault.create(creator, ["pool_vault", pool_state.key, token_0_mint.key], token_0_mint, authority.key, token_0_program);
  token_1_vault.create(creator, ["pool_vault", pool_state.key, token_1_mint.key], token_1_mint, authority.key, token_1_program);

  // The pool account: owned by the System Program until now, at its PDA or a keypair that signed.
  require(pool_state.owner === pubkey("11111111111111111111111111111111"), ErrorCode.NotApproved);
  const pool_bump = findProgramAddressBump(["pool", amm_config.key, token_0_mint.key, token_1_mint.key], programId());
  if (pool_state.key !== findProgramAddress(["pool", amm_config.key, token_0_mint.key, token_1_mint.key], programId()))
    require(pool_state.isSigner, AnchorError.RequireEqViolated);
  const space = 637n;
  if (pool_state.lamports === 0n)
    system_program.createAccount(creator, pool_state, rentExempt(space), space, programId(), [
      "pool",
      amm_config.key,
      token_0_mint.key,
      token_1_mint.key,
      pool_bump,
    ]);
  else {
    let required = rentExempt(space);
    if (required === 0n) required = 1n;
    if (required > pool_state.lamports) system_program.transfer(creator, pool_state, required - pool_state.lamports);
    system_program.allocate(pool_state, space, ["pool", amm_config.key, token_0_mint.key, token_1_mint.key, pool_bump]);
    system_program.assign(pool_state, programId(), ["pool", amm_config.key, token_0_mint.key, token_1_mint.key, pool_bump]);
  }
  const pool = initAccount<PoolState>(pool_state);
  observation_state.pool_id = pool_state.key;

  if (init_amount_0 !== 0n) token_0_program.transferChecked(creator_token_0, token_0_mint, token_0_vault, creator, init_amount_0);
  if (init_amount_1 !== 0n) token_1_program.transferChecked(creator_token_1, token_1_mint, token_1_vault, creator, init_amount_1);
  const vault_0 = token_0_vault.amount;
  const vault_1 = token_1_vault.amount;
  require(vault_0 !== 0n && vault_1 !== 0n, ErrorCode.EmptySupply);
  const liquidity = u64(isqrt(u128(vault_0) * u128(vault_1)));
  log(`liquidity:${liquidity}, lock_lp_amount:100, vault_0_amount:${vault_0},vault_1_amount:${vault_1}`);
  require(liquidity >= 100n, ErrorCode.InitLpAmountTooLess);
  token_program.mintTo(lp_mint, creator_lp_token, authority, liquidity - 100n, ["vault_and_lp_mint_auth_seed", authority.pdaBump]);
  // The fee to create a pool, in wrapped SOL.
  if (amm_config.create_pool_fee !== 0n) {
    system_program.transfer(creator, create_pool_fee, amm_config.create_pool_fee);
    token_program.syncNative(create_pool_fee);
  }
  pool.auth_bump = authority.pdaBump;
  pool.lp_supply = liquidity;
  pool.open_time = opens;
  pool.pool_creator = creator.key;
  pool.amm_config = amm_config.key;
  pool.token_0_vault = token_0_vault.key;
  pool.token_1_vault = token_1_vault.key;
  pool.lp_mint = lp_mint.key;
  pool.token_0_mint = token_0_mint.key;
  pool.token_1_mint = token_1_mint.key;
  pool.token_0_program = token_0_mint.tokenProgram;
  pool.token_1_program = token_1_mint.tokenProgram;
  pool.observation_key = observation_state.key;
  pool.lp_mint_decimals = 9n;
  pool.mint_0_decimals = token_0_mint.decimals;
  pool.mint_1_decimals = token_1_mint.decimals;
  pool.recent_epoch = currentEpoch();
  pool.creator_fee_on = 0n;
  pool.enable_creator_fee = false;
}

/** The byte a CreatorFeeOn is stored as. */
function feeOn(on: CreatorFeeOn): u8 {
  return on === CreatorFeeOn.OnlyToken0 ? 1n : on === CreatorFeeOn.OnlyToken1 ? 2n : 0n;
}

/**
 * initialize without the rent sysvar, choosing the creator fee: `creator_fee_on` null leaves it off, otherwise it is on
 * and taken as it says.
 */
export function initializeV2(
  creator: Mut<Signer>,
  amm_config: Account<AmmConfig>,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  pool_state: Mut<AccountInfo>,
  token_0_mint: MintOf<Mint, never, never, "token_0_program">,
  token_1_mint: MintOf<Mint, never, never, "token_1_program">,
  lp_mint: Init<Mint>,
  creator_token_0: TokenOf<Mut<TokenAccount>, "token_0_mint", "creator">,
  creator_token_1: TokenOf<Mut<TokenAccount>, "token_1_mint", "creator">,
  creator_lp_token: Ata<Init<TokenAccount>, "creator", "lp_mint">,
  token_0_vault: Init<TokenAccount>,
  token_1_vault: Init<TokenAccount>,
  create_pool_fee: Address<Mut<TokenAccount>, "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8">,
  observation_state: Init<ObservationState>,
  token_program: TokenProgram,
  token_0_program: TokenInterface,
  token_1_program: TokenInterface,
  associated_token_program: AssociatedTokenProgram,
  system_program: SystemProgram,
  init_amount_0: u64,
  init_amount_1: u64,
  open_time: u64,
  creator_fee_on: Option<CreatorFeeOn>,
): void {
  constraint(token_0_mint, token_0_mint.key.compare(token_1_mint.key) < 0n);
  lp_mint.create(creator, ["pool_lp_mint", pool_state.key], 9n, authority.key, null, token_program);
  creator_lp_token.create(creator, token_program);
  observation_state.create(creator, ["observation", pool_state.key]);

  requireSupported(remainingAccounts(), token_0_mint, token_1_mint);
  require(!amm_config.disable_create_pool, ErrorCode.NotApproved);
  const block_timestamp = u64(now());
  const opens = open_time <= block_timestamp ? block_timestamp + 1n : open_time;

  token_0_vault.create(creator, ["pool_vault", pool_state.key, token_0_mint.key], token_0_mint, authority.key, token_0_program);
  token_1_vault.create(creator, ["pool_vault", pool_state.key, token_1_mint.key], token_1_mint, authority.key, token_1_program);

  // The pool account: owned by the System Program until now, at its PDA or a keypair that signed.
  require(pool_state.owner === pubkey("11111111111111111111111111111111"), ErrorCode.NotApproved);
  const pool_bump = findProgramAddressBump(["pool", amm_config.key, token_0_mint.key, token_1_mint.key], programId());
  if (pool_state.key !== findProgramAddress(["pool", amm_config.key, token_0_mint.key, token_1_mint.key], programId()))
    require(pool_state.isSigner, AnchorError.RequireEqViolated);
  const space = 637n;
  if (pool_state.lamports === 0n)
    system_program.createAccount(creator, pool_state, rentExempt(space), space, programId(), [
      "pool",
      amm_config.key,
      token_0_mint.key,
      token_1_mint.key,
      pool_bump,
    ]);
  else {
    let required = rentExempt(space);
    if (required === 0n) required = 1n;
    if (required > pool_state.lamports) system_program.transfer(creator, pool_state, required - pool_state.lamports);
    system_program.allocate(pool_state, space, ["pool", amm_config.key, token_0_mint.key, token_1_mint.key, pool_bump]);
    system_program.assign(pool_state, programId(), ["pool", amm_config.key, token_0_mint.key, token_1_mint.key, pool_bump]);
  }
  const pool = initAccount<PoolState>(pool_state);
  observation_state.pool_id = pool_state.key;

  if (init_amount_0 !== 0n) token_0_program.transferChecked(creator_token_0, token_0_mint, token_0_vault, creator, init_amount_0);
  if (init_amount_1 !== 0n) token_1_program.transferChecked(creator_token_1, token_1_mint, token_1_vault, creator, init_amount_1);
  const vault_0 = token_0_vault.amount;
  const vault_1 = token_1_vault.amount;
  require(vault_0 !== 0n && vault_1 !== 0n, ErrorCode.EmptySupply);
  const liquidity = u64(isqrt(u128(vault_0) * u128(vault_1)));
  log(`liquidity:${liquidity}, lock_lp_amount:100, vault_0_amount:${vault_0},vault_1_amount:${vault_1}`);
  require(liquidity >= 100n, ErrorCode.InitLpAmountTooLess);
  token_program.mintTo(lp_mint, creator_lp_token, authority, liquidity - 100n, ["vault_and_lp_mint_auth_seed", authority.pdaBump]);
  // The fee to create a pool, in wrapped SOL.
  if (amm_config.create_pool_fee !== 0n) {
    system_program.transfer(creator, create_pool_fee, amm_config.create_pool_fee);
    token_program.syncNative(create_pool_fee);
  }
  pool.auth_bump = authority.pdaBump;
  pool.lp_supply = liquidity;
  pool.open_time = opens;
  pool.pool_creator = creator.key;
  pool.amm_config = amm_config.key;
  pool.token_0_vault = token_0_vault.key;
  pool.token_1_vault = token_1_vault.key;
  pool.lp_mint = lp_mint.key;
  pool.token_0_mint = token_0_mint.key;
  pool.token_1_mint = token_1_mint.key;
  pool.token_0_program = token_0_mint.tokenProgram;
  pool.token_1_program = token_1_mint.tokenProgram;
  pool.observation_key = observation_state.key;
  pool.lp_mint_decimals = 9n;
  pool.mint_0_decimals = token_0_mint.decimals;
  pool.mint_1_decimals = token_1_mint.decimals;
  pool.recent_epoch = currentEpoch();
  pool.creator_fee_on = creator_fee_on === null ? 0n : feeOn(creator_fee_on);
  pool.enable_creator_fee = creator_fee_on !== null;
}

/**
 * A pool created by a payer holding a Permission (created by Raydium), for `creator`: the payer funds it and gets the
 * LP tokens, `creator` collects the creator fee, which is always on.
 */
export function initializeWithPermission(
  payer: Mut<Signer>,
  creator: AccountInfo,
  amm_config: Account<AmmConfig>,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  pool_state: Mut<AccountInfo>,
  token_0_mint: MintOf<Mint, never, never, "token_0_program">,
  token_1_mint: MintOf<Mint, never, never, "token_1_program">,
  lp_mint: Init<Mint>,
  payer_token_0: TokenOf<Mut<TokenAccount>, "token_0_mint", "payer">,
  payer_token_1: TokenOf<Mut<TokenAccount>, "token_1_mint", "payer">,
  payer_lp_token: Ata<Init<TokenAccount>, "payer", "lp_mint">,
  token_0_vault: Init<TokenAccount>,
  token_1_vault: Init<TokenAccount>,
  create_pool_fee: Address<Mut<TokenAccount>, "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8">,
  observation_state: Init<ObservationState>,
  permission: Seeds<Account<Permission>, ["permission", "@payer"]>,
  token_program: TokenProgram,
  token_0_program: TokenInterface,
  token_1_program: TokenInterface,
  associated_token_program: AssociatedTokenProgram,
  system_program: SystemProgram,
  init_amount_0: u64,
  init_amount_1: u64,
  open_time: u64,
  creator_fee_on: CreatorFeeOn,
): void {
  constraint(token_0_mint, token_0_mint.key.compare(token_1_mint.key) < 0n);
  lp_mint.create(payer, ["pool_lp_mint", pool_state.key], 9n, authority.key, null, token_program);
  payer_lp_token.create(payer, token_program);
  observation_state.create(payer, ["observation", pool_state.key]);

  requireSupported(remainingAccounts(), token_0_mint, token_1_mint);
  require(!amm_config.disable_create_pool, ErrorCode.NotApproved);
  const block_timestamp = u64(now());
  const opens = open_time <= block_timestamp ? block_timestamp + 1n : open_time;

  token_0_vault.create(payer, ["pool_vault", pool_state.key, token_0_mint.key], token_0_mint, authority.key, token_0_program);
  token_1_vault.create(payer, ["pool_vault", pool_state.key, token_1_mint.key], token_1_mint, authority.key, token_1_program);

  // The pool account: owned by the System Program until now, at its PDA or a keypair that signed.
  require(pool_state.owner === pubkey("11111111111111111111111111111111"), ErrorCode.NotApproved);
  const pool_bump = findProgramAddressBump(["pool", amm_config.key, token_0_mint.key, token_1_mint.key], programId());
  if (pool_state.key !== findProgramAddress(["pool", amm_config.key, token_0_mint.key, token_1_mint.key], programId()))
    require(pool_state.isSigner, AnchorError.RequireEqViolated);
  const space = 637n;
  if (pool_state.lamports === 0n)
    system_program.createAccount(payer, pool_state, rentExempt(space), space, programId(), [
      "pool",
      amm_config.key,
      token_0_mint.key,
      token_1_mint.key,
      pool_bump,
    ]);
  else {
    let required = rentExempt(space);
    if (required === 0n) required = 1n;
    if (required > pool_state.lamports) system_program.transfer(payer, pool_state, required - pool_state.lamports);
    system_program.allocate(pool_state, space, ["pool", amm_config.key, token_0_mint.key, token_1_mint.key, pool_bump]);
    system_program.assign(pool_state, programId(), ["pool", amm_config.key, token_0_mint.key, token_1_mint.key, pool_bump]);
  }
  const pool = initAccount<PoolState>(pool_state);
  observation_state.pool_id = pool_state.key;

  if (init_amount_0 !== 0n) token_0_program.transferChecked(payer_token_0, token_0_mint, token_0_vault, payer, init_amount_0);
  if (init_amount_1 !== 0n) token_1_program.transferChecked(payer_token_1, token_1_mint, token_1_vault, payer, init_amount_1);
  const vault_0 = token_0_vault.amount;
  const vault_1 = token_1_vault.amount;
  require(vault_0 !== 0n && vault_1 !== 0n, ErrorCode.EmptySupply);
  const liquidity = u64(isqrt(u128(vault_0) * u128(vault_1)));
  log(`liquidity:${liquidity}, lock_lp_amount:100, vault_0_amount:${vault_0},vault_1_amount:${vault_1}`);
  require(liquidity >= 100n, ErrorCode.InitLpAmountTooLess);
  token_program.mintTo(lp_mint, payer_lp_token, authority, liquidity - 100n, ["vault_and_lp_mint_auth_seed", authority.pdaBump]);
  // The fee to create a pool, in wrapped SOL.
  if (amm_config.create_pool_fee !== 0n) {
    system_program.transfer(payer, create_pool_fee, amm_config.create_pool_fee);
    token_program.syncNative(create_pool_fee);
  }
  pool.auth_bump = authority.pdaBump;
  pool.lp_supply = liquidity;
  pool.open_time = opens;
  pool.pool_creator = creator.key;
  pool.amm_config = amm_config.key;
  pool.token_0_vault = token_0_vault.key;
  pool.token_1_vault = token_1_vault.key;
  pool.lp_mint = lp_mint.key;
  pool.token_0_mint = token_0_mint.key;
  pool.token_1_mint = token_1_mint.key;
  pool.token_0_program = token_0_mint.tokenProgram;
  pool.token_1_program = token_1_mint.tokenProgram;
  pool.observation_key = observation_state.key;
  pool.lp_mint_decimals = 9n;
  pool.mint_0_decimals = token_0_mint.decimals;
  pool.mint_1_decimals = token_1_mint.decimals;
  pool.recent_epoch = currentEpoch();
  pool.creator_fee_on = feeOn(creator_fee_on);
  pool.enable_creator_fee = true;
}

// ---- liquidity -------------------------------------------------------------------------------------------------------

export function deposit(
  owner: Signer,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  pool_state: Mut<PoolState>,
  owner_lp_token: Mut<TokenAccount>,
  token_0_account: Mut<TokenAccount>,
  token_1_account: Mut<TokenAccount>,
  token_0_vault: Mut<TokenAccount>,
  token_1_vault: Mut<TokenAccount>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  lp_mint: Mut<Mint>,
  lp_token_amount: u64,
  maximum_token_0_amount: u64,
  maximum_token_1_amount: u64,
): void {
  constraint(owner_lp_token, owner_lp_token.owner === owner.key, AnchorError.ConstraintTokenOwner);
  constraint(token_0_account, token_0_account.owner === owner.key, AnchorError.ConstraintTokenOwner);
  constraint(token_0_account, token_0_account.mint === token_0_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(token_1_account, token_1_account.owner === owner.key, AnchorError.ConstraintTokenOwner);
  constraint(token_1_account, token_1_account.mint === token_1_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(token_0_vault, token_0_vault.key === pool_state.token_0_vault);
  constraint(token_1_vault, token_1_vault.key === pool_state.token_1_vault);
  constraint(vault_0_mint, vault_0_mint.key === token_0_vault.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_1_vault.mint, AnchorError.ConstraintAddress);
  constraint(lp_mint, lp_mint.key === pool_state.lp_mint, ErrorCode.IncorrectLpMint);
  require(lp_token_amount > 0n, AnchorError.RequireGtViolated);
  require(enabled(pool_state, 0n), ErrorCode.NotApproved);
  const total_0 = withoutFee0(pool_state, token_0_vault.amount);
  const total_1 = withoutFee1(pool_state, token_1_vault.amount);
  const results = lpTokensToTradingTokens(u128(lp_token_amount), u128(pool_state.lp_supply), u128(total_0), u128(total_1), true);
  require(results.token_0_amount !== 0n && results.token_1_amount !== 0n, ErrorCode.ZeroTradingTokens);
  const token_0_amount = u64(results.token_0_amount);
  const fee_0 = inverseFee(vault_0_mint, token_0_amount);
  const transfer_0 = token_0_amount + fee_0;
  const token_1_amount = u64(results.token_1_amount);
  const fee_1 = inverseFee(vault_1_mint, token_1_amount);
  const transfer_1 = token_1_amount + fee_1;
  emit<LpChangeEvent>({
    pool_id: pool_state.key,
    lp_amount_before: pool_state.lp_supply,
    token_0_vault_before: total_0,
    token_1_vault_before: total_1,
    token_0_amount,
    token_1_amount,
    token_0_transfer_fee: fee_0,
    token_1_transfer_fee: fee_1,
    change_type: 0n,
  });
  require(transfer_0 <= maximum_token_0_amount && transfer_1 <= maximum_token_1_amount, ErrorCode.ExceededSlippage);
  toVault(owner, token_0_account, token_0_vault, vault_0_mint, token_program, token_program_2022, transfer_0);
  toVault(owner, token_1_account, token_1_vault, vault_1_mint, token_program, token_program_2022, transfer_1);
  pool_state.lp_supply += lp_token_amount;
  token_program.mintTo(lp_mint, owner_lp_token, authority, lp_token_amount, ["vault_and_lp_mint_auth_seed", pool_state.auth_bump]);
  pool_state.recent_epoch = currentEpoch();
}

export function withdraw(
  owner: Signer,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  pool_state: Mut<PoolState>,
  owner_lp_token: Mut<TokenAccount>,
  token_0_account: Mut<TokenAccount>,
  token_1_account: Mut<TokenAccount>,
  token_0_vault: Mut<TokenAccount>,
  token_1_vault: Mut<TokenAccount>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  lp_mint: Mut<Mint>,
  memo_program: Address<AccountInfo, "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr">,
  lp_token_amount: u64,
  minimum_token_0_amount: u64,
  minimum_token_1_amount: u64,
): void {
  constraint(owner_lp_token, owner_lp_token.owner === owner.key, AnchorError.ConstraintTokenOwner);
  constraint(token_0_account, token_0_account.mint === token_0_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(token_1_account, token_1_account.mint === token_1_vault.mint, AnchorError.ConstraintTokenMint);
  constraint(token_0_vault, token_0_vault.key === pool_state.token_0_vault);
  constraint(token_1_vault, token_1_vault.key === pool_state.token_1_vault);
  constraint(vault_0_mint, vault_0_mint.key === token_0_vault.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_1_vault.mint, AnchorError.ConstraintAddress);
  constraint(lp_mint, lp_mint.key === pool_state.lp_mint, ErrorCode.IncorrectLpMint);
  require(lp_token_amount > 0n, AnchorError.RequireGtViolated);
  require(owner_lp_token.amount >= lp_token_amount, AnchorError.RequireGteViolated);
  require(enabled(pool_state, 1n), ErrorCode.NotApproved);
  const total_0 = withoutFee0(pool_state, token_0_vault.amount);
  const total_1 = withoutFee1(pool_state, token_1_vault.amount);
  const results = lpTokensToTradingTokens(u128(lp_token_amount), u128(pool_state.lp_supply), u128(total_0), u128(total_1), false);
  require(results.token_0_amount !== 0n && results.token_1_amount !== 0n, ErrorCode.ZeroTradingTokens);
  let token_0_amount = u64(results.token_0_amount);
  if (total_0 < token_0_amount) token_0_amount = total_0;
  const fee_0 = transferFee(vault_0_mint, token_0_amount);
  const receive_0 = token_0_amount - fee_0;
  let token_1_amount = u64(results.token_1_amount);
  if (total_1 < token_1_amount) token_1_amount = total_1;
  const fee_1 = transferFee(vault_1_mint, token_1_amount);
  const receive_1 = token_1_amount - fee_1;
  emit<LpChangeEvent>({
    pool_id: pool_state.key,
    lp_amount_before: pool_state.lp_supply,
    token_0_vault_before: total_0,
    token_1_vault_before: total_1,
    token_0_amount: receive_0,
    token_1_amount: receive_1,
    token_0_transfer_fee: fee_0,
    token_1_transfer_fee: fee_1,
    change_type: 1n,
  });
  require(receive_0 >= minimum_token_0_amount && receive_1 >= minimum_token_1_amount, ErrorCode.ExceededSlippage);
  pool_state.lp_supply -= lp_token_amount;
  token_program.burn(owner_lp_token, lp_mint, owner, lp_token_amount, ["vault_and_lp_mint_auth_seed", pool_state.auth_bump]);
  fromVault(
    authority,
    token_0_vault,
    token_0_account,
    vault_0_mint,
    token_program,
    token_program_2022,
    token_0_amount,
    signer(["vault_and_lp_mint_auth_seed", pool_state.auth_bump]),
  );
  fromVault(
    authority,
    token_1_vault,
    token_1_account,
    vault_1_mint,
    token_program,
    token_program_2022,
    token_1_amount,
    signer(["vault_and_lp_mint_auth_seed", pool_state.auth_bump]),
  );
  pool_state.recent_epoch = currentEpoch();
}

// ---- swaps -----------------------------------------------------------------------------------------------------------

export function swapBaseInput(
  payer: Signer,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  amm_config: Account<AmmConfig>,
  pool_state: Mut<PoolState>,
  input_token_account: Mut<TokenAccount>,
  output_token_account: Mut<TokenAccount>,
  input_vault: Mut<TokenAccount>,
  output_vault: Mut<TokenAccount>,
  input_token_program: TokenInterface,
  output_token_program: TokenInterface,
  input_token_mint: Mint,
  output_token_mint: Mint,
  observation_state: Mut<ObservationState>,
  amount_in: u64,
  minimum_amount_out: u64,
): void {
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  constraint(input_vault, input_vault.key === pool_state.token_0_vault || input_vault.key === pool_state.token_1_vault);
  constraint(output_vault, output_vault.key === pool_state.token_0_vault || output_vault.key === pool_state.token_1_vault);
  constraint(input_token_mint, input_token_mint.key === input_vault.mint, AnchorError.ConstraintAddress);
  constraint(output_token_mint, output_token_mint.key === output_vault.mint, AnchorError.ConstraintAddress);
  constraint(observation_state, observation_state.key === pool_state.observation_key, AnchorError.ConstraintAddress);
  const block_timestamp = u64(now());
  require(enabled(pool_state, 2n) && block_timestamp >= pool_state.open_time, ErrorCode.NotApproved);
  const transfer_fee = transferFee(input_token_mint, amount_in);
  const actual_amount_in = amount_in > transfer_fee ? amount_in - transfer_fee : 0n;
  require(actual_amount_in > 0n, AnchorError.RequireGtViolated);
  const params = swapParams(pool_state, input_vault, output_vault);
  const constant_before = u128(params.total_input) * u128(params.total_output);
  const creator_fee_rate = pool_state.enable_creator_fee ? amm_config.creator_fee_rate : 0n;
  const result = curveSwapBaseInput(
    u128(actual_amount_in),
    u128(params.total_input),
    u128(params.total_output),
    amm_config.trade_fee_rate,
    creator_fee_rate,
    amm_config.protocol_fee_rate,
    amm_config.fund_fee_rate,
    params.creator_fee_on_input,
  );
  const constant_after = result.new_input_vault_amount * result.new_output_vault_amount;
  require(u64(result.input_amount) === actual_amount_in, AnchorError.RequireEqViolated);
  const amount_out = u64(result.output_amount);
  const output_transfer_fee = transferFee(output_token_mint, amount_out);
  const amount_received = amount_out - output_transfer_fee;
  require(amount_received > 0n, AnchorError.RequireGtViolated);
  require(amount_received >= minimum_amount_out, ErrorCode.ExceededSlippage);
  updateFees(pool_state, u64(result.protocol_fee), u64(result.fund_fee), u64(result.creator_fee), params.zero_for_one);
  emit<SwapEvent>({
    pool_id: pool_state.key,
    input_vault_before: params.total_input,
    output_vault_before: params.total_output,
    input_amount: u64(result.input_amount),
    output_amount: u64(result.output_amount),
    input_transfer_fee: transfer_fee,
    output_transfer_fee,
    base_input: true,
    input_mint: input_token_mint.key,
    output_mint: output_token_mint.key,
    trade_fee: u64(result.trade_fee),
    creator_fee: u64(result.creator_fee),
    creator_fee_on_input: params.creator_fee_on_input,
  });
  require(constant_after >= constant_before, AnchorError.RequireGteViolated);
  input_token_program.transferChecked(input_token_account, input_token_mint, input_vault, payer, amount_in);
  if (amount_out !== 0n)
    output_token_program.transferChecked(output_vault, output_token_mint, output_token_account, authority, amount_out, [
      "vault_and_lp_mint_auth_seed",
      pool_state.auth_bump,
    ]);
  observe(observation_state, u64(now()), params.price_0, params.price_1);
  pool_state.recent_epoch = currentEpoch();
}

export function swapBaseOutput(
  payer: Signer,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  amm_config: Account<AmmConfig>,
  pool_state: Mut<PoolState>,
  input_token_account: Mut<TokenAccount>,
  output_token_account: Mut<TokenAccount>,
  input_vault: Mut<TokenAccount>,
  output_vault: Mut<TokenAccount>,
  input_token_program: TokenInterface,
  output_token_program: TokenInterface,
  input_token_mint: Mint,
  output_token_mint: Mint,
  observation_state: Mut<ObservationState>,
  max_amount_in: u64,
  amount_out: u64,
): void {
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  constraint(input_vault, input_vault.key === pool_state.token_0_vault || input_vault.key === pool_state.token_1_vault);
  constraint(output_vault, output_vault.key === pool_state.token_0_vault || output_vault.key === pool_state.token_1_vault);
  constraint(input_token_mint, input_token_mint.key === input_vault.mint, AnchorError.ConstraintAddress);
  constraint(output_token_mint, output_token_mint.key === output_vault.mint, AnchorError.ConstraintAddress);
  constraint(observation_state, observation_state.key === pool_state.observation_key, AnchorError.ConstraintAddress);
  require(amount_out > 0n, AnchorError.RequireGtViolated);
  const block_timestamp = u64(now());
  require(enabled(pool_state, 2n) && block_timestamp >= pool_state.open_time, ErrorCode.NotApproved);
  const out_transfer_fee = inverseFee(output_token_mint, amount_out);
  const amount_out_with_transfer_fee = amount_out + out_transfer_fee;
  const params = swapParams(pool_state, input_vault, output_vault);
  const constant_before = u128(params.total_input) * u128(params.total_output);
  const creator_fee_rate = pool_state.enable_creator_fee ? amm_config.creator_fee_rate : 0n;
  const result = curveSwapBaseOutput(
    u128(amount_out_with_transfer_fee),
    u128(params.total_input),
    u128(params.total_output),
    amm_config.trade_fee_rate,
    creator_fee_rate,
    amm_config.protocol_fee_rate,
    amm_config.fund_fee_rate,
    params.creator_fee_on_input,
  );
  const constant_after = result.new_input_vault_amount * result.new_output_vault_amount;
  const input_amount = u64(result.input_amount);
  require(input_amount > 0n, AnchorError.RequireGtViolated);
  const input_transfer_fee = inverseFee(input_token_mint, input_amount);
  const input_transfer_amount = input_amount + input_transfer_fee;
  require(max_amount_in >= input_transfer_amount, ErrorCode.ExceededSlippage);
  require(u64(result.output_amount) === amount_out_with_transfer_fee, AnchorError.RequireEqViolated);
  updateFees(pool_state, u64(result.protocol_fee), u64(result.fund_fee), u64(result.creator_fee), params.zero_for_one);
  emit<SwapEvent>({
    pool_id: pool_state.key,
    input_vault_before: params.total_input,
    output_vault_before: params.total_output,
    input_amount: u64(result.input_amount),
    output_amount: u64(result.output_amount),
    input_transfer_fee,
    output_transfer_fee: out_transfer_fee,
    base_input: false,
    input_mint: input_token_mint.key,
    output_mint: output_token_mint.key,
    trade_fee: u64(result.trade_fee),
    creator_fee: u64(result.creator_fee),
    creator_fee_on_input: params.creator_fee_on_input,
  });
  require(constant_after >= constant_before, AnchorError.RequireGteViolated);
  input_token_program.transferChecked(input_token_account, input_token_mint, input_vault, payer, input_transfer_amount);
  output_token_program.transferChecked(output_vault, output_token_mint, output_token_account, authority, amount_out_with_transfer_fee, [
    "vault_and_lp_mint_auth_seed",
    pool_state.auth_bump,
  ]);
  observe(observation_state, u64(now()), params.price_0, params.price_1);
  pool_state.recent_epoch = currentEpoch();
}

export interface SwapParams {
  zero_for_one: boolean;
  total_input: u64;
  total_output: u64;
  price_0: u128;
  price_1: u128;
  creator_fee_on_input: boolean;
}

/** The direction, the vault amounts without fees and the prices before the swap (PoolState::get_swap_params). */
function swapParams(pool: Mut<PoolState>, input_vault: Mut<TokenAccount>, output_vault: Mut<TokenAccount>): SwapParams {
  const zero_for_one = input_vault.key === pool.token_0_vault && output_vault.key === pool.token_1_vault;
  require(zero_for_one || (input_vault.key === pool.token_1_vault && output_vault.key === pool.token_0_vault), ErrorCode.InvalidVault);
  const vault_0 = zero_for_one ? input_vault.amount : output_vault.amount;
  const vault_1 = zero_for_one ? output_vault.amount : input_vault.amount;
  const amount_0 = withoutFee0(pool, vault_0);
  const amount_1 = withoutFee1(pool, vault_1);
  return {
    zero_for_one,
    total_input: zero_for_one ? amount_0 : amount_1,
    total_output: zero_for_one ? amount_1 : amount_0,
    price_0: (u128(amount_1) * 4294967296n) / u128(amount_0),
    price_1: (u128(amount_0) * 4294967296n) / u128(amount_1),
    creator_fee_on_input: creatorFeeOnInput(pool, zero_for_one),
  };
}

// ---- fees ----------------------------------------------------------------------------------------------------------

export function collectProtocolFee(
  owner: Signer,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  pool_state: Mut<PoolState>,
  amm_config: Account<AmmConfig>,
  token_0_vault: Mut<TokenAccount>,
  token_1_vault: Mut<TokenAccount>,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  recipient_token_0_account: Mut<TokenAccount>,
  recipient_token_1_account: Mut<TokenAccount>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  amount_0_requested: u64,
  amount_1_requested: u64,
): void {
  constraint(owner, owner.key === amm_config.protocol_owner || owner.key === ADMIN, ErrorCode.InvalidOwner);
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  constraint(token_0_vault, token_0_vault.key === pool_state.token_0_vault);
  constraint(token_1_vault, token_1_vault.key === pool_state.token_1_vault);
  constraint(vault_0_mint, vault_0_mint.key === token_0_vault.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_1_vault.mint, AnchorError.ConstraintAddress);
  const amount_0 = amount_0_requested < pool_state.protocol_fees_token_0 ? amount_0_requested : pool_state.protocol_fees_token_0;
  const amount_1 = amount_1_requested < pool_state.protocol_fees_token_1 ? amount_1_requested : pool_state.protocol_fees_token_1;
  pool_state.protocol_fees_token_0 -= amount_0;
  pool_state.protocol_fees_token_1 -= amount_1;
  pool_state.recent_epoch = currentEpoch();
  fromVault(
    authority,
    token_0_vault,
    recipient_token_0_account,
    vault_0_mint,
    token_program,
    token_program_2022,
    amount_0,
    signer(["vault_and_lp_mint_auth_seed", pool_state.auth_bump]),
  );
  fromVault(
    authority,
    token_1_vault,
    recipient_token_1_account,
    vault_1_mint,
    token_program,
    token_program_2022,
    amount_1,
    signer(["vault_and_lp_mint_auth_seed", pool_state.auth_bump]),
  );
}

export function collectFundFee(
  owner: Signer,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  pool_state: Mut<PoolState>,
  amm_config: Account<AmmConfig>,
  token_0_vault: Mut<TokenAccount>,
  token_1_vault: Mut<TokenAccount>,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  recipient_token_0_account: Mut<TokenAccount>,
  recipient_token_1_account: Mut<TokenAccount>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  amount_0_requested: u64,
  amount_1_requested: u64,
): void {
  constraint(owner, owner.key === amm_config.fund_owner || owner.key === ADMIN, ErrorCode.InvalidOwner);
  constraint(amm_config, amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  constraint(token_0_vault, token_0_vault.key === pool_state.token_0_vault);
  constraint(token_1_vault, token_1_vault.key === pool_state.token_1_vault);
  constraint(vault_0_mint, vault_0_mint.key === token_0_vault.mint, AnchorError.ConstraintAddress);
  constraint(vault_1_mint, vault_1_mint.key === token_1_vault.mint, AnchorError.ConstraintAddress);
  const amount_0 = amount_0_requested < pool_state.fund_fees_token_0 ? amount_0_requested : pool_state.fund_fees_token_0;
  const amount_1 = amount_1_requested < pool_state.fund_fees_token_1 ? amount_1_requested : pool_state.fund_fees_token_1;
  pool_state.fund_fees_token_0 -= amount_0;
  pool_state.fund_fees_token_1 -= amount_1;
  pool_state.recent_epoch = currentEpoch();
  fromVault(
    authority,
    token_0_vault,
    recipient_token_0_account,
    vault_0_mint,
    token_program,
    token_program_2022,
    amount_0,
    signer(["vault_and_lp_mint_auth_seed", pool_state.auth_bump]),
  );
  fromVault(
    authority,
    token_1_vault,
    recipient_token_1_account,
    vault_1_mint,
    token_program,
    token_program_2022,
    amount_1,
    signer(["vault_and_lp_mint_auth_seed", pool_state.auth_bump]),
  );
}

// ---- creator fees (instructions/collect_creator_fee*.rs, states/creator_fee_share.rs) -----------------------------

/** The part of `fee` the protocol keeps at `rate` (rounded down, so the dust goes to the creator). */
function sharedPart(fee: u64, rate: u64): u64 {
  require(rate <= FEE_RATE_DENOMINATOR_VALUE, ErrorCode.InvalidInput);
  return u64((u128(fee) * u128(rate)) / u128(FEE_RATE_DENOMINATOR_VALUE));
}

/** What the creator is owed after the protocol's share. */
export interface CreatorAmounts {
  amount_0: u64;
  amount_1: u64;
}

/** Book the protocol's share of the creator fees and zero them (PoolState::settle_creator_fee). */
function settleCreatorFee(pool: Mut<PoolState>, rate: u64): CreatorAmounts {
  const shared_0 = sharedPart(pool.creator_fees_token_0, rate);
  const shared_1 = sharedPart(pool.creator_fees_token_1, rate);
  require(pool.protocol_fees_token_0 <= MAX_U64 - shared_0, ErrorCode.MathOverflow);
  require(pool.protocol_fees_token_1 <= MAX_U64 - shared_1, ErrorCode.MathOverflow);
  const amount_0 = pool.creator_fees_token_0 - shared_0;
  const amount_1 = pool.creator_fees_token_1 - shared_1;
  pool.protocol_fees_token_0 += shared_0;
  pool.protocol_fees_token_1 += shared_1;
  pool.creator_fees_token_0 = 0n;
  pool.creator_fees_token_1 = 0n;
  return { amount_0, amount_1 };
}

/** Pay the pool's creator its fees, less the protocol's share; the creator signs. */
export function collectCreatorFee(
  creator: Mut<Signer>,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  pool_state: Mut<PoolState>,
  amm_config: Account<AmmConfig>,
  token_0_vault: Mut<TokenAccount>,
  token_1_vault: Mut<TokenAccount>,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  creator_token_0: Ata<InitIfNeeded<TokenAccount>, "creator", "vault_0_mint">,
  creator_token_1: Ata<InitIfNeeded<TokenAccount>, "creator", "vault_1_mint">,
  token_0_program: TokenInterface,
  token_1_program: TokenInterface,
  associated_token_program: AssociatedTokenProgram,
  system_program: SystemProgram,
  creator_fee_share: Seeds<AccountInfo, ["creator_fee_share", "@creator", "@amm_config"]>,
): void {
  // Anchor creates the creator's token accounts before it checks the other accounts.
  creator_token_0.createIfNeeded(creator, token_0_program);
  creator_token_1.createIfNeeded(creator, token_1_program);
  require(creator.key === pool_state.pool_creator, AnchorError.ConstraintAddress);
  require(amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  require(token_0_vault.key === pool_state.token_0_vault, AnchorError.ConstraintRaw);
  require(token_1_vault.key === pool_state.token_1_vault, AnchorError.ConstraintRaw);
  require(vault_0_mint.key === token_0_vault.mint, AnchorError.ConstraintAddress);
  require(vault_1_mint.key === token_1_vault.mint, AnchorError.ConstraintAddress);
  // The protocol's share: the creator's own CreatorFeeShare when it exists, else the config's.
  let rate = amm_config.creator_fee_share_rate;
  if (creator_fee_share.dataLen !== 0n && creator_fee_share.owner === programId()) {
    const share = loadAccount<CreatorFeeShare>(creator_fee_share);
    rate = share.share_rate;
  }
  require(pool_state.creator_fees_token_0 !== 0n || pool_state.creator_fees_token_1 !== 0n, ErrorCode.NoFeeCollect);
  const owed = settleCreatorFee(pool_state, rate);
  const amount_0 = owed.amount_0;
  const amount_1 = owed.amount_1;
  pool_state.recent_epoch = currentEpoch();
  if (amount_0 !== 0n)
    token_0_program.transferChecked(token_0_vault, vault_0_mint, creator_token_0, authority, amount_0, ["vault_and_lp_mint_auth_seed", authority.pdaBump]);
  if (amount_1 !== 0n)
    token_1_program.transferChecked(token_1_vault, vault_1_mint, creator_token_1, authority, amount_1, ["vault_and_lp_mint_auth_seed", authority.pdaBump]);
}

/** The same, sent by anyone: `payer` funds the creator's token accounts if they are missing. */
export function collectCreatorFeePermissionless(
  payer: Mut<Signer>,
  creator: AccountInfo,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  pool_state: Mut<PoolState>,
  token_0_vault: Mut<TokenAccount>,
  token_1_vault: Mut<TokenAccount>,
  vault_0_mint: Mint,
  vault_1_mint: Mint,
  creator_token_0: Ata<InitIfNeeded<TokenAccount>, "creator", "vault_0_mint">,
  creator_token_1: Ata<InitIfNeeded<TokenAccount>, "creator", "vault_1_mint">,
  token_0_program: TokenInterface,
  token_1_program: TokenInterface,
  associated_token_program: AssociatedTokenProgram,
  system_program: SystemProgram,
  amm_config: Account<AmmConfig>,
  creator_fee_share: Seeds<AccountInfo, ["creator_fee_share", "@creator", "@amm_config"]>,
): void {
  creator_token_0.createIfNeeded(payer, token_0_program);
  creator_token_1.createIfNeeded(payer, token_1_program);
  require(creator.key === pool_state.pool_creator, AnchorError.ConstraintAddress);
  require(token_0_vault.key === pool_state.token_0_vault, AnchorError.ConstraintRaw);
  require(token_1_vault.key === pool_state.token_1_vault, AnchorError.ConstraintRaw);
  require(vault_0_mint.key === token_0_vault.mint, AnchorError.ConstraintAddress);
  require(vault_1_mint.key === token_1_vault.mint, AnchorError.ConstraintAddress);
  require(amm_config.key === pool_state.amm_config, AnchorError.ConstraintAddress);
  // The protocol's share: the creator's own CreatorFeeShare when it exists, else the config's.
  let rate = amm_config.creator_fee_share_rate;
  if (creator_fee_share.dataLen !== 0n && creator_fee_share.owner === programId()) {
    const share = loadAccount<CreatorFeeShare>(creator_fee_share);
    rate = share.share_rate;
  }
  require(pool_state.creator_fees_token_0 !== 0n || pool_state.creator_fees_token_1 !== 0n, ErrorCode.NoFeeCollect);
  const owed = settleCreatorFee(pool_state, rate);
  const amount_0 = owed.amount_0;
  const amount_1 = owed.amount_1;
  pool_state.recent_epoch = currentEpoch();
  if (amount_0 !== 0n)
    token_0_program.transferChecked(token_0_vault, vault_0_mint, creator_token_0, authority, amount_0, ["vault_and_lp_mint_auth_seed", authority.pdaBump]);
  if (amount_1 !== 0n)
    token_1_program.transferChecked(token_1_vault, vault_1_mint, creator_token_1, authority, amount_1, ["vault_and_lp_mint_auth_seed", authority.pdaBump]);
}

// ---- permissions, fee shares, supported mints (instructions/admin/*.rs) --------------------------------------------

/** Let `permission_authority` create pools with initialize_with_permission (Raydium's admin or permission owner). */
export function createPermissionPda(
  owner: Mut<Signer>,
  permission_authority: AccountInfo,
  permission: Init<Permission>,
  system_program: SystemProgram,
): void {
  // Anchor creates the account before it checks the signer.
  permission.create(owner, ["permission", permission_authority.key]);
  require(owner.key === ADMIN || owner.key === PERMISSION_OWNER, ErrorCode.InvalidOwner);
  permission.authority = permission_authority.key;
}

/** Take that permission back; the account's rent goes to the signer. */
export function closePermissionPda(
  owner: Mut<Signer>,
  permission_authority: AccountInfo,
  permission: Seeds<CloseTo<Mut<Permission>, "owner">, ["permission", "@permission_authority"]>,
  system_program: SystemProgram,
): void {
  constraint(owner, owner.key === ADMIN || owner.key === PERMISSION_OWNER, ErrorCode.InvalidOwner);
}

/** Set the protocol's share of `creator`'s creator fees on `amm_config` (in millionths), in place of the config's. */
export function createCreatorFeeShare(
  owner: Mut<Signer>,
  creator: AccountInfo,
  amm_config: Account<AmmConfig>,
  creator_fee_share: Init<CreatorFeeShare>,
  system_program: SystemProgram,
  share_rate: u64,
): void {
  const bump = creator_fee_share.create(owner, ["creator_fee_share", creator.key, amm_config.key]);
  require(owner.key === ADMIN || owner.key === CREATOR_FEE_SHARE_OWNER, ErrorCode.InvalidOwner);
  require(share_rate <= FEE_RATE_DENOMINATOR_VALUE, ErrorCode.InvalidInput);
  creator_fee_share.bump = bump;
  creator_fee_share.creator = creator.key;
  creator_fee_share.amm_config = amm_config.key;
  creator_fee_share.share_rate = share_rate;
}

/** Remove that share: the config's applies again. */
export function closeCreatorFeeShare(
  owner: Mut<Signer>,
  creator: AccountInfo,
  amm_config: Account<AmmConfig>,
  creator_fee_share: Seeds<CloseTo<Mut<CreatorFeeShare>, "owner">, ["creator_fee_share", "@creator", "@amm_config"]>,
  system_program: SystemProgram,
): void {
  constraint(owner, owner.key === ADMIN || owner.key === CREATOR_FEE_SHARE_OWNER, ErrorCode.InvalidOwner);
}

/** Allow a Token-2022 mint in pools whatever its extensions (Raydium's admin or mint operator). */
export function createSupportMintAssociated(
  owner: Mut<Signer>,
  token_mint: Mint,
  support_mint_associated: Init<SupportMintAssociated>,
  system_program: SystemProgram,
): void {
  support_mint_associated.bump = support_mint_associated.create(owner, ["support_mint", token_mint.key]);
  require(owner.key === ADMIN || owner.key === SUPPORT_MINT_OWNER, ErrorCode.NotApproved);
  require(token_mint.tokenProgram === TOKEN_2022_PROGRAM_ID, ErrorCode.NotApproved);
  support_mint_associated.mint = token_mint.key;
}

/** Withdraw that allowance; the account's rent goes to the signer. */
export function closeSupportMintAssociated(
  owner: Mut<Signer>,
  token_mint: Owner<Mint, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", ErrorCode.NotApproved>,
  support_mint_associated: Seeds<CloseTo<Mut<SupportMintAssociated>, "owner">, ["support_mint", "@token_mint"]>,
  system_program: SystemProgram,
): void {
  constraint(owner, owner.key === ADMIN || owner.key === SUPPORT_MINT_OWNER, ErrorCode.NotApproved);
}

// ---- excess lamports (instructions/admin/collect_excess_lamports.rs, utils/token.rs) ------------------------------

/**
 * Whether `account` reads as a token account (StateWithExtensions::<Account>::unpack): 165 bytes, or more with the
 * account type byte saying Account, initialized, its option tags 0 or 1. A mint or anything else does not.
 */
function isTokenAccount(account: RemainingAccount): boolean {
  const len = account.dataLen;
  if (len < 165n || len === 355n) return false;
  if (len > 165n && readData<u8>(account, 165n) !== 2n) return false;
  const state = readData<u8>(account, 108n);
  if (state === 0n || state > 2n) return false;
  return readData<u32>(account, 72n) <= 1n && readData<u32>(account, 109n) <= 1n && readData<u32>(account, 129n) <= 1n;
}
function tokenAmount(account: RemainingAccount): u64 {
  return isTokenAccount(account) ? readData<u64>(account, 64n) : 0n;
}

/** A token instruction (`data`: WithdrawExcessLamports or UnwrapLamports) moving lamports from `source` to `wallet`, signed by the pool authority. */
function lamportsOut(
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  source: RemainingAccount,
  wallet: Mut<Signer>,
  authority: AccountInfo,
  seeds: SignerSeeds,
  unwrap: u64,
): void {
  const legacy = source.owner === TOKEN_PROGRAM_ID;
  if (unwrap === 0n) {
    if (legacy) invoke(token_program, [writable(source), writable(wallet), readonlySigner(authority)], [u8(38n)], seeds);
    else invoke(token_program_2022, [writable(source), writable(wallet), readonlySigner(authority)], [u8(38n)], seeds);
  } else if (legacy) invoke(token_program, [writable(source), writable(wallet), readonlySigner(authority)], [u8(45n), u8(1n), unwrap], seeds);
  else invoke(token_program_2022, [writable(source), writable(wallet), readonlySigner(authority)], [u8(45n), u8(1n), unwrap], seeds);
}

/**
 * Move what a token account owned by the pool authority holds above its rent to `wallet`: WithdrawExcessLamports for a
 * token account or mint; for wrapped SOL, SyncNative folds the excess into the amount and UnwrapLamports takes exactly
 * that back out.
 */
function withdrawFromToken(
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
  source: RemainingAccount,
  wallet: Mut<Signer>,
  authority: AccountInfo,
  seeds: SignerSeeds,
): void {
  const native = isTokenAccount(source) && readData<u32>(source, 109n) === 1n;
  if (!native) {
    lamportsOut(token_program, token_program_2022, source, wallet, authority, seeds, 0n);
    return;
  }
  const before = tokenAmount(source);
  if (source.owner === TOKEN_PROGRAM_ID) invoke(token_program, [writable(source)], [u8(17n)]);
  else invoke(token_program_2022, [writable(source)], [u8(17n)]);
  const after = tokenAmount(source);
  require(after >= before, ErrorCode.LamportsCalculateError);
  const excess = after - before;
  if (excess === 0n) return;
  lamportsOut(token_program, token_program_2022, source, wallet, authority, seeds, excess);
  require(tokenAmount(source) === before, ErrorCode.LamportsCalculateError);
}

/**
 * Sweep lamports above rent to Raydium's lamport collector: from the token accounts and mints among the remaining
 * accounts (the pool authority's), then from this program's accounts among them.
 */
export function collectExcessLamports(
  collect_lamports_wallet: Mut<Signer>,
  authority: Seeds<AccountInfo, ["vault_and_lp_mint_auth_seed"]>,
  token_program: TokenProgram,
  token_program_2022: Token2022Program,
): void {
  constraint(collect_lamports_wallet, collect_lamports_wallet.key === COLLECT_LAMPORTS || collect_lamports_wallet.key === ADMIN, ErrorCode.InvalidOwner);
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) {
    const r = rest.get(i);
    if (r.owner === TOKEN_PROGRAM_ID || r.owner === TOKEN_2022_PROGRAM_ID) withdrawFromToken(token_program, token_program_2022, r, collect_lamports_wallet, authority, signer(["vault_and_lp_mint_auth_seed", authority.pdaBump]));
  }
  for (let i = 0n; i < rest.length; i++) {
    const r = rest.get(i);
    if (r.owner !== programId()) continue;
    const minimum = rentExempt(r.dataLen);
    require(r.lamports >= minimum, ProgramError.InsufficientFunds);
    const excess = r.lamports - minimum;
    if (excess === 0n) continue;
    r.lamports -= excess;
    collect_lamports_wallet.lamports += excess;
  }
}
