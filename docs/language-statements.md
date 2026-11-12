# Statements and functions

TypeSOL uses TypeScript's syntax and accepts a subset of its statements and expressions. This page lists exactly which:
declarations, assignment, control flow, functions and closures, and, at the end, [what is refused](#what-is-refused)
with the message each refusal gives. Part of the [language guide](language.md).

In short, a function body may contain:

| Accepted | Notes |
| --- | --- |
| `const`, `let` | one name each, with an initializer ([declarations](#declarations)) |
| assignment, `+=` … `>>=`, `++`, `--` | checked arithmetic ([types](language-types.md#integers)) |
| `if` / `else`, `? :`, `&&`, `\|\|`, `!` | conditions are `boolean` |
| `for`, `for … of`, `while`, `do … while`, `break`, `continue` | [loops](#loops) |
| `switch` | on integers, enums and a data enum's `kind` |
| `return` | |
| calls | helpers, closures, built-ins, account methods |
| `const { a, b } = x` | [destructuring](#destructuring), one level |
| arrow functions and `function` expressions | [closures](#arrow-functions-and-closures) |
| template strings, `+` on strings | [strings](language-types.md#strings-built-at-run-time) |
| `??`, `?.`, `x!` | on options and optional accounts |

Everything else is refused at compile time with a message saying what to write instead. Nothing is half-supported.

## Declarations

```ts
import { type Mut, type u64, type u8 } from "typesol";

export interface Counter {
  count: u64;
  step: u8;
}

export function add(counter: Mut<Counter>, times: u64): void {
  const step: u64 = 2n;
  let total = 0n;
  for (let i = 0n; i < times; i++) total += step;
  {
    const total = 1n; // a new name in this block
    counter.step = 1n;
    counter.count += total;
  }
  counter.count += total;
}
```

- `const` and `let` declare one plain name with an initializer. `let x: u64;` without one is refused (`declare one
  plain name with an initializer`), and so is `var` (`use const or let, not var`).
- The type comes from the annotation or the initializer. A local declared from a bare literal (`let total = 0n`) is a
  `u64`; annotate it for another width (`const step: u8 = 2n`).
- A local can be an integer, `boolean`, `Pubkey`, `Hash`, enum, `Option`, `string`, a struct or a `FixedArray` /
  `FixedVec`. A `Vec` cannot be a local: use a `FixedVec`.
- Block scoping is JavaScript's: a name declared in a block is gone after it, and may shadow an outer one.
- `const` cannot be reassigned (TypeScript's own error). Unlike JavaScript, parameters cannot be reassigned either
  (`"n" is const or an argument and cannot be reassigned`): copy one into a `let`.
- Struct field names that are C keywords or names the generated C uses (`default`, `signed`, `int`, `char`, `NULL`,
  `SUCCESS`, …), or that start with `_` or contain `__`, are refused (`"default" is reserved in the generated C; pick
  another name`).

## Assignment

You can assign to a local, a field of a writable account (`Mut<T>`), a field of a local struct, a list element through
`.set(i, v)`, and `.lamports` of a writable account. Instruction arguments are read-only (`instruction arguments are
read-only; copy the value into a local first`), and so are helper parameters (see [Inout](#inout-parameters)).

Compound assignments (`+=`, `-=`, `*=`, `/=`, `%=`, `**=`, `&=`, `|=`, `^=`, `<<=`, `>>=`) and `++` / `--` are
checked like the operators they stand for.

### Copies and references

```ts
import { type Mut, type u64 } from "typesol";

export interface Point {
  x: u64;
  y: u64;
}

export interface Shape {
  a: Point;
  b: Point;
  sum: u64;
}

export function edit(shape: Mut<Shape>): void {
  shape.b = shape.a; // assignment copies the whole struct
  const copy: Point = shape.a; // an annotated binding is a copy
  copy.x += 1n; // shape.a is unchanged
  const ref = shape.a; // an unannotated const binding is a reference
  ref.y += 1n; // changes shape.a.y
  shape.sum = copy.x + ref.y;
}
```

- **Assignment copies.** `a.home = b.home` and `a.trail.set(0n, a.home)` copy a whole struct or array of the same type,
  as Rust and Anchor do.
- **Binding with `const` references.** `const r = acct.home` names the same storage, like a JavaScript object
  reference: writes through `r` change `acct.home`. Struct references are bound with `const`; `let r = acct.home` is
  refused (`bind struct references with const`).
- **An annotation makes a copy.** `const p: Point = acct.home` (or `= { x, y }`) is a local struct of its own. Lists
  likewise: `const ys: FixedVec<u64, 4> = acct.xs` is a copy.
- **A reference cannot outlive what it names.** Replacing the referenced place (`book.bids.set(i, …)`, `pop()`,
  `clear()`, `acct.p = …`) while the reference is still used afterwards is a compile error, because JavaScript would
  keep the old object: `"q" still refers to a.home; replacing it here would change what "q" reads (in JS it keeps the
  old value). Copy the fields you need into locals first`.
- A ternary can pick a reference: `const o = side === Side.Bid ? book.bids.get(i) : book.asks.get(i)` aliases one of
  them, no copy.
- Scalars (integers, booleans, `Pubkey`) are always copied.

## Expressions

- **Operators**: arithmetic and bitwise operators on integers ([integers](language-types.md#integers)), comparisons,
  `&&`, `||`, `!`, `===`, `!==`, and `? :`. `instanceof`, `in`, `typeof`, `delete`, `void` and the comma operator are
  refused.
- **Evaluation order**: operands and arguments are read left to right, as in JavaScript, even when a later one changes
  account data (`v.length + v.pop()`) or a local (`x + bump()` with a closure `bump` doing `x += 1n`, or a list
  callback writing it).
- **Ternaries** run only the chosen branch: `const fee = vip ? 0n : 30n`. Between accounts too:
  `const source = ephemeral ? rest.get(5n) : reserve` picks a remaining account (`rest.get(i)`, a local or
  `RemainingAccount` helper parameter bound to one) or an `AccountInfo` parameter, and the result goes wherever a
  remaining account does (typed CPIs, `readData`, `loadRaw` / `loadRawMut`, `loadBorsh`, helpers taking a
  `RemainingAccount`).
- **`??`, `?.` and `!`** work on options and optional accounts ([Option](language-types.md#option),
  [optional accounts](language-accounts.md#optional-accounts)). `?.` and `!` on anything else, and a method call
  through `?.`, are refused (a `find` on struct elements excepted: `xs.find(f)!.qty`).
- **Object literals** need a known struct type ([structs](language-types.md#structs)); array literals are only
  written inline, as seeds, CPI account lists, a `fixedVec([…])` or a list of functions in `for … of`.

## Conditions

```ts
import { type Mut, type u64 } from "typesol";

export interface Tier {
  level: u64;
}

export function classify(tier: Mut<Tier>, amount: u64, vip: boolean): void {
  if (vip && amount > 0n) tier.level = 3n;
  else if (amount >= 1000n) tier.level = 2n;
  else tier.level = amount < 10n ? 0n : 1n;
}
```

A condition (in `if`, `while`, `for`, `? :`, `&&`, `||`, `!`) must be a `boolean`. Unlike JavaScript, there is no
truthiness: `if (amount)` is refused (`expected boolean, got u64`).

`==` and `!=` compile like `===` and `!==`: both operands have the same type (`operands have different types` otherwise),
so there is no coercion for the loose forms to do.

## Loops

```ts
import { type FixedArray, type Mut, type u64, type Vec } from "typesol";

export interface Book {
  levels: FixedArray<u64, 8>;
  total: u64;
}

export function tally(book: Mut<Book>, extra: Vec<u64>, n: u64): void {
  for (let i = 0n; i < n; i++) book.total += 1n;
  for (let i = 0n, j = n; i < j; i++, j--) book.total += 1n;
  for (const level of book.levels) {
    if (level === 0n) continue;
    book.total += level;
  }
  for (const x of extra) {
    if (x > 100n) break;
    book.total += x;
  }
  let k = 0n;
  while (k < 3n) k++;
  do {
    k--;
  } while (k > 0n);
}
```

- `for (init; condition; update)` with one counter or several (`for (let i = 0n, j = n; i < j; i++, j--)`): several
  declarations, and comma-separated updates run in order after each pass, `continue` included.
- `for (const x of list)` over a `Vec`, `FixedArray`, `FixedVec`, a `Vec` argument, the instruction data, a stored
  `map` / `filter` result or a chain. Each `x` is what `list.get(i)` gives: a value, or a reference into account data
  for structs. The length is read again every step, as in JavaScript.
- `for (const f of [dbl, inc])` runs a list of named functions in turn (unrolled; `continue` and `break` work).
- `while`, `do … while`, `break` and `continue`. Inside a `switch`, `break` leaves the switch and `continue` the
  enclosing loop, as in JavaScript.
- Labels (`outer: for …`) and `for … in` are refused.
- There is no iteration limit: loops are bounded by the transaction's compute budget.
- Remaining accounts are iterated by index: `for (let i = 0n; i < rest.length; i++) rest.get(i)`.

## switch

```ts
import { type Mut, type u128, type u64 } from "typesol";

export enum Side {
  Bid,
  Ask,
}

export interface Book {
  bids: u64;
  asks: u64;
}

const LARGE = 1000n;

export function place(book: Mut<Book>, side: Side, size: u128): void {
  switch (side) {
    case Side.Bid:
      book.bids += 1n;
      break;
    case Side.Ask:
      book.asks += 1n;
  }
  switch (size) {
    case 0n:
    case 1n:
      book.bids += 0n;
      break;
    case LARGE:
      book.asks += 0n;
      break;
    default:
      book.bids += 0n;
  }
}
```

`switch` works on integers (128-bit ones too), enums and a data enum's `.kind`, with JavaScript's `break` and
fallthrough. Case labels are literals, constants or enum members (`case labels must be literals, constants or enum
members`). A `switch` on a string is refused (`switch works on integers and enums`).

## Destructuring

```ts
import { type Account, type Mut, type Pubkey, type u64 } from "typesol";

export interface Point {
  x: u64;
  y: u64;
}

export interface Player {
  owner: Pubkey;
  pos: Point;
  score: u64;
}

export function read(player: Account<Player>, out: Mut<Player>): void {
  const { owner, pos: p } = player;
  let { score } = player;
  score += p.x;
  out.owner = owner;
  out.score = score;
}
```

`const { owner, pos: p } = acct` (or `let` for scalars you change) from a name or a field path: one declaration per
name, read as `acct.owner` would be. Scalars are copies, nested structs are references. There is no rest
(`...rest is not supported in destructuring`), no defaults, and no nesting (`nested destructuring is not supported;
destructure in two steps`). Array destructuring is only for `const [address, bump] =
findProgramAddressWithBump(seeds, program)` ([PDAs](language-pdas.md#deriving-addresses-in-the-body)).

## Helpers

```ts
import { type Mut, type u64 } from "typesol";

export interface Fee {
  numerator: u64;
  denominator: u64;
}

export interface Vault {
  fees: u64;
  rate: Fee;
}

function applyFee(fee: Fee, amount: u64): u64 {
  return (amount * fee.numerator) / fee.denominator;
}

function at(numerator: u64): Fee {
  return { numerator, denominator: 100n };
}

export function charge(vault: Mut<Vault>, amount: u64): void {
  vault.fees += applyFee(vault.rate, amount);
  vault.fees += applyFee({ numerator: 3n, denominator: 100n }, amount);
  vault.rate = at(5n);
  vault.fees += at(1n).numerator;
}
```

A helper is a function that is not exported (and every function of an imported file).

- **Parameters**: values (integers, booleans, `Pubkey`, `Hash`, enums, `Option`, `string`, `u256`), structs, lists
  (below), data enums, `SignerSeeds`, remaining accounts (`RemainingAccount`, or the list: `RemainingAccounts`), the
  instruction data (`InstructionBytes`), functions ([below](#functions-as-arguments)) and accounts the instruction
  already checked (`Signer`, `Account<T>`, `Mut<T>`, `AccountInfo`, token accounts, mints, programs). Helpers cannot
  take `Init<…>` accounts or constraint types (`helpers take accounts that exist`; `constraints belong on instruction
  parameters`), and a read-only account cannot be passed where a helper takes `Mut<T>`.
- **Results**: `void`, a scalar, a `string`, a function, or a fixed-size struct
  (`function at(x: u64, y: u64): Point { return { x, y }; }`): the caller gets its own copy, to bind, store with
  `acct.home = at(…)` / `arr.set(i, at(…))` or read as `at(…).x`. The return type is required (`helper functions need
  an explicit return type`), and a helper with a result must return on every path (TypeScript checks it; a path that
  still ends without one fails with 5114).
- **Arguments written in place**: a struct, data-enum or `fixedArray<T, N>(fill)` argument may be a literal
  (`applyFee({ denominator: 100n, numerator: 3n }, amount)`, nested literals and a ternary with a literal branch too),
  built in a local of its own as `const fee: Fee = { … }` would be.
- **No recursion**: a helper cannot call itself, directly or through others (`recursion is not supported: a -> b ->
  a`). Nor can a closure.
- Helpers are not `async` or generators, and are declared at the top level: a `function` declaration inside a
  function is refused (declare a `const` arrow there instead).

### How arguments are passed

TypeSOL keeps JavaScript's meaning (a callee cannot change the caller's values unless it is given the place to change)
while passing large values by pointer:

- Struct, list and data-enum parameters are read-only, passed by pointer. Writing to one is refused: `helper parameters
  are read-only: declare p as Inout<T> to change the caller's value in place, or copy it into a local first`.
- When the helper also takes accounts, an argument that is account data (a field of a view or of a loaded account) is
  copied at the call, since the helper's writes could change it. A struct the caller owns (a local, a helper's result,
  an instruction argument, return data, or a struct parameter of a helper that itself takes accounts) is still passed
  in place.
- `Pubkey`, `Option`, `string` and `u256` parameters are passed by pointer too (the SBF target passes a C struct as a
  pointer to the caller's object):
  - a helper that writes nothing reads the caller's value in place;
  - a helper that can write (it takes accounts, remaining accounts or `Inout<T>` places) gets a copy taken at the
    call, and so does text a string argument views in account data or in an `Inout<T>` place;
  - except when the argument is one nothing the helper is given reaches: a local, a temporary, an instruction
    argument, a constant, an account's key, the program id or a parameter of the calling helper, passed in place.
- **List parameters.** A `FixedVec<T, N>` or `Vec<T>` parameter takes a Vec argument, a slice of one, or the caller's
  FixedVec of the same elements (a local, a field of a local struct or of account data) with at most N elements of
  room. It is read-only and passed as a view of its elements, by pointer; a list in account data is copied first when
  the helper also takes accounts, as a struct is.
- A helper that takes a struct account as `Mut<T>` can grow its Vec (`push(value, payer)`: the account's size at
  instruction entry is passed along).

### Inline and @noinline

clang inlines most helpers into their callers, so their locals share the caller's 4 KiB stack frame.
`/** @noinline */` on a helper keeps it a function of its own with its own frame (a few CU per call), for work with
large locals of its own (Phoenix's order ids, built after its event recorder's last CPI):

```ts
import { type Mut, type u64, fixedArray } from "typesol";

export interface Out {
  v: u64;
}

/** @noinline */
function third(seed: u64): u64 {
  const xs = fixedArray<u64, 200>(seed);
  return xs.get(3n);
}

export function run(out: Mut<Out>): void {
  out.v = third(out.v);
}
```

### Inout parameters

```ts
import { type FixedVec, type Inout, type Mut, type u64 } from "typesol";

export interface Recorder {
  count: u64;
  last: u64;
}

export interface Log {
  rec: Recorder;
  ids: FixedVec<u64, 4>;
}

function addEvent(rec: Inout<Recorder>, value: u64): void {
  rec.count += 1n;
  rec.last = value;
}

function remember(ids: Inout<FixedVec<u64, 4>>, id: u64): void {
  if (ids.length === 4n) ids.clear();
  ids.push(id);
}

export function record(log: Mut<Log>, value: u64): void {
  addEvent(log.rec, value);
  remember(log.ids, value);
  const scratch: Recorder = { count: 0n, last: 0n };
  addEvent(scratch, value);
}
```

`rec: Inout<Recorder>` is Rust's `rec: &mut Recorder`: the helper gets the caller's place itself (a pointer, no copy:
about the compute units of the same code written inline) and the caller sees its writes after the call, as JavaScript
shares an object passed to a function.

- `T` is a fixed-size struct, a `FixedArray<T, N>` or a `FixedVec<T, N>` (its `push`, `pop` and `clear` included).
- **The argument is a writable place**: a local struct or list, a `loadBorsh` local, a field path of a local, of a
  `loadRawMut` view or of a `Mut<T>` account, a list element (`book.levels.get(i)`, a narrowed Option's value),
  another `Inout` parameter (passed on), or a literal (a fresh value nobody else sees). A read-only one (a field of an
  `Account<T>`, a `loadRaw` view, an instruction argument, a read-only parameter) is a compile error naming what to
  change (`bump() changes p (Inout): "a" is read-only; declare it Mut<...>`).
- **Nothing else may reach the place during the call.** No other argument may share storage with an Inout one (one
  place inside the other; two elements of one list, whatever their indexes, a BigVec slice's elements included; an
  account and a place inside it; a read-only struct argument inside it: pass a copy). An element of a `Vec` or
  `BigVec` is refused when the call may resize or filter that list (the helper takes writable or remaining accounts),
  since its elements would move. A reference into the place (`const e = p.items.get(0n)`) that is read after the call
  is refused, since the helper may replace what it points at (copy the fields first, or read them through the place).
- **Places that may be one account at run time** (two `Dup<…>` accounts, a writable and a read-only account, native
  views) are compared before the call: 2040 when they overlap ([which places, and the one pair left to run
  time](language-native.md#inout-places-that-may-be-one-account)).
- **Values are not places.** Integers, Pubkeys, strings and Options are values, which JavaScript copies into a function
  too: return the new value (`x = f(x)`) or keep it in a struct and take `Inout<ThatStruct>` (`Inout<u64>: a u64 is a
  value, which JS copies into a function too, …`). `Vec<T>`, `BigVec<T>`, accounts and data enums are refused with
  what to write instead, and so is `Inout<T>` anywhere but a helper's parameter.
- Closures, and helpers expanded because they were given one, take `Inout<T>` the same way; their struct parameters
  were references already.

## Arrow functions and closures

```ts
import { type Mut, type u64 } from "typesol";

export interface Sum {
  total: u64;
}

const fee = (x: u64): u64 => x / 100n;

export function collect(sum: Mut<Sum>, a: u64, b: u64): void {
  let total = 0n;
  const add = (v: u64): void => {
    total += v - fee(v);
  };
  add(a);
  add(b);
  const double = function (x: u64): u64 {
    return x * 2n;
  };
  sum.total = double(total);
}
```

- `const f = (x: u64): u64 => …` or `const f = function (…) {…}`, at the top level or inside a function.
- One that captures nothing becomes a helper.
- One that reads or writes the enclosing function's variables (a closure) is expanded where it is called: its names
  mean what they meant where it was declared, struct parameters are references, `return` leaves the closure. It cannot
  call itself.
- Parameter types are required where the function is declared (TypeScript's `noImplicitAny`); an arrow written at a
  call takes them from the parameter it is passed to.
- Functions are values where they can be expanded: `const h = g` names the same function, and a function that returns
  one (`function adder(n: u64): (x: u64) => u64 { return (x) => x + n; }`) makes a closure where it is called
  (`const add5 = adder(5n)`, or `adder(5n)(x)`).
- A function can be chosen at run time between named ones, `const g = k === 1n ? dbl : inc` (the condition is read
  once, there; a call runs only the chosen one), and a list of named functions can be run in turn,
  `for (const f of [dbl, inc]) total += f(x)` (unrolled; `continue` and `break` work).
- Functions cannot be stored in a struct, chosen from a list by index, or returned from an instruction.

### Functions as arguments

```ts
import { type Mut, type u64 } from "typesol";

export interface Out {
  v: u64;
}

function applyTwice(f: (x: u64) => u64, v: u64): u64 {
  return f(f(v));
}

function dbl(x: u64): u64 {
  return x * 2n;
}

export function run(out: Mut<Out>, k: u64): void {
  out.v = applyTwice(dbl, out.v);
  out.v = applyTwice((x) => x * 3n, out.v);
  out.v = applyTwice((x) => x + k, out.v);
}
```

A helper may take a function parameter. It is compiled once per named function passed (a helper, or a local function
that captures nothing). An arrow written at the call works too (`applyTwice((x) => x * 3n, v)`: its types come from the
parameter) when it reads none of the caller's variables. Given a closure (one that reads them, as `(x) => x + k`), the
helper is expanded where it is called instead, like a closure, so it runs where the closure can (its type parameters
bound from the call, its accounts the caller's).

### Generic helpers

```ts
import { type Mut, type u8, u64 } from "typesol";

export interface Point {
  x: u64;
  y: u64;
}

export interface Out {
  v: u64;
  p: Point;
}

function bigger<T extends bigint>(a: T, b: T): T {
  return a > b ? a : b;
}

function pick<T>(first: boolean, a: T, b: T): T {
  return first ? a : b;
}

export function run(out: Mut<Out>, x: u8, y: u8, first: boolean): void {
  out.v = bigger(out.v, 3n) + u64(bigger(x, y));
  const home: Point = { x: 1n, y: 2n };
  out.p = pick<Point>(first, home, out.p);
}
```

`function max<T extends bigint>(a: T, b: T): T` is compiled once per set of types it is called with (`max(a, b)` with
`u64` arguments, or `max<u128>(x, 1n)` when only literals tell). A type parameter stands for an integer, boolean,
`Pubkey`, enum or fixed-size struct (`pick<Point>(…)`, or from struct arguments; a struct `T` is copied like any struct
value). Each instance is checked like any helper; one that is never called is not compiled (TypeScript still
type-checks it). Arithmetic on `T` is a `bigint` to TypeScript: write `return (a + b) as T` (`as` names a type the
value already has; it never converts). Local functions and arrows passed inside a generic helper are refused: declare
them at the top level.

## What is refused

Each row was compiled; the message is the compiler's, today, or TypeScript's where TypeScript refuses first. Messages
may gain a hint line.

| Construct | Example | Message |
| --- | --- | --- |
| classes | `class Counter { n = 0n; }` | classes are not supported: describe account data with an interface and logic with functions |
| `async` | `export async function f(): Promise<void> {}` | instructions cannot be async or generators |
| `async` helpers | `async function h(): Promise<void> {}` | helper functions cannot be async |
| generators | `function* ids(): Generator<u64> { yield 1n; }` | helper functions cannot be generators |
| `await` | `const y = await n;` | 'await' expressions are only allowed within async functions and at the top levels of modules. |
| `throw` | `throw new Error("bad");` | throw is not supported: fail the instruction with require(false, ErrorCode.X) or require(cond, "message") |
| `try` / `catch` / `finally` | `try { b.value = 1n; } catch { b.value = 2n; }` | try/catch is not supported: a failed check or CPI aborts the whole instruction, so check first with require(…) |
| `number` literals | `b.value = 1;` | Type 'number' is not assignable to type 'bigint'. hint: integers (u64, u32, i64 …) are bigint in TypeSOL: write 1n, not 1, and take u64, not number |
| floats | `b.value = 1.5;` | Type 'number' is not assignable to type 'bigint'. |
| `number` in a loop | `for (let i = 0; i < 3; i++) {}` | use a bigint literal (0n): TypeSOL integers are bigints |
| `number`, `any`, `unknown`, `T[]`, tuples | `export function f(x: number): void {}` | parameter type must be an integer, boolean, Pubkey, string, or an account type (…) |
| `any` locals | `const y: any = n;` | local type must be an integer, boolean, Pubkey, enum, option or string |
| `var` | `var y = n;` | use const or let, not var |
| `let` without a value | `let x: u64;` | declare one plain name with an initializer |
| top-level `let` and `var` | `let total = 0n;` (top level) | top-level variables must be const literals |
| top-level statements | `log("start");` (top level) | this kind of statement (ExpressionStatement) is not supported at the top level of a TypeSOL file |
| reassigning a parameter | `n = 3n;` | "n" is const or an argument and cannot be reassigned |
| writing an argument | `p.x = 3n;` (`p: Point` argument) | instruction arguments are read-only; copy the value into a local first |
| `for … in` | `for (const k in b) {}` | for … in is not supported: use for (init; cond; step), for (const x of list), while or do … while |
| labels | `outer: for (…) { break outer; }` | LabeledStatement is not supported in TypeSOL |
| truthiness | `if (n) log("x");` | expected boolean, got u64 |
| indexing with `[ ]` | `b.value = b.xs[0];` | indexing with [ ] is not supported: use .get(i) and .set(i, value), with i a bigint (0n) |
| array literals as values | `const a = [1n, 2n];` | arrays are only allowed inline as seeds/CPI lists; declare local arrays with fixedArray<T, N>(fill) |
| untyped object literals, spread | `const o = { a: 1n };` | an object literal needs a struct type here: give it one (const p: Point = { … }), … |
| `new` | `const m = new Map<u64, u64>();` | this syntax (NewExpression) is not supported in TypeSOL expressions |
| `typeof` | `const t = typeof n;` | typeof is not supported at run time: the types are known when the program compiles |
| `delete` | `const k = delete b.value;` | The operand of a 'delete' operator must be optional. (TypeScript; on an operand TypeScript accepts: delete is not supported: account fields always exist; set the value instead) |
| `void` | `const v = void n;` | this syntax (VoidExpression) is not supported in TypeSOL expressions |
| `instanceof` | `if (b instanceof Object) {}` | operator instanceof is not supported |
| `in` | `if ("value" in b) {}` | operator in is not supported |
| the comma operator | `y = (b.value = 1n, 2n);` | operator , is not supported |
| regular expressions | `const r = /a/;` | this syntax (RegularExpressionLiteral) is not supported in TypeSOL expressions |
| tagged templates | ``const t = String.raw`x`;`` | this syntax (TaggedTemplateExpression) is not supported in TypeSOL expressions |
| `undefined` | `if (b.value === undefined) {}` | unknown name "undefined" |
| optional parameters | `export function f(x?: u64): void {}` | optional parameters are not supported; use x: Option<T> and pass null for none |
| default parameters | `export function f(x: u64 = 1n): void {}` | default values are not supported; the client passes every argument |
| rest parameters | `export function f(...x: u64[]): void {}` | ...rest parameters are not supported; take a Vec<T> argument, or remainingAccounts() for accounts |
| optional fields | `export interface O { v?: u64 }` | optional fields are not supported; use v: Option<T> (null for none) |
| methods in interfaces | `export interface G { v(): u64 }` | structs may only contain plain fields |
| enum initializers | `export enum E { A = 1, B = 2 }` | value enum members are numbered 0, 1, 2… in order; leave out initializers |
| nested `function` declarations | `function inner(x: u64): u64 { return x; }` (in a body) | FunctionDeclaration is not supported in TypeSOL |
| recursion | `function a(x: u64): u64 { return x === 0n ? 0n : a(x - 1n); }` | recursion is not supported: a -> a |
| helpers without a return type | `function h(x: u64) { return x; }` | helper functions need an explicit return type (void, an integer, boolean, Pubkey or a struct) |
| namespaces | `namespace N { export const x = 1n; }` | namespaces are not supported: use separate files and import from them |
| npm and Node.js imports | `import { x } from "lodash";` | only imports from "typesol" and relative TypeSOL files ("./math") are allowed, got "lodash" |
| default and namespace imports | `import * as ts from "typesol";` | use named imports: import { ... } from "typesol" |
| `console` | `console.log("x");` | 'console' does not exist in a Solana program … hint: a program writes logs with log("…") from "typesol" |
| `Math` | `const m = Math.max(1, 2);` | unsupported call: Math.max; use max(a, b) |
| `BigInt` | `b.value = BigInt(5);` | unsupported call: BigInt; use u64(x) or another integer cast |
| `Date` | `const d = Date.now();` | unsupported call: Date.now; use now() (the Clock's unix timestamp) |
| `JSON` | `log(JSON.stringify(n));` | unsupported call: JSON.stringify; use log(…) with the values |
| string `.length` | `const l = t.length;` | use byteLength(s) for strings; .length is available on arrays, Vecs and remainingAccounts() |
| string methods | `const c = t.slice(0, 1);` | unsupported call: t.slice |
| `as` conversions | `b.value = x as u64;` (`x: u8`) | this is a u8, not a u64: \`as\` does not convert (use u64(x) and the like for integers) |
| mixed integer widths | `b.value = b.value + x;` (`x: u8`) | operands have different types: u64 and u8; convert with u64(...) etc. |
| unary minus on unsigned | `b.value = -n;` | unary minus needs a signed integer (i8 … i128) |
| operators on `f64` | `b.value = r.x + r.x;` (`r.x: f64`) | + on an f64 is not supported: an f64 is held as its IEEE 754 bits and there is no float arithmetic (this would compute on the bits); compute in integers and make the result with f64FromBits(bits), or take an f64's bits with f64Bits(x) |
| `===` on `f64` | `if (r.x === r.y) {}` (`f64` fields) | === on an f64 is not supported: an f64 is held as its IEEE 754 bits, and equal bits are not equal numbers (NaN would equal itself, 0 would not equal -0); to compare the bits, write f64Bits(a) === f64Bits(b) |
| an `f64` as an integer | `b.value = r.x;` (`r.x: f64`) | an f64 is not an integer, so it is not converted to u64: it is held as its IEEE 754 bits, and the integer would be those bits; to use the bits, write f64Bits(x) |
| an `f64` as text | ``log(`${r.x}`);`` (`r.x: f64`) | an f64 cannot be written as text: there is no float formatting, and the digits would be its IEEE 754 bits read as an integer; to show the bits, write f64Bits(x) |
| `?.` on a non-optional value | `const v = b?.value;` | ?. works on optional accounts and Option<struct> values (other values are never null) |
| `let` struct references | `let q = b.home;` | bind struct references with const |
| nested destructuring | `const { home: { x } } = b;` | nested destructuring is not supported; destructure in two steps |
| rest in destructuring | `const { value, ...rest } = b;` | ...rest is not supported in destructuring |
| defaults in destructuring | `const { value = 3n } = b;` | default values are not supported in destructuring |
| array destructuring | `const [p, q] = [1n, 2n];` | array destructuring is only for const [address, bump] = findProgramAddressWithBump(seeds, program) |
| `switch` on strings | `switch (t) { case "a": break; }` | switch works on integers and enums |
| non-constant `case` labels | `case b.value:` | case labels must be literals, constants or enum members |
| writing a helper's parameter | `function h(p: Point): void { p.x = 1n; }` | helper parameters are read-only: declare p as Inout<T> to change the caller's value in place, or copy it into a local first |
| `Vec` locals | `const v: Vec<u64> = fixedVec([]);` | local type must be an integer, boolean, Pubkey, enum, option or string |
| an unused proof or signature check | `merkleVerify(leaf, proof, root);` | the result of merkleVerify is discarded, so nothing is checked: it returns whether the proof holds; write require(merkleVerify(…), error) |
| a proof check in an empty `if` | `if (merkleVerify(leaf, proof, root)) {}` | the result of merkleVerify is not acted on: the if around it has an empty body, so nothing is checked: it returns whether the proof holds; write require(merkleVerify(…), error) |
| a proof check kept in a local never read | `const ok = merkleVerify(leaf, proof, root);` (`ok` unused) | the result of merkleVerify is never read (ok is not used), so nothing is checked: it returns whether the proof holds; write require(merkleVerify(…), error) |
| a `@code` tag outside a doc comment | `export enum E { A = "a", /* @code 6100 */ B = "b" }` | this @code tag is not read: only a doc comment (/** … */) is, not a /* … */ comment; write /** @code … */ above B |
| a `@code` tag after other code on its line | `export enum E { A = "a", /** @code 6100 */ B = "b" }` | this @code tag is not read: other code comes before it on its line; put /** @code … */ on its own line above B |

**Next:** [Accounts](language-accounts.md): account parameters and the checks they emit.
