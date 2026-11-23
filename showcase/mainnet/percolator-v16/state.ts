// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs
// `mod constants` and `mod state`, and the persisted structs of aeyakovenko/percolator src/v16.rs, Copyright Anatoly
// Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// Every persisted struct of the program's accounts, as a packed TypeSOL struct mirroring the original's `#[repr(C)]`
// bytemuck Pod field for field, in declaration order, and the accessors of `mod state` that the on-chain build has
// (those under `#[cfg(not(target_os = "solana"))]` are host-only and not ported). Each account starts with a 16-byte
// header: magic "PERCV16\0", version 16, the kind, five zero bytes.
//
//   Market (kind 1)      header, WrapperConfig (448) at 16, GroupHeader (726) at 464, then one AssetSlot (1,845) per
//                        capacity from 1,190: the program's 512-byte oracle wrapper (AssetOracleProfile, 424, then
//                        AssetControlSequences, 88) and the engine's EngineAssetSlot (1,333).
//   Portfolio (kind 2)   header, Portfolio (9,419) at 16, PortfolioMatcherConfig (96 of 104 reserved bytes) at 9,435,
//                        the portfolio id at 9,539, the owner-state sequence at 9,547, the matcher expiry at 9,555:
//                        9,563 bytes.
//   Ledgers (kinds 3, 4) header, then BackingDomainLedger (224) or InsuranceLedger (160).
//   Closed market (5)    the header alone.
//
// The engine's structs are built from byte-array integers (`V16PodU64` is `[u8; 8]`, alignment 1): here they are
// plain integers of the same width in a packed struct, the same little-endian bytes (`V16PodU64::get` / `::new` are
// the read and the write of the field). The program's wrapper structs use native integers with explicit padding
// fields; u128 is aligned to 16 on the host that printed the layout fixture and to 8 on SBF, and neither leaves
// padding (Pod refuses it), so the packed struct is the same bytes. A Rust field whose name starts with `_` is named
// without it here (TypeSOL reserves the prefix), its Rust name kept with @idlName. The test
// showcase/test/percolator-v16-state.test.ts ties every struct below to the offsets and sizes rustc printed for the
// pinned sources (showcase/test/fixtures/percolator-v16-layout.json), from the compiler's own model of this file.
//
// The original reads with `bytemuck::try_from_bytes` (views) or `pod_read_unaligned` (copies) after checking the
// range itself (`data.get(range).ok_or(InvalidAccountLen)`). Here each accessor makes the original's checks and returns
// the offset; the caller binds the view (`loadRawAt<GroupHeader>(market, marketHeaderAt(market))`). A copy the original
// mutates and writes back is a view mutated in place: equivalent wherever a later failure fails the transaction, which
// NOTES.md records site by site where it is not.
import {
  type FixedArray,
  type Inout,
  type Pubkey,
  type RemainingAccount,
  type i64,
  type i128,
  type u8,
  type u16,
  type u32,
  type u64,
  type u128,
  ProgramError,
  loadRawAt,
  pubkey,
  readData,
  require,
  u64 as toU64,
} from "typesol";
import { PercolatorError } from "./errors.js";

// ---- mod constants -------------------------------------------------------------------------------------------------

/** "PERCV16\0". */
export const MAGIC = 0x5045524356313600n;
export const VERSION = 16n;
export const KIND_MARKET = 1n;
export const KIND_PORTFOLIO = 2n;
export const KIND_BACKING_DOMAIN_LEDGER = 3n;
export const KIND_INSURANCE_LEDGER = 4n;
export const KIND_CLOSED_MARKET = 5n;

export const HEADER_LEN = 16n;
export const WRAPPER_CONFIG_LEN = 448n;
export const ASSET_ORACLE_PROFILE_LEN = 424n;
export const ASSET_ORACLE_WRAPPER_LEN = 512n;
export const ASSET_CONTROL_SEQUENCES_OFF = 424n;
export const ASSET_CONTROL_SEQUENCES_LEN = 88n;
/** size_of::<MarketGroupV16HeaderAccount>(). */
export const MARKET_GROUP_LEN = 726n;
/** size_of::<EngineAssetSlotV16Account>(). */
export const ENGINE_ASSET_SLOT_LEN = 1333n;
/** size_of::<Market<[u8; 512]>>(): the 512-byte wrapper, then the engine slot. */
export const MARKET_ASSET_SLOT_LEN = 1845n;
/** size_of::<PortfolioAccountV16Account>(). */
export const PORTFOLIO_STATE_LEN = 9419n;
export const PORTFOLIO_SOURCE_DOMAIN_LEN = 196n;
export const MARKET_GROUP_OFF = 464n;
export const MIN_MARKET_ACCOUNT_LEN = 1190n;
export const DEFAULT_MARKET_SLOT_CAPACITY = 1n;
export const MARKET_ACCOUNT_LEN = 3035n;
export const PORTFOLIO_ENGINE_ACCOUNT_LEN = 9435n;
export const PORTFOLIO_MATCHER_CONFIG_OFF = 9435n;
export const PORTFOLIO_MATCHER_CONFIG_LEN = 104n;
export const PORTFOLIO_MATCHER_CONTROL_OFF = 9531n;
export const PORTFOLIO_ID_OFF = 9539n;
export const PORTFOLIO_ID_LEN = 8n;
/** The shared retained owner-state sequence (named MATCHER_SEQUENCE in the original's persisted-layout constants). */
export const PORTFOLIO_MATCHER_SEQUENCE_OFF = 9547n;
export const PORTFOLIO_MATCHER_SEQUENCE_LEN = 8n;
export const PORTFOLIO_LEGACY_ACCOUNT_LEN = 9547n;
export const PORTFOLIO_MATCHER_EXPIRY_OFF = 9555n;
export const PORTFOLIO_MATCHER_EXPIRY_LEN = 8n;
export const PORTFOLIO_PRE_EXPIRY_ACCOUNT_LEN = 9555n;
export const PORTFOLIO_ACCOUNT_LEN = 9563n;
export const BACKING_DOMAIN_LEDGER_ACCOUNT_LEN = 240n;
export const INSURANCE_LEDGER_ACCOUNT_LEN = 176n;
export const MAX_MATCHER_TAIL_ACCOUNTS = 32n;
export const MATCHER_ABI_VERSION = 3n;
export const MATCHER_CONTEXT_MIN_LEN = 64n;
export const ORACLE_LEG_CAP = 3n;
export const ORACLE_MODE_MANUAL = 0n;
export const ORACLE_MODE_HYBRID_AFTER_HOURS = 1n;
export const ORACLE_MODE_EWMA_MARK = 2n;
export const ORACLE_MODE_AUTH_MARK = 3n;
export const EFFECTIVE_PRICE_PROVENANCE_AUTHENTICATED = 0n;
export const EFFECTIVE_PRICE_PROVENANCE_TRADE_DRIVEN = 1n;
export const ORACLE_LEG_FLAG_DIVIDE_LEG2 = 1n;
export const ORACLE_LEG_FLAG_DIVIDE_LEG3 = 2n;
export const ORACLE_LEG_FLAGS_MASK = 3n;
/** `!ORACLE_LEG_FLAGS_MASK` as a u8. */
export const ORACLE_LEG_FLAGS_UNKNOWN = 0xfcn;
export const SWITCHBOARD_RESULT_SCALE = 1000000000000n;
export const DEFAULT_MARK_EWMA_HALFLIFE_SLOTS = 600n;
export const MAX_DYNAMIC_TRADE_FEE_BPS = 10000n;
export const MAX_PERMISSIONLESS_RESOLVE_STALE_SLOTS = 6480000n;
export const MAX_FORCE_CLOSE_DELAY_SLOTS = 10000000n;
export const WRAPPER_MAX_PORTFOLIO_ASSETS = 14n;
export const WRAPPER_MAX_BOUNDED_SOURCE_DOMAINS = 28n;
export const WRAPPER_SOURCE_LIEN_REFRESH_LEG_WEIGHT = 6n;
export const WRAPPER_MAX_SOURCE_LIEN_REFRESH_WORK = 72n;

