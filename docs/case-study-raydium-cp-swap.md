# Case study: Raydium CP-Swap

This page ports a production AMM, every instruction of it: [Raydium CP-Swap](https://github.com/raydium-io/raydium-cp-swap)
(`programs/cp-swap`, Anchor 1.0.2, Apache-2.0). It is deployed on mainnet at
`CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`. The port is [`showcase/mainnet/raydium-cp-swap/`](https://github.com/typesol-lang/typesol/blob/main/showcase/mainnet/raydium-cp-swap)
(`state.ts`, `curve.ts`, `raydium_cp_swap.ts`). As with [coral-xyz/multisig](case-study-multisig.md), it is checked
against the binary that runs on mainnet, not a rebuild.

## What is ported

The port covers all 21 of the original's instructions:

- pool creation: `initialize`, `initialize_v2` (the same without the rent sysvar, choosing the creator fee) and
  `initialize_with_permission` (for a payer Raydium authorized, on behalf of another creator, with the creator fee on);
- the four trading instructions: `swap_base_input`, `swap_base_output`, `deposit` and `withdraw`;
- the fees: `collect_protocol_fee`, `collect_fund_fee`, `collect_creator_fee` and
  `collect_creator_fee_permissionless`;
- the admin instructions: `create_amm_config`, `update_amm_config`, `update_pool_status`, `create_permission_pda`,
  `close_permission_pda`, `create_creator_fee_share`, `close_creator_fee_share`, `create_support_mint_associated`,
  `close_support_mint_associated` and `collect_excess_lamports`.

The port keeps the original's account layouts:

- `AmmConfig`, `Permission`, `CreatorFeeShare` and `SupportMintAssociated` are Borsh accounts of fixed size.
- `PoolState` and `ObservationState` are zero-copy `#[repr(C, packed)]` structs, which is TypeSOL's fixed layout.

It also keeps the original's names, account order, argument order and error codes, and emits the same events
(`SwapEvent`, `LpChangeEvent`). Existing pools, clients and indexers work with it unchanged.

## What it needed

Creating the pool by hand, as the original does, needed a few general features (`test/language/manual-init.test.ts`):

- `systemProgram.allocate` and `assign`, for an address someone pre-funded;
- `programId()` and `findProgramAddressBump(seeds, program)`, to sign as the pool PDA;
- `initAccount<T>(account)`, Anchor's `load_init`: a program account the body created becomes a struct to fill;
- `Pubkey.compare`, for the original's `token_0_mint < token_1_mint`;
- `ata.create(payer, tokenProgram)`, an associated token account under one of several token programs.

`Init` accounts also now fail on an address already in use as Anchor's do. TypeSOL used to check first and fail with
3000; now the System Program refuses the address (`AccountAlreadyInUse`, custom 0). It also checks that the payer is
not the account being created (4101).

Four Token-2022 reads were added to the compiler for this port (`test/integrations/t22ext.test.ts`):

- `transferFeeInverse(mint, amountReceived)`: spl-token-2022's `calculate_inverse_epoch_fee`, used for deposits and
  exact-output swaps.
- `transferFeeBasisPoints(mint)` and `transferFeeMaximum(mint)`: the fee in force this epoch.
- `extensionsWithin(account, [types])`: the original's list of mint extensions a pool accepts.

The instructions added later needed none: `Ata<InitIfNeeded<…>>` for the creator's token accounts, `CloseTo` for the
closing instructions, `readData` to read a token account as `StateWithExtensions::unpack` does, and `invoke` for the
token instructions Anchor has no wrapper for (`WithdrawExcessLamports`, `SyncNative`, `UnwrapLamports`).

The rest uses features TypeSOL already had:

- `constraint(…)`, for Anchor's `address = pool_state.load()?.amm_config` and `constraint = …` in Anchor's order;
- u128 arithmetic for the constant-product curve and the price oracle;
- token CPIs signed by the pool authority PDA;
- events.

## How it was checked

[`showcase/test/raydium-cp-swap.test.ts`](https://github.com/typesol-lang/typesol/blob/main/showcase/test/raydium-cp-swap.test.ts) loads the binary dumped from
mainnet on 2026-11-07 (deployed at slot 463522946 on 2026-10-31; sha256 in [`test/programs/SOURCES.md`](https://github.com/typesol-lang/typesol/blob/main/test/programs/SOURCES.md)) into one
LiteSVM and the port into another. Both use the same program id and the same clock.

**Setup.**

- Mints and token accounts are made by the same SPL Token / Token-2022 instructions in both.
- Raydium's five signing keys (the admin, and the owners of permissions, fee shares, supported mints and excess
  lamports) are replaced by test keys in both: in the original, at each place its code loads one (four 64-bit
  immediates); in the port, in its source. The admin instructions then run in both.
- Pools for trading (an `AmmConfig`, a pool's `PoolState` and its `ObservationState`) are written in both as the
  original lays them out, so each test starts from the state it needs.

**Comparison.** For each transaction, the test requires the same outcome (success, or the same error down to the
code), the same lamports, owner and data for every account involved, and the same events byte for byte.

There are 136 transactions:

- **Pool creation.** With `initialize`, these cases are covered:
  - a pool at its PDA, at a signing keypair, and at a pre-funded address;
  - a pool with the creation fee, paid in wrapped SOL;
  - a pool of Token-2022 fee mints;
  - creating the same pool twice;
  - an address that did not sign (2501);
  - mints in the wrong order (2003);
  - an unsupported extension (6007);
  - a disabled config (6000);
  - too little liquidity (6009).

  `initialize_v2` with the creator fee off and on in each of its three modes, and its refusals.
  `initialize_with_permission` without a permission (3007), with another payer's (2006), and with one.
- **Swaps.** Both directions, by input and by output; the observation ring advancing as the clock moves; slippage
  (6005); zero amounts.
- **Liquidity.** Deposit, a partial withdrawal, slippage both ways, withdrawing more LP than held, zero.
- **Fees.** Protocol and fund fees collected by their owners after trading, and refused for anyone else (6001).
- **Creator fees.** Pools with the creator fee on at 0.05%, taken from the input token, only token_0, or only
  token_1: swaps both ways, by input and by output, booking the fee on the right side. Collected by the creator (its
  token accounts created on the way) at the config's share, again with nothing owed (6014), with the creator's own
  share, by anyone with the permissionless form, at the config's share again after the share is closed, for SPL Token
  and Token-2022 fee mints; a share above 100% (6003); anyone but the creator (2012).
- **Permissions, fee shares, supported mints.** Each created and closed by Raydium's keys and refused for anyone else
  (6001, 6000); a fee share above 100% (6003); a permission created twice; a supported-mint entry for an SPL Token
  mint (6000). A Token-2022 mint with a permanent delegate is refused for a pool (6007) until it is listed and the
  entry passed, and again without the entry.
- **Excess lamports.** Swept from the pool and its observation account (rent kept), from an SPL Token and a Token-2022
  vault and the LP mint (`WithdrawExcessLamports`), from wrapped SOL held by the pool authority (`SyncNative`, then
  `UnwrapLamports` of exactly the difference); a trader's account (the token program's OwnerMismatch, 4); anyone but
  the two keys (6001).
- **The price oracle.** A new point, a second swap within 15 seconds (added to the current point), and a ring at its
  last slot whose cumulative price is 10 below `u128::MAX`: the next point wraps to slot 0 and the sum wraps around.
- **Token-2022.** A pool of two transfer-fee mints (1.5% and 0.37%): swaps both ways and by output, deposit and
  withdrawal, through the inverse-fee path; and a pool of Token-2022 mints without a fee.
- **Refusals.**
  - Another config (2012), another pool's vault (2003), another observation account (2012) or mint (2012).
  - The same vault twice, a wrong pool authority (2006), another trader's account.
  - Wrong vaults or LP mint on deposit (6004), the wrong token program.
  - Swaps or deposits on a pool whose status disables them (6000).
  - The admin instructions sent by anyone but the admin (2012, 6001).

## Cost

Compute units per transaction, mainnet original against the port, from that test:

| Instruction | Raydium (mainnet) | TypeSOL | |
| --- | ---: | ---: | ---: |
| `initialize` | 83,559 | 39,878 | −52% |
| `initialize`, Token-2022 transfer fees | 93,047 | 53,834 | −42% |
| `initialize_v2`, creator fee on | 86,286 | 41,760 | −52% |
| `initialize_with_permission` | 98,221 | 43,358 | −56% |
| `swap_base_input` | 24,162 | 5,734 | −76% |
| `swap_base_output` | 24,591 | 5,945 | −76% |
| `deposit` | 25,007 | 6,194 | −75% |
| `withdraw` | 25,214 | 6,203 | −75% |
| `collect_protocol_fee` | 20,205 | 4,189 | −79% |
| `collect_creator_fee`, creating the creator's two token accounts | 61,644 | 34,014 | −45% |
| `collect_creator_fee_permissionless` | 28,165 | 5,887 | −79% |
| `create_permission_pda` | 10,525 | 2,291 | −78% |
| `create_creator_fee_share` | 8,421 | 2,067 | −75% |
| `create_support_mint_associated` | 7,837 | 2,012 | −74% |
| `close_creator_fee_share` | 5,169 | 767 | −85% |
| `collect_excess_lamports`, wrapped SOL | 10,798 | 3,764 | −65% |
| `swap_base_input`, Token-2022 transfer fees | 31,339 | 12,082 | −61% |
| `swap_base_output`, Token-2022 transfer fees | 32,508 | 14,097 | −57% |
| `deposit`, Token-2022 transfer fees | 33,203 | 14,478 | −56% |

The Token-2022 rows include the token program's own work, which is the same in both. Refusals cost far less. For
example, a swap through the wrong config costs 17,193 against 1,656.

On size, the port's binary is 215,080 bytes and the deployed original is 749,848 bytes, for the same 21 instructions.

Pool creation is mostly the token programs' and the System Program's own work (account creation, initialization,
transfers), which costs the same in both. The difference is the program's part. Its cost also varies from run to run
with the PDA bump searches of the random keys the test uses, in both programs alike.

Two general optimizations came out of profiling this port. u128 arithmetic now takes the native 64-bit instructions
when the values fit, and an instruction reads the Clock once. Together they took a swap from 7,478 to 5,734.

## Where they differ

- **Panics.** Where the original calls `unwrap()` or `assert!`, it aborts with `ProgramFailedToComplete`. The port
  fails with a numbered error instead:
  - an overflow or underflow, 5100: an exact-output swap for more than the vault holds;
  - a division by zero, 5101: the price of an empty side, or an exact-output swap for exactly what the vault holds;
  - invalid input, 6003: a fee rate out of range in the admin instructions, which only the admin can reach.
  - an overflow adding to the destination's lamports in `collect_excess_lamports`, 5100 where the original returns
    `ArithmeticOverflow`: no account holds that many lamports.

  The swaps and liquidity instructions reach none of these with the amounts a pool can hold.
- **Check order on double faults.** Account checks run in Anchor's order, so a transaction breaking one check gets the
  same code. The port keeps the pool's `address = …` and `token::…` constraints as `constraint(…)` calls in Anchor's
  order. A transaction that breaks a token check and an account-type check at once can still be reported differently.
- **Token accounts in `collect_excess_lamports`.** The original reads a remaining account as a token account with
  `StateWithExtensions::unpack`, which also walks the Token-2022 extension list. The port checks the size, the
  account type byte, the state and the option tags, not the extension list: a Token-2022 account the token program
  wrote always has a valid one.
- **Logs.** Error messages are TypeSOL's. Codes and events are the original's.
