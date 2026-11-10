// Byte builders on FixedVec<u8, N> (pushLE, pushKey, pushBorsh, setLE, truncate), and Phoenix's event recorder built
// from them: `[15] ‖ Borsh(Header) ‖ events`, the batch's event count patched in at bytes 91..93, flushed by a self-CPI
// signed by the log authority PDA, truncated back to the 93-byte header after each flush.
import {
  FixedArray,
  FixedVec,
  InstructionBytes,
  ProgramError,
  Pubkey,
  RemainingAccounts,
  currentSlot,
  findProgramAddressBump,
  fixedArray,
  fixedVec,
  i8,
  i16,
  i32,
  i64,
  i128,
  instructionData,
  invokeInstruction,
  loadRawMut,
  log,
  now,
  programId,
  remainingAccounts,
  require,
  setReturnData,
  u8,
  u16,
  u32,
  u64,
  u128,
} from "typesol";

export type PhoenixMarketEvent =
  | { kind: "Uninitialized" }
  | {
      kind: "Header";
      instruction: u8;
      sequenceNumber: u64;
      timestamp: i64;
      slot: u64;
      market: Pubkey;
      signer: Pubkey;
      totalEvents: u16;
    }
  | {
      kind: "Fill";
      index: u16;
      makerId: Pubkey;
      orderSequenceNumber: u64;
      priceInTicks: u64;
      baseLotsFilled: u64;
      baseLotsRemaining: u64;
    }
  | { kind: "Fee"; index: u16; feesCollectedInQuoteLots: u64 };

export interface Meta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Point {
  x: u32;
  y: i16;
}

export interface Quote {
  price: u64;
  limit: u64 | null;
  owner: Pubkey;
}

export interface Scratch {
  buf: FixedVec<u8, 16>;
}

const HEADER_LEN = 93n;
const MAX_INNER_INSTRUCTION_SIZE = 1280n;
const LOG_IX_ACCOUNT_META_SIZE = 34n;

/** The integers at their widths, a Pubkey, setLE and truncate. */
function scalars(data: InstructionBytes): void {
  const buf: FixedVec<u8, 128> = fixedVec([]);
  buf.pushLE(u8(0xabn));
  buf.pushLE<u16>(0x1234n);
  buf.pushLE(u32(0xdeadbeefn));
  buf.pushLE(data.readU64(1n));
  buf.pushLE(u128(1n) << 100n);
  buf.pushLE(i8(-2n));
  buf.pushLE<i16>(-3n);
  buf.pushLE(i32(-4n));
  buf.pushLE(i64(-5n));
  buf.pushLE(i128(-6n));
  buf.pushKey(programId());
  buf.setLE<u16>(1n, 0xbeefn);
  buf.setLE(3n, u32(7n));
  setReturnData(buf);
}

/** Borsh values: structs (fixed and with an Option), a data enum, a list, an array, a string, Options, a bool. */
function values(owner: Pubkey): void {
  const buf: FixedVec<u8, 256> = fixedVec([]);
  const p: Point = { x: 7n, y: -1n };
  buf.pushBorsh(p);
  buf.pushBorsh<Quote>({ price: 5n, limit: null, owner });
  const q: Quote = { price: 6n, limit: 9n, owner };
  buf.pushBorsh(q);
  const fee: PhoenixMarketEvent = { kind: "Fee", index: 3n, feesCollectedInQuoteLots: 100n };
  buf.pushBorsh(fee);
  buf.pushBorsh<PhoenixMarketEvent>({ kind: "Uninitialized" });
  const xs: FixedVec<u16, 4> = fixedVec([1n, 2n]);
  buf.pushBorsh(xs);
  const arr: FixedArray<u8, 3> = fixedArray(9n);
  buf.pushBorsh(arr);
  buf.pushBorsh("hi");
  const none: u32 | null = null;
  buf.pushBorsh(none);
  const some: u32 | null = 77n;
  buf.pushBorsh(some);
  buf.pushBorsh(true);
  buf.pushBorsh(u16(513n));
  setReturnData(buf);
}

