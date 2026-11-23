// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs,
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// CureAndCancelClose (tag 42, `handle_cure_and_cancel_close` and the engine's `cure_and_cancel_close_not_atomic`),
// ForfeitRecoveryLeg (tag 43) and RebalanceReduce (tag 44): `handle_forfeit_recovery_leg` and `handle_rebalance_reduce`
// in `with_one_portfolio_view`, with `accrue_zero_move_funding_before_position_change_view`, the engine's
// `forfeit_recovery_leg_not_atomic` (recovery.ts) and `rebalance_reduce_position_not_atomic` (built from liquidation's
// reduction: liquidation.ts).
//
// Copies. The original reads the asset's oracle profile into a copy (`read_oracle_profile_from_view`, its refusals
// InvalidConfig), accrues on it and writes it back validated (`write_oracle_profile_to_view`, InvalidConfig); nothing in
// between reads the profile's bytes from the account and every failure fails the transaction, so the port accrues in
// place (trading.ts) and validates where the original writes.
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenProgram,
  type i128,
  type u64,
  type u128,
  loadRawAt,
  loadRawMutAt,
  programAt,
  require,
  i128 as toI128,
  u64 as toU64,
  u128 as toU128,
} from "typesol";
import {
  PercolatorError,
  V16_ARITHMETIC_OVERFLOW,
  V16_COUNTER_UNDERFLOW,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_NON_PROGRESS,
  V16_RECOVERY_REQUIRED,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type AssetOracleProfile,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type WrapperConfig,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  assetOracleProfileOk,
  dynamicSlotOffset,
  readPortfolioId,
  readPortfolioPositionEpoch,
} from "./state.js";
import { LIFECYCLE_ACTIVE, LIFECYCLE_DRAIN_ONLY, MAX_VAULT_TVL, engineSlotAt, marketShapeErr, validateWithMarket } from "./engine.js";
import { closeProgressErr, marketModeErr } from "./wire.js";
import { NO_SLOT, activeLegForAsset, domainAssetSide, insuranceDomainIndex, pendingDomainLossBarrierCount } from "./primitives.js";
import { absH, effectiveAbsQuantityForLeg, refreshAccountAndCertify } from "./health.js";
import { settleAccountSideEffects } from "./settlement.js";
import { settleNegativePnlFromPrincipal } from "./refresh.js";
import { assetSlot, barrierBlocks, beginZeroOiResidueResets, positionChangeTouchesBarrier, setPendingBarrierCount, signedPosition, validateBasisOrZero } from "./trade.js";
import { DECLARED, certifyAfterLocalSettlement, reducePosition, riskScore, validateProgress } from "./liquidation.js";

const I128_MAX_RX: u128 = 0x7fffffffffffffffffffffffffffffffn;
const U128_MAX_RX: u128 = 0xffffffffffffffffffffffffffffffffn;
import { accrueZeroMoveBeforePositionChange, bumpPositionEpoch } from "./trading.js";
import { forfeitRecoveryLeg } from "./recovery.js";
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
  rejectStaleLive,
  signerCheck,
  vaultAuthorityOf,
  verifyTokenProgramV16,
  verifyUserTokenAccount,
  verifyVaultTokenAccount,
  writableCheck,
  amountToU64,
} from "./program.js";

/**
 * `handle_forfeit_recovery_leg(portfolio_id, position_epoch, asset, b_delta_budget)`: a zero budget is
 * InvalidInstruction; accounts owner (signer), market (w), portfolio (w): `with_one_portfolio_view` (the owner signs,
 * the two writable and the program's, the market's config, the portfolio's storage, the market view, the portfolio's
 * id and position epoch: EngineProvenanceMismatch, its view, account id and owner: Unauthorized). Then a Live market
 * whose permissionless resolution has matured is LockActive; the asset's profile (an asset past the view or an invalid
 * profile InvalidConfig), its zero-move funding accrued as for a reducing change, the profile validated (InvalidConfig);
 * the engine's forfeit; the market's shape and the portfolio validated; the position epoch advanced.
 *
 * @noinline
 */
export function forfeitRecoveryLegHandler(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const budget = data.readU128(19n);
  require(budget !== 0n, PercolatorError.InvalidInstruction);
  const markets = onePortfolioView(rest, data, programId);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  liveResolveNotMatured(m);
  const asset = toU64(data.readU16(17n));
  accrueBeforeChange(m, markets, asset);
  forfeitRecoveryLeg(m, markets, pa, asset, budget);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, pa, markets);
  bumpPositionEpoch(pa);
}

