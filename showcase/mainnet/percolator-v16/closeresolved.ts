// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs,
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// CloseResolved (tag 30) and PermissionlessCrank on a Resolved market: `handle_close_resolved`, the sole public engine
// crank on a Resolved market (autocrank.ts, resolved.ts), the maintenance fee it collects credited to market 0's
// insurance budgets (`credit_maintenance_fee_to_active_market_budgets_view`), and the payout: the SPL Token Transfer
// from the vault, signed by the vault authority PDA (`verify_withdrawable_token_accounts` with an unencumbered
// destination, `require_token_balance`, `transfer_tokens_signed`).
//
// Copies. The original reads the wrapper config into `cfg` at the market view (used afterwards only for the fee rate and
// the mints) and never writes it back; the port reads the same fields from the account, which nothing in between
// changes (the fee carry is a byte the original writes in place too).
//
// Repeated accounts. The market's data is borrowed mutably when the portfolio's storage is checked, which reads the
// portfolio's length through its RefCell (solana-program 1.18.26 `AccountInfo::data_len`): a portfolio that is the
// market panics there (src/account_info.rs:91:19; the pinocchio hook logs the file only). The token accounts are read
// after the market's borrow ends.
import {
  type FixedArray,
  type Pubkey,
  type RemainingAccounts,
  type TokenProgram,
  type u64,
  type u128,
  currentSlot,
  findProgramAddressWithBump,
  fixedArray,
  loadRawAt,
  panic,
  programAt,
  require,
} from "typesol";
import { PercolatorError, checkV16 } from "./errors.js";
import { type GroupHeader, type Portfolio, type WrapperConfig, HEADER_LEN, MARKET_GROUP_OFF } from "./state.js";
import { marketShapeErr } from "./engine.js";
import { type AutoCrank, type Observation, NONE, PLAN_CLOSE_RESOLVED, PLAN_NO_ACTION, autoCrank } from "./autocrank.js";
import { NONPROG } from "./liquidation.js";
import { creditMaintenanceFee, verifyWithdrawable } from "./custody.js";
import {
  amountToU64,
  authenticatedMarketSlot,
  ensurePortfolioStorage,
  expectPortfolioAccountKey,
  keyCheck,
  marketViewMut,
  needAccounts,
  ownerCheck,
  portfolioViewMut,
  signerCheck,
  verifyTokenProgramV16,
  writableCheck,
} from "./program.js";

/** MarketModeV16::Resolved. */
const MODE_RESOLVED_CR = 1n;

/**
 * `handle_close_resolved(fee_rate, auto_crank_now_slot, backing_asset_hint)`: accounts owner, market (w), portfolio (w),
 * then (for a payout) destination token account (w), vault (w), vault authority, token program. The market and
 * portfolio writable and the program's; the market view with the fee carry; the portfolio's storage; its view, account
 * id and owner (Unauthorized); EngineLockActive unless Resolved; the slot (the crank's: the Clock's; CloseResolved's: the
 * later of the Clock's and the market's); within the force-close delay after the resolved slot the owner must sign; the
 * engine's crank with the hint as its only observation and the config's maintenance fee rate; anything but
 * CloseResolved with an outcome is EngineNonProgress; the insurance's growth credited to market 0's budgets; the shape.
 * A payout: the four accounts (NotEnoughAccountKeys), the two token accounts writable, SPL Token, the vault authority PDA
 * ["vault", market] (InvalidArgument), the token accounts, the amount within u64, the vault's balance
 * (InvalidTokenAccount), the transfer.
 *
 * `crankSlot` is NONE for CloseResolved; `hint` the hinted asset or NONE.
 *
 * @noinline
 */
export function closeResolved(rest: RemainingAccounts, programId: Pubkey, crankSlot: u64, hint: u64): void {
  needAccounts(rest, 3n);
  const owner = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  writableCheck(m);
  writableCheck(pa);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  const markets = marketViewMut(m);
  // ensure_portfolio_storage_for_market_slots reads the portfolio's `data_len()` (a RefCell borrow) while the market's
  // data is borrowed mutably: a portfolio that is the market panics there.
  if (pa.key === m.key) panic("already mutably borrowed: BorrowError", "src/account_info.rs:91:19");
  ensurePortfolioStorage(pa);
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === owner.key, PercolatorError.Unauthorized);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.mode === MODE_RESOLVED_CR, PercolatorError.EngineLockActive);
  const slot = crankSlot === NONE ? authenticatedMarketSlot(h.current_slot) : currentSlot();
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  const delay = cfg.force_close_delay_slots;
  if (delay !== 0n && (slot > h.resolved_slot ? slot - h.resolved_slot : 0n) < delay) signerCheck(owner);
  const insuranceBefore = h.insurance;
  const obs: FixedArray<Observation, 16> = fixedArray<Observation, 16>({ asset: 0n, price: 0n, rate: 0n });
  let count = 0n;
  if (hint !== NONE) {
    obs.get(0n).asset = hint;
    count = 1n;
  }
  const r: AutoCrank = { plan: PLAN_NO_ACTION, asset: NONE, current: false, status: 0n, closed: false, payout: 0n };
  autoCrank(m, markets, pa, slot, obs, count, cfg.maintenance_fee_per_slot, r);
  require(r.plan === PLAN_CLOSE_RESOLVED && r.status !== NONPROG, PercolatorError.EngineNonProgress);
  const insurance = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).insurance;
  creditMaintenanceFee(m, markets, insurance > insuranceBefore ? insurance - insuranceBefore : 0n);
  checkV16(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), markets));
  const payout: u128 = r.closed ? r.payout : 0n;
  if (payout === 0n) return;
  needAccounts(rest, 7n);
  const dest = rest.get(3n);
  const vault = rest.get(4n);
  const vaultAuthority = rest.get(5n);
  const tokenProgram = rest.get(6n);
  writableCheck(dest);
  writableCheck(vault);
  verifyTokenProgramV16(tokenProgram);
  const [authority, bump] = findProgramAddressWithBump(["vault", m.key], programId);
  keyCheck(vaultAuthority, authority);
  const balance = verifyWithdrawable(dest, owner.key, vault, authority, m, true);
  const amount = amountToU64(payout);
  require(balance >= amount, PercolatorError.InvalidTokenAccount);
  programAt<TokenProgram>(tokenProgram).transfer(vault, dest, vaultAuthority, amount, ["vault", m.key, bump]);
}
