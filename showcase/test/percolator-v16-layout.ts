// The persisted layouts of Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog and
// aeyakovenko/percolator, Apache-2.0: every struct an account holds, field by field in declaration order, transcribed
// from the sources (engine src/v16.rs, program src/v16_program.rs `mod state` and `mod constants`). Offsets are not
// written down: they follow from the order and the sizes, because every struct is `#[repr(C)]` and bytemuck `Pod`,
// which refuses implicit padding. The engine's structs are built from byte-array integers (`V16PodU64` is `[u8; 8]`),
// alignment 1; the program's wrapper structs use native integers with explicit padding fields.
//
// percolator-v16-layout.test.ts checks this table against `offset_of!` / `size_of` printed by the Rust compiler for
// the pinned sources (scripts/percolator-v16-reference/layout.sh, its output in fixtures/percolator-v16-layout.json),
// and against accounts the reference binary initialised. This file imports nothing, so that the layout script can
// read it with plain Node.

/** A field: name, type (a primitive below or a struct of STRUCTS), and an array length. */
export type Field = readonly [name: string, type: string, count?: number];

/** The byte size of each primitive type. `pu*` / `pi*` are the engine's `V16Pod*` byte-array integers. */
export const PRIMITIVES: Record<string, number> = {
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  i64: 8,
  u128: 16,
  pu16: 2,
  pu32: 4,
  pu64: 8,
  pu128: 16,
  pi128: 16,
  /** `[u8; 32]`: a public key or a feed id. */
  key: 32,
};

