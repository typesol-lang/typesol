// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// A trader's free funds: DepositFunds (processor/deposit.rs) and WithdrawFunds (processor/withdraw.rs). Funds on the
// market are counted in lots in the trader's TraderState (the traders tree); tokens sit in the two vaults. A deposit
// registers the trader if needed (an approved seat is required), adds the lots and transfers lots × lot size atoms in;
// a withdrawal takes up to the requested free lots (all of them by default) and sends them out, signed by each vault.
//
// Accounts, after the entry's four (program, log authority, market, trader):
// - DepositFunds: seat, base account, quote account, base vault, quote vault, SPL Token;
// - WithdrawFunds: base account, quote account, base vault, quote vault, SPL Token.
import { type MarketHeader, type TraderState, tradersOffset } from "./state.js";
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenProgram,
  ProgramError,
  loadRaw,
  log,
  logComputeUnits,
  programAt,
  rbTreeMutAt,
  require,
  u8,
  u32,
  u64,
} from "typesol";
import { PhoenixError } from "./errors.js";
import { assertPostAllowed, assertReduceAllowed, checkSeatWithContext, checkVaultContext, dispatchLoadedMarket } from "./checkers.js";
import { addBaseLots, addQuoteLots, baseLotsToAtoms, emptyTraderState, need, quoteLotsToAtoms, subBaseLots, subQuoteLots } from "./util.js";

/** process_deposit_funds: DepositParams { quote_lots_to_deposit, base_lots_to_deposit } after the tag. */
export function depositFunds(rest: RemainingAccounts, data: InstructionBytes): void {
  const market = rest.get(2n);
  const trader = rest.get(3n);
  // DepositContext::load.
  assertPostAllowed(market);
  need(rest, 5n);
  checkSeatWithContext(rest.get(4n), market.key, trader.key, true);
  checkVaultContext(rest, 5n, market, trader.key);
  require(data.length === 17n, ProgramError.BorshIoError);
  const quoteLots = data.readU64(1n);
  const baseLots = data.readU64(9n);

  dispatchLoadedMarket(market);
  const h = loadRaw<MarketHeader>(market);
  const traders = rbTreeMutAt<Pubkey, TraderState>(market, tradersOffset(h.market_size_params.bids_size), h.market_size_params.num_seats);
  // get_or_register_trader, then get_trader_state_mut (TraderNotFound when the traders tree is full).
  let index = u64(traders.addrOf(trader.key));
  if (index === 0n) {
    const added = traders.insert(trader.key, emptyTraderState());
    require(added !== null, PhoenixError.TraderNotFound);
    index = u64(added!);
  }
  const state = traders.nodeAt(u32(index)).value;
  state.base_lots_free = addBaseLots(state.base_lots_free, baseLots);
  state.quote_lots_free = addQuoteLots(state.quote_lots_free, quoteLots);

  // try_deposit: quote first, then base; a zero amount is not transferred.
  const quoteAtoms = quoteLotsToAtoms(quoteLots, h.quote_lot_size);
  const baseAtoms = baseLotsToAtoms(baseLots, h.base_lot_size);
  const token = programAt<TokenProgram>(rest.get(9n));
  if (quoteAtoms > 0n) token.transfer(rest.get(6n), rest.get(8n), trader, quoteAtoms);
  if (baseAtoms > 0n) token.transfer(rest.get(5n), rest.get(7n), trader, baseAtoms);
}

/**
 * process_withdraw_funds: WithdrawParams { quote_lots_to_withdraw: Option<u64>, base_lots_to_withdraw: Option<u64> }
 * after the tag (None: all the free lots).
 */
export function withdrawFunds(rest: RemainingAccounts, data: InstructionBytes): void {
  const market = rest.get(2n);
  const trader = rest.get(3n);
  // CancelOrWithdrawContext::load.
  assertReduceAllowed(market);
  checkVaultContext(rest, 4n, market, trader.key);
  // Two Borsh Options: a tag (0 or 1), then the u64 when 1; nothing after.
  require(data.length >= 2n && data.readU8(1n) <= 1n, ProgramError.BorshIoError);
  const hasQuote = data.readU8(1n) === 1n;
  const at = hasQuote ? 10n : 2n;
  require(data.length >= at + 1n && data.readU8(at) <= 1n, ProgramError.BorshIoError);
  const hasBase = data.readU8(at) === 1n;
  require(data.length === at + (hasBase ? 9n : 1n), ProgramError.BorshIoError);
  processWithdraw(rest, 4n, trader.key, hasQuote, hasQuote ? data.readU64(2n) : 0n, hasBase, hasBase ? data.readU64(at + 1n) : 0n, false);
}

