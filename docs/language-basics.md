# Language basics

This page explains what a TypeSOL program is: the file, its imports, its instructions and account data, and what the
compiler derives from them. It is the first page of the [language guide](language.md). It assumes you know
TypeScript; it does not assume you know Anchor or Rust, and [Solana in a dozen lines](#solana-in-a-dozen-lines)
introduces the chain's terms.

## A program is a TypeScript file

A TypeSOL program is a `.ts` file, the entry file, and the TypeSOL files it imports. The TypeScript compiler
type-checks it against `lib/typesol.d.ts` (the package's declarations), then TypeSOL checks that it stays inside the
language, lowers it to C and builds a Solana SBF program with clang. Nothing runs on chain but the compiled code: there
is no interpreter and no JavaScript runtime.

The file is made of:

| Top-level declaration | What it becomes |
| --- | --- |
| `export function name(…)` | an [instruction](#instructions): an entry point clients call |
| `export interface Name { … }` | a struct: [account data](#account-data), an argument, an event or a field of another struct |
| `export enum Name { … }` | a unit enum, or an error enum when its members are strings ([errors](language-errors-events.md)) |
| `export type Name = { kind: "A"; … } \| { kind: "B"; … }` | a data enum ([types](language-types.md#data-enums)) |
| `function name(…)` (not exported) | a [helper](language-statements.md#helpers), called by instructions and other helpers |
| `const NAME = …` | a compile-time [constant](#constants) |
| `type Name = …` | a [type alias](#type-aliases) |
| `interface Name { … }` (not exported) | a [file-local struct](language-types.md#file-local-structs), left out of the IDL |
| `import { … } from "typesol"` or `"./file"` | the language's built-ins, or another TypeSOL file |

Every other top-level statement is refused: `class`, `namespace`, `let` and `var`, and expressions with effects (see
[what is refused](language-statements.md#what-is-refused)).

## Solana in a dozen lines

What the rest of the guide assumes about the chain. Each term is in the [glossary](glossary.md); Solana's own
documentation is at [solana.com/docs/core](https://solana.com/docs/core).

- An [account](glossary.md#account) holds [lamports](glossary.md#lamports) (1 SOL is 10^9 of them) and bytes of
  data, and has an [owner](glossary.md#owner) program. Only the owner changes the data or takes lamports out; any
  program can add lamports to a writable account.
- A program is an account holding code. It keeps no state of its own: what it remembers is in accounts it owns, and
  the [checks on its parameters](language-accounts.md) make sure an account is one of them.
- Every account holds the [rent](glossary.md#rent)-exempt minimum for its size; closing it returns that
  ([limits and costs](#limits-and-costs)).
- A [transaction](glossary.md#transaction) holds [instructions](glossary.md#instruction). It lists every account they
  use, which are [writable](glossary.md#writable) and which [sign](glossary.md#signer); a program can reach no other
  account. If one instruction fails, the whole transaction fails.
- A [PDA](language-pdas.md) is an address derived from [seeds](glossary.md#seeds) and a program id, with a
  [bump](glossary.md#bump) byte; no key can sign for it but that program's own calls.
- One program calls another with a [CPI](language-cpi.md); the [System Program](glossary.md#system-program) creates
  accounts and moves SOL, and [sysvars](language-chain.md#sysvars) hold the clock and other cluster state.
- Work is metered in [compute units](glossary.md#compute-units), with a budget per transaction.
- A build writes an [IDL](glossary.md#idl), the JSON that clients encode calls from; arguments are
  [Borsh](glossary.md#borsh)-encoded, the program itself is [SBF](glossary.md#sbf) bytecode.

## A first program

A poll: anyone opens one at an address derived from their key and a number, anyone votes, and the creator ends it and
gets the number of votes back as the instruction's result.

```ts
import { type Account, type Init, type Mut, type Pubkey, type Signer, type SystemProgram, type u64, type u8, emit, require } from "typesol";

/** One poll: the votes for and against. */
export interface Poll {
  creator: Pubkey;
  /** Votes for yes. */
  yes: u64;
  no: u64;
  closed: boolean;
  bump: u8;
}

export interface Voted {
  poll: Pubkey;
  yes: boolean;
}

export enum PollError {
  Closed = "The poll is closed",
  NotCreator = "Only the creator can end the poll",
}

const SEED = "poll";

/** Open a poll at the address ["poll", creator, id]. */
export function open(creator: Mut<Signer>, poll: Init<Poll>, systemProgram: SystemProgram, id: u64): void {
  poll.bump = poll.create(creator, [SEED, creator.key, id]);
  poll.creator = creator.key;
}

export function vote(voter: Signer, poll: Mut<Poll>, yes: boolean): void {
  require(!poll.closed, PollError.Closed);
  if (yes) poll.yes += 1n;
  else poll.no += 1n;
  emit<Voted>({ poll: poll.key, yes });
}

export function end(creator: Signer, poll: Mut<Poll>): u64 {
  require(poll.creator === creator.key, PollError.NotCreator);
  poll.closed = true;
  return total(poll);
}

function total(poll: Account<Poll>): u64 {
  return poll.yes + poll.no;
}
```

Line by line:

- **The import.** Everything the program uses comes from `"typesol"`. Types (`u64`, `Mut`, `Signer`) are imported
  with `type`; functions (`require`, `emit`) without it. There is no other module to import from: no Node.js, no npm
  packages, no `console`.
- **`export interface Poll`.** An exported interface is a struct. Used as an account's type (`Init<Poll>`,
  `Mut<Poll>`), it is account data: an 8-byte discriminator, then the fields in order, 8 + 32 + 8 + 8 + 1 + 1 = 58
  bytes.
  The JSDoc comments become `docs` in the IDL.
- **`export interface Voted`.** Another struct; this one is only used by `emit<Voted>(…)`, so the IDL lists it under
  `events`.
- **`export enum PollError`.** An enum whose members are strings is an error enum. `PollError.Closed` is error 6000
  and `PollError.NotCreator` 6001, with these messages in the IDL, as Anchor's `#[error_code]`.
- **`const SEED = "poll"`.** A constant, inlined where it is used. Here it is a seed.
- **`open`.** An exported function is an instruction. Its parameters are the accounts the client passes (`creator`,
  `poll`, `systemProgram`) and the arguments it sends (`id`). Each account type says what is checked before the body
  runs: `Mut<Signer>` must sign and be writable, `Init<Poll>` must be writable and is created by the body,
  `SystemProgram` must be the System Program. `poll.create(creator, [SEED, creator.key, id])` derives the address
  from the seeds, checks that `poll` is that address, creates the account with `creator` paying the rent, writes the
  discriminator and returns the bump. The new account's fields start at zero.
- **`vote`.** `Mut<Poll>` is an existing account of this program holding a `Poll` (owner, discriminator and size
  checked), writable. `require(condition, error)` fails the instruction when the condition is false, and with it
  the whole transaction: nothing it wrote is kept. `poll.yes += 1n` is checked: an overflow fails the instruction too. Integer literals are bigints,
  written `1n`.
- **`end`.** Only the creator may end the poll: `require` compares the stored `creator` with the signer. It sets
  `closed`, so later votes fail with 6000, and returns the total. An instruction may return a value: the client reads
  it as return data, and the IDL lists it under `returns`. (The account stays open; `close(account, destination)`
  would delete it and return its rent: [closing and resizing](language-accounts.md#closing-and-resizing).)
- **`function total`.** A function that is not exported is a helper. It takes the account as `Account<Poll>`
  (read-only) and returns a `u64`. Helpers are not entry points and are not in the IDL.

The IDL the build writes describes all of this: three instructions with their accounts (with `poll`'s seeds under
`pda`, so clients derive its address), arguments and return type, the `Poll` account, the `Voted` event and the two
errors.

## Imports

```ts
import { type Mut, type u64, require, u8 } from "typesol";

export interface Gauge {
  level: u8;
}

export function set(gauge: Mut<Gauge>, value: u64): void {
  require(value <= 100n, "level is 0 to 100");
  gauge.level = u8(value);
}
```

- `"typesol"` is the language's library. Import types with `type`, and functions and constants without it.
- A cast is a function as well as a type: `u8(x)` converts, `x: u8` declares. Import `u8` without `type` when the
  code calls it; one import serves as both.
- `import { … } from "./math"` imports another TypeSOL file of the program ([multiple files](#multiple-files)).
- Nothing else can be imported: `only imports from "typesol" and relative TypeSOL files ("./math") are allowed`.
  Imports must be named imports (`use named imports: import { ... } from "typesol"`), not a default or namespace
  import. Names from `"typesol"` may be renamed (`import { log as say }`); names from TypeSOL files may not.

## Instructions

An exported function is an instruction. The client calls it by name; the program finds it by its discriminator.
`export default function bump(…)` is an instruction too, named `bump` like any other: the program has no default
entry point.

- **Discriminator.** The first 8 bytes of the instruction data: sha256("global:<name>")[..8], where `<name>` is the
  function's name in snake_case (`relayIncrement` is `global:relay_increment`), as Anchor computes it. Two functions
  whose names meet in snake_case are refused. `/** @discriminator … */` replaces it
  ([interfaces](language-cpi.md#implementing-another-programs-interface-transfer-hooks)).
- **Parameters.** Each parameter is an account (its type is an account type: `Signer`, `Account<T>`, `Mut<T>`, …,
  see [accounts](language-accounts.md)) or an argument (an integer, `boolean`, `Pubkey`, `string`, a struct, an enum,
  an `Option`, a list). The client passes the accounts in the order they are declared, and sends the arguments,
  Borsh-encoded, after the discriminator.
- **Body.** Before the first statement the accounts are checked and the arguments decoded: a transaction that fails a
  check never reaches your code ([which error a transaction gets](errors.md#which-error-a-transaction-gets)).
- **Result.** `void`, or one integer, `boolean`, `Pubkey`, `string` (a Borsh String) or fixed-size struct, sent as
  return data (at most 1024 bytes), listed as `returns` in the IDL and decoded by the generated client.
- **Failure.** There are no exceptions. A failed `require`, a failed account check, an overflow or a failed call to
  another program ends the instruction with an error code. The whole transaction fails: the runtime discards every
  change it made, in every one of its instructions.

Unlike TypeScript, an instruction cannot be `async` or a generator, and its parameters cannot be optional (`x?: u64`),
have defaults or be a rest parameter. An argument that may be absent is an `Option<T>` the client passes as `null`.

How a transaction reaches an instruction:

1. Instruction data shorter than 8 bytes fails with 100 (InstructionMissing).
2. The discriminator selects the instruction; an unknown one fails with 101 (InstructionFallbackNotFound), unless the
   program has a [`@fallback`](language-native.md#the-fallback-entry) entry.
3. The accounts are checked in parameter order, then the arguments are decoded (malformed or short data: 102,
   InstructionDidNotDeserialize), then the constraints run ([accounts](language-accounts.md)).
4. The body runs.

## Account data

An exported interface whose fields have a fixed size is a struct. As the type of an account parameter it is that
account's data:

```ts
import { type Mut, type Pubkey, type u64, type FixedArray } from "typesol";

export interface Point {
  x: u64;
  y: u64;
}

export interface Player {
  owner: Pubkey;
  home: Point;
  trail: FixedArray<Point, 4>;
}

export function move(player: Mut<Player>, x: u64, y: u64): void {
  player.home = { x, y };
}
```

- An account of this program starts with an 8-byte discriminator, sha256("account:<Name>")[..8] (Anchor's), then the
  fields in declaration order, back to back with no padding, integers little-endian. `Player` takes 8 + 32 + 16 +
  4 × 16 = 120 bytes.
- Interfaces nest: `home: Point`, `trail: FixedArray<Point, 4>`.
- Every field has a fixed size, except `Vec<T>` fields, which make the account grow
  ([Vec](language-types.md#vec)). Each type's size is in [types](language-types.md).
- Unlike TypeScript, fields cannot be optional (`v?: u64`): `optional fields are not supported; use v: Option<T> (null
  for none)`. Interfaces hold plain fields only; methods and getters are refused.
- What the IDL describes (account data, arguments, results, events, an exported struct's field, a data enum's
  variant) must be exported: a struct used there without `export` is an error saying to export it.

Anchor programs store the same bytes as long as the struct has only fixed-size types. Borsh strings, vectors and options
in account data (Anchor's default) need [`@layout borsh`](language-accounts.md#anchors-account-bytes-layout-borsh).

## Helpers

A function that is not exported is a helper: it can be called from instructions and other helpers, is not an entry
point and is not in the IDL. Every function of an imported file is a helper too. Helpers take values, structs, lists
and accounts the instruction has already checked, and return a value or `void`. They need an explicit return type
and cannot call themselves. See [functions and helpers](language-statements.md#helpers).

## Constants

```ts
import { type Mut, type u16, type u64, log } from "typesol";

const SEED = "vault";
const FEE_BPS: u16 = 30n;
const ROOM = 1280n - 34n;
const ON = true;

export interface Config {
  fee: u16;
  room: u64;
}

export function setup(config: Mut<Config>): void {
  config.fee = FEE_BPS;
  config.room = ROOM;
  if (ON) log(SEED);
}
```

- A top-level `const` is a compile-time constant: a bigint, boolean or string literal, `pubkey("…")` (a base58
  address, checked when the program compiles), or an integer expression over literals and constants declared before
  it, in this file or an imported one (`+ - * / % ** & | ^ << >>`, unary `-` and `~`).
- Constants are inlined where they are used, and may be seeds; when a seed is a constant, the IDL records its value.
- A constant with an integer type is computed in that type, every step checked: `const X: u64 = 1n - 2n + 5n` is an
  error (`1n - 2n is -1, which does not fit in u64`), and `const M: u8 = ~1n` is 254 (`~` within the width).
  Division by zero, a negative exponent or a shift past the width are compile errors.
- An untyped integer constant is inlined as its value and takes the type of the place it is used in, as a literal
  does: `const FEE = 30n` stores into a `u16` field, and `const FEE = 300n` into a `u8` one is `300 does not fit in u8`.
- Top-level `let` and `var` are refused: `top-level variables must be const literals`. A program has no global state
  other than its accounts.
- A few names configure the compiler: `HEAP_SIZE_KIB` ([below](#memory-stack-and-heap)), `MAX_ACCOUNTS`
  ([accounts](language-accounts.md#how-many-accounts)), `NATIVE_ACCOUNT_WRITES`, `PANIC_ON_OVERFLOW`, `PANIC_STYLE`,
  `ERROR_LOG_PREFIX`, `PROGRAM_ERROR_LOG_PREFIX` ([native programs](language-native.md)).

## Type aliases

```ts
import { type FixedVec, type Mut, type Pubkey, type u64, type u8 } from "typesol";

type Price = u64;
type Key = Pubkey;
type Buf = FixedVec<u8, 32>;
type Ask = Price;

export interface Book {
  best: Ask;
  maker: Key;
  memo: Buf;
}

export function quote(book: Mut<Book>, price: Price): void {
  book.best = price;
}
```

A type alias is another name for one type, replaced by it wherever it is used: layouts, arguments and the IDL see the
aliased type. Aliases can be exported or not, imported like any name, and name other aliases (the aliased type keeps
the names of the file declaring it). They cannot be generic (`type aliases cannot be generic`). A union of named
types (`type Event = Fill | Place`) is neither an alias nor a data enum: write the variants as object types
([data enums](language-types.md#data-enums)).

## Multiple files

```ts file=math.ts
import { type u64 } from "typesol";

export const BPS = 10000n;

export function fee(amount: u64, bps: u64): u64 {
  return (amount * bps) / BPS;
}
```

```ts
import { type Mut, type u64 } from "typesol";
import { fee } from "./math";

export interface Vault {
  fees: u64;
}

export function charge(vault: Mut<Vault>, amount: u64): void {
  vault.fees += fee(amount, 30n);
}
```

- Structs, enums, constants and helpers can live in other files. Only the entry file's exported functions are
  instructions; every function of an imported file is a helper.
- Names are program-wide, so imports from TypeSOL files cannot be renamed (`import { a as b }` is refused).
- Error codes number the imported files' error enums first.

## What the compiler derives

From the source alone, a build writes:

- `<name>.so`: the program.
- `<name>.json`: an Anchor IDL (spec 0.1.0). It lists every instruction (name, discriminator, accounts with their
  `writable` / `signer` flags, `pda` seeds and fixed `address`es, `optional` accounts, `relations`, arguments,
  `returns`), every account struct, type, event and error, and the JSDoc of instructions, `@param` tags, structs,
  fields and data enums as `docs`. Anchor and Codama clients read it unchanged.
- `<name>.client.ts`: a typed client ([client.md](client.md)).
- `<name>.c` and `<name>.build.json`: the generated C and the build's record ([cli.md](cli.md)).

## Memory: stack and heap

A program runs with a 4 KiB stack frame per function and a heap of 32 KiB. Locals live on the stack: a list local
holds at most 2 KiB, and a frame that overflows is a compile error that names its biggest locals. Strings built at run
time and a few other values live on the heap ([heap values](language-types.md#heap-values)), which is never freed
during an instruction.

`const HEAP_SIZE_KIB = 64n` (32 to 256) lets the program use a bigger heap; the client must then add a ComputeBudget
`requestHeapFrame` instruction with that size to the transaction.

## Limits and costs

The cluster sets these; the numbers are those at the time of writing.

- **Rent.** An account holds the rent-exempt minimum for its size, (128 + data bytes) × 6,960 lamports: 1,294,560
  lamports (about 0.0013 SOL) for the 58-byte poll above. `create` takes it from the payer, `rentExempt(space)` computes
  it in the program, and `close(account, destination)` moves every lamport, the rent included, to `destination`.
- **Compute.** A transaction gets 200,000 compute units per instruction by default and at most 1,400,000, which the
  client asks for with a ComputeBudget `SetComputeUnitLimit` instruction; past its budget the transaction fails. To
  see where a program spends them, build with `typesol build --profile` and pass the transaction's logs to `typesol
  profile` ([cli.md](cli.md)), which gives compute units per TypeScript line.
- **Transaction size.** At most 1,232 bytes: signatures, every account's 32-byte address and the instruction data.
  It bounds how many accounts and how many bytes of arguments one transaction can carry.
- **Account size.** At most 10 MiB. `create` allocates at most 10 KiB, and an account grows by at most 10 KiB per
  instruction (3016): grow a larger one over several instructions.
- **Accounts.** At most 32 per instruction, unless the program raises it with
  [`MAX_ACCOUNTS`](language-accounts.md#how-many-accounts) (5113).

## Next

- [Types](language-types.md): integers, strings, enums, structs, options and lists.
- [Statements and functions](language-statements.md): which TypeScript is TypeSOL.
- [Accounts](language-accounts.md): account parameters and the checks they emit.
- A complete program that moves tokens: [`examples/escrow.ts`](https://github.com/typesol-lang/typesol/blob/main/examples/escrow.ts), which `typesol init my-app
  --template escrow` scaffolds with its tests ([tokens](language-cpi.md#tokens)).
