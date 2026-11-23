// A port of Percolator v16 at commit 7b110913 (engine 5e3af07), aeyakovenko/percolator-prog src/v16_program.rs,
// Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Changes: rewritten in TypeSOL. Ported here: `handle_init_market`, `handle_init_portfolio`, `handle_deposit` and
// `handle_close_portfolio`, with `state::init_market_account_zero_copy`, `init_portfolio_account_zero_copy` and
// `close_portfolio_account_to_market_slab`.
//
// Each handler is the original's, check for check in its order. The handlers read their arguments at fixed offsets of
// the instruction data, which decode (percolator.ts) has checked to have exactly the tag's length.
//
// Repeated accounts. The original holds a mutable borrow of the market's data while it borrows the portfolio's
// (InitPortfolio, Deposit, ClosePortfolio): the same account in both places would fail that borrow
// (AccountBorrowFailed). It cannot get there: a market must be of the market kind and a portfolio of the portfolio kind
// (InitPortfolio refuses an initialized portfolio first), so a repeated market and portfolio is refused earlier, the
// same way in both. The other accounts are compared by key only (signers, the mint, token accounts), as in the original.
import {
  type InstructionBytes,
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  type TokenProgram,
  ProgramError,
  currentSlot,
  findProgramAddress,
  loadRawAt,
  loadRawMutAt,
  programAt,
  rawArrayMutAt,
  rentExempt,
  require,
  resizeAccount,
  u32,
  u64 as toU64,
  zeroData,
} from "typesol";
import { PercolatorError, checkV16 } from "./errors.js";
import {
  type AccountHeader,
  type AssetSlot,
  type GroupHeader,
  type Portfolio,
  type PortfolioMatcherConfig,
  type WrapperConfig,
  DEFAULT_MARK_EWMA_HALFLIFE_SLOTS,
  HEADER_LEN,
  KIND_MARKET,
  KIND_PORTFOLIO,
  MARKET_GROUP_LEN,
  MARKET_GROUP_OFF,
  MAX_ORACLE_PRICE,
  MATCHER_CONTEXT_MIN_LEN,
  MATCHER_ENABLED_MASK,
  MATCHER_POSITION_EPOCH_MASK,
  MATCHER_POSITION_EPOCH_SHIFT,
  MATCHER_TRADE_FEE_CAP_MASK,
  MATCHER_TRADE_FEE_CAP_SHIFT,
  MIN_MARKET_ACCOUNT_LEN,
  PORTFOLIO_ACCOUNT_LEN,
  PORTFOLIO_ID_OFF,
  PORTFOLIO_MATCHER_EXPIRY_OFF,
  PORTFOLIO_MATCHER_SEQUENCE_OFF,
  WRAPPER_MAX_PORTFOLIO_ASSETS,
  ZERO_KEY,
  allocatePortfolioId,
  assetSlotAt,
  checkHeader,
  isInitialized,
  marketHeaderAt,
  marketSlotCapacity,
  matcherCapabilityConfigIsValid,
  nextPortfolioMatcherSequence,
  portfolioMatcherConfigAt,
  portfolioPreflightChecks,
  portfolioViewChecks,
  readPortfolioId,
  readPortfolioMatcherSequence,
  readPortfolioPositionEpoch,
  validateAssetOracleProfile,
  validateMarketDynamicLen,
  validateMatcherControl,
  validateWrapperConfig,
  writeHeaderView,
} from "./state.js";
import {
  ADL_ONE,
  BOUND_SCALE,
  MAX_PROTOCOL_FEE_ABS,
  MAX_RECOVERY_FALLBACK_DEVIATION_BPS,
  V16_ACCOUNT_VERSION,
  V16_LAYOUT_DISCRIMINATOR,
  provenanceHeaderErr,
} from "./wire.js";
import {
  CREDIT_RATE_SCALE,
  LIFECYCLE_ACTIVE,
  MARKET_MODE_RESOLVED,
  configFullErr,
  depositEngine,
  deregisterEmptyPortfolio,
  marketShapeErr,
  registerEmptyPortfolio,
  validateWithMarket,
} from "./engine.js";
import {
  type U64Cell,
  needAccounts,
  advancePortfolioSequence,
  amountToU64,
  authenticatedMarketSlot,
  ensurePortfolioStorage,
  expectPortfolioAccountKey,
  keyCheck,
  expectPortfolioSequenceBinding,
  liveAuthorityMatches,
  marketViewMut,
  ownerCheck,
  portfolioViewMut,
  readMarketConfigMode,
  rejectStaleLive,
  signerCheck,
  unpackMintV16,
  vaultAuthorityOf,
  verifyTokenProgramV16,
  verifyUserTokenAccount,
  verifyVaultTokenAccount,
  writableCheck,
} from "./program.js";