/** The Rust type each table name stands for, and its fields. */
export const STRUCTS: Record<string, { rust: string; fields: readonly Field[] }> = {
  // ---- The program's wrapper (src/v16_program.rs, mod state) --------------------------------------------------------
  WrapperConfig: {
    rust: "percolator_prog::state::WrapperConfigV16",
    fields: [
      ["marketauth", "key"],
      ["collateral_mint", "key"],
      ["secondary_collateral_mint", "key"],
      ["maintenance_fee_per_slot", "u128"],
      ["permissionless_market_init_fee", "u128"],
      ["trade_fee_base_bps", "u64"],
      ["permissionless_resolve_stale_slots", "u64"],
      ["force_close_delay_slots", "u64"],
      ["last_good_oracle_slot", "u64"],
      ["terminal_slab_scan_progress", "u128"],
      ["_reserved_insurance_withdraw_max_bps", "u16"],
      ["liquidation_cranker_fee_share_bps", "u16"],
      ["maintenance_cranker_fee_share_bps", "u16"],
      ["backing_trade_fee_bps_long", "u16"],
      ["unit_scale", "u32"],
      ["conf_filter_bps", "u16"],
      ["backing_trade_fee_bps_short", "u16"],
      ["_reserved_insurance_withdraw_deposits_only", "u8"],
      ["oracle_mode", "u8"],
      ["oracle_leg_count", "u8"],
      ["oracle_leg_flags", "u8"],
      ["invert", "u8"],
      ["_padding0", "u8"],
      ["free_market_slot_count", "u16"],
      ["_reserved_insurance_withdraw_cooldown_slots", "u64"],
      ["_reserved_last_insurance_withdraw_slot", "u64"],
      ["max_staleness_secs", "u64"],
      ["hybrid_soft_stale_slots", "u64"],
      ["mark_ewma_e6", "u64"],
      ["mark_ewma_last_slot", "u64"],
      ["mark_ewma_halflife_slots", "u64"],
      ["mark_min_fee", "u64"],
      ["oracle_target_price_e6", "u64"],
      ["oracle_target_publish_time", "i64"],
      ["oracle_leg_feeds", "key", 3],
      ["oracle_leg_prices_e6", "u64", 3],
      ["oracle_leg_publish_times", "i64", 3],
      ["backing_trade_fee_policy_count", "u16"],
      ["backing_trade_fee_insurance_share_bps_long", "u16"],
      ["backing_trade_fee_insurance_share_bps_short", "u16"],
      ["fee_redirect_to_market_0_bps", "u16"],
      ["matcher_req_seq", "u64"],
      ["next_portfolio_id", "u64"],
    ],
  },
  AssetOracleProfile: {
    rust: "percolator_prog::state::AssetOracleProfileV16",
    fields: [
      ["oracle_mode", "u8"],
      ["oracle_leg_count", "u8"],
      ["oracle_leg_flags", "u8"],
      ["invert", "u8"],
      ["unit_scale", "u32"],
      ["conf_filter_bps", "u16"],
      ["backing_trade_fee_bps_long", "u16"],
      ["backing_trade_fee_bps_short", "u16"],
      ["backing_trade_fee_insurance_share_bps_long", "u16"],
      ["backing_trade_fee_insurance_share_bps_short", "u16"],
      ["price_move_remainder_bps_num", "u16"],
      ["effective_price_provenance", "u8"],
      ["_padding0", "u8", 3],
      ["insurance_authority", "key"],
      ["insurance_operator", "key"],
      ["backing_bucket_authority", "key"],
      ["oracle_authority", "key"],
      ["max_staleness_secs", "u64"],
      ["hybrid_soft_stale_slots", "u64"],
      ["mark_ewma_e6", "u64"],
      ["mark_ewma_last_slot", "u64"],
      ["mark_ewma_halflife_slots", "u64"],
      ["mark_min_fee", "u64"],
      ["oracle_target_price_e6", "u64"],
      ["oracle_target_publish_time", "i64"],
      ["last_good_oracle_slot", "u64"],
      ["oracle_leg_feeds", "key", 3],
      ["oracle_leg_prices_e6", "u64", 3],
      ["oracle_leg_publish_times", "i64", 3],
      ["asset_admin", "key"],
      ["funding_mark_e6", "u64"],
      ["funding_mark_pending_e6", "u64"],
      ["funding_mark_pending_slot", "u64"],
    ],
  },
  AssetControlSequences: {
    rust: "percolator_prog::state::AssetControlSequencesV16",
    fields: [
      ["oracle_observation", "u64"],
      ["backing_fee", "u64"],
      ["authority_epoch", "u64"],
      ["trade_fee", "u64"],
      ["liquidation_fee", "u64"],
      ["maintenance_fee", "u64"],
      ["fee_redirect", "u64"],
      ["market_init_fee", "u64"],
      ["permissionless_resolve", "u64"],
      ["insurance_top_up", "u64"],
      ["backing_top_up", "u64"],
    ],
  },
  BackingDomainLedger: {
    rust: "percolator_prog::state::BackingDomainLedgerAccountV16",
    fields: [
      ["market_group", "key"],
      ["authority", "key"],
      ["total_principal_atoms", "u128"],
      ["total_deposited_atoms", "u128"],
      ["total_principal_withdrawn_atoms", "u128"],
      ["total_earnings_atoms", "u128"],
      ["total_earnings_withdrawn_atoms", "u128"],
      ["last_observed_bucket_earnings_atoms", "u128"],
      ["cumulative_loss_atoms", "u128"],
      ["cumulative_recovery_atoms", "u128"],
      ["last_observed_unavailable_principal_atoms", "u128"],
      ["domain", "u16"],
      ["_padding", "u8", 14],
    ],
  },
  InsuranceLedger: {
    rust: "percolator_prog::state::InsuranceLedgerAccountV16",
    fields: [
      ["market_group", "key"],
      ["authority", "key"],
      ["total_principal_atoms", "u128"],
      ["total_deposited_atoms", "u128"],
      ["total_withdrawn_atoms", "u128"],
      ["cumulative_profit_atoms", "u128"],
      ["cumulative_loss_atoms", "u128"],
      ["last_observed_insurance_atoms", "u128"],
    ],
  },
  PortfolioMatcherConfig: {
    rust: "percolator_prog::state::PortfolioMatcherConfigV16",
    fields: [
      ["matcher_program", "key"],
      ["matcher_context", "key"],
      ["matcher_delegate", "key"],
      ["control", "u64"],
    ],
  },

  // ---- The engine's market group (src/v16.rs) -----------------------------------------------------------------------
  Config: {
    rust: "percolator::V16ConfigAccount",
    fields: [
      ["max_portfolio_assets", "pu16"],
      ["max_market_slots", "pu32"],
      ["min_nonzero_mm_req", "pu128"],
      ["min_nonzero_im_req", "pu128"],
      ["h_min", "pu64"],
      ["h_max", "pu64"],
      ["maintenance_margin_bps", "pu64"],
      ["initial_margin_bps", "pu64"],
      ["max_trading_fee_bps", "pu64"],
      ["liquidation_fee_bps", "pu64"],
      ["liquidation_fee_cap", "pu128"],
      ["min_liquidation_abs", "pu128"],
      ["max_accrual_dt_slots", "pu64"],
      ["max_abs_funding_e9_per_slot", "pu64"],
      ["min_funding_lifetime_slots", "pu64"],
      ["max_price_move_bps_per_slot", "pu64"],
      ["max_account_b_settlement_chunks", "pu64"],
      ["max_bankrupt_close_chunks", "pu64"],
      ["max_bankrupt_close_lifetime_slots", "pu64"],
      ["asset_activation_cooldown_slots", "pu64"],
      ["public_b_chunk_atoms", "pu128"],
      ["max_recovery_fallback_deviation_bps", "pu64"],
      ["backing_fee_base_rate_e9_per_slot", "pu64"],
      ["backing_fee_kink_util_bps", "pu64"],
      ["backing_fee_slope_at_kink_e9_per_slot", "pu64"],
      ["backing_fee_slope_above_kink_e9_per_slot", "pu64"],
      ["backing_freshness_buckets", "u8"],
      ["margin_mode_realizable_full_shared_cross_margin", "u8"],
      ["source_credit_lien_required", "u8"],
      ["insurance_credit_reservation_required", "u8"],
      ["permissionless_recovery_enabled", "u8"],
      ["recovery_fallback_price_enabled", "u8"],
      ["recovery_fallback_envelope_enabled", "u8"],
      ["credit_lien_revalidation_required", "u8"],
      ["stale_certificate_penalty_enabled", "u8"],
      ["full_refresh_required_for_favorable_actions", "u8"],
      ["public_liveness_profile_crank_forward", "u8"],
    ],
  },
  OptionalRecoveryReason: {
    rust: "percolator::V16OptionalRecoveryReasonAccount",
    fields: [
      ["present", "u8"],
      ["value", "u8"],
    ],
  },
  ResolvedPayoutLedger: {
    rust: "percolator::ResolvedPayoutLedgerV16Account",
    fields: [
      ["snapshot_residual", "pu128"],
      ["terminal_claim_exact_receipts_num", "pu128"],
      ["terminal_claim_bound_unreceipted_num", "pu128"],
      ["current_payout_rate_num", "pu128"],
      ["current_payout_rate_den", "pu128"],
      ["snapshot_slot", "pu64"],
      ["payout_halted", "u8"],
      ["finalized", "u8"],
    ],
  },
  GroupHeader: {
    rust: "percolator::MarketGroupV16HeaderAccount",
    fields: [
      ["market_group_id", "key"],
      ["config", "Config"],
      ["asset_slot_capacity", "pu32"],
      ["vault", "pu128"],
      ["insurance", "pu128"],
      ["c_tot", "pu128"],
      ["pnl_pos_tot", "pu128"],
      ["pnl_pos_bound_tot_num", "pu128"],
      ["pnl_pos_bound_tot", "pu128"],
      ["pnl_matured_pos_tot", "pu128"],
      ["backing_provider_earnings_total", "pu128"],
      ["source_claim_bound_total_num", "pu128"],
      ["source_fresh_backing_total_num", "pu128"],
      ["source_insurance_credit_reserved_total_atoms", "pu128"],
      ["insurance_domain_budget_remaining_total", "pu128"],
      ["resolved_payout_blocker_count", "pu64"],
      ["materialized_portfolio_count", "pu64"],
      ["stale_certificate_count", "pu64"],
      ["b_stale_account_count", "pu64"],
      ["negative_pnl_account_count", "pu64"],
      ["risk_epoch", "pu64"],
      ["asset_set_epoch", "pu64"],
      ["asset_activation_count", "pu64"],
      ["last_asset_activation_slot", "pu64"],
      ["next_market_id", "pu64"],
      ["oracle_epoch", "pu64"],
      ["funding_epoch", "pu64"],
      ["slot_last", "pu64"],
      ["current_slot", "pu64"],
      ["bankruptcy_hlock_active", "u8"],
      ["threshold_stress_active", "u8"],
      ["loss_stale_active", "u8"],
      ["recovery_reason", "OptionalRecoveryReason"],
      ["mode", "u8"],
      ["resolved_slot", "pu64"],
      ["payout_snapshot", "pu128"],
      ["payout_snapshot_pnl_pos_tot", "pu128"],
      ["payout_snapshot_captured", "u8"],
      ["resolved_payout_ledger", "ResolvedPayoutLedger"],
    ],
  },

  // ---- The engine's asset slot --------------------------------------------------------------------------------------
  AssetState: {
    rust: "percolator::AssetStateV16Account",
    fields: [
      ["market_id", "pu64"],
      ["retired_slot", "pu64"],
      ["lifecycle", "u8"],
      ["raw_oracle_target_price", "pu64"],
      ["effective_price", "pu64"],
      ["fund_px_last", "pu64"],
      ["slot_last", "pu64"],
      ["a_long", "pu128"],
      ["a_short", "pu128"],
      ["k_long", "pi128"],
      ["k_short", "pi128"],
      ["f_long_num", "pi128"],
      ["f_short_num", "pi128"],
      ["kf_epoch_long", "pu64"],
      ["kf_epoch_short", "pu64"],
      ["k_epoch_start_long", "pi128"],
      ["k_epoch_start_short", "pi128"],
      ["f_epoch_start_long_num", "pi128"],
      ["f_epoch_start_short_num", "pi128"],
      ["b_long_num", "pu128"],
      ["b_short_num", "pu128"],
      ["b_epoch_start_long_num", "pu128"],
      ["b_epoch_start_short_num", "pu128"],
      ["oi_eff_long_q", "pu128"],
      ["oi_eff_short_q", "pu128"],
      ["stored_pos_count_long", "pu64"],
      ["stored_pos_count_short", "pu64"],
      ["stale_account_count_long", "pu64"],
      ["stale_account_count_short", "pu64"],
      ["pending_obligation_count_long", "pu64"],
      ["pending_obligation_count_short", "pu64"],
      ["loss_weight_sum_long", "pu128"],
      ["loss_weight_sum_short", "pu128"],
      ["social_loss_remainder_long_num", "pu128"],
      ["social_loss_remainder_short_num", "pu128"],
      ["social_loss_dust_long_num", "pu128"],
      ["social_loss_dust_short_num", "pu128"],
      ["explicit_unallocated_loss_long", "pu128"],
      ["explicit_unallocated_loss_short", "pu128"],
      ["epoch_long", "pu64"],
      ["epoch_short", "pu64"],
      ["mode_long", "u8"],
      ["mode_short", "u8"],
    ],
  },
  SourceCreditState: {
    rust: "percolator::SourceCreditStateV16Account",
    fields: [
      ["positive_claim_bound_num", "pu128"],
      ["exact_positive_claim_num", "pu128"],
      ["fresh_reserved_backing_num", "pu128"],
      ["spent_backing_num", "pu128"],
      ["provider_receivable_num", "pu128"],
      ["valid_liened_backing_num", "pu128"],
      ["impaired_liened_backing_num", "pu128"],
      ["insurance_credit_reserved_num", "pu128"],
      ["valid_liened_insurance_num", "pu128"],
      ["impaired_liened_insurance_num", "pu128"],
      ["credit_rate_num", "pu128"],
      ["credit_epoch", "pu64"],
    ],
  },
  BackingBucket: {
    rust: "percolator::BackingBucketV16Account",
    fields: [
      ["market_id", "pu64"],
      ["fresh_unliened_backing_num", "pu128"],
      ["valid_liened_backing_num", "pu128"],
      ["consumed_liened_backing_num", "pu128"],
      ["impaired_liened_backing_num", "pu128"],
      ["utilization_fee_earnings", "pu128"],
      ["expiry_slot", "pu64"],
      ["status", "u8"],
    ],
  },
  InsuranceCreditReservation: {
    rust: "percolator::InsuranceCreditReservationV16Account",
    fields: [
      ["insurance_credit_reserved_num", "pu128"],
      ["valid_liened_insurance_num", "pu128"],
      ["impaired_liened_insurance_num", "pu128"],
      ["consumed_insurance_num", "pu128"],
      ["source_credit_epoch", "pu64"],
    ],
  },
  EngineAssetSlot: {
    rust: "percolator::EngineAssetSlotV16Account",
    fields: [
      ["asset", "AssetState"],
      ["insurance_domain_budget_long", "pu128"],
      ["insurance_domain_budget_short", "pu128"],
      ["insurance_domain_spent_long", "pu128"],
      ["insurance_domain_spent_short", "pu128"],
      ["pending_domain_loss_barrier_long", "pu64"],
      ["pending_domain_loss_barrier_short", "pu64"],
      ["source_credit_long", "SourceCreditState"],
      ["source_credit_short", "SourceCreditState"],
      ["backing_long", "BackingBucket"],
      ["backing_short", "BackingBucket"],
      ["insurance_reservation_long", "InsuranceCreditReservation"],
      ["insurance_reservation_short", "InsuranceCreditReservation"],
      ["provider_principal_long_num", "pu128"],
      ["provider_principal_short_num", "pu128"],
    ],
  },
  /** One slot of the market account: the program's 512-byte oracle wrapper, then the engine's slot. */
  AssetSlot: {
    rust: "percolator::Market<[u8; 512]>",
    fields: [
      ["wrapper", "u8", 512],
      ["engine", "EngineAssetSlot"],
    ],
  },

  // ---- The engine's portfolio ---------------------------------------------------------------------------------------
  ProvenanceHeader: {
    rust: "percolator::ProvenanceHeaderV16Account",
    fields: [
      ["market_group_id", "key"],
      ["portfolio_account_id", "key"],
      ["owner", "key"],
      ["version", "pu16"],
      ["layout_discriminator", "pu16"],
    ],
  },
  PortfolioLeg: {
    rust: "percolator::PortfolioLegV16Account",
    fields: [
      ["active", "u8"],
      ["asset_index", "pu32"],
      ["market_id", "pu64"],
      ["side", "u8"],
      ["basis_pos_q", "pi128"],
      ["a_basis", "pu128"],
      ["k_snap", "pi128"],
      ["f_snap", "pi128"],
      ["kf_epoch_snap", "pu64"],
      ["epoch_snap", "pu64"],
      ["loss_weight", "pu128"],
      ["b_snap", "pu128"],
      ["b_rem", "pu128"],
      ["b_epoch_snap", "pu64"],
      ["b_stale", "u8"],
      ["stale", "u8"],
    ],
  },
  HealthCert: {
    rust: "percolator::HealthCertV16Account",
    fields: [
      ["certified_equity", "pi128"],
      ["certified_initial_req", "pu128"],
      ["certified_maintenance_req", "pu128"],
      ["certified_liq_deficit", "pu128"],
      ["certified_worst_case_loss", "pu128"],
      ["cert_oracle_epoch", "pu64"],
      ["cert_funding_epoch", "pu64"],
      ["cert_risk_epoch", "pu64"],
      ["cert_asset_set_epoch", "pu64"],
      // V16_ACTIVE_BITMAP_WORDS = (16 + 63) / 64 = 1
      ["active_bitmap_at_cert", "pu64", 1],
      ["valid", "u8"],
    ],
  },
  CloseProgressLedger: {
    rust: "percolator::CloseProgressLedgerV16Account",
    fields: [
      ["active", "u8"],
      ["finalized", "u8"],
      ["canceled", "u8"],
      ["close_id", "pu64"],
      ["asset_index", "pu32"],
      ["market_id", "pu64"],
      ["domain_side", "u8"],
      ["gross_loss_at_close_start", "pu128"],
      ["drift_reference_slot", "pu64"],
      ["max_close_slot", "pu64"],
      ["support_consumed", "pu128"],
      ["junior_face_burned", "pu128"],
      ["insurance_spent", "pu128"],
      ["b_loss_booked", "pu128"],
      ["explicit_loss_assigned", "pu128"],
      ["quantity_adl_applied_q", "pu128"],
      ["drift_consumed", "pu128"],
      ["residual_remaining", "pu128"],
    ],
  },
  ResolvedPayoutReceipt: {
    rust: "percolator::ResolvedPayoutReceiptV16Account",
    fields: [
      ["prior_bound_contribution_num", "pu128"],
      ["live_released_face_at_receipt", "pu128"],
      ["terminal_positive_claim_face", "pu128"],
      ["paid_effective", "pu128"],
      ["present", "u8"],
      ["finalized", "u8"],
    ],
  },
  PortfolioSourceDomain: {
    rust: "percolator::PortfolioSourceDomainV16Account",
    fields: [
      ["domain", "pu32"],
      ["source_claim_market_id", "pu64"],
      ["source_claim_bound_num", "pu128"],
      ["source_claim_liened_num", "pu128"],
      ["source_claim_counterparty_liened_num", "pu128"],
      ["source_claim_insurance_liened_num", "pu128"],
      ["source_lien_effective_reserved", "pu128"],
      ["source_lien_counterparty_backing_num", "pu128"],
      ["source_lien_insurance_backing_num", "pu128"],
      ["source_lien_fee_last_slot", "pu64"],
      ["source_claim_impaired_num", "pu128"],
      ["source_lien_impaired_effective_reserved", "pu128"],
      ["source_lien_capital_at_risk_fee_revenue", "pu128"],
      ["source_lien_impaired_capital_at_risk_fee_revenue", "pu128"],
    ],
  },
  Portfolio: {
    rust: "percolator::PortfolioAccountV16Account",
    fields: [
      ["provenance_header", "ProvenanceHeader"],
      ["owner", "key"],
      ["capital", "pu128"],
      ["pnl", "pi128"],
      ["reserved_pnl", "pu128"],
      ["residual_crystallized_loss_atoms_total", "pu128"],
      ["residual_spent_principal_atoms_total", "pu128"],
      ["residual_received_atoms_total", "pu128"],
      ["funding_long_paid_atoms_total", "pu128"],
      ["funding_long_received_atoms_total", "pu128"],
      ["funding_short_paid_atoms_total", "pu128"],
      ["funding_short_received_atoms_total", "pu128"],
      ["fee_credits", "pi128"],
      ["cancel_deposit_escrow", "pu128"],
      ["last_fee_slot", "pu64"],
      ["active_bitmap", "pu64", 1],
      // V16_MAX_PORTFOLIO_ASSETS_N = 16 (the wrapper admits 14)
      ["legs", "PortfolioLeg", 16],
      // PORTFOLIO_SOURCE_DOMAIN_CAP = 2 * 16 outside Kani builds
      ["source_domains", "PortfolioSourceDomain", 32],
      ["health_cert", "HealthCert"],
      ["stale_state", "u8"],
      ["b_stale_state", "u8"],
      ["rebalance_lock", "u8"],
      ["liquidation_lock", "u8"],
      ["close_progress", "CloseProgressLedger"],
      ["resolved_payout_receipt", "ResolvedPayoutReceipt"],
    ],
  },
};

