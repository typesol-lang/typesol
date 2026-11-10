// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// InitializeMarket (processor/initialize.rs). The market account was allocated by the client, owned by Phoenix and
// zeroed; the instruction creates the two token vaults (PDAs ["vault", market, mint], each its own authority),
// initializes the FIFOMarket's trees and parameters and writes the header. The market starts PostOnly, the creator its
// authority and successor.
//
// Accounts, after the entry's four (program, log authority, market, creator: a writable signer, the vaults' payer):
// base mint, quote mint, base vault, quote vault, System Program, SPL Token.
import {
  type FIFOOrderId,
  type FIFORestingOrder,
  type FifoMarketPrefix,
  type MarketHeader,
  type TraderState,
  BIDS_OFFSET,
  FIFO_MARKET_OFFSET,
  MARKET_DISCRIMINANT_LOG,
  MARKET_HEADER_DISCRIMINANT,
  MARKET_STATUS_POST_ONLY,
  TOKEN_ACCOUNT_LEN,
  asksOffset,
  tradersOffset,
} from "./state.js";
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenProgram,
  type u8,
  ProgramError,
  createProgramAddress,
  findProgramAddressBump,
  loadRawMut,
  loadRawMutAt,
  log,
  panicsAt,
  programAt,
  rbTreeMutAt,
  require,
  u32,
  u64,
} from "typesol";
import { PhoenixError } from "./errors.js";
import { checkEmptyAccount, checkMint, checkSystemProgram, checkTokenProgram, dispatchMarket } from "./checkers.js";
import { PHOENIX_ID, TOKEN_PROGRAM_ID, createPda, need, orderCmp, pow10 } from "./util.js";

/**
 * One vault: its address must be the PDA ["vault", market, mint]; created (owned by SPL Token, 165 bytes) and
 * initialized as a token account of `mint` whose owner is the vault itself. Returns its bump.
 */
function createVault(rest: RemainingAccounts, market: Pubkey, vault: RemainingAccount, mint: RemainingAccount): u8 {
  const bump = findProgramAddressBump(["vault", market, mint.key], PHOENIX_ID);
  const key = createProgramAddress(["vault", market, mint.key, bump], PHOENIX_ID)!;
  if (key !== vault.key) {
    log(`Supplied vault (${vault.key}) does not match computed key (${key}). \nsrc/program/processor/initialize.rs:165:9`);
    require(false, PhoenixError.InvalidMarketSigner);
  }
  createPda(rest.get(3n), vault, rest.get(8n), TOKEN_PROGRAM_ID, TOKEN_ACCOUNT_LEN, "vault", market, mint.key, bump);
  programAt<TokenProgram>(rest.get(9n)).initializeAccount3(vault, mint, vault.key);
  return bump;
}

