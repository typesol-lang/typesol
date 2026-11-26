// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): processor helpers and `mod state` accessors of
// aeyakovenko/percolator-prog src/v16_program.rs, Copyright Anatoly Yakovenko, licensed under the Apache License,
// Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// What the first instructions share: the account checks (`account`, `expect_signer`, `expect_writable`,
// `expect_owner`, `expect_key`, the authorities), the SPL Token checks (`unpack_mint`, `verify_token_program`,
// `verify_user_token_account`, `verify_vault_token_account` with its canonical-vault pin, spl-token 4.0's `unpack`
// refusals), the market preflights (`read_market_config_mode_and_capacity`, `read_market_trade_preflight`,
// `market_view_mut`), the portfolio bindings, the oracle profiles and control sequences of an asset slot, and the
// two ledgers.
//
// The original copies the wrapper config, an oracle profile or a slot's control sequences out of the market, changes
// the copy and writes it back after validating it (`write_wrapper_config`, `write_oracle_profile_to_view`,
// `write_control_sequences_to_view`). The port changes them in place: every failure after the change fails the
// transaction, so the bytes are the same (NOTES.md, section 1). Where the value written back cannot fail the validation
// the read already passed (only fields the validation does not look at, or values checked against the same bounds
// before, changed), the port does not validate it again; each handler says where.
import {
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type u8,
  type u32,
  type u64,
  type u128,
  ProgramError,
  currentSlot,
  findProgramAddress,
  loadRawAt,
  loadRawMutAt,
  pubkey,
  readData,
  require,
  resizeAccount,
  u64 as toU64,
} from "typesol";
import { PercolatorError, V16_OK, checkV16 } from "./errors.js";
import {
  type AssetControlSequences,
  type AssetOracleProfile,
  type BackingBucket,
  type EngineAssetSlot,
  type GroupHeader,
  type Portfolio,
  type WrapperConfig,
  ASSET_CONTROL_SEQUENCES_OFF,
  HEADER_LEN,
  KIND_MARKET,
  KIND_PORTFOLIO,
  MARKET_GROUP_OFF,
  MIN_MARKET_ACCOUNT_LEN,
  PORTFOLIO_ACCOUNT_LEN,
  PORTFOLIO_MATCHER_SEQUENCE_OFF,
  ZERO_KEY,
  assetSlotAt,
  checkHeader,
  dynamicSlotOffset,
  marketHeaderAt,
  marketSlotCapacity,
  marketViewChecks,
  nextPortfolioMatcherSequence,
  portfolioViewChecks,
  readPortfolioId,
  readPortfolioMatcherSequence,
  validateAssetOracleProfile,
  validateMarketDynamicLen,
  validateWrapperConfig,
  wrapperConfigAt,
} from "./state.js";
import { BOUND_SCALE, V16_ACCOUNT_VERSION, V16_LAYOUT_DISCRIMINATOR, backingBucketErr, marketModeErr } from "./wire.js";
import { compactSourceDomains, configFullErr, engineSlotAt, sourceCreditErr } from "./engine.js";

export const SPL_TOKEN_ID = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** The Associated Token Account program: the canonical vault is the vault PDA's ATA of the mint. */
export const ATA_PROGRAM_ID = pubkey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** spl_token::state::Mint::LEN and Account::LEN. */
export const SPL_MINT_LEN = 82n;
export const SPL_ACCOUNT_LEN = 165n;
const U64_MAX_P = 0xffffffffffffffffn;
const U128_MAX_P = 0xffffffffffffffffffffffffffffffffn;

// ---- Accounts --------------------------------------------------------------------------------------------------------

/**
 * `account(accounts, i)` for the first `n` positions: NotEnoughAccountKeys when fewer were passed. Each handler takes
 * its fixed accounts before any check, so one count check stands for them.
 */
export function needAccounts(rest: RemainingAccounts, n: u64): void {
  require(rest.length >= n, ProgramError.NotEnoughAccountKeys);
}

/** `expect_signer`. */
export function signerCheck(a: RemainingAccount): void {
  require(a.isSigner, PercolatorError.ExpectedSigner);
}

/** `expect_writable`. */
export function writableCheck(a: RemainingAccount): void {
  require(a.isWritable, PercolatorError.ExpectedWritable);
}

/** `expect_owner`: IncorrectProgramId for another owner. */
export function ownerCheck(a: RemainingAccount, owner: Pubkey): void {
  require(a.owner === owner, ProgramError.IncorrectProgramId);
}

