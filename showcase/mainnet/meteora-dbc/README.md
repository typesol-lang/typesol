# Meteora Dynamic Bonding Curve, ported to TypeSOL

Required Notice: All underlying software code is subject to the licence set out at https://github.com/MeteoraAg/dynamic-bonding-curve

This directory is a derivative of Meteora's Dynamic Bonding Curve (https://github.com/MeteoraAg/dynamic-bonding-curve)
at commit 91e696e (release 0.2.2, `programs/dynamic-bonding-curve`), rewritten in TypeSOL. It is **not** under this
repository's MIT licence: it is subject to Meteora's Non-commercial Licence, a verbatim copy of which is in
[LICENSE.md](LICENSE.md). Every source file here says so in its first line. The tests that run it
(`showcase/test/meteora-dbc*.ts`) are under the same terms. Nothing in this directory is part of the published
`@typesol/cli` package.

## What is here

31 of the program's 35 instructions:

| File | Ports |
| --- | --- |
| `meteora_dbc.ts` | the instructions. Stage 1: `create_operator_account`, `close_operator_account`, `close_claim_protocol_fee_operator`, `create_token_badge`, `close_token_badge`, `create_partner_metadata`, `create_config`, `create_config2`, `create_config_with_transfer_hook`. Stage 2 so far: `swap`, `swap2` (ExactIn, PartialFill, ExactOut), `claim_trading_fee`, `claim_creator_trading_fee`, `claim_partner_pool_creation_fee`, `claim_protocol_pool_creation_fee`, `claim_protocol_fee2`, `transfer_pool_creator`, `create_virtual_pool_metadata`, `initialize_virtual_pool_with_spl_token` (with its Metaplex metadata CPIs), `initialize_virtual_pool_with_token2022`, `initialize_virtual_pool_with_token2022_transfer_hook`, `swap2_with_transfer_hook`, `claim_trading_fee2`, `claim_creator_trading_fee2`. Stage 3: `partner_withdraw_surplus`, `creator_withdraw_surplus`, `withdraw_migration_fee`, `withdraw_leftover`, `create_locker` (the locker's `create_vesting_escrow_v2` by CPI), `migration_damm_v2_create_metadata` (deprecated, does nothing), `migration_damm_v2` (DAMM v2's `initialize_pool` or `initialize_pool_with_dynamic_config`, `create_position`, `add_liquidity` or `split_position2`, `permanent_lock_position`, `lock_inner_position`, the position NFTs' owners, the base mint's transfer fee authority, the burn, all under flash rent) |
| `errors.ts` | `error.rs`: all 87 errors, codes and messages |
| `state.ts` | the accounts (`PoolConfig`, `ConfigWithTransferHook`, `VirtualPool`, `TransferHookPool`, `Operator`, `TokenBadge`, `ClaimFeeOperator`, `PartnerMetadata`, `VirtualPoolMetadata`, the DAMM migration metadata) and the argument types |
| `events.ts` | `event.rs`: all 29 events |
| `math.ts`, `curve.ts` | `math/` and `curve.rs` |
| `fees.ts` | the fee scheduler, the rate limiter, fee parameters, dynamic fee, fee splits and the DAMM v2 validation helpers |
| `swap.ts` | the swap math of `state/virtual_pool.rs` (three modes, both directions, applying a result) and the volatility tracker |
| `process_swap.ts` | `instructions/swap/process_swap.rs`, the pool and config account loaders, `utils/remaining_accounts.rs` and the token transfers of `utils/token.rs` (the hook's extra accounts resolved by `transferCheckedWithHook`) |
| `migration.ts` | `migration_handler/` (compounding and concentrated liquidity) |
| `damm_v2.ts` | what the graduation reads and computes: the DAMM v2 config checks of `migrate_damm_v2_initialize_pool.rs`, the DAMM v2 pool and position fields it reads (layouts from DBC's `idls/damm_v2.json`), the liquidity distribution and its adjustment, the migrated pool's fee parameters, the surplus and migration fee splits, and the mint reads of `utils/token.rs` on the unchecked mint accounts of the migration |
| `config.ts` | config validation and `process_create_config` |
| `token.ts` | the quote mint's score, the transfer fee reads and the Token-2022 base mint and vault sizes of `utils/token.rs` |

Not yet ported: stage 4, the DAMM v1 migration (`migration_meteora_damm_create_metadata`, `migrate_meteora_damm`,
`migrate_meteora_damm_lock_lp_token`, `migrate_meteora_damm_claim_lp_token`). Their discriminators fail with Anchor's
InstructionFallbackNotFound (101).

## How it is checked

`showcase/test/meteora-dbc.test.ts`, `meteora-dbc-fuzz.test.ts`, `meteora-dbc-swap.test.ts`, `meteora-dbc-pool.test.ts`,
`meteora-dbc-pool2022.test.ts`, `meteora-dbc-hook.test.ts`, `meteora-dbc-mainnet.test.ts`, `meteora-dbc-migration.test.ts` and
`meteora-dbc-migration-fuzz.test.ts` run each transaction against this port and against
the program deployed on mainnet (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, deployed in slot 457,502,600, sha256
`c9f45da6…22bb9` once cut at the ELF's end; `scripts/fetch-programs.sh` downloads it, see `test/programs/SOURCES.md`),
with the admin keys and the protocol fee program's authority replaced by test keys in both, and Metaplex Token
Metadata as deployed on mainnet in both (`mpl_token_metadata.so`, sha256 `31f0a627…9011`), and a small transfer hook
(`showcase/test/fixtures/meteora-dbc/hook.ts`) for transfer hook configs. Pools are made by the three pool creation
instructions in both; one is written into both ledgers, as those instructions leave it, only under a config rewritten to
the rate limiter (pool creation refuses that mode; only pools made before 0.2.1 swap with it).
`meteora-dbc-mainnet.test.ts` swaps on two pools read from mainnet (`showcase/test/fixtures/meteora-dbc/`). The
graduation tests (`meteora-dbc-migration*.test.ts`, helpers in `meteora-dbc-graduation.ts`) load DAMM v2
(`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`) and the locker (`LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`) as
deployed on mainnet into both VMs (`meteora_damm_v2.so`, `meteora_locker.so`, see `test/programs/SOURCES.md`) with DAMM
v2's seven migration configs read from mainnet (`showcase/test/fixtures/meteora-dbc/damm-v2/`), fund the pool
authority as it is funded on mainnet (it lends the rent of the accounts DAMM v2 and the locker create), and compare the
DAMM v2 pool, positions, position NFT mints and accounts, vaults and the locker's escrow besides DBC's own accounts.
Each must give the same outcome and error code, the same account
bytes and the same events (the self-CPIs' instruction data, and `emit!`'s log lines). The tests skip when the binary is absent.

Known differences: log lines (Anchor's error messages and the original's "Math error thrown at …" lines are not
reproduced), compute units, the IDL (the three config events describe ConfigParameters' fields in place, and the
metadata Strings are `bytes`), and one refusal order: a read-only `payer` fails with ConstraintMut (2000) here and with
the System Program's PrivilegeEscalation in the original. The `curve` argument holds at most 24 points (102 beyond,
where the original reads any length and refuses more than 16 with InvalidCurve); a transaction carries at most 23.
The transfer hook instructions' `slices` argument holds at most 64 entries (102 beyond; the original takes a Vec of
any length, though more than two slices with accounts are refused as duplicates). The quote vault is sized from the quote mint's extensions as Anchor's `init` sizes it, for the extensions listed in
`token.ts` (`tokenAccountSpace`); a quote mint with confidential-transfer extensions would be sized differently.
When this program is invoked by another program and a rate limiter applies, it reads the processed sibling instructions
as the original does (`processedSiblingInstruction`), checked through a calling program
(`showcase/test/fixtures/meteora-dbc/relay.ts`) loaded in both.
The migration reads its unchecked base and quote mints' transfer fee extension in place (as `token.ts` does) where the
original unpacks them with spl-token-2022's `StateWithExtensions` first: an account that is not a mint would be refused
there and read here, but the vaults' `token::mint` constraints make the mints the vaults' own. DAMM v2's config, pool
and position are read at their fields' offsets after Anchor's owner and discriminator checks (3007, 3001, 3002); a DAMM
v2 account shorter than its type (DAMM v2 makes none) fails here when a field past its end is read (3003), where
Anchor's `load` panics on slicing it. These cases are not tested.
