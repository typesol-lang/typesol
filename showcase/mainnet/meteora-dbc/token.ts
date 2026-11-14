// A port of Meteora Dynamic Bonding Curve (MeteoraAg/dynamic-bonding-curve @ 91e696e), subject to Meteora's Non-commercial Licence (see LICENSE.md in this directory). Changes: rewritten in TypeSOL.
// The token helpers config creation and token badges use (programs/dynamic-bonding-curve/src/utils/token.rs): the
// quote mint's score, its Token-2022 transfer fee and fee config authority, and the transfer fee arithmetic.
//
// The original unpacks the mint with spl-token-2022's StateWithExtensions; this port reads the same TLV entries in
// place (the mint's 82 bytes, padding to 165, the account type, then type u16 / length u16 / value entries). The
// mint itself was already checked as an initialized mint of either token program by its `Mint` parameter, as Anchor's
// InterfaceAccount<Mint> checks it.
import { type Mint, type Pubkey, type RemainingAccount, type u16, currentEpoch, loadAccount, pubkey, readData, require, u64, u128 } from "typesol";
import { PoolError } from "./errors";
import { subU64 } from "./math";
import { type TokenBadge } from "./state";

export const TOKEN_PROGRAM_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** spl_token_2022::native_mint */
const TOKEN_2022_NATIVE_MINT = pubkey("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");

/** Token-2022 extension types the quote mint may carry permissionlessly. */
export const EXT_TRANSFER_FEE_CONFIG = 1n;
const EXT_METADATA_POINTER = 18n;
const EXT_TOKEN_METADATA = 19n;
/** Where a Token-2022 mint's TLV entries start: after the base mint padded to an account's 165 bytes, and its type. */
export const TLV_START = 166n;
/** MintScore, ordered as the original's enum. */
export const MINT_SCORE_UNSUPPORTED = 0n;
export const MINT_SCORE_PERMISSIONED_WITH_TRANSFER_FEE = 1n;
export const MINT_SCORE_PERMISSIONED_WITHOUT_TRANSFER_FEE = 2n;
export const MINT_SCORE_PERMISSIONLESS = 3n;

/** get_token_program_flags: 0 for SPL Token, 1 otherwise. */
export function tokenProgramFlag(mint: Mint): u64 {
  return mint.tokenProgram === TOKEN_PROGRAM_ID ? 0n : 1n;
}

/** The offset of the value of the mint's first TLV entry of `extensionType`, or 0 when it has none. */
function extensionOffset(mint: Mint, extensionType: u64): u64 {
  if (mint.dataLen <= TLV_START) return 0n;
  let off = TLV_START;
  while (off + 4n <= mint.dataLen) {
    const t = u64(readData<u16>(mint, off));
    // An Uninitialized (0) type ends the entries, as spl-token-2022's TLV walk stops there.
    if (t === 0n) return 0n;
    const len = u64(readData<u16>(mint, off + 2n));
    if (t === extensionType) return off + 4n;
    off = off + 4n + len;
  }
  return 0n;
}

/** Whether every TLV entry of the mint is MetadataPointer, TokenMetadata or TransferFeeConfig. */
function onlyPermissionlessExtensions(mint: Mint): boolean {
  if (mint.dataLen <= TLV_START) return true;
  let off = TLV_START;
  while (off + 4n <= mint.dataLen) {
    const t = u64(readData<u16>(mint, off));
    if (t === 0n) return true;
    if (t !== EXT_METADATA_POINTER && t !== EXT_TOKEN_METADATA && t !== EXT_TRANSFER_FEE_CONFIG) return false;
    off = off + 4n + u64(readData<u16>(mint, off + 2n));
  }
  return true;
}

/** ZeroTransferFee::is_zero of the TransferFee at `at` (epoch u64, maximum_fee u64, transfer_fee_basis_points u16). */
function feeIsZero(mint: Mint, at: u64): boolean {
  return readData<u16>(mint, at + 16n) === 0n || readData<u64>(mint, at + 8n) === 0n;
}

/** is_transfer_fee_zero, given the TransferFeeConfig's offset (0: no TransferFeeConfig, so true). */
function transferFeeIsZero(mint: Mint, cfg: u64): boolean {
  if (cfg === 0n) return true;
  // TransferFeeConfig: config authority [32], withdraw authority [32], withheld u64, older fee @72, newer fee @90
  const newerEpoch = readData<u64>(mint, cfg + 90n);
  if (currentEpoch() < newerEpoch) return feeIsZero(mint, cfg + 72n) && feeIsZero(mint, cfg + 90n);
  return feeIsZero(mint, cfg + 90n);
}

