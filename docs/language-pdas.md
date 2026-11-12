# PDAs

A program derived address (PDA) is an address derived from seeds and a program id, with no private key: only the
program can sign for it. This page covers seeds, bumps, creating accounts at PDAs, checking them, signing for them in
calls to other programs, and how the IDL records them. Part of the [language guide](language.md).

```ts
import { type Init, type Mut, type Pubkey, type Seeds, type Signer, type SystemAccount, type SystemProgram, type u16, type u64, type u8, findProgramAddressBump, programId, requirePda, signer } from "typesol";

export interface Vault {
  owner: Pubkey;
  bump: u8;
  solBump: u8;
}

export function open(owner: Mut<Signer>, vault: Init<Vault>, systemProgram: SystemProgram, index: u16): void {
  vault.bump = vault.create(owner, ["vault", owner.key, index]);
  vault.owner = owner.key;
  vault.solBump = findProgramAddressBump(["sol", vault.key], programId());
}

export function pay(
  owner: Signer,
  vault: Seeds<Mut<Vault>, ["vault", "@owner", "@index"], "bump">,
  sol: Mut<SystemAccount>,
  to: Mut<SystemAccount>,
  systemProgram: SystemProgram,
  index: u16,
  amount: u64,
): void {
  requirePda(sol, ["sol", vault.key], vault.solBump);
  const solSigner = signer(["sol", vault.key, vault.solBump]);
  systemProgram.transfer(sol, to, amount, solSigner);
}
```

`open` creates the vault at `["vault", owner, index]` and stores both bumps, the second derived, not taken from the
arguments. `pay` moves lamports only for the vault's owner: the `Seeds` constraint derives the vault's address from
the signing `owner`, so another signer names another address and fails with 2006.

## Seeds

A seed list is an array literal written where the seeds go. Each seed contributes its bytes:

| Seed | Bytes |
| --- | --- |
| a string literal or string constant (`"vault"`) | its UTF-8 bytes |
| a `string` argument or `FixedString` field | its UTF-8 bytes |
| a `Pubkey` (`owner.key`, a field, `pubkey("…")`) | its 32 bytes |
| a `Hash` (`sha256(…)`) | its 32 bytes, as Marginfi seeds an order with the hash of its bank keys |
| an integer (an argument, a field, a local, a typed literal) | little-endian at its declared width: a `u16` gives 2 bytes; a bare `5n` is a u64, 8 bytes |
| a unit enum value (`Side.Ask`, an argument or a field) | 1 byte, its variant index |
| `bigEndian(x)` | an integer's bytes most significant first (`["tick_array", pool.key, bigEndian(start)]`), Rust's `to_be_bytes()` |
| the bump (a `u8`) | 1 byte, last |

A seed is at most 32 bytes (`a seed can be at most 32 bytes`, when its length is known at compile time). A `string`
argument longer than that is only known at run time: `create`, `createIfNeeded`, `requirePda` and `Seeds<…>` then fail
with 2006, as for any other address that is not the PDA; check `byteLength(s) <= 32n` first to fail with an error of
your own. Solana takes at
most 16 seeds per address, the bump included. A list the derivation adds the bump to (`create`, `requirePda`,
`findProgramAddress`) holds at most 15 entries (`at most 15 seeds: the bump the derivation adds makes 16, Solana's
limit`); a list that ends with its bump (signer seeds, `createProgramAddress`) holds 16: 15 seeds and the bump (`at
most 16 seeds, the bump included (Solana's limit)`).

## Creating an account at a PDA

