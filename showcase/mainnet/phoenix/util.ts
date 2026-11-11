// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// What more than one instruction uses: the program's addresses, the PDAs (loaders.rs), the quantity arithmetic of
// quantities.rs with its overflow panics, the decimal formatting of token_utils.rs, and the CPIs Phoenix makes
// (system_utils.rs's create_account, token_utils.rs's deposits and withdrawals, signed by the vault PDA).
//
// Phoenix is built with overflow checks and solana-program 1.14: an overflow panics with Rust's message at the
// location of the expression, and a newtype's operator (QuoteLots + QuoteLots) at its `impl`, which is the macro
// invocation in quantities.rs. Each of those operators is a helper here, its location its macro line.
import {
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type SystemProgram,
  type i8,
  type i64,
  type u8,
  type u32,
  ProgramError,
  abort,
  fixedArray,
  log,
  panicsAt,
  programAt,
  pubkey,
  rentExempt,
  require,
  u64,
} from "typesol";
import { type FIFOOrderId, type TraderState } from "./state.js";

/** crate::ID (declare_id!). The port runs at the same address, so programId() is the same key. */
export const PHOENIX_ID = pubkey("PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY");
/** phoenix_log_authority::id(): the PDA ["log"], fixed at compile time as declare_pda! fixes it. */
export const LOG_AUTHORITY_ID = pubkey("7aDTsspkQNGKmrexAN7FLx9oxU3iPczSSvHNggyuqYkR");
/** phoenix_log_authority::bump(). */
export const LOG_AUTHORITY_BUMP: u8 = 255n;
export const SYSTEM_PROGRAM_ID = pubkey("11111111111111111111111111111111");
export const TOKEN_PROGRAM_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export const U64_MAX = 18446744073709551615n;

// ---- Accounts by position ---------------------------------------------------------------------------------------

/** `next_account_info` past the end: NotEnoughAccountKeys, nothing logged. */
export function need(rest: RemainingAccounts, n: u64): void {
  require(rest.length >= n, ProgramError.NotEnoughAccountKeys);
}

/**
 * A Rust slice index past the end (`&data[..end]`), as Phoenix's toolchain reports it: core's own location, not the
 * caller's (rustc before 1.71 did not track the caller of slice indexing).
 */
export function sliceEndPanic(end: u64, len: u64): void {
  log(`panicked at 'range end index ${end} out of range for slice of length ${len}', library/core/src/slice/index.rs:73:5`);
  abort();
}

// ---- The books' order (state/markets/fifo.rs) ------------------------------------------------------------------------

/**
 * FIFOOrderId's Ord, as sokoban calls it (`searched.cmp(node)`): the left key's side decides. A bid's sequence number
 * is stored inverted (top bit set): bids order by price descending, then sequence descending (`other.cmp(self)` on the
 * fields); asks by price ascending, then sequence ascending.
 */
export function orderCmp(a: FIFOOrderId, b: FIFOOrderId): i8 {
  if (a.order_sequence_number >> 63n === 1n) {
    if (a.price_in_ticks !== b.price_in_ticks) return b.price_in_ticks < a.price_in_ticks ? -1n : 1n;
    if (a.order_sequence_number !== b.order_sequence_number) return b.order_sequence_number < a.order_sequence_number ? -1n : 1n;
    return 0n;
  }
  if (a.price_in_ticks !== b.price_in_ticks) return a.price_in_ticks < b.price_in_ticks ? -1n : 1n;
  if (a.order_sequence_number !== b.order_sequence_number) return a.order_sequence_number < b.order_sequence_number ? -1n : 1n;
  return 0n;
}

/** TraderState::default(), the value a newly registered trader gets. */
export function emptyTraderState(): TraderState {
  return { quote_lots_locked: 0n, quote_lots_free: 0n, base_lots_locked: 0n, base_lots_free: 0n, padding: fixedArray<u64, 8>(0n) };
}

/**
 * `clock.unix_timestamp as u64` (new_order.rs:385, :551): the i64's two's-complement bits, so a negative timestamp
 * reads as a value above 2^63 (every time in force is then in the past). A checked cast would fail instead.
 */
export function timestampAsU64(t: i64): u64 {
  if (t >= 0n) return u64(t);
  return u64(t + 9223372036854775807n + 1n) + 9223372036854775808n;
}

// ---- Quantities (quantities.rs) ----------------------------------------------------------------------------------

/** QuoteLots + QuoteLots (`basic_u64!(QuoteLots)`). */
export function addQuoteLots(a: u64, b: u64): u64 {
  return panicsAt("src/quantities.rs:233:1", a + b);
}

/** QuoteLots - QuoteLots. */
export function subQuoteLots(a: u64, b: u64): u64 {
  return panicsAt("src/quantities.rs:233:1", a - b);
}

/** BaseLots + BaseLots (`basic_u64!(BaseLots)`). */
export function addBaseLots(a: u64, b: u64): u64 {
  return panicsAt("src/quantities.rs:234:1", a + b);
}

/** BaseLots - BaseLots. */
export function subBaseLots(a: u64, b: u64): u64 {
  return panicsAt("src/quantities.rs:234:1", a - b);
}

