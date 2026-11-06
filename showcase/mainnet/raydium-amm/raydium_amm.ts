// A port of Raydium AMM v4 (raydium-io/raydium-amm, program/src, d26944b), Copyright Raydium, licensed under the
// Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// Raydium's original constant-product AMM, the program at 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8. It is a native
// program, not an Anchor one: one entrypoint reads a tag byte and the arguments that follow it, and takes its accounts
// by position (a swap takes 17 or 18 of them, the v2 swaps 8). So the port is one @fallback entry over
// instructionData() and remainingAccounts(), its checks, logs and errors in the original's order. A failure the
// original raises with a built-in ProgramError, or with a panic (`unwrap()`, `unimplemented!()`, an overflow), fails
// here the same way: ProgramError.X, panic(), and PANIC_ON_OVERFLOW for the arithmetic.
import {
  type Pubkey,
  type RemainingAccount,
  type RemainingAccounts,
  ProgramError,
  createProgramAddress,
  currentEpoch,
  findProgramAddress,
  findProgramAddressBump,
  instructionData,
  invoke,
  loadRaw,
  loadRawMut,
  log,
  logBase64,
  now,
  panic,
  programId,
  pubkey,
  readData,
  readonly,
  readonlySigner,
  remainingAccounts,
  rentExempt,
  require,
  u128,
  u256,
  u32,
  u64,
  u8,
  writable,
  writableSigner,
} from "typesol";
import {
  type AmmConfig,
  type AmmInfo,
  type DepositLog,
  type Fees,
  type InitLog,
  type SwapBaseInLog,
  type SwapBaseOutLog,
  type TargetOrders,
  type WithdrawLog,
  AMM_CONFIG_SIZE,
  AMM_INFO_SIZE,
  AmmError,
  RESET_NO,
  RESET_YES,
  STATE_IDLE,
  STATUS_INITIALIZED,
  STATUS_SWAP_ONLY,
  STATUS_UNINITIALIZED,
  STATUS_WAITING_TRADE,
  STATUS_WITHDRAW_ONLY,
  TARGET_ORDERS_SIZE,
  TEN_THOUSAND,
} from "./state.js";
import {
  COIN2PC,
  PC2COIN,
  calcXPower,
  ceilDiv,
  mulDiv,
  normalizeDecimalV2,
  restoreDecimal,
  sqrt128,
  sqrt256,
  swapTokenAmountBaseIn,
  swapTokenAmountBaseOut,
  toU64,
  totalCoinWithoutTakePnl,
  totalPcWithoutTakePnl,
} from "./math.js";

/** `checked_*().unwrap()` and `as_u64()` past u64 panic, as in the original (no error code). */
export const PANIC_ON_OVERFLOW = true;

// config_feature (mainnet).
const AMM_OWNER = pubkey("GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ");
const CREATE_POOL_FEE_ADDRESS = pubkey("7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5");
const COLLECT_LAMPORTS = pubkey("Rayyxz4cjBTQo7XTT1fhVNqFWK21TjiWcrtPgC3czbL");
const SPL_TOKEN = pubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SPL_ASSOCIATED_TOKEN = pubkey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM = pubkey("11111111111111111111111111111111");
const DEFAULT_PUBKEY = pubkey("11111111111111111111111111111111");

const AUTHORITY_AMM = "amm authority";
const AMM_ASSOCIATED_SEED = "amm_associated_seed";
const TARGET_ASSOCIATED_SEED = "target_associated_seed";
const COIN_VAULT_ASSOCIATED_SEED = "coin_vault_associated_seed";
const PC_VAULT_ASSOCIATED_SEED = "pc_vault_associated_seed";
const LP_MINT_ASSOCIATED_SEED = "lp_mint_associated_seed";
const AMM_CONFIG_SEED = "amm_config_account_seed";

const TOKEN_ACCOUNT_LEN = 165n;
const MINT_LEN = 82n;

// ---- Accounts --------------------------------------------------------------------------------------------------

/** `next_account_info` past the end: NotEnoughAccountKeys, where the original reaches that account. */
function need(rest: RemainingAccounts, n: u64): void {
  require(rest.length >= n, ProgramError.NotEnoughAccountKeys);
}

/** What the original reads of an SPL token account (`spl_token::state::Account::unpack`). */
export interface TokenAccountData {
  mint: Pubkey;
  owner: Pubkey;
  amount: u64;
  hasDelegate: boolean;
  hasCloseAuthority: boolean;
}

/**
 * Processor::unpack_token_account: owned by the token program (InvalidSplTokenProgram), then Account::unpack, whose
 * failures (wrong size, bad option tags or state, not initialized) are all ExpectedAccount.
 */
function unpackTokenAccount(a: RemainingAccount, tokenProgram: Pubkey): TokenAccountData {
  require(a.owner === tokenProgram, AmmError.InvalidSplTokenProgram);
  require(a.dataLen === TOKEN_ACCOUNT_LEN, AmmError.ExpectedAccount);
  const delegateTag = readData<u32>(a, 72n);
  const state = readData<u8>(a, 108n);
  const nativeTag = readData<u32>(a, 109n);
  const closeTag = readData<u32>(a, 129n);
  require(delegateTag <= 1n && nativeTag <= 1n && closeTag <= 1n && state <= 2n, AmmError.ExpectedAccount);
  require(state !== 0n, AmmError.ExpectedAccount);
  return {
    mint: readData<Pubkey>(a, 0n),
    owner: readData<Pubkey>(a, 32n),
    amount: readData<u64>(a, 64n),
    hasDelegate: delegateTag === 1n,
    hasCloseAuthority: closeTag === 1n,
  };
}

/** What the original reads of an SPL mint (`spl_token::state::Mint::unpack`). */
export interface MintData {
  hasMintAuthority: boolean;
  mintAuthority: Pubkey;
  supply: u64;
  decimals: u8;
  hasFreezeAuthority: boolean;
}

/** Processor::unpack_mint: owned by the token program (InvalidSplTokenProgram), then Mint::unpack (ExpectedMint). */
function unpackMint(a: RemainingAccount, tokenProgram: Pubkey): MintData {
  require(a.owner === tokenProgram, AmmError.InvalidSplTokenProgram);
  require(a.dataLen === MINT_LEN, AmmError.ExpectedMint);
  const authorityTag = readData<u32>(a, 0n);
  const initialized = readData<u8>(a, 45n);
  const freezeTag = readData<u32>(a, 46n);
  require(authorityTag <= 1n && freezeTag <= 1n && initialized <= 1n, AmmError.ExpectedMint);
  require(initialized === 1n, AmmError.ExpectedMint);
  return {
    hasMintAuthority: authorityTag === 1n,
    mintAuthority: readData<Pubkey>(a, 4n),
    supply: readData<u64>(a, 36n),
    decimals: readData<u8>(a, 44n),
    hasFreezeAuthority: freezeTag === 1n,
  };
}

/** check_assert_eq!'s log (log.rs log_keys_mismatch); the caller then fails with its error. */
function logMismatch(what: string, input: Pubkey, expected: Pubkey): void {
  log(`ray_log: ${what} mismatch: input:${input}, expected:${expected}`);
}

/** Processor::authority_id: create_program_address(["amm authority", nonce]); InvalidProgramAddress if none. */
function authorityId(nonce: u64): Pubkey {
  const a = createProgramAddress([AUTHORITY_AMM, u8(nonce & 255n)], programId());
  require(a !== null, AmmError.InvalidProgramAddress);
  return a;
}

/** AmmInfo::load_mut_checked's checks: this program's (InvalidAmmAccountOwner), 752 bytes, initialized. */
function checkAmm(a: RemainingAccount): void {
  require(a.owner === programId(), AmmError.InvalidAmmAccountOwner);
  require(a.dataLen === AMM_INFO_SIZE, AmmError.ExpectedAccount);
}

/** TargetOrders::load_mut_checked's checks: this program's, 2208 bytes; its owner field is the pool. */
function checkTargetOrders(a: RemainingAccount): void {
  require(a.owner === programId(), AmmError.InvalidTargetAccountOwner);
  require(a.dataLen === TARGET_ORDERS_SIZE, AmmError.ExpectedAccount);
}

