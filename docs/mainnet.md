# Deploy to mainnet

From an empty directory to a program on Solana mainnet-beta: create, test, deploy, publish the IDL, then check that
the deployed binary is the one your source builds. The program here is the counter that `typesol init` creates
(11,400 bytes, 11.1 KiB, built with TypeSOL 0.43.0 and platform-tools clang 20.1.7 for SBPF v0; other versions differ
slightly); any TypeSOL project works the same way.

You need Node.js 22.12 or later and the Agave CLI with platform-tools (see the README's Quick start).

**The toolchain you deploy with.** The binary is what the platform-tools' clang makes of the generated C, so the
toolchain is part of what you trust. Deploy with the one TypeSOL is tested with (Agave 3.1.10, platform-tools v1.52;
`typesol doctor` says whether yours is, and `typesol deploy --toolchain-strict` refuses another). The host matters
as well: the platform-tools package of each host has its own compiler-builtins, so a program that uses 128-bit or
signed division links to different bytes on macOS, Linux arm64 and Linux x86_64
([stability.md](stability.md#what-builds-the-same-bytes-where)). For a program others should be able to verify, build
it with `--docker` (step 2): a pinned linux/amd64 container that anyone can rebuild. Keep
`target/my_app/my_app.build.json` with each deployment, next to the commit you deployed: it records the TypeSOL,
TypeScript, clang and platform-tools versions, the host, the container when there was one, and the deployed bytes'
sha256. Step 6's `verify` matches only when it rebuilds with the same TypeSOL version, toolchain and (for such
programs) host, and on a mismatch `--manifest` with that file shows what differs.

## 1. Create and test

```sh
npx @typesol/cli init my-app
cd my-app
npm install
npm test
```

`npm test` runs `tests/my_app.test.ts` in LiteSVM: it compiles the program and calls it, with no validator or SOL.
Write your program in `programs/my_app.ts` and keep the tests passing before you spend anything.

## 2. Build

```sh
npx --no-install typesol build
```

This writes `target/my_app/`: the program (`my_app.so`), its Anchor IDL (`my_app.json`), a TypeScript client
(`my_app.client.ts`) and the generated C. The first build also creates `target/deploy/my_app-keypair.json`, the
program's address, and records the address in `typesol.json`.

**Back up `target/deploy/my_app-keypair.json` now.** It is not committed (`.gitignore`), and without it you cannot
redeploy to that address.

### A build others can verify

```sh
npx --no-install typesol build --docker
```

The same files, built inside a container instead of with your platform-tools. The container is made on your machine
from `docker/Dockerfile`, which ships in the package; every input is pinned: the Node and busybox base images by their
linux/amd64 digests, the Agave 3.1.10 and platform-tools v1.52 release files by sha256, and the TypeSOL package (the
version your project uses) by its release record, `releases/<version>.json`: the npm tarball's sha512 integrity and
sha1 shasum and every file's sha256, checked before it is installed. The first `--docker` build of a TypeSOL version
builds the image (about 750 MB of downloads, a few minutes; Docker must be running, `typesol doctor` shows it); later
ones take seconds. The build runs with no network, the project mounted read-only, the output directory writable, as
your user, never root. `my_app.build.json` then records the container: the platform, the Dockerfile's sha256, the
pinned base images and downloads, the TypeSOL tarball's hashes and the local image id.

Deploy that `my_app.so` with the Solana CLI, `solana program deploy target/my_app/my_app.so --program-id
target/deploy/my_app-keypair.json --use-rpc` (with your `--url`): `typesol deploy`, `--dry-run` included, builds again
with your local platform-tools and overwrites the container build. Commit the source, keep
`my_app.build.json`, and publish the commit and that file with the program id.

The TypeSOL inside the container is the version this `typesol` is, the one your project installs (`npx --no-install
typesol`); a global `typesol` of another version than the project's `node_modules/typesol` refuses rather than
guess. `--typesol-version <v>` picks another. Only versions with a release record can be installed (0.43.0 and later):
a package carries the records of the releases before it, because a release's record is written after it is
published. For the newest release, pass its record from the repository with `--release-record <file>`
(`releases/<version>.json` on main), or use a later `@typesol/cli`.

## 3. A wallet with SOL

```sh
solana-keygen new -o ~/.config/solana/deployer.json
solana config set --url mainnet-beta --keypair ~/.config/solana/deployer.json
solana address
```

Send SOL to that address. Most of what a deploy costs is rent for the program's bytes, which you get back if you
ever close the program:

```sh
solana rent $(wc -c < target/my_app/my_app.so)
```

For the counter that is about 0.080 SOL (rent is (128 + size) × 6,960 lamports at the current rate: 80,234,880
lamports for 11,400 bytes; the program data account holds 45 bytes more). During the deploy the program is first
written to a buffer account that holds the same amount again; it is returned when the deploy finishes. Fund about
twice the rent plus 0.01 SOL for fees: 0.17 SOL for the counter.

The public mainnet RPC is rate-limited; for deploys, set `--url` (or `solana config set --url`) to your RPC
provider's endpoint.

## 4. Deploy

```sh
npx --no-install typesol deploy --dry-run   # builds and prints the solana command it will run
npx --no-install typesol deploy
```

It runs `solana program deploy` at the address in `target/deploy/my_app-keypair.json`, with your wallet as payer and
upgrade authority, and prints the program id. Deploying again upgrades the program in place.

If a deploy stops part-way, the buffer stays behind with its SOL. The error prints the buffer's address; recover it
with `solana program close <buffer address>`, or list yours with `solana program show --buffers`.

## 5. Publish the IDL

```sh
npx --no-install typesol idl publish
```

It writes the IDL to the Program Metadata program, signed by the upgrade authority, where Anchor clients and
explorers look for it. It costs a few thousandths of a SOL of rent.

## 6. Verify

```sh
npx --no-install typesol verify my_app
```

`verify` rebuilds the program from `programs/my_app.ts`, reads the deployed one at the address in `typesol.json` from
the cluster in your Solana CLI config, and compares the bytes. `match` means anyone with your source and the same
TypeSOL version and toolchain (and host, for a program with 128-bit or signed division) gets exactly the program on
chain. It also prints the upgrade authority and checks the IDL you published in step 5.

### Verifying someone else's program

With the source at the deployed commit, the program id and, ideally, the deployer's `<name>.build.json`:

```sh
git clone <repository> && cd <repository> && git checkout <commit>
npx --no-install typesol verify my_app --address <program id> --url mainnet-beta --docker --manifest my_app.build.json
```

`--docker` rebuilds in the same container recipe, built on your machine from the Dockerfile and checked inputs. The
TypeSOL version is the deployed build's (from the manifest whose binary hash is the deployed bytes'), or
`--typesol-version <v>`; months later, the current `@typesol/cli` installs the old version in the container, checked
against its release record. On a match it prints what was verified: the program, the source directory and its git
commit (and whether it has uncommitted changes), the TypeSOL version and tarball, the clang and platform-tools, the
container's Dockerfile sha256, base images and downloads, and the command that repeats it. On a mismatch it shows the
toolchain of each side that is known, as without `--docker`. Exit codes: 0 match, 3 mismatch.

What this is not: the container is built locally from pinned inputs, not pulled from a published image, so the first
verification downloads the inputs and builds it. Its local image id can differ between machines; the Dockerfile's
sha256 and the pinned inputs are what to compare. The result is not registered with an external verified-build
registry: the evidence is the command and its output, which anyone can rerun.

## 7. Call it

`target/my_app/my_app.client.ts` builds the program's instructions on `@solana/kit`; see [client.md](client.md).

## Later

- **Freeze it.** `solana program set-upgrade-authority <program id> --final` makes the program immutable. It cannot
  be undone.
- **Close it.** `solana program close <program id> --bypass-warning` returns the rent to the authority. The program
  id can never be used again.

A worked example: the official escrow, deployed to mainnet in TypeSOL, Pinocchio, native Rust and Anchor, with every
transaction linked, is in the README's [On mainnet](../README.md#on-mainnet) section.
