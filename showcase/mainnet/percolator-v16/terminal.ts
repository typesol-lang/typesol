// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs and
// aeyakovenko/percolator src/v16.rs, Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL. Ported here: the terminal handlers
// `handle_close_slab` (with `terminal_slab_scan_start`, `encode_terminal_slab_scan_progress`, the engine's
// `advance_terminal_slab_not_atomic`, `terminal_claim_free_recredit_for_slot`, `kernel_terminal_slab_asset_step`,
// `kernel_terminal_slab_wait_continuation`, `retire_terminal_unbudgeted_insurance_core_not_atomic`),
// `handle_claim_resolved_payout_topup` (`claim_resolved_payout_topup_not_atomic`), `handle_swap_secondary_for_primary`
// and `handle_force_close_abandoned_asset` (`force_close_recovery_pair_not_atomic`, which runs the trade engine of
// trade.ts, and the residue's forfeit of recovery.ts).
//
// Each handler is the original's, check for check in its order; the arguments are read at fixed offsets after decode
// has checked the length.
//
// Copies. `handle_close_slab` takes the wrapper config by value and writes it back validated
// (`write_wrapper_config`) after the engine's step; the port changes the scan progress in place and validates the config
// where the original writes it (nothing in between reads the config's bytes, and every failure in between fails the
// transaction). `handle_force_close_abandoned_asset` copies the asset state before the maintenance fees and reads the
// copy's open interest after them; the port keeps the two values it reads.
//
// Repeated accounts. CloseSlab refuses the admin as the market by key; the token accounts are owner-checked by SPL
// Token before their data is read. ClaimResolvedPayoutTopup and ForceCloseAbandonedAsset give each portfolio the
// portfolio's length first (`ensure_portfolio_storage_for_market_slots`): a market passed as a portfolio is longer and
// refused there (InvalidAccountLen), and ForceCloseAbandonedAsset refuses one portfolio twice by key.
import {
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenProgram,
  type u64,
  type u128,
  currentSlot,
  findProgramAddress,
  findProgramAddressWithBump,
  loadRawAt,
  loadRawMutAt,
  programAt,
  rawArrayAt,
  pubkey,
  readData,
  rentExempt,
  require,
  resizeAccount,
  i128 as toI128,
  u64 as toU64,
  u128 as toU128,
  zeroData,
} from "typesol";
import {
  PercolatorError,
  V16_INVALID_CONFIG,
  V16_INVALID_LEG,
  V16_LOCK_ACTIVE,
  V16_NON_PROGRESS,
  checkV16,
  failV16,
} from "./errors.js";
import {
  type AccountHeader,
  type AssetOracleProfile,
  type AssetSlot,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type WrapperConfig,
  HEADER_LEN,
  KIND_CLOSED_MARKET,
  MARKET_GROUP_LEN,
  MARKET_GROUP_OFF,
  ZERO_KEY,
  validateWrapperConfig,
  writeHeaderView,
} from "./state.js";
import { BOUND_SCALE, backingBucketStatusErr, boolErr, marketModeErr } from "./wire.js";
import { LIFECYCLE_RECOVERY, engineSlotAt, marketShapeErr, validateWithMarket } from "./engine.js";
import { activeLegForAsset, assetStateOf, effectiveBackingExpiry, expireSourceBackingBucket, residual } from "./primitives.js";
import { effectiveAbsQuantityForLeg } from "./health.js";
import { executeTrade } from "./trade.js";
import { configuredAssetIndex } from "./lifecycle.js";
import { forfeitRecoveryLeg } from "./recovery.js";
import { advanceResolvedSlot, applyReceiptPayment, clearFullyDilutedReceipt, receiptClaimableNow } from "./resolved.js";
import { bumpPositionEpoch, signedPositionForAsset } from "./trading.js";
import { creditMaintenanceFee, verifyWithdrawable } from "./custody.js";
import { syncAccountFeeToSlot } from "./refresh.js";
import { recreditTerminalResidualCore, requireTerminalClaimFree } from "./reserves.js";
import {
  ATA_PROGRAM_ID,
  SPL_TOKEN_ID,
  amountToU64,
  authenticatedMarketSlot,
  ensurePortfolioStorage,
  expectLiveAuthority,
  expectPortfolioAccountKey,
  keyCheck,
  marketViewMut,
  needAccounts,
  ownerCheck,
  portfolioViewMut,
  profileFromView,
  readMarketConfigMode,
  rejectStaleLive,
  requireAuthorityEpoch,
  signerCheck,
  unpackMintV16,
  verifyTokenProgramV16,
  verifyUserTokenAccount,
  verifyVaultTokenAccount,
  writableCheck,
} from "./program.js";

