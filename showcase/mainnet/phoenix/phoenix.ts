// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// Phoenix v1, the program at PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY: a limit order book that matches and settles
// on chain. It is a native program (lib.rs): a u8 tag, the instruction's Borsh arguments after it, accounts by
// position. Every instruction but Log starts with the same four accounts (the program itself, the log authority PDA,
// the market, the signer), checked here; the market's events are sent to the program itself in Log self-CPIs
// (recorder.ts) and the market's sequence number goes up by one when the instruction ends.
//
// The instructions live by subject: initialize.ts (InitializeMarket), governance.ts (ClaimAuthority, NameSuccessor,
// ChangeMarketStatus), seats.ts (RequestSeat, RequestSeatAuthorized, ChangeSeatStatus), funds.ts (DepositFunds,
// WithdrawFunds), fees.ts (CollectFees, ChangeFeeRecipient), orders.ts (swaps and limit orders) and cancel.ts
// (reductions, cancels, ForceCancelOrders, EvictSeat).
import { type FixedVec, type u8, ProgramError, currentSlot, fixedVec, instructionData, loadRaw, log, now, panic, remainingAccounts, require } from "typesol";
import { type MarketHeader } from "./state.js";
import { type Recorder, TAG_LOG, finishRecorder, startRecorder } from "./recorder.js";
import { checkLogAuthority, checkMarket, checkMarketInit, checkPhoenixProgram, checkSigner } from "./checkers.js";
import { LOG_AUTHORITY_ID } from "./util.js";
import { initializeMarket } from "./initialize.js";
import { changeMarketStatus, claimAuthority, nameSuccessor } from "./governance.js";
import { changeSeatStatus, requestSeat, requestSeatAuthorized } from "./seats.js";
import { depositFunds, withdrawFunds } from "./funds.js";
import { changeFeeRecipient, collectFees } from "./fees.js";
import {
  placeLimitOrder,
  placeLimitOrderWithFreeFunds,
  placeMultiplePostOnlyOrders,
  placeMultiplePostOnlyOrdersWithFreeFunds,
  swap,
  swapWithFreeFunds,
} from "./orders.js";
import { cancelAllOrders, cancelMultipleOrdersById, cancelUpTo, evictSeat, forceCancelOrders, reduceOrder } from "./cancel.js";

/** Rust panics as solana-program 1.14 reports them: `panicked at '<msg>', <file>:<line>:<col>`, then abort. */
export const PANIC_STYLE = "solana-1.14";
/** Phoenix is built with overflow checks: arithmetic outside the panicsAt sites panics too, as Rust's would. */
export const PANIC_ON_OVERFLOW = true;
/**
 * The account data is written in place as Phoenix writes it: the header, the FIFOMarket and its trees are separate
 * views of one account, and the runtime judges the writes when the instruction ends.
 */
export const NATIVE_ACCOUNT_WRITES = true;
/**
 * Phoenix's entrypoint logs nothing when an instruction fails (what it has to say is the assert line before). The
 * compiler writes a line for every failure; these make it the bare error: the PhoenixError's text, or the
 * ProgramError's name.
 */
