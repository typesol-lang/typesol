// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// The accounts and the types the instructions carry. Phoenix keeps two kinds of accounts, both `#[repr(C)]` Pod
// structs read in place (bytemuck), with an 8-byte discriminant of its own at byte 0 (keccak(program id ‖ type name),
// program/accounts.rs):
//
// - the market: a 576-byte MarketHeader, then a FIFOMarket<Pubkey, BIDS, ASKS, SEATS> (state/markets/fifo.rs) whose
//   three lib-sokoban RedBlackTrees are sized by the header's `market_size_params`. Only the twelve size sets of
//   dispatch_market.rs are accepted; the trees start at byte 880 (bids), then asks, then the traders.
// - a seat: 128 bytes at the PDA ["seat", market, trader], the market authority's approval of one trader.
//
// The header stores its enums as u64s (MarketStatus, SeatApprovalStatus); instruction arguments carry them as Borsh
// u8 tags. The quantity newtypes of quantities.rs (QuoteLots, BaseAtomsPerBaseLot, …) are plain u64s here; their
// operators' overflow panics are util.ts's helpers.
import { type FixedArray, type Pubkey, type i64, type u8, type u16, type u32, type u64, type u128 } from "typesol";

// ---- Discriminants (accounts.rs, test_valid_discriminants) --------------------------------------------------------

/** get_discriminant::<MarketHeader>(): keccak(program id ‖ "phoenix::program::accounts::MarketHeader")[..8]. */
export const MARKET_HEADER_DISCRIMINANT = 8167313896524341111n;
/** get_discriminant::<Seat>(). */
export const SEAT_DISCRIMINANT = 2002603505298356104n;
/** The line get_discriminant logs each time it runs (it hashes again on every call). */
export const MARKET_DISCRIMINANT_LOG = "Discriminant for phoenix::program::accounts::MarketHeader is 8167313896524341111";
export const SEAT_DISCRIMINANT_LOG = "Discriminant for phoenix::program::accounts::Seat is 2002603505298356104";

// ---- The market header (accounts.rs) --------------------------------------------------------------------------------

export interface MarketSizeParams {
  bids_size: u64;
  asks_size: u64;
  num_seats: u64;
}

export interface TokenParams {
  /** Number of decimals of the mint (9 for SOL, 6 for USDC). */
  decimals: u32;
  /** The bump of the vault PDA ["vault", market, mint]. */
  vault_bump: u32;
  mint_key: Pubkey;
  vault_key: Pubkey;
}

/** 576 bytes at byte 0 of the market. */
export interface MarketHeader {
  discriminant: u64;
  /** A MarketStatus (MARKET_STATUS_*). */
  status: u64;
  market_size_params: MarketSizeParams;
  base_params: TokenParams;
  /** BaseAtomsPerBaseLot. */
  base_lot_size: u64;
  quote_params: TokenParams;
  /** QuoteAtomsPerQuoteLot. */
  quote_lot_size: u64;
  /** QuoteAtomsPerBaseUnitPerTick. */
  tick_size_in_quote_atoms_per_base_unit: u64;
  authority: Pubkey;
  fee_recipient: Pubkey;
  market_sequence_number: u64;
  successor: Pubkey;
  raw_base_units_per_base_unit: u32;
  padding1: u32;
  padding2: FixedArray<u64, 32>;
}

export const MARKET_HEADER_SIZE = 576n;
/** Byte offsets the program reads before it has a view (the header's own checks). */
export const HEADER_STATUS_OFFSET = 8n;

/** MarketStatus (status.rs), as the header stores it. */
export const MARKET_STATUS_UNINITIALIZED = 0n;
export const MARKET_STATUS_ACTIVE = 1n;
export const MARKET_STATUS_POST_ONLY = 2n;
export const MARKET_STATUS_PAUSED = 3n;
export const MARKET_STATUS_CLOSED = 4n;
export const MARKET_STATUS_TOMBSTONED = 5n;

/** SeatApprovalStatus (status.rs), as a seat stores it. */
export const SEAT_NOT_APPROVED = 0n;
export const SEAT_APPROVED = 1n;
export const SEAT_RETIRED = 2n;

// ---- The FIFOMarket (state/markets/fifo.rs) -------------------------------------------------------------------------

/** The FIFOMarket's fixed fields, 304 bytes at byte 576; the trees follow at 880. */
export interface FifoMarketPrefix {
  padding: FixedArray<u64, 32>;
  /** BaseLotsPerBaseUnit. */
  base_lots_per_base_unit: u64;
  /** QuoteLotsPerBaseUnitPerTick. */
  tick_size_in_quote_lots_per_base_unit: u64;
  /** The sequence number of the next order; 0 until the market is initialized, then 1. */
  order_sequence_number: u64;
  taker_fee_bps: u64;
  /** QuoteLots collected in the market's lifetime. */
  collected_quote_lot_fees: u64;
  /** QuoteLots accrued and not yet collected. */
  unclaimed_quote_lot_fees: u64;
}

