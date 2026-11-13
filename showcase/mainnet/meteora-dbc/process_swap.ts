// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// The swap of a VirtualPool (instructions/swap/process_swap.rs, swap_exact_in.rs, swap_partial_fill.rs,
// swap_exact_out.rs; the pool and config account loaders of utils/). The instruction emits the events from what
// processSwap returns (an event goes out from the instruction itself).
//
// The instructions sysvar, which the original reads with solana_instructions_sysvar when a client passes it as the
// one remaining account, is read here from its bytes: a u16 count, a u16 offset per instruction, each instruction as
// a u16 account count, (u8 flags, 32-byte key) per account, the program id, a u16 data length and the data, and the
// current index in the last two bytes.
import {
  type AccountInfo,
  type Inout,
  type Mint,
  type Mut,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type Signer,
  type TokenAccount,
  type TokenInterface,
  type u16,
  currentSlot,
  now,
  panic,
  programId,
  pubkey,
  readData,
  require,
  stackHeight,
  transferHookProgram,
  u8,
  u64,
} from "typesol";
import { PoolError } from "./errors";
import { feeMode, isRateLimiterConfig, rateLimiterApplied } from "./fees";
import { U64_MAX, addU64, mulU64 } from "./math";
import { type PoolConfig, type PoolState, type SwapResult2 } from "./state";
import { type SwapFeeMode, applySwapResult, swapResultFor, updatePreSwap } from "./swap";
import { type EpochFee, epochFee, excludedTransferFee, includedTransferFee } from "./token";

/** const_pda::pool_authority: ["pool_authority"] of the program, bump 255. */
export const POOL_AUTHORITY = pubkey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const POOL_AUTHORITY_BUMP = 255n;
const INSTRUCTIONS_SYSVAR = pubkey("Sysvar1nstructions1111111111111111111111111");
/** sha256("account:<Name>")[..8] as little-endian u64s. */
export const DISC_VIRTUAL_POOL: u64 = 6662870464433873109n;
export const DISC_TRANSFER_HOOK_POOL: u64 = 2569793050875845613n;
const DISC_POOL_CONFIG: u64 = 3135040203581713434n;
const DISC_CONFIG_WITH_TRANSFER_HOOK: u64 = 18265411696862616616n;
/** sha256("global:<name>")[..8] as little-endian u64s. */
const IX_SWAP: u64 = 14449647541112719096n;
const IX_SWAP2: u64 = 9825548078193527617n;
const IX_SWAP2_WITH_TRANSFER_HOOK: u64 = 10935555836643728823n;
const IX_INIT_SPL: u64 = 5721883141255681420n;
const IX_INIT_T22: u64 = 11230973141116483241n;
const IX_INIT_T22_HOOK: u64 = 182273922491289014n;

/** What processSwap hands the instruction for its events (SwapEventData). */
export interface SwapOutcome {
  quote_to_base: boolean;
  has_referral: boolean;
  result: SwapResult2;
  in_amount_in: u64;
  in_minimum_amount_out: u64;
  quote_reserve_amount: u64;
  migration_threshold: u64;
  excluded_transfer_fee_amount_out: u64;
  fee_on_base_token: boolean;
  current_timestamp: u64;
  curve_complete: boolean;
  base_reserve: u64;
}

// ---- account loaders (utils/pool_account_loader.rs, utils/config_account_loader.rs) -----------------------------

/** PoolAccountLoader::try_from: this program's, exactly 8 + 416 bytes, a VirtualPool or TransferHookPool. Returns whether it is a TransferHookPool. */
export function checkPoolAccount(pool: AccountInfo): boolean {
  require(pool.owner === programId(), PoolError.InvalidPoolAccount);
  require(pool.dataLen === 424n, PoolError.InvalidPoolAccount);
  const disc = readData<u64>(pool, 0n);
  require(disc === DISC_VIRTUAL_POOL || disc === DISC_TRANSFER_HOOK_POOL, PoolError.InvalidPoolAccount);
  return disc === DISC_TRANSFER_HOOK_POOL;
}

