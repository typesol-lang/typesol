// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// The market authority's instructions of processor/governance.rs: ClaimAuthority, NameSuccessor and
// ChangeMarketStatus. (ForceCancelOrders and EvictSeat, the authority's cancel and withdraw, are in cancel.ts.)
//
// Accounts, after the entry's four (program, log authority, market, signer): ChangeMarketStatus takes an optional
// receiver of a tombstoned market's lamports (the signer when left out).
import {
  type FIFOOrderId,
  type FIFORestingOrder,
  type FifoMarketPrefix,
  type MarketHeader,
  type TraderState,
  BIDS_OFFSET,
  FIFO_MARKET_OFFSET,
  MARKET_STATUS_ACTIVE,
  MARKET_STATUS_CLOSED,
  MARKET_STATUS_PAUSED,
  MARKET_STATUS_POST_ONLY,
  MARKET_STATUS_TOMBSTONED,
  asksOffset,
  tradersOffset,
} from "./state.js";
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccounts,
  u64,
  ProgramError,
  closeRaw,
  loadRawAt,
  loadRawMut,
  log,
  rbTreeAt,
  require,
} from "typesol";
import { PhoenixError } from "./errors.js";
import { assertValidAuthority, assertValidSuccessor, dispatchLoadedMarket, statusName } from "./checkers.js";
import { orderCmp } from "./util.js";

/** process_claim_authority: the named successor takes the authority. */
export function claimAuthority(rest: RemainingAccounts): void {
  const market = rest.get(2n);
  const successor = rest.get(3n).key;
  assertValidSuccessor(market, successor);
  const h = loadRawMut<MarketHeader>(market);
  h.authority = successor;
}

/** process_name_successor: the authority names its successor (a Borsh Pubkey after the tag). */
export function nameSuccessor(rest: RemainingAccounts, data: InstructionBytes): void {
  const market = rest.get(2n);
  assertValidAuthority(market, rest.get(3n).key);
  require(data.length === 33n, ProgramError.BorshIoError);
  const h = loadRawMut<MarketHeader>(market);
  h.successor = data.readPubkey(1n);
}

/** MarketStatus::valid_state_transition. */
function validTransition(from: u64, to: u64): boolean {
  if (from === 0n) return to === MARKET_STATUS_POST_ONLY;
  if (from === MARKET_STATUS_ACTIVE) return to === MARKET_STATUS_POST_ONLY || to === MARKET_STATUS_PAUSED || to === MARKET_STATUS_ACTIVE;
  if (from === MARKET_STATUS_POST_ONLY)
    return to === MARKET_STATUS_ACTIVE || to === MARKET_STATUS_PAUSED || to === MARKET_STATUS_CLOSED || to === MARKET_STATUS_POST_ONLY;
  if (from === MARKET_STATUS_CLOSED)
    return to === MARKET_STATUS_TOMBSTONED || to === MARKET_STATUS_PAUSED || to === MARKET_STATUS_CLOSED || to === MARKET_STATUS_POST_ONLY;
  if (from === MARKET_STATUS_PAUSED)
    return to === MARKET_STATUS_ACTIVE || to === MARKET_STATUS_POST_ONLY || to === MARKET_STATUS_CLOSED || to === MARKET_STATUS_PAUSED;
  return false;
}

/**
 * process_change_market_status: a MarketStatus (Borsh u8) after the tag, reached by a valid transition. Tombstoned
 * deletes the market: the books, the uncollected fees and the traders must all be empty, then its lamports go to the
 * receiver, it is assigned to the System Program and its data dropped (realloc to 0).
 */
export function changeMarketStatus(rest: RemainingAccounts, data: InstructionBytes): void {
  const market = rest.get(2n);
  const authority = rest.get(3n);
  assertValidAuthority(market, authority.key);
  require(data.length === 2n && data.readU8(1n) <= 5n, ProgramError.BorshIoError);
  const next = u64(data.readU8(1n));
  const h = loadRawMut<MarketHeader>(market);
  const status = h.status;
  if (!validTransition(status, next)) {
    // MarketStatus::from(status) first: only Phoenix writes the header, so the status is always one of the six.
    statusName(status);
    log("Invalid state transition. \nsrc/program/status.rs:84:9");
    require(false, PhoenixError.InvalidStateTransition);
  }
  if (next !== MARKET_STATUS_TOMBSTONED) {
    h.status = next;
    log(`Market status changed to ${statusName(next)}`);
    return;
  }
  dispatchLoadedMarket(market);
  const p = h.market_size_params;
  const bids = rbTreeAt<FIFOOrderId, FIFORestingOrder>(market, BIDS_OFFSET, p.bids_size, orderCmp);
  const asks = rbTreeAt<FIFOOrderId, FIFORestingOrder>(market, asksOffset(p.bids_size), p.asks_size, orderCmp);
  if (bids.length !== 0n || asks.length !== 0n) {
    log(`Invalid market status, must have no open orders, found ${bids.length} bids and ${asks.length} asks. \nsrc/program/processor/governance.rs:132:17`);
    require(false, ProgramError.InvalidAccountData);
  }
  const fifo = loadRawAt<FifoMarketPrefix>(market, FIFO_MARKET_OFFSET);
  if (fifo.unclaimed_quote_lot_fees !== 0n) {
    log("Invalid market status, must have no uncollected fees. \nsrc/program/processor/governance.rs:141:17");
    require(false, ProgramError.InvalidAccountData);
  }
  const traders = rbTreeAt<Pubkey, TraderState>(market, tradersOffset(p.bids_size), p.num_seats);
  if (traders.length !== 0n) {
    log(`Invalid market status, must have no traders, found ${traders.length}. \nsrc/program/processor/governance.rs:147:17`);
    require(false, ProgramError.InvalidAccountData);
  }
  // receiver.lamports += market.lamports; market.lamports = 0; assign(System); realloc(0, false).
  closeRaw(market, rest.length > 4n ? rest.get(4n) : authority);
  log("Market has been removed");
}