/** AmmConfig::load_checked's checks. */
function checkConfig(a: RemainingAccount): void {
  require(a.owner === programId(), AmmError.InvalidOwner);
  require(a.dataLen === AMM_CONFIG_SIZE, AmmError.ExpectedAccount);
}

// ---- CPIs (invokers.rs), with the original's account metas and data -----------------------------------------

function systemTransfer(system: RemainingAccount, from: RemainingAccount, to: RemainingAccount, lamports: u64): void {
  invoke(system, [writableSigner(from), writable(to)], [u32(2n), lamports]);
}

function tokenTransfer(tokenProgram: RemainingAccount, source: RemainingAccount, dest: RemainingAccount, owner: RemainingAccount, amount: u64): void {
  invoke(tokenProgram, [writable(source), writable(dest), readonlySigner(owner)], [u8(3n), amount]);
}

function tokenTransferWithAuthority(
  tokenProgram: RemainingAccount,
  source: RemainingAccount,
  dest: RemainingAccount,
  authority: RemainingAccount,
  nonce: u64,
  amount: u64,
): void {
  invoke(tokenProgram, [writable(source), writable(dest), readonlySigner(authority)], [u8(3n), amount], [AUTHORITY_AMM, u8(nonce & 255n)]);
}

function tokenMintTo(
  tokenProgram: RemainingAccount,
  mint: RemainingAccount,
  dest: RemainingAccount,
  authority: RemainingAccount,
  nonce: u64,
  amount: u64,
): void {
  invoke(tokenProgram, [writable(mint), writable(dest), readonlySigner(authority)], [u8(7n), amount], [AUTHORITY_AMM, u8(nonce & 255n)]);
}

function tokenBurn(tokenProgram: RemainingAccount, account: RemainingAccount, mint: RemainingAccount, owner: RemainingAccount, amount: u64): void {
  invoke(tokenProgram, [writable(account), writable(mint), readonlySigner(owner)], [u8(8n), amount]);
}

// ---- P&L -------------------------------------------------------------------------------------------------------

export interface TakenPnl {
  deltaX: u128;
  deltaY: u128;
  totalPc: u64;
  totalCoin: u64;
  /** The P&L newly owed, added to the pool's need_take_pnl by the caller. */
  pcPnl: u64;
  coinPnl: u64;
}

/**
 * Processor::calc_take_pnl: when the pool's x * y grew past the last baseline's, the protocol's share of the growth
 * (pnl_numerator / pnl_denominator of the excess, at constant price) is set aside as P&L owed.
 */
function calcTakePnl(target: TargetOrders, amm: AmmInfo, totalPc: u64, totalCoin: u64, x1: u256, y1: u256): TakenPnl {
  let deltaX: u128 = 0n;
  let deltaY: u128 = 0n;
  let pc = totalPc;
  let coin = totalCoin;
  let pcPnl: u64 = 0n;
  let coinPnl: u64 = 0n;
  const calcPcAmount = restoreDecimal(target.calcPnlX, amm.pcDecimals, amm.sysDecimalValue);
  const calcCoinAmount = restoreDecimal(target.calcPnlY, amm.coinDecimals, amm.sysDecimalValue);
  if (u128(pc) * u128(coin) >= calcPcAmount * calcCoinAmount) {
    const x2 = sqrt256(calcXPower(u256(target.calcPnlX), u256(target.calcPnlY), x1, y1));
    const y2 = (x2 * y1) / x1;
    const diffX = u128(x1 - x2);
    const diffY = u128(y1 - y2);
    deltaX = (diffX * u128(amm.fees.pnlNumerator)) / u128(amm.fees.pnlDenominator);
    deltaY = (diffY * u128(amm.fees.pnlNumerator)) / u128(amm.fees.pnlDenominator);
    const diffPcPnlAmount = restoreDecimal(diffX, amm.pcDecimals, amm.sysDecimalValue);
    const diffCoinPnlAmount = restoreDecimal(diffY, amm.coinDecimals, amm.sysDecimalValue);
    const pcPnlAmount = u64((diffPcPnlAmount * u128(amm.fees.pnlNumerator)) / u128(amm.fees.pnlDenominator));
    const coinPnlAmount = u64((diffCoinPnlAmount * u128(amm.fees.pnlNumerator)) / u128(amm.fees.pnlDenominator));
    if (pcPnlAmount !== 0n && coinPnlAmount !== 0n) {
      // need_take_pnl_* += these (checked: an overflow panics before the totals change)
      pcPnl = pcPnlAmount;
      coinPnl = coinPnlAmount;
      if (amm.stateData.needTakePnlPc + pcPnl < pcPnl || amm.stateData.needTakePnlCoin + coinPnl < coinPnl) panic("overflow");
      pc = pc - pcPnlAmount;
      coin = coin - coinPnlAmount;
    } else {
      deltaX = 0n;
      deltaY = 0n;
    }
  } else {
    log(`calc_take_pnl error x:${x1}, y:${y1}, calc_pnl_x:${target.calcPnlX}, calc_pnl_y:${target.calcPnlY}`);
    require(false, AmmError.CalcPnlError);
  }
  return { deltaX, deltaY, totalPc: pc, totalCoin: coin, pcPnl, coinPnl };
}

// ---- Associated accounts of a new pool --------------------------------------------------------------------------

/**
 * generate_amm_associated_{account,spl_token,spl_mint}'s common part: the address must be the PDA
 * [program, market, seed]; an account the system program still owns is funded up to rent (at least 1 lamport),
 * allocated and assigned with the PDA signing. One that exists already is a repeat creation.
 */
function createAssociated(
  market: RemainingAccount,
  target: RemainingAccount,
  wallet: RemainingAccount,
  system: RemainingAccount,
  seed: string,
  size: u64,
  owner: Pubkey,
  mismatch: string,
  isMint: boolean,
): void {
  const expected = findProgramAddress([programId(), market.key, seed], programId());
  const bump = findProgramAddressBump([programId(), market.key, seed], programId());
  if (expected !== target.key) {
    log(mismatch);
    if (isMint) require(false, AmmError.ExpectedMint);
    require(false, AmmError.ExpectedAccount);
  }
  if (target.owner !== system.key) {
    log(expected);
    require(false, AmmError.RepeatCreateAmm);
  }
  let required = rentExempt(size);
  if (required < 1n) required = 1n;
  required = required > target.lamports ? required - target.lamports : 0n;
  if (required > 0n) systemTransfer(system, wallet, target, required);
  invoke(system, [writableSigner(target)], [u32(8n), size], [programId(), market.key, seed, bump]);
  invoke(system, [writableSigner(target)], [u32(1n), owner], [programId(), market.key, seed, bump]);
}

// ---- Instructions ----------------------------------------------------------------------------------------------

