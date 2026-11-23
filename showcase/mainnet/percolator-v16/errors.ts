// A port of Percolator v16 at commit 7b110913 (engine 5e3af07): aeyakovenko/percolator-prog src/v16_program.rs
// `mod error` and aeyakovenko/percolator src/v16.rs `V16Error`, Copyright Anatoly Yakovenko, licensed under the Apache
// License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in TypeSOL.
//
// PercolatorError: codes from 0 in declaration order, returned as `ProgramError::Custom(e as u32)`. The entrypoint
// logs nothing when an instruction fails; neither does the port (ERROR_LOG_PREFIX and PROGRAM_ERROR_LOG_PREFIX are
// null in percolator.ts).
//
// The engine returns `Result<_, V16Error>` and the program passes most errors on with `.map_err(map_v16_error)?`. The
// port's engine hands an error back as a value, a V16Error code below (0 for success), and the
// caller either fails with `failV16` (the original's `map_v16_error` followed by `?`) or looks at it first where the
// original matches on it (NOTES.md lists those sites). Places where the program maps an engine error to something
// else itself (`map_account_wire_error` in state.ts: always InvalidAccountData) are ported at the site.
import { type u64, require } from "typesol";

export enum PercolatorError {
  /** @code 0 */
  InvalidMagic = "InvalidMagic",
  InvalidVersion = "InvalidVersion",
  AlreadyInitialized = "AlreadyInitialized",
  NotInitialized = "NotInitialized",
  InvalidAccountKind = "InvalidAccountKind",
  // 5.
  InvalidAccountLen = "InvalidAccountLen",
  ExpectedSigner = "ExpectedSigner",
  ExpectedWritable = "ExpectedWritable",
  Unauthorized = "Unauthorized",
  InvalidInstruction = "InvalidInstruction",
  // 10.
  InvalidMint = "InvalidMint",
  InvalidTokenAccount = "InvalidTokenAccount",
  InvalidVaultAccount = "InvalidVaultAccount",
  InvalidTokenProgram = "InvalidTokenProgram",
  EngineInvalidConfig = "EngineInvalidConfig",
  // 15.
  EngineArithmeticOverflow = "EngineArithmeticOverflow",
  EngineProvenanceMismatch = "EngineProvenanceMismatch",
  EngineHiddenLeg = "EngineHiddenLeg",
  EngineInvalidLeg = "EngineInvalidLeg",
  EngineStale = "EngineStale",
  // 20.
  EngineBStale = "EngineBStale",
  EngineLockActive = "EngineLockActive",
  EngineNonProgress = "EngineNonProgress",
  EngineRecoveryRequired = "EngineRecoveryRequired",
  EngineCounterOverflow = "EngineCounterOverflow",
  // 25.
  EngineCounterUnderflow = "EngineCounterUnderflow",
  OracleInvalid = "OracleInvalid",
  OracleStale = "OracleStale",
  OracleConfTooWide = "OracleConfTooWide",
  InvalidOracleKey = "InvalidOracleKey",
  // 30.
  AssetGenerationMismatch = "AssetGenerationMismatch",
  RentExemptRequired = "RentExemptRequired",
}

// ---- V16Error, as values -------------------------------------------------------------------------------------------

/** Success, where an engine function's result is passed as a V16Error code. */
export const V16_OK = 0n;
/** `V16Error` (engine src/v16.rs), in declaration order from 1 (0 is success). */
export const V16_INVALID_CONFIG = 1n;
export const V16_ARITHMETIC_OVERFLOW = 2n;
export const V16_PROVENANCE_MISMATCH = 3n;
export const V16_HIDDEN_LEG = 4n;
export const V16_INVALID_LEG = 5n;
export const V16_STALE = 6n;
export const V16_B_STALE = 7n;
export const V16_LOCK_ACTIVE = 8n;
export const V16_NON_PROGRESS = 9n;
export const V16_RECOVERY_REQUIRED = 10n;
export const V16_COUNTER_OVERFLOW = 11n;
export const V16_COUNTER_UNDERFLOW = 12n;

/**
 * `Err(map_v16_error(err))`: fail with the PercolatorError the original maps `err` to (one arm per variant, in the
 * original's order). Every V16Error has an arm, so the last line is reached only by a code that is no V16Error, which
 * the port never makes.
 */
export function failV16(err: u64): void {
  require(err !== V16_INVALID_CONFIG, PercolatorError.EngineInvalidConfig);
  require(err !== V16_ARITHMETIC_OVERFLOW, PercolatorError.EngineArithmeticOverflow);
  require(err !== V16_PROVENANCE_MISMATCH, PercolatorError.EngineProvenanceMismatch);
  require(err !== V16_HIDDEN_LEG, PercolatorError.EngineHiddenLeg);
  require(err !== V16_INVALID_LEG, PercolatorError.EngineInvalidLeg);
  require(err !== V16_STALE, PercolatorError.EngineStale);
  require(err !== V16_B_STALE, PercolatorError.EngineBStale);
  require(err !== V16_LOCK_ACTIVE, PercolatorError.EngineLockActive);
  require(err !== V16_NON_PROGRESS, PercolatorError.EngineNonProgress);
  require(err !== V16_RECOVERY_REQUIRED, PercolatorError.EngineRecoveryRequired);
  require(err !== V16_COUNTER_OVERFLOW, PercolatorError.EngineCounterOverflow);
  require(err !== V16_COUNTER_UNDERFLOW, PercolatorError.EngineCounterUnderflow);
  require(false, PercolatorError.EngineInvalidConfig);
}

/** `.map_err(map_v16_error)?` on an engine result passed as a value: nothing on success, else `failV16`. */
export function checkV16(err: u64): void {
  if (err !== V16_OK) failV16(err);
}
