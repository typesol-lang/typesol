// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// SPL Stake Pool, the program at SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy: a pool of stake accounts delegated to
// many validators, with one pool token for all of them. It is a native program: the entrypoint decodes a Borsh
// StakePoolInstruction (a u8 tag, then the variant's fields, every byte consumed) and the processor takes its
// accounts by position. So the port is one @fallback entry over instructionData() and remainingAccounts(), with the
// original's checks, logs and errors in its order. On an error the entrypoint logs `error.to_str()`: "Error: " and
// the error's text, for StakePoolError and for the built-in ProgramErrors alike (the two prefixes below).
//
// The instructions live by subject: admin.ts (Initialize, the setters, SetPreferredValidator), validators.ts (adding,
// removing and cleaning up validators), update.ts (the per-epoch updates), sol.ts (SOL deposits and withdrawals),
// and the files the later parts fill: rebalance.ts, stake_deposit.ts, stake_withdraw.ts, metadata.ts.
import { ProgramError, instructionData, log, remainingAccounts, require, u64 } from "typesol";
import { addValidatorToPool, cleanupRemovedValidatorEntries, removeValidatorFromPool } from "./validators.js";
import { initialize, setFee, setFundingAuthority, setManager, setPreferredValidator, setStaker } from "./admin.js";
import { updateStakePoolBalance, updateValidatorListBalance } from "./update.js";
import { depositSol, withdrawSol } from "./sol.js";
import { decreaseValidatorStake, increaseValidatorStake } from "./rebalance.js";
import { depositStake } from "./stake_deposit.js";
import { withdrawStake } from "./stake_withdraw.js";
import { createTokenMetadata, updateTokenMetadata } from "./metadata.js";
import { DEFAULT_PUBKEY } from "./util.js";
import { type Fee } from "./state.js";

/** The entrypoint's failure line, `msg!(error.to_str::<StakePoolError>())`: "Error: " and the error's text. */
export const ERROR_LOG_PREFIX = "Error: ";
/** The same line for a built-in ProgramError ("Error: InvalidArgument", …). */
export const PROGRAM_ERROR_LOG_PREFIX = "Error: ";
/** UpdateValidatorListBalance takes any number of validator / transient stake pairs (7 + 2N accounts). */
export const MAX_ACCOUNTS = 255n;
/**
 * Account data written in place, as the original writes it: the validator list (loadRawMut) and the pool (storeBorsh)
 * are not checked writable up front, the runtime judges at the end (a read-only account whose bytes changed fails
 * with ReadonlyDataModified, one written with the bytes it held does not). Where the original's RefCell refuses an
 * account passed again while the list is borrowed, the port makes the same refusal (util.ts, "The list's borrow").
 */
export const NATIVE_ACCOUNT_WRITES = true;

