# Meteora Dynamic Bonding Curve, ported to TypeSOL

Required Notice: All underlying software code is subject to the licence set out at https://github.com/MeteoraAg/dynamic-bonding-curve

This directory is a derivative of Meteora's Dynamic Bonding Curve (https://github.com/MeteoraAg/dynamic-bonding-curve)
at commit 91e696e (release 0.2.2, `programs/dynamic-bonding-curve`), rewritten in TypeSOL. It is **not** under this
repository's MIT licence: it is subject to Meteora's Non-commercial Licence, a verbatim copy of which is in
[LICENSE.md](LICENSE.md). Every source file here says so in its first line. The tests that run it
(`showcase/test/meteora-dbc*.ts`) are under the same terms. Nothing in this directory is part of the published
`@typesol/cli` package.

## What is here

The first stage of the port (9 of the program's 35 instructions):

| File | Ports |
| --- | --- |
| `meteora_dbc.ts` | the instructions: `create_operator_account`, `close_operator_account`, `close_claim_protocol_fee_operator`, `create_token_badge`, `close_token_badge`, `create_partner_metadata`, `create_config`, `create_config2`, `create_config_with_transfer_hook` |
| `errors.ts` | `error.rs`: all 87 errors, codes and messages |
| `state.ts` | the accounts (`PoolConfig`, `ConfigWithTransferHook`, `VirtualPool`, `TransferHookPool`, `Operator`, `TokenBadge`, `ClaimFeeOperator`, `PartnerMetadata`, `VirtualPoolMetadata`, the DAMM migration metadata) and the argument types |
| `events.ts` | `event.rs`: all 29 events |
| `math.ts`, `curve.ts` | `math/` and `curve.rs` |
| `fees.ts` | the fee scheduler, fee parameters, dynamic fee, fee splits and the DAMM v2 validation helpers |
| `migration.ts` | `migration_handler/` (compounding and concentrated liquidity) |
| `config.ts` | config validation and `process_create_config` |
| `token.ts` | the quote mint's score and transfer fee reads of `utils/token.rs` |

Not yet ported: the other 26 instructions (pools, swaps, fee claims, surplus, leftover, locker, DAMM v1 and v2
migration), the rate limiter base fee and the swap math of `state/virtual_pool.rs`. Their discriminators fail with
Anchor's InstructionFallbackNotFound (101).

## How it is checked

`showcase/test/meteora-dbc.test.ts` and `meteora-dbc-fuzz.test.ts` run each transaction against this port and against
the program deployed on mainnet (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, deployed in slot 457,502,600, sha256
`c9f45da6…22bb9` once cut at the ELF's end; `scripts/fetch-programs.sh` downloads it, see `test/programs/SOURCES.md`),
with the admin keys replaced by test keys in both. Each must give the same outcome and error code, the same account
bytes and the same events (the self-CPIs' instruction data). The tests skip when the binary is absent.

Known differences: log lines (Anchor's error messages and the original's "Math error thrown at …" lines are not
reproduced), compute units, the IDL (the three config events describe ConfigParameters' fields in place, and the
metadata Strings are `bytes`), and one refusal order: a read-only `payer` fails with ConstraintMut (2000) here and with
the System Program's PrivilegeEscalation in the original. The `curve` argument holds at most 24 points (102 beyond,
where the original reads any length and refuses more than 16 with InvalidCurve); a transaction carries at most 23.