/** Phoenix's EventRecorder: the header, events added with a running index, batches flushed by self-CPI. */
function recordEvents(rest: RemainingAccounts, instruction: u8, sequenceNumber: u64, fills: u64): void {
  const logAuthority = rest.get(1n).key;
  const data: FixedVec<u8, 1280> = fixedVec([15n]);
  data.pushBorsh<PhoenixMarketEvent>({
    kind: "Header",
    instruction,
    sequenceNumber,
    timestamp: now(),
    slot: currentSlot(),
    market: rest.get(2n).key,
    signer: rest.get(3n).key,
    totalEvents: 0n,
  });
  const metas: FixedVec<Meta, 1> = fixedVec([{ pubkey: logAuthority, isSigner: true, isWritable: false }]);
  const bump = findProgramAddressBump(["log"], programId());
  let batch = 0n;
  let emitted = 0n;
  let added = 0n;
  for (let i = 0n; i < fills; i++) {
    const event: FixedVec<u8, 67> = fixedVec([]);
    event.pushBorsh<PhoenixMarketEvent>({
      kind: "Fill",
      index: u16(added),
      makerId: rest.get(3n).key,
      orderSequenceNumber: i,
      priceInTicks: 1000n + i,
      baseLotsFilled: 1n,
      baseLotsRemaining: 0n,
    });
    if (data.length + event.length + LOG_IX_ACCOUNT_META_SIZE > MAX_INNER_INSTRUCTION_SIZE) {
      log(`Sending batch ${batch + 1n} with header and ${added - emitted} market events, total events sent: ${added}`);
      data.setLE(HEADER_LEN - 2n, u16(added - emitted));
      invokeInstruction(programId(), metas, data, rest, ["log", bump]);
      data.truncate(HEADER_LEN);
      batch++;
      emitted = added;
    }
    data.pushAll(event);
    added++;
  }
  log(`Sending batch ${batch + 1n} with header and ${added - emitted} market events, total events sent: ${added}`);
  data.setLE(HEADER_LEN - 2n, u16(added - emitted));
  invokeInstruction(programId(), metas, data, rest, ["log", bump]);
  data.truncate(HEADER_LEN);
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const rest = remainingAccounts();
  // Phoenix's Log instruction: only the log authority, signing through the self-CPI.
  if (tag === 15n) {
    require(rest.get(0n).isSigner, ProgramError.MissingRequiredSignature);
    return;
  }
  if (tag === 0n) {
    scalars(data);
    return;
  }
  if (tag === 1n) {
    values(rest.get(0n).key);
    return;
  }
  // [2, instruction u8, sequence number u64, fills u64]
  if (tag === 2n) {
    recordEvents(rest, data.readU8(1n), data.readU64(2n), data.readU64(10n));
    return;
  }
  // A FixedVec<u8, N> in account data (a loadRawMut view).
  if (tag === 3n) {
    const s = loadRawMut<Scratch>(rest.get(0n));
    s.buf.pushLE(u32(0x01020304n));
    s.buf.pushLE(u64(5n));
    return;
  }
  if (tag === 4n) {
    const s = loadRawMut<Scratch>(rest.get(0n));
    s.buf.truncate(2n);
    s.buf.pushLE(u16(0xffffn));
    return;
  }
  // Failures: past the room, setLE past the length, truncate past the length, pushBorsh past the room.
  const small: FixedVec<u8, 4> = fixedVec([1n]);
  if (tag === 5n) small.pushLE(u32(1n));
  if (tag === 6n) small.setLE(0n, u16(1n));
  if (tag === 7n) small.truncate(2n);
  if (tag === 8n) small.pushBorsh("abcd");
  if (tag === 9n) small.pushKey(programId());
  const q: Quote = { price: 1n, limit: 2n, owner: programId() };
  if (tag === 10n) small.pushBorsh(q);
  log("no failure");
}