const U64_MAX_TM: u128 = 0xffffffffffffffffn;
const MODE_LIVE_TM = 0n;
const MODE_RESOLVED_TM = 1n;
const BUCKET_FRESH_TM = 1n;
/** `TERMINAL_SLAB_SCAN_ASSETS_PER_CALL`. */
const SCAN_PER_CALL = 256n;
/** spl_token::native_mint::id(). */
const NATIVE_MINT = pubkey("So11111111111111111111111111111111111111112");

// ---- CloseSlab (tag 13) -------------------------------------------------------------------------------------------------

/** `TerminalSlabOutcomeV16` as the handler sees it. */
const OUTCOME_SCAN = 0n;
const OUTCOME_EXPIRED = 1n;
const OUTCOME_RECREDITED = 2n;
const OUTCOME_READY = 3n;

interface TerminalStep {
  outcome: u64;
  /** ScanProgress's next asset, InsuranceRecredited's asset. */
  asset: u64;
  /** ReadyToClose's retired amount. */
  retired: u128;
}

/**
 * `terminal_claim_free_recredit_for_slot(slot, residual)`: what the asset's recredit would restore, from the slot's
 * values: the long source's receivable overlap with the short domain's spend, the short source's with the long
 * domain's, then the short domain's unconsumed spend and the long domain's, each bounded by the residual left
 * (CounterUnderflow for a step past it, ArithmeticOverflow for the sum).
 */
function recreditForSlot(e: EngineAssetSlot, res: u128): u128 {
  let longSource = e.source_credit_long.provider_receivable_num / BOUND_SCALE;
  if (longSource > e.insurance_domain_spent_short) longSource = e.insurance_domain_spent_short;
  if (longSource > res) longSource = res;
  const afterLong = res - longSource;
  let shortSource = e.source_credit_short.provider_receivable_num / BOUND_SCALE;
  if (shortSource > e.insurance_domain_spent_long) shortSource = e.insurance_domain_spent_long;
  if (shortSource > afterLong) shortSource = afterLong;
  const afterOverlap = afterLong - shortSource;
  // The spends less the overlaps taken from them (each overlap is at most its spend).
  const shortLeft = e.insurance_domain_spent_short - longSource;
  const shortUnconsumed = shortLeft < afterOverlap ? shortLeft : afterOverlap;
  const afterShort = afterOverlap - shortUnconsumed;
  const longLeft = e.insurance_domain_spent_long - shortSource;
  const longUnconsumed = longLeft < afterShort ? longLeft : afterShort;
  // Each term is at most the residual and their sum at most the residual: no overflow.
  return longSource + shortSource + shortUnconsumed + longUnconsumed;
}

/**
 * `advance_terminal_slab_not_atomic(slot, scan_start)`: the shape; the claim-free state; the resolved slot advanced;
 * a nonzero start past the configured assets refused (InvalidConfig). With fresh backing or a residual, up to 256 assets
 * from the start: a lapsed Fresh bucket (long first) is expired (BackingExpired); an asset whose recredit is nonzero is
 * recredited (InsuranceRecredited; InvalidConfig if nothing moved); a live Fresh bucket stops the scan there
 * (ScanProgress, LockActive when it is the start); past the batch, ScanProgress at its end. Then no earnings or fresh
 * backing may be left (LockActive), and the vault is retired (`retire_terminal_unbudgeted_insurance_core_not_atomic`:
 * the insurance within the vault, no remaining budget or source reservation, LockActive; the vault and the insurance
 * zeroed; the vault less the insurance as protocol surplus, CounterUnderflow): ReadyToClose with the vault as retired.
 */
