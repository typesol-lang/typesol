// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs and
// aeyakovenko/percolator src/v16.rs, Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL. Ported here: the insurance and
// backing-bucket handlers (`handle_top_up_insurance` for TopUpInsurance and TopUpInsuranceDomain,
// `handle_top_up_backing_bucket`, `handle_withdraw_backing_bucket`, `handle_withdraw_backing_bucket_earnings`,
// `handle_withdraw_insurance_asset`) with `verify_domain_withdrawal_preflight`, `read_or_new_*_ledger`,
// `live_domain_withdraw_health_or_shutdown_view` and the views they read; and the engine functions they reach
// (`deposit_fresh_counterparty_backing_not_atomic`, `withdraw_fresh_counterparty_backing_not_atomic`,
// `withdraw_resolved_counterparty_backing_surplus_not_atomic`, `withdraw_backing_provider_earnings_not_atomic`,
// `withdraw_domain_insurance_not_atomic`, `recredit_terminal_claim_free_residual_for_asset_not_atomic` and their
// helpers). CloseSlab's terminal scan (terminal.ts) reuses the recredit.
//
// Each handler is the original's, check for check in its order; the arguments are read at fixed offsets after decode
// has checked the length.
//
// Two borrows, one view. The original takes the market view twice in each top-up (a preflight block, then the
// mutation block after the token accounts are verified) and repeats in the second block checks the first made (the
// mode, the asset generation, the authority epoch, the authority). Nothing between the blocks writes the market, so
// the repeated checks pass and the port makes them once; what only the second block checks
// (`reject_permissionless_resolve_matured_live_view`, the authority read again from the view) it makes where the
// original does.
//
// The ledgers. The original reads the optional ledger into a copy (`read_or_new_*_ledger`: InvalidAccountLen,
// InvalidAccountData for a nonzero uninitialized account, the header, the validation, Unauthorized for another market,
// authority or domain), syncs it, changes it with the engine call between, and writes it (`write_or_init_*_ledger`,
// which validates it: both keys set) after the market's shape. The port changes the ledger in place where the
// original changes its copy; every error after the first change fails the transaction, so the bytes are the same. The
// one check the write makes that the read did not is the new ledger's authority: a ledger created for a zero
// authority (the admin's shutdown drain with no backing or insurance authority set) is refused there with
// InvalidAccountData, which the port checks at the same point.
//
// Repeated accounts. The original borrows the ledger's data mutably while it holds the market's: the market passed
// as the ledger fails that borrow (AccountBorrowFailed), checked by key at the same point. Every other account is
// owner-checked (the token accounts by SPL Token, the ledger by this program) before its data is read.
import {
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenProgram,
  type u64,
  type u128,
  ProgramError,
  findProgramAddressWithBump,
  loadRawAt,
  loadRawMutAt,
  programAt,
  readData,
  require,
  u8 as toU8,
  u16 as toU16,
  u64 as toU64,
} from "typesol";
import { PercolatorError, V16_ARITHMETIC_OVERFLOW, V16_COUNTER_UNDERFLOW, V16_INVALID_CONFIG, V16_LOCK_ACTIVE, V16_RECOVERY_REQUIRED, V16_STALE, checkV16, failV16 } from "./errors.js";
import {
  type AccountHeader,
  type AssetControlSequences,
  type AssetOracleProfile,
  type BackingBucket,
  type BackingDomainLedger,
  type EngineAssetSlot,
  type GroupHeader,
  type InsuranceCreditReservation,
  type InsuranceLedger,
  type SourceCreditState,
  type WrapperConfig,
  BACKING_DOMAIN_LEDGER_ACCOUNT_LEN,
  HEADER_LEN,
  INSURANCE_LEDGER_ACCOUNT_LEN,
  KIND_BACKING_DOMAIN_LEDGER,
  KIND_INSURANCE_LEDGER,
  MARKET_GROUP_OFF,
  ZERO_KEY,
  assetOracleProfileOk,
  assetSlotAt,
  backingDomainLedgerAt,
  dynamicSlotOffset,
  insuranceLedgerAt,
  isInitialized,
  validateBackingDomainLedger,
  validateInsuranceLedger,
  writeHeaderView,
} from "./state.js";
import { BOUND_SCALE, marketModeErr, optionalRecoveryReasonErr, resolvedPayoutLedgerErr } from "./wire.js";
import {
  LIFECYCLE_ACTIVE,
  LIFECYCLE_DRAIN_ONLY,
  LIFECYCLE_RECOVERY,
  amountFromBoundNum,
  domainInsuranceBudgetRemaining,
  engineSlotAt,
  marketShapeErr,
} from "./engine.js";
import { boundNumFromAmount, recomputeSourceCreditForEpoch } from "./kernels.js";
import {
  addFreshCounterpartyBacking,
  adjustProviderPrincipal,
  applyTotalDelta,
  bucketAt,
  bucketForDomain,
  domainAssetSide,
  domainBudgetRemainingParts,
  domainInsuranceBudgetSpent,
  encumbranceProofForParts,
  insuranceDomainIndex,
  providerPrincipal,
  releaseProviderPrincipalAfter,
  reservationForDomain,
  residual,
  setDomainInsuranceSpent,
  setSourceCreditTotals,
  sourceAt,
  sourceForDomain,
  sourceTotalsAt,
  validateDomainLedger,
} from "./primitives.js";
import { availableBacking } from "./claims.js";
import { availableDomainInsurance } from "./liquidation.js";
import { resolvedPositivePayoutReady } from "./resolved.js";
import { depositDomainInsurance } from "./lifecycle.js";
import { assetHasPositionOrLossState } from "./oracle.js";
import { allZero, syncBacking } from "./policy.js";
import { verifyWithdrawable } from "./custody.js";
import {
  amountToU64,
  authenticatedMarketSlot,
  backingDomainPartsCheck,
  backingUnavailableAtoms,
  controlsFromView,
  keyCheck,
  liveAuthorityMatches,
  marketViewMut,
  needAccounts,
  ownerCheck,
  profileFromView,
  readAssetOracleProfileState,
  readMarketConfigMode,
  readMarketTradePreflight,
  rejectStaleLive,
  requireAssetGeneration,
  requireAuthorityEpoch,
  advanceAuthorityEpoch,
  signerCheck,
  vaultAuthorityOf,
  verifyTokenProgramV16,
  verifyUserTokenAccount,
  verifyVaultTokenAccount,
  writableCheck,
} from "./program.js";

const U128_MAX_RV: u128 = 0xffffffffffffffffffffffffffffffffn;
const MODE_LIVE_RV = 0n;
const MODE_RESOLVED_RV = 1n;
const BUCKET_EMPTY_RV = 0n;
const BUCKET_FRESH_RV = 1n;
const BUCKET_EXPIRED_RV = 2n;
const BUCKET_IMPAIRED_RV = 3n;

// ---- Views of the processor ------------------------------------------------------------------------------------------

/**
 * `require_domain_accepts_live_topup_view(group, domain)`: the domain configured and its asset in the view
 * (InvalidInstruction); the asset Active, DrainOnly or in Recovery (EngineLockActive otherwise).
 */
