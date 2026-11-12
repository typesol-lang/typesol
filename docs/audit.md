# Audit package

For a security firm reviewing TypeSOL. TypeSOL compiles a subset of TypeScript to C and then to Solana SBF; every
program it builds includes one C runtime header. The question for an audit is whether a program compiled by TypeSOL
can be made to do something its source and [the security model](security-model.md) say it cannot. Programs written
with TypeSOL are out of scope; their authors audit them.

## Scope

In order of priority. Line counts at 0.45.0 (November 2026).

| Priority | Component | Files | Lines | Why |
| --- | --- | --- | ---: | --- |
| 1 | C runtime | `runtime/typesol_rt.h` | 2,998 | In every program: input parsing, account checks, checked arithmetic, PDAs, system and token CPIs, account creation, resizing and closing, oracles, signature checks, the heap |
| 1 | Instruction prologue and constraints | `src/compiler/emit/function.ts` | 876 | Which checks each account parameter gets, and their order |
| 1 | Account data, Vecs and assignment | `src/compiler/emit/alias.ts`, `storage.ts`, `statements.ts`, `base.ts` | 3,807 | Reads and writes of account data, growable Vec layout and resizing, references and aliasing, closure and helper expansion |
| 1 | Calls and CPIs | `src/compiler/emit/calls.ts`, `cpi-core.ts`, `cpi.ts`, `create.ts`, `token.ts` | 5,708 | Built-ins, remaining accounts, `invoke` / `invokeInstruction` and their account flags, signer seeds, token CPIs, account creation |
| 1 | Raw views and the red-black tree | `src/compiler/emit/views.ts`, `rbtree.ts` | 655 | Accounts read without a discriminator at run-time offsets (`loadRaw`, `loadRawAt`, `rawArrayAt`, `BigVec`), their bounds, and the red-black tree's node indexes (`rbTreeAt`) |
| 1 | Metaplex CPIs | `src/compiler/emit/metaplex.ts` | 1,465 | Token Metadata, Core and Bubblegum instruction layouts and their account lists |
| 1 | Expressions | `src/compiler/emit/expressions.ts`, `shared.ts`, `borsh.ts` | 2,115 | Checked arithmetic and casts, Borsh encoding of arguments and `@layout borsh` accounts |
| 2 | Front end | `src/compiler/analyze.ts`, `model.ts` | 3,488 | What the language accepts; constraints and account types as parsed from the source |
| 2 | Interface | `src/compiler/idl.ts`, `src/tools/clientgen.ts` | 2,460 | The IDL and the generated client must describe the program exactly (a mismatch can make clients sign the wrong thing) |
| 3 | Build and tooling | `src/compiler/toolchain.ts`, `src/cli.ts`, `src/workspace.ts`, `src/tools/` | | Build flags, deploy and verification commands |

The language surface is `lib/typesol.d.ts` (2,619 lines): every type and built-in a program can use, with its
documented behavior. [docs/language.md](language.md) is the reference; [docs/architecture.md](architecture.md) maps
the code, [docs/runtime.md](runtime.md) the runtime's conventions.

