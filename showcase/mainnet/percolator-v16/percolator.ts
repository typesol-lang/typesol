// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs and
// aeyakovenko/percolator src/v16.rs, Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The entry of the port: the original's `Instruction::decode` (src/v16_program.rs `mod ix`) for all 50 tags, which the
// processor runs before anything else (before any account is looked at): empty data, an unknown tag, data too short
// for the tag's fields, a vector count above 16 and trailing bytes are refused with InvalidInstructionData exactly
// where the original refuses them; then the dispatch to the 50 handlers (setup.ts: InitMarket, InitPortfolio, Deposit,
// ClosePortfolio, SetMatcherConfig; custody.ts: Withdraw, SyncMaintenanceFee, whose engine code is refresh.ts;
// policy.ts: the authority, policy and ledger instructions; oracle.ts: the managed marks and ConfigureHybridOracle,
// whose external oracle reads are in external.ts; lifecycle.ts: UpdateAssetLifecycle, RestartAssetOracle,
// CanonicalizeSpentBackingHistory; trading.ts: TradeNoCpi, whose engine code is trade.ts and health.ts; batch.ts:
// BatchTradeNoCpi; matcher.ts: TradeCpi and BatchTradeCpi; convert.ts: ConvertReleasedPnl; crank.ts:
// PermissionlessCrank and FinalizeResetSide, whose engine code is autocrank.ts, liquidation.ts, recovery.ts and
// resolved.ts; recoveries.ts, resolution.ts and closeresolved.ts: the recovery and resolution instructions;
// reserves.ts: the insurance and backing-bucket instructions; terminal.ts: CloseSlab, ClaimResolvedPayoutTopup,
// SwapSecondaryForPrimary and ForceCloseAbandonedAsset).
//
// The original is a native program behind pinocchio 0.11.1's `entrypoint!` (anchor-lang-v2's re-export): up to 255
// accounts, a bump allocator that assumes 256 KiB of heap, a panic hook that logs the file of the panic, and a shim
// that builds solana-program 1.18 AccountInfos (RefCell-shared for repeated accounts) before the processor runs. It
// logs nothing of its own (no `msg!`): only panics log.
//
// Beside this file: state.ts (the persisted structs and the accessors of `mod state`), wire.ts (the engine's wire
// conversions and the signed readers), errors.ts (PercolatorError and the V16Error mapping), engine.ts (the engine code
// the ported handlers reach), refresh.ts (the maintenance fee and the withdrawal), accrual.ts (asset accrual and committed funding), program.ts (the processor's shared
// helpers), external.ts (the external oracle readers), setup.ts, custody.ts, policy.ts, oracle.ts and lifecycle.ts (the handlers). NOTES.md records the sites where the
// original swallows an error after changing a copy, and the decoded vectors' heap use.
import { type InstructionBytes, type u8, type u64, ProgramError, instructionData, programId, remainingAccounts, require, u64 as toU64 } from "typesol";
import { closePortfolio, deposit, initMarket, initPortfolio, setMatcherConfig } from "./setup.js";
import { syncMaintenanceFee, withdraw } from "./custody.js";
import { configureHybridOracle, configureManagedMark, pushManagedMark } from "./oracle.js";
import { canonicalizeSpentBackingHistory, restartAssetOracle, updateAssetLifecycle } from "./lifecycle.js";
import {
  configurePermissionlessResolve,
  syncBackingDomainLedger,
  syncInsuranceLedger,
  updateAssetAuthority,
  updateAuthority,
  updateBackingFeePolicy,
  updateBaseUnitMints,
  updateMarketAuthorityPolicy,
  updateTradeFeePolicy,
} from "./policy.js";
import { tradeNoCpi } from "./trading.js";
import { batchTradeNoCpi } from "./batch.js";
import { batchTradeCpi, tradeCpi } from "./matcher.js";
import { convertReleasedPnlHandler } from "./convert.js";
import { cureAndCancelCloseHandler, forfeitRecoveryLegHandler, rebalanceReduceHandler } from "./recoveries.js";
import { closeResolved } from "./closeresolved.js";
import { resolveMarketHandler, resolveStalePermissionless } from "./resolution.js";
import { claimResolvedPayoutTopup, closeSlab, forceCloseAbandonedAsset, swapSecondaryForPrimary } from "./terminal.js";
import { topUpBackingBucket, topUpInsurance, withdrawBackingBucket, withdrawBackingEarnings, withdrawInsuranceAsset } from "./reserves.js";

