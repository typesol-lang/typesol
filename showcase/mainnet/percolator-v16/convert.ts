// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs and
// aeyakovenko/percolator src/v16.rs, Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// ConvertReleasedPnl (tag 28): `handle_convert_released_pnl` in `with_one_portfolio_view` (owner signer, position
// binding, post-validation, the position epoch advanced), `reject_lapsed_source_backing_for_conversion_view`, and the
// engine's `convert_released_pnl_to_capital_not_atomic` (`preflight_convert_released_pnl_to_capital`,
// `ensure_favorable_action_allowed`, `convert_released_pnl_to_capital_core_not_atomic`,
// `apply_released_pnl_conversion_core_not_atomic`, `apply_released_pnl_conversion_with_consumption_core_not_atomic`
// with `kernel_released_pnl_conversion_partition` and `TokenValueFlowProofV16::support_to_account_capital`).
//
// Errors. Inside the handler's closure every error is a V16Error the wrapper maps (`map_v16_error`): the conversion's
// writes are made in place and a refusal after them (a result of 0 or above the caller's cap: LockActive) fails the
// transaction, as the original's comment says it means to ("staging the conversion and only committing it when the
// converted amount fits"). No error on these paths is swallowed after a write; the one `.is_ok()` (a source domain
// that `domain_asset_side` refuses is not an exposure) only reads.
import { type InstructionBytes, type Pubkey, type RemainingAccount, type RemainingAccounts, type i128, type u8, type u64, type u128, loadRawAt, loadRawMutAt, require, i128 as toI128, u64 as toU64, u128 as toU128 } from "typesol";
import { PercolatorError, V16_ARITHMETIC_OVERFLOW, V16_COUNTER_UNDERFLOW, V16_HIDDEN_LEG, V16_INVALID_CONFIG, V16_LOCK_ACTIVE, V16_STALE, checkV16, failV16 } from "./errors.js";
import { type EngineAssetSlot, type GroupHeader, type Portfolio, type WrapperConfig, HEADER_LEN, MARKET_GROUP_OFF, readPortfolioId, readPortfolioPositionEpoch } from "./state.js";
import { V16_MAX_PORTFOLIO_ASSETS_N, backingBucketErr, boolErr, marketModeErr } from "./wire.js";
import { PORTFOLIO_SOURCE_DOMAIN_CAP, engineSlotAt, legErr, marketShapeErr, validateWithMarket } from "./engine.js";
import { haircutEffectiveSupport } from "./kernels.js";
import { accountHasSourceClaims, domainHasDefaultTag, domainIsOccupied, faceClaimToBurnForSupport, juniorClaimBound, residual } from "./primitives.js";
import { consumeValidatedAccountSourceCredit, setAccountPnlAfterSourceClaimBurn } from "./claims.js";
import { accountHLockMax, accountSourceRealizableSupport, assetHasTargetLag, certCurrentErr } from "./health.js";
import { bumpPositionEpoch } from "./trading.js";
import {
  authenticatedMarketSlot,
  ensurePortfolioStorage,
  expectPortfolioAccountKey,
  marketViewMut,
  needAccounts,
  ownerCheck,
  permissionlessStaleMatured,
  portfolioViewMut,
  readMarketConfigMode,
  signerCheck,
  writableCheck,
} from "./program.js";

const U128_MAX_CV: u128 = 0xffffffffffffffffffffffffffffffffn;
const I128_MAX_CV: u128 = 0x7fffffffffffffffffffffffffffffffn;
/** `BackingBucketStatusV16::Fresh`. */
const BUCKET_FRESH_CV: u8 = 1n;

/**
 * `reject_lapsed_source_backing_for_conversion_view(group, portfolio, slot)`: the configured slots within the view
 * (InvalidConfig); each occupied source domain with a claim on a configured asset (InvalidConfig otherwise) whose bucket
 * (decoded) is Fresh and lapsed at the slot is Stale.
 */
function rejectLapsedBacking(m: RemainingAccount, markets: u64, pa: RemainingAccount, slot: u64): void {
  const configured = toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots);
  if (configured > markets) failV16(V16_INVALID_CONFIG);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let i = 0n; i < PORTFOLIO_SOURCE_DOMAIN_CAP; i++) {
    const s = p.source_domains.get(i);
    if (!domainIsOccupied(s) || s.source_claim_bound_num === 0n) continue;
    const d = toU64(s.domain);
    if (d / 2n >= configured) failV16(V16_INVALID_CONFIG);
    const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(d / 2n));
    const b = d % 2n === 0n ? e.backing_long : e.backing_short;
    checkV16(backingBucketErr(b));
    if (b.status === BUCKET_FRESH_CV && b.expiry_slot <= slot) failV16(V16_STALE);
  }
}