export const ERROR_LOG_PREFIX = null;
export const PROGRAM_ERROR_LOG_PREFIX = null;
/** Phoenix ignores accounts after the ones it reads, however many; the default of 32 would refuse more (5113). */
export const MAX_ACCOUNTS = 255n;

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  // `instruction_data.split_first()` and `PhoenixInstruction::try_from(tag)`: 0..=17 and 100..=109.
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  require(tag <= 17n || (tag >= 100n && tag <= 109n), ProgramError.InvalidInstructionData);

  // Log: the recorder's self-CPI, which only the log authority (signing through the CPI) may send.
  if (tag === TAG_LOG) {
    require(rest.length >= 1n, ProgramError.NotEnoughAccountKeys);
    if (!rest.get(0n).isSigner) {
      log("Log authority must sign through CPI. \nsrc/lib.rs:114:9");
      require(false, ProgramError.MissingRequiredSignature);
    }
    if (rest.get(0n).key !== LOG_AUTHORITY_ID) {
      log("Invalid log authority. \nsrc/lib.rs:119:9");
      require(false, ProgramError.InvalidArgument);
    }
    return;
  }

  // `let (program_accounts, accounts) = accounts.split_at(4);`
  if (rest.length < 4n) panic("assertion failed: mid <= self.len()", "src/lib.rs:127:49");
  // PhoenixLogContext::load, then PhoenixMarketContext::load (load_init for InitializeMarket).
  checkPhoenixProgram(rest.get(0n));
  checkLogAuthority(rest.get(1n));
  const market = rest.get(2n);
  if (tag === 100n) checkMarketInit(market);
  else checkMarket(market);
  checkSigner(rest.get(3n));

  // EventRecorder::new: the header carries the market's sequence number as the instruction starts.
  const rec: Recorder = { instruction: tag, batchIndex: 0n, eventsEmitted: 0n, eventsAdded: 0n };
  // The Log instruction's data, [15] then the header (built empty, then pushed: cheaper than fixedVec([15n])).
  const logData: FixedVec<u8, 1280> = fixedVec([]);
  logData.pushLE<u8>(15n);
  const header = loadRaw<MarketHeader>(market);
  startRecorder(rec, logData, header.market_sequence_number, now(), currentSlot(), market.key, rest.get(3n).key);

  switch (tag) {
    case 100n:
      log("PhoenixInstruction::Initialize");
      initializeMarket(rest, data);
      break;
    case 0n:
      log("PhoenixInstruction::Swap");
      swap();
      break;
    case 1n:
      log("PhoenixInstruction::SwapWithFreeFunds");
      swapWithFreeFunds();
      break;
    case 2n:
      log("PhoenixInstruction::PlaceLimitOrder");
      placeLimitOrder();
      break;
    case 3n:
      log("PhoenixInstruction::PlaceLimitOrderWithFreeFunds");
      placeLimitOrderWithFreeFunds();
      break;
    case 16n:
      log("PhoenixInstruction::PlaceMultiplePostOnlyOrders");
      placeMultiplePostOnlyOrders();
      break;
    case 17n:
      log("PhoenixInstruction::PlaceMultiplePostOnlyOrdersWithFreeFunds");
      placeMultiplePostOnlyOrdersWithFreeFunds();
      break;
    case 4n:
      log("PhoenixInstruction::ReduceOrder");
      reduceOrder();
      break;
    case 5n:
      log("PhoenixInstruction::ReduceOrderWithFreeFunds");
      reduceOrder();
      break;
    case 6n:
      log("PhoenixInstruction::CancelAllOrders");
      cancelAllOrders();
      break;
    case 7n:
      log("PhoenixInstruction::CancelAllOrdersWithFreeFunds");
      cancelAllOrders();
      break;
    case 8n:
      // (Phoenix logs CancelUpTo under this name.)
      log("PhoenixInstruction::CancelMultipleOrders");
      cancelUpTo();
      break;
    case 9n:
      log("PhoenixInstruction::CancelUpToWithFreeFunds");
      cancelUpTo();
      break;
    case 10n:
      log("PhoenixInstruction::CancelMultipleOrdersById");
      cancelMultipleOrdersById();
      break;
    case 11n:
      log("PhoenixInstruction::CancelMultipleOrdersByIdWithFreeFunds");
      cancelMultipleOrdersById();
      break;
    case 12n:
      log("PhoenixInstruction::WithdrawFunds");
      withdrawFunds(rest, data);
      break;
    case 13n:
      log("PhoenixInstruction::DepositFunds");
      depositFunds(rest, data);
      break;
    case 107n:
      log("PhoenixInstruction::ForceCancelOrders");
      forceCancelOrders();
      break;
    case 106n:
      log("PhoenixInstruction::EvictSeat");
      evictSeat();
      break;
    case 101n:
      log("PhoenixInstruction::ClaimAuthority");
      claimAuthority(rest);
      break;
    case 102n:
      log("PhoenixInstruction::NameSuccessor");
      nameSuccessor(rest, data);
      break;
    case 103n:
      log("PhoenixInstruction::ChangeMarketStatus");
      changeMarketStatus(rest, data);
      break;
    case 105n:
      log("PhoenixInstruction::RequestSeatAuthorized");
      requestSeatAuthorized(rest);
      break;
    case 14n:
      log("PhoenixInstruction::RequestSeat");
      requestSeat(rest);
      break;
    case 104n:
      log("PhoenixInstruction::ChangeSeatStatus");
      changeSeatStatus(rest, data);
      break;
    case 108n:
      log("PhoenixInstruction::CollectFees");
      collectFees(rest, rec, logData);
      break;
    case 109n:
      log("PhoenixInstruction::ChangeFeeRecipient");
      changeFeeRecipient(rest);
      break;
  }
  finishRecorder(rec, logData, rest);
  // The ids of the orders that rested go out as return data here, after the last CPI (the order instructions).
}