/**
 * `with_one_portfolio_view(owner_must_sign, position binding)` up to its closure: accounts owner (signer), market (w),
 * portfolio (w); the owner signs, the two writable and the program's; the market's config; the portfolio's storage;
 * the market view; the portfolio's id and position epoch (EngineProvenanceMismatch); its view, account id and owner
 * (Unauthorized). Returns the view's slot count.
 */
function onePortfolioView(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): u64 {
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
  return markets;
}

/** A Live market whose permissionless resolution has matured at the market's authenticated slot: LockActive. */
function liveResolveNotMatured(m: RemainingAccount): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.mode === 0n && permissionlessStaleMatured(loadRawAt<WrapperConfig>(m, HEADER_LEN), authenticatedMarketSlot(h.current_slot))) failV16(V16_LOCK_ACTIVE);
}

/**
 * `accrue_zero_move_funding_before_position_change_view(cfg, group, asset, true)`: the asset's profile
 * (`read_oracle_profile_from_view(...).map_err(|_| InvalidConfig)`: past the view, or an invalid profile), its zero-move
 * funding accrued as for a reducing change, the profile written back validated (InvalidConfig).
 */
function accrueBeforeChange(m: RemainingAccount, markets: u64, asset: u64): void {
  if (asset >= markets) failV16(V16_INVALID_CONFIG);
  const at = dynamicSlotOffset(asset);
  if (!assetOracleProfileOk(loadRawAt<AssetOracleProfile>(m, at))) failV16(V16_INVALID_CONFIG);
  accrueZeroMoveBeforePositionChange(m, markets, at, asset, true);
  if (!assetOracleProfileOk(loadRawAt<AssetOracleProfile>(m, at))) failV16(V16_INVALID_CONFIG);
}

// ---- RebalanceReduce (tag 44) -----------------------------------------------------------------------------------------

/**
 * `rebalance_reduce_position_not_atomic(account, { asset, reduce_q })`: LockActive unless Live; InvalidConfig past the
 * configured slots or for nothing to reduce; the asset Active or DrainOnly (`require_asset_live_reducible`: LockActive);
 * the side effects settled (public B chunk; a chunk left is no refusal here); the account certified after local
 * settlement; the risk score before; the asset's active leg (InvalidLeg); the reduction within the unilateral capacity
 * (`kernel_reduce_position_delta`; nothing: NonProgress); a pending barrier that blocks the change LockActive; the
 * position reduced (a declaration under it is RecoveryRequired); the loss settled from principal; certified again; the
 * residue resets; NonProgress unless the score fell. Every refusal fails the transaction (no caller looks at one).
 */
function rebalanceReducePosition(m: RemainingAccount, markets: u64, pa: RemainingAccount, asset: u64, reduceQ: u128): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== 0n) failV16(V16_LOCK_ACTIVE);
  if (asset >= toU64(h.config.max_market_slots) || reduceQ === 0n) failV16(V16_INVALID_CONFIG);
  const life = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset.lifecycle;
  if (life !== LIFECYCLE_ACTIVE && life !== LIFECYCLE_DRAIN_ONLY) failV16(V16_LOCK_ACTIVE);
  settleAccountSideEffects(m, markets, pa, loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.public_b_chunk_atoms);
  certifyAfterLocalSettlement(m, markets, pa);
  const before = riskScore(pa);
  const slot = activeLegForAsset(pa, asset);
  if (slot === NO_SLOT) failV16(V16_INVALID_LEG);
  const leg = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slot);
  // unilateral_close_capacity(asset, leg): the asset decoded; the leg's effective quantity, at most both sides' OI.
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  let cap = effectiveAbsQuantityForLeg(a, leg);
  if (a.oi_eff_long_q < cap) cap = a.oi_eff_long_q;
  if (a.oi_eff_short_q < cap) cap = a.oi_eff_short_q;
  const budget = reduceQ < cap ? reduceQ : cap;
  const pre = absH(leg.basis_pos_q);
  const q = budget < pre ? budget : pre;
  if (q > I128_MAX_RX) failV16(V16_ARITHMETIC_OVERFLOW);
  const delta: i128 = leg.side === 1n ? toI128(q) : -toI128(q);
  if (q === 0n) failV16(V16_NON_PROGRESS);
  // position_delta_blocked_by_pending_domain_loss_barrier(account, asset, delta).
  const current = signedPosition(loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(activeLegForAsset(pa, asset)));
  const next = current + delta;
  validateBasisOrZero(next);
  if (barrierBlocks(positionChangeTouchesBarrier(m, markets, asset, current, next), current, next)) failV16(V16_LOCK_ACTIVE);
  if (reducePosition(m, markets, pa, asset, q) === DECLARED) failV16(V16_RECOVERY_REQUIRED);
  settleNegativePnlFromPrincipal(m, pa);
  certifyAfterLocalSettlement(m, markets, pa);
  beginZeroOiResidueResets(m, markets, asset);
  if (!validateProgress(before, pa)) failV16(V16_NON_PROGRESS);
}

