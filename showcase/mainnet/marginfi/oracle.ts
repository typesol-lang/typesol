// A port of marginfi v2 (mrgnlabs/marginfi-v2 @ c5d440f6), Copyright mrgnlabs, licensed under the Apache License, Version 2.0.
// Marginfi's price adapter (programs/marginfi/src/state/price.rs and lst_stake_price.rs @ c5d440f6), every oracle setup:
// a Pyth push feed (PriceUpdateV2, Borsh), a Switchboard pull feed (PullFeedAccountData, fixed offsets), a fixed price,
// a Scope entry; times a rate another program's account holds where the setup takes one — a Solend, Kamino, Drift or
// JupLend venue's exchange rate, a single pool's stake per LST (staked SOL), Marinade's mSOL rate, an SPL stake pool's
// LST rate, an Exponent PT's linear accretion to par. The deprecated PythLegacy and SwitchboardV2 panic, as there.
//
// Errors are values here (`err`, 0 when there is none), as the original's are `Result`s its risk engine sometimes keeps
// instead of returning; the instructions fail with them (`require(r.err === 0n, r.err)`). Panics abort.
import {
  type Account,
  type RemainingAccount,
  type RemainingAccounts,
  type u128,
  type u16,
  currentSlot,
  currentEpoch,
  findProgramAddress,
  rentExempt,
  type Pubkey,
  u128 as toU128,
  u256 as toU256,
  i128 as toI128,
  type i128,
  type i32,
  type i64,
  type u32,
  type u64,
  type u8,
  i64 as toI64,
  pubkey,
  readData,
  require,
  u64 as toU64,
} from "typesol";
import { ASSET_TAG_DRIFT, ASSET_TAG_JUPLEND, BANK_ASSET_TAG_STAKED, saturatingAddI64, saturatingSubI64 } from "./bank";
import { MarginfiError } from "./errors";
import {
  type Fx,
  I80F48_ONE,
  exp10Fx,
  fxAdd,
  fxFromI128Wrapping,
  fxFromI64,
  fxFromU64,
  fxMin,
  fxSub,
  fxTryAdd,
  fxTryDiv,
  fxTryMul,
  fxTrySub,
  fxWrappingDiv,
} from "./i80f48";
import { U32_MAX_FX } from "./interest_rate";
import { type Bank, OracleSetup } from "./state";

/** Bank.config.asset_tag */
export const ASSET_TAG_DEFAULT: u8 = 0n;
export const ASSET_TAG_SOL: u8 = 1n;
export const ASSET_TAG_KAMINO: u8 = 3n;
export const ASSET_TAG_SOLEND: u8 = 5n;

/** A Pyth account that does not Borsh-decode: the original fails with ProgramError::BorshIoError (not a custom code). */
export const ERR_BORSH: u32 = 1n;
export const WRONG_NUMBER_OF_ORACLE_ACCOUNTS: u32 = 6051n;
const WRONG_ORACLE_ACCOUNT_KEYS: u32 = 6052n;
const INVALID_ORACLE_SETUP: u32 = 6025n;
const ORACLE_NOT_SETUP: u32 = 6031n;

const SWITCHBOARD_PULL_ID = pubkey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
/** sha256("account:PriceUpdateV2")[..8] and PullFeedAccountData's discriminator, as little-endian u64s. */
const PRICE_UPDATE_V2_DISC: u64 = 14840625886530892066n;
const PULL_FEED_DISC: u64 = 2944183222661815236n;
/** CONF_INTERVAL_MULTIPLE (2.12) and MAX_CONF_INTERVAL (0.05). */
const CONF_INTERVAL_MULTIPLE: i128 = 596726950626591n;
const MAX_CONF_INTERVAL: i128 = 14073748835533n;
/** The default maximum Pyth confidence: u32::MAX / 10 (10%). */
const DEFAULT_MAX_CONFIDENCE: u32 = 429496729n;

/** OracleSetup as its u8 (the instruction arguments' form); 29 and up are not setups. */
export function setupOf(n: u8): OracleSetup {
  switch (n) {
    case 0n:
      return OracleSetup.None;
    case 1n:
      return OracleSetup.PythLegacy;
    case 2n:
      return OracleSetup.SwitchboardV2;
    case 3n:
      return OracleSetup.PythPushOracle;
    case 4n:
      return OracleSetup.SwitchboardPull;
    case 5n:
      return OracleSetup.StakedWithPythPush;
    case 6n:
      return OracleSetup.KaminoPythPush;
    case 7n:
      return OracleSetup.KaminoSwitchboardPull;
    case 8n:
      return OracleSetup.Fixed;
    case 9n:
      return OracleSetup.DriftPythPull;
    case 10n:
      return OracleSetup.DriftSwitchboardPull;
    case 11n:
      return OracleSetup.SolendPythPull;
    case 12n:
      return OracleSetup.SolendSwitchboardPull;
    case 13n:
      return OracleSetup.FixedKamino;
    case 14n:
      return OracleSetup.FixedDrift;
    case 15n:
      return OracleSetup.JuplendPythPull;
    case 16n:
      return OracleSetup.JuplendSwitchboardPull;
    case 17n:
      return OracleSetup.FixedJuplend;
    case 18n:
      return OracleSetup.Scope;
    case 19n:
      return OracleSetup.PythMSOL;
    case 20n:
      return OracleSetup.KaminoMSOL;
    case 21n:
      return OracleSetup.JuplendMSOL;
    case 22n:
      return OracleSetup.PythLST;
    case 23n:
      return OracleSetup.KaminoLST;
    case 24n:
      return OracleSetup.JuplendLST;
    case 25n:
      return OracleSetup.PTPyth;
    case 26n:
      return OracleSetup.PTFixed;
    case 27n:
      return OracleSetup.ScopeKamino;
    case 28n:
      return OracleSetup.ScopeJuplend;
  }
  // OracleSetup::from_u8(..).unwrap_or_else(|| panic!("unsupported oracle type")); here InternalLogicError.
  require(false, MarginfiError.InternalLogicError);
  return OracleSetup.None;
}

/**
 * OracleSetup::feed_family: the kind of feed oracle_keys[0] is (0 when it names no feed another setup could share):
 * 1 Pyth push, 2 staked Pyth push, 3 Switchboard pull, 4 mSOL, 5 LST, 6 PT on Pyth.
 */
export function feedFamily(s: OracleSetup): u8 {
  switch (s) {
    case OracleSetup.PythPushOracle:
    case OracleSetup.KaminoPythPush:
    case OracleSetup.DriftPythPull:
    case OracleSetup.SolendPythPull:
    case OracleSetup.JuplendPythPull:
      return 1n;
    case OracleSetup.StakedWithPythPush:
      return 2n;
    case OracleSetup.SwitchboardPull:
    case OracleSetup.KaminoSwitchboardPull:
    case OracleSetup.DriftSwitchboardPull:
    case OracleSetup.SolendSwitchboardPull:
    case OracleSetup.JuplendSwitchboardPull:
      return 3n;
    case OracleSetup.PythMSOL:
    case OracleSetup.KaminoMSOL:
    case OracleSetup.JuplendMSOL:
      return 4n;
    case OracleSetup.PythLST:
    case OracleSetup.KaminoLST:
    case OracleSetup.JuplendLST:
      return 5n;
    case OracleSetup.PTPyth:
      return 6n;
  }
  return 0n;
}

/** The asset tag a venue setup belongs to (its validation's first check); 255 for the setups ported here. */
function venueTag(s: OracleSetup): u8 {
  switch (s) {
    case OracleSetup.KaminoPythPush:
    case OracleSetup.KaminoSwitchboardPull:
    case OracleSetup.FixedKamino:
    case OracleSetup.ScopeKamino:
    case OracleSetup.KaminoMSOL:
    case OracleSetup.KaminoLST:
      return ASSET_TAG_KAMINO;
    case OracleSetup.DriftPythPull:
    case OracleSetup.DriftSwitchboardPull:
    case OracleSetup.FixedDrift:
      return ASSET_TAG_DRIFT;
    case OracleSetup.SolendPythPull:
    case OracleSetup.SolendSwitchboardPull:
      return ASSET_TAG_SOLEND;
    case OracleSetup.JuplendPythPull:
    case OracleSetup.JuplendSwitchboardPull:
    case OracleSetup.FixedJuplend:
    case OracleSetup.ScopeJuplend:
    case OracleSetup.JuplendMSOL:
    case OracleSetup.JuplendLST:
      return ASSET_TAG_JUPLEND;
    case OracleSetup.PythMSOL:
    case OracleSetup.PythLST:
    case OracleSetup.PTPyth:
    case OracleSetup.PTFixed:
      return ASSET_TAG_DEFAULT;
  }
  return 255n;
}

/** Whether this setup reads its feed account (oracle_keys[0]) and nothing else. */
function readsOneFeed(s: OracleSetup): boolean {
  return s === OracleSetup.PythPushOracle || s === OracleSetup.SwitchboardPull || s === OracleSetup.StakedWithPythPush;
}

// ---- validation (OraclePriceFeedAdapter::validate_bank_config, the light form configure_bank_oracle uses) ----------

/**
 * What validation decides before reading an account: the asset tag, then the number of accounts. 0 means the setup
 * reads the one account given (validateFeedAccount next).
 */
export function validateOracleCount(bank: Account<Bank>, n: u64): u32 {
  const s = bank.config.oracle_setup;
  const tag = bank.config.asset_tag;
  if (s === OracleSetup.None) return ORACLE_NOT_SETUP;
  // Both panic as deprecated in the original.
  require(s !== OracleSetup.PythLegacy && s !== OracleSetup.SwitchboardV2, MarginfiError.InternalLogicError);
  if (s === OracleSetup.PythPushOracle || s === OracleSetup.SwitchboardPull) {
    if (tag !== ASSET_TAG_DEFAULT && tag !== ASSET_TAG_SOL) return INVALID_ORACLE_SETUP;
    return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  }
  if (s === OracleSetup.StakedWithPythPush) {
    if (tag !== BANK_ASSET_TAG_STAKED) return INVALID_ORACLE_SETUP;
    return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  }
  if (s === OracleSetup.Fixed) {
    if (tag !== ASSET_TAG_DEFAULT) return INVALID_ORACLE_SETUP;
    return n === 0n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  }
  if (s === OracleSetup.Scope && tag !== ASSET_TAG_DEFAULT && tag !== ASSET_TAG_SOL) return INVALID_ORACLE_SETUP;
  if (s !== OracleSetup.Scope && tag !== venueTag(s)) return INVALID_ORACLE_SETUP;
  if (isReserveSetup(s)) return n === 2n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (isFixedVenueSetup(s)) return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.PythMSOL || s === OracleSetup.PythLST) return n === 2n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (isLstSetup(s)) return n === 3n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.PTPyth) return n === 2n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.PTFixed) return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.Scope) return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (isScopeSetup(s)) return n === 2n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  require(false, "TypeSOL port: this oracle setup's validation is not ported");
  return 0n;
}

