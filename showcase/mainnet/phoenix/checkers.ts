// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// The account checks (program/validation/checkers/*.rs) and the market loader (program/dispatch_market.rs).
//
// Every check is Phoenix's `assert_with_msg(cond, err, msg)`: on failure it logs `"{msg}. \n{location}"` (one line with
// a newline inside; the location is the assert's call site, `#[track_caller]`) and returns `err`. Here each is that log
// line and a `require(false, …)` with the same error, in the original's order. (The port's failure path writes one more
// line, the error's name: the compiler logs every failure. See the test's notes.)
//
// The checks are helpers over remaining accounts by position, as Phoenix's loaders take them from an iterator:
// `need(rest, n)` first where the original's `next_account_info` would run out (NotEnoughAccountKeys, no log).
import {
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type u8,
  type u32,
  u64,
  ProgramError,
  findProgramAddress,
  loadRaw,
  loadRawAt,
  log,
  panic,
  readData,
  require,
} from "typesol";
import { PhoenixError } from "./errors.js";
import {
  type FifoMarketPrefix,
  type MarketHeader,
  type Seat,
  FIFO_MARKET_OFFSET,
  MARKET_DISCRIMINANT_LOG,
  MARKET_HEADER_DISCRIMINANT,
  MARKET_HEADER_SIZE,
  MARKET_STATUS_ACTIVE,
  MARKET_STATUS_CLOSED,
  MARKET_STATUS_PAUSED,
  MARKET_STATUS_POST_ONLY,
  SEAT_APPROVED,
  SEAT_DISCRIMINANT,
  SEAT_DISCRIMINANT_LOG,
  SEAT_SIZE,
  TOKEN_ACCOUNT_LEN,
  fifoMarketSize,
  isSupportedSize,
} from "./state.js";
import { LOG_AUTHORITY_ID, PHOENIX_ID, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, need, sliceEndPanic } from "./util.js";

// ---- checkers/mod.rs ----------------------------------------------------------------------------------------------

/** Program::new(info, &crate::id()). */
export function checkPhoenixProgram(a: RemainingAccount): void {
  if (a.key !== PHOENIX_ID) {
    log("Incorrect program id. \nsrc/program/validation/checkers/mod.rs:55:9");
    require(false, ProgramError.IncorrectProgramId);
  }
}

/** Program::new(info, &system_program::id()). */
export function checkSystemProgram(a: RemainingAccount): void {
  if (a.key !== SYSTEM_PROGRAM_ID) {
    log("Incorrect program id. \nsrc/program/validation/checkers/mod.rs:55:9");
    require(false, ProgramError.IncorrectProgramId);
  }
}

/** Program::new(info, &spl_token::id()). */
export function checkTokenProgram(a: RemainingAccount): void {
  if (a.key !== TOKEN_PROGRAM_ID) {
    log("Incorrect program id. \nsrc/program/validation/checkers/mod.rs:55:9");
    require(false, ProgramError.IncorrectProgramId);
  }
}

/** PDA::new(info, &phoenix_log_authority::id()). */
export function checkLogAuthority(a: RemainingAccount): void {
  if (a.key !== LOG_AUTHORITY_ID) {
    log("Incorrect account key. \nsrc/program/validation/checkers/mod.rs:22:9");
    require(false, ProgramError.InvalidInstructionData);
  }
}

/** Signer::new. */
export function checkSigner(a: RemainingAccount): void {
  if (!a.isSigner) {
    log("Missing required signature. \nsrc/program/validation/checkers/mod.rs:85:9");
    require(false, ProgramError.MissingRequiredSignature);
  }
}

/** Signer::new_payer: writable, then signed. */
export function checkPayer(a: RemainingAccount): void {
  if (!a.isWritable) {
    log("Payer is not writable. \nsrc/program/validation/checkers/mod.rs:107:9");
    require(false, ProgramError.InvalidInstructionData);
  }
  if (!a.isSigner) {
    log("Missing required signature for payer. \nsrc/program/validation/checkers/mod.rs:112:9");
    require(false, ProgramError.MissingRequiredSignature);
  }
}

