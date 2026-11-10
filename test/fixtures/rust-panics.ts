// Rust panics as a program built with solana-program 1.14 leaves them (Phoenix v1): `panicked at '<msg>', <file>:<line>:<col>`
// logged, then the abort syscall ("SBF program panicked"). The cases mirror the Phoenix binary's own panics, which the
// test compares line for line: the entrypoint's split_at with too few accounts, and the overflow and remainder checks
// of InitializeMarket (raw u64 arithmetic in initialize.rs, the wrapper types' operators in quantities.rs).
import { ProgramError, i64, instructionData, log, panic, panicsAt, remainingAccounts, require, u64 } from "typesol";

export const PANIC_STYLE = "solana-1.14";
export const PANIC_ON_OVERFLOW = true;

/** QuoteLots + QuoteLots: the location is the operator's macro invocation, wherever the addition is written. */
const QUOTE_LOTS_ADD = "src/quantities.rs:233:1";

function addQuoteLots(a: u64, b: u64): u64 {
  return panicsAt(QUOTE_LOTS_ADD, a + b);
}

function pow10(decimals: u64): u64 {
  let v = 1n;
  for (let i = 0n; i < decimals; i++) v = v * 10n;
  return v;
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  // `let (program_accounts, accounts) = accounts.split_at(4);`
  if (tag === 0n) {
    if (remainingAccounts().length < 4n) panic("assertion failed: mid <= self.len()", "src/lib.rs:127:49");
    return;
  }
  // `10u64.pow(base_mint.decimals as u32) * raw_base_units_per_base_unit.unwrap_or(1) as u64`
  if (tag === 1n) {
    const atoms = panicsAt("src/program/processor/initialize.rs:109:9", pow10(u64(data.readU8(1n))) * u64(data.readU32(2n)));
    log(`${atoms}`);
    return;
  }
  // `base_atoms_per_base_unit % num_base_lots_per_base_unit` (BaseAtomsPerBaseUnit % BaseLotsPerBaseUnit)
  if (tag === 2n) {
    log(`${panicsAt("src/quantities.rs:296:1", data.readU64(1n) % data.readU64(9n))}`);
    return;
  }
  // `quote_atoms_per_quote_unit % num_quote_lots_per_quote_unit`
  if (tag === 3n) {
    log(`${panicsAt("src/quantities.rs:297:1", data.readU64(1n) % data.readU64(9n))}`);
    return;
  }
  // `quote_lot_size * tick_size_in_quote_lots_per_base_unit`
  if (tag === 4n) {
    log(`${panicsAt("src/quantities.rs:280:1", data.readU64(1n) * data.readU64(9n))}`);
    return;
  }
  // A compound assignment, and the same operator through a helper.
  if (tag === 5n) {
    let total = data.readU64(1n);
    panicsAt(QUOTE_LOTS_ADD, (total += data.readU64(9n)));
    log(`${total}`);
    return;
  }
  if (tag === 6n) {
    log(`${addQuoteLots(data.readU64(1n), data.readU64(9n))}`);
    return;
  }
  const a = data.readU64(1n);
  const b = data.readU64(9n);
  if (tag === 7n) log(`${panicsAt("src/a.rs:1:2", a - b)}`);
  if (tag === 8n) log(`${panicsAt("src/a.rs:3:4", a / b)}`);
  // i64::MIN (when a is 1) negated, and divided by -1.
  if (tag === 9n) log(`${panicsAt("src/a.rs:5:6", -(i64(-9223372036854775807n) - i64(a)))}`);
  if (tag === 10n) log(`${panicsAt("src/a.rs:7:8", (i64(-9223372036854775807n) - i64(a)) / (i64(0n) - i64(b)))}`);
  if (tag === 11n) log(`${panicsAt("src/a.rs:9:10", a << b)}`);
  // Nested: each operator panics at the innermost location around it.
  if (tag === 12n) log(`${panicsAt("src/outer.rs:1:1", a + panicsAt("src/inner.rs:2:2", b * b))}`);
  // Outside panicsAt, PANIC_ON_OVERFLOW: TypeSOL's line, then the abort.
  if (tag === 13n) log(`${a + b}`);
  // No location: this source line and column.
  if (tag === 14n) panic("explicit");
  if (tag === 15n) log(`${panicsAt("src/a.rs:11:12", a % b)}`);
}