export const FIFO_MARKET_OFFSET = 576n;
/** The bids tree: MARKET_HEADER_SIZE + the 304-byte prefix. */
export const BIDS_OFFSET = 880n;
/** A sokoban RedBlackTree's own bytes before its nodes: root u32, padding [u32; 3], the allocator's size u64, bump and free-list head u32. */
export const TREE_HEADER_SIZE = 32n;
/** A book node: registers [u32; 4], FIFOOrderId (16), FIFORestingOrder (32). */
export const ORDER_NODE_SIZE = 64n;
/** A trader node: registers [u32; 4], Pubkey (32), TraderState (96). */
export const TRADER_NODE_SIZE = 144n;

/** A book's key: the price, and the sequence number (a bid's stored inverted, `!seq`, so its top bit is set). */
export interface FIFOOrderId {
  price_in_ticks: u64;
  order_sequence_number: u64;
}

export interface FIFORestingOrder {
  /** The trader's node index in the traders tree. */
  trader_index: u64;
  num_base_lots: u64;
  last_valid_slot: u64;
  last_valid_unix_timestamp_in_seconds: u64;
}

/** A registered trader's funds (state/trader_state.rs). */
export interface TraderState {
  quote_lots_locked: u64;
  quote_lots_free: u64;
  base_lots_locked: u64;
  base_lots_free: u64;
  padding: FixedArray<u64, 8>;
}

/** The seat account: 128 bytes at ["seat", market, trader]. */
export interface Seat {
  discriminant: u64;
  market: Pubkey;
  trader: Pubkey;
  /** A SeatApprovalStatus (SEAT_*). */
  approval_status: u64;
  padding: FixedArray<u64, 6>;
}

export const SEAT_SIZE = 128n;
/** spl_token::state::Account::LEN, the vaults' size. */
export const TOKEN_ACCOUNT_LEN = 165n;

// ---- Instruction arguments (processor/*.rs, state/enums.rs, state/order_schema) --------------------------------------

export enum Side {
  Bid,
  Ask,
}

export enum SelfTradeBehavior {
  Abort,
  CancelProvide,
  DecrementTake,
}

/** MarketStatus as ChangeMarketStatus carries it (a Borsh u8 tag). */
export enum MarketStatusArg {
  Uninitialized,
  Active,
  PostOnly,
  Paused,
  Closed,
  Tombstoned,
}

/** SeatApprovalStatus as ChangeSeatStatus carries it. */
export enum SeatApprovalStatusArg {
  NotApproved,
  Approved,
  Retired,
}

/** InitializeParams (processor/initialize.rs), Borsh after the tag: 99 bytes, or 103 with raw_base_units_per_base_unit. */
export interface InitializeParams {
  market_size_params: MarketSizeParams;
  num_quote_lots_per_quote_unit: u64;
  tick_size_in_quote_lots_per_base_unit: u64;
  num_base_lots_per_base_unit: u64;
  taker_fee_bps: u16;
  fee_collector: Pubkey;
  /** 1 raw base unit is 10^decimals atoms; a base unit is this many raw base units (None: 1). */
  raw_base_units_per_base_unit: u32 | null;
}

/** DepositParams (processor/deposit.rs). */
export interface DepositParams {
  quote_lots_to_deposit: u64;
  base_lots_to_deposit: u64;
}

/** WithdrawParams (processor/withdraw.rs): None withdraws all the free lots. */
export interface WithdrawParams {
  quote_lots_to_withdraw: u64 | null;
  base_lots_to_withdraw: u64 | null;
}

/** CancelOrderParams (processor/reduce_order.rs). */
export interface CancelOrderParams {
  side: Side;
  price_in_ticks: u64;
  order_sequence_number: u64;
}

/** ReduceOrderParams. */
export interface ReduceOrderParams {
  base_params: CancelOrderParams;
  size: u64;
}

/** CancelUpToParams (processor/cancel_multiple_orders.rs). */
export interface CancelUpToParams {
  side: Side;
  tick_limit: u64 | null;
  num_orders_to_search: u32 | null;
  num_orders_to_cancel: u32 | null;
}

/** FailedMultipleLimitOrderBehavior (processor/new_order.rs). */
export enum FailedMultipleLimitOrderBehavior {
  FailOnInsufficientFundsAndAmendOnCross,
  FailOnInsufficientFundsAndFailOnCross,
  SkipOnInsufficientFundsAndAmendOnCross,
  SkipOnInsufficientFundsAndFailOnCross,
}

/** CondensedOrder: one order of a MultipleOrderPacket. */
export interface CondensedOrder {
  price_in_ticks: u64;
  size_in_base_lots: u64;
  last_valid_slot: u64 | null;
  last_valid_unix_timestamp_in_seconds: u64 | null;
}

/**
 * OrderPacket (state/order_schema/order_packet.rs). The matching engine's part decodes it from the instruction data
 * itself (the processor accepts packets written before the last three fields existed); this is its full layout.
 */