/** Whether the TransferFeeConfig at `cfg` has a config authority (OptionalNonZeroPubkey: all zeros is None). */
function hasConfigAuthority(mint: Mint, cfg: u64): boolean {
  const zero = pubkey("11111111111111111111111111111111");
  return readData<Pubkey>(mint, cfg) !== zero;
}

/** has_transfer_fee_or_config_authority */
export function hasTransferFeeOrConfigAuthority(mint: Mint): boolean {
  if (mint.tokenProgram === TOKEN_PROGRAM_ID) return false;
  const cfg = extensionOffset(mint, EXT_TRANSFER_FEE_CONFIG);
  if (cfg === 0n) return false;
  return hasConfigAuthority(mint, cfg) || !transferFeeIsZero(mint, cfg);
}

/** is_permissionless_supported_quote_mint */
function isPermissionlessSupportedQuoteMint(mint: Mint): boolean {
  if (mint.tokenProgram === TOKEN_PROGRAM_ID) return true;
  require(mint.key !== TOKEN_2022_NATIVE_MINT, PoolError.UnsupportNativeMintToken2022);
  if (!onlyPermissionlessExtensions(mint)) return false;
  const cfg = extensionOffset(mint, EXT_TRANSFER_FEE_CONFIG);
  if (cfg !== 0n && (hasConfigAuthority(mint, cfg) || !transferFeeIsZero(mint, cfg))) return false;
  return true;
}

/** get_mint_score without a token badge. */
export function mintScore(mint: Mint): u64 {
  if (isPermissionlessSupportedQuoteMint(mint)) return MINT_SCORE_PERMISSIONLESS;
  return MINT_SCORE_UNSUPPORTED;
}

/** get_mint_score with a token badge, loaded as Anchor's AccountLoader<TokenBadge>::try_from. */
export function mintScoreWithBadge(mint: Mint, tokenBadge: RemainingAccount): u64 {
  if (isPermissionlessSupportedQuoteMint(mint)) return MINT_SCORE_PERMISSIONLESS;
  const badge = loadAccount<TokenBadge>(tokenBadge);
  require(badge.token_mint === mint.key, PoolError.InvalidTokenBadge);
  if (!hasTransferFeeOrConfigAuthority(mint)) return MINT_SCORE_PERMISSIONED_WITHOUT_TRANSFER_FEE;
  return MINT_SCORE_PERMISSIONED_WITH_TRANSFER_FEE;
}

/**
 * TransferFee::calculate_fee: ceil(amount * bps / 10_000), at most `maximumFee`; 0 for no fee or no amount. It cannot
 * return None for a u64 amount and bps up to 10_000.
 */
export function calculateFee(bps: u64, maximumFee: u64, amount: u64): u64 {
  if (bps === 0n || amount === 0n) return 0n;
  const numerator = u128(amount) * u128(bps);
  const raw = u64((numerator + 9999n) / 10000n);
  return raw < maximumFee ? raw : maximumFee;
}

/** calculate_transfer_fee_excluded_amount for a fee given as (bps, maximum): the amount after the fee. */
export function transferFeeExcludedAmount(hasFee: boolean, bps: u64, maximumFee: u64, includedAmount: u64): u64 {
  if (!hasFee) return includedAmount;
  return subU64(includedAmount, calculateFee(bps, maximumFee, includedAmount));
}

/** The quote mint's epoch fee as get_epoch_transfer_fee reads it, applied to `includedAmount`. */
export function quoteTransferFeeExcludedAmount(mint: Mint, includedAmount: u64): u64 {
  if (mint.tokenProgram === TOKEN_PROGRAM_ID) return includedAmount;
  const cfg = extensionOffset(mint, EXT_TRANSFER_FEE_CONFIG);
  if (cfg === 0n) return includedAmount;
  const fee = currentEpoch() >= readData<u64>(mint, cfg + 90n) ? cfg + 90n : cfg + 72n;
  return transferFeeExcludedAmount(true, u64(readData<u16>(mint, fee + 16n)), readData<u64>(mint, fee + 8n), includedAmount);
}

// ---- transfer fees on swaps (utils/token.rs) ----------------------------------------------------------------------

/** A mint's TransferFee for the current epoch (get_epoch_transfer_fee): `has` false for none. */
export interface EpochFee {
  has: boolean;
  bps: u64;
  max: u64;
}

/** get_epoch_transfer_fee */
export function epochFee(mint: Mint): EpochFee {
  if (mint.tokenProgram === TOKEN_PROGRAM_ID) return { has: false, bps: 0n, max: 0n };
  const cfg = extensionOffset(mint, EXT_TRANSFER_FEE_CONFIG);
  if (cfg === 0n) return { has: false, bps: 0n, max: 0n };
  const fee = currentEpoch() >= readData<u64>(mint, cfg + 90n) ? cfg + 90n : cfg + 72n;
  return { has: true, bps: u64(readData<u16>(mint, fee + 16n)), max: readData<u64>(mint, fee + 8n) };
}

