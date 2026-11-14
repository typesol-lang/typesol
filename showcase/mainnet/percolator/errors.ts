// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb and aeyakovenko/percolator 3f55f87), Copyright
// Anatoly Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Changes: rewritten in TypeSOL.
//
// PercolatorError (prog `mod error`): codes from 0 in declaration order, returned as `ProgramError::Custom(e as u32)`.
// The entrypoint (solana-program 1.18's `entrypoint!`) logs nothing when an instruction fails; neither does the port
// (ERROR_LOG_PREFIX and PROGRAM_ERROR_LOG_PREFIX are null in percolator.ts).
//
// The engine returns `Result<_, RiskError>` and the program maps every error with `map_risk_error` and `?`, so an
// engine error ends the instruction with its mapped code where it happens: the port's engine fails in place with that
// code (`fail…` below). The few places where the original looks at an error before passing it on (UpdateConfig's
// degenerate arm) get the error as a value: an `Outcome` code, 0 for success.
import { type u64, ProgramError, require } from "typesol";

export enum PercolatorError {
  /** @code 0 */
  InvalidMagic = "InvalidMagic",
  InvalidVersion = "InvalidVersion",
  AlreadyInitialized = "AlreadyInitialized",
  NotInitialized = "NotInitialized",
  InvalidSlabLen = "InvalidSlabLen",
  // 5.
  InvalidOracleKey = "InvalidOracleKey",
  OracleStale = "OracleStale",
  OracleConfTooWide = "OracleConfTooWide",
  InvalidVaultAta = "InvalidVaultAta",
  InvalidMint = "InvalidMint",
  // 10.
  ExpectedSigner = "ExpectedSigner",
  ExpectedWritable = "ExpectedWritable",
  OracleInvalid = "OracleInvalid",
  EngineInsufficientBalance = "EngineInsufficientBalance",
  EngineUndercollateralized = "EngineUndercollateralized",
  // 15.
  EngineUnauthorized = "EngineUnauthorized",
  EngineInvalidMatchingEngine = "EngineInvalidMatchingEngine",
  EnginePnlNotWarmedUp = "EnginePnlNotWarmedUp",
  EngineOverflow = "EngineOverflow",
  EngineAccountNotFound = "EngineAccountNotFound",
  // 20.
  EngineNotAnLPAccount = "EngineNotAnLPAccount",
  EnginePositionSizeMismatch = "EnginePositionSizeMismatch",
  EngineRiskReductionOnlyMode = "EngineRiskReductionOnlyMode",
  EngineAccountKindMismatch = "EngineAccountKindMismatch",
  InvalidTokenAccount = "InvalidTokenAccount",
  // 25.
  InvalidTokenProgram = "InvalidTokenProgram",
  InvalidConfigParam = "InvalidConfigParam",
  HyperpTradeNoCpiDisabled = "HyperpTradeNoCpiDisabled",
  EngineCorruptState = "EngineCorruptState",
  CatchupRequired = "CatchupRequired",
  // 30.
  DepositCapExceeded = "DepositCapExceeded",
  InsuranceWithdrawCooldown = "InsuranceWithdrawCooldown",
  InsuranceWithdrawCapExceeded = "InsuranceWithdrawCapExceeded",
}

// ---- RiskError, as map_risk_error maps it --------------------------------------------------------------------------

/** RiskError::InsufficientBalance → EngineInsufficientBalance (13). */
export function failInsufficientBalance(): void {
  require(false, PercolatorError.EngineInsufficientBalance);
}
/** RiskError::Undercollateralized → EngineUndercollateralized (14). */
export function failUndercollateralized(): void {
  require(false, PercolatorError.EngineUndercollateralized);
}
/** RiskError::Unauthorized → EngineUnauthorized (15). */
export function failUnauthorized(): void {
  require(false, PercolatorError.EngineUnauthorized);
}
/** RiskError::PnlNotWarmedUp → EnginePnlNotWarmedUp (17). */
export function failPnlNotWarmedUp(): void {
  require(false, PercolatorError.EnginePnlNotWarmedUp);
}
/** RiskError::Overflow → EngineOverflow (18). */
export function failOverflow(): void {
  require(false, PercolatorError.EngineOverflow);
}
/** RiskError::AccountNotFound → EngineAccountNotFound (19). */
export function failAccountNotFound(): void {
  require(false, PercolatorError.EngineAccountNotFound);
}
/** RiskError::CorruptState → EngineCorruptState (28). */
export function failCorrupt(): void {
  require(false, PercolatorError.EngineCorruptState);
}

// ---- Errors as values ------------------------------------------------------------------------------------------------

/** A `Result<(), ProgramError>` as a number: 0 is Ok, 1 + n is Custom(n), the others name a built-in error. */
export const OK = 0n;
export const ERR_CUSTOM = 1n;
export const ERR_ILLEGAL_OWNER = 100n;
export const ERR_INVALID_ACCOUNT_DATA = 101n;

/** The Outcome of PercolatorError `code` (its number). */
export function custom(code: u64): u64 {
  return ERR_CUSTOM + code;
}
export const E_INVALID_ORACLE_KEY = 5n;
export const E_ORACLE_STALE = 6n;
export const E_ORACLE_CONF_TOO_WIDE = 7n;
export const E_ORACLE_INVALID = 12n;
export const E_ENGINE_OVERFLOW = 18n;

/** `?` on an Outcome: fail with its error unless it is OK. */
export function check(outcome: u64): void {
  if (outcome === OK) return;
  require(outcome !== ERR_ILLEGAL_OWNER, ProgramError.IllegalOwner);
  require(outcome !== ERR_INVALID_ACCOUNT_DATA, ProgramError.InvalidAccountData);
  require(outcome !== custom(E_INVALID_ORACLE_KEY), PercolatorError.InvalidOracleKey);
  require(outcome !== custom(E_ORACLE_STALE), PercolatorError.OracleStale);
  require(outcome !== custom(E_ORACLE_CONF_TOO_WIDE), PercolatorError.OracleConfTooWide);
  require(outcome !== custom(E_ORACLE_INVALID), PercolatorError.OracleInvalid);
  require(outcome !== custom(E_ENGINE_OVERFLOW), PercolatorError.EngineOverflow);
  // Every Outcome made in this program is one of the above.
  require(false, ProgramError.InvalidArgument);
}