/** ConfigAccountLoader::try_from: this program's, a PoolConfig (8 + 1,040 bytes) or ConfigWithTransferHook (8 + 1,120). */
export function checkConfigAccount(config: AccountInfo): boolean {
  require(config.owner === programId(), PoolError.InvalidConfigAccount);
  require(config.dataLen >= 8n, PoolError.InvalidConfigAccount);
  const disc = readData<u64>(config, 0n);
  if (disc === DISC_CONFIG_WITH_TRANSFER_HOOK) {
    require(config.dataLen === 1128n, PoolError.InvalidConfigAccount);
    return true;
  }
  require(disc === DISC_POOL_CONFIG, PoolError.InvalidConfigAccount);
  require(config.dataLen === 1048n, PoolError.InvalidConfigAccount);
  return false;
}

// ---- the instructions sysvar ----------------------------------------------------------------------------------

/** load_current_index_checked */
function currentIndex(ixs: RemainingAccount): u64 {
  require(ixs.dataLen >= 2n, PoolError.InvalidInstructionsSysvar);
  return u64(readData<u16>(ixs, ixs.dataLen - 2n));
}

/** Where instruction `i` starts in the sysvar (load_instruction_at_checked; i is below the current index here). */
function instructionAt(ixs: RemainingAccount, i: u64): u64 {
  return u64(readData<u16>(ixs, 2n + 2n * i));
}
function accountsOf(ixs: RemainingAccount, at: u64): u64 {
  return u64(readData<u16>(ixs, at));
}
function accountKey(ixs: RemainingAccount, at: u64, j: u64): Pubkey {
  return readData<Pubkey>(ixs, at + 2n + 33n * j + 1n);
}
function programOf(ixs: RemainingAccount, at: u64): Pubkey {
  return readData<Pubkey>(ixs, at + 2n + 33n * accountsOf(ixs, at));
}
/** The data's first 8 bytes as a u64 (`&instruction.data[..8]`, which panics on shorter data). */
function discOf(ixs: RemainingAccount, at: u64): u64 {
  const dataAt = at + 2n + 33n * accountsOf(ixs, at) + 32n;
  if (u64(readData<u16>(ixs, dataAt)) < 8n) panic("range end index 8 out of range for slice");
  return readData<u64>(ixs, dataAt + 2n);
}

/** is_instruction_include_pool_swap: one of this program's swaps on `pool` (its account 2). */
function includesPoolSwap(ixs: RemainingAccount, at: u64, pool: Pubkey): boolean {
  const d = discOf(ixs, at);
  if (d === IX_SWAP || d === IX_SWAP2 || d === IX_SWAP2_WITH_TRANSFER_HOOK) {
    if (accountsOf(ixs, at) <= 2n) panic("index out of bounds");
    return accountKey(ixs, at, 2n) === pool;
  }
  return false;
}

/**
 * validate_single_swap_instruction: no other swap on this pool earlier in the transaction. When this program runs by
 * CPI the original also reads the processed sibling instructions (sol_get_processed_sibling_instruction), which this
 * port cannot: it refuses that case (FailToValidateSingleSwapInstruction) where the original may accept it.
 */
function validateSingleSwap(pool: Pubkey, rest: RemainingAccounts, hasSysvar: boolean): void {
  require(hasSysvar, PoolError.FailToValidateSingleSwapInstruction);
  const ixs = rest.get(0n);
  const current = currentIndex(ixs);
  if (programOf(ixs, instructionAt(ixs, current)) !== programId()) {
    require(stackHeight() <= 2n, PoolError.FailToValidateSingleSwapInstruction);
    require(false, PoolError.FailToValidateSingleSwapInstruction);
  }
  for (let i = 0n; i < current; i++) {
    const at = instructionAt(ixs, i);
    if (programOf(ixs, at) !== programId()) {
      for (let j = 0n; j < accountsOf(ixs, at); j++) require(accountKey(ixs, at, j) !== pool, PoolError.FailToValidateSingleSwapInstruction);
    } else {
      require(!includesPoolSwap(ixs, at, pool), PoolError.FailToValidateSingleSwapInstruction);
    }
  }
}

/** validate_contain_initialize_pool_ix_and_no_cpi(...).is_ok(): an earlier top-level instruction created this pool. */
function createdInThisTransaction(pool: Pubkey, hasReferral: boolean, rest: RemainingAccounts, hasSysvar: boolean): boolean {
  if (hasReferral || !hasSysvar) return false;
  const ixs = rest.get(0n);
  const current = currentIndex(ixs);
  if (programOf(ixs, instructionAt(ixs, current)) !== programId()) return false;
  for (let i = 0n; i < current; i++) {
    const at = instructionAt(ixs, i);
    if (programOf(ixs, at) === programId()) {
      const d = discOf(ixs, at);
      if ((d === IX_INIT_SPL || d === IX_INIT_T22 || d === IX_INIT_T22_HOOK) && accountsOf(ixs, at) > 5n && accountKey(ixs, at, 5n) === pool) return true;
    }
  }
  return false;
}