/** A field's size: its type's size times its count. */
export function sizeOf(type: string): number {
  const p = PRIMITIVES[type];
  if (p !== undefined) return p;
  const s = STRUCTS[type];
  if (!s) throw new Error(`unknown type ${type}`);
  return s.fields.reduce((n, [, t, c]) => n + sizeOf(t) * (c ?? 1), 0);
}

/** Each field's offset and size in a struct (sizes include the array length). */
export function layout(name: string): { name: string; type: string; count: number; offset: number; size: number }[] {
  const s = STRUCTS[name];
  if (!s) throw new Error(`unknown struct ${name}`);
  let at = 0;
  return s.fields.map(([field, type, count]) => {
    const size = sizeOf(type) * (count ?? 1);
    const row = { name: field, type, count: count ?? 1, offset: at, size };
    at += size;
    return row;
  });
}

/** The offset of a field, `a.b.c` naming a path through nested structs (array elements are not addressed; "" is 0). */
export function offsetOf(struct: string, path: string): number {
  if (path === "") return 0;
  let at = 0;
  let type = struct;
  for (const part of path.split(".")) {
    const f = layout(type).find((r) => r.name === part);
    if (!f) throw new Error(`${type} has no field ${part}`);
    at += f.offset;
    type = f.type;
  }
  return at;
}

