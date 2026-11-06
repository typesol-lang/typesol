// Marginfi's Kamino integration (programs/marginfi/src/instructions/kamino and programs/kamino-mocks of
// mrgnlabs/marginfi-v2 @ c5d440f6): what the Kamino instructions read from klend's accounts, at the offsets
// kamino-mocks' MinimalReserve, MinimalObligation and MinimalLendingMarket give (discriminator included), and klend's
// instruction discriminators for the CPIs.
//
// kamino-mocks has its own error enum, numbered from 6000 as Marginfi's is: MathError 6000.
import { type Account, type FixedArray, type Pubkey, type u128, type u64, type u8, readData, require, u64 as toU64 } from "typesol";
import { fxFromU64, fxTryDiv, fxTryMul } from "./i80f48";
import { SOLEND_MOCKS_MATH_ERROR, kaminoScaledSupplies } from "./oracle";

/** The Obligation and LendingMarket discriminators, as little-endian u64s. */
export const KAMINO_OBLIGATION_DISC: u64 = 12082115842956709544n;
export const KAMINO_MARKET_DISC: u64 = 8654965518109930230n;
/** 8 + size_of::<MinimalReserve>(), 8 + size_of::<MinimalObligation>(), 8 + size_of::<MinimalLendingMarket>() */
export const KAMINO_RESERVE_SIZE: u64 = 8624n;
export const KAMINO_OBLIGATION_SIZE: u64 = 3344n;
export const KAMINO_MARKET_SIZE: u64 = 4664n;

/**
 * kamino-mocks' MinimalReserve, MinimalObligation and MinimalLendingMarket: klend's accounts as Marginfi loads them
 * (AccountLoader: owner, then klend's discriminator, then the size), their fields read at the offsets below.
 *
 * @repr c packed
 * @serialization bytemuck
 * @discriminator 0x2bf2ccca1af73b7f
 */
export interface KaminoReserve {
  bytes: FixedArray<u8, 8616>;
}
/**
 * @repr c packed
 * @serialization bytemuck
 * @discriminator 0xa8ce8d6a584caca7
 */
export interface KaminoObligation {
  bytes: FixedArray<u8, 3336>;
}
/**
 * @repr c packed
 * @serialization bytemuck
 * @discriminator 0xf6723262489d1c78
 */
export interface KaminoMarket {
  bytes: FixedArray<u8, 4656>;
}

/** The reserve's lending market and liquidity mint. */
export function reserveMarket(reserve: Account<KaminoReserve>): Pubkey {
  return readData<Pubkey>(reserve, 32n);
}
export function reserveMint(reserve: Account<KaminoReserve>): Pubkey {
  return readData<Pubkey>(reserve, 128n);
}
/** MinimalReserve::is_stale */
export function reserveStale(reserve: Account<KaminoReserve>, slot: u64): boolean {
  return readData<u64>(reserve, 16n) < slot;
}

/** collateral_to_liquidity / liquidity_to_collateral at the reserve's rate, toward −∞ (KaminoMocksError::MathError). */
export function kaminoConvert(reserve: Account<KaminoReserve>, amount: u64, toLiquidity: boolean): u64 {
  const s = kaminoScaledSupplies(
    readData<u64>(reserve, 224n),
    readData<u128>(reserve, 232n),
    readData<u128>(reserve, 344n),
    readData<u128>(reserve, 360n),
    readData<u128>(reserve, 376n),
    readData<u64>(reserve, 272n),
    readData<u64>(reserve, 2592n),
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

/** The obligation's i-th deposit: its reserve and collateral amount. */
export function depositReserve(obligation: Account<KaminoObligation>, i: u64): Pubkey {
  return readData<Pubkey>(obligation, 96n + 136n * i);
}
export function depositAmount(obligation: Account<KaminoObligation>, i: u64): u64 {
  return readData<u64>(obligation, 128n + 136n * i);
}
/** Whether every deposit after the first is empty. */
export function onlyFirstDeposit(obligation: Account<KaminoObligation>): boolean {
  for (let i = 1n; i < 8n; i++) if (depositAmount(obligation, i) !== 0n) return false;
  return true;
}

/** MinimalLendingMarket::is_emergency_mode */
export function marketEmergency(market: Account<KaminoMarket>): u8 {
  return readData<u8>(market, 122n);
}
