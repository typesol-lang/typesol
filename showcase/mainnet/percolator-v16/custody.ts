// A port of Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog src/v16_program.rs,
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Changes: rewritten in TypeSOL. Ported here: `handle_sync_maintenance_fee` and `handle_withdraw`, with
// `state::market_view_mut_with_fee_carry` and `MaintenanceFeeSplitCarry::split`,
// `credit_maintenance_fee_to_active_market_budgets_view`, `collect_maintenance_fee_before_value_debit_view`,
// `reject_portfolio_pending_price_managed_mark_view`, `policy_v16::fee_share_floor` (`mul_div_u128_by_u64`),
// `verify_withdrawable_token_accounts` and `transfer_tokens_signed`. The engine code they reach is refresh.ts.
//
// Each handler is the original's, check for check in its order; the arguments are read at fixed offsets of the
// instruction data, which decode (percolator.ts) has checked to have exactly the tag's length.
//
// The legs. A Live market's portfolio with an active leg whose fee anchor has moved has its legs settled against the
// assets' K, F and B indices before the fee (`settle_account_side_effects_not_atomic`, settlement.ts); a settlement
// that stops at a B chunk is BStale. Withdraw with an active leg is then refused by the engine (EngineStale), as in the
// original: only a flat portfolio withdraws.
//
// Repeated accounts. The original holds the market's data mutably while it borrows the portfolio's and the cranker's.
// The portfolio or the cranker passed as the market is first given the portfolio's length
// (`ensure_portfolio_storage_for_market_slots`: InvalidAccountLen for a longer market, a realloc of a shorter one, after
// which the market's length is no whole number of slots and the market view refuses it), the same way in both, so no
// borrow conflict is reachable; a cranker equal to the portfolio is the original's own branch.
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenProgram,
  type u32,
  type u64,
  type u128,
  currentSlot,
  findProgramAddress,
  findProgramAddressWithBump,
  loadRawAt,
  loadRawMutAt,
  programAt,
  readData,
  require,
  u64 as toU64,
  u128 as toU128,
} from "typesol";
import { PercolatorError, V16_OK, checkV16 } from "./errors.js";
import {
  type AssetOracleProfile,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type WrapperConfig,
  HEADER_LEN,
  MARKET_GROUP_OFF,
  ORACLE_MODE_AUTH_MARK,
  ORACLE_MODE_EWMA_MARK,
  ORACLE_MODE_HYBRID_AFTER_HOURS,
  ZERO_KEY,
} from "./state.js";
import { V16_MAX_PORTFOLIO_ASSETS_N } from "./wire.js";
import { deregisterEmptyPortfolio, engineSlotAt, legErr, marketShapeErr, validateWithMarket } from "./engine.js";
import { creditAccountFromInsurance, creditDomainInsuranceBudget, syncAccountFeeToSlot, withdrawEngine } from "./refresh.js";
import { closePortfolioToMarket } from "./setup.js";
import {
  ATA_PROGRAM_ID,
  SPL_TOKEN_ID,
  advancePortfolioSequence,
  amountToU64,
  authenticatedMarketSlot,
  ensurePortfolioStorage,
  expectPortfolioAccountKey,
  expectPortfolioSequenceBinding,
  keyCheck,
  marketViewMut,
  needAccounts,
  ownerCheck,
  portfolioViewMut,
  profileFromView,
  readMarketConfigMode,
  rejectStaleLive,
  signerCheck,
  unpackTokenAccountV16,
  verifyTokenProgramV16,
  writableCheck,
} from "./program.js";

const U128_MAX_C: u128 = 0xffffffffffffffffffffffffffffffffn;

// ---- The maintenance fee's destination ----------------------------------------------------------------------------------

/**
 * `credit_maintenance_fee_to_active_market_budgets_view(fee_carry, group, amount)`: nothing for zero; otherwise the
 * amount split between asset 0's long and short insurance domains by the market's carry
 * (`MaintenanceFeeSplitCarry::split`: half each, an odd atom to the long side when the carry byte is 1, and the byte
 * flipped (xor 1) for an odd amount), each credited with `credit_domain_insurance_budget_not_atomic` (map_v16_error).
 * The carry is the wrapper config's `_padding0` byte, written in place in the original too.
 */