function advanceTerminalSlab(m: RemainingAccount, markets: u64, slot: u64, start: u64, out: Inout<TerminalStep>): void {
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  requireTerminalClaimFree(m);
  advanceResolvedSlot(m, slot);
  const configured = toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots);
  if (start !== 0n && start >= configured) failV16(V16_INVALID_CONFIG);
  const inspectBacking = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).source_fresh_backing_total_num !== 0n;
  const res = residual(m);
  const inspectRecredit = res !== 0n;
  if (inspectBacking || inspectRecredit) {
    const end = start + SCAN_PER_CALL < configured ? start + SCAN_PER_CALL : configured;
    // The view's slots (`self.markets`): the shape check above bounded the configured count by the capacity, which the
    // market view took from the length, so each slot is read in place as the original indexes the slice.
    const slots = rawArrayAt<AssetSlot>(m, MARKET_GROUP_OFF + MARKET_GROUP_LEN, markets);
    for (let asset = start; asset < end; asset++) {
      const e = slots.get(asset).engine;
      checkV16(backingBucketStatusErr(e.backing_long.status));
      checkV16(backingBucketStatusErr(e.backing_short.status));
      const recreditable = inspectRecredit && recreditForSlot(e, res) !== 0n;
      const longFresh = inspectBacking && e.backing_long.status === BUCKET_FRESH_TM;
      const shortFresh = inspectBacking && e.backing_short.status === BUCKET_FRESH_TM;
      // kernel_terminal_slab_asset_step gives Continue for an asset with neither a Fresh bucket nor a recredit, whatever
      // the expiries; the original makes both effective first, which cannot fail here (advance_resolved_slot required a
      // Resolved market) and changes nothing, so the port makes them effective only where the step reads them.
      if (!longFresh && !shortFresh && !recreditable) continue;
      const longExpiry = effectiveBackingExpiry(m, e.backing_long.expiry_slot);
      const shortExpiry = effectiveBackingExpiry(m, e.backing_short.expiry_slot);
      if ((longFresh && longExpiry <= slot) || (shortFresh && shortExpiry <= slot)) {
        expireSourceBackingBucket(m, markets, asset * 2n + (longFresh && longExpiry <= slot ? 0n : 1n), slot);
        checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
        out.outcome = OUTCOME_EXPIRED;
        return;
      }
      if (recreditable) {
        if (recreditTerminalResidualCore(m, markets, asset) === 0n) failV16(V16_INVALID_CONFIG);
        checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
        out.outcome = OUTCOME_RECREDITED;
        out.asset = asset;
        return;
      }
      if (longFresh || shortFresh) {
        // Wait: the remaining Fresh bucket is live (an expired one was taken above).
        if (asset <= start) failV16(V16_LOCK_ACTIVE);
        out.outcome = OUTCOME_SCAN;
        out.asset = asset;
        return;
      }
    }
    if (end !== configured) {
      out.outcome = OUTCOME_SCAN;
      out.asset = end;
      return;
    }
  }
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.backing_provider_earnings_total !== 0n || h.source_fresh_backing_total_num !== 0n) failV16(V16_LOCK_ACTIVE);
  if (h.insurance > h.vault || h.insurance_domain_budget_remaining_total !== 0n || h.source_insurance_credit_reserved_total_atoms !== 0n) failV16(V16_LOCK_ACTIVE);
  // The two proofs balance by construction (the surplus vault − insurance is not negative: checked just above).
  out.retired = h.vault;
  h.vault = 0n;
  h.insurance = 0n;
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  out.outcome = OUTCOME_READY;
}

