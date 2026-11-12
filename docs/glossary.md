# Glossary

The Solana and TypeSOL terms the [language guide](language.md) uses, one paragraph each, with the page that uses them
most. Solana's own documentation covers the chain in depth: [solana.com/docs/core](https://solana.com/docs/core).

## Account

A record on the chain at a 32-byte address: a balance in lamports, bytes of data, an owner program and an executable
flag. Programs keep all their state in accounts. See [accounts](language-accounts.md).

## Owner

The program an account belongs to. Only the owner can change the account's data or take lamports from it; any
program can add lamports to an account the transaction made writable. A new account belongs to the System Program
until it is assigned to another. See [accounts](language-accounts.md#account-parameters-and-the-checks-they-emit).

## Lamports

The unit of SOL: 1 SOL is 1,000,000,000 lamports. `account.lamports` is an account's balance, a `u64`.

## Rent

An account must hold a minimum balance proportional to its size to stay on chain, the rent-exempt minimum:
(128 + data bytes) × 6,960 lamports at the time of writing. `create` funds it from the payer, `rentExempt(space)`
computes it, and closing the account returns it. See [creating accounts](language-accounts.md#creating-accounts).

## Discriminator

The first 8 bytes of an account of a TypeSOL or Anchor program (sha256("account:<Name>")[..8]), which say which struct
it holds, and of an instruction's data (sha256("global:<name>")[..8]), which say which instruction it calls. See
[account data](language-basics.md#account-data) and [instructions](language-basics.md#instructions).

## PDA

A program derived address: an address derived from seeds and a program id that has no private key, so only that
program can sign for it, in its calls to other programs. Programs keep accounts at PDAs so that their addresses can be
derived again. See [PDAs](language-pdas.md).

## Seeds

The byte strings a PDA is derived from (`["vault", owner.key]`): at most 15 of them, plus the bump, each at most 32
bytes. See [seeds](language-pdas.md#seeds).

## Bump

The one byte added to a PDA's seeds so that the derived address has no private key. The canonical bump is the
highest that works; it is found by trying 255, 254, … and is usually stored in the account. See [PDAs](language-pdas.md).

## Signer

An account whose private key signed the transaction (a wallet), or a PDA of the calling program in a call it signs
for. A `Signer` parameter checks it. See [accounts](language-accounts.md#account-parameters-and-the-checks-they-emit).

## Writable

Marked writable by the transaction, so its data or lamports may change. A `Mut<…>` parameter checks it.

## Instruction

A call to one program: the program id, the accounts it reads or writes and its data. A TypeSOL instruction is an
exported function. See [instructions](language-basics.md#instructions).

## Transaction

One or more instructions sent together with their signatures, at most 1,232 bytes at the time of writing. It is
atomic: when any instruction fails, the whole transaction fails, its changes are discarded and the fee is still paid.

## Program id

A program's address. `programId()` gives it in the program; `typesol.json` records it for each program of a project.

## Upgrade authority

The key that may replace an upgradeable program's code. `typesol verify` prints it; `solana program
set-upgrade-authority … --final` removes it. See [deploy to mainnet](mainnet.md).

## System Program

The built-in program that creates accounts, assigns them to an owner and moves lamports out of the accounts it owns
(wallets). See [the System Program](language-cpi.md#the-system-program).

## CPI

A cross-program invocation: one program calling another during an instruction, passing it accounts and, for PDAs,
signer seeds. See [calling other programs](language-cpi.md).

## Sysvar

An account at a fixed address that holds cluster state: the clock, rent, the epoch schedule and others. See
[sysvars](language-chain.md#sysvars).

## Mint and token account

An SPL Token mint describes a token (its supply, decimals and mint authority); a token account holds an amount of one
mint for an owner, its authority. Both belong to the SPL Token or Token-2022 program. See
[tokens](language-cpi.md#tokens).

## Borsh

The binary encoding Anchor uses for instruction arguments, events and its account data: integers little-endian,
strings and vectors with a u32 length first. See [types](language-types.md).

## IDL

A JSON description of a program's instructions, accounts, types, events and errors, from which clients encode calls
and decode accounts. A TypeSOL build writes one in Anchor's format. See [what the compiler
derives](language-basics.md#what-the-compiler-derives).

## SBF

Solana's bytecode, which programs are compiled to. TypeSOL lowers a program to C and builds it with the platform-tools'
clang.

## Compute units

What an instruction's work is measured in. A transaction gets 200,000 per instruction by default and at most 1,400,000
at the time of writing; past its budget it fails. `typesol profile` shows where a program spends them. See [limits and
costs](language-basics.md#limits-and-costs).

## Next

[The language guide](language.md).
