// A port of Phoenix v1 (Ellipsis-Labs/phoenix-v1), Copyright Ellipsis Labs, licensed under the MIT License. Changes:
// rewritten in TypeSOL.
//
// PhoenixError (program/error.rs): codes from 0, returned as `ProgramError::Custom(e as u32)` (0 as Solana's
// CUSTOM_ZERO). Each member's message is the error's Display, its `#[error(...)]` text, as Phoenix logs it
// ("ERROR: Event recorder failed to record events: {}"). The entrypoint itself logs nothing when an instruction fails;
// what Phoenix says about a failure is the `assert_with_msg` line before it (checkers.ts).

export enum PhoenixError {
  /** @code 0 */
  InvalidMarketParameters = "Invalid market parameters error",
  InvalidMarketAuthority = "Invalid market authority error",
  FailedToLoadMarketFromAccount = "Market deserialization error",
  MarketAlreadyInitialized = "Market already initialized error",
  MarketUninitialized = "Market is not initialized error",
  // 5.
  InvalidStateTransition = "Invalid state transition error",
  InvalidMarketSigner = "Invalid market signer error",
  InvalidLotSize = "Invalid lot size error",
  InvalidTickSize = "Invalid tick size error",
  InvalidMint = "Invalid mint error",
  // 10.
  InvalidBaseVault = "Invalid base vault error",
  InvalidQuoteVault = "Invalid quote vault error",
  InvalidBaseAccount = "Invalid base account error",
  InvalidQuoteAccount = "Invalid quote account error",
  TooManyEvents = "Too many events error",
  // 15.
  NewOrderError = "New order error",
  ReduceOrderError = "Reduce order error",
  CancelMultipleOrdersError = "Cancel multiple orders error",
  WithdrawFundsError = "Withdraw funds error",
  RemoveEmptyOrdersError = "Remove empty orders error",
  // 20.
  TraderNotFound = "Trader not found error",
  InvalidSeatStatus = "Invalid seat status",
  EvictionError = "Failed to evict trader",
  NonEmptyScratchBuffer = "Non empty scratch buffer",
  FailedToSerializeEvent = "Failed to serialize event",
  // 25.
  FailedToFlushBuffer = "Failed to flush buffer",
}
