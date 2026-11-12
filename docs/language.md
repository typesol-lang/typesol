# The TypeSOL language

TypeSOL is a subset of TypeScript that compiles to Solana programs. A program is a `.ts` file: its exported functions
are instructions, its exported interfaces are account data, and its parameter types say which accounts are checked and
how. The TypeScript compiler type-checks it against `lib/typesol.d.ts`; TypeSOL then refuses what is outside the
language, lowers the rest to C and builds an SBF program with clang, and writes an Anchor-compatible IDL and a typed
client. Nothing runs on chain but the compiled code.

What differs from TypeScript, in short:

- Integers are bigints of a declared width (`u8` … `u128`, `i8` … `i128`, `1n` literals), and every arithmetic
  operation is checked. There is no `number` and no floating point.
- Everything comes from `"typesol"`: no Node.js, no npm packages, no `console`, no `Math`.
- No `class`, `async`, `throw` or `try`: a failed `require` (or check, or overflow) ends the instruction and fails the
  whole transaction, whose changes the runtime discards.
- Every type's layout is known when the program compiles. Locals and struct fields have a fixed size: strings in
  accounts are `FixedString<N>`, lists are `FixedArray` or `FixedVec`. What varies in length is a `string` or `Vec`
  argument (read in place from the instruction data), a `Vec` field (the account grows) and a string built at run time
  (on the heap). There are no dynamic objects.

