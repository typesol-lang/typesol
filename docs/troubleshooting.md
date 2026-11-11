# Troubleshooting

**"Solana SBF SDK not found"** — install the Agave CLI (https://docs.anza.xyz/cli/install) and run
`cargo-build-sbf --version` once. TypeSOL looks in `~/.local/share/solana/install/active_release/bin/platform-tools-sdk/sbf`
and next to `cargo-build-sbf` on PATH; set `TYPESOL_SBF_SDK` to a `platform-tools-sdk/sbf` directory otherwise.

**"platform-tools missing" / "no SBPF v2 libraries"** — `cargo-build-sbf --force-tools-install`.

**"warning: this build uses clang … TypeSOL is tested with clang 20.1.7-rust-dev …"** — the active platform-tools are
not the ones the release is tested with (platform-tools v1.52, from Agave 3.1.10). The build goes on, but the C TypeSOL
generates is only checked against that clang: another one can compile it to other bytes, and what the C relies on
includes backend details (how the SBF backend passes struct arguments was behind a defect fixed after 0.43.0). Install the tested ones with
`cargo-build-sbf --install-only --force-tools-install --tools-version v1.52`; `typesol doctor` shows which are active.
In CI, `--toolchain-strict` (or `TYPESOL_TOOLCHAIN=strict`) turns the warning into an error.

**`typesol verify` says MISMATCH** — first make sure the same sources (imports included), TypeSOL version and SBPF
version are used. Then the toolchain: verify prints the rebuild's clang and platform-tools, and the deployed build's
when a `<name>.build.json` describes the deployed bytes (`--manifest <file>`, one next to a given `.so`, or the local
build's). A program on chain carries no such record, so keep the build manifest of every deployment.

**`--docker needs Docker: docker is not installed` / `the Docker daemon is not running`** — `build --docker` and
`verify --docker` run in a container: install Docker, or start Docker Desktop (or `sudo systemctl start docker`).
`typesol doctor` has a `docker` row. Nothing is built without it; drop `--docker` to build with your own platform-tools.

**`docker build of typesol-build:… failed`** — the first `--docker` build makes the image, which needs the network:
the base images from Docker Hub, the Agave and platform-tools release files from GitHub, the TypeSOL tarball from npm.
A `checksum` error means a downloaded file is not the one the Dockerfile pins (retry; if it persists, report it).
`typesol tarball check: integrity …` means the tarball npm served is not the one `releases/<version>.json` records:
do not use that version until it is explained. On arm64 machines the image is linux/amd64 and runs emulated: Docker
Desktop provides the x86_64 emulation (QEMU or Rosetta); other Docker installs may need `binfmt` for amd64.

**`no release record for TypeSOL <version>`** — the container installs only versions whose tarball record ships with
the package. Pass the record from the repository with `--release-record releases/<version>.json`, use a later
`@typesol/cli`, or choose a recorded version with `--typesol-version`. 0.42.0 and earlier have no record.

**`this project installs typesol X …, but this is typesol Y`** — a `typesol` other than the project's ran `--docker`.
Run the project's own (`npx --no-install typesol …`), or say which version to use with `--typesol-version`.

**`the container build failed … the container sees only <dir>`** — the compiler's error is printed above it. The
container mounts only the project root (or a single file's directory): an import from outside it is missing there.

**`verify` says `differs   host`** — the same TypeSOL and toolchain built the two sides on different hosts, and the
program links compiler-builtins code that differs between platform-tools host packages (128-bit or signed division).
Rebuild on the deployed side's kind of host, or, for programs others should verify, deploy a `--docker` build.

**Windows** — not tested; use WSL2 with the Linux Agave CLI.

**Node errors such as `ERR_UNKNOWN_FILE_EXTENSION` or `ERR_REQUIRE_ESM`** — use Node.js 22.12 or newer.

**"`solana` was not found on PATH"** (deploy) — install the Agave CLI, or use `typesol deploy --dry-run` and run the
printed commands yourself.

**"… is missing, but typesol.json records …"** — the program keypair under `target/deploy/` was deleted or replaced.
Restore it from your backup. Without it you cannot upgrade the deployed program; removing `"address"` from
`typesol.json` gives the program a new address.

**A build error you don't recognize** — the compiler adds a `hint:` line under TypeScript's message where TypeScript's
own advice points the wrong way for a program. The usual ones: integers are `bigint` (`1n`, `u64` parameters, not
`number`); `require`, `log`, `min`, `max` and `fixedArray` are imported from `"typesol"`; arrays are read with `.get(i)`
and written with `.set(i, v)`; an account you change is a `Mut<T>` parameter; there is no `async`, `try`, `throw` or
`class`. The full list of what the subset covers is in [language.md](language.md).

**A transaction fails with a custom error** — see [errors.md](errors.md). Failures raised by the
compiler's checks log their TypeScript location, e.g. `TypeSOL: arithmetic overflow (vault.ts:42)`.

**Heap errors (5110) building strings** — strings are allocated on a 32 KiB heap and never freed. Build less text,
or declare `const HEAP_SIZE_KIB = 64n` and add a ComputeBudget `requestHeapFrame` instruction to the transaction.

**`typesol idl publish` fails on a local validator with "invalid instruction data"** — the System Program of
`solana-test-validator` (Agave 3.1 included) rejects a System instruction that the current Program Metadata program
uses. Publishing works on mainnet-beta. The error shows the failing transaction's last log lines.

**"instruction X (with the helpers inlined into it) needs N bytes of stack; SBPF v0 gives each function 4096"** — under
SBPF v0 (the default) every function gets a fixed 4 KiB stack frame, and going past it corrupts memory, so the build
refuses it. SBPF v1 and v2 (`--sbpf v1` / `v2`) grow frames dynamically, so this limit does not apply there. Large structs and arrays copied into typed
locals (`const q: Big = acct.big`) are the usual cause: bind them without a type (`const q = acct.big`, a reference
into the account data). The message lists the biggest locals (clang's frame layout: a local's name and the source
line near it; the locals of an inlined helper show as unnamed, with the helpers' locals that may be them). Helpers are
often inlined into their instruction, so their locals count toward its frame: mark one `/** @noinline */` to give it a
4 KiB frame of its own (a few compute units per call), or declare a large local list or struct of an instruction
`/** @heap */` to keep it on the heap (about 18 CU for the allocation).