/** Engine `MAX_ORACLE_PRICE` (src/lib.rs). */
export const MAX_ORACLE_PRICE = 1000000000000n;
/** `offset_of!(WrapperConfigV16, _padding0)`: the one-bit maintenance-fee split carry (MaintenanceFeeSplitCarry). */
export const MAINTENANCE_FEE_SPLIT_CARRY_OFF = 197n;
/** The all-zero key (`[0u8; 32]`). */
export const ZERO_KEY = pubkey("11111111111111111111111111111111");

// ---- The account header -------------------------------------------------------------------------------------------

/** The 16 bytes every account starts with (`write_header`): magic, version, kind, then zeros. */
export interface AccountHeader {
  magic: u64;
  version: u16;
  kind: u8;
  zero: FixedArray<u8, 5>;
}

// ---- The program's wrapper structs (src/v16_program.rs mod state) ---------------------------------------------------

/** `WrapperConfigV16` (448 bytes at 16 of the market). */
export interface WrapperConfig {
  marketauth: Pubkey;
  collateral_mint: Pubkey;
  secondary_collateral_mint: Pubkey;
  maintenance_fee_per_slot: u128;
  permissionless_market_init_fee: u128;
  trade_fee_base_bps: u64;
  permissionless_resolve_stale_slots: u64;
  force_close_delay_slots: u64;
  last_good_oracle_slot: u64;
  terminal_slab_scan_progress: u128;
  /** @idlName _reserved_insurance_withdraw_max_bps */
  reserved_insurance_withdraw_max_bps: u16;
  liquidation_cranker_fee_share_bps: u16;
  maintenance_cranker_fee_share_bps: u16;
  backing_trade_fee_bps_long: u16;
  unit_scale: u32;
  conf_filter_bps: u16;
  backing_trade_fee_bps_short: u16;
  /** @idlName _reserved_insurance_withdraw_deposits_only */
  reserved_insurance_withdraw_deposits_only: u8;
  oracle_mode: u8;
  oracle_leg_count: u8;
  oracle_leg_flags: u8;
  invert: u8;
  /** The maintenance-fee split carry (0 or 1), under its historical name. @idlName _padding0 */
  padding0: u8;
  free_market_slot_count: u16;
  /** @idlName _reserved_insurance_withdraw_cooldown_slots */
  reserved_insurance_withdraw_cooldown_slots: u64;
  /** @idlName _reserved_last_insurance_withdraw_slot */
  reserved_last_insurance_withdraw_slot: u64;
  max_staleness_secs: u64;
  hybrid_soft_stale_slots: u64;
  mark_ewma_e6: u64;
  mark_ewma_last_slot: u64;
  mark_ewma_halflife_slots: u64;
  mark_min_fee: u64;
  oracle_target_price_e6: u64;
  oracle_target_publish_time: i64;
  oracle_leg_feeds: FixedArray<Pubkey, 3>;
  oracle_leg_prices_e6: FixedArray<u64, 3>;
  oracle_leg_publish_times: FixedArray<i64, 3>;
  backing_trade_fee_policy_count: u16;
  backing_trade_fee_insurance_share_bps_long: u16;
  backing_trade_fee_insurance_share_bps_short: u16;
  fee_redirect_to_market_0_bps: u16;
  matcher_req_seq: u64;
  next_portfolio_id: u64;
}

/** `AssetOracleProfileV16` (424 bytes: the first part of each asset slot's 512-byte wrapper). */
export interface AssetOracleProfile {
  oracle_mode: u8;
  oracle_leg_count: u8;
  oracle_leg_flags: u8;
  invert: u8;
  unit_scale: u32;
  conf_filter_bps: u16;
  backing_trade_fee_bps_long: u16;
  backing_trade_fee_bps_short: u16;
  backing_trade_fee_insurance_share_bps_long: u16;
  backing_trade_fee_insurance_share_bps_short: u16;
  price_move_remainder_bps_num: u16;
  effective_price_provenance: u8;
  /** @idlName _padding0 */
  padding0: FixedArray<u8, 3>;
  insurance_authority: Pubkey;
  insurance_operator: Pubkey;
  backing_bucket_authority: Pubkey;
  oracle_authority: Pubkey;
  max_staleness_secs: u64;
  hybrid_soft_stale_slots: u64;
  mark_ewma_e6: u64;
  mark_ewma_last_slot: u64;
  mark_ewma_halflife_slots: u64;
  mark_min_fee: u64;
  oracle_target_price_e6: u64;
  oracle_target_publish_time: i64;
  last_good_oracle_slot: u64;
  oracle_leg_feeds: FixedArray<Pubkey, 3>;
  oracle_leg_prices_e6: FixedArray<u64, 3>;
  oracle_leg_publish_times: FixedArray<i64, 3>;
  asset_admin: Pubkey;
  funding_mark_e6: u64;
  funding_mark_pending_e6: u64;
  funding_mark_pending_slot: u64;
}

/** `AssetControlSequencesV16` (88 bytes at 424 of each asset slot's wrapper). */
export interface AssetControlSequences {
  oracle_observation: u64;
  backing_fee: u64;
  authority_epoch: u64;
  trade_fee: u64;
  liquidation_fee: u64;
  maintenance_fee: u64;
  fee_redirect: u64;
  market_init_fee: u64;
  permissionless_resolve: u64;
  insurance_top_up: u64;
  backing_top_up: u64;
}

/** An asset slot's `[u8; ASSET_ORACLE_WRAPPER_LEN]` as the program uses it: the profile, then the sequences. */
export interface AssetOracleWrapper {
  profile: AssetOracleProfile;
  controls: AssetControlSequences;
}

/** `BackingDomainLedgerAccountV16` (224 bytes after the header of a kind-3 account). */
export interface BackingDomainLedger {
  market_group: Pubkey;
  authority: Pubkey;
  total_principal_atoms: u128;
  total_deposited_atoms: u128;
  total_principal_withdrawn_atoms: u128;
  total_earnings_atoms: u128;
  total_earnings_withdrawn_atoms: u128;
  last_observed_bucket_earnings_atoms: u128;
  cumulative_loss_atoms: u128;
  cumulative_recovery_atoms: u128;
  last_observed_unavailable_principal_atoms: u128;
  domain: u16;
  /** @idlName _padding */
  padding: FixedArray<u8, 14>;
}

/** `InsuranceLedgerAccountV16` (160 bytes after the header of a kind-4 account). */
export interface InsuranceLedger {
  market_group: Pubkey;
  authority: Pubkey;
  total_principal_atoms: u128;
  total_deposited_atoms: u128;
  total_withdrawn_atoms: u128;
  cumulative_profit_atoms: u128;
  cumulative_loss_atoms: u128;
  last_observed_insurance_atoms: u128;
}

