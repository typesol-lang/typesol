# Glossary

The Solana and TypeSOL terms the [language guide](language.md) uses, one paragraph each, with the page that uses them
most. Solana's own documentation covers the chain in depth: [solana.com/docs/core](https://solana.com/docs/core).

## Account

A record on the chain at a 32-byte address: a balance in lamports, bytes of data, an owner program and an executable
flag. Programs keep all their state in accounts. See [accounts](language-accounts.md).

## Owner

The word has three meanings in the guide:

- **An account's owner** is the program it belongs to. Only the owner can change the account's data or take lamports
  from it; any program can add lamports to an account the transaction made writable. A new account belongs to the
  System Program until it is assigned to another. See
  [accounts](language-accounts.md#account-parameters-and-the-checks-they-emit).
- **A token account's `owner` field** is the wallet or PDA allowed to move its tokens (its authority), while the
  account itself belongs to the token program. See [tokens](language-cpi.md#tokens).
- **An `owner` field of your own structs** is whatever the program makes of it, usually the key allowed to act on the
  account, checked with `HasOne<…, "owner">` or `require`. See [constraints](language-accounts.md#constraints).

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

## Keypair account

An account whose address is the public key of a keypair made for it, as opposed to a [PDA](#pda): the keypair signs
the transaction that creates it, and afterwards nobody needs it. `create(payer, null)` makes one. See [creating
accounts](language-accounts.md#creating-accounts).

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

## Authority

An account allowed to do something to another: a mint's mint authority, a token account's owner, a program's
[upgrade authority](#programdata-and-upgrade-authority), a program's own admin key. It acts by signing, as a wallet or
as a PDA with signer seeds. See [tokens](language-cpi.md#tokens).

## Payer

The account that pays: the fee payer, the transaction's first signer, pays its fees; the payer an instruction names
(`create(payer, …)`) pays the rent of the accounts it creates, so it must sign and be writable (`Mut<Signer>`). See
[creating accounts](language-accounts.md#creating-accounts).

## Writable

Marked writable by the transaction, so its data or lamports may change. A `Mut<…>` parameter checks it.

## Instruction

A call to one program: the program id, the accounts it reads or writes and its data. A TypeSOL instruction is an
exported function. See [instructions](language-basics.md#instructions).

## Transaction

One or more instructions sent together with their signatures, at most 1,232 bytes at the time of writing. It is
atomic: when any instruction fails, the whole transaction fails, its changes are discarded and the fee is still paid.

## Remaining accounts

The accounts a client passes after those an instruction declares, read by position with `remainingAccounts()`
(Anchor's `ctx.remaining_accounts`), for lists whose length is known only at run time. See [remaining
accounts](language-accounts.md#remaining-accounts).

## Return data

Up to 1,024 bytes an instruction leaves for its caller: another program reads them after the call, and a client from
the transaction's simulation or metadata. A TypeSOL instruction that returns a value sends it this way. See [return
values](language-errors-events.md#return-values).

## Program id

A program's address. `programId()` gives it in the program; `typesol.json` records it for each program of a project.

## ProgramData and upgrade authority

An upgradeable program (the BPF upgradeable loader's, which `solana program deploy` uses) is two accounts: the program
account at the program id, which points to a ProgramData account derived from it, and that ProgramData account, which
holds the code, the slot of the last deploy and the upgrade authority. The upgrade authority is the key that may
replace the code; `solana program set-upgrade-authority … --final` removes it, and the program can then never change.
`typesol verify` prints it, and a `ProgramData` parameter reads it, to let only the deployer set a program up. See
[ProgramData](language-accounts.md#programdata) and [deploy to mainnet](mainnet.md).

## System Program

The built-in program that creates accounts, assigns them to an owner and moves lamports out of the accounts it owns
(wallets). See [the System Program](language-cpi.md#the-system-program).

## CPI

A cross-program invocation: one program calling another during an instruction, passing it accounts and, for PDAs,
signer seeds. See [calling other programs](language-cpi.md).

## Slot and epoch

A slot is the time a validator has to produce a block, about 400 ms; an epoch is a run of slots (432,000 on mainnet,
about two days) after which stake activates or deactivates and rewards are paid. `currentSlot()` and `currentEpoch()`
read them from the Clock. See [sysvars](language-chain.md#sysvars).

## Cluster

A network of validators running one Solana chain: mainnet-beta (real SOL), devnet (free SOL for testing), testnet, or a
local validator on your machine (`solana-test-validator`, often called localnet). Commands that send transactions take
the cluster's RPC URL (`--url`). See [deploy to mainnet](mainnet.md).

## Sysvar

An account at a fixed address that holds cluster state: the clock, rent, the epoch schedule and others. See
[sysvars](language-chain.md#sysvars).

## Syscall

A function the runtime provides to programs: logging, hashing, signature recovery, reading sysvars, deriving PDAs,
calling other programs. A program calls it as a function; its cost is in compute units. See
[sysvars](language-chain.md#sysvars).

## Precompile

A native program that verifies signatures (Ed25519, secp256k1, secp256r1) given in an instruction of its own. The
runtime runs it before the transaction's programs and rejects the transaction if a signature is wrong, so a program
only needs to find that instruction in the transaction, through the Instructions sysvar. See
[signatures](language-chain.md#signatures).

## Mint and token account

An SPL Token mint describes a token (its supply, decimals and mint authority); a token account holds an amount of one
mint for an owner, its authority. Both belong to the SPL Token or Token-2022 program. See
[tokens](language-cpi.md#tokens).

## Associated token account

The token account at the address the Associated Token Account program derives from a wallet, the token program and a
mint: the one token account per wallet and mint that wallets and clients use by default. `Ata<…>` checks or creates
one. See [token accounts and mints as
parameters](language-cpi.md#token-accounts-and-mints-as-parameters).

## Borsh

The binary encoding Anchor uses for instruction arguments, events and its account data: integers little-endian,
strings and vectors with a u32 length first. See [types](language-types.md).

## Zero-copy

An account read in place, its bytes used as the struct, instead of being decoded into a copy (Anchor's
`#[account(zero_copy)]` and `AccountLoader`, with bytemuck). TypeSOL reads every fixed-layout account in place;
`@serialization bytemuck` makes the IDL describe a struct as zero-copy, and such an account is checked as Anchor's
`AccountLoader` checks it. See [zero-copy types](language-accounts.md#zero-copy-types-as-anchors-idl-describes-them).

## Anchor

The most used Rust framework for Solana programs: its macros generate each instruction's account checks
(`#[derive(Accounts)]`), account discriminators, error codes and an IDL. TypeSOL follows its conventions (the same
discriminators, error numbers and IDL format), so Anchor clients and tools work with TypeSOL programs, and the guide
names the Anchor equivalent of each feature for readers who know it. Knowing Anchor is not needed. See [migrate from
Anchor](migrate-from-anchor.md).

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