export function creditMaintenanceFee(m: RemainingAccount, markets: u64, amount: u128): void {
  if (amount === 0n) return;
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  const odd = (amount & 1n) === 1n;
  const long = amount / 2n + (odd && cfg.padding0 === 1n ? 1n : 0n);
  if (odd) cfg.padding0 = cfg.padding0 ^ 1n;
  creditDomainInsuranceBudget(m, markets, 0n, long);
  creditDomainInsuranceBudget(m, markets, 1n, amount - long);
}

/**
 * `policy_v16::fee_share_floor(amount, bps)`: ⌊amount · bps / 10,000⌋ (`mul_div_u128_by_u64`, rounding down), 0 for a
 * zero amount or share; its overflow (None) is EngineArithmeticOverflow at the caller.
 */
export function feeShareFloor(amount: u128, bps: u128): u128 {
  if (amount === 0n || bps === 0n) return 0n;
  const whole = amount / 10000n;
  const residue = (amount % 10000n) * bps;
  require(whole <= U128_MAX_C / bps, PercolatorError.EngineArithmeticOverflow);
  const quotient = whole * bps;
  require(quotient <= U128_MAX_C - residue / 10000n, PercolatorError.EngineArithmeticOverflow);
  return quotient + residue / 10000n;
}

/**
 * `reject_portfolio_pending_price_managed_mark_view`: for each of the 16 leg slots, the leg decoded (map_v16_error),
 * its bitmap bit equal to its active flag (EngineHiddenLeg); for an active leg, its asset configured and in the view
 * and its market id the asset's (EngineInvalidLeg), the asset's oracle profile read from the view (validated) and,
 * when price-managed (hybrid, EWMA or AuthMark), the asset's raw target, the profile's EWMA mark and its oracle target
 * all at the effective price (EngineLockActive otherwise).
 */
function rejectPendingManagedMark(m: RemainingAccount, pa: RemainingAccount, markets: u64): void {
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  const bitmap = p.active_bitmap.get(0n);
  const configured = toU64(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).config.max_market_slots);
  for (let slot = 0n; slot < V16_MAX_PORTFOLIO_ASSETS_N; slot++) {
    const leg = p.legs.get(slot);
    checkV16(legErr(leg));
    const active = ((bitmap >> slot) & 1n) !== 0n;
    require(active === (leg.active === 1n), PercolatorError.EngineHiddenLeg);
    if (!active) continue;
    const asset = toU64(leg.asset_index);
    require(asset < configured && asset < markets, PercolatorError.EngineInvalidLeg);
    const a = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset)).asset;
    require(leg.market_id === a.market_id, PercolatorError.EngineInvalidLeg);
    const profile = loadRawAt<AssetOracleProfile>(m, profileFromView(m, markets, asset));
    const mode = profile.oracle_mode;
    if (mode === ORACLE_MODE_HYBRID_AFTER_HOURS || mode === ORACLE_MODE_EWMA_MARK || mode === ORACLE_MODE_AUTH_MARK) {
      const price = a.effective_price;
      require(a.raw_oracle_target_price === price && profile.mark_ewma_e6 === price && profile.oracle_target_price_e6 === price, PercolatorError.EngineLockActive);
    }
  }
}

// ---- SyncMaintenanceFee (tag 48) ---------------------------------------------------------------------------------------

/**
 * `handle_sync_maintenance_fee(now_slot)`: accounts market (w), portfolio (w), and optionally a cranker portfolio (w)
 * that takes a share of the fee. The market and the portfolio writable and the program's; the market's config
 * (`read_market_config_mode_and_capacity`); the portfolio's storage grown if short; the cranker writable, the
 * program's and grown if short (unless it is the portfolio). The slot is the Clock's (`authenticated_slot_or_fallback`:
 * the argument is the fallback when the Clock cannot be read, which on chain it always can). Then under the market view
 * (`market_view_mut_with_fee_carry`): a live market's matured stale window refused (OracleStale); the portfolio's view
 * and account id; `reject_portfolio_pending_price_managed_mark_view`; the cranker's view, account id and validation
 * (another portfolio than this one); the fee synced to the slot (`sync_account_fee_to_slot_not_atomic` at the config's
 * rate), the cranker's share (`fee_share_floor` of the config's cranker share) credited to the cranker from the
 * insurance with the validations after it, the rest to asset 0's insurance budgets (the carry), the market's shape and
 * the portfolios validated again; and, when a fee was charged, the portfolio deregistered and closed into the market if
 * it is now empty.
 *
 * `deregister_empty_materialized_portfolio_not_atomic` returning LockActive (a portfolio that is not empty) is
 * swallowed by the original (`Err(V16Error::LockActive) => false`) and the instruction succeeds: NOTES.md site 1. The
 * port's `deregisterEmptyPortfolio` returns that code as a value and writes nothing before it, as the original.
 *
 * The cranker's share is at most the fee (the config's share is at most 10,000: `validate_wrapper_config`), so the
 * original's `charged.checked_sub(reward)` (EngineCounterUnderflow) cannot refuse.
 *
 * @noinline
 */