/** Tag 1: create a pool from a market's address (which only names the PDAs now), with its first liquidity. */
function initialize2(rest: RemainingAccounts, nonce: u64, openTime: u64, initPcAmount: u64, initCoinAmount: u64): void {
  const legacy = rest.length !== 19n;
  need(rest, legacy ? 21n : 19n);
  const o = legacy ? 1n : 0n; // the open orders account sits at 6 in the 21-account form
  const tokenProgram = rest.get(0n);
  const ataProgram = rest.get(1n);
  const system = rest.get(2n);
  const rentSysvar = rest.get(3n);
  const ammAcct = rest.get(4n);
  const authority = rest.get(5n);
  const lpMint = rest.get(6n + o);
  const coinMint = rest.get(7n + o);
  const pcMint = rest.get(8n + o);
  const coinVault = rest.get(9n + o);
  const pcVault = rest.get(10n + o);
  const targetAcct = rest.get(11n + o);
  const configAcct = rest.get(12n + o);
  const feeDestination = rest.get(13n + o);
  const market = rest.get(legacy ? 16n : 14n);
  const wallet = rest.get(legacy ? 17n : 15n);
  const userCoin = rest.get(legacy ? 18n : 16n);
  const userPc = rest.get(legacy ? 19n : 17n);
  const userLp = rest.get(legacy ? 20n : 18n);

  require(findProgramAddress([AMM_CONFIG_SEED], programId()) === configAcct.key && configAcct.owner === programId(), AmmError.InvalidConfigAccount);
  require(coinMint.key !== pcMint.key, AmmError.InvalidCoinMint);
  log(`initialize2: InitializeInstruction2 { nonce: ${nonce}, open_time: ${openTime}, init_pc_amount: ${initPcAmount}, init_coin_amount: ${initCoinAmount} }`);
  require(wallet.isSigner, AmmError.InvalidSignAccount);
  if (tokenProgram.key !== SPL_TOKEN) {
    logMismatch("spl_token_program", tokenProgram.key, SPL_TOKEN);
    require(false, AmmError.InvalidSplTokenProgram);
  }
  if (ataProgram.key !== SPL_ASSOCIATED_TOKEN) {
    logMismatch("spl_associated_token_account", ataProgram.key, SPL_ASSOCIATED_TOKEN);
    require(false, AmmError.InvalidSplTokenProgram);
  }
  if (system.key !== SYSTEM_PROGRAM) {
    logMismatch("sys_program", system.key, SYSTEM_PROGRAM);
    require(false, AmmError.InvalidSysProgramAddress);
  }
  const expectAuthority = findProgramAddress([AUTHORITY_AMM], programId());
  const expectNonce = findProgramAddressBump([AUTHORITY_AMM], programId());
  require(authority.key === expectAuthority && nonce === u64(expectNonce), AmmError.InvalidProgramAddress);
  require(feeDestination.key === CREATE_POOL_FEE_ADDRESS, AmmError.InvalidFee);
  checkConfig(configAcct);
  const config = loadRaw<AmmConfig>(configAcct);
  if (config.createPoolFee !== 0n) {
    systemTransfer(system, wallet, feeDestination, config.createPoolFee);
    invoke(tokenProgram, [writable(feeDestination)], [u8(17n)]);
  }
  const coinMintData = unpackMint(coinMint, SPL_TOKEN);
  const pcMintData = unpackMint(pcMint, SPL_TOKEN);

  createAssociated(
    market,
    targetAcct,
    wallet,
    system,
    TARGET_ASSOCIATED_SEED,
    TARGET_ORDERS_SIZE,
    programId(),
    "Error: Associated token address does not match seed derivation",
    false,
  );
  // The LP mint: lp decimals are the coin's; minted by the pool authority, no freeze authority.
  createAssociated(
    market,
    lpMint,
    wallet,
    system,
    LP_MINT_ASSOCIATED_SEED,
    MINT_LEN,
    SPL_TOKEN,
    "Error: Associated mint address does not match seed derivation",
    true,
  );
  invoke(tokenProgram, [writable(lpMint), readonly(rentSysvar)], [u8(0n), coinMintData.decimals, authority.key, u8(0n)]);
  createAssociated(
    market,
    coinVault,
    wallet,
    system,
    COIN_VAULT_ASSOCIATED_SEED,
    TOKEN_ACCOUNT_LEN,
    SPL_TOKEN,
    "Error: Associated token address does not match seed derivation",
    false,
  );
  invoke(tokenProgram, [writable(coinVault), readonly(coinMint), readonly(authority), readonly(rentSysvar)], [u8(1n)]);
  createAssociated(
    market,
    pcVault,
    wallet,
    system,
    PC_VAULT_ASSOCIATED_SEED,
    TOKEN_ACCOUNT_LEN,
    SPL_TOKEN,
    "Error: Associated token address does not match seed derivation",
    false,
  );
  invoke(tokenProgram, [writable(pcVault), readonly(pcMint), readonly(authority), readonly(rentSysvar)], [u8(1n)]);
  createAssociated(
    market,
    ammAcct,
    wallet,
    system,
    AMM_ASSOCIATED_SEED,
    AMM_INFO_SIZE,
    programId(),
    "Error: Associated token address does not match seed derivation",
    false,
  );

  // The creator's LP account (spl-associated-token-account Create), then the first liquidity.
  invoke(ataProgram, [writableSigner(wallet), writable(userLp), readonly(wallet), readonly(lpMint), readonly(system), readonly(tokenProgram)], [u8(0n)]);
  tokenTransfer(tokenProgram, userCoin, coinVault, wallet, initCoinAmount);
  tokenTransfer(tokenProgram, userPc, pcVault, wallet, initPcAmount);

  const amm = loadRawMut<AmmInfo>(ammAcct);
  require(amm.status === STATUS_UNINITIALIZED, AmmError.AlreadyInUse);
  const coinVaultData = unpackTokenAccount(coinVault, SPL_TOKEN);
  if (coinVaultData.owner !== authority.key) {
    logMismatch("coin_vault_owner", coinVaultData.owner, authority.key);
    require(false, AmmError.InvalidOwner);
  }
  require(coinVaultData.amount !== 0n, AmmError.InvalidSupply);
  require(!coinVaultData.hasDelegate, AmmError.InvalidDelegate);
  require(!coinVaultData.hasCloseAuthority, AmmError.InvalidCloseAuthority);
  if (coinMint.key !== coinVaultData.mint) {
    logMismatch("coin_mint", coinMint.key, coinVaultData.mint);
    require(false, AmmError.InvalidCoinMint);
  }
  const pcVaultData = unpackTokenAccount(pcVault, SPL_TOKEN);
  if (pcVaultData.owner !== authority.key) {
    logMismatch("pc_vault_owner", pcVaultData.owner, authority.key);
    require(false, AmmError.InvalidOwner);
  }
  require(pcVaultData.amount !== 0n, AmmError.InvalidSupply);
  require(!pcVaultData.hasDelegate, AmmError.InvalidDelegate);
  require(!pcVaultData.hasCloseAuthority, AmmError.InvalidCloseAuthority);
  if (pcMint.key !== pcVaultData.mint) {
    logMismatch("pc_mint", pcMint.key, pcVaultData.mint);
    require(false, AmmError.InvalidPCMint);
  }
  const lp = unpackMint(lpMint, SPL_TOKEN);
  require(lp.supply === 0n, AmmError.InvalidSupply);
  require(lp.hasMintAuthority && lp.mintAuthority === authority.key, AmmError.InvalidOwner);
  require(!lp.hasFreezeAuthority, AmmError.InvalidFreezeAuthority);

  const liquidity = toU64(sqrt128(u128(pcVaultData.amount) * u128(coinVaultData.amount)));
  let unit: u64 = 1n;
  for (let i = 0n; i < u64(lp.decimals); i++) unit *= 10n; // 10u64.checked_pow(decimals).unwrap()
  require(liquidity >= unit, AmmError.InitLpAmountTooLess);
  tokenMintTo(tokenProgram, lpMint, userLp, authority, nonce, liquidity - unit);

  // AmmInfo::initialize.
  amm.fees.minSeparateNumerator = 5n;
  amm.fees.minSeparateDenominator = TEN_THOUSAND;
  amm.fees.tradeFeeNumerator = 25n;
  amm.fees.tradeFeeDenominator = TEN_THOUSAND;
  amm.fees.pnlNumerator = 12n;
  amm.fees.pnlDenominator = 100n;
  amm.fees.swapFeeNumerator = 25n;
  amm.fees.swapFeeDenominator = TEN_THOUSAND;
  amm.stateData.poolOpenTime = openTime;
  amm.status = STATUS_UNINITIALIZED;
  amm.nonce = nonce;
  amm.orderNum = 7n;
  amm.depth = 3n;
  amm.coinDecimals = u64(coinMintData.decimals);
  amm.pcDecimals = u64(pcMintData.decimals);
  amm.state = STATE_IDLE;
  amm.resetFlag = RESET_NO;
  const decimals = pcMintData.decimals > coinMintData.decimals ? pcMintData.decimals : coinMintData.decimals;
  let sys: u64 = 1n;
  for (let i = 0n; i < u64(decimals); i++) sys *= 10n;
  amm.sysDecimalValue = sys;
  amm.minSize = 0n;
  amm.volMaxCutRatio = 500n;
  amm.amountWave = (sys * 5n) / 1000n;
  amm.coinLotSize = 0n;
  amm.pcLotSize = 0n;
  amm.minPriceMultiplier = 1n;
  amm.maxPriceMultiplier = 1000000000n;
  amm.clientOrderId = 0n;
  amm.recentEpoch = currentEpoch();

  const initLog: InitLog = {
    logType: 0n,
    time: openTime,
    pcDecimals: u8(amm.pcDecimals & 255n),
    coinDecimals: u8(amm.coinDecimals & 255n),
    pcLotSize: 0n,
    coinLotSize: 0n,
    pcAmount: pcVaultData.amount,
    coinAmount: coinVaultData.amount,
    market: market.key,
  };
  logBase64("ray_log: ", initLog);
  const x = normalizeDecimalV2(pcVaultData.amount, amm.pcDecimals, amm.sysDecimalValue);
  const y = normalizeDecimalV2(coinVaultData.amount, amm.coinDecimals, amm.sysDecimalValue);
  require(targetAcct.owner === programId(), AmmError.InvalidProgramAddress);
  const target = loadRawMut<TargetOrders>(targetAcct);
  // TargetOrders::check_init.
  require(target.owner === DEFAULT_PUBKEY, AmmError.AlreadyInUse);
  target.owner = ammAcct.key;
  target.calcPnlX = x;
  target.calcPnlY = y;
  target.freeSlotBits = 340282366920938463463374607431768211455n;

  amm.coinVault = coinVault.key;
  amm.pcVault = pcVault.key;
  amm.coinVaultMint = coinMint.key;
  amm.pcVaultMint = pcMint.key;
  amm.lpMint = lpMint.key;
  amm.market = market.key;
  amm.targetOrders = targetAcct.key;
  amm.ammOwner = AMM_OWNER;
  amm.lpAmount = liquidity;
  amm.status = openTime > u64(now()) ? STATUS_WAITING_TRADE : STATUS_SWAP_ONLY;
  amm.resetFlag = RESET_YES;
}