/** calculate_transfer_fee_excluded_amount */
export function excludedTransferFee(f: EpochFee, includedAmount: u64): u64 {
  return transferFeeExcludedAmount(f.has, f.bps, f.max, includedAmount);
}

/**
 * calculate_transfer_fee_included_amount: the amount to send for `excludedAmount` to arrive, with spl-token-2022's
 * calculate_inverse_fee (MathOverflow where it has no answer) and the original's check that the fee of the result is
 * that fee (FeeInverseIsIncorrect).
 */
export function includedTransferFee(f: EpochFee, excludedAmount: u64): u64 {
  if (excludedAmount === 0n) return 0n;
  if (!f.has) return excludedAmount;
  // calculate_pre_fee_amount
  let pre: u64 = excludedAmount;
  if (f.bps === 0n) pre = excludedAmount;
  else if (f.bps === 10000n) {
    require(f.max <= 18446744073709551615n - excludedAmount, PoolError.MathOverflow);
    pre = f.max + excludedAmount;
  } else {
    const raw = (u128(excludedAmount) * 10000n + (10000n - u128(f.bps)) - 1n) / (10000n - u128(f.bps));
    if (raw - u128(excludedAmount) >= u128(f.max)) {
      require(f.max <= 18446744073709551615n - excludedAmount, PoolError.MathOverflow);
      pre = excludedAmount + f.max;
    } else {
      require(raw <= 18446744073709551615n, PoolError.MathOverflow);
      pre = u64(raw);
    }
  }
  const fee = calculateFee(f.bps, f.max, pre);
  require(excludedAmount <= 18446744073709551615n - fee, PoolError.MathOverflow);
  const included = excludedAmount + fee;
  require(fee === calculateFee(f.bps, f.max, included), PoolError.FeeInverseIsIncorrect);
  return included;
}

/**
 * The size of a token account of `mint`, computed from the mint as Anchor 1.0's `init` of a token account computes it
 * (no GetAccountDataSize call): 165 under SPL Token or for a Token-2022 mint whose extensions need no account
 * extension; otherwise 165, the account type byte, and each required account extension (TransferFeeConfig needs
 * TransferFeeAmount, NonTransferable needs NonTransferableAccount and ImmutableOwner, TransferHook needs
 * TransferHookAccount, Pausable needs PausableAccount), each with its 4-byte TLV header. Other account extensions
 * (confidential transfers) are not covered.
 */
export function tokenAccountSpace(mint: Mint): u64 {
  if (mint.tokenProgram === TOKEN_PROGRAM_ID || mint.dataLen <= TLV_START) return 165n;
  let extra: u64 = 0n;
  let off = TLV_START;
  while (off + 4n <= mint.dataLen) {
    const t = u64(readData<u16>(mint, off));
    if (t === 0n) break;
    if (t === 1n) extra = extra + 12n;
    else if (t === 9n) extra = extra + 8n;
    else if (t === 14n) extra = extra + 5n;
    else if (t === 26n) extra = extra + 4n;
    off = off + 4n + u64(readData<u16>(mint, off + 2n));
  }
  return extra === 0n ? 165n : 166n + extra;
}

// ---- Token-2022 base mints (utils/token.rs create_token_2022_base_mint, create_token_2022_base_vault) -------------

/**
 * The base mint's size, as anchor-spl's find_mint_account_size computes it for its extensions: the mint padded to an
 * account's 165 bytes, the account type, then each extension with its 4-byte header (MetadataPointer 64,
 * TransferFeeConfig 108, TransferHook 64). No combination here comes to a Multisig's 355 bytes.
 */
export function token2022BaseMintSpace(transferFee: boolean, transferHook: boolean): u64 {
  let space: u64 = 166n + 68n;
  if (transferFee) space = space + 112n;
  if (transferHook) space = space + 68n;
  return space;
}

/**
 * The base vault's size: ExtensionType::get_required_init_account_extensions of the new mint's extensions
 * (TransferFeeConfig needs TransferFeeAmount, 8 bytes; TransferHook needs TransferHookAccount, 1 byte; MetadataPointer
 * nothing), then try_calculate_account_len (165 without extensions).
 */
export function token2022BaseVaultSpace(transferFee: boolean, transferHook: boolean): u64 {
  if (!transferFee && !transferHook) return 165n;
  let space: u64 = 166n;
  if (transferFee) space = space + 12n;
  if (transferHook) space = space + 5n;
  return space;
}