/** `expect_key`: InvalidArgument for another key. */
export function keyCheck(a: RemainingAccount, key: Pubkey): void {
  require(a.key === key, ProgramError.InvalidArgument);
}

/** `live_authority_matches`: a set key equal to the signer's. */
export function liveAuthorityMatches(expected: Pubkey, signer: Pubkey): boolean {
  return expected !== ZERO_KEY && expected === signer;
}

/** `expect_live_authority`: Unauthorized otherwise. */
export function expectLiveAuthority(expected: Pubkey, signer: Pubkey): void {
  require(liveAuthorityMatches(expected, signer), PercolatorError.Unauthorized);
}

/**
 * `expect_incoming_authority`: the zero key burns (InvalidInstruction unless `allowBurn`); any other new key signs
 * the instruction as the given account.
 */
export function expectIncomingAuthority(a: RemainingAccount, newKey: Pubkey, allowBurn: boolean): void {
  if (newKey === ZERO_KEY) {
    require(allowBurn, PercolatorError.InvalidInstruction);
    return;
  }
  signerCheck(a);
  require(a.key === newKey, PercolatorError.Unauthorized);
}

/** `amount_to_u64`: InvalidInstruction above u64. */
export function amountToU64(amount: u128): u64 {
  require(amount <= U64_MAX_P, PercolatorError.InvalidInstruction);
  return toU64(amount);
}

// ---- SPL Token -------------------------------------------------------------------------------------------------------

/** spl-token's `unpack_coption_key` / `unpack_coption_u64` tag: [0,0,0,0] None, [1,0,0,0] Some, else refused. */
function coptionOk(a: RemainingAccount, at: u64): boolean {
  return readData<u32>(a, at) <= 1n;
}

/**
 * `unpack_mint`: SPL Token's, 82 bytes, and `Mint::unpack` (both COption tags, `is_initialized` a bool and true):
 * every refusal InvalidMint. Returns the decimals. Only SPL Token mints are accepted (not Token-2022).
 */
export function unpackMintV16(m: RemainingAccount): u8 {
  require(m.owner === SPL_TOKEN_ID, PercolatorError.InvalidMint);
  require(m.dataLen === SPL_MINT_LEN, PercolatorError.InvalidMint);
  const init = readData<u8>(m, 45n);
  require(coptionOk(m, 0n) && init === 1n && coptionOk(m, 46n), PercolatorError.InvalidMint);
  return readData<u8>(m, 44n);
}

/** `verify_token_program`: SPL Token's key (not Token-2022), executable. */
export function verifyTokenProgramV16(a: RemainingAccount): void {
  require(a.key === SPL_TOKEN_ID && a.executable, PercolatorError.InvalidTokenProgram);
}

/**
 * `unpack_token_account`: SPL Token's, 165 bytes, `Account::unpack` (the COption tags, the state byte 0..2, then
 * initialized): every refusal InvalidTokenAccount. Returns the state (1 Initialized, 2 Frozen).
 */
export function unpackTokenAccountV16(a: RemainingAccount): u8 {
  require(a.owner === SPL_TOKEN_ID, PercolatorError.InvalidTokenAccount);
  require(a.dataLen === SPL_ACCOUNT_LEN, PercolatorError.InvalidTokenAccount);
  const state = readData<u8>(a, 108n);
  require(coptionOk(a, 72n) && state <= 2n && coptionOk(a, 109n) && coptionOk(a, 129n) && state !== 0n, PercolatorError.InvalidTokenAccount);
  return state;
}

/** `verify_user_token_account`: the mint (InvalidMint), the owner and Initialized (InvalidTokenAccount); the amount. */
export function verifyUserTokenAccount(ta: RemainingAccount, owner: Pubkey, mint: Pubkey): u64 {
  const state = unpackTokenAccountV16(ta);
  require(readData<Pubkey>(ta, 0n) === mint, PercolatorError.InvalidMint);
  require(readData<Pubkey>(ta, 32n) === owner && state === 1n, PercolatorError.InvalidTokenAccount);
  return readData<u64>(ta, 64n);
}

/**
 * `verify_vault_token_account`: the mint (InvalidMint); the vault authority's, Initialized, no delegate, no close
 * authority and at the canonical address (the vault authority's associated token account of the mint) or
 * InvalidVaultAccount. The amount.
 */
