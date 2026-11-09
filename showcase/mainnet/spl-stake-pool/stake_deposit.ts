// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// Depositing a stake account into the pool (processor.rs process_deposit_stake): DepositStake (9) and
// DepositStakeWithSlippage (23). NOT PORTED YET: panics until a later part ports it.
import { type RemainingAccounts, type u64, panic } from "typesol";

/** process_deposit_stake(minimum_pool_tokens_out): `slippage` is whether the minimum is given. */
export function depositStake(rest: RemainingAccounts, slippage: boolean, minimumPoolTokensOut: u64): void {
  panic("not ported yet");
}