/** @fallback */
export function process(): void {
  const data = instructionData();
  const rest = remainingAccounts();
  // StakePoolInstruction::try_from_slice: a tag the enum has, the variant's fields, nothing after them. Any other
  // bytes are a Borsh error (BorshIoError), before anything is logged.
  const n = data.length;
  require(n >= 1n, ProgramError.BorshIoError);
  const tag = data.readU8(0n);
  if (tag === 0n) {
    // Initialize { fee, withdrawal_fee, deposit_fee: Fee (denominator, numerator), referral_fee: u8, max_validators: u32 }
    require(n === 54n, ProgramError.BorshIoError);
    const epochFee: Fee = { denominator: data.readU64(1n), numerator: data.readU64(9n) };
    const withdrawalFee: Fee = { denominator: data.readU64(17n), numerator: data.readU64(25n) };
    const depositFee: Fee = { denominator: data.readU64(33n), numerator: data.readU64(41n) };
    log("Instruction: Initialize stake pool");
    initialize(rest, epochFee, withdrawalFee, depositFee, data.readU8(49n), data.readU32(50n));
    return;
  }
  if (tag === 1n) {
    // AddValidatorToPool(u32 seed)
    require(n === 5n, ProgramError.BorshIoError);
    log("Instruction: AddValidatorToPool");
    addValidatorToPool(rest, data.readU32(1n));
    return;
  }
  if (tag === 2n) {
    require(n === 1n, ProgramError.BorshIoError);
    log("Instruction: RemoveValidatorFromPool");
    removeValidatorFromPool(rest);
    return;
  }
  if (tag === 3n || tag === 4n || tag === 21n) {
    // DecreaseValidatorStake / IncreaseValidatorStake / DecreaseValidatorStakeWithReserve { lamports, transient_stake_seed }
    require(n === 17n, ProgramError.BorshIoError);
    if (tag === 4n) {
      log("Instruction: IncreaseValidatorStake");
      increaseValidatorStake(rest, data.readU64(1n), data.readU64(9n), false, 0n);
      return;
    }
    if (tag === 3n) {
      log("Instruction: DecreaseValidatorStake");
      log("NOTE: This instruction is deprecated, please use `DecreaseValidatorStakeWithReserve`");
    } else log("Instruction: DecreaseValidatorStakeWithReserve");
    decreaseValidatorStake(rest, data.readU64(1n), data.readU64(9n), false, 0n, tag === 21n);
    return;
  }
  if (tag === 5n) {
    // SetPreferredValidator { validator_type: Deposit | Withdraw, validator_vote_address: Option<Pubkey> }
    require(n >= 3n && data.readU8(1n) <= 1n && data.readU8(2n) <= 1n, ProgramError.BorshIoError);
    const some = data.readU8(2n) === 1n;
    require(n === (some ? 35n : 3n), ProgramError.BorshIoError);
    log("Instruction: SetPreferredValidator");
    setPreferredValidator(rest, data.readU8(1n) === 1n, some, some ? data.readPubkey(3n) : DEFAULT_PUBKEY);
    return;
  }
  if (tag === 6n) {
    // UpdateValidatorListBalance { start_index: u32, no_merge: bool }
    require(n === 6n && data.readU8(5n) <= 1n, ProgramError.BorshIoError);
    log("Instruction: UpdateValidatorListBalance");
    updateValidatorListBalance(rest, u64(data.readU32(1n)), data.readU8(5n) === 1n);
    return;
  }
  if (tag === 7n) {
    require(n === 1n, ProgramError.BorshIoError);
    log("Instruction: UpdateStakePoolBalance");
    updateStakePoolBalance(rest);
    return;
  }
  if (tag === 8n) {
    require(n === 1n, ProgramError.BorshIoError);
    log("Instruction: CleanupRemovedValidatorEntries");
    cleanupRemovedValidatorEntries(rest);
    return;
  }
  if (tag === 9n || tag === 23n) {
    // DepositStake / DepositStakeWithSlippage { minimum_pool_tokens_out }
    require(n === (tag === 9n ? 1n : 9n), ProgramError.BorshIoError);
    log(tag === 9n ? "Instruction: DepositStake" : "Instruction: DepositStakeWithSlippage");
    depositStake(rest, tag === 23n, tag === 23n ? data.readU64(1n) : 0n);
    return;
  }
  if (tag === 10n || tag === 24n) {
    // WithdrawStake(u64) / WithdrawStakeWithSlippage { pool_tokens_in, minimum_lamports_out }
    require(n === (tag === 10n ? 9n : 17n), ProgramError.BorshIoError);
    log(tag === 10n ? "Instruction: WithdrawStake" : "Instruction: WithdrawStakeWithSlippage");
    withdrawStake(rest, data.readU64(1n), tag === 24n, tag === 24n ? data.readU64(9n) : 0n);
    return;
  }
  if (tag === 11n) {
    require(n === 1n, ProgramError.BorshIoError);
    log("Instruction: SetManager");
    setManager(rest);
    return;
  }
  if (tag === 12n) {
    // SetFee { fee: FeeType }: SolReferral(u8) | StakeReferral(u8) | Epoch | StakeWithdrawal | SolDeposit |
    // StakeDeposit | SolWithdrawal (Fee)
    require(n >= 2n && data.readU8(1n) <= 6n, ProgramError.BorshIoError);
    const kind = data.readU8(1n);
    const referral = kind <= 1n;
    require(n === (referral ? 3n : 18n), ProgramError.BorshIoError);
    log("Instruction: SetFee");
    if (referral) setFee(rest, kind, data.readU8(2n), 0n, 0n);
    else setFee(rest, kind, 0n, data.readU64(2n), data.readU64(10n));
    return;
  }
  if (tag === 13n) {
    require(n === 1n, ProgramError.BorshIoError);
    log("Instruction: SetStaker");
    setStaker(rest);
    return;
  }
  if (tag === 14n || tag === 25n) {
    // DepositSol(u64) / DepositSolWithSlippage { lamports_in, minimum_pool_tokens_out }
    require(n === (tag === 14n ? 9n : 17n), ProgramError.BorshIoError);
    log(tag === 14n ? "Instruction: DepositSol" : "Instruction: DepositSolWithSlippage");
    depositSol(rest, data.readU64(1n), tag === 25n, tag === 25n ? data.readU64(9n) : 0n);
    return;
  }
  if (tag === 15n) {
    // SetFundingAuthority(StakeDeposit | SolDeposit | SolWithdraw)
    require(n === 2n && data.readU8(1n) <= 2n, ProgramError.BorshIoError);
    log("Instruction: SetFundingAuthority");
    setFundingAuthority(rest, data.readU8(1n));
    return;
  }
  if (tag === 16n || tag === 26n) {
    // WithdrawSol(u64) / WithdrawSolWithSlippage { pool_tokens_in, minimum_lamports_out }
    require(n === (tag === 16n ? 9n : 17n), ProgramError.BorshIoError);
    log(tag === 16n ? "Instruction: WithdrawSol" : "Instruction: WithdrawSolWithSlippage");
    withdrawSol(rest, data.readU64(1n), tag === 26n, tag === 26n ? data.readU64(9n) : 0n);
    return;
  }
  if (tag === 17n || tag === 18n) {
    // CreateTokenMetadata / UpdateTokenMetadata { name, symbol, uri }: Borsh Strings, decoded (and the line logged)
    // with the checks in metadata.ts, which then invokes Metaplex.
    if (tag === 17n) createTokenMetadata(rest);
    else updateTokenMetadata(rest);
    return;
  }
  if (tag === 19n || tag === 20n) {
    // IncreaseAdditionalValidatorStake / DecreaseAdditionalValidatorStake { lamports, transient_stake_seed, ephemeral_stake_seed }
    require(n === 25n, ProgramError.BorshIoError);
    if (tag === 19n) {
      log("Instruction: IncreaseAdditionalValidatorStake");
      increaseValidatorStake(rest, data.readU64(1n), data.readU64(9n), true, data.readU64(17n));
      return;
    }
    log("Instruction: DecreaseAdditionalValidatorStake");
    decreaseValidatorStake(rest, data.readU64(1n), data.readU64(9n), true, data.readU64(17n), true);
    return;
  }
  if (tag === 22n) {
    // Redelegate { lamports, source_transient_stake_seed, ephemeral_stake_seed, destination_transient_stake_seed }:
    // decoded, then refused (deprecated since 2.0.0: the Stake program's Redelegate will not be enabled).
    require(n === 33n, ProgramError.BorshIoError);
    log("Instruction: Redelegate will not be enabled");
    require(false, ProgramError.InvalidInstructionData);
  }
  // No such variant ("Unexpected variant tag").
  require(false, ProgramError.BorshIoError);
}