const U64_MAX_S = 0xffffffffffffffffn;

// ---- InitMarket (tag 0) ---------------------------------------------------------------------------------------------------

/**
 * `handle_init_market`: the admin signs, the market is writable and the program's, the mint is an SPL Token mint;
 * the arguments' own checks (EngineInvalidConfig); then `init_market_account_zero_copy`: not initialized, at least
 * the minimum length, zeroed, the header, the wrapper config (validated), asset 0's oracle profile copied into every
 * slot of the capacity, the group header (`MarketGroupV16HeaderAccount::new_dynamic`: the capacity holds the
 * configured assets, the config `validate_public_user_fund`, both InvalidAccountData), the configured slots' engine
 * state, and the market's shape. The config is `V16Config::public_user_fund(max_portfolio_assets, h_min, h_max)` with
 * the instruction's values over it.
 *
 * @noinline
 */
export function initMarket(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 3n);
  const admin = rest.get(0n);
  const m = rest.get(1n);
  const mint = rest.get(2n);
  signerCheck(admin);
  writableCheck(m);
  ownerCheck(m, programId);
  unpackMintV16(mint);
  const maxPortfolioAssets = data.readU16(1n);
  const hMax = data.readU64(11n);
  const initialPrice = data.readU64(19n);
  const maxTradingFeeBps = data.readU64(75n);
  const tradeFeeBaseBps = data.readU64(83n);
  const maintenanceFeePerSlot = data.readU128(203n);
  require(
    !(
      tradeFeeBaseBps > maxTradingFeeBps ||
      maxPortfolioAssets === 0n ||
      maxPortfolioAssets > WRAPPER_MAX_PORTFOLIO_ASSETS ||
      hMax > BOUND_SCALE ||
      maintenanceFeePerSlot > MAX_PROTOCOL_FEE_ABS
    ),
    PercolatorError.EngineInvalidConfig,
  );
  require(initialPrice !== 0n && initialPrice <= MAX_ORACLE_PRICE, PercolatorError.EngineInvalidConfig);
  const initSlot = currentSlot();

  // init_market_account_zero_copy.
  require(!isInitialized(m), PercolatorError.AlreadyInitialized);
  require(m.dataLen >= MIN_MARKET_ACCOUNT_LEN, PercolatorError.InvalidAccountLen);
  zeroData(m, 0n, m.dataLen);
  const header = loadRawMutAt<AccountHeader>(m, 0n);
  writeHeaderView(header, KIND_MARKET);
  // write_wrapper_config_to_bytes: the fields InitMarket sets (every other is zero), validated. The split-carry byte
  // it keeps is zero, as is the config's.
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  cfg.marketauth = admin.key;
  cfg.collateral_mint = mint.key;
  cfg.maintenance_fee_per_slot = maintenanceFeePerSlot;
  cfg.trade_fee_base_bps = tradeFeeBaseBps;
  cfg.last_good_oracle_slot = initSlot;
  cfg.mark_ewma_e6 = initialPrice;
  cfg.mark_ewma_last_slot = initSlot;
  cfg.mark_ewma_halflife_slots = DEFAULT_MARK_EWMA_HALFLIFE_SLOTS;
  cfg.oracle_target_price_e6 = initialPrice;
  cfg.next_portfolio_id = 1n;
  validateWrapperConfig(cfg);
  // asset_oracle_profile_from_config, then init_asset_oracle_profiles: validated, then written into every slot of
  // the capacity (`market_slot_capacity`: a whole number of slots, else InvalidAccountData).
  const capacity = marketSlotCapacity(m);
  const slots = rawArrayMutAt<AssetSlot>(m, MARKET_GROUP_OFF + MARKET_GROUP_LEN, capacity);
  if (capacity !== 0n) {
    // asset_oracle_profile_from_config of the config above: Manual, the admin as asset 0's admin and its four
    // authorities, the initial price as mark, target and funding mark, the init slot as the mark's and the liveness
    // slot, the default half-life; every other field zero (as the slot is).
    const p = slots.get(0n).wrapper.profile;
    p.insurance_authority = admin.key;
    p.insurance_operator = admin.key;
    p.backing_bucket_authority = admin.key;
    p.oracle_authority = admin.key;
    p.mark_ewma_e6 = initialPrice;
    p.mark_ewma_last_slot = initSlot;
    p.mark_ewma_halflife_slots = DEFAULT_MARK_EWMA_HALFLIFE_SLOTS;
    p.oracle_target_price_e6 = initialPrice;
    p.last_good_oracle_slot = initSlot;
    p.asset_admin = admin.key;
    p.funding_mark_e6 = initialPrice;
    validateAssetOracleProfile(p);
    // init_asset_oracle_profiles' copy_from_slice into each slot: the memmove syscall per slot, as the original's
    // memcpy (a struct assignment between views of one account copies with memmove from 80 bytes). The slots' view
    // checked their bounds once, so each copy is the syscall alone.
    for (let i = 1n; i < capacity; i++) slots.get(i).wrapper.profile = slots.get(0n).wrapper.profile;
  }
  // capacity > u32::MAX (InvalidAccountLen) cannot happen within an account's 10 MiB.
  // MarketGroupV16HeaderAccount::new_dynamic(market key, config, capacity, init slot).
  const h = loadRawMutAt<GroupHeader>(m, MARKET_GROUP_OFF);
  const c = h.config;
  c.max_portfolio_assets = maxPortfolioAssets;
  c.max_market_slots = u32(maxPortfolioAssets);
  c.min_nonzero_mm_req = data.readU128(27n);
  c.min_nonzero_im_req = data.readU128(43n);
  c.h_min = data.readU64(3n);
  c.h_max = hMax;
  c.maintenance_margin_bps = data.readU64(59n);
  c.initial_margin_bps = data.readU64(67n);
  c.max_trading_fee_bps = maxTradingFeeBps;
  c.liquidation_fee_bps = data.readU64(91n);
  c.liquidation_fee_cap = data.readU128(99n);
  c.min_liquidation_abs = data.readU128(115n);
  c.max_accrual_dt_slots = data.readU64(139n);
  c.max_abs_funding_e9_per_slot = data.readU64(147n);
  c.min_funding_lifetime_slots = data.readU64(155n);
  c.max_price_move_bps_per_slot = data.readU64(131n);
  c.max_account_b_settlement_chunks = data.readU64(163n);
  c.max_bankrupt_close_chunks = data.readU64(171n);
  c.max_bankrupt_close_lifetime_slots = data.readU64(179n);
  c.asset_activation_cooldown_slots = 1n;
  c.public_b_chunk_atoms = data.readU128(187n);
  c.max_recovery_fallback_deviation_bps = MAX_RECOVERY_FALLBACK_DEVIATION_BPS;
  c.backing_fee_kink_util_bps = 8000n;
  c.backing_freshness_buckets = 1n;
  c.margin_mode_realizable_full_shared_cross_margin = 1n;
  c.source_credit_lien_required = 1n;
  c.insurance_credit_reservation_required = 1n;
  c.permissionless_recovery_enabled = 1n;
  c.recovery_fallback_price_enabled = 1n;
  c.recovery_fallback_envelope_enabled = 1n;
  c.credit_lien_revalidation_required = 1n;
  c.stale_certificate_penalty_enabled = 1n;
  c.full_refresh_required_for_favorable_actions = 1n;
  c.public_liveness_profile_crank_forward = 1n;
  require(capacity >= toU64(maxPortfolioAssets), ProgramError.InvalidAccountData);
  require(configFullErr(c) === 0n, ProgramError.InvalidAccountData);
  h.market_group_id = m.key;
  h.asset_slot_capacity = u32(capacity);
  h.slot_last = initSlot;
  h.current_slot = initSlot;
  // The configured count is max_portfolio_assets, nonzero and within the capacity (checked above); next_market_id
  // is configured + 1 (new_dynamic's 1, then overwritten).
  const configured = toU64(maxPortfolioAssets);
  h.next_market_id = configured + 1n;
  for (let i = 0n; i < configured; i++) {
    // EngineAssetSlotV16Account::empty_for_market(i + 1) with the asset of AssetStateV16::default() at the initial
    // price (the slot is zero: only the nonzero fields are written).
    const e = slots.get(i).engine;
    e.asset.market_id = i + 1n;
    e.asset.lifecycle = LIFECYCLE_ACTIVE;
    e.asset.raw_oracle_target_price = initialPrice;
    e.asset.effective_price = initialPrice;
    e.asset.fund_px_last = initialPrice;
    e.asset.slot_last = initSlot;
    e.asset.a_long = ADL_ONE;
    e.asset.a_short = ADL_ONE;
    e.source_credit_long.credit_rate_num = CREDIT_RATE_SCALE;
    e.source_credit_short.credit_rate_num = CREDIT_RATE_SCALE;
    e.backing_long.market_id = i + 1n;
    e.backing_short.market_id = i + 1n;
  }
  // market_view_mut's checks hold for the bytes just written (the length and header were checked, the config validated,
  // the configured count is within the capacity); then validate_shape (InvalidAccountData).
  require(marketShapeErr(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF), capacity) === 0n, ProgramError.InvalidAccountData);
}

