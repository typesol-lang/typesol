// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// Fees (processor/fees.rs). Takers pay fees in quote lots, which accrue in the FIFOMarket's unclaimed fees. Anyone may
// sweep them to the fee recipient's quote token account (CollectFees, which records a Fee event); the market
// authority names the recipient (ChangeFeeRecipient), with the current recipient's signature when fees are still
// uncollected.
//
// Accounts, after the entry's four (program, log authority, market, signer):
// - CollectFees: the fee recipient's quote token account, the quote vault, SPL Token;
// - ChangeFeeRecipient (signer: the authority): the new recipient, then optionally the current one (signing).
import { type FifoMarketPrefix, type MarketHeader, type PhoenixMarketEvent, FIFO_MARKET_OFFSET } from "./state.js";
import {
  type FixedVec,
  type Inout,
  type RemainingAccounts,
  type TokenProgram,
  type u8,
  ProgramError,
  loadRaw,
  loadRawMut,
  loadRawMutAt,
  log,
  loadRawAt,
  programAt,
  require,
  u16,
} from "typesol";
import { type Recorder, FEE_EVENT_LEN, makeRoom } from "./recorder.js";
import { assertValidAuthority, checkTokenAccountOwner, checkTokenProgram, checkVault, dispatchLoadedMarket, isSignerWithKey } from "./checkers.js";
import { sendFromVault } from "./funds.js";
import { addQuoteLots, decimalString, need, quoteLotsToAtoms } from "./util.js";

/** process_collect_fees: the unclaimed fees move to the collected total and out to the fee recipient's account. */
export function collectFees(rest: RemainingAccounts, rec: Inout<Recorder>, data: Inout<FixedVec<u8, 1280>>): void {
  const market = rest.get(2n);
  const h = loadRaw<MarketHeader>(market);
  // CollectFeesContext::load.
  need(rest, 5n);
  checkTokenAccountOwner(rest.get(4n), h.quote_params.mint_key, h.fee_recipient);
  need(rest, 6n);
  checkVault(rest.get(5n), h.quote_params.mint_key, h.quote_params.vault_key);
  need(rest, 7n);
  checkTokenProgram(rest.get(6n));

  dispatchLoadedMarket(market);
  const fifo = loadRawMutAt<FifoMarketPrefix>(market, FIFO_MARKET_OFFSET);
  const quoteLots = fifo.unclaimed_quote_lot_fees;
  fifo.collected_quote_lot_fees = addQuoteLots(fifo.collected_quote_lot_fees, quoteLots);
  fifo.unclaimed_quote_lot_fees = 0n;
  makeRoom(rec, data, rest, FEE_EVENT_LEN);
  data.pushBorsh<PhoenixMarketEvent>({ kind: "Fee", index: u16(rec.eventsAdded), fees_collected_in_quote_lots: quoteLots });
  rec.eventsAdded++;

  const quoteAtoms = quoteLotsToAtoms(quoteLots, h.quote_lot_size);
  log(`Collected ${decimalString(quoteAtoms, h.quote_params.decimals)} in fees`);
  sendFromVault(programAt<TokenProgram>(rest.get(6n)), market.key, h.quote_params.mint_key, h.quote_params.vault_bump, rest.get(5n), rest.get(4n), quoteAtoms);
}

/** process_change_fee_recipient. */
export function changeFeeRecipient(rest: RemainingAccounts): void {
  const market = rest.get(2n);
  // ChangeFeeRecipientContext::load: the previous recipient is optional; a wrong one is logged and ignored.
  assertValidAuthority(market, rest.get(3n).key);
  const h = loadRawMut<MarketHeader>(market);
  need(rest, 5n);
  const previousSigned = rest.length > 5n ? isSignerWithKey(rest.get(5n), h.fee_recipient) : false;
  dispatchLoadedMarket(market);
  if (loadRawAt<FifoMarketPrefix>(market, FIFO_MARKET_OFFSET).unclaimed_quote_lot_fees > 0n && !previousSigned) {
    log("Previous fee recipient must sign if there are uncollected fees. \nsrc/program/processor/fees.rs:81:9");
    require(false, ProgramError.MissingRequiredSignature);
  }
  h.fee_recipient = rest.get(4n).key;
}
