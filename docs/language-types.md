# Types

Every value in a TypeSOL program has a type whose layout is known when the program compiles: a fixed size for most,
a length followed by its elements or bytes for `string` and `Vec` (see the table). This page goes
through them: what each one is, how to write it, its bytes in account data and in instruction arguments, its limits,
and the error code when a limit is hit at run time. Part of the [language guide](language.md).

| Type | In account data | As an argument (Borsh) |
| --- | --- | --- |
| `u8` `u16` `u32` `u64` `u128`, `i8` … `i128` | 1, 2, 4, 8, 16 bytes, little-endian | the same |
| `u256` | not allowed | not allowed |
| `boolean` | 1 byte, 0 or 1 | the same, checked (102) |
| `Pubkey`, `Hash` | 32 bytes | the same |
| `string` | not allowed: use `FixedString<N>` | u32 length + UTF-8 bytes |
| `FixedString<N>` | u32 length + N bytes | not a parameter type (take a `string`); in a struct argument, a Borsh String of at most N bytes (102 when longer) |
| unit `enum` | 1 byte, the variant's index | the same, checked (102) |
| data enum | 1 tag byte + the largest variant | a Borsh enum: the tag, then the variant |
| struct (`interface`) | its fields back to back | the same |
| `Option<T>` | 1 byte + size(T), always | 1 byte when empty, else 1 + T |
| `FixedArray<T, N>` | N × size(T) | the same |
| `FixedVec<T, N>` | u32 length + N × size(T), always | a Borsh Vec of at most N elements |
| `Vec<T>` | u32 length + elements, stored after the fixed fields; the account grows | a Borsh Vec, read in place |

## Integers

```ts
import { type Mut, type i64, type u8, type u64 } from "typesol";

export interface Stats {
  count: u64;
  delta: i64;
  level: u8;
}

export function record(stats: Mut<Stats>, by: u64, change: i64): void {
  stats.count += by;
  stats.delta = stats.delta + change;
  stats.level = 3n;
}
```

- The types are `u8`, `u16`, `u32`, `u64`, `u128` (unsigned) and `i8`, `i16`, `i32`, `i64`, `i128` (two's
  complement). To TypeScript they are all `bigint`; TypeSOL tracks the declared width.