export function verifyVaultTokenAccount(ta: RemainingAccount, owner: Pubkey, mint: Pubkey): u64 {
  const state = unpackTokenAccountV16(ta);
  require(readData<Pubkey>(ta, 0n) === mint, PercolatorError.InvalidMint);
  const shape = readData<Pubkey>(ta, 32n) === owner && state === 1n && readData<u32>(ta, 72n) === 0n && readData<u32>(ta, 129n) === 0n;
  // `||` evaluates the canonical address only when the rest holds.
  require(shape && ta.key === findProgramAddress([owner, SPL_TOKEN_ID, mint], ATA_PROGRAM_ID), PercolatorError.InvalidVaultAccount);
  return readData<u64>(ta, 64n);
}

/** `derive_vault_authority`: the PDA ["vault", market]. */
export function vaultAuthorityOf(market: Pubkey, programId: Pubkey): Pubkey {
  return findProgramAddress(["vault", market], programId);
}

// ---- Market preflights --------------------------------------------------------------------------------------------------

/**
 * `read_market_config_mode_and_capacity`: the header, the length (a whole number of slots), the wrapper config
 * (validated), the engine config (`try_to_runtime`: shape and solvency envelope) and the mode, every engine refusal
 * InvalidAccountData (`map_account_wire_error`). Returns the mode byte.
 */
export function readMarketConfigMode(m: RemainingAccount): u8 {
  checkHeader(m, KIND_MARKET);
  validateMarketDynamicLen(m);
  validateWrapperConfig(loadRawAt<WrapperConfig>(m, wrapperConfigAt(m)));
  const h = loadRawAt<GroupHeader>(m, marketHeaderAt(m));
  require(configFullErr(h.config) === V16_OK, ProgramError.InvalidAccountData);
  require(marketModeErr(h.mode) === V16_OK, ProgramError.InvalidAccountData);
  return h.mode;
}

/**
 * `read_market_trade_preflight(data, asset)`: the minimum length, the header, the wrapper config, the engine config
 * (InvalidAccountData), the asset below the configured count (InvalidInstruction), its slot within the data, the mode
 * (InvalidAccountData). The caller reads the slot's market id and the config's `max_trading_fee_bps` from the views.
 */
