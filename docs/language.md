# The TypeSOL language

The full reference. For a tour, start with the [README](../README.md).

## Types and statements

| Concept | TypeSOL |
| --- | --- |
| Instruction | an exported function returning `void`, one integer / boolean / `Pubkey`, a `string` (a Borsh String), or a fixed-size struct (sent as return data, at most 1024 bytes; `returns` in the IDL, and the generated client decodes it) |
| Account data | an exported `interface` with fixed-size fields; interfaces nest (`home: Point`, `trail: FixedArray<Point, 4>`) |
| Integers | `u8` `u16` `u32` `u64` `u128` `i8` `i16` `i32` `i64` `i128` — bigint literals (`1n`), every `+ - * / % **` (and `+=` … `**=`) checked (`**` aborts on a negative exponent, as JS throws); `& \| ^` on equal types, `~` within the width, `<<` / `>>` checked (amount below the width, `<<` may not lose bits). `u256` is for computation (sqrt-price and liquidity math): locals, helper parameters and results, the same checked operators and comparisons, `u256(x)` from any unsigned value and `u128(x)` / `u64(x)` back (4102 when it does not fit); never in account data, arguments, events, return data or CPI data (the IDL has no 256-bit integer), and logged only when it fits in 128 bits |
| Integer helpers | `mulDiv(a, b, c)` / `mulDivCeil` (u64 through a 128-bit product, u128 through a 256-bit one, u256 through a 512-bit one), `isqrt(x)` (up to u128), `min(a, b)`, `max(a, b)` |
| Other scalars | `boolean`, `Pubkey` (compare with `===` or `.equals`) |
| Errors | `export enum MyError { Name = "message" }` + `require(cond, MyError.Name)` → codes 6000+ (`/** @code 6200 */` before a member jumps to that code, Anchor's `Name = 200`; `Name = ""` has no message in the IDL); `require(cond, "message")` makes an error of its own (`RequireFailed<N>`, numbered after the enums' errors; one per distinct message, listed in the IDL); `require(cond, AnchorError.RequireKeysEqViolated)` fails with one of Anchor's own codes (2502 here; any anchor-lang `ErrorCode` can be raised this way); `require(cond, code)` with a `u32` value fails with that code as computed at run time (a helper returning its error: `require(r.err === 0n, r.err)`). See [errors.md](errors.md) |
| Casts | `u8(x)`, `u64(x)`, … abort if the value does not fit. A cast is a value: import `u64`, not `type u64` (one import serves as both) |
| Logging | `log("text")`, `log(value)`, `log(pubkey)` |
| Arrays | `scores: FixedArray<u64, 8>` in account data — `.get(i)`, `.set(i, v)`, `.length`, bounds-checked; elements can be structs or strings |
| Local arrays | `const xs = fixedArray<i64, 5>(0n)` — up to 256 elements on the stack; also a struct literal's field value (`{ prices: fixedArray<u64, 16>(0n), … }`), filled in place. Elements may be structs of fixed size or `FixedString<N>` (`fixedArray<Meta, 2>({ pubkey, isSigner: false, isWritable: true })`: the fill built once and copied into each slot), and `fixedArray<T, N>(fill)` written inline feeds a chain, a list method or `for … of` (`fixedArray<u64, 3>(2n).map((x) => x * 5n).reduce(…)`) |
| Local lists | `const metas: FixedVec<Meta, 4> = fixedVec([{ pubkey: k, isSigner: false, isWritable: false }])`, `const buf: FixedVec<u8, 600> = fixedVec([])`, `const pair: FixedArray<Meta, 2> = fixedArray(meta)` — a FixedVec or FixedArray of integers, booleans, Pubkeys, enums, `FixedString<N>` or fixed-size structs on the stack, with `get`, `set`, `push`, `pushAll`, `pop`, `clear`, `.length`, `for … of` and the list methods (a `FixedVec<u8, N>` is also a byte buffer: `pushLE`, `pushKey`, `pushBorsh`, `setLE`, `truncate`, see [Porting a native program](#porting-a-native-program)); given another list (`const y: FixedVec<Pubkey, 4> = xs`) it is a copy, as a struct local is. Setting one up costs about the same at any size (`fixedVec([])` of 1280 bytes about 10 CU: the free slots are zeroed by the memset syscall, the elements written in place, also as a struct literal's field). One list holds at most 2 KiB (the 4 KiB stack frame is shared with the rest of the function): a bigger one is a compile error naming its size |
| Strings | `string` arguments and literals; `name: FixedString<32>` in account data (u32 length + 32 bytes); `===`, `byteLength(s)`, `log(s)`, `+=`, as PDA seeds; too-long writes abort (5105). A local bound to account text keeps its own copy |
| Copies | `a.home = b.home`, `a.trail.set(0n, a.home)` copy whole structs / arrays of the same type: assignment copies (like Rust/Anchor), binding with `const` references |
| Destructuring | `const { owner, pos: p } = acct` (or `let` for scalars to change) from a name or a field path — one declaration per name, read like `acct.owner`: scalars are copies, nested structs are references. No rest, defaults or nesting |
| Struct values | `const p: Point = { x, y }` (or a copy of another Point) — a local struct; fields can be updated, store it with `acct.home = p` |
| Pubkey constants | `const ADMIN = pubkey("4Nd1…")` (checked at compile time) or inline `pubkey("…")`; usable as seeds |
| Events | `emit<Deposited>({ owner: owner.key, amount })` — Anchor-format `Program data:` logs, listed under `events` in the IDL; event structs may hold `string`, `Option`, `FixedVec<T, N>` (its fixed layout, as in account data), `Vec<T>` (Borsh: from a Vec argument or a list in account data) and `Option<Vec<T>>`; a nested struct given as a literal is Borsh too |
| Enums | `export enum Status { Pending, Approved }` — unit variants stored as the Borsh u8 index; `Status.Approved`, `===` |
| Options | `best: Option<u64>` (or `u64 \| null`) — `null`, `=== null`, TypeScript narrowing; `===` between options or with a value follows JS (null equals null, empty never equals a value); empty use aborts (5108); `acct?.field` on an optional account and `x.home?.field` on an `Option<struct>` give an Option (empty when the account was left out / the option is empty), `a ?? b` takes b only when a is empty (b runs only then; the result is an Option when b can be null), `x!` is the value or aborts with 5108; `${opt}` prints the value or `null`. Borsh `option` in arguments/events, fixed `{ is_some, value }` in account data |
| Vecs | `entries: Vec<Entry>` in account data, any number of them, declared anywhere: they are stored after the fixed-size fields in the order declared (so every other field keeps its offset; the IDL lists that order), and a push, pop or clear moves the Vecs after it (a reference into one of those cannot be used across it). In a `@layout borsh` struct a Vec is the last field (Anchor's order) — `get`, `set`, `push(v, payer)`, `pop()`, `clear()`, `.length`; the account is resized (realloc) and rent topped up by `payer`; `Vec<u64>` arguments are read-only views; `Vec<string>` arguments (Anchor's `Vec<String>`) are views of the instruction data, each checked as UTF-8 on entry (102), and go back out as Borsh through `invoke`; `pop()` of a Vec of structs works as a statement |
| Anchor's account bytes | `/** @layout borsh */` on an account struct stores it as Anchor does (Borsh: a `FixedString<N>` is a String, a `FixedVec<T, N>` or `Vec<T>` a Vec, an `Option` one byte when empty, and the fields after them move), so a TypeSOL program can take over accounts an Anchor program wrote and the IDL lists Anchor's own types. The instruction unpacks it into the usual fixed layout when it starts (bad bytes fail with 3003) and packs it back when it returns (3004 when the account is too small for the new value), so everything else works on it unchanged. A `Vec<T>` field (any position; integers, booleans, Pubkeys, unit enums or fixed-size structs) is Anchor's own: held on the heap while the instruction runs, growing as Rust's Vec does, bounded only by the account when it is written back (3004); its elements move when it grows, so a reference into one cannot outlive a `push` or an assignment. `Init` of such a struct takes its space, `create(payer, seeds, space)`. Programs invoked from the body (CPIs) see the account's bytes as they were when the instruction started. Costs more compute than the fixed layout (the whole account is read and written each time; see the benchmarks); nested structs and list elements must be fixed-size (FixedString elements allowed). The same struct is Borsh as a whole instruction argument (checked like Borsh deserialization, UTF-8 included), as return data and as an event; as those (not as account data) it may also hold `string` fields and data enums carrying strings, Anchor's `String` and enums in argument structs (account data takes data enums without strings); not inside list or enum arguments or `loadAccount`, and a struct holding a `Vec<T>` is account data or a whole argument, not return data or an event |
| A native program's Borsh accounts | `const pool = loadBorsh<StakePool>(acct)` / `storeBorsh(acct, pool)`: Borsh from byte 0 with no discriminator and no owner check, read into a local struct and written back, as Rust's `try_from_slice_unchecked` and `serialize` do (trailing bytes ignored when reading, left as they were when writing; invalid bytes or an account too small fail with `ProgramError.BorshIoError`). Any struct of integers, booleans, Pubkeys, enums, FixedArrays, FixedStrings, FixedVecs, Options, data enums with fixed-size payloads and nested structs of those; see [Porting a native program](#porting-a-native-program) |
| Zero-copy types as Anchor's IDL describes them | `/** @repr c */` (`@repr c packed`, `@repr c align 8`, `@repr rust` on an enum) and `/** @serialization bytemuck */` on a struct or enum put the IDL's `repr` and `serialization` there, as Anchor's `#[account(zero_copy)]` / `#[repr(C)]` types have them. TypeSOL stores fields back to back, so an unpacked `@repr c` struct must have its fields where C puts them: a field off its alignment, or a size that is not a multiple of the struct's, is a compile error naming the padding to add (Anchor zero-copy types spell their padding out as `_pad` fields, so a port matches). A 16-byte integer's alignment differs between targets: hold it as below or mark the struct packed |
| Field names and bytes for the IDL | `/** @bytes */` on an integer field: stored as the integer (little-endian), shown in the IDL as `[u8; N]` (Marginfi's `WrappedI80F48 { value: [u8; 16] }`, read and written as an `i128`); on a FixedArray of integers, each element as its bytes (`[[u8; 8]; 16]` for a `FixedArray<u64, 16>`). `/** @idlName _pad0 */`: the field's IDL name where the source cannot use it (a leading `_`). A field named like an account member plus `_` (`key_`, `lamports_`) is `key` / `lamports` in the IDL |
| Floats in events and accounts | `f64` holds a 64-bit float as its IEEE bits (Borsh writes those 8 bytes; the IDL says `f64`). There is no float arithmetic: `f64FromBits(bits)` makes one from bits the program computed in integers (Marginfi's events report I80F48 amounts this way), `f64Bits(x)` reads them back |
| Options of arrays | `Option<FixedArray<T, N>>` fields (Anchor's `Option<[u16; 3]>`): one tag byte then N elements in fixed layouts, Borsh in arguments and events |
| Fixed-capacity lists | `owners: FixedVec<Pubkey, 8>` — any field, any number of them, in nested structs too: a u32 length and room for N elements (always 4 + N × size bytes), the same `get`, `set`, `push(v)`, `pop()`, `clear()`, `.length` and `for … of`; `push` on a full one fails (5104); `xs.pushAll(items)` appends a whole list of the same elements in one copy (another FixedVec, a FixedArray or Vec, a Vec argument, the instruction data or a slice of it: a memcpy, about 0.01 CU a byte for 1000 bytes against 11 for a `push` loop), failing with 5104 and appending nothing when it does not fit (`Vec` declares it so a Vec still passes for a FixedVec, but a Vec grows one `push` at a time); `acct.owners = fixedVec([a, b])` writes a whole one (unused slots zeroed), and `acct.owners = owners` copies a `Vec` argument (or another list of the same elements) into it, Anchor's `multisig.owners = owners` (more than N fail with 5104). In account data, returned structs and events; as an argument (`ids: FixedVec<u64, 8>`) it is a Borsh Vec of at most N elements, read like a `Vec` argument (more fail with 102) |
| Native zero-copy lists | `validators: BigVec<ValidatorStakeInfo>` — SPL's `big_vec` (the stake pool's validator list): the last field of a fixed-layout struct read with `loadRaw` / `loadRawMut`, a u32 length then the elements, in an account allocated up front; its room is the account's (`.capacity`: (size − fixed fields − 4) / size(T)) and it is never resized. Loading checks that the length fits (ProgramError::AccountDataTooSmall), and every access afterwards is bounded by the room as well: a length written again after the load (writeData, another view, storeBorsh) is read as at most `.capacity`, so `.length`, `get` / `set`, the loops, `slice` and `retain` never reach past the account. `get` / `set` (5104 past the length), `push(v)` (AccountDataTooSmall when full, as BigVec::push), `retain((x) => keep)` (in place, one pass, kept runs moved with the memmove syscall; bytes past the new end keep what they held, as BigVec::retain), `for … of`, the list callbacks (`findIndex`, `find(f)!.field` on struct elements), `.length`. `list.slice(start, end?)` is BigVec::deserialize_mut_slice(start, end − start), used where it is written (`for (const v of l.validators.slice(skip, skip + n))`, `.slice(a, b).forEach(…)`, `.get(i)`, `.length`); out of range fails with AccountDataTooSmall instead of clamping. Elements are references into the account. Not an account parameter, an argument, a local, nested, or in a `@layout borsh` struct |
| Views at run-time offsets | A native account whose parts start where its header says (Phoenix's market at byte 576, trees sized by `market_size_params`, Serum's slabs): `loadRawAt<T>(acct, offset)` / `loadRawMutAt<T>(acct, offset)` are `loadRaw` / `loadRawMut` at a byte offset known only at run time, and `rawArrayAt<T>(acct, offset, capacity)` / `rawArrayMutAt<T>(…)` are `capacity` elements of a fixed-size type (integers, booleans, Pubkeys, enums, `FixedString<N>`, structs) packed in place from there, the count a run-time u64: `get` / `set` (5104 past the count), `.length` (the capacity), `for … of` and the list methods, structs by reference. The bounds are checked once, when the view is made (`offset + size`, with overflow, within the data: ProgramError::AccountDataTooSmall), and element access is pointer arithmetic. Owner (3007), writability and the one-mutable-view claim (2040) are `loadRaw` / `loadRawMut`'s, so several mutable views of one account need `NATIVE_ACCOUNT_WRITES`, as a native port declares. Bind them with const; not helper parameters |
| lib-sokoban's RedBlackTree | `const bids = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, offset, capacity, compareOrders)` (or `rbTreeAt` to read): lib-sokoban 0.3's `RedBlackTree<K, V, N>` over account bytes, byte for byte (root, allocator, 1-based nodes of registers + key + value; freed nodes keep their key and value; LIFO free list ending at the bump index), checked against the crate on a million recorded operations. `length`, `capacity`, `initialize()`, `get(k)` (the value in place, or null), `insert(k, v)` (the node index, or null when a new key finds it full; an equal key takes the value), `remove(k)` (the value, read in the freed node, or null), `min()` / `max()` (a node: `.key`, `.value`, `.index`, or null), `addrOf(k)` (0 when absent), `nodeAt(i)` (Phoenix keeps a trader's node index), `for (const e of tree)` / `tree.reversed()` with `break` / `continue`. The comparator, a function of the program `(a: K, b: K) => i8`, is called as `compare(searchedKey, nodeKey)` (Phoenix's FIFOOrderId orders by the left key's side); without one, keys are ordered as Rust derives Ord (fields in order, integers by value, Pubkeys bytewise). A reference into the tree (`get`, `min`, a node) cannot be used after an `insert` (it may reuse a freed node), and a `for … of` body cannot insert, remove or initialize on the tree it walks (compile errors, as Rust's borrows). Panics as sokoban's (see [Porting a native program](#porting-a-native-program)) |
| Struct arguments | `order: Order`, `ids: FixedArray<u8, 4>`, `orders: Vec<Order>` — fixed layouts, Borsh-identical, validated on entry (bools, enums, option tags, string lengths, enum tags; 102) and read-only. A struct holding a FixedVec that is only ever an argument is read as Anchor sends it (its FixedVec a Borsh Vec, as `@layout borsh`). A struct holding Options (at any depth, Anchor's `BankConfigOpt`) that is not account data is Borsh on the wire as Anchor sends it, an empty Option one byte; read its Some values after narrowing (`if (c.rate !== null && c.rate.zero_util !== null) …`), also an `Option<FixedArray<T, N>>` (`.get(i)`, or copied whole into a `FixedArray` field). An argument may itself be an `Option<S>` of such a struct (Anchor's `Option<WrappedI80F48>`): a tag byte, then the struct when Some; read its fields after `x !== null`; helpers take the struct, not the Option. Likewise `Option<Vec<T>>` (or `Vec<T> | null`, or of a FixedVec; Anchor's `Option<Vec<u8>>`): a tag byte, then the Vec when Some; check `x !== null` before reading it as a list or passing it to a helper that takes the list. An event may hold one too (`keys: Option<Vec<Pubkey>>`, given `null`, such an argument or a list), and a nested struct written as a literal in an event (`header: { signer: who.key, … }`) goes out as Borsh, its Options one byte when empty. A `Vec<u8>` is `bytes` in the IDL, as Anchor writes it (clients pass a Buffer) |
| Accounts created by hand | `systemProgram.createAccount(…)`, or `allocate(account, space, seeds?)` + `assign(account, owner, seeds?)` for an address someone pre-funded, then `const data = initAccount<T>(account)` (Anchor's `load_init`: owned by this program 3007, writable 3006, large enough 3003, no discriminator yet 3000) gives the struct to fill: for accounts whose address is decided at run time (a PDA or a signing keypair), as Raydium's pools are. `Init<T>` covers the usual case |
| Remaining accounts | `remainingAccounts()` — `.length`, `.get(i)` → `key`, `owner`, `lamports` (writes check writability), `isSigner`, `isWritable`; `loadAccount<T>` / `loadAccountMut<T>` give checked struct views (also of an `AccountInfo` parameter, Anchor's `AccountLoader::try_from` on an `UncheckedAccount`; the view is also its account: `.key`, `.lamports`, and it passes to a helper taking `Account<T>` / `Mut<T>`; a second `loadAccountMut` of one account is refused, 2040, but a view declared in a loop body ends with its iteration, and `loadAccountMut<Dup<T>>` in a loop also accepts an account passed more than once, one view at a time, as a route back through one pool needs); pass one to a helper that takes a `RemainingAccount` parameter (it reads the key, owner, lamports, data length and data, and loads structs from it; a `loadAccountMut` there claims the account for the rest of the instruction, so a second one fails with 2040), or all of them to one that takes `RemainingAccounts` (`.length`, `.get(i)`, passed on to other helpers; spreading them into a CPI stays in the instruction); pass them to `invoke`, one at a time or spread: `...remainingAccounts()` (each with the flags it was passed with), `...readonly(rest)` / `...writable(rest)` (all with that role), `rest.slice(a, b)` for part of them; a CPI lists at most as many accounts as an instruction takes (5113) |
| Struct literals | `book.entries.push({ who: who.key, amount, status: Status.Pending, note }, who)` — every field required |
| Struct references | `const o = side === Side.Bid ? book.bids.get(i) : book.asks.get(i)` — aliases account data like a JS object reference (no copy); replacing the referenced place (`book.bids.set(i, …)`, `pop()`, `clear()`, `acct.p = …`) while the reference is still used afterwards is a compile error, because JS would keep the old object |
| Other programs' accounts | `const pool = loadForeign<Pool>(account, AMM_PROGRAM)` — owner, `account:Pool` discriminator and size checked (3007 / 3002 / 3003); `readData<u64>(account, offset)` for raw little-endian reads (bounds-checked, 3003); `writeData<u64>(account, offset, value)` writes one into a `Mut<AccountInfo>` of this program (bounds-checked, 3003): raw layouts such as Marginfi's monitor archive |
| Ternaries | `const fee = vip ? 0n : 30n` — only the chosen branch runs. Between accounts too: `const source = ephemeral ? rest.get(5n) : reserve` picks a remaining account (`rest.get(i)`, a local or `RemainingAccount` helper parameter bound to one) or an `AccountInfo` parameter, and the result goes wherever a remaining account does (typed CPIs, `readData`, `loadRaw` / `loadRawMut`, `loadBorsh`, helpers taking a `RemainingAccount`) |
| Constants | top-level `const SEED = "vault"`, `const FEE: u16 = 30n`, `const ON = true` — inlined, usable as seeds (and described in the IDL) |
| Data enums | `export type Action = { kind: "Deposit"; amount: u64 } \| { kind: "Pause" }` — `a.kind === "Deposit"`, `switch (a.kind)`, TypeScript narrowing picks the variant (checked again at runtime, 5112); Borsh enums in arguments/events, fixed `{ tag, payload }` in account data. A variant may hold a `string` (`{ kind: "Say"; text: string }`): such an enum works in arguments, events and locals (Borsh, as Anchor encodes it) but not in account data |
| Option of structs | `home: Option<Point>` in account data — `=== null`, `p.home.x` after narrowing, `p.home = null` / `{ x, y }`; once narrowed, `p.home` (or an `Option<FixedArray>`) also passes to a helper that takes the struct (or array) |
| Strings at runtime | `"hello, " + name`, `` `#${n}` ``, `` `owner ${acct.owner}` `` (a Pubkey or Hash as base58; an `Option` of an integer, boolean, Pubkey or Hash as its value, or `null` when empty, as JS prints it: after `x !== null` that is the value) — built on the 32 KiB heap (5110 when full): a template is joined in one allocation, text known at compile time (literals, string and Pubkey constants) is folded in, and `s += …` grows the newest heap string in place |
| `switch` | on integers (128-bit ones too), enums and data-enum `.kind`, with JS `break` / fallthrough; case labels are literals, constants or enum members |
| Hashing & signatures | `sha256(...)`, `keccak256(...)` → `Hash` (a PDA seed too: its 32 bytes, as Marginfi seeds an order with the hash of its bank keys); `findProgramAddress(seeds, program)` → the canonical PDA of any program (Rust `Pubkey::find_program_address(..).0`, e.g. a Bubblegum asset id) and `findProgramAddressBump(seeds, program)` its bump; `programId()` → this program's address; `a.compare(b)` orders Pubkeys and Hashes as Rust orders their 32 bytes (-1 / 0 / 1); `merkleVerify(leaf, proof: Vec<Hash>, root)` (sorted-pair keccak, OpenZeppelin convention; inner nodes and leaves are hashed alike, so hash leaves as OpenZeppelin does, `keccak256(keccak256(data))`, and never take the leaf itself from the arguments: an inner node would pass as a leaf); `verifyEd25519(instructionsSysvar, signer, message)` checks an Ed25519 precompile instruction in the same transaction; `stackHeight()` is 1 when the transaction calls the program directly, more under a CPI (`require(stackHeight() === 1n, …)` refuses CPI callers); `verifySecp256k1(keccak256(...message) | ethMessageHash(message), recoveryId, r, s, ethAddress)` (the hash must be computed in the program; a passed-in hash could be forged) |
| Oracles | `pythPrice(update: PythPriceUpdate, feedId, maxAgeSeconds, exponent?)` (fully verified, feed-matched, fresh; with `exponent`, a feed at another scale is refused); raw `update.price / conf / exponent / publishTime` are unchecked (any feed, partially verified or stale: check `feedId`, `fullyVerified` and the age yourself, or use `pythPrice`); `switchboardValue(feed: SwitchboardFeed, expectedFeed, maxStaleSlots, decimals, minSamples?)` (the feed must be the expected one: anyone can create feeds; `minSamples`, default 1, the fewest oracle samples accepted) (mainnet program unless `SwitchboardFeed<"devnet">`) |
| Randomness | A chain has no secret randomness of its own: slot hashes and timestamps are known to, or chosen by, the block producer. `SwitchboardRandomness` (Switchboard On-Demand's RandomnessAccountData; owner, discriminator and size checked) gives verifiable randomness by commit and reveal: commit while `r.seedSlot === currentSlot() - 1n` and store `r.key` and `r.seedSlot`; settle in a later transaction after checking both, with `r.value()` (32 bytes) or `r.valueU64()`, which fail (5111) unless the value was revealed in this slot. See test/fixtures/coinflip.ts |
| Multiple files | `import { Side, min } from "./math"` — structs, enums, constants and helpers can live in other files; only the entry file's exported functions are instructions; names are program-wide, so imports from TypeSOL files cannot be renamed; error codes number imported files first |
| Loops | `for (let i = 0n; i < n; i++)`, `while`, `do … while`, `for (const x of list)` over a `Vec` or `FixedArray` (each `x` is what `list.get(i)` gives: a value, or a reference into account data for structs; the length is read again every step, as in JS), `break`, `continue` — bounded by the compute budget. Remaining accounts are iterated by index |
| Helpers | non-exported functions (and every function of an imported file): take values, structs, Vec arguments, `SignerSeeds`, remaining accounts (`RemainingAccount`, or the list: `RemainingAccounts`) and accounts the instruction already checked (`Signer`, `AccountInfo`/`AccountMeta`, `Mut<T>`, token accounts, programs); return `void`, a scalar, a `string`, a function (see below) or a fixed-size struct (`function at(x: u64, y: u64): Point { return { x, y }; }`: the caller gets its own copy, to bind, store with `acct.home = at(…)` / `arr.set(i, at(…))` or read as `at(…).x`); a struct, data-enum or `fixedArray<T, N>(fill)` argument may be written in place (`applyFee({ denominator: 100n, numerator: 3n }, amount)`, nested literals and a ternary with a literal branch too), built in a local of its own as `const fee: Fee = { … }` would be; no recursion. Struct, list and data-enum parameters are read-only (passed by pointer, or copied at the call when the helper also takes accounts); `Inout<T>` (below) gives the helper the caller's place to change. A helper that takes a struct account as `Mut<T>` can grow its Vec (`push(value, payer)`: the account's size at instruction entry is passed along) |
| `Inout<T>` parameters | `function addEvent(rec: Inout<Recorder>, e: Event): void { rec.count += 1n; … }` is Rust's `rec: &mut Recorder`: the helper gets the caller's place itself (a pointer, no copy: about the compute units of the same code written inline) and the caller sees its writes after the call, as JS shares an object passed to a function. `T` is a fixed-size struct, a `FixedArray<T, N>` or a `FixedVec<T, N>` (its `push`, `pop` and `clear` included). The argument is a writable place: a local struct or list, a `loadBorsh` local, a field path of a local, of a `loadRawMut` view or of a `Mut<T>` account, a list element (`book.levels.get(i)`, a narrowed Option's value), another `Inout` parameter (passed on), or a literal (a fresh value nobody else sees); a read-only one (a field of an `Account<T>`, a `loadRaw` view, an instruction argument, a read-only parameter) is a compile error naming what to change. At each call, so that the helper's parameter is the only way to the place while it runs: no other argument may share storage with an Inout one (one place inside the other; two elements of one list, whatever their indexes, a BigVec slice's elements included; an account and a place inside it; a read-only struct argument inside it: pass a copy); an element of a `Vec` or `BigVec` is refused when the call may resize or filter that list (the helper takes writable or remaining accounts), since its elements would move; and a reference into the place (`const e = p.items.get(0n)`) that is read after the call is refused, since the helper may replace what it points at (copy the fields first, or read them through the place). Places that differ in the source but may be one account at run time (two `Dup<…>` accounts, two `loadRawMut` views under `NATIVE_ACCOUNT_WRITES`, a helper's own account parameters) are compared before the call: 2040 when they overlap. One pair is left to run time: a place in a `loadRawMut` view passed with the `RemainingAccount` it was loaded from (without `NATIVE_ACCOUNT_WRITES` a second `loadRawMut` of it in the helper fails, 2040; with the flag the helper can load and write the same bytes, the flag's trade-off). Integers, Pubkeys, strings and Options are values, which JS copies into a function too: return the new value (`x = f(x)`) or keep it in a struct and take `Inout<ThatStruct>`. `Vec<T>`, `BigVec<T>`, accounts and data enums are refused with what to write instead, and so is `Inout<T>` anywhere but a helper's parameter. Closures (and helpers expanded because they were given one) take `Inout<T>` the same way; their struct parameters were references already |
| Arrow functions and closures | `const fee = (x: u64): u64 => x / 100n` (or `const f = function (…) {…}`) at the top level or inside a function. One that reads or writes the enclosing function's variables (a closure: `let total = 0n; const add = (v: u64): void => { total += v; }`) is expanded where it is called: its names mean what they meant where it was declared, struct parameters are references, `return` leaves the closure; it cannot call itself. One that captures nothing becomes a helper. Parameter types may be left out on closures (taken from the arguments). Functions are values where they can be expanded: `const h = g` names the same function, and a function that returns one (`function adder(n: u64): (x: u64) => u64 { return (x) => x + n; }`) makes a closure where it is called (`const add5 = adder(5n)`, or `adder(5n)(x)`). A function can be chosen at run time between named ones, `const g = k === 1n ? dbl : inc` (the condition is read once, there; a call runs only the chosen one), and a list of named functions can be run in turn, `for (const f of [dbl, inc]) total += f(x)` (unrolled; `continue` and `break` work) |
| Functions as arguments | a helper may take a function parameter (`function applyTwice(f: (x: u64) => u64, v: u64): u64`): it is compiled once per named function passed (a helper or a local function that captures nothing). An arrow written at the call works too (`applyTwice((x) => x * 3n, v)`: its types come from the parameter) when it reads none of the function's variables. Given a closure (one that reads them), the helper is expanded where it is called instead, like a closure, so it runs where the closure can (its type parameters bound from the call, its accounts the caller's) |
| List callbacks | on a `Vec`, `FixedArray`, `FixedVec` or `Vec` argument: `forEach`, `some`, `every`, `find` (an Option of the element; scalar elements; on struct elements read a field with `xs.find(f)!.qty`, which aborts with 5108 when nothing matched, or `xs.find(f)?.qty`, an Option), `findIndex` (i64, -1 when absent), `reduce(fn, initial)`, `includes(value)`, `indexOf(value)` (i64), `map` and `filter`. The arrow written at the call is expanded into a loop (elements as `list.get(i)` gives them, structs by reference) and may read and write the function's variables. A `map` / `filter` chain used right away (`xs.filter(f).map(g).reduce(h, 0n)`, `.length`, `for … of`) is one loop that stores nothing; callbacks after a filter get the index among the elements it let through. Stored (`const ys = xs.filter(f)`), it is a FixedVec on the stack as big as the list it starts from; from a `Vec`, give the size: `const ys: FixedVec<u64, 16> = …` (at most 2 KiB; one element more aborts with 5104). `map` gives integers, booleans, Pubkeys or enums; stored with a `FixedVec<Struct, N>` or `FixedVec<FixedString<N>, M>` annotation it gives structs (`(o) => ({ qty: o.qty })`) or text, and inside a chain it gives structs when the callback names its struct, `xs.map((o): Scored => ({ … })).filter(…).reduce(…)` (one struct per element, nothing stored) |
| Generic helpers | `function max<T extends bigint>(a: T, b: T): T` — compiled once per set of types it is called with (`max(a, b)` with u64 arguments, or `max<u128>(x, 1n)` when only literals tell); a type parameter stands for an integer, boolean, Pubkey, enum or fixed-size struct (`pick<Point>(…)`, or from struct arguments; a struct `T` is copied like any struct value). Each instance is checked like any helper; one that is never called is not compiled (TypeScript still type-checks it). Arithmetic on `T` is a `bigint` to TypeScript: `return (a + b) as T` (`as` names a type the value already has; it never converts) |
| Evaluation order | operands and arguments are read left to right, as in JS, even when a later one changes account data (`v.length + v.pop()`) |
| `++` `--` `+=` `-=` `*=` `/=` `%=` `&=` `\|=` `^=` `<<=` `>>=` | all checked |
| Sysvars | `now()`, `currentSlot()`, `currentEpoch()`, `epochStartTimestamp()` (clock), `minimumBalance(account)`, `rentExempt(space)` (rent); `slotHashes: SlotHashesSysvar` (an account, too large for the sysvar syscalls): `count`, `latestSlot`, `latestHash` (public: not a source of secret randomness); `slotsPerEpoch()`, `epochWarmup()`, `firstNormalEpoch()`, `firstNormalSlot()` (EpochSchedule); `lastRestartSlot()`; `epochRewards()` (EpochRewards through its syscall, Rust's `EpochRewards::get()`, no account: a read-only copy with `distributionStartingBlockHeight`, `numPartitions`, `parentBlockhash` (Hash), `totalPoints` (u128), `totalRewards`, `distributedRewards`, `active`; `const er = epochRewards()` or `epochRewards().active` inline, not a helper parameter); `history: StakeHistorySysvar` (an account): `count`, `latestEpoch`, `has(epoch)`, `effective(epoch)`, `activating(epoch)`, `deactivating(epoch)` (0 for an epoch not listed) |
| Account size | `realloc(account, newSize, payer)` on a `Mut<Struct>` — growing charges the payer the extra rent (at most 10 KiB per instruction, 3016); shrinking keeps the lamports in the account; never below the struct. Refused on a struct with a growable `Vec` (its push / pop / clear size the account). `resizeAccount(account, newSize)` on a `Mut<AccountInfo>` of this program is Rust's `AccountInfo::resize`: the length only, new bytes zeroed, no rent moved (fund it first: `rentExempt(newSize)`), at most 10 KiB of growth (3016) |
| Token-2022 extensions | `transferFee(mint, amount)` (current-epoch TransferFeeConfig, ceil + cap like spl-token-2022), `transferFeeInverse(mint, amountReceived)` (the fee when the recipient is to get that much: spl-token-2022's `calculate_inverse_epoch_fee`), `transferFeeBasisPoints(mint)` / `transferFeeMaximum(mint)` (this epoch's; 0 without the extension), `extensionsWithin(account, [1n, 18n, …])` (every extension is one of those types), `transferHookProgram(mint)`, `transferHookAuthority(mint)`, `permanentDelegate(mint)`, `mintCloseAuthority(mint)` (Option<Pubkey>), `hasExtension(account, type)`, `isTransferring(tokenAccount)` (inside a transfer hook: whether Token-2022 is transferring from it) |
| Events through CPI | `emitCpi<Paid>({ … }, eventAuthority, self)` with `eventAuthority: EventAuthority, self: SelfProgram` parameters — Anchor `emit_cpi!`: the event rides in a self-CPI (inner instruction), not in logs; the program accepts Anchor's event instruction (2002 / 2006 otherwise) |
| Heap | 32 KiB by default; `const HEAP_SIZE_KIB = 64n` (32–256) lets the program use more, when clients add ComputeBudget `requestHeapFrame` |
| Docs | JSDoc on instructions, `@param`, structs, fields and data enums becomes `docs` in the IDL |
| Metaplex Core | `core: MplCoreProgram` — `createCollection`, `createAsset` (in a collection, PDA authorities via signerSeeds), `transferAsset`, `burnAsset` (`null` leaves an optional account out); plugins as a literal list after the uri (`[{ kind: "Royalties", basisPoints: 500n, creators: [{ address, percentage: 100n }] }, { kind: "PermanentFreezeDelegate", frozen: false, authority: studio.key }]`), and `addPlugin` / `updatePlugin` / `removePlugin(…, "FreezeDelegate")` with their `…CollectionPlugin` forms. Plugins: Royalties (with an optional `ruleSet: { programAllowList \| programDenyList: [...] }`), FreezeDelegate, BurnDelegate, TransferDelegate, UpdateDelegate, PermanentFreezeDelegate, Attributes, PermanentTransferDelegate, PermanentBurnDelegate, Edition, MasterEdition (collections: `maxSupply?`, `name?`, `uri?`), AddBlocker, ImmutableMetadata, VerifiedCreators, Autograph, BubblegumV2, FreezeExecute, PermanentFreezeExecute (Groups is kept by Core's group instructions); `authority` is `"owner"`, `"updateAuthority"`, `"none"` or a Pubkey; `coreAssetOwner(asset)`, `coreAssetCollection(asset)`. External plugin adapters: `addExternalPlugin` / `removeExternalPlugin` / `writeExternalPluginData` (and the Collection forms) with `{ kind: "AppData", dataAuthority, schema? }`, `{ kind: "Oracle", baseAddress, checks: [{ event: "transfer", canReject: true }], resultsOffset?, baseAddressConfig? }`, `{ kind: "LifecycleHook", hookedProgram, checks, extraAccounts?, dataAuthority?, schema? }` and the Linked forms; a key names one (`{ kind: "AppData", dataAuthority }`, `{ kind: "Oracle", address }`); data is a string, a `Vec<u8>` argument or `null` (Core currently answers lifecycle hooks with NotAvailable, 23) |
| Compressed NFTs | `bubblegum: BubblegumProgram` — V1 (trees on SPL Account Compression): `createTree`, `mint` (MintV1, no collection/creators), `mintToCollection` (MintToCollectionV1: into a verified Token Metadata collection), `transfer`, `burn`, `delegate` (the leaf owner or delegate signs; a PDA owner signs with the seeds). V2 (trees on mpl-account-compression with mpl-noop): `createTreeV2`, `mintV2(…, { name, symbol, uri, sellerFeeBasisPoints, creators?, isMutable? }, { collection, authority, cpiSigner }?)` (into a Core collection that has the `BubblegumV2` plugin), `transferV2`, `burnV2`, `delegateV2`, `freezeV2` / `thawV2`, `setNonTransferableV2`, `updateMetadataV2(…, currentMetadata, { name?, symbol?, uri?, creators?, … })`, `verifyCreatorV2` / `unverifyCreatorV2`, `setCollectionV2`. Each takes the leaf (`{ root, dataHash, creatorHash, assetDataHash?, flags?, nonce, index }`, or `{ root, assetDataHash?, flags?, nonce, index }` with the leaf's current metadata for the metadata instructions) and its proof as `remainingAccounts()` / `rest.slice(a)` |

## Account parameters and the checks they emit

| Parameter type | Checked before your code runs |
| --- | --- |
| `Signer` / `Mut<Signer>` | signed (and writable) |
| `Account<T>` / `Mut<T>` | owned by this program, 8-byte discriminator matches, data large enough (and writable). A zero-copy type (`@serialization bytemuck`) is checked as Anchor's `AccountLoader` checks it: owner first (3007, also for an account never created), then a discriminator to read (3001) and match (3002), then the size |
| `Init<T>` | writable; `create(payer, seeds)` derives the PDA, verifies it, funds rent, writes the discriminator (up to 10 KiB); `create(payer, null)` creates a new keypair account that signs the transaction instead (3010 if it did not; a signer in the IDL); a third argument is Anchor's `space = …` (discriminator included, at least 8 + the struct's size). A seed may be an Option integer argument with a default, `opt ?? 0n` (the IDL records `opt.unwrap_or(0)`, as Anchor's does). The creates a body starts with (after its `constraint(…)` lines) run before the other accounts' constraints, as Anchor creates `init` accounts first; a create after other statements runs where it is |
| `InitIfNeeded<T>` | `const created = acct.createIfNeeded(payer, seeds)` — creates once; afterwards re-derives the PDA and checks owner, discriminator and size (Anchor `init_if_needed`); `acct.pdaBump` after create. An existing account is used as it is: check the fields you rely on |
| `/** @fallback */ export function legacy(): void` | Anchor's `fallback`: runs when no instruction's discriminator matches the data (short data too) instead of failing with 101; it takes no parameters and reads `const data = instructionData()` (the whole data: `data.length`, `data.get(i)`, or passed on to `invokeInstruction`) and `remainingAccounts()`. Not in the IDL. The data is a read-only list of u8: `for (const b of data)`, `map` / `filter` / `reduce` / `some` and the other list methods, `data.slice(start, end?)` (a view, nothing copied; unlike JS it does not clamp: past the length fails with 5104), `out.pushAll(data.slice(a, b))` into a local FixedVec, and a helper takes it or a slice as an `InstructionBytes` parameter |
| Account groups: `p: PoolAccounts`, where `export interface PoolAccounts { pool: HasOne<Mut<Pool>, "vault">; vault: Mut<TokenAccount>; … }` | Anchor's composite accounts (a `#[derive(Accounts)]` struct as a field of another): an interface whose fields are accounts is one parameter, its accounts the instruction's in field order. The body uses `p.pool.reserve`, passes `p.vault` to CPIs and helpers, and creates `p.pool.create(…)`. Constraints inside name the group's own fields first (`HasOne<…, "vault">`, `Seeds<…, ["pool", "@mint"]>`, `TokenOf<…, "mint", "pool">`), then the instruction's. The IDL nests them (`{ name: "p", accounts: [...] }`, seeds relative to the group); the client and `t.ix` flatten them (`pPool`, `pVault`). A field may be optional (`A \| null`) or another group (`p.fees.vault`; the IDL nests it too, the client flattens it to `pFeesVault`); a group may not be optional or a helper parameter. An instruction with a group checks in Anchor's order: its arguments first (102), then each account in order, a group's constraints right after the group's accounts (as a composite's `try_accounts` does), the other constraints last |
| `constraint(acct, condition, error?)` | Anchor's `constraint = condition @ error` on `acct`: statements at the very start of the body, run with that account's checks (after its `has_one`, before the next account; with the other constraints after the creates the body starts with), so a transaction breaking several checks gets Anchor's code; they read accounts and arguments; the default error is ConstraintRaw (2003) |
| `HasOne<A, "owner">`, `Seeds<A, ["vault", "@owner"], "bump">`, `CloseTo<A, "owner">` | declarative constraints like Anchor's `has_one`, `seeds`/`bump` and `close`: checked before the body (2001 / 2006), close runs when the instruction succeeds; `"@name"` = account key or argument bytes (`"@name:be"`: an integer's bytes most significant first, Rust's `to_be_bytes()`; the IDL records the argument, as Anchor's does, so clients that derive the address from the IDL get it wrong: pass such accounts explicitly), `"@acct.field"` = a Pubkey, integer or unit enum field of a struct account parameter (also the account's own: `["offer", "@maker", "@offer.id"]`), other strings are literals; recorded as `relations` / `pda` in the IDL. a bump stored in another struct account is named `"@acct.field"` (Anchor `bump = multisig.nonce`), or `"@acct.field.inner"` when it is in a struct field of it (Anchor `bump = config.bumps.vault`); `acct.pdaBump` is the bump (Anchor `ctx.bumps.acct`): the stored field when one is named, else the canonical bump the check found — use it to sign as the PDA |
| `HasOne<A, "owner", ErrorCode.NotOwner>`, `Address<A, "…", E.X>`, `Owner<A, "…", E.X>`, `Signed<A, E.X>`, `Mut<T, E.X>` | one of your errors instead of Anchor's code, as Anchor's `has_one = owner @ ErrorCode.NotOwner`, `address = … @ …`, `owner = … @ …`, `signer @ …` and `mut @ …` (the constraints Anchor lets you name an error for); a member of one of the program's error enums. For several `HasOne` fields with different errors, nest them: `HasOne<HasOne<Mut<V>, "owner", E.A>, "admin", E.B>` |
| `HasOne<TokenAccount, "mint" \| "owner">`, `HasOne<Mint, "mintAuthority" \| "freezeAuthority">` | token constraints (2014 / 2015 / 2016 / 2017) against the parameter with that name; `TokenOf<TokenAccount, "mintParam", "authorityParam", "tokenProgramParam">` / `MintOf<Mint, "authorityParam", "freezeParam", "tokenProgramParam">` name the parameters, as Anchor's `token::mint = …` / `mint::authority = …` / `…::token_program = …` do (`never` leaves one out; the token program one: owned by that token program, 2021 / 2022) |
| `Ata<TokenAccount, "owner", "mint">` | the account is the associated token account of those parameters (2009; ATA `pda` in the IDL); the owner may be a Pubkey field of a struct account parameter, `"@config.wallet"` (Anchor's `associated_token::authority = config.load()?.wallet`; the IDL names the account, as Anchor's does) |
| `Ata<Init<TokenAccount>, "owner", "mint">`, `Ata<InitIfNeeded<TokenAccount>, "owner", "mint">` | Anchor `init` / `init_if_needed` with `associated_token::…`: `acct.create(payer)` creates the ATA (fails if it exists); `const created = acct.createIfNeeded(payer)` creates it only when missing, otherwise checks it is that ATA (2009). Then it is a `TokenAccount` of that mint and owner (2014 / 2015). Needs `AssociatedTokenProgram`, `SystemProgram` and a token program parameter; call it at the top level before using the account |
| `Address<A, "4Nd1…">` | exact address (2012; `address` in the IDL) |
| `Owner<A, "Tokenkeg…">`, `Executable<A>` | owner program (2004), executable (2007). On a struct account, `Owner<Account<T>, "…">` is another program's account (Anchor's `Account` / `AccountLoader` of a `declare_program!` type): loaded with that program as its owner (3007) and Anchor's discriminator for `T`'s name, its fields read and `HasOne` checked as for this program's own; the IDL lists `T` among its types, not its accounts (an error named on such an `Owner` is not used: the load fails with 3007). Such a struct may carry a shorter discriminator, `/** @discriminator 0x01 */` (1 to 8 bytes, as Anchor's `discriminator = &[1]`; Solend's reserve), its fields then starting right after it; this program's own accounts keep 8 |
| `Seeds<A, ["metadata", "@mint"], never, "@metadataProgram">` | the fourth argument derives the PDA under another program (a program parameter or a base58 address; `pda.program` in the IDL) |
| `A \| null` / `Optional<A>` | optional account (Anchor `Option<Account>`): the client passes this program's id to leave it out; its checks and constraints run only when present (a `constraint(other, …)` that mentions it runs as written: `x === null` is checked when it is missing); `x !== null` before use, or `x!` / `x!.field` to assert it was passed (5115 otherwise); `optional` in the IDL |
| `ProgramData` | this program's ProgramData (address derived from the program id, upgradeable-loader owner and state checked); `upgradeAuthority`, `deploySlot` — gate admin setup on `programData.upgradeAuthority === admin.key` |
| `EventAuthority`, `SelfProgram` | Anchor's `["__event_authority"]` PDA, and this program's own address, for `emitCpi` |
| `Migrate<From, To>` | Anchor 1.0's `Migration`: an existing `From` account (owner, discriminator, size) rewritten as `To` by `acct.migrate(payer, value)`, a top-level statement the instruction must reach. `acct.from` (read-only) before it, `acct.to` after; the value is built in full before the rewrite, so it may read `acct.from`. Resized to `To` (the payer tops up rent when it grows, at most 10 KiB; shrinking keeps the lamports; growing needs `SystemProgram`). Fixed-layout structs without growable Vecs; no constraints yet; the account cannot be passed to a helper (use `acct.to` fields in the instruction). An account already migrated fails with 3002. Keep the old struct under a new name with its discriminator: `/** @discriminator account:Counter */ interface CounterV1 { … }` |
| `Zeroed<T>` | accounts (up to 10 MiB) the client allocated with System `CreateAccount`, Anchor's `zero`: discriminator still zero (2013, checked first as under Anchor), owned by this program, big enough, rent-exempt — then initialized. A `@layout borsh` struct starts empty and is written as Borsh when the instruction returns |
| `Signed<A>` | the account must sign the transaction (Anchor's `signer` constraint, 2002), e.g. `Signed<Zeroed<Multisig>>` for an account the client creates with a fresh keypair; the IDL marks it a signer |
| `Init<Mint>`, `InitIfNeeded<Mint>` | Anchor `init` / `init_if_needed` with `mint::decimals` / `mint::authority` / `mint::freeze_authority`: `const bump = mint.create(payer, ["mint", payer.key], 6n, authority, freezeAuthority \| null)` creates the mint at that PDA of this program, or with `null` seeds as a new keypair account that signs (3010 if it did not), under the instruction's token program (its only token program parameter, or one passed as the last argument of `create` / `createIfNeeded`; plus `SystemProgram`). Token-2022 extensions (Anchor's `extensions::…`) go after the freeze authority: `mint.create(payer, null, 6n, authority, null, { metadataPointer: { authority, metadataAddress: mint.key }, transferHook: { authority, programId }, closeAuthority, permanentDelegate, nonTransferable: true, defaultAccountState: true, interestBearing: { rateAuthority, rate }, transferFee: { configAuthority, withdrawAuthority, basisPoints, maximumFee }, groupPointer, groupMemberPointer })` sizes the mint for them and initializes each before InitializeMint2. With `createIfNeeded` an existing mint must carry groupPointer / groupMemberPointer / metadataPointer / closeAuthority / permanentDelegate / transferHook with those keys (Anchor's 2024–2039); extensions not listed are not looked at, so an existing mint may carry others (a permanent delegate, say). `createIfNeeded(…)` returns whether it created it; an existing one must be that PDA and have those decimals and authorities (2018 / 2016 / 2017) |
| `Init<TokenAccount>`, `InitIfNeeded<TokenAccount>` (no `Ata<…>`) | Anchor `init` / `init_if_needed` with `token::mint` / `token::authority`: `vault.create(payer, ["vault", mint.key], mint, authority)` (the authority may be `vault.key` itself) creates a token account at that PDA (or a keypair account with `null`), sized for the mint's extensions under Token-2022. `createIfNeeded` checks an existing one has that mint and owner (2014 / 2015), not its delegate or close authority (as Anchor) |
| `TokenAccount` / `Mut<TokenAccount>` | owned by SPL Token or Token-2022 (extensions allowed, multisig accounts refused), initialized (an account never created: 3012, as Anchor; a `Mint` likewise); `mint`, `owner`, `amount`, `delegate`, `delegatedAmount`, `isFrozen`, `isNative`, `closeAuthority`, `tokenProgram` |
| `Mint` / `Mut<Mint>` | owned by SPL Token or Token-2022, initialized; `decimals`, `supply`, `mintAuthority`, `freezeAuthority`, `tokenProgram` |
| `SystemProgram`, `TokenProgram`, `Token2022Program` | exact program address |
| `TokenInterface` | either token program |
| `AssociatedTokenProgram` | `create` / `createIdempotent` CPIs; `associatedTokenAddress(owner, mint, tokenProgram)` |
| `MemoProgram` | SPL Memo v2: `memoProgram.memo(text, [signers], signerSeeds?)`; each listed account signs (a PDA of this program with its seeds) |
| `TokenMetadataProgram` | Metaplex `createV3(...)` (CreateMetadataAccountV3), optionally with `{ creators: [{ address, verified, share }], collection: mint }` after `isMutable` (1–5 creators, shares adding up to 100; only the update authority, signing, can be `verified: true`; the collection is written unverified; `isCollection: true` makes the NFT a sized collection); `createMasterEditionV3(edition, mint, updateAuthority, mintAuthority, payer, metadata, tokenProgram, systemProgram, maxSupply \| null)`; `verifyCollection(authority, metadata, collectionMint, collectionMetadata, collectionMasterEdition, systemProgram, instructionsSysvar)` (Verify with CollectionV1); `updateMetadataAccountsV2(metadata, updateAuthority, data \| null, newUpdateAuthority \| null, primarySaleHappened \| null, isMutable \| null)` (`data` replaces the whole DataV2: `{ name, symbol, uri, sellerFeeBasisPoints, creators?, collection? }`; each null leaves that part); `burnV1(authority, metadata, edition \| null, mint, token, collectionMetadata \| null, systemProgram, instructionsSysvar, tokenProgram, amount)` (Burn: the holder signs and gets the rent back; the token account and edition close, the metadata is cleared to one byte); `metadataAddress(mint)`, `masterEditionAddress(mint)` |
| `StakeProgram` | `initialize(stake, rentSysvar, staker, withdrawer, lockup?)` (`lockup`: `{ unixTimestamp, epoch, custodian }`, none when left out), `authorize(stake, clockSysvar, authority, newAuthority, "staker" \| "withdrawer", custodian?)`, `delegate(stake, vote, clockSysvar, stakeHistorySysvar, stakeConfig, staker)`, `split(stake, splitStake, staker, lamports)`, `deactivate(stake, clockSysvar, staker)`, `withdraw(stake, to, clockSysvar, stakeHistorySysvar, withdrawer, lamports, custodian?)`, `merge(destination, source, clockSysvar, stakeHistorySysvar, staker)`, `getMinimumDelegation()` (a CPI, then the u64 the Stake program returns; fails as solana_program's `get_minimum_delegation` does); instruction tags and account lists as solana-stake-interface's builders; the sysvar and config accounts are parameters, as in anchor-spl's stake module, or `named(account, address)` (a native port): the instruction names `address` (`SysvarC1ock…`), as solana_program's builders do, and `account`, the slot's account, is what the runtime gets, as Rust's `invoke_signed(&ix, &[stake, clock_info, …])` passes it; the runtime looks the address up among the CPI's accounts only, so a slot holding another account fails the call (MissingAccount), as the original does, even when the sysvar is elsewhere in the transaction (`named` is valid only there); authorities and the lockup custodian sign (PDAs with signerSeeds, given last) |
| `InstructionsSysvar`, `PythPriceUpdate`, `SwitchboardFeed` | exact address (3008) / owner program + discriminator. `Address<InstructionsSysvar, "Sysvar1nstructions1111111111111111111111111">` checks the address as Anchor's `address = sysvar::instructions::ID` on an `UncheckedAccount` does (2012, with the constraints) |
| `InstructionsSysvar` (introspection) | `ixs.length`, `ixs.currentIndex()` (the top-level instruction being executed), `ixs.get(i)` → a `TransactionInstruction`: `programId`, `accountsLength`, `dataLength`, `accountKey(j)` / `accountIsSigner(j)` / `accountIsWritable(j)`, `readU8/U16/U32/U64/readPubkey(offset)` (little-endian), `is(program, "name")` (that program's instruction by its default Anchor discriminator, sha256("global:<name>"); an instruction with its own `@discriminator` is matched with `programId` and `readU64(0)` instead). Every read is bounds-checked (5104). It is the transaction author's data: require things of the transaction with it (a repay instruction after a flash loan), never treat it as proof |
| `Program<"Address…">` | exact program address + executable |
| `UncheckedProgram` | executable only — check `.key` yourself |
| `AccountInfo` / `Mut<AccountInfo>` | nothing (writable for `Mut`); `owner`, `executable` |
| `SystemAccount` / `Mut<SystemAccount>` | owned by the System Program, e.g. a wallet (Anchor `SystemAccount`, 3011) |

Every account exposes `key`, `lamports`, `dataLen`, `isSigner`, `isWritable`. At most 32 accounts per instruction (more is refused, 5113); `export const MAX_ACCOUNTS = 128n` (up to 255, Anchor takes what the runtime allows) raises it for programs that take many remaining accounts, keeping the CPI scratch lists on the heap instead of the stack (programs that do not declare it compile exactly as before).

Two writable parameters can never be the same account: aliasing is refused with error 2040 (also when a remaining
account written through `.lamports` or `loadAccountMut` is another account of the instruction). `Dup<Mut<T>>`
(Anchor's `dup`) lifts that for one parameter when both accounts are read and written in place (not created, closed
or `@layout borsh`; a close destination may be one, the rent reaching it through either): a write through either is
seen through the other, so read what you need before writing. A remaining account
can be loaded with `loadAccountMut` once per instruction: loading the same one again (`rest.get(i)` and `rest.get(j)`
with `i == j`) is refused with 2040 too, since the two views would alias. So is a second `loadAccountMut` of one
`AccountInfo` parameter; two `Dup<…>` parameters that are one account may each be loaded (one array holding both ticks
of a position, as Raydium CLMM's tick arrays).

## Built-ins

- `systemProgram.transfer(from, to, lamports, signerSeeds?)` (`from` is a `Mut<Signer>`, or a system-owned PDA of this
  program, a SOL vault, with its seeds), `systemProgram.createAccount(payer, account, lamports, space, owner, signerSeeds?)`
  (the new account signs: a keypair `Mut<Signer>` or this program's PDA), `systemProgram.createPda(payer, account, space,
  owner, seeds)` (Anchor's `init` with `seeds`, `space` and `owner = …` on an `UncheckedAccount`: a `Mut<AccountInfo>`
  that must be this program's PDA for `seeds` (2006), created owned by `owner`, or topped up, allocated and assigned when
  someone funded the address first; returns the bump, records the PDA in the IDL, and among the creates a body starts
  with runs before the constraints), `rentExempt(space)`, `MINT_SIZE`, `TOKEN_ACCOUNT_SIZE`
- Token programs (`TokenProgram`, `Token2022Program`, `TokenInterface`) — pass `signerSeeds` (with the bump) when the authority is a PDA:
  `transfer`, `transferChecked(from, mint, to, authority, amount)` (required by Token-2022 mints with fees/hooks), `mintTo` (the mint may be one this instruction just created), `burn`, `closeAccount` (a token account, or a Token-2022 mint with a close authority),
  `approve(source, delegate, owner, amount)`, `revoke`, the checked forms `mintToChecked(mint, to, authority, amount)`,
  `burnChecked(from, mint, authority, amount)` and `approveChecked(source, mint, delegate, owner, amount)` (the decimals
  come from the mint), `setAuthority(target, current, AuthorityType.MintTokens, next | null)`,
  `freezeAccount` / `thawAccount(account, mint, freezeAuthority)`, `syncNative(account)`, `initializeMint2(mint, decimals, mintAuthority, freezeAuthority | null)`,
  `initializeAccount3(account, mint, owner)`, and on Token-2022 `initializeMetadata(mint, updateAuthority, mintAuthority, name, symbol, uri)` (metadata extension) and the extension initializers to call between `createAccount` and `initializeMint2` / `initializeAccount3`: `initializeTransferFeeConfig(mint, configAuthority | null, withdrawAuthority | null, basisPoints, maximumFee)`, `initializeMintCloseAuthority(mint, authority | null)`, `initializeNonTransferableMint(mint)`, `initializePermanentDelegate(mint, delegate)`, `initializeDefaultAccountState(mint, frozen)`, `initializeMetadataPointer` / `initializeGroupPointer` / `initializeGroupMemberPointer` / `initializeTransferHook(mint, authority | null, address | null)`, `initializeInterestBearingMint(mint, rateAuthority | null, rate)`, `initializeImmutableOwner(account)`; the extension instructions `updateDefaultAccountState(mint, freezeAuthority, frozen)`, `updateTransferHook(mint, authority, programId | null)`, `enableRequiredMemoTransfers` / `disableRequiredMemoTransfers(account, owner)`, `updateInterestRate(mint, rateAuthority, rate)`, `transferCheckedWithFee(from, mint, to, authority, amount, fee)`, `harvestWithheldTokensToMint(mint, remainingAccounts())`, `withdrawWithheldTokensFromMint(mint, destination, authority)`, `setTransferFee(mint, authority, basisPoints, maximumFee)`; and the Token Metadata interface `updateMetadataField(mint, updateAuthority, field, value)` ("name" / "symbol" / "uri" or any other key), `removeMetadataKey(mint, updateAuthority, key, idempotent)`, `updateMetadataAuthority(mint, updateAuthority, next | null)`, `emitMetadata(mint)`; and the Token Group interface: `initializeTokenGroup(group, mint, mintAuthority, updateAuthority | null, maxSize)` (a collection mint with a GroupPointer to itself; fund the rent for the group, which Token-2022 adds to the account), `initializeGroupMember(member, memberMint, memberMintAuthority, group, groupUpdateAuthority)`, `updateGroupMaxSize(group, authority, maxSize)`, `updateGroupAuthority(group, authority, next | null)`. Each takes optional signerSeeds
- `account.lamports` read/write on `Mut` accounts, `close(account, destination)` for program accounts
- `requirePda(account, seeds, bump)`: any bump that gives a valid PDA passes, as with Anchor's `bump = expr`. Use a bump
  stored when the account was created (or `Seeds<…>`); one taken from the instruction's arguments lets the caller pick
  among up to 256 addresses for the same seeds

## Implementing another program's interface (transfer hooks)

`/** @discriminator spl-transfer-hook-interface:execute */` above an instruction replaces its Anchor discriminator with
sha256(preimage)[..8] (or `@discriminator 0x…` for raw bytes), so a TypeSOL program can be a Token-2022 transfer hook:
`execute(source, mint, destination, owner, extraMetas, ...extraAccounts, amount)` plus
`initExtraAccountMetas(payer, account, mint, systemProgram, extraAccounts?)` for the validation account (an
ExtraAccountMetaList). Extra accounts are listed as `{ address, isSigner?, isWritable? }` (a fixed address) or
`{ seeds: [...], program?, isSigner?, isWritable? }` (a PDA of this program, or with `program: i` of the program at account
index i), with seeds from string literals, `seedAccountKey(i)`, `seedAccountData(i, offset, length)` and
`seedInstructionData(offset, length)`; Token-2022 resolves and checks them on every transfer. The first extra account has
index 5. `updateExtraAccountMetas(...)` rewrites and resizes an existing list. See `test/fixtures/hook.ts` and the
transfer-hook ports.

## Calling other programs

```ts
export function relayIncrement(authority: Signer, counter: Mut<AccountInfo>, counterProgram: Program<"JD2v…99Y2">, by: u64): void {
  invoke(counterProgram, [readonlySigner(authority), writable(counter)], [sighash("increment"), by]);
}

// Sign for a PDA of this program: raw System transfer (u32 tag 2, u64 lamports) out of a treasury PDA.
export function payOut(admin: Signer, treasury: Mut<SystemAccount>, recipient: Mut<SystemAccount>, systemProgram: SystemProgram, amount: u64, bump: u8): void {
  invoke(systemProgram, [writableSigner(treasury), writable(recipient)], [u32(2n), amount], ["treasury", admin.key, bump]);
}
```

- program: a `Program<"address">` (key and executable checked on entry), an `UncheckedProgram`, an
  `Address<AccountInfo, "address">` (Anchor's `#[account(address = ID)]` on an `UncheckedAccount`: only the key is
  checked, 2012), the system or a token program, or a remaining account.
- accounts: `readonly(x)`, `writable(x)`, `readonlySigner(x)`, `writableSigner(x)`. The compiler refuses `writable` on a
  non-`Mut` parameter and a signer flag on an account that neither signed nor is covered by `signerSeeds`. An optional
  account passed as it is (`readonly(x)` / `writable(x)` with `x: A | null`, no `!`) is left out of the list when it
  was not passed, as Rust's `if let Some(x) = &self.x { accounts.push(…) }` does.
- data (Borsh): integers little-endian at their declared width (`u32(2n)` is 4 bytes, a bare `5n` is a u64), booleans,
  Pubkeys, strings, Options, structs and FixedArrays (their fixed layout), data enums, `Vec` arguments,
  `sighash("name")` (Anchor discriminator), `hex("0a0b")`. Up to 1024 bytes.
- `signerSeeds` (with the bump) signs for this program's PDA. When several PDAs sign one call, pass a list of seed
  lists: `[["vault", owner.key, vaultBump], ["fees", feesBump]]` (at most 16).
- A seed list used more than once can be named: `const vault = signer(["vault", owner.key, bump])`, then pass `vault`
  wherever signerSeeds go. One of two lists picked at run time: `const pool = indexed ? signer([…, index, bump]) :
  signer([…, bump])`.
- `bigEndian(x)` in a seed list: an integer's bytes most significant first (`["tick_array", pool.key, bigEndian(start)]`).
- After the call, `returnData<u64>(program)` reads what the callee returned, checking the size and that it came from `program`.
  A struct is bound to a local, `const quote = returnData<Quote>(amm)`: a fixed layout of integers, booleans, Pubkeys,
  unit enums and arrays is read as its bytes (bools and enums checked); a struct with Options, strings or Vecs is
  declared `/** @layout borsh */` and Borsh-decoded. Bytes that are not exactly the struct fail with 5106.

A call decided at run time, such as one a multisig stored in account data, is `invokeInstruction` (Rust's
`invoke_signed(&Instruction { program_id, accounts, data }, infos, seeds)`):

```ts
invokeInstruction(transaction.programId, transaction.accounts, transaction.data, remainingAccounts(), [multisig.key, multisig.nonce]);
```

- the accounts are a list of structs with `pubkey`, `isSigner` and `isWritable` (a Vec or FixedVec in account data, a
  Vec argument, a stored `map` result, or a local list built on the stack); the data a list of u8 (the same, the
  instruction data or a slice of it).
- every account in the fourth argument (`remainingAccounts()` or a slice; in a helper, its `RemainingAccounts`
  parameter or a slice of it) is handed to the runtime, which finds each meta's account there by key: one that is
  missing fails the call, as under Rust (MissingAccount, "Instruction references an unknown account").
- so a native port builds the instruction as Rust's instruction builders do, in a helper too, with metas naming
  accounts by key:

  ```ts
  function transfer(rest: RemainingAccounts, data: InstructionBytes, to: Pubkey): void {
    const metas: FixedVec<Meta, 2> = fixedVec([{ pubkey: rest.get(0n).key, isSigner: true, isWritable: true }]);
    metas.push({ pubkey: to, isSigner: false, isWritable: true });
    const ix: FixedVec<u8, 12> = fixedVec([2n, 0n, 0n, 0n]); // system_instruction::transfer
    ix.pushAll(data.slice(1n, 9n)); // the lamports, as sent
    invokeInstruction(rest.get(2n).key, metas, ix, rest);
  }
  ```
- the runtime checks the privileges: a meta may be a signer or writable only as the transaction passed that account,
  or as a PDA of this program the seeds (fifth argument) sign for. See `showcase/mainnet/multisig/multisig.ts`.

Typed calls from an IDL: `typesol cpi other.json --out other_cpi.ts` writes one helper per instruction
(`vaultDeposit(program, owner, vault, systemProgram, amount, seeds)`), with the account flags, discriminator and
argument encoding taken from the IDL (Anchor 0.30+ / 1.x, or TypeSOL's own). Call it with `signer([...seeds, bump])`
when a PDA of your program signs, or `signer([])`. Instructions whose arguments have no Borsh-identical TypeSOL type
(strings or Options inside structs, data-carrying enums) are listed and left out.

## PDAs in the IDL

When an instruction calls `x.create(payer, seeds)` or `requirePda(x, seeds, bump)` and every seed is a string literal,
an integer literal, an argument, `acct.key` or a scalar field of an account, the IDL entry for `x` gets Anchor `pda.seeds`
(`const` / `arg` / `account`), so Anchor and Codama clients derive the address themselves.

## Programs and sysvars passed as remaining accounts

A native program takes its programs and sysvars by position too. `programAt<P>(account)` checks a remaining account
(or an `AccountInfo` parameter) is that program, once, by its key, and gives it P's typed methods:

```ts
const rest = remainingAccounts();
const stake = programAt<StakeProgram>(rest.get(12n)); // ProgramError.IncorrectProgramId if it is another account
stake.split(rest.get(3n), rest.get(4n), rest.get(1n), lamports, [pool.key, "withdraw", bump]);
const minimum = stake.getMinimumDelegation();
programAt<TokenInterface>(rest.get(10n)).mintTo(rest.get(7n), rest.get(8n), rest.get(1n), amount, seeds);
```

- P is `StakeProgram`, `SystemProgram`, `TokenProgram`, `Token2022Program`, `TokenInterface` (either token program),
  `AssociatedTokenProgram` or `MemoProgram`. Bind it with `const`, or call a method on it directly; pass it to a helper
  that takes that program type.
- `sysvarAt<StakeHistorySysvar>(account)` does the same for the StakeHistory sysvar (ProgramError.InvalidArgument for
  another account): `count`, `latestEpoch`, `has(epoch)`, `effective(epoch)` … as on a parameter (read its fields
  through a `const` bound to it; methods also work on the call itself).
- Every typed CPI (System, SPL Token and Token-2022, ATA, Memo, Stake) takes, for each account, a declared parameter,
  a remaining account (`rest.get(i)`, a local bound to one, a `RemainingAccount` helper parameter), a struct loaded
  from one, or an `AccountInfo` parameter where a `TokenAccount` or `Mint` goes. Declared parameters keep their
  compile-time checks (writable slots need `Mut<…>`, an authority without signerSeeds a `Signer`). A remaining account
  is not checked by the compiler, and unlike `invoke` the typed calls add no runtime check of their own: the runtime
  refuses a CPI that makes an account writable or a signer when the transaction did not (and no seeds sign for it),
  and the called program checks the rest (a token account's mint and owner, a stake account's authorities).
- The cost is the key check (four 8-byte compares) and the call itself: within a few compute units of the same call
  written with `invoke`, which checks only the executable flag (test/integrations/native-cpi.test.ts measures it).

## Porting a native program

A program written without Anchor (Raydium AMM v4, SPL programs) reads a tag byte and its arguments itself and takes its
accounts by position. TypeSOL ports one as it is (see `showcase/mainnet/raydium-amm` and `test/fixtures/native.ts`):

- One `/** @fallback */` entry: `const data = instructionData()` gives the bytes, with `data.readU8/U16/U32/U64/U128/
  readPubkey(offset)` (little-endian, bounds-checked: 5104), and the list methods, `for … of`, `data.slice(a, b)`
  (a view, 5104 out of range) and `out.pushAll(data.slice(a, b))` (a memcpy into a local FixedVec); a helper takes it as
  an `InstructionBytes` parameter. `remainingAccounts()` gives the accounts by position.
- Calls to System, Token and Stake: `programAt<P>(acct)` and the typed methods, with remaining accounts (above), not
  hand-encoded `invoke` data.
- Accounts without a discriminator: `loadRaw<T>(acct)` / `loadRawMut<T>(acct)` view one as a fixed-layout struct from
  byte 0 (this program's, 3007; at least the struct's size, 3003; `loadRawMut`: writable, loaded once). Make the
  original's own checks (an exact size, its error codes) before the load. Structs are packed, as `#[repr(C, packed)]`.
- Borsh accounts without a discriminator (SPL Stake Pool's `StakePool`, read with `try_from_slice_unchecked` and
  written with `serialize`): `const pool = loadBorsh<StakePool>(acct)` decodes the data from byte 0 into a local
  struct (a copy: fields updated, Options narrowed and set to null or a value, data enums switched, copied, passed to
  helpers), and `storeBorsh(acct, pool)` encodes it back from byte 0. As Rust: no owner check and no discriminator
  (check the owner first, as the original does); bytes after the value are ignored when reading and left as they were
  when writing (an Option that became None leaves its old bytes behind it); data too short, an Option tag or boolean
  other than 0/1, an enum tag out of range, a String that is not UTF-8 or longer than its `FixedString<N>`, or an
  account too small for the encoding fail with `ProgramError.BorshIoError`. `acct` is a remaining account, a
  `RemainingAccount` helper parameter or an `AccountInfo` parameter (`Mut<AccountInfo>` for `storeBorsh`; a remaining
  account must be writable, 3006). `T` may hold integers, booleans, Pubkeys, enums, FixedArrays, `FixedString<N>`,
  `FixedVec<T, N>`, Options, data enums with fixed-size payloads and nested structs of those, with or without
  `@layout borsh`; not `Vec<T>` or `string` (they would need the heap or a view). Each struct gets its own
  straight-line decoder and encoder (no heap): about 280 CU to read a 611-byte `StakePool` and 610 CU to read and
  write it back. The local lives on the stack (4 KiB per function).
- Lists over the rest of an account (SPL's `big_vec`): a struct ending in `BigVec<T>`, `const list =
  loadRawMut<ValidatorList>(acct)`, then `list.validators.push(…)`, `.retain((v) => …)`, `.findIndex((v) => …)`,
  `for (const v of list.validators.slice(skip, skip + len))` (`deserialize_mut_slice(skip, len)`). The load fails with
  AccountDataTooSmall when the stored length does not fit, where the Rust would only panic on reaching such an element:
  check the length first (`readData<u32>(acct, offset)`) where the original returns an error of its own before that.
- Parts at offsets the account's header gives: `loadRawAt<T>(acct, offset)` / `loadRawMutAt<T>(…)` for a struct,
  `rawArrayAt<T>(acct, offset, capacity)` / `rawArrayMutAt<T>(…)` for a run-time number of elements, each bounds-checked
  once when it is made (ProgramError::AccountDataTooSmall; `loadRaw`'s fixed size check stays 3003, the error of a
  view whose size is known when the program is compiled), as Phoenix slices `&data[576..]` after checking the
  account's size itself. The checks a Rust original makes first (a size, its own error code) go before the view.
- lib-sokoban's trees (Phoenix's order books and trader seats): `rbTreeMutAt<K, V>(acct, offset, capacity, compare?)`,
  every write the crate's own, so the account matches the original after every instruction:

  ```ts
  /** Phoenix's FIFOOrderId Ord: a bid's sequence number is stored inverted (top bit set); bids descend, asks ascend. */
  function orderCmp(a: FIFOOrderId, b: FIFOOrderId): i8 {
    if (a.order_sequence_number >> 63n === 1n) {
      // a bid (the left key's side decides): `other.cmp(self)`
      if (a.price_in_ticks !== b.price_in_ticks) return b.price_in_ticks < a.price_in_ticks ? -1n : 1n;
      return b.order_sequence_number < a.order_sequence_number ? -1n : b.order_sequence_number > a.order_sequence_number ? 1n : 0n;
    }
    if (a.price_in_ticks !== b.price_in_ticks) return a.price_in_ticks < b.price_in_ticks ? -1n : 1n;
    return a.order_sequence_number < b.order_sequence_number ? -1n : a.order_sequence_number > b.order_sequence_number ? 1n : 0n;
  }
  const bids = rbTreeMutAt<FIFOOrderId, FIFORestingOrder>(market, 880n, n, orderCmp);
  const best = bids.min(); // the best bid, or null
  if (best !== null && best.value.num_base_lots > 0n) best.value.num_base_lots -= fill;
  const index = traders.addrOf(trader); // a seat's node index, 0 when absent
  ```

  The C runs sokoban's get_addr / _insert / _remove / rotations / allocator statement for statement, with the node
  stride a constant (512 entries: get 166 CU, insert 493, remove 294, min 94; 4096: 215 / 595 / 355 / 112, against
  300 / 604 / 497 / 191 and 384 / 742 / 618 / 225 for lib-sokoban built with cargo-build-sbf). sokoban's panics are
  Rust panics in the original; the tree reproduces each as solana-program up to 1.17 reports one (Phoenix's build):
  the log line `panicked at '<message>', <file>:<line>:<column>`, then the runtime's abort ("SBF program panicked",
  ProgramFailedToComplete), with sokoban's messages and source lines as Phoenix's binary holds them (`src/…`):
  `initialize()` on an allocator that is not all zero, "Cannot reinitialize NodeAllocator" (src/node_allocator.rs:249:13);
  an empty tree's insert with no room (capacity 0, or a damaged allocator), "Buffer is full, size N" (:269:17); and on
  damaged registers only, "Nodes are not connected" (src/red_black_tree.rs:429:13), "assertion failed:
  self.is_root(parent)" (:503:17), "assertion failed: self.is_leaf(max_left)" (:598:17), a size going below zero
  ("attempt to subtract with overflow", src/node_allocator.rs:291:9). A node index outside 1..capacity, from `nodeAt`
  or a damaged register, panics as Rust's `nodes[i - 1]` would ("index out of bounds: the len is N but the index is
  I", src/node_allocator.rs:255:10; index 0, "attempt to subtract with overflow", :255:21: locations read from the
  source, not from a binary), so a damaged tree never reads outside the account. A port makes the original's checks
  in the original's order before the tree call, and these lines follow on their own. Iteration keeps its stack on the
  program's stack (64 nodes, more than any red-black tree a u32 index can address holds on one path); a deeper,
  damaged tree panics where the Rust's heap stack would grow. A tree is a const of the function that makes it, not
  a helper parameter (make it again in the helper from the account).
- Writes as the original makes them: `export const NATIVE_ACCOUNT_WRITES = true` (anywhere in the program; opt-in, for
  native ports). A native program writes account data in place and the runtime judges afterwards: a read-only account
  whose data actually changed fails the instruction (`ReadonlyDataModified`, or an access violation at the write under
  account-data direct mapping), one that was only read (or written with the bytes it held) is fine, and an account
  passed twice is two `AccountInfo`s over one buffer. By default
  `loadRawMut` and `storeBorsh` check writability up front (3006), `loadRawMut` claims the account once and
  `storeBorsh` refuses an account passed more than once (2040, as a write to a remaining account's lamports), so a
  port fails where the original succeeds (a read-only validator list that is only read; the list passed again as a
  stake account, which the original skips by its address checks). With the flag, `loadRawMut`, `storeBorsh` and the
  BigVec writes through a `loadRawMut` view skip both, and both take a plain `AccountInfo` parameter (no `Mut<…>`
  needed). Owner and size checks stay. **The trade-off:** a write to a read-only account is reported by the runtime at
  the end, not at the write, and two loads of one account are two views of the same bytes (a write through one is
  read through the other), where Rust's `RefCell` would fail a second `borrow_mut()` while the first is held (a panic,
  or `AccountBorrowFailed` through `try_borrow_mut_data`). The original's own address and type checks normally refuse
  such a pair before it is loaded (SPL Stake Pool's PDA checks); make them in the same order, before the load. Only
  data writes are affected: with or without the flag every view reads the account's bytes in place, so a `loadRaw`
  of an account also loaded with `loadRawMut` (or written with `storeBorsh`) reads what was written, BigVec pushes
  included; the flag only lifts the up-front checks (a second `loadRawMut` of one account, at the same position or
  another, is 2040 without it). `.lamports` on remaining accounts, `loadAccountMut`, CPI account metas and the checks of
  `Mut<…>` parameters stay as they are, and programs without the flag compile exactly as before.
- Accounts closed, reassigned and resized by hand, on remaining accounts and `AccountInfo` parameters:
  `closeRaw(account, receiver)` is what Phoenix's Tombstone writes, in its order: `receiver.lamports +=
  account.lamports` (checked), `account.lamports = 0`, `assign(&system_program::id())`, `realloc(0, false)`. Unlike
  `close` the data is not zeroed first (a realloc to 0 drops it, and the runtime then accepts the new owner), so it
  costs a few compute units whatever the account's size, and the account ends as the original's does (gone, its
  lamports in the receiver; test/language/native-close.test.ts compares it with Phoenix's own Tombstone).
  `assignOwner(account, owner)` is `AccountInfo::assign` (the runtime accepts it for a writable account of this program
  whose data is empty or zeroed), and `resizeAccount(account, size)` also takes a remaining account (`realloc(size,
  true)`: new bytes zeroed, at most 10 KiB past the size it had when the instruction started, 3016; that size is the one
  the entrypoint records in the account's record, as solana_program 1.14's does, only in programs that resize a
  remaining account). Without `NATIVE_ACCOUNT_WRITES` the accounts are checked as other writes the compiler cannot see
  are: writable (3006; a parameter must be `Mut<AccountInfo>`), passed once (2040), the closed or reassigned account
  this program's (3007), and not closed into itself (2040). With it nothing is checked and the runtime judges, as for
  the original (`ReadonlyLamportChange`, `ExternalAccountLamportSpend`, `UnbalancedInstruction`, `ModifiedProgramId`),
  and plain `AccountInfo` parameters are enough.
- Errors as the original returns them: an error enum may start at code 0 (`/** @code 0 */`, Rust's
  `ProgramError::Custom(0)`, returned as Solana's CUSTOM_ZERO); `require(c, ProgramError.InvalidInstructionData)` for a
  built-in error; `panic(message, "program/src/lib.rs:12:5")` for a Rust panic (ProgramFailedToComplete, the runtime
  reporting that location; `panic(null, "src/lib.rs:105:19")` logs no message, for an original whose panic handler
  writes none, so only the runtime's "SBF program Panicked in src/lib.rs at 105:19" is left); `abort()` for Rust's
  abort (the allocator's out-of-memory error: `log("Error: memory allocation failed, out of memory"); abort();`), the
  runtime's `abort` syscall, which logs "SBF program panicked" with no location; `const PANIC_ON_OVERFLOW = true`
  makes arithmetic overflow and division by zero panic as `checked_*().unwrap()` does instead of failing with 5100 /
  5101.
- Panics as an older solana-program writes them: `export const PANIC_STYLE = "solana-1.14"` (a program built with
  solana-program 1.14 to 1.17, whose rustc formats a panic before 1.73 did: Phoenix v1) makes `panic(message,
  location)` log `panicked at '<message>', <location>` and then abort, so the runtime's last line is "SBF program
  panicked" with no location, as that panic handler leaves it (`panic(null, …)` is refused there: the handler always
  logs; without a location the TypeScript line and column are used). `PANIC_ON_OVERFLOW`'s panics abort too.
- Overflow panics with Rust's message and location: `panicsAt("src/quantities.rs:233:1", a + b)` is `a + b` whose
  checked arithmetic panics as Rust's overflow checks do at that location ("attempt to add with overflow"; also
  "attempt to subtract / multiply with overflow", "attempt to divide by zero", "attempt to calculate the remainder
  with a divisor of zero", "attempt to negate with overflow", "attempt to divide with overflow" and "attempt to shift
  left / right with overflow" for a shift amount past the width), logged as `panic` logs (`PANIC_STYLE` above, else
  the message and sol_panic_ at the location), instead of failing with 5100 / 5101; with or without
  `PANIC_ON_OVERFLOW`, which applies outside it. Rust reports the location of the expression the operator belongs
  to, so the wrapper goes around that expression: only the operators written inside it take the location (not those
  of the helpers it calls), an inner `panicsAt` gives its operators their own (`panicsAt(A, x + panicsAt(B, y * z))`),
  and as a statement it takes an assignment, `panicsAt(LOC, total += fee);`. A Rust newtype's operator panics at its
  `impl` (Phoenix's `QuoteLots + QuoteLots` at the macro line in quantities.rs, wherever the addition is written): give
  the port a helper, `function addQuoteLots(a: u64, b: u64): u64 { return panicsAt(QUOTE_LOTS_ADD, a + b); }`. The
  bits `<<` loses, `**`, `mulDiv` / `mulDivCeil`, casts and u256 arithmetic keep TypeSOL's failures (Rust checks them
  differently, or with other messages).
  test/language/rust-panics.test.ts checks the lines against the Phoenix binary's own panics.
- Log lines as the original writes them: `const ERROR_LOG_PREFIX = "AMM error: "` and `const PROGRAM_ERROR_LOG_PREFIX =
  "Program error: "` replace the compiler's failure line with the entrypoint's (`msg!("AMM error: {}", e)`); `null`
  logs no failure line at all, as a native program returns an error its own checks already explained (Phoenix): the
  program's errors and codes its helpers return (`ERROR_LOG_PREFIX = null`), built-in ProgramErrors and `programAt`'s
  check (`PROGRAM_ERROR_LOG_PREFIX = null`), each about 110 CU cheaper than a logged one (constraint errors and the
  compiler's own checks still log);
  `logBase64("ray_log: ", record)` logs a struct's bytes in base64 (a native `bincode` log record);
  `createProgramAddress(seeds, program)` is `Pubkey::create_program_address` (null for no address);
  `logComputeUnits()` is `sol_log_compute_units()`: the runtime writes "Program consumption: N units remaining" at
  that point, as for the original (Phoenix's cancel and withdraw paths log it).
- Byte strings built by hand (instruction data for a self-CPI, a log record, return data) in a `FixedVec<u8, N>`, a
  local list or one in account data: `buf.pushLE(x)` appends an integer's little-endian bytes at its width (u8 … u128,
  i8 … i128; a literal needs one: `buf.pushLE<u16>(1n)` or `buf.pushLE(u16(1n))`), `buf.pushKey(key)` a Pubkey's 32
  bytes, `buf.pushBorsh(value)` a value's Borsh encoding with the codecs `invoke`, events and `storeBorsh` use (a
  struct, or an object literal given its type, `buf.pushBorsh<Header>({ … })`; a data enum, its tag then the variant's
  fields; a FixedArray; a list, its u32 count then the elements; integers, booleans, Pubkeys, strings and Options),
  `buf.setLE(offset, x)` (or `setLE<u16>(offset, x)`) overwrites bytes within the length, as Rust's
  `data[a..b].copy_from_slice(…)`, and `buf.truncate(n)` keeps the first `n`. Past the room (or, for `setLE` and
  `truncate`, past the length) fails with 5104 and the length does not move. Phoenix's event recorder, which the test
  checks byte for byte against the Phoenix binary's batches:

  ```ts
  const data: FixedVec<u8, 1280> = fixedVec([15n]); // PhoenixInstruction::Log
  data.pushBorsh<PhoenixMarketEvent>({ kind: "Header", instruction, sequenceNumber, timestamp: now(), slot: currentSlot(), market, signer, totalEvents: 0n });
  // … for each event: event.pushBorsh<PhoenixMarketEvent>({ kind: "Fill", index, … }); data.pushAll(event);
  data.setLE(91n, u16(batchSize)); // total_events of this batch
  invokeInstruction(programId(), metas, data, rest, ["log", bump]);
  data.truncate(93n); // back to the header
  ```
- Return data as the original sets it: `setReturnData(bytes)` is `set_return_data(&bytes)`, the bytes as they are, from
  the `@fallback` entry, a helper or a void instruction (Phoenix's Borsh `Vec<FIFOOrderId>` of the orders that rested,
  built in a local `FixedVec<u8, N>`). `bytes` is a list of u8: a local FixedVec, a Vec or FixedVec in account data, or
  the instruction data or a slice of it. The last call wins and an empty list clears it; a CPI made afterwards replaces
  it with the callee's (call it after the last CPI, as Rust must). More than 1024 bytes fails as the Rust call does: the
  runtime refuses it ("Return data too large (1025 > 1024)"). An instruction that returns a value cannot call it (a
  compile error: its return value is its return data); a helper it calls may, and the instruction's return value, set
  last, replaces what the helper set.

## Not supported yet

A struct holding a FixedVec that is both an argument and account data (its bytes differ there, and the IDL describes a
type one way: declare one for each), growing an account by more than 10 KiB in one instruction (Solana's limit: realloc
again in the next instruction), `?.` and `!` on anything but optional accounts, Options and a `find` on struct elements,
functions stored in a struct, chosen from a list by index or returned from an instruction, a fused `map` to strings
(store it, annotated), floating point (by design).
They are rejected at compile time rather than half-supported.

`Init.create` handles a PDA address someone pre-funded: it tops up rent, then allocates and assigns instead of
`create_account` (which would fail).