// ---- Accounts (src/v16_program.rs, mod constants and mod state) -------------------------------------------------------

/** Every account starts with this header: magic "PERCV16\0" (u64), version 16 (u16), kind (u8), five zero bytes. */
export const HEADER = { magic: 0, version: 8, kind: 10, len: 16 } as const;
export const MAGIC = 0x5045_5243_5631_3600n;
export const VERSION = 16;
export const KIND = { market: 1, portfolio: 2, backingDomainLedger: 3, insuranceLedger: 4, closedMarket: 5 } as const;

/** The market account: header, wrapper config, the engine's group header, then one asset slot per capacity. */
export const MARKET = {
  wrapper: HEADER.len,
  group: HEADER.len + sizeOf("WrapperConfig"),
  slots: HEADER.len + sizeOf("WrapperConfig") + sizeOf("GroupHeader"),
  slotLen: sizeOf("AssetSlot"),
  /** Within a slot's 512-byte wrapper: the oracle profile, then the control sequences. */
  controlSequences: sizeOf("AssetOracleProfile"),
} as const;
/** The market account's length for `capacity` asset slots (InitMarket takes the account as allocated). */
export const marketLen = (capacity: number) => MARKET.slots + capacity * MARKET.slotLen;

/** The portfolio account: header, the engine's portfolio, then the program's matcher config and three u64 words. */
export const PORTFOLIO = {
  state: HEADER.len,
  matcherConfig: HEADER.len + sizeOf("Portfolio"),
  /** 104 bytes are reserved for the matcher config; its `control` word is its last 8. */
  matcherConfigLen: 104,
  id: HEADER.len + sizeOf("Portfolio") + 104,
  /** The owner-state sequence (named MATCHER_SEQUENCE in the source). */
  sequence: HEADER.len + sizeOf("Portfolio") + 112,
  expiry: HEADER.len + sizeOf("Portfolio") + 120,
  len: HEADER.len + sizeOf("Portfolio") + 128,
} as const;