/** Can this status take deposits / withdrawals / swaps (AmmStatus::*_permission)? */
function depositPermission(status: u64): boolean {
  if (status > 7n) panic("internal error: entered unreachable code");
  return status === 1n || status >= 4n;
}
function withdrawPermission(status: u64): boolean {
  if (status > 7n) panic("internal error: entered unreachable code");
  return status === 1n || status >= 3n;
}
function swapPermission(status: u64): boolean {
  if (status > 7n) panic("internal error: entered unreachable code");
  return status === 1n || status >= 6n;
}

/** Tag 3: add liquidity in the pool's ratio, `base_side` 0 fixing the coin amount, else the pc amount. */
function deposit(rest: RemainingAccounts, maxCoinAmount: u64, maxPcAmount: u64, baseSide: u64, hasOtherMin: boolean, otherAmountMin: u64): void {
  const short = rest.length === 11n;
  require(short || rest.length === 14n || rest.length === 15n, AmmError.WrongAccountsNumber);
  const s = short ? 0n : 1n;
  const tokenProgram = rest.get(0n);
  const ammAcct = rest.get(1n);
  const authority = rest.get(2n);
  const targetAcct = rest.get(3n + s);
  const lpMint = rest.get(4n + s);
  const coinVault = rest.get(5n + s);
  const pcVault = rest.get(6n + s);
  const userCoin = rest.get(short ? 7n : 9n);
  const userPc = rest.get(short ? 8n : 10n);
  const userLp = rest.get(short ? 9n : 11n);
  const owner = rest.get(short ? 10n : 12n);

  checkAmm(ammAcct);
  const amm = loadRawMut<AmmInfo>(ammAcct);
  require(amm.status !== STATUS_UNINITIALIZED, AmmError.InvalidStatus);
  require(amm.pcVaultMint !== amm.coinVaultMint, AmmError.NotAllowed);
  const depositLog: DepositLog = {
    logType: 1n,
    maxCoin: maxCoinAmount,
    maxPc: maxPcAmount,
    base: baseSide,
    poolCoin: 0n,
    poolPc: 0n,
    poolLp: 0n,
    calcPnlX: 0n,
    calcPnlY: 0n,
    deductCoin: 0n,
    deductPc: 0n,
    mintLp: 0n,
  };
  if (maxCoinAmount === 0n || maxPcAmount === 0n) {
    logBase64("ray_log: ", depositLog);
    require(false, AmmError.InvalidInput);
  }
  require(owner.isSigner, AmmError.InvalidSignAccount);
  require(depositPermission(amm.status), AmmError.InvalidStatus);
  require(authority.key === authorityId(amm.nonce), AmmError.InvalidProgramAddress);
  if (tokenProgram.key !== SPL_TOKEN) {
    logMismatch("spl_token_program", tokenProgram.key, SPL_TOKEN);
    require(false, AmmError.InvalidSplTokenProgram);
  }
  require(coinVault.key === amm.coinVault && userCoin.key !== amm.coinVault, AmmError.InvalidCoinVault);
  require(pcVault.key === amm.pcVault && userPc.key !== amm.pcVault, AmmError.InvalidPCVault);
  if (lpMint.key !== amm.lpMint) {
    logMismatch("lp_mint", lpMint.key, amm.lpMint);
    require(false, AmmError.InvalidPoolMint);
  }
  if (targetAcct.key !== amm.targetOrders) {
    logMismatch("target_orders", targetAcct.key, amm.targetOrders);
    require(false, AmmError.InvalidTargetOrders);
  }
  const coinVaultData = unpackTokenAccount(coinVault, SPL_TOKEN);
  const pcVaultData = unpackTokenAccount(pcVault, SPL_TOKEN);
  const userCoinData = unpackTokenAccount(userCoin, SPL_TOKEN);
  const userPcData = unpackTokenAccount(userPc, SPL_TOKEN);
  checkTargetOrders(targetAcct);
  const target = loadRawMut<TargetOrders>(targetAcct);
  require(target.owner === ammAcct.key, AmmError.InvalidTargetOwner);

  const pc0 = totalPcWithoutTakePnl(pcVaultData.amount, amm);
  const coin0 = totalCoinWithoutTakePnl(coinVaultData.amount, amm);
  const x1 = normalizeDecimalV2(pc0, amm.pcDecimals, amm.sysDecimalValue);
  const y1 = normalizeDecimalV2(coin0, amm.coinDecimals, amm.sysDecimalValue);
  const taken = calcTakePnl(target, amm, pc0, coin0, u256(x1), u256(y1));
  amm.stateData.needTakePnlPc = amm.stateData.needTakePnlPc + taken.pcPnl;
  amm.stateData.needTakePnlCoin = amm.stateData.needTakePnlCoin + taken.coinPnl;
  const totalPc = taken.totalPc;
  const totalCoin = taken.totalCoin;

  depositLog.poolCoin = totalCoin;
  depositLog.poolPc = totalPc;
  depositLog.poolLp = amm.lpAmount;
  depositLog.calcPnlX = target.calcPnlX;
  depositLog.calcPnlY = target.calcPnlY;
  if (amm.lpAmount === 0n) {
    logBase64("ray_log: ", depositLog);
    require(false, AmmError.NotAllowZeroLP);
  }
  let deductPc: u64 = 0n;
  let deductCoin: u64 = 0n;
  let mintLp: u64 = 0n;
  if (baseSide === 0n) {
    deductPc = mulDiv(maxCoinAmount, totalPc, totalCoin, true);
    deductCoin = maxCoinAmount;
    depositLog.deductCoin = deductCoin;
    depositLog.deductPc = deductPc;
    if (deductPc > maxPcAmount || (hasOtherMin && deductPc < otherAmountMin)) {
      logBase64("ray_log: ", depositLog);
      require(false, AmmError.ExceededSlippage);
    }
    mintLp = mulDiv(amm.lpAmount, deductCoin, totalCoin, false);
  } else {
    deductCoin = mulDiv(maxPcAmount, totalCoin, totalPc, true);
    deductPc = maxPcAmount;
    depositLog.deductCoin = deductCoin;
    depositLog.deductPc = deductPc;
    if (deductCoin > maxCoinAmount || (hasOtherMin && deductCoin < otherAmountMin)) {
      logBase64("ray_log: ", depositLog);
      require(false, AmmError.ExceededSlippage);
    }
    mintLp = mulDiv(amm.lpAmount, deductPc, totalPc, false);
  }
  depositLog.mintLp = mintLp;
  logBase64("ray_log: ", depositLog);
  require(deductCoin <= userCoinData.amount && deductPc <= userPcData.amount, AmmError.InsufficientFunds);
  require(mintLp !== 0n && deductCoin !== 0n && deductPc !== 0n, AmmError.InvalidInput);
  tokenTransfer(tokenProgram, userCoin, coinVault, owner, deductCoin);
  tokenTransfer(tokenProgram, userPc, pcVault, owner, deductPc);
  tokenMintTo(tokenProgram, lpMint, userLp, authority, amm.nonce, mintLp);
  amm.lpAmount = amm.lpAmount + mintLp;
  target.calcPnlX = x1 + normalizeDecimalV2(deductPc, amm.pcDecimals, amm.sysDecimalValue) - taken.deltaX;
  target.calcPnlY = y1 + normalizeDecimalV2(deductCoin, amm.coinDecimals, amm.sysDecimalValue) - taken.deltaY;
  amm.recentEpoch = currentEpoch();
}

