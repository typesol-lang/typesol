// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// Seats (processor/manage_seat.rs). A trader needs an approved seat to place limit orders: a 128-byte account at the
// PDA ["seat", market, trader], requested by the trader (RequestSeat) or for the trader by the market authority
// (RequestSeatAuthorized), created NotApproved, then approved or retired by the authority (ChangeSeatStatus). Approving
// a seat registers the trader in the market's traders tree.
//
// Accounts, after the entry's four (program, log authority, market, signer):
// - RequestSeatAuthorized (signer: the authority): payer (writable signer), trader, seat, System Program;
// - RequestSeat (signer: the trader, who pays): seat, System Program;
// - ChangeSeatStatus (signer: the authority): seat.
import {
  type MarketHeader,
  type Seat,
  type TraderState,
  SEAT_APPROVED,
  SEAT_DISCRIMINANT,
  SEAT_DISCRIMINANT_LOG,
  SEAT_NOT_APPROVED,
  SEAT_RETIRED,
  SEAT_SIZE,
  tradersOffset,
} from "./state.js";
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  ProgramError,
  createProgramAddress,
  findProgramAddressWithBump,
  loadRaw,
  loadRawMut,
  log,
  panic,
  rbTreeMutAt,
  require,
  u64,
} from "typesol";
import { assertPostAllowed, assertValidAuthority, checkEmptyAccount, checkPayer, checkSeat, checkSystemProgram, dispatchLoadedMarket } from "./checkers.js";
import { PHOENIX_ID, createPda, emptyTraderState, need } from "./util.js";

/** _create_seat: the seat PDA of (market, trader), created (128 bytes, owned by Phoenix) and written NotApproved. */
function createSeat(payer: RemainingAccount, trader: Pubkey, seat: RemainingAccount, market: Pubkey, systemProgram: RemainingAccount): void {
  const [address, bump] = findProgramAddressWithBump(["seat", market, trader], PHOENIX_ID);
  if (address !== seat.key) {
    log("Invalid seat address. \nsrc/program/processor/manage_seat.rs:69:5");
    require(false, ProgramError.InvalidAccountData);
  }
  createPda(payer, seat, systemProgram, PHOENIX_ID, SEAT_SIZE, "seat", market, trader, bump);
  // Seat::new_init (get_discriminant logs), then written over the new account's bytes.
  log(SEAT_DISCRIMINANT_LOG);
  const s = loadRawMut<Seat>(seat);
  s.discriminant = SEAT_DISCRIMINANT;
  s.market = market;
  s.trader = trader;
  s.approval_status = SEAT_NOT_APPROVED;
  for (let i = 0n; i < 6n; i++) s.padding.set(i, 0n);
}

/** process_request_seat_authorized: the authority requests a seat for `trader`, `payer` funding it. */
export function requestSeatAuthorized(rest: RemainingAccounts): void {
  const market = rest.get(2n);
  assertValidAuthority(market, rest.get(3n).key);
  need(rest, 5n);
  checkPayer(rest.get(4n));
  need(rest, 7n);
  checkEmptyAccount(rest.get(6n));
  need(rest, 8n);
  checkSystemProgram(rest.get(7n));
  createSeat(rest.get(4n), rest.get(5n).key, rest.get(6n), market.key, rest.get(7n));
}

/** process_request_seat: the trader requests (and pays for) its own seat, while the market takes orders. */
export function requestSeat(rest: RemainingAccounts): void {
  const market = rest.get(2n);
  assertPostAllowed(market);
  need(rest, 5n);
  checkEmptyAccount(rest.get(4n));
  need(rest, 6n);
  checkSystemProgram(rest.get(5n));
  createSeat(rest.get(3n), rest.get(3n).key, rest.get(4n), market.key, rest.get(5n));
}

/** SeatApprovalStatus's Display. */
function seatStatusName(status: u64): string {
  if (status === SEAT_NOT_APPROVED) return "NotApproved";
  if (status === SEAT_APPROVED) return "Approved";
  return "Retired";
}

/**
 * process_change_seat_status: a SeatApprovalStatus (Borsh u8) after the tag. NotApproved → Approved registers the
 * trader (an empty TraderState; "Failed to register trader" when the traders tree is full); Approved → NotApproved,
 * Approved → Retired and NotApproved → Retired only change the seat; the same status logs and changes nothing; any
 * other transition (out of Retired) fails.
 */
export function changeSeatStatus(rest: RemainingAccounts, data: InstructionBytes): void {
  const market = rest.get(2n);
  assertValidAuthority(market, rest.get(3n).key);
  need(rest, 5n);
  const seatInfo = rest.get(4n);
  checkSeat(seatInfo, market.key);
  require(data.length === 2n && data.readU8(1n) <= 2n, ProgramError.BorshIoError);
  const next = u64(data.readU8(1n));
  const seat = loadRawMut<Seat>(seatInfo);
  const current = seat.approval_status;
  // SeatApprovalStatus::from panics past Retired; only Phoenix writes a seat.
  if (current > SEAT_RETIRED) panic("Invalid approval status", "src/program/status.rs:129:18");
  if (current === next) {
    log("Seat status is unchanged");
    return;
  }
  if (current === SEAT_NOT_APPROVED && next === SEAT_APPROVED) {
    seat.approval_status = SEAT_APPROVED;
    dispatchLoadedMarket(market);
    const h = loadRaw<MarketHeader>(market);
    const p = h.market_size_params;
    const traders = rbTreeMutAt<Pubkey, TraderState>(market, tradersOffset(p.bids_size), p.num_seats);
    // get_or_register_trader: insert an empty state unless the trader is there; None when the tree is full.
    if (traders.addrOf(seat.trader) === 0n && traders.insert(seat.trader, emptyTraderState()) === null) {
      log("Failed to register trader. \nsrc/program/processor/manage_seat.rs:122:13");
      require(false, ProgramError.InvalidArgument);
    }
    return;
  }
  if (current !== SEAT_RETIRED && next !== SEAT_NOT_APPROVED) {
    // Approved → Retired, NotApproved → Retired.
    seat.approval_status = next;
    return;
  }
  if (current === SEAT_APPROVED) {
    // Approved → NotApproved.
    seat.approval_status = next;
    return;
  }
  log(`Invalid seat status transition from ${seatStatusName(current)} to ${seatStatusName(next)}`);
  require(false, ProgramError.InvalidInstructionData);
}