function requireDomainAcceptsTopup(m: RemainingAccount, markets: u64, domain: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const asset = domain / 2n;
  require(domain < 2n * toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  const lifecycle = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle;
  require(lifecycle === LIFECYCLE_ACTIVE || lifecycle === LIFECYCLE_DRAIN_ONLY || lifecycle === LIFECYCLE_RECOVERY, PercolatorError.EngineLockActive);
}

/** `domain_authorities_from_view(group, cfg, domain)`: the domain configured and its asset in the view
 * (InvalidInstruction), then the asset's profile read from the view (validated). Returns the profile's offset. */
function authoritiesFromView(m: RemainingAccount, markets: u64, domain: u64): u64 {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(domain < 2n * toU64(h.config.max_market_slots) && domain / 2n < markets, PercolatorError.InvalidInstruction);
  return profileFromView(m, markets, domain / 2n);
}

/** `market_insurance_remaining_view(group, asset)`: both domains' remaining budgets (ArithmeticOverflow), at most the
 * market's insurance. */
function marketInsuranceRemaining(m: RemainingAccount, markets: u64, asset: u64): u128 {
  const long = domainInsuranceBudgetRemaining(m, markets, asset * 2n);
  const short = domainInsuranceBudgetRemaining(m, markets, asset * 2n + 1n);
  require(long <= U128_MAX_RV - short, PercolatorError.EngineArithmeticOverflow);
  const insurance = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).insurance;
  return long + short < insurance ? long + short : insurance;
}

/** `domain_insurance_withdraw_capacity(domain)`: the domain, its available insurance, at most the vault. */
function domainWithdrawCapacity(m: RemainingAccount, markets: u64, domain: u64): u128 {
  domainAssetSide(m, markets, domain);
  const available = availableDomainInsurance(m, markets, domain);
  const vault = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).vault;
  return available < vault ? available : vault;
}

/** `market_insurance_withdraw_capacity_view(group, asset)`: both domains' capacities (ArithmeticOverflow), at most the
 * insurance not reserved for source credit (saturating) and the vault. */
function marketWithdrawCapacity(m: RemainingAccount, markets: u64, asset: u64): u128 {
  const long = domainWithdrawCapacity(m, markets, asset * 2n);
  const short = domainWithdrawCapacity(m, markets, asset * 2n + 1n);
  require(long <= U128_MAX_RV - short, PercolatorError.EngineArithmeticOverflow);
  let capacity = long + short;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const global = h.insurance > h.source_insurance_credit_reserved_total_atoms ? h.insurance - h.source_insurance_credit_reserved_total_atoms : 0n;
  if (global < capacity) capacity = global;
  return h.vault < capacity ? h.vault : capacity;
}

/**
 * `shutdown_asset_empty_and_matured_now_view(cfg, group, asset).is_ok()`: a Live market, an asset other than 0 with a
 * force-close delay, configured and in the view, in Recovery, whose profile's last good oracle slot is set, not after
 * the authenticated slot and at least the delay behind it, with no position or loss state.
 */
function shutdownEmptyAndMatured(m: RemainingAccount, markets: u64, asset: u64): boolean {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  if (h.mode !== MODE_LIVE_RV || asset === 0n || cfg.force_close_delay_slots === 0n || asset >= toU64(h.config.max_market_slots) || asset >= markets) return false;
  if (loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset.lifecycle !== LIFECYCLE_RECOVERY) return false;
  // read_oracle_profile_from_view: its validation's refusal is an Err, which `is_ok()` turns into false.
  const now = authenticatedMarketSlot(h.current_slot);
  const profile = loadRawAt<AssetOracleProfile>(m, dynamicSlotOffset(asset));
  if (!assetOracleProfileOk(profile)) return false;
  const shutdown = profile.last_good_oracle_slot;
  if (shutdown === 0n || now < shutdown || now - shutdown < cfg.force_close_delay_slots) return false;
  return !assetHasPositionOrLossState(m, markets, asset);
}

/**
 * `live_domain_withdraw_health_or_shutdown_view(cfg, group, domain)`: true for an empty matured shutdown asset;
 * otherwise the stale window (OracleStale), then any live loss state refused with EngineLockActive (negative PnL
 * accounts, the domain's barrier, threshold stress, a loss-stale market, a recorded Recovery reason, decoded first:
 * map_v16_error), the asset's own unsettled loss state, and an exposed asset whose target leads its effective price.
 */