/** `PortfolioMatcherConfigV16` (96 bytes at 9,435 of a portfolio; 104 are reserved). */
export interface PortfolioMatcherConfig {
  matcher_program: Pubkey;
  matcher_context: Pubkey;
  matcher_delegate: Pubkey;
  /** Bit 0 enabled, bits 1..49 the position epoch, bits 50..63 the LP's trade-fee cap in bps. */
  control: u64;
}

// ---- The engine's market group (src/v16.rs) ------------------------------------------------------------------------

/** `V16ConfigAccount` (249 bytes). */
export interface Config {
  max_portfolio_assets: u16;
  max_market_slots: u32;
  min_nonzero_mm_req: u128;
  min_nonzero_im_req: u128;
  h_min: u64;
  h_max: u64;
  maintenance_margin_bps: u64;
  initial_margin_bps: u64;
  max_trading_fee_bps: u64;
  liquidation_fee_bps: u64;
  liquidation_fee_cap: u128;
  min_liquidation_abs: u128;
  max_accrual_dt_slots: u64;
  max_abs_funding_e9_per_slot: u64;
  min_funding_lifetime_slots: u64;
  max_price_move_bps_per_slot: u64;
  max_account_b_settlement_chunks: u64;
  max_bankrupt_close_chunks: u64;
  max_bankrupt_close_lifetime_slots: u64;
  asset_activation_cooldown_slots: u64;
  public_b_chunk_atoms: u128;
  max_recovery_fallback_deviation_bps: u64;
  backing_fee_base_rate_e9_per_slot: u64;
  backing_fee_kink_util_bps: u64;
  backing_fee_slope_at_kink_e9_per_slot: u64;
  backing_fee_slope_above_kink_e9_per_slot: u64;
  backing_freshness_buckets: u8;
  margin_mode_realizable_full_shared_cross_margin: u8;
  source_credit_lien_required: u8;
  insurance_credit_reservation_required: u8;
  permissionless_recovery_enabled: u8;
  recovery_fallback_price_enabled: u8;
  recovery_fallback_envelope_enabled: u8;
  credit_lien_revalidation_required: u8;
  stale_certificate_penalty_enabled: u8;
  full_refresh_required_for_favorable_actions: u8;
  public_liveness_profile_crank_forward: u8;
}

/** `V16OptionalRecoveryReasonAccount` (2 bytes). */
export interface OptionalRecoveryReason {
  present: u8;
  value: u8;
}

/** `ResolvedPayoutLedgerV16Account` (90 bytes). */
export interface ResolvedPayoutLedger {
  snapshot_residual: u128;
  terminal_claim_exact_receipts_num: u128;
  terminal_claim_bound_unreceipted_num: u128;
  current_payout_rate_num: u128;
  current_payout_rate_den: u128;
  snapshot_slot: u64;
  payout_halted: u8;
  finalized: u8;
}

/** `MarketGroupV16HeaderAccount` (726 bytes at 464 of the market). */
export interface GroupHeader {
  market_group_id: Pubkey;
  config: Config;
  asset_slot_capacity: u32;
  vault: u128;
  insurance: u128;
  c_tot: u128;
  pnl_pos_tot: u128;
  pnl_pos_bound_tot_num: u128;
  pnl_pos_bound_tot: u128;
  pnl_matured_pos_tot: u128;
  backing_provider_earnings_total: u128;
  source_claim_bound_total_num: u128;
  source_fresh_backing_total_num: u128;
  source_insurance_credit_reserved_total_atoms: u128;
  insurance_domain_budget_remaining_total: u128;
  resolved_payout_blocker_count: u64;
  materialized_portfolio_count: u64;
  stale_certificate_count: u64;
  b_stale_account_count: u64;
  negative_pnl_account_count: u64;
  risk_epoch: u64;
  asset_set_epoch: u64;
  asset_activation_count: u64;
  last_asset_activation_slot: u64;
  next_market_id: u64;
  oracle_epoch: u64;
  funding_epoch: u64;
  slot_last: u64;
  current_slot: u64;
  bankruptcy_hlock_active: u8;
  threshold_stress_active: u8;
  loss_stale_active: u8;
  recovery_reason: OptionalRecoveryReason;
  mode: u8;
  resolved_slot: u64;
  payout_snapshot: u128;
  payout_snapshot_pnl_pos_tot: u128;
  payout_snapshot_captured: u8;
  resolved_payout_ledger: ResolvedPayoutLedger;
}

// ---- The engine's asset slot ----------------------------------------------------------------------------------------

/** `AssetStateV16Account` (515 bytes). */
export interface AssetState {
  market_id: u64;
  retired_slot: u64;
  lifecycle: u8;
  raw_oracle_target_price: u64;
  effective_price: u64;
  fund_px_last: u64;
  slot_last: u64;
  a_long: u128;
  a_short: u128;
  k_long: i128;
  k_short: i128;
  f_long_num: i128;
  f_short_num: i128;
  kf_epoch_long: u64;
  kf_epoch_short: u64;
  k_epoch_start_long: i128;
  k_epoch_start_short: i128;
  f_epoch_start_long_num: i128;
  f_epoch_start_short_num: i128;
  b_long_num: u128;
  b_short_num: u128;
  b_epoch_start_long_num: u128;
  b_epoch_start_short_num: u128;
  oi_eff_long_q: u128;
  oi_eff_short_q: u128;
  stored_pos_count_long: u64;
  stored_pos_count_short: u64;
  stale_account_count_long: u64;
  stale_account_count_short: u64;
  pending_obligation_count_long: u64;
  pending_obligation_count_short: u64;
  loss_weight_sum_long: u128;
  loss_weight_sum_short: u128;
  social_loss_remainder_long_num: u128;
  social_loss_remainder_short_num: u128;
  social_loss_dust_long_num: u128;
  social_loss_dust_short_num: u128;
  explicit_unallocated_loss_long: u128;
  explicit_unallocated_loss_short: u128;
  epoch_long: u64;
  epoch_short: u64;
  mode_long: u8;
  mode_short: u8;
}

/** `SourceCreditStateV16Account` (184 bytes). */
export interface SourceCreditState {
  positive_claim_bound_num: u128;
  exact_positive_claim_num: u128;
  fresh_reserved_backing_num: u128;
  spent_backing_num: u128;
  provider_receivable_num: u128;
  valid_liened_backing_num: u128;
  impaired_liened_backing_num: u128;
  insurance_credit_reserved_num: u128;
  valid_liened_insurance_num: u128;
  impaired_liened_insurance_num: u128;
  credit_rate_num: u128;
  credit_epoch: u64;
}

/** `BackingBucketV16Account` (97 bytes). */
export interface BackingBucket {
  market_id: u64;
  fresh_unliened_backing_num: u128;
  valid_liened_backing_num: u128;
  consumed_liened_backing_num: u128;
  impaired_liened_backing_num: u128;
  utilization_fee_earnings: u128;
  expiry_slot: u64;
  status: u8;
}