export function syncMaintenanceFee(rest: RemainingAccounts, programId: Pubkey): void {
  needAccounts(rest, 2n);
  const m = rest.get(0n);
  const pa = rest.get(1n);
  writableCheck(m);
  writableCheck(pa);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  readMarketConfigMode(m);
  ensurePortfolioStorage(pa);
  const cranked = rest.length > 2n;
  if (cranked) {
    const c = rest.get(2n);
    writableCheck(c);
    ownerCheck(c, programId);
    if (c.key !== pa.key) ensurePortfolioStorage(c);
  }
  const now = currentSlot();
  const markets = marketViewMut(m);
  rejectStaleLive(m);
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  rejectPendingManagedMark(m, pa, markets);
  // cfg_pre: the config read before the view, which nothing in between changes.
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const rate = cfg.maintenance_fee_per_slot;
  const share = toU128(cfg.maintenance_cranker_fee_share_bps);
  let charged: u128 = 0n;
  if (cranked && rest.get(2n).key === pa.key) {
    charged = syncAccountFeeToSlot(m, pa, markets, now, rate);
    const reward = feeShareFloor(charged, share);
    if (reward !== 0n) {
      creditAccountFromInsurance(m, pa, markets, reward);
      checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
      validateWithMarket(m, pa, markets);
    }
    creditMaintenanceFee(m, markets, charged - reward);
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    validateWithMarket(m, pa, markets);
  } else if (cranked) {
    const c = rest.get(2n);
    portfolioViewMut(c);
    expectPortfolioAccountKey(c);
    validateWithMarket(m, c, markets);
    charged = syncAccountFeeToSlot(m, pa, markets, now, rate);
    const reward = feeShareFloor(charged, share);
    if (reward !== 0n) {
      creditAccountFromInsurance(m, c, markets, reward);
      checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
      validateWithMarket(m, pa, markets);
      validateWithMarket(m, c, markets);
    }
    creditMaintenanceFee(m, markets, charged - reward);
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    validateWithMarket(m, pa, markets);
    validateWithMarket(m, c, markets);
  } else {
    charged = syncAccountFeeToSlot(m, pa, markets, now, rate);
    creditMaintenanceFee(m, markets, charged);
    checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
    validateWithMarket(m, pa, markets);
  }
  if (charged !== 0n && deregisterEmptyPortfolio(m, pa, markets) === V16_OK) closePortfolioToMarket(pa, m);
}

// ---- Withdraw (tag 4) ------------------------------------------------------------------------------------------------------

/**
 * `verify_withdrawable_token_accounts(dest, owner, vault, vault_authority, cfg, unencumbered)`: both SPL Token accounts
 * unpacked (InvalidTokenAccount), of one mint that is the market's collateral mint or its secondary one (InvalidMint);
 * the destination the owner's and Initialized (InvalidTokenAccount); the vault the vault authority's, Initialized, with
 * no delegate or close authority and at the canonical address of its mint (InvalidVaultAccount); with `unencumbered`
 * the destination without either (InvalidTokenAccount). Returns the vault's amount.
 */
export function verifyWithdrawable(dest: RemainingAccount, owner: Pubkey, vault: RemainingAccount, authority: Pubkey, m: RemainingAccount, unencumbered: boolean): u64 {
  const destState = unpackTokenAccountV16(dest);
  const vaultState = unpackTokenAccountV16(vault);
  const mint = readData<Pubkey>(dest, 0n);
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const withdrawable = mint === cfg.collateral_mint || (cfg.secondary_collateral_mint !== ZERO_KEY && mint === cfg.secondary_collateral_mint);
  require(mint === readData<Pubkey>(vault, 0n) && withdrawable, PercolatorError.InvalidMint);
  require(readData<Pubkey>(dest, 32n) === owner && destState === 1n, PercolatorError.InvalidTokenAccount);
  const shape = readData<Pubkey>(vault, 32n) === authority && vaultState === 1n && readData<u32>(vault, 72n) === 0n && readData<u32>(vault, 129n) === 0n;
  require(shape && vault.key === findProgramAddress([authority, SPL_TOKEN_ID, mint], ATA_PROGRAM_ID), PercolatorError.InvalidVaultAccount);
  // require_unencumbered_dest (CloseResolved): the destination without a delegate or a close authority.
  require(!unencumbered || (readData<u32>(dest, 72n) === 0n && readData<u32>(dest, 129n) === 0n), PercolatorError.InvalidTokenAccount);
  return readData<u64>(vault, 64n);
}