`acct.create(payer, seeds)` on an `Init<T>` derives the PDA of this program for the seeds, finds the canonical bump,
checks that the account passed is that address (2006), creates it and returns the bump ([creating
accounts](language-accounts.md#creating-accounts)). Store the bump in the account (`vault.bump = …`) to check and sign
cheaply later.

- `acct.createIfNeeded(payer, seeds)` on an `InitIfNeeded<T>` does the same once, and afterwards re-derives the address
  and checks it.
- A seed may be an Option integer argument with a default, `opt ?? 0n`; the IDL records `opt.unwrap_or(0)`, as Anchor's
  does.
- `create(payer, null)` makes a keypair account instead of a PDA: the account signs the transaction.

### createPda

`systemProgram.createPda(payer, account, space, owner, seeds)` is Anchor's `init` with `seeds`, `space` and
`owner = …` on an `UncheckedAccount`: `account` is a `Mut<AccountInfo>` that must be this program's PDA for `seeds`
(2006). It is created owned by `owner`, or topped up, allocated and assigned when someone funded the address first. It
returns the bump, records the PDA in the IDL, and among the creates a body starts with runs before the constraints.

## Seeds constraints

`Seeds<A, ["vault", "@owner"], "bump">` checks before the body that the account is the PDA for those seeds (2006), as
Anchor's `seeds = […], bump`:

- `"@name"` is the key of the account parameter `name`, or the bytes of the argument `name`.
- `"@name:be"` is an integer argument's bytes most significant first (Rust's `to_be_bytes()`). The IDL records the
  argument as Anchor's does, so clients that derive the address from the IDL get it wrong: pass such accounts
  explicitly.
- `"@acct.field"` is a `Pubkey`, integer or unit enum field of a struct account parameter, also the account's own:
  `["offer", "@maker", "@offer.id"]`.
- Other strings are literals.
- The third argument names the bump: a field of the account itself (`"bump"`, Anchor's `bump = vault.bump`), a field of
  another struct account (`"@acct.field"`, Anchor's `bump = multisig.nonce`), or a field in a struct field of it
  (`"@acct.field.inner"`, Anchor's `bump = config.bumps.vault`). Without it (`never`, or left out) the canonical bump
  is searched for, which costs more.
- `acct.pdaBump` is the bump (Anchor's `ctx.bumps.acct`): the stored field when one is named, else the canonical bump
  the check found. Use it to sign as the PDA.
- `Seeds<A, ["metadata", "@mint"], never, "@metadataProgram">`: the fourth argument derives the PDA under another
  program (a program parameter or a base58 address; `pda.program` in the IDL).

Inside an [account group](language-accounts.md#account-groups), `"@name"` names the group's own fields first.

## Checking a PDA in the body

`requirePda(account, seeds, bump)` checks that `account` is the PDA of this program for `seeds` and `bump` (2006). Any
bump that gives a valid PDA passes, as with Anchor's `bump = expr`. Use a bump stored when the account was created (or
`Seeds<…>`): one taken from the instruction's arguments lets the caller pick among up to 256 addresses for the same
seeds.

## Deriving addresses in the body

```ts
import { type Mut, type Pubkey, type u64, type u8, bigEndian, findProgramAddress, findProgramAddressBump, findProgramAddressWithBump, programId } from "typesol";

export interface Book {
  tick: Pubkey;
  vault: Pubkey;
  bump: u8;
}

export function locate(book: Mut<Book>, owner: Pubkey, start: u64): void {
  book.tick = findProgramAddress(["tick", owner, bigEndian(start)], programId());
  const [vault, bump] = findProgramAddressWithBump(["vault", owner], programId());
  book.vault = vault;
  book.bump = bump;
  book.bump = findProgramAddressBump(["vault", owner], programId());
}
```

- `findProgramAddress(seeds, program)` is the canonical PDA of any program (Rust's
  `Pubkey::find_program_address(..).0`, e.g. a Bubblegum asset id), and `findProgramAddressBump(seeds, program)` its
  bump. `const [address, bump] = findProgramAddressWithBump(seeds, program)` gives both from one search (Rust's
  `let (address, bump) = …`). Each search costs about 450 CU per bump tried.
- `createProgramAddress(seeds, program)` is `Pubkey::create_program_address`: the address for seeds that include the
  bump, or `null` when they give none.
- `programId()` is this program's address.

## Signing as a PDA

A PDA of this program signs a call to another program when the call is given its seeds, with the bump:

```ts
import { type Account, type HasOne, type Mut, type Pubkey, type Seeds, type Signer, type SystemAccount, type SystemProgram, type u64, type u8, signer } from "typesol";

export interface Config {
  admin: Pubkey;
  bump: u8;
  treasuryBump: u8;
  feesBump: u8;
}

export function payOut(admin: Signer, config: HasOne<Seeds<Account<Config>, ["config"], "bump">, "admin">, treasury: Mut<SystemAccount>, fees: Mut<SystemAccount>, to: Mut<SystemAccount>, systemProgram: SystemProgram, amount: u64): void {
  systemProgram.transfer(treasury, to, amount, ["treasury", admin.key, config.treasuryBump]);
  const feeSigner = signer(["fees", config.feesBump]);
  systemProgram.transfer(fees, to, 1n, feeSigner);
}
```

Signer seeds are authority: whoever reaches the call spends what the PDA holds. Here `HasOne` lets only the config's
`admin` call `payOut` (2001 for anyone else), and the bumps come from the config, where they were stored when the
PDAs were created. The config is itself a PDA, `["config"]`, so the program has exactly one: a `HasOne` on any
`Account<Config>` would accept a config anyone created naming themselves admin, and drain `fees`. Whoever creates that
one config is the admin, so gate its creation, for example on the upgrade authority
([ProgramData](language-accounts.md#programdata)). Seeds that include the caller, as `["treasury", admin.key, …]`
does, also limit a call to the caller's own PDA: another signer's seeds give another address, which then does not
sign.

- Every CPI takes optional signer seeds as its last argument: a seed list written there with the bump
  (`["treasury", admin.key, bump]`), or a named one. When several PDAs sign one `invoke`, pass a list of seed lists,
  `[["vault", owner.key, vaultBump], ["fees", feesBump]]` (at most 16).
- A seed list used more than once can be named: `const vault = signer(["vault", owner.key, bump])`, then pass `vault`
  wherever signer seeds go. One of two lists can be picked at run time:
  `const pool = indexed ? signer([…, index, bump]) : signer([…, bump])`. `signer([…])` is written in a declaration or
  as a helper's argument; inside a CPI's own argument list it is refused (`seeds must be an array literal`): write the
  array there instead.
- **When seeds are read.** A named list, and one given to a helper, holds its seeds as they were when it was written
  (JavaScript evaluates the array then): a field or local changed afterwards does not change what it signs for. A list
  written in a call (a helper's `signer([…])` argument, seeds written in a CPI, `create(payer, [...], space)`) holds
  them as they were when the list was read, even when a later argument changes a seed.
- Helpers take signer seeds as a `SignerSeeds` parameter, called with `signer([…])` (or `signer([])` when nothing
  signs).
- The compiler refuses a signer flag in `invoke` on an account that neither signed nor is covered by signer seeds
  ([calling other programs](language-cpi.md#accounts)).
- A typed call from an IDL takes `signer([...seeds, bump])` when a PDA of your program signs, or `signer([])`.

## PDAs in the IDL

When an instruction calls `x.create(payer, seeds)` or `requirePda(x, seeds, bump)`, or `x` has a `Seeds<…>`
constraint, and every seed is a string literal, an integer literal, a constant, an argument, `acct.key` or a scalar
field of an account, the IDL entry for `x` gets Anchor's `pda.seeds` (`const` / `arg` / `account`), so Anchor and
Codama clients derive the address themselves. An associated token account (`Ata<…>`) gets the ATA program's `pda`.

**Next:** [Errors, logs, events and return values](language-errors-events.md).