/** Solend's setups: a Pyth or Switchboard feed, then the reserve its exchange rate comes from. */
export function isSolendSetup(s: OracleSetup): boolean {
  return s === OracleSetup.SolendPythPull || s === OracleSetup.SolendSwitchboardPull;
}

/** Kamino's feed setups (KaminoPythPush, KaminoSwitchboardPull): a feed, then the reserve. */
export function isKaminoSetup(s: OracleSetup): boolean {
  return s === OracleSetup.KaminoPythPush || s === OracleSetup.KaminoSwitchboardPull;
}

/** Drift's feed setups (DriftPythPull, DriftSwitchboardPull): a feed, then the spot market. */
export function isDriftSetup(s: OracleSetup): boolean {
  return s === OracleSetup.DriftPythPull || s === OracleSetup.DriftSwitchboardPull;
}

/** JupLend's feed setups (JuplendPythPull, JuplendSwitchboardPull): a feed, then the Lending account. */
export function isJuplendSetup(s: OracleSetup): boolean {
  return s === OracleSetup.JuplendPythPull || s === OracleSetup.JuplendSwitchboardPull;
}

// ---- staked SOL (lst_stake_price.rs: a validator's SPL single pool) ----------------------------------------------------

const SPL_TOKEN_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SINGLE_POOL_ID = pubkey("SVSPxpvHdN29nkVg9rPapPNDddN5DipNLRUFhyjFThE");
const STAKE_POOL_VALIDATION_FAILED: u32 = 6048n;
const STAKE_ORACLES_DISABLED: u32 = 6053n;
const ZERO_SUPPLY_IN_STAKE_POOL: u32 = 6092n;
/** Bank.flags: STAKED_ORACLE_DISABLED, STAKED_ORACLE_PRICE_USES_ONRAMP (on_ramp_transition) */
const BANK_STAKED_ORACLE_DISABLED: u64 = 512n;
const BANK_STAKED_ORACLE_USES_ONRAMP: u64 = 1024n;
/** SVSP_PHANTOM_TOKEN_AMOUNT: the single pool prices against its supply plus 1 SOL of tokens never minted. */
const SVSP_PHANTOM_TOKEN_AMOUNT: u64 = 1000000000n;
const ZERO_PUBKEY = pubkey("11111111111111111111111111111111");

/** The pool's SOL (the stake account's, and its on-ramp's, lamports above rent exemption) or, before the on-ramp, the legacy delegated value. */
export interface PoolValue {
  err: u32;
  nav: u64;
  supply: u64;
}

/**
 * A staked bank's feed (StakedWithPythPush): the SOL feed times the pool's SOL per LST. Accounts: the SOL feed, the LST
 * mint, the pool's stake account, its on-ramp. The cache keeps the SOL price and the rate as its multiplier.
 */
