# Porting a native program (advanced)

> This page is advanced. Programs written for TypeSOL from the start, and ports of Anchor programs, need none of it:
> they use instructions with typed accounts ([accounts](language-accounts.md)). Read on to port a program written
> without Anchor and keep its exact behaviour: the same instruction data, account bytes, errors and log lines.

A program written without Anchor (Raydium AMM v4, SPL programs, Phoenix) reads a tag byte and its arguments itself,
takes its accounts by position, stores accounts without discriminators and reports failures its own way. TypeSOL
ports one as it is: the showcase ports ([`showcase/mainnet/raydium-amm`](https://github.com/typesol-lang/typesol/tree/main/showcase/mainnet/raydium-amm), `spl-stake-pool`, `phoenix`) run beside the
original binaries, and [`test/fixtures/native.ts`](https://github.com/typesol-lang/typesol/blob/main/test/fixtures/native.ts) is a small one. Part of the [language guide](language.md).

## The fallback entry

```ts
import { type AccountInfo, type Mut, ProgramError, instructionData, remainingAccounts, require, u64, writeData } from "typesol";

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length >= 9n, ProgramError.InvalidInstructionData);
  const tag = data.readU8(0n);
  const amount = data.readU64(1n);
  const rest = remainingAccounts();
  if (tag === 1n) {
    const total = data.slice(1n, 9n).reduce((s, b) => s + u64(b), 0n);
    require(total > 0n || amount === 0n, ProgramError.InvalidArgument);
  }
  require(rest.length >= 1n, ProgramError.NotEnoughAccountKeys);
}

export function record(target: Mut<AccountInfo>, value: u64): void {
  writeData<u64>(target, 0n, value);
}
```

`record` is there to show that instructions and a fallback coexist: as written, anyone can overwrite the first 8 bytes
of any account this program owns.

`/** @fallback */ export function name(): void` is Anchor's `fallback`: it runs when no instruction's discriminator
matches the data (short data too) instead of failing with 101. A program may have only a fallback, as a native
program does, or instructions and a fallback.

- It takes no parameters and reads `const data = instructionData()` (the whole data) and `remainingAccounts()` (the
  accounts by position). It is not in the IDL.
- The data is a read-only list of u8: `data.length`, `data.get(i)`, `data.readU8/U16/U32/U64/U128/readPubkey(offset)`
  (little-endian, bounds-checked: 5104), `for (const b of data)`, `map` / `filter` / `reduce` / `some` and the other
  list methods.
- `data.slice(start, end?)` is a view, nothing copied. Unlike JavaScript it does not clamp: past the length it fails
  with 5104. `out.pushAll(data.slice(a, b))` copies into a local FixedVec (a memcpy).
- A helper takes the data, or a slice of it, as an `InstructionBytes` parameter; bind it to a const first
  (`const data = instructionData()`) and pass `data`.
- Calls to System, Token and Stake go through `programAt<P>(acct)` and the typed methods, with remaining accounts, not
  hand-encoded `invoke` data ([programs passed as remaining
  accounts](language-cpi.md#programs-and-sysvars-passed-as-remaining-accounts)).

## Accounts without a discriminator

```ts
import { type AccountInfo, type Mut, type Pubkey, type u64, ProgramError, loadRaw, loadRawMut, require } from "typesol";

export interface Header {
  version: u64;
  admin: Pubkey;
  total: u64;
}

export function bump(market: Mut<AccountInfo>, admin: AccountInfo, amount: u64): void {
  require(admin.isSigner, ProgramError.MissingRequiredSignature);
  require(market.dataLen === 48n, ProgramError.InvalidAccountData);
  require(loadRaw<Header>(market).version === 1n, ProgramError.InvalidAccountData);
  const header = loadRawMut<Header>(market);
  require(header.admin === admin.key, ProgramError.IllegalOwner);
  header.total += amount;
}
```

- `loadRaw<T>(acct)` / `loadRawMut<T>(acct)` view an account as a fixed-layout struct from byte 0: owned by this
  program (3007), at least the struct's size (3003); `loadRawMut` also writable (3006) and loaded once. Structs are
  packed, as `#[repr(C, packed)]`.
- Make the original's own checks (an exact size, its error codes) before the load.
- An `AccountInfo` is not checked at all, so a key compared with a stored one proves nothing until the account signed:
  `bump` checks `admin.isSigner` first, as a native program does (`MissingRequiredSignature`).
- A read-only view can be read where it is made, `loadRaw<Header>(market).inner.b` or `loadRawAt<Prefix>(market,
  576n).tick` (its checks made there). A writable one claims its account once per instruction, so it is bound to a
  const first.
- The owner check of these views (and of `loadRawAt`, `rawArrayAt`, `rbTreeAt` below) is made every time, but the last
  account found to be this program's passes again with one pointer compare instead of 32 bytes until a CPI or an owner
  write (`assignOwner`, `closeRaw`, `close`). Helpers that each view the market again, and views in loops, pay about
  3 compute units for it instead of about 14.

### Borsh accounts

```ts
import { type AccountInfo, type Mut, type Option, type Pubkey, type u64, ProgramError, loadBorsh, programId, require, storeBorsh } from "typesol";

/** @layout borsh */
export interface StakePool {
  manager: Pubkey;
  totalLamports: u64;
  fee: Option<u64>;
}

export function deposit(pool: Mut<AccountInfo>, amount: u64): void {
  require(pool.owner === programId(), ProgramError.IllegalOwner);
  const state = loadBorsh<StakePool>(pool);
  state.totalLamports += amount;
  if (state.fee === null) state.fee = 0n;
  storeBorsh(pool, state);
}
```

`deposit` shows the decoding and encoding only: the owner is checked, but as written any caller raises
`totalLamports`, and the original also checks that the pool is initialized.

SPL Stake Pool's `StakePool` is read with `try_from_slice_unchecked` and written with `serialize`.
`const pool = loadBorsh<StakePool>(acct)` decodes the data from byte 0 into a local struct (a copy: fields updated,
Options narrowed and set to null or a value, data enums switched, copied, passed to helpers), and `storeBorsh(acct,
pool)` encodes it back from byte 0.

- As in Rust: no owner check and no discriminator; check the owner first, as the original does and `deposit` does.
  Bytes after the value are ignored when reading and left as they were when writing (an Option that became None
  leaves its old bytes behind it).
- Data too short, an Option tag or boolean other than 0/1, an enum tag out of range, a String that is not UTF-8 or
  longer than its `FixedString<N>`, or an account too small for the encoding fail with `ProgramError.BorshIoError`.
- `acct` is a remaining account, a `RemainingAccount` helper parameter or an `AccountInfo` parameter (`Mut<AccountInfo>`
  for `storeBorsh`; a remaining account must be writable, 3006).
- `T` may hold integers, booleans, Pubkeys, enums, FixedArrays, `FixedString<N>`, `FixedVec<T, N>`, Options, data enums
  with fixed-size payloads and nested structs of those, with or without `@layout borsh`; not `Vec<T>` or `string`
  (they would need the heap or a view).
- Each struct gets its own straight-line decoder and encoder (no heap): about 280 CU to read a 611-byte `StakePool`
  and 610 CU to read and write it back. The local lives on the stack (4 KiB per function).

## Lists over the rest of an account: BigVec

```ts
import { type BigVec, type Mut, type AccountInfo, type Pubkey, type u64, loadRawMut } from "typesol";

export interface ValidatorInfo {
  vote: Pubkey;
  lamports: u64;
}

export interface ValidatorList {
  maxValidators: u64;
  validators: BigVec<ValidatorInfo>;
}

export function add(list: Mut<AccountInfo>, vote: Pubkey, skip: u64): void {
  const l = loadRawMut<ValidatorList>(list);
  if (l.validators.findIndex((v) => v.vote === vote) < 0n) l.validators.push({ vote, lamports: 0n });
  l.validators.retain((v) => v.lamports > 0n || v.vote === vote);
  for (const v of l.validators.slice(skip, l.validators.length)) v.lamports += 1n;
}
```

`add` shows the list operations only: as written, anyone can push to any account this program owns.

`validators: BigVec<ValidatorInfo>` is SPL's `big_vec` (the stake pool's validator list): the last field of a
fixed-layout struct read with `loadRaw` / `loadRawMut`, a u32 length then the elements, in an account allocated up
front. Its room is the account's (`.capacity`: (size − fixed fields − 4) / size(T)), and it is never resized.

- Loading checks that the length fits (ProgramError::AccountDataTooSmall), and every access afterwards is bounded by
  the room as well: a length written again after the load (`writeData`, another view, `storeBorsh`) is read as at most
  `.capacity`, so `.length`, `get` / `set`, the loops, `slice` and `retain` never reach past the account. The load fails
  where the Rust would only panic on reaching such an element: check the length first (`readData<u32>(acct, offset)`)
  where the original returns an error of its own before that.
- `get` / `set` (5104 past the length), `push(v)` (AccountDataTooSmall when full, as `BigVec::push`), `retain((x) =>
  keep)` (in place, one pass, kept runs moved with the memmove syscall; bytes past the new end keep what they held, as
  `BigVec::retain`), `for … of`, the list callbacks (`findIndex`, `find(f)!.field` on struct elements), `.length`.
- `list.slice(start, end?)` is `BigVec::deserialize_mut_slice(start, end − start)`, used where it is written
  (`for (const v of l.validators.slice(skip, skip + n))`, `.slice(a, b).forEach(…)`, `.get(i)`, `.length`). Out of
  range fails with AccountDataTooSmall instead of clamping.
- Elements are references into the account.
- Not an account parameter, an argument, a local, nested, or in a `@layout borsh` struct.

## Views at run-time offsets

```ts
import { type AccountInfo, type Mut, type u64, ProgramError, loadRawAt, rawArrayMutAt, require } from "typesol";

export interface Prefix {
  tick: u64;
  count: u64;
}

export function fill(market: Mut<AccountInfo>, at: u64, n: u64): void {
  require(market.dataLen >= 576n, ProgramError.InvalidAccountData);
  const prefix = loadRawAt<Prefix>(market, at);
  const slots = rawArrayMutAt<u64>(market, at + 16n, n);
  for (let i = 0n; i < slots.length; i++) slots.set(i, prefix.tick + i);
}
```

`fill` shows the views only: as written, anyone can overwrite slots of any account this program owns.

A native account whose parts start where its header says (Phoenix's market at byte 576, trees sized by
`market_size_params`, Serum's slabs):

- `loadRawAt<T>(acct, offset)` / `loadRawMutAt<T>(acct, offset)` are `loadRaw` / `loadRawMut` at a byte offset known
  only at run time.
- `rawArrayAt<T>(acct, offset, capacity)` / `rawArrayMutAt<T>(…)` are `capacity` elements of a fixed-size type
  (integers, booleans, Pubkeys, enums, `FixedString<N>`, structs) packed in place from there, the count a run-time u64:
  `get` / `set` (5104 past the count), `.length` (the capacity), `for … of` and the list methods, structs by
  reference.
- The bounds are checked once, when the view is made (`offset + size`, with overflow, within the data:
  ProgramError::AccountDataTooSmall; `loadRaw`'s fixed size check stays 3003, the error of a view whose size is known
  when the program is compiled), as Phoenix slices `&data[576..]` after checking the account's size itself. Element
  access is pointer arithmetic.
- Owner (3007), writability and the one-mutable-view claim (2040) are `loadRaw` / `loadRawMut`'s, so several mutable
  views of one account need `NATIVE_ACCOUNT_WRITES` ([below](#writes-as-the-original-makes-them)), as a native port
  declares.
- Bind them with const; they are not helper parameters. `rbTreeAt(…).length` and `.capacity` read a tree made for the
  one read; anything else on a tree or a raw array is done on a const bound to it.
- A view (and anything read through it) is not used after `closeRaw` or `resizeAccount` of an account it may view, or
  after a helper that may close or resize one it is given: its bounds were checked against the old length, so it is a
  compile error saying to take the view again.

## lib-sokoban's red-black tree

```ts
import { type AccountInfo, type Mut, type i8, type u64, ProgramError, rbTreeMutAt, require } from "typesol";

export interface OrderId {
  price: u64;
  seq: u64;
}

export interface Resting {
  trader: u64;
  lots: u64;
}

function byPrice(a: OrderId, b: OrderId): i8 {
  if (a.price !== b.price) return a.price < b.price ? -1n : 1n;
  return a.seq < b.seq ? -1n : a.seq > b.seq ? 1n : 0n;
}

export function place(market: Mut<AccountInfo>, capacity: u64, price: u64, seq: u64, trader: u64, lots: u64): void {
  const asks = rbTreeMutAt<OrderId, Resting>(market, 8n, capacity, byPrice);
  const at = asks.insert({ price, seq }, { trader, lots });
  require(at !== null, ProgramError.InvalidArgument);
  const best = asks.min();
  if (best !== null && best.value.lots > 100n) best.value.lots -= 1n;
}

export function cancel(market: Mut<AccountInfo>, capacity: u64, price: u64, seq: u64, trader: u64): void {
  const asks = rbTreeMutAt<OrderId, Resting>(market, 8n, capacity, byPrice);
  const at = asks.addrOf({ price, seq });
  if (at !== 0n && asks.nodeAt(at).value.trader === trader) asks.removeAt(at);
  let total = 0n;
  for (const e of asks) total += e.value.lots;
  require(total < 1000000n, ProgramError.InvalidArgument);
}
```

`rbTreeMutAt<K, V>(acct, offset, capacity, compare?)` (or `rbTreeAt` to read) is lib-sokoban 0.3's
`RedBlackTree<K, V, N>` over account bytes, byte for byte (root, allocator, 1-based nodes of registers + key + value;
freed nodes keep their key and value; a LIFO free list ending at the bump index), checked against the crate after every
operation of recorded traces ([`test/verification/rbtree-trace.test.ts`](https://github.com/typesol-lang/typesol/blob/main/test/verification/rbtree-trace.test.ts)). Every write is the crate's own, so the account
matches the original after every instruction (Phoenix's order books and trader seats).

`place` and `cancel` show the tree operations only: `trader` is an argument, so as written anyone can rest an order
under any trader or cancel any trader's order. Phoenix takes the trader from an account that signed and looks up its
seat in the market's trader tree before it touches the book.

- `length`, `capacity`, `initialize()`, `get(k)` (the value in place, or null), `insert(k, v)` (the node index, or null
  when a new key finds it full; an equal key takes the value), `remove(k)` (the value, read in the freed node, or null),
  `removeAt(i)` (the node at index `i` from `addrOf` or a node's `.index`, removed with `remove`'s writes without
  searching again: 144 CU less per cancel in [`test/language/phx-costs.test.ts`](https://github.com/typesol-lang/typesol/blob/main/test/language/phx-costs.test.ts); null for 0 or a node in no tree),
  `min()` / `max()` (a node: `.key`, `.value`, `.index`, or null), `addrOf(k)` (0 when absent), `nodeAt(i)` (Phoenix
  keeps a trader's node index), `for (const e of tree)` / `tree.reversed()` with `break` / `continue`.
- **The comparator** is a function of the program, `(a: K, b: K) => i8` (any signed integer result; an unsigned one is
  refused, as it could never say "less"), called as `compare(searchedKey, nodeKey)` (Phoenix's FIFOOrderId orders by
  the left key's side). Without one, keys are ordered as Rust derives Ord (fields in order, integers by value, Pubkeys
  bytewise).
- **References.** A reference into the tree (`get`, `min`, a node, however it is bound: `c ? t.min() : t.max()`,
  `t.get(k)!`; a node is bound with const) cannot be used after an `insert` (it may reuse a freed node). A `for … of`
  body cannot insert, remove or initialize on the tree it walks, nor on any tree view of an account that may be the
  walked one's (another view of the same tree; under `NATIVE_ACCOUNT_WRITES` any account may be), nor call a helper
  that takes accounts and makes an `rbTreeMutAt` view. These are compile errors, as Rust's borrows are.
- **Cost.** The C runs sokoban's get_addr / _insert / _remove / rotations / allocator statement for statement, with the
  node stride a constant. With 512 entries: get 166 CU, insert 493, remove 294, min 94; with 4096: 215 / 595 / 355 /
  112, against 300 / 604 / 497 / 191 and 384 / 742 / 618 / 225 for lib-sokoban built with cargo-build-sbf. A walk
  costs about 34 compute units per node, a sum in its body included (each node's index checked once, when the walk
  reaches it).
- **Iteration** keeps its stack on the program's stack (64 nodes, more than any red-black tree a u32 index can address
  holds on one path); a deeper, damaged tree panics where the Rust's heap stack would grow.
- A tree is a const of the function that makes it, not a helper parameter (make it again in the helper from the
  account).
- **Panics.** sokoban's panics are Rust panics in the original; the tree reproduces each as solana-program up to 1.17
  reports one (Phoenix's build): the log line `panicked at '<message>', <file>:<line>:<column>`, then the runtime's
  abort ("SBF program panicked", ProgramFailedToComplete), with sokoban's messages and source lines as Phoenix's binary
  holds them (`src/…`):
  - `initialize()` on an allocator that is not all zero: "Cannot reinitialize NodeAllocator"
    (src/node_allocator.rs:249:13);
  - an empty tree's insert with no room (capacity 0, or a damaged allocator): "Buffer is full, size N" (:269:17);
  - on damaged registers only: "Nodes are not connected" (src/red_black_tree.rs:429:13), "assertion failed:
    self.is_root(parent)" (:503:17), "assertion failed: self.is_leaf(max_left)" (:598:17), a size going below zero
    ("attempt to subtract with overflow", src/node_allocator.rs:291:9);
  - a node index outside 1..capacity, from `nodeAt` or a damaged register, panics as Rust's `nodes[i - 1]` would
    ("index out of bounds: the len is N but the index is I", src/node_allocator.rs:255:10; index 0, "attempt to
    subtract with overflow", :255:21: locations read from the source, not from a binary), so a damaged tree never
    reads outside the account.

  A port makes the original's checks in the original's order before the tree call, and these lines follow on their own.

## Writes as the original makes them

`export const NATIVE_ACCOUNT_WRITES = true` (anywhere in the program; opt-in, for native ports).

A native program writes account data in place and the runtime judges afterwards: a read-only account whose data
actually changed fails the instruction (`ReadonlyDataModified`, or an access violation at the write under account-data
direct mapping), one that was only read (or written with the bytes it held) is fine, and an account passed twice is two
`AccountInfo`s over one buffer.

- **By default** `loadRawMut` and `storeBorsh` check writability up front (3006), `loadRawMut` claims the account once
  and `storeBorsh` refuses an account passed more than once (2040, as a write to a remaining account's lamports). So a
  port fails where the original succeeds (a read-only validator list that is only read; the list passed again as a
  stake account, which the original skips by its address checks).
- **With the flag**, `loadRawMut`, `storeBorsh` and the BigVec writes through a `loadRawMut` view skip both, and both
  take a plain `AccountInfo` parameter (no `Mut<…>` needed). Owner and size checks stay.
- **The trade-off:** a write to a read-only account is reported by the runtime at the end, not at the write, and two
  loads of one account are two views of the same bytes (a write through one is read through the other), where Rust's
  `RefCell` would fail a second `borrow_mut()` while the first is held (a panic, or `AccountBorrowFailed` through
  `try_borrow_mut_data`). The original's own address and type checks normally refuse such a pair before it is loaded
  (SPL Stake Pool's PDA checks); make them in the same order, before the load.
- Only data writes are affected: with or without the flag every view reads the account's bytes in place, so a
  `loadRaw` of an account also loaded with `loadRawMut` (or written with `storeBorsh`) reads what was written, BigVec
  pushes included. The flag only lifts the up-front checks (a second `loadRawMut` of one account, at the same position
  or another, is 2040 without it).
- `.lamports` on remaining accounts, `loadAccountMut`, CPI account metas and the checks of `Mut<…>` parameters stay as
  they are, and programs without the flag compile exactly as before.

### Inout places that may be one account

An `Inout<T>` argument ([Inout parameters](language-statements.md#inout-parameters)) must not share storage with
another argument during the call. In every program, places in accounts that only the transaction can tell apart are
compared before the call and fail with 2040 when they overlap ([two parameters, one
account](language-accounts.md#two-parameters-one-account)). Under `NATIVE_ACCOUNT_WRITES` the native views are
compared the same way: places in two `loadRawMut` or `loadRawMutAt` views, `rawArrayMutAt` elements and `rbTreeMutAt`
nodes, which may be views of one account.

One pair is left to run time: a place in a `loadRawMut` view passed with the `RemainingAccount` it was loaded from.
Without `NATIVE_ACCOUNT_WRITES` a second `loadRawMut` of it in the helper fails with 2040; with the flag the helper can
load and write the same bytes, the flag's trade-off.

## Accounts closed, reassigned and resized by hand

On remaining accounts and `AccountInfo` parameters:

- `closeRaw(account, receiver)` is what Phoenix's Tombstone writes, in its order: `receiver.lamports +=
  account.lamports` (checked), `account.lamports = 0`, `assign(&system_program::id())`, `realloc(0, false)`. Unlike
  `close` the data is not zeroed first (a realloc to 0 drops it, and the runtime then accepts the new owner), so it
  costs a few compute units whatever the account's size, and the account ends as the original's does (gone, its
  lamports in the receiver; [`test/language/native-close.test.ts`](https://github.com/typesol-lang/typesol/blob/main/test/language/native-close.test.ts) compares it with Phoenix's own Tombstone).
- `assignOwner(account, owner)` is `AccountInfo::assign` (the runtime accepts it for a writable account of this program
  whose data is empty or zeroed).
- `resizeAccount(account, size)` also takes a remaining account (`realloc(size, true)`: new bytes zeroed, at most
  10 KiB past the size it had when the instruction started, 3016). That size is the one the entrypoint records in the
  account's record, as solana_program 1.14's does, only in programs that resize a remaining account.
- A view of the account made before either (`loadRawMutAt`, `rawArrayMutAt`, `rbTreeMutAt`, a node or a struct read
  through one) is a compile error to use after it: its bounds were checked against the old length, so take the view
  again.
- Without `NATIVE_ACCOUNT_WRITES` the accounts are checked as other writes the compiler cannot see are: writable (3006;
  a parameter must be `Mut<AccountInfo>`), passed once (2040), the closed or reassigned account this program's (3007),
  and not closed into itself (2040). With it nothing is checked and the runtime judges, as for the original
  (`ReadonlyLamportChange`, `ExternalAccountLamportSpend`, `UnbalancedInstruction`, `ModifiedProgramId`), and plain
  `AccountInfo` parameters are enough.

## Errors and panics as the original reports them

```ts
import { type u64, ProgramError, instructionData, panic, panicsAt, require } from "typesol";

export enum PoolError {
  /** @code 0 */
  AlreadyInUse = "Pool account already in use",
  Deserialization = "Failed to deserialize",
}

/** @fallback */
export function entry(): void {
  const data = instructionData();
  require(data.length > 0n, ProgramError.InvalidInstructionData);
  require(data.readU8(0n) !== 9n, PoolError.AlreadyInUse);
  if (data.readU8(0n) === 7n) panic("unsupported instruction", "program/src/lib.rs:12:5");
  const a = data.readU64(1n);
  const total: u64 = panicsAt("src/quantities.rs:233:1", a + 1n);
  require(total > 0n, PoolError.Deserialization);
}
```

- An error enum may start at code 0 (`/** @code 0 */`, Rust's `ProgramError::Custom(0)`, returned as Solana's
  CUSTOM_ZERO).
- `require(c, ProgramError.InvalidInstructionData)` fails with a built-in error.
- `panic(message, "program/src/lib.rs:12:5")` is a Rust panic (ProgramFailedToComplete, the runtime reporting that
  location). `panic(null, "src/lib.rs:105:19")` logs no message, for an original whose panic handler writes none, so
  only the runtime's "SBF program Panicked in src/lib.rs at 105:19" is left.
- `abort()` is Rust's abort (the allocator's out-of-memory error: `log("Error: memory allocation failed, out of
  memory"); abort();`), the runtime's `abort` syscall, which logs "SBF program panicked" with no location.
- `const PANIC_ON_OVERFLOW = true` makes arithmetic overflow and division by zero panic as `checked_*().unwrap()` does
  instead of failing with 5100 / 5101.
- **Panics as an older solana-program writes them.** `export const PANIC_STYLE = "solana-1.14"` (a program built with
  solana-program 1.14 to 1.17, whose rustc formats a panic as it did before 1.73: Phoenix v1) makes `panic(message,
  location)` log `panicked at '<message>', <location>` and then abort, so the runtime's last line is "SBF program
  panicked" with no location, as that panic handler leaves it. `panic(null, …)` is refused there (the handler always
  logs); without a location the TypeScript line and column are used. `PANIC_ON_OVERFLOW`'s panics abort too.
- **Overflow panics with Rust's message and location.** `panicsAt("src/quantities.rs:233:1", a + b)` is `a + b` whose
  checked arithmetic panics as Rust's overflow checks do at that location ("attempt to add with overflow"; also
  "attempt to subtract / multiply with overflow", "attempt to divide by zero", "attempt to calculate the remainder with
  a divisor of zero", "attempt to negate with overflow", "attempt to divide with overflow" and "attempt to shift left /
  right with overflow" for a shift amount past the width), logged as `panic` logs (`PANIC_STYLE` above, else the
  message and `sol_panic_` at the location), instead of failing with 5100 / 5101; with or without `PANIC_ON_OVERFLOW`,
  which applies outside it.
  - Rust reports the location of the expression the operator belongs to, so the wrapper goes around that expression:
    only the operators written inside it take the location (not those of the helpers it calls), an inner `panicsAt`
    gives its operators their own (`panicsAt(A, x + panicsAt(B, y * z))`), and as a statement it takes an assignment,
    `panicsAt(LOC, total += fee);`.
  - A Rust newtype's operator panics at its `impl` (Phoenix's `QuoteLots + QuoteLots` at the macro line in
    quantities.rs, wherever the addition is written): give the port a helper, `function addQuoteLots(a: u64, b: u64):
    u64 { return panicsAt(QUOTE_LOTS_ADD, a + b); }`.
  - The bits `<<` loses, `**`, `mulDiv` / `mulDivCeil`, casts and u256 arithmetic keep TypeSOL's failures (Rust checks
    them differently, or with other messages).
  - [`test/language/rust-panics.test.ts`](https://github.com/typesol-lang/typesol/blob/main/test/language/rust-panics.test.ts) checks the lines against the Phoenix binary's own panics.

## Log lines as the original writes them

- `const ERROR_LOG_PREFIX = "AMM error: "` and `const PROGRAM_ERROR_LOG_PREFIX = "Program error: "` replace the
  compiler's failure line with the entrypoint's (`msg!("AMM error: {}", e)`).
- `null` logs no failure line at all, as a native program returns an error its own checks already explained (Phoenix):
  the program's errors and codes its helpers return (`ERROR_LOG_PREFIX = null`), built-in ProgramErrors and
  `programAt`'s check (`PROGRAM_ERROR_LOG_PREFIX = null`), each about 110 CU cheaper than a logged one (constraint
  errors and the compiler's own checks still log).
- `logBase64("ray_log: ", record)` logs a struct's bytes in base64 (a native `bincode` log record).
- `createProgramAddress(seeds, program)` is `Pubkey::create_program_address` (null for no address).
- `logComputeUnits()` is `sol_log_compute_units()`: the runtime writes "Program consumption: N units remaining" at that
  point, as for the original (Phoenix's cancel and withdraw paths log it).

## Byte strings built by hand

```ts
import { type FixedVec, type Pubkey, type u64, type u8, fixedVec, setReturnData, u16 } from "typesol";

export interface Header {
  kind: u8;
  owner: Pubkey;
  amount: u64;
}

export function encode(owner: Pubkey, amount: u64, count: u64): void {
  const data: FixedVec<u8, 128> = fixedVec([15n]);
  data.pushLE<u16>(1n);
  data.pushKey(owner);
  data.pushBorsh<Header>({ kind: 2n, owner, amount });
  data.pushLE(amount);
  data.setLE(1n, u16(count));
  setReturnData(data);
  data.truncate(3n);
}
```

Instruction data for a self-CPI, a log record or return data is built in a `FixedVec<u8, N>` (a local list or one in
account data):

- `buf.pushLE(x)` appends an integer's little-endian bytes at its width (u8 … u128, i8 … i128; a literal needs one:
  `buf.pushLE<u16>(1n)` or `buf.pushLE(u16(1n))`).
- `buf.pushKey(key)` appends a Pubkey's 32 bytes.
- `buf.pushBorsh(value)` appends a value's Borsh encoding with the codecs `invoke`, events and `storeBorsh` use: a
  struct, or an object literal given its type (`buf.pushBorsh<Header>({ … })`); a data enum, its tag then the
  variant's fields; a FixedArray; a list, its u32 count then the elements; integers, booleans, Pubkeys, strings and
  Options. A data-enum literal of a fixed-size variant costs what the same bytes cost with `pushLE`: its fields
  evaluated in order, then one room check and a store of each.
- `buf.setLE(offset, x)` (or `setLE<u16>(offset, x)`) overwrites bytes within the length, as Rust's
  `data[a..b].copy_from_slice(…)`, and `buf.truncate(n)` keeps the first `n`.
- Past the room (or, for `setLE` and `truncate`, past the length) fails with 5104 and the length does not move.

Phoenix's event recorder is built this way, and the showcase checks it byte for byte against the Phoenix binary's
batches.

## Return data as the original sets it

`setReturnData(bytes)` is `set_return_data(&bytes)`, the bytes as they are, from the `@fallback` entry, a helper or a
void instruction (Phoenix's Borsh `Vec<FIFOOrderId>` of the orders that rested, built in a local `FixedVec<u8, N>`).

- `bytes` is a list of u8: a local FixedVec, a Vec or FixedVec in account data, or the instruction data or a slice of
  it.
- The last call wins and an empty list clears it; a CPI made afterwards replaces it with the callee's (call it after the
  last CPI, as Rust must).
- More than 1024 bytes fails as the Rust call does: the runtime refuses it ("Return data too large (1025 > 1024)").
- An instruction that returns a value cannot call it (a compile error: its return value is its return data); a helper
  it calls may, and the instruction's return value, set last, replaces what the helper set.

**Next:** [Built-ins](language-builtins.md): every name `"typesol"` exports.
