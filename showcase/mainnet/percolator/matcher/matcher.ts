// A port of the Percolator matcher (aeyakovenko/percolator-match 199b139, src/lib.rs and src/vamm.rs: the program
// TradeCpi calls), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// A test fixture, not a port matched to a binary: no build of this matcher is deployed for Percolator v12.20 (the
// author's deploy manifest says "NOT DEPLOYED — third parties provision their own"), so the TradeCpi tests run this
// TypeSOL matcher under both the original and the port. 199b139 is the matcher ABI v2 the v12.20 program speaks (the
// 67-byte request, the 64-byte answer at the start of the context account), the last commit before the deploy.
//
// Two instructions: the call (tag 0, from TradeCpi, signed by the LP PDA) and Init (tag 2, the context's parameters).
// One context layout for both kinds: Passive (kind 0, a fixed spread around the oracle) and vAMM (kind 1, the spread
// plus an impact that grows with the fill's notional against a liquidity depth). The answer is written at byte 0, the
// MatcherCtx (256 bytes) at byte 64.
import { type FixedArray, type InstructionBytes, type Pubkey, type RemainingAccounts, type u8, ProgramError, i128, instructionData, loadRawMutAt, programId, pubkey, readData, remainingAccounts, require, u32, u64, u128 } from "typesol";

const MATCHER_ABI_VERSION = 2n;
const MATCHER_CONTEXT_LEN = 320n;
const MATCHER_CALL_LEN = 67n;
const INIT_CTX_LEN = 66n;
const CTX_OFF = 64n;
const MATCHER_MAGIC = 0x504552434d415443n;
const MATCHER_VERSION = 3n;
const FLAG_VALID = 1n;
const FLAG_PARTIAL_OK = 2n;
const KIND_PASSIVE = 0n;
const KIND_VAMM = 1n;
const ZERO_KEY = pubkey("11111111111111111111111111111111");
const I128_MAX = 170141183460469231731687303715884105727n;
const I128_MIN = -170141183460469231731687303715884105728n;

/** MatcherReturn (64 bytes at byte 0). */
export interface MatcherReturn {
  abi_version: u32;
  flags: u32;
  exec_price_e6: u64;
  exec_size: i128;
  req_id: u64;
  lp_account_id: u64;
  oracle_price_e6: u64;
  reserved: u64;
}

/** MatcherCtx (256 bytes at byte 64). */
export interface MatcherCtx {
  magic: u64;
  version: u32;
  kind: u8;
  pad0: FixedArray<u8, 3>;
  lp_pda: Pubkey;
  trading_fee_bps: u32;
  base_spread_bps: u32;
  max_total_bps: u32;
  impact_k_bps: u32;
  liquidity_notional_e6: u128;
  max_fill_abs: u128;
  inventory_base: i128;
  last_oracle_price_e6: u64;
  last_exec_price_e6: u64;
  max_inventory_abs: u128;
  reserved: FixedArray<u8, 112>;
}

/** The context account's first 320 bytes: the answer, then the MatcherCtx. */
export interface MatcherAccount {
  ret: MatcherReturn;
  ctx: MatcherCtx;
}

/** |v| of an i128 as u128. */
function absI128(v: i128): u128 {
  if (v >= 0n) return u128(v);
  if (v === I128_MIN) return 170141183460469231731687303715884105728n;
  return u128(-v);
}

/** `x as i128` of a u128 (its bits). */
function asI128(x: u128): i128 {
  if (x <= I128_MAX) return i128(x);
  return -i128(340282366920938463463374607431768211455n - x) - 1n;
}

function satAddI128(a: i128, b: i128): i128 {
  if (b > 0n && a > I128_MAX - b) return I128_MAX;
  if (b < 0n && a < I128_MIN - b) return I128_MIN;
  return a + b;
}