function liveWithdrawHealthOrShutdown(m: RemainingAccount, markets: u64, domain: u64): boolean {
  const asset = domain / 2n;
  if (shutdownEmptyAndMatured(m, markets, asset)) return true;
  rejectStaleLive(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  // group.markets[asset]: the caller has bounded the asset by the configured count, which the view's count is not below.
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const barrier = domain % 2n === 0n ? e.pending_domain_loss_barrier_long : e.pending_domain_loss_barrier_short;
  checkV16(optionalRecoveryReasonErr(h.recovery_reason));
  const recovery = h.recovery_reason.present === 1n;
  require(
    !(h.negative_pnl_account_count !== 0n || barrier !== 0n || h.threshold_stress_active !== 0n || h.loss_stale_active !== 0n || recovery),
    PercolatorError.EngineLockActive,
  );
  // asset_local_loss_stale_view.
  const a = e.asset;
  let lossStale = a.stale_account_count_long !== 0n || a.stale_account_count_short !== 0n;
  if (!lossStale && (a.lifecycle === LIFECYCLE_ACTIVE || a.lifecycle === LIFECYCLE_DRAIN_ONLY) && a.slot_last < h.current_slot)
    lossStale = assetHasPositionOrLossState(m, markets, asset);
  require(!lossStale, PercolatorError.EngineLockActive);
  // reject_exposed_target_effective_lag_view (the asset is in the view: no InvalidInstruction).
  const exposed = a.oi_eff_long_q !== 0n || a.oi_eff_short_q !== 0n;
  require(!(exposed && a.raw_oracle_target_price !== a.effective_price), PercolatorError.EngineLockActive);
  return false;
}

// ---- The ledgers -------------------------------------------------------------------------------------------------------

/**
 * `read_or_new_insurance_ledger(data, market, authority, observed)` then `sync_insurance_ledger(observed)`, in place:
 * the length (InvalidAccountLen); an initialized ledger read (the header, the validation) and bound to this market and
 * authority (Unauthorized), synced; an uninitialized one all zero (InvalidAccountData) and created (its observation the
 * insurance now: the sync adds nothing). Returns whether it was created (the write's validation of a new ledger's
 * authority is the caller's, after the engine call).
 */
function insuranceLedgerSynced(la: RemainingAccount, m: RemainingAccount, authority: Pubkey, observed: u128): boolean {
  require(la.dataLen === INSURANCE_LEDGER_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  if (isInitialized(la)) {
    const l = loadRawMutAt<InsuranceLedger>(la, insuranceLedgerAt(la));
    validateInsuranceLedger(l);
    require(l.market_group === m.key && l.authority === authority, PercolatorError.Unauthorized);
    if (observed >= l.last_observed_insurance_atoms) {
      const delta = observed - l.last_observed_insurance_atoms;
      require(l.cumulative_profit_atoms <= U128_MAX_RV - delta, PercolatorError.EngineArithmeticOverflow);
      l.cumulative_profit_atoms += delta;
    } else {
      const delta = l.last_observed_insurance_atoms - observed;
      require(l.cumulative_loss_atoms <= U128_MAX_RV - delta, PercolatorError.EngineArithmeticOverflow);
      l.cumulative_loss_atoms += delta;
    }
    l.last_observed_insurance_atoms = observed;
    return false;
  }
  require(allZero(la, INSURANCE_LEDGER_ACCOUNT_LEN), ProgramError.InvalidAccountData);
  const header = loadRawMutAt<AccountHeader>(la, 0n);
  writeHeaderView(header, KIND_INSURANCE_LEDGER);
  const l = loadRawMutAt<InsuranceLedger>(la, HEADER_LEN);
  l.market_group = m.key;
  l.authority = authority;
  l.last_observed_insurance_atoms = observed;
  return true;
}

/**
 * `read_or_new_backing_domain_ledger(data, market, authority, domain, bucket)` then `sync_backing_domain_ledger`, in
 * place (as the insurance ledger's, bound also to the domain). Returns whether it was created.
 */
function backingLedgerSynced(la: RemainingAccount, m: RemainingAccount, authority: Pubkey, domain: u64, b: BackingBucket): boolean {
  require(la.dataLen === BACKING_DOMAIN_LEDGER_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  if (isInitialized(la)) {
    const l = loadRawMutAt<BackingDomainLedger>(la, backingDomainLedgerAt(la));
    validateBackingDomainLedger(l);
    require(l.market_group === m.key && l.authority === authority && toU64(l.domain) === domain, PercolatorError.Unauthorized);
    syncBacking(l, b.utilization_fee_earnings, b);
    return false;
  }
  require(allZero(la, BACKING_DOMAIN_LEDGER_ACCOUNT_LEN), ProgramError.InvalidAccountData);
  const unavailable = backingUnavailableAtoms(b);
  const header = loadRawMutAt<AccountHeader>(la, 0n);
  writeHeaderView(header, KIND_BACKING_DOMAIN_LEDGER);
  const l = loadRawMutAt<BackingDomainLedger>(la, HEADER_LEN);
  l.market_group = m.key;
  l.authority = authority;
  l.last_observed_bucket_earnings_atoms = b.utilization_fee_earnings;
  l.last_observed_unavailable_principal_atoms = unavailable;
  l.domain = toU16(domain);
  return true;
}

// ---- TopUpInsurance (tag 9) and TopUpInsuranceDomain (tag 56) ------------------------------------------------------

/**
 * `handle_top_up_insurance(scope, market_id, intent_id, authority_epoch, amount)`: accounts signer, market (w), source
 * token account (w), vault (w), token program, optionally an insurance ledger (w, the program's). The signer signs; the
 * market, the token accounts and the ledger writable; the market and the ledger the program's; SPL Token. Under the
 * market view: Live (TopUpInsurance: EngineLockActive; TopUpInsuranceDomain: InvalidInstruction, with the domain
 * configured, then the domain accepting top-ups); the asset (0, or the domain's) configured, its generation and
 * authority epoch, its insurance top-up sequence older than the intent (EngineStale), its profile; its insurance
 * authority signs; the source the signer's of the primary mint and the vault canonical; the amount within u64 and the
 * source's balance. Then the stale window (OracleStale), the domain again, the authority read from the view again, the
 * insurance observed (both domains' remaining budgets, or the domain's), the ledger synced, the deposit (half and half
 * into asset 0's domains, or into the domain), the ledger's principal, deposits and observation raised, the shape, the
 * sequence advanced, and the SPL Token Transfer from the source (none for 0).
 *
 * @noinline
 */
export function topUpInsurance(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey, scoped: boolean): void {
  needAccounts(rest, 5n);
  const signer = rest.get(0n);
  const m = rest.get(1n);
  const source = rest.get(2n);
  const vault = rest.get(3n);
  const tokenProgram = rest.get(4n);
  const ledgered = rest.length > 5n;
  signerCheck(signer);
  writableCheck(m);
  writableCheck(source);
  writableCheck(vault);
  ownerCheck(m, programId);
  if (ledgered) {
    writableCheck(rest.get(5n));
    ownerCheck(rest.get(5n), programId);
  }
  verifyTokenProgramV16(tokenProgram);
  const at = scoped ? 3n : 1n;
  const domain = scoped ? toU64(data.readU16(1n)) : 0n;
  const expectedMarketId = data.readU64(at);
  const intent = data.readU64(at + 8n);
  const expectedEpoch = data.readU64(at + 16n);
  const amount = data.readU128(at + 24n);
  const asset = domain / 2n;
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const configured = toU64(h.config.max_market_slots);
  if (scoped) {
    require(!(h.mode !== MODE_LIVE_RV || domain >= 2n * configured || asset >= configured), PercolatorError.InvalidInstruction);
    requireDomainAcceptsTopup(m, markets, domain);
  } else require(h.mode === MODE_LIVE_RV, PercolatorError.EngineLockActive);
  require(asset < configured, PercolatorError.InvalidInstruction);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  requireAuthorityEpoch(m, markets, asset, expectedEpoch);
  const controls = loadRawMutAt<AssetControlSequences>(m, controlsFromView(m, markets, asset));
  require(intent > controls.insurance_top_up, PercolatorError.EngineStale);
  const insuranceAuthority = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, asset)).insurance_authority;
  require(liveAuthorityMatches(insuranceAuthority, signer.key), PercolatorError.Unauthorized);
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const balance = verifyUserTokenAccount(source, signer.key, cfg.collateral_mint);
  verifyVaultTokenAccount(vault, vaultAuthorityOf(m.key, programId), cfg.collateral_mint);
  const amount64 = amountToU64(amount);
  require(balance >= amount64, PercolatorError.InvalidTokenAccount);
  // The second block: Live, the generation and the epoch again (they pass: nothing wrote the market).
  rejectStaleLive(m);
  if (scoped) requireDomainAcceptsTopup(m, markets, domain);
  // domain_authorities_from_view(scope.authority_domain()): the same profile, the same authority (it passed).
  authoritiesFromView(m, markets, domain);
  const observed = scoped ? domainInsuranceBudgetRemaining(m, markets, domain) : marketInsuranceRemaining(m, markets, asset);
  let created = false;
  if (ledgered) {
    const la = rest.get(5n);
    require(la.key !== m.key, ProgramError.AccountBorrowFailed);
    created = insuranceLedgerSynced(la, m, insuranceAuthority, observed);
  }
  if (scoped) depositDomainInsurance(m, markets, domain, amount);
  else if (amount !== 0n) {
    // deposit_market_zero_insurance_view: ⌊amount / 2⌋ into domain 0, the rest into domain 1.
    const long = amount / 2n;
    depositDomainInsurance(m, markets, 0n, long);
    depositDomainInsurance(m, markets, 1n, amount - long);
  }
  if (ledgered) {
    const l = loadRawMutAt<InsuranceLedger>(rest.get(5n), HEADER_LEN);
    require(l.total_principal_atoms <= U128_MAX_RV - amount, PercolatorError.EngineArithmeticOverflow);
    l.total_principal_atoms += amount;
    require(l.total_deposited_atoms <= U128_MAX_RV - amount, PercolatorError.EngineArithmeticOverflow);
    l.total_deposited_atoms += amount;
    require(l.last_observed_insurance_atoms <= U128_MAX_RV - amount, PercolatorError.EngineArithmeticOverflow);
    l.last_observed_insurance_atoms += amount;
  }
  // validate_shape: the deposits end with it (TopUpInsurance of 0 makes none, and the view's checks held the shape).
  if (!scoped && amount === 0n) checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  // write_or_init_insurance_ledger: a created ledger's authority is the signer's (validation holds).
  if (created) validateInsuranceLedger(loadRawAt<InsuranceLedger>(rest.get(5n), HEADER_LEN));
  controls.insurance_top_up = intent;
  if (amount64 !== 0n) programAt<TokenProgram>(tokenProgram).transfer(source, vault, signer, amount64);
}

// ---- TopUpBackingBucket (tag 24) -------------------------------------------------------------------------------------

/**
 * `deposit_fresh_counterparty_backing_not_atomic(domain, amount, expiry)`: the domain; zero refused (InvalidConfig); the
 * amount in bound units (ArithmeticOverflow) added as fresh backing (`add_fresh_counterparty_backing_unchecked`) and as
 * provider principal (saturating); the vault raised (ArithmeticOverflow); the domain's ledger; the shape.
 */
function depositFreshBacking(m: RemainingAccount, markets: u64, domain: u64, amount: u128, expiry: u64): void {
  domainAssetSide(m, markets, domain);
  if (amount === 0n) failV16(V16_INVALID_CONFIG);
  const backing = boundNumFromAmount(amount);
  addFreshCounterpartyBacking(m, markets, domain, backing, expiry, 1n);
  adjustProviderPrincipal(m, markets, domain, backing, true);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.vault > U128_MAX_RV - amount) failV16(V16_ARITHMETIC_OVERFLOW);
  h.vault += amount;
  validateDomainLedger(m, markets, domain);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/** `backing_fee_policy_for_domain_view`: the domain's side of the asset's profile (fee, insurance share). */
function backingPolicyMatches(m: RemainingAccount, markets: u64, domain: u64, fee: u64, share: u64): boolean {
  const p = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, domain / 2n));
  if (domain % 2n === 0n) return toU64(p.backing_trade_fee_bps_long) === fee && toU64(p.backing_trade_fee_insurance_share_bps_long) === share;
  return toU64(p.backing_trade_fee_bps_short) === fee && toU64(p.backing_trade_fee_insurance_share_bps_short) === share;
}

