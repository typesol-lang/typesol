// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// The pool token's Metaplex metadata (processor.rs process_create_pool_token_metadata,
// process_update_pool_token_metadata; inline_mpl_token_metadata.rs): CreateTokenMetadata (17) and
// UpdateTokenMetadata (18). The manager names the token; the withdraw authority, which is the mint authority, signs
// Metaplex's CreateMetadataAccountV3 and is made the metadata's update authority, then signs its
// UpdateMetadataAccountV2.
//
// Each instruction's arguments are three Borsh Strings (name, symbol, uri). The entrypoint decodes the whole data
// first (try_from_slice: lengths that fit, UTF-8, nothing after the uri; anything else is BorshIoError, or the
// allocator's out-of-memory abort for a length too big for the heap), so they are checked here before the
// "Instruction: …" line. The original then moves them into the Metaplex instruction's DataV2 unchanged, so its bytes
// are this instruction's from the name on, between a new tag and the fixed fields after the uri. The entry
// (stake_pool.ts) builds that instruction from the data as sent and invokes it, with metadataCpiAccount's accounts:
// invokeInstruction runs only in the instruction itself, not in a helper.
//
// The withdraw authority signs with the bump stored in the pool, which check_authority_withdraw has just proved gives
// its address; the original finds the bump again (find_withdraw_authority_program_address). Initialize stores the
// bump it finds, so the two are the same for every pool.
import {
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type u8,
  ProgramError,
  abort,
  findProgramAddress,
  instructionData,
  loadBorsh,
  log,
  programId,
  pubkey,
  require,
  u64,
} from "typesol";
import { StakePoolError } from "./errors.js";
import { type StakePool, AccountType } from "./state.js";
import { SYSTEM_PROGRAM_ID, checkAccountOwner, checkAuthorityWithdraw, checkManager, checkMint, checkSystemProgram, need } from "./util.js";

/** inline_mpl_token_metadata::ID. */
export const MPL_TOKEN_METADATA_ID = pubkey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
/** Metaplex's instruction tags: CreateMetadataAccountV3, UpdateMetadataAccountV2. */
export const CREATE_METADATA_ACCOUNT_V3 = 33n;
export const UPDATE_METADATA_ACCOUNT_V2 = 15n;