/** `account_has_source_liens(account)`: a liened claim before the compacted tail. */
export function hasSourceLiens(pa: RemainingAccount): boolean {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let i = 0n; i < PORTFOLIO_SOURCE_DOMAIN_CAP; i++) {
    const s = p.source_domains.get(i);
    if (domainHasDefaultTag(s) && !domainIsOccupied(s)) break;
    if (s.source_claim_liened_num !== 0n) return true;
  }
  return false;
}

/**
 * `account_has_active_source_claim_exposure(account)`: a domain with a claim, on a configured asset in the view
 * (`domain_asset_side(d).is_ok()`), whose asset the portfolio holds an active leg of on the side opposite the domain's
 * (`account_has_active_exposure_for_source_domain`: the asset's active leg, `active_leg_for_asset`, decoded).
 */
export function hasActiveSourceClaimExposure(m: RemainingAccount, markets: u64, pa: RemainingAccount): boolean {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let i = 0n; i < PORTFOLIO_SOURCE_DOMAIN_CAP; i++) {
    const s = p.source_domains.get(i);
    const occupied = domainIsOccupied(s);
    if (domainHasDefaultTag(s) && !occupied) break;
    if (!occupied || s.source_claim_bound_num === 0n) continue;
    const d = toU64(s.domain);
    if (d >= 2n * toU64(h.config.max_market_slots) || d / 2n >= markets) continue;
    // active_leg_for_asset: over the bitmap's slots, each leg decoded and active (HiddenLeg), at most one of the asset.
    const asset = d / 2n;
    const bitmap = p.active_bitmap.get(0n);
    let found = 16n;
    for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
      if (((bitmap >> slot) & 1n) === 0n) continue;
      const leg = p.legs.get(slot);
      checkV16(legErr(leg));
      if (leg.active !== 1n) failV16(V16_HIDDEN_LEG);
      if (toU64(leg.asset_index) === asset) {
        if (found !== 16n) failV16(V16_HIDDEN_LEG);
        found = slot;
      }
    }
    // The leg is active and its opposite side is the domain's (the domain's parity: 0 long, 1 short).
    if (found !== 16n && (p.legs.get(found).side === 1n) !== (d % 2n === 1n)) return true;
  }
  return false;
}

/**
 * `ensure_favorable_action_allowed(account)`: validated with the market; the H-lock lane HMax is LockActive; the
 * certificate current (Stale); an active leg on an asset with a target-effective lag is LockActive.
 */
function ensureFavorableActionAllowed(m: RemainingAccount, markets: u64, pa: RemainingAccount): void {
  validateWithMarket(m, pa, markets);
  if (accountHLockMax(m, markets, pa)) failV16(V16_LOCK_ACTIVE);
  checkV16(certCurrentErr(m, pa));
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    if (leg.active === 1n && assetHasTargetLag(m, markets, toU64(leg.asset_index))) failV16(V16_LOCK_ACTIVE);
  }
}

/**
 * The engine's `convert_released_pnl_to_capital_not_atomic(account)` with `ConsumeHaircutFace`: the preflight (Live and
 * no payout snapshot, each decoded: LockActive; the favorable action allowed); the released PnL (the positive PnL above
 * the reserved; none converts nothing); with source claims, LockActive for a liened claim or an active exposure, and
 * what the claims realize; without them, nothing on a Live market (else the haircut support); none is LockActive; the
 * claims' credit consumed and burned (or, without claims, the face the support burns), the partition, the PnL lowered
 * with the burned claims, the capital and c_tot raised (ArithmeticOverflow), the matured positive total lowered
 * (saturating), the token-flow proof, the certificate invalidated; the market's shape and the portfolio validated.
 * Returns the amount converted.
 */