Out of scope: the Solana runtime, platform-tools (clang, lld), the TypeScript compiler, and programs written with
TypeSOL. The platform-tools are part of what a binary trusts all the same: the tests cover the toolchain the release
declares (`TESTED_TOOLCHAIN` in `src/compiler/toolchain.ts`: Agave 3.1.10, platform-tools v1.52), builds with another
one warn, and the review of 0.43.0 traced one defect to how that backend passes struct arguments. The platform-tools
host package mattered too, up to 0.44.1: its compiler-builtins library, which each of the macOS, Linux arm64 and
Linux x86_64 packages lays out differently, made a program with 128-bit or signed division link to different bytes on
each. From 0.45.0 on the builtins are TypeSOL's own C, compiled with the program, and the programs measured build to
the same bytes on the three hosts (the 76 of the sources for SBPF v0, 14 for v1 and v2;
[stability.md](stability.md#what-builds-the-same-bytes-where)). The reference environment for binaries is the
`--docker` build container (`docker/Dockerfile`, linux/amd64; base images by digest, release files by sha256, the
TypeSOL tarball by its release record and its npm dependencies by a lock whose every integrity `npm ci` checks), which
`typesol verify --docker` rebuilds in.

## What to check

The guarantees in [security-model.md](security-model.md), each of which should hold for every program the compiler
accepts. Areas where a bug would be most damaging, and where earlier internal reviews found the issues listed below:

- **Account checks**: every parameter type and constraint, also when an account only reaches a helper, a closure or a
  CPI; optional accounts; the duplicate-writable check.
- **Aliasing**: two views of one account (parameters, remaining accounts, references held across a call), writes
  through a place the right side moved.
- **Account data layout**: growable Vecs after the fixed fields, their lengths against the account size, resizing and
  the Vecs that follow, `@layout borsh` accounts.
- **Arithmetic**: every operator and cast at every width, compound assignment, `mulDiv`, rent.
- **CPIs and signing**: signer-seed arrays (including their reuse across statements), account flags in `invoke`,
  `invokeInstruction` (metas from data, the infos it hands over, `ts_alloc` of the meta array),
  account creation on pre-funded addresses, closing.
- **The runtime's parsing**: instruction data, the serialized accounts, Token-2022 extension data, oracle accounts and
  the instructions sysvar.

## Earlier reviews

Internal reviews, by the maintainers: none of them is an independent audit. Their findings and fixes are in the
CHANGELOG.

### 0.44.0 (2026-11-11)

A second internal review, of 0.44.0 as published, over the areas the review of 0.43.0 left out: the token,
Token-2022 and Metaplex CPI wrappers' emitters, the oracle readers, the Stake wrappers and signature introspection,
SBPF v1 and v2 builds, optional accounts, `Dup<…>`, and the heap and stack limits. It probed each with targeted
programs run in LiteSVM against the real token programs, and read the runtime header and the C generated for them.

Defects found, fixed in 0.44.1 (its CHANGELOG section, with a test for each):

- **A None authority in `mint.create`'s `transferFee` was 33 bytes.** Token-2022 reads a None COption as one byte,
  so the 32 zero bytes after it became the next fields: a mint with a null config authority got no withdraw
  authority and a fee of 0. The standalone `initializeTransferFeeConfig` was right.
- **A reference held across a resize through another slot.** The reference rule compared names only: with a
  `Dup<…>` pair, a read-only and a writable account of one type, or a loaded struct naming one account, a reference
  made through one slot outlived a push, pop or clear through the other and reached another record. Such programs are
  now refused, as with one name.
- **Wrapper arguments out of source order.** Twelve token wrappers and the Stake wrappers read their signer seeds
  before an earlier argument's code ran (a PDA other than the one the source names); amounts of `transfer` and the
  like, and account text given to the metadata wrappers, were read after a later argument's code ran.
- **A 355-byte mint.** Extensions adding up to a Multisig's length made `mint.create` fail every time (Token-2022
  sizes such a mint 357).
- **`updateExtraAccountMetas` growth.** The 10 KiB limit was counted from the current length, so after a
  `resizeAccount` it could write past the runtime's room into the next account's record.
- **Heap Vec aliasing in the runtime.** `ts_hvec_reserve` wrote through a type the C aliasing rules let the optimizer
  treat as unrelated to the generated code's (latent; no miscompile seen).
- **Oracle documentation.** What `pythPrice` and `switchboardValue` do not check was not said plainly; the readers are
  unchanged (docs/security-model.md).

Examined and found sound: the other token and Token-2022 wrappers' optional keys (the standalone initializers'
COptions and Borsh Options, the OptionalNonZero keys of the pointer, hook, group and interest extensions); Token-2022
mints and accounts with extensions not taken for one another; several large token-metadata buffers in one
instruction; the Ed25519 signature readers against hostile offsets (into another instruction, a zero count, the same
bytes under another program id, a fake Instructions sysvar); optional accounts left out or passed unsigned; `Dup<…>`
pairs without references across a resize; the heap frame and stack limits; and checked arithmetic at every integer
width, built for SBPF v0, v1 and v2 from the same source, with the same results.

Not reviewed: the Metaplex wrappers for unusual argument shapes beyond reading them, the large ports (Marginfi,
Phoenix, Raydium, the Stake Pool) built for SBPF v1 and v2, and Windows.

### 0.43.0 (2026-11-11)

An internal review of 0.43.0 as published. It probed the compiler's semantics with targeted programs (helpers,
references, closures, seeds, `close()`, Borsh decoding), read the runtime header and the C generated for those
programs, and exercised the tooling (the CLI commands and `typesol/testing`). It did not cover the emitters of the
Metaplex and token CPI wrappers, the oracles, builds for SBPF v1 and v2, or Windows.

Defects found, fixed in 0.44.0 (its CHANGELOG section, with a test
for each):

- **Helper arguments were not copies.** A Pubkey, Option, string or u256 argument reaches a helper as a pointer to the
  caller's object (that is how the SBF backend passes it), so a helper that was not inlined and wrote that object read
  its own write through the parameter: an authorization check on the old value (`rotate(v, v.admin, caller)` with
  `v.admin = v.pending` inside) passed on the new one. Whether it happened depended on clang's inlining.
- **Seed lists were read at the CPI instead of where they are written.** A list bound to a name, given to a helper,
  or written beside an argument with side effects read its seeds when the CPI ran, so after `st.count += 1n` the
  program signed for another PDA than the one the source names.
- **The reference rule was skipped for account-group fields and loaded accounts.** A reference into an account used
  after a helper that may move the account's data is refused; it was not when the account reached the helper as an
  account-group field or had been loaded with `loadAccountMut`, and such a program wrote through the stale reference.
- **Borsh length checks wrapped.** The decoder subtracted before comparing, so for an `Option` of a struct holding an
  Option (or a Vec of such structs) a short buffer wrapped the subtraction and the read went past the end of the
  input: bounded by the struct's size, and read only.
- **Evaluation order with closures.** A local read before a closure or list callback that changes it kept the new
  value instead of the one it had when read; a string viewing text inside an `Inout` place was not copied for the
  helper taking the place.