/** Tag 4: burn LP tokens for the pool's coin and pc in proportion. */
function withdraw(rest: RemainingAccounts, amount: u64, hasMins: boolean, minCoinAmount: u64, minPcAmount: u64): void {
  const short = rest.length === 11n;
  require(short || (rest.length >= 20n && rest.length <= 23n), AmmError.WrongAccountsNumber);
  const p = rest.length >= 22n ? 2n : 0n; // two padding accounts in the 22 / 23-account forms
  const s = short ? 0n : 1n;
  const tokenProgram = rest.get(0n);
  const ammAcct = rest.get(1n);
  const authority = rest.get(2n);
  const targetAcct = rest.get(3n + s);
  const lpMint = rest.get(4n + s);
  const coinVault = rest.get(5n + s);
  const pcVault = rest.get(6n + s);
  const userLp = rest.get(short ? 7n : 13n + p);
  const userCoin = rest.get(short ? 8n : 14n + p);
  const userPc = rest.get(short ? 9n : 15n + p);
  const owner = rest.get(short ? 10n : 16n + p);

  require(owner.isSigner, AmmError.InvalidSignAccount);
  checkAmm(ammAcct);
  const amm = loadRawMut<AmmInfo>(ammAcct);
  require(amm.status !== STATUS_UNINITIALIZED, AmmError.InvalidStatus);
  checkTargetOrders(targetAcct);
  const target = loadRawMut<TargetOrders>(targetAcct);
  require(target.owner === ammAcct.key, AmmError.InvalidTargetOwner);
  require(withdrawPermission(amm.status), AmmError.InvalidStatus);
  require(authority.key === authorityId(amm.nonce), AmmError.InvalidProgramAddress);
  if (tokenProgram.key !== SPL_TOKEN) {
    logMismatch("spl_token_program", tokenProgram.key, SPL_TOKEN);
    require(false, AmmError.InvalidSplTokenProgram);
  }
  require(coinVault.key === amm.coinVault && userCoin.key !== amm.coinVault, AmmError.InvalidCoinVault);
  require(pcVault.key === amm.pcVault && userPc.key !== amm.pcVault, AmmError.InvalidPCVault);
  if (targetAcct.key !== amm.targetOrders) {
    logMismatch("target_orders", targetAcct.key, amm.targetOrders);
    require(false, AmmError.InvalidTargetOrders);
  }
  if (lpMint.key !== amm.lpMint) {
    logMismatch("lp_mint", lpMint.key, amm.lpMint);
    require(false, AmmError.InvalidPoolMint);
  }
  const coinVaultData = unpackTokenAccount(coinVault, SPL_TOKEN);
  const pcVaultData = unpackTokenAccount(pcVault, SPL_TOKEN);
  const userCoinData = unpackTokenAccount(userCoin, SPL_TOKEN);
  const userPcData = unpackTokenAccount(userPc, SPL_TOKEN);
  require(userCoinData.mint === coinVaultData.mint && amm.coinVaultMint === userCoinData.mint, AmmError.InvalidCoinMint);
  require(userPcData.mint === pcVaultData.mint && amm.pcVaultMint === userPcData.mint, AmmError.InvalidPCMint);
  const lp = unpackMint(lpMint, SPL_TOKEN);
  const userLpData = unpackTokenAccount(userLp, SPL_TOKEN);
  require(userLpData.owner === owner.key, AmmError.InvalidOwner);
  require(userLpData.mint === lpMint.key, AmmError.InvalidTokenLP);
  require(amount <= userLpData.amount, AmmError.InsufficientFunds);
  require(amount <= lp.supply && amount < amm.lpAmount, AmmError.NotAllowZeroLP);

  let totalPc = totalPcWithoutTakePnl(pcVaultData.amount, amm);
  let totalCoin = totalCoinWithoutTakePnl(coinVaultData.amount, amm);
  const x1 = normalizeDecimalV2(totalPc, amm.pcDecimals, amm.sysDecimalValue);
  const y1 = normalizeDecimalV2(totalCoin, amm.coinDecimals, amm.sysDecimalValue);
  let deltaX: u128 = 0n;
  let deltaY: u128 = 0n;
  if (amm.status !== STATUS_WITHDRAW_ONLY) {
    const taken = calcTakePnl(target, amm, totalPc, totalCoin, u256(x1), u256(y1));
    amm.stateData.needTakePnlPc = amm.stateData.needTakePnlPc + taken.pcPnl;
    amm.stateData.needTakePnlCoin = amm.stateData.needTakePnlCoin + taken.coinPnl;
    deltaX = taken.deltaX;
    deltaY = taken.deltaY;
    totalPc = taken.totalPc;
    totalCoin = taken.totalCoin;
  }
  const coinAmount = mulDiv(totalCoin, amount, amm.lpAmount, false);
  const pcAmount = mulDiv(totalPc, amount, amm.lpAmount, false);
  const withdrawLog: WithdrawLog = {
    logType: 2n,
    withdrawLp: amount,
    userLp: userLpData.amount,
    poolCoin: totalCoin,
    poolPc: totalPc,
    poolLp: amm.lpAmount,
    calcPnlX: target.calcPnlX,
    calcPnlY: target.calcPnlY,
    outCoin: coinAmount,
    outPc: pcAmount,
  };
  logBase64("ray_log: ", withdrawLog);
  require(amount !== 0n && coinAmount !== 0n && pcAmount !== 0n, AmmError.InvalidInput);
  require(coinAmount < coinVaultData.amount && pcAmount < pcVaultData.amount, AmmError.TakePnlError);
  require(!hasMins || (minCoinAmount <= coinAmount && minPcAmount <= pcAmount), AmmError.ExceededSlippage);
  tokenTransferWithAuthority(tokenProgram, coinVault, userCoin, authority, amm.nonce, coinAmount);
  tokenTransferWithAuthority(tokenProgram, pcVault, userPc, authority, amm.nonce, pcAmount);
  tokenBurn(tokenProgram, userLp, lpMint, owner, amount);
  amm.lpAmount = amm.lpAmount - amount;
  target.calcPnlX = x1 - normalizeDecimalV2(pcAmount, amm.pcDecimals, amm.sysDecimalValue) - deltaX;
  target.calcPnlY = y1 - normalizeDecimalV2(coinAmount, amm.coinDecimals, amm.sysDecimalValue) - deltaY;
  amm.recentEpoch = currentEpoch();
}

