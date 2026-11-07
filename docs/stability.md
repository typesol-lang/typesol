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
- Metaplex CPIs (Token Metadata, Core, Bubblegum), oracles (Pyth, Switchboard), the Stake program.
- Functions chosen at run time and lists of functions, closures returned from functions.
- `typesol/testing`'s epochs and staking: `warpToEpoch`, `nextEpoch`, `StakeCluster`, `stakeActivation`, the vote and
  stake account builders and `readStakeAccount`.
- Tools: `typesol port`, `clone`, `profile`, `cpi`, the editor plugin, the MCP server and the agent files `init`
  writes, the SBPF v1 and v2 targets.

## Before 1.0

- **An external audit** of the compiler and runtime ([audit package](audit.md)), its findings fixed and published.
- **Settle the open edges**, each either supported or refused with a clear error:
  - a struct holding a FixedVec as both an argument and account data (two layouts, one IDL type);
  - helpers that take a writable struct which is not an account (a `loadRaw` view, a local), now refused;
  - `require` with an error code computed at run time that is 0: fails as an overflow (5100) today, where a native
    program returns CUSTOM_ZERO;
  - which experimental parts above become stable, and which stay outside the 1.0 promise.
- **A release candidate** (1.0.0-rc) used for the showcase ports and the templates, with no breaking change between it
  and 1.0.0.
