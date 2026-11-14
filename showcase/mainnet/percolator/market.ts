// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb, src/percolator.rs `process_instruction` and
// `handle_update_authority`), Copyright Anatoly Yakovenko, licensed under the Apache License, Version 2.0
// (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The market's own instructions: InitMarket (tag 0), CloseSlab (13), UpdateConfig (14), PushHyperpMark (17),
// SetOraclePriceCap (18) and UpdateAuthority (32). Each is the original's handler statement for statement; the
// header and config are read as copies and written back where the original writes them.
import {
  type Inout,
  type InstructionBytes,
  type Pubkey,
  type RemainingAccounts,
  type TokenProgram,
  type i64,
  i128,
  type u8,
  type u16,
  type u32,
  type u64,
  type u128,
  ProgramError,
  currentSlot,
  findProgramAddressWithBump,
  lastRestartSlot,
  loadRawMut,
  loadRawMutAt,
  programAt,
  readData,
  require,
  u64 as toU64,
  u128 as toU128,
  zeroData,
} from "typesol";
import { PercolatorError, OK, check, custom, E_ORACLE_CONF_TOO_WIDE, E_ORACLE_STALE } from "./errors.js";
import { type MarketConfig, type RiskEngine, type RiskParams, ENGINE_MAX_ACCOUNTS, ENGINE_OFF, FLAG_ORACLE_INITIALIZED, MAGIC, SLAB_LEN } from "./state.js";
import { type PriceRead, clampOraclePrice, clampTowardWithDt, computeCurrentFundingRateE9, ewmaUpdate, isHyperpMode, permissionlessStaleMatured, readEnginePriceE6, toEnginePrice, ZERO_FEED } from "./oracle.js";
import { ZERO_KEY, MAX_ORACLE_PRICE, MAX_PROTOCOL_FEE_ABS, MAX_RESOLVE_PRICE_DEVIATION_BPS, MAX_VAULT_TVL, accrueMarketTo, initInPlace } from "./engine.js";
import {
  type SlabPrefix,
  CATCHUP_CHUNKS_MAX,
  catchupAccrue,
  engineIsResolved,
  expectKey,
  expectLen,
  expectSigner,
  expectWritable,
  markOracleInitialized,
  readClock,
  readPriceAndStamp,
  requireAdmin,
  requireInitialized,
  slabGuard,
  unpackMint,
  vaultAuthority,
  verifyTokenAccount,
  verifyTokenProgram,
  verifyVault,
  withdrawCollateral,
  TOKEN_PROGRAM_ID,
  MINT_LEN,
} from "./program.js";
import { readI64 } from "./wire.js";

/** Wrapper-owned engine envelope (prog `mod constants`). */
export const MAX_ACCRUAL_DT_SLOTS = 10000000n;
export const MAX_ABS_FUNDING_E9_PER_SLOT_WRAPPER = 10000n;
export const MIN_FUNDING_LIFETIME_SLOTS = 10000000n;
export const MAX_UNIT_SCALE = 1000000000n;
export const DEFAULT_FUNDING_HORIZON_SLOTS = 500n;
export const DEFAULT_FUNDING_K_BPS = 100n;
export const DEFAULT_FUNDING_MAX_PREMIUM_BPS = 500n;
export const DEFAULT_FUNDING_MAX_E9_PER_SLOT = 1000n;
export const DEFAULT_HYPERP_PRICE_CAP_E2BPS = 10000n;
export const MAX_ORACLE_PRICE_CAP_E2BPS = 1000000n;
export const DEFAULT_MARK_EWMA_HALFLIFE_SLOTS = 100n;
export const DEFAULT_PERMISSIONLESS_RESOLVE_STALE_SLOTS = 90000n;
export const MAX_FORCE_CLOSE_DELAY_SLOTS = 10000000n;

/** UpdateAuthority kinds. */
export const AUTHORITY_ADMIN = 0n;
export const AUTHORITY_HYPERP_MARK = 1n;
export const AUTHORITY_INSURANCE = 2n;
export const AUTHORITY_INSURANCE_OPERATOR = 4n;

// ---- InitMarket (tag 0) ------------------------------------------------------------------------------------------------