// ---- InitPortfolio (tag 1) --------------------------------------------------------------------------------------------------

/**
 * `handle_init_portfolio`: the owner signs; the market and portfolio writable and the program's; the portfolio not
 * initialized; the market's config and mode (Live, else EngineLockActive); the portfolio reallocated to its length
 * and rent-exempt for it; then under the market view: Live, not stale-matured, a new portfolio id, the portfolio
 * written (`init_portfolio_account_zero_copy`), validated with the market and registered, the next id stored.
 *
 * @noinline
 */
export function initPortfolio(rest: RemainingAccounts, programId: Pubkey): void {
  needAccounts(rest, 3n);
  const owner = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  signerCheck(owner);
  writableCheck(m);
  writableCheck(pa);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  require(!isInitialized(pa), PercolatorError.AlreadyInitialized);
  require(readMarketConfigMode(m) === 0n, PercolatorError.EngineLockActive);
  if (pa.dataLen !== PORTFOLIO_ACCOUNT_LEN) resizeAccount(pa, PORTFOLIO_ACCOUNT_LEN);
  require(pa.lamports >= rentExempt(PORTFOLIO_ACCOUNT_LEN), PercolatorError.RentExemptRequired);
  const markets = marketViewMut(m);
  const h = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF);
  require(h.mode === 0n, PercolatorError.EngineLockActive);
  rejectStaleLive(m);
  const cfg = loadRawMutAt<WrapperConfig>(m, HEADER_LEN);
  const id = allocatePortfolioId(cfg.next_portfolio_id);
  const lastFeeSlot = authenticatedMarketSlot(h.current_slot);
  // init_portfolio_account_zero_copy: the length is the full one (reallocated above) and the account uninitialized
  // (checked above), so it zeroes, writes the header, the provenance, the owner, the fee slot, sixteen empty legs
  // (a_basis = ADL_ONE, all else zero) and the id.
  zeroData(pa, 0n, PORTFOLIO_ACCOUNT_LEN);
  const header = loadRawMutAt<AccountHeader>(pa, 0n);
  writeHeaderView(header, KIND_PORTFOLIO);
  const p = loadRawMutAt<Portfolio>(pa, HEADER_LEN);
  p.provenance_header.market_group_id = m.key;
  p.provenance_header.portfolio_account_id = pa.key;
  p.provenance_header.owner = owner.key;
  p.provenance_header.version = V16_ACCOUNT_VERSION;
  p.provenance_header.layout_discriminator = V16_LAYOUT_DISCRIMINATOR;
  p.owner = owner.key;
  p.last_fee_slot = lastFeeSlot;
  for (let i = 0n; i < 16n; i++) p.legs.get(i).a_basis = ADL_ONE;
  const idCell = loadRawMutAt<U64Cell>(pa, PORTFOLIO_ID_OFF);
  idCell.v = id;
  // portfolio_view_mut_for_market_slots: the header and length hold; compacting the zeroed source domains changes
  // nothing.
  portfolioViewChecks(pa);
  validateWithMarket(m, pa, markets);
  registerEmptyPortfolio(m, pa, markets);
  // write_wrapper_config: only next_portfolio_id changed, which validate_wrapper_config does not look at.
  cfg.next_portfolio_id = id + 1n;
}