/** MatcherCtx::validate: the kind, the vAMM depth, the bps bounds, the LP PDA set. */
function validate(c: MatcherCtx): void {
  require(c.kind <= KIND_VAMM, ProgramError.InvalidInstructionData);
  require(!(c.kind === KIND_VAMM && c.liquidity_notional_e6 === 0n), ProgramError.InvalidAccountData);
  require(c.max_total_bps <= 9000n, ProgramError.InvalidAccountData);
  require(c.trading_fee_bps <= 1000n, ProgramError.InvalidAccountData);
  const fixed = u64(c.base_spread_bps) + u64(c.trading_fee_bps);
  const totalFixed = fixed > 0xffffffffn ? 0xffffffffn : fixed;
  require(totalFixed <= u64(c.max_total_bps), ProgramError.InvalidAccountData);
  require(c.lp_pda !== ZERO_KEY, ProgramError.InvalidAccountData);
}

/** check_inventory_limit: the fill cut so that |inventory| stays within max_inventory_abs (0: no limit). */
function inventoryLimit(c: MatcherCtx, fill: u128, isBuy: boolean): u128 {
  if (c.max_inventory_abs === 0n) return fill;
  const current = c.inventory_base;
  const maxInv = asI128(c.max_inventory_abs);
  const f = asI128(fill);
  const newInv = satAddI128(current, isBuy ? -f : f);
  if (absI128(newInv) <= c.max_inventory_abs) return fill;
  if (isBuy) {
    if (current <= -maxInv) return 0n;
    const maxFill = absI128(current + maxInv);
    return fill < maxFill ? fill : maxFill;
  }
  if (current >= maxInv) return 0n;
  const maxFill = absI128(maxInv - current);
  return fill < maxFill ? fill : maxFill;
}

/** process_matcher_call and vamm::process_call. */
function call(rest: RemainingAccounts, data: InstructionBytes, id: Pubkey): void {
  require(rest.length >= 2n, ProgramError.NotEnoughAccountKeys);
  const lpPda = rest.get(0n);
  const ctx = rest.get(1n);
  require(ctx.owner === id, ProgramError.IncorrectProgramId);
  require(ctx.dataLen >= MATCHER_CONTEXT_LEN, ProgramError.AccountDataTooSmall);
  require(readData<u64>(ctx, CTX_OFF) === MATCHER_MAGIC, ProgramError.UninitializedAccount);
  require(lpPda.isSigner, ProgramError.MissingRequiredSignature);
  // MatcherCall::parse.
  require(data.length >= MATCHER_CALL_LEN, ProgramError.InvalidInstructionData);
  const reqId = data.readU64(1n);
  const lpAccountId = data.readU64(11n);
  const oracle = data.readU64(19n);
  const reqSize = asI128(data.readU128(27n));
  for (let i = 43n; i < 67n; i++) require(data.readU8(i) === 0n, ProgramError.InvalidInstructionData);
  require(oracle !== 0n, ProgramError.InvalidInstructionData);
  require(reqSize !== I128_MIN, ProgramError.InvalidInstructionData);
  const acct = loadRawMutAt<MatcherAccount>(ctx, 0n);
  // MatcherCtx::read_from: a copy (its _pad0 read as zeros), written back whole after the fill.
  const c: MatcherCtx = acct.ctx;
  for (let i = 0n; i < 3n; i++) c.pad0.set(i, 0n);
  validate(c);
  require(lpPda.key === c.lp_pda, ProgramError.InvalidAccountData);

  // compute_passive_execution / compute_vamm_execution.
  const reqAbs = absI128(reqSize);
  const isBuy = reqSize > 0n;
  let fill: u128 = 0n;
  if (c.max_fill_abs !== 0n) fill = reqAbs < c.max_fill_abs ? reqAbs : c.max_fill_abs;
  fill = inventoryLimit(c, fill, isBuy);
  let flags = FLAG_VALID;
  let execPrice = oracle;
  let execSize: i128 = 0n;
  if (fill === 0n) flags = FLAG_VALID | FLAG_PARTIAL_OK;
  else {
    execSize = isBuy ? i128(fill) : -i128(fill);
    const base = u128(c.base_spread_bps);
    const fee = u128(c.trading_fee_bps);
    const maxTotal = u128(c.max_total_bps);
    let extra: u128 = 0n;
    if (c.kind === KIND_VAMM) {
      require(fill <= 340282366920938463463374607431768211455n / u128(oracle), ProgramError.ArithmeticOverflow);
      const absNotional = (fill * u128(oracle)) / 1000000n;
      let impact: u128 = 0n;
      if (c.liquidity_notional_e6 > 0n) {
        const k = u128(c.impact_k_bps);
        require(k === 0n || absNotional <= 340282366920938463463374607431768211455n / k, ProgramError.ArithmeticOverflow);
        impact = (absNotional * k) / c.liquidity_notional_e6;
      }
      const room = maxTotal > base ? maxTotal - base : 0n;
      const maxImpact = room > fee ? room - fee : 0n;
      extra = impact < maxImpact ? impact : maxImpact;
    }
    const sum = base + fee + extra;
    const total = maxTotal < sum ? maxTotal : sum;
    const p = isBuy ? (u128(oracle) * (10000n + total)) / 10000n : (u128(oracle) * (10000n - total)) / 10000n;
    require(p !== 0n && p <= 0xffffffffffffffffn, ProgramError.ArithmeticOverflow);
    execPrice = u64(p);
  }
  if (execSize !== 0n) {
    // inventory_base.saturating_sub(exec_size).
    c.inventory_base = execSize === I128_MIN ? satAddI128(c.inventory_base, I128_MAX) : satAddI128(c.inventory_base, -execSize);
    c.last_oracle_price_e6 = oracle;
    c.last_exec_price_e6 = execPrice;
  }
  acct.ctx = c;
  const r: MatcherReturn = {
    abi_version: u32(MATCHER_ABI_VERSION),
    flags: u32(flags),
    exec_price_e6: execPrice,
    exec_size: execSize,
    req_id: reqId,
    lp_account_id: lpAccountId,
    oracle_price_e6: oracle,
    reserved: 0n,
  };
  acct.ret = r;
}