/** Tag 7: send the P&L set aside to the P&L owner (the program's owner or the config's pnl_owner). */
function withdrawPnl(rest: RemainingAccounts): void {
  need(rest, 10n);
  const tokenProgram = rest.get(0n);
  const ammAcct = rest.get(1n);
  const configAcct = rest.get(2n);
  const authority = rest.get(3n);
  const coinVault = rest.get(4n);
  const pcVault = rest.get(5n);
  const userCoin = rest.get(6n);
  const userPc = rest.get(7n);
  const pnlOwner = rest.get(8n);
  const targetAcct = rest.get(9n);

  checkAmm(ammAcct);
  const amm = loadRawMut<AmmInfo>(ammAcct);
  require(amm.status !== STATUS_UNINITIALIZED, AmmError.InvalidStatus);
  require(authority.key === authorityId(amm.nonce), AmmError.InvalidProgramAddress);
  require(findProgramAddress([AMM_CONFIG_SEED], programId()) === configAcct.key && configAcct.owner === programId(), AmmError.InvalidConfigAccount);
  checkConfig(configAcct);
  const config = loadRaw<AmmConfig>(configAcct);
  require(pnlOwner.isSigner && (pnlOwner.key === AMM_OWNER || pnlOwner.key === config.pnlOwner), AmmError.InvalidSignAccount);
  if (coinVault.key !== amm.coinVault) {
    logMismatch("coin_vault", coinVault.key, amm.coinVault);
    require(false, AmmError.InvalidCoinVault);
  }
  if (pcVault.key !== amm.pcVault) {
    logMismatch("pc_vault", pcVault.key, amm.pcVault);
    require(false, AmmError.InvalidPCVault);
  }
  if (tokenProgram.key !== SPL_TOKEN) {
    logMismatch("spl_token_program", tokenProgram.key, SPL_TOKEN);
    require(false, AmmError.InvalidSplTokenProgram);
  }
  if (targetAcct.key !== amm.targetOrders) {
    logMismatch("target_orders", targetAcct.key, amm.targetOrders);
    require(false, AmmError.InvalidTargetOrders);
  }
  const coinVaultData = unpackTokenAccount(coinVault, SPL_TOKEN);
  const pcVaultData = unpackTokenAccount(pcVault, SPL_TOKEN);
  const userCoinData = unpackTokenAccount(userCoin, SPL_TOKEN);
  const userPcData = unpackTokenAccount(userPc, SPL_TOKEN);
  checkTargetOrders(targetAcct);
  const target = loadRawMut<TargetOrders>(targetAcct);
  require(target.owner === ammAcct.key, AmmError.InvalidTargetOwner);
  require(coinVaultData.mint === amm.coinVaultMint && userCoinData.mint === amm.coinVaultMint, AmmError.InvalidCoinMint);
  require(pcVaultData.mint === amm.pcVaultMint && userPcData.mint === amm.pcVaultMint, AmmError.InvalidPCMint);
  const pc0 = totalPcWithoutTakePnl(pcVaultData.amount, amm);
  const coin0 = totalCoinWithoutTakePnl(coinVaultData.amount, amm);
  log(`withdrawpnl need_take_coin:${amm.stateData.needTakePnlCoin}, need_take_pc:${amm.stateData.needTakePnlPc}`);
  const x1 = normalizeDecimalV2(pc0, amm.pcDecimals, amm.sysDecimalValue);
  const y1 = normalizeDecimalV2(coin0, amm.coinDecimals, amm.sysDecimalValue);
  log(`withdrawpnl total_pc:${pc0}, total_coin:${coin0}, x:${x1}, y:${y1}`);
  const taken = calcTakePnl(target, amm, pc0, coin0, u256(x1), u256(y1));
  amm.stateData.needTakePnlPc = amm.stateData.needTakePnlPc + taken.pcPnl;
  amm.stateData.needTakePnlCoin = amm.stateData.needTakePnlCoin + taken.coinPnl;
  log(
    `withdrawpnl total_pc:${taken.totalPc}, total_pc:${taken.totalCoin}, delta_x:${taken.deltaX}, delta_y:${taken.deltaY}, need_take_coin:${amm.stateData.needTakePnlCoin}, need_take_pc:${amm.stateData.needTakePnlPc}`,
  );
  require(amm.stateData.needTakePnlCoin <= coinVaultData.amount && amm.stateData.needTakePnlPc <= pcVaultData.amount, AmmError.TakePnlError);
  tokenTransferWithAuthority(tokenProgram, coinVault, userCoin, authority, amm.nonce, amm.stateData.needTakePnlCoin);
  tokenTransferWithAuthority(tokenProgram, pcVault, userPc, authority, amm.nonce, amm.stateData.needTakePnlPc);
  amm.stateData.needTakePnlCoin = 0n;
  amm.stateData.needTakePnlPc = 0n;
  target.calcPnlX = x1 - taken.deltaX;
  target.calcPnlY = y1 - taken.deltaY;
  amm.recentEpoch = currentEpoch();
}

/**
 * The swaps. v1 (tags 9, 11) takes 17 or 18 accounts (the order book's, unused now, and the target orders account
 * when 18); v2 (tags 16, 17) takes the 8 that matter. `baseIn`: the input is exact; otherwise the output is.
 */
