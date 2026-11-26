// Whole-value copies and zero-fills from the memory syscalls' thresholds on (runtime/typesol_rt.h): struct assignments
// between views of one account at run-time offsets (which may overlap) or of an account passed twice, below (3 to 79
// bytes) and from TS_COPY_SYSCALL_MIN (80 bytes); copies through a local of the function just below and from
// TS_LOCAL_COPY_SYSCALL_MIN (400); a struct literal built in a temporary; an Option<struct> set to null below and from
// TS_ZERO_SYSCALL_MIN (192); and resizeAccount's zero-fill (TS_ZERO_RUN_MIN, 64).
import { type FixedArray, type Option, type u8, type u64, ProgramError, instructionData, loadRawAt, loadRawMutAt, remainingAccounts, require, resizeAccount } from "typesol";

/** 3, 6, 16, 40 and 72 bytes: copies below the threshold between pointers (every byte read before any is written). */
export interface B3 {
  b: FixedArray<u8, 3>;
}
export interface B6 {
  b: FixedArray<u8, 6>;
}
export interface B16 {
  a: u64;
  b: u64;
}
export interface B40 {
  head: u64;
  rest: FixedArray<u8, 32>;
}
export interface B72 {
  head: u64;
  rest: FixedArray<u8, 64>;
}
export interface H3 {
  v: B3;
}
export interface H6 {
  v: B6;
}
export interface H16 {
  v: B16;
}
export interface H40 {
  v: B40;
}
export interface H72 {
  v: B72;
}
/** 79 bytes: one below the copy threshold between pointers. */
export interface B79 {
  head: u64;
  rest: FixedArray<u8, 71>;
}
/** 80 bytes: the threshold (the memmove syscall). */
export interface B80 {
  head: u64;
  rest: FixedArray<u8, 72>;
}
/** 87 bytes: past the threshold, a length that is not a multiple of 8. */
export interface B87 {
  head: u64;
  rest: FixedArray<u8, 79>;
}
/** 399 and 400 bytes: around the threshold for a copy through a local. */
export interface B399 {
  head: u64;
  rest: FixedArray<u8, 391>;
}
export interface B400 {
  head: u64;
  rest: FixedArray<u8, 392>;
}
/** 1 KiB. */
export interface B1024 {
  head: u64;
  rest: FixedArray<u8, 1016>;
}
export interface H79 {
  v: B79;
}
export interface H80 {
  v: B80;
}
export interface H87 {
  v: B87;
}
export interface H399 {
  v: B399;
}
export interface H400 {
  v: B400;
}
export interface H1024 {
  v: B1024;
}
/** An Option<struct> whose value is 191 bytes (zeroed by stores) and one of 192 (the memset syscall). */
export interface Z191 {
  head: u64;
  rest: FixedArray<u8, 183>;
}
export interface Z192 {
  head: u64;
  rest: FixedArray<u8, 184>;
}
export interface O191 {
  o: Option<Z191>;
}
export interface O192 {
  o: Option<Z192>;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 18n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const run = data.readU8(17n);
  const rest = remainingAccounts();
  // The source may be the same account as the destination or another (the same one passed twice).
  const from = rest.length > 1n ? rest.get(1n) : rest.get(0n);
  if (tag === 0n) {
    const d = loadRawMutAt<H79>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H79>(from, data.readU64(9n));
    if (run === 1n) d.v = s.v;
  } else if (tag === 1n) {
    const d = loadRawMutAt<H80>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H80>(from, data.readU64(9n));
    if (run === 1n) d.v = s.v;
  } else if (tag === 2n) {
    const d = loadRawMutAt<H87>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H87>(from, data.readU64(9n));
    if (run === 1n) d.v = s.v;
  } else if (tag === 3n) {
    const d = loadRawMutAt<H1024>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H1024>(from, data.readU64(9n));
    if (run === 1n) d.v = s.v;
  } else if (tag === 4n) {
    // A struct literal is built in a temporary (it reads the old value) and copied whole into place.
    const d = loadRawMutAt<H1024>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H1024>(from, data.readU64(9n));
    if (run === 1n) d.v = { head: d.v.head + 1n, rest: s.v.rest };
  } else if (tag === 5n) {
    const d = loadRawMutAt<O191>(rest.get(0n), data.readU64(1n));
    if (run === 1n) d.o = null;
  } else if (tag === 6n) {
    const d = loadRawMutAt<O192>(rest.get(0n), data.readU64(1n));
    if (run === 1n) d.o = null;
  } else if (tag === 7n) {
    // resizeAccount: bytes past the old length are zeroed.
    resizeAccount(rest.get(0n), data.readU64(1n));
  } else if (tag === 8n) {
    // Through a local copy (an annotated binding is a copy): the source's old bytes, whatever the overlap.
    const d = loadRawMutAt<H399>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H399>(from, data.readU64(9n));
    const c: B399 = s.v;
    if (run === 1n) d.v = c;
  } else if (tag === 9n) {
    const d = loadRawMutAt<H400>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H400>(from, data.readU64(9n));
    const c: B400 = s.v;
    if (run === 1n) d.v = c;
  } else if (tag === 10n) {
    const d = loadRawMutAt<H3>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H3>(from, data.readU64(9n));
    if (run === 1n) d.v = s.v;
  } else if (tag === 11n) {
    const d = loadRawMutAt<H6>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H6>(from, data.readU64(9n));
    if (run === 1n) d.v = s.v;
  } else if (tag === 12n) {
    const d = loadRawMutAt<H16>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H16>(from, data.readU64(9n));
    if (run === 1n) d.v = s.v;
  } else if (tag === 13n) {
    const d = loadRawMutAt<H40>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H40>(from, data.readU64(9n));
    if (run === 1n) d.v = s.v;
  } else if (tag === 14n) {
    const d = loadRawMutAt<H72>(rest.get(0n), data.readU64(1n));
    const s = loadRawAt<H72>(from, data.readU64(9n));
    if (run === 1n) d.v = s.v;
  }
}