/** `handle_close_resolved`'s `None` for the crank's slot and the hint (CloseResolved). */
const NOT_A_CRANK: u64 = 0xffffffffffffffffn;
import { finalizeResetSide, permissionlessCrank } from "./crank.js";

/** Panics as pinocchio's entrypoint hook reports them: the file of the panic, then "** PANICKED **", then abort. */
export const PANIC_STYLE = "pinocchio";
/** The market and portfolio are views written in place, as the original writes them. */
export const NATIVE_ACCOUNT_WRITES = true;
/** The original logs nothing when an instruction fails. */
export const ERROR_LOG_PREFIX = null;
export const PROGRAM_ERROR_LOG_PREFIX = null;
/** The entrypoint takes as many accounts as an instruction can name (pinocchio's MAX_TX_ACCOUNTS, 255). */
export const MAX_ACCOUNTS = 255n;


/** The widths of `mod ix`'s readers: `read_u8`, `read_u16`, `read_u32`, `read_u64` / `read_i64`, `read_u128` / `read_i128`, `read_bytes32`. */
const U8 = 1n;
const U16 = 2n;
const U32 = 4n;
const U64 = 8n;
const U128 = 16n;
const B32 = 32n;
/** `BATCH_TRADE_DECODE_MAX_LEGS` and `CRANK_OBSERVATION_DECODE_MAX`. */
const MAX_LEGS = 16n;
const MAX_OBSERVATIONS = 16n;

/** `Instruction::public_tag_is_known`: the 50 tags of src/v16_program.rs. */
function publicTagIsKnown(tag: u8): boolean {
  if (tag <= 10n) return tag !== 2n && tag !== 7n;
  if (tag === 13n || tag === 19n || tag === 24n || tag === 28n || tag === 30n || tag === 32n) return true;
  if (tag >= 34n && tag <= 40n) return true;
  if (tag >= 42n && tag <= 46n) return true;
  return tag >= 48n && tag <= 70n;
}

/**
 * The body length of a tag without a vector: the sum of its fields' widths, in the order `decode` reads them (the
 * field names in the comments, as `Instruction` declares them).
 */
