// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// Phoenix's heap, counted. Phoenix allocates with solana-program 1.14.9's BumpAllocator (entrypoint.rs): 32 KiB from
// the top down, each allocation rounded down to its alignment, nothing ever freed, and an allocation that would pass
// the heap's first 8 bytes (where the allocator keeps its position) fails: "Error: memory allocation failed, out of
// memory", then abort. So whether an instruction runs out of memory, and where, depends only on the bytes it has
// allocated so far, which this file counts as the Rust allocates them: the port allocates none of them (its own lists
// are fixed and its log lines built differently), so the count is all it has of Phoenix's heap.
//
// The count lives in the Recorder (`heap`: bytes allocated after the entrypoint's, from an 8-aligned position), which
// every instruction that records events carries, with `limit`: a count up to it surely fits. The entrypoint's own share
// (entrypoint.rs deserialize) is a Vec<AccountInfo> of 48 bytes per account entry, then two Rcs (32 + 40 bytes) per
// distinct account; a duplicate entry clones the first. So the limit starts at the room 120 bytes an account would
// leave, and the first time the count passes it the distinct accounts are counted and it becomes the room there is.
//
// Charged in the order the Rust allocates (each site cites the line it models):
// - before any instruction's own work, PREFIX: the market's discriminant line (get_discriminant's `phoenix_log!`, a
//   String grown 42 then 84 bytes) and the EventRecorder (event_recorder.rs:96, :114, :117: 1280 + 67 + 34 bytes);
// - the status checks' messages, built whether or not they fail (phoenix_checkers.rs:59, :69, :82) and the seat's
//   discriminant line;
// - each batch the recorder sends: its "Sending batch" line (event_recorder.rs:227), 132 bytes;
// - the Vecs the instructions grow: the ids a cancel collects (fifo.rs:1453, :1492; cancel_multiple_orders.rs:195),
//   the decoded lists of CancelMultipleOrdersById and the multiple-order packet (borsh 0.9.3's Vec, its first allocation
//   capped at 4096 bytes of elements), the sorted orders (itertools' sorted_by and the standard library's merge sort),
//   the placed order ids (lib.rs:139) and their Borsh bytes (lib.rs:369);
// - sokoban's tree iterators (red_black_tree.rs:180: a boxed iterator of 88 bytes, whose stack, a Vec<u32>, grows as
//   deep as the walk goes) for the cancels and a Limit order's crossing check (fifo.rs:1005);
// - the "Insufficient funds" lines of the orders that check funds (new_order.rs:745, :760);
// - each SPL Token transfer's Instruction (token_utils.rs).
//
// Not counted: the messages a failing check or a panic formats (assert_with_msg's `msg!`, a Borsh error's String, the
// panic handler's line). They are only built when the instruction fails anyway, so the count stays exact up to the
// failure; but when the heap has less room than such a message needs, Phoenix runs out of memory where the port reports
// the failure (see docs/case-study-phoenix.md). Nor is what the instructions with nothing to grow allocate past their
// batches (InitializeMarket, CollectFees' line, the seat and governance instructions; their counts are not kept
// exact): with at most 128 distinct accounts, the most a transaction locks, it stays far below the heap.
import { type FixedVec, type Inout, type RemainingAccount, type RemainingAccounts, type u32, abort, fixedVec, log, readData, u8, u64 } from "typesol";
import { type Recorder } from "./recorder.js";

/** The heap's bytes the allocations can use: 32 KiB less the allocator's position word. */
export const HEAP_ROOM = 32760n;
/** The most the entrypoint takes per account entry: 48 for the AccountInfo, 72 for the Rcs of a distinct account. */
export const MAX_PER_ACCOUNT = 120n;
/** What every instruction has allocated before its own work (see the file's notes): 42 + 84 + 1280 + 67 + 34. */
export const PREFIX = 1507n;
/** The status checks' messages (format! of the message, 2 × its literal text). */
export const REDUCE_ALLOWED_MESSAGE = 92n; // "Reduce order is not allowed, market status is "
export const CROSS_ALLOWED_MESSAGE = 106n; // "FOK and IOC orders are not allowed, market status is "
export const POST_ALLOWED_MESSAGE = 98n; // "Post only order is not allowed, market status is "
/** The seat's discriminant line, as the market's (42, then 84). */
export const SEAT_DISCRIMINANT_LINE = 126n;
/** "Sending batch {} with header and {} market events, total events sent: {}" (2 × 66; the numbers always fit). */
export const BATCH_LINE = 132n;
/** "Insufficient funds to place order: {} base lots available, {} base lots required" (2 × 76), and the quote form (2 × 78). */
export const BASE_FUNDS_LINE = 152n;
export const QUOTE_FUNDS_LINE = 156n;
/**
 * spl_token::instruction::transfer (spl-token 3.5.0), built for each token CPI Phoenix makes (token_utils.rs:67, :94):
 * its data, `Vec::with_capacity(size_of::<TokenInstruction>())` (80 bytes: InitializeMint's COption<Pubkey>, Pubkey and
 * u8 after the tag, aligned to the &str of UiAmountToAmount), and its three AccountMetas (102).
 */
