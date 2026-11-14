// A port of Percolator v12.20 (aeyakovenko/percolator-prog 06f86fb and aeyakovenko/percolator 3f55f87), Copyright
// Anatoly Yakovenko, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
// Changes: rewritten in TypeSOL.
//
// Percolator v12.20, the program at BCGNFw6vDinWTF9AybAbi8vr69gx5nk5w8o2vEWgpsiw (upgrade authority burned): a
// perpetual-futures risk engine in one zero-copy account, the slab (state.ts). It is a native program
// (solana-program 1.18 `entrypoint!`): a u8 tag, the arguments little-endian after it, accounts by position. The whole
// instruction is decoded first (`Instruction::decode`: InvalidInstructionData for an unknown tag, short data or
// trailing bytes), then the handler runs.
//
// The handlers live by subject: market.ts (InitMarket, CloseSlab, UpdateConfig, PushHyperpMark, SetOraclePriceCap,
// UpdateAuthority), users.ts (InitUser, InitLP, DepositCollateral, WithdrawCollateral, CloseAccount, TopUpInsurance,
// ReclaimEmptyAccount, SettleAccount, DepositFeeCredits, ConvertReleasedPnl), trade.ts (TradeNoCpi, TradeCpi), crank.ts
// (KeeperCrank, LiquidateAtOracle, CatchupAccrue) and resolve.ts (ResolveMarket, WithdrawInsurance,
// AdminForceCloseAccount, WithdrawInsuranceLimited, ResolvePermissionless, ForceCloseResolved). Beside them: engine.ts
// (the risk engine), wide.ts (its 256-bit arithmetic), oracle.ts (Pyth / Chainlink / Hyperp prices), program.ts (the
// checks and helpers every handler shares), errors.ts, wire.ts and state.ts. All 27 instructions are ported.
import { type InstructionBytes, ProgramError, instructionData, invoke, programId, readonlySigner, remainingAccounts, require, u8, writable } from "typesol";
import { closeSlab, initMarket, pushHyperpMark, setOraclePriceCap, updateAuthority, updateConfig } from "./market.js";
import { closeAccount, convertReleasedPnl, deposit, depositFeeCredits, initAccount, reclaimEmptyAccount, settleAccount, topUpInsurance, withdraw } from "./users.js";
import { tradeCpiAfter, tradeCpiBefore, tradeNoCpi } from "./trade.js";
import { catchupAccrueIx, keeperCrank, liquidateAtOracle } from "./crank.js";
import { adminForceCloseAccount, forceCloseResolved, resolveMarket, resolvePermissionless, withdrawInsurance, withdrawInsuranceLimited } from "./resolve.js";

/** The slab, the header and the config are views of one account, written in place as the original writes them. */
export const NATIVE_ACCOUNT_WRITES = true;
/**
 * Rust panics as solana-program 1.18's handler reports them (rustc 1.73 and later): one log line
 * `panicked at <file>:<line>:<col>:` and the message after a newline, then abort ("SBF program panicked").
 */
export const PANIC_STYLE = "solana-1.18";
/** The entrypoint logs nothing when an instruction fails. */
export const ERROR_LOG_PREFIX = null;
export const PROGRAM_ERROR_LOG_PREFIX = null;
/** TradeCpi forwards any number of tail accounts; every other handler checks its exact count itself. */
export const MAX_ACCOUNTS = 255n;

/** Instruction::decode's length rules (the arguments themselves are read by the handlers). */
function decode(data: InstructionBytes): void {
  require(data.length >= 1n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const n = data.length - 1n;
  if (tag === 0n) {
    // 295 bytes of fixed fields, then either nothing or the whole 66-byte extended tail.
    require(n === 295n || n === 361n, ProgramError.InvalidInstructionData);
  } else if (tag === 5n) {
    // KeeperCrank's candidates are read and checked by its handler, first thing (crank.ts `keeperCrank`).
  } else {
    let want = 0n;
    if (tag === 1n) want = 8n;
    else if (tag === 2n) want = 72n;
    else if (tag === 3n || tag === 4n || tag === 27n || tag === 28n) want = 10n;
    else if (tag === 6n) want = 20n;
    else if (tag === 7n || tag === 8n || tag === 21n || tag === 25n || tag === 26n || tag === 30n) want = 2n;
    else if (tag === 9n || tag === 18n || tag === 23n) want = 8n;
    else if (tag === 10n) want = 28n;
    else if (tag === 13n || tag === 19n || tag === 20n || tag === 29n || tag === 31n) want = 0n;
    else if (tag === 14n) want = 34n;
    else if (tag === 17n) want = 16n;
    else if (tag === 32n) want = 33n;
    else require(false, ProgramError.InvalidInstructionData);
    require(n === want, ProgramError.InvalidInstructionData);
  }
}

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  const id = programId();
  decode(data);
  const tag = data.readU8(0n);
  if (tag === 0n) initMarket(rest, data, id);
  else if (tag === 1n) initAccount(rest, data, id, false);
  else if (tag === 2n) initAccount(rest, data, id, true);
  else if (tag === 3n) deposit(rest, data, id);
  else if (tag === 4n) withdraw(rest, data, id);
  else if (tag === 5n) keeperCrank(rest, data, id);
  else if (tag === 6n) tradeNoCpi(rest, data, id);
  else if (tag === 7n) liquidateAtOracle(rest, data, id);
  else if (tag === 8n) closeAccount(rest, data, id);
  else if (tag === 9n) topUpInsurance(rest, data, id);
  else if (tag === 10n) {
    // TradeCpi: the matcher call (zc::invoke_signed_trade) signed by the LP PDA ["lp", slab, lp_idx], with the
    // 67-byte request (tag 0, req_id, lp_idx, lp_account_id, oracle price, size, 24 zero bytes) and the tail of
    // accounts after the eighth forwarded with their flags.
    const t = tradeCpiBefore(rest, data, id);
    invoke(
      rest.get(5n),
      [readonlySigner(rest.get(7n)), writable(rest.get(6n)), ...rest.slice(8n)],
      [u8(0n), t.req_id, t.lp_idx, t.lp_account_id, t.price, t.size, 0n, 0n, 0n],
      ["lp", rest.get(2n).key, t.lp_idx, t.bump],
    );
    tradeCpiAfter(rest, data, t);
  }
  else if (tag === 13n) closeSlab(rest, id);
  else if (tag === 14n) updateConfig(rest, data, id);
  else if (tag === 17n) pushHyperpMark(rest, data, id);
  else if (tag === 18n) setOraclePriceCap(rest, data, id);
  else if (tag === 19n) resolveMarket(rest, id);
  else if (tag === 20n) withdrawInsurance(rest, id);
  else if (tag === 21n) adminForceCloseAccount(rest, data, id);
  else if (tag === 23n) withdrawInsuranceLimited(rest, data, id);
  else if (tag === 25n) reclaimEmptyAccount(rest, data, id);
  else if (tag === 26n) settleAccount(rest, data, id);
  else if (tag === 27n) depositFeeCredits(rest, data, id);
  else if (tag === 28n) convertReleasedPnl(rest, data, id);
  else if (tag === 29n) resolvePermissionless(rest, id);
  else if (tag === 30n) forceCloseResolved(rest, data, id);
  else if (tag === 31n) catchupAccrueIx(rest, id);
  // decode() has refused every other tag: 32 is left.
  else updateAuthority(rest, data, id);
}