/** The two ledger accounts: header, then the struct. */
export const BACKING_DOMAIN_LEDGER_LEN = HEADER.len + sizeOf("BackingDomainLedger");
export const INSURANCE_LEDGER_LEN = HEADER.len + sizeOf("InsuranceLedger");

/**
 * The program constants the layout test reads from the Rust compiler too (`constants::*` and two `state` functions),
 * with the values this table implies.
 */
export const CONSTANTS: Record<string, number> = {
  HEADER_LEN: HEADER.len,
  WRAPPER_CONFIG_LEN: sizeOf("WrapperConfig"),
  ASSET_ORACLE_PROFILE_LEN: sizeOf("AssetOracleProfile"),
  ASSET_ORACLE_WRAPPER_LEN: 512,
  ASSET_CONTROL_SEQUENCES_OFF: MARKET.controlSequences,
  ASSET_CONTROL_SEQUENCES_LEN: 512 - sizeOf("AssetOracleProfile"),
  MARKET_GROUP_LEN: sizeOf("GroupHeader"),
  MARKET_ASSET_SLOT_LEN: MARKET.slotLen,
  PORTFOLIO_STATE_LEN: sizeOf("Portfolio"),
  PORTFOLIO_SOURCE_DOMAIN_LEN: sizeOf("PortfolioSourceDomain"),
  MARKET_GROUP_OFF: MARKET.group,
  MIN_MARKET_ACCOUNT_LEN: MARKET.slots,
  MARKET_ACCOUNT_LEN: marketLen(1),
  PORTFOLIO_ENGINE_ACCOUNT_LEN: PORTFOLIO.matcherConfig,
  PORTFOLIO_MATCHER_CONFIG_OFF: PORTFOLIO.matcherConfig,
  PORTFOLIO_MATCHER_CONFIG_LEN: PORTFOLIO.matcherConfigLen,
  PORTFOLIO_MATCHER_CONTROL_OFF: PORTFOLIO.matcherConfig + 96,
  PORTFOLIO_ID_OFF: PORTFOLIO.id,
  PORTFOLIO_MATCHER_SEQUENCE_OFF: PORTFOLIO.sequence,
  PORTFOLIO_MATCHER_EXPIRY_OFF: PORTFOLIO.expiry,
  PORTFOLIO_ACCOUNT_LEN: PORTFOLIO.len,
  backing_domain_ledger_account_len: BACKING_DOMAIN_LEDGER_LEN,
  insurance_ledger_account_len: INSURANCE_LEDGER_LEN,
};