/** The decoded InitMarket (decode has checked the length: 296 bytes, or 362 with the extended tail). */
/** @noinline */
export function initMarket(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const admin = data.readPubkey(1n);
  const collateralMint = data.readPubkey(33n);
  const indexFeedId = data.readPubkey(65n);
  const maxStalenessSecs = data.readU64(97n);
  const confFilterBps = data.readU16(105n);
  const invert = data.readU8(107n);
  const unitScale = data.readU32(108n);
  let initialMarkPriceE6 = data.readU64(112n);
  const maintenanceFeePerSlot = data.readU128(120n);
  const minOraclePriceCapE2bps = data.readU64(136n);
  // read_risk_params at 144.
  const params: RiskParams = {
    maintenance_margin_bps: data.readU64(152n),
    initial_margin_bps: data.readU64(160n),
    trading_fee_bps: data.readU64(168n),
    max_accounts: data.readU64(176n),
    max_crank_staleness_slots: data.readU64(208n),
    liquidation_fee_bps: data.readU64(216n),
    liquidation_fee_cap: data.readU128(224n),
    min_liquidation_abs: data.readU128(248n),
    min_nonzero_mm_req: data.readU128(264n),
    min_nonzero_im_req: data.readU128(280n),
    h_min: data.readU64(144n),
    h_max: data.readU64(200n),
    resolve_price_deviation_bps: data.readU64(240n),
    max_accrual_dt_slots: MAX_ACCRUAL_DT_SLOTS,
    max_abs_funding_e9_per_slot: MAX_ABS_FUNDING_E9_PER_SLOT_WRAPPER,
    min_funding_lifetime_slots: MIN_FUNDING_LIFETIME_SLOTS,
    max_active_positions_per_side: data.readU64(176n),
  };
  const newAccountFee = data.readU128(184n);
  const hasTail = data.length > 296n;
  const insuranceWithdrawMaxBps: u16 = hasTail ? data.readU16(296n) : 0n;
  const insuranceWithdrawCooldownSlots: u64 = hasTail ? data.readU64(298n) : 0n;
  const permissionlessResolveStaleSlots: u64 = hasTail ? data.readU64(306n) : DEFAULT_PERMISSIONLESS_RESOLVE_STALE_SLOTS;
  const fundingHorizon: u64 = hasTail ? data.readU64(314n) : DEFAULT_FUNDING_HORIZON_SLOTS;
  const fundingK: u64 = hasTail ? data.readU64(322n) : DEFAULT_FUNDING_K_BPS;
  const fundingMaxPremium: i64 = hasTail ? readI64(data, 330n) : DEFAULT_FUNDING_MAX_PREMIUM_BPS;
  const fundingMaxPerSlot: i64 = hasTail ? readI64(data, 338n) : DEFAULT_FUNDING_MAX_E9_PER_SLOT;
  const markMinFee: u64 = hasTail ? data.readU64(346n) : 0n;
  const forceCloseDelaySlots: u64 = hasTail ? data.readU64(354n) : 1n;

  expectLen(rest.length, 9n);
  const aAdmin = rest.get(0n);
  const aSlab = rest.get(1n);
  const aMint = rest.get(2n);
  const aVault = rest.get(3n);
  expectSigner(aAdmin);
  expectWritable(aSlab);
  require(admin === aAdmin.key, ProgramError.InvalidInstructionData);
  require(collateralMint === aMint.key, ProgramError.InvalidInstructionData);
  require(aMint.owner === TOKEN_PROGRAM_ID, ProgramError.IllegalOwner);
  require(aMint.dataLen === MINT_LEN, ProgramError.InvalidAccountData);
  unpackMint(aMint);
  require(invert <= 1n, ProgramError.InvalidInstructionData);
  require(confFilterBps <= 10000n, ProgramError.InvalidInstructionData);
  require(unitScale <= MAX_UNIT_SCALE, ProgramError.InvalidInstructionData);
  require(params.initial_margin_bps !== 0n && params.maintenance_margin_bps !== 0n, ProgramError.InvalidInstructionData);
  require(params.initial_margin_bps <= 10000n, ProgramError.InvalidInstructionData);
  require(params.initial_margin_bps >= params.maintenance_margin_bps, ProgramError.InvalidInstructionData);
  require(insuranceWithdrawMaxBps <= 10000n, ProgramError.InvalidInstructionData);
  require(!(insuranceWithdrawMaxBps > 0n && insuranceWithdrawCooldownSlots === 0n), ProgramError.InvalidInstructionData);
  require(maxStalenessSecs !== 0n && maxStalenessSecs <= 604800n, ProgramError.InvalidInstructionData);
  const isHyperp = indexFeedId === ZERO_FEED;
  require(!(isHyperp && initialMarkPriceE6 === 0n), ProgramError.InvalidInstructionData);
  if (isHyperp) {
    const p = toEnginePrice(initialMarkPriceE6, invert, unitScale);
    require(p !== 0n, PercolatorError.OracleInvalid);
    require(p <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
    initialMarkPriceE6 = p;
  }
  require(newAccountFee <= MAX_VAULT_TVL, ProgramError.InvalidInstructionData);
  require(!(unitScale > 0n && newAccountFee % toU128(unitScale) !== 0n), ProgramError.InvalidInstructionData);
  require(minOraclePriceCapE2bps <= MAX_ORACLE_PRICE_CAP_E2BPS, ProgramError.InvalidInstructionData);
  require(!(permissionlessResolveStaleSlots > 0n && permissionlessResolveStaleSlots <= params.max_crank_staleness_slots), ProgramError.InvalidInstructionData);
  require(!(permissionlessResolveStaleSlots > 0n && forceCloseDelaySlots === 0n), ProgramError.InvalidInstructionData);
  require(forceCloseDelaySlots <= MAX_FORCE_CLOSE_DELAY_SLOTS, ProgramError.InvalidInstructionData);
  require(!(permissionlessResolveStaleSlots > 0n && params.h_max > permissionlessResolveStaleSlots), ProgramError.InvalidInstructionData);
  require(!(permissionlessResolveStaleSlots > 0n && permissionlessResolveStaleSlots > params.max_accrual_dt_slots), ProgramError.InvalidInstructionData);
  if (isHyperp && permissionlessResolveStaleSlots > 0n)
    require(permissionlessResolveStaleSlots <= CATCHUP_CHUNKS_MAX * MAX_ACCRUAL_DT_SLOTS, ProgramError.InvalidInstructionData);
  require(!(!isHyperp && permissionlessResolveStaleSlots === 0n && minOraclePriceCapE2bps === 0n), PercolatorError.InvalidConfigParam);
  if (hasTail) {
    require(fundingHorizon !== 0n, PercolatorError.InvalidConfigParam);
    require(fundingK <= 100000n, PercolatorError.InvalidConfigParam);
    require(fundingMaxPremium >= 0n, PercolatorError.InvalidConfigParam);
    require(fundingMaxPerSlot >= 0n && i128(fundingMaxPerSlot) <= i128(params.max_abs_funding_e9_per_slot), PercolatorError.InvalidConfigParam);
  }
  require(toU128(markMinFee) <= MAX_PROTOCOL_FEE_ABS, PercolatorError.InvalidConfigParam);
  require(!(isHyperp && permissionlessResolveStaleSlots > 0n && markMinFee === 0n), ProgramError.InvalidInstructionData);

  slabGuard(aSlab, programId);
  require(readData<u64>(aSlab, 0n) !== MAGIC, PercolatorError.AlreadyInitialized);
  const [auth, bump] = findProgramAddressWithBump(["vault", aSlab.key], programId);
  verifyVault(aVault, auth, aMint.key, aVault.key, true);
  // `for b in data.iter_mut() { *b = 0; }` (a memset).
  zeroData(aSlab, 0n, SLAB_LEN);

  const clock = readClock(rest.get(5n));
  let initPrice = initialMarkPriceE6;
  let initPublishTime: i64 = 0n;
  if (!isHyperp) {
    const read: PriceRead = { price: 0n, publish_time: 0n };
    check(readEnginePriceE6(rest.get(7n), indexFeedId, clock.unix_timestamp, maxStalenessSecs, confFilterBps, invert, unitScale, read));
    require(read.price !== 0n && read.price <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
    initPrice = read.price;
    initPublishTime = read.publish_time;
  }
  // The engine's invariants, checked here so that init_in_place's asserts do not fire.
  require(params.max_accounts <= ENGINE_MAX_ACCOUNTS && params.max_accounts !== 0n, ProgramError.InvalidInstructionData);
  require(!(params.maintenance_margin_bps > params.initial_margin_bps || params.initial_margin_bps > 10000n), ProgramError.InvalidInstructionData);
  require(!(params.trading_fee_bps > 10000n || params.liquidation_fee_bps > 10000n), ProgramError.InvalidInstructionData);
  require(
    !(params.min_nonzero_mm_req === 0n || params.min_nonzero_mm_req >= params.min_nonzero_im_req || params.min_nonzero_im_req > MAX_VAULT_TVL),
    ProgramError.InvalidInstructionData,
  );
  require(!(params.min_liquidation_abs > params.liquidation_fee_cap || params.liquidation_fee_cap > MAX_PROTOCOL_FEE_ABS), ProgramError.InvalidInstructionData);
  require(!(params.h_max === 0n || params.h_min > params.h_max), ProgramError.InvalidInstructionData);
  require(!(params.resolve_price_deviation_bps === 0n || params.resolve_price_deviation_bps > MAX_RESOLVE_PRICE_DEVIATION_BPS), ProgramError.InvalidInstructionData);

  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  initInPlace(e, params, clock.slot, initPrice);
  e.last_crank_slot = clock.slot;

  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const c = prefix.config;
  c.collateral_mint = aMint.key;
  c.vault_pubkey = aVault.key;
  c.index_feed_id = indexFeedId;
  c.max_staleness_secs = maxStalenessSecs;
  c.conf_filter_bps = confFilterBps;
  c.vault_authority_bump = bump;
  c.invert = invert;
  c.unit_scale = unitScale;
  c.funding_horizon_slots = fundingHorizon;
  c.funding_k_bps = fundingK;
  c.funding_max_premium_bps = fundingMaxPremium;
  c.funding_max_e9_per_slot = fundingMaxPerSlot;
  c.hyperp_authority = isHyperp ? aAdmin.key : ZERO_KEY;
  c.hyperp_mark_e6 = isHyperp ? initialMarkPriceE6 : 0n;
  c.last_oracle_publish_time = initPublishTime;
  c.oracle_price_cap_e2bps = isHyperp ? (DEFAULT_HYPERP_PRICE_CAP_E2BPS > minOraclePriceCapE2bps ? DEFAULT_HYPERP_PRICE_CAP_E2BPS : minOraclePriceCapE2bps) : minOraclePriceCapE2bps;
  c.last_effective_price_e6 = isHyperp ? initialMarkPriceE6 : initPrice;
  c.min_oracle_price_cap_e2bps = minOraclePriceCapE2bps;
  c.insurance_withdraw_max_bps = insuranceWithdrawMaxBps;
  c.tvl_insurance_cap_mult = 0n;
  c.insurance_withdraw_cooldown_slots = insuranceWithdrawCooldownSlots;
  c.last_hyperp_index_slot = isHyperp ? clock.slot : 0n;
  c.last_mark_push_slot = isHyperp ? toU128(clock.slot) : 0n;
  c.last_insurance_withdraw_slot = 0n;
  c.mark_ewma_e6 = isHyperp ? initialMarkPriceE6 : 0n;
  c.mark_ewma_last_slot = isHyperp ? clock.slot : 0n;
  c.mark_ewma_halflife_slots = DEFAULT_MARK_EWMA_HALFLIFE_SLOTS;
  c.init_restart_slot = lastRestartSlot();
  c.permissionless_resolve_stale_slots = permissionlessResolveStaleSlots;
  c.last_good_oracle_slot = clock.slot;
  c.maintenance_fee_per_slot = maintenanceFeePerSlot;
  c.fee_sweep_cursor_word = 0n;
  c.fee_sweep_cursor_bit = 0n;
  c.mark_min_fee = markMinFee;
  c.force_close_delay_slots = forceCloseDelaySlots;
  c.new_account_fee = newAccountFee;
  // (The config was zeroed above: its padding fields stay zero.)
  require(!(isHyperp && c.oracle_price_cap_e2bps === 0n), ProgramError.InvalidInstructionData);

  const h = prefix.header;
  h.magic = MAGIC;
  h.version = 0n;
  h.bump = bump;
  h.admin = aAdmin.key;
  h.insurance_authority = aAdmin.key;
  h.insurance_operator = aAdmin.key;
  h.req_nonce = 0n;
  h.padding.set(0n, FLAG_ORACLE_INITIALIZED);
}

// ---- CloseSlab (tag 13) ------------------------------------------------------------------------------------------------

/** @noinline */
export function closeSlab(rest: RemainingAccounts, programId: Pubkey): void {
  expectLen(rest.length, 6n);
  const aDest = rest.get(0n);
  const aSlab = rest.get(1n);
  const aVault = rest.get(2n);
  const aVaultAuth = rest.get(3n);
  const aDestAta = rest.get(4n);
  expectSigner(aDest);
  expectWritable(aSlab);
  verifyTokenProgram(rest.get(5n));
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  requireAdmin(prefix.header.admin, aDest.key);
  const mint = prefix.config.collateral_mint;
  const bump = prefix.config.vault_authority_bump;
  const auth = vaultAuthority(aSlab.key, bump, programId);
  verifyVault(aVault, auth, mint, prefix.config.vault_pubkey, false);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  require(e.vault === 0n, PercolatorError.EngineInsufficientBalance);
  require(e.insurance_balance === 0n, PercolatorError.EngineInsufficientBalance);
  require(e.num_used_accounts === 0n, PercolatorError.EngineAccountNotFound);
  // The vault was unpacked by verify_vault (the second unpack cannot fail).
  const stranded = readData<u64>(aVault, 64n);
  const token = programAt<TokenProgram>(rest.get(5n));
  if (stranded > 0n) {
    verifyTokenAccount(aDestAta, aDest.key, mint);
    require(aVaultAuth.key === auth, ProgramError.InvalidSeeds);
    withdrawCollateral(token, aVault, aDestAta, aVaultAuth, stranded, aSlab.key, bump);
  }
  // The original still holds the slab's mutable borrow here, and its `invoke` borrows every account it passes: the
  // slab as the destination (an admin who is the slab) or as the vault authority (not checked when nothing was
  // drained) fails the call with AccountBorrowFailed. The vault and the token program cannot be the slab (checked).
  require(aDest.key !== aSlab.key && aVaultAuth.key !== aSlab.key, ProgramError.AccountBorrowFailed);
  token.closeAccount(aVault, aDest, aVaultAuth, ["vault", aSlab.key, bump]);
  zeroData(aSlab, 0n, SLAB_LEN);
  const lamports = aSlab.lamports;
  aSlab.lamports = 0n;
  require(aDest.lamports <= 0xffffffffffffffffn - lamports, PercolatorError.EngineOverflow);
  aDest.lamports = aDest.lamports + lamports;
}

// ---- UpdateConfig (tag 14) ---------------------------------------------------------------------------------------------
//
// The original reads the config as a copy and writes it back after the oracle read and at the end. Here the config is
// changed in place: nothing reads it in between, and a failed read changes nothing before it fails, so the bytes are
// the same (a 400-byte copy is a loop of word moves in TypeSOL, where Rust's is one memcpy).

/** @noinline */
export function updateConfig(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const fundingHorizonSlots = data.readU64(1n);
  const fundingKBps = data.readU64(9n);
  const fundingMaxPremiumBps = readI64(data, 17n);
  const fundingMaxE9PerSlot = readI64(data, 25n);
  const tvlInsuranceCapMult = data.readU16(33n);
  expectLen(rest.length, 4n);
  const aAdmin = rest.get(0n);
  const aSlab = rest.get(1n);
  expectSigner(aAdmin);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  requireAdmin(prefix.header.admin, aAdmin.key);
  require(fundingHorizonSlots !== 0n, PercolatorError.InvalidConfigParam);
  require(fundingMaxPremiumBps >= 0n && fundingMaxE9PerSlot >= 0n, PercolatorError.InvalidConfigParam);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  require(i128(fundingMaxE9PerSlot) <= i128(e.params.max_abs_funding_e9_per_slot), PercolatorError.InvalidConfigParam);
  require(fundingKBps <= 100000n, PercolatorError.InvalidConfigParam);
  const rate = computeCurrentFundingRateE9(prefix.config);
  const clock = readClock(rest.get(2n));
  require(!permissionlessStaleMatured(prefix.config, clock.slot), PercolatorError.OracleStale);
  if (isHyperpMode(prefix.config)) flushHyperpIndex(prefix.config, clock.slot);
  let accrualPrice: u64 = 0n;
  let accrualRate: i128 = 0n;
  if (isHyperpMode(prefix.config)) {
    accrualPrice = prefix.config.last_effective_price_e6;
    accrualRate = rate;
  } else {
    const read: PriceRead = { price: 0n, publish_time: 0n };
    const r = readPriceAndStamp(prefix.config, rest.get(3n), clock.unix_timestamp, clock.slot, read);
    if (r === OK) {
        accrualPrice = read.price;
      accrualRate = rate;
    } else {
      if (r !== custom(E_ORACLE_STALE) && r !== custom(E_ORACLE_CONF_TOO_WIDE)) check(r);
      accrualPrice = e.last_oracle_price;
      accrualRate = 0n;
    }
  }
  if (accrualPrice > 0n) {
    catchupAccrue(e, clock.slot, accrualRate);
    accrueMarketTo(e, clock.slot, accrualPrice, accrualRate);
    markOracleInitialized(prefix);
  }
  prefix.config.funding_horizon_slots = fundingHorizonSlots;
  prefix.config.funding_k_bps = fundingKBps;
  prefix.config.funding_max_premium_bps = fundingMaxPremiumBps;
  prefix.config.funding_max_e9_per_slot = fundingMaxE9PerSlot;
  prefix.config.tvl_insurance_cap_mult = tvlInsuranceCapMult;
}

/** The Hyperp index flush of the admin paths: toward the mark (EWMA, else pushed) without a staleness check. */
export function flushHyperpIndex(config: Inout<MarketConfig>, slot: u64): void {
  const prevIndex = config.last_effective_price_e6;
  const mark = config.mark_ewma_e6 > 0n ? config.mark_ewma_e6 : config.hyperp_mark_e6;
  if (mark > 0n && prevIndex > 0n) {
    const dt = slot > config.last_hyperp_index_slot ? slot - config.last_hyperp_index_slot : 0n;
    config.last_effective_price_e6 = clampTowardWithDt(prevIndex > 1n ? prevIndex : 1n, mark, config.oracle_price_cap_e2bps, dt);
    config.last_hyperp_index_slot = slot;
  }
}

// ---- PushHyperpMark (tag 17) -------------------------------------------------------------------------------------------

/** @noinline */
export function pushHyperpMark(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const priceE6 = data.readU64(1n);
  expectLen(rest.length, 2n);
  const aAuthority = rest.get(0n);
  const aSlab = rest.get(1n);
  expectSigner(aAuthority);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  const config: MarketConfig = prefix.config;
  require(isHyperpMode(config), PercolatorError.EngineUnauthorized);
  const rate = computeCurrentFundingRateE9(config);
  // Clock::get() (the sysvar syscall, not an account).
  const slot = currentSlot();
  require(!permissionlessStaleMatured(config, slot), PercolatorError.OracleStale);
  flushHyperpIndex(config, slot);
  prefix.config = config;
  require(config.hyperp_authority !== ZERO_KEY && config.hyperp_authority === aAuthority.key, PercolatorError.EngineUnauthorized);
  require(priceE6 !== 0n, PercolatorError.OracleInvalid);
  const normalized = toEnginePrice(priceE6, config.invert, config.unit_scale);
  require(normalized !== 0n, PercolatorError.OracleInvalid);
  require(normalized <= MAX_ORACLE_PRICE, PercolatorError.OracleInvalid);
  const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
  catchupAccrue(e, slot, rate);
  accrueMarketTo(e, slot, config.last_effective_price_e6, rate);
  const clamped = clampOraclePrice(config.last_effective_price_e6, normalized, config.oracle_price_cap_e2bps);
  config.hyperp_mark_e6 = clamped;
  config.last_mark_push_slot = toU128(slot);
  config.mark_ewma_e6 = ewmaUpdate(config.mark_ewma_e6, clamped, config.mark_ewma_halflife_slots, config.mark_ewma_last_slot, slot, config.mark_min_fee, config.mark_min_fee);
  config.mark_ewma_last_slot = slot;
  prefix.config = config;
}

// ---- SetOraclePriceCap (tag 18) ----------------------------------------------------------------------------------------

/** @noinline */
export function setOraclePriceCap(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const maxChange = data.readU64(1n);
  expectLen(rest.length, 3n);
  const aAdmin = rest.get(0n);
  const aSlab = rest.get(1n);
  expectSigner(aAdmin);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  require(!engineIsResolved(aSlab), ProgramError.InvalidAccountData);
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  requireAdmin(prefix.header.admin, aAdmin.key);
  const config: MarketConfig = prefix.config;
  const isHyperp = isHyperpMode(config);
  const rate = computeCurrentFundingRateE9(config);
  const clock = readClock(rest.get(2n));
  require(!permissionlessStaleMatured(config, clock.slot), PercolatorError.OracleStale);
  if (isHyperp) {
    flushHyperpIndex(config, clock.slot);
    prefix.config = config;
    const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
    catchupAccrue(e, clock.slot, rate);
    accrueMarketTo(e, clock.slot, config.last_effective_price_e6, rate);
  }
  require(!(isHyperp && maxChange === 0n), PercolatorError.InvalidConfigParam);
  require(!(maxChange !== 0n && maxChange < config.min_oracle_price_cap_e2bps), PercolatorError.InvalidConfigParam);
  require(!(!isHyperp && maxChange === 0n && config.min_oracle_price_cap_e2bps !== 0n), PercolatorError.InvalidConfigParam);
  require(maxChange <= MAX_ORACLE_PRICE_CAP_E2BPS, PercolatorError.InvalidConfigParam);
  config.oracle_price_cap_e2bps = maxChange;
  prefix.config = config;
}

// ---- UpdateAuthority (tag 32) ------------------------------------------------------------------------------------------

/** @noinline */
export function updateAuthority(rest: RemainingAccounts, data: InstructionBytes, programId: Pubkey): void {
  const kind = data.readU8(1n);
  const newKey = data.readPubkey(2n);
  expectLen(rest.length, 3n);
  const aCurrent = rest.get(0n);
  const aNew = rest.get(1n);
  const aSlab = rest.get(2n);
  expectSigner(aCurrent);
  expectWritable(aSlab);
  slabGuard(aSlab, programId);
  requireInitialized(aSlab);
  const isBurn = newKey === ZERO_KEY;
  const prefix = loadRawMut<SlabPrefix>(aSlab);
  if (!isBurn) {
    // Clock::get() (the syscall).
    require(!permissionlessStaleMatured(prefix.config, currentSlot()), PercolatorError.OracleStale);
    expectSigner(aNew);
    expectKey(aNew, newKey);
  }
  let current = ZERO_KEY;
  if (kind === AUTHORITY_ADMIN) current = prefix.header.admin;
  else if (kind === AUTHORITY_HYPERP_MARK) current = prefix.config.hyperp_authority;
  else if (kind === AUTHORITY_INSURANCE) current = prefix.header.insurance_authority;
  else if (kind === AUTHORITY_INSURANCE_OPERATOR) current = prefix.header.insurance_operator;
  else require(false, ProgramError.InvalidInstructionData);
  requireAdmin(current, aCurrent.key);
  if (kind === AUTHORITY_ADMIN) {
    if (isBurn) {
      const resolved = engineIsResolved(aSlab);
      const e = loadRawMutAt<RiskEngine>(aSlab, ENGINE_OFF);
      const hasAccounts = e.num_used_accounts > 0n;
      if (!resolved) {
        require(!(prefix.config.permissionless_resolve_stale_slots === 0n || prefix.config.force_close_delay_slots === 0n), PercolatorError.InvalidConfigParam);
      } else require(!(hasAccounts && prefix.config.force_close_delay_slots === 0n), PercolatorError.InvalidConfigParam);
    }
    prefix.header.admin = newKey;
  } else if (kind === AUTHORITY_HYPERP_MARK) {
    require(isHyperpMode(prefix.config), PercolatorError.InvalidConfigParam);
    require(!(isBurn && prefix.config.mark_ewma_e6 === 0n), PercolatorError.InvalidConfigParam);
    prefix.config.hyperp_authority = newKey;
  } else if (kind === AUTHORITY_INSURANCE) prefix.header.insurance_authority = newKey;
  else prefix.header.insurance_operator = newKey;
}