/**
 * `handle_rebalance_reduce(portfolio_id, position_epoch, asset, reduce_q)`: a zero amount is InvalidInstruction;
 * `with_one_portfolio_view` as ForfeitRecoveryLeg's but without its closing shape and portfolio checks (the engine's
 * transition owns them); a Live market whose permissionless resolution has matured is LockActive; the asset's zero-move
 * funding accrued as for a reducing change (the profile read and written as above); the engine's reduction; the
 * position epoch advanced.
 *
 * @noinline
 */
export function rebalanceReduceHandler(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const reduceQ = data.readU128(19n);
  require(reduceQ !== 0n, PercolatorError.InvalidInstruction);
  const asset = toU64(data.readU16(17n));
  const markets = onePortfolioView(rest, data, programId);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  liveResolveNotMatured(m);
  accrueBeforeChange(m, markets, asset);
  rebalanceReducePosition(m, markets, pa, asset, reduceQ);
  bumpPositionEpoch(pa);
}

// ---- CureAndCancelClose (tag 42) --------------------------------------------------------------------------------------------

/**
 * `preflight_cure_and_cancel_close(account, deposit)`: the account validated with the market; LockActive unless the
 * close ledger (decoded) is active, unfinalized, uncanceled, without irreversible progress and with its whole gross loss
 * outstanding; the ledger's domain (checked) holding a barrier on its side (LockActive); the escrow plus the deposit, the
 * vault plus the deposit (ArithmeticOverflow; above MAX_VAULT_TVL InvalidConfig), the capital and c_tot plus the escrow
 * (ArithmeticOverflow).
 */
function cureAndCancelPreflight(m: RemainingAccount, markets: u64, pa: RemainingAccount, deposit: u128): void {
  validateWithMarket(m, pa, markets);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const c = p.close_progress;
  checkV16(closeProgressErr(c));
  const irreversible =
    c.support_consumed !== 0n ||
    c.junior_face_burned !== 0n ||
    c.insurance_spent !== 0n ||
    c.b_loss_booked !== 0n ||
    c.explicit_loss_assigned !== 0n ||
    c.quantity_adl_applied_q !== 0n ||
    c.drift_consumed !== 0n;
  if (c.active !== 1n || c.finalized === 1n || c.canceled === 1n || irreversible || c.residual_remaining !== c.gross_loss_at_close_start) failV16(V16_LOCK_ACTIVE);
  const domain = insuranceDomainIndex(m, markets, toU64(c.asset_index), c.domain_side === 1n);
  domainAssetSide(m, markets, domain);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(domain / 2n));
  const barrier = domain % 2n === 1n ? e.pending_domain_loss_barrier_short : e.pending_domain_loss_barrier_long;
  if (barrier === 0n) failV16(V16_LOCK_ACTIVE);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (p.cancel_deposit_escrow > U128_MAX_RX - deposit || h.vault > U128_MAX_RX - deposit) failV16(V16_ARITHMETIC_OVERFLOW);
  if (h.vault + deposit > MAX_VAULT_TVL) failV16(V16_INVALID_CONFIG);
  const escrow = p.cancel_deposit_escrow + deposit;
  if (p.capital > U128_MAX_RX - escrow || h.c_tot > U128_MAX_RX - escrow) failV16(V16_ARITHMETIC_OVERFLOW);
}

/**
 * `cure_and_cancel_close_not_atomic(account, deposit)`: the preflight; the account refreshed and certified
 * (`full_account_refresh_not_atomic`: no B chunk, so BStale is the refresh's own); the preflight again; the escrow and
 * deposit added to the vault, c_tot and the capital (ArithmeticOverflow); InvalidConfig unless the certified equity plus
 * the escrow covers the certified initial requirement; the escrow zeroed; the ledger's barrier released
 * (CounterUnderflow) and the legless asset's resets begun; the ledger canceled; the certificate invalidated; the account
 * validated with the market and the market's shape. The token-flow proof moves the deposit and the escrow into capital
 * with the vault raised by the deposit: its validation cannot refuse.
 */