/** AdjustedQuoteLots + AdjustedQuoteLots (`basic_u64_struct!(AdjustedQuoteLots)`). */
export function addAdjusted(a: u64, b: u64): u64 {
  return panicsAt("src/quantities.rs:257:1", a + b);
}

/** AdjustedQuoteLots - AdjustedQuoteLots. */
export function subAdjusted(a: u64, b: u64): u64 {
  return panicsAt("src/quantities.rs:257:1", a - b);
}

/** QuoteLotsPerBaseUnitPerTick × Ticks = QuoteLotsPerBaseUnit, a price in quote lots per base unit. */
export function ticksToPrice(tickSize: u64, ticks: u64): u64 {
  return panicsAt("src/quantities.rs:287:1", tickSize * ticks);
}

/** QuoteLotsPerBaseUnit × BaseLots = AdjustedQuoteLots. */
export function adjustedQuoteLots(price: u64, baseLots: u64): u64 {
  return panicsAt("src/quantities.rs:293:1", price * baseLots);
}

/** QuoteLots × BaseLotsPerBaseUnit = AdjustedQuoteLots. */
export function quoteLotsToAdjusted(quoteLots: u64, baseLotsPerBaseUnit: u64): u64 {
  return panicsAt("src/quantities.rs:290:1", quoteLots * baseLotsPerBaseUnit);
}

/** `ticks × tick size × lots / base lots per base unit`: the quote lots a resting order of `lots` at `ticks` locks. */
export function quoteLotsFor(ticks: u64, tickSize: u64, lots: u64, baseLotsPerBaseUnit: u64): u64 {
  return adjustedQuoteLots(ticksToPrice(tickSize, ticks), lots) / baseLotsPerBaseUnit;
}

/** QuoteLots × QuoteAtomsPerQuoteLot = QuoteAtoms (`allow_multiply!(QuoteLots, QuoteAtomsPerQuoteLot, QuoteAtoms)`). */
export function quoteLotsToAtoms(lots: u64, quoteLotSize: u64): u64 {
  return panicsAt("src/quantities.rs:264:1", lots * quoteLotSize);
}

/** BaseLots × BaseAtomsPerBaseLot = BaseAtoms. */
export function baseLotsToAtoms(lots: u64, baseLotSize: u64): u64 {
  return panicsAt("src/quantities.rs:265:1", lots * baseLotSize);
}

/**
 * 10^n as Rust's `10u64.pow(n)` computes it. Its multiplications (square and multiply) overflow exactly when 10^n
 * does, from n = 20, and panic at core's `uint_impl!` invocation for u64, as the toolchain Phoenix was built with
 * recorded it (its build machine's path).
 */
export function pow10(n: u64): u64 {
  let v = 1n;
  for (let i = 0n; i < n; i++) v = panicsAt("/home/runner/work/bpf-tools/bpf-tools/out/rust/library/core/src/num/mod.rs:849:5", v * 10n);
  return v;
}

/**
 * token_utils.rs get_decimal_string: `{amount / 10^d}.{amount % 10^d, zero-padded to d digits, trailing zeros
 * trimmed}` ("1.5", "0.000001", and "3." when the fraction is zero, as the Rust prints it).
 */
export function decimalString(amount: u64, decimals: u32): string {
  const scale = pow10(u64(decimals));
  const whole = amount / scale;
  let frac = amount % scale;
  let width = u64(decimals);
  while (width > 0n && frac % 10n === 0n) {
    frac /= 10n;
    width--;
  }
  if (width === 0n) return `${whole}.`;
  // The digits frac has, and the zeros that pad it to `width`.
  let digits = 1n;
  for (let t = frac / 10n; t > 0n; t /= 10n) digits++;
  let out = `${whole}.`;
  for (let i = digits; i < width; i++) out += "0";
  return `${out}${frac}`;
}

// ---- CPIs ---------------------------------------------------------------------------------------------------------

/**
 * system_utils.rs create_account: a new PDA of `space` bytes owned by `owner`. An address with no lamports is created
 * with CreateAccount (rent-exempt minimum, signed by the PDA's seeds); one someone funded first is topped up to the
 * minimum (at least 1 lamport) with a Transfer from the payer, then Allocated and Assigned, signed by the seeds.
 * `seedA` / `seedB` / `seedC` are the PDA's seeds after its prefix: Phoenix's PDAs are [prefix, market, key, bump].
 */
export function createPda(
  payer: RemainingAccount,
  account: RemainingAccount,
  systemProgram: RemainingAccount,
  owner: Pubkey,
  space: u64,
  prefix: string,
  market: Pubkey,
  key: Pubkey,
  bump: u8,
): void {
  const system = programAt<SystemProgram>(systemProgram);
  const minimum = rentExempt(space);
  const current = account.lamports;
  if (current === 0n) {
    system.createAccount(payer, account, minimum, space, owner, [prefix, market, key, bump]);
    return;
  }
  const required = (minimum > 1n ? minimum : 1n) > current ? (minimum > 1n ? minimum : 1n) - current : 0n;
  if (required > 0n) system.transfer(payer, account, required);
  system.allocate(account, space, [prefix, market, key, bump]);
  system.assign(account, owner, [prefix, market, key, bump]);
}