/**
 * process_withdraw (also EvictSeat's, with `evictSeat`): claim the free lots, then send them from the vaults. The
 * vault accounts are the five from position `vaults` (base account, quote account, base vault, quote vault, SPL
 * Token). Phoenix logs the compute units left four times on the way (sol_log_compute_units); the third comes only
 * once the claim succeeded.
 */
export function processWithdraw(
  rest: RemainingAccounts,
  vaults: u64,
  trader: Pubkey,
  hasQuote: boolean,
  quoteLotsRequested: u64,
  hasBase: boolean,
  baseLotsRequested: u64,
  evictSeat: boolean,
): void {
  logComputeUnits();
  logComputeUnits();
  const market = rest.get(2n);
  dispatchLoadedMarket(market);
  const h = loadRaw<MarketHeader>(market);
  const traders = rbTreeMutAt<Pubkey, TraderState>(market, tradersOffset(h.market_size_params.bids_size), h.market_size_params.num_seats);
  // claim_funds: None (WithdrawFundsError) for a trader with no state.
  const index = traders.addrOf(trader);
  require(index !== 0n, PhoenixError.WithdrawFundsError);
  const state = traders.nodeAt(index).value;
  const freeQuote = state.quote_lots_free;
  const freeBase = state.base_lots_free;
  const quoteLots = hasQuote && quoteLotsRequested < freeQuote ? quoteLotsRequested : freeQuote;
  const baseLots = hasBase && baseLotsRequested < freeBase ? baseLotsRequested : freeBase;
  state.quote_lots_free = subQuoteLots(freeQuote, quoteLots);
  state.base_lots_free = subBaseLots(freeBase, baseLots);
  if (evictSeat && isEmpty(state)) traders.removeAt(index); // remove(&trader), at the node found above
  logComputeUnits();
  if (evictSeat && traders.addrOf(trader) !== 0n) {
    log("Trader was not evicted, there are still orders on the book. \nsrc/program/processor/withdraw.rs:87:13");
    require(false, PhoenixError.EvictionError);
  }
  logComputeUnits();
  tryWithdraw(rest, vaults, quoteLots, baseLots);
}

/**
 * token_utils.rs try_withdraw (process_withdraw's, and the reductions' and cancels' of what they released): quote lots
 * × quote lot size, then base lots × base lot size, sent quote first, each from its vault signed by the vault PDA. The
 * vault context is the five accounts from position `vaults` (base account, quote account, base vault, quote vault,
 * SPL Token).
 */
export function tryWithdraw(rest: RemainingAccounts, vaults: u64, quoteLots: u64, baseLots: u64): void {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  const quoteAtoms = quoteLotsToAtoms(quoteLots, h.quote_lot_size);
  const baseAtoms = baseLotsToAtoms(baseLots, h.base_lot_size);
  const token = programAt<TokenProgram>(rest.get(vaults + 4n));
  sendFromVault(token, market.key, h.quote_params.mint_key, h.quote_params.vault_bump, rest.get(vaults + 3n), rest.get(vaults + 1n), quoteAtoms);
  sendFromVault(token, market.key, h.base_params.mint_key, h.base_params.vault_bump, rest.get(vaults + 2n), rest.get(vaults), baseAtoms);
}

/** `*trader_state == TraderState::default()`: every field zero, the padding too. */
function isEmpty(s: TraderState): boolean {
  if (s.quote_lots_locked !== 0n || s.quote_lots_free !== 0n || s.base_lots_locked !== 0n || s.base_lots_free !== 0n) return false;
  for (const w of s.padding) if (w !== 0n) return false;
  return true;
}

/** token_utils.rs maybe_invoke_withdraw: an SPL Token Transfer out of a vault (its own authority), when non-zero. */
export function sendFromVault(
  token: TokenProgram,
  market: Pubkey,
  mint: Pubkey,
  vaultBump: u32,
  vault: RemainingAccount,
  to: RemainingAccount,
  amount: u64,
): void {
  if (amount !== 0n) token.transfer(vault, to, vault, amount, ["vault", market, mint, u8(vaultBump & 0xffn)]);
}