function swap(rest: RemainingAccounts, v2: boolean, baseIn: boolean, amountA: u64, amountB: u64): void {
  let t = 0n;
  if (!v2) {
    require(rest.length === 17n || rest.length === 18n, AmmError.WrongAccountsNumber);
    t = rest.length === 18n ? 1n : 0n;
  } else need(rest, 5n);
  const tokenProgram = rest.get(0n);
  const ammAcct = rest.get(1n);
  const authority = rest.get(2n);
  const coinVault = rest.get(v2 ? 3n : 4n + t);
  const pcVault = rest.get(v2 ? 4n : 5n + t);
  checkAmm(ammAcct);
  const amm = loadRawMut<AmmInfo>(ammAcct);
  require(amm.status !== STATUS_UNINITIALIZED, AmmError.InvalidStatus);
  require(amm.pcVaultMint !== amm.coinVaultMint, AmmError.NotAllowed);
  if (v2) need(rest, 8n);
  const userSource = rest.get(v2 ? 5n : 14n + t);
  const userDestination = rest.get(v2 ? 6n : 15n + t);
  const userOwner = rest.get(v2 ? 7n : 16n + t);
  require(userOwner.isSigner, AmmError.InvalidSignAccount);
  if (tokenProgram.key !== SPL_TOKEN) {
    logMismatch("spl_token_program", tokenProgram.key, SPL_TOKEN);
    require(false, AmmError.InvalidSplTokenProgram);
  }
  const auth = authorityId(amm.nonce);
  if (authority.key !== auth) {
    // The base-out swaps log the mismatch (check_assert_eq!); the base-in ones only fail.
    if (!baseIn) logMismatch("authority", authority.key, auth);
    require(false, AmmError.InvalidProgramAddress);
  }
  if (coinVault.key !== amm.coinVault) {
    logMismatch("coin_vault", coinVault.key, amm.coinVault);
    require(false, AmmError.InvalidCoinVault);
  }
  if (pcVault.key !== amm.pcVault) {
    logMismatch("pc_vault", pcVault.key, amm.pcVault);
    require(false, AmmError.InvalidPCVault);
  }
  require(userSource.key !== amm.pcVault && userSource.key !== amm.coinVault, AmmError.InvalidUserToken);
  require(userDestination.key !== amm.pcVault && userDestination.key !== amm.coinVault, AmmError.InvalidUserToken);
  const coinVaultData = unpackTokenAccount(coinVault, SPL_TOKEN);
  const pcVaultData = unpackTokenAccount(pcVault, SPL_TOKEN);
  const sourceData = unpackTokenAccount(userSource, SPL_TOKEN);
  const destinationData = unpackTokenAccount(userDestination, SPL_TOKEN);
  if (!swapPermission(amm.status)) {
    // swap_base_out_v2 fails without the log line.
    if (baseIn && !v2) log(`swap_base_in: status ${amm.status}`);
    if (baseIn && v2) log(`swap_base_in_v2: status ${amm.status}`);
    if (!baseIn && !v2) log(`swap_base_out: status ${amm.status}`);
    require(false, AmmError.InvalidStatus);
  } else if (amm.status === STATUS_WAITING_TRADE) {
    require(u64(now()) >= amm.stateData.poolOpenTime, AmmError.InvalidStatus);
    amm.status = STATUS_SWAP_ONLY;
    if (baseIn && !v2) log("swap_base_in: WaitingTrade to SwapOnly");
    if (baseIn && v2) log("swap_base_in_v2: WaitingTrade to SwapOnly");
    if (!baseIn && !v2) log("swap_base_out: WaitingTrade to SwapOnly");
    if (!baseIn && v2) log("swap_base_out_v2: WaitingTrade to SwapOnly");
  }
  const totalPc = totalPcWithoutTakePnl(pcVaultData.amount, amm);
  const totalCoin = totalCoinWithoutTakePnl(coinVaultData.amount, amm);
  let direction: u64 = 0n;
  if (sourceData.mint === coinVaultData.mint && destinationData.mint === pcVaultData.mint) direction = COIN2PC;
  else if (sourceData.mint === pcVaultData.mint && destinationData.mint === coinVaultData.mint) direction = PC2COIN;
  else require(false, AmmError.InvalidUserToken);

  // The side the swap pays out of holds `outTotal` (less the P&L owed).
  const outTotal = direction === COIN2PC ? totalPc : totalCoin;
  if (baseIn) {
    const amountIn = amountA;
    const minimumAmountOut = amountB;
    const inLog: SwapBaseInLog = {
      logType: 3n,
      amountIn,
      minimumOut: minimumAmountOut,
      direction,
      userSource: sourceData.amount,
      poolCoin: totalCoin,
      poolPc: totalPc,
      outAmount: 0n,
    };
    if (sourceData.amount < amountIn) {
      logBase64("ray_log: ", inLog);
      require(false, AmmError.InsufficientFunds);
    }
    const swapFee = ceilDiv(u128(amountIn) * u128(amm.fees.swapFeeNumerator), u128(amm.fees.swapFeeDenominator));
    const inAfterFee = u128(amountIn) - swapFee;
    const out = u64(swapTokenAmountBaseIn(inAfterFee, u128(totalPc), u128(totalCoin), direction));
    inLog.outAmount = out;
    logBase64("ray_log: ", inLog);
    require(out >= minimumAmountOut, AmmError.ExceededSlippage);
    require(out !== 0n && amountIn !== 0n, AmmError.InvalidInput);
    require(out < outTotal, AmmError.InsufficientFunds);
    if (direction === COIN2PC) {
      tokenTransfer(tokenProgram, userSource, coinVault, userOwner, amountIn);
      tokenTransferWithAuthority(tokenProgram, pcVault, userDestination, authority, amm.nonce, out);
    } else {
      tokenTransfer(tokenProgram, userSource, pcVault, userOwner, amountIn);
      tokenTransferWithAuthority(tokenProgram, coinVault, userDestination, authority, amm.nonce, out);
    }
  } else {
    const maxAmountIn = amountA;
    const amountOut = amountB;
    const inBeforeFee = swapTokenAmountBaseOut(u128(amountOut), u128(totalPc), u128(totalCoin), direction);
    const inAfterFee = u64(ceilDiv(inBeforeFee * u128(amm.fees.swapFeeDenominator), u128(amm.fees.swapFeeDenominator - amm.fees.swapFeeNumerator)));
    const outLog: SwapBaseOutLog = {
      logType: 4n,
      maxIn: maxAmountIn,
      amountOut,
      direction,
      userSource: sourceData.amount,
      poolCoin: totalCoin,
      poolPc: totalPc,
      deductIn: inAfterFee,
    };
    logBase64("ray_log: ", outLog);
    require(sourceData.amount >= inAfterFee, AmmError.InsufficientFunds);
    require(maxAmountIn >= inAfterFee, AmmError.ExceededSlippage);
    require(inAfterFee !== 0n && amountOut !== 0n, AmmError.InvalidInput);
    require(amountOut < outTotal, AmmError.InsufficientFunds);
    if (direction === COIN2PC) {
      tokenTransfer(tokenProgram, userSource, coinVault, userOwner, inAfterFee);
      tokenTransferWithAuthority(tokenProgram, pcVault, userDestination, authority, amm.nonce, amountOut);
    } else {
      tokenTransfer(tokenProgram, userSource, pcVault, userOwner, inAfterFee);
      tokenTransferWithAuthority(tokenProgram, coinVault, userDestination, authority, amm.nonce, amountOut);
    }
  }
  amm.recentEpoch = currentEpoch();
}

/** Tag 6: the program owner sets a pool's status (0 Status), state (1 State), fees (2 Fees) or open time (3). */
function setParams(rest: RemainingAccounts, param: u64, value: u64): void {
  need(rest, 2n);
  const ammAcct = rest.get(0n);
  const ammOwner = rest.get(1n);
  checkAmm(ammAcct);
  const amm = loadRawMut<AmmInfo>(ammAcct);
  require(amm.status !== STATUS_UNINITIALIZED, AmmError.InvalidStatus);
  require(ammAcct.owner === programId(), AmmError.InvalidOwner);
  require(ammOwner.isSigner && ammOwner.key === AMM_OWNER, AmmError.InvalidSignAccount);
  if (param === 0n) {
    require(value >= 1n && value <= 7n, AmmError.InvalidInput);
    amm.status = value;
  } else if (param === 1n) {
    require(value <= 6n, AmmError.InvalidInput);
    amm.state = value;
  } else if (param === 2n) {
    // The fees come from the instruction data (setFees), already read into a struct.
  } else {
    amm.stateData.poolOpenTime = value;
  }
  amm.recentEpoch = currentEpoch();
}

/** Tag 6 with param 2: Fees::validate (each numerator below its nonzero denominator), then the new fees. */
function setFees(rest: RemainingAccounts, fees: Fees): void {
  need(rest, 2n);
  const ammAcct = rest.get(0n);
  const ammOwner = rest.get(1n);
  checkAmm(ammAcct);
  const amm = loadRawMut<AmmInfo>(ammAcct);
  require(amm.status !== STATUS_UNINITIALIZED, AmmError.InvalidStatus);
  require(ammAcct.owner === programId(), AmmError.InvalidOwner);
  require(ammOwner.isSigner && ammOwner.key === AMM_OWNER, AmmError.InvalidSignAccount);
  require(fees.minSeparateNumerator < fees.minSeparateDenominator && fees.minSeparateDenominator !== 0n, AmmError.InvalidFee);
  require(fees.tradeFeeNumerator < fees.tradeFeeDenominator && fees.tradeFeeDenominator !== 0n, AmmError.InvalidFee);
  require(fees.pnlNumerator < fees.pnlDenominator && fees.pnlDenominator !== 0n, AmmError.InvalidFee);
  require(fees.swapFeeNumerator < fees.swapFeeDenominator && fees.swapFeeDenominator !== 0n, AmmError.InvalidFee);
  amm.fees.minSeparateNumerator = fees.minSeparateNumerator;
  amm.fees.minSeparateDenominator = fees.minSeparateDenominator;
  amm.fees.tradeFeeNumerator = fees.tradeFeeNumerator;
  amm.fees.tradeFeeDenominator = fees.tradeFeeDenominator;
  amm.fees.pnlNumerator = fees.pnlNumerator;
  amm.fees.pnlDenominator = fees.pnlDenominator;
  amm.fees.swapFeeNumerator = fees.swapFeeNumerator;
  amm.fees.swapFeeDenominator = fees.swapFeeDenominator;
  amm.recentEpoch = currentEpoch();
}