export function readMarketTradePreflight(m: RemainingAccount, asset: u64): u8 {
  require(m.dataLen >= MIN_MARKET_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  checkHeader(m, KIND_MARKET);
  validateWrapperConfig(loadRawAt<WrapperConfig>(m, wrapperConfigAt(m)));
  const h = loadRawAt<GroupHeader>(m, marketHeaderAt(m));
  require(configFullErr(h.config) === V16_OK, ProgramError.InvalidAccountData);
  require(asset < toU64(h.config.max_market_slots), PercolatorError.InvalidInstruction);
  assetSlotAt(m, asset);
  require(marketModeErr(h.mode) === V16_OK, ProgramError.InvalidAccountData);
  return h.mode;
}

/** `market_view_mut`'s checks (state.ts `marketViewChecks`); the slot count of the view. */
export function marketViewMut(m: RemainingAccount): u64 {
  return marketViewChecks(m);
}

/**
 * `state::read_asset_oracle_profile(data, i)`: the header, `i` below the capacity the length gives
 * (InvalidInstruction), then the profile validated. Its offset.
 */
export function readAssetOracleProfileState(m: RemainingAccount, i: u64): u64 {
  checkHeader(m, KIND_MARKET);
  const capacity = marketSlotCapacity(m);
  require(i < capacity, PercolatorError.InvalidInstruction);
  const at = dynamicSlotOffset(i);
  validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
  return at;
}

// ---- The group view's slot wrappers ---------------------------------------------------------------------------------

/** `read_oracle_profile_from_view`: slot `i` of the view (InvalidInstruction past it), its profile validated; the offset. */
export function profileFromView(m: RemainingAccount, markets: u64, i: u64): u64 {
  require(i < markets, PercolatorError.InvalidInstruction);
  const at = dynamicSlotOffset(i);
  validateAssetOracleProfile(loadRawAt<AssetOracleProfile>(m, at));
  return at;
}

/** Slot `i`'s control sequences (`read_control_sequences_from_view`: InvalidInstruction past the view; no validation). */
export function controlsFromView(m: RemainingAccount, markets: u64, i: u64): u64 {
  require(i < markets, PercolatorError.InvalidInstruction);
  return dynamicSlotOffset(i) + ASSET_CONTROL_SEQUENCES_OFF;
}

/** ControlSequenceLane, as the fields of AssetControlSequencesV16 it names. */
export const LANE_TRADE_FEE = 0n;
export const LANE_LIQUIDATION_FEE = 1n;
export const LANE_MAINTENANCE_FEE = 2n;
export const LANE_FEE_REDIRECT = 3n;
export const LANE_MARKET_INIT_FEE = 4n;
export const LANE_PERMISSIONLESS_RESOLVE = 5n;
export const LANE_ORACLE_OBSERVATION = 6n;

/** `advance_control_sequence_view`: the lane's sequence strictly newer (EngineStale), then the proposed value. */
export function advanceControlSequence(m: RemainingAccount, markets: u64, i: u64, lane: u64, proposed: u64): void {
  const s = loadRawMutAt<AssetControlSequences>(m, controlsFromView(m, markets, i));
  if (lane === LANE_TRADE_FEE) {
    require(proposed > s.trade_fee, PercolatorError.EngineStale);
    s.trade_fee = proposed;
  } else if (lane === LANE_LIQUIDATION_FEE) {
    require(proposed > s.liquidation_fee, PercolatorError.EngineStale);
    s.liquidation_fee = proposed;
  } else if (lane === LANE_MAINTENANCE_FEE) {
    require(proposed > s.maintenance_fee, PercolatorError.EngineStale);
    s.maintenance_fee = proposed;
  } else if (lane === LANE_FEE_REDIRECT) {
    require(proposed > s.fee_redirect, PercolatorError.EngineStale);
    s.fee_redirect = proposed;
  } else if (lane === LANE_MARKET_INIT_FEE) {
    require(proposed > s.market_init_fee, PercolatorError.EngineStale);
    s.market_init_fee = proposed;
  } else if (lane === LANE_PERMISSIONLESS_RESOLVE) {
    require(proposed > s.permissionless_resolve, PercolatorError.EngineStale);
    s.permissionless_resolve = proposed;
  } else {
    require(proposed > s.oracle_observation, PercolatorError.EngineStale);
    s.oracle_observation = proposed;
  }
}

/** `advance_backing_fee_sequence_view`: newer than max(backing_fee, authority_epoch) (EngineStale). */
export function advanceBackingFeeSequence(m: RemainingAccount, markets: u64, i: u64, proposed: u64): void {
  const s = loadRawMutAt<AssetControlSequences>(m, controlsFromView(m, markets, i));
  const floor = s.backing_fee > s.authority_epoch ? s.backing_fee : s.authority_epoch;
  require(proposed > floor, PercolatorError.EngineStale);
  s.backing_fee = proposed;
}

/** `advance_authority_epoch_view`: the expected epoch (EngineStale), plus one (EngineCounterOverflow). */
export function advanceAuthorityEpoch(m: RemainingAccount, markets: u64, i: u64, expected: u64): void {
  const s = loadRawMutAt<AssetControlSequences>(m, controlsFromView(m, markets, i));
  require(s.authority_epoch === expected, PercolatorError.EngineStale);
  require(s.authority_epoch !== U64_MAX_P, PercolatorError.EngineCounterOverflow);
  s.authority_epoch += 1n;
}

/** `require_authority_epoch_view`. */
export function requireAuthorityEpoch(m: RemainingAccount, markets: u64, i: u64, expected: u64): void {
  const s = loadRawAt<AssetControlSequences>(m, controlsFromView(m, markets, i));
  require(s.authority_epoch === expected, PercolatorError.EngineStale);
}

/** `require_asset_generation_view`: `i` configured and in the view (InvalidInstruction), its market id (AssetGenerationMismatch). */
export function requireAssetGeneration(m: RemainingAccount, markets: u64, i: u64, expected: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(i < toU64(h.config.max_market_slots) && i < markets, PercolatorError.InvalidInstruction);
  // The slot's asset market id: the first field of its engine part.
  require(readData<u64>(m, engineSlotAt(i)) === expected, PercolatorError.AssetGenerationMismatch);
}

// ---- Oracle liveness -----------------------------------------------------------------------------------------------------

/** `oracle_v16::permissionless_stale_matured`. */
export function permissionlessStaleMatured(cfg: WrapperConfig, now: u64): boolean {
  const since = now > cfg.last_good_oracle_slot ? now - cfg.last_good_oracle_slot : 0n;
  return cfg.permissionless_resolve_stale_slots !== 0n && since >= cfg.permissionless_resolve_stale_slots;
}

/** `authenticated_market_slot_or_fallback_view`: max(Clock slot, current_slot). */
export function authenticatedMarketSlot(currentSlotOfMarket: u64): u64 {
  const clock = currentSlot();
  return clock > currentSlotOfMarket ? clock : currentSlotOfMarket;
}

/** `reject_permissionless_resolve_matured_live_view`: a live market whose stale window has matured (OracleStale). */
export function rejectStaleLive(m: RemainingAccount): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  if (h.mode !== 0n) return;
  const cfg = loadRawAt<WrapperConfig>(m, HEADER_LEN);
  require(!permissionlessStaleMatured(cfg, authenticatedMarketSlot(h.current_slot)), PercolatorError.OracleStale);
}

