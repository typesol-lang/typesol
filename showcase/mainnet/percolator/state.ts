// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb and aeyakovenko/percolator 3f55f87), Copyright
// Anatoly Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Changes: rewritten in TypeSOL.
//
// The slab: the program's one account, 1,525,624 bytes, read and written in place (the original casts it with
// `unsafe` pointer casts, `mod zc`). Its parts, in order:
//
//   SlabHeader     136 bytes at 0      (prog `state::SlabHeader`)
//   MarketConfig   400 bytes at 136    (prog `state::MarketConfig`)
//   RiskEngine     1,492,160 at 536    (engine `RiskEngine`: aggregates, side state, a 64-word bitmap, two u16
//                                       freelists and 4,096 accounts of 360 bytes)
//   RiskBuffer     160 bytes at 1,492,696 (prog `risk_buffer::RiskBuffer`)
//   generations    4,096 u64s at 1,492,856 (the materialization counter each slot was created under)
//
// The structs are `#[repr(C)]` with the SBF target's alignment, where u128 and i128 align to 8 (not 16 as on x86_64
// since Rust 1.77): TypeSOL structs are packed, so every padding byte Rust inserts is a field here (`pad…`). The
// offsets are the ones the mainnet binary uses (showcase/test/percolator-layout.test.ts reads them from slabs the
// binary itself initialised). The engine's U128 / I128 wrappers are `[u64; 2]`, the same bytes as a u128 / i128.
import { type FixedArray, type Pubkey, type i64, type i128, type u8, type u16, type u32, type u64, type u128 } from "typesol";

export const ENGINE_MAX_ACCOUNTS = 4096n;
export const BITMAP_WORDS = 64n;
export const HEADER_LEN = 136n;
export const CONFIG_LEN = 400n;
export const ENGINE_OFF = 536n;
export const ENGINE_LEN = 1492160n;
export const RISK_BUF_OFF = 1492696n;
export const RISK_BUF_CAP = 4n;
export const GEN_TABLE_OFF = 1492856n;
export const SLAB_LEN = 1525624n;
/** "PERCOLAT". */
export const MAGIC = 0x504552434f4c4154n;

/** Header byte 13 (`_padding[0]`, here `padding.get(0)`): the market flags. */
export const FLAGS_OFF = 13n;
export const FLAG_CPI_IN_PROGRESS = 4n;
export const FLAG_ORACLE_INITIALIZED = 8n;

export interface SlabHeader {
  magic: u64;
  version: u32;
  bump: u8;
  /** [0] is the flags byte. */
  padding: FixedArray<u8, 3>;
  admin: Pubkey;
  /** `_reserved[0..8]`: the TradeCpi request nonce; `[8..16]`: the materialization counter; `[16..24]` unused. */
  req_nonce: u64;
  mat_counter: u64;
  reserved_tail: u64;
  insurance_authority: Pubkey;
  insurance_operator: Pubkey;
}

export interface MarketConfig {
  collateral_mint: Pubkey;
  vault_pubkey: Pubkey;
  index_feed_id: Pubkey;
  max_staleness_secs: u64;
  conf_filter_bps: u16;
  vault_authority_bump: u8;
  invert: u8;
  unit_scale: u32;
  funding_horizon_slots: u64;
  funding_k_bps: u64;
  funding_max_premium_bps: i64;
  funding_max_e9_per_slot: i64;
  hyperp_authority: Pubkey;
  hyperp_mark_e6: u64;
  last_oracle_publish_time: i64;
  oracle_price_cap_e2bps: u64;
  last_effective_price_e6: u64;
  min_oracle_price_cap_e2bps: u64;
  insurance_withdraw_max_bps: u16;
  tvl_insurance_cap_mult: u16;
  iw_padding: u32;
  insurance_withdraw_cooldown_slots: u64;
  iw_padding2: FixedArray<u64, 2>;
  last_hyperp_index_slot: u64;
  last_mark_push_slot: u128;
  last_insurance_withdraw_slot: u64;
  pad_obsolete_stale_slot: u64;
  mark_ewma_e6: u64;
  mark_ewma_last_slot: u64;
  mark_ewma_halflife_slots: u64;
  init_restart_slot: u64;
  permissionless_resolve_stale_slots: u64;
  last_good_oracle_slot: u64;
  maintenance_fee_per_slot: u128;
  fee_sweep_cursor_word: u64;
  fee_sweep_cursor_bit: u64;
  mark_min_fee: u64;
  force_close_delay_slots: u64;
  new_account_fee: u128;
}