/**
 * `Signer::new_with_key(a, key).ok()`: whether `a` signed and is `key`. The failed check's line is logged even though
 * the caller only keeps the Option (ChangeFeeRecipient's previous fee recipient).
 */
export function isSignerWithKey(a: RemainingAccount, key: Pubkey): boolean {
  if (!a.isSigner) {
    log("Missing required signature. \nsrc/program/validation/checkers/mod.rs:85:9");
    return false;
  }
  if (a.key !== key) {
    log("Incorrect key for signer. \nsrc/program/validation/checkers/mod.rs:98:9");
    return false;
  }
  return true;
}

/** EmptyAccount::new: no data, owned by the System Program. */
export function checkEmptyAccount(a: RemainingAccount): void {
  if (a.dataLen !== 0n) {
    log("Account must be uninitialized. \nsrc/program/validation/checkers/mod.rs:142:9");
    require(false, ProgramError.InvalidAccountData);
  }
  if (a.owner !== SYSTEM_PROGRAM_ID) {
    log("Empty accounts must be owned by the system program. \nsrc/program/validation/checkers/mod.rs:147:9");
    require(false, ProgramError.IllegalOwner);
  }
}

// ---- token_checkers.rs --------------------------------------------------------------------------------------------

/**
 * MintAccountInfo::new: owned by SPL Token, then `Mint::unpack` (exactly 82 bytes, InvalidAccountData; COption tags
 * of 0 or 1 and an is_initialized byte of 0 or 1, InvalidAccountData, read in that order; not initialized:
 * UninitializedAccount). Returns the decimals.
 */
export function checkMint(a: RemainingAccount): u64 {
  if (a.owner !== TOKEN_PROGRAM_ID) {
    log("Mint account must be owned by the Token Program. \nsrc/program/validation/checkers/token_checkers.rs:16:9");
    require(false, ProgramError.IllegalOwner);
  }
  require(a.dataLen === 82n, ProgramError.InvalidAccountData);
  // mint_authority: COption<Pubkey> (u32 tag, key), supply u64, decimals u8, is_initialized u8, freeze_authority.
  const authorityTag = readData<u32>(a, 0n);
  require(authorityTag <= 1n, ProgramError.InvalidAccountData);
  const initialized = readData<u8>(a, 45n);
  require(initialized <= 1n, ProgramError.InvalidAccountData);
  require(readData<u32>(a, 46n) <= 1n, ProgramError.InvalidAccountData);
  require(initialized === 1n, ProgramError.UninitializedAccount);
  return u64(readData<u8>(a, 44n));
}

/** TokenAccountInfo::new: owned by SPL Token, 165 bytes, of `mint`. */
export function checkTokenAccount(a: RemainingAccount, mint: Pubkey): void {
  if (a.owner !== TOKEN_PROGRAM_ID) {
    log("Token account must be owned by the Token Program. \nsrc/program/validation/checkers/token_checkers.rs:51:9");
    require(false, ProgramError.IllegalOwner);
  }
  if (a.dataLen !== TOKEN_ACCOUNT_LEN) {
    log("Token account data length must be 165 bytes. \nsrc/program/validation/checkers/token_checkers.rs:56:9");
    require(false, ProgramError.InvalidAccountData);
  }
  if (readData<Pubkey>(a, 0n) !== mint) {
    log("Token account mint mismatch. \nsrc/program/validation/checkers/token_checkers.rs:62:9");
    require(false, ProgramError.InvalidAccountData);
  }
}

/** TokenAccountInfo::new_with_owner: and owned (token-wise) by `owner`. */
export function checkTokenAccountOwner(a: RemainingAccount, mint: Pubkey, owner: Pubkey): void {
  checkTokenAccount(a, mint);
  if (readData<Pubkey>(a, 32n) !== owner) {
    log("Token account owner mismatch. \nsrc/program/validation/checkers/token_checkers.rs:77:9");
    require(false, ProgramError.IllegalOwner);
  }
}