// ---- Deposit (tag 3) -------------------------------------------------------------------------------------------------------

/**
 * `handle_deposit(portfolio_id, expected_sequence, amount)`: the owner signs; the market, portfolio and both token
 * accounts writable; the market and portfolio the program's; SPL Token; the portfolio's id and owner-state sequence;
 * the market Live; the source token account the owner's of the market's mint, the vault the canonical one; the amount
 * a u64 and within the source's balance; the portfolio's storage grown if short; then under the market view: Live, not
 * stale-matured, the binding again, the portfolio's account id and owner, the engine deposit, the sequence advanced;
 * then the SPL Token Transfer (none for 0).
 *
 * @noinline
 */
export function deposit(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 6n);
  const owner = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  const source = rest.get(3n);
  const vault = rest.get(4n);
  const tokenProgram = rest.get(5n);
  signerCheck(owner);
  writableCheck(m);
  writableCheck(pa);
  writableCheck(source);
  writableCheck(vault);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  verifyTokenProgramV16(tokenProgram);
  const portfolioId = data.readU64(1n);
  const expectedSequence = data.readU64(9n);
  const amount = data.readU128(17n);
  expectPortfolioSequenceBinding(pa, portfolioId, expectedSequence);
  require(readMarketConfigMode(m) === 0n, PercolatorError.EngineLockActive);
  const mint = loadRawAt<WrapperConfig>(m, HEADER_LEN).collateral_mint;
  const vaultAuthority = vaultAuthorityOf(m.key, programId);
  const balance = verifyUserTokenAccount(source, owner.key, mint);
  verifyVaultTokenAccount(vault, vaultAuthority, mint);
  const amount64 = amountToU64(amount);
  require(balance >= amount64, PercolatorError.InvalidTokenAccount);
  ensurePortfolioStorage(pa);
  const markets = marketViewMut(m);
  require(loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode === 0n, PercolatorError.EngineLockActive);
  rejectStaleLive(m);
  expectPortfolioSequenceBinding(pa, portfolioId, expectedSequence);
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === owner.key, PercolatorError.Unauthorized);
  depositEngine(m, pa, markets, amount);
  advancePortfolioSequence(pa, expectedSequence);
  if (amount64 !== 0n) programAt<TokenProgram>(tokenProgram).transfer(source, vault, owner, amount64);
}

