# SPL Stake Pool: the original's integration tests, mapped

Every test function of the original's own integration tests (solana-program/stake-pool `program@v2.1.0`,
`program/tests/*.rs`, 28 files and their helpers) is mapped below to a differential case of the TypeSOL port's tests:
the original (`test/programs/spl_stake_pool.so`, as deployed on mainnet) and the port run side by side, and each case
must have the same outcome, log lines and account bytes in both (`both()` in `spl-stake-pool-helpers.ts`).

- **covered**: a case of the earlier files runs the same instruction path under the same condition (the label in
  quotes is the `both()` label, the file is `spl-stake-pool.test.ts` unless named).
- **added**: no earlier case did; `spl-stake-pool-upstream.test.ts` runs it, in a `describe` named after the file and
  an `it` named after the test (`[variant]` for a `test_case`), with the outcome the upstream test expects.

| | Test functions |
| --- | --- |
| covered | 143 |
| added | 78 (the whole of force_destake.rs and huge_pool.rs among them) |
| not applicable | 0 |

None is left out. Five upstream tests have empty bodies (`{}`, some marked `// TODO`); they are mapped by their names:
two to the force_destake.rs cases that do what they name, one to an earlier case, and two (`..._with_uninitialized_validator_list`
in update_validator_list_balance.rs and update_stake_pool_balance.rs) added from their names.

## Adaptations

Where program-test does what LiteSVM does not, the scenario is adapted, not dropped:

- **Epochs.** `warp_to_slot` is `d.nextEpoch()`: a `StakeCluster` (docs/test-your-program.md, "Epochs and staking")
  ends the epoch with its StakeHistory entry, so warmup and cooldown are a cluster's. Upstream's setups start at epoch
  14 or 15 and warp to the next; here they start at epoch 0 and move the same number of epochs.
- **Validator rewards.** Upstream credits the vote accounts (`increment_vote_account_credits`) and warps, and the
  runtime pays inflation rewards into the delegated stake. Here, right after the epoch boundary, each active
  validator stake account's delegation grows with its lamports, as the Stake program's reward payout grows them.
  Extra lamports (tips, upstream's `transfer`s into a stake account or the reserve) are sent as upstream sends them.
- **Accounts written by hand.** `program_test.add_account` and `context.set_account` become the same bytes written
  into both VMs (`d.write`, `d.patch`); upstream's huge pools and force-destaked validators are written into an
  initialized pool (its list entries, lamports and supply, the mint's supply and the manager's tokens), so the pool,
  list and mint accounts are the ones Initialize made in both programs.
- **The minimum delegation.** Upstream's `program_test()` turns off the 1 SOL minimum delegation (1,000,000 lamports
  then); LiteSVM's Stake program has it, so amounts given as multiples of the minimum are multiples of 1 SOL.
- **Huge pools.** The list holds upstream's 3,000 or 20,000 entries at full size (BigVec, written into the list
  account). Upstream also writes every validator stake account and vote account; only the ones an instruction names
  are written here (no instruction reads the others). Their stake activates in the current epoch, as upstream's do.
  The 20,000-entry cases ask for 1,400,000 compute units (appended after the pool's instruction, so its errors stay at
  index 0); the 3,000-entry ones, and the 6,800 and 19,000 regression cases, ask for nothing (the default 200,000).

## Compute units at the limits