/** An account of the Metaplex instruction (solana_instruction::AccountMeta). */
export interface InstructionMeta {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

// ---- The arguments (StakePoolInstruction::try_from_slice) -------------------------------------------------------------

/** The top bit of each byte of a word: ASCII bytes have it clear. */
const NON_ASCII = 0x8080808080808080n;

/**
 * str::from_utf8 on data[start, end): well-formed UTF-8, so no overlong forms, no surrogates (ED A0..BF) and nothing
 * past U+10FFFF (F4 90.., F5..FF). ASCII goes eight bytes at a time.
 */
function isUtf8(start: u64, end: u64): boolean {
  const data = instructionData();
  let i = start;
  while (i < end) {
    if (end - i >= 8n && (data.readU64(i) & NON_ASCII) === 0n) {
      i += 8n;
      continue;
    }
    const b = u64(data.readU8(i));
    if (b < 0x80n) {
      i += 1n;
      continue;
    }
    // The lead byte gives the width and the range of the byte after it; any later bytes are 80..BF.
    let width = 0n;
    let low = 0x80n;
    let high = 0xbfn;
    if (b >= 0xc2n && b <= 0xdfn) width = 2n;
    else if (b >= 0xe0n && b <= 0xefn) {
      width = 3n;
      if (b === 0xe0n) low = 0xa0n;
      if (b === 0xedn) high = 0x9fn;
    } else if (b >= 0xf0n && b <= 0xf4n) {
      width = 4n;
      if (b === 0xf0n) low = 0x90n;
      if (b === 0xf4n) high = 0x8fn;
    } else return false;
    if (end - i < width) return false;
    const second = u64(data.readU8(i + 1n));
    if (second < low || second > high) return false;
    if (width >= 3n && (data.readU8(i + 2n) & 0xc0n) !== 0x80n) return false;
    if (width === 4n && (data.readU8(i + 3n) & 0xc0n) !== 0x80n) return false;
    i += width;
  }
  return true;
}

/** Borsh allocates a String's bytes before reading them, but never more than 1 MiB at first. */
const BORSH_FIRST_ALLOCATION = 1048576n;
/**
 * The original's heap (the entrypoint's 32 KiB bump allocator, its first 8 bytes the allocator's own) less what
 * reporting a short input takes (io::Error::new and its message): 32686 bytes, measured on the mainnet binary.
 */
const DECODE_HEAP = 32686n;
/** solana-account-info's AccountInfo, and the Rc<RefCell<…>> of its lamports and of its data. */
const ACCOUNT_INFO_SIZE = 48n;
const ACCOUNT_CELLS_SIZE = 72n;

/**
 * What of DECODE_HEAP the entrypoint leaves: it made an AccountInfo for each account (in one Vec) and the lamports
 * and data cells for each distinct one (a duplicate shares its first's).
 */
function decodeHeapLeft(rest: RemainingAccounts): u64 {
  const n = rest.length;
  let distinct = 0n;
  for (let i = 0n; i < n; i++) {
    const key = rest.get(i).key;
    let first = true;
    for (let j = 0n; j < i && first; j++) if (rest.get(j).key === key) first = false;
    if (first) distinct += 1n;
  }
  return DECODE_HEAP - ACCOUNT_INFO_SIZE * n - ACCOUNT_CELLS_SIZE * distinct;
}

/**
 * The end of the Borsh String `k` (0 name, 1 symbol, 2 uri) at `at`: a u32 length, then that many bytes of UTF-8
 * (else BorshIoError). A length past the end of the data is BorshIoError when the bytes Borsh allocates for it fit
 * on the heap next to the Strings before it, and otherwise the allocator's out-of-memory abort, as in the original.
 */
function borshStringEnd(rest: RemainingAccounts, at: u64, k: u64): u64 {
  const data = instructionData();
  const n = data.length;
  require(n - at >= 4n, ProgramError.BorshIoError);
  const start = at + 4n;
  const len = u64(data.readU32(at));
  if (n - start < len) {
    // The Strings before this one hold their bytes (all of the data since the tag, but their lengths).
    const held = at - 1n - 4n * k;
    const allocated = len < BORSH_FIRST_ALLOCATION ? len : BORSH_FIRST_ALLOCATION;
    if (held + allocated > decodeHeapLeft(rest)) {
      // The allocator's error handler: this line, then Rust's abort (the runtime's "SBF program panicked").
      log("Error: memory allocation failed, out of memory");
      abort();
    }
    require(false, ProgramError.BorshIoError);
  }
  require(isUtf8(start, start + len), ProgramError.BorshIoError);
  return start + len;
}

/** { name, symbol, uri } after the tag, and nothing after them. */
function decodeArguments(rest: RemainingAccounts): void {
  const data = instructionData();
  const end = borshStringEnd(rest, borshStringEnd(rest, borshStringEnd(rest, 1n, 0n), 1n), 2n);
  require(end === data.length, ProgramError.BorshIoError);
}

// ---- Checks --------------------------------------------------------------------------------------------------------

/** check_mpl_metadata_program. */
function checkMplMetadataProgram(a: RemainingAccount): void {
  if (a.key !== MPL_TOKEN_METADATA_ID) {
    log(`Expected mpl metadata program ${MPL_TOKEN_METADATA_ID}, received ${a.key}`);
    require(false, ProgramError.IncorrectProgramId);
  }
}

/** check_mpl_metadata_account_address: find_metadata_account(pool mint), ["metadata", program, mint]. */
function checkMetadataAddress(metadata: Pubkey, poolMint: Pubkey): void {
  const expected = findProgramAddress(["metadata", MPL_TOKEN_METADATA_ID, poolMint], MPL_TOKEN_METADATA_ID);
  require(expected === metadata, StakePoolError.InvalidMetadataAccount);
}

// ---- The instructions ----------------------------------------------------------------------------------------------

/**
 * Tag 17: CreateTokenMetadata { name, symbol, uri }. Accounts: pool, manager (signs), withdraw authority, pool mint,
 * payer (signs, a wallet), metadata account, Metaplex, System. Returns the withdraw authority's bump, for the entry's
 * CreateMetadataAccountV3 (metadata, mint, mint authority, payer, update authority, System).
 */
export function createTokenMetadata(rest: RemainingAccounts): u8 {
  decodeArguments(rest);
  log("Instruction: CreateTokenMetadata");
  need(rest, 8n);
  const poolAcct = rest.get(0n);
  const payer = rest.get(4n);
  if (!payer.isSigner) {
    log("Payer did not sign metadata creation");
    require(false, StakePoolError.SignatureMissing);
  }
  checkSystemProgram(rest.get(7n));
  checkAccountOwner(payer, SYSTEM_PROGRAM_ID);
  checkAccountOwner(poolAcct, programId());
  checkMplMetadataProgram(rest.get(6n));
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkManager(pool, rest.get(1n));
  checkAuthorityWithdraw(pool, rest.get(2n).key, poolAcct.key);
  checkMint(pool, rest.get(3n));
  checkMetadataAddress(rest.get(5n).key, pool.poolMint);
  return pool.stakeWithdrawBumpSeed;
}

/**
 * Tag 18: UpdateTokenMetadata { name, symbol, uri }. Accounts: pool, manager (signs), withdraw authority, metadata
 * account, Metaplex. Returns the withdraw authority's bump, for the entry's UpdateMetadataAccountV2 (metadata, update
 * authority).
 */
export function updateTokenMetadata(rest: RemainingAccounts): u8 {
  decodeArguments(rest);
  log("Instruction: UpdateTokenMetadata");
  need(rest, 5n);
  const poolAcct = rest.get(0n);
  checkAccountOwner(poolAcct, programId());
  checkMplMetadataProgram(rest.get(4n));
  const pool = loadBorsh<StakePool>(poolAcct);
  require(pool.accountType === AccountType.StakePool, StakePoolError.InvalidState);
  checkManager(pool, rest.get(1n));
  checkAuthorityWithdraw(pool, rest.get(2n).key, poolAcct.key);
  checkMetadataAddress(rest.get(3n).key, pool.poolMint);
  return pool.stakeWithdrawBumpSeed;
}

/**
 * The Metaplex instruction's account `i` (create_metadata_accounts_v3 / update_metadata_accounts_v2): the withdraw
 * authority signs as the mint authority and the update authority.
 */
export function metadataCpiAccount(rest: RemainingAccounts, create: boolean, i: u64): InstructionMeta {
  if (!create)
    return i === 0n ? { pubkey: rest.get(3n).key, isSigner: false, isWritable: true } : { pubkey: rest.get(2n).key, isSigner: true, isWritable: false };
  if (i === 0n) return { pubkey: rest.get(5n).key, isSigner: false, isWritable: true };
  if (i === 1n) return { pubkey: rest.get(3n).key, isSigner: false, isWritable: false };
  if (i === 3n) return { pubkey: rest.get(4n).key, isSigner: true, isWritable: true };
  if (i === 5n) return { pubkey: rest.get(7n).key, isSigner: false, isWritable: false };
  return { pubkey: rest.get(2n).key, isSigner: true, isWritable: false };
}
