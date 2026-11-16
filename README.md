<p align="center">
  <img alt="TypeSOL" src="assets/readme/header.png" width="520">
</p>

<h3 align="center">Write Solana programs in TypeScript. Ship native SBF.</h3>

<p align="center">
  <a href="https://github.com/typesol-lang/typesol/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/typesol-lang/typesol/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-3178C6"></a>
  <a href="https://www.npmjs.com/package/@typesol/cli"><img alt="npm version" src="https://img.shields.io/npm/v/@typesol/cli"></a>
  <img alt="Target: Solana SBF" src="https://img.shields.io/badge/target-Solana%20SBF-14F195">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="https://typesol.com">Website</a> ·
  <a href="https://typesol.com/docs/">Docs</a> ·
  <a href="https://typesol.com/docs/changelog/">Changelog</a> ·
  <a href="#numbers">Benchmarks</a> ·
  <a href="docs/language.md">Language reference</a> ·
  <a href="https://x.com/type_sol">X</a>
</p>

TypeSOL compiles a TypeScript subset straight to Solana bytecode. It does not use an interpreter or a VM on chain, and
it does not generate Rust. Your `.ts` file is typechecked by the TypeScript compiler, lowered to C, and built with the
same LLVM toolchain that `cargo-build-sbf` uses. Every build also writes an **Anchor-compatible IDL**, so Anchor
clients read TypeSOL programs unchanged.

- **One language, end to end.** You write the program and its tests in TypeScript, and every build writes a typed
  client for it ([docs/client.md](docs/client.md)). Your editor gives you completion and type errors throughout.
- **Checked by default.**
  - Every arithmetic operation is checked.
  - Account owner, discriminator, signer, writability and aliasing checks are generated from your parameter types.
  - Constraints follow Anchor's rules and use Anchor's error codes.