export type OrderPacket =
  | {
      kind: "PostOnly";
      side: Side;
      price_in_ticks: u64;
      num_base_lots: u64;
      client_order_id: u128;
      reject_post_only: boolean;
      use_only_deposited_funds: boolean;
      last_valid_slot: u64 | null;
      last_valid_unix_timestamp_in_seconds: u64 | null;
      fail_silently_on_insufficient_funds: boolean;
    }
  | {
      kind: "Limit";
      side: Side;
      price_in_ticks: u64;
      num_base_lots: u64;
      self_trade_behavior: SelfTradeBehavior;
      match_limit: u64 | null;
      client_order_id: u128;
      use_only_deposited_funds: boolean;
      last_valid_slot: u64 | null;
      last_valid_unix_timestamp_in_seconds: u64 | null;
      fail_silently_on_insufficient_funds: boolean;
    }
  | {
      kind: "ImmediateOrCancel";
      side: Side;
      price_in_ticks: u64 | null;
      num_base_lots: u64;
      num_quote_lots: u64;
      min_base_lots_to_fill: u64;
      min_quote_lots_to_fill: u64;
      self_trade_behavior: SelfTradeBehavior;
      match_limit: u64 | null;
      client_order_id: u128;
      use_only_deposited_funds: boolean;
      last_valid_slot: u64 | null;
      last_valid_unix_timestamp_in_seconds: u64 | null;
    };

// ---- Events (program/events.rs) -------------------------------------------------------------------------------------

/**
 * PhoenixMarketEvent, Borsh: what the recorder sends in its Log self-CPIs. Each batch is `[15] ‖ Header ‖ events`; an
 * event's `index` counts the events of the whole instruction.
 */
export type PhoenixMarketEvent =
  | { kind: "Uninitialized" }
  | {
      kind: "Header";
      instruction: u8;
      sequence_number: u64;
      timestamp: i64;
      slot: u64;
      market: Pubkey;
      signer: Pubkey;
      total_events: u16;
    }
  | {
      kind: "Fill";
      index: u16;
      maker_id: Pubkey;
      order_sequence_number: u64;
      price_in_ticks: u64;
      base_lots_filled: u64;
      base_lots_remaining: u64;
    }
  | { kind: "Place"; index: u16; order_sequence_number: u64; client_order_id: u128; price_in_ticks: u64; base_lots_placed: u64 }
  | { kind: "Reduce"; index: u16; order_sequence_number: u64; price_in_ticks: u64; base_lots_removed: u64; base_lots_remaining: u64 }
  | { kind: "Evict"; index: u16; maker_id: Pubkey; order_sequence_number: u64; price_in_ticks: u64; base_lots_evicted: u64 }
  | {
      kind: "FillSummary";
      index: u16;
      client_order_id: u128;
      total_base_lots_filled: u64;
      total_quote_lots_filled: u64;
      total_fee_in_quote_lots: u64;
    }
  | { kind: "Fee"; index: u16; fees_collected_in_quote_lots: u64 }
  | { kind: "TimeInForce"; index: u16; order_sequence_number: u64; last_valid_slot: u64; last_valid_unix_timestamp_in_seconds: u64 }
  | { kind: "ExpiredOrder"; index: u16; maker_id: Pubkey; order_sequence_number: u64; price_in_ticks: u64; base_lots_removed: u64 };

// ---- The accepted market sizes (dispatch_market.rs) --------------------------------------------------------------------

/**
 * Whether (bids, asks, seats) is one of the twelve FIFOMarket instantiations the program was built with:
 * 512 × {128, 1025, 1153}, 1024 × {128, 2049, 2177}, 2048 × {128, 4097, 4225}, 4096 × {128, 8193, 8321}, bids = asks.
 */
export function isSupportedSize(bids: u64, asks: u64, seats: u64): boolean {
  if (bids !== asks) return false;
  if (bids === 512n) return seats === 128n || seats === 1025n || seats === 1153n;
  if (bids === 1024n) return seats === 128n || seats === 2049n || seats === 2177n;
  if (bids === 2048n) return seats === 128n || seats === 4097n || seats === 4225n;
  if (bids === 4096n) return seats === 128n || seats === 8193n || seats === 8321n;
  return false;
}

/** size_of::<FIFOMarket<_, N, N, S>>(): the prefix, two books and the traders. */
export function fifoMarketSize(bids: u64, seats: u64): u64 {
  return 304n + 2n * (TREE_HEADER_SIZE + ORDER_NODE_SIZE * bids) + TREE_HEADER_SIZE + TRADER_NODE_SIZE * seats;
}

/** Where the asks tree starts. */
export function asksOffset(bids: u64): u64 {
  return BIDS_OFFSET + TREE_HEADER_SIZE + ORDER_NODE_SIZE * bids;
}

/** Where the traders tree starts. */
export function tradersOffset(bids: u64): u64 {
  return BIDS_OFFSET + 2n * (TREE_HEADER_SIZE + ORDER_NODE_SIZE * bids);
}