/** TokenAccountInfo::new_with_owner_and_key: a vault, at its address and its own owner. */
export function checkVault(a: RemainingAccount, mint: Pubkey, vault: Pubkey): void {
  if (a.key !== vault) {
    log("Invalid pubkey for Token Account. \nsrc/program/validation/checkers/token_checkers.rs:91:9");
    require(false, ProgramError.InvalidInstructionData);
  }
  checkTokenAccountOwner(a, mint, vault);
}

/**
 * PhoenixVaultContext::load_from_iter: from position `at`, the trader's base and quote token accounts, the two vaults
 * and the token program.
 */
export function checkVaultContext(rest: RemainingAccounts, at: u64, market: RemainingAccount, trader: Pubkey): void {
  const h = loadRaw<MarketHeader>(market);
  need(rest, at + 1n);
  checkTokenAccountOwner(rest.get(at), h.base_params.mint_key, trader);
  need(rest, at + 2n);
  checkTokenAccountOwner(rest.get(at + 1n), h.quote_params.mint_key, trader);
  need(rest, at + 3n);
  checkVault(rest.get(at + 2n), h.base_params.mint_key, h.base_params.vault_key);
  need(rest, at + 4n);
  checkVault(rest.get(at + 3n), h.quote_params.mint_key, h.quote_params.vault_key);
  need(rest, at + 5n);
  checkTokenProgram(rest.get(at + 4n));
}

// ---- phoenix_checkers.rs: the market --------------------------------------------------------------------------------

/**
 * MarketAccountInfo::new: owned by Phoenix, the header read (`&data[..576]`, a slice panic when shorter), its
 * discriminant computed (and logged) and compared.
 */
export function checkMarket(m: RemainingAccount): void {
  if (m.owner !== PHOENIX_ID) {
    log("Market must be owned by the Phoenix program. \nsrc/program/validation/checkers/phoenix_checkers.rs:29:9");
    require(false, ProgramError.IllegalOwner);
  }
  if (m.dataLen < MARKET_HEADER_SIZE) sliceEndPanic(MARKET_HEADER_SIZE, m.dataLen);
  const h = loadRaw<MarketHeader>(m);
  log(MARKET_DISCRIMINANT_LOG);
  if (h.discriminant !== MARKET_HEADER_DISCRIMINANT) {
    log("Invalid market discriminant. \nsrc/program/validation/checkers/phoenix_checkers.rs:45:9");
    require(false, ProgramError.InvalidAccountData);
  }
}

/**
 * MarketAccountInfo::new_init: the header split off (`split_at(576)`, which panics at its caller when shorter), then
 * owned by Phoenix, discriminant 0 and status Uninitialized.
 */
export function checkMarketInit(m: RemainingAccount): void {
  if (m.dataLen < MARKET_HEADER_SIZE) panic("assertion failed: mid <= self.len()", "src/program/validation/checkers/phoenix_checkers.rs:114:46");
  if (m.owner !== PHOENIX_ID) {
    log("Market must be owned by the Phoenix program. \nsrc/program/validation/checkers/phoenix_checkers.rs:117:9");
    require(false, ProgramError.IllegalOwner);
  }
  const h = loadRaw<MarketHeader>(m);
  if (h.discriminant !== 0n) {
    log("Expected uninitialized market with discriminant 0. \nsrc/program/validation/checkers/phoenix_checkers.rs:123:9");
    require(false, ProgramError.InvalidAccountData);
  }
  if (h.status !== 0n) {
    log("MarketStatus must be uninitialized. \nsrc/program/validation/checkers/phoenix_checkers.rs:128:9");
    require(false, ProgramError.InvalidAccountData);
  }
}

/** MarketStatus's Display. */
export function statusName(status: u64): string {
  if (status === 0n) return "Uninitialized";
  if (status === MARKET_STATUS_ACTIVE) return "Active";
  if (status === MARKET_STATUS_POST_ONLY) return "PostOnly";
  if (status === MARKET_STATUS_PAUSED) return "Paused";
  if (status === MARKET_STATUS_CLOSED) return "Closed";
  if (status === 5n) return "Tombstoned";
  // MarketStatus::from: only Phoenix writes the header, so this is never reached.
  panic("Invalid market status", "src/program/status.rs:52:18");
}

