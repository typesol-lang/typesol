# Troubleshooting

Grouped by when they happen; within each group, the problems a first run meets come first.

## Install

### `TypeSOL needs Node.js 22.12 or later`

The CLI checks the Node.js version before anything else. On an older one, `npm install` can fail inside npm and the
tests with `Map.groupBy is not a function`; install a current Node.js (https://nodejs.org, or `nvm install 22`).

### `npm error 404 … typesol - Not found`

`npx --no-install typesol` ran outside a project, or before `npm install` in it: `typesol` is the name projects install
the package under, not a package on npm. Run `npx @typesol/cli …` there, or `npm install` in the project first.

### "the Agave CLI is not installed" (formerly "Solana SBF SDK not found")

Install it and its platform-tools as in the README's [Quick start](../README.md#quick-start):

```sh
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"   # the installer edits ~/.profile only
cargo-build-sbf --install-only --force-tools-install --tools-version v1.52   # about 0.5 GB, quiet for a minute or two
```

TypeSOL looks in `~/.local/share/solana/install/active_release/bin/platform-tools-sdk/sbf` and next to
`cargo-build-sbf` on PATH; set `TYPESOL_SBF_SDK` to a `platform-tools-sdk/sbf` directory otherwise. On Linux arm64 see
[Linux arm64: the Agave installer fails with a 404](#linux-arm64-the-agave-installer-fails-with-a-404).

### `cargo-build-sbf: command not found` right after installing

The Agave installer adds its `bin` directory to `PATH` in `~/.profile`, which only new login shells read. In the same
shell, run `export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"`.

### "the Agave CLI is installed, but not its platform-tools" (formerly "platform-tools missing") / "no SBPF v2 libraries"

`cargo-build-sbf --install-only --force-tools-install --tools-version v1.52`. Neither `cargo-build-sbf --version` (it
downloads nothing) nor `cargo-build-sbf --force-tools-install` alone (it needs Cargo and a Cargo project) installs them.

### Linux arm64: the Agave installer fails with a 404

Anza publishes no Agave CLI for Linux arm64 (`agave-install-init-aarch64-unknown-linux-gnu` is not there), but
platform-tools has a `linux-aarch64` package. With it and the SDK's C files from the x86_64 release (headers and
linker script, as the `--docker` image takes them), `typesol build` and LiteSVM tests work; `typesol doctor` prints
these commands there (they need `curl` and `bzip2`):

```sh
mkdir -p $HOME/.local/share/typesol-sdk/sbf/dependencies/platform-tools
curl -sSfL https://github.com/anza-xyz/agave/releases/download/v3.1.10/solana-release-x86_64-unknown-linux-gnu.tar.bz2 | tar -xj -C $HOME/.local/share/typesol-sdk --strip-components=3 solana-release/bin/platform-tools-sdk/sbf/c
curl -sSfL https://github.com/anza-xyz/platform-tools/releases/download/v1.52/platform-tools-linux-aarch64.tar.bz2 | tar -xj -C $HOME/.local/share/typesol-sdk/sbf/dependencies/platform-tools
touch $HOME/.local/share/typesol-sdk/sbf/dependencies/platform-tools-v1.52.md
export TYPESOL_SBF_SDK=$HOME/.local/share/typesol-sdk/sbf   # add this line to ~/.profile too
```

Deploying needs the Solana CLI: deploy from macOS or Linux x86_64, or build the Agave CLI from source
(https://docs.anza.xyz/cli/install). `build --docker` (linux/amd64, emulated) works on any host with Docker.

### Windows

Not tested; use WSL2 with the Linux Agave CLI.

### Node errors such as `ERR_UNKNOWN_FILE_EXTENSION` or `ERR_REQUIRE_ESM`

Use Node.js 22.12 or newer.

### "warning: this build uses clang … TypeSOL is tested with clang 20.1.7-rust-dev …"

The active platform-tools are not the ones the release is tested with (platform-tools v1.52, from Agave 3.1.10). The
build goes on, but the C TypeSOL generates is only checked against that clang: another one can compile it to other
bytes, and what the C relies on includes backend details (how the SBF backend passes struct arguments was behind a
defect fixed after 0.43.0). Install the tested ones with `cargo-build-sbf --install-only --force-tools-install
--tools-version v1.52`; `typesol doctor` shows which are active. In CI, `--toolchain-strict` (or
`TYPESOL_TOOLCHAIN=strict`) turns the warning into an error.

## Writing and running a program

### A build error you don't recognize

The compiler adds a `hint:` line under TypeScript's message where TypeScript's own advice points the wrong way for a
program (and for a global a program does not have, such as `console` or `process`, says so in place of TypeScript's
advice to add a library). The usual ones: integers are `bigint` (`1n`, `u64` parameters, not `number`); `require`,
`log`, `min`, `max`, `fixedArray`, the types (`Signer`, `Mut`, …) and the integer casts are imported from `"typesol"` (a
cast such as `u64(x)` without `type`: `import { u64 }`); arrays are read with `.get(i)` and written with `.set(i, v)`;
an account you change is a `Mut<T>` parameter; the time is `now()`, not `Date.now()`; there is no `async`, `try`,
`throw` or `class`. The full list of what the subset covers is in [language.md](language.md).

### A transaction fails with a custom error

See [errors.md](errors.md). Failures raised by the compiler's checks log their TypeScript location, e.g. `TypeSOL:
arithmetic overflow (vault.ts:42)`.

### "exceeded CUs meter" / "Computational budget exceeded"

The transaction ran out of compute units: by default each instruction gets 200,000, and the logs end with `Program
<id> consumed 200000 of 200000 compute units` and `… failed: exceeded CUs meter at BPF instruction …`. Ask for more,
up to 1,400,000 per transaction, with a ComputeBudget `SetComputeUnitLimit` instruction placed before the others
(`getSetComputeUnitLimitInstruction({ units })` from `@solana-program/compute-budget`, or the bytes `[2, units as a
u32 little-endian]` to `ComputeBudget111111111111111111111111111111`). The generated client's `sendInstructions` and
the testing library's `t.send(payer, ...ixs)` send the instructions they are given, so pass it first:
`t.send(alice, setLimit, t.ix(…))`. To spend less, find the costly lines with `typesol build --profile` and `typesol
profile` ([limits and costs](language-basics.md#limits-and-costs)).

### `Transaction size … exceeds limit of 1232 bytes` / "transaction too large"

A transaction is at most 1,232 bytes, signatures, account addresses and instruction data included. Kit refuses to send
a larger one (the first message), and an RPC node refuses it too. Split the work into several transactions, pass
fewer accounts, or send large data in chunks into an account the program reads; with many accounts, a version 0
transaction with an address lookup table costs one byte per account instead of 32 (kit's
`compressTransactionMessageUsingAddressLookupTables`) ([limits and costs](language-basics.md#limits-and-costs)).

### Heap errors (5110) building strings

Strings are allocated on a 32 KiB heap and never freed. Build less text, or declare `const HEAP_SIZE_KIB = 64n` and add
a ComputeBudget `requestHeapFrame` instruction to the transaction.

### "instruction X (with the helpers inlined into it) needs N bytes of stack; SBPF v0 gives each function 4096"

Under SBPF v0 (the default) every function gets a fixed 4 KiB stack frame, and going past it corrupts memory, so the
build refuses it. SBPF v1 and v2 (`--sbpf v1` / `v2`) grow frames dynamically, so this limit does not apply there. Large
structs and arrays copied into typed locals (`const q: Big = acct.big`) are the usual cause: bind them without a type
(`const q = acct.big`, a reference into the account data). The message lists the biggest locals (clang's frame layout: a
local's name and the source line near it; the locals of an inlined helper show as unnamed, with the helpers' locals that
may be them). Helpers are often inlined into their instruction, so their locals count toward its frame: mark one `/**
@noinline */` to give it a 4 KiB frame of its own (a few compute units per call), or declare a large local list or
struct of an instruction `/** @heap */` to keep it on the heap (about 18 CU for the allocation).

### "… is missing, but typesol.json records …"

The program keypair under `target/deploy/` was deleted or replaced. Restore it from your backup. Without it you cannot
upgrade the deployed program; removing `"address"` from `typesol.json` gives the program a new address.

## Deploy

### `no payer keypair at ~/.config/solana/id.json` (deploy)

`solana-keygen new` creates it (or pass `--keypair <file>`); fund it on devnet with `solana airdrop 2 --url devnet`.
Nothing is sent before it exists.

### "`solana` was not found on PATH" (deploy)

Install the Agave CLI, or use `typesol deploy --dry-run` and run the printed commands yourself.

### `typesol idl publish` fails on a local validator with "invalid instruction data"

The System Program of `solana-test-validator` (Agave 3.1 included) rejects a System instruction that the current Program
Metadata program uses. The error shows the failing transaction's last log lines. No option fixes it locally: the System
Program is part of the validator. Publish where the Program Metadata program is deployed, mainnet-beta or devnet
(`npx --no-install typesol idl publish --url devnet`; [publish the IDL](mainnet.md#5-publish-the-idl)); against a local
validator, clients read the IDL file the build writes (`target/<name>/<name>.json`, [client.md](client.md)).

## Verify and `--docker`

### `typesol verify` says MISMATCH

First make sure the same sources (imports included), TypeSOL version and SBPF version are used. Then the toolchain:
verify prints the rebuild's clang and platform-tools, and the deployed build's when a `<name>.build.json` describes the
deployed bytes (`--manifest <file>`, one next to a given `.so`, or the local build's). A program on chain carries no
such record, so keep the build manifest of every deployment.

### `--docker needs Docker: docker is not installed` / `the Docker daemon is not running`

`build --docker` and `verify --docker` run in a container: install Docker, or start Docker Desktop (or `sudo systemctl
start docker`). `typesol doctor` has a `docker` row. Nothing is built without it; drop `--docker` to build with your own
platform-tools.

### `docker build of typesol-build:… failed`

The first `--docker` build makes the image, which needs the network: the base images from Docker Hub, the Agave and
platform-tools release files from GitHub, the TypeSOL tarball from npm. A `checksum` error means a downloaded file is
not the one the Dockerfile pins (retry; if it persists, report it). `typesol tarball check: integrity …` means the
tarball npm served is not the one `releases/<version>.json` records: do not use that version until it is explained.
`typesol dependency lock: …` means the lock does not describe the package's dependencies or names a package without a
registry integrity; an `EINTEGRITY` error from `npm ci` means a downloaded dependency is not the one the lock records:
the same.

### `the local image typesol-build:… was not built from this release record and dependency lock`

An image of that tag exists, made from a record or lock with other values (it names them). Two records of one version
disagree, so find out which is right before going on; to build from the one given now, `docker image rm` the tag and run
again.

### `no dependency lock for TypeSOL <version>`

Neither this package nor that version's tarball has `docker/deps/<version>.lock.json`: use a later `@typesol/cli`, which
ships the locks of the versions before it. On arm64 machines the image is linux/amd64 and runs emulated: Docker Desktop
provides the x86_64 emulation (QEMU or Rosetta); other Docker installs may need `binfmt` for amd64.

### `no release record for TypeSOL <version>` / `could not fetch the release record`

The container installs only versions whose tarball has a record: the package's own, or `releases/<version>.json` on the
repository's main branch, which `--docker` fetches for a release newer than the package. Offline (or behind a proxy that
blocks raw.githubusercontent.com), pass the record yourself with `--release-record releases/<version>.json` from a
checkout, or choose a version the package records with `--typesol-version`. HTTP 404 means the repository has no record
for that version: check that it is a released version. 0.42.0 and earlier have no record.

### `this project installs typesol X …, but this is typesol Y`

A `typesol` other than the project's ran `--docker`. Run the project's own (`npx --no-install typesol …`), or say which
version to use with `--typesol-version`.

### `the container build failed … the container sees only <dir>`

The compiler's error is printed above it. The container mounts only the project root (or a single file's directory): an
import from outside it is missing there.

### `verify` says `differs   host`

The same TypeSOL (0.44.1 or earlier) and toolchain built the two sides on different hosts. That may be the cause if the
program has 128-bit or signed division: those versions linked platform-tools' compiler-builtins, which each host package
lays out differently. Rebuild on the deployed side's kind of host (or with `--docker`, if the deployed build was one).
From 0.45.0 on the host is not a difference between macOS arm64, Linux arm64 and Linux x86_64 (the hosts measured);
`differs   host (not measured)` means one side was built on another host.

### A 0.44.x program with division, deployed from macOS or Linux arm64, does not match `verify --docker`

0.44.0 and 0.44.1 linked platform-tools' compiler-builtins, so a program that calls 128-bit or signed division built to
other bytes on each host package; the container is linux/amd64 and gives the Linux x86_64 bytes. What verifies it is a
0.44.x install (the version in its `.build.json`) on the same kind of host as the one that built it, without `--docker`:
`npx @typesol/cli@0.44.1 verify …` on macOS arm64 for a build made there.