function fixedBodyLen(tag: u8): u64 {
  // InitMarket (decode_init_market_body): max_portfolio_assets u16, h_min, h_max, initial_price u64,
  // min_nonzero_mm_req, min_nonzero_im_req u128, maintenance_margin_bps, initial_margin_bps, max_trading_fee_bps,
  // trade_fee_base_bps, liquidation_fee_bps u64, liquidation_fee_cap, min_liquidation_abs u128,
  // max_price_move_bps_per_slot, max_accrual_dt_slots, max_abs_funding_e9_per_slot, min_funding_lifetime_slots,
  // max_account_b_settlement_chunks, max_bankrupt_close_chunks, max_bankrupt_close_lifetime_slots u64,
  // public_b_chunk_atoms, maintenance_fee_per_slot u128: 218 bytes.
  if (tag === 0n) return U16 + 3n * U64 + 2n * U128 + 5n * U64 + 2n * U128 + 7n * U64 + 2n * U128;
  // InitPortfolio, SyncInsuranceLedger, ClaimResolvedPayoutTopup: nothing.
  if (tag === 1n || tag === 54n || tag === 46n) return 0n;
  // Deposit, Withdraw: portfolio_id, expected_sequence u64, amount u128.
  if (tag === 3n || tag === 4n) return 2n * U64 + U128;
  // TradeNoCpi (decode_trade_nocpi_body): account_a_portfolio_id, account_a_position_epoch, account_b_portfolio_id,
  // account_b_position_epoch u64, asset_index u16, market_id u64, size_q i128, exec_price, fee_bps u64,
  // backing_fee_cap_bps u16: 76 bytes.
  if (tag === 6n) return 4n * U64 + U16 + U64 + U128 + 2n * U64 + U16;
  // ClosePortfolio: portfolio_id, expected_sequence, position_epoch u64.
  if (tag === 8n) return 3n * U64;
  // TopUpInsurance: market_id, intent_id, authority_epoch u64, amount u128.
  if (tag === 9n) return 3n * U64 + U128;
  // TradeCpi (decode_trade_cpi_body): account_a_portfolio_id, account_a_position_epoch, account_b_portfolio_id,
  // account_b_position_epoch, account_b_matcher_sequence u64, asset_index u16, market_id u64, size_q i128, fee_bps,
  // limit_price u64, backing_fee_cap_bps u16: 84 bytes.
  if (tag === 10n) return 5n * U64 + U16 + U64 + U128 + 2n * U64 + U16;
  // CloseSlab: authority_epoch u64. ResolveStalePermissionless, SyncMaintenanceFee: now_slot u64.
  if (tag === 13n || tag === 39n || tag === 48n) return U64;
  // ResolveMarket: asset_generation_frontier, authority_epoch u64.
  if (tag === 19n) return 2n * U64;
  // TopUpBackingBucket: domain u16, market_id, intent_id, authority_epoch u64, backing_fee_bps,
  // insurance_share_bps u16, amount u128, expiry_slot u64.
  if (tag === 24n) return U16 + 3n * U64 + 2n * U16 + U128 + U64;
  // ConvertReleasedPnl: portfolio_id, position_epoch u64, amount u128. CureAndCancelClose: portfolio_id,
  // position_epoch u64, optional_deposit u128.
  if (tag === 28n || tag === 42n) return 2n * U64 + U128;
  // CloseResolved: fee_rate_per_slot u128.
  if (tag === 30n) return U128;
  // UpdateAuthority: authority_epoch u64, new_pubkey [u8; 32].
  if (tag === 32n) return U64 + B32;
  // ConfigureHybridOracle (decode_configure_hybrid_oracle_body): asset_index u16, market_id, now_slot u64,
  // now_unix_ts i64, oracle_leg_count, oracle_leg_flags u8, max_staleness_secs, hybrid_soft_stale_slots,
  // mark_ewma_halflife_slots, mark_min_fee u64, invert u8, unit_scale u32, conf_filter_bps u16,
  // oracle_leg_feeds 3 × [u8; 32], observation_sequence, authority_epoch u64: 179 bytes.
  if (tag === 34n) return U16 + 3n * U64 + 2n * U8 + 4n * U64 + U8 + U32 + U16 + 3n * B32 + 2n * U64;
  // ConfigureEwmaMark: asset_index u16, market_id, now_slot, initial_mark_e6, mark_ewma_halflife_slots,
  // mark_min_fee, observation_sequence, authority_epoch u64.
  if (tag === 35n) return U16 + 7n * U64;
  // PushEwmaMark, PushAuthMark: asset_index u16, market_id, now_slot, mark_e6, observation_sequence,
  // authority_epoch u64. ConfigureAuthMark: the same with initial_mark_e6. RestartAssetOracle: the same with
  // initial_price.
  if (tag === 36n || tag === 62n || tag === 63n || tag === 69n) return U16 + 5n * U64;
  // UpdateLiquidationFeePolicy, UpdateMaintenanceFeePolicy: cranker_share_bps u16, policy_sequence,
  // authority_epoch u64. UpdateFeeRedirectPolicy: redirect_bps u16, then the same.
  if (tag === 37n || tag === 49n || tag === 58n) return U16 + 2n * U64;
  // ConfigurePermissionlessResolve: asset_generation_frontier, stale_slots, force_close_delay_slots,
  // policy_sequence, authority_epoch u64.
  if (tag === 38n) return 5n * U64;
  // UpdateAssetLifecycle (decode_update_asset_lifecycle_body): action u8, asset_index u16, market_id,
  // authority_epoch, now_slot, initial_price u64, max_init_fee u128, insurance_authority, insurance_operator,
  // backing_bucket_authority, oracle_authority [u8; 32]: 179 bytes.
  if (tag === 40n) return U8 + U16 + 4n * U64 + U128 + 4n * B32;
  // ForfeitRecoveryLeg: portfolio_id, position_epoch u64, asset_index u16, b_delta_budget u128. RebalanceReduce:
  // portfolio_id, position_epoch u64, asset_index u16, reduce_q u128.
  if (tag === 43n || tag === 44n) return 2n * U64 + U16 + U128;
  // FinalizeResetSide: asset_index u16, side u8.
  if (tag === 45n) return U16 + U8;
  // WithdrawBackingBucket, WithdrawBackingBucketEarnings: domain u16, market_id, authority_epoch u64, amount u128.
  // WithdrawInsuranceAsset: asset_index u16, market_id, authority_epoch u64, amount u128.
  if (tag === 50n || tag === 52n || tag === 57n) return U16 + 2n * U64 + U128;
  // UpdateBackingFeePolicy: domain u16, market_id u64, fee_bps, insurance_share_bps u16, policy_sequence,
  // authority_epoch u64.
  if (tag === 51n) return U16 + U64 + 2n * U16 + 2n * U64;
  // SyncBackingDomainLedger: domain u16.
  if (tag === 53n) return U16;
  // UpdateTradeFeePolicy: trade_fee_base_bps, policy_sequence, authority_epoch u64.
  if (tag === 55n) return 3n * U64;
  // TopUpInsuranceDomain: domain u16, market_id, intent_id, authority_epoch u64, amount u128.
  if (tag === 56n) return U16 + 3n * U64 + U128;
  // UpdateMarketInitFeePolicy: min_init_fee u128, policy_sequence, authority_epoch u64.
  if (tag === 59n) return U128 + 2n * U64;
  // UpdateBaseUnitMints (decode_update_base_unit_mints_body): primary_mint, secondary_mint [u8; 32],
  // authority_epoch u64.
  if (tag === 60n) return 2n * B32 + U64;
  // SwapSecondaryForPrimary (decode_swap_secondary_for_primary_body): amount u128, authority_epoch u64.
  if (tag === 61n) return U128 + U64;
  // ForceCloseAbandonedAsset: asset_index u16, now_slot u64, close_q u128.
  if (tag === 64n) return U16 + U64 + U128;
  // UpdateAssetAuthority: asset_index u16, market_id, authority_epoch u64, kind u8, new_pubkey [u8; 32].
  if (tag === 65n) return U16 + 2n * U64 + U8 + B32;
  // SetMatcherConfig (decode_set_matcher_config_body): portfolio_id, expected_sequence, position_epoch,
  // asset_generation_frontier u64, enabled u8, trade_fee_cap_bps u16, expiry_slot u64.
  if (tag === 68n) return 4n * U64 + U8 + U16 + U64;
  // CanonicalizeSpentBackingHistory: asset_index u16, market_id, authority_epoch u64. (Tag 70; decode() routes
  // tags 5, 66 and 67 elsewhere, so this is the last known tag.)
  return U16 + 2n * U64;
}

