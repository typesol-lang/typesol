# Stability and the road to 1.0

TypeSOL is pre-1.0. Until 1.0, a minor release (0.x → 0.y) may change the language, the account and IDL layout of
generated programs and error codes, and says so in the CHANGELOG ([versioning
policy](https://github.com/typesol-lang/.github/blob/main/VERSIONING.md)). This page says what 1.0 will promise, which
parts are already meant to stay as they are, and what has to be settled first.

## What 1.0 will promise

From 1.0 on, within a major version:

- **Sources keep compiling.** A program that compiles with 1.x compiles with every later 1.y, to a program with the same
  account layouts, IDL, instruction and account discriminators and error codes. New releases add; they do not take away.
- **Binaries are reproducible and only change for a reason.** A release that changes the binary of a program that uses
  none of its new features says so, with the release manifest's diff (`binary-diff.txt`) as the evidence.
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

## Experimental

Useful today, but may still change before 1.0 (each change listed in the CHANGELOG):

- The native-program surface (0.40.0): `loadRaw` / `loadRawMut`, the instruction data readers, error code 0,
  `ProgramError`, `panic`, `PANIC_ON_OVERFLOW`, `ERROR_LOG_PREFIX` / `PROGRAM_ERROR_LOG_PREFIX`, `logBase64`,
  `createProgramAddress`.
- `loadBorsh` / `storeBorsh` (0.42.0): a native program's Borsh accounts read into a local struct and written back.
- `BigVec<T>` (0.42.0): SPL's `big_vec`, a list over the rest of a native account.
- Views at run-time offsets (unreleased): `loadRawAt` / `loadRawMutAt`, `rawArrayAt` / `rawArrayMutAt`.
- The built-in RedBlackTree (unreleased): `rbTreeAt` / `rbTreeMutAt`, lib-sokoban 0.3's byte layout and algorithms,
  its panics in solana-program 1.14–1.17's format.
- `panic(null, location)` (no log line) and `abort()` (Rust's abort, "SBF program panicked") (0.42.0).
- Failures without a log line (unreleased): `ERROR_LOG_PREFIX = null` / `PROGRAM_ERROR_LOG_PREFIX = null`.
- `findProgramAddressWithBump` (unreleased), with `const [address, bump] = …` its only array destructuring.
- Plain type aliases (unreleased): `type Price = u64`, replaced by the type they name.
- Local `FixedVec` / `FixedArray` lists of structs, `FixedVec.pushAll`, the instruction data as a list (`slice`,
  `InstructionBytes` helper parameters), `invokeInstruction` in helpers (0.42.0); local FixedVecs given for read-only
  `FixedVec<T, N>` / `Vec<T>` helper parameters (unreleased).
- `epochRewards()` and `EpochRewards` (0.42.0): the EpochRewards sysvar through its syscall.
- `NATIVE_ACCOUNT_WRITES` (0.42.0): opt-in native write semantics for `loadRawMut`, `storeBorsh` and BigVec writes
  (writability and aliasing left to the runtime). It drops checks a program would otherwise get, so it stays outside
  "the checks stay" promise above: it only applies to programs that declare it.
- `Inout<T>` helper parameters (unreleased): a helper that changes a struct, FixedArray or FixedVec of the caller's
  that is not an account (a local, a `loadBorsh` local, a field of a `loadRawMut` view, a list element), with the
  aliasing rules at each call. It settles the open edge of helpers taking a writable struct that is not an account,
  which were refused; the rules (what counts as overlapping, which places may move) may still be refined.
- For native ports (Unreleased): `setReturnData` and `logComputeUnits` in a native entry; `closeRaw`, `assignOwner`
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
