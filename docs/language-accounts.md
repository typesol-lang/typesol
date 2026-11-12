# Accounts

An instruction's account parameters are typed, and each type says what is checked before the body runs: the owner,
the discriminator, the size, signatures, writability, constraints between accounts. This page lists the account types,
the constraint types and the account built-ins, with what each generates and the error codes. Part of the
[language guide](language.md). For deriving and signing for PDAs, see [PDAs](language-pdas.md); for the order in which
the checks run, [which error a transaction gets](errors.md#which-error-a-transaction-gets).

## Account parameters and the checks they emit

```ts
import { type Account, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u64 } from "typesol";

export interface Note {
  author: Pubkey;
  likes: u64;
}

export function write(author: Mut<Signer>, note: Init<Note>, systemProgram: SystemProgram): void {
  note.create(author, null);
  note.author = author.key;
}

export function like(fan: Signer, note: Mut<Note>, original: Account<Note>): void {
  note.likes += original.likes > 0n ? 1n : 2n;
}
```

| Parameter type | Checked before your code runs |
| --- | --- |
| `Signer` / `Mut<Signer>` | signed (3010) and, for `Mut`, writable (2000) |
| `Account<T>` / `Mut<T>` | owned by this program (3007), initialized (3012), 8-byte discriminator matches (3002), data large enough (3003) and, for `Mut`, writable (2000). A zero-copy type is checked as Anchor's `AccountLoader` checks it ([below](#zero-copy-types-as-anchors-idl-describes-them)) |
| `Init<T>` | writable; the body creates it ([below](#creating-accounts)) |
| `InitIfNeeded<T>` | writable; the body creates it when it does not exist, else checks it |
| `Zeroed<T>` | allocated by the client, not yet initialized, writable ([below](#zeroed-accounts)) |
| `TokenAccount` / `Mut<TokenAccount>` | owned by SPL Token or Token-2022 (extensions allowed, multisig accounts refused), initialized (3012 for an account never created, as Anchor) |
| `Mint` / `Mut<Mint>` | owned by SPL Token or Token-2022, initialized (3012) |
| `SystemAccount` / `Mut<SystemAccount>` | owned by the System Program, e.g. a wallet (Anchor's `SystemAccount`, 3011) |
| `AccountInfo` / `Mut<AccountInfo>` | nothing (writable for `Mut`): check what you rely on yourself |
| `SystemProgram`, `TokenProgram`, `Token2022Program` | the exact program address (3008) |
| `TokenInterface` | either token program |
| `AssociatedTokenProgram`, `MemoProgram`, `TokenMetadataProgram`, `StakeProgram`, `MplCoreProgram`, `BubblegumProgram` | that program's address (3008); their methods are CPIs ([calling other programs](language-cpi.md)) |
| `Program<"Address…">` | the exact program address (3008) and executable (3009) |
| `UncheckedProgram` | executable only: check `.key` yourself |
| `ProgramData` | this program's ProgramData ([below](#programdata)) |
| `InstructionsSysvar` | the exact address (3008) ([introspection](language-chain.md#instruction-introspection)) |
| `PythPriceUpdate`, `SwitchboardFeed`, `SwitchboardRandomness` | owner program and discriminator ([oracles](language-chain.md#oracles)) |
| `SlotHashesSysvar`, `StakeHistorySysvar` | the sysvar's address (3008) and data (5103: SlotHashes with no entries, StakeHistory too short) ([sysvars](language-chain.md#sysvars)) |
| `EventAuthority`, `SelfProgram` | Anchor's `["__event_authority"]` PDA, and this program's own address, for [`emitCpi`](language-errors-events.md#events-through-cpi) |
| `A \| null` / `Optional<A>` | an [optional account](#optional-accounts) |
| `Dup<Mut<T>>` | may be the same account as another writable parameter ([below](#two-parameters-one-account)) |

Every account exposes `key`, `lamports`, `dataLen`, `isSigner` and `isWritable`; `AccountInfo` adds `owner` and
`executable`. A struct account's fields are read as `acct.field`, and written on a `Mut<T>`. A field named like an
account member (`key`, `lamports`, …) is refused: name it `key_` (it is `key` in the IDL).

Unlike Anchor, there is no `Context` and no `#[derive(Accounts)]` struct: the parameters are the accounts, in the order
the client passes them. Writing to an account that is not `Mut<…>` is a TypeScript error (the field is read-only).

### Two parameters, one account

Two writable parameters can never be the same account: aliasing is refused with error 2040 (also when a remaining
account written through `.lamports` or `loadAccountMut` is another account of the instruction).

`Dup<Mut<T>>` (Anchor's `dup`) lifts that for one parameter when both accounts are read and written in place (not
created, closed or `@layout borsh`; a close destination may be one, the rent reaching it through either). A write
through either is seen through the other, so read what you need before writing. A reference into one of them
(`const e = a.entries.get(i)`) cannot be used after a push, pop or clear through the other moved that data, as with one
name (a compile error): copy the fields first.

A remaining account can be loaded with `loadAccountMut` once per instruction: loading the same one again
(`rest.get(i)` and `rest.get(j)` with `i == j`) is refused with 2040 too, since the two views would alias. So is a
second `loadAccountMut` of one `AccountInfo` parameter. Two `Dup<…>` parameters that are one account may each be
loaded (one array holding both ticks of a position, as Raydium CLMM's tick arrays).

### How many accounts

At most 32 accounts per instruction; more is refused with 5113. `export const MAX_ACCOUNTS = 128n` (up to 255; Anchor
takes what the runtime allows) raises it for programs that take many remaining accounts. The CPI scratch lists are
then kept on the heap instead of the stack; programs that do not declare it compile exactly as before.

## Creating accounts

```ts
import { type Init, type InitIfNeeded, type Mut, type Pubkey, type Signer, type SystemProgram, type u8 } from "typesol";

export interface Profile {
  owner: Pubkey;
  bump: u8;
}

export interface Settings {
  admin: Pubkey;
}

export function register(user: Mut<Signer>, profile: Init<Profile>, systemProgram: SystemProgram): void {
  profile.bump = profile.create(user, ["profile", user.key]);
  profile.owner = user.key;
}

export function configure(admin: Mut<Signer>, settings: InitIfNeeded<Settings>, systemProgram: SystemProgram): void {
  const created = settings.createIfNeeded(admin, ["settings"]);
  if (created) settings.admin = admin.key;
}

export function scratch(payer: Mut<Signer>, extra: Init<Settings>, systemProgram: SystemProgram): void {
  extra.create(payer, null, 8n + 32n + 64n);
}
```

- **`Init<T>`**: `acct.create(payer, seeds)` derives the PDA, verifies that the account is that address (2006), funds
  the rent from `payer`, allocates the struct's size (up to 10 KiB), assigns it to this program and writes the
  discriminator; it returns the bump. `create(payer, null)` creates a keypair account instead: the account must sign
  the transaction (3010; it is a signer in the IDL). A third argument is Anchor's `space = …` (the discriminator
  included, at least 8 + the struct's size). The new account's fields start at zero.
- A payer that is the account being created fails with 4101; an address already in use fails in the System Program
  (0, AccountAlreadyInUse), as under Anchor's `init`. `create` also handles an address someone pre-funded: it tops up
  the rent, then allocates and assigns instead of `create_account` (which would fail).
- The creates a body starts with (after its `constraint(…)` lines) run before the other accounts' constraints, as
  Anchor creates `init` accounts first; a create after other statements runs where it is.
- `create` and `createIfNeeded` are top-level statements of the instruction (`const bump = acct.create(…)` included),
  not inside an `if`, a loop, a helper or a `return` (`… must be a top-level statement of the instruction`), and an
  `Init<T>` the body never creates is an error.
- **`InitIfNeeded<T>`**: `const created = acct.createIfNeeded(payer, seeds)` creates the account once; afterwards it
  re-derives the PDA and checks the owner, discriminator and size (Anchor's `init_if_needed`). `acct.pdaBump` is the
  bump after it. An existing account is used as it is: check the fields you rely on.
- Seeds, bumps and `create` under another program are on the [PDAs](language-pdas.md) page; mints, token accounts
  and associated token accounts are created the same way ([tokens](language-cpi.md#creating-mints-and-token-accounts)).

### Accounts created by hand

`systemProgram.createAccount(…)`, or `systemProgram.allocate(account, space, seeds?)` + `systemProgram.assign(account,
owner, seeds?)` for an address someone pre-funded, then `const data = initAccount<T>(account)` (Anchor's `load_init`:
owned by this program 3007, writable 3006, large enough 3003, no discriminator yet 3000) gives the struct to fill. This
is for accounts whose address is decided at run time (a PDA or a signing keypair), as Raydium's pools are. `Init<T>`
covers the usual case. `systemProgram.createPda(…)` is [on the PDA page](language-pdas.md#createpda).

### Zeroed accounts

`Zeroed<T>` is Anchor's `zero`: an account (up to 10 MiB) the client allocated with System `CreateAccount`. Its
discriminator must still be zero (2013, checked first as under Anchor), and it must be owned by this program (3007),
big enough for the struct (3003), writable (2000) and rent-exempt (2005); then the discriminator is written and the
body initializes the fields. A `@layout borsh` struct starts empty and is written as Borsh when
the instruction returns. `Signed<Zeroed<Multisig>>` also requires it to sign, for an account the client creates with a
fresh keypair.

### Migrating an account

```ts
import { type Migrate, type Mut, type Pubkey, type Signer, type SystemProgram, type u64 } from "typesol";

/** @discriminator account:Counter */
export interface CounterV1 {
  count: u64;
}

export interface CounterV2 {
  count: u64;
  owner: Pubkey;
}

export function upgrade(payer: Mut<Signer>, counter: Migrate<CounterV1, CounterV2>, systemProgram: SystemProgram): void {
  counter.migrate(payer, { count: counter.from.count, owner: payer.key });
}
```

Anchor 1.0's `Migration`: an existing `From` account (owner, discriminator, size checked) is rewritten as `To` by
`acct.migrate(payer, value)`, a top-level statement the instruction must reach.

- `acct.from` (read-only) is readable before it and `acct.to` after it; the value is built in full before the rewrite,
  so it may read `acct.from`.
- The account is resized to `To` (the payer tops up the rent when it grows, at most 10 KiB; shrinking keeps the
  lamports; growing needs `SystemProgram`).
- The account then carries `To`'s discriminator, so an account already migrated fails with 3002. Keep the old struct
  under a new name with its old discriminator, `/** @discriminator account:Counter */ interface CounterV1 { … }`, and
  give the new one a name of its own (two structs with one discriminator are refused).
- Limits: fixed-layout structs without growable Vecs, no constraints yet, and the account cannot be passed to a helper
  (use `acct.to` fields in the instruction).

## Closing and resizing

```ts
import { type Mut, type Signer, type SystemProgram, type u64, close, realloc } from "typesol";

export interface Log {
  entries: u64;
}

export function grow(payer: Mut<Signer>, log: Mut<Log>, systemProgram: SystemProgram, size: u64): void {
  realloc(log, size, payer);
}

export function remove(owner: Mut<Signer>, log: Mut<Log>): void {
  close(log, owner);
}
```

- `close(account, destination)` closes a program account: its lamports go to `destination` (another writable
  account) and its data is zeroed. The account is not used after it in the function, except its `key` (compile
  errors, or 2040 at run time in a helper given one account twice). `CloseTo<A, "dest">` does the same when the
  instruction succeeds ([constraints](#constraints)).
- `realloc(account, newSize, payer)` on a `Mut<Struct>`: growing charges the payer the extra rent (at most 10 KiB per
  instruction, 3016); shrinking keeps the lamports in the account; never below the struct. Refused on a struct with a
  growable `Vec` (its push / pop / clear size the account).
- `resizeAccount(account, newSize)` on a `Mut<AccountInfo>` of this program is Rust's `AccountInfo::resize`: the
  length only, new bytes zeroed, no rent moved (fund it first: `rentExempt(newSize)`), at most 10 KiB of growth
  (3016).
- An account grows at most 10 KiB per instruction, counted from its length when the instruction started (Solana's
  limit): realloc again in the next instruction.
- `account.lamports` can be read on any account and written on a `Mut` one.

## Constraints

```ts
import { type CloseTo, type HasOne, type Mut, type Pubkey, type Seeds, type Signer, type u64, type u8, constraint } from "typesol";

export enum VaultError {
  NotOwner = "Only the owner",
  TooMuch = "Amount above the limit",
}

export interface Vault {
  owner: Pubkey;
  limit: u64;
  balance: u64;
  bump: u8;
}

export function spend(owner: Signer, vault: HasOne<Seeds<Mut<Vault>, ["vault", "@owner"], "bump">, "owner", VaultError.NotOwner>, amount: u64): void {
  constraint(vault, amount <= vault.limit, VaultError.TooMuch);
  vault.balance -= amount;
}

export function shut(owner: Mut<Signer>, vault: CloseTo<HasOne<Mut<Vault>, "owner">, "owner">): void {
  vault.balance = 0n;
}
```

Constraints are types wrapped around an account type, as Anchor's `#[account(…)]` attributes. They are checked before
the body, in Anchor's order, and recorded in the IDL (`relations`, `pda`, `address`).

| Constraint | Checks | Error |
| --- | --- | --- |
| `HasOne<A, "owner">` | the struct's `owner` field equals the parameter named `owner` (Anchor's `has_one`) | 2001 |
| `Seeds<A, ["vault", "@owner"], "bump">` | the account is that PDA ([PDAs](language-pdas.md#seeds-constraints)) | 2006 |
| `CloseTo<A, "owner">` | closes the account into `owner` when the instruction succeeds (Anchor's `close`) | |
| `Address<A, "4Nd1…">` | the exact address (`address` in the IDL) | 2012 |
| `Owner<A, "Tokenkeg…">` | the owner program | 2004 |
| `Executable<A>` | executable | 2007 |
| `Signed<A>` | the account signed (Anchor's `signer` constraint); the IDL marks it a signer | 2002 |
| `Ata<TokenAccount, "owner", "mint">` | the associated token account of those parameters ([tokens](language-cpi.md#token-accounts-and-mints-as-parameters)) | 2009 |
| `TokenOf<…>`, `MintOf<…>` | a token account's mint, authority and token program; a mint's authorities | 2014–2017, 2021, 2022 |
| `constraint(acct, condition, error?)` | any condition, in the body's first statements | 2003, or your error |

- **Your own errors.** `HasOne<A, "owner", ErrorCode.NotOwner>`, `Address<A, "…", E.X>`, `Owner<A, "…", E.X>`,
  `Signed<A, E.X>` and `Mut<T, E.X>` fail with a member of one of the program's error enums instead of Anchor's code, as
  Anchor's `has_one = owner @ ErrorCode.NotOwner`, `address = … @ …`, `owner = … @ …`, `signer @ …` and `mut @ …` (the
  constraints Anchor lets you name an error for). For several `HasOne` fields with different errors, nest them:
  `HasOne<HasOne<Mut<V>, "owner", E.A>, "admin", E.B>`.
- **`constraint(acct, condition, error?)`** is Anchor's `constraint = condition @ error` on `acct`: statements at the
  very start of the body, run with that account's checks (after its `has_one`, before the next account; with the other
  constraints after the creates the body starts with), so a transaction breaking several checks gets Anchor's code.
  They read accounts and arguments. The default error is ConstraintRaw (2003).
- **`Owner` on a struct account**: `Owner<Account<T>, "…">` is another program's account (Anchor's `Account` /
  `AccountLoader` of a `declare_program!` type): loaded with that program as its owner (3007) and Anchor's
  discriminator for `T`'s name, its fields read and `HasOne` checked as for this program's own. The IDL lists `T`
  among its types, not its accounts (an error named on such an `Owner` is not used: the load fails with 3007). Such a
  struct may carry a shorter discriminator, `/** @discriminator 0x01 */` (1 to 8 bytes, as Anchor's
  `discriminator = &[1]`; Solend's reserve), its fields then starting right after it; this program's own accounts
  keep 8.
- `Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">` checks the address as Anchor's
  `address = sysvar::instructions::ID` on an `UncheckedAccount` does (2012, with the constraints).

## Optional accounts

```ts
import { type Account, type Mut, type Pubkey, type u64 } from "typesol";

export interface Bank {
  owner: Pubkey;
  total: u64;
}

export function deposit(bank: Mut<Bank>, referrer: Account<Bank> | null, amount: u64): void {
  bank.total += amount;
  if (referrer !== null) bank.total += referrer.total > 0n ? 1n : 0n;
  const bonus = referrer?.total ?? 0n;
  bank.total += bonus > 1000n ? 1n : 0n;
}
```

`A | null` or `Optional<A>` is Anchor's `Option<Account>`: the client passes this program's id to leave it out, and the
IDL marks it `optional`.

- Its checks and constraints run only when it is present. A `constraint(other, …)` that mentions it runs as written
  (`x === null` is checked when it is missing).
- Check `x !== null` before use, or assert it was passed with `x!` / `x!.field` (5115 when it was left out).
  `acct?.field` gives an Option (empty when the account was left out).
- Passed to `invoke` as it is (`readonly(x)` / `writable(x)` without `!`), it is left out of the CPI's list when it
  was not passed ([calling other programs](language-cpi.md#accounts)).

## Account groups

```ts
import { type HasOne, type Mut, type Pubkey, type Signer, type TokenAccount, type u64 } from "typesol";

export interface Pool {
  vault: Pubkey;
  reserve: u64;
}

export interface PoolAccounts {
  pool: HasOne<Mut<Pool>, "vault">;
  vault: Mut<TokenAccount>;
}

export function record(user: Signer, p: PoolAccounts, amount: u64): void {
  p.pool.reserve += amount;
}
```

Anchor's composite accounts (a `#[derive(Accounts)]` struct as a field of another): an exported interface whose fields
are accounts is one parameter, its accounts the instruction's in field order. The body uses `p.pool.reserve`, passes
`p.vault` to CPIs and helpers, and creates `p.pool.create(…)`.

- Constraints inside name the group's own fields first (`HasOne<…, "vault">`, `Seeds<…, ["pool", "@mint"]>`,
  `TokenOf<…, "mint", "pool">`), then the instruction's.
- The IDL nests them (`{ name: "p", accounts: [...] }`, seeds relative to the group); the client and `t.ix` flatten
  them (`pPool`, `pVault`).
- A field may be optional (`A | null`) or another group (`p.fees.vault`; the IDL nests it too, the client flattens it
  to `pFeesVault`). A group may not be optional or a helper parameter. Groups must be exported (`account groups must
  be exported: export interface …`).
- An instruction with a group checks in Anchor's order: its arguments first (102), then each account in order, a
  group's constraints right after the group's accounts (as a composite's `try_accounts` does), the other constraints
  last.

## ProgramData

`programData: ProgramData` is this program's ProgramData account: its address is derived from the program id, and the
upgradeable loader owner and state are checked. It exposes `upgradeAuthority` and `deploySlot`. Gate admin setup on
`programData.upgradeAuthority === admin.key`.

## Remaining accounts

```ts
import { type Mut, type RemainingAccount, type u64, remainingAccounts } from "typesol";

export interface Tally {
  sum: u64;
}

function weight(acct: RemainingAccount): u64 {
  return acct.isWritable ? acct.lamports : 0n;
}

export function count(tally: Mut<Tally>): void {
  const rest = remainingAccounts();
  for (let i = 0n; i < rest.length; i++) tally.sum += weight(rest.get(i));
}
```

`remainingAccounts()` gives the accounts passed after the declared ones, in order.

- `.length`, `.get(i)` (5104 past the end) → `key`, `owner`, `lamports` (writes check writability, 3006), `isSigner`,
  `isWritable`, the data length and data.
- `loadAccount<T>(acct)` / `loadAccountMut<T>(acct)` give checked struct views (owner, discriminator and size, as
  `Account<T>` / `Mut<T>`), also of an `AccountInfo` parameter (Anchor's `AccountLoader::try_from` on an
  `UncheckedAccount`). The view is also its account: `.key`, `.lamports`, and it passes to a helper taking `Account<T>`
  / `Mut<T>`. A second `loadAccountMut` of one account is refused (2040), but a view declared in a loop body ends with
  its iteration, and `loadAccountMut<Dup<T>>` in a loop also accepts an account passed more than once, one view at a
  time, as a route back through one pool needs.
- Pass one to a helper that takes a `RemainingAccount` parameter (it reads the key, owner, lamports, data length and
  data, and loads structs from it; a `loadAccountMut` there claims the account for the rest of the instruction, so a
  second one fails with 2040), or all of them to one that takes `RemainingAccounts` (`.length`, `.get(i)`, passed on to
  other helpers; spreading them into a CPI stays in the instruction).
- Pass them to `invoke`, one at a time or spread: `...remainingAccounts()` (each with the flags it was passed with),
  `...readonly(rest)` / `...writable(rest)` (all with that role), `rest.slice(a, b)` for part of them. A CPI lists at
  most as many accounts as an instruction takes (5113).
- Typed CPIs take remaining accounts too ([remaining accounts in
  CPIs](language-cpi.md#programs-and-sysvars-passed-as-remaining-accounts)).

## Other programs' accounts

- `const pool = loadForeign<Pool>(account, AMM_PROGRAM)` loads another Anchor program's account: owner, the
  `account:Pool` discriminator and size checked (3007 / 3002 / 3003).
- `readData<u64>(account, offset)` reads a raw little-endian value (bounds-checked, 3003).
- `writeData<u64>(account, offset, value)` writes one into a `Mut<AccountInfo>` of this program (bounds-checked, 3003):
  raw layouts such as Marginfi's monitor archive.
- Native programs' accounts without a discriminator (`loadRaw`, `loadBorsh`) are on the
  [native programs](language-native.md#accounts-without-a-discriminator) page.

## Account data layouts

By default an account struct is stored in a fixed layout: the 8-byte discriminator, then each field at a fixed offset
(each type's bytes are in [types](language-types.md)), with `Vec` fields after the fixed ones. Annotations change how a
struct is stored or how the IDL describes it.

### Anchor's account bytes: @layout borsh

`/** @layout borsh */` on an account struct stores it as Anchor does: Borsh, so a `FixedString<N>` is a String, a
`FixedVec<T, N>` or `Vec<T>` a Vec, an `Option` one byte when empty, and the fields after them move. A TypeSOL program
can then take over accounts an Anchor program wrote, and the IDL lists Anchor's own types.

```ts
import { type FixedString, type Mut, type Option, type u64 } from "typesol";

/** @layout borsh */
export interface Profile {
  name: FixedString<32>;
  score: Option<u64>;
  level: u64;
}

export function rename(profile: Mut<Profile>, name: string): void {
  profile.name = name;
  profile.level += 1n;
}
```

- The instruction unpacks the account into the usual fixed layout when it starts (bad bytes fail with 3003) and packs
  it back when it returns (3004 when the account is too small for the new value), so everything else works on it
  unchanged.
- A `Vec<T>` field (any position; integers, booleans, Pubkeys, unit enums or fixed-size structs) is Anchor's own: held
  on the heap while the instruction runs, growing as Rust's Vec does, bounded only by the account when it is written
  back (3004). Its elements move when it grows, so a reference into one cannot outlive a `push` or an assignment.
- `Init` of such a struct takes its space: `create(payer, seeds, space)`.
- Programs invoked from the body (CPIs) see the account's bytes as they were when the instruction started.
- It costs more compute than the fixed layout: the whole account is read and written each time (see the benchmarks).
- Nested structs and list elements must be fixed-size (FixedString elements allowed).
- The same struct is Borsh as a whole instruction argument (checked like Borsh deserialization, UTF-8 included), as
  return data and as an event. As those (not as account data) it may also hold `string` fields and data enums carrying
  strings, Anchor's `String` and enums in argument structs (account data takes data enums without strings). Not inside
  list or enum arguments or `loadAccount`, and a struct holding a `Vec<T>` is account data or a whole argument, not
  return data or an event.
- A struct holding a FixedVec cannot be both an argument and account data (its bytes differ there, and the IDL
  describes a type one way): declare one for each.

### Zero-copy types as Anchor's IDL describes them

`/** @repr c */` (`@repr c packed`, `@repr c align 8`, `@repr rust` on an enum) and `/** @serialization bytemuck */`
on a struct or enum put the IDL's `repr` and `serialization` there, as Anchor's `#[account(zero_copy)]` / `#[repr(C)]`
types have them.

- TypeSOL stores fields back to back, so an unpacked `@repr c` struct must have its fields where C puts them: a field
  off its alignment, or a size that is not a multiple of the struct's, is a compile error naming the padding to add
  (Anchor zero-copy types spell their padding out as `_pad` fields, so a port matches).
- A 16-byte integer's alignment differs between targets: hold it as `@bytes` (below) or mark the struct packed.
- A zero-copy (`@serialization bytemuck`) account is checked as Anchor's `AccountLoader` checks it: the owner first
  (3007, also for an account never created), then a discriminator to read (3001) and match (3002), then the size.

### Field names and bytes for the IDL

- `/** @bytes */` on an integer field: stored as the integer (little-endian), shown in the IDL as `[u8; N]`
  (Marginfi's `WrappedI80F48 { value: [u8; 16] }`, read and written as an `i128`). On a FixedArray of integers, each
  element as its bytes (`[[u8; 8]; 16]` for a `FixedArray<u64, 16>`).
- `/** @idlName _pad0 */`: the field's IDL name where the source cannot use it (a leading `_`).
- A field named like an account member plus `_` (`key_`, `lamports_`) is `key` / `lamports` in the IDL.
- `/** @discriminator account:Old */` (or `0x` and 8 bytes) replaces an account struct's discriminator.
- JSDoc on structs and fields becomes `docs` in the IDL.