- **Small and fast.** In the counter, vault and escrow benchmarks below, TypeSOL uses 5–32% of Anchor's compute units,
  with binaries about 10× smaller, and fewer compute units than native Rust and hand-tuned Pinocchio on every
  instruction. On 17 official example programs it uses fewer than Anchor and native Rust on every instruction, and
  more than their Pinocchio versions on 13 of the 26 ([Numbers](#numbers)). On mainnet the results differ by
  instruction; see [the mainnet table](#on-mainnet).
- **Checked against mainnet.** Nine ports of deployed programs (eleven programs: Jito MEV's row is three), among them
  Marginfi v2, Phoenix v1 and SPL Stake Pool, run beside the original binaries: the same outcomes, events, return data
  and account bytes on thousands of transactions, and the same error codes and log lines but for the exceptions each
  case study lists, for fewer compute units ([the ports](#ported-and-checked-against-mainnet-binaries)).
- **Verifiable.** `typesol verify` reads a deployed program from the cluster and checks it, and the IDL published on
  chain, against its source. Every release records its npm tarball in `releases/<version>.json` ([releases/](releases)),
  and the hashes of every program it builds in its GitHub Release's `typesol-<version>-manifest.json`
  ([docs/testing.md](docs/testing.md#reproducing-a-release)).
  The same source, TypeSOL version and toolchain build to the same bytes on macOS arm64, Linux arm64 and Linux x86_64
  (measured with 0.45.0: all 76 programs then in the sources for SBPF v0, 14 of them for v1 and v2; programs added
  since, the Meteora DBC and Percolator ports among them, were not in that measurement; Linux arm64 with the platform-tools
  `linux-aarch64` package set up as in [Requirements](#requirements), since there is no Agave CLI for it;
  [docs/stability.md](docs/stability.md#what-builds-the-same-bytes-where)).
  `typesol build --docker` builds in a pinned linux/amd64 container that anyone can rebuild from the Dockerfile, and
  `typesol verify --docker` checks a deployed program against its source in that same environment
  ([docs/mainnet.md](docs/mainnet.md#6-verify)).

**Try it** in the browser, with nothing to install: [typesol.com/play](https://typesol.com/play/). On your machine, once
Node.js and the Solana toolchain are in place ([Quick start](#quick-start), [Requirements](#requirements)):
`npx @typesol/cli init my-app`, then `cd my-app && npm install && npm test`.

<p align="center">
  <a href="#numbers">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/readme/benchmarks-dark.svg">
      <img alt="Benchmark summary: compute units and binary size of TypeSOL, Pinocchio, native Rust and Anchor" src="assets/readme/benchmarks-light.svg" width="900">
    </picture>
  </a>
</p>

## Ported and checked against mainnet binaries

Each port is the whole program, written in TypeSOL from the original's source. Its tests send every transaction to
the port and to the binary deployed on mainnet, both in LiteSVM, and require the same outcome, events, return data and
bytes in every account the transaction names, and the same error code and log lines, with the exceptions each case
study lists. Of those, the kinds that recur:

- **Error-message text.** The Anchor ports log their errors in TypeSOL's words, with Anchor's codes; Jito's also leaves
  out Anchor's `Instruction: …` lines.
- **Panics.** Where the original panics, Marginfi, Raydium CLMM, Raydium CP-Swap and Jito MEV fail with a numbered
  error, and Marginfi also answers a few runtime errors that carry no code (`AccountBorrowFailed`, `BorshIoError`)
  with numbered ones; the tests require that both fail.
- **Informational logs.** Marginfi writes only the original's `WARN` lines, of about 160 `msg!` lines.
- **Raydium CLMM's reward mints**, kept in the order added, so `OperationState`'s bytes differ when two or more are
  listed.
- **Compute.** A Percolator keeper crank that exceeds the compute budget in the original completes in the port.

Phoenix v1, Raydium AMM v4, SPL Stake Pool and Percolator match every log line of the compared transactions, panics
included, except the runtime's compute-unit lines. The port must also use fewer compute units on every transaction that succeeds. A case study for
each (for Percolator, the port's README) says what was compared and what was not.

| Program | Kind | Instructions | Transactions compared |
| --- | --- | ---: | ---: |
| [Marginfi v2](docs/case-study-marginfi.md) | Anchor, lending | 124 | 2,321 |
| [Phoenix v1](docs/case-study-phoenix.md) | native, limit order book | 28 | 3,575 |
| [SPL Stake Pool](docs/case-study-spl-stake-pool.md) | native, liquid staking | 27 | 2,107 |
| [Raydium CLMM](docs/case-study-raydium-clmm.md) | Anchor, concentrated liquidity | 37 | 302 |
| [Raydium CP-Swap](docs/case-study-raydium-cp-swap.md) | Anchor, constant product | 21 | 136 |
| [Raydium AMM v4](docs/case-study-raydium-amm.md) | native, constant product | all | 144 (60 random steps) |
| [Jito MEV](docs/case-study-jito-mev.md) | Anchor, three programs | 24 | 150 |
| [Percolator v12.20](showcase/mainnet/percolator) | native, perpetuals risk engine | 27 | 139,185 (132,031 random or mutated: 3,711 in random walks on fixed seeds, 128,320 from the mutation fuzzers) |
| [coral-xyz/multisig](docs/case-study-multisig.md) | Anchor | all | 55 |

A tenth port is held to a narrower comparison and is not counted above:
[Meteora Dynamic Bonding Curve 0.2.2](showcase/mainnet/meteora-dbc) (Anchor, launchpad, all 35 instructions, with its
migrations into DAMM v1 and DAMM v2). Outcomes, error codes, account bytes, inner instructions (its events are
self-CPIs) and return data are compared as for the ports above, with the exceptions its README lists; of the log only
the events' `Program data:` lines are compared, not the rest of its text, and compute units are not compared. The
port, its tests (`showcase/test/meteora-dbc*.ts`) and their fixtures (`showcase/test/fixtures/meteora-dbc/`) are under
Meteora's Non-commercial Licence, not this repository's (see [NOTICE](NOTICE)).

Each count is what a default test run compares, with the fetch-only binaries present (`pnpm fetch:programs`). Random
walks, with fixed or printed seeds, run on top of the other ports' counts ([docs/testing.md](docs/testing.md)); the
multisig port has none. The
sources are in [`showcase/mainnet`](showcase/mainnet), and where each original binary comes from is recorded in
[test/programs/SOURCES.md](test/programs/SOURCES.md).

## At a glance

**`counter.ts`**: a complete program, 23 non-blank lines. (`typesol init` writes it with one more instruction, a read-only
`assertAtLeast`.)

```ts
import { type Init, type Mut, type Pubkey, type Signer,
         type SystemProgram, type u8, type u64, require } from "typesol";

export interface Counter {
  authority: Pubkey;
  count: u64;
  bump: u8;
}

export enum CounterError {
  Unauthorized = "Only the counter's authority can change it",
}

export function initialize(
  authority: Mut<Signer>,
  counter: Init<Counter>,
  systemProgram: SystemProgram,
): void {
  counter.bump = counter.create(authority, ["counter", authority.key]);
  counter.authority = authority.key;
  counter.count = 0n;
}

export function increment(authority: Signer, counter: Mut<Counter>, by: u64): void {
  require(counter.authority === authority.key, CounterError.Unauthorized);
  counter.count += by; // overflow-checked
}
```

<details>
<summary><b>The same program in Anchor</b>: 44 non-blank lines of Rust</summary>

```rust
#[program]
pub mod counter {
    use super::*;
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let c = &mut ctx.accounts.counter;
        c.authority = ctx.accounts.authority.key();
        c.count = 0;
        c.bump = ctx.bumps.counter;
        Ok(())
    }
    pub fn increment(ctx: Context<Increment>, by: u64) -> Result<()> {
        let c = &mut ctx.accounts.counter;
        require_keys_eq!(c.authority, ctx.accounts.authority.key(),
                         CounterError::Unauthorized);
        c.count = c.count.checked_add(by)
            .ok_or(error!(CounterError::Overflow))?;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Counter { pub authority: Pubkey, pub count: u64, pub bump: u8 }

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Counter::INIT_SPACE,
              seeds = [b"counter", authority.key().as_ref()], bump)]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub counter: Account<'info, Counter>,
}

#[error_code]
pub enum CounterError {
    #[msg("Only the counter's authority can change it")]
    Unauthorized,
    #[msg("arithmetic overflow")]
    Overflow,
}
```

</details>

Both programs accept the same instructions and store the same account layout. The test suite sends identical
transactions to both and compares the results.

## Quick start

No install: try TypeSOL in the browser at [typesol.com/play](https://typesol.com/play/).

You need Node.js 22.12 or later and the Agave CLI with its platform-tools, which hold the clang TypeSOL compiles with.
Rust is not needed. TypeSOL is tested with **Agave 3.1.10 and platform-tools v1.52** (clang 20.1.7); to install exactly
those on macOS or Linux x86_64 (Linux arm64: see
[Requirements](https://github.com/typesol-lang/typesol#requirements)):

```sh
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"
# The installer adds this line to ~/.profile for new shells, and this shell needs it now:
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
# Once: this downloads the platform-tools, about 0.5 GB and up to 1.6 GB unpacked, and prints nothing for a minute or two:
cargo-build-sbf --install-only --force-tools-install --tools-version v1.52
```

```sh
npx @typesol/cli init my-app --name counter
cd my-app && npm install
npm test
npx --no-install typesol build
```

`init` writes `typesol.json`, `programs/counter.ts`, `tests/counter.test.ts` and a tsconfig. `npm test` builds the program
and runs it in LiteSVM, an in-process Solana runtime. `build` writes `target/counter/`: `counter.so`, `counter.json` (the
IDL), `counter.client.ts` and `counter.build.json`.

`init` also writes rules and an MCP server config for AI coding agents (AGENTS.md, CLAUDE.md, `.cursor/`, `.mcp.json`)
and lists them; `--no-agent-files` leaves them out. `typesol/testing` encodes instructions and decodes accounts from
the IDL itself, so a new project installs neither Anchor's TypeScript package nor Solana web3.js 1.x.

Other versions work, but their binaries are not covered by the project's tests: `typesol build` warns once when the
clang is another one (`--toolchain-strict` or `TYPESOL_TOOLCHAIN=strict` makes that an error), and every build records
its clang, platform-tools and host in `<name>.build.json`.

`npx --no-install typesol doctor` checks all of this (Node.js, platform-tools and whether they are the tested ones, Solana CLI, keypair, RPC) and prints the command
that fixes anything missing. Inside a project, `npx --no-install typesol …` (or `npm run build`, `npm run deploy`) runs the
project's own copy; outside one, use `npx @typesol/cli …`. Plain `npx typesol` is not TypeSOL: `typesol` is not the npm
package's name, so where the project's copy is not installed npx would fetch whatever package has that name. Outside a
project (or before `npm install`), `npx --no-install typesol …` therefore fails with npm's `E404 … typesol - Not
found`, which does not mention `@typesol/cli`: run `npx @typesol/cli …` there, or `npm install` in the project first.

To deploy, on devnet:

```sh
# Once, if you have no keypair at ~/.config/solana/id.json:
solana-keygen new
# Test SOL for the rent. The airdrop is rate-limited, and https://faucet.solana.com also works:
solana airdrop 2 --url devnet
npx --no-install typesol deploy --url devnet
```

or on a local validator: `solana-test-validator` in another terminal, `solana airdrop 5 --url localhost`, then
`npx --no-install typesol deploy --url localhost`. `deploy` checks the payer's keypair, the RPC and the payer's balance
before sending anything, and stops with the command to run when one is missing.

`--template vault` or `--template escrow` starts from a SOL vault or an SPL token escrow instead of the counter, each
with a passing LiteSVM test.

The npm package is [`@typesol/cli`](https://www.npmjs.com/package/@typesol/cli). Projects install it under the name
`typesol`, which is what programs import (`import { … } from "typesol"`); `typesol init` sets that up. To add it to an
existing project: `npm install -D typesol@npm:@typesol/cli`.

Deploying again upgrades the program in place. Keep `target/deploy/<name>-keypair.json`: that keypair is your
program's address.

**Your first change.** Open `programs/counter.ts`, add an instruction (say `decrement`, with
`require(counter.count >= 1n, …)` before `counter.count -= 1n`), call it from `tests/counter.test.ts` and run `npm test`.
If the build refuses something, the error points at the line and, for the usual first mistakes (`1` instead of `1n`,
`console.log`, `Date.now()`, a missing import, `async`), adds a `hint:` with what to write instead; your editor shows
the same.

**Where next**
- The language, every type and built-in: [docs/language.md](docs/language.md).
- Tests with `typesol/testing` (accounts by name, plain values): [docs/test-your-program.md](docs/test-your-program.md).
- Coming from Anchor: [docs/migrate-from-anchor.md](docs/migrate-from-anchor.md) maps every construct, and
  `typesol port` starts from your program's IDL; [docs/case-study-escrow.md](docs/case-study-escrow.md) follows one
  program through the port.
- Real programs checked against their mainnet binaries: [Showcase](https://github.com/typesol-lang/typesol#showcase-ports-checked-against-mainnet), with a
  case study each (Marginfi v2 in full: all 124 instructions, 2,321 transactions with the same outcomes, events and
  account bytes; Phoenix v1, a native order book, the same on 3,575 transactions down to its event bytes and log lines;
  Raydium AMM v4, a native program, down to its log lines).
- To mainnet (wallet, cost, deploy, IDL, verification): [docs/mainnet.md](docs/mainnet.md).
- With an AI coding agent: [docs/ai.md](docs/ai.md) (agent rules, [llms.txt](https://typesol.com/llms.txt), the MCP server).

## How it works

```
counter.ts ─▶ tsc typecheck ─▶ subset check ─▶ C + typesol_rt.h ─▶ clang -target sbf ─▶ counter.so
                                      └────────────────────────────────────────────────▶ counter.json (Anchor IDL)
```

1. **Typecheck.** The TypeScript compiler checks your code against [`lib/typesol.d.ts`](lib/typesol.d.ts), which
   declares every TypeSOL type and built-in.
2. **Subset check.** TypeSOL rejects anything outside the language (floats, classes, `any`, foreign imports)
   with a `file:line:col` diagnostic, and a hint for the usual first mistakes. Nothing is half-supported.
3. **Lower.** Instruction bodies become C. Account validation, checked arithmetic, Borsh encoding and CPI plumbing
   come from [`runtime/typesol_rt.h`](runtime/typesol_rt.h).
4. **Build.** The Agave platform-tools `clang` and `ld.lld` produce the `.so` (SBPF v0 by default; v1 and v2 with
   `--sbpf`).

Runtime failures point back to your source: `Error 6000 Unauthorized (counter.ts:25)`, or
`TypeSOL: arithmetic overflow (vault.ts:44)`.

## What you can write

| | |
| --- | --- |
| **Accounts** | `Signer`, `Account<T>`, `Mut<T>`, `Init<T>`, `InitIfNeeded<T>` (PDAs or keypair accounts, with Anchor's `space`; mints, token accounts and associated token accounts), `Zeroed<T>` (up to 10 MiB), optional accounts (`A \| null`), token accounts and mints, `SystemAccount`, programs, sysvars, and account groups (Anchor's composite accounts) |
| **Constraints** | `HasOne`, `Seeds` (also from account fields and under another program; `pdaBump` like `ctx.bumps`), `CloseTo`, `Ata`, `Address`, `Owner`, `Executable`. They are checked before the body runs and recorded in the IDL, and take your own error as Anchor's `@ ErrorCode.X` does |
| **Data** | `u8`…`u128`, `i8`…`i128`, `u256` (for computation), `f64` (as its bits, in events and accounts), `boolean`, `Pubkey`, `Hash`, nested structs, `FixedArray`, `FixedString`, `Option`, unit enums, data enums (discriminated unions), type aliases (`type Price = u64`), `Vec` that resizes its account, `FixedVec` lists anywhere, and Anchor's own byte layout (`@layout borsh`) to take over existing Anchor accounts and to pass, return and emit structs with String / Vec / Option fields as Anchor does |
| **Control flow** | `if`, `for`, `for … of`, `while`, `switch` (with narrowing on data enums), ternaries, `??`, destructuring, helper functions (returning structs too, changing the caller's structs and lists through `Inout<T>`, arrow functions, closures, function arguments, generics, functions chosen at run time), list callbacks (`some`, `find`, `reduce`, …, with `map` / `filter` chains that store nothing) across multiple files |
| **CPIs** | System, SPL Token, Token-2022 (including extension reads, metadata and token groups), ATA, Memo, Stake, Metaplex Token Metadata, Core, Bubblegum. Generic `invoke` with PDA signing (one or several PDAs per call), return data, and typed bindings generated from any Anchor IDL (`typesol cpi`) |
| **Events** | `emit` (log-based) and `emitCpi` (Anchor `emit_cpi!`, through a self-CPI) |
| **Crypto & oracles** | `sha256`, `keccak256`, Merkle proofs, Ed25519 and secp256k1 signature checks, Pyth pull oracle, Switchboard feeds and verifiable randomness |
| **Native programs** | a `@fallback` entry over the raw instruction data and accounts by position, Borsh accounts (`loadBorsh`), views of account bytes in place (also at offsets known only at run time) and lib-sokoban's red-black tree over them, byte builders (`pushLE`, `pushBorsh`, …), return data, `closeRaw`, and Rust's panics and overflow messages at the original's source locations |
| **Interfaces** | custom discriminators (`@discriminator`), so a TypeSOL program can be a Token-2022 transfer hook, with extra accounts (ExtraAccountMetaList) |

The [language guide](docs/language.md) explains each construct with a compiled example, and lists every type, check
and built-in.

## Tooling

| Command | What it does |
| --- | --- |
| `typesol init` | scaffold a project with a program, a LiteSVM test, TypeScript configs and the files AI coding agents read (AGENTS.md, CLAUDE.md, Cursor rules, MCP config) |
| `typesol new <program>` | add another program and its test to a project |
| `typesol clone <address…>` | copy mainnet accounts and programs for the tests, loaded by `testProgram` |
| `typesol build` | compile every program in `typesol.json`, or a single `.ts` file |
| `typesol check` | typecheck and subset-check without compiling (every program of the project, or one file); `--json` gives each error's hint as a field |
| `typesol mcp` | an MCP server for AI coding agents: check, IDL, docs search and the rules as tools ([docs/ai.md](docs/ai.md)) |
| `typesol deploy` | `solana program deploy` with the right program keypair (`--dry-run` prints the commands) |
| `typesol idl publish` | upload the IDL to the Program Metadata program (canonical when the upgrade authority signs) |
| `typesol cpi <idl.json>` | generate typed CPI helpers for another program |
| `typesol client <idl.json>` | generate a typed TypeScript client from an Anchor IDL (`typesol build` writes one per program) |
| `typesol port` | a TypeSOL skeleton of an Anchor program from its IDL, keeping discriminators and error codes |
| `typesol/ts-plugin` | the compiler's errors in the editor as you type, in every file of a program ([docs/cli.md](docs/cli.md#editor)) |
| `typesol verify` | rebuild from source and compare with the program and IDL on chain (or a dumped `.so`); `--docker` rebuilds in the pinned container |
| `typesol profile` | compute units per TypeScript line, from a `--profile` build's logs |
| `typesol emit-c` | print the generated C |

See [docs/cli.md](docs/cli.md). The compiler is also a library:

```ts
import { build } from "typesol/compiler";

const { soPath, idl } = build("programs/counter.ts", "target/counter", programAddress);
```

Subpath exports: `typesol/compiler`, `typesol/workspace`, `typesol/cpi`, `typesol/client`, `typesol/idl`,
`typesol/profile`, `typesol/testing`, `typesol/ts-plugin`.

## Numbers

The same counter, vault and escrow programs, written four ways. All four use the same instruction encoding, account
layout and checks. They get identical transactions in LiteSVM and must end in identical account state. The table
shows mean compute units per call (generated by `scripts/readme-bench.ts` from the benchmark run). The programs,
scenarios and harness are in [typesol-lang/benchmarks](https://github.com/typesol-lang/benchmarks), which pins the compiler and
toolchain and records them with every result:

<!-- bench:table -->
| Instruction | TypeSOL | Pinocchio 0.10 | Native Rust | Anchor 1.0.2 |
| --- | ---: | ---: | ---: | ---: |
| counter.initialize | **1,856** | 3,186 | 4,601 | 6,573 |
| counter.increment | **110** | 113 | 857 | 2,323 |
| vault.open | **1,875** | 3,185 | 4,613 | 6,627 |
| vault.deposit | **1,314** | 1,377 | 2,832 | 4,355 |
| vault.withdraw | **315** | 370 | 1,176 | 3,628 |
| vault.shut | **161** | 167 | 950 | 2,024 |
| escrow.make | **3,595** | 6,179 | 9,240 | 13,304 |
| escrow.take | **4,019** | 4,051 | 8,500 | 14,365 |
| escrow.refund | **2,696** | 2,769 | 5,695 | 8,449 |
| binary, counter / vault / escrow | 11.1 / 14.1 / 21.5 KB | 19.6 / 22.9 / 29.4 KB | 27.9 / 35.0 / 46.5 KB | 145.2 / 158.9 / 190.7 KB |
<!-- /bench:table -->

`initialize`, `open` and `make` include the PDA bump search. TypeSOL hashes PDA candidates with the sha256 and
curve-check syscalls instead of the 1,500-CU PDA syscalls the others call, with the same results. The
escrow moves SPL tokens through CPIs (`take` makes three). Like Pinocchio, TypeSOL reads accounts in place and builds
CPI account records only for the accounts a call lists. It uses fewer compute units than Pinocchio on every
instruction here, while also refusing duplicate writable accounts as Anchor does. Fewer compute
units are not a safety claim. The differential tests also run the escrow against its Anchor twin ([docs/testing.md](docs/testing.md)).

These three programs' Pinocchio versions were written for this comparison.

<!-- bench:official -->
On the official examples, 17 programs of solana-developers/program-examples@de09019 that this project did not write (26 instructions, `official.ts` in the benchmarks repository), TypeSOL uses fewer compute units than Anchor on 26 of 26 instructions and than native Rust on 26 of 26, and more than Pinocchio on 13 of 26.
<!-- /bench:official -->

Those Pinocchio versions often do less: favorites, close-account and
program-derived-addresses take the PDA bump from the client instead of searching for it on chain, and pda-rent-payer
checks the client's bump instead of finding the canonical one; program-derived-addresses' increment checks neither the
address nor the owner of the account it writes; transfer-sol checks neither that the recipient is a System account nor
that the paying account of `transfer_sol_with_program` belongs to the program. The notes for each program, and every
figure, are in the benchmarks' `results.json` (`official`).

### On mainnet

The official escrow ([tokens/escrow](https://github.com/solana-developers/program-examples/tree/de090195e4de698e150572c4f886c333323a64a5/tokens/escrow)),
deployed to Solana mainnet-beta in all four versions and called with the same mints, amounts and accounts, one
instruction per transaction. The TypeSOL program was upgraded in place to 0.25.0 on 2026-10-29; the others are as first
deployed on 2026-10-27. Each figure is the compute units of that transaction, linked to Solscan; the lowest per row is
in bold. The TypeSOL program was checked against its source with `typesol verify` (it is the 0.25.0 build, not the
current release) and its IDL is published on chain with `typesol idl publish`; the Pinocchio, native Rust and Anchor
programs are the benchmarks' builds, and this record does not check them byte for byte against those builds.

These four programs are a benchmark record, not a service: the maintainers' own keys made every offer and took or
refunded each one in the runs recorded, so no offer is open and they hold no one's tokens. The TypeSOL one predates
the defects fixed in 0.44.0 and 0.44.1 (see [Status](#status)); its source,
[`showcase/program-examples/tokens/escrow.ts`](showcase/program-examples/tokens/escrow.ts) (the same at 0.25.0, then
`test/ports/tokens/escrow.ts`), uses none of the constructs those defects need: no helper functions, closures,
`Dup<…>` or loaded accounts, seed lists written in place at each call, token wrapper arguments that are plain reads,
and no `transferFee` or `updateExtraAccountMetas`.

| Transaction | TypeSOL | Pinocchio | Native Rust | Anchor |
| --- | ---: | ---: | ---: | ---: |
| make_offer (offer 1) | [29,205](https://solscan.io/tx/4AaenpnDGYmT2JXAm8HuN5D9GkEWLYeqyMNxJq6D9aYk6ssunSwNTigFmZoCJtY7MZ3FFBXLsig8jo1YmjUFVTpX) | [**21,145**](https://solscan.io/tx/3tWjcMQxTja6QjEmAvi1MRF9qCsnPBsAmQNPnd5RcNTwnkkJYmk9JFFnZoJbTAc6MEr2QYQd7KtgPGtaNr3inrCG) | [45,698](https://solscan.io/tx/4AgQzePrXL4f4qYrFQBzE65d8cszpmqSiQVt9yVsAotbrYTnartXuM2g2PFg7VhUGaZpbhfH9jzXgwXdRLXwB7tk) | [38,648](https://solscan.io/tx/4Hm62foYd5hoNqmEfLk51HhVVb5VHa5oTr81rjAKNNXyKFYwSrpXZhzFVwbk3WxRzEsiqGxHbn7B4eBop6RC1Sgx) |
| take_offer (offer 1) | [**9,951**](https://solscan.io/tx/52ej6M3zFt5kgMGKUef9VGZdmZWqJdSoHCvCEB9P3btg7DSbvHkM24uk95W7HXjSX12XHmEmXATC7GLcQQ1U22kK) | [26,706](https://solscan.io/tx/4KLfVqTM2KmwgqF4xECWmNuZWYufsWcocdT5saamWdZQfRYhY7aTsyEyk5pVTxug6LJnngJhWDU7NMiPnZxu9sH2) | [31,628](https://solscan.io/tx/5f2VxEcPUfZbCVHpbYbUntVwfUN4k6ieetxSjdpJVwfck2tDuv2QTGbFFtNcy34Nn8d6bKSp5efzKDSbg7xj5TbJ) | [32,835](https://solscan.io/tx/3sJVTUvGRRtvYisFyqthvYQUZpeLmNN2UtXJq9TsQHW2TLP8YwtiuFGoPvu51w5YoZyJjKc3dM3zF6JXTFRFjc6H) |
| make_offer (offer 2) | [20,205](https://solscan.io/tx/36mSJoMESxSLoxL5apVkoPzptAgFmUM9z2ZVuKpCadQajxbTF3T6BT93bw2ugHfLX7qSXvcBQ96kd8m22y3DsbTH) | [**19,645**](https://solscan.io/tx/PXPGNGCN3RN15L812K9Ho99Xz5YmUgMDaDy8aXuSg1kFgtdX42Z6foLLJkn8X9XB68xgeQsTBQhoDdUfRPKks2f) | [29,198](https://solscan.io/tx/2n38Urd1FsijNB2kbQy1b2cNHrvU7sXwYe5zH9SeyZUJRhUaD8TXSJGkvjEGYCTy3bdmAvEqqE27Ufgcxg3S3uFe) | [38,648](https://solscan.io/tx/185ZpYg3H1Ku4upHPBoBavrTczwzwxQiz7wjqqYWXd8MmxbimbLz7VvjuQdnqAGaAMy11G8M1QqPzXbrPof8gQb) |
| refund_offer (offer 2) | [**5,478**](https://solscan.io/tx/55Q7pTfsew4F4N9DPB21BEqeHPANhkgQmUGAYVerFP73D7qMTp4eeo5CPMpYQqU7SLS4e49fuKtLkZ9XowbyoKET) | [13,387](https://solscan.io/tx/2cNkvA4xuFJBQzFcFTnLrxRzDU1q5617T8TCF5sBS7JeNzCPUxCPfzS37uv1RUg7xs9Mqyya6KDV9GSZxGiToevT) | [17,731](https://solscan.io/tx/Nj8RGLqEgbj8SEhd9hLcB2JQJY7YwkP1CnMdeJFBdsFhftntFqm1j1wAD1Mc715wrkPv2pFCWu93AF29oHQUDYr) | [20,576](https://solscan.io/tx/5on9Fxe6mADcbWwVn43yQ5wYtdWyx2u3Ry2hSniLJjRqoj2J55Hbgv4AbZoVZ5CDp2VrrghEkKRBvmXxjv1TynmY) |
| escrow program's own part, 4 transactions | **28,118** | 36,956 | 93,273 | 102,926 |
| program | [65ybkcg6…](https://solscan.io/account/65ybkcg6mQa9t5EuHtirRdvf2qAu12qRiK6wYBbGk16P) | [FrQwq3iU…](https://solscan.io/account/FrQwq3iUa8ZkWEne1y27webXTAyLgH4Hj6t986t6VS2G) | [5pnmi1Md…](https://solscan.io/account/5pnmi1MdxzXKmgX7ooRSE212rzZK8rb7nNpRTSMqP8V1) | [EG7M3sLL…](https://solscan.io/account/EG7M3sLLwB7MhmtzwYsaxbhZaFDbshL9hmVK79bQVyVq) |

In make_offer the Associated Token Account program creates the vault: 13,480 to 22,480 CU of the make_offers above
(13,585 to 22,585 with the token transfer after it). That is most of the TypeSOL and Pinocchio make_offers (67–77%)
and about a third to a half of the native Rust and Anchor ones (35–46%), whose own part is larger (15,543 to 29,043
CU). The ATA program searches for the vault address's bump itself at 1,500 CU a try, and every offer has its own
vault, so that part depends on the offer (13,510 CU for both of Anchor's, 13,480 and 22,480 for TypeSOL's); programs
that check the vault's address re-derive it, so take_offer and refund_offer can vary with it too. The escrow
program's own part is steadier: TypeSOL's make_offer spent 6,620 CU of its own on both offers. The Pinocchio version takes the offer PDA's bump from the client instead of
searching for it. Mainnet figures differ from the LiteSVM means above. Every run, including the one before the
upgrade, is in [typesol-lang/benchmarks](https://github.com/typesol-lang/benchmarks) (`results/`).

## How it is tested

- **Execution tests.** Programs that use each language feature are compiled and run in LiteSVM (`test/language/`,
  `test/examples/`, `test/integrations/`, `test/security/`), and every complete example of the language guide must
  compile (`test/language/docs-examples.test.ts`).
- **Diagnostics tests.** Refused constructs are tested with the message they get (`test/language/diagnostics.test.ts`,
  and every row of the guide's "What is refused" table).
- **Golden tests.** The generated C of the counter and the generated clients of two programs are compared with golden
  output (`test/golden/`), and CI rebuilds 14 programs on Linux x86_64 to the bytes the reference container gives
  (`test/golden/binaries.json`).
- **Randomized tests** against independent oracles:
  - Arithmetic at every integer width is checked against BigInt.
  - Stateful vault, escrow and ledger runs are checked against a TypeScript model.
  - Differential runs send the same transactions to TypeSOL and to the Anchor twins and compare outcomes, account
    contents and balances.
- **Ports against mainnet binaries.** The nine ports above run beside the deployed originals, transaction by
  transaction, and random walks over eight of them (all but multisig), and over Meteora DBC, compare every step.
- **Localnet smoke test.** A script deploys every example to a local validator and drives it end to end; it is run
  by hand, not in CI.

Details are in [docs/testing.md](docs/testing.md).

## Examples

| | |
| --- | --- |
| [`counter.ts`](examples/counter.ts) | PDA init, authority check |
| [`vault.ts`](examples/vault.ts) | System CPI, direct lamport moves, rent floor, close |
| [`escrow.ts`](examples/escrow.ts) | SPL Token CPIs signed by a PDA, atomic swap, refund |
| [`minter.ts`](examples/minter.ts) | capped issuer over SPL Token and Token-2022, set up by the mint's authority |
| [`ledgerbook.ts`](examples/ledgerbook.ts) | enums, Options, a Vec that grows and shrinks its account |
| [`airdrop.ts`](examples/airdrop.ts) | remaining accounts, batch payouts, `loadAccountMut` |
| [`relay.ts`](examples/relay.ts), [`caller.ts`](examples/caller.ts) | generic `invoke`, PDA-signed transfers, return data |
| [`profiles.ts`](examples/profiles.ts) | nested structs, FixedString, events |
| [`orderbook/`](examples/orderbook) | a three-file, 28 KiB zero-copy limit order book |

### Showcase: ports checked against mainnet

[`showcase/`](showcase) holds Anchor and native programs ported and checked against the binaries deployed on mainnet
(same outcomes, account bytes and events; [`showcase/test`](showcase/test)), and the ports of all 46
[solana-developers/program-examples](showcase/program-examples/README.md).
Case studies: [Marginfi v2](docs/case-study-marginfi.md), [Phoenix v1](docs/case-study-phoenix.md), [SPL Stake Pool](docs/case-study-spl-stake-pool.md), [Raydium AMM v4](docs/case-study-raydium-amm.md), [Raydium CLMM](docs/case-study-raydium-clmm.md),
[Raydium CP-Swap](docs/case-study-raydium-cp-swap.md), [Jito MEV](docs/case-study-jito-mev.md),
[coral-xyz/multisig](docs/case-study-multisig.md), [an Anchor escrow](docs/case-study-escrow.md).

| | |
| --- | --- |
| [`raydium-cp-swap/`](showcase/mainnet/raydium-cp-swap) | Raydium CP-Swap in full, all 21 instructions: constant-product swaps, LP deposits and withdrawals, Token-2022 transfer fees, a price oracle, creator fees and their shares, permissioned pools, supported mints |
| [`raydium-clmm/`](showcase/mainnet/raydium-clmm) | Raydium CLMM in full: concentrated-liquidity positions as NFTs, swaps and multi-hop routes across tick arrays, limit orders, rewards, dynamic fees, u256 math |
| [`jito-mev/`](showcase/mainnet/jito-mev) | Jito's tip payment, tip distribution and priority fee distribution: tips paid out per leader, Merkle-proof claims, epochs and expiry |
| [`marginfi/`](showcase/mainnet/marginfi) | Marginfi v2 in full, all 124 instructions: I80F48 fixed-point arithmetic, zero-copy accounts, oracles (Pyth, Switchboard, staked SOL, Scope, venue exchange rates), the risk engine, liquidation and bankruptcy, flash loans, orders, rebalances, and the Solend, Kamino, Drift and JupLend banks |
| [`phoenix/`](showcase/mainnet/phoenix) | Phoenix v1, Ellipsis Labs' on-chain limit order book and a native program, in full, all 28 instructions: price-time matching over lib-sokoban red-black trees in one market account, every order type, self-trade behaviours, time in force, eviction, cancels, seats and fees, its events as Log self-CPIs byte for byte |
| [`spl-stake-pool/`](showcase/mainnet/spl-stake-pool) | SPL Stake Pool in full, all 27 instructions, a native program and the one behind most liquid staking tokens: pools of stake across up to 20,000 validators, SOL and stake deposits and withdrawals, rebalancing over epochs, fees and authorities, token metadata |
| [`raydium-amm/`](showcase/mainnet/raydium-amm) | Raydium AMM v4, the original constant-product AMM and a native (non-Anchor) program, in full: pool creation, deposits and withdrawals, the v1 and v2 swaps, P&L and administration, down to its log records and panics |
| [`meteora-dbc/`](showcase/mainnet/meteora-dbc) | Meteora Dynamic Bonding Curve 0.2.2 in full, all 35 instructions: configs, pool creation on SPL Token and Token-2022 (transfer fees and hooks), the three swap modes, fee schedulers and the rate limiter, fee claims, the locker, and the migrations into DAMM v1 and DAMM v2. Under Meteora's Non-commercial Licence (its own `LICENSE.md`); log text and compute units are not compared |
| [`percolator/`](showcase/mainnet/percolator) | Percolator v12.20, Anatoly Yakovenko's perpetuals risk engine and its native program, in full, all 27 instructions, against the immutable mainnet build: one 1.5 MB slab of 4,096 accounts, U256 and U512 arithmetic, trades through matcher programs, funding, liquidation, the keeper crank with pro-rata loss socialisation and side resets, resolution and teardown. The author's own suite gives the same outcome on every test under both binaries (660 passed). Upstream is educational and not audited |
| [`multisig.ts`](showcase/mainnet/multisig/multisig.ts) | coral-xyz/multisig: stored instructions run with `invokeInstruction`, a PDA signing, Anchor's Borsh accounts |

## Status

**TypeSOL is pre-1.0.** Releases follow the organization's
[versioning policy](https://github.com/typesol-lang/.github/blob/main/VERSIONING.md); [CHANGELOG.md](CHANGELOG.md) lists every
change.
- The compiler, runtime and tooling have been through internal security reviews and are covered by the tests above.
  The two latest, of 0.43.0 and 0.44.0 in November 2026, found defects that made a program that compiled behave
  differently from its source; each is fixed with a test, and [docs/audit.md](docs/audit.md) lists them, what the
  reviews covered and what they did not. Programs built before 0.44.1 should be rebuilt.
- 0.45.0 to 0.49.0 have had no security review. They add, among others,
  `runtime/typesol_builtins.c` (the compiler builtins as TypeSOL's own C, 0.45.0), `transferCheckedWithHook`,
  `EVENT_AUTHORITY_CHECK` and the reads of processed sibling instructions (0.48.0), and `zeroData`, `log64`,
  `PANIC_STYLE = "solana-1.18"`, `executable` on remaining accounts and lamport writes on remaining accounts under
  `NATIVE_ACCOUNT_WRITES` (0.49.0).
- From 0.44.0 on, a release that only fixes defects is a patch with no new language surface and a binary diff in its
  notes ([SECURITY.md](SECURITY.md#fix-releases)), and the npm tarball is the one packed from the tag and recorded
  in [releases/](releases).
- They have **not been audited by an independent firm**. Do not put significant value behind programs built with
  TypeSOL until such an audit is published.
- Audit your own programs as you would any Solana program. What a compiled program can rely on, and what is left to
  you, is in [docs/security-model.md](docs/security-model.md); [docs/audit.md](docs/audit.md) is the package for an
  external audit.
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

Not supported yet: see the end of [docs/language.md](docs/language.md#not-supported-yet). What 1.0 will promise, what is
stable already and what is still experimental: [docs/stability.md](docs/stability.md).

## Requirements

- Node.js 22.12 or later (the CLI stops with the version it needs on an older one).
- The Agave CLI with platform-tools (see [Quick start](#quick-start)).
- macOS or Linux x86_64 for everything; Linux arm64 to build and test, set up as below (deploying from it needs the
  Solana CLI built from source); on Windows, WSL2.
- Linux arm64: Anza publishes no Agave CLI for it (the installer fails with a 404), but platform-tools has a
  `linux-aarch64` package. With it and the SDK's C files from the x86_64 release (headers and linker script, as the
  `--docker` image takes them), `typesol build` and LiteSVM tests work (needs `curl` and `bzip2`):

  ```sh
  mkdir -p "$HOME/.local/share/typesol-sdk/sbf/dependencies/platform-tools"
  # About 215 MB, for the C headers and linker script of the SDK only:
  curl -sSfL https://github.com/anza-xyz/agave/releases/download/v3.1.10/solana-release-x86_64-unknown-linux-gnu.tar.bz2 | tar -xj -C "$HOME/.local/share/typesol-sdk" --strip-components=3 solana-release/bin/platform-tools-sdk/sbf/c
  # About 515 MB, 1.6 GB unpacked, and quiet for a minute or two:
  curl -sSfL https://github.com/anza-xyz/platform-tools/releases/download/v1.52/platform-tools-linux-aarch64.tar.bz2 | tar -xj -C "$HOME/.local/share/typesol-sdk/sbf/dependencies/platform-tools"
  touch "$HOME/.local/share/typesol-sdk/sbf/dependencies/platform-tools-v1.52.md"
  # Add this line to ~/.profile too, for new shells:
  export TYPESOL_SBF_SDK="$HOME/.local/share/typesol-sdk/sbf"
  ```

  `typesol doctor` prints these commands there. Deploying needs the Solana CLI: deploy from macOS or Linux x86_64,
  or build the Agave CLI from source. `build --docker` (linux/amd64, emulated) works on any host with Docker.

TypeSOL finds the SDK under `~/.local/share/solana/install/active_release` or next to `cargo-build-sbf` on `PATH`. Set
`TYPESOL_SBF_SDK` to override the location. See [docs/troubleshooting.md](docs/troubleshooting.md).

## Contributing

Start with [docs/architecture.md](docs/architecture.md), which covers how the compiler is laid out and how to add a
built-in, a constraint or an error code. Then read [CONTRIBUTING.md](CONTRIBUTING.md). Releases are listed in
[CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE), except the Meteora Dynamic Bonding Curve port: `showcase/mainnet/meteora-dbc/`, its tests
`showcase/test/meteora-dbc*.ts` and their fixtures `showcase/test/fixtures/meteora-dbc/` are subject to the Meteora
Non-commercial Licence ([its text](showcase/mainnet/meteora-dbc/LICENSE.md), [NOTICE](NOTICE)), and none of them is in
the npm package. The runtime and `typesol/testing` include code ported from MIT and Apache-2.0 projects, and the tests
use third-party program binaries and data that are not in the npm package: see [NOTICE](NOTICE) and
[test/programs/SOURCES.md](test/programs/SOURCES.md).
