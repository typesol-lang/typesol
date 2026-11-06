// A port of Raydium AMM v4 (raydium-io/raydium-amm, program/src, d26944b), Copyright Raydium, licensed under the
// Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// The accounts (state.rs), the ray_log records (log.rs) and the errors (error.rs). Raydium AMM v4 is a native program:
// its accounts are `#[repr(C, packed)]` structs with no discriminator, read with loadRaw / loadRawMut after the same
// owner and exact-size checks its `load_checked` makes.
import { type FixedArray, type Pubkey, type u128, type u64, type u8 } from "typesol";

export const TEN_THOUSAND = 10000n;

/** AmmStatus (state.rs). */
export const STATUS_UNINITIALIZED = 0n;
export const STATUS_INITIALIZED = 1n;
export const STATUS_DISABLED = 2n;
export const STATUS_WITHDRAW_ONLY = 3n;
export const STATUS_LIQUIDITY_ONLY = 4n;
export const STATUS_ORDER_BOOK_ONLY = 5n;
export const STATUS_SWAP_ONLY = 6n;
export const STATUS_WAITING_TRADE = 7n;

/** AmmState: only IdleState is set now that the order book is gone; SetParams still accepts 0..6. */
export const STATE_IDLE = 1n;
/** AmmResetFlag. */
export const RESET_YES = 0n;
export const RESET_NO = 1n;

export interface TargetOrder {
  price: u64;
  vol: u64;
}

/** The account kept beside each pool (the order book's plan once; now its P&L baseline, calc_pnl_x / calc_pnl_y). */
export interface TargetOrders {
  owner: Pubkey;
  buyOrders: FixedArray<TargetOrder, 50>;
  padding1: FixedArray<u64, 8>;
  targetX: u128;
  targetY: u128;
  planXBuy: u128;
  planYBuy: u128;
  planXSell: u128;
  planYSell: u128;
  placedX: u128;
  placedY: u128;
  calcPnlX: u128;
  calcPnlY: u128;
  sellOrders: FixedArray<TargetOrder, 50>;
  padding2: FixedArray<u64, 6>;
  replaceBuyClientId: FixedArray<u64, 10>;
  replaceSellClientId: FixedArray<u64, 10>;
  lastOrderNumerator: u64;
  lastOrderDenominator: u64;
  planOrdersCur: u64;
  placeOrdersCur: u64;
  validBuyOrderNum: u64;
  validSellOrderNum: u64;
  padding3: FixedArray<u64, 10>;
  freeSlotBits: u128;
}

export interface Fees {
  minSeparateNumerator: u64;
  minSeparateDenominator: u64;
  tradeFeeNumerator: u64;
  tradeFeeDenominator: u64;
  pnlNumerator: u64;
  pnlDenominator: u64;
  swapFeeNumerator: u64;
  swapFeeDenominator: u64;
}

export interface StateData {
  needTakePnlCoin: u64;
  needTakePnlPc: u64;
  totalPnlPc: u64;
  totalPnlCoin: u64;
  poolOpenTime: u64;
  padding: FixedArray<u64, 2>;
  orderbookToInitTime: u64;
  swapCoinInAmount: u128;
  swapPcOutAmount: u128;
  swapAccPcFee: u64;
  swapPcInAmount: u128;
  swapCoinOutAmount: u128;
  swapAccCoinFee: u64;
}

/** A pool: 752 bytes. */
export interface AmmInfo {
  status: u64;
  nonce: u64;
  orderNum: u64;
  depth: u64;
  coinDecimals: u64;
  pcDecimals: u64;
  state: u64;
  resetFlag: u64;
  minSize: u64;
  volMaxCutRatio: u64;
  amountWave: u64;
  coinLotSize: u64;
  pcLotSize: u64;
  minPriceMultiplier: u64;
  maxPriceMultiplier: u64;
  sysDecimalValue: u64;
  fees: Fees;
  stateData: StateData;
  coinVault: Pubkey;
  pcVault: Pubkey;
  coinVaultMint: Pubkey;
  pcVaultMint: Pubkey;
  lpMint: Pubkey;
  openOrders: Pubkey;
  market: Pubkey;
  marketProgram: Pubkey;
  targetOrders: Pubkey;
  padding1: FixedArray<u64, 8>;
  ammOwner: Pubkey;
  lpAmount: u64;
  clientOrderId: u64;
  recentEpoch: u64;
  padding2: u64;
}

/** The program's one config account (PDA ["amm_config_account_seed"]): who takes P&L, the pool creation fee. */
export interface AmmConfig {
  pnlOwner: Pubkey;
  cancelOwner: Pubkey;
  pending1: FixedArray<u64, 28>;
  pending2: FixedArray<u64, 31>;
  createPoolFee: u64;
}

export const AMM_INFO_SIZE = 752n;
export const TARGET_ORDERS_SIZE = 2208n;
export const AMM_CONFIG_SIZE = 544n;