/** `InsuranceCreditReservationV16Account` (72 bytes). */
export interface InsuranceCreditReservation {
  insurance_credit_reserved_num: u128;
  valid_liened_insurance_num: u128;
  impaired_liened_insurance_num: u128;
  consumed_insurance_num: u128;
  source_credit_epoch: u64;
}

/** `EngineAssetSlotV16Account` (1,333 bytes at 512 of each asset slot). */
export interface EngineAssetSlot {
  asset: AssetState;
  insurance_domain_budget_long: u128;
  insurance_domain_budget_short: u128;
  insurance_domain_spent_long: u128;
  insurance_domain_spent_short: u128;
  pending_domain_loss_barrier_long: u64;
  pending_domain_loss_barrier_short: u64;
  source_credit_long: SourceCreditState;
  source_credit_short: SourceCreditState;
  backing_long: BackingBucket;
  backing_short: BackingBucket;
  insurance_reservation_long: InsuranceCreditReservation;
  insurance_reservation_short: InsuranceCreditReservation;
  provider_principal_long_num: u128;
  provider_principal_short_num: u128;
}

/** `Market<[u8; 512]>` (1,845 bytes): one slot of the market account. */
export interface AssetSlot {
  wrapper: AssetOracleWrapper;
  engine: EngineAssetSlot;
}

// ---- The engine's portfolio -----------------------------------------------------------------------------------------

/** `ProvenanceHeaderV16Account` (100 bytes). */
export interface ProvenanceHeader {
  market_group_id: Pubkey;
  portfolio_account_id: Pubkey;
  owner: Pubkey;
  version: u16;
  layout_discriminator: u16;
}

/** `PortfolioLegV16Account` (152 bytes). */
export interface PortfolioLeg {
  active: u8;
  asset_index: u32;
  market_id: u64;
  side: u8;
  basis_pos_q: i128;
  a_basis: u128;
  k_snap: i128;
  f_snap: i128;
  kf_epoch_snap: u64;
  epoch_snap: u64;
  loss_weight: u128;
  b_snap: u128;
  b_rem: u128;
  b_epoch_snap: u64;
  b_stale: u8;
  stale: u8;
}

/** `HealthCertV16Account` (121 bytes; V16_ACTIVE_BITMAP_WORDS = 1). */
export interface HealthCert {
  certified_equity: i128;
  certified_initial_req: u128;
  certified_maintenance_req: u128;
  certified_liq_deficit: u128;
  certified_worst_case_loss: u128;
  cert_oracle_epoch: u64;
  cert_funding_epoch: u64;
  cert_risk_epoch: u64;
  cert_asset_set_epoch: u64;
  active_bitmap_at_cert: FixedArray<u64, 1>;
  valid: u8;
}

/** `CloseProgressLedgerV16Account` (184 bytes). */
export interface CloseProgressLedger {
  active: u8;
  finalized: u8;
  canceled: u8;
  close_id: u64;
  asset_index: u32;
  market_id: u64;
  domain_side: u8;
  gross_loss_at_close_start: u128;
  drift_reference_slot: u64;
  max_close_slot: u64;
  support_consumed: u128;
  junior_face_burned: u128;
  insurance_spent: u128;
  b_loss_booked: u128;
  explicit_loss_assigned: u128;
  quantity_adl_applied_q: u128;
  drift_consumed: u128;
  residual_remaining: u128;
}

/** `ResolvedPayoutReceiptV16Account` (66 bytes). */
export interface ResolvedPayoutReceipt {
  prior_bound_contribution_num: u128;
  live_released_face_at_receipt: u128;
  terminal_positive_claim_face: u128;
  paid_effective: u128;
  present: u8;
  finalized: u8;
}

/** `PortfolioSourceDomainV16Account` (196 bytes). */
export interface PortfolioSourceDomain {
  domain: u32;
  source_claim_market_id: u64;
  source_claim_bound_num: u128;
  source_claim_liened_num: u128;
  source_claim_counterparty_liened_num: u128;
  source_claim_insurance_liened_num: u128;
  source_lien_effective_reserved: u128;
  source_lien_counterparty_backing_num: u128;
  source_lien_insurance_backing_num: u128;
  source_lien_fee_last_slot: u64;
  source_claim_impaired_num: u128;
  source_lien_impaired_effective_reserved: u128;
  source_lien_capital_at_risk_fee_revenue: u128;
  source_lien_impaired_capital_at_risk_fee_revenue: u128;
}

/** `PortfolioAccountV16Account` (9,419 bytes at 16 of a portfolio): 16 leg slots, 32 source domains. */
export interface Portfolio {
  provenance_header: ProvenanceHeader;
  owner: Pubkey;
  capital: u128;
  pnl: i128;
  reserved_pnl: u128;
  residual_crystallized_loss_atoms_total: u128;
  residual_spent_principal_atoms_total: u128;
  residual_received_atoms_total: u128;
  funding_long_paid_atoms_total: u128;
  funding_long_received_atoms_total: u128;
  funding_short_paid_atoms_total: u128;
  funding_short_received_atoms_total: u128;
  fee_credits: i128;
  cancel_deposit_escrow: u128;
  last_fee_slot: u64;
  active_bitmap: FixedArray<u64, 1>;
  legs: FixedArray<PortfolioLeg, 16>;
  source_domains: FixedArray<PortfolioSourceDomain, 32>;
  health_cert: HealthCert;
  stale_state: u8;
  b_stale_state: u8;
  rebalance_lock: u8;
  liquidation_lock: u8;
  close_progress: CloseProgressLedger;
  resolved_payout_receipt: ResolvedPayoutReceipt;
}

// ---- Headers and kinds ----------------------------------------------------------------------------------------------

/** `check_header`: at least the header, the magic, the version, then the kind. */
export function checkHeader(a: RemainingAccount, kind: u8): void {
  require(a.dataLen >= HEADER_LEN, PercolatorError.InvalidAccountLen);
  require(readData<u64>(a, 0n) === MAGIC, PercolatorError.NotInitialized);
  require(readData<u16>(a, 8n) === VERSION, PercolatorError.InvalidVersion);
  require(readData<u8>(a, 10n) === kind, PercolatorError.InvalidAccountKind);
}

/** `check_portfolio_kind`. */
export function checkPortfolioKind(a: RemainingAccount): void {
  checkHeader(a, KIND_PORTFOLIO);
}

/** `is_initialized`: at least the header and the magic (the version and kind are not looked at). */
export function isInitialized(a: RemainingAccount): boolean {
  return a.dataLen >= HEADER_LEN && readData<u64>(a, 0n) === MAGIC;
}

/** `write_header` (after the caller's length check): the magic, the version, the kind, five zero bytes. */
export function writeHeaderView(h: Inout<AccountHeader>, kind: u8): void {
  h.magic = MAGIC;
  h.version = VERSION;
  h.kind = kind;
  for (let i = 0n; i < 5n; i++) h.zero.set(i, 0n);
}

// ---- Portfolio words after the engine state ------------------------------------------------------------------------

/** PortfolioMatcherConfigV16's control word, its fields as the original masks them. */
export const MATCHER_ENABLED_MASK = 1n;
export const MATCHER_POSITION_EPOCH_SHIFT = 1n;
export const MATCHER_POSITION_EPOCH_MAX = 0x1ffffffffffffn;
export const MATCHER_POSITION_EPOCH_MASK = 0x3fffffffffffen;
export const MATCHER_TRADE_FEE_CAP_SHIFT = 50n;
export const MATCHER_TRADE_FEE_CAP_MASK = 0xfffc000000000000n;

