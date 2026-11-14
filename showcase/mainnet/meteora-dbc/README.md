# Meteora Dynamic Bonding Curve, ported to TypeSOL

Required Notice: All underlying software code is subject to the licence set out at https://github.com/MeteoraAg/dynamic-bonding-curve

This directory is a derivative of Meteora's Dynamic Bonding Curve (https://github.com/MeteoraAg/dynamic-bonding-curve)
at commit 91e696e (release 0.2.2, `programs/dynamic-bonding-curve`), rewritten in TypeSOL. It is **not** under this
repository's MIT licence: it is subject to Meteora's Non-commercial Licence, a verbatim copy of which is in
[LICENSE.md](LICENSE.md). Every source file here says so in its first line. The tests that run it
(`showcase/test/meteora-dbc*.ts`) are under the same terms. Nothing in this directory is part of the published
`@typesol/cli` package.

## What is here

All 35 of the program's instructions:

| File | Ports |
| --- | --- |
| `meteora_dbc.ts` | the instructions. Stage 1: `create_operator_account`, `close_operator_account`, `close_claim_protocol_fee_operator`, `create_token_badge`, `close_token_badge`, `create_partner_metadata`, `create_config`, `create_config2`, `create_config_with_transfer_hook`. Stage 2 so far: `swap`, `swap2` (ExactIn, PartialFill, ExactOut), `claim_trading_fee`, `claim_creator_trading_fee`, `claim_partner_pool_creation_fee`, `claim_protocol_pool_creation_fee`, `claim_protocol_fee2`, `transfer_pool_creator`, `create_virtual_pool_metadata`, `initialize_virtual_pool_with_spl_token` (with its Metaplex metadata CPIs), `initialize_virtual_pool_with_token2022`, `initialize_virtual_pool_with_token2022_transfer_hook`, `swap2_with_transfer_hook`, `claim_trading_fee2`, `claim_creator_trading_fee2`. Stage 3: `partner_withdraw_surplus`, `creator_withdraw_surplus`, `withdraw_migration_fee`, `withdraw_leftover`, `create_locker` (the locker's `create_vesting_escrow_v2` by CPI), `migration_damm_v2_create_metadata` (deprecated, does nothing), `migration_damm_v2` (DAMM v2's `initialize_pool` or `initialize_pool_with_dynamic_config`, `create_position`, `add_liquidity` or `split_position2`, `permanent_lock_position`, `lock_inner_position`, the position NFTs' owners, the base mint's transfer fee authority, the burn, all under flash rent). Stage 4, the DAMM v1 migration (deprecated for new configs; pools of configs made before 0.2.1 still take it): `migration_meteora_damm_create_metadata`, `migrate_meteora_damm` (DAMM v1's `initialize_permissionless_constant_product_pool_with_config2` under flash rent, the burn, the LP split), `migrate_meteora_damm_lock_lp_token` (DAMM v1's `lock`), `migrate_meteora_damm_claim_lp_token` |
| `errors.ts` | `error.rs`: all 87 errors, codes and messages |
| `state.ts` | the accounts (`PoolConfig`, `ConfigWithTransferHook`, `VirtualPool`, `TransferHookPool`, `Operator`, `TokenBadge`, `ClaimFeeOperator`, `PartnerMetadata`, `VirtualPoolMetadata`, the DAMM migration metadata) and the argument types |
| `events.ts` | `event.rs`: all 29 events |
| `math.ts`, `curve.ts` | `math/` and `curve.rs` |
| `fees.ts` | the fee scheduler, the rate limiter, fee parameters, dynamic fee, fee splits and the DAMM v2 validation helpers |
| `swap.ts` | the swap math of `state/virtual_pool.rs` (three modes, both directions, applying a result) and the volatility tracker |
| `process_swap.ts` | `instructions/swap/process_swap.rs`, the pool and config account loaders, `utils/remaining_accounts.rs` and the token transfers of `utils/token.rs` (the hook's extra accounts resolved by `transferCheckedWithHook`) |
| `migration.ts` | `migration_handler/` (compounding and concentrated liquidity) |
| `damm_v1.ts` | what the DAMM v1 migration reads of DAMM v1: its Config (read at its fields' offsets after Anchor's `Account::try_from` checks), its LockEscrow (layouts from DBC's `idls/dynamic_amm.json`), and `validate_config_key` of `migrate_meteora_damm_initialize_pool.rs` |
| `damm_v2.ts` | what the graduation reads and computes: the DAMM v2 config checks of `migrate_damm_v2_initialize_pool.rs`, the DAMM v2 pool and position fields it reads (layouts from DBC's `idls/damm_v2.json`), the liquidity distribution and its adjustment, the migrated pool's fee parameters, the surplus and migration fee splits, and the mint reads of `utils/token.rs` on the unchecked mint accounts of the migration |
| `config.ts` | config validation and `process_create_config` |
| `token.ts` | the quote mint's score, the transfer fee reads and the Token-2022 base mint and vault sizes of `utils/token.rs` |

## How it is checked

Every test sends each transaction to this port and to the program deployed on mainnet, each in its own LiteSVM under
the program's id with the same clock, the admin keys and the protocol fee program's authority replaced by test keys in
both (`showcase/test/meteora-dbc-helpers.ts`). The tests skip when a binary is absent; `scripts/fetch-programs.sh`
downloads them.

| Test | What it covers |
| --- | --- |
| `meteora-dbc.test.ts`, `meteora-dbc-fuzz.test.ts` | stage 1: admin, operator, badge and partner accounts, the three config instructions; random config parameters |
| `meteora-dbc-swap.test.ts`, `meteora-dbc-mainnet.test.ts` | swaps (every mode, both directions, referrals, the rate limiter and its single-swap guard, random sequences to the threshold), fee claims, `transfer_pool_creator`, pool metadata; two pools read from mainnet (`showcase/test/fixtures/meteora-dbc/mainnet/`) |
| `meteora-dbc-pool.test.ts`, `meteora-dbc-pool2022.test.ts`, `meteora-dbc-hook.test.ts` | the three pool creation instructions, the transfer hook instructions (a small hook, `showcase/test/fixtures/meteora-dbc/hook.ts`, in both; a calling program, `relay.ts`, for the processed sibling instructions) |
| `meteora-dbc-migration.test.ts` | stage 3 and the DAMM v2 migration on DAMM v2's seven migration configs read from mainnet (`showcase/test/fixtures/meteora-dbc/damm-v2/`) |
| `meteora-dbc-migration-v1.test.ts` | stage 4, the DAMM v1 migration, on DAMM v1's six migration configs and the wrapped SOL vault read from mainnet (`showcase/test/fixtures/meteora-dbc/damm-v1/`); other dynamic vaults are made by the vault program's own `initialize` in both. Configs are made for DAMM v2 and their migration option rewritten to DAMM v1 in both ledgers, as configs made before 0.2.1 hold it (`create_config` refuses DAMM v1 now) |
| `meteora-dbc-migration-fuzz.test.ts` | random configs and pools graduated on the DAMM v2 or the DAMM v1 path, the withdrawals, locker, metadata, migration and (DAMM v1) LP locks and claims in a random order |

The programs both VMs carry, as deployed on mainnet (sha256 of the dump cut at the ELF's end; `test/programs/SOURCES.md`):

| Program | Id | Deployed in slot | sha256 |
| --- | --- | --- | --- |
| Meteora DBC 0.2.2 (the original) | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | 457,502,600 | `c9f45da65b0c87ca76c1ed5ad0d1ef2ead7c3392e8e41f194d50296820a22bb9` |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | | `31f0a627dba051a938de650464e55cc5397a4be0fd496929c1f9cf02fe5e9011` |
| DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | 457,080,014 | `ca7a32627e284798de74eab2c8c3fe5c904c02b282f93a3314d5ad5bc92e5a67` |
| Locker | `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn` | 368,684,289 | `0ba6f4f596a343b8163ac9b75b0fbeca0681683c7d4b4b23050b4929d015abed` |
| DAMM v1 | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | 468,782,174 (2026-11-13) | `ea4e658199aba1f7d02d9db0e8ade226f99e618f96ffd66f4b7901dbafb97f58` |
| Dynamic vault | `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` | 457,247,303 | `a3c23d248fa6c4b26a84e2194e53d3a5d6a74d10c878eba10a23589c7b18fdcb` |

### What is compared

For every transaction: the outcome and error code; the bytes (lamports, owner, data) of every account it touches,
DBC's own and the other programs' (the DAMM v2 pool, positions, position NFT mints and accounts and vaults; the locker's
escrow; the DAMM v1 pool, its LP mint and the LP mint's Metaplex metadata, both dynamic vaults with their token
accounts and LP mints, the pool's vault LP accounts, the protocol fee accounts, the lock escrows and their LP accounts,
the LP accounts of the pool authority, partner and creator; the migration metadata); every inner instruction (program,
accounts, data: the events travel in self-CPIs); the return data; and the `Program data:` log lines (`emit!`).

### What differs

- Log lines: Anchor's error messages and the original's "Math error thrown at …" lines are not reproduced. Compute
  units differ.
- The IDL: the three config events describe ConfigParameters' fields in place, the metadata Strings are `bytes`.
- A read-only `payer` fails with ConstraintMut (2000) here and with the System Program's PrivilegeEscalation in the
  original.
- The `curve` argument holds at most 24 points (102 beyond, where the original reads any length and refuses more than
  16 with InvalidCurve); a transaction carries at most 23. The transfer hook instructions' `slices` argument holds at
  most 64 entries (102 beyond; the original takes a Vec of any length, though more than two slices with accounts are
  refused as duplicates).
- The quote vault is sized from the quote mint's extensions as Anchor's `init` sizes it, for the extensions listed in
  `token.ts` (`tokenAccountSpace`); a quote mint with confidential-transfer extensions would be sized differently.
- When this program is invoked by another program and a rate limiter applies, it reads the processed sibling
  instructions as the original does (`processedSiblingInstruction`).
- The order of checks when a transaction breaks several at once. Anchor deserializes every account first (in field
  order) and checks the constraints after; here some deserialization checks run as the first constraints: the DAMM v2
  migration's custom loaders, and in the DAMM v1 instructions the DAMM v1 config's `Account::try_from` checks and the
  SPL-Token-only check of the token accounts (3007 for a Token-2022 one), while this program's typed parameters
  (signers, programs, token accounts) are checked before any of them. Each check gives the original's error when it is
  the only one that fails, which is what the tests send; a transaction breaking two of them in different fields may get
  another of the two errors here.

### What is not verified

- The migration reads its unchecked base and quote mints' transfer fee extension in place (as `token.ts` does) where
  the original unpacks them with spl-token-2022's `StateWithExtensions` first: an account that is not a mint would be
  refused there and read here, but the vaults' `token::mint` constraints make the mints the vaults' own. DAMM v2's
  config, pool and position are read at their fields' offsets after Anchor's owner and discriminator checks (3007,
  3001, 3002); a DAMM v2 account shorter than its type (DAMM v2 makes none) fails here when a field past its end is
  read (3003), where Anchor's `load` panics on slicing it. Likewise a DBC VirtualPool, PoolConfig or DAMM v1 migration
  metadata account shorter than its type (this program makes none). These cases are not tested.
- `migrate_meteora_damm` reads the LP minted to the pool authority as anchor_spl's `accessor::amount` does (bytes
  64..72, after DAMM v1 created the account); a shorter account fails here with 3003 and panics in the original
  (DAMM v1 always creates a token account there).
- A DAMM v1 LockEscrow shorter than its type with the LockEscrow discriminator (DAMM v1 makes none) is not tested.
- The binaries are identified (DBC as 0.2.2 by its instruction names, error messages and source paths; DAMM v1, the
  dynamic vault and the locker by their IDLs as DBC keeps them); none was rebuilt from source, so the port is checked
  against these deployed binaries, not against a source revision. DAMM v1 was upgraded on 2026-11-13: a later upgrade
  of it (or of DAMM v2, the vault or the locker) can change what the migrations do on mainnet.
