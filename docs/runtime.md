# The C runtime

`runtime/typesol_rt.h` is included by every generated program. It holds what the emitted C calls: error codes, the
entry point's input parser, account checks, checked arithmetic, Borsh helpers, CPIs, sysvars, strings and the heap.
This page is for people changing it; programs never call it directly.

Since 0.45.0 the runtime is no longer header-only: `runtime/typesol_builtins.c` holds the functions clang calls for
128-bit multiplication, division and shifts and for signed 64-bit division (`__multi3`, `__udivti3`, `__divti3`,
`__divdi3`, …). It is compiled with every program by the same clang and linked after it, in place of platform-tools'
`compiler-builtins` library, whose layout differed by host package
([stability.md](stability.md#what-builds-the-same-bytes-where)); `test/language/builtins.test.ts` checks it against
BigInt and its compute units against compiler-builtins'. Multiplication and shifts are assembly written for the 128-bit
libcall convention of clang 20 (platform-tools v1.52) and earlier: the result's address in r1, the operands after it.
clang 22 (platform-tools v1.57) passes the operands from r1 and returns the result in registers, so for a clang above
20 the file compiles C definitions of the same four functions instead (`TS_ASM_LIBCALLS`), which take whatever
convention that clang gives their C signatures; with the assembly, a program built by clang 22 stored its first
128-bit product through the operand's low half ("Access violation writing 8 bytes at address …"). The test runs the C
definitions too, compiled by the tested clang as a clang above 20 would select them.

## Conventions

- **Header-only, `static inline`.** Each program compiles the header with its own code, and `--gc-sections` drops
  what it does not use. `always_inline` marks the few helpers that must disappear into their caller (word loads and
  stores, `ts_memcpy`, checked add/subtract); `noinline` marks the ones that should exist once per program because
  many call sites would otherwise each grow the binary (`ts_fail`, the rent fallback `ts_rent_slow`, PDA search).
- **Errors are return values.** A function that can fail returns `uint64_t`: `SUCCESS`, or an error code. Fail with
  `TS_FAIL(code, "TypeSOL: …")` (logs the message, then returns the code) and propagate with `TS_TRY(call)`.
  The instruction returns the code, and the runtime reports it as `Custom(code)`. The exceptions abort the program
  instead: Rust-style panics (`panic`, `PANIC_ON_OVERFLOW`, `PANIC_STYLE`, `panicsAt`) and a RedBlackTree whose bytes
  are inconsistent (`ts_rbt_bad_index`, `ts_rbt_too_deep`, as lib-sokoban panics), which end with the runtime's
  "SBF program panicked".
- **No C struct by value where it may alias.** The SBF target passes a C struct argument as a pointer to the caller's
  object and makes no copy, so a function that writes memory the argument came from would see its own writes. A
  runtime function taking a struct and an out-pointer it writes reads the struct into scalars first (`ts_str_append`
  is an always-inlined wrapper of `ts_str_append_n`); generated helpers take such values by pointer.
- **Bounds without wrapping.** Size checks compare `a + b > limit` only when the sum cannot overflow, else
  `n > limit - at` with `at <= limit` known (`ts_alloc`); a check such as `n > len - at - rest` is wrong when `at` may
  be past `len - rest`.
- **Error codes follow Anchor.** Where Anchor has a framework error with the same meaning, its number is used (2006
  ConstraintSeeds, 3003 AccountDidNotDeserialize, …), so Anchor and Codama clients name failures correctly.
  TypeSOL-only conditions are 5100–5199; user errors start at 6000. Every code is listed in [errors.md](errors.md).
- **No byte loops from the SDK.** The SDK's `sol_memcpy`, `sol_memcmp` and `SolPubkey_same` move one byte per
  iteration. The runtime uses `ts_ld64` / `ts_st64` (unaligned 8-byte loads and stores, which SBF allows) in
  `ts_memcpy`, `ts_memzero`, `ts_mem_eq`, `ts_key_eq` and `ts_memmove`.
- **The memory syscalls where they cost less.** `sol_memmove_` and `sol_memset_` cost about 16 and 14 compute units
  whatever the length up to 2,749 bytes. Whole values of a size known when compiling are copied by `TS_COPY` from 80
  bytes and zeroed by `TS_ZERO` from 192 between places reached through pointers (account data, views, a helper's
  pointer parameters), where the unrolled loads and stores cost at least 10 units more. Where a side is a local of the
  function, `TS_COPY_LOCAL` / `TS_MEMCPY` take the syscall from 400 bytes and `TS_ZERO_LOCAL` from 600, where clang
  stops unrolling: below that the optimizer drops the stores and loads nothing reads (a struct literal built in place, a
  helper's result read field by field), which a call would prevent. The size folds when compiling, so smaller copies
  compile to exactly the code they were. Run-time lengths, always loops, take the syscall from 64 bytes: the bytes an
  account grows by (`ts_memzero_run`, one unit more below 64) and an account's data at `close` (`TS_CLOSE`, decided from
  the type's smallest size). The measured table is above these macros in `typesol_rt.h`. Copies always use memmove:
  `sol_memcpy_` fails the transaction on overlapping ranges, which two views of one account can give.
- **Same results as the reference.** Fast paths must give bit-identical results to what they replace: `ts_add_overflow_u64`
  matches `__builtin_add_overflow`, the rent fast path and `ts_rent_slow` match the double computation, PDA search
  matches `sol_try_find_program_address`. A change here needs a test against the reference, not only against itself.

## Sections

In file order:

| Section | What it provides |
| --- | --- |
| Error codes, `TS_FAIL`, `TS_TRY` | The codes above and the two macros |
| Word-wise memory helpers | `ts_ld64`, `ts_st64`, `ts_memcpy`, `ts_memmove`, `ts_memzero`, `ts_mem_eq`; the memory syscalls past their thresholds (`TS_COPY`, `TS_MEMCPY`, `TS_ZERO`, `ts_memzero_run`); checked u64 add/subtract/multiply |
| Well-known program ids | System, Token, Token-2022, ATA, Metaplex and the other programs the language names |
| Strings | `TS_Str` views (pointer, length), UTF-8 validation, comparison, `FixedString<N>` storage |
| Entry point input | `TsAccount` (the loader's serialized account, read in place), `TsParams`, `ts_deserialize` |
| Account checks | owner, discriminator, signer, writable, executable, address, size, uniqueness (`ts_check_*`), growable Vec lengths; `ts_owned`, the native views' owner check with its one-account cache (`TS_OWNER_CACHE`, forgotten at every CPI and owner write by `TS_OWNER_FORGET`) |
| Little-endian IO | `ts_read_le` and friends for argument decoding and Borsh |
| Sysvars | clock, rent (`ts_rent`, `ts_minimum_balance_of`, `ts_minimum_balance`), program data |
| PDA | `ts_pda_hash`, `ts_create_pda_address`, `ts_find_pda` (canonical bump), `ts_require_pda` |
| System program CPIs | create, assign, allocate, transfer, `ts_create_pda`, `ts_resize` / `ts_realloc`, close |
| Token-2022 extensions | TLV walking for the extensions the language reads |
| Metaplex Core and Bubblegum | account readers (`coreAssetOwner`, …) |
| SPL Token / Token-2022 CPIs | transfer, mint, burn, approve, close, freeze and their checked forms |
| Return data | `sol_set_return_data` wrappers |
| Crypto | sha256, keccak256, ed25519 / secp256k1 verification helpers, Merkle proofs |
| Heap | `ts_alloc`, a bump allocator (32 KiB by default, `HEAP_SIZE_KIB` up to 256), string building (`ts_str_join`, `ts_str_append`, number and base58 text) |
| Oracles | Pyth price updates, Switchboard |
| Associated token accounts, token metadata, transfer hooks | ATA derivation and creation, Token Metadata CPIs, transfer-hook extra accounts |

## Changing it

- Every runtime change can move compute units or binary size. Measure it before and after with
  [typesol-lang/benchmarks](https://github.com/typesol-lang/benchmarks) pointed at your checkout, and put the difference in
  the pull request (see CONTRIBUTING).
- A change that alters behavior (a result, an error code, a log line, account bytes) is a language change and goes
  in the CHANGELOG as one. One that only changes cost says so: "same results".
- New error codes: add the `#define` here, the row in [errors.md](errors.md) and the name in the compiler's runtime
  error list (`TYPESOL_ERRORS` in `src/tools/clientgen.ts`), so clients name it (a test checks every code has a name).