/**
 * `handle_withdraw(portfolio_id, expected_sequence, amount)`: accounts owner (signer), market (w), portfolio (w),
 * destination token account (w), vault (w), vault authority, token program. The owner signs; the four writable; the
 * market and the portfolio the program's; SPL Token; the portfolio's id and owner-state sequence; the market's config
 * and a Live mode (EngineLockActive); the vault authority PDA ["vault", market] (InvalidArgument); the token accounts
 * (`verify_withdrawable_token_accounts`). A zero amount ends there, successfully. The amount within u64
 * (InvalidInstruction); the portfolio's storage grown if short; then under the market view: Live again
 * (EngineLockActive), the stale window, the binding again, the portfolio's view, account id and owner (Unauthorized);
 * the maintenance fee collected first (`collect_maintenance_fee_before_value_debit_view`: with a nonzero rate on a Live
 * market, synced to max(Clock, the market's slot) and credited to asset 0's insurance budgets); an amount equal to the
 * capital before the fee withdraws all that is left after it; `withdraw_not_atomic`; the owner-state sequence
 * advanced; the vault's balance (read before) at least the amount (InvalidTokenAccount); the SPL Token Transfer from
 * the vault to the destination, signed by the vault authority PDA (none for 0).
 *
 * @noinline
 */
export function withdraw(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 7n);
  const owner = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  const dest = rest.get(3n);
  const vault = rest.get(4n);
  const vaultAuthority = rest.get(5n);
  const tokenProgram = rest.get(6n);
  signerCheck(owner);
  writableCheck(m);
  writableCheck(pa);
  writableCheck(dest);
  writableCheck(vault);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  verifyTokenProgramV16(tokenProgram);
  const portfolioId = data.readU64(1n);
  const expectedSequence = data.readU64(9n);
  const amount = data.readU128(17n);
  expectPortfolioSequenceBinding(pa, portfolioId, expectedSequence);
  require(readMarketConfigMode(m) === 0n, PercolatorError.EngineLockActive);
  const [authority, bump] = findProgramAddressWithBump(["vault", m.key], programId);
  keyCheck(vaultAuthority, authority);
  const balance = verifyWithdrawable(dest, owner.key, vault, authority, m, false);
  if (amount === 0n) return;
  amountToU64(amount);
  ensurePortfolioStorage(pa);
  const markets = marketViewMut(m);
  require(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode === 0n, PercolatorError.EngineLockActive);
  rejectStaleLive(m);
  expectPortfolioSequenceBinding(pa, portfolioId, expectedSequence);
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  const p = loadRawAt<Portfolio>(pa, HEADER_LEN);
  require(p.owner === owner.key, PercolatorError.Unauthorized);
  const before = p.capital;
  // collect_maintenance_fee_before_value_debit_view (the mode is Live here).
  const rate = loadRawAt<WrapperConfig>(m, HEADER_LEN).maintenance_fee_per_slot;
  if (rate !== 0n) {
    const now = authenticatedMarketSlot(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).current_slot);
    creditMaintenanceFee(m, markets, syncAccountFeeToSlot(m, pa, markets, now, rate));
  }
  const withdrawn = amount === before ? loadRawAt<Portfolio>(pa, HEADER_LEN).capital : amount;
  withdrawEngine(m, pa, markets, withdrawn);
  advancePortfolioSequence(pa, expectedSequence);
  const amount64 = amountToU64(withdrawn);
  require(balance >= amount64, PercolatorError.InvalidTokenAccount);
  if (amount64 !== 0n) programAt<TokenProgram>(tokenProgram).transfer(vault, dest, vaultAuthority, amount64, ["vault", m.key, bump]);
}