export function stakedFeed(bank: Account<Bank>, rest: RemainingAccounts, first: u64, t: i64): Feed {
  const oracle = rest.get(first);
  const mint = rest.get(first + 1n);
  const stake = rest.get(first + 2n);
  const onramp = rest.get(first + 3n);
  if (mint.key !== bank.config.oracle_keys.get(1n) || stake.key !== bank.config.oracle_keys.get(2n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  // Account::<Mint>::try_from(..).unwrap(): a token program's initialized mint, or a panic.
  require(mint.owner === SPL_TOKEN_ID && mint.dataLen >= 82n && readData<u8>(mint, 45n) !== 0n, MarginfiError.InternalLogicError);
  const supply = readData<u64>(mint, 36n);
  if (supply === 0n) return feedErr(ZERO_SUPPLY_IN_STAKE_POOL);
  const v = poolValue(bank, stake, onramp, supply);
  if (v.err !== 0n) return feedErr(v.err);
  if (oracle.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  const f = pythFeed(oracle, toI64(bank.config.oracle_max_age), t);
  if (f.err !== 0n) return f;
  const mult = fxTryDiv(fxFromU64(v.nav), fxFromU64(v.supply));
  if (mult.err !== 0n) return feedErr(VENUE_MATH_ERROR);
  const raw = priceAndConfidence(f, true, 4294967295n);
  // price × nav / supply in i128 (toward zero), back into an i64; the confidences by mul_div_u64.
  const price: i128 = (toI128(f.price) * toI128(v.nav)) / toI128(v.supply);
  const ema: i128 = (toI128(f.ema_price) * toI128(v.nav)) / toI128(v.supply);
  const conf: i128 = mulDivU128(toU128(f.conf), toU128(v.nav), toU128(v.supply));
  const emaConf: i128 = mulDivU128(toU128(f.ema_conf), toU128(v.nav), toU128(v.supply));
  const i64Min: i128 = -9223372036854775808n;
  const i64Max: i128 = 9223372036854775807n;
  const u64Max: i128 = 18446744073709551615n;
  if (price < i64Min || price > i64Max || ema < i64Min || ema > i64Max) return feedErr(VENUE_MATH_ERROR);
  if (conf < 0n || conf > u64Max || emaConf < 0n || emaConf > u64Max) return feedErr(VENUE_MATH_ERROR);
  const out = f;
  out.has_raw = 1n;
  out.raw_err = raw.err;
  out.raw_price = raw.price;
  out.raw_conf = raw.conf;
  out.mult = mult.v;
  out.price = toI64(price);
  out.ema_price = toI64(ema);
  out.conf = toU64(conf);
  out.ema_conf = toU64(emaConf);
  return out;
}

/** on_ramp_transition: the pool's net asset value with the on-ramp, the legacy delegated value before it, or disabled. */
function poolValue(bank: Account<Bank>, stake: RemainingAccount, onramp: RemainingAccount, supply: u64): PoolValue {
  if ((bank.flags & BANK_STAKED_ORACLE_USES_ONRAMP) !== 0n) {
    // expected_staked_onramp: the bank's key, else the on-ramp of the validator's pool.
    let expected = bank.config.oracle_keys.get(3n);
    if (expected === ZERO_PUBKEY) {
      if (bank.integration_acc_1 === ZERO_PUBKEY) return { err: STAKE_POOL_VALIDATION_FAILED, nav: 0n, supply: 0n };
      expected = findProgramAddress(["onramp", findProgramAddress(["pool", bank.integration_acc_1], SINGLE_POOL_ID)], SINGLE_POOL_ID);
    }
    if (onramp.key !== expected) return { err: WRONG_ORACLE_ACCOUNT_KEYS, nav: 0n, supply: 0n };
    const main = saturatingSubU64(stake.lamports, rentExempt(stake.dataLen));
    const ramp = saturatingSubU64(onramp.lamports, rentExempt(onramp.dataLen));
    const nav = main > 18446744073709551615n - ramp ? 18446744073709551615n : main + ramp;
    const eff = supply > 18446744073709551615n - SVSP_PHANTOM_TOKEN_AMOUNT ? 18446744073709551615n : supply + SVSP_PHANTOM_TOKEN_AMOUNT;
    return { err: 0n, nav, supply: eff };
  }
  if ((bank.flags & BANK_STAKED_ORACLE_DISABLED) !== 0n) return { err: STAKE_ORACLES_DISABLED, nav: 0n, supply: 0n };
  // StakeStateV2 (Borsh): a u32 tag, then Stake(Meta 120 bytes, Stake: delegation.voter 32, delegation.stake u64, …).
  // Bytes that do not decode fail with ProgramError::BorshIoError in the original (not a custom code).
  require(stake.dataLen >= 4n, "TypeSOL port: the pool's stake account does not decode (BorshIoError)");
  const tag = readData<u32>(stake, 0n);
  require(tag <= 3n, "TypeSOL port: the pool's stake account does not decode (BorshIoError)");
  if (tag !== 2n) {
    require(tag !== 1n || stake.dataLen >= 124n, "TypeSOL port: the pool's stake account does not decode (BorshIoError)");
    return { err: STAKE_POOL_VALIDATION_FAILED, nav: 0n, supply: 0n };
  }
  require(stake.dataLen >= 197n, "TypeSOL port: the pool's stake account does not decode (BorshIoError)");
  const delegated = readData<u64>(stake, 156n);
  if (delegated < 1000000000n) return { err: VENUE_MATH_ERROR, nav: 0n, supply: 0n };
  return { err: 0n, nav: delegated - 1000000000n, supply };
}

function saturatingSubU64(a: u64, b: u64): u64 {
  return a > b ? a - b : 0n;
}

// ---- Scope (price.rs ScopePriceFeed: an entry of Scope's OraclePrices) -------------------------------------------

const SCOPE_PROGRAM_ID = pubkey("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");
/** Scope's OraclePrices: an 8-byte discriminator, the oracle mappings key, then 512 dated prices of 56 bytes. */
const SCOPE_PRICES_DISCRIMINATOR: u64 = 10571153419667931225n;

/** ScopePriceFeed::check_ais: a Scope OraclePrices account of its exact size, the entry refreshed, its exponent sane. */
export function scopeEntryErr(a: RemainingAccount, entry: u16): u32 {
  if (a.owner !== SCOPE_PROGRAM_ID) return 6800n;
  if (a.dataLen < 8n || readData<u64>(a, 0n) !== SCOPE_PRICES_DISCRIMINATOR) return 6800n;
  if (a.dataLen !== 8n + 32n + 512n * 56n) return 6800n;
  if (toU64(entry) >= 512n) return 6801n;
  const at = 8n + 32n + toU64(entry) * 56n;
  if (readData<u64>(a, at) === 0n || readData<u64>(a, at + 24n) === 0n) return 6801n;
  if (readData<u64>(a, at + 8n) >= 24n) return 6801n;
  return 0n;
}

/** Whether the setup prices from a Scope entry (Scope, ScopeKamino, ScopeJuplend). */
export function isScopeSetup(s: OracleSetup): boolean {
  return s === OracleSetup.Scope || s === OracleSetup.ScopeKamino || s === OracleSetup.ScopeJuplend;
}

/**
 * A Scope bank's feed: the entry's price (value / 10^exp, no confidence), dated, not newer than now nor older than the
 * bank's maximum age; inside a Kamino or JupLend bank, times the venue's rate (the cache's multiplier, the entry's
 * price its price).
 */
export function scopeFeed(bank: Account<Bank>, rest: RemainingAccounts, first: u64, t: i64): Feed {
  const s = bank.config.oracle_setup;
  const feed = rest.get(first);
  if (feed.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  let rate: i128 = I80F48_ONE;
  let noBorrowPower: u8 = 0n;
  if (s === OracleSetup.ScopeKamino) {
    const reserve = rest.get(first + 1n);
    if (reserve.key !== bank.config.oracle_keys.get(1n)) return feedErr(KAMINO_RESERVE_VALIDATION_FAILED);
    if (reserve.owner !== KAMINO_ID || reserve.dataLen < 8n || readData<u64>(reserve, 0n) !== KAMINO_RESERVE_DISC)
      return feedErr(KAMINO_RESERVE_VALIDATION_FAILED);
    require(reserve.dataLen >= 8624n, MarginfiError.InternalLogicError);
    if (readData<u64>(reserve, 16n) < currentSlot()) return feedErr(KAMINO_RESERVE_STALE);
    const sup = kaminoSupplies(reserve);
    if (sup.err !== 0n) return feedErr(sup.err);
    if (sup.b <= 0n) return feedErr(VENUE_MATH_ERROR);
    rate = fxWrappingDiv(sup.a, sup.b);
    if (readData<u8>(reserve, 4864n) !== 0n || (bank.flags & KAMINO_MARKET_EMERGENCY) !== 0n) noBorrowPower = 1n;
  } else if (s === OracleSetup.ScopeJuplend) {
    const lending = rest.get(first + 1n);
    if (lending.key !== bank.config.oracle_keys.get(1n)) return feedErr(JUPLEND_LENDING_VALIDATION_FAILED);
    if (lending.owner !== JUPLEND_ID || lending.dataLen < 8n || readData<u64>(lending, 0n) !== JUPLEND_LENDING_DISC)
      return feedErr(JUPLEND_LENDING_VALIDATION_FAILED);
    require(lending.dataLen >= 196n, MarginfiError.InternalLogicError);
    if (toI64Wrap(readData<u64>(lending, 123n)) < t) return feedErr(JUPLEND_LENDING_STALE);
    const m = fxTryDiv(fxFromU64(readData<u64>(lending, 115n)), fxFromU128(EXCHANGE_PRICES_PRECISION));
    if (m.err !== 0n) return feedErr(VENUE_MATH_ERROR);
    rate = m.v;
  }
  const e = scopeEntryErr(feed, bank.config.scope_entry_index);
  if (e !== 0n) return feedErr(e);
  const at = 8n + 32n + toU64(bank.config.scope_entry_index) * 56n;
  const p = fxTryDiv(fxFromU64(readData<u64>(feed, at)), exp10Fx(readData<u64>(feed, at + 8n)));
  if (p.err !== 0n) return feedErr(VENUE_MATH_ERROR);
  const updated = readData<u64>(feed, at + 24n);
  // i64::try_from, then not in the future, then the age.
  if (updated > 9223372036854775807n) return feedErr(6801n);
  const last = toI64(updated);
  if (last > t) return feedErr(6801n);
  if (saturatingSubI64(t, last) > toI64(bank.config.oracle_max_age)) return feedErr(6802n);
  // Priced as a fixed price is (no confidence, no bias), dated by the entry.
  const out = feedErr(0n);
  out.kind = 8n;
  out.value = p.v;
  out.source_time = last;
  out.no_borrow_power = noBorrowPower;
  if (s === OracleSetup.Scope) return out;
  const adjusted = fxTryMul(p.v, rate);
  if (adjusted.err !== 0n) return feedErr(VENUE_MATH_ERROR);
  out.value = adjusted.v;
  out.mult = rate;
  out.has_raw = 1n;
  out.raw_err = 0n;
  out.raw_price = p.v;
  out.raw_conf = 0n;
  return out;
}

// ---- Exponent PT (lst_stake_price.rs pt_linear_multiplier: an Exponent vault) -------------------------------------

const EXPONENT_ID = pubkey("ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7");
/** The Exponent Vault discriminator, as a little-endian u64. */
const EXPONENT_VAULT_DISC: u64 = 8607953397882554579n;
const EXPONENT_VAULT_VALIDATION_FAILED: u32 = 6137n;
/** PT_MAX_MATURITY_HORIZON: about 5 years. */
const PT_MAX_MATURITY_HORIZON: i64 = 157680000n;

export function isPtSetup(s: OracleSetup): boolean {
  return s === OracleSetup.PTPyth || s === OracleSetup.PTFixed;
}

/** load_exponent_vault / validate_exponent_vault_account: the vault at oracle_keys[idx] (key, owner, discriminator), with `mint` its PT mint. */
function ptVaultErr(bank: Account<Bank>, a: RemainingAccount, idx: u64, checkMint: boolean): u32 {
  if (a.key !== bank.config.oracle_keys.get(idx)) return EXPONENT_VAULT_VALIDATION_FAILED;
  if (a.owner !== EXPONENT_ID || a.dataLen < 8n || readData<u64>(a, 0n) !== EXPONENT_VAULT_DISC) return EXPONENT_VAULT_VALIDATION_FAILED;
  require(a.dataLen >= 457n, MarginfiError.InternalLogicError);
  if (checkMint && readData<Pubkey>(a, 104n) !== bank.mint) return EXPONENT_VAULT_VALIDATION_FAILED;
  return 0n;
}

/**
 * pt_linear_multiplier: from the bank's start price (its fixed price) at the vault's start to par at maturity, linearly
 * (InterestRateCalc::lerp), capped by what a PT redeems for (SY per PT times asset per SY). A vault in emergency mode
 * (its SY rate under its all-time high) does not price unless `ignorePt`.
 */
function ptRate(bank: Account<Bank>, v: RemainingAccount, t: i64, ignorePt: boolean): Fx {
  if (!ignorePt) {
    // is_in_emergency_mode: the all-time-high SY rate above the last seen one (u256, most significant word first).
    let emergency = false;
    for (let i: u64 = 4n; i > 0n; i--) {
      const ath = readData<u64>(v, 369n + 8n * (i - 1n));
      const last = readData<u64>(v, 337n + 8n * (i - 1n));
      if (ath !== last) {
        emergency = ath > last;
        break;
      }
    }
    if (emergency) return { err: EXPONENT_VAULT_VALIDATION_FAILED, v: 0n };
  }
  const start = toI64(readData<u32>(v, 264n));
  const maturity = start + toI64(readData<u32>(v, 268n));
  if (!(maturity > start && maturity <= t + PT_MAX_MATURITY_HORIZON)) return { err: EXPONENT_VAULT_VALIDATION_FAILED, v: 0n };
  // lerp(start, start price, maturity, 1, now)
  const startY = bank.config.fixed_price.value;
  const startX = fxFromI64(start);
  const endX = fxFromI64(maturity);
  const target = fxFromI64(t);
  let expected: i128 = startY;
  if (!(endX <= startX || target <= startX)) {
    if (target >= endX) expected = I80F48_ONE;
    else {
      if (I80F48_ONE < startY) return { err: VENUE_MATH_ERROR, v: 0n };
      const proportion = fxWrappingDiv(target - startX, endX - startX);
      const scaled = fxTryMul(I80F48_ONE - startY, proportion);
      if (scaled.err !== 0n) return { err: VENUE_MATH_ERROR, v: 0n };
      expected = startY + scaled.v;
    }
  }
  // pt_redemption_multiplier
  const supply = readData<u64>(v, 449n);
  if (supply === 0n) return { err: EXPONENT_VAULT_VALIDATION_FAILED, v: 0n };
  if (readData<u64>(v, 345n) !== 0n || readData<u64>(v, 353n) !== 0n || readData<u64>(v, 361n) !== 0n) return { err: EXPONENT_VAULT_VALIDATION_FAILED, v: 0n };
  const syRate = readData<u64>(v, 337n);
  if (syRate === 0n) return { err: EXPONENT_VAULT_VALIDATION_FAILED, v: 0n };
  const syPerPt = fxTryDiv(fxFromU64(readData<u64>(v, 441n)), fxFromU64(supply));
  if (syPerPt.err !== 0n) return { err: VENUE_MATH_ERROR, v: 0n };
  const assetPerSy = fxTryDiv(fxFromU64(syRate), fxFromU128(EXCHANGE_PRICES_PRECISION));
  if (assetPerSy.err !== 0n) return { err: VENUE_MATH_ERROR, v: 0n };
  const redemption = fxTryMul(syPerPt.v, assetPerSy.v);
  if (redemption.err !== 0n) return { err: VENUE_MATH_ERROR, v: 0n };
  return { err: 0n, v: expected < redemption.v ? expected : redemption.v };
}

/**
 * A PT bank's feed: PTPyth, the feed times the PT rate (the cache keeping that price); PTFixed, the PT rate as a fixed
 * USD price (the vault its only account).
 */
export function ptFeed(bank: Account<Bank>, rest: RemainingAccounts, first: u64, t: i64, ignorePt: boolean): Feed {
  if (bank.config.oracle_setup === OracleSetup.PTFixed) {
    const v = rest.get(first);
    const e = ptVaultErr(bank, v, 0n, false);
    if (e !== 0n) return feedErr(e);
    const r = ptRate(bank, v, t, ignorePt);
    if (r.err !== 0n) return feedErr(r.err);
    const out = feedErr(0n);
    out.kind = 8n;
    out.value = r.v;
    return out;
  }
  const oracle = rest.get(first);
  if (oracle.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  const v = rest.get(first + 1n);
  const e = ptVaultErr(bank, v, 1n, false);
  if (e !== 0n) return feedErr(e);
  const r = ptRate(bank, v, t, ignorePt);
  if (r.err !== 0n) return feedErr(r.err);
  const f = pythFeed(oracle, toI64(bank.config.oracle_max_age), t);
  if (f.err !== 0n) return f;
  // The PT rate baked in; the cache keeps that price, with no multiplier.
  const g = withRate(f, r.v, true, 4294967295n);
  if (g.err !== 0n) return g;
  return withRate(g, I80F48_ONE, true, 4294967295n);
}

// ---- mSOL and LSTs (lst_stake_price.rs: Marinade's state, an SPL stake pool) --------------------------------------

const MARINADE_ID = pubkey("MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD");
/** The Marinade State discriminator, as a little-endian u64. */
const MARINADE_STATE_DISC: u64 = 12805505502107374296n;
const MARINADE_STATE_VALIDATION_FAILED: u32 = 6136n;
const SPL_STAKE_POOL_ID = pubkey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
const SANCTUM_SPL_STAKE_POOL_ID = pubkey("SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY");
const SANCTUM_SPL_MULTI_STAKE_POOL_ID = pubkey("SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn");
const STAKE_POOL_STALE: u32 = 6139n;
/** MAX_LST_SOL_RATE: an LST's or mSOL's SOL rate must be in (0, 3). */
const MAX_LST_SOL_RATE_FX: i128 = 844424930131968n;

/** Whether the setup prices mSOL (Marinade) or an LST (an SPL stake pool), on its own or inside a Kamino or JupLend bank. */
export function isLstSetup(s: OracleSetup): boolean {
  return (
    s === OracleSetup.PythMSOL ||
    s === OracleSetup.KaminoMSOL ||
    s === OracleSetup.JuplendMSOL ||
    s === OracleSetup.PythLST ||
    s === OracleSetup.KaminoLST ||
    s === OracleSetup.JuplendLST
  );
}

/** marinade_price_multiplier over the state at oracle_keys[idx]: (active + cooling down + reserve − tickets) / mSOL supply. */
function marinadeRate(bank: Account<Bank>, a: RemainingAccount, idx: u64): Fx {
  if (a.key !== bank.config.oracle_keys.get(idx)) return { err: MARINADE_STATE_VALIDATION_FAILED, v: 0n };
  if (a.owner !== MARINADE_ID || a.dataLen < 8n || readData<u64>(a, 0n) !== MARINADE_STATE_DISC) return { err: MARINADE_STATE_VALIDATION_FAILED, v: 0n };
  require(a.dataLen >= 576n, MarginfiError.InternalLogicError);
  const supply = readData<u64>(a, 504n);
  if (supply === 0n) return { err: MARINADE_STATE_VALIDATION_FAILED, v: 0n };
  const parts: u128 = toU128(readData<u64>(a, 376n)) + toU128(readData<u64>(a, 226n)) + toU128(readData<u64>(a, 568n)) + toU128(readData<u64>(a, 496n));
  // Each checked_add of the u64s: past u64, MathError.
  if (toU128(readData<u64>(a, 376n)) + toU128(readData<u64>(a, 226n)) > 18446744073709551615n) return { err: VENUE_MATH_ERROR, v: 0n };
  if (toU128(readData<u64>(a, 376n)) + toU128(readData<u64>(a, 226n)) + toU128(readData<u64>(a, 568n)) > 18446744073709551615n)
    return { err: VENUE_MATH_ERROR, v: 0n };
  if (parts > 18446744073709551615n) return { err: VENUE_MATH_ERROR, v: 0n };
  const tickets = readData<u64>(a, 528n);
  const staked = toU64(parts) > tickets ? toU64(parts) - tickets : 0n;
  const r = fxTryDiv(fxFromU64(staked), fxFromU64(supply));
  if (r.err !== 0n) return { err: VENUE_MATH_ERROR, v: 0n };
  if (r.v <= 0n || r.v >= MAX_LST_SOL_RATE_FX) return { err: MARINADE_STATE_VALIDATION_FAILED, v: 0n };
  return r;
}

/** stake_pool_price_multiplier over the SPL stake pool at oracle_keys[idx]: total lamports / pool tokens, updated this epoch or the last. */
function stakePoolRate(bank: Account<Bank>, a: RemainingAccount, idx: u64): Fx {
  if (a.key !== bank.config.oracle_keys.get(idx)) return { err: STAKE_POOL_VALIDATION_FAILED, v: 0n };
  if (a.owner !== SPL_STAKE_POOL_ID && a.owner !== SANCTUM_SPL_STAKE_POOL_ID && a.owner !== SANCTUM_SPL_MULTI_STAKE_POOL_ID)
    return { err: STAKE_POOL_VALIDATION_FAILED, v: 0n };
  // The Borsh prefix up to last_update_epoch (282 bytes; trailing bytes ignored), account_type 1 (StakePool).
  if (a.dataLen < 282n || readData<u8>(a, 0n) !== 1n) return { err: STAKE_POOL_VALIDATION_FAILED, v: 0n };
  const supply = readData<u64>(a, 266n);
  if (supply === 0n) return { err: ZERO_SUPPLY_IN_STAKE_POOL, v: 0n };
  const last = readData<u64>(a, 274n);
  const epoch = currentEpoch();
  if (epoch > last && epoch - last > 1n) return { err: STAKE_POOL_STALE, v: 0n };
  const r = fxTryDiv(fxFromU64(readData<u64>(a, 258n)), fxFromU64(supply));
  if (r.err !== 0n) return { err: VENUE_MATH_ERROR, v: 0n };
  if (r.v <= 0n || r.v >= MAX_LST_SOL_RATE_FX) return { err: STAKE_POOL_VALIDATION_FAILED, v: 0n };
  return r;
}

/** validate_marinade_state_account / validate_stake_pool_account: the account at oracle_keys[idx], its mint the bank's. */
function lstAccountErr(bank: Account<Bank>, a: RemainingAccount, idx: u64): u32 {
  const s = bank.config.oracle_setup;
  if (s === OracleSetup.PythMSOL || s === OracleSetup.KaminoMSOL || s === OracleSetup.JuplendMSOL) {
    if (a.key !== bank.config.oracle_keys.get(idx)) return MARINADE_STATE_VALIDATION_FAILED;
    if (a.owner !== MARINADE_ID || a.dataLen < 8n || readData<u64>(a, 0n) !== MARINADE_STATE_DISC) return MARINADE_STATE_VALIDATION_FAILED;
    require(a.dataLen >= 576n, MarginfiError.InternalLogicError);
    return readData<Pubkey>(a, 8n) === bank.mint ? 0n : MARINADE_STATE_VALIDATION_FAILED;
  }
  if (a.key !== bank.config.oracle_keys.get(idx)) return STAKE_POOL_VALIDATION_FAILED;
  if (a.owner !== SPL_STAKE_POOL_ID && a.owner !== SANCTUM_SPL_STAKE_POOL_ID && a.owner !== SANCTUM_SPL_MULTI_STAKE_POOL_ID)
    return STAKE_POOL_VALIDATION_FAILED;
  if (a.dataLen < 282n || readData<u8>(a, 0n) !== 1n) return STAKE_POOL_VALIDATION_FAILED;
  return readData<Pubkey>(a, 162n) === bank.mint ? 0n : STAKE_POOL_VALIDATION_FAILED;
}

/**
 * An mSOL or LST bank's feed (PythMSOL, PythLST and their Kamino and JupLend kinds): the SOL feed times the mSOL or LST
 * rate, whose price the cache keeps; inside a Kamino or JupLend bank, then times the venue's rate, the cache's
 * multiplier. Accounts: the SOL feed, then the venue's (if any), then Marinade's state or the stake pool.
 */
export function lstFeed(bank: Account<Bank>, rest: RemainingAccounts, first: u64, t: i64): Feed {
  const s = bank.config.oracle_setup;
  const msol = s === OracleSetup.PythMSOL || s === OracleSetup.KaminoMSOL || s === OracleSetup.JuplendMSOL;
  const kamino = s === OracleSetup.KaminoMSOL || s === OracleSetup.KaminoLST;
  const juplend = s === OracleSetup.JuplendMSOL || s === OracleSetup.JuplendLST;
  const oracle = rest.get(first);
  if (oracle.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  let venueRate: i128 = I80F48_ONE;
  let noBorrowPower: u8 = 0n;
  if (kamino) {
    const reserve = rest.get(first + 1n);
    if (reserve.key !== bank.config.oracle_keys.get(1n)) return feedErr(KAMINO_RESERVE_VALIDATION_FAILED);
    if (reserve.owner !== KAMINO_ID || reserve.dataLen < 8n || readData<u64>(reserve, 0n) !== KAMINO_RESERVE_DISC)
      return feedErr(KAMINO_RESERVE_VALIDATION_FAILED);
    require(reserve.dataLen >= 8624n, MarginfiError.InternalLogicError);
    if (readData<u64>(reserve, 16n) < currentSlot()) return feedErr(KAMINO_RESERVE_STALE);
    const sup = kaminoSupplies(reserve);
    if (sup.err !== 0n) return feedErr(sup.err);
    if (sup.b <= 0n) return feedErr(VENUE_MATH_ERROR);
    venueRate = fxWrappingDiv(sup.a, sup.b);
    if (readData<u8>(reserve, 4864n) !== 0n || (bank.flags & KAMINO_MARKET_EMERGENCY) !== 0n) noBorrowPower = 1n;
  } else if (juplend) {
    const lending = rest.get(first + 1n);
    if (lending.key !== bank.config.oracle_keys.get(1n)) return feedErr(JUPLEND_LENDING_VALIDATION_FAILED);
    if (lending.owner !== JUPLEND_ID || lending.dataLen < 8n || readData<u64>(lending, 0n) !== JUPLEND_LENDING_DISC)
      return feedErr(JUPLEND_LENDING_VALIDATION_FAILED);
    require(lending.dataLen >= 196n, MarginfiError.InternalLogicError);
    if (toI64Wrap(readData<u64>(lending, 123n)) < t) return feedErr(JUPLEND_LENDING_STALE);
    const m = fxTryDiv(fxFromU64(readData<u64>(lending, 115n)), fxFromU128(EXCHANGE_PRICES_PRECISION));
    if (m.err !== 0n) return feedErr(VENUE_MATH_ERROR);
    venueRate = m.v;
  }
  const idx: u64 = kamino || juplend ? 2n : 1n;
  const rate = msol ? marinadeRate(bank, rest.get(first + idx), idx) : stakePoolRate(bank, rest.get(first + idx), idx);
  if (rate.err !== 0n) return feedErr(rate.err);
  const f = pythFeed(oracle, toI64(bank.config.oracle_max_age), t);
  if (f.err !== 0n) return f;
  f.no_borrow_power = noBorrowPower;
  // The mSOL / LST rate baked into the feed; the cache keeps that price, and the venue's rate as its multiplier.
  const g = withRate(f, rate.v, true, 4294967295n);
  if (g.err !== 0n) return g;
  return withRate(g, venueRate, true, 4294967295n);
}

/** A venue bank's fixed price (FixedKamino, FixedDrift, FixedJuplend): no feed, the reserve / spot market / Lending only. */
export function isFixedVenueSetup(s: OracleSetup): boolean {
  return s === OracleSetup.FixedKamino || s === OracleSetup.FixedDrift || s === OracleSetup.FixedJuplend;
}

/** The venue setups ported: a Pyth or Switchboard feed and a reserve whose exchange rate multiplies it. */
export function isReserveSetup(s: OracleSetup): boolean {
  return isSolendSetup(s) || isKaminoSetup(s) || isDriftSetup(s) || isJuplendSetup(s);
}

/** Whether validation goes on to read the feed account (after validateOracleCount passed). */
export function validatesFeedAccount(bank: Account<Bank>): boolean {
  return (
    readsOneFeed(bank.config.oracle_setup) ||
    isReserveSetup(bank.config.oracle_setup) ||
    isLstSetup(bank.config.oracle_setup) ||
    bank.config.oracle_setup === OracleSetup.PTPyth
  );
}

/** The feed account's checks: its key, then a Pyth update's discriminator and Borsh form or a Switchboard feed's. */
export function validateFeedAccount(bank: Account<Bank>, a: RemainingAccount): u32 {
  if (a.key !== bank.config.oracle_keys.get(0n)) return WRONG_ORACLE_ACCOUNT_KEYS;
  const s = bank.config.oracle_setup;
  if (
    s === OracleSetup.SwitchboardPull ||
    s === OracleSetup.SolendSwitchboardPull ||
    s === OracleSetup.KaminoSwitchboardPull ||
    s === OracleSetup.DriftSwitchboardPull ||
    s === OracleSetup.JuplendSwitchboardPull
  )
    return switchboardAccountErr(a);
  return pythAccountErr(a);
}

/** After the feed, a venue setup's second account: the reserve's key (Solend/KaminoReserveValidationFailed). */
export function validateVenueAccount(bank: Account<Bank>, rest: RemainingAccounts): u32 {
  const s = bank.config.oracle_setup;
  // A fixed venue price's one account is the venue's.
  if (isFixedVenueSetup(s)) {
    if (rest.get(0n).key === bank.config.oracle_keys.get(1n)) return 0n;
    if (s === OracleSetup.FixedDrift) return DRIFT_SPOT_MARKET_VALIDATION_FAILED;
    return s === OracleSetup.FixedJuplend ? JUPLEND_LENDING_VALIDATION_FAILED : KAMINO_RESERVE_VALIDATION_FAILED;
  }
  // An Exponent PT vault (PTPyth: after the feed; PTFixed: the only account), its PT mint the bank's.
  if (s === OracleSetup.PTPyth) return ptVaultErr(bank, rest.get(1n), 1n, true);
  if (s === OracleSetup.PTFixed) return ptVaultErr(bank, rest.get(0n), 0n, true);
  // An mSOL / LST setup inside a Kamino or JupLend bank: the venue's account, then Marinade's state or the stake pool.
  if (isLstSetup(s)) {
    const venue = s === OracleSetup.KaminoMSOL || s === OracleSetup.KaminoLST || s === OracleSetup.JuplendMSOL || s === OracleSetup.JuplendLST;
    if (venue && rest.get(1n).key !== bank.config.oracle_keys.get(1n))
      return s === OracleSetup.KaminoMSOL || s === OracleSetup.KaminoLST ? KAMINO_RESERVE_VALIDATION_FAILED : JUPLEND_LENDING_VALIDATION_FAILED;
    return lstAccountErr(bank, rest.get(venue ? 2n : 1n), venue ? 2n : 1n);
  }
  if (!isReserveSetup(s)) return 0n;
  if (rest.get(1n).key === bank.config.oracle_keys.get(1n)) return 0n;
  if (isDriftSetup(s)) return DRIFT_SPOT_MARKET_VALIDATION_FAILED;
  if (isJuplendSetup(s)) return JUPLEND_LENDING_VALIDATION_FAILED;
  return isSolendSetup(s) ? SOLEND_RESERVE_VALIDATION_FAILED : KAMINO_RESERVE_VALIDATION_FAILED;
}

// ---- reading feeds ----------------------------------------------------------------------------------------------

/** One feed as loaded (OraclePriceFeedAdapter): Pyth's spot and EMA pairs, or a Switchboard or fixed price. */
export interface Feed {
  err: u32;
  /** 3 Pyth push, 4 Switchboard pull, 8 fixed */
  kind: u8;
  price: i64;
  conf: u64;
  ema_price: i64;
  ema_conf: u64;
  exponent: i32;
  publish_time: i64;
  /** Switchboard's or the fixed price, as I80F48 bits */
  value: i128;
  source_time: i64;
  /** A venue bank's exchange rate (I80F48), applied to the feed above; 1 for the others */
  mult: i128;
  /** A venue feed's price for the bank's cache, read before the rate is applied (has_raw 1): its error, price, confidence */
  has_raw: u8;
  raw_err: u32;
  raw_price: i128;
  raw_conf: i128;
  /** 1 when the collateral cannot back new borrows (a Kamino reserve or market in emergency mode): worth 0 for Initial */
  no_borrow_power: u8;
}

/** OraclePriceWithConfidence */
export interface PriceConf {
  err: u32;
  price: i128;
  conf: i128;
  source_time: i64;
  /** The bank's price multiplier the cache keeps with it (a venue's exchange rate; 1 otherwise) */
  mult: i128;
}

export function feedErr(err: u32): Feed {
  return {
    err,
    kind: 0n,
    price: 0n,
    conf: 0n,
    ema_price: 0n,
    ema_conf: 0n,
    exponent: 0n,
    publish_time: 0n,
    value: 0n,
    source_time: 0n,
    mult: I80F48_ONE,
    has_raw: 0n,
    raw_err: 0n,
    raw_price: 0n,
    raw_conf: 0n,
    no_borrow_power: 0n,
  };
}

/**
 * load_oracle_context's checks before an account is read: no setup, the number of accounts. 0 means the setup
 * reads the one account given (loadFeed next); a fixed price needs none (fixedFeed).
 */
export function oracleCount(bank: Account<Bank>, n: u64): u32 {
  const s = bank.config.oracle_setup;
  if (s === OracleSetup.None) return ORACLE_NOT_SETUP;
  // Both panic as deprecated in the original.
  require(s !== OracleSetup.PythLegacy && s !== OracleSetup.SwitchboardV2, MarginfiError.InternalLogicError);
  if (s === OracleSetup.PythPushOracle || s === OracleSetup.SwitchboardPull) return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.Fixed) return n === 0n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (isReserveSetup(s)) return n === 2n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (isFixedVenueSetup(s)) return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.StakedWithPythPush) return n === 4n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.PythMSOL || s === OracleSetup.PythLST) return n === 2n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (isLstSetup(s)) return n === 3n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.Scope) return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (isScopeSetup(s)) return n === 2n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.PTPyth) return n === 2n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  if (s === OracleSetup.PTFixed) return n === 1n ? 0n : WRONG_NUMBER_OF_ORACLE_ACCOUNTS;
  require(false, "TypeSOL port: this oracle setup's pricing is not ported");
  return 0n;
}

/** The fixed price (`Fixed`): never negative. */
export function fixedFeed(bank: Account<Bank>): Feed {
  const v = bank.config.fixed_price.value;
  if (v < 0n) return feedErr(6100n);
  return {
    err: 0n,
    kind: 8n,
    price: 0n,
    conf: 0n,
    ema_price: 0n,
    ema_conf: 0n,
    exponent: 0n,
    publish_time: 0n,
    value: v,
    source_time: 0n,
    mult: I80F48_ONE,
    has_raw: 0n,
    raw_err: 0n,
    raw_price: 0n,
    raw_conf: 0n,
    no_borrow_power: 0n,
  };
}

/** A Pyth or Switchboard feed for the bank, read from its account: the key, the account, then its age. */
export function loadFeed(bank: Account<Bank>, a: RemainingAccount, t: i64): Feed {
  if (a.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  const maxAge = toI64(bank.config.oracle_max_age);
  if (bank.config.oracle_setup === OracleSetup.SwitchboardPull) return switchboardFeed(a, maxAge, t);
  return pythFeed(a, maxAge, t);
}

/** SwitchboardPullPriceFeed::load_checked: the account, then its age. */
function switchboardFeed(a: RemainingAccount, maxAge: i64, t: i64): Feed {
  const e = switchboardAccountErr(a);
  if (e !== 0n) return feedErr(e);
  const updated = readData<i64>(a, 2216n);
  if (saturatingSubI64(t, updated) > maxAge) return feedErr(6049n);
  const f = feedErr(0n);
  f.kind = 4n;
  f.value = readData<i128>(a, 2264n);
  f.source_time = updated;
  return f;
}

/** PythPushOraclePriceFeed::load_checked: the account, a fully verified update, then its age. */
function pythFeed(a: RemainingAccount, maxAge: i64, t: i64): Feed {
  const e = pythAccountErr(a);
  if (e !== 0n) return feedErr(e);
  // Only a fully verified update is accepted (MIN_PYTH_PUSH_VERIFICATION_LEVEL), then its age.
  if (readData<u8>(a, 40n) === 0n) return feedErr(6056n);
  const publish = readData<i64>(a, 93n);
  if (saturatingAddI64(publish, maxAge) < t) return feedErr(6050n);
  const f = feedErr(0n);
  f.kind = 3n;
  f.price = readData<i64>(a, 73n);
  f.conf = readData<u64>(a, 81n);
  f.ema_price = readData<i64>(a, 109n);
  f.ema_conf = readData<u64>(a, 117n);
  f.exponent = readData<i32>(a, 89n);
  f.publish_time = publish;
  f.source_time = publish;
  return f;
}

// ---- Solend reserves (solend_mocks::state::SolendMinimalReserve: Solend's packed Reserve, the version byte first) --------

const SOLEND_ID = pubkey("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");
const SOLEND_RESERVE_VALIDATION_FAILED: u32 = 6401n;
const SOLEND_RESERVE_STALE: u32 = 6411n;
const VENUE_MATH_ERROR: u32 = 6062n;
/** SolendMocksError::MathError: the mocks' own error enum, numbered from 6000 like Marginfi's. */
export const SOLEND_MOCKS_MATH_ERROR: u32 = 6000n;
const WAD: u128 = 1000000000000000000n;

/**
 * load_solend_reserve: the key oracle_keys[1] names, then AccountLoader::try_from (the Solend program's account, its
 * version byte 1 as the discriminator); a reserve shorter than SolendMinimalReserve panics when loaded.
 */
export function solendReserveErr(bank: Account<Bank>, r: RemainingAccount): u32 {
  if (r.key !== bank.config.oracle_keys.get(1n)) return SOLEND_RESERVE_VALIDATION_FAILED;
  if (r.owner !== SOLEND_ID || r.dataLen < 1n || readData<u8>(r, 0n) !== 1n) return SOLEND_RESERVE_VALIDATION_FAILED;
  require(r.dataLen >= 619n, MarginfiError.InternalLogicError);
  return 0n;
}

/** SolendMinimalReserve::is_stale: last_update_slot behind the current slot (the stale flag is not read). */
export function solendReserveStale(r: RemainingAccount): boolean {
  return readData<u64>(r, 1n) < currentSlot();
}

/** decimal_to_i80f48: a WAD-scaled u128 as I80F48, the integer part at most 2^79 - 1 (MathError past it). */
function decimalFx(raw: u128): Fx {
  const whole = raw / WAD;
  if (whole > 604462909807314587353087n) return { err: SOLEND_MOCKS_MATH_ERROR, v: 0n };
  const frac = ((raw % WAD) * 281474976710656n) / WAD;
  return { err: 0n, v: toI128(whole) * 281474976710656n + toI128(frac) };
}

/** Two I80F48 values, or the error computing them. */
export interface FxPair {
  err: u32;
  a: i128;
  b: i128;
}

/**
 * SolendMinimalReserve::scaled_supplies over the reserve's fields: its total liquidity (available + borrowed -
 * protocol fees, the last two WAD decimals) and its collateral mint's supply, both divided by 10^decimals.
 */
export function solendScaledSupplies(available: u64, borrowedWads: u128, feesWads: u128, decimals: u8, collateral: u64): FxPair {
  const borrowed = decimalFx(borrowedWads);
  if (borrowed.err !== 0n) return { err: borrowed.err, a: 0n, b: 0n };
  const fees = decimalFx(feesWads);
  if (fees.err !== 0n) return { err: fees.err, a: 0n, b: 0n };
  const total = fxSub(fxAdd(fxFromU64(available), borrowed.v), fees.v);
  if (decimals > 23n) return { err: SOLEND_MOCKS_MATH_ERROR, a: 0n, b: 0n };
  const scale = exp10Fx(toU64(decimals));
  const liq = fxTryDiv(total, scale);
  if (liq.err !== 0n) return { err: SOLEND_MOCKS_MATH_ERROR, a: 0n, b: 0n };
  const col = fxTryDiv(fxFromU64(collateral), scale);
  if (col.err !== 0n) return { err: SOLEND_MOCKS_MATH_ERROR, a: 0n, b: 0n };
  return { err: 0n, a: liq.v, b: col.v };
}

/** solend_price_multiplier: total liquidity per collateral token (MathError with no collateral). */
function solendMultiplier(r: RemainingAccount): Fx {
  const s = solendScaledSupplies(readData<u64>(r, 171n), readData<u128>(r, 179n), readData<u128>(r, 373n), readData<u8>(r, 74n), readData<u64>(r, 259n));
  if (s.err !== 0n) return { err: s.err, v: 0n };
  if (s.b <= 0n) return { err: VENUE_MATH_ERROR, v: 0n };
  return { err: 0n, v: fxWrappingDiv(s.a, s.b) };
}

/** mul_i64_by_i80f48: the product, toward −∞, as an i64; err when it does not fit. */
function mulI64(v: i64, m: i128): Fx {
  const p = fxTryMul(fxFromI64(v), m);
  if (p.err !== 0n) return p;
  const n = p.v >> 48n;
  if (n < -9223372036854775808n || n > 9223372036854775807n) return { err: VENUE_MATH_ERROR, v: 0n };
  return { err: 0n, v: n };
}

/** mul_u64_by_i80f48 */
function mulU64(v: u64, m: i128): Fx {
  const p = fxTryMul(fxFromU64(v), m);
  if (p.err !== 0n) return p;
  const n = p.v >> 48n;
  if (n < 0n || n > 18446744073709551615n) return { err: VENUE_MATH_ERROR, v: 0n };
  return { err: 0n, v: n };
}

/** mul_i128_by_i80f48: the value as I80F48 (err past 80 integer bits), times the multiplier, toward −∞. */
function mulI128(v: i128, m: i128): Fx {
  if (v < -604462909807314587353088n || v > 604462909807314587353087n) return { err: VENUE_MATH_ERROR, v: 0n };
  const p = fxTryMul(v * 281474976710656n, m);
  if (p.err !== 0n) return p;
  return { err: 0n, v: p.v >> 48n };
}

/**
 * A venue feed once loaded: its price as the bank's cache keeps it (Pyth's confidence uncapped, Switchboard's at the
 * bank's maximum), then its prices and confidences times the exchange rate `m` (MathError when they do not fit).
 */
function withRate(f: Feed, m: i128, pyth: boolean, maxConfidence: u32): Feed {
  const raw = priceAndConfidence(f, true, pyth ? 4294967295n : maxConfidence);
  const out = feedErr(0n);
  out.kind = f.kind;
  out.price = f.price;
  out.conf = f.conf;
  out.ema_price = f.ema_price;
  out.ema_conf = f.ema_conf;
  out.exponent = f.exponent;
  out.publish_time = f.publish_time;
  out.value = f.value;
  out.source_time = f.source_time;
  out.no_borrow_power = f.no_borrow_power;
  out.has_raw = 1n;
  out.raw_err = raw.err;
  out.raw_price = raw.price;
  out.raw_conf = raw.conf;
  out.mult = m;
  if (pyth) {
    const price = mulI64(f.price, m);
    const ema = mulI64(f.ema_price, m);
    const conf = mulU64(f.conf, m);
    const emaConf = mulU64(f.ema_conf, m);
    if (price.err !== 0n || ema.err !== 0n || conf.err !== 0n || emaConf.err !== 0n) {
      out.err = VENUE_MATH_ERROR;
      return out;
    }
    out.price = toI64(price.v);
    out.ema_price = toI64(ema.v);
    out.conf = toU64(conf.v);
    out.ema_conf = toU64(emaConf.v);
  } else {
    const v = mulI128(f.value, m);
    if (v.err !== 0n) {
      out.err = VENUE_MATH_ERROR;
      return out;
    }
    out.value = v.v;
  }
  return out;
}

/**
 * A Solend bank's feed (SolendPythPull, SolendSwitchboardPull): the reserve (its key, the account, its freshness, the
 * exchange rate) and the feed account (Pyth checks its key after the reserve, Switchboard before), the feed's price as
 * the bank's cache keeps it (Pyth's confidence uncapped), then its prices and confidences times the rate.
 */
export function solendFeed(bank: Account<Bank>, rest: RemainingAccounts, first: u64, t: i64): Feed {
  const pyth = bank.config.oracle_setup === OracleSetup.SolendPythPull;
  const oracle = rest.get(first);
  const reserve = rest.get(first + 1n);
  if (!pyth && oracle.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  const re = solendReserveErr(bank, reserve);
  if (re !== 0n) return feedErr(re);
  if (solendReserveStale(reserve)) return feedErr(SOLEND_RESERVE_STALE);
  const m = solendMultiplier(reserve);
  if (m.err !== 0n) return feedErr(m.err);
  if (pyth && oracle.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  const maxAge = toI64(bank.config.oracle_max_age);
  const f = pyth ? pythFeed(oracle, maxAge, t) : switchboardFeed(oracle, maxAge, t);
  if (f.err !== 0n) return f;
  return withRate(f, m.v, pyth, bank.config.oracle_max_confidence);
}

// ---- Kamino reserves (kamino_mocks::state::MinimalReserve, Anchor zero-copy) -----------------------------------------

export const KAMINO_ID = pubkey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const KAMINO_RESERVE_VALIDATION_FAILED: u32 = 6210n;
const KAMINO_RESERVE_STALE: u32 = 6206n;
/** The Reserve account's discriminator, as a little-endian u64. */
export const KAMINO_RESERVE_DISC: u64 = 9168193160886415915n;
/** Bank.flags: the reserve's market is in emergency mode (propagate_kamino_market_emergency). */
export const KAMINO_MARKET_EMERGENCY: u64 = 16384n;

/** u68f60_to_i80f48: a Kamino Fraction (U68F60) as I80F48, its 12 lowest bits dropped. */
export function u68f60Fx(raw: u128): i128 {
  return toI128(raw >> 12n);
}

/**
 * MinimalReserve::scaled_supplies over the reserve's fields: available + borrowed - the protocol, referrer and pending
 * referrer fees (Fractions), and the collateral supply, both divided by 10^decimals (KaminoMocksError::MathError, 6000).
 */
export function kaminoScaledSupplies(available: u64, borrowed: u128, protocol: u128, referrer: u128, pending: u128, decimals: u64, collateral: u64): FxPair {
  const total = fxSub(fxSub(fxSub(fxAdd(fxFromU64(available), u68f60Fx(borrowed)), u68f60Fx(protocol)), u68f60Fx(referrer)), u68f60Fx(pending));
  // `as u8` on the reserve's u64 decimals.
  const d = decimals & 255n;
  if (d > 23n) return { err: SOLEND_MOCKS_MATH_ERROR, a: 0n, b: 0n };
  const scale = exp10Fx(d);
  const liq = fxTryDiv(total, scale);
  if (liq.err !== 0n) return { err: SOLEND_MOCKS_MATH_ERROR, a: 0n, b: 0n };
  const col = fxTryDiv(fxFromU64(collateral), scale);
  if (col.err !== 0n) return { err: SOLEND_MOCKS_MATH_ERROR, a: 0n, b: 0n };
  return { err: 0n, a: liq.v, b: col.v };
}

function kaminoSupplies(r: RemainingAccount): FxPair {
  return kaminoScaledSupplies(
    readData<u64>(r, 224n),
    readData<u128>(r, 232n),
    readData<u128>(r, 344n),
    readData<u128>(r, 360n),
    readData<u128>(r, 376n),
    readData<u64>(r, 272n),
    readData<u64>(r, 2592n),
  );
}

/**
 * A Kamino bank's feed (KaminoPythPush, KaminoSwitchboardPull): the feed's key, the reserve (its key, the account, its
 * freshness, the exchange rate), the feed account, whether the collateral still backs borrows, then the cache's price
 * and the prices times the rate.
 */
export function kaminoFeed(bank: Account<Bank>, rest: RemainingAccounts, first: u64, t: i64): Feed {
  const pyth = bank.config.oracle_setup === OracleSetup.KaminoPythPush;
  const oracle = rest.get(first);
  const reserve = rest.get(first + 1n);
  if (oracle.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  if (reserve.key !== bank.config.oracle_keys.get(1n)) return feedErr(KAMINO_RESERVE_VALIDATION_FAILED);
  if (reserve.owner !== KAMINO_ID || reserve.dataLen < 8n || readData<u64>(reserve, 0n) !== KAMINO_RESERVE_DISC)
    return feedErr(KAMINO_RESERVE_VALIDATION_FAILED);
  require(reserve.dataLen >= 8624n, MarginfiError.InternalLogicError);
  if (readData<u64>(reserve, 16n) < currentSlot()) return feedErr(KAMINO_RESERVE_STALE);
  const s = kaminoSupplies(reserve);
  if (s.err !== 0n) return feedErr(s.err);
  if (s.b <= 0n) return feedErr(VENUE_MATH_ERROR);
  const m = fxWrappingDiv(s.a, s.b);
  const maxAge = toI64(bank.config.oracle_max_age);
  const f = pyth ? pythFeed(oracle, maxAge, t) : switchboardFeed(oracle, maxAge, t);
  if (f.err !== 0n) return f;
  // kamino_borrow_power: the reserve's emergency mode, or the market's as propagated to the bank.
  if (readData<u8>(reserve, 4864n) !== 0n || (bank.flags & KAMINO_MARKET_EMERGENCY) !== 0n) f.no_borrow_power = 1n;
  return withRate(f, m, pyth, bank.config.oracle_max_confidence);
}

/**
 * A feed times a venue's exchange rate (`numerator` / `precision`, as `mult` in I80F48 for the cache): the feed account,
 * the cache's price (before the rate; Pyth's confidence unbounded), then the prices and confidences times the rate
 * (mul_div: a negative price, or a result past its type, fails with MathError).
 */
function rateFeed(bank: Account<Bank>, oracle: RemainingAccount, pyth: boolean, numerator: u128, precision: u128, mult: i128, t: i64): Feed {
  const maxAge = toI64(bank.config.oracle_max_age);
  const f = pyth ? pythFeed(oracle, maxAge, t) : switchboardFeed(oracle, maxAge, t);
  if (f.err !== 0n) return f;
  const raw = priceAndConfidence(f, true, pyth ? 4294967295n : bank.config.oracle_max_confidence);
  const out = feedErr(0n);
  out.kind = f.kind;
  out.price = f.price;
  out.conf = f.conf;
  out.ema_price = f.ema_price;
  out.ema_conf = f.ema_conf;
  out.exponent = f.exponent;
  out.publish_time = f.publish_time;
  out.value = f.value;
  out.source_time = f.source_time;
  out.has_raw = 1n;
  out.raw_err = raw.err;
  out.raw_price = raw.price;
  out.raw_conf = raw.conf;
  out.mult = mult;
  if (pyth) {
    // mul_div_i64 / mul_div_u64: a negative value, or a result past the type, fails.
    const price: i128 = f.price < 0n ? -1n : mulDivU128(toU128(f.price), numerator, precision);
    const ema: i128 = f.ema_price < 0n ? -1n : mulDivU128(toU128(f.ema_price), numerator, precision);
    const conf: i128 = mulDivU128(toU128(f.conf), numerator, precision);
    const emaConf: i128 = mulDivU128(toU128(f.ema_conf), numerator, precision);
    const i64Max: i128 = 9223372036854775807n;
    const u64Max: i128 = 18446744073709551615n;
    if (price < 0n || price > i64Max || ema < 0n || ema > i64Max || conf < 0n || conf > u64Max || emaConf < 0n || emaConf > u64Max) {
      out.err = VENUE_MATH_ERROR;
      return out;
    }
    out.price = toI64(price);
    out.ema_price = toI64(ema);
    out.conf = toU64(conf);
    out.ema_conf = toU64(emaConf);
  } else {
    // mul_div_i128 on Switchboard's 10^18-scaled value.
    const v: i128 = f.value < 0n ? -1n : mulDivU128(toU128(f.value), numerator, precision);
    if (v < 0n) {
      out.err = VENUE_MATH_ERROR;
      return out;
    }
    out.value = v;
  }
  return out;
}

// ---- Drift spot markets (drift_mocks::state::MinimalSpotMarket, Anchor zero-copy) ----------------------------------

export const DRIFT_ID = pubkey("dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH");
const DRIFT_SPOT_MARKET_VALIDATION_FAILED: u32 = 6304n;
const DRIFT_SPOT_MARKET_STALE: u32 = 6322n;
/** The SpotMarket account's discriminator, as a little-endian u64. */
export const DRIFT_SPOT_MARKET_DISC: u64 = 2828614232571425124n;
/** SPOT_CUMULATIVE_INTEREST_PRECISION */
const SPOT_INTEREST_PRECISION: u128 = 10000000000n;

/** mul_div_u128: value × numerator / denominator, toward zero; -1 when the product does not fit a u128 (or the result an i128). */
function mulDivU128(value: u128, numerator: u128, denominator: u128): i128 {
  const p = toU256(value) * toU256(numerator);
  if (p > 340282366920938463463374607431768211455n) return -1n;
  const q = p / toU256(denominator);
  if (q > 170141183460469231731687303715884105727n) return -1n;
  return toI128(q);
}

/** I80F48::from_num of a u128 (panics past its 80 integer bits). */
function fxFromU128(n: u128): i128 {
  require(n <= 604462909807314587353087n, MarginfiError.InternalLogicError);
  return toI128(n) * 281474976710656n;
}

/** `as i64` on a u64: wraps past i64::MAX. */
function toI64Wrap(n: u64): i64 {
  return n <= 9223372036854775807n ? toI64(n) : toI64(n - 9223372036854775808n) - 9223372036854775807n - 1n;
}

/**
 * A Drift bank's feed (DriftPythPull, DriftSwitchboardPull): the feed's key, the spot market (its key, the account, its
 * interest accrued this second), then the feed times its cumulative deposit interest over 10^10 (rateFeed).
 */
export function driftFeed(bank: Account<Bank>, rest: RemainingAccounts, first: u64, t: i64): Feed {
  const pyth = bank.config.oracle_setup === OracleSetup.DriftPythPull;
  const oracle = rest.get(first);
  const market = rest.get(first + 1n);
  if (oracle.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  if (market.key !== bank.config.oracle_keys.get(1n)) return feedErr(DRIFT_SPOT_MARKET_VALIDATION_FAILED);
  if (market.owner !== DRIFT_ID || market.dataLen < 8n || readData<u64>(market, 0n) !== DRIFT_SPOT_MARKET_DISC)
    return feedErr(DRIFT_SPOT_MARKET_VALIDATION_FAILED);
  require(market.dataLen >= 776n, MarginfiError.InternalLogicError);
  if (toI64Wrap(readData<u64>(market, 568n)) < t) return feedErr(DRIFT_SPOT_MARKET_STALE);
  const numerator = readData<u128>(market, 464n);
  const mult = fxTryDiv(fxFromU128(numerator), fxFromU64(toU64(SPOT_INTEREST_PRECISION)));
  if (mult.err !== 0n) return feedErr(VENUE_MATH_ERROR);
  return rateFeed(bank, oracle, pyth, numerator, SPOT_INTEREST_PRECISION, mult.v, t);
}

// ---- JupLend lendings (juplend_mocks::state::Lending, Anchor zero-copy, packed) ----------------------------------

export const JUPLEND_ID = pubkey("jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9");
const JUPLEND_LENDING_VALIDATION_FAILED: u32 = 6501n;
const JUPLEND_LENDING_STALE: u32 = 6504n;
/** The Lending account's discriminator, as a little-endian u64. */
export const JUPLEND_LENDING_DISC: u64 = 17417253714645927815n;
/** EXCHANGE_PRICES_PRECISION */
const EXCHANGE_PRICES_PRECISION: u128 = 1000000000000n;

/**
 * A JupLend bank's feed (JuplendPythPull, JuplendSwitchboardPull): the feed's key, the Lending account (its key, the
 * account, updated this second), the feed account, the cache's price, then the prices and confidences times the
 * Lending's token exchange price over 10^12.
 */
export function juplendFeed(bank: Account<Bank>, rest: RemainingAccounts, first: u64, t: i64): Feed {
  const pyth = bank.config.oracle_setup === OracleSetup.JuplendPythPull;
  const oracle = rest.get(first);
  const lending = rest.get(first + 1n);
  if (oracle.key !== bank.config.oracle_keys.get(0n)) return feedErr(WRONG_ORACLE_ACCOUNT_KEYS);
  if (lending.key !== bank.config.oracle_keys.get(1n)) return feedErr(JUPLEND_LENDING_VALIDATION_FAILED);
  if (lending.owner !== JUPLEND_ID || lending.dataLen < 8n || readData<u64>(lending, 0n) !== JUPLEND_LENDING_DISC)
    return feedErr(JUPLEND_LENDING_VALIDATION_FAILED);
  require(lending.dataLen >= 196n, MarginfiError.InternalLogicError);
  if (toI64Wrap(readData<u64>(lending, 123n)) < t) return feedErr(JUPLEND_LENDING_STALE);
  const numerator = toU128(readData<u64>(lending, 115n));
  const mult = fxTryDiv(fxFromU64(readData<u64>(lending, 115n)), fxFromU128(EXCHANGE_PRICES_PRECISION));
  if (mult.err !== 0n) return feedErr(VENUE_MATH_ERROR);
  return rateFeed(bank, oracle, pyth, numerator, EXCHANGE_PRICES_PRECISION, mult.v, t);
}

/**
 * A venue bank's fixed price (FixedKamino, FixedDrift, FixedJuplend): the venue's account (its key, the account, updated
 * now), then the fixed price (never negative) times the venue's rate, which the cache keeps as its multiplier with the
 * fixed price as its price (no confidence). A Kamino reserve with no collateral keeps the price as it is.
 */
export function fixedVenueFeed(bank: Account<Bank>, rest: RemainingAccounts, first: u64, t: i64): Feed {
  const s = bank.config.oracle_setup;
  const a = rest.get(first);
  const base = bank.config.fixed_price.value;
  let price: i128 = 0n;
  let mult: i128 = I80F48_ONE;
  let noBorrowPower: u8 = 0n;
  if (s === OracleSetup.FixedDrift) {
    if (a.key !== bank.config.oracle_keys.get(1n)) return feedErr(DRIFT_SPOT_MARKET_VALIDATION_FAILED);
    if (a.owner !== DRIFT_ID || a.dataLen < 8n || readData<u64>(a, 0n) !== DRIFT_SPOT_MARKET_DISC) return feedErr(DRIFT_SPOT_MARKET_VALIDATION_FAILED);
    require(a.dataLen >= 776n, MarginfiError.InternalLogicError);
    if (toI64Wrap(readData<u64>(a, 568n)) < t) return feedErr(DRIFT_SPOT_MARKET_STALE);
    if (base < 0n) return feedErr(6100n);
    const ratio = fxTryDiv(fxFromU128(readData<u128>(a, 464n)), fxFromU64(toU64(SPOT_INTEREST_PRECISION)));
    if (ratio.err !== 0n) return feedErr(VENUE_MATH_ERROR);
    const p = fxTryMul(base, ratio.v);
    if (p.err !== 0n) return feedErr(VENUE_MATH_ERROR);
    price = p.v;
    mult = ratio.v;
  } else if (s === OracleSetup.FixedKamino) {
    if (a.key !== bank.config.oracle_keys.get(1n)) return feedErr(KAMINO_RESERVE_VALIDATION_FAILED);
    if (a.owner !== KAMINO_ID || a.dataLen < 8n || readData<u64>(a, 0n) !== KAMINO_RESERVE_DISC) return feedErr(KAMINO_RESERVE_VALIDATION_FAILED);
    require(a.dataLen >= 8624n, MarginfiError.InternalLogicError);
    if (readData<u64>(a, 16n) < currentSlot()) return feedErr(KAMINO_RESERVE_STALE);
    if (base < 0n) return feedErr(6100n);
    const supplies = kaminoSupplies(a);
    if (supplies.err !== 0n) return feedErr(supplies.err);
    price = base;
    if (supplies.b > 0n) {
      mult = fxWrappingDiv(supplies.a, supplies.b);
      const p = fxTryMul(base, mult);
      if (p.err !== 0n) return feedErr(VENUE_MATH_ERROR);
      price = p.v;
    }
    // kamino_borrow_power: the reserve's emergency mode, or the market's as propagated to the bank.
    if (readData<u8>(a, 4864n) !== 0n || (bank.flags & KAMINO_MARKET_EMERGENCY) !== 0n) noBorrowPower = 1n;
  } else {
    if (a.key !== bank.config.oracle_keys.get(1n)) return feedErr(JUPLEND_LENDING_VALIDATION_FAILED);
    if (a.owner !== JUPLEND_ID || a.dataLen < 8n || readData<u64>(a, 0n) !== JUPLEND_LENDING_DISC) return feedErr(JUPLEND_LENDING_VALIDATION_FAILED);
    require(a.dataLen >= 196n, MarginfiError.InternalLogicError);
    if (toI64Wrap(readData<u64>(a, 123n)) < t) return feedErr(JUPLEND_LENDING_STALE);
    if (base < 0n) return feedErr(6100n);
    // base × token_exchange_price, then / 10^12 (not × the multiplier: a different rounding).
    const p = fxTryMul(base, fxFromU64(readData<u64>(a, 115n)));
    if (p.err !== 0n) return feedErr(VENUE_MATH_ERROR);
    const q = fxTryDiv(p.v, fxFromU128(EXCHANGE_PRICES_PRECISION));
    if (q.err !== 0n) return feedErr(VENUE_MATH_ERROR);
    price = q.v;
    const m = fxTryDiv(fxFromU64(readData<u64>(a, 115n)), fxFromU128(EXCHANGE_PRICES_PRECISION));
    if (m.err !== 0n) return feedErr(VENUE_MATH_ERROR);
    mult = m.v;
  }
  const out = fixedFeed(bank);
  out.value = price;
  out.mult = mult;
  out.has_raw = 1n;
  out.raw_err = 0n;
  out.raw_price = base;
  out.raw_conf = 0n;
  out.no_borrow_power = noBorrowPower;
  return out;
}

/**
 * load_price_update_v2_checked: at least the discriminator, then a Borsh PriceUpdateV2: write authority (32), a
 * verification level (1 = Full, or 0 = Partial and its signature count), the price message (84) and the posted slot.
 */
export function pythAccountErr(a: RemainingAccount): u32 {
  if (a.dataLen < 8n || readData<u64>(a, 0n) !== PRICE_UPDATE_V2_DISC) return 6060n;
  if (a.dataLen < 41n) return ERR_BORSH;
  const level = readData<u8>(a, 40n);
  if (level > 1n) return ERR_BORSH;
  return a.dataLen < (level === 1n ? 133n : 134n) ? ERR_BORSH : 0n;
}

/** SwitchboardPullPriceFeed::check_ais: the owner, then PullFeedAccountData::parse (discriminator, 3,200 bytes). */
function switchboardAccountErr(a: RemainingAccount): u32 {
  if (a.owner !== SWITCHBOARD_PULL_ID) return 6059n;
  if (a.dataLen < 3208n || readData<u64>(a, 0n) !== PULL_FEED_DISC) return 6061n;
  return 0n;
}

// ---- prices (PriceAdapter) --------------------------------------------------------------------------------------

/** pyth_price_components_to_i80f48: x scaled by 10^exponent (|exponent| of 24 or more panics, indexing EXP_10_I80F48). */
function pythScaled(x: i128, exponent: i32): Fx {
  const scale = exp10Fx(toU64(exponent < 0n ? -toI64(exponent) : toI64(exponent)));
  if (exponent === 0n) return { err: 0n, v: x };
  if (exponent < 0n) return fxTryDiv(x, scale);
  return fxTryMul(x, scale);
}

/** The feed's price, spot (RealTime) or EMA (TimeWeighted), without a bias. */
function rawPrice(f: Feed, realTime: boolean): Fx {
  if (f.kind === 3n) return pythScaled(fxFromI64(realTime ? f.price : f.ema_price), f.exponent);
  if (f.kind === 4n) return fxTryDiv(fxFromI128Wrapping(f.value), 281474976710656000000000000000000n);
  return { err: 0n, v: f.value };
}

/**
 * The confidence interval: Pyth's (2.12 × its confidence, failing past the bank's maximum or 10% of the price, then at
 * most 5%), Switchboard's (the configured share of the price, at most 5%; none when 0), none for a fixed price.
 */
function confidence(f: Feed, realTime: boolean, maxConfidence: u32): Fx {
  if (f.kind === 4n) {
    if (maxConfidence === 0n) return { err: 0n, v: 0n };
    const p = rawPrice(f, realTime);
    if (p.err !== 0n) return p;
    const scaled = fxTryMul(p.v, fxFromU64(toU64(maxConfidence)));
    if (scaled.err !== 0n) return scaled;
    const c = fxTryDiv(scaled.v, U32_MAX_FX);
    if (c.err !== 0n) return c;
    const cap = fxTryMul(p.v, MAX_CONF_INTERVAL);
    if (cap.err !== 0n) return cap;
    return { err: 0n, v: fxMin(c.v, cap.v) };
  }
  if (f.kind !== 3n) return { err: 0n, v: 0n };
  const raw = pythScaled(fxFromU64(realTime ? f.conf : f.ema_conf), f.exponent);
  if (raw.err !== 0n) return raw;
  const c = fxTryMul(raw.v, CONF_INTERVAL_MULTIPLE);
  if (c.err !== 0n) return c;
  const p = pythScaled(fxFromI64(realTime ? f.price : f.ema_price), f.exponent);
  if (p.err !== 0n) return p;
  const scaled = fxTryMul(p.v, fxFromU64(toU64(maxConfidence > 0n ? maxConfidence : DEFAULT_MAX_CONFIDENCE)));
  if (scaled.err !== 0n) return scaled;
  const max = fxTryDiv(scaled.v, U32_MAX_FX);
  if (max.err !== 0n) return max;
  if (c.v > max.v) return { err: 6055n, v: 0n };
  const cap = fxTryMul(p.v, MAX_CONF_INTERVAL);
  if (cap.err !== 0n) return cap;
  // assert!s in the original (a tiny negative price with no confidence reaches the first).
  require(cap.v >= 0n && c.v >= 0n, MarginfiError.InternalLogicError);
  return { err: 0n, v: fxMin(c.v, cap.v) };
}

/** PriceBias */
export const BIAS_NONE: u8 = 0n;
export const BIAS_LOW: u8 = 1n;
export const BIAS_HIGH: u8 = 2n;

/** get_price_of_type: the price, less (Low) or plus (High) the confidence interval. */
export function priceOfType(f: Feed, realTime: boolean, bias: u8, maxConfidence: u32): Fx {
  const p = rawPrice(f, realTime);
  if (p.err !== 0n || bias === BIAS_NONE || f.kind === 8n) return p;
  const c = confidence(f, realTime, maxConfidence);
  if (c.err !== 0n) return c;
  return bias === BIAS_LOW ? fxTrySub(p.v, c.v) : fxTryAdd(p.v, c.v);
}

/** get_price_and_confidence_of_type: the confidence interval first (it may fail), then the unbiased price. */
export function priceAndConfidence(f: Feed, realTime: boolean, maxConfidence: u32): PriceConf {
  const c = confidence(f, realTime, maxConfidence);
  if (c.err !== 0n) return { err: c.err, price: 0n, conf: 0n, source_time: 0n, mult: I80F48_ONE };
  const p = rawPrice(f, realTime);
  if (p.err !== 0n) return { err: p.err, price: 0n, conf: 0n, source_time: 0n, mult: I80F48_ONE };
  return { err: 0n, price: p.v, conf: c.v, source_time: f.source_time, mult: I80F48_ONE };
}