/**
 * `handle_top_up_backing_bucket(domain, market_id, intent_id, authority_epoch, backing_fee_bps, insurance_share_bps,
 * amount, expiry_slot)`: accounts as TopUpInsurance's (the optional ledger a backing-domain ledger). Under the view:
 * Live with the domain configured (EngineLockActive); the asset's generation and authority epoch; its backing top-up
 * sequence older than the intent (EngineStale); a nonzero amount's expiry after the authenticated slot
 * (InvalidInstruction); the domain accepting top-ups; the domain's backing fee policy as expected (Unauthorized); its
 * backing authority signs; the token accounts, the amount within u64 and the source's balance. A nonzero amount: the
 * stale window, the domain and the policy and the authority again, the ledger synced, the fresh backing deposited, the
 * ledger's principal and deposits raised, the sequence advanced; a zero amount only advances the sequence. Then the
 * transfer (none for 0).
 *
 * @noinline
 */
export function topUpBackingBucket(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 5n);
  const signer = rest.get(0n);
  const m = rest.get(1n);
  const source = rest.get(2n);
  const vault = rest.get(3n);
  const tokenProgram = rest.get(4n);
  const ledgered = rest.length > 5n;
  signerCheck(signer);
  writableCheck(m);
  writableCheck(source);
  writableCheck(vault);
  ownerCheck(m, programId);
  if (ledgered) {
    writableCheck(rest.get(5n));
    ownerCheck(rest.get(5n), programId);
  }
  verifyTokenProgramV16(tokenProgram);
  const domain = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const intent = data.readU64(11n);
  const expectedEpoch = data.readU64(19n);
  const fee = toU64(data.readU16(27n));
  const share = toU64(data.readU16(29n));
  const amount = data.readU128(31n);
  const expiry = data.readU64(47n);
  const asset = domain / 2n;
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const configured = toU64(h.config.max_market_slots);
  require(!(h.mode !== MODE_LIVE_RV || domain >= 2n * configured || asset >= configured), PercolatorError.EngineLockActive);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  requireAuthorityEpoch(m, markets, asset, expectedEpoch);
  const controls = loadRawMutAt<AssetControlSequences>(m, controlsFromView(m, markets, asset));
  require(intent > controls.backing_top_up, PercolatorError.EngineStale);
  require(!(amount !== 0n && expiry <= authenticatedMarketSlot(h.current_slot)), PercolatorError.InvalidInstruction);
  requireDomainAcceptsTopup(m, markets, domain);
  require(backingPolicyMatches(m, markets, domain, fee, share), PercolatorError.Unauthorized);
  const backingAuthority = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, asset)).backing_bucket_authority;
  require(liveAuthorityMatches(backingAuthority, signer.key), PercolatorError.Unauthorized);
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const balance = verifyUserTokenAccount(source, signer.key, cfg.collateral_mint);
  verifyVaultTokenAccount(vault, vaultAuthorityOf(m.key, programId), cfg.collateral_mint);
  const amount64 = amountToU64(amount);
  require(balance >= amount64, PercolatorError.InvalidTokenAccount);
  if (amount !== 0n) {
    // The second block: Live, the generation, the epoch and the expiry again (they pass); then what is new to it.
    rejectStaleLive(m);
    requireDomainAcceptsTopup(m, markets, domain);
    // backing_fee_policy_for_domain_view and domain_authorities_from_view again: the same profile (they pass).
    authoritiesFromView(m, markets, domain);
    let created = false;
    if (ledgered) {
      const la = rest.get(5n);
      require(la.key !== m.key, ProgramError.AccountBorrowFailed);
      backingDomainPartsCheck(m, markets, domain);
      created = backingLedgerSynced(la, m, backingAuthority, domain, loadRawAt<BackingBucket>(m, bucketAt(domain)));
    }
    depositFreshBacking(m, markets, domain, amount, expiry);
    if (ledgered) {
      const l = loadRawMutAt<BackingDomainLedger>(rest.get(5n), HEADER_LEN);
      require(l.total_principal_atoms <= U128_MAX_RV - amount, PercolatorError.EngineArithmeticOverflow);
      l.total_principal_atoms += amount;
      require(l.total_deposited_atoms <= U128_MAX_RV - amount, PercolatorError.EngineArithmeticOverflow);
      l.total_deposited_atoms += amount;
    }
    // validate_shape again (the deposit ended with it); a created ledger's authority is the signer's.
    if (created) validateBackingDomainLedger(loadRawAt<BackingDomainLedger>(rest.get(5n), HEADER_LEN));
  }
  // advance_control_sequence_view (a zero amount's block: the generation and the epoch again, which pass).
  controls.backing_top_up = intent;
  if (amount64 !== 0n) programAt<TokenProgram>(tokenProgram).transfer(source, vault, signer, amount64);
}

// ---- The domain withdrawals' preflight -----------------------------------------------------------------------------------

/** `DOMAIN_WITHDRAW_AUTH_INSURANCE` / `_BACKING`. */
const AUTH_INSURANCE = 0n;
const AUTH_BACKING = 1n;

/**
 * `verify_domain_withdrawal_preflight(market, authority, dest, vault, vault_authority, domain, amount, market_id,
 * require_live, kind)`: the market's config and mode (`read_market_config_mode_and_capacity`); outside Resolved the
 * authority signs; the domain configured (InvalidInstruction); the asset's trade preflight and generation
 * (AssetGenerationMismatch); its profile; the beneficiary (the insurance operator or the backing authority) or the
 * market authority (Unauthorized); the vault authority PDA (InvalidArgument); the token accounts (the destination the
 * beneficiary's, unencumbered when the authority did not sign); the amount within u64 and the vault's balance. Returns
 * the PDA's bump.
 */
function domainWithdrawalPreflight(
  m: RemainingAccount,
  authority: RemainingAccount,
  dest: RemainingAccount,
  vault: RemainingAccount,
  vaultAuthority: RemainingAccount,
  domain: u64,
  amount: u128,
  expectedMarketId: u64,
  programId: Pubkey,
  kind: u64,
): u64 {
  const mode = readMarketConfigMode(m);
  if (mode !== MODE_RESOLVED_RV) signerCheck(authority);
  const asset = domain / 2n;
  const configured = toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots);
  require(!(domain >= 2n * configured || asset >= configured), PercolatorError.InvalidInstruction);
  readMarketTradePreflight(m, asset);
  require(readData<u64>(m, assetSlotAt(m, asset)) === expectedMarketId, PercolatorError.AssetGenerationMismatch);
  const p = loadRawAt<AssetOracleProfile>(m, readAssetOracleProfileState(m, asset));
  const beneficiary = kind === AUTH_INSURANCE ? p.insurance_operator : p.backing_bucket_authority;
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  require(liveAuthorityMatches(beneficiary, authority.key) || liveAuthorityMatches(cfg.marketauth, authority.key), PercolatorError.Unauthorized);
  const [pda, bump] = findProgramAddressWithBump(["vault", m.key], programId);
  keyCheck(vaultAuthority, pda);
  const balance = verifyWithdrawable(dest, beneficiary, vault, pda, m, !authority.isSigner);
  require(balance >= amountToU64(amount), PercolatorError.InvalidTokenAccount);
  return toU64(bump);
}