/** Tag 14: the program owner creates the config account (PDA ["amm_config_account_seed"]). */
function createConfig(rest: RemainingAccounts): void {
  need(rest, 4n);
  const admin = rest.get(0n);
  const configAcct = rest.get(1n);
  const pnlOwner = rest.get(2n);
  const system = rest.get(3n);
  require(admin.isSigner && admin.key === AMM_OWNER, AmmError.InvalidSignAccount);
  require(system.key === SYSTEM_PROGRAM, AmmError.InvalidSysProgramAddress);
  const pda = findProgramAddress([AMM_CONFIG_SEED], programId());
  const bump = findProgramAddressBump([AMM_CONFIG_SEED], programId());
  require(pda === configAcct.key, AmmError.InvalidConfigAccount);
  require(configAcct.owner === system.key, AmmError.RepeatCreateConfigAccount);
  let required = rentExempt(AMM_CONFIG_SIZE);
  if (required < 1n) required = 1n;
  required = required > configAcct.lamports ? required - configAcct.lamports : 0n;
  if (required > 0n) systemTransfer(system, admin, configAcct, required);
  invoke(system, [writableSigner(configAcct)], [u32(8n), AMM_CONFIG_SIZE], [AMM_CONFIG_SEED, bump]);
  invoke(system, [writableSigner(configAcct)], [u32(1n), programId()], [AMM_CONFIG_SEED, bump]);
  checkConfig(configAcct);
  const config = loadRawMut<AmmConfig>(configAcct);
  config.pnlOwner = pnlOwner.key;
  config.createPoolFee = 0n;
}

/** Tag 15: the program owner sets the config's P&L owner (0), cancel owner (1) or pool creation fee (2). */
function updateConfig(rest: RemainingAccounts, param: u64, owner: Pubkey, fee: u64): void {
  need(rest, 2n);
  const admin = rest.get(0n);
  const configAcct = rest.get(1n);
  require(admin.isSigner && admin.key === AMM_OWNER, AmmError.InvalidSignAccount);
  require(findProgramAddress([AMM_CONFIG_SEED], programId()) === configAcct.key && configAcct.owner === programId(), AmmError.InvalidConfigAccount);
  checkConfig(configAcct);
  const config = loadRawMut<AmmConfig>(configAcct);
  if (param === 0n) {
    require(owner !== DEFAULT_PUBKEY, AmmError.InvalidInput);
    config.pnlOwner = owner;
  } else if (param === 1n) {
    require(owner !== DEFAULT_PUBKEY, AmmError.InvalidInput);
    config.cancelOwner = owner;
  } else {
    config.createPoolFee = fee;
  }
}

/**
 * Tag 18: the collector takes the lamports above rent from this program's accounts and the pool authority's token
 * accounts given after the first three (a wrapped-SOL account: the excess synced in, then unwrapped).
 */
function withdrawExcessLamports(rest: RemainingAccounts): void {
  need(rest, 3n);
  const collector = rest.get(0n);
  const authority = rest.get(1n);
  const tokenProgram = rest.get(2n);
  require(collector.isSigner && collector.key === COLLECT_LAMPORTS, AmmError.InvalidSignAccount);
  if (tokenProgram.key !== SPL_TOKEN) {
    logMismatch("spl_token_program", tokenProgram.key, SPL_TOKEN);
    require(false, AmmError.InvalidSplTokenProgram);
  }
  const auth = authorityId(254n);
  if (authority.key !== auth) {
    logMismatch("authority", authority.key, auth);
    require(false, AmmError.InvalidProgramAddress);
  }
  for (let i = 3n; i < rest.length; i++) {
    const source = rest.get(i);
    if (source.owner === SPL_TOKEN) {
      const native = source.dataLen === TOKEN_ACCOUNT_LEN && readData<u8>(source, 109n) === 1n;
      if (native) {
        const before = readData<u64>(source, 64n);
        invoke(tokenProgram, [writable(source)], [u8(17n)]);
        const after = readData<u64>(source, 64n);
        require(after >= before, ProgramError.InsufficientFunds);
        const excess = after - before;
        if (excess !== 0n) {
          invoke(tokenProgram, [writable(source), writable(collector), readonlySigner(authority)], [u8(45n), u8(1n), excess], [AUTHORITY_AMM, u8(254n)]);
          require(readData<u64>(source, 64n) === before, AmmError.LamportsCalculateError);
        }
      } else {
        invoke(tokenProgram, [writable(source), writable(collector), readonlySigner(authority)], [u8(38n)], [AUTHORITY_AMM, u8(254n)]);
      }
    } else if (source.owner === programId()) {
      const minimum = rentExempt(source.dataLen);
      require(source.lamports >= minimum, ProgramError.InsufficientFunds);
      const excess = source.lamports - minimum;
      if (excess !== 0n) {
        source.lamports = source.lamports - excess;
        collector.lamports = collector.lamports + excess;
      }
    }
  }
}

// ---- Entrypoint: AmmInstruction::unpack, then Processor::process -------------------------------------------------

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const n = data.length - 1n; // the bytes after the tag
  if (tag === 1n) {
    require(n >= 25n, ProgramError.InvalidInstructionData);
    initialize2(rest, u64(data.readU8(1n)), data.readU64(2n), data.readU64(10n), data.readU64(18n));
    return;
  }
  if (tag === 3n) {
    require(n >= 24n, ProgramError.InvalidInstructionData);
    const other = n >= 32n;
    deposit(rest, data.readU64(1n), data.readU64(9n), data.readU64(17n), other, other ? data.readU64(25n) : 0n);
    return;
  }
  if (tag === 4n) {
    require(n >= 8n, ProgramError.InvalidInstructionData);
    const mins = n >= 24n;
    withdraw(rest, data.readU64(1n), mins, mins ? data.readU64(9n) : 0n, mins ? data.readU64(17n) : 0n);
    return;
  }
  if (tag === 6n) {
    require(n >= 1n, ProgramError.InvalidInstructionData);
    const param = u64(data.readU8(1n));
    require(param <= 3n, ProgramError.InvalidInstructionData);
    if (param === 2n) {
      require(n >= 65n, ProgramError.InvalidInstructionData);
      const fees: Fees = {
        minSeparateNumerator: data.readU64(2n),
        minSeparateDenominator: data.readU64(10n),
        tradeFeeNumerator: data.readU64(18n),
        tradeFeeDenominator: data.readU64(26n),
        pnlNumerator: data.readU64(34n),
        pnlDenominator: data.readU64(42n),
        swapFeeNumerator: data.readU64(50n),
        swapFeeDenominator: data.readU64(58n),
      };
      setFees(rest, fees);
      return;
    }
    require(n >= 9n, ProgramError.InvalidInstructionData);
    setParams(rest, param, data.readU64(2n));
    return;
  }
  if (tag === 7n) {
    withdrawPnl(rest);
    return;
  }
  if (tag === 9n || tag === 11n || tag === 16n || tag === 17n) {
    require(n >= 16n, ProgramError.InvalidInstructionData);
    swap(rest, tag >= 16n, tag === 9n || tag === 16n, data.readU64(1n), data.readU64(9n));
    return;
  }
  if (tag === 14n) {
    createConfig(rest);
    return;
  }
  if (tag === 15n) {
    require(n >= 1n, ProgramError.InvalidInstructionData);
    const param = data.readU8(1n);
    if (param === 0n || param === 1n) {
      require(n >= 33n, ProgramError.InvalidInstructionData);
      updateConfig(rest, u64(param), data.readPubkey(2n), 0n);
      return;
    }
    require(param === 2n && n >= 9n, ProgramError.InvalidInstructionData);
    updateConfig(rest, 2n, DEFAULT_PUBKEY, data.readU64(2n));
    return;
  }
  if (tag === 18n) {
    withdrawExcessLamports(rest);
    return;
  }
  // Initialize, MonitorStep, MigrateToOpenBook, WithdrawSrm, PreInitialize, SimulateInfo, AdminCancelOrders.
  if (tag === 0n || tag === 2n || tag === 5n || tag === 8n || tag === 10n || tag === 12n || tag === 13n)
    panic("not implemented: This instruction is not supported");
  require(false, ProgramError.InvalidInstructionData);
}