/**
 * `handle_close_slab(authority_epoch)`: accounts admin (signer, w), market (w), vault (w), vault authority, destination
 * (w), token program, then for a market with a second mint its vault and the admin's account (w), then (for retired
 * value) the primary mint (w) and for a native mint the residue destination (w). The admin signs and is writable, the
 * market, the vault and the destination writable; the admin not the market (InvalidInstruction); the market the
 * program's; SPL Token. Under the market view: the market authority signs; asset 0's authority epoch; Resolved, with no
 * capital or portfolio left (EngineLockActive); the vault authority PDA; the vault and the destination (the admin's) of
 * the primary mint; the secondary pair (distinct accounts: InvalidVaultAccount). One terminal step at the authenticated
 * slot from the stored scan progress (InvalidInstruction for a progress past u64 or the configured assets): a scan, an
 * expiry or a recredit stores its progress and ends; ReadyToClose clears it and, for retired value on a native mint,
 * reads asset 0's insurance authority. The config written validated. Then the retired value burned (or, for the native
 * mint, sent to the insurance authority's canonical account), the rest of the vault swept to the destination, the vault
 * closed to the admin, the secondary vault swept and closed, the market cut to its header and made a closed-market
 * tombstone, and every lamport above that header's rent moved to the admin.
 *
 * @noinline
 */
export function closeSlab(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 6n);
  const admin = rest.get(0n);
  const m = rest.get(1n);
  const vault = rest.get(2n);
  const vaultAuthority = rest.get(3n);
  const dest = rest.get(4n);
  const tokenProgram = rest.get(5n);
  signerCheck(admin);
  writableCheck(admin);
  writableCheck(m);
  writableCheck(vault);
  writableCheck(dest);
  require(admin.key !== m.key, PercolatorError.InvalidInstruction);
  ownerCheck(m, programId);
  verifyTokenProgramV16(tokenProgram);
  const markets = marketViewMut(m);
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  expectLiveAuthority(cfg.marketauth, admin.key);
  requireAuthorityEpoch(m, markets, 0n, data.readU64(1n));
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.mode === MODE_RESOLVED_TM, PercolatorError.EngineLockActive);
  require(h.c_tot === 0n && h.materialized_portfolio_count === 0n, PercolatorError.EngineLockActive);
  const [pda, bump] = findProgramAddressWithBump(["vault", m.key], programId);
  keyCheck(vaultAuthority, pda);
  const primary = cfg.collateral_mint;
  const vaultBalance = verifyVaultTokenAccount(vault, pda, primary);
  verifyUserTokenAccount(dest, admin.key, primary);
  const secondary = cfg.secondary_collateral_mint !== ZERO_KEY;
  let secondaryBalance: u64 = 0n;
  if (secondary) {
    needAccounts(rest, 8n);
    const sv = rest.get(6n);
    const sd = rest.get(7n);
    writableCheck(sv);
    writableCheck(sd);
    require(sv.key !== vault.key && sd.key !== dest.key, PercolatorError.InvalidVaultAccount);
    secondaryBalance = verifyVaultTokenAccount(sv, pda, cfg.secondary_collateral_mint);
    verifyUserTokenAccount(sd, admin.key, cfg.secondary_collateral_mint);
  }
  const slot = authenticatedMarketSlot(h.current_slot);
  const configured = toU64(h.config.max_market_slots);
  // terminal_slab_scan_start.
  const progress = cfg.terminal_slab_scan_progress;
  let start: u64 = 0n;
  if (progress !== 0n) {
    require(progress <= U64_MAX_TM, PercolatorError.InvalidInstruction);
    start = toU64(progress);
    require(start < configured, PercolatorError.InvalidInstruction);
  }
  const step: TerminalStep = { outcome: 0n, asset: 0n, retired: 0n };
  advanceTerminalSlab(m, markets, slot, start, step);
  if (step.outcome !== OUTCOME_READY) {
    // encode_terminal_slab_scan_progress (the next asset is below the configured count); BackingExpired restarts.
    if (step.outcome !== OUTCOME_EXPIRED) require(step.asset < configured, PercolatorError.InvalidInstruction);
    cfg.terminal_slab_scan_progress = step.outcome === OUTCOME_EXPIRED ? 0n : toU128(step.asset);
    validateWrapperConfig(cfg);
    return;
  }
  cfg.terminal_slab_scan_progress = 0n;
  const retired = step.retired;
  let residueAuthority: Pubkey = ZERO_KEY;
  const native = retired !== 0n && primary === NATIVE_MINT;
  if (native) {
    // domain_authorities_from_view(0): domain 0 is configured and asset 0 in the view.
    residueAuthority = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, 0n)).insurance_authority;
  }
  validateWrapperConfig(cfg);
  const retired64 = amountToU64(retired);
  require(vaultBalance >= retired64, PercolatorError.InvalidTokenAccount);
  const sweep = vaultBalance - retired64;
  const token = programAt<TokenProgram>(tokenProgram);
  if (retired64 !== 0n) {
    const at = secondary ? 8n : 6n;
    needAccounts(rest, at + 1n);
    const mint = rest.get(at);
    writableCheck(mint);
    keyCheck(mint, primary);
    unpackMintV16(mint);
    if (native) {
      needAccounts(rest, at + 2n);
      const residueDest = rest.get(at + 1n);
      writableCheck(residueDest);
      require(residueDest.key === findProgramAddress([residueAuthority, SPL_TOKEN_ID, primary], ATA_PROGRAM_ID), PercolatorError.InvalidTokenAccount);
      verifyWithdrawable(residueDest, residueAuthority, vault, vaultAuthority.key, m, true);
      token.transfer(vault, residueDest, vaultAuthority, retired64, ["vault", m.key, bump]);
    } else token.burn(vault, mint, vaultAuthority, retired64, ["vault", m.key, bump]);
  }
  if (sweep > 0n) token.transfer(vault, dest, vaultAuthority, sweep, ["vault", m.key, bump]);
  token.closeAccount(vault, admin, vaultAuthority, ["vault", m.key, bump]);
  if (secondary) {
    if (secondaryBalance > 0n) token.transfer(rest.get(6n), rest.get(7n), vaultAuthority, secondaryBalance, ["vault", m.key, bump]);
    token.closeAccount(rest.get(6n), admin, vaultAuthority, ["vault", m.key, bump]);
  }
  // realloc(HEADER_LEN, false), then write_closed_market_tombstone: the header's bytes zeroed and written.
  resizeAccount(m, HEADER_LEN);
  zeroData(m, 0n, HEADER_LEN);
  const tomb = loadRawMutAt<AccountHeader>(m, 0n);
  writeHeaderView(tomb, KIND_CLOSED_MARKET);
  const retained = rentExempt(HEADER_LEN);
  const lamports = m.lamports;
  require(lamports >= retained, PercolatorError.RentExemptRequired);
  const refund = lamports - retained;
  m.lamports = retained;
  require(admin.lamports <= 0xffffffffffffffffn - refund, PercolatorError.EngineArithmeticOverflow);
  admin.lamports += refund;
}