// ---- ClosePortfolio (tag 8) --------------------------------------------------------------------------------------------------

/**
 * `handle_close_portfolio(portfolio_id, expected_sequence, position_epoch)`: the closer signs; the market and
 * portfolio writable and the program's; the market's config; the portfolio's storage grown if short; then under the
 * market view: the portfolio's id, sequence and position epoch all as expected (EngineStale), its account id, the
 * owner signing or, on a resolved market, the market authority; validated with the market and deregistered (a
 * portfolio that is not empty: EngineLockActive); then `close_portfolio_account_to_market_slab`: the data zeroed and
 * dropped (realloc to 0), its lamports moved to the market.
 *
 * @noinline
 */
export function closePortfolio(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  needAccounts(rest, 3n);
  const closer = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  signerCheck(closer);
  writableCheck(m);
  writableCheck(pa);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  readMarketConfigMode(m);
  ensurePortfolioStorage(pa);
  const markets = marketViewMut(m);
  const id = readPortfolioId(pa);
  const sequence = readPortfolioMatcherSequence(pa);
  const epoch = readPortfolioPositionEpoch(pa);
  require(id === data.readU64(1n) && sequence === data.readU64(9n) && epoch === data.readU64(17n), PercolatorError.EngineStale);
  portfolioViewMut(pa);
  expectPortfolioAccountKey(pa);
  const ownerSigned = loadRawAt<Portfolio>(pa, HEADER_LEN).owner === closer.key;
  const terminal = loadRawAt<GroupHeader>(m, MARKET_GROUP_OFF).mode === MARKET_MODE_RESOLVED && liveAuthorityMatches(loadRawAt<WrapperConfig>(m, HEADER_LEN).marketauth, closer.key);
  require(ownerSigned || terminal, PercolatorError.Unauthorized);
  validateWithMarket(m, pa, markets);
  checkV16(deregisterEmptyPortfolio(m, pa, markets));
  closePortfolioToMarket(pa, m);
}