/** assert_post_allowed: Active or PostOnly. */
export function assertPostAllowed(m: RemainingAccount): void {
  const status = loadRaw<MarketHeader>(m).status;
  if (status !== MARKET_STATUS_ACTIVE && status !== MARKET_STATUS_POST_ONLY) {
    log(`Post only order is not allowed, market status is ${statusName(status)}. \nsrc/program/validation/checkers/phoenix_checkers.rs:82:9`);
    require(false, ProgramError.InvalidAccountData);
  }
}

/** assert_reduce_allowed: Active, PostOnly, Paused or Closed. */
export function assertReduceAllowed(m: RemainingAccount): void {
  const status = loadRaw<MarketHeader>(m).status;
  if (status === 0n || status > MARKET_STATUS_CLOSED) {
    log(`Reduce order is not allowed, market status is ${statusName(status)}. \nsrc/program/validation/checkers/phoenix_checkers.rs:59:9`);
    require(false, ProgramError.InvalidAccountData);
  }
}

/** assert_cross_allowed: Active only. */
export function assertCrossAllowed(m: RemainingAccount): void {
  const status = loadRaw<MarketHeader>(m).status;
  if (status !== MARKET_STATUS_ACTIVE) {
    log(`FOK and IOC orders are not allowed, market status is ${statusName(status)}. \nsrc/program/validation/checkers/phoenix_checkers.rs:69:9`);
    require(false, ProgramError.InvalidAccountData);
  }
}

/** assert_valid_authority. */
export function assertValidAuthority(m: RemainingAccount, authority: Pubkey): void {
  if (loadRaw<MarketHeader>(m).authority !== authority) {
    log("Invalid market authority. \nsrc/program/validation/checkers/phoenix_checkers.rs:94:9");
    require(false, PhoenixError.InvalidMarketAuthority);
  }
}

/** assert_valid_successor. */
export function assertValidSuccessor(m: RemainingAccount, successor: Pubkey): void {
  if (loadRaw<MarketHeader>(m).successor !== successor) {
    log("Invalid market successor. \nsrc/program/validation/checkers/phoenix_checkers.rs:103:9");
    require(false, PhoenixError.InvalidMarketAuthority);
  }
}

/**
 * dispatch_market_mut: one of the twelve FIFOMarket sizes ("Invalid parameters for market", Custom 0), the FIFOMarket
 * cast over `&data[576..]` (sokoban's `&data[..size]`, a slice panic when the account is short), and, except when the
 * market is being initialized, an order sequence number above 0. The caller then makes the trees it needs (a tree is
 * a view of the function that makes it): bids at BIDS_OFFSET, asks at asksOffset(bids), traders at tradersOffset(bids).
 */
export function dispatchMarket(m: RemainingAccount, bids: u64, asks: u64, seats: u64, initial: boolean): void {
  if (!isSupportedSize(bids, asks, seats)) {
    log("Invalid parameters for market");
    require(false, PhoenixError.InvalidMarketParameters);
  }
  const size = fifoMarketSize(bids, seats);
  const room = m.dataLen - FIFO_MARKET_OFFSET;
  if (room < size) sliceEndPanic(size, room);
  if (!initial) {
    if (loadRawAt<FifoMarketPrefix>(m, FIFO_MARKET_OFFSET).order_sequence_number === 0n) {
      log("Market is not initialized. \nsrc/program/dispatch_market.rs:79:9");
      require(false, PhoenixError.MarketUninitialized);
    }
  }
}

/** load_with_dispatch_mut for a loaded market: the sizes its header records. */
export function dispatchLoadedMarket(m: RemainingAccount): void {
  const h = loadRaw<MarketHeader>(m);
  dispatchMarket(m, h.market_size_params.bids_size, h.market_size_params.asks_size, h.market_size_params.num_seats, false);
}

// ---- phoenix_checkers.rs: seats -------------------------------------------------------------------------------------

