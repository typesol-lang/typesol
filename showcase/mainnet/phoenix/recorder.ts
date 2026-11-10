// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// The event recorder (program/event_recorder.rs). Phoenix does not log its market events: it sends them to itself in
// Log instructions (tag 15), self-CPIs signed by the log authority PDA ["log"], so clients read them from the
// transaction's inner instructions. Each Log instruction's data is
//
//   [15] ‖ Borsh(PhoenixMarketEvent::Header(AuditLogHeader { instruction, sequence_number, timestamp, slot, market,
//          signer, total_events })) ‖ the batch's events
//
// 93 bytes of header, `total_events` (bytes 91..93) patched with the batch's own count before each send. An event is
// appended unless the data would then pass the 1280-byte inner-instruction limit (with 34 bytes for the one account
// meta), in which case the batch is sent first (makeRoom). The code that records an event appends it in place with
// pushBorsh of its PhoenixMarketEvent literal, which writes only that variant: Phoenix serializes each event into a
// scratch buffer first, the same bytes. When the instruction ends, the market's sequence number goes up by one and what
// is left is sent, always at least one batch (an instruction with no events sends the bare header).
//
// The entry owns the recorder's state (a Recorder) and the Log instruction's data (a FixedVec<u8, 1280> on its
// stack); the helpers that record take both as `Inout<…>` (Rust's `&mut EventRecorder`), with the instruction's
// accounts for the CPI. They are two places rather than one struct because the compiler builds a struct literal's
// FixedVec field in a temporary and copies it in (2.4k compute units, and the stack twice over, for 1280 bytes).
import {
  type FixedVec,
  type Inout,
  type Pubkey,
  type RemainingAccounts,
  type i64,
  ProgramError,
  fixedVec,
  invokeInstruction,
  loadRawMut,
  log,
  panicsAt,
  require,
  u8,
  u16,
  u64,
} from "typesol";
import { type MarketHeader, type PhoenixMarketEvent } from "./state.js";
import { LOG_AUTHORITY_BUMP, LOG_AUTHORITY_ID, PHOENIX_ID } from "./util.js";

/** The maximum data of an inner instruction (MAX_INNER_INSTRUCTION_SIZE). */
const MAX_INNER_INSTRUCTION_SIZE = 1280n;
/** The bytes of the Log instruction's one AccountMeta (LOG_IX_ACCOUNT_META_SIZE). */
const LOG_IX_ACCOUNT_META_SIZE = 34n;
/** The room the batch's data has: an event is appended while it fits (makeRoom). */
export const EVENT_ROOM = MAX_INNER_INSTRUCTION_SIZE - LOG_IX_ACCOUNT_META_SIZE;
/**
 * [15] and the Borsh header: the PhoenixMarketEvent tag, the instruction (u8), the sequence number, timestamp and slot
 * (8 bytes each), the market and the signer, total_events (u16).
 */
export const HEADER_LEN = 1n + 1n + 1n + 3n * 8n + 2n * 32n + 2n;
/**
 * Each event's bytes, the PhoenixMarketEvent tag and the index (u16) first: the room makeRoom asks for. The largest is a
 * Fill (MAX_EVENT_SIZE).
 */
export const FILL_EVENT_LEN = 1n + 2n + 32n + 4n * 8n; // maker, sequence number, price, lots filled, lots remaining
export const REDUCE_EVENT_LEN = 1n + 2n + 4n * 8n; // sequence number, price, lots removed, lots remaining
export const PLACE_EVENT_LEN = 1n + 2n + 8n + 16n + 8n + 8n; // sequence number, client order id, price, lots
export const SUMMARY_EVENT_LEN = 1n + 2n + 16n + 3n * 8n; // client order id, base lots, quote lots, fee
export const TIME_IN_FORCE_EVENT_LEN = 1n + 2n + 3n * 8n; // sequence number, last valid slot and timestamp
export const EVICT_EVENT_LEN = 1n + 2n + 32n + 3n * 8n; // maker, sequence number, price, lots (ExpiredOrder too)
export const FEE_EVENT_LEN = 1n + 2n + 8n; // fees collected