export function matcherEnabled(control: u64): u64 {
  return control & MATCHER_ENABLED_MASK;
}
export function matcherPositionEpoch(control: u64): u64 {
  return (control & MATCHER_POSITION_EPOCH_MASK) >> MATCHER_POSITION_EPOCH_SHIFT;
}
export function matcherTradeFeeCapBps(control: u64): u64 {
  return (control & MATCHER_TRADE_FEE_CAP_MASK) >> MATCHER_TRADE_FEE_CAP_SHIFT;
}
/** `PortfolioMatcherConfigV16::validate`: the fee cap at most 10,000 bps (InvalidAccountData). */
export function validateMatcherControl(control: u64): void {
  require(matcherTradeFeeCapBps(control) <= 10000n, ProgramError.InvalidAccountData);
}

/** The offset of the matcher config after `read_portfolio_matcher_config`'s checks (its `validate` is the caller's). */
export function portfolioMatcherConfigAt(p: RemainingAccount): u64 {
  checkHeader(p, KIND_PORTFOLIO);
  require(p.dataLen >= PORTFOLIO_MATCHER_CONFIG_OFF + PORTFOLIO_MATCHER_CONFIG_LEN, PercolatorError.InvalidAccountLen);
  return PORTFOLIO_MATCHER_CONFIG_OFF;
}

/** `read_portfolio_id`: a nonzero id (InvalidAccountData for 0). */
export function readPortfolioId(p: RemainingAccount): u64 {
  checkHeader(p, KIND_PORTFOLIO);
  require(p.dataLen >= PORTFOLIO_ID_OFF + 8n, PercolatorError.InvalidAccountLen);
  const id = readData<u64>(p, PORTFOLIO_ID_OFF);
  require(id !== 0n, ProgramError.InvalidAccountData);
  return id;
}

/** `read_portfolio_matcher_sequence`: 0 for a legacy account that ends before it. */
export function readPortfolioMatcherSequence(p: RemainingAccount): u64 {
  checkHeader(p, KIND_PORTFOLIO);
  if (p.dataLen === PORTFOLIO_LEGACY_ACCOUNT_LEN) return 0n;
  require(p.dataLen >= PORTFOLIO_MATCHER_SEQUENCE_OFF + 8n, PercolatorError.InvalidAccountLen);
  return readData<u64>(p, PORTFOLIO_MATCHER_SEQUENCE_OFF);
}

/** `read_portfolio_matcher_expiry`: 0 for an account that ends before it. */
export function readPortfolioMatcherExpiry(p: RemainingAccount): u64 {
  checkHeader(p, KIND_PORTFOLIO);
  if (p.dataLen <= PORTFOLIO_PRE_EXPIRY_ACCOUNT_LEN) return 0n;
  require(p.dataLen >= PORTFOLIO_MATCHER_EXPIRY_OFF + 8n, PercolatorError.InvalidAccountLen);
  return readData<u64>(p, PORTFOLIO_MATCHER_EXPIRY_OFF);
}

/** `read_portfolio_position_epoch`: the control word's episode, after `validate`. */
export function readPortfolioPositionEpoch(p: RemainingAccount): u64 {
  checkHeader(p, KIND_PORTFOLIO);
  require(p.dataLen >= PORTFOLIO_MATCHER_CONTROL_OFF + 8n, PercolatorError.InvalidAccountLen);
  const control = readData<u64>(p, PORTFOLIO_MATCHER_CONTROL_OFF);
  validateMatcherControl(control);
  return matcherPositionEpoch(control);
}

/** `next_portfolio_matcher_sequence`: the expected value (EngineStale otherwise), plus one. */
export function nextPortfolioMatcherSequence(current: u64, expected: u64): u64 {
  require(current === expected, PercolatorError.EngineStale);
  require(current !== 0xffffffffffffffffn, PercolatorError.EngineCounterOverflow);
  return current + 1n;
}

/** `matcher_capability_is_live`. */
export function matcherCapabilityIsLive(expirySlot: u64, currentSlot: u64): boolean {
  return expirySlot !== 0n && currentSlot < expirySlot;
}

/** `matcher_capability_config_is_valid`. */
export function matcherCapabilityConfigIsValid(enabled: u8, tradeFeeCapBps: u16, expirySlot: u64, currentSlot: u64): boolean {
  if (enabled === 0n) return tradeFeeCapBps === 0n && expirySlot === 0n;
  if (enabled === 1n) return tradeFeeCapBps <= 10000n && matcherCapabilityIsLive(expirySlot, currentSlot);
  return false;
}

/** `allocate_portfolio_id`: 0 (a market from before the counter) starts at 1; returns the id (the next is id + 1). */
export function allocatePortfolioId(next: u64): u64 {
  const id = next === 0n ? 1n : next;
  require(id !== 0xffffffffffffffffn, PercolatorError.EngineCounterOverflow);
  return id;
}

// ---- Ledgers --------------------------------------------------------------------------------------------------------