| Huge pool | Original | TypeSOL | |
| --- | ---: | ---: | ---: |
| 20,000: UpdateValidatorListBalance (4) | 28,205 | 8,398 | 30% |
| 20,000: UpdateStakePoolBalance | 547,385 | 321,992 | 59% |
| 20,000: CleanupRemovedValidatorEntries | 184,870 | 101,019 | 55% |
| 20,000: DepositStake (last validator) | 611,313 | 153,010 | 25% |
| 20,000: WithdrawStake (last validator) | 788,346 | 311,709 | 40% |
| 3,000: UpdateValidatorListBalance (4) | 34,055 | 9,652 | 28% |
| 3,000: UpdateStakePoolBalance | 88,235 | 49,842 | 56% |
| 3,000: CleanupRemovedValidatorEntries | 31,720 | 15,869 | 50% |
| 3,000: DepositStake | 147,665 | 66,869 | 45% |
| 3,000: WithdrawStake | 171,699 | 89,567 | 52% |
| 3,000: RemoveValidatorFromPool (first / middle / last) | 20,883 / 61,383 / 103,356 | 14,796 / 22,296 / 30,122 | 71% / 36% / 29% |
| 3,000: AddValidatorToPool (last entry) | 122,092 | 46,517 | 38% |
| 3,000: IncreaseValidatorStake (last) | 126,061 | 48,786 | 39% |
| 3,000: SetPreferredValidator (last) | 84,818 | 16,594 | 20% |
| 3,000: CleanupRemovedValidatorEntries (all removed) | 43,720 | 21,869 | 50% |
| 3,550: WithdrawStake (regression: the port's must fit 200,000) | 191,649 | 96,867 | 51% |
| 6,800: UpdateStakePoolBalance (regression: no compute-unit request) | 190,835 | 110,642 | 58% |
| 19,000: CleanupRemovedValidatorEntries (regression: no compute-unit request) | 175,720 | 95,869 | 55% |

(The UpdateValidatorListBalance, AddValidatorToPool and DepositStake / WithdrawStake rows vary by a few thousand units
from run to run: the vote accounts are new keys each run, and so are the bump searches of their stake addresses.)

The instructions that go through the whole list without doing anything else per entry (UpdateStakePoolBalance's sum,
CleanupRemovedValidatorEntries' retain) cost the port 16 and 5 units an entry, against the original's 27 and 9. They
once cost it 31 and 11, more than the original's: with no compute-unit request (200,000 units) the port then ran out
where the original did not, from about 6,400 validators for UpdateStakePoolBalance and about 18,100 for the cleanup.
That was the compiler's BigVec loops, not the port's logic. A loop inside a large function shares SBF's registers with
everything the function holds across it, so clang spilled the sum's pointer, epoch and total (a reload and a store an
entry); the compiler now gives a loop over a BigVec (`for … of`, the list methods, a slice) a C function of its own.
`retain` walks the elements with one pointer (5 instructions a kept element), and the sum writes each check as
`b <= U64_MAX - a` before `a + b`, the addition's own overflow check, which clang then drops. The regression cases run
both instructions at 6,800 and 19,000 validators with no compute-unit request and require both programs to succeed
(the original fits to about 7,100 and 20,000).

WithdrawStake was another, in the port's own logic: it looked for validators with stake to give in one pass that only
stopped once it had found both active and transient stake, the original in two searches that each stop at the first.
At 3,550 validators the original's withdrawal takes about 191,000 units and the port's ran out of the 200,000. The
port now searches as the original does (`stake_withdraw.ts`). The regression case withdraws at 3,550 validators with
the 1,400,000 units (so that neither program's outcome hangs on how many units the bump searches of new keys take,
which moves them by a few thousand) and requires the port's to fit in 200,000.

## initialize.rs

| Upstream test | Here |
| --- | --- |
| success [token, token-2022] | covered: "initialize", "initialize token-2022" |
| fail_double_initialize | covered: "initialize: pool in use" |
| fail_with_already_initialized_validator_list | added |
| fail_with_high_fee | covered: "initialize: epoch fee over 1" |
| fail_with_high_withdrawal_fee | covered: "initialize: withdrawal fee over 1" |
| fail_with_wrong_max_validators | covered: "initialize: max validators mismatch" |
| fail_with_wrong_mint_authority (a fee account not of the pool mint) | covered: "initialize: fee account of another mint" |
| fail_with_freeze_authority | covered: "initialize: mint with freeze authority" |
| success_with_supported_extensions | added (a fee account with TransferFeeAmount and CpiGuard; the TransferFeeConfig mint is also "initialize token-2022 transfer fee") |
| fail_with_unsupported_mint_extension (NonTransferable) | added |
| fail_with_unsupported_account_extension (MemoTransfer) | added |
| fail_with_wrong_token_program_id | covered: "initialize: not a token program" |
| fail_with_fee_owned_by_wrong_token_program_id | covered: "initialize: not a token program" (the token program is checked before the fee account) |
| fail_with_wrong_fee_account (an empty account of another program) | added |
| fail_with_wrong_withdraw_authority | covered: "initialize: wrong withdraw authority" |
| fail_with_not_rent_exempt_pool | covered: "initialize: pool not rent-exempt" |
| fail_with_not_rent_exempt_validator_list | covered: "initialize: list not rent-exempt" |
| fail_without_manager_signature | covered: "initialize: manager not signing" |
| fail_with_pre_minted_pool_tokens | covered: "initialize: mint with supply" |
| fail_with_bad_reserve (staker, withdrawer, custodian, uninitialized) | covered: "initialize: reserve of another staker", "… of another withdrawer", "… reserve uninitialized"; added: the lockup custodian |
| success_with_extra_reserve_lamports | covered: "initialize" (a reserve of 7 SOL, the fee account gets 7 SOL of tokens) |
| fail_with_incorrect_mint_decimals | covered: "initialize: mint with 6 decimals" |
| fail_with_too_many_validators | covered: "initialize: over 20000 validators" |

## vsa_add.rs, vsa_remove.rs

| Upstream test | Here |
| --- | --- |
| vsa_add::success | covered: "add validator" |
| vsa_add::fail_with_wrong_validator_list_account | covered: "add validator: wrong list" |
| vsa_add::fail_double_add | covered: "add validator: again" |
| vsa_add::fail_wrong_staker | covered: "add validator: wrong staker" |
| vsa_add::fail_without_signature | covered: "add validator: staker not signing" |
| vsa_add::fail_with_wrong_stake_program_id | covered: "add validator: wrong stake program" |
| vsa_add::fail_with_wrong_system_program_id | covered: "add validator: wrong system program" |
| vsa_add::fail_add_too_many_validator_stake_accounts | covered: "add validator: list full" |
| vsa_add::fail_with_not_updated_stake_pool | covered: "add validator: stale pool" |
| vsa_add::fail_with_uninitialized_validator_list_account | added |
| vsa_add::fail_on_non_vote_account | added (no account at the vote address; "add validator: not a vote account" passes the mint) |
| vsa_add::fail_on_incorrectly_derived_stake_account | covered: "add validator: wrong stake address" |
| vsa_add::success_with_lamports_in_account | added |
| vsa_add::fail_with_not_enough_reserve_lamports | covered: "add validator: reserve too small" |
| vsa_add::fail_with_wrong_reserve | covered: "add validator: wrong reserve" |
| vsa_add::fail_with_draining_reserve | added |
| vsa_remove::success | covered: "validators over epochs › removes validators through deactivation, and cleans up" |
| vsa_remove::fail_with_wrong_stake_program_id | covered: "remove validator: wrong stake program" |
| vsa_remove::fail_with_wrong_validator_list_account | covered: "remove validator: wrong list" |
| vsa_remove::success_at_large_value | added |
| vsa_remove::fail_double_remove (after the merge and cleanup) | added ("remove validator: again" is before the merge) |
| vsa_remove::fail_wrong_staker | covered: "remove validator: wrong staker" |
| vsa_remove::fail_no_signature | added |
| vsa_remove::success_with_activating_transient_stake | added |
| vsa_remove::success_with_deactivating_transient_stake | added |
| vsa_remove::success_resets_preferred_validator | covered: "remove validator: preferred", "remove validator: withdraw preferred" |
| vsa_remove::fail_cannot_hijack_transient_account | added |
| vsa_remove::fail_not_updated_stake_pool | covered: "remove validator: stale pool" |
| vsa_remove::fail_with_uninitialized_validator_list_account | added |
| vsa_remove::update_no_merge_after_removal | added |
| vsa_remove::success_remove_validator_with_transient_stake_triggers_deactivating_all | added (with success_with_activating_transient_stake; an active transient stake is "remove validator with transient stake") |

## set_manager.rs, set_staker.rs, set_preferred.rs, preferred_validators.rs

| Upstream test | Here |
| --- | --- |
| set_manager::test_set_manager | covered: "set manager" |
| set_manager::test_set_manager_by_malicious | covered: "set manager: wrong manager" |
| set_manager::test_set_manager_without_existing_signature | covered: "set manager: manager not signing" |
| set_manager::test_set_manager_without_new_signature | covered: "set manager: new manager not signing" |
| set_manager::test_set_manager_with_wrong_mint_for_pool_fee_acc | covered: "set manager: fee account of another mint" |
| set_staker::success_set_staker_as_manager | covered: "set staker by manager" |
| set_staker::success_set_staker_as_staker | covered: "set staker by staker" |
| set_staker::fail_wrong_manager (neither manager nor staker) | covered: "set staker by old staker" |
| set_staker::fail_set_staker_without_signature | covered: "set staker unsigned" |
| set_preferred::success_deposit | covered: "set preferred: deposit" |
| set_preferred::success_withdraw | covered: "set preferred: withdraw" |
| set_preferred::success_unset | covered: "clear preferred withdraw (withdrawals)" (spl-stake-pool-stake.test.ts), "set preferred: clear deposit" |
| set_preferred::fail_wrong_staker | covered: "set preferred: wrong staker" |
| set_preferred::fail_not_present_validator | covered: "set preferred: not in the pool" |
| set_preferred::fail_ready_for_removal | covered: "set preferred: removed validator" |
| preferred_validators::test_preferred_validator_removal | covered: "withdraw stake (whole validator)" (spl-stake-pool-stake.test.ts, the validator preferred for both) |
| preferred_validators::test_preferred_validator_reset_on_cleanup | covered: "cleanup resets preferred" |
| preferred_validators::test_preferred_validator_reset_on_cleanup_inactive_validator | added |

## set_deposit_fee.rs, set_epoch_fee.rs, set_funding_authority.rs, set_referral_fee.rs, set_withdrawal_fee.rs

The manager check of SetFee runs before the fee type is looked at, so one wrong-manager case covers every fee type.

| Upstream test | Here |
| --- | --- |
| set_deposit_fee::success_stake | covered: "set fee: stake deposit" |
| set_deposit_fee::success_stake_increase_fee_from_0 | added |
| set_deposit_fee::fail_stake_wrong_manager | covered: "set fee: wrong manager" |
| set_deposit_fee::fail_stake_high_deposit_fee | covered: "set fee: StakeDeposit over 100%" |
| set_deposit_fee::success_sol | covered: "set fee: sol deposit" |
| set_deposit_fee::fail_sol_wrong_manager | covered: "set fee: wrong manager" |
| set_deposit_fee::fail_sol_high_deposit_fee | covered: "set fee: SolDeposit over 100%" |
| set_epoch_fee::success (100%, two epochs later) | added |
| set_epoch_fee::fail_wrong_manager | covered: "set fee: wrong manager" |
| set_epoch_fee::fail_high_fee | covered: "set fee: Epoch over 100%" |
| set_epoch_fee::fail_not_updated | covered: "set fee: epoch fee on a stale pool 0" |
| set_funding_authority::success_set_stake_deposit_authority | covered: "set funding StakeDeposit", "unset funding StakeDeposit" |
| set_funding_authority::fail_wrong_manager | covered: "set funding: wrong manager" |
| set_funding_authority::fail_without_signature | added |
| set_funding_authority::success_set_sol_deposit_authority | covered: "set funding SolDeposit", "unset funding SolDeposit" |
| set_funding_authority::success_set_withdraw_authority | covered: "set funding SolWithdraw", "unset funding SolWithdraw" |
| set_referral_fee::success_stake | covered: "set fee: stake referral" |
| set_referral_fee::success_stake_increase_fee_from_0 | added |
| set_referral_fee::fail_stake_wrong_manager | covered: "set fee: wrong manager" |
| set_referral_fee::fail_stake_high_referral_fee | covered: "set fee: stake referral over 100" |
| set_referral_fee::success_sol | covered: "set fee: sol referral" |
| set_referral_fee::fail_sol_wrong_manager | covered: "set fee: wrong manager" |
| set_referral_fee::fail_sol_high_referral_fee | covered: "set fee: sol referral over 100" |
| set_withdrawal_fee::success (two epochs later) | covered: "set fee: stake withdrawal from none", "set fee: sol withdrawal from none", the two "update pool (settings …)" |
| set_withdrawal_fee::success_fee_cannot_increase_more_than_once | added |
| set_withdrawal_fee::success_reset_fee_after_one_epoch | added |
| set_withdrawal_fee::success_increase_fee_from_0 | covered: "set fee: stake withdrawal from none" |
| set_withdrawal_fee::fail_wrong_manager | covered: "set fee: wrong manager" |
| set_withdrawal_fee::fail_high_withdrawal_fee | covered: "set fee: StakeWithdrawal over 100%" |
| set_withdrawal_fee::fail_high_stake_fee_increase | covered: "set fee: stake withdrawal over 1.5x" |
| set_withdrawal_fee::fail_high_sol_fee_increase | added |
| set_withdrawal_fee::fail_high_stake_fee_increase_from_0 | added |
| set_withdrawal_fee::fail_high_sol_fee_increase_from_0 | covered: "set fee: sol withdrawal too fast from none" |
| set_withdrawal_fee::fail_not_updated | added |

## create_pool_token_metadata.rs, update_pool_token_metadata.rs (spl-stake-pool-metadata.test.ts)

| Upstream test | Here |
| --- | --- |
| create::success [token] (token-2022 commented out upstream) | covered: "create metadata"; the Token-2022 mint also: "create metadata (Token-2022)" |
| create::fail_manager_did_not_sign | covered: "create: manager not signing" |
| create::fail_wrong_manager_signed | covered: "create: wrong manager" |
| create::fail_wrong_mpl_metadata_program | covered: "create: wrong metadata program" (checked before the manager) |
| create::fail_create_metadata_twice | covered: "create metadata again" |
| update::success_update_pool_token_metadata | covered: "update metadata" |
| update::fail_manager_did_not_sign | covered: "update: manager not signing" |
| update::fail_wrong_manager_signed | covered: "update: wrong manager" |

## deposit.rs, deposit_sol.rs, deposit_authority.rs, deposit_edge_cases.rs

| Upstream test | Here |
| --- | --- |
| deposit::success [token, token-2022] | covered: "deposit stake" (spl-stake-pool-stake.test.ts), "deposit stake (Token-2022)" |
| deposit::success_with_extra_stake_lamports | covered: "deposit stake with extra lamports" |
| deposit::fail_with_wrong_stake_program_id | covered: "deposit stake: wrong stake program" |
| deposit::fail_with_wrong_token_program_id | covered: "deposit stake: wrong token program" |
| deposit::fail_with_wrong_validator_list_account | covered: "deposit stake: wrong list" |
| deposit::fail_with_unknown_validator | covered: "deposit stake: validator not in the pool" |
| deposit::fail_with_wrong_withdraw_authority | covered: "deposit stake: wrong withdraw authority" |
| deposit::fail_with_wrong_mint_for_receiver_acc | covered: "deposit stake: tokens to another mint's account" |
| deposit::success_with_slippage [token, token-2022] (exactly the amount, and one more) | added |
| deposit_sol::success [token, token-2022] | covered: "deposit sol (SPL Token)", "deposit sol (Token-2022)" |
| deposit_sol::fail_with_wrong_token_program_id | covered: "deposit sol: wrong token program" |
| deposit_sol::fail_with_wrong_withdraw_authority | covered: "deposit sol: wrong withdraw authority" |
| deposit_sol::fail_with_wrong_mint_for_receiver_acc | added |
| deposit_sol::success_with_sol_deposit_authority | covered: "deposit sol with authority" |
| deposit_sol::fail_without_sol_deposit_authority_signature | covered: "deposit sol: wrong authority" |
| deposit_sol::success_with_referral_fee | covered: "deposit sol (SPL Token)" (a referrer's account, 30%) |
| deposit_sol::fail_with_invalid_referrer | added |
| deposit_sol::success_with_slippage [token, token-2022] | covered: "deposit sol slippage (SPL Token)", "… (Token-2022)", "deposit sol slippage exceeded …" |
| deposit_authority::success_initialize | covered: "initialize with deposit authority, empty reserve" |
| deposit_authority::success_deposit (activating stake) | added |
| deposit_authority::fail_deposit_without_authority_signature (another key signing) | added (with success_deposit) |
| deposit_edge_cases::success_with_preferred_deposit | covered: "deposit stake: preferred validator" |
| deposit_edge_cases::fail_with_wrong_preferred_deposit | covered: "deposit stake: not the preferred validator" |
| deposit_edge_cases::success_with_referral_fee | covered: "deposit stake" (a referrer's account, 30%) |
| deposit_edge_cases::fail_with_invalid_referrer | added |

## withdraw.rs, withdraw_sol.rs, withdraw_with_fee.rs, withdraw_edge_cases.rs

| Upstream test | Here |
| --- | --- |
| withdraw::success [token, token-2022] | covered: "withdraw stake" (spl-stake-pool-stake.test.ts), "withdraw stake (Token-2022)" |
| withdraw::success_with_closed_manager_fee_account | added ("withdraw stake: frozen fee account" freezes it, a different path) |
| withdraw::fail_with_wrong_stake_program | covered: "withdraw stake: wrong stake program" |
| withdraw::fail_with_wrong_withdraw_authority | covered: "withdraw stake: wrong withdraw authority" |
| withdraw::fail_with_wrong_token_program_id | covered: "withdraw stake: wrong token program" |
| withdraw::fail_with_wrong_validator_list | covered: "withdraw stake: wrong list" |
| withdraw::fail_with_unknown_validator | covered: "withdraw stake: validator not in the pool" |
| withdraw::fail_double_withdraw_to_the_same_account | covered: "withdraw stake: split into an existing stake account" |
| withdraw::fail_without_token_approval | covered: "withdraw stake: another user's tokens"; added: "withdraw stake: approval revoked" |
| withdraw::fail_with_not_enough_tokens (empty validator, revoked, approved for 1) | covered: "withdraw stake: from a validator at the minimum"; added: the revoked and short approvals |
| withdraw::success_with_slippage [token, token-2022] | covered: "withdraw stake slippage", "withdraw stake slippage (Token-2022)", "withdraw stake: slippage exceeded" |
| withdraw_sol::success [token, token-2022] | covered: "withdraw sol (SPL Token)", "withdraw sol (Token-2022)" |
| withdraw_sol::fail_with_wrong_withdraw_authority | covered: "withdraw sol: wrong withdraw authority" |
| withdraw_sol::fail_overdraw_reserve | covered: "withdraw sol: more than the reserve" |
| withdraw_sol::success_with_sol_withdraw_authority | covered: "withdraw sol with authority" |
| withdraw_sol::fail_without_sol_withdraw_authority_signature | covered: "withdraw sol: wrong authority" |
| withdraw_sol::success_with_slippage [token, token-2022] | covered: "withdraw sol slippage (SPL Token)", "… (Token-2022)", "withdraw sol slippage exceeded …" |
| withdraw_with_fee::success_withdraw_all_fee_tokens | added |
| withdraw_with_fee::success_empty_out_stake_with_fee | added |
| withdraw_edge_cases::fail_remove_validator_blocked_by_transient_stake | added |
| withdraw_edge_cases::fail_remove_validator | added |
| withdraw_edge_cases::success_remove_validator [0, 5, 11, 29] | added |
| withdraw_edge_cases::fail_with_reserve | covered: "withdraw stake: from the reserve" |
| withdraw_edge_cases::fail_with_transient | added |
| withdraw_edge_cases::success_with_reserve | covered: "withdraw stake (reserve)" |
| withdraw_edge_cases::success_with_empty_preferred_withdraw | covered: "withdraw stake: preferred validator at the minimum" |
| withdraw_edge_cases::success_and_fail_with_preferred_withdraw | covered: "withdraw stake: not the preferred validator", "withdraw stake: the preferred validator" |
| withdraw_edge_cases::fail_withdraw_from_transient | added |
| withdraw_edge_cases::success_withdraw_from_transient | covered: "withdraw stake (transient)" |
| withdraw_edge_cases::success_with_small_preferred_withdraw | added |
| withdraw_edge_cases::fail_overdraw_reserve | covered: "withdraw stake: more than the reserve holds" |
| withdraw_edge_cases::success_remove_preferred_validator_resets_preference | covered: "withdraw stake (whole validator)" (the validator preferred for both) |

## increase.rs, decrease.rs (spl-stake-pool-rebalance.test.ts)

| Upstream test | Here |
| --- | --- |
| increase::success [additional, non-additional] | covered: "increase", "increase additional (split)" |
| increase::fail_with_wrong_withdraw_authority | covered: "increase: wrong withdraw authority" |
| increase::fail_with_wrong_validator_list | covered: "increase: wrong list" |
| increase::fail_with_unknown_validator | covered: "increase: vote not in the pool" |
| increase::fail_twice_diff_seed [additional, non-additional] | covered: "increase additional: wrong seed"; added: non-additional |
| increase::twice [success-all-additional, success-with-additional, fail-without-additional, fail-no-additional] | covered: "increase additional (merge)", "increase: transient in use"; added: all-additional, without-additional |
| increase::fail_with_small_lamport_amount [additional, non-additional] | covered: "increase: below the minimum delegation"; added: additional |
| increase::fail_overdraw_reserve [additional, non-additional] | covered: "increase: more than the reserve has"; added: additional |
| increase::fail_additional_with_decreasing | covered: "increase additional: transient deactivating" |
| increase::fail_with_force_destaked_validator (empty upstream) | covered by force_destake::fail_increase (added) |
| decrease::success [Additional, Reserve, Deprecated] | covered: "decrease additional (split)", "decrease with reserve", "decrease (deprecated)" |
| decrease::fail_with_wrong_withdraw_authority | covered: "decrease: wrong withdraw authority" |
| decrease::fail_with_wrong_validator_list | covered: "decrease: wrong list" |
| decrease::fail_with_unknown_validator | covered: "decrease: delegated to a validator not in the pool" |
| decrease::fail_twice_diff_seed [Additional, Reserve, Deprecated] | covered: "decrease additional: wrong seed"; added: Reserve, Deprecated |
| decrease::twice [success-all-additional, success-with-additional, fail-without-additional, fail-no-additional] | covered: "decrease additional (merge)", "decrease with reserve: transient in use"; added: all-additional, without-additional |
| decrease::fail_with_small_lamport_amount [Additional, Reserve, Deprecated] | covered: "decrease: below the minimum delegation"; added: Additional, Deprecated |
| decrease::fail_big_overdraw [Additional, Reserve, Deprecated] | covered: "decrease: more than the validator stake holds"; added: Additional, Deprecated |
| decrease::fail_overdraw [Additional, Reserve, Deprecated] | covered: "decrease: more than the validator stake holds"; added: Additional, Deprecated |
| decrease::fail_additional_with_increasing | covered: "decrease additional: transient activating" |
| decrease::fail_validator_marked_for_removal_decrease_stake [Additional, Reserve, Deprecated] | covered: "decrease: validator removed"; added: Additional, Deprecated |

## update_validator_list_balance.rs, update_stake_pool_balance.rs

| Upstream test | Here |
| --- | --- |
| uvlb::success_with_normal (validator rewards) | added |
| uvlb::merge_into_reserve | covered: "update list (after decrease)" (spl-stake-pool-rebalance.test.ts) |
| uvlb::merge_into_validator_stake | covered: "update list (after increase)" (spl-stake-pool-rebalance.test.ts) |
| uvlb::merge_transient_stake_after_remove | added |
| uvlb::success_with_burned_tokens | added |
| uvlb::fail_with_no_merge_during_reward_payout | added ("update list: rewards distributed" merges) |
| uvlb::fail_with_uninitialized_validator_list (empty upstream) | added from its name |
| uvlb::success_with_force_destaked_validator (empty upstream) | covered by force_destake::success_update (added) |
| uvlb::updates_validator_status_after_cluster_restart_merge | added |
| uvlb::ignores_unusable_stake_accounts_preventing_exploit | added |
| uvlb::update_validator_list_balance_ingores_uninitialized_stake_account_balances | added |
| uvlb::cleanup_does_not_remove_validators_with_remaining_lamports | added |
| usp::success (the epoch fee on rewards) | covered: "update pool (rewards)"; with grown delegations: uvlb::success_with_normal (added) |
| usp::success_absorbing_extra_lamports | covered: "update list (rewards)", "update pool (rewards)" (lamports sent to a validator stake account) |
| usp::fail_with_wrong_validator_list | covered: "update pool: wrong list" |
| usp::fail_with_wrong_pool_fee_account | covered: "update pool: wrong fee account" |
| usp::fail_with_wrong_reserve | added |
| usp::test_update_stake_pool_balance_with_uninitialized_validator_list (empty upstream) | added from its name |
| usp::test_update_stake_pool_balance_with_out_of_dated_validators_balances (empty upstream) | covered: "update pool before the list", "update pool after half" |

## force_destake.rs, huge_pool.rs

| Upstream test | Here |
| --- | --- |
| force_destake::success_update | added |
| force_destake::fail_increase | added |
| force_destake::success_remove_validator | added |
| huge_pool::update [20,000 with 1.4M CU, 3,000] | added (and 6,800 / 19,000 with no CU request, the regressions above) |
| huge_pool::remove_validator_from_pool [3,000] | added |
| huge_pool::add_validator_to_pool [3,000] | added |
| huge_pool::set_preferred [3,000] | added |
| huge_pool::deposit_stake [20,000 with 1.4M CU, 3,000] | added |
| huge_pool::withdraw [20,000 with 1.4M CU, 3,000] | added (and 3,550, the regression above) |
| huge_pool::cleanup_all [3,000] | added |