// ray_log records (log.rs): bincode of these structs, base64. LogType: 0 Init, 1 Deposit, 2 Withdraw, 3 SwapBaseIn,
// 4 SwapBaseOut.
export interface InitLog {
  logType: u8;
  time: u64;
  pcDecimals: u8;
  coinDecimals: u8;
  pcLotSize: u64;
  coinLotSize: u64;
  pcAmount: u64;
  coinAmount: u64;
  market: Pubkey;
}

export interface DepositLog {
  logType: u8;
  maxCoin: u64;
  maxPc: u64;
  base: u64;
  poolCoin: u64;
  poolPc: u64;
  poolLp: u64;
  calcPnlX: u128;
  calcPnlY: u128;
  deductCoin: u64;
  deductPc: u64;
  mintLp: u64;
}

export interface WithdrawLog {
  logType: u8;
  withdrawLp: u64;
  userLp: u64;
  poolCoin: u64;
  poolPc: u64;
  poolLp: u64;
  calcPnlX: u128;
  calcPnlY: u128;
  outCoin: u64;
  outPc: u64;
}

export interface SwapBaseInLog {
  logType: u8;
  amountIn: u64;
  minimumOut: u64;
  direction: u64;
  userSource: u64;
  poolCoin: u64;
  poolPc: u64;
  outAmount: u64;
}

export interface SwapBaseOutLog {
  logType: u8;
  maxIn: u64;
  amountOut: u64;
  direction: u64;
  userSource: u64;
  poolCoin: u64;
  poolPc: u64;
  deductIn: u64;
}

/** error.rs: `ProgramError::Custom(e as u32)`, from 0. */
export enum AmmError {
  /** @code 0 */
  AlreadyInUse = "Already in use.",
  InvalidProgramAddress = "Invalid program address.",
  ExpectedMint = "Expected mint.",
  ExpectedAccount = "Expected account.",
  InvalidCoinVault = "Invalid coin vault.",
  InvalidPCVault = "Invalid PC vault.",
  InvalidTokenLP = "Invalid token LP.",
  InvalidDestTokenCoin = "Invalid destination token coin.",
  InvalidDestTokenPC = "Invalid destination token PC.",
  InvalidPoolMint = "Invalid pool mint.",
  InvalidOpenOrders = "Invalid open orders.",
  InvalidMarket = "Invalid market.",
  InvalidMarketProgram = "Invalid market program.",
  InvalidTargetOrders = "Invalid target orders.",
  AccountNeedWriteable = "Account must be writable.",
  AccountNeedReadOnly = "Account must be read-only.",
  InvalidCoinMint = "Invalid coin mint.",
  InvalidPCMint = "Invalid PC mint.",
  InvalidOwner = "Invalid owner.",
  InvalidSupply = "Invalid supply.",
  InvalidDelegate = "Invalid delegate.",
  InvalidSignAccount = "Invalid sign account.",
  InvalidStatus = "Invalid status.",
  InvalidInstruction = "Invalid instruction.",
  WrongAccountsNumber = "Wrong accounts number.",
  InvalidTargetAccountOwner = "Invalid target account owner.",
  InvalidTargetOwner = "Invalid target owner.",
  InvalidAmmAccountOwner = "Invalid AMM account owner.",
  InvalidParamsSet = "Invalid parameter set.",
  InvalidInput = "Invalid input.",
  ExceededSlippage = "Exceeded desired slippage limit.",
  CalculationExRateFailure = "Calculation exchange rate failed.",
  CheckedSubOverflow = "Checked subtraction overflow.",
  CheckedAddOverflow = "Checked addition overflow.",
  CheckedMulOverflow = "Checked multiplication overflow.",
  CheckedDivOverflow = "Checked division overflow.",
  CheckedEmptyFunds = "Empty funds.",
  CalcPnlError = "P&L calculation error.",
  InvalidSplTokenProgram = "Invalid SPL token program.",
  TakePnlError = "Take P&L error.",
  InsufficientFunds = "Insufficient funds.",
  ConversionFailure = "Conversion to u64 failed with overflow or underflow.",
  InvalidUserToken = "User token input does not match AMM.",
  InvalidSrmMint = "Invalid SRM mint.",
  InvalidSrmToken = "Invalid SRM token.",
  TooManyOpenOrders = "Too many open orders.",
  OrderAtSlotIsPlaced = "Order at slot is already placed.",
  InvalidSysProgramAddress = "Invalid system program address.",
  InvalidFee = "Invalid fee.",
  RepeatCreateAmm = "Repeat AMM creation for the market.",
  NotAllowZeroLP = "Zero LP not allowed.",
  InvalidCloseAuthority = "Token account has a close authority.",
  InvalidFreezeAuthority = "Pool token mint has a freeze authority.",
  InvalidReferPCMint = "Invalid referrer PC mint.",
  InvalidConfigAccount = "Invalid configuration account.",
  RepeatCreateConfigAccount = "Repeat configuration account creation.",
  MarketLotSizeIsTooLarge = "Market lot size is too large.",
  InitLpAmountTooLess = "Initial LP amount is too low.",
  UnknownAmmError = "Unknown AMM error.",
  NotAllowed = "Not allowed due to same mint.",
  LamportsCalculateError = "Lamports calculate error.",
}