// ---- WithdrawBackingBucket (tag 50) ----------------------------------------------------------------------------------

/**
 * `withdraw_fresh_counterparty_backing_not_atomic(domain, amount)`: the domain; zero refused (InvalidConfig); the
 * amount in bound units; a Fresh bucket at or past its (effective) expiry is Stale; in Live, more than the provider
 * principal while a position on the asset has not settled the latest K/F change is LockActive; in Resolved, more than
 * the surplus is LockActive; the source state; the withdrawal (`prepare_counterparty_backing_withdraw_delta`: a Fresh
 * bucket with the unliened backing and the reserve, LockActive otherwise; an emptied bucket becomes Impaired, Expired or
 * Empty); the source recomputed; its available backing still covering its claim bound (LockActive); the vault lowered
 * (CounterUnderflow); the encumbrance proof; the bucket and the source written (the totals), the provider principal
 * released, the risk epoch and the vault; the ledger; the shape.
 */
function withdrawFreshBacking(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  const asset = domainAssetSide(m, markets, domain);
  if (amount === 0n) failV16(V16_INVALID_CONFIG);
  const backing = boundNumFromAmount(amount);
  const expiry = bucketForDomain(m, markets, domain);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const b = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  if (b.status === BUCKET_FRESH_RV && expiry <= h.current_slot) failV16(V16_STALE);
  checkV16(marketModeErr(h.mode));
  if (h.mode === MODE_LIVE_RV && backing > providerPrincipal(m, markets, domain)) {
    const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
    if (a.stale_account_count_long !== 0n || a.stale_account_count_short !== 0n) failV16(V16_LOCK_ACTIVE);
  }
  if (h.mode === MODE_RESOLVED_RV && amount > resolvedBackingSurplus(m, markets, domain)) failV16(V16_LOCK_ACTIVE);
  sourceForDomain(m, markets, domain);
  const old = sourceTotalsAt(m, domain);
  const s = loadRawMutAt<SourceCreditState>(m, sourceAt(domain));
  // prepare_counterparty_backing_withdraw_delta on the bucket as read (its effective expiry, written back with it).
  if (b.status !== BUCKET_FRESH_RV || b.fresh_unliened_backing_num < backing || s.fresh_reserved_backing_num < backing) failV16(V16_LOCK_ACTIVE);
  b.expiry_slot = expiry;
  b.fresh_unliened_backing_num -= backing;
  s.fresh_reserved_backing_num -= backing;
  if (b.fresh_unliened_backing_num === 0n && b.valid_liened_backing_num === 0n) {
    if (b.impaired_liened_backing_num !== 0n) b.status = BUCKET_IMPAIRED_RV;
    else if (b.consumed_liened_backing_num !== 0n) b.status = BUCKET_EXPIRED_RV;
    else {
      b.status = BUCKET_EMPTY_RV;
      b.expiry_slot = 0n;
    }
  }
  const nextEpoch = recomputeSourceCreditForEpoch(s, h.risk_epoch, 1n);
  if (availableBacking(s) < s.positive_claim_bound_num) failV16(V16_LOCK_ACTIVE);
  if (h.vault < amount) failV16(V16_COUNTER_UNDERFLOW);
  reservationForDomain(m, markets, domain);
  encumbranceProofForParts(m, markets, domain);
  // set_backing_bucket_for_domain (the earnings unchanged: no total moves), set_source_credit_for_domain.
  setSourceCreditTotals(m, markets, domain, old);
  releaseProviderPrincipalAfter(m, markets, domain, old.fresh, s.fresh_reserved_backing_num);
  h.risk_epoch = nextEpoch;
  h.vault -= amount;
  validateDomainLedger(m, markets, domain);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `resolved_counterparty_backing_surplus(domain)`: the domain; the junior payout pool (`resolved_junior_payout_pool`:
 * Resolved or LockActive; with a captured snapshot the ledger's residual and claim bound, RecoveryRequired once payouts
 * are halted; before it, LockActive unless payouts are ready and no source claim is left, then the residual and the
 * junior bound); nothing unless the bucket is Fresh and not (effectively) expired; else the unliened backing beyond the
 * junior need plus the domain's claim bound, in whole atoms.
 */
function resolvedBackingSurplus(m: RemainingAccount, markets: u64, domain: u64): u128 {
  domainAssetSide(m, markets, domain);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_RESOLVED_RV) failV16(V16_LOCK_ACTIVE);
  if (h.payout_snapshot_captured > 1n) failV16(V16_INVALID_CONFIG);
  let pool: u128 = 0n;
  let bound: u128 = 0n;
  if (h.payout_snapshot_captured === 1n) {
    const l = h.resolved_payout_ledger;
    checkV16(resolvedPayoutLedgerErr(l));
    if (l.payout_halted === 1n) failV16(V16_RECOVERY_REQUIRED);
    if (l.terminal_claim_exact_receipts_num > U128_MAX_RV - l.terminal_claim_bound_unreceipted_num) failV16(V16_ARITHMETIC_OVERFLOW);
    pool = l.snapshot_residual;
    bound = l.terminal_claim_exact_receipts_num + l.terminal_claim_bound_unreceipted_num;
  } else {
    if (!resolvedPositivePayoutReady(m) || h.source_claim_bound_total_num !== 0n) failV16(V16_LOCK_ACTIVE);
    pool = residual(m);
    bound = h.pnl_pos_bound_tot_num;
  }
  const expiry = bucketForDomain(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  if (b.status !== BUCKET_FRESH_RV || expiry <= h.current_slot) return 0n;
  // kernel_resolved_junior_backing_need_num: ⌈bound / BOUND_SCALE⌉ less the residual (saturating), in bound units.
  const whole = bound / BOUND_SCALE + (bound % BOUND_SCALE === 0n ? 0n : 1n);
  const short = whole > pool ? whole - pool : 0n;
  if (short > U128_MAX_RV / BOUND_SCALE) failV16(V16_ARITHMETIC_OVERFLOW);
  const need = short * BOUND_SCALE;
  sourceForDomain(m, markets, domain);
  const claims = loadRawAt<SourceCreditState>(m, sourceAt(domain)).positive_claim_bound_num;
  if (need > U128_MAX_RV - claims) failV16(V16_ARITHMETIC_OVERFLOW);
  const reserve = need + claims;
  return b.fresh_unliened_backing_num > reserve ? (b.fresh_unliened_backing_num - reserve) / BOUND_SCALE : 0n;
}

/**
 * `handle_withdraw_backing_bucket(domain, market_id, authority_epoch, amount)`: accounts authority, market (w),
 * destination (w), vault (w), vault authority, token program, optionally a backing-domain ledger (w). The writable and
 * owner checks, SPL Token, a zero amount refused (InvalidInstruction), the preflight. Under the view: the generation;
 * the domain's authorities; on a Resolved market with portfolios or capital left only the surplus, and only with the
 * provider's signature (EngineLockActive); Live: the domain's health or a matured empty shutdown (Recovery:
 * EngineLockActive); the backing authority, or the market authority for a shutdown drain (Unauthorized); the authority
 * epoch of the asset (asset 0's for the admin); the bucket's expiry after the authenticated slot (EngineStale); the
 * ledger synced with at least the amount of principal (EngineCounterUnderflow); the withdrawal (the surplus or the
 * fresh backing); the ledger's principal lowered and its withdrawals raised; the shape; the transfer signed by the
 * vault authority.
 *
 * @noinline
 */
export function withdrawBackingBucket(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 6n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  const dest = rest.get(2n);
  const vault = rest.get(3n);
  const vaultAuthority = rest.get(4n);
  const tokenProgram = rest.get(5n);
  const ledgered = rest.length > 6n;
  writableCheck(m);
  writableCheck(dest);
  writableCheck(vault);
  ownerCheck(m, programId);
  if (ledgered) {
    writableCheck(rest.get(6n));
    ownerCheck(rest.get(6n), programId);
  }
  verifyTokenProgramV16(tokenProgram);
  const domain = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const expectedEpoch = data.readU64(11n);
  const amount = data.readU128(19n);
  require(amount !== 0n, PercolatorError.InvalidInstruction);
  const bump = domainWithdrawalPreflight(m, authority, dest, vault, vaultAuthority, domain, amount, expectedMarketId, programId, AUTH_BACKING);
  const markets = marketViewMut(m);
  const asset = domain / 2n;
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  const backingAuthority = loadRawAt<AssetOracleProfile>(m, authoritiesFromView(m, markets, domain)).backing_bucket_authority;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const surplusOnly = h.mode === MODE_RESOLVED_RV && (h.materialized_portfolio_count !== 0n || h.c_tot !== 0n);
  require(!(surplusOnly && !authority.isSigner), PercolatorError.EngineLockActive);
  let shutdown = false;
  if (h.mode === MODE_LIVE_RV) shutdown = liveWithdrawHealthOrShutdown(m, markets, domain);
  else require(h.mode === MODE_RESOLVED_RV, PercolatorError.EngineLockActive);
  const local = liveAuthorityMatches(backingAuthority, authority.key);
  const admin = shutdown && liveAuthorityMatches(loadRawAt<WrapperConfig>(m, HEADER_LEN).marketauth, authority.key);
  require(local || admin, PercolatorError.Unauthorized);
  requireAuthorityEpoch(m, markets, local ? asset : 0n, expectedEpoch);
  backingDomainPartsCheck(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  // policy_v16::backing_principal_withdrawal_is_fresh (the stored expiry: backing_domain_parts_view's bucket).
  require(authenticatedMarketSlot(h.current_slot) < b.expiry_slot, PercolatorError.EngineStale);
  let created = false;
  if (ledgered) {
    const la = rest.get(6n);
    require(la.key !== m.key, ProgramError.AccountBorrowFailed);
    created = backingLedgerSynced(la, m, backingAuthority, domain, b);
    require(amount <= loadRawAt<BackingDomainLedger>(la, HEADER_LEN).total_principal_atoms, PercolatorError.EngineCounterUnderflow);
  }
  // withdraw_resolved_counterparty_backing_surplus_not_atomic: the surplus, then the ordinary withdrawal (which, on a
  // Resolved market, computes the surplus again: the same value, so the same check).
  if (surplusOnly && amount > resolvedBackingSurplus(m, markets, domain)) failV16(V16_LOCK_ACTIVE);
  withdrawFreshBacking(m, markets, domain, amount);
  if (ledgered) {
    const l = loadRawMutAt<BackingDomainLedger>(rest.get(6n), HEADER_LEN);
    // The principal was checked above: the subtraction cannot underflow.
    l.total_principal_atoms -= amount;
    require(l.total_principal_withdrawn_atoms <= U128_MAX_RV - amount, PercolatorError.EngineArithmeticOverflow);
    l.total_principal_withdrawn_atoms += amount;
    if (created) validateBackingDomainLedger(l);
  }
  programAt<TokenProgram>(tokenProgram).transfer(vault, dest, vaultAuthority, toU64(amount), ["vault", m.key, toU8(bump)]);
}

// ---- WithdrawBackingBucketEarnings (tag 52) -------------------------------------------------------------------------

/**
 * `handle_withdraw_backing_bucket_earnings(domain, market_id, authority_epoch, amount)`: accounts authority, market (w),
 * ledger (w, required), destination (w), vault (w), vault authority, token program. As WithdrawBackingBucket's up to
 * the authorities, except that a Resolved market with portfolios or capital left is refused (EngineLockActive); then
 * the epoch; the amount within the bucket's earnings and the vault (EngineLockActive); the ledger synced; the earnings
 * withdrawn (`withdraw_backing_provider_earnings_not_atomic`); the ledger's observed earnings lowered
 * (EngineCounterUnderflow) and its withdrawn earnings raised; the shape; the ledger written; the signed transfer.
 *
 * @noinline
 */
export function withdrawBackingEarnings(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 7n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  const la = rest.get(2n);
  const dest = rest.get(3n);
  const vault = rest.get(4n);
  const vaultAuthority = rest.get(5n);
  const tokenProgram = rest.get(6n);
  writableCheck(m);
  writableCheck(la);
  writableCheck(dest);
  writableCheck(vault);
  ownerCheck(m, programId);
  ownerCheck(la, programId);
  verifyTokenProgramV16(tokenProgram);
  const domain = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const expectedEpoch = data.readU64(11n);
  const amount = data.readU128(19n);
  require(amount !== 0n, PercolatorError.InvalidInstruction);
  const bump = domainWithdrawalPreflight(m, authority, dest, vault, vaultAuthority, domain, amount, expectedMarketId, programId, AUTH_BACKING);
  const markets = marketViewMut(m);
  const asset = domain / 2n;
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  const backingAuthority = loadRawAt<AssetOracleProfile>(m, authoritiesFromView(m, markets, domain)).backing_bucket_authority;
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  let shutdown = false;
  if (h.mode === MODE_LIVE_RV) shutdown = liveWithdrawHealthOrShutdown(m, markets, domain);
  else if (h.mode === MODE_RESOLVED_RV) require(h.materialized_portfolio_count === 0n && h.c_tot === 0n, PercolatorError.EngineLockActive);
  else require(false, PercolatorError.EngineLockActive);
  const local = liveAuthorityMatches(backingAuthority, authority.key);
  const admin = shutdown && liveAuthorityMatches(loadRawAt<WrapperConfig>(m, HEADER_LEN).marketauth, authority.key);
  require(local || admin, PercolatorError.Unauthorized);
  requireAuthorityEpoch(m, markets, local ? asset : 0n, expectedEpoch);
  backingDomainPartsCheck(m, markets, domain);
  const b = loadRawAt<BackingBucket>(m, bucketAt(domain));
  require(!(amount > b.utilization_fee_earnings || amount > h.vault), PercolatorError.EngineLockActive);
  require(la.key !== m.key, ProgramError.AccountBorrowFailed);
  const created = backingLedgerSynced(la, m, backingAuthority, domain, b);
  // withdraw_backing_provider_earnings_not_atomic: the domain; the bucket read (its effective expiry, written back
  // with it); the earnings and the vault lowered (within both: checked above, so apply_backing_provider_earnings_withdraw
  // cannot refuse); the bucket written (the earnings total moved); the ledger; the shape.
  domainAssetSide(m, markets, domain);
  const expiry = bucketForDomain(m, markets, domain);
  const hm = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const bm = loadRawMutAt<BackingBucket>(m, bucketAt(domain));
  hm.vault -= amount;
  hm.backing_provider_earnings_total = applyTotalDelta(hm.backing_provider_earnings_total, bm.utilization_fee_earnings, bm.utilization_fee_earnings - amount);
  bm.utilization_fee_earnings -= amount;
  bm.expiry_slot = expiry;
  validateDomainLedger(m, markets, domain);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  const l = loadRawMutAt<BackingDomainLedger>(la, HEADER_LEN);
  require(l.last_observed_bucket_earnings_atoms >= amount, PercolatorError.EngineCounterUnderflow);
  l.last_observed_bucket_earnings_atoms -= amount;
  require(l.total_earnings_withdrawn_atoms <= U128_MAX_RV - amount, PercolatorError.EngineArithmeticOverflow);
  l.total_earnings_withdrawn_atoms += amount;
  if (created) validateBackingDomainLedger(l);
  programAt<TokenProgram>(tokenProgram).transfer(vault, dest, vaultAuthority, toU64(amount), ["vault", m.key, toU8(bump)]);
}

// ---- WithdrawInsuranceAsset (tag 57) --------------------------------------------------------------------------------

/**
 * `set_domain_insurance_budget_core(domain, budget, insurance_limit)` for a lower budget: the domain; the old and new
 * remaining parts (InvalidConfig); the market's remaining total moved by their difference (CounterUnderflow), not above
 * the limit (LockActive); the budget written.
 */
function setDomainBudget(m: RemainingAccount, markets: u64, domain: u64, budget: u128, limit: u128): void {
  const asset = domainAssetSide(m, markets, domain);
  const bs = domainInsuranceBudgetSpent(m, markets, domain);
  const oldRemaining = domainBudgetRemainingParts(bs.budget, bs.spent);
  const newRemaining = domainBudgetRemainingParts(budget, bs.spent);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const next = applyTotalDelta(h.insurance_domain_budget_remaining_total, oldRemaining, newRemaining);
  if (next > limit) failV16(V16_LOCK_ACTIVE);
  h.insurance_domain_budget_remaining_total = next;
  const e = loadRawMutAt<EngineAssetSlot>(m, engineSlotAt(asset));
  if (domain % 2n === 1n) e.insurance_domain_budget_short = budget;
  else e.insurance_domain_budget_long = budget;
}

/**
 * `withdraw_domain_insurance_not_atomic(domain, amount)`: the domain; its budget and spent part; its reserved insurance
 * in atoms (the reservation decoded); `withdraw_domain_insurance_delta` (the amount within the insurance not reserved
 * for source credit, the budget less spent less reserved, and the vault: LockActive); the budget set (the remaining
 * total within the new insurance); the vault and the insurance lowered; the token-flow proof (insurance capital out:
 * it balances by construction); the domain's ledger; the shape.
 */
function withdrawDomainInsurance(m: RemainingAccount, markets: u64, domain: u64, amount: u128): void {
  domainAssetSide(m, markets, domain);
  const bs = domainInsuranceBudgetSpent(m, markets, domain);
  reservationForDomain(m, markets, domain);
  const reserved = amountFromBoundNum(loadRawAt<InsuranceCreditReservation>(m, reservationAtDomain(domain)).insurance_credit_reserved_num);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const global = h.insurance > h.source_insurance_credit_reserved_total_atoms ? h.insurance - h.source_insurance_credit_reserved_total_atoms : 0n;
  let remaining = bs.budget > bs.spent ? bs.budget - bs.spent : 0n;
  remaining = remaining > reserved ? remaining - reserved : 0n;
  const cap = global < remaining ? global : remaining;
  if (amount > cap || amount > h.vault) failV16(V16_LOCK_ACTIVE);
  // The subtractions are within the bounds just checked (the original's CounterUnderflow cannot fire).
  setDomainBudget(m, markets, domain, bs.budget - amount, h.insurance - amount);
  const hm = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  hm.vault -= amount;
  hm.insurance -= amount;
  validateDomainLedger(m, markets, domain);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}

/**
 * `debit_market_insurance_budget_view(group, asset, amount)`: nothing for zero; the long domain's withdraw capacity
 * first, the rest from the short domain (above its capacity: EngineCounterUnderflow).
 */
function debitMarketInsurance(m: RemainingAccount, markets: u64, asset: u64, amount: u128): void {
  if (amount === 0n) return;
  let left = amount;
  const longCapacity = domainWithdrawCapacity(m, markets, asset * 2n);
  const longDebit = longCapacity < left ? longCapacity : left;
  if (longDebit !== 0n) {
    withdrawDomainInsurance(m, markets, asset * 2n, longDebit);
    left -= longDebit;
  }
  if (left !== 0n) {
    require(left <= domainWithdrawCapacity(m, markets, asset * 2n + 1n), PercolatorError.EngineCounterUnderflow);
    withdrawDomainInsurance(m, markets, asset * 2n + 1n, left);
  }
}

/** Where `domain`'s insurance reservation is (primitives' `reservationAt`, for a domain the caller bounded). */
function reservationAtDomain(domain: u64): u64 {
  return engineSlotAt(domain / 2n) + (domain % 2n === 1n ? 1229n : 1157n);
}

/**
 * `handle_withdraw_insurance_asset(asset, market_id, authority_epoch, amount)`: accounts operator, market (w),
 * destination (w), vault (w), vault authority, token program, optionally an insurance ledger (w). The writable and owner
 * checks, SPL Token, a zero amount refused (InvalidInstruction), the amount within u64. The preflight: the asset's
 * trade preflight and generation, a Live or Resolved market (InvalidInstruction), the operator's signature in Live,
 * the vault authority PDA, the profile, the token accounts (the destination the insurance operator's in Live, the
 * insurance authority's in Resolved) and the vault's balance. Under the view: the asset configured and in the view, its
 * generation, its authorities. Live: both domains' health or a matured empty shutdown; the insurance operator, or the
 * market authority for a shutdown drain of an asset other than 0 (Unauthorized); the epoch (asset 0's for the admin).
 * Resolved: no portfolio or capital left (EngineLockActive); the insurance authority's key (Unauthorized; no signature
 * needed); the asset's epoch; the claim-free residual recredited to its insurance domains. Then the amount within the
 * withdraw capacity, the insurance and the vault (EngineLockActive); the ledger synced with that capacity; the debit;
 * the ledger's withdrawals raised, principal lowered (saturating) and observation lowered (EngineCounterUnderflow); the
 * shape; the authority epoch advanced; the signed transfer.
 *
 * @noinline
 */
export function withdrawInsuranceAsset(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 6n);
  const operator = rest.get(0n);
  const m = rest.get(1n);
  const dest = rest.get(2n);
  const vault = rest.get(3n);
  const vaultAuthority = rest.get(4n);
  const tokenProgram = rest.get(5n);
  const ledgered = rest.length > 6n;
  writableCheck(m);
  writableCheck(dest);
  writableCheck(vault);
  ownerCheck(m, programId);
  if (ledgered) {
    writableCheck(rest.get(6n));
    ownerCheck(rest.get(6n), programId);
  }
  verifyTokenProgramV16(tokenProgram);
  const asset = toU64(data.readU16(1n));
  const expectedMarketId = data.readU64(3n);
  const expectedEpoch = data.readU64(11n);
  const amount = data.readU128(19n);
  require(amount !== 0n, PercolatorError.InvalidInstruction);
  const amount64 = amountToU64(amount);
  const mode = readMarketTradePreflight(m, asset);
  require(readData<u64>(m, assetSlotAt(m, asset)) === expectedMarketId, PercolatorError.AssetGenerationMismatch);
  require(mode === MODE_LIVE_RV || mode === MODE_RESOLVED_RV, PercolatorError.InvalidInstruction);
  if (mode === MODE_LIVE_RV) signerCheck(operator);
  const [pda, bump] = findProgramAddressWithBump(["vault", m.key], programId);
  keyCheck(vaultAuthority, pda);
  const p0 = loadRawAt<AssetOracleProfile>(m, readAssetOracleProfileState(m, asset));
  const beneficiary = mode === MODE_LIVE_RV ? p0.insurance_operator : p0.insurance_authority;
  const balance = verifyWithdrawable(dest, beneficiary, vault, pda, m, !operator.isSigner);
  require(balance >= amount64, PercolatorError.InvalidTokenAccount);
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const live = h.mode === MODE_LIVE_RV;
  require(live || h.mode === MODE_RESOLVED_RV, PercolatorError.EngineLockActive);
  require(asset < toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  requireAssetGeneration(m, markets, asset, expectedMarketId);
  const p = loadRawAt<AssetOracleProfile>(m, authoritiesFromView(m, markets, asset * 2n));
  let epochAsset = asset;
  if (live) {
    const longDrain = liveWithdrawHealthOrShutdown(m, markets, asset * 2n);
    const shortDrain = liveWithdrawHealthOrShutdown(m, markets, asset * 2n + 1n);
    const local = liveAuthorityMatches(p.insurance_operator, operator.key);
    const admin = asset !== 0n && longDrain && shortDrain && liveAuthorityMatches(loadRawAt<WrapperConfig>(m, HEADER_LEN).marketauth, operator.key);
    require(local || admin, PercolatorError.Unauthorized);
    if (!local) epochAsset = 0n;
    requireAuthorityEpoch(m, markets, epochAsset, expectedEpoch);
  } else {
    require(h.materialized_portfolio_count === 0n && h.c_tot === 0n, PercolatorError.EngineLockActive);
    require(liveAuthorityMatches(p.insurance_authority, operator.key), PercolatorError.Unauthorized);
    requireAuthorityEpoch(m, markets, asset, expectedEpoch);
    recreditTerminalResidualForAsset(m, markets, asset);
  }
  const available = marketWithdrawCapacity(m, markets, asset);
  const after = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(!(amount > available || amount > after.insurance || amount > after.vault), PercolatorError.EngineLockActive);
  let created = false;
  if (ledgered) {
    const la = rest.get(6n);
    require(la.key !== m.key, ProgramError.AccountBorrowFailed);
    created = insuranceLedgerSynced(la, m, p.insurance_authority, available);
  }
  debitMarketInsurance(m, markets, asset, amount);
  if (ledgered) {
    const l = loadRawMutAt<InsuranceLedger>(rest.get(6n), HEADER_LEN);
    require(l.total_withdrawn_atoms <= U128_MAX_RV - amount, PercolatorError.EngineArithmeticOverflow);
    l.total_withdrawn_atoms += amount;
    l.total_principal_atoms = l.total_principal_atoms > amount ? l.total_principal_atoms - amount : 0n;
    require(l.last_observed_insurance_atoms >= amount, PercolatorError.EngineCounterUnderflow);
    l.last_observed_insurance_atoms -= amount;
  }
  // validate_shape: the debit ended with it.
  if (created) validateInsuranceLedger(loadRawAt<InsuranceLedger>(rest.get(6n), HEADER_LEN));
  advanceAuthorityEpoch(m, markets, epochAsset, expectedEpoch);
  programAt<TokenProgram>(tokenProgram).transfer(vault, dest, vaultAuthority, amount64, ["vault", m.key, bump]);
}

// ---- The terminal recredit ---------------------------------------------------------------------------------------------

/**
 * `require_terminal_claim_free_state`: a Resolved market (the mode decoded) with no portfolio, capital, PnL, claim
 * bound, source claim, payout blocker, stale certificate, B-stale or negative-PnL account (LockActive).
 */
export function requireTerminalClaimFree(m: RemainingAccount): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (
    h.mode !== MODE_RESOLVED_RV ||
    h.materialized_portfolio_count !== 0n ||
    h.c_tot !== 0n ||
    h.pnl_pos_tot !== 0n ||
    h.pnl_matured_pos_tot !== 0n ||
    h.pnl_pos_bound_tot !== 0n ||
    h.pnl_pos_bound_tot_num !== 0n ||
    h.source_claim_bound_total_num !== 0n ||
    h.resolved_payout_blocker_count !== 0n ||
    h.stale_certificate_count !== 0n ||
    h.b_stale_account_count !== 0n ||
    h.negative_pnl_account_count !== 0n
  )
    failV16(V16_LOCK_ACTIVE);
}

/**
 * `apply_terminal_insurance_recredit_not_atomic(domain, spent, recredit, remaining)`: nothing for zero; above the spent
 * part or the remaining residual CounterUnderflow; the insurance raised (ArithmeticOverflow); the domain's spent part
 * lowered (`set_domain_insurance_spent_core`); the remaining residual lowered; the proof (surplus to insurance: it
 * balances). Returns what was recredited.
 */
function applyRecredit(m: RemainingAccount, markets: u64, domain: u64, spent: u128, recredit: u128, remaining: Inout<Remaining>): u128 {
  if (recredit === 0n) return 0n;
  if (recredit > spent || recredit > remaining.v) failV16(V16_COUNTER_UNDERFLOW);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.insurance > U128_MAX_RV - recredit) failV16(V16_ARITHMETIC_OVERFLOW);
  h.insurance += recredit;
  setDomainInsuranceSpent(m, markets, domain, spent - recredit);
  remaining.v -= recredit;
  return recredit;
}