- **`close()` gaps.** Closing an account into itself compiled, `Dup<…>` was accepted on an account the body closes,
  and an account could be used after `close()` in the same instruction (its writes were dropped).
- **Tooling: IDL text reached generated code unvalidated.** `typesol cpi` and `typesol port` wrote names and other text
  from the IDL they were given into the TypeScript they generate without the checks `typesol client` makes.

Programs built with 0.43.0 or earlier should be rebuilt with 0.44.0 or later and redeployed. The first defect is
the one that can break an authorization check; [security-model.md](security-model.md#review-of-0430-2026-11-11)
says how to tell whether a program was exposed to it.

### Before 0.43.0

Internal reviews in October 2026. The releases from 0.26.0 to 0.42.0 were not reviewed one by one: the 0.43.0 review
read the code that includes them, but probed only the areas above. They add, among others, `u256`, big-endian seeds
and accounts loaded in the body (0.37.0), stored bumps in nested fields and error members without messages (0.38.0),
`@code`, `@repr` / `@serialization`, `@bytes` / `@idlName`, `f64`, Options inside Options in arguments and events,
loop-scoped `loadAccountMut` with `Dup<T>`, account resizing and raw writes, `systemProgram.createPda` (0.39.0), and
the native-program surface: `loadRaw` / `loadRawMut` (accounts without a discriminator), instruction data readers,
error code 0, built-in ProgramErrors, `panic`, `PANIC_ON_OVERFLOW` (0.40.0), the agent tooling (`typesol mcp`, 0.41.0),
Borsh accounts without a discriminator, `BigVec<T>`, typed CPIs on remaining accounts and the Stake program's CPIs
(0.42.0), views at run-time offsets (`loadRawAt`, `rawArrayAt`), the built-in red-black tree (`rbTreeAt`), `Inout<T>`
helper parameters and `closeRaw` (0.43.0). An external review should include them; the native-program surface first,
since it skips the account checks Anchor-style parameters get, and the areas the 0.43.0 review did not cover.

- **0.25.0** (runtime and emitted checks): two Medium issues fixed, a remaining account loaded mutably twice through
  the same slot, and a Vec element written after its right side resized the Vec; plus a token program ambiguity,
  `mint::token_program`, oracle options and documentation of `requirePda`, Merkle leaves and `createIfNeeded`.
- **0.24.0** (compiler review): helper and closure expansion scoped to their own module, stale struct references
  across Vec moves refused, account-shadowing parameters refused; client SDK hardening.
- Earlier releases: see `test/security/regressions.test.ts` and `test/security/hardening.test.ts`, which keep every
  attack that once worked as a failing transaction.

## Evidence

- **Tests**: by subject under `test/` (`docs/architecture.md`); the count of each run is in CI's log.
  `test/security/` holds the attacks.
- **Differential tests**: the same transactions to TypeSOL and to Anchor twins (`test/anchor-twins`), comparing
  outcomes, account contents and balances after every step.
- **Model-based fuzzing** (`test/verification/`): arithmetic against BigInt at every width, `u256` against BigInt,
  Marginfi's I80F48 against vectors the `fixed` crate wrote; honest and hostile action sequences against state models
  with value conservation; account layout with two growable Vecs and aliasing through remaining accounts. Each run
  prints its seed (`FUZZ_SEED`), `pnpm fuzz` runs them wide.
- **Random transactions against mainnet binaries**: Jito's three MEV programs (`showcase/test/fuzz-jito.test.ts`),
  Marginfi's administration and interest (`showcase/test/fuzz-marginfi.test.ts`) and Raydium CLMM (the `fuzz:`
  case of its differential test) take random sequences of honest and hostile
  transactions, in the original and the port alike, with the same outcome, account bytes and events required after
  every step. A new seed on every run, CI's included.
- **Ported programs**: all 46 programs of solana-developers/program-examples, run through their original tests' flows
  and failure paths ([showcase/program-examples/README.md](https://github.com/typesol-lang/typesol/blob/main/showcase/program-examples/README.md)).
- **Four-way comparison**: [typesol-lang/benchmarks](https://github.com/typesol-lang/benchmarks) runs 17 of those programs in
  TypeSOL, Anchor, native Rust and Pinocchio, requires the same outcome, and records how each refuses the hostile calls
  and with which error.

## Running it

```sh
git clone https://github.com/typesol-lang/typesol && cd typesol
pnpm install && pnpm build
pnpm fetch:programs        # Metaplex binaries for the token-metadata, Core and Bubblegum tests
pnpm build:twins           # the Anchor twins (Rust + Anchor 1.0.2)
pnpm test                  # everything; CI runs it on Ubuntu (Node 22, 24) per change, macOS on demand (macos.yml)
pnpm fuzz                  # the randomized checks, wide
```

`node dist/cli.js build <program.ts> --out <dir>` writes the generated C next to the binary, which is the most direct
way to review what a construct compiles to; `test/golden/counter.c` is a pinned example.

## Contact

Coordinate through a private advisory on https://github.com/typesol-lang/typesol/security, or report findings the same way
(SECURITY.md).
