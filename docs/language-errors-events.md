# Errors, logs, events and return values

How a TypeSOL program fails, what it writes to the transaction's logs, the events it emits and the values it returns.
Part of the [language guide](language.md). The full list of error codes is in [errors.md](errors.md).

## require

```ts
import { type Account, type Mut, type Pubkey, type Signer, type u64, AnchorError, require } from "typesol";

export enum VaultError {
  NotOwner = "Only the owner can withdraw",
  /** @code 6100 */
  TooLarge = "Amount above the balance",
  Empty = "",
}

export interface Vault {
  owner: Pubkey;
  balance: u64;
}

export function withdraw(owner: Signer, vault: Mut<Vault>, amount: u64): void {
  require(vault.owner === owner.key, VaultError.NotOwner);
  require(amount <= vault.balance, VaultError.TooLarge);
  require(amount > 0n, "amount must be positive");
  require(vault.owner === owner.key, AnchorError.RequireKeysEqViolated);
  vault.balance -= amount;
}

export function audit(vault: Account<Vault>): void {
  require(vault.balance > 0n, VaultError.Empty);
}
```

`require(condition, error)` fails the instruction with `error` when the condition is false. There are no exceptions:
unlike JavaScript's `throw`, a failure cannot be caught, and the runtime discards every change the instruction made,
including those of programs it called.

The error may be:

| Error | Code |
| --- | --- |
| a member of one of your error enums, `MyError.Name` | 6000 + its position, or its `@code` |
| a string, `require(cond, "message")` | an error of its own, `RequireFailed<N>`, numbered after the enums' errors; one per distinct message, listed in the IDL |
| `AnchorError.X`, any of anchor-lang's `ErrorCode`s | Anchor's own code: `AnchorError.RequireKeysEqViolated` is 2502, as `require_keys_eq!` |
| `ProgramError.X` | a built-in Solana error (`ProgramError.InvalidInstructionData`), as a native program returns it |
| a `u32` value | that code, computed at run time |

A code computed at run time is how a helper passes an error on as Rust's `?` does, when it returns the error as a
value instead of failing (a price read whose error the caller may record or ignore): `const r = price(feed);
require(r.err === 0n, r.err);`. The code is reported as it is (use one of your errors' codes, so clients can decode
it); a zero code fails with 5100.

## Error enums

- `export enum MyError { Name = "message" }`: an enum whose members are strings is an error enum, Anchor's
  `#[error_code]`. Each member is an error; its string is the message (the IDL's `msg`).
- Codes start at 6000 and follow declaration order. Error enums of imported files are numbered first.
- `/** @code 6200 */` before a member gives it that code (Anchor's `Name = 200`), and the members after it continue
  from there. Codes only go up (`@code must be a number from … up`). The tag goes on its own line above the member, or
  first on the member's line; after other code on a line (`A = "a", /** @code 6200 */ B = "b"`) it would belong to no
  member, so it is refused.
- `Name = ""` has no message in the IDL, as an Anchor variant without `#[msg]`.
- An error enum may start at code 0 (`/** @code 0 */`, Rust's `ProgramError::Custom(0)`, returned as Solana's
  CUSTOM_ZERO), for ports of native programs ([native
  programs](language-native.md#errors-and-panics-as-the-original-reports-them)).
- `require(cond, "message")` errors come after the highest code.

When the program fails, the logs show the error and the source line, `Error 6000 NotOwner (vault.ts:21)`, and
TypeSOL's own failures say what failed, `TypeSOL: arithmetic overflow (vault.ts:42)`. Native ports can change or drop
that line ([log lines](language-native.md#log-lines-as-the-original-writes-them)).

## log

```ts
import { type Pubkey, type u64, log } from "typesol";

export function show(owner: Pubkey, amount: u64, ok: boolean): void {
  log("deposit");
  log(amount);
  log(owner);
  log(`owner ${owner} deposited ${amount}: ${ok}`);
}
```

`log(text)`, `log(value)` (an integer) and `log(key)` (a `Pubkey` or `Hash`, as base58) write a `Program log:`
line. A boolean is logged through a template string (`` log(`ok: ${ok}`) ``); `log(flag)` alone is a type error.
`console.log` is not available. Template strings and `+` build the text on the heap
([strings built at run time](language-types.md#strings-built-at-run-time)). `logBase64` and `logComputeUnits` are for
native ports ([log lines](language-native.md#log-lines-as-the-original-writes-them)).

## Events

```ts
import { type Mut, type Option, type Pubkey, type Signer, type u64, type Vec, emit } from "typesol";

export interface Deposited {
  owner: Pubkey;
  amount: u64;
  memo: string;
  referrer: Option<Pubkey>;
  tags: Vec<u64>;
}

export interface Pool {
  total: u64;
}

export function deposit(owner: Signer, pool: Mut<Pool>, amount: u64, tags: Vec<u64>): void {
  pool.total += amount;
  emit<Deposited>({ owner: owner.key, amount, memo: "thanks", referrer: null, tags });
}
```

- `emit<T>({ … })` writes an Anchor-format event: a `Program data:` log line holding the event's discriminator
  (sha256("event:<Name>")[..8]) and its Borsh bytes. The IDL lists `T` under `events`, and Anchor's event parsers and
  the generated client decode it.
- The type argument is required (`emit<T>(…)`), and the literal names every field.
- Event structs may hold `string`, `Option`, `FixedVec<T, N>` (its fixed layout, as in account data), `Vec<T>` (Borsh:
  from a Vec argument or a list in account data) and `Option<Vec<T>>` (given `null`, such an argument or a list). A
  nested struct given as a literal (`header: { signer: who.key, … }`) goes out as Borsh too, its Options one byte
  when empty.
- An event is at most 1024 bytes (5107).

### Events through CPI

```ts
import { type EventAuthority, type Mut, type SelfProgram, type u64, emitCpi } from "typesol";

export interface Paid {
  amount: u64;
}

export interface Ledger {
  total: u64;
}

export function pay(ledger: Mut<Ledger>, eventAuthority: EventAuthority, self: SelfProgram, amount: u64): void {
  ledger.total += amount;
  emitCpi<Paid>({ amount }, eventAuthority, self);
}
```

`emitCpi<T>({ … }, eventAuthority, self)` is Anchor's `emit_cpi!`: the event rides in a self-CPI (an inner
instruction) instead of the logs. The instruction takes `eventAuthority:
EventAuthority` (Anchor's `["__event_authority"]` PDA) and `self: SelfProgram` parameters, and the program accepts
Anchor's event instruction (2002 when the event authority did not sign it, 2006 when it is not that PDA).

## Return values

```ts
import { type Account, type Pubkey, type u64 } from "typesol";

export interface Quote {
  price: u64;
  maker: Pubkey;
}

export interface Market {
  price: u64;
  maker: Pubkey;
}

export function price(market: Account<Market>): u64 {
  return market.price;
}

export function quote(market: Account<Market>): Quote {
  return { price: market.price, maker: market.maker };
}
```

An instruction that returns a value sends it as return data: one integer, `boolean`, `Pubkey`, `string` (a Borsh
String) or fixed-size struct, at most 1024 bytes. The IDL lists it as `returns`, and the generated client decodes it.

- Another program reads it after a CPI with `returnData<T>(program)` ([calling other
  programs](language-cpi.md#return-data)).
- `setReturnData(bytes)` sets the raw bytes, as Rust's `set_return_data` (a native port's); an instruction that returns
  a value cannot call it ([return data as the original sets
  it](language-native.md#return-data-as-the-original-sets-it)).