// ---- ClaimResolvedPayoutTopup (tag 46) ------------------------------------------------------------------------------

/**
 * `handle_claim_resolved_payout_topup`: accounts owner (any key; no signature), market (w), portfolio (w), and for a
 * payout the destination (w), the vault (w), the vault authority and the token program. The market and the portfolio
 * writable and the program's; the market's config; the portfolio's storage. Under the view: the portfolio's view, key
 * and owner (Unauthorized); the resolved slot advanced to the authenticated slot; `claim_resolved_payout_topup_not_atomic`
 * (validated with the market; Resolved with the snapshot captured, LockActive; the receipt's claimable amount, the
 * fully diluted receipt cleared when it is 0, else min(claimable, vault) paid from the vault and recorded on the
 * receipt; the shape; validated again). A payout: the four accounts, the token program, the vault authority PDA, the
 * token accounts (the owner's destination, unencumbered) and the vault's balance, the signed transfer.
 *
 * @noinline
 */
export function claimResolvedPayoutTopup(rest: RemainingAccounts, programId: Pubkey): void {
  needAccounts(rest, 3n);
  const owner = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  writableCheck(m);
  writableCheck(pa);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  readMarketConfigMode(m);
  ensurePortfolioStorage(pa);
  const markets = marketViewMut(m);
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === owner.key, PercolatorError.Unauthorized);
  advanceResolvedSlot(m, authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot));
  // preflight_claim_resolved_payout_topup.
  validateWithMarket(m, pa, markets);
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_RESOLVED_TM) failV16(V16_LOCK_ACTIVE);
  checkV16(boolErr(h.payout_snapshot_captured));
  if (h.payout_snapshot_captured !== 1n) failV16(V16_LOCK_ACTIVE);
  // claim_resolved_payout_topup_core_not_atomic: the receipt decoded inside the claimable amount.
  const claimable = receiptClaimableNow(m, pa);
  let payout: u128 = 0n;
  if (claimable === 0n) clearFullyDilutedReceipt(m, pa);
  else {
    // kernel_resolved_payout_step; the proof balances by construction.
    payout = claimable < h.vault ? claimable : h.vault;
    applyReceiptPayment(pa, payout);
    h.vault -= payout;
  }
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, pa, markets);
  if (payout === 0n) return;
  needAccounts(rest, 7n);
  const dest = rest.get(3n);
  const vault = rest.get(4n);
  const vaultAuthority = rest.get(5n);
  const tokenProgram = rest.get(6n);
  writableCheck(dest);
  writableCheck(vault);
  verifyTokenProgramV16(tokenProgram);
  const [pda, bump] = findProgramAddressWithBump(["vault", m.key], programId);
  keyCheck(vaultAuthority, pda);
  const balance = verifyWithdrawable(dest, owner.key, vault, pda, m, true);
  const payout64 = amountToU64(payout);
  require(balance >= payout64, PercolatorError.InvalidTokenAccount);
  programAt<TokenProgram>(tokenProgram).transfer(vault, dest, vaultAuthority, payout64, ["vault", m.key, bump]);
}