/**
 * `close_portfolio_account_to_market_slab`: the portfolio's data zeroed and dropped (realloc to 0), its lamports moved
 * to the market (EngineArithmeticOverflow past u64). ClosePortfolio and SyncMaintenanceFee close a portfolio this way.
 */
export function closePortfolioToMarket(pa: RemainingAccount, m: RemainingAccount): void {
  zeroData(pa, 0n, pa.dataLen);
  resizeAccount(pa, 0n);
  const lamports = pa.lamports;
  if (lamports !== 0n) {
    pa.lamports = 0n;
    require(m.lamports <= U64_MAX_S - lamports, PercolatorError.EngineArithmeticOverflow);
    m.lamports += lamports;
  }
}

// ---- SetMatcherConfig (tag 68) ----------------------------------------------------------------------------------------------

/**
 * `handle_set_matcher_config(portfolio_id, expected_sequence, position_epoch, asset_generation_frontier, enabled,
 * trade_fee_cap_bps, expiry_slot)`: accounts LP owner (signer), market, LP portfolio (w), then for `enabled` the
 * matcher program, its context and the matcher delegate. Before any account: the capability's shape against the
 * Clock (`matcher_capability_config_is_valid`: InvalidInstruction). Then the owner signs, the portfolio is writable,
 * both are the program's; the portfolio's provenance (`read_portfolio_owner_preflight`) names this market, itself and
 * the signer (Unauthorized); the market's next asset generation is the frontier (EngineStale); the portfolio's id,
 * owner-state sequence and position epoch are as expected (EngineStale); the storage grown if short; the matcher
 * config replaced (for `enabled`: an executable program other than this one, a context it owns of at least 64 bytes,
 * and the delegate PDA ["matcher", market, portfolio, owner, program, context]), its control word's enabled bit,
 * position epoch and fee cap set, the expiry written, the sequence advanced.
 *
 * The original borrows one account's data at a time here (the portfolio's, the market's, the context's length), so a
 * repeated account reaches no borrow conflict.
 *
 * @noinline
 */