/** process_initialize_market. `data` is the instruction data, InitializeParams (Borsh) after the tag. */
export function initializeMarket(rest: RemainingAccounts, data: InstructionBytes): void {
  const market = rest.get(2n);
  // InitializeMarketContext::load: each account checked as it is taken.
  need(rest, 5n);
  const baseDecimals = checkMint(rest.get(4n));
  need(rest, 6n);
  const quoteDecimals = checkMint(rest.get(5n));
  need(rest, 7n);
  checkEmptyAccount(rest.get(6n));
  need(rest, 8n);
  checkEmptyAccount(rest.get(7n));
  need(rest, 9n);
  checkSystemProgram(rest.get(8n));
  need(rest, 10n);
  checkTokenProgram(rest.get(9n));

  // InitializeParams::try_from_slice: 82 bytes, then Option<u32> (tag 0, or 1 and 4 bytes), and nothing after.
  require(data.length >= 84n && data.readU8(83n) <= 1n, ProgramError.BorshIoError);
  const hasRaw = data.readU8(83n) === 1n;
  require(data.length === (hasRaw ? 88n : 84n), ProgramError.BorshIoError);
  const bidsSize = data.readU64(1n);
  const asksSize = data.readU64(9n);
  const numSeats = data.readU64(17n);
  const quoteLotsPerQuoteUnit = data.readU64(25n);
  const tickSizeInQuoteLotsPerBaseUnit = data.readU64(33n);
  const baseLotsPerBaseUnit = data.readU64(41n);
  const takerFeeBps = data.readU16(49n);
  const feeCollector = data.readPubkey(51n);
  const rawBaseUnitsPerBaseUnit = hasRaw ? data.readU32(84n) : u32(1n);

  if (takerFeeBps > 10000n) {
    log("Taker fee must be less than or equal to 10000 basis points (100%). \nsrc/program/processor/initialize.rs:102:5");
    require(false, ProgramError.InvalidInstructionData);
  }
  const baseAtomsPerBaseUnit = panicsAt("src/program/processor/initialize.rs:109:9", pow10(baseDecimals) * u64(rawBaseUnitsPerBaseUnit));
  const quoteAtomsPerQuoteUnit = pow10(quoteDecimals);
  // BaseAtomsPerBaseUnit % BaseLotsPerBaseUnit, QuoteAtomsPerQuoteUnit % QuoteLotsPerQuoteUnit: a zero divisor panics.
  if (panicsAt("src/quantities.rs:296:1", baseAtomsPerBaseUnit % baseLotsPerBaseUnit) !== 0n) {
    log(
      `Base lots per base unit (${baseLotsPerBaseUnit}) must be a factor of base atoms per base unit (${baseAtomsPerBaseUnit}). \nsrc/program/processor/initialize.rs:114:5`,
    );
    require(false, PhoenixError.InvalidLotSize);
  }
  if (panicsAt("src/quantities.rs:297:1", quoteAtomsPerQuoteUnit % quoteLotsPerQuoteUnit) !== 0n) {
    log(
      `Quote lots per quote unit (${quoteLotsPerQuoteUnit}) must be a factor of quote atoms per quote unit (${quoteAtomsPerQuoteUnit}). \nsrc/program/processor/initialize.rs:122:5`,
    );
    require(false, PhoenixError.InvalidLotSize);
  }
  // Both divisions are exact (checked above), so the Div impls' "WARNING: Expected clean division" never logs.
  const quoteLotSize = quoteAtomsPerQuoteUnit / quoteLotsPerQuoteUnit;
  const tickSizeInQuoteAtomsPerBaseUnit = panicsAt("src/quantities.rs:280:1", quoteLotSize * tickSizeInQuoteLotsPerBaseUnit);
  log(
    `Market parameters:\n        num_quote_lots_per_quote_unit: ${quoteLotsPerQuoteUnit}, \n        tick_size_in_quote_lots_per_base_unit: ${tickSizeInQuoteLotsPerBaseUnit}, \n        num_base_lots_per_base_unit: ${baseLotsPerBaseUnit},\n        tick_size_in_quote_atoms_per_base_unit: ${tickSizeInQuoteAtomsPerBaseUnit},`,
  );
  // A trade of 1 base lot at 1 tick must be a whole number of quote lots.
  if (panicsAt("src/quantities.rs:298:1", tickSizeInQuoteLotsPerBaseUnit % baseLotsPerBaseUnit) !== 0n) {
    log("The number of quote lots per tick be a multiple of the number of base lots per base unit. \nsrc/program/processor/initialize.rs:151:5");
    require(false, ProgramError.InvalidInstructionData);
  }

  const baseVaultBump = createVault(rest, market.key, rest.get(6n), rest.get(4n));
  const quoteVaultBump = createVault(rest, market.key, rest.get(7n), rest.get(5n));

  // The FIFOMarket over `&data[576..]`, sized by the parameters (not the header, still empty).
  dispatchMarket(market, bidsSize, asksSize, numSeats, true);
  const fifo = loadRawMutAt<FifoMarketPrefix>(market, FIFO_MARKET_OFFSET);
  if (fifo.order_sequence_number !== 0n) {
    log("Market must have a sequence number of 0. \nsrc/program/processor/initialize.rs:210:9");
    require(false, PhoenixError.MarketAlreadyInitialized);
  }
  // initialize_with_params: the three allocators (each panics unless all zero), then the parameters; the order
  // sequence number goes from 0 to 1, which marks the market initialized.
  const bids = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, BIDS_OFFSET, bidsSize, orderCmp);
  bids.initialize();
  const asks = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, asksOffset(bidsSize), asksSize, orderCmp);
  asks.initialize();
  const traders = rbTreeMutAt<Pubkey, TraderState>(market, tradersOffset(bidsSize), numSeats);
  traders.initialize();
  fifo.tick_size_in_quote_lots_per_base_unit = tickSizeInQuoteLotsPerBaseUnit;
  fifo.base_lots_per_base_unit = baseLotsPerBaseUnit;
  fifo.order_sequence_number = 1n;
  fifo.taker_fee_bps = u64(takerFeeBps);

  // MarketHeader::new (which computes, and logs, the discriminant), written over all 576 bytes.
  log(MARKET_DISCRIMINANT_LOG);
  const h = loadRawMut<MarketHeader>(market);
  h.discriminant = MARKET_HEADER_DISCRIMINANT;
  h.status = MARKET_STATUS_POST_ONLY;
  h.market_size_params.bids_size = bidsSize;
  h.market_size_params.asks_size = asksSize;
  h.market_size_params.num_seats = numSeats;
  h.base_params.decimals = u32(baseDecimals);
  h.base_params.vault_bump = u32(baseVaultBump);
  h.base_params.mint_key = rest.get(4n).key;
  h.base_params.vault_key = rest.get(6n).key;
  h.base_lot_size = baseAtomsPerBaseUnit / baseLotsPerBaseUnit;
  h.quote_params.decimals = u32(quoteDecimals);
  h.quote_params.vault_bump = u32(quoteVaultBump);
  h.quote_params.mint_key = rest.get(5n).key;
  h.quote_params.vault_key = rest.get(7n).key;
  h.quote_lot_size = quoteLotSize;
  h.tick_size_in_quote_atoms_per_base_unit = tickSizeInQuoteAtomsPerBaseUnit;
  h.authority = rest.get(3n).key;
  h.fee_recipient = feeCollector;
  h.market_sequence_number = 0n;
  h.successor = rest.get(3n).key;
  h.raw_base_units_per_base_unit = rawBaseUnitsPerBaseUnit;
  h.padding1 = 0n;
  for (let i = 0n; i < 32n; i++) h.padding2.set(i, 0n);
}
