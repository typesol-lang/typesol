// A port of marginfi v2 (mrgnlabs/marginfi-v2 @ c5d440f6), Copyright mrgnlabs, licensed under the Apache License, Version 2.0.
// Marginfi's Solend integration (programs/marginfi/src/instructions/solend and programs/solend-mocks of
// mrgnlabs/marginfi-v2 @ c5d440f6): what the four Solend instructions read from Solend's accounts. Solend writes its
// accounts packed, a version byte (1) first; the reserve's fields sit at the offsets solend-mocks' SolendMinimalReserve
// gives (one more here, for the version byte), the obligation's at the ones validate_solend_obligation reads.
//
// solend-mocks has its own error enum, numbered from 6000 as Marginfi's is: MathError 6000, InvalidAccountData 6001,
// InvalidObligationCollateral 6002, InvalidObligationLiquidity 6003.
import {
  type Account,
  type AccountInfo,
  type FixedArray,
  type Pubkey,
  type u128,
  type u32,
  type u64,
  type u8,
  log,
  pubkey,
  readData,
  require,
  u64 as toU64,
} from "typesol";
import { fxFromU64, fxTryDiv, fxTryMul } from "./i80f48";
import { SOLEND_MOCKS_MATH_ERROR, solendScaledSupplies } from "./oracle";

export const SOLEND_PROGRAM_ID = pubkey("So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo");
const INVALID_ACCOUNT_DATA: u32 = 6001n;
const INVALID_OBLIGATION_COLLATERAL: u32 = 6002n;
const INVALID_OBLIGATION_LIQUIDITY: u32 = 6003n;
/** OBLIGATION_LEN */
export const SOLEND_OBLIGATION_SIZE: u64 = 1300n;

/**
 * solend-mocks' SolendMinimalReserve: a Solend reserve as Marginfi loads it (AccountLoader: owner, then a one-byte
 * discriminator, its version 1, then the size), its fields read at the offsets below.
 *
 * @repr c packed
 * @serialization bytemuck
 * @discriminator 0x01
 */
export interface SolendReserve {
  bytes: FixedArray<u8, 618>;
}

/** The reserve's lending market, liquidity mint, liquidity supply and collateral mint and supply token accounts. */
export function reserveLendingMarket(reserve: Account<SolendReserve>): Pubkey {
  return readData<Pubkey>(reserve, 10n);
}
export function reserveLiquidityMint(reserve: Account<SolendReserve>): Pubkey {
  return readData<Pubkey>(reserve, 42n);
}

/** SolendMinimalReserve::is_stale: last_update_slot behind the current slot. */
export function reserveSlot(reserve: Account<SolendReserve>): u64 {
  return readData<u64>(reserve, 1n);
}

/** collateral_to_liquidity / liquidity_to_collateral: `amount` at the reserve's exchange rate, toward −∞. */
export function convert(reserve: Account<SolendReserve>, amount: u64, toLiquidity: boolean): u64 {
  const s = solendScaledSupplies(
    readData<u64>(reserve, 171n),
    readData<u128>(reserve, 179n),
    readData<u128>(reserve, 373n),
    readData<u8>(reserve, 74n),
    readData<u64>(reserve, 259n),
  );
  require(s.err === 0n, s.err);
  const from = toLiquidity ? s.b : s.a;
  const to = toLiquidity ? s.a : s.b;
  require(from !== 0n, SOLEND_MOCKS_MATH_ERROR);
  const p = fxTryMul(fxFromU64(amount), to);
  require(p.err === 0n, SOLEND_MOCKS_MATH_ERROR);
  const q = fxTryDiv(p.v, from);
  require(q.err === 0n, SOLEND_MOCKS_MATH_ERROR);
  const n = q.v >> 48n;
  require(n >= 0n && n <= 18446744073709551615n, SOLEND_MOCKS_MATH_ERROR);
  return toU64(n);
}

/** The checks get_solend_obligation_deposit_amount and validate_solend_obligation start with. */
function checkObligationAccount(obligation: AccountInfo): void {
  require(obligation.owner === SOLEND_PROGRAM_ID, INVALID_ACCOUNT_DATA);
  require(obligation.dataLen >= SOLEND_OBLIGATION_SIZE, INVALID_ACCOUNT_DATA);
  require(readData<u8>(obligation, 0n) === 1n, INVALID_ACCOUNT_DATA);
}

/** validate_solend_obligation: one deposit, of this reserve and not empty, and no borrows. */
export function validateObligation(obligation: AccountInfo, reserve: Pubkey): void {
  checkObligationAccount(obligation);
  require(readData<u8>(obligation, 202n) === 1n, INVALID_OBLIGATION_COLLATERAL);
  require(readData<u8>(obligation, 203n) === 0n, INVALID_OBLIGATION_LIQUIDITY);
  require(readData<Pubkey>(obligation, 204n) === reserve, INVALID_OBLIGATION_COLLATERAL);
  require(readData<u64>(obligation, 236n) > 0n, INVALID_OBLIGATION_COLLATERAL);
}

/** get_solend_obligation_deposit_amount: the first deposit's collateral. */
export function obligationDeposit(obligation: AccountInfo): u64 {
  checkObligationAccount(obligation);
  return readData<u64>(obligation, 236n);
}

/** assert_within_one_token's test (the caller fails with its error), logging a mismatch as it does. */
export function withinOneToken(actual: u64, expected: u64): boolean {
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff <= 1n) return true;
  log(`Amount mismatch → actual: ${actual}, expected: ${expected}, diff: ${diff}`);
  return false;
}