/** get_seat_address(market, trader).0. */
export function seatAddress(market: Pubkey, trader: Pubkey): Pubkey {
  return findProgramAddress(["seat", market, trader], PHOENIX_ID);
}

/**
 * SeatAccountInfo::new_with_context: owned by Phoenix, at the seat PDA of (market, trader), its discriminant, trader
 * and market, then approved (or, with `approved` false, not approved: NotApproved or Retired).
 */
export function checkSeatWithContext(s: RemainingAccount, market: Pubkey, trader: Pubkey, approved: boolean): void {
  const address = seatAddress(market, trader);
  if (s.owner !== PHOENIX_ID) {
    log("Seat must be owned by the Phoenix program. \nsrc/program/validation/checkers/phoenix_checkers.rs:181:9");
    require(false, ProgramError.IllegalOwner);
  }
  if (address !== s.key) {
    log("Invalid address for seat. \nsrc/program/validation/checkers/phoenix_checkers.rs:186:9");
    require(false, ProgramError.InvalidInstructionData);
  }
  if (s.dataLen < SEAT_SIZE) sliceEndPanic(SEAT_SIZE, s.dataLen);
  const seat = loadRaw<Seat>(s);
  log(SEAT_DISCRIMINANT_LOG);
  if (seat.discriminant !== SEAT_DISCRIMINANT) {
    log("Invalid discriminant for seat. \nsrc/program/validation/checkers/phoenix_checkers.rs:193:9");
    require(false, ProgramError.InvalidAccountData);
  }
  if (seat.trader !== trader) {
    log("Invalid trader for seat. \nsrc/program/validation/checkers/phoenix_checkers.rs:198:9");
    require(false, ProgramError.InvalidAccountData);
  }
  if (seat.market !== market) {
    log("Invalid market for seat. \nsrc/program/validation/checkers/phoenix_checkers.rs:203:9");
    require(false, ProgramError.InvalidAccountData);
  }
  // SeatApprovalStatus::from panics past Retired; only Phoenix writes a seat.
  if (seat.approval_status > 2n) panic("Invalid approval status", "src/program/status.rs:129:18");
  if (approved) {
    if (seat.approval_status !== SEAT_APPROVED) {
      log("Seat must be approved. \nsrc/program/validation/checkers/phoenix_checkers.rs:210:13");
      require(false, PhoenixError.InvalidSeatStatus);
    }
  } else if (seat.approval_status === SEAT_APPROVED) {
    log("Seat must be unapproved or retired. \nsrc/program/validation/checkers/phoenix_checkers.rs:216:13");
    require(false, PhoenixError.InvalidSeatStatus);
  }
}

/**
 * SeatAccountInfo::new (ChangeSeatStatus), in its own order: the bytes read first (any owner; a slice panic when
 * short), the seat's market, then owner, address (from the trader the seat names) and discriminant.
 */
export function checkSeat(s: RemainingAccount, market: Pubkey): void {
  if (s.dataLen < SEAT_SIZE) sliceEndPanic(SEAT_SIZE, s.dataLen);
  const seatMarket = readData<Pubkey>(s, 8n);
  const address = seatAddress(market, readData<Pubkey>(s, 40n));
  if (seatMarket !== market) {
    log("Market on seat does not match market in instruction. \nsrc/program/validation/checkers/phoenix_checkers.rs:232:9");
    require(false, ProgramError.InvalidAccountData);
  }
  if (s.owner !== PHOENIX_ID) {
    log("Seat must be owned by the Phoenix program. \nsrc/program/validation/checkers/phoenix_checkers.rs:237:9");
    require(false, ProgramError.IllegalOwner);
  }
  if (address !== s.key) {
    log("Invalid address for seat. \nsrc/program/validation/checkers/phoenix_checkers.rs:242:9");
    require(false, ProgramError.InvalidInstructionData);
  }
  log(SEAT_DISCRIMINANT_LOG);
  if (readData<u64>(s, 0n) !== SEAT_DISCRIMINANT) {
    log("Invalid discriminant for seat. \nsrc/program/validation/checkers/phoenix_checkers.rs:247:9");
    require(false, ProgramError.InvalidAccountData);
  }
}