// ---- SwapSecondaryForPrimary (tag 61) --------------------------------------------------------------------------------

/**
 * `handle_swap_secondary_for_primary(amount, authority_epoch)`: accounts authority (signer), market, primary source
 * (w), primary vault (w), secondary destination (w), secondary vault (w), vault authority, token program. The
 * authority signs; the four token accounts writable; the market the program's; SPL Token; a zero amount refused and the
 * amount within u64 (InvalidInstruction); the market's config; the market authority signs; asset 0's authority epoch
 * (`read_asset_control_sequences`: the header, slot 0 within the data); the secondary mint set (InvalidMint); the vault
 * authority PDA; the token accounts and both balances; the primary paid in by the authority and the secondary paid out
 * by the vault authority.
 *
 * @noinline
 */
export function swapSecondaryForPrimary(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 8n);
  const authority = rest.get(0n);
  const m = rest.get(1n);
  const primarySource = rest.get(2n);
  const primaryVault = rest.get(3n);
  const secondaryDest = rest.get(4n);
  const secondaryVault = rest.get(5n);
  const vaultAuthority = rest.get(6n);
  const tokenProgram = rest.get(7n);
  signerCheck(authority);
  writableCheck(primarySource);
  writableCheck(primaryVault);
  writableCheck(secondaryDest);
  writableCheck(secondaryVault);
  ownerCheck(m, programId);
  verifyTokenProgramV16(tokenProgram);
  const amount = data.readU128(1n);
  require(amount !== 0n, PercolatorError.InvalidInstruction);
  const amount64 = amountToU64(amount);
  readMarketConfigMode(m);
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  expectLiveAuthority(cfg.marketauth, authority.key);
  // state::read_asset_control_sequences(data, 0): slot 0's control sequences within the data (the config read above
  // holds the header and the length: a whole number of slots, at least one).
  require(readData<u64>(m, ASSET0_EPOCH_AT) === data.readU64(17n), PercolatorError.EngineStale);
  const primary = cfg.collateral_mint;
  const secondary = cfg.secondary_collateral_mint;
  require(secondary !== ZERO_KEY, PercolatorError.InvalidMint);
  const [pda, bump] = findProgramAddressWithBump(["vault", m.key], programId);
  keyCheck(vaultAuthority, pda);
  const sourceBalance = verifyUserTokenAccount(primarySource, authority.key, primary);
  verifyVaultTokenAccount(primaryVault, pda, primary);
  verifyUserTokenAccount(secondaryDest, authority.key, secondary);
  const vaultBalance = verifyVaultTokenAccount(secondaryVault, pda, secondary);
  require(sourceBalance >= amount64, PercolatorError.InvalidTokenAccount);
  require(vaultBalance >= amount64, PercolatorError.InvalidTokenAccount);
  const token = programAt<TokenProgram>(tokenProgram);
  token.transfer(primarySource, primaryVault, authority, amount64);
  token.transfer(secondaryVault, secondaryDest, vaultAuthority, amount64, ["vault", m.key, bump]);
}