// ---- process_swap ---------------------------------------------------------------------------------------------

/** transfer_token_from_user / transfer_token_from_pool_authority without hook accounts: a hooked mint needs them. */
export function requireNoTransferHook(mint: Mint): void {
  require(mint.tokenProgram === pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") || transferHookProgram(mint) === null, PoolError.MissingRemainingAccountForTransferHook);
}

/**
 * process_swap for a VirtualPool with no transfer hook accounts (swap, swap2). `swapMode` 0 ExactIn, 1 PartialFill,
 * 2 ExactOut; `amount0` / `amount1` as SwapParameters2 has them.
 */
export function processSwap(
  p: Inout<PoolState>,
  c: PoolConfig,
  poolKey: Pubkey,
  poolAuthority: AccountInfo,
  inputTokenAccount: Mut<TokenAccount>,
  outputTokenAccount: Mut<TokenAccount>,
  baseVault: Mut<TokenAccount>,
  quoteVault: Mut<TokenAccount>,
  baseMint: Mint,
  quoteMint: Mint,
  payer: Signer,
  tokenBaseProgram: TokenInterface,
  tokenQuoteProgram: TokenInterface,
  hasReferral: boolean,
  rest: RemainingAccounts,
  amount0: u64,
  amount1: u64,
  swapMode: u64,
): SwapOutcome {
  require(swapMode <= 2n, PoolError.TypeCastFailed);
  const quoteToBase = inputTokenAccount.mint !== baseMint.key;
  require(amount0 > 0n, PoolError.AmountIsZero);
  require(rest.length <= 1n, PoolError.InvalidRemainingAccountsLength);
  const hasSysvar = rest.length === 1n;
  if (hasSysvar) require(rest.get(0n).key === INSTRUCTIONS_SYSVAR, PoolError.InvalidInstructionsSysvar);
  // get_current_point
  require(c.activation_type <= 1n, PoolError.InvalidActivationType);
  const t = now();
  const currentPoint = c.activation_type === 0n ? currentSlot() : t >= 0n ? u64(t) : U64_MAX - u64(-(t + 1n));
  if (isRateLimiterConfig(c.pool_fees.base_fee) && rateLimiterApplied(c.pool_fees.base_fee, currentPoint, p.activation_point, quoteToBase))
    validateSingleSwap(poolKey, rest, hasSysvar);
  const minFee = c.enable_first_swap_with_min_fee === 1n && p.has_swap === 0n && createdInThisTransaction(poolKey, hasReferral, rest, hasSysvar);
  require(!(p.quote_reserve >= c.migration_quote_threshold), PoolError.PoolIsCompleted);
  const currentTimestamp = t >= 0n ? u64(t) : U64_MAX - u64(-(t + 1n));
  updatePreSwap(p, c, currentTimestamp);
  const fm = feeMode(c.collect_fee_mode, quoteToBase);
  const mode: SwapFeeMode = { fees_on_input: fm.fees_on_input, fees_on_base_token: fm.fees_on_base_token, has_referral: hasReferral };
  const feeIn: EpochFee = quoteToBase ? epochFee(quoteMint) : epochFee(baseMint);
  const feeOut: EpochFee = quoteToBase ? epochFee(baseMint) : epochFee(quoteMint);

  // the curve's amount: the input after its transfer fee, or for ExactOut the output before it
  let curveAmount: u64 = 0n;
  if (swapMode === 2n) curveAmount = includedTransferFee(feeOut, amount0);
  else {
    curveAmount = excludedTransferFee(feeIn, amount0);
    require(curveAmount > 0n, PoolError.AmountIsZero);
  }
  const r = swapResultFor(p, c, curveAmount, mode, quoteToBase, currentPoint, minFee, swapMode);
  let inAmountIn: u64 = 0n;
  let inMinimumOut: u64 = 0n;
  let excludedOut: u64 = 0n;
  if (swapMode === 0n) {
    excludedOut = excludedTransferFee(feeOut, r.output_amount);
    require(excludedOut >= amount1, PoolError.ExceededSlippage);
    inAmountIn = amount0;
    inMinimumOut = amount1;
  } else if (swapMode === 1n) {
    excludedOut = excludedTransferFee(feeOut, r.output_amount);
    require(excludedOut >= amount1, PoolError.ExceededSlippage);
    let includedIn = amount0;
    if (r.amount_left !== 0n) includedIn = includedTransferFee(feeIn, r.included_fee_input_amount);
    require(includedIn <= amount0, PoolError.ExceededInputAmount);
    inAmountIn = includedIn;
    inMinimumOut = excludedOut;
  } else {
    const includedIn = includedTransferFee(feeIn, r.included_fee_input_amount);
    require(includedIn <= amount1, PoolError.ExceededSlippage);
    inAmountIn = includedIn;
    inMinimumOut = amount0;
    excludedOut = amount0;
  }
  applySwapResult(p, c, r, mode, quoteToBase, currentTimestamp);
  const migrationQuoteThreshold = c.migration_quote_threshold;
  const migrationBaseThreshold = c.migration_base_threshold;
  const v = c.locked_vesting_config;
  
  // the input to its vault, then the output from the other vault (transfer_token_from_user, _from_pool_authority)
  if (quoteToBase) {
    requireNoTransferHook(quoteMint);
    tokenQuoteProgram.transferChecked(inputTokenAccount, quoteMint, quoteVault, payer, inAmountIn);
    requireNoTransferHook(baseMint);
    tokenBaseProgram.transferChecked(baseVault, baseMint, outputTokenAccount, poolAuthority, r.output_amount, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  } else {
    requireNoTransferHook(baseMint);
    tokenBaseProgram.transferChecked(inputTokenAccount, baseMint, baseVault, payer, inAmountIn);
    requireNoTransferHook(quoteMint);
    tokenQuoteProgram.transferChecked(quoteVault, quoteMint, outputTokenAccount, poolAuthority, r.output_amount, ["pool_authority", u8(POOL_AUTHORITY_BUMP)]);
  }
  return {
    quote_to_base: quoteToBase,
    has_referral: hasReferral,
    result: r,
    in_amount_in: inAmountIn,
    in_minimum_amount_out: inMinimumOut,
    quote_reserve_amount: 0n,
    migration_threshold: migrationQuoteThreshold,
    excluded_transfer_fee_amount_out: excludedOut,
    fee_on_base_token: mode.fees_on_base_token,
    current_timestamp: currentTimestamp,
    curve_complete: false,
    base_reserve: 0n,
  };
}

/**
 * The end of process_swap, after the referral's share: when the curve is complete, the base vault (reloaded) must hold
 * the migration base, the base fees owed and the locked vesting; the pool records the finish time and its progress.
 */
export function finishSwap(p: Inout<PoolState>, c: PoolConfig, baseVault: TokenAccount, o: Inout<SwapOutcome>): void {
  const migrationQuoteThreshold = c.migration_quote_threshold;
  const migrationBaseThreshold = c.migration_base_threshold;
  const v = c.locked_vesting_config;
  const currentTimestamp = o.current_timestamp;
  if (p.quote_reserve >= migrationQuoteThreshold) {
    // the base vault reloaded: the threshold, the base fees owed and the locked vesting must be there
    const fees = addU64(addU64(p.partner_base_fee, p.protocol_base_fee), p.creator_base_fee);
    const vestingTotal = addU64(v.cliff_unlock_amount, mulU64(v.amount_per_period, v.number_of_period));
    const required = addU64(addU64(migrationBaseThreshold, fees), vestingTotal);
    require(baseVault.amount >= required, PoolError.InsufficientLiquidityForMigration);
    p.finish_curve_timestamp = currentTimestamp;
    const hasVesting = v.amount_per_period !== 0n || v.cliff_duration_from_migration_time !== 0n || v.frequency !== 0n || v.number_of_period !== 0n || v.cliff_unlock_amount !== 0n;
    // MigrationProgress: PostBondingCurve (1) with locked vesting, else LockedVesting (2)
    p.migration_progress = hasVesting ? 1n : 2n;
    o.curve_complete = true;
    o.base_reserve = p.base_reserve;
  }
  o.quote_reserve_amount = p.quote_reserve;
}