// ---- Portfolio bindings --------------------------------------------------------------------------------------------------

/** `expect_portfolio_sequence_binding`: the id (EngineProvenanceMismatch), the owner-state sequence (EngineStale). */
export function expectPortfolioSequenceBinding(p: RemainingAccount, expectedId: u64, expectedSequence: u64): void {
  require(readPortfolioId(p) === expectedId, PercolatorError.EngineProvenanceMismatch);
  nextPortfolioMatcherSequence(readPortfolioMatcherSequence(p), expectedSequence);
}

/** `ensure_portfolio_storage_for_market_slots`: longer than the full length refused, shorter grown (zeroed). */
export function ensurePortfolioStorage(p: RemainingAccount): void {
  require(p.dataLen <= PORTFOLIO_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  if (p.dataLen < PORTFOLIO_ACCOUNT_LEN) resizeAccount(p, PORTFOLIO_ACCOUNT_LEN);
}

/**
 * `portfolio_view_mut_for_market_slots`: the header and the length (state.ts `portfolioViewChecks`), then
 * `PortfolioV16ViewMut::new`, which compacts the source domains in place.
 */
export function portfolioViewMut(p: RemainingAccount): void {
  portfolioViewChecks(p);
  const view = loadRawMutAt<Portfolio>(p, HEADER_LEN);
  compactSourceDomains(view.source_domains);
}

/** `expect_portfolio_view_account_key`: the provenance header decoded (EngineProvenanceMismatch), then its account id. */
export function expectPortfolioAccountKey(p: RemainingAccount): void {
  const ph = loadRawAt<Portfolio>(p, HEADER_LEN).provenance_header;
  require(ph.version === V16_ACCOUNT_VERSION && ph.layout_discriminator === V16_LAYOUT_DISCRIMINATOR, PercolatorError.EngineProvenanceMismatch);
  require(ph.portfolio_account_id === p.key, PercolatorError.EngineProvenanceMismatch);
}

/** `advance_portfolio_matcher_sequence` (after the binding above: the header and the length hold). */
export function advancePortfolioSequence(p: RemainingAccount, expected: u64): void {
  const next = nextPortfolioMatcherSequence(readPortfolioMatcherSequence(p), expected);
  checkHeader(p, KIND_PORTFOLIO);
  require(p.dataLen >= PORTFOLIO_MATCHER_SEQUENCE_OFF + 8n, PercolatorError.InvalidAccountLen);
  writeU64At(p, PORTFOLIO_MATCHER_SEQUENCE_OFF, next);
}

/** A u64 written at `at` of a program account's data. */
function writeU64At(a: RemainingAccount, at: u64, v: u64): void {
  const cell = loadRawMutAt<U64Cell>(a, at);
  cell.v = v;
}
export interface U64Cell {
  v: u64;
}

// ---- Backing buckets and insurance ---------------------------------------------------------------------------------------

/**
 * `backing_domain_parts_view(group, domain)`'s checks: `domain` configured and its asset in the view
 * (InvalidInstruction), its source-credit state and bucket converted (map_v16_error). The caller reads the bucket
 * from the slot.
 */
export function backingDomainPartsCheck(m: RemainingAccount, markets: u64, domain: u64): void {
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const asset = domain / 2n;
  require(domain < 2n * toU64(h.config.max_market_slots) && asset < markets, PercolatorError.InvalidInstruction);
  const e = loadRawAt<EngineAssetSlot>(m, engineSlotAt(asset));
  const long = domain % 2n === 0n;
  const credit = long ? e.source_credit_long : e.source_credit_short;
  checkV16(sourceCreditErr(credit));
  const bucket = long ? e.backing_long : e.backing_short;
  checkV16(backingBucketErr(bucket));
}

/** `backing_unavailable_principal_atoms`: (consumed + impaired) / BOUND_SCALE (EngineArithmeticOverflow). */
export function backingUnavailableAtoms(b: BackingBucket): u128 {
  require(b.consumed_liened_backing_num <= U128_MAX_P - b.impaired_liened_backing_num, PercolatorError.EngineArithmeticOverflow);
  return (b.consumed_liened_backing_num + b.impaired_liened_backing_num) / BOUND_SCALE;
}