export function convertReleasedPnl(m: RemainingAccount, markets: u64, pa: RemainingAccount): u128 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== 0n) failV16(V16_LOCK_ACTIVE);
  checkV16(boolErr(h.payout_snapshot_captured));
  if (h.payout_snapshot_captured === 1n) failV16(V16_LOCK_ACTIVE);
  ensureFavorableActionAllowed(m, markets, pa);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const pos: u128 = p.pnl > 0n ? toU128(p.pnl) : 0n;
  const released = pos > p.reserved_pnl ? pos - p.reserved_pnl : 0n;
  if (released === 0n) return 0n;
  const claims = accountHasSourceClaims(pa);
  if (claims && (hasSourceLiens(pa) || hasActiveSourceClaimExposure(m, markets, pa))) failV16(V16_LOCK_ACTIVE);
  let converted: u128 = 0n;
  if (claims) converted = accountSourceRealizableSupport(m, markets, pa, released);
  else {
    checkV16(marketModeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode));
    if (loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode !== 0n) converted = haircutEffectiveSupport(released, residual(m), juniorClaimBound(m));
  }
  if (converted === 0n) failV16(V16_LOCK_ACTIVE);
  // apply_released_pnl_conversion_core_not_atomic.
  let faceBurn: u128 = 0n;
  let cp: u128 = 0n;
  let ins: u128 = 0n;
  let preburned: u128 = 0n;
  if (claims) {
    const c = consumeValidatedAccountSourceCredit(m, markets, pa, converted, true, true);
    faceBurn = c.face_burn;
    cp = c.counterparty_credit_consumed;
    ins = c.insurance_credit_consumed;
    preburned = c.burned_num;
  } else faceBurn = faceClaimToBurnForSupport(converted, residual(m), juniorClaimBound(m));
  // apply_released_pnl_conversion_with_consumption_core_not_atomic.
  const reserved = loadRawAt<Portfolio>(pa, HEADER_LEN).reserved_pnl;
  if (converted > (pos > reserved ? pos - reserved : 0n)) failV16(V16_INVALID_CONFIG);
  // kernel_released_pnl_conversion_partition(pos, converted, face_burn, false): the PnL debit is the face burned.
  if (converted > faceBurn || faceBurn > pos) failV16(V16_INVALID_CONFIG);
  if (faceBurn > I128_MAX_CV) failV16(V16_ARITHMETIC_OVERFLOW);
  const pnl = loadRawAt<Portfolio>(pa, HEADER_LEN).pnl;
  // pnl ≥ face burned ≥ 0 here (the burn is at most the positive PnL): the difference cannot leave i128.
  const newPnl: i128 = pnl - toI128(faceBurn);
  setAccountPnlAfterSourceClaimBurn(m, markets, pa, newPnl, preburned);
  const pm = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  if (pm.capital > U128_MAX_CV - converted) failV16(V16_ARITHMETIC_OVERFLOW);
  pm.capital += converted;
  const hm = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (hm.c_tot > U128_MAX_CV - converted) failV16(V16_ARITHMETIC_OVERFLOW);
  hm.c_tot += converted;
  hm.pnl_matured_pos_tot = hm.pnl_matured_pos_tot > faceBurn ? hm.pnl_matured_pos_tot - faceBurn : 0n;
  // The protocol surplus consumed (CounterUnderflow); the proof's sources then sum to the capital credited and its
  // credits and debit balance at an unchanged vault: its validation cannot refuse.
  if (converted < cp || converted - cp < ins) failV16(V16_COUNTER_UNDERFLOW);
  pm.health_cert.valid = 0n;
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, pa, markets);
  return converted;
}

/**
 * `handle_convert_released_pnl(portfolio_id, position_epoch, amount)`: a zero amount is InvalidInstruction; accounts
 * owner (signer), market (w), portfolio (w): the owner signs, the two writable and the program's; the market's config;
 * the portfolio's storage; the market view; the portfolio's id and position epoch (EngineProvenanceMismatch); its view,
 * account id and owner (Unauthorized). Then on a Live market whose permissionless resolution has not matured
 * (LockActive each), lapsed backing refused, the engine's conversion, a result of 0 or above the amount LockActive; the
 * market's shape and the portfolio validated; the position epoch advanced.
 *
 * @noinline
 */
export function convertReleasedPnlHandler(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const amount = data.readU128(17n);
  require(amount !== 0n, PercolatorError.InvalidInstruction);
  needAccounts(rest, 3n);
  const owner = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  signerCheck(owner);
  writableCheck(m);
  writableCheck(pa);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  readMarketConfigMode(m);
  ensurePortfolioStorage(pa);
  const markets = marketViewMut(m);
  const id = readPortfolioId(pa);
  const epoch = readPortfolioPositionEpoch(pa);
  require(id === data.readU64(1n) && epoch === data.readU64(9n), PercolatorError.EngineProvenanceMismatch);
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === owner.key, PercolatorError.Unauthorized);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.mode !== 0n) failV16(V16_LOCK_ACTIVE);
  const now = authenticatedMarketSlot(h.current_slot);
  if (permissionlessStaleMatured(loadRawAt<WrapperConfig>(m, HEADER_LEN), now)) failV16(V16_LOCK_ACTIVE);
  rejectLapsedBacking(m, markets, pa, now);
  const converted = convertReleasedPnl(m, markets, pa);
  if (converted === 0n || converted > amount) failV16(V16_LOCK_ACTIVE);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, pa, markets);
  bumpPositionEpoch(pa);
}