/**
 * `Instruction::decode`: `split_public_input` (a tag byte, one of the 50), the tag's fields read in order (each
 * `read_*` refuses data shorter than its width), then `rest.is_empty()`. Every refusal is InvalidInstructionData and
 * nothing happens between the reads, so a fixed body is refused exactly when its length differs from the fields'
 * total. The three bodies with a vector read its u8 count first and refuse a count above 16 before reading the
 * elements (allocating `Vec::with_capacity(count)` in between, which the port has no need of: NOTES.md):
 *
 * - PermissionlessCrank (5): now_slot u64, count u8, then count × (asset_index u16, oracle_accounts u8).
 * - BatchTradeNoCpi (66): count u8, count × (asset_index u16, market_id u64, size_q i128, exec_price u64,
 *   fee_bps u64), then account_a_portfolio_id, account_a_position_epoch, account_b_portfolio_id,
 *   account_b_position_epoch u64.
 * - BatchTradeCpi (67): count u8, count × (asset_index u16, market_id u64, size_q i128, fee_bps u64,
 *   limit_price u64), then account_a_portfolio_id, account_a_position_epoch, account_b_portfolio_id,
 *   account_b_position_epoch, account_b_matcher_sequence u64, max_slippage_atoms, max_fee_atoms u128.
 *
 * Enum, bool and option-like bytes (UpdateAssetLifecycle's action, UpdateAssetAuthority's kind, FinalizeResetSide's
 * side, SetMatcherConfig's enabled, ConfigureHybridOracle's invert and leg count) are read as plain u8 here; their
 * handlers judge them. A count of 0 decodes. Returns the tag.
 */