function cureAndCancelClose(m: RemainingAccount, markets: u64, pa: RemainingAccount, deposit: u128): void {
  cureAndCancelPreflight(m, markets, pa, deposit);
  refreshAccountAndCertify(m, markets, pa);
  cureAndCancelPreflight(m, markets, pa, deposit);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  // The preflight just bounded every sum.
  const escrow = p.cancel_deposit_escrow + deposit;
  if (escrow > I128_MAX_RX) failV16(V16_ARITHMETIC_OVERFLOW);
  const cert = p.health_cert;
  const e = toI128(escrow);
  if (cert.certified_equity > 0n && cert.certified_equity > toI128(I128_MAX_RX) - e) failV16(V16_ARITHMETIC_OVERFLOW);
  const cured = cert.certified_equity + e;
  if (cured < 0n || toU128(cured) < cert.certified_initial_req) failV16(V16_INVALID_CONFIG);
  h.vault += deposit;
  h.c_tot += escrow;
  p.capital += escrow;
  p.cancel_deposit_escrow = 0n;
  const c = p.close_progress;
  const asset = toU64(c.asset_index);
  const short = c.domain_side === 1n;
  insuranceDomainIndex(m, markets, asset, short);
  const count = pendingDomainLossBarrierCount(m, markets, asset, short);
  if (count === 0n) failV16(V16_COUNTER_UNDERFLOW);
  setPendingBarrierCount(m, markets, asset, short, count - 1n);
  // begin_legless_asset_resets(asset).
  const a = loadRawAt<EngineAssetSlot>(m, assetSlot(m, markets, asset)).asset;
  if (a.stored_pos_count_long === 0n && a.stored_pos_count_short === 0n) beginZeroOiResidueResets(m, markets, asset);
  c.active = 0n;
  c.finalized = 0n;
  c.canceled = 1n;
  p.health_cert.valid = 0n;
  validateWithMarket(m, pa, markets);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `handle_cure_and_cancel_close(portfolio_id, position_epoch, deposit)`: accounts owner (signer), market (w), portfolio
 * (w), then for a deposit the source token account (w), the vault (w) and the token program. The owner signs; the two
 * writable and the program's; the market's config; the portfolio's storage; its id and position epoch
 * (EngineProvenanceMismatch). A deposit: the three accounts (NotEnoughAccountKeys), writable, SPL Token, the source the
 * owner's account of the collateral mint and the vault the canonical one, the amount within u64 and the balance
 * (InvalidTokenAccount). Then the market view; EngineLockActive unless Live; a matured stale window OracleStale; the
 * portfolio's view, account id and owner (Unauthorized); the engine's cure; the position epoch advanced; the SPL Token
 * Transfer of the deposit signed by the owner.
 *
 * @noinline
 */
export function cureAndCancelCloseHandler(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
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
  require(readPortfolioId(pa) === data.readU64(1n) && readPortfolioPositionEpoch(pa) === data.readU64(9n), PercolatorError.EngineProvenanceMismatch);
  const deposit = data.readU128(17n);
  let amount: u64 = 0n;
  if (deposit !== 0n) {
    needAccounts(rest, 6n);
    writableCheck(rest.get(3n));
    writableCheck(rest.get(4n));
    verifyTokenProgramV16(rest.get(5n));
    readMarketConfigMode(m);
    const mint = loadRawAt<WrapperConfig>(m, HEADER_LEN).collateral_mint;
    const authority = vaultAuthorityOf(m.key, programId);
    const balance = verifyUserTokenAccount(rest.get(3n), owner.key, mint);
    verifyVaultTokenAccount(rest.get(4n), authority, mint);
    amount = amountToU64(deposit);
    require(balance >= amount, PercolatorError.InvalidTokenAccount);
  }
  const markets = marketViewMut(m);
  require(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode === 0n, PercolatorError.EngineLockActive);
  rejectStaleLive(m);
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === owner.key, PercolatorError.Unauthorized);
  cureAndCancelClose(m, markets, pa, deposit);
  bumpPositionEpoch(pa);
  if (deposit !== 0n) programAt<TokenProgram>(rest.get(5n)).transfer(rest.get(3n), rest.get(4n), owner, amount);
}