/** Slot 0's authority epoch: the dynamic slots' start, the profile, then the third u64 of the control sequences. */
const ASSET0_EPOCH_AT = MARKET_GROUP_OFF + 726n + 424n + 16n;

// ---- ForceCloseAbandonedAsset (tag 64) -----------------------------------------------------------------------------

/**
 * `force_close_recovery_pair_not_atomic(a, b, asset, close_q)`: Live (LockActive); a nonzero request (InvalidConfig);
 * the asset configured and decoded; in Recovery (LockActive); both portfolios' legs of the asset active and on opposite
 * sides (InvalidLeg); the quantity the smallest of the request, both legs' effective quantities and both sides' open
 * interest (NonProgress for 0); the trade at the effective price without a fee, the short portfolio as the long side so
 * that both legs shrink. Returns nothing (the closed quantity is not used).
 */
function forceCloseRecoveryPair(m: RemainingAccount, markets: u64, pa: RemainingAccount, pb: RemainingAccount, asset: u64, request: u128): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  checkV16(marketModeErr(h.mode));
  if (h.mode !== MODE_LIVE_TM) failV16(V16_LOCK_ACTIVE);
  if (request === 0n) failV16(V16_INVALID_CONFIG);
  configuredAssetIndex(m, markets, asset);
  assetStateOf(m, markets, asset);
  const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  if (a.lifecycle !== LIFECYCLE_RECOVERY) failV16(V16_LOCK_ACTIVE);
  const slotA = activeLegForAsset(pa, asset);
  const slotB = activeLegForAsset(pb, asset);
  if (slotA === NO_LEG || slotB === NO_LEG) failV16(V16_INVALID_LEG);
  const legA = loadRawAt<Portfolio>(pa, HEADER_LEN).legs.get(slotA);
  const legB = loadRawAt<Portfolio>(pb, HEADER_LEN).legs.get(slotB);
  if (legA.side === legB.side) failV16(V16_INVALID_LEG);
  const effA = effectiveAbsQuantityForLeg(a, legA);
  const effB = effectiveAbsQuantityForLeg(a, legB);
  let q = request;
  if (effA < q) q = effA;
  if (effB < q) q = effB;
  if (a.oi_eff_long_q < q) q = a.oi_eff_long_q;
  if (a.oi_eff_short_q < q) q = a.oi_eff_short_q;
  if (q === 0n) failV16(V16_NON_PROGRESS);
  // q is at most an effective quantity (below 2^127): the i128 conversion cannot fail.
  const size = toI128(q);
  if (legA.side === 1n) executeTrade(m, markets, pa, pb, { asset: asset, size: size, price: a.effective_price, fee_bps: 0n });
  else executeTrade(m, markets, pb, pa, { asset: asset, size: size, price: a.effective_price, fee_bps: 0n });
}

/** `active_leg_slot_for_asset`'s None. */
const NO_LEG: u64 = 0xffffffffffffffffn;