- **Literals are bigints**: `1n`, `0n`, `-5n`. Unlike JavaScript, there are no `number`s: `1` is refused
  (`Type 'number' is not assignable to type 'bigint'`, with a hint to write `1n`), and so are `number` parameters and
  fields. A literal takes the type of the place it is used in and must fit there (`300 does not fit in u8`). A local
  declared from a bare literal, `const x = 5n`, is a `u64`; an untyped top-level constant takes the type of each place
  it is used in, as a literal does ([constants](language-basics.md#constants)).
- **Both operands have one type.** `a + b` with a `u64` and a `u8` is refused: `operands have different types: u64 and
  u8; convert with u64(...) etc.` Comparisons (`<`, `<=`, `===`, …) need equal types too.
- **Every operation is checked.** `+ - * / % **` and their assignments (`+=` … `**=`) fail the instruction on
  overflow (5100) or division by zero (5101); `**` with a negative exponent fails as well (JavaScript throws there).
  Unlike JavaScript there are no silent wraps and no `Infinity`.
- **Bitwise operators.** `& | ^` work on equal types; `~` flips the bits within the type's width (`~1n` as a `u8` is
  254). Both shifts fail (5100) when the amount is negative or not below the width (`x >> 64n` on a `u64`), and `<<`
  also when bits would be lost; `>>` is arithmetic on signed types. Unlike JavaScript, where a bigint shift never
  fails, `1n << 64n` is not a bigger number and `x >> 200n` is not 0. The shift amount, also in `<<=` and `>>=`, may be
  any integer type up to `u128`.
- `++` and `--` are checked like `+= 1n`. Unary `-` needs a signed type (`unary minus needs a signed integer (i8 …
  i128)`).

`const PANIC_ON_OVERFLOW = true` makes overflow and division by zero panic as Rust's `checked_*().unwrap()` does,
instead of failing with 5100 / 5101 ([native
programs](language-native.md#errors-and-panics-as-the-original-reports-them)).

### Casts

```ts
import { type Mut, type u64, u8, i64 } from "typesol";

export interface Small {
  level: u8;
  delta: i64;
}

export function store(small: Mut<Small>, value: u64): void {
  small.level = u8(value);
  small.delta = i64(value);
}
```

- `u8(x)`, `u16(x)`, … `i128(x)` convert an integer to another width. They fail with 4102 (InvalidNumericConversion)
  when the value does not fit: `u8(300n)` and `u64(-1n)` fail, they never truncate.
- A cast is a value as well as a type: import `u8`, not `type u8`, and the one import serves for both uses (importing
  both is a duplicate identifier).
- `as` does not convert. `x as u64` with `x: u8` is refused: `this is a u8, not a u64: \`as\` does not convert (use
  u64(x) and the like for integers)`. In generic helpers `as T` names a type the value already has.

### Integer helpers

| Function | What it computes |
| --- | --- |
| `mulDiv(a, b, c)` | `a * b / c` rounded down, without overflow in the product: u64 through a 128-bit product, u128 through a 256-bit one, u256 through a 512-bit one. Fails with 5101 when `c` is zero and 5100 when the result does not fit |
| `mulDivCeil(a, b, c)` | the same, rounded up |
| `isqrt(x)` | the integer square root of an unsigned integer (`u8` … `u256`) |
| `min(a, b)`, `max(a, b)` | the smaller or larger of two integers of one type |

`Math` is not available (`Math works on numbers; use min(a, b) and max(a, b) from "typesol", which take bigints`), nor
`BigInt(…)` (`unsupported call: BigInt; use u64(x) or another integer cast`).

### u256

```ts
import { type Mut, u128, u256 } from "typesol";

export interface Pool {
  liquidity: u128;
}

export function scale(pool: Mut<Pool>, a: u128, b: u128): void {
  const product = u256(a) * u256(b);
  pool.liquidity = u128(product >> 64n);
}
```

`u256` is for computation (sqrt-price and liquidity math): locals, helper parameters and results, with the same checked
operators and comparisons, `min` / `max`, `mulDiv`, `isqrt`, `switch`, and as a list index (5104 past u64).

- `u256(x)` converts from any integer (a negative one fails with 4102); `u128(x)` and `u64(x)` convert back (4102
  when it does not fit).
- A shift amount or an exponent is a `u128` or smaller (`a shift amount is a u128 or smaller integer`; `the exponent of
  ** is a u128 or smaller integer`).
- Never in account data, arguments, events, return data or CPI data: the IDL has no 256-bit integer (`A.v: u256 is for
  computation; store a u128 (or two u128s)`).
- `log(x)` prints it only when it fits in 128 bits; a larger value fails with 5100.

## Booleans

`boolean`, with `true` and `false`, `&&`, `||`, `!`, `===` and `!==`. One byte in account data and arguments; an
argument byte other than 0 or 1 fails with 102. Unlike JavaScript there is no truthiness: a condition must be a
`boolean`, so `if (count)` with an integer is refused (`expected boolean, got u64`); write `if (count > 0n)`.

## Pubkey and Hash

```ts
import { type Account, type Pubkey, type Signer, pubkey, require } from "typesol";

const ADMIN = pubkey("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T");

export interface Config {
  owner: Pubkey;
}

export function check(config: Account<Config>, caller: Signer): void {
  require(config.owner === caller.key || caller.key.equals(ADMIN), "not allowed");
  require(config.owner.compare(ADMIN) !== 0n, "owner is the admin");
}
```

- `Pubkey` is a 32-byte address. Compare with `===`, `!==` or `.equals(other)`; `<` and `>` are refused (`< needs
  integer operands`): `a.compare(b)` orders two keys as Rust orders their bytes (-1, 0 or 1).
- `pubkey("…")` is a constant address, checked as base58 when the program compiles, at the top level or inline.
- `Hash` is 32 bytes too: what `sha256` and `keccak256` return ([hashing](language-chain.md#hashing)), with `===` and
  `.compare`.
- In a template string or `log`, a `Pubkey` or `Hash` prints as base58.

## Strings

```ts
import { type FixedString, type Mut, byteLength, log, require } from "typesol";

export interface Profile {
  name: FixedString<32>;
}

export function rename(profile: Mut<Profile>, name: string): void {
  require(byteLength(name) <= 32n, "name too long");
  profile.name = name;
  if (profile.name === "admin") log("renamed to admin");
  profile.name += "!";
}
```

- **`string`** is an argument or literal: a Borsh String (u32 length, then UTF-8 bytes) in arguments, checked as UTF-8
  on entry (102). It cannot be account data (`A has a variable-length string field and cannot be account data; use
  FixedString<N>`).
- **`FixedString<N>`** is a string field with room for N bytes, N from 1 to 10240: a u32 length then N bytes, always
  4 + N bytes. Assigning a longer string fails with 5105.
- What strings support: `===` and `!==`, `byteLength(s)` (UTF-8 bytes, a `u64`), `log(s)`, `+=` on a `FixedString`
  field, and use as a PDA seed (its bytes). A local bound to account text keeps its own copy.
- Unlike JavaScript, `.length` is refused (it would be a JS number of UTF-16 units: `use byteLength(s) for strings`),
  and so are indexing and string methods (`s.slice`, `s.charAt`, …).

### Strings built at run time

```ts
import { type Pubkey, type u64, type Option, log } from "typesol";

export function report(owner: Pubkey, amount: u64, limit: Option<u64>): void {
  const line = `owner ${owner} paid ${amount}, limit ${limit}`;
  log(line);
  let tag = "id-";
  tag += "7";
  log("tag " + tag);
}
```

`"a" + name`, `` `#${n}` `` and `s += …` build strings on the heap (32 KiB; 5110 when full). In a template, a `Pubkey`
or `Hash` prints as base58 and an `Option` of an integer, boolean, `Pubkey` or `Hash` as its value or `null`, as
JavaScript prints it (after `x !== null`, the value). A template is joined in one allocation; text known when the
program compiles (literals, string and `Pubkey` constants) is folded in; `s += …` grows the newest heap string in
place. Tagged templates (`` String.raw`…` ``) are refused.

## Enums

```ts
import { type Mut, type u64 } from "typesol";

export enum Status {
  Pending,
  Approved,
  Rejected,
}

export interface Request {
  status: Status;
  amount: u64;
}

export function approve(request: Mut<Request>): void {
  if (request.status === Status.Pending) request.status = Status.Approved;
}
```

- A unit enum's members are numbered 0, 1, 2… in order; initializers are refused (`value enum members are numbered 0,
  1, 2… in order; leave out initializers`). Stored as one byte, the Borsh u8 index; an argument byte past the last
  member fails with 102.
- Compare with `===` / `!==`, or `switch`. An enum is not an integer: `u8(status)` is a type error.
- An enum whose members are strings is an error enum ([errors](language-errors-events.md#error-enums)).

## Data enums

```ts
import { type Mut, type u64 } from "typesol";

export type Action = { kind: "Deposit"; amount: u64 } | { kind: "Withdraw"; amount: u64 } | { kind: "Pause" };

export interface Vault {
  balance: u64;
  paused: boolean;
  last: Action;
}

export function apply(vault: Mut<Vault>, action: Action): void {
  switch (action.kind) {
    case "Deposit":
      vault.balance += action.amount;
      break;
    case "Withdraw":
      vault.balance -= action.amount;
      break;
    case "Pause":
      vault.paused = true;
  }
  vault.last = action;
}
```

- A data enum is a union of object types, each with a `kind` string literal: Rust's enum with fields, Borsh-encoded as
  Anchor encodes one. `a.kind === "Deposit"` or `switch (a.kind)`, and TypeScript narrowing picks the variant.
- Reading a variant's field is checked again at run time: when the value is not that variant, 5112.
- In account data: 1 tag byte then room for the largest variant. In arguments and events: the tag, then that
  variant's fields.
- A variant may hold a `string` (`{ kind: "Say"; text: string }`): such an enum works in arguments, events and
  locals, but not in account data.
- Write a variant as a literal: `vault.last = { kind: "Pause" }`.
- A union of named types (`type Event = Fill | Place`) is not a data enum: write the variants as object types.

## Structs

```ts
import { type Mut, type u64 } from "typesol";

export interface Point {
  x: u64;
  y: u64;
}

export interface Player {
  home: Point;
  score: u64;
}

function moved(p: Point, dx: u64): Point {
  return { x: p.x + dx, y: p.y };
}

export function step(player: Mut<Player>, dx: u64): void {
  const next: Point = moved(player.home, dx);
  next.y += 1n;
  player.home = next;
}
```

- An `interface` with fixed-size fields is a struct; exported ones are in the IDL. Fields are stored in declaration
  order, back to back, with no padding.
- A struct literal names every field (`{ x, y: 2n }`); a missing or unknown field is an error. An object literal needs
  a known struct type: a typed local (`const p: Point = { … }`), a field, a helper parameter, `emit<T>(…)`.
- `a.home = b.home` copies the whole struct, as Rust and Anchor do; how `const` binds one is in
  [copies and references](language-statements.md#copies-and-references).
- A struct cannot contain itself.

### File-local structs

`interface Pair { a: u64; b: u64 }` without `export` is the file's own struct, for its helpers (parameters, results,
`Inout<Pair>`), locals and other such structs; it is left out of the IDL. What the IDL describes (account data,
instruction arguments and results, events, an exported struct's field, a data enum's variant) cannot hold one: each
such use is an error saying to export it.

## Option

```ts
import { type Mut, type Option, type u64 } from "typesol";

export interface Auction {
  best: Option<u64>;
  floor: u64;
}

export function bid(auction: Mut<Auction>, amount: u64, cap: Option<u64>): void {
  if (auction.best === null || amount > auction.best) auction.best = amount;
  const limit = cap ?? auction.floor;
  if (amount > limit) auction.best = null;
  auction.floor = auction.best!;
}
```

- `Option<T>` (or `T | null`) is a value or `null`. Compare with `=== null` / `!== null`; TypeScript narrows it.
- Using an empty option where a value is needed fails with 5108; `x!` is the value, or 5108.
- `a ?? b` takes `b` only when `a` is empty, and evaluates `b` only then; the result is an Option when `b` can be null.
- `===` between options, or with a value, follows JavaScript: `null === null`, and an empty option never equals a
  value.
- `x.home?.field` on an `Option<struct>` gives an Option (empty when the option is). `?.` on anything else is refused:
  `?. works on optional accounts and Option<struct> values (other values are never null)`.
- **Bytes.** In account data: always 1 + size(T) bytes, `{ is_some, value }`. In arguments and events: Borsh, one
  byte when empty.
- `Option<Point>` in account data: `=== null`, `p.home.x` after narrowing, `p.home = null` or `= { x, y }`. Once
  narrowed, `p.home` (or an `Option<FixedArray>`) passes to a helper that takes the struct (or array).
- `Option<FixedArray<T, N>>` fields (Anchor's `Option<[u16; 3]>`): one tag byte then N elements in fixed layouts,
  Borsh in arguments and events.

## Lists

There are three list types. All of them have `.length` (a `u64`), `get(i)` and `set(i, v)` with bounds checks (5104),
`for … of`, and the [list methods](#list-methods). Unlike JavaScript arrays, indexing with `[ ]` is refused (`indexing
with [ ] is not supported: use .get(i) and .set(i, value), with i a bigint (0n)`), and indexes are bigints.

| | Size | Grows | Where |
| --- | --- | --- | --- |
| `FixedArray<T, N>` | N elements, always | no | account data, arguments, locals |
| `FixedVec<T, N>` | u32 length + room for N | up to N | account data, arguments, locals, events, return data |
| `Vec<T>` | u32 length + its elements | the account is resized | account data, arguments (read-only), events |

Which one to use in account data:

- **`FixedArray<T, N>`** when there are always N elements (a board, a fixed set of slots). The account's rent covers
  all N from creation.
- **`FixedVec<T, N>`** when the count varies up to a known maximum (owners of a multisig, at most N). The account is
  created at its full size, so its creator pays the rent for N elements up front and nothing grows later; a `push`
  past N fails with 5104. It also works in locals, nested structs and return data.
- **`Vec<T>`** when the count has no useful maximum. The account starts small and each `push(v, payer)` resizes it,
  `payer` paying the extra rent, so the instruction needs a `SystemProgram`; it grows at most 10 KiB per instruction
  (3016) and 10 MiB in all. A struct with a `Vec` is account data only, not a local or a nested struct.

### FixedArray

```ts
import { type FixedArray, type Mut, type u64, fixedArray } from "typesol";

export interface Board {
  scores: FixedArray<u64, 8>;
  best: u64;
}

export function submit(board: Mut<Board>, slot: u64, score: u64): void {
  board.scores.set(slot, score);
  for (const s of board.scores) if (s > board.best) board.best = s;
  const recent = fixedArray<u64, 4>(0n);
  recent.set(0n, score);
  board.best += recent.get(0n) - score;
}
```

- `FixedArray<T, N>` has N elements, N a literal from 1 to 1000000; elements can be integers, booleans, Pubkeys,
  enums, `FixedString<N>` or structs of fixed size. In account data it is N × size(T) bytes.
- `fixedArray<T, N>(fill)` makes a local array on the stack, up to 256 elements (`fixedArray<T, N>: N must be a literal
  1..256 (locals live on the 4KB stack)`), filled with `fill`. Elements may be structs (the fill built once and copied
  into each slot) or `FixedString<N>`. It may be a struct literal's field value (`{ prices: fixedArray<u64, 16>(0n),
  … }`), filled in place, and written inline it feeds a chain, a list method or `for … of`
  (`fixedArray<u64, 3>(2n).map((x) => x * 5n).reduce(…)`).

### FixedVec

```ts
import { type FixedVec, type Mut, type Pubkey, fixedVec, require } from "typesol";

export interface Multisig {
  owners: FixedVec<Pubkey, 8>;
}

export function setOwners(ms: Mut<Multisig>, owners: FixedVec<Pubkey, 8>): void {
  ms.owners = owners;
}

export function addOwner(ms: Mut<Multisig>, owner: Pubkey): void {
  require(!ms.owners.includes(owner), "already an owner");
  ms.owners.push(owner);
}

export function reset(ms: Mut<Multisig>, first: Pubkey): void {
  ms.owners = fixedVec([first]);
  const scratch: FixedVec<Pubkey, 8> = fixedVec([]);
  scratch.pushAll(ms.owners);
  scratch.pop();
}
```

- `FixedVec<T, N>` is a list with room for N elements: a u32 length and the room, always 4 + N × size(T) bytes. Any
  field, any number of them, nested structs too. Elements as for FixedArray.
- `get`, `set`, `push(v)`, `pop()`, `clear()`, `.length`, `for … of`. `push` on a full one fails with 5104.
- `xs.pushAll(items)` appends a whole list of the same elements in one copy: another FixedVec, a FixedArray or Vec, a
  Vec argument, the instruction data or a slice of it. It is a memcpy (about 0.01 CU a byte for 1000 bytes, against 11
  for a `push` loop), and fails with 5104, appending nothing, when it does not fit. (`Vec` declares `pushAll` so a Vec
  passes for a FixedVec, but a Vec grows one `push` at a time.)
- `acct.owners = fixedVec([a, b])` writes a whole one (the unused slots zeroed); `acct.owners = owners` copies a `Vec`
  argument or another list of the same elements into it, as Anchor's `multisig.owners = owners` (more than N: 5104).
- As an argument, `ids: FixedVec<u64, 8>` is a Borsh Vec of at most N elements, read like a `Vec` argument (more fail
  with 102).
- In account data, returned structs and events it has its fixed layout.
- **Local lists.** A FixedVec or FixedArray of integers, booleans, Pubkeys, enums, `FixedString<N>` or fixed-size
  structs can be a local, on the stack: `const metas: FixedVec<Meta, 4> = fixedVec([{ pubkey: k, isSigner: false,
  isWritable: false }])`, `const buf: FixedVec<u8, 600> = fixedVec([])`, `const pair: FixedArray<Meta, 2> =
  fixedArray(meta)`.
  - Given another list (`const y: FixedVec<Pubkey, 4> = xs`) it is a copy, as a struct local is.
  - Setting one up costs about the same at any size: `fixedVec([])` of 1280 bytes is about 10 CU (the free slots are
    zeroed by the memset syscall, the elements written in place, also as a struct literal's field).
- **Size limit.** One list holds at most 2 KiB of elements (the FixedVec's u32 length aside: `FixedVec<u32, 512>`
  fits). The 4 KiB stack frame is shared with the rest of the function, and a frame that overflows is reported with
  its biggest locals; a bigger list is a compile error naming its size. [`@heap`](#heap-values) moves one to the heap.
- A `FixedVec<u8, N>` is also a byte buffer: `pushLE`, `pushKey`, `pushBorsh`, `setLE`, `truncate`
  ([byte builders](language-native.md#byte-strings-built-by-hand)).

### Vec

```ts
import { type Mut, type Pubkey, type Signer, type SystemProgram, type u64, type Vec } from "typesol";

export interface Entry {
  who: Pubkey;
  amount: u64;
}

export interface Book {
  total: u64;
  entries: Vec<Entry>;
}

export function add(payer: Mut<Signer>, book: Mut<Book>, systemProgram: SystemProgram, amount: u64): void {
  book.entries.push({ who: payer.key, amount }, payer);
  book.total += amount;
}

export function sum(book: Mut<Book>, amounts: Vec<u64>): void {
  for (const a of amounts) book.total += a;
}
```

- **In account data**, `entries: Vec<Entry>` holds any number of elements. An account may have any number of Vecs,
  declared anywhere: they are stored after the fixed-size fields, in the order declared, so every other field keeps
  its offset (the IDL lists that order).
- `get`, `set`, `push(v, payer)`, `pop()`, `clear()`, `.length`. `push` resizes the account (realloc) and `payer` tops
  up the rent, so the instruction needs a `SystemProgram` parameter (`instructions that grow a Vec (push) need a
  SystemProgram parameter to top up rent`). An account grows at most 10 KiB per instruction (3016). `pop()` of a Vec
  of structs works as a statement.
- A push, pop or clear moves the Vecs stored after it. A reference into one of those cannot be used across it (a
  compile error), also when the reference was made through another parameter that may be the same account: a
  `Dup<…>` pair, a read-only and a writable account of one type, a struct loaded with `loadAccount` /
  `loadAccountMut`.
- A `Vec` is not a local type (`local type must be an integer, boolean, Pubkey, enum, option or string`): use a
  FixedVec.
- **As an argument**, `amounts: Vec<u64>` is a read-only view of the instruction data (`Vec arguments are read-only`).
  `Vec<string>` arguments (Anchor's `Vec<String>`) are views too, each element checked as UTF-8 on entry (102), and go
  back out as Borsh through `invoke`.
- In a `@layout borsh` struct a Vec is Anchor's: anywhere among the fields, held on the heap while the instruction runs
  ([`@layout borsh`](language-accounts.md#anchors-account-bytes-layout-borsh)).
- A struct with a Vec is account data only, never nested in another struct (`Inner has a growable Vec and can only be
  account data, not nested`); nest a FixedVec.

### List methods

On a `Vec`, `FixedArray`, `FixedVec` or `Vec` argument:

```ts
import { type FixedArray, type FixedVec, type Mut, type u64, type i64 } from "typesol";

export interface Orders {
  qty: FixedArray<u64, 8>;
  total: u64;
  firstBig: i64;
}

export function summarize(o: Mut<Orders>): void {
  o.total = o.qty.filter((q) => q > 0n).map((q) => q * 2n).reduce((s, q) => s + q, 0n);
  o.firstBig = o.qty.findIndex((q) => q > 100n);
  if (o.qty.some((q) => q === 0n)) o.total += 1n;
  const big: FixedVec<u64, 8> = o.qty.filter((q) => q > 10n);
  o.total += big.length;
}
```

- `forEach`, `some`, `every`, `find`, `findIndex` (an `i64`, -1 when absent), `reduce(fn, initial)`, `includes(value)`,
  `indexOf(value)` (an `i64`), `map` and `filter`.
- `find` gives an Option of the element, for scalar elements. On struct elements read a field: `xs.find(f)!.qty`
  (5108 when nothing matched) or `xs.find(f)?.qty` (an Option).
- The arrow written at the call is expanded into a loop (elements as `list.get(i)` gives them, structs by reference)
  and may read and write the function's variables.
- A `map` / `filter` chain used right away (`xs.filter(f).map(g).reduce(h, 0n)`, `.length`, `for … of`) is one loop
  that stores nothing; callbacks after a filter get the index among the elements it let through.
- Stored (`const ys = xs.filter(f)`), it is a FixedVec on the stack as big as the list it starts from. From a `Vec`,
  give the size: `const ys: FixedVec<u64, 16> = …` (at most 2 KiB; one element more aborts with 5104).
- `map` gives integers, booleans, Pubkeys or enums. Stored with a `FixedVec<Struct, N>` or `FixedVec<FixedString<N>, M>`
  annotation it gives structs (`(o) => ({ qty: o.qty })`) or text, and inside a chain it gives structs when the
  callback names its struct: `xs.map((o): Scored => ({ … })).filter(…).reduce(…)` (one struct per element, nothing
  stored). A fused `map` to strings is not supported: store it, annotated.

## Struct arguments

Advanced: what an Anchor port meets when its instructions take structs, lists and Options as arguments.

`order: Order`, `ids: FixedArray<u8, 4>`, `orders: Vec<Order>` as instruction arguments are fixed layouts,
Borsh-identical, validated on entry (booleans, enum tags, option tags, string lengths: 102) and read-only.

- A struct holding a `FixedVec` that is only ever an argument is read as Anchor sends it (its FixedVec a Borsh Vec, as
  under [`@layout borsh`](language-accounts.md#anchors-account-bytes-layout-borsh)).
- A struct holding `Option`s (at any depth, as Anchor's `BankConfigOpt`) that is not account data is Borsh on the wire,
  an empty Option one byte. Read its values after narrowing (`if (c.rate !== null && c.rate.zero_util !== null) …`),
  an `Option<FixedArray<T, N>>` too (`.get(i)`, or copied whole into a `FixedArray` field).
- An argument may be an `Option<S>` of such a struct (Anchor's `Option<WrappedI80F48>`): a tag byte, then the struct
  when present; read its fields after `x !== null`. Helpers take the struct, not the Option.
- Likewise `Option<Vec<T>>` (or `Vec<T> | null`, or of a FixedVec; Anchor's `Option<Vec<u8>>`): a tag byte, then the
  Vec. Check `x !== null` before reading it as a list or passing it to a helper that takes the list.
- A `Vec<u8>` is `bytes` in the IDL, as Anchor writes it (clients pass a Buffer).

## f64

Advanced: for ports whose events or accounts carry a float. `f64` holds a 64-bit float as its IEEE bits, for events and accounts that carry one (Borsh writes those 8 bytes; the
IDL says `f64`). There is no float arithmetic: `f64FromBits(bits)` makes one from bits the program computed with
integers (Marginfi's events report I80F48 amounts this way), and `f64Bits(x)` reads them back. Float literals (`1.5`)
are refused.

Every operator with an `f64` operand is refused, since the integer operator would compute on the bits: arithmetic,
bitwise, shifts, unary `-` and `~`, the ordering comparisons, compound assignments, `++` / `--`, and `min`, `max`,
`isqrt` and `mulDiv` (`+ on an f64 is not supported: an f64 is held as its IEEE 754 bits and there is no float
arithmetic …`). Compute in integers and convert at the end. Equality is refused too (`===`, `!==`, `==`, `!=` and
`switch`): equal bits are not equal numbers, as NaN is not equal to itself and `0` equals `-0`. To compare the bits,
say so: `f64Bits(a) === f64Bits(b)`. Copying an `f64` (to a local, a field, an event) keeps its bits.

## Heap values

Advanced: where memory comes from when the stack is not enough. Locals live on the stack. These live on the heap (32 KiB by default;
[`HEAP_SIZE_KIB`](language-basics.md#memory-stack-and-heap) raises it), which is never freed during an instruction:

- strings built at run time (5110 when the heap is full);
- a `@layout borsh` struct's `Vec` fields while the instruction runs;
- the CPI scratch lists of a program that declares `MAX_ACCOUNTS`;
- a list or struct local marked `/** @heap */`:

```ts
import { type FixedVec, type u8, fixedVec, log } from "typesol";

export function collect(n: u8): void {
  /** @heap */
  const ids: FixedVec<u8, 3000> = fixedVec([]);
  ids.push(n);
  log(ids.length);
}
```

`/** @heap */` on an instruction's list or struct local keeps it on the heap instead of the stack: one allocation per
declaration, reused when a loop declares it again, up to the heap's size, for about 18 CU. Not in helpers, which may
run many times while the heap is never freed.

**Next:** [Statements and functions](language-statements.md): which TypeScript is TypeSOL.