For a tour, start with the [README](../README.md); to port an Anchor program, [migrate from
Anchor](migrate-from-anchor.md). New to Solana? [Language basics](language-basics.md#solana-in-a-dozen-lines) starts
with the terms the guide uses.

## The guide

Read in order, or jump to what you need. Every example on these pages is a complete program that compiles, unless it
is marked as a fragment.

| Page | What it covers |
| --- | --- |
| [Language basics](language-basics.md) | Solana in a dozen lines, then what a program is: the file, imports, instructions, account data, helpers, constants, multiple files, what the compiler derives, stack and heap, limits and costs (rent, compute, transaction and account sizes) |
| [Types](language-types.md) | integers and checked arithmetic, casts, `u256`, booleans, `Pubkey`, strings, enums, data enums, structs, `Option`, lists, `f64`, heap values, with their bytes and limits |
| [Statements and functions](language-statements.md) | which TypeScript is TypeSOL: declarations, copies and references, control flow, destructuring, helpers, `Inout<T>`, closures, generics, and what is refused |
| [Accounts](language-accounts.md) | account parameters and the checks they emit, creating, closing and resizing accounts, constraints, optional accounts, account groups, remaining accounts, account layouts |
| [PDAs](language-pdas.md) | seeds, bumps, `Seeds<…>`, `requirePda`, deriving addresses, signing as a PDA, PDAs in the IDL |
| [Errors, logs, events and return values](language-errors-events.md) | `require`, error enums and codes, `log`, `emit`, `emitCpi`, return values |
| [Calling other programs](language-cpi.md) | the System, Token, Token-2022, Associated Token, Memo, Metaplex and Stake programs, typed calls from an IDL, `invoke`, `invokeInstruction`, transfer hooks |
| [Sysvars, hashes, signatures and oracles](language-chain.md) | the clock and other sysvars, hashing, signature checks, instruction introspection, Pyth, Switchboard, randomness |
| [Porting a native program](language-native.md) | advanced: the `@fallback` entry, raw account views, Borsh accounts, `BigVec`, the red-black tree, byte builders, Rust's panics and log lines |
| [Built-ins](language-builtins.md) | every name `"typesol"` exports, one line each, generated from `lib/typesol.d.ts` |
| [Glossary](glossary.md) | the Solana and TypeSOL terms the guide uses: account, owner, rent, PDA, CPI, IDL, compute units, … |

Then: [test your program](test-your-program.md) in LiteSVM, call it from [the generated client](client.md),
[deploy it](mainnet.md), and when something fails, [troubleshooting](troubleshooting.md).

The error codes are in [errors.md](errors.md); what a compiled program checks for you and what is left to you, in the
[security model](security-model.md).

## Not supported yet

- A struct holding a FixedVec that is both an argument and account data (its bytes differ there, and the IDL describes
  a type one way): declare one for each.
- Growing an account by more than 10 KiB in one instruction (Solana's limit): realloc again in the next instruction.
- `?.` and `!` on anything but optional accounts, Options and a `find` on struct elements.
- Functions stored in a struct, chosen from a list by index, or returned from an instruction.
- A fused `map` to strings: store it, annotated.
- Floating point (by design).

They are rejected at compile time rather than half-supported.

## Index of the former sections

Where each part of the language is described, under the headings this page used to have.

### Types and statements

| Topic | Where |
| --- | --- |
| instructions: exported functions, parameters, results | [Basics: Instructions](language-basics.md#instructions) |
| account data: exported interfaces, nesting | [Basics: Account data](language-basics.md#account-data) |
| integers, literals, checked operators, `++` `+=` … | [Types: Integers](language-types.md#integers) |
| `mulDiv`, `mulDivCeil`, `isqrt`, `min`, `max` | [Types: Integer helpers](language-types.md#integer-helpers) |
| casts (`u8(x)` …) | [Types: Casts](language-types.md#casts) |
| `u256` | [Types: u256](language-types.md#u256) |
| `boolean` | [Types: Booleans](language-types.md#booleans) |
| `Pubkey`, `Hash`, `pubkey("…")` constants | [Types: Pubkey and Hash](language-types.md#pubkey-and-hash) |
| `string`, `FixedString<N>` | [Types: Strings](language-types.md#strings) |
| strings built at run time, templates | [Types: Strings built at run time](language-types.md#strings-built-at-run-time) |
| unit enums | [Types: Enums](language-types.md#enums) |
| data enums | [Types: Data enums](language-types.md#data-enums) |
| structs, struct literals, struct values | [Types: Structs](language-types.md#structs) |
| file-local structs | [Types: File-local structs](language-types.md#file-local-structs) |
| struct, list and Option arguments | [Types: Struct arguments](language-types.md#struct-arguments) |
| `Option`, `??`, `?.`, `!`, options of structs and arrays | [Types: Option](language-types.md#option) |
| `FixedArray`, `fixedArray` locals | [Types: FixedArray](language-types.md#fixedarray) |
| `FixedVec`, local lists, `pushAll` | [Types: FixedVec](language-types.md#fixedvec) |
| `Vec` in account data and as arguments | [Types: Vec](language-types.md#vec) |
| list callbacks (`map`, `filter`, `find`, …) | [Types: List methods](language-types.md#list-methods) |
| `f64` | [Types: f64](language-types.md#f64) |
| the heap, `@heap`, `HEAP_SIZE_KIB` | [Types: Heap values](language-types.md#heap-values), [Basics: Memory](language-basics.md#memory-stack-and-heap) |
| `const` and `let`, copies and references | [Statements: Declarations](language-statements.md#declarations), [Copies and references](language-statements.md#copies-and-references) |
| destructuring | [Statements: Destructuring](language-statements.md#destructuring) |
| ternaries, evaluation order | [Statements: Expressions](language-statements.md#expressions) |
| loops | [Statements: Loops](language-statements.md#loops) |
| `switch` | [Statements: switch](language-statements.md#switch) |
| helpers, how arguments are passed, `@noinline` | [Statements: Helpers](language-statements.md#helpers) |
| `Inout<T>` parameters | [Statements: Inout parameters](language-statements.md#inout-parameters) |
| arrow functions and closures, functions as values | [Statements: Arrow functions and closures](language-statements.md#arrow-functions-and-closures) |
| functions as arguments | [Statements: Functions as arguments](language-statements.md#functions-as-arguments) |
| generic helpers | [Statements: Generic helpers](language-statements.md#generic-helpers) |
| top-level constants | [Basics: Constants](language-basics.md#constants) |
| type aliases | [Basics: Type aliases](language-basics.md#type-aliases) |
| multiple files | [Basics: Multiple files](language-basics.md#multiple-files) |
| JSDoc in the IDL | [Basics: What the compiler derives](language-basics.md#what-the-compiler-derives) |
| errors, `require`, error codes | [Errors: require](language-errors-events.md#require), [Error enums](language-errors-events.md#error-enums) |
| `log` | [Errors: log](language-errors-events.md#log) |
| `emit`, events | [Errors: Events](language-errors-events.md#events) |
| `emitCpi` | [Errors: Events through CPI](language-errors-events.md#events-through-cpi) |
| `@layout borsh` (Anchor's account bytes) | [Accounts: @layout borsh](language-accounts.md#anchors-account-bytes-layout-borsh) |
| `@repr`, `@serialization bytemuck` | [Accounts: Zero-copy types](language-accounts.md#zero-copy-types-as-anchors-idl-describes-them) |
| `@bytes`, `@idlName`, `key_` | [Accounts: Field names and bytes for the IDL](language-accounts.md#field-names-and-bytes-for-the-idl) |
| accounts created by hand, `initAccount` | [Accounts: Accounts created by hand](language-accounts.md#accounts-created-by-hand) |
| remaining accounts, `loadAccount` | [Accounts: Remaining accounts](language-accounts.md#remaining-accounts) |
| other programs' accounts, `readData`, `writeData` | [Accounts: Other programs' accounts](language-accounts.md#other-programs-accounts) |
| `realloc`, `resizeAccount` | [Accounts: Closing and resizing](language-accounts.md#closing-and-resizing) |
| sysvars | [Chain: Sysvars](language-chain.md#sysvars) |
| hashing, signatures, `findProgramAddress` | [Chain: Hashing](language-chain.md#hashing), [Signatures](language-chain.md#signatures), [PDAs: Deriving addresses](language-pdas.md#deriving-addresses-in-the-body) |
| oracles | [Chain: Oracles](language-chain.md#oracles) |
| randomness | [Chain: Randomness](language-chain.md#randomness) |
| Token-2022 extension reads | [CPI: Token-2022 extension reads](language-cpi.md#token-2022-extension-reads) |
| Metaplex Core | [CPI: Metaplex Core](language-cpi.md#metaplex-core) |
| compressed NFTs | [CPI: Compressed NFTs](language-cpi.md#compressed-nfts-bubblegum) |
| native Borsh accounts (`loadBorsh`) | [Native: Borsh accounts](language-native.md#borsh-accounts) |
| `BigVec` | [Native: BigVec](language-native.md#lists-over-the-rest-of-an-account-bigvec) |
| views at run-time offsets | [Native: Views at run-time offsets](language-native.md#views-at-run-time-offsets) |
| lib-sokoban's red-black tree | [Native: Red-black tree](language-native.md#lib-sokobans-red-black-tree) |

### Account parameters and the checks they emit

| Topic | Where |
| --- | --- |
| every account type and what it checks | [Accounts: Account parameters](language-accounts.md#account-parameters-and-the-checks-they-emit) |
| `Init`, `InitIfNeeded`, `create`, `space` | [Accounts: Creating accounts](language-accounts.md#creating-accounts) |
| `Zeroed<T>`, `Signed<Zeroed<T>>` | [Accounts: Zeroed accounts](language-accounts.md#zeroed-accounts) |
| `Migrate<From, To>` | [Accounts: Migrating an account](language-accounts.md#migrating-an-account) |
| constraints: `HasOne`, `Seeds`, `CloseTo`, `Address`, `Owner`, `Executable`, `Signed`, your own errors, `constraint(…)` | [Accounts: Constraints](language-accounts.md#constraints) |
| `Seeds<…>`, `"@name"`, bumps, `pdaBump` | [PDAs: Seeds constraints](language-pdas.md#seeds-constraints) |
| token accounts and mints, `TokenOf`, `MintOf`, `Ata` | [CPI: Token accounts and mints as parameters](language-cpi.md#token-accounts-and-mints-as-parameters) |
| `Init<Mint>`, `Init<TokenAccount>`, ATAs, mint extensions | [CPI: Creating mints and token accounts](language-cpi.md#creating-mints-and-token-accounts) |
| optional accounts | [Accounts: Optional accounts](language-accounts.md#optional-accounts) |
| account groups | [Accounts: Account groups](language-accounts.md#account-groups) |
| `ProgramData` | [Accounts: ProgramData](language-accounts.md#programdata) |
| the `@fallback` entry | [Native: The fallback entry](language-native.md#the-fallback-entry) |
| `InstructionsSysvar` introspection | [Chain: Instruction introspection](language-chain.md#instruction-introspection) |
| program and sysvar parameters | [Accounts: Account parameters](language-accounts.md#account-parameters-and-the-checks-they-emit) |
| `MAX_ACCOUNTS` | [Accounts: How many accounts](language-accounts.md#how-many-accounts) |
| two parameters, one account (2040), `Dup<…>` | [Accounts: Two parameters, one account](language-accounts.md#two-parameters-one-account) |

### Built-ins

| Topic | Where |
| --- | --- |
| `systemProgram.transfer`, `createAccount`, `createPda` | [CPI: The System Program](language-cpi.md#the-system-program) |
| token program methods | [CPI: Tokens](language-cpi.md#tokens) |
| `account.lamports`, `close` | [Accounts: Closing and resizing](language-accounts.md#closing-and-resizing) |
| `requirePda` | [PDAs: Checking a PDA in the body](language-pdas.md#checking-a-pda-in-the-body) |
| every exported name | [Built-ins](language-builtins.md) |

### Implementing another program's interface (transfer hooks)

See [Calling other programs: transfer hooks](language-cpi.md#implementing-another-programs-interface-transfer-hooks).

### Calling other programs

| Topic | Where |
| --- | --- |
| `invoke`: program, accounts, data | [CPI: invoke](language-cpi.md#invoke) |
| signer seeds, `signer([…])` | [PDAs: Signing as a PDA](language-pdas.md#signing-as-a-pda) |
| `returnData` | [CPI: Return data](language-cpi.md#return-data) |
| `invokeInstruction` | [CPI: invokeInstruction](language-cpi.md#invokeinstruction) |
| `typesol cpi`: typed calls from an IDL | [CPI: Typed calls from an IDL](language-cpi.md#typed-calls-from-an-idl) |
| Associated Token, Memo, Token Metadata, Stake | [CPI: Associated Token, Memo, Metadata and Stake](language-cpi.md#associated-token-memo-metadata-and-stake) |

### PDAs in the IDL

See [PDAs: PDAs in the IDL](language-pdas.md#pdas-in-the-idl).

### Programs and sysvars passed as remaining accounts

See [Calling other programs: programs and sysvars passed as remaining
accounts](language-cpi.md#programs-and-sysvars-passed-as-remaining-accounts).

### Porting a native program

See [Porting a native program](language-native.md): the [fallback entry](language-native.md#the-fallback-entry),
[accounts without a discriminator](language-native.md#accounts-without-a-discriminator),
[writes as the original makes them](language-native.md#writes-as-the-original-makes-them) (`NATIVE_ACCOUNT_WRITES`),
[closing and resizing by hand](language-native.md#accounts-closed-reassigned-and-resized-by-hand),
[errors and panics](language-native.md#errors-and-panics-as-the-original-reports-them),
[log lines](language-native.md#log-lines-as-the-original-writes-them),
[byte strings](language-native.md#byte-strings-built-by-hand) and
[return data](language-native.md#return-data-as-the-original-sets-it).

**Next:** [Language basics](language-basics.md).