export function setMatcherConfig(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const portfolioId = data.readU64(1n);
  const expectedSequence = data.readU64(9n);
  const positionEpoch = data.readU64(17n);
  const frontier = data.readU64(25n);
  const enabled = data.readU8(33n);
  const feeCap = data.readU16(34n);
  const expiry = data.readU64(36n);
  require(matcherCapabilityConfigIsValid(enabled, feeCap, expiry, currentSlot()), PercolatorError.InvalidInstruction);
  needAccounts(rest, 3n);
  const owner = rest.get(0n);
  const m = rest.get(1n);
  const pa = rest.get(2n);
  signerCheck(owner);
  writableCheck(pa);
  ownerCheck(m, programId);
  ownerCheck(pa, programId);
  // read_portfolio_owner_preflight: the length, the header, the provenance decoded (map_account_wire_error) and its
  // owner the portfolio's (InvalidAccountData).
  portfolioPreflightChecks(pa);
  const ph = loadRawAt<Portfolio>(pa, HEADER_LEN).provenance_header;
  require(provenanceHeaderErr(ph) === 0n, ProgramError.InvalidAccountData);
  require(loadRawAt<Portfolio>(pa, HEADER_LEN).owner === ph.owner, ProgramError.InvalidAccountData);
  require(ph.market_group_id === m.key && ph.portfolio_account_id === pa.key && ph.owner === owner.key, PercolatorError.Unauthorized);
  // read_asset_lifecycle_generation_preflight(data, 0, true): the header, the length, asset 0's slot within the data
  // when it is configured; the next market id.
  checkHeader(m, KIND_MARKET);
  validateMarketDynamicLen(m);
  const h = loadRawAt<GroupHeader>(m, marketHeaderAt(m));
  if (h.config.max_market_slots !== 0n) assetSlotAt(m, 0n);
  require(h.next_market_id === frontier, PercolatorError.EngineStale);
  const currentId = readPortfolioId(pa);
  const currentSequence = readPortfolioMatcherSequence(pa);
  const currentEpoch = readPortfolioPositionEpoch(pa);
  require(portfolioId === currentId && expectedSequence === currentSequence && positionEpoch === currentEpoch, PercolatorError.EngineStale);
  nextPortfolioMatcherSequence(currentSequence, expectedSequence);
  ensurePortfolioStorage(pa);
  // read_portfolio_matcher_config: the header, the range (the account has its full length now), `validate`.
  const at = portfolioMatcherConfigAt(pa);
  const mc = loadRawMutAt<PortfolioMatcherConfig>(pa, at);
  validateMatcherControl(mc.control);
  let control = mc.control;
  if (enabled === 0n) {
    mc.matcher_program = ZERO_KEY;
    mc.matcher_context = ZERO_KEY;
    mc.matcher_delegate = ZERO_KEY;
  } else {
    needAccounts(rest, 6n);
    const prog = rest.get(3n);
    const ctx = rest.get(4n);
    const delegate = rest.get(5n);
    require(
      !(prog.key === programId || !prog.executable || ctx.executable || ctx.owner !== prog.key || ctx.dataLen < MATCHER_CONTEXT_MIN_LEN),
      PercolatorError.InvalidInstruction,
    );
    keyCheck(delegate, findProgramAddress(["matcher", m.key, pa.key, owner.key, prog.key, ctx.key], programId));
    mc.matcher_program = prog.key;
    mc.matcher_context = ctx.key;
    mc.matcher_delegate = delegate.key;
  }
  // set_enabled (enabled ≤ 1 by the shape check), set_position_epoch (the epoch was read from the control word, so
  // within its 49 bits), set_trade_fee_cap_bps (at most 10,000 by the shape check): none can refuse.
  control = (control & ~MATCHER_ENABLED_MASK) | toU64(enabled);
  control = (control & ~MATCHER_POSITION_EPOCH_MASK) | (currentEpoch << MATCHER_POSITION_EPOCH_SHIFT);
  control = (control & ~MATCHER_TRADE_FEE_CAP_MASK) | (toU64(feeCap) << MATCHER_TRADE_FEE_CAP_SHIFT);
  mc.control = control;
  // write_portfolio_matcher_config (validated: the cap is at most 10,000), write_portfolio_matcher_expiry,
  // advance_portfolio_matcher_sequence (the sequence was checked above).
  const expiryCell = loadRawMutAt<U64Cell>(pa, PORTFOLIO_MATCHER_EXPIRY_OFF);
  expiryCell.v = expiry;
  const sequenceCell = loadRawMutAt<U64Cell>(pa, PORTFOLIO_MATCHER_SEQUENCE_OFF);
  sequenceCell.v = currentSequence + 1n;
}