/** The claim-free residual left to recredit (the original's `&mut u128`). */
export interface Remaining {
  v: u128;
}

/**
 * `recredit_terminal_claim_free_residual_for_asset_core_not_atomic(asset)`: the residual; for each side while some is
 * left, the provider-receivable overlap of that source domain with the paired (opposite) insurance domain's spend; then
 * for the short insurance domain and the long one while some is left, the spend still unconsumed. Returns the total
 * (ArithmeticOverflow).
 */
export function recreditTerminalResidualCore(m: RemainingAccount, markets: u64, asset: u64): u128 {
  const remaining: Remaining = { v: residual(m) };
  let total: u128 = 0n;
  for (let side = 0n; side < 2n; side++) {
    if (remaining.v === 0n) break;
    const source = insuranceDomainIndex(m, markets, asset, side === 1n);
    // recredit_terminal_claim_free_overlap_for_source_domain_not_atomic: the paired insurance domain, its spend, the
    // source's receivable in atoms (the source state read whole).
    domainAssetSide(m, markets, source);
    const insurance = insuranceDomainIndex(m, markets, asset, side === 0n);
    const spent = domainInsuranceBudgetSpent(m, markets, insurance).spent;
    sourceForDomain(m, markets, source);
    const receivable = loadRawAt<SourceCreditState>(m, sourceAt(source)).provider_receivable_num / BOUND_SCALE;
    let recredit = receivable < spent ? receivable : spent;
    if (remaining.v < recredit) recredit = remaining.v;
    const got = applyRecredit(m, markets, insurance, spent, recredit, remaining);
    if (total > U128_MAX_RV - got) failV16(V16_ARITHMETIC_OVERFLOW);
    total += got;
  }
  for (let k = 0n; k < 2n; k++) {
    if (remaining.v === 0n) break;
    // The short insurance domain first, then the long one.
    const insurance = insuranceDomainIndex(m, markets, asset, k === 0n);
    const spent = domainInsuranceBudgetSpent(m, markets, insurance).spent;
    const recredit = spent < remaining.v ? spent : remaining.v;
    const got = applyRecredit(m, markets, insurance, spent, recredit, remaining);
    if (total > U128_MAX_RV - got) failV16(V16_ARITHMETIC_OVERFLOW);
    total += got;
  }
  return total;
}

/** `recredit_terminal_claim_free_residual_for_asset_not_atomic(asset)`: the shape, the claim-free state, the core,
 * the shape. */
function recreditTerminalResidualForAsset(m: RemainingAccount, markets: u64, asset: u64): void {
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  requireTerminalClaimFree(m);
  recreditTerminalResidualCore(m, markets, asset);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
}