export const TOKEN_TRANSFER = 182n;
/** sokoban's boxed RedBlackTreeIterator (red_black_tree.rs:180). */
export const TREE_ITERATOR = 88n;
/** The most an iterator's stack can take: 16 + 32 + 64 + 128 bytes (a tree of 4096 nodes is at most 24 deep). */
export const MAX_ITERATOR_STACK = 240n;

/** The allocator's out-of-memory abort (alloc::alloc::handle_alloc_error under solana-program's handler). */
export function outOfMemory(): void {
  log("Error: memory allocation failed, out of memory");
  abort();
}

/** The accounts the entrypoint gave Rcs to: the entries that are not duplicates of an earlier one. */
function distinctAccounts(rest: RemainingAccounts): u64 {
  const firsts: FixedVec<u8, 255> = fixedVec([]);
  for (let i = 0n; i < rest.length; i++) {
    const key = rest.get(i).key;
    let seen = false;
    for (const j of firsts) {
      if (rest.get(j).key === key) {
        seen = true;
        break;
      }
    }
    if (!seen) firsts.push(u8(i));
  }
  return firsts.length;
}

/** The room the entrypoint left, which becomes the limit: 32,760 bytes less 48 an entry and 72 a distinct account. */
/** @noinline */
function exactRoom(rec: Inout<Recorder>, rest: RemainingAccounts): u64 {
  rec.limit = HEAP_ROOM - 48n * rest.length - 72n * distinctAccounts(rest);
  return rec.limit;
}

/**
 * The count past its limit: out of memory unless the exact room still holds it. The frequent charges (a batch's line,
 * a token transfer) are written where they happen as `rec.heap += …; if (rec.heap > rec.limit) overLimit(rec, rest);`,
 * alloc's own two lines without its call.
 */
/** @noinline */
export function overLimit(rec: Inout<Recorder>, rest: RemainingAccounts): void {
  if (rec.heap > exactRoom(rec, rest)) outOfMemory();
}

/**
 * Whether `extra` more bytes would fit after what is counted. An allocation followed by nothing Phoenix logs or sends
 * before the next checked one needs no check of its own (the next check counts it, and the outcome is the same).
 */
export function fits(rec: Inout<Recorder>, rest: RemainingAccounts, extra: u64): boolean {
  return rec.heap + extra <= rec.limit || rec.heap + extra <= exactRoom(rec, rest);
}

/** An allocation of `size` bytes, alignment 1 (a String, a Vec<u8>). */
export function alloc(rec: Inout<Recorder>, rest: RemainingAccounts, size: u64): void {
  rec.heap += size;
  if (rec.heap > rec.limit) overLimit(rec, rest);
}

/** An allocation of `size` bytes, alignment 8 (`pos = (pos - size) & !7`; the count starts 8-aligned). */
export function alloc8(rec: Inout<Recorder>, rest: RemainingAccounts, size: u64): void {
  rec.heap = (rec.heap + size + 7n) & 0xfffffffffffffff8n;
  if (rec.heap > rec.limit) overLimit(rec, rest);
}

/**
 * What a Vec of `elem`-byte elements (alignment 8) allocates as `len` elements are pushed one by one from empty:
 * RawVec's first capacity is 4 and it doubles (`max(2 × cap, len + 1)`), each growth a new allocation.
 */
export function grownBytes(len: u64, elem: u64): u64 {
  if (len === 0n) return 0n;
  let cap = 4n;
  let bytes = 4n * elem;
  while (cap < len) {
    cap *= 2n;
    bytes += cap * elem;
  }
  return bytes;
}

