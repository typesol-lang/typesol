# CLI reference

`typesol <command> --help` prints the same text for one command. Options are checked: an unknown option is an
error. Exit codes: **0** success, **1** failure (compile errors, failed deploy, …), **2** usage error,
**3** `verify` mismatch.

| Command | What it does |
| --- | --- |
| `typesol init [<dir>] [--name <program>] [--template counter\|vault\|escrow]` | Create a project: `typesol.json`, `programs/<name>.ts`, `tests/<name>.test.ts` (LiteSVM), `package.json`, `tsconfig.json`, `programs/tsconfig.json` (with the editor plugin), `.vscode/settings.json` (the workspace TypeScript, so the plugin loads), `.gitignore`, the rules for AI coding agents (`AGENTS.md`, `CLAUDE.md` importing it, `.cursor/rules/typesol.mdc`) and the MCP server configuration (`.mcp.json`, `.cursor/mcp.json`; see [ai.md](ai.md)). `<name>` must be snake_case; by default it is derived from `<dir>` (`my-app` → `my_app`). The template picks the program and its test: `counter` (default, a PDA counter per user), `vault` (SOL at a PDA: deposit, withdraw above rent, close) or `escrow` (SPL tokens: make, take, refund, the offer PDA signing for its vault). Refuses to overwrite files. It warns, with the install commands, when the platform-tools that building needs are missing. |
| `typesol new <program> [--template counter\|vault\|escrow]` | In a project: add a program, `programs/<program>.ts` and `tests/<program>.test.ts` from the template, and its entry in `typesol.json`. Refuses to overwrite files or reuse a name. |
| `typesol doctor [--url <rpc>] [--config <cli config>]` | Check what building, testing and deploying need: Node.js, the platform-tools (and a `toolchain` row: the tested ones, or untested with both versions), the Solana CLI, Docker (optional: only `--docker` builds need it; it says when they run emulated), its keypair, the RPC (`--url`, a cluster moniker, or the CLI config) and the keypair's balance there, and the project. Each problem is printed with the command that fixes it. Exit code 1 when building is impossible (Node.js or the platform-tools missing); deploy pieces are warnings. |
| `typesol build [<program>…] [--sbpf v0\|v1\|v2] [--profile] [--toolchain-strict] [--docker [--typesol-version <v>] [--release-record <file>]] [--quiet]` | In a project: build every program (or those named) into `<out>/<name>/`: `<name>.so`, `<name>.json` (Anchor IDL), `<name>.client.ts` (TypeScript client, see [client.md](client.md)), `<name>.c`, `<name>.build.json` (the TypeSOL, TypeScript, clang and platform-tools versions, the host, the SBPF version, each source's sha256 and the binary's). With platform-tools other than the tested ones it warns once; `--toolchain-strict` (or `TYPESOL_TOOLCHAIN=strict`) refuses them. The first build creates `<out>/deploy/<name>-keypair.json` and records the address in `typesol.json`; later builds refuse a different keypair. Without the keypair (a fresh clone, CI) it builds at the recorded address and says so; only `deploy` needs the keypair. `--docker` builds in the pinned container instead ([below](#build---docker-and-verify---docker)). |
| `typesol build <file.ts> [--out <dir>] [--program-id <keypair.json>] [--sbpf …] [--profile] [--toolchain-strict] [--docker …] [--quiet]` | Outside a project (or a file that is not one of its programs): build that file. Its keypair is `--program-id`, which must exist, or `<out>/<name>-keypair.json`, created on the first build. A project program's `.ts` builds as that program. |
| `typesol check [<program>… \| <file.ts>] [--json] [--stdin \| --files]` | Type-check and validate without building. In a project, no argument checks every program (or those named) and exits 1 if any has errors. `--json` prints `{ ok, diagnostics: [{ file, line, column, message }] }`, always (a missing file or unreadable `--files` input is a diagnostic too, exit 1 or 2); `--stdin` checks the text given on stdin as that file (its imports come from disk); `--files` reads `{ "files": { "<absolute path>": "<text>", … } }` from stdin and checks with those texts instead of the disk (an editor's unsaved buffers). |
| `typesol clone [<address>…] [--url <rpc>] [--config <cli config>] [--out <dir>]` | Copy cluster accounts and programs for the tests (Anchor's `[test.validator.clone]`): each account to `<address>.json` (lamports, owner, data), each program to `<address>.so` (its ELF, from the ProgramData account for upgradeable programs), in `tests/accounts` (`"accounts"` in `typesol.json`) or `--out`. Without addresses it clones the project's `"clone"` list. `testProgram` loads that directory into its LiteSVM; commit it so the tests run offline. |
| `typesol emit-c <file.ts> [--out <file.c>] [--profile]` | Print or write the generated C. |
| `typesol mcp` | Serve the Model Context Protocol on stdio for AI coding agents: tools to check a program (errors with hints), read its IDL, search the docs and read the rules a TypeSOL program follows. The `.mcp.json` / `.cursor/mcp.json` that `init` writes start it as `npx --no-install typesol mcp` (the project's own copy); see [ai.md](ai.md). |
| `typesol deploy [<program>…] [--url <rpc>] [--keypair <payer.json>] [--config <cli config>] [--dry-run] [--sbpf …] [--toolchain-strict]` | Build (`--toolchain-strict` as for `build`), then `solana program deploy --use-rpc` at the program keypair's address. Deploying again upgrades (the payer must be the upgrade authority). `--dry-run` builds and prints the commands. It needs a cluster, `--url` or `json_rpc_url` in the Solana CLI config: it never falls back to the CLI's default. Before sending anything it prints the cluster's host and the payer, checks that the RPC answers and that the payer holds enough for the rent (about twice the binary's on a first deploy, while the buffer exists), and says what to do if not (start `solana-test-validator`, `solana airdrop` on devnet or a local validator). Needs `solana` on PATH. |
| `typesol idl publish [<program>…] [--url <rpc>] [--keypair <authority.json>] [--config <cli config>] [--non-canonical]` | Compile (the binary is not rebuilt), then write each IDL to the Program Metadata program (seed `idl`). Canonical IDLs must be signed by the upgrade authority. Defaults come from the Solana CLI config (`~/.config/solana/cli/config.yml`); it prints the cluster's host and the payer before sending. |
| `typesol cpi <idl.json> [--out <file.ts>] [--prefix <name>] [--address <base58>]` | Generate TypeSOL helpers that call another program from its IDL. Unsupported instructions are listed on stderr. |
| `typesol port <idl.json> [--out <file.ts>]` | A TypeSOL program skeleton from an Anchor IDL (0.30+/1.x), to port an Anchor program: account structs, enums, errors, events and one function per instruction with its accounts and arguments, each body `require(false, …NotPorted)` until written. Instruction discriminators (an explicit `@discriminator` when the name derives another), account names and error codes are kept, so existing clients keep working where the layouts match; notes on stderr list where they do not (Borsh `String`/`Option` in account data, a `Vec` that is not the last field). Error codes that skip ahead are kept with `@code`, and zero-copy types keep their IDL `repr`, `serialization` and field names (`@repr`, `@serialization`, `@idlName`). |
| `typesol client <idl.json> [--out <file.ts>] [--address <base58>]`, `typesol client --address <program id> [--url <rpc>] [--config <cli config>] [--out <file.ts>]` | Generate a typed TypeScript client on `@solana/kit` from an Anchor IDL (0.30+/1.x or TypeSOL); the IDL is validated first, and what the client leaves out is printed as notes. Without a file, the IDL is read from the chain: the canonical Program Metadata IDL, else Anchor's IDL account. See [client.md](client.md). |
| `typesol verify <program\|file.ts> [<deployed.so>] [--address <program id>] [--url <rpc>] [--config <cli config>] [--sbpf …] [--manifest <name.build.json>] [--docker …]` | Rebuild and compare with what is deployed. Without a `.so`, reads the program from the cluster (`--url`, cluster monikers such as `mainnet-beta` included, else the Solana CLI config) at `--address` or the address `typesol.json` records, under any loader (v2, upgradeable v3, v4); prints the upgrade authority (or that the program is immutable) and the last deploy slot, and compares the IDL published with `typesol idl publish` (a published IDL that differs is a mismatch). With a `.so` (e.g. `solana program dump`), compares with that file. Trailing zero padding is ignored; the SBPF version is read from the deployed ELF unless `--sbpf` is given. On a mismatch it prints the rebuild's toolchain (clang, platform-tools, host, TypeSOL) and the deployed build's when a build manifest's binary hash is the deployed bytes' (`--manifest`, `<deployed>.build.json` next to a given `.so`, or the local build's), and what differs; otherwise it says the deployed side's toolchain is unknown (a program on chain records none). A host difference alone is named as such; it counts only between builds of 0.44.1 or earlier, whose programs with 128-bit or signed division linked platform-tools' compiler-builtins (laid out differently by each host package). `--docker` rebuilds in the pinned container and, on a match, prints what was verified ([below](#build---docker-and-verify---docker)). |
| `typesol profile <logs.txt\|-> [--program <id>]` | Compute units per TypeScript line from the logs of a `--profile` build's transaction (exit 1 when the logs have no markers). |
| `typesol help <command>` | Same as `typesol <command> --help`. |
| `typesol --version` | Print the version. |

`clone`, `client --address`, `verify` and `idl publish` give up on an RPC request after 30 seconds
(`TYPESOL_RPC_TIMEOUT=<seconds>` changes it) and, like `doctor` and `deploy`, name only the RPC's host and the cause
when one fails (an RPC URL can carry an API key). A `--config` file that does not exist is a usage error everywhere.

Builds (`build`, `deploy`, `verify`, `typesol/testing`) compare the active clang with the one the release is tested
with (`TESTED_TOOLCHAIN` in `typesol/compiler`: Agave 3.1.10, platform-tools v1.52): another one gets one warning per
process on stderr. `TYPESOL_TOOLCHAIN=strict` makes it an error everywhere, `warn` is the default.

## build --docker and verify --docker

`--docker` builds in a container made on your machine from `docker/Dockerfile` (shipped in the package): linux/amd64
on every machine (emulated on arm64), Node 24, the platform-tools v1.52 of Agave 3.1.10, and a TypeSOL version from
npm whose tarball is checked against `releases/<version>.json` (sha512 integrity, sha1 shasum, every file's sha256)
before it is installed, with its npm dependencies installed by `npm ci` from `docker/deps/<version>.lock.json` (every
package checked against the lock's integrity; the package's lock, or the version's own tarball's). Every input is
pinned by digest, checksum or integrity. The image is `typesol-build:<version>-<first 12
of the Dockerfile's sha256>`, built the first time it is needed (progress on stderr; about 750 MB of downloads) and
reused after. Builds run with `--network none`, the sources read-only (the project root, or a single file's
directory: imports from outside it are not there), the output directory writable, no capabilities, a read-only root
file system, as your uid and gid (root for a root caller, still without capabilities). The written files are the
ones `build` writes; `<name>.build.json` adds `container` (platform, Dockerfile sha256, base images, downloads, the
TypeSOL tarball's hashes and the commit its record names, where the release record came from and the record's sha256,
the dependency lock with its sha256, the local image id). An image is reused only when its labels carry this
record's integrity, shasum, commit and file list and this lock's sha256; an image of the same tag made from other
values is an error that names it (remove it to build from this record).

| Option | |
| --- | --- |
| `--typesol-version <v>` | The TypeSOL in the container. Default: this `typesol`'s version (in a project that installs another `typesol` than the one running, an error naming both); for `verify`, the version of the deployed build's manifest when one is known (`--manifest`, `<deployed>.build.json`, or the local build's whose binary hash is the deployed one's). |
| `--release-record <file>` | The record to check that version's tarball against. Default: the package's (a package ships the records of the releases before it: a record is written after its release is published), else `releases/<version>.json` fetched from the repository's main branch over HTTPS (said on stderr; where it came from and the sha256 of its bytes go into `container.typesol.record`), so that the npm tarball is checked against a second, independent source (as with a file given here; a record the package ships came from npm too). Offline, or for a version the repository has no record of, an error names this option. Versions before 0.43.0 have no record and are refused. |

Without Docker, with its daemon stopped or when the image build fails, `--docker` is an error and nothing is built;
it never falls back to the local toolchain. `TYPESOL_DOCKER_CPUS` and `TYPESOL_DOCKER_MEMORY` (e.g. `2`, `4g`) limit
the build container on a shared machine. Why one platform: [stability.md](stability.md#what-builds-the-same-bytes-where).

## typesol.json

```json
{
  "programs": { "vault": { "path": "programs/vault.ts", "address": "…recorded on first build…" } },
  "out": "target",
  "sbpf": "v0"
}
```

`"clone": ["<address>", …]` lists the cluster accounts `typesol clone` copies for the tests, and `"accounts"` where
they are kept (default `tests/accounts`). `"programs": { "vault": "programs/vault.ts" }` (a plain path) is accepted too. Keep `target/deploy/*-keypair.json`
safe and out of git: it is the program's address, and it is needed to deploy it again. A clone without
it still builds and tests (`npm test` builds first) at the recorded address; deploying needs it.

## Editor

`typesol init` projects load `typesol/ts-plugin` from `programs/tsconfig.json`: besides TypeScript's errors, the editor
underlines what the TypeSOL compiler refuses (an unsupported construct, a constraint that cannot hold…), for the text
being edited (unsaved changes in every open file), once TypeScript itself has nothing to report. It checks the program
entries listed in `typesol.json` and shows each problem in the file it is in, the entry or any file it imports. The
compiler runs inside the editor's TypeScript server once it has loaded (a check takes milliseconds; the first ones run
`typesol check --json --files` as a child process). Editors load tsconfig plugins from the project's own TypeScript:
`typesol init` writes `.vscode/settings.json` so VS Code offers to switch to it ("Use Workspace Version"). To add the
plugin to an existing project:

```json
{ "compilerOptions": { "plugins": [{ "name": "typesol/ts-plugin" }] } }
```