/** Engine `RiskParams` (168 bytes). */
export interface RiskParams {
  maintenance_margin_bps: u64;
  initial_margin_bps: u64;
  trading_fee_bps: u64;
  max_accounts: u64;
  max_crank_staleness_slots: u64;
  liquidation_fee_bps: u64;
  liquidation_fee_cap: u128;
  min_liquidation_abs: u128;
  min_nonzero_mm_req: u128;
  min_nonzero_im_req: u128;
  h_min: u64;
  h_max: u64;
  resolve_price_deviation_bps: u64;
  max_accrual_dt_slots: u64;
  max_abs_funding_e9_per_slot: u64;
  min_funding_lifetime_slots: u64;
  max_active_positions_per_side: u64;
}

/** Engine `Account` (360 bytes). */
export interface Account {
  capital: u128;
  /** 0 = user, 1 = LP. */
  kind: u8;
  pad0: FixedArray<u8, 7>;
  pnl: i128;
  reserved_pnl: u128;
  position_basis_q: i128;
  adl_a_basis: u128;
  adl_k_snap: i128;
  f_snap: i128;
  adl_epoch_snap: u64;
  matcher_program: Pubkey;
  matcher_context: Pubkey;
  owner: Pubkey;
  fee_credits: i128;
  last_fee_slot: u64;
  sched_present: u8;
  pad1: FixedArray<u8, 7>;
  sched_remaining_q: u128;
  sched_anchor_q: u128;
  sched_start_slot: u64;
  sched_horizon: u64;
  sched_release_q: u128;
  pending_present: u8;
  pad2: FixedArray<u8, 7>;
  pending_remaining_q: u128;
  pending_horizon: u64;
  pending_created_slot: u64;
}

export const KIND_USER = 0n;
export const KIND_LP = 1n;

/** MarketMode. */
export const LIVE = 0n;
export const RESOLVED = 1n;
/** SideMode. */
export const NORMAL = 0n;
export const DRAIN_ONLY = 1n;
export const RESET_PENDING = 2n;

/** Engine `RiskEngine` (1,492,160 bytes at ENGINE_OFF). */
export interface RiskEngine {
  vault: u128;
  insurance_balance: u128;
  params: RiskParams;
  current_slot: u64;
  market_mode: u8;
  pad0: FixedArray<u8, 7>;
  resolved_price: u64;
  resolved_slot: u64;
  resolved_payout_h_num: u128;
  resolved_payout_h_den: u128;
  resolved_payout_ready: u8;
  pad1: FixedArray<u8, 7>;
  resolved_k_long_terminal_delta: i128;
  resolved_k_short_terminal_delta: i128;
  resolved_live_price: u64;
  last_crank_slot: u64;
  c_tot: u128;
  pnl_pos_tot: u128;
  pnl_matured_pos_tot: u128;
  gc_cursor: u16;
  pad2: FixedArray<u8, 6>;
  adl_mult_long: u128;
  adl_mult_short: u128;
  adl_coeff_long: i128;
  adl_coeff_short: i128;
  adl_epoch_long: u64;
  adl_epoch_short: u64;
  adl_epoch_start_k_long: i128;
  adl_epoch_start_k_short: i128;
  oi_eff_long_q: u128;
  oi_eff_short_q: u128;
  side_mode_long: u8;
  side_mode_short: u8;
  pad3: FixedArray<u8, 6>;
  stored_pos_count_long: u64;
  stored_pos_count_short: u64;
  stale_account_count_long: u64;
  stale_account_count_short: u64;
  phantom_dust_bound_long_q: u128;
  phantom_dust_bound_short_q: u128;
  materialized_account_count: u64;
  neg_pnl_account_count: u64;
  last_oracle_price: u64;
  fund_px_last: u64;
  last_market_slot: u64;
  f_long_num: i128;
  f_short_num: i128;
  f_epoch_start_long_num: i128;
  f_epoch_start_short_num: i128;
  used: FixedArray<u64, 64>;
  num_used_accounts: u16;
  free_head: u16;
  next_free: FixedArray<u16, 4096>;
  prev_free: FixedArray<u16, 4096>;
  pad4: u32;
  accounts: FixedArray<Account, 4096>;
}

/** prog `risk_buffer::RiskEntry` (32 bytes). */
export interface RiskEntry {
  idx: u16;
  pad: FixedArray<u8, 14>;
  notional: u128;
}

/** prog `risk_buffer::RiskBuffer` (160 bytes at RISK_BUF_OFF): the four largest notionals the crank has seen. */
export interface RiskBuffer {
  scan_cursor: u16;
  count: u8;
  pad: FixedArray<u8, 13>;
  min_notional: u128;
  entries: FixedArray<RiskEntry, 4>;
}

/** The slab's risk buffer, as one struct to copy in and out (read_risk_buffer / write_risk_buffer). */
export interface RiskBufferHolder {
  buffer: RiskBuffer;
}

/** The generation table at GEN_TABLE_OFF: the materialization counter each slot was created under. */
export interface GenerationTable {
  generation: FixedArray<u64, 4096>;
}
