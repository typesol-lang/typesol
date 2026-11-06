// Marginfi's rebalance execution helpers (programs/marginfi/src/instructions/marginfi_account/rebalance.rs,
// state/rate.rs and state/rebalance.rs @ c5d440f6): the referenced banks read from the remaining accounts, their
// supply rates (a native bank's curve, or a Kamino, Drift or JupLend venue's: venue_rates.ts), venue multipliers,
// deposit room and token amounts, and the record's checks. Solend banks take no part (a rebalance refuses them).
import {
  type Account,
  type FixedArray,
  type Mut,
  type Pubkey,
  type RemainingAccounts,
  type i128,
  type i64,
  type u8,
  findProgramAddress,
  fixedArray,
  loadAccount,
  pubkey,
  loadAccountMut,
  require,
  u64,
} from "typesol";
import { accrueInterest, balanceDecimals, depositLimitFx, updateBankCache } from "./bank";
import { MarginfiError } from "./errors";
import { I80F48_ONE, I80F48_ZERO, exp10Fx, fxAdd, fxDiv, fxFromU64, fxMul, fxSub, fxTryMul } from "./i80f48";
import { multipointCurve } from "./interest_rate";
import { WRONG_NUMBER_OF_ORACLE_ACCOUNTS } from "./oracle";
import { accountsPerBank, cacheOfFeed, calcValue, feedAt, loaderErr } from "./risk";
import { driftRemaining, driftSupplyApr, juplendSupplyApr, kaminoRemaining, kaminoSupplyApr } from "./venue_rates";
import { type Bank, type MarginfiAccount, type MarginfiGroup } from "./state";

const REB_U64_MAX: u64 = 18446744073709551615n;
/** I80F48::MAX: a bank without a deposit limit has room for anything. */
export const FX_MAX: i128 = 170141183460469231731687303715884105727n;

/** is_integration_asset_tag: Kamino, Drift, Solend and JupLend banks. */
export function isVenueBank(tag: u8): boolean {
  return tag === 3n || tag === 4n || tag === 5n || tag === 6n;
}

/** The referenced banks as parse_rebalance_banks finds them: each bank's account index, its oracles, and the end. */
export interface ParsedBanks {
  at: FixedArray<u64, 8>;
  /** Where the bank's venue accounts start (JupLend's token reserve, then the rewards accounts) */
  extra: FixedArray<u64, 8>;
  /** Whether JupLend's rate model was taken (and checked) */
  rateModel: boolean;
  first: FixedArray<u64, 8>;
  count: FixedArray<u64, 8>;
  end: u64;
}

/**
 * parse_rebalance_banks: `n` blocks of [bank, (JupLend's token reserve), (the venue's reward accounts), oracles], each
 * bank once (SameAssetAndLiabilityBanks), a bank of this program (InvalidBankAccount) in the group.
 */
