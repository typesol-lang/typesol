# Stability and the road to 1.0

TypeSOL is pre-1.0. Until 1.0, a minor release (0.x → 0.y) may change the language, the account and IDL layout of
generated programs and error codes, and says so in the CHANGELOG ([versioning
policy](https://github.com/typesol-lang/.github/blob/main/VERSIONING.md)). This page says what 1.0 will promise, which
parts are already meant to stay as they are, and what has to be settled first.

## What 1.0 will promise

From 1.0 on, within a major version:

- **Sources keep compiling.** A program that compiles with 1.x compiles with every later 1.y, to a program with the same
  account layouts, IDL, instruction and account discriminators and error codes. New releases add; they do not take away.
- **Binaries are reproducible and only change for a reason.** With the same TypeSOL release, in the build container
  (`--docker`), a source builds to the same bytes on every machine; outside it, to the same C, IDL and object code on
  every host, and to the same binary except where the platform-tools host packages differ ([below](#what-builds-the-same-bytes-where)).
  A release that changes the binary of a program that uses none of its new features says so, with the release
  manifest's diff (`binary-diff.txt`) as the evidence.
- **The checks stay.** No check a program gets from its parameter types (owner, discriminator, signer, writability,
  aliasing, checked arithmetic, constraints) is removed or weakened.
- **The tools keep their interfaces**: `typesol build`, `test` (via `typesol/testing`), `check --json`, `deploy`,
  `verify`, `idl`, the typed client, and `typesol.json`.

## Stable already

Meant to stay as they are; a change before 1.0 would be a breaking change listed as one:

- Types: the integers (`u8` … `u128`, `i8` … `i128`), `boolean`, `Pubkey`, `Hash`, structs, `FixedArray`, `FixedVec`,
  `Vec`, `FixedString`, `Option`, unit and data enums, `u256` in computation.
- Account parameters and their checks: `Signer`, `Account<T>`, `Mut<T>`, `Init<T>`, `InitIfNeeded<T>`, `Zeroed<T>`,
  optional accounts, token accounts and mints, programs, sysvars, account groups; the constraints (`HasOne`, `Seeds`,
  `CloseTo`, `Ata`, `Address`, `Owner`, `Executable`).
- Errors and events: error enums and their codes, `require`, `AnchorError`, `emit`, `emitCpi`.
- CPIs: System, SPL Token, Token-2022, Associated Token, Memo, generic `invoke` with PDA signing.
- Layouts: account data (Anchor's discriminator and fixed or `@layout borsh` layout), the IDL, the client.

## What a release gives you now

- **The npm package is the one that was checked.** From 0.43.0 on, `releases/<version>.json` in the repository holds
  the published tarball's shasum and integrity and every file's sha256, packed from a clean export of the release tag
  after install, build and lint. `npm pack` is reproducible here, so anyone can pack the tag again and compare, or
  compare the registry with `node scripts/release-check.ts <version> --verify --registry`
  ([docs/testing.md](testing.md#the-npm-tarball)).
- **The tests cover one toolchain.** Each release declares the Agave and platform-tools it is tested with
  (`TESTED_TOOLCHAIN`, exported from `typesol/compiler`; Agave 3.1.10 and platform-tools v1.52 now). A binary built with
  another clang is outside what the tests cover: `typesol build` and `deploy` warn once, `--toolchain-strict` (or
  `TYPESOL_TOOLCHAIN=strict`) refuses it, and `typesol doctor` shows which one is active.
- **A build says what made it.** `<name>.build.json` records the TypeSOL, TypeScript, clang and platform-tools versions,
  the host, the SBPF version and the sha256 of every source and of the binary. `typesol verify` uses it to say, on a
  mismatch, whether the toolchains differ. A program on chain records none of this: keep the file with the deployment.
- **A deployed program anyone can rebuild.** `typesol build --docker` builds in a container made from
  `docker/Dockerfile` (in the package), whose inputs are all pinned: base images by digest, the Agave and
  platform-tools release files by sha256, the TypeSOL tarball by its `releases/<version>.json`. `typesol verify
  --docker` rebuilds there and says what it verified. The image is built locally from those inputs; no image is
  published, and the result is not registered with any external verified-build registry
  ([docs/mainnet.md](mainnet.md#6-verify)).
- **Fixes come as patches of the latest minor.** From 0.44.0 on, a release that only fixes soundness or security
  defects is a patch (0.44.1, …) with no new language surface, and its notes carry the binary diff against the
  previous release ([SECURITY.md](../SECURITY.md#fix-releases)). Older minors are not maintained.

## What builds the same bytes where

Measured with TypeSOL 0.44.0 (the npm tarball) and platform-tools v1.52 on macOS arm64 (the platform-tools
`osx-aarch64` package), Linux arm64 and Linux x86_64 (the `linux-aarch64` and `linux-x86_64` packages, in
containers): the 76 programs of the 0.44.0 sources (`scripts/release-manifest.ts`).

| What | Same on every host? |
| --- | --- |
| The generated C (all 76) | yes |
| The IDL (all 76) | yes |
| clang's object code (`.o`, checked for counter and Phoenix) | yes |
| `ld.lld`'s output from the same inputs | yes: each host's lld linked the same objects and libraries to the same bytes |
| The binary, 66 of 76 programs (counter, vault, escrow, multisig among them) | yes |
| The binary, 10 of 76 (the Phoenix, Marginfi, Raydium, Jito priority-fee and Stake Pool ports, transfer-fee, token-fundraiser, token-swap) | no: three different binaries on the three hosts (token-fundraiser: the two Linux ones agree) |

The cause is one library. Each platform-tools host package ships its own build of the SBF `compiler-builtins` Rust
library (`libcompiler_builtins-<hash>.rlib`, another file and another hash in each package); linking the same object
against another host's copy gives the other host's binary. A program links what it calls: the 66 that agree use at
most `__multi3` (64×64→128 multiplication), which builds the same in every package; the 10 that differ call 128-bit
or signed 64-bit division or shifts (`__udivti3`, `__umodti3`, `__divti3`, `__divdi3`, `__lshrti3`, …), whose code
differs between packages. Nothing in the emitted C, the paths or the build directory reaches the binary.

So the reference environment is one platform: the build container is `linux/amd64` on every machine (emulated on
arm64 hosts), and CI checks on every change that a Linux x86_64 runner with independently installed platform-tools
builds the programs of `test/golden/binaries.json` (including Phoenix) to the container's bytes. A build outside the
container is still reproducible on the same kind of host; `<name>.build.json` records the host, and `typesol verify`
names a host difference when it is the only one.

## Experimental

Useful today, but may still change before 1.0 (each change listed in the CHANGELOG):

- The native-program surface (0.40.0): `loadRaw` / `loadRawMut`, the instruction data readers, error code 0,
  `ProgramError`, `panic`, `PANIC_ON_OVERFLOW`, `ERROR_LOG_PREFIX` / `PROGRAM_ERROR_LOG_PREFIX`, `logBase64`,
  `createProgramAddress`.
- `loadBorsh` / `storeBorsh` (0.42.0): a native program's Borsh accounts read into a local struct and written back.
- `BigVec<T>` (0.42.0): SPL's `big_vec`, a list over the rest of a native account.
- Views at run-time offsets (0.43.0): `loadRawAt` / `loadRawMutAt`, `rawArrayAt` / `rawArrayMutAt`; a read-only
  view read where it is made (`loadRaw<T>(a).field`, `rbTreeAt(…).length`), and the owner check's cache the views share.
- The built-in RedBlackTree (0.43.0): `rbTreeAt` / `rbTreeMutAt`, lib-sokoban 0.3's byte layout and algorithms,
  its panics in solana-program 1.14–1.17's format, `removeAt(index)` (what it gives for a node in no tree may change).
- `panic(null, location)` (no log line) and `abort()` (Rust's abort, "SBF program panicked") (0.42.0).
- Failures without a log line (0.43.0): `ERROR_LOG_PREFIX = null` / `PROGRAM_ERROR_LOG_PREFIX = null`.
- `findProgramAddressWithBump` (0.43.0), with `const [address, bump] = …` its only array destructuring.
- Plain type aliases (0.43.0): `type Price = u64`, replaced by the type they name.
- File-local structs (0.43.0): `interface Pair { … }` without `export`, for helpers and locals, out of the IDL.
- Constant expressions (0.43.0): top-level integer constants folded from literals and earlier constants, a typed
  one computed in its type.
- Comma-separated `for` updates and initializers (0.43.0).
- Stack room (0.43.0): `/** @noinline */` helpers and `/** @heap */` locals.
- Local `FixedVec` / `FixedArray` lists of structs, `FixedVec.pushAll`, the instruction data as a list (`slice`,
  `InstructionBytes` helper parameters), `invokeInstruction` in helpers (0.42.0); local FixedVecs given for read-only
  `FixedVec<T, N>` / `Vec<T>` helper parameters (0.43.0).
- `epochRewards()` and `EpochRewards` (0.42.0): the EpochRewards sysvar through its syscall.
- `NATIVE_ACCOUNT_WRITES` (0.42.0): opt-in native write semantics for `loadRawMut`, `storeBorsh` and BigVec writes
  (writability and aliasing left to the runtime). It drops checks a program would otherwise get, so it stays outside
  "the checks stay" promise above: it only applies to programs that declare it.
- `Inout<T>` helper parameters (0.43.0): a helper that changes a struct, FixedArray or FixedVec of the caller's
  that is not an account (a local, a `loadBorsh` local, a field of a `loadRawMut` view, a list element), with the
  aliasing rules at each call. It settles the open edge of helpers taking a writable struct that is not an account,
  which were refused; the rules (what counts as overlapping, which places may move) may still be refined.
- For native ports (0.43.0): `setReturnData` and `logComputeUnits` in a native entry; `closeRaw`, `assignOwner`
  and `resizeAccount` on remaining accounts; the byte builders of `FixedVec<u8, N>` (`pushLE`, `pushKey`, `pushBorsh`,
  `setLE`, `truncate`); `PANIC_STYLE = "solana-1.14"` and `panicsAt(location, expression)`.
- Metaplex CPIs (Token Metadata, Core, Bubblegum), oracles (Pyth, Switchboard), the Stake program.
- `programAt<P>` / `sysvarAt<S>` and remaining accounts in the typed CPIs (System, Token, ATA, Memo, Stake); a ternary
  between remaining accounts and `AccountInfo` parameters (0.42.0).
- Functions chosen at run time and lists of functions, closures returned from functions.
- `typesol/testing`'s epochs and staking: `warpToEpoch`, `nextEpoch`, `StakeCluster`, `stakeActivation`, the vote and
  stake account builders and `readStakeAccount`.
- Tools: `typesol port`, `clone`, `profile`, `cpi`, the editor plugin, the MCP server and the agent files `init`
  writes, the SBPF v1 and v2 targets.

## Before 1.0

- **An external audit** of the compiler and runtime ([audit package](audit.md)), its findings fixed and published.
- **Settle the open edges**, each either supported or refused with a clear error:
  - a struct holding a FixedVec as both an argument and account data (two layouts, one IDL type);
  - `require` with an error code computed at run time that is 0: fails as an overflow (5100) today, where a native
    program returns CUSTOM_ZERO;
  - which experimental parts above become stable, and which stay outside the 1.0 promise.
- **A release candidate** (1.0.0-rc) used for the showcase ports and the templates, with no breaking change between it
  and 1.0.0.