/** PhoenixInstruction tags the recorder itself needs. */
export const TAG_LOG = 15n;
export const TAG_CHANGE_MARKET_STATUS = 103n;

/** An AccountMeta of a CPI built by hand. */
interface Meta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

/** EventRecorder's state with its EventStateTracker. */
export interface Recorder {
  /** The PhoenixInstruction being recorded. */
  instruction: u8;
  /** Batches sent so far. */
  batchIndex: u64;
  /** Events sent so far (u16 in the original). */
  eventsEmitted: u64;
  /** Events added so far; the next event's index. */
  eventsAdded: u64;
}

/**
 * EventRecorder::new: `data` holds [15]; the header follows, with the market's sequence number as the instruction
 * starts, the clock, the market and the signer.
 */
export function startRecorder(
  rec: Inout<Recorder>,
  data: Inout<FixedVec<u8, 1280>>,
  sequenceNumber: u64,
  timestamp: i64,
  slot: u64,
  market: Pubkey,
  signer: Pubkey,
): void {
  data.pushBorsh<PhoenixMarketEvent>({
    kind: "Header",
    instruction: rec.instruction,
    sequence_number: sequenceNumber,
    timestamp,
    slot,
    market,
    signer,
    total_events: 0n, // patched before each send
  });
}

/** EventRecorder::flush: log the batch, patch its count in, send it, keep the header. */
export function flush(rec: Inout<Recorder>, data: Inout<FixedVec<u8, 1280>>, rest: RemainingAccounts): void {
  const batch = rec.eventsAdded - rec.eventsEmitted;
  log(`Sending batch ${rec.batchIndex + 1n} with header and ${batch} market events, total events sent: ${rec.eventsAdded}`);
  data.setLE(HEADER_LEN - 2n, u16(batch));
  const metas: FixedVec<Meta, 1> = fixedVec([{ pubkey: LOG_AUTHORITY_ID, isSigner: true, isWritable: false }]);
  // invoke_signed with [phoenix_program, log_authority]: the entry's first two accounts.
  invokeInstruction(PHOENIX_ID, metas, data, rest.slice(0n, 2n), ["log", LOG_AUTHORITY_BUMP]);
  data.truncate(HEADER_LEN);
  rec.eventsEmitted = rec.eventsAdded;
  rec.batchIndex++;
}

/**
 * EventRecorder::add_event, its flush: the batch so far is sent first when an event of `len` bytes would take the data
 * past the limit. The caller then appends the event, `data.pushBorsh<PhoenixMarketEvent>({ kind: …, index:
 * u16(rec.eventsAdded), … })` (which writes only that variant's bytes, straight into the batch, where add_event
 * serializes the event into a scratch buffer first: the same bytes), and counts it, `rec.eventsAdded++`.
 */
export function makeRoom(rec: Inout<Recorder>, data: Inout<FixedVec<u8, 1280>>, rest: RemainingAccounts, len: u64): void {
  if (data.length + len > EVENT_ROOM) flush(rec, data, rest);
}

/**
 * increment_market_sequence_number_and_flush: the sequence number up by one (a market Tombstone emptied has no header:
 * only ChangeMarketStatus may do that), then the last batch.
 */
export function finishRecorder(rec: Inout<Recorder>, data: Inout<FixedVec<u8, 1280>>, rest: RemainingAccounts): void {
  const market = rest.get(2n);
  if (market.dataLen === 0n) {
    if (rec.instruction !== u8(TAG_CHANGE_MARKET_STATUS)) {
      log("The only instruction that can be used to delete a market is ChangeMarketStatus. \nsrc/program/event_recorder.rs:197:13");
      require(false, ProgramError.InvalidInstructionData);
    }
  } else {
    const h = loadRawMut<MarketHeader>(market);
    h.market_sequence_number = panicsAt("src/program/accounts.rs:131:9", h.market_sequence_number + 1n);
  }
  if (rec.batchIndex === 0n || rec.eventsEmitted < rec.eventsAdded) flush(rec, data, rest);
}