export function parseBanks(rest: RemainingAccounts, group: Pubkey, n: u64, withRewards: boolean, withRateModel: boolean): ParsedBanks {
  const p: ParsedBanks = {
    at: fixedArray<u64, 8>(0n),
    extra: fixedArray<u64, 8>(0n),
    rateModel: withRewards && withRateModel,
    first: fixedArray<u64, 8>(0n),
    count: fixedArray<u64, 8>(0n),
    end: 0n,
  };
  let cursor = 0n;
  for (let i = 0n; i < n; i++) {
    require(rest.length > cursor, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
    const key = rest.get(cursor).key;
    for (let j = 0n; j < i; j++) require(rest.get(p.at.get(j)).key !== key, MarginfiError.SameAssetAndLiabilityBanks);
    require(loaderErr(rest.get(cursor)) === 0n, MarginfiError.InvalidBankAccount);
    const bank = loadAccount<Bank>(rest.get(cursor));
    p.at.set(i, cursor);
    cursor += 1n;
    require(bank.group === group, MarginfiError.InvalidGroup);
    const per = accountsPerBank(bank);
    require(per.err === 0n, per.err);
    const oracles = per.n > 0n ? per.n - 1n : 0n;
    const tag = bank.config.asset_tag;
    p.extra.set(i, cursor);
    let extra = tag === 6n ? 1n : 0n;
    if (withRewards && tag === 3n) extra += 1n;
    if (withRewards && tag === 6n) extra += 3n;
    for (let k = 0n; k < extra; k++) {
      require(rest.length > cursor, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
      // JupLend's rate model (the last of its rewards accounts): the mint's, when it is read.
      if (withRewards && withRateModel && tag === 6n && k === 3n)
        require(rest.get(cursor).key === findProgramAddress(["rate_model", bank.mint], REB_JUPLEND_LIQUIDITY), 6501n);
      cursor += 1n;
    }
    require(rest.length >= cursor + oracles, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
    p.first.set(i, cursor);
    p.count.set(i, oracles);
    cursor += oracles;
  }
  p.end = cursor;
  return p;
}

/** accrue_native_bank: interest and the cache brought up to date (venue banks are refreshed by their venue). */
export function accrueNative(rest: RemainingAccounts, at: u64, group: Account<MarginfiGroup>, t: i64): void {
  const bank = loadAccountMut<Bank>(rest.get(at));
  if (isVenueBank(bank.config.asset_tag)) return;
  accrueInterest(bank, group, bank.key, t);
  updateBankCache(bank, group, t);
}

/**
 * venue_multiplier: the bank's exchange-rate multiplier from its oracle accounts (a venue's rate; 1 for a native bank),
 * read as the price cache reads it, so stale and wide prices refuse here too.
 */
export function venueMultiplier(bank: Account<Bank>, rest: RemainingAccounts, first: u64, count: u64, t: i64): i128 {
  const pc = cacheOfFeed(bank, feedAt(bank, rest, first, count, t, false));
  require(pc.err === 0n, pc.err);
  return pc.mult;
}

const REB_JUPLEND_LIQUIDITY = pubkey("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");

/**
 * rate_at: the bank's supply rate after `extra` more native tokens — a native bank's curve, or its venue's (the venue
 * account its last oracle account; Kamino's lending market and JupLend's token reserve and rewards accounts from the
 * venue accounts).
 */
export function rateAt(bank: Account<Bank>, rest: RemainingAccounts, p: ParsedBanks, i: u64, extra: u64, t: i64): i128 {
  const tag = bank.config.asset_tag;
  if (!isVenueBank(tag)) return supplyRate(bank, extra);
  require(p.count.get(i) > 0n, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
  const venue = rest.get(p.first.get(i) + p.count.get(i) - 1n);
  const x = p.extra.get(i);
  if (tag === 3n) {
    // Kamino's lending market is a rewards account: with none taken, WrongNumberOfOracleAccounts.
    require(p.first.get(i) > x, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
    const r = kaminoSupplyApr(bank, venue, rest.get(x), extra, t);
    require(r.err === 0n, r.err);
    return r.v;
  }
  if (tag === 4n) {
    const r = driftSupplyApr(bank, venue, extra, t);
    require(r.err === 0n, r.err);
    return r.v;
  }
  require(tag === 6n, MarginfiError.InvalidOracleSetup);
  require(p.first.get(i) > x + 1n, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
  // JupLend's rate model, when taken (start); in its place the token reserve, unread.
  const r = juplendSupplyApr(bank, venue, rest.get(x), rest.get(x + 1n), rest.get(x + 2n), p.rateModel, rest.get(p.rateModel ? x + 3n : x), extra, t);
  require(r.err === 0n, r.err);
  return r.v;
}

/**
 * NativeRateModel::rate_at: the lending rate after `extra` more native tokens are deposited (the curve's base rate at
 * that utilization, times it); 0 with no deposits or no borrows. Venue banks are not ported.
 */
export function supplyRate(bank: Account<Bank>, extra: u64): i128 {
  require(!isVenueBank(bank.config.asset_tag), MarginfiError.RebalanceVenueUnsupported);
  require(bank.config.interest_rate_config.curve_type === 1n, MarginfiError.InvalidConfig);
  const assets = fxAdd(fxMul(bank.total_asset_shares.value, bank.asset_share_value.value), fxFromU64(extra));
  const liabilities = fxMul(bank.total_liability_shares.value, bank.liability_share_value.value);
  if (assets === I80F48_ZERO || liabilities === I80F48_ZERO) return I80F48_ZERO;
  const utilization = fxDiv(liabilities, assets);
  return fxMul(multipointCurve(bank.config.interest_rate_config, utilization), utilization);
}

/** NativeRateModel::new's checks (the curve, the totals) without pricing anything. */
export function checkRateModel(bank: Account<Bank>): void {
  require(bank.config.interest_rate_config.curve_type === 1n, MarginfiError.InvalidConfig);
  fxMul(bank.total_asset_shares.value, bank.asset_share_value.value);
  fxMul(bank.total_liability_shares.value, bank.liability_share_value.value);
}

/** underlying_of a native amount: whole tokens (calc_value at a price of 1). */
export function whole(amount: i128, decimals: u8): i128 {
  if (amount === I80F48_ZERO) return I80F48_ZERO;
  return fxDiv(amount, exp10Fx(u64(decimals)));
}

/** to_native: whole tokens as native units, truncated (MathError when negative or past u64). */
export function toNative(decimals: u8, amount: i128): u64 {
  const v = fxMul(amount, exp10Fx(u64(decimals)));
  require(v >= I80F48_ZERO, MarginfiError.MathError);
  const n = v >> 48n;
  require(n <= 18446744073709551615n, MarginfiError.MathError);
  return u64(n);
}

/** underlying_of: native (bank accounting) units × the venue multiplier, in whole tokens (calc_value). */
export function underlyingOf(amount: i128, bank: Account<Bank>, multiplier: i128): i128 {
  const v = calcValue(amount, multiplier, balanceDecimals(bank), I80F48_ZERO, false);
  require(v.err === 0n, v.err);
  return v.v;
}

/** bank_underlying: the account's deposit in the bank, in whole tokens (0 without a balance there). */
export function underlying(account: Account<MarginfiAccount>, key: Pubkey, bank: Account<Bank>, multiplier: i128): i128 {
  for (let i = 0n; i < 16n; i++) {
    const b = account.lending_account.balances.get(i);
    if (b.active !== 0n && b.bank_pk === key) return underlyingOf(fxMul(b.asset_shares.value, bank.asset_share_value.value), bank, multiplier);
  }
  return I80F48_ZERO;
}

/** The order tag of the account's balance in the bank (0 without one). */
export function tagIn(account: Account<MarginfiAccount>, key: Pubkey): u64 {
  for (let i = 0n; i < 16n; i++) {
    const b = account.lending_account.balances.get(i);
    if (b.active !== 0n && b.bank_pk === key) return u64(b.tag);
  }
  return 0n;
}

/** Whether the account holds an active balance in the bank (LendingAccount::get_balance). */
export function holds(account: Account<MarginfiAccount>, key: Pubkey): boolean {
  for (let i = 0n; i < 16n; i++) {
    const b = account.lending_account.balances.get(i);
    if (b.active !== 0n && b.bank_pk === key) return true;
  }
  return false;
}

/**
 * deposit_capacity_of: what a rebalance may still deliver into the bank, in whole tokens — the tighter of the deposit
 * limit's room (in the bank's units, through the multiplier) and the venue's (in the mint's).
 */
export function depositRoom(bank: Account<Bank>, multiplier: i128, rest: RemainingAccounts, p: ParsedBanks, i: u64, t: i64): i128 {
  let own: i128 = FX_MAX;
  if (bank.config.deposit_limit !== REB_U64_MAX) {
    // get_remaining_deposit_capacity
    const current = fxMul(bank.total_asset_shares.value, bank.asset_share_value.value);
    const limit = depositLimitFx(bank);
    let native: u64 = 0n;
    if (current < limit) {
      // (limit − current − 1).floor() as u64: MathError when negative or past u64.
      const room = fxSub(fxSub(limit, current), I80F48_ONE);
      const floor = room >> 48n;
      require(floor >= 0n && floor <= 18446744073709551615n, MarginfiError.MathError);
      native = u64(floor);
    }
    if (native !== REB_U64_MAX) own = underlyingOf(fxFromU64(native), bank, multiplier);
  }
  const tag = bank.config.asset_tag;
  let venue: i128 = FX_MAX;
  if (isVenueBank(tag)) {
    require(p.count.get(i) > 0n, WRONG_NUMBER_OF_ORACLE_ACCOUNTS);
    const a = rest.get(p.first.get(i) + p.count.get(i) - 1n);
    let cap: i128 = -1n;
    if (tag === 3n) {
      const r = kaminoRemaining(bank, a);
      require(r.err === 0n, r.err);
      cap = r.v;
    } else if (tag === 4n) {
      const r = driftRemaining(bank, a, t);
      require(r.err === 0n, r.err);
      cap = r.v;
    } else require(tag === 6n, MarginfiError.InvalidOracleSetup);
    if (cap >= 0n && cap !== 18446744073709551615n) {
      const v = calcValue(fxFromU64(u64(cap)), I80F48_ONE, bank.mint_decimals, I80F48_ZERO, false);
      require(v.err === 0n, v.err);
      venue = v.v;
    }
  }
  return own < venue ? own : venue;
}

/** yield_index_of: the bank's asset share value times its venue multiplier (MathError past I80F48). */
export function yieldIndex(bank: Account<Bank>, multiplier: i128): i128 {
  const v = fxTryMul(bank.asset_share_value.value, multiplier);
  require(v.err === 0n, MarginfiError.MathError);
  return v.v;
}