function decode(data: InstructionBytes): u8 {
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  require(publicTagIsKnown(tag), ProgramError.InvalidInstructionData);
  const n = data.length - 1n;
  if (tag === 5n) {
    require(n >= U64 + U8, ProgramError.InvalidInstructionData);
    const count = toU64(data.readU8(1n + U64));
    require(count <= MAX_OBSERVATIONS, ProgramError.InvalidInstructionData);
    require(n === U64 + U8 + count * (U16 + U8), ProgramError.InvalidInstructionData);
  } else if (tag === 66n || tag === 67n) {
    require(n >= U8, ProgramError.InvalidInstructionData);
    const count = toU64(data.readU8(1n));
    require(count <= MAX_LEGS, ProgramError.InvalidInstructionData);
    // Both legs are 42 bytes (u16, u64, i128 and two u64), in another order of the last two.
    const leg = U16 + U64 + U128 + 2n * U64;
    const tail = tag === 66n ? 4n * U64 : 5n * U64 + 2n * U128;
    require(n === U8 + count * leg + tail, ProgramError.InvalidInstructionData);
  } else {
    require(n === fixedBodyLen(tag), ProgramError.InvalidInstructionData);
  }
  return tag;
}

/** @fallback */
export function process(): void {
  const data = instructionData();
  const tag = decode(data);
  const rest = remainingAccounts();
  const id = programId();
  if (tag === 0n) initMarket(rest, data, id);
  else if (tag === 1n) initPortfolio(rest, id);
  else if (tag === 3n) deposit(rest, data, id);
  else if (tag === 4n) withdraw(rest, data, id);
  else if (tag === 6n) tradeNoCpi(rest, data, id);
  else if (tag === 5n) permissionlessCrank(rest, data, id);
  else if (tag === 45n) finalizeResetSide(rest, data, id);
  else if (tag === 28n) convertReleasedPnlHandler(rest, data, id);
  else if (tag === 8n) closePortfolio(rest, data, id);
  else if (tag === 48n) syncMaintenanceFee(rest, id);
  else if (tag === 32n) updateAuthority(rest, data, id);
  else if (tag === 37n || tag === 49n || tag === 58n || tag === 59n) updateMarketAuthorityPolicy(rest, data, id, toU64(tag));
  else if (tag === 38n) configurePermissionlessResolve(rest, data, id);
  else if (tag === 51n) updateBackingFeePolicy(rest, data, id);
  else if (tag === 53n) syncBackingDomainLedger(rest, data, id);
  else if (tag === 54n) syncInsuranceLedger(rest, id);
  else if (tag === 55n) updateTradeFeePolicy(rest, data, id);
  else if (tag === 60n) updateBaseUnitMints(rest, data, id);
  else if (tag === 65n) updateAssetAuthority(rest, data, id);
  else if (tag === 35n || tag === 62n) configureManagedMark(rest, data, id, tag === 35n);
  else if (tag === 34n) configureHybridOracle(rest, data, id);
  else if (tag === 36n || tag === 63n) pushManagedMark(rest, data, id, tag === 36n);
  else if (tag === 68n) setMatcherConfig(rest, data, id);
  else if (tag === 40n) updateAssetLifecycle(rest, data, id);
  else if (tag === 69n) restartAssetOracle(rest, data, id);
  else if (tag === 70n) canonicalizeSpentBackingHistory(rest, data, id);
  else if (tag === 43n) forfeitRecoveryLegHandler(rest, data, id);
  else if (tag === 44n) rebalanceReduceHandler(rest, data, id);
  else if (tag === 42n) cureAndCancelCloseHandler(rest, data, id);
  else if (tag === 30n) closeResolved(rest, id, NOT_A_CRANK, NOT_A_CRANK);
  else if (tag === 19n) resolveMarketHandler(rest, data, id);
  else if (tag === 39n) resolveStalePermissionless(rest, id);
  else if (tag === 9n || tag === 56n) topUpInsurance(rest, data, id, tag === 56n);
  else if (tag === 24n) topUpBackingBucket(rest, data, id);
  else if (tag === 50n) withdrawBackingBucket(rest, data, id);
  else if (tag === 52n) withdrawBackingEarnings(rest, data, id);
  else if (tag === 57n) withdrawInsuranceAsset(rest, data, id);
  else if (tag === 13n) closeSlab(rest, data, id);
  else if (tag === 46n) claimResolvedPayoutTopup(rest, id);
  else if (tag === 61n) swapSecondaryForPrimary(rest, data, id);
  else if (tag === 64n) forceCloseAbandonedAsset(rest, data, id);
  else if (tag === 66n) batchTradeNoCpi(rest, data, id);
  else if (tag === 10n) tradeCpi(rest, data, id);
  // Tag 67, the one known tag left: decode refused every other.
  else batchTradeCpi(rest, data, id);
}