/**
 * `handle_force_close_abandoned_asset(asset, now_slot, close_q)`: accounts cranker (signer), market (w), portfolio a
 * (w), portfolio b (w), all three the program's. The cranker signs; two distinct portfolios and a nonzero quantity
 * (InvalidInstruction); the slot is the Clock's; a Live market (`read_market_config_mode_and_capacity`;
 * EngineLockActive); both portfolios' storage. Under the view: Live, the asset configured and in the view, a force-close
 * delay set (EngineLockActive); the stale window (OracleStale); the asset in Recovery and its profile's last good
 * oracle slot set, not after the slot and at least the delay behind it (EngineLockActive); both portfolios' views and
 * keys, validated with the market; the maintenance fee collected from each; their positions on the asset. One flat:
 * the other's side must have no open interest left (EngineInvalidLeg; both flat: EngineNonProgress) and its leg is
 * forfeited with the quantity as the budget, then its position epoch advanced; neither flat: the pair force-closed and
 * both epochs advanced. The market's shape and both portfolios validated after either.
 *
 * @noinline
 */
export function forceCloseAbandonedAsset(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 4n);
  const cranker = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  const pb = rest.get(3n);
  signerCheck(cranker);
  writableCheck(m);
  writableCheck(pa);
  writableCheck(pb);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  ownerCheck(pb, programId);
  const asset = loadAsset(data);
  const closeQ = data.readU128(11n);
  require(pa.key !== pb.key && closeQ !== 0n, PercolatorError.InvalidInstruction);
  const slot = currentSlot();
  require(readMarketConfigMode(m) === MODE_LIVE_TM, PercolatorError.EngineLockActive);
  ensurePortfolioStorage(pa);
  ensurePortfolioStorage(pb);
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  require(
    !(h.mode !== MODE_LIVE_TM || asset >= toU64(h.config.max_market_slots) || asset >= markets || cfg.force_close_delay_slots === 0n),
    PercolatorError.EngineLockActive,
  );
  rejectStaleLive(m);
  // The asset state copied here (its open interest is what the residue's check reads, after the fees).
  const a0 = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
  const oiLong = a0.oi_eff_long_q;
  const oiShort = a0.oi_eff_short_q;
  require(a0.lifecycle === LIFECYCLE_RECOVERY, PercolatorError.EngineLockActive);
  const shutdown = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, asset)).last_good_oracle_slot;
  require(!(shutdown === 0n || slot < shutdown || slot - shutdown < cfg.force_close_delay_slots), PercolatorError.EngineLockActive);
  portfolioViewMut(pa);
  portfolioViewMut(pb);
  expectPortfolioAccountKey(pa);
  expectPortfolioAccountKey(pb);
  validateWithMarket(m, pa, markets);
  validateWithMarket(m, pb, markets);
  // collect_maintenance_fee_before_value_debit_view for each (Live here).
  const rate = cfg.maintenance_fee_per_slot;
  if (rate !== 0n) {
    creditMaintenanceFee(m, markets, syncAccountFeeToSlot(m, pa, markets, authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot), rate));
    creditMaintenanceFee(m, markets, syncAccountFeeToSlot(m, pb, markets, authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot), rate));
  }
  const qa = signedPositionForAsset(m, markets, pa, asset);
  const qb = signedPositionForAsset(m, markets, pb, asset);
  if (qa === 0n || qb === 0n) {
    require(qa !== 0n || qb !== 0n, PercolatorError.EngineNonProgress);
    const residueA = qa !== 0n;
    const q = residueA ? qa : qb;
    require((q > 0n ? oiLong : oiShort) === 0n, PercolatorError.EngineInvalidLeg);
    forfeitRecoveryLeg(m, markets, residueA ? pa : pb, asset, closeQ);
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    validateWithMarket(m, pa, markets);
    validateWithMarket(m, pb, markets);
    bumpPositionEpoch(residueA ? pa : pb);
    return;
  }
  forceCloseRecoveryPair(m, markets, pa, pb, asset, closeQ);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  validateWithMarket(m, pa, markets);
  validateWithMarket(m, pb, markets);
  bumpPositionEpoch(pa);
  bumpPositionEpoch(pb);
}

/** The asset index argument (u16 at 1). */
function loadAsset(data: InstructionBytes): u64 {
  return toU64(data.readU16(1n));
}
