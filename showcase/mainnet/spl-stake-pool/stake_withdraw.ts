// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// Withdrawing a stake account from the pool (processor.rs process_withdraw_stake): WithdrawStake (10) and
// WithdrawStakeWithSlippage (24). NOT PORTED YET: panics until a later part ports it.
import { type RemainingAccounts, type u64, panic } from "typesol";

/** process_withdraw_stake(pool_tokens, minimum_lamports_out): `slippage` is whether the minimum is given. */
export function withdrawStake(rest: RemainingAccounts, poolTokens: u64, slippage: boolean, minimumLamportsOut: u64): void {
  panic("not ported yet");
}