/** vamm::process_init. */
function init(rest: RemainingAccounts, data: InstructionBytes, id: Pubkey): void {
  require(rest.length >= 2n, ProgramError.NotEnoughAccountKeys);
  const lpPda = rest.get(0n);
  const ctx = rest.get(1n);
  require(ctx.owner === id, ProgramError.IncorrectProgramId);
  require(ctx.dataLen >= MATCHER_CONTEXT_LEN, ProgramError.AccountDataTooSmall);
  require(ctx.isWritable, ProgramError.InvalidAccountData);
  require(data.length >= INIT_CTX_LEN, ProgramError.InvalidInstructionData);
  const kind = data.readU8(1n);
  require(kind <= KIND_VAMM, ProgramError.InvalidInstructionData);
  require(readData<u64>(ctx, CTX_OFF) !== MATCHER_MAGIC, ProgramError.AccountAlreadyInitialized);
  const acct = loadRawMutAt<MatcherAccount>(ctx, 0n);
  const c: MatcherCtx = acct.ctx;
  c.magic = MATCHER_MAGIC;
  c.version = u32(MATCHER_VERSION);
  c.kind = kind;
  for (let i = 0n; i < 3n; i++) c.pad0.set(i, 0n);
  c.lp_pda = lpPda.key;
  c.trading_fee_bps = data.readU32(2n);
  c.base_spread_bps = data.readU32(6n);
  c.max_total_bps = data.readU32(10n);
  c.impact_k_bps = data.readU32(14n);
  c.liquidity_notional_e6 = data.readU128(18n);
  c.max_fill_abs = data.readU128(34n);
  c.inventory_base = 0n;
  c.last_oracle_price_e6 = 0n;
  c.last_exec_price_e6 = 0n;
  c.max_inventory_abs = data.readU128(50n);
  for (let i = 0n; i < 112n; i++) c.reserved.set(i, 0n);
  validate(c);
  acct.ctx = c;
}

/** @fallback */
export function process(): void {
  const data = instructionData();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  if (tag === 0n) call(remainingAccounts(), data, programId());
  else if (tag === 2n) init(remainingAccounts(), data, programId());
  else require(false, ProgramError.InvalidInstructionData);
}