/** The offset of the ledger after `read_backing_domain_ledger`'s length and header checks. */
export function backingDomainLedgerAt(a: RemainingAccount): u64 {
  require(a.dataLen === BACKING_DOMAIN_LEDGER_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  checkHeader(a, KIND_BACKING_DOMAIN_LEDGER);
  return HEADER_LEN;
}

/** `validate_backing_domain_ledger`: both keys set and the padding zero (InvalidAccountData). */
export function validateBackingDomainLedger(l: BackingDomainLedger): void {
  let padZero = true;
  for (let i = 0n; i < 14n; i++) if (l.padding.get(i) !== 0n) padZero = false;
  require(l.market_group !== ZERO_KEY && l.authority !== ZERO_KEY && padZero, ProgramError.InvalidAccountData);
}

/** The offset of the ledger after `read_insurance_ledger`'s length and header checks. */
export function insuranceLedgerAt(a: RemainingAccount): u64 {
  require(a.dataLen === INSURANCE_LEDGER_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  checkHeader(a, KIND_INSURANCE_LEDGER);
  return HEADER_LEN;
}

/** `validate_insurance_ledger`: both keys set (InvalidAccountData). */
export function validateInsuranceLedger(l: InsuranceLedger): void {
  require(l.market_group !== ZERO_KEY && l.authority !== ZERO_KEY, ProgramError.InvalidAccountData);
}

// ---- The wrapper config and the asset oracle profiles ----------------------------------------------------------------

/** `backing_trade_fee_policy_shape_ok`. */
export function backingTradeFeePolicyShapeOk(feeBps: u16, insuranceShareBps: u16): boolean {
  return feeBps <= 10000n && insuranceShareBps <= 10000n && (feeBps !== 0n || insuranceShareBps === 0n);
}

/** `valid_engine_oracle_price`. */
export function validEngineOraclePrice(price: u64): boolean {
  return price !== 0n && price <= MAX_ORACLE_PRICE;
}

/** `oracle_v16::oracle_leg_config_ok`: the leg count, the divide flags and distinct nonzero feeds. */
export function oracleLegConfigOk(count: u8, flags: u8, feeds: FixedArray<Pubkey, 3>): boolean {
  return oracleLegFeedsOk(count, flags, feeds.get(0n), feeds.get(1n), feeds.get(2n));
}

/** `oracle_leg_config_ok` on three feeds given one by one (an instruction's arguments). */
export function oracleLegFeedsOk(count: u8, flags: u8, f0: Pubkey, f1: Pubkey, f2: Pubkey): boolean {
  if ((flags & ORACLE_LEG_FLAGS_UNKNOWN) !== 0n) return false;
  if (count === 0n) return flags === 0n && f0 === ZERO_KEY && f1 === ZERO_KEY && f2 === ZERO_KEY;
  if (count > ORACLE_LEG_CAP || f0 === ZERO_KEY) return false;
  if (count === 1n) return flags === 0n && f1 === ZERO_KEY && f2 === ZERO_KEY;
  if (f1 === ZERO_KEY || f1 === f0) return false;
  if (count === 2n) return (flags & ORACLE_LEG_FLAG_DIVIDE_LEG3) === 0n && f2 === ZERO_KEY;
  return f2 !== ZERO_KEY && f2 !== f0 && f2 !== f1;
}

/** Whether the three oracle legs (feeds, prices, publish times) are all zero. */
function legsEmpty(feeds: FixedArray<Pubkey, 3>, prices: FixedArray<u64, 3>, times: FixedArray<i64, 3>): boolean {
  for (let i = 0n; i < 3n; i++) if (feeds.get(i) !== ZERO_KEY || prices.get(i) !== 0n || times.get(i) !== 0n) return false;
  return true;
}

/** `validate_wrapper_config`: every refusal is InvalidAccountData. */
export function validateWrapperConfig(c: WrapperConfig): void {
  const terminalScanShapeOk = c.terminal_slab_scan_progress <= 0xffffffffffffffffn;
  require(!(c.collateral_mint === ZERO_KEY || (c.secondary_collateral_mint !== ZERO_KEY && c.secondary_collateral_mint === c.collateral_mint)), ProgramError.InvalidAccountData);
  require(
    !(
      !terminalScanShapeOk ||
      c.reserved_insurance_withdraw_max_bps !== 0n ||
      c.reserved_insurance_withdraw_deposits_only !== 0n ||
      c.reserved_insurance_withdraw_cooldown_slots !== 0n ||
      c.reserved_last_insurance_withdraw_slot !== 0n ||
      c.liquidation_cranker_fee_share_bps > 10000n ||
      c.maintenance_cranker_fee_share_bps > 10000n ||
      !backingTradeFeePolicyShapeOk(c.backing_trade_fee_bps_long, c.backing_trade_fee_insurance_share_bps_long) ||
      !backingTradeFeePolicyShapeOk(c.backing_trade_fee_bps_short, c.backing_trade_fee_insurance_share_bps_short) ||
      c.conf_filter_bps > 10000n ||
      c.invert > 1n ||
      c.padding0 > 1n ||
      c.fee_redirect_to_market_0_bps > 10000n ||
      c.oracle_leg_count > ORACLE_LEG_CAP ||
      (c.oracle_leg_flags & ORACLE_LEG_FLAGS_UNKNOWN) !== 0n
    ),
    ProgramError.InvalidAccountData,
  );
  let base = 0n;
  if (c.backing_trade_fee_bps_long !== 0n) base += 1n;
  if (c.backing_trade_fee_bps_short !== 0n) base += 1n;
  require(toU64(c.backing_trade_fee_policy_count) >= base, ProgramError.InvalidAccountData);
  const mode = c.oracle_mode;
  if (mode === ORACLE_MODE_MANUAL) {
    require(c.oracle_leg_count === 0n && c.oracle_leg_flags === 0n, ProgramError.InvalidAccountData);
  } else if (mode === ORACLE_MODE_HYBRID_AFTER_HOURS) {
    require(
      !(
        c.oracle_leg_count === 0n ||
        c.max_staleness_secs === 0n ||
        c.hybrid_soft_stale_slots === 0n ||
        !validEngineOraclePrice(c.mark_ewma_e6) ||
        !validEngineOraclePrice(c.oracle_target_price_e6) ||
        !oracleLegConfigOk(c.oracle_leg_count, c.oracle_leg_flags, c.oracle_leg_feeds)
      ),
      ProgramError.InvalidAccountData,
    );
  } else if (mode === ORACLE_MODE_EWMA_MARK) {
    require(
      !(
        c.oracle_leg_count !== 0n ||
        c.oracle_leg_flags !== 0n ||
        c.invert !== 0n ||
        c.unit_scale !== 0n ||
        c.conf_filter_bps !== 0n ||
        c.max_staleness_secs !== 0n ||
        c.hybrid_soft_stale_slots !== 0n ||
        !validEngineOraclePrice(c.mark_ewma_e6) ||
        !validEngineOraclePrice(c.oracle_target_price_e6) ||
        c.mark_ewma_halflife_slots === 0n ||
        !legsEmpty(c.oracle_leg_feeds, c.oracle_leg_prices_e6, c.oracle_leg_publish_times)
      ),
      ProgramError.InvalidAccountData,
    );
  } else if (mode === ORACLE_MODE_AUTH_MARK) {
    require(
      !(
        c.oracle_leg_count !== 0n ||
        c.oracle_leg_flags !== 0n ||
        c.invert !== 0n ||
        c.unit_scale !== 0n ||
        c.conf_filter_bps !== 0n ||
        c.max_staleness_secs !== 0n ||
        c.hybrid_soft_stale_slots !== 0n ||
        !validEngineOraclePrice(c.mark_ewma_e6) ||
        !validEngineOraclePrice(c.oracle_target_price_e6) ||
        c.mark_ewma_e6 !== c.oracle_target_price_e6 ||
        c.mark_ewma_halflife_slots !== 0n ||
        c.mark_min_fee !== 0n ||
        !legsEmpty(c.oracle_leg_feeds, c.oracle_leg_prices_e6, c.oracle_leg_publish_times)
      ),
      ProgramError.InvalidAccountData,
    );
  } else {
    require(false, ProgramError.InvalidAccountData);
  }
}

/** `validate_asset_oracle_profile`: every refusal is InvalidAccountData. */
export function validateAssetOracleProfile(p: AssetOracleProfile): void {
  const padZero = p.padding0.get(0n) === 0n && p.padding0.get(1n) === 0n && p.padding0.get(2n) === 0n;
  require(
    !(
      p.conf_filter_bps > 10000n ||
      !backingTradeFeePolicyShapeOk(p.backing_trade_fee_bps_long, p.backing_trade_fee_insurance_share_bps_long) ||
      !backingTradeFeePolicyShapeOk(p.backing_trade_fee_bps_short, p.backing_trade_fee_insurance_share_bps_short) ||
      p.invert > 1n ||
      p.price_move_remainder_bps_num >= 10000n ||
      p.effective_price_provenance > EFFECTIVE_PRICE_PROVENANCE_TRADE_DRIVEN ||
      (p.oracle_mode !== ORACLE_MODE_HYBRID_AFTER_HOURS && p.effective_price_provenance !== EFFECTIVE_PRICE_PROVENANCE_AUTHENTICATED) ||
      !padZero ||
      p.oracle_leg_count > ORACLE_LEG_CAP ||
      (p.oracle_leg_flags & ORACLE_LEG_FLAGS_UNKNOWN) !== 0n ||
      (p.funding_mark_e6 !== 0n && !validEngineOraclePrice(p.funding_mark_e6)) ||
      (p.funding_mark_pending_e6 === 0n) !== (p.funding_mark_pending_slot === 0n) ||
      (p.funding_mark_pending_e6 !== 0n && (!validEngineOraclePrice(p.funding_mark_pending_e6) || p.funding_mark_e6 === 0n))
    ),
    ProgramError.InvalidAccountData,
  );
  const mode = p.oracle_mode;
  if (mode === ORACLE_MODE_MANUAL) {
    require(
      !(p.oracle_leg_count !== 0n || p.oracle_leg_flags !== 0n || !legsEmpty(p.oracle_leg_feeds, p.oracle_leg_prices_e6, p.oracle_leg_publish_times)),
      ProgramError.InvalidAccountData,
    );
  } else if (mode === ORACLE_MODE_HYBRID_AFTER_HOURS) {
    require(
      !(
        p.oracle_leg_count === 0n ||
        p.max_staleness_secs === 0n ||
        p.hybrid_soft_stale_slots === 0n ||
        !validEngineOraclePrice(p.mark_ewma_e6) ||
        !validEngineOraclePrice(p.oracle_target_price_e6) ||
        p.mark_ewma_halflife_slots === 0n ||
        !oracleLegConfigOk(p.oracle_leg_count, p.oracle_leg_flags, p.oracle_leg_feeds)
      ),
      ProgramError.InvalidAccountData,
    );
  } else if (mode === ORACLE_MODE_EWMA_MARK) {
    require(
      !(
        p.oracle_leg_count !== 0n ||
        p.oracle_leg_flags !== 0n ||
        p.invert !== 0n ||
        p.unit_scale !== 0n ||
        p.conf_filter_bps !== 0n ||
        p.max_staleness_secs !== 0n ||
        p.hybrid_soft_stale_slots !== 0n ||
        !validEngineOraclePrice(p.mark_ewma_e6) ||
        !validEngineOraclePrice(p.oracle_target_price_e6) ||
        p.mark_ewma_halflife_slots === 0n ||
        !legsEmpty(p.oracle_leg_feeds, p.oracle_leg_prices_e6, p.oracle_leg_publish_times)
      ),
      ProgramError.InvalidAccountData,
    );
  } else if (mode === ORACLE_MODE_AUTH_MARK) {
    require(
      !(
        p.oracle_leg_count !== 0n ||
        p.oracle_leg_flags !== 0n ||
        p.invert !== 0n ||
        p.unit_scale !== 0n ||
        p.conf_filter_bps !== 0n ||
        p.max_staleness_secs !== 0n ||
        p.hybrid_soft_stale_slots !== 0n ||
        !validEngineOraclePrice(p.mark_ewma_e6) ||
        !validEngineOraclePrice(p.oracle_target_price_e6) ||
        p.mark_ewma_e6 !== p.oracle_target_price_e6 ||
        p.mark_ewma_halflife_slots !== 0n ||
        p.mark_min_fee !== 0n ||
        !legsEmpty(p.oracle_leg_feeds, p.oracle_leg_prices_e6, p.oracle_leg_publish_times)
      ),
      ProgramError.InvalidAccountData,
    );
  } else {
    require(false, ProgramError.InvalidAccountData);
  }
}

/** `validate_asset_oracle_profile` as a value: false where it refuses. */
export function assetOracleProfileOk(p: AssetOracleProfile): boolean {
  const padZero = p.padding0.get(0n) === 0n && p.padding0.get(1n) === 0n && p.padding0.get(2n) === 0n;
  if (
      
      p.conf_filter_bps > 10000n ||
      !backingTradeFeePolicyShapeOk(p.backing_trade_fee_bps_long, p.backing_trade_fee_insurance_share_bps_long) ||
      !backingTradeFeePolicyShapeOk(p.backing_trade_fee_bps_short, p.backing_trade_fee_insurance_share_bps_short) ||
      p.invert > 1n ||
      p.price_move_remainder_bps_num >= 10000n ||
      p.effective_price_provenance > EFFECTIVE_PRICE_PROVENANCE_TRADE_DRIVEN ||
      (p.oracle_mode !== ORACLE_MODE_HYBRID_AFTER_HOURS && p.effective_price_provenance !== EFFECTIVE_PRICE_PROVENANCE_AUTHENTICATED) ||
      !padZero ||
      p.oracle_leg_count > ORACLE_LEG_CAP ||
      (p.oracle_leg_flags & ORACLE_LEG_FLAGS_UNKNOWN) !== 0n ||
      (p.funding_mark_e6 !== 0n && !validEngineOraclePrice(p.funding_mark_e6)) ||
      (p.funding_mark_pending_e6 === 0n) !== (p.funding_mark_pending_slot === 0n) ||
      (p.funding_mark_pending_e6 !== 0n && (!validEngineOraclePrice(p.funding_mark_pending_e6) || p.funding_mark_e6 === 0n))
    )
      return false;
  const mode = p.oracle_mode;
  if (mode === ORACLE_MODE_MANUAL) {
    if (
      p.oracle_leg_count !== 0n || p.oracle_leg_flags !== 0n || !legsEmpty(p.oracle_leg_feeds, p.oracle_leg_prices_e6, p.oracle_leg_publish_times))
      return false;
  } else if (mode === ORACLE_MODE_HYBRID_AFTER_HOURS) {
    if (
      
        p.oracle_leg_count === 0n ||
        p.max_staleness_secs === 0n ||
        p.hybrid_soft_stale_slots === 0n ||
        !validEngineOraclePrice(p.mark_ewma_e6) ||
        !validEngineOraclePrice(p.oracle_target_price_e6) ||
        p.mark_ewma_halflife_slots === 0n ||
        !oracleLegConfigOk(p.oracle_leg_count, p.oracle_leg_flags, p.oracle_leg_feeds)
      )
      return false;
  } else if (mode === ORACLE_MODE_EWMA_MARK) {
    if (
      
        p.oracle_leg_count !== 0n ||
        p.oracle_leg_flags !== 0n ||
        p.invert !== 0n ||
        p.unit_scale !== 0n ||
        p.conf_filter_bps !== 0n ||
        p.max_staleness_secs !== 0n ||
        p.hybrid_soft_stale_slots !== 0n ||
        !validEngineOraclePrice(p.mark_ewma_e6) ||
        !validEngineOraclePrice(p.oracle_target_price_e6) ||
        p.mark_ewma_halflife_slots === 0n ||
        !legsEmpty(p.oracle_leg_feeds, p.oracle_leg_prices_e6, p.oracle_leg_publish_times)
      )
      return false;
  } else if (mode === ORACLE_MODE_AUTH_MARK) {
    if (
      
        p.oracle_leg_count !== 0n ||
        p.oracle_leg_flags !== 0n ||
        p.invert !== 0n ||
        p.unit_scale !== 0n ||
        p.conf_filter_bps !== 0n ||
        p.max_staleness_secs !== 0n ||
        p.hybrid_soft_stale_slots !== 0n ||
        !validEngineOraclePrice(p.mark_ewma_e6) ||
        !validEngineOraclePrice(p.oracle_target_price_e6) ||
        p.mark_ewma_e6 !== p.oracle_target_price_e6 ||
        p.mark_ewma_halflife_slots !== 0n ||
        p.mark_min_fee !== 0n ||
        !legsEmpty(p.oracle_leg_feeds, p.oracle_leg_prices_e6, p.oracle_leg_publish_times)
      )
      return false;
  } else {
    return false;
  }
  return true;
}

/** The offset of the wrapper config after `read_wrapper_config_from_bytes`'s range check (its validation is the caller's). */
export function wrapperConfigAt(m: RemainingAccount): u64 {
  require(m.dataLen >= HEADER_LEN + WRAPPER_CONFIG_LEN, PercolatorError.InvalidAccountLen);
  return HEADER_LEN;
}

// ---- Market lengths and slots ---------------------------------------------------------------------------------------

/** `market_account_len_for_capacity`. */
export function marketAccountLenForCapacity(capacity: u64): u64 {
  return MARKET_GROUP_OFF + MARKET_GROUP_LEN + capacity * MARKET_ASSET_SLOT_LEN;
}

/**
 * `market_slot_capacity`: at least the group header (InvalidAccountLen), and a whole number of slots after it
 * (`dynamic_asset_slot_capacity_from_account_len`, its InvalidConfig mapped to InvalidAccountData).
 */
export function marketSlotCapacity(m: RemainingAccount): u64 {
  require(m.dataLen >= MARKET_GROUP_OFF + MARKET_GROUP_LEN, PercolatorError.InvalidAccountLen);
  const trailing = m.dataLen - MARKET_GROUP_OFF - MARKET_GROUP_LEN;
  require(trailing % MARKET_ASSET_SLOT_LEN === 0n, ProgramError.InvalidAccountData);
  return trailing / MARKET_ASSET_SLOT_LEN;
}

/**
 * `validate_market_dynamic_len`: the capacity; `validate_dynamic_market_group_account_len` then recomputes the length
 * from it, which equals the account's by construction of the capacity (no further refusal is reachable).
 */
export function validateMarketDynamicLen(m: RemainingAccount): u64 {
  return marketSlotCapacity(m);
}

/** `dynamic_slot_offset`: where slot `i` starts (its wrapper). No overflow is reachable for a u32 index. */
export function dynamicSlotOffset(i: u64): u64 {
  return MARKET_GROUP_OFF + MARKET_GROUP_LEN + i * MARKET_ASSET_SLOT_LEN;
}

/** The offset of slot `i`'s engine part after `asset_slot_wire`'s range check (InvalidAccountLen past the data). */
export function assetSlotAt(m: RemainingAccount, i: u64): u64 {
  const start = dynamicSlotOffset(i) + ASSET_ORACLE_WRAPPER_LEN;
  require(start + ENGINE_ASSET_SLOT_LEN <= m.dataLen, PercolatorError.InvalidAccountLen);
  return start;
}

/** `asset_oracle_profile_range`: an index below the capacity (InvalidInstruction), the profile's offset. */
export function assetOracleProfileAt(m: RemainingAccount, i: u64): u64 {
  const capacity = marketSlotCapacity(m);
  require(i < capacity, PercolatorError.InvalidInstruction);
  return dynamicSlotOffset(i);
}

/** `asset_control_sequences_range`: an index below the capacity (InvalidInstruction), the sequences' offset. */
export function assetControlSequencesAt(m: RemainingAccount, i: u64): u64 {
  const capacity = marketSlotCapacity(m);
  require(i < capacity, PercolatorError.InvalidInstruction);
  return dynamicSlotOffset(i) + ASSET_CONTROL_SEQUENCES_OFF;
}

/**
 * `read_asset_oracle_profile`: the header, the range, then `validate_asset_oracle_profile` on the profile; its offset.
 * (`write_asset_oracle_profile` makes the same checks in the same order, validating the profile it writes: in place,
 * the caller validates after changing the view.)
 */
export function readAssetOracleProfileAt(m: RemainingAccount, i: u64): u64 {
  checkHeader(m, KIND_MARKET);
  const at = assetOracleProfileAt(m, i);
  validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
  return at;
}

/** `read_asset_control_sequences` (their validation accepts every value): the header, the range; their offset. */
export function readAssetControlSequencesAt(m: RemainingAccount, i: u64): u64 {
  checkHeader(m, KIND_MARKET);
  return assetControlSequencesAt(m, i);
}

/** `require_newer_control_sequence`. */
export function requireNewerControlSequence(current: u64, proposed: u64): void {
  require(proposed > current, PercolatorError.EngineStale);
}

/** `require_current_authority_epoch`. */
export function requireCurrentAuthorityEpoch(current: u64, expected: u64): void {
  require(current === expected, PercolatorError.EngineStale);
}

/** `next_authority_epoch`. */
export function nextAuthorityEpoch(current: u64, expected: u64): u64 {
  requireCurrentAuthorityEpoch(current, expected);
  require(current !== 0xffffffffffffffffn, PercolatorError.EngineCounterOverflow);
  return current + 1n;
}

/** `backing_fee_sequence_floor`. */
export function backingFeeSequenceFloor(backingFee: u64, legacyShortOrEpoch: u64): u64 {
  return backingFee > legacyShortOrEpoch ? backingFee : legacyShortOrEpoch;
}

/** The program's `decode_market_mode`: 0 Live, 1 Resolved, 2 Recovery, anything else InvalidAccountData. */
export function decodeMarketModeProgram(v: u8): u8 {
  require(v <= 2n, ProgramError.InvalidAccountData);
  return v;
}

/** The offset of the group header after `market_header`'s range check (InvalidAccountLen). */
export function marketHeaderAt(m: RemainingAccount): u64 {
  require(m.dataLen >= MARKET_GROUP_OFF + MARKET_GROUP_LEN, PercolatorError.InvalidAccountLen);
  return MARKET_GROUP_OFF;
}

/**
 * `market_view_mut`'s checks, in order: the minimum length, the header, the wrapper config (validated), the capacity,
 * then `market_group_view_from_state`'s: the configured asset count nonzero and within the capacity
 * (InvalidAccountData). Returns the capacity; the caller binds the views (the config at 16, the group header at 464,
 * the slots from 1,190).
 */
export function marketViewChecks(m: RemainingAccount): u64 {
  require(m.dataLen >= MIN_MARKET_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  checkHeader(m, KIND_MARKET);
  validateWrapperConfig(loadRawAt<WrapperConfig>(m, wrapperConfigAt(m)));
  const capacity = validateMarketDynamicLen(m);
  const configured = toU64(readData<u32>(m, MARKET_GROUP_OFF + 34n));
  require(configured !== 0n && configured <= capacity, ProgramError.InvalidAccountData);
  return capacity;
}

/**
 * `portfolio_view_mut_for_market_slots`'s checks: the header, then a length from the engine state's end to the full
 * account (InvalidAccountLen). The engine portfolio view is at HEADER_LEN.
 */
export function portfolioViewChecks(p: RemainingAccount): void {
  checkHeader(p, KIND_PORTFOLIO);
  require(p.dataLen >= HEADER_LEN + PORTFOLIO_STATE_LEN && p.dataLen <= PORTFOLIO_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
}

/** `read_portfolio_owner_preflight`'s length and header checks (the provenance check is wire.ts `provenanceHeaderErr`). */
export function portfolioPreflightChecks(p: RemainingAccount): void {
  require(p.dataLen >= PORTFOLIO_ENGINE_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  checkHeader(p, KIND_PORTFOLIO);
}