/** The bytes an iterator's stack (Vec<u32>: 16, then 32, 64, … bytes) takes to hold `depth` nodes at once. */
function stackBytes(depth: u64): u64 {
  if (depth === 0n) return 0n;
  let cap = 4n;
  let bytes = 16n;
  while (cap < depth) {
    cap *= 2n;
    bytes += 4n * cap;
  }
  return bytes;
}

/**
 * The bytes sokoban's iterator stack takes in an in-order walk of the tree at `offset` (nodes of `stride` bytes) from
 * its smallest key up to node `stop` included (0: the whole tree): RedBlackTreeIterator::next (red_black_tree.rs:793)
 * pushes each node on the way down its left children and pops it when it is yielded. Read from the registers (left at
 * +0, right at +4 of each node), as the walk was: the caller asks before it changes the tree.
 */
export function walkStackBytes(market: RemainingAccount, offset: u64, stride: u64, stop: u32): u64 {
  const stack: FixedVec<u32, 64> = fixedVec([]);
  let ptr = readData<u32>(market, offset);
  let depth = 0n;
  while (stack.length > 0n || ptr !== 0n) {
    if (ptr !== 0n) {
      stack.push(ptr);
      if (stack.length > depth) depth = stack.length;
      ptr = readData<u32>(market, offset + 32n + (u64(ptr) - 1n) * stride);
    } else {
      const node = stack.pop();
      if (node === stop) break;
      ptr = readData<u32>(market, offset + 36n + (u64(node) - 1n) * stride);
    }
  }
  return stackBytes(depth);
}

/** The merge sort's `is_less` on prices: bids sort by price descending, asks ascending (new_order.rs:572). */
function less(prices: Inout<FixedVec<u64, 170>>, a: u64, b: u64, descending: boolean): boolean {
  return descending ? prices.get(a) > prices.get(b) : prices.get(a) < prices.get(b);
}

/**
 * The heap the standard library's stable sort takes for `n` elements of 8 bytes (references) with these prices in this
 * order (alloc/src/slice.rs merge_sort, as Phoenix's toolchain has it): nothing up to 20 elements (insertion sort);
 * above, a buffer of n / 2 elements and the stack of runs (16 bytes each, a Vec grown 4, 8, …), whose depth is that of
 * the natural runs found from the end (extended to 10 elements) and merged while TimSort's invariants fail.
 * @noinline
 */
export function sortBytes(prices: Inout<FixedVec<u64, 170>>, n: u64, descending: boolean): u64 {
  if (n <= 20n) return 0n;
  const runs: FixedVec<u64, 64> = fixedVec([]);
  let depth = 0n;
  let end = n;
  while (end > 0n) {
    let start = end - 1n;
    if (start > 0n) {
      start -= 1n;
      if (less(prices, start + 1n, start, descending)) {
        while (start > 0n && less(prices, start, start - 1n, descending)) start -= 1n;
      } else {
        while (start > 0n && !less(prices, start, start - 1n, descending)) start -= 1n;
      }
    }
    // Short runs are extended to MIN_RUN (10) by insertion.
    while (start > 0n && end - start < 10n) start -= 1n;
    // A run's length (its start is the sum of the lengths below it: kept implicit).
    runs.push(end - start);
    if (runs.length > depth) depth = runs.length;
    end = start;
    // collapse(): merge while the invariants fail (`start == 0` is the last run).
    for (;;) {
      const k = runs.length;
      if (k < 2n) break;
      const top = runs.get(k - 1n);
      const merge =
        end === 0n ||
        runs.get(k - 2n) <= top ||
        (k >= 3n && runs.get(k - 3n) <= runs.get(k - 2n) + top) ||
        (k >= 4n && runs.get(k - 4n) <= runs.get(k - 3n) + runs.get(k - 2n));
      if (!merge) break;
      const r = k >= 3n && runs.get(k - 3n) < top ? k - 3n : k - 2n;
      runs.set(r, runs.get(r) + runs.get(r + 1n));
      for (let i = r + 1n; i + 1n < k; i++) runs.set(i, runs.get(i + 1n));
      runs.pop();
    }
  }
  return 8n * (n / 2n) + grownBytes(depth, 16n);
}
