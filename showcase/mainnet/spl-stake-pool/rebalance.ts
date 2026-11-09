// A port of SPL Stake Pool (solana-program/stake-pool, program/src, tag program@v2.1.0, 54cdced), Copyright Anza
// Maintainers, licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes:
// rewritten in TypeSOL.
//
// Moving stake between the reserve and the validators (processor.rs process_increase_validator_stake,
// process_decrease_validator_stake): IncreaseValidatorStake (4), IncreaseAdditionalValidatorStake (19),
// DecreaseValidatorStake (3), DecreaseValidatorStakeWithReserve (21), DecreaseAdditionalValidatorStake (20).
// NOT PORTED YET: these panic until a later part ports them.
import { type RemainingAccounts, type u64, panic } from "typesol";

/**
 * process_increase_validator_stake(lamports, transient_stake_seed, maybe_ephemeral_stake_seed): `ephemeral` is
 * whether the ephemeral seed is given (IncreaseAdditionalValidatorStake).
 */
export function increaseValidatorStake(rest: RemainingAccounts, lamports: u64, transientSeed: u64, ephemeral: boolean, ephemeralSeed: u64): void {
  panic("not ported yet");
}

/**
 * process_decrease_validator_stake(lamports, transient_stake_seed, maybe_ephemeral_stake_seed,
 * fund_rent_exempt_reserve): `fundRentFromReserve` is false only for the deprecated DecreaseValidatorStake.
 */
export function decreaseValidatorStake(
  rest: RemainingAccounts,
  lamports: u64,
  transientSeed: u64,
  ephemeral: boolean,
  ephemeralSeed: u64,
  fundRentFromReserve: boolean,
): void {
  panic("not ported yet");
}
